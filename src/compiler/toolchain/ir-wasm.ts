/**
 * Lowering a function's semantic IR to a WebAssembly module.
 *
 * This is the same boundary the C lowering is, for the target that has no C
 * compiler here: the model writes the IR, the compiler checks it against the
 * contract and is now the one that wrote the module, so nothing the model wrote
 * is ever assembled. The module is emitted as bytes rather than as text,
 * because a text form would need an assembler this build does not otherwise
 * depend on, and a module the compiler wrote has no reader to disagree with it.
 *
 * The module boundary is the one the module contract has always had: it imports
 * the host's linear memory and nothing else, and exports exactly the symbol the
 * function is called by. That is also the whole of what such a module can
 * reach, so this lowering refuses the constructs that would need a runtime
 * service rather than emitting a call the host has nothing to answer. A
 * function that prints, allocates, builds a string, reads the command line,
 * raises, or calls another function of the program is refused here by name, and
 * the `c`, `asm` and `machine` kinds are the ones that build it. What is left is
 * arithmetic, control flow, and the reads and writes of the memory the host
 * placed — which is what a `wasm` build verifies against test vectors.
 */

import { stat, writeFile } from "node:fs/promises";
import { CompilerError } from "../core/errors.ts";
import { run } from "../core/process.ts";
import { generateWasmHost, wasmValueType } from "./wasm.ts";
import type { Runner } from "../core/types.ts";
import { parseType, symbolOf } from "../semantics/contract.ts";
import type { FunctionContract } from "../core/types.ts";
import {
  type SemanticBlock,
  type SemanticFunction,
  type SemanticLoop,
  type SemanticStatement,
  type SemanticTerminator,
  type SemanticValue,
  elementTypeOf,
  slotType,
  type SemanticType,
} from "../core/semantic-ir.ts";

/** What a built module is, and what runs it. */
export interface ModuleResult {
  runner: Runner;
  modulePath: string;
  hostPath: string;
  moduleSizeBytes: number;
}

export interface ModuleRequest {
  /** The function as the IR holds it, already validated against its contract. */
  fn: SemanticFunction;
  contract: FunctionContract;
  modulePath: string;
  hostPath: string;
  candidate?: string;
}

/**
 * A construct the module boundary cannot carry. A lowering that emitted one
 * would build a module the host cannot instantiate, so it is refused here,
 * where the build can say what is missing and which kind builds it instead.
 */
function unreachable(what: string, contract: FunctionContract, candidate?: string): never {
  throw new CompilerError({
    category: "TargetError",
    stage: "compile",
    message: `a WebAssembly module cannot ${what}, in ${symbolOf(contract)}`,
    detail:
      "a wasm module imports the host's linear memory and nothing else, so it reaches no runtime service. " +
      "A function that prints, allocates, builds a string, reads the command line, raises, or calls another " +
      "function of the program is built by the c, asm or machine output kind instead",
    function: symbolOf(contract),
    candidate,
  });
}

/* -------------------------------------------------------------------------- */
/* Bytes                                                                       */
/* -------------------------------------------------------------------------- */

/** A module under construction: a byte buffer and the LEB128 the format uses. */
class Bytes {
  private readonly bytes: number[] = [];

  byte(value: number): void {
    this.bytes.push(value & 0xff);
  }

  raw(values: ArrayLike<number>): void {
    for (let index = 0; index < values.length; index += 1) this.bytes.push(values[index] as number);
  }

  /** An unsigned integer, as the format's LEB128. */
  varuint(value: number): void {
    let rest = value >>> 0;
    do {
      const low = rest & 0x7f;
      rest >>>= 7;
      this.byte(rest === 0 ? low : low | 0x80);
    } while (rest !== 0);
  }

  /** A signed integer, as the format's LEB128. */
  varint(value: number): void {
    let rest = value | 0;
    for (;;) {
      const low = rest & 0x7f;
      const sign = low & 0x40;
      rest >>= 7;
      if ((rest === 0 && sign === 0) || (rest === -1 && sign !== 0)) {
        this.byte(low);
        return;
      }
      this.byte(low | 0x80);
    }
  }

  /**
   * A signed 64 bit integer, as the format's LEB128. A 32 bit word cannot hold
   * one, so the arithmetic is done on a `bigint`: a constant past 2^31 written
   * through the 32 bit path keeps its low half and reads as a different number.
   */
  varbig(value: bigint): void {
    let rest = value;
    for (;;) {
      const low = Number(rest & 0x7fn);
      rest >>= 7n;
      const sign = low & 0x40;
      if ((rest === 0n && sign === 0) || (rest === -1n && sign !== 0)) {
        this.byte(low);
        return;
      }
      this.byte(low | 0x80);
    }
  }

  name(value: string): void {
    const encoded = new TextEncoder().encode(value);
    this.varuint(encoded.length);
    this.raw(encoded);
  }

  /**
   * A vector of a known number of elements, prefixed by that count. Every
   * vector in the format is counted this way; only a function body inside the
   * code section is prefixed by its size in bytes instead.
   */
  counted(count: number, write: (into: Bytes) => void): void {
    const body = new Bytes();
    write(body);
    this.varuint(count);
    this.raw(body.bytes);
  }

  /**
   * A section, which is its id, its length and its body. The body is written
   * into a buffer of its own so that its length is known before it is stated,
   * which is why the writer is handed that buffer rather than this one.
   */
  section(id: number, write: (into: Bytes) => void): void {
    const body = new Bytes();
    write(body);
    this.byte(id);
    this.varuint(body.bytes.length);
    this.raw(body.bytes);
  }

  build(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

/* -------------------------------------------------------------------------- */
/* The numeric instruction set                                                 */
/* -------------------------------------------------------------------------- */

const I32 = 0x7f;
const I64 = 0x7e;
const F32 = 0x7d;
const F64 = 0x7c;

/**
 * A type the module carries values in. A reference, a slice, a buffer and an
 * array are all a byte offset into the memory the host provides, pointing at
 * the first element: the count of a buffer is the word the offset sits one
 * before, which the host writes there because a length arrives with no
 * argument of its own.
 */
function carrier(type: SemanticType): number {
  if (type.kind !== "primitive") return I32;
  const wasm = wasmValueType(type);
  return wasm === "i64" ? I64 : wasm === "f32" ? F32 : wasm === "f64" ? F64 : I32;
}

/** Whether a whole number is one the module reads as unsigned. */
function unsigned(type: SemanticType): boolean {
  return type.kind === "primitive" && (type.name === "u8" || type.name === "u16" || type.name === "u32" || type.name === "u64" || type.name === "usize");
}

/** The width one element of a buffer takes, which is the width the host lays it out at. */
function elementSize(type: SemanticType): number {
  if (type.kind !== "primitive") return 8;
  switch (type.name) {
    case "bool":
    case "i8":
    case "u8":
      return 1;
    case "i16":
    case "u16":
      return 2;
    case "i32":
    case "u32":
    case "f32":
      return 4;
    default:
      return 8;
  }
}

/** The load that reads a value of one type at one width. */
function loadCode(type: SemanticType): { code: number; align: number } {
  const width = elementSize(type);
  const held = carrier(type);
  if (held === I32) {
    if (width === 1) return { code: unsigned(type) ? 0x2d : 0x2c, align: 0 };
    if (width === 2) return { code: unsigned(type) ? 0x2f : 0x2e, align: 1 };
    return { code: 0x28, align: 2 };
  }
  if (held === I64) {
    if (width === 1) return { code: 0x30, align: 0 };
    if (width === 2) return { code: 0x32, align: 1 };
    if (width === 4) return { code: 0x34, align: 2 };
    return { code: 0x29, align: 3 };
  }
  if (held === F32) return { code: 0x2a, align: 2 };
  return { code: 0x2b, align: 3 };
}

/** The store that writes a value of one type at one width. */
function storeCode(type: SemanticType): { code: number; align: number } {
  const width = elementSize(type);
  const held = carrier(type);
  if (held === I32) {
    if (width === 1) return { code: 0x3a, align: 0 };
    if (width === 2) return { code: 0x3b, align: 1 };
    return { code: 0x36, align: 2 };
  }
  if (held === I64) {
    if (width === 1) return { code: 0x3c, align: 0 };
    if (width === 2) return { code: 0x3d, align: 1 };
    if (width === 4) return { code: 0x3e, align: 2 };
    return { code: 0x37, align: 3 };
  }
  if (held === F32) return { code: 0x38, align: 2 };
  return { code: 0x39, align: 3 };
}

/** The binary operators of one carrier type, by the name the IR gives them. */
const BINARY: Record<number, Record<string, number>> = {
  [I32]: {
    add: 0x6a, sub: 0x6b, mul: 0x6c, div: 0x6d, mod: 0x6f, and: 0x71, or: 0x72, xor: 0x73,
    shl: 0x74, shr: 0x75, eq: 0x46, ne: 0x47, lt: 0x48, gt: 0x4a, le: 0x4c, ge: 0x4e,
  },
  [I64]: {
    add: 0x7c, sub: 0x7d, mul: 0x7e, div: 0x7f, mod: 0x81, and: 0x83, or: 0x84, xor: 0x85,
    shl: 0x86, shr: 0x87, eq: 0x51, ne: 0x52, lt: 0x53, gt: 0x55, le: 0x57, ge: 0x59,
  },
  [F32]: {
    add: 0x92, sub: 0x93, mul: 0x94, div: 0x95, min: 0x96, max: 0x97,
    eq: 0x5b, ne: 0x5c, lt: 0x5d, gt: 0x5e, le: 0x5f, ge: 0x60,
  },
  [F64]: {
    add: 0xa0, sub: 0xa1, mul: 0xa2, div: 0xa3, min: 0xa4, max: 0xa5,
    eq: 0x61, ne: 0x62, lt: 0x63, gt: 0x64, le: 0x65, ge: 0x66,
  },
};

/** A byte offset into the memory the host provides, which is the whole width. */
const USIZE = { kind: "primitive", name: "usize" } as const;

const COMPOUND: Record<string, string> = {
  "+=": "add",
  "-=": "sub",
  "*=": "mul",
  "/=": "div",
  "%=": "mod",
};

/* -------------------------------------------------------------------------- */
/* The body                                                                    */
/* -------------------------------------------------------------------------- */

/** Every name the body reads, with the type it is declared as. */
function bindings(fn: SemanticFunction): { name: string; type: SemanticType }[] {
  const names = new Map<string, SemanticType>();
  for (const param of fn.params) names.set(param.name, slotType(param));
  const walk = (statements: readonly SemanticStatement[]): void => {
    for (const statement of statements) {
      if (statement.k === "let") names.set(statement.slot.name, slotType(statement.slot));
      if (statement.k === "if") {
        walk(statement.then.statements);
        if (statement.otherwise !== null) walk(statement.otherwise.statements);
      }
      if (statement.k === "block") walk(statement.body.statements);
      if (statement.k === "loop") {
        if (statement.loop.kind === "counted") names.set(statement.loop.variable, statement.loop.type);
        if (statement.loop.kind === "each") {
          names.set(statement.loop.element, statement.loop.elementType);
          names.set(statement.loop.index, { kind: "primitive", name: "usize" });
        }
        walk(statement.loop.body.statements);
      }
    }
  };
  walk(fn.entry.statements);
  return [...names].map(([name, type]) => ({ name, type }));
}

/**
 * Compiles one function's IR to the body of one wasm function.
 *
 * Every value in the IR is a tree, so each one is emitted where it is used and
 * needs no temporary: the only thing that outlives its own expression is a
 * slot, and a slot is a local. A name is one local for the whole function,
 * which is what the IR's scoping says anyway — telling two blocks' uses of one
 * name apart is the work of a target with real blocks, and this is not one.
 */
class Body {
  private readonly code = new Bytes();
  private readonly index = new Map<string, number>();
  private readonly declared: SemanticType[] = [];
  private readonly frames: string[] = [];
  private readonly slots: Map<string, SemanticType>;
  private readonly fn: SemanticFunction;
  private readonly contract: FunctionContract;
  private readonly returns: SemanticType;
  private readonly candidate: string | undefined;
  /** How many labels the body has opened that the IR does not name. */
  private anonymous = 0;

  constructor(fn: SemanticFunction, contract: FunctionContract, returns: SemanticType, candidate: string | undefined) {
    this.fn = fn;
    this.contract = contract;
    this.returns = returns;
    this.candidate = candidate;
    const all = bindings(fn);
    for (const binding of all) {
      this.index.set(binding.name, this.declared.length);
      this.declared.push(binding.type);
    }
    this.slots = new Map(all.map((binding) => [binding.name, binding.type] as const));
  }

  private op(value: number): void {
    this.code.byte(value);
  }

  private i32(value: number): void {
    this.op(0x41);
    this.code.varint(value | 0);
  }

  private i64(value: bigint): void {
    this.op(0x42);
    this.code.varbig(value);
  }

  private float(value: number, wide: boolean): void {
    const size = wide ? 8 : 4;
    const view = new DataView(new ArrayBuffer(size));
    if (wide) view.setFloat64(0, value, true);
    else view.setFloat32(0, value, true);
    this.op(wide ? 0x44 : 0x43);
    for (let index = 0; index < size; index += 1) this.op(view.getUint8(index));
  }

  private slot(name: string): SemanticType {
    const type = this.slots.get(name);
    if (type === undefined) {
      throw new CompilerError({
        category: "SemanticIrError",
        stage: "semantic-ir",
        message: `the body of ${symbolOf(this.contract)} reads "${name}", which it declares nowhere`,
      });
    }
    return type;
  }

  private local(name: string): number {
    const at = this.index.get(name);
    if (at === undefined) {
      throw new CompilerError({
        category: "SemanticIrError",
        stage: "semantic-ir",
        message: `the body of ${symbolOf(this.contract)} reads "${name}", which it declares nowhere`,
      });
    }
    return at;
  }

  private get(name: string): void {
    this.op(0x20);
    this.code.varuint(this.local(name));
  }

  private set(name: string): void {
    this.op(0x21);
    this.code.varuint(this.local(name));
  }

  /** The relative depth a labelled frame is reached by from where the body is. */
  private depth(id: string): number {
    for (let position = this.frames.length - 1; position >= 0; position -= 1) {
      if (this.frames[position] === id) return this.frames.length - 1 - position;
    }
    throw new CompilerError({
      category: "SemanticIrError",
      stage: "semantic-ir",
      message: `a jump to "${id}" leaves no block or loop it is a break or a continue of`,
    });
  }

  /**
   * A label no jump names. An `if` or a block of its own still opens one, and
   * the format counts every label a branch reaches past, so it is held here
   * under a name no terminator can ask for.
   */
  private frame(): string {
    this.anonymous += 1;
    return `#${this.anonymous}`;
  }

  /** Converts what is on the stack into the type a use reads it in. */
  private convert(from: SemanticType, to: number): void {
    const held = carrier(from);
    if (held === to) return;
    if (held === I32 && to === I64) {
      this.op(unsigned(from) ? 0xad : 0xac);
      return;
    }
    if (held === I64 && to === I32) {
      this.op(0xa7);
      return;
    }
    if (held === F32 && to === F64) {
      this.op(0xbb);
      return;
    }
    if (held === F64 && to === F32) {
      this.op(0xb6);
      return;
    }
    if (held === I32) {
      this.op(to === F32 ? 0xb2 : 0xb7);
      return;
    }
    if (held === I64) {
      this.op(to === F32 ? 0xb4 : 0xb9);
      return;
    }
    this.op(to === I32 ? (held === F32 ? 0xa8 : 0xaa) : held === F32 ? 0xae : 0xb0);
  }

  /** The truth of a value, as the language the source was written in reads one. */
  private condition(value: SemanticValue): void {
    const held = carrier(value.type);
    this.value(value, value.type);
    if (held === I32) return;
    if (held === I64) {
      this.op(0x50);
      return;
    }
    this.float(0, held === F64);
    this.op(BINARY[held].ne as number);
  }

  /** One value, as the operations that produce it. */
  private value(value: SemanticValue, at: SemanticType): void {
    switch (value.k) {
      case "const":
        this.constant(value.text, value.type);
        this.convert(value.type, carrier(at));
        return;
      case "bool":
        this.i32(value.value ? 1 : 0);
        this.convert({ kind: "primitive", name: "i32" }, carrier(at));
        return;
      case "nothing":
        this.i32(0);
        this.convert({ kind: "primitive", name: "i32" }, carrier(at));
        return;
      case "local":
        this.get(value.name);
        this.convert(this.slot(value.name), carrier(at));
        return;
      case "length": {
        // A module is handed a pointer to the elements of a buffer and no
        // length beside it, so the host writes the count in the word the
        // pointer sits one before, and the count is read from there. The
        // length of a string is the runtime's to answer, and a module reaches
        // no runtime.
        const held = value.of.type;
        if (held.kind !== "slice" && held.kind !== "array" && held.kind !== "ptr") {
          unreachable("take the length of a value that is not a buffer", this.contract, this.candidate);
        }
        this.value(value.of, USIZE);
        this.i64(8n);
        this.op(0x7d);
        this.op(0xa7);
        this.op(0x29);
        this.code.varuint(3);
        this.code.varuint(0);
        this.convert(value.type, carrier(at));
        return;
      }
      case "element": {
        this.value(value.of, USIZE);
        this.value(value.index, USIZE);
        this.i64(BigInt(elementSize(value.type)));
        this.op(0x7e);
        this.op(0x7c);
        this.op(0xa7);
        const load = loadCode(value.type);
        this.op(load.code);
        this.code.varuint(load.align);
        this.code.varuint(0);
        this.convert(value.type, carrier(at));
        return;
      }
      case "loadField": {
        const layout = this.fn.objects[value.layout];
        const field = layout?.fields.find((entry) => entry.name === value.field);
        if (field === undefined) {
          unreachable(`read the field "${value.field}" of the layout "${value.layout}"`, this.contract, this.candidate);
        }
        this.value(value.object, USIZE);
        this.op(0xa7);
        const load = loadCode(value.type);
        this.op(load.code);
        this.code.varuint(load.align);
        this.code.varuint(field.offset);
        this.convert(value.type, carrier(at));
        return;
      }
      case "unary": {
        // Every one of these answers in the type the use reads it in, like the
        // rest: an operator works in the operand's own carrier, and what comes
        // out of it is converted to the carrier the use asked for. A case that
        // leaves its own type on the stack hands the next operator a value of
        // the wrong width, which the format reads as a type error.
        const held = carrier(value.type);
        if (value.op === "pos") {
          this.value(value.operand, at);
          return;
        }
        if (value.op === "not") {
          this.condition(value.operand);
          this.op(0x45);
          this.convert({ kind: "primitive", name: "bool" }, carrier(at));
          return;
        }
        this.value(value.operand, value.type);
        if (value.op === "bitNot") this.op(held === I64 ? 0x83 : 0x71);
        else this.op(held === I64 ? 0x7d : held === I32 ? 0x6b : held === F32 ? 0x8c : 0x9a);
        this.convert(value.type, carrier(at));
        return;
      }
      case "isNull":
        this.value(value.operand, USIZE);
        this.i32(0);
        this.op(value.negate ? 0x47 : 0x46);
        this.convert({ kind: "primitive", name: "i32" }, carrier(at));
        return;
      case "select":
        // A `select` reads its condition last: it is the top of the stack, and
        // the two arms below it are what it chooses between. Both arms are
        // emitted in the type the use reads the whole in, so what it hands back
        // is already that type.
        this.value(value.then, at);
        this.value(value.otherwise, at);
        this.condition(value.condition);
        this.op(0x1b);
        return;
      case "coalesce":
        // `left ?? right` is the right arm when the left one is nothing, and
        // nothing is a zero of the left arm's own type: a zero of another width
        // under a comparison of this one is a module the engine refuses.
        this.value(value.right, at);
        this.value(value.left, at);
        this.value(value.left, at);
        const held = carrier(value.left.type);
        if (held === I64) this.i64(0n);
        else if (held === F64) this.float(0, true);
        else if (held === F32) this.float(0, false);
        else this.i32(0);
        this.op(BINARY[held].eq as number);
        this.op(0x1b);
        return;
      case "logical":
        // A logical operator is a value and not a condition: the arm the truth
        // of the left one chooses, which is a select over the two. `&&` keeps
        // the right arm when the left one holds and `||` keeps it when the left
        // one does not, so one of them turns that truth over first.
        this.value(value.right, at);
        this.value(value.left, at);
        this.condition(value.left);
        if (value.op === "or") this.op(0x45);
        this.op(0x1b);
        return;
      case "arith":
      case "compare": {
        // A comparison names the type its two sides are compared as, which is
        // not the type it answers with: comparing two doubles as whole numbers
        // loses every fraction of them and answers the other arm than the one
        // the source wrote. An operator's type is the operands' own type.
        const compared = value.k === "compare" ? value.operand : value.type;
        const held = carrier(compared);
        this.value(value.left, compared);
        this.value(value.right, compared);
        const op = BINARY[held][value.op];
        if (op === undefined) {
          unreachable(`compute ${value.op}`, this.contract, this.candidate);
        }
        this.op(op);
        if (value.k === "compare") {
          this.convert({ kind: "primitive", name: "i32" }, carrier(at));
          return;
        }
        this.convert(value.type, carrier(at));
        return;
      }
      default:
        unreachable(`hold a value the IR keeps as "${value.k}"`, this.contract, this.candidate);
    }
  }

  /** A literal, in the type the IR resolved it to. */
  private constant(text: string, type: SemanticType): void {
    switch (carrier(type)) {
      case I32:
        this.i32(Number(BigInt(text)));
        return;
      case I64:
        this.i64(BigInt(text));
        return;
      case F32:
        this.float(Number(text), false);
        return;
      default:
        this.float(Number(text), true);
    }
  }

  block(block: SemanticBlock, label: string | null): void {
    if (label !== null) this.frames.push(label);
    for (const statement of block.statements) this.statement(statement);
    this.terminator(block.terminator);
    if (label !== null) this.frames.pop();
  }

  private terminator(terminator: SemanticTerminator): void {
    if (terminator.k === "next") return;
    if (terminator.k === "return") {
      if (terminator.value !== null) this.value(terminator.value, this.returns);
      else if (this.returns.kind !== "void") this.answer();
      this.op(0x0f);
      return;
    }
    this.op(0x0c);
    this.code.varuint(this.depth(terminator.target));
  }

  private statement(statement: SemanticStatement): void {
    switch (statement.k) {
      case "let":
        this.value(statement.value, slotType(statement.slot));
        this.set(statement.slot.name);
        return;
      case "set": {
        const type = this.slot(statement.name);
        const held = carrier(type);
        this.get(statement.name);
        this.value(statement.value, type);
        if (statement.op !== "=") this.op(BINARY[held][COMPOUND[statement.op] as string] as number);
        this.set(statement.name);
        return;
      }
      case "step": {
        // A step is a statement, and nothing reads what it would hand back: a
        // `tee` pushes the new value again, and in a body that falls through
        // to the turn of the loop — a do-while, or the last statement of a
        // block — that value is a module the engine refuses.
        const held = carrier(this.slot(statement.name));
        this.get(statement.name);
        if (held === I64) this.i64(1n);
        else if (held === F64) this.float(1, true);
        else if (held === F32) this.float(1, false);
        else this.i32(1);
        this.op(statement.op === "++" ? (BINARY[held].add as number) : (BINARY[held].sub as number));
        this.set(statement.name);
        return;
      }
      case "setElement": {
        // What a name holds is the buffer; what one of its elements is takes
        // the type out of that, and it is the element the address is counted in
        // and the value written at — a name's own type is a reference, and a
        // reference has no width.
        const element = elementTypeOf(this.slot(statement.buffer));
        if (element === null) {
          unreachable(`write an element of "${statement.buffer}"`, this.contract, this.candidate);
        }
        this.value({ k: "local", type: this.slot(statement.buffer), name: statement.buffer }, USIZE);
        this.value(statement.index, USIZE);
        this.i64(BigInt(elementSize(element)));
        this.op(0x7e);
        this.op(0x7c);
        this.op(0xa7);
        this.value(statement.value, element);
        if (statement.op !== "=") this.op(BINARY[carrier(element)][COMPOUND[statement.op] as string] as number);
        const store = storeCode(element);
        this.op(store.code);
        this.code.varuint(store.align);
        this.code.varuint(0);
        return;
      }
      case "storeField": {
        const layout = this.fn.objects[statement.layout];
        const field = layout?.fields.find((entry) => entry.name === statement.field);
        if (field === undefined) {
          unreachable(`write the field "${statement.field}" of the layout "${statement.layout}"`, this.contract, this.candidate);
        }
        this.value(statement.object, USIZE);
        this.op(0xa7);
        this.value(statement.value, USIZE);
        this.op(0xa7);
        const store = storeCode(statement.value.type);
        this.op(store.code);
        this.code.varuint(store.align);
        this.code.varuint(field.offset);
        return;
      }
      case "if":
        // An `if` opens a label the format counts when a branch reaches for one,
        // so it is a frame like a loop's — a jump out of an arm is a depth from
        // here, and a depth that forgets the arm is a jump to the wrong place.
        this.condition(statement.condition);
        this.op(0x04);
        this.code.byte(0x40);
        this.frames.push(this.frame());
        this.block(statement.then, null);
        if (statement.otherwise !== null) {
          this.op(0x05);
          this.block(statement.otherwise, null);
        }
        this.frames.pop();
        this.op(0x0b);
        return;
      case "block":
        // A block of its own: the names it declares stop meaning past its end,
        // and in a module with no scopes the body is emitted either way. It is
        // a label, so a jump out of it is counted like any other.
        this.op(0x02);
        this.code.byte(0x40);
        this.frames.push(this.frame());
        this.block(statement.body, null);
        this.frames.pop();
        this.op(0x0b);
        return;
      case "loop":
        this.loop(statement.loop);
        return;
      case "call":
        this.builtin(statement.call.callee);
        return;
      case "printText":
        unreachable("print text", this.contract, this.candidate);
      case "printNumber":
        unreachable("print a number", this.contract, this.candidate);
      case "printNewline":
        unreachable("end a line", this.contract, this.candidate);
      case "retain":
        unreachable("retain a value", this.contract, this.candidate);
      case "raise":
        unreachable("raise", this.contract, this.candidate);
    }
  }

  /**
   * A loop as a `block` around a `loop`: `break` leaves the block and
   * `continue` branches to the loop, which is the one the IR's header names.
   *
   * Whatever a loop counts on is bound before either frame, because a branch
   * back to the loop start runs everything ahead of it, and a counter bound
   * inside the loop is a counter bound again on every pass.
   */
  private loop(loop: SemanticLoop): void {
    if (loop.kind === "counted") {
      // A counted loop moves its index at the head of the turn rather than at
      // the foot, because a `continue` branches to the head: a step at the foot
      // is a step a `continue` skips, and a loop whose index never moves is a
      // loop that never ends. The turn before the first is a turn of its own,
      // so the index starts one step short of the value the source wrote.
      this.value(loop.from, loop.type);
      this.convert(loop.from.type, carrier(loop.type));
      this.countedStep(loop);
      this.op(BINARY[carrier(loop.type)].sub as number);
      this.set(loop.variable);
    }
    if (loop.kind === "each") {
      this.i64(0n);
      this.set(loop.index);
    }
    this.op(0x02);
    this.code.byte(0x40);
    this.frames.push(loop.exit);
    this.op(0x03);
    this.code.byte(0x40);
    this.frames.push(loop.header);
    if (loop.kind === "while") {
      this.condition(loop.condition);
      this.op(0x45);
      this.exitTest();
      this.block(loop.body, null);
      this.backToHeader();
    } else if (loop.kind === "doWhile") {
      this.block(loop.body, null);
      this.condition(loop.condition);
      this.op(0x0d);
      this.code.varuint(0);
    } else if (loop.kind === "counted") {
      this.get(loop.variable);
      this.countedStep(loop);
      // The step is the signed amount the index moves by, so a loop counting
      // down carries a negative one and adds it like any other.
      this.op(BINARY[carrier(loop.type)].add as number);
      this.set(loop.variable);
      this.get(loop.variable);
      this.value(loop.to, loop.type);
      this.convert(loop.to.type, carrier(loop.type));
      const bound = loop.down ? (loop.inclusive ? "ge" : "gt") : loop.inclusive ? "le" : "lt";
      this.op(BINARY[carrier(loop.type)][bound] as number);
      this.op(0x45);
      this.exitTest();
      this.block(loop.body, null);
      this.backToHeader();
    } else {
      // A for-of counts elements from the first to the length. It counts them
      // rather than moving the buffer, because the buffer is a name the body
      // reads elsewhere and the walk does not change what it holds.
      this.get(loop.index);
      this.value(loop.length, USIZE);
      this.op(0x53);
      this.op(0x45);
      this.exitTest();
      this.get(loop.of);
      this.convert(this.slot(loop.of), I64);
      this.get(loop.index);
      this.i64(BigInt(elementSize(loop.elementType)));
      this.op(0x7e);
      this.op(0x7c);
      this.op(0xa7);
      const load = loadCode(loop.elementType);
      this.op(load.code);
      this.code.varuint(load.align);
      this.code.varuint(0);
      this.convert(loop.elementType, carrier(loop.elementType));
      this.set(loop.element);
      this.block(loop.body, null);
      this.get(loop.index);
      this.i64(1n);
      this.op(0x7c);
      this.set(loop.index);
      this.backToHeader();
    }
    this.op(0x0b);
    this.frames.pop();
    this.op(0x0b);
    this.frames.pop();
  }

  /**
   * What one turn of a counted loop moves its index by. A loop that names a
   * step moves by it, and a loop that does not moves by one the way it already
   * travels — which is a negative one when it counts down, or the index climbs
   * for ever and the loop never ends.
   */
  private countedStep(loop: Extract<SemanticLoop, { kind: "counted" }>): void {
    if (loop.step !== null) {
      this.value(loop.step, loop.type);
      this.convert(loop.step.type, carrier(loop.type));
      return;
    }
    this.value({ k: "const", type: loop.type, text: loop.down ? "-1" : "1" }, loop.type);
  }

  /** Leaves the loop for its exit, which is the block the loop sits in. */
  private exitTest(): void {
    this.op(0x0d);
    this.code.varuint(1);
  }

  /** Branches back to the head of the loop, which is where a continue goes. */
  private backToHeader(): void {
    this.op(0x0c);
    this.code.varuint(0);
  }

  private builtin(callee: string): void {
    const wide: Record<string, number> = { abs: 0x8b, floor: 0x8e, trunc: 0x8f };
    const code = wide[callee];
    if (code === undefined) {
      unreachable(`call the builtin ${callee}`, this.contract, this.candidate);
    }
    this.op(code);
  }

  /** The declarations of the locals the body added beyond the parameters. */
  localGroups(): number[] {
    const groups: number[] = [];
    const counts = new Map<number, number>();
    for (let position = this.fn.params.length; position < this.declared.length; position += 1) {
      const type = carrier(this.declared[position] as SemanticType);
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
    for (const [type, count] of counts) groups.push(count, type);
    return groups;
  }

  /**
   * A value of the contracted return type, for a body that falls out of its own
   * end. A body that ends on a return has already answered, so nothing runs
   * this — but a function that returns one still has to leave something of
   * that type behind, and the format has no other way to fall off the end.
   */
  answer(): void {
    if (this.returns.kind === "void") return;
    if (this.returns.kind === "primitive" && this.returns.name === "f64") {
      this.float(0, true);
      return;
    }
    if (this.returns.kind === "primitive" && this.returns.name === "f32") {
      this.float(0, false);
      return;
    }
    if (carrier(this.returns) === I64) {
      this.i64(0n);
      return;
    }
    this.i32(0);
  }

  finish(): Uint8Array {
    return this.code.build();
  }
}

/* -------------------------------------------------------------------------- */
/* The module                                                                  */
/* -------------------------------------------------------------------------- */

const MODULE_HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

/**
 * Whether the bytes are a module at all. The build runs under Node, so this is
 * the engine's own answer rather than a second opinion; where it is not there,
 * the boundary check below validates the same bytes and says so itself.
 */
function validModule(bytes: Uint8Array): boolean {
  const engine = (globalThis as { WebAssembly?: { validate(bytes: Uint8Array): boolean } }).WebAssembly;
  return engine === undefined ? true : engine.validate(bytes);
}

export function moduleBytes(
  fn: SemanticFunction,
  contract: FunctionContract,
  candidate?: string,
): Uint8Array {
  const returns = parseType(contract.function.returns);
  const body = new Body(fn, contract, returns, candidate);
  const parameters = fn.params.map((param) => carrier(slotType(param)));
  const result = returns.kind === "void" ? undefined : carrier(returns);
  const code = new Bytes();
  const groups = body.localGroups();
  code.counted(groups.length / 2, (locals) => groups.forEach((value) => locals.varuint(value)));
  body.block(fn.entry, null);
  code.raw(body.finish());
  if (result !== undefined) body.answer();
  code.byte(0x0b);
  const compiled = code.build();

  const module = new Bytes();
  module.raw(MODULE_HEADER);
  module.section(1, (types) =>
    types.counted(1, (one) => {
      one.byte(0x60);
      one.counted(parameters.length, (values) => parameters.forEach((type) => values.byte(type)));
      one.counted(result === undefined ? 0 : 1, (results) => {
        if (result !== undefined) results.byte(result);
      });
    }),
  );
  module.section(2, (imports) =>
    imports.counted(1, (one) => {
      one.name("env");
      one.name("memory");
      one.byte(0x02);
      // A memory is a limits pair — a flag byte and the pages it starts with —
      // and not a vector, which costs a byte the format does not allow.
      one.byte(0x00);
      one.varuint(1);
    }),
  );
  module.section(3, (functions) => functions.counted(1, (one) => one.byte(0)));
  module.section(7, (exports) =>
    exports.counted(1, (one) => {
      one.name(symbolOf(contract));
      one.byte(0x00);
      one.varuint(0);
    }),
  );
  module.section(10, (bodies) =>
    bodies.counted(1, (one) => {
      one.varuint(compiled.length);
      one.raw(compiled);
    }),
  );
  return module.build();
}

/* -------------------------------------------------------------------------- */
/* The build                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Emits the module, checks the boundary it has to keep, and writes the host
 * that runs it. Nothing a model wrote is assembled here: the IR was checked
 * against the contract before this, and the module is the compiler's own.
 */
export async function buildModule(request: ModuleRequest): Promise<ModuleResult> {
  const functionName = symbolOf(request.contract);
  const bytes = moduleBytes(request.fn, request.contract, request.candidate);
  if (!validModule(bytes)) {
    throw new CompilerError({
      category: "TargetError",
      stage: "compile",
      message: `the compiler emitted a module for ${functionName} that is not valid WebAssembly`,
      function: functionName,
      candidate: request.candidate,
    });
  }
  await writeFile(request.modulePath, bytes);
  await writeFile(request.hostPath, generateWasmHost(request.contract), "utf8");

  const inspection = run(
    process.execPath,
    ["--input-type=module", "-e", INSPECT_MODULE, request.modulePath, functionName],
    { timeoutMs: 60_000 },
  );
  if (inspection.code !== 0) {
    throw new CompilerError({
      category: "TargetError",
      stage: "compile",
      message: `the WebAssembly module for ${functionName} violates the contract`,
      detail: (inspection.stderr.trim() || inspection.stdout.trim()).slice(0, 2000),
      function: functionName,
      candidate: request.candidate,
    });
  }
  return {
    runner: { command: process.execPath, args: [request.hostPath, request.modulePath] },
    modulePath: request.modulePath,
    hostPath: request.hostPath,
    moduleSizeBytes: (await stat(request.modulePath)).size,
  };
}

/** Rejects a module that reaches outside the memory the host provides. */
const INSPECT_MODULE = `
import { readFileSync } from "node:fs";
const [path, expected] = process.argv.slice(1);
const bytes = readFileSync(path);
if (!WebAssembly.validate(bytes)) {
  process.stderr.write("the module is not valid WebAssembly\\n");
  process.exit(1);
}
const module = new WebAssembly.Module(bytes);
const problems = [];
const imports = WebAssembly.Module.imports(module);
const memoryImports = imports.filter((entry) => entry.kind === "memory");
if (imports.length !== 1 || memoryImports.length !== 1 || memoryImports[0].module !== "env" || memoryImports[0].name !== "memory") {
  problems.push('the module must import exactly one memory: (import "env" "memory" ...)');
}
if (imports.some((entry) => entry.kind !== "memory")) {
  problems.push("the module must not import functions, tables or globals");
}
const exports = WebAssembly.Module.exports(module).map((entry) => entry.name);
if (exports.includes("memory") || exports.includes("_start")) {
  problems.push("the module must not export memory or _start; the host provides both");
}
if (!exports.includes(expected)) {
  problems.push('the module must export the contracted function "' + expected + '"');
}
if (problems.length > 0) {
  process.stderr.write(problems.join("\\n") + "\\n");
  process.exit(1);
}
`;

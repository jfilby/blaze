/**
 * Lowering a function's semantic IR to a WebAssembly module.
 *
 * This is the same boundary the C lowering is, for the target that has no C
 * compiler here: the IR is the compiler's own and has been checked against the
 * contract, so the compiler is the one that wrote the module. The module is
 * emitted as bytes rather than as text,
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
import { ARGV, ARGV_LENGTH, builtinFor } from "../semantics/builtins.ts";
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

/**
 * The operators a whole number the module reads as unsigned needs in place of
 * the signed ones, by the name the IR gives them.
 *
 * WebAssembly spells these out rather than reading a flag: `lt_s` and `lt_u`
 * are different instructions, and a module that emits the signed one over a
 * `u32` orders `3000000000` below `1`, because the same bits are a negative
 * number. The arithmetic the two spellings share — addition, multiplication,
 * a bitwise operator, and the amount of a shift, which is masked either way —
 * is in `BINARY` and is not repeated here.
 */
const UNSIGNED_BINARY: Record<number, Record<string, number>> = {
  [I32]: { div: 0x6e, mod: 0x70, shr: 0x76, lt: 0x49, gt: 0x4b, le: 0x4d, ge: 0x4f },
  [I64]: { div: 0x80, mod: 0x82, shr: 0x88, lt: 0x54, gt: 0x56, le: 0x58, ge: 0x5a },
  [F32]: {},
  [F64]: {},
};

/**
 * Converting a whole number to a float, by the carrier the whole number is
 * held in, the carrier it becomes, and whether it is read as unsigned.
 *
 * WebAssembly names these for how the bits read rather than for how the value
 * was declared, and the two spellings differ on exactly the values over the
 * signed range: `3000000000` as a `u32` is itself, and sign-extended it is
 * `-1294967296`. A conversion that always took the signed one turned a whole
 * number the source wrote into a different number.
 */
const TO_FLOAT: Record<number, Record<number, { signed: number; unsigned: number }>> = {
  [I32]: { [F32]: { signed: 0xb2, unsigned: 0xb3 }, [F64]: { signed: 0xb7, unsigned: 0xb8 } },
  [I64]: { [F32]: { signed: 0xb4, unsigned: 0xb5 }, [F64]: { signed: 0xb9, unsigned: 0xba } },
};

/**
 * Converting a float to a whole number, by the same two carriers. Which of the
 * two it is here is the destination's own business, because the destination is
 * the one deciding what it can hold.
 */
const TO_WHOLE: Record<number, Record<number, { signed: number; unsigned: number }>> = {
  [F32]: { [I32]: { signed: 0xa8, unsigned: 0xa9 }, [I64]: { signed: 0xae, unsigned: 0xaf } },
  [F64]: { [I32]: { signed: 0xaa, unsigned: 0xab }, [I64]: { signed: 0xb0, unsigned: 0xb1 } },
};

/**
 * The maths builtin each source name is a single instruction of, keyed by the
 * name a callee is contracted under. Every one of them takes and answers a
 * double, so every opcode is an `f64` one: the `f32` opcode of the same name
 * would read an operand off a stack the engine never put one on, and the
 * module would be refused for a reason nothing in it shows.
 */
const MATH: Record<string, number> = {
  "Math.abs": 0x99,
  "Math.floor": 0x9c,
  "Math.trunc": 0x9d,
  "Math.min": 0xa4,
  "Math.max": 0xa5,
};

/**
 * The builtins that read the command line, whose names are the table's own
 * rather than a source name. The host the build runs is handed the module and
 * the vectors on standard input, so there is no command line for a module to
 * read and no process to read it from.
 */
const ARGV_NAMES: Record<string, true> = {
  [ARGV]: true,
  [ARGV_LENGTH]: true,
};

/**
 * The 32 bit whole number a byte offset is counted in. The format indexes
 * memory with a 32 bit address, and the memory the host provides is a handful
 * of pages, so the whole of an address fits: a base and an index computed at
 * the full width and narrowed afterwards are instructions the engine has to
 * emulate on a 32 bit one for a number that never used the width.
 */
const ADDRESS = { kind: "primitive", name: "u32" } as const;

/**
 * How far one element of a buffer is from the next, as a shift. The width is
 * one, two, four or eight bytes, so the scale is a shift of zero, one, two or
 * three: the shift of zero is left out, because moving a number by none of it
 * is an instruction that does what the address already says.
 */
function elementShift(type: SemanticType): number {
  const width = elementSize(type);
  return width <= 1 ? -1 : Math.log2(width);
}

const COMPOUND: Record<string, string> = {
  "+=": "add",
  "-=": "sub",
  "*=": "mul",
  "/=": "div",
  "%=": "mod",
};

/**
 * The operator a compound assignment of one carrier type is, by the name the
 * IR gives it. A whole number the module reads as unsigned is divided and
 * taken mod as unsigned, for the reason the `arith` case above gives: the
 * instruction is named for how the bits read and not for how the value was
 * declared, so the signed one over a `u32` returns a negative number for a
 * numerator above the signed range.
 */
function compoundCode(held: number, type: SemanticType, op: string): number {
  const name = COMPOUND[op] as string;
  const code = unsigned(type) ? UNSIGNED_BINARY[held][name] : undefined;
  return (code ?? BINARY[held][name]) as number;
}

/* -------------------------------------------------------------------------- */
/* The body                                                                    */
/* -------------------------------------------------------------------------- */

/** A name the body reads, and the block whose declaration it answers to. */
interface Binding {
  /** The block the name is declared in, which is what tells two uses apart. */
  block: string;
  name: string;
  type: SemanticType;
}

/**
 * Every name the body reads, with the block that declares it and the type it
 * is declared as.
 *
 * A name is one local per block that declares it rather than one local for the
 * whole function, because the IR's scoping is what says which declaration a
 * use answers to: two blocks that both declare `x` of different types are two
 * values, and one local for the two would give the second one's type to the
 * first one's uses. The resolver refuses a name declared twice in the same
 * block, so no two declarations share a block here.
 */
function bindings(fn: SemanticFunction): Binding[] {
  const found: Binding[] = [];
  const seen = new Set<string>();
  const declare = (block: string, name: string, type: SemanticType): void => {
    const key = `${block} ${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ block, name, type });
  };
  const walk = (statements: readonly SemanticStatement[], block: string): void => {
    for (const statement of statements) {
      if (statement.k === "let") declare(block, statement.slot.name, slotType(statement.slot));
      if (statement.k === "if") {
        walk(statement.then.statements, statement.then.id);
        if (statement.otherwise !== null) walk(statement.otherwise.statements, statement.otherwise.id);
      }
      if (statement.k === "block") walk(statement.body.statements, statement.body.id);
      if (statement.k === "loop") {
        // A loop declares its own names in the block its body is, which is
        // where they stop meaning at the end of it: a `let` of the same name
        // past the loop is another value, not a second view of this one.
        if (statement.loop.kind === "counted") {
          declare(statement.loop.body.id, statement.loop.variable, statement.loop.type);
        }
        if (statement.loop.kind === "each") {
          declare(statement.loop.body.id, statement.loop.element, statement.loop.elementType);
          // The index of a walk is a count of elements, and it is held in the
          // 32 bits an address is counted in: the count the module compares it
          // against is read out of the same memory the addresses are, so the
          // two are 32 bit numbers either way. A use that reads it wider is
          // converted where it is read, which widens the very same count.
          declare(statement.loop.body.id, statement.loop.index, ADDRESS);
        }
        walk(statement.loop.body.statements, statement.loop.body.id);
      }
    }
  };
  // A parameter and a `let` of the function's own body are one scope: the
  // resolver refuses a name the two both give, so neither is the other's.
  for (const param of fn.params) declare(fn.entry.id, param.name, slotType(param));
  walk(fn.entry.statements, fn.entry.id);
  return found;
}

/**
 * Compiles one function's IR to the body of one wasm function.
 *
 * Every value in the IR is a tree, so each one is emitted where it is used and
 * needs no temporary: the only thing that outlives its own expression is a
 * slot, and a slot is a local. A name is one local per block that declares it,
 * so a name two blocks both give is two locals, and the block the body is
 * emitting is what says which of them a use means.
 */
class Body {
  private readonly code = new Bytes();
  /** The local each `block name` pair is, in the order the module numbers them. */
  private readonly index = new Map<string, number>();
  /** The type each `block name` pair is declared as. */
  private readonly types = new Map<string, SemanticType>();
  /** The carrier of every local, in the order the module numbers them. */
  private readonly declared: number[] = [];
  private readonly frames: string[] = [];
  /** The blocks the body is inside, outermost first. */
  private readonly blocks: string[] = [];
  private readonly fn: SemanticFunction;
  private readonly contract: FunctionContract;
  private readonly returns: SemanticType;
  private readonly candidate: string | undefined;
  /**
   * The borrowed locals of each carrier that are free to be handed out again,
   * most recently borrowed first. A borrow nests — the right arm of a `&&`
   * borrows the same carrier the whole operator borrowed — so a local is only
   * free once the statement that borrowed it has finished with it.
   */
  private readonly spare = new Map<number, number[]>();
  /** How many labels the body has opened that the IR does not name. */
  private anonymous = 0;

  constructor(fn: SemanticFunction, contract: FunctionContract, returns: SemanticType, candidate: string | undefined) {
    this.fn = fn;
    this.contract = contract;
    this.returns = returns;
    this.candidate = candidate;
    for (const binding of bindings(fn)) {
      this.index.set(`${binding.block} ${binding.name}`, this.declared.length);
      this.types.set(`${binding.block} ${binding.name}`, binding.type);
      this.declared.push(carrier(binding.type));
    }
  }

  /**
   * A local of one carrier to hold a value for the span of a statement. The
   * format has no way to copy what is on the stack, so a statement that needs
   * one value twice asks for a local to keep the first in.
   */
  private borrow(held: number): number {
    const free = this.spare.get(held);
    const at = free?.pop();
    if (at !== undefined) return at;
    const index = this.declared.length;
    this.declared.push(held);
    return index;
  }

  /** Hands a borrowed local back, so a later borrow of that carrier takes it. */
  private release(held: number, at: number): void {
    const free = this.spare.get(held);
    if (free === undefined) this.spare.set(held, [at]);
    else free.push(at);
  }

  /** Stores what is on the top of the stack in a borrowed local. */
  private keep(at: number): void {
    this.op(0x21);
    this.code.varuint(at);
  }

  /** Reads a local back onto the top of the stack. */
  private read(at: number): void {
    this.op(0x20);
    this.code.varuint(at);
  }

  /**
   * Reads a local back and leaves it where it was, which is what a value that
   * is both the answer and the test of a branch has to be.
   */
  private keepAndRead(at: number): void {
    this.op(0x22);
    this.code.varuint(at);
  }

  private op(value: number): void {
    this.code.byte(value);
  }

  private i32(value: number): void {
    this.op(0x41);
    this.code.varint(value | 0);
  }

  /**
   * An i64 constant. The value is wrapped into the signed 64 bit range first,
   * because a constant is not always written at the width it is read: the
   * magnitude of `-9223372036854775808` is a number one past the largest i64,
   * and a LEB128 written for it is an encoding the engine refuses.
   */
  private i64(value: bigint): void {
    this.op(0x42);
    this.code.varbig(BigInt.asIntN(64, value));
  }

  private float(value: number, wide: boolean): void {
    const size = wide ? 8 : 4;
    const view = new DataView(new ArrayBuffer(size));
    if (wide) view.setFloat64(0, value, true);
    else view.setFloat32(0, value, true);
    this.op(wide ? 0x44 : 0x43);
    for (let index = 0; index < size; index += 1) this.op(view.getUint8(index));
  }

  /**
   * The local a name means where the body is, which is the one the innermost
   * block that declares it holds. A name is one local per block that declares
   * it, so the block the body is emitting is what says which of them a use is.
   */
  private local(name: string): number {
    for (let position = this.blocks.length - 1; position >= 0; position -= 1) {
      const at = this.index.get(`${this.blocks[position]} ${name}`);
      if (at !== undefined) return at;
    }
    throw new CompilerError({
      category: "SemanticIrError",
      stage: "semantic-ir",
      message: `the body of ${symbolOf(this.contract)} reads "${name}", which it declares nowhere`,
    });
  }

  private slot(name: string): SemanticType {
    for (let position = this.blocks.length - 1; position >= 0; position -= 1) {
      const type = this.types.get(`${this.blocks[position]} ${name}`);
      if (type !== undefined) return type;
    }
    throw new CompilerError({
      category: "SemanticIrError",
      stage: "semantic-ir",
      message: `the body of ${symbolOf(this.contract)} reads "${name}", which it declares nowhere`,
    });
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
  private convert(from: SemanticType, to: SemanticType): void {
    const held = carrier(from);
    const wanted = carrier(to);
    if (held === wanted) return;
    if (held === I32 && wanted === I64) {
      this.op(unsigned(from) ? 0xad : 0xac);
      return;
    }
    if (held === I64 && wanted === I32) {
      this.op(0xa7);
      return;
    }
    if (held === F32 && wanted === F64) {
      this.op(0xbb);
      return;
    }
    if (held === F64 && wanted === F32) {
      this.op(0xb6);
      return;
    }
    // A whole number and a float are the last conversion left, and it is
    // spelled twice. Which of the two is asked depends on which side is the
    // whole number: widening reads the source's own spelling and narrowing
    // reads the destination's.
    const whole = held === I32 || held === I64;
    const table = whole ? TO_FLOAT : TO_WHOLE;
    const pair = table[held]?.[wanted];
    if (pair === undefined) {
      unreachable("convert between carriers", this.contract, this.candidate);
    }
    this.op(whole ? (unsigned(from) ? pair.unsigned : pair.signed) : unsigned(to) ? pair.unsigned : pair.signed);
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

  /**
   * The address of one element of a buffer, in the 32 bits the format indexes
   * memory with.
   *
   * The host hands a module a handful of pages, so a whole address fits in 32
   * bits however wide the arithmetic that counts it is. Computing the base and
   * the index at the full width and narrowing the sum is a multiply and an
   * add the engine has to emulate on a 32 bit one; narrowing each on its own
   * and scaling by a shift is not, and `elementSize` only ever answers one, two,
   * four or eight, so the scale is a shift of at most three.
   */
  private address(of: SemanticValue, index: SemanticValue, type: SemanticType): void {
    this.value(of, ADDRESS);
    this.value(index, ADDRESS);
    const shift = elementShift(type);
    if (shift > 0) {
      this.i32(shift);
      this.op(0x74);
    }
    this.op(BINARY[I32].add as number);
  }

  /** One value, as the operations that produce it. */
  private value(value: SemanticValue, at: SemanticType): void {
    switch (value.k) {
      case "const":
        this.constant(value.text, value.type);
        this.convert(value.type, at);
        return;
      case "bool":
        this.i32(value.value ? 1 : 0);
        this.convert({ kind: "primitive", name: "i32" }, at);
        return;
      case "nothing":
        this.i32(0);
        this.convert({ kind: "primitive", name: "i32" }, at);
        return;
      case "local":
        this.get(value.name);
        this.convert(this.slot(value.name), at);
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
        this.value(value.of, ADDRESS);
        this.i32(8);
        this.op(BINARY[I32].sub as number);
        this.op(0x29);
        this.code.varuint(3);
        this.code.varuint(0);
        this.convert(value.type, at);
        return;
      }
      case "element": {
        this.address(value.of, value.index, value.type);
        const load = loadCode(value.type);
        this.op(load.code);
        this.code.varuint(load.align);
        this.code.varuint(0);
        this.convert(value.type, at);
        return;
      }
      case "loadField": {
        const layout = this.fn.objects[value.layout];
        const field = layout?.fields.find((entry) => entry.name === value.field);
        if (field === undefined) {
          unreachable(`read the field "${value.field}" of the layout "${value.layout}"`, this.contract, this.candidate);
        }
        this.value(value.object, ADDRESS);
        const load = loadCode(value.type);
        this.op(load.code);
        this.code.varuint(load.align);
        this.code.varuint(field.offset);
        this.convert(value.type, at);
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
          this.convert({ kind: "primitive", name: "bool" }, at);
          return;
        }
        // WebAssembly has no `i32.neg` and no `i64.neg`, and no integer
        // complement: an integer is negated by taking it from a zero of its own
        // width, and a complement is `0 - 1 - x`, which is `~x` in two's
        // complement at every width. A sub takes its left operand first, so the
        // zero goes down before the value: `x - 0` is not a negation of
        // anything. A float width is the one case with a negation of its own
        // (`f32.neg`, `f64.neg`), and it uses it.
        if (value.op === "bitNot") {
          if (held === I64) this.i64(0n);
          else if (held === F64) this.float(0, true);
          else if (held === F32) this.float(0, false);
          else this.i32(0);
          this.value(value.operand, value.type);
          this.op(BINARY[held].sub as number);
          if (held === I64) this.i64(1n);
          else if (held === F64) this.float(1, true);
          else if (held === F32) this.float(1, false);
          else this.i32(1);
          this.op(BINARY[held].sub as number);
        } else if (held === I64) {
          this.i64(0n);
          this.value(value.operand, value.type);
          this.op(BINARY[held].sub as number);
        } else if (held === I32) {
          this.i32(0);
          this.value(value.operand, value.type);
          this.op(BINARY[held].sub as number);
        } else {
          this.value(value.operand, value.type);
          this.op(held === F32 ? 0x8c : 0x9a);
        }
        this.convert(value.type, at);
        return;
      }
      case "isNull":
        // A reference is a byte offset, and the format reads a comparison
        // against a zero of the operand's own width: an `i64` operand beside
        // an `i32` zero is a module the engine refuses. So the zero is the
        // width the operand is held at, and the operator is that width's.
        this.value(value.operand, value.operand.type);
        const width = carrier(value.operand.type);
        if (width === I64) this.i64(0n);
        else if (width === F64) this.float(0, true);
        else if (width === F32) this.float(0, false);
        else this.i32(0);
        this.op(BINARY[width][value.negate ? "ne" : "eq"] as number);
        this.convert({ kind: "primitive", name: "i32" }, at);
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
      case "coalesce": {
        // `left ?? right` is the right arm when the left one is nothing, and
        // nothing is a zero of the left arm's own type: a zero of another width
        // under a comparison of this one is a module the engine refuses.
        //
        // The right arm is behind a branch rather than under a `select`, which
        // chooses between two values it has already been given. A select
        // writes the left arm down twice and runs the right one whatever the
        // left one says, so `a ?? a[0]` read the first element of an empty
        // buffer — a trap the source language never raises. The left arm is
        // written once here, into the local the answer is read back out of.
        const held = carrier(value.left.type);
        const answer = this.borrow(held);
        this.value(value.left, value.left.type);
        this.keepAndRead(answer);
        if (held === I64) this.i64(0n);
        else if (held === F64) this.float(0, true);
        else if (held === F32) this.float(0, false);
        else this.i32(0);
        this.op(BINARY[held].eq as number);
        this.op(0x04);
        this.code.byte(0x40);
        this.frames.push(this.frame());
        this.value(value.right, value.left.type);
        this.keep(answer);
        this.frames.pop();
        this.op(0x0b);
        this.read(answer);
        this.convert(value.left.type, at);
        this.release(held, answer);
        return;
      }
      case "logical": {
        // A logical operator is a value and not a condition: the arm the truth
        // of the left one chooses. `&&` keeps the right arm when the left one
        // holds and `||` keeps it when the left one does not, so one of them
        // turns that truth over first.
        //
        // The right arm is behind a branch, for the reason the `??` above
        // gives: a `select` over the two arms runs the right one whatever the
        // left one says, and writes the left one down twice to do it. The left
        // arm is written once here, into the local the answer is read back
        // out of, and the right one only when the operator calls for it.
        const held = carrier(at);
        const answer = this.borrow(held);
        this.value(value.left, at);
        this.keepAndRead(answer);
        if (held === I64) this.op(0x50);
        else if (held === F64) {
          this.float(0, true);
          this.op(BINARY[F64].ne as number);
        } else if (held === F32) {
          this.float(0, false);
          this.op(BINARY[F32].ne as number);
        }
        if (value.op === "or") this.op(0x45);
        this.op(0x04);
        this.code.byte(0x40);
        this.frames.push(this.frame());
        this.value(value.right, at);
        this.keep(answer);
        this.frames.pop();
        this.op(0x0b);
        this.read(answer);
        this.release(held, answer);
        return;
      }
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
        // A whole number the module holds as unsigned is divided, ordered and
        // shifted as unsigned, because the instruction is named for how the
        // bits read and not for how the value was declared.
        const unsignedOp = unsigned(compared) ? UNSIGNED_BINARY[held][value.op] : undefined;
        const op = unsignedOp ?? BINARY[held][value.op];
        if (op === undefined) {
          unreachable(`compute ${value.op}`, this.contract, this.candidate);
        }
        this.op(op);
        if (value.k === "compare") {
          this.convert({ kind: "primitive", name: "i32" }, at);
          return;
        }
        this.convert(value.type, at);
        return;
      }
      case "call": {
        // A module reaches no other function of the program, so the only call
        // it can lower is a maths builtin, and that is an instruction over the
        // argument rather than a call. Every argument goes down first, in the
        // order the call passes them, and the instruction takes the last one
        // off the top.
        if (builtinFor(value.call.callee) === null) {
          unreachable(`call ${value.call.callee}`, this.contract, this.candidate);
        }
        for (const [position, argument] of value.call.args.entries()) {
          this.value(argument, value.call.argTypes[position] ?? argument.type);
        }
        this.builtin(value.call.callee);
        this.convert(value.type, at);
        return;
      }
      case "argv":
        // `process.argv.length` and `process.argv(n)` are the same read of the
        // command line, and a module is handed the vectors and no process.
        this.noCommandLine();
        return;
      default:
        unreachable(`hold a value the IR keeps as "${value.k}"`, this.contract, this.candidate);
    }
  }

  /**
   * The refusal a read of the command line gets. The host a module runs under
   * is handed the test vectors on standard input and starts no process, so
   * `process.argv` is nothing the module can reach.
   */
  private noCommandLine(): never {
    throw new CompilerError({
      category: "TargetError",
      stage: "compile",
      message: `a WebAssembly module cannot read the command line, in ${symbolOf(this.contract)}`,
      detail:
        "the host a module runs under is handed the test vectors on standard input and starts no process, so " +
        "process.argv is nothing the module can reach. Build this function as the c, asm or machine output " +
        "kind to read the command line",
      function: symbolOf(this.contract),
      candidate: this.candidate,
    });
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
    // The block is the scope its own names are declared in, so it is on the
    // stack for its statements and for the value its terminator hands back:
    // a name two blocks both give is a different local in each of them.
    this.blocks.push(block.id);
    for (const statement of block.statements) this.statement(statement);
    this.terminator(block.terminator);
    this.blocks.pop();
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
        // A plain `=` computes nothing from what the slot holds, so the old
        // value is never pushed. Pushing it and emitting no operator left it
        // on the stack, and every block this backend opens is void-typed, so
        // the leftover failed the `end` check of the arm it was in.
        if (statement.op === "=") {
          this.value(statement.value, type);
          this.set(statement.name);
          return;
        }
        this.get(statement.name);
        this.value(statement.value, type);
        this.op(compoundCode(held, type, statement.op));
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
        this.address({ k: "local", type: this.slot(statement.buffer), name: statement.buffer }, statement.index, element);
        // A compound operator takes the old element and the new value, while
        // the store that follows takes the address first and the value on top
        // of it. Pushing the address and then the new value and emitting the
        // operator left the operator combining the address and the value, and
        // one value on the stack where a store reads two — a module the engine
        // refuses to validate. So the address is kept in a local, the old
        // element is read at it, the sum is kept in a second one, and the two
        // are read back in the order the store takes them. The load and the
        // store are at the width the element is written at, which is the width
        // the operator works in.
        if (statement.op !== "=") {
          const held = carrier(element);
          const address = this.borrow(I32);
          this.keep(address);
          this.read(address);
          const old = loadCode(element);
          this.op(old.code);
          this.code.varuint(0);
          this.code.varuint(0);
          this.value(statement.value, element);
          this.op(compoundCode(held, element, statement.op));
          const sum = this.borrow(held);
          this.keep(sum);
          this.read(address);
          this.read(sum);
          this.release(held, sum);
          this.release(I32, address);
        } else {
          this.value(statement.value, element);
        }
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
        // The address is the only thing narrowed to the 32 bits the format
        // indexes memory with; the value goes down at the width of its own
        // type, which is the width the store pops. Wrapping the value as well
        // handed `i64.store` and `f64.store` an `i32`.
        this.value(statement.object, ADDRESS);
        this.value(statement.value, statement.value.type);
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
        // A block of its own is emitted without a `block` around it. The names
        // it declares stop meaning past its end, which the scope stack in
        // `block` already says, and the `block` a module opens is a label: a
        // terminator branches either to a loop's header or out of the block
        // that holds the loop, never to this one, so the label it opens is one
        // no jump can name and every branch out of it is a depth deeper than
        // it has to be. Emitting nothing takes the nesting off every scoped
        // block in the function.
        this.block(statement.body, null);
        return;
      case "loop":
        this.loop(statement.loop);
        return;
      case "call":
        // A call written for its effect is the same instruction as a call read
        // for its value, so it takes the same arguments off the stack: a maths
        // builtin is an instruction over its argument, and emitted without one
        // it is an instruction that pops a value nobody pushed.
        if (builtinFor(statement.call.callee) === null) {
          unreachable(`call ${statement.call.callee}`, this.contract, this.candidate);
        }
        for (const [position, argument] of statement.call.args.entries()) {
          this.value(argument, statement.call.argTypes[position] ?? argument.type);
        }
        this.builtin(statement.call.callee);
        // Nothing reads the answer, so it is dropped rather than left for the
        // statement after this one to take as one of its own operands.
        this.op(0x1a);
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
    // A loop declares its index and its element in the block its body is, and
    // the prologue below is part of that loop: the index it starts is the
    // body block's own name, so the block is on the scope stack before it runs.
    this.blocks.push(loop.body.id);
    // A counted loop's bound and its step are read once, before the loop: the
    // head of the turn needs both of them on every pass, and a value tree the
    // source wrote inside the header is the same number on every one of them.
    // They are borrowed rather than declared, so a body without a counted loop
    // carries no local for them.
    let bound = -1;
    let step = -1;
    let end = -1;
    if (loop.kind === "counted") {
      const held = carrier(loop.type);
      bound = this.borrow(held);
      this.value(loop.to, loop.type);
      this.keep(bound);
      step = this.borrow(held);
      this.countedStep(loop);
      this.keep(step);
      // A counted loop moves its index at the head of the turn rather than at
      // the foot, because a `continue` branches to the head: a step at the foot
      // is a step a `continue` skips, and a loop whose index never moves is a
      // loop that never ends. The turn before the first is a turn of its own,
      // so the index starts one step short of the value the source wrote.
      this.value(loop.from, loop.type);
      this.read(step);
      this.op(BINARY[held].sub as number);
      this.set(loop.variable);
    }
    if (loop.kind === "each") {
      // A for-of walks a buffer by a cursor: the index of the element the turn
      // is on, and the count the walk stops at. Both are read out of the same
      // memory the addresses are, so both are 32 bit numbers, and the head of
      // the turn is a `+= 1`, a compare and a branch rather than a 64 bit
      // multiply the engine has to emulate. The walk advances at the head, for
      // the same reason a counted loop does: a `continue` branches to the head,
      // so an advance at the foot is one a `continue` skips. The turn before
      // the first is a turn of its own, so the index starts one short of the
      // first element, and the count is read once: nothing in the body can
      // change the count the host wrote beside the elements.
      this.i32(-1);
      this.set(loop.index);
      end = this.borrow(I32);
      this.value(loop.length, ADDRESS);
      this.keep(end);
    }
    this.op(0x02);
    this.code.byte(0x40);
    this.frames.push(loop.exit);
    this.op(0x03);
    this.code.byte(0x40);
    // A do-while's `continue` branches to the head of the loop, and for it the
    // head is the test and not the body: a branch to the body start would skip
    // the condition, and a loop that never tests its condition is a loop that
    // never ends. Its body therefore sits in a block of its own, and branching
    // to a block runs to its end — which is where the test is. The loop the
    // back edge returns to is a frame of its own, since the header names the
    // block the continue reaches.
    this.frames.push(loop.kind === "doWhile" ? this.frame() : loop.header);
    if (loop.kind === "while") {
      this.condition(loop.condition);
      this.op(0x45);
      this.exitTest();
      this.block(loop.body, null);
      this.backToHeader();
    } else if (loop.kind === "doWhile") {
      this.op(0x02);
      this.code.byte(0x40);
      this.frames.push(loop.header);
      this.block(loop.body, null);
      this.frames.pop();
      this.op(0x0b);
      this.condition(loop.condition);
      this.op(0x0d);
      this.code.varuint(0);
    } else if (loop.kind === "counted") {
      this.get(loop.variable);
      this.read(step);
      // The step is the signed amount the index moves by, so a loop counting
      // down carries a negative one and adds it like any other.
      this.op(BINARY[carrier(loop.type)].add as number);
      this.set(loop.variable);
      this.get(loop.variable);
      this.read(bound);
      const stop = loop.down ? (loop.inclusive ? "ge" : "gt") : loop.inclusive ? "le" : "lt";
      this.op(BINARY[carrier(loop.type)][stop] as number);
      this.op(0x45);
      this.exitTest();
      this.block(loop.body, null);
      this.backToHeader();
    } else {
      // A for-of walks a buffer by a cursor: the index moves on by one, and
      // the walk ends once the index has reached the count that was read
      // before the loop. It counts elements rather than moving the buffer,
      // because the buffer is a name the body reads elsewhere and the walk
      // does not change what it holds.
      this.get(loop.index);
      this.i32(1);
      this.op(BINARY[I32].add as number);
      this.keepAndRead(this.local(loop.index));
      this.read(end);
      // The count is read out of the host's memory as a whole number, so it is
      // ordered as one: a count past the signed range is a count, not a
      // negative number the walk has already passed.
      this.op(UNSIGNED_BINARY[I32].ge as number);
      this.exitTest();
      this.address(
        { k: "local", type: this.slot(loop.of), name: loop.of },
        { k: "local", type: ADDRESS, name: loop.index },
        loop.elementType,
      );
      const load = loadCode(loop.elementType);
      this.op(load.code);
      this.code.varuint(load.align);
      this.code.varuint(0);
      this.convert(loop.elementType, loop.elementType);
      this.set(loop.element);
      this.block(loop.body, null);
      this.backToHeader();
    }
    this.op(0x0b);
    this.frames.pop();
    this.op(0x0b);
    this.frames.pop();
    // The borrows of the head go back in the reverse of the order they were
    // taken, which is the order a stack discipline hands the same local out
    // again: a loop inside this one borrows the same carriers and is finished
    // with them by now.
    if (loop.kind === "counted") {
      this.release(carrier(loop.type), step);
      this.release(carrier(loop.type), bound);
    }
    if (loop.kind === "each") this.release(I32, end);
    this.blocks.pop();
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
    const code = MATH[callee];
    if (code === undefined) {
      if (ARGV_NAMES[callee] === true) this.noCommandLine();
      // `Math.round` is the one maths builtin with no instruction of its own:
      // the source language rounds a half up, and the only rounding a module
      // has rounds a half to even, so nothing in it is the same number.
      throw new CompilerError({
        category: "TargetError",
        stage: "compile",
        message: `a WebAssembly module cannot round the way the source language does, in ${symbolOf(this.contract)}`,
        detail:
          "Math.round rounds a half up and the module's own rounding rounds a half to even, so the two disagree " +
          "on every half. Math.abs, Math.floor, Math.trunc, Math.min and Math.max are one instruction each and " +
          "are lowered. Build this function as the c, asm or machine output kind to round as the source does",
        function: symbolOf(this.contract),
        candidate: this.candidate,
      });
    }
    this.op(code);
  }

  /**
   * The declarations of the locals the body added beyond the parameters, one
   * pair per run of them that share a carrier, in the order they were declared.
   *
   * The module numbers the locals in the order these pairs are written, and
   * `bindings` numbered them in the order the body declares them, so the two
   * have to be the same order. Collecting one pair per distinct carrier instead
   * permuted every local whose carrier was not already a contiguous run, so a
   * body holding a bigint between two numbers wrote a `local.set` against a
   * local of the wrong type and the module was not valid WebAssembly.
   */
  localGroups(): number[] {
    const types: number[] = [];
    for (let position = this.fn.params.length; position < this.declared.length; position += 1) {
      types.push(this.declared[position] as number);
    }
    const groups: number[] = [];
    let index = 0;
    while (index < types.length) {
      const type = types[index];
      if (type === undefined) break;
      let run = 1;
      while (types[index + run] === type) run += 1;
      groups.push(run, type);
      index += run;
    }
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
  // The body is emitted before the locals are declared, because a statement
  // that needs a value twice borrows a local for it, and a local borrowed
  // while the body was emitted was not declared yet. So the body's own bytes
  // are taken first and the declaration they are numbered against is written
  // in front of them afterwards.
  body.block(fn.entry, null);
  // The value a body that falls out of its own end leaves behind is written
  // before the body is copied, because `finish` takes the bytes as they
  // stand: an `answer` after it appends to a buffer nothing reads again, and
  // the `end` that closes the function is left with an empty stack under a
  // type section that declares a result.
  if (result !== undefined) body.answer();
  const emitted = body.finish();
  const groups = body.localGroups();
  code.counted(groups.length / 2, (locals) => groups.forEach((value) => locals.varuint(value)));
  code.raw(emitted);
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
/* Reading a module back                                                       */
/* -------------------------------------------------------------------------- */

/** The sections of a module, by the id the format gives them. */
const SECTIONS: Record<number, string> = {
  0: "custom",
  1: "types",
  2: "imports",
  3: "functions",
  4: "tables",
  5: "memory",
  6: "globals",
  7: "exports",
  8: "start",
  9: "elements",
  10: "code",
  11: "data",
  12: "data count",
};

/** Reads the unsigned integer the format writes in `bits` at `at`. */
function readVaruint(bytes: Uint8Array, at: number, bits: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  for (let index = at; index < bytes.length && shift < bits; index += 1) {
    const byte = bytes[index] ?? 0;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, next: index + 1 };
    shift += 7;
  }
  throw new CompilerError({
    category: "TargetError",
    stage: "compile",
    message: "the module ends in the middle of a length",
    detail: "the bytes read back are not a module the compiler emitted",
  });
}

/**
 * What a module holds, as a reader is told it. A module is binary, so a review
 * of one is shown its shape rather than a listing of it: every section it is
 * made of, how large that section is, and what it exports. That is what can be
 * said about a module without disassembling it, and the rules a review may
 * propose are applied to the IR the module was built from either way.
 */
export function describeModule(bytes: Uint8Array): string {
  const lines: string[] = [`${bytes.length} bytes`, ""];
  const header = bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d;
  if (!header) {
    lines.push("These bytes do not begin with a WebAssembly module header.");
    return lines.join("\n");
  }
  let at = 8;
  while (at < bytes.length) {
    const id = bytes[at] ?? 0;
    const size = readVaruint(bytes, at + 1, 32);
    const name = SECTIONS[id] ?? `section ${id}`;
    lines.push(`${name}: ${size.value} bytes`);
    if (id === 7) {
      lines.push(...readExports(bodyOf(bytes, size)).map((entry) => `  ${entry}`));
    }
    at = size.next + size.value;
  }
  return lines.join("\n");
}

/** The bytes of one section, which is where its own lengths are counted from. */
function bodyOf(bytes: Uint8Array, size: { value: number; next: number }): Uint8Array {
  return bytes.subarray(size.next, size.next + size.value);
}

/** The exports of a module, as one `name (kind)` line each. */
function readExports(body: Uint8Array): string[] {
  const count = readVaruint(body, 0, 32);
  const kinds = ["function", "table", "memory", "global"];
  const entries: string[] = [];
  let at = count.next;
  for (let index = 0; index < count.value && at < body.length; index += 1) {
    const name = readVaruint(body, at, 32);
    const kind = kinds[body[name.next + name.value] ?? 0] ?? "unknown";
    entries.push(`exports ${new TextDecoder().decode(bodyOf(body, name))} (${kind})`);
    at = name.next + name.value + 1 + readVaruint(body, name.next + name.value + 1, 32).value;
  }
  return entries;
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

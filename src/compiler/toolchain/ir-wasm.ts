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
import { boundaryProblems, generateWasmHost, wasmValueType } from "./wasm.ts";
import type { Runner } from "../core/types.ts";
import { parseType, symbolOf } from "../semantics/contract.ts";
import type { FunctionContract } from "../core/types.ts";
import { ARGV, ARGV_LENGTH, builtinFor } from "../semantics/builtins.ts";
import {
  isWide,
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

/**
 * A module under construction: a byte buffer and the LEB128 the format uses.
 *
 * The buffer grows in place rather than as one array element per byte: a
 * module's body is written through three buffers before it is written at all
 * — the body itself, the code entry that frames it, and the module — and one
 * `number[]` push per byte through all three is an array three times the size
 * of the module. Nothing is copied until `build`, and a section copies its
 * body in whole rather than a byte at a time.
 */
class Bytes {
  private buffer = new Uint8Array(256);
  private used = 0;

  /** How many bytes have been written, which is what a section length is. */
  get length(): number {
    return this.used;
  }

  /** The room for one more byte, widened first if what is here will not hold it. */
  private room(extra: number): number {
    const at = this.used;
    this.used += extra;
    if (this.used > this.buffer.length) {
      let size = this.buffer.length * 2;
      while (size < this.used) size *= 2;
      const wider = new Uint8Array(size);
      wider.set(this.buffer.subarray(0, at));
      this.buffer = wider;
    }
    return at;
  }

  /**
   * One byte.
   *
   * The room is taken before the buffer is reached for, because taking it is
   * what widens the buffer: an indexed assignment reads its target before it
   * reads its right-hand side, so `this.buffer[this.room(1)] = value` writes
   * into the buffer that was there before the widening and drops everything
   * past its end.
   */
  byte(value: number): void {
    const at = this.room(1);
    this.buffer[at] = value & 0xff;
  }

  raw(values: ArrayLike<number>): void {
    // The room is taken before the write, because taking it is what widens the
    // buffer: reaching for `this.buffer` first and asking for room afterwards
    // would write into the buffer that was there before the widening, and
    // everything past its end is dropped.
    const at = this.room(values.length);
    this.buffer.set(values, at);
  }

  /**
   * Another buffer's bytes, written here whole. A section writes its body into
   * a buffer of its own so that the length is known before it is stated, and
   * this is how that body joins this one: one copy, rather than one array
   * element per byte on the way through the copy.
   */
  absorb(other: Bytes): void {
    if (other.used === 0) return;
    const at = this.room(other.used);
    this.buffer.set(other.buffer.subarray(0, other.used), at);
  }

  /**
   * Gives back everything written past `length`, for an instruction that
   * turned out to have no effect. The bytes stay in the buffer; only the
   * length moves, and whatever is written next goes over them.
   */
  truncate(length: number): void {
    this.used = length;
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
    const encoded = ENCODER.encode(value);
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
    this.absorb(body);
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
    this.varuint(body.length);
    this.absorb(body);
  }

  build(): Uint8Array {
    return this.buffer.slice(0, this.used);
  }
}

/** The encoder of the few names a module carries, rather than one per name. */
const ENCODER = new TextEncoder();

/* -------------------------------------------------------------------------- */
/* The numeric instruction set                                                 */
/* -------------------------------------------------------------------------- */

const I32 = 0x7f;
const I64 = 0x7e;
const F32 = 0x7d;
const F64 = 0x7c;

/**
 * Everything the lowering needs to know about one type, worked out once.
 *
 * A type decides the carrier it is held in, whether that carrier reads it as
 * unsigned, the width the host lays one of its elements out at, the shift that
 * scales an index of them, and the two memory instructions at that width. None
 * of it varies by anything but the type's name, and a body asks the same
 * questions of the same handful of types at every element of every loop, so
 * the answers are worked out the first time and read out of a map thereafter.
 */
interface TypeFacts {
  /** The carrier the module carries a value of this type in. */
  held: number;
  /** Whether a whole number is one the module reads as unsigned. */
  unsigned: boolean;
  /** The width one element of a buffer takes, which is the width the host lays it out at. */
  size: number;
  /** How far one element is from the next, as a shift, or `-1` when that is no shift at all. */
  shift: number;
  /** The load that reads a value of this type at its width. */
  load: { code: number; align: number };
  /** The store that writes a value of this type at its width. */
  store: { code: number; align: number };
}

/** The width one element of a buffer takes, which is the width the host lays it out at. */
const WIDTHS: Record<string, number> = {
  bool: 1, i8: 1, u8: 1, i16: 2, u16: 2, i32: 4, u32: 4, f32: 4, i64: 8, u64: 8, usize: 8, isize: 8, f64: 8,
};

/** The loads that read a value at a width, by the carrier it is read into. */
const LOADS: Record<number, Record<number, { code: number; align: number }>> = {
  [I32]: { 1: { code: 0x2c, align: 0 }, 2: { code: 0x2e, align: 1 }, 4: { code: 0x28, align: 2 } },
  [I64]: { 1: { code: 0x30, align: 0 }, 2: { code: 0x32, align: 1 }, 4: { code: 0x34, align: 2 }, 8: { code: 0x29, align: 3 } },
  [F32]: { 4: { code: 0x2a, align: 2 } },
  [F64]: { 8: { code: 0x2b, align: 3 } },
};

/**
 * The loads of a whole number the module reads as unsigned, which the format
 * spells out separately for the one- and two-byte widths: the same bytes read
 * as a signed byte of `-1` are `255` here, and a sign-extended `u32` is a
 * number past the range the source wrote.
 */
const UNSIGNED_LOADS: Record<number, Record<number, { code: number; align: number }>> = {
  [I32]: { 1: { code: 0x2d, align: 0 }, 2: { code: 0x2f, align: 1 }, 4: { code: 0x28, align: 2 } },
};

/** The stores that write a value at a width, by the carrier it is written from. */
const STORES: Record<number, Record<number, { code: number; align: number }>> = {
  [I32]: { 1: { code: 0x3a, align: 0 }, 2: { code: 0x3b, align: 1 }, 4: { code: 0x36, align: 2 } },
  [I64]: { 1: { code: 0x3c, align: 0 }, 2: { code: 0x3d, align: 1 }, 4: { code: 0x3e, align: 2 }, 8: { code: 0x37, align: 3 } },
  [F32]: { 4: { code: 0x38, align: 2 } },
  [F64]: { 8: { code: 0x39, align: 3 } },
};

/**
 * The facts about a type that is not one of the primitives: a reference, a
 * slice, a buffer and an array are all a byte offset into the memory the host
 * provides, pointing at the first element. The count of a buffer is the word
 * the offset sits one before, which the host writes there because a length
 * arrives with no argument of its own.
 */
const REFERENCE: TypeFacts = {
  held: I32,
  unsigned: false,
  size: 8,
  shift: 3,
  load: { code: 0x28, align: 2 },
  store: { code: 0x36, align: 2 },
};

const FACTS = new Map<string, TypeFacts>();

function facts(type: SemanticType): TypeFacts {
  // A wide number is refused here rather than described, and this is the one
  // place the refusal belongs. Everything below is a table keyed by a single
  // WebAssembly value type: a `TypeFacts` names the one carrier a value lives in
  // and the load and store that move it. A `u256` has no such carrier — it is
  // four `i64` limbs laid out in memory — so describing it would mean answering
  // `i64` and a size of eight, and every load and store of it would then move a
  // quarter of the value.
  //
  // Refusing keeps that unreachable: nothing below has to know what a wide
  // number is, because no value of one ever arrives.
  if (type.kind === "primitive" && isWide(type.name)) {
    throw new CompilerError({
      category: "AssemblyError",
      stage: "wasm",
      message: `this backend cannot lower a ${type.name}`,
      detail: "a wide number is four 64 bit limbs laid out in memory and WebAssembly has no value type for one; lower this function to the c backend, where a wide operation is a call into the wide kernel",
    });
  }
  if (type.kind !== "primitive") return REFERENCE;
  const known = FACTS.get(type.name);
  if (known !== undefined) return known;
  const wasm = wasmValueType(type);
  const held = wasm === "i64" ? I64 : wasm === "f32" ? F32 : wasm === "f64" ? F64 : I32;
  const isUnsigned = type.name === "u8" || type.name === "u16" || type.name === "u32" || type.name === "u64" || type.name === "usize";
  const size = WIDTHS[type.name] ?? 8;
  const loads = (isUnsigned ? UNSIGNED_LOADS[held] : undefined) ?? LOADS[held];
  const computed: TypeFacts = {
    held,
    unsigned: isUnsigned,
    size,
    shift: size <= 1 ? -1 : Math.log2(size),
    load: loads?.[size] ?? REFERENCE.load,
    store: STORES[held]?.[size] ?? REFERENCE.store,
  };
  FACTS.set(type.name, computed);
  return computed;
}

/** The binary operators of one carrier type, by the name the IR gives them. */
const BINARY: Record<number, Record<string, number>> = {
  [I32]: {
    add: 0x6a, sub: 0x6b, mul: 0x6c, div: 0x6d, mod: 0x6f, and: 0x71, or: 0x72, xor: 0x73,
    shl: 0x74, shr: 0x75, ushr: 0x77, eq: 0x46, ne: 0x47, lt: 0x48, gt: 0x4a, le: 0x4c, ge: 0x4e,
  },
  [I64]: {
    add: 0x7c, sub: 0x7d, mul: 0x7e, div: 0x7f, mod: 0x81, and: 0x83, or: 0x84, xor: 0x85,
    shl: 0x86, shr: 0x87, ushr: 0x89, eq: 0x51, ne: 0x52, lt: 0x53, gt: 0x55, le: 0x57, ge: 0x59,
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
  [I32]: { div: 0x6e, mod: 0x70, shr: 0x76, ushr: 0x77, lt: 0x49, gt: 0x4b, le: 0x4d, ge: 0x4f },
  [I64]: { div: 0x80, mod: 0x82, shr: 0x88, ushr: 0x89, lt: 0x54, gt: 0x56, le: 0x58, ge: 0x5a },
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
  "Math.sqrt": 0x9f,
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
 * The type a truth is written and converted in. An `i32` is what the format
 * reads a test as, and naming the type once means the conversions that leave
 * a truth do not each build their own.
 */
const TRUTH: SemanticType = { kind: "primitive", name: "bool" };

/**
 * The eight bytes a float constant is written out of, kept for the whole
 * module rather than made per constant. A constant is read back one byte at a
 * time straight after it is written, so nothing else is looking at it.
 */
const FLOAT_BYTES = new DataView(new ArrayBuffer(8));

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
  const code = facts(type).unsigned ? UNSIGNED_BINARY[held][name] : undefined;
  return (code ?? BINARY[held][name]) as number;
}

/* -------------------------------------------------------------------------- */
/* The body                                                                    */
/* -------------------------------------------------------------------------- */

/** A name the body reads: the local it is held in and the type it is read as. */
interface Local {
  index: number;
  type: SemanticType;
}

/**
 * One block the body is inside.
 *
 * `allocated` is null where the scope did not hand the names out itself. A
 * loop's body is entered twice — once for the header that reads its index and
 * once for the statements — and the second entry reuses the first's names
 * rather than declaring a second set of locals for them.
 */
interface Scope {
  id: string;
  names: Map<string, Local>;
  allocated: number[] | null;
}

/**
 * Compiles one function's IR to the body of one wasm function.
 *
 * Every value in the IR is a tree, so each one is emitted where it is used and
 * needs no temporary: the only thing that outlives its own expression is a
 * slot, and a slot is a local. A name is one local per block that declares it,
 * so a name two blocks both give is two values, and the block the body is
 * emitting is what says which of them a use means.
 */
class Body {
  private readonly code = new Bytes();
  /** The carrier of every local, in the order the module numbers them. */
  private readonly declared: number[] = [];
  /**
   * The locals of each carrier that are free to be handed out again, most
   * recently freed first.
   *
   * Two things hold a local only for as long as they need it. A borrow is a
   * value a statement needs twice, and it nests — the right arm of a `&&`
   * borrows the same carrier the whole operator borrowed — so a local is only
   * free once the statement that borrowed it has finished with it. A name
   * means from the `let` that declares it to the end of the block that
   * declares it, and is free once the body has emitted past that end. One
   * pool for the two is what lets a name that stopped meaning and a temporary
   * share a slot, and it is why a `let` in every nested block of a function is
   * not a frame slot in every engine.
   */
  private readonly spare = new Map<number, number[]>();
  /** The names each block that has been entered declares. */
  private readonly byBlock = new Map<string, Map<string, Local>>();
  /** The blocks the body is inside, outermost first. */
  private readonly scopes: Scope[] = [];
  /** The labels the body has opened that a jump names, and where each is. */
  private readonly frames: string[] = [];
  private readonly labelAt = new Map<string, number>();
  private readonly fn: SemanticFunction;
  private readonly contract: FunctionContract;
  private readonly returns: SemanticType;
  private readonly candidate: string | undefined;
  /** How many labels the body has opened that the IR does not name. */
  private anonymous = 0;
  /** The local the instruction at the end of the body read, or -1 for another. */
  private readLocal = -1;
  /** Where in the body that read began. */
  private readAt = -1;
  /** A float constant already laid down in a global, by the number and its precision. */
  private readonly pooled = new Map<string, number>();
  /** Every float constant the body laid down, in the order the globals are numbered. */
  readonly pooledFloats: { type: number; opcode: number; bytes: number[] }[] = [];

  constructor(fn: SemanticFunction, contract: FunctionContract, returns: SemanticType, candidate: string | undefined) {
    this.fn = fn;
    this.contract = contract;
    this.returns = returns;
    this.candidate = candidate;
    // A parameter is a local the module numbers before any other, because the
    // function's type is written in that order, and it is never handed back
    // to the pool: the host filled it before the body ran and every `local`
    // in the body reads it.
    this.open(fn.entry);
    for (const param of fn.params) {
      const type = slotType(param);
      const scope = this.scopes[this.scopes.length - 1] as Scope;
      scope.names.set(param.name, { index: this.declared.length, type });
      this.declared.push(facts(type).held);
    }
  }

  /**
   * A block's names are its own while the body is inside it. Entering a block
   * the body is already inside reuses those names rather than declaring a
   * second set of locals, which is what a loop's header and its body are.
   */
  private open(block: SemanticBlock): void {
    const known = this.byBlock.get(block.id);
    this.byBlock.set(block.id, known ?? new Map());
    this.scopes.push({ id: block.id, names: known ?? this.byBlock.get(block.id) as Map<string, Local>, allocated: known === undefined ? [] : null });
  }

  /**
   * Leaves the innermost block, handing every name it declared back to the
   * pool. Nothing reads a name past the end of the block that declares it —
   * that is what the scope stack is for — so the local is free the moment the
   * body has emitted the block's terminator, and a sibling block that declares
   * the same name of the same carrier takes it.
   */
  private close(): void {
    const scope = this.scopes.pop();
    if (scope === undefined || scope.allocated === null) return;
    for (const index of scope.allocated) this.release(this.declared[index] as number, index);
    this.byBlock.delete(scope.id);
  }

  /**
   * The local one name is held in, taken from the pool of its carrier or made
   * a new one, and recorded against the block that declares it so leaving that
   * block hands it back.
   */
  private holdLocal(name: string, type: SemanticType): Local {
    const held = facts(type).held;
    const reused = this.spare.get(held)?.pop();
    const local: Local = { index: reused ?? this.declared.length, type };
    if (reused === undefined) this.declared.push(held);
    const scope = this.scopes[this.scopes.length - 1] as Scope;
    scope.names.set(name, local);
    scope.allocated?.push(local.index);
    return local;
  }

  /**
   * A local of one carrier to hold a value for the span of a statement. The
   * format has no way to copy what is on the stack, so a statement that needs
   * one value twice asks for a local to keep the first in.
   */
  private borrow(held: number): number {
    const reused = this.spare.get(held)?.pop();
    if (reused !== undefined) return reused;
    const index = this.declared.length;
    this.declared.push(held);
    return index;
  }

  /** Hands a local back, so a later borrow or name of that carrier takes it. */
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
    this.readLocal = at;
    this.readAt = this.code.length - this.varuintLength(at) - 1;
  }

  /**
   * Reads a local back and leaves it where it was, which is what a value that
   * is both the answer and the test of a branch has to be.
   */
  private keepAndRead(at: number): void {
    this.op(0x22);
    this.code.varuint(at);
  }

  private varuintLength(value: number): number {
    let rest = value >>> 0;
    let length = 1;
    while (rest > 0x7f) {
      rest >>>= 7;
      length += 1;
    }
    return length;
  }

  private op(value: number): void {
    this.code.byte(value);
    this.readLocal = -1;
    this.readAt = -1;
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

  /**
   * A float constant, read out of the module's own globals rather than written
   * out again at every place it appears.
   *
   * `f64.const` carries eight raw bytes, so a constant used k times costs 9k
   * bytes and materialises those eight bytes every time the instruction runs.
   * The machine backend writes such a constant once into the read-only data and
   * loads it at each use, which is what a `global` is here as well: the first
   * use lays the number down in a global of its own and every use reads it.
   *
   * The type of the global is the precision the literal was written at, so a
   * `f32` and an `f64` of the same number are two globals and not one.
   */
  private float(value: number, wide: boolean): void {
    const key = `${wide ? "f64" : "f32"}:${value}`;
    const known = this.pooled.get(key);
    if (known !== undefined) {
      this.op(0x23);
      this.code.varuint(known);
      return;
    }
    if (wide) FLOAT_BYTES.setFloat64(0, value, true);
    else FLOAT_BYTES.setFloat32(0, value, true);
    const size = wide ? 8 : 4;
    const bytes: number[] = [];
    for (let at = 0; at < size; at += 1) bytes.push(FLOAT_BYTES.getUint8(at));
    this.pooled.set(key, this.pooledFloats.length);
    this.pooledFloats.push({ type: wide ? F64 : F32, opcode: wide ? 0x44 : 0x43, bytes });
    // A global read is the first use of the number laid down; the number itself
    // is written once, into the global section, and nowhere in the body.
    this.op(0x23);
    this.code.varuint(this.pooledFloats.length - 1);
  }

  /**
   * The local a name means where the body is, which is the one the innermost
   * block that declares it holds. A name is one local per block that declares
   * it, so the block the body is emitting is what says which of them a use is.
   */
  private resolve(name: string): Local {
    for (let position = this.scopes.length - 1; position >= 0; position -= 1) {
      const local = (this.scopes[position] as Scope).names.get(name);
      if (local !== undefined) return local;
    }
    throw new CompilerError({
      category: "SemanticIrError",
      stage: "semantic-ir",
      message: `the body of ${symbolOf(this.contract)} reads "${name}", which it declares nowhere`,
    });
  }

  private get(name: string): Local {
    const local = this.resolve(name);
    this.readAt = this.code.length;
    this.op(0x20);
    this.code.varuint(local.index);
    this.readLocal = local.index;
    return local;
  }

  private set(name: string): void {
    const local = this.resolve(name);
    // A read of a local that the very next instruction overwrites with the
    // same local reads nothing: the value is on the stack for the write and
    // the write puts back what it took off. Both go, which is one instruction
    // and one index less wherever a statement reads a name into itself.
    if (this.readLocal === local.index) {
      this.code.truncate(this.readAt);
      this.readLocal = -1;
      this.readAt = -1;
      return;
    }
    this.op(0x21);
    this.code.varuint(local.index);
  }

  /** The relative depth a labelled frame is reached by from where the body is. */
  private depth(id: string): number {
    const at = this.labelAt.get(id);
    if (at !== undefined) return this.frames.length - 1 - at;
    throw new CompilerError({
      category: "SemanticIrError",
      stage: "semantic-ir",
      message: `a jump to "${id}" leaves no block or loop it is a break or a continue of`,
    });
  }

  /**
   * A label the body has opened that a jump may name, at the depth it is
   * reached by. An `if` or a block of its own still opens one, and the format
   * counts every label a branch reaches past, so it is opened under a name no
   * terminator can ask for.
   */
  private push(id: string | null): string {
    this.anonymous += 1;
    const label = id ?? `#${this.anonymous}`;
    this.labelAt.set(label, this.frames.length);
    this.frames.push(label);
    return label;
  }

  /** Closes the innermost label, which is the one a `break` of it leaves. */
  private pop(): void {
    const label = this.frames.pop();
    if (label !== undefined) this.labelAt.delete(label);
  }

  /** Converts what is on the stack into the type a use reads it in. */
  private convert(from: SemanticType, to: SemanticType): void {
    const held = facts(from).held;
    const wanted = facts(to).held;
    if (held === wanted) return;
    if (held === I32 && wanted === I64) {
      this.op(facts(from).unsigned ? 0xad : 0xac);
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
    this.op(whole ? (facts(from).unsigned ? pair.unsigned : pair.signed) : facts(to).unsigned ? pair.unsigned : pair.signed);
  }

  /**
   * The truth of a value on the stack, as the i32 the source language reads a
   * test in: nonzero is true. Whatever carrier the value is held in, what is
   * left here is always an i32, so every site that wants a truth — an `if`,
   * a `select`, the arm a `do-while` re-tests on — consumes it as it stands
   * and none of them has to ask what is there first.
   *
   * An i32 is its own truth, because the format reads every nonzero i32 as
   * true wherever a test is wanted and the source language reads it the same
   * way. The two wider carriers each need one instruction of their own, and
   * which one they need depends on the answer being asked for: `i64.eqz` is
   * the falsity of a 64 bit whole number, so it is what `negation` takes and
   * what `condition` turns over, and the same is true of `f64.eq 0` against
   * `f64.ne 0`. Emitting each answer at the carrier that has it cheapest is
   * what keeps a `while` over a 64 bit whole number at one instruction where
   * asking for the truth first and turning it over again spent two.
   */
  private condition(value: SemanticValue): void {
    this.value(value, value.type);
    this.truth(facts(value.type).held);
  }

  /** The falsity of a value on the stack, as an i32 nonzero where the value does not hold. */
  private negation(value: SemanticValue): void {
    this.value(value, value.type);
    this.lie(facts(value.type).held);
  }

  /** The truth of what is on the stack, at the carrier it is held in. */
  private truth(held: number): void {
    if (held === I32) return;
    if (held === I64) {
      // `i64.eqz` is the falsity of a 64 bit whole number, so the truth turns
      // it over. A `while` asks for the falsity and takes the `eqz` on its
      // own; an `if` asks for the truth and pays the one more instruction.
      this.op(0x50);
      this.op(0x45);
      return;
    }
    this.float(0, held === F64);
    this.op(BINARY[held].ne as number);
  }

  /** The falsity of what is on the stack, at the carrier it is held in. */
  private lie(held: number): void {
    if (held === I32) {
      this.op(0x45);
      return;
    }
    if (held === I64) {
      this.op(0x50);
      return;
    }
    this.float(0, held === F64);
    this.op(BINARY[held].eq as number);
  }

  /**
   * The truth of a test the compiler already knows, or null where the test is
   * a value it has to emit.
   *
   * A `bool` is the answer the IR resolved to, and a `const` is the number the
   * source wrote: a nonzero number holds and a zero does not, on every
   * carrier, which is what the two operators above compute. A `not-a-number`
   * is not zero, so it holds here as `f64.ne 0` says it does — the backend
   * does not give a whole other reading to a number it cannot compare.
   */
  private known(value: SemanticValue): boolean | null {
    if (value.k === "bool") return value.value;
    if (value.k !== "const") return null;
    const held = facts(value.type).held;
    if (held === I32) return (Number(BigInt(value.text)) | 0) !== 0;
    if (held === I64) return BigInt(value.text) !== 0n;
    return Number(value.text) !== 0;
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
    const shift = facts(type).shift;
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
        this.constant(value.text, value.type, at);
        return;
      case "bool":
        // A truth and a nothing are a one and a zero, and every carrier holds
        // both exactly, so each is written at the carrier its use reads it in
        // rather than as an `i32` and a conversion to it.
        this.literal(value.value ? "1" : "0", facts(at).held);
        return;
      case "nothing":
        this.literal("0", facts(at).held);
        return;
      case "local": {
        const local = this.get(value.name);
        this.convert(local.type, at);
        return;
      }
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
        const load = facts(value.type).load;
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
        const load = facts(value.type).load;
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
        const held = facts(value.type).held;
        if (value.op === "pos") {
          this.value(value.operand, at);
          return;
        }
        if (value.op === "not") {
          // The falsity of the operand is the whole of what `!x` is, and each
          // carrier has that in one instruction of its own: `i32.eqz`,
          // `i64.eqz` and `f64.eq 0`. Asking for the truth first and turning
          // it over spent two of them over a 64 bit whole number and over a
          // float, where the falsity was already what `condition` had built.
          this.negation(value.operand);
          this.convert(TRUTH, at);
          return;
        }
        // WebAssembly has no `i32.neg` and no `i64.neg`, and no integer
        // complement: an integer is negated by taking it from a zero of its own
        // width, and a complement is `0 - 1 - x`, which is `~x` in two's
        // complement at every width. A sub takes its left operand first, so the
        // zero goes down before the value: `x - 0` is not a negation of
        // anything. A float width is the one case with a negation of its own
        // (`f32.neg`, `f64.neg`), and it uses it.
        //
        // A complement over a whole number is not that arithmetic at all: in
        // two's complement `~x` is the exclusive-or of `x` with every bit set,
        // which is one instruction and one constant rather than two of each.
        // The constant is a `-1` of the operand's own width, so the exclusive
        // or is the one of that width and the answer is the same number at
        // every width the two's complement of that width gives.
        if (value.op === "bitNot" && (held === I32 || held === I64)) {
          if (held === I64) this.i64(-1n);
          else this.i32(-1);
          this.value(value.operand, value.type);
          this.op(BINARY[held].xor as number);
        } else if (value.op === "bitNot") {
          if (held === F64) this.float(0, true);
          else this.float(0, false);
          this.value(value.operand, value.type);
          this.op(BINARY[held].sub as number);
          if (held === F64) this.float(1, true);
          else this.float(1, false);
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
        const width = facts(value.operand.type).held;
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
        const held = facts(value.left.type).held;
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
        this.push(null);
        this.value(value.right, value.left.type);
        this.keep(answer);
        this.pop();
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
        const held = facts(at).held;
        const answer = this.borrow(held);
        this.value(value.left, at);
        this.keepAndRead(answer);
        // `&&` takes the right arm when the left one holds and `||` takes it
        // when the left one does not, so the two ask for opposite answers and
        // each carrier has the one it wants in a single instruction. Which
        // instruction that is depends on the carrier: over a whole number `x`
        // holds when `x` is nonzero and `i64.eqz` is the falsity of it, so
        // `&&` turns that over and `||` takes it as it stands.
        if (value.op === "or") this.lie(held);
        else this.truth(held);
        this.op(0x04);
        this.code.byte(0x40);
        this.push(null);
        this.value(value.right, at);
        this.keep(answer);
        this.pop();
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
        const held = facts(compared).held;
        this.value(value.left, compared);
        this.value(value.right, compared);
        // A whole number the module holds as unsigned is divided, ordered and
        // shifted as unsigned, because the instruction is named for how the
        // bits read and not for how the value was declared.
        const unsignedOp = facts(compared).unsigned ? UNSIGNED_BINARY[held][value.op] : undefined;
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

  /**
   * A literal, at the carrier the use reads it in where that carrier holds the
   * number the literal's own type holds, and at the literal's own type
   * converted where it does not.
   *
   * A constant is one instruction per carrier, so a literal written at the
   * width it is read in costs one instruction where one written at its own
   * width and converted costs two: an `i32` literal read as a `bigint` is
   * `i64.const` rather than `i32.const` and an `i64.extend_i32_s`, and a
   * `nothing` read as a double is `f64.const 0` rather than `i32.const 0` and
   * an `f64.convert_i32_s`. The re-spelling is only the same number where the
   * destination carrier holds the value exactly, which is what `exact` asks
   * and what `convert`'s table already assumes of the conversions it does in
   * one instruction: `3000000000` read as a `f64` is itself, and the same
   * literal read as an `i32` is a different number, so it keeps the path
   * through the conversion.
   */
  private constant(text: string, type: SemanticType, at: SemanticType): void {
    const held = facts(type).held;
    const wanted = facts(at).held;
    // The number the literal's own carrier holds is what a conversion would
    // have been applied to, so it is the number whose exactness at the
    // destination decides whether that carrier can hold it as it stands.
    const value = this.valueOf(text, held);
    this.literal(text, held !== wanted && !this.exact(value, wanted) ? held : wanted);
  }

  /** The number a literal denotes at one carrier. */
  private valueOf(text: string, held: number): number | bigint {
    if (held === I64) return BigInt.asIntN(64, BigInt(text));
    if (held === F32) return Math.fround(Number(text));
    if (held === F64) return Number(text);
    // An `i32` constant is a signed 32 bit word, so a whole number past the
    // signed range is the value its low half reads back as — the same number
    // the conversion this re-spells would have widened.
    return Number(BigInt(text)) | 0;
  }

  /** A literal written as the constant of one carrier. */
  private literal(text: string, held: number): void {
    if (held === I64) {
      this.i64(BigInt.asIntN(64, BigInt(text)));
      return;
    }
    if (held === F64) {
      this.float(Number(text), true);
      return;
    }
    if (held === F32) {
      this.float(Math.fround(Number(text)), false);
      return;
    }
    this.i32(Number(BigInt(text)) | 0);
  }


  /** Whether one carrier holds a value exactly, which is what makes the re-spelling the same number. */
  private exact(value: number | bigint, wanted: number): boolean {
    if (typeof value === "bigint") {
      if (wanted === I32) return BigInt.asIntN(32, value) === value;
      if (wanted === I64) return BigInt.asIntN(64, value) === value;
      const asFloat = Number(value);
      if (wanted === F32) return Number.isInteger(asFloat) && BigInt(Math.fround(asFloat)) === value;
      return Number.isInteger(asFloat) && BigInt(asFloat) === value;
    }
    // A float read as a whole number is truncated, so the literal is that
    // number only where it is already a whole one inside the signed range:
    // past it the conversion traps rather than answers, and a `f32` read as a
    // `f64` is a widening that always holds.
    if (wanted === I32) return Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
    if (wanted === I64) {
      return Number.isInteger(value) && value >= -9223372036854775808 && value <= 9223372036854775807;
    }
    return wanted === F64 || Math.fround(value) === value;
  }

  block(block: SemanticBlock, label: string | null): void {
    if (label !== null) this.push(label);
    // The block is the scope its own names are declared in, so it is on the
    // stack for its statements and for the value its terminator hands back:
    // a name two blocks both give is a different local in each of them.
    this.open(block);
    for (const statement of block.statements) this.statement(statement);
    this.terminator(block.terminator);
    this.close();
    if (label !== null) this.pop();
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
        // The name is declared before its value is emitted: the value is
        // emitted inside the block that declares the name, and a name that
        // block has not declared yet is not one its value can read.
        this.holdLocal(statement.slot.name, slotType(statement.slot));
        this.value(statement.value, slotType(statement.slot));
        this.set(statement.slot.name);
        return;
      case "set": {
        const type = this.resolve(statement.name).type;
        const held = facts(type).held;
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
        const held = facts(this.resolve(statement.name).type).held;
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
        const buffer = this.resolve(statement.buffer);
        const element = elementTypeOf(buffer.type);
        if (element === null) {
          unreachable(`write an element of "${statement.buffer}"`, this.contract, this.candidate);
        }
        this.address({ k: "local", type: buffer.type, name: statement.buffer }, statement.index, element);
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
          const held = facts(element).held;
          const address = this.borrow(I32);
          this.keep(address);
          this.read(address);
          const old = facts(element).load;
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
        const store = facts(element).store;
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
        const store = facts(statement.value.type).store;
        this.op(store.code);
        this.code.varuint(store.align);
        this.code.varuint(field.offset);
        return;
      }
      case "if": {
        // A test the compiler already knows the answer to is not a branch: an
        // `if` over a literal truth, or over a literal number, runs one arm
        // every time, so only that arm is emitted and neither the test nor the
        // other arm is. No frame is opened either, because there is no `if`
        // instruction left for one to be the depth of: the arm is emitted as
        // the block of its own that an `if` arm is, and a jump out of it is
        // the same depth it was before the arm existed.
        const known = this.known(statement.condition);
        if (known !== null) {
          const taken = known ? statement.then : statement.otherwise;
          if (taken !== null) this.block(taken, null);
          return;
        }
        // An `if` opens a label the format counts when a branch reaches for one,
        // so it is a frame like a loop's — a jump out of an arm is a depth from
        // here, and a depth that forgets the arm is a jump to the wrong place.
        this.condition(statement.condition);
        this.op(0x04);
        this.code.byte(0x40);
        this.push(null);
        this.block(statement.then, null);
        if (statement.otherwise !== null) {
          this.op(0x05);
          this.block(statement.otherwise, null);
        }
        this.pop();
        this.op(0x0b);
        return;
      }
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
    // The body block is entered again below to emit its statements, and the
    // second entry finds these names already declared rather than a second set
    // of locals for them.
    this.open(loop.body);
    // A counted loop's bound and its step are read once, before the loop: the
    // head of the turn needs both of them on every pass, and a value tree the
    // source wrote inside the header is the same number on every one of them.
    // They are borrowed rather than declared, so a body without a counted loop
    // carries no local for them.
    let bound = -1;
    let step = -1;
    let end = -1;
    if (loop.kind === "counted") {
      const held = facts(loop.type).held;
      this.holdLocal(loop.variable, loop.type);
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
      // the first is a turn of its own, so the index starts one step short of
      // the first element, and the count is read once: nothing in the body can
      // change the count the host wrote beside the elements.
      // The index of a walk is a count of elements, and it is held in the 32
      // bits an address is counted in: the count the module compares it
      // against is read out of the same memory the addresses are, so the two
      // are 32 bit numbers either way. A use that reads it wider is converted
      // where it is read, which widens the very same count.
      this.holdLocal(loop.index, ADDRESS);
      this.holdLocal(loop.element, loop.elementType);
      this.i32(-1);
      this.set(loop.index);
      end = this.borrow(I32);
      this.value(loop.length, ADDRESS);
      this.keep(end);
    }
    this.op(0x02);
    this.code.byte(0x40);
    this.push(loop.exit);
    this.op(0x03);
    this.code.byte(0x40);
    // A do-while's `continue` branches to the head of the loop, and for it the
    // head is the test and not the body: a branch to the body start would skip
    // the condition, and a loop that never tests its condition is a loop that
    // never ends. Its body therefore sits in a block of its own, and branching
    // to a block runs to its end — which is where the test is. The loop the
    // back edge returns to is a frame of its own, since the header names the
    // block the continue reaches.
    this.push(loop.kind === "doWhile" ? null : loop.header);
    if (loop.kind === "while") {
      // The exit is tested against the falsity of the condition, and `br_if`
      // branches on a nonzero value, so what it takes is the falsity rather
      // than the truth turned over again. Over a 64 bit whole number that is
      // `i64.eqz` on its own, where the truth followed by an `i32.eqz` spent
      // two instructions to ask the same question.
      this.negation(loop.condition);
      this.exitTest();
      this.block(loop.body, null);
      this.backToHeader();
    } else if (loop.kind === "doWhile") {
      this.op(0x02);
      this.code.byte(0x40);
      this.push(loop.header);
      this.block(loop.body, null);
      this.pop();
      this.op(0x0b);
      this.condition(loop.condition);
      this.op(0x0d);
      this.code.varuint(0);
    } else if (loop.kind === "counted") {
      this.get(loop.variable);
      this.read(step);
      // The step is the signed amount the index moves by, so a loop counting
      // down carries a negative one and adds it like any other.
      this.op(BINARY[facts(loop.type).held].add as number);
      this.set(loop.variable);
      this.get(loop.variable);
      this.read(bound);
      const stop = loop.down ? (loop.inclusive ? "ge" : "gt") : loop.inclusive ? "le" : "lt";
      this.op(BINARY[facts(loop.type).held][stop] as number);
      // The exit is tested against the falsity of the comparison, for the
      // reason the `while` above gives.
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
      const index = this.get(loop.index);
      this.i32(1);
      this.op(BINARY[I32].add as number);
      this.keepAndRead(index.index);
      this.read(end);
      // The count is read out of the host's memory as a whole number, so it is
      // ordered as one: a count past the signed range is a count, not a
      // negative number the walk has already passed.
      this.op(UNSIGNED_BINARY[I32].ge as number);
      this.exitTest();
      this.address(
        { k: "local", type: this.resolve(loop.of).type, name: loop.of },
        { k: "local", type: ADDRESS, name: loop.index },
        loop.elementType,
      );
      const load = facts(loop.elementType).load;
      this.op(load.code);
      this.code.varuint(load.align);
      this.code.varuint(0);
      this.convert(loop.elementType, loop.elementType);
      this.set(loop.element);
      this.block(loop.body, null);
      this.backToHeader();
    }
    this.op(0x0b);
    this.pop();
    this.op(0x0b);
    this.pop();
    // The borrows of the head go back in the reverse of the order they were
    // taken, which is the order a stack discipline hands the same local out
    // again: a loop inside this one borrows the same carriers and is finished
    // with them by now.
    if (loop.kind === "counted") {
      this.release(facts(loop.type).held, step);
      this.release(facts(loop.type).held, bound);
    }
    if (loop.kind === "each") this.release(I32, end);
    this.close();
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
    if (facts(this.returns).held === I64) {
      this.i64(0n);
      return;
    }
    this.i32(0);
  }

  /**
   * The buffer the body was written into, which the code section writes in
   * whole rather than reading out and copying back in.
   */
  bytes(): Bytes {
    return this.code;
  }
}

/* -------------------------------------------------------------------------- */
/* The module                                                                  */
/* -------------------------------------------------------------------------- */

const MODULE_HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

export function moduleBytes(
  fn: SemanticFunction,
  contract: FunctionContract,
  candidate?: string,
): Uint8Array {
  const returns = parseType(contract.function.returns);
  const body = new Body(fn, contract, returns, candidate);
  const parameters = fn.params.map((param) => facts(slotType(param)).held);
  const result = returns.kind === "void" ? undefined : facts(returns).held;
  // The body is emitted into a buffer of its own, because a statement that
  // needs a value twice borrows a local for it, and a local borrowed while the
  // body was emitted was not declared yet. So the body's own bytes are taken
  // first and the declaration they are numbered against is written in front of
  // them afterwards.
  body.block(fn.entry, null);
  // The value a body that falls out of its own end leaves behind is written
  // before the body's bytes are taken, because `answer` appends to the buffer
  // the body is written into: an `answer` after they were read appends to a
  // buffer nothing reads again, and the `end` that closes the function is left
  // with an empty stack under a type section that declares a result.
  if (result !== undefined) body.answer();
  // The locals are declared in front of the body rather than after it, because
  // a statement that needs a value twice borrows a local for it, and a local
  // borrowed while the body was emitted was not declared yet. Both are written
  // into one buffer, which the code section then takes whole: the body's bytes
  // are never copied out and back in on the way to the module.
  const groups = body.localGroups();
  const code = new Bytes();
  code.counted(groups.length / 2, (locals) => groups.forEach((value) => locals.varuint(value)));
  code.absorb(body.bytes());
  code.byte(0x0b);

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
  // The constants the body pooled, one global each. The section sits between
  // the function section and the export section because the format numbers the
  // sections in order, and a global is read by the index the body handed it out
  // at, so the order they were laid down in is the order they are numbered in.
  //
  // A global is a value type, a mutability byte and a constant expression that
  // initialises it. The expression is the constant itself followed by `end`, and
  // the mutability is immutable because nothing here can write one.
  module.section(6, (globals) =>
    globals.counted(body.pooledFloats.length, (each) => {
      for (const pooled of body.pooledFloats) {
        // A global is its value type and its mutability, and nothing else: the
        // counted form is a table's element type, which is not what this is.
        each.byte(pooled.type);
        each.byte(0x00);
        each.byte(pooled.opcode);
        each.raw(pooled.bytes);
        each.byte(0x0b);
      }
    }),
  );
  module.section(7, (exports) =>
    exports.counted(1, (one) => {
      one.name(symbolOf(contract));
      one.byte(0x00);
      one.varuint(0);
    }),
  );
  module.section(10, (bodies) =>
    bodies.counted(1, (one) => {
      one.varuint(code.length);
      one.absorb(code);
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
  const detail = await inspect(request.modulePath, functionName, bytes);
  if (detail !== null) {
    throw new CompilerError({
      category: "TargetError",
      stage: "compile",
      message: `the WebAssembly module for ${functionName} violates the contract`,
      detail: detail.slice(0, 2000),
      function: functionName,
      candidate: request.candidate,
    });
  }
  await writeFile(request.modulePath, bytes);
  await writeFile(request.hostPath, generateWasmHost(request.contract), "utf8");
  return {
    runner: { command: process.execPath, args: [request.hostPath, request.modulePath] },
    modulePath: request.modulePath,
    hostPath: request.hostPath,
    moduleSizeBytes: (await stat(request.modulePath)).size,
  };
}

/**
 * Why a module reaches outside the memory the host provides, or null where it
 * keeps to the boundary.
 *
 * The bytes are asked here, on the ones the build just emitted, which is the
 * whole of what the child process was started to find out: spawning a Node to
 * compile a module this process can compile is a second interpreter per
 * candidate, and a build emits one module per candidate it tries. Where this
 * process has no WebAssembly of its own there is nothing to ask, and the child
 * reads the written module and answers there.
 */
async function inspect(path: string, expected: string, bytes: Uint8Array): Promise<string | null> {
  const problems = boundaryProblems(bytes, expected);
  if (problems === null) {
    await writeFile(path, bytes);
    const inspection = run(process.execPath, ["--input-type=module", "-e", INSPECT_MODULE, path, expected], { timeoutMs: 60_000 });
    if (inspection.code === 0) return null;
    return (inspection.stderr.trim() || inspection.stdout.trim()).slice(0, 2000);
  }
  if (problems.length === 0) return null;
  // The child reports an invalid module in one line where the checks above
  // answer with the list of what is wrong, so an invalid module keeps the
  // message it has always had.
  if (problems.length === 1 && problems[0] === "the module is not valid WebAssembly") {
    return `the module is not valid WebAssembly`;
  }
  return problems.join("\n");
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

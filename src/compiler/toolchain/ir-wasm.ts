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
import { boundaryProblems, bodyOf, DATA_BASE_EXPORT, generateWasmHost, generateWasmProgramHost, INSPECT_MODULE, moduleServices, readVaruint, wasmValueType } from "./wasm.ts";
import { HOST_SERVICE_BY_SYMBOL } from "./wasm-host-runtime.ts";
import type { Runner } from "../core/types.ts";
import { symbolOf } from "../semantics/contract.ts";
import { rulesFor } from "../semantics/language.ts";
import type { FunctionContract } from "../core/types.ts";
import { ARGV, ARGV_LENGTH, builtinFor } from "../semantics/builtins.ts";
import {
  isWide,
  isWideType,
  isTextType,
  isNumber,
  type SemanticBlock,
  type SemanticCall,
  type SemanticFunction,
  type SemanticLoop,
  type SemanticStatement,
  type SemanticTerminator,
  type CompareOp,
  type SemanticTextPart,
  type SemanticValue,
  elementTypeOf,
  slotType,
  type SemanticType,
  TEXT,
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
  /**
   * The other functions of the program, which the module holds beside this one.
   *
   * A module holds every function of the program and calls them by the index
   * each of them has in it, so a function that calls another function of the
   * program needs that function in its module: there is no linker to find it
   * beside. A build that compiles one function on its own has nothing to hold
   * beside it.
   */
  functions?: readonly SemanticFunction[];
  modulePath: string;
  hostPath: string;
  candidate?: string;
  /**
   * The language the program was written in, which says how a value is written
   * as text: one language writes a whole number with a marker the other has no
   * word for, and a truth as `true` where the other writes `True`.
   */
  language?: string;
  /**
   * Whether the folds the backend knows are safe are applied.
   *
   * A build folds. The flag is here so that the folded module and the
   * unfolded one can be compared, which is the only way to say that a fold
   * changed nothing but the size.
   */
  optimize?: boolean;
}

/**
 * A construct the module boundary cannot carry. A lowering that emitted one
 * would build a module the host cannot instantiate, so it is refused here,
 * where the build can say what is missing and which kind builds it instead.
 *
 * The name is the symbol of the function the construct was reached in, so the
 * refusal says which function it was and not only what it is.
 */
function unreachable(what: string, name: string, candidate?: string): never {
  throw new CompilerError({
    category: "TargetError",
    stage: "compile",
    message: `a WebAssembly module cannot ${what}, in ${name}`,
    detail:
      "the host ABI of a wasm module carries the runtime services the module imports, and this construct " +
      "needs one the ABI does not have. The c, asm and machine output kinds reach the whole runtime",
    function: name,
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
  /**
   * True when the carrier is the address of a value rather than the value.
   *
   * Every load and store below moves one element at a width, and neither knows
   * what it is looking at. A value whose carrier is a pointer is four times the
   * width it is loaded at, so anything that reads one of these as though the
   * carrier held the value would move a quarter of it — this is what says so.
   */
  wide?: boolean;
}

/** The limb operations of the three that do not carry, by the IR's name. */
const WIDE_BITWISE: Record<string, number> = { and: 0x83, or: 0x84, xor: 0x85 };

/**
 * The wide builtins, by the name the IR calls them under, and the service of
 * the host ABI that answers them.
 *
 * The kernel writes its answer into a block of its own and answers with the
 * address of it, which is how a wide number is carried.
 */
const WIDE_BUILTINS: Record<string, string> = {
  "u256_from_u64x2": "blaze_rt_u256_from_u64x2",
  "u256_from_u64x4": "blaze_rt_u256_from_u64x4",
  "u256_add_mod": "blaze_rt_u256_add_mod",
  "u256_sub_mod": "blaze_rt_u256_sub_mod",
  "u256_mul_mod": "blaze_rt_u256_mul_mod",
  "u256_div": "blaze_rt_u256_div",
};

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

/**
 * A dynamic value is the runtime's own representation, carried in a `f64` the
 * way the C backend carries it.
 *
 * A dynamic value is not a pointer into the memory: it is a handle the runtime
 * keeps, and the runtime's own ABI carries it as a `double`. A reference to an
 * object the program laid out is a pointer, and stays one.
 */
const DYNAMIC: TypeFacts = {
  held: F64,
  unsigned: false,
  size: 8,
  shift: 3,
  load: { code: 0x2b, align: 3 },
  store: { code: 0x39, align: 3 },
};

/**
 * A wide number is four 64 bit limbs laid out in memory, and WebAssembly has no
 * value type for one — so what the type is carried *as* is the address of
 * those four limbs, in the 32 bit address the memory is already indexed with.
 *
 * This is the same answer a buffer gets, and the reason is the same: the format
 * has one pointer-shaped value and this is what it points at. The difference is
 * that a wide number is not read from and written to by the host as a whole; the
 * four limbs are this backend's own, laid out once and never moved as a unit.
 *
 * Every operation on one is written out here as limb arithmetic rather than
 * lowered to anything: a module imports the host's linear memory and nothing
 * else, so there is no kernel to call, and an operation this file has not
 * written refuses rather than being carried out four limbs wide.
 */
const WIDE: TypeFacts = {
  held: I32,
  unsigned: false,
  size: 4,
  shift: 2,
  load: { code: 0x29, align: 3 },
  store: { code: 0x37, align: 3 },
  wide: true,
};

/**
 * Where the read-only constants begin, and why they do not begin at zero.
 *
 * The constants a body pools go into one data segment, and a data segment is
 * written by the host when the module is instantiated and is not a thing a
 * module may write to afterwards. The limbs of a wide number, on the other hand,
 * are scratch: every operation writes one somewhere and reads it back. So the
 * two cannot share an address range, and this is the boundary between them — a
 * page is 65536 bytes and the import asks the host for one, so everything below
 * this is addressable whatever the host allocated.
 *
 * The scratch needs no initialising because every byte of the host's memory
 * starts as zero, and a wide number that has not been written yet is zero.
 */
const WIDE_DATA_BASE = 4096;

/**
 * The most scratch a module may have for the whole numbers in flight.
 *
 * A page is the most the host's memory holds below the constants, and the
 * scratch is below the constants, so a module that needs more than this has
 * more values in flight at once than there is room for. The scratch of each
 * function is a region of its own within it, so a program of several functions
 * shares the limit between them.
 */
const SCRATCH_LIMIT = 65536;

/**
 * Two hundred and fifty six low bits set, which is a whole number wrapping
 * around at its own width.
 *
 * This is the mask rather than the power, because it is used as one: `&` is a
 * bitwise and, and a whole number masked with two to the two hundred and fifty
 * six is zero for every number the width can hold, because none of them has that
 * bit set. The number a literal wraps to is the low 256 bits of the literal.
 */
const WIDE_MASK = (1n << 256n) - 1n;

/** The four limbs of a whole number, lowest first. */
function byteViewOf(value: bigint): bigint[] {
  const limbs: bigint[] = [];
  let rest = value & WIDE_MASK;
  for (let limb = 0; limb < 4; limb += 1) {
    limbs.push(rest & 0xffffffffffffffffn);
    rest >>= 64n;
  }
  return limbs;
}

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
  if (type.kind === "primitive" && isWide(type.name)) return WIDE;
  // A dynamic value is the runtime's own handle rather than a pointer into the
  // memory, and the runtime carries it as a double.
  if (type.kind === "ref" && type.of === null && type.name === undefined) return DYNAMIC;
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
    shl: 0x74, shr: 0x75, ushr: 0x76, eq: 0x46, ne: 0x47, lt: 0x48, gt: 0x4a, le: 0x4c, ge: 0x4e,
  },
  [I64]: {
    add: 0x7c, sub: 0x7d, mul: 0x7e, div: 0x7f, mod: 0x81, and: 0x83, or: 0x84, xor: 0x85,
    shl: 0x86, shr: 0x87, ushr: 0x88, eq: 0x51, ne: 0x52, lt: 0x53, gt: 0x55, le: 0x57, ge: 0x59,
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
  [I32]: { div: 0x6e, mod: 0x70, shr: 0x76, ushr: 0x76, lt: 0x49, gt: 0x4b, le: 0x4d, ge: 0x4f },
  [I64]: { div: 0x80, mod: 0x82, shr: 0x88, ushr: 0x88, lt: 0x54, gt: 0x56, le: 0x58, ge: 0x5a },
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
  "Math.ceil": 0x9b,
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

/** The type a number is written in when the format reads it as a double. */
const F64_TYPE: SemanticType = { kind: "primitive", name: "f64" };

/** The type a whole number is widened to when it is handed to the runtime. */
const I64_TYPE: SemanticType = { kind: "primitive", name: "i64" };

/** The type a dynamic value is carried in, which is the runtime's own handle. */
const DYNAMIC_TYPE: SemanticType = { kind: "ref", of: null };

/** Whether a primitive type is a whole number rather than a floating one. */
function isWholeNumber(name: string): boolean {
  return name !== "f32" && name !== "f64";
}

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
  "&=": "and",
  "|=": "or",
  "^=": "xor",
  "<<=": "shl",
  ">>=": "shr",
  ">>>=": "ushr",
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
  if (op === "**=") {
    // There is no power instruction, and a compound power is not the low half
    // of a computation every backend runs: it is refused here, by name.
    throw new CompilerError({
      category: "AssemblyError",
      stage: "wasm",
      message: "this backend has not written a pow",
      detail: "WebAssembly has no instruction for a power, and no runtime to call one of: a program that raises is written C or run as machine code",
    });
  }
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
 * One function the module holds, and what a call of it has to know.
 *
 * The parameters are the types the module declares the function with and the
 * result is what it answers: a call converts its arguments to the parameter
 * types, and converts the answer back to the type the call was written at.
 */
interface HeldFunction {
  /** The IR of the function. */
  readonly fn: SemanticFunction;
  /** The name the module exports it by, which is the symbol the program calls it by. */
  readonly export: string;
  /** The types of the parameters, as the module declares them. */
  readonly params: readonly SemanticType[];
  /** What the function answers, or null where it answers nothing. */
  readonly result: SemanticType | null;
}

/**
 * What a module owns, as opposed to what one of its functions owns.
 *
 * The pooled constants, the data the module lays down and the services it
 * imports are the module's: two functions of one module read the same global
 * and the same text, and a service is imported once however many of the
 * functions reach for it. What a function owns is what is left — its own bytes,
 * its own locals, its own labels — and the scratch of the wide numbers in
 * flight, which is a region of its own, so that a function that computes one
 * and then calls a function that computes one as well does not write over the
 * first.
 */
class Module {
  /** Every float constant the module laid down, in the order the globals are numbered. */
  readonly floats: { type: number; opcode: number; bytes: number[] }[] = [];
  /** A float constant already laid down in a global, by the number and its precision. */
  private readonly pooled = new Map<string, number>();
  /**
   * The wide constants the module pooled, and the address of each one.
   *
   * The key is the number the constant holds, so a number the source wrote out
   * twice is laid down once.
   */
  readonly wideConstants = new Map<string, number>();
  /**
   * The constants the module lays down in its own data: the wide numbers and
   * the texts, in the order they were pooled.
   *
   * A text the program wrote out is laid down in the module's own data and
   * read at the address it was given, the same way a pooled float is read out
   * of a global rather than written out again at every place it appears.
   */
  readonly data: number[][] = [];
  /**
   * The services of the host ABI the module reached for, and the index of the
   * import each one is.
   */
  private readonly services = new Map<string, number>();
  /** The functions the module holds, in the order they are numbered in. */
  readonly held: HeldFunction[] = [];
  /**
   * The index the module's own functions start at, which is past every import.
   *
   * The format numbers the imported functions first, so a call of a function of
   * the module names the index the function has after them. The count of the
   * imports is not known until every function has been lowered — a service is
   * imported the first time a function reaches for it — so the module is
   * lowered twice: once to find out what it imports, and once to write the
   * calls at the indexes the imports leave.
   */
  base = 0;
  /** Where the module's own data begins: above the scratch of every function. */
  offset = WIDE_DATA_BASE;

  /** The services the module reached for, in the order it reached for them. */
  serviceList(): string[] {
    return [...this.services.keys()];
  }

  /**
   * The index of the import a service is, handed out the first time the module
   * reaches for it: the import section writes the services in that order and a
   * call names the index of the import it calls. The power is the first import
   * of every module, so the services start at one.
   */
  service(symbol: string): number {
    const known = this.services.get(symbol);
    if (known !== undefined) return known;
    const index = this.services.size + 1;
    this.services.set(symbol, index);
    return index;
  }

  /**
   * The global a float constant is read out of, laid down the first time the
   * module reaches for it.
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
  float(value: number, wide: boolean): number {
    const key = `${wide ? "f64" : "f32"}:${value}`;
    const known = this.pooled.get(key);
    if (known !== undefined) return known;
    if (wide) FLOAT_BYTES.setFloat64(0, value, true);
    else FLOAT_BYTES.setFloat32(0, value, true);
    const size = wide ? 8 : 4;
    const bytes: number[] = [];
    for (let at = 0; at < size; at += 1) bytes.push(FLOAT_BYTES.getUint8(at));
    this.pooled.set(key, this.floats.length);
    this.floats.push({ type: wide ? F64 : F32, opcode: wide ? 0x44 : 0x43, bytes });
    return this.floats.length - 1;
  }

  /** The address of a wide constant, laid down the first time it is reached for. */
  wide(value: bigint): number {
    const key = `u256:${value & WIDE_MASK}`;
    const known = this.wideConstants.get(key);
    if (known !== undefined) return known;
    const bytes: number[] = [];
    for (const limb of byteViewOf(value)) {
      for (let at = 0; at < 8; at += 1) bytes.push(Number((limb >> BigInt(at * 8)) & 0xffn));
    }
    const at = this.dataBytes(bytes);
    this.wideConstants.set(key, at);
    return at;
  }

  /** The address of a text, laid down in the module's own data. */
  text(value: string): number {
    // The bytes of a text are laid down with a zero at the end of them, which
    // is what a text the runtime reads as a C string is.
    return this.dataBytes([...new TextEncoder().encode(value), 0]);
  }

  /**
   * The address of a block of bytes in the module's own data, which is where
   * the constant goes and the next one after it.
   */
  dataBytes(bytes: number[]): number {
    const at = this.offset + this.data.reduce((whole, each) => whole + each.length, 0);
    this.data.push(bytes);
    return at;
  }

  /** The function a symbol names, or null where the module holds no such function. */
  function(symbol: string): HeldFunction | null {
    for (const held of this.held) {
      if (held.export === symbol) return held;
    }
    return null;
  }

  /** The index of the function a symbol names, or -1 where the module holds no such function. */
  functionIndex(symbol: string): number {
    for (let index = 0; index < this.held.length; index += 1) {
      if ((this.held[index] as HeldFunction).export === symbol) return this.base + index;
    }
    return -1;
  }
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
  /** The symbol of the function the body is, which a refusal names. */
  private readonly name: string;
  private readonly returns: SemanticType;
  private readonly candidate: string | undefined;
  /**
   * The style a value is written as text in, which is the language's own: one
   * language writes a whole number with a marker the other has no word for, and
   * a truth as `true` where the other writes `True`.
   */
  private readonly style: number;
  /** How many labels the body has opened that the IR does not name. */
  private anonymous = 0;
  /** The local the instruction at the end of the body read, or -1 for another. */
  private readLocal = -1;
  /** Where in the body that read began. */
  private readAt = -1;
  /** The module the body is one function of. */
  private readonly module: Module;
  /**
   * Where the scratch of the wide numbers in flight begins.
   *
   * The scratch is a region of the function's own: a function that computes a
   * wide number and then calls a function that computes one as well would find
   * the second one written over the first if the two shared a region.
   */
  private readonly scratchBase: number;
  /** How far through that region the arithmetic has come. */
  private scratchTaken = 0;
  /**
   * Whether the folds the backend knows are safe are applied.
   *
   * A build folds: the module it writes is the folded one. The flag is here
   * so that the folded module and the unfolded one can be compared, which is
   * the only way to say that a fold changed nothing but the size.
   */
  private readonly optimize: boolean;

  constructor(
    module: Module,
    fn: SemanticFunction,
    name: string,
    returns: SemanticType,
    candidate: string | undefined,
    style = 0,
    optimize = true,
    scratch = 0,
  ) {
    this.module = module;
    this.fn = fn;
    this.name = name;
    this.returns = returns;
    this.candidate = candidate;
    this.style = style;
    this.optimize = optimize;
    this.scratchBase = scratch;
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

  /**
   * Copies what is on the top of the stack into a borrowed local and leaves it
   * there, which the format calls `local.tee`.
   *
   * A limb walk needs this at every step: each step reads a value it computed
   * one instruction earlier, and there is no way to copy what is on the stack
   * except to put it in a local. Storing and loading it back would be the same
   * two instructions plus a store.
   */
  private tee(at: number): void {
    this.op(0x22);
    this.code.varuint(at);
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
   * A call of a service of the host ABI.
   *
   * The service is imported the first time the body reaches for it and the
   * import is named by its index, so the index is handed out by the module and
   * the import section writes the services in the order the body reached for
   * them.
   */
  private callService(symbol: string): void {
    this.op(0x10);
    this.code.varuint(this.module.service(symbol));
  }

  /**
   * A call of another function of the program.
   *
   * A module holds every function of the program and calls them by the index
   * each of them has in it: there is no linker and no symbol table, so the
   * index is a lookup in the table the module holds. The arguments are the
   * callee's own types — the IR of the call carries the signature of the
   * callee, and the callee's own body declares what it takes — and the answer
   * comes back in the callee's own type and is converted to the type the call
   * was written at.
   *
   * @param at the type the answer is wanted in, or null where the call is
   * written for its effect and nothing reads the answer.
   */
  private programCall(call: SemanticCall, callee: HeldFunction, at: SemanticType | null): void {
    for (const [position, argument] of call.args.entries()) {
      const given = call.argTypes[position] ?? argument.type;
      this.value(argument, given);
      const wanted = callee.params[position];
      // The signature the call was written against and the body the module
      // holds are the same function, so the types agree; where they do not,
      // the argument is converted into the one the callee takes.
      if (wanted !== undefined) this.convert(given, wanted);
    }
    this.op(0x10);
    this.code.varuint(this.module.functionIndex(call.callee));
    if (at === null) return;
    if (callee.result === null) {
      unreachable(`call ${call.callee} for its value`, this.name, this.candidate);
    }
    this.convert(callee.result, at);
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

  /** Reads the local at an index, which the format calls `local.get`. */
  private localAt(at: number): void {
    this.op(0x20);
    this.code.varuint(at);
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
    const index = this.module.float(value, wide);
    this.op(0x23);
    this.code.varuint(index);
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
      message: `the body of ${this.name} reads "${name}", which it declares nowhere`,
    });
  }

  private get(name: string): Local {
    const local = this.resolve(name);
    this.op(0x20);
    // Where the read begins, which is the `local.get` opcode itself: the
    // opcode byte and the index after it are one instruction, and the index is
    // not written yet, so the position is the one byte just written. It is
    // taken after the opcode, because `op` clears the mark it keeps — reading
    // it first leaves a position of no instruction at all, and a statement that
    // reads a name into itself then truncates the body behind it.
    this.readAt = this.code.length - 1;
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
      unreachable("convert between carriers", this.name, this.candidate);
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
   *
   * A wide number is not folded at all: it is held as an address rather than as
   * a carrier, so `| 0` reads the low thirty-two bits of a number whose whole
   * value may be above every one of them, and the arm the source does not take
   * is the one a module would be left holding. The test is asked of it at run
   * time like any other value's.
   */
  private known(value: SemanticValue): boolean | null {
    if (value.k === "bool") return value.value;
    if (value.k !== "const") return null;
    if (value.type.kind === "primitive" && isWide(value.type.name)) return null;
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

  /**
   * A whole number widened into a wide number, which the kernel beside the
   * runtime does.
   *
   * The kernel writes the answer into a block of its own and answers with the
   * address of it, which is how a wide number is carried: four limbs in the
   * memory, and the address of them.
   */
  private widen(value: SemanticValue): void {
    if (value.type.kind !== "primitive" || !isWholeNumber(value.type.name)) {
      unreachable("widen something that is not a whole number into a wide number", this.name, this.candidate);
    }
    const out = this.wideScratch();
    // The kernel writes its answer into a block of its own and is given the
    // address of it first, the way every kernel call is.
    this.i32(out);
    // The kernel takes one machine word, so the number is widened to that
    // width first: a 32 bit whole number is read as a 64 bit one.
    this.value(value, I64_TYPE);
    this.callService("blaze_rt_u256_from_u64");
    this.i32(out);
  }

  /** One value, as the operations that produce it. */
  private value(value: SemanticValue, at: SemanticType): void {
    // A whole number read as a wide number is widened by the kernel that
    // builds a wide number out of one word, and the answer is the same number:
    // the low limb holds the word it was written as and the three above it are
    // nothing. A wide number is four limbs in the memory and the address of
    // them, so a number cannot be converted into one where it stands — the
    // kernel is what does it.
    if (isWideType(at) && !isWideType(value.type)) {
      this.widen(value);
      return;
    }
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
        // length of a text and the length of a dynamic array are the
        // runtime's to answer.
        const held = value.of.type;
        if (isTextType(held)) {
          this.value(value.of, TEXT);
          this.callService("blaze_rt_text_length");
          this.convert(value.type, at);
          return;
        }
        if (held.kind === "ref" && held.of === null && held.name === undefined) {
          this.value(value.of, DYNAMIC_TYPE);
          this.callService("blaze_rt_array_length");
          this.convert(value.type, at);
          return;
        }
        if (held.kind !== "slice" && held.kind !== "array" && held.kind !== "ptr") {
          unreachable("take the length of a value that is not a buffer", this.name, this.candidate);
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
        const of = value.of.type;
        if (of.kind === "ref" && of.of === null && of.name === undefined) {
          // An element of a dynamic array is the runtime's to answer. The
          // index is a count and the runtime carries a count as a double, so
          // it is written as one: a count written as a whole number is a
          // module the engine refuses, because the service takes a double.
          this.value(value.of, DYNAMIC_TYPE);
          this.value(value.index, F64_TYPE);
          this.callService("blaze_rt_array_get");
          this.convert(value.type, at);
          return;
        }
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
          unreachable(`read the field "${value.field}" of the layout "${value.layout}"`, this.name, this.candidate);
        }
        this.value(value.object, ADDRESS);
        const load = facts(value.type).load;
        this.op(load.code);
        this.code.varuint(load.align);
        this.code.varuint(field.offset);
        this.convert(value.type, at);
        return;
      }
      case "buffer": {
        // A typed array is a block the runtime lays out, and the count of its
        // elements is the word the offset sits one before: a module reads the
        // length of a buffer from there.
        if (value.view !== null) {
          unreachable("take a view of a block of bytes", this.name, this.candidate);
        }
        const element = value.element;
        const size = facts(element).size;
        if (value.count !== null) {
          this.value(value.count, ADDRESS);
          this.op(0xad); // `i64.extend_i32_u`
          this.i64(BigInt(size));
          this.callService("blaze_rt_array_new");
          return;
        }
        // The elements written out are laid down one at a time, at the address
        // the index names.
        const total = value.values.length;
        this.i64(BigInt(total));
        this.i64(BigInt(size));
        this.callService("blaze_rt_array_new");
        const pointer = this.borrow(I32);
        this.keep(pointer);
        for (let index = 0; index < total; index += 1) {
          this.localAt(pointer);
          this.i32(index);
          const shift = facts(element).shift;
          if (shift > 0) {
            this.i32(shift);
            this.op(0x74); // `i32.shl`
          }
          this.op(BINARY[I32].add as number);
          this.value(value.values[index] as SemanticValue, element);
          const store = facts(element).store;
          this.op(store.code);
          this.code.varuint(store.align);
          this.code.varuint(0);
        }
        this.localAt(pointer);
        this.release(I32, pointer);
        return;
      }
      case "newObject": {
        const layout = this.fn.objects[value.layout];
        if (layout === undefined) {
          unreachable(`build an object of the layout "${value.layout}"`, this.name, this.candidate);
        }
        // The object is a block the runtime lays out, and its fields are
        // written at the offsets the layout gives them.
        this.i64(BigInt(layout.size));
        this.i64(BigInt(layout.align));
        this.callService("blaze_rt_object_new");
        const pointer = this.borrow(I32);
        this.keep(pointer);
        for (const field of value.fields) {
          const entry = layout.fields.find((each) => each.name === field.name);
          if (entry === undefined) {
            unreachable(`write the field "${field.name}" of the layout "${value.layout}"`, this.name, this.candidate);
          }
          this.localAt(pointer);
          this.value(field.value, field.value.type);
          const store = facts(field.value.type).store;
          this.op(store.code);
          this.code.varuint(store.align);
          this.code.varuint(entry.offset);
        }
        this.localAt(pointer);
        this.release(I32, pointer);
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
        // Two whole numbers are not chosen between by choosing between their
        // addresses — the two addresses are two different places and the answer
        // is whichever place holds it — so the limbs are chosen and written.
        if (at.kind === "primitive" && isWide(at.name)) {
          this.wideSelect(value.condition, value.then, value.otherwise);
          return;
        }
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
        // A number beside a text is the test, and the text is the value the
        // operator hands back, so a number that answers is written as the text
        // of that number. The truth is asked of the number itself, which is
        // what the language asks of it: a number that is not a number holds
        // nothing.
        if (isTextType(at) && isNumber(value.left.type)) {
          const held = facts(at).held;
          const answer = this.borrow(held);
          this.asText(value.left, null);
          this.keep(answer);
          this.value(value.left, value.left.type);
          const carrier = facts(value.left.type).held;
          if (value.op === "or") this.lie(carrier);
          else this.truth(carrier);
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
        // A wide number is carried as the address of its four limbs, and every
        // operation on one has to be written out as limb arithmetic below —
        // there is no instruction for thirty-two bytes and, because a module
        // reaches no runtime service, nothing to call either. What is written is
        // routed to it and everything else stops here rather than reaching the
        // table below, where a four-limb value would be carried out as one
        // `i32` and answer the low thirty-two bits of the number it was given.
        if (compared.kind === "primitive" && isWide(compared.name)) {
          if (value.k === "compare") {
            this.wideCompare(value.op, value.left, value.right);
            return;
          }
          this.wideBinary(value.op, value.left, value.right);
          return;
        }
        // Two texts are compared by what they say and not by where they are: a
        // text built at run time and one written out are two addresses that
        // can say the same thing, and the addresses compared as if the texts
        // did. The runtime owns the texts, so the comparison is the runtime's
        // own, and the answer is a number below zero, zero or a number above
        // zero: the comparison the source wrote is one of the six ways of
        // asking about that.
        if (value.k === "compare" && isTextType(compared)) {
          this.value(value.left, TEXT);
          this.value(value.right, TEXT);
          this.callService("blaze_rt_text_compare");
          this.i32(0);
          this.op(BINARY[I32][value.op] as number);
          this.convert({ kind: "primitive", name: "i32" }, at);
          return;
        }
        // A compound assignment and an arith of `pow` both have no
        // instruction and no runtime here. Refuse it by name rather than emit
        // a byte that does not decode, or nothing at all.
        if (value.k === "arith" && value.op === "pow") {
          // `pow` is the one arithmetic operation with no instruction of its
          // own; the host provides it through the `env.pow` import.
        }
        // Two texts are joined by the runtime, which owns the result: the join
        // is a service of the host ABI rather than an instruction.
        if (value.op === "concat") {
          this.value(value.left, TEXT);
          this.value(value.right, TEXT);
          this.callService("blaze_rt_string_append");
          this.convert(TEXT, at);
          return;
        }
        if (value.op === "arrayConcat") {
          unreachable("arrayConcat is not written by the wasm backend", "arrayConcat");
          return;
        }
        const held = facts(compared).held;
        this.value(value.left, compared);
        this.value(value.right, compared);
        // A whole number the module holds as unsigned is divided, ordered and
        // shifted as unsigned, because the instruction is named for how the
        // bits read and not for how the value was declared.
        if (value.op === "pow") {
          this.op(0x10);
          this.code.varuint(0);
          this.convert(value.type, at);
          return;
        }
        const unsignedOp = facts(compared).unsigned ? UNSIGNED_BINARY[held][value.op] : undefined;
        const op = unsignedOp ?? BINARY[held][value.op];
        if (op === undefined) {
          if (value.op === "floorDiv" || value.op === "floorMod") {
            // A floor division and a floored remainder are the operations of a
            // language whose division rounds towards zero and whose remainder
            // takes the sign of its left side, and this backend has not written
            // them: the division it has is the truncating one.
            unreachable(
              `compute ${value.op}: this backend has not written a floor division or a floored remainder`,
              this.name,
              this.candidate,
            );
          }
          unreachable(`compute ${value.op}`, this.name, this.candidate);
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
        // The only call a module can lower is a maths builtin, which is an
        // instruction over the argument rather than a call, or a call of another
        // function of the program, which is a call of the index that function
        // has in the module. Every argument goes down first, in the order the
        // call passes them, and the instruction takes the last one off the top.
        if (builtinFor(value.call.callee) === null && this.module.function(value.call.callee) === null) {
          unreachable(`call ${value.call.callee}`, this.name, this.candidate);
        }
        // The wide arithmetic is the kernel beside the runtime, and a module
        // calls it the same way the other two backends do.
        const kernel = WIDE_BUILTINS[value.call.callee];
        if (kernel !== undefined) {
          this.wideKernel(kernel, value.call);
          return;
        }
        // The dynamic values and the dynamic arrays are the runtime's own
        // representation, and the runtime is the host: these calls are calls
        // of the services of the host ABI.
        const answered = this.dynamicCall(value.call);
        if (answered !== null) {
          this.convert(answered, at);
          return;
        }
        // A call of another function of the program is a call of the index that
        // function has in this module: there is no linker and no symbol table,
        // so the index is a lookup in the table the module holds.
        const callee = this.module.function(value.call.callee);
        if (callee !== null) {
          this.programCall(value.call, callee, at);
          return;
        }
        for (const [position, argument] of value.call.args.entries()) {
          this.value(argument, value.call.argTypes[position] ?? argument.type);
        }
        this.builtin(value.call.callee);
        this.convert(value.type, at);
        return;
      }
      case "argv": {
        // `process.argv.length` and `process.argv(n)` are the same read of the
        // command line, and the host the module runs under is a process of its
        // own: the arguments it reads are the ones the host was given.
        if (value.index === null) {
          this.callService("blaze_rt_argv_count");
          this.convert({ kind: "primitive", name: "usize" }, at);
          return;
        }
        this.value(value.index, { kind: "primitive", name: "usize" });
        this.callService("blaze_rt_argv");
        this.convert(F64_TYPE, at);
        return;
      }
      case "text":
        this.text(value);
        this.convert(TEXT, at);
        return;
      case "toText":
        this.asText(value.of, value.digits);
        this.convert(TEXT, at);
        return;
      default:
        unreachable(`hold a value the IR keeps as "${value.k}"`, this.name, this.candidate);
    }
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
    // A wide constant is not a literal: there is no instruction that carries
    // thirty-two bytes. It is laid down once in the module's own data and every
    // use is its address, the same way a pooled float is read out of a global
    // rather than written out again at every place it appears.
    if (type.kind === "primitive" && isWide(type.name)) {
      this.wideConstant(BigInt(text));
      return;
    }
    // A text constant is the text itself and not a number: it is laid down in
    // the module's own data and every use is its address.
    if (isTextType(type)) {
      this.i32(this.poolText(text));
      return;
    }
    const held = facts(type).held;
    const wanted = facts(at).held;
    // The number the literal's own carrier holds is what a conversion would
    // have been applied to, so it is the number whose exactness at the
    // destination decides whether that carrier can hold it as it stands.
    const value = this.valueOf(text, held);
    this.literal(text, held !== wanted && !this.exact(value, wanted) ? held : wanted);
  }

  /**
   * Lays a wide constant down once and leaves its address on the stack.
   *
   * The limbs are written lowest first, which is the order the arithmetic reads
   * them back in and the order the machine backend writes them in, so the two
   * backends lay the same thirty-two bytes out the same way for the same
   * number. The value is read as a whole number, so a literal with a sign is its
   * two's complement over 256 bits rather than a negative number of limbs.
   */
  private wideConstant(value: bigint): void {
    this.i32(this.module.wide(value));
  }

  /**
   * One comparison of two whole numbers, as a limb walk from the top.
   *
   * The limbs are the same whatever the order asked for, so only two are
   * written: whether the two limbs are equal, and whether the left is the
   * smaller. Everything else is those two and not — `le` is `lt` or `eq`,
   * `gt` is `lt` the other way round, and `ne` is not `eq`.
   *
   * The walk starts at the top limb because that is the one that decides: a
   * number whose top limbs match is ordered by the first pair below them that
   * does not, and a pair of equal limbs passes the question down. Stopping at
   * the first difference and keeping that answer is what makes the walk `O(1)`
   * on the values that differ high and `O(4)` on the rest, and the answer is the
   * same either way.
   */
  private wideCompare(op: CompareOp, left: SemanticValue, right: SemanticValue): void {
    if (op === "lt") {
      this.wideOrder(left, right, false);
      return;
    }
    if (op === "gt") {
      this.wideOrder(right, left, false);
      return;
    }
    if (op === "le") {
      this.wideOrder(left, right, true);
      return;
    }
    if (op === "ge") {
      this.wideOrder(right, left, true);
      return;
    }
    if (op !== "eq" && op !== "ne") this.wideRefuse(`compare ${op}`);
    const leftAt = this.borrow(I32);
    this.value(left, left.type);
    this.keep(leftAt);
    const rightAt = this.borrow(I32);
    this.value(right, right.type);
    this.keep(rightAt);
    const leftLimb = this.borrow(I64);
    const rightLimb = this.borrow(I64);
    // A comparison answers a zero or a one and not a limb, so the answer is
    // kept as the `i32` it is rather than in one of the limbs it compared.
    const answer = this.borrow(I32);
    for (let limb = 0; limb < 4; limb += 1) {
      this.loadLimb(leftAt, limb, leftLimb);
      this.loadLimb(rightAt, limb, rightLimb);
      this.localAt(leftLimb);
      this.localAt(rightLimb);
      this.op(0x51); // `i64.eq`
      // Every limb has to match, so each one is anded into the answer so far.
      if (limb === 0) this.keep(answer);
      else {
        this.localAt(answer);
        this.op(0x71); // `i32.and`
        this.keep(answer);
      }
    }
    this.localAt(answer);
    // `ne` is `eq` answered the other way round, which is asking whether the
    // answer is nothing: `eq` leaves a one for a match and the two are never
    // both true at once.
    if (op === "ne") this.op(0x45); // `i32.eqz`
    for (const at of [leftLimb, rightLimb]) this.release(I64, at);
    for (const at of [leftAt, rightAt, answer]) this.release(I32, at);
  }

  /**
   * Whether the first whole number is below the second, or below it or equal.
   *
   * Each limb from the top down answers one question — are these two limbs
   * equal, and if not, which is smaller — and the answer to the whole is the
   * first one that is not "equal", because a limb that matches says nothing
   * about the limbs below it. That is what the two selections do: the later
   * limbs only speak when every limb above them matched.
   */
  private wideOrder(left: SemanticValue, right: SemanticValue, orEqual: boolean): void {
    const leftAt = this.borrow(I32);
    this.value(left, left.type);
    this.keep(leftAt);
    const rightAt = this.borrow(I32);
    this.value(right, right.type);
    this.keep(rightAt);
    const leftLimb = this.borrow(I64);
    const rightLimb = this.borrow(I64);
    const answer = this.borrow(I32);
    // Whether this pair of limbs matches, and what the pair decides on its own.
    // Both are kept because a `select` reads its condition last and its first
    // value below that, so the three have to be in locals to be in that order.
    const matches = this.borrow(I32);
    const decided = this.borrow(I32);
    // What the walk has settled on so far, which for the top limbs is "no pair
    // has differed yet" — and that is already the answer when they never do.
    // Two equal numbers are below each other only when equal is allowed.
    this.i32(orEqual ? 1 : 0);
    this.keep(answer);
    for (let limb = 3; limb >= 0; limb -= 1) {
      this.loadLimb(leftAt, limb, leftLimb);
      this.loadLimb(rightAt, limb, rightLimb);
      // `equal ? answer : (smaller ? one : zero)`
      this.localAt(leftLimb);
      this.localAt(rightLimb);
      this.op(0x51); // `i64.eq`
      this.keep(matches);
      if (orEqual) {
        this.localAt(leftLimb);
        this.localAt(rightLimb);
        this.op(0x54); // `i64.lt_u`
        this.keep(decided);
      } else {
        // `<` is not `le`: a pair of equal limbs decides nothing, so the answer
        // for this pair is the comparison itself and a zero for a match. A
        // `select` reads its condition last and its first value below that, so
        // the one has to be pushed before the zero.
        this.i32(1);
        this.i32(0);
        this.localAt(leftLimb);
        this.localAt(rightLimb);
        this.op(0x54); // `i64.lt_u`
        this.op(0x1b); // `select`
        this.keep(decided);
      }
      // `matches ? answer : decided` — the limbs below only speak when every
      // limb above them matched.
      this.localAt(answer);
      this.localAt(decided);
      this.localAt(matches);
      this.op(0x1b); // `select`
      this.keep(answer);
    }
    this.localAt(answer);
    for (const at of [leftLimb, rightLimb]) this.release(I64, at);
    for (const at of [leftAt, rightAt, answer, matches, decided]) this.release(I32, at);
  }

  /**
   * One whole number chosen between two, copied limb by limb.
   *
   * The module has an instruction that chooses between two values, and what it
   * chooses between here is the two addresses rather than the two numbers — and
   * two addresses are two different places, of which one holds the answer. So
   * the limbs are chosen and written, which is the selection the operator means.
   */
  private wideSelect(condition: SemanticValue, then: SemanticValue, otherwise: SemanticValue): void {
    const thenAt = this.borrow(I32);
    this.value(then, then.type);
    this.keep(thenAt);
    const otherAt = this.borrow(I32);
    this.value(otherwise, otherwise.type);
    this.keep(otherAt);
    const out = this.wideScratch();
    for (let limb = 0; limb < 4; limb += 1) {
      // The address of the limb is below both arms, because a store reads its
      // address before its value and the value is what the selection answers —
      // and it is pushed once per limb, because the store consumes it.
      this.atScratch(out);
      this.loadLimb(thenAt, limb);
      this.loadLimb(otherAt, limb);
      this.condition(condition);
      this.op(0x1b); // `select`
      this.storeLimb(limb);
    }
    for (const at of [thenAt, otherAt]) this.release(I32, at);
    this.i32(out);
  }

  /**
   * One whole number moved by a number of bits, a limb at a time.
   *
   * A count of bits splits into a whole number of limbs and the bits left over,
   * and a limb of the answer is a limb of the number moved and the limb below it
   * moved the other way. Both need a limb that is not there — the one below the
   * bottom limb, and the one the count pushes past the top — so the number is
   * first copied into a padded run with zeros on both sides, and every limb the
   * walk wants can then be read without asking whether it exists.
   */
  private wideShift(op: "shl" | "shr", value: SemanticValue, count: SemanticValue): void {
    const valueAt = this.borrow(I32);
    this.value(value, value.type);
    this.keep(valueAt);
    const countAt = this.borrow(I32);
    // The count is a machine number and the machine moves a number by less than
    // two hundred and fifty six bits, so it is read at the width of the register
    // it is counted in rather than the width its own type carries it.
    this.value(count, { kind: "primitive", name: "u32" });
    this.keep(countAt);
    const bits = this.borrow(I32);
    const offset = this.borrow(I32);
    const address = this.borrow(I32);
    const limbValue = this.borrow(I64);
    // A count of two hundred and fifty six bits or more moves every limb of the
    // number off the end, and the answer is a whole number of zero limbs. The
    // walk cannot reach that answer on its own: the padded run holds a limb and
    // a half on each side of the copy, which covers every count below the width
    // and none above it, so the count the walk is given is held below the width
    // — which keeps every address inside the run whatever the count was — and
    // what the walk made of it is masked away.
    const bounded = this.borrow(I32);
    this.localAt(countAt);
    this.i32(255);
    this.localAt(countAt);
    this.i32(256);
    this.op(0x49); // `i32.lt_u`
    this.op(0x1b); // `select`
    this.keep(bounded);
    const mask = this.borrow(I64);
    this.i64(-1n);
    this.i64(0n);
    this.localAt(countAt);
    this.i32(256);
    this.op(0x49); // `i32.lt_u`
    this.op(0x1b); // `select`
    this.keep(mask);
    // Ninety-six bytes: a limb of zero on each side of the four that are copied
    // in, so a count that moves the walk off either end still reads a limb
    // rather than a neighbour of the copy.
    const padded = this.wideScratchOf(96);
    for (let cleared = 0; cleared < 96; cleared += 4) {
      this.i32(padded + cleared);
      this.i32(0);
      this.op(0x36); // `i32.store`
      this.code.varuint(2);
      this.code.varuint(0);
    }
    // The four limbs are laid out with a limb of zero on each side, so a count
    // that pushes the walk off either end still reads a limb rather than a
    // neighbour of the copy.
    for (let limb = 0; limb < 4; limb += 1) {
      this.i32(padded + 32 + limb * 8);
      this.loadLimb(valueAt, limb);
      this.op(0x37); // `i64.store`
      this.code.varuint(3);
      this.code.varuint(0);
    }
    // The count is a whole number of limbs and the bits left over, and the limb
    // count is turned into a byte offset here because every address below is one
    // a store takes. A number going left takes its bits from the limb below it,
    // so the limb it reads is `k` below the one being written, and the index
    // only counts up, so `k` is negated here rather than at every use.
    if (op === "shl") this.i32(0);
    this.localAt(bounded);
    this.i32(6);
    this.op(0x76); // `i32.shr_u`
    this.i32(3);
    this.op(0x74); // `i32.shl`
    // `i32.sub` takes the top of the stack away from the one below it, so the
    // zero that makes this a negation is written before the count rather than
    // after it.
    if (op === "shl") this.op(0x6b); // `i32.sub`
    this.keep(offset);
    this.localAt(bounded);
    this.i32(63);
    this.op(0x71); // `i32.and`
    this.keep(bits);
    const out = this.wideScratch();
    for (let limb = 0; limb < 4; limb += 1) {
      this.i32(out + limb * 8);
      this.localAt(offset);
      this.i32(limb * 8);
      this.op(0x6a); // `i32.add`
      this.i32(32 + padded);
      this.op(0x6a);
      this.keep(address);
      this.localAt(address);
      this.op(0x29); // `i64.load`
      this.code.varuint(3);
      this.code.varuint(0);
      this.keep(limbValue);
      this.localAt(limbValue);
      this.localAt(bits);
      this.op(0xad); // `i64.extend_i32_u`
      this.op(op === "shl" ? 0x86 : 0x88); // `i64.shl` or `i64.shr_u`
      this.keep(limbValue);
      // The neighbouring limb gives up the bits this one is short of. It is the
      // one below for a shift left and the one above for a shift right.
      this.localAt(address);
      this.i32(op === "shl" ? -8 : 8);
      this.op(0x6a); // `i32.add`
      this.op(0x29); // `i64.load`
      this.code.varuint(3);
      this.code.varuint(0);
      // A shift left takes the top of the limb below into the bottom of this one,
      // and a shift right takes the bottom of the limb above into the top of this
      // one, so the neighbouring limb moves one the other way before it is moved
      // the rest of the way.
      this.i64(1n);
      this.op(op === "shl" ? 0x88 : 0x86);
      // Sixty-three and then the bits left over: the shift above moved the
      // neighbouring limb by one bit and this moves it the rest of the way, so
      // the two together move exactly the sixty-four that fill this limb.
      this.i32(63);
      this.localAt(bits);
      this.op(0x6b); // `i32.sub`
      this.op(0xad); // `i64.extend_i32_u`
      this.op(op === "shl" ? 0x88 : 0x86);
      // A count of no bits at all leaves nothing for the neighbouring limb to
      // give up, and the two shifts that fold it in would together move sixty-four
      // bits, which a machine shift reads as none at all. So the fold is chosen
      // away when there are no bits left over.
      this.i64(0n);
      this.localAt(bits);
      this.i32(0);
      this.op(0x47); // `i32.ne`
      this.op(0x1b); // `select`
      this.localAt(limbValue);
      this.op(0x84); // `i64.or`
      this.localAt(mask);
      this.op(0x83); // `i64.and`
      this.op(0x37); // `i64.store`
      this.code.varuint(3);
      this.code.varuint(0);
    }
    for (const at of [valueAt, countAt, bounded]) this.release(I32, at);
    this.release(I64, mask);
    this.i32(out);
  }

  /**
   * Thirty-two bytes of scratch, somewhere below every constant.
   *
   * The two cannot share an address range — a data segment is written by the
   * host and a value in flight is written by the module — so the scratch is
   * taken from below and the constants from above. Every byte of it starts as
   * zero, which is a whole number that has not been written yet.
   *
   * A function whose arithmetic nests more deeply than this has more values in
   * flight at once than there is room for, and that is said rather than
   * overwriting one with another.
   */
  private wideScratch(): number {
    return this.wideScratchOf(32);
  }

  /** The same, for a region that is not one whole number wide. */
  private wideScratchOf(bytes: number): number {
    const at = this.scratchBase + this.scratchTaken;
    this.scratchTaken += bytes;
    if (this.scratchTaken > SCRATCH_LIMIT) {
      throw new CompilerError({
        category: "AssemblyError",
        stage: "wasm",
        message: "this function keeps more wide numbers in flight than the module has scratch for",
        detail: `every value an operation is computing on is thirty-two bytes and they live in a region of their own below the module's constants, of which there are ${(SCRATCH_LIMIT / 32) | 0}; split the expression`,
      });
    }
    return at;
  }

  /**
  /**
   * A call of the wide kernel, which writes its answer into a block of its
   * own.
   *
   * The block is the scratch the module keeps for the values in flight, and the
   * answer is that block's address: a wide number is four limbs in the memory,
   * and the module holds it as the address of them.
   */
  private wideKernel(symbol: string, call: SemanticCall): void {
    const out = this.wideScratch();
    this.i32(out);
    for (const [position, argument] of call.args.entries()) {
      this.value(argument, call.argTypes[position] ?? argument.type);
    }
    this.callService(symbol);
    this.i32(out);
  }

  /**
   * One wide operation, written out as arithmetic on the four limbs.
   *
   * There is no instruction for a two hundred and fifty six bit add and there
   * is nothing to call — a module reaches no runtime service, so the kernel the
   * C backend calls is not here. It is a limb walk: load each limb of both
   * sides, combine them, and carry or borrow into the next.
   *
   * The carry is found by comparison rather than by sign, because these are
   * whole numbers and `i64.lt_s` would read the top bit as a sign. Three inputs
   * go into each limb, so it takes two comparisons: `a + b` may carry on its
   * own, and adding the carry from below may carry again. Testing only the first
   * is right for the top limb of a value that never carries and wrong for the
   * rest of one that does.
   */
  private wideBinary(op: string, left: SemanticValue, right: SemanticValue): void {
    // A shift's right operand is the number of bits to move rather than another
    // whole number, so a shift is written out by its own walk and not by the
    // limb-by-limb combine below, which reads both of its operands as
    // addresses of limbs.
    if (op === "shl" || op === "shr") {
      this.wideShift(op, left, right);
      return;
    }
    // A multiply, a division and a remainder are the operations the format has
    // no instruction for and the kernel beside the runtime is there for: the
    // module calls it, the same way the C and the machine backends do, so the
    // answer is one answer rather than three.
    if (op === "mul" || op === "div" || op === "mod") {
      const out = this.wideScratch();
      this.i32(out);
      this.value(left, left.type);
      this.value(right, right.type);
      this.callService(`blaze_rt_u256_${op}`);
      this.i32(out);
      return;
    }
    const leftAt = this.borrow(I32);
    this.value(left, left.type);
    this.keep(leftAt);
    const rightAt = this.borrow(I32);
    this.value(right, right.type);
    this.keep(rightAt);
    const out = this.wideScratch();

    const bitwise = WIDE_BITWISE[op];
    if (bitwise !== undefined) {
      for (let limb = 0; limb < 4; limb += 1) {
        this.atScratch(out);
        this.loadLimb(leftAt, limb);
        this.loadLimb(rightAt, limb);
        this.op(bitwise);
        this.storeLimb(limb);
      }
      this.release(I32, leftAt);
      this.release(I32, rightAt);
      this.i32(out);
      return;
    }

    const carries = op === "add";
    if (!carries && op !== "sub") this.wideRefuse(op);
    // The limb being combined, the sum or difference of the two, and the flag
    // carried or borrowed in from the limb below.
    const leftLimb = this.borrow(I64);
    const rightLimb = this.borrow(I64);
    const middle = this.borrow(I64);
    const summed = this.borrow(I64);
    // A comparison answers a zero or a one and not a limb, so the flag is held
    // as the `i32` it is and widened back to a limb before it joins one.
    const flag = this.borrow(I32);
    const carry = this.borrow(I64);
    this.i64(0n);
    this.keep(carry);
    for (let limb = 0; limb < 4; limb += 1) {
      this.loadLimb(leftAt, limb, leftLimb);
      this.loadLimb(rightAt, limb, rightLimb);
      this.localAt(leftLimb);
      this.localAt(rightLimb);
      this.op(carries ? 0x7c : 0x7d); // `i64.add` or `i64.sub`
      this.tee(middle);
      // Whether the operation on its own carried or borrowed is a comparison of
      // the two it was given: a sum is below the limb it started from when it
      // carried, and a difference is one the limb being subtracted from was not
      // big enough to cover.
      if (carries) {
        this.localAt(leftLimb);
      } else {
        this.localAt(leftLimb);
        this.localAt(rightLimb);
      }
      this.op(0x54); // `i64.lt_u`
      this.keep(flag);
      this.localAt(middle);
      this.localAt(carry);
      this.op(carries ? 0x7c : 0x7d);
      // The limb before the carry and the limb after it are kept apart: the
      // second test is whether the carry going in pushed the result past what it
      // was, and comparing the result with itself is the one comparison that can
      // never be true — a carry chain that stops after the first limb and is
      // right on every value that never carries.
      this.tee(summed);
      // A sum that carried again is below what it was before the carry went in,
      // and a difference borrowed again when the result underflowed, which is
      // the same question asked of the difference before the borrow went in:
      // nothing was there to subtract it from.
      // For a sum the test is against the limb before the carry went in; for a
      // difference it is against the difference itself, because a borrow only
      // underflows when the difference was already below the borrow.
      this.localAt(middle);
      if (!carries) this.localAt(summed);
      this.op(0x54); // `i64.lt_u`
      this.op(0xad); // `i64.extend_i32_u`
      this.localAt(flag);
      this.op(0xad); // `i64.extend_i32_u`
      this.op(0x84); // `i64.or`
      this.keep(carry);
      this.atScratch(out);
      this.localAt(summed);
      this.storeLimb(limb);
    }
    for (const at of [leftLimb, rightLimb, middle, summed, carry]) this.release(I64, at);
    // The two addresses and the flag are 32 bit, and handing one of those back
    // as a limb would offer a later borrow of a limb the index of a short one.
    for (const at of [leftAt, rightAt, flag]) this.release(I32, at);
    this.i32(out);
  }

  /** One limb of a whole number, left on the stack or kept in a local. */
  private loadLimb(address: number, limb: number, into?: number): void {
    this.localAt(address);
    this.op(0x29); // `i64.load`
    this.code.varuint(3);
    this.code.varuint(limb * 8);
    if (into !== undefined) this.keep(into);
  }

  /**
   * The address the scratch the result is written to lives at.
   *
   * A store takes its address before its value — the address is the deeper of
   * the two on the stack — so this is pushed before the value is computed rather
   * than after, and the value is computed above it.
   */
  private atScratch(address: number): void {
    this.i32(address);
  }

  /** The address and the value on top of the stack, written as one limb. */
  private storeLimb(limb: number): void {
    this.op(0x37); // `i64.store`
    this.code.varuint(3);
    this.code.varuint(limb * 8);
  }

  /**
   * The refusal of an operation on a wide number this file has not written.
   *
   * A wide multiply is the one the other two backends answer and this one does
   * not, and the reason is an instruction the format does not have rather than
   * one this file has not reached: there is no `mulhi`, so a sixty-four by
   * sixty-four product has to be four thirty-two by thirty-two ones put back
   * together, and each of the ten limb products added into the answer with the
   * carry chain. A build that needs one is refused here rather than handed a
   * product that is the low half of every limb and nothing of the halves above,
   * which would be a wrong answer wearing a module's clothes.
   */
  private wideRefuse(op: string): never {
    throw new CompilerError({
      category: "AssemblyError",
      stage: "wasm",
      message: `this backend has not written a wide ${op}`,
      detail: `a whole number of this width is four 64 bit limbs in the host's memory and WebAssembly has one instruction per limb, so this is written out by hand and ${op} is not written yet`,
    });
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
    for (const name of block.releases) this.releaseName(name);
    this.terminator(block.terminator);
    this.close();
    if (label !== null) this.pop();
  }

  /**
   * A text the program wrote out, laid down in the module's own data.
   *
   * A text is a byte offset into the memory, and a text written out in the
   * source is a constant: it is laid down once, beside the wide constants the
   * body pooled, and every use of it is the address it was given. The bytes
   * carry a terminator, because the runtime writes a text as far as its
   * terminator.
   */
  private poolText(text: string): number {
    return this.module.text(text);
  }

  /**
   * A text, as the offset of its bytes in the memory.
   *
   * A text the program wrote out is laid down in the module's data and read at
   * the address it was given. A text built at run time is joined by the
   * runtime, which owns the result: the parts go down one at a time and the
   * runtime joins each onto the one before it.
   */
  private text(value: SemanticValue): void {
    if (value.k === "text") {
      if (value.parts.every((part) => part.k === "text")) {
        this.i32(this.poolText(value.parts.map((part) => (part as { k: "text"; value: string }).value).join("")));
        return;
      }
      this.joinedText(value.parts);
      return;
    }
    if (value.k === "toText") {
      this.asText(value.of, value.digits);
      return;
    }
    if (value.k === "const" && isTextType(value.type)) {
      this.i32(this.poolText(value.text));
      return;
    }
    if (value.k === "nothing") {
      // Nothing is the absence of a text, which is the zero the runtime reads
      // as nothing.
      this.i32(0);
      return;
    }
    this.value(value, TEXT);
  }

  /**
   * A text built at run time, joined by the runtime one part at a time.
   *
   * The first part is the text the join starts from and every part after it is
   * joined onto the result so far, which is what the runtime's own join does.
   */
  private joinedText(parts: readonly SemanticTextPart[]): void {
    const answer = this.borrow(I32);
    let started = false;
    for (const part of parts) {
      if (!started) {
        if (part.k === "text") this.i32(this.poolText(part.value));
        else this.asText(part.value, null);
        started = true;
        continue;
      }
      this.localAt(answer);
      if (part.k === "text") this.i32(this.poolText(part.value));
      else this.asText(part.value, null);
      this.callService("blaze_rt_string_append");
    }
    if (!started) this.i32(this.poolText(""));
    this.keep(answer);
    this.release(I32, answer);
  }

  /**
   * A value written as text, as the managed text the runtime owns.
   *
   * A text is already a text. A number is written by the runtime's own
   * formatter, into a block the module asks for and the runtime fills, and the
   * bytes are then copied into a text the runtime owns: a text the module
   * joins with another one has to be a text the runtime can measure and copy.
   */
  private asText(value: SemanticValue, digits: number | null): void {
    const type = value.type;
    if (isTextType(type)) {
      this.text(value);
      return;
    }
    if (type.kind === "primitive" && type.name === "bool") {
      // A truth is written as the word the language writes it in, and which of
      // the two words it is depends on the value, so the two are chosen
      // between rather than picked at build time.
      const truth = this.borrow(I32);
      this.condition(value);
      this.keep(truth);
      this.i32(this.poolText(this.style === 1 ? "True" : "true"));
      this.i32(this.poolText(this.style === 1 ? "False" : "false"));
      this.localAt(truth);
      this.op(0x1b); // `select`
      this.release(I32, truth);
      return;
    }
    if (type.kind === "ref" && type.of === null && type.name === undefined) {
      // A dynamic value is written by the runtime, which knows what it holds.
      this.value(value, DYNAMIC_TYPE);
      this.callService("blaze_rt_to_text");
      return;
    }
    if (type.kind === "primitive" && isWide(type.name)) {
      // A wide number is written by the runtime's own formatter.
      this.value(value, type);
      this.callService("blaze_rt_print_u256");
      return;
    }
    if (value.k === "nothing") {
      this.i32(this.poolText(this.style === 1 ? "None" : "null"));
      return;
    }
    // A number is written by the runtime's formatter into a block of its own,
    // and the bytes are then copied into a text the runtime owns.
    const scratch = this.borrow(I32);
    this.i64(64n);
    this.callService("blaze_rt_allocate");
    this.keep(scratch);
    const length = this.borrow(I64);
    this.value(value, F64_TYPE);
    this.localAt(scratch);
    if (digits === null) {
      this.i64(64n);
      this.callService("blaze_rt_format_number");
    } else {
      this.i32(digits);
      this.i64(64n);
      this.callService("blaze_rt_format_number_fixed");
    }
    this.keep(length);
    this.localAt(scratch);
    this.localAt(length);
    this.callService("blaze_rt_string_new");
    this.localAt(scratch);
    this.callService("blaze_rt_release");
    this.release(I64, length);
    this.release(I32, scratch);
  }

  /**
   * Writes text to the output, the way the runtime writes it.
   *
   * A text the program wrote out is written as it stands. A text built at run
   * time is written in the parts it was built from, which is what the runtime
   * does with one: a part written out is written as it stands, and a value
   * interpolated into it is written as the runtime writes that value.
   */
  private printText(value: SemanticValue): void {
    if (value.k === "text" && !value.parts.every((part) => part.k === "text")) {
      for (const part of value.parts) {
        if (part.k === "text") {
          this.i32(this.poolText(part.value));
          this.callService("blaze_rt_print_text");
          continue;
        }
        this.asText(part.value, null);
        this.callService("blaze_rt_print_text");
      }
      return;
    }
    this.text(value);
    this.callService("blaze_rt_print_text");
  }

  /**
   * Writes a number to the output, the way the runtime writes it.
   *
   * A whole number is written from the integer itself, because a double holds
   * every whole number only up to 2^53 and a larger one lost its last digits
   * on the way out.
   */
  private printNumber(value: SemanticValue, bigint: boolean): void {
    const type = value.type;
    if (type.kind === "primitive" && isWide(type.name)) {
      this.value(value, type);
      this.callService("blaze_rt_print_u256");
      return;
    }
    if (type.kind === "primitive" && isWholeNumber(type.name)) {
      this.value(value, type);
      this.convert(type, I64_TYPE);
      this.i32(bigint ? 1 : 0);
      this.callService("blaze_rt_print_whole");
      return;
    }
    this.value(value, F64_TYPE);
    this.callService("blaze_rt_print_number");
  }

  /** Keeps a value alive across a release of it, which is the runtime's counting. */
  private retainValue(value: SemanticValue): void {
    this.value(value, value.type);
    this.callService("blaze_rt_retain");
    this.op(0x1a); // `drop`
  }

  /** Drops a reference the runtime owns, which is the runtime's own counting. */
  private releaseName(name: string): void {
    const local = this.resolve(name);
    this.localAt(local.index);
    this.callService("blaze_rt_release");
  }

  private terminator(terminator: SemanticTerminator): void {
    if (terminator.k === "next") return;
    // A jump leaves the blocks it is written in, and frees what they owned on
    // the way out. A function allocates no array, and an object it builds
    // belongs to its caller, so there is normally nothing to free here.
    if (terminator.k === "jump") {
      for (const name of terminator.releases) this.releaseName(name);
    }
    // A block nothing arrives at is the one instruction WebAssembly has for it:
    // `unreachable` traps if control ever gets here, which is the honest answer
    // for a path the program does not take.
    if (terminator.k === "unreachable") {
      this.op(0x00);
      return;
    }
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
        if (statement.op === "**=") {
          // The power is the host's own, and it takes two doubles and answers
          // one: the operands are converted to doubles before the call and the
          // answer is converted back to the slot's own type after it. A slot of
          // a whole number is otherwise handed to the call at its own width,
          // and the engine refuses the module for it.
          this.get(statement.name);
          this.convert(type, F64_TYPE);
          this.value(statement.value, type);
          this.convert(type, F64_TYPE);
          this.op(0x10);
          this.code.varuint(0);
          this.convert(F64_TYPE, type);
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
          unreachable(`write an element of "${statement.buffer}"`, this.name, this.candidate);
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
          if (statement.op === "**=") {
            // The power is the host's own, and it takes two doubles: the old
            // element and the new value are converted to doubles before the
            // call and the answer is converted back to the element's own width.
            this.convert(element, F64_TYPE);
            this.value(statement.value, element);
            this.convert(element, F64_TYPE);
            this.op(0x10);
            this.code.varuint(0);
            this.convert(F64_TYPE, element);
          } else {
            this.value(statement.value, element);
            this.op(compoundCode(held, element, statement.op));
          }
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
          unreachable(`write the field "${statement.field}" of the layout "${statement.layout}"`, this.name, this.candidate);
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
        if (builtinFor(statement.call.callee) === null && this.module.function(statement.call.callee) === null) {
          unreachable(`call ${statement.call.callee}`, this.name, this.candidate);
        }
        // The dynamic values and the dynamic arrays are the runtime's own, and
        // the runtime is the host.
        if (this.dynamicCall(statement.call) !== null) {
          // Nothing reads the answer, so it is dropped rather than left for
          // the statement after it to take as one of its own operands.
          this.op(0x1a);
          return;
        }
        // A call of another function of the program is a call of the index that
        // function has in this module.
        const callee = this.module.function(statement.call.callee);
        if (callee !== null) {
          this.programCall(statement.call, callee, null);
          // Nothing reads the answer, so it is dropped rather than left for the
          // statement after it to take as one of its own operands.
          if (callee.result !== null) this.op(0x1a);
          return;
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
        this.printText(statement.value);
        return;
      case "printNumber":
        this.printNumber(statement.value, statement.bigint);
        return;
      case "printNewline":
        this.callService("blaze_rt_print_newline");
        return;
      case "retain":
        this.retainValue(statement.value);
        return;
      case "raise": {
        // A raise never comes back: the host throws where the C runtime does
        // not come back. WebAssembly has no way of saying that a call never
        // returns — the format has no such annotation on a function type — so
        // the lowering says it itself: the instruction after the call is an
        // `unreachable`, the same one the IR's own `unreachable` terminator
        // emits, which traps if control ever reaches it.
        this.text(statement.message);
        this.callService("blaze_rt_raise");
        this.op(0x00);
        return;
      }
      case "fill": {
        // Every element of an array written as one value, as `a.fill(x)` is.
        // The index is a name of the compiler's own, and the count is the
        // length of the buffer, which is the word the offset sits one before.
        const buffer = this.resolve(statement.buffer);
        const element = statement.type;
        const index = this.borrow(I32);
        const count = this.borrow(I32);
        this.localAt(buffer.index);
        this.i32(8);
        this.op(BINARY[I32].sub as number);
        this.op(0x29); // `i64.load`
        this.code.varuint(3);
        this.code.varuint(0);
        this.op(0xa7); // `i32.wrap_i64`
        this.keep(count);
        this.i32(0);
        this.keep(index);
        // The walk is a block around a loop, which is the shape every loop in
        // this backend is: the block is the exit and the loop is the header.
        this.op(0x02); // `block`
        this.code.byte(0x40);
        this.push(null);
        this.op(0x03); // `loop`
        this.code.byte(0x40);
        this.push(null);
        // The turn is done when the index has reached the count.
        this.localAt(index);
        this.localAt(count);
        this.op(UNSIGNED_BINARY[I32].ge as number);
        this.op(0x0d); // `br_if`
        this.code.varuint(1);
        // The element is written at the address the index names.
        this.localAt(buffer.index);
        this.localAt(index);
        const shift = facts(element).shift;
        if (shift > 0) {
          this.i32(shift);
          this.op(0x74); // `i32.shl`
        }
        this.op(BINARY[I32].add as number);
        this.value(statement.value, element);
        const store = facts(element).store;
        this.op(store.code);
        this.code.varuint(store.align);
        this.code.varuint(0);
        // The index moves on, at the head of the turn rather than at its foot,
        // so a `continue` does not skip it.
        this.localAt(index);
        this.i32(1);
        this.op(BINARY[I32].add as number);
        this.keep(index);
        this.op(0x0c); // `br`
        this.code.varuint(0);
        this.op(0x0b); // `end`
        this.pop();
        this.op(0x0b); // `end`
        this.pop();
        this.release(I32, count);
        this.release(I32, index);
        return;
      }
    }
  }

  /**
   * A loop as a `block` around a `loop`: `break` leaves the block and
   * `continue` branches to the loop, which is the one the IR's header names.
   *
   * Whatever a loop counts on is bound before either frame, because a branch
   * back to the loop start runs everything ahead of it, and a counter bound
   * inside the loop is a counter bound again on every pass.
   *
   * A loop marked parallel is written out as the loop it is. This module's one
   * import is an unshared `env.memory`, and `boundaryProblems` refuses any
   * other, so a WebAssembly thread is not something this backend can emit. The
   * mark says the turns do not depend on each other rather than that they must
   * be run at once, and running them in order is the same program.
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
    /**
     * The step of a counted loop, when it is a constant.
     *
     * A constant is the same number on every turn of the loop, so it is read
     * where it is used rather than kept in a local of its own: the local costs
     * a byte in the declaration and two in the write the body does not need,
     * and the read is the same size either way.
     */
    let stepConstant: { text: string; type: SemanticType } | null = null;
    if (loop.kind === "counted") {
      const held = facts(loop.type).held;
      // The bound, the step and the index it starts at are read before the index
      // is declared, because after it the name resolves to the loop's own
      // declaration: a loop counting from `for (let limit = limit; ...)` reads
      // the `limit` around it, and a local declared and not yet written is a
      // zero. The C backend reads them in this order for the same reason.
      bound = this.borrow(held);
      this.value(loop.to, loop.type);
      this.keep(bound);
      stepConstant = this.optimize ? countedStepOf(loop) : null;
      step = stepConstant === null ? this.borrow(held) : -1;
      if (stepConstant === null) {
        this.countedStep(loop);
        this.keep(step);
      }
      const startConstant = this.optimize ? constantOf(loop.from) : null;
      const start = startConstant === null ? this.borrow(held) : -1;
      if (startConstant === null) {
        this.value(loop.from, loop.type);
        this.keep(start);
      }
      this.holdLocal(loop.variable, loop.type);
      // A counted loop moves its index at the head of the turn rather than at
      // the foot, because a `continue` branches to the head: a step at the foot
      // is a step a `continue` skips, and a loop whose index never moves is a
      // loop that never ends. The turn before the first is a turn of its own,
      // so the index starts one step short of the value the source wrote.
      if (startConstant === null) this.read(start);
      else this.constant(startConstant.text, startConstant.type, loop.type);
      if (stepConstant === null) this.read(step);
      else this.constant(stepConstant.text, stepConstant.type, loop.type);
      this.op(BINARY[held].sub as number);
      this.set(loop.variable);
      if (start !== -1) this.release(held, start);
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
      const counter = this.get(loop.variable);
      if (stepConstant === null) this.read(step);
      else this.constant(stepConstant.text, stepConstant.type, loop.type);
      // The step is the signed amount the index moves by, so a loop counting
      // down carries a negative one and adds it like any other.
      this.op(BINARY[facts(loop.type).held].add as number);
      // The value the counter moves to is the value the test below reads, so
      // it is written down and left on the stack: a `local.tee` is one
      // instruction where a write and a read are two.
      if (this.optimize) this.tee(counter.index);
      else {
        this.set(loop.variable);
        this.get(loop.variable);
      }
      this.read(bound);
      const stop = loop.down ? (loop.inclusive ? "ge" : "gt") : loop.inclusive ? "le" : "lt";
      // The counter is ordered the way it was declared, which is what the
      // `each` walk below does: a loop counting up to a `u32` bound past the
      // signed range ends before it begins under the signed comparison, because
      // the same bits are a negative number.
      const unsignedStop = facts(loop.type).unsigned ? UNSIGNED_BINARY[facts(loop.type).held][stop] : undefined;
      this.op((unsignedStop ?? BINARY[facts(loop.type).held][stop]) as number);
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
      if (step !== -1) this.release(facts(loop.type).held, step);
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
    if (code !== undefined) {
      this.op(code);
      return;
    }
    if (ARGV_NAMES[callee] === true) {
      // The command line is the host's own, and the host is a process: the
      // count of it and the arguments on it are the runtime's to answer.
      if (callee === ARGV_LENGTH) {
        this.callService("blaze_rt_argv_count");
        return;
      }
      this.callService("blaze_rt_argv");
      return;
    }
    if (callee === "Math.random") {
      // The random source is the runtime's, and the runtime is the host.
      this.callService("blaze_rt_random");
      return;
    }
    if (callee === "whole.abs") {
      // The magnitude of a whole number, which is a whole number: the value
      // turned over when it is below zero. The value is read twice, so it is
      // kept in a local first.
      const at = this.borrow(I64);
      this.keep(at);
      this.i64(0n);
      this.localAt(at);
      this.op(BINARY[I64].sub as number);
      this.localAt(at);
      this.localAt(at);
      this.op(BINARY[I64].lt as number);
      this.op(0x1b); // `select`
      this.release(I64, at);
      return;
    }
    if (callee === "whole.min" || callee === "whole.max") {
      // The smaller or the larger of two whole numbers, which is a whole
      // number: the two are chosen between rather than compared into a truth.
      const left = this.borrow(I64);
      const right = this.borrow(I64);
      this.keep(left);
      this.keep(right);
      this.localAt(left);
      this.localAt(right);
      this.localAt(left);
      this.localAt(right);
      this.op(BINARY[I64][callee === "whole.min" ? "lt" : "gt"] as number);
      this.op(0x1b); // `select`
      this.release(I64, right);
      this.release(I64, left);
      return;
    }
    if (callee === "whole.floor" || callee === "whole.ceil" || callee === "whole.trunc") {
      // The three roundings that answer a whole number: the fraction one is
      // rounded and then narrowed, which is what the answer is.
      this.op(callee === "whole.floor" ? 0x9c : callee === "whole.ceil" ? 0x9b : 0x9d);
      this.op(0xb0); // `i64.trunc_f64_s`
      return;
    }
    if (callee === "Math.round") {
      // `Math.round` rounds a half away from zero, and the module has no
      // instruction that does. The two halves are computed with the
      // instructions it does have — `floor(x + 0.5)` for a non-negative
      // argument and `ceil(x - 0.5)` for a negative one — and the sign of
      // the argument chooses between them.
      const local = this.borrow(F64);
      this.tee(local);
      this.read(local);
      this.float(0.5, true);
      this.op(BINARY[F64].add as number);
      this.op(0x9c); // floor
      this.read(local);
      this.float(0.5, true);
      this.op(BINARY[F64].sub as number);
      this.op(0x9b); // ceil
      this.read(local);
      this.float(0, true);
      this.op(BINARY[F64].ge as number);
      this.op(0x1b); // select
      this.release(F64, local);
      return;
    }
    throw new CompilerError({
      category: "TargetError",
      stage: "compile",
      message: `a WebAssembly module cannot call ${callee}, in ${this.name}`,
      detail: "this backend has no instruction for it",
      function: this.name,
      candidate: this.candidate,
    });
  }

  /**
   * The calls the runtime answers, which are the dynamic values and the
   * dynamic arrays.
   *
   * A dynamic value is the runtime's own representation, carried in a handle,
   * and the runtime is the host: every one of these calls is a call of a
   * service of the host ABI. The arguments go down in the order the service
   * takes them, and the answer is what the service answers it in.
   *
   * The answer is the type the service answers in and not the type the call
   * was written at: the runtime answers a count as a double, and a use that
   * reads it as a whole number narrows it where it reads it.
   *
   * @returns the type the call answers, or null where the call is not one of
   * the runtime's own.
   */
  private dynamicCall(call: SemanticCall): SemanticType | null {
    const argument = (position: number): SemanticValue => call.args[position] as SemanticValue;
    switch (call.callee) {
      case "array.new":
        // An empty dynamic array, which is the runtime's own and is carried in
        // the handle it answers.
        this.callService("blaze_rt_dyn_array_new");
        return DYNAMIC_TYPE;
      case "array.push":
        this.dynamicValue(argument(0));
        this.dynamicValue(argument(1));
        this.callService("blaze_rt_array_push");
        return DYNAMIC_TYPE;
      case "array.get":
        this.dynamicValue(argument(0));
        this.dynamicValue(argument(1));
        this.callService("blaze_rt_array_get");
        return F64_TYPE;
      case "array.length":
        this.dynamicValue(argument(0));
        this.callService("blaze_rt_array_length");
        return F64_TYPE;
      case "JSON.parse": {
        // The text is the offset of its bytes, which is what the service
        // reads. The C ABI carries it as a double because everything on that
        // side of the wall is a double; this ABI has a pointer of its own,
        // and every other service of the table that takes a text takes it
        // that way.
        const text = argument(0);
        if (!isTextType(text.type)) {
          unreachable("parse JSON of something that is not a text", this.name, this.candidate);
        }
        this.value(text, TEXT);
        this.callService("blaze_rt_json_parse");
        return DYNAMIC_TYPE;
      }
      case "JSON.stringify":
        this.dynamicValue(argument(0));
        this.callService("blaze_rt_json_stringify");
        return DYNAMIC_TYPE;
      case "crypto.createHash":
        this.callService("blaze_rt_md5_create");
        return DYNAMIC_TYPE;
      case "hasher.update": {
        // The hasher is the runtime's own, and the text it is fed is the text
        // the value holds: a text is itself, and anything else is what the
        // runtime renders it as.
        this.dynamicValue(argument(0));
        const text = argument(1);
        if (isTextType(text.type)) {
          this.value(text, TEXT);
        } else {
          this.dynamicValue(text);
          this.callService("blaze_rt_to_text");
        }
        this.callService("blaze_rt_md5_update");
        return DYNAMIC_TYPE;
      }
      case "hasher.update.digest":
        this.dynamicValue(argument(0));
        this.callService("blaze_rt_md5_digest");
        return DYNAMIC_TYPE;
      case "fs.readFileSync":
        // The path and the mode are texts, and the runtime reads them at the
        // offsets they are.
        this.textArgument(argument(0));
        this.textArgument(argument(1));
        this.callService("blaze_rt_file_read");
        return DYNAMIC_TYPE;
      case "Number":
      case "parseInt": {
        // The number a value is written at: a text is the number its text
        // states, and the runtime reads it out of the box it makes of it.
        const value = argument(0);
        if (isTextType(value.type)) {
          this.value(value, TEXT);
          this.callService("blaze_rt_box_string");
        } else {
          this.dynamicValue(value);
        }
        this.callService("blaze_rt_to_number");
        return F64_TYPE;
      }
      case "text.indexOf": {
        // Where the needle first says itself in the text. The two texts go
        // down at the offsets their bytes are at, and the service answers the
        // index the module carries a number at.
        this.textArgument(argument(0));
        this.textArgument(argument(1));
        this.callService("blaze_rt_text_index_of");
        return F64_TYPE;
      }
      case "text.slice": {
        // The text between two indexes. A slice written with one index runs
        // to the end, which the service reads as a stop it can never reach.
        this.textArgument(argument(0));
        this.value(argument(1), F64_TYPE);
        if (call.args.length > 2) this.value(argument(2), F64_TYPE);
        else this.float(Number.MAX_SAFE_INTEGER, true);
        this.callService("blaze_rt_text_slice");
        return TEXT;
      }
      case "text.trim": {
        // The text with the whitespace at both ends gone.
        this.textArgument(argument(0));
        this.callService("blaze_rt_text_trim");
        return TEXT;
      }
      case "process.env": {
        // The environment variable a program reads: the host asks for it by
        // its name, and the answer is the text it is set to, empty where the
        // host set nothing at all.
        this.textArgument(argument(0));
        this.callService("blaze_rt_env_get");
        return TEXT;
      }
      default:
        return null;
    }
  }

  /**
   * A value the runtime holds, as the double the runtime carries it in.
   *
   * A number is a number and a value the runtime already holds is the handle
   * it is held in. A text is a text the runtime owns: the runtime boxes it,
   * because the boxing is what makes a text a dynamic value, and it is the
   * runtime's own work rather than the module's.
   */
  private dynamicValue(value: SemanticValue): void {
    const type = value.type;
    if (type.kind === "ref" && type.of === null && type.name === undefined) {
      this.value(value, DYNAMIC_TYPE);
      return;
    }
    if (isTextType(type)) {
      this.value(value, TEXT);
      this.callService("blaze_rt_box_string");
      return;
    }
    this.value(value, F64_TYPE);
  }

  /**
   * A text the runtime is handed, as the offset of its bytes.
   *
   * A text is the offset of its bytes in the memory, and a text that is
   * nothing is no offset at all: the runtime reads an empty text at it.
   */
  private textArgument(value: SemanticValue): void {
    if (isTextType(value.type)) {
      this.value(value, TEXT);
      return;
    }
    if (value.k === "nothing") {
      this.i32(0);
      return;
    }
    unreachable("hand the runtime a text where a text is wanted", this.name, this.candidate);
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

  /**
   * How much of the function's own scratch the arithmetic has taken.
   *
   * The module asks for it once the body has been lowered, because the scratch
   * of a function is a region of its own and the regions are laid out one after
   * another above the constants.
   */
  scratchUsed(): number {
    return this.scratchTaken;
  }
}

/* -------------------------------------------------------------------------- */
/* The module                                                                  */
/* -------------------------------------------------------------------------- */

const MODULE_HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

/** The byte a WebAssembly value type is written as in a type section. */
const TYPE_CODES: Record<string, number> = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c };

/**
 * The constant a value is, or null where it is not one.
 *
 * A constant is a number the source wrote out, and a number the source wrote
 * out is the same number on every turn of a loop and on every pass of a
 * branch. The backend reads such a number where it is used rather than
 * keeping it in a local of its own, which is a fold the backend knows is safe
 * because it is the one that wrote the number.
 */
function constantOf(value: SemanticValue | null): { text: string; type: SemanticType } | null {
  if (value === null) return null;
  if (value.k !== "const") return null;
  if (value.type.kind !== "primitive") return null;
  if (isWide(value.type.name)) return null;
  return { text: value.text, type: value.type };
}

/**
 * The step a counted loop moves its index by, when it is a number the source
 * wrote out.
 *
 * A loop that writes no step of its own moves its index by one, or by one
 * less when it counts down, and that is a number like any other.
 */
function countedStepOf(loop: Extract<SemanticLoop, { kind: "counted" }>): { text: string; type: SemanticType } | null {
  if (loop.step !== null) return constantOf(loop.step);
  return { text: loop.down ? "-1" : "1", type: loop.type };
}

/**
 * Whether the body of a function always answers, which is what makes the value
 * a body that falls out of its own end leaves behind unnecessary.
 *
 * A body that ends in a return never falls out of its own end, so the value
 * the function leaves behind is written where nothing reaches it. A jump to
 * the entry block lands at the end of the function, and that path does reach
 * it, so a body with such a jump needs the value after all.
 */
function alwaysReturns(fn: SemanticFunction): boolean {
  const entry = fn.entry;
  if (entry.terminator.k !== "return" && entry.terminator.k !== "unreachable") return false;
  return !blocksOf(entry).some(
    (block) => block.terminator.k === "jump" && block.terminator.target === entry.id,
  );
}

/** Every block of a body, the one it starts with and the ones inside it. */
function blocksOf(block: SemanticBlock): SemanticBlock[] {
  const blocks: SemanticBlock[] = [block];
  for (const statement of block.statements) {
    if (statement.k === "if") {
      blocks.push(...blocksOf(statement.then));
      if (statement.otherwise !== null) blocks.push(...blocksOf(statement.otherwise));
      continue;
    }
    if (statement.k === "loop") {
      blocks.push(...blocksOf(statement.loop.body));
      continue;
    }
    if (statement.k === "block") blocks.push(...blocksOf(statement.body));
  }
  return blocks;
}

/**
 * One function the module holds.
 */
export interface ModuleFunction {
  /** The IR of the function, already validated against its contract. */
  readonly fn: SemanticFunction;
  /**
   * The contract the function is called by.
   *
   * The contract says what the function takes and what it answers, and the
   * module declares the function with the types the IR holds.
   */
  readonly contract?: FunctionContract;
  /**
   * The name the module exports it by.
   *
   * It is the symbol the program calls the function by, which is the symbol
   * the IR holds unless the caller says otherwise.
   */
  readonly export?: string;
}

/**
 * The module of a program: every function of the program, and the body it runs.
 */
export interface ProgramModule {
  /** The functions the module holds, in the order they are numbered in. */
  readonly functions: readonly ModuleFunction[];
  /**
   * The body of the program, as the entry of the module.
   *
   * The entry is a function of no arguments that runs the statements of the
   * body and answers nothing: it is the driver the C backend writes in C,
   * written here as the module's own function.
   */
  readonly entry?: SemanticBlock;
}

/** What a module is written with. */
export interface ModuleOptions {
  /** The candidate the module was written from, which a refusal names. */
  readonly candidate?: string;
  /** The style a value is written as text in, which is the language's own. */
  readonly style?: number;
  /**
   * Whether the folds the backend knows are safe are applied.
   *
   * A build folds. The flag is here so that the folded module and the
   * unfolded one can be compared, which is the only way to say that a fold
   * changed nothing but the size.
   */
  readonly optimize?: boolean;
}

/**
 * The name the module exports the entry of a program by.
 *
 * The entry is the body of the program, and the host calls it the way it calls
 * the contracted symbol of a function: it is the driver the C backend writes
 * in C, written here as the module's own function.
 */
export const ENTRY_EXPORT = "__blaze_entry";

/**
 * What the module of a program is written from.
 */
export interface ProgramModuleRequest {
  /** The functions the module holds, in the order they are numbered in. */
  readonly functions: readonly ModuleFunction[];
  /**
   * The body of the program, as the entry of the module.
   *
   * The entry is a function of no arguments that runs the statements of the
   * body and answers nothing: it is the driver the C backend writes in C,
   * written here as the module's own function.
   */
  readonly entry?: SemanticBlock;
  /** Where the module is written. */
  readonly modulePath: string;
  /** Where the host that runs it is written. */
  readonly hostPath: string;
  /** The candidate the module was written from, which a refusal names. */
  readonly candidate?: string;
  /** The language the program was written in. */
  readonly language?: string;
  /** Whether the folds the backend knows are safe are applied. */
  readonly optimize?: boolean;
}

/**
 * The function's own body as the module writes it, and the bytes of the code
 * section it is written into.
 *
 * The folded module is the one a build writes: the folds the backend knows
 * are safe are applied to what it writes, and a fold that changed an answer
 * would be a fold the backend did not know was safe.
 */
export function moduleBytes(
  fn: SemanticFunction,
  contract: FunctionContract,
  candidate?: string,
  style = 0,
  options: { optimize?: boolean } = {},
): Uint8Array {
  return programModuleBytes(
    { functions: [{ fn, contract }] },
    { candidate, style, optimize: options.optimize ?? true },
  );
}

/**
 * The module of a program, as the bytes of it.
 *
 * A module holds every function of the program and calls them by the index
 * each of them has in it, and the body of the program is the entry of the
 * module: there is no linker and no symbol table, so a call is a lookup in the
 * table the module holds and the driver the C backend writes in C is the
 * module's own function.
 *
 * The module is written twice. The first pass finds out what the module
 * imports — a service is imported the first time a function reaches for it, so
 * the count of the imports is not known until every function has been lowered —
 * and how much scratch each function needs for the whole numbers in flight.
 * The second pass writes the module with the indexes the imports leave and the
 * scratch the first pass measured.
 */
export function programModuleBytes(program: ProgramModule, options: ModuleOptions = {}): Uint8Array {
  const optimize = options.optimize ?? true;
  const style = options.style ?? 0;
  const candidate = options.candidate;

  /** The functions the module holds, with the entry among them. */
  const functions: { fn: SemanticFunction; name: string; export: string }[] = [];
  for (const one of program.functions) {
    const named = one.export ?? one.fn.symbol;
    functions.push({ fn: one.fn, name: named, export: named });
  }
  if (program.entry !== undefined) {
    // The entry is the body of the program, and a refusal in it names the body
    // rather than the symbol the module exports it by.
    functions.push({ fn: entryFunction(program.entry), name: "the body of the program", export: ENTRY_EXPORT });
  }
  if (functions.length === 0) {
    throw new CompilerError({
      category: "TargetError",
      stage: "compile",
      message: "a WebAssembly module holds no function",
      detail: "the module of a program holds every function of the program and the body it runs",
      candidate,
    });
  }

  // The first pass: what the module imports, and how much scratch each of its
  // functions needs for the whole numbers in flight.
  const probe = new Module();
  for (const one of functions) probe.held.push(heldOf(one.fn, one.export));
  const scratch: number[] = [];
  for (const one of functions) {
    scratch.push(lower(probe, one, 0, candidate, style, optimize).scratch);
  }

  // The imports are known now, so the functions of the module are numbered
  // after them: the power is the first function the module imports, the
  // services the module reached for follow it, and the module's own functions
  // come after those. The memory is not a function and takes no index.
  const services = probe.serviceList();
  const base = 1 + services.length;
  // The scratch of each function is a region of its own, and the constants are
  // laid down above every one of them.
  const regions: number[] = [];
  let used = 0;
  for (const size of scratch) {
    regions.push(used);
    used += size;
  }
  if (used > SCRATCH_LIMIT) {
    throw new CompilerError({
      category: "AssemblyError",
      stage: "wasm",
      message: "the module keeps more wide numbers in flight than it has scratch for",
      detail: `every value an operation is computing on is thirty-two bytes and they live in a region below the module's constants, of which there are ${(SCRATCH_LIMIT / 32) | 0}`,
      candidate,
    });
  }
  const offset = Math.max(WIDE_DATA_BASE, used);

  // The second pass: the module itself, with the indexes the imports leave.
  const module = new Module();
  module.base = base;
  module.offset = offset;
  for (const one of functions) module.held.push(heldOf(one.fn, one.export));
  const codes: Bytes[] = [];
  for (const [index, one] of functions.entries()) {
    codes.push(lower(module, one, regions[index] as number, candidate, style, optimize).code);
  }

  const signatures = services.map((symbol) => {
    const service = HOST_SERVICE_BY_SYMBOL.get(symbol);
    if (service === undefined) {
      throw new CompilerError({
        category: "TargetError",
        stage: "compile",
        message: `"${symbol}" is not a service of the host ABI`,
        candidate,
      });
    }
    return service;
  });

  const out = new Bytes();
  out.raw(MODULE_HEADER);
  // The types are the module's own functions first, then the power, then the
  // services: the import section names the power's type and the services' types
  // by their index, and the function section names each function's type.
  const functionTypes = functions.map((one) => signatureOf(one.fn));
  out.section(1, (types) =>
    types.counted(1 + functionTypes.length + signatures.length, (one) => {
      for (const type of functionTypes) writeType(one, type);
      one.byte(0x60);
      one.counted(2, (values) => { values.byte(0x7c); values.byte(0x7c); });
      one.counted(1, (results) => results.byte(0x7c));
      for (const service of signatures) {
        writeType(one, {
          parameters: service.params.map((type) => TYPE_CODES[type] as number),
          result: service.result === null ? undefined : (TYPE_CODES[service.result] as number),
        });
      }
    }),
  );
  out.section(2, (imports) =>
    imports.counted(2 + services.length, (one) => {
      one.name("env");
      one.name("memory");
      one.byte(0x02);
      one.byte(0x00);
      one.varuint(1);
      one.name("env");
      one.name("pow");
      one.byte(0x00);
      one.varuint(functionTypes.length);
      for (const [position, symbol] of services.entries()) {
        one.name("env");
        one.name(symbol);
        one.byte(0x00);
        // The type of a service is the one after the functions' own types and
        // the power's, in the order the services are listed in.
        one.varuint(1 + functionTypes.length + position);
      }
    }),
  );
  out.section(3, (functions2) => {
    // Every function of the module has a type of its own, in the order the
    // functions are numbered in, so the type of the nth is the nth.
    const body = new Bytes();
    for (let index = 0; index < functions.length; index += 1) body.byte(index);
    functions2.varuint(functions.length);
    functions2.absorb(body);
  });
  // The constants the body pooled, one global each. The section sits between
  // the function section and the export section because the format numbers the
  // sections in order, and a global is read by the index the body handed it out
  // at, so the order they were laid down in is the order they are numbered in.
  //
  // A global is its value type, a mutability byte and a constant expression that
  // initialises it. The expression is the constant itself followed by `end`, and
  // the mutability is immutable because nothing here can write one.
  // The constants the body pooled, one global each, and after them the address
  // the host may first hand out memory from. That last one is a global rather
  // than a constant the host is told, because the host does not know how much
  // data the module laid down: it would have to read the segment back out of the
  // binary. The module is the only thing that knows where its own memory ends,
  // so it says so, and a host that allocated below it would write a vector over
  // the limbs of a wide number in flight.
  out.section(6, (globals) =>
    globals.counted(module.floats.length + 1, (each) => {
      for (const pooled of module.floats) {
        // A global is its value type, a mutability byte and a constant expression
        // that initialises it. The expression is the constant itself followed by
        // `end`, and the mutability is immutable because nothing here can write one.
        each.byte(pooled.type);
        each.byte(0x00);
        each.byte(pooled.opcode);
        each.raw(pooled.bytes);
        each.byte(0x0b);
      }
      each.byte(I32);
      each.byte(0x00);
      each.byte(0x41);
      each.varuint(dataBase(module));
      each.byte(0x0b);
    }),
  );
  out.section(7, (exports) => {
    const body = new Bytes();
    for (const [index, one] of functions.entries()) {
      body.name(one.export);
      body.byte(0x00);
      // The functions of the module come after the imports: the power and the
      // services the module reached for.
      body.varuint(base + index);
    }
    // The global the host reads to learn where it may allocate from. `0x03`
    // is a global export; the index is past every pooled float.
    body.name(DATA_BASE_EXPORT);
    body.byte(0x03);
    body.varuint(module.floats.length);
    exports.varuint(functions.length + 1);
    exports.absorb(body);
  });
  out.section(10, (bodies) => {
    const body = new Bytes();
    for (const code of codes) {
      body.varuint(code.length);
      body.absorb(code);
    }
    bodies.varuint(codes.length);
    bodies.absorb(body);
  });
  // The wide constants and the texts the body pooled, laid down once by the
  // host when the module is instantiated. The segment starts above the scratch
  // the arithmetic writes into, because a data segment is not a thing a module
  // may write to and a wide number in flight is. Its offset is a constant
  // expression rather than an address the body reads, which is what the format
  // requires.
  if (module.data.length > 0) {
    out.section(11, (data) =>
      data.counted(1, (one) => {
        // An active segment in memory zero, written at a constant expression.
        one.varuint(0);
        one.byte(0x41);
        one.varbig(BigInt(offset));
        one.byte(0x0b);
        const bytes = module.data.flat();
        one.varuint(bytes.length);
        for (const byte of bytes) one.byte(byte);
      }),
    );
  }
  return out.build();
}

/**
 * The type a function is declared with: the carriers of its parameters and the
 * carrier of what it answers.
 */
function signatureOf(fn: SemanticFunction): { parameters: number[]; result: number | undefined } {
  const parameters = fn.params.map((param) => facts(slotType(param)).held);
  const result = fn.returns.kind === "void" ? undefined : facts(fn.returns).held;
  return { parameters, result };
}

/** Writes one type into the type section. */
function writeType(
  one: Bytes,
  type: { parameters: number[]; result: number | undefined },
): void {
  one.byte(0x60);
  one.counted(type.parameters.length, (values) => type.parameters.forEach((code) => values.byte(code)));
  one.counted(type.result === undefined ? 0 : 1, (results) => {
    if (type.result !== undefined) results.byte(type.result);
  });
}

/** What the module holds of one function, and what a call of it needs to know. */
function heldOf(fn: SemanticFunction, named: string): HeldFunction {
  return {
    fn,
    export: named,
    params: fn.params.map((param) => slotType(param)),
    result: fn.returns.kind === "void" ? null : fn.returns,
  };
}

/**
 * The body of a program, as the function the module runs it by.
 *
 * The body is a sequence of statements rather than a function, and the module
 * runs it as one: a function of no arguments that answers nothing.
 */
function entryFunction(block: SemanticBlock): SemanticFunction {
  return {
    name: ENTRY_EXPORT,
    symbol: ENTRY_EXPORT,
    params: [],
    returns: { kind: "void" },
    requires: [],
    ensures: [],
    effects: [],
    allocates: false,
    prints: false,
    readsArgv: false,
    objects: {},
    calls: [],
    entry: block,
  };
}

/**
 * Lowers one function of the module and returns the bytes of its body.
 *
 * The body is emitted into a buffer of its own, because a statement that
 * needs a value twice borrows a local for it, and a local borrowed while the
 * body was emitted was not declared yet. So the body's own bytes are taken
 * first and the declaration they are numbered against is written in front of
 * them afterwards.
 */
function lower(
  module: Module,
  one: { fn: SemanticFunction; name: string; export: string },
  scratch: number,
  candidate: string | undefined,
  style: number,
  optimize: boolean,
): { code: Bytes; scratch: number } {
  const fn = one.fn;
  const body = new Body(module, fn, one.name, fn.returns, candidate, style, optimize, scratch);
  const signature = signatureOf(fn);
  body.block(fn.entry, null);
  // The value a body that falls out of its own end leaves behind is written
  // before the body's bytes are taken, because `answer` appends to the buffer
  // the body is written into: an `answer` after they were read appends to a
  // buffer nothing reads again, and the `end` that closes the function is left
  // with an empty stack under a type section that declares a result.
  //
  // A body that always answers does not fall out of its own end, so the value
  // is written where nothing reaches it: the module carries it and nothing
  // reads it.
  if (signature.result !== undefined && !(optimize && alwaysReturns(fn))) body.answer();
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
  return { code, scratch: body.scratchUsed() };
}

/**
 * The first address above everything the module owns: its scratch is below the
 * constants, and the constants are the wide numbers and the texts the module
 * pooled, in that order.
 */
function dataBase(module: Module): number {
  const pooled = module.data.reduce((whole, bytes) => whole + bytes.length, 0);
  return module.offset + pooled;
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

/**
 * What a module holds, as a reader is told it.
 *
 * A module is binary, so a review of one is shown a listing of it: every
 * section it is made of and how large that section is, the types, the imports
 * and their signatures, the exports, the globals, and the code section decoded
 * into the instructions a processor would run. The rules a review applies are
 * applied to the IR the module was built from, which is what the compiler
 * already does; what the listing is for is that a reader can see what the
 * module holds rather than what the compiler meant to write.
 */
export function describeModule(bytes: Uint8Array): string {
  const lines: string[] = [`${bytes.length} bytes`, ""];
  const header = bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d;
  if (!header) {
    lines.push("These bytes do not begin with a WebAssembly module header.");
    return lines.join("\n");
  }
  const sections = new Map<number, Uint8Array>();
  let at = 8;
  while (at < bytes.length) {
    const id = bytes[at] ?? 0;
    const size = readVaruint(bytes, at + 1, 32);
    const name = SECTIONS[id] ?? `section ${id}`;
    lines.push(`${name}: ${size.value} bytes`);
    sections.set(id, bodyOf(bytes, size));
    at = size.next + size.value;
  }
  lines.push("");

  const types = readTypes(sections.get(1));
  if (types.length > 0) {
    lines.push("types:");
    for (const [index, type] of types.entries()) lines.push(`  ${index}: ${type}`);
    lines.push("");
  }

  const imports = readImports(sections.get(2));
  if (imports.length > 0) {
    lines.push("imports:");
    for (const entry of imports) lines.push(`  ${entry}`);
    lines.push("");
  }

  const globals = readGlobals(sections.get(6));
  if (globals.length > 0) {
    lines.push("globals:");
    for (const [index, entry] of globals.entries()) lines.push(`  ${index}: ${entry}`);
    lines.push("");
  }

  const exports = readExports(sections.get(7));
  if (exports.length > 0) {
    lines.push("exports:");
    for (const entry of exports) lines.push(`  ${entry}`);
    lines.push("");
  }

  const code = sections.get(10);
  if (code !== undefined) {
    // The code section holds the functions the module defines, and the format
    // numbers the imported ones first: the nth function of the code section is
    // the function at the index past the imports.
    const imported = imports.filter((entry) => / \(function \d+\)$/.test(entry)).length;
    const names = new Map<number, string>();
    for (const entry of exports) {
      const match = /^(\S+) \(function (\d+)\)$/.exec(entry);
      if (match !== null) names.set(Number(match[2]), match[1] as string);
    }
    lines.push("code:");
    for (const [index, body] of readCode(code).entries()) {
      const at = imported + index;
      lines.push(`  function ${at}${names.has(at) ? ` (${names.get(at)})` : ""}:`);
      for (const instruction of body) lines.push(`    ${instruction}`);
    }
    lines.push("");
  }

  return lines.join("\n").replace(/\n+$/, "\n");
}

/** The value types the format names, by the byte it writes them as. */
const VALUE_TYPES: Record<number, string> = {
  0x7f: "i32",
  0x7e: "i64",
  0x7d: "f32",
  0x7c: "f64",
  0x70: "funcref",
  0x6f: "externref",
};

/** The types of the module, as the signature the format writes them in. */
function readTypes(body: Uint8Array | undefined): string[] {
  if (body === undefined) return [];
  const types: string[] = [];
  const count = readVaruint(body, 0, 32);
  let at = count.next;
  for (let index = 0; index < count.value && at < body.length; index += 1) {
    const form = body[at];
    at += 1;
    if (form !== 0x60) break;
    const parameters = readVaruint(body, at, 32);
    const names: string[] = [];
    let cursor = parameters.next;
    for (let position = 0; position < parameters.value && cursor < body.length; position += 1) {
      names.push(VALUE_TYPES[body[cursor] ?? 0] ?? "unknown");
      cursor += 1;
    }
    at = cursor;
    const results = readVaruint(body, at, 32);
    const answers: string[] = [];
    cursor = results.next;
    for (let position = 0; position < results.value && cursor < body.length; position += 1) {
      answers.push(VALUE_TYPES[body[cursor] ?? 0] ?? "unknown");
      cursor += 1;
    }
    at = cursor;
    types.push(`(${names.join(", ")}) -> ${answers.length === 0 ? "nothing" : answers.join(", ")}`);
  }
  return types;
}

/** The imports of the module, as one line each. */
function readImports(body: Uint8Array | undefined): string[] {
  if (body === undefined) return [];
  const entries: string[] = [];
  const count = readVaruint(body, 0, 32);
  let at = count.next;
  for (let index = 0; index < count.value && at < body.length; index += 1) {
    const module = readVaruint(body, at, 32);
    const field = readVaruint(body, module.next + module.value, 32);
    const kind = body[field.next + field.value] ?? 0;
    const name = new TextDecoder().decode(bodyOf(body, field));
    const moduleName = new TextDecoder().decode(bodyOf(body, module));
    at = field.next + field.value + 1;
    if (kind === 0x00) {
      const type = readVaruint(body, at, 32);
      at = type.next;
      entries.push(`${moduleName}.${name} (function ${type.value})`);
      continue;
    }
    if (kind === 0x02) {
      at += 1;
      const minimum = readVaruint(body, at, 32);
      at = minimum.next;
      entries.push(`${moduleName}.${name} (memory ${minimum.value} pages)`);
      continue;
    }
    break;
  }
  return entries;
}

/** The globals of the module, as one line each. */
function readGlobals(body: Uint8Array | undefined): string[] {
  if (body === undefined) return [];
  const entries: string[] = [];
  const count = readVaruint(body, 0, 32);
  let at = count.next;
  for (let index = 0; index < count.value && at < body.length; index += 1) {
    const type = VALUE_TYPES[body[at] ?? 0] ?? "unknown";
    const mutable = (body[at + 1] ?? 0) !== 0;
    at += 2;
    // The initialiser is a constant expression, which ends at its `end`.
    while (at < body.length && body[at] !== 0x0b) at += 1;
    at += 1;
    entries.push(`${type}${mutable ? " (mutable)" : ""}`);
  }
  return entries;
}

/** The exports of the module, as one `name (kind index)` line each. */
function readExports(body: Uint8Array | undefined): string[] {
  if (body === undefined) return [];
  const kinds = ["function", "table", "memory", "global"];
  const entries: string[] = [];
  const count = readVaruint(body, 0, 32);
  let at = count.next;
  for (let index = 0; index < count.value && at < body.length; index += 1) {
    const name = readVaruint(body, at, 32);
    const kind = kinds[body[name.next + name.value] ?? 0] ?? "unknown";
    const target = readVaruint(body, name.next + name.value + 1, 32);
    entries.push(`${new TextDecoder().decode(bodyOf(body, name))} (${kind} ${target.value})`);
    at = target.next;
  }
  return entries;
}

/**
 * The code section, decoded into the instructions a processor would run.
 *
 * Every instruction is one line: where it is, what it is, and what it reads.
 * A reader of a module reads this rather than the bytes, which is the same
 * thing a reader of an object reads rather than the bytes of it.
 */
function readCode(body: Uint8Array): string[][] {
  const functions: string[][] = [];
  const count = readVaruint(body, 0, 32);
  let at = count.next;
  for (let index = 0; index < count.value && at < body.length; index += 1) {
    const size = readVaruint(body, at, 32);
    at = size.next;
    functions.push(readFunction(body.subarray(at, at + size.value)));
    at += size.value;
  }
  return functions;
}

/** One function's body, decoded into its instructions. */
function readFunction(body: Uint8Array): string[] {
  const lines: string[] = [];
  const locals = readVaruint(body, 0, 32);
  let at = locals.next;
  let local = 0;
  for (let index = 0; index < locals.value && at < body.length; index += 1) {
    const count = readVaruint(body, at, 32);
    at = count.next;
    const type = VALUE_TYPES[body[at] ?? 0] ?? "unknown";
    at += 1;
    if (index === 0) lines.push(`locals: ${count.value} x ${type}`);
    local += count.value;
  }
  while (at < body.length) {
    const start = at;
    const opcode = body[at] ?? 0;
    at += 1;
    const instruction = INSTRUCTIONS[opcode];
    if (instruction === undefined) {
      lines.push(`${start.toString(16).padStart(4, "0")}  (unknown opcode 0x${opcode.toString(16)})`);
      break;
    }
    const immediate = readImmediate(body, at, instruction[1]);
    at = immediate.next;
    lines.push(`${start.toString(16).padStart(4, "0")}  ${instruction[0]}${immediate.text === "" ? "" : ` ${immediate.text}`}`);
  }
  return lines;
}

/**
 * The immediate an instruction reads, as the text of it.
 *
 * The kinds are the ones the format has: an index, a memory argument, a
 * constant of one of the four carriers, a block type, a table of branches and
 * the few that are their own shape.
 */
function readImmediate(body: Uint8Array, at: number, kind: string): { text: string; next: number } {
  switch (kind) {
    case "index": {
      const value = readVaruint(body, at, 32);
      return { text: String(value.value), next: value.next };
    }
    case "memarg": {
      const align = readVaruint(body, at, 32);
      const offset = readVaruint(body, align.next, 32);
      return { text: `align=${align.value} offset=${offset.value}`, next: offset.next };
    }
    case "i32": {
      const value = readVarint(body, at);
      return { text: String(value.value), next: value.next };
    }
    case "i64": {
      const value = readVarint64(body, at);
      return { text: String(value.value), next: value.next };
    }
    case "f32": {
      const view = new DataView(body.buffer, body.byteOffset + at, 4);
      return { text: String(view.getFloat32(0, true)), next: at + 4 };
    }
    case "f64": {
      const view = new DataView(body.buffer, body.byteOffset + at, 8);
      return { text: String(view.getFloat64(0, true)), next: at + 8 };
    }
    case "block": {
      const byte = body[at] ?? 0x40;
      if (byte === 0x40) return { text: "", next: at + 1 };
      return { text: VALUE_TYPES[byte] ?? "unknown", next: at + 1 };
    }
    case "br_table": {
      const count = readVaruint(body, at, 32);
      const targets: number[] = [];
      let cursor = count.next;
      for (let index = 0; index < count.value && cursor < body.length; index += 1) {
        const target = readVaruint(body, cursor, 32);
        targets.push(target.value);
        cursor = target.next;
      }
      const fallback = readVaruint(body, cursor, 32);
      return { text: `${targets.join(" ")} ${fallback.value}`, next: fallback.next };
    }
    case "call_indirect": {
      const type = readVaruint(body, at, 32);
      const table = readVaruint(body, type.next, 32);
      return { text: `${type.value} ${table.value}`, next: table.next };
    }
    case "select": {
      const count = readVaruint(body, at, 32);
      return { text: String(count.value), next: count.next };
    }
    default:
      return { text: "", next: at };
  }
}

/** Reads a signed integer the format writes in LEB128. */
function readVarint(bytes: Uint8Array, at: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  for (let index = at; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) {
      const signed = shift < 32 ? value << (32 - shift) >> (32 - shift) : value;
      return { value: signed, next: index + 1 };
    }
  }
  return { value: 0, next: bytes.length };
}

/** Reads a signed sixty-four bit integer the format writes in LEB128. */
function readVarint64(bytes: Uint8Array, at: number): { value: bigint; next: number } {
  let value = 0n;
  let shift = 0n;
  for (let index = at; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0;
    value |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
    if ((byte & 0x80) === 0) {
      const signed = BigInt.asIntN(64, value);
      return { value: signed, next: index + 1 };
    }
  }
  return { value: 0n, next: bytes.length };
}

/**
 * Every instruction the format has, by the byte it is written as, with the
 * kind of immediate it reads.
 *
 * The table is the format's own: a reader of a module has to name every
 * instruction it can meet, and the ones missing from it are the ones a module
 * this compiler wrote never carries.
 */
const INSTRUCTIONS: Record<number, [string, string]> = {
  0x00: ["unreachable", ""],
  0x01: ["nop", ""],
  0x02: ["block", "block"],
  0x03: ["loop", "block"],
  0x04: ["if", "block"],
  0x05: ["else", ""],
  0x0b: ["end", ""],
  0x0c: ["br", "index"],
  0x0d: ["br_if", "index"],
  0x0e: ["br_table", "br_table"],
  0x0f: ["return", ""],
  0x10: ["call", "index"],
  0x11: ["call_indirect", "call_indirect"],
  0x1a: ["drop", ""],
  0x1b: ["select", ""],
  0x1c: ["select", "select"],
  0x20: ["local.get", "index"],
  0x21: ["local.set", "index"],
  0x22: ["local.tee", "index"],
  0x23: ["global.get", "index"],
  0x24: ["global.set", "index"],
  0x28: ["i32.load", "memarg"],
  0x29: ["i64.load", "memarg"],
  0x2a: ["f32.load", "memarg"],
  0x2b: ["f64.load", "memarg"],
  0x2c: ["i32.load8_s", "memarg"],
  0x2d: ["i32.load8_u", "memarg"],
  0x2e: ["i32.load16_s", "memarg"],
  0x2f: ["i32.load16_u", "memarg"],
  0x30: ["i64.load8_s", "memarg"],
  0x31: ["i64.load8_u", "memarg"],
  0x32: ["i64.load16_s", "memarg"],
  0x33: ["i64.load16_u", "memarg"],
  0x34: ["i64.load32_s", "memarg"],
  0x35: ["i64.load32_u", "memarg"],
  0x36: ["i32.store", "memarg"],
  0x37: ["i64.store", "memarg"],
  0x38: ["f32.store", "memarg"],
  0x39: ["f64.store", "memarg"],
  0x3a: ["i32.store8", "memarg"],
  0x3b: ["i32.store16", "memarg"],
  0x3c: ["i64.store8", "memarg"],
  0x3d: ["i64.store16", "memarg"],
  0x3e: ["i64.store32", "memarg"],
  0x3f: ["memory.size", ""],
  0x40: ["memory.grow", ""],
  0x41: ["i32.const", "i32"],
  0x42: ["i64.const", "i64"],
  0x43: ["f32.const", "f32"],
  0x44: ["f64.const", "f64"],
  0x45: ["i32.eqz", ""],
  0x46: ["i32.eq", ""],
  0x47: ["i32.ne", ""],
  0x48: ["i32.lt_s", ""],
  0x49: ["i32.lt_u", ""],
  0x4a: ["i32.gt_s", ""],
  0x4b: ["i32.gt_u", ""],
  0x4c: ["i32.le_s", ""],
  0x4d: ["i32.le_u", ""],
  0x4e: ["i32.ge_s", ""],
  0x4f: ["i32.ge_u", ""],
  0x50: ["i64.eqz", ""],
  0x51: ["i64.eq", ""],
  0x52: ["i64.ne", ""],
  0x53: ["i64.lt_s", ""],
  0x54: ["i64.lt_u", ""],
  0x55: ["i64.gt_s", ""],
  0x56: ["i64.gt_u", ""],
  0x57: ["i64.le_s", ""],
  0x58: ["i64.le_u", ""],
  0x59: ["i64.ge_s", ""],
  0x5a: ["i64.ge_u", ""],
  0x5b: ["f32.eq", ""],
  0x5c: ["f32.ne", ""],
  0x5d: ["f32.lt", ""],
  0x5e: ["f32.gt", ""],
  0x5f: ["f32.le", ""],
  0x60: ["f32.ge", ""],
  0x61: ["f64.eq", ""],
  0x62: ["f64.ne", ""],
  0x63: ["f64.lt", ""],
  0x64: ["f64.gt", ""],
  0x65: ["f64.le", ""],
  0x66: ["f64.ge", ""],
  0x67: ["i32.clz", ""],
  0x68: ["i32.ctz", ""],
  0x69: ["i32.popcnt", ""],
  0x6a: ["i32.add", ""],
  0x6b: ["i32.sub", ""],
  0x6c: ["i32.mul", ""],
  0x6d: ["i32.div_s", ""],
  0x6e: ["i32.div_u", ""],
  0x6f: ["i32.rem_s", ""],
  0x70: ["i32.rem_u", ""],
  0x71: ["i32.and", ""],
  0x72: ["i32.or", ""],
  0x73: ["i32.xor", ""],
  0x74: ["i32.shl", ""],
  0x75: ["i32.shr_s", ""],
  0x76: ["i32.shr_u", ""],
  0x77: ["i32.rotl", ""],
  0x78: ["i32.rotr", ""],
  0x79: ["i64.clz", ""],
  0x7a: ["i64.ctz", ""],
  0x7b: ["i64.popcnt", ""],
  0x7c: ["i64.add", ""],
  0x7d: ["i64.sub", ""],
  0x7e: ["i64.mul", ""],
  0x7f: ["i64.div_s", ""],
  0x80: ["i64.div_u", ""],
  0x81: ["i64.rem_s", ""],
  0x82: ["i64.rem_u", ""],
  0x83: ["i64.and", ""],
  0x84: ["i64.or", ""],
  0x85: ["i64.xor", ""],
  0x86: ["i64.shl", ""],
  0x87: ["i64.shr_s", ""],
  0x88: ["i64.shr_u", ""],
  0x89: ["i64.rotl", ""],
  0x8a: ["i64.rotr", ""],
  0x8b: ["f32.abs", ""],
  0x8c: ["f32.neg", ""],
  0x8d: ["f32.ceil", ""],
  0x8e: ["f32.floor", ""],
  0x8f: ["f32.trunc", ""],
  0x90: ["f32.nearest", ""],
  0x91: ["f32.sqrt", ""],
  0x92: ["f32.add", ""],
  0x93: ["f32.sub", ""],
  0x94: ["f32.mul", ""],
  0x95: ["f32.div", ""],
  0x96: ["f32.min", ""],
  0x97: ["f32.max", ""],
  0x98: ["f32.copysign", ""],
  0x99: ["f64.abs", ""],
  0x9a: ["f64.neg", ""],
  0x9b: ["f64.ceil", ""],
  0x9c: ["f64.floor", ""],
  0x9d: ["f64.trunc", ""],
  0x9e: ["f64.nearest", ""],
  0x9f: ["f64.sqrt", ""],
  0xa0: ["f64.add", ""],
  0xa1: ["f64.sub", ""],
  0xa2: ["f64.mul", ""],
  0xa3: ["f64.div", ""],
  0xa4: ["f64.min", ""],
  0xa5: ["f64.max", ""],
  0xa6: ["f64.copysign", ""],
  0xa7: ["i32.wrap_i64", ""],
  0xa8: ["i32.trunc_f32_s", ""],
  0xa9: ["i32.trunc_f32_u", ""],
  0xaa: ["i32.trunc_f64_s", ""],
  0xab: ["i32.trunc_f64_u", ""],
  0xac: ["i64.extend_i32_s", ""],
  0xad: ["i64.extend_i32_u", ""],
  0xae: ["i64.trunc_f32_s", ""],
  0xaf: ["i64.trunc_f32_u", ""],
  0xb0: ["i64.trunc_f64_s", ""],
  0xb1: ["i64.trunc_f64_u", ""],
  0xb2: ["f32.convert_i32_s", ""],
  0xb3: ["f32.convert_i32_u", ""],
  0xb4: ["f32.convert_i64_s", ""],
  0xb5: ["f32.convert_i64_u", ""],
  0xb6: ["f32.demote_f64", ""],
  0xb7: ["f64.convert_i32_s", ""],
  0xb8: ["f64.convert_i32_u", ""],
  0xb9: ["f64.convert_i64_s", ""],
  0xba: ["f64.convert_i64_u", ""],
  0xbb: ["f64.promote_f32", ""],
  0xbc: ["i32.reinterpret_f32", ""],
  0xbd: ["i64.reinterpret_f64", ""],
  0xbe: ["f32.reinterpret_i32", ""],
  0xbf: ["f64.reinterpret_i64", ""],
  0xc0: ["i32.trunc_sat_f32_s", ""],
  0xc1: ["i32.trunc_sat_f32_u", ""],
  0xc2: ["i32.trunc_sat_f64_s", ""],
  0xc3: ["i32.trunc_sat_f64_u", ""],
  0xc4: ["i64.trunc_sat_f32_s", ""],
  0xc5: ["i64.trunc_sat_f32_u", ""],
  0xc6: ["i64.trunc_sat_f64_s", ""],
  0xc7: ["i64.trunc_sat_f64_u", ""],
};

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
  const style = rulesFor(request.language).style === "python" ? 1 : 0;
  const bytes = programModuleBytes(
    {
      functions: [
        { fn: request.fn, contract: request.contract },
        ...(request.functions ?? []).map((fn) => ({ fn })),
      ],
    },
    { candidate: request.candidate, style, optimize: request.optimize ?? true },
  );
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
  // The host is the runtime: it carries the implementations of the services the
  // module reached for, and nothing else, over the memory the module reads.
  await writeFile(
    request.hostPath,
    generateWasmHost(request.contract, { services: moduleServices(bytes), style }),
    "utf8",
  );
  return {
    runner: { command: process.execPath, args: [request.hostPath, request.modulePath] },
    modulePath: request.modulePath,
    hostPath: request.hostPath,
    moduleSizeBytes: (await stat(request.modulePath)).size,
  };
}

/**
 * Emits the module of a program, checks the boundary it has to keep, and writes
 * the host that runs it.
 *
 * The module holds every function of the program and the body it runs, and the
 * host calls the entry: the driver the C backend writes in C is the module's
 * own function here.
 */
export async function buildProgramModule(request: ProgramModuleRequest): Promise<ModuleResult> {
  const style = rulesFor(request.language).style === "python" ? 1 : 0;
  const bytes = programModuleBytes(
    { functions: request.functions, entry: request.entry },
    { candidate: request.candidate, style, optimize: request.optimize ?? true },
  );
  const detail = await inspect(request.modulePath, request.entry === undefined ? undefined : ENTRY_EXPORT, bytes);
  if (detail !== null) {
    throw new CompilerError({
      category: "TargetError",
      stage: "compile",
      message: "the WebAssembly module of the program violates the contract",
      detail: detail.slice(0, 2000),
      candidate: request.candidate,
    });
  }
  await writeFile(request.modulePath, bytes);
  // The host is the runtime: it carries the implementations of the services the
  // module reached for, and nothing else, over the memory the module reads.
  await writeFile(
    request.hostPath,
    generateWasmProgramHost({ services: moduleServices(bytes), style, entry: ENTRY_EXPORT }),
    "utf8",
  );
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
async function inspect(path: string, expected: string | undefined, bytes: Uint8Array): Promise<string | null> {
  const problems = boundaryProblems(bytes, expected);
  if (problems === null) {
    await writeFile(path, bytes);
    const inspection = run(process.execPath, ["--input-type=module", "-e", INSPECT_MODULE, path, expected ?? ""], { timeoutMs: 60_000 });
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


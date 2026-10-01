/**
 * Lowering a function's semantic IR to machine code.
 *
 * This backend writes the object itself. There is no C in between and no
 * assembler is asked: the IR is read, the instructions of the System V AMD64
 * convention are written out, and what comes out is a relocatable object the
 * linker puts beside the other objects of the program. The runtime, the harness
 * and the maths library are still C, and the object calls into them by the
 * symbols `runtime/abi.ts` names — the boundary is the one every backend keeps.
 *
 * No value is given a register of its own. Every value the body computes is
 * written to a slot in the frame, and the registers that carry a value between
 * two instructions are the accumulator and one scratch beside it: a whole number
 * or a reference in `rax` and `rcx`, a float in `xmm0` and `xmm1`. That is what
 * makes a register, an offset and an instruction the compiler's decision rather
 * than a model's, and it keeps the lowering readable beside the C one, which is
 * the reference for what the IR means.
 */

import { stat, writeFile } from "node:fs/promises";
import { CompilerError } from "../core/errors.ts";
import { run } from "../core/process.ts";
import { isRuntimeSymbol, RUNTIME_NAME } from "../runtime/abi.ts";
import { ARGV_LENGTH, BUILTINS } from "../semantics/builtins.ts";
import { parseType, symbolOf } from "../semantics/contract.ts";
import {
  elementTypeOf,
  hasCall,
  walkValues,
  isBoolean,
  isFloat,
  isNumber,
  isReference,
  isTextType,
  isUnsigned,
  slotType,
  typeEquals,
  valueKind,
  type CompareOp,
  type SemanticBlock,
  type SemanticCall,
  type SemanticFunction,
  type SemanticLoop,
  type SemanticStatement,
  type SemanticTerminator,
  type SemanticType,
  type SemanticValue,
} from "../core/semantic-ir.ts";
import type { FunctionContract, ObjectLayout, TargetSpec } from "../core/types.ts";
import { nameLiveness, overlaps } from "../semantics/liveness.ts";
import { describeObject, writeObject, type DataLabel } from "./elf64.ts";
import { NameScope } from "./names.ts";
import {
  Encoder,
  INTEGER_ARGUMENTS,
  R8,
  R9,
  R10,
  R11,
  R12,
  R13,
  R14,
  R15,
  RAX,
  RBX,
  RCX,
  RDI,
  RDX,
  RSI,
  RSP,
  SSE_ARGUMENTS,
  type Memory,
  type VectorSave,
  type Width,
  XMM0,
  XMM1,
  XMM2,
  XMM3,
  XMM4,
  XMM5,
  XMM6,
  XMM7,
  XMM8,
  XMM9,
  XMM10,
  XMM11,
  XMM12,
  XMM13,
  XMM14,
  XMM15,
  frame,
  indexed,
  mem,
} from "./x86.ts";

/* -------------------------------------------------------------------------- */
/* Types as the machine holds them                                              */
/* -------------------------------------------------------------------------- */

const NUMBER: SemanticType = { kind: "primitive", name: "f64" };
const USIZE: SemanticType = { kind: "primitive", name: "usize" };
const TEXT = { kind: "text" } as const;
const POINTER: SemanticType = { kind: "primitive", name: "usize" };

/**
 * The type a walk's index is held at. The IR does not name one: counting over
 * an array is a whole number whatever the elements are, and what the pinning
 * pass weighs here is the type of the register the counter is given, which is
 * this whenever the loop states no type of its own.
 */
const INDEX: SemanticType = { kind: "primitive", name: "u64" };

/** The C library a lowered function calls, which the linker resolves. */
const LIBRARY: Record<string, true> = {
  strlen: true,
  memcpy: true,
  strcmp: true,
  pow: true,
  fabs: true,
  floor: true,
  trunc: true,
};

/** The operator each compound assignment is, by the name the IR gives it. */
const COMPOUND: Record<string, "add" | "sub" | "mul" | "div" | "mod"> = {
  "+": "add",
  "-": "sub",
  "*": "mul",
  "/": "div",
  "%": "mod",
};

/**
 * The condition that fires when the one it names does not. A branch on a
 * comparison is written as the negation of the condition the comparison
 * holds under, because the flags a comparison leaves say what the
 * comparison *is*, and a branch is reached by the arm that is not the one the
 * comparison chose.
 */
const NEGATED: Record<"e" | "ne" | "l" | "le" | "g" | "ge" | "b" | "be" | "a" | "ae", "e" | "ne" | "l" | "le" | "g" | "ge" | "b" | "be" | "a" | "ae"> = {
  e: "ne",
  ne: "e",
  l: "ge",
  le: "g",
  g: "le",
  ge: "l",
  b: "ae",
  be: "a",
  a: "be",
  ae: "b",
};

/**
 * The condition a comparison of two whole numbers holds under, by whether
 * the language reads the numbers as signed. A comparison is carried out at
 * the width the language promotes it to, so the two sides are already
 * widened the way the conditions below expect them to be.
 */
const COMPARISON: Record<"signed" | "unsigned", Record<CompareOp, "e" | "ne" | "l" | "le" | "g" | "ge" | "b" | "be" | "a" | "ae">> = {
  signed: { eq: "e", ne: "ne", lt: "l", le: "le", gt: "g", ge: "ge" },
  unsigned: { eq: "e", ne: "ne", lt: "b", le: "be", gt: "a", ge: "ae" },
};

/**
 * The operations the machine writes with the number in the instruction rather
 * than in a register. A division and a remainder are the two it does not: the
 * machine divides a register by a register, and a literal is not one.
 */
const IMMEDIATE_OPERATIONS: Record<string, true> = {
  add: true,
  sub: true,
  mul: true,
  shl: true,
  shr: true,
  ushr: true,
  sar: true,
  and: true,
  or: true,
  xor: true,
};

/**
 * The whole-number registers a callee leaves as it found them, which are the
 * ones a value that never changes can be kept in across a call. Four is what
 * this backend uses of the five the convention has: rbx, r12, r13 and r14.
 *
 * The fifth, r15, is the register an object being filled lives in for the
 * duration of the statement that fills it. It is not taken from the list of
 * values a function can pin because it is already spoken for, and it is the
 * right register for the job: it survives the calls a field value makes, which
 * is the whole reason the object pointer cannot live in the scratch register
 * every other part of the lowering uses.
 */
const CALLEE_SAVED: readonly number[] = [RBX, R12, R13, R14];

/**
 * The register an object allocated and filled as one value is held in across
 * the field stores, which is what stops it being written to the frame and read
 * back for every field that is a call.
 *
 * A call takes the scratch register — it is the fourth argument register — so
 * an object pointer kept there has to be written down before a field that calls
 * and read back after it, which is a store and a load per call-valued field. A
 * register the convention says a callee leaves as it found them needs neither.
 */
const OBJECT_POINTER = R15;


/**
 * The vector registers a callee leaves as it found them, which are the ones a
 * float that never changes can be kept in across a call.
 *
 * Ten is what the convention has: xmm6 to xmm15. They are a register file of
 * their own, so a float pinned here costs nothing a whole number pinned in
 * `CALLEE_SAVED` would: the two lists are filled independently and neither
 * takes a register the other wanted. A float left in the frame instead costs a
 * load on every read and a store on every write, and a loop whose bound and
 * step are floats reads both on every turn.
 *
 * The first two of them are also argument registers. A callee that is handed
 * seven or eight floats has to save them before it writes to them and restore
 * them before it returns, so a value kept in one here survives the call the
 * same way a value kept in rbx does.
 */
const VECTOR_CALLEE_SAVED: readonly number[] = [XMM6, XMM7, XMM8, XMM9, XMM10, XMM11, XMM12, XMM13, XMM14, XMM15];

/**
 * The whole-number registers the convention does not ask a callee to preserve,
 * which are the ones a value that no call reaches can be kept in for nothing.
 *
 * A callee-saved register costs the function a push and a pop and sixteen bytes
 * of stack, and buys the same thing a caller-saved one buys for free over the
 * stretch of the body where nothing calls: the value is in a register rather
 * than in the frame. A name that has to survive a call cannot be kept in one
 * of these — the call writes its arguments into them — so the two lists answer
 * different questions and a name is given the one its live range fits.
 *
 * `rax` is the accumulator and `rcx` the scratch, which every value the body
 * computes passes through, and `rdx` is what a division and a one-byte write
 * go through, so none of the three is a place a name can be kept.
 */
const CALLER_SAVED: readonly number[] = [RDI, RSI, R8, R9, R10, R11];

/**
 * The vector registers the convention does not ask a callee to preserve, which
 * answer the same question as `CALLER_SAVED` does for a whole number.
 *
 * `xmm0` is the accumulator and `xmm1` the scratch, so the four left are the
 * ones a name can be kept in. They are also the fourth to eighth of the
 * argument registers, which is the same fact as for the whole numbers: a value
 * kept here does not survive the call that writes them.
 */
const VECTOR_CALLER_SAVED: readonly number[] = [XMM2, XMM3, XMM4, XMM5];

/**
 * How often a name has to be read before it is worth a register of its own.
 *
 * Keeping one costs a push and a read back, which is five bytes against the
 * one a read saves by not reaching into the frame — so a name read a few times
 * is a few bytes larger for the same work. It buys a load retired on every
 * read rather than a smaller object, and the frame it frees is one the next
 * binding takes anyway.
 */
const PINNING_READS = 4;

/**
 * What a read is worth by the number of loops it is nested in: the first entry
 * is a read on a path nothing repeats, the second one inside a loop, the third
 * inside a loop inside a loop, and the last for anything deeper.
 *
 * It is a doubling rather than the turn count of the loop, which is not known
 * here and is not the point: what says a read is hot is that the block holding
 * it is carried out again, and how much again grows with how many loops are
 * around it. The list stops at eight because the difference between a hundred
 * turns of a loop and a thousand changes which name is pinned first not at all,
 * and a name pinned on a turn count it cannot be held to is a name pinned for
 * the wrong reason.
 */
const READ_WEIGHT: readonly number[] = [1, 2, 4, 8];

/**
 * The operations the machine carries out with a literal reached in the
 * instruction rather than a register beside it. A minimum, a maximum, a power
 * and a remainder are not among them: each has its own form, and each of those
 * forms reads two registers.
 */
const FLOAT_OPERATION: Record<string, true> = { add: true, sub: true, mul: true, div: true };

/** The maths builtin each source name is one call of, by the name C gives it. */
const MATH_LIBRARY: Record<string, string> = {
  "Math.abs": "fabs",
  "Math.sqrt": "sqrt",
  "Math.floor": "floor",
  "Math.trunc": "trunc",
};

/** How wide a value of this type is, which is the width a slot holds it at. */
function widthOf(type: SemanticType): Width {
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

/** Whether a whole number of this type is read as signed. */
function signedOf(type: SemanticType): boolean {
  if (type.kind !== "primitive") return true;
  return isUnsigned(type) ? false : true;
}

/**
 * Which shift a shift right is written as. `>>` keeps the sign of a signed
 * number and `>>>` never does, so a shift right is the arithmetic one over a
 * signed number and the logical one over everything else.
 */
function shiftOf(operation: "shl" | "shr" | "ushr" | "sar", type: SemanticType): "shl" | "shr" | "sar" {
  if (operation === "ushr") return "shr";
  if (operation === "shr" && signedOf(type)) return "sar";
  return operation;
}

/**
 * The width an operation on whole numbers is carried out at. A C compiler
 * promotes anything narrower than an `int` to one and carries a shift and a
 * remainder out where it promoted it, so these are the widths an operation here
 * has to use for the same answers.
 */
function operationWidth(type: SemanticType): 4 | 8 {
  return widthOf(type) === 8 ? 8 : 4;
}

function machineError(message: string, detail?: string, functionName?: string): CompilerError {
  return new CompilerError({ category: "AssemblyError", stage: "assemble", message, function: functionName, detail });
}

/* -------------------------------------------------------------------------- */
/* The build                                                                    */
/* -------------------------------------------------------------------------- */

export interface MachineRequest {
  /** The function as the IR holds it, already validated against its contract. */
  fn: SemanticFunction;
  contract: FunctionContract;
  target: TargetSpec;
  /**
   * The symbols of the other functions of the program. An object may call one,
   * because the linker puts the objects beside each other; a symbol outside the
   * runtime, the C library and these is a reference nothing will resolve.
   */
  callable: ReadonlySet<string>;
  /** Where the object is written. */
  objectPath: string;
  candidate?: string;
}

export interface MachineResult {
  objectPath: string;
  objectSizeBytes: number;
  /** The bytes of code, which is what a size objective weighs. */
  textSizeBytes: number;
}

/**
 * The target this backend encodes for. It writes the instructions of one
 * machine, so a target naming another is refused here rather than answered with
 * code no processor of that machine reads.
 *
 * A target that names a processor of that machine is answered rather than
 * refused: what is written is the instruction set every one of them runs, so the
 * code is right for the processor asked for and leaves its extensions alone.
 * That is a question of speed, not of what the program computes.
 */
export function assertMachineTarget(target: TargetSpec): void {
  if (target.arch === "x86_64" && target.abi === "sysv") return;
  throw new CompilerError({
    category: "TargetError",
    stage: "assemble",
    message: `the machine backend cannot build for ${target.arch}-${target.os}-${target.abi}`,
    detail: "it writes x86-64 System V code itself; build with --backend c for another target",
  });
}

/**
 * The object of one function, written and checked.
 *
 * The check is the one every backend owes the program it is linked into: the
 * object defines exactly the symbol the function is called by, and every symbol
 * it refers to is one the runtime, the C library or another function of the
 * program provides. Anything else would be a link failure found after a model
 * had been asked what to do about it.
 */
export async function buildObject(request: MachineRequest): Promise<MachineResult> {
  assertMachineTarget(request.target);
  const functionName = symbolOf(request.contract);
  const object = lowerFunction(request.fn, request.contract, functionName, request.callable);
  await writeFile(request.objectPath, object.bytes);
  const written = inspectWrittenObject(request.objectPath, functionName);
  if (written.defined.length !== 1 || written.defined[0] !== functionName) {
    throw machineError(
      `the object of ${functionName} defines [${written.defined.join(", ")}] instead of only "${functionName}"`,
      "the program links the objects beside each other and calls this one by that name",
      functionName,
    );
  }
  const outside = written.undefined.filter(
    (symbol) => !isRuntimeSymbol(symbol) && LIBRARY[symbol] !== true && !request.callable.has(symbol),
  );
  if (outside.length > 0) {
    throw machineError(
      `${functionName} refers to symbols outside the runtime ABI and the C library: ${outside.join(", ")}`,
      undefined,
      functionName,
    );
  }
  return {
    objectPath: request.objectPath,
    objectSizeBytes: (await stat(request.objectPath)).size,
    textSizeBytes: object.textSizeBytes,
  };
}

/**
 * Every block of a body with how many loops it is nested in, itself included.
 *
 * The depth is what a census over the whole function weighs a read by: a read
 * in a block two loops deep is carried out once for every turn of both of them,
 * and a read at the top of the body is carried out once whatever the loops turn.
 * Counting them alike says a value read once per turn of a hot loop is worth
 * the same as one read once in the whole run, which is the difference between
 * the two being in a register.
 */
function everyBlockAtDepth(
  block: SemanticBlock,
  depth = 0,
  into: { block: SemanticBlock; depth: number }[] = [],
): { block: SemanticBlock; depth: number }[] {
  into.push({ block, depth });
  for (const statement of block.statements) {
    if (statement.k === "if") {
      everyBlockAtDepth(statement.then, depth, into);
      if (statement.otherwise !== null) everyBlockAtDepth(statement.otherwise, depth, into);
    } else if (statement.k === "loop") everyBlockAtDepth(statement.loop.body, depth + 1, into);
    else if (statement.k === "block") everyBlockAtDepth(statement.body, depth, into);
  }
  return into;
}

/**
 * A counted loop that adds up what two arrays hold element by element, which is
 * the one loop shape this backend does with a whole vector of doubles at a time.
 *
 * `total += a[i] * b[i]` over `i` is the dot product, and it is the shape every
 * numeric kernel over a typed array is written as. It is also the one loop whose
 * arithmetic is a serial dependency: every turn adds into the value the turn
 * before it left, so the sum takes as long as the array is long however fast the
 * multiplication beside it retires. Writing the loop out into copies of its body
 * did not shorten that chain, and measured slower. A vector accumulator is a
 * different chain — one add per two elements, two lanes deep — and that is the
 * whole of what this buys.
 */
interface PackedDot {
  /** The counter the loop counts on, which is what both arrays are read at. */
  readonly counter: string;
  /** The name the products are added into, and the value the loop answers. */
  readonly accumulator: string;
  /** The name of the array read on the left of the product, and on the right. */
  readonly left: string;
  readonly right: string;
  /** The element the counter starts at, which is a whole number written out. */
  readonly from: number;
  /** The value the counter is compared against on every turn. */
  readonly bound: SemanticValue;
}

/** The whole number a `const` writes, or null where it is not one. */
function wholeConst(value: SemanticValue): number | null {
  if (value.k !== "const") return null;
  if (!/^-?[0-9]+$/.test(value.text)) return null;
  const read = Number(value.text);
  return Number.isSafeInteger(read) ? read : null;
}

/**
 * Whether a counted loop is a `PackedDot`, and which one it is.
 *
 * Every condition here is a refusal rather than a promise. The loop has to count
 * up by one from a whole number written out; its body has to be one statement
 * that adds a product of two element reads at the counter into a name, and it
 * has to hold nothing — a body that breaks out of the loop, continues it,
 * declares a name or writes the counter is one whose turns cannot be folded into
 * pairs. The product has to be a product: a loop that sums the difference of two
 * arrays, or divides them, is one the arithmetic below would compute wrongly
 * rather than slowly.
 *
 * The counter is usually a float, because the frontend gives a loop counter the
 * type of the numbers around it. That does not stop a turn being paired with the
 * next one: the pairing is decided by whole numbers of bytes, and every element
 * the counter names is one turn apart, so the same elements are read in the
 * same order as the scalar loop read them in.
 */
function packedDotOf(loop: SemanticLoop): PackedDot | null {
  if (loop.kind !== "counted") return null;
  if (loop.inclusive || loop.down || loop.step !== null) return null;
  if (loop.body.statements.length !== 1) return null;
  if (loop.body.releases.length > 0 || loop.body.terminator.k !== "next") return null;
  const statement = loop.body.statements[0];
  if (statement.k !== "set" || statement.op !== "+=") return null;
  if (statement.name === loop.variable) return null;
  const product = statement.value;
  if (product.k !== "arith" || product.op !== "mul") return null;
  const left = readOf(product.left, loop.variable);
  const right = readOf(product.right, loop.variable);
  if (left === null || right === null) return null;
  if (left.element !== "f64" || right.element !== "f64") return null;
  if (left.of === right.of) return null;
  const from = wholeConst(loop.from);
  // A negative start makes the byte cursor a negative number of bytes, which the
  // shift that turns it back into an index would read as a very large one.
  if (from === null || from < 0) return null;
  // A bound that is the accumulator or the counter is a value the turns change,
  // and one read before the loop would be read once where the loop reads it
  // again.
  if (namesIn(loop.to).some((name) => name === statement.name || name === loop.variable)) return null;
  return {
    counter: loop.variable,
    accumulator: statement.name,
    left: left.of,
    right: right.of,
    from,
    bound: loop.to,
  };
}

/**
 * One side of a product that reads one element of an array of doubles at the
 * loop's own counter, or null where it is anything else.
 */
function readOf(
  value: SemanticValue,
  counter: string,
): { readonly of: string; readonly element: string } | null {
  if (value.k !== "element" || value.of.k !== "local") return null;
  if (value.index.k !== "local" || value.index.name !== counter) return null;
  if (value.type.kind !== "primitive") return null;
  return { of: value.of.name, element: value.type.name };
}

/** The names a value reads. */
function namesIn(value: SemanticValue): string[] {
  const found: string[] = [];
  walkValues(value, (one) => {
    if (one.k === "local") found.push(one.name);
  });
  return found;
}

/* -------------------------------------------------------------------------- */
/* Packed sum: the independent part of a loop turn, a vector at a time        */
/* -------------------------------------------------------------------------- */

/**
 * A counted loop whose one turn adds into a name a value the counter decides,
 * where that value can be computed for a pair of counters at once.
 *
 * This is `PackedDot` for the loops a dot product is not. A dot product folds
 * the whole of its turn into a vector accumulator and therefore reorders the
 * additions, which is only sound because the IR says nothing about the order
 * the sum is taken in. Here the addition stays exactly where the source wrote
 * it — one `addsd` per turn, in the order the turns came — and only the
 * arithmetic *underneath* it is done two counters at a time, because that part
 * reads nothing the addition writes.
 */
interface PackedSum {
  /** The counter the loop counts on, which the value under the addition reads. */
  readonly counter: string;
  /** The name the products are added into, and the value the loop answers. */
  readonly accumulator: string;
  /** What is added each turn: a function of the counter and of nothing written. */
  readonly added: SemanticValue;
  /** The element the counter starts at, which is a whole number written out. */
  readonly from: number;
  /** The value the counter is compared against on every turn. */
  readonly bound: SemanticValue;
  /**
   * The arrays the value reads elements of, in the order it first reads each.
   *
   * Every one of them is read at the counter, so a pair of turns reads a pair of
   * elements of each that stand beside each other — one load of sixteen bytes
   * apiece. Each is therefore given a register of its own to hold the first
   * element, since the loads are written against different bases and there is
   * no one register that addresses all of them.
   */
  readonly arrays: readonly string[];
}

/**
 * Whether a counted loop is a `PackedSum`, and which one it is.
 *
 * Every condition here is a refusal rather than a promise, and they are the
 * same ones `packedDotOf` refuses on: the loop has to count up by one from a
 * whole number written out, and its body has to be one statement that adds into
 * a name and holds nothing else. What is added must be a function of the
 * counter alone — a value that reads the name it is added into is one whose
 * lanes are not two turns of the same computation, and one that calls is one
 * this backend will not run twice to answer one turn.
 */
function packedSumOf(loop: SemanticLoop): PackedSum | null {
  if (loop.kind !== "counted") return null;
  if (loop.inclusive || loop.down || loop.step !== null) return null;
  if (loop.body.statements.length !== 1) return null;
  if (loop.body.releases.length > 0 || loop.body.terminator.k !== "next") return null;
  const statement = loop.body.statements[0];
  if (statement.k !== "set" || statement.op !== "+=") return null;
  if (statement.name === loop.variable) return null;
  const from = wholeConst(loop.from);
  if (from === null || from < 0) return null;
  if (namesIn(loop.to).some((name) => name === statement.name || name === loop.variable)) return null;
  const census = new Census(statement.value, loop.variable, statement.name);
  if (census.calls || !census.packable) return null;
  return {
    counter: loop.variable,
    accumulator: statement.name,
    added: statement.value,
    from,
    bound: loop.to,
    arrays: census.arrays,
  };
}

/**
 * The registers one turn of a packed sum is written with: where the pair of
 * counters it is for stands, how far along the arrays it reads has come, and
 * which register holds the first element of each of them.
 *
 * These are the loop's own, gathered once so that every value under the addition
 * is written against the same registers rather than each being handed its own
 * copy of them.
 */
interface PackedTurn {
  /** The register holding the pair of counters this turn is for, one in each lane. */
  readonly counter: number;
  /** The name that pair is of, which is the loop's own counter. */
  readonly counterName: string;
  /** The register holding how many bytes of the arrays the pairs have read. */
  readonly cursor: number;
  /** The arrays a turn reads, in the order the census first read each. */
  readonly arrays: readonly string[];
  /** The register holding the first element of each, in the same order. */
  readonly bases: readonly number[];
}

/**
 * How deep the right side of an operation may be built.
 *
 * Three registers carry the work, and the right side is built with the register
 * the left side is standing in as its third. Two operations deep is what that
 * affords: at the third the register the left is in is wanted by something the
 * right is still holding, and there is no fourth register to spill it to.
 */
const PACKED_RIGHT_DEPTH = 2;

/**
 * Whether a value is a tree of operations no deeper than `PACKED_RIGHT_DEPTH`,
 * which is what the register discipline in `packedValue` can build while the
 * register its neighbour is standing in is the one it borrows.
 */
function shallow(value: SemanticValue, depth = PACKED_RIGHT_DEPTH): boolean {
  if (value.k !== "arith") return true;
  if (depth === 0) return false;
  return shallow(value.left, depth - 1) && shallow(value.right, depth - 1);
}

/**
 * What a value reads that a packed turn cannot carry: whether any of it calls,
 * whether it can be computed a lane at a time, and which arrays it reads.
 *
 * The two refusals that matter are the ones that would change the number the
 * program answers rather than the speed it answers it at, and each of them is
 * stated in the place that makes it.
 */
class Census {
  /** Whether anything under the addition calls, which a lane cannot do once. */
  calls = false;
  /** Whether every operation in the value has a packed form of the same value. */
  packable = true;
  /** The arrays the value reads elements of, which a pair load reads beside. */
  readonly arrays: string[] = [];

  /** The counter the value under the addition reads, which is the loop's own. */
  readonly counter: string;

  /** The name the value is added into, which no lane may read. */
  readonly accumulator: string;

  constructor(value: SemanticValue, counter: string, accumulator: string) {
    this.counter = counter;
    this.accumulator = accumulator;
    walkValues(value, (one) => {
      if (one.k === "call" || one.k === "newObject") this.calls = true;
      if (!this.fits(one)) this.packable = false;
    });
  }

  /** Whether one value under the addition has a packed form of itself. */
  private fits(value: SemanticValue): boolean {
    switch (value.k) {
      case "const":
        // A literal is the same number in both lanes, which is what a pair of
        // copies of it is.
        return isFloat(value.type);
      case "local":
        // The counter is the pair itself. Any other name is loop-invariant,
        // because a counted loop here writes nothing but its counter and the
        // name it adds into, and the name it adds into is refused above.
        //
        // No test is made here of what type the name has: the array a lane
        // reads its two elements out of is reached through one of these, and it
        // is not a double. What a name is read *as* is settled where it is
        // used, by the sides of the operation around it having to be at that
        // operation's own type.
        return value.name !== this.accumulator;
      case "element":
        return this.fitsElement(value);
      case "arith":
        return this.fitsArithmetic(value);
      default:
        // A field, a length, a piece of text, a cast: none of them is a number
        // a lane can be handed, and each would have to be computed twice for
        // the two lanes that are wanted from it.
        return false;
    }
  }

  /**
   * An element read at the counter, of a whole double.
   *
   * Two turns read two doubles that stand beside each other, which is one
   * sixteen-byte load and not two eight-byte ones. That is only true of a
   * double: a narrower element is two or four to a register, so the pair the
   * instruction would read is not the pair the loop wants.
   */
  private fitsElement(value: SemanticValue & { k: "element" }): boolean {
    if (value.of.k !== "local") return false;
    if (value.index.k !== "local" || value.index.name !== this.counter) return false;
    if (value.type.kind !== "primitive" || value.type.name !== "f64") return false;
    if (!this.arrays.includes(value.of.name)) this.arrays.push(value.of.name);
    return true;
  }

  /**
   * An operation, and the whole of what it refuses.
   *
   * A packed instruction and the scalar one it stands for have to be the same
   * computation on every input, not on the ones a test happens to try. Four
   * families are refused here because that is not true of them.
   *
   * **Floating point arithmetic** — add, subtract, multiply, divide — is
   * allowed, and is the same number: each lane is the same IEEE-754 operation
   * on the same operands at the same rounding mode, and a packed
   * instruction raises its exceptions on a lane without touching its
   * neighbour. What makes this a multiply and *not* a fused multiply-add is
   * that SSE2 has no fused form: the two are written as two instructions and
   * rounded twice, exactly as the scalar pair is. Were a fused form added, this
   * would have to refuse multiplication feeding an addition, because it rounds
   * once where the loop rounds twice.
   *
   * **Integer arithmetic** is refused outright, for a reason that is about this
   * backend rather than about the mathematics: every packed instruction the
   * emitter below writes is a double one, so a whole number carried in a lane
   * would be a whole number carried as a double, and a loop that adds one would
   * be handed the answer to a different loop. A packed integer form is a thing
   * to add with the encoder, not one to admit ahead of it.
   *
   * Were there one, a sum and a difference would be the only safe operations.
   * A packed sum wraps each lane at the width of the type, which is what a
   * scalar sum wraps at, so overflow would be per lane and would agree. A
   * product would not: SSE2 has no packed multiply at these widths (`PMULLD` is
   * SSE4.1 and `PMULLQ` is AVX-512), and every packed form that does exist
   * computes a wider answer than the scalar one truncates to — an overflow the
   * two would not agree on. A quotient has no packed integer divide to agree
   * with at all.
   *
   * **Shifts** are refused. A packed shift takes its count at five bits for a
   * double-word lane and six for a quad-word one, where the scalar shift masks
   * it at thirty-one or sixty-three — the width of the type. The two agree for
   * every count a program would write below the width and disagree at the top
   * of it, which is a difference the language would see.
   *
   * **Conversions** are refused, and this is the one that keeps this loop the
   * shape it is written. The scalar conversion of a float to a whole number
   * branches on the range for an unsigned target and answers the value the
   * language means; the packed conversion (`CVTTPD2DQ`) has no such branch and
   * answers one indefinite value instead, so the two agree on a signed target
   * inside its range and on nothing else. The other direction is refused
   * because widening two thirty-two bit values to two doubles moves them, and
   * narrowing a double to a single leaves one lane where the scalar form has
   * one value: which lane a value lands in is not something this may decide.
   */
  private fitsArithmetic(value: SemanticValue & { k: "arith" }): boolean {
    // A double, and one of the four operations a double pair has. Every packed
    // instruction written below reads its lanes as doubles, so a lane of any
    // other type is a lane carrying a different number than the one written.
    if (!isFloat(value.type)) return false;
    if (value.op !== "add" && value.op !== "sub" && value.op !== "mul" && value.op !== "div") return false;
    // Every side at the type of the answer, so that a lane is one value of that
    // type rather than one of some other width the pair load did not bring. This
    // is also what refuses a whole number read where a double is: the two sides
    // are not at the answer's type, and reading one is the conversion the rule
    // above refuses.
    if (!typeEquals(value.left.type, value.type)) return false;
    if (!typeEquals(value.right.type, value.type)) return false;
    // The right side is built with the register the left side is standing in as
    // its third, which is why its height is bounded and the left side's is not:
    // the left is finished with before the right begins, so nothing is lost by
    // the right writing over it, while the right is built across it.
    return shallow(value.right);
  }
}

/**
 * Every block of a body, itself included, which is what a read census over the
 * whole function is taken across.
 */
function everyBlock(block: SemanticBlock, into: SemanticBlock[] = []): SemanticBlock[] {
  for (const entry of everyBlockAtDepth(block)) into.push(entry.block);
  return into;
}


/**
 * Every value a block computes in its own right, nested blocks included, and
 * every value inside those. It is the whole of what the body reads, which is
 * what a value is a candidate to be kept in a register by.
 */
function everyValue(block: SemanticBlock, into: SemanticValue[] = []): SemanticValue[] {
  const add = (value: SemanticValue | null): void => {
    if (value === null) return;
    into.push(value);
    walkValues(value, (one) => into.push(one));
  };
  for (const statement of block.statements) {
    switch (statement.k) {
      case "let":
      case "set":
      case "printText":
      case "printNumber":
      case "retain":
      case "storeField": add(statement.value); break;
      case "setElement": add(statement.index); add(statement.value); break;
      case "if": add(statement.condition); break;
      case "raise": add(statement.message); break;
      case "call": add({ k: "call", type: statement.call.returns, call: statement.call }); break;
      case "loop": {
        const loop = statement.loop;
        if (loop.kind === "counted") { add(loop.from); add(loop.to); add(loop.step); }
        else if (loop.kind === "each") add(loop.length);
        else add(loop.condition);
        for (const nested of everyBlock(loop.body)) everyValue(nested, into);
        break;
      }
      default: break;
    }
  }
  if (block.terminator.k === "return") add(block.terminator.value);
  return into;
}
/** The object a function's machine code is, and the code it carries. */
function lowerFunction(
  fn: SemanticFunction,
  contract: FunctionContract,
  functionName: string,
  callable: ReadonlySet<string>,
): { bytes: Uint8Array; textSizeBytes: number } {
  const machine = new Machine(fn, contract);
  const text = machine.emit();
  for (const symbol of machine.externals) {
    if (isRuntimeSymbol(symbol) || LIBRARY[symbol] === true || symbol === functionName || callable.has(symbol)) continue;
    throw machineError(
      `${functionName} refers to ${symbol}, which is neither the runtime, the C library, nor a function of this program`,
      undefined,
      functionName,
    );
  }
  return {
    bytes: writeObject({
      text,
      rodata: Uint8Array.from(machine.rodata),
      function: { name: fn.symbol, offset: 0, size: text.length },
      labels: machine.labels,
      undefined: machine.externals,
      relocations: machine.code.relocations,
    }).bytes,
    textSizeBytes: text.length,
  };
}


/**
 * The register the last argument of a call that spills nothing is taken in.
 *
 * Nothing spills, so every argument before it took a register of its own class
 * and the count of each is that argument's index among the arguments of its
 * class.
 */
function lastArgumentRegister(types: readonly SemanticType[], last: number): number {
  let floating = 0;
  for (const type of types.slice(0, last)) if (isFloat(type)) floating += 1;
  const type = types[last] as SemanticType;
  return isFloat(type) ? (SSE_ARGUMENTS[floating] as number) : (INTEGER_ARGUMENTS[last - floating] as number);
}

/**
 * The argument at which a call runs out of registers, or the number of
 * arguments when it does not.
 *
 * The convention gives every argument a register until a class runs out, and
 * the first argument with no register is on the stack with every argument after
 * it, whichever class those are. A caller asks this before it writes its
 * arguments down, because the ones that go on the stack are written out before
 * the registers are read and writing them out goes through the very register
 * an argument left in the accumulator is in.
 */
function firstArgumentOnStack(types: readonly SemanticType[]): number {
  let general = 0;
  let floating = 0;
  for (const [at, type] of types.entries()) {
    if (isFloat(type) ? floating >= SSE_ARGUMENTS.length : general >= INTEGER_ARGUMENTS.length) return at;
    if (isFloat(type)) floating += 1;
    else general += 1;
  }
  return types.length;
}

/** What the linker sees in the object that was written. */
function inspectWrittenObject(objectPath: string, functionName: string): { defined: string[]; undefined: string[] } {
  const definedResult = run("nm", ["--defined-only", "--extern-only", objectPath], { timeoutMs: 30_000 });
  const undefinedResult = run("nm", ["--undefined-only", objectPath], { timeoutMs: 30_000 });
  if (definedResult.code !== 0 || undefinedResult.code !== 0) {
    throw machineError(
      `cannot inspect the object of ${functionName}`,
      `${definedResult.stderr}${undefinedResult.stderr}`.trim(),
      functionName,
    );
  }
  const symbolNames = (result: typeof definedResult): string[] =>
    result.stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/).pop() ?? "")
      .filter((symbol) => symbol !== "");
  return { defined: symbolNames(definedResult), undefined: symbolNames(undefinedResult) };
}

/* -------------------------------------------------------------------------- */
/* The lowering                                                                 */
/* -------------------------------------------------------------------------- */

/** What a whole number may be combined with, and how. */
type Arithmetic = "add" | "sub" | "mul" | "div" | "mod" | "shl" | "shr" | "ushr" | "sar" | "and" | "or" | "xor";

/**
 * The labels one loop's header and its exit are written under, and the ids the
 * IR named them by. The ids are what a `break` and a `continue` name; the
 * labels are what a jump is written to, and they are the lowering's own because
 * one block id can stand for more than one place in the code — a loop that sits
 * in the entry block leaves for that block, and so does the next loop after it.
 */
interface LoopLabels {
  readonly header: string;
  readonly exit: string;
  readonly names: { readonly header: string; readonly exit: string };
}

/** A value the lowering keeps in the frame while it builds another. */
interface Held {
  /** Where in the frame it is: a distance up from the bottom of it. */
  readonly offset: number;
  readonly type: SemanticType;
  /**
   * The register a value that never changes lives in, or null where it lives in
   * the frame. A name that is written once and read after is in a register that
   * a call cannot take, so a read of it is a move and a frame is not reserved
   * for it at all.
   */
  readonly register: number | null;
}

class Machine {
  readonly code = new Encoder();
  readonly rodata: number[] = [];
  /** A literal already laid down, so one string is written to the object once. */
  private readonly literals = new Map<string, string>();
  /** A float already laid down, so one constant is written to the object once. */
  private readonly floatLabels = new Map<string, string>();
  readonly labels: DataLabel[] = [];
  /** The symbols the code calls or reads that this object does not define. */
  readonly externals: string[] = [];

  private readonly names = new NameScope((name) => name);
  private readonly slots = new Map<string, Held>();
  private readonly loops: { header: string; exit: string; names: { header: string; exit: string } }[] = [];
  private readonly layouts: Record<string, ObjectLayout>;
  private readonly epilogue = this.code.label("Lepilogue");
  /** How many labels the lowering has minted, one pair per loop. */
  private mintedLabels = 0;
  /**
   * The labels a loop's header and its exit are written under.
   *
   * The IR names both by the id of the block they belong to, and a loop whose
   * exit is the block around it names the very block the function starts in:
   * two `for` loops one after another both leave for `entry`. Binding that id
   * twice makes the second binding the one every jump resolves to, so the first
   * loop's exit jumps past the second loop to the end of the function. A label
   * the lowering mints is named once and means one place.
   */
  private loopLabels(loop: SemanticLoop): LoopLabels {
    const at = this.mintedLabels++;
    const header = `Lhead${at}`;
    const exit = `Lexit${at}`;
    return { header, exit, names: { header: loop.header, exit: loop.exit } };
  }
  private used = 0;
  private temporaries = 0;
  /** Slots bound for the statements being written and not yet handed back. */
  private readonly borrowed: Held[] = [];
  /** Slots handed back, which the next statement that needs one takes. */
  private readonly spareSlots: number[] = [];
  /** The register a name that never changes is in, by the name it is declared as. */
  private readonly pinned = new Map<string, number>();
  /** The registers the prologue pushes and the epilogue reads back, in that order. */
  private pinnedRegisters: number[] = [];
  /** The vector registers spilled to the frame by the prologue and read back by the epilogue. */
  private pinnedVectors: VectorSave[] = [];
  /** The register an object being filled lives in, when this function fills one. */
  private objectRegister: number | null = null;
  /** Whether the body calls anything, which is what the frame's size answers for. */
  private mayCall = false;
  /** The arguments that arrived on the stack, and where each one's address is written. */
  private readonly incoming: { index: number; at: number }[] = [];
  /**
   * The slot whose value the accumulator holds, and where the code stood when
   * it last did — which is what `load` reads, and what nothing else may.
   */
  private accumulator: { offset: number; at: number } | null = null;

  /**
   * Whether this function allocates an object or writes an array out, which is
   * what the register above is for.
   *
   * A function that never builds one has no use for the register, and taking it
   * anyway would cost every such function a push and a pop for nothing — which
   * is the whole of what a name being pinned costs, so a program of small
   * functions would pay for a change that helps only the few that allocate.
   */
  private fillsObjects(): boolean {
    for (const block of everyBlock(this.fn.entry)) {
      for (const value of everyValue(block)) {
        if (value.k === "newObject" || value.k === "buffer") return true;
      }
    }
    return false;
  }
  private lastLiteral = "";

  private readonly fn: SemanticFunction;

  constructor(fn: SemanticFunction, contract: FunctionContract) {
    this.fn = fn;
    // A layout the program lays out is in the function; one only the contract
    // states is the contract's, and both are the same struct to every reader.
    this.layouts = { ...contract.definition.objects, ...fn.objects };
  }

  /* ---------------------------------------------------------------------- */
  /* The frame                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Room in the frame for `bytes`, and where in the frame it is: a distance up
   * from the bottom of it, which is where the prologue left the stack pointer.
   *
   * A slot's address is settled here rather than at the end of the body,
   * because the frame grows upwards from a stack pointer the prologue has
   * already moved: a slot reserved now keeps the address it is given however
   * much the frame grows around it afterwards. That is what the body and the
   * epilogue are both written against, and it is why the frame's own size is
   * the one number in a prologue that has to be left a field for.
   */
  private reserve(bytes: number, alignment = 8): number {
    this.used = Math.ceil((this.used + bytes) / alignment) * alignment;
    return this.used - bytes;
  }

  private bind(name: string, type: SemanticType): Held {
    const emitted = this.names.declare(name, type);
    const register = this.pinned.get(emitted) ?? null;
    // A pinned value is in a register and never in the frame, so the frame slot
    // that reads and writes go through is not reserved: its distance is zero,
    // which is the first slot's own address, and it is never read — every use of
    // a held value goes through `load`, `store` or `scratchFrom`, and those
    // three read the register.
    const offset = register === null ? this.reserve(widthOf(type)) : 0;
    const held: Held = { offset, type, register };
    this.slots.set(emitted, held);
    return held;
  }

  private slot(name: string): Held {
    const emitted = this.names.read(name);
    const found = this.slots.get(emitted);
    if (found === undefined) throw machineError(`${this.fn.symbol} reads ${name}, which it does not declare`);
    return found;
  }

  /**
   * A slot the lowering binds for itself, of the type it holds, which is free
   * again when the statement that bound it has been written.
   *
   * Almost every slot a lowering binds for itself is written and read within
   * the one statement that needed it — the right side of an arithmetic, the
   * address of a field, the value a call takes as an argument — so the slot is
   * handed back when that statement is done and the next one that needs one
   * takes it. A frame that grew for every arithmetic the function contains
   * rather than for the few of them live at once also crosses the width at
   * which an instruction addresses a slot in one byte of displacement rather
   * than four, which is a byte on every instruction that reads one.
   */
  private hold(type: SemanticType, prefix: string): Held {
    const held = this.reserveSlot(type, prefix);
    this.borrowed.push(held);
    return held;
  }

  /**
   * A slot that outlives the statement that bound it. A loop's bound and its
   * step are read before the body and never inside it, but the body is written
   * between the two, so these are handed back by hand rather than at the end
   * of the statement the loop is.
   */
  private holdAcross(type: SemanticType, prefix: string): Held {
    return this.reserveSlot(type, prefix);
  }

  private reserveSlot(type: SemanticType, prefix: string): Held {
    this.temporaries += 1;
    const name = this.names.reserve(`${prefix}_${this.temporaries}`);
    const offset = this.spareSlots.pop() ?? this.reserve(Math.max(widthOf(type), 8));
    const held: Held = { offset, type, register: null };
    this.slots.set(name, held);
    return held;
  }

  /**
   * Hands one slot back, so that the next statement that needs one takes it.
   * Only the slots a statement bound for itself are handed back, and only once
   * the statement that bound them has been written.
   */
  private freeSlot(held: Held): void {
    this.spareSlots.push(held.offset);
  }

  /**
   * Hands back every slot bound since the mark, so that the next statement
   * that needs one takes it. The slots go back in the order the frame grew in,
   * so the ones nearest the top of it are handed out again first.
   */
  private freeSlotsSince(mark: number): void {
    for (let at = this.borrowed.length - 1; at >= mark; at -= 1) {
      this.spareSlots.push(this.borrowed[at].offset);
    }
    this.borrowed.length = mark;
    // A slot handed back here goes to whatever needs one next, and no
    // instruction written says so: what says which value a slot holds is where
    // it sits in the frame, and the next slot to take this one holds another.
    this.accumulator = null;
  }

  private scratch(bytes: number, prefix: string): number {
    this.temporaries += 1;
    this.names.reserve(`${prefix}_${this.temporaries}`);
    return this.reserve(bytes, 16);
  }

  /**
   * A value written into a slot of its own, which is what a loop bound the
   * program computed rather than wrote out is held in: it is read once before
   * the loop and once on every turn of it, and computing it on a turn would be
   * a read the source never performed.
   */
  private heldAt(type: SemanticType, prefix: string, value: SemanticValue): Held {
    this.at(value, type);
    const held = this.holdAcross(type, prefix);
    this.store(held);
    return held;
  }

  /* ---------------------------------------------------------------------- */
  /* The function itself                                                    */
  /* ---------------------------------------------------------------------- */

  /**
   * Puts the values a body reaches for again in registers instead of in the frame.
   *
   * Which names those are, and which register each one gets, is answered by
   * `liveness.ts` and not by counting: a census of reads says how often a name
   * is reached for and nothing about *when*, and where a value is live is what
   * says whether two names can share a register and whether a call takes it
   * away. So each name is given the runs of the body it is live over, and two
   * names whose runs never meet are put in the same register — which is what
   * lifts the cap a fixed list puts on how many names a function can hold.
   *
   * Which register depends on what a call does to the name. One that has to
   * still be there after a call can only be kept in a register the convention
   * says a callee leaves as it found it, and that costs the function a push and
   * a pop and sixteen bytes of stack. One no call reaches can be kept in a
   * register that costs nothing, because nothing is written over it between the
   * two places the value is read. So the two lists are filled independently —
   * `CALLER_SAVED` first for a name nothing calls, `CALLEE_SAVED` for one
   * something does — and a float is pinned out of the vector file rather than
   * the general one, which is a register file of its own.
   *
   * How many times a name is read still decides which name gets a register
   * first, but only as a weight: a read in a loop body is carried out once for
   * every turn of that loop and a read at the top of the body once however many
   * turns it turns, so a read is weighed by how many loops enclose the block it
   * is in. A name the weight says is worth more than the register costs is
   * given one; the ones that are not stay in the frame, where a load or a
   * store is what the lowering says they cost.
   *
   * A counted loop's counter is decided below rather than here: it is written
   * and read by the loop itself on every turn, so it is the one name whose
   * weight is not in question.
   */
  private allocateRegisters(): void {
    const reads = new Map<string, number>();
    const writes = new Map<string, number>();
    const declared: { name: string; type: SemanticType }[] = this.fn.params.map((parameter) => ({
      name: parameter.name,
      type: slotType(parameter),
    }));
    const write = (name: string, weight: number): void => {
      writes.set(name, (writes.get(name) ?? 0) + weight);
    };
    // A function that calls itself runs its own body once per level of the
    // recursion, so a read on a straight line through it is still a read
    // carried out many times — worth here what a read inside a loop is worth
    // in a function that calls nothing. `checksum` reads its one parameter
    // three times, which is below the threshold on a straight line and above
    // it in the function that is called once per node of the tree it walks.
    const recursed = this.fn.calls.some((edge) => edge.callee === this.fn.name) ? 1 : 0;
    for (const { block, depth } of everyBlockAtDepth(this.fn.entry)) {
      const weight = READ_WEIGHT[Math.min(depth + recursed, READ_WEIGHT.length - 1)];
      for (const statement of block.statements) {
        if (statement.k === "set" || statement.k === "step") write(statement.name, weight);
        if (statement.k === "setElement") {
          // The buffer of a write is named rather than valued, so a census of
          // the values the body computes never sees it read. Writing an element
          // changes what the pointer reaches and not the pointer itself, so it
          // is a read of the name rather than a write of it.
          reads.set(statement.buffer, (reads.get(statement.buffer) ?? 0) + weight);
        }
      }
      for (const value of everyValue(block)) {
        if (value.k === "local") reads.set(value.name, (reads.get(value.name) ?? 0) + weight);
      }
    }
    // Every name the body declares, and how many declarations spell it. A name
    // declared once is bound once and read under the spelling the source gave
    // it, so the register this pass gives it is the register the lowering reads
    // it by. A name declared twice is two names under one spelling — the second
    // escaping to another — so which register either is in cannot be said from
    // here, and neither of them is a candidate.
    const declarationCount = new Map<string, number>();
    const loopDeclared = new Set<string>();
    const declare = (name: string): void => {
      declarationCount.set(name, (declarationCount.get(name) ?? 0) + 1);
    };
    for (const parameter of this.fn.params) declare(parameter.name);
    for (const { block } of everyBlockAtDepth(this.fn.entry)) {
      for (const statement of block.statements) {
        if (statement.k === "let") declare(statement.slot.name);
        else if (statement.k === "loop") {
          const loop = statement.loop;
          if (loop.kind === "counted") {
            declare(loop.variable);
            loopDeclared.add(loop.variable);
          } else if (loop.kind === "each") {
            declare(loop.index);
            declare(loop.element);
            loopDeclared.add(loop.index);
            loopDeclared.add(loop.element);
          }
        }
      }
    }
    // A name a loop declares is the counter path's to decide about, and a name
    // declared inside a loop body is an accumulator as often as anything else:
    // `let sum = 0` written inside a loop and added to on every turn of it is
    // the commonest one there is, and it was left in the frame because only the
    // top of the body was looked at.
    for (const { block } of everyBlockAtDepth(this.fn.entry)) {
      for (const statement of block.statements) {
        if (statement.k !== "let" || loopDeclared.has(statement.slot.name)) continue;
        declared.push({ name: statement.slot.name, type: slotType(statement.slot) });
      }
    }
    // What a name is worth a register for is what it costs the frame: every
    // read and every write it is reached for is a memory operand, and a
    // register turns each of them into a move between registers instead.
    //
    // A name a loop writes counts its writes as well as its reads, because an
    // accumulator is read and written on every turn and both were frame
    // accesses. One written on a straight line counts too: what it used to be
    // given instead of a register was the answer that where a value is live
    // cannot be said without solving for it, which `liveness.ts` does.
    const score = (name: string): number => (reads.get(name) ?? 0) + (writes.get(name) ?? 0);
    const candidates = declared
      .map((entry) => ({ entry, score: score(entry.name) }))
      .filter((candidate) => candidate.score > 0 && declarationCount.get(candidate.entry.name) === 1)
      .sort((left, right) => right.score - left.score);

    this.pinnedRegisters = [];
    this.pinnedVectors = [];
    // Where every name is live, and what a call does to it. A name no call
    // reaches can be kept in a register the convention does not ask a callee to
    // preserve, which costs the function nothing; one that has to survive a
    // call has to be in one that does, which costs a push and a pop.
    const liveness = nameLiveness(
      this.fn.entry,
      this.fn.params.map((parameter) => parameter.name),
    );
    // The register each parameter arrives in, and the ones the parameters after
    // it arrive in. The prologue moves a parameter out of the register it
    // arrives in and into the one it was allocated, one parameter after another,
    // so a parameter may not be given a register another parameter has not been
    // read out of yet: the move that reads it would read what the first move
    // wrote. A parameter's own arrival register is the exception, because it is
    // where its value already is and nothing is moved at all.
    const arrivals = this.arrivals();
    const arrivalOf = new Map<string, number | null>();
    const laterArrivals = new Map<string, Set<number>>();
    for (const [at, parameter] of this.fn.params.entries()) {
      arrivalOf.set(parameter.name, arrivals[at]?.register ?? null);
      const after = new Set<number>();
      for (let later = at + 1; later < arrivals.length; later += 1) {
        const register = arrivals[later]?.register ?? null;
        if (register !== null) after.add(register);
      }
      laterArrivals.set(parameter.name, after);
    }
    const taken = new Map<number, (readonly [number, number])[]>();
    const claim = (register: number, live: readonly (readonly [number, number])[]): void => {
      const found = taken.get(register);
      if (found === undefined) taken.set(register, [...live]);
      else found.push(...live);
    };
    // The first register of a pool that is free over every place the name is
    // live, or null when every one of them is spoken for. Two names whose runs
    // never meet are never both live, so either register will do.
    //
    // A parameter is also kept out of the registers the parameters after it
    // arrive in, and given its own arrival register in preference to any other:
    // that one is where its value already is, so nothing is moved and nothing
    // can be moved over.
    const free = (
      pool: readonly number[],
      live: readonly (readonly [number, number])[],
      name: string,
    ): number | null => {
      const own = arrivalOf.get(name) ?? null;
      const later = laterArrivals.get(name);
      for (const pass of [own === null ? -1 : 0, 1]) {
        for (const register of pool) {
          const wanted = pass === 0 ? register === own : register !== own;
          if (!wanted) continue;
          if (later?.has(register) === true) continue;
          const held = taken.get(register);
          if (held === undefined || !overlaps(held, live)) return register;
        }
      }
      return null;
    };
    /**
     * A name in a register, or null when neither pool has one free over the
     * places it is live.
     *
     * A name a call reaches can only be kept where the callee leaves it alone,
     * because the call writes its arguments into every other one. A name no
     * call reaches is given one of those first, which is free, and only falls
     * back to a preserved one when the free file is spoken for where it is
     * live — a name whose live range is disjoint from that of the names ahead
     * of it shares their register and neither pays for it.
     */
    const assign = (name: string, type: SemanticType): void => {
      const facts = liveness.get(name);
      if (facts === undefined || facts.live.length === 0) return;
      const live = facts.live;
      const float = isFloat(type);
      const preserved = float ? VECTOR_CALLEE_SAVED : CALLEE_SAVED;
      const given = float ? VECTOR_CALLER_SAVED : CALLER_SAVED;
      const register = facts.acrossCall
        ? free(preserved, live, name)
        : (free(given, live, name) ?? free(preserved, live, name));
      if (register === null) return;
      this.pinned.set(name, register);
      claim(register, live);
      // Only a register the convention asks a callee to preserve is one the
      // prologue has to put somewhere and the epilogue read back. The two files
      // are numbered apart, so which one a register came from is what says it,
      // and not whether its number is in the preserved list.
      if (!preserved.includes(register)) return;
      if (float) this.pinnedVectors.push({ register, offset: 0, single: widthOf(type) === 4 });
      else this.pinnedRegisters.push(register);
    };
    // What a name is worth is what it costs the frame, but what it costs the
    // function is what the register it is put in costs to save: two memory
    // operands of prologue and epilogue for a preserved one, and none at all
    // for one the convention does not ask a callee to preserve. So a preserved
    // register has to be earned and a free one has not.
    const worth = (name: string): number => {
      const facts = liveness.get(name);
      return facts?.acrossCall === true ? PINNING_READS + 1 : 1;
    };
    for (const candidate of candidates) {
      if (candidate.score < worth(candidate.entry.name)) continue;
      assign(candidate.entry.name, candidate.entry.type);
    }
    // A counted loop's counter is written and read by the loop itself on every
    // turn, so it is what a register is worth the most on. Left in the frame it
    // costs a load and a store per turn to hold a value that the next turn
    // reads straight back out again.
    //
    // A float counter is not left out. It takes a vector register, and a
    // preserved vector register is spilled to the frame by the prologue for the
    // eight bytes it costs there and read back by the epilogue: two
    // instructions once for the function, against a load and a store on every
    // turn of the loop. A loop that turns twice never pays that back, which is
    // why it used to be left in the frame, and why a loop that turns a million
    // times was paying for it on every turn instead.
    //
    // A name declared more than once is left out too. Two loops both written
    // `for (let i ...)` share the name and would share the register, and the
    // inner one would go on stepping the outer one's counter.
    const counters = new Map<string, { depth: number; type: SemanticType }>();
    const declarations = new Map<string, number>();
    const walkCounters = (block: SemanticBlock, depth: number): void => {
      for (const statement of block.statements) {
        if (statement.k !== "loop") continue;
        const loop = statement.loop;
        if (loop.kind === "counted") {
          declarations.set(loop.variable, (declarations.get(loop.variable) ?? 0) + 1);
          // The inner loop of a nested pair turns the most, so depth is what
          // says which counter is worth a register first.
          counters.set(loop.variable, { depth: Math.max(counters.get(loop.variable)?.depth ?? 0, depth), type: loop.type });
        } else if (loop.kind === "each") {
          declarations.set(loop.index, (declarations.get(loop.index) ?? 0) + 1);
          declarations.set(loop.element, (declarations.get(loop.element) ?? 0) + 1);
          // A walk over an array steps its index once per turn and reads it
          // twice — once for the address and once for whatever the body does
          // with it — which is the same shape as a counted loop's counter and is
          // given a register for the same reason. Only the index is a candidate:
          // the element is the loop's own value and is written once per turn
          // from whatever the address produced.
          counters.set(loop.index, { depth: Math.max(counters.get(loop.index)?.depth ?? 0, depth), type: INDEX });
        }
        walkCounters(loop.body, depth + 1);
      }
    };
    walkCounters(this.fn.entry, 0);
    const ordered = [...counters.entries()]
      .filter(([name]) => (declarations.get(name) ?? 0) === 1 && declarationCount.get(name) === 1)
      .sort((left, right) => right[1].depth - left[1].depth);
    for (const [name, counter] of ordered) assign(name, counter.type);
    // The register an object is filled in is claimed after every name that could
    // be pinned to one, so that a function which builds an object keeps the
    // registers its names are read most often and takes the object register
    // from what is left.
    if (this.fillsObjects()) {
      this.objectRegister = OBJECT_POINTER;
      this.pinnedRegisters.push(OBJECT_POINTER);
    }
    // The prologue pushes the registers above the frame and the lowering binds
    // its slots from there downwards, so a slot's address does not depend on
    // whether a register was pinned. A vector register has no push and is
    // spilled to a slot of the frame instead, so its slot is reserved here and
    // the pushes are counted as before.
    this.used = this.pinnedRegisters.length * 8;
    for (const saved of this.pinnedVectors) {
      saved.offset = this.reserve(8, 8);
    }
    this.mayCall = this.callsAnything();
  }

  /**
   * Whether the body calls anything, which is what makes the frame's own size
   * the stack's alignment business: a call pushes a return address and every
   * callee assumes the stack it is entered on is sixteen byte aligned, so a
   * frame is a whole number of boundaries out of place. A function that calls
   * nothing has nothing to keep straight.
   */
  private callsAnything(): boolean {
    if (this.fn.allocates || this.fn.prints || this.fn.readsArgv) return true;
    for (const block of everyBlock(this.fn.entry)) {
      for (const value of everyValue(block)) {
        if (hasCall(value)) return true;
      }
    }
    return false;
  }

  emit(): Uint8Array {
    this.allocateRegisters();
    // A pinned value is in a register the convention says a callee leaves as it
    // found it, so the register is pushed here and popped there. The pushes are
    // above the frame rather than in it, which is what leaves a slot at the
    // same distance from the stack pointer whatever was pinned.
    for (const register of this.pinnedRegisters) this.code.push(register);
    const frameAt = this.code.subRegImmLater(RSP);
    // A vector register has no push and is spilled into the frame, which is
    // written after the frame is taken because that is the stack pointer the
    // slot's address is written against.
    for (const saved of this.pinnedVectors) this.code.saveVector(saved.register, saved.offset, saved.single);
    this.parameters();
    // The body opens a scope of its own, and the parameters are read in it, so
    // they are declared one scope further out.
    this.names.enter();
    this.block(this.fn.entry);
    this.code.bind(this.epilogue);
    const bytes = this.frameBytes();
    this.code.epilogue(this.pinnedRegisters, this.pinnedVectors, bytes);
    // An argument that arrived on the stack is above the return address, which
    // is above the pushes, which are above the frame: how far above the stack
    // pointer it is is a function of a frame nothing had read when the address
    // was written, so it is filled in now the frame is settled.
    for (const argument of this.incoming) {
      this.code.patchDisp(argument.index, bytes + this.pinnedRegisters.length * 8 + argument.at);
    }
    if (bytes > 0) this.code.patchWord(frameAt, bytes);
    // A function the body turned out to give no frame to writes no `sub` for
    // it: the instruction was written before the body was read, because the
    // frame is as large as what the body reserved.
    else this.code.unwriteSub(frameAt);
    return this.code.finish();
  }

  /**
   * The frame, in eight byte steps and, where a call is made, with the stack
   * left the sixteen byte aligned every callee is assumed to be entered on.
   *
   * A function is entered eight bytes off a boundary, because the call that
   * reached it pushed a return address, and a call inside it wants that back.
   * So what the prologue moves the stack down by — the pushes and the frame
   * together — is a number eight bytes off a whole number of boundaries, and
   * the frame is what is left of that number once the pushes are spoken for.
   * Which costs up to eight bytes a function whose frame lands on a boundary,
   * against the four instructions a frame pointer costs every call of it.
   */
  private frameBytes(): number {
    const pushed = this.pinnedRegisters.length * 8;
    const below = pushed + this.used;
    if (!this.mayCall) return Math.ceil(below / 8) * 8;
    return 8 + 16 * Math.ceil((below - 8) / 16) - pushed;
  }

  /**
   * The address `at` bytes above the return address, which is where an argument
   * that arrived on the stack sits: the return address is the first word above
   * where the stack pointer stood on entry, so the first argument past the
   * registers is eight bytes above it.
   *
   * It is the one address in a function that cannot be written as it is
   * written: what is above the return address is a function of how large a
   * frame the body goes on to reserve, and nothing has read that yet. So the
   * displacement is written as the four byte form and left for `emit` to fill
   * in, and the index recorded here is what that patch is given by.
   */
  private stackArgument(at: number): Memory {
    this.incoming.push({ index: this.code.deferDisp(), at });
    return mem(RSP, 0);
  }

  /**
   * Where each parameter arrives: the register it is handed in, or null where it
   * is handed on the stack above the return address.
   *
   * The register allocation needs this before the prologue is written, because
   * a parameter given a register is moved there from the one it arrives in —
   * and a move into a register another parameter has not been read out of yet
   * destroys that argument.
   */
  private arrivals(): { register: number | null; stack: number }[] {
    let general = 0;
    let floating = 0;
    let stack = 0;
    return this.fn.params.map((parameter) => {
      const type = slotType(parameter);
      const register = stack > 0 ? undefined : isFloat(type) ? SSE_ARGUMENTS[floating] : INTEGER_ARGUMENTS[general];
      if (register === undefined) {
        const here = stack;
        stack += 1;
        return { register: null, stack: here };
      }
      if (isFloat(type)) floating += 1;
      else general += 1;
      return { register, stack: -1 };
    });
  }

  /**
   * The arguments as they arrive: the first six whole numbers and the first
   * eight floats come in registers, and the rest are on the stack above the
   * return address.
   */
  private parameters(): void {
    const arrivals = this.arrivals();
    for (const [at, parameter] of this.fn.params.entries()) {
      const arrival = arrivals[at];
      if (arrival === undefined) {
        throw machineError(`${this.fn.symbol} has an argument the convention hands in nowhere`);
      }
      const type = slotType(parameter);
      const held = this.bind(parameter.name, type);
      const offset = held.offset;
      const register = arrival.register;
      if (held.register !== null) {
        // A parameter that is pinned is in a register from here on, so the frame
        // copy it would otherwise be written to is not made. It arrives in an
        // argument register or on the stack, and either is one move into the
        // register it is pinned to — which is no move at all where it was given
        // the register it arrived in, which is what it is given whenever that
        // register is one the allocation was free to use.
        if (register === null) {
          const argument = this.stackArgument(8 + arrival.stack * 8);
          if (isFloat(type)) this.code.movsLoad(held.register, argument, widthOf(type) === 4);
          else this.code.movRegMem(held.register, argument);
          continue;
        }
        if (held.register === register) continue;
        if (isFloat(type)) this.code.movsMove(held.register, register, widthOf(type) === 4);
        else this.code.movRegReg(held.register, register);
        continue;
      }
      if (register === null) {
        // An argument of a class that has run out of registers is on the stack
        // above the return address, and so is every argument after it.
        this.code.movRegMem(RAX, this.stackArgument(8 + arrival.stack * 8));
        this.code.movMemRegSized(frame(offset), RAX, widthOf(type));
        continue;
      }
      this.code.movMemRegSized(frame(offset), register, widthOf(type));
      // The first float argument arrives in the accumulator itself, so writing
      // it down leaves the accumulator holding what the slot holds — which is
      // what the first read of that parameter is answered by.
      if (isFloat(type)) {
        this.code.movsStore(frame(offset), register, widthOf(type) === 4);
        if (register === XMM0) this.accumulator = { offset, at: this.code.written };
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* The accumulator and the frame                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * The accumulator holding the value a slot has — or already holding it, which
   * is a load this answers without writing one.
   *
   * Every value the body computes passes through the accumulator, and nothing
   * between a store and the load that reads the same slot moves it: a store
   * writes the accumulator down without taking it away. So the slot whose value
   * the accumulator holds is kept beside where the code was when it last did,
   * and a load is one instruction shorter whenever the slot is the one asked
   * for and no instruction has been written since. What says the accumulator
   * still holds it is that second half: an instruction that took the
   * accumulator moved the code on, so a fact recorded against a place in the
   * code cannot be read at a later one.
   */
  private load(held: Held): void {
    if (held.register !== null) {
      if (isFloat(held.type)) this.code.movsMove(XMM0, held.register, widthOf(held.type) === 4);
      else this.code.movRegReg(RAX, held.register);
      return;
    }
    if (this.accumulator?.offset === held.offset && this.accumulator.at === this.code.written) return;
    if (isFloat(held.type)) {
      this.code.movsLoad(XMM0, frame(held.offset), widthOf(held.type) === 4);
    } else {
      this.code.movRegMemSized(RAX, frame(held.offset), widthOf(held.type), signedOf(held.type));
    }
    this.accumulator = { offset: held.offset, at: this.code.written };
  }

  /**
   * The value the accumulator has, written at the address a register holds.
   * The displacement is the offset of a field in the object that address
   * points at, so a write to a field is one instruction rather than a move
   * of the address, an addition to it, and the write.
   */
  private storeInto(type: SemanticType, address: number, displacement = 0): void {
    if (isFloat(type)) {
      this.code.movsStore(mem(address, displacement), XMM0, widthOf(type) === 4);
      return;
    }
    this.code.movMemRegSized(mem(address, displacement), RAX, widthOf(type));
  }

  /**
   * A slot holding the value the accumulator has.
   *
   * Writing the accumulator down does not take it away, so what it holds is
   * still what it held — which is what lets the load of that same slot after it
   * be answered rather than written.
   */
  private store(held: Held): void {
    if (held.register !== null) {
      if (isFloat(held.type)) this.code.movsMove(held.register, XMM0, widthOf(held.type) === 4);
      else this.code.movRegReg(held.register, RAX);
      return;
    }
    if (isFloat(held.type)) {
      this.code.movsStore(frame(held.offset), XMM0, widthOf(held.type) === 4);
      return;
    }
    this.code.movMemRegSized(frame(held.offset), RAX, widthOf(held.type));
  }

  /**
   * The value at the address the accumulator has, read as the type it is.
   * The displacement is the offset of a field in the object that address
   * points at, which is how a read of a field is one instruction rather than
   * an addition to the address and then the read.
   */
  private readAt(type: SemanticType, displacement = 0): void {
    if (isFloat(type)) {
      this.code.movsLoad(XMM0, mem(RAX, displacement), widthOf(type) === 4);
      return;
    }
    this.code.movRegMemSized(RAX, mem(RAX, displacement), widthOf(type), signedOf(type));
  }

  /** The value in a slot of the frame, read as the type it is declared at. */
  private readSlotAt(type: SemanticType, offset: number): void {
    if (isFloat(type)) {
      this.code.movsLoad(XMM0, frame(offset), widthOf(type) === 4);
      return;
    }
    this.code.movRegMemSized(RAX, frame(offset), widthOf(type), signedOf(type));
  }

  /** The accumulator widened to the width and sign of the type it is read as. */
  private normalize(type: SemanticType): void {
    if (isFloat(type) || widthOf(type) === 8) return;
    this.code.narrow(RAX, RAX, widthOf(type), signedOf(type));
  }

  /**
   * The same widening, for a value that has just come out of an operation
   * carried out at the width the type is stored at.
   *
   * The invariant this rests on: an operation the machine carries out on the
   * thirty-two bit half of a register writes that half and nothing above it,
   * so the whole register already holds the value widened the way an unsigned
   * thirty-two bit type is widened and there is nothing left to do. A signed
   * type still needs its `movsxd`, because a thirty-two bit operation leaves
   * the sign in the thirty-first bit rather than copying it upwards, and so
   * does every type narrower than a word.
   *
   * It is only sound where the value provably came from such an operation. A
   * value a callee handed back is not one: the convention says nothing about
   * what the upper half of the return register holds, so a call is normalized
   * the long way.
   */
  private normalizeArithmetic(type: SemanticType, register = RAX): void {
    if (isFloat(type) || widthOf(type) === 8) return;
    if (widthOf(type) === 4 && !signedOf(type)) return;
    this.code.narrow(register, register, widthOf(type), signedOf(type));
  }

  /** The scratch register holding what the accumulator has. */
  private toScratch(type: SemanticType): void {
    if (isFloat(type)) {
      this.code.movsMove(XMM1, XMM0, widthOf(type) === 4);
      return;
    }
    this.code.movRegReg(RCX, RAX);
  }

  /**
   * The scratch register holding what a slot holds. The other side of an
   * operation is read out of its slot at the last moment rather than kept in a
   * register across the evaluation of this one, which would be clobbered by
   * every operation the value itself is made of.
   */
  private scratchFrom(held: Held): void {
    if (held.register !== null) {
      if (isFloat(held.type)) this.code.movsMove(XMM1, held.register, widthOf(held.type) === 4);
      else this.code.movRegReg(RCX, held.register);
      return;
    }
    if (isFloat(held.type)) {
      this.code.movsLoad(XMM1, frame(held.offset), widthOf(held.type) === 4);
      return;
    }
    this.code.movRegMem(RCX, frame(held.offset));
  }

  /* ---------------------------------------------------------------------- */
  /* Blocks and statements                                                  */
  /* ---------------------------------------------------------------------- */

  private block(block: SemanticBlock): void {
    this.names.enter();
    // A statement binds the slots it needs for itself, so the frame is left
    // holding the few of them that are live at once rather than the sum of
    // every one the function ever bound.
    const mark = this.borrowed.length;
    for (const statement of block.statements) this.statement(statement);
    this.freeSlotsSince(mark);
    for (const name of block.releases) this.release(name);
    this.terminator(block.terminator);
    // A block that leaves for another one has written the jump that does it,
    // and that jump is not one the lowering laid out to reach whatever comes
    // next here.
    if (block.terminator.k === "jump") this.code.sealJump();
    this.names.leave();
  }

  private statement(statement: SemanticStatement): void {
    switch (statement.k) {
      case "let": {
        const type = slotType(statement.slot);
        if (statement.slot.kind === "buffer") {
          this.value(statement.value);
          this.store(this.bind(statement.slot.name, type));
          return;
        }
        this.at(statement.value, type);
        this.store(this.bind(statement.slot.name, type));
        return;
      }
      case "set":
        this.assign(statement.name, statement.op, statement.value);
        return;
      case "setElement": {
        const buffer = this.slot(statement.buffer);
        const element = elementTypeOf(buffer.type) ?? statement.value.type;
        const place = this.hold(POINTER, "blaze_place");
        this.at(statement.value, element);
        const written = this.hold(element, "blaze_element");
        this.store(written);
        this.addressOf(statement.buffer, statement.index, element);
        this.store(place);
        if (statement.op !== "=") {
          this.readSlotAt(element, place.offset);
          const read = this.hold(element, "blaze_read");
          this.store(read);
          this.load(written);
          this.toScratch(element);
          this.load(read);
          this.apply(COMPOUND[statement.op.slice(0, -1)], element);
          this.normalizeArithmetic(element);
        } else {
          this.load(written);
        }
        this.code.movRegMem(RCX, frame(place.offset));
        this.storeInto(element, RCX);
        return;
      }
      case "step": {
        // A name the build gave a register of its own is stepped where it lies,
        // the way a counted loop steps its counter. Copying it through the
        // accumulator to add one and write it back is two instructions that
        // produce the same register.
        const target = this.slot(statement.name);
        const register = target.register;
        if (register === null) this.load(target);
        this.one(target.type, statement.op === "++" ? "add" : "sub", register ?? RAX);
        this.normalizeArithmetic(target.type, register ?? RAX);
        if (register === null) this.store(target);
        return;
      }
      case "printText":
        this.printText(statement.value);
        return;
      case "printNumber":
        this.at(statement.value, NUMBER);
        this.runtime("_print_number");
        return;
      case "printNewline":
        this.runtime("_print_newline");
        return;
      case "retain":
        this.value(statement.value);
        this.code.movRegReg(RDI, RAX);
        this.runtime("_retain");
        return;
      case "raise":
        this.value(statement.message);
        this.code.movRegReg(RDI, RAX);
        this.runtime("_raise");
        return;
      case "call":
        this.callValue(statement.call, null);
        return;
      case "storeField":
        this.storeField(statement.object, statement.layout, statement.field, statement.value);
        return;
      case "if": {
        const otherwise = this.code.label("Lelse");
        const end = this.code.label("Lend");
        // With no other arm there is nothing at `otherwise` to reach: the arm
        // that is not taken is the end of the statement itself, so the branch
        // goes there and no jump over the other arm is written at all. What
        // that jump used to be was five bytes moving zero.
        this.truthBranch(statement.condition, false, statement.otherwise === null ? end : otherwise);
        this.block(statement.then);
        if (statement.otherwise !== null) {
          // An arm that returns or leaves for another block never comes back
          // here, so the jump over the other arm is written only when the arm
          // does fall out of the end of it.
          if (statement.then.terminator.k === "next") this.code.jmp(end);
          this.code.bind(otherwise);
          this.block(statement.otherwise);
        }
        this.code.bind(end);
        return;
      }
      case "block":
        this.block(statement.body);
        return;
      case "loop":
        this.loop(statement.loop);
        return;
    }
  }

  /** A name given a value, or one changed by the operator it was written with. */
  private assign(name: string, op: string, value: SemanticValue): void {
    const target = this.slot(name);
    // A string grows: `+=` is a new value rather than an addition in place, and
    // two addresses added together are not a string.
    if (op === "+=" && isTextType(target.type)) {
      this.concat({ k: "local", type: TEXT, name }, value, target.type);
      this.store(target);
      return;
    }
    if (op === "=") {
      this.at(value, target.type);
      this.store(target);
      return;
    }
    // Every other operator reads what the name holds as well as the value it is
    // given, and which of the two is the left side of it is the whole of what a
    // compound assignment is: `i -= 1` is `i` less one and `1 - i` is a number
    // of its own, and for `n /= 2` the difference is two divided by n.
    //
    // An addition and a multiplication are the two operations whose answer does
    // not say which side was which, so for those the value is evaluated once
    // into the accumulator and the name's old value is read into the scratch
    // register, which is one instruction fewer than the general form below and
    // the same answer.
    const operation = COMPOUND[op.slice(0, -1)];
    this.at(value, target.type);
    if (operation === "add" || operation === "mul") {
      if (this.floatOverFrame(operation, target.type, target)) {
        this.normalizeArithmetic(target.type);
        this.store(target);
        return;
      }
      this.scratchFrom(target);
      this.apply(operation, target.type);
      this.normalizeArithmetic(target.type);
      this.store(target);
      return;
    }
    // Anything else needs the name on the left, and the accumulator holds the
    // value rather than the name. The value is written down before the name is
    // read rather than after, so an expression that writes the name as a side
    // of its own evaluation still reads the same thing it would have: the order
    // is the one the addition above has.
    const right = this.hold(target.type, "blaze_right");
    this.store(right);
    this.load(target);
    if (isFloat(target.type)) {
      this.code.movsLoad(XMM1, frame(right.offset), widthOf(target.type) === 4);
    } else this.readInto(right, RCX);
    this.apply(operation, target.type);
    this.normalizeArithmetic(target.type);
    this.store(target);
  }

  /**
   * A float operation over a side that is already in the frame, answered by
   * the instruction reading it rather than by a move in front of one.
   *
   * A sum and a product take their sides either way round, so the value the
   * accumulator holds and the one the frame holds may be given over in
   * whichever order is convenient and the answer is the same. A difference
   * and a quotient do not, and are left the way they were.
   *
   * It answers whether it did, so a side that is in a register rather than in
   * the frame — which is where a value the build gave a register of its own
   * lives — goes the other way.
   */
  private floatOverFrame(operation: Arithmetic, type: SemanticType, other: Held): boolean {
    if (!isFloat(type) || (operation !== "add" && operation !== "mul")) return false;
    if (other.register !== null) return false;
    this.code.sseMem(operation, XMM0, frame(other.offset), widthOf(type) === 4);
    return true;
  }

  private storeField(object: SemanticValue, layoutName: string, name: string, value: SemanticValue): void {
    const found = this.field(layoutName, name);
    const type = parseType(found.type);
    if (this.keepsScratch(object) && this.keepsScratch(value)) {
      // Neither side writes the scratch, so the address is taken first and the
      // value is written straight through it. The other order has to write the
      // value to the frame and read it back, because taking the address of the
      // object is what takes the scratch.
      this.value(object);
      this.code.lea(RCX, mem(RAX, found.offset));
      this.at(value, type);
      this.storeInto(type, RCX);
      return;
    }
    this.at(value, type);
    const written = this.hold(type, "blaze_field");
    this.store(written);
    // The address of the field is one `lea` rather than a copy of the object
    // and an addition to it: the offset of a field is a displacement the
    // machine computes for itself, not an arithmetic the lowering writes out.
    this.value(object);
    this.code.lea(RCX, mem(RAX, found.offset));
    this.load(written);
    this.storeInto(written.type, RCX);
  }

  /**
   * Whether writing a value leaves the scratch register as it found it, which
   * is what lets a value already held in it survive the writing of another.
   *
   * A name, a number, a truth and a null are read or written as they are. A
   * field read takes the object through the accumulator and reads the field
   * through it, so it takes neither register of its own when the object takes
   * neither either. Everything else is either written through the scratch — an
   * arithmetic, a comparison, an element read, a string — or is a call that
   * takes it away, and a value that does either is written the long way round.
   */
  private keepsScratch(value: SemanticValue): boolean {
    switch (value.k) {
      case "local":
      case "const":
      case "bool":
      case "nothing":
        return true;
      case "loadField":
        return this.keepsScratch(value.object);
      default:
        return false;
    }
  }

  private loop(loop: SemanticLoop): void {
    this.names.enter();
    const labels = this.loopLabels(loop);
    this.loops.push({ header: labels.header, exit: labels.exit, names: { header: loop.header, exit: loop.exit } });
    switch (loop.kind) {
      case "while": {
        this.code.bind(labels.header);
        this.truthBranch(loop.condition, false, labels.exit);
        this.block(loop.body);
        // The same, for the edge back to the header: a body that returns or
        // breaks never reaches the test again, so the jump is not written.
        if (loop.body.terminator.k === "next") this.code.jmp(labels.header);
        this.code.bind(labels.exit);
        break;
      }
      case "doWhile": {
        this.code.bind(labels.header);
        this.block(loop.body);
        this.truthBranch(loop.condition, true, labels.header);
        this.code.bind(labels.exit);
        break;
      }
      case "counted":
        this.counted(loop, labels);
        break;
      case "each":
        this.each(loop, labels);
        break;
    }
    this.loops.pop();
    this.names.leave();
  }

  /**
   * Every name a loop and the blocks inside it write, which is what a bound
   * read once may not read: a value naming one of them is a value the loop has
   * to look at again on each turn rather than hold for the whole loop.
   */
  private loopWrites(loop: SemanticLoop): Set<string> {
    const written = new Set<string>();
    if (loop.kind === "counted") written.add(loop.variable);
    else if (loop.kind === "each") {
      written.add(loop.index);
      written.add(loop.element);
    }
    const visit = (block: SemanticBlock): void => {
      for (const statement of block.statements) {
        if (statement.k === "set" || statement.k === "step") written.add(statement.name);
        else if (statement.k === "setElement") written.add(statement.buffer);
        else if (statement.k === "let") written.add(statement.slot.name);
        else if (statement.k === "loop") {
          for (const name of this.loopWrites(statement.loop)) written.add(name);
        }
        if (statement.k === "loop") visit(statement.loop.body);
        else if (statement.k === "if") {
          visit(statement.then);
          if (statement.otherwise !== null) visit(statement.otherwise);
        } else if (statement.k === "block") visit(statement.body);
      }
    };
    visit(loop.body);
    return written;
  }

  /**
   * Registers of a kind this loop writes, or null when the program has pinned so
   * many that there are not enough left.
   *
   * Nothing in this loop calls, so borrowing the ones a caller does not ask to
   * be preserved is free: the convention only obliges a callee to hand back what
   * it was given, and this function has been handed nothing by the time it gets
   * here. A pinned register is one the allocator gave to a name, and writing
   * over it would be writing over that name's value, so they are the ones left
   * out.
   */
  private borrow(pool: readonly number[], howMany: number): number[] | null {
    const spoken = new Set(this.pinned.values());
    const free = pool.filter((register) => !spoken.has(register));
    return free.length >= howMany ? free.slice(0, howMany) : null;
  }

  /**
   * A counted loop that adds up what two arrays hold, written a vector at a time.
   *
   * A turn of the loop below is two turns of the loop the source wrote: it reads
   * two elements of each array, multiplies them and adds the pair into an
   * accumulator that holds two sums at once, in three instructions where the
   * scalar turn took two loads, a multiply, an add, and the two conversions that
   * turn a float counter into the index either array is read at. Nothing here
   * calls, so none of the registers it borrows has to survive anything.
   *
   * The counter is stepped once, at the end, rather than on every turn. The
   * cursor is a count of bytes, and dividing it by the sixteen a pair is brings
   * back the index of the element the pairs stopped at — which is the counter
   * the scalar loop would have left there, because it stepped by one per turn and
   * two turns are one pair.
   *
   * An odd number of elements leaves one over, and it is written by the body this
   * would otherwise have written for every element, at the counter the pairs
   * reached. So the sum the loop answers is the sum of every element whether the
   * array held an odd number of them or not.
   *
   * Returns false when the registers this needs are not free, which leaves the
   * loop to be written the way every other one is.
   */
  private packedDot(
    dot: PackedDot,
    loop: Extract<SemanticLoop, { kind: "counted" }>,
    labels: LoopLabels,
  ): boolean {
    const type: SemanticType = { kind: "primitive", name: "f64" };
    const whole: SemanticType = { kind: "primitive", name: "i64" };
    const vectors = this.borrow([XMM0, XMM1, ...VECTOR_CALLER_SAVED], 3);
    const registers = this.borrow([RDI, RSI, R8, R9, R10, R11], 3);
    if (vectors === null || registers === null) return false;
    const [sum, lane, spare] = vectors;
    const [cursor, left, right] = registers;

    // The counter is declared before anything is written, because the scalar tail
    // at the end reads it as the index the leftover element is at.
    const variable = this.bind(dot.counter, type);
    const to = this.heldAt(type, "blaze_bound", dot.bound);
    const limit = this.holdAcross(whole, "blaze_limit");

    // Where the pairs stop: the bound as a byte offset, less the sixteen bytes
    // one pair is. A bound under two elements leaves this negative, which is what
    // the signed comparison in the loop reads as "no pairs at all".
    this.at(dot.bound, type);
    this.code.cvtFloatToInt(RAX, XMM0, false, true);
    this.code.shiftImm("shl", RAX, 3, true);
    this.code.aluImm("sub", RAX, 16, true);
    this.code.movMemRegSized(frame(limit.offset), RAX, 8);

    this.readInto(this.slot(dot.left), left);
    this.readInto(this.slot(dot.right), right);
    this.code.movRegImm(cursor, BigInt(dot.from * 8));
    // The accumulator of a vector of two sums starts at zero in both its halves.
    this.code.xorFloat(sum, sum);
    this.code.movsLoadLabel(XMM0, this.floatLiteral(floatBits(dot.from, false)), false);
    this.store(variable);

    const paired = this.code.label("Lpaired");
    this.code.bind(labels.header);
    this.code.movRegMemSized(RAX, frame(limit.offset), 8, true);
    this.code.alu("cmp", RAX, cursor, true);
    this.code.jcc("l", paired);
    // The cursor is a count of bytes and not of elements, so the address it
    // names is the array's own plus the cursor: the scale of the index is one,
    // and a turn reads the sixteen bytes at it.
    this.code.packedLoad(lane, indexed(left, cursor, 1));
    this.code.packedMem("mul", lane, indexed(right, cursor, 1));
    this.code.packed("add", sum, lane);
    this.code.aluImm("add", cursor, 16, true);
    this.code.jmp(labels.header);
    this.code.bind(paired);

    // The sum of a vector of two is one number, and it is its halves added to
    // each other: the shuffle leaves the high double in both halves, the add
    // leaves their sum in the low one, and the low one is a whole double.
    this.code.packedMove(spare, sum);
    this.code.unpackHigh(spare, sum);
    this.code.packed("add", sum, spare);
    const accumulator = this.slot(dot.accumulator);
    if (accumulator.register !== null) this.code.movsMove(accumulator.register, sum, false);
    else this.code.movsStore(frame(accumulator.offset), sum, false);

    // The counter where the pairs left it, which is where a scalar loop stepping
    // by one per turn would have left it too.
    this.code.movRegReg(RAX, cursor);
    this.code.shiftImm("shr", RAX, 3, true);
    this.code.cvtIntToFloat(spare, RAX, false);
    // `store` writes what the accumulator holds, and the index is in the
    // register the conversion put it in rather than in the accumulator.
    this.code.movsMove(XMM0, spare, false);
    this.store(variable);

    // What one element is left over is written by the body the loop was written
    // with, at the counter the pairs reached, and the counter is stepped past it
    // so that the value left behind is the one a scalar loop leaves.
    this.load(variable);
    this.comparedBranch(type, "lt", to, false, labels.exit);
    this.block(loop.body);
    this.load(variable);
    this.one(type, "add");
    this.store(variable);

    this.code.bind(labels.exit);
    this.freeSlot(to);
    this.freeSlot(limit);
    return true;
  }

  /**
   * A loop that adds a value the counter decides, where that value is computed
   * a pair of counters at a time and the additions are not.
   *
   * A turn below is two turns of the loop the source wrote. What is under the
   * addition — the element read, the weight built from the counter, the division
   * of one by the other — is the same arithmetic on two different counters, and
   * nothing in it reads the accumulator, so both turns' worth of it is computed
   * in one register. What is *not* done a pair at a time is the addition: the low
   * lane is added into the accumulator, then the high one, by the same scalar
   * instruction and in the same order the scalar loop would have added them in.
   *
   * That order is the whole reason this loop is not folded into a vector
   * accumulator the way a dot product is. A sum of floats is not the same number
   * however it is grouped, so a loop that adds may not have its additions
   * reordered — and this one computes everything else in the order the source
   * wrote and adds in that order too, which is what makes the pair the same
   * answer rather than merely a faster one.
   *
   * An odd number of turns leaves one over, and it is written by the body this
   * would otherwise have written for every turn, at the counter the pairs
   * reached. So the sum the loop answers is the sum of every turn whether the
   * bound was an even number or not.
   *
   * Returns false when the registers this needs are not free, which leaves the
   * loop to be written the way every other one is.
   */
  private packedSum(
    sum: PackedSum,
    loop: Extract<SemanticLoop, { kind: "counted" }>,
    labels: LoopLabels,
  ): boolean {
    const type: SemanticType = { kind: "primitive", name: "f64" };
    const whole: SemanticType = { kind: "primitive", name: "i64" };
    // The pair of counters lives in the loop counter's own register, and the
    // additions are made into the accumulator's, so a loop either of which was
    // given no register of its own is left to be written the way every other one
    // is. Both are asked for before the counter is bound, because binding is
    // what declares a name: a refusal here has to leave the names the scalar
    // loop is about to declare alone.
    const counter = this.pinned.get(this.names.read(sum.counter));
    const accumulator = this.slot(sum.accumulator);
    // The additions below are a double added into a double, so an accumulator of
    // another type is not one this can make at all.
    if (counter === undefined || accumulator.register === null || !isFloat(accumulator.type)) return false;
    const total = accumulator.register;
    // Three more: where a turn's value lands, the one its other side is built
    // in, and the one the other side borrows in turn. None of them is the
    // accumulator's, which the build gave a name this loop adds into a register
    // of its own and which is therefore not free to write through.
    const vectors = this.borrow([XMM0, XMM1, ...VECTOR_CALLER_SAVED], 3);
    // One register for the cursor the pair load is written against, and one for
    // each array's first element: a load is written against a base and a
    // displacement, so two arrays cannot share one register however little they
    // are read. A value reading more arrays than there are registers free is left
    // to be written the way every other loop is.
    const registers = this.borrow([RDI, RSI, R8, R9, R10, R11], 1 + sum.arrays.length);
    if (vectors === null || registers === null) return false;
    const [result, other, third] = vectors;
    const [cursor, ...bases] = registers;

    // What one turn is written with, gathered once so that every value under the
    // addition is written against the same registers.
    const turn: PackedTurn = { counter, counterName: sum.counter, cursor, arrays: sum.arrays, bases };

    // Declared before anything is written, because the scalar tail at the end
    // reads the counter as the index the leftover turn is at. It is the one
    // register the work below never writes through, because every read of a
    // counter is a move out of it.
    const variable = this.bind(sum.counter, type);
    const to = this.heldAt(type, "blaze_bound", sum.bound);
    const limit = this.holdAcross(whole, "blaze_limit");

    // Where the pairs stop: the bound as a byte offset, less the sixteen bytes
    // one pair is. A bound under two elements leaves this negative, which is what
    // the signed comparison in the loop reads as "no pairs at all".
    this.at(sum.bound, type);
    this.code.cvtFloatToInt(RAX, XMM0, false, true);
    this.code.shiftImm("shl", RAX, 3, true);
    this.code.aluImm("sub", RAX, 16, true);
    this.code.movMemRegSized(frame(limit.offset), RAX, 8);

    // The counter as the pair of counters one turn answers for: this one and the
    // next. Laying one literal over the other puts them in the two lanes, and
    // each turn moves the pair on by one in both of them.
    // The counter is written by `store`, which puts the accumulator into the
    // register the loop counts in, so the value it starts from is the value the
    // accumulator is holding at this point. It is loaded into the accumulator
    // for that reason rather than into the counter: the pair is laid over it
    // afterwards, and a counter written first would have its low half replaced.
    this.code.movsLoadLabel(XMM0, this.floatLiteral(floatBits(sum.from, false)), false);
    this.store(variable);
    this.code.movsLoadLabel(other, this.floatLiteral(floatBits(sum.from + 1, false)), false);
    this.code.unpackLow(counter, other);

    // Each array's first element, read once for the whole loop: a pair of turns
    // reads a pair of elements that stand beside each other in every one of them,
    // so the base of each is the same on every turn.
    for (const [at, name] of sum.arrays.entries()) this.readInto(this.slot(name), bases[at]);
    this.code.movRegImm(cursor, BigInt(sum.from * 8));
    // A sum taken one turn at a time starts at nothing, in the register the
    // additions will be made into.
    this.code.xorFloat(total, total);

    const paired = this.code.label("Lsummed");
    this.code.bind(labels.header);
    this.code.movRegMemSized(RAX, frame(limit.offset), 8, true);
    this.code.alu("cmp", RAX, cursor, true);
    this.code.jcc("l", paired);
    this.packedValue(sum.added, result, other, third, turn);
    // The low lane is this turn and the high lane is the next, and they are
    // added in that order because that is the order the scalar loop added in.
    // Nothing under the addition is a vector addition, so the only pair of turns
    // this folds is the pair of loads and the pair of counters.
    this.code.sse("add", total, result, false);
    this.code.packedMove(other, result);
    this.code.unpackHigh(other, result);
    this.code.movsMove(XMM0, other, false);
    this.code.sse("add", total, XMM0, false);
    // The pair moves on by the two counters one pair of turns stands for, in
    // both lanes: the low one is the turn the pair starts at and the high one is
    // the turn after it, so moving both by two leaves them a turn apart.
    this.code.movsLoadLabel(third, this.floatLiteral(floatBits(2, false)), false);
    this.code.unpackLow(third, third);
    this.code.packed("add", counter, third);
    this.code.aluImm("add", cursor, 16, true);
    this.code.jmp(labels.header);
    this.code.bind(paired);

    // The counter where the pairs left it, which is where a scalar loop stepping
    // by one per turn would have left it too.
    this.code.movRegReg(RAX, cursor);
    this.code.shiftImm("shr", RAX, 3, true);
    this.code.cvtIntToFloat(other, RAX, false);
    // `store` writes what the accumulator holds, and the index is in the
    // register the conversion put it in rather than in the accumulator.
    this.code.movsMove(XMM0, other, false);
    this.store(variable);

    // The sum the pairs added is already where a scalar loop leaves it: the
    // register the build gave the name, which every read of it below is taken
    // from and every write to it is made to. Writing it into the frame as well
    // would say nothing and would land in a slot the bound was given.
    // What one turn leaves over is written by the body the loop was written
    // with, at the counter the pairs reached, and the counter is stepped past it
    // so that the value left behind is the one a scalar loop leaves.
    this.load(variable);
    this.comparedBranch(type, "lt", to, false, labels.exit);
    this.block(loop.body);
    this.load(variable);
    this.one(type, "add");
    this.store(variable);

    this.code.bind(labels.exit);
    this.freeSlot(to);
    this.freeSlot(limit);
    return true;
  }

  /**
   * One value under the addition, in both lanes of a register at once.
   *
   * Every name this may meet is one a census has already said has a packed form
   * of itself, so each case here is how that form is written rather than whether
   * it may be. The counter is the pair the loop is counting; any other name is
   * loop-invariant and is copied into both lanes; a literal is broadcast the
   * same way; an element is the one sixteen-byte load that reads this turn and
   * the next; and an operation is its scalar form with a `d` on the opcode.
   *
   * Two registers carry the work and one carries the counters, at any depth:
   * each side is built into the register the other is not in, so neither is
   * still standing when the instruction that joins them is written.
   */
  private packedValue(
    value: SemanticValue,
    into: number,
    other: number,
    third: number,
    turn: PackedTurn,
  ): void {
    switch (value.k) {
      case "const": {
        this.code.movsLoadLabel(into, this.floatLiteral(floatBits(Number(decimalText(value.text)), false)), false);
        this.code.unpackLow(into, into);
        return;
      }
      case "local": {
        if (value.name === turn.counterName) {
          this.code.packedMove(into, turn.counter);
          return;
        }
        this.code.movsLoad(into, frame(this.slot(value.name).offset), false);
        this.code.unpackLow(into, into);
        return;
      }
      case "element": {
        // Two turns read two doubles that stand beside each other, which is one
        // load of sixteen bytes: the base of the array the read names and the
        // cursor of the pairs, both of which are in registers for the whole loop.
        const of = value.of.k === "local" ? value.of.name : "";
        const at = turn.arrays.indexOf(of);
        const base = turn.bases[at];
        if (base === undefined) throw machineError("a pair load was written for an array no base register was read for");
        this.code.packedLoad(into, indexed(base, turn.cursor, 1));
        return;
      }
      case "arith": {
        // The left side is finished with before the right begins, so the right
        // is built with the register it is standing in as its third and writes
        // over it, and the answer is the instruction that joins the two. That is
        // what a census bounds the height of the right side for.
        this.packedValue(value.left, into, other, third, turn);
        this.packedValue(value.right, other, third, into, turn);
        this.code.packed(value.op as "add" | "sub" | "mul" | "div", into, other);
        return;
      }
      default:
        throw machineError("a value was packed that the census said has no packed form of itself");
    }
  }

  /**
   * A loop that counts from one number to another. The bound and the step are
   * read once, because a `for` reads its bound on every turn and adds its step
   * on every turn, so a bound or a step the IR calls is a call the loop would
   * otherwise make once per turn. The header label sits on the step, which is
   * where a `continue` belongs, and the first turn is entered at the test.
   */
  private counted(loop: Extract<SemanticLoop, { kind: "counted" }>, labels: LoopLabels): void {
    const type = loop.type;
    // A loop that adds up two arrays element by element is written a whole
    // vector at a time. It is recognised here rather than in a pass over the IR
    // because the arithmetic is the machine's: `optimize-ir.ts` runs before any
    // backend and would write this loop out into copies of its body first, and
    // two rewrites of one loop have to be kept from meeting.
    const dot = packedDotOf(loop);
    if (dot !== null && this.packedDot(dot, loop, labels)) return;
    // A loop that adds a value the counter decides is written the same way, with
    // everything under the addition a pair of counters at a time and the
    // addition itself one turn at a time.
    const sum = packedSumOf(loop);
    if (sum !== null && this.packedSum(sum, loop, labels)) return;
    // The variable is bound before the loop's own values are read, because
    // whether it has a register decides whether the value the loop starts from
    // needs a slot of its own: a counter in a register is written straight from
    // the value the loop starts at, where a counter in the frame is written from
    // a slot that holds that value and nothing else ever reads.
    const variable = this.bind(loop.variable, type);
    let from: Held | null = null;
    if (variable.register === null) {
      this.at(loop.from, type);
      from = this.holdAcross(type, "blaze_from");
      this.store(from);
    } else {
      this.at(loop.from, type);
      this.store(variable);
    }
    // A bound and a step are read once and held, which is what a `for` costs
    // when nothing writes them: the value the loop counts to is the same number
    // on every turn. A body that writes one of them is the other case, and
    // `for (i = 0; i < limit; i++) { limit = 9; }` reads a different bound on
    // the second turn, so a value the body writes is read again at the header
    // instead of being held for the whole loop.
    const written = this.loopWrites(loop);
    const reread = (value: SemanticValue): boolean => {
      let seen = false;
      walkValues(value, (one) => {
        if (one.k === "local" && written.has(one.name)) seen = true;
      });
      return seen;
    };
    const boundReread = reread(loop.to);
    const stepReread = loop.step !== null && reread(loop.step);
    const writtenTo = boundReread ? null : this.literalOf(loop.to, type);
    const to: Held | number = writtenTo ?? this.heldAt(type, "blaze_to", loop.to);
    let step: Held | number | null = null;
    if (loop.step !== null) {
      // A step the program wrote out is the same number on every turn, so it
      // is carried by the instruction that adds it rather than by a slot it is
      // read out of on each of them.
      const number = stepReread ? null : this.immediateOf(loop.step, type);
      if (number !== null) {
        step = number;
      } else {
        this.at(loop.step, type);
        step = this.holdAcross(type, "blaze_step");
        this.store(step);
      }
    }
    // A counter in the frame is started from the slot the loop's first value
    // was written to, which the step and the bound above were evaluated after
    // and would otherwise have taken the accumulator away from. A counter in a
    // register was already given it above and needs nothing here.
    if (variable.register === null && from !== null) {
      this.load(from);
      this.store(variable);
    }
    const test = this.code.label("Ltest");
    this.code.jmp(test);
    this.code.bind(labels.header);
    // A bound the body writes is read again here, before the test reads it, so
    // the turn after the write compares against the value that was written.
    if (boundReread && typeof to !== "number") {
      this.at(loop.to, type);
      this.store(to);
    }
    const stepSlot = step !== null && typeof step !== "number" ? step : null;
    if (stepReread && loop.step !== null && stepSlot !== null) {
      this.at(loop.step, type);
      this.store(stepSlot);
    }
    // The counter is stepped once per turn and then tested, and both of those
    // work on it where it is: the accumulator the step leaves it in, or the
    // register of its own when the loop was given one. A counter in a
    // register is stepped and compared where it lies, so a turn costs no
    // traffic through the frame at all.
    const counter = variable.register ?? RAX;
    if (step === null) {
      // No step written out is one turn's worth in the direction the loop
      // counts, which is the only place `down` decides the arithmetic.
      if (variable.register === null) this.load(variable);
      this.one(type, loop.down ? "sub" : "add", counter);
    } else if (typeof step === "number") {
      // A step that is written down is the signed amount the index moves by,
      // so it is added whatever its sign is: the direction is already in it,
      // and subtracting a step of minus one moved the index the other way and
      // ran a descending loop for ever.
      if (variable.register === null) this.load(variable);
      if (isFloat(type)) {
        // A float has no add-with-the-amount-inside form, so the step is written
        // into the scratch and the counter is advanced in the register it lies in.
        this.code.movsLoadLabel(XMM1, this.floatLiteral(floatBits(step, widthOf(type) === 4)), widthOf(type) === 4);
        this.code.sse("add", counter, XMM1, widthOf(type) === 4);
      } else this.code.aluImm("add", counter, step, operationWidth(type) === 8);
    } else {
      this.scratchFrom(step);
      if (variable.register === null) this.load(variable);
      else if (isFloat(type)) this.code.movsMove(XMM0, variable.register, widthOf(type) === 4);
      else this.code.movRegReg(RAX, variable.register);
      this.apply("add", type);
      // A step that had to be read leaves the sum in the accumulator rather than
      // in the register the counter is in, because the scratch the step was read
      // into is the other side of the addition and the counter cannot be both.
      // The counter is read back out of the accumulator here, which is what a
      // counter in the frame gets from the store below instead.
      if (variable.register !== null) {
        if (isFloat(type)) this.code.movsMove(variable.register, XMM0, widthOf(type) === 4);
        else this.code.movRegReg(variable.register, RAX);
      }
    }
    this.normalizeArithmetic(type, counter);
    // A counter stepped where it lies is not stored: writing the accumulator
    // into it would step it with whatever the step left behind.
    if (variable.register === null) this.store(variable);
    this.code.bind(test);
    // Nothing is written between the store above and the test, so the counter
    // is still in the accumulator and reading the slot it was just written to
    // would be loading a value that is already there.
    this.comparedBranch(
      type,
      loop.inclusive ? (loop.down ? "ge" : "le") : loop.down ? "gt" : "lt",
      to,
      false,
      labels.exit,
      counter,
    );
    this.block(loop.body);
    if (loop.body.terminator.k === "next") this.code.jmp(labels.header);
    this.code.bind(labels.exit);
    // The slots the header was read into are dead now the loop is written, and
    // whatever the statement after this one binds takes them.
    if (from !== null) this.freeSlot(from);
    if (typeof to !== "number") this.freeSlot(to);
    if (typeof step !== "number" && step !== null) this.freeSlot(step);
  }

  /**
   * A loop that walks an array. The buffer is read in the scope the loop was
   * entered in, and its length is read once, for the same reason a counted
   * loop's bound is.
   */
  private each(loop: Extract<SemanticLoop, { kind: "each" }>, labels: LoopLabels): void {
    this.at(loop.length, USIZE);
    const length = this.holdAcross(USIZE, "blaze_length");
    this.store(length);
    const index = this.bind(loop.index, USIZE);
    // The index is stepped where it lies, the way a counted loop steps its
    // counter: in the frame it costs a store and a load per turn to hold a
    // value the next turn reads straight back out again, and a register the
   // callee leaves alone costs neither.
    const counter = index.register ?? RAX;
    this.code.movRegImm(counter, 0n);
    if (index.register === null) this.store(index);
    const test = this.code.label("Ltest");
    this.code.jmp(test);
    this.code.bind(labels.header);
    this.code.aluImm("add", counter, 1);
    if (index.register === null) this.store(index);
    this.code.bind(test);
    // The count was just written, so the counter is still where it was stepped.
    this.code.aluRegMem("cmp", counter, frame(length.offset), true);
    this.code.jcc("ae", labels.exit);
    this.addressOf(loop.of, { k: "local", type: USIZE, name: loop.index }, loop.elementType);
    this.readAt(loop.elementType);
    this.store(this.bind(loop.element, loop.elementType));
    this.block(loop.body);
    if (loop.body.terminator.k === "next") this.code.jmp(labels.header);
    this.code.bind(labels.exit);
    // The length was read before the body and is dead now the loop is written.
    this.freeSlot(length);
  }

  /**
   * The flags saying whether a value is true. An empty string is false and an
   * absent reference is false, as they are in the language, and a value that is
   * not a number is true, which is what a comparison that is not ordered says.
   */
  private truth(value: SemanticValue): void {
    this.value(value);
    this.truthOfAccumulator(value.type);
  }

  /**
   * The same truth asked of the value the accumulator already holds, which is
   * what lets a caller that has just read a value into it branch on it without
   * reading the value a second time.
   */
  private truthOfAccumulator(type: SemanticType): void {
    if (isTextType(type)) {
      this.code.movRegMemSized(RCX, mem(RAX), 1, false);
      this.code.test(RCX);
      return;
    }
    if (isFloat(type)) {
      this.floatTruth(type);
      return;
    }
    this.code.test(RAX);
  }

  /**
   * A branch on whether a value is true, and nothing else.
   *
   * A value that is a comparison is the case this exists for. The comparison
   * already leaves in the flags the answer every caller of `truth` goes on to
   * ask about, so the branch reads them where they are: the condition byte is
   * never widened into the accumulator, and the `test` that asked whether it
   * was zero never happens. The side that is not a comparison is put in the
   * accumulator and asked of it as before.
   */
  private truthBranch(value: SemanticValue, whenTrue: boolean, label: string): void {
    if (value.k === "isNull" && !isTextType(value.operand.type)) {
      // A test of a reference is a test of the pointer holding it, and the
      // answer is a branch on the pointer rather than a truth written down as
      // a number and tested again. `is_null` is the test itself and
      // `is_not_null` is its negation, so which of the two conditions the
      // branch reads is the one the test holds under for the sense asked for.
      this.value(value.operand);
      this.truthOfAccumulator(value.operand.type);
      this.code.jcc((whenTrue ? !value.negate : value.negate) ? "e" : "ne", label);
      return;
    }
    if (value.k === "compare" && !isTextType(value.operand)) {
      const type = value.operand;
      // Which form the comparison takes is settled before either side is
      // written, so that a side is evaluated once whichever form it is. An
      // other side the program wrote out is carried by the comparison itself
      // rather than by a slot, so `left > 0` is a compare against a literal
      // and not a literal stored in the frame and read back out of it.
      const immediate = this.literalOf(value.right, type);
      if (immediate !== null) {
        this.at(value.left, type);
        this.comparedBranch(type, value.op, immediate, whenTrue, label);
        return;
      }
      const right = this.hold(type, "blaze_right");
      this.at(value.right, type);
      this.store(right);
      this.at(value.left, type);
      this.comparedBranch(type, value.op, right, whenTrue, label);
      return;
    }
    this.truth(value);
    this.code.jcc(whenTrue ? "ne" : "e", label);
  }

  /**
   * `!` over a comparison, read out of the flags the comparison leaves rather
   * than out of a number the comparison was first written down as.
   */
  private comparedNegated(value: SemanticValue & { k: "compare" }): void {
    const type = value.operand;
    const immediate = this.immediateOf(value.right, type);
    if (immediate !== null) {
      this.at(value.left, type);
      this.cmpHeld(type, immediate);
    } else {
      const right = this.hold(type, "blaze_right");
      this.at(value.right, type);
      this.store(right);
      this.at(value.left, type);
      this.cmpHeld(type, right);
    }
    this.code.setcc(NEGATED[COMPARISON[signedOf(type) ? "signed" : "unsigned"][value.op]], RAX);
    this.code.movzxReg8(RAX, RAX);
  }

  /**
   * A float is true when it is not zero, and a value that is no number is too.
   * The `movzx` that turns the two condition bytes into a number sets the
   * zero flag from that number, so the truth is in the flags once the move is
   * written and nothing has to ask about it afterwards.
   */
  private floatTruth(type: SemanticType): void {
    this.code.xorFloat(XMM2, XMM2);
    this.code.sseCompare(XMM0, XMM2, widthOf(type) === 4, false);
    this.code.setcc("ne", RAX);
    this.code.setcc("p", RCX);
    this.code.alu8("or", RAX, RCX);
    this.code.movzxReg8(RAX, RAX);
  }

  private terminator(terminator: SemanticTerminator): void {
    if (terminator.k === "next") return;
    if (terminator.k === "return") {
      if (terminator.value !== null) this.at(terminator.value, this.fn.returns);
      this.code.jmp(this.epilogue);
      return;
    }
    for (const name of terminator.releases) this.release(name);
    const open = this.loops[this.loops.length - 1];
    // The target is the id of a block the IR names, and what the jump is
    // written under is the label the lowering minted for that place, which is
    // not the block's id: a block named by two loops is two places.
    if (open === undefined || (terminator.target !== open.names.header && terminator.target !== open.names.exit)) {
      throw machineError(`${this.fn.symbol} jumps for a block no loop around it names`, terminator.target);
    }
    this.code.jmp(terminator.target === open.names.header ? open.header : open.exit);
  }

  private release(name: string): void {
    const held = this.slot(name);
    this.load(held);
    this.code.movRegReg(RDI, RAX);
    this.runtime("_release");
  }

  /* ---------------------------------------------------------------------- */
  /* Values                                                                 */
  /* ---------------------------------------------------------------------- */

  /** A value read as the type a use fixes it at. */
  private at(value: SemanticValue, as: SemanticType | null): void {
    this.value(value);
    if (as === null) return;
    this.convert(value.type, as);
  }

  /**
   * A value in the accumulator: a whole number or a reference in `rax`, a float
   * in `xmm0`, and a whole number widened to fill the register so that a value
   * is always the number its type names and never the bits of something wider.
   */
  private value(value: SemanticValue): void {
    switch (value.k) {
      case "const":
        this.constant(value);
        return;
      case "bool":
        this.code.movRegImm(RAX, value.value ? 1n : 0n);
        return;
      case "nothing":
        this.zero(value.type);
        return;
      case "local":
        this.load(this.slot(value.name));
        return;
      case "text":
        this.text(value);
        return;
      case "toText":
        this.asText(value.of);
        return;
      case "call":
        this.callValue(value.call, value.type);
        return;
      case "newObject":
        this.object(value);
        return;
      case "loadField":
        // The offset of the field is the displacement of the read, so the
        // address is not adjusted in a register first: the accumulator is
        // still the object, and the read reaches the field itself.
        this.value(value.object);
        this.readAt(value.type, this.field(value.layout, value.field).offset);
        return;
      case "length":
        this.length(value.of);
        return;
      case "element": {
        // An element is read at the width the array holds it at, and a use
        // that widens it converts it afterwards: an array of single precision
        // numbers read as a double is one element widened, not two.
        const element = elementTypeOf(value.of.type) ?? value.type;
        this.addressOf(value.of, value.index, element);
        this.readAt(element);
        this.convert(element, value.type);
        return;
      }
      case "argv":
        if (value.index === null) {
          this.runtime("_argv_count");
          return;
        }
        this.at(value.index, USIZE);
        this.code.movRegReg(RDI, RAX);
        this.runtime("_argv");
        return;
      case "isNull":
        this.value(value.operand);
        this.code.test(RAX);
        this.code.setcc(value.negate ? "ne" : "e", RAX);
        this.code.movzxReg8(RAX, RAX);
        return;
      case "unary":
        this.unary(value);
        return;
      case "arith":
        this.arithmetic(value);
        return;
      case "compare":
        this.comparison(value);
        return;
      case "logical":
        this.logical(value);
        return;
      case "coalesce":
        this.coalesce(value);
        return;
      case "select":
        this.select(value);
        return;
      case "buffer":
        this.buffer(value);
        return;
    }
  }

  private zero(type: SemanticType): void {
    if (isFloat(type)) {
      this.code.xorFloat(XMM0, XMM0);
      return;
    }
    this.code.movRegImm(RAX, 0n);
  }

  private constant(value: SemanticValue & { k: "const" }): void {
    if (isFloat(value.type)) {
      const single = widthOf(value.type) === 4;
      this.code.movsLoadLabel(XMM0, this.floatLiteral(floatBits(Number(decimalText(value.text)), single)), single);
      return;
    }
    const whole = integerText(value.text);
    this.code.movRegImm(RAX, whole);
    // A literal already the number its type holds needs nothing written after
    // it: the register already holds it at its own width, and narrowing it is
    // the same value read back. One instruction per literal, for nothing.
    if (!this.writtenWhole(whole, value.type)) this.normalize(value.type);
  }

  /**
   * Whether a whole number written out is already the number its type holds.
   *
   * The test is the literal's own range and not the width of the register it
   * was written into: a negative literal is sign-extended, and an unsigned
   * type keeps a top bit the register has already filled with zeros.
   */
  private writtenWhole(value: bigint, type: SemanticType): boolean {
    if (value < 0n) return false;
    const top = 1n << BigInt(widthOf(type) * 8);
    if (value >= top) return false;
    return isUnsigned(type) || value < top / 2n;
  }

  /* ---------------------------------------------------------------------- */
  /* Operations                                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * An operation whose two sides are in place: the accumulator holds the left
   * and the scratch register the right. A division is the one that cannot be
   * written in place, because the machine divides the accumulator widened to
   * twice its width and answers in two registers.
   */
  private apply(operation: Arithmetic, type: SemanticType): void {
    if (isFloat(type)) {
      const names = { add: "add", sub: "sub", mul: "mul", div: "div" } as const;
      if (operation in names) this.code.sse(names[operation as "add" | "sub" | "mul" | "div"], XMM0, XMM1, widthOf(type) === 4);
      return;
    }
    const wide = operationWidth(type) === 8;
    switch (operation) {
      case "add":
      case "sub":
      case "and":
      case "or":
      case "xor":
        this.code.alu(operation, RAX, RCX, wide);
        return;
      case "mul":
        this.code.imul(RAX, RCX, wide);
        return;
      case "shl":
      case "ushr":
      case "shr":
        // A shift right keeps the sign of a signed number and fills a whole
        // number with zeros of an unsigned one, which is what the sign of the
        // type says; `>>>` is the one that fills with zeros either way. The
        // count is taken at the width the language carries the shift out at,
        // which is the width the sides were promoted to.
        this.code.aluImm("and", RCX, wide ? 63 : 31);
        this.code.shift(shiftOf(operation, type), RAX, wide);
        return;
      case "div":
      case "mod": {
        // A division is of twice the width of the number, and what the high
        // half holds is what says whether the two are read as signed: a sign
        // repeated for a signed number, and nothing at all for an unsigned one.
        const unsigned = isUnsigned(type);
        if (unsigned) this.code.alu("xor", RDX, RDX, false);
        else this.code.signExtend(wide);
        this.code.divide(unsigned ? "div" : "idiv", RCX, wide);
        if (operation === "mod") this.code.movRegReg(RAX, RDX);
        return;
      }
      default:
        throw machineError(`${this.fn.symbol} performs ${operation}, which is not an operation of a number`);
    }
  }

  /** One, added to or taken from the value the accumulator has. */
  private one(type: SemanticType, operation: "add" | "sub", register = RAX): void {
    if (isFloat(type)) {
      const single = widthOf(type) === 4;
      // The destination is named by the caller because a float counter the loop
      // was given a register for is stepped where it lies, and the accumulator a
      // counter with no register of its own is stepped in is XMM0 — which is
      // what the whole-number default is, the two being numbered from one zero.
      this.code.sseMemLabel(operation, register, this.floatLiteral(floatBits(1, single)), single);
      return;
    }
    this.code.aluImm(operation, register, 1, operationWidth(type) === 8);
  }

  /**
   * A number as the float a register reads, at the precision asked for. The
   * register is named by the caller because one is the other side of an
   * operation and one is the only register left when a value is in the
   * accumulator and the scratch beside it.
   */
  private floatConstant(value: number, type: SemanticType, destination: number): void {
    const single = widthOf(type) === 4;
    this.code.movsLoadLabel(destination, this.floatLiteral(floatBits(value, single)), single);
  }

  /**
   * A comparison as a number: one when it holds and zero when it does not. The
   * accumulator holds the left side and the slot the right, and every
   * comparison of a value that is not a number is false.
   *
   * `UCOMISD` sets all three of the ordered flags at once when either side is
   * not a number, so the carry the below conditions read is set on exactly the
   * comparison that must be false: `CF` fires `b` and `be`, and the two
   * conditions above it stay false because the same instruction clears their
   * carry. The parity flag is the one that says a comparison was ordered, so
   * the two conditions that read the carry are gated on it — the same pair the
   * equal arms below gate on, for the same reason.
   */
  private compare(type: SemanticType, op: CompareOp, right: Held | number): void {
    if (isFloat(type)) {
      const single = widthOf(type) === 4;
      if (typeof right === "number") this.code.movsLoadLabel(XMM1, this.floatLiteral(floatBits(right, single)), single);
      else this.code.movsLoad(XMM1, frame(right.offset), single);
      this.code.sseCompare(XMM0, XMM1, single, true);
      switch (op) {
        case "lt":
        case "le":
          this.code.setcc(op === "lt" ? "b" : "be", RAX);
          this.code.setcc("np", RCX);
          this.code.alu8("and", RAX, RCX);
          break;
        case "gt":
          this.code.setcc("a", RAX);
          break;
        case "ge":
          this.code.setcc("ae", RAX);
          break;
        case "eq":
          // Equal and ordered: a value that is not a number compares equal to
          // nothing at all, and the parity bit is what says so.
          this.code.setcc("e", RAX);
          this.code.setcc("np", RCX);
          this.code.alu8("and", RAX, RCX);
          break;
        case "ne":
          this.code.setcc("ne", RAX);
          this.code.setcc("p", RCX);
          this.code.alu8("or", RAX, RCX);
          break;
      }
      this.code.movzxReg8(RAX, RAX);
      return;
    }
    this.cmpHeld(type, right);
    this.code.setcc(COMPARISON[signedOf(type) ? "signed" : "unsigned"][op], RAX);
    this.code.movzxReg8(RAX, RAX);
  }

  /**
   * A comparison of two whole numbers, left in the flags rather than turned
   * into a number. The accumulator holds the left side and the other is a slot
   * in the frame or a number in the instruction, and both sides are compared
   * at the width the language promotes them to.
   */
  private cmpHeld(type: SemanticType, right: Held | number): void {
    if (typeof right === "number") {
      this.code.aluImm("cmp", RAX, right, operationWidth(type) === 8);
      return;
    }
    if (operationWidth(type) === 8) {
      // A whole register wide, so the comparison reads the number where it
      // lies rather than through a copy of it in the scratch. Reading it as a
      // full register was a 64-bit read of a slot a 32-bit store had written,
      // so the compare ran against whatever the upper half of the frame held.
      this.code.aluRegMem("cmp", RAX, frame(right.offset), true);
      return;
    }
    // Narrower, so the read has to widen the number the way the language reads
    // it before it can be compared as one.
    this.code.movRegMemSized(RCX, frame(right.offset), operationWidth(type), signedOf(type));
    this.code.alu("cmp", RAX, RCX, false);
  }
  /**
   * A branch on a comparison: the comparison is left in the flags and the
   * branch reads them there, so the condition byte the value form would have
   * widened into the accumulator is never written at all. This is what a
   * counted loop's test, an `if` and the loops come down to when the IR hands
   * them a comparison — a `movzx` sets the zero flag from the very byte it
   * widens, so the `test` that used to follow it was reading a flag the
   * instruction before it had already set.
   *
   * A float is answered the other way, for the reason the value form above
   * states: the conditions that read the carry a `UCOMISD` leaves have to be
   * gated on the parity bit, which is two instructions rather than one. The
   * number the comparison makes is widened by a `movzx`, which sets the zero
   * flag, so the branch on it is a `jcc` on that flag and not a `test` on it.
   */
  private comparedBranch(type: SemanticType, op: CompareOp, right: Held | number, whenTrue: boolean, label: string, left = RAX): void {
    if (isFloat(type)) {
      const single = widthOf(type) === 4;
      // The comparison reads XMM0 and XMM1, so a side the build gave a register
      // of its own is moved into one of those rather than read out of the frame
      // it is not in. `left` is XMM0 already whenever it is the accumulator,
      // which is what the whole-number default register is.
      if (left !== XMM0) this.code.movsMove(XMM0, left, single);
      if (typeof right === "number") this.code.movsLoadLabel(XMM1, this.floatLiteral(floatBits(right, single)), single);
      else if (right.register !== null) this.code.movsMove(XMM1, right.register, single);
      else this.code.movsLoad(XMM1, frame(right.offset), single);
      this.floatBranch(op, single, whenTrue, label);
      return;
    }
    const width = operationWidth(type);
    const condition = COMPARISON[signedOf(type) ? "signed" : "unsigned"][op];
    // Both sides are compared at the width the language promotes them to, and
    // the operand is read at that width too. Reading it as a full register was
    // a 64-bit read of a slot a 32-bit store had written, so the compare ran
    // against whatever the upper half of the frame held: a counted loop whose
    // bound was a small number never reached it and ran until the counter
    // overflowed.
    if (typeof right === "number") {
      this.code.aluImm("cmp", left, right, width === 8);
    } else if (width === 8) {
      // A whole register wide, so the read fills the register and the
      // comparison can read it where it lies rather than through a copy of it
      // in the scratch.
      this.code.aluRegMem("cmp", left, frame(right.offset), true);
    } else {
      // Narrower, so the read has to widen the number the way the language
      // reads it before it can be compared as one.
      this.code.movRegMemSized(RCX, frame(right.offset), width, signedOf(type));
      this.code.alu("cmp", left, RCX, false);
    }
    this.code.jcc(whenTrue ? condition : NEGATED[condition], label);
  }

  /**
   * A branch on a comparison of two floats, answered by the flags themselves.
   *
   * The value form of the same comparison writes two condition bytes and
   * combines them into the accumulator, which is a number a branch then has
   * to test. A branch wants no number, so the comparison is left where it is
   * and the jump reads it there.
   *
   * The sides are compared the other way round, and that is what makes the
   * conditions above the carry the ones the language asks for. `UCOMISD`
   * compares without a sign, so an unordered pair sets every flag below the
   * carry and clears every one above it: with the right side as the one being
   * compared, `a < b` is `b > a` is "above", which an unordered pair cannot
   * set, and `a > b` is "below", which it can, so that one takes the parity bit
   * as a jump of its own rather than as an instruction that combines it with a
   * condition afterwards.
   */
  private floatBranch(op: CompareOp, single: boolean, whenTrue: boolean, label: string): void {
    this.code.sseCompare(XMM1, XMM0, single, true);
    const condition =
      op === "lt" ? "a"
      : op === "le" ? "ae"
      : op === "gt" ? "b"
      : op === "ge" ? "be"
      : op === "eq" ? "e"
      : "ne";
    if (op === "lt" || op === "le") {
      this.code.jcc(whenTrue ? condition : NEGATED[condition], label);
      return;
    }
    // A comparison that was not ordered is false whichever way the branch
    // reads it, so both jumps take the same label: the first for a pair that
    // is not numbers, the second for the condition the language does answer.
    this.code.jcc("p", label);
    this.code.jcc(whenTrue ? condition : NEGATED[condition], label);
  }

  /**
   * The label a float the program wrote out is read at, or null when this
   * value cannot be reached there: it is not a literal, it is at the other
   * precision than the operation reads — which would need a conversion the
   * instruction has none of — or the operation has no form that takes memory.
   */
  private floatOperand(value: SemanticValue, type: SemanticType, op: string): string | null {
    if (!isFloat(type) || value.k !== "const" || !isFloat(value.type)) return null;
    if (FLOAT_OPERATION[op] !== true || widthOf(value.type) !== widthOf(type)) return null;
    return this.floatLiteral(floatBits(Number(decimalText(value.text)), widthOf(type) === 4));
  }

  /**
   * The number a comparison could carry on its other side instead of a
   * register, or null when what the value is cannot be written as one.
   *
   * A whole number is carried by the instruction's own immediate field, and a
   * float by the read-only data the instruction reads it out of, so neither is
   * written into a slot of the frame and read back out of it. Every place a
   * comparison is written already has a form that reads its other side from
   * one place or the other; this is what decides which.
   *
   * A float is only carried where the instruction can read it at the precision
   * the comparison is made at, and a whole number only where the immediate
   * fields encode it — a sign-extended byte or a sign-extended word.
   */
  private literalOf(value: SemanticValue, type: SemanticType): number | null {
    if (value.k === "bool") return isFloat(type) ? null : value.value ? 1 : 0;
    if (value.k !== "const") return null;
    if (isFloat(type)) {
      // A float the program wrote out at the other precision is a conversion
      // the instruction has no form of, so it is left to the frame.
      if (!isFloat(value.type) || widthOf(value.type) !== widthOf(type)) return null;
      const parsed = Number(decimalText(value.text));
      // A value that is not a number has no bits to be laid down, and the
      // answer it gives is the one the operation would have given anyway.
      return Number.isNaN(parsed) ? null : parsed;
    }
    const parsed = integerText(value.text);
    if (parsed < -0x8000_0000n || parsed > 0x7fff_ffffn) return null;
    return Number(parsed);
  }

  /**
   * The number an instruction could carry instead of a register, or null when
   * what the value is cannot be written into one.
   *
   * A literal is the same number wherever it is written, so the instruction
   * that consumes it takes it as an immediate and the frame never holds it.
   * The range is the one the immediate forms encode — a sign-extended byte or
   * a sign-extended word — which is every literal a program of this language
   * writes in practice.
   */
  private immediateOf(value: SemanticValue, type: SemanticType): number | null {
    if (isFloat(type)) return null;
    if (value.k === "bool") return value.value ? 1 : 0;
    if (value.k !== "const") return null;
    const parsed = integerText(value.text);
    if (parsed < -0x8000_0000n || parsed > 0x7fff_ffffn) return null;
    return Number(parsed);
  }

  /**
   * An operation whose other side is a number written into the instruction.
   * Only `IMMEDIATE_OPERATIONS` reaches here; the two that have no such form
   * are refused by the caller before the left side is written, so the throw at
   * the end of this is the assertion that neither of them ever arrives.
   */
  private applyImmediate(
    operation: Arithmetic,
    type: SemanticType,
    value: number,
  ): void {
    const wide = operationWidth(type) === 8;
    switch (operation) {
      case "add":
      case "sub":
      case "and":
      case "or":
      case "xor":
        this.code.aluImm(operation, RAX, value, wide);
        return;
      case "mul":
        this.code.imulImm(RAX, value, wide);
        return;
      case "shl":
      case "ushr":
      case "shr":
      case "sar":
        // The count of a shift is taken at the width the language masks it to,
        // and the mask is applied here rather than left to the machine, so the
        // count this form carries is the count the language computes.
        this.code.shiftImm(shiftOf(operation, type), RAX, value & (wide ? 63 : 31), wide);
        return;
      default:
        throw machineError(`${this.fn.symbol} performs ${operation} by a number written out, which the machine has no instruction for`);
    }
  }

  private arithmetic(value: SemanticValue & { k: "arith" }): void {
    const type = value.type;
    if (value.op === "concat") {
      this.concat(value.left, value.right, type);
      return;
    }
    if (value.op === "pow") {
      this.at(value.right, NUMBER);
      const right = this.hold(NUMBER, "blaze_right");
      this.store(right);
      this.at(value.left, NUMBER);
      this.scratchFrom(right);
      this.library("pow");
      return;
    }
    if (value.op === "min" || value.op === "max") {
      this.between(value, value.op === "min");
      return;
    }
    // A right side the program wrote out is carried by the instruction rather
    // than by a slot: an immediate for a whole number, and a literal in the
    // read-only data for a float, so neither is copied into the frame and read
    // back out of it, and the eight bytes the copy lived in are not reserved
    // at all. A sum and a product take their sides either way round, so a
    // literal on either side is carried by the instruction; a difference and a
    // quotient may not, and a literal is only the left side of those. The side
    // that is not the literal is written once whichever form is taken, so the
    // question is settled before it is evaluated.
    const commutative = value.op === "add" || value.op === "mul";
    const onRight = this.floatOperand(value.right, type, value.op);
    const literal = onRight ?? (commutative ? this.floatOperand(value.left, type, value.op) : null);
    if (literal !== null) {
      this.at(onRight === null ? value.right : value.left, type);
      this.code.sseMemLabel(value.op as "add" | "sub" | "mul" | "div", XMM0, literal, widthOf(type) === 4);
      this.normalizeArithmetic(type);
      return;
    }
    const immediate = this.immediateOf(value.right, type);
    if (immediate !== null && IMMEDIATE_OPERATIONS[value.op] === true) {
      this.at(value.left, type);
      this.applyImmediate(value.op, type, immediate);
      this.normalizeArithmetic(type);
      return;
    }
    // A float operation reads its other side out of the frame itself, so the
    // side that is not in the accumulator when the operation is written is
    // stored once and the instruction does the reading, which is one
    // instruction instead of the pair that reads a value out and then
    // operates on it. A sum and a product take their sides either way round,
    // which also means the right side is never written down: a call that
    // answers into the accumulator is consumed where it lands. A difference
    // and a quotient may not, so they keep the order they had.
    if (isFloat(type)) {
      const commutative = value.op === "add" || value.op === "mul";
      this.at(commutative ? value.left : value.right, type);
      const memory = this.hold(type, commutative ? "blaze_left" : "blaze_right");
      this.store(memory);
      this.at(commutative ? value.right : value.left, type);
      if (memory.register === null) {
        this.code.sseMem(value.op as "add" | "sub" | "mul" | "div", XMM0, frame(memory.offset), widthOf(type) === 4);
        this.normalizeArithmetic(type);
        return;
      }
      this.scratchFrom(memory);
      this.apply(value.op, type);
      this.normalizeArithmetic(type);
      return;
    }
    this.at(value.right, type);
    const right = this.hold(type, "blaze_right");
    this.store(right);
    this.at(value.left, type);
    this.scratchFrom(right);
    this.apply(value.op, type);
    this.normalizeArithmetic(type);
  }

  /**
   * The smaller or the larger of two numbers. Each side answers once, so both
   * are read first: a value the IR calls is a call that would otherwise run
   * twice.
   *
   * A whole number is a move on a condition rather than a branch, which is
   * what the comment here used to say it could not be. It could not be for a
   * choice between two registers, and it is not for a comparison either:
   * `CMOVcc` reads the flags `CMP` left, so the answer is the same one the
   * branch chose, chosen without a guess and without paying for a guess.
   *
   * A float is not. `MINSD` and `MAXSD` answer with their source whenever the
   * comparison does not hold, and a comparison against a value that is not a
   * number never holds — so the instruction cannot say which side was at
   * fault, and `min(NaN, 2)` and `min(2, NaN)` come out the same way whichever
   * way round they are encoded. The language answers both with the right side,
   * and a signed zero is equal to a positive one rather than less than it, so
   * `min(-0.0, 0.0)` is a positive zero. An instruction that answers a pair
   * the wrong way is not a faster branch, it is a different program, so the
   * float keeps the branch and the whole number takes the move.
   */
  private between(value: SemanticValue & { k: "arith" }, smaller: boolean): void {
    const type = value.type;
    const low = this.hold(type, "blaze_low");
    const high = this.hold(type, "blaze_high");
    this.at(value.left, type);
    this.store(low);
    this.at(value.right, type);
    this.store(high);
    if (!isFloat(type)) {
      this.load(low);
      this.scratchFrom(high);
      // The answer is the right side when the comparison does not hold, so the
      // move is written on the condition that says so. The sides are compared
      // at the width the language promotes them to, and that comparison is
      // left in the flags for the move to read.
      this.code.alu("cmp", RAX, RCX, operationWidth(type) === 8);
      const away = COMPARISON[signedOf(type) ? "signed" : "unsigned"][smaller ? "lt" : "gt"];
      this.code.cmov(NEGATED[away], RAX, RCX, operationWidth(type) === 8);
      this.normalizeArithmetic(type);
      return;
    }
    const end = this.code.label("Lpick");
    const keep = this.code.label("Lkeep");
    // The comparison is a value of its own, so the arm it answers with is read
    // again rather than kept in a register through it.
    this.load(low);
    this.compare(type, smaller ? "lt" : "gt", high);
    this.code.test(RAX);
    this.code.jcc("ne", keep);
    this.load(high);
    this.code.jmp(end);
    this.code.bind(keep);
    this.load(low);
    this.code.bind(end);
  }

  private comparison(value: SemanticValue & { k: "compare" }): void {
    const type = value.operand;
    if (isTextType(type)) {
      const left = this.hold(type, "blaze_left");
      const right = this.hold(type, "blaze_right");
      this.at(value.left, TEXT);
      this.store(left);
      this.at(value.right, TEXT);
      this.store(right);
      this.textOrder(value.op, left, right);
      return;
    }
    // An other side the program wrote out is carried by the comparison itself,
    // so it is never written to the frame and read back out of it.
    const written = this.literalOf(value.right, type);
    if (written !== null) {
      this.at(value.left, type);
      this.compare(type, value.op, written);
      this.normalize(value.type);
      return;
    }
    const right = this.hold(type, "blaze_right");
    this.at(value.right, type);
    this.store(right);
    this.at(value.left, type);
    // The left side is already in the accumulator and stays there: writing it
    // to a slot and reading it back is two instructions that answer nothing.
    this.compare(type, value.op, right);
    this.normalize(value.type);
  }

  /**
   * Which of two strings is the greater, as a number: negative, zero or
   * positive. A string built at run time and one written out are two addresses
   * that can say the same thing, so what they say is compared and not where
   * they are. An absent string is nothing, so it is equal to another absent
   * string and to no other.
   */
  private textOrder(op: CompareOp, left: Held, right: Held): void {
    this.code.movRegMem(RAX, frame(left.offset));
    this.code.movRegMem(RCX, frame(right.offset));
    this.code.alu("cmp", RAX, RCX);
    const byAddress = this.code.label("Lorder");
    const joined = this.code.label("Ljoined");
    this.code.jcc("e", byAddress);
    this.code.test(RAX);
    this.code.jcc("e", byAddress);
    this.code.test(RCX);
    this.code.jcc("e", byAddress);
    this.code.movRegReg(RDI, RAX);
    this.code.movRegReg(RSI, RCX);
    this.library("strcmp");
    this.code.jmp(joined);
    this.code.bind(byAddress);
    this.code.alu("sub", RAX, RCX);
    this.code.bind(joined);
    this.code.aluImm("cmp", RAX, 0);
    const conditions: Record<CompareOp, "e" | "ne" | "l" | "le" | "g" | "ge"> = {
      eq: "e",
      ne: "ne",
      lt: "l",
      le: "le",
      gt: "g",
      ge: "ge",
    };
    this.code.setcc(conditions[op], RAX);
    this.code.movzxReg8(RAX, RAX);
  }

  /**
   * `&&`, `||` and `??` each answer one of two values, and the left one is
   * answered by deciding on it. The left arm is left in the accumulator and
   * the branch reads it there; it is only written down first when the right
   * arm can take the accumulator away from it, which a call does. A call in
   * the right arm is the only thing that clobbers the accumulator — every
   * other operation the IR makes writes through the frame — so a right arm
   * with no call in it leaves the left one where it is and the frame slot it
   * used to take is not reserved at all.
   */
  private logical(value: SemanticValue & { k: "logical" }): void {
    const otherwise = this.code.label("Larm");
    const end = this.code.label("Lend");
    const keep = hasCall(value.right);
    if (!keep && value.left.k === "compare" && isBoolean(value.left.type) && typeEquals(value.left.type, value.type)) {
      // A truth answered by a comparison is the other arm when the comparison
      // does not hold, and a comparison that does not hold is the one truth it
      // can be: so the deciding arm is written down rather than kept, and the
      // comparison is asked of the flags instead of being written as a number
      // first. A `(a < b) && c` is then a comparison and a jump where it was a
      // comparison, a condition byte, a widening, a test and a jump.
      this.truthBranch(value.left, value.op === "and", otherwise);
      this.at(value.right, value.type);
      this.code.jmp(end);
      this.code.bind(otherwise);
      this.code.movRegImm(RAX, value.op === "and" ? 0n : 1n);
      this.code.bind(end);
      return;
    }
    const arm = keep ? this.hold(value.left.type, "blaze_arm") : null;
    this.value(value.left);
    if (arm !== null) this.store(arm);
    this.truthOfAccumulator(value.left.type);
    this.code.jcc(value.op === "and" ? "e" : "ne", otherwise);
    this.at(value.right, value.type);
    this.code.jmp(end);
    this.code.bind(otherwise);
    if (arm !== null) this.load(arm);
    this.convert(value.left.type, value.type);
    this.code.bind(end);
  }

  private coalesce(value: SemanticValue & { k: "coalesce" }): void {
    const kind = valueKind(value.left);
    if (kind !== "null" && kind !== "reference" && !isTextType(value.left.type)) {
      this.value(value.left);
      return;
    }
    const otherwise = this.code.label("Larm");
    const end = this.code.label("Lend");
    // An absent string is an absent pointer and an absent reference is one
    // too, so the test is the same one the `||` above asks: is the value zero.
    // It is asked of the accumulator the arm is already in, unless the right
    // arm is a call and would take the accumulator away from it.
    const keep = hasCall(value.right);
    const arm = keep ? this.hold(value.left.type, "blaze_arm") : null;
    this.value(value.left);
    if (arm !== null) this.store(arm);
    this.code.test(RAX);
    this.code.jcc("e", otherwise);
    this.convert(value.left.type, value.type);
    this.code.jmp(end);
    this.code.bind(otherwise);
    this.at(value.right, value.type);
    this.code.bind(end);
  }

  private select(value: SemanticValue & { k: "select" }): void {
    const otherwise = this.code.label("Larm");
    const end = this.code.label("Lend");
    this.truthBranch(value.condition, false, otherwise);
    this.at(value.then, value.type);
    this.code.jmp(end);
    this.code.bind(otherwise);
    this.at(value.otherwise, value.type);
    this.code.bind(end);
  }

  private unary(value: SemanticValue & { k: "unary" }): void {
    switch (value.op) {
      case "pos":
        this.value(value.operand);
        return;
      case "not": {
        if (value.operand.k === "compare" && !isTextType(value.operand.operand)) {
          // The comparison leaves the answer in the flags and `not` is the
          // other sense of it, so the condition byte is written from those
          // flags. The general form writes the answer down as a number first
          // and then asks whether that number is zero.
          this.comparedNegated(value.operand);
          return;
        }
        // The truth of the operand is asked of the accumulator it is already
        // in: it does not have to be written down and read back to be asked
        // about, and `not` is the one operation that changes no bit of it.
        this.truth(value.operand);
        this.code.setcc("e", RAX);
        this.code.movzxReg8(RAX, RAX);
        return;
      }
      case "bitNot":
        this.value(value.operand);
        this.code.not(RAX);
        this.normalize(value.type);
        return;
      case "neg": {
        const type = value.operand.type;
        this.value(value.operand);
        if (isFloat(type)) {
          // The sign of a float is its highest bit, so a negation turns that one
          // over rather than subtracting from nothing.
          this.code.movRegImm(RAX, widthOf(type) === 4 ? -0x8000_0000n : -0x8000_0000_0000_0000n);
          this.code.movdXmm(XMM1, RAX);
          this.code.xorFloat(XMM0, XMM1);
          return;
        }
        this.code.neg(RAX);
        this.normalize(value.type);
        return;
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Text                                                                   */
  /* -------------------------------------------------------------------------- */

  /**
   * A string, as the pointer the runtime hands out. Text the program wrote is a
   * literal in the read-only data; a value interpolated into it is written by
   * the runtime's own formatter, so a number read into a string is written the
   * way the source language writes it and not by this backend.
   */
  private text(value: SemanticValue & { k: "text" }): void {
    if (value.parts.every((part) => part.k === "text")) {
      this.literal(value.parts.map((part) => (part.k === "text" ? part.value : "")).join(""));
      this.code.leaLabel(RAX, this.lastLiteral);
      return;
    }
    // Every part is measured before the string is laid out, so the buffer that
    // holds it is exactly as long as the parts are.
    const parts = value.parts.map(() => ({ pointer: this.hold(POINTER, "blaze_part"), length: this.hold(USIZE, "blaze_length") }));
    value.parts.forEach((part, at) => {
      if (part.k === "text") {
        this.literal(part.value);
        this.code.leaLabel(RAX, this.lastLiteral);
        this.store(parts[at].pointer);
        this.code.movRegImm(RAX, BigInt(Buffer.byteLength(part.value, "utf8")));
        this.store(parts[at].length);
        return;
      }
      // A part that came back measured is as long as it says, and one that did
      // not is text to begin with, which is the only shape left to measure.
      const measured = this.asTextPart(part.value, parts[at].length);
      this.store(parts[at].pointer);
      if (!measured) {
        this.code.movRegReg(RDI, RAX);
        this.library("strlen");
        this.store(parts[at].length);
      }
    });
    const total = this.hold(USIZE, "blaze_total");
    this.code.movRegImm(RAX, 0n);
    for (const part of parts) {
      this.code.aluRegMem("add", RAX, frame(part.length.offset));
    }
    this.store(total);
    this.code.movRegMem(RAX, frame(total.offset));
    this.code.aluImm("add", RAX, 1);
    this.code.movRegReg(RDI, RAX);
    this.runtime("_allocate");
    const buffer = this.hold(POINTER, "blaze_text");
    this.store(buffer);
    const filled = this.hold(USIZE, "blaze_filled");
    this.code.movRegImm(RAX, 0n);
    this.store(filled);
    // A part of nothing is copied by a copy of nothing, and the guard that
    // used to skip it was downstream of the measure: a part that is not measured
    // is measured with `strlen` first, so a null one has already been read.
    for (const part of parts) {
      this.code.movRegMem(RAX, frame(filled.offset));
      this.code.movRegMem(RCX, frame(buffer.offset));
      this.code.lea(RCX, indexed(RCX, RAX, 1));
      this.code.movRegReg(RDI, RCX);
      this.code.movRegMem(RSI, frame(part.pointer.offset));
      this.code.movRegMem(RDX, frame(part.length.offset));
      this.library("memcpy");
      this.code.movRegMem(RAX, frame(filled.offset));
      this.code.aluRegMem("add", RAX, frame(part.length.offset));
      this.store(filled);
    }
    // The terminator is the byte after the last one written, and the value the
    // body reads is the buffer itself.
    this.code.movRegMem(RAX, frame(filled.offset));
    this.code.movRegMem(RCX, frame(buffer.offset));
    this.code.lea(RAX, indexed(RCX, RAX, 1));
    this.code.movRegReg(RCX, RAX);
    this.code.alu("xor", RAX, RAX, false);
    this.code.movMemRegSized(mem(RCX), RAX, 1);
    this.code.movRegMem(RAX, frame(buffer.offset));
  }

  /**
   * A text written to the output. A template is written a part at a time, which
   * is what a person reading the output would have done, and it is what the
   * output is: nothing holds the text but this statement, so laying the parts
   * out in a buffer to read the whole thing back is a copy, an allocation and a
   * measure of a string that is already known to be exactly as long as its
   * parts. The output is buffered by the runtime either way, so a part written
   * is not a write to the outside.
   *
   * A text that is a value rather than a template has nowhere to be written as
   * a value but the output, so it is written whole.
   */
  private printText(value: SemanticValue): void {
    const parts = value.k === "text" ? value.parts : null;
    const writes = parts === null ? 0 : parts.filter((part) => part.k !== "text").length;
    if (parts === null || (parts.length > 0 && writes === 0)) {
      this.value(value);
      this.code.movRegReg(RDI, RAX);
      this.runtime("_print_text");
      return;
    }
    // One part is kept measured for as long as the statement lasts, and it is
    // the only one that can need a slot: every other length is written where
    // the runtime returned it or read as a constant.
    const length = this.hold(USIZE, "blaze_length");
    for (const part of parts) {
      if (part.k === "text") {
        this.literal(part.value);
        this.code.leaLabel(RAX, this.lastLiteral);
        this.code.movRegReg(RDI, RAX);
        this.code.movRegImm(RSI, BigInt(Buffer.byteLength(part.value, "utf8")));
      } else {
        // A part that arrived without a length is text to begin with, and the
        // only shape left to measure.
        const measured = this.asTextPart(part.value, length);
        this.code.movRegReg(RDI, RAX);
        if (!measured) {
          this.library("strlen");
          this.code.movRegReg(RSI, RAX);
        } else {
          this.code.movRegMem(RSI, frame(length.offset));
        }
      }
      this.runtime("_print_text_n");
    }
  }

  /**
   * A part of a text as the text it is, with its length where the caller asked
   * for it. A template writes the conversion around what it interpolates, and
   * the conversion is unwrapped here rather than lowered: it is text already by
   * its own type, so handing it to `asText` whole would read it as a string
   * that arrives without a length and measure the bytes the conversion had
   * just counted.
   */
  private asTextPart(value: SemanticValue, measured: Held | null): boolean {
    let inner = value;
    while (inner.k === "toText") inner = inner.of;
    return this.asText(inner, measured);
  }

  /**
   * A value as text, as the source language prints one. A number is written by
   * the runtime's own formatter, so it reads the way the source writes it; a
   * truth and an absence are the words the source prints, and a reference that
   * is there is the address the driver prints for one.
   *
   * The length of the text is written to `measured` wherever the text is
   * written already measured: a word is a constant, and the runtime hands back
   * the count of what it formatted. Only a value that is text to begin with
   * carries no length, and a caller that needs one measures that itself. The
   * return says which of the two happened, so the caller reads a part that
   * arrived measured for nothing and measures the rest.
   */
  private asText(value: SemanticValue, measured: Held | null = null): boolean {
    /** A word written in place of a value, which is as long as the word is. */
    const word = (text: string): void => {
      if (measured !== null) {
        this.code.movRegImm(RAX, BigInt(Buffer.byteLength(text, "utf8")));
        this.store(measured);
      }
      this.literal(text);
      this.code.leaLabel(RAX, this.lastLiteral);
    };

    if (isTextType(value.type)) {
      this.value(value);
      return false;
    }
    if (valueKind(value) === "null") {
      word("null");
      return true;
    }
    if (isBoolean(value.type)) {
      const otherwise = this.code.label("Lword");
      const end = this.code.label("Lend");
      this.value(value);
      this.code.test(RAX);
      this.code.jcc("e", otherwise);
      word("true");
      this.code.jmp(end);
      this.code.bind(otherwise);
      word("false");
      this.code.bind(end);
      return true;
    }
    if (isReference(value.type)) {
      const pointer = this.hold(value.type, "blaze_reference");
      const otherwise = this.code.label("Lword");
      const end = this.code.label("Lend");
      this.value(value);
      this.store(pointer);
      this.code.movRegMem(RAX, frame(pointer.offset));
      this.code.test(RAX);
      this.code.jcc("e", otherwise);
      this.code.movdXmm(XMM0, RAX);
      this.formatNumber(measured);
      this.code.jmp(end);
      this.code.bind(otherwise);
      word("null");
      this.code.bind(end);
      return true;
    }
    this.at(value, NUMBER);
    this.formatNumber(measured);
    return true;
  }

  /**
   * The accumulator holding the text of the number `xmm0` holds, and how long
   * that text is, written to `measured`. The runtime counts what it writes, so
   * counting it again over the result reads it a second time for an answer the
   * first read already gave.
   */
  private formatNumber(measured: Held | null): void {
    const buffer = this.scratch(64, "blaze_number");
    this.code.lea(RDI, frame(buffer));
    this.code.movRegImm(RSI, 64n);
    this.runtime("_format_number");
    // The formatter writes a terminator of its own, and one is written here as
    // well: the buffer is this function's own, and the length it is given is
    // where the string ends.
    this.code.movRegReg(RCX, RAX);
    if (measured !== null) this.code.movMemRegSized(frame(measured.offset), RCX, 8);
    this.code.lea(RAX, frame(buffer));
    this.code.alu("xor", RDX, RDX, false);
    this.code.movMemRegSized(indexed(RAX, RCX, 1), RDX, 1);
    this.code.lea(RAX, frame(buffer));
  }

  private length(of: SemanticValue): void {
    if (isTextType(of.type)) {
      // A string is as long as its bytes. The runtime counts a string it owns
      // from the header it installed before it, which a string written out in
      // the source does not have, so both are counted as the C library counts
      // them.
      this.value(of);
      this.code.movRegReg(RDI, RAX);
      this.library("strlen");
      return;
    }
    throw machineError(
      `${this.fn.symbol} reads the length of an array, which no machine this compiler writes can answer`,
      "an array reaches a function as a pointer to its first element and no length arrives with it",
    );
  }

  /** Two values as one string, which is what `+` over text and `+=` are. */
  private concat(left: SemanticValue, right: SemanticValue, type: SemanticType): void {
    this.text({
      k: "text",
      type: TEXT,
      parts: [
        { k: "value", value: left },
        { k: "value", value: right },
      ],
    });
    if (!isTextType(type)) this.convert(TEXT, type);
  }

  private literal(text: string): void {
    // A string the program wrote out twice is the same string, so it is laid
    // down once and both places take the address of it.
    const held = this.literals.get(text);
    if (held !== undefined) {
      this.lastLiteral = held;
      return;
    }
    const label = this.code.label("Ltext");
    this.labels.push({ name: label, offset: this.rodata.length });
    for (const byte of Buffer.from(text, "utf8")) this.rodata.push(byte);
    this.rodata.push(0);
    this.literals.set(text, label);
    this.lastLiteral = label;
  }

  /**
   * A float laid down beside the code and read from there by its label.
   *
   * The other way to write a constant is to build it in a register every time
   * it is written: ten bytes of instruction, two of them, and a crossing
   * between the register files each way. A constant the program wrote in the
   * source is the same number everywhere it appears, so it is written once
   * here and read with one instruction at each use — which is what a compiler
   * that lowers a whole program does with a literal it has already seen.
   */
  private floatLiteral(bits: bigint): string {
    const held = this.floatLabels.get(bits.toString());
    if (held !== undefined) return held;
    const label = this.code.label("Lfloat");
    this.labels.push({ name: label, offset: this.rodata.length });
    for (let index = 0; index < 8; index += 1) {
      this.rodata.push(Number((bits >> BigInt(index * 8)) & 0xffn));
    }
    this.floatLabels.set(bits.toString(), label);
    return label;
  }

  /* ---------------------------------------------------------------------- */
  /* Arrays and objects                                                     */
  /* -------------------------------------------------------------------------- */

  /**
   * The address of one element, which is what a read and a write both need
   * before they know the value. The index is read into a slot first, because the
   * sequence may be a value the IR computes and the index may be another.
   */

  /**
   * The index of an element read, or null when it has to be computed.
   *
   * A number the program wrote out is one the instruction can carry. A name is
   * one the frame already holds, but only where reading it is the whole of
   * what the general form does with it: an address is built out of a whole
   * number, so a slot that holds a narrower one is read at its own width and
   * widened, and a float is read as a whole number by a conversion the general
   * form writes. Neither is a plain 64 bit read, so neither takes this path.
   *
   * A name the build gave a register of its own takes this path too, and is
   * read out of that register by `readInto` below. It cannot be read out of the
   * frame: a pinned name has no slot reserved at all, so its distance into the
   * frame is zero, which is the first slot's own address.
   */
  private plainIndex(index: SemanticValue): Held | bigint | null {
    if (index.k === "const") return integerText(index.text);
    if (index.k !== "local") return null;
    const held = this.slot(index.name);
    // A float is not a plain index however it is held. The register a float is
    // pinned to is numbered out of the vector file, so handing it to a whole
    // number register the way a frame slot is handed over reads a different
    // register altogether — number seven being rdi and not xmm7. A float index
    // takes the general form, which converts it into the accumulator first.
    if (isFloat(held.type)) return null;
    if (held.register !== null) return held;
    return widthOf(held.type) !== 8 ? null : held;
  }

  /** The number an index is, in the register the caller asked for. */
  private readInto(held: Held | bigint, register: number): void {
    if (typeof held === "bigint") {
      this.code.movRegImm(register, held);
      return;
    }
    if (held.register !== null) {
      this.code.movRegReg(register, held.register);
      return;
    }
    this.code.movRegMem(register, frame(held.offset));
  }

  private addressOf(sequence: SemanticValue | string, index: SemanticValue, element: SemanticType): void {
    const scale = widthOf(element);
    const base = typeof sequence === "string" ? this.slot(sequence) : sequence.k === "local" ? this.slot(sequence.name) : null;
    // The sequence is a pointer wherever it came from: an array reaches a
    // function as a pointer to its elements, so it is one whole-register read.
    const readable = base !== null && widthOf(base.type) === 8 && !isFloat(base.type);
    const at = readable ? this.plainIndex(index) : null;
    if (readable && base !== null && at !== null) {
      // Both sides are read rather than computed, so neither of them writes a
      // register the other is holding: the address is two reads and one `lea`,
      // where the general form reserves a slot, writes the index into it and
      // reads it back out again.
      this.load(base);
      this.readInto(at, RCX);
      this.code.lea(RAX, indexed(RAX, RCX, scale));
      return;
    }
    const held = this.hold(USIZE, "blaze_index");
    this.at(index, USIZE);
    this.store(held);
    this.value(typeof sequence === "string" ? { k: "local", type: base?.type ?? POINTER, name: sequence } : sequence);
    this.code.movRegReg(RCX, RAX);
    this.code.movRegMem(RAX, frame(held.offset));
    this.code.lea(RAX, indexed(RCX, RAX, scale));
  }

  /**
   * An array the program wrote out, allocated and filled where it was.
   *
   * The address of the array is held in a register across the elements, and
   * each element's offset is the displacement of its own store, so an element
   * costs one instruction rather than three. Which register it is held in is
   * what the rest of this depends on: the scratch register is the fourth
   * argument register, so an element that is a call takes it away and an
   * address kept there has to be written down and read back. A register the
   * convention says a callee leaves alone survives a call, so a function that
   * was given one does not pay that, and one that was not keeps the register
   * it already had and reloads the address for a call-valued element.
   */
  private buffer(value: SemanticValue & { k: "buffer" }): void {
    if (value.length === null) {
      throw machineError(
        `${this.fn.symbol} holds an array whose length the program settled on`,
        "a function is given its arrays, and allocates none of its own",
      );
    }
    this.code.movRegImm(RDI, BigInt(value.length));
    this.code.movRegImm(RSI, BigInt(widthOf(value.element)));
    this.runtime("_array_new");
    const held = this.objectRegister;
    if (held !== null) {
      this.code.movRegReg(held, RAX);
      value.values.forEach((element, at) => {
        this.at(element, value.element);
        this.storeInto(value.element, held, at * widthOf(value.element));
      });
      this.code.movRegReg(RAX, held);
      return;
    }
    const array = this.hold(POINTER, "blaze_array");
    this.store(array);
    this.code.movRegMem(RCX, frame(array.offset));
    value.values.forEach((element, at) => {
      this.at(element, value.element);
      // The address is the value the accumulator held before the element was
      // read, so it is rebuilt where the element took it from.
      if (hasCall(element)) this.code.movRegMem(RCX, frame(array.offset));
      this.storeInto(value.element, RCX, at * widthOf(value.element));
    });
    this.code.movRegReg(RAX, RCX);
  }

  private layout(name: string): ObjectLayout {
    const layout = this.layouts[name];
    if (layout === undefined) throw machineError(`${this.fn.symbol} uses the layout ${name}, which the program does not lay out`);
    return layout;
  }

  private field(layoutName: string, name: string): { name: string; type: string; offset: number } {
    const found = this.layout(layoutName).fields.find((entry) => entry.name === name);
    if (found === undefined) throw machineError(`${this.fn.symbol} uses ${layoutName}.${name}, which the layout does not have`);
    return found;
  }

  /** An object, allocated and filled as one value, on the terms `buffer` above. */
  private object(value: SemanticValue & { k: "newObject" }): void {
    const layout = this.layout(value.layout);
    this.code.movRegImm(RDI, BigInt(layout.size));
    this.code.movRegImm(RSI, BigInt(layout.align));
    this.runtime("_object_new");
    if (this.objectRegister !== null) {
      this.code.movRegReg(this.objectRegister, RAX);
      for (const written of value.fields) {
        const field = this.field(value.layout, written.name);
        const type = parseType(field.type);
        this.at(written.value, type);
        this.storeInto(type, this.objectRegister, field.offset);
      }
      this.code.movRegReg(RAX, this.objectRegister);
      return;
    }
    const object = this.hold(POINTER, "blaze_object");
    this.store(object);
    this.code.movRegMem(RCX, frame(object.offset));
    for (const written of value.fields) {
      const field = this.field(value.layout, written.name);
      const type = parseType(field.type);
      this.at(written.value, type);
      if (hasCall(written.value)) this.code.movRegMem(RCX, frame(object.offset));
      this.storeInto(type, RCX, field.offset);
    }
    this.code.movRegReg(RAX, RCX);
  }

  /* ---------------------------------------------------------------------- */
  /* Calls                                                                  */
  /* -------------------------------------------------------------------------- */

  private callValue(call: SemanticCall, wanted: SemanticType | null): void {
    if (call.builtin) {
      this.builtin(call);
      if (wanted !== null && wanted.kind !== "void") this.convert(call.returns, wanted);
      return;
    }
    // An argument left where it is, rather than written to a slot and read back
    // out of it, is a store and a load saved for a value that never moved.
    //
    // Two forms are left where they are. One is the accumulator, which only the
    // last argument can use because evaluating a later one takes it away. The
    // other is the argument's own register, which a value that is nothing but a
    // read can be read into directly — a recursive call's argument is a field of
    // the parameter, and going through the accumulator for one is a move that
    // answers nothing. That is the last argument too, because an argument
    // register is one a later argument's own evaluation may write, and it is
    // only when nothing goes on the stack, because the arguments that do are
    // written out through the very registers the rest are read into.
    const types = call.args.map((argument, at) => call.argTypes[at] ?? argument.type);
    const spilling = firstArgumentOnStack(types);
    const last = call.args.length - 1;
    const intoLast = spilling === call.args.length ? lastArgumentRegister(types, last) : undefined;
    let fresh = -1;
    let placed = -1;
    const args: (Held | null)[] = call.args.map((argument, at) => {
      const type = types[at];
      // An argument that is a name read at the type the parameter takes is the
      // slot itself: the register the call takes it in is filled from there
      // anyway, and the general form copies it into a slot of its own first.
      if (argument.k === "local") {
        const held = this.slot(argument.name);
        if (typeEquals(held.type, type)) return held;
        // A reference is a pointer whatever it points at, so a slot holding
        // one is already the register the call takes a reference in — the two
        // types are written differently and are the same word.
        if (isReference(held.type) && isReference(type)) return held;
      }
      if (at === last && intoLast !== undefined && this.readIntoRegister(argument, intoLast, type)) {
        placed = at;
        return null;
      }
      const untouched = at === last && spilling === call.args.length;
      if (untouched) fresh = at;
      this.at(argument, type);
      const held = this.hold(type, "blaze_argument");
      if (!untouched) this.store(held);
      return held;
    });
    this.callSymbol(call.signature.symbol, args, call.returns, fresh, placed);
    if (wanted !== null && wanted.kind !== "void") this.convert(call.returns, wanted);
  }


  /**
   * A value that is nothing but reads, read straight into the register the
   * caller wants it in.
   *
   * A name is read out of its slot, and a field of one is a second read at a
   * displacement. A field whose object is itself a name is the shape every
   * recursive call on a tree has.
   *
   * Anything that computes is refused, because the accumulator is what computes
   * things; so is a conversion, because the instruction that narrows the value
   * would have to write the register too and there is no general form here for
   * that. Only a value already at the type the parameter takes is read, so the
   * register holds the number the callee is declared to be handed.
   */
  private readIntoRegister(value: SemanticValue, register: number, type: SemanticType): boolean {
    if (value.k === "local") {
      const held = this.slot(value.name);
      if (!typeEquals(held.type, type) && !(isReference(held.type) && isReference(type))) return false;
      // A value the build gave a register of its own has no slot to read out
      // of: its distance into the frame is zero, which is the first slot's own
      // address, so it is copied from the register it is in.
      if (held.register !== null) {
        if (isFloat(held.type)) this.code.movsMove(register, held.register, widthOf(held.type) === 4);
        else this.code.movRegReg(register, held.register);
        return true;
      }
      if (isFloat(type)) this.code.movsLoad(register, frame(held.offset), widthOf(type) === 4);
      else this.code.movRegMemSized(register, frame(held.offset), widthOf(held.type), signedOf(held.type));
      return true;
    }
    if (value.k !== "loadField") return false;
    if (!typeEquals(value.type, type) && !(isReference(value.type) && isReference(type))) return false;
    const object = value.object;
    if (object.k !== "local") return false;
    const base = this.slot(object.name);
    if (!typeEquals(base.type, object.type)) return false;
    const displacement = this.field(value.layout, value.field).offset;
    if (base.register !== null) {
      const at = mem(base.register, displacement);
      if (isFloat(type)) this.code.movsLoad(register, at, widthOf(type) === 4);
      else this.code.movRegMemSized(register, at, widthOf(type), signedOf(type));
      return true;
    }
    // The object is in the frame, so the field is read through it: the name is
    // read straight into the register the call takes it in and the field is
    // read through that. Going through the accumulator is a move that answers
    // nothing, and reading the object into a slot first is a store and a load
    // for a value that was read exactly once.
    if (isFloat(type)) {
      this.code.movsLoad(register, frame(base.offset), widthOf(base.type) === 4);
      this.code.movsLoad(register, mem(register, displacement), widthOf(type) === 4);
      return true;
    }
    this.code.movRegMemSized(register, frame(base.offset), widthOf(base.type), signedOf(base.type));
    this.code.movRegMemSized(register, mem(register, displacement), widthOf(type), signedOf(type));
    return true;
  }

  /**
   * A call the compiler itself provides. Each is what the C library has by the
   */
  private builtin(call: SemanticCall): void {
    const argument = call.args[0];
    if (call.callee === ARGV_LENGTH) {
      this.runtime("_argv_count");
      return;
    }
    if (call.callee === "argv") {
      this.at(argument, USIZE);
      this.code.movRegReg(RDI, RAX);
      this.runtime("_argv");
      return;
    }
    if (call.callee === "Math.round") {
      this.at(argument, NUMBER);
      const operand = this.hold(NUMBER, "blaze_rounded");
      this.store(operand);
      this.floatConstant(0.5, NUMBER, XMM1);
      this.code.sse("add", XMM0, XMM1, false);
      this.library("floor");
      // The answer is kept beside the value it was made of: a value that rounds
      // to zero from below keeps its sign, which is what the language does and
      // what a round of the C library rounds away, and every other answer is
      // the one the library gave.
      this.code.movsMove(XMM1, XMM0, false);
      const keep = this.code.label("Lround");
      const end = this.code.label("Lend");
      this.code.xorFloat(XMM2, XMM2);
      this.code.sseCompare(XMM0, XMM2, false, true);
      this.code.jcc("p", keep);
      this.code.jcc("ne", keep);
      this.code.movsLoad(XMM0, frame(operand.offset), false);
      this.code.sseCompare(XMM0, XMM2, false, true);
      // A comparison of floats leaves the unsigned conditions: the ones that
      // say which side of the other a value is on.
      this.code.jcc("ae", keep);
      this.code.movsMove(XMM0, XMM1, false);
      this.code.movRegImm(RAX, -0x8000_0000_0000_0000n);
      this.code.movdXmm(XMM2, RAX);
      this.code.xorFloat(XMM0, XMM2);
      this.code.jmp(end);
      this.code.bind(keep);
      this.code.movsMove(XMM0, XMM1, false);
      this.code.bind(end);
      return;
    }
    const library = MATH_LIBRARY[call.callee];
    if (library === undefined || BUILTINS[call.callee] === undefined) {
      throw machineError(`${this.fn.symbol} calls ${call.callee}, which this backend does not lower`);
    }
    this.at(argument, NUMBER);
    this.library(library);
  }

  /**
   * A call, with the arguments where the convention puts them. The registers
   * are read last, because writing an argument that has no register left goes
   * through the very registers the others are read into.
   */
  private callSymbol(symbol: string, args: readonly (Held | null)[], returns: SemanticType, fresh = -1, placed = -1): void {
    this.external(symbol);
    const onStack: Held[] = [];
    const registers: { register: number; held: Held; at: number }[] = [];
    let general = 0;
    let floating = 0;
    for (const [at, argument] of args.entries()) {
      if (argument === null) continue;
      // The registers are handed out in the order the arguments are written, and
      // an argument that has none left is on the stack with every argument after
      // it, whichever class those are. An argument already in its own register
      // still takes one, so that the counts below are the ones the convention
      // hands out.
      const register =
        onStack.length > 0 ? undefined : isFloat(argument.type) ? SSE_ARGUMENTS[floating] : INTEGER_ARGUMENTS[general];
      if (register === undefined) {
        onStack.push(argument);
        continue;
      }
      if (isFloat(argument.type)) floating += 1;
      else general += 1;
      registers.push({ register, held: argument, at });
    }
    // An argument that has run out of registers goes on the stack below where
    // the return address is pushed, which is below the frame — so it is written
    // before the stack is moved down past it, because the frame is addressed
    // from the stack pointer and every slot the registers below are read from
    // has to still be where the prologue left it when they are read.
    //
    // The move itself is a whole number of sixteen byte steps, so the stack is
    // the same alignment at the call as it is everywhere else in the body, which
    // is what every function the C library was compiled for assumes of the call
    // it is entered by.
    const slots = Math.ceil(onStack.length / 2) * 2;
    onStack.forEach((argument, at) => {
      this.load(argument);
      const address = mem(RSP, at * 8 - slots * 8);
      if (isFloat(argument.type)) {
        this.code.movsStore(address, XMM0, widthOf(argument.type) === 4);
        return;
      }
      this.code.movMemReg(address, RAX);
    });
    for (const { register, held, at } of registers) {
      // An argument that was read straight into its own register is already
      // there, and filling it again from the frame is the move the caller
      // avoided by not writing it there at all.
      if (at === placed) continue;
      // An argument that is pinned is in its register, so it is copied from
      // there rather than read out of the frame.
      if (held.register !== null) {
        if (isFloat(held.type)) this.code.movsMove(register, held.register, widthOf(held.type) === 4);
        else this.code.movRegReg(register, held.register);
        continue;
      }
      // The answer of a call passed straight to this one is in the accumulator
      // and was never written down. An argument with no register left is written
      // through that accumulator, so this holds only when there is none, and it
      // is read last, so nothing after it takes the accumulator away.
      if (at === fresh && onStack.length === 0) {
        if (isFloat(held.type)) {
          if (register !== XMM0) this.code.movsMove(register, XMM0, widthOf(held.type) === 4);
        } else if (register !== RAX) this.code.movRegReg(register, RAX);
        continue;
      }
      if (isFloat(held.type)) {
        this.code.movsLoad(register, frame(held.offset), widthOf(held.type) === 4);
        continue;
      }
      this.code.movRegMemSized(register, frame(held.offset), widthOf(held.type), signedOf(held.type));
    }
    // The stack a call pushes onto has to leave the stack sixteen byte aligned,
    // which is what every function the C library was compiled for assumes of the
    // call it is entered by, so the arguments written above are given the room
    // they are read from only here.
    if (slots > 0) this.code.aluImm("sub", RSP, slots * 8);
    this.code.call(symbol);
    if (slots > 0) this.code.aluImm("add", RSP, slots * 8);
    if (returns.kind !== "void" && !isFloat(returns)) this.normalize(returns);
  }

  /** A call the body makes for what it does, with nothing of its own to pass. */
  private runtime(entry: string): void {
    this.library(`${RUNTIME_NAME}${entry}`);
  }

  private library(symbol: string): void {
    this.external(symbol);
    this.code.call(symbol);
  }

  private external(symbol: string): void {
    if (this.externals.includes(symbol)) return;
    this.externals.push(symbol);
  }

  /* ---------------------------------------------------------------------- */
  /* Conversions                                                            */
  /* -------------------------------------------------------------------------- */

  /**
   * A value in the accumulator read as another type. A use converts inside a
   * kind: a whole number written where a double is read, a number narrowed to
   * the width it is stored at. A reference is a pointer whatever it points at
   * and text is a pointer whatever it says, so neither is converted at all.
   */
  private convert(from: SemanticType, to: SemanticType): void {
    if (to.kind === "void") return;
    if (isTextType(from) || isTextType(to) || isReference(from) || isReference(to)) return;
    if (!isNumber(from) || !isNumber(to)) return;
    if (isFloat(from) && isFloat(to)) {
      // The opcode's prefix names the precision the value is read at, so it is
      // the source's width and not the destination's.
      if (widthOf(from) !== widthOf(to)) this.code.cvtFloatPrecision(XMM0, XMM0, widthOf(from) === 4);
      return;
    }
    if (isFloat(from)) {
      this.code.cvtFloatToInt(RAX, XMM0, widthOf(from) === 4, widthOf(to) === 8);
      this.normalizeArithmetic(to);
      return;
    }
    if (isFloat(to)) {
      this.wholeAsDouble(from, to);
      return;
    }
    if (widthOf(to) < widthOf(from)) this.code.narrow(RAX, RAX, widthOf(to), signedOf(to));
  }

  /**
   * A whole number read as a float. The accumulator holds the value widened to
   * its own width, and a conversion is signed at that width — except for a
   * whole number of a full word, which has to be read as itself or every value
   * above the middle of the range would come back negative.
   */
  private wholeAsDouble(from: SemanticType, to: SemanticType): void {
    const single = widthOf(to) === 4;
    if (widthOf(from) === 8 && isUnsigned(from)) {
      const halved = this.code.label("Lhalf");
      const done = this.code.label("Ldone");
      // A signed conversion reads the sign bit as a sign, so a value from the
      // middle of the range upwards would come back negative. Those are halved
      // instead — rounding up, since the bit shifted out is the low one — and
      // the answer is doubled afterwards.
      this.code.test(RAX);
      this.code.jcc("s", halved);
      this.code.cvtIntToFloat(XMM0, RAX, single);
      this.code.jmp(done);
      this.code.bind(halved);
      this.code.movRegReg(RCX, RAX);
      this.code.shiftImm("shr", RCX, 1);
      this.code.aluImm("and", RAX, 1);
      this.code.alu("or", RAX, RCX);
      this.code.cvtIntToFloat(XMM0, RAX, single);
      this.code.sse("add", XMM0, XMM0, single);
      this.code.bind(done);
      return;
    }
    this.code.cvtIntToFloat(XMM0, RAX, single);
  }
}

/* -------------------------------------------------------------------------- */
/* Numbers as they are written                                                  */
/* -------------------------------------------------------------------------- */

/** The value a whole number literal is. */
function integerText(text: string): bigint {
  if (/^[+-]?0[xX]/.test(text)) {
    const negative = text.startsWith("-");
    return (negative ? -1n : 1n) * BigInt(negative ? text.slice(1) : text);
  }
  if (/^[+-]?[0-9]+$/.test(text)) return BigInt(text);
  return BigInt(Math.trunc(Number(text)));
}

/** The value a number literal is, written as a decimal whatever it was. */
function decimalText(text: string): string {
  if (!/^[+-]?0[xX]/.test(text)) return text;
  const negative = text.startsWith("-");
  return `${negative ? "-" : ""}${BigInt(negative ? text.slice(1) : text).toString()}`;
}

/** The bits a number is, which is what a float is written into a register as. */
function floatBits(value: number, single: boolean): bigint {
  if (single) {
    const bits = new DataView(new ArrayBuffer(4));
    bits.setFloat32(0, value, true);
    return BigInt(bits.getUint32(0, true));
  }
  const bits = new DataView(new ArrayBuffer(8));
  bits.setFloat64(0, value, true);
  return BigInt.asIntN(64, bits.getBigUint64(0, true));
}

/* -------------------------------------------------------------------------- */
/* Reading a lowered object back                                                */
/* -------------------------------------------------------------------------- */

/**
 * What a review of the target code is shown. Machine code is not text, so a
 * review of it reads the listing the disassembler in the toolchain prints; where
 * there is no disassembler, what the object says of itself is given instead.
 */
export function describeMachineObject(objectPath: string, bytes: Uint8Array): { text: string; note: string | null } {
  const listing = run("objdump", ["-d", "-r", "--no-show-raw-insn", objectPath], { timeoutMs: 30_000 });
  if (listing.code === 0 && listing.stdout.trim() !== "") {
    return {
      text: listing.stdout,
      note: "This is the machine code itself, as the disassembler reads it. The IR it was built from is the artifact the rules are applied to, and the object is regenerated from it.",
    };
  }
  return {
    text: describeObject(bytes),
    note: "No disassembler was available, so this is what the object says of itself. The IR it was built from is the artifact the rules are applied to, and the object is regenerated from it.",
  };
}

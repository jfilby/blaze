/**
 * The rewrites a build applies to the IR on its own, before and after the ones
 * a model proposes.
 *
 * A review proposes, and the rules hold it to: whatever the rules in
 * `repair.ts` do not cover, no build ever does, and the largest thing they do
 * not cover is everything that needs no judgement. Constant folding, the
 * algebraic identities, loop-invariant hoisting, commoning a value a loop
 * computes once, and dropping what nothing reads are all the same on every
 * build, so waiting for a model to propose one is waiting for luck.
 *
 * The pass here is the deterministic half. It is applied to a whole function
 * and to a whole program's own statements, it is applied again after every
 * round a review produced, and it runs to a fixed point, because one of these
 * exposes the next: a fold makes a value hoistable, and a hoist makes two
 * computations the same one.
 *
 * One rewrite is not a rewrite of one body: whole-number arithmetic
 * (`whole-numbers.ts`) reads a whole program, because what it needs to know is
 * what the callers of a function hand it. It therefore runs once, at the end,
 * rather than in the rounds below.
 *
 * Every rewrite here is value-preserving by construction, and the two places
 * that could have been are guarded and say why: folding a floating-point
 * operation is only exact where IEEE says the result is exact, and moving a
 * computation is only the same program where the value reads nothing the
 * region writes and cannot fault. The test a value has to pass is one answer,
 * in `repair.ts`, whichever rewrite is asking: what `hoist-invariant` and
 * `common-subexpression` hold a model's proposal to is what this holds itself.
 */

import type {
  SemanticBlock,
  SemanticCall,
  SemanticFunction,
  SemanticLoop,
  SemanticProgram,
  SemanticSlot,
  SemanticStatement,
  SemanticTextPart,
  SemanticType,
  SemanticValue,
} from "../core/semantic-ir.ts";
import { hasCall, isInteger, isTextType, isUnsigned, isWideType, slotType, statementBlocksOf, statementValues, typeEquals, walkValues, TEXT } from "../core/semantic-ir.ts";
import { declaredNames, freshName, isBindable, isSafeToCompute, replaceBlockIds, replaceValues, slotFor, substituteLocals, typeLabel, valueKey } from "./repair.ts";
import { wholeNumberArithmetic } from "./whole-numbers.ts";
import { restructureHotFunction } from "./restructure.ts";
import { markParallelLoops, NO_CALLEES, type Callees } from "./parallel.ts";
import { eliminateMutualRecursion, eliminateMutualRecursionInProgram, eliminateRecursion } from "./recursion.ts";
import { markRegionLoops } from "./region.ts";

/* -------------------------------------------------------------------------- */
/* Numbers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The whole-number types, and the width each one holds.
 *
 * `usize` and `isize` are here because they are the two the table was missing
 * and both are reachable: a buffer's offset is a `usize`, so the arithmetic a
 * window is laid out with — `2 * bytesPerFloat * n` in the spectral norm
 * example — reached every fold below as an unfoldable tree and reached a
 * backend as the arithmetic the source wrote. Both are a machine word on every
 * target this compiler builds for, which is the width `ir-machine.ts` gives
 * them, so a value folded here wraps exactly as it would have wrapped there.
 *
 * A loop counter is not one of these and is not the case this table was
 * missing: `ir-resolve.ts` types a counted loop `i64` unless its ends are
 * written at a narrower whole width, so the index a kernel walks an array with
 * was already folding. What was missing is the arithmetic around the array
 * rather than over it.
 */
const WIDTH: Record<string, number> = {
  i8: 8, i16: 16, i32: 32, i64: 64,
  u8: 8, u16: 16, u32: 32, u64: 64,
  usize: 64, isize: 64,
};
const FLOAT_TYPES: Record<string, true> = { f32: true, f64: true };
/** The name of a numeric type, which is what a fold wraps to a width. */
type NumericName =
  | "i8" | "i16" | "i32" | "i64"
  | "u8" | "u16" | "u32" | "u64"
  | "usize" | "isize"
  | "f32" | "f64";

/** The type a folded truth is written at, which is the one the IR gives it. */
const BOOL = { kind: "primitive", name: "bool" } as const;

/**
 * A number as a JavaScript one, or null when its text is not a number this
 * pass can reason about. A literal wider than 2^53 arrives as text and stays
 * text: a double cannot hold it, so folding through one would change the value.
 */
function asNumber(text: string): number | null {
  const value = Number(text);
  if (!Number.isFinite(value) && !/^-?(inf|nan)$/i.test(text)) return null;
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) return null;
  return value;
}

/** The text a number is written back as, which is the shortest form of it. */
function asText(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "Infinity";
  if (value === -Infinity) return "-Infinity";
  if (Object.is(value, -0)) return "-0";
  return String(value);
}

/** The type a whole number is written at, which is what its range follows. */
function numberType(value: SemanticValue): NumericName | null {
  if (value.type.kind !== "primitive") return null;
  const name = value.type.name;
  return name in WIDTH || FLOAT_TYPES[name] === true ? (name as NumericName) : null;
}

/**
 * A whole number wrapped to the range of its type, as the backends wrap it.
 *
 * The arithmetic is done in whole numbers of the compiler's own rather than in
 * doubles, because a double holds every integer exactly only up to 2^53 and a
 * 64 bit range is wider than that: `7 % 3` at `i64` came out of the double form
 * as zero, because the sum the signed wrap forms reaches 2.77e19 and rounds on
 * the way back down. The answer a backend gives is the answer modulo 2^64, and
 * that is the question this now asks.
 */
function wrapWhole(value: number, name: NumericName): number {
  const width = WIDTH[name];
  if (width === undefined || !Number.isFinite(value)) return value;
  const bits = BigInt(width);
  const modulus = 2n ** bits;
  // A double at or above 2^53 has no fractional part, so this is the very
  // integer the double holds.
  const whole = BigInt(Math.trunc(value));
  if (isUnsigned({ kind: "primitive", name } as SemanticType)) {
    return Number(((whole % modulus) + modulus) % modulus);
  }
  const bound = modulus / 2n;
  return Number(((((whole + bound) % modulus) + modulus) % modulus) - bound);
}

/**
 * The mask every bit of a whole number set is, or null when there is not one
 * this pass can reason about.
 *
 * A 64 bit mask is 18446744073709551615, which is past 2^53 and so is not a
 * number a double holds exactly: `right` is a literal this pass has already
 * refused to read as one, so a `u64 & 0xffffffffffffffff` is left as it was
 * written rather than folded against a mask that has already lost its low bits.
 * That is the same refusal `asNumber` makes and for the same reason.
 */
function allOnesAt(type: SemanticType, name: NumericName): number | null {
  if (!isInteger(type)) return null;
  const width = WIDTH[name];
  if (width === undefined) return null;
  const mask = 2 ** width - 1;
  return Number.isSafeInteger(mask) ? mask : null;
}

/**
 * Folds one operation on two literals, or answers null when it may not.
 *
 * Floating point is where the care is. `0.1 + 0.2` is not `0.3`, and a fold
 * that rounded it to `0.3` would deliver a program that disagrees with the
 * source it was compiled from. So a float operation is only folded when its
 * answer is exact, which is decided by re-reading it back: if the double the
 * operation produced is the double the folded text parses to, the two are the
 * same number, and if they are not, the operation is left as it was written.
 *
 * A whole number folds whenever it is computed, because the backends wrap to
 * the width of the type and this does the same arithmetic.
 */
function foldArithmetic(op: string, left: number, right: number, name: NumericName): number | null {
  const isFloat = FLOAT_TYPES[name] === true;
  let folded: number;
  switch (op) {
    case "add": folded = left + right; break;
    case "sub": folded = left - right; break;
    case "mul": folded = left * right; break;
    case "div":
      if (right === 0) return null;
      folded = left / right;
      break;
    case "mod":
      if (right === 0) return null;
      folded = left % right;
      break;
    case "pow": folded = left ** right; break;
    case "min": folded = Math.min(left, right); break;
    case "max": folded = Math.max(left, right); break;
    case "shl": folded = left * 2 ** shiftCount(right, name); break;
    case "shr": folded = Math.floor(left / 2 ** shiftCount(right, name)); break;
    case "ushr": folded = left >>> right; break;
    case "and": folded = wholeBits(left, right, "and", name); break;
    case "or": folded = wholeBits(left, right, "or", name); break;
    case "xor": folded = wholeBits(left, right, "xor", name); break;
    default: return null;
  }
  if (isFloat) {
    // Only an exact answer is folded, and it is exact when the text written
    // back reads as the very double the operation produced.
    const text = asText(folded);
    const read = Number(text);
    if (Number.isNaN(folded) || Object.is(folded, -0) || !Number.isFinite(folded)) return folded;
    if (!Object.is(read, folded)) return null;
    return folded;
  }
  return wrapWhole(folded, name);
}

/** Two 32 bit values as the signed integer their bits spell. */
function toBits(value: number): number {
  return value | 0;
}

/**
 * The count a shift is taken at, which is the count the backend takes it at:
 * masked to the width the shift is carried out at — 32 bits for the narrow
 * types, which the C compiler promotes to an int and whose count the machine
 * masks, and 64 for the wide ones — because `x << 32` is `x << 0` wherever the
 * backend reads it. A fold that multiplied by the whole count answered a
 * different number than the machine it was folded for: `1 << 32` at `i32` is
 * one, and the product wrapped to the width of the type is zero. A count the
 * language reads as anything else — a wider number, a negative one, one
 * written with a fraction — is read down the same way, because the mask is
 * what the count is read through wherever a shift is taken.
 */
function shiftCount(count: number, name: NumericName): number {
  return count & (WIDTH[name] === 64 ? 63 : 31);
}

/**
 * One bitwise operation over two whole numbers, at the width the type holds.
 *
 * `and`, `or` and `xor` are operations on the bits, so the width they are
 * carried out at is the width of the answer: a 64 bit type carries them over
 * all 64 bits, and reading its sides as 32 bit integers — as the language
 * reads `&`, `|` and `^` at — took the high half of the answer away.
 * `4294967296 | 1` at `usize` is 4294967297, not one.
 *
 * The sides are wrapped to the range of the type first, which is what a
 * register holds, and a narrow one is read as the 32 bit integer the language
 * reads its bitwise sides at, promotion included. The answer is read back at
 * the sign of the type, and one a double does not carry exactly is not an
 * answer at all: the fold leaves the operation as it was written for the
 * backend to compute at the width it wraps to.
 */
function wholeBits(left: number, right: number, op: "and" | "or" | "xor", name: NumericName): number {
  if (WIDTH[name] !== 64) {
    if (op === "and") return toBits(left) & toBits(right);
    if (op === "or") return toBits(left) | toBits(right);
    return toBits(left) ^ toBits(right);
  }
  const modulus = 2n ** 64n;
  const wrap = (value: number): bigint => {
    const whole = BigInt(Math.trunc(value));
    return ((whole % modulus) + modulus) % modulus;
  };
  const leftBits = wrap(left);
  const rightBits = wrap(right);
  const wrapped = op === "and" ? leftBits & rightBits : op === "or" ? leftBits | rightBits : leftBits ^ rightBits;
  if (!isUnsigned({ kind: "primitive", name } as SemanticType) && wrapped >= 2n ** 63n) {
    return readBack(wrapped - modulus);
  }
  return readBack(wrapped);
}

/**
 * The number a 64 bit bitwise answer is read back as. A whole number the
 * double cannot hold exactly is not an answer this pass may store: its
 * shortest form reads back as a different number, and wrapping that double —
 * 18446744073709552000 is exactly 2^64 — would land the whole answer on a
 * different bit pattern than the one the operation computed. A number the
 * answer does not carry is read back as the one the wrap leaves alone and the
 * fold that writes it back refuses, so the operation stays as it was written
 * and the backend computes its own width.
 */
function readBack(wrapped: bigint): number {
  const read = Number(wrapped);
  return Number.isSafeInteger(read) ? read : NaN;
}

/* -------------------------------------------------------------------------- */
/* Rewriting one value                                                         */
/* -------------------------------------------------------------------------- */

/** Every value directly inside another. */
export function valueChildren(value: SemanticValue): readonly SemanticValue[] {
  switch (value.k) {
    case "arith":
      return [value.left, value.right];
    case "compare":
      return [value.left, value.right];
    case "logical":
    case "coalesce":
      return [value.left, value.right];
    case "select":
      return [value.condition, value.then, value.otherwise];
    case "unary":
      return [value.operand];
    case "isNull":
      return [value.operand];
    case "toText":
      return [value.of];
    case "length":
      return [value.of];
    case "element":
      return [value.of, value.index];
    case "loadField":
      return [value.object];
    case "newObject":
      return value.fields.map((field) => field.value);
    case "buffer":
      // A count the program settled on when it ran is a value of its own, and
      // a view is a window of a block another name holds: both are read, and a
      // walk that stops at the block reads nothing at all.
      return [
        ...(value.count === null ? [] : [value.count]),
        ...(value.view === null ? [] : [value.view.of, value.view.offset]),
        ...value.values,
      ];
    case "text":
      return value.parts.flatMap((part) => (part.k === "value" ? [part.value] : []));
    case "argv":
      return value.index === null ? [] : [value.index];
    // The arguments of a call are values of their own: a name read in one and a
    // constant written into one are both what the body reads and computes, and
    // a walk that stops at the call answers "nothing here" for both.
    case "call":
      return value.call.args;
    case "closure":
      return value.captures;
    case "capture":
      return [value.closure];
    default:
      return [];
  }
}

/** A walk of a value and everything inside it, outermost first. */
export function walkSemanticValue(value: SemanticValue, visit: (value: SemanticValue) => void): void {
  visit(value);
  for (const child of valueChildren(value)) walkSemanticValue(child, visit);
}

/** A value rebuilt with every child replaced. */
function withChildren(value: SemanticValue, children: SemanticValue[]): SemanticValue {
  let at = 0;
  const next = (): SemanticValue => {
    const child = children[at] as SemanticValue;
    at += 1;
    return child;
  };
  switch (value.k) {
    case "arith": return { ...value, left: next(), right: next() };
    case "compare": return { ...value, left: next(), right: next() };
    case "logical":
    case "coalesce": return { ...value, left: next(), right: next() };
    case "select": return { ...value, condition: next(), then: next(), otherwise: next() };
    case "unary": return { ...value, operand: next() };
    case "isNull": return { ...value, operand: next() };
    case "toText": return { ...value, of: next() };
    case "length": return { ...value, of: next() };
    case "element": return { ...value, of: next(), index: next() };
    case "loadField": return { ...value, object: next() };
    case "argv": return value.index === null ? value : { ...value, index: next() };
    // The types of the arguments are the ones the call was made with, and a
    // fold never changes a type, so the folded values line up with them.
    case "call": return { ...value, call: { ...value.call, args: children } };
    case "newObject": return { ...value, fields: value.fields.map((field) => ({ ...field, value: next() })) };
    case "buffer": {
      // The children a buffer holds are the count, then the two sides of a
      // view, then the elements — the same order `valueChildren` walked them
      // out in. Handing every one of them to `values` wrote the folded count
      // into the elements of the buffer and left the count the arithmetic it
      // was before the fold, so a sized buffer the program asked for held a
      // count nothing had folded and an element it never wrote.
      let at = 0;
      const count = value.count === null ? null : (children[at++] as SemanticValue);
      const view = value.view === null ? null : { of: children[at++] as SemanticValue, offset: children[at++] as SemanticValue };
      return { ...value, count, view, values: children.slice(at) };
    }
    case "text":
      return {
        ...value,
        parts: value.parts.map((part) => (part.k === "value" ? { k: "value" as const, value: next() } : part)),
      };
    case "closure": return { ...value, captures: children };
    case "capture": return { ...value, closure: next() };
    default: return value;
  }
}

/** Every statement of a block that is a block of its own. */
export function nestedSemanticBlocks(block: SemanticBlock): SemanticBlock[] {
  const nested: SemanticBlock[] = [];
  for (const statement of block.statements) {
    for (const one of statementBlocksOf(statement)) nested.push(...nestedSemanticBlocks(one));
  }
  return [block, ...nested];
}


/* -------------------------------------------------------------------------- */
/* Folding                                                                     */
/* -------------------------------------------------------------------------- */

/** The two values of a node that decides on one of them. */
function literalOf(value: SemanticValue): number | null {
  return value.k === "const" ? asNumber(value.text) : null;
}

/**
 * The small whole number a wide value is written as, or null when it is not
 * one the compiler can read.
 *
 * A wide number is written in three ways: as a literal that is widened to the
 * width on use, and as one of the two constructors that build it from 64-bit
 * limbs. A constant that is a limb or four of them is a number this pass can
 * count with, and everything else — a name, a call that computes — is not.
 */
function smallWideOf(value: SemanticValue): number | null {
  const small = (one: SemanticValue | undefined): number | null => {
    if (one === undefined) return null;
    const written = literalOf(one);
    return written !== null && Number.isInteger(written) && written >= 0 ? written : null;
  };
  if (value.k === "const") return small(value);
  if (value.k !== "call") return null;
  if (value.call.callee === "u256_from_u64x2") {
    const low = small(value.call.args[0]);
    const high = small(value.call.args[1]);
    return low !== null && high === 0 ? low : null;
  }
  if (value.call.callee === "u256_from_u64x4") {
    const low = small(value.call.args[0]);
    const rest = [small(value.call.args[1]), small(value.call.args[2]), small(value.call.args[3])];
    return low !== null && rest.every((one) => one === 0) ? low : null;
  }
  return null;
}

/**
 * `(k * x) mod m`, written as the additions it is, for the counts one
 * addition or two answer.
 *
 * A modular multiply is the one operation in this IR that costs a 64-by-64
 * product for each of sixteen limb pairs, and a small multiplier does not need
 * one: `2 * x` is `x + x`, and a modular addition is the cheap kernel beside
 * the multiply. The elliptic-curve code this was written for doubles a point
 * on every turn, and two of the multiplies in that doubling are by 2 and 3.
 *
 * Only two and three are taken here, and the reason is what a count above them
 * costs without a binding to hold the doubling: `8 * x` is three doublings
 * only if the first is written down once and read three times, and a value
 * that is not bound is computed again at every read — so the three additions
 * of the chain are seven additions of the tree, which is slower than the
 * multiply it replaced. A count of four and above is left as the multiply by
 * this function, and taken by `chainSmallProducts`, which binds the steps and
 * so does not have that tree to pay for.
 *
 * The rewrite is exact for every modulus: `k * x` is `x` added to itself `k`
 * times, and a modular addition answers the same residue whether the additions
 * are done one at a time or all at once.
 */
function modularMultiplyOf(
  value: SemanticValue & { k: "call" },
  multiplier: number,
  other: SemanticValue,
  mod: SemanticValue,
): SemanticValue | null {
  const addMod = (left: SemanticValue, right: SemanticValue): SemanticValue => ({
    k: "call",
    type: value.type,
    call: {
      ...value.call,
      callee: "u256_add_mod",
      signature: { ...value.call.signature, name: "u256_add_mod", symbol: "u256_add_mod" },
      args: [left, right, mod],
    },
  });
  // The modulus is written into every addition the rewrite makes, and a
  // product by zero or one drops it. A modulus that computes something is not
  // a value the rewrite may read a different number of times than the source
  // did, so it is only rewritten when reading it again is free.
  if (!isSafeToCompute(mod)) return null;
  if (multiplier === 0) {
    // The product by zero is no value at all, so the other side is no longer
    // computed where it was: only a value with nothing to drop is rewritten.
    if (!isSafeToCompute(other)) return null;
    return { k: "const", type: value.type, text: "0" };
  }
  if (multiplier === 1) return other;
  // The answer is the other side written once or twice, so the rewrite is only
  // a saving when writing it twice is free: a name is read, a literal is laid
  // down, and a wide constant built from its limbs is the limbs it is written
  // with. Anything computed would be computed again at every copy, so a
  // product by two of a sum would be two copies of the sum and every operation
  // in it — slower than the one product it replaced.
  if (other.k !== "local" && other.k !== "const" && smallWideOf(other) === null) return null;
  if (multiplier === 2) return addMod(other, other);
  if (multiplier === 3) return addMod(addMod(other, other), other);
  return null;
}

/* -------------------------------------------------------------------------- */
/* A small multiplier written as a chain, with a binding at every step          */
/* -------------------------------------------------------------------------- */

/** The largest count a modular multiply is written as a chain of additions for. */
const SMALL_COUNT_LIMIT = 16;

/**
 * The small count a modular multiply is written as a chain for, or null when
 * the value is not one.
 *
 * A count is read the way the count in `modularMultiplyOf` is: a literal, or a
 * wide constant built from its limbs. A count above the limit stays a multiply,
 * because the chain is a doubling per bit and a product is one kernel call: the
 * chain answers a count of sixteen with four additions where the multiply is
 * the sixteen limb products the kernel executes, but a count of a thousand
 * would be nine additions against the same kernel, and the kernel is the one
 * thing that answers the whole range.
 */
function smallCountOf(value: SemanticValue): number | null {
  const written = smallWideOf(value);
  if (written === null || written < 2 || written > SMALL_COUNT_LIMIT) return null;
  return written;
}

/**
 * `k * x` as `x` added to itself, with a binding between the steps.
 *
 * `modularMultiplyOf` writes a multiply by two or three as the additions it is,
 * but only where the other side is free to write twice: a name, a literal, or a
 * wide constant built from its limbs. The curve's doubling multiplies a sum it
 * computed by two, and eight times a square by eight, and both of those sides
 * are read more than once — so the rewrite it makes is not available, and the
 * multiply stays.
 *
 * A binding makes it available: the side is computed once into a name, and then
 * read. The count is walked from its highest bit down, doubling the accumulator
 * at every step and adding the side where the bit is set, which is the binary
 * form of the multiply and costs a doubling per bit plus one addition per set
 * bit. A doubling reads the accumulator twice, so each step's binding is read
 * more than once and stays where it is put; the multiply by eight that a
 * doubling of a point begins with is three additions rather than sixteen limb
 * products.
 *
 * A count of two or three over a side that is free is already the rewrite
 * `modularMultiplyOf` makes, so this one only has the chain to add: it is
 * applied after the fold, and it takes what the fold left.
 */
function chainOf(
  value: SemanticValue & { k: "call" },
  bindings: SemanticStatement[],
  taken: Set<string>,
  line: number,
): SemanticValue | null {
  if (value.call.callee !== "u256_mul_mod" || !isWideType(value.type)) return null;
  const [left, right, mod] = value.call.args;
  if (left === undefined || right === undefined || mod === undefined) return null;
  const count = smallCountOf(left) ?? smallCountOf(right);
  if (count === null) return null;
  // Every addition in the chain reads the modulus, so a modulus that computes
  // something would be computed once per step instead of the once the source
  // wrote.
  if (!isSafeToCompute(mod)) return null;
  const other = smallCountOf(left) !== null ? right : left;
  // The side is computed once, so it has to be a value that may be computed
  // where the multiply was: a read through an object is not one, because the
  // binding is built before the statement that read it, and a call with an
  // effect is not one either.
  if (!isSafeToCompute(other)) return null;
  let seed = other;
  if (other.k !== "local" && other.k !== "const") {
    const name = freshName(taken, "smallCountOperand");
    bindings.push({ k: "let", slot: slotFor(other, name), value: other, line });
    seed = { k: "local", type: value.type, name };
  }
  const addMod = (a: SemanticValue, b: SemanticValue): SemanticValue => ({
    k: "call",
    type: value.type,
    call: {
      ...value.call,
      callee: "u256_add_mod",
      signature: { ...value.call.signature, name: "u256_add_mod", symbol: "u256_add_mod" },
      args: [a, b, mod],
    },
  });
  const bind = (step: SemanticValue): SemanticValue => {
    const name = freshName(taken, "smallCountStep");
    bindings.push({ k: "let", slot: slotFor(step, name), value: step, line });
    return { k: "local", type: value.type, name };
  };
  let acc = seed;
  for (let bit = Math.floor(Math.log2(count)) - 1; bit >= 0; bit -= 1) {
    acc = bind(addMod(acc, acc));
    if (((count >> bit) & 1) !== 0) acc = bind(addMod(acc, seed));
  }
  return acc;
}

/** The outermost multiply by a small count in a value, or null. */
function smallProductIn(value: SemanticValue): (SemanticValue & { k: "call" }) | null {
  let found: (SemanticValue & { k: "call" }) | null = null;
  walkValues(value, (one) => {
    if (found !== null || one.k !== "call") return;
    if (one.call.callee !== "u256_mul_mod" || !isWideType(one.type)) return;
    if (one.call.args.length !== 3) return;
    if (smallCountOf(one.call.args[0] as SemanticValue) !== null) found = one;
    else if (smallCountOf(one.call.args[1] as SemanticValue) !== null) found = one;
  });
  return found;
}

/**
 * Every small multiply in a body written as the chain of additions it is.
 *
 * One product is rewritten per statement per round, because the chain's own
 * bindings may hold another product, and the rounds of this pass reach it the
 * same way they reach a fold the previous one exposed.
 */
function chainSmallProducts(body: Body): boolean {
  const taken = new Set<string>(body.params.map((param) => param.name));
  for (const block of nestedSemanticBlocks(body.entry)) {
    taken.add(block.id);
    for (const statement of block.statements) if (statement.k === "let") taken.add(statement.slot.name);
  }
  let changed = false;
  const walk = (block: SemanticBlock): void => {
    for (const statement of block.statements) {
      for (const nested of statementBlocksOf(statement)) walk(nested);
    }
    if (chainOne(block, taken)) changed = true;
  };
  walk(body.entry);
  return changed;
}

function chainOne(block: SemanticBlock, taken: Set<string>): boolean {
  const statements: SemanticStatement[] = [];
  let changed = false;
  for (const statement of block.statements) {
    const value = statement.k === "let" || statement.k === "set" ? statement.value : null;
    const product = value === null ? null : smallProductIn(value);
    if (product !== null) {
      const bindings: SemanticStatement[] = [];
      const chained = chainOf(product, bindings, taken, statement.line);
      if (chained !== null) {
        const replacements = new Map([[valueKey(product), chained]]);
        statements.push(...bindings);
        statements.push(replaceValues(statement, replacements) as SemanticStatement);
        changed = true;
        continue;
      }
    }
    statements.push(statement);
  }
  if (block.terminator.k === "return" && block.terminator.value !== null) {
    const product = smallProductIn(block.terminator.value);
    if (product !== null) {
      const bindings: SemanticStatement[] = [];
      const chained = chainOf(product, bindings, taken, block.statements[0]?.line ?? 0);
      if (chained !== null) {
        const replacements = new Map([[valueKey(product), chained]]);
        statements.push(...bindings);
        block.terminator = { ...block.terminator, value: replaceValues(block.terminator.value, replacements) };
        changed = true;
      }
    }
  }
  if (changed) block.statements = statements;
  return changed;
}

/**
 * The text of a value that is written out in full, or null when it is built
 * at run time.
 */
function literalTextOf(value: SemanticValue): string | null {
  if (value.k !== "text") return null;
  let text = "";
  for (const part of value.parts) {
    if (part.k !== "text") return null;
    text += part.value;
  }
  return text;
}

/**
 * A string added to a string, when both of them are written out.
 *
 * Two strings written out are one string written out, and the string is the
 * same string the program would have built by joining them at run time — it is
 * only built earlier, and a backend that writes a string out as a literal
 * writes nothing at all.
 */
function foldConcat(value: SemanticValue & { k: "arith" }): SemanticValue | null {
  const left = literalTextOf(value.left);
  if (left === null) return null;
  const right = literalTextOf(value.right);
  if (right === null) return null;
  return { k: "text", type: TEXT, parts: [{ k: "text", value: left + right }] };
}

/**
 * An array added to an array, when both of them are written out.
 *
 * Two arrays written out are one array written out, with the elements of the
 * right following those of the left, and the array is the same one the program
 * would have built by joining them at run time.
 */
function foldArrayConcat(value: SemanticValue & { k: "arith" }): SemanticValue | null {
  if (value.left.k !== "buffer" || value.right.k !== "buffer") return null;
  if (value.left.count !== null || value.left.view !== null) return null;
  if (value.right.count !== null || value.right.view !== null) return null;
  const element = value.left.element;
  if (!typeEquals(element, value.right.element)) return null;
  return {
    k: "buffer",
    type: value.type,
    element,
    length: (value.left.length ?? value.left.values.length) + (value.right.length ?? value.right.values.length),
    count: null,
    view: null,
    values: [...value.left.values, ...value.right.values],
  };
}

/**
 * The value one node folds to, or null when it stays as it is written.
 *
 * This is the whole of constant folding and the whole of the algebraic
 * identities in one place, because they are the same question asked of the same
 * node: is there a shorter way to write what this already says? A node over two
 * literals has an answer that is one literal. A node over one literal and an
 * identity has an answer that is the other side. A node over the same value
 * twice has an answer that is that value.
 */
function foldValue(value: SemanticValue): SemanticValue | null {
  switch (value.k) {
    case "arith": {
      // A string added to a string is the one operation with no number behind
      // it, so it is folded before the numbers are: two strings written out are
      // one string written out, and a string written out is not built at run
      // time at all.
      if (value.op === "concat") return foldConcat(value);
      if (value.op === "arrayConcat") return foldArrayConcat(value);
      const name = numberType(value);
      if (name === null) return null;
      const left = literalOf(value.left);
      const right = literalOf(value.right);
      if (left !== null && right !== null) {
        const folded = foldArithmetic(value.op, left, right, name);
        if (folded === null) return null;
        // A whole number the compiler writes back as text is read by a backend
        // as text, and text carries a number exactly only to 2^53. An answer
        // past that is written as the shortest thing that reads back as the
        // same double, which is a different number: `-7` divided by two at
        // `u64` is 18446744073709551609, and what it was written as was
        // 18446744073709552000. Such an answer is left as the arithmetic it
        // came from, which the backend computes at the width it wraps to.
        if (isInteger(value.type) && !Number.isSafeInteger(folded)) return null;
        return { k: "const", type: value.type, text: asText(folded) };
      }
      // The identities, each of which holds at the type it is written at.
      //
      // They are all restricted to whole numbers, and the reason is signed
      // zero rather than rounding: `x + 0.0` is `-0.0` turned into `0.0`, and
      // `x * 1.0` is exact, so one float identity is not the same program as
      // the other and neither is written here. A whole number has no such
      // value, so all of them are the same program at a whole type.
      if (value.right.k === "const" && right !== null && FLOAT_TYPES[name] !== true) {
        if (value.op === "add" && right === 0) return value.left;
        if (value.op === "sub" && right === 0) return value.left;
        if (value.op === "mul" && right === 1) return value.left;
        // A product with a zero is a zero, and not the other side: `x * 0` is
        // zero however large `x` is, so folding it to the other side handed a
        // program that answered with the value it was asked to multiply rather
        // than with the product. The bitwise zero two lines below is written
        // the same way, and this one was the copy of it that answered with the
        // wrong side.
        if (value.op === "mul" && right === 0 && isInteger(value.type)) return { k: "const", type: value.type, text: asText(0) };
        if (value.op === "shl" && right === 0) return value.left;
        // A right shift by nothing is the value, as a left shift by nothing
        // is. The three were written together and only the left one was
        // written down, so `x >> 0` and `x >>> 0` reached a backend as a
        // shift on every turn of whatever loop counted with them.
        //
        // The shift moves no bit, but it is a conversion as well as a shift
        // when the two are not the same width: `>>>` reads its sides as the
        // unsigned 32 bit numbers the language reads them as, so `x >>> 0` is
        // `x` as one of those and not `x` as it is. `-1 >>> 0` is 4294967295
        // and `2.5 >>> 0` is 2, and folding the shift away answered with the
        // value it was asked about rather than with the number the language
        // reads it as. The fold is taken where the conversion is nothing:
        // where the side is already at the width the answer is.
        if ((value.op === "shr" || value.op === "ushr") && right === 0 && typeEquals(value.left.type, value.type)) {
          return value.left;
        }
        // A whole number divided by one is itself and a whole number
        // remaindered by one is zero, and neither is a fault: one is never
        // zero, so the divide the backend would run is one it does not have to.
        if (value.op === "div" && right === 1) return value.left;
        if (value.op === "mod" && right === 1) return { k: "const", type: value.type, text: asText(0) };
        // The bitwise identities, at the width the type holds. An index is
        // masked and combined more often than anything else in a kernel, and
        // `x | 0` and `x ^ 0` are how a source spells a value it did not
        // change.
        const allOnes = allOnesAt(value.type, name);
        if (value.op === "or" && right === 0) return value.left;
        if (value.op === "xor" && right === 0) return value.left;
        if (value.op === "and" && right === 0) return { k: "const", type: value.type, text: asText(0) };
        if (allOnes !== null) {
          if (value.op === "and" && right === allOnes) return value.left;
          if (value.op === "or" && right === allOnes) return { k: "const", type: value.type, text: asText(allOnes) };
          // `x ^ allOnes` is the bitwise complement of x, which the IR spells
          // as a unary rather than as another binary over the same mask.
          if (value.op === "xor" && right === allOnes) {
            return { k: "unary", type: value.type, op: "bitNot", operand: value.left };
          }
        }
      }
      if (value.left.k === "const" && left !== null) {
        if (value.op === "add" && left === 0) return value.right;
        if (value.op === "mul" && left === 1) return value.right;
        // A product with a zero on the left is the same zero the same product
        // with the zero on the right is, so it is folded the same way.
        if (value.op === "mul" && left === 0 && isInteger(value.type)) return { k: "const", type: value.type, text: asText(0) };
        // `0 - x` is the negation of x, and not x: this returned the right
        // side, so `0 - a.length` printed the length rather than its
        // negation. A whole number negates by the same wrap the subtraction
        // does, so it is the negation; a float does not, because `0.0 - 0.0`
        // is a positive zero and negating a zero is a negative one, so that
        // form is left as the subtraction it was written as.
        if (value.op === "sub" && left === 0 && isInteger(value.type)) {
          return { k: "unary", type: value.type, op: "neg", operand: value.right };
        }
        if (value.op === "div" && left === 0 && right !== null && right !== 0) {
          return { k: "const", type: value.type, text: asText(0) };
        }
      }
      // A value against itself is zero, one, or false — and only where the
      // value is a number, which is the whole of the condition. `NaN - NaN` is
      // NaN and `NaN / NaN` is NaN, and `0 / 0` and `inf / inf` are both NaN as
      // well, so a float folded here is a program that computed a NaN and is
      // handed a zero or a one instead. The comparison folds further down are
      // guarded the same way, for the same reason and in the same words.
      //
      // So the fold is taken where the operand is written out — a literal is a
      // number the source can see, and a finite one is not a NaN — and over a
      // whole number, which has no NaN and no infinity to divide by.
      if (valueKey(value.left) === valueKey(value.right)) {
        // `literalOf` answers null for anything that is not written out, and
        // null is not zero: the test this replaces asked `!== 0` of it, so a
        // *variable* against itself satisfied it and every `x / x` the
        // compiler lowered was a one — including the `x / x` of a program that
        // had found a zero there and was asking for the NaN.
        const literal = literalOf(value.left);
        const written = literal !== null && Number.isFinite(literal);
        if (value.op === "sub") {
          return written || isInteger(value.type) ? { k: "const", type: value.type, text: asText(0) } : null;
        }
        if (value.op === "div") {
          if (written && literal !== 0) return { k: "const", type: value.type, text: asText(1) };
          if (!isInteger(value.type)) return null;
          if (numberType(value.left) === null) return null;
        }
        if (value.op === "min" || value.op === "max") return value.left;
        if (value.op === "and" || value.op === "or") return value.left;
        if (value.op === "xor") return { k: "const", type: value.type, text: asText(0) };
      }
      // A whole number divided and multiplied by a power of two is a shift,
      // which is the instruction the machine backend has and the division is
      // not. A signed division is left alone: truncation towards zero and a
      // shift disagree about a negative value, which is why
      // `reciprocal-multiply` is a floating point rule.
      //
      // The count is bounded by the width of the type, because that is the
      // width the count is taken at: a shift of 32 at `i32` wraps to a shift of
      // zero on the machine, where the multiplication it replaced has already
      // wrapped the value to nothing at all. `2^32 * x` is zero at `i32` and
      // `x << 32` is `x << 0`, which is `x`.
      if (isInteger(value.type) && value.right.k === "const" && right !== null && right > 0) {
        const exponent = Number.isInteger(Math.log2(right)) ? Math.log2(right) : null;
        if (exponent !== null && exponent >= 1 && exponent < WIDTH[name]) {
          // A value that cannot be negative divides and shifts alike, and one
          // that can does not: `-7 / 2` is `-3` and `-7 >> 1` is `-4`.
          const exact = isUnsigned(value.type) || (literalOf(value.left) ?? -1) >= 0;
          if (exact && value.op === "div") {
            return { ...value, op: "shr", right: { k: "const", type: value.right.type, text: String(exponent) } };
          }
          if (exact && value.op === "mod") {
            return { ...value, op: "and", right: { k: "const", type: value.right.type, text: String(right - 1) } };
          }
          if (value.op === "mul") {
            return { ...value, op: "shl", right: { k: "const", type: value.right.type, text: String(exponent) } };
          }
        }
      }
      return null;
    }
    case "call": {
      // A modular multiply by a number the compiler can read is the sum of
      // that many copies, and the modular addition is the cheap kernel. The
      // count is read from the side that is written out; the other side is the
      // value being counted, and it has to be the wide number the answer is,
      // because the additions are made at that width.
      if (value.call.callee !== "u256_mul_mod" || !isWideType(value.type)) return null;
      const [left, right, mod] = value.call.args;
      if (left === undefined || right === undefined || mod === undefined) return null;
      const writtenLeft = smallWideOf(left);
      const writtenRight = smallWideOf(right);
      if (writtenLeft !== null && isWideType(right.type)) {
        return modularMultiplyOf(value, writtenLeft, right, mod);
      }
      if (writtenRight !== null && isWideType(left.type)) {
        return modularMultiplyOf(value, writtenRight, left, mod);
      }
      return null;
    }
    case "compare": {
      const name = numberType(value.left);
      if (name === null) return null;
      const left = literalOf(value.left);
      const right = literalOf(value.right);
      if (left === null || right === null) {
        // A whole number against itself is an answer whatever the operator is:
        // it equals itself, it is not above or below itself, and it is neither
        // strictly greater nor strictly less. That is what a loop guard and an
        // index bounds check compute, so `while (i <= i)` and `if (i > i)` fold
        // to the truth they already are and the branch goes with them.
        //
        // A float is left as it was written, and that is the one case where the
        // answer is not obvious: IEEE 754 has every NaN compare unequal to
        // itself, so `x == x` over a `f64` is a test for a NaN rather than a
        // truth. Folding it to `true` would turn a program that finds its NaNs
        // into one that does not, so only a whole number is folded here.
        //
        // The type the fold is decided by is the one the operands are compared
        // as, which is the type the backends compare them as: a value that is
        // not written out has no type of its own to read, so the type of the
        // comparison is the only thing that says whether the answer is obvious.
        if (numberType(value.right) === null) return null;
        if (!isInteger(value.operand)) return null;
        if (valueKey(value.left) !== valueKey(value.right)) return null;
        if (value.op === "eq" || value.op === "ge" || value.op === "le") {
          return { k: "bool", type: BOOL, value: true };
        }
        if (value.op === "ne" || value.op === "lt" || value.op === "gt") {
          return { k: "bool", type: BOOL, value: false };
        }
        return null;
      }
      if (FLOAT_TYPES[name] === true && (Number.isNaN(left) || Number.isNaN(right))) {
        // A comparison with a NaN is false whatever the operator is, except
        // `ne`, which is true. The backends answer it that way too.
        return { k: "bool", type: BOOL, value: value.op === "ne" };
      }
      const answer = compare(value.op, left, right);
      if (answer === null) return null;
      return { k: "bool", type: BOOL, value: answer };
    }
    case "logical": {
      if (value.left.k === "bool" && value.right.k === "bool") {
        return { k: "bool", type: BOOL, value: value.op === "and" ? value.left.value && value.right.value : value.left.value || value.right.value };
      }
      // A short circuit whose left side is already a truth is its right side,
      // whichever way it decides. `false && x` is false and never runs x;
      // `true && x` is x and runs only x; `true || x` is true and never runs
      // x; `false || x` is x and runs only x. Each is the other side with the
      // branch the deciding truth already made taken out of it, which is what
      // a guard that is already a guard comes to after the fold.
      if (value.left.k === "bool") {
        if (value.op === "and") return value.left.value ? value.right : { k: "bool", type: BOOL, value: false };
        return value.left.value ? { k: "const", type: value.type, text: "1" } : value.right;
      }
      // A short circuit over the same value twice is that value. `x && x` is x
      // whether x is a truth or not: a falsy x answers the left side, and a
      // true one answers the right, and both are x. This is what a name read
      // twice through a short circuit comes to.
      if (valueKey(value.left) === valueKey(value.right)) return value.left;
      return null;
    }
    case "coalesce": {
      if (value.left.k === "nothing") return value.right;
      return null;
    }
    case "select": {
      if (value.condition.k === "bool") {
        return value.condition.value ? value.then : value.otherwise;
      }
      return null;
    }
    case "unary": {
      const operand = literalOf(value.operand);
      if (value.op === "pos" && !(value.operand.type.kind === "ref" && value.operand.type.of === null && value.operand.type.name === undefined)) return value.operand;
      if (value.op === "neg" && operand !== null) {
        const name = numberType(value);
        if (name === null) return null;
        return { k: "const", type: value.type, text: asText(FLOAT_TYPES[name] === true ? -operand : wrapWhole(-operand, name)) };
      }
      // The complement of a number written out is a number written out, which
      // is how `x ^ allOnes` above is answered and how a source that spells a
      // mask directly is folded. It is the mask minus the value at a whole
      // number, and the subtraction wraps exactly as the complement does.
      if (value.op === "bitNot" && operand !== null) {
        const name = numberType(value);
        if (name !== null && FLOAT_TYPES[name] !== true) {
          const mask = allOnesAt(value.type, name);
          if (mask !== null) return { k: "const", type: value.type, text: asText(wrapWhole(mask - operand, name)) };
        }
      }
      if (value.operand.k === "bool") {
        if (value.op === "not") return { k: "bool", type: BOOL, value: !value.operand.value };
        return value.operand;
      }
      return null;
    }
    case "isNull": {
      if (value.operand.k === "nothing") return { k: "bool", type: BOOL, value: value.negate };
      return null;
    }
    case "text": {
      // A string of nothing but literals is a literal.
      if (value.parts.every((part) => part.k === "text")) {
        return { k: "text", type: value.type, parts: value.parts };
      }
      return null;
    }
    default:
      return null;
  }
}

/** What one comparison of two numbers answers, or null when it does not. */
function compare(op: string, left: number, right: number): boolean | null {
  switch (op) {
    case "eq": return left === right;
    case "ne": return left !== right;
    case "lt": return left < right;
    case "le": return left <= right;
    case "gt": return left > right;
    case "ge": return left >= right;
    default: return null;
  }
}
/**
 * Folds a value and everything inside it, outermost first, so an inner fold
 * exposes the outer one. A node that folds is not looked at again.
 */
export function foldSemanticValue(value: SemanticValue): SemanticValue {
  const folded = foldValue(value);
  if (folded !== null) return folded;
  const before = valueChildren(value);
  const children = before.map((child) => foldSemanticValue(child));
  if (children.every((child, index) => child === before[index])) {
    return joinTextParts(value);
  }
  return joinTextParts(withChildren(value, children));
}

/**
 * A string the program builds, with the pieces of it that are written out
 * joined together.
 *
 * Two pieces of text written next to each other are one piece of text, and a
 * string built out of three written pieces and a value is built out of two
 * pieces and a value once the three written ones are joined. A piece that is
 * itself a string written out in full is that string written out, and it is a
 * piece of text like any other.
 *
 * A backend writes a string out by concatenating its parts one at a time, so
 * joining them here is the difference between one concatenation and four.
 *
 * The parts are the same string either way: the text is the text, and the
 * pieces it is written out of are how it was written rather than what it is.
 */
function joinTextParts(value: SemanticValue): SemanticValue {
  if (value.k !== "text") return value;
  let changed = false;
  const parts: SemanticTextPart[] = [];
  const push = (text: string): void => {
    const last = parts[parts.length - 1];
    if (last !== undefined && last.k === "text") {
      parts[parts.length - 1] = { k: "text", value: last.value + text };
      changed = true;
      return;
    }
    parts.push({ k: "text", value: text });
  };
  for (const part of value.parts) {
    if (part.k === "text") {
      push(part.value);
      continue;
    }
    const inner = part.value;
    if (inner.k === "text" && inner.parts.every((one) => one.k === "text")) {
      changed = true;
      for (const one of inner.parts) push((one as { k: "text"; value: string }).value);
      continue;
    }
    parts.push(part);
  }
  if (!changed) return value;
  return { ...value, parts };
}

/* -------------------------------------------------------------------------- */
/* Over a function                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Every value a statement computes, in the order it computes them.
 *
 * A call is one value whose own children are its arguments, which is how
 * `rootsOf` already reads a block, so a name read as an argument is read here
 * too. A walk that stopped at the call would count a name that is read in one
 * as a name nothing reads, and a pass that drops unread bindings would then drop
 * one a call still reads.
 */

/** Every value a block computes, and every one inside those values. */
function valuesOf(block: SemanticBlock, visit: (value: SemanticValue) => void): void {
  for (const statement of block.statements) {
    for (const value of statementValues(statement)) walkSemanticValue(value, visit);
  }
  if (block.terminator.k === "return" && block.terminator.value !== null) {
    walkSemanticValue(block.terminator.value, visit);
  }
}

/**
 * The names the body shares with the scope around it: the strings a function
 * is given to write through, which are held in a cell the caller holds too.
 *
 * A write to one of them is a write the caller sees, so a rewrite that drops a
 * write nothing reads may not drop it: what reads it is in another body.
 */
function sharedNames(body: Body): Set<string> {
  const names = new Set<string>();
  for (const param of body.params) {
    if (param.kind !== "text") continue;
    if ((param as { boxed?: boolean }).boxed !== true) continue;
    names.add(param.name);
  }
  return names;
}

/**
 * The names a function reference of the body captures: the names the program
 * reads of the scope around it and hands to the function it names.
 *
 * A capture is a name written down as text and not as a value, so a rewrite
 * that replaces a read of a name with a value does not reach it: the function
 * is still handed the name, and the name has to be there. A name that is
 * captured is therefore a name no rewrite may write out of the body.
 */
function capturedNames(body: Body): Set<string> {
  const names = new Set<string>();
  for (const block of nestedSemanticBlocks(body.entry)) {
    valuesOf(block, (value) => {
      walkSemanticValue(value, (one) => {
        if (one.k !== "functionRef") return;
        for (const capture of one.captures) names.add(capture.name);
      });
    });
  }
  return names;
}

/**
 * The names one node of a value reads: the name itself, and the names it hands
 * to a function it names.
 *
 * A capture is a name written down as text rather than as a value, so a walk
 * that reads the values alone does not see it: the function reference hands the
 * nested function the binding's value by name, and the name is read where the
 * reference is written. Every pass that asks what a body reads has to ask it
 * this way, or it concludes that a name nothing reads is one nothing reads —
 * and drops the write that gave the name its value.
 */
function namesOfNode(one: SemanticValue): readonly string[] {
  if (one.k === "local") return [one.name];
  if (one.k === "functionRef") return one.captures.map((capture) => capture.name);
  return [];
}

/** A block with every value in it folded, and with its nested blocks folded. */
function foldBlock(block: SemanticBlock): boolean {
  let changed = false;
  block.statements = block.statements.map((statement) => {
    const folded = foldStatement(statement);
    if (folded !== statement) changed = true;
    return folded;
  });
  for (const statement of block.statements) {
    for (const nested of statementBlocksOf(statement)) {
      if (foldBlock(nested)) changed = true;
    }
  }
  if (block.terminator.k === "return" && block.terminator.value !== null) {
    const folded = foldSemanticValue(block.terminator.value);
    if (folded !== block.terminator.value) {
      block.terminator = { ...block.terminator, value: folded };
      changed = true;
    }
  }
  return changed;
}

/**
 * A statement with its value folded, or the statement itself when nothing in it
 * folded.
 *
 * The identity of the returned object is what says whether anything changed:
 * `foldBlock` compares the folded statement against the one it was given, so a
 * rewrite that rebuilds the statement unconditionally reports a change on every
 * round and the fixed point above never ends. Rebuilding only when a value came
 * back a different object makes the report mean what it is written to mean —
 * `foldSemanticValue` returns the very value it was handed when nothing folded,
 * so an unchanged value is the signal that this statement is already folded.
 */
function foldStatement(statement: SemanticStatement): SemanticStatement {
  switch (statement.k) {
    case "step":
      return statement;
    case "setElement": {
      const index = foldSemanticValue(statement.index);
      const value = foldSemanticValue(statement.value);
      return index === statement.index && value === statement.value ? statement : { ...statement, index, value };
    }
    case "fill": {
      const value = foldSemanticValue(statement.value);
      return value === statement.value ? statement : { ...statement, value };
    }
    case "let":
    case "set":
    case "printText":
    case "printNumber":
    case "retain":
    case "storeField": {
      const value = foldSemanticValue(statement.value);
      return value === statement.value ? statement : { ...statement, value };
    }
    case "if": {
      const condition = foldSemanticValue(statement.condition);
      return condition === statement.condition ? statement : { ...statement, condition };
    }
    case "raise": {
      const message = foldSemanticValue(statement.message);
      return message === statement.message ? statement : { ...statement, message };
    }
    case "loop": {
      const loop = foldLoop(statement.loop);
      return loop === statement.loop ? statement : { ...statement, loop };
    }
    default: return statement;
  }
}

function foldLoop(loop: SemanticLoop): SemanticLoop {
  if (loop.kind === "counted") {
    const from = foldSemanticValue(loop.from);
    const to = foldSemanticValue(loop.to);
    const step = loop.step === null ? null : foldSemanticValue(loop.step);
    if (from === loop.from && to === loop.to && step === loop.step) return loop;
    return { ...loop, from, to, step };
  }
  if (loop.kind === "each") {
    const length = foldSemanticValue(loop.length);
    return length === loop.length ? loop : { ...loop, length };
  }
  const condition = foldSemanticValue(loop.condition);
  return condition === loop.condition ? loop : { ...loop, condition };
}

/* -------------------------------------------------------------------------- */
/* Dropping what nothing reads                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Every name a function reads, counted.
 *
 * The count is what makes the removal safe rather than a guess: a `let` whose
 * name is read nowhere is a value nothing looks at, and a `set` of a name
 * that is overwritten before anything reads it is a value nothing ever saw.
 * Both are counted across the whole function, nested blocks included, because a
 * name declared in an arm is read in that arm and nowhere else.
 */
function readCounts(body: Body): Map<string, number> {
  const counts = new Map<string, number>();
  const count = (name: string): void => {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  };
  const walk = (block: SemanticBlock): void => {
    valuesOf(block, (value) => {
      walkSemanticValue(value, (one) => {
        for (const name of namesOfNode(one)) count(name);
      });
    });
    for (const statement of block.statements) {
      for (const nested of statementBlocksOf(statement)) walk(nested);
      // A loop's element and counter are read by the loop statement itself, so
      // they are counted as read whatever the body does with them.
      if (statement.k === "loop" && statement.loop.kind === "each") {
        count(statement.loop.index);
        count(statement.loop.element);
      }
      // The buffer an element is written into is named as a bare string, so no
      // walk of the values above reaches it. It is a read all the same: the
      // name holding the elements is read to find which element is written,
      // and a binding read only that way is one this would otherwise drop,
      // leaving the write naming a name the function never declared.
      if (statement.k === "setElement" || statement.k === "fill") count(statement.buffer);
      // The name a `step` writes is a bare string for the same reason, and the
      // write is the only thing in a body like `let i = 0; i++;` that keeps
      // the slot alive. Dropping the declaration there left the increment
      // naming a slot the block never declared, which the validator refuses by
      // name.
      if (statement.k === "step") count(statement.name);
      // A compound assignment reads the name it writes: `text += more` is a
      // read of the text and a write of it, and a binding that is read only
      // that way is one this would otherwise drop, leaving the write naming a
      // name the block never declared.
      if (statement.k === "set" && statement.op !== "=") count(statement.name);
    }
  };
  walk(body.entry);
  return counts;
}

/**
 * Drops the bindings nothing reads.
 *
 * This is what makes the other rules here able to run more than once. Every
 * rewrite that binds a value adds a `let`, and nothing removed them, so a
 * function that had been through a few rounds was carrying the names of them
 * all. A name nothing reads is a value nothing looks at, and the backends
 * still lower it: a `let` is an allocation and a store on every target.
 *
 * A name a `release` names is not dropped. The validator requires a block to
 * release what it allocated, in the order it allocated it, and a name that is
 * gone from the statements is still named by that list, so the two have to go
 * together or the validator is right to refuse the function.
 */
function dropUnread(body: Body): boolean {
  const counts = readCounts(body);
  const keep = (name: string, released: boolean): boolean => released || (counts.get(name) ?? 0) > 0;
  const walk = (block: SemanticBlock): boolean => {
    let changed = false;
    block.statements = block.statements.filter((statement) => {
      if (statement.k === "let") {
        if (keep(statement.slot.name, block.releases.includes(statement.slot.name))) return true;
        // A binding whose value is not a value — a call that has an effect, a
        // read of memory, a division that may fault — is not dropped: the
        // effect is what the statement is there for, and dropping the binding
        // takes it out of the program.
        if (!isSafeToCompute(statement.value)) return true;
        changed = true;
        return false;
      }
      return true;
    });
    for (const statement of block.statements) {
      for (const nested of statementBlocksOf(statement)) {
        if (walk(nested)) changed = true;
      }
    }
    if (changed) block.releases = block.releases.filter((name) => counts.has(name) || block.releases.includes(name));
    return changed;
  };
  return walk(body.entry);
}

/**
 * Hoists what a loop reads on every turn and never changes.
 *
 * The rule a review can propose hoists a value the loop computes MORE THAN
 * ONCE, which is the wrong end of it: the value that costs is the one computed
 * exactly once per turn and never at all outside — a bound that is a call, a
 * field read, or an expression over the loop's own parameter. That is what this
 * hoists, and it is hoisted for every loop rather than only for one a model
 * named.
 *
 * The value has to be the same on every turn, which is decided the same way the
 * proposed rule decides it: it may not read a name the loop writes (its
 * counter, its element, or anything the body assigns), and it may not read
 * memory, because the IR holds no length and no null test and a load hoisted
 * out of a turn that did not read it is a read the source never performed.
 */
function hoistLoopInvariants(body: Body): boolean {
  // The names a binding is written under are taken from a set every binding in
  // the body is checked against, and not counted out of the statement the hoist
  // sat at: two loops at the same place in two different blocks — an outer loop
  // and one nested in it — both said `invariant2_0`, and the inner declaration
  // shadowed the outer one for the rest of the block. A body that hoisted `x * 2`
  // above its outer loop and `k + 1` above its inner one then read the *inner*
  // name where the source read the outer value, and answered 87 where it says
  // 78. One set for the whole body is what makes a name answer for one binding.
  const taken = new Set<string>(body.params.map((param) => param.name));
  for (const block of nestedSemanticBlocks(body.entry)) {
    for (const statement of block.statements) if (statement.k === "let") taken.add(statement.slot.name);
  }
  let changed = false;
  const walk = (block: SemanticBlock): void => {
    // A hoist inserts a statement above the loop it hoisted out of, so the
    // index moves under the walk and it is stepped rather than mapped.
    for (let at = 0; at < block.statements.length; at += 1) {
      if (hoistOne(block, at, taken)) {
        changed = true;
        at += 1;
      }
    }
    for (const statement of block.statements) {
      for (const nested of statementBlocksOf(statement)) walk(nested);
    }
  };
  walk(body.entry);
  return changed;
}

/* -------------------------------------------------------------------------- */
/* Unrolling                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * How many turns of a counted loop are counted before the loop is left as the
 * source wrote it. Counting is what decides whether the loop can be unrolled,
 * and a loop that turns a hundred million times is worth more standing still
 * than is worth counting.
 */
const MAX_COUNTED_TURNS = 1024;

/** As many turns as are written out whole before a loop is left as it is. */
const MAX_UNROLLED_TURNS = 4;

/** As many statements as the turns of one body may add up to. */
const MAX_UNROLLED_STATEMENTS = 64;

/**
 * A number a loop counts in, as the compiler's own, or null when it is not one
 * this can count in.
 *
 * Both have to be whole, and for the same reason: a turn of an unrolled body
 * reads its own number off the counter by an addition, and an addition over a
 * number that is not whole — or that is whole but too large to be exact — is a
 * turn that ran on a number the source never wrote.
 */
function countedNumber(value: SemanticValue): number | null {
  if (value.k !== "const") return null;
  if (numberType(value) === null) return null;
  const number = asNumber(value.text);
  return number !== null && Number.isSafeInteger(number) ? number : null;
}

/** A whole number written out at a type, which is what a bound and a step become. */
function integerAt(type: SemanticType, value: number): SemanticValue {
  return { k: "const", type, text: asText(value) };
}

/* -------------------------------------------------------------------------- */
/* A scalar multiplication, a window at a time                                 */
/* -------------------------------------------------------------------------- */

/** The bits one window of a scalar multiplication holds. */
const WINDOW_BITS = 4;
/** The shift of the highest nibble of a 256 bit scalar. */
const WINDOW_TOP_SHIFT = 256 - WINDOW_BITS;
/** The nibbles one window walks. */
const WINDOW_DIGITS = 1 << WINDOW_BITS;

/** Whether a value is a zero the source wrote out, at any whole width. */
function isWrittenZero(value: SemanticValue): boolean {
  return value.k === "const" && /^[+]?0+$/.test(value.text.trim());
}

/** Whether a value is a whole number written out as this one. */
function isWrittenNumber(value: SemanticValue, wanted: number): boolean {
  if (value.k !== "const") return false;
  const written = asNumber(value.text);
  return written !== null && written === wanted;
}

/**
 * Whether a value is the identity of the points of a curve.
 *
 * The identity of Jacobian coordinates is the point whose `x` and `z` are both
 * zero, and `y` is whatever the source wrote. It arrives one of two ways: as an
 * object built from those fields, or as a constructor called with them, whose
 * parameters are named for the coordinates they become. A call of no arguments
 * is looked through once, because the zero point is a name a program declares
 * as `new Point(0, 1, 0)` inside a function of its own.
 */
function isPointIdentity(value: SemanticValue, callees: Callees, depth = 0): boolean {
  if (value.k === "newObject") {
    const x = value.fields.find((field) => field.name === "x");
    const z = value.fields.find((field) => field.name === "z");
    return x !== undefined && z !== undefined && isWrittenZero(x.value) && isWrittenZero(z.value);
  }
  if (value.k !== "call") return false;
  const params = value.call.signature.params;
  if (params.length === 3 && params[0]?.name === "x" && params[2]?.name === "z") {
    const x = value.call.args[0];
    const z = value.call.args[2];
    return x !== undefined && z !== undefined && isWrittenZero(x) && isWrittenZero(z);
  }
  if (value.call.args.length !== 0 || depth >= 2) return false;
  const callee = callees.get(value.call.callee);
  if (callee === undefined || callee.entry.statements.length > 0) return false;
  const end = callee.entry.terminator;
  return end.k === "return" && end.value !== null && isPointIdentity(end.value, callees, depth + 1);
}

/**
 * The double-and-add loop of one scalar multiplication, as a window at a time.
 *
 * The source of a curve's multiplication walks the scalar one bit at a time:
 * on every turn it doubles the point and adds it to the accumulator when the
 * bit is set. That is 256 doublings and, for a scalar of random bits, 128
 * additions — and an addition of Jacobian points is sixteen limb products
 * where a doubling is nine, so the additions are nearly half of what the
 * multiplication costs.
 *
 * A window is the same arithmetic with four bits decided at once. The
 * multiples `2P` through `15P` are built once, by doubling and adding the point
 * the loop already holds, and each turn of the loop then doubles the
 * accumulator four times and adds the one multiple the next nibble names. The
 * doublings are the same 256; the additions fall to the 64 turns, and one of
 * those adds nothing when the nibble is zero.
 *
 * The pattern the pass recognizes is the shape the source writes, not a name:
 * a `while` whose test is a scalar against zero, whose body adds a point to
 * the accumulator when the low bit of the scalar is set, doubles the point and
 * shifts the scalar down. The accumulator has to start at the identity,
 * because a windowed loop starts from the accumulator the source started from
 * and doubles it the same 256 times: a nonzero start would be multiplied by
 * two to the power of the width on the way.
 *
 * The answer is the same point, because a window is the distributive law over
 * the bits it holds: `4 * p + d` is the four doublings and the one addition,
 * and the nibbles of the scalar are the scalar.
 */
function windowedScalarMultiplication(body: Body, callees: Callees): boolean {
  const taken = new Set<string>(body.params.map((param) => param.name));
  for (const block of nestedSemanticBlocks(body.entry)) {
    taken.add(block.id);
    for (const statement of block.statements) if (statement.k === "let") taken.add(statement.slot.name);
  }
  let changed = false;
  const walk = (block: SemanticBlock): void => {
    for (const statement of block.statements) {
      for (const nested of statementBlocksOf(statement)) walk(nested);
    }
    if (windowOne(block, taken, callees)) changed = true;
  };
  walk(body.entry);
  return changed;
}

/** One loop rewritten as a window, or false when the block holds no such loop. */
function windowOne(block: SemanticBlock, taken: Set<string>, callees: Callees): boolean {
  const at = block.statements.length - 1;
  const statement = block.statements[at];
  if (statement === undefined || statement.k !== "loop" || statement.loop.kind !== "while") return false;
  const loop = statement.loop;
  if (at < 3) return false;
  if (block.terminator.k !== "return" || block.terminator.value === null) return false;
  if (block.terminator.value.k !== "local") return false;
  const pName = block.terminator.value.name;

  const declarations = block.statements.slice(at - 3, at);
  if (declarations.some((one) => one.k !== "let")) return false;
  const declared = new Map<string, Extract<SemanticStatement, { k: "let" }>>();
  for (const one of declarations) {
    if (one.k === "let") declared.set(one.slot.name, one);
  }
  const pLet = declared.get(pName);
  if (pLet === undefined || !isPointIdentity(pLet.value, callees)) return false;

  const body = loop.body;
  if (body.releases.length > 0 || body.terminator.k !== "next" || body.statements.length !== 3) return false;
  const condition = body.statements.find((one) => one.k === "if");
  const writes = body.statements.filter((one) => one.k === "set");
  if (condition === undefined || condition.k !== "if" || writes.length !== 2) return false;

  const doubleSet = writes.find((one) => {
    if (one.k !== "set" || one.value.k !== "call" || one.value.call.args.length !== 1) return false;
    const argument = one.value.call.args[0];
    return argument !== undefined && argument.k === "local" && argument.name === one.name;
  });
  if (doubleSet === undefined || doubleSet.value.k !== "call") return false;
  const dName = doubleSet.name;
  const dLet = declared.get(dName);
  if (pLet.slot.kind !== "object" || dLet === undefined || dLet.slot.kind !== "object") return false;
  const pType = pLet.slot.type;
  if (pType.kind !== "ref" || !typeEquals(dLet.slot.type, pType)) return false;

  const shiftSet = writes.find((one) => one.k === "set" && one !== doubleSet);
  if (shiftSet === undefined || shiftSet.value.k !== "arith" || shiftSet.value.op !== "shr") return false;
  if (shiftSet.value.left.k !== "local" || shiftSet.value.left.name !== shiftSet.name) return false;
  if (!isWrittenNumber(shiftSet.value.right, 1)) return false;
  const nName = shiftSet.name;
  const nLet = declared.get(nName);
  if (nLet === undefined || nLet.slot.kind !== "value") return false;
  if (nLet.slot.type.kind !== "primitive" || nLet.slot.type.name !== "u256") return false;
  const nType = nLet.slot.type;

  if (!comparesZero(loop.condition, nName, "gt")) return false;
  if (condition.otherwise !== null || condition.then.releases.length > 0) return false;
  if (condition.then.terminator.k !== "next" || condition.then.statements.length !== 1) return false;
  const addSet = condition.then.statements[0];
  if (addSet === undefined || addSet.k !== "set" || addSet.name !== pName) return false;
  if (addSet.value.k !== "call" || addSet.value.call.args.length !== 2) return false;
  const [left, right] = addSet.value.call.args;
  if (left === undefined || right === undefined || left.k !== "local" || right.k !== "local") return false;
  if (left.name !== pName || right.name !== dName) return false;
  if (!conditionalOnLowBit(condition.condition, nName)) return false;
  if (!typeEquals(addSet.value.type, pType) || !typeEquals(doubleSet.value.type, pType)) return false;

  const addCall = addSet.value.call;
  const doubleCall = doubleSet.value.call;
  const line = statement.line;
  const i64: SemanticType = { kind: "primitive", name: "i64" };
  const local = (name: string, type: SemanticType): SemanticValue => ({ k: "local", type, name });
  const callOf = (call: SemanticCall, args: SemanticValue[]): SemanticValue => ({
    k: "call",
    type: call.returns,
    call: { ...call, args, argTypes: args.map((argument) => argument.type) },
  });

  // The multiples the window names. An even one is the double of half of it and
  // an odd one is the even one before it plus the point itself, so every
  // multiple is built from multiples already written down.
  const multiples: string[] = new Array(WINDOW_DIGITS).fill("");
  multiples[1] = dName;
  const tableLets: SemanticStatement[] = [];
  const tableNames: string[] = [];
  for (let digit = 2; digit < WINDOW_DIGITS; digit += 1) {
    const name = freshName(taken, "windowMultiple");
    const value = digit % 2 === 0
      ? callOf(doubleCall, [local(multiples[digit / 2] as string, pType)])
      : callOf(addCall, [local(multiples[digit - 1] as string, pType), local(dName, pType)]);
    multiples[digit] = name;
    tableNames.push(name);
    tableLets.push({ k: "let", slot: { kind: "object", name, mutable: false, type: pType }, value, line });
  }

  const shiftName = freshName(taken, "windowShift");
  const shiftLet: SemanticStatement = {
    k: "let",
    slot: { kind: "value", name: shiftName, mutable: true, type: i64 },
    value: { k: "const", type: i64, text: asText(WINDOW_TOP_SHIFT) },
    line,
  };
  const shift = local(shiftName, i64);
  const digitName = freshName(taken, "windowDigit");
  const digit = local(digitName, nType);

  const statements: SemanticStatement[] = [];
  for (let doubling = 0; doubling < WINDOW_BITS; doubling += 1) {
    statements.push({ k: "set", name: pName, op: "=", value: callOf(doubleCall, [local(pName, pType)]), line });
  }
  statements.push({
    k: "let",
    slot: { kind: "value", name: digitName, mutable: false, type: nType },
    value: {
      k: "arith",
      type: nType,
      op: "and",
      left: { k: "arith", type: nType, op: "shr", left: local(nName, nType), right: shift },
      right: { k: "const", type: i64, text: asText(WINDOW_DIGITS - 1) },
    },
    line,
  });
  for (let value = 1; value < WINDOW_DIGITS; value += 1) {
    statements.push({
      k: "if",
      condition: {
        k: "compare",
        type: BOOL,
        op: "eq",
        operand: nType,
        left: digit,
        right: { k: "const", type: i64, text: asText(value) },
      },
      then: {
        id: freshName(taken, "windowBlock"),
        releases: [],
        statements: [{
          k: "set",
          name: pName,
          op: "=",
          value: callOf(addCall, [local(pName, pType), local(multiples[value] as string, pType)]),
          line,
        }],
        terminator: { k: "next" },
      },
      otherwise: null,
      line,
    });
  }
  statements.push({
    k: "set",
    name: shiftName,
    op: "=",
    value: { k: "arith", type: i64, op: "sub", left: shift, right: { k: "const", type: i64, text: asText(WINDOW_BITS) } },
    line,
  });

  body.statements = statements;
  body.releases = [];
  body.terminator = { k: "next" };
  loop.condition = {
    k: "compare",
    type: BOOL,
    op: "ge",
    operand: i64,
    left: shift,
    right: { k: "const", type: i64, text: "0" },
  };

  // The multiples are the block's own allocations and the loop is the last
  // thing it holds, so they are freed on the way out, innermost declared first.
  for (const name of tableNames) block.releases.unshift(name);
  block.statements.splice(at, 0, ...tableLets, shiftLet);
  return true;
}

/** Whether a condition is a name compared with zero, in one direction. */
function comparesZero(value: SemanticValue, name: string, op: "gt" | "ne"): boolean {
  if (value.k !== "compare" || value.op !== op) return false;
  if (value.left.k === "local" && value.left.name === name) return isWrittenZero(value.right);
  if (value.right.k === "local" && value.right.name === name) return isWrittenZero(value.left);
  return false;
}

/** Whether a condition is the low bit of a name being set. */
function conditionalOnLowBit(value: SemanticValue, name: string): boolean {
  if (value.k !== "compare" || (value.op !== "ne" && value.op !== "gt")) return false;
  const bit = (one: SemanticValue): boolean =>
    one.k === "arith" && one.op === "and" && one.left.k === "local" && one.left.name === name && isWrittenNumber(one.right, 1);
  return (bit(value.left) && isWrittenZero(value.right)) || (bit(value.right) && isWrittenZero(value.left));
}

/**
 * Unrolls the loops whose turn is already settled, and drops the ones that never
 * turn.
 *
 * The rules a review proposes here are `hoist-invariant` and nothing else: this
 * is not a rule of the catalogue but a property of the IR, decided the same way
 * every time and asked about no model. A loop whose ends are all written out
 * runs a number of turns the compiler can work out for itself, and a number of
 * turns it knows is a number of turns it does not have to ask about: the count
 * and the compare go, and what is left is the body, several times over.
 *
 * The counter is what makes it safe. A turn that leaves the loop, or that moves
 * the counter itself, is a turn this cannot write twice, and a body either has
 * those or has not — which is the whole of what is decided before anything is
 * rewritten.
 */
function unrollCountedLoops(body: Body): boolean {
  let changed = false;
  // A copy of a body brings names and block ids with it, and neither may be one
  // the function already has, so what they are taken from grows as the walk
  // goes and a later loop cannot mint what an earlier one took.
  const taken = new Set<string>();
  for (const param of body.params) taken.add(param.name);
  for (const block of nestedSemanticBlocks(body.entry)) {
    taken.add(block.id);
    for (const statement of block.statements) {
      if (statement.k === "let") taken.add(statement.slot.name);
    }
  }
  const walk = (block: SemanticBlock): void => {
    block.statements = block.statements.flatMap((statement) => {
      if (statement.k !== "loop") return [statement];
      const rewritten = unrollOne(statement, taken);
      if (rewritten === null) return [statement];
      changed = true;
      return rewritten;
    });
    for (const statement of block.statements) {
      for (const nested of statementBlocksOf(statement)) walk(nested);
    }
  };
  walk(body.entry);
  return changed;
}

/**
 * What a counted loop turns into, or null when it is left as it was written.
 *
 * Nothing here is asked of the loop's body beyond what a turn may and may not
 * do: it may not leave the loop, and it may not move the counter. Everything
 * else — the counter's type, whether it wraps, whether the turns divide evenly
 * — is arithmetic, and it is done in the loop's own type because that is where
 * the counter lives.
 */
function unrollOne(
  statement: Extract<SemanticStatement, { k: "loop" }>,
  taken: Set<string>,
): SemanticStatement[] | null {
  const loop = statement.loop;
  if (loop.kind !== "counted") return null;
  if (loop.type.kind !== "primitive") return null;
  if (WIDTH[loop.type.name] === undefined && FLOAT_TYPES[loop.type.name] !== true) return null;
  const name = loop.type.name as NumericName;
  // A whole number of a whole-number type counts in that type's range, because
  // that is where the counter lives: a `u8` counting to ten runs two hundred
  // and eighty-one times, wrapping round, and a count done in the compiler's own
  // numbers would call that one turn. A float counts as a double, which is what
  // the machine adds with.
  const whole = WIDTH[loop.type.name] !== undefined;

  const from = countedNumber(loop.from);
  const to = countedNumber(loop.to);
  const step = loop.step === null ? (loop.down ? -1 : 1) : countedNumber(loop.step);
  if (from === null || to === null || step === null || step === 0) return null;
  // A counter that does not move toward the bound it counts to is a loop the
  // source wrote, and this pass does not second-guess one.
  if (loop.down ? step > 0 : step < 0) return null;

  // A turn that leaves the loop cannot be written twice: a `continue` would
  // restart the unrolled loop rather than skip the copy beside it, and a
  // `break` — of this loop or of one inside it — would leave the whole of it.
  if (nestedSemanticBlocks(loop.body).some((block) => block.terminator.k === "jump")) return null;
  // A turn that moves the counter cannot be told from the turn beside it, since
  // which number it is on is what the copy is written against.
  if (namesWrittenIn(loop.body).has(loop.variable)) return null;

  const keepsGoing = (counter: number): boolean =>
    loop.inclusive
      ? loop.down
        ? counter >= to
        : counter <= to
      : loop.down
        ? counter > to
        : counter < to;
  let turns = 0;
  let counter = from;
  while (keepsGoing(counter)) {
    counter = whole ? wrapWhole(counter + step, name) : counter + step;
    if (!Number.isSafeInteger(counter)) return null;
    turns += 1;
    if (turns > MAX_COUNTED_TURNS) return null;
  }

  // A loop that never turns is a loop that is not there.
  if (turns === 0) return [];
  // A loop of a few turns is written out whole, and that is the whole of what
  // this does. Writing out every turn takes the counter away altogether: the
  // number a turn is on is a number written out, so the arithmetic over it
  // folds, and what is left is the body with no step, no compare and no branch
  // around it. A loop of three turns over four statements measured eight percent
  // faster that way and the same function with sixty-four turns measured four
  // percent SLOWER when it was unrolled by copies instead, because a copy after
  // the first has to work out its own number off a counter that is still
  // moving. So the count is taken when it is small enough to write down and the
  // loop is left alone when it is not.
  if (turns > MAX_UNROLLED_TURNS || turns * loop.body.statements.length > MAX_UNROLLED_STATEMENTS) return null;
  return Array.from({ length: turns }, (_one, turn) => ({
    k: "block" as const,
    body: copyOfBody(loop, taken, integerAt(loop.type, wrapWhole(from + turn * step, name))),
    line: statement.line,
  }));
}

/**
 * One turn of a counted loop, written out.
 *
 * The turn is a block of its own, which is where the names it declares are kept
 * apart: two turns that both declare `sum` are two turns writing the same slot,
 * so every name a turn declares is renamed beside the one it had, and its blocks
 * are renamed for the same reason.
 *
 * `counter` is the number this turn is on. It is not a name read: the turn
 * leaves the loop, and the counter was declared in it, so the one number it
 * held is written into the turn in full.
 */
function copyOfBody(
  loop: Extract<SemanticLoop, { kind: "counted" }>,
  taken: Set<string>,
  counter: SemanticValue,
): SemanticBlock {
  const writes = new Map<string, string>();
  for (const block of nestedSemanticBlocks(loop.body)) {
    for (const name of declaredNames(block)) writes.set(name, freshName(taken, "unrolled"));
  }
  const blocks = new Map<string, string>();
  for (const block of nestedSemanticBlocks(loop.body)) {
    blocks.set(block.id, freshName(taken, "unrolledBlock"));
  }
  const bindings = new Map<string, SemanticValue>([[loop.variable, counter]]);
  return replaceBlockIds(substituteLocals(loop.body, bindings, writes), blocks) as SemanticBlock;
}

/**
 * The values a loop statement carries that do not change between turns.
 *
 * A counted loop's bound and step, a for-of's length, a while's condition: the
 * positions the loop reads on every turn and the body never writes. A counter
 * is not among them — the loop writes it — and neither is anything the body
 * assigns.
 */
function loopInvariants(loop: SemanticLoop): SemanticValue[] {
  if (loop.kind === "counted") return [loop.to, ...(loop.step === null ? [] : [loop.step])];
  if (loop.kind === "each") return [loop.length];
  return [loop.condition];
}

/** Every name a loop and the blocks inside it write, which an invariant may not read. */
function namesWrittenBy(loop: SemanticLoop): Set<string> {
  const written = namesWrittenIn(loop.body);
  if (loop.kind === "counted") written.add(loop.variable);
  else if (loop.kind === "each") {
    written.add(loop.index);
    written.add(loop.element);
  }
  return written;
}

/** Every name the statements of a block and the blocks inside it write. */
function namesWrittenIn(block: SemanticBlock): Set<string> {
  const written = new Set<string>();
  const walk = (one: SemanticBlock): void => {
    for (const statement of one.statements) {
      switch (statement.k) {
        case "set":
        case "step": written.add(statement.name); break;
        case "setElement": written.add(statement.buffer); break;
        case "fill": written.add(statement.buffer); break;
        case "let": written.add(statement.slot.name); break;
        // A loop written inside the block writes its own counter, and a value
        // that reads one is not the same value on every turn of the loop
        // around it. Without this the counter was invisible to the loop
        // enclosing the one that declared it: hoisting `j === 1` out of an
        // inner loop looked impossible (the inner loop writes `j`) but it was
        // hoisted out of the *outer* one instead, into a block where `j` was
        // never declared.
        case "loop": {
          const inner = statement.loop;
          if (inner.kind === "counted") written.add(inner.variable);
          else if (inner.kind === "each") {
            written.add(inner.index);
            written.add(inner.element);
          }
          break;
        }
      }
      for (const nested of statementBlocksOf(statement)) walk(nested);
    }
  };
  walk(block);
  return written;
}

/** A value a hoist may not move: one that reads memory or a name that changes. */
function readsMemoryOrChanges(value: SemanticValue, written: ReadonlySet<string>): boolean {
  let unsafe = false;
  walkSemanticValue(value, (one) => {
    if (one.k === "element" || one.k === "loadField" || one.k === "length") unsafe = true;
    if (one.k === "local" && written.has(one.name)) unsafe = true;
    // A call that has an effect is not the same value on every turn: it reads
    // the world, so computing it once above the loop reads the world once
    // where the source read it on every turn. A loop whose condition is
    // `sqlite.step(stmt) > 0` hoisted out of the loop reads one row and then
    // loops on it forever.
    if (one.k === "call" && one.call.effects.length > 0) unsafe = true;
  });
  return unsafe;
}

/**
 * Binds every value of a loop that is worth a name, and rewrites the loop to
 * read them.
 *
 * A value that is already a bare name is not given another: it is what the
 * loop reads today, and a name for it would cost a slot and save nothing. A
 * value that reads memory, or that reads a name the loop or its body writes, is
 * left alone for the reason `hoist-invariant` leaves it alone — it is not the
 * same value on every turn, or computing it on a turn that did not read it is a
 * read the source never performed.
 *
 * The bindings go immediately above the loop, in the block it is written in, so
 * each name is in scope for the loop and for whatever follows it that read the
 * value the loop read.
 */
function hoistOne(owner: SemanticBlock, at: number, taken: Set<string>): boolean {
  const statement = owner.statements[at];
  if (statement === undefined || statement.k !== "loop") return false;
  const written = namesWrittenBy(statement.loop);
  const bindings: SemanticStatement[] = [];
  const reads = new Map<string, SemanticValue>();
  const bind = (value: SemanticValue): void => {
    if (reads.has(valueKey(value))) return;
    // A name the whole body is asked about, so two bindings written in two
    // different blocks cannot answer to one spelling — which is what made an
    // outer loop's hoisted value read back as the inner loop's.
    const name = freshName(taken, "invariant");
    reads.set(valueKey(value), { k: "local", type: value.type, name });
    bindings.push({ k: "let", slot: slotFor(value, name), value, line: statement.line });
  };
  loopInvariants(statement.loop).forEach((value) => {
    if (value.k === "local" || value.k === "const") return;
    if (readsMemoryOrChanges(value, written)) return;
    bind(value);
  });
  // The body is where the value that costs is. A loop's own bound is read once
  // per turn and is usually a number or a name the loop reads from the frame;
  // what a body computes every turn is an expression over names nothing in the
  // loop writes, and that one is hoisted here rather than waiting for a model
  // to propose it at a site.
  //
  // Once per turn is enough, and is the case the rule a review proposes cannot
  // reach: `hoist-invariant` binds a value computed MORE THAN ONCE, which is
  // the wrong end of it. A body that computes `n * 2` on every turn of a
  // hundred-turn loop computes it ninety-nine times more than it needs to.
  hoistableIn(statement.loop.body, written).forEach(bind);
  if (bindings.length === 0) return false;
  owner.statements[at] = { ...statement, loop: replaceValues(statement.loop, reads) as SemanticLoop };
  owner.statements.splice(at, 0, ...bindings);
  return true;
}

/**
 * Every value a block computes that is worth computing once above it, once for
 * however many turns run.
 *
 * Every block of it is read, itself included, and a value is in the answer once
 * for anywhere it appears: a body that computes the same value twice is the
 * case the rule a review proposes is for, and one that computes it once is the
 * case the rule cannot reach and costs the most.
 */
function hoistableIn(block: SemanticBlock, written: ReadonlySet<string>): SemanticValue[] {
  const roots: SemanticValue[] = [];
  for (const nested of nestedSemanticBlocks(block)) roots.push(...rootsOf(nested));
  const seen = new Set<string>();
  const hoistable: SemanticValue[] = [];
  for (const value of candidates(roots, written)) {
    const key = valueKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    hoistable.push(value);
  }
  // A read of an element of a buffer the loop never writes, at an index the
  // loop never changes, is the same value on every turn: hoisting it reads the
  // buffer once above the loop instead of once per turn. `candidates` refuses
  // every element read because `isSafeToCompute` holds all memory reads too
  // conservative to bind in general, but a loop-invariant element read is sound
  // to hoist here — neither the buffer nor the index is written by the loop, so
  // every turn would read the very same element.
  for (const root of roots) {
    walkSemanticValue(root, (value) => {
      if (value.k !== "element") return;
      if (!isElementReadLoopInvariant(value, written)) return;
      const key = valueKey(value);
      if (seen.has(key)) return;
      seen.add(key);
      hoistable.push(value);
    });
  }
  return hoistable;
}

/**
 * Whether one element read names the same value on every turn of a loop: the
 * buffer it reads is one the loop never writes, and the index it reads at is
 * one the loop never changes.
 */
function isElementReadLoopInvariant(
  value: SemanticValue & { k: "element" },
  written: ReadonlySet<string>,
): boolean {
  if (value.of.k !== "local" || written.has(value.of.name)) return false;
  let dependent = false;
  walkSemanticValue(value.index, (one) => {
    if (one.k === "local" && written.has(one.name)) dependent = true;
  });
  return !dependent;
}

function repeatedAmong(roots: readonly SemanticValue[], written: ReadonlySet<string>): SemanticValue[] {
  const counts = new Map<string, number>();
  for (const value of candidates(roots, written)) {
    counts.set(valueKey(value), (counts.get(valueKey(value)) ?? 0) + 1);
  }
  const all = candidates(roots, written);
  return all.filter((value) => (counts.get(valueKey(value)) ?? 0) > 1);
}

/**
 * Every value a set of roots computes that could be bound to a name: one that
 * is computed rather than read, none of it calls, none of it reads a name the
 * region writes, and it can be computed wherever it is moved to.
 *
 * The three tests are the ones `hoist-invariant` and `common-subexpression`
 * hold a proposal to, so a value this binds and a value a rule binds are the
 * same value. A name and a number are excluded because binding one is a slot
 * and a store where reading it was already one instruction.
 */
function candidates(roots: readonly SemanticValue[], written: ReadonlySet<string>): SemanticValue[] {
  const found: SemanticValue[] = [];
  for (const root of roots) {
    walkSemanticValue(root, (value) => {
      if (value.k === "local" || value.k === "const") return;
      if (!isBindable(value) || hasCall(value) || !isSafeToCompute(value)) return;
      let readsWritten = false;
      walkSemanticValue(value, (one) => {
        if (one.k === "local" && written.has(one.name)) readsWritten = true;
      });
      if (readsWritten) return;
      found.push(value);
    });
  }
  return found;
}

/** Every value a block computes in its own right, without its nested blocks. */
function rootsOf(block: SemanticBlock): SemanticValue[] {
  const roots: SemanticValue[] = [];
  const read = (value: SemanticValue | null): void => {
    if (value !== null) roots.push(value);
  };
  for (const statement of block.statements) {
    switch (statement.k) {
      case "let":
      case "set":
      case "printText":
      case "printNumber":
      case "retain":
      case "storeField": read(statement.value); break;
      case "setElement": read(statement.index); read(statement.value); break;
      case "fill": read(statement.value); break;
      case "if": read(statement.condition); break;
      case "raise": read(statement.message); break;
      case "call": roots.push({ k: "call", type: statement.call.returns, call: statement.call }); break;
      case "loop": {
        const loop = statement.loop;
        if (loop.kind === "counted") {
          read(loop.from);
          read(loop.to);
          read(loop.step);
        } else if (loop.kind === "each") read(loop.length);
        else read(loop.condition);
        break;
      }
      default: break;
    }
  }
  if (block.terminator.k === "return") read(block.terminator.value);
  return roots;
}

/**
 * Commoning every value a block computes more than once, at the top of that
 * block.
 *
 * This is the rewrite a review can only propose at a site it names, so it
 * happens only when a model happens to name the right block. The values are the
 * ones `common-subexpression` holds a proposal to, so what this binds and what
 * that binds are the same values: computed rather than read, nothing in them
 * calls, and computable wherever they are moved to — which is what makes
 * computing one on a turn that did not read it the same program.
 *
 * The bindings go at the top of the block, which is above every statement that
 * reads one of them and below every statement that writes a name one of them
 * reads, so each is computed once and is the same value everywhere it is used.
 */
function commonWithin(body: Body): boolean {
  // The same rule the hoister is held to: a name the whole body is asked about,
  // so two bindings written in two rounds — or in two different blocks — cannot
  // answer to one spelling. Counting out of the block and the order gave a body
  // two bindings both called `commonentry_1`, one for `x * 2` and one for `x / 2`,
  // and every read after the second was the first's value with the second's
  // name on it.
  const taken = new Set<string>(body.params.map((param) => param.name));
  for (const block of nestedSemanticBlocks(body.entry)) {
    for (const statement of block.statements) if (statement.k === "let") taken.add(statement.slot.name);
  }
  let changed = false;
  const walk = (block: SemanticBlock): void => {
    if (commonOne(block, taken)) changed = true;
    for (const statement of block.statements) {
      for (const nested of statementBlocksOf(statement)) walk(nested);
    }
  };
  walk(body.entry);
  return changed;
}

function commonOne(block: SemanticBlock, taken: Set<string>): boolean {
  const repeated = repeatedAmong(rootsOf(block), namesWrittenHere(block));
  if (repeated.length === 0) return false;
  const line = block.statements[0]?.line ?? 0;
  const reads = new Map<string, SemanticValue>();
  const bindings: SemanticStatement[] = [];
  for (const value of repeated) {
    const name = freshName(taken, "common");
    reads.set(valueKey(value), { k: "local", type: value.type, name });
    bindings.push({ k: "let", slot: slotFor(value, name), value, line });
  }
  block.statements = block.statements.map((statement) => replaceValues(statement, reads) as SemanticStatement);
  if (block.terminator.k === "return" && block.terminator.value !== null) {
    block.terminator = { ...block.terminator, value: replaceValues(block.terminator.value, reads) };
  }
  block.statements.unshift(...bindings);
  return true;
}

/**
 * Every name a block's statements write, nested blocks included.
 *
 * The bindings go at the top of the block and the reads they replace are
 * rewritten inside the nested blocks as well, so a name a nested block writes is
 * a name a binding above it may not read: a value computed once above a nested
 * block and once below it is two numbers if the block writes something the
 * value reads, and binding it at the top makes the lower one the upper one.
 */
function namesWrittenHere(block: SemanticBlock): Set<string> {
  const written = new Set<string>();
  for (const nested of nestedSemanticBlocks(block)) {
    for (const statement of nested.statements) {
      if (statement.k === "set" || statement.k === "step") written.add(statement.name);
      if (statement.k === "setElement") written.add(statement.buffer);
      if (statement.k === "fill") written.add(statement.buffer);
      if (statement.k === "storeField") {
        walkSemanticValue(statement.object, (part) => {
          if (part.k === "local") written.add(part.name);
        });
      }
      if (statement.k === "let") written.add(statement.slot.name);
    }
  }
  return written;
}

/**
 * Replaces every read of a name whose value is another name with a read of
 * that one, and drops the binding.
 *
 * A copy of a name is a slot, a store and a load on every read, for a name the
 * program already has. It is the same program only where nothing writes the
 * name it copies between the binding and the reads: a program that counts a
 * name down and reads the copy afterwards is reading the number it started
 * with, not the one the counter holds now. Nothing writing that name anywhere
 * in the function is the test that says so without having to place every read
 * against every write.
 *
 * A name reached through a buffer is not one of those reads either way. An
 * element is written into a buffer the statement names as a bare string, so a
 * substitution over values cannot reach it: propagating a copy of a name that
 * is written or read that way would drop the binding and leave the element
 * write naming a name the function does not have. Such a name is therefore
 * both written and unreachable here, and the copy is left alone.
 */
function propagateCopies(body: Body): boolean {
  const writes = new Set<string>();
  const buffers = new Set<string>();
  const captured = capturedNames(body);
  const candidates: { name: string; source: string }[] = [];
  for (const block of nestedSemanticBlocks(body.entry)) {
    for (const statement of block.statements) {
      if (statement.k === "set" || statement.k === "step") writes.add(statement.name);
      if (statement.k === "setElement" || statement.k === "fill") {
        writes.add(statement.buffer);
        buffers.add(statement.buffer);
      }
      if (statement.k === "let" && statement.value.k === "local") {
        candidates.push({ name: statement.slot.name, source: statement.value.name });
      }
    }
  }
  const copied = candidates.filter(
    (copy) =>
      !writes.has(copy.source) &&
      !writes.has(copy.name) &&
      !buffers.has(copy.source) &&
      !buffers.has(copy.name) &&
      // A name a function reference captures is handed to that function by
      // name, and the copy would leave the name the function is given with
      // nothing behind it.
      !captured.has(copy.name),
  );
  if (copied.length === 0) return false;
  // Keyed by the read of the copy rather than by the read it becomes, because
  // that is the node `replaceValues` finds. A copy of a copy — `let b = a;
  // let c = b` — is a chain, and the read of `c` becomes a read of `b`, which
  // is a name this pass is dropping. A value that has already been replaced is
  // not looked at again, so the read of `b` inside the value `c` was replaced
  // by would survive it and be left naming nothing. Each copy is therefore
  // resolved against the copies recorded before it, which is every name its
  // value can read: a value reads what is declared above it, and every copy
  // above it has been resolved already.
  const reads = new Map<string, SemanticValue>();
  for (const copy of copied) {
    const type = localTypeOf(body, copy.name);
    const source = { k: "local", type, name: copy.source } as const;
    reads.set(valueKey({ k: "local", type, name: copy.name }), replaceValues(source, reads) as SemanticValue);
  }
  const isCopy = (name: string): boolean => copied.some((copy) => copy.name === name);
  const walk = (block: SemanticBlock): void => {
    block.statements = block.statements
      .filter((statement) => !(statement.k === "let" && isCopy(statement.slot.name)))
      .map((statement) => replaceValues(statement, reads) as SemanticStatement);
    for (const statement of block.statements) {
      for (const nested of statementBlocksOf(statement)) walk(nested);
    }
    if (block.terminator.k === "return" && block.terminator.value !== null) {
      block.terminator = { ...block.terminator, value: replaceValues(block.terminator.value, reads) };
    }
    block.releases = block.releases.filter((name) => !isCopy(name));
  };
  walk(body.entry);
  return true;
}

/** The type a name is read as, which is the type its own binding declares. */
function localTypeOf(body: Body, name: string): SemanticType {
  for (const parameter of body.params) if (parameter.name === name) return slotType(parameter);
  for (const block of nestedSemanticBlocks(body.entry)) {
    for (const statement of block.statements) {
      if (statement.k === "let" && statement.slot.name === name) return slotType(statement.slot);
      if (statement.k === "loop") {
        const loop = statement.loop;
        if (loop.kind === "counted" && loop.variable === name) return loop.type;
        if (loop.kind === "each" && loop.element === name) return loop.elementType;
      }
    }
  }
  return { kind: "primitive", name: "bool" };
}

/**
 * Puts the value of a binding into the one place that reads it, and drops the
 * binding.
 *
 * A name read once is a slot, a store and a load wrapped around a value that
 * had somewhere to go all along. The machine pools those, so what goes is the
 * store and the load rather than the slot, which is one instruction each — and
 * in a loop body that is one each on every turn. It is the shape
 * `let tree = createTree(depth)` followed by one use of `tree` is, which is
 * what a program written as `sum += checksum(createTree(depth))` becomes by the
 * time it reaches here.
 *
 * Three things bound where the read may be, and all three are about it being
 * this turn's read rather than another:
 *
 * - It is in the same block. A read inside an arm or a loop is a read on a turn
 *   the binding may not run on, or more than once, and moving the value there
 *   computes it on turns the source never did.
 * - Nothing between writes a name the value reads. A program that computes a
 *   value, counts its own input down and then reads the value is reading the
 *   number the value was made from.
 * - The value is safe to compute wherever it is moved to, so no statement in
 *   between can fault and the move cannot put a fault where the program had
 *   none. That is `isSafeToCompute`, the same test `hoist-invariant` and
 *   `common-subexpression` hold a proposal to.
 *
 * A name that is written again is not a binding at all and is left to
 * `propagateCopies`, which reads the copies out rather than the values.
 */
function inlineSingleUses(body: Body): boolean {
  const reads = new Map<string, number>();
  const captured = capturedNames(body);
  for (const block of nestedSemanticBlocks(body.entry)) {
    valuesOf(block, (one) => {
      for (const name of namesOfNode(one)) reads.set(name, (reads.get(name) ?? 0) + 1);
    });
    // A name a buffer write names is read by that write, and a binding dropped
    // while the write stands leaves the write naming a name the block does not
    // have. The buffer is a bare string, so no walk of the values reaches it.
    for (const statement of block.statements) {
      if (statement.k === "setElement" || statement.k === "fill") {
        reads.set(statement.buffer, (reads.get(statement.buffer) ?? 0) + 1);
      }
    }
  }
  let changed = false;
  for (const block of nestedSemanticBlocks(body.entry)) {
    const keep: SemanticStatement[] = [];
    const replacements = new Map<string, SemanticValue>();
    for (let at = 0; at < block.statements.length; at += 1) {
      const statement = block.statements[at];
      const name =
        statement !== undefined && statement.k === "let"
          ? singleUseBinding(statement, at, block, reads, captured)
          : null;
      if (statement === undefined || name === null || statement.k !== "let") {
        if (statement !== undefined) keep.push(statement);
        continue;
      }
      // The same chain as `propagateCopies` meets here: `let v1 = v0 + 1` in a
      // block of them has each value read the name the binding before it
      // replaces. A replaced value is not looked at again, so that read would
      // outlive the binding it names. Resolving the value against the bindings
      // recorded before it closes the chain before anything is replaced, and a
      // value only reads what is declared above it, so those are all of them.
      replacements.set(
        valueKey({ k: "local", type: slotType(statement.slot), name }),
        replaceValues(statement.value, replacements),
      );
      changed = true;
    }
    if (replacements.size === 0) continue;
    block.statements = keep.map((statement) => replaceValues(statement, replacements) as SemanticStatement);
    if (block.terminator.k === "return" && block.terminator.value !== null) {
      block.terminator = { ...block.terminator, value: replaceValues(block.terminator.value, replacements) };
    }
  }
  return changed;
}

/**
 * Whether a statement binds a name that is read exactly once, that nothing
 * writes between the binding and that read, and whose value is safe to compute
 * where the read is.
 *
 * The test walks forward from the statement rather than counting reads alone:
 * one read says the name is read once, and walking says the read is on this
 * turn and nothing has changed under it.
 */
function singleUseBinding(
  statement: SemanticStatement,
  at: number,
  block: SemanticBlock,
  reads: ReadonlyMap<string, number>,
  captured: ReadonlySet<string>,
): string | null {
  if (statement.k !== "let" || statement.value.k === "local") return null;
  const name = statement.slot.name;
  // A name a function reference captures is handed to that function by name,
  // and the function is handed the name and not the value: writing the value
  // out of the body leaves the function with a name nothing holds.
  if (captured.has(name)) return null;
  if (reads.get(name) !== 1) return null;
  if (block.releases.includes(name)) return null;
  if (!isSafeToCompute(statement.value)) return null;
  // The read is of the binding's own type. A slot declared at one width and
  // bound to a value of another is a conversion the source asked for, and
  // putting the value where the name was would drop it.
  if (typeLabel(statement.value.type) !== typeLabel(slotType(statement.slot))) return null;
  // Two sets of names, and both have to be clear of everything in between: the
  // ones the value is made of, which a write would change under it, and the name
  // the binding itself, which `set s += 1` writes while reading nothing. A
  // compound assignment is the one that catches the second — the value it
  // carries is the right-hand side, and the name on the left is nowhere in it.
  const clobbered = new Set<string>();
  walkSemanticValue(statement.value, (one) => {
    if (one.k === "local") clobbered.add(one.name);
  });
  clobbered.add(name);
  // Every statement after the binding is scanned for the one read, and the scan
  // stops at anything that leaves the block: a loop, an arm or a raise is a turn
  // this statement's value may not survive to.
  for (let after = at + 1; after < block.statements.length; after += 1) {
    const next = block.statements[after];
    if (next === undefined) return null;
    if (next.k === "loop" || next.k === "if" || next.k === "block" || next.k === "raise") return null;
    if (writesAnyOf(next, clobbered)) return null;
    if (readsNameInStatement(next, name)) return movableInto(next, name);
    continue;
  }
  const returned = block.terminator.k === "return" ? block.terminator.value : null;
  if (returned === null || !readsName(returned, name)) return null;
  let underTest = false;
  walkSemanticValue(returned, (one) => {
    if (one.k !== "logical" && one.k !== "coalesce") return;
    if (readsName(one.left, name)) underTest = true;
  });
  return underTest ? null : name;
}

/**
 * The name, when the values it is read in are written down once each.
 *
 * The arm a `&&`, a `||` or a `??` decides on is written as the test and again
 * as the value that answers when the test says so, so a value moved into it is
 * computed twice — which `evaluatedOnceProblems` refuses, and which the
 * resolver hoists a call out of for exactly that reason. Every other position
 * is written once, so everywhere else the move is the same program.
 */
function movableInto(statement: SemanticStatement, name: string): string | null {
  for (const value of statementValues(statement)) {
    let underTest = false;
    walkSemanticValue(value, (one) => {
      if (one.k !== "logical" && one.k !== "coalesce") return;
      if (readsName(one.left, name)) underTest = true;
    });
    if (underTest) return null;
  }
  return name;
}

/** Whether a statement assigns any of a set of names. */
function writesAnyOf(statement: SemanticStatement, names: ReadonlySet<string>): boolean {
  let writes = false;
  if ((statement.k === "set" || statement.k === "step") && names.has(statement.name)) writes = true;
  if (statement.k === "setElement" && names.has(statement.buffer)) writes = true;
  if (statement.k === "let" && names.has(statement.slot.name)) writes = true;
  return writes;
}

/** Whether a statement reads a name, anywhere in the values it computes. */
function readsNameInStatement(statement: SemanticStatement, name: string): boolean {
  return statementValues(statement).some((value) => readsName(value, name));
}

/** Whether a value reads a name. */
function readsName(value: SemanticValue, name: string): boolean {
  let found = false;
  walkSemanticValue(value, (one) => {
    if (one.k === "local" && one.name === name) found = true;
  });
  return found;
}

/**
 * Drops a write nothing reads afterwards.
 *
 * A `set` of a name no other statement of the function reads is a value nothing
 * ever saw, and on every target it is a slot, a store and the arithmetic that
 * produced it. One that writes something a call makes is left alone: running
 * the call is what the statement is for when nothing reads what it wrote.
 */
function dropDeadWrites(body: Body): boolean {
  const reads = new Map<string, number>();
  const shared = sharedNames(body);
  for (const block of nestedSemanticBlocks(body.entry)) {
    valuesOf(block, (value) => {
      walkSemanticValue(value, (one) => {
        for (const name of namesOfNode(one)) reads.set(name, (reads.get(name) ?? 0) + 1);
      });
    });
  }
  let changed = false;
  for (const block of nestedSemanticBlocks(body.entry)) {
    const before = block.statements.length;
    block.statements = block.statements.filter((statement) => {
      if (statement.k !== "set" || statement.op !== "=") return true;
      if (block.releases.includes(statement.name)) return true;
      // A write to a string the caller holds is a write the caller sees, and
      // what reads it is in the caller's body and not in this one.
      if (shared.has(statement.name)) return true;
      if ((reads.get(statement.name) ?? 0) > 0) return true;
      let calls = false;
      walkSemanticValue(statement.value, (one) => {
        if (one.k === "call") calls = true;
      });
      return calls;
    });
    if (block.statements.length !== before) changed = true;
  }
  return changed;
}

/**
 * Drops a write to a name that is written again before anything reads it.
 *
 * `dropDeadWrites` above takes a write nothing reads anywhere. This takes the
 * other half: a write that something does read, but not between this write and
 * the next one. `set s = 1; set s = 2;` leaves `s` holding 2 either way, and the
 * first store is a slot, a value and a store on every target for nothing.
 *
 * The walk is backwards within one block, because that is the only place the
 * question can be answered. A block has its own scope, so within it a name's
 * only writers are the statements of that block and its only readers are the
 * values of those statements and the block's terminator.
 *
 * A block is not an island, though, and that is what this walk has to carry: a
 * block that ends by falling through continues into the block around it, so
 * the names that are live after the statement the block sits inside are live
 * inside it too, and whatever it leaves live is live after that statement. A
 * loop body counted on its own starts from nothing and concludes that a store
 * at the end of it is one nothing ever saw, which deletes the store and every
 * binding the store read.
 *
 * A write whose value calls something is kept whatever the census says, because
 * the statement is then also the reason the call runs.
 */

/**
 * Every name a block reads, the blocks inside it included.
 *
 * This is what a loop body needs and a plain block does not. A body that ends
 * by writing a name it read at the top has not ended that name's life: the
 * turn after this one reads it again, so the name is live where the body ends.
 * Counted on its own the body says otherwise, and a walk that believes it
 * deletes a store the next turn was going to read — which is how a program that
 * shifts a number down a limb at a time came to shift the number it started
 * with once, and then stop.
 */
function namesReadIn(block: SemanticBlock): Set<string> {
  const read = new Set<string>();
  const walk = (one: SemanticBlock): void => {
    valuesOf(one, (value) => {
      walkSemanticValue(value, (part) => {
        for (const name of namesOfNode(part)) read.add(name);
      });
    });
    for (const statement of one.statements) {
      for (const nested of statementBlocksOf(statement)) walk(nested);
    }
  };
  walk(block);
  return read;
}

/** Whether a value reads the name it is being asked about. */
function readsLocal(value: SemanticValue, name: string): boolean {
  let found = false;
  walkSemanticValue(value, (one) => {
    if (one.k === "local" && one.name === name) found = true;
  });
  return found;
}
function dropOverwrittenStores(body: Body): boolean {
  let changed = false;
  const shared = sharedNames(body);
  const note = (after: Set<string>, value: SemanticValue | null): void => {
    if (value === null) return;
    walkSemanticValue(value, (one) => {
      for (const name of namesOfNode(one)) after.add(name);
    });
  };
  // The names still live once the block has run, which is what the block hands
  // back to the one that contains it.
  const walk = (block: SemanticBlock, liveAfter: ReadonlySet<string>): Set<string> => {
    const after = new Set(liveAfter);
    note(after, block.terminator.k === "return" ? block.terminator.value : null);
    const kept: SemanticStatement[] = [];
    for (let at = block.statements.length - 1; at >= 0; at -= 1) {
      const statement = block.statements[at];
      if (statement === undefined) continue;
      // The census has to see inside a statement as well as at its own value: a
      // name an `if` arm reads is read on a turn this statement may not run on,
      // and a name a loop body assigns is not assigned on this path either.
      // The block is walked as well as counted, because what it leaves live
      // flows out of it when the block ends by falling through.
      for (const nested of blocksInside(statement)) {
        if (walked.has(nested)) continue;
        walked.add(nested);
        // What the loop reads on every turn is read inside the body as well,
        // so the names that read walks over are live there: a body that writes
        // the loop's own bound has written something the next turn reads, and
        // a walk that does not know that concludes the write was one nothing
        // ever saw.
        const seeded = new Set(after);
        if (statement.k === "loop") {
          for (const value of loopInvariants(statement.loop)) note(seeded, value);
          // The body is read again on the next turn, so what it reads is live
          // where it ends: a name a turn reads at the top and writes at the
          // bottom is carried, not left behind.
          for (const name of namesReadIn(nested)) seeded.add(name);
        }
        const leaving = walk(nested, seeded);
        // A block that ends by falling through continues into what follows the
        // statement it sits inside, so whatever it leaves live is live there.
        if (nested.terminator.k === "next") {
          for (const name of leaving) after.add(name);
        }
      }
      // Every name this statement reads is read here, so it is live for
      // whatever comes before it: `s = s + x` reads the very name it writes,
      // and a name only a later print reads is read by that print.
      for (const value of statementValues(statement)) note(after, value);
      // Only an assignment that reads nothing is a candidate. A compound one
      // reads the name it writes — `s += x` is `s = s + x` — so the name is live
      // whatever the census says, and so is one whose value names it.
      const readsItself =
        statement.k === "set" && readsLocal(statement.value, statement.name);
      if (
        statement.k === "set" &&
        statement.op === "=" &&
        !readsItself &&
        !after.has(statement.name) &&
        !block.releases.includes(statement.name) &&
        // A write to a string the caller holds is a write the caller sees, and
        // the caller reads it after this body has ended.
        !shared.has(statement.name) &&
        !carriesAValue(statement)
      ) {
        changed = true;
        continue;
      }
      // An assignment that reads nothing ends the life of whatever the name held
      // before it, so the name leaves the census rather than joining it: what
      // comes earlier is holding a value nothing can reach any more. One that
      // reads the name, a compound one and a step all read what they write, so
      // those leave it live for whatever comes before.
      if (statement.k === "set") {
        if (statement.op === "=" && !readsItself) after.delete(statement.name);
        else after.add(statement.name);
      } else if (statement.k === "step") {
        after.add(statement.name);
      } else if (statement.k === "setElement") {
        after.add(statement.buffer);
      } else if (statement.k === "let") {
        after.add(statement.slot.name);
      }
      kept.push(statement);
    }
    block.statements = kept.reverse();
    // A block that ends by returning or by jumping for another one hands back
    // nothing: whatever was live where it left is the other block's business.
    return block.terminator.k === "next" ? after : new Set<string>();
  };
  const walked = new Set<SemanticBlock>();
  walk(body.entry, new Set<string>());
  return changed;
}

/**
 * Every block a statement has a body of, which is where it reads and writes
 * besides in its own values. Both arms of an `if` are returned: a name one of
 * them reads is read on a turn the statement may not take, and a name one of
 * them writes is not written on the path that skipped it.
 */
function blocksInside(statement: SemanticStatement): SemanticBlock[] {
  if (statement.k === "loop" || statement.k === "block") return [statementBlocksOf(statement)[0] as SemanticBlock];
  if (statement.k === "if") return statement.otherwise === null ? [statement.then] : [statement.then, statement.otherwise];
  return [];
}

/** Whether a statement's value is a call, which is the reason the statement is there at all. */
function carriesAValue(statement: SemanticStatement & { value: SemanticValue }): boolean {
  let calls = false;
  walkSemanticValue(statement.value, (one) => {
    if (one.k === "call") calls = true;
  });
  return calls;
}

/**
 * Drops a name written as itself.
 *
 * `set s = s` is what every compound assignment that changes nothing becomes:
 * `set s += 0` folds to `s + 0`, which folds to `s`, and what is left is a
 * load and a store of a name into itself. The source language's own `s = s` is
 * the same statement.
 *
 * The one case where the write is not the identity is a conversion: a slot
 * declared at one width and written a value of another is a narrowing the
 * source asked for, and dropping it would drop the narrowing. That is the same
 * test `inlineSingleUses` runs before it moves a value past its binding.
 */
function dropSelfAssignments(body: Body): boolean {
  const types = new Map<string, SemanticType>();
  for (const parameter of body.params) types.set(parameter.name, slotType(parameter));
  for (const block of nestedSemanticBlocks(body.entry)) {
    for (const statement of block.statements) {
      if (statement.k === "let") types.set(statement.slot.name, slotType(statement.slot));
      if (statement.k === "loop") {
        const loop = statement.loop;
        if (loop.kind === "counted") types.set(loop.variable, loop.type);
        if (loop.kind === "each") types.set(loop.element, loop.elementType);
      }
    }
  }
  let changed = false;
  for (const block of nestedSemanticBlocks(body.entry)) {
    block.statements = block.statements.filter((statement) => {
      if (statement.k !== "set" || statement.op !== "=") return true;
      if (statement.value.k !== "local" || statement.value.name !== statement.name) return true;
      if (block.releases.includes(statement.name)) return true;
      const held = types.get(statement.name);
      if (held !== undefined && typeLabel(statement.value.type) !== typeLabel(held)) return true;
      changed = true;
      return false;
    });
  }
  return changed;
}

/**
 * Takes the arm an `if` whose condition folded to a truth selects, where that
 * can be done without merging two scopes into one.
 *
 * The arms are blocks of their own, so a name one of them declares belongs to
 * it; splicing it into the block the `if` is written in would put that name in
 * a scope it was not declared in, which is left alone rather than renamed.
 */
function pruneKnownBranches(block: SemanticBlock): boolean {
  let changed = false;
  block.statements = block.statements.flatMap((statement) => {
    if (statement.k !== "if" || statement.condition.k !== "bool") return [statement];
    const taken = statement.condition.value ? statement.then : statement.otherwise;
    if (taken === null) {
      changed = true;
      return [];
    }
    if (taken.statements.some(claimsAName)) return [statement];
    // An arm that ends in something other than falling out of the end of it
    // carries that ending in its terminator, and a terminator belongs to the
    // block it was written in: the block around an `if` always has a way
    // through that does not leave, which is what makes the return inside the
    // arm an early one. Splicing the arm's statements into that block and
    // dropping the terminator would turn `if (2 > 1) { return 1 } return 2`
    // into a function that returns 2.
    if (taken.terminator.k !== "next" || taken.releases.length > 0) return [statement];
    changed = true;
    return taken.statements;
  });
  return changed;
}

/**
 * Drops the statements no execution path reaches.
 *
 * A block is a list of statements and a terminator, and a terminator is where
 * the block ends. Two of the statements a block can hold end it themselves: a
 * `raise` ends the program, and an `if` whose two arms both leave ends it
 * whichever way the condition went. Everything written below such a statement
 * is a statement no processor runs and every backend still emits —
 * `raise("bad"); sum += a[i]` emits the raise, the load, the add and the store
 * for the sum of an array nobody ever reaches.
 *
 * What makes this exact rather than a guess is that the transfer is inside one
 * block: a block is entered only at its first statement and its terminator is
 * the only way out of it, so nothing after a statement that leaves can be
 * reached from anywhere else. The list is cut at that statement and the
 * terminator stays, which is what the block ended with either way.
 *
 * The releases survive, and have to. A block's releases name what it owns and
 * are checked against the order it allocated in, so a binding the dropped
 * statements made is still named there; what allocated them is not among those
 * dropped, because an allocation is written before the transfer that ends the
 * block.
 */
function dropUnreachable(body: Body): boolean {
  let changed = false;
  const walk = (block: SemanticBlock): void => {
    for (const statement of block.statements) {
      for (const nested of statementBlocksOf(statement)) walk(nested);
      if (statement.k === "loop") walk(statement.loop.body);
    }
    // The list is cut at the first statement that leaves, so what follows it is
    // dropped and what precedes it is kept in order. A block with no such
    // statement is left exactly as it was and reports no change, which is what
    // stops the fixed point from running on a rewrite that did nothing.
    const leaving = block.statements.findIndex(leavesHere);
    if (leaving < 0) return;
    const kept = block.statements.slice(0, leaving + 1);
    if (kept.length === block.statements.length) return;
    block.statements = kept;
    changed = true;
  };
  walk(body.entry);
  return changed;
}

/**
 * Whether control cannot reach the statement after this one.
 *
 * A `raise` is the plain case: the IR says nothing after it runs. An `if` is
 * the other, and only when both of its arms leave, because that is the shape
 * where taking neither branch is not a path at all.
 *
 * A loop is never one of them, and this is worth spelling out because the
 * naive reading of it is wrong. A loop body ends by jumping back to the loop's
 * header, so its terminator is a jump rather than a `next` — which looks like
 * it leaves and is in fact the loop working. A loop is left only through a
 * `break` or a `return` inside it, and the IR writes those as the terminator of
 * a block nested inside the body rather than as an ending of the loop
 * statement, so the loop itself always falls through to what follows it.
 */
function leavesHere(statement: SemanticStatement): boolean {
  if (statement.k === "raise") return true;
  if (statement.k !== "if") return false;
  if (statement.otherwise === null) return false;
  return [statement.then, statement.otherwise].every((block) => block.terminator.k !== "next");
}

/** Whether a statement declares a name, which is what stops an arm splicing. */
function claimsAName(statement: SemanticStatement): boolean {
  if (statement.k === "let") return true;
  if (statement.k === "loop") return statement.loop.kind !== "while" && statement.loop.kind !== "doWhile";
  return false;
}

/* -------------------------------------------------------------------------- */
/* A loop whose body has nothing left to do                                     */
/* -------------------------------------------------------------------------- */

/**
 * A loop whose body does nothing once the name its guard tests has settled,
 * left at the turn that settles it.
 *
 * A guard at the end of a loop body that tests a name the body itself writes —
 * `if (answer === 0) { answer = a[i] > b[i] ? 1 : -1 }` — is a loop that does
 * its work on the turns before the name settles and nothing on the turns after.
 * The IR already says that: the body is one statement, and it is the guarded
 * one. Writing the loop as one that leaves when the guard is not met is the
 * same program with the turns that do nothing taken out of it.
 *
 * What is skipped is what makes it exact rather than a guess. Every turn the
 * rewrite removes contained exactly three things: the counter's step, the
 * loop's own test, and the guard's evaluation. The body's statements are the
 * guard, so they still run on exactly the turns they ran on; a turn that no
 * longer runs takes no read with it that the original performed, because the
 * guard was false on it and the body was not entered. Four things have to hold,
 * and each is checked before anything is rewritten:
 *
 * - Nothing outside the guarded arm writes the name, so the guard is what
 *   decides whether the body works and not an assignment somewhere else. A
 *   `let` of the same spelling inside the loop is a different binding and is
 *   refused as a write of it.
 * - The loop's own counter — and the index and element of a walk — is not read
 *   after the loop, because a loop that leaves early leaves the counter
 *   somewhere the original left it not.
 * - Every value the loop's own header evaluates on each turn holds no element,
 *   field or length read, so a turn that no longer runs does not drop a read
 *   that could fault. `isSafeToCompute` is the one answer to that, the same one
 *   `hoist-invariant` and `common-subexpression` are held to.
 * - The body falls out of its own end, so the guard really is the last thing a
 *   turn does and leaving skips nothing the body did after it.
 *
 * A loop this rewrites is one `parallel.ts` refuses afterwards — a turn that
 * decides whether the next one runs is not a turn that may run beside another —
 * and it is refused there rather than here, because the mark is a claim about
 * the body as it stands and this said nothing about turns.
 */
function leaveSettledLoopsEarly(body: Body): boolean {
  const ids = new Set<string>(nestedSemanticBlocks(body.entry).map((block) => block.id));
  let minted = 0;
  let changed = false;
  const walk = (block: SemanticBlock): void => {
    for (const statement of block.statements) {
      if (statement.k !== "loop") {
        for (const nested of statementBlocksOf(statement)) walk(nested);
        continue;
      }
      const loop = statement.loop;
      minted += 1;
      if (settled(loop, body, ids, `blaze_leave_${minted}`)) changed = true;
      walk(loop.body);
    }
  };
  walk(body.entry);
  return changed;
}

/** The name a guard tests for the value the body settles it at, or null. */
function settledName(condition: SemanticValue): string | null {
  if (condition.k !== "compare" || condition.op !== "eq") return null;
  // A text is compared by the runtime rather than by an instruction, and the
  // answer is the same either way, but a name holding one is a reference and
  // the guard is about a number the body works towards.
  if (isTextType(condition.operand)) return null;
  const { left, right } = condition;
  if (left.k === "local") return left.name;
  if (right.k === "local") return right.name;
  return null;
}

/** Whether a loop's body has nothing left to do once a name settles. */
function settled(loop: SemanticLoop, body: Body, ids: Set<string>, fresh: string): boolean {
  // A loop a team may run, or one that owns a region, is read by the rule that
  // marks it rather than by this one. Neither is marked when this runs, so the
  // question is asked of the marks a body can already carry.
  const marked = loop as { parallel?: unknown; region?: unknown };
  if (marked.parallel !== undefined || marked.region === true) return false;
  // Every value the loop's own turn evaluates: what a counted loop stops at and
  // steps by are re-read at the header when the body writes them, and a walk
  // reads its length and a `while` its condition on every turn.
  const perTurn =
    loop.kind === "counted"
      ? [loop.to, ...(loop.step === null ? [] : [loop.step])]
      : loop.kind === "each"
        ? [loop.length]
        : [loop.condition];
  for (const value of perTurn) if (!isSafeToCompute(value)) return false;
  // The names the loop itself moves, which a `break` leaves somewhere else and
  // which the guard cannot be about.
  const own = new Set<string>();
  if (loop.kind === "counted") own.add(loop.variable);
  if (loop.kind === "each") {
    own.add(loop.index);
    own.add(loop.element);
  }
  // The guard is the last statement of the body and the body falls out of its
  // own end, so nothing follows it and leaving skips nothing. A body that ends
  // by going round again falls out of its own end too, which is what a trailing
  // `continue` is.
  const statements = loop.body.statements;
  const back = loop.body.terminator;
  const fallsOut = back.k === "next" || (back.k === "jump" && back.target === loop.header);
  if (!fallsOut || statements.length === 0) return false;
  const guard = statements[statements.length - 1];
  if (guard.k !== "if" || guard.otherwise !== null) return false;
  const name = settledName(guard.condition);
  if (name === null || own.has(name)) return false;
  if (writes(loop.body, name, guard.then)) return false;
  // The counter is what a `break` leaves somewhere else, so a loop that is read
  // after itself is one this may not rewrite.
  if (readsOutside(loop, body, own)) return false;
  const leaving: SemanticBlock = {
    id: fresh,
    statements: [],
    releases: [],
    // A `break` frees what the blocks it leaves own, the block it is written in
    // first and the loop's own body after it: the resolver's `jump` writes the
    // same list for a `break` the source spelled out.
    terminator: { k: "jump", target: loop.exit, releases: [...loop.body.releases] },
  };
  ids.add(fresh);
  // The guard is asked the other way round: the arm under it is the work a turn
  // does while the name is still at the value the body settles, and the way
  // through is the loop's last turn.
  const condition = guard.condition;
  if (condition.k === "compare") condition.op = condition.op === "eq" ? "ne" : "eq";
  statements[statements.length - 1] = {
    k: "if",
    condition,
    then: leaving,
    otherwise: guard.then,
    line: guard.line,
  };
  return true;
}

/**
 * Whether anything in a loop writes a name, the guarded arm left out.
 *
 * The arm is what the guard lets through, so a write in it is the write the
 * guard is about. A `let` counts as a write: a second binding of one spelling
 * is a different name to the resolver, and the guard would be asked about the
 * new one on the turns after it.
 */
function writes(loop: SemanticBlock, name: string, guarded: SemanticBlock): boolean {
  const walk = (block: SemanticBlock): boolean => {
    for (const statement of block.statements) {
      if (statement.k === "set" || statement.k === "step") {
        if (statement.name === name) return true;
      } else if (statement.k === "let") {
        if (statement.slot.name === name) return true;
      } else if (statement.k === "loop") {
        const inner = statement.loop;
        if (inner.kind === "counted" && inner.variable === name) return true;
        if (inner.kind === "each" && (inner.index === name || inner.element === name)) return true;
        if (walk(inner.body)) return true;
        continue;
      }
      for (const nested of statementBlocksOf(statement)) {
        // The guarded arm is the write the guard is about; it is left out here
        // and read as part of the guard below.
        if (nested === guarded) continue;
        if (walk(nested)) return true;
      }
    }
    return false;
  };
  return walk(loop);
}

/**
 * Whether a name is read anywhere the loop is not.
 *
 * The counter's last value is the one a loop written out leaves behind, and
 * leaving early leaves a different one: a loop that counts down from ten and
 * stops at its first turn leaves the counter at nine rather than at minus one.
 * The loop's own ends are read in the block the loop is written in, so they are
 * outside it for the purposes of this question.
 */
function readsOutside(loop: SemanticLoop, body: Body, names: ReadonlySet<string>): boolean {
  let found = false;
  const ask = (value: SemanticValue | null): void => {
    if (found || value === null) return;
    walkValues(value, (one) => {
      if (one.k === "local" && names.has(one.name)) found = true;
    });
  };
  const outside = (block: SemanticBlock): void => {
    for (const statement of block.statements) {
      if (statement.k !== "loop") {
        for (const nested of statementBlocksOf(statement)) outside(nested);
        continue;
      }
      const inner = statement.loop;
      if (inner !== loop) {
        outside(inner.body);
        continue;
      }
      if (inner.kind === "counted") {
        ask(inner.from);
        ask(inner.to);
        ask(inner.step);
      } else if (inner.kind === "each") ask(inner.length);
      else ask(inner.condition);
    }
    // What the block hands back is read after the loop just as a statement after
    // it is.
    ask(block.terminator.k === "return" ? block.terminator.value : null);
    for (const statement of block.statements) {
      if (statement.k === "raise") ask(statement.message);
    }
  };
  outside(body.entry);
  return found;
}

/* -------------------------------------------------------------------------- */
/* A residue, as a mask                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The widest mask that is still one number a double holds exactly, which is
 * what a literal is printed as. A residue of a wider value than that has no
 * mask this pass could write down, and the arithmetic it was written with is
 * left as it was.
 */
const MASK_PLACES = 53;

/**
 * A limb's residue, taken as a mask rather than as a shift down, a shift back up
 * and a difference.
 *
 * A field value is limbs, and an addition carries from one to the next. What a
 * limb keeps and what the rest of it carries are one value read two ways, and
 * the way the pass that reasons about limb arithmetic (`whole-elements.ts`)
 * writes it is a shift down for the carry and a shift back up for the residue:
 * `whole = sum >> 24; o[i] = sum - (whole << 24)`. On the machine that is a
 * shift, a shift, a round trip through the frame for the shifted value and a
 * difference, because the difference needs the value in a register the
 * accumulator is not.
 *
 * `x - ((x >> k) << k)` is `x` with its low `k` bits, for every whole number and
 * every `k`: the shift down drops them, the shift back up puts back the ones it
 * kept and nothing of the ones it dropped, and the difference is the difference.
 * The machine has a single instruction for that with the number inside it, and a
 * carry chain is one long run of exactly this shape.
 *
 * The source writes the shift back up as a product by a power of two as often
 * as not — `sum - whole * 16777216` — so a product is read as the move it is.
 * Both are the same number, and the mask is the same shift.
 */
function maskLimbResidues(body: Body): boolean {
  let changed = false;
  for (const block of nestedSemanticBlocks(body.entry)) {
    // The names a statement of this block writes, which are not the ones its
    // bindings hold: what such a name holds after the write is not what it was
    // bound to, and a substitution against the binding would read the first
    // value where the second is the one that is there.
    const written = new Set<string>();
    for (const statement of block.statements) {
      if (statement.k === "set" || statement.k === "step") written.add(statement.name);
    }
    // Every residue found, keyed as the value it was found as. The search walks
    // the block in order, because a residue is only a residue against a binding
    // that is already in effect: the `let` that binds the carry comes before the
    // statement that takes the residue off it.
    const found = new Map<string, SemanticValue>();
    const bound = new Map<string, SemanticValue>();
    for (const statement of block.statements) {
      for (const value of statementValues(statement)) {
        walkSemanticValue(value, (inner) => {
          const mask = maskedOf(inner, bound);
          if (mask !== null) found.set(valueKey(inner), mask);
        });
      }
      if (statement.k === "let" && !written.has(statement.slot.name)) bound.set(statement.slot.name, statement.value);
    }
    if (found.size === 0) continue;
    block.statements = block.statements.map((statement) => replaceValues(statement, found) as SemanticStatement);
    changed = true;
  }
  return changed;
}

/** The mask a residue written as a shift back up is, or null when it is not one. */
function maskedOf(value: SemanticValue, bound: ReadonlyMap<string, SemanticValue>): SemanticValue | null {
  if (value.k !== "arith" || value.op !== "sub") return null;
  // A mask is over the bits of a whole number, and the residue has to be one.
  if (value.type.kind !== "primitive" || !isInteger(value.type)) return null;
  const back = maskPlaces(value.right, bound);
  if (back === null) return null;
  // The residue is taken of the very value the carry was shifted down from, so
  // the two halves are one value read two ways.
  if (valueKey(value.left) !== back.down) return null;
  return {
    k: "arith", type: value.type, op: "and",
    left: value.left,
    right: { k: "const", type: value.type, text: String(back.bits) },
  };
}

/**
 * The value a residue was shifted down from and the mask that is the same
 * number, read off the shift back up that takes the difference.
 *
 * The shift back up is over the carry, and the carry is either a name the block
 * bound to the shift down — which is the way `whole-elements` writes it, because
 * the carry is read a second time by the statement that hands it on — or the
 * shift down itself, which is the way an expression a program wrote out has it.
 * Both are the same number, and the mask is the same shift.
 */
function maskPlaces(value: SemanticValue, bound: ReadonlyMap<string, SemanticValue>): { down: string; bits: number } | null {
  if (value.k !== "arith") return null;
  if (value.op !== "shl" && value.op !== "mul") return null;
  if (value.left.k !== "local") return null;
  const moved = literalOf(value.right);
  if (moved === null) return null;
  // A shift moves the name by a number of places; a product moves it by a power
  // of two, which is the same move and the way the source writes it.
  const places = value.op === "shl" ? moved : powerOfTwo(moved);
  if (places === null || places < 1 || places > MASK_PLACES) return null;
  const carried = bound.get(value.left.name);
  const down = carried === undefined ? value.left : carried;
  if (down.k !== "arith" || down.op !== "shr") return null;
  if (literalOf(down.right) !== places) return null;
  return { down: valueKey(down.left), bits: 2 ** places - 1 };
}

/** The power of two a number is, or null when it is not one. */
function powerOfTwo(value: number): number | null {
  if (value < 1 || !Number.isSafeInteger(value)) return null;
  const places = Math.log2(value);
  return Number.isInteger(places) && 2 ** places === value ? places : null;
}

/**
 * What the rewrites read of a function: the body they walk and the names that
 * are already bound in it. A program has the same body and no parameters of its
 * own, which is why this is one shape rather than two entry points over two.
 */
interface Body {
  readonly params: readonly SemanticSlot[];
  readonly entry: SemanticBlock;
}

/**
 * Applies the deterministic rewrites to a function, to a fixed point.
 *
 * The point is bounded rather than open-ended: each round folds what the last
 * one exposed, and a round that changes nothing ends it. A fold that makes two
 * computations the same one is what lets the next round find them, so stopping
 * after one pass would leave most of what there is to find unfound.
 *
 * The round is written the way the rewrites are: each one says whether it
 * changed anything, and a round that none of them did is the round after which
 * nothing more would be. Comparing the tree against a copy of itself by
 * writing both out as text is the same answer for far more work.
 */
export function optimizeSemanticFunction(fn: SemanticFunction, callees: Callees = NO_CALLEES): SemanticFunction {
  // A cycle of bodies is answered before a body's own recursion is, because a
  // body in a cycle may also call itself: the merged loop carries a call of
  // itself as a turn of the loop the same way it carries a call of any other
  // body of the cycle, while the pass below answers a body that calls only
  // itself and would take that call out of reach of this one.
  eliminateMutualRecursion(fn, callees);
  // Recursion is answered with a loop before the rounds run, because the loop
  // it writes is the loop the rounds read: hoisting an invariant out of a
  // recursion, commoning two values in it and counting its turns are three
  // things none of them can do while the frames are still there.
  eliminateRecursion(fn);
  optimizeBody(fn, callees);
  // A call boundary the local rewrites cannot cross is the one thing left that
  // can cost more than it saves, so it is asked after the rounds have settled.
  // The rounds run again over what the fusion exposed, because a body written
  // into another is a body the folds and the commoner have not read yet.
  const restructured = restructureHotFunction(fn, callees);
  if ("refused" in restructured) return fn;
  optimizeBody(restructured.applied, callees);
  return restructured.applied;
}

/**
 * The same rewrites over a program's entry, which is a body with no parameters
 * of its own.
 *
 * A program's statements are the same shape a function's are and reach the
 * same backends, so they are held to the same rewrites: a top-level loop of a
 * program is a loop like any other, and the value its body computes on every
 * turn is computed once above it here as it is in a function.
 */
export function optimizeSemanticEntry(
  entry: SemanticBlock,
  callees: Callees = NO_CALLEES,
  params: readonly SemanticSlot[] = [],
): SemanticBlock {
  optimizeBody({ params, entry }, callees);
  return entry;
}

/**
 * The same rewrites over a whole program, which is a body under the functions it
 * calls: the statements of the program itself, with nothing bound in it but what
 * those statements declare.
 */
export function optimizeSemanticProgram(
  program: SemanticProgram,
  known: Callees = new Map(program.bodies.map((fn) => [fn.name, fn])),
): SemanticProgram {
  // The callees are read before any body is marked: whether a loop may run its
  // turns at once is a question about what the functions it calls write, and a
  // program that runs nothing of its own holds no bodies of its own — its
  // functions are resolved and compiled one at a time, and the caller is the one
  // holding them.
  const callees: Callees = known;
  optimizeSemanticEntry(program.entry, callees);
  // A function the program declares is a body of its own, and the rewrites that
  // run over a program run over it: a loop invariant hoisted out of a function
  // is worth as much there as it is in the block the program starts in. What a
  // body of its own recursion becomes is a loop, and it becomes one first, so
  // that the rounds below are rounds over a loop rather than over frames.
  // A cycle of bodies is one loop of several bodies and is answered before any
  // one of them is answered on its own, and every body of it is answered from
  // the same copy of every body, so which of them was answered first does not
  // decide what the others are answered with.
  eliminateMutualRecursionInProgram(program.bodies);
  for (const fn of program.bodies) eliminateRecursion(fn);
  // The bodies are held in one map that is read and written as the pass goes,
  // because which bodies a program may write out is a question about the
  // program rather than about one body, and a body fused into another is the
  // body the next one reads. A map built once over `program.bodies` would
  // answer about the tree as it was before this pass touched it.
  const bodies = new Map(program.bodies.map((fn) => [fn.name, fn]));
  // The whole-number arm of a body is built before the calls are written out,
  // because the arm is what a fusion wants to copy: a call written out of a
  // body that has no callers left would be answered by the arm-less body, and
  // the whole-number path the arm carries would be gone with the call. The arm
  // of a body this has already rewritten is refused on its own — its entry
  // holds the arm's own test — so the second read below adds nothing twice.
  wholeNumberArithmetic(program);
  for (let index = 0; index < program.bodies.length; index += 1) {
    const fn = program.bodies[index] as SemanticFunction;
    optimizeSemanticEntry(fn.entry, bodies, fn.params);
    // The same call-boundary rewrite a single function gets, run here over a
    // body the program declares. A body of the program has no outline to mark
    // its calls with, so this one decides: a hot call of a callee that is free
    // of effects and reaches neither itself nor this body is written out. A
    // callee whose body is more than a call is worth is still refused, so the
    // functions a body calls one after another stay calls.
    // Whole-number arithmetic runs after this, so a body it has fused is one
    // the whole-number pass reads.
    const restructured = restructureHotFunction(fn, bodies, { decideUnmarked: true });
    if ("refused" in restructured) continue;
    program.bodies[index] = restructured.applied;
    bodies.set(fn.name, restructured.applied);
    optimizeSemanticEntry(restructured.applied.entry, bodies, restructured.applied.params);
  }
  // Whole-number arithmetic is the one rewrite here that is a question about a
  // whole program rather than about one body: what it needs to know is what
  // the callers of a function hand it, which is settled once every body has
  // settled. It runs last and it runs once, because a function it has rewritten
  // already holds whole-number parameters and would be rewritten again.
  wholeNumberArithmetic(program);
  return program;
}

function optimizeBody(body: Body, callees: Callees): void {
  for (let round = 0; round < 8; round += 1) {
    let changed = false;
    if (foldAll(body)) changed = true;
    // A residue written as a shift down and a shift back up is a mask, which is
    // one instruction rather than four — and the fold can only see it once the
    // binding that carries the shift down is one it can read.
    if (maskLimbResidues(body)) changed = true;
    // A multiply by a small count is the chain of additions it is, with a
    // binding between the steps so the side is computed once. It reads the
    // fold's answer: a side that is free to write twice is already an addition
    // by the time the fold is done, and what is left is the side that is not.
    if (chainSmallProducts(body)) changed = true;
    if (pruneAll(body)) changed = true;
    // A scalar multiplication written a bit at a time is the one loop here
    // whose rewrite is a different algorithm rather than a cheaper spelling of
    // the same one, so it goes before the passes that move the loop's own
    // statements around and after the fold that gives its ends their values.
    if (windowedScalarMultiplication(body, callees)) changed = true;
    if (hoistLoopInvariants(body)) changed = true;
    // A loop whose body has nothing left to do once a name settles is left at
    // that turn before the loops are counted and written out: unrolling one
    // first would write its guard out as many times as it turns.
    if (leaveSettledLoopsEarly(body)) changed = true;
    // Unrolling reads the loop's ends, so it goes after the fold has made them
    // written out and before the round decides the IR has stopped changing.
    if (unrollCountedLoops(body)) changed = true;
    if (commonWithin(body)) changed = true;
    if (propagateCopies(body)) changed = true;
    if (inlineSingleUses(body)) changed = true;
    // Unreachable code goes before the dead stores: a `raise` is what makes the
    // statements after it unreachable, and a store nothing reaches is not one
    // the passes below would have counted in the first place.
    if (dropUnreachable(body)) changed = true;
    // The self-assignment goes before the dead stores, because folding is what
    // turns a compound assignment that changes nothing into one, and the dead
    // stores below are the ones the self-assignment can then leave behind.
    if (dropSelfAssignments(body)) changed = true;
    if (dropDeadWrites(body)) changed = true;
    if (dropOverwrittenStores(body)) changed = true;
    if (dropUnread(body)) changed = true;
    if (!changed) break;
  }
  // Independence is marked last, on the body the rounds have settled. A verdict
  // is a claim about a body as it stands, so a pass that ran before them would
  // be claiming something about a body that has since been rewritten — a loop
  // the rounds split in two, or unrolled away entirely, is not the loop the
  // answer was about.
  markParallelLoops(body.entry, callees);
  markRegionLoops(body.entry, callees);
}

/** Folds every block of the function, nested ones included. */
function foldAll(body: Body): boolean {
  let changed = false;
  for (const block of nestedSemanticBlocks(body.entry)) {
    if (foldBlock(block)) changed = true;
  }
  return changed;
}

/** Takes the arm of every `if` whose condition is already a truth. */
function pruneAll(body: Body): boolean {
  let changed = false;
  for (const block of nestedSemanticBlocks(body.entry)) {
    if (pruneKnownBranches(block)) changed = true;
  }
  return changed;
}

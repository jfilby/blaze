/**
 * Whole-number arithmetic the compiler can answer itself.
 *
 * Two things here are the compiler's own rather than a target's: the value of
 * an expression whose operands are both constants, and the reduction of a wide
 * remainder to the kernels that compute it without a 256 bit intermediate. The
 * first is what lets a source write `2n ** 256n - 2n ** 32n - 977n` as the
 * expression it is; the second is what makes `(a * b) % p` over `u256` the
 * mathematical product rather than the low 256 bits of it.
 */

import {
  isWhole,
  type ArithOp,
  type SemanticType,
  type SemanticValue,
} from "../core/semantic-ir.ts";
import type { PrimitiveTypeName } from "../core/types.ts";

/** The bits a whole number type holds. */
const BITS: Readonly<Record<string, number>> = {
  i8: 8,
  u8: 8,
  i16: 16,
  u16: 16,
  i32: 32,
  u32: 32,
  i64: 64,
  u64: 64,
  isize: 64,
  usize: 64,
  i256: 256,
  u256: 256,
};

/** The whole types that hold a sign, which a division and a shift read. */
const SIGNED: ReadonlySet<string> = new Set(["i8", "i16", "i32", "i64", "isize", "i256"]);

/** The most an exponent may be for a power to be folded, so a typo is a
 * refusal rather than an allocation. */
const MAX_POWER = 4096;
/** The most bits a folded power may reach, which bounds what it allocates. */
const MAX_POWER_BITS = 16384;

/** The bits a whole number type holds, or null where it is not a whole type. */
export function wholeBits(name: PrimitiveTypeName): number | null {
  return BITS[name] ?? null;
}

/** A whole number as the value the type holds: two's complement at its width. */
export function wrapped(value: bigint, name: PrimitiveTypeName): bigint {
  const bits = BITS[name];
  if (bits === undefined) return value;
  const span = 1n << BigInt(bits);
  const masked = ((value % span) + span) % span;
  if (!SIGNED.has(name)) return masked;
  const half = 1n << BigInt(bits - 1);
  return masked >= half ? masked - span : masked;
}

/** The exact value of `base ** exponent`, or null where folding it is refused. */
export function wholePower(base: bigint, exponent: bigint): bigint | null {
  if (exponent < 0n || exponent > BigInt(MAX_POWER)) return null;
  if (exponent === 0n) return 1n;
  const bits = base === 0n ? 1 : base.toString(2).replace("-", "").length;
  if (bits * Number(exponent) > MAX_POWER_BITS) return null;
  return base ** exponent;
}

/**
 * The value of one whole-number operation on two constants.
 *
 * The answer is the one the type holds, not the one the arithmetic reaches:
 * `2n ** 256n` is the `u256` zero, because a `u256` holds 256 bits, and that is
 * what every backend answers for the same operation on the same values.
 */
export function foldWhole(op: ArithOp, left: bigint, right: bigint, name: PrimitiveTypeName): bigint | null {
  switch (op) {
    case "add":
      return wrapped(left + right, name);
    case "sub":
      return wrapped(left - right, name);
    case "mul":
      return wrapped(left * right, name);
    case "div": {
      if (right === 0n) return null;
      // A whole division truncates towards zero, which is what the C and the
      // machine division of a whole number do.
      return wrapped(left / right, name);
    }
    case "floorDiv": {
      if (right === 0n) return null;
      let quotient = left / right;
      if (left % right !== 0n && (left < 0n) !== (right < 0n)) quotient -= 1n;
      return wrapped(quotient, name);
    }
    case "mod": {
      if (right === 0n) return null;
      return wrapped(left % right, name);
    }
    case "floorMod": {
      if (right === 0n) return null;
      let rest = left % right;
      if (rest !== 0n && (rest < 0n) !== (right < 0n)) rest += right;
      return wrapped(rest, name);
    }
    case "pow": {
      const power = wholePower(left, right);
      return power === null ? null : wrapped(power, name);
    }
    case "shl": {
      const bits = BITS[name];
      const count = Number(right);
      // A shift past the width is left to the target's kernel: the count a
      // kernel masks and the count a number is shifted by are not the same
      // count, and folding one as the other answers a number the program did
      // not write.
      if (bits === undefined || count < 0 || count >= bits) return null;
      return wrapped(left << BigInt(count), name);
    }
    case "shr":
    case "ushr": {
      const bits = BITS[name];
      const count = Number(right);
      if (bits === undefined || count < 0 || count >= bits) return null;
      if (op === "ushr") {
        const span = 1n << BigInt(bits);
        const value = ((left % span) + span) % span;
        return value >> BigInt(count);
      }
      const value = wrapped(left, name);
      return value >> BigInt(count);
    }
    case "and":
      return wrapped(left & right, name);
    case "or":
      return wrapped(left | right, name);
    case "xor":
      return wrapped(left ^ right, name);
    default:
      return null;
  }
}

/**
 * The whole number a constant is, or null where the text is not one.
 *
 * The digits may be decimal or hexadecimal, and a sign may stand in front of
 * either: the source writes `0x2DEE...n` and the folded text of a signed value
 * is `-1`.
 */
export function wholeText(text: string): bigint | null {
  const clean = text.trim().replace(/n$/, "");
  if (!/^[+-]?(?:0[xX][0-9a-fA-F]+|\d+)$/.test(clean)) return null;
  try {
    return BigInt(clean);
  } catch {
    return null;
  }
}

/** A whole number as the constant the IR holds, at the type it is held at. */
export function wholeConstant(value: bigint, type: SemanticType): SemanticValue | null {
  if (type.kind !== "primitive" || !isWhole(type.name)) return null;
  return { k: "const", type, text: wrapped(value, type.name).toString() };
}

/** A type written as the name of a whole number. */
export function wholeType(name: PrimitiveTypeName): SemanticType {
  return { kind: "primitive", name };
}

/** The kernels a wide remainder is computed by, one per operation it holds. */
export const MODULAR_KERNEL: Readonly<Record<string, string>> = {
  add: "u256_add_mod",
  sub: "u256_sub_mod",
  mul: "u256_mul_mod",
};

/** The kernels a wide remainder is computed by, and the call that makes one. */
export type ModularCall = (name: string, args: readonly SemanticValue[]) => SemanticValue | null;

/**
 * The value of `dividend % modulus` over a 256 bit number, computed by the
 * kernels that do not overflow.
 *
 * A `u256` multiplication wraps at 256 bits, so `(a * b) % p` taken literally
 * is the remainder of the low half of the product — a different number from the
 * source's. The kernels take a 512 bit product, or a sum that carries past the
 * top of the width, and reduce it by the modulus; the tree the source wrote is
 * therefore written as a call of one kernel per operation, and every leaf is
 * handed to the kernel that reads it.
 *
 * The modulus is written into every kernel, so it is only fused when reading it
 * again is the same value: a name or a constant. A call or a field a program
 * can change between the two reads is left to the ordinary remainder, which
 * reads it once.
 */
export function modularReduction(
  dividend: SemanticValue,
  modulus: SemanticValue,
  call: ModularCall,
): SemanticValue | null {
  // The modulus is written into every kernel, so it is only fused when reading
  // it again is the same value: a name or a constant. A call or a field a
  // program can change between the two reads is left to the ordinary remainder,
  // which reads it once.
  if (modulus.k !== "const" && modulus.k !== "local") return null;
  const reduced = asU256(modulus);
  if (reduced === null) return null;
  // Whether the tree holds an operation at all: a dividend that is one value is
  // the ordinary remainder, and answering it as the value itself would drop the
  // reduction the source wrote.
  let fused = false;
  const reduce = (value: SemanticValue): SemanticValue | null => {
    if (value.k !== "arith") return asU256(value);
    const kernel = MODULAR_KERNEL[value.op];
    if (kernel === undefined || value.type.kind !== "primitive" || value.type.name !== "u256") return null;
    const left = reduce(value.left);
    if (left === null) return null;
    const right = reduce(value.right);
    if (right === null) return null;
    fused = true;
    return call(kernel, [left, right, reduced]);
  };
  const rendered = reduce(dividend);
  return fused ? rendered : null;
}

/**
 * A value as the `u256` a modular kernel reads.
 *
 * A kernel takes four limbs; a whole number written out is the widening the
 * kernel does itself, and it is written here as the four limb constant it is so
 * that the call is one type all the way down. A name is already the width the
 * tree is computed at, or it is not a value this fusion can name.
 */
function asU256(value: SemanticValue): SemanticValue | null {
  if (value.type.kind === "primitive" && value.type.name === "u256") return value;
  if (value.k !== "const" || value.type.kind !== "primitive" || !isWhole(value.type.name)) return null;
  const number = wholeText(value.text);
  if (number === null || number < 0n) return null;
  return { k: "const", type: { kind: "primitive", name: "u256" }, text: number.toString() };
}

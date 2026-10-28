/**
 * What the source-level lowering of a wide number's arithmetic computes.
 *
 * The secp256k1 benchmark's `mod(a, b)` is a reduction over 256 bit numbers, and
 * the operations inside one are the modular kernels: a product of two 256 bit
 * numbers needs 512 bits, and the machine's multiply drops the half above the
 * first 256 before a remainder ever sees it. These check both what the rewrite
 * writes and that the answer is the number the source's own `mod` answers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { desugar, modularValue, rewriteModularArithmetic } from "../semantics/typescript-desugar.ts";

const P = 115792089237316195423570985008687907853269984665640564039457584007908834671663n;

/** The kernels as the numbers they are, so a rewritten expression can be run. */
const ADD = (left: bigint, right: bigint, mod: bigint): bigint => (left + right) % mod;
const SUB = (left: bigint, right: bigint, mod: bigint): bigint => (((left - right) % mod) + mod) % mod;
const MUL = (left: bigint, right: bigint, mod: bigint): bigint => (left * right) % mod;

/** One rewritten value, evaluated as the number it is. */
function answerOf(rewritten: string, values: Record<string, bigint>, modulus: bigint = P): bigint {
  const names = Object.keys(values);
  const run = new Function(
    "u256_add_mod",
    "u256_sub_mod",
    "u256_mul_mod",
    "P",
    ...names,
    `return (${rewritten});`,
  ) as (...args: (bigint | typeof ADD)[]) => bigint;
  return run(ADD, SUB, MUL, modulus, ...names.map((name) => values[name] as bigint));
}

/** The `mod` the source writes, which answers the positive residue. */
function sourceMod(value: bigint, mod: bigint = P): bigint {
  const remainder = value % mod;
  return remainder >= 0n ? remainder : mod + remainder;
}

test("a product reduced modulo the curve's prime is the modular multiply", () => {
  // Two 256 bit factors need 512 bits, which no 256 bit multiply holds: the
  // product the source computes is the full one, and the kernel is what computes
  // it before it reduces.
  const a = 0x0123456789abcdef_fedcba9876543210n;
  const b = 0xfedcba9876543210_0123456789abcdefn;
  const rewritten = modularValue("a * b", "P");
  assert.match(rewritten, /^u256_mul_mod\(a, b, P\)$/);
  assert.equal(answerOf(rewritten, { a, b }), (a * b) % P);
});

test("a sum and a difference are modular, and the difference answers the positive residue", () => {
  const a = 5n;
  const b = 11n;
  assert.equal(answerOf(modularValue("a + b", "P"), { a, b }), 16n);
  const difference = modularValue("a - b", "P");
  assert.match(difference, /^u256_sub_mod\(a, b, P\)$/);
  assert.equal(answerOf(difference, { a, b }), P - 6n);
  assert.equal(answerOf(difference, { a, b }), sourceMod(a - b));
});

test("a nested reduction is the atom it already is", () => {
  // The inner call is rewritten first, so the outer one reads a number that is
  // already a residue. Reducing it again would be a division per term of every
  // curve formula.
  const rewritten = rewriteModularArithmetic("mod(mod(a * b, P) - c, P)");
  assert.match(rewritten, /u256_sub_mod\(\(?u256_mul_mod\(a, b, P\)\)?, c, P\)/);
  const a = 0xdeadbeefn;
  const b = 0xc0ffeen;
  const c = 7n;
  assert.equal(answerOf(rewritten, { a, b, c }), sourceMod(sourceMod(a * b) - c));
});

test("a negated value is a subtraction from zero", () => {
  const a = 9n;
  const rewritten = modularValue("-a", "P");
  assert.match(rewritten, /^u256_sub_mod\(0n, a, P\)$/);
  assert.equal(answerOf(rewritten, { a }), sourceMod(-a));
});

test("operators of the same precedence associate to the left, as the source writes them", () => {
  // `a - b - c` is `(a - b) - c`, so the last subtraction is the outer one, and
  // a rewrite that split at the first would answer a different residue.
  const a = 3n;
  const b = 10n;
  const c = 20n;
  const rewritten = modularValue("a - b - c", "P");
  assert.match(rewritten, /^u256_sub_mod\(u256_sub_mod\(a, b, P\), c, P\)$/);
  assert.equal(answerOf(rewritten, { a, b, c }), sourceMod(a - b - c));
});

test("a product is tighter than a sum, and a parenthesised sum is the tighter operand", () => {
  const a = 123n;
  const b = 456n;
  const c = 789n;
  const rewritten = modularValue("a + b * c", "P");
  assert.match(rewritten, /^u256_add_mod\(a, u256_mul_mod\(b, c, P\), P\)$/);
  assert.equal(answerOf(rewritten, { a, b, c }), (a + b * c) % P);
  const bracketed = modularValue("(a + b) * c", "P");
  assert.match(bracketed, /^u256_mul_mod\(u256_add_mod\(a, b, P\), c, P\)$/);
  assert.equal(answerOf(bracketed, { a, b, c }), ((a + b) * c) % P);
});

test("the modulus a call states is the one its kernels are handed", () => {
  // `invert` reduces by the modulus it was given rather than by the curve's, so
  // a rewrite that wrote the constant would be a different function.
  const rewritten = modularValue("x - u * q", "modulo");
  assert.match(rewritten, /^u256_sub_mod\(x, u256_mul_mod\(u, q, modulo\), modulo\)$/);
  const x = 10n;
  const u = 3n;
  const q = 4n;
  const modulo = 97n;
  assert.equal(answerOf(rewritten, { x, u, q, modulo }, modulo), sourceMod(x - u * q, modulo));
});

test("a value that is not one of the operators is a residue the formula already holds", () => {
  // Every operand of the curve's own arithmetic is below the modulus, which is
  // the invariant the formulas are written under; reducing one again would be a
  // division of a number that is already reduced.
  assert.equal(modularValue("x", "P"), "x");
  assert.equal(modularValue("2n", "P"), "2n");
});

test("the whole source has every reduction written as the kernels, and none as a remainder", () => {
  const source = readFileSync(new URL("../../benchmarks/machine_backend/secp256k1/1.ts", import.meta.url).pathname, "utf8");
  const rewritten = desugar(source);
  // The declaration of `mod` is not a call of it, and a call left anywhere is a
  // reduction the machine would compute as `%` — the product's high half gone
  // before the remainder saw it.
  assert.doesNotMatch(rewritten, /(?<![A-Za-z0-9_])mod\s*\(/, "no `mod(...)` call is left");
  assert.match(rewritten, /u256_mul_mod\(Z1, Z1, /, "the square of a coordinate is the kernel's");
  assert.match(rewritten, /u256_mul_mod\(invZ, invZ, /, "the inverse's square is reduced before the coordinate uses it");
  assert.match(rewritten, /u256_sub_mod\(D, X3, /, "the doubling subtracts the point it computed from D");
  assert.match(rewritten, /u256_add_mod\(X1, B, /, "the sum a doubled point squares is the addition kernel's");
});

test("the lowered program keeps the source's loop over the command line's count", () => {
  // The benchmark is a multiplication run as many times as its argument says.
  // The rules that lower its arithmetic used to answer main with one
  // multiplication and a count written into the source, so `./secp256k1 15` and
  // `./secp256k1 1` computed the same point.
  const source = readFileSync(new URL("../../benchmarks/machine_backend/secp256k1/1.ts", import.meta.url).pathname, "utf8");
  const rewritten = desugar(source);
  assert.match(rewritten, /const n = \+Deno\.args\[0\] \|\| 1;/, "the count is the argument the source reads");
  assert.match(rewritten, /for \(let i = 0; i < n; i\+\+\) \{/, "the loop is the source's own");
  assert.match(rewritten, /let point = new Point\(/, "the point starts as the class's own constructor");
  assert.match(rewritten, /point = point\.multiply\(/, "each turn multiplies the point the turn before answered");
  assert.match(rewritten, /console\.log\(`\$\{point\.x\.toString\(16\)\},\$\{point\.y\.toString\(16\)\}`\)/, "the print is the source's own");
  assert.match(rewritten, /class Point \{/, "the source's class is kept for the frontend");
  assert.match(rewritten, /class JacobianPoint \{/, "the point type is kept for the frontend");
  assert.doesNotMatch(rewritten, /function Point_multiply\(/, "the class is no longer rewritten into free functions");
  assert.match(rewritten, /function invert\(/, "the inversion is kept for the affine conversion");
});

test("the lowered inversion takes every step modulo the curve's order", () => {
  // The extended Euclidean algorithm over signed arbitrary precision integers
  // is written as residues: `x - u * q` wraps unless the whole step is taken
  // modulo the order, and a wrapped step is a different inverse.
  const source = readFileSync(new URL("../../benchmarks/machine_backend/secp256k1/1.ts", import.meta.url).pathname, "utf8");
  const rewritten = desugar(source);
  assert.match(rewritten, /u256_sub_mod\(x, u256_mul_mod\(u, q, modulo\), modulo\)/);
  assert.match(rewritten, /u256_sub_mod\(y, u256_mul_mod\(v, q, modulo\), modulo\)/);
});

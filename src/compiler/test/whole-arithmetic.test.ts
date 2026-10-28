/**
 * Whole-number arithmetic the compiler answers itself.
 *
 * A source's bigints are arbitrary precision: a constant expression is the
 * number it names, and a remainder of a product is the remainder of the whole
 * product. A `u256` is not arbitrary precision, so the compiler folds what it
 * can and hands the rest to the kernels that reduce without an intermediate
 * the width cannot hold. These check both halves, in the IR and in a program
 * the build delivers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runBuild } from "../compiler.ts";
import { run } from "../core/process.ts";
import { phaseOf, irOf } from "./phase.ts";
import { resolveProgram } from "../semantics/ir-resolve.ts";
import { printSemanticProgram } from "../semantics/ir-text.ts";
import { scratch } from "./scratch.ts";
import { writeProject } from "./project.ts";
import { foldWhole } from "../semantics/whole-arithmetic.ts";

const REPLAY = new URL("./fixtures/dot-product-replay.json", import.meta.url).pathname;
const QUIET = { stage: () => {} };

/** The IR of a program's body, lowered the way a build lowers it. */
function programIr(source: string): string {
  const phase = phaseOf("typescript", { "main.ts": source }, "main.ts");
  return printSemanticProgram(resolveProgram(phase.body!, phase.program, phase.objectNames, phase.objectLayouts, phase.objectKeys));
}

const P = 2n ** 256n - 2n ** 32n - 977n;

test("a folded value is the one the type holds", () => {
  // The fold is the arithmetic the backend would compute, not the one the
  // numbers reach: a `u256` holds 256 bits, a division of a signed number
  // truncates towards zero, and a floored remainder follows its divisor.
  assert.equal(foldWhole("sub", 0n, 2n ** 32n, "u256"), 2n ** 256n - 2n ** 32n);
  assert.equal(foldWhole("pow", 2n, 256n, "u256"), 0n, "a power wider than the type wraps");
  assert.equal(foldWhole("div", -7n, 2n, "i64"), -3n, "a division truncates towards zero");
  assert.equal(foldWhole("floorDiv", -7n, 2n, "i64"), -4n);
  assert.equal(foldWhole("mod", -7n, 2n, "i64"), -1n, "a remainder takes the sign of its left side");
  assert.equal(foldWhole("floorMod", -7n, 2n, "i64"), 1n);
  assert.equal(foldWhole("div", 1n, 0n, "i64"), null, "a division by zero is left to the program");
});

test("a constant expression of bigints is folded at the width that holds the answer", () => {
  // `2n ** 256n` is two to the two hundred and fifty sixth power, and the
  // `u256` it is held at wraps that to zero; the two subtractions that follow
  // then answer the curve's prime, which is the number the source wrote.
  const ir = programIr([
    "const P = 2n ** 256n - 2n ** 32n - 977n;",
    "const Q = 2n ** 128n;",
    "console.log(P.toString(16), Q.toString(16));",
    "",
  ].join("\n"));
  assert.match(ir, new RegExp(`const\\[u256\\] ${P}`), "the prime is one folded constant");
  assert.match(ir, /const\[u256\] 340282366920938463463374607431768211456/, "the power is one folded constant");
  assert.doesNotMatch(ir, /pow\[/, "no power is left for a target to compute");
});

test("a wide remainder is the kernels' answer, not the wrapped product", () => {
  // The product of two 256 bit numbers needs 512 bits. A `%` over the low half
  // is a different number from the remainder of the whole product, so the tree
  // is written as one kernel per operation, and a whole literal beside it is
  // widened to the width the kernel reads.
  const ir = programIr([
    "const P = 2n ** 256n - 2n ** 32n - 977n;",
    "let a: u256 = 0x1234567890abcdefn;",
    "let r: u256 = a * a % P;",
    "let s: u256 = (a * a + a - 3n) % P;",
    "let u: u256 = a % P;",
    "console.log(r.toString(16), s.toString(16), u.toString(16));",
    "",
  ].join("\n"));
  assert.match(ir, /u256_mul_mod \[arg\[u256\] local\[u256\] a arg\[u256\] local\[u256\] a /, "the product is reduced before it wraps");
  assert.match(ir, /u256_add_mod /, "a sum under a remainder is the addition kernel's");
  assert.match(ir, /u256_sub_mod /, "a difference under a remainder is the subtraction kernel's");
  assert.match(ir, /arg\[u256\] const\[u256\] 3 /, "a whole literal is widened to the width the kernel reads");
  // A dividend that is one value is the ordinary remainder: fusing it to the
  // value itself would drop the reduction the source wrote.
  assert.match(ir, /let value\[u256\] u mutable = \[mod\[u256\] local\[u256\] a/, "a bare remainder stays a remainder");
});

test("a truth of a wide number is compared with zero", () => {
  // A wide number is four limbs, and a branch reads a truth. The source's
  // `if (n & 1n)` is the comparison the language reads it as, and it is written
  // as one here rather than handed to a target that has no `if` over four limbs.
  const ir = programIr([
    "let n: u256 = 3n;",
    "let s: u256 = 0n;",
    "if (n & 1n) { s = 1n; }",
    "console.log(s.toString(16));",
    "",
  ].join("\n"));
  assert.match(ir, /if \[ne\[bool\] u256 \[and\[u256\] local\[u256\] n const\[i64\] 1\] const\[u256\] 0\]/, "the mask is tested against zero");
});

test("a power of a whole number is written as the products it is", () => {
  // A kernel has no wide power, and a power of a whole number is a product of
  // them: a square is the number multiplied by itself, and a constant power is
  // folded rather than written out.
  const source = [
    "function square(a: u256): u256 { return a ** 2n; }",
    "function height(): u256 { return 2n ** BigInt(128); }",
    "console.log(square(3n).toString(16), height().toString(16));",
    "",
  ].join("\n");
  assert.match(irOf("typescript", { "main.ts": source }, "main.ts", "square"), /return \[mul\[u256\] local\[u256\] a local\[u256\] a\]/);
  assert.match(irOf("typescript", { "main.ts": source }, "main.ts", "height"), /return const\[u256\] 340282366920938463463374607431768211456/);
});

test("a program computes bigints as the language it was written in does", async () => {
  // The source runs under the language's own toolchain as well as being built,
  // and the two have to print the same thing: a folded constant, a modular
  // product, a power and a truth of a wide number, over values wide enough that
  // the wrapped answer is a different number.
  const source = [
    "const P = 2n ** 256n - 2n ** 32n - 977n;",
    "function square(a: u256): u256 { return a * a % P; }",
    "function power(a: u256): u256 { return a ** 2n; }",
    "function odd(n: u256): boolean { if (n & 1n) { return true; } return false; }",
    "let a: u256 = 0x1234567890abcdefn;",
    "console.log(P.toString(16));",
    "console.log(square(a).toString(16));",
    "console.log((a * a + a - 3n).toString(16));",
    "console.log(power(a).toString(16));",
    "console.log(odd(a), odd(a + 1n));",
    "console.log((2n ** 128n).toString(16));",
    "",
  ].join("\n");
  const directory = await scratch("blaze-whole-arithmetic-");
  await writeFile(join(directory, "main.ts"), source, "utf8");
  await writeProject(join(directory, "blaze.toml"), {
    language: "typescript",
    sourceFile: "main.ts",
    model: { provider: "replay", file: REPLAY },
    output: "machine",
  });
  const outcome = await runBuild(
    "blaze.toml",
    { cwd: directory, reuse: false, model: `replay:${REPLAY}` },
    QUIET,
    "build",
  );
  assert.ok(outcome.outputPath !== null, "a program build delivers its binary");
  const original = run("node", ["--experimental-strip-types", "main.ts"], { cwd: directory, timeoutMs: 60_000 });
  const delivered = run(outcome.outputPath, [], { timeoutMs: 60_000 });
  assert.equal(original.code, 0, original.stderr);
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, original.stdout);
});

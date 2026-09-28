/**
 * Lowering a function's semantic IR to a WebAssembly module.
 *
 * Every case here is run: the module is emitted, the engine validates it, and
 * the host the build ships runs it against the vectors the contract carries. A
 * case that only inspected the bytes would agree with a module that traps.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildModule } from "../toolchain/ir-wasm.ts";
import { programWithSemantics } from "./phase.ts";
import { run } from "../core/process.ts";
import type { FunctionContract } from "../core/types.ts";
import type { SemanticFunction } from "../core/semantic-ir.ts";

/**
 * Contracts a library that declares one function, emits the module for it, and
 * runs it under the host the build ships. The signature is given rather than
 * assumed, because the vectors the host reads carry one field per parameter and
 * a test that guessed the signature would be checking the wrong call.
 */
async function compute(
  parameters: string,
  body: readonly string[],
  vectors: string,
  expected: string,
): Promise<void> {
  const library = `export function r(${parameters}): number {\n${body.join("\n")}\n}\n`;
  const files = { "main.ts": 'import { r } from "./lib.ts";\nr(0);\n', "lib.ts": library };
  const { program, semantics } = programWithSemantics("typescript", files, "main.ts");
  const contract = program.files.find((file) => file.path === "lib.ts")?.functions.r;
  assert.ok(contract !== undefined, "the entry program imports the function under test");
  const directory = await mkdtemp(join(tmpdir(), "blaze-wasm-"));
  const built = await buildModule({
    fn: semantics.r as SemanticFunction,
    contract,
    modulePath: join(directory, "candidate.wasm"),
    hostPath: join(directory, "host.mjs"),
  });
  const result = run("node", [built.hostPath, built.modulePath], { input: vectors, timeoutMs: 60_000 });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, expected);
}

test("the module computes the sum a counted loop accumulates", async () => {
  await compute(
    "a: Float64Array, b: Float64Array, n: number",
    ["  let total = 0;", "  for (let i = 0; i < n; i++) { total += a[i] * b[i]; }", "  return total;"],
    "run\n3 3 3\n1 2 3\n4 5 6\n",
    "RESULT 32\n",
  );
});

test("a loop that counts down ends rather than counting past its bound", async () => {
  // The index moves by a signed step, so a loop counting down carries a negative
  // one. A lowering that subtracts it moves the index the other way and the
  // loop never ends: this answer is the whole of what says the loop terminated.
  await compute(
    "n: number",
    ["  let total = 0;", "  for (let i = n; i > 0; i -= 1) { total += i; }", "  return total;"],
    "run\n4\n",
    "RESULT 10\n",
  );
});

test("a for-of walks a buffer by element and stops at its length", async () => {
  await compute(
    "a: Float64Array",
    ["  let total = 0;", "  for (const value of a) { total += value; }", "  return total;"],
    "run\n3\n1 2 3\n",
    "RESULT 6\n",
  );
});

test("a branch is read for the arm it takes and the arm it does not", async () => {
  const guard = ["  if (n < lo) { return lo; }", "  if (n > hi) { return hi; }", "  return n;"];
  await compute("n: number, lo: number, hi: number", guard, "run\n9 0 5\n", "RESULT 5\n");
  await compute("n: number, lo: number, hi: number", guard, "run\n1 0 5\n", "RESULT 1\n");
  await compute("n: number, lo: number, hi: number", guard, "run\n3 0 5\n", "RESULT 3\n");
});

test("a whole-number buffer is read at the width the host laid it out at", async () => {
  // A `u8` element is one byte, and reading it as a four byte word reads the
  // three elements after it, so the count this returns says which it did.
  await compute(
    "a: Int32Array, n: number",
    ["  let count = 0;", "  for (let i = 0; i < n; i++) { if (a[i] > 2) { count += 1; } }", "  return count;"],
    "run\n3 3\n7 8 9\n",
    "RESULT 3\n",
  );
});

test("a construct the module boundary cannot reach is refused by name", async () => {
  const files = {
    "main.ts": 'import { r } from "./lib.ts";\nr(0);\n',
    "lib.ts": "export function r(n: number): number {\n  console.log(n);\n  return n;\n}\n",
  };
  const { program, semantics } = programWithSemantics("typescript", files, "main.ts");
  const contract: FunctionContract | undefined = program.files.find((f) => f.path === "lib.ts")?.functions.r;
  assert.ok(contract !== undefined, "the entry program imports the function under test");
  const directory = await mkdtemp(join(tmpdir(), "blaze-wasm-print-"));
  await assert.rejects(
    buildModule({
      fn: semantics.r as SemanticFunction,
      contract,
      modulePath: join(directory, "candidate.wasm"),
      hostPath: join(directory, "host.mjs"),
    }),
    /cannot print a number/,
    "a module reaches no runtime service, so printing is refused rather than emitted",
  );
});

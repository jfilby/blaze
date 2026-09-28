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
import { buildModule, moduleBytes } from "../toolchain/ir-wasm.ts";
import { programWithSemantics } from "./phase.ts";
import { run } from "../core/process.ts";
import { encodeRunRequest, type TestVector } from "../toolchain/verifier.ts";
import type { FunctionContract } from "../core/types.ts";
import type { SemanticFunction } from "../core/semantic-ir.ts";

/** The parts of the engine a case here drives a module with. */
interface Engine {
  Module: new (bytes: Uint8Array) => object;
  Instance: new (module: object, imports: object) => { exports: Record<string, unknown> };
  Memory: new (shape: { initial: number }) => { buffer: ArrayBuffer };
}

/**
 * The engine the build runs on, reached the way the backend reaches it: a
 * case here drives a module directly, because the host lays out only the
 * memory a vector needs and a case has to see what lies past a buffer.
 */
const engine = (globalThis as { WebAssembly?: Engine }).WebAssembly;
assert.ok(engine !== undefined, "the engine the build runs on carries modules");

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
  const walk = ["  let total = 0;", "  for (const value of a) { total += value; }", "  return total;"];
  await compute("a: Float64Array", walk, "run\n3\n1 2 3\n", "RESULT 6\n");
  await compute("a: Float64Array", walk, "run\n0\n", "RESULT 0\n");
});

test("a walk stops at the count even when the memory past the buffer is not empty", async () => {
  // A module is handed a pointer to the elements and no length beside it, so
  // the host writes the count in the word the pointer sits one before. A
  // module that has to guess the count walks off the end of the buffer, and
  // memory the host has not written is not always zero: the numbers below are
  // what a walk that counted on would add up.
  const library = [
    "export function r(a: Float64Array): number {",
    "  let total = 0;",
    "  for (const value of a) { total += value; }",
    "  return total;",
    "}",
  ].join("\n");
  const files = { "main.ts": 'import { r } from "./lib.ts";\nr(0);\n', "lib.ts": library };
  const { program, semantics } = programWithSemantics("typescript", files, "main.ts");
  const contract: FunctionContract | undefined = program.files.find((file) => file.path === "lib.ts")?.functions.r;
  assert.ok(contract !== undefined, "the entry program imports the function under test");
  const memory = new engine.Memory({ initial: 1 });
  const instance = new engine.Instance(new engine.Module(moduleBytes(semantics.r as SemanticFunction, contract)), {
    env: { memory },
  });
  const view = new DataView(memory.buffer);
  view.setBigUint64(1024, 3n, true);
  for (let index = 0; index < 3; index += 1) view.setFloat64(1032 + index * 8, index + 1, true);
  for (let address = 1056; address < 1024 + 512; address += 8) view.setFloat64(address, 100, true);
  const entry = instance.exports[contract.function.name] as (offset: number) => number;
  assert.equal(entry(1032), 6, "a walk that counted past three elements summed the hundreds beside them");
});

test("a length is the count the host wrote, not a count of bytes", async () => {
  await compute("a: Int32Array", ["  return a.length > 0 ? 1 : 0;"], "run\n3\n7 8 9\n", "RESULT 1\n");
  await compute("a: Int32Array", ["  return a.length > 0 ? 1 : 0;"], "run\n0\n", "RESULT 0\n");
  await compute("a: Int32Array", ["  return a.length > 2 ? 1 : 0;"], "run\n3\n7 8 9\n", "RESULT 1\n");
  await compute("a: Int32Array", ["  return a.length > 2 ? 1 : 0;"], "run\n1\n7\n", "RESULT 0\n");
});

test("a branch is read for the arm it takes and the arm it does not", async () => {
  const guard = ["  if (n < lo) { return lo; }", "  if (n > hi) { return hi; }", "  return n;"];
  await compute("n: number, lo: number, hi: number", guard, "run\n9 0 5\n", "RESULT 5\n");
  await compute("n: number, lo: number, hi: number", guard, "run\n1 0 5\n", "RESULT 1\n");
  await compute("n: number, lo: number, hi: number", guard, "run\n3 0 5\n", "RESULT 3\n");
});
test("a comparison is made in the type the source compared in, not as whole numbers", async () => {
  // A comparison names the type its two sides are compared as, and a double is
  // not a whole number. Truncating -0.5 to 0 loses the sign that decided the
  // branch, so a lowering that compares whole numbers answers the other arm
  // than the one the source wrote.
  const guard = ["  if (n < 0) { return -1; }", "  return 1;"];
  await compute("n: number", guard, "run\n-0.5\n", "RESULT -1\n");
  await compute("n: number", guard, "run\n0.5\n", "RESULT 1\n");
});

test("a conditional hands back the arm its test chose, and not the other", async () => {
  // A `select` reads its test off the top of the stack, under the two arms it
  // chooses between. A lowering that pushes the test first hands back the arm
  // the source did not write, or builds a module the engine refuses.
  const arm = ["  let v = n < 0 ? 1 : 2;", "  return v;"];
  await compute("n: number", arm, "run\n-1\n", "RESULT 1\n");
  await compute("n: number", arm, "run\n1\n", "RESULT 2\n");
});

test("a short-circuit operator answers with the arm the source kept", async () => {
  // `&&` is the right arm when the left one holds and `||` is the left arm
  // then, so a lowering that treats both alike answers the opposite of the
  // operator the source wrote.
  const conjunction = ["  let v = n > 0 && n < 5;", "  return v ? 1 : 0;"];
  await compute("n: number", conjunction, "run\n3\n", "RESULT 1\n");
  await compute("n: number", conjunction, "run\n7\n", "RESULT 0\n");
  const disjunction = ["  let v = n > 0 || n < -5;", "  return v ? 1 : 0;"];
  await compute("n: number", disjunction, "run\n3\n", "RESULT 1\n");
  await compute("n: number", disjunction, "run\n-3\n", "RESULT 0\n");
});

test("a jump out of a nested arm reaches the loop it names", async () => {
  // An `if` opens a label the format counts when a branch reaches past it, so
  // a `break` inside an arm is one depth further out than a `break` in the
  // body. A depth that forgets the arm restarts the loop instead of leaving it,
  // and this program never answers.
  const leaving = [
    "  let i = 0;",
    "  while (i < n) {",
    "    if (i === 2) { break; }",
    "    i++;",
    "  }",
    "  return i;",
  ];
  await compute("n: number", leaving, "run\n5\n", "RESULT 2\n");
  const turning = [
    "  let total = 0;",
    "  for (let i = 0; i < n; i++) {",
    "    if (i === 2) { continue; }",
    "    total += i;",
    "  }",
    "  return total;",
  ];
  await compute("n: number", turning, "run\n5\n", "RESULT 8\n");
});

test("a loop that counts down on `i--` ends, and a `continue` moves it on", async () => {
  // The step of a loop that names none is one the way it already travels, so a
  // loop counting down moves by a negative one: a step of one either way counts
  // a loop up and the answer never comes. A `continue` branches to the head of
  // the turn, so the index moves there or the loop counts on the same index
  // for ever.
  const down = ["  let total = 0;", "  for (let i = n; i > 0; i--) { total += i; }", "  return total;"];
  await compute("n: number", down, "run\n4\n", "RESULT 10\n");
  const turning = [
    "  let total = 0;",
    "  for (let i = 0; i < n; i++) {",
    "    if (i === 2) { continue; }",
    "    total += i;",
    "  }",
    "  return total;",
  ];
  await compute("n: number", turning, "run\n4\n", "RESULT 4\n");
});

test("a body whose arms all return is a module the engine takes", async () => {
  // Every path out of this body returns, so the body falls off its own end
  // carrying nothing. A function that returns a value still has to leave one
  // of that type behind, and a `return` with an empty stack is not a module.
  const arms = [
    "  if (n < 0) { return -1; }",
    "  else if (n === 0) { return 0; }",
    "  else { return 1; }",
  ];
  await compute("n: number", arms, "run\n-4\n", "RESULT -1\n");
  await compute("n: number", arms, "run\n0\n", "RESULT 0\n");
  await compute("n: number", arms, "run\n4\n", "RESULT 1\n");
});

test("an element is written at the width it is read at", async () => {
  // A name holds the buffer, and what one of its elements are takes the type
  // out of that. An address counted in the name's own width, and a value
  // stored at it, land one element along of where the next read looks.
  await compute("a: Int32Array, i: number", ["  a[i] = 7;", "  return a[0];"], "run\n4 0\n1 2 3 4\n", "RESULT 7\n");
});

test("a 64 bit constant is the number it was written as", async () => {
  // A signed LEB128 of a 64 bit value is wider than a machine word, so it is
  // written out of a `bigint`. Written out of a 32 bit one it keeps its low
  // half, and 5000000000 answers as 705032704.
  const library = [
    "export function r(): bigint {",
    "  let total = 5000000000n;",
    "  for (let i = 0; i < 2; i++) { total += 1n; }",
    "  return total;",
    "}",
  ].join("\n");
  const files = { "main.ts": 'import { r } from "./lib.ts";\nr();\n', "lib.ts": library };
  const { program, semantics } = programWithSemantics("typescript", files, "main.ts");
  const contract: FunctionContract | undefined = program.files.find((file) => file.path === "lib.ts")?.functions.r;
  assert.ok(contract !== undefined, "the entry program imports the function under test");
  const directory = await mkdtemp(join(tmpdir(), "blaze-wasm-"));
  const built = await buildModule({
    fn: semantics.r as SemanticFunction,
    contract,
    modulePath: join(directory, "candidate.wasm"),
    hostPath: join(directory, "host.mjs"),
  });
  const vectors: TestVector[] = [{ id: "only", kind: "fixed", args: {} }];
  const result = run("node", [built.hostPath, built.modulePath], {
    input: encodeRunRequest(contract, vectors),
    timeoutMs: 60_000,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "RESULT 5000000002\n");
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

test("a value is left in the type the use reads it in", async () => {
  // An arm of a conditional may be a double where the whole is another width,
  // and nothing is a zero of the left arm's own type. Each is chosen or
  // compared with the others beside it, so each has to be in the width of the
  // whole before it reaches the operator that reads them together.
  const coalesce = ["  let v = n ?? 0;", "  return v;"];
  await compute("n: number", coalesce, "run\n0\n", "RESULT 0\n");
  await compute("n: number", coalesce, "run\n2.5\n", "RESULT 2.5\n");
  const arm = ["  let v = c ? n : 0.5;", "  return v;"];
  await compute("c: boolean, n: number", arm, "run\n1 1.5\n", "RESULT 1.5\n");
  await compute("c: boolean, n: number", arm, "run\n0 1.5\n", "RESULT 0.5\n");
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

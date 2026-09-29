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
import { CompilerError } from "../core/errors.ts";
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

test("a continue advances a for-of walk instead of re-reading its first element", async () => {
  // The walk advances at the head of the turn, for the reason a counted loop
  // does: a `continue` branches to the head, so an advance at the foot is one
  // a `continue` skips, and a walk that never advances never ends.
  await compute(
    "a: Float64Array",
    ["  let total = 0;", "  for (const value of a) { if (value > 2) continue; total += value; }", "  return total;"],
    "run\n5\n1 2 3 4 5\n",
    "RESULT 3\n",
  );
});

test("a continue re-tests the condition of a do-while", async () => {
  // The test is at the foot of the turn, and a `continue` branches to the head
  // of the loop, so the body sits in a block of its own: branching to a block
  // runs to its end, which is where the test is. A branch to the body start
  // would skip the condition, and the loop would never end.
  await compute(
    "n: number",
    ["  let total = 0;", "  let i = 0;", "  do { i += 1; if (i > 2) continue; total += i; } while (i < 5);", "  return total;"],
    "run\n0\n\n",
    "RESULT 3\n",
  );
});

test("a plain assignment inside an arm leaves nothing on the stack", async () => {
  // Every block the backend opens is void-typed, so a value left on the stack
  // fails the `end` check of the arm it was in and the engine refuses the
  // module. A `=` computes nothing from what the slot holds, so the old value
  // is never pushed.
  await compute(
    "n: number",
    ["  let t = 0;", "  if (n > 1) { t = 5.5; }", "  return t;"],
    "run\n3\n\n",
    "RESULT 5.5\n",
  );
});

test("a negation and a complement of a whole number are the arithmetic that is them", async () => {
  // WebAssembly has no `i64.neg` and no integer complement, so `-x` is `0 - x`
  // and `~x` is `0 - 1 - x`. Emitting the binary opcodes instead asked for a
  // second operand that was never pushed, and the engine refused the module.
  // A complement of a double is refused by the validator, so these are whole
  // numbers, which is the only place the language allows one.
  await compute("n: bigint", ["  return -n;"], "run\n5\n\n", "RESULT -5\n");
  await compute("n: bigint", ["  return ~n;"], "run\n5\n\n", "RESULT -6\n");
});

test("a negation of a 32 bit whole number is a module the engine takes", async () => {
  // There is no `i32.neg` either. The 64 bit case above pushes the zero it
  // subtracts from; the 32 bit one did not, so it emitted `i32.sub` with a
  // single operand on the stack and the engine refused the whole module —
  // "not enough arguments on the stack for i32.sub (need 2, got 1)". A `u32`
  // element is the only 32 bit whole number a source can negate, so the array
  // is how the case is reached.
  // The negation is a `u32` one, because that is the type the IR gives it: the
  // zero it subtracts from is a zero of the element's own type, so `0 - 7` is
  // `4294967289` and reads back as itself. The C backend has always answered
  // that, so a module that answered `-7` here was a module the two backends
  // disagreed about.
  await compute("a: Uint32Array", ["  return -a[0];"], "run\n1\n7\n", "RESULT 4294967289\n");
  await compute("a: Uint32Array", ["  return -a[0];"], "run\n2\n0 1\n", "RESULT 0\n");
});

test("a maths builtin is the instruction of its own name", async () => {
  // Every maths builtin is one instruction, but the table that carried it was
  // keyed by the bare name the opcode is called (`abs`) rather than the name a
  // callee is contracted under (`Math.abs`), so no entry ever matched and every
  // maths call in a module was refused. The opcodes were the `f32` ones of the
  // same names over arguments that are doubles.
  await compute("n: number", ["  return Math.abs(n);"], "run\n-2.5\n\n", "RESULT 2.5\n");
  await compute("n: number", ["  return Math.floor(n);"], "run\n-2.5\n\n", "RESULT -3\n");
  await compute("n: number", ["  return Math.trunc(n);"], "run\n-2.5\n\n", "RESULT -2\n");
  // Used inside an expression rather than returned whole, so the argument and
  // the answer both have to sit on the stack around the instruction.
  await compute("n: number", ["  return Math.abs(n) + 1;"], "run\n-2.5\n\n", "RESULT 3.5\n");
});

test("a whole number the module holds unsigned is ordered and computed as unsigned", async () => {
  // WebAssembly names its ordering and dividing instructions after how the bits
  // read, and `u32` is read unsigned. `3000000000` is over the signed range, so
  // the same bits are `-1294967296` to a signed instruction: ordered as signed
  // it sits below 1, divided as signed it halves to `-647483648`, and shifted
  // as signed it moves the wrong way. Every answer here is the unsigned one.
  const high = "3000000000";
  await compute("a: Uint32Array", ["  return a[0] < a[1] ? 1 : 0;"], `run\n2\n${high} 1\n`, "RESULT 0\n");
  await compute("a: Uint32Array", ["  return a[1] < a[0] ? 1 : 0;"], `run\n2\n${high} 1\n`, "RESULT 1\n");
  await compute("a: Uint32Array", ["  return a[0] > a[1] ? 1 : 0;"], `run\n2\n${high} 1\n`, "RESULT 1\n");
  await compute("a: Uint32Array", ["  return a[0] / a[1];"], `run\n3\n${high} 2 0\n`, "RESULT 1500000000\n");
  await compute("a: Uint32Array", ["  return a[0] % a[1];"], `run\n3\n${high} 3 0\n`, "RESULT 0\n");
  await compute("a: Uint32Array", ["  return a[0] >> a[1];"], `run\n3\n${high} 1 0\n`, "RESULT 1500000000\n");
  // The answer of a whole operation is read as a double on the way out, and
  // `3000000001` is over the signed range of the 32 bit it was held in, so
  // widening it as a signed value is where a sum that was right becomes
  // `-1294967295`. The operations the two spellings share must not move.
  await compute("a: Uint32Array", ["  return a[0] + a[1];"], `run\n2\n${high} 1\n`, "RESULT 3000000001\n");
});

test("a maths builtin written for its effect is an instruction and not an empty one", async () => {
  // A call statement is the same instruction as a call read for its value, and
  // it takes the same arguments. Emitted without them it popped a value nobody
  // pushed, and the engine refused the whole module.
  await compute("n: number", ["  Math.floor(n);", "  return 1;"], "run\n1.5\n\n", "RESULT 1\n");
  await compute("n: number", ["  Math.abs(n);", "  return 2;"], "run\n-3\n\n", "RESULT 2\n");
});

test("a maths builtin that is not one instruction is refused by name", async () => {
  // `Math.round` rounds a half up and the only rounding a module has rounds a
  // half to even, so no instruction of it is the same number. The refusal says
  // which one and why, rather than reporting it as a call a module cannot make.
  await assert.rejects(
    compute("n: number", ["  return Math.round(n);"], "run\n1\n\n", ""),
    (error: unknown) => {
      assert.ok(error instanceof CompilerError);
      assert.match(error.message, /cannot round the way the source language does/);
      assert.match(error.detail ?? "", /rounds a half up and the module's own rounding rounds a half to even/);
      return true;
    },
  );
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

test("locals of different carriers are declared in the order they are numbered", async () => {
  // The module numbers the locals in the order the declaration pairs are
  // written, and the body numbers them in the order it declares them. The
  // pairs were collected one per distinct carrier, which is the same order
  // only while one carrier fills one contiguous run: a bigint held between two
  // numbers permuted the rest, and the module the compiler wrote was rejected
  // as not valid WebAssembly.
  const interleaved = ["  let a = 1.5;", "  let b = 2n;", "  let c = 2.5;", "  return a + c;"];
  await compute("", interleaved, "run\n\n", "RESULT 4\n");
  const leading = ["  let b = 2n;", "  let a = 1.5;", "  let c = 2.5;", "  return a + c;"];
  await compute("", leading, "run\n\n", "RESULT 4\n");
  const trailing = ["  let a = 1.5;", "  let c = 2.5;", "  let b = 2n;", "  return a + c;"];
  await compute("", trailing, "run\n\n", "RESULT 4\n");
  // A run of one carrier is still declared once, and the whole is still right.
  await compute("", ["  let a = 1.5;", "  let c = 2.5;", "  return a + c;"], "run\n\n", "RESULT 4\n");
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

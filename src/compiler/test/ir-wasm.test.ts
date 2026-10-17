/**
 * Lowering a function's semantic IR to a WebAssembly module.
 *
 * Every case here is run: the module is emitted, the engine validates it, and
 * the host the build ships runs it against the vectors the contract carries. A
 * case that only inspected the bytes would agree with a module that traps.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { join } from "node:path";
import { buildModule, moduleBytes } from "../toolchain/ir-wasm.ts";
import { programWithSemantics } from "./phase.ts";
import { run } from "../core/process.ts";
import { encodeRunRequest, type TestVector } from "../toolchain/verifier.ts";
import type { FunctionContract } from "../core/types.ts";
import { parseSemanticFunction } from "../semantics/ir-text.ts";
import type { ArithOp, CompareOp, SemanticFunction, SemanticType } from "../core/semantic-ir.ts";
import { scratch } from "./scratch.ts";

/** The parts of the engine a case here drives a module with. */
interface Engine {
  Module: new (bytes: Uint8Array) => object;
  Instance: new (module: object, imports: object) => { exports: Record<string, unknown> };
  Memory: new (shape: { initial: number }) => { buffer: ArrayBuffer };
  validate(bytes: Uint8Array): boolean;
}

/**
 * The engine the build runs on, reached the way the backend reaches it: a
 * case here drives a module directly, because the host lays out only the
 * memory a vector needs and a case has to see what lies past a buffer.
 */
const engine = (globalThis as { WebAssembly?: Engine }).WebAssembly;
assert.ok(engine !== undefined, "the engine the build runs on carries modules");

const F64: SemanticType = { kind: "primitive", name: "f64" };
const I32: SemanticType = { kind: "primitive", name: "i32" };

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
  const directory = await scratch("blaze-wasm-");
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

test("a loop counts from the name its own index shadows", async () => {
  // The prologue declares the index in the block the body is, and the bound and
  // the start are read where the source wrote them: a local declared and not yet
  // written is a zero, so a prologue that declared the index first started this
  // loop at zero and answered the sum of 0, 1 and 2 rather than of 10, 11 and 12.
  await compute(
    "n: number",
    [
      "  let limit = 10;",
      "  let total = 0;",
      "  for (let limit = limit; limit < 13; limit += 1) { total += limit; }",
      "  return total;",
    ],
    "run\n0\n",
    "RESULT 33\n",
  );
});

test("a statement that reads a name into itself leaves the ones around it alone", async () => {
  // `x = x` is the one statement whose read and write cancel: the value is
  // already on the stack, so both instructions go and one name is left. Where
  // the read begins has to be the `local.get` itself, taken after the opcode is
  // written — a position read before the opcode is written down is a position of
  // no instruction at all, and truncating the body to it drops every instruction
  // before the read, so the module does not answer this at all.
  await compute(
    "a: Float64Array",
    ["  let x = a[0];", "  let y = x;", "  x = x;", "  return x + y;"],
    "run\n1\n7\n",
    "RESULT 14\n",
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
  await compute("n: number", ["  return Math.ceil(n);"], "run\n-2.5\n\n", "RESULT -2\n");
  await compute("n: number", ["  return Math.ceil(n);"], "run\n2.5\n\n", "RESULT 3\n");
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

test("a maths builtin that rounds a half up is the instruction the source expects", async () => {
  await compute("n: number", ["  return Math.round(n);"], "run\n2.5\n\n", "RESULT 3\n");
  await compute("n: number", ["  return Math.round(n);"], "run\n-2.5\n\n", "RESULT -3\n");
  await compute("n: number", ["  return Math.round(n);"], "run\n2.4\n\n", "RESULT 2\n");
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
    env: { memory, pow: Math.pow },
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
  const directory = await scratch("blaze-wasm-");
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

test("a reference is tested for nothing against a zero of its own width", () => {
  // A reference is a byte offset, which the module holds at the full width of
  // a 64 bit number. The nothing it is compared against was written as an
  // `i32`, and `i32.eq` over an `i64` and an `i32` is a module the engine
  // refuses, so every `x === null` and `!x` failed the build. The reference
  // arrives as a parameter because this backend has no way to build one.
  const object: SemanticType = { kind: "ref", of: null, name: "Point" };
  const fn: SemanticFunction = {
    name: "r",
    symbol: "r",
    params: [{ kind: "object", name: "p", mutable: false, type: object }],
    returns: F64,
    requires: [],
    ensures: [],
    effects: [],
    allocates: false,
    prints: false,
    readsArgv: false,
    objects: {},
    calls: [],
    entry: {
      id: "entry",
      statements: [
        {
          k: "let",
          slot: { kind: "value", name: "absent", mutable: false, type: F64 },
          value: {
            k: "select",
            type: F64,
            condition: { k: "isNull", type: I32, operand: { k: "local", type: object, name: "p" }, negate: false },
            then: { k: "const", type: F64, text: "1" },
            otherwise: { k: "const", type: F64, text: "0" },
          },
          line: 1,
        },
        {
          k: "let",
          slot: { kind: "value", name: "present", mutable: false, type: F64 },
          value: {
            k: "select",
            type: F64,
            condition: { k: "isNull", type: I32, operand: { k: "local", type: object, name: "p" }, negate: true },
            then: { k: "const", type: F64, text: "1" },
            otherwise: { k: "const", type: F64, text: "0" },
          },
          line: 2,
        },
      ],
      releases: [],
      terminator: {
        k: "return",
        value: {
          k: "arith",
          type: F64,
          op: "add",
          left: { k: "local", type: F64, name: "absent" },
          right: { k: "local", type: F64, name: "present" },
        },
      },
    },
  };
  const contract = {
    version: "1",
    function: { name: "r", symbol: "r", params: [{ name: "p", type: "ref<Point>" }], returns: "f64" },
    requires: [],
    ensures: [],
    memory: { reads: [], writes: [], aliasing: [] },
    effects: [],
    numeric: { floatingPoint: "ieee754", rounding: "nearest", fastMath: false },
    optimize: { primary: "balanced" },
    definition: { statements: [], objects: {}, allocates: false, prints: false, readsArgv: false, calls: [] },
  } as FunctionContract;
  const memory = new engine.Memory({ initial: 1 });
  const instance = new engine.Instance(new engine.Module(moduleBytes(fn, contract)), { env: { memory, pow: Math.pow } });
  const read = instance.exports.r as (p: number) => number;
  assert.equal(read(0), 1, "nothing is nothing, and an offset is not");
  assert.equal(read(64), 1, "an offset beside a buffer is not nothing either");
});

test("a field is stored at the width its type is read at", () => {
  // The address of an object is the only thing narrowed to the 32 bits the
  // format indexes memory with. The value went down wrapped to the same
  // width, and `f64.store` was then handed an `i32`: the engine refused the
  // module, so every write to a field wider than a word failed the build. The
  // object arrives as a parameter because this backend cannot build one.
  const object: SemanticType = { kind: "ref", of: null, name: "Point" };
  const fn: SemanticFunction = {
    name: "r",
    symbol: "r",
    params: [{ kind: "object", name: "p", mutable: true, type: object }],
    returns: F64,
    requires: [],
    ensures: [],
    effects: [],
    allocates: false,
    prints: false,
    readsArgv: false,
    objects: {
      Point: { name: "Point", fields: [{ name: "x", type: "f64", offset: 0 }], size: 8, align: 8 },
    },
    calls: [],
    entry: {
      id: "entry",
      statements: [
        {
          k: "storeField",
          layout: "Point",
          field: "x",
          object: { k: "local", type: object, name: "p" },
          value: { k: "const", type: F64, text: "7.25" },
          line: 1,
        },
      ],
      releases: [],
      terminator: {
        k: "return",
        value: { k: "loadField", type: F64, object: { k: "local", type: object, name: "p" }, layout: "Point", field: "x" },
      },
    },
  };
  const contract = {
    version: "1",
    function: { name: "r", symbol: "r", params: [{ name: "p", type: "ref<Point>" }], returns: "f64" },
    requires: [],
    ensures: [],
    memory: { reads: [], writes: [], aliasing: [] },
    effects: [],
    numeric: { floatingPoint: "ieee754", rounding: "nearest", fastMath: false },
    optimize: { primary: "balanced" },
    definition: { statements: [], objects: {}, allocates: false, prints: false, readsArgv: false, calls: [] },
  } as FunctionContract;
  const memory = new engine.Memory({ initial: 1 });
  const instance = new engine.Instance(new engine.Module(moduleBytes(fn, contract)), { env: { memory, pow: Math.pow } });
  assert.equal((instance.exports.r as (p: number) => number)(64), 7.25, "a double field holds the double it was written with");
});

test("a compound division of a whole number above the signed range is unsigned", async () => {
  // The instruction is named for how the bits read and not for how the value
  // was declared: `i32.div_s` over a `u32` of 3000000000 answered a negative
  // number, while the same division written as `n = a / b` was unsigned.
  const library = [
    "export function r(n: number): number {",
    "  let x = 3000000000;",
    "  x /= n;",
    "  return x;",
    "}",
    "",
  ].join("\n");
  const files = { "main.ts": 'import { r } from "./lib.ts";\nr(0);\n', "lib.ts": library };
  const { program, semantics } = programWithSemantics("typescript", files, "main.ts");
  const contract: FunctionContract | undefined = program.files.find((file) => file.path === "lib.ts")?.functions.r;
  assert.ok(contract !== undefined, "the entry program imports the function under test");
  const directory = await scratch("blaze-wasm-divu-");
  const built = await buildModule({
    fn: semantics.r as SemanticFunction,
    contract,
    modulePath: join(directory, "candidate.wasm"),
    hostPath: join(directory, "host.mjs"),
  });
  const vectors: TestVector[] = [{ id: "only", kind: "fixed", args: { n: "2" } }];
  const result = run("node", [built.hostPath, built.modulePath], {
    input: encodeRunRequest(contract, vectors),
    timeoutMs: 60_000,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "RESULT 1500000000\n");
});

test("a construct the module boundary cannot reach is refused by name", async () => {
  const files = {
    "main.ts": 'import { r } from "./lib.ts";\nr(0);\n',
    "lib.ts": "export function r(n: number): number {\n  console.log(n);\n  return n;\n}\n",
  };
  const { program, semantics } = programWithSemantics("typescript", files, "main.ts");
  const contract: FunctionContract | undefined = program.files.find((f) => f.path === "lib.ts")?.functions.r;
  assert.ok(contract !== undefined, "the entry program imports the function under test");
  const directory = await scratch("blaze-wasm-print-");
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

/**
 * Emits the module for a function written as the IR text a model writes,
 * against the contract of the same function written in a source, and answers
 * whether the engine takes the bytes. The TypeScript path only writes an
 * element with a compound operator where the source itself is compound, so
 * shapes the text form can write still reach this backend through the text.
 */
function throughIr(library: string, text: string): number {
  const files = { "main.ts": 'import { r } from "./lib.ts";\nr(0);\n', "lib.ts": library };
  const { program } = programWithSemantics("typescript", files, "main.ts");
  const contract: FunctionContract | undefined = program.files.find((file) => file.path === "lib.ts")?.functions.r;
  assert.ok(contract !== undefined, "the entry program imports the function under test");
  const bytes = moduleBytes(parseSemanticFunction(text, program), contract);
  assert.ok(engine !== undefined);
  return engine.validate(bytes) ? bytes.length : -1;
}

test("a compound write to an element reads the element it writes over", () => {
  // `a[i] += v` takes the old element and the new value, and the store that
  // follows takes the address and one value. Pushing the address and the new
  // value and emitting the operator left the operator combining those two and
  // one value on the stack where the store reads two, so `WebAssembly.validate`
  // said no: every compound element write was a module the engine refused.
  // The shape also reaches this backend through the IR text a model writes,
  // which names the compound write directly.
  const library = "export function r(a: Float64Array): number {\n  a[1] = 2.5;\n  a[0] = 1.5;\n  return a[0] + a[1];\n}\n";
  const text = [
    "function r(a: []f64) -> f64",
    '  requires "a != null"',
    '  requires "len(a) >= (1 + 1)"',
    '  requires "len(a) >= (0 + 1)"',
    "  ensures none",
    "  allocates no",
    "  prints no",
    "  reads_argv no",
    "  effects none",
    "  param value[[]f64] a mutable",
    "  block entry: releases[]",
    "    set_element a const[usize] 1 = const[f64] 2.5 @2",
    "    set_element a const[usize] 1 += const[f64] 1.5 @3",
    "  return [add[f64] [element[f64] local[[]f64] a const[usize] 0] [element[f64] local[[]f64] a const[usize] 1]]",
    "",
  ].join("\n");
  assert.ok(throughIr(library, text) > 0, "a compound element write is a module the engine takes");
});

test("a power is lowered through the runtime import", () => {
  const library = "export function r(a: number): number {\n  return a ** 2;\n}\n";
  const text = [
    "function r(a: f64) -> f64",
    "  requires none",
    "  ensures none",
    "  allocates no",
    "  prints no",
    "  reads_argv no",
    "  effects none",
    "  param value[f64] a mutable",
    "  block entry: releases[]",
    "  return [pow[f64] local[f64] a const[f64] 2]",
    "",
  ].join("\n");
  assert.ok(throughIr(library, text) > 0, "a pow in IR text is a module the engine takes");
  const setText = [
    "function r(a: f64) -> f64",
    "  requires none",
    "  ensures none",
    "  allocates no",
    "  prints no",
    "  reads_argv no",
    "  effects none",
    "  param value[f64] a mutable",
    "  block entry: releases[]",
    "    let value[f64] b mutable = local[f64] a @2",
    "    set b **= const[f64] 2 @3",
    "  return local[f64] b",
    "",
  ].join("\n");
  assert.ok(throughIr(library, setText) > 0, "a `**=` in IR text is a module the engine takes");
});

test("two blocks that both declare a name are two values, not one", async () => {
  // One local for a name across the whole function gave the second block's
  // declaration its type to the first block's uses, and a `local.set` of a
  // double against a local of another width is a module the engine refuses.
  // The resolver refuses a name declared twice in the same block, so this is
  // two sibling arms of one test.
  const arms = [
    "  let total = 0;",
    "  if (n > 0) { let v = 1.5; total = v; }",
    "  else { let v = 2n; total = 3; }",
    "  return total;",
  ];
  await compute("n: number", arms, "run\n1\n", "RESULT 1.5\n");
  await compute("n: number", arms, "run\n-1\n", "RESULT 3\n");
});

test("a short-circuit operator does not run the arm the source never reaches", () => {
  // `&&` answers with its left arm when the left one does not hold, and a
  // `select` over the two arms is handed both of them: the right arm ran
  // whatever the left one said, so `i < n && a[i] > 0` read the first element
  // of an empty buffer. The memory past the buffer is filled with positives
  // here, which is what a walk that read past the count would answer.
  const library = [
    "export function r(a: Float64Array, n: number): number {",
    "  let count = 0;",
    "  for (let i = 0; i < n; i++) { if (i < n && a[i] > 0) { count += 1; } }",
    "  return count;",
    "}",
  ].join("\n");
  const files = { "main.ts": 'import { r } from "./lib.ts";\nr(0);\n', "lib.ts": library };
  const { program, semantics } = programWithSemantics("typescript", files, "main.ts");
  const contract: FunctionContract | undefined = program.files.find((file) => file.path === "lib.ts")?.functions.r;
  assert.ok(contract !== undefined, "the entry program imports the function under test");
  const memory = new engine.Memory({ initial: 1 });
  const instance = new engine.Instance(new engine.Module(moduleBytes(semantics.r as SemanticFunction, contract)), {
    env: { memory, pow: Math.pow },
  });
  const view = new DataView(memory.buffer);
  view.setBigUint64(1024, 0n, true);
  for (let address = 1032; address < 1024 + 512; address += 8) view.setFloat64(address, 100, true);
  const read = instance.exports[contract.function.name] as (offset: number, count: number) => number;
  assert.equal(read(1032, 0), 0, "an empty buffer is read as an empty buffer, not as the memory past it");
  view.setBigUint64(1024, 2n, true);
  view.setFloat64(1032, 5, true);
  view.setFloat64(1040, -1, true);
  assert.equal(read(1032, 2), 1, "the right arm runs only for the elements the left arm lets it");
});

test("a clamp is the two instructions the module has for it", async () => {
  // `Math.min` and `Math.max` are `f64.min` and `f64.max`, and a clamp is the
  // two of them. The table named neither, so a clamp was refused with an error
  // about `Math.round`, which is a different builtin and a different reason.
  const clamp = ["  return Math.min(Math.max(n, 0), 10);"];
  await compute("n: number", clamp, "run\n-4\n", "RESULT 0\n");
  await compute("n: number", clamp, "run\n7\n", "RESULT 7\n");
  await compute("n: number", clamp, "run\n40\n", "RESULT 10\n");
});

test("the command line is refused by what it is, not by what rounds", async () => {
  // Every builtin with no instruction behind it was reported as `Math.round`,
  // so a read of `process.argv` was refused for a rounding the source never
  // asked for.
  await assert.rejects(
    compute("n: number", ["  return n + process.argv.length;"], "run\n1\n\n", ""),
    /cannot read the command line/,
    "a module is handed the vectors and no process, so the command line is named as what it is",
  );
});

test("a module whose code is larger than one buffer is written whole", async () => {
  // Every buffer starts at 256 bytes and is widened by asking for room, which
  // takes a copy. Reaching for the buffer before asking for the room means the
  // copy happens after the write was aimed at the old one, so everything past
  // the old end is dropped and the section length no longer matches what is
  // inside it. A function below that size never reaches it.
  const lines = ["  let total = 0;"];
  for (let index = 0; index < 60; index += 1) lines.push(`  total += a[0] * ${index + 1}.5 + a[1] * ${index + 2}.25;`);
  lines.push("  return total;");
  const expected = Array.from({ length: 60 }, (_, index) => 1 * (index + 1.5) + 2 * (index + 2.25)).reduce((sum, value) => sum + value, 0);
  await compute("a: Float64Array, n: number", lines, "run\n2 1\n1 2\n", `RESULT ${expected}\n`);
});

test("a wide constant is laid down in the module's own memory and read back", () => {
  // A wide number is thirty-two bytes and no WebAssembly instruction carries
  // thirty-two bytes, so the literal is written once into a data segment and
  // every use of it is its address. This is the one part of carrying a wide
  // number that has to be right before any arithmetic on one can be: an
  // operation reads its operands out of memory at an address, and an address
  // that points at nothing reads back as zero and every limb of the answer is
  // then zero as well.
  //
  // The limbs are laid down lowest first, which is what the arithmetic reads
  // them back in, and the segment begins above the scratch a computation writes
  // into — a data segment is written by the host and not by the module, so a
  // constant and a value in flight cannot share an address.
  const U: SemanticType = { kind: "primitive", name: "u256" };
  const TEXT = "0x0123456789abcdeffedcba987654321089abcdef0123456776543210fedcba98";
  const memory = new engine.Memory({ initial: 1 });
  const instance = new engine.Instance(
    new engine.Module(moduleBytes(returnsConstant(U, TEXT), wideContract())),
    { env: { memory, pow: Math.pow } },
  );
  const address = (instance.exports as { subject: () => number }).subject();
  const view = new Uint8Array(memory.buffer);
  let limbs = "";
  for (let limb = 3; limb >= 0; limb -= 1) {
    for (let at = 7; at >= 0; at -= 1) limbs += view[address + limb * 8 + at].toString(16).padStart(2, "0");
  }
  assert.equal(limbs, TEXT.slice(2), "the four limbs are where the address says, lowest first");
});

/** The contract for a function of no arguments answering one wide number. */
function wideContract(): FunctionContract {
  return {
    version: "1",
    numeric: { floatingPoint: "ieee754", rounding: "nearest", fastMath: false },
    function: { name: "subject", symbol: "subject", params: [], returns: "u256" },
    optimize: { primary: "latency", secondary: "size" },
    effects: [],
    memory: { reads: [], writes: [], aliasing: [] },
    requires: [],
    ensures: [],
    definition: { statements: [], objects: {}, allocates: false, prints: false, readsArgv: false, calls: [] },
  };
}

/** A function whose whole body is one wide literal. */
function returnsConstant(type: SemanticType, text: string): SemanticFunction {
  return {
    name: "subject",
    symbol: "subject",
    params: [],
    returns: type,
    requires: [],
    ensures: [],
    effects: [],
    allocates: false,
    prints: false,
    readsArgv: false,
    objects: {},
    calls: [],
    entry: { id: "entry", statements: [], releases: [], terminator: { k: "return", value: { k: "const", type, text } } },
  };
}

test("a wide number is arithmetic on four limbs, in the module's own memory", () => {
  // There is no two hundred and fifty six bit add in WebAssembly and, because
  // a module imports the host's memory and nothing else, there is no kernel to
  // call either. What is left is the arithmetic the C backend's kernel does,
  // written out: four limbs combined one at a time with the carry threaded
  // into the next.
  //
  // The carry is found by comparing rather than by sign, because these are
  // whole numbers and a signed comparison would read the top bit as a sign.
  // Three values go into each limb — both operands and the carry from below —
  // so it takes two comparisons, and a limb that carries on its own while the
  // carry coming in pushes it past again is the case that catches a version
  // which only tests the first.
  const U: SemanticType = { kind: "primitive", name: "u256" };
  const MASK = (1n << 256n) - 1n;
  const VECTORS: readonly (readonly [string, string])[] = [
    ["0123456789abcdeffedcba987654321089abcdef0123456776543210fedcba98", "fedcba98765432100123456789abcdeffedcba98765432100123456789abcdef"],
    ["ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", "0000000000000000000000000000000000000000000000000000000000000001"],
    ["ffffffffffffffff0000000000000000ffffffffffffffff0000000000000000", "0000000000000000ffffffffffffffff0000000000000000ffffffffffffffff"],
    ["ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"],
    ["00000000000000010000000000000000", "00000000000000010000000000000000"],
    ["00000000000000000000000000000000", "00000000000000000000000000000001"],
  ];
  for (const op of ["add", "sub", "and", "or", "xor"] as const) {
    for (const [leftText, rightText] of VECTORS) {
      const left = BigInt(`0x${leftText}`);
      const right = BigInt(`0x${rightText}`);
      const expected = op === "add" ? (left + right) & MASK : op === "sub" ? (left - right) & MASK : op === "and" ? left & right : op === "or" ? left | right : left ^ right;
      const bytes = moduleBytes(wideBinary(U, op, leftText, rightText), wideContract());
      const memory = new engine.Memory({ initial: 1 });
      const instance = new engine.Instance(new engine.Module(bytes), { env: { memory, pow: Math.pow } });
      const address = (instance.exports as { subject: () => number }).subject();
      const view = new Uint8Array(memory.buffer);

      let limbs = "";
      for (let limb = 3; limb >= 0; limb -= 1) {
        for (let at = 7; at >= 0; at -= 1) limbs += view[address + limb * 8 + at].toString(16).padStart(2, "0");
      }
      assert.equal(limbs, expected.toString(16).padStart(64, "0"), `the ${op} of ${leftText} and ${rightText}`);
    }
  }
});

test("two whole numbers are subtracted a limb at a time, borrowing as it goes", () => {
  // A borrow runs up the number when a limb cannot cover what is taken from it,
  // so the vectors are chosen so that the borrow starts at the bottom and at the
  // top and stops somewhere in the middle. A version that stops after the first
  // limb is right on every value that never borrows and wrong on every value
  // that does.
  const U: SemanticType = { kind: "primitive", name: "u256" };
  const MASK = (1n << 256n) - 1n;
  const VECTORS: readonly (readonly [string, string])[] = [
    ["ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"],
    ["00000000000000000000000000000000", "00000000000000000000000000000001"],
    ["00000000000000010000000000000000", "00000000000000010000000000000000"],
    ["ffffffffffffffff000000000000000000000000000000000000000000000000", "0000000000000001000000000000000000000000000000000000000000000000"],
    ["0123456789abcdeffedcba987654321089abcdef0123456776543210fedcba98", "fedcba98765432100123456789abcdeffedcba98765432100123456789abcdef"],
    ["ffffffffffffffffffffffffffffffff0000000000000000ffffffffffffffff", "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"],
  ];
  for (const [leftText, rightText] of VECTORS) {
    const left = BigInt(`0x${leftText}`);
    const right = BigInt(`0x${rightText}`);
    const bytes = moduleBytes(wideBinary(U, "sub", leftText, rightText), wideContract());
    const memory = new engine.Memory({ initial: 1 });
    const instance = new engine.Instance(new engine.Module(bytes), { env: { memory, pow: Math.pow } });
    const address = (instance.exports as { subject: () => number }).subject();
    const view = new Uint8Array(memory.buffer);
    let limbs = "";
    for (let limb = 3; limb >= 0; limb -= 1) {
      for (let at = 7; at >= 0; at -= 1) limbs += view[address + limb * 8 + at].toString(16).padStart(2, "0");
    }
    assert.equal(limbs, ((left - right) & MASK).toString(16).padStart(64, "0"), `the sub of ${leftText} and ${rightText}`);
  }
});

/** A function whose whole body is one wide operation on two wide literals. */
function wideBinary(type: SemanticType, op: ArithOp, left: string, right: string): SemanticFunction {
  return {
    name: "subject",
    symbol: "subject",
    params: [],
    returns: type,
    requires: [],
    ensures: [],
    effects: [],
    allocates: false,
    prints: false,
    readsArgv: false,
    objects: {},
    calls: [],
    entry: {
      id: "entry",
      statements: [],
      releases: [],
      terminator: {
        k: "return",
        value: { k: "arith", type, op, left: { k: "const", type, text: `0x${left}` }, right: { k: "const", type, text: `0x${right}` } },
      },
    },
  };
}

test("two whole numbers are compared a limb at a time, from the top", () => {
  // Whole numbers are ordered by their top limbs: a number whose top limbs
  // match is ordered by the first pair below them that does not. That is the
  // walk this exercises, and the vectors are chosen so that the answer is found
  // at the top in one case and at the bottom in another — a walk that started
  // at the bottom and stopped at the first difference would order `1` below
  // `2^64` correctly and `2^64` below `1` wrongly.
  const U: SemanticType = { kind: "primitive", name: "u256" };
  const MASK = (1n << 256n) - 1n;
  const VECTORS: readonly (readonly [string, string])[] = [
    ["1", "2"],
    ["2", "1"],
    ["ffffffffffffffff00000000000000000000000000000000000000000000000000000000", "ffffffffffffffffffffffffffffffff0000000000000000000000000000000000000000000000"],
    ["00000000000000000000000000000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", "00000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000"],
    ["ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"],
    ["0", "0"],
  ];
  for (const op of ["eq", "ne", "lt", "le", "gt", "ge"] as const) {
    for (const [leftText, rightText] of VECTORS) {
      const left = BigInt(`0x${leftText}`) & MASK;
      const right = BigInt(`0x${rightText}`) & MASK;
      const expected =
        op === "eq" ? left === right : op === "ne" ? left !== right
        : op === "lt" ? left < right : op === "le" ? left <= right
        : op === "gt" ? left > right : left >= right;
      const memory = new engine.Memory({ initial: 1 });
      const bytes: Uint8Array = moduleBytes(wideComparison(U, op, leftText, rightText), boolContract());
      const instance = new engine.Instance(new engine.Module(bytes), { env: { memory, pow: Math.pow } });
      const answer: number = (instance.exports as { subject: () => number }).subject();
      assert.equal(answer !== 0, expected, `the ${op} of ${leftText} and ${rightText}`);
    }
  }
});

/** A function whose whole body is one comparison of two wide literals. */
function wideComparison(type: SemanticType, op: CompareOp, left: string, right: string): SemanticFunction {
  return {
    name: "subject", symbol: "subject", params: [], returns: { kind: "primitive", name: "bool" },
    requires: [], ensures: [], effects: [], allocates: false, prints: false, readsArgv: false, objects: {}, calls: [],
    entry: {
      id: "entry", statements: [], releases: [],
      terminator: {
        k: "return",
        value: { k: "compare", type: { kind: "primitive", name: "bool" }, op, operand: type,
          left: { k: "const", type, text: `0x${left}` }, right: { k: "const", type, text: `0x${right}` } },
      },
    },
  };
}

/** The contract for a function of no arguments answering a whole number. */
function numberContract(returns: string): FunctionContract {
  return { ...boolContract(), function: { name: "subject", symbol: "subject", params: [], returns } };
}

/** The contract for a function of no arguments answering a truth. */
function boolContract(): FunctionContract {
  return {
    version: "1",
    numeric: { floatingPoint: "ieee754", rounding: "nearest", fastMath: false },
    function: { name: "subject", symbol: "subject", params: [], returns: "bool" },
    optimize: { primary: "latency", secondary: "size" },
    effects: [],
    memory: { reads: [], writes: [], aliasing: [] },
    requires: [], ensures: [],
    definition: { statements: [], objects: {}, allocates: false, prints: false, readsArgv: false, calls: [] },
  };
}

test("a whole number is chosen between two, a limb at a time", () => {
  // The module has an instruction that chooses between two values, and running
  // it on two wide numbers would choose between their two addresses — which are
  // two different places, and the answer is whichever place holds it. So the
  // limbs are chosen and written, which is the selection the operator means.
  const U: SemanticType = { kind: "primitive", name: "u256" };
  for (const take of [true, false]) {
    const then = "fedcba98765432100123456789abcdeffedcba98765432100123456789abcdef";
    const otherwise = "0123456789abcdeffedcba987654321089abcdef0123456776543210fedcba98";
    const bytes: Uint8Array = moduleBytes(wideSelection(U, take, then, otherwise), wideContract());
    const memory = new engine.Memory({ initial: 1 });
    const instance = new engine.Instance(new engine.Module(bytes), { env: { memory, pow: Math.pow } });
    const address: number = (instance.exports as { subject: () => number }).subject();
    const view = new Uint8Array(memory.buffer);
    let limbs = "";
    for (let limb = 3; limb >= 0; limb -= 1) {
      for (let at = 7; at >= 0; at -= 1) limbs += view[address + limb * 8 + at].toString(16).padStart(2, "0");
    }
    assert.equal(limbs, take ? then : otherwise, `the selection when the condition is ${take}`);
  }
});

/** A function whose whole body is one selection between two wide literals. */
function wideSelection(type: SemanticType, take: boolean, then: string, otherwise: string): SemanticFunction {
  return {
    name: "subject", symbol: "subject", params: [], returns: type,
    requires: [], ensures: [], effects: [], allocates: false, prints: false, readsArgv: false, objects: {}, calls: [],
    entry: {
      id: "entry", statements: [], releases: [],
      terminator: {
        k: "return",
        value: {
          k: "select", type,
          condition: { k: "bool", type: { kind: "primitive", name: "bool" }, value: take },
          then: { k: "const", type, text: `0x${then}` },
          otherwise: { k: "const", type, text: `0x${otherwise}` },
        },
      },
    },
  };
}

/** A function whose whole body is one wide shift by a scalar count. */
function wideShifted(type: SemanticType, op: "shl" | "shr", left: string, right: string): SemanticFunction {
  return {
    name: "subject",
    symbol: "subject",
    params: [],
    returns: type,
    requires: [],
    ensures: [],
    effects: [],
    allocates: false,
    prints: false,
    readsArgv: false,
    objects: {},
    calls: [],
    entry: {
      id: "entry",
      statements: [],
      releases: [],
      terminator: {
        k: "return",
        value: { k: "arith", type, op, left: { k: "const", type, text: `0x${left}` }, right: { k: "const", type: { kind: "primitive", name: "usize" }, text: right } },
      },
    },
  };
}

test("a module imports the host's memory and nothing else", () => {
  // The whole of what a module can reach is its own arithmetic and the memory the
  // host placed in it. A module that imported a function would be reaching for a
  // runtime service, and one that grew its memory would be reaching past the host
  // for more — so both are asserted here rather than left as a claim in a
  // comment, because a module that broke the rule would still be a valid module
  // and would still run.
  const U: SemanticType = { kind: "primitive", name: "u256" };
  const bytes = moduleBytes(wideBinary(U, "add", "ff".repeat(32), "01".padStart(64, "0")), wideContract());
  const listed = (engine.Module as unknown as { imports(module: object): { module: string; name: string; kind: string }[] }).imports(new engine.Module(bytes));
  assert.deepEqual(listed, [{ module: "env", name: "memory", kind: "memory" }, { module: "env", name: "pow", kind: "function" }], "the module asks for the host's memory and pow");
});

test("a whole number moves by a number of bits, a limb at a time", () => {
  // A count of bits is a whole number of limbs and the bits left over. The walk
  // this exercises is the one that has to combine the two — a version that moved
  // each limb by the whole count, or by only the leftover bits, is right for
  // counts under sixty-four and wrong for every count above it.
  const U: SemanticType = { kind: "primitive", name: "u256" };
  const MASK = (1n << 256n) - 1n;
  const VALUE = "fedcba98765432100123456789abcdeffedcba98765432100123456789abcdef";
  const left = BigInt(`0x${VALUE}`);
  for (const op of ["shl", "shr"] as const) {
    for (const count of [0, 1, 7, 63, 64, 65, 127, 200]) {
      const expected = (op === "shl" ? left << BigInt(count) : left >> BigInt(count)) & MASK;
      const bytes = moduleBytes(wideShifted(U, op, VALUE, String(count)), wideContract());
      const memory = new engine.Memory({ initial: 1 });
      const instance = new engine.Instance(new engine.Module(bytes), { env: { memory, pow: Math.pow } });
      const address = (instance.exports as { subject: () => number }).subject();
      const view = new Uint8Array(memory.buffer);
      let limbs = "";
      for (let limb = 3; limb >= 0; limb -= 1) {
        for (let at = 7; at >= 0; at -= 1) limbs += view[address + limb * 8 + at].toString(16).padStart(2, "0");
      }
      assert.equal(limbs, expected.toString(16).padStart(64, "0"), `a shift ${op === "shl" ? "left" : "right"} by ${count}`);
    }
  }
});

/**
 * A function whose whole body is one shift of two literals, held at the width
 * the shift is at. The opcode is chosen by the carrier, so this is the shape
 * that says which instruction the module has to emit for it.
 */
function scalarShifted(type: SemanticType, op: "shr" | "ushr", left: string, right: string): SemanticFunction {
  return {
    name: "subject", symbol: "subject", params: [], returns: type,
    requires: [], ensures: [], effects: [], allocates: false, prints: false, readsArgv: false, objects: {}, calls: [],
    entry: {
      id: "entry",
      statements: [],
      releases: [],
      terminator: {
        k: "return",
        value: { k: "arith", type, op, left: { k: "const", type, text: left }, right: { k: "const", type, text: right } },
      },
    },
  };
}

/** What a body of one shift answers, run on the engine the build runs on. */
function shifted(fn: SemanticFunction, contract: FunctionContract): number {
  const here = engine;
  assert.ok(here !== undefined);
  const bytes = moduleBytes(fn, contract);
  assert.ok(here.validate(bytes), "the engine accepts the module");
  const memory = new here.Memory({ initial: 1 });
  const instance = new here.Instance(new here.Module(bytes), { env: { memory, pow: Math.pow } });
  return (instance.exports as { subject: () => number }).subject();
}

test("a whole number of thirty-two bits moves by a number of bits", () => {
  // The opcode beside the shift is a rotate: rotating forty-eight left by two
  // pushes the low two bits out of the top and leaves nothing behind, so the
  // answer is zero where the shift is twelve. A right shift of a whole number
  // the module reads as unsigned clears the top bit, where the signed one
  // carries the negativity out — the two differ on exactly the numbers above
  // the signed range, which is the whole of what this covers.
  const S32: SemanticType = { kind: "primitive", name: "i32" };
  const U32Type: SemanticType = { kind: "primitive", name: "u32" };
  assert.equal(shifted(scalarShifted(S32, "ushr", "48", "2"), numberContract("i32")), 12);
  assert.equal(shifted(scalarShifted(U32Type, "ushr", "-2", "1"), numberContract("u32")), 2147483647);
  assert.equal(shifted(scalarShifted(S32, "shr", "-2", "1"), numberContract("i32")), -1);
});


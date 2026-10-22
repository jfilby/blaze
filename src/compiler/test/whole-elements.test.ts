/**
 * What the whole-number pass over buffers does to a program, and that what it
 * does is the same program.
 *
 * The pass in `semantics/whole-elements.ts` reads a whole program rather than
 * one body — what a buffer holds is what every write into it and every call
 * site of every function leaves in it — so what it needs checking is the
 * program: the shape it leaves a loop in, the shapes it refuses to leave one
 * in, and the numbers both forms answer. The numbers are checked by running the
 * program the way a build builds it and the way the language runs it, and
 * comparing what the two print; the machine code is checked by disassembling
 * what the machine backend wrote, because the whole of what this pass is for is
 * the carry chain it shortens.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildProgramDriver } from "../toolchain/driver.ts";
import { compileFunctionC, generateFunctionC } from "../toolchain/ir-c.ts";
import { buildObject } from "../toolchain/ir-machine.ts";
import { resolveProgram } from "../semantics/ir-resolve.ts";
import { resolveFunction } from "../semantics/ir-function.ts";
import { optimizeSemanticProgram, optimizeSemanticFunction } from "../semantics/optimize-ir.ts";
import { wholeElementArithmetic } from "../semantics/whole-elements.ts";
import { contractsByName, vectorChecked } from "../semantics/calls.ts";
import { semanticIrProblems, validateSemanticFunction } from "../semantics/ir-validate.ts";
import { buildStandaloneRuntime } from "../runtime/standalone.ts";
import { RUNTIME_NAME, runtimeHeaderSource } from "../runtime/abi.ts";
import { run } from "../core/process.ts";
import type { FunctionContext } from "../semantics/ir-function.ts";
import type { SemanticFunction, SemanticProgram } from "../core/semantic-ir.ts";
import type { FunctionContract, TargetSpec } from "../core/types.ts";
import { phaseOf } from "./phase.ts";
import { scratch } from "./scratch.ts";

const TARGET: TargetSpec = { arch: "x86_64", os: "linux", abi: "sysv", cpu: "", features: [] };

/** The object the driver of every program here links against, built once. */
let runtime: Promise<string> | null = null;

/**
 * A modular addition over four limbs, which is the shape this pass exists for:
 * the carry is a chain of eleven turns in the benchmark and four here, and every
 * turn of it waits on the one before.
 */
const ADDITION = [
  "function addMod(o: Float64Array, a: Float64Array, b: Float64Array): void {",
  "  let carry = 0;",
  "  for (let i = 0; i < 4; i += 1) {",
  "    const sum = a[i] + b[i] + carry;",
  "    const whole = Math.floor(sum / 16777216);",
  "    o[i] = sum - whole * 16777216;",
  "    carry = whole;",
  "  }",
  "}",
  "",
  "const A = new Float64Array(4);",
  "const B = new Float64Array(4);",
  "const O = new Float64Array(4);",
  "for (let i = 0; i < 4; i += 1) {",
  "  A[i] = 9000000 + i * 7;",
  "  B[i] = 8000000 + i * 11;",
  "}",
  "addMod(O, A, B);",
  "for (let i = 0; i < 4; i += 1) console.log(O[i]);",
  "",
].join("\n");

/** The same program with a fraction written into one of the buffers. */
const FRACTION = ADDITION.replace("A[i] = 9000000 + i * 7;", "A[i] = 9000000 + i * 7 + 0.5;");

/** The same program with a buffer filled by a function of a number. */
const FILLED_BY_CALL = [
  "function fillWhole(o: Float64Array): void {",
  "  for (let i = 0; i < 4; i += 1) o[i] = 9000000 + i * 7;",
  "}",
  "function fillFrom(v: number, o: Float64Array): void {",
  "  for (let i = 0; i < 4; i += 1) o[i] = v + i;",
  "}",
  "function addMod(o: Float64Array, a: Float64Array, b: Float64Array): void {",
  "  let carry = 0;",
  "  for (let i = 0; i < 4; i += 1) {",
  "    const sum = a[i] + b[i] + carry;",
  "    const whole = Math.floor(sum / 16777216);",
  "    o[i] = sum - whole * 16777216;",
  "    carry = whole;",
  "  }",
  "}",
  "",
  "const A = new Float64Array(4);",
  "const B = new Float64Array(4);",
  "const O = new Float64Array(4);",
  "fillWhole(A);",
  "fillFrom(3.5, B);",
  "addMod(O, A, B);",
  "for (let i = 0; i < 4; i += 1) console.log(O[i]);",
  "",
].join("\n");

/**
 * A function whose body is one reduction, and so states a postcondition: the
 * checker runs it with vectors of its own, and a vector is not the program's
 * buffer.
 */
const CONTRACTED = [
  "function sumAll(a: Float64Array, n: number): number {",
  "  let total = 0;",
  "  for (let i = 0; i < n; i += 1) total += a[i];",
  "  return total;",
  "}",
  "",
  "const A = new Float64Array(4);",
  "for (let i = 0; i < 4; i += 1) A[i] = 9000000 + i * 7;",
  "console.log(sumAll(A, 4));",
  "",
].join("\n");

/** What a source is contracted and resolved into, and what the pass left it. */
interface Phased {
  readonly program: SemanticProgram;
  readonly functions: Map<string, SemanticFunction>;
  readonly phase: ReturnType<typeof phaseOf>;
}

/** A program contracted, with its own statements and every function resolved. */
function phased(source: string, leave: ReadonlySet<string> = new Set()): Phased {
  const phase = phaseOf("typescript", { "main.ts": source }, "main.ts");
  assert.ok(phase.body !== undefined);
  const contracts = phase.program.files.flatMap((file) => Object.entries(file.functions));
  const context: FunctionContext = { objectNames: phase.objectNames, functions: Object.fromEntries(contracts) };
  const functions = new Map(contracts.map(([name, contract]) => [name, resolveFunction(contract, context)]));
  const program = resolveProgram(phase.body, phase.program, phase.objectNames, phase.objectLayouts, phase.objectKeys);
  wholeElementArithmetic([...functions.values()], program.entry, leave);
  return { program, functions, phase };
}

/** The IR one function of a program is left in, after the pass and the rounds. */
function bodyOf(source: string, name: string, leave: ReadonlySet<string> = new Set()): string {
  const { functions } = phased(source, leave);
  const fn = functions.get(name);
  assert.ok(fn !== undefined, `${name} is a function of the program`);
  return JSON.stringify(optimizeSemanticFunction(fn, functions));
}

/** The C one function of a program is written out as, after the rewrites. */
function written(source: string, name: string): string {
  const { functions } = phased(source);
  const fn = functions.get(name);
  assert.ok(fn !== undefined, `${name} is a function of the program`);
  return generateFunctionC(optimizeSemanticFunction(fn, functions));
}

/** The program written to disk, every function of it compiled, and the link. */
async function linked(source: string): Promise<{ directory: string; binary: string }> {
  const { program, functions, phase } = phased(source);
  const directory = await scratch("blaze-whole-elements-");
  await writeFile(join(directory, "main.ts"), source, "utf8");
  await writeFile(join(directory, `${RUNTIME_NAME}.h`), runtimeHeaderSource(), "utf8");
  runtime ??= buildStandaloneRuntime(await scratch("blaze-runtime-")).then((built) => built.objectPath);

  const objectPaths: string[] = [];
  for (const contract of phase.program.files.flatMap((file) => Object.values(file.functions))) {
    const fn = functions.get(contract.function.name);
    assert.ok(fn !== undefined);
    const built = await compileFunctionC({
      fn: optimizeSemanticFunction(fn, functions),
      contract,
      mode: "debug",
      target: TARGET,
      sourcePath: join(directory, `${fn.name}.c`),
      objectPath: join(directory, `${fn.name}.o`),
      includeDirectories: [directory],
    });
    objectPaths.push(built.objectPath);
  }
  const runner = await buildProgramDriver({
    mode: "debug",
    target: TARGET,
    program: optimizeSemanticProgram(program),
    workDirectory: directory,
    objectPaths,
    runtimeObjectPath: await runtime,
    outputPath: join(directory, "program"),
  });
  return { directory, binary: runner.command };
}

/** The machine code one function of a program is written out as. */
async function emitted(source: string, name: string): Promise<string> {
  const { functions, phase } = phased(source);
  const fn = functions.get(name);
  assert.ok(fn !== undefined, `${name} is a function of the program`);
  const contract = Object.values(phase.program.files)
    .flatMap((file) => Object.values(file.functions))
    .find((one) => one.function.name === name);
  assert.ok(contract !== undefined);
  const directory = await scratch("blaze-whole-elements-asm-");
  const objectPath = join(directory, `${name}.o`);
  const built = await buildObject({
    fn: optimizeSemanticFunction(fn, functions),
    contract: contract as FunctionContract,
    target: TARGET,
    callable: new Set(functions.keys()),
    objectPath,
  });
  assert.ok(built.textSizeBytes > 0);
  return run("objdump", ["-d", "--no-show-raw-insn", objectPath], { timeoutMs: 30_000 }).stdout;
}

test("a loop over a buffer of whole numbers computes in whole numbers", () => {
  const body = bodyOf(ADDITION, "addMod");

  // The carry is a chain of whole-number turns, so the sum of a limb and the
  // carry is a whole-number addition and the quotient of that sum by a power of
  // two is a shift down: `Math.floor(sum / 16777216)` was sixteen cycles of
  // floating point on the one part of a turn nothing else was waiting on, and it
  // is one instruction now.
  assert.match(body, /"op":"shr"/);
  assert.doesNotMatch(body, /"callee":"Math\.floor"/);
  // The two element reads are bound to names of their own, because a double
  // cannot be read at the width a whole number is read at, and the sum of them
  // is bound at that width in one declaration rather than one per side.
  assert.match(body, /"type":\{"kind":"primitive","name":"i64"\}/);
  // What leaves the loop is still the array the program declared: the elements
  // are written as whole numbers into the same doubles they were written into
  // before, and every signature is the one the source declared.
  assert.match(body, /"k":"setElement"/);
  assert.match(body, /"kind":"slice","of":\{"kind":"primitive","name":"f64"\}/);
});

test("a buffer the program writes a fraction into is left alone", () => {
  // One element written as three quarters is one buffer whose elements are not
  // all whole numbers, and reading it as a whole number would answer `1` where
  // the program wrote `1.5`.
  const body = bodyOf(FRACTION, "addMod");

  assert.doesNotMatch(body, /"op":"shr"/);
  assert.match(body, /"callee":"Math\.floor"/);
});

test("a buffer a call site fills from a number the program cannot see is left alone", () => {
  // `fillFrom(3.5, B)` writes a fraction the pass cannot rule out, so the buffer
  // is one it may not bound whatever the other of the program's writers does.
  const body = bodyOf(FILLED_BY_CALL, "addMod");

  assert.doesNotMatch(body, /"op":"shr"/);
  assert.match(body, /"callee":"Math\.floor"/);
});

test("a loop whose arms are a reduction is written as a whole number", () => {
  // The loop's body has to be a chain. One with an arm in it is left as it was,
  // and so is one whose body calls anything.
  const conditional = [
    "function reduce(o: Float64Array, m: Float64Array): void {",
    "  let borrow = 0;",
    "  for (let i = 0; i < 4; i += 1) {",
    "    const difference = o[i] - m[i] - borrow;",
    "    if (difference < 0) {",
    "      o[i] = difference + 16777216;",
    "      borrow = 1;",
    "    } else {",
    "      o[i] = difference;",
    "      borrow = 0;",
    "    }",
    "  }",
    "}",
    "",
    "const O = new Float64Array(4);",
    "const M = new Float64Array(4);",
    "for (let i = 0; i < 4; i += 1) {",
    "  O[i] = 9000000 + i * 7;",
    "  M[i] = 8000000 + i * 11;",
    "}",
    "reduce(O, M);",
    "for (let i = 0; i < 4; i += 1) console.log(O[i]);",
    "",
  ].join("\n");
  const body = bodyOf(conditional, "reduce");

  assert.match(body, /"type":\{"kind":"primitive","name":"i64"\}/);
});

test("the whole-number loop is arithmetic the validator holds to", () => {
  const { program, functions, phase } = phased(ADDITION);
  assert.deepEqual(semanticIrProblems(optimizeSemanticProgram(program)), []);
  for (const contract of phase.program.files.flatMap((file) => Object.values(file.functions))) {
    const fn = functions.get(contract.function.name);
    assert.ok(fn !== undefined);
    validateSemanticFunction(optimizeSemanticFunction(fn, functions), contract, functions);
  }
});

test("the machine code carries the chain as whole numbers", async () => {
  const rewritten = await emitted(ADDITION, "addMod");
  const leftAlone = await emitted(FRACTION, "addMod");

  // The chain the pass exists to shorten: the quotient of the sum by a power of
  // two is a shift of a whole number, and the multiply that scaled it into a
  // quotient is gone with it.
  assert.match(rewritten, /\bsar\s+\$0x18\b/, "the carry is shifted down by twenty-four places");
  assert.doesNotMatch(rewritten, /\bmulsd\b/, "nothing on the chain is a floating point multiply");
  assert.match(rewritten, /\bcvttsd2si\b/, "each element read is brought to a whole number once");
  // The other program is left as the source wrote it, which is what says the
  // first one was not the shape it always had: a buffer that may hold a fraction
  // is still scaled and floored.
  assert.match(leftAlone, /\bmulsd\b/, "a buffer that may hold a fraction is scaled");
  assert.doesNotMatch(leftAlone, /\bsar\s+\$0x18\b/, "and its carry is not shifted down");
});

test("a rewritten loop answers what the language answers", async () => {
  const { directory, binary } = await linked(ADDITION);
  const source = run("node", ["main.ts"], { cwd: directory, timeoutMs: 120_000 });
  const delivered = run(binary, [], { timeoutMs: 120_000 });

  assert.equal(source.code, 0, source.stderr);
  assert.equal(delivered.code, 0, delivered.stderr);
  // Each limb is the sum of the two the program wrote, less the one power of two
  // above it: 17000000 − 16777216 is 222784, and the carry it leaves makes the
  // next limb one higher.
  assert.deepEqual(delivered.stdout.trimEnd().split("\n"), ["222784", "222803", "222821", "222839"]);
  assert.equal(delivered.stdout, source.stdout);
});

test("a buffer left alone answers what the language answers", async () => {
  const { directory, binary } = await linked(FILLED_BY_CALL);
  const source = run("node", ["main.ts"], { cwd: directory, timeoutMs: 120_000 });
  const delivered = run(binary, [], { timeoutMs: 120_000 });

  assert.equal(source.code, 0, source.stderr);
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, source.stdout);
  // The halves are written into `B`, so a whole-number form of the carry would
  // answer whole limbs where the language answers halves — and this is the
  // program that says so.
  assert.match(source.stdout, /\.\d/, "the answer has a fraction in it");
});

test("the C the pass leaves a loop in computes the same numbers", () => {
  // The whole-number form of a loop is written over `int64_t` locals while the
  // arrays stay the doubles the program declared, so what the C backend writes
  // is a narrowing where the loop reads an element and the arithmetic in between.
  const c = written(ADDITION, "addMod");

  assert.match(c, /int64_t/);
  assert.doesNotMatch(c, /floor\(/);
  // The other program keeps the arithmetic the source wrote, which is what says
  // the first one was not the shape it always had.
  assert.match(written(FRACTION, "addMod"), /floor\(/);
});

test("a magnitude is not the value it is the magnitude of", async () => {
  // The whole-number form of a magnitude is the magnitude of the whole number,
  // and the whole number is the value only where the value is not below zero.
  // Nothing says that it is not: a buffer holds whatever was written into it,
  // and a negative one is a number the program wrote.
  const source = [
    "function magnitudes(o: Float64Array, a: Float64Array): void {",
    "  let carry = 0;",
    "  for (let i = 0; i < 4; i += 1) {",
    "    const v = Math.abs(a[i]);",
    "    o[i] = v + carry;",
    "    carry = v;",
    "  }",
    "}",
    "",
    "const A = new Float64Array(4);",
    "const O = new Float64Array(4);",
    "for (let i = 0; i < 4; i += 1) A[i] = -5 - i;",
    "magnitudes(O, A);",
    "for (let i = 0; i < 4; i += 1) console.log(O[i]);",
    "",
  ].join("\n");
  const { directory, binary } = await linked(source);
  const original = run("node", ["main.ts"], { cwd: directory, timeoutMs: 120_000 });
  const delivered = run(binary, [], { timeoutMs: 120_000 });

  assert.equal(original.code, 0, original.stderr);
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, original.stdout);
  assert.deepEqual(delivered.stdout.trimEnd().split("\n"), ["5", "11", "13", "15"]);
});

test("an element is read where it is read, and not above the write before it", async () => {
  // A value the whole-number form reads out of an element is the element as it
  // is where it is read. Written above the body it was the element as it was
  // before the write above it, which is another number.
  const source = [
    "function chained(o: Float64Array, a: Float64Array, b: Float64Array): void {",
    "  for (let i = 0; i < 4; i += 1) {",
    "    o[i] = a[i] + b[i];",
    "    const t = o[i] + b[i];",
    "    o[i] = t;",
    "  }",
    "}",
    "",
    "const A = new Float64Array(4);",
    "const B = new Float64Array(4);",
    "const O = new Float64Array(4);",
    "for (let i = 0; i < 4; i += 1) { A[i] = 100 + i; B[i] = 7; }",
    "chained(O, A, B);",
    "for (let i = 0; i < 4; i += 1) console.log(O[i]);",
    "",
  ].join("\n");
  const { directory, binary } = await linked(source);
  const original = run("node", ["main.ts"], { cwd: directory, timeoutMs: 120_000 });
  const delivered = run(binary, [], { timeoutMs: 120_000 });

  assert.equal(original.code, 0, original.stderr);
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, original.stdout);
  assert.deepEqual(delivered.stdout.trimEnd().split("\n"), ["114", "115", "116", "117"]);
});

test("a name that held a fraction holds it still", async () => {
  // A name the loop writes as a whole number is re-typed so that every read of
  // it is a whole number, and it may only be re-typed where it held a whole
  // number before the loop: a name that held a fraction holds it still, and a
  // fraction read as a whole number is a number the program never wrote.
  const source = [
    "function carried(o: Float64Array, a: Float64Array): void {",
    "  let x = 0.5;",
    "  console.log(x);",
    "  for (let i = 0; i < 4; i += 1) {",
    "    const sum = a[i] + 1;",
    "    o[i] = sum;",
    "    x = sum;",
    "  }",
    "  console.log(x);",
    "}",
    "",
    "const A = new Float64Array(4);",
    "const O = new Float64Array(4);",
    "for (let i = 0; i < 4; i += 1) A[i] = 9000000 + i;",
    "carried(O, A);",
    "",
  ].join("\n");
  const { directory, binary } = await linked(source);
  const original = run("node", ["main.ts"], { cwd: directory, timeoutMs: 120_000 });
  const delivered = run(binary, [], { timeoutMs: 120_000 });

  assert.equal(original.code, 0, original.stderr);
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, original.stdout);
  assert.deepEqual(delivered.stdout.trimEnd().split("\n"), ["0.5", "9000004"]);
});

test("a function the checker runs with vectors is left as the source wrote it", () => {
  // The checker builds inputs of the declared types and asks whether the
  // function answers what its contract says, and a vector is not the program's
  // buffer: it holds the values the type allows, and the whole-number form
  // answers another number for the ones that are not whole numbers. So a
  // function with a postcondition is left alone, and the loop of a function
  // without one is still the whole-number form.
  const phase = phaseOf("typescript", { "main.ts": CONTRACTED }, "main.ts");
  const checked = vectorChecked(contractsByName(phase.program.files));

  assert.deepEqual([...checked], ["sumAll"], "the function with a postcondition is the one the checker runs");

  const rewritten = bodyOf(CONTRACTED, "sumAll");
  const untouched = bodyOf(CONTRACTED, "sumAll", checked);

  assert.match(rewritten, /blaze_limb_/, "the loop is the whole-number form");
  assert.doesNotMatch(untouched, /blaze_limb_/, "the function is left as the source wrote it");
});
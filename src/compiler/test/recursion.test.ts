/**
 * What the recursion pass does to a body, and that what it does is the same
 * program.
 *
 * The pass in `semantics/recursion.ts` rewrites the semantic IR, so what needs
 * checking is the IR: the loop it leaves a tail-recursive body in, the body it
 * refuses and the reason it gives, and the numbers both arms of a rewritten body
 * answer. The numbers are checked by building the program the way a build
 * builds it — once with the pass and once without — and running both, so what
 * the loop prints is read against what the frames it replaced printed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { buildProgramDriver } from "../toolchain/driver.ts";
import { compileFunctionC } from "../toolchain/ir-c.ts";
import { buildObject } from "../toolchain/ir-machine.ts";
import { resolveProgram } from "../semantics/ir-resolve.ts";
import { resolveFunction, type FunctionContext } from "../semantics/ir-function.ts";
import { optimizeSemanticFunction, optimizeSemanticProgram } from "../semantics/optimize-ir.ts";
import { eliminateRecursion, recursionRefusal } from "../semantics/recursion.ts";
import { semanticFunctionProblems } from "../semantics/ir-validate.ts";
import { parseSemanticFunction, printSemanticFunction } from "../semantics/ir-text.ts";
import { buildStandaloneRuntime } from "../runtime/standalone.ts";
import { RUNTIME_NAME, runtimeHeaderSource } from "../runtime/abi.ts";
import { run } from "../core/process.ts";
import type { FunctionContract, TargetSpec } from "../core/types.ts";
import type { SemanticBlock, SemanticFunction, SemanticLoop, SemanticStatement } from "../core/semantic-ir.ts";
import { phaseOf } from "./phase.ts";
import { scratch } from "./scratch.ts";

const TARGET: TargetSpec = { arch: "x86_64", os: "linux", abi: "sysv", cpu: "", features: [] };

/* -------------------------------------------------------------------------- */
/* Reading a program as a build reads it                                       */
/* -------------------------------------------------------------------------- */

/**
 * The declarations of a module, with the one statement that makes the file a
 * program. A file of nothing but declarations is a library, and a library
 * offers only what it exports — and what this compiler contracts is a program,
 * so a body is what these sources are given.
 */
function library(declarations: string): string {
  return `${declarations}console.log(0);\n`;
}

/** Every contract a source declares a function with. */
function contractsOf(source: string): Record<string, FunctionContract> {
  return Object.fromEntries(Object.entries(phaseOf("typescript", { "main.ts": source }, "main.ts").program.files[0]?.functions ?? {}));
}

/** Every function a source declares, with the body the compiler resolved for it. */
function bodiesOf(source: string): Map<string, SemanticFunction> {
  const phase = phaseOf("typescript", { "main.ts": source }, "main.ts");
  const contracts = contractsOf(source);
  const context: FunctionContext = { objectNames: phase.objectNames, functions: contracts };
  return new Map(Object.entries(contracts).map(([name, contract]) => [name, resolveFunction(contract, context)]));
}

/** The body a source declares for one function, as the pass left it. */
function answered(source: string, name: string): SemanticFunction {
  const fn = structuredClone(bodiesOf(source).get(name) as SemanticFunction);
  eliminateRecursion(fn);
  return fn;
}

/* -------------------------------------------------------------------------- */
/* Reading a body back                                                         */
/* -------------------------------------------------------------------------- */

/** Every loop of a body, the outermost first, however deep it is written. */
function loopsOf(entry: SemanticBlock): readonly SemanticLoop[] {
  const loops: SemanticLoop[] = [];
  const walk = (block: SemanticBlock): void => {
    for (const statement of block.statements) {
      if (statement.k === "loop") {
        loops.push(statement.loop);
        walk(statement.loop.body);
      } else if (statement.k === "if") {
        walk(statement.then);
        if (statement.otherwise !== null) walk(statement.otherwise);
      } else if (statement.k === "block") walk(statement.body);
    }
  };
  walk(entry);
  return loops;
}

/** The one loop a body holds, which is what a rewritten body has instead of its frames. */
function onlyLoop(fn: SemanticFunction): SemanticLoop {
  const loops = loopsOf(fn.entry);
  assert.equal(loops.length, 1, "the body holds one loop");
  return loops[0] as SemanticLoop;
}

/** Whether a body still calls the function it is the body of. */
function callsItself(fn: SemanticFunction): boolean {
  return JSON.stringify(fn).includes(`"callee":"${fn.name}"`);
}

/** What each statement of a run of turns binds or writes, in the order they are written. */
function namesIn(statements: readonly SemanticStatement[]): readonly string[] {
  return statements.map((statement) => (statement.k === "let" ? statement.slot.name : statement.k === "set" ? statement.name : statement.k));
}

/* -------------------------------------------------------------------------- */
/* The shape a tail call becomes                                               */
/* -------------------------------------------------------------------------- */

const TAIL = library(
  [
    "function count(n: number, acc: number): number {",
    "  if (n <= 0) {",
    "    return acc;",
    "  }",
    "  return count(n - 1, acc * n);",
    "}",
    "",
  ].join("\n"),
);

test("a tail call becomes the loop its arguments are carried round", () => {
  const fn = answered(TAIL, "count");
  assert.equal(callsItself(fn), false, "the body no longer calls itself");

  // One loop, and it is a while: the test that ended the recursion is the test
  // the loop runs, written the other way round.
  const loop = onlyLoop(fn);
  assert.equal(loop.kind, "while");
  assert.equal(loop.header, loop.body.terminator.k === "jump" ? loop.body.terminator.target : "");
  assert.equal(loop.exit, fn.entry.id, "the loop leaves for the block it is written in");

  // The loop leaves the function holding what the base case answered, which is
  // the accumulator the last turn wrote.
  assert.equal(fn.entry.terminator.k, "return");
  assert.match(printSemanticFunction(fn), /return local\[f64\] acc/);

  // Both arguments are bound to a name of their own before either parameter is
  // written, so `acc * n` is the product of the values this turn was given and
  // not of a half-written one.
  assert.deepEqual(namesIn(loop.body.statements).slice(-4), ["blaze_arg1", "blaze_arg2", "n", "acc"]);
  assert.deepEqual(semanticFunctionProblems(fn), [], "the validator holds a rewritten body to the rules it holds any other to");
});

test("a rewritten body survives the IR text a model is handed and a person reads", () => {
  const printed = printSemanticFunction(answered(TAIL, "count"));
  const parsed = parseSemanticFunction(printed, phaseOf("typescript", { "main.ts": TAIL }, "main.ts").program);
  assert.deepEqual(semanticFunctionProblems(parsed), []);
  assert.equal(callsItself(parsed), false);
});

test("the pass runs before the rewrites that read loops", () => {
  const fn = optimizeSemanticFunction(structuredClone(bodiesOf(TAIL).get("count") as SemanticFunction));
  assert.equal(callsItself(fn), false);
  assert.equal(onlyLoop(fn).kind, "while");
});

/* -------------------------------------------------------------------------- */
/* What is refused, and why                                                     */
/* -------------------------------------------------------------------------- */

interface Refused {
  readonly about: string;
  readonly source: string;
  readonly fn: string;
  readonly why: RegExp;
}

const REFUSED: readonly Refused[] = [
  {
    about: "two calls of itself in what is handed back",
    fn: "fib",
    source: library(["function fib(n: number): number {", "  if (n <= 1) {", "    return n;", "  }", "  return fib(n - 1) + fib(n - 2);", "}", ""].join("\n")),
    why: /more than one call of itself/,
  },
  {
    about: "a subtraction, which is not a combination the loop may carry",
    fn: "down",
    source: library(["function down(n: number): number {", "  if (n <= 1) {", "    return 0;", "  }", "  return n - down(n - 1);", "}", ""].join("\n")),
    why: /not combined into a sum or a product/,
  },
  {
    about: "a base case that computes before it answers",
    fn: "computed",
    source: library(
      [
        "function computed(n: number, acc: number): number {",
        "  if (n <= 0) {",
        "    const doubled = acc * 2;",
        "    return doubled;",
        "  }",
        "  return computed(n - 1, acc + n);",
        "}",
        "",
      ].join("\n"),
    ),
    why: /computes something before it answers/,
  },
  {
    about: "a test that reads a name a turn writes",
    fn: "seen",
    source: library(
      [
        "function seen(n: number, acc: number): number {",
        "  let count = 0;",
        "  count = count + 1;",
        "  if (n <= count) {",
        "    return acc;",
        "  }",
        "  return seen(n - 1, acc + n);",
        "}",
        "",
      ].join("\n"),
    ),
    why: /reads "count", which a turn writes/,
  },
  {
    about: "a recursion with no test to end it",
    fn: "endless",
    source: library(["function endless(n: number): number {", "  return endless(n - 1);", "}", ""].join("\n")),
    why: /does not end in a test of its own/,
  },
  {
    about: "a body that ends in a call of another function",
    fn: "elsewhere",
    source: library(
      [
        "function plain(n: number): number {",
        "  return n;",
        "}",
        "",
        "function elsewhere(n: number): number {",
        "  if (n <= 0) {",
        "    return 0;",
        "  }",
        "  return plain(n);",
        "}",
        "",
      ].join("\n"),
    ),
    why: /ends in a call of another function/,
  },
  {
    // Only the accumulated shape carries the base case's answer from a name
    // bound above the loop. A tail call leaves the base case where the source
    // wrote it, so `base()` there still runs only on the call that reaches it.
    about: "a base case that answers with a call",
    fn: "tick",
    source: library(
      [
        "function base(): number {",
        "  console.log(99);",
        "  return 0;",
        "}",
        "",
        "function tick(n: number, acc: number): number {",
        "  if (n <= 0) {",
        "    return base();",
        "  }",
        "  return acc + tick(n - 1, acc + n);",
        "}",
        "",
      ].join("\n"),
    ),
    why: /the answer is carried from before the loop/,
  },
];

for (const subject of REFUSED) {
  test(`a body is left alone when it is ${subject.about}`, () => {
    const fn = structuredClone(bodiesOf(subject.source).get(subject.fn) as SemanticFunction);
    const written = printSemanticFunction(fn);
    const refusal = recursionRefusal(fn);
    assert.ok(refusal !== null, "the body is refused a loop");
    assert.match(refusal, subject.why);
    assert.equal(eliminateRecursion(fn), false);
    assert.equal(printSemanticFunction(fn), written, "a refused body is left exactly as the source wrote it");
  });
}

/* -------------------------------------------------------------------------- */
/* Effects, and a body with more than one call                                 */
/* -------------------------------------------------------------------------- */

test("a recursion with effects of its own keeps them", () => {
  const source = library(
    [
      "function walk(n: number, acc: number): number {",
      "  if (n <= 0) {",
      "    return acc;",
      "  }",
      "  console.log(`turn ${n}`);",
      "  return walk(n - 1, acc + n);",
      "}",
      "",
    ].join("\n"),
  );
  const fn = answered(source, "walk");
  assert.equal(callsItself(fn), false);
  // The print is a statement of the turn, so it is a statement of the loop, and
  // it is still the first thing a turn does — before the arguments are read and
  // before the parameters move.
  const loop = onlyLoop(fn);
  assert.equal(loop.kind, "while");
  assert.deepEqual(namesIn(loop.body.statements).slice(0, 2), ["printText", "printNewline"]);
  assert.deepEqual(namesIn(loop.body.statements).slice(-4), ["blaze_arg1", "blaze_arg2", "n", "acc"]);
});

test("a body with a second call of itself carries both", () => {
  const source = library(
    [
      "function twoWays(n: number, acc: number): number {",
      "  if (n <= 0) {",
      "    return acc;",
      "  }",
      "  if (n === 3) {",
      "    return twoWays(n - 1, acc * 100);",
      "  }",
      "  return twoWays(n - 1, acc + n);",
      "}",
      "",
    ].join("\n"),
  );
  const fn = answered(source, "twoWays");
  assert.equal(callsItself(fn), false);
  assert.deepEqual(semanticFunctionProblems(fn), []);
});

test("a body that calls another recursive body is answered one at a time", () => {
  const source = library(
    [
      "function inner(n: number, acc: number): number {",
      "  if (n <= 0) {",
      "    return acc;",
      "  }",
      "  return inner(n - 1, acc + 1);",
      "}",
      "",
      "function outer(n: number, acc: number): number {",
      "  if (n <= 0) {",
      "    return acc;",
      "  }",
      "  return outer(n - 1, inner(n, acc));",
      "}",
      "",
    ].join("\n"),
  );
  const inner = answered(source, "inner");
  const outer = answered(source, "outer");
  assert.equal(callsItself(inner), false, "the body that only calls itself is answered");
  assert.equal(callsItself(outer), false, "and so is the one that calls it at an argument");
  assert.deepEqual(semanticFunctionProblems(outer), []);
});

/* -------------------------------------------------------------------------- */
/* The same program, before and after                                          */
/* -------------------------------------------------------------------------- */

const PROGRAM = [
  "function count(n: number, acc: number): number {",
  "  if (n <= 0) {",
  "    return acc;",
  "  }",
  "  return count(n - 1, acc * n);",
  "}",
  "",
  "function countdown(n: number, acc: number): number {",
  "  if (n <= 0) {",
  "    return acc;",
  "  }",
  "  console.log(`turn ${n}`);",
  "  return countdown(n - 1, acc + n);",
  "}",
  "",
  "function twoWays(n: number, acc: number): number {",
  "  if (n <= 0) {",
  "    return acc;",
  "  }",
  "  if (n === 3) {",
  "    return twoWays(n - 1, acc * 100);",
  "  }",
  "  return twoWays(n - 1, acc + n);",
  "}",
  "",
  "function shallow(x: number): number {",
  "  if (x <= 0) {",
  "    return x;",
  "  }",
  "  let doubled = x * 2;",
  "  return shallow(x - 1) + doubled;",
  "}",
  "",
  "console.log(count(6, 1));",
  "console.log(countdown(3, 0));",
  "console.log(twoWays(5, 0));",
  "console.log(shallow(4));",
  "",
].join("\n");

/** The object every program here links against, built once. */
let runtime: Promise<string> | null = null;

/** A program written to disk, built the way a build builds it, and run. */
async function delivered(source: string, transformed: boolean): Promise<string> {
  const phase = phaseOf("typescript", { "main.ts": source }, "main.ts");
  assert.ok(phase.body !== undefined);
  const contracts = contractsOf(source);
  const context: FunctionContext = { objectNames: phase.objectNames, functions: contracts };
  const directory = await scratch("blaze-recursion-");
  await writeFile(join(directory, "main.ts"), source, "utf8");
  await writeFile(join(directory, `${RUNTIME_NAME}.h`), runtimeHeaderSource(), "utf8");
  runtime ??= buildStandaloneRuntime(await scratch("blaze-runtime-")).then((built) => built.objectPath);

  const objectPaths: string[] = [];
  for (const [name, contract] of Object.entries(contracts)) {
    const fn = resolveFunction(contract, context);
    if (transformed) optimizeSemanticFunction(fn);
    const built = await compileFunctionC({
      fn,
      contract,
      mode: "debug",
      target: TARGET,
      sourcePath: join(directory, `${name}.c`),
      objectPath: join(directory, `${name}.o`),
      includeDirectories: [directory],
    });
    objectPaths.push(built.objectPath);
  }
  const program = resolveProgram(phase.body, phase.program);
  if (transformed) optimizeSemanticProgram(program);
  const binary = await buildProgramDriver({
    mode: "debug",
    target: TARGET,
    program,
    workDirectory: directory,
    objectPaths,
    runtimeObjectPath: await runtime,
    outputPath: join(directory, "program"),
  });
  const result = await run(binary.command, [], { cwd: directory });
  assert.equal(result.code, 0, result.stderr);
  return result.stdout;
}

test("a loop answers what the frames it replaced answered", async () => {
  const before = await delivered(PROGRAM, false);
  const after = await delivered(PROGRAM, true);
  assert.equal(after, before, "the rewritten program prints what the recursive one printed");
  assert.equal(before, "720\nturn 3\nturn 2\nturn 1\n6\n903\n20\n");
});

test("the machine backend lowers the same loop", async () => {
  const fn = answered(TAIL, "count");
  assert.deepEqual(semanticFunctionProblems(fn), []);
  const contract = contractsOf(TAIL)["count"] as FunctionContract;
  const built = await buildObject({
    fn,
    contract,
    target: TARGET,
    callable: new Set(),
    objectPath: join(await scratch("blaze-recursion-machine-"), "count.o"),
  });
  assert.ok(built.textSizeBytes > 0, "the object carries the loop");
});

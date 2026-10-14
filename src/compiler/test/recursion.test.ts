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
import { eliminateMutualRecursion, eliminateMutualRecursionInProgram, eliminateRecursion, mutualRecursionRefusal, recursionRefusal } from "../semantics/recursion.ts";
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

/**
 * The body a source declares for one function, as the passes that answer a cycle
 * of bodies left it: the body it is handed is answered from the others as the
 * source wrote them, which is what a build compiles one function at a time on.
 */
function answeredCycle(source: string, name: string): SemanticFunction {
  const bodies = bodiesOf(source);
  const fn = structuredClone(bodies.get(name) as SemanticFunction);
  eliminateMutualRecursion(fn, bodies);
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
/* What a cycle of bodies becomes                                              */
/* -------------------------------------------------------------------------- */

const PARITY = library(
  [
    "function even(n: number): boolean {",
    "  if (n <= 0) {",
    "    return true;",
    "  }",
    "  return odd(n - 1);",
    "}",
    "",
    "function odd(n: number): boolean {",
    "  if (n <= 0) {",
    "    return false;",
    "  }",
    "  return even(n - 1);",
    "}",
    "",
  ].join("\n"),
);

test("a body that hands back to another body becomes one loop of both", () => {
  const bodies = bodiesOf(PARITY);
  const even = structuredClone(bodies.get("even") as SemanticFunction);
  assert.equal(eliminateMutualRecursion(even, bodies), true, "the cycle is one loop");

  // The calls between the bodies are what the loop carries, so neither of them
  // is left in it: what is left is the arguments of each call written into the
  // parameters of the body that call reaches.
  assert.equal(callsItself(even), false, "the body no longer calls itself");
  assert.equal(JSON.stringify(even).includes('"callee":"odd"'), false, "and no longer calls the body it hands back to");

  const loop = onlyLoop(even);
  assert.equal(loop.kind, "while", "the loop is the one the base case's test is written as");
  // One arm per body of the cycle, so the loop runs the turn of whichever body
  // it is on and the counter says which one that is.
  const dispatch = loop.body.statements[0];
  assert.equal(dispatch?.k, "if", "the turn of the loop is chosen by which body it is on");
  if (dispatch?.k === "if") assert.notEqual(dispatch.otherwise, null, "both bodies of the cycle are an arm of the loop");
  assert.deepEqual(semanticFunctionProblems(even), [], "the validator holds a rewritten cycle to the rules it holds any other to");
});

test("every body of a cycle is answered, whichever of them is answered first", () => {
  const bodies = [...bodiesOf(PARITY).values()].map((body) => structuredClone(body));
  assert.equal(eliminateMutualRecursionInProgram(bodies), true, "every body of the cycle is one loop");
  for (const body of bodies) {
    assert.equal(callsItself(body), false, `${body.name} no longer calls itself`);
    assert.deepEqual(semanticFunctionProblems(body), [], `${body.name} is a function the compiler may lower`);
  }
});

test("a merged cycle survives the IR text a model is handed and a person reads", () => {
  const printed = printSemanticFunction(answeredCycle(PARITY, "odd"));
  const parsed = parseSemanticFunction(printed, phaseOf("typescript", { "main.ts": PARITY }, "main.ts").program);
  assert.deepEqual(semanticFunctionProblems(parsed), []);
  assert.equal(callsItself(parsed), false);
});

test("a body that calls itself inside a cycle is still one loop", async () => {
  // `even` hands back to itself on one turn and to `odd` on the next, and the
  // cycle is the two of them rather than `even` alone: the merged loop carries
  // the call of itself the same way it carries the call of the other body.
  const source = library(
    [
      "function even(n: number): number {",
      "  if (n <= 0) {",
      "    return 0;",
      "  }",
      "  if (n === 3) {",
      "    return even(n - 1);",
      "  }",
      "  return odd(n - 1);",
      "}",
      "",
      "function odd(n: number): number {",
      "  if (n <= 0) {",
      "    return 1;",
      "  }",
      "  return even(n - 1);",
      "}",
      "",
      "console.log(even(9));",
      "console.log(even(3));",
      "console.log(odd(9));",
      "",
    ].join("\n"),
  );
  const even = answeredCycle(source, "even");
  assert.equal(callsItself(even), false, "the body no longer calls itself");
  assert.equal(JSON.stringify(even).includes('"callee":"odd"'), false, "nor the body it hands back to");
  assert.deepEqual(semanticFunctionProblems(even), []);
  assert.equal(await delivered(source, true), await delivered(source, false), "the loop answers what the frames answered");
});

test("a body that hands back to a body that hands back to nothing is left alone", () => {
  // `plain` does not hand back to `elsewhere`, so there is one recursion here
  // and not a cycle: the two bodies are two loops that call one another, and
  // only the frames between them are what the loop cannot carry.
  const source = library(
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
  );
  const bodies = bodiesOf(source);
  const fn = structuredClone(bodies.get("elsewhere") as SemanticFunction);
  const written = printSemanticFunction(fn);
  assert.equal(mutualRecursionRefusal(fn, bodies), "the body hands back to no body that hands back to it");
  assert.equal(eliminateMutualRecursion(fn, bodies), false);
  assert.equal(printSemanticFunction(fn), written, "a body in no cycle is left exactly as the source wrote it");
});

/* -------------------------------------------------------------------------- */
/* Cycles that are refused, and why                                            */
/* -------------------------------------------------------------------------- */

interface CycleRefused {
  readonly about: string;
  readonly source: string;
  readonly fn: string;
  readonly why: RegExp;
}

const CYCLE_REFUSED: readonly CycleRefused[] = [
  {
    // One loop leaves one function handing back one answer, so two bodies that
    // hand back two types are two loops with a call between them rather than one
    // loop, and the frames between them are what they are.
    about: "two bodies that hand back two types",
    fn: "count",
    source: library(
      [
        "function count(n: number): number {",
        "  if (n <= 0) {",
        "    return 0;",
        "  }",
        "  return label(n - 1);",
        "}",
        "",
        "function label(n: number): bigint {",
        "  if (n <= 0) {",
        "    return 0n;",
        "  }",
        "  return count(n - 1);",
        "}",
        "",
      ].join("\n"),
    ),
    why: /one loop leaves one function handing back one type/,
  },
  {
    // A call that is not the last thing a body does is a frame the loop cannot
    // carry: this turn is waiting for the answer of that call, and the turn the
    // call would have been is not the next turn of this loop. The other call of
    // `pong` is in tail position and is what the cycle is found through, which
    // is why the body is refused here rather than as a body in no cycle.
    about: "a call of the cycle that is not the last thing it does",
    fn: "ping",
    source: library(
      [
        "function ping(n: number): number {",
        "  if (n <= 0) {",
        "    return 0;",
        "  }",
        "  if (n === 3) {",
        "    return pong(n - 1);",
        "  }",
        "  const answer = pong(n - 1);",
        "  return answer;",
        "}",
        "",
        "function pong(n: number): number {",
        "  if (n <= 0) {",
        "    return 1;",
        "  }",
        "  return ping(n - 1);",
        "}",
        "",
      ].join("\n"),
    ),
    why: /not the last thing it does/,
  },
  {
    // The loop reads the parameters of every body of the cycle above itself,
    // before any turn wrote them, and the values it reads them on are the
    // arguments of a call that reaches the body. An argument that calls
    // something is not one of them: it would be evaluated on every call into the
    // function rather than on every turn, and a call that prints would print
    // for a body the loop never reached.
    about: "a call into the cycle made with an argument that calls",
    fn: "even",
    source: library(
      [
        "function tick(n: number): number {",
        "  return n - 1;",
        "}",
        "",
        "function even(n: number): boolean {",
        "  if (n <= 0) {",
        "    return true;",
        "  }",
        "  return odd(tick(n));",
        "}",
        "",
        "function odd(n: number): boolean {",
        "  if (n <= 0) {",
        "    return false;",
        "  }",
        "  return even(tick(n));",
        "}",
        "",
      ].join("\n"),
    ),
    why: /no call whose arguments the loop can read above itself/,
  },
];

for (const subject of CYCLE_REFUSED) {
  test(`a cycle is left alone when ${subject.about}`, () => {
    const bodies = bodiesOf(subject.source);
    const fn = structuredClone(bodies.get(subject.fn) as SemanticFunction);
    const written = printSemanticFunction(fn);
    const refusal = mutualRecursionRefusal(fn, bodies);
    assert.ok(refusal !== null, "the cycle is refused a loop");
    assert.match(refusal, subject.why);
    assert.equal(eliminateMutualRecursion(fn, bodies), false);
    assert.equal(printSemanticFunction(fn), written, "a refused cycle is left exactly as the source wrote it");
  });
}

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
    // The chain runs down the right of every node to the call of itself, and it
    // stops at a call *of itself* and at nothing else. This body makes exactly
    // one call of itself and none of them is on the chain: the chain ends in
    // `wrap`, and the call sits inside that call's arguments. Answering `wrap`
    // with the carried name and carrying the recursion off as a turn of the loop
    // deletes `wrap` and answers 3 where the program answers 153.
    about: "a chain that runs down to a call of another function",
    fn: "f",
    source: library(
      [
        "function wrap(x: bigint, y: bigint): bigint {",
        "  return x * 10n + y;",
        "}",
        "",
        "function f(n: bigint, acc: bigint): bigint {",
        "  if (n <= 0n) {",
        "    return 1n;",
        "  }",
        "  return acc + wrap(f(n - 1n, acc + 2n), 3n);",
        "}",
        "",
      ].join("\n"),
    ),
    why: /not combined into a sum or a product/,
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
  {
    // The loop runs the test before the statements of a turn, and the recursion
    // ran them before the test as well — so a statement written above the test
    // runs on the call that reaches the base case in the recursion and does not
    // in the loop. `walk` prints the depth it was entered at, so the rewritten
    // body answered a run one line shorter than the source wrote: the `enter 0`
    // was gone.
    about: "a statement before the test that ends the recursion",
    fn: "walk",
    source: library(
      [
        "function walk(n: number, acc: number): number {",
        "  console.log(`enter ${n}`);",
        "  if (n <= 0) {",
        "    return acc;",
        "  }",
        "  return walk(n - 1, acc + n);",
        "}",
        "",
      ].join("\n"),
    ),
    why: /the loop does not run it on the call that reaches the base case/,
  },
  {
    // The same hole through a name: `tick` writes what it prints, so binding it
    // is not the whole of the statement, and the call it makes is a call whether
    // it is bound or kept.
    about: "a call bound above the test that ends the recursion",
    fn: "walk",
    source: library(
      [
        "function tick(): number {",
        "  console.log(1);",
        "  return 1;",
        "}",
        "",
        "function walk(n: number, acc: number): number {",
        "  let x = tick();",
        "  if (n <= 0) {",
        "    return acc;",
        "  }",
        "  return walk(n - 1, acc + x);",
        "}",
        "",
      ].join("\n"),
    ),
    why: /the loop does not run it on the call that reaches the base case/,
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

test("a turn that only binds a name above the test still becomes the loop", () => {
  // The refusal is about what the loop leaves *out* on the call that reaches the
  // base case, and a name nothing reads there is not something. `seen` binds a
  // counter above the test, steps it below, and answers with the accumulator —
  // so the loop that drops the last turn's step changes nothing the program can
  // see, and the body is still a loop.
  const source = library(
    [
      "function seen(n: number, acc: number): number {",
      "  let count = 0;",
      "  if (n <= 0) {",
      "    return acc;",
      "  }",
      "  count = count + 1;",
      "  return seen(n - 1, acc + n);",
      "}",
      "",
    ].join("\n"),
  );
  assert.equal(callsItself(answered(source, "seen")), false, "the body becomes the loop");
});

test("a base case answering with a name a turn writes keeps its frames", () => {
  // The loop leaves the function holding what the base case answered, and it is
  // read where the base case was — after every turn has run. A name the turns
  // write holds what the last turn left there rather than what the base case
  // read, so an answer reading one is a different number: this body answers 0
  // and was rewritten to answer 5.
  const source = library(
    [
      "function clash(n: number): number {",
      "  let y = 0;",
      "  if (n <= 0) {",
      "    return y;",
      "  }",
      "  y = 5;",
      "  return clash(n - 1);",
      "}",
      "",
    ].join("\n"),
  );
  assert.equal(callsItself(answered(source, "clash")), true, "the body keeps its frames");
  assert.equal(
    recursionRefusal(bodiesOf(source).get("clash") as SemanticFunction),
    'the base case answers with "y", which a turn writes',
    "the refusal says which name the answer cannot read",
  );
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
  "function even(n: number): boolean {",
  "  if (n <= 0) {",
  "    return true;",
  "  }",
  "  return odd(n - 1);",
  "}",
  "",
  "function odd(n: number): boolean {",
  "  if (n <= 0) {",
  "    return false;",
  "  }",
  "  return even(n - 1);",
  "}",
  "",
  "function phase(n: number): number {",
  "  if (n <= 0) {",
  "    return 10;",
  "  }",
  "  console.log(`phase ${n}`);",
  "  return turn(n - 1);",
  "}",
  "",
  "function turn(n: number): number {",
  "  if (n <= 0) {",
  "    return 20;",
  "  }",
  "  console.log(`turn ${n}`);",
  "  return third(n - 1);",
  "}",
  "",
  "function third(n: number): number {",
  "  if (n <= 0) {",
  "    return 30;",
  "  }",
  "  console.log(`third ${n}`);",
  "  return phase(n - 1);",
  "}",
  "",
  "console.log(count(6, 1));",
  "console.log(countdown(3, 0));",
  "console.log(twoWays(5, 0));",
  "console.log(shallow(4));",
  "console.log(even(6));",
  "console.log(odd(6));",
  "console.log(phase(5));",
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
  // A build compiles one function at a time and hands the pass every body of the
  // program, which is what a cycle of bodies is answered from: the other bodies
  // are read as the source wrote them and left as they are.
  const bodies = new Map(Object.entries(contracts).map(([name, contract]) => [name, resolveFunction(contract, context)]));
  for (const [name, contract] of Object.entries(contracts)) {
    const fn = resolveFunction(contract, context);
    if (transformed) optimizeSemanticFunction(fn, bodies);
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
  const program = resolveProgram(phase.body, phase.program, phase.objectNames, phase.objectLayouts, phase.objectKeys);
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
  assert.equal(
    before,
    "720\nturn 3\nturn 2\nturn 1\n6\n903\n20\ntrue\nfalse\nphase 5\nturn 4\nthird 3\nphase 2\nturn 1\n30\n",
  );
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

test("the machine backend lowers the loop of a cycle of bodies", async () => {
  const fn = answeredCycle(PARITY, "even");
  assert.deepEqual(semanticFunctionProblems(fn), []);
  const contract = contractsOf(PARITY)["even"] as FunctionContract;
  const built = await buildObject({
    fn,
    contract,
    target: TARGET,
    callable: new Set(),
    objectPath: join(await scratch("blaze-recursion-cycle-machine-"), "even.o"),
  });
  assert.ok(built.textSizeBytes > 0, "the object carries the loop of both bodies");
});

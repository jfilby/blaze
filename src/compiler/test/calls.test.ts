/**
 * What the program does at each call its source wrote.
 *
 * The outline decides this once for the whole graph (see semantics/calls.ts),
 * and three things follow from the decision that a reader has to be able to
 * check: which symbols a candidate may reference, which bodies its prompt has
 * to carry, and which callee a stored object is keyed on. These tests state
 * the decision itself and the narrowing it causes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { programOf } from "./phase.ts";
import { callableSymbols } from "../toolchain/assembler.ts";
import { contractsByName, writtenOut } from "../semantics/calls.ts";
import { buildUserPrompt, type PromptRequest } from "../ai/prompt.ts";
import { unitKey, type UnitKeyInput } from "../incremental.ts";
import type { FunctionContract, ProgramContract, TargetSpec } from "../core/types.ts";

const TARGET: TargetSpec = { arch: "x86_64", os: "linux", abi: "sysv", cpu: "", features: [] };

/** The contracts of one program, with every call decided. */
function program(files: Record<string, string>, entry: string): ProgramContract {
  return programOf("typescript", files, entry);
}

/** One function of the program, which every one of these programs declares. */
function functionOf(of: ProgramContract, name: string): FunctionContract {
  const contract = of.files
    .flatMap((file) => Object.values(file.functions))
    .find((entry) => entry.function.name === name);
  assert.ok(contract !== undefined, `${name} is not a function of this program`);
  return contract;
}

/** The calls one function makes, as `callee:strategy` pairs. */
function calls(of: ProgramContract, name: string): string[] {
  return (functionOf(of, name).definition?.calls ?? []).map((edge) => `${edge.callee}:${edge.strategy}`);
}

/** A program of one caller over one callee, and the caller's call to it. */
function overCallee(callee: readonly string[], effect = "let total = 0;\n  for (let i = 0; i < n; i++) {\n    total = total + leaf(i);\n  }\n  return total;"): ProgramContract {
  return program(
    {
      "main.ts": [
        "export function leaf(n: number): number {",
        ...callee,
        "}",
        "export function report(n: number): number {",
        `  ${effect}`,
        "}",
        "console.log(`${report(3)}`);",
        "",
      ].join("\n"),
    },
    "main.ts",
  );
}

/** A program with no callee at all, so the decisions are not about a call. */
function alone(): ProgramContract {
  return program(
    {
      "main.ts": [
        "export function report(n: number): number {",
        "  let total = 0;",
        "  for (let i = 0; i < n; i++) { total = total + i; }",
        "  return total;",
        "}",
        "console.log(`${report(3)}`);",
        "",
      ].join("\n"),
    },
    "main.ts",
  );
}

test("a call is a call, because the callee is verified on its own vectors", () => {
  // `leaf` is stated as one expression, so its contract is a postcondition and
  // its body is checked against vectors. Writing it out would replace a proved
  // body with a second one only the program can see, so the call stands and
  // every caller gets whichever candidate won.
  const of = overCallee(["  return n * 2;"]);
  assert.deepEqual(calls(of, "report"), ["leaf:call"]);
  // A function that states a result is straight-line, so it calls nothing at
  // all and there is no edge to decide.
  assert.deepEqual(calls(of, "leaf"), []);
});

test("a call to a function the compiler cannot verify is written out instead", () => {
  // `leaf` branches, so it is contracted as a definition: there are no vectors
  // for it, so nothing about it is proved but by the program. Its caller would
  // stop being checked at all if it called it, and writing it out is what gives
  // the caller its own run back.
  const of = overCallee(["  if (n > 2) { return 3; }", "  return 1;"]);
  assert.deepEqual(calls(of, "report"), ["leaf:inline"]);
});

test("a recursive callee is called, however little of it there is", () => {
  const of = overCallee(["  if (n <= 0) { return 0; }", "  return leaf(n - 1);"]);
  assert.deepEqual(calls(of, "report"), ["leaf:call"]);
});

test("a callee that allocates is called, because what it returns is owned by its frame", () => {
  const of = overCallee(["  if (n > 0) { return { count: n }; }", "  return { count: 0 };"], "let total = 0;\n  for (let i = 0; i < n; i++) {\n    total = total + leaf(i).count;\n  }\n  return total;");
  assert.deepEqual(calls(of, "report"), ["leaf:call"]);
});

test("a callee that prints is called, for the same reason it allocates", () => {
  const of = overCallee(["  console.log(n);", "  return n;"], "let total = 0;\n  for (let i = 0; i < n; i++) {\n    total = total + leaf(i);\n  }\n  return total;");
  assert.deepEqual(calls(of, "report"), ["leaf:call"]);
});

test("mutual recursion is called, because neither body ends", () => {
  const of = program(
    {
      "main.ts": [
        "export function left(n: number): number {",
        "  if (n <= 0) { return 0; }",
        "  return right(n - 1);",
        "}",
        "export function right(n: number): number {",
        "  if (n <= 0) { return 0; }",
        "  return left(n - 1);",
        "}",
        "export function report(n: number): number {",
        "  let total = 0;",
        "  for (let i = 0; i < n; i++) { total = total + left(i); }",
        "  return total;",
        "}",
        "console.log(`${report(3)}`);",
        "",
      ].join("\n"),
    },
    "main.ts",
  );
  assert.deepEqual(calls(of, "report"), ["left:call"]);
  assert.deepEqual(calls(of, "left"), ["right:call"]);
});

test("a builtin is not a call the outline decides anything about", () => {
  // `Math.max` is answered by the driver, so it is not a symbol this build
  // emits and there is nothing to decide about how it is reached.
  const of = program(
    {
      "main.ts": [
        "export function report(n: number): number {",
        "  let total = 0;",
        "  for (let i = 0; i < n; i++) { total = Math.max(total, i); }",
        "  return total;",
        "}",
        "console.log(`${report(3)}`);",
        "",
      ].join("\n"),
    },
    "main.ts",
  );
  assert.deepEqual(calls(of, "report"), []);
});

test("a candidate may reference the symbols of the calls it is told to make, and no others", () => {
  const of = program(
    {
      "main.ts": [
        "export function pick(n: number): number {",
        "  if (n > 2) { return 3; }",
        "  return 1;",
        "}",
        "export function twice(n: number): number { return n * 2; }",
        "export function report(n: number): number {",
        "  let total = 0;",
        "  for (let i = 0; i < n; i++) { total = total + pick(i) + twice(i); }",
        "  return total;",
        "}",
        "console.log(`${report(3)}`);",
        "",
      ].join("\n"),
    },
    "main.ts",
  );
  const contracts = contractsByName(of.files);
  // `twice` is called, so its symbol is referenceable. `pick` is written out,
  // so its symbol is not: the body is already in the prompt, and a reference to
  // it would be a reimplementation behind a local label.
  assert.deepEqual([...callableSymbols(functionOf(of, "report"), contracts)].sort(), ["twice"]);
  // The same narrowing holds for the callee itself: `twice` is straight-line
  // and states a result, so it calls nothing and may reference nothing.
  assert.deepEqual([...callableSymbols(functionOf(of, "twice"), contracts)], []);
});

test("the prompt states a written-out callee as a body to implement rather than a symbol to call", () => {
  const of = overCallee(["  if (n > 2) { return 3; }", "  return 1;"]);
  const request: PromptRequest = {
    contract: functionOf(of, "report"),
    unit: { file: "main.ts", function: "report" },
    program: of,
    sources: [{ path: "main.ts", source: "" }],
    callees: [functionOf(of, "leaf")],
    target: TARGET,
    output: "machine",
    runtime: "none",
    candidate: 1,
    candidates: 1,
    attempt: 1,
  };
  const prompt = buildUserPrompt(request);

  // The body is carried, because a symbol the candidate may not reference is no
  // use to it on its own, and the rule that says the symbol is off limits is
  // stated beside it.
  assert.match(prompt, /WRITE OUT/);
  assert.match(prompt, /leaf\(n: f64\) -> f64/);
  // Nothing is called, so nothing is offered as callable and the candidate is
  // told it is run on its own.
  assert.doesNotMatch(prompt, /^CALLS$/m);
  assert.match(prompt, /assembled, linked and run on its own/);
});

test("the prompt offers a called callee as a symbol and does not offer its body", () => {
  const of = overCallee(["  return n * 2;"]);
  const request: PromptRequest = {
    contract: functionOf(of, "report"),
    unit: { file: "main.ts", function: "report" },
    program: of,
    sources: [{ path: "main.ts", source: "" }],
    callees: [functionOf(of, "leaf")],
    target: TARGET,
    output: "machine",
    runtime: "none",
    candidate: 1,
    candidates: 1,
    attempt: 1,
  };
  const prompt = buildUserPrompt(request);

  assert.match(prompt, /^CALLS$/m);
  assert.match(prompt, /C prototype: double leaf\(double n\)/);
  assert.match(prompt, /argument locations: n -> xmm0/);
  // The body is not carried: it is verified on its own, and a candidate that
  // wrote it out would be a second body nothing has proved.
  assert.doesNotMatch(prompt, /WRITE OUT/);
});

/** The key a build stores one function's object under. */
function keyOf(of: ProgramContract, name: string, file: string): string {
  const input: UnitKeyInput = {
    contract: functionOf(of, name),
    file,
    program: of,
    target: TARGET,
    output: "machine",
    runtime: "none",
    test: { randomCases: 0, maxLength: 0, seed: 0 },
    benchmark: { iterations: 1 },
    model: "test",
    compilerVersion: "0.0.0",
    toolchain: "test",
  };
  return unitKey(input);
}

test("a caller's stored object is keyed on the body of a callee it writes out", () => {
  // `leaf` is written out, so its body is inside the caller's object. A fix to
  // it has to invalidate the caller, or the caller keeps the body it was given
  // before the fix while the callee is rebuilt beside it.
  const before = keyOf(overCallee(["  if (n > 2) { return 3; }", "  return 1;"]), "report", "main.ts");
  const after = keyOf(overCallee(["  if (n > 2) { return 4; }", "  return 1;"]), "report", "main.ts");
  assert.notEqual(before, after);
});

test("a caller's stored object is keyed on the body of a callee it calls", () => {
  // The converse, and the reason the two tests are a pair: a callee that is
  // called by symbol is not in the caller's object, so a change to what it
  // does rebuilds it and leaves the caller reusable. Keying on every callee's
  // body would make each fix invalidate the whole program behind it.
  const before = keyOf(overCallee(["  return n * 2;"]), "report", "main.ts");
  const after = keyOf(overCallee(["  return n * 3;"]), "report", "main.ts");
  assert.equal(before, after);
});

test("what a candidate has to write out is the whole closure, not the direct callees", () => {
  const of = program(
    {
      "main.ts": [
        "export function base(n: number): number {",
        "  if (n > 2) { return 3; }",
        "  return 1;",
        "}",
        "export function middle(n: number): number {",
        "  if (n > 1) { return base(n); }",
        "  return base(n);",
        "}",
        "export function report(n: number): number {",
        "  let total = 0;",
        "  for (let i = 0; i < n; i++) { total = total + middle(i); }",
        "  return total;",
        "}",
        "console.log(`${report(3)}`);",
        "",
      ].join("\n"),
    },
    "main.ts",
  );
  assert.deepEqual(calls(of, "report"), ["middle:inline"]);
  // `middle` is written out and it calls `base`, which is written out too, so
  // the candidate needs both bodies: what lands inside its object is the whole
  // thing, and what it is given has to be the whole thing.
  const written = writtenOut(contractsByName(of.files), functionOf(of, "report")).map((contract) => contract.function.name);
  assert.deepEqual(written.sort(), ["base", "middle", "report"]);
});

test("a candidate with no calls is left with its own symbol and the runtime", () => {
  const of = alone();
  const contracts = contractsByName(of.files);
  assert.deepEqual([...callableSymbols(functionOf(of, "report"), contracts)], []);
  assert.deepEqual(writtenOut(contracts, functionOf(of, "report")).map((c) => c.function.name), ["report"]);
});

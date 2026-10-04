/**
 * The review loop, driven where a whole build cannot reach it.
 *
 * What a build makes is a program the compiler resolved from the source, and
 * that program is what the contract says it is. The rounds after the first are
 * for the cases a build does not produce on its own: an artifact the toolchain
 * rejected, and a program that printed something its source does not. Both are
 * driven here directly, with the artifact the compiler would have written
 * replaced by one the toolchain refuses, so that the loop and the hand-off it
 * makes are what is under test.
 */

import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { machine, reviewCandidates, runtimePreparer, type CodegenRequest } from "../codegen.ts";
import { parseContract } from "../semantics/contract.ts";
import { resolveFunction } from "../semantics/ir-function.ts";
import { printSemanticFunction } from "../semantics/ir-text.ts";
import { createBackend } from "../ai/backend.ts";
import { resolveModel } from "../ai/model.ts";
import { chatEndpoint, type ChatEndpoint } from "./model-endpoint.ts";
import { phaseOf, semanticsOf } from "./phase.ts";
import type { SemanticFunction } from "../core/semantic-ir.ts";
import type { FunctionContract, ProgramMismatch, SourceInput } from "../core/types.ts";
import { scratch } from "./scratch.ts";

const SOURCE = "export function square(x: number): number {\n  return x * x;\n}\n";
const SOUND = "verdict: sound\nreason: the body computes what the contract states";

const phase = phaseOf("typescript", { "main.ts": SOURCE }, "main.ts");
const semantics = semanticsOf(phase);
const contract = phase.program.files[0].functions.square as NonNullable<
  (typeof phase.program.files)[0]["functions"]["square"]
>;
const resolved = resolveFunction(contract, { objectNames: phase.objectNames, functions: {} });

/**
 * A program the compiler may lower and the vectors refuse: it doubles its
 * argument, which is a body as valid as the one the source was written as and
 * is not what the contract states.
 */
function doubling(): SemanticFunction {
  const fn = structuredClone(resolved);
  const doubled = { k: "arith" as const, type: { kind: "primitive" as const, name: "f64" as const }, op: "add" as const, left: { k: "local" as const, type: { kind: "primitive" as const, name: "f64" as const }, name: "x" }, right: { k: "local" as const, type: { kind: "primitive" as const, name: "f64" as const }, name: "x" } };
  fn.entry.statements = [
    { k: "let", slot: { kind: "value", name: "doubled", mutable: true, type: doubled.type }, value: doubled, line: 2 },
  ];
  fn.entry.terminator = { k: "return", value: { k: "local", type: doubled.type, name: "doubled" } };
  return fn;
}

/**
 * A program with a callee beside the unit under test, so `inline-call` is a
 * proposal the rules hold and a review that proposes it is applied rather than
 * refused. A body nothing can rewrite cannot show what is under test here: the
 * target review adds a candidate only when it changed something.
 */
const CALLING_FILES: Record<string, string> = {
  "main.ts": "import { work, twice } from './lib.ts';\nconsole.log(work(2));\n",
  "lib.ts": [
    "export function twice(x: number): number {",
    "  return x + x;",
    "}",
    "",
    "export function work(scale: number): number {",
    "  let total = 0;",
    "  for (let i = 0; i < 4; i += 1) {",
    "    total += i * scale;",
    "  }",
    "  return total + twice(scale);",
    "}",
    "",
  ].join("\n"),
};

const ownPhase = phaseOf("typescript", CALLING_FILES, "main.ts");
const ownSemantics = semanticsOf(ownPhase);
const ownWork = ownPhase.program.files
  .flatMap((file) => Object.entries(file.functions))
  .find(([name]) => name === "work")?.[1] as FunctionContract;
const ownContracts: Record<string, FunctionContract> = Object.fromEntries(
  ownPhase.program.files.flatMap((file) => Object.entries(file.functions)),
);
const work = resolveFunction(ownWork, { objectNames: ownPhase.objectNames, functions: ownContracts });

const TARGET = { arch: "x86_64" as const, os: "linux" as const, abi: "sysv" as const, cpu: "", features: [] };

/** A project pointed at the endpoint the test opened, with the artifact under test. */
async function request(t: TestContext, base: SemanticFunction, over: Partial<CodegenRequest> = {}): Promise<CodegenRequest> {
  const endpoint: ChatEndpoint = await chatEndpoint(t, [], { answer: () => SOUND });
  const directory = await scratch("blaze-review-loop-");
  const model = resolveModel("openai-compatible/stub", { AI_API_KEY: "test-key", AI_BASE_URL: endpoint.url });
  // The unit under test, unless the test brings its own program: a contract, the
  // phase it came from and the IR of every function beside it are one choice,
  // and a test that drives a different function drives all four.
  const unit = over.contract ?? contract;
  const own = unit === contract ? phase : ownPhase;
  return {
    contract: unit,
    parsed: over.parsed ?? parseContract(unit),
    unitFile: over.unitFile ?? (unit === contract ? "main.ts" : "lib.ts"),
    program: over.program ?? own.program,
    base,
    functions: over.functions ?? (unit === contract ? semantics : ownSemantics),
    target: TARGET,
    output: "ir",
    runtime: "none",
    backend: () => createBackend(model),
    generation: { maxCandidates: 1, maxAttempts: 2, maxRetries: 0, candidateConcurrency: 1, functionConcurrency: 1 },
    test: { randomCases: 3, maxLength: 8, seed: 1 },
    benchmark: { iterations: 10 },
    workspace: { workDirectory: directory, functionName: unit.function.name },
    existing: [],
    callable: new Set(),
    // The runtime the candidate links against, built once for the whole loop.
    prepareRuntime: runtimePreparer({
      mode: "debug",
      lowering: "c",
      runtime: "none",
      target: { arch: "x86_64", os: "linux", abi: "sysv", cpu: "", features: [] },
      workspace: { workDirectory: directory, functionName: unit.function.name },
    }),
    machine: machine(),
    // What the test overrides is what the request asks for, so it is spread
    // last: a test that brings its own output kind or lowering is not answered
    // with the default one.
    ...over,
    __endpoint: endpoint,
  } as CodegenRequest & { __endpoint: ChatEndpoint };
}

/** The endpoint a request opened, which is what recorded what the model was asked. */
function asked(t: TestContext, request: CodegenRequest): string[] {
  void t;
  const endpoint = (request as CodegenRequest & { __endpoint?: ChatEndpoint }).__endpoint;
  assert.ok(endpoint !== undefined, "the request was opened against an endpoint");
  return endpoint.prompts;
}

test("a rejected artifact is reviewed again with the diagnostic that rejected it", async (t) => {
  const looped = await request(t, doubling());

  const result = await reviewCandidates(looped);

  // Nothing can fix it: no rule in the catalogue changes what a body computes,
  // so every round is the same artifact and there is no candidate to deliver.
  // What the loop did is say so on every round, with the diagnostic the
  // toolchain earned.
  assert.equal(result.selected, null);
  assert.equal(result.outcomes.length, 2);
  assert.ok(result.outcomes.every((outcome) => !outcome.valid));
  assert.match(`${result.outcomes[0]?.failure?.message ?? ""}\n${result.outcomes[0]?.failure?.detail ?? ""}`, /test vectors did not match the contract/);
  const prompts = asked(t, looped);
  assert.equal(prompts.length, 2, "one review per round");
  assert.doesNotMatch(prompts[0] ?? "", /test vectors did not match/, "the first round has no diagnostic yet");
  assert.match(prompts[1] ?? "", /WHAT THE COMPILER ALREADY FOUND/);
  assert.match(prompts[1] ?? "", /test vectors did not match the contract/);
  assert.match(prompts[1] ?? "", /expected .* got /, "the vectors that did not match are named");
});

test("a program that printed something else is handed to the review beside what the source prints", async (t) => {
  const wrong = doubling();
  const mismatch: ProgramMismatch = { line: 1, expected: "4", actual: "3", expectedOutput: "4\n", actualOutput: "3\n" };
  const looped = await request(t, wrong, { programFailure: { mismatch, previous: printSemanticFunction(wrong) } });

  await reviewCandidates(looped);

  const prompts = asked(t, looped);
  assert.equal(prompts.length, 2);
  // The round after the mismatch is handed the artifact that produced the wrong
  // output, and both outputs beside it.
  assert.match(prompts[0] ?? "", /WHAT THE PROGRAM IT BELONGS TO PRINTED/);
  assert.match(prompts[0] ?? "", /WHAT THE SOURCE PRINTS/);
  assert.match(prompts[0] ?? "", /The outputs are the same until line 1, where they differ/);
  assert.ok((prompts[0] ?? "").includes(printSemanticFunction(wrong)), "the artifact that printed it is handed back");
});

test("a build reports its candidates in the order it numbered them, whichever finished first", async (t) => {
  // Candidates are compiled and verified alongside each other now and measured
  // one at a time, so they finish in an order the build does not choose and one
  // run of this is not the next. What the record is assembled in is the order
  // the chains were numbered in, and that is what keeps the winner a function
  // of the measurements: were the outcomes collected as they arrived, the
  // pairing of a candidate with its own duration would be a race, and two
  // builds of the same source would pick their winner differently.
  const looped = await request(t, resolved, {
    output: "machine",
    lowering: "machine",
    mode: "debug",
    generation: { maxCandidates: 3, maxAttempts: 1, maxRetries: 0, candidateConcurrency: 3, functionConcurrency: 1 },
  });

  const result = await reviewCandidates(looped);

  const ids = result.candidates.map((candidate) => candidate.id);
  const numbers = ids.map((id) => Number(id.slice(1)));
  assert.equal(ids.length, 3, "every candidate was generated");
  assert.deepEqual(numbers, [...numbers].sort((left, right) => left - right), "candidates are reported in the order they were numbered");
  assert.deepEqual(
    result.outcomes.map((outcome) => outcome.candidate),
    ids,
    "every outcome is the candidate it was measured for, and not one that finished nearer",
  );
  // The winner is the fastest of the candidates the build says it measured,
  // which is the whole of what a selection is: the same outcomes in the same
  // order give the same winner whatever order the work behind them took.
  const valid = result.outcomes.filter((outcome) => outcome.valid);
  assert.equal(valid.length, 3, "every candidate satisfied its contract");
  const fastest = [...valid].sort(
    (left, right) => (left.benchmark?.durationNs ?? Number.POSITIVE_INFINITY) - (right.benchmark?.durationNs ?? Number.POSITIVE_INFINITY),
  )[0];
  assert.equal(result.selected, fastest.candidate, "the winner is the fastest candidate in the record");
});

test("every candidate a build writes answers to a name of its own", async (t) => {
  // A candidate's id is how selection, the stored record, `blaze test` and the
  // files it is lowered into all find it, and each of those resolves it by
  // name with the first match winning. So one id standing for two
  // implementations is a build that verified one thing and delivered another.
  // The target review was numbered from the same arithmetic as a chain's
  // candidates and took the id of the last one, and a rebuild that counted the
  // stored candidates rather than reading their numbers restarted inside the
  // range they held. Both are answered by the record naming each candidate once.
  const answer = (prompt: string): string =>
    /THE TARGET CODE THE COMPILER LOWERED/.test(prompt)
      ? // The target review applying a proposal is what adds the candidate
        // whose number used to collide with a chain's.
        "verdict: repaired\nreason: the callee is a leaf\nproposal: inline-call entry callee=twice"
      : SOUND;
  const endpoint: ChatEndpoint = await chatEndpoint(t, [], { answer });
  const model = resolveModel("openai-compatible/stub", { AI_API_KEY: "test-key", AI_BASE_URL: endpoint.url });
  const generated = await request(t, work, {
    contract: ownWork,
    output: "machine",
    lowering: "machine",
    mode: "debug",
    backend: () => createBackend(model),
    generation: { maxCandidates: 1, maxAttempts: 1, maxRetries: 0, candidateConcurrency: 1, functionConcurrency: 1 },
  });

  const result = await reviewCandidates(generated);

  const ids = result.candidates.map((candidate) => candidate.id);
  assert.ok(ids.length > 1, "the target review added a candidate of its own");
  assert.equal(new Set(ids).size, ids.length, `two candidates answered to one name: ${ids.join(", ")}`);
  // Every outcome names a candidate that is in the record, and the winner is
  // one of them: an id nothing answers to is a candidate nothing can be found
  // by, and a first match on a shared one finds the wrong implementation.
  for (const outcome of result.outcomes) {
    assert.ok(ids.includes(outcome.candidate), `an outcome names ${outcome.candidate}, which is not in the record`);
  }
  assert.ok(result.selected === null || ids.includes(result.selected), `the winner ${result.selected} is not in the record`);

  // A build that regenerates from stored candidates numbers beside them rather
  // than among them, whatever the stored numbers are.
  const again = await reviewCandidates(
    await request(t, work, {
      contract: ownWork,
      output: "machine",
      lowering: "machine",
      mode: "debug",
      backend: () => createBackend(model),
      generation: { maxCandidates: 1, maxAttempts: 1, maxRetries: 0, candidateConcurrency: 1, functionConcurrency: 1 },
      existing: result.candidates,
    }),
  );
  const stored = new Set(ids);
  const fresh = again.candidates.filter((candidate) => !stored.has(candidate.id)).map((candidate) => candidate.id);
  assert.ok(
    fresh.every((id) => !stored.has(id)),
    `a regenerated candidate took a stored name: ${fresh.filter((id) => stored.has(id)).join(", ")}`,
  );
});

/** What a project of this shape is, for the record the compiler writes. */
export const REVIEW_LOOP_INPUT: SourceInput = {
  language: "typescript",
  source: SOURCE,
  entry: "square",
};


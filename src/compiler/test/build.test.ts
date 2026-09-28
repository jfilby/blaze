import assert from "node:assert/strict";
import { test } from "node:test";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBuild, runStored, inspectProject, STATE_DIRECTORY } from "../compiler.ts";
import { run } from "../core/process.ts";
import { CompilerError } from "../core/errors.ts";
import type { BuildStatus, ProgramContract, SourceInput, VerificationResult } from "../core/types.ts";
import { chatEndpoint } from "./model-endpoint.ts";
import { writeProject } from "./project.ts";
import { irOf } from "./phase.ts";

const REPLAY = new URL("./fixtures/dot-product-replay.json", import.meta.url).pathname;
const HELLO_WORLD_REPLAY = new URL("./fixtures/hello-world-replay.json", import.meta.url).pathname;
const PROTO_REPLAY = new URL("./fixtures/proto-function-replay.json", import.meta.url).pathname;
const EXAMPLE_DIRECTORY = new URL("../../examples/hello_world", import.meta.url).pathname;

const INPUT: SourceInput = {
  language: "nim",
  source: [
    "proc dotProduct(a: ptr float32, b: ptr float32, n: usize): float32 =",
    "  var acc: float32 = 0.0",
    "  for i in 0 ..< n:",
    "    acc += a[i] * b[i]",
    "  result = acc",
    "",
  ].join("\n"),
  entry: "dotProduct",
  target: { arch: "x86_64", os: "linux", abi: "sysv", cpu: "", features: [] },
  // Every kind answers in the semantic IR, so a machine build is a build of
  // the IR a model wrote, lowered into the assembly the toolchain assembles.
  output: "machine",
  generation: { maxCandidates: 1, maxAttempts: 2 },
  test: { randomCases: 6, maxLength: 64, seed: 7 },
  benchmark: { iterations: 200 },
};

/**
 * The IR the compiler resolves for the function `INPUT` compiles, which is what
 * a model is asked for and what every kind of answer is.
 */
const DOT_PRODUCT_IR = irOf("nim", { "module.nim": INPUT.source }, "module.nim", "dotProduct");

/**
 * The IR a build refuses, and why: an element of a `f32*` is a `f32`, and a
 * body that adds one to a running total cannot read one as text. Nothing about
 * it is visible until the candidate is read against the contract.
 */
const MISREAD_ELEMENT_IR = DOT_PRODUCT_IR.replace(
  "[element[f32] local[f32*] a local[f64] i]",
  "[element[text] local[f32*] a local[f64] i]",
);

/**
 * The IR a build refuses a second time, for a different reason: a call to a
 * function the program does not declare, which the text cannot name.
 */
const UNDECLARED_CALL_IR = DOT_PRODUCT_IR.replace(
  "  return local[f32] acc",
  "  return [call[f32] total [arg[f32] local[f32] acc] ownership=none retain=no]",
);

/**
 * The IR a build refuses a third time: a body that hands back text where the
 * contract states a number is not a function of that function.
 */
const TEXT_RESULT_IR = DOT_PRODUCT_IR.replace("  return local[f32] acc", "  return [to_text local[f32] acc]");

async function workspace(name: string, input: SourceInput = INPUT): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `blaze-${name}-`));
  await writeProject(join(directory, "input.toml"), input);
  return directory;
}

/**
 * The shipped example, copied into a workspace. A build delivers the program it
 * links beside the project file, so a test that builds the example builds a
 * copy: the repository is not the test's scratch directory.
 */
async function exampleWorkspace(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `blaze-${name}-`));
  const directory = join(root, "hello_world");
  await cp(EXAMPLE_DIRECTORY, directory, { recursive: true });
  // The example ships with the state of an earlier build, and what these tests
  // read is what their own build writes.
  await rm(join(directory, STATE_DIRECTORY), { recursive: true, force: true });
  return directory;
}

const quiet = { stage: () => {} };

test("a function the source named __proto__ is compiled and recorded like any other", async () => {
  // Every record of a build is keyed by whatever the source called the
  // function, and `__proto__` is a legal name: the contract phase's duplicate
  // check read the inherited accessor, so it refused a program that declares
  // the name once, and the records were assigned into rather than built, so
  // the entry never existed in them.
  const directory = await mkdtemp(join(tmpdir(), "blaze-proto-"));
  await writeProject(join(directory, "input.toml"), {
    language: "typescript",
    source: ["export function __proto__(n: bigint): bigint {", "  return n * 2n;", "}", ""].join("\n"),
    entry: "__proto__",
    target: { arch: "x86_64", os: "linux", abi: "sysv", cpu: "", features: [] },
    // The fixture this build replays answers in the IR, like every other kind.
    output: "machine",
    generation: { maxCandidates: 1, maxAttempts: 1 },
    test: { randomCases: 3, maxLength: 16, seed: 3 },
    benchmark: { iterations: 10 },
  });
  const outcome = await runBuild(
    "input.toml",
    { cwd: directory, reuse: false, model: `replay:${PROTO_REPLAY}` },
    quiet,
    "build",
  );

  assert.equal(outcome.build.status, "success");
  assert.deepEqual(Object.keys(outcome.build.selectedCandidates ?? {}), ["__proto__"]);
  for (const file of ["candidates.json", "verification.json"]) {
    const record = JSON.parse(
      await readFile(join(directory, STATE_DIRECTORY, "projects/input", file), "utf8"),
    ) as Record<string, unknown>;
    assert.deepEqual(Object.keys(record), ["__proto__"], `${file} must record the function`);
  }
});

test("a project that names a target cpu builds against it", async () => {
  // The x86 assembler takes the machine to emit for as `-march=` on its command
  // line. The cpu was written into the source as `.arch`, which is the ARM
  // pseudo-op: the x86 assembler reads it as the architecture named `x86` and
  // refused every build of a project that set a cpu, with `no such
  // architecture: 'x86'`.
  const directory = await workspace("cpu", { ...INPUT, target: { ...INPUT.target, cpu: "znver1" } });
  const outcome = await runBuild("input.toml", { cwd: directory, reuse: false, model: `replay:${REPLAY}` }, quiet, "build");
  assert.equal(outcome.build.status, "success");
  assert.equal(outcome.build.target.cpu, "znver1");

  // And a cpu the assembler does not know is still refused, and named.
  const refused = await workspace("cpu-bad", { ...INPUT, target: { ...INPUT.target, cpu: "not-a-cpu" } });
  await assert.rejects(
    runBuild("input.toml", { cwd: refused, reuse: false, model: `replay:${REPLAY}` }, quiet, "build"),
    /the assembler does not support target\.cpu "not-a-cpu"/,
  );
});

test("a build says that it resolved and validated the IR before it asked for anything", async () => {
  // The IR is a step of every build, not one a project opts into, so a reader
  // watching the output sees it happen and sees how much of it there was. A
  // postcondition is counted beside it because it is the other half of what a
  // function is: the body is implemented, the postcondition is what it is
  // checked against.
  const directory = await workspace("ir-stage");
  const log: string[] = [];
  const stages: string[] = [];
  const outcome = await runBuild(
    "input.toml",
    { cwd: directory, reuse: false, model: `replay:${REPLAY}` },
    { stage: (stage, _status, message) => { stages.push(stage); log.push(message); } },
    "build",
  );

  assert.equal(outcome.build.status, "success");
  const reported = log.find((message) => message.startsWith("Semantic IR:"));
  assert.ok(reported !== undefined, `the build reported no IR: ${log.join("\n")}`);
  assert.match(reported, /1 function\(s\) resolved and validated/);
  assert.match(reported, /1 postcondition\(s\)/);
  // It is reported before anything is generated, which is the whole of what
  // "inherent to the build" means: the IR exists whether or not it is lowered.
  assert.ok(stages.indexOf("ir") < stages.indexOf("generate"), stages.join(", "));
});

test("a build produces assembly, a native executable and a complete record", async () => {
  const directory = await workspace("build");
  const outcome = await runBuild("input.toml", { cwd: directory, reuse: false, model: `replay:${REPLAY}` }, quiet, "build");

  assert.equal(outcome.build.status, "success");
  assert.equal(outcome.build.outputKind, "machine");
  assert.deepEqual(outcome.build.selectedCandidates, { dotProduct: "c1" });
  assert.equal(outcome.outputPath, join(directory, STATE_DIRECTORY, "projects/input/output/input"));

  const program = JSON.parse(
    await readFile(join(directory, STATE_DIRECTORY, "projects/input/contract.json"), "utf8"),
  ) as ProgramContract;
  assert.deepEqual(program.entry, { file: "<inline>", function: "dotProduct" });
  assert.deepEqual(program.files[0].functions.dotProduct.ensures, ["result == sum(i = 0..<n, (a[i] * b[i]))"]);

  const verification = JSON.parse(
    await readFile(join(directory, STATE_DIRECTORY, "projects/input/verification.json"), "utf8"),
  ) as Record<string, VerificationResult[]>;
  assert.equal(verification.dotProduct.length, 1);
  assert.equal(verification.dotProduct[0].passed, true);
  assert.ok(verification.dotProduct[0].cases > 10);

  const benchmark = JSON.parse(
    await readFile(join(directory, STATE_DIRECTORY, "projects/input/benchmark.json"), "utf8"),
  ) as Record<string, { durationNs: number; iterations: number }[]>;
  assert.equal(benchmark.dotProduct[0].iterations, 200);
  assert.ok(benchmark.dotProduct[0].durationNs > 0);

  const build = await inspectProject("input", directory);
  assert.equal(build.status, "success");
  assert.match(build.sourceHash, /^[0-9a-f]{64}$/);
  assert.match(build.contractHash, /^[0-9a-f]{64}$/);
});

test("the delivered executable computes the contracted function", async () => {
  const directory = await workspace("run");
  const outcome = await runBuild("input.toml", { cwd: directory, reuse: false, model: `replay:${REPLAY}` }, quiet, "build");
  assert.ok(outcome.outputPath !== null);

  const request = ["run", "5 5 5", "1 2 3 4 5", "1 1 1 1 1", "3 3 3", "2 2 2", "2 2 2", ""].join("\n");
  const execution = run(outcome.outputPath, [], { input: request, timeoutMs: 60_000 });
  assert.equal(execution.code, 0, execution.stderr);
  assert.deepEqual(
    execution.stdout.trim().split("\n").map((line) => Number(line.split(" ")[1])),
    [15, 12],
  );
});

test("the delivered IR is the implementation that was verified, and the assembly is what it was lowered into", async () => {
  const directory = await workspace("asm");
  const outcome = await runBuild("input.toml", { cwd: directory, reuse: false, model: `replay:${REPLAY}` }, quiet, "build");
  assert.ok(outcome.outputAssemblyPath !== null);

  // Every kind answers in the IR, so what a build verified is the IR, and the
  // text it delivers beside the assembly is that IR itself and not a copy of
  // something else: what the model wrote is what the contract was checked on.
  const stored = JSON.parse(
    await readFile(join(directory, STATE_DIRECTORY, "projects/input/candidates.json"), "utf8"),
  ) as Record<string, { text: string }[]>;
  const implementation = await readFile(outcome.outputAssemblyPath.replace(/\.s$/, ".ir"), "utf8");
  assert.equal(implementation, stored.dotProduct[0].text);

  // What a machine build delivers is the assembly the toolchain made of the C
  // the compiler wrote for that IR, so the delivered text is the target the
  // object was assembled from rather than the IR itself.
  const delivered = await readFile(outcome.outputAssemblyPath, "utf8");
  assert.notEqual(delivered, implementation, "the assembly is not the IR it was lowered from");
  assert.match(delivered, /^\s*\.file\s+"c1\.lower\.c"$/m, "the assembly is the compiler's own lowering");
  assert.match(delivered, /^\s*\.globl\s+dotProduct$/m, "the assembly defines the function the IR describes");
});

test("a C build delivers the C source the compiler verified", async () => {
  const directory = await workspace("c", { ...INPUT, output: "c" });
  const replay = join(directory, "candidates.json");
  // A `c` build is answered in the IR like every other kind: the C is the text
  // the compiler wrote for it, so what a model never sees is a signature.
  await writeFile(replay, JSON.stringify({ candidates: [DOT_PRODUCT_IR] }), "utf8");

  const outcome = await runBuild("input.toml", { cwd: directory, reuse: false, model: `replay:${replay}` }, quiet, "build");
  assert.equal(outcome.build.outputKind, "c");
  assert.ok(outcome.outputPath?.endsWith("output/input.c"));

  const source = await readFile(outcome.outputPath as string, "utf8");
  assert.match(source, /float dotProduct\(float\* a, float\* b, size_t n\)/);
});

test("a rejected candidate is replaced and its diagnostic is fed back", async () => {
  const directory = await workspace("retry");
  const replay = join(directory, "candidates.json");
  await writeFile(
    replay,
    JSON.stringify({
      candidates: [MISREAD_ELEMENT_IR, DOT_PRODUCT_IR],
    }),
    "utf8",
  );

  const outcome = await runBuild(
    "input.toml",
    { cwd: directory, reuse: false, model: `replay:${replay}`, maxAttempts: 2 },
    quiet,
    "build",
  );
  assert.equal(outcome.build.status, "success");
  assert.deepEqual(outcome.build.selectedCandidates, { dotProduct: "c2" });

  const candidates = Object.values(
    JSON.parse(await readFile(join(directory, STATE_DIRECTORY, "projects/input/candidates.json"), "utf8")) as Record<
      string,
      { id: string; candidate: number; round: number; feedback?: string[] }[]
    >,
  ).flat();
  // The repair is the second attempt of the first candidate, not a new one.
  assert.deepEqual(
    candidates.map((entry) => [entry.id, entry.candidate, entry.round]),
    [["c1", 1, 1], ["c2", 1, 2]],
  );
  assert.equal(candidates[0].feedback, undefined);
  // The diagnostic is the one that refused the candidate, and it says what in
  // the IR is wrong rather than which line of a model answer it came from.
  assert.match(candidates[1].feedback?.[0] ?? "", /^\[attempt 1] ir failed: dotProduct is not a function the compiler may lower/);
  assert.match(candidates[1].feedback?.[0] ?? "", /an element of a f32\* is a f32, not a text/);
});

test("diagnostics accumulate across repairs and never reach the next candidate", async () => {
  const directory = await workspace("accumulate");
  const replay = join(directory, "candidates.json");
  // Three rejections in a row, then a working answer: the first candidate burns
  // its attempts, and the second one is generated from a clean prompt. Each
  // refusal is a different one, so the third repair is shown three reasons
  // rather than the same one three times.
  await writeFile(
    replay,
    JSON.stringify({
      candidates: [MISREAD_ELEMENT_IR, UNDECLARED_CALL_IR, TEXT_RESULT_IR, DOT_PRODUCT_IR],
    }),
    "utf8",
  );

  const outcome = await runBuild(
    "input.toml",
    { cwd: directory, reuse: false, model: `replay:${replay}`, maxAttempts: 3, maxCandidates: 2 },
    quiet,
    "build",
  );
  assert.equal(outcome.build.status, "success");
  assert.deepEqual(outcome.build.selectedCandidates, { dotProduct: "c4" });

  const candidates = Object.values(
    JSON.parse(await readFile(join(directory, STATE_DIRECTORY, "projects/input/candidates.json"), "utf8")) as Record<
      string,
      { id: string; candidate: number; round: number; feedback?: string[] }[]
    >,
  ).flat();
  assert.deepEqual(
    candidates.map((entry) => [entry.id, entry.candidate, entry.round]),
    [
      ["c1", 1, 1],
      ["c2", 1, 2],
      ["c3", 1, 3],
      ["c4", 2, 1],
    ],
  );

  // Every repair sees what this candidate already collected, oldest first.
  assert.equal(candidates[0].feedback, undefined);
  assert.equal(candidates[1].feedback?.length, 1);
  assert.match(
    candidates[1].feedback?.[0] ?? "",
    /^\[attempt 1] ir failed: dotProduct is not a function the compiler may lower.*an element of a f32\* is a f32, not a text/s,
  );
  assert.equal(candidates[2].feedback?.length, 2);
  assert.match(candidates[2].feedback?.[0] ?? "", /^\[attempt 1]/);
  assert.match(candidates[2].feedback?.[1] ?? "", /^\[attempt 2] ir failed: the IR text is not a program at line \d+/);
  assert.match(candidates[2].feedback?.[1] ?? "", /found "total"/);

  // The next candidate starts clean: candidate 1's diagnostics stay behind.
  assert.equal(candidates[3].feedback, undefined);
});

test("a build where nothing is valid fails with a record that says why", async () => {
  const directory = await workspace("fail");
  const replay = join(directory, "candidates.json");
  // The one answer a build refuses, so nothing here can be selected: the record
  // has to say so rather than leave a build that delivered nothing unexplained.
  await writeFile(replay, JSON.stringify({ candidates: [TEXT_RESULT_IR] }), "utf8");

  await assert.rejects(
    () => runBuild("input.toml", { cwd: directory, reuse: false, model: `replay:${replay}`, maxAttempts: 1 }, quiet, "build"),
    (error: unknown) => error instanceof CompilerError && /no candidate for dotProduct/.test(error.message),
  );

  const build = JSON.parse(
    await readFile(join(directory, STATE_DIRECTORY, "projects/input/build.json"), "utf8"),
  ) as BuildStatus;
  assert.equal(build.status, "failed");
  assert.equal(build.error?.category, "AiGenerationError");
});

test("reuse rebuilds from the stored implementation without asking the model", async () => {
  const directory = await workspace("reuse");
  const options = { cwd: directory, reuse: false, model: `replay:${REPLAY}` };
  const first = await runBuild("input.toml", options, quiet, "build");
  assert.equal(first.build.status, "success");

  // A model that cannot be resolved would fail if it were consulted at all.
  const reused = await runBuild(
    "input.toml",
    { cwd: directory, reuse: true, model: "openai/this-model-does-not-exist" },
    quiet,
    "build",
  );
  assert.equal(reused.build.status, "success");
  assert.deepEqual(reused.build.selectedCandidates, { dotProduct: "c1" });
  assert.deepEqual(reused.candidates, first.candidates);
});

/** The same contract, stated as a sum: the object that satisfies it is another. */
const SUM_SOURCE = INPUT.source.replace("acc += a[i] * b[i]", "acc += a[i] + b[i]");

const SUM_IR = irOf("nim", { "module.nim": SUM_SOURCE }, "module.nim", "dotProduct");

/** A replay file of its own, so a test can leave the model unable to answer. */
async function writableReplay(directory: string, fixture: string): Promise<string> {
  const replay = join(directory, "candidates.json");
  await writeFile(replay, await readFile(fixture, "utf8"));
  return replay;
}

/**
 * A program whose only function states no postcondition, which is what a
 * function that is a branch rather than an expression comes to, so the program
 * it is part of is the only oracle that has anything to say about it. It
 * reaches no other function of the program, which is what leaves a candidate
 * for it a candidate the build may call on its own.
 */
const COUNTING_PROGRAM = [
  "function down(n: number): number {",
  "  if (n <= 0) {",
  "    return 0;",
  "  }",
  "  return 1;",
  "}",
  "",
  "console.log(down(3));",
  "",
].join("\n");

/** One above zero, one at or below it, which is what counting down comes to. */
const COUNT_IR = irOf("typescript", { "1.ts": COUNTING_PROGRAM }, "1.ts", "down");

/** Answers zero wherever the source answers one, so the program prints 0 where it prints 1. */
const WRONG_COUNT_IR = COUNT_IR.replace("  return const[f64] 1", "  return const[f64] 0");

/**
 * Divides by its argument, which the contract states nothing about, so the zero
 * an input built from the contract carries is a legal one and the candidate
 * divides by it. It is the IR the source resolves to with the guard the source
 * wrote dropped: a candidate that divided after the guard would answer the
 * probe's zero with the source's own answer and never divide at all, and the
 * defect this is here for is a division the probe is the first thing to reach.
 * Nothing about it is visible to a static check: the IR is a function of the
 * contract and the division is well formed. This is the class of defect the
 * program round is the only oracle for, and the one faulting a single call is
 * there to catch early.
 */
const DIVIDING_COUNT_IR = [
  COUNT_IR.slice(0, COUNT_IR.indexOf("  block entry: releases[]")),
  "  block entry: releases[]",
  "  return [div[i32] const[i32] 7 local[f64] n]",
  "",
].join("\n");

test("reuse refuses to rebuild a function whose contract changed", async () => {
  const directory = await workspace("changed");
  await runBuild("input.toml", { cwd: directory, reuse: false, model: `replay:${REPLAY}` }, quiet, "build");
  await writeProject(join(directory, "input.toml"), { ...INPUT, source: SUM_SOURCE });

  await assert.rejects(
    () => runBuild("input.toml", { cwd: directory, reuse: true, model: `replay:${REPLAY}` }, quiet, "build"),
    /the stored implementation of dotProduct was built from different inputs/,
  );
});

test("a function whose contract changed is generated again", async () => {
  const directory = await workspace("incremental-changed");
  const replay = await writableReplay(directory, REPLAY);
  await runBuild("input.toml", { cwd: directory, reuse: false, model: `replay:${replay}` }, quiet, "build");

  // The contract now states a sum rather than a product, so the object that
  // satisfied the old one cannot satisfy this one, and the model is asked.
  await writeProject(join(directory, "input.toml"), { ...INPUT, source: SUM_SOURCE });
  await writeFile(replay, JSON.stringify({ candidates: [SUM_IR] }), "utf8");
  const second = await runBuild("input.toml", { cwd: directory, reuse: false, model: `replay:${replay}` }, quiet, "build");

  assert.equal(second.build.status, "success");
  assert.deepEqual(second.build.reused, {});
  assert.ok((second.verification.dotProduct?.[0]?.cases ?? 0) > 0);
});

test("a build reuses a function it already proved, and asks no model for it", async () => {
  const directory = await workspace("incremental");
  const replay = await writableReplay(directory, REPLAY);
  const first = await runBuild("input.toml", { cwd: directory, reuse: false, model: `replay:${replay}` }, quiet, "build");
  assert.equal(first.build.status, "success");

  // The model is left able to answer nothing at all: a build that reuses every
  // function it needs never reaches it.
  await writeFile(replay, JSON.stringify({ candidates: ["not the IR at all"] }), "utf8");
  const second = await runBuild("input.toml", { cwd: directory, reuse: false, model: `replay:${replay}` }, quiet, "build");

  assert.equal(second.build.status, "success");
  assert.deepEqual(second.build.reused, { dotProduct: "c1" });
  assert.deepEqual(second.build.selectedCandidates, first.build.selectedCandidates);
});

test("a change that leaves a contract alone does not rebuild the function", async () => {
  const directory = await workspace("incremental-comment");
  const replay = await writableReplay(directory, REPLAY);
  await runBuild("input.toml", { cwd: directory, reuse: false, model: `replay:${replay}` }, quiet, "build");

  // A comment is not part of what the function is contracted to do, so the
  // object that was verified is still the object this build links.
  await writeProject(join(directory, "input.toml"), { ...INPUT, source: `${INPUT.source}# a comment\n` });
  await writeFile(replay, JSON.stringify({ candidates: ["not the IR at all"] }), "utf8");
  const second = await runBuild("input.toml", { cwd: directory, reuse: false, model: `replay:${replay}` }, quiet, "build");

  assert.equal(second.build.status, "success");
  assert.deepEqual(second.build.reused, { dotProduct: "c1" });
});

test("a stored implementation whose files are gone is rebuilt from it, without a model", async () => {
  const directory = await workspace("incremental-partial");
  const replay = await writableReplay(directory, REPLAY);
  await runBuild("input.toml", { cwd: directory, reuse: false, model: `replay:${replay}` }, quiet, "build");

  await rm(join(directory, STATE_DIRECTORY, "projects/input/work"), { recursive: true, force: true });
  await writeFile(replay, JSON.stringify({ candidates: ["not the IR at all"] }), "utf8");
  const log: string[] = [];
  const second = await runBuild(
    "input.toml",
    { cwd: directory, reuse: false, model: `replay:${replay}` },
    { stage: (_stage, _status, message) => log.push(message) },
    "build",
  );

  // The object is gone, so the stored implementation is assembled and verified
  // again, which is what it takes to deliver it: the model is still not asked.
  assert.equal(second.build.status, "success");
  assert.deepEqual(second.build.reused, {});
  assert.ok(log.some((message) => /is rebuilt from its stored implementation/.test(message)), log.join("\n"));
  assert.ok(second.outputPath !== null);
  assert.equal(run(second.outputPath, [], { input: "run\n5 5 5\n1 2 3 4 5\n1 1 1 1 1\n3 3 3\n2 2 2\n2 2 2\n", timeoutMs: 60_000 }).code, 0);
});

/** A program project built from recorded candidates, with the generation limits the test needs. */
async function countedProject(name: string, answers: string[], maxCandidates: number): Promise<string> {
  const directory = await programProject(name, COUNTING_PROGRAM, answers[0]);
  await writeProject(join(directory, "input.toml"), {
    ...INPUT,
    language: "typescript",
    entry: "",
    source: COUNTING_PROGRAM,
    generation: { maxCandidates, maxAttempts: 1 },
  });
  await writeFile(join(directory, "candidates.json"), JSON.stringify({ candidates: answers }), "utf8");
  return directory;
}

test("a definition candidate that faults on the call is rejected before it is selected", async () => {
  const directory = await countedProject("faulting", [DIVIDING_COUNT_IR], 1);
  // The fault is attributed to the function and to the candidate that caused
  // it, which is what lets a repair round regenerate one function rather than
  // every definition in the program.
  const failure = await runBuild(
    "input.toml",
    { cwd: directory, reuse: false, model: `replay:${join(directory, "candidates.json")}` },
    quiet,
    "build",
  ).then(
    () => { throw new Error("a candidate that faults must not be selected"); },
    (error: CompilerError) => error,
  );
  assert.match(`${failure.message}\n${failure.detail ?? ""}`, /c1: VerificationError candidate c1: down liveness check failed: the candidate was killed by SIGFPE/);
  // The diagnostic says the call was made and the result not read, so a model
  // reading it is not told the probe judged what the function computes.
  assert.match(failure.detail ?? "", /the result was not read, so this says nothing about what it computes/);
});

test("a candidate that faults is not selected over one that runs", async () => {
  const directory = await countedProject("one-good", [DIVIDING_COUNT_IR, COUNT_IR], 2);
  const outcome = await runBuild(
    "input.toml",
    { cwd: directory, reuse: false, model: `replay:${join(directory, "candidates.json")}` },
    quiet,
    "build",
  );

  assert.equal(outcome.build.status, "success");
  assert.deepEqual(outcome.build.selectedCandidates, { down: "c2" });

  const generation = JSON.parse(
    await readFile(join(directory, STATE_DIRECTORY, "projects/input/generation.json"), "utf8"),
  ) as { functions: Record<string, { outcomes: { candidate: string; valid: boolean; failure?: { message: string } }[] }> };
  const [first] = generation.functions.down.outcomes;
  assert.equal(first.valid, false);
  assert.match(first.failure?.message ?? "", /candidate c1: down liveness check failed/);
});

test("a function the program never agreed with is not reused", async () => {
  const directory = await programProject("unproved", COUNTING_PROGRAM, WRONG_COUNT_IR);
  const replay = join(directory, "candidates.json");
  await assert.rejects(
    () => runBuild("input.toml", { cwd: directory, reuse: false, model: `replay:${replay}`, maxAttempts: 1 }, quiet, "build"),
    /the program does not print what the source prints|the program stopped/,
  );

  // The program is what proves a function it is the only oracle for, so an
  // implementation the program rejected is regenerated rather than reused.
  await writeFile(replay, JSON.stringify({ candidates: [COUNT_IR] }), "utf8");
  const outcome = await runBuild(
    "input.toml",
    { cwd: directory, reuse: false, model: `replay:${replay}`, maxAttempts: 1 },
    quiet,
    "build",
  );
  assert.equal(outcome.build.status, "success");
  assert.deepEqual(outcome.build.reused, {});
});

test("test and benchmark re-run against the selected candidate", async () => {
  const directory = await workspace("stored");
  await runBuild("input.toml", { cwd: directory, reuse: false, model: `replay:${REPLAY}` }, quiet, "build");
  const options = { cwd: directory, reuse: false, model: `replay:${REPLAY}` };

  const verified = await runStored("input", options, quiet, "test");
  assert.equal(verified.functions.dotProduct.candidate, "c1");
  assert.equal(verified.functions.dotProduct.verification?.passed, true);
  assert.ok((verified.functions.dotProduct.verification?.cases ?? 0) > 0);

  const measured = await runStored("input", options, quiet, "benchmark");
  assert.ok((measured.functions.dotProduct.benchmark?.durationNs ?? 0) > 0);
  assert.equal(measured.functions.dotProduct.benchmark?.iterations, 200);
});

test("the shipped TypeScript example builds into a program that prints what it claims", async () => {
  const directory = await exampleWorkspace("example");
  const outcome = await runBuild(
    join(directory, "blaze.toml"),
    { cwd: directory, reuse: false, model: `replay:${HELLO_WORLD_REPLAY}`, maxAttempts: 1 },
    quiet,
    "build",
  );

  assert.equal(outcome.project, "hello_world");
  assert.equal(outcome.build.status, "success");
  assert.deepEqual(outcome.contracts.dotProduct.function.params, [
    { name: "a", type: "slice<f64>" },
    { name: "b", type: "slice<f64>" },
    { name: "n", type: "f64" },
  ]);
  // The entry module is a program, so what it prints is what it is checked on,
  // and the function it calls is the one the build compiles.
  assert.equal(outcome.body?.file, "main.ts");
  assert.deepEqual(Object.keys(outcome.build.selectedCandidates ?? {}), ["dotProduct"]);

  assert.ok(outcome.outputPath !== null);
  const execution = run(outcome.outputPath, [], { timeoutMs: 60_000 });
  assert.equal(execution.code, 0, execution.stderr);
  assert.equal(execution.stdout, "starting: dot product of 4 elements\ndone: dot product = 70\n");
});

/**
 * A program is delivered twice: the store keeps the copy the build record
 * names, and the project directory gets the binary beside the sources, named
 * after the project. Both are named the way the platform names an executable,
 * so a build on Linux writes no `.exe` at all.
 */
test("a program is delivered to the project directory under the platform's name", async () => {
  const directory = await exampleWorkspace("deliver");

  const suffix = process.platform === "win32" ? ".exe" : "";
  const outcome = await runBuild(
    join(directory, "blaze.toml"),
    { cwd: directory, reuse: false, model: `replay:${HELLO_WORLD_REPLAY}`, maxAttempts: 1 },
    quiet,
    "build",
  );

  // The store keeps its own copy, which is what `blaze test` re-runs.
  assert.equal(outcome.outputPath, join(directory, STATE_DIRECTORY, "projects/hello_world/output/hello_world"));
  const delivered = join(directory, `hello_world${suffix}`);
  const execution = run(delivered, [], { timeoutMs: 60_000 });
  assert.equal(execution.code, 0, execution.stderr);
  assert.equal(execution.stdout, "starting: dot product of 4 elements\ndone: dot product = 70\n");

  const work = join(directory, STATE_DIRECTORY, "projects/hello_world/work");
  const written = await readdir(work);
  assert.ok(written.includes(`program${suffix}`), "the linked program is named for the platform");
  const foreign = suffix === "" ? ".exe" : "";
  assert.deepEqual(
    written.filter((name) => name.endsWith(foreign)),
    [],
    "no artifact carries another platform's executable suffix",
  );
});

/**
 * A program whose only compiled function reads an object. A reference is not
 * something the harness protocol can pass, so there is no vector to plan and
 * nothing to compare: the program is what checks that the function works.
 */
const REFERENCE_PROGRAM = [
  "function depth(node: any): number {",
  "  if (node.left) {",
  "    return 1;",
  "  }",
  "  return 0;",
  "}",
  "",
  'console.log("a program holds no references, so depth is linked, not called");',
  "",
].join("\n");

const DEPTH_IR = irOf("typescript", { "1.ts": REFERENCE_PROGRAM }, "1.ts", "depth");

/** A program project, compiled by recorded candidates rather than by a model. */
async function programProject(name: string, source: string, answer: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `blaze-${name}-`));
  await writeProject(join(directory, "input.toml"), { ...INPUT, language: "typescript", entry: "", source });
  await writeFile(join(directory, "candidates.json"), JSON.stringify({ candidates: [answer] }), "utf8");
  return directory;
}

test("a program whose function takes a reference is built, because the program is what checks it", async () => {
  const directory = await programProject("reference", REFERENCE_PROGRAM, DEPTH_IR);
  const outcome = await runBuild(
    "input.toml",
    { cwd: directory, reuse: false, model: `replay:${join(directory, "candidates.json")}`, maxAttempts: 1 },
    quiet,
    "build",
  );

  assert.equal(outcome.build.status, "success");
  assert.deepEqual(outcome.contracts.depth.function.params, [{ name: "node", type: "ref<any>" }]);
  assert.deepEqual(outcome.build.selectedCandidates, { depth: "c1" });

  assert.ok(outcome.outputPath !== null);
  const execution = run(outcome.outputPath, [], { timeoutMs: 60_000 });
  assert.equal(execution.code, 0, execution.stderr);
  assert.equal(execution.stdout, "a program holds no references, so depth is linked, not called\n");
});

/**
 * A program of two functions, one of which the other calls. The caller cannot
 * be verified on its own: the object it needs is the callee's, and which
 * candidate of the callee it is has not been settled when the caller is built.
 * So the call is linked by the program, and the program is what says whether
 * the two agree.
 */
const CALLING_PROGRAM = [
  "function twice(n: number): number {",
  "  return n * 2;",
  "}",
  "",
  "function main(): void {",
  "  console.log(twice(21));",
  "}",
  "",
  "main();",
  "",
].join("\n");

/** The callee: returns its argument doubled, as the source says. */
const TWICE_IR = irOf("typescript", { "main.ts": CALLING_PROGRAM }, "main.ts", "twice");

/** The caller: prints what the callee returns, rather than computing it again. */
const MAIN_CALLS_TWICE_IR = irOf("typescript", { "main.ts": CALLING_PROGRAM }, "main.ts", "main");

/**
 * A two-function program project, answered per function rather than per
 * request: the two are generated at the same time, so which answer a request
 * gets is decided by the function the prompt is for.
 */
async function callingProject(
  name: string,
  caller: string,
): Promise<{ directory: string; answer: (prompt: string) => string }> {
  const directory = await mkdtemp(join(tmpdir(), `blaze-${name}-`));
  await writeFile(join(directory, "main.ts"), CALLING_PROGRAM, "utf8");
  await writeProject(join(directory, "blaze.toml"), {
    language: "typescript",
    sourceFile: "main.ts",
    model: { provider: "openai-compatible", model: "stub" },
    output: "machine",
    generation: { maxCandidates: 1, maxAttempts: 1 },
  });
  return { directory, answer: (prompt: string) => (prompt.includes("function being written: main") ? caller : TWICE_IR) };
}

test("a function that calls another function of the program is built and checked by it", async (t) => {
  const { directory, answer } = await callingProject("calls-sibling", MAIN_CALLS_TWICE_IR);
  await chatEndpoint(t, [], { answer });

  const outcome = await runBuild(
    "blaze.toml",
    { cwd: directory, reuse: false, model: "openai-compatible/stub" },
    quiet,
    "build",
  );

  assert.equal(outcome.build.status, "success");
  assert.deepEqual(Object.keys(outcome.contracts).sort(), ["main", "twice"]);

  assert.ok(outcome.outputPath !== null);
  const execution = run(outcome.outputPath, [], { timeoutMs: 60_000 });
  assert.equal(execution.code, 0, execution.stderr);
  assert.equal(execution.stdout, "42\n");

  // The caller is not probed and carries no vector: the object it calls is the
  // callee's, so the program is the only thing that can run it. What proved it
  // is that the program printed what the source prints.
  const generation = JSON.parse(
    await readFile(join(directory, STATE_DIRECTORY, `projects/${outcome.project}/generation.json`), "utf8"),
  ) as {
    functions: Record<
      string,
      { outcomes: { probe?: { called: boolean; reason: string | null }; verification?: unknown }[] }
    >;
  };
  const [mainOutcome] = generation.functions.main.outcomes;
  assert.equal(mainOutcome.probe?.called, false);
  assert.match(mainOutcome.probe?.reason ?? "", /it calls twice, so the program it belongs to is what runs it/);
  // The callee is a function of its own contract, so it is still verified and
  // measured on its own vectors: being called does not cost it that.
  const [twiceOutcome] = generation.functions.twice.outcomes;
  assert.equal(twiceOutcome.probe, undefined);
  assert.notEqual(twiceOutcome.verification, undefined);
});

test("a function that calls another function wrongly is rejected by the program", async (t) => {
  // The caller doubles what the callee already doubled, so the program prints
  // 84 where the source prints 42. Nothing is wrong with the candidate on its
  // own, and the program is the only thing that can see it.
  const wrong = MAIN_CALLS_TWICE_IR.replace(
    "print_number [call[f64] twice [arg[f64] const[f64] 21] ownership=none retain=no] @6",
    "print_number [add[f64] [call[f64] twice [arg[f64] const[f64] 21] ownership=none retain=no] const[f64] 42] @6",
  );
  const { directory, answer } = await callingProject("wrong-call", wrong);
  await chatEndpoint(t, [], { answer });

  const failure = await runBuild(
    "blaze.toml",
    { cwd: directory, reuse: false, model: "openai-compatible/stub" },
    quiet,
    "build",
  ).then(
    () => { throw new Error("a program that prints the wrong thing must not be delivered"); },
    (error: CompilerError) => error,
  );
  assert.match(`${failure.message}\n${failure.detail ?? ""}`, /the program prints "84"/);
});

/**
 * A program of two functions where the call is one the outline writes out.
 *
 * `step` branches, so its contract states what it does and there are no
 * vectors to check it against: nothing about it is proved but by the program.
 * It allocates nothing, prints nothing, reads no arguments and reaches
 * nothing, so writing it out is what the outline decides, and `report` is
 * written as the body rather than as a call to `step`.
 */
const WRITTEN_OUT_PROGRAM = [
  "function step(n: number): number {",
  "  if (n > 2) {",
  "    return 3;",
  "  }",
  "  return 1;",
  "}",
  "",
  "function main(): void {",
  "  console.log(step(3));",
  "}",
  "",
  "main();",
  "",
].join("\n");

/** The callee: three above two, and one at or below it. */
const STEP_IR = irOf("typescript", { "main.ts": WRITTEN_OUT_PROGRAM }, "main.ts", "step");

/** The caller as the source writes it: a call to the callee it was told to write out. */
const MAIN_CALLS_STEP_IR = irOf("typescript", { "main.ts": WRITTEN_OUT_PROGRAM }, "main.ts", "main");

/**
 * The same program with the callee's own body written into the caller, which is
 * what the outline asks for: the IR the compiler resolves for a caller that
 * computes `step(3)` itself is the answer a candidate that writes the call out
 * is written from, so it is resolved rather than written by hand here. Its line
 * numbers are that program's, which is nothing the contract reads.
 */
const WRITTEN_OUT_MAIN_PROGRAM = [
  "function step(n: number): number {",
  "  if (n > 2) {",
  "    return 3;",
  "  }",
  "  return 1;",
  "}",
  "",
  "function main(): void {",
  "  const n = 3;",
  "  if (n > 2) {",
  "    console.log(3);",
  "  } else {",
  "    console.log(1);",
  "  }",
  "}",
  "",
  "main();",
  "",
].join("\n");

/**
 * The caller: it writes out what `step` does rather than calling it, so it
 * declares no call for it, references no other symbol of the program and is
 * linked and probed on its own. The branch is the callee's own, so the program
 * is what says whether the copy agrees with it.
 */
const MAIN_WRITES_STEP_IR = irOf("typescript", { "main.ts": WRITTEN_OUT_MAIN_PROGRAM }, "main.ts", "main");

/**
 * A two-function program project answered per function rather than per request:
 * the two are generated at the same time, so which answer a request gets is
 * decided by the function the prompt is for.
 */
async function writtenOutProject(
  name: string,
  source: string,
  caller: string,
  callee: string,
): Promise<{ directory: string; answer: (prompt: string) => string }> {
  const directory = await mkdtemp(join(tmpdir(), `blaze-${name}-`));
  await writeFile(join(directory, "main.ts"), source, "utf8");
  await writeProject(join(directory, "blaze.toml"), {
    language: "typescript",
    sourceFile: "main.ts",
    model: { provider: "openai-compatible", model: "stub" },
    output: "machine",
    generation: { maxCandidates: 1, maxAttempts: 1 },
  });
  return {
    directory,
    answer: (prompt: string) => (prompt.includes("function being written: main") ? caller : callee),
  };
}

test("a caller the outline tells to write a callee out is checked on its own", async (t) => {
  const { directory, answer } = await writtenOutProject("writes-out", WRITTEN_OUT_PROGRAM, MAIN_WRITES_STEP_IR, STEP_IR);
  await chatEndpoint(t, [], { answer });

  const outcome = await runBuild(
    "blaze.toml",
    { cwd: directory, reuse: false, model: "openai-compatible/stub" },
    quiet,
    "build",
  );

  assert.equal(outcome.build.status, "success");
  assert.deepEqual(Object.keys(outcome.contracts).sort(), ["main", "step"]);
  assert.ok(outcome.outputPath !== null);
  assert.equal(run(outcome.outputPath, [], { timeoutMs: 60_000 }).stdout, "3\n");

  // The whole point of writing the call out: the caller declares no call for
  // the callee and references no other symbol of the program, so it is linked
  // on its own and probed. A candidate that declared the call would be carried
  // to the program round instead, with no run and no fault of its own.
  const generation = JSON.parse(
    await readFile(join(directory, STATE_DIRECTORY, `projects/${outcome.project}/generation.json`), "utf8"),
  ) as { functions: Record<string, { outcomes: { probe?: { called: boolean; reason: string | null } }[] }> };
  const [mainOutcome] = generation.functions.main.outcomes;
  assert.notEqual(mainOutcome.probe, undefined);
  assert.equal(mainOutcome.probe?.called, true);
});

test("a candidate that calls a callee it was told to write out is rejected", async (t) => {
  // The candidate declares the call the outline refused it, so the program is
  // linked without the callee it was told to write out and the linker turns the
  // reference away: the body was already in its prompt, so reaching for the
  // symbol is a reimplementation behind a call.
  const { directory, answer } = await writtenOutProject("calls-refused", WRITTEN_OUT_PROGRAM, MAIN_CALLS_STEP_IR, STEP_IR);
  await chatEndpoint(t, [], { answer });

  const failure = await runBuild(
    "blaze.toml",
    { cwd: directory, reuse: false, model: "openai-compatible/stub" },
    quiet,
    "build",
  ).then(
    () => { throw new Error("a candidate that calls a callee it was told to write out must not be delivered"); },
    (error: CompilerError) => error,
  );
  assert.match(`${failure.message}\n${failure.detail ?? ""}`, /undefined reference to `step'/);
});

/**
 * A three-function program where the body `main` writes out is itself a caller:
 * `main` writes out `step`, and `step` calls `twice`.
 */
const TRANSITIVE_PROGRAM = [
  "function twice(n: number): number {",
  "  return n * 2;",
  "}",
  "",
  "function step(n: number): number {",
  "  if (n > 2) {",
  "    return twice(n);",
  "  }",
  "  return twice(n);",
  "}",
  "",
  "function main(): void {",
  "  console.log(step(3));",
  "}",
  "",
  "main();",
  "",
].join("\n");

/**
 * The caller: it writes out what `step` does, and what `step` does is call
 * `twice`. That call is `main`'s to make, so `twice` has to be a symbol this
 * candidate may reference; before it was one, the candidate that named it was
 * rejected and the build failed on a program it should deliver. A candidate
 * handed a callee's body to write out may name the call that body makes, so
 * `twice` is a call this candidate may declare even though the source's own
 * `main` never names it. The answer is the IR the source resolves to with the
 * call in the header changed to the one the written-out body makes, and the
 * body making it: `step(3)` is `twice(3)`.
 */
const MAIN_WRITES_TRANSITIVE_IR = irOf("typescript", { "main.ts": TRANSITIVE_PROGRAM }, "main.ts", "main")
  .replace("  call step\n", "  call twice\n")
  .replace(
    "print_number [call[f64] step [arg[f64] const[f64] 3] ownership=none retain=no] @13",
    "print_number [call[f64] twice [arg[f64] const[f64] 3] ownership=none retain=no] @13",
  );

/** `step` on its own: still a call to `twice`, and still its own object. */
const STEP_TRANSITIVE_IR = irOf("typescript", { "main.ts": TRANSITIVE_PROGRAM }, "main.ts", "step");

/** The callee of both, which the program records as reachable from either. */
const TWICE_TRANSITIVE_IR = irOf("typescript", { "main.ts": TRANSITIVE_PROGRAM }, "main.ts", "twice");

test("a call inside a body the outline tells a candidate to write out is a call it may make", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "blaze-writes-transitive-"));
  await writeFile(join(directory, "main.ts"), TRANSITIVE_PROGRAM, "utf8");
  await writeProject(join(directory, "blaze.toml"), {
    language: "typescript",
    sourceFile: "main.ts",
    model: { provider: "openai-compatible", model: "stub" },
    output: "machine",
    generation: { maxCandidates: 1, maxAttempts: 1 },
  });
  await chatEndpoint(t, [], {
    answer: (prompt: string) =>
      prompt.includes("function being written: main")
        ? MAIN_WRITES_TRANSITIVE_IR
        : prompt.includes("function being written: step")
          ? STEP_TRANSITIVE_IR
          : TWICE_TRANSITIVE_IR,
  });

  const outcome = await runBuild(
    "blaze.toml",
    { cwd: directory, reuse: false, model: "openai-compatible/stub" },
    quiet,
    "build",
  );

  // `step(3)` is 6: the branch takes the `n > 2` arm, and `twice(3)` doubles it.
  assert.equal(outcome.build.status, "success");
  assert.deepEqual(Object.keys(outcome.contracts).sort(), ["main", "step", "twice"]);
  assert.ok(outcome.outputPath !== null);
  assert.equal(run(outcome.outputPath, [], { timeoutMs: 60_000 }).stdout, "6\n");
});

test("a program entry is accepted under the symbol its contract names, not under its function name", async () => {
  const source = ["function main(): number {", "  return 40 + 2;", "}", "", "main();", 'console.log(`answer: ${42}`);', ""].join("\n");
  // The entry is written under the symbol its contract names, so the IR a
  // candidate answers with is headed `main as blaze_main`.
  const answer = irOf("typescript", { "module.ts": source }, "module.ts", "main");
  assert.match(answer, /^function main as blaze_main\(\) -> f64$/m);
  const directory = await programProject("entry-symbol", source, answer);
  const outcome = await runBuild(
    "input.toml",
    { cwd: directory, reuse: false, model: `replay:${join(directory, "candidates.json")}`, maxAttempts: 1 },
    quiet,
    "build",
  );

  assert.equal(outcome.build.status, "success");
  assert.equal(outcome.contracts.main.function.symbol, "blaze_main");
  // The entry of a program is compiled under the symbol the contract gives it,
  // so a candidate that defines that symbol is the one that was asked for.
  assert.ok((outcome.verification.main?.[0]?.cases ?? 0) > 0);
  assert.deepEqual(outcome.build.selectedCandidates, { main: "c1" });

  assert.ok(outcome.outputPath !== null);
  const execution = run(outcome.outputPath, [], { timeoutMs: 60_000 });
  assert.equal(execution.code, 0, execution.stderr);
  assert.equal(execution.stdout, "answer: 42\n");
});

/**
 * Runs a program with a real terminal on its standard input and output, which
 * is what a bare `./binary` gives it. The output is drained until the terminal
 * is closed, so every line the program wrote is seen.
 */
function runOnTerminal(command: string, timeoutMs = 30_000): { code: number | null; output: string } {
  const driver = `
import os, pty, select, subprocess, sys
master, slave = pty.openpty()
program = subprocess.Popen([${JSON.stringify(command)}], stdin=slave, stdout=slave, stderr=slave, close_fds=True)
os.close(slave)
chunks = []
while True:
    ready, _, _ = select.select([master], [], [], ${timeoutMs / 1000})
    if not ready:
        break
    try:
        data = os.read(master, 4096)
    except OSError:
        break
    if not data:
        break
    chunks.append(data)
program.wait()
sys.stdout.write(b"".join(chunks).decode("utf8", "replace"))
sys.exit(program.returncode)
`;
  const result = run("python3", ["-c", driver], { timeoutMs });
  return { code: result.code, output: result.stdout };
}

test("a delivered program started on a terminal runs and exits instead of hanging", async (t) => {
  if (run("python3", ["-c", "pass"]).spawnError !== undefined) {
    t.skip("python3 is needed to give the program a terminal");
    return;
  }
  const directory = await exampleWorkspace("tty");
  const outcome = await runBuild(
    join(directory, "blaze.toml"),
    { cwd: directory, reuse: false, model: `replay:${HELLO_WORLD_REPLAY}`, maxAttempts: 1 },
    quiet,
    "build",
  );
  assert.ok(outcome.outputPath !== null);

  const execution = runOnTerminal(outcome.outputPath);
  // The binary must terminate on its own: a timeout here is the bug.
  assert.equal(execution.code, 0, execution.output);
  assert.match(execution.output, /^done: dot product = 70$/m);
});

test("a project names its provider and model, and the flag overrides it", async () => {
  const directory = await workspace("models");
  await writeProject(join(directory, "input.toml"), {
    ...INPUT,
    model: { provider: "openrouter", model: "anthropic/claude-sonnet-4.5" },
  });
  // The project names OpenRouter; only the flag lets this build run offline.
  const fromFile = await runBuild(
    "input.toml",
    { cwd: directory, reuse: false, model: `replay:${REPLAY}` },
    quiet,
    "build",
  );
  assert.equal(fromFile.build.status, "success");
  assert.equal(fromFile.build.model, `replay:${REPLAY}`);
});

test("the model in a project file is what a build uses", async () => {
  const directory = await workspace("file-model");
  await writeProject(join(directory, "input.toml"), { ...INPUT, model: { provider: "replay", file: REPLAY } });
  // No --model and no AI_MODEL: the project file is the only source.
  const outcome = await runBuild("input.toml", { cwd: directory, reuse: false }, quiet, "build");
  assert.equal(outcome.build.model, `replay:${REPLAY}`);
  assert.equal(outcome.build.modelConfig, `replay:${REPLAY}`);
});

test("a project file may use the provider/model shorthand", async () => {
  const directory = await workspace("shorthand");
  await writeProject(join(directory, "input.toml"), { ...INPUT, model: `replay:${REPLAY}` });
  const outcome = await runBuild("input.toml", { cwd: directory, reuse: false }, quiet, "build");
  assert.equal(outcome.build.status, "success");
});

test("an incomplete model selection is reported before any work happens", async () => {
  const directory = await workspace("incomplete");
  await writeProject(join(directory, "input.toml"), { ...INPUT, model: { provider: "openai" } });
  await assert.rejects(
    () => runBuild("input.toml", { cwd: directory, reuse: false }, quiet, "build"),
    /must name both a provider and a model/,
  );

  await writeProject(join(directory, "input.toml"), { ...INPUT, model: { provider: "replay" } });
  await assert.rejects(
    () => runBuild("input.toml", { cwd: directory, reuse: false }, quiet, "build"),
    /replay provider without a "file"/,
  );
});

test("a credential in a project file is refused", async () => {
  const directory = await workspace("credential");
  await writeProject(join(directory, "input.toml"), {
    ...INPUT,
    model: { provider: "openrouter", model: "openai/gpt-5", apiKey: "sk-or-leaked" },
  });
  await assert.rejects(
    () => runBuild("input.toml", { cwd: directory, reuse: false, model: `replay:${REPLAY}` }, quiet, "build"),
    /puts a credential in "model.apiKey"/,
  );
});

test("a source file given in place of a project file is named as one", async () => {
  const directory = await workspace("source-as-input");
  await writeFile(join(directory, "module.ts"), "export function f(): number { return 1; }\n");
  // The compiler builds a project file, so this must not be reported as a
  // JSON parse error on the source the user meant to compile.
  await assert.rejects(
    () => runBuild("module.ts", { cwd: directory, reuse: false, model: `replay:${REPLAY}` }, quiet, "build"),
    /is a source file, not a project file/,
  );
});

test("a program that names an entry function is refused, because a program is its statements", async () => {
  const directory = await workspace("program-with-entry");
  await writeFile(join(directory, "module.ts"), 'import { f } from "./f.ts";\nconsole.log(f());\n');
  await writeFile(join(directory, "f.ts"), "export function f(): number {\n  return 1;\n}\n");
  await writeProject(join(directory, "input.toml"), {
    ...INPUT,
    language: "typescript",
    sourceFile: "module.ts",
    entry: "f",
  });
  await assert.rejects(
    () => runBuild("input.toml", { cwd: directory, reuse: false, model: `replay:${REPLAY}` }, quiet, "build"),
    /entry "f" names a function, but module.ts is a program/,
  );
});

test("an imported module that runs code is refused, because nothing would run it", async () => {
  const directory = await workspace("library-with-body");
  await writeFile(
    join(directory, "main.ts"),
    'import { f } from "./f.ts";\nconsole.log(`${f()}`);\n',
  );
  await writeFile(
    join(directory, "f.ts"),
    'import { g } from "./g.ts";\nexport function f(): number {\n  return 1;\n}\nconsole.log(g());\n',
  );
  await writeFile(join(directory, "g.ts"), "export function g(): number {\n  return 2;\n}\n");
  await writeProject(join(directory, "input.toml"), { ...INPUT, language: "typescript", sourceFile: "main.ts" });
  await assert.rejects(
    () => runBuild("input.toml", { cwd: directory, reuse: false, model: `replay:${REPLAY}` }, quiet, "build"),
    /f.ts runs code at the top level/,
  );
});

/** A project whose entry module imports another module of the same directory. */
async function multiFileProject(name: string, helper: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `blaze-${name}-`));
  await writeFile(
    join(directory, "dot.ts"),
    [
      'import { scale } from "./scale.ts";',
      "",
      "export function dotProduct(a: Float64Array, b: Float64Array, n: number): number {",
      "  let total = 0;",
      "  for (let i = 0; i < n; i++) {",
      "    total += a[i] * b[i];",
      "  }",
      "  return total;",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(join(directory, "scale.ts"), helper);
  await writeProject(join(directory, "input.toml"), {
    language: "typescript",
    sourceFile: "dot.ts",
    entry: "dotProduct",
    target: INPUT.target,
    // The fixture this build replays answers in the IR, like every other kind.
    output: "machine",
    generation: { maxCandidates: 1, maxAttempts: 1 },
    test: { randomCases: 4, maxLength: 32, seed: 3 },
    benchmark: { iterations: 100 },
  });
  return directory;
}

const SCALE = "export function scale(x: number): number {\n  return x * 2;\n}\n";

test("every file of a program is contracted before any code is generated", async () => {
  const directory = await multiFileProject("program", SCALE);
  const outcome = await runBuild(
    "input.toml",
    { cwd: directory, reuse: false, model: `replay:${HELLO_WORLD_REPLAY}`, maxAttempts: 1 },
    quiet,
    "build",
  );

  assert.equal(outcome.build.status, "success");
  assert.deepEqual(outcome.program.files.map((file) => file.path), ["dot.ts", "scale.ts"]);
  assert.deepEqual(outcome.program.edges, [{ from: "dot.ts", to: "scale.ts", symbols: ["scale"] }]);
  // The imported module is contracted too, not only the module being compiled.
  assert.deepEqual(outcome.program.files[1].functions.scale.ensures, ["result == (x * 2)"]);
  assert.equal(outcome.program.entry.function, "dotProduct");
});

test("a contract failure stops the build before a model is asked for code", async () => {
  const directory = await multiFileProject("unresolved", "export function other(x: number): number {\n  return x;\n}\n");
  await assert.rejects(
    () => runBuild("input.toml", { cwd: directory, reuse: false, model: `replay:${HELLO_WORLD_REPLAY}` }, quiet, "build"),
    /imports "scale" from ".\/scale.ts", which does not export it/,
  );
  // Nothing was generated: the failure came from the contract phase itself.
  await assert.rejects(() => readFile(join(directory, STATE_DIRECTORY, "projects/input/candidates.json"), "utf8"));
});

test("an unknown project is reported, not guessed", async () => {
  const directory = await workspace("unknown");
  await assert.rejects(() => inspectProject("missing", directory), /unknown project "missing"/);
  await assert.rejects(
    () => runStored("missing", { cwd: directory, reuse: false }, quiet, "test"),
    /unknown project "missing"/,
  );
});

test("generate stops at candidate selection and delivers nothing", async () => {
  const directory = await workspace("generate");
  const outcome = await runBuild("input.toml", { cwd: directory, reuse: false, model: `replay:${REPLAY}` }, quiet, "generate");
  assert.equal(outcome.outputPath, null);
  assert.equal(outcome.build.status, "success");
  await assert.rejects(() => readFile(join(directory, STATE_DIRECTORY, "projects/input/output/input"), "utf8"));
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBuild, runStored, inspectProject, STATE_DIRECTORY } from "../compiler.ts";
import { run } from "../core/process.ts";
import type { ProgramContract, SourceInput, VerificationResult } from "../core/types.ts";
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

/** A review that finds nothing to change, which is what most rounds answer. */
const SOUND = "verdict: sound\nreason: the body computes what the contract states, and no rule applies to it";

/** A review file of its own, so a test can script the answers a build is given. */
async function reviews(directory: string, ...answers: string[]): Promise<string> {
  const path = join(directory, "reviews.json");
  await writeFile(path, JSON.stringify({ reviews: answers }), "utf8");
  return path;
}

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
  assert.ok(stages.indexOf("ir") < stages.indexOf("review"), stages.join(", "));
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
  // The C is the text the compiler wrote for the IR it resolved, so a model
  // never sees a signature and a `c` build is the same build as any other.
  const replay = await reviews(directory, SOUND);
  const outcome = await runBuild("input.toml", { cwd: directory, reuse: false, model: `replay:${replay}` }, quiet, "build");
  assert.equal(outcome.build.outputKind, "c");
  assert.ok(outcome.outputPath?.endsWith("output/input.c"));

  const source = await readFile(outcome.outputPath as string, "utf8");
  assert.match(source, /float dotProduct\(float\* a, float\* b, size_t n\)/);
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

/** A replay file of its own, so a test can leave the model unable to answer. */
async function writableReplay(directory: string, fixture: string): Promise<string> {
  const replay = join(directory, "candidates.json");
  await writeFile(replay, await readFile(fixture, "utf8"));
  return replay;
}

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
  await writeFile(replay, JSON.stringify({ reviews: ["this is not a review"] }), "utf8");
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
  await writeFile(replay, JSON.stringify({ reviews: ["this is not a review"] }), "utf8");
  const second = await runBuild("input.toml", { cwd: directory, reuse: false, model: `replay:${replay}` }, quiet, "build");

  assert.equal(second.build.status, "success");
  assert.deepEqual(second.build.reused, { dotProduct: "c1" });
});

test("a stored implementation whose files are gone is rebuilt from it, without a model", async () => {
  const directory = await workspace("incremental-partial");
  const replay = await writableReplay(directory, REPLAY);
  await runBuild("input.toml", { cwd: directory, reuse: false, model: `replay:${replay}` }, quiet, "build");

  await rm(join(directory, STATE_DIRECTORY, "projects/input/work"), { recursive: true, force: true });
  await writeFile(replay, JSON.stringify({ reviews: ["this is not a review"] }), "utf8");
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

/** A program project, whose reviews are recorded rather than asked for. */
async function programProject(name: string, source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `blaze-${name}-`));
  await writeProject(join(directory, "input.toml"), { ...INPUT, language: "typescript", entry: "", source });
  await writeFile(join(directory, "reviews.json"), JSON.stringify({ reviews: [SOUND] }), "utf8");
  return directory;
}

test("a program whose function takes a reference is built, because the program is what checks it", async () => {
  const directory = await programProject("reference", REFERENCE_PROGRAM);
  const outcome = await runBuild(
    "input.toml",
    { cwd: directory, reuse: false, model: `replay:${join(directory, "reviews.json")}`, maxAttempts: 1 },
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

/**
 * A two-function program project, answered per function rather than per
 * request: the two are generated at the same time, so which answer a request
 * gets is decided by the function the prompt is for.
 */
async function callingProject(name: string): Promise<{ directory: string; answer: () => string }> {
  const directory = await mkdtemp(join(tmpdir(), `blaze-${name}-`));
  await writeFile(join(directory, "main.ts"), CALLING_PROGRAM, "utf8");
  await writeProject(join(directory, "blaze.toml"), {
    language: "typescript",
    sourceFile: "main.ts",
    model: { provider: "openai-compatible", model: "stub" },
    output: "machine",
    generation: { maxCandidates: 1, maxAttempts: 1 },
  });
  return { directory, answer: () => SOUND };
}

test("a function that calls another function of the program is built and checked by it", async (t) => {
  const { directory, answer } = await callingProject("calls-sibling");
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

/**
 * A program of two functions, one of which the other calls. `step` is a single
 * block that falls out of it, which is what a body has to be for the compiler
 * to put it where the call was: the IR a function is written in has one block
 * of its own, so a body that leaves from more than one of them has nowhere to
 * go in a caller.
 */
const BRANCHING_PROGRAM = [
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

test("a review that inlines a call has the callee's body put where the call was", async (t) => {
  const inline = "verdict: repaired\nreason: the callee is a leaf\nproposal: inline-call entry callee=twice";
  const directory = await mkdtemp(join(tmpdir(), "blaze-writes-out-"));
  await writeFile(join(directory, "main.ts"), CALLING_PROGRAM, "utf8");
  await writeProject(join(directory, "blaze.toml"), {
    language: "typescript",
    sourceFile: "main.ts",
    model: { provider: "openai-compatible", model: "stub" },
    output: "machine",
    generation: { maxCandidates: 1, maxAttempts: 1 },
  });
  await chatEndpoint(t, [], { answer: (prompt: string) => (prompt.includes("under review: main") ? inline : SOUND) });

  const outcome = await runBuild(
    "blaze.toml",
    { cwd: directory, reuse: false, model: "openai-compatible/stub" },
    quiet,
    "build",
  );

  assert.equal(outcome.build.status, "success");
  assert.deepEqual(Object.keys(outcome.contracts).sort(), ["main", "twice"]);
  assert.ok(outcome.outputPath !== null);
  assert.equal(run(outcome.outputPath, [], { timeoutMs: 60_000 }).stdout, "42\n");

  // The whole point of writing the call out: the caller declares no call for
  // the callee and references no other symbol of the program, so it is linked
  // on its own and probed. The rule is the compiler's and the artifact is
  // regenerated from it, so what is delivered is the one the rule produced.
  const generation = JSON.parse(
    await readFile(join(directory, STATE_DIRECTORY, `projects/${outcome.project}/generation.json`), "utf8"),
  ) as { functions: Record<string, { outcomes: { probe?: { called: boolean; reason: string | null } }[] }> };
  const [mainOutcome] = generation.functions.main.outcomes;
  assert.notEqual(mainOutcome.probe, undefined);
  assert.equal(mainOutcome.probe?.called, true);
});

test("a callee that leaves from more than one block is left as a call, and the program still runs", async (t) => {
  // The outline would write `step` out into `main`, but `step` returns from two
  // of its blocks, and a body like that has nowhere to go in a caller that has
  // one. The call stays, both functions are linked, and the program prints what
  // the source prints.
  const directory = await mkdtemp(join(tmpdir(), "blaze-writes-transitive-"));
  await writeFile(join(directory, "main.ts"), BRANCHING_PROGRAM, "utf8");
  await writeProject(join(directory, "blaze.toml"), {
    language: "typescript",
    sourceFile: "main.ts",
    model: { provider: "openai-compatible", model: "stub" },
    output: "machine",
    generation: { maxCandidates: 1, maxAttempts: 1 },
  });
  await chatEndpoint(t, [], { answer: () => SOUND });

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
  // The caller still reaches the program, which is the only thing that can run
  // it: the object it calls is the callee's.
  const generation = JSON.parse(
    await readFile(join(directory, STATE_DIRECTORY, `projects/${outcome.project}/generation.json`), "utf8"),
  ) as { functions: Record<string, { outcomes: { probe?: { called: boolean; reason: string | null } }[] }> };
  assert.match(generation.functions.main.outcomes[0]?.probe?.reason ?? "", /it calls step/);
});

test("a program entry is accepted under the symbol its contract names, not under its function name", async () => {
  const source = ["function main(): number {", "  return 40 + 2;", "}", "", "main();", 'console.log(`answer: ${42}`);', ""].join("\n");
  // The entry is written under the symbol its contract names, so the IR a
  // candidate answers with is headed `main as blaze_main`.
  const answer = irOf("typescript", { "module.ts": source }, "module.ts", "main");
  assert.match(answer, /^function main as blaze_main\(\) -> f64$/m);
  const directory = await programProject("entry-symbol", source);
  const outcome = await runBuild(
    "input.toml",
    { cwd: directory, reuse: false, model: `replay:${join(directory, "reviews.json")}`, maxAttempts: 1 },
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

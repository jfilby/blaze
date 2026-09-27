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

const REPLAY = new URL("./fixtures/dot-product-replay.json", import.meta.url).pathname;
const HELLO_WORLD_REPLAY = new URL("./fixtures/hello-world-replay.json", import.meta.url).pathname;
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
  generation: { maxCandidates: 1, maxAttempts: 2 },
  test: { randomCases: 6, maxLength: 64, seed: 7 },
  benchmark: { iterations: 200 },
};

async function workspace(name: string, input: SourceInput = INPUT): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `blaze-${name}-`));
  await writeFile(join(directory, "input.json"), JSON.stringify(input, null, 2), "utf8");
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

test("a build produces assembly, a native executable and a complete record", async () => {
  const directory = await workspace("build");
  const outcome = await runBuild("input.json", { cwd: directory, reuse: false, model: `replay:${REPLAY}` }, quiet, "build");

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
  const outcome = await runBuild("input.json", { cwd: directory, reuse: false, model: `replay:${REPLAY}` }, quiet, "build");
  assert.ok(outcome.outputPath !== null);

  const request = ["run", "5 5 5", "1 2 3 4 5", "1 1 1 1 1", "3 3 3", "2 2 2", "2 2 2", ""].join("\n");
  const execution = run(outcome.outputPath, [], { input: request, timeoutMs: 60_000 });
  assert.equal(execution.code, 0, execution.stderr);
  assert.deepEqual(
    execution.stdout.trim().split("\n").map((line) => Number(line.split(" ")[1])),
    [15, 12],
  );
});

test("the delivered assembly is the implementation that was verified", async () => {
  const directory = await workspace("asm");
  const outcome = await runBuild("input.json", { cwd: directory, reuse: false, model: `replay:${REPLAY}` }, quiet, "build");
  assert.ok(outcome.outputAssemblyPath !== null);

  const delivered = await readFile(outcome.outputAssemblyPath, "utf8");
  const stored = JSON.parse(
    await readFile(join(directory, STATE_DIRECTORY, "projects/input/candidates.json"), "utf8"),
  ) as Record<string, { assembly: string }[]>;
  assert.ok(delivered.endsWith(stored.dotProduct[0].assembly));
  assert.ok(delivered.startsWith(".text"), "the architecture prelude is compiler controlled");
});

test("a C build delivers the C source the compiler verified", async () => {
  const directory = await workspace("c", { ...INPUT, output: "c" });
  const replay = join(directory, "candidates.json");
  await writeFile(
    replay,
    JSON.stringify({
      candidates: [
        "#include <stddef.h>\nfloat dotProduct(const float* a, const float* b, size_t n) {\n  float total = 0.0f;\n  for (size_t i = 0; i < n; i++) total += a[i] * b[i];\n  return total;\n}\n",
      ],
    }),
    "utf8",
  );

  const outcome = await runBuild("input.json", { cwd: directory, reuse: false, model: `replay:${replay}` }, quiet, "build");
  assert.equal(outcome.build.outputKind, "c");
  assert.ok(outcome.outputPath?.endsWith("output/input.c"));

  const source = await readFile(outcome.outputPath as string, "utf8");
  assert.match(source, /float dotProduct\(const float\* a, const float\* b, size_t n\)/);
});

test("a rejected candidate is replaced and its diagnostic is fed back", async () => {
  const directory = await workspace("retry");
  const replay = join(directory, "candidates.json");
  const reference = JSON.parse(await readFile(REPLAY, "utf8")) as { candidates: string[] };
  await writeFile(
    replay,
    JSON.stringify({
      candidates: ["\t.globl dotProduct\ndotProduct:\n\tsyscall\n\tret\n", reference.candidates[0]],
    }),
    "utf8",
  );

  const outcome = await runBuild(
    "input.json",
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
  assert.match(candidates[1].feedback?.[0] ?? "", /syscall/);
  assert.match(candidates[1].feedback?.[0] ?? "", /^\[attempt 1]/);
});

test("diagnostics accumulate across repairs and never reach the next candidate", async () => {
  const directory = await workspace("accumulate");
  const replay = join(directory, "candidates.json");
  const reference = JSON.parse(await readFile(REPLAY, "utf8")) as { candidates: string[] };
  // Three rejections in a row, then a working answer: the first candidate burns
  // its attempts, and the second one is generated from a clean prompt.
  await writeFile(
    replay,
    JSON.stringify({
      candidates: [
        "\t.globl dotProduct\ndotProduct:\n\tsyscall\n\tret\n",
        "\t.globl dotProduct\ndotProduct:\n\tnotaninstruction\n\tret\n",
        "\t.globl dotProduct\ndotProduct:\n\tmovssq\n\tret\n",
        reference.candidates[0],
      ],
    }),
    "utf8",
  );

  const outcome = await runBuild(
    "input.json",
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
  assert.match(candidates[1].feedback?.[0] ?? "", /^\[attempt 1] assemble failed:.*syscall/s);
  assert.equal(candidates[2].feedback?.length, 2);
  assert.match(candidates[2].feedback?.[0] ?? "", /^\[attempt 1]/);
  assert.match(candidates[2].feedback?.[1] ?? "", /^\[attempt 2]/);
  assert.match(candidates[2].feedback?.[1] ?? "", /notaninstruction/);

  // The next candidate starts clean: candidate 1's diagnostics stay behind.
  assert.equal(candidates[3].feedback, undefined);
});

test("a build where nothing is valid fails with a record that says why", async () => {
  const directory = await workspace("fail");
  const replay = join(directory, "candidates.json");
  await writeFile(replay, JSON.stringify({ candidates: ["\t.globl dotProduct\ndotProduct:\n\tret\n"] }), "utf8");

  await assert.rejects(
    () => runBuild("input.json", { cwd: directory, reuse: false, model: `replay:${replay}`, maxAttempts: 1 }, quiet, "build"),
    (error: unknown) => error instanceof CompilerError && /no candidate for dotProduct/.test(error.message),
  );

  const build = JSON.parse(
    await readFile(join(directory, STATE_DIRECTORY, "projects/input/build.json"), "utf8"),
  ) as BuildStatus;
  assert.equal(build.status, "failed");
  assert.equal(build.error?.category, "AiGenerationError");
});

test("reuse rebuilds from stored assembly without asking the model", async () => {
  const directory = await workspace("reuse");
  const options = { cwd: directory, reuse: false, model: `replay:${REPLAY}` };
  const first = await runBuild("input.json", options, quiet, "build");
  assert.equal(first.build.status, "success");

  // A model that cannot be resolved would fail if it were consulted at all.
  const reused = await runBuild(
    "input.json",
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

const SUM_ASSEMBLY = [
  "\t.globl\tdotProduct",
  "dotProduct:",
  "\tvxorps\t%xmm0, %xmm0, %xmm0",
  "\ttest\t%rdx, %rdx",
  "\tje\t1f",
  "\tmovq\t%rdx, %rcx",
  "2:\tvmovss\t(%rdi), %xmm1",
  "\tvaddss\t(%rsi), %xmm1, %xmm1",
  "\tvaddss\t%xmm1, %xmm0, %xmm0",
  "\taddq\t$4, %rdi",
  "\taddq\t$4, %rsi",
  "\tsubq\t$1, %rcx",
  "\tjne\t2b",
  "1:\tret",
  "",
].join("\n");

/** A replay file of its own, so a test can leave the model unable to answer. */
async function writableReplay(directory: string, fixture: string): Promise<string> {
  const replay = join(directory, "candidates.json");
  await writeFile(replay, await readFile(fixture, "utf8"));
  return replay;
}

/**
 * A program whose only function recurses, which no postcondition can state, so
 * the program it is part of is the only oracle that has anything to say about
 * it.
 */
const COUNTING_PROGRAM = [
  "function down(n: number): number {",
  "  if (n <= 0) {",
  "    return 0;",
  "  }",
  "  return down(n - 1) + 1;",
  "}",
  "",
  "console.log(down(3));",
  "",
].join("\n");

/** Returns its argument, which is what counting down to zero comes to. */
const COUNT_ASSEMBLY = [".text", "\t.globl\tdown", "down:", "\tret", ""].join("\n");

/** Answers zero whatever it is given, so the program prints 0 where it prints 3. */
const WRONG_COUNT_ASSEMBLY = [".text", "\t.globl\tdown", "down:", "\tpxor\t%xmm0, %xmm0", "\tret", ""].join("\n");

test("reuse refuses to rebuild a function whose contract changed", async () => {
  const directory = await workspace("changed");
  await runBuild("input.json", { cwd: directory, reuse: false, model: `replay:${REPLAY}` }, quiet, "build");
  await writeFile(join(directory, "input.json"), JSON.stringify({ ...INPUT, source: SUM_SOURCE }), "utf8");

  await assert.rejects(
    () => runBuild("input.json", { cwd: directory, reuse: true, model: `replay:${REPLAY}` }, quiet, "build"),
    /the stored implementation of dotProduct was built from different inputs/,
  );
});

test("a function whose contract changed is generated again", async () => {
  const directory = await workspace("incremental-changed");
  const replay = await writableReplay(directory, REPLAY);
  await runBuild("input.json", { cwd: directory, reuse: false, model: `replay:${replay}` }, quiet, "build");

  // The contract now states a sum rather than a product, so the object that
  // satisfied the old one cannot satisfy this one, and the model is asked.
  await writeFile(join(directory, "input.json"), JSON.stringify({ ...INPUT, source: SUM_SOURCE }), "utf8");
  await writeFile(replay, JSON.stringify({ candidates: [SUM_ASSEMBLY] }), "utf8");
  const second = await runBuild("input.json", { cwd: directory, reuse: false, model: `replay:${replay}` }, quiet, "build");

  assert.equal(second.build.status, "success");
  assert.deepEqual(second.build.reused, {});
  assert.ok((second.verification.dotProduct?.[0]?.cases ?? 0) > 0);
});

test("a build reuses a function it already proved, and asks no model for it", async () => {
  const directory = await workspace("incremental");
  const replay = await writableReplay(directory, REPLAY);
  const first = await runBuild("input.json", { cwd: directory, reuse: false, model: `replay:${replay}` }, quiet, "build");
  assert.equal(first.build.status, "success");

  // The model is left able to answer nothing at all: a build that reuses every
  // function it needs never reaches it.
  await writeFile(replay, JSON.stringify({ candidates: ["not assembly at all"] }), "utf8");
  const second = await runBuild("input.json", { cwd: directory, reuse: false, model: `replay:${replay}` }, quiet, "build");

  assert.equal(second.build.status, "success");
  assert.deepEqual(second.build.reused, { dotProduct: "c1" });
  assert.deepEqual(second.build.selectedCandidates, first.build.selectedCandidates);
});

test("a change that leaves a contract alone does not rebuild the function", async () => {
  const directory = await workspace("incremental-comment");
  const replay = await writableReplay(directory, REPLAY);
  await runBuild("input.json", { cwd: directory, reuse: false, model: `replay:${replay}` }, quiet, "build");

  // A comment is not part of what the function is contracted to do, so the
  // object that was verified is still the object this build links.
  await writeFile(join(directory, "input.json"), JSON.stringify({ ...INPUT, source: `${INPUT.source}# a comment\n` }), "utf8");
  await writeFile(replay, JSON.stringify({ candidates: ["not assembly at all"] }), "utf8");
  const second = await runBuild("input.json", { cwd: directory, reuse: false, model: `replay:${replay}` }, quiet, "build");

  assert.equal(second.build.status, "success");
  assert.deepEqual(second.build.reused, { dotProduct: "c1" });
});

test("a stored implementation whose files are gone is rebuilt from it, without a model", async () => {
  const directory = await workspace("incremental-partial");
  const replay = await writableReplay(directory, REPLAY);
  await runBuild("input.json", { cwd: directory, reuse: false, model: `replay:${replay}` }, quiet, "build");

  await rm(join(directory, STATE_DIRECTORY, "projects/input/work"), { recursive: true, force: true });
  await writeFile(replay, JSON.stringify({ candidates: ["not assembly at all"] }), "utf8");
  const log: string[] = [];
  const second = await runBuild(
    "input.json",
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

/**
 * Divides by its argument, which the contract states nothing about, so the zero
 * an input built from the contract carries is a legal one and the candidate
 * faults on it. Nothing about it is visible to a static check: the calls are
 * aligned, the registers are preserved, and the assembly is well formed. This is
 * the class of defect the program round is the only oracle for, and the one
 * faulting a single call is there to catch early.
 */
const DIVIDING_COUNT_ASSEMBLY = [
  ".text",
  ".globl down",
  "down:",
  "  cvttsd2siq %xmm0, %rax",
  "  movq %rax, %rcx",
  "  movq $7, %rax",
  "  cqto",
  "  idivq %rcx",
  "  ret",
  "",
].join("\n");

/** A program project built from recorded candidates, with the generation limits the test needs. */
async function countedProject(name: string, assemblies: string[], maxCandidates: number): Promise<string> {
  const directory = await programProject(name, COUNTING_PROGRAM, assemblies[0]);
  await writeFile(
    join(directory, "input.json"),
    JSON.stringify({ ...INPUT, language: "typescript", entry: "", source: COUNTING_PROGRAM, generation: { maxCandidates, maxAttempts: 1 } }),
    "utf8",
  );
  await writeFile(join(directory, "candidates.json"), JSON.stringify({ candidates: assemblies }), "utf8");
  return directory;
}

test("a definition candidate that faults on the call is rejected before it is selected", async () => {
  const directory = await countedProject("faulting", [DIVIDING_COUNT_ASSEMBLY], 1);
  // The fault is attributed to the function and to the candidate that caused
  // it, which is what lets a repair round regenerate one function rather than
  // every definition in the program.
  const failure = await runBuild(
    "input.json",
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
  const directory = await countedProject("one-good", [DIVIDING_COUNT_ASSEMBLY, COUNT_ASSEMBLY], 2);
  const outcome = await runBuild(
    "input.json",
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
  const directory = await programProject("unproved", COUNTING_PROGRAM, WRONG_COUNT_ASSEMBLY);
  const replay = join(directory, "candidates.json");
  await assert.rejects(
    () => runBuild("input.json", { cwd: directory, reuse: false, model: `replay:${replay}`, maxAttempts: 1 }, quiet, "build"),
    /the program does not print what the source prints|the program stopped/,
  );

  // The program is what proves a function it is the only oracle for, so an
  // implementation the program rejected is regenerated rather than reused.
  await writeFile(replay, JSON.stringify({ candidates: [COUNT_ASSEMBLY] }), "utf8");
  const outcome = await runBuild(
    "input.json",
    { cwd: directory, reuse: false, model: `replay:${replay}`, maxAttempts: 1 },
    quiet,
    "build",
  );
  assert.equal(outcome.build.status, "success");
  assert.deepEqual(outcome.build.reused, {});
});

test("test and benchmark re-run against the selected candidate", async () => {
  const directory = await workspace("stored");
  await runBuild("input.json", { cwd: directory, reuse: false, model: `replay:${REPLAY}` }, quiet, "build");
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
    join(directory, "blaze.json"),
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
    join(directory, "blaze.json"),
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

const DEPTH_ASSEMBLY = [
  ".text",
  ".globl depth",
  "depth:",
  "  testq %rdi, %rdi",
  "  je .Lempty",
  "  movabsq $4607182418800017408, %rax",
  "  movq %rax, %xmm0",
  "  ret",
  ".Lempty:",
  "  pxor %xmm0, %xmm0",
  "  ret",
  "",
].join("\n");

/** A program project, compiled by recorded candidates rather than by a model. */
async function programProject(name: string, source: string, assembly: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `blaze-${name}-`));
  await writeFile(join(directory, "input.json"), JSON.stringify({ ...INPUT, language: "typescript", entry: "", source }), "utf8");
  await writeFile(join(directory, "candidates.json"), JSON.stringify({ candidates: [assembly] }), "utf8");
  return directory;
}

test("a program whose function takes a reference is built, because the program is what checks it", async () => {
  const directory = await programProject("reference", REFERENCE_PROGRAM, DEPTH_ASSEMBLY);
  const outcome = await runBuild(
    "input.json",
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
const TWICE_ASSEMBLY = [
  ".text",
  "\t.globl\ttwice",
  "twice:",
  "\taddsd\t%xmm0, %xmm0",
  "\tret",
  "",
].join("\n");

/** The caller: prints what the callee returns, rather than computing it again. */
const MAIN_CALLS_TWICE_ASSEMBLY = [
  ".text",
  "\t.globl\tblaze_main",
  "blaze_main:",
  "\tsubq\t$24, %rsp",
  "\tmovabsq\t$4626604192193052672, %rax",
  "\tmovq\t%rax, %xmm0",
  "\tcall\ttwice",
  "\tmovq\t%xmm0, %rdi",
  "\tcall\tblaze_rt_print_number",
  "\tcall\tblaze_rt_print_newline",
  "\taddq\t$24, %rsp",
  "",
].join("\n");

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
  await writeFile(
    join(directory, "blaze.json"),
    JSON.stringify({
      language: "typescript",
      sourceFile: "main.ts",
      model: { provider: "openai-compatible", model: "stub" },
      output: "machine",
      generation: { maxCandidates: 1, maxAttempts: 1 },
    }),
    "utf8",
  );
  return { directory, answer: (prompt: string) => (prompt.includes("function being written: main") ? caller : TWICE_ASSEMBLY) };
}

test("a function that calls another function of the program is built and checked by it", async (t) => {
  const { directory, answer } = await callingProject("calls-sibling", MAIN_CALLS_TWICE_ASSEMBLY);
  await chatEndpoint(t, [], { answer });

  const outcome = await runBuild(
    "blaze.json",
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
  const wrong = MAIN_CALLS_TWICE_ASSEMBLY.replace(
    "\tmovq\t%xmm0, %rdi",
    "\taddsd\t%xmm0, %xmm0\n\tmovq\t%xmm0, %rdi",
  );
  const { directory, answer } = await callingProject("wrong-call", wrong);
  await chatEndpoint(t, [], { answer });

  const failure = await runBuild(
    "blaze.json",
    { cwd: directory, reuse: false, model: "openai-compatible/stub" },
    quiet,
    "build",
  ).then(
    () => { throw new Error("a program that prints the wrong thing must not be delivered"); },
    (error: CompilerError) => error,
  );
  assert.match(`${failure.message}\n${failure.detail ?? ""}`, /the program prints "84"/);
});

test("a program entry is accepted under the symbol its contract names, not under its function name", async () => {
  const source = ["function main(): number {", "  return 40 + 2;", "}", "", "main();", 'console.log(`answer: ${42}`);', ""].join("\n");
  const assembly = [".text", ".globl blaze_main", "blaze_main:", "  movabsq $4631107791820423168, %rax", "  movq %rax, %xmm0", "  ret", ""].join("\n");
  const directory = await programProject("entry-symbol", source, assembly);
  const outcome = await runBuild(
    "input.json",
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
    join(directory, "blaze.json"),
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
  await writeFile(
    join(directory, "input.json"),
    JSON.stringify({ ...INPUT, model: { provider: "openrouter", model: "anthropic/claude-sonnet-4.5" } }),
  );
  // The project names OpenRouter; only the flag lets this build run offline.
  const fromFile = await runBuild(
    "input.json",
    { cwd: directory, reuse: false, model: `replay:${REPLAY}` },
    quiet,
    "build",
  );
  assert.equal(fromFile.build.status, "success");
  assert.equal(fromFile.build.model, `replay:${REPLAY}`);
});

test("the model in a project file is what a build uses", async () => {
  const directory = await workspace("file-model");
  await writeFile(
    join(directory, "input.json"),
    JSON.stringify({ ...INPUT, model: { provider: "replay", file: REPLAY } }),
  );
  // No --model and no AI_MODEL: the project file is the only source.
  const outcome = await runBuild("input.json", { cwd: directory, reuse: false }, quiet, "build");
  assert.equal(outcome.build.model, `replay:${REPLAY}`);
  assert.equal(outcome.build.modelConfig, `replay:${REPLAY}`);
});

test("a project file may use the provider/model shorthand", async () => {
  const directory = await workspace("shorthand");
  await writeFile(join(directory, "input.json"), JSON.stringify({ ...INPUT, model: `replay:${REPLAY}` }));
  const outcome = await runBuild("input.json", { cwd: directory, reuse: false }, quiet, "build");
  assert.equal(outcome.build.status, "success");
});

test("an incomplete model selection is reported before any work happens", async () => {
  const directory = await workspace("incomplete");
  await writeFile(join(directory, "input.json"), JSON.stringify({ ...INPUT, model: { provider: "openai" } }));
  await assert.rejects(
    () => runBuild("input.json", { cwd: directory, reuse: false }, quiet, "build"),
    /must name both a provider and a model/,
  );

  await writeFile(join(directory, "input.json"), JSON.stringify({ ...INPUT, model: { provider: "replay" } }));
  await assert.rejects(
    () => runBuild("input.json", { cwd: directory, reuse: false }, quiet, "build"),
    /replay provider without a "file"/,
  );
});

test("a credential in a project file is refused", async () => {
  const directory = await workspace("credential");
  await writeFile(
    join(directory, "input.json"),
    JSON.stringify({ ...INPUT, model: { provider: "openrouter", model: "openai/gpt-5", apiKey: "sk-or-leaked" } }),
  );
  await assert.rejects(
    () => runBuild("input.json", { cwd: directory, reuse: false, model: `replay:${REPLAY}` }, quiet, "build"),
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
  await writeFile(
    join(directory, "input.json"),
    JSON.stringify({ ...INPUT, language: "typescript", sourceFile: "module.ts", entry: "f" }),
  );
  await assert.rejects(
    () => runBuild("input.json", { cwd: directory, reuse: false, model: `replay:${REPLAY}` }, quiet, "build"),
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
  await writeFile(
    join(directory, "input.json"),
    JSON.stringify({ ...INPUT, language: "typescript", sourceFile: "main.ts" }),
  );
  await assert.rejects(
    () => runBuild("input.json", { cwd: directory, reuse: false, model: `replay:${REPLAY}` }, quiet, "build"),
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
  await writeFile(
    join(directory, "input.json"),
    JSON.stringify({
      language: "typescript",
      sourceFile: "dot.ts",
      entry: "dotProduct",
      target: INPUT.target,
      generation: { maxCandidates: 1, maxAttempts: 1 },
      test: { randomCases: 4, maxLength: 32, seed: 3 },
      benchmark: { iterations: 100 },
    }),
  );
  return directory;
}

const SCALE = "export function scale(x: number): number {\n  return x * 2;\n}\n";

test("every file of a program is contracted before any code is generated", async () => {
  const directory = await multiFileProject("program", SCALE);
  const outcome = await runBuild(
    "input.json",
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
    () => runBuild("input.json", { cwd: directory, reuse: false, model: `replay:${HELLO_WORLD_REPLAY}` }, quiet, "build"),
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
  const outcome = await runBuild("input.json", { cwd: directory, reuse: false, model: `replay:${REPLAY}` }, quiet, "generate");
  assert.equal(outcome.outputPath, null);
  assert.equal(outcome.build.status, "success");
  await assert.rejects(() => readFile(join(directory, STATE_DIRECTORY, "projects/input/output/input"), "utf8"));
});

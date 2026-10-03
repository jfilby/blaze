import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runBuild, runStored, inspectProject, STATE_DIRECTORY, type Reporter } from "../compiler.ts";
import { run } from "../core/process.ts";
import type { ProgramContract, SourceInput, VerificationResult } from "../core/types.ts";
import { chatEndpoint } from "./model-endpoint.ts";
import { writeProject } from "./project.ts";
import { irOf } from "./phase.ts";
import { scratch } from "./scratch.ts";

const REPLAY = new URL("./fixtures/dot-product-replay.json", import.meta.url).pathname;
const HELLO_WORLD_REPLAY = new URL("./fixtures/hello-world-replay.json", import.meta.url).pathname;
const PROTO_REPLAY = new URL("./fixtures/proto-function-replay.json", import.meta.url).pathname;
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
  const directory = await scratch(`blaze-${name}-`);
  await writeProject(join(directory, "input.toml"), input);
  return directory;
}

/**
 * The shipped example, copied into a workspace. A build delivers the program it
 * links beside the project file, so a test that builds the example builds a
 * copy: the repository is not the test's scratch directory.
 */
const quiet = { stage: () => {} };

test("a backend that cannot deliver the output kind asked for is refused", async () => {
  // The two axes are separate, so the pair is checked rather than either one
  // winning: a module only comes from the backend that encodes one, and the C
  // the compiler writes is not one.
  const directory = await workspace("backend-pair", { ...INPUT, output: "wasm", backend: "c" });
  await assert.rejects(
    () => runBuild("input.toml", { cwd: directory, reuse: false, model: `replay:${REPLAY}` }, quiet, "build"),
    /the "c" backend cannot deliver the "wasm" output kind/,
  );
  const other = await workspace("backend-pair-c", { ...INPUT, output: "machine", backend: "wasm" });
  await assert.rejects(
    () => runBuild("input.toml", { cwd: other, reuse: false, model: `replay:${REPLAY}` }, quiet, "build"),
    /the "wasm" backend cannot deliver the "machine" output kind/,
  );
});

test("a backend nobody has heard of is refused by name", async () => {
  const directory = await workspace("backend-unknown", { ...INPUT, backend: "llvm" as never });
  await assert.rejects(
    () => runBuild("input.toml", { cwd: directory, reuse: false, model: `replay:${REPLAY}` }, quiet, "build"),
    /unknown backend "llvm"/,
  );
});

test("a build names the backend it used, and one that names none gets the output kind's", async () => {
  // The backend is what wrote the artifact, so a record that does not say
  // which one cannot be re-verified as the same build. An output kind names the
  // backend that writes it: an object is delivered by the one that encodes an
  // object, and both of those are asked for here.
  const named = await workspace("backend-recorded", { ...INPUT, backend: "c" });
  const outcome = await runBuild(
    "input.toml",
    { cwd: named, reuse: false, model: `replay:${REPLAY}` },
    quiet,
    "build",
  );
  const build = await inspectProject("input", named);
  assert.equal(build.outputKind, "machine");
  assert.equal(build.backend, "c");
  assert.equal(outcome.outputKind, "machine");

  const implied = await workspace("backend-implied");
  await runBuild("input.toml", { cwd: implied, reuse: false, model: `replay:${REPLAY}` }, quiet, "build");
  assert.equal((await inspectProject("input", implied)).backend, "machine");
});

test("a mode nobody has heard of is refused by name", async () => {
  const directory = await workspace("mode-unknown", { ...INPUT, mode: "turbo" as never });
  await assert.rejects(
    () => runBuild("input.toml", { cwd: directory, reuse: false, model: `replay:${REPLAY}` }, quiet, "build"),
    /unknown mode "turbo"/,
  );
});

test("a build names the mode it built in, and one that names none gets the default", async () => {
  // The mode decides the flags the artifact was built with, so a record that
  // does not say which one cannot be re-verified as the same build.
  const named = await workspace("mode-named", { ...INPUT, mode: "release" });
  const outcome = await runBuild(
    "input.toml",
    { cwd: named, reuse: false, model: `replay:${REPLAY}` },
    quiet,
    "build",
  );
  assert.equal(outcome.build.mode, "release");
  assert.equal((await inspectProject("input", named)).mode, "release");

  // `debug` is the default: a build that names no mode is optimized for
  // reading, which is what a reader who has not asked for speed wants.
  const implied = await workspace("mode-implied");
  await runBuild("input.toml", { cwd: implied, reuse: false, model: `replay:${REPLAY}` }, quiet, "build");
  assert.equal((await inspectProject("input", implied)).mode, "debug");
});

test("a function the source named __proto__ is compiled and recorded like any other", async () => {
  // Every record of a build is keyed by whatever the source called the
  // function, and `__proto__` is a legal name: the contract phase's duplicate
  // check read the inherited accessor, so it refused a program that declares
  // the name once, and the records were assigned into rather than built, so
  // the entry never existed in them.
  const directory = await scratch("blaze-proto-");
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

  // Re-measuring a stored build reads and writes the same records, and it did
  // so by assignment into the parsed object, where this name is an inherited
  // accessor: the entry the build had just written was gone by the time the
  // re-measure wrote its record back, and the prototype of the record had
  // become an array.
  const remeasured = await runStored(
    "input",
    { cwd: directory, reuse: false, model: `replay:${PROTO_REPLAY}` },
    quiet,
    "test",
  );
  assert.deepEqual(Object.keys(remeasured.functions), ["__proto__"], "the re-measure keeps the function it measured");
  for (const file of ["verification.json", "benchmark.json"]) {
    const record = JSON.parse(
      await readFile(join(directory, STATE_DIRECTORY, "projects/input", file), "utf8"),
    ) as Record<string, unknown>;
    assert.deepEqual(Object.keys(record), ["__proto__"], `${file} must record the function after a re-measure`);
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

test("what a build delivers is the artifact its backend wrote beside the IR it verified", async () => {
  const directory = await workspace("asm");
  const outcome = await runBuild("input.toml", { cwd: directory, reuse: false, model: `replay:${REPLAY}` }, quiet, "build");
  assert.ok(outcome.outputAssemblyPath !== null);

  // Every kind answers in the IR, so what a build verified is the IR, and the
  // text it delivers beside the object is that IR itself and not a copy of
  // something else: what the model wrote is what the contract was checked on.
  const stored = JSON.parse(
    await readFile(join(directory, STATE_DIRECTORY, "projects/input/candidates.json"), "utf8"),
  ) as Record<string, { text: string }[]>;
  const implementation = await readFile(outcome.outputAssemblyPath.replace(/\.o$/, ".ir"), "utf8");
  assert.equal(implementation, stored.dotProduct[0].text);

  // A build that lowers the IR itself delivers the object it encoded, and what
  // the object defines is the symbol the program calls.
  const object = await readFile(outcome.outputAssemblyPath);
  assert.equal(object.subarray(0, 4).toString("latin1"), "\x7fELF");
  const defined = run("nm", ["--defined-only", "--extern-only", outcome.outputAssemblyPath], { timeoutMs: 30_000 });
  assert.equal(defined.code, 0, defined.stderr);
  assert.deepEqual(defined.stdout.trim().split("\n").map((line) => line.trim().split(/\s+/).pop()), ["dotProduct"]);

  // The `c` backend delivers the assembly the toolchain made of the C the
  // compiler wrote for that IR, so its text is the target the object was
  // assembled from rather than the IR itself.
  const throughC = await workspace("asm-c", { ...INPUT, backend: "c" });
  const cOutcome = await runBuild(
    "input.toml",
    { cwd: throughC, reuse: false, model: `replay:${REPLAY}` },
    quiet,
    "build",
  );
  assert.ok(cOutcome.outputAssemblyPath !== null);
  const delivered = await readFile(cOutcome.outputAssemblyPath, "utf8");
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
    /the stored implementation of dotProduct was reviewed from different inputs/,
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

/**
 * A build record as it is on the disk, so a test can say a build ran under a
 * different engine without touching the compiler's own sources.
 */
async function storedRecord(directory: string, project: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(join(directory, STATE_DIRECTORY, `projects/${project}/build.json`), "utf8"),
  ) as Record<string, unknown>;
}

async function writeStoredRecord(directory: string, project: string, record: Record<string, unknown>): Promise<void> {
  await writeFile(
    join(directory, STATE_DIRECTORY, `projects/${project}/build.json`),
    JSON.stringify(record, null, 2),
    "utf8",
  );
}

/** The record of what a build proved per function, exactly as it is stored. */
async function storedIncremental(directory: string, project: string): Promise<string> {
  return readFile(join(directory, STATE_DIRECTORY, `projects/${project}/incremental.json`), "utf8");
}

test("a build records the engine that built it", async () => {
  const directory = await workspace("engine-recorded");
  const outcome = await runBuild("input.toml", { cwd: directory, reuse: false, model: `replay:${REPLAY}` }, quiet, "build");

  // The stamp is the release and a fingerprint of the compiler's own sources,
  // which is what the next run compares against its own.
  assert.match(outcome.build.engine, /^0\.1\.0\+[0-9a-f]{8}$/);
  assert.equal((await storedRecord(directory, outcome.project)).engine, outcome.build.engine);
});

test("an engine that changed is announced, and declining leaves the last build alone", async () => {
  const directory = await workspace("engine-changed");
  const replay = await writableReplay(directory, REPLAY);
  const first = await runBuild("input.toml", { cwd: directory, reuse: false, model: `replay:${replay}` }, quiet, "build");
  assert.equal(first.build.status, "success");

  // The record now claims an engine that is not this one, which is what a
  // compiler updated under a project looks like from inside a build.
  const record = await storedRecord(directory, first.project);
  await writeStoredRecord(directory, first.project, { ...record, engine: "0.1.0+00000000" });
  const before = await storedIncremental(directory, first.project);

  const asked: string[] = [];
  await assert.rejects(
    () =>
      runBuild(
        "input.toml",
        {
          cwd: directory,
          reuse: false,
          model: `replay:${replay}`,
          confirm: async (question) => {
            asked.push(question);
            return false;
          },
        },
        quiet,
        "build",
      ),
    /the engine changed \(0\.1\.0\+00000000 -> /,
  );

  assert.equal(asked.length, 1, `the user was asked ${asked.length} times: ${asked.join(" ")}`);
  assert.match(asked[0] ?? "", /Recompile every function from scratch/);
  // Nothing was built, so the record is the build that was there before, not a
  // failed one: the project still has the object the last build verified.
  const after = await storedRecord(directory, first.project);
  assert.equal(after.status, "success");
  assert.equal(after.engine, "0.1.0+00000000", "a declined build overwrote the record it was asked about");
  assert.deepEqual(after.selectedCandidates, first.build.selectedCandidates);
  // What the last build proved is still proved: a build that stops before it
  // starts has not invalidated the proof it was about to replace.
  assert.equal(await storedIncremental(directory, first.project), before, "a declined build disturbed what was stored");
});

test("an engine that changed is recompiled when the user says so, and without asking otherwise", async () => {
  const directory = await workspace("engine-accepted");
  const replay = await writableReplay(directory, REPLAY);
  const first = await runBuild("input.toml", { cwd: directory, reuse: false, model: `replay:${replay}` }, quiet, "build");
  const record = await storedRecord(directory, first.project);
  await writeStoredRecord(directory, first.project, { ...record, engine: "0.1.0+00000000" });

  const log: string[] = [];
  const listening: Reporter = { stage: (_stage, _status, message) => log.push(message) };
  // No confirm hook at all is a build that has nobody to ask: a pipe, a log, a
  // script. It says what happened and goes on to build.
  const second = await runBuild("input.toml", { cwd: directory, reuse: false, model: `replay:${replay}` }, listening, "build");
  assert.equal(second.build.status, "success");
  assert.ok(log.some((message) => /Engine changed: 0\.1\.0\+00000000 -> /.test(message)), log.join("\n"));
  // Every function is asked for again. The announcement says so, so the build
  // has to do it even where the keys alone would have let it through: a stamp
  // that moved says the sources this compiler reads are not the ones the
  // stored objects were built from, whatever else about them agrees.
  assert.deepEqual(second.build.reused, {});
  assert.notEqual(second.build.engine, "0.1.0+00000000");
  assert.equal(second.build.engine, first.build.engine);
});

test("--recompile rebuilds every function even though the engine has not moved", async () => {
  const directory = await workspace("engine-recompile");
  const replay = await writableReplay(directory, REPLAY);
  const first = await runBuild("input.toml", { cwd: directory, reuse: false, model: `replay:${replay}` }, quiet, "build");
  assert.deepEqual(first.build.reused, {});

  const asked: string[] = [];
  const second = await runBuild(
    "input.toml",
    {
      cwd: directory,
      reuse: false,
      recompile: true,
      model: `replay:${replay}`,
      confirm: async (question) => {
        asked.push(question);
        return true;
      },
    },
    quiet,
    "build",
  );

  assert.equal(second.build.status, "success");
  assert.deepEqual(asked, [], "a build that was told to recompile asked anyway");
  assert.deepEqual(second.build.reused, {}, "the stored implementation was reused by a recompile");
  assert.equal(second.build.recompiled, true);
  // The record says so, so a reader of it can tell this build apart from one
  // that had to rebuild because its inputs moved.
  assert.equal((await storedRecord(directory, second.project)).recompiled, true);
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

test("a rebuild from stored implementations chooses among all of them, not the first", async () => {
  // An edit to the lowering reaches this path with the whole record intact, so
  // the choice is made again over every candidate the build stored. Stopping at
  // the first one that verified would ship whichever the record happened to
  // hold first, and a stored order is not a ranking.
  const directory = await workspace("incremental-choose", {
    ...INPUT,
    generation: { maxCandidates: 3, maxAttempts: 1 },
  });
  const replay = await reviews(directory, SOUND, SOUND, SOUND);
  const first = await runBuild("input.toml", { cwd: directory, reuse: false, model: `replay:${replay}` }, quiet, "build");
  assert.equal(first.build.status, "success");
  const stored = first.candidates?.dotProduct ?? [];
  assert.equal(stored.length, 3, `the build stored ${stored.length} candidate(s)`);

  // The same path an edit to the assembler takes: the objects are gone, so the
  // stored implementations are put through the toolchain again.
  await rm(join(directory, STATE_DIRECTORY, "projects/input/work"), { recursive: true, force: true });
  await writeFile(replay, JSON.stringify({ reviews: ["this is not a review"] }), "utf8");
  const second = await runBuild("input.toml", { cwd: directory, reuse: false, model: `replay:${replay}` }, quiet, "build");

  assert.equal(second.build.status, "success");
  assert.deepEqual(second.build.reused, {});
  // Every stored candidate was re-measured, so every one is in the record the
  // build wrote. One of them means the build stopped at the first that verified.
  const rebuilt = second.candidates?.dotProduct ?? [];
  assert.equal(rebuilt.length, 3, `the rebuild kept ${rebuilt.length} of 3 stored candidate(s)`);
  // And the candidate that was selected is one this build chose, not a default.
  assert.ok(second.build.selectedCandidates?.dotProduct?.startsWith("c"), JSON.stringify(second.build.selectedCandidates));
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

/**
 * A program is delivered twice: the store keeps the copy the build record
 * names, and the project directory gets the binary beside the sources, named
 * after the project. Both are named the way the platform names an executable,
 * so a build on Linux writes no `.exe` at all.
 */
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
  const directory = await scratch(`blaze-${name}-`);
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
 *
 * `twice` calls `scale2`, so the body the compiler would put where the call
 * was is a body that calls something itself, and inlining it would put two
 * calls in the caller. A callee like that stays a call, which is what leaves
 * the caller here with something it cannot be checked against on its own.
 */
const CALLING_PROGRAM = [
  "function scale2(n: number): number {",
  "  return n + n;",
  "}",
  "",
  "function twice(n: number): number {",
  "  return scale2(n) + scale2(n);",
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
 * The same shape with a callee that calls nothing: its body is a single block
 * the compiler is free to put where the call was, so a caller that calls it can
 * be verified against its own contract after all.
 */
const LEAF_CALLING_PROGRAM = [
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
  const directory = await scratch(`blaze-${name}-`);
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
  assert.deepEqual(Object.keys(outcome.contracts).sort(), ["main", "scale2", "twice"]);

  assert.ok(outcome.outputPath !== null);
  const execution = run(outcome.outputPath, [], { timeoutMs: 60_000 });
  assert.equal(execution.code, 0, execution.stderr);
  // 21 doubled twice over: `twice` is two calls to `scale2` and nothing else.
  assert.equal(execution.stdout, "84\n");

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
  // `twice` calls `scale2`, and `scale2` is a leaf, so the fold puts its body
  // where each of its calls was. What is left of `twice` is a function of its
  // own, and being called by `main` no longer costs it the probe.
  const [twiceOutcome] = generation.functions.twice.outcomes;
  assert.equal(twiceOutcome.probe?.called, true);
  // `scale2` is the callee the frontend could write a postcondition for, and it
  // is a function of its own: being called by `twice` does not cost it the
  // vectors it is checked against.
  const [scale2Outcome] = generation.functions.scale2.outcomes;
  assert.notEqual(scale2Outcome.verification, undefined);
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
  const directory = await scratch("blaze-writes-out-");
  await writeFile(join(directory, "main.ts"), LEAF_CALLING_PROGRAM, "utf8");
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

  // The whole point of putting the body there: the caller declares no call for
  // the callee and references no other symbol of the program, so it is linked
  // on its own and probed. A leaf is inlined whether a review asked for it or
  // the fold did, and what is delivered is the artifact that produced the
  // object either way.
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
  const directory = await scratch("blaze-writes-transitive-");
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

/**
 * A program of two modules whose callee carries a loop the compiler proved its
 * turns independent, so the object of that callee is compiled with a
 * team-of-threads pragma in it.
 *
 * `scale` recurses on a whole number and hands one back, so the turns of
 * `total`'s loop combine what it returns in any order, and the loop writes
 * nothing a turn of it found. Nothing about that is in the program's own
 * statements — the driver calls `total` and holds no loop — so the pragma is
 * in an object the driver links, and the link is where the threading runtime
 * has to be asked for.
 */
const PARALLEL_CALLING_PROGRAM = [
  "export function scale(depth: number): number {",
  "  if (depth > 0) {",
  "    return 1 + scale(depth - 1);",
  "  }",
  "  return 1;",
  "}",
  "",
  "export function total(depth: number, iterations: number): number {",
  "  let sum = 0;",
  "  for (var i = 0; i < iterations; i++) {",
  "    sum += scale(depth);",
  "  }",
  "  return sum;",
  "}",
  "",
].join("\n");

const PARALLEL_ENTRY = ['import { total } from "./lib.ts";', "", "console.log(total(4, 8));", ""].join("\n");

test("a program whose function carries a parallel loop links the threading runtime", async (t) => {
  const directory = await scratch("blaze-parallel-program-");
  await writeFile(join(directory, "lib.ts"), PARALLEL_CALLING_PROGRAM, "utf8");
  await writeFile(join(directory, "main.ts"), PARALLEL_ENTRY, "utf8");
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
  // The pragma is what an object of this program carries, and the delivered
  // binary is one that ran, so the link served it rather than dropping it.
  assert.ok(outcome.outputPath !== null);
  const execution = run(outcome.outputPath, [], { timeoutMs: 60_000 });
  assert.equal(execution.code, 0, execution.stderr);
  // Eight turns of `scale(4)`, which is 5.
  assert.equal(execution.stdout, "40\n");
});

test("a caller of a leaf is built as a function of its own, with no review asking for it", async (t) => {
  // Nothing proposes this rewrite. The fold asks the compiler's own question
  // about every call on the way to every object, and a callee that is a single
  // block has a body that can be put where the call was. What the caller gains
  // is the thing it did not have: with no call left in it, the object stands
  // on its own and is checked against its contract instead of by the program.
  const directory = await scratch("blaze-inline-leaf-");
  await writeFile(join(directory, "main.ts"), LEAF_CALLING_PROGRAM, "utf8");
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
  assert.ok(outcome.outputPath !== null);
  const execution = run(outcome.outputPath, [], { timeoutMs: 60_000 });
  assert.equal(execution.code, 0, execution.stderr);
  assert.equal(execution.stdout, "42\n", "and it prints what the source prints");

  const generation = JSON.parse(
    await readFile(join(directory, STATE_DIRECTORY, `projects/${outcome.project}/generation.json`), "utf8"),
  ) as { functions: Record<string, { outcomes: { probe?: { called: boolean; reason: string | null } }[] }> };
  assert.notEqual(generation.functions.main.outcomes[0]?.probe, undefined, "the caller is probed on its own");
  assert.equal(generation.functions.main.outcomes[0]?.probe?.called, true);
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
  const directory = await scratch(`blaze-${name}-`);
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

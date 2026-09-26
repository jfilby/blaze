import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBuild, runStored, inspectProject, STATE_DIRECTORY } from "../compiler.ts";
import { run } from "../core/process.ts";
import { CompilerError } from "../core/errors.ts";
import type { BuildStatus, ProgramContract, SourceInput, VerificationResult } from "../core/types.ts";

const REPLAY = new URL("./fixtures/dot-product-replay.json", import.meta.url).pathname;
const HELLO_WORLD_REPLAY = new URL("./fixtures/hello-world-replay.json", import.meta.url).pathname;
const EXAMPLE = new URL("../../examples/hello_world/blaze.json", import.meta.url).pathname;

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

test("reuse refuses to build a project whose source changed", async () => {
  const directory = await workspace("changed");
  await runBuild("input.json", { cwd: directory, reuse: false, model: `replay:${REPLAY}` }, quiet, "build");
  await writeFile(join(directory, "input.json"), JSON.stringify({ ...INPUT, source: `${INPUT.source}# changed\n` }), "utf8");

  await assert.rejects(
    () => runBuild("input.json", { cwd: directory, reuse: true, model: `replay:${REPLAY}` }, quiet, "build"),
    /source of input changed/,
  );
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
  const directory = await mkdtemp(join(tmpdir(), "blaze-example-"));
  const outcome = await runBuild(
    EXAMPLE,
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
  const directory = await mkdtemp(join(tmpdir(), "blaze-tty-"));
  const outcome = await runBuild(
    EXAMPLE,
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

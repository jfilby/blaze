import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBuild, STATE_DIRECTORY } from "../compiler.ts";
import { run } from "../core/process.ts";
import {
  isRuntimeSymbol,
  RUNTIME_ABI,
  RUNTIME_NAME,
  runtimeHeaderSource,
  runtimeSourceSource,
} from "../runtime/abi.ts";
import { generateRuntimeAdapterSource } from "../runtime/nim.ts";
import { buildUserPrompt, type PromptRequest } from "../ai/prompt.ts";
import { entryContract } from "../semantics/program.ts";
import { programOf } from "./phase.ts";
import type { SourceInput } from "../core/types.ts";

const REPLAY = new URL("./fixtures/runtime-dot-product-replay.json", import.meta.url).pathname;
const C_REPLAY = new URL("./fixtures/runtime-dot-product-c-replay.json", import.meta.url).pathname;
const EXAMPLE = new URL("../../examples/hosted_dot_product/blaze.json", import.meta.url).pathname;
const EXAMPLE_CANDIDATES = new URL("../../examples/hosted_dot_product/candidates.json", import.meta.url).pathname;

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
  generation: { maxCandidates: 1, maxAttempts: 1 },
  test: { randomCases: 4, maxLength: 32, seed: 11 },
  benchmark: { iterations: 50 },
};

const quiet = { stage: () => {} };

async function workspace(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `blaze-${name}-`));
  await writeFile(join(directory, "input.json"), JSON.stringify(INPUT, null, 2), "utf8");
  return directory;
}

/** The compiler state of a project, in the directory the build ran in. */
function project(directory: string): string {
  return join(directory, STATE_DIRECTORY, "projects/input");
}

/** One header line per vector: two lengths, then the scalar, then both buffers. */
const VECTORS = ["run", "3 3 3", "1 2 3", "1 1 1", "2 2 2", "4 4 4", "1 1 1 1", ""].join("\n");

function results(stdout: string): number[] {
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("RESULT "))
    .map((line) => Number(line.split(" ")[1]));
}

const nimAvailable = run("nim", ["--version"], { timeoutMs: 30_000 }).code === 0;

test("every runtime the ABI describes is implemented on both sides of the boundary", () => {
  const header = runtimeHeaderSource();
  const standalone = runtimeSourceSource();
  const adapter = generateRuntimeAdapterSource();
  for (const item of RUNTIME_ABI) {
    assert.ok(isRuntimeSymbol(item.symbol), `${item.symbol} must be referenceable by a candidate`);
    assert.ok(header.includes(`${item.symbol}(`), `${item.symbol} must be declared in ${RUNTIME_NAME}.h`);
    assert.ok(standalone.includes(`${item.symbol}(`), `${item.symbol} must be implemented by the compiler runtime`);
    assert.ok(adapter.includes(`proc ${item.symbol}*(`), `${item.symbol} must be implemented by the Nim adapter`);
  }
});

test("the managed object representation is the same in the header and in the adapter", () => {
  const header = runtimeHeaderSource();
  const adapter = generateRuntimeAdapterSource();
  assert.match(header, /#define BLAZE_RT_HEADER_SIZE 48u/);
  assert.match(adapter, /BlazeHeaderSize = 48'u64/);
  for (const field of ["magic", "base", "length", "alignment"]) {
    assert.ok(header.includes(field), `the header must describe ${field}`);
    assert.ok(adapter.includes(field), `the adapter must keep ${field}`);
  }
});

test("the prompt tells the model which runtime entry points it may call", () => {
  const files = { "module.nim": "proc dotProduct(a: ptr float32): float32 = 0.0\n" };
  const program = programOf("nim", files, "module.nim");
  const request: Omit<PromptRequest, "runtime"> = {
    contract: entryContract(program),
    unit: { file: "module.nim", function: "dotProduct" },
    program,
    sources: [{ path: "module.nim", source: files["module.nim"] }],
    target: { arch: "x86_64", os: "linux", abi: "sysv", cpu: "", features: [] },
    output: "machine",
    candidate: 1,
    attempt: 1,
  };

  const hosted = buildUserPrompt({ ...request, runtime: "nim" });
  assert.match(hosted, /RUNTIME/);
  assert.match(hosted, /Nim host runtime/);
  assert.match(hosted, /void\* blaze_rt_allocate\(size_t bytes\)/);
  assert.match(hosted, /blaze_rt_release/);
  assert.ok(
    !/The function is pure/.test(hosted),
    "a hosted candidate may allocate, so the prompt must not tell the model the function is pure",
  );

  const standalone = buildUserPrompt({ ...request, runtime: "none" });
  assert.match(standalone, /compiler runtime/);
});

test("a standalone build links the compiler runtime and a candidate may allocate through it", async () => {
  const directory = await workspace("runtime-none");
  const outcome = await runBuild(
    "input.json",
    { cwd: directory, reuse: false, model: `replay:${REPLAY}` },
    quiet,
    "build",
  );

  assert.equal(outcome.build.runtime, "none");
  assert.equal(outcome.verification.dotProduct[0]?.passed, true);
  assert.equal(outcome.build.status, "success");

  // The candidate calls the ABI, and the runtime object resolves it.
  const undefinedSymbols = run("nm", ["--undefined-only", join(project(directory), "work/dotProduct/c1.o")], { timeoutMs: 30_000 });
  assert.match(undefinedSymbols.stdout, /blaze_rt_allocate/);
  assert.match(undefinedSymbols.stdout, /blaze_rt_release/);
  const runtimeObject = run("nm", ["--defined-only", join(project(directory), `work/${RUNTIME_NAME}.o`)], { timeoutMs: 30_000 });
  for (const item of RUNTIME_ABI) {
    assert.ok(runtimeObject.stdout.includes(item.symbol), `${item.symbol} must be defined by the compiler runtime`);
  }

  const execution = run(outcome.outputPath!, [], { input: VECTORS, timeoutMs: 60_000 });
  assert.equal(execution.code, 0, execution.stderr);
  assert.deepEqual(results(execution.stdout), [6, 8]);
});

test("a C candidate may call the runtime ABI", async () => {
  const directory = await workspace("runtime-c");
  const outcome = await runBuild(
    "input.json",
    { cwd: directory, reuse: false, model: `replay:${C_REPLAY}`, output: "c" },
    quiet,
    "build",
  );

  assert.equal(outcome.build.runtime, "none");
  assert.equal(outcome.verification.dotProduct[0]?.passed, true);
  const source = await readFile(outcome.outputPath!, "utf8");
  assert.match(source, /#include "blaze_rt\.h"/);
  assert.match(source, /blaze_rt_allocate/);
});

test("a hosted build runs the candidate inside a Nim host program", async (t) => {
  if (!nimAvailable) {
    t.skip("the Nim compiler is not installed");
    return;
  }
  const directory = await workspace("runtime-nim");
  const outcome = await runBuild(
    "input.json",
    { cwd: directory, reuse: false, model: `replay:${REPLAY}`, runtime: "nim" },
    quiet,
    "build",
  );

  assert.equal(outcome.build.runtime, "nim");
  assert.equal(outcome.verification.dotProduct[0]?.passed, true);
  assert.equal(outcome.build.status, "success");

  // The host program and the adapter are compiler output, and the adapter
  // implements the whole ABI on Nim's allocator.
  const adapter = await readFile(join(project(directory), `work/dotProduct/${RUNTIME_NAME}.nim`), "utf8");
  assert.match(adapter, /proc blaze_rt_allocate\*/);
  const host = await readFile(join(project(directory), "work/dotProduct/c1_host.nim"), "utf8");
  assert.match(host, /import blaze_rt/);
  assert.match(host, /proc dotProduct\(/);

  // The delivered program is the Nim host, with the candidate linked into it.
  const symbols = run("nm", ["--defined-only", outcome.outputPath!], { timeoutMs: 30_000 });
  assert.ok(symbols.stdout.includes("dotProduct"), "the candidate must be linked into the host program");
  assert.ok(symbols.stdout.includes("blaze_rt_allocate"), "the adapter must provide the ABI");
  assert.ok(symbols.stdout.includes("NimMain"), "the delivered program must be a Nim program");
});

test("both runtimes answer the harness protocol identically", async (t) => {
  if (!nimAvailable) {
    t.skip("the Nim compiler is not installed");
    return;
  }
  const standalone = await runBuild(
    "input.json",
    { cwd: await workspace("runtime-parity-none"), reuse: false, model: `replay:${REPLAY}` },
    quiet,
    "build",
  );
  const hosted = await runBuild(
    "input.json",
    { cwd: await workspace("runtime-parity-nim"), reuse: false, model: `replay:${REPLAY}`, runtime: "nim" },
    quiet,
    "build",
  );

  const fromStandalone = run(standalone.outputPath!, [], { input: VECTORS, timeoutMs: 60_000 });
  const fromHosted = run(hosted.outputPath!, [], { input: VECTORS, timeoutMs: 60_000 });
  assert.equal(fromStandalone.code, 0, fromStandalone.stderr);
  assert.equal(fromHosted.code, 0, fromHosted.stderr);
  assert.deepEqual(results(fromHosted.stdout), results(fromStandalone.stdout));

  const benchRequest = "bench 100\n3 3 3\n1 2 3\n1 1 1\n";
  for (const runner of [standalone.outputPath!, hosted.outputPath!]) {
    const bench = run(runner, [], { input: benchRequest, timeoutMs: 60_000 });
    assert.equal(bench.code, 0, bench.stderr);
    const line = bench.stdout.split("\n").find((entry) => entry.startsWith("BENCH "));
    assert.ok(line !== undefined, `a benchmark must report a BENCH line, got ${JSON.stringify(bench.stdout)}`);
    const [, duration, sink] = line.split(" ");
    assert.ok(Number(duration) > 0, "the benchmark must report a positive duration");
    assert.equal(Number(sink), 600, "the sink must accumulate one result per iteration");
  }
});

test("the shipped hosted example builds against the Nim runtime", async (t) => {
  if (!nimAvailable) {
    t.skip("the Nim compiler is not installed");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "blaze-hosted-example-"));
  const outcome = await runBuild(
    EXAMPLE,
    { cwd: directory, reuse: false, model: `replay:${EXAMPLE_CANDIDATES}`, maxAttempts: 1 },
    quiet,
    "build",
  );

  assert.equal(outcome.project, "hosted_dot_product");
  assert.equal(outcome.build.runtime, "nim");
  assert.equal(outcome.verification.dotProduct[0]?.passed, true);

  const execution = run(outcome.outputPath!, [], { input: VECTORS, timeoutMs: 60_000 });
  assert.equal(execution.code, 0, execution.stderr);
  assert.deepEqual(results(execution.stdout), [6, 8]);
});

test("an unknown runtime is rejected before anything is built", async () => {
  const directory = await workspace("runtime-unknown");
  await assert.rejects(
    runBuild("input.json", { cwd: directory, reuse: false, model: `replay:${REPLAY}`, runtime: "go" as never }, quiet, "build"),
    /unknown runtime "go"/,
  );
});

test("a WebAssembly module cannot link a host runtime", async () => {
  const directory = await workspace("runtime-wasm");
  await assert.rejects(
    runBuild(
      "input.json",
      { cwd: directory, reuse: false, model: `replay:${REPLAY}`, output: "wasm", runtime: "nim" },
      quiet,
      "build",
    ),
    /cannot link the "nim" runtime/,
  );
});

test("a project file may name its runtime", async (t) => {
  if (!nimAvailable) {
    t.skip("the Nim compiler is not installed");
    return;
  }
  const directory = await workspace("runtime-project");
  await writeFile(
    join(directory, "input.json"),
    JSON.stringify({ ...INPUT, runtime: "nim" }, null, 2),
    "utf8",
  );
  const outcome = await runBuild(
    "input.json",
    { cwd: directory, reuse: false, model: `replay:${REPLAY}` },
    quiet,
    "build",
  );
  assert.equal(outcome.build.runtime, "nim");
  assert.equal(outcome.verification.dotProduct[0]?.passed, true);
});

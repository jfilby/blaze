import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeProject } from "./project.ts";
import { runBuild } from "../compiler.ts";
import { storeDirectory } from "./scratch.ts";
import { run } from "../core/process.ts";
import {
  isRuntimeSymbol,
  RUNTIME_ABI,
  RUNTIME_NAME,
  runtimeHeaderSource,
  runtimeSourceSource,
} from "../runtime/abi.ts";
import { buildStandaloneRuntime } from "../runtime/standalone.ts";
import { generateHostSource, generateRuntimeAdapterSource } from "../runtime/nim.ts";
import { generateHarness } from "../toolchain/linker.ts";
import { body } from "./definition.ts";
import { buildIrReviewPrompt, type ReviewRequest } from "../ai/review.ts";
import { printSemanticFunction } from "../semantics/ir-text.ts";
import { programWithSemantics } from "./phase.ts";
import type { FunctionContract, SourceInput } from "../core/types.ts";
import { scratch } from "./scratch.ts";

const REPLAY = new URL("./fixtures/runtime-dot-product-replay.json", import.meta.url).pathname;
const OBJECT_REPLAY = new URL("./fixtures/runtime-object-replay.json", import.meta.url).pathname;
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
  // The fixture this file replays is the IR the compiler resolves for this.
  output: "machine",
  generation: { maxCandidates: 1, maxAttempts: 1 },
  test: { randomCases: 4, maxLength: 32, seed: 11 },
  benchmark: { iterations: 50 },
};

/**
 * A program whose only function allocates. Its contract states the memory
 * effect, and that is what puts the runtime in reach of the lowering: the
 * model writes the IR, and the compiler writes the call the object is built by.
 */
const ALLOCATING: SourceInput = {
  language: "typescript",
  source: [
    "export function make(): any {",
    "  return { left: null, right: null };",
    "}",
    "const made = make();",
    "",
  ].join("\n"),
  target: { arch: "x86_64", os: "linux", abi: "sysv", cpu: "", features: [] },
  output: "machine",
  generation: { maxCandidates: 1, maxAttempts: 1 },
};

const quiet = { stage: () => {} };

async function workspace(name: string, input: SourceInput = INPUT): Promise<string> {
  const directory = await scratch(`blaze-${name}-`);
  await writeProject(join(directory, "input.toml"), input);
  return directory;
}

/** The compiler state of a project, in the directory the build ran in. */
function project(directory: string): Promise<string> {
  return storeDirectory(directory, "input");
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

test("a danger runtime still answers the ABI where its own arithmetic would not", async () => {
  // `danger` leaves out the checks a program makes of itself. Two of the
  // runtime's own answers are not such a check: `index - 2` underflows to a
  // pointer before the argument array, and `size - 1` underflows to the
  // largest size there is, which copied a whole number into a buffer of
  // nothing and ended the run on a fault. The ABI promises NaN for an index
  // that names no argument and 0 for a size of 0, in every mode.
  const probe = [
    "#include <stdio.h>",
    "#include <stddef.h>",
    `#include "${RUNTIME_NAME}.h"`,
    "int main(void) {",
    `  ${RUNTIME_NAME}_initialize();`,
    "  double args[1] = {5.0};",
    `  ${RUNTIME_NAME}_arguments_set(args, 1);`,
    `  printf("%f\\n", ${RUNTIME_NAME}_argv(0));`,
    `  printf("%f\\n", ${RUNTIME_NAME}_argv(1));`,
    `  printf("%f\\n", ${RUNTIME_NAME}_argv(2));`,
    `  printf("%f\\n", ${RUNTIME_NAME}_argv(3));`,
    `  printf("%zu\\n", ${RUNTIME_NAME}_format_number(1.5, (unsigned char*)0, 0));`,
    `  ${RUNTIME_NAME}_finalize();`,
    "  return 0;",
    "}",
    "",
  ].join("\n");
  for (const mode of ["debug", "danger"] as const) {
    const directory = await scratch(`blaze-argv-${mode}-`);
    await writeFile(join(directory, `${RUNTIME_NAME}.h`), runtimeHeaderSource(), "utf8");
    await writeFile(join(directory, "runtime.c"), runtimeSourceSource(mode), "utf8");
    await writeFile(join(directory, "probe.c"), probe, "utf8");
    const binary = join(directory, "probe");
    const built = run("gcc", ["-std=c11", "-O0", "-I", directory, join(directory, "probe.c"), join(directory, "runtime.c"), "-o", binary, "-lm"], {
      timeoutMs: 120_000,
    });
    assert.equal(built.code, 0, built.stderr);
    const result = run(binary, [], { timeoutMs: 60_000 });
    assert.equal(result.code, 0, `${mode} must answer rather than fault`);
    assert.deepEqual(
      result.stdout.trim().split("\n"),
      ["nan", "nan", "5.000000", "nan", "0"],
      `${mode}: an index that names no argument is NaN, and a buffer of nothing is written nothing`,
    );
  }
});

test("an argument read before the host gave any is NaN in every mode", async () => {
  // The probe harness a candidate is checked by calls the function without
  // giving the runtime any arguments, so `blaze_rt_arguments` is still the null
  // it starts as. A read of index 2 is the first argument, which is one the host
  // never gave, and answering it means reading a null pointer: the check that
  // decides it is the runtime's own arithmetic over an index the program built,
  // not a check a program makes of itself, so `danger` keeps it. Without it a
  // candidate of any program that reads `process.argv` is killed by the probe
  // before it is ever run. NaN rather than 0 is the answer the source gives:
  // reading an argument a program was not given is `+undefined`.
  const probe = [
    "#include <stdio.h>",
    `#include "${RUNTIME_NAME}.h"`,
    "int main(void) {",
    `  ${RUNTIME_NAME}_initialize();`,
    `  printf("%f\\n", ${RUNTIME_NAME}_argv(2));`,
    `  printf("%f\\n", ${RUNTIME_NAME}_argv(3));`,
    `  printf("%zu\\n", ${RUNTIME_NAME}_argv_count());`,
    `  ${RUNTIME_NAME}_finalize();`,
    "  return 0;",
    "}",
    "",
  ].join("\n");
  for (const mode of ["debug", "danger"] as const) {
    const directory = await scratch(`blaze-argv-none-${mode}-`);
    await writeFile(join(directory, `${RUNTIME_NAME}.h`), runtimeHeaderSource(), "utf8");
    await writeFile(join(directory, "runtime.c"), runtimeSourceSource(mode), "utf8");
    await writeFile(join(directory, "probe.c"), probe, "utf8");
    const binary = join(directory, "probe");
    const built = run("gcc", ["-std=c11", "-O0", "-I", directory, join(directory, "probe.c"), join(directory, "runtime.c"), "-o", binary, "-lm"], {
      timeoutMs: 120_000,
    });
    assert.equal(built.code, 0, built.stderr);
    const result = run(binary, [], { timeoutMs: 60_000 });
    assert.equal(result.code, 0, `${mode} must answer rather than fault`);
    // No arguments were given, so the count is the program and the file it runs
    // and every argument the program asked for is the NaN the ABI promises.
    assert.deepEqual(result.stdout.trim().split("\n"), ["nan", "nan", "2"], `${mode}: no argument is NaN, and two entries are always there`);
  }
});

test("a released block is the next block of its size, and a null release is nothing", async () => {
  // Two things the small-block pool decides. A block that is released goes back
  // onto the list of its own class, so the block a program gets next is one it
  // had before — and it is cleared on the way out, because a block the program
  // wrote to is not the zeroed block a cleared block promises. And the ABI says
  // a null pointer is ignored, in every mode: a program releases a name when it
  // goes out of scope, and a name whose value is nothing is a program that
  // never made one. Without that, `danger` reads the header of a null pointer
  // on the first release of a value that was never built.
  const probe = [
    "#include <stdio.h>",
    "#include <string.h>",
    `#include "${RUNTIME_NAME}.h"`,
    "int main(void) {",
    `  ${RUNTIME_NAME}_initialize();`,
    `  ${RUNTIME_NAME}_release(NULL);`,
    "  /* Two blocks of a class are never the same block, and both are cleared. */",
    "  for (int round = 0; round < 3; round += 1) {",
    "    void* held[128];",
    "    for (int at = 0; at < 128; at += 1) {",
    "      held[at] = blaze_rt_object_new(16, 8);",
    "      if (held[at] == NULL) return 1;",
    "      if (((unsigned long)held[at] % 8) != 0) return 2;",
    "      if (((unsigned char*)held[at])[0] != 0) return 3;",
    "      if (((unsigned char*)held[at])[16] != 0) return 4;",
    "      if (blaze_rt_object_size(held[at]) != 16) return 5;",
    "      memset(held[at], 0xab, 16);",
    "    }",
    "    for (int at = 1; at < 128; at += 1) if (held[at] == held[at - 1]) return 6;",
    "    for (int at = 0; at < 128; at += 1) blaze_rt_release(held[at]);",
    "  }",
    "  /* A reused block is cleared again, which is what a cleared block is. */",
    "  void* again = blaze_rt_object_new(16, 8);",
    "  if (again == NULL) return 7;",
    "  for (int at = 0; at < 17; at += 1) if (((unsigned char*)again)[at] != 0) return 8;",
    "  /* A block that is held twice is released twice and freed once. */",
    "  void* shared = blaze_rt_object_new(32, 8);",
    "  blaze_rt_retain(shared);",
    "  memset(shared, 0x11, 32);",
    "  blaze_rt_release(shared);",
    "  if (((unsigned char*)shared)[0] != 0x11) return 9;",
    "  blaze_rt_release(shared);",
    "  /* A block too large for a class is the host's, and comes back from it. */",
    "  void* large = blaze_rt_object_new(65536, 8);",
    "  if (large == NULL) return 10;",
    "  if (((unsigned char*)large)[65536] != 0) return 11;",
    "  blaze_rt_release(large);",
    `  ${RUNTIME_NAME}_finalize();`,
    "  return 0;",
    "}",
    "",
  ].join("\n");
  for (const mode of ["debug", "danger"] as const) {
    const directory = await scratch(`blaze-pool-${mode}-`);
    await writeFile(join(directory, `${RUNTIME_NAME}.h`), runtimeHeaderSource(), "utf8");
    await writeFile(join(directory, "runtime.c"), runtimeSourceSource(mode), "utf8");
    await writeFile(join(directory, "probe.c"), probe, "utf8");
    const binary = join(directory, "probe");
    const built = run("gcc", ["-std=c11", "-O2", "-I", directory, join(directory, "probe.c"), join(directory, "runtime.c"), "-o", binary, "-lm"], {
      timeoutMs: 120_000,
    });
    assert.equal(built.code, 0, built.stderr);
    const result = run(binary, [], { timeoutMs: 60_000 });
    assert.equal(result.code, 0, `${mode}: the pool must answer every block rather than fault (status ${String(result.code)})`);
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

test("a review of a function that allocates names no runtime symbol", () => {
  // The source allocates an object, and the IR the compiler resolved carries
  // that as an effect: the call into the runtime is written by the lowering,
  // so nothing a model reads names one, and nothing a model is asked for can
  // put one into the artifact.
  const files = {
    "module.ts":
      "export function make(): any {\n  return { left: null, right: null };\n}\nconst made = make();\n",
  };
  const { program, semantics } = programWithSemantics("typescript", files, "module.ts");
  const request: ReviewRequest = {
    stage: "ir",
    contract: program.files[0].functions.make,
    unit: { file: "module.ts", function: "make" },
    program,
    semantics,
    target: { arch: "x86_64", os: "linux", abi: "sysv", cpu: "", features: [] },
    output: "machine",
    candidate: 1,
    attempt: 1,
    candidates: 1,
    artifact: printSemanticFunction(semantics.make),
    artifactNote: null,
    feedback: [],
    refusals: [],
  };

  const prompt = buildIrReviewPrompt(request);
  assert.ok(prompt.includes(printSemanticFunction(semantics.make)), "the review reads the resolved IR");
  assert.match(prompt, /allocates objects: yes|allocates/);
  assert.doesNotMatch(prompt, /blaze_rt_object_new/);
  assert.doesNotMatch(prompt, /blaze_rt_release/);
  assert.doesNotMatch(prompt, /blaze_rt_allocate/);
});

test("a standalone build links the compiler runtime, and a function that allocates reaches it", async () => {
  const directory = await workspace("runtime-none");
  const outcome = await runBuild(
    "input.toml",
    { cwd: directory, reuse: false, model: `replay:${REPLAY}` },
    quiet,
    "build",
  );

  assert.equal(outcome.build.runtime, "none");
  assert.equal(outcome.verification.dotProduct[0]?.passed, true);
  assert.equal(outcome.build.status, "success");

  // What a lowering reaches for, the runtime object is there to define, so the
  // whole ABI is in it rather than the few entries one candidate happened to
  // use.
  const runtimeObject = run("nm", ["--defined-only", join(await project(directory), `work/${RUNTIME_NAME}.o`)], { timeoutMs: 30_000 });
  for (const item of RUNTIME_ABI) {
    assert.ok(runtimeObject.stdout.includes(item.symbol), `${item.symbol} must be defined by the compiler runtime`);
  }

  const execution = run(outcome.outputPath!, [], { input: VECTORS, timeoutMs: 60_000 });
  assert.equal(execution.code, 0, execution.stderr);
  assert.deepEqual(results(execution.stdout), [6, 8]);

  // A function whose contract says it allocates is the one that reaches the
  // runtime: the answer is the effect, and the call the object is built by is
  // the compiler's to write, so it lands in the object unresolved and the
  // runtime beside it is what settles it.
  const allocating = await workspace("runtime-none-object", ALLOCATING);
  const built = await runBuild(
    "input.toml",
    { cwd: allocating, reuse: false, model: `replay:${OBJECT_REPLAY}` },
    quiet,
    "build",
  );
  assert.equal(built.build.status, "success");
  const undefinedSymbols = run("nm", ["--defined-only", join(await project(allocating), "work/make/c1.o")], { timeoutMs: 30_000 });
  assert.doesNotMatch(undefinedSymbols.stdout, /blaze_rt_/, "a call the runtime defines belongs to the runtime object");
  const asked = run("nm", ["--undefined-only", join(await project(allocating), "work/make/c1.o")], { timeoutMs: 30_000 });
  assert.match(asked.stdout, /blaze_rt_object_new/, "a function that allocates must reach the runtime");
  const beside = run("nm", ["--defined-only", join(await project(allocating), `work/${RUNTIME_NAME}.o`)], { timeoutMs: 30_000 });
  for (const line of asked.stdout.split("\n").filter((entry) => /\sU\s/.test(entry))) {
    const symbol = line.trim().split(/\s+/)[1] ?? "";
    assert.ok(beside.stdout.includes(symbol), `the runtime object must define ${symbol}, which the candidate leaves to it`);
  }
});

test("the C a build compiles includes the runtime ABI, so a function that allocates calls through it", async () => {
  const directory = await workspace("runtime-c", ALLOCATING);
  const outcome = await runBuild(
    "input.toml",
    { cwd: directory, reuse: false, model: `replay:${OBJECT_REPLAY}`, output: "c" },
    quiet,
    "build",
  );

  assert.equal(outcome.build.runtime, "none");
  assert.equal(outcome.build.status, "success");
  // What a `c` build compiles is the C the compiler wrote from the IR, and
  // what it is built from is the header the ABI is declared in: an object the
  // function allocates cannot be built without one. Which entry point it asks
  // for is the emitter's own business — a literal that writes every field of
  // its layout is given a block nothing cleared, and one that leaves a field
  // out a cleared block — so what is checked is that what it asks for is an
  // entry point the ABI declares, and that it asks for something.
  const source = await readFile(join(await project(directory), "work/make/c1.c"), "utf8");
  assert.match(source, /#include "blaze_rt\.h"/);
  const asked = [...new Set(source.match(/blaze_rt_[a-z_]+/g) ?? [])];
  assert.ok(asked.length > 0, "a function that allocates must reach the runtime");
  for (const symbol of asked) {
    assert.ok(isRuntimeSymbol(symbol), `${symbol} is not an entry point of the ABI`);
  }
});

test("a result too small for seventeen decimal places is still the number it is", async (t) => {
  if (!nimAvailable) {
    t.skip("the Nim compiler is not installed");
    return;
  }
  // The verifier reads a double off whichever host ran and holds it to the
  // contract, so a correct result has to survive being printed by either.
  // Nim's `ffDecimal` counts the digits *after the point*, so a result of
  // 1e-18 printed as seventeen zeroes and read back as zero, and a correct
  // candidate was refused on the hosted build and passed on the standalone
  // one. The C harness prints seventeen significant digits and this now does
  // the same.
  const contract: FunctionContract = {
    version: "1",
    function: {
      name: "small",
      symbol: "small",
      params: [
        { name: "x", type: "f64" },
        { name: "a", type: "ptr<f64>" },
        { name: "n", type: "usize" },
      ],
      returns: "f64",
    },
    requires: [],
    ensures: ["result == (x * 1e-18)"],
    memory: { reads: [], writes: [], aliasing: [] },
    effects: [],
    numeric: { floatingPoint: "ieee754", rounding: "nearest", fastMath: false },
    optimize: { primary: "throughput" },
    definition: body([{ kind: "result", value: { k: "ident", name: "x" }, line: 1 }]),
  };
  const candidate = "double small(double x, double* a, unsigned long n) { (void)a; (void)n; return x * 1e-18; }\n";
  const request = "run\n1 1 1\n1\n";
  const root = await scratch("blaze-float-");

  const plain = join(root, "plain");
  await mkdir(plain);
  await writeFile(join(plain, "blaze_rt.h"), runtimeHeaderSource(), "utf8");
  await writeFile(join(plain, "blaze_rt.c"), runtimeSourceSource(), "utf8");
  await writeFile(join(plain, "small.c"), candidate, "utf8");
  await writeFile(join(plain, "harness.c"), generateHarness(contract, request), "utf8");
  const built = run("gcc", ["-std=c11", "-O2", "-D_POSIX_C_SOURCE=200809L", "-o", "h", "harness.c", "small.c", "blaze_rt.c", "-lm"], {
    cwd: plain,
    timeoutMs: 120_000,
  });
  assert.equal(built.code, 0, built.stderr);
  const fromPlain = run(join(plain, "h"), [], { input: request, cwd: plain });
  assert.equal(fromPlain.code, 0, fromPlain.stderr);

  const hosted = join(root, "hosted");
  await mkdir(hosted);
  await writeFile(join(hosted, "blaze_rt.nim"), generateRuntimeAdapterSource(), "utf8");
  await writeFile(join(hosted, "small.c"), candidate, "utf8");
  await writeFile(join(hosted, "host.nim"), generateHostSource(contract, request), "utf8");
  const object = run("gcc", ["-std=c11", "-O2", "-c", "-o", "small.o", "small.c"], { cwd: hosted });
  assert.equal(object.code, 0, object.stderr);
  const linked = run("nim", ["c", "--hints:off", "--warnings:off", `--nimcache:${join(hosted, "nimcache")}`, `--passL:${join(hosted, "small.o")}`, `--out:${join(hosted, "h")}`, "host.nim"], {
    cwd: hosted,
    timeoutMs: 600_000,
  });
  assert.equal(linked.code, 0, linked.stderr);
  const fromHosted = run(join(hosted, "h"), [], { input: request, cwd: hosted });
  assert.equal(fromHosted.code, 0, fromHosted.stderr);

  for (const [host, output] of [
    ["the C harness", fromPlain],
    ["the Nim host", fromHosted],
  ] as const) {
    const line = output.stdout.split("\n").find((entry) => entry.startsWith("RESULT "));
    assert.ok(line !== undefined, `${host} printed no RESULT: ${JSON.stringify(output.stdout)}`);
    assert.equal(Number(line.split(" ")[1]), 1e-18, `${host} must print a form that reads back as the double computed`);
  }
});

test("an unknown runtime is rejected before anything is built", async () => {
  const directory = await workspace("runtime-unknown");
  await assert.rejects(
    runBuild("input.toml", { cwd: directory, reuse: false, model: `replay:${REPLAY}`, runtime: "go" as never }, quiet, "build"),
    /unknown runtime "go"/,
  );
});

test("a WebAssembly module cannot link a host runtime", async () => {
  const directory = await workspace("runtime-wasm");
  await assert.rejects(
    runBuild(
      "input.toml",
      { cwd: directory, reuse: false, model: `replay:${REPLAY}`, output: "wasm", runtime: "nim" },
      quiet,
      "build",
    ),
    /cannot link the "nim" runtime/,
  );
});

test("argv_count counts the program and the file it runs, as process.argv does", async (t) => {
  if (!nimAvailable) {
    t.skip("the Nim compiler is not installed");
    return;
  }
  const directory = await scratch("blaze-argv-count-");
  const probe = [
    "var args: array[3, float64] = [5, 7, 9]",
    `${RUNTIME_NAME}_arguments_set(cast[ptr UncheckedArray[float64]](addr args[0]), csize_t(3))`,
    `echo ${RUNTIME_NAME}_argv_count()`,
    `echo ${RUNTIME_NAME}_argv(0)`,
    `echo ${RUNTIME_NAME}_argv(2)`,
    `echo ${RUNTIME_NAME}_argv(4)`,
    `echo ${RUNTIME_NAME}_argv(5)`,
  ].join("\n");
  const source = join(directory, "probe.nim");
  await writeFile(source, `${generateRuntimeAdapterSource()}\n${probe}\n`, "utf8");
  const binary = join(directory, "probe");
  const built = run("nim", ["c", "--hints:off", "--warnings:off", "-d:release", `--nimcache:${join(directory, "cache")}`, `-o:${binary}`, source], { timeoutMs: 300_000 });
  assert.equal(built.code, 0, built.stderr);
  const out = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(out.code, 0, out.stderr);

  // Three arguments are five entries of process.argv, and the first argument
  // sits at index 2: a count of three would send a program that walked
  // process.argv past its end, and one that returned the raw count. Index 0 and
  // the index past the end name no argument at all, and are NaN.
  assert.deepEqual(out.stdout.trim().split("\n"), ["5", "nan", "5.0", "9.0", "nan"]);
});

test("an over-aligned object is writable across its whole length in the Nim adapter", async (t) => {
  if (!nimAvailable) {
    t.skip("the Nim compiler is not installed");
    return;
  }
  const directory = await scratch("blaze-align-");
  const probe = [
    "for align in [16'u64, 32, 64, 128]:",
    "  let n = 20",
    "  let p = blaze_rt_object_new(csize_t(n), csize_t(align))",
    "  for i in 0 ..< n:",
    "    cast[ptr UncheckedArray[uint8]](p)[i] = uint8(i + 1)",
    "  for i in 0 ..< n:",
    "    if cast[ptr UncheckedArray[uint8]](p)[i] != uint8(i + 1):",
    "      echo \"MISMATCH \", align",
    `  if cast[uint](p) mod align != 0: echo "MISALIGNED ", align`,
    "  if blaze_rt_object_size(p) != csize_t(n): echo \"WRONGSIZE \", align",
    "  blaze_rt_release(p)",
    "echo \"done\"",
  ].join("\n");
  const source = join(directory, "align.nim");
  await writeFile(source, `${generateRuntimeAdapterSource()}\n${probe}\n`, "utf8");
  const binary = join(directory, "align");
  const built = run("nim", ["c", "--hints:off", "--warnings:off", "-d:release", `--nimcache:${join(directory, "cache")}`, `-o:${binary}`, source], { timeoutMs: 300_000 });
  assert.equal(built.code, 0, built.stderr);
  const out = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(out.code, 0, out.stderr);

  // The block covers the gap the alignment leaves as well as the bytes, and
  // the header follows the payload: sizing it by the bytes alone returned a
  // pointer past the end and a header nothing could read.
  assert.equal(out.stdout.trim(), "done");
});

test("an object alignment that leaves the allocator no budget is refused, not wrapped", async () => {
  // The budget the block allocator checks is the cap less the alignment less
  // the header. An alignment of exactly the cap made that subtraction wrap, so
  // the guard read as the whole size_t range, the total wrapped into a 4 KiB
  // allocation, and the payload was then placed a terabyte from it: the
  // header write was a wild write rather than a refusal.
  const directory = await scratch("blaze-alloc-");
  const runtime = await buildStandaloneRuntime(directory);
  const compile = async (request: string[], name: string): Promise<string> => {
    const path = join(directory, `${name}.c`);
    await writeFile(
      path,
      [
        "#include <stdio.h>",
        `#include "${RUNTIME_NAME}.h"`,
        "int main(void) {",
        "  setbuf(stdout, NULL);",
        "  unsigned char* at;",
        "  void* block;",
        ...request,
        "  return 0;",
        "}",
      ].join("\n"),
      "utf8",
    );
    const built = run("gcc", ["-std=c11", "-O2", "-I", directory, "-o", join(directory, name), path, runtime.objectPath]);
    assert.equal(built.code, 0, built.stderr);
    return join(directory, name);
  };

  const atCap = await compile(
    [
      "  block = blaze_rt_object_new((size_t)BLAZE_RT_MAX_ALLOCATION, (size_t)BLAZE_RT_MAX_ALLOCATION);",
      '  printf("answered %p\\n", block);',
    ],
    "at_cap",
  );
  const refused = run(atCap, [], { timeoutMs: 60_000 });
  assert.equal(refused.code, 2, `an alignment at the cap must be refused, not answered:\n${refused.stdout}`);
  assert.match(refused.stderr, /alignment is too large/);

  // The ordinary alignments a contract actually asks for still work, and the
  // block is writable across its whole length.
  const ordinary = await compile(
    [
      "  block = blaze_rt_object_new(64, 64);",
      '  if (blaze_rt_object_size(block) != 64) { printf("wrong size\\n"); return 1; }',
      '  if ((size_t)block % 64 != 0) { printf("misaligned\\n"); return 1; }',
      "  at = (unsigned char*)block;",
      "  for (size_t i = 0; i < 64; i += 1) at[i] = (unsigned char)i;",
      '  for (size_t i = 0; i < 64; i += 1) if (at[i] != (unsigned char)i) { printf("corrupt\\n"); return 1; }',
      "  blaze_rt_release(block);",
      '  printf("ok\\n");',
    ],
    "ordinary",
  );
  const worked = run(ordinary, [], { timeoutMs: 60_000 });
  assert.equal(worked.code, 0, worked.stderr);
  assert.equal(worked.stdout.trim(), "ok");
});

test("a processor count past the stack arrays does not write past them", async () => {
  // The jobs and the thread handles of a team are two arrays on the stack of
  // whoever asked for the team, and the part count came from a processor count
  // read out of the host with nothing bounding it. A machine reporting more
  // processors than the arrays hold wrote one part past the end of each, over
  // the caller's frame: a segfault rather than a team. The count the host
  // reports is stubbed here, because a test machine has four of them and the
  // bound is what is under test.
  const directory = await scratch("blaze-parts-");
  const runtime = await buildStandaloneRuntime(directory);
  await writeFile(
    join(directory, "stub.c"),
    ["#include <unistd.h>", "long sysconf(int name) { (void)name; return 4096; }", ""].join("\n"),
    "utf8",
  );
  await writeFile(
    join(directory, "parts.c"),
    [
      "#include <stdio.h>",
      `#include "${RUNTIME_NAME}.h"`,
      "static double* out;",
      "static void turn(void* frame, size_t begin, size_t end) {",
      "  (void)frame;",
      "  for (size_t at = begin; at < end; at += 1) out[at] = (double)at * 2.0;",
      "}",
      "int main(void) {",
      "  setbuf(stdout, NULL);",
      "  const size_t count = 512;",
      `  out = (double*)${RUNTIME_NAME}_allocate(count * sizeof(double));`,
      `  ${RUNTIME_NAME}_parallel_for(count, turn, 0);`,
      "  for (size_t at = 0; at < count; at += 1) {",
      "    if (out[at] != (double)at * 2.0) { printf(\"wrong at %zu\\n\", at); return 1; }",
      "  }",
      '  printf("ok\\n");',
      "  return 0;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  const binary = join(directory, "parts");
  const built = run(
    "gcc",
    ["-std=c11", "-O1", "-I", directory, "-o", binary, join(directory, "parts.c"), join(directory, "stub.c"), runtime.objectPath, "-lpthread", "-lm"],
    { timeoutMs: 120_000 },
  );
  assert.equal(built.code, 0, built.stderr);
  const result = run(binary, [], { timeoutMs: 120_000 });
  assert.equal(result.code, 0, `a team is cut into what the stack holds:\n${result.stderr}`);
  assert.equal(result.stdout.trim(), "ok");
});

test("a string appended to itself is that string twice, and the block it left is not read", async () => {
  // The emitter binds one temporary per interpolated part, so a string written
  // into itself is one block named on both sides of the append. When the block
  // has no room to grow into, the append allocates, copies the left side, gives
  // the left side back and only then reads the right one — which is that block,
  // already released. A block too large for the pool is handed straight back to
  // the host, so the read after the release is not a value that happens to still
  // be there: it is memory the allocator took, and it faulted.
  const probe = [
    "#include <stdio.h>",
    "#include <stdlib.h>",
    "#include <string.h>",
    `#include "${RUNTIME_NAME}.h"`,
    "int main(void) {",
    `  ${RUNTIME_NAME}_initialize();`,
    "  const size_t n = 400000;",
    "  char* big = (char*)malloc(n + 1);",
    "  memset(big, 'A', n);",
    "  big[n] = 0;",
    `  const char* s = ${RUNTIME_NAME}_string_new((const unsigned char*)big, n);`,
    "  free(big);",
    `  const char* joined = ${RUNTIME_NAME}_string_append(s, s);`,
    `  if (${RUNTIME_NAME}_string_length(joined) != 2 * n) { printf("length %zu\\n", ${RUNTIME_NAME}_string_length(joined)); return 1; }`,
    "  for (size_t at = 0; at < 2 * n; at += 1) {",
    "    if (joined[at] != 'A') { printf(\"byte %zu is %c\\n\", at, joined[at]); return 2; }",
    "  }",
    `  ${RUNTIME_NAME}_release((void*)joined);`,
    `  ${RUNTIME_NAME}_finalize();`,
    '  printf("ok\\n");',
    "  return 0;",
    "}",
    "",
  ].join("\n");
  const directory = await scratch("blaze-self-append-");
  await writeFile(join(directory, `${RUNTIME_NAME}.h`), runtimeHeaderSource(), "utf8");
  await writeFile(join(directory, "runtime.c"), runtimeSourceSource("release"), "utf8");
  await writeFile(join(directory, "probe.c"), probe, "utf8");
  const binary = join(directory, "probe");
  const built = run("gcc", ["-std=c11", "-O2", "-I", directory, join(directory, "probe.c"), join(directory, "runtime.c"), "-o", binary, "-lm"], {
    timeoutMs: 120_000,
  });
  assert.equal(built.code, 0, built.stderr);
  const result = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(result.code, 0, `a string appended to itself must answer that string twice: ${result.stderr}`);
  assert.equal(result.stdout.trim(), "ok");
});

test("a block the slab pools is refused when it is released, as one given to the host is", async () => {
  // The magic is what stands between a released pointer and a second use of it,
  // and the pooled path returned before poisoning it: every block small enough
  // for a slab — every small object, every short string, every small array —
  // kept reading as live, so the check never fired for any of them. A second
  // release then linked the block to itself and the class handed the same
  // address out for ever, which is two live values in one piece of memory and a
  // program that writes through one and reads through the other.
  const probe = [
    "#include <stdio.h>",
    "#include <stdint.h>",
    "#include <stddef.h>",
    `#include "${RUNTIME_NAME}.h"`,
    "",
    "int main(void) {",
    "  void* block = blaze_rt_allocate(64);",
    "  const blaze_rt_header* header = (const blaze_rt_header*)((const char*)block - BLAZE_RT_HEADER_SIZE);",
    '  if (header->magic != BLAZE_RT_MAGIC) { printf("a fresh block does not read as live\\n"); return 1; }',
    `  ${RUNTIME_NAME}_release(block);`,
    '  if (header->magic == BLAZE_RT_MAGIC) { printf("a pooled block still reads as live after its release\\n"); return 2; }',
    `  ${RUNTIME_NAME}_release(block);`,
    '  printf("a second release was refused\\n");',
    "  return 3;",
    "}",
    "",
  ].join("\n");
  const directory = await scratch("blaze-pooled-release-");
  await writeFile(join(directory, `${RUNTIME_NAME}.h`), runtimeHeaderSource(), "utf8");
  await writeFile(join(directory, "runtime.c"), runtimeSourceSource("debug"), "utf8");
  await writeFile(join(directory, "probe.c"), probe, "utf8");
  const binary = join(directory, "probe");
  const built = run("gcc", ["-std=c11", "-O2", "-I", directory, join(directory, "probe.c"), join(directory, "runtime.c"), "-o", binary, "-lm"], {
    timeoutMs: 120_000,
  });
  assert.equal(built.code, 0, built.stderr);
  // The refusal is the runtime's own: it prints its reason and stops, so the
  // probe's own last line is never reached.
  const result = run(binary, [], { timeoutMs: 60_000 });
  assert.notEqual(result.code, 3, `a second release of a pooled block must be refused: ${result.stdout}`);
  assert.match(result.stderr, /not a live runtime pointer/);
});

test("a region hands out a block whose read past the end is a zero, as the language answers it", async () => {
  // The alignment is added to a block on top of the payload rather than taken
  // out of the slack the allocator leaves, and those bytes are what a read past
  // the end of an array lands on: the program is allowed to make that read and
  // the language answers it as a zero. A region allocates with a call that
  // clears nothing, so it has to clear the slack as well as the payload — and
  // the region is rewound at the top of every turn, so the slack is exactly the
  // bytes the previous turn wrote there. Clearing the payload alone left a
  // fresh array reading back what the last one wrote past its end.
  const probe = [
    "#include <stdio.h>",
    `#include "${RUNTIME_NAME}.h"`,
    "int main(void) {",
    `  ${RUNTIME_NAME}_initialize();`,
    "  double seen[2] = {0.0, 0.0};",
    "  for (int turn = 0; turn < 2; turn += 1) {",
    `    ${RUNTIME_NAME}_region_enter();`,
    `    double* a = (double*)${RUNTIME_NAME}_array_new(4, sizeof(double));`,
    "    if (a == NULL) return 1;",
    "    a[0] = 1.0;",
    "    if (turn == 0) a[4] = 42.0;",
    "    seen[turn] = a[4];",
    `    ${RUNTIME_NAME}_region_leave();`,
    "  }",
    `  ${RUNTIME_NAME}_finalize();`,
    '  printf("%g %g\\n", seen[0], seen[1]);',
    "  return 0;",
    "}",
    "",
  ].join("\n");
  const directory = await scratch("blaze-region-slack-");
  await writeFile(join(directory, `${RUNTIME_NAME}.h`), runtimeHeaderSource(), "utf8");
  await writeFile(join(directory, "runtime.c"), runtimeSourceSource("release"), "utf8");
  await writeFile(join(directory, "probe.c"), probe, "utf8");
  const binary = join(directory, "probe");
  const built = run("gcc", ["-std=c11", "-O2", "-I", directory, join(directory, "probe.c"), join(directory, "runtime.c"), "-o", binary, "-lm"], {
    timeoutMs: 120_000,
  });
  assert.equal(built.code, 0, built.stderr);
  const result = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), "42 0", "the second turn's array is a fresh one, so it reads zero past its end");
});

test("a region opened inside an open region does not take the outer turn's blocks", async () => {
  // A turn of a marked loop may call a function whose own turn is marked too:
  // the compiler marks the innermost loop it can on a path, which is a
  // statement about one body and says nothing about a call into another. The
  // inner region rewinding the shared cursor handed the outer turn's blocks out
  // a second time while the outer turn was still reading them, so a node written
  // before the call read back as whatever the callee built after it.
  const probe = [
    "#include <stdio.h>",
    `#include "${RUNTIME_NAME}.h"`,
    "int main(void) {",
    `  ${RUNTIME_NAME}_initialize();`,
    "  double seen[2] = {0.0, 0.0};",
    "  for (int turn = 0; turn < 2; turn += 1) {",
    `    ${RUNTIME_NAME}_region_enter();`,
    `    double* node = (double*)${RUNTIME_NAME}_array_new(4, sizeof(double));`,
    "    if (node == NULL) return 1;",
    "    node[0] = 7.0;",
    `    ${RUNTIME_NAME}_region_enter();`,
    `    double* scratch = (double*)${RUNTIME_NAME}_array_new(4, sizeof(double));`,
    "    if (scratch == NULL) return 1;",
    "    scratch[0] = 99.0;",
    `    ${RUNTIME_NAME}_region_leave();`,
    "    seen[turn] = node[0];",
    `    ${RUNTIME_NAME}_region_leave();`,
    "  }",
    `  ${RUNTIME_NAME}_finalize();`,
    '  printf("%g %g\\n", seen[0], seen[1]);',
    "  return 0;",
    "}",
    "",
  ].join("\n");
  const directory = await scratch("blaze-region-nested-");
  await writeFile(join(directory, `${RUNTIME_NAME}.h`), runtimeHeaderSource(), "utf8");
  await writeFile(join(directory, "runtime.c"), runtimeSourceSource("release"), "utf8");
  await writeFile(join(directory, "probe.c"), probe, "utf8");
  const binary = join(directory, "probe");
  const built = run("gcc", ["-std=c11", "-O2", "-I", directory, join(directory, "probe.c"), join(directory, "runtime.c"), "-o", binary, "-lm"], {
    timeoutMs: 120_000,
  });
  assert.equal(built.code, 0, built.stderr);
  const result = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), "7 7", "the outer turn keeps its own block across the nested region");
});

test("a region left more often than it was entered does not underflow", async () => {
  // A turn that leaves early — a break, or a return out of the function — has
  // the compiler write the closing call on that path as well as at the bottom
  // of the body, so one leave can arrive for no enter. Counting the depth
  // rather than holding a flag is what makes the extra leave end the region
  // instead of taking the count below zero, where the next enter would read as
  // nested one and the cursor would never be rewound again.
  const probe = [
    "#include <stdio.h>",
    `#include "${RUNTIME_NAME}.h"`,
    "int main(void) {",
    `  ${RUNTIME_NAME}_initialize();`,
    `  ${RUNTIME_NAME}_region_enter();`,
    `  ${RUNTIME_NAME}_region_leave();`,
    `  ${RUNTIME_NAME}_region_leave();`,
    `  ${RUNTIME_NAME}_region_enter();`,
    `    double* a = (double*)${RUNTIME_NAME}_array_new(4, sizeof(double));`,
    `    double* b = (double*)${RUNTIME_NAME}_array_new(4, sizeof(double));`,
    "  if (a == NULL || b == NULL) return 1;",
    "  a[0] = 1.0; b[0] = 2.0;",
    `  ${RUNTIME_NAME}_region_leave();`,
    "  a[0] = 5.0;",
    `  double* c = (double*)${RUNTIME_NAME}_array_new(4, sizeof(double));`,
    "  if (c == NULL) return 1;",
    '  printf("%d\\n", c == a);',
    `  ${RUNTIME_NAME}_finalize();`,
    "  return 0;",
    "}",
    "",
  ].join("\n");
  const directory = await scratch("blaze-region-underflow-");
  await writeFile(join(directory, `${RUNTIME_NAME}.h`), runtimeHeaderSource(), "utf8");
  await writeFile(join(directory, "runtime.c"), runtimeSourceSource("release"), "utf8");
  await writeFile(join(directory, "probe.c"), probe, "utf8");
  const binary = join(directory, "probe");
  const built = run("gcc", ["-std=c11", "-O2", "-I", directory, join(directory, "probe.c"), join(directory, "runtime.c"), "-o", binary, "-lm"], {
    timeoutMs: 120_000,
  });
  assert.equal(built.code, 0, built.stderr);
  const result = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), "0", "the region is rewound, so the block after it is fresh memory");
});

test("the Nim adapter joins and clears strings as the C runtime does", async (t) => {
  if (!nimAvailable) {
    t.skip("the Nim compiler is not installed");
    return;
  }
  // Three things the two runtimes have to answer alike, and did not.
  //
  // A joined string's length: both branches of the append leave a header
  // carrying the room the block has rather than the length of the string, and
  // `blaze_rt_text_length` answers `length - 1`, so `"a" + "b"` measured 17.
  //
  // A string handed to both sides: the emitter binds one temporary per
  // interpolated part, so a string written into itself is one block named
  // twice, and the append released the left side before it read the right one.
  //
  // Bytes of text that are not terminated: `$text` scans for the terminator
  // before the slice is taken, so a literal carrying an escape the language
  // writes as a byte of text was cut at that byte.
  const probe = [
    "let joined = blaze_rt_string_append(\"a\", \"b\")",
    "if blaze_rt_string_length(joined) != 2:",
    "  echo \"LENGTH \", blaze_rt_string_length(joined)",
    "var big = newString(400000)",
    "for i in 0 ..< 400000: big[i] = 'A'",
    "let s = blaze_rt_string_new(unsafeAddr big[0], 400000)",
    "let twice = blaze_rt_string_append(s, s)",
    "if blaze_rt_string_length(twice) != 800000:",
    "  echo \"SELFLEN \", blaze_rt_string_length(twice)",
    "for i in 0 ..< 800000:",
    "  if twice[i] != 'A':",
    "    echo \"SELFBYTE \", i",
    "    break",
    "blaze_rt_print_text_n(\"a\\0b\", 3)",
    "echo \"\"",
    "echo \"done\"",
  ].join("\n");
  const directory = await scratch("blaze-nim-strings-");
  const source = join(directory, "strings.nim");
  await writeFile(source, `${generateRuntimeAdapterSource()}\n${probe}\n`, "utf8");
  const binary = join(directory, "strings");
  const built = run("nim", ["c", "--hints:off", "--warnings:off", "-d:release", `--nimcache:${join(directory, "cache")}`, `-o:${binary}`, source], {
    timeoutMs: 300_000,
  });
  assert.equal(built.code, 0, built.stderr);
  const out = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(out.code, 0, out.stderr);
  assert.equal(out.stdout, "a\0b\ndone\n");
});

test("a block released inside an open region is not handed out again by the slab", async (t) => {
  if (!nimAvailable) {
    t.skip("the Nim compiler is not installed");
    return;
  }
  // The region is rewound at the top of every turn, so a block released inside
  // it is still wanted: the rewind takes the whole region back, and the next
  // turn's block is the same bytes on purpose. What must not happen is that
  // block reaching the slab's released list, where an allocation made outside
  // the region is handed those bytes while the region is still rewound over
  // them — two live blocks in one piece of memory.
  const probe = [
    "blaze_rt_region_enter()",
    "let held = blaze_rt_object_new(64, 8)",
    "blaze_rt_release(cast[pointer](held))",
    "blaze_rt_region_leave()",
    "let outside = blaze_rt_object_new(64, 8)",
    "if cast[uint](held) == cast[uint](outside):",
    "  echo \"ALIASED\"",
    "else:",
    "  echo \"distinct\"",
    "blaze_rt_release(cast[pointer](outside))",
  ].join("\n");
  const directory = await scratch("blaze-nim-region-");
  const source = join(directory, "region.nim");
  await writeFile(source, `${generateRuntimeAdapterSource()}\n${probe}\n`, "utf8");
  const binary = join(directory, "region");
  const built = run("nim", ["c", "--hints:off", "--warnings:off", "-d:release", `--nimcache:${join(directory, "cache")}`, `-o:${binary}`, source], {
    timeoutMs: 300_000,
  });
  assert.equal(built.code, 0, built.stderr);
  const out = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(out.code, 0, out.stderr);
  assert.equal(out.stdout.trim(), "distinct");
});


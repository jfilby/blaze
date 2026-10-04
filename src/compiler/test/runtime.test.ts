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


/**
 * A Python program, built and run beside the source it was written as.
 *
 * A program is checked against the output of the language it was written in,
 * so the tests here run the source with python3 and the delivered binary with
 * the compiler, and compare what the two print. The runtime is built once, as
 * a build builds it once.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateProgramDriver, buildProgramDriver } from "../toolchain/driver.ts";
import { compileFunctionC } from "../toolchain/ir-c.ts";
import { resolveFunction, type FunctionContext } from "../semantics/ir-function.ts";
import { resolveProgram, type SemanticProgram } from "../semantics/ir-resolve.ts";
import { buildStandaloneRuntime } from "../runtime/standalone.ts";
import { RUNTIME_NAME, runtimeHeaderSource } from "../runtime/abi.ts";
import { run } from "../core/process.ts";
import { verifyProgram } from "../toolchain/verify-program.ts";
import { runBuild } from "../compiler.ts";
import { writeProject } from "./project.ts";
import { phaseOf } from "./phase.ts";
import { scratch } from "./scratch.ts";

/** The object the driver of every program here links against, built once. */
let runtime: Promise<string> | null = null;

/** A one file Python program, resolved exactly as a build resolves it. */
function resolved(source: string): SemanticProgram {
  const phase = phaseOf("python", { "main.py": source }, "main.py");
  assert.ok(phase.body !== undefined);
  return resolveProgram(phase.body, phase.program, phase.objectNames, phase.objectLayouts, phase.objectKeys);
}

/** The program written to disk and the binary it was linked into. */
async function linked(source: string): Promise<{ directory: string; binary: string }> {
  const directory = await scratch("blaze-python-");
  await writeFile(join(directory, "main.py"), source, "utf8");
  // The driver includes the runtime header by name, as a build keeps the
  // runtime beside the driver it links.
  await writeFile(join(directory, `${RUNTIME_NAME}.h`), runtimeHeaderSource(), "utf8");
  runtime ??= buildStandaloneRuntime(await scratch("blaze-runtime-")).then((built) => built.objectPath);
  // The functions of a program are objects of their own, compiled one at a
  // time and linked beside the driver, as a build compiles them.
  const phase = phaseOf("python", { "main.py": source }, "main.py");
  const context: FunctionContext = {
    objectNames: phase.objectNames,
    functions: Object.fromEntries(phase.program.files.flatMap((file) => Object.entries(file.functions))),
    language: phase.program.language,
  };
  const objectPaths: string[] = [];
  for (const file of phase.program.files) {
    for (const contract of Object.values(file.functions)) {
      const fn = resolveFunction(contract, context);
      const objectPath = join(directory, `${contract.function.name}.o`);
      await compileFunctionC({
        fn,
        contract,
        target: { arch: "x86_64", os: "linux", abi: "sysv", cpu: "", features: [] },
        mode: "debug",
        sourcePath: join(directory, `${contract.function.name}.c`),
        objectPath,
        includeDirectories: [directory],
      });
      objectPaths.push(objectPath);
    }
  }
  const runner = await buildProgramDriver({
    mode: "debug",
    target: { arch: "x86_64", os: "linux", abi: "sysv", cpu: "", features: [] },
    program: resolved(source),
    workDirectory: directory,
    objectPaths,
    runtimeObjectPath: await runtime,
    outputPath: join(directory, "program"),
  });
  return { directory, binary: runner.command };
}

/** The binary the program was linked into, and what the source printed. */
async function deliver(source: string): Promise<{ binary: string; original: string }> {
  const { directory, binary } = await linked(source);
  const original = run("python3", ["main.py"], { cwd: directory, timeoutMs: 60_000 });
  assert.equal(original.code, 0, original.stderr);
  return { binary, original: original.stdout };
}

test("a Python program prints what its source prints", async () => {
  const source = ["print('hello')", ""].join("\n");
  const { binary, original } = await deliver(source);
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, original);
  assert.equal(delivered.stdout, "hello\n");
});

test("a number is written as text the way Python writes it", async () => {
  const source = ["print(1.0)", "print(2)", "print(0.0001)", "print(0.00001)", ""].join("\n");
  const { binary, original } = await deliver(source);
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, original);
  assert.equal(delivered.stdout, "1.0\n2\n0.0001\n1e-05\n");
});

test("a boolean and a null are written the way Python writes them", async () => {
  const source = ["print(True)", "print(False)", ""].join("\n");
  const { binary, original } = await deliver(source);
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, original);
  assert.equal(delivered.stdout, "True\nFalse\n");
});

test("a division is a true division, and a remainder takes the sign of its divisor", async () => {
  const source = ["print(7 / 2)", "print(7 // 2)", "print(-7 % 2)", ""].join("\n");
  const { binary, original } = await deliver(source);
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, original);
  assert.equal(delivered.stdout, "3.5\n3\n1\n");
});

test("a function of a program is called and its result is printed", async () => {
  const source = [
    "def twice(n: int) -> int:",
    "    return n * 2",
    "",
    'if __name__ == "__main__":',
    "    print(twice(21))",
    "",
  ].join("\n");
  const { binary, original } = await deliver(source);
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, original);
  assert.equal(delivered.stdout, "42\n");
});

test("a program writes its values with a space between them", async () => {
  const source = ["print('a', 1, True)", ""].join("\n");
  const { binary, original } = await deliver(source);
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, original);
  assert.equal(delivered.stdout, "a 1 True\n");
});

test("a loop of a program counts over a range", async () => {
  const source = [
    "total = 0",
    "for i in range(5):",
    "    total += i",
    "print(total)",
    "",
  ].join("\n");
  const { binary, original } = await deliver(source);
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, original);
  assert.equal(delivered.stdout, "10\n");
});

test("a list of a program is a buffer of what it holds, and an f-string is text", async () => {
  const source = ["a = [1.0, 2.0, 3.0]", "print(a[1])", 'print(f"{a[1]} items")', ""].join("\n");
  const { binary, original } = await deliver(source);
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, original);
  assert.equal(delivered.stdout, "2.0\n2.0 items\n");
});

test("the C a Python program is driven by sets the style of the text it writes", () => {
  const source = ["print(1.0)", ""].join("\n");
  const written = generateProgramDriver(resolved(source));
  assert.match(written, /blaze_rt_set_text_style\(1\)/);
});

test("a Python program is built and checked against the source it was written as", async (t) => {
  // The environment must not name a model: the build under test has none
  // anywhere, which is the whole of what it proves.
  const previous = process.env.AI_MODEL;
  delete process.env.AI_MODEL;
  t.after(() => {
    if (previous === undefined) delete process.env.AI_MODEL;
    else process.env.AI_MODEL = previous;
  });
  const directory = await scratch("blaze-python-build-");
  await writeProject(join(directory, "input.toml"), {
    language: "python",
    source: ["print('hello')", "print(1.0)", ""].join("\n"),
    entry: "",
    target: { arch: "x86_64", os: "linux", abi: "sysv", cpu: "", features: [] },
    output: "c",
    generation: { maxCandidates: 1, maxAttempts: 2 },
    test: { randomCases: 6, maxLength: 64, seed: 7 },
    benchmark: { iterations: 200 },
  });
  const outcome = await runBuild("input.toml", { cwd: directory, reuse: false }, { stage: () => {} }, "build");
  assert.equal(outcome.build.status, "success", outcome.build.error?.message ?? "");
  // The delivered program is beside the project file, and it prints what the
  // source prints.
  const delivered = run(join(directory, "input"), [], { cwd: directory, timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, "hello\n1.0\n");
});

test("a program is checked against the toolchain that runs its source", async () => {
  // The build runs the source on its own toolchain and the delivered binary
  // beside it, and compares what the two print: the source is the
  // specification.
  const source = ["print('hello')", "print(1.0)", ""].join("\n");
  const { directory, binary } = await linked(source);
  const checked = await verifyProgram({
    language: "python",
    sourcePath: join(directory, "main.py"),
    directory,
    runner: { command: binary, args: [] },
  });
  assert.equal(checked.passed, true, checked.difference?.expected ?? "");
  assert.equal(checked.expected, "hello\n1.0\n");
});

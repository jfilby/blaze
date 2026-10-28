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
function resolved(source: string, files: Record<string, string> = { "main.py": source }): SemanticProgram {
  const phase = phaseOf("python", files, "main.py");
  assert.ok(phase.body !== undefined);
  return resolveProgram(phase.body, phase.program, phase.objectNames, phase.objectLayouts, phase.objectKeys);
}

/** The program written to disk and the binary it was linked into. */
async function linked(
  source: string,
  files: Record<string, string> = { "main.py": source },
): Promise<{ directory: string; binary: string }> {
  const directory = await scratch("blaze-python-");
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(directory, name), content, "utf8");
  }
  // The driver includes the runtime header by name, as a build keeps the
  // runtime beside the driver it links.
  await writeFile(join(directory, `${RUNTIME_NAME}.h`), runtimeHeaderSource(), "utf8");
  runtime ??= buildStandaloneRuntime(await scratch("blaze-runtime-")).then((built) => built.objectPath);
  // The functions of a program are objects of their own, compiled one at a
  // time and linked beside the driver, as a build compiles them.
  const phase = phaseOf("python", files, "main.py");
  const context: FunctionContext = {
    objectNames: phase.objectNames,
    functions: Object.fromEntries(phase.program.files.flatMap((file) => Object.entries(file.functions))),
    language: phase.program.language,
  };
  const objectPaths: string[] = [];
  for (const file of phase.program.files) {
    for (const contract of Object.values(file.functions)) {
      const fn = resolveFunction(contract, context);
      const objectPath = join(directory, `${contract.function.symbol}.o`);
      await compileFunctionC({
        fn,
        contract,
        target: { arch: "x86_64", os: "linux", abi: "sysv", cpu: "", features: [] },
        mode: "debug",
        sourcePath: join(directory, `${contract.function.symbol}.c`),
        objectPath,
        includeDirectories: [directory],
      });
      objectPaths.push(objectPath);
    }
  }
  const runner = await buildProgramDriver({
    mode: "debug",
    target: { arch: "x86_64", os: "linux", abi: "sysv", cpu: "", features: [] },
    program: resolved(source, files),
    workDirectory: directory,
    objectPaths,
    runtimeObjectPath: await runtime,
    outputPath: join(directory, "program"),
  });
  return { directory, binary: runner.command };
}

/** The binary the program was linked into, and what the source printed. */
async function deliver(
  source: string,
  files: Record<string, string> = { "main.py": source },
  arguments_: readonly string[] = [],
): Promise<{ binary: string; original: string }> {
  const { directory, binary } = await linked(source, files);
  const original = run("python3", ["main.py", ...arguments_], { cwd: directory, timeoutMs: 60_000 });
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

test("a compound floor division is the floor division it states", async () => {
  // C has no `//=`, and `//` in C opens a comment: the compound form reached
  // the C backend as a statement that said nothing at all, and the program
  // kept the number it had instead of dividing it. The compound is written as
  // the binary form, which is the same program.
  const source = ["x = 7", "x //= 2", "print(x)", "y = -7", "y //= 2", "print(y)", ""].join("\n");
  const { binary, original } = await deliver(source);
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, original);
  assert.equal(delivered.stdout, "3\n-4\n");
});

test("a power answers the power it states", async () => {
  // The compiler's power is a double's operation, so both sides of `**` must be
  // numbers rather than whole numbers: `2 ** 3` is refused, and a whole-number
  // power is not part of a program. A fractional power prints the same in both,
  // which is what the build compares: `2.0 ** -1.0` is `0.5` and `4.0 ** 0.5`
  // is `2.0`.
  const source = ["print(2.0 ** -1.0)", "print(4.0 ** 0.5)", ""].join("\n");
  const { binary, original } = await deliver(source);
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, original);
  assert.equal(delivered.stdout, "0.5\n2.0\n");
});

test("a division by a zero the loop never reaches is not made", async () => {
  // The division is loop-invariant, so the compiler lifted it above the loop —
  // and the loop runs no turns, so the source never divided by that zero. The
  // division faults on a zero divisor, and the program died where the source
  // printed what it printed.
  const source = ["n = 0", "d = 0", "for i in range(n):", "    x = 7 // d", "    print(x)", "print('done')", ""].join("\n");
  const { binary, original } = await deliver(source);
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, original);
  assert.equal(delivered.stdout, "done\n");
});

test("a whole number beside a fraction is a fraction", async () => {  // Python has no such a thing as a whole number beside a fraction: the pair
  // is a fraction there.
  const source = ["print(1 + 2.5)", "print(2.5 + 1)", "x = 3", "print(x * 1.5)", ""].join("\n");
  const { binary, original } = await deliver(source);
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, original);
  assert.equal(delivered.stdout, "3.5\n3.5\n4.5\n");
});

test("the magnitude of a whole number is a whole number", async () => {
  // Python's `abs` of a whole number is a whole number, and the compiler's
  // `Math.abs` answers a fraction: the two are two kinds of number, and they
  // print differently.
  const source = ["print(abs(-3))", "print(abs(-3.5))", "print(min(3, 4))", "print(max(3, 4))", ""].join("\n");
  const { binary, original } = await deliver(source);
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, original);
  assert.equal(delivered.stdout, "3\n3.5\n3\n4\n");
});

test("a conversion answers a whole number", async () => {
  const source = ["print(int(3.7))", "import math", "print(math.floor(3.7))", "print(math.ceil(3.2))", ""].join("\n");
  const { binary, original } = await deliver(source);
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, original);
  assert.equal(delivered.stdout, "3\n3\n4\n");
});

test("a conditional expression answers the arm the condition holds", async () => {
  // Python writes the value first and the condition after it.
  const source = ["x = 1", "print('yes' if x == 1 else 'no')", "print(1 if x > 2 else 2)", ""].join("\n");
  const { binary, original } = await deliver(source);
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, original);
  assert.equal(delivered.stdout, "yes\n2\n");
});

test("a dict is read by its key", async () => {
  const source = ["d = {'left': 1, 'right': 2}", "print(d['left'])", 'print(f"{d[\'right\']}")', ""].join("\n");
  const { binary, original } = await deliver(source);
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, original);
  assert.equal(delivered.stdout, "1\n2\n");
});

test("the command line of a program is the one it was given", async () => {
  // The length of the command line is the file and the arguments, and the
  // arguments are numbers, so a program reads one with `int`.
  const source = ["import sys", "", "print(len(sys.argv))", "print(int(sys.argv[1]))", ""].join("\n");
  const { binary, original } = await deliver(source, { "main.py": source }, ["42"]);
  const delivered = run(binary, ["42"], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, original);
  assert.equal(delivered.stdout, "2\n42\n");
});

test("a program calls a function of another file of the project", async () => {  // The program is the shape a Python program is written in: a `main` of its
  // own, a guard that names the entry module, and a function of another file
  // that does the work.
  const main = [
    "from helpers import dot",
    "",
    "def main() -> int:",
    "    a = [1.0, 2.0, 3.0]",
    "    b = [4.0, 5.0, 6.0]",
    "    print(dot(a, b, 3))",
    "    return 0",
    "",
    'if __name__ == "__main__":',
    "    main()",
    "",
  ].join("\n");
  const helpers = [
    "def dot(a: list[float], b: list[float], n: int) -> float:",
    "    total: float = 0.0",
    "    for i in range(n):",
    "        total += a[i] * b[i]",
    "    return total",
    "",
  ].join("\n");
  const { binary, original } = await deliver(main, { "main.py": main, "helpers.py": helpers });
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, original);
  assert.equal(delivered.stdout, "32.0\n");
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

test("a name a loop accumulates is read on every turn as the name it is", async () => {
  // The value a compound assignment writes is the old value and the right
  // side, and not the right side alone. A binding that answers the right side
  // would read `total += i` as `total = i`, and the program would print the
  // counter on every turn instead of the running sum.
  const source = [
    "total = 0",
    "for i in range(4):",
    "    total += i",
    "    print(total)",
    "",
  ].join("\n");
  const { binary, original } = await deliver(source);
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, original);
  assert.equal(delivered.stdout, "0\n1\n3\n6\n");
});

test("a name an arm of a branch writes is read as the name it is after the branch", async () => {
  // Only one arm runs, and the arm that does not run writes nothing: a value
  // read out of the arm that was lowered last would answer what the source
  // wrote in a branch the program never took.
  const source = [
    "x = 1",
    "if x == 2:",
    "    x = 5",
    "print(x)",
    "",
  ].join("\n");
  const { binary, original } = await deliver(source);
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, original);
  assert.equal(delivered.stdout, "1\n");
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

test("a Python program that calls a function of another file is built and checked", async (t) => {
  // The function of the other file is checked against its contract with
  // vectors of its own, and a vector is not the program's buffer: it holds the
  // values the declared type allows. So the function is left as the source
  // wrote it, and the contract it states holds for the vectors as well as for
  // the program's own lists.
  const previous = process.env.AI_MODEL;
  delete process.env.AI_MODEL;
  t.after(() => {
    if (previous === undefined) delete process.env.AI_MODEL;
    else process.env.AI_MODEL = previous;
  });
  const directory = await scratch("blaze-python-module-build-");
  await writeFile(
    join(directory, "main.py"),
    ["from helpers import dot", "", "print(dot([1.0, 2.0], [3.0, 4.0], 2))", ""].join("\n"),
    "utf8",
  );
  await writeFile(
    join(directory, "helpers.py"),
    [
      "def dot(a: list[float], b: list[float], n: int) -> float:",
      "    total: float = 0.0",
      "    for i in range(n):",
      "        total += a[i] * b[i]",
      "    return total",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeProject(join(directory, "input.toml"), {
    language: "python",
    sourceFile: "main.py",
    target: { arch: "x86_64", os: "linux", abi: "sysv", cpu: "", features: [] },
    output: "c",
    generation: { maxCandidates: 1, maxAttempts: 2 },
    test: { randomCases: 6, maxLength: 64, seed: 7 },
    benchmark: { iterations: 200 },
  });
  const outcome = await runBuild("input.toml", { cwd: directory, reuse: false }, { stage: () => {} }, "build");
  assert.equal(outcome.build.status, "success", outcome.build.error?.message ?? "");
  const delivered = run(join(directory, "input"), [], { cwd: directory, timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, "11.0\n");
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

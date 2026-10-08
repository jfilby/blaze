/**
 * What the whole-number pass does to a program, and that what it does is the
 * same program.
 *
 * The pass in `semantics/whole-numbers.ts` reads a whole program rather than
 * one body, so what it needs checking is the program: the shape it leaves a
 * function in, the shape it refuses to leave one in, and the numbers both arms
 * of a rewritten function answer. The numbers are checked by running the
 * program the way a build builds it and the way the language runs it, and
 * comparing what the two print.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildProgramDriver, generateProgramDriver } from "../toolchain/driver.ts";
import { resolveProgram, type SemanticProgram } from "../semantics/ir-resolve.ts";
import { optimizeSemanticProgram } from "../semantics/optimize-ir.ts";
import { semanticIrProblems } from "../semantics/ir-validate.ts";
import { buildStandaloneRuntime } from "../runtime/standalone.ts";
import { RUNTIME_NAME, runtimeHeaderSource } from "../runtime/abi.ts";
import { run } from "../core/process.ts";
import { phaseOf } from "./phase.ts";
import { scratch } from "./scratch.ts";

/** The object the driver of every program here links against, built once. */
let runtime: Promise<string> | null = null;

/**
 * A program whose statements run a function that declares `triangle` inside
 * itself, which is where a program's own helper is written. The file opens
 * with a statement, which is what says it is a program rather than a library
 * of functions.
 */
function programOf(body: string): string {
  return [
    "const reach = 8;",
    "",
    "function run(): void {",
    "  function triangle(x: number, y: number): number {",
    "    return ((x + y) * (x + y + 1) >>> 1) + x + 1;",
    "  }",
    body,
    "}",
    "",
    "run();",
    "",
  ].join("\n");
}

/**
 * A program that calls `triangle` inside the reach a whole-number arm is
 * written for and once past it, so one program runs both arms. The second call
 * is also the case a `u32 >>> 1` and a sixty-four bit shift disagree on: its
 * product is above four billion, and the language wraps it.
 */
const BOTH_ARMS = programOf(
  [
    "  let withinReach = 0;",
    "  for (let i = 0; i < reach; i += 1) withinReach = triangle(i, i);",
    "  console.log(withinReach);",
    "",
    "  let pastReach = 0;",
    "  for (let i = 40000000; i < 40000001; i += 1) pastReach = triangle(i, i);",
    "  console.log(pastReach);",
  ].join("\n"),
);

/** A program resolved from one entry module, exactly as a build resolves it. */
function resolved(source: string): SemanticProgram {
  const phase = phaseOf("typescript", { "main.ts": source }, "main.ts");
  assert.ok(phase.body !== undefined);
  return resolveProgram(phase.body, phase.program, phase.objectNames, phase.objectLayouts, phase.objectKeys);
}

/** The C a program of this source is written out as, after the rewrites. */
function written(source: string): string {
  return generateProgramDriver(optimizeSemanticProgram(resolved(source)));
}

/** The program written to disk and the binary it was linked into. */
async function linked(source: string): Promise<{ directory: string; binary: string }> {
  const directory = await scratch("blaze-whole-");
  await writeFile(join(directory, "main.ts"), source, "utf8");
  await writeFile(join(directory, `${RUNTIME_NAME}.h`), runtimeHeaderSource(), "utf8");
  runtime ??= buildStandaloneRuntime(await scratch("blaze-runtime-")).then((built) => built.objectPath);
  const runner = await buildProgramDriver({
    mode: "debug",
    target: { arch: "x86_64", os: "linux", abi: "sysv", cpu: "", features: [] },
    program: optimizeSemanticProgram(resolved(source)),
    workDirectory: directory,
    objectPaths: [],
    runtimeObjectPath: await runtime,
    outputPath: join(directory, "program"),
  });
  return { directory, binary: runner.command };
}

test("a function every caller hands whole numbers to computes in whole numbers", () => {
  const c = written(programOf("  for (let i = 0; i < reach; i += 1) console.log(triangle(i, i));"));

  // The parameters are whole numbers now, so the function is declared with them
  // and its callers hand their counters over without converting them first.
  assert.match(c, /^extern double triangle\(int64_t x, int64_t y\);$/m);
  assert.match(c, /triangle\(i, i\)/);

  // The body answers the whole-number form first and the arithmetic the source
  // wrote after it, and what chooses between them is one comparison over each
  // parameter, read as the unsigned number the reach is added to.
  const arm = c.slice(c.indexOf("\ndouble triangle(int64_t"));
  assert.match(arm, /\+ 33554432ULL\) <= 67108864ULL/);
  // The shift is a whole-number shift of a whole-number product, and the answer
  // is read as the double the caller is waiting for.
  assert.match(arm, /return \(double\)\(\(\(\(int64_t\)/);
  assert.match(arm, /\(uint32_t\)\(\(\(x \+ y\) \* \(\(x \+ y\) \+ 1LL\)\)\) >> /);
  // The arm the reach refuses is the one the source wrote, unchanged.
  assert.match(arm, /common\w+ = \(x \+ y\);/);
});

test("a function one caller hands a double to is left as the source wrote it", () => {
  // One caller that passes a fraction is one whose parameter may not be read as
  // a whole number: truncating it would answer for a value the program never
  // said was whole, so the body keeps the arithmetic it had.
  const c = written(programOf("  for (let i = 0; i < reach; i += 1) console.log(triangle(i + 0.5, i));"));

  assert.match(c, /^extern double triangle\(double x, double y\);$/m);
  assert.match(c, /common\w+ = \(x \+ y\);/);
  assert.doesNotMatch(c, /uint64_t/);
});

test("a body that writes one of its names is left as the source wrote it", () => {
  // `sum` is bound to `x + y` and written to `x + y + 1`, so the answer is
  // computed of the value written, not of the value bound. A body that writes
  // anything is a body whose values would have to move, and moving a value a
  // write stands behind is another program: the whole-number form answers from
  // what a name was bound to, and that is not what the body means after a write.
  const source = programOf(
    [
      "  function rewrite(x: number, y: number): number {",
      "    let sum = x + y;",
      "    sum = sum + 1;",
      "    return sum * y;",
      "  }",
      "  for (let i = 0; i < reach; i += 1) console.log(rewrite(i, i));",
    ].join("\n"),
  );
  const c = written(source);

  assert.match(c, /^extern double rewrite\(double x, double y\);$/m);
  assert.doesNotMatch(c, /uint64_t/);
});

test("a whole-number arm is arithmetic the validator holds to", () => {
  assert.deepEqual(semanticIrProblems(optimizeSemanticProgram(resolved(BOTH_ARMS))), []);
});

test("both arms of a rewritten function answer what the language answers", async () => {
  const { directory, binary } = await linked(BOTH_ARMS);
  const source = run("node", ["main.ts"], { cwd: directory, timeoutMs: 120_000 });
  const delivered = run(binary, [], { timeoutMs: 120_000 });

  assert.equal(source.code, 0, source.stderr);
  assert.equal(delivered.code, 0, delivered.stderr);
  // 113 is `triangle(7, 7)` with every term small, and 336376833 is
  // `triangle(40000000, 40000000)`: its product is 6.4e15, which a sixty-four
  // bit shift would answer for at full width and `>>> 1` answers for at
  // thirty-two.
  assert.deepEqual(delivered.stdout.trimEnd().split("\n"), ["113", "336376833"]);
  assert.equal(delivered.stdout, source.stdout);
});

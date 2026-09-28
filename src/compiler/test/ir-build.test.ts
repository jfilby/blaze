/**
 * Builds through the IR: a project that sets `output = "ir"`, the model answers
 * with the semantic IR of a function, and the compiler parses it, checks it
 * against the contract the function was declared in, and writes the target code
 * itself. No register, offset or instruction is a model's to choose in either
 * direction.
 *
 * A program is the only oracle a function whose contract states what it does
 * has, so the program is what these tests check: the source is run with node and
 * the delivered binary is run beside it, and the two are compared line for line.
 * A candidate the compiler may not lower is refused before any toolchain is
 * asked for anything, and the refusal is what the next attempt is given.
 *
 * Both fixtures are what `blaze ir --function total` printed for the library
 * below, copied without a change. The header lines are the contract's and the
 * parser checks every one of them, so a fixture is the printed output verbatim
 * and only the body is the model's to choose.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIRECTORY, runBuild } from "../compiler.ts";
import { run } from "../core/process.ts";
import { resolveFunction } from "../semantics/ir-function.ts";
import { printSemanticFunction } from "../semantics/ir-text.ts";
import { chatEndpoint } from "./model-endpoint.ts";
import { phaseOf } from "./phase.ts";
import { writeProject } from "./project.ts";

/** The answer a build accepts, written out as `blaze ir` printed it. */
const RESOLVED = new URL("./fixtures/ir-total-replay.json", import.meta.url).pathname;
/**
 * The same answer with one value read as a type the field does not take: an
 * element of a `[]f64` is a number, and a body that adds one to a running
 * total cannot read it as text.
 */
const MISREAD = new URL("./fixtures/ir-total-wrong-replay.json", import.meta.url).pathname;

const quiet = { stage: () => {} };

/**
 * The library the program calls: a loop over a buffer, accumulating what it
 * reads. The guard at the top is what makes the frontend contract this body as
 * a definition rather than as a postcondition, and a definition is the only
 * kind of function the IR has a body to describe.
 */
const LIBRARY = [
  "export function total(values: Float64Array, count: number): number {",
  "  if (count <= 0) {",
  "    return 0;",
  "  }",
  "  let sum = 0;",
  "  for (let index = 0; index < count; index += 1) {",
  "    sum += values[index];",
  "  }",
  "  return sum;",
  "}",
  "",
].join("\n");

/** The entry module: a program that calls the definition and prints what it returns. */
const ENTRY = [
  'import { total } from "./lib.ts";',
  "",
  "const readings = new Float64Array([3, 1, 4, 1, 5, 9, 2, 6]);",
  "const pair = new Float64Array([2, 6]);",
  "for (let limit = 0; limit < readings.length; limit += 2) {",
  "  console.log(`first ${limit} of the readings sum to ${total(readings, limit)}`);",
  "}",
  "console.log(`none ${total(readings, 0)}`);",
  "console.log(`pair ${total(pair, pair.length)}`);",
  "console.log(`all ${total(readings, readings.length)}`);",
  "",
].join("\n");

/** What the source prints, which is what the delivered program has to print. */
const PRINTED = [
  "first 0 of the readings sum to 0",
  "first 2 of the readings sum to 4",
  "first 4 of the readings sum to 9",
  "first 6 of the readings sum to 23",
  "none 0",
  "pair 8",
  "all 31",
  "",
].join("\n");

/** The candidate one recorded replay file answers a request with. */
async function recorded(fixture: string): Promise<string> {
  return (JSON.parse(await readFile(fixture, "utf8")) as { candidates: string[] }).candidates[0];
}

/** What the compiler resolved for `total`, which is what a fixture holds. */
function resolved(): string {
  const phase = phaseOf("typescript", { "main.ts": ENTRY, "lib.ts": LIBRARY }, "main.ts");
  const contract = phase.program.files.find((file) => file.path === "lib.ts")?.functions.total;
  assert.ok(contract !== undefined, "the entry program imports the library function these tests build");
  return printSemanticFunction(resolveFunction(contract, { objectNames: phase.objectNames, functions: {} }));
}

/**
 * A project of an entry program and the library it calls, written out with a
 * project file that asks for the IR, and the directory the build runs in.
 */
async function project(name: string, model: object, attempts = 1): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `blaze-${name}-`));
  await writeFile(join(directory, "main.ts"), ENTRY, "utf8");
  await writeFile(join(directory, "lib.ts"), LIBRARY, "utf8");
  await writeProject(join(directory, "input.toml"), {
    language: "typescript",
    sourceFile: "main.ts",
    model,
    output: "ir",
    generation: { maxCandidates: 1, maxAttempts: attempts },
  });
  return directory;
}

test("a program built from IR runs and prints what its source prints", async () => {
  const answer = await recorded(RESOLVED);
  assert.equal(answer, resolved(), "the fixture is the IR the compiler resolved for the function");

  const directory = await project("ir-build", { provider: "replay", file: RESOLVED });
  const outcome = await runBuild(
    "input.toml",
    { cwd: directory, reuse: false, model: `replay:${RESOLVED}`, maxAttempts: 1 },
    quiet,
    "build",
  );

  assert.equal(outcome.build.status, "success", "the IR the model answered with is a program the compiler may lower");
  assert.ok(outcome.outputPath !== null, "a program build delivers its binary");
  assert.deepEqual(outcome.build.selectedCandidates, { total: "c1" });

  // The binary is the one the build verified, and the source is the
  // specification: node runs the TypeScript, the compiler's binary runs the
  // object the IR was lowered into, and the two are compared line for line.
  const binary = run(outcome.outputPath as string, [], { timeoutMs: 60_000 });
  assert.equal(binary.code, 0, `the delivered program stopped: ${binary.stderr.trim()}`);
  assert.equal(binary.stdout, PRINTED, "the delivered program prints what its source prints");
  assert.equal(run("node", [join(directory, "main.ts")], { timeoutMs: 60_000 }).stdout, PRINTED);
});

test("a candidate that is not a program the compiler may lower is refused, naming the line", async () => {
  const wrong = await recorded(MISREAD);
  assert.notEqual(wrong, await recorded(RESOLVED), "the refused candidate differs from the accepted one in one value");

  const directory = await project("ir-refused", { provider: "replay", file: MISREAD });
  const refused = await runBuild(
    "input.toml",
    { cwd: directory, reuse: false, model: `replay:${MISREAD}`, maxAttempts: 1 },
    quiet,
    "build",
  ).then(
    () => null,
    (cause: unknown) => cause as Error,
  );

  assert.ok(refused !== null, "a candidate the compiler may not lower fails the build");
  const reported = `${refused.message} ${"detail" in refused ? String(refused.detail) : ""}`;
  assert.match(reported, /not a function the compiler may lower/);
  // The diagnostic names the statement that is wrong and how the value in it was
  // read, not the file the candidate came from.
  assert.match(reported, /line 7/, "the diagnostic says which line of the candidate is wrong");
  assert.match(reported, /an element of a \[\]f64 is a f64, not a text/);

  // The refusal happened before any toolchain was asked for anything: the
  // object is written by the backend, and the backend is only reached by a
  // candidate that passed.
  const work = join(directory, STATE_DIRECTORY, "projects/input/work/total");
  assert.deepEqual(
    (await readdir(work).catch(() => [])).filter((name) => name.endsWith(".o") || name.endsWith(".c")),
    [],
    "nothing was compiled from a candidate that was refused",
  );

  // The build record says the build failed, and keeps the reason.
  const build = JSON.parse(await readFile(join(directory, STATE_DIRECTORY, "projects/input/build.json"), "utf8")) as {
    status: string;
    error?: { message: string };
  };
  assert.equal(build.status, "failed");
  assert.match(build.error?.message ?? "", /total/, "the record says which function had no usable candidate");
});

test("a refused IR candidate is repaired with the diagnostic that refused it", async (t) => {
  const wrong = await recorded(MISREAD);
  const right = await recorded(RESOLVED);
  const endpoint = await chatEndpoint(t, [], { answer: (prompt) => (prompt.includes(wrong) ? right : wrong) });

  const directory = await project("ir-repair", { provider: "openai-compatible", model: "stub" }, 2);
  const outcome = await runBuild(
    "input.toml",
    { cwd: directory, reuse: false, model: "openai-compatible/stub", maxAttempts: 2 },
    quiet,
    "build",
  );

  assert.equal(outcome.build.status, "success", "the repaired IR is the one that is delivered");
  assert.deepEqual(
    outcome.build.selectedCandidates,
    { total: "c2" },
    "the repair replaced the candidate rather than starting a new one",
  );
  assert.equal(endpoint.prompts.length, 2, "the IR is generated once, then regenerated");

  // The first request asks for the IR of this function, and hands the model the
  // IR the compiler resolved, which is what the answer is written from.
  const generated = endpoint.prompts[0];
  assert.match(generated, /Answer with the whole function as semantic IR/);
  assert.ok(generated.includes(right), "the resolved IR the candidate is written from is in the request");

  // The second is a repair: it carries the IR that was refused and the
  // diagnostic that refused it, so the next attempt knows what to change.
  const repair = endpoint.prompts[1];
  assert.match(repair, /DIAGNOSTICS FOR THIS CANDIDATE, OLDEST FIRST/);
  assert.match(repair, /\[attempt 1] ir failed: total is not a function the compiler may lower/);
  assert.match(repair, /an element of a \[\]f64 is a f64, not a text/);
  assert.ok(repair.includes(wrong), "the repair is handed the IR that was refused");

  const binary = run(outcome.outputPath as string, [], { timeoutMs: 60_000 });
  assert.equal(binary.stdout, PRINTED, "the program the repair built prints what the source prints");
});

test("a function that states a postcondition is generated as IR, like any other", async (t) => {
  // `square` is one expression, so it states a postcondition as well as
  // carrying a body. Both travel: the body is what is implemented, and the
  // postcondition is what the result is checked against. There is no path
  // where a postcondition sends the build back to C.
  const ir = [
    "function square(count: f64) -> f64",
    "  requires none",
    '  ensures "result == (count * count)"',
    "  allocates no",
    "  prints no",
    "  reads_argv no",
    "  effects none",
    "  param value[f64] count mutable",
    "  block entry: releases[]",
    "  return [mul[f64] local[f64] count local[f64] count]",
    "",
  ].join("\n");
  const endpoint = await chatEndpoint(t, [], { answer: () => ir });
  const directory = await mkdtemp(join(tmpdir(), "blaze-ir-postcondition-"));
  await writeFile(
    join(directory, "main.ts"),
    "export function square(count: number): number {\n  return count * count;\n}\n",
    "utf8",
  );
  await writeProject(join(directory, "input.toml"), {
    language: "typescript",
    sourceFile: "main.ts",
    model: { provider: "openai-compatible", model: "stub" },
    output: "ir",
    generation: { maxCandidates: 1, maxAttempts: 1 },
  });

  const outcome = await runBuild(
    "input.toml",
    { cwd: directory, reuse: false, model: "openai-compatible/stub", maxAttempts: 1 },
    quiet,
    "build",
  );

  assert.equal(outcome.build.status, "success");
  assert.equal(endpoint.prompts.length, 1, "the function is asked for once");
  assert.match(endpoint.prompts[0], /Answer with the whole function as semantic IR/);
  assert.doesNotMatch(endpoint.prompts[0], /C11/, "a postcondition does not send the build back to C");
  // The body the compiler resolved is what the model is asked to write from,
  // and the postcondition is stated beside it as what the result is held to.
  assert.match(endpoint.prompts[0], /THE FUNCTION TO IMPLEMENT/);
  assert.match(endpoint.prompts[0], /result == \(count \* count\)/);

  const work = (await readdir(join(directory, STATE_DIRECTORY, "projects/input/work/square"))).sort();
  assert.ok(work.includes("c1.ir"), `the IR is what was generated: ${work.join(", ")}`);
  assert.ok(work.includes("c1.o"), `the object the compiler lowered it into is in ${work.join(", ")}`);
  // The result is checked against the postcondition, on vectors of its own,
  // rather than by running a program there is no library of.
  assert.ok((outcome.verification.square?.[0]?.cases ?? 0) > 0, "the postcondition verified the result");
  const stored = JSON.parse(
    await readFile(join(directory, STATE_DIRECTORY, "projects/input/candidates.json"), "utf8"),
  ) as Record<string, { text: string }[]>;
  assert.deepEqual(stored.square?.map((entry) => entry.text), [ir], "the IR is what was generated");
});

/**
 * Builds through the IR: a project that sets `output = "ir"`, the compiler
 * resolves the source into the semantic IR, a review of that IR proposes what
 * it would change, and the compiler applies the proposals it accepts and
 * writes the target code itself. No register, offset or instruction is a
 * model's to choose, and no IR is a model's to write.
 *
 * A program is the only oracle a function whose contract states what it does
 * has, so the program is what these tests check: the source is run with node and
 * the delivered binary is run beside it, and the two are compared line for
 * line.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { STATE_DIRECTORY, runBuild } from "../compiler.ts";
import { run } from "../core/process.ts";
import { resolveFunction } from "../semantics/ir-function.ts";
import { optimizeSemanticFunction } from "../semantics/optimize-ir.ts";
import { NO_CALLEES } from "../semantics/parallel.ts";
import { generateFunctionC } from "../toolchain/ir-c.ts";
import { printSemanticFunction } from "../semantics/ir-text.ts";
import type { SemanticFunction } from "../core/semantic-ir.ts";
import { chatEndpoint } from "./model-endpoint.ts";
import { phaseOf, semanticsOf } from "./phase.ts";
import { writeProject } from "./project.ts";
import { scratch } from "./scratch.ts";

const quiet = { stage: () => {} };

/** A review that finds nothing to change, which is what most rounds answer. */
const SOUND = "verdict: sound\nreason: the body computes what the contract states, and no rule applies to it";

/**
 * The library the program calls: a loop over a buffer, accumulating what it
 * reads, with a divisor of a power of two in it so a rule of the catalogue
 * applies to the body. The guard at the top is what makes the frontend contract
 * this body as a definition rather than as a postcondition, and a definition is
 * the only kind of function the IR has a body to describe.
 */
const LIBRARY = [
  "export function total(values: Float64Array, count: number): number {",
  "  if (count <= 0) {",
  "    return 0;",
  "  }",
  "  let sum = 0;",
  "  for (let index = 0; index < count; index += 1) {",
  "    sum += values[index] / 4;",
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

/** What the compiler resolved for `total`, which is what every candidate starts from. */
function resolvedFunction(): SemanticFunction {
  const phase = phaseOf("typescript", { "main.ts": ENTRY, "lib.ts": LIBRARY }, "main.ts");
  const contract = phase.program.files.find((file) => file.path === "lib.ts")?.functions.total;
  assert.ok(contract !== undefined, "the entry program imports the library function these tests build");
  return resolveFunction(contract, { objectNames: phase.objectNames, functions: {} });
}

/** The IR text the compiler prints for what the source resolved into. */
function resolved(): string {
  return printSemanticFunction(resolvedFunction());
}

/**
 * The IR text a build delivers, which is the resolved IR the optimizer has
 * been over: the passes that run in between are what decide whether a loop's
 * turns may run at once and whether a turn may reuse the storage the turn before
 * it took, and those marks are in the artifact that is built.
 */
function delivered(): string {
  return printSemanticFunction(optimizeSemanticFunction(resolvedFunction(), NO_CALLEES));
}

/** A project of an entry program and the library it calls, with the limits a test needs. */
async function project(name: string, model: object, attempts = 1): Promise<string> {
  const directory = await scratch(`blaze-${name}-`);
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

/** The candidates a build recorded for `total`. */
async function recorded(directory: string): Promise<{ id: string; text: string; proposals?: string[] }[]> {
  const record = JSON.parse(
    await readFile(join(directory, STATE_DIRECTORY, "projects/input/candidates.json"), "utf8"),
  ) as Record<string, { id: string; text: string; proposals?: string[] }[]>;
  return record.total ?? [];
}

test("a program is built from the IR the compiler resolved, with no answer from a model", async (t) => {
  const endpoint = await chatEndpoint(t, [], { answer: () => SOUND });
  const directory = await project("ir-build", { provider: "openai-compatible", model: "stub" });

  const outcome = await runBuild(
    "input.toml",
    { cwd: directory, reuse: false, model: "openai-compatible/stub", maxAttempts: 1 },
    quiet,
    "build",
  );

  assert.equal(outcome.build.status, "success", "the resolved IR is a program the compiler may lower");
  assert.ok(outcome.outputPath !== null, "a program build delivers its binary");
  assert.deepEqual(outcome.build.selectedCandidates, { total: "c1" });

  // The IR the build delivered is the IR the compiler resolved, byte for byte:
  // a review that proposed nothing left it exactly as the source was written.
  const candidates = await recorded(directory);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].text, delivered());
  assert.equal(candidates[0].proposals, undefined, "nothing was proposed, so nothing was rewritten");

  // The review is what the model was asked for, and the IR it read is the
  // artifact the build delivers.
  assert.equal(endpoint.prompts.length, 1, "the IR is reviewed once");
  assert.match(endpoint.prompts[0] ?? "", /THE SEMANTIC IR THE COMPILER RESOLVED THE SOURCE INTO/);
  assert.ok((endpoint.prompts[0] ?? "").includes(resolved()), "the review reads the artifact as it stands");

  // The binary is the one the build verified, and the source is the
  // specification: node runs the TypeScript, the compiler's binary runs the
  // object the IR was lowered into, and the two are compared line for line.
  const binary = run(outcome.outputPath as string, [], { timeoutMs: 60_000 });
  assert.equal(binary.code, 0, `the delivered program stopped: ${binary.stderr.trim()}`);
  assert.equal(binary.stdout, run("node", [join(directory, "main.ts")], { timeoutMs: 60_000 }).stdout);
  assert.equal(binary.stdout, "first 0 of the readings sum to 0\nfirst 2 of the readings sum to 1\nfirst 4 of the readings sum to 2.25\nfirst 6 of the readings sum to 5.75\nnone 0\npair 2\nall 7.75\n");
});

test("a review that proposes a fix has it applied, and the artifact is regenerated", async (t) => {
  // The body divides by four, and a power of two is the one division a
  // multiplication is the same number as, so the proposal is one the catalogue
  // holds and the compiler can regenerate the whole function from.
  const answer = "verdict: repaired\nreason: a division by a power of two is a multiplication\nproposal: reciprocal-multiply entry";
  const endpoint = await chatEndpoint(t, [], { answer: () => answer });
  const directory = await project("ir-proposal", { provider: "openai-compatible", model: "stub" });

  const outcome = await runBuild(
    "input.toml",
    { cwd: directory, reuse: false, model: "openai-compatible/stub", maxAttempts: 1 },
    quiet,
    "build",
  );

  assert.equal(outcome.build.status, "success");
  const candidates = await recorded(directory);
  assert.equal(candidates.length, 1);
  assert.match(candidates[0].text, /set sum \+= \[mul\[f64\] \[element\[f64\] local\[\[\]f64\] values local\[f64\] index\] const\[f64\] 0\.25\]/);
  assert.doesNotMatch(candidates[0].text, /\[div\[f64\]/);
  assert.deepEqual(candidates[0].proposals, ["`reciprocal-multiply entry`: turned 1 division(s) in entry into a multiplication by their reciprocal"]);

  // The regenerated function is the one the build verified: the program it is
  // part of still prints what the source prints.
  assert.ok(outcome.outputPath !== null);
  const binary = run(outcome.outputPath as string, [], { timeoutMs: 60_000 });
  assert.equal(binary.code, 0, binary.stderr);
  assert.equal(binary.stdout, run("node", [join(directory, "main.ts")], { timeoutMs: 60_000 }).stdout);
  assert.equal(endpoint.prompts.length, 1);
});

test("a proposal the compiler refuses leaves the artifact as it was, and says why", async (t) => {
  // Nothing in this function is a repeated value, and no loop here is one the
  // catalogue hoists out of, so both proposals are refused with the reason and
  // the round carries on with what it had.
  const answer = [
    "verdict: repaired",
    "reason: the divisor is read on every iteration",
    "proposal: hoist-invariant entry",
    "proposal: inline-call entry callee=total",
  ].join("\n");
  await chatEndpoint(t, [], { answer: () => answer });
  const directory = await project("ir-refused", { provider: "openai-compatible", model: "stub" });
  const log: string[] = [];

  const outcome = await runBuild(
    "input.toml",
    { cwd: directory, reuse: false, model: "openai-compatible/stub", maxAttempts: 1 },
    { stage: (_stage, _status, message) => log.push(message) },
    "build",
  );

  assert.equal(outcome.build.status, "success");
  const candidates = await recorded(directory);
  assert.equal(candidates[0].text, delivered(), "a refused proposal changes nothing");
  assert.equal(candidates[0].proposals, undefined);
  assert.ok(
    log.some((message) => /total: `hoist-invariant entry` was refused: has a body that .*nothing more than once/.test(message)),
    log.join("\n"),
  );
  // `total` is not called in `entry` at all, so the second proposal is refused
  // for that and not for writing. A callee that writes is inlinable now: the
  // substitution renames its write targets beside its reads, so a write cannot
  // land on a name the caller has. What is still refused is the call the block
  // does not make, and the refusal says which block would hold it.
  assert.ok(
    log.some((message) => /total: `inline-call entry callee=total` was refused: total is not called in block entry/.test(message)),
    log.join("\n"),
  );
});

test("a function that states a postcondition is reviewed and verified like any other", async (t) => {
  // `square` is one expression, so it states a postcondition as well as
  // carrying a body. Both travel: the body is what is implemented, and the
  // postcondition is what the result is checked against. There is no path where
  // a postcondition sends the build back to C.
  const endpoint = await chatEndpoint(t, [], { answer: () => SOUND });
  const directory = await scratch("blaze-ir-postcondition-");
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
  assert.equal(endpoint.prompts.length, 1, "the function is reviewed once");
  assert.match(endpoint.prompts[0] ?? "", /result == \(count \* count\)/, "the postcondition is what the result is held to");
  assert.doesNotMatch(endpoint.prompts[0] ?? "", /C11/, "a postcondition does not send the build back to C");

  const work = (await readdir(join(directory, STATE_DIRECTORY, "projects/input/work/square"))).sort();
  assert.ok(work.includes("c1.ir"), `the IR is what the build delivered: ${work.join(", ")}`);
  assert.ok(work.includes("c1.o"), `the object the compiler lowered it into is in ${work.join(", ")}`);
  // The result is checked against the postcondition, on vectors of its own,
  // rather than by running a program there is no library of.
  assert.ok((outcome.verification.square?.[0]?.cases ?? 0) > 0, "the postcondition verified the result");
});

test("an increment used as a value hands back the value its side says it does", () => {
  // `i++` reads the value the name had and `++i` the value it has after the
  // step, so the two resolve to the same statements in a different order. A
  // snapshot taken before the step in both cases compiles, verifies and runs,
  // and every value the prefix form appears in comes out one step behind.
  const library = (expr: string): string =>
    [
      "export function bump(count: number): number {",
      "  if (count <= 0) { return 0; }",
      "  let i = 5;",
      `  const y = ${expr};`,
      "  return y;",
      "}",
      "",
    ].join("\n");
  const entry = ['import { bump } from "./lib.ts";', "console.log(bump(1));", ""].join("\n");
  const phase = (expr: string) => phaseOf("typescript", { "lib.ts": library(expr), "main.ts": entry }, "main.ts");

  const prefix = printSemanticFunction(semanticsOf(phase("++i")).bump as SemanticFunction);
  const postfix = printSemanticFunction(semanticsOf(phase("i++")).bump as SemanticFunction);
  assert.notEqual(prefix, postfix, "the two sides of an increment are not the same program");
  // The step runs first, so the snapshot the value is read from is the value
  // the step has already written.
  assert.match(prefix, /step i \+\+ pre @4\n {4}let value\[f64\] t\d+ immutable = local\[f64\] i @4/);
  // The snapshot runs first, so it is the value the name had before the step.
  assert.match(postfix, /let value\[f64\] t\d+ immutable = local\[f64\] i @4\n {4}step i \+\+ post @4/);

  // The C is what computes it, and there `++i` is a statement whose value
  // nothing reads, so the order of the two lines is the whole of the value.
  const c = (expr: string): string => generateFunctionC(semanticsOf(phase(expr)).bump as SemanticFunction);
  assert.match(c("++i"), /\+\+i;\n {2}double t\d+ = i;/);
  assert.match(c("i++"), /double t\d+ = i;\n {2}i\+\+;/);
  assert.match(c("--i"), /--i;\n {2}double t\d+ = i;/);
  assert.match(c("i--"), /double t\d+ = i;\n {2}i--;/);
});


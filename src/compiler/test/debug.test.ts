import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBuild } from "../compiler.ts";
import { exclusive } from "../codegen.ts";
import { run } from "../core/process.ts";
import type { SourceInput } from "../core/types.ts";
import { chatEndpoint, type ChatEndpoint } from "./model-endpoint.ts";
import { writeProject } from "./project.ts";

const SQUARE_SOURCE = "export function square(x: number): number {\n  return x * x;\n}\n";

const SQUARE: SourceInput = {
  language: "typescript",
  source: SQUARE_SOURCE,
  entry: "square",
  model: { provider: "openai-compatible", model: "stub" },
  // The answers these tests queue are reviews of what the compiler resolved.
  output: "machine",
  generation: { maxCandidates: 1, maxAttempts: 2 },
  optimize: { primary: "size" },
};

/** A review that finds nothing to change, which is what most rounds answer. */
const SOUND = "verdict: sound\nreason: the body computes what the contract states, and no rule applies to it";

async function project(t: TestContext, answers: string[]): Promise<string> {
  await chatEndpoint(t, answers);
  const directory = await mkdtemp(join(tmpdir(), "blaze-debug-"));
  await writeProject(join(directory, "blaze.toml"), SQUARE);
  return directory;
}

/** A project that produces `candidates` implementations, `candidateConcurrency` at a time. */
async function fanOutProject(
  t: TestContext,
  answers: string[],
  input: Partial<SourceInput>,
  until?: number,
): Promise<{ directory: string; peak: () => number }> {
  const endpoint = await chatEndpoint(t, answers, until === undefined ? {} : { until });
  const directory = await mkdtemp(join(tmpdir(), "blaze-debug-"));
  const project: SourceInput = {
    ...SQUARE,
    generation: { maxCandidates: 1, maxAttempts: 1 },
    ...input,
  };
  await writeProject(join(directory, "blaze.toml"), project);
  return { directory, peak: endpoint.peak };
}

test("candidates are reviewed at the same time when candidate concurrency allows it", async (t) => {
  // The endpoint answers only once three requests are in flight, so a client
  // that reviewed candidates one at a time could never get past the first.
  // The guard timeout is a deadlock escape for that case, not a synchronisation
  // point: it can only turn a real fan-out into a failure, never the reverse.
  const { directory, peak } = await fanOutProject(
    t,
    [SOUND],
    { generation: { maxCandidates: 3, maxAttempts: 1, candidateConcurrency: 3 } },
    3,
  );

  const outcome = await runBuild("blaze.toml", { cwd: directory, reuse: false }, { stage: () => {} }, "build");
  assert.equal(outcome.build.status, "success");
  assert.equal(peak(), 3, "three candidates should have been in flight together");
});

test("candidate concurrency of one reviews candidates one at a time", async (t) => {
  const { directory, peak } = await fanOutProject(
    t,
    [SOUND],
    { generation: { maxCandidates: 3, maxAttempts: 1, candidateConcurrency: 1 } },
  );

  const outcome = await runBuild("blaze.toml", { cwd: directory, reuse: false }, { stage: () => {} }, "build");
  assert.equal(outcome.build.status, "success");
  assert.equal(peak(), 1, "a candidate must be reviewed before the next is asked for");
  // One record per candidate, whatever order they were produced in.
  assert.deepEqual(outcome.candidates.square.map((entry) => entry.id), ["c1", "c2", "c3"]);
  assert.deepEqual(outcome.candidates.square.map((entry) => entry.candidate), [1, 2, 3]);
});

test("without --debug the prompts stay out of the way", async (t) => {
  const endpoint = await chatEndpoint(t, [SOUND]);
  const directory = await mkdtemp(join(tmpdir(), "blaze-debug-"));
  await writeProject(join(directory, "blaze.toml"), SQUARE);

  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  t.after(() => {
    process.stderr.write = original;
  });

  const outcome = await runBuild("blaze.toml", { cwd: directory, reuse: false }, { stage: () => {} }, "build");
  assert.equal(outcome.build.status, "success", endpoint.url);
  assert.equal(written.join(""), "", "a quiet build writes no diagnostics");
});

test("--debug prints the system and user prompt of every review", async (t) => {
  const directory = await project(t, [SOUND]);

  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  t.after(() => {
    process.stderr.write = original;
  });

  const outcome = await runBuild("blaze.toml", { cwd: directory, reuse: false, debug: true }, { stage: () => {} }, "build");
  assert.equal(outcome.build.status, "success");
  assert.equal(outcome.build.selectedCandidates?.square, "c1");

  const debug = written.join("");
  // One dump per review: the IR, and the target it was lowered into.
  assert.equal(debug.match(/-- prompt ir 1\.1: system --/g)?.length, 1);
  assert.equal(debug.match(/-- prompt target 1\.1: system --/g)?.length, 1);
  assert.match(debug, /You are a verification backend for a compiler/);
  assert.match(debug, /"name": "square"/);
  assert.match(debug, /result == \(x \* x\)/);
  assert.match(debug, /architecture: x86_64/);
  assert.match(debug, /WHAT YOU MAY PROPOSE/);
  assert.match(debug, /- reciprocal-multiply:/);
  assert.match(debug, /verdict: sound \| repaired \| unsound/);

  // The first review is handed the IR as the compiler wrote it, and the second
  // is handed the target that IR was lowered into.
  assert.match(debug, /THE SEMANTIC IR THE COMPILER RESOLVED THE SOURCE INTO/);
  assert.match(debug, /return \[mul\[f64\] local\[f64\] x local\[f64\] x\]/);
  assert.match(debug, /THE TARGET CODE THE COMPILER LOWERED THE IR INTO/);
});

test("the prompt reaches the model as the contract and the instructions", async (t) => {
  const endpoint = await chatEndpoint(t, [SOUND]);
  const directory = await mkdtemp(join(tmpdir(), "blaze-debug-"));
  await writeProject(join(directory, "blaze.toml"), SQUARE);

  await runBuild("blaze.toml", { cwd: directory, reuse: false, debug: true }, { stage: () => {} }, "build");

  assert.equal(endpoint.prompts.length, 2, "the IR is reviewed, and then the target it was lowered into");
  const sent = endpoint.prompts[0] ?? "";
  assert.match(sent, /"name": "square"/);
  assert.match(sent, /architecture: x86_64/);
  assert.match(sent, /## SITES A PROPOSAL MAY NAME/);
  assert.match(endpoint.prompts[1] ?? "", /THE TARGET CODE THE COMPILER LOWERED THE IR INTO/);
});

/* -------------------------------------------------------------------------- */
/* Function fan-out                                                           */
/* -------------------------------------------------------------------------- */

/** Two modules, each with one function, so a build has two units to hand out. */
const PAIR_SOURCES: Record<string, string> = {
  "twice.ts": "export function twice(x: number): number {\n  return x * 2;\n}\n",
  "negate.ts": "export function negate(x: number): number {\n  return -x;\n}\n",
  "main.ts": [
    'import { twice } from "./twice.ts";',
    'import { negate } from "./negate.ts";',
    "",
    "console.log(twice(negate(4)));",
    "",
  ].join("\n"),
};

/**
 * A program of two functions, each answered from the request that asked about
 * it: a build that reviews both at once cannot say which request is for which
 * function, so an endpoint that answers in arrival order cannot test it.
 */
async function pairProject(
  t: TestContext,
  generation: Record<string, number>,
  until?: number,
): Promise<{ directory: string; endpoint: ChatEndpoint }> {
  const endpoint = await chatEndpoint(t, [], { until, answer: () => SOUND });
  const directory = await mkdtemp(join(tmpdir(), "blaze-functions-"));
  for (const [name, source] of Object.entries(PAIR_SOURCES)) {
    await writeFile(join(directory, name), source, "utf8");
  }
  await writeProject(join(directory, "blaze.toml"), {
    language: "typescript",
    sourceFile: "main.ts",
    model: { provider: "openai-compatible", model: "stub" },
    output: "machine",
    generation: { maxCandidates: 1, maxAttempts: 1, ...generation },
  });
  return { directory, endpoint };
}

test("functions are reviewed at the same time when function concurrency allows it", async (t) => {
  // The endpoint answers only once both requests are in flight, so a build
  // that generated one function at a time could never get past the first.
  const { directory, endpoint } = await pairProject(t, { functionConcurrency: 2 }, 2);

  const outcome = await runBuild("blaze.toml", { cwd: directory, reuse: false }, { stage: () => {} }, "build");

  assert.equal(outcome.build.status, "success");
  assert.equal(endpoint.peak(), 2, "both functions should have been in flight together");
  assert.equal(run(outcome.outputPath as string, [], { timeoutMs: 60_000 }).stdout, "-8\n");
});

test("function concurrency of one reviews functions one at a time", async (t) => {
  const { directory, endpoint } = await pairProject(t, { functionConcurrency: 1 });

  const outcome = await runBuild("blaze.toml", { cwd: directory, reuse: false }, { stage: () => {} }, "build");

  assert.equal(outcome.build.status, "success");
  assert.equal(endpoint.peak(), 1, "a function must be answered before the next is asked for");
});

test("the default reviews up to three functions at a time", async (t) => {
  // Four functions against a gate of four: a build that never reaches four in
  // flight is capped below it, and the gate opens on its own rather than
  // hanging, so the peak is what the cap is rather than what the gate allowed.
  // Each function scales its argument by a different power of two, so every
  // value the program prints is exact: doubling cannot round.
  const DOUBLES: Record<string, number> = { a: 1, b: 2, c: 3, d: 4 };
  const sources: Record<string, string> = Object.fromEntries(
    Object.entries(DOUBLES).map(([name, times]) => [
      `${name}.ts`,
      `export function ${name}(x: number): number {\n  return x${" * 2".repeat(times)};\n}\n`,
    ]),
  );
  sources["main.ts"] = [
    'import { a } from "./a.ts";',
    'import { b } from "./b.ts";',
    'import { c } from "./c.ts";',
    'import { d } from "./d.ts";',
    "",
    "console.log(a(1) + b(1) + c(1) + d(1));",
    "",
  ].join("\n");
  const endpoint = await chatEndpoint(t, [], {
    until: 4,
    answer: (prompt) => {
      // The contract is in the request, so it says which function is being
      // reviewed however the requests arrive.
      assert.match(prompt, /"name": "(\w+)"/, "the request names the function it is for");
      return SOUND;
    },
  });
  const directory = await mkdtemp(join(tmpdir(), "blaze-default-"));
  for (const [name, source] of Object.entries(sources)) {
    await writeFile(join(directory, name), source, "utf8");
  }
  await writeProject(join(directory, "blaze.toml"), {
    language: "typescript",
    sourceFile: "main.ts",
    model: { provider: "openai-compatible", model: "stub" },
    output: "machine",
    generation: { maxCandidates: 1, maxAttempts: 1 },
  });

  const outcome = await runBuild("blaze.toml", { cwd: directory, reuse: false }, { stage: () => {} }, "build");

  assert.equal(outcome.build.status, "success");
  assert.equal(endpoint.peak(), 3, "three functions at a time is the default");
});

test("the machine lock admits one measurement at a time and survives a failure", async () => {
  // The property a build leans on: a measurement runs with nothing else on the
  // machine, and a candidate that cannot be measured releases the machine for
  // the candidates queued behind it instead of stranding them. The tasks here
  // hand control back and forth explicitly, so the test proves the ordering
  // rather than racing a clock against it.
  const machine = exclusive();
  const events: string[] = [];
  let live = 0;
  let peakLive = 0;
  // A gate each task opens itself, so the test proves the ordering rather than
  // racing a clock against it, and a signal the first task raises once it is on
  // the machine.
  const gates = [0, 1, 2].map(() => Promise.withResolvers<void>());
  const onMachine = Promise.withResolvers<void>();
  const measure = async (name: string, index: number, fails: boolean): Promise<void> => {
    events.push(`enter ${name}`);
    live += 1;
    peakLive = Math.max(peakLive, live);
    onMachine.resolve();
    await gates[index].promise;
    live -= 1;
    events.push(`leave ${name}`);
    if (fails) throw new Error(`${name} could not be measured`);
  };

  const measured = Promise.allSettled([
    machine.run(() => measure("first", 0, false)),
    machine.run(() => measure("second", 1, true)),
    machine.run(() => measure("third", 2, false)),
  ]);
  // The first task holds the machine, so the two queued behind it cannot have
  // started: nothing is running that has not been let on purpose.
  await onMachine.promise;
  assert.deepEqual(events, ["enter first"], "only the first measurement is on the machine");
  gates[0].resolve();
  gates[1].resolve();
  gates[2].resolve();

  const results = await measured;
  assert.equal(peakLive, 1, "two measurements must never share the machine");
  assert.deepEqual(
    results.map((result) => result.status),
    ["fulfilled", "rejected", "fulfilled"],
    "a failed measurement must not fail the candidates queued behind it",
  );
  assert.deepEqual(
    events,
    ["enter first", "leave first", "enter second", "leave second", "enter third", "leave third"],
    "the queue is served in order, and a failure hands the machine on",
  );
});

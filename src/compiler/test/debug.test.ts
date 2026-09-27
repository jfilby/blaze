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

const SQUARE: SourceInput = {
  language: "typescript",
  source: "export function square(x: number): number {\n  return x * x;\n}\n",
  entry: "square",
  model: { provider: "openai-compatible", model: "stub" },
  generation: { maxCandidates: 1, maxAttempts: 2 },
  optimize: { primary: "size" },
};

/** x arrives in xmm0 as a double; the contract asks for x * x. */
const SQUARE_ASSEMBLY = ["\t.globl\tsquare", "square:", "\tmulsd\t%xmm0, %xmm0", "\tret", ""].join("\n");

/** Assembles and links cleanly, but computes x + x, so verification rejects it. */
const WRONG_SQUARE_ASSEMBLY = ["\t.globl\tsquare", "square:", "\taddsd\t%xmm0, %xmm0", "\tret", ""].join("\n");

async function project(t: TestContext, answers: string[]): Promise<string> {
  await chatEndpoint(t, answers);
  const directory = await mkdtemp(join(tmpdir(), "blaze-debug-"));
  await writeFile(join(directory, "blaze.json"), JSON.stringify(SQUARE), "utf8");
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
  await writeFile(join(directory, "blaze.json"), JSON.stringify(project), "utf8");
  return { directory, peak: endpoint.peak };
}

test("candidates are generated at the same time when candidate concurrency allows it", async (t) => {
  // The endpoint answers only once three requests are in flight, so a client
  // that generated candidates one at a time could never get past the first.
  // The guard timeout is a deadlock escape for that case, not a synchronisation
  // point: it can only turn a real fan-out into a failure, never the reverse.
  const { directory, peak } = await fanOutProject(
    t,
    [SQUARE_ASSEMBLY],
    { generation: { maxCandidates: 3, maxAttempts: 1, candidateConcurrency: 3 } },
    3,
  );

  const outcome = await runBuild("blaze.json", { cwd: directory, reuse: false }, { stage: () => {} }, "build");
  assert.equal(outcome.build.status, "success");
  assert.equal(peak(), 3, "three candidates should have been in flight together");
});

test("candidate concurrency of one generates candidates one at a time", async (t) => {
  const { directory, peak } = await fanOutProject(
    t,
    [SQUARE_ASSEMBLY],
    { generation: { maxCandidates: 3, maxAttempts: 1, candidateConcurrency: 1 } },
  );

  const outcome = await runBuild("blaze.json", { cwd: directory, reuse: false }, { stage: () => {} }, "build");
  assert.equal(outcome.build.status, "success");
  assert.equal(peak(), 1, "a candidate must be answered before the next is asked for");
  // One record per candidate, whatever order they were produced in.
  assert.deepEqual(outcome.candidates.square.map((entry) => entry.id), ["c1", "c2", "c3"]);
  assert.deepEqual(outcome.candidates.square.map((entry) => entry.candidate), [1, 2, 3]);
});

test("without --debug the prompts stay out of the way", async (t) => {
  const endpoint = await chatEndpoint(t, [SQUARE_ASSEMBLY]);
  const directory = await mkdtemp(join(tmpdir(), "blaze-debug-"));
  await writeFile(join(directory, "blaze.json"), JSON.stringify(SQUARE), "utf8");

  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  t.after(() => {
    process.stderr.write = original;
  });

  const outcome = await runBuild("blaze.json", { cwd: directory, reuse: false }, { stage: () => {} }, "build");
  assert.equal(outcome.build.status, "success", endpoint.url);
  assert.equal(written.join(""), "", "a quiet build writes no diagnostics");
});

test("--debug prints the system and user prompt of every attempt", async (t) => {
  const directory = await project(t, [WRONG_SQUARE_ASSEMBLY, SQUARE_ASSEMBLY]);

  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  t.after(() => {
    process.stderr.write = original;
  });

  const outcome = await runBuild("blaze.json", { cwd: directory, reuse: false, debug: true }, { stage: () => {} }, "build");
  assert.equal(outcome.build.status, "success", "the repair should succeed");
  assert.equal(outcome.build.selectedCandidates?.square, "c2");

  const debug = written.join("");
  // One dump per attempt: the rejected one and its repair.
  assert.equal(debug.match(/-- prompt 1\.1: system --/g)?.length, 1);
  assert.equal(debug.match(/-- prompt 1\.2: system --/g)?.length, 1);
  assert.match(debug, /You are a code generation backend/);
  assert.match(debug, /"name": "square"/);
  assert.match(debug, /result == \(x \* x\)/);
  assert.match(debug, /architecture: x86_64/);
  assert.match(debug, /OUTPUT LANGUAGE/);
  assert.match(debug, /Write GNU assembler \(GAS\) AT&T syntax for x86-64/);

  // Only the repair names a rejected candidate; the first attempt is generated
  // from the contract alone and has nothing to repair.
  assert.equal(debug.match(/CANDIDATE 1 WAS REJECTED/g)?.length, 1);

  // The repair is handed the assembly it is fixing, and why it was rejected.
  assert.match(debug, /THE OUTPUT BEING REPAIRED/);
  assert.match(debug, /addsd\t%xmm0, %xmm0/, "the repair prompt carries the rejected assembly");
  assert.match(debug, /This is repair attempt 2/);
  assert.match(debug, /verify failed: \d+ of \d+ test vectors did not match the contract/);
  assert.match(debug, /\[attempt 1] verify failed:/, "the diagnostic is attributed to the attempt that earned it");
  assert.match(debug, /expected [\d.e+-]+, got [\d.e+-]+ \(/);
});

test("the prompt reaches the model as the contract and the instructions", async (t) => {
  const endpoint = await chatEndpoint(t, [SQUARE_ASSEMBLY]);
  const directory = await mkdtemp(join(tmpdir(), "blaze-debug-"));
  await writeFile(join(directory, "blaze.json"), JSON.stringify(SQUARE), "utf8");

  await runBuild("blaze.json", { cwd: directory, reuse: false, debug: true }, { stage: () => {} }, "build");

  assert.equal(endpoint.prompts.length, 1);
  const sent = endpoint.prompts[0];
  assert.match(sent, /code generation backend/);
  assert.match(sent, /"name": "square"/);
  assert.match(sent, /architecture: x86_64/);
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

/** `twice` as the model writes it: x arrives in xmm0 as a double. */
const TWICE_ASSEMBLY = ["\t.globl\ttwice", "twice:", "\taddsd\t%xmm0, %xmm0", "\tret", ""].join("\n");

/** `negate` flips the sign bit, which is what -x is for a double. */
const NEGATE_ASSEMBLY = [
  "\t.globl\tnegate",
  "negate:",
  "\tmovq\t$-9223372036854775808, %rax",
  "\tmovq\t%rax, %xmm1",
  "\txorpd\t%xmm1, %xmm0",
  "\tret",
  "",
].join("\n");

/**
 * A program of two functions, each answered from the prompt that asked for it:
 * a build that generates both at once cannot say which request is for which
 * function, so an endpoint that answers in arrival order cannot test it.
 */
async function pairProject(
  t: TestContext,
  generation: Record<string, number>,
  until?: number,
): Promise<{ directory: string; endpoint: ChatEndpoint }> {
  const endpoint = await chatEndpoint(t, [], {
    until,
    answer: (prompt) => (prompt.includes('"name": "twice"') ? TWICE_ASSEMBLY : NEGATE_ASSEMBLY),
  });
  const directory = await mkdtemp(join(tmpdir(), "blaze-functions-"));
  for (const [name, source] of Object.entries(PAIR_SOURCES)) {
    await writeFile(join(directory, name), source, "utf8");
  }
  await writeFile(
    join(directory, "blaze.json"),
    JSON.stringify({
      language: "typescript",
      sourceFile: "main.ts",
      model: { provider: "openai-compatible", model: "stub" },
      output: "machine",
      generation: { maxCandidates: 1, maxAttempts: 1, ...generation },
    }),
    "utf8",
  );
  return { directory, endpoint };
}

test("functions are generated at the same time when function concurrency allows it", async (t) => {
  // The endpoint answers only once both requests are in flight, so a build
  // that generated one function at a time could never get past the first.
  const { directory, endpoint } = await pairProject(t, { functionConcurrency: 2 }, 2);

  const outcome = await runBuild("blaze.json", { cwd: directory, reuse: false }, { stage: () => {} }, "build");

  assert.equal(outcome.build.status, "success");
  assert.equal(endpoint.peak(), 2, "both functions should have been in flight together");
  assert.equal(run(outcome.outputPath as string, [], { timeoutMs: 60_000 }).stdout, "-8\n");
});

test("function concurrency of one generates functions one at a time", async (t) => {
  const { directory, endpoint } = await pairProject(t, { functionConcurrency: 1 });

  const outcome = await runBuild("blaze.json", { cwd: directory, reuse: false }, { stage: () => {} }, "build");

  assert.equal(outcome.build.status, "success");
  assert.equal(endpoint.peak(), 1, "a function must be answered before the next is asked for");
});

test("the default generates up to three functions at a time", async (t) => {
  // Four functions against a gate of four: a build that never reaches four in
  // flight is capped below it, and the gate opens on its own rather than
  // hanging, so the peak is what the cap is rather than what the gate allowed.
  // Each function doubles its argument a different number of times, so the
  // assembly is a whole number of `addsd` and every intermediate is exact:
  // scaling by a power of two cannot round.
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
  const assembly = (name: string, times: number): string =>
    [`\t.globl\t${name}`, `${name}:`, ...Array.from({ length: times }, () => "\taddsd\t%xmm0, %xmm0"), "\tret", ""].join(
      "\n",
    );
  const endpoint = await chatEndpoint(t, [], {
    until: 4,
    answer: (prompt) => {
      // The contract is in the prompt, so it says which function is being asked
      // for however the requests arrive.
      const name = /"name": "(\w+)"/.exec(prompt)?.[1];
      assert.ok(name !== undefined, "the prompt names the function it is for");
      return assembly(name, DOUBLES[name] ?? 1);
    },
  });
  const directory = await mkdtemp(join(tmpdir(), "blaze-default-"));
  for (const [name, source] of Object.entries(sources)) {
    await writeFile(join(directory, name), source, "utf8");
  }
  await writeFile(
    join(directory, "blaze.json"),
    JSON.stringify({
      language: "typescript",
      sourceFile: "main.ts",
      model: { provider: "openai-compatible", model: "stub" },
      output: "machine",
      generation: { maxCandidates: 1, maxAttempts: 1 },
    }),
    "utf8",
  );

  const outcome = await runBuild("blaze.json", { cwd: directory, reuse: false }, { stage: () => {} }, "build");

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

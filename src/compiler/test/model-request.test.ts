import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBuild, inspectProject } from "../compiler.ts";
import type { SourceInput } from "../core/types.ts";
import { CompilerError } from "../core/errors.ts";
import { chatEndpoint, type ChatEndpoint, type ChatEndpointOptions } from "./model-endpoint.ts";
import { writeProject } from "./project.ts";

const quiet = { stage: () => {} };
const SOURCE = "export function square(x: number): number {\n  return x * x;\n}\n";

/**
 * A project pointed at a model that never answers, which is what a model
 * that is still thinking looks like from the outside.
 */
async function projectWaitingOn(
  t: TestContext,
  generation: SourceInput["generation"],
): Promise<{ directory: string; received: Promise<void> }> {
  const endpoint = await chatEndpoint(t, [], { silent: true });

  const directory = await mkdtemp(join(tmpdir(), "blaze-model-"));
  const input: SourceInput = {
    language: "typescript",
    source: SOURCE,
    entry: "square",
    model: { provider: "openai-compatible", model: "silent" },
    // The answer this test waits on is the review of the entry function's IR.
    output: "machine",
    generation,
  };
  await writeProject(join(directory, "input.toml"), input);
  return { directory, received: endpoint.received };
}

/**
 * A project pointed at a model that answers whatever the test queued, one
 * answer per request, the last one repeated once the queue runs out.
 */
async function projectAnswering(
  t: TestContext,
  answers: readonly string[],
  generation: SourceInput["generation"],
  endpoint: ChatEndpointOptions = {},
  source = SOURCE,
): Promise<{ directory: string; chat: ChatEndpoint }> {
  const chat = await chatEndpoint(t, answers, endpoint);
  const directory = await mkdtemp(join(tmpdir(), "blaze-model-"));
  const input: SourceInput = {
    language: "typescript",
    source,
    entry: "square",
    model: { provider: "openai-compatible", model: "stub" },
    // The answers this test queues are the reviews of the entry function.
    output: "machine",
    generation,
  };
  await writeProject(join(directory, "input.toml"), input);
  return { directory, chat };
}

/** A review that finds nothing to change, which is what most rounds answer. */
const SOUND = "verdict: sound\nreason: the body computes what the contract states, and no rule applies to it";

/** A review that fixes something, so a build has a proposal to apply. */
const HOISTED = "verdict: repaired\nreason: the bound is read on every iteration\nproposal: hoist-invariant b1";

test("a model that has not answered is waited for, not given up on", async (t) => {
  const { directory, received } = await projectWaitingOn(t, { maxCandidates: 1, maxAttempts: 1 });

  let settled = false;
  const building = runBuild("input.toml", { cwd: directory, reuse: false }, quiet, "build").then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  // The request is open and the model has said nothing. There is no budget in
  // this project, so the build must still be waiting on it.
  await received;
  assert.equal(settled, false, "the build should still be waiting for the model");
  void building;
});

// The tests below do wait on the clock, on purpose: the subject is a wall clock
// budget, so the only way to observe it is for it to elapse. Each one waits for
// the shortest budget the assertion needs.
test("a project that sets a budget gives up when the model overruns it", async (t) => {
  const { directory } = await projectWaitingOn(t, { maxCandidates: 1, maxAttempts: 1, timeoutSeconds: 1 });

  await assert.rejects(
    () => runBuild("input.toml", { cwd: directory, reuse: false }, quiet, "build"),
    (error: unknown) => {
      const diagnostic =
        error instanceof Error ? `${error.message}\n${(error as { detail?: string }).detail ?? ""}` : String(error);
      assert.match(diagnostic, /did not answer within 1s/);
      assert.match(diagnostic, /remove generation\.timeoutSeconds/);
      return true;
    },
  );
});

test("the build record keeps the model that was asked", async (t) => {
  const { directory } = await projectWaitingOn(t, { maxCandidates: 1, maxAttempts: 1, timeoutSeconds: 1 });
  await assert.rejects(() => runBuild("input.toml", { cwd: directory, reuse: false }, quiet, "build"));

  const build = await inspectProject("input", directory);
  assert.equal(build.status, "failed");
  assert.equal(build.model, "openai-compatible/silent");
  assert.equal(build.error?.category, "AiReviewError");
});

test("the compiler says which model it is waiting for", async (t) => {
  const { directory } = await projectWaitingOn(t, { maxCandidates: 1, maxAttempts: 1, timeoutSeconds: 1 });
  const lines: string[] = [];
  await assert.rejects(() =>
    runBuild(
      "input.toml",
      { cwd: directory, reuse: false },
      { stage: (_stage, _status, message) => lines.push(message) },
      "build",
    ),
  );

  assert.ok(lines.includes("Model: openai-compatible/silent"), `no model line in: ${lines.join(" | ")}`);
  const reviewing = lines.filter((line) => line.startsWith("Reviewing the "));
  assert.equal(reviewing.length, 1, `expected one review line in: ${lines.join(" | ")}`);
  assert.match(reviewing[0], /: square, candidate 1 of 1, round 1 of 1, /);
  assert.ok(
    reviewing[0].endsWith("waiting for openai-compatible/silent"),
    `the review line does not name the model: ${reviewing[0]}`,
  );
});

test("an answer that is not a review is asked for again, and costs no round", async (t) => {
  const { directory, chat } = await projectAnswering(
    t,
    ["", "here is the implementation", SOUND],
    { maxCandidates: 1, maxAttempts: 1, maxRetries: 2 },
  );
  const lines: string[] = [];
  const outcome = await runBuild(
    "input.toml",
    { cwd: directory, reuse: false },
    { stage: (_stage, _status, message) => lines.push(message) },
    "build",
  );

  assert.equal(outcome.build.status, "success");
  // Three answers for the IR round and one for the target that was reviewed
  // afterwards: an answer that could not be read never became a revision, so
  // the round kept the only attempt the project gave it.
  assert.equal(chat.prompts.length, 4);
  assert.deepEqual(outcome.candidates.square.map((entry) => entry.round), [1]);
  assert.match(chat.prompts[3] ?? "", /THE TARGET CODE THE COMPILER LOWERED THE IR INTO/);
  // The re-request says what was wrong with the answers before it.
  assert.match(chat.prompts[2] ?? "", /THE PREVIOUS ANSWER COULD NOT BE READ/);
  assert.match(chat.prompts[2] ?? "", /the answer gives no verdict/);
  assert.match(chat.prompts[2] ?? "", /line 1 is neither a verdict, a reason nor a proposal/);
  assert.ok(
    lines.some((line) =>
      line.includes("Asking again: square, ir of candidate 1, round 1, the answer gives no verdict, finish reason: stop, usage: 1 in, 1 out; request 1 of 2, waiting for openai-compatible/stub"),
    ),
    `no retry line in: ${lines.join(" | ")}`,
  );
});

test("a model that never answers with a review fails with every reason it gave", async (t) => {
  const { directory, chat } = await projectAnswering(t, [""], {
    maxCandidates: 1,
    maxAttempts: 2,
    maxRetries: 1,
  });

  await assert.rejects(
    () => runBuild("input.toml", { cwd: directory, reuse: false }, quiet, "build"),
    (error: unknown) =>
      error instanceof CompilerError &&
      error.message === "the model did not answer with a review the compiler could read" &&
      /asked 2 times/.test(error.detail ?? ""),
  );
  assert.equal(chat.prompts.length, 2, "the re-request is the only request beyond the first");
});

test("an answer the provider stopped short of says why it stopped", async (t) => {
  const { directory, chat } = await projectAnswering(
    t,
    [""],
    { maxCandidates: 1, maxAttempts: 1, maxRetries: 1 },
    { finishReason: "length" },
  );
  const lines: string[] = [];

  await assert.rejects(
    () =>
      runBuild(
        "input.toml",
        { cwd: directory, reuse: false },
        { stage: (_stage, _status, message) => lines.push(message) },
        "build",
      ),
    (error: unknown) =>
      error instanceof CompilerError &&
      /asked 2 times/.test(error.detail ?? "") &&
      /the answer was cut off at the token limit before it was finished \(finish reason: length, usage: 1 in, 1 out\)/.test(
        error.detail ?? "",
      ),
  );
  // The build is told the same thing while it is still waiting on the model.
  assert.ok(
    lines.some((line) =>
      line.includes("the answer was cut off at the token limit before it was finished, finish reason: length, usage: 1 in, 1 out; request 1 of 1"),
    ),
    `no retry line in: ${lines.join(" | ")}`,
  );
  // The re-request carries what was wrong with the answer, not how the
  // provider stopped or what it cost: a stop is a fact about the request the
  // model cannot change by being asked again.
  assert.equal(chat.prompts.length, 2);
  assert.match(chat.prompts[1], /the answer was cut off at the token limit/);
  assert.doesNotMatch(chat.prompts[1], /finish reason/);
});

test("a stop the provider names differently says both names", async (t) => {
  // A content filter is the one stop whose provider name is worth having: the
  // unified reason says what happened, the provider's own says what it calls
  // it, and only the first of the two is the same across providers.
  const { directory } = await projectAnswering(
    t,
    [""],
    { maxCandidates: 1, maxAttempts: 1, maxRetries: 1 },
    { finishReason: "content_filter" },
  );

  await assert.rejects(
    () => runBuild("input.toml", { cwd: directory, reuse: false }, quiet, "build"),
    (error: unknown) =>
      error instanceof CompilerError &&
      /finish reason: content-filter, raw: content_filter/.test(error.detail ?? ""),
  );
});

test("a provider that reports no tokens is not said to have spent none", async (t) => {
  // A gateway that does not account for usage is not a request that cost
  // nothing, and a line reading "usage: 0 in" would say it was.
  const { directory } = await projectAnswering(
    t,
    [""],
    { maxCandidates: 1, maxAttempts: 1, maxRetries: 1 },
    { finishReason: "length", usage: null },
  );

  await assert.rejects(
    () => runBuild("input.toml", { cwd: directory, reuse: false }, quiet, "build"),
    (error: unknown) =>
      error instanceof CompilerError &&
      /the answer was cut off at the token limit before it was finished \(finish reason: length\)/.test(
        error.detail ?? "",
      ) &&
      !/usage/.test(error.detail ?? ""),
  );
});

/**
 * A reply that stops where the limit fell: a review whose verdict line is
 * there and whose proposals are cut in half. This is the shape a token limit
 * produces, and the reason the stop is checked before the text is read.
 */
const CUT_OFF_REVIEW = ["verdict: repaired", "reason: the bound is read on every", "proposal: hoist-inv"].join("\n");

test("a reply cut off at the token limit is not a review", async (t) => {
  const { directory, chat } = await projectAnswering(
    t,
    [CUT_OFF_REVIEW, SOUND],
    { maxCandidates: 1, maxAttempts: 1, maxRetries: 1 },
    { finishReasons: ["length", "stop"] },
  );
  const lines: string[] = [];

  const outcome = await runBuild(
    "input.toml",
    { cwd: directory, reuse: false },
    { stage: (_stage, _status, message) => lines.push(message) },
    "build",
  );

  // The half-written answer is never read: what the round holds is the whole
  // answer the re-request came back with, and none of what the limit cut.
  assert.equal(outcome.candidates.square.length, 1);
  assert.equal(outcome.build.status, "success");
  // It cost a request, not a round: a reply that was never a review was never
  // a revision to reject. The third request is the review of the target the
  // re-request's answer produced.
  assert.equal(chat.prompts.length, 3);
  assert.deepEqual(outcome.candidates.square.map((entry) => entry.round), [1]);
  assert.ok(
    lines.some((line) =>
      line.includes("the answer was cut off at the token limit before it was finished, finish reason: length"),
    ),
    `no retry line in: ${lines.join(" | ")}`,
  );
  // The re-request says the answer was cut off, which the model can act on by
  // writing less, and not how the provider stopped, which it cannot.
  assert.match(chat.prompts[1], /cut off at the token limit/);
  assert.doesNotMatch(chat.prompts[1], /finish reason/);
});

test("a model that keeps writing past the limit fails saying what it cost", async (t) => {
  const { directory, chat } = await projectAnswering(
    t,
    [CUT_OFF_REVIEW],
    { maxCandidates: 1, maxAttempts: 1, maxRetries: 1 },
    { finishReason: "length", usage: { prompt: 900, completion: 4096, total: 4996 } },
  );

  await assert.rejects(
    () => runBuild("input.toml", { cwd: directory, reuse: false }, quiet, "build"),
    (error: unknown) =>
      error instanceof CompilerError &&
      error.message === "the model wrote more than it was allowed to answer" &&
      /asked 2 times/.test(error.detail ?? "") &&
      /the answer was cut off at the token limit before it was finished \(finish reason: length, usage: 900 in, 4096 out\)/.test(
        error.detail ?? "",
      ),
  );
  assert.equal(chat.prompts.length, 2);
});

test("a request the provider failed is asked for again", async (t) => {
  const { directory, chat } = await projectAnswering(
    t,
    [SOUND],
    { maxCandidates: 1, maxAttempts: 1, maxRetries: 1 },
    { failFirst: 1 },
  );

  const outcome = await runBuild("input.toml", { cwd: directory, reuse: false }, quiet, "build");
  assert.equal(outcome.build.status, "success");
  assert.equal(chat.prompts.length, 3, "the failed request was asked for again, and the target was reviewed after it");
  assert.match(chat.prompts[1] ?? "", /the provider request failed/);
});

test("a review of the IR and a review of the target each regenerate the artifact", async (t) => {
  // One function, two reviews: the IR is reviewed before it is lowered, and
  // the target the compiler lowered it into is reviewed afterwards. Both are
  // asked of the same model and both are answered from the same queue, and the
  // first one is what changed.
  const reduction = [
    "export function square(values: Float64Array, n: number): number {",
    "  let total = 0;",
    "  for (let i = 0; i < n; i++) {",
    "    total += (i * n) / (n * n) + (i * n) / (n * n);",
    "  }",
    "  return total;",
    "}",
    "",
  ].join("\n");
  const { directory, chat } = await projectAnswering(
    t,
    [HOISTED],
    { maxCandidates: 1, maxAttempts: 1 },
    {},
    reduction,
  );

  const outcome = await runBuild("input.toml", { cwd: directory, reuse: false }, quiet, "build");

  assert.equal(outcome.build.status, "success");
  assert.equal(chat.prompts.length, 2, "the IR is reviewed, and then the target it was lowered into");
  assert.match(chat.prompts[0] ?? "", /THE SEMANTIC IR THE COMPILER RESOLVED THE SOURCE INTO/);
  assert.match(chat.prompts[1] ?? "", /THE TARGET CODE THE COMPILER LOWERED THE IR INTO/);

  const [candidate] = outcome.candidates.square;
  assert.ok(candidate !== undefined);
  assert.equal(candidate.proposals?.length, 1, "what the review changed is recorded with the candidate");
  assert.match(candidate.proposals?.[0] ?? "", /^`hoist-invariant b1`: hoisted 1 value\(s\)/);
  assert.match(candidate.text, /hoisted1/, "the artifact is the one the rule produced");
  // The second review proposed the same rule for the same loop, and there was
  // nothing left for it to hoist, so it changed nothing and the candidate is
  // the one the first review produced.
  assert.equal(outcome.candidates.square.length, 1);
});

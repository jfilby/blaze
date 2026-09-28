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
): Promise<{ directory: string; chat: ChatEndpoint }> {
  const chat = await chatEndpoint(t, answers, endpoint);
  const directory = await mkdtemp(join(tmpdir(), "blaze-model-"));
  const input: SourceInput = {
    language: "typescript",
    source: SOURCE,
    entry: "square",
    model: { provider: "openai-compatible", model: "stub" },
    generation,
  };
  await writeProject(join(directory, "input.toml"), input);
  return { directory, chat };
}

/** x arrives in xmm0 as a double; the contract asks for x * x. */
const SQUARE_ASSEMBLY = ["\t.globl\tsquare", "square:", "\tmulsd\t%xmm0, %xmm0", "\tret", ""].join("\n");

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
  assert.equal(build.error?.category, "AiGenerationError");
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
  assert.ok(
    lines.some((line) => line === "Generating assembly: square, candidate 1 of 1, attempt 1 of 1, waiting for openai-compatible/silent"),
    `no generating line in: ${lines.join(" | ")}`,
  );
});

test("an answer with no implementation is asked for again, and costs no repair attempt", async (t) => {
  const { directory, chat } = await projectAnswering(
    t,
    ["", "   ", SQUARE_ASSEMBLY],
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
  // Three answers, all of them for one attempt: an answer with no
  // implementation in it never became a candidate, so the candidate kept the
  // only attempt the project gave it.
  assert.equal(chat.prompts.length, 3);
  assert.deepEqual(outcome.candidates.square.map((entry) => entry.round), [1]);
  // The re-request says what was wrong with the answer before it.
  assert.match(chat.prompts[2], /THE PREVIOUS ANSWER COULD NOT BE USED/);
  assert.match(chat.prompts[2], /the model returned an empty response/);
  assert.ok(
    lines.includes(
      "Asking again: square, candidate 1, attempt 1, the model returned an empty response, finish reason: stop, usage: 1 in, 1 out; request 1 of 2, waiting for openai-compatible/stub",
    ),
    `no retry line in: ${lines.join(" | ")}`,
  );
});

test("a model that never answers with an implementation fails with every reason it gave", async (t) => {
  const { directory, chat } = await projectAnswering(t, [""], {
    maxCandidates: 1,
    maxAttempts: 2,
    maxRetries: 1,
  });

  await assert.rejects(
    () => runBuild("input.toml", { cwd: directory, reuse: false }, quiet, "build"),
    (error: unknown) =>
      error instanceof CompilerError &&
      error.message === "the model returned an empty response" &&
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
      /the model returned an empty response \(finish reason: length, usage: 1 in, 1 out\)/.test(error.detail ?? ""),
  );
  // The build is told the same thing while it is still waiting on the model.
  assert.ok(
    lines.some((line) =>
      line.includes("the model returned an empty response, finish reason: length, usage: 1 in, 1 out; request 1 of 1"),
    ),
    `no retry line in: ${lines.join(" | ")}`,
  );
  // The re-request carries what was wrong with the answer, not how the
  // provider stopped or what it cost: a stop is a fact about the request the
  // model cannot change by being asked again.
  assert.equal(chat.prompts.length, 2);
  assert.match(chat.prompts[1], /the model returned an empty response/);
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
      /the model returned an empty response \(finish reason: length\)/.test(error.detail ?? "") &&
      !/usage/.test(error.detail ?? ""),
  );
});

/**
 * A reply that closes its fence and then stops: everything `extractAssembly`
 * asks for, and an implementation that ends mid-instruction. This is the
 * shape a token limit produces, and the reason the stop is checked before the
 * text rather than after it.
 */
const CUT_OFF_ASSEMBLY = ["```asm", "\t.globl\tsquare", "square:", "\tmulsd\t%xmm0, %xmm0", "\taddsd", "```"].join("\n");

test("a reply cut off at the token limit is not an implementation", async (t) => {
  const { directory, chat } = await projectAnswering(
    t,
    [CUT_OFF_ASSEMBLY, SQUARE_ASSEMBLY],
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

  // The half-written function is never assembled: what the candidate holds is
  // the whole answer the re-request came back with, and none of the
  // instruction the limit cut through.
  assert.equal(outcome.candidates.square.length, 1);
  assert.match(outcome.candidates.square[0].assembly, /mulsd/);
  assert.doesNotMatch(outcome.candidates.square[0].assembly, /addsd/);
  assert.equal(outcome.build.status, "success");
  // It cost a request, not an attempt: a reply that never became an
  // implementation never became a candidate to repair.
  assert.equal(chat.prompts.length, 2);
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
    [CUT_OFF_ASSEMBLY],
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
    [SQUARE_ASSEMBLY],
    { maxCandidates: 1, maxAttempts: 1, maxRetries: 1 },
    { failFirst: 1 },
  );

  const outcome = await runBuild("input.toml", { cwd: directory, reuse: false }, quiet, "build");
  assert.equal(outcome.build.status, "success");
  assert.equal(chat.prompts.length, 2);
  assert.match(chat.prompts[1], /the provider request failed/);
});

const DECLINED = [
  "STATUS: failed",
  "The contract requires behavior that cannot be implemented",
  "with the available information.",
].join("\n");

test("a model that reports it cannot implement the contract ends the build there", async (t) => {
  const { directory, chat } = await projectAnswering(t, [DECLINED], { maxCandidates: 1, maxAttempts: 3, maxRetries: 2 });

  await assert.rejects(
    () => runBuild("input.toml", { cwd: directory, reuse: false }, quiet, "build"),
    (error: unknown) =>
      error instanceof CompilerError &&
      error.category === "ModelDeclinedError" &&
      error.stage === "generate" &&
      error.functionName === "square" &&
      error.message === "The contract requires behavior that cannot be implemented\nwith the available information.",
  );
  // One request and no repair: the report is the answer, so nothing asks the
  // model again for the contract it just said it cannot meet.
  assert.equal(chat.prompts.length, 1);
  // The build record keeps the model's own account of why, not a diagnostic
  // the compiler wrote about it.
  const build = await inspectProject("input", directory);
  assert.equal(build.status, "failed");
  assert.equal(build.error?.category, "ModelDeclinedError");
  assert.equal(build.error?.message, "The contract requires behavior that cannot be implemented\nwith the available information.");
});

test("a failure status with nothing under it is asked for again", async (t) => {
  // A status nobody accounted for is an answer that cannot be used rather
  // than a failure to believe, so the re-request says the report is missing
  // and the build carries on when the reason arrives.
  const { directory, chat } = await projectAnswering(t, ["STATUS: failed", SQUARE_ASSEMBLY], {
    maxCandidates: 1,
    maxAttempts: 1,
    maxRetries: 1,
  });

  const outcome = await runBuild("input.toml", { cwd: directory, reuse: false }, quiet, "build");
  assert.equal(outcome.build.status, "success");
  assert.equal(chat.prompts.length, 2);
  assert.match(chat.prompts[1], /reported a failure and said nothing about it/);
});

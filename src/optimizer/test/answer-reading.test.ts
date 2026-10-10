/**
 * What is read out of what a model wrote.
 *
 * Two readings and both of them are of untrusted text: the answer a review
 * gave back, which is JSON wherever the model felt like putting it, and the
 * `--debug` output a build wrote, which is the compiler's own format with
 * the model's own text inside it. Neither may fail the pass for a shape it
 * does not have to fail for, and neither may mistake a quoted line inside a
 * body for a header of its own.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseResponse } from "../ai.ts";
import { extractDebug } from "../build-feedback.ts";

test("an answer's JSON is read wherever the answer wrote it", () => {
  const answer = [
    "Here is what I would change:",
    "```json",
    JSON.stringify({
      summary: "hoist the invariant",
      proposals: [{ file: "a.ts", description: "why", original: "a", replacement: "b" }],
    }),
    "```",
    "Let me know if you want more.",
  ].join("\n");

  const read = parseResponse(answer);

  assert.equal(read.summary, "hoist the invariant");
  assert.equal(read.proposals.length, 1);
  assert.deepEqual(read.proposals[0], { file: "a.ts", description: "why", original: "a", replacement: "b" });
});

test("an answer with no JSON is refused naming what was read", () => {
  assert.throws(
    () => parseResponse("I am sorry, I cannot help with compiler optimisation."),
    /the answer held no JSON object/,
  );
});

test("an answer whose JSON cannot be read is refused naming what was read", () => {
  // A trailing comma: the braces are there, the JSON is not.
  assert.throws(() => parseResponse('{"summary": "x",}'), /could not be read/);
});

test("a proposal missing any field is dropped rather than applied blind", () => {
  const answer = JSON.stringify({
    summary: "s",
    proposals: [
      { file: "a.ts", description: "d", original: "o", replacement: "r" },
      { file: "b.ts", description: "d", original: "o" },
      { description: "d", original: "o", replacement: "r" },
      { file: "c.ts", description: "", original: "o", replacement: "r" },
    ],
  });

  assert.deepEqual(
    parseResponse(answer).proposals.map((p) => p.file),
    ["a.ts"],
  );
});

/** Exactly what the compiler writes to stderr for `--debug`. */
const DEBUG_OUTPUT = [
  "blaze: reading the project",
  "-- prompt ir 1.1: system --",
  "You are reviewing the IR of one function.",
  "-- prompt ir 1.1: user --",
  "## Contract",
  "-- prompt target 1.1: system --",
  "a second stage",
  "-- answer ir 1.1 request 1 --",
  // quoteReply indents what it quotes, so a header inside a body is not at
  // the start of a line and must not split the block it is inside.
  "    -- answer ir 1.1 request 1 --",
  "    { not json }",
  "-- answer ir 1.1 request 2 --",
  "a second refusal",
].join("\n");

test("a build's debug output is read by its own headers", () => {
  const blocks = extractDebug(DEBUG_OUTPUT);

  assert.deepEqual(
    blocks.prompts.map((p) => p.split("\n")[0]),
    ["-- prompt ir 1.1: system --", "-- prompt ir 1.1: user --", "-- prompt target 1.1: system --"],
  );
  assert.deepEqual(
    blocks.answers.map((a) => a.split("\n")[0]),
    ["-- answer ir 1.1 request 1 --", "-- answer ir 1.1 request 2 --"],
  );
});

test("a block's body is kept as it was written", () => {
  const blocks = extractDebug(DEBUG_OUTPUT);

  assert.match(blocks.prompts[0] ?? "", /You are reviewing the IR/);
  assert.match(blocks.prompts[1] ?? "", /## Contract/);
  assert.match(blocks.answers[0] ?? "", /not json/);
  assert.match(blocks.answers[1] ?? "", /a second refusal/);
});

test("a prompt body longer than its budget keeps its label and its end", () => {
  const long = ["-- prompt ir 1.1: user --", "x".repeat(9000)].join("\n");

  const blocks = extractDebug(long);

  assert.match(blocks.prompts[0] ?? "", /^-- prompt ir 1.1: user --/);
  assert.match(blocks.prompts[0] ?? "", /\[truncated\]/);
  assert.match(blocks.prompts[0] ?? "", /x{100}$/);
  assert.ok((blocks.prompts[0] ?? "").length < 9000);
});

test("a debug output with no review in it reads as nothing", () => {
  const blocks = extractDebug("blaze: reading the project\nblaze: done\n");

  assert.deepEqual(blocks, { prompts: [], answers: [] });
});

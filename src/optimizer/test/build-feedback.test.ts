/**
 * What a build is read for, and what it says when there is nothing to read.
 *
 * A build-feedback run is the reviewer's prompts and answers, which only
 * exist if a model reviewed. A build with no model reviews nothing at all
 * and says so in its own output, and that is a different sentence from a
 * build that failed before it reviewed anything: the one is a thing to set
 * in the environment and the other is a build to read the output of.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { extractDebug } from "../build-feedback.ts";

/** What the compiler's own output says when no model is configured. */
const NO_MODEL_OUTPUT = [
  "· Mode: danger (-O3)",
  "· Model: (unset)",
  "✓ Semantic IR: 3 function(s) resolved and validated",
  "✓ machine code built into a testable implementation",
].join("\n");

test("a build with no model is said to have reviewed nothing, and why", () => {
  // The build succeeded, so nothing about it failed: there is no review in
  // it because there was nothing to review with.
  const blocks = extractDebug(NO_MODEL_OUTPUT);

  assert.deepEqual(blocks, { prompts: [], answers: [] });
  assert.match(NO_MODEL_OUTPUT, /Model:\s*\(unset\)/);
});

test("a build that failed before reviewing is left to its own output", () => {
  const refused = extractDebug("blaze: reading the project\nblaze: nothing was reviewed\n");

  assert.deepEqual(refused, { prompts: [], answers: [] });
  assert.doesNotMatch("blaze: nothing was reviewed", /Model:\s*\(unset\)/);
});

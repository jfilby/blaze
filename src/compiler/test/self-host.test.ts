/**
 * The compiler's own sources, measured against the TypeScript subset.
 *
 * A compiler that compiles itself starts with its own tree: every source that
 * makes the binary has to be a source the frontend reads. This test reads them
 * all and reports what is still outside the subset, so a slice that teaches the
 * frontend one more construct shows up as a lower number rather than as a
 * feeling that progress was made.
 *
 * The budget is a ratchet, not a target. It is lowered by the change that earns
 * the lowering, and a change that adds a construct to the compiler raises it in
 * the same commit and says why.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { selfHostGap } from "./self-host-gap.ts";

/**
 * The refusals the compiler's sources earn today.
 *
 * It was 6339 when the report was added, 6248 after the type-only slice, and
 * 6313 when the platform boundary added its two sources. Object shorthand and
 * the text methods lowered it to 5856. Lower it with every slice; raise it only
 * when the compiler itself starts using a construct the frontend has not
 * learned yet.
 */
const REFUSAL_BUDGET = 5856;

/** One read of the tree, shared by the tests that read the report. */
const measured = selfHostGap();

test("the compiler's own sources are measured against the TypeScript subset", async (t) => {
  const report = await measured;

  t.diagnostic(
    `self-host: ${report.clean.length} of ${report.files.length} sources read, ` +
      `${report.refused.length} refused, ${report.total} refusals`,
  );
  for (const kind of report.refusals.slice(0, 10)) {
    t.diagnostic(`${String(kind.count).padStart(5)}  ${kind.message}  (e.g. ${kind.files[0]})`);
  }

  assert.ok(report.files.length > 0, "the compiler has sources to read");
  assert.equal(
    report.files.length,
    report.clean.length + report.refused.length,
    "every source is either read or refused",
  );
  assert.ok(
    report.total <= REFUSAL_BUDGET,
    `${report.total} refusals is more than the budget of ${REFUSAL_BUDGET}: a slice lowered it, so lower the budget, or the compiler grew a construct the frontend does not read`,
  );
});

test("a source that is refused says why, and one that is read says nothing", async () => {
  const report = await measured;
  for (const refused of report.refused) {
    assert.ok(refused.count > 0, `${refused.path} is refused and counts at least one construct`);
    assert.ok(refused.messages.length > 0, `${refused.path} is refused without a reason`);
  }
  for (const clean of report.clean) {
    assert.ok(report.files.includes(clean), `${clean} is a source of the compiler`);
  }
});

test("the sources that make the compiler are not the tests, the benchmarks or the scratch programs", async () => {
  const report = await measured;
  for (const path of report.files) {
    assert.doesNotMatch(path, /^(test|bench|scratch)\//, `${path} is not compiled into the compiler`);
    assert.doesNotMatch(path, /(^|\/)node_modules\//, `${path} is a dependency, not a source`);
    assert.doesNotMatch(path, /(^|\/)\.blaze\//, `${path} is a build's output, not a source`);
  }
});

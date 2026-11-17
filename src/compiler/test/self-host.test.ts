/**
 * The compiler's own sources, measured against the TypeScript subset.
 *
 * A compiler that compiles itself starts with its own tree: every source that
 * makes the binary has to be a source the frontend reads. This test reads them
 * as the module graph a build reads — every file linked with the types, values
 * and signatures its imports bind — and reports what is still outside the
 * subset, so a slice that teaches the frontend one more construct shows up as a
 * lower number rather than as a feeling that progress was made. The report is
 * a diagnostic for the self-build test, not a budget or a target.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { selfHostGap } from "./self-host-gap.ts";

/**
 * The gap report is a diagnostic, not a budget.
 *
 * Progress is measured by a native compiler compiling this tree, as described
 * in `docs/specs/self-building.md`. This report says which sources and
 * constructs are still outside the subset when that build fails, so the queue
 * is visible without treating a historical count as an acceptance criterion.
 */

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
    report.total === 0,
    `${report.total} refusals: the frontend does not read a construct the compiler writes; see the diagnostic above`,
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
  // The Node host's model transport names the AI SDK. A native project maps the
  // same boundary to `ai/review-native.ts`, so the Node files are not sources a
  // compiler binary carries.
  for (const host of ["ai/review-node.ts", "ai/commandcode.ts"]) {
    assert.ok(!report.files.includes(host), `${host} is the Node host's, not the compiler's`);
  }
  assert.ok(report.files.includes("ai/review-native.ts"), "the adapter a native build links is a source of the compiler");
});

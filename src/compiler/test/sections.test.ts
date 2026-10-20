/**
 * Unit tests for the suite's section planner.
 *
 * The planner reads each test file's source with the TypeScript compiler API
 * and returns one whole-file section per file, without running any test body.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverSections } from "./sections.ts";

test("discoverSections plans one whole-file section per test file", async () => {
  const { sections, totalTests } = await discoverSections([
    "test/format-number.test.ts",
    "test/terminal-title.test.ts",
  ]);

  assert.equal(sections.length, 2);

  for (const section of sections) {
    // Whole-file sections are not name-sharded.
    assert.equal(section.pattern, null);
    assert.equal(section.name, section.file);
    assert.ok(section.testCount > 0, `${section.file} has tests`);
  }

  // The plan total is the sum of the section counts.
  const counted = sections.reduce((sum, section) => sum + section.testCount, 0);
  assert.equal(totalTests, counted);
});

test("discoverSections counts every test declaration of a file", async () => {
  const { sections } = await discoverSections(["test/format-number.test.ts"]);
  assert.equal(sections[0].testCount, 1);
});

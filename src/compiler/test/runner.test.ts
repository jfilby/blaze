/**
 * Unit tests for the sectioned test runner's logic.
 *
 * These avoid spawning `node:test`'s `run()` from within a test that is itself
 * being run by `run()`, which node:test refuses (a recursive run). Instead they
 * exercise `mergeSections`, `isSectionSummary`, `parseArgs` and
 * `discoverSections` directly. The end-to-end runner output contract is
 * verified by the full suite run.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { TestEvent } from "node:test/reporters";
import {
  mergeSections,
  isSectionSummary,
  parseArgs,
} from "./run.ts";
import { discoverSections, type Section } from "./sections.ts";

async function* eventsOf(events: TestEvent[]): AsyncGenerator<TestEvent> {
  for (const event of events) yield event;
}

function passEvent(name: string, number: number): TestEvent {
  return {
    type: "test:pass",
    nesting: 1,
    data: { name, testNumber: number, details: { duration_ms: 1 } },
  } as unknown as TestEvent;
}

function failEvent(name: string, number: number): TestEvent {
  return {
    type: "test:fail",
    nesting: 1,
    data: { name, testNumber: number, details: { duration_ms: 1 }, error: { message: "nope" } },
  } as unknown as TestEvent;
}

function summaryDiagnostic(message: string): TestEvent {
  return { type: "test:diagnostic", nesting: 0, data: { message } } as unknown as TestEvent;
}

test("isSectionSummary spots per-section summaries and ignores real tests", () => {
  assert.equal(isSectionSummary({ type: "test:plan", nesting: 0, data: {} } as unknown as TestEvent), true);
  assert.equal(isSectionSummary({ type: "test:summary", nesting: 0, data: {} } as unknown as TestEvent), true);
  assert.equal(isSectionSummary(summaryDiagnostic("pass 3")), true);
  assert.equal(isSectionSummary(summaryDiagnostic("fail 1")), true);
  assert.equal(isSectionSummary(summaryDiagnostic("tests 5")), true);
  assert.equal(isSectionSummary(summaryDiagnostic("duration_ms 10")), true);
  assert.equal(isSectionSummary(passEvent("a test", 1)), false);
  assert.equal(isSectionSummary(failEvent("a test", 2)), false);
  assert.equal(
    isSectionSummary({ type: "test:diagnostic", nesting: 0, data: { message: "hello world" } } as unknown as TestEvent),
    false
  );
});

test("parseArgs reads the reporter, concurrency and files", () => {
  const args = parseArgs([
    "--test-reporter=./test/reporter.ts",
    "--concurrency=3",
    "test/a.test.ts",
    "--concurrency",
    "7",
    "test/b.test.ts",
    "--some-other-flag",
  ]);

  assert.equal(args.reporter, "./test/reporter.ts");
  assert.equal(args.concurrency, 7);
  assert.deepEqual(args.files, ["test/a.test.ts", "test/b.test.ts"]);
});

test("parseArgs uses sensible defaults", () => {
  const args = parseArgs(["test/a.test.ts"]);
  assert.equal(args.reporter, "./test/reporter.ts");
  assert.equal(args.concurrency, 8);
  assert.deepEqual(args.files, ["test/a.test.ts"]);
});

test("mergeSections yields one plan and one aggregate summary", async () => {
  const section: Section = {
    file: "a.test.ts",
    pattern: null,
    testCount: 2,
    name: "a.test.ts",
  };
  const counts = { pass: 0, fail: 0, skip: 0, todo: 0, cancelled: 0 };
  const output: TestEvent[] = [];

  for await (const event of mergeSections(
    [section],
    1,
    2,
    counts,
    () =>
      eventsOf([
        { type: "test:plan", nesting: 0, data: { count: 1 } } as unknown as TestEvent,
        passEvent("a passing test", 1),
        summaryDiagnostic("pass 99"), // per-section summary: must be suppressed
        failEvent("a failing test", 2),
      ])
  )) {
    output.push(event);
  }

  // One plan for the whole suite.
  assert.equal(output[0].type, "test:plan");
  assert.equal(output[0].data.count, 2);
  // Real test results flow through.
  assert.equal(output[1].type, "test:pass");
  assert.equal(output[2].type, "test:fail");
  // Per-section summary diagnostics are suppressed...
  assert.ok(
    !output.some((e) => e.type === "test:diagnostic" && e.data.message === "pass 99")
  );
  // ...and replaced with one aggregate summary.
  const failDiagnostic = output.find(
    (e) => e.type === "test:diagnostic" && e.data.message === `fail ${counts.fail}`
  );
  assert.ok(failDiagnostic, "expected an aggregate fail diagnostic");
  assert.equal(counts.pass, 1);
  assert.equal(counts.fail, 1);
});

test("discoverSections plans one whole-file section per test file", async () => {
  const { sections, totalTests } = await discoverSections(["test/format-number.test.ts"]);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].pattern, null);
  assert.equal(sections[0].testCount, 1);
  assert.equal(totalTests, 1);
});

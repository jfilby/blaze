/**
 * What the records add up to, and what of it reads.
 *
 * The numbers a report is made of are computed over whole records, so they
 * can be checked against hand-written records: a set of runs with known
 * outcomes, known refusals and known measurements, whose totals are arrived
 * at here rather than trusted. The two that matter most are the rate a
 * method earns a commit at, and the count of kept changes that measured
 * slower — a number that is not zero is a record of the gate disagreeing
 * with itself.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { render, summarize } from "../summary.ts";
import type { RunRecord, SessionRecord } from "../runs.ts";
import type { Method } from "../ai.ts";
import type { RunOutcome } from "../runs.ts";

const AT = "2026-10-10T09:00:00.000Z";

/** A run whose fields are the ones a test cares about. */
function run(
  over: Partial<RunRecord> & { method: Method; outcome: RunOutcome },
): RunRecord {
  return {
    version: 1,
    id: `run-${Math.random().toString(36).slice(2, 8)}`,
    session: {
      id: "session",
      startedAt: AT,
      model: "anthropic/claude-sonnet-4-5",
      project: null,
      methods: [over.method],
      maxIterations: 1,
      benchmarkRuns: 2,
      baseCommit: "abc1234",
    },
    iteration: 1,
    summary: null,
    applied: [],
    refused: [],
    benchmark: null,
    commit: null,
    error: null,
    papers: [],
    startedAt: AT,
    finishedAt: AT,
    durationMs: 1000,
    ...over,
  };
}

function session(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    version: 1,
    id: "session",
    context: run({ method: "code-review", outcome: "committed" }).session,
    runs: [],
    committed: 0,
    outcome: "no-commits",
    error: null,
    finishedAt: AT,
    durationMs: 1000,
    ...over,
  };
}

function measured(percent: number, over: Partial<RunRecord> = {}): RunRecord {
  const before = 100;
  const after = before * (1 + percent / 100);
  return run({
    method: "code-review",
    outcome: "committed",
    benchmark: {
      before: { mean: before, stddev: 1, runs: 3, unit: "s" },
      after: { mean: after, stddev: 1, runs: 3, unit: "s" },
      delta: after - before,
      percent,
      withinNoise: Math.abs(percent) < 1,
    },
    ...over,
  });
}

test("a set of runs and sessions is counted", () => {
  const runs = [
    run({ method: "research", outcome: "committed", commit: "aaa" }),
    run({ method: "research", outcome: "no-proposals" }),
    run({ method: "code-review", outcome: "committed" }),
    run({ method: "code-review", outcome: "tests-failed", error: "the suite rejected it" }),
  ];

  const summary = summarize(runs, [session({ outcome: "committed", committed: 2 })]);

  assert.equal(summary.runs, 4);
  assert.equal(summary.sessions, 1);
  assert.equal(summary.committed, 2);
  assert.equal(summary.firstAt, AT);
  assert.equal(summary.lastAt, AT);
});

test("each method is counted on its own, with its own rate", () => {
  const runs = [
    run({ method: "research", outcome: "committed" }),
    run({ method: "research", outcome: "no-proposals" }),
    run({ method: "research", outcome: "no-proposals" }),
    run({ method: "build-feedback", outcome: "failed", error: "no key" }),
    run({ method: "build-feedback", outcome: "committed" }),
    run({ method: "code-review", outcome: "committed" }),
  ];

  const byMethod = summarize(runs, []).byMethod;

  assert.deepEqual(
    byMethod.map((m) => [m.method, m.runs, m.committed, m.rate]),
    [
      ["research", 3, 1, (1 / 3) * 100],
      ["build-feedback", 2, 1, 50],
      ["code-review", 1, 1, 100],
    ],
  );
});

test("outcomes are counted in the order they are read in", () => {
  const runs = [
    run({ method: "code-review", outcome: "committed" }),
    run({ method: "code-review", outcome: "committed" }),
    run({ method: "code-review", outcome: "tests-failed" }),
    run({ method: "code-review", outcome: "no-proposals" }),
  ];

  assert.deepEqual(
    summarize(runs, []).outcomes,
    [
      { outcome: "committed", count: 2 },
      { outcome: "no-proposals", count: 1 },
      { outcome: "tests-failed", count: 1 },
    ],
  );
});

test("a refusal is counted by what it was, not by which file it was about", () => {
  const runs = [
    run({
      method: "code-review",
      outcome: "nothing-applied",
      refused: [{ file: "a.ts", reason: "the original text appears more than once" }],
    }),
    run({
      method: "code-review",
      outcome: "nothing-applied",
      refused: [{ file: "b.ts", reason: "the original text appears more than once" }],
    }),
    run({
      method: "code-review",
      outcome: "nothing-applied",
      refused: [{ file: "c.ts", reason: "the file is not inside the compiler" }],
    }),
  ];

  assert.deepEqual(summarize(runs, []).refusals, [
    { reason: "the original text appears more than once", file: "a.ts", count: 2 },
    { reason: "the file is not inside the compiler", file: "c.ts", count: 1 },
  ]);
});

test("a measurement is counted, and a kept slower change is the gate's word against itself", () => {
  const runs = [
    // Faster beyond its own spread, and kept: not slower however far out.
    measured(-4),
    // Inside the noise, and kept.
    measured(0.5),
    // Slower beyond the noise, and reverted.
    measured(2, { outcome: "slower", commit: null }),
    measured(9, { outcome: "slower", commit: null }),
  ];

  const m = summarize(runs, []).measurements;

  assert.equal(m.measured, 4);
  assert.equal(m.faster, 1);
  assert.equal(m.slower, 3);
  assert.equal(m.measured - m.faster - m.slower, 0);
  // mean of (-4, 0.5, 2, 9) is 1.875; median is 1.25.
  assert.equal(m.meanPercent, 1.875);
  assert.equal(m.medianPercent, 1.25);
  // Everything that measured slower beyond the noise was reverted, so the
  // number of kept ones there is zero: the gate held.
  assert.equal(m.committedSlower, 0);
});

test("a kept change that measured slower beyond the noise is counted", () => {
  // What the gate saying so is worth: a run that kept a change it measured
  // as slower is a record of the two halves disagreeing, and it is counted.
  const m = summarize([measured(2)], []).measurements;

  assert.equal(m.committedSlower, 1);
});

test("no measurements is said as none, not as a number", () => {
  const m = summarize([run({ method: "code-review", outcome: "no-proposals" })], []).measurements;

  assert.equal(m.measured, 0);
  assert.equal(m.meanPercent, null);
  assert.equal(m.medianPercent, null);
  assert.deepEqual(m.recent, []);
});

test("the files the kept changes were written in are counted, most changed first", () => {
  const runs = [
    run({ method: "code-review", outcome: "committed", applied: [{ file: "codegen.ts", description: "a" }] }),
    run({ method: "code-review", outcome: "committed", applied: [{ file: "codegen.ts", description: "b" }] }),
    run({ method: "code-review", outcome: "committed", applied: [{ file: "semantics/repair.ts", description: "c" }] }),
    // A change that was not kept is not a file a report counts.
    run({ method: "code-review", outcome: "tests-failed", applied: [{ file: "never.ts", description: "d" }] }),
  ];

  assert.deepEqual(summarize(runs, []).files, [
    { file: "codegen.ts", changes: 2 },
    { file: "semantics/repair.ts", changes: 1 },
  ]);
});

test("the runs that kept nothing are listed newest first, with what refusals said", () => {
  const runs = [
    run({ method: "code-review", outcome: "committed" }),
    run({ method: "research", outcome: "nothing-applied", refused: [{ file: "a.ts", reason: "not there" }] }),
    run({ method: "code-review", outcome: "slower", error: "measured 2s slower" }),
  ];

  const failures = summarize(runs, []).failures;

  assert.deepEqual(
    failures.map((f) => [f.method, f.outcome]),
    [
      ["code-review", "slower"],
      ["research", "nothing-applied"],
    ],
  );
  assert.equal(failures[1]?.refused[0]?.reason, "not there");
});

test("a session that never ran is a result the runs alone do not show", () => {
  const summary = summarize([], [
    session({ outcome: "refused", error: "the working tree is not clean" }),
    session({ outcome: "committed", committed: 1 }),
  ]);

  assert.deepEqual(summary.sessionOutcomes, [
    { outcome: "committed", count: 1 },
    { outcome: "refused", count: 1 },
  ]);
  assert.equal(summary.runs, 0);
});

test("a summary with nothing in it is a summary of nothing", () => {
  const summary = summarize([], []);

  assert.equal(summary.runs, 0);
  assert.equal(summary.committed, 0);
  assert.equal(summary.firstAt, null);
  assert.deepEqual(summary.byMethod, []);
  assert.deepEqual(summary.outcomes, []);
  assert.deepEqual(summary.failures, []);
});

test("the report reads as a report", () => {
  const runs = [
    measured(-2, { method: "research", commit: "abc1234" }),
    run({
      method: "code-review",
      outcome: "nothing-applied",
      refused: [{ file: "a.ts", reason: "the original text appears more than once" }],
    }),
  ];

  const text = render(summarize(runs, [session({ outcome: "no-commits" })]));

  assert.match(text, /2 runs, 1 committed, from 1 session/);
  assert.match(text, /A run commits 50% of the time/);
  assert.match(text, /research +1 runs +1 committed +100%/);
  assert.match(text, /mean -2\.00%, median -2\.00%/);
  assert.match(text, /1 × the original text appears more than once/);
  assert.match(text, /no-commits 1/);
  // The reading says which way round a negative number is.
  assert.match(text, /a negative number is a compiler that got faster/);
});

test("a research paper that led to a commit is of use", () => {
  const paper = { title: "Loop Vectorization", url: "https://example.com/loop" };
  const runs = [
    run({ method: "research", outcome: "committed", papers: [paper] }),
    run({ method: "research", outcome: "no-proposals", papers: [paper] }),
  ];

  const research = summarize(runs, []).research;

  assert.equal(research.length, 1);
  assert.equal(research[0]?.title, "Loop Vectorization");
  assert.equal(research[0]?.runs, 2);
  assert.equal(research[0]?.committed, 1);
  assert.equal(research[0]?.useful, true);
});

test("a research paper that only led to failed runs is not of use", () => {
  const paper = { title: "Dead End", url: "https://example.com/dead" };
  const runs = [
    run({ method: "research", outcome: "tests-failed", papers: [paper] }),
    run({ method: "research", outcome: "slower", papers: [paper] }),
  ];

  const research = summarize(runs, []).research;

  assert.equal(research.length, 1);
  assert.equal(research[0]?.useful, false);
  assert.equal(research[0]?.committed, 0);
});

test("research papers are listed useful first, then by how many runs read them", () => {
  const useful = { title: "Useful", url: "https://example.com/useful" };
  const notUseful = { title: "Not Useful", url: "https://example.com/not" };
  const runs = [
    run({ method: "research", outcome: "tests-failed", papers: [notUseful] }),
    run({ method: "research", outcome: "committed", papers: [useful] }),
  ];

  const research = summarize(runs, []).research;

  assert.equal(research.length, 2);
  assert.equal(research[0]?.title, "Useful");
  assert.equal(research[0]?.useful, true);
  assert.equal(research[1]?.title, "Not Useful");
  assert.equal(research[1]?.useful, false);
});

test("the report shows which research papers were of use", () => {
  const useful = { title: "Loop Vectorization", url: "https://example.com/loop" };
  const notUseful = { title: "Dead End", url: "https://example.com/dead" };
  const runs = [
    run({ method: "research", outcome: "committed", papers: [useful] }),
    run({ method: "research", outcome: "tests-failed", papers: [notUseful] }),
  ];

  const text = render(summarize(runs, []));

  assert.match(text, /Research papers the runs read/);
  assert.match(text, /Of use \(1\):/);
  assert.match(text, /Loop Vectorization \(1 committed\)/);
  assert.match(text, /Not of use \(1\):/);
  assert.match(text, /Dead End/);
});

test("runs without papers are not counted as research", () => {
  const runs = [
    run({ method: "code-review", outcome: "committed" }),
    run({ method: "build-feedback", outcome: "no-proposals" }),
  ];

  const research = summarize(runs, []).research;

  assert.equal(research.length, 0);
});

/**
 * What a measurement says, and when it says a change is slower.
 *
 * The benchmark is the gate a pass is kept or thrown away by, so what it
 * reads has to be what hyperfine wrote: a top level object with a results
 * array, whose first entry carries the mean, the spread over its own runs,
 * and the runs themselves. Reading anything else out of it — a bracket
 * somewhere earlier in the output, a mean of zero — is a benchmark of
 * nothing that then decides the pass.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readHyperfineResult, type HyperfineExport } from "../benchmark.ts";
import { isSlower } from "../cli.ts";

/** An export as hyperfine writes it for one measurement of five runs. */
const exportOf = (over: Partial<{ mean: number; stddev: number | null; times: number[] }>): HyperfineExport => {
  const mean = over.mean ?? 100;
  const stddev = over.stddev === undefined ? 2 : over.stddev;
  return {
    results: [
      {
        mean,
        stddev: stddev as number,
        times: over.times ?? Array.from({ length: 5 }, () => mean),
      },
    ],
  };
};

test("hyperfine's own JSON shape is read", () => {
  const result = readHyperfineResult(exportOf({ mean: 212.909, stddev: 0.4 }));

  assert.equal(result.mean, 212.909);
  assert.equal(result.stddev, 0.4);
  assert.equal(result.runs, 5);
  assert.equal(result.unit, "s");
});

test("one run has no spread, and hyperfine says so with a null", () => {
  const result = readHyperfineResult(exportOf({ stddev: null, times: [213.5] }));

  assert.equal(result.runs, 1);
  assert.equal(result.stddev, 0);
  assert.ok(result.mean > 0);
});

test("a measurement of nothing is refused: it would read as an unlimited speedup", () => {
  assert.throws(() => readHyperfineResult(exportOf({ mean: 0, times: [0, 0] })), /no time/);
  assert.throws(() => readHyperfineResult({ results: [] }), /no usable result/);
  assert.throws(() => readHyperfineResult({}), /no usable result/);
  // A mean hyperfine could not compute is the same ignorance.
  assert.throws(
    () => readHyperfineResult({ results: [{ mean: Number.NaN, stddev: 0, times: [1] }] }),
    /no usable result/,
  );
});

const measured = (mean: number, runs: number): { mean: number; stddev: number; runs: number; unit: string } => ({
  mean,
  stddev: 2,
  runs,
  unit: "s",
});

test("a faster change is not slower", () => {
  assert.equal(isSlower(measured(200, 5), measured(190, 5)), false);
});

test("a slower change beyond the noise is slower", () => {
  // Ten seconds over a two second spread is not noise.
  assert.equal(isSlower(measured(200, 5), measured(210, 5)), true);
});

test("a difference smaller than the two benchmarks' spread is noise, not slower", () => {
  // The mean's own uncertainty is stddev over the root of how many runs it
  // took: 2/sqrt(5) is about 0.9s for either side, so half a second either
  // way is what noise alone would produce.
  assert.equal(isSlower(measured(200, 5), measured(200.5, 5)), false);
});

test("the smaller of the two thresholds still counts", () => {
  // A tight measurement and a long one: a percent of the whole is the
  // floor, and one second of a hundred is not a change.
  assert.equal(isSlower(measured(100, 40), measured(101, 40)), false);
  // ...but it is a change of a measurement that short.
  assert.equal(isSlower(measured(100, 40), measured(102, 40)), true);
});

test("one run measured no spread, and a percent of the measurement still counts", () => {
  assert.equal(isSlower(measured(213, 1), measured(213.5, 1)), false);
  assert.equal(isSlower(measured(213, 1), measured(216, 1)), true);
});

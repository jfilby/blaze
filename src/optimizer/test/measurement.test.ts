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
import { join } from "node:path";
import { test } from "node:test";
import { benchmarkProject, readHyperfineResult, type HyperfineExport } from "../benchmark.ts";
import { benchmarkProblem, isSlower } from "../cli.ts";
import type { ProjectInfo } from "../project.ts";
import { scratch } from "./scratch.ts";

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

/**
 * A project a run may be aimed at, with whatever benchmark entry it names.
 *
 * The shape is `ProjectInfo`'s and the paths are scratch ones, which is what
 * lets a test ask what a project's own benchmark is read as without running
 * anything.
 */
function projectAt(directory: string, benchmark: ProjectInfo["benchmark"]): ProjectInfo {
  return {
    tomlPath: join(directory, "blaze.toml"),
    directory,
    sourcePath: join(directory, "main.ts"),
    source: "function main(): void { console.log('hi'); }\n",
    context: "a tree walk",
    model: null,
    benchmark,
  };
}

test("a project that names no benchmark has nothing to be timed", async () => {
  const dir = join(await scratch("blazeup-project-"), "binarytrees");

  // Nothing here builds a program: a project that names no command has no
  // measurement, and saying so is the whole answer.
  await assert.rejects(() => benchmarkProject(projectAt(dir, null)), /names no \[benchmark\] entry/);
});

test("a project with no benchmark entry is refused, and handed the entry to write", async () => {
  const dir = join(await scratch("blazeup-project-"), "binarytrees");

  const problem = benchmarkProblem(projectAt(dir, null));

  assert.match(problem ?? "", /names no \[benchmark\] entry, so a run aimed at it has nothing to measure it by/);
  // The refusal is the entry to write, in the words the file takes, with the
  // program the project's own build delivers already in it.
  assert.match(problem ?? "", /command = "\.\/binarytrees 16"/);
  assert.match(problem ?? "", /working_dir = "\."/);
});

test("a project that names an entry is measured on the program it builds", async () => {
  const dir = join(await scratch("blazeup-project-"), "binarytrees");

  assert.equal(benchmarkProblem(projectAt(dir, { command: "./binarytrees 16", directory: dir, program: "binarytrees" })), null);
});

test("a project file that is not its directory's own is refused, because the rebuild reads that one", async () => {
  const dir = await scratch("blazeup-project-");
  const named = { ...projectAt(dir, { command: "./run 16", directory: dir, program: "run" }), tomlPath: join(dir, "app.toml") };

  assert.match(benchmarkProblem(named) ?? "", /is not the blaze\.toml of its directory/);
});

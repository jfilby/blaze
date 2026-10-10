/**
 * What each run leaves behind, and what can still be read of it.
 *
 * A run's record is the only thing that says afterwards what a run did, so
 * the writing and the reading are checked together: every record written
 * comes back with the fields it was written with, an interrupted run's
 * half-written file is left out rather than taking the report down, and the
 * two directories are the two kinds of record and not one.
 */

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  readRun,
  readRuns,
  readSession,
  readSessions,
  recordsDirectory,
  runsDirectory,
  sessionsDirectory,
  writeRun,
  writeSession,
  type RunRecord,
  type SessionContext,
  type SessionRecord,
} from "../runs.ts";
import { scratch } from "./scratch.ts";

const CONTEXT: SessionContext = {
  id: "2026-10-10_09-00-00_aaaaaa",
  startedAt: "2026-10-10T09:00:00.000Z",
  model: "anthropic/claude-sonnet-4-5",
  project: null,
  methods: ["research", "build-feedback", "code-review"],
  maxIterations: 3,
  benchmarkRuns: 2,
  baseCommit: "abc1234",
};

function run(over: Partial<RunRecord> = {}): RunRecord {
  return {
    version: 1,
    id: "2026-10-10_09-01-00_bbbbbb",
    session: CONTEXT,
    iteration: 1,
    method: "code-review",
    outcome: "committed",
    summary: "hoist the invariant",
    applied: [{ file: "codegen.ts", description: "hoisted" }],
    refused: [],
    benchmark: null,
    commit: "def5678",
    error: null,
    startedAt: "2026-10-10T09:01:00.000Z",
    finishedAt: "2026-10-10T09:02:00.000Z",
    durationMs: 60000,
    ...over,
  };
}

function session(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    version: 1,
    id: "2026-10-10_09-00-00_aaaaaa",
    context: CONTEXT,
    runs: ["2026-10-10_09-01-00_bbbbbb"],
    committed: 1,
    outcome: "committed",
    error: null,
    finishedAt: "2026-10-10T09:05:00.000Z",
    durationMs: 300000,
    ...over,
  };
}

test("a run written is a run that can be read back", async () => {
  const repo = await scratch("blazeopt-runs-");

  const path = writeRun(run(), repo);

  assert.equal(path, join(runsDirectory(repo), "2026-10-10_09-01-00_bbbbbb.json"));
  const read = readRun("2026-10-10_09-01-00_bbbbbb", repo);
  assert.deepEqual(read, run());
});

test("a session written is a session that can be read back", async () => {
  const repo = await scratch("blazeopt-runs-");

  writeSession(session(), repo);

  assert.deepEqual(readSession("2026-10-10_09-00-00_aaaaaa", repo), session());
  assert.deepEqual(readSessions(repo).map((s) => s.id), ["2026-10-10_09-00-00_aaaaaa"]);
});

test("the two kinds of record are in two directories, under one", async () => {
  const repo = await scratch("blazeopt-runs-");
  writeRun(run(), repo);
  writeSession(session(), repo);

  assert.equal(recordsDirectory(repo), join(repo, ".blazeopt"));
  assert.equal(runsDirectory(repo), join(repo, ".blazeopt", "runs"));
  assert.equal(sessionsDirectory(repo), join(repo, ".blazeopt", "sessions"));
  // A run is not a session, and neither is read for the other.
  assert.deepEqual(readRuns(repo).map((r) => r.id), [run().id]);
});

test("a repository that has never run holds no records", async () => {
  const repo = await scratch("blazeopt-runs-");

  assert.deepEqual(readRuns(repo), []);
  assert.deepEqual(readSessions(repo), []);
  assert.equal(readRun("nothing", repo), null);
});

test("records come back in the order they happened, not the order of their names", async () => {
  const repo = await scratch("blazeopt-runs-");
  // The third was written first, and its name sorts before the others.
  writeRun(run({ id: "2026-10-10_09-03-00_c", iteration: 3 }), repo);
  writeRun(run({ id: "2026-10-10_09-01-00_a", iteration: 1 }), repo);
  writeRun(run({ id: "2026-10-10_09-02-00_b", iteration: 2 }), repo);

  assert.deepEqual(
    readRuns(repo).map((r) => r.iteration),
    [1, 2, 3],
  );
});

test("two runs of the same second are read in the order their names break the tie", async () => {
  const repo = await scratch("blazeopt-runs-");
  const both = "2026-10-10T09:00:00.000Z";
  // Two runs of one session share a second: the name decides which is first.
  writeRun(run({ id: "2026-10-10_09-00-00_b", iteration: 2, startedAt: both }), repo);
  writeRun(run({ id: "2026-10-10_09-00-00_a", iteration: 1, startedAt: both }), repo);

  assert.deepEqual(
    readRuns(repo).map((r) => r.iteration),
    [1, 2],
  );
});

test("a record that is not one is left out rather than failing the report", async () => {
  const repo = await scratch("blazeopt-runs-");
  writeRun(run(), repo);
  // What an interrupted run leaves behind: a file that is not a record.
  await writeFile(join(runsDirectory(repo), "interrupted.json"), "{ \"version\": 1,");
  await writeFile(join(runsDirectory(repo), "not-json.json"), "not json at all");
  // And a file that is JSON but is not this version's shape.
  await writeFile(join(runsDirectory(repo), "other-version.json"), JSON.stringify({ id: "x" }));

  assert.deepEqual(
    readRuns(repo).map((r) => r.id),
    [run().id],
  );
});

test("a run keeps the context of the session it belonged to", async () => {
  const repo = await scratch("blazeopt-runs-");

  writeRun(run(), repo);

  const read = readRuns(repo)[0];
  assert.equal(read?.session.model, "anthropic/claude-sonnet-4-5");
  assert.equal(read?.session.benchmarkRuns, 2);
  assert.equal(read?.session.baseCommit, "abc1234");
});

test("a repository that cannot be written is said rather than swallowing the run", async () => {
  // A path that cannot be created as a directory: the write fails, the run
  // reports it, and the run is not a failure of the record.
  const repo = await scratch("blazeopt-runs-");
  writeFileSync(join(repo, ".blazeopt"), "not a directory\n");

  const path = writeRun(run(), repo);

  assert.equal(path, null);
});

/**
 * What it takes to continue a session that died, and what a continuation does
 * with where it stopped.
 *
 * A fatal error mid-loop — a rate-limited model, a missing key, a crash —
 * kills the invocation, and without a record of where it stopped the session
 * is gone: the runs it got through, the settings it ran under, the project it
 * was aimed at. The record is what `--resume` rebuilds the session from, and
 * what is checked here is that the record is one that can be continued, and
 * that the continuation runs the runs the dead session had left.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { continuationStart, iterationRange, resumePlan, shouldWriteRefusedSession, type Asked } from "../cli.ts";
import { readSession, writeSession, type SessionContext, type SessionRecord } from "../runs.ts";
import { scratch } from "./scratch.ts";

const CONTEXT: SessionContext = {
  id: "2026-10-10_09-00-00_aaaaaa",
  // A session record is refused when it is old enough that the tree it names
  // may have been rewritten, so the default context is one that started now.
  startedAt: new Date().toISOString(),
  model: "anthropic/claude-sonnet-4-5",
  project: null,
  methods: ["research", "build-feedback", "code-review"],
  maxIterations: 3,
  benchmarkRuns: 5,
  baseCommit: "abc1234",
};

function session(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    version: 1,
    id: CONTEXT.id,
    context: CONTEXT,
    runs: ["2026-10-10_09-01-00_bbbbbb"],
    committed: 0,
    outcome: "failed",
    error: "the model rate-limited the run",
    finishedAt: "2026-10-10T09:05:00.000Z",
    durationMs: 300000,
    ...over,
  };
}

function asked(over: Partial<Asked> = {}): Asked {
  return {
    resume: CONTEXT.id,
    positionals: [],
    requested: { maxIterations: undefined, benchmarkRuns: undefined, methods: undefined },
    given: { maxIterations: false, benchmarkRuns: false, methods: false },
    ...over,
  };
}

function git(dir: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
}

/** The short sha the repository is on, which a session record names as its base. */
function head(dir: string): string {
  const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: dir, encoding: "utf8" });
  if (result.status !== 0) throw new Error("the repository has no head");
  return result.stdout.trim();
}

/** A scratch git repository with one commit, the tree a session record names. */
async function repository(): Promise<string> {
  const dir = await scratch("blazeup-resume-");
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "compiler.ts"), "// the compiler\n");
  git(dir, "init", "--quiet");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "test");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "baseline");
  return dir;
}

test("a session that can be continued gives back its settings and where it stopped", async () => {
  const dir = await repository();
  writeSession(session({ context: { ...CONTEXT, baseCommit: head(dir) } }), dir);

  const plan = resumePlan(asked(), dir);

  assert.notEqual(typeof plan, "string");
  if (typeof plan === "string") return;
  assert.equal(plan.done, 1);
  assert.deepEqual(plan.methods, CONTEXT.methods);
  assert.equal(plan.maxIterations, 3);
  assert.equal(plan.benchmarkRuns, 5);
  assert.equal(plan.record.id, CONTEXT.id);
});

test("a session record that is not there is refused by name", async () => {
  const dir = await repository();

  const plan = resumePlan(asked({ resume: "2020-01-01_00-00-00_zzzzzz" }), dir);

  assert.match(plan as string, /no session record named 2020-01-01_00-00-00_zzzzzz/);
});

test("a session that ran to end has nothing to continue", async () => {
  const dir = await repository();
  writeSession(session({ outcome: "committed", context: { ...CONTEXT, baseCommit: head(dir) } }), dir);

  const plan = resumePlan(asked(), dir);

  assert.match(plan as string, /nothing to continue/);
});

test("a session that used all its runs has none left", async () => {
  const dir = await repository();
  writeSession(
    session({
      runs: ["a", "b", "c"],
      context: { ...CONTEXT, baseCommit: head(dir) },
    }),
    dir,
  );

  const plan = resumePlan(asked(), dir);

  assert.match(plan as string, /no runs left/);
});

test("a session aimed at one project is not continued with another", async () => {
  const dir = await repository();
  writeSession(
    session({ context: { ...CONTEXT, baseCommit: head(dir), project: "/repo/proj/blaze.toml" } }),
    dir,
  );

  const plan = resumePlan(asked({ positionals: ["/other/proj/blaze.toml"] }), dir);

  assert.match(plan as string, /it was aimed at \/repo\/proj\/blaze\.toml/);
});

test("a flag that shrinks a resumed session is refused", async () => {
  const dir = await repository();
  writeSession(session({ context: { ...CONTEXT, baseCommit: head(dir) } }), dir);

  const plan = resumePlan(
    asked({
      given: { maxIterations: true, benchmarkRuns: false, methods: false },
      requested: { maxIterations: 1, benchmarkRuns: undefined, methods: undefined },
    }),
    dir,
  );

  assert.match(plan as string, /it was given --max-iterations 3, not 1/);
});

test("a session a day old is refused as an expired proof of the tree", async () => {
  const dir = await repository();
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  writeSession(session({ context: { ...CONTEXT, baseCommit: head(dir), startedAt: old } }), dir);

  const plan = resumePlan(asked(), dir);

  assert.match(plan as string, /tree proof expired/);
});

test("a dirty tree is refused", async () => {
  const dir = await repository();
  writeSession(session({ context: { ...CONTEXT, baseCommit: head(dir) } }), dir);
  await writeFile(join(dir, "src", "compiler.ts"), "// someone's work\n");

  const plan = resumePlan(asked(), dir);

  assert.match(plan as string, /the working tree is not clean/);
});

test("a repository that moved is refused", async () => {
  const dir = await repository();
  writeSession(session({ context: { ...CONTEXT, baseCommit: head(dir) } }), dir);
  await writeFile(join(dir, "src", "compiler.ts"), "// more work\n");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "moved");

  const plan = resumePlan(asked(), dir);

  assert.match(plan as string, /the repository is on \w+, not the \w+ it started from/);
});

test("the continuation loop skips the runs a session already did", () => {
  assert.deepEqual(iterationRange(0, 3), [0, 1, 2]);
  assert.deepEqual(iterationRange(1, 3), [1, 2]);
  assert.deepEqual(iterationRange(3, 3), []);
});

test("a continuation starts with the dead session's runs and commits", async () => {
  const dir = await repository();
  writeSession(session({ runs: ["a", "b"], committed: 1, context: { ...CONTEXT, baseCommit: head(dir) } }), dir);

  const plan = resumePlan(asked(), dir);
  assert.notEqual(typeof plan, "string");
  if (typeof plan === "string") return;

  const start = continuationStart(plan);
  assert.deepEqual(start.runIds, ["a", "b"]);
  assert.equal(start.committed, 1);
});

test("a fresh session starts with no runs and no commits", () => {
  const start = continuationStart(undefined);
  assert.deepEqual(start.runIds, []);
  assert.equal(start.committed, 0);
});

test("a refused fresh session is written, a refused continuation is not", async () => {
  // A fresh refusal is the only record of an invocation that never started, so
  // it is kept. A refused continuation reuses the dead session's id, so
  // writing one would overwrite the failed record it was meant to continue —
  // and a second `--resume` would find nothing to continue (it refused to
  // start).
  assert.equal(shouldWriteRefusedSession(undefined), true);

  const dir = await repository();
  writeSession(session({ context: { ...CONTEXT, baseCommit: head(dir) } }), dir);
  const plan = resumePlan(asked(), dir);
  assert.notEqual(typeof plan, "string");
  if (typeof plan === "string") return;
  assert.equal(shouldWriteRefusedSession(plan), false);
});

test("a refused continuation leaves the failed session resumable", async () => {
  const dir = await repository();
  const failed = session({ outcome: "failed", runs: ["2026-10-10_09-01-00_bbbbbb"], context: { ...CONTEXT, baseCommit: head(dir) } });
  writeSession(failed, dir);

  // What the fix does on a refused `--resume`: nothing is written, so the
  // failed record stays as it was.
  assert.deepEqual(readSession(CONTEXT.id, dir)?.outcome, "failed");

  // And what the old code did — overwrite with a refused record of the same
  // id — is what made the second `--resume` fail.
  writeSession({ ...failed, runs: [], committed: 0, outcome: "refused", error: "smoke test" }, dir);
  const plan = resumePlan(asked(), dir);
  assert.match(plan as string, /nothing to continue \(it refused to start\)/);
});

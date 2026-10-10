/**
 * What each run did, and which session it belonged to, written at the head
 * of the repository.
 *
 * A **run** is one turn of the optimization loop — one method, one answer,
 * one measurement, one commit or revert. A **session** is one invocation of
 * `blazeopt`, which is the runs it got through and the answer it was working
 * under. Both are recorded, whether they got anywhere or not: a run whose
 * tests failed, one whose proposals were all refused and a session that
 * refused to start on a dirty tree are three different facts, and none of
 * them is visible afterwards except from here.
 *
 * `blazeopt-report` reads what this module writes.
 *
 * The records live in `.blazeopt` at the head of the repository, one file
 * per run and one file per session rather than one appended log: a run that
 * is interrupted part way through would leave a half-written line in a log,
 * and a whole record in a directory is what a report can read.
 *
 * The directory is the repository's, so the repository ignores it — the way
 * it ignores the build state `.blaze` — because a directory an untracked
 * file makes dirty is a directory a tool that reads the tree cannot run in.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Method } from "./ai.ts";

/** The version of the record shapes, so a report can say what it cannot read. */
export const RECORD_VERSION = 1;

/** Where the records are: `.blazeopt` at the head of the repository. */
export function recordsDirectory(repoRoot = repositoryRoot()): string {
  return join(repoRoot, ".blazeopt");
}

/** Where the run records are. */
export function runsDirectory(repoRoot = repositoryRoot()): string {
  return join(recordsDirectory(repoRoot), "runs");
}

/** Where the session records are. */
export function sessionsDirectory(repoRoot = repositoryRoot()): string {
  return join(recordsDirectory(repoRoot), "sessions");
}

/**
 * The head of the repository the optimizer works on.
 *
 * The optimizer is a package inside it (`src/optimizer`), so the head is two
 * directories up — the same assumption the compiler directory rests on.
 */
function repositoryRoot(): string {
  return join(import.meta.dirname, "..", "..");
}

/** What became of one run. */
export type RunOutcome =
  /** The change was kept and committed. */
  | "committed"
  /** The model proposed nothing. */
  | "no-proposals"
  /** Every proposal was refused, or none of them could be applied. */
  | "nothing-applied"
  /** The change was applied and the compiler's suite rejected it. */
  | "tests-failed"
  /** The change was kept, measured slower than the noise, and reverted. */
  | "slower"
  /** The run had nothing to work from before it started. */
  | "skipped"
  /** The run threw. */
  | "failed";

/** A change a run applied. */
export interface AppliedChange {
  readonly file: string;
  readonly description: string;
}

/** A proposal a run refused, and why. */
export interface RefusedProposal {
  readonly file: string;
  readonly reason: string;
}

/** One measurement of the compiler. */
export interface Measurement {
  readonly mean: number;
  readonly stddev: number;
  readonly runs: number;
  /** What the numbers are in: hyperfine reports seconds. */
  readonly unit: string;
}

/** What the two measurements of a change said. */
export interface RunBenchmark {
  readonly before: Measurement;
  readonly after: Measurement;
  /** `after - before`, in seconds. */
  readonly delta: number;
  /** The same, as a percentage of the measurement before. */
  readonly percent: number;
  /** Whether the difference was smaller than the two measurements' spread. */
  readonly withinNoise: boolean;
}

/**
 * What a session was working under: the context every run of it shares, so
 * that a run record stands on its own when a report reads it.
 */
export interface SessionContext {
  readonly id: string;
  readonly startedAt: string;
  /** The model the session asked, named the way the environment names it. */
  readonly model: string | null;
  /** The project the session was aimed at, when one was named. */
  readonly project: string | null;
  readonly methods: readonly Method[];
  readonly maxIterations: number;
  readonly benchmarkRuns: number;
  /** The commit the session started from, so its commits read against it. */
  readonly baseCommit: string | null;
}

/** What one run did. */
export interface RunRecord {
  readonly version: number;
  /** A name for the run, unique within the directory. */
  readonly id: string;
  readonly session: SessionContext;
  /** Which of the session's runs this was. */
  readonly iteration: number;
  readonly method: Method;
  readonly outcome: RunOutcome;
  /** What the model said it was doing, when a model was asked. */
  readonly summary: string | null;
  readonly applied: readonly AppliedChange[];
  readonly refused: readonly RefusedProposal[];
  readonly benchmark: RunBenchmark | null;
  /** The commit a kept change became, when it became one. */
  readonly commit: string | null;
  /** Why a run that kept nothing kept nothing. */
  readonly error: string | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
}

/** What became of a whole invocation. */
export type SessionOutcome =
  /** At least one of its runs committed. */
  | "committed"
  /** It ran, and nothing was kept. */
  | "no-commits"
  /** It refused to start: the tree was dirty, the suite was already failing,
   *  or it was given something it could not read. */
  | "refused"
  /** It threw. */
  | "failed";

/** What one invocation did. */
export interface SessionRecord {
  readonly version: number;
  readonly id: string;
  readonly context: SessionContext;
  /** The ids of the runs it got through, in order. */
  readonly runs: readonly string[];
  /** How many of them committed. */
  readonly committed: number;
  readonly outcome: SessionOutcome;
  /** Why a session that did nothing did nothing. */
  readonly error: string | null;
  readonly finishedAt: string;
  readonly durationMs: number;
}

/**
 * A name for a run or a session: when it started, and a little more so two
 * in the same millisecond are still two records.
 */
export function newId(at: Date = new Date()): string {
  const stamp = at.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const salt = Math.random().toString(36).slice(2, 8);
  return `${stamp}_${salt}`;
}

/**
 * Write one run's record.
 *
 * A failure to write is not a failure of the run: the compiler was optimised
 * or it was not, and a records directory that could not be written does not
 * change that. It is said rather than swallowed, because a run that believes
 * its record was kept and has not kept it is worse than one that knows.
 *
 * @returns The path the record was written to, or null when it was not
 */
export function writeRun(record: RunRecord, repoRoot = repositoryRoot()): string | null {
  try {
    const directory = runsDirectory(repoRoot);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${record.id}.json`);
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
    return path;
  } catch (cause) {
    process.stderr.write(
      `blazeopt: the run's record could not be written: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    );
    return null;
  }
}

/** Write one session's record, on the same terms as a run's. */
export function writeSession(record: SessionRecord, repoRoot = repositoryRoot()): string | null {
  try {
    const directory = sessionsDirectory(repoRoot);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${record.id}.json`);
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
    return path;
  } catch (cause) {
    process.stderr.write(
      `blazeopt: the session's record could not be written: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    );
    return null;
  }
}

/**
 * Every run record the directory holds, oldest first.
 *
 * A record that cannot be read is left out rather than allowed to fail the
 * report: one half-written file from an interrupted run would otherwise take
 * the whole report down with it, and the report is about the runs that did
 * finish.
 */
export function readRuns(repoRoot = repositoryRoot()): RunRecord[] {
  return readRecords(runsDirectory(repoRoot), isRunRecord, (run) => run.startedAt);
}

/** Every session record the directory holds, oldest first. */
export function readSessions(repoRoot = repositoryRoot()): SessionRecord[] {
  return readRecords(sessionsDirectory(repoRoot), isSessionRecord, (session) => session.context.startedAt);
}

/**
 * Read the records in a directory, in the order they happened.
 *
 * The order is the timestamps the records themselves carry, with the name of
 * the file as a tiebreak: a run is named for when it started to the second,
 * so two runs of one session can share a name-prefix, and a report that read
 * them in the order their files happen to be named would read one turn of a
 * session before the one before it.
 */
function readRecords<T>(
  directory: string,
  isRecord: (value: unknown) => value is T,
  whenOf: (record: T) => string,
): T[] {
  if (!existsSync(directory)) return [];

  const records: Array<{ name: string; record: T }> = [];
  for (const name of readdirSync(directory).sort()) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(directory, name), "utf8"));
      if (isRecord(parsed)) records.push({ name, record: parsed });
    } catch {
      // Unreadable: see above.
    }
  }
  return records
    .sort((a, b) => whenOf(a.record).localeCompare(whenOf(b.record)) || a.name.localeCompare(b.name))
    .map((entry) => entry.record);
}

/** The one record a run's file holds, or null when the file holds no record. */
export function readRun(id: string, repoRoot = repositoryRoot()): RunRecord | null {
  return readRecord(join(runsDirectory(repoRoot), `${id}.json`), isRunRecord);
}

/** The one record a session's file holds, or null when it holds none. */
export function readSession(id: string, repoRoot = repositoryRoot()): SessionRecord | null {
  return readRecord(join(sessionsDirectory(repoRoot), `${id}.json`), isSessionRecord);
}

function readRecord<T>(path: string, isRecord: (value: unknown) => value is T): T | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Whether a parsed value is a record this version can read.
 *
 * The shape is checked rather than trusted: a report over records another
 * version wrote is a report that fails on a field that is not there.
 */
function isRunRecord(value: unknown): value is RunRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<RunRecord>;
  return (
    typeof record.id === "string" &&
    typeof record.iteration === "number" &&
    typeof record.method === "string" &&
    typeof record.outcome === "string" &&
    Array.isArray(record.applied) &&
    typeof record.session === "object" &&
    record.session !== null
  );
}

function isSessionRecord(value: unknown): value is SessionRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<SessionRecord>;
  return (
    typeof record.id === "string" &&
    Array.isArray(record.runs) &&
    typeof record.committed === "number" &&
    typeof record.outcome === "string" &&
    typeof record.context === "object" &&
    record.context !== null
  );
}

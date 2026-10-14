#!/usr/bin/env node
/**
 * blazeup-report — what the optimizer's runs have been doing.
 *
 *   blazeup-report [options]
 *
 * Reads the run and session records `blazeup` writes at the head of the
 * repository and reports on them: how often a run gets to a commit, which of
 * the three methods earns it, what has been refusing the runs (a text that is
 * not there, a test that fails, a measurement that is slower), and what the
 * measurements have been doing to the compiler over time.
 *
 * A run is one turn of the optimization loop and a session is one invocation
 * of blazeup, which is the words the records themselves are written in.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { recordsDirectory, readRuns, readSessions, type RunRecord } from "./runs.ts";
import { render, summarize } from "./summary.ts";
import type { Method } from "./ai.ts";

/** The methods a run can be, for `--method`. */
const METHODS: readonly Method[] = ["research", "build-feedback", "code-review"];

const USAGE = `blazeup-report — what the optimizer's runs have been doing

Usage:
  blazeup-report [options]

Reads what blazeup wrote into .blazeup at the head of the repository:
one record per run and one per session. A run is one turn of the
optimization loop; a session is one invocation of blazeup.

Options:
  --limit <n>        Only the most recent n runs (default: all)
  --method <name>    Only runs of one method: research, build-feedback,
                     code-review
  --since <text>     Only runs started after this instant: an ISO timestamp,
                     or a number of days back (7 is the last week)
  --path <path>      Read the records from this repository instead of this one
  --json             A machine-readable report instead of one to read
  --list             One line per run, newest first, and nothing else
  -h, --help         Show this help
`;

interface Options {
  limit?: number;
  method?: Method;
  since?: Date;
  repoRoot?: string;
  json: boolean;
  list: boolean;
}

function main(argv: string[]): number {
  let parsed;
  try {
    // Strict: an unknown option is a typo, and a typo that quietly changes
    // what the report is about is a report that answers something else.
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        limit: { type: "string" },
        method: { type: "string" },
        since: { type: "string" },
        path: { type: "string" },
        json: { type: "boolean" },
        list: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n\n${USAGE}`);
    return 1;
  }

  if (parsed.values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const options: Options = { json: parsed.values.json === true, list: parsed.values.list === true };
  const wrong: string[] = [];

  if (parsed.values.limit !== undefined) {
    const limit = Number(parsed.values.limit);
    if (!Number.isInteger(limit) || limit < 1) {
      wrong.push(`--limit needs a whole number of runs, not "${parsed.values.limit}"`);
    } else {
      options.limit = limit;
    }
  }

  if (parsed.values.method !== undefined) {
    if (!METHODS.includes(parsed.values.method as Method)) {
      wrong.push(`--method needs one of ${METHODS.join(", ")}, not "${parsed.values.method}"`);
    } else {
      options.method = parsed.values.method as Method;
    }
  }

  if (parsed.values.since !== undefined) {
    const since = parseSince(parsed.values.since);
    if (since === null) {
      wrong.push(
        `--since needs an ISO timestamp or a number of days back, not "${parsed.values.since}"`,
      );
    } else {
      options.since = since;
    }
  }

  if (parsed.values.path !== undefined) {
    options.repoRoot = parsed.values.path;
  }

  if (wrong.length > 0) {
    process.stderr.write(`${wrong.join("\n")}\n\n${USAGE}`);
    return 1;
  }

  const runs = select(readRuns(options.repoRoot), options);
  const sessions = readSessions(options.repoRoot);

  // No records at all is a report about nothing, and says where it looked:
  // a repository that has never run the optimizer has no records, and that
  // is the most likely explanation for being here.
  if (runs.length === 0 && sessions.length === 0) {
    process.stderr.write(
      `blazeup-report: no records at ${recordsDirectory(options.repoRoot)}\n` +
        "Run blazeup first: every run and every session writes a record, whatever happened.\n",
    );
    return 1;
  }

  if (options.list) {
    for (const run of [...runs].reverse()) process.stdout.write(`${line(run)}\n`);
    return 0;
  }

  const summary = summarize(runs, sessions);
  process.stdout.write(options.json ? `${JSON.stringify(summary, null, 2)}\n` : render(summary));
  return 0;
}

/**
 * The runs the options ask for, oldest first.
 *
 * `--limit` is applied last, so that it keeps the most recent runs of the
 * method it is already looking at rather than the most recent runs of all.
 */
function select(runs: readonly RunRecord[], options: Options): RunRecord[] {
  let selected = [...runs];
  if (options.method !== undefined) {
    selected = selected.filter((run) => run.method === options.method);
  }
  if (options.since !== undefined) {
    const since = options.since.getTime();
    selected = selected.filter((run) => Date.parse(run.startedAt) >= since);
  }
  if (options.limit !== undefined) {
    selected = selected.slice(-options.limit);
  }
  return selected;
}

/**
 * What `--since` was given: an ISO timestamp, or a number of days back from
 * now. Null when it is neither.
 */
function parseSince(text: string): Date | null {
  if (text.trim() !== "" && Number.isFinite(Number(text))) {
    const at = new Date();
    at.setUTCDate(at.getUTCDate() - Number(text));
    return at;
  }
  const at = new Date(text);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** One line per run, newest first. */
function line(run: RunRecord): string {
  const when = run.startedAt.replace("T", " ").slice(0, 16);
  const kept = run.outcome === "committed" ? ` ${run.commit ?? ""}` : "";
  const refusedCount = run.refused?.length ?? 0;
  const refused = refusedCount > 0 ? ` (+${refusedCount} refused)` : "";
  const error = run.error === null ? "" : ` — ${firstLine(run.error)}`;
  return `${when}  ${run.iteration} ${pad(run.method)}  ${pad(run.outcome)}${kept}${refused}${error}`;
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? "";
}

function pad(text: string, width = 14): string {
  return text.length >= width ? text : `${text}${" ".repeat(width - text.length)}`;
}

/**
 * This module is the command, so running is what it does when it is the one
 * being run rather than read: `summary.ts` is what the numbers live in, and
 * importing that is how they are read without reporting on them.
 */
function isInvoked(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isInvoked()) {
  process.exitCode = main(process.argv.slice(2));
}

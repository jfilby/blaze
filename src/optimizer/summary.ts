/**
 * What the records add up to, and how it reads.
 *
 * The numbers a report is made of are computed here over whole records
 * rather than accumulated as runs are made, so that the same records read
 * twice give the same report, and so that a report can be checked against
 * hand-written records without running anything.
 *
 * Nothing here reads the filesystem: `readRuns` and `readSessions` do that,
 * and what they hand over is what is counted.
 */

import type { Method } from "./ai.ts";
import type { RunOutcome, RunRecord, SessionRecord, SessionOutcome } from "./runs.ts";

/** What the records add up to. */
export interface Summary {
  /** How many runs the report is about. */
  readonly runs: number;
  /** How many sessions those runs came from, and how many there were. */
  readonly sessions: number;
  readonly committed: number;
  /** When the earliest and latest of the runs recorded started. */
  readonly firstAt: string | null;
  readonly lastAt: string | null;
  /** Each method, and what became of its runs. */
  readonly byMethod: readonly MethodSummary[];
  /** How often each outcome happened. */
  readonly outcomes: readonly OutcomeSummary[];
  /** What has been refusing the runs, most often first. */
  readonly refusals: readonly RefusalSummary[];
  /** What the measurements have been doing. */
  readonly measurements: Measurements;
  /** Which files the kept changes were written in, most changed first. */
  readonly files: readonly FileSummary[];
  /** What became of the sessions the runs came from. */
  readonly sessionOutcomes: readonly OutcomeSummary[];
  /** The runs that did not keep anything, newest first, and why. */
  readonly failures: readonly Failure[];
  /** The research papers the runs read, and whether they were of use. */
  readonly research: readonly ResearchSummary[];
}

export interface MethodSummary {
  readonly method: Method;
  readonly runs: number;
  readonly committed: number;
  /** committed / runs, as a percentage, or null when it ran nothing. */
  readonly rate: number | null;
  readonly outcomes: readonly OutcomeSummary[];
}

export interface OutcomeSummary {
  readonly outcome: string;
  readonly count: number;
}

export interface RefusalSummary {
  readonly reason: string;
  readonly file: string | null;
  readonly count: number;
}

export interface Measurements {
  /** How many runs measured their change at all. */
  readonly measured: number;
  /** How many measured faster, and how many measured slower. */
  readonly faster: number;
  readonly slower: number;
  /** The mean and the median of the measured change, as a percentage. */
  readonly meanPercent: number | null;
  readonly medianPercent: number | null;
  /**
   * Kept changes that measured slower. This is zero when the gate held: a
   * change is only committed when it was not measurably slower, so a number
   * here is a record of the gate disagreeing with itself.
   */
  readonly committedSlower: number;
  /** The last few measured changes, newest first. */
  readonly recent: readonly MeasurementLine[];
}

export interface MeasurementLine {
  readonly at: string;
  readonly method: Method;
  readonly before: number;
  readonly after: number;
  readonly percent: number;
  readonly withinNoise: boolean;
  readonly committed: boolean;
}

export interface FileSummary {
  readonly file: string;
  readonly changes: number;
}

export interface Failure {
  readonly at: string;
  readonly iteration: number;
  readonly method: Method;
  readonly outcome: RunOutcome;
  readonly error: string | null;
  readonly refused: readonly RefusalSummary[];
}

/** A research paper, and what became of the runs that read it. */
export interface ResearchSummary {
  readonly title: string;
  readonly url: string;
  /** How many runs read this paper. */
  readonly runs: number;
  /** How many of those runs committed. */
  readonly committed: number;
  /** Whether this paper was of use: at least one run that read it committed. */
  readonly useful: boolean;
}

/** The order the outcomes are read in, which is the order that matters. */
const OUTCOME_ORDER: readonly RunOutcome[] = [
  "committed",
  "no-proposals",
  "nothing-applied",
  "tests-failed",
  "slower",
  "skipped",
  "failed",
];

const SESSION_ORDER: readonly SessionOutcome[] = ["committed", "no-commits", "refused", "failed"];

/**
 * What the records add up to.
 *
 * @param runs The run records to read, oldest first
 * @param sessions Every session record, whether these runs came from them
 *   or not: a session that never got a run off the ground is a result, and
 *   the runs alone would not show it
 */
export function summarize(runs: readonly RunRecord[], sessions: readonly SessionRecord[]): Summary {
  return {
    runs: runs.length,
    sessions: sessions.length,
    committed: runs.filter((run) => run.outcome === "committed").length,
    firstAt: runs[0]?.startedAt ?? null,
    lastAt: runs.at(-1)?.startedAt ?? null,
    byMethod: byMethod(runs),
    outcomes: countBy(runs, (run) => run.outcome, OUTCOME_ORDER),
    refusals: refusalSummary(runs),
    measurements: measurements(runs),
    files: fileSummary(runs),
    sessionOutcomes: countSessions(sessions),
    failures: failures(runs),
    research: researchSummary(runs),
  };
}

function byMethod(runs: readonly RunRecord[]): MethodSummary[] {
  const methods = [...new Set(runs.map((run) => run.method))];
  return methods.map((method) => {
    const of = runs.filter((run) => run.method === method);
    const committed = of.filter((run) => run.outcome === "committed").length;
    return {
      method,
      runs: of.length,
      committed,
      rate: of.length === 0 ? null : (committed / of.length) * 100,
      outcomes: countBy(of, (run) => run.outcome, OUTCOME_ORDER),
    };
  });
}

function countBy<K extends string>(
  runs: readonly RunRecord[],
  key: (run: RunRecord) => K,
  order: readonly K[],
): OutcomeSummary[] {
  const counts = new Map<string, number>();
  for (const run of runs) {
    const value = key(run);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return order
    .filter((value) => counts.has(value))
    .map((value) => ({ outcome: value, count: counts.get(value) ?? 0 }));
}

function countSessions(sessions: readonly SessionRecord[]): OutcomeSummary[] {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    counts.set(session.outcome, (counts.get(session.outcome) ?? 0) + 1);
  }
  return SESSION_ORDER.filter((value) => counts.has(value)).map((value) => ({
    outcome: value,
    count: counts.get(value) ?? 0,
  }));
}

/**
 * What has been refusing the runs.
 *
 * A refusal is counted by what it was, not by which file it was about: a
 * change written where a turn may not write is refused however many times
 * the agent tries it, and that is one fact about the compiler and the agent
 * rather than a count of files.
 */
function refusalSummary(runs: readonly RunRecord[]): RefusalSummary[] {
  const counts = new Map<string, RefusalSummary>();
  for (const run of runs) {
    for (const refused of run.refused) {
      const key = refused.reason;
      const found = counts.get(key);
      if (found === undefined) {
        counts.set(key, { reason: refused.reason, file: refused.file, count: 1 });
      } else {
        counts.set(key, { ...found, count: found.count + 1 });
      }
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

function fileSummary(runs: readonly RunRecord[]): FileSummary[] {
  const counts = new Map<string, number>();
  // A change that was reverted was written into the compiler's source and
  // then taken out again: the file is not one a report counts, because this
  // report is about what the compiler ended up holding.
  const kept = runs.filter((run) => run.outcome === "committed");
  for (const run of kept) {
    for (const change of run.applied) {
      counts.set(change.file, (counts.get(change.file) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([file, changes]) => ({ file, changes }))
    .sort((a, b) => b.changes - a.changes || a.file.localeCompare(b.file));
}

function measurements(runs: readonly RunRecord[]): Measurements {
  const measured = runs.filter((run) => run.benchmark !== null);
  const faster = measured.filter((run) => (run.benchmark?.percent ?? 0) < 0);
  const slower = measured.filter((run) => (run.benchmark?.percent ?? 0) > 0);
  const percents = measured.map((run) => run.benchmark?.percent ?? 0).sort((a, b) => a - b);

  return {
    measured: measured.length,
    faster: faster.length,
    slower: slower.length,
    meanPercent: mean(percents),
    medianPercent: median(percents),
    // A kept change that measured slower *and* beyond the noise: one that
    // measured faster is not slower however far outside its spread it was.
    committedSlower: measured.filter(
      (run) =>
        run.outcome === "committed" &&
        run.benchmark !== null &&
        run.benchmark.delta > 0 &&
        !run.benchmark.withinNoise,
    ).length,
    recent: [...measured]
      .reverse()
      .slice(0, 5)
      .map((run) => ({
        at: run.startedAt,
        method: run.method,
        before: run.benchmark?.before.mean ?? 0,
        after: run.benchmark?.after.mean ?? 0,
        percent: run.benchmark?.percent ?? 0,
        withinNoise: run.benchmark?.withinNoise ?? true,
        committed: run.outcome === "committed",
      })),
  };
}

function failures(runs: readonly RunRecord[]): Failure[] {
  return [...runs]
    .reverse()
    .filter((run) => run.outcome !== "committed")
    .slice(0, 8)
    .map((run) => ({
      at: run.startedAt,
      iteration: run.iteration,
      method: run.method,
      outcome: run.outcome,
      error: run.error,
      refused: refusalSummary([run]),
    }));
}

/**
 * Which research papers were of use, and which were not.
 *
 * A paper is of use when at least one run that read it committed: the research
 * it carried was turned into a change that survived the suite and the
 * measurement. A paper that was only read by runs that kept nothing was not
 * of use — the ideas it carried were not ones this compiler could use, or not
 * ones the agent could turn into a change.
 *
 * A paper read by both a committed run and a failed run is counted as useful:
 * the same paper can carry an idea that works and one that does not, and the
 * run that found the working one is the answer to whether the paper was worth
 * reading.
 */
function researchSummary(runs: readonly RunRecord[]): ResearchSummary[] {
  const byUrl = new Map<string, ResearchSummary>();
  for (const run of runs) {
    for (const paper of run.papers) {
      const found = byUrl.get(paper.url);
      if (found === undefined) {
        byUrl.set(paper.url, {
          title: paper.title,
          url: paper.url,
          runs: 1,
          committed: run.outcome === "committed" ? 1 : 0,
          useful: run.outcome === "committed",
        });
      } else {
        const committed = found.committed + (run.outcome === "committed" ? 1 : 0);
        byUrl.set(paper.url, {
          ...found,
          runs: found.runs + 1,
          committed,
          useful: found.useful || run.outcome === "committed",
        });
      }
    }
  }
  return [...byUrl.values()].sort((a, b) => {
    // Useful papers first, then by how many runs read them, then by title.
    if (a.useful !== b.useful) return a.useful ? -1 : 1;
    if (a.runs !== b.runs) return b.runs - a.runs;
    return a.title.localeCompare(b.title);
  });
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 1 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2;
}

/** How the summary reads, for a person. */
export function render(summary: Summary): string {
  const out: string[] = [];
  const width = 72;
  const rule = "-".repeat(width);

  out.push("blazeopt-report".padEnd(width));
  out.push(rule);
  out.push(
    `${summary.runs} run${plural(summary.runs)}, ${summary.committed} committed, ` +
      `from ${summary.sessions} session${plural(summary.sessions)}`,
  );
  if (summary.firstAt !== null && summary.lastAt !== null) {
    out.push(`First run ${short(summary.firstAt)}, last run ${short(summary.lastAt)}`);
  }
  out.push("");

  if (summary.runs > 0) {
    const rate = (summary.committed / summary.runs) * 100;
    out.push(`A run commits ${rate.toFixed(0)}% of the time.`);
    out.push("");
  }

  if (summary.byMethod.length > 0) {
    out.push("By method");
    out.push(rule);
    for (const method of summary.byMethod) {
      const rate = method.rate === null ? "never ran" : `${method.rate.toFixed(0)}%`;
      out.push(
        `  ${method.method.padEnd(15)} ${String(method.runs).padStart(4)} runs  ${String(method.committed).padStart(4)} committed  ${rate}`,
      );
      const outcomes = method.outcomes.map((o) => `${o.outcome} ${o.count}`).join(", ");
      out.push(`  ${" ".repeat(15)} ${outcomes}`);
    }
    out.push("");
  }

  if (summary.measurements.measured > 0) {
    const m = summary.measurements;
    out.push("Measurements");
    out.push(rule);
    out.push(
      `  ${m.measured} change${plural(m.measured)} measured: ${m.faster} faster, ${m.slower} slower, ` +
        `${m.measured - m.faster - m.slower} unchanged`,
    );
    out.push(
      `  mean ${signed(m.meanPercent)}, median ${signed(m.medianPercent)} ` +
        `(a negative number is a compiler that got faster)`,
    );
    if (m.committedSlower > 0) {
      out.push(`  ${m.committedSlower} committed change(s) measured slower than the noise: the gate did not hold`);
    }
    out.push("  The most recent measured changes:");
    for (const line of m.recent) {
      const kept = line.committed ? "kept" : "reverted";
      const noise = line.withinNoise ? "" : " (beyond noise)";
      out.push(
        `    ${short(line.at)}  ${line.method.padEnd(15)} ${signed(line.percent).padStart(8)}  ${kept}${noise}`,
      );
    }
    out.push("");
  }

  if (summary.refusals.length > 0) {
    out.push("What refused the runs");
    out.push(rule);
    for (const refusal of summary.refusals) {
      out.push(`  ${String(refusal.count).padStart(4)} × ${refusal.reason}`);
    }
    out.push("");
  }

  if (summary.files.length > 0) {
    out.push("Files the kept changes were written in");
    out.push(rule);
    for (const file of summary.files) {
      out.push(`  ${String(file.changes).padStart(4)} × ${file.file}`);
    }
    out.push("");
  }

  if (summary.research.length > 0) {
    out.push("Research papers the runs read");
    out.push(rule);
    const useful = summary.research.filter((p) => p.useful);
    const notUseful = summary.research.filter((p) => !p.useful);
    if (useful.length > 0) {
      out.push(`  Of use (${useful.length}):`);
      for (const paper of useful) {
        const runs = paper.runs > 1 ? `, ${paper.runs} runs` : "";
        out.push(`    ${paper.title} (${paper.committed} committed${runs})`);
        out.push(`      ${paper.url}`);
      }
    }
    if (notUseful.length > 0) {
      out.push(`  Not of use (${notUseful.length}):`);
      for (const paper of notUseful) {
        const runs = paper.runs > 1 ? `, ${paper.runs} runs` : "";
        out.push(`    ${paper.title}${runs}`);
        out.push(`      ${paper.url}`);
      }
    }
    out.push("");
  }

  if (summary.sessionOutcomes.length > 0) {
    out.push("Sessions");
    out.push(rule);
    out.push(`  ${summary.sessionOutcomes.map((s) => `${s.outcome} ${s.count}`).join(", ")}`);
    if (summary.sessionOutcomes.some((s) => s.outcome === "refused" && s.count > 0)) {
      out.push("  (a refused session is a run that did not start: the tree, the suite, or the arguments)");
    }
    out.push("");
  }

  if (summary.failures.length > 0) {
    out.push("Runs that kept nothing, most recent first");
    out.push(rule);
    for (const failure of summary.failures) {
      const why = failure.error ?? failure.refused.map((r) => r.reason).join("; ");
      out.push(`  ${short(failure.at)}  run ${failure.iteration} ${failure.method} — ${failure.outcome}`);
      if (why !== "") out.push(`      ${firstLine(why)}`);
    }
    out.push("");
  }

  return `${out.join("\n")}\n`;
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? "";
}

function short(at: string): string {
  return at.replace("T", " ").slice(0, 16);
}

function signed(value: number | null): string {
  if (value === null) return "  —";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function plural(count: number): string {
  return count === 1 ? "" : "s";
}

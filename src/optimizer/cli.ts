#!/usr/bin/env node
/**
 * blazeup - iterative blaze compiler optimizer.
 *
 *   blazeup [project] [options]
 *
 * Runs an optimization loop of turns, each with one of three methods:
 *   1. research       — Tavily search + compiler source review
 *   2. build-feedback — blaze build AI review feedback + compiler source review
 *   3. code-review    — compiler source review alone
 *
 * Each turn hands what it gathered to the coding agent pi, which reads the
 * compiler and edits it. The result is judged with the compiler's own test
 * suite and a measurement of it, and a change that survives is committed.
 *
 * A project path targets the run at one blaze project: the research queries
 * and the build feedback are about that project, and the agent is told what
 * the project does.
 *
 * Options:
 *   --max-iterations <n>   Maximum runs (default 3)
 *   --benchmark-runs <n>   Hyperfine runs per benchmark (default 5)
 *   --methods <list>       Comma-separated methods to cycle through
 *                         (default "research,build-feedback,code-review")
 *   --show-ai-coding       Print what the coding agent does as it works
 *                          (default; --no-show-ai-coding turns it off)
 *   -h, --help             Show this help
 */

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { craftQuery, searchTavily, tavilyApiKey } from "./tavily.ts";
import { addProcessed, isProcessed, loadCache, markUseful, saveCache, type CacheEntry } from "./cache.ts";
import {
  benchmarkCompiler,
  benchmarkProject,
  SKIP_HEAP_PROOF_ENV,
  type BenchmarkResult,
} from "./benchmark.ts";
import { gatherBuildFeedback } from "./build-feedback.ts";
import { AGENTS_FILE, agentsFile, compilerDirectory, repositoryRoot } from "./repository.ts";
import {
  AGENT_COMMAND,
  agentProblem,
  agentSmokeProblem,
  changedPaths,
  editVerdict,
  nothingToJudge,
  putBack,
  revertEdits,
  runAgent,
  setAside,
  verdictReason,
  type FileEdit,
} from "./agentic.ts";
import { modelProblem, modelToAsk, type Method } from "./ai.ts";
import { benchmarkExample, deliveredProgram, loadProject, PROJECT_FILE, type ProjectInfo } from "./project.ts";
import {
  DEFAULT_BENCHMARK_RUNS,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_METHODS,
  newId,
  readSession,
  RECORD_VERSION,
  resumeCommand,
  writeRun,
  writeSession,
  type RefusedProposal,
  type ResearchPaper,
  type RunOutcome,
  type RunRecord,
  type SessionContext,
  type SessionOutcome,
  type SessionRecord,
  type Goal,
} from "./runs.ts";

/** The goals a session can be run for. */
export const GOALS: readonly Goal[] = ["optimize", "capability"];
export type { Goal };

/** The compiler directory, where `npm test` is run. */
const COMPILER_DIR = compilerDirectory();

/** The repository the agent works at the base of. */
const REPO_DIR = repositoryRoot();

/** How the run names the thing it hands its work to. */
const AGENT_DESCRIPTION = `${AGENT_COMMAND}, the coding agent`;

/** How much of the agent's answer a run record carries. */
const AGENT_SUMMARY_BUDGET = 600;

/** Whether a string names a goal a run can be run for. */
export function isGoal(value: string): value is Goal {
  return GOALS.includes(value as Goal);
}

/** The methods a methods list names, or null when it names none of them. */
export function parseMethods(value: string): Method[] | null {
  const parts = value.split(",").map((m) => m.trim());
  const methods: Method[] = [];
  for (const part of parts) {
    if (part === "") continue;
    if (!DEFAULT_METHODS.includes(part as Method)) return null;
    if (!methods.includes(part as Method)) methods.push(part as Method);
  }
  if (methods.length === 0) return null;
  return methods;
}

const USAGE = `blazeup - iterative blaze compiler optimizer

Alternates between three methods (research, build-feedback, code-review),
each of which gathers what the coding agent pi is given to read. The agent
reads the compiler and edits it, and every change is tested with the full
test suite, benchmarked with hyperfine, and committed on success.

Usage:
  blazeup <goal> [project] [options]

goal must be one of: ${GOALS.join(", ")}.
  optimize     improve the compiler's generated code (the default kind of run)
  capability  add what the compiler is missing, especially for a named project

A project is a directory containing blaze.toml, or a .toml file naming its
own. With one, the run is targeted at it: the research queries are about
what the project does, the build-feedback method compiles it, and the agent
is told what the project is for. Without one, the runs are general.

A run is measured on what it improves: the compiler's own test suite when no
project is named, and the program the project builds when one is. How much of
that program to run is the project's own to say -- a command nobody chose can
use all the machine's memory -- so a run aimed at a project needs a
[benchmark] entry in its blaze.toml naming the command to time and the
directory to run it in. A project that names none is refused, and the refusal
prints the entry to write.

A run establishes the compiler's test suite as a baseline before it starts,
refuses a working tree that already holds uncommitted work, and commits only
the files the agent changed. A change the suite rejects, or that measures
slower than the noise, is reverted.

The agent is started at the base of the repository rather than in the
compiler directory, because that is where the repository's own AGENTS.md
lives and what it says is how this repository is worked in. It is handed
that file by name as well, so it does not depend on finding it.

Every run and every session records itself in .blazeup at the head of the
repository, whatever happened. blazeup-report reports on those records.

A session that dies before it finishes — a rate-limited model, a missing key,
a crash — leaves a record of where it stopped, and the command to continue it
is printed as the session starts and again when it fails: blazeup --resume <id>
rebuilds the session from that record and runs the runs it had left.

Options:
  --max-iterations <n>   Maximum runs (default 3)
  --benchmark-runs <n>   Hyperfine runs per benchmark (default 5)
  --methods <list>       Comma-separated methods to cycle through:
                           research       Tavily search + compiler source review
                           build-feedback blaze build AI review feedback + source
                           code-review    compiler source review alone
                         (default "research,build-feedback,code-review")
  --resume <id>          Continue a failed session where it stopped
  --show-ai-coding       print what the coding agent does as it works
                           (default; --no-show-ai-coding turns it off)
  -h, --help             show this help

Environment:
  TAVILY_API_KEY         enables research runs
  AI_MODEL               provider/model for the coding agent (e.g. anthropic/claude-sonnet-4-5).
                         With a project, its blaze.toml is read instead when this
                         is not set, because a build of it would ask that model.
  ANTHROPIC_API_KEY      Anthropic API key
  OPENAI_API_KEY         OpenAI API key
  GOOGLE_GENERATIVE_AI_API_KEY  Google API key
`;

interface Options {
  maxIterations: number;
  benchmarkRuns: number;
  /** Whether what the coding agent does is printed as it works. */
  showOutput: boolean;
  project?: ProjectInfo;
  goal?: Goal;
}

async function runOne(
  method: Method,
  iteration: number,
  session: SessionContext,
  options: Options,
): Promise<RunRecord> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();

  // What the run turns out to have done. Every way out of this function fills
  // it in, because a run that did nothing is a result too.
  const record: Mutable<RunRecord> = {
    version: RECORD_VERSION,
    id: newId(new Date(started)),
    session,
    iteration,
    method,
    outcome: "failed",
    summary: null,
    applied: [],
    refused: [],
    benchmark: null,
    commit: null,
    error: null,
    papers: [],
    startedAt,
    finishedAt: startedAt,
    durationMs: 0,
  };

  process.stdout.write(`\n${"=".repeat(72)}\n`);
  process.stdout.write(`Run ${iteration}/${session.maxIterations}: ${method}\n`);
  process.stdout.write(`${"=".repeat(72)}\n\n`);

  // 1. Gather context
  let context: string | null = "";
  if (method === "research") {
    const research = await gatherResearchContext(options.project);
    // Nothing new to read is nothing to work from: a run of research whose
    // papers have all been processed would otherwise be asked for an
    // improvement out of memory of them.
    if (research === null) {
      process.stdout.write("Nothing new in the research cache, skipping.\n\n");
      return finish(record, "skipped", started);
    }
    context = research.context;
    record.papers = research.papers;
  } else if (method === "build-feedback") {
    context = await gatherBuildFeedbackContext(options.project);
  }

  // 2. Hand the run to the coding agent, which reads the compiler and writes
  //    the change. It works at the base of the repository, under the
  //    repository's own instructions, and everything it writes is read back
  //    out of the tree rather than remembered from what it said.
  process.stdout.write(`Handing the run to ${AGENT_DESCRIPTION} at the base of the repository...\n`);
  const answer = await askCodingAgent(method, context, options.project, options.showOutput, options.goal);

  record.summary = answer.summary === "" ? null : answer.summary;
  record.applied = answer.files.map((file) => ({ file, description: "the coding agent's change" }));
  record.refused = answer.refused;

  for (const refusal of answer.refused) {
    process.stderr.write(`  Refused (${refusal.reason}): ${refusal.file}\n`);
  }

  // The agent could not be asked at all: it is not installed, the
  // instructions are not there, or the model it was given cannot write code.
  // Whatever it wrote before it died is work nobody has judged, and the tree
  // has already been put back the way it was found.
  if (answer.problem !== null) {
    process.stdout.write(`${answer.problem}\n`);
    return finish(record, "failed", started, answer.problem);
  }

  if (answer.files.length === 0) {
    // The agent answered — it said what it did, or wrote where it may not —
    // but nothing it wrote is a change the run can keep. That is a turn that
    // happened and kept nothing rather than one that could not happen, so
    // the two are named apart: an agent that had its every write refused
    // applied nothing, and one that looked and found nothing proposed
    // nothing.
    const outcome: RunOutcome = answer.refused.length > 0 ? "nothing-applied" : "no-proposals";
    process.stdout.write("Nothing to keep: the agent changed nothing the run can keep.\n");
    return finish(record, outcome, started);
  }

  for (const file of answer.files) process.stdout.write(`  Changed: ${file}\n`);
  process.stdout.write(`\nThe coding agent says:\n${answer.summary}\n\n`);

  // From here the working tree holds the agent's change, so every exit from
  // this block either commits it or reverts exactly the files the agent
  // wrote. The whole tree is never touched: it is the user's repository and
  // it holds anything else they have in progress.
  try {
    // 3. Test
    process.stdout.write("\nRunning test suite...\n");
    const testResult = testsPassed();
    if (!testResult) {
      process.stdout.write("Tests failed, reverting changes.\n");
      revertEdits(answer.files, REPO_DIR);
      return finish(record, "tests-failed", started, "the compiler's test suite rejected the change");
    }
    process.stdout.write("Tests passed.\n");

    // 4. Measure with the change and without it, on what the run improves
    const measured = await measureChange(answer.files, options.benchmarkRuns, options.project);
    record.benchmark = {
      before: measured.before,
      after: measured.after,
      delta: measured.delta,
      percent: (measured.delta / measured.before.mean) * 100,
      withinNoise: !isSlower(measured.before, measured.after),
    };

    if (isSlower(measured.before, measured.after)) {
      process.stdout.write(
        `  Slower by ${measured.delta.toFixed(3)}s (${((measured.delta / measured.before.mean) * 100).toFixed(1)}%), reverting.\n`,
      );
      revertEdits(answer.files, REPO_DIR);
      return finish(
        record,
        "slower",
        started,
        `the change measured ${measured.delta.toFixed(3)}s slower, beyond measurement noise`,
      );
    }
    if (measured.delta < 0) {
      process.stdout.write(
        `  Faster by ${(-measured.delta).toFixed(3)}s (${((-measured.delta / measured.before.mean) * 100).toFixed(1)}%)\n`,
      );
    } else {
      process.stdout.write(`  Within measurement noise (${measured.delta.toFixed(3)}s)\n`);
    }

    // 5. Commit
    const commit = commitChanges(
      method,
      record.applied.map((change) => `${change.file}: ${change.description}`),
      answer.files,
    );
    if (commit === null) {
      // Nothing to commit is not a run that kept its change either: the
      // change is in the tree, uncommitted, and the record says so.
      return finish(record, "nothing-applied", started, "git had nothing to commit");
    }
    record.commit = commit;
    return finish(record, "committed", started);
  } catch (cause) {
    // A run that dies after writing its change must not leave the compiler
    // modified and uncommitted: the next turn would be working on top of a
    // change nobody has judged.
    revertEdits(answer.files, REPO_DIR);
    return finish(record, "failed", started, cause instanceof Error ? cause.message : String(cause));
  }
}

/** Close a pass's record: the outcome, and how long it took. */
function finish(record: Mutable<RunRecord>, outcome: RunOutcome, started: number, error?: string): RunRecord {
  const finished = Date.now();
  record.outcome = outcome;
  record.error = error ?? null;
  record.finishedAt = new Date(finished).toISOString();
  record.durationMs = finished - started;
  return record;
}

/** A record being filled in, so that it is written once it is whole. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** What the coding agent did, as far as the run can tell. */
interface AgentAnswer {
  /** Every path it wrote that the run may keep. */
  readonly files: readonly FileEdit[];
  /** Every path it wrote that the run may not, and why. */
  readonly refused: readonly RefusedProposal[];
  /** What it says it did. */
  readonly summary: string;
  /** Why there is nothing to judge, or null when there is. */
  readonly problem: string | null;
}

/**
 * Read what the agent wrote out of the tree, and take back out what it may
 * not have written.
 *
 * The tree is read rather than remembered: an agent with tools of its own may
 * write a file nobody asked it for, and the tree is the only thing that
 * knows. What it may write is the compiler, and never the compiler's tests,
 * which are the gate the change is judged by. Anything else is taken back out
 * before the turn is judged, and named as the refusal it is.
 *
 * @param cwd The base of the repository, whose tree is read
 */
export function readAgentEdits(cwd: string): { files: FileEdit[]; refused: RefusedProposal[] } {
  const files: FileEdit[] = [];
  const refused: RefusedProposal[] = [];
  for (const path of changedPaths(cwd)) {
    const verdict = editVerdict(path, cwd);
    if (verdict === "compiler") files.push(path);
    else refused.push({ file: path, reason: verdictReason(verdict) });
  }
  revertEdits(
    refused.map((entry) => entry.file),
    cwd,
  );
  return { files, refused };
}

/**
 * Hand one turn of the loop to the coding agent, and read back what it wrote.
 *
 * The agent is started at the base of the repository, under the repository's
 * own instructions, and what it wrote is read out of the tree rather than
 * taken from what it says: an agent with its own tools may write a file
 * nobody asked it for, and the tree is the only thing that knows.
 *
 * @param showOutput Whether what it does is printed as it does it, which is
 *   asked of the stream it writes rather than of what it wrote
 */
async function askCodingAgent(
  method: Method,
  context: string,
  project: ProjectInfo | undefined,
  showOutput: boolean,
  goal?: Goal,
): Promise<AgentAnswer> {
  const problem = agentProblem(modelToAsk(project));
  if (problem !== null) return { files: [], refused: [], summary: "", problem };

  const answer = await runAgent({
    method,
    context,
    project,
    goal,
    model: modelToAsk(project),
    instructions: agentsFile(REPO_DIR),
    cwd: REPO_DIR,
    showOutput,
  });

  const edits = readAgentEdits(REPO_DIR);
  const files = edits.files;
  const refused = edits.refused;

  // Everything it wrote, whether the turn may keep it or not: an agent that
  // died leaves work nobody has judged, and a tree that goes back the way it
  // was found is the state a turn that kept nothing is in.
  const written = [...files, ...refused.map((entry) => entry.file)];
  const answerText = cap(answer.summary, AGENT_SUMMARY_BUDGET);

  if (answer.problem !== null) {
    revertEdits(written, REPO_DIR);
    return { files: [], refused, summary: answerText, problem: answer.problem };
  }
  if (answer.exitCode !== 0) {
    revertEdits(written, REPO_DIR);
    const detail = answer.detail === "" ? "" : `\n${answer.detail}`;
    return {
      files: [],
      refused,
      summary: answerText,
      problem: `the coding agent exited ${String(answer.exitCode)}${detail}`,
    };
  }

  // An agent that contributed nothing at all did not answer, however its
  // process exited: it wrote nothing the run may keep, had nothing it wrote
  // taken back out, and said nothing. There is no turn to judge, so this is
  // the same as an agent that could not be asked, and the run is recorded as
  // one that could not happen rather than one that looked and kept nothing.
  // An agent that kept failing upstream and gave up lands here.
  const unanswered = nothingToJudge(files, refused, answerText);
  if (unanswered !== null) {
    return { files: [], refused, summary: answerText, problem: unanswered };
  }

  return { files, refused, summary: answerText, problem: null };
}

/** What a measurement of one change came to. */
interface Measured {
  readonly before: BenchmarkResult;
  readonly after: BenchmarkResult;
  /** `after - before`, in seconds. */
  readonly delta: number;
}

/**
 * Measure the compiler with the change and without it.
 *
 * The change is already in the tree by the time there is anything to
 * measure, so it is taken out — read into the run, the tree put back the way
 * it was, and the change written back afterwards. The two measurements are
 * then of the same compiler minutes apart rather than a run apart.
 */
async function measureChange(
  files: readonly FileEdit[],
  runs: number,
  project: ProjectInfo | undefined,
): Promise<Measured> {
  const aside = setAside(files, REPO_DIR);
  revertEdits(files, REPO_DIR);

  // What a run aimed at a project measures is the program it builds, which is
  // the thing the compiler makes fast; what a general run measures is the
  // compiler's own suite, which is the only command that means the same thing
  // from any directory.
  const what = measuredThing(project);
  let before: BenchmarkResult;
  try {
    process.stdout.write(`\nMeasuring ${what} without the change...\n`);
    before = await measure(runs, project);
    process.stdout.write(
      `  Before: ${before.mean.toFixed(3)}s ± ${before.stddev.toFixed(3)}s (${before.runs} runs)\n`,
    );
  } finally {
    putBack(aside, REPO_DIR);
  }

  process.stdout.write(`\nMeasuring ${what} with the change...\n`);
  const after = await measure(runs, project);
  process.stdout.write(`  After:  ${after.mean.toFixed(3)}s ± ${after.stddev.toFixed(3)}s (${after.runs} runs)\n`);

  return { before, after, delta: after.mean - before.mean };
}

/** What the measurement of one change is of, said the way a run says it. */
function measuredThing(project: ProjectInfo | undefined): string {
  if (project === undefined || project.benchmark === null) return "the compiler";
  return `the program ${userPath(project.tomlPath)} builds`;
}

/**
 * A path the way whoever ran this names it: from the base of the repository
 * when it is inside it, and absolute when it is not, so a project anywhere else
 * is named by where it is rather than by how far away it is.
 */
function userPath(path: string): string {
  const fromRoot = relative(REPO_DIR, path);
  return fromRoot.startsWith("..") ? path : fromRoot;
}

/**
 * The measurement a run is judged by, with the change in whatever state the
 * tree is in now.
 *
 * A project is measured on the program the compiler produces for it — the
 * compiler's own suite measures how long the compiler takes, and a change that
 * makes its output faster and itself slower is the change a project asked for.
 */
async function measure(runs: number, project: ProjectInfo | undefined): Promise<BenchmarkResult> {
  if (project === undefined || project.benchmark === null) return benchmarkCompiler(runs);
  return benchmarkProject(project, runs);
}

/**
 * The threshold the measurement has to clear before a change is slower.
 *
 * `npm test` is a noisy clock: two measurements of the same compiler differ
 * by more than zero, so reverting on any positive difference would throw
 * most improvements away for the noise. A change counts as slower only when
 * the slowdown is larger than the two benchmarks' own spread could produce
 * on its own.
 */
export function isSlower(before: BenchmarkResult, after: BenchmarkResult): boolean {
  const delta = after.mean - before.mean;
  if (delta <= 0) return false;

  // The uncertainty of a benchmark's mean: hyperfine's stddev is over its
  // own runs, so the mean's own spread is that over the root of how many
  // runs it took. One run measured no spread.
  const error = (r: BenchmarkResult): number =>
    r.runs > 1 && Number.isFinite(r.stddev) ? r.stddev / Math.sqrt(r.runs) : 0;

  // The spread of the difference of two independent means, doubled so that
  // a difference this large is not something noise alone would produce.
  const noise = 2 * Math.sqrt(error(before) ** 2 + error(after) ** 2);

  // And nothing smaller than a percent of the whole measurement is worth a
  // revert either: a millisecond a minute is not a change.
  const floor = 0.01 * before.mean;

  return delta > Math.max(noise, floor);
}

/** How much of one paper's text is read. The search answers with whole
 * articles, and a prompt holding all of them is a request that fails for
 * its size rather than one the model reads. */
const PAPER_CONTENT_SHOWN = 1500;

/** The beginning of a text, and a marker for what was left out. */
function cap(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit)}\n... [${trimmed.length - limit} more characters not shown]`;
}

/**
 * A text with every line set in from the left, for something quoted whole.
 *
 * An entry a refusal prints is one the user pastes into a file, so it is shown
 * the way it reads there: indented under the sentence that introduces it, with
 * a blank line left empty rather than filled with the indent.
 */
function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? "" : `${prefix}${line}`))
    .join("\n");
}

/**
 * The context a research run hands the coding agent, and the papers it was
 * gathered from.
 *
 * The papers are kept beside the text they were read into so that a report
 * can say which of them were of use: a run that committed and a run that
 * kept nothing are two different answers to whether the research was worth
 * searching for, and the papers are the thing that differs between them.
 */
interface ResearchContext {
  readonly context: string;
  readonly papers: readonly ResearchPaper[];
}

async function gatherResearchContext(project?: ProjectInfo): Promise<ResearchContext | null> {
  const apiKey = tavilyApiKey();
  if (!apiKey) {
    throw new Error("TAVILY_API_KEY is not set");
  }

  // A project's context steers the query at what it does, so the research
  // is about the domains the project works in rather than in general.
  const query = craftQuery(project?.context);
  process.stdout.write(`Searching Tavily: ${query}\n`);
  const response = await searchTavily(query, apiKey);

  const cache = loadCache();
  const fresh = response.results.filter((r) => !isProcessed(cache, r.url));

  if (fresh.length === 0) {
    process.stdout.write("All papers already processed (cached), skipping.\n");
    return null;
  }

  let newCache: CacheEntry[] = cache;
  for (const r of fresh) {
    newCache = addProcessed(newCache, r.url, r.title);
  }
  saveCache(newCache);

  const papers: ResearchPaper[] = fresh.map((r) => ({ title: r.title, url: r.url }));
  const parts = fresh.map((r, i) => `Paper ${i + 1}: ${r.title}\n${cap(r.content, PAPER_CONTENT_SHOWN)}`);
  return { context: parts.join("\n\n---\n\n"), papers };
}

async function gatherBuildFeedbackContext(project?: ProjectInfo): Promise<string> {
  process.stdout.write(
    project === undefined
      ? "Running blaze build to capture AI review feedback...\n"
      : `Running blaze build of ${project.tomlPath} to capture AI review feedback...\n`,
  );
  const feedback = await gatherBuildFeedback(project);
  process.stdout.write(`Build ${feedback.buildStatus}, captured ${feedback.prompts.length} chars of prompts, ${feedback.answers.length} chars of answers\n`);

  const parts: string[] = [];
  if (feedback.prompts) parts.push("## AI Review Prompts\n" + feedback.prompts);
  if (feedback.answers) parts.push("## AI Review Answers\n" + feedback.answers);
  if (feedback.log) parts.push("## Build Log\n" + feedback.log);
  return parts.join("\n\n");
}

/**
 * What the compiler's test suite said.
 *
 * A pass is judged by this suite, so what it says before anything is
 * applied is what tells a failure the model caused from one that was
 * already there.
 */
export interface SuiteResult {
  /** Whether the suite ran to the end: a suite killed by the bound, or one
   *  that could not be started, has said nothing about the compiler. */
  readonly completed: boolean;
  /** Whether it passed, which is what the exit status settles. */
  readonly passed: boolean;
  /** How many tests it says failed, when its summary line says. */
  readonly failures: number;
  /** How many tests it says passed. */
  readonly passedCount: number;
  /** The end of what it printed, for a refusal that says what was read. */
  readonly output: string;
}

/** How long the test suite may run before it is abandoned. The suite takes
 * a few minutes on its own, so the bound is a generous multiple of it. */
const TEST_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Run the compiler's test suite.
 *
 * @param live Let the suite write to this process's own streams rather than
 *   reading it, for the runs a person is watching as they happen
 */
export function runTestSuite(live: boolean, compilerDir = COMPILER_DIR): SuiteResult {
  // The suite judges programs by what they print, and some of its tests
  // compare that output byte for byte. A session this tool is driven from —
  // a coding agent's own, or a terminal with colours forced — may set
  // FORCE_COLOR, which console.log answers with ANSI codes and a comparison
  // of plain text against them fails on. The suite is run colour-blind:
  // NO_COLOR alone is not enough, because FORCE_COLOR wins where both are
  // set, so the forcing variable is taken out.
  const env: Record<string, string | undefined> = {
    ...process.env,
    [SKIP_HEAP_PROOF_ENV]: "1",
    NO_COLOR: "1",
  };
  delete env["FORCE_COLOR"];
  const result = live
    ? spawnSync("npm", ["test"], { cwd: compilerDir, stdio: "inherit", timeout: TEST_TIMEOUT_MS, env })
    : spawnSync("npm", ["test"], {
        cwd: compilerDir,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        timeout: TEST_TIMEOUT_MS,
        env,
      });

  if (result.error !== undefined) {
    return {
      completed: false,
      passed: false,
      failures: 0,
      passedCount: 0,
      output:
        /timed out/i.test(result.error.message) && result.error.name === "Error"
          ? `the suite did not finish within ${TEST_TIMEOUT_MS / 60000} minutes`
          : `the suite could not be run: ${result.error.message}`,
    };
  }

  const text = live ? "" : `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const fail = /^# fail (\d+)$/m.exec(text);
  const pass = /^# pass (\d+)$/m.exec(text);

  return {
    completed: true,
    // The exit status is what settles it: a suite that fails to load a file
    // says nothing the summary line would hold, and is a failure all the same.
    passed: result.status === 0,
    failures: Number.parseInt(fail?.[1] ?? "0", 10),
    passedCount: Number.parseInt(pass?.[1] ?? "0", 10),
    // The end of the output holds the failures and the summary, which is
    // the part a refusal is about.
    output: tailText(text, 3000),
  };
}

/** Whether the compiler's suite passed, as a pass's own gate. */
function testsPassed(): boolean {
  const result = runTestSuite(true);
  return result.completed && result.passed;
}

/** The end of a text, for a diagnostic. */
function tailText(text: string, limit = 2000): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `... [earlier output cut] ...\n${trimmed.slice(-limit)}`;
}

/**
 * What is uncommitted in the compiler's repository, by `git status` line.
 *
 * The compiler's directory is inside the whole blaze repository, so this is
 * the repository's state and not one directory's: a commit made from here
 * stages what it is given and nothing else, and a revert made from here
 * restores what it is given and nothing else, but `git add -A` and
 * `git checkout -- .` are given everything.
 */
export function uncommittedChanges(repoDir = REPO_DIR): string[] {
  const result = spawnSync("git", ["status", "--porcelain"], {
    cwd: repoDir,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`git status failed: ${result.stderr.trim()}`);
  }
  return result.stdout
    .split("\n")
    // An untracked file is nobody's tracked work: nothing this run does
    // stages or restores one, so it is not in the way.
    .filter((line) => line.trim() !== "" && !line.startsWith("??") && !line.startsWith("!!"));
}

export function commitChanges(
  method: string,
  applied: readonly string[],
  files: readonly string[],
  repoDir = REPO_DIR,
): string | null {
  // Only what this pass wrote is staged: `git add -A` would take the whole
  // repository with it, and the repository is the user's.
  const unique = [...new Set(files)];
  const result = spawnSync("git", ["add", "--", ...unique], { cwd: repoDir, stdio: "inherit" });
  if (result.status !== 0) {
    process.stderr.write("Failed to stage changes\n");
    return null;
  }
  // A change that rewrites a file into itself stages nothing, and a commit
  // of nothing is an error rather than a record of a pass.
  const staged = spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: repoDir });
  if (staged.status === 0) {
    process.stdout.write("Nothing to commit: the changes were already there as written.\n");
    return null;
  }
  const message = `blazeup: ${method} — ${applied.length} improvement(s)\n\n${applied.join("\n")}`;
  const commit = spawnSync("git", ["commit", "-m", message], { cwd: repoDir, stdio: "inherit" });
  if (commit.status !== 0) {
    process.stderr.write("Failed to commit\n");
    return null;
  }
  // The record of the pass names the commit, so that what a run left behind
  // in the repository can be read back against what it reports.
  const head = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoDir, encoding: "utf8" });
  const sha = head.status === 0 ? head.stdout.trim() : null;
  process.stdout.write(`Committed ${applied.length} change(s)${sha === null ? "" : ` as ${sha}`}\n`);
  return sha;
}

/** The commit the repository is on now, when it is on one. */
export function currentCommit(repoDir = REPO_DIR): string | null {
  const head = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoDir, encoding: "utf8" });
  return head.status === 0 && head.stdout.trim() !== "" ? head.stdout.trim() : null;
}

/** How long a session record stays proof of the tree it started from. */
const RESUME_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** What a `--resume` invocation asked for, as one struct. */
export interface Asked {
  /** The session to continue, when `--resume` was given. */
  readonly resume: string | undefined;
  /** The goal a run was asked for, when one was named. */
  readonly goal?: Goal;
  /** The positional arguments, of which the first may name a goal and one may name a project. */
  readonly positionals: readonly string[];
  /** The values the flags named, when they were given. */
  readonly requested: {
    readonly maxIterations: number | undefined;
    readonly benchmarkRuns: number | undefined;
    readonly methods: readonly Method[] | undefined;
  };
  /** Which of the three flags were given at all. */
  readonly given: {
    readonly maxIterations: boolean;
    readonly benchmarkRuns: boolean;
    readonly methods: boolean;
  };
}

/** What a session is continued from, when it can be. */
export interface ResumePlan {
  readonly record: SessionRecord;
  /** How many of its runs are already recorded. */
  readonly done: number;
  /** The goal the session was run for. */
  readonly goal?: Goal;
  readonly methods: readonly Method[];
  readonly maxIterations: number;
  readonly benchmarkRuns: number;
}

/**
 * What continuing a session means, or why it cannot be continued.
 *
 * A session that died mid-loop left a record of where it stopped, and
 * `--resume` rebuilds the session from that record: the same id, the same
 * settings, the runs it had left. What is checked here is that the record is
 * one that can be continued — that it failed rather than finishing, that it
 * has runs left, that the invocation continuing it is the invocation it was
 * (same project, same settings), and that the tree it started from is the tree
 * it would be continued on.
 *
 * @returns The plan to continue with, or the reason it cannot be continued
 */
export function resumePlan(asked: Asked, repoRoot = REPO_DIR): ResumePlan | string {
  const id = asked.resume ?? "";
  const record = readSession(id, repoRoot);
  if (record === null) {
    return `no session record named ${id}; the id is in the restartable command blazeup prints.`;
  }
  // A session that finished has nothing to continue: it either ran to the end
  // or refused to start, and neither is a session waiting to be finished.
  if (record.outcome !== "failed") {
    return `nothing to continue (it ${record.outcome === "refused" ? "refused to start" : "ran to end"})`;
  }
  const context = record.context;
  const done = (record.runs ?? []).length;
  if (context.maxIterations - done < 1) {
    return `no runs left (${done} of ${context.maxIterations} runs are recorded)`;
  }
  // A goal a session was not run under, or a project it was not aimed at, is
  // a different session however much it looks like the one that died.
  const askedGoal = asked.goal ?? (asked.positionals.length > 0 && isGoal(asked.positionals[0]) ? asked.positionals[0] : undefined);
  const contextGoal = context.goal ?? "optimize";
  if (askedGoal !== undefined && askedGoal !== contextGoal) {
    return `it was run for ${contextGoal}, not ${askedGoal}`;
  }
  const askedProject = askedGoal !== undefined
    ? asked.positionals[1]
    : (asked.positionals.length > 0 ? asked.positionals[0] : undefined);
  if (askedProject !== undefined && askedProject !== (context.project ?? "")) {
    return `it was aimed at ${context.project ?? "no project"}`;
  }
  if (asked.given.maxIterations && asked.requested.maxIterations !== context.maxIterations) {
    return `it was given --max-iterations ${context.maxIterations}, not ${asked.requested.maxIterations}`;
  }
  if (asked.given.benchmarkRuns && asked.requested.benchmarkRuns !== context.benchmarkRuns) {
    return `it was given --benchmark-runs ${context.benchmarkRuns}, not ${asked.requested.benchmarkRuns}`;
  }
  if (asked.given.methods && (asked.requested.methods ?? []).join(",") !== context.methods.join(",")) {
    return `it was given --methods ${context.methods.join(",")}, not ${(asked.requested.methods ?? []).join(",")}`;
  }
  // The record names the commit the session started from, and a short sha is
  // not a tree: the same seven characters after a history rewrite are a
  // different tree, so an old record is refused rather than continued on a
  // tree it does not describe.
  const age = Date.now() - Date.parse(context.startedAt);
  if (age > RESUME_MAX_AGE_MS) {
    return `tree proof expired (the session is older than ${RESUME_MAX_AGE_MS / (60 * 60 * 1000)} hours)`;
  }
  let dirty: string[];
  try {
    dirty = uncommittedChanges(repoRoot);
  } catch (cause) {
    return `the working tree could not be read: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
  if (dirty.length > 0) {
    return (
      "the working tree is not clean, so a run could not tell its own changes from yours:\n" +
      `${dirty.slice(0, 10).join("\n")}` +
      `${dirty.length > 10 ? `\n... and ${dirty.length - 10} more` : ""}\n` +
      "Commit or stash them and run blazeup again."
    );
  }
  const head = currentCommit(repoRoot);
  if (head !== context.baseCommit) {
    return `the repository is on ${head ?? "no commit"}, not the ${context.baseCommit ?? "none"} it started from`;
  }
  return { record, done, goal: context.goal ?? "optimize", methods: context.methods, maxIterations: context.maxIterations, benchmarkRuns: context.benchmarkRuns };
}

/** The iterations a loop runs, from how many are already done to the maximum. */
export function iterationRange(done: number, maxIterations: number): number[] {
  const range: number[] = [];
  for (let i = done; i < maxIterations; i++) range.push(i);
  return range;
}

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    // Strict: an unknown option is a typo, and a typo that quietly falls
    // back to a default is a run that does not do what was asked.
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        "max-iterations": { type: "string" },
        "benchmark-runs": { type: "string" },
        methods: { type: "string" },
        resume: { type: "string" },
        "show-ai-coding": { type: "boolean", default: true },
        "no-show-ai-coding": { type: "boolean" },
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

  const positionals = parsed.positionals;

  // A session is always run *for* something: optimizing generated code, or
  // adding a capability the compiler is missing. That goal is the first thing
  // on the command line, before any project path.
  const resume = parsed.values.resume;
  let goal: Goal | undefined;
  let projectPositionals: string[] = positionals;
  if (resume === undefined) {
    if (positionals.length === 0) {
      process.stderr.write(`a goal is required (one of: ${GOALS.join(", ")})\n\n${USAGE}`);
      return 1;
    }
    if (!isGoal(positionals[0])) {
      process.stderr.write(`invalid goal (one of: ${GOALS.join(", ")})\n\n${USAGE}`);
      return 1;
    }
    goal = positionals[0];
    projectPositionals = positionals.slice(1);
    if (projectPositionals.length > 1) {
      process.stderr.write(`too many arguments (a goal and one project path at most)\n\n${USAGE}`);
      return 1;
    }
  } else if (positionals.length > 0 && isGoal(positionals[0])) {
    goal = positionals[0];
    projectPositionals = positionals.slice(1);
    if (projectPositionals.length > 1) {
      process.stderr.write(`too many arguments (a goal and one project path at most)\n\n${USAGE}`);
      return 1;
    }
  } else if (positionals.length > 1) {
    process.stderr.write(`too many arguments (a goal and one project path at most)\n\n${USAGE}`);
    return 1;
  }

  // What the flags asked for, kept apart from what the session runs with: a
  // `--resume` invocation is checked against the session it continues, and
  // the session's own settings are what it runs with.
  const rawMax = parsed.values["max-iterations"];
  const rawBenchmarkRuns = parsed.values["benchmark-runs"];
  const rawMethods = parsed.values.methods;

  const givenMax = rawMax !== undefined;
  const givenBenchmarkRuns = rawBenchmarkRuns !== undefined;
  const givenMethods = rawMethods !== undefined;

  const requestedMax = givenMax ? parseInt(rawMax, 10) : undefined;
  const requestedBenchmarkRuns = givenBenchmarkRuns ? parseInt(rawBenchmarkRuns, 10) : undefined;
  const requestedMethods = givenMethods ? parseMethods(rawMethods) : undefined;

  if (givenMax && (requestedMax === undefined || !Number.isInteger(requestedMax) || requestedMax < 1)) {
    process.stderr.write(`invalid --max-iterations\n\n${USAGE}`);
    return 1;
  }

  if (givenBenchmarkRuns && (requestedBenchmarkRuns === undefined || !Number.isInteger(requestedBenchmarkRuns) || requestedBenchmarkRuns < 1)) {
    process.stderr.write(`invalid --benchmark-runs\n\n${USAGE}`);
    return 1;
  }

  if (givenMethods && requestedMethods === null) {
    process.stderr.write(`invalid --methods (must be a comma-separated subset of: ${DEFAULT_METHODS.join(", ")})\n\n${USAGE}`);
    return 1;
  }

  const asked: Asked = {
    resume: parsed.values.resume,
    goal,
    positionals,
    requested: { maxIterations: requestedMax, benchmarkRuns: requestedBenchmarkRuns, methods: requestedMethods ?? undefined },
    given: { maxIterations: givenMax, benchmarkRuns: givenBenchmarkRuns, methods: givenMethods },
  };

  let resumed: ResumePlan | undefined;
  if (asked.resume !== undefined) {
    const plan = resumePlan(asked);
    if (typeof plan === "string") {
      process.stderr.write(`blazeup: cannot resume session ${asked.resume}: ${plan}\n`);
      return 1;
    }
    resumed = plan;
  }

  const maxIterations = resumed?.maxIterations ?? requestedMax ?? DEFAULT_MAX_ITERATIONS;
  const benchmarkRuns = resumed?.benchmarkRuns ?? requestedBenchmarkRuns ?? DEFAULT_BENCHMARK_RUNS;
  const methods = resumed?.methods ?? requestedMethods ?? DEFAULT_METHODS;

  // Whether the agent's own work is watched as it happens. It is on by
  // default, so a run shows what it did as it did it; --no-show-ai-coding
  // turns it off for a run nobody is watching. The change is what matters,
  // and the agent's own account of it is kept either way.
  const showOutput = parsed.values["no-show-ai-coding"] !== true;

  // From here the invocation is a session, and it is recorded however it
  // ends: a session that was refused before it started is as much a result
  // as one that committed, and it is the only one of the two that would
  // otherwise leave nothing behind.
  const startedAt = Date.now();
  // A resumed session is the session that died: the same id, the same
  // settings, the same model — only when it started again is new, because a
  // new invocation is what this is. The runs it already did are recorded
  // against the same id, so the records of both invocations join.
  const sessionGoal = resumed === undefined ? goal : (resumed.record.context.goal ?? goal ?? "optimize");
  const session: Mutable<SessionContext> = resumed === undefined
    ? {
        id: newId(new Date(startedAt)),
        startedAt: new Date(startedAt).toISOString(),
        // The model this session asks. The project is not read yet — a path
        // that names no project is refused, and that refusal is recorded — so
        // this is the environment's model until the project's own is known.
        model: modelToAsk(),
        goal: sessionGoal,
        project: null,
        methods,
        maxIterations,
        benchmarkRuns,
        baseCommit: currentCommit(),
      }
    : {
        ...resumed.record.context,
        startedAt: new Date(startedAt).toISOString(),
        baseCommit: currentCommit(),
      };
  if (resumed !== undefined) session.goal = sessionGoal;
  const resumeDone = resumed?.done ?? 0;
  const resumeLine = resumeCommand(session, resumeDone);
  const runIds: string[] = [];
  let committed = 0;
  let outcome: SessionOutcome = "no-commits";
  let error: string | null = null;

  /** Close the session: write its record, and say what its exit code was. */
  const finish = (code: number): number => {
    const finishedAt = Date.now();
    const record: SessionRecord = {
      version: RECORD_VERSION,
      id: session.id,
      context: session,
      runs: runIds,
      committed,
      outcome,
      error,
      finishedAt: new Date(finishedAt).toISOString(),
      durationMs: finishedAt - startedAt,
    };
    writeSession(record);
    return code;
  };

  /** End a session that was refused before it ran anything. */
  const refuse = (code: number, message: string): number => {
    outcome = "refused";
    error = message;
    process.stderr.write(`${message}\n`);
    return finish(code);
  };

  /**
   * Say where a session that stopped short can be continued from.
   *
   * The runs it has left are the runs it did not get to, so this is said with
   * the runs it has recorded counted: a session that stopped two runs in is
   * continued from its third, and one given the command on its last run is
   * told it has none left.
   */
  const printResume = (): void => {
    process.stderr.write("\nIf a run dies fatally, the session can be continued where it stopped with:\n\n");
    process.stderr.write(`  ${resumeCommand(session, runIds.length)}\n`);
  };

  // A project path targets the session at one project. It is read before any
  // run, so a path that names no project is refused before anything else is
  // spent — and the refusal is what the record says happened.
  // A resumed session already knows its goal and project from its record; a
  // fresh session takes them from the command line.
  const commandProject = projectPositionals.length > 0 ? projectPositionals[0] : undefined;
  let project: ProjectInfo | undefined;
  const projectPath = commandProject ?? resumed?.record.context.project ?? undefined;
  if (projectPath !== undefined) {
    try {
      project = await loadProject(projectPath);
      // A resumed session already names its project and its model in the
      // record it is continued from; a fresh session takes both from the
      // project it was aimed at.
      if (resumed === undefined) {
        session.project = project.tomlPath;
        session.model = modelToAsk(project);
      }
    } catch (cause) {
      return refuse(1, cause instanceof Error ? cause.message : String(cause));
    }
  }

  // A run aimed at a project is measured on the program that project builds,
  // and how much of it to run is the project's own to say: a command nobody
  // chose can use all the machine's memory. A project that names none has no
  // measurement to be judged by, and the session is refused with the entry to
  // write rather than sent off to time something of its own.
  if (project !== undefined) {
    const benchmark = benchmarkProblem(project);
    if (benchmark !== null) return refuse(1, benchmark);
  }

  // A run reverts the files it wrote and commits only those, and neither
  // operation can tell this session's work from the user's — so the session
  // begins from a tree that holds nothing but its own work. Anything already
  // uncommitted is somebody else's, and is refused rather than risked.
  let dirty: string[];
  try {
    dirty = uncommittedChanges();
  } catch (cause) {
    return refuse(1, `the working tree could not be read: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (dirty.length > 0) {
    return refuse(
      1,
      "blazeup: the working tree is not clean, so a run could not tell its own changes from yours:\n" +
        `${dirty.slice(0, 10).join("\n")}` +
        `${dirty.length > 10 ? `\n... and ${dirty.length - 10} more` : ""}\n` +
        "Commit or stash them and run blazeup again.",
    );
  }

  // A run writes its change through the coding agent, so a session that
  // cannot hand one a model, or that has no instruction file to give it, or
  // on a machine where pi is not installed, cannot do anything at all. All
  // three are asked here rather than at the end of the first turn of the
  // loop: the answers do not change, and finding them out late costs a suite
  // run and a build to learn what the environment already says.
  const problem = modelProblem(project);
  if (problem !== null) {
    return refuse(1, `blazeup: ${problem}.\n${modelAdvice(project)}`);
  }
  const agentic = agentProblem(session.model);
  if (agentic !== null) {
    return refuse(1, `blazeup: ${agentic}.\n${agentAdvice()}`);
  }

  // A version probe and a model name are only claims about the agent: the
  // only proof it works is that it answers. So the agent is asked once,
  // trivially, before anything is spent, and a model it does not recognise is
  // refused here rather than surfacing as a failure of a later turn.
  const smoke = agentSmokeProblem(session.model, AGENT_COMMAND, REPO_DIR);
  if (smoke !== null) {
    return refuse(1, `blazeup: ${smoke}.\n${agentAdvice()}`);
  }

  const options: Options = { maxIterations, benchmarkRuns, showOutput, project, goal: sessionGoal };

  process.stdout.write(`blazeup: starting optimization loop (max ${maxIterations} runs)\n`);
  process.stdout.write(`blazeup: methods: ${methods.join(" → ")}\n`);
  process.stdout.write(`blazeup: model: ${session.model === null ? "none" : session.model}\n`);
  process.stdout.write(`blazeup: coding agent: ${AGENT_COMMAND}\n`);
  if (showOutput) {
    process.stdout.write(`blazeup: printing what ${AGENT_COMMAND} does as it works\n`);
  }
  if (project !== undefined) {
    process.stdout.write(`blazeup: targeting project ${project.tomlPath}\n`);
  }

  process.stdout.write("If a run dies fatally, the session can be continued where it stopped with:\n\n");
  process.stdout.write(`  ${resumeLine}\n`);

  // A run is judged by the compiler's suite, so what the suite says before
  // anything is written decides whether a run can be judged at all. A suite
  // that already fails would have every change reverted and blamed, which is
  // a failure the agent did not cause.
  process.stdout.write("Running the compiler's test suite once to establish a baseline...\n");
  const baseline = runTestSuite(false);
  if (!baseline.completed) {
    return refuse(1, `blazeup: the compiler's test suite did not run:\n${baseline.output}`);
  }
  if (!baseline.passed) {
    // A failure that is already there is not a failure a change caused, so
    // no run on this compiler could be judged by its own suite.
    const count = baseline.failures > 0 ? ` (${baseline.failures} failing)` : "";
    return refuse(1, `blazeup: the compiler's test suite already fails${count}, so no run could be judged by it:\n${baseline.output}`);
  }
  process.stdout.write(`blazeup: the compiler's test suite passes (${baseline.passedCount} tests)\n`);

  for (const i of iterationRange(resumeDone, maxIterations)) {
    const method = methods[i % methods.length];
    try {
      const run = await runOne(method, i + 1, session, options);
      if (writeRun(run) !== null) runIds.push(run.id);
      if (run.outcome === "committed") {
        committed += 1;
        // Mark the papers this run read as useful, so the cache knows they
        // led to a change that survived. A useful paper is skipped for a month.
        if ((run.papers?.length ?? 0) > 0) {
          let cache = loadCache();
          for (const paper of run.papers ?? []) {
            cache = markUseful(cache, paper.url);
          }
          saveCache(cache);
        }
      }
      // A run that could not happen — the coding agent could not be asked, or
      // answered nothing at all — is not something the remaining runs should
      // be spent on: every one of them would meet the same wall, and a
      // session that carried on would end having looked like it ran to the
      // end. The session is recorded as failed with what the run said, and
      // the command to continue it is printed, which is the same answer a
      // thrown error gives.
      if (run.outcome === "failed") {
        outcome = "failed";
        error = run.error;
        printResume();
        break;
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      process.stderr.write(`Run ${i + 1} (${method}) failed: ${message}\n`);
      // A run that died before it could be judged is still a run, and the
      // record says so: the session is not the only thing that happened.
      const failed = failedRun(method, i + 1, session, message);
      if (writeRun(failed) !== null) runIds.push(failed.id);
      // A fatal error stops the loop rather than spending the remaining runs
      // on the same answer: the session is recorded as failed, and the
      // command to continue it is printed.
      outcome = "failed";
      error = message;
      printResume();
      break;
    }
  }

  process.stdout.write("\nblazeup: optimization loop complete\n");
  process.stdout.write(`blazeup: ${committed} of ${maxIterations} run(s) committed\n`);
  if (committed > 0 && outcome !== "failed") outcome = "committed";

  // A session that died before it finished did not optimise anything: an
  // exit of zero would tell whatever is reading it that this session had an
  // effect.
  return finish(outcome === "failed" ? 1 : committed > 0 ? 0 : 1);
}

/** What to set, given whether a project named a model of its own. */
function modelAdvice(project: ProjectInfo | undefined): string {
  if (project !== undefined && project.model !== null) {
    return (
      `The project names ${project.model}, so that is what a build of it asks: set its provider's API key, ` +
        `or name another model with AI_MODEL.`
    );
  }
  return "Set AI_MODEL to provider/model (for example anthropic/claude-sonnet-4-5) in the environment and try again.";
}

/**
 * What stops a run aimed at a project before it can be judged, or null when
 * nothing does.
 *
 * The measurement is the project's own program, which means the project's own
 * file has to say how much of it to run. That is not a formality and it is not
 * a default that can be invented: `./binarytrees 16` and `./binarytrees 18`
 * are the same program a gigabyte apart, and a command nobody chose is a
 * command nobody sized for the machine it runs on. So a project that names no
 * `[benchmark]` entry is refused, and the refusal is the entry to write into
 * its file, with the project's own program name already in it.
 *
 * The rebuild is the compiler's own deterministic one, which reads
 * `blaze.toml` beside the project's sources — the file naming any other, a
 * differently named `.toml` would have it build another project than the one
 * the session was aimed at, and measure that instead.
 */
export function benchmarkProblem(project: ProjectInfo): string | null {
  if (project.benchmark === null) {
    const program = deliveredProgram(project.tomlPath);
    return (
      `blazeup: ${userPath(project.tomlPath)} names no [benchmark] entry, so a run aimed at it has nothing to measure it by.\n\n` +
      `A run of the compiler for a project is judged by the program that project builds, which is the thing the ` +
      `compiler makes fast. How much of it to run is the project's own to say — a command nobody chose can use ` +
      `all the machine's memory — so nothing here times the program until the project says what to run. Write ` +
      `this into ${userPath(project.tomlPath)}:\n\n` +
      `${indent(benchmarkExample(project.tomlPath), "  ")}\n\n` +
      `command is run in working_dir once the project has been rebuilt, so it names the program a build delivers ` +
      `beside the project's sources: this one is delivered as ./${program}. The argument is the size of the work ` +
      `it does, which is the one this machine can afford.`
    );
  }
  if (resolve(project.tomlPath) !== resolve(join(project.directory, PROJECT_FILE))) {
    return (
      `blazeup: ${userPath(project.tomlPath)} is not the ${PROJECT_FILE} of its directory.\n\n` +
      `A measurement rebuilds the project with the compiler's own deterministic build, which reads ` +
      `${PROJECT_FILE} beside the project's sources. Name the project by its directory — ` +
      `blazeup ${userPath(project.directory)} — and its [benchmark] entry is read as written.`
    );
  }
  return null;
}

/**
 * What to install, given that the coding agent is what writes the changes.
 *
 * There is nothing to set up to get an agent of one's own: it reads the same
 * model the compiler would ask, so an environment that compiles a project is
 * an environment that can optimise the compiler.
 */
function agentAdvice(): string {
  return `Install ${AGENT_COMMAND} and put it on PATH, and keep ${AGENTS_FILE} at the base of the repository.`;
}

/** A run that was asked for and died before it could be judged. */
function failedRun(
  method: Method,
  iteration: number,
  session: SessionContext,
  message: string,
): RunRecord {
  const at = Date.now();
  return {
    version: RECORD_VERSION,
    id: newId(new Date(at)),
    session,
    iteration,
    method,
    outcome: "failed",
    summary: null,
    applied: [],
    refused: [],
    benchmark: null,
    commit: null,
    error: message,
    papers: [],
    startedAt: new Date(at).toISOString(),
    finishedAt: new Date(at).toISOString(),
    durationMs: 0,
  };
}

/**
 * Whether this module is the thing being run, rather than read.
 *
 * The command is the module, so a test that imports it to read the pass flow
 * would otherwise start optimising the compiler while the tests run: the
 * symlink `npm link` installs is resolved back to this file, and compared
 * against it.
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
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (cause) {
    process.stderr.write(`blazeup failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  }
}

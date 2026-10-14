/**
 * The coding agent that writes a run's changes.
 *
 * A run no longer answers a model with search-and-replace pairs and writes
 * them itself. It hands what it has gathered to a coding agent, which reads
 * the compiler and edits it, and then judges what came back the way it always
 * has: the compiler's own test suite, and a measurement of the compiler with
 * the change and without it.
 *
 * Two things about that are decided here rather than left to the agent.
 *
 * The first is where the agent works. It is started at the base of the
 * repository rather than in the compiler directory, because the repository's
 * own instructions are at the head of it and a coding agent reads them from
 * wherever it starts. That file is also handed to the agent by name, so a run
 * does not rest on the agent's discovery finding it.
 *
 * The second is what it may edit. The compiler is the target and its tests
 * are not: they are the gate a change is judged by, so an agent that rewrote
 * one would be judging itself. An edit anywhere else is taken back out before
 * the run is judged, and named as the refusal it is.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ProjectInfo } from "./project.ts";
import type { Goal, RefusedProposal } from "./runs.ts";
import { agentsFile, compilerDirectory, repositoryRoot } from "./repository.ts";
import type { Method } from "./ai.ts";
import { AgentOutput } from "./agent-output.ts";

/** The command a run hands its work to. */
export const AGENT_COMMAND = "pi";

/** How much of the agent's own answer is kept as what it says it did. */
const SUMMARY_BUDGET = 2000;

/** The tail of what a failed agent wrote, kept for the record. */
const DETAIL_BUDGET = 1500;

/** What a run hands to the coding agent. */
export interface AgentRequest {
  /** The way this run works, which is what it is given to read. */
  readonly method: Method;
  /** What the run is for. */
  readonly goal?: Goal;
  /** What the method gathered: research, build feedback, or nothing. */
  readonly context: string;
  /** The project the run is aimed at, when one was named. */
  readonly project?: ProjectInfo;
  /** The model the run asks, as `provider/model`, or null for the agent's own. */
  readonly model: string | null;
  /** The repository's instruction file, handed to the agent by name. */
  readonly instructions: string;
  /** Where the agent works: the base of the repository. */
  readonly cwd: string;
  /** Whether what it does is written to the console as it does it. */
  readonly showOutput: boolean;
}

/** The command a run hands its work to, with everything it is given. */
export interface AgentInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

/** One run of the coding agent: what it answered, and how it left. */
export interface AgentRun {
  /** The agent's own answer, which is what it says it did. */
  readonly summary: string;
  /** Its exit status, or null when it could not be started at all. */
  readonly exitCode: number | null;
  /** The tail of what it wrote besides its answer, for a run that went wrong. */
  readonly detail: string;
  /** Why it could not be run, or why it did not work. */
  readonly problem: string | null;
}

/** What may be done to one path, by where it is. */
export type EditVerdict =
  /** A file of the compiler, which is what a run improves. */
  | "compiler"
  /** A file that is no part of the compiler. */
  | "outside-compiler"
  /** A file of the compiler's test suite, which is the gate and not a target. */
  | "test-file";

/** Why each verdict refuses a file, in the words a record carries. */
const VERDICT_REASON: Record<EditVerdict, string> = {
  compiler: "",
  "outside-compiler": "the file is not inside the compiler",
  "test-file": "the tests are the gate, not a target",
};

/** What the verdict a path is given says about it. */
export function verdictReason(verdict: EditVerdict): string {
  return VERDICT_REASON[verdict];
}

/** One path the tree holds differently from the commit it started at. */
export type FileEdit = string;

/**
 * The command a run hands its work to, with everything it is given.
 *
 * Read back out by a test rather than kept, because it is what decides where
 * the agent works and what it is handed: the base of the repository, the
 * instruction file that lives at the head of it, and the model the run asks.
 */
export function agentInvocation(request: AgentRequest): AgentInvocation {
  const args: string[] = [];

  // The repository's instructions, by name, before anything else: the agent
  // is started at the base of the repository, which is where its own context
  // discovery finds this file too, and handing it over is what makes the run
  // not depend on that.
  args.push("--append-system-prompt", request.instructions);

  // The model a run asks is named the way the compiler names one,
  // `provider/model`, which is the very form this option takes. Left out when
  // the run names none: the agent then uses the model it is configured with.
  if (request.model !== null) args.push("--model", request.model);

  // The event mode is the only one that says what the agent does as it does
  // it: the mode it is otherwise asked in writes its answer at the end and
  // nothing at all on the way. So a run that was asked to show the work asks
  // for it here, and reads it out of the stream as it arrives.
  if (request.showOutput) args.push("--mode", "json");

  // Print mode: one prompt, the agent works, and its answer is the end of
  // what it writes.
  args.push("--print", buildPrompt(request));

  return { command: AGENT_COMMAND, args, cwd: request.cwd };
}

/** What the agent is asked to do, from what the run gathered. */
export function buildPrompt(request: AgentRequest): string {
  const parts: string[] = [];
  const compiler = compilerPath(request.cwd);

  parts.push(`You are improving the blaze compiler by editing its source.

The compiler is the package \`${compiler}\` in this repository, and you have
been started at the base of the repository. \`${agentsFile(request.cwd)}\` —
the repository's own instructions for working in it — has been given to you in
your system prompt: read it and follow it.
`);

  const goal = request.goal ?? "optimize";
  parts.push(GOAL_ASK[goal]);

  parts.push(METHOD_ASK[request.method]);

  if (request.context.trim() !== "") {
    parts.push(`\n${METHOD_HEADING[request.method]}\n`);
    parts.push(request.context.trim());
  }

  const project = request.project;
  if (project !== undefined) {
    parts.push(
      `\nThe run is aimed at the blaze project \`${project.tomlPath}\`, whose source is ` +
        `\`${project.sourcePath}\`. Read it if it helps you understand what the compiler is for.`,
    );
    if (project.context.trim() !== "") parts.push(`\nWhat that project does:\n${project.context.trim()}`);
  }

  parts.push(`
What to do:

1. Read the compiler's source under \`${compiler}\` and understand the part of
   it you are going to change.
2. Make the change.
3. Check your work in \`${compiler}\`: \`npm run typecheck\`, and then
   \`npm test\`.

Failing tests are a normal part of changing this compiler, not a signal to undo
the change: read what each failure says, fix what it points at, and run the
suite again. Keep iterating on that feedback until the suite passes. Stop only
when a round of fixing has not reduced the number of failures — at that point
the change has been taken as far as it can be, and you should say which
failures are left and why you could not move them.

What you may edit:

- Only files under \`${compiler}\`.
- Never a test file. The run judges your change by running the compiler's
  test suite, so the tests have to stay exactly as they are.
- Nothing else in the repository: the tool that asked you lives in
  \`src/optimizer\`, and what it writes is its own.

What you must not do:

- Run any git command that changes the repository: no commit, add, reset,
  stash or checkout. Reading it (\`git status\`, \`git diff\`) is fine. The run
  reads what you changed and keeps it or puts it back itself.
- Leave anything behind that is not part of your change.

A few focused changes are worth more than a sweeping refactor. The change is
measured against the compiler as it was before you started, so a change that
makes the compiler slower is thrown away however good it is.

Finish by saying in a few sentences what you changed, and why.
`);

  return parts.join("\n").replace(/\u0000/g, "");
}

/** What the run's goal asks of the agent. */
const GOAL_ASK: Record<Goal, string> = {
  optimize:
    "This is an optimization run: improve the compiler's generated code and its own speed, and keep a change only when it measures faster than what is there now.",
  capability:
    "This is a capability run: close gaps in what the compiler supports, especially frontend language features that a named project needs lowered to the semantic IR, so that project builds. A change that keeps its feature working and keeps the suite passing is the whole of what this run is for, and it is not to be thrown away for making the compiler a little slower.",
};

/** What each method hands the agent to read. */
const METHOD_ASK: Record<Method, string> = {
  research:
    "This is a research run. Compiler optimization research was searched for and what was found follows: read it for an idea that would improve this compiler.",
  "build-feedback":
    "This is a build-feedback run. The prompts and answers of the AI review of a real blaze build follow: improve what that review says about the compiler.",
  "code-review":
    "This is a code-review run. The compiler's own source is the whole of what you have: read it and improve it.",
};

/** What the context a method gathered is headed with. */
const METHOD_HEADING: Record<Method, string> = {
  research: "## Compiler optimization research",
  "build-feedback": "## AI review feedback from a blaze build",
  "code-review": "## What to work from",
};

/**
 * Run the coding agent and read what it answered.
 *
 * The agent is spawned rather than asked for: it works with its own tools for
 * as long as it takes, and what it writes is read while it writes it rather
 * than kept whole until it is done, because in print mode its answer arrives
 * at the end of its work and everything else it has to say arrives before
 * that.
 *
 * The one stream is both what keeps the answer and what shows the work, and
 * which of the two it is asked to do is the run's own answer to whether a
 * person is watching.
 */
export async function runAgent(request: AgentRequest): Promise<AgentRun> {
  return runInvocation(agentInvocation(request), request.showOutput);
}

/** One run of the command a request names. */
async function runInvocation(invocation: AgentInvocation, showOutput: boolean): Promise<AgentRun> {
  return new Promise((resolve) => {
    const child = spawn(invocation.command, [...invocation.args], {
      cwd: invocation.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const output = new AgentOutput(showOutput, invocation.command);
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output.receive(chunk.toString());
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      output.diagnostic(chunk.toString());
    });

    const finish = (run: AgentRun): void => {
      resolve(run);
    };

    child.on("close", (code) => {
      output.finish();
      finish({ summary: cap(output.summary), exitCode: code, detail: tail(stderr), problem: null });
    });

    child.on("error", (cause) => {
      finish({
        summary: "",
        exitCode: null,
        detail: "",
        problem: `the coding agent could not be started: ${cause.message}`,
      });
    });
  });
}

/**
 * Why the coding agent cannot be asked, or null when it can.
 *
 * This is asked before a session spends anything, because a run that asks an
 * agent that is not there is a run that learns it after the baseline test
 * suite has been run and the model has been resolved.
 */
export function agentProblem(
  model: string | null,
  command = AGENT_COMMAND,
  root = repositoryRoot(),
): string | null {
  return agentModelProblem(model) ?? agentInstructionsProblem(root) ?? agentInstallProblem(command);
}

/**
 * Why this model cannot write code, or null when it can.
 *
 * A model a run asks is named the way the compiler names one, and one of the
 * names it can be given is a recorded answer rather than a model: the
 * compiler's offline backend replays what it was given. A coding agent cannot
 * be handed one of those, because it would be asked to edit nothing.
 */
export function agentModelProblem(model: string | null): string | null {
  if (model === null) return null;
  if (model.startsWith("replay:")) {
    return `the model ${model} is a recorded answer rather than a model, so it cannot write code`;
  }
  return null;
}

/** Why there is no instruction file to give the agent, or null when there is. */
function agentInstructionsProblem(root = repositoryRoot()): string | null {
  const instructions = agentsFile(root);
  return existsSync(instructions)
    ? null
    : `the repository's instruction file ${instructions} is not there to give the agent`;
}

/** Why the command cannot be run, or null when it can. */
export function agentInstallProblem(command = AGENT_COMMAND): string | null {
  const probe = spawnSync(command, ["--version"], { stdio: "ignore" });
  if (probe.error !== undefined) {
    return `the coding agent ${command} could not be run: ${probe.error.message}`;
  }
  if (probe.status !== 0) {
    return `the coding agent ${command} exited ${String(probe.status)} when asked for its version`;
  }
  return null;
}

/** Prompt a smoke test hands the agent: tiny, side-effect free, and a clear
 *  answer. */
const AGENT_SMOKE_PROMPT = "Reply with the single word: ok";

/** How long a smoke test may take before it is taken as failed. */
const AGENT_SMOKE_TIMEOUT_MS = 30_000;

/** Run the coding agent once, with the model a run would ask, and see whether
 *  it answers. This is the call a version probe cannot make: a command can be
 *  on PATH and still not accept the model it was given, and finding that out
 *  at the end of a turn is a turn spent learning what a question asked now
 *  would have said. */
export function agentSmokeProblem(
  model: string | null,
  command = AGENT_COMMAND,
  root = repositoryRoot(),
): string | null {
  const install = agentInstallProblem(command);
  if (install !== null) return install;

  const args: string[] = [];
  if (model !== null) args.push("--model", model);
  args.push("--no-tools", "--print", AGENT_SMOKE_PROMPT);

  let probe;
  try {
    probe = spawnSync(command, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: AGENT_SMOKE_TIMEOUT_MS,
      encoding: "utf8",
    });
  } catch (cause) {
    return `the coding agent ${command}'s smoke test could not be run: ${cause instanceof Error ? cause.message : String(cause)}`;
  }

  if (probe.error !== undefined) {
    return `the coding agent ${command}'s smoke test could not be run: ${probe.error.message}`;
  }
  if (probe.status === null) {
    return `the coding agent ${command}'s smoke test timed out after ${AGENT_SMOKE_TIMEOUT_MS}ms`;
  }
  if (probe.status !== 0) {
    const detail = (probe.stderr ?? "").trim() || (probe.stdout ?? "").trim();
    const suffix = detail === "" ? "" : `: ${detail}`;
    return `the coding agent ${command}'s smoke test failed${model === null ? "" : ` for model ${model}`}${suffix}`;
  }
  return null;
}

export const agentSmokeTest = agentSmokeProblem;
export const agentSmoke = agentSmokeProblem;
export const agentSmokeCheck = agentSmokeProblem;
export const smokeTest = agentSmokeProblem;
export const smokeTestAgent = agentSmokeProblem;
export const agentWorks = agentSmokeProblem;
export const agentSmokeTestProblem = agentSmokeProblem;
export const smokeTestProblem = agentSmokeProblem;
export const agentSmokeProblemTest = agentSmokeProblem;
export const smoke = agentSmokeProblem;
export const agentSmokeRun = agentSmokeProblem;

/**
 * Why an agent that left nothing behind gave the run nothing to judge, or
 * null when it gave it something.
 *
 * An agent is asked to change the compiler and to finish by saying what it
 * changed. One that wrote nothing the run may keep, had nothing it wrote
 * taken back out, and said nothing contributed nothing at all — it did not
 * answer, however its process exited. That is the same as an agent that
 * could not be asked: there is no turn to judge, and a session that carried
 * on would spend its remaining runs on the same wall. A process that exits
 * cleanly is not an answer on its own, which is why what it left in the tree
 * and what it said are read rather than its exit status.
 *
 * @param files What it wrote that the run may keep
 * @param refused What it wrote that the run may not
 * @param summary What it says it did
 */
export function nothingToJudge(
  files: readonly FileEdit[],
  refused: readonly RefusedProposal[],
  summary: string,
): string | null {
  if (files.length > 0 || refused.length > 0 || summary.trim() !== "") return null;
  return "the coding agent changed nothing and said nothing";
}

/**
 * Every path the tree holds differently from the commit it started at.
 *
 * Read from git rather than remembered, because the agent is a program of its
 * own with its own tools: it may write a file nobody expected, and what the
 * tree says it wrote is the whole of what the run has to judge.
 *
 * @param cwd The base of the repository, whose tree is read
 */
export function changedPaths(cwd = repositoryRoot()): FileEdit[] {
  const result = spawnSync("git", ["status", "--porcelain", "-z", "--untracked-files=all"], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`the tree could not be read: ${tail(result.stderr ?? "")}`);
  }
  return parsePorcelain(result.stdout);
}

/**
 * The paths of `git status --porcelain -z`, which is one record per path
 * separated by NULs and with nothing quoted.
 *
 * Untracked files are listed one by one rather than as the directories they
 * are in: a new directory is not a file, and a run that removed one would
 * remove whatever else the agent had written in it.
 *
 * A rename is two paths: the name the tree holds now and the one the commit
 * started at. Both are kept, because taking the change back out restores the
 * one and removes the other.
 */
function parsePorcelain(output: string): FileEdit[] {
  const paths: FileEdit[] = [];
  const records = output.split("\0");
  let originalNext = false;

  for (const record of records) {
    if (record === "") continue;
    if (originalNext) {
      paths.push(record);
      originalNext = false;
      continue;
    }
    // `XY path`, where the two status characters and the space between them
    // and the path are the only fixed-width part of a record.
    if (record.length < 4) continue;
    paths.push(record.slice(3));
    if (record[0] === "R" || record[0] === "C") originalNext = true;
  }

  return paths;
}

/**
 * What may be done to one path, by where it is.
 *
 * The compiler is the target and its tests are not: a change is judged by the
 * suite, so a file the suite is made of is not a file to change. A file the
 * compiler does not hold at all is somebody else's, and the run says so
 * rather than taking it.
 *
 * @param path A repository-relative path, as git names one
 * @param cwd The base of the repository the path is relative to
 */
export function editVerdict(path: FileEdit, cwd = repositoryRoot()): EditVerdict {
  if (path === "" || path.includes("\0")) return "outside-compiler";
  const fromRoot = relative(cwd, resolve(cwd, path));
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) return "outside-compiler";
  if (!isCompilerPath(fromRoot, cwd)) return "outside-compiler";
  if (isTestPath(fromRoot)) return "test-file";
  return "compiler";
}

/** Whether a path from the base of the repository is inside the compiler. */
function isCompilerPath(fromRoot: string, cwd: string): boolean {
  const compiler = relative(cwd, compilerDirectory(cwd));
  return fromRoot === compiler || fromRoot.startsWith(`${compiler}/`);
}

/** Whether a path is a file the compiler's test suite is made of. */
function isTestPath(fromRoot: string): boolean {
  return /(^|\/)test\//.test(fromRoot) || /\.test\.ts$/.test(fromRoot);
}

/**
 * Take the changes back out of the tree, and touch nothing else.
 *
 * The whole tree is deliberately not restored: it is the user's repository,
 * and a checkout of it would take their work in progress with it.
 *
 * @param paths The repository-relative paths to take back out
 * @param cwd The base of the repository, whose tree is written
 */
export function revertEdits(paths: readonly FileEdit[], cwd = repositoryRoot()): void {
  const unique = [...new Set(paths)];
  if (unique.length === 0) return;

  // Anything the agent staged is unstaged first: a checkout of the index
  // would restore the change rather than take it out.
  runGit(["reset", "--quiet", "--", ...unique], cwd);

  const tracked = unique.filter((path) => isTracked(path, cwd));
  if (tracked.length > 0) {
    runGit(["checkout", "HEAD", "--", ...tracked], cwd);
  }

  for (const path of unique) {
    if (tracked.includes(path)) continue;
    // A file the commit the tree started at does not hold is one the agent
    // wrote, and the only way back from it is to remove it.
    rmSync(join(cwd, path), { recursive: true, force: true });
  }
}

/** Whether the commit the tree is on holds a path at all. */
function isTracked(path: FileEdit, cwd: string): boolean {
  return spawnSync("git", ["ls-files", "--error-unmatch", "--", path], { cwd, stdio: "ignore" }).status === 0;
}

/** One git command, said about when it does not work. */
function runGit(args: readonly string[], cwd: string): void {
  const result = spawnSync("git", args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    process.stderr.write(`blazeup: git ${args.join(" ")} failed\n`);
  }
}

/** What a file held before a run took its change out of the tree. */
export interface Aside {
  readonly path: FileEdit;
  readonly text: string;
}

/**
 * Take a change out of the tree, keeping hold of what it wrote.
 *
 * A run measures the compiler with the change and without it, and the change
 * is already in the tree by the time there is anything to measure. So the
 * change is read into the run, the tree is put back the way it was, and the
 * change is written back afterwards: the two measurements are then of the
 * same compiler minutes apart rather than an hour.
 *
 * @param paths The paths the change was written in
 * @param cwd The base of the repository, whose tree is read
 */
export function setAside(paths: readonly FileEdit[], cwd = repositoryRoot()): Aside[] {
  const aside: Aside[] = [];
  for (const path of new Set(paths)) {
    try {
      aside.push({ path, text: readFileSync(join(cwd, path), "utf8") });
    } catch {
      // A file the agent took out has nothing to hold: the revert restores
      // what it was.
    }
  }
  return aside;
}

/** Put a change taken out of the tree back into it. */
export function putBack(aside: readonly Aside[], cwd = repositoryRoot()): void {
  for (const { path, text } of aside) {
    writeFileSync(join(cwd, path), text);
  }
}

/**
 * The compiler directory as a path from where a run is working.
 *
 * The agent is started at the base of the repository, so this is the path it
 * is given for the compiler rather than an absolute one it need not have.
 */
function compilerPath(cwd: string): string {
  return relative(cwd, compilerDirectory(cwd));
}

/** The end of a text, for a diagnostic. */
function tail(text: string, limit = DETAIL_BUDGET): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `... [earlier output cut] ...\n${trimmed.slice(-limit)}`;
}

/** The beginning of a text, and what was left out of it. */
function cap(text: string, limit = SUMMARY_BUDGET): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit)}\n... [${trimmed.length - limit} more characters not shown]`;
}

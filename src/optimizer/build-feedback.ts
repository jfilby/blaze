/**
 * Gather AI review feedback from a blaze build.
 *
 * Runs a real blaze build with --debug and captures the review prompts the
 * compiler sent and the answers the model gave back. This feedback is the
 * context of the build-feedback pass: the proposals an AI reviewer made
 * while reviewing the IR and the lowered target of a real project.
 *
 * With a project, that project is built (one candidate, one attempt per
 * function, so the feedback is fast). Without one, a small project that
 * exercises the review pipeline is built in a temporary directory.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectInfo } from "./project.ts";

const COMPILER_DIR = join(import.meta.dirname, "..", "compiler");
const COMPILER_CLI = join(COMPILER_DIR, "cli.ts");

/** A project used when no project is given: small enough to build fast. */
const TEST_SOURCE = `export function square(x: number): number {
  return x * x;
}
`;

const TEST_TOML = `sourceFile = "main.ts"
output = "machine"
`;

/** Review feedback captured from one build. */
export interface BuildFeedback {
  /** The prompts the compiler sent for review, truncated per prompt. */
  readonly prompts: string;
  /** The answers the model gave back that the compiler could not read. */
  readonly answers: string;
  /** The build's own progress log, its tail. */
  readonly log: string;
  /** Whether the build itself succeeded. */
  readonly buildStatus: string;
}

/**
 * Run a blaze build with --debug and capture the review feedback.
 *
 * @param project The project to build, or undefined for the built-in one
 */
export async function gatherBuildFeedback(project?: ProjectInfo): Promise<BuildFeedback> {
  let cwd: string;
  let cleanup: (() => Promise<void>) | undefined;

  if (project !== undefined) {
    // The project is built where it lives, so its build state is written
    // beside it the way a build of it anywhere else would be.
    cwd = project.directory;
  } else {
    const dir = await mkdtemp(join(tmpdir(), "blazeopt-build-"));
    await writeFile(join(dir, "main.ts"), TEST_SOURCE);
    await writeFile(join(dir, "blaze.toml"), TEST_TOML);
    cwd = dir;
    cleanup = () => rm(dir, { recursive: true, force: true });
  }

  try {
    const args = [
      COMPILER_CLI,
      "build",
      project !== undefined ? project.tomlPath : "blaze.toml",
      "--debug",
      // One candidate and one attempt is enough to see what the compiler
      // asks and what the model answers, without a full generation run.
      ...(project !== undefined ? ["--max-candidates", "1", "--max-attempts", "1"] : []),
    ];
    return await runBuild(args, cwd);
  } finally {
    await cleanup?.().catch(() => {});
  }
}

/** One build: spawn the compiler, collect its output, extract the feedback. */
function runBuild(args: readonly string[], cwd: string): Promise<BuildFeedback> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    child.on("close", (code) => {
      const { prompts, answers } = extractDebug(stderr);

      if (prompts.length === 0 && answers.length === 0) {
        // The two reasons there is nothing to read are told apart here rather
        // than left to whoever reads the error. A build with no model reviews
        // nothing at all and says so in its own output; a build that failed
        // before it reviewed anything says something else, and the tail of
        // what it said is what identifies it.
        if (/Model:\s*\(unset\)/.test(stdout)) {
          reject(
            new Error(
              "the build reviewed nothing because no model is configured: its own output says \"Model: (unset)\"\n" +
                "A build-feedback run is the reviewer's prompts and answers, so it needs a model to review with.",
            ),
          );
          return;
        }
        const detail = tail(stderr) || tail(stdout);
        reject(new Error(`the build produced no review output (exit ${String(code)})${detail ? `:\n${detail}` : ""}`));
        return;
      }

      resolve({
        prompts: prompts.join("\n\n"),
        answers: answers.join("\n\n"),
        log: tail(stdout, 4000),
        buildStatus: code === 0 ? "success" : "failed",
      });
    });

    child.on("error", (cause) => {
      reject(cause);
    });
  });
}

/**
 * A `-- prompt` and a `-- answer` block in the debug output, exactly as the
 * compiler writes them:
 *
 *   -- prompt ir 1.1: system --
 *   -- prompt ir 1.1: user --
 *   -- answer ir 1.1 request 1 --
 *
 * The header line is kept as the label of each block, and the prompt bodies
 * are capped: a prompt carries the whole artifact, and repeating one in full
 * for every function would be more context than the answer is worth.
 */
const DEBUG_HEADER = /^-- (prompt|answer) [a-z]+ \d+(?:\.\d+)?(?: request \d+)?(?:: (?:system|user))? --$/;

const PROMPT_BODY_BUDGET = 2000;
const MAX_PROMPTS = 8;
const MAX_ANSWERS = 10;

interface DebugBlocks {
  readonly prompts: string[];
  readonly answers: string[];
}

/** The `-- prompt` and `-- answer` blocks in a build's debug output. */
export function extractDebug(stderr: string): DebugBlocks {
  const prompts: string[] = [];
  const answers: string[] = [];
  let block: string[] | null = null;
  let kind: "prompt" | "answer" | null = null;

  const flush = (): void => {
    if (block === null || kind === null) return;
    const text = block.join("\n").trim();
    if (text !== "") {
      const isPrompt = kind === "prompt";
      const list = isPrompt ? prompts : answers;
      if (list.length < (isPrompt ? MAX_PROMPTS : MAX_ANSWERS)) {
        list.push(isPrompt ? cap(text, PROMPT_BODY_BUDGET) : text);
      }
    }
    block = null;
    kind = null;
  };

  for (const line of stderr.split("\n")) {
    const header = DEBUG_HEADER.exec(line);
    if (header !== null) {
      flush();
      kind = header[1] as "prompt" | "answer";
      block = [line];
      continue;
    }
    if (block !== null) block.push(line);
  }
  flush();

  return { prompts, answers };
}

/** Keep a block's label and the last `budget` characters of its body. */
function cap(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const newline = text.indexOf("\n");
  const label = newline === -1 ? text : text.slice(0, newline + 1);
  return `${label}... [truncated] ...\n${text.slice(-budget)}`;
}

/** The last `limit` characters of a text, for diagnostics and the build log. */
function tail(text: string, limit = 2000): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `... [earlier output cut] ...\n${trimmed.slice(-limit)}`;
}

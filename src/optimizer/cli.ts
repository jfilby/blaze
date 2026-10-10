#!/usr/bin/env node
/**
 * blazeopt - iterative blaze compiler optimizer.
 *
 *   blazeopt [options]
 *
 * Runs an optimization loop that alternates between three pass methods:
 *   1. research       — Tavily search + compiler source review
 *   2. build-feedback — blaze build AI review feedback + compiler source review
 *   3. code-review    — compiler source review alone
 *
 * Each pass proposes changes using the Vercel AI SDK, applies them, tests
 * with the full test suite, benchmarks with hyperfine, and commits on success.
 * Research results are cached with a weekly reset.
 *
 * A project path targets the run at one blaze project: the research queries
 * and the build feedback are about that project, and the proposals are
 * asked to be relevant to what it does.
 *
 * Options:
 *   --max-iterations <n>   Maximum passes (default 3)
 *   --benchmark-runs <n>   Hyperfine runs per benchmark (default 5)
 *   --methods <list>       Comma-separated pass methods to cycle through
 *                         (default "research,build-feedback,code-review")
 *   -h, --help             Show this help
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { craftQuery, searchTavily, tavilyApiKey } from "./tavily.ts";
import { addProcessed, isProcessed, loadCache, saveCache, type CacheEntry } from "./cache.ts";
import { benchmarkCompiler } from "./benchmark.ts";
import { gatherBuildFeedback } from "./build-feedback.ts";
import { proposeImprovements, applyProposal, type PassMethod } from "./ai.ts";
import { loadProject, type ProjectInfo } from "./project.ts";

const COMPILER_DIR = join(import.meta.dirname, "..", "compiler");

const VALID_METHODS: readonly PassMethod[] = ["research", "build-feedback", "code-review"];

function parseMethods(value: string): PassMethod[] | null {
  const parts = value.split(",").map((m) => m.trim());
  const methods: PassMethod[] = [];
  for (const part of parts) {
    if (part === "") continue;
    if (!VALID_METHODS.includes(part as PassMethod)) return null;
    if (!methods.includes(part as PassMethod)) methods.push(part as PassMethod);
  }
  if (methods.length === 0) return null;
  return methods;
}

const USAGE = `blazeopt - iterative blaze compiler optimizer

Alternates between three pass methods (research, build-feedback, code-review),
proposing compiler improvements using the Vercel AI SDK. Each pass is tested
with the full test suite, benchmarked with hyperfine, and committed on success.

Usage:
  blazeopt [project] [options]

A project is a directory containing blaze.toml, or a .toml file naming its
own. With one, the run is targeted at it: the research queries are about
what the project does, the build-feedback pass compiles it, and the proposals
are asked to be relevant to it. Without one, the passes are general.

Options:
  --max-iterations <n>   Maximum passes (default 3)
  --benchmark-runs <n>   Hyperfine runs per benchmark (default 5)
  --methods <list>       Comma-separated pass methods to cycle through:
                           research       Tavily search + compiler source review
                           build-feedback blaze build AI review feedback + source
                           code-review    compiler source review alone
                         (default "research,build-feedback,code-review")
  -h, --help             show this help

Environment:
  TAVILY_API_KEY         enables research passes
  AI_MODEL               provider/model for the AI SDK (e.g. anthropic/claude-sonnet-4-5)
  ANTHROPIC_API_KEY      Anthropic API key
  OPENAI_API_KEY         OpenAI API key
  GOOGLE_GENERATIVE_AI_API_KEY  Google API key
`;

interface Options {
  maxIterations: number;
  benchmarkRuns: number;
  project?: ProjectInfo;
}

async function runPass(
  method: PassMethod,
  iteration: number,
  options: Options,
): Promise<boolean> {
  const methodLabel = method === "research" ? "research" : method === "build-feedback" ? "build-feedback" : "code-review";
  process.stdout.write(`\n${"=".repeat(72)}\n`);
  process.stdout.write(`Iteration ${iteration}/${options.maxIterations}: ${methodLabel}\n`);
  process.stdout.write(`${"=".repeat(72)}\n\n`);

  // 1. Gather context
  let context = "";
  if (method === "research") {
    context = await gatherResearchContext(options.project);
  } else if (method === "build-feedback") {
    context = await gatherBuildFeedbackContext(options.project);
  }

  // 2. Propose improvements
  process.stdout.write("Requesting AI proposals...\n");
  const response = await proposeImprovements(method, context, options.project);
  process.stdout.write(`AI summary: ${response.summary}\n`);
  process.stdout.write(`Proposed ${response.proposals.length} change(s)\n\n`);

  if (response.proposals.length === 0) {
    process.stdout.write("No proposals to apply, skipping.\n");
    return false;
  }

  // 3. Benchmark before
  process.stdout.write("Benchmarking before changes...\n");
  const before = await benchmarkCompiler(options.benchmarkRuns);
  process.stdout.write(`  Before: ${before.mean.toFixed(3)}s ± ${before.stddev.toFixed(3)}s\n\n`);

  // 4. Apply proposals
  const applied: string[] = [];
  for (const proposal of response.proposals) {
    if (applyProposal(proposal)) {
      applied.push(`${proposal.file}: ${proposal.description}`);
      process.stdout.write(`  Applied: ${proposal.file} — ${proposal.description}\n`);
    } else {
      process.stdout.write(`  Skipped (original not found): ${proposal.file}\n`);
    }
  }

  if (applied.length === 0) {
    process.stdout.write("No proposals could be applied, skipping.\n");
    return false;
  }

  // 5. Test
  process.stdout.write("\nRunning test suite...\n");
  const testResult = runTests();
  if (!testResult) {
    process.stdout.write("Tests failed, reverting changes.\n");
    revertChanges();
    return false;
  }
  process.stdout.write("Tests passed.\n");

  // 6. Benchmark after
  process.stdout.write("\nBenchmarking after changes...\n");
  const after = await benchmarkCompiler(options.benchmarkRuns);
  process.stdout.write(`  After:  ${after.mean.toFixed(3)}s ± ${after.stddev.toFixed(3)}s\n`);

  const delta = after.mean - before.mean;
  const percent = (delta / before.mean) * 100;
  if (delta > 0) {
    process.stdout.write(`  Slower by ${delta.toFixed(3)}s (${percent.toFixed(1)}%), reverting.\n`);
    revertChanges();
    return false;
  }
  process.stdout.write(`  Faster by ${(-delta).toFixed(3)}s (${(-percent).toFixed(1)}%)\n`);

  // 7. Commit
  commitChanges(methodLabel, applied);
  return true;
}

async function gatherResearchContext(project?: ProjectInfo): Promise<string> {
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
    return "";
  }

  let newCache: CacheEntry[] = cache;
  for (const r of fresh) {
    newCache = addProcessed(newCache, r.url, r.title);
  }
  saveCache(newCache);

  const parts = fresh.map((r, i) => `Paper ${i + 1}: ${r.title}\n${r.content}`);
  return parts.join("\n\n---\n\n");
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

function runTests(): boolean {
  const result = spawnSync("npm", ["test"], {
    cwd: COMPILER_DIR,
    stdio: "inherit",
    timeout: 300000,
  });
  return result.status === 0;
}

function revertChanges(): void {
  const result = spawnSync("git", ["checkout", "--", "."], {
    cwd: COMPILER_DIR,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.stderr.write("Failed to revert changes\n");
  }
}

function commitChanges(method: string, applied: readonly string[]): void {
  const result = spawnSync("git", ["add", "-A"], { cwd: COMPILER_DIR, stdio: "inherit" });
  if (result.status !== 0) {
    process.stderr.write("Failed to stage changes\n");
    return;
  }
  const message = `blazeopt: ${method} — ${applied.length} improvement(s)\n\n${applied.join("\n")}`;
  const commit = spawnSync("git", ["commit", "-m", message], { cwd: COMPILER_DIR, stdio: "inherit" });
  if (commit.status === 0) {
    process.stdout.write(`Committed ${applied.length} change(s)\n`);
  } else {
    process.stderr.write("Failed to commit\n");
  }
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "max-iterations": { type: "string" },
      "benchmark-runs": { type: "string" },
      methods: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (parsed.values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const positionals = parsed.positionals;
  if (positionals.length > 1) {
    process.stderr.write(`too many arguments (one project path at most)\n\n${USAGE}`);
    return 1;
  }

  const maxIterations = parsed.values["max-iterations"]
    ? parseInt(parsed.values["max-iterations"], 10)
    : 3;
  const benchmarkRuns = parsed.values["benchmark-runs"]
    ? parseInt(parsed.values["benchmark-runs"], 10)
    : 5;

  if (isNaN(maxIterations) || maxIterations < 1) {
    process.stderr.write(`invalid --max-iterations\n\n${USAGE}`);
    return 1;
  }

  const methods = parseMethods(parsed.values["methods"] ?? "research,build-feedback,code-review");
  if (methods === null) {
    process.stderr.write(`invalid --methods (must be a comma-separated subset of: ${VALID_METHODS.join(", ")})\n\n${USAGE}`);
    return 1;
  }

  // A project path targets the run at one project. It is read before any
  // pass, so a path that names no project is refused before anything else.
  let project: ProjectInfo | undefined;
  if (positionals.length === 1) {
    try {
      project = await loadProject(positionals[0]);
    } catch (cause) {
      process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
      return 1;
    }
  }

  const options: Options = { maxIterations, benchmarkRuns, project };

  process.stdout.write(`blazeopt: starting optimization loop (max ${maxIterations} iterations)\n`);
  process.stdout.write(`blazeopt: pass methods: ${methods.join(" → ")}\n`);
  if (project !== undefined) {
    process.stdout.write(`blazeopt: targeting project ${project.tomlPath}\n`);
  }

  for (let i = 0; i < maxIterations; i++) {
    const method = methods[i % methods.length];
    try {
      await runPass(method, i + 1, options);
    } catch (cause) {
      process.stderr.write(`Pass ${i + 1} (${method}) failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
    }
  }

  process.stdout.write("\nblazeopt: optimization loop complete\n");
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (cause) {
  process.stderr.write(`blazeopt failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exitCode = 1;
}

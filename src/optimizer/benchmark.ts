/**
 * Hyperfine-based benchmarking for the blaze compiler.
 *
 * Each optimization pass benchmarks the compiler before and after applying
 * changes. If the post-change benchmark is slower, the change is discarded.
 *
 * Two things about this measurement are easy to get wrong and both of them
 * were. Hyperfine writes its JSON to a file this module names, because
 * stdout carries the results table, the bracketed time ranges in it and
 * anything the benchmarked command prints — slicing that apart by bracket
 * reads the wrong JSON. And the benchmark runs in the compiler directory,
 * because `npm test` is a command with a meaning only relative to a project.
 *
 * A run aimed at a project is measured on the program that project builds
 * rather than on the compiler's own suite, because the compiler is what makes
 * that program fast. The rebuild is the deterministic half of a build and the
 * command that times the program is the project's own.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectInfo } from "./project.ts";

const COMPILER_DIR = join(import.meta.dirname, "..", "compiler");

/** The compiler's own deterministic rebuild of a project, with no model in it. */
const OFFLINE_BUILD = join(COMPILER_DIR, "offline-build.ts");

/** How long a benchmark may run before it is abandoned, per hyperfine run. */
const BENCHMARK_RUN_TIMEOUT_MS = 15 * 60 * 1000;

/** How long a project may take to rebuild before it is abandoned. */
const REBUILD_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Set when a run of this optimizer times the suite, to leave the heap proof
 * out of it: the proof in test/program-body.test.ts grows a real two gigabytes
 * of memory, which is the thing the system kills on a machine a benchmarking
 * session is already filling.
 */
export const SKIP_HEAP_PROOF_ENV = "BLAZE_SKIP_HEAP_PROOF";

/** The command a benchmark of the compiler times. */
const SUITE_COMMAND = `${SKIP_HEAP_PROOF_ENV}=1 npm test`;

export interface BenchmarkResult {
  readonly mean: number;
  readonly stddev: number;
  readonly runs: number;
  /** The unit the mean and stddev are in: hyperfine reports seconds. */
  readonly unit: string;
}

/** The part of hyperfine's JSON export this module reads. */
export interface HyperfineExport {
  readonly results?: Array<{ mean: number; stddev: number; times: number[] }>;
}

/**
 * Benchmark a command using hyperfine.
 *
 * @param command The shell command to benchmark
 * @param runs Number of measurement runs (default 5)
 * @param cwd The directory the command runs in (default: the compiler)
 * @returns The benchmark result with mean and stddev in seconds
 */
export async function benchmark(
  command: string,
  runs = 5,
  cwd = COMPILER_DIR,
): Promise<BenchmarkResult> {
  const dir = await mkdtemp(join(tmpdir(), "blazeopt-bench-"));
  const exportPath = join(dir, "hyperfine.json");

  // A measurement of the compiler's own test suite is a few minutes a run,
  // so the time a benchmark is allowed is per run it takes: one bound for
  // the whole benchmark would abandon five runs it has already paid for.
  const timeoutMs = BENCHMARK_RUN_TIMEOUT_MS * (runs + 1);

  try {
    // hyperfine's own output, and the benchmarked command's, are not read:
    // the JSON goes to a file so that what is parsed is only the JSON.
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "hyperfine",
        [
          "--warmup", "1",
          "--runs", String(runs),
          "--export-json", exportPath,
          "--shell", "bash",
          command,
        ],
        { cwd, stdio: ["ignore", "ignore", "pipe"] },
      );

      let stderr = "";
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

      const timer = setTimeout(
        () => {
          child.kill("SIGKILL");
          reject(new Error(`the benchmark did not finish within ${timeoutMs / 60000} minutes`));
        },
        timeoutMs,
      );

      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`hyperfine failed (exit ${String(code)}): ${stderr.trim().slice(-1000)}`));
          return;
        }
        resolve();
      });

      child.on("error", (cause) => {
        clearTimeout(timer);
        reject(cause);
      });
    });

    const data = JSON.parse(await readFile(exportPath, "utf8")) as HyperfineExport;
    return readHyperfineResult(data);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * What one hyperfine export says, read from the export's own JSON.
 *
 * The shape is hyperfine's and not an array of results: a top level object
 * with a `results` array, each entry of which carries the mean and the
 * spread over its own runs. A single run has no spread, and hyperfine says so
 * with a null rather than a zero.
 *
 * @param export The parsed `--export-json` document
 * @returns The first benchmark's mean, spread and run count
 */
export function readHyperfineResult(data: HyperfineExport): BenchmarkResult {
  const first = data.results?.[0];
  if (first === undefined || typeof first.mean !== "number" || !Number.isFinite(first.mean)) {
    throw new Error("hyperfine returned no usable result");
  }

  // A run that times nothing, or that hyperfine refused to time, would read
  // as a mean of zero and as an unlimited speedup.
  const times = Array.isArray(first.times)
    ? first.times.filter((t): t is number => typeof t === "number" && t > 0)
    : [];
  if (first.mean <= 0 || times.length === 0) {
    throw new Error("hyperfine measured the command as taking no time");
  }

  return {
    mean: first.mean,
    stddev:
      typeof first.stddev === "number" && Number.isFinite(first.stddev) ? first.stddev : 0,
    runs: times.length,
    unit: "s",
  };
}

/**
 * Benchmark the blaze compiler by timing the test suite, with the suite's
 * heap proof left out of it.
 * This exercises the full compiler pipeline and is the most reliable
 * measure of compiler performance.
 */
export async function benchmarkCompiler(runs = 5): Promise<BenchmarkResult> {
  return benchmark(SUITE_COMMAND, runs);
}

/**
 * Benchmark a blaze project: rebuild it with the compiler as it stands, and
 * time the program the project's own file says to time.
 *
 * The program is what the compiler made fast, so a run aimed at a project is
 * judged by it rather than by the compiler's own suite. The rebuild is the
 * deterministic half of a build — the same frontend, resolver, optimizer and
 * toolchain a build runs, with no model in it — so what is timed is what the
 * rule-based half of the compiler produced, and two measurements of the same
 * compiler are the same program twice.
 *
 * The command is the project's own and nothing here ever chooses one. How much
 * of the program to run is a question about the machine, not about the
 * compiler: a project file that names no `[benchmark]` entry has no
 * measurement to be judged by, and the run refuses it rather than timing
 * something of its own.
 *
 * @param project The project, whose blaze.toml names the command and the
 *   directory it runs in
 * @param runs Number of measurement runs
 */
export async function benchmarkProject(project: ProjectInfo, runs = 5): Promise<BenchmarkResult> {
  const entry = project.benchmark;
  if (entry === null) {
    throw new Error(`${project.tomlPath} names no [benchmark] entry, so there is nothing to time`);
  }

  const work = await mkdtemp(join(tmpdir(), "blazeopt-project-"));
  // The program the measurement times is written where the project's own build
  // delivers it, which is the project's directory and therefore the user's.
  const delivered = join(entry.directory, entry.program);
  const previous = join(work, "previous");
  let replaced = false;

  try {
    const built = await rebuildProject(project, work);
    replaced = await holdAside(delivered, previous);
    await copyFile(built, delivered);
    await chmod(delivered, 0o755);
    return await benchmark(entry.command, runs, entry.directory);
  } finally {
    // The project's directory goes back the way it was found: the program this
    // measured by is a build artifact of this run, and a run that left its own
    // build behind would leave the user's tree dirty with it.
    if (replaced) await copyFile(previous, delivered).catch(() => {});
    else await rm(delivered, { force: true }).catch(() => {});
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Rebuild a project, and say where the program it wrote is.
 *
 * The rebuild is the compiler's own offline harness, which runs the
 * deterministic half of a build: it writes the objects, the runtime and the
 * linked program into the work directory it is given. It is run from the
 * project's own directory, the way a build of it is, so what it resolves is
 * what the project resolves.
 */
async function rebuildProject(project: ProjectInfo, work: string): Promise<string> {
  const program = join(work, "program");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("node", [OFFLINE_BUILD, project.directory, work], {
      cwd: project.directory,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`the project was not rebuilt within ${REBUILD_TIMEOUT_MS / 60000} minutes`));
    }, REBUILD_TIMEOUT_MS);

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const detail = tail(stderr) || tail(stdout);
        reject(
          new Error(
            `the project could not be rebuilt (exit ${String(code)})${detail === "" ? "" : `:\n${detail}`}`,
          ),
        );
        return;
      }
      // A build that answered with nothing wrote nothing, and there would be
      // nothing for the command to time but a program an earlier one left.
      if (!existsSync(program)) {
        reject(new Error("the rebuild wrote no program to time"));
        return;
      }
      resolve();
    });

    child.on("error", (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
  });

  return program;
}

/**
 * Hold whatever the delivered program is now out of the way, so it can be put
 * back once the measurement is over.
 *
 * @returns Whether there was something to hold, which is what decides whether
 *   the delivered file is restored or taken back out at the end
 */
async function holdAside(delivered: string, previous: string): Promise<boolean> {
  if (!existsSync(delivered)) return false;
  await copyFile(delivered, previous);
  return true;
}

/** The end of a text, for a diagnostic. */
function tail(text: string, limit = 2000): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `... [earlier output cut] ...\n${trimmed.slice(-limit)}`;
}

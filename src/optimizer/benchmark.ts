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
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COMPILER_DIR = join(import.meta.dirname, "..", "compiler");

/** How long a benchmark may run before it is abandoned, per hyperfine run. */
const BENCHMARK_RUN_TIMEOUT_MS = 15 * 60 * 1000;

export interface BenchmarkResult {
  readonly mean: number;
  readonly stddev: number;
  readonly runs: number;
  /** The unit the mean and stddev are in: hyperfine reports seconds. */
  readonly unit: string;
}

/** The part of hyperfine's JSON export this module reads. */
interface HyperfineExport {
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
    const first = data.results?.[0];
    if (first === undefined || typeof first.mean !== "number" || !Number.isFinite(first.mean)) {
      throw new Error("hyperfine returned no usable result");
    }

    // A run that times nothing, or that hyperfine refused to time, would
    // read as a mean of zero and as an unlimited speedup.
    const times = Array.isArray(first.times)
      ? first.times.filter((t): t is number => typeof t === "number" && t > 0)
      : [];
    if (first.mean <= 0 || times.length === 0) {
      throw new Error("hyperfine measured the command as taking no time");
    }

    return {
      mean: first.mean,
      // One run has no spread, and hyperfine says so with a null rather
      // than a zero: read it as no measured spread rather than no result.
      stddev:
        typeof first.stddev === "number" && Number.isFinite(first.stddev) ? first.stddev : 0,
      runs: times.length,
      unit: "s",
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Benchmark the blaze compiler by timing `npm test`.
 * This exercises the full compiler pipeline and is the most reliable
 * measure of compiler performance.
 */
export async function benchmarkCompiler(runs = 5): Promise<BenchmarkResult> {
  return benchmark("npm test", runs);
}

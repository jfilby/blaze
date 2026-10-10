/**
 * Hyperfine-based benchmarking for the blaze compiler.
 *
 * Each optimization pass benchmarks the compiler before and after applying
 * changes. If the post-change benchmark is slower, the change is discarded.
 */

import { spawn } from "node:child_process";

export interface BenchmarkResult {
  readonly mean: number;
  readonly stddev: number;
  readonly runs: number;
  readonly unit: string;
}

/**
 * Benchmark a command using hyperfine.
 *
 * @param command The shell command to benchmark
 * @param runs Number of measurement runs (default 5)
 * @returns The benchmark result with mean and stddev in milliseconds
 */
export async function benchmark(command: string, runs = 5): Promise<BenchmarkResult> {
  return new Promise((resolve, reject) => {
    const args = [
      "--warmup", "1",
      "--runs", String(runs),
      "--export-json", "/dev/stdout",
      "--shell", "bash",
      command,
    ];
    const child = spawn("hyperfine", args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`hyperfine failed (exit ${code}): ${stderr.trim()}`));
        return;
      }
      try {
        // hyperfine --export-json writes to stdout; parse the last JSON object
        const jsonStr = stdout.slice(stdout.lastIndexOf("["));
        const data = JSON.parse(jsonStr) as Array<{
          mean: number;
          stddev: number;
          runs: number;
        }>;
        if (data.length === 0) {
          reject(new Error("hyperfine returned no results"));
          return;
        }
        const result = data[0];
        resolve({
          mean: result.mean,
          stddev: result.stddev,
          runs: result.runs,
          unit: "s",
        });
      } catch (cause) {
        reject(new Error(`failed to parse hyperfine output: ${cause instanceof Error ? cause.message : String(cause)}`));
      }
    });
  });
}

/**
 * Benchmark the blaze compiler by timing `npm test`.
 * This exercises the full compiler pipeline and is the most reliable
 * measure of compiler performance.
 */
export async function benchmarkCompiler(runs = 5): Promise<BenchmarkResult> {
  return benchmark("npm test", runs);
}

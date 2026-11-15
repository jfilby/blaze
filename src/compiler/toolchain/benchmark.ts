/**
 * Benchmarking.
 *
 * Valid candidates are measured in isolated child processes, so nothing from a
 * previous candidate can influence the next measurement. Benchmark results
 * only decide which valid candidate is selected; they never affect correctness.
 */

import { CompilerError } from "../core/errors.ts";
import { run, GENERATED_HEAP_BYTES, type RunResult } from "../core/process.ts";
import { encodeBenchRequest, vectorValues, type TestVector } from "./verifier.ts";
import { preconditionFailures, type ParsedContract } from "../semantics/contract.ts";
import type { BenchmarkResult, FunctionContract, Runner } from "../core/types.ts";

function fieldOf(value: unknown, key: string): any {
  return (value as Record<string, unknown>)[key];
}

const REPEATS = 3;

/** The longest generated vector: the most representative workload. */
export function selectBenchmarkVector(contract: FunctionContract, parsed: ParsedContract, vectors: readonly TestVector[]): TestVector {
  let best = vectors[0];
  let bestLength = -1;
  for (const vector of vectors) {
    const args = fieldOf(vector, "args") as Record<string, string | string[] | null>;
    const length = Object.values(args).reduce((longest: number, value: string | string[] | null) => {
      const size = Array.isArray(value) ? Number(fieldOf(value, "length")) : 0;
      return Math.max(longest, size);
    }, 0);
    if (length > bestLength) {
      best = vector;
      bestLength = length;
    }
  }
  if (preconditionFailures(parsed, vectorValues(contract, best)).length > 0) {
    throw new CompilerError("BenchmarkError", "benchmark", "the benchmark vector violates the contract preconditions", "", String(fieldOf(fieldOf(contract, "function"), "name")), "", "");
  }
  return best;
}

export interface BenchmarkRequest {
  contract: FunctionContract;
  runner: Runner;
  candidate: string;
  iterations: number;
  vector: TestVector;
}


/**
 * How a benchmark run ended when it did not end cleanly. A run killed by a
 * signal or stopped at its time limit has no exit status, and reporting the
 * missing one as a status would describe a stop as a code the program chose.
 */
function benchmarkStop(execution: RunResult): string | null {
  if (fieldOf(execution, "timedOut") === true) return "did not finish";
  const signal = fieldOf(execution, "signal") as string | null;
  if (signal !== null) return `was terminated by ${signal}`;
  const code = fieldOf(execution, "code") as number | null;
  if (code === null) return "did not report an exit status";
  if (code !== 0) return `exited with status ${code}`;
  return null;
}
export function benchmarkCandidate(request: BenchmarkRequest): BenchmarkResult {
  const contract = fieldOf(request, "contract") as FunctionContract;
  const vector = fieldOf(request, "vector") as TestVector;
  const iterations = Number(fieldOf(request, "iterations"));
  const candidateName = String(fieldOf(request, "candidate"));
  const runner = fieldOf(request, "runner") as Runner;
  const functionName = String(fieldOf(fieldOf(contract, "function"), "name"));
  const input = encodeBenchRequest(contract, vector, iterations);
  const durations: number[] = [];

  for (let repeat = 0; repeat < REPEATS; repeat += 1) {
    const execution = run(String(fieldOf(runner, "command")), fieldOf(runner, "args") as string[], {
      input,
      timeoutMs: 300_000,
      heapBytes: GENERATED_HEAP_BYTES,
    });
    if (fieldOf(execution, "spawnError") !== undefined) {
      throw new CompilerError("BenchmarkError", "benchmark", `cannot run the candidate for ${functionName}`, fieldOf(execution, "spawnError") as string | undefined, functionName, candidateName, "");
    }

    const stopped = benchmarkStop(execution);
    if (stopped !== null) {
      throw new CompilerError("BenchmarkError", "benchmark", `the benchmark run for ${functionName} ${stopped}`, String(fieldOf(execution, "stderr")).trim().slice(0, 2000), functionName, candidateName, "");
    }
    const line = String(fieldOf(execution, "stdout")).split("\n").find((entry) => entry.startsWith("BENCH "));
    if (line === undefined) {
      throw new CompilerError("BenchmarkError", "benchmark", `the benchmark run for ${functionName} produced no result`, String(fieldOf(execution, "stdout")).trim().slice(0, 400), functionName, candidateName, "");
    }
    const durationNs = Number.parseInt(String(line.split(" ")[1]), 10);
    if (!Number.isFinite(durationNs) || durationNs <= 0) {
      throw new CompilerError("BenchmarkError", "benchmark", `the benchmark reported an invalid duration for ${functionName}`, line, functionName, candidateName, "");
    }
    durations.push(durationNs);
  }

  // The fastest run is the least noisy estimate of the candidate's cost.
  const durationNs = Math.min(...durations);
  return {
    candidate: candidateName,
    iterations,
    durationNs,
    throughput: iterations / durationNs,
  };
}

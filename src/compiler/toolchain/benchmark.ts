/**
 * Benchmarking.
 *
 * Valid candidates are measured in isolated child processes, so nothing from a
 * previous candidate can influence the next measurement. Benchmark results
 * only decide which valid candidate is selected; they never affect correctness.
 */

import { CompilerError } from "../core/errors.ts";
import { run } from "../core/process.ts";
import { encodeBenchRequest, planTestVectors, vectorValues, type TestVector } from "./verifier.ts";
import { preconditionFailures, type ParsedContract } from "../semantics/contract.ts";
import type { BenchmarkResult, FunctionContract, Runner, TestConfig } from "../core/types.ts";

const REPEATS = 3;

/** The longest generated vector: the most representative workload. */
export function selectBenchmarkVector(contract: FunctionContract, parsed: ParsedContract, config: TestConfig): TestVector {
  const vectors = planTestVectors(parsed, config);
  let best = vectors[0];
  let bestLength = -1;
  for (const vector of vectors) {
    const length = Object.values(vector.args).reduce((longest, value) => {
      const size = Array.isArray(value) ? value.length : 0;
      return Math.max(longest, size);
    }, 0);
    if (length > bestLength) {
      best = vector;
      bestLength = length;
    }
  }
  if (preconditionFailures(parsed, vectorValues(contract, best)).length > 0) {
    throw new CompilerError({
      category: "BenchmarkError",
      stage: "benchmark",
      message: "the benchmark vector violates the contract preconditions",
      function: contract.function.name,
    });
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

export function benchmarkCandidate(request: BenchmarkRequest): BenchmarkResult {
  const input = encodeBenchRequest(request.contract, request.vector, request.iterations);
  const durations: number[] = [];

  for (let repeat = 0; repeat < REPEATS; repeat += 1) {
    const execution = run(request.runner.command, request.runner.args, { input, timeoutMs: 300_000 });
    if (execution.spawnError !== undefined) {
      throw new CompilerError({
        category: "BenchmarkError",
        stage: "benchmark",
        message: `cannot run the candidate for ${request.contract.function.name}`,
        function: request.contract.function.name,
        candidate: request.candidate,
        detail: execution.spawnError,
      });
    }
    if (execution.code !== 0) {
      throw new CompilerError({
        category: "BenchmarkError",
        stage: "benchmark",
        message: `the benchmark run for ${request.contract.function.name} exited with status ${execution.code}`,
        function: request.contract.function.name,
        candidate: request.candidate,
        detail: execution.stderr.trim().slice(0, 2000),
      });
    }
    const line = execution.stdout.split("\n").find((entry) => entry.startsWith("BENCH "));
    if (line === undefined) {
      throw new CompilerError({
        category: "BenchmarkError",
        stage: "benchmark",
        message: `the benchmark run for ${request.contract.function.name} produced no result`,
        function: request.contract.function.name,
        candidate: request.candidate,
        detail: execution.stdout.trim().slice(0, 400),
      });
    }
    const durationNs = Number.parseInt(line.split(" ")[1], 10);
    if (!Number.isFinite(durationNs) || durationNs <= 0) {
      throw new CompilerError({
        category: "BenchmarkError",
        stage: "benchmark",
        message: `the benchmark reported an invalid duration for ${request.contract.function.name}`,
        function: request.contract.function.name,
        candidate: request.candidate,
        detail: line,
      });
    }
    durations.push(durationNs);
  }

  // The fastest run is the least noisy estimate of the candidate's cost.
  const durationNs = Math.min(...durations);
  return {
    candidate: request.candidate,
    iterations: request.iterations,
    durationNs,
    throughput: request.iterations / durationNs,
  };
}

/**
 * Code generation.
 *
 * The generate -> assemble -> link -> verify -> benchmark loop. Every
 * diagnostic that rejects a candidate is collected and handed to the model for
 * the next attempt, so assembler errors and failing test vectors lead to
 * corrected candidates instead of a dead end.
 *
 * The compiler decides which candidate is valid and which one is selected. The
 * model only proposes.
 */

import { assemble } from "./toolchain/assembler.ts";
import { benchmarkCandidate, selectBenchmarkVector } from "./toolchain/benchmark.ts";
import { buildWasm } from "./toolchain/wasm.ts";
import { compileC } from "./toolchain/csource.ts";
import { generateHarness, link } from "./toolchain/linker.ts";
import { buildHostProgram } from "./runtime/nim.ts";
import { buildStandaloneRuntime, writeRuntimeHeader } from "./runtime/standalone.ts";
import { writeFile } from "node:fs/promises";
import { CompilerError, toCompilerError } from "./core/errors.ts";
import type { AiBackend } from "./ai/backend.ts";
import type { ParsedContract } from "./semantics/contract.ts";
import { encodeRunRequest, selectDemoVector, verifyCandidate, type TestVector } from "./toolchain/verifier.ts";
import type {
  AssemblyCandidate,
  BenchmarkConfig,
  BenchmarkResult,
  CandidateOutcome,
  FunctionContract,
  RuntimeKind,
  GenerationConfig,
  OutputKind,
  Runner,
  TestConfig,
  VerificationResult,
} from "./core/types.ts";

/** How each output kind is named in stage messages. */
const IMPLEMENTATION_LABEL: Record<OutputKind, string> = {
  c: "C",
  asm: "assembly",
  machine: "assembly",
  wasm: "WebAssembly",
};

export interface CodegenWorkspace {
  /** Directory for intermediate artifacts: assembly, objects, harness, test binaries. */
  workDirectory: string;
  functionName: string;
}

export interface CodegenRequest extends CandidateEvaluationRequest {
  contract: FunctionContract;
  parsed: ParsedContract;
  target: FunctionContract["target"];
  output: OutputKind;
  /**
   * Built on demand: a build that reuses stored assembly must not need model
   * configuration, because it never asks a model anything.
   */
  backend: () => AiBackend;
  generation: GenerationConfig;
  test: TestConfig;
  benchmark: BenchmarkConfig;
  workspace: CodegenWorkspace;
  /** Candidates from a previous build, tried before asking the model again. */
  existing: AssemblyCandidate[];
  /**
   * Called just before a request goes out. A model can take minutes, so the
   * compiler says it is waiting rather than looking stuck.
   */
  onGenerate?: (attempt: number, attempts: number) => void;
}

export interface CodegenResult {
  candidates: AssemblyCandidate[];
  outcomes: CandidateOutcome[];
  selected: string | null;
  benchmarkVector: TestVector;
  /** Wall clock time spent waiting for the model, in nanoseconds. */
  modelDurationNs: bigint;
}

interface CandidatePaths {
  /** The implementation as delivered: assembly, C source or WebAssembly text. */
  implementation: string;
  object: string;
  harness: string;
  executable: string;
  module: string;
  host: string;
}

function pathsFor(workspace: CodegenWorkspace, candidate: string, output: OutputKind): CandidatePaths {
  const base = `${workspace.workDirectory}/${candidate}`;
  const extension = output === "c" ? "c" : output === "wasm" ? "wat" : "s";
  return {
    implementation: `${base}.${extension}`,
    object: `${base}.o`,
    harness: `${base}.harness.c`,
    executable: `${base}.exe`,
    module: `${base}.wasm`,
    host: `${base}.host.mjs`,
  };
}

/** Diagnostics handed back to the model after a rejected candidate. */
function feedbackFor(failure: CandidateOutcome["failure"]): string[] {
  if (failure === undefined) return [];
  const detail = failure.detail === undefined || failure.detail.trim() === "" ? "" : `\n${failure.detail.trim()}`;
  return [`${failure.stage} failed: ${failure.message}${detail}`];
}

/** Everything evaluating one candidate needs, with or without a backend. */
export interface CandidateEvaluationRequest {
  contract: FunctionContract;
  parsed: ParsedContract;
  target: FunctionContract["target"];
  output: OutputKind;
  workspace: CodegenWorkspace;
  test: TestConfig;
  benchmark: BenchmarkConfig;
  runtime: RuntimeKind;
}

/** A candidate built far enough to be executed. */
export interface Materialized {
  runner: Runner;
  sizeBytes: number;
  textSizeBytes: number;
  implementationPath: string;
}

/**
 * Turns model output into something executable. Every kind is validated by the
 * native toolchain before it runs: assembly and C through the assembler and the
 * C compiler, WebAssembly through the module checks.
 */
async function materialize(
  request: CandidateEvaluationRequest,
  candidate: AssemblyCandidate,
  paths: CandidatePaths,
  demoRequest: string,
): Promise<Materialized> {
  if (request.output === "wasm") {
    const module = await buildWasm({
      text: candidate.assembly,
      contract: request.contract,
      textPath: paths.implementation,
      modulePath: paths.module,
      hostPath: paths.host,
      candidate: candidate.id,
    });
    return { runner: module.runner, sizeBytes: module.moduleSizeBytes, textSizeBytes: 0, implementationPath: paths.implementation };
  }
  // The ABI header exists before the candidate is compiled: a C candidate may
  // include it, and the harness always does.
  const runtime =
    request.runtime === "none"
      ? await buildStandaloneRuntime(request.workspace.workDirectory)
      : undefined;
  if (runtime === undefined) await writeRuntimeHeader(request.workspace.workDirectory);

  const object =
    request.output === "c"
      ? await compileC({
          source: candidate.assembly,
          contract: request.contract,
          target: request.target,
          sourcePath: paths.implementation,
          objectPath: paths.object,
          candidate: candidate.id,
        })
      : await assemble({
          assembly: candidate.assembly,
          assemblyPath: paths.implementation,
          objectPath: paths.object,
          contract: request.contract,
          target: request.target,
          candidate: candidate.id,
        });

  if (runtime !== undefined) {
    await writeFile(paths.harness, generateHarness(request.contract, demoRequest), "utf8");
    link({
      harnessPath: paths.harness,
      objectPath: paths.object,
      runtimeObjectPath: runtime.objectPath,
      outputPath: paths.executable,
      functionName: request.contract.function.name,
    });
    return {
      runner: { command: paths.executable, args: [] },
      sizeBytes: object.objectSizeBytes,
      textSizeBytes: object.textSizeBytes,
      implementationPath: paths.implementation,
    };
  }

  // A hosted build is a Nim program: the host speaks the harness protocol, so
  // the candidate object is linked into it instead of into a C main.
  const host = await buildHostProgram({
    contract: request.contract,
    workDirectory: request.workspace.workDirectory,
    candidate: candidate.id,
    objectPath: paths.object,
    demoRequest,
  });
  return {
    runner: host.runner,
    sizeBytes: object.objectSizeBytes,
    textSizeBytes: object.textSizeBytes,
    implementationPath: paths.implementation,
  };
}

export function implementationLabel(output: OutputKind): string {
  return IMPLEMENTATION_LABEL[output];
}

async function evaluateCandidate(
  request: CandidateEvaluationRequest,
  candidate: AssemblyCandidate,
  benchmarkVector: TestVector,
  demoRequest: string,
): Promise<CandidateOutcome> {
  const paths = pathsFor(request.workspace, candidate.id, request.output);
  try {
    const built = await materialize(request, candidate, paths, demoRequest);

    const verification = verifyCandidate({
      contract: request.contract,
      parsed: request.parsed,
      runner: built.runner,
      candidate: candidate.id,
      config: request.test,
    });
    if (!verification.passed) {
      return {
        candidate: candidate.id,
        valid: false,
        failure: {
          category: "VerificationError",
          stage: "verify",
          message: `${verification.failures.length} of ${verification.cases} test vectors did not match the contract`,
          detail: verification.failures
            .map((failure) => `${failure.vector}: expected ${failure.expected}, got ${failure.actual} (${failure.reason})`)
            .join("\n"),
        },
        textSizeBytes: built.textSizeBytes,
        objectSizeBytes: built.sizeBytes,
        verification,
      };
    }

    const benchmark = benchmarkCandidate({
      contract: request.contract,
      runner: built.runner,
      candidate: candidate.id,
      iterations: request.benchmark.iterations,
      vector: benchmarkVector,
    });

    return {
      candidate: candidate.id,
      valid: true,
      textSizeBytes: built.textSizeBytes,
      objectSizeBytes: built.sizeBytes,
      verification,
      benchmark,
    };
  } catch (cause) {
    const error = toCompilerError(cause, {
      category: "AssemblyError",
      stage: "assemble",
      function: request.contract.function.name,
      candidate: candidate.id,
    });
    return {
      candidate: candidate.id,
      valid: false,
      failure: {
        category: error.category,
        stage: error.stage,
        message: error.message,
        ...(error.detail === undefined ? {} : { detail: error.detail }),
      },
    };
  }
}

/**
 * Chooses the best valid candidate. Speed decides for latency and throughput;
 * code size decides for size; energy and balanced use the fastest candidate,
 * because neither can be measured on this toolchain.
 */
export function selectCandidate(outcomes: readonly CandidateOutcome[], contract: FunctionContract): string | null {
  const valid = outcomes.filter((outcome) => outcome.valid);
  if (valid.length === 0) return null;

  const bySpeed = [...valid].sort((left, right) => {
    const leftNs = left.benchmark?.durationNs ?? Number.POSITIVE_INFINITY;
    const rightNs = right.benchmark?.durationNs ?? Number.POSITIVE_INFINITY;
    return leftNs - rightNs;
  });
  const bySize = [...valid].sort((left, right) => (left.textSizeBytes ?? 0) - (right.textSizeBytes ?? 0));

  switch (contract.optimize.primary) {
    case "size":
      return bySize[0].candidate;
    case "latency":
    case "throughput":
    case "energy":
    case "balanced":
      return bySpeed[0].candidate;
  }
}

export async function generateCandidates(request: CodegenRequest): Promise<CodegenResult> {
  const benchmarkVector = selectBenchmarkVector(request.contract, request.parsed, request.test);
  const demoRequest = encodeRunRequest(request.contract, [selectDemoVector(request.parsed, request.test)]);
  const candidates: AssemblyCandidate[] = [];
  const outcomes: CandidateOutcome[] = [];

  for (const existing of request.existing) {
    candidates.push(existing);
    outcomes.push(await evaluateCandidate(request, existing, benchmarkVector, demoRequest));
    if (selectCandidate(outcomes, request.contract) !== null) {
      // Nothing was generated: the stored assembly is reused as it stands.
      return { candidates, outcomes, selected: selectCandidate(outcomes, request.contract), benchmarkVector, modelDurationNs: 0n };
    }
  }

  // One backend per run: it carries the state a session needs, such as which
  // recorded answer to serve next, but is not built until generation happens.
  let backend: AiBackend | null = null;
  const generationBackend = (): AiBackend => (backend ??= request.backend());

  let feedback: string[] | undefined;
  let attempt = request.existing.length;
  let valid = 0;
  let modelDurationNs = 0n;

  while (attempt < request.generation.maxAttempts && valid < request.generation.maxCandidates) {
    attempt += 1;
    request.onGenerate?.(attempt, request.generation.maxAttempts);
    const startedAt = process.hrtime.bigint();
    const candidate = await generationBackend().generate(
      {
        contract: request.contract,
        target: request.target,
        output: request.output,
        runtime: request.runtime,
        feedback,
        attempt,
      },
      attempt,
    );
    modelDurationNs += process.hrtime.bigint() - startedAt;
    candidates.push(candidate);

    const outcome = await evaluateCandidate(request, candidate, benchmarkVector, demoRequest);
    outcomes.push(outcome);
    if (outcome.valid) {
      valid += 1;
      feedback = undefined;
      continue;
    }
    feedback = feedbackFor(outcome.failure);
  }

  if (candidates.length === 0) {
    throw new CompilerError({
      category: "AiGenerationError",
      stage: "generate",
      message: "no assembly candidate was produced",
      function: request.contract.function.name,
    });
  }

  return { candidates, outcomes, selected: selectCandidate(outcomes, request.contract), benchmarkVector, modelDurationNs };
}

/* -------------------------------------------------------------------------- */
/* Stored candidates                                                          */
/* -------------------------------------------------------------------------- */

export interface StoredCandidateResult {
  verification?: VerificationResult;
  benchmark?: BenchmarkResult;
}

export type StoredCandidateRequest = CandidateEvaluationRequest & { candidate: AssemblyCandidate };

/**
 * Re-runs assembly, linking, verification and benchmarking for a stored
 * candidate. Used by `blaze test` and `blaze benchmark`.
 */
export async function evaluateStoredCandidate(request: StoredCandidateRequest): Promise<StoredCandidateResult> {
  const benchmarkVector = selectBenchmarkVector(request.contract, request.parsed, request.test);
  const demoRequest = encodeRunRequest(request.contract, [selectDemoVector(request.parsed, request.test)]);
  const outcome = await evaluateCandidate(
    {
      contract: request.contract,
      parsed: request.parsed,
      target: request.contract.target,
      output: request.output,
      runtime: request.runtime,
      workspace: request.workspace,
      test: request.test,
      benchmark: request.benchmark,
    },
    request.candidate,
    benchmarkVector,
    demoRequest,
  );
  if (!outcome.valid) {
    throw new CompilerError({
      category: outcome.failure?.category === "VerificationError" ? "VerificationError" : "AssemblyError",
      stage: outcome.failure?.stage ?? "verify",
      message: outcome.failure?.message ?? `candidate ${request.candidate.id} is not valid`,
      function: request.contract.function.name,
      candidate: request.candidate.id,
      detail: outcome.failure?.detail,
    });
  }
  const result: StoredCandidateResult = {};
  if (outcome.verification !== undefined) result.verification = outcome.verification;
  if (outcome.benchmark !== undefined) result.benchmark = outcome.benchmark;
  return result;
}

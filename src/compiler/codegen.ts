/**
 * Code generation.
 *
 * A candidate is generated once and then repaired in place. Assembling,
 * linking, running and verifying it happen in that order, and every diagnostic
 * that rejects it is collected and handed back for the next attempt, so
 * assembler errors and failing test vectors lead to corrected candidates
 * instead of a dead end. Candidates are independent: a repair inherits the
 * history of its own candidate and nothing else.
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
import { buildStandaloneRuntime, writeRuntimeHeader, type StandaloneRuntime } from "./runtime/standalone.ts";
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CompilerError, toCompilerError } from "./core/errors.ts";
import type { AiBackend } from "./ai/backend.ts";
import type { ProgramFailure } from "./ai/prompt.ts";
import type { ParsedContract } from "./semantics/contract.ts";
import { encodeRunRequest, selectDemoVector, verifyCandidate, type TestVector } from "./toolchain/verifier.ts";
import type {
  AssemblyCandidate,
  BenchmarkConfig,
  BenchmarkResult,
  CandidateOutcome,
  FunctionContract,
  ProgramContract,
  RuntimeKind,
  GenerationConfig,
  OutputKind,
  Runner,
  SourceModule,
  TargetSpec,
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

/** Where a build stands in the candidate/attempt loop, for progress reporting. */
export interface GenerationProgress {
  /** The candidate being produced, 1-based. */
  candidate: number;
  /** How many candidates the build will produce. */
  candidates: number;
  /** The attempt within that candidate, 1-based. The first generates. */
  attempt: number;
  /** How many attempts that candidate is allowed. */
  attempts: number;
  /** True when this attempt repairs a rejected candidate rather than generating one. */
  repair: boolean;
}

export interface CodegenRequest extends CandidateEvaluationRequest {
  contract: FunctionContract;
  parsed: ParsedContract;
  /** The file that declares the contract, which the prompt reads as the source. */
  unitFile: string;
  /** The whole program, contracted: what a backend needs about every file. */
  program: ProgramContract;
  /** Every module of the program, with the source each contract came from. */
  sources: readonly SourceModule[];
  target: TargetSpec;
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
   * What the program printed where its source prints something else, with the
   * implementation this function contributed to it. A contract that states
   * what a function does has no vector of its own, so the program is the only
   * oracle it has, and this is the only diagnostic such a function ever gets.
   */
  programFailure?: ProgramFailure;
  /**
   * Where this round's candidate numbering starts. A build that regenerates
   * after a program mismatch passes what the round before it wrote, so the two
   * rounds name different implementations on disk.
   */
  sequenceStart?: number;
  /**
   * Called just before a request goes out. A model can take minutes, so the
   * compiler says it is waiting rather than looking stuck.
   */
  onGenerate?: (progress: GenerationProgress) => void;
}

export interface CodegenResult {
  candidates: AssemblyCandidate[];
  outcomes: CandidateOutcome[];
  selected: string | null;
  /** The vector a verified candidate is measured on, or null for a contract
   *  that returns no value to measure. */
  benchmarkVector: TestVector | null;
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

/**
 * One diagnostic, attributed to the attempt that earned it. Diagnostics
 * accumulate within a candidate, so a repair sees everything that was already
 * wrong as well as what this round reported.
 */
function diagnosticFor(failure: CandidateOutcome["failure"], attempt: number): string {
  if (failure === undefined) return `[attempt ${attempt}] rejected: the candidate did not satisfy the contract`;
  const detail = failure.detail === undefined || failure.detail.trim() === "" ? "" : `\n${failure.detail.trim()}`;
  return `[attempt ${attempt}] ${failure.stage} failed: ${failure.message}${detail}`;
}

/** Everything evaluating one candidate needs, with or without a backend. */
export interface CandidateEvaluationRequest {
  contract: FunctionContract;
  parsed: ParsedContract;
  target: TargetSpec;
  output: OutputKind;
  workspace: CodegenWorkspace;
  test: TestConfig;
  benchmark: BenchmarkConfig;
  runtime: RuntimeKind;
  /**
   * Writes and compiles the compiler runtime, once for the whole build. Every
   * native candidate links against the same runtime, and candidates can be
   * generated at the same time, so two of them writing the same header would
   * race. Returns undefined for a WebAssembly build, which links no runtime.
   */
  prepareRuntime: () => Promise<StandaloneRuntime | undefined>;
}

/**
 * Builds the runtime once and hands the same one to every candidate. Callers
 * own the result, so nothing is shared but the promise.
 */
export function runtimePreparer(request: {
  output: OutputKind;
  runtime: RuntimeKind;
  workspace: CodegenWorkspace;
}): () => Promise<StandaloneRuntime | undefined> {
  let pending: Promise<StandaloneRuntime | undefined> | null = null;
  return () => {
    pending ??= (async (): Promise<StandaloneRuntime | undefined> => {
      if (request.output === "wasm") return undefined;
      if (request.runtime === "none") return buildStandaloneRuntime(request.workspace.workDirectory);
      await writeRuntimeHeader(request.workspace.workDirectory);
      return undefined;
    })();
    return pending;
  };
}

/** A candidate built far enough to be executed. */
export interface Materialized {
  runner: Runner;
  sizeBytes: number;
  textSizeBytes: number;
  implementationPath: string;
}


/** The vectors a candidate is verified and measured with. */
interface PlannedVectors {
  /** The vector the benchmark runs, and the example run the harness carries. */
  benchmark: TestVector;
  demo: string;
}

/**
 * Vectors for a contract that states what a function returns, planned once for
 * a whole unit. A contract that states what a function does has none: the
 * protocol passes scalars and buffers, so a parameter it cannot carry, such as
 * a reference to an object, is not something to plan a vector for, and there
 * is no returned value to compare either. The program such a function belongs
 * to is what says whether the two agree.
 */
function planVectors(request: CandidateEvaluationRequest): PlannedVectors | null {
  if (request.parsed.resultDefinition === null) return null;
  return {
    benchmark: selectBenchmarkVector(request.contract, request.parsed, request.test),
    demo: encodeRunRequest(request.contract, [selectDemoVector(request.parsed, request.test)]),
  };
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
  vectors: PlannedVectors | null,
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
  // include it, and the harness always does. It is written and compiled once
  // for the whole build, not once per candidate.
  const runtime = await request.prepareRuntime();

  const object =
    request.output === "c"
      ? await compileC({
          source: candidate.assembly,
          contract: request.contract,
          target: request.target,
          sourcePath: paths.implementation,
          objectPath: paths.object,
          candidate: candidate.id,
          ...(runtime === undefined ? {} : { includeDirectories: [dirname(runtime.headerPath)] }),
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
    await writeFile(paths.harness, generateHarness(request.contract, vectors?.demo ?? ""), "utf8");
    link({
      harnessPath: paths.harness,
      objectPath: paths.object,
      runtimeObjectPath: runtime.objectPath,
      includeDirectories: [dirname(runtime.headerPath)],
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
    demoRequest: vectors?.demo ?? "",
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
  vectors: PlannedVectors | null,
): Promise<CandidateOutcome> {
  const paths = pathsFor(request.workspace, candidate.id, request.output);
  try {
    const built = await materialize(request, candidate, paths, vectors);

    // A contract that states what a function does rather than what it returns
    // has no vector to run: the candidate is built, and the program it belongs
    // to says whether the two print the same thing.
    if (vectors === null) {
      return {
        candidate: candidate.id,
        valid: true,
        textSizeBytes: built.textSizeBytes,
        objectSizeBytes: built.sizeBytes,
      };
    }

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
      vector: vectors.benchmark,
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
  const vectors = planVectors(request);
  const candidates: AssemblyCandidate[] = [];
  const outcomes: CandidateOutcome[] = [];

  for (const existing of request.existing) {
    candidates.push(existing);
    outcomes.push(await evaluateCandidate(request, existing, vectors));
    if (selectCandidate(outcomes, request.contract) !== null) {
      // Nothing was generated: the stored assembly is reused as it stands.
      return { candidates, outcomes, selected: selectCandidate(outcomes, request.contract), benchmarkVector: vectors?.benchmark ?? null, modelDurationNs: 0n };
    }
  }

  // One backend per run: it carries the state a session needs, such as which
  // recorded answer to serve next, but is not built until generation happens.
  let backend: AiBackend | null = null;
  const generationBackend = (): AiBackend => (backend ??= request.backend());

  const { maxAttempts, maxCandidates, concurrency } = request.generation;
  // Candidate records are numbered from the stored ones and from whatever a
  // previous round of this build already wrote, so a build that regenerates
  // after a program mismatch never writes over the candidates it is replacing.
  const firstSequence = request.existing.length + (request.sequenceStart ?? 0);
  let modelDurationNs = 0n;

  // Each candidate owns a contiguous block of records and collects its own, so
  // the build reads the same way whatever order the candidates finish in.
  const chains = Array.from({ length: maxCandidates }, () => ({
    candidates: [] as AssemblyCandidate[],
    outcomes: [] as CandidateOutcome[],
  }));

  // Candidates are independent chains. One is generated from the contract
  // alone, or from the implementation a program rejected when the build is
  // repairing a program, and is then repaired in place for as long as the
  // toolchain rejects it; a repair receives everything that candidate has
  // collected so far, not just the last round, and nothing crosses into the
  // next candidate. A candidate only ever waits on its own previous attempt, so
  // chains overlap: a repair runs while the candidates that are still
  // generating keep going.
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < chains.length) {
      const index = next;
      next += 1;
      const chain = chains[index];
      const candidate = index + 1;
      const diagnostics: string[] = [];
      // A program that printed something other than what its source prints is
      // the only diagnostic a contract of this shape ever earns, so a round
      // generated after one repairs the implementation that produced it rather
      // than starting blind from the contract.
      let previous = request.programFailure?.previous;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        request.onGenerate?.({
          candidate,
          candidates: maxCandidates,
          attempt,
          attempts: maxAttempts,
          repair: previous !== undefined,
        });
        const startedAt = process.hrtime.bigint();
        const generated = await generationBackend().generate(
          {
            contract: request.contract,
            unit: { file: request.unitFile, function: request.contract.function.name },
            program: request.program,
            sources: request.sources,
            target: request.target,
            output: request.output,
            runtime: request.runtime,
            candidate,
            candidates: maxCandidates,
            attempt,
            ...(previous === undefined ? {} : { previous }),
            ...(request.programFailure === undefined ? {} : { programFailure: request.programFailure }),
            ...(diagnostics.length === 0 ? {} : { feedback: [...diagnostics] }),
          },
          firstSequence + index * maxAttempts + attempt,
        );
        modelDurationNs += process.hrtime.bigint() - startedAt;
        chain.candidates.push(generated);
        previous = generated.assembly;

        // Verification and benchmarking are blocking, so candidates are measured
        // one at a time even though they were generated together.
        const outcome = await evaluateCandidate(request, generated, vectors);
        chain.outcomes.push(outcome);
        if (outcome.valid) break;
        diagnostics.push(diagnosticFor(outcome.failure, attempt));
      }
    }
  };

  const workers = Math.max(1, Math.min(concurrency, maxCandidates));
  // A request that fails outright fails the build, so every chain is allowed to
  // settle before the first failure is reported: a chain that is still running
  // must not go on writing work files after the build has given up on it.
  const settled = await Promise.allSettled(Array.from({ length: workers }, () => worker()));
  const failure = settled.find((entry) => entry.status === "rejected");
  if (failure !== undefined && failure.status === "rejected") throw failure.reason;

  for (const chain of chains) {
    candidates.push(...chain.candidates);
    outcomes.push(...chain.outcomes);
  }

  if (candidates.length === 0) {
    throw new CompilerError({
      category: "AiGenerationError",
      stage: "generate",
      message: "no assembly candidate was produced",
      function: request.contract.function.name,
    });
  }

  return { candidates, outcomes, selected: selectCandidate(outcomes, request.contract), benchmarkVector: vectors?.benchmark ?? null, modelDurationNs };
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
  const vectors = planVectors(request);
  const outcome = await evaluateCandidate(
    {
      contract: request.contract,
      parsed: request.parsed,
      target: request.target,
      output: request.output,
      runtime: request.runtime,
      workspace: request.workspace,
      test: request.test,
      benchmark: request.benchmark,
      prepareRuntime: request.prepareRuntime,
    },
    request.candidate,
    vectors,
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

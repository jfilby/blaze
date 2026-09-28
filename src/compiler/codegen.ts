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

import { benchmarkCandidate, selectBenchmarkVector } from "./toolchain/benchmark.ts";
import { buildModule } from "./toolchain/ir-wasm.ts";
import { compileFunctionC } from "./toolchain/ir-c.ts";
import { parseSemanticFunction } from "./semantics/ir-text.ts";
import { validateSemanticFunction } from "./semantics/ir-validate.ts";
import { generateHarness, generateProbeHarness, link } from "./toolchain/linker.ts";
import { planProbe, type ProbePlan } from "./toolchain/probe.ts";
import { buildHostProgram } from "./runtime/nim.ts";
import { buildStandaloneRuntime, writeRuntimeHeader } from "./runtime/standalone.ts";

/**
 * What a build prepared once and then hands to every candidate: the ABI header
 * the C the compiler wrote includes, and the C runtime object to link it
 * against. The two are separate because they have separate lives: a hosted
 * build writes the header and links no C runtime, since the host program is
 * what carries the runtime services. A candidate of a hosted build still needs
 * the header on its include path, so the header is reported either way.
 */
export interface PreparedRuntime {
  headerPath: string;
  /** Absent for a hosted build: the host program links, so there is no C object. */
  objectPath?: string;
}
import { stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CompilerError, toCompilerError } from "./core/errors.ts";
import type { SemanticFunction } from "./core/semantic-ir.ts";
import { run, GENERATED_HEAP_BYTES, type RunResult } from "./core/process.ts";
import { EXECUTABLE_SUFFIX } from "./core/target.ts";
import type { AiBackend } from "./ai/backend.ts";
import type { ProgramFailure } from "./ai/prompt.ts";
import type { ParsedContract } from "./semantics/contract.ts";
import { encodeRunRequest, selectDemoVector, verifyCandidate, type TestVector } from "./toolchain/verifier.ts";
import type {
  Candidate,
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
import type { IncrementalEntry } from "./incremental.ts";

/** How each output kind is named in stage messages. */
const IMPLEMENTATION_LABEL: Record<OutputKind, string> = {
  c: "C",
  asm: "assembly",
  machine: "assembly",
  wasm: "WebAssembly",
  ir: "semantic IR",
};

/**
 * What the generate stage names, which is what the model is writing there: the
 * IR, on every kind. The kind only says how far the toolchain takes that one
 * answer, so the line names the delivery the build asked for and leaves the
 * name of the language itself to the stage that produces it — before one of
 * them, nothing of that language exists.
 */
export function generationLabel(output: OutputKind): string {
  return output === "ir" ? "semantic IR" : `semantic IR for ${implementationLabel(output)} output`;
}

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
  /**
   * Every function of the program as the IR holds it, by name. The prompt
   * reads a function from here rather than from its source statements, so what
   * a model reasons about is the same description a backend is given.
   */
  semantics: Record<string, SemanticFunction>;
  /** Every module of the program, with the source each contract came from. */
  sources: readonly SourceModule[];
  target: TargetSpec;
  output: OutputKind;
  /**
   * Built on demand: a build that reuses stored candidates must not need model
   * configuration, because it never asks a model anything.
   */
  backend: () => AiBackend;
  generation: GenerationConfig;
  test: TestConfig;
  benchmark: BenchmarkConfig;
  workspace: CodegenWorkspace;
  /** Candidates from a previous build, tried before asking the model again. */
  existing: Candidate[];
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
  candidates: Candidate[];
  outcomes: CandidateOutcome[];
  selected: string | null;
  /** The vector a verified candidate is measured on, or null for a contract
   *  that returns no value to measure. */
  benchmarkVector: TestVector | null;
  /** Wall clock time spent waiting for the model, in nanoseconds. */
  modelDurationNs: bigint;
}

interface CandidatePaths {
  /** The IR the model wrote, which every output kind answers in. */
  implementation: string;
  /** The text the compiler lowered that IR into, which is the deliverable. */
  lowered: string;
  /** The C the compiler wrote, which is gcc's input and is not the deliverable except for a `c` build. */
  loweredSource: string;
  object: string;
  harness: string;
  /** The harness that calls a definition-contract candidate once, and its binary. */
  probeHarness: string;
  probeExecutable: string;
  executable: string;
  module: string;
  host: string;
}

/**
 * Where a candidate's files are, by name. One place decides them, so what a
 * build delivers and what it looks for on disk to reuse a candidate cannot
 * drift apart.
 *
 * Every output kind answers in the IR, so the implementation is the IR on
 * every one of them, and what differs is the text the compiler lowered it
 * into: the C it wrote for a `c` build, the assembly the C compiler made of
 * that C for an `asm` or `machine` build, and the module for a `wasm` one.
 */
function candidateFiles(workspace: CodegenWorkspace, candidate: string, output: OutputKind): CandidatePaths {
  const base = `${workspace.workDirectory}/${candidate}`;
  // A `c` build delivers the C, so for that kind the C is the lowered text. For
  // every other kind the lowered text is the assembly gcc makes of the C, and
  // the C is named apart from it: the two are different files, and giving the
  // C the deliverable's own name wrote `c1.c.c` beside a `c1.c` that was never
  // written, so nothing could be delivered.
  const deliveringC = output === "c";
  return {
    implementation: `${base}.ir`,
    lowered: `${base}.${deliveringC ? "c" : "s"}`,
    loweredSource: deliveringC ? `${base}.c` : `${base}.lower.c`,
    object: `${base}.o`,
    harness: `${base}.harness.c`,
    probeHarness: `${base}.probe.c`,
    probeExecutable: `${base}.probe${EXECUTABLE_SUFFIX}`,
    executable: `${base}${EXECUTABLE_SUFFIX}`,
    module: `${base}.wasm`,
    host: `${base}.host.mjs`,
  };
}

/**
 * Every file a build consumes from a candidate it did not rebuild: what it
 * delivers, and the object it links when the deliverable is a program. A
 * candidate whose files are not all here is rebuilt from its stored
 * implementation rather than reused, so nothing is delivered that is missing.
 *
 * A candidate that calls another function of the program has no executable of
 * its own, because the program is the only thing that can link it. The IR is
 * what says so, and requiring the executable anyway would report a file that
 * was never written as one that went missing, and rebuild the candidate on
 * every build for the life of the project.
 */
export function reusableFiles(
  workspace: CodegenWorkspace,
  candidate: string,
  output: OutputKind,
  linksObjects: boolean,
  /**
   * Whether the candidate links on its own. A stored one says so by the calls
   * its IR holds, and the build that stored it knew.
   */
  standalone: boolean,
): string[] {
  const paths = candidateFiles(workspace, candidate, output);
  const delivered = output === "ir" ? paths.implementation : paths.lowered;
  if (output === "machine") {
    return [
      delivered,
      ...(standalone ? [paths.executable] : []),
      ...(linksObjects ? [paths.object] : []),
    ];
  }
  if (output === "wasm") return [delivered, paths.module];
  return [delivered];
}

/**
 * A result that is not the result of this build: the candidates and outcomes
 * an earlier build stored, and the candidate it selected among them. Nothing
 * was assembled, linked, verified or measured, and no model was asked, so the
 * time spent waiting for one is nothing.
 */
export function reusedResult(entry: IncrementalEntry): CodegenResult {
  return {
    candidates: entry.candidates,
    outcomes: entry.outcomes,
    selected: entry.selected,
    benchmarkVector: entry.benchmarkVector,
    modelDurationNs: 0n,
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

/**
 * Runs one task at a time, in the order the tasks arrive.
 *
 * Candidates are compared on measured speed, and a measurement only means
 * something when nothing else is competing for the machine. So assembly,
 * linking, verification and benchmarking never overlap: not between the
 * candidates of one function, and not between the functions a build generates
 * at the same time. What overlaps is the waiting, which is where the time goes.
 */
export interface Exclusive {
  run<T>(task: () => Promise<T>): Promise<T>;
}

/**
 * A lock the tasks queue on. A task that fails releases it for the next one: a
 * function that could not be built must not strand every function queued
 * behind it.
 */
export function exclusive(): Exclusive {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const result = tail.then(task, task);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}

export interface CandidateEvaluationRequest {
  /**
   * The other functions this build compiles, by symbol. A candidate may call
   * them: the build links the objects together, so a call is a call rather than
   * a reimplementation. A candidate that makes one cannot be linked on its own,
   * so the program it belongs to is what runs it.
   */
  callable: ReadonlySet<string>;
  contract: FunctionContract;
  parsed: ParsedContract;
  /** The whole program, contracted: what an IR candidate is bound to. */
  program: ProgramContract;
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
  prepareRuntime: () => Promise<PreparedRuntime | undefined>;
  /**
   * The machine, one user at a time. Every candidate of every function of a
   * build is measured through this one, so a build may generate as many
   * functions at a time as it likes without two candidates being timed against
   * each other.
   */
  exclusive: Exclusive;
}

/**
 * Builds the runtime once and hands the same one to every candidate. Callers
 * own the result, so nothing is shared but the promise.
 */
export function runtimePreparer(request: {
  output: OutputKind;
  runtime: RuntimeKind;
  workspace: CodegenWorkspace;
}): () => Promise<PreparedRuntime | undefined> {
  let pending: Promise<PreparedRuntime | undefined> | null = null;
  return () => {
    pending ??= (async (): Promise<PreparedRuntime | undefined> => {
      if (request.output === "wasm") return undefined;
      if (request.runtime === "none") return buildStandaloneRuntime(request.workspace.workDirectory);
      return { headerPath: await writeRuntimeHeader(request.workspace.workDirectory) };
    })();
    return pending;
  };
}

/**
 * A candidate built far enough to be executed. `runner` is null for a candidate
 * that calls another function of the program: it is assembled, but the program
 * it belongs to is the only thing that can link and run it.
 */
export interface Materialized {
  runner: Runner | null;
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
 * The IR a candidate answered with, bound to the contract it is an
 * implementation of and checked against it. A candidate that is not a program
 * the compiler may lower is refused here, before anything is compiled, and the
 * diagnostics are the ones a repair round is given.
 */
export function readSemanticCandidate(
  candidate: Candidate,
  program: ProgramContract,
  contract: FunctionContract,
): SemanticFunction {
  const fn = parseSemanticFunction(candidate.text, program);
  validateSemanticFunction(fn, contract);
  return fn;
}

/**
 * Turns model output into something executable.
 *
 * Every output kind answers in the same language and is lowered the same way,
 * so this is the only place a candidate becomes an object or a module: the
 * model wrote the IR, the compiler checked it against the contract and is now
 * the one that wrote the target, so nothing the model wrote is ever compiled.
 * What the build delivers is the text that lowering produced, and what a size
 * objective weighs is that text rather than the IR, which is the same for
 * every candidate and so would order them by nothing at all.
 */
async function materialize(
  request: CandidateEvaluationRequest,
  candidate: Candidate,
  paths: CandidatePaths,
  vectors: PlannedVectors | null,
  /** The IR the model wrote, which every output kind answers in. */
  fn: SemanticFunction,
  /**
   * Whether the candidate can be linked on its own. One that calls another
   * function of the program cannot: the object it needs is another
   * candidate's, and which one is not settled until every candidate has been.
   */
  standalone: boolean,
): Promise<Materialized> {
  if (request.output === "wasm") {
    const module = await buildModule({
      fn,
      contract: request.contract,
      modulePath: paths.module,
      hostPath: paths.host,
      candidate: candidate.id,
    });
    return {
      runner: module.runner,
      sizeBytes: module.moduleSizeBytes,
      textSizeBytes: (await stat(paths.implementation)).size,
      implementationPath: paths.implementation,
    };
  }
  // The ABI header exists before the candidate is compiled: the C the compiler
  // wrote includes it, and the harness always does. It is written and compiled
  // once for the whole build, not once per candidate.
  const runtime = await request.prepareRuntime();
  // A `c` build delivers the C the compiler wrote, an `asm` or `machine` one
  // the assembly the C compiler made of it, and an `ir` one the IR itself.
  // Only the last is what the model wrote, and it is the same for every
  // candidate, so a size objective weighs the text below rather than it.
  const deliversAssembly = request.output === "asm" || request.output === "machine";
  const lowered = await compileFunctionC({
    fn,
    contract: request.contract,
    target: request.target,
    sourcePath: paths.loweredSource,
    objectPath: paths.object,
    ...(runtime === undefined ? {} : { includeDirectories: [dirname(runtime.headerPath)] }),
    ...(deliversAssembly ? { assemblyPath: paths.lowered } : {}),
  });
  // The lowering weighs what the build delivers: the assembly when it asked
  // for one, the C otherwise. An `ir` build delivers the model-written IR,
  // which is the same text for every candidate and orders them by nothing.
  const textSizeBytes =
    request.output === "ir" ? (await stat(paths.implementation)).size : lowered.textSizeBytes;
  const object = { objectSizeBytes: lowered.objectSizeBytes };
  if (!standalone) {
    // Assembled, but not linked: the program this candidate is part of is the
    // one that has to run it, and it is linked once every candidate is chosen.
    return { runner: null, sizeBytes: object.objectSizeBytes, textSizeBytes, implementationPath: paths.implementation };
  }

  // A build that links the C runtime runs the candidate in a C harness. A
  // hosted build has no such object: the host program is what runs it.
  if (runtime?.objectPath !== undefined) {
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
      textSizeBytes,
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
    textSizeBytes,
    implementationPath: paths.implementation,
  };
}


export function implementationLabel(output: OutputKind): string {
  return IMPLEMENTATION_LABEL[output];
}

/**
 * A candidate built, verified and measured, with the machine to itself. Every
 * path that measures a candidate comes through here, so no candidate is ever
 * timed while another one is being measured.
 */
async function evaluateCandidate(
  request: CandidateEvaluationRequest,
  candidate: Candidate,
  vectors: PlannedVectors | null,
): Promise<CandidateOutcome> {
  return request.exclusive.run(() => measureCandidate(request, candidate, vectors));
}

async function measureCandidate(
  request: CandidateEvaluationRequest,
  candidate: Candidate,
  vectors: PlannedVectors | null,
): Promise<CandidateOutcome> {
  const paths = candidateFiles(request.workspace, candidate.id, request.output);
  try {
    // The IR is the implementation and is kept beside whatever it lowers
    // into, because it is what the model wrote, what a later round is shown and
    // what a build that failed on it leaves behind to be read. It is written
    // before it is read rather than once it has been lowered, so that a
    // candidate the reader refused is on disk beside the ones it accepted: a
    // refusal that names a line of the IR and leaves no copy of the IR is a
    // diagnostic nothing can be done about.
    await writeFile(paths.implementation, candidate.text, "utf8");

    // A candidate may call the other functions of the program, and one that does
    // is linked only into the program, so nothing about it can be run on its own.
    // The program is the oracle for it, which is where a definition contract
    // already sends its candidate. Every output kind answers in the IR, so
    // this is where one candidate is read on every kind — and a candidate that
    // is not a program the compiler may lower is refused here, inside the
    // refusal path, where a diagnostic comes of it and a repair round is given
    // the reason.
    const fn = readSemanticCandidate(candidate, request.program, request.contract);
    const calls = fn.calls.map((edge) => edge.callee).filter((callee) => request.callable.has(callee));
    const built = await materialize(request, candidate, paths, vectors, fn, calls.length === 0);

    // A candidate that calls another function of the program is judged by that
    // program and by nothing else: there is no standalone binary to probe and
    // no vector to run it against, so it is carried to the program round.
    if (calls.length > 0) {
      return {
        candidate: candidate.id,
        valid: true,
        probe: { called: false, reason: `it calls ${calls.join(", ")}, so the program it belongs to is what runs it` },
        textSizeBytes: built.textSizeBytes,
        objectSizeBytes: built.sizeBytes,
      };
    }

    // A contract that states what a function does rather than what it returns
    // has no vector to verify against, so the candidate is called once on an
    // input built from the contract instead. That settles whether it can be
    // executed at all; the program it belongs to is what says whether the two
    // agree, and it keeps that job.
    if (vectors === null) {
      const probe = await probeCandidate(request, paths, planProbe(request.contract, request.parsed));
      if (probe.reason !== null && probe.called) {
        return {
          candidate: candidate.id,
          valid: false,
          failure: {
            category: "VerificationError",
            stage: "verify",
            message: `candidate ${candidate.id}: ${request.contract.function.name} liveness check failed: ${probe.reason}`,
            detail: [
              "The candidate was called once on an input built from its contract and the result was not read, so this says nothing about what it computes.",
              `The program ${request.contract.function.name} belongs to is what says whether the two agree.`,
              ...(probe.stderr.trim() === "" ? [] : [`the candidate wrote to standard error:\n${probe.stderr.trim()}`]),
            ].join("\n"),
          },
          probe: { called: probe.called, reason: probe.reason },
          textSizeBytes: built.textSizeBytes,
          objectSizeBytes: built.sizeBytes,
        };
      }
      return {
        candidate: candidate.id,
        valid: true,
        probe: { called: probe.called, reason: probe.reason },
        textSizeBytes: built.textSizeBytes,
        objectSizeBytes: built.sizeBytes,
      };
    }

    // Reached only when the candidate is standalone, which is what leaves it
    // with a binary to run its vectors against.
    if (built.runner === null) {
      throw new CompilerError({
        category: "LinkError",
        stage: "link",
        message: `candidate ${candidate.id} produced no binary to verify`,
        function: request.contract.function.name,
        candidate: candidate.id,
      });
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
 * A candidate called once on an input built from its own contract, and whether
 * the call came back.
 */
interface ProbeOutcome {
  /** Whether the call was made at all. */
  readonly called: boolean;
  /** What stopped it, or why it was not made. Null when it came back. */
  readonly reason: string | null;
  readonly stderr: string;
}

/** How long a call on a defaulted input may take before it is a fault. */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * Calls a definition-contract candidate once and reports whether it came back.
 *
 * The result is discarded and nothing is compared with the source, so a
 * candidate that returns the wrong answer passes this. What is settled here is
 * the one defect the program cannot report cheaply: finding out there costs a
 * round of the program and a regeneration of every function in it, rather than
 * of the one that is wrong.
 */
async function probeCandidate(
  request: CandidateEvaluationRequest,
  paths: CandidatePaths,
  plan: ProbePlan,
): Promise<ProbeOutcome> {
  if (plan.kind === "skip") return { called: false, reason: plan.reason, stderr: "" };
  // The probe links the object the C toolchain links, so it runs for every
  // kind that produces one, whatever text that object was lowered from. A
  // `wasm` build produces a module instead, and the host that runs a module
  // is what calls it there.
  if (request.output === "wasm") {
    return { called: false, reason: "a wasm candidate is run by its module host, not the native probe", stderr: "" };
  }
  const runtime = await request.prepareRuntime();
  if (runtime?.objectPath === undefined) {
    return { called: false, reason: "the build links no runtime for the probe to call into", stderr: "" };
  }

  await writeFile(paths.probeHarness, generateProbeHarness(request.contract, plan), "utf8");
  link({
    harnessPath: paths.probeHarness,
    objectPath: paths.object,
    runtimeObjectPath: runtime.objectPath,
    includeDirectories: [dirname(runtime.headerPath)],
    outputPath: paths.probeExecutable,
    functionName: request.contract.function.name,
  });

  const result = await run(paths.probeExecutable, [], {
    timeoutMs: PROBE_TIMEOUT_MS,
    heapBytes: GENERATED_HEAP_BYTES,
  });
  return { called: true, reason: probeFault(result), stderr: result.stderr };
}

/**
 * How a run that did not come back is described, or null when it did. A run
 * stopped at the deadline is reported as that first: it started, so it is
 * neither a probe that failed to launch nor a candidate that ran and failed.
 */
export function probeFault(result: RunResult): string | null {
  if (result.timedOut) return `the candidate did not return within ${PROBE_TIMEOUT_MS / 1000} seconds`;
  if (result.spawnError !== undefined) return `the probe did not start: ${result.spawnError}`;
  if (result.signal !== null) return `the candidate was killed by ${result.signal}`;
  if (result.code !== 0) return `the candidate exited with status ${result.code}`;
  return null;
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
  const candidates: Candidate[] = [];
  const outcomes: CandidateOutcome[] = [];

  for (const existing of request.existing) {
    candidates.push(existing);
    outcomes.push(await evaluateCandidate(request, existing, vectors));
    if (selectCandidate(outcomes, request.contract) !== null) {
      // Nothing was generated: the stored candidate is reused as it stands.
      return { candidates, outcomes, selected: selectCandidate(outcomes, request.contract), benchmarkVector: vectors?.benchmark ?? null, modelDurationNs: 0n };
    }
  }

  // One backend per run: it carries the state a session needs, such as which
  // recorded answer to serve next, but is not built until generation happens.
  let backend: AiBackend | null = null;
  const generationBackend = (): AiBackend => (backend ??= request.backend());

  const { maxAttempts, maxCandidates, candidateConcurrency } = request.generation;
  // Candidate records are numbered from the stored ones and from whatever a
  // previous round of this build already wrote, so a build that regenerates
  // after a program mismatch never writes over the candidates it is replacing.
  const firstSequence = request.existing.length + (request.sequenceStart ?? 0);
  let modelDurationNs = 0n;

  // Each candidate owns a contiguous block of records and collects its own, so
  // the build reads the same way whatever order the candidates finish in.
  const chains = Array.from({ length: maxCandidates }, () => ({
    candidates: [] as Candidate[],
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
            semantics: request.semantics,
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
        previous = generated.text;

        // Verification and benchmarking are blocking, so candidates are measured
        // one at a time even though they were generated together.
        const outcome = await evaluateCandidate(request, generated, vectors);
        chain.outcomes.push(outcome);
        if (outcome.valid) break;
        diagnostics.push(diagnosticFor(outcome.failure, attempt));
      }
    }
  };

  const workers = Math.max(1, Math.min(candidateConcurrency, maxCandidates));
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
      message: "no candidate was produced",
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

export type StoredCandidateRequest = CandidateEvaluationRequest & { candidate: Candidate };

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
      program: request.program,
      target: request.target,
      output: request.output,
      runtime: request.runtime,
      workspace: request.workspace,
      test: request.test,
      benchmark: request.benchmark,
      prepareRuntime: request.prepareRuntime,
      callable: request.callable,
      exclusive: request.exclusive,
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

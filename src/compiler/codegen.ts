/**
 * Code generation.
 *
 * Every candidate is a program the compiler wrote. The first one is the
 * semantic IR the compiler resolved from the source, before a model has seen
 * anything; each later one is that IR regenerated after a review proposed
 * fixes to it and the rules behind those fixes held. What is left is assembling,
 * linking, running and verifying, in that order, so every diagnostic that
 * rejects a candidate is collected and handed to the next review of it, and a
 * rejected round leads to a regenerated artifact rather than a dead end.
 *
 * A model never contributes a candidate. It is asked to read an artifact and to
 * name the rewrites it would make; the compiler applies them to its own tree,
 * revalidates what came out and lowers it again. The model decides which
 * candidate wins only in the sense that its review decides what each candidate
 * is: whether an artifact is correct is settled by running it.
 *
 * The compiler decides which candidate is valid and which one is selected.
 */

import { benchmarkCandidate, selectBenchmarkVector, type BenchmarkRequest } from "./toolchain/benchmark.ts";
import { buildModule, describeModule } from "./toolchain/ir-wasm.ts";
import { buildObject as buildMachineObject, describeMachineObject } from "./toolchain/ir-machine.ts";
import { compileFunctionC } from "./toolchain/ir-c.ts";
import { parseSemanticFunction, printSemanticFunction } from "./semantics/ir-text.ts";
import { validateSemanticFunction } from "./semantics/ir-validate.ts";
import { applyProposal, inlineCalls, type RepairContext } from "./semantics/repair.ts";
import { optimizeSemanticFunction } from "./semantics/optimize-ir.ts";
import { entryIsParallel } from "./semantics/parallel.ts";
import type { Threading } from "./core/target.ts";
import { generateHarness, generateProbeHarness, link } from "./toolchain/linker.ts";
import { planProbe, type ProbePlan } from "./toolchain/probe.ts";
import { buildHostProgram } from "./runtime/nim.ts";
import { buildStandaloneRuntime, writeRuntimeHeader } from "./runtime/standalone.ts";
import type { ReviewRequest, ReviewStage } from "./ai/review.ts";
import type { Review } from "./core/proposal.ts";

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
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CompilerError, toCompilerError } from "./core/errors.ts";
import type { SemanticFunction } from "./core/semantic-ir.ts";
import { run, GENERATED_HEAP_BYTES, type RunResult } from "./core/process.ts";
import { EXECUTABLE_SUFFIX } from "./core/target.ts";
import type { AiBackend } from "./ai/backend.ts";
import type { ParsedContract } from "./semantics/contract.ts";
import { encodeRunRequest, planTestVectors, selectDemoVector, verifyCandidate, type TestVector } from "./toolchain/verifier.ts";
import type {
  BackendKind,
  BuildMode,
  Candidate,
  BenchmarkConfig,
  BenchmarkResult,
  CandidateOutcome,
  FunctionContract,
  ProgramContract,
  ProgramFailure,
  RuntimeKind,
  GenerationConfig,
  OutputKind,
  Runner,
  TargetSpec,
  TestConfig,
  VerificationResult,
} from "./core/types.ts";
import type { IncrementalEntry } from "./incremental.ts";

/** How each output kind is named in stage messages. */
const IMPLEMENTATION_LABEL: Record<OutputKind, string> = {
  c: "C",
  asm: "assembly",
  // A `machine` build delivers an object. The `c` backend writes it with
  // `gcc -c` and the assembly beside it with `gcc -S`, so a review reads the
  // assembly and a size objective weighs it, and the assembly is never
  // assembled. The machine backend writes the object itself and delivers that.
  machine: "machine code",
  wasm: "WebAssembly",
  ir: "semantic IR",
};

/**
 * Where a build stands in the review loop, for progress reporting.
 */
/**
 * Where a build stands in the review loop, for progress reporting.
 */
export interface ReviewProgress {
  /** The artifact under review. */
  stage: ReviewStage;
  /** The candidate being produced, 1-based. */
  candidate: number;
  /** How many candidates the build will produce. */
  candidates: number;
  /** The round within that candidate, 1-based. The first reviews the resolved IR. */
  attempt: number;
  /** How many rounds that candidate is allowed. */
  attempts: number;
}

export interface CodegenWorkspace {
  /** Directory for intermediate artifacts: assembly, objects, harness, test binaries. */
  workDirectory: string;
  functionName: string;
}


export interface CodegenRequest extends CandidateEvaluationRequest {
  contract: FunctionContract;
  parsed: ParsedContract;
  /** The file that declares the contract, which the prompt reads as the source. */
  unitFile: string;
  /** The whole program, contracted: what a backend needs about every file. */
  program: ProgramContract;
  /**
   * The function the compiler resolved from the source, which is the artifact
   * every candidate starts from. What the frontend parsed and `ir-resolve.ts`
   * resolved is already a program every backend can lower, so a build starts
   * from it and a review may only rewrite it.
   */
  base: SemanticFunction;
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
  onReview?: (progress: ReviewProgress) => void;
  /**
   * Called with what the compiler rewrote and what it refused, so a build says
   * what it decided on its own and what it would not do, rather than only what
   * a model asked for.
   */
  onNote?: (note: string) => void;
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
  /** The IR the artifact is, which every output kind lowers. */
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
 * that C for an `asm` or `machine` one, the module for a `wasm` one, and
 * nothing at all for a `machine` backend, which writes the object itself.
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
  lowering: BackendKind,
  linksObjects: boolean,
  /**
   * Whether the candidate links on its own. A stored one says so by the calls
   * its IR holds, and the build that stored it knew.
   */
  standalone: boolean,
): string[] {
  const paths = candidateFiles(workspace, candidate, output);
  // What a build delivers is what its backend wrote: an object the compiler
  // encoded itself is delivered as the object, and everything else is
  // delivered as the text it was lowered into.
  const delivered = lowering === "machine" ? paths.object : output === "ir" ? paths.implementation : paths.lowered;
  if (lowering === "wasm") return [delivered, paths.module];
  // A kind that links a candidate on its own delivers the executable that
  // links, so the executable is a file the build consumes and one that is not
  // there is a candidate that has to be rebuilt. The `machine` branch below
  // always needs it, because nothing else links it; `ir` needs it only when
  // the candidate is standalone, which is what the call the program holds
  // decides.
  //
  // The object is a separate question and the answer does not depend on the
  // output kind: every kind that assembles writes one, and a program build
  // links it for every function it holds. Asking the executable question
  // first and returning its answer is what used to drop the object, so both
  // files are collected and the list is built once.
  const executable = output === "machine" || (output === "ir" && standalone);
  return [
    delivered,
    ...(executable ? [paths.executable] : []),
    ...(linksObjects ? [paths.object] : []),
  ];
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
 * The machine a build runs on, and the two ways work is admitted to it.
 *
 * A measurement only means something when nothing else is competing for the
 * machine, so a timed run is given the machine to itself: `measure` is a
 * measurement, and there is one of those at a time. Everything else a
 * candidate needs — writing its C, assembling it, linking it, running it
 * against its vectors — is work whose result is not a number, so nothing about
 * it is a measurement and `run` admits it alongside other such work. That is
 * the whole of what the serialisation was for, and a build that compiles five
 * candidates one after another spends most of its time on the part of the work
 * that was never timed.
 *
 * The two are one queue and not two locks: a measurement waits for whatever
 * shared work is on the machine, and shared work queues up behind a
 * measurement rather than pushing it to the back of everything. Neither phase
 * takes the machine and then asks for the other, which is what would make a
 * build wait for itself: the measurement is taken after the shared work has
 * given the machine back, not inside it.
 */
export interface Machine {
  /** Work whose result is not a number, run alongside other such work. */
  run<T>(task: () => T | Promise<T>): Promise<T>;
  /** A timed run, alone on the machine. */
  measure<T>(task: () => T | Promise<T>): Promise<T>;
}

/** Work that has asked for the machine and not been given it yet. */
interface Waiting {
  /** Whether it is a measurement, which is what the machine is held for. */
  readonly timed: boolean;
  /** Lets it on and counts it against the machine. */
  readonly admit: () => void;
}

/**
 * The queue the two phases of a candidate share. A task that fails gives the
 * machine back for the next one: a candidate that could not be built must not
 * strand every candidate queued behind it.
 */
export function machine(): Machine {
  const waiting: Waiting[] = [];
  let shared = 0;
  let timed = 0;

  /**
   * Lets on as much of the queue as the machine can carry, in the order it
   * arrived.
   *
   * Shared work ahead of a measurement is let on, because it is ahead of it
   * and running it is what lets the measurement be reached at all: refusing it
   * for the sake of a measurement queued behind it would leave that
   * measurement waiting for work that was itself waiting for it, and a build
   * would deadlock on its own queue. Shared work *behind* a measurement is
   * never let on ahead of it, so a build that keeps producing work cannot push
   * a measurement to the back of all of it. Because the queue is finite and
   * ordered, that is starvation-free: everything ahead of a measurement runs
   * once, and the measurement runs after it.
   */
  const drain = (): void => {
    while (waiting.length > 0 && timed === 0) {
      const next = waiting[0];
      // A measurement wants the machine to itself, so it waits for the shared
      // work already on it.
      if (next.timed && shared > 0) return;
      waiting.shift();
      next.admit();
      // Nothing behind a measurement runs until it has been taken and given
      // back, which `timed` already says.
      if (next.timed) return;
    }
  };

  const take = <T>(isTimed: boolean, task: () => T | Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      waiting.push({
        timed: isTimed,
        admit: () => {
          if (isTimed) timed += 1;
          else shared += 1;
          Promise.resolve()
            .then(task)
            .then(resolve, reject)
            .finally(() => {
              if (isTimed) timed -= 1;
              else shared -= 1;
              drain();
            });
        },
      });
      drain();
    });

  return {
    run: <T>(task: () => T | Promise<T>) => take(false, task),
    measure: <T>(task: () => T | Promise<T>) => take(true, task),
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
  /**
   * Every function of the program as the IR holds it, by name. A candidate is
   * folded against these, so a callee whose body may be put where its call was
   * is one the fold already has rather than one a backend would have to go and
   * resolve.
   */
  functions: Readonly<Record<string, SemanticFunction>>;
  output: OutputKind;
  /**
   * What lowered the IR. Named for the lowering rather than the model
   * transport, which this request also carries as `backend`.
   */
  lowering: BackendKind;
  /** How the toolchain builds this candidate, from the project's mode. */
  mode: BuildMode;
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
   * The machine every candidate of every function of a build is built and
   * measured on, so a build may generate as many functions at a time as it
   * likes without two candidates being timed against each other. What is not
   * measured is not serialised: the compiling and verifying of a candidate
   * runs alongside the compiling and verifying of the others, and only the
   * timing is given the machine to itself.
   */
  machine: Machine;
}

/**
 * Builds the runtime once and hands the same one to every candidate. Callers
 * own the result, so nothing is shared but the promise.
 */
export function runtimePreparer(request: {
  lowering: BackendKind;
  mode: BuildMode;
  runtime: RuntimeKind;
  target: TargetSpec;
  workspace: CodegenWorkspace;
}): () => Promise<PreparedRuntime | undefined> {
  let pending: Promise<PreparedRuntime | undefined> | null = null;
  return () => {
    pending ??= (async (): Promise<PreparedRuntime | undefined> => {
      if (request.lowering === "wasm") return undefined;
      if (request.runtime === "none") return buildStandaloneRuntime(request.workspace.workDirectory, request.mode, request.target);
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
  /**
   * The threading runtime this object needs at the link, which is nothing
   * unless one of its loops is written as a team of threads. A program links
   * the objects of all its functions, so this is what a program asks for
   * whatever its own driver holds.
   */
  threads: Threading[];
  textSizeBytes: number;
  implementationPath: string;
}


/** The vectors a candidate is verified and measured with. */
interface PlannedVectors {
  /** Every case the contract is checked against, planned once for the whole unit. */
  cases: TestVector[];
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
  const vectors = planTestVectors(request.parsed, request.test);
  return {
    cases: vectors,
    benchmark: selectBenchmarkVector(request.contract, request.parsed, vectors),
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
  functions: Readonly<Record<string, SemanticFunction>> = {},
): SemanticFunction {
  const fn = parseSemanticFunction(candidate.text, program);
  validateSemanticFunction(fn, contract, new Map(Object.entries(functions)));
  return fn;
}

/**
 * The candidate as the compiler lowers it: the same answer with the
 * deterministic rewrites applied to it.
 *
 * Every path from a candidate to an object or a module comes through here — a
 * candidate this build produced, one an earlier build stored and `blaze test`
 * or `blaze benchmark` re-measures, and one an incremental build reuses whole —
 * so each is lowered folded. The text is rewritten and not only the tree,
 * because the IR a build delivers beside the object is the IR the object was
 * made from: an artifact that is not what was compiled is one a reader cannot
 * check anything against.
 */
export function foldedCandidate(
  candidate: Candidate,
  program: ProgramContract,
  functions: Readonly<Record<string, SemanticFunction>>,
): Candidate {
  // A candidate whose text does not parse is one the reader refuses, and that
  // refusal is reported with the reason the parser gave. The fold is left out
  // rather than failing here, where the reason would be a different one.
  try {
    // Inlining comes before the rewrites, because the callee spliced in was
    // resolved from the source and has not been through them yet.
    const callees = new Map(Object.entries(functions));
    const inlined = inlineCalls(parseSemanticFunction(candidate.text, program), { functions: callees });
    return { ...candidate, text: printSemanticFunction(optimizeSemanticFunction(inlined, callees)) };
  } catch {
    return candidate;
  }
}

/**
 * Turns a candidate into something executable.
 *
 * Every output kind is the same IR lowered the same way, so this is the only
 * place a candidate becomes an object or a module. What the build delivers is
 * the text that lowering produced, and what a size objective weighs is that
 * text rather than the IR, which is the same for every candidate of a function
 * that no review changed and so would order them by nothing at all.
 */
async function materialize(
  request: CandidateEvaluationRequest,
  candidate: Candidate,
  paths: CandidatePaths,
  vectors: PlannedVectors | null,
  /** The IR the candidate is, which every output kind lowers. */
  fn: SemanticFunction,
  /**
   * Whether the candidate can be linked on its own. One that calls another
   * function of the program cannot: the object it needs is another
   * candidate's, and which one is not settled until every candidate has been.
   */
  standalone: boolean,
): Promise<Materialized> {
  // The threading runtime this object needs at the link, which is nothing
  // unless one of its loops is written as a team of threads. The C backend
  // writes such a loop as a pragma OpenMP serves; the machine backend writes
  // its own instructions and calls the runtime for its threads, and it decides
  // that per loop rather than for the body at large — a marked loop it refused
  // is written in order and needs nothing. The wasm backend runs the turns in
  // order however they were marked, which is the same program.
  let threads: Threading[] = request.lowering === "c" && entryIsParallel(fn.entry) ? ["openmp"] : [];
  if (request.lowering === "wasm") {
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
      threads: [],
      textSizeBytes: (await stat(paths.implementation)).size,
      implementationPath: paths.implementation,
    };
  }
  // The ABI header exists before the candidate is compiled: the C the compiler
  // wrote includes it, and the harness always does. It is written and compiled
  // once for the whole build, not once per candidate. The machine backend
  // links the same runtime object and includes no header of its own, so it
  // prepares the same runtime and lowers nothing through it.
  const runtime = await request.prepareRuntime();
  // What the object is, and the weight the lowering weighs. A `c` build
  // delivers the C, an `asm` one the assembly the C compiler made of it, a
  // `machine` one the object the compiler wrote itself, and an `ir` one the
  // IR: only the last is the same for every candidate a review changed
  // nothing in, so a size objective weighs the text below instead.
  const deliversAssembly = request.output === "asm" || (request.output === "machine" && request.lowering === "c");
  let lowered: Awaited<ReturnType<typeof buildMachineObject>> | Awaited<ReturnType<typeof compileFunctionC>>;
  if (request.lowering === "machine") {
    lowered = await buildMachineObject({
      fn,
      contract: request.contract,
      target: request.target,
      callable: request.callable,
      objectPath: paths.object,
      candidate: candidate.id,
    });
    // The machine backend answers this per object rather than per body, because
    // a loop it refused to give a team is written in order and asks for nothing.
    if (lowered.threads) threads = ["pthread"];
  } else {
    lowered = await compileFunctionC({
      fn,
      contract: request.contract,
      mode: request.mode,
      target: request.target,
      sourcePath: paths.loweredSource,
      objectPath: paths.object,
      ...(runtime === undefined ? {} : { includeDirectories: [dirname(runtime.headerPath)] }),
      ...(deliversAssembly ? { assemblyPath: paths.lowered } : {}),
    });
  }
  const textSizeBytes = request.output === "ir" ? (await stat(paths.implementation)).size : lowered.textSizeBytes;
  const object = { objectSizeBytes: lowered.objectSizeBytes };
  if (!standalone) {
    // Assembled, but not linked: the program this candidate is part of is the
    // one that has to run it, and it is linked once every candidate is chosen.
    return { runner: null, sizeBytes: object.objectSizeBytes, threads, textSizeBytes, implementationPath: paths.implementation };
  }

  // A build that links the C runtime runs the candidate in a C harness. A
  // hosted build has no such object: the host program is what runs it.
  if (runtime?.objectPath !== undefined) {
    await writeFile(paths.harness, generateHarness(request.contract, vectors?.demo ?? ""), "utf8");
    link({
      // The link carries the objective and the target because `-flto` makes
      // this command the one that decides the code: gcc rebuilds every object
      // in front of it with these options, so a link without them delivers and
      // verifies a program built at a level and a machine nothing asked for.
      objective: request.contract.optimize.primary,
      target: request.target,
      mode: request.mode,
      harnessPath: paths.harness,
      objectPath: paths.object,
      runtimeObjectPath: runtime.objectPath,
      // A candidate whose object carries a pragma needs the runtime that serves
      // it at the link, and one whose object does not links none.
      threads,
      includeDirectories: [dirname(runtime.headerPath)],
      outputPath: paths.executable,
      functionName: request.contract.function.name,
    });
    return {
      runner: { command: paths.executable, args: [] },
      sizeBytes: object.objectSizeBytes,
      threads,
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
    mode: request.mode,
  });
  return {
    runner: host.runner,
    sizeBytes: object.objectSizeBytes,
    threads,
    textSizeBytes,
    implementationPath: paths.implementation,
  };
}


export function implementationLabel(output: OutputKind): string {
  return IMPLEMENTATION_LABEL[output];
}

/**
 * A candidate built and verified, and the measurement it is still owed.
 *
 * The two are separate because only one of them needs the machine to itself.
 * Compiling a candidate and running it against its vectors produce a yes or a
 * no, which is worth nothing less for having been produced beside the ones
 * being produced for the candidates it is compared with, and a build that
 * waited for the machine to compile five candidates one at a time waited for
 * the part of the work that is not a measurement at all. What is left is the
 * timing, and that is taken on its own.
 */
interface Built {
  /** What the candidate is, with the measurement it is owed left out. */
  readonly outcome: CandidateOutcome;
  /** What to time, or null for a candidate the build does not time. */
  readonly timing: BenchmarkRequest | null;
}

/**
 * Builds, verifies and measures one candidate. Every path that measures a
 * candidate comes through here, so no candidate is ever timed while another one
 * is being measured or while anything else is on the machine.
 */
async function evaluateCandidate(
  request: CandidateEvaluationRequest,
  candidate: Candidate,
  vectors: PlannedVectors | null,
): Promise<CandidateOutcome> {
  const built = await request.machine.run(() => buildCandidate(request, candidate, vectors));
  if (built.timing === null) return built.outcome;
  const timing = built.timing;
  // The machine was given back when the build finished, and is taken again
  // here: a task that asked for the machine and then for the machine alone
  // would be waiting for a slot it was itself holding.
  const benchmark = await request.machine.measure(() => benchmarkCandidate(timing));
  return { ...built.outcome, benchmark };
}

async function buildCandidate(
  request: CandidateEvaluationRequest,
  written: Candidate,
  vectors: PlannedVectors | null,
): Promise<Built> {
  const candidate = foldedCandidate(written, request.program, request.functions);
  const paths = candidateFiles(request.workspace, candidate.id, request.output);
  try {
    // The IR is the artifact and is kept beside whatever it lowers into,
    // because it is what a later review is shown and what a build that failed
    // on it leaves behind to be read. It is written
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
    const fn = readSemanticCandidate(candidate, request.program, request.contract, request.functions);
    const calls = fn.calls.map((edge) => edge.callee).filter((callee) => request.callable.has(callee));
    const built = await materialize(request, candidate, paths, vectors, fn, calls.length === 0);

    // A candidate that calls another function of the program is judged by that
    // program and by nothing else: there is no standalone binary to probe and
    // no vector to run it against, so it is carried to the program round.
    if (calls.length > 0) {
      return {
        outcome: {
          candidate: candidate.id,
          valid: true,
          probe: { called: false, reason: `it calls ${calls.join(", ")}, so the program it belongs to is what runs it` },
          textSizeBytes: built.textSizeBytes,
          objectSizeBytes: built.sizeBytes,
          threads: built.threads,
        },
        timing: null,
      };
    }

    // A contract that states what a function does rather than what it returns
    // has no vector to verify against, so the candidate is called once on an
    // input built from the contract instead. That settles whether it can be
    // executed at all; the program it belongs to is what says whether the two
    // agree, and it keeps that job.
    if (vectors === null) {
      const probe = await probeCandidate(request, paths, planProbe(request.contract, request.parsed), built.threads);
      if (probe.reason !== null && probe.called) {
        return {
          outcome: {
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
            threads: built.threads,
          },
          timing: null,
        };
      }
      return {
        outcome: {
          candidate: candidate.id,
          valid: true,
          probe: { called: probe.called, reason: probe.reason },
          textSizeBytes: built.textSizeBytes,
          objectSizeBytes: built.sizeBytes,
          threads: built.threads,
        },
        timing: null,
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
      vectors: vectors.cases,
    });
    if (!verification.passed) {
      return {
        outcome: {
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
          threads: built.threads,
          verification,
        },
        timing: null,
      };
    }

    // The only work a candidate is timed for. It is handed back to the caller
    // rather than taken here, because taking it here would mean measuring
    // while still holding the machine for the building — the machine a
    // measurement is supposed to have to itself.
    return {
      outcome: {
        candidate: candidate.id,
        valid: true,
        textSizeBytes: built.textSizeBytes,
        objectSizeBytes: built.sizeBytes,
        threads: built.threads,
        verification,
      },
      timing: {
        contract: request.contract,
        runner: built.runner,
        candidate: candidate.id,
        iterations: request.benchmark.iterations,
        vector: vectors.benchmark,
      },
    };
  } catch (cause) {
    const error = toCompilerError(cause, {
      category: "AssemblyError",
      stage: "assemble",
      function: request.contract.function.name,
      candidate: candidate.id,
    });
    return {
      outcome: {
        candidate: candidate.id,
        valid: false,
        failure: {
          category: error.category,
          stage: error.stage,
          message: error.message,
          ...(error.detail === undefined ? {} : { detail: error.detail }),
        },
      },
      timing: null,
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
  /** The threading runtime the object needs, which the probe's link must serve. */
  threads: Threading[],
): Promise<ProbeOutcome> {
  if (plan.kind === "skip") return { called: false, reason: plan.reason, stderr: "" };
  // The probe links the object the C toolchain links, so it runs for every
  // kind that produces one, whatever text that object was lowered from. A
  // `wasm` build produces a module instead, and the host that runs a module
  // is what calls it there.
  if (request.lowering === "wasm") {
    return { called: false, reason: "a wasm candidate is run by its module host, not the native probe", stderr: "" };
  }
  const runtime = await request.prepareRuntime();
  if (runtime?.objectPath === undefined) {
    return { called: false, reason: "the build links no runtime for the probe to call into", stderr: "" };
  }

  await writeFile(paths.probeHarness, generateProbeHarness(request.contract, plan), "utf8");
  link({
    objective: request.contract.optimize.primary,
    target: request.target,
    mode: request.mode,
    harnessPath: paths.probeHarness,
    objectPath: paths.object,
    runtimeObjectPath: runtime.objectPath,
    threads,
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

/**
 * What one review of an artifact changed, and what it could not change.
 *
 * A proposal is applied one at a time, each against the tree the last one
 * produced, and each is checked before the next is: a rule that does not hold
 * where it was aimed is refused and the round carries on with the ones that do,
 * and a rule that holds but leaves a program the compiler may not lower is
 * refused for that. What a round produces is therefore always a function the
 * compiler wrote, and the text it is written back as is the artifact the next
 * round reviews.
 */
export interface Revision {
  /** The IR as the compiler writes it, revised by every proposal that held. */
  readonly text: string;
  /** What each applied proposal did, oldest first. */
  readonly applied: readonly string[];
  /** Every proposal that was refused and why, which the next round is given. */
  readonly refused: readonly string[];
}

function revise(
  fn: SemanticFunction,
  review: Review,
  request: CodegenRequest,
  context: RepairContext,
): Revision {
  const applied: string[] = [];
  const refused: string[] = [];
  let current = fn;
  for (const proposal of review.proposals) {
    // The deterministic rewrites run before each proposal, not only at the end:
    // a fold that makes two values the same one is what lets the rule that
    // binds a repeated value see them as repeated, and a rule that proposes to
    // hoist something the last round already hoisted is proposing nothing.
    current = optimizeSemanticFunction(current, context.functions);
    const outcome = applyProposal(current, proposal, context);
    if ("refused" in outcome) {
      const note = `\`${proposal.text}\` was refused: ${outcome.refused}`;
      refused.push(note);
      request.onNote?.(note);
      continue;
    }
    try {
      validateSemanticFunction(outcome.applied, request.contract, context.functions);
    } catch (cause) {
      const error = toCompilerError(cause, { category: "SemanticIrError", stage: "ir" });
      const note = `\`${proposal.text}\` was refused: the rule applies, but what it produced is not a function the compiler may lower\n${error.detail ?? error.message}`;
      refused.push(note);
      request.onNote?.(note);
      continue;
    }
    current = outcome.applied;
    applied.push(`\`${proposal.text}\`: ${outcome.note}`);
  }
  // And once more after the last proposal, so a round that proposed nothing at
  // all still arrives folded, and so the text a review reads is what the
  // backends are handed rather than what the model last wrote.
  current = optimizeSemanticFunction(current, context.functions);
  return { text: printSemanticFunction(current), applied, refused };
}

/**
 * The target a review of the lowered artifact reads. The C and the assembly are
 * text the compiler wrote, so a review reads them as they stand. A module and
 * an object are not text: a review of a module reads what it holds, and a
 * review of an object reads the listing a processor would run, which is the
 * whole of what a reader can be told about either without it.
 */
async function targetArtifact(
  request: CodegenRequest,
  candidate: Candidate,
): Promise<{ text: string; note: string | null } | null> {
  const paths = candidateFiles(request.workspace, candidate.id, request.output);
  if (request.lowering === "wasm") {
    const module = await readFile(paths.module);
    return {
      text: describeModule(module),
      note: "A module is binary, so this is what it holds rather than a listing of it. The IR it was built from is the artifact the rules are applied to, and the module is regenerated from it.",
    };
  }
  if (request.lowering === "machine") {
    return describeMachineObject(paths.object, await readFile(paths.object));
  }
  return { text: await readFile(paths.lowered, "utf8"), note: null };
}

/**
 * Reviews the IR and regenerates it, once per candidate and for as many rounds
 * as the toolchain keeps rejecting what came out.
 *
 * Every candidate starts from the same artifact: the IR the compiler resolved
 * from the source. A round asks a model to read it and name the rewrites it
 * would make, applies the ones that hold, prints the result and hands it to the
 * toolchain. A round that proposed nothing leaves the IR as it was, which is a
 * candidate like any other: it is assembled, verified and measured, and what
 * that says about it is what the next round is given.
 *
 * The winner is then reviewed once more, against the target the compiler
 * lowered it into. What comes of that is regenerated the same way and verified
 * as the same way, and it replaces the winner only if it still passes: a review
 * of the target cannot make a program correct that the IR was not.
 */

export async function reviewCandidates(request: CodegenRequest): Promise<CodegenResult> {
  const vectors = planVectors(request);
  const candidates: Candidate[] = [];
  const outcomes: CandidateOutcome[] = [];

  // Every stored candidate goes through the toolchain as it is now, and the
  // same selection runs over all of them. Stopping at the first one that
  // verified would pick whichever the record happened to store first, and a
  // stored order is not a ranking: three candidates that all verify with the
  // second the fastest would be settled for the third, because it was written
  // first. A build that reuses this way is a build that is choosing again, and
  // the only thing it saves is the asking.
  for (const existing of request.existing) {
    candidates.push(existing);
    outcomes.push(await evaluateCandidate(request, existing, vectors));
  }
  const reused = selectCandidate(outcomes, request.contract);
  if (reused !== null) {
    // Nothing was reviewed: the stored candidates are reused as they stand.
    return { candidates, outcomes, selected: reused, benchmarkVector: vectors?.benchmark ?? null, modelDurationNs: 0n };
  }

  // One backend per run: it carries the state a session needs, such as which
  // recorded answer to serve next, but is not built until a review happens.
  let backend: AiBackend | null = null;
  const generationBackend = (): AiBackend => (backend ??= request.backend());
  const context: RepairContext = { functions: new Map(Object.entries(request.functions)) };

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

  /**
   * Asks for one review of one artifact and regenerates it from what came back.
 * The wait is the only part of a round a model is needed for, and it is the
 * part that is measured: what the compiler spends assembling and running is
 * its own.
   */
  const askFor = async (
    asked: ReviewRequest,
    sequence: number,
  ): Promise<{ review: Review; durationNs: bigint }> => {
    const startedAt = process.hrtime.bigint();
    const review = await generationBackend().review(asked, sequence);
    return { review, durationNs: process.hrtime.bigint() - startedAt };
  };

  // Candidates are independent chains. Each reviews the same IR independently,
  // and then its own revisions for as long as the toolchain rejects them: a
  // round is given everything that candidate has collected so far, not just the
  // last, and nothing crosses into the next candidate. A candidate only ever
  // waits on its own previous round, so chains overlap: one runs while the
  // candidates that are still reviewing keep going.
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < chains.length) {
      const index = next;
      next += 1;
      const chain = chains[index];
      const candidate = index + 1;
      const diagnostics: string[] = [];
      const refusals: string[] = [];
      // A program that printed something other than what its source prints is
      // the only diagnostic a contract of this shape ever earns, so a round
      // that follows one starts from the IR that produced it rather than from
      // the one the source resolved to.
      // What every candidate starts from: the IR the compiler resolved from
      // the source, before anything has been lowered or asked about.
      let current =
        request.programFailure === undefined
          ? request.base
          : parseSemanticFunction(request.programFailure.previous, request.program);

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const sequence = firstSequence + index * maxAttempts + attempt;
        request.onReview?.({ stage: "ir", candidate, candidates: maxCandidates, attempt, attempts: maxAttempts });
        const { review, durationNs } = await askFor(
          {
            stage: "ir",
            contract: request.contract,
            unit: { file: request.unitFile, function: request.contract.function.name },
            program: request.program,
            semantics: request.functions,
            target: request.target,
            output: request.output,
            candidate,
            candidates: maxCandidates,
            attempt,
            artifact: printSemanticFunction(current),
            artifactNote: null,
            feedback: [...diagnostics],
            refusals: [...refusals],
            ...(request.programFailure === undefined ? {} : { programFailure: request.programFailure }),
          },
          sequence,
        );
        modelDurationNs += durationNs;
        const revision = revise(current, review, request, context);
        refusals.splice(0, refusals.length, ...revision.refused);

        const regenerated: Candidate = {
          id: `c${sequence}`,
          text: revision.text,
          model: generationBackend().id,
          modelConfig: generationBackend().id,
          generatedAt: new Date().toISOString(),
          candidate,
          round: attempt,
          ...(revision.applied.length === 0 ? {} : { proposals: [...revision.applied] }),
          ...(diagnostics.length === 0 ? {} : { feedback: [...diagnostics] }),
        };
        chain.candidates.push(regenerated);

        // Candidates are measured one at a time even though they were
        // reviewed together, and what this waits for is the measurement
        // rather than the whole of the build: the compiling and verifying
        // ahead of it runs alongside the same work for the other candidates.
        const outcome = await evaluateCandidate(request, regenerated, vectors);
        chain.outcomes.push(outcome);
        if (outcome.valid) break;
        current = parseSemanticFunction(revision.text, request.program);
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
      category: "AiReviewError",
      stage: "review",
      message: "no candidate was produced",
      function: request.contract.function.name,
    });
  }

  let selected = selectCandidate(outcomes, request.contract);
  if (selected === null || request.output === "ir") {
    return { candidates, outcomes, selected, benchmarkVector: vectors?.benchmark ?? null, modelDurationNs };
  }

  // The winner is reviewed against the target the compiler lowered it into, and
  // what that review changes is regenerated and verified as any other
  // candidate. It replaces the winner only by being verified: a proposal the
  // rules produced and the toolchain rejected leaves the winner standing.
  const winner = candidates.find((entry) => entry.id === selected);
  const artifact = winner === undefined ? null : await targetArtifact(request, winner);
  if (winner === undefined || artifact === null) {
    return { candidates, outcomes, selected, benchmarkVector: vectors?.benchmark ?? null, modelDurationNs };
  }
  request.onReview?.({ stage: "target", candidate: winner.candidate, candidates: maxCandidates, attempt: 1, attempts: 1 });
  const { review, durationNs } = await askFor(
    {
      stage: "target",
      contract: request.contract,
      unit: { file: request.unitFile, function: request.contract.function.name },
      program: request.program,
      semantics: request.functions,
      target: request.target,
      output: request.output,
      candidate: winner.candidate,
      candidates: maxCandidates,
      attempt: 1,
      artifact: artifact.text,
      artifactNote: artifact.note,
      feedback: [],
      refusals: [],
    },
    firstSequence + maxCandidates * maxAttempts,
  );
  modelDurationNs += durationNs;
  const revision = revise(parseSemanticFunction(winner.text, request.program), review, request, context);
  if (revision.applied.length === 0) {
    return { candidates, outcomes, selected, benchmarkVector: vectors?.benchmark ?? null, modelDurationNs };
  }
  const revised: Candidate = {
    id: `c${firstSequence + maxCandidates * maxAttempts}`,
    text: revision.text,
    model: generationBackend().id,
    modelConfig: generationBackend().id,
    generatedAt: new Date().toISOString(),
    candidate: winner.candidate,
    round: 1,
    proposals: [...revision.applied],
  };
  const outcome = await evaluateCandidate(request, revised, vectors);
  candidates.push(revised);
  outcomes.push(outcome);
  return {
    candidates,
    outcomes,
    selected: outcome.valid ? revised.id : selected,
    benchmarkVector: vectors?.benchmark ?? null,
    modelDurationNs,
  };
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
      functions: request.functions,
      target: request.target,
      output: request.output,
      lowering: request.lowering,
      mode: request.mode,
      runtime: request.runtime,
      workspace: request.workspace,
      test: request.test,
      benchmark: request.benchmark,
      prepareRuntime: request.prepareRuntime,
      callable: request.callable,
      machine: request.machine,
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

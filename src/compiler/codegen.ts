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
import { planProbe, wasmProbeInput, type ProbePlan } from "./toolchain/probe.ts";
import { buildHostProgram } from "./runtime/nim.ts";
import { buildStandaloneRuntime, writeRuntimeHeader } from "./runtime/standalone.ts";
import { buildFacilRuntime, facilIoLibraries } from "./runtime/facil.ts";
import { defaultHttpRuntimeNeeds, type HttpRuntimeNeeds } from "./runtime/http-needs.ts";
import { buildSqliteLibrary } from "./runtime/sqlite-build.ts";
import { buildTritonLibrary } from "./runtime/triton-build.ts";
import type { ReviewRequest, ReviewStage } from "./ai/review.ts";
import type { Proposal, Review } from "./core/proposal.ts";

/**
 * What a build prepared once and then hands to every candidate: the ABI header
 * the C the compiler wrote includes, and the C runtime object to link it
 * against. The two are separate because they have separate lives: a hosted
 * build writes the header and links no C runtime, since the host program is
 * what carries the runtime services. A candidate of a hosted build still needs
 * the header on its include path, so the header is reported either way.
 *
 * A library is beside the runtime and not part of it: it is a thing the
 * program links, and the build prepares it once for the whole build as well.
 */
export interface PreparedRuntime {
  headerPath: string;
  /** Absent for a hosted build: the host program links, so there is no C object. */
  objectPath?: string;
  /**
   * The libraries the runtime's own object needs at the link. The HTTP
   * runtime carries facil.io, and facil.io carries TLS, so a link that has
   * the HTTP runtime in it has the libraries of TLS in it too.
   */
  libraries?: readonly string[];
  /**
   * The objects of the libraries the program links beside the runtime, in
   * link order: the SQLite library, when the program uses SQLite. A library
   * is a thing the program links, and not a host the program runs on.
   */
  libraryObjects?: readonly PreparedLibrary[];
}

/**
 * A library prepared for a build: the header the generated code includes and
 * the object the program links.
 */
export interface PreparedLibrary {
  headerPath: string;
  objectPath: string;
}
import { monotonicTimeNs, readFile, stat, writeFile, dirname } from "./core/platform.ts";
import { CompilerError, toCompilerError } from "./core/errors.ts";
import type { SemanticBlock, SemanticFunction } from "./core/semantic-ir.ts";
import { run, GENERATED_HEAP_BYTES, type RunResult } from "./core/process.ts";
import { EXECUTABLE_SUFFIX } from "./core/target.ts";
import type { AiBackend } from "./ai/backend.ts";
import { parseType, type ParsedContract } from "./semantics/contract.ts";
import { encodeRunRequest, planVerificationBatches, selectDemoVector, verifyCandidate, type TestVector } from "./toolchain/verifier.ts";
import type {
  BackendKind,
  BuildMode,
  Candidate,
  BenchmarkConfig,
  BenchmarkResult,
  CandidateOutcome,
  CallEdge,
  FunctionContract,
  FunctionSignature,
  Objective,
  ProgramContract,
  ProgramFailure,
  RuntimeKind,
  LibraryKind,
  GenerationConfig,
  OutputKind,
  Runner,
  TargetSpec,
  TestConfig,
  VerificationResult,
} from "./core/types.ts";
import type { IncrementalEntry } from "./incremental.ts";

function fieldOf(value: unknown, key: string): any {
  return (value as Record<string, unknown>)[key];
}

/** What a probe found, which a class lays out where an anonymous literal does not. */
class ProbeStatus {
  called: boolean;
  reason: string;

  constructor(called: boolean, reason: string) {
    this.called = called;
    this.reason = reason;
  }
}

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
  /** The file that declares the contract, which the prompt reads as the source. */
  unitFile: string;
  /**
   * The function the compiler resolved from the source, which is the artifact
   * every candidate starts from. What the frontend parsed and `ir-resolve.ts`
   * resolved is already a program every backend can lower, so a build starts
   * from it and a review may only rewrite it.
   */
  base: SemanticFunction;
  /**
   * Built on demand: a build that reuses stored candidates must not need model
   * configuration, because it never asks a model anything. Absent when no
   * model is configured at all: the build runs the rules alone, lowers the IR
   * it resolved and reviews nothing.
   */
  backend?: () => AiBackend;
  generation: GenerationConfig;
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
  const base = `${String(fieldOf(workspace, "workDirectory"))}/${candidate}`;
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
  // Every build delivers the IR beside the target it was lowered from, whatever
  // the kind is, so it is a file every build consumes rather than an `ir` one.
  const delivered = lowering === "machine" ? String(fieldOf(paths, "object")) : output === "ir" ? String(fieldOf(paths, "implementation")) : String(fieldOf(paths, "lowered"));
  // The wasm backend writes the module and no assembly: naming the assembly here
  // asked for a file that is never written, so the list could never be complete
  // and a stored candidate was rebuilt on every build for the life of the
  // project. The module is what it delivers, and the host that runs it is
  // delivered beside it: a module nobody can run is not a deliverable.
  if (lowering === "wasm") return [String(fieldOf(paths, "module")), String(fieldOf(paths, "host")), String(fieldOf(paths, "implementation"))];
  // A candidate that links on its own delivers the executable that links, and
  // one that does not has none: `materialize` below returns before the harness
  // link for a candidate that calls another function of the program, because the
  // program is what has to run it. So the executable is a file the build
  // consumes exactly when the candidate is standalone, whatever the output kind
  // is — naming it for a `machine` build regardless made a stored candidate
  // that can never be complete, so it was rebuilt on every build for the life of
  // the project.
  //
  // The object is a separate question and the answer does not depend on the
  // output kind: every kind that assembles writes one, and a program build
  // links it for every function it holds. Asking the executable question
  // first and returning its answer is what used to drop the object, so both
  // files are collected and the list is built once.
  const files: string[] = [String(fieldOf(paths, "implementation")), delivered];
  if (standalone) files[files.length] = String(fieldOf(paths, "executable"));
  if (linksObjects) files[files.length] = String(fieldOf(paths, "object"));
  return files;
}

/**
 * A result that is not the result of this build: the candidates and outcomes
 * an earlier build stored, and the candidate it selected among them. Nothing
 * was assembled, linked, verified or measured, and no model was asked, so the
 * time spent waiting for one is nothing.
 */
export function reusedResult(entry: IncrementalEntry): CodegenResult {
  return {
    candidates: fieldOf(entry, "candidates") as Candidate[],
    outcomes: fieldOf(entry, "outcomes") as CandidateOutcome[],
    selected: fieldOf(entry, "selected") as string | null,
    benchmarkVector: fieldOf(entry, "benchmarkVector") as TestVector | null,
    modelDurationNs: BigInt(0),
  };
}

/**
 * One diagnostic, attributed to the attempt that earned it. Diagnostics
 * accumulate within a candidate, so a repair sees everything that was already
 * wrong as well as what this round reported.
 */
function diagnosticFor(failure: CandidateOutcome["failure"], attempt: number): string {
  if (failure === undefined) return `[attempt ${attempt}] rejected: the candidate did not satisfy the contract`;
  const failureDetail = fieldOf(failure, "detail") as string | undefined;
  const detail = failureDetail === undefined || failureDetail.trim().length === 0 ? "" : `\n${failureDetail.trim()}`;
  return `[attempt ${attempt}] ${String(fieldOf(failure, "stage"))} failed: ${String(fieldOf(failure, "message"))}${detail}`;
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

  // Shared work ahead of a measurement is let on, because it is ahead of it
  // and running it is what lets the measurement be reached at all: refusing it
  // for the sake of a measurement queued behind it would leave that
  // measurement waiting for work that was itself waiting for it. Shared work
  // behind a measurement is never let on ahead of it, so a build that keeps
  // producing work cannot push a measurement to the back of it.
  const drain = (): void => {
    while (waiting.length > 0 && timed === 0) {
      const next = waiting[0] as Waiting;
      if (next.timed && shared > 0) return;
      waiting.shift();
      next.admit();
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
  /**
   * The functions of the program, for a build that is a program.
   *
   * A program is one module: every function of it is in the module and is
   * called by the index it has there, so a function that calls another
   * function of the program needs that function in its module — there is no
   * linker to find it beside. A build that compiles one function on its own
   * has nothing to hold beside it, and carries none.
   */
  programFunctions?: readonly SemanticFunction[];
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
  /** The libraries the program links beside the runtime, in link order. */
  libraries?: readonly LibraryKind[];
  /**
   * What the HTTP runtime is built for, read from the program it is built
   * for: how many connections its server may hold, and whether it speaks TLS.
   */
  http?: HttpRuntimeNeeds;
}): () => Promise<PreparedRuntime | undefined> {
  let pending: Promise<PreparedRuntime | undefined> | null = null;
  const lowering = String(fieldOf(request, "lowering"));
  const mode = fieldOf(request, "mode") as BuildMode;
  const runtimeKind = String(fieldOf(request, "runtime"));
  const target = fieldOf(request, "target") as TargetSpec;
  const workspace = fieldOf(request, "workspace") as CodegenWorkspace;
  const libraries = fieldOf(request, "libraries") as readonly LibraryKind[] | undefined;
  const http = (fieldOf(request, "http") as HttpRuntimeNeeds | undefined) ?? defaultHttpRuntimeNeeds();
  return () => {
    pending ??= (async (): Promise<PreparedRuntime | undefined> => {
      if (lowering === "wasm") return undefined;
      const workDirectory = String(fieldOf(workspace, "workDirectory"));
      let prepared: PreparedRuntime;
      if (runtimeKind === "none") {
        prepared = await buildStandaloneRuntime(workDirectory, mode, target);
      } else if (runtimeKind === "facil") {
        const facility = await buildFacilRuntime(workDirectory, mode, target, http);
        prepared = { headerPath: String(fieldOf(facility, "headerPath")), objectPath: String(fieldOf(facility, "objectPath")), libraries: facilIoLibraries(fieldOf(http, "tls") === true, target) };
      } else {
        prepared = { headerPath: await writeRuntimeHeader(workDirectory) };
      }
      // The libraries are built after the runtime, because the adapter of a
      // library includes the runtime's header and calls into it.
      const libraryObjects: PreparedLibrary[] = [];
      for (const library of libraries ?? []) {
        if (library === "sqlite") {
          libraryObjects.push(await buildSqliteLibrary(workDirectory, mode, target));
        }
        if (library === "triton") {
          libraryObjects.push(await buildTritonLibrary(workDirectory, mode, target));
        }
      }
      const runtimeLibraries = fieldOf(prepared, "libraries") as readonly string[] | undefined;
      const runtimeObject = fieldOf(prepared, "objectPath") as string | undefined;
      const built: PreparedRuntime = { headerPath: String(fieldOf(prepared, "headerPath")), libraryObjects };
      if (runtimeObject !== undefined) built.objectPath = runtimeObject;
      if (runtimeLibraries !== undefined) built.libraries = runtimeLibraries;
      return built;
    })();
    return pending;
  };
}

/**
 * The objects of the libraries a build prepared, in the order they are linked.
 */
function libraryObjects(runtime: PreparedRuntime | undefined): string[] {
  const paths: string[] = [];
  const held = fieldOf(runtime, "libraryObjects") as readonly PreparedLibrary[] | undefined;
  for (const library of held ?? []) paths[paths.length] = String(fieldOf(library, "objectPath"));
  return paths;
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
  /** Every batch's cases, concatenated in batch order. */
  cases: TestVector[];
  /** The seed of the first batch, recorded on the verification result. */
  seed: number;
  /** One seed per independent randomized batch. */
  batchSeeds: number[];
  /** How many vectors each batch contributed. */
  batchSizes: number[];
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
 *
 * A parameter of a reference type is the same answer whichever way the
 * contract is written: the vector cannot carry the object, so there is
 * nothing to hand the function and nothing to compare — and a function that
 * took one and was planned a vector for it failed the build with `ref<any> is
 * not a buffer`, which names the protocol rather than the program. It is
 * checked where it can be: against the program that calls it.
 */
function planVectors(request: CandidateEvaluationRequest): PlannedVectors | null {
  const parsed = fieldOf(request, "parsed") as ParsedContract;
  if (fieldOf(parsed, "resultDefinition") === null) return null;
  // A parameter that is a reference to an object is what the protocol cannot
  // carry: a vector holds numbers and the elements of a buffer, so a reference
  // has nothing to be read as. Planning one raised `ref<any> is not a buffer`
  // out of the vector builder, naming the protocol rather than the program,
  // and there is no returned value to compare either — the program such a
  // function belongs to is what says whether the two agree.
  const contract = fieldOf(parsed, "contract") as FunctionContract;
  const fn = fieldOf(contract, "function") as FunctionSignature;
  const params = fieldOf(fn, "params") as readonly { readonly type: string }[];
  if (params.some((param) => parseType(String(fieldOf(param, "type"))).kind === "ref")) return null;
  const test = fieldOf(request, "test") as TestConfig;
  const plans = planVerificationBatches(parsed, test);
  const vectors: TestVector[] = [];
  for (const plan of plans) {
    for (const vector of fieldOf(plan, "vectors") as readonly TestVector[]) vectors.push(vector);
  }
  return {
    cases: vectors,
    seed: Number(fieldOf(plans[0], "seed")),
    batchSeeds: plans.map((plan) => Number(fieldOf(plan, "seed"))),
    batchSizes: plans.map((plan) => (fieldOf(plan, "vectors") as readonly unknown[]).length),
    benchmark: selectBenchmarkVector(fieldOf(request, "contract") as FunctionContract, parsed, fieldOf(plans[0], "vectors") as readonly TestVector[]),
    demo: encodeRunRequest(fieldOf(request, "contract") as FunctionContract, [selectDemoVector(parsed, test)]),
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
  const fn = parseSemanticFunction(String(fieldOf(candidate, "text")), program);
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
  let parsed: SemanticFunction;
  try {
    parsed = parseSemanticFunction(String(fieldOf(candidate, "text")), program);
  } catch {
    return candidate;
  }
  // Everything past the parser is outside that bargain. A fold that throws is
  // this compiler declining to rewrite IR it was asked to rewrite, and delivering
  // the candidate unfolded in its place is a different program from the one the
  // build describes: the folds are what re-derive the `parallel` and `region`
  // marks from the bodies the function calls, and the validator only proves a
  // mark the IR text claims. A candidate carrying one therefore reaches an object
  // on the strength of a claim no rule in this build checked.
  //
  // Inlining comes before the rewrites, because the callee spliced in was
  // resolved from the source and has not been through them yet.
  const callees = new Map(Object.entries(functions));
  const inlined = inlineCalls(parsed, { functions: callees });
  // The artifact a fold produced is a new candidate: the one it was given is
  // the resolved IR the build records, and rewriting it in place would make a
  // second fold of the same candidate read what the first one wrote.
  return { ...candidate, text: printSemanticFunction(optimizeSemanticFunction(inlined, callees)) };
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
  const lowering = String(fieldOf(request, "lowering"));
  const output = String(fieldOf(request, "output"));
  const contract = fieldOf(request, "contract") as FunctionContract;
  const target = fieldOf(request, "target") as TargetSpec;
  const candidateId = String(fieldOf(candidate, "id"));
  // The threading runtime this object needs at the link, which is nothing
  // unless one of its loops is written as a team of threads. The C backend
  // writes such a loop as a pragma OpenMP serves; the machine backend writes
  // its own instructions and calls the runtime for its threads, and it decides
  // that per loop rather than for the body at large — a marked loop it refused
  // is written in order and needs nothing. The wasm backend runs the turns in
  // order however they were marked, which is the same program.
  let threads: Threading[] = lowering === "c" && entryIsParallel(fieldOf(fn, "entry") as SemanticBlock) ? ["openmp"] : [];
  if (lowering === "wasm") {
    const programFunctions = fieldOf(request, "programFunctions") as readonly SemanticFunction[] | undefined;
    const allFunctions = programFunctions ?? [];
    const module = await buildModule({
      fn,
      contract,
      // A program is one module, so the functions a candidate calls are in the
      // module beside it: the module calls them by the index they have in it,
      // and there is no linker to find them anywhere else.
      functions: allFunctions.filter((one) => String(fieldOf(one, "symbol")) !== String(fieldOf(fn, "symbol"))),
      modulePath: String(fieldOf(paths, "module")),
      hostPath: String(fieldOf(paths, "host")),
      candidate: candidateId,
      language: String(fieldOf(fieldOf(request, "program"), "language")),
    });
    return {
      runner: fieldOf(module, "runner") as Runner,
      sizeBytes: Number(fieldOf(module, "moduleSizeBytes")),
      threads: [],
      textSizeBytes: Number(fieldOf(await stat(String(fieldOf(paths, "implementation"))), "size")),
      implementationPath: String(fieldOf(paths, "implementation")),
    };
  }
  // The ABI header exists before the candidate is compiled: the C the compiler
  // wrote includes it, and the harness always does. It is written and compiled
  // once for the whole build, not once per candidate. The machine backend
  // links the same runtime object and includes no header of its own, so it
  // prepares the same runtime and lowers nothing through it.
  const runtime = await (fieldOf(request, "prepareRuntime") as () => Promise<PreparedRuntime | undefined>)();
  // What the object is, and the weight the lowering weighs. A `c` build
  // delivers the C, an `asm` one the assembly the C compiler made of it, a
  // `machine` one the object the compiler wrote itself, and an `ir` one the
  // IR: only the last is the same for every candidate a review changed
  // nothing in, so a size objective weighs the text below instead.
  const deliversAssembly = output === "asm" || (output === "machine" && lowering === "c");
  let lowered: Awaited<ReturnType<typeof buildMachineObject>> | Awaited<ReturnType<typeof compileFunctionC>>;
  if (lowering === "machine") {
    lowered = await buildMachineObject({
      fn,
      contract,
      target,
      callable: fieldOf(request, "callable") as ReadonlySet<string>,
      objectPath: String(fieldOf(paths, "object")),
      candidate: candidateId,
    });
    // The machine backend answers this per object rather than per body, because
    // a loop it refused to give a team is written in order and asks for nothing.
    if (fieldOf(lowered, "threads") === true) threads = ["pthread"];
  } else {
    lowered = await compileFunctionC({
      fn,
      contract,
      mode: fieldOf(request, "mode") as BuildMode,
      target,
      sourcePath: String(fieldOf(paths, "loweredSource")),
      objectPath: String(fieldOf(paths, "object")),
      ...(runtime === undefined ? {} : { includeDirectories: [dirname(String(fieldOf(runtime, "headerPath")))] }),
      ...(deliversAssembly ? { assemblyPath: String(fieldOf(paths, "lowered")) } : {}),
    });
  }
  const textSizeBytes = output === "ir" ? Number(fieldOf(await stat(String(fieldOf(paths, "implementation"))), "size")) : Number(fieldOf(lowered, "textSizeBytes"));
  const objectSizeBytes = Number(fieldOf(lowered, "objectSizeBytes"));
  if (!standalone) {
    // Assembled, but not linked: the program this candidate is part of is the
    // one that has to run it, and it is linked once every candidate is chosen.
    return { runner: null, sizeBytes: objectSizeBytes, threads, textSizeBytes, implementationPath: String(fieldOf(paths, "implementation")) };
  }

  // A build that links the C runtime runs the candidate in a C harness. A
  // hosted build has no such object: the host program is what runs it.
  if (fieldOf(runtime, "objectPath") !== undefined) {
    await writeFile(String(fieldOf(paths, "harness")), generateHarness(contract, vectors?.demo ?? "", String(fieldOf(fieldOf(request, "program"), "language"))), "utf8");
    const runtimeLibraries = fieldOf(runtime, "libraries") as string[] | undefined;
    link({
      // The link carries the objective and the target because `-flto` makes
      // this command the one that decides the code: gcc rebuilds every object
      // in front of it with these options, so a link without them delivers and
      // verifies a program built at a level and a machine nothing asked for.
      objective: fieldOf(fieldOf(contract, "optimize"), "primary") as Objective,
      target,
      mode: fieldOf(request, "mode") as BuildMode,
      harnessPath: String(fieldOf(paths, "harness")),
      objectPath: String(fieldOf(paths, "object")),
      runtimeObjectPath: String(fieldOf(runtime, "objectPath")),
      libraryObjectPaths: libraryObjects(runtime),
      // A candidate whose object carries a pragma needs the runtime that serves
      // it at the link, and one whose object does not links none.
      threads,
      includeDirectories: [dirname(String(fieldOf(runtime, "headerPath")))],
      outputPath: String(fieldOf(paths, "executable")),
      functionName: String(fieldOf(fieldOf(contract, "function"), "name")),
      ...(runtimeLibraries === undefined ? {} : { libraries: runtimeLibraries }),
    });
    return {
      runner: { command: String(fieldOf(paths, "executable")), args: [] },
      sizeBytes: objectSizeBytes,
      threads,
      textSizeBytes,
      implementationPath: String(fieldOf(paths, "implementation")),
    };
  }

  // A hosted build is a Nim program: the host speaks the harness protocol, so
  // the candidate object is linked into it instead of into a C main.
  const host = await buildHostProgram({
    contract,
    workDirectory: String(fieldOf(fieldOf(request, "workspace"), "workDirectory")),
    candidate: candidateId,
    objectPath: String(fieldOf(paths, "object")),
    demoRequest: vectors?.demo ?? "",
    mode: fieldOf(request, "mode") as BuildMode,
  });
  return {
    runner: fieldOf(host, "runner") as Runner,
    sizeBytes: objectSizeBytes,
    threads,
    textSizeBytes,
    implementationPath: String(fieldOf(paths, "implementation")),
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
  const built = await buildCandidate(request, candidate, vectors);
  const timing = fieldOf(built, "timing") as BenchmarkRequest | null;
  if (timing === null) return fieldOf(built, "outcome") as CandidateOutcome;
  // The machine was given back when the build finished, and is taken again
  // here: a task that asked for the machine and then for the machine alone
  // would be waiting for a slot it was itself holding.
  const benchmark = benchmarkCandidate(timing);
  const outcome = fieldOf(built, "outcome") as CandidateOutcome;
  (outcome as unknown as Record<string, unknown>)["benchmark"] = benchmark;
  return outcome;
}

async function buildCandidate(
  request: CandidateEvaluationRequest,
  written: Candidate,
  vectors: PlannedVectors | null,
): Promise<Built> {
  const program = fieldOf(request, "program") as ProgramContract;
  const functions = fieldOf(request, "functions") as Readonly<Record<string, SemanticFunction>>;
  const contract = fieldOf(request, "contract") as FunctionContract;
  const callable = fieldOf(request, "callable") as ReadonlySet<string>;
  const candidate = foldedCandidate(written, program, functions);
  const paths = candidateFiles(fieldOf(request, "workspace") as CodegenWorkspace, String(fieldOf(candidate, "id")), fieldOf(request, "output") as OutputKind);
  try {
    // The IR is the artifact and is kept beside whatever it lowers into,
    // because it is what a later review is shown and what a build that failed
    // on it leaves behind to be read. It is written
    // before it is read rather than once it has been lowered, so that a
    // candidate the reader refused is on disk beside the ones it accepted: a
    // refusal that names a line of the IR and leaves no copy of the IR is a
    // diagnostic nothing can be done about.
    await writeFile(String(fieldOf(paths, "implementation")), String(fieldOf(candidate, "text")), "utf8");

    // A candidate may call the other functions of the program, and one that does
    // is linked only into the program, so nothing about it can be run on its own.
    // The program is the oracle for it, which is where a definition contract
    // already sends its candidate. Every output kind answers in the IR, so
    // this is where one candidate is read on every kind — and a candidate that
    // is not a program the compiler may lower is refused here, inside the
    // refusal path, where a diagnostic comes of it and a repair round is given
    // the reason.
    const fn = readSemanticCandidate(candidate, program, contract, functions);
    const calls = (fieldOf(fn, "calls") as readonly CallEdge[]).map((edge) => String(fieldOf(edge, "callee"))).filter((callee) => callable.has(callee));
    const built = await materialize(request, candidate, paths, vectors, fn, calls.length === 0);
    const candidateId = String(fieldOf(candidate, "id"));

    // A candidate that calls another function of the program is judged by that
    // program and by nothing else: there is no standalone binary to probe and
    // no vector to run it against, so it is carried to the program round.
    if (calls.length > 0) {
      const status = new ProbeStatus(false, `it calls ${calls.join(", ")}, so the program it belongs to is what runs it`);
      return {
        outcome: {
          candidate: candidateId,
          valid: true,
          probe: status,
          textSizeBytes: Number(fieldOf(built, "textSizeBytes")),
          objectSizeBytes: Number(fieldOf(built, "sizeBytes")),
          threads: fieldOf(built, "threads") as Threading[],
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
      const parsed = fieldOf(request, "parsed") as ParsedContract;
      const probe = await probeCandidate(request, paths, planProbe(contract, parsed), fieldOf(built, "threads") as Threading[]);
      const reason = fieldOf(probe, "reason") as string | null;
      const called = fieldOf(probe, "called") === true;
      if (reason !== null && called) {
        const fnName = String(fieldOf(fieldOf(contract, "function"), "name"));
        const stderr = String(fieldOf(probe, "stderr")).trim();
        return {
          outcome: {
            candidate: candidateId,
            valid: false,
            failure: {
              category: "VerificationError",
              stage: "verify",
              message: `candidate ${candidateId}: ${fnName} liveness check failed: ${reason}`,
              detail: [
                "The candidate was called once on an input built from its contract and the result was not read, so this says nothing about what it computes.",
                `The program ${fnName} belongs to is what says whether the two agree.`,
                ...(stderr.length === 0 ? [] : [`the candidate wrote to standard error:\n${stderr}`]),
              ].join("\n"),
            },
            probe: { called, reason },
            textSizeBytes: Number(fieldOf(built, "textSizeBytes")),
            objectSizeBytes: Number(fieldOf(built, "sizeBytes")),
            threads: fieldOf(built, "threads") as Threading[],
          },
          timing: null,
        };
      }
      return {
        outcome: {
          candidate: candidateId,
          valid: true,
          probe: { called, reason },
          textSizeBytes: Number(fieldOf(built, "textSizeBytes")),
          objectSizeBytes: Number(fieldOf(built, "sizeBytes")),
          threads: fieldOf(built, "threads") as Threading[],
        },
        timing: null,
      };
    }

    // Reached only when the candidate is standalone, which is what leaves it
    // with a binary to run its vectors against.
    const runner = fieldOf(built, "runner") as Runner | null;
    if (runner === null) {
      throw new CompilerError("LinkError", "link", `candidate ${candidateId} produced no binary to verify`, "", String(fieldOf(fieldOf(contract, "function"), "name")), candidateId, "");
    }

    const verification = verifyCandidate({
      contract,
      parsed: fieldOf(request, "parsed") as ParsedContract,
      runner,
      candidate: candidateId,
      vectors: fieldOf(vectors, "cases") as TestVector[],
      seed: Number(fieldOf(vectors, "seed")),
      batchSeeds: fieldOf(vectors, "batchSeeds") as number[],
      batchSizes: fieldOf(vectors, "batchSizes") as number[],
    });
    const passed = fieldOf(verification, "passed") === true;
    if (!passed) {
      const failures = fieldOf(verification, "failures") as readonly { readonly vector: string; readonly expected: string; readonly actual: string; readonly reason: string }[];
      return {
        outcome: {
          candidate: candidateId,
          valid: false,
          failure: {
            category: "VerificationError",
            stage: "verify",
            message: `${failures.length} of ${String(fieldOf(verification, "cases"))} test vectors did not match the contract`,
            detail: failures
              .map((failure) => `${String(fieldOf(failure, "vector"))}: expected ${String(fieldOf(failure, "expected"))}, got ${String(fieldOf(failure, "actual"))} (${String(fieldOf(failure, "reason"))})`)
              .join("\n"),
          },
          textSizeBytes: Number(fieldOf(built, "textSizeBytes")),
          objectSizeBytes: Number(fieldOf(built, "sizeBytes")),
          threads: fieldOf(built, "threads") as Threading[],
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
        candidate: candidateId,
        valid: true,
        textSizeBytes: Number(fieldOf(built, "textSizeBytes")),
        objectSizeBytes: Number(fieldOf(built, "sizeBytes")),
        threads: fieldOf(built, "threads") as Threading[],
        verification,
      },
      timing: {
        contract,
        runner,
        candidate: candidateId,
        iterations: Number(fieldOf(fieldOf(request, "benchmark"), "iterations")),
        vector: fieldOf(vectors, "benchmark") as TestVector,
      },
    };
  } catch (cause) {
    const error = toCompilerError(cause, "AssemblyError", "assemble", "", "", String(fieldOf(fieldOf(contract, "function"), "name")), String(fieldOf(candidate, "id")), "");
    const detail = fieldOf(error, "detail") as string | undefined;
    return {
      outcome: {
        candidate: String(fieldOf(candidate, "id")),
        valid: false,
        failure: {
          category: String(fieldOf(error, "category")),
          stage: String(fieldOf(error, "stage")),
          message: String(fieldOf(error, "message")),
          ...(detail === undefined ? {} : { detail }),
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
  // is what calls it there: the same protocol, one vector, and nothing
  // compared with the answer.
  const contract = fieldOf(request, "contract") as FunctionContract;
  const parsed = fieldOf(request, "parsed") as ParsedContract;
  if (String(fieldOf(request, "lowering")) === "wasm") {
    const wasmPlan = wasmProbeInput(contract, parsed);
    if (wasmPlan.kind === "skip") return { called: false, reason: wasmPlan.reason, stderr: "" };
    const result = await run(process.execPath, [String(fieldOf(paths, "host")), String(fieldOf(paths, "module"))], {
      input: fieldOf(wasmPlan, "input") as string,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    return { called: true, reason: probeFault(result), stderr: String(fieldOf(result, "stderr")) };
  }
  const runtime = await (fieldOf(request, "prepareRuntime") as () => Promise<PreparedRuntime | undefined>)();
  if (fieldOf(runtime, "objectPath") === undefined) {
    return { called: false, reason: "the build links no runtime for the probe to call into", stderr: "" };
  }

  await writeFile(String(fieldOf(paths, "probeHarness")), generateProbeHarness(contract, plan, String(fieldOf(fieldOf(request, "program"), "language"))), "utf8");
  const runtimeLibraries = fieldOf(runtime, "libraries") as string[] | undefined;
  link({
    objective: fieldOf(fieldOf(contract, "optimize"), "primary") as Objective,
    target: fieldOf(request, "target") as TargetSpec,
    mode: fieldOf(request, "mode") as BuildMode,
    harnessPath: String(fieldOf(paths, "probeHarness")),
    objectPath: String(fieldOf(paths, "object")),
    runtimeObjectPath: String(fieldOf(runtime, "objectPath")),
    libraryObjectPaths: libraryObjects(runtime),
    threads,
    includeDirectories: [dirname(String(fieldOf(runtime, "headerPath")))],
    outputPath: String(fieldOf(paths, "probeExecutable")),
    functionName: String(fieldOf(fieldOf(contract, "function"), "name")),
    ...(runtimeLibraries === undefined ? {} : { libraries: runtimeLibraries }),
  });

  const result = await run(String(fieldOf(paths, "probeExecutable")), [], {
    timeoutMs: PROBE_TIMEOUT_MS,
    heapBytes: GENERATED_HEAP_BYTES,
  });
  return { called: true, reason: probeFault(result), stderr: String(fieldOf(result, "stderr")) };
}

/**
 * How a run that did not come back is described, or null when it did. A run
 * stopped at the deadline is reported as that first: it started, so it is
 * neither a probe that failed to launch nor a candidate that ran and failed.
 */
export function probeFault(result: RunResult): string | null {
  if (fieldOf(result, "timedOut") === true) return `the candidate did not return within ${PROBE_TIMEOUT_MS / 1000} seconds`;
  const spawnError = fieldOf(result, "spawnError");
  if (spawnError !== undefined) return `the probe did not start: ${String(spawnError)}`;
  const signal = fieldOf(result, "signal") as string | null;
  if (signal !== null) return `the candidate was killed by ${signal}`;
  // A raise is a way the source can end too: the runtime reports it on the
  // standard error and exits two. The probe asks whether the candidate ran,
  // and the program it belongs to is what settles what it computes.
  //
  // A refusal is not a raise. The runtime's own guards — a pointer that was
  // never handed out, a corrupt header, an allocation past the limit — say the
  // candidate broke the runtime it runs on, and that is a candidate that did
  // not run at all. The prefix is what tells the two apart, because the text
  // of a raise is the source's and may say anything.
  const stderr = String(fieldOf(result, "stderr"));
  const code = Number(fieldOf(result, "code"));
  if (code === 2 && /^blaze: /m.test(stderr) && !/^blaze: internal: /m.test(stderr)) return null;
  if (code !== 0) return `the candidate exited with status ${code}`;
  return null;
}

/**
 * Chooses the best valid candidate. Speed decides for latency and throughput;
 * code size decides for size; energy and balanced use the fastest candidate,
 * because neither can be measured on this toolchain.
 */
export function selectCandidate(outcomes: readonly CandidateOutcome[], contract: FunctionContract): string | null {
  const valid = outcomes.filter((outcome) => fieldOf(outcome, "valid") === true);
  if (valid.length === 0) return null;

  // A candidate the build did not time has no benchmark at all: a program the
  // harness checks as a whole is measured there, not once per function. Guard
  // the missing object, not just the missing field, or the sort crashes before
  // the fallback can say a candidate that was not timed is the slower one.
  const timedNs = (outcome: CandidateOutcome): number => {
    const benchmark = fieldOf(outcome, "benchmark") as Record<string, unknown> | null | undefined;
    if (benchmark === null || benchmark === undefined) return Number.POSITIVE_INFINITY;
    return (fieldOf(benchmark, "durationNs") as number | undefined) ?? Number.POSITIVE_INFINITY;
  };
  const bySpeed = [...valid].sort((left, right) => timedNs(left) - timedNs(right));
  const bySize = [...valid].sort((left, right) => (fieldOf(left, "textSizeBytes") as number | undefined ?? 0) - (fieldOf(right, "textSizeBytes") as number | undefined ?? 0));

  const objective = String(fieldOf(fieldOf(contract, "optimize"), "primary"));
  if (objective === "size") return String(fieldOf(bySize[0], "candidate"));
  return String(fieldOf(bySpeed[0], "candidate"));
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
  const proposals = fieldOf(review, "proposals") as readonly Proposal[];
  for (const proposal of proposals) {
    // The deterministic rewrites run before each proposal, not only at the end:
    // a fold that makes two values the same one is what lets the rule that
    // binds a repeated value see them as repeated, and a rule that proposes to
    // hoist something the last round already hoisted is proposing nothing.
    current = optimizeSemanticFunction(current, fieldOf(context, "functions") as ReadonlyMap<string, SemanticFunction>);
    const outcome = applyProposal(current, proposal, context);
    const proposalText = String(fieldOf(proposal, "text"));
    const refusal = fieldOf(outcome, "refused") as string | undefined;
    if (refusal !== undefined) {
      const note = `\`${proposalText}\` was refused: ${String(refusal)}`;
      refused.push(note);
      request.onNote?.(note);
      continue;
    }
    try {
      validateSemanticFunction(fieldOf(outcome, "applied") as SemanticFunction, fieldOf(request, "contract") as FunctionContract, fieldOf(context, "functions") as ReadonlyMap<string, SemanticFunction>);
    } catch (cause) {
      const error = toCompilerError(cause, "SemanticIrError", "ir", "", "", "", "", "");
      const note = `\`${proposalText}\` was refused: the rule applies, but what it produced is not a function the compiler may lower\n${fieldOf(error, "detail") ?? fieldOf(error, "message")}`;
      refused.push(note);
      request.onNote?.(note);
      continue;
    }
    current = fieldOf(outcome, "applied") as SemanticFunction;
    applied.push(`\`${proposalText}\`: ${String(fieldOf(outcome, "note"))}`);
    // A rule aimed at a whole block may hold where part of it does not — a
    // callee called five times is inlined four of them, and the fifth is left
    // where it was because an argument it was called with is itself a call.
    // What it left is said here, which is where a round's refusals go, so the
    // next round reads it beside what it did.
    for (const reason of (fieldOf(outcome, "partial") as readonly string[] | undefined) ?? []) {
      const note = `\`${proposalText}\` was refused: ${reason}`;
      refused.push(note);
      request.onNote?.(note);
    }
  }
  // And once more after the last proposal, so a round that proposed nothing at
  // all still arrives folded, and so the text a review reads is what the
  // backends are handed rather than what the model last wrote.
  current = optimizeSemanticFunction(current, fieldOf(context, "functions") as ReadonlyMap<string, SemanticFunction>);
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
  const paths = candidateFiles(fieldOf(request, "workspace") as CodegenWorkspace, String(fieldOf(candidate, "id")), fieldOf(request, "output") as OutputKind);
  const lowering = String(fieldOf(request, "lowering"));
  if (lowering === "wasm") {
    const module = (await readFile(String(fieldOf(paths, "module")), "utf8")) as unknown as Uint8Array;
    return {
      text: describeModule(module),
      note: "This is the module itself: its sections, its types, its imports and their signatures, its exports and the instructions of its code. The IR it was built from is the artifact the rules are applied to, and the module is regenerated from it.",
    };
  }
  if (lowering === "machine") {
    return describeMachineObject(String(fieldOf(paths, "object")), (await readFile(String(fieldOf(paths, "object")), "utf8")) as unknown as Uint8Array);
  }
  return { text: await readFile(String(fieldOf(paths, "lowered")), "utf8"), note: null };
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
  const existing = fieldOf(request, "existing") as Candidate[];
  const contract = fieldOf(request, "contract") as FunctionContract;
  const program = fieldOf(request, "program") as ProgramContract;
  const functions = fieldOf(request, "functions") as Readonly<Record<string, SemanticFunction>>;
  const generation = fieldOf(request, "generation") as GenerationConfig;

  // Every stored candidate goes through the toolchain as it is now, and the
  // same selection runs over all of them. Stopping at the first one that
  // verified would pick whichever the record happened to store first, and a
  // stored order is not a ranking: three candidates that all verify with the
  // second the fastest would be settled for the third, because it was written
  // first. A build that reuses this way is a build that is choosing again, and
  // the only thing it saves is the asking.
  for (const one of existing) {
    candidates.push(one);
    outcomes.push(await evaluateCandidate(request, one, vectors));
  }
  const reused = selectCandidate(outcomes, contract);
  if (reused !== null) {
    // Nothing was reviewed: the stored candidates are reused as they stand.
    return { candidates, outcomes, selected: reused, benchmarkVector: vectors === null ? null : fieldOf(vectors, "benchmark") as TestVector | null, modelDurationNs: BigInt(0) };
  }

  const context: RepairContext = { functions: new Map(Object.entries(functions)) };

  const maxAttempts = Number(fieldOf(generation, "maxAttempts"));
  const maxCandidates = Number(fieldOf(generation, "maxCandidates"));
  const candidateConcurrency = Number(fieldOf(generation, "candidateConcurrency"));
  const sequenceStart = fieldOf(request, "sequenceStart") as number | undefined;
  // A review's position in the build's record. It is computed rather than
  // counted because it decides which recorded answer a replay serves, and a
  // replay file is written against these positions.
  const firstSequence = existing.length + (sequenceStart ?? 0);
  let modelDurationNs: bigint = BigInt(0);

  // A candidate's id is what every later stage resolves it by — selection, the
  // stored record, `blaze test`, and the files it is written to — so it is
  // allocated here and never derived from anything. Deriving it from the chain
  // and attempt arithmetic handed the target review the id of the last
  // candidate a chain had already produced, and counting the stored candidates
  // to decide where to start handed a rebuild ids the stored ones already
  // held. Either way two different implementations answered to one name and
  // the first match won: a stored object verified as one thing was linked and
  // delivered as another.
  const takenIds = new Set<string>(existing.map((entry) => String(fieldOf(entry, "id"))));
  const ids: number[] = [];
  for (const entry of existing) {
    const found = /^c(\d+)$/.exec(String(fieldOf(entry, "id")));
    const captured = found === null ? "" : String(found[1]);
    ids[ids.length] = captured.length === 0 ? 0 : Number(captured);
  }
  let nextId = 1 + Math.max(sequenceStart ?? 0, ...ids);
  const allocateId = (): string => {
    let id = `c${nextId}`;
    while (takenIds.has(id)) {
      nextId += 1;
      id = `c${nextId}`;
    }
    nextId += 1;
    takenIds.add(id);
    return id;
  };

  // A build with no model configured runs the rules alone: the IR the
  // compiler resolved is the one candidate, folded the way a round that
  // proposed nothing leaves it, and verified and measured the way every
  // candidate is. There is no reviewer to ask, so there are no rounds and no
  // review of the target either.
  if (fieldOf(request, "backend") === undefined) {
    const base = fieldOf(request, "base") as SemanticFunction;
    const candidate: Candidate = {
      id: allocateId(),
      text: printSemanticFunction(optimizeSemanticFunction(structuredClone(base), context.functions)),
      model: "compiler",
      modelConfig: "compiler",
      generatedAt: new Date().toISOString(),
      candidate: 1,
      round: 1,
    };
    candidates.push(candidate);
    outcomes.push(await evaluateCandidate(request, candidate, vectors));
    return {
      candidates,
      outcomes,
      selected: selectCandidate(outcomes, contract),
      benchmarkVector: vectors === null ? null : fieldOf(vectors, "benchmark") as TestVector | null,
      modelDurationNs: BigInt(0),
    };
  }

  // One backend per run: it carries the state a session needs, such as which
  // recorded answer to serve next, but is not built until a review happens.
  // The no-model build returned above, so a request that reaches here has a
  // backend to build.
  let backend: AiBackend | null = null;
  const generationBackend = (): AiBackend => (backend ??= (fieldOf(request, "backend") as () => AiBackend)());

  // Each candidate owns a contiguous block of records and collects its own, so
  // the build reads the same way whatever order the candidates finish in.
  const chains: { candidates: Candidate[]; outcomes: CandidateOutcome[] }[] = [];
  for (let at = 0; at < maxCandidates; at += 1) chains[at] = { candidates: [], outcomes: [] };

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
    const startedAt = monotonicTimeNs();
    const backend = generationBackend();
    const review = await backend.review(asked, sequence);
    return { review, durationNs: monotonicTimeNs() - startedAt };
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
      const programFailure = fieldOf(request, "programFailure") as ProgramFailure | undefined;
      let current = programFailure === undefined
        ? fieldOf(request, "base") as SemanticFunction
        : parseSemanticFunction(String(fieldOf(programFailure, "previous")), program);

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const sequence = firstSequence + index * maxAttempts + attempt;
        // A review can take minutes; say the compiler is waiting on one before
        // the request goes out, so a build does not look stuck.
        const reviewing = fieldOf(request, "onReview") as ((progress: ReviewProgress) => void) | undefined;
        reviewing?.({ stage: "ir", candidate, candidates: maxCandidates, attempt, attempts: maxAttempts });
        const { review, durationNs } = await askFor(
          {
            stage: "ir",
            contract,
            unit: { file: String(fieldOf(request, "unitFile")), function: String(fieldOf(fieldOf(contract, "function"), "name")) },
            program,
            semantics: functions,
            target: fieldOf(request, "target") as TargetSpec,
            output: fieldOf(request, "output") as OutputKind,
            candidate,
            candidates: maxCandidates,
            attempt,
            artifact: printSemanticFunction(current),
            artifactNote: null,
            feedback: [...diagnostics],
            refusals: [...refusals],
            ...(programFailure === undefined ? {} : { programFailure }),
          },
          sequence,
        );
        modelDurationNs += durationNs;
        const revision = revise(current, review, request, context);
        refusals.splice(0, refusals.length, ...revision.refused);

        const regenerated: Candidate = {
          id: allocateId(),
          text: String(fieldOf(revision, "text")),
          model: String(fieldOf(generationBackend(), "id")),
          modelConfig: String(fieldOf(generationBackend(), "id")),
          generatedAt: new Date().toISOString(),
          candidate,
          round: attempt,
          ...(revision.applied.length === 0 ? {} : { proposals: [...revision.applied] }),
          ...(diagnostics.length === 0 ? {} : { feedback: [...diagnostics] }),
        };
        const chainCandidates = fieldOf(chain, "candidates") as Candidate[];
        chainCandidates.push(regenerated);

        // Candidates are measured one at a time even though they were
        // reviewed together, and what this waits for is the measurement
        // rather than the whole of the build: the compiling and verifying
        // ahead of it runs alongside the same work for the other candidates.
        const outcome = await evaluateCandidate(request, regenerated, vectors);
        const chainOutcomes = fieldOf(chain, "outcomes") as CandidateOutcome[];
        chainOutcomes.push(outcome);
        if (fieldOf(outcome, "valid") === true) break;
        current = parseSemanticFunction(revision.text, program);
        diagnostics.push(diagnosticFor(fieldOf(outcome, "failure") as CandidateOutcome["failure"], attempt));
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
    for (const one of fieldOf(chain, "candidates") as readonly Candidate[]) candidates.push(one);
    for (const one of fieldOf(chain, "outcomes") as readonly CandidateOutcome[]) outcomes.push(one);
  }

  if (candidates.length === 0) {
    throw new CompilerError("AiReviewError", "review", "no candidate was produced", "", String(fieldOf(fieldOf(contract, "function"), "name")), "", "");
  }

  const selected = selectCandidate(outcomes, contract);
  const outputKind = String(fieldOf(request, "output"));
  const benchmarkVector = vectors === null ? null : fieldOf(vectors, "benchmark") as TestVector | null;
  if (selected === null || /^ir$/.test(outputKind)) {
    return { candidates, outcomes, selected, benchmarkVector, modelDurationNs };
  }

  // The winner is reviewed against the target the compiler lowered it into, and
  // what that review changes is regenerated and verified as any other
  // candidate. It replaces the winner only by being verified: a proposal the
  // rules produced and the toolchain rejected leaves the winner standing.
  const winner = candidates.find((entry) => String(fieldOf(entry, "id")) === selected);
  const artifact = winner === undefined ? null : await targetArtifact(request, winner);
  if (winner === undefined || artifact === null) {
    return { candidates, outcomes, selected, benchmarkVector, modelDurationNs };
  }
  const targetReviewing = fieldOf(request, "onReview") as ((progress: ReviewProgress) => void) | undefined;
  targetReviewing?.({ stage: "target", candidate: Number(fieldOf(winner, "candidate")), candidates: maxCandidates, attempt: 1, attempts: maxAttempts });
  const { review, durationNs } = await askFor(
    {
      stage: "target",
      contract,
      unit: { file: String(fieldOf(request, "unitFile")), function: String(fieldOf(fieldOf(contract, "function"), "name")) },
      program,
      semantics: functions,
      target: fieldOf(request, "target") as TargetSpec,
      output: outputKind as OutputKind,
      candidate: Number(fieldOf(winner, "candidate")),
      candidates: maxCandidates,
      attempt: 1,
      artifact: String(fieldOf(artifact, "text")),
      artifactNote: fieldOf(artifact, "note") as string | null,
      feedback: [],
      refusals: [],
    },
    firstSequence + maxCandidates * maxAttempts,
  );
  modelDurationNs += durationNs;
  const revision = revise(parseSemanticFunction(String(fieldOf(winner, "text")), program), review, request, context);
  if (revision.applied.length === 0) {
    return { candidates, outcomes, selected, benchmarkVector, modelDurationNs };
  }
  const revised: Candidate = {
    id: allocateId(),
    text: String(fieldOf(revision, "text")),
    model: String(fieldOf(generationBackend(), "id")),
    modelConfig: String(fieldOf(generationBackend(), "id")),
    generatedAt: new Date().toISOString(),
    candidate: Number(fieldOf(winner, "candidate")),
    round: 1,
    proposals: [...revision.applied],
  };
  const outcome = await evaluateCandidate(request, revised, vectors);
  candidates.push(revised);
  outcomes.push(outcome);
  return {
    candidates,
    outcomes,
    selected: fieldOf(outcome, "valid") === true ? String(fieldOf(revised, "id")) : selected,
    benchmarkVector,
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
  const candidate = fieldOf(request, "candidate") as Candidate;
  const contract = fieldOf(request, "contract") as FunctionContract;
  const evaluation: CandidateEvaluationRequest = {
    contract,
    parsed: fieldOf(request, "parsed") as ParsedContract,
    program: fieldOf(request, "program") as ProgramContract,
    functions: fieldOf(request, "functions") as Readonly<Record<string, SemanticFunction>>,
    target: fieldOf(request, "target") as TargetSpec,
    output: fieldOf(request, "output") as OutputKind,
    lowering: fieldOf(request, "lowering") as BackendKind,
    mode: fieldOf(request, "mode") as BuildMode,
    runtime: fieldOf(request, "runtime") as RuntimeKind,
    workspace: fieldOf(request, "workspace") as CodegenWorkspace,
    test: fieldOf(request, "test") as TestConfig,
    benchmark: fieldOf(request, "benchmark") as BenchmarkConfig,
    prepareRuntime: fieldOf(request, "prepareRuntime") as () => Promise<PreparedRuntime | undefined>,
    callable: fieldOf(request, "callable") as ReadonlySet<string>,
    machine: fieldOf(request, "machine") as Machine,
  };
  const outcome = await evaluateCandidate(evaluation, candidate, vectors);
  const failure = fieldOf(outcome, "failure") as CandidateOutcome["failure"];
  const candidateId = String(fieldOf(candidate, "id"));
  if (fieldOf(outcome, "valid") !== true) {
    const category = failure === undefined ? "AssemblyError" : String(fieldOf(failure, "category"));
    throw new CompilerError(category === "VerificationError" ? "VerificationError" : "AssemblyError", String(fieldOf(failure, "stage") ?? "verify"), String(fieldOf(failure, "message") ?? `candidate ${candidateId} is not valid`), fieldOf(failure, "detail") as string | undefined, String(fieldOf(fieldOf(contract, "function"), "name")), candidateId, "");
  }
  const result: StoredCandidateResult = {};
  const verification = fieldOf(outcome, "verification") as VerificationResult | undefined;
  const benchmark = fieldOf(outcome, "benchmark") as BenchmarkResult | undefined;
  if (verification !== undefined) result.verification = verification;
  if (benchmark !== undefined) result.benchmark = benchmark;
  return result;
}

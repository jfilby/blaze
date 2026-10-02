/**
 * Shared data shapes for the AI native compiler.
 *
 * The canonical representation of a function contract is JSON (see
 * private-docs/specs/contract dsl.md). Everything the compiler reads or writes
 * on disk is described here.
 *
 * Contracts are target independent: a contract states what a function or a
 * whole program must do, never what machine it runs on. The target is chosen
 * by the build and reaches a backend beside the contract, never inside it.
 */

import type { Statement } from "./ir.ts";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type PrimitiveTypeName =
  | "bool"
  | "i8"
  | "i16"
  | "i32"
  | "i64"
  | "u8"
  | "u16"
  | "u32"
  | "u64"
  | "f32"
  | "f64"
  | "usize"
  | "isize";

export const PRIMITIVE_TYPES: readonly PrimitiveTypeName[] = [
  "bool",
  "i8",
  "i16",
  "i32",
  "i64",
  "u8",
  "u16",
  "u32",
  "u64",
  "f32",
  "f64",
  "usize",
  "isize",
];

/** A parsed contract type expression. The textual form is the canonical form. */
export type TypeExpr =
  | { kind: "primitive"; name: PrimitiveTypeName }
  | { kind: "ptr"; of: TypeExpr }
  | { kind: "slice"; of: TypeExpr }
  | { kind: "array"; of: TypeExpr; length: number | null }
  /**
   * A reference to an object on the heap. `of` is null until the object is
   * inferred, and `name` is the object it points at once the layouts are known.
   */
  | { kind: "ref"; of: TypeExpr | null; name?: string }
  /** A function that returns nothing. */
  | { kind: "void" };

/* -------------------------------------------------------------------------- */
/* Target                                                                     */
/* -------------------------------------------------------------------------- */

export type Arch = "x86_64" | "aarch64" | "riscv64";
export type OsName = "linux";
export type Abi = "sysv";

export interface TargetSpec {
  arch: Arch;
  os: OsName;
  abi: Abi;
  /** GAS `-march`/`.arch` selector. Empty means the toolchain default. */
  cpu: string;
  features: string[];
}

/* -------------------------------------------------------------------------- */
/* Contract                                                                   */
/* -------------------------------------------------------------------------- */

export interface FunctionParam {
  name: string;
  /** Contract type expression, e.g. `ptr<f32>`, `usize`. */
  type: string;
}

export interface FunctionSignature {
  name: string;
  /**
   * The name the object exports, which is the name of the function in the
   * source unless that name is taken by the host: a program of a TypeScript
   * module has an entry function called `main`, and the executable the driver
   * links already has one.
   */
  symbol: string;
  params: FunctionParam[];
  returns: string;
}

export interface MemoryContract {
  reads: string[];
  writes: string[];
  aliasing: string[];
  alignment?: Record<string, number>;
  lifetime?: string;
  mutability?: Record<string, "read" | "readwrite">;
}

export type FastMathMode = false | "safe" | "aggressive";

export interface NumericContract {
  floatingPoint: "ieee754";
  rounding: "nearest";
  fastMath: FastMathMode;
}

export type Objective = "latency" | "throughput" | "size" | "energy" | "balanced";

export interface OptimizeSpec {
  primary: Objective;
  secondary?: Objective;
}

export type Effect =
  | "memory"
  | "io"
  | "filesystem"
  | "network"
  | "syscall"
  | "random"
  | "clock"
  | "panic"
  | "exception"
  | "atomic";

export interface FunctionContract {
  version: "1";
  function: FunctionSignature;
  requires: string[];
  /**
   * What the result must equal, when one expression can say it. A postcondition
   * is a claim the implementation is checked against; it is not a description
   * of the implementation, and a function has a body either way.
   */
  ensures: string[];
  memory: MemoryContract;
  effects: Effect[];
  numeric: NumericContract;
  optimize: OptimizeSpec;
  /** What the function is: the statements it runs and the objects it lays out. */
  definition: FunctionDefinition;
}

/**
 * What an emitted caller does at one call its source wrote: call the callee's
 * symbol, or write out what the callee does. Decided once for the whole
 * program, because whether a call can be written out is a property of every
 * function the call reaches, not of the one call.
 */
export type CallStrategy = "call" | "inline";

/** One call a function's body makes, and what the artifact does at it. */
export interface CallEdge {
  /** The name the source called it by. */
  callee: string;
  strategy: CallStrategy;
}

/**
 * An object a function allocates: the fields it holds, where each one sits and
 * what the whole object takes. A pointer field is a reference, so an object of
 * references is the tree a recursive function builds.
 */
export interface ObjectLayout {
  name: string;
  size: number;
  align: number;
  fields: { name: string; type: string; offset: number }[];
}

/**
 * The body of a function, as the source wrote it: the statements it runs and
 * the objects it lays out. Every function carries one, whether or not a
 * postcondition also says what its result must equal, because the body is what
 * is implemented and lowered while the postcondition is what it is checked
 * against.
 */
export interface FunctionDefinition {
  statements: Statement[];
  objects: Record<string, ObjectLayout>;
  /** The function allocates an object. */
  allocates: boolean;
  /** The function prints. */
  prints: boolean;
  /** The function reads the arguments the program was given. */
  readsArgv: boolean;
  /**
   * Every call the body makes, in the order it first makes each, with the
   * strategy the outline chose for it.
   */
  calls: CallEdge[];
}

/* -------------------------------------------------------------------------- */
/* Program contract                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A source file as the program sees it. The path is relative to the project
 * directory, so the same program always produces the same contract.
 */
export interface SourceModule {
  path: string;
  source: string;
}

/**
 * The contract of one file: every function it exports, and the files it
 * imports. A contract names no target, so one program contract serves every
 * backend.
 */
export interface FileContract {
  path: string;
  functions: Record<string, FunctionContract>;
  imports: string[];
}

/** One resolved import: which file, and which symbols it binds. */
export interface ContractEdge {
  /** The importing file. */
  from: string;
  /** The imported file. */
  to: string;
  /** Symbols taken from it, in source order. */
  symbols: string[];
}

/**
 * The whole program, contracted: one contract per file plus the edges between
 * them. Target generation does not start until this exists and validates.
 */
export interface ProgramContract {
  version: "1";
  language: string;
  /**
   * The entry module, and the function a build compiles when the entry module
   * is a library. A program has no entry function: its statements run, and
   * every function of the graph is compiled.
   */
  entry: { file: string; function: string | null };
  files: FileContract[];
  edges: ContractEdge[];
}

/* -------------------------------------------------------------------------- */
/* Input                                                                      */
/* -------------------------------------------------------------------------- */

export interface GenerationConfig {
  /** Candidates to generate. Each one is generated from the contract alone. */
  maxCandidates: number;
  /**
   * Attempts allowed per candidate: the first generates, every later one
   * repairs the output the previous attempt was rejected for. A candidate
   * costs at most this many model requests.
   */
  maxAttempts: number;
  /**
   * Extra model requests one attempt is allowed to spend on an answer that
   * carries no implementation: a request the provider failed, or a reply that
   * was empty. Such an answer never becomes a candidate, so it is asked for
   * again in place rather than spent on one of the repair attempts above.
   */
  maxRetries: number;
  /**
   * Candidates generated at the same time. Candidates never wait on each
   * other, only on their own previous attempt, so this is how much of the
   * model latency a build overlaps. 1 generates one candidate at a time.
   * Measurement is never overlapped, whatever this is: candidates are
   * compared on measured speed, and that comparison is only meaningful when
   * nothing else is competing for the machine.
   *
   * What it does not serialise is the work ahead of the measurement — writing
   * the C, assembling it, linking it, running the candidate against its
   * vectors — which has no number in it and so nothing to be measured against.
   * That runs alongside the same work for the other candidates however this is
   * set: a build at 1 is slow because it asks the model once at a time, not
   * because it waits its turn to run gcc.
   */
  candidateConcurrency: number;
  /**
   * Functions reviewed at the same time. Functions are independent of each
   * other in the same way candidates are, so this is how much of a multi
   * function program's model latency a build overlaps. 1 reviews one function
   * at a time.
   *
   * It multiplies with `candidateConcurrency`: three functions of four
   * candidates each are up to twelve reviews in flight, and as many sets of
   * candidates being built and verified at the same time. Measurement stays
   * one at a time whatever this is, because candidates are compared on
   * measured speed and that comparison is only meaningful when nothing else is
   * competing for the machine.
   */
  functionConcurrency: number;
  /**
   * Wall clock budget for ONE model request. Unset means wait as long as the
   * model takes. Set it when a build must fail rather than wait.
   *
   * The budget is per request, not a budget shared across retries: every
   * request is given the whole of it, and a request that exceeds it is not
   * retried. The backend recognises that by the name the abort carries, and
   * only a `TimeoutError` is a timeout: an `AbortError`, which is how a
   * dropped connection arrives, is an ordinary provider failure and is asked
   * for again.
   */
  timeoutSeconds?: number;
}

export interface TestConfig {
  /** Number of randomized test cases. */
  randomCases: number;
  /** Upper bound for generated buffer lengths. */
  maxLength: number;
  /** Seed for the deterministic PRNG used by test generation. */
  seed: number;
}

export interface BenchmarkConfig {
  /** Calls performed inside the isolated benchmark process. */
  iterations: number;
}

/**
 * What a build produces. Every kind is the same semantic IR taken a different
 * distance by the toolchain:
 *
 *   ir       the IR as the compiler resolved it, checked against the contract
 *   c        the C the compiler wrote for it, compiled and verified
 *   asm      the assembly the C compiler made of that C, assembled and verified
 *   machine  the same object, linked into a program and verified by running it
 *   wasm     the WebAssembly module the compiler encoded from the IR, verified
 *            by running it against the contract's vectors
 *
 * The kind is a delivery choice rather than a language anything chooses
 * between, so lowering is the compiler's work on every path and a rule it
 * enforces is never a rule anyone has to be told.
 */
export type OutputKind = "c" | "asm" | "machine" | "wasm" | "ir";

export const OUTPUT_KINDS: readonly OutputKind[] = ["c", "asm", "machine", "wasm", "ir"];

/**
 * What lowers the semantic IR into the artifact a build delivers. The value
 * names what the compiler itself writes; everything after that is the
 * toolchain's:
 *
 *   c       the C the compiler wrote, which `gcc -c` makes an object of
 *   wasm    the module the compiler encoded itself, which needs no toolchain
 *   machine the object the compiler encoded itself, instructions and all
 *
 * A backend is not a distance: how far the build carries the IR is `output`,
 * and a `c` backend delivers the C, the assembly or an object without becoming
 * a different backend. A project names none, and gets the one its output kind
 * implies.
 */
export type BackendKind = "c" | "wasm" | "machine";

export const BACKENDS: readonly BackendKind[] = ["c", "wasm", "machine"];


/**
 * The runtime a build links against. Generated code reaches runtime services
 * through the blaze runtime ABI, never through a host implementation:
 *
 *   none  the compiler emits the runtime itself, on top of libc
 *   nim   a Nim host program and the Nim runtime adapter provide the services
 */
export type RuntimeKind = "none" | "nim";

export const RUNTIME_KINDS: readonly RuntimeKind[] = ["none", "nim"];

/**
 * How hard the toolchain builds, and how much of itself it checks:
 *
 *   debug     optimized for reading: `-O0 -g`, so a delivered program is the
 *             one the compiler wrote with nothing folded away
 *   release   optimized for running: `-O3`, and a contract whose primary
 *             objective is size gets `-O2` instead. A candidate is compiled
 *             with `-ffat-lto-objects` so it is still a self-contained object
 *             to measure, and the delivered program is linked with `-flto`
 *   danger    release, with the runtime's own guards left out: the
 *             use-after-free check, the allocation overflow check, the size
 *             caps and the null checks are not emitted
 * `danger` is a promise about the program rather than about the build, and it
 * is the only one of the three that changes what a candidate does when it
 * runs. Everything the compiler proves about a candidate is proved the same
 * way in all three: the IR is validated before it is lowered either way, and a
 * candidate is verified and measured before it is selected. What a `danger`
 * build stops doing is second-guessing the program at run time.
 *
 * The guards `danger` removes are the only run-time safety checks the
 * generated program carries. There is no bounds check on an element access at
 * any mode: the IR's `element` value holds no length, and the C backend
 * lowers an access to a bare subscript, so an out-of-range read is undefined
 * behaviour on `c`, `asm` and `machine` alike. A `wasm` build traps on one
 * because the module engine does it, which is the engine's behaviour rather
 * than this compiler's, and no mode changes that.
 */
export type BuildMode = "debug" | "release" | "danger";

export const BUILD_MODES: readonly BuildMode[] = ["debug", "release", "danger"];

/** How a built implementation is executed for verification and benchmarking. */
export interface Runner {
  command: string;
  args: string[];
}

/**
 * The model a project is compiled with. Credentials never live here: the
 * provider is named, the key comes from the environment.
 */
export interface ModelSelection {
  provider?: string;
  model?: string;
  /** Assembly file for the offline replay provider. */
  file?: string;
}

export interface SourceInput {
  language: string;
  source: string;
  /** Path of a source file next to the input file, read instead of `source`. */
  sourceFile?: string;
  /** Provider and model for this project, overriding AI_MODEL. */
  model?: string | ModelSelection;
  /** Function of the entry module to compile. Absent when the entry is a program. */
  entry?: string;
  output?: OutputKind;
  /** What lowers the IR. Absent when the output kind implies it. */
  backend?: BackendKind;
  /** How the toolchain builds. Defaults to `debug`. */
  mode?: BuildMode;
  target?: Partial<TargetSpec>;
  runtime?: RuntimeKind;
  optimize?: Partial<OptimizeSpec>;
  numeric?: Partial<NumericContract>;
  generation?: Partial<GenerationConfig>;
  test?: Partial<TestConfig>;
  benchmark?: Partial<BenchmarkConfig>;
}

export const DEFAULT_GENERATION: GenerationConfig = {
  maxCandidates: 5,
  maxAttempts: 3,
  maxRetries: 3,
  candidateConcurrency: 4,
  functionConcurrency: 3,
};

export const DEFAULT_TEST: TestConfig = {
  randomCases: 24,
  maxLength: 1024,
  seed: 0x5eed1234,
};

export const DEFAULT_BENCHMARK: BenchmarkConfig = {
  iterations: 2000,
};

/* -------------------------------------------------------------------------- */
/* Candidates, verification, build records                                    */
/* -------------------------------------------------------------------------- */

export interface Candidate {
  id: string;
  /**
   * The artifact, which is the semantic IR for every kind, whatever is later
   * delivered. It is the program, uncompiled: every backend reads this, and
   * none of them treats it as anything else.
   */
  text: string;
  model: string;
  modelConfig: string;
  generatedAt: string;
  /** Which candidate this belongs to (1-based). Candidates are independent. */
  candidate: number;
  /** Round within its candidate (1-based). The first reviews the resolved IR, later ones what it produced. */
  round: number;
  /**
   * What each review of this artifact changed, oldest first, as the rule that
   * was applied and what it did. Absent for a candidate no proposal changed,
   * which is the IR the compiler resolved from the source as it stands.
   */
  proposals?: string[];
  /** Every diagnostic this candidate collected before this attempt, oldest first. */
  feedback?: string[];
}

export interface CandidateOutcome {
  candidate: string;
  valid: boolean;
  /** null when assembly, assembling, linking and verification all succeeded. */
  failure?: {
    category: string;
    stage: string;
    message: string;
    detail?: string;
  };
  objectSizeBytes?: number;
  textSizeBytes?: number;
  verification?: VerificationResult;
  benchmark?: BenchmarkResult;
  /**
   * The liveness check on a definition-contract candidate: whether it was called
   * once on an input built from its own contract, and what stopped it. Absent
   * for a candidate verified against its own vectors, which is a stronger check
   * than this one, and for one that failed before it could be called.
   */
  probe?: { readonly called: boolean; readonly reason: string | null };
}

export interface TestFailure {
  vector: string;
  expected: string;
  actual: string;
  reason: string;
}

export interface VerificationResult {
  candidate: string;
  passed: boolean;
  cases: number;
  tolerance: number | null;
  failures: TestFailure[];
  durationNs: number;
}

/**
 * Where a program stopped saying what its source says. A function that states
 * no postcondition has no vector to verify it against, so the program it
 * belongs to is the only oracle it has, and this is what that oracle reports.
 */
export interface ProgramMismatch {
  /** The first line the two disagree on, counted from 1. */
  line: number;
  /** What the source prints on that line. */
  expected: string;
  /** What the program printed on that line instead. */
  actual: string;
  /** Everything the source printed, so a repair sees the output it must match. */
  expectedOutput: string;
  /** Everything the program printed. */
  actualOutput: string;
  /**
   * How the program stopped before it printed the rest, when it stopped rather
   * than disagreeing: it never finished, a signal took it, or it failed. A
   * program that stops has no line to disagree with, so this is what a repair
   * round is given instead.
   */
  failure?: string;
  /** What the program wrote to standard error on its way down. */
  failureOutput?: string;
}

/**
 * A program that did not print what its source prints, together with the
 * implementation that produced it. A contract that states what a function does
 * rather than what it returns has no vector of its own, so the program is the
 * only oracle it has, and this is what a review of that implementation is
 * given.
 */
export interface ProgramFailure {
  mismatch: ProgramMismatch;
  /** The IR that produced the output, which is what the next revision starts from. */
  previous: string;
}

export interface BenchmarkResult {
  candidate: string;
  iterations: number;
  durationNs: number;
  /** Operations (calls) per nanosecond. */
  throughput?: number;
}

export interface BuildStatus {
  id: string;
  input: string;
  contract: string;
  target: TargetSpec;
  status: "building" | "success" | "failed";
  /** What this build delivers. */
  outputKind: OutputKind;
  /** What lowered the IR for this build. */
  backend: BackendKind;
  /** How the toolchain built this. */
  mode: BuildMode;
  /** The runtime this build links against. */
  runtime: RuntimeKind;
  /** The candidate selected for each compiled function, by function name. */
  selectedCandidates?: Record<string, string>;
  /**
   * The candidate this build reused for each function it did not rebuild,
   * by function name. A function named here was taken as it stands from the
   * build that verified it, because nothing it was compiled from had changed.
   */
  reused?: Record<string, string>;
  output?: string;
  createdAt: string;
  updatedAt: string;
  /** sha256 of the input source text. */
  sourceHash: string;
  /** sha256 of the canonical contract JSON. */
  contractHash: string;
  model: string;
  modelConfig: string;
  compilerVersion: string;
  /**
   * The engine that built it, as `engineStamp` names it: the release and the
   * fingerprint of the sources that decide what a function is. A later run
   * compares it with its own, so a build that changed the compiler under a
   * project says so instead of quietly re-asking a model for every function.
   */
  engine: string;
  /** Whether this build asked for every function again whatever the engine. */
  recompiled?: boolean;
  error?: { category: string; stage: string; message: string; detail?: string };
}

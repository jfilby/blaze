/**
 * Shared data shapes for the AI native compiler.
 *
 * The canonical representation of a function contract is JSON (see
 * private-docs/specs/contract dsl.md). Everything the compiler reads or writes
 * on disk is described here.
 */

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
  | { kind: "array"; of: TypeExpr; length: number | null };

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
  ensures: string[];
  memory: MemoryContract;
  effects: Effect[];
  numeric: NumericContract;
  target: TargetSpec;
  optimize: OptimizeSpec;
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
   * Candidates generated at the same time. Candidates never wait on each
   * other, only on their own previous attempt, so this is how much of the
   * model latency a build overlaps. 1 generates one candidate at a time.
   * Verification and benchmarking are never overlapped: candidates are
   * compared on measured speed, and that comparison is only meaningful when
   * nothing else is competing for the machine.
   */
  concurrency: number;
  /**
   * Optional wall clock budget for one model request, retries included. Unset
   * means wait as long as the model takes.
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
 * What a build produces. The kind decides both the language the model is asked
 * to write and how far the toolchain takes it:
 *
 *   c        C source, compiled and verified, delivered as source
 *   asm      x86-64 assembly, assembled and verified, delivered as assembly
 *   machine  x86-64 assembly, assembled, linked and verified, delivered as an executable
 *   wasm     WebAssembly text, assembled and verified, delivered as a module
 */
export type OutputKind = "c" | "asm" | "machine" | "wasm";

export const OUTPUT_KINDS: readonly OutputKind[] = ["c", "asm", "machine", "wasm"];

/**
 * The runtime a build links against. Generated code reaches runtime services
 * through the blaze runtime ABI, never through a host implementation:
 *
 *   none  the compiler emits the runtime itself, on top of libc
 *   nim   a Nim host program and the Nim runtime adapter provide the services
 */
export type RuntimeKind = "none" | "nim";

export const RUNTIME_KINDS: readonly RuntimeKind[] = ["none", "nim"];

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
  entry: string;
  output?: OutputKind;
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
  concurrency: 4,
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

export interface AssemblyCandidate {
  id: string;
  assembly: string;
  model: string;
  modelConfig: string;
  generatedAt: string;
  /** Which candidate this belongs to (1-based). Candidates are independent. */
  candidate: number;
  /** Attempt within its candidate (1-based). The first generates, later ones repair. */
  round: number;
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
  /** The runtime this build links against. */
  runtime: RuntimeKind;
  selectedCandidate?: string;
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
  error?: { category: string; stage: string; message: string; detail?: string };
}

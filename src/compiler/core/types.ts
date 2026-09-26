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
  ensures: string[];
  memory: MemoryContract;
  effects: Effect[];
  numeric: NumericContract;
  optimize: OptimizeSpec;
  /** What the function is, for a result no expression can state. */
  definition?: FunctionDefinition;
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
 * The body of a function, for a contract that states no postcondition. A
 * function that branches, recurses, allocates, calls or prints has no result
 * that can be written as one expression, so the contract carries what the
 * function is instead: the statements it runs and the objects it lays out.
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
  /** Function of the entry module to compile. Absent when the entry is a program. */
  entry?: string;
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
  /** The candidate selected for each compiled function, by function name. */
  selectedCandidates?: Record<string, string>;
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

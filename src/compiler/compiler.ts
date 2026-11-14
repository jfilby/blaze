/**
 * The compiler pipeline.
 *
 *   source -> contract -> semantic IR -> review -> target -> review -> output
 *
 * The compiler writes every program. It reads the source, contracts it,
 * resolves each function into the semantic IR, lowers that IR to whatever the
 * project asked for, and proves the result by running it. A model is asked
 * twice along that path — once to read the IR before anything is lowered from
 * it, once to read the target it was lowered into — and answers with a verdict
 * and a list of proposals naming rewrites out of `semantics/repair.ts`. The
 * compiler applies the proposals that hold by rewriting the IR and printing it
 * again, refuses the ones that do not with a reason, and verifies whatever
 * came of either. Nothing a model says is compiled.
 *
 * The IR covers a program body and every function the program declares, each as
 * a whole: its signature, the conditions it is held to, its effects, the
 * objects it lays out, the calls it makes, and its body. `blaze ir` prints any
 * of them, and reads IR back from a file for the same validation a resolved
 * program gets.
 *
 * The contract phase (semantics/program.ts) reads and contracts every file of
 * the program and validates the whole graph. Nothing lowers a target until
 * that phase has produced a valid program contract, and every backend is
 * handed that contract.
 *
 * A program body then becomes the semantic IR (core/semantic-ir.ts, written by
 * semantics/ir-resolve.ts): what the program does, with every value typed and
 * every block naming where control goes. It is validated (semantics/
 * ir-validate.ts) before any toolchain is asked for anything, so a program no
 * backend may lower never reaches gcc, nim or a linker.
 *
 * Everything the compiler produces lives under `.blaze/` in the directory the
 * compiler was run from: JSON build records, intermediate artifacts and the
 * final output. The build record is written before and after the run, so a
 * failed build is as inspectable as a successful one.
 */

import { existsSync, readFileSync, copyFile, hostWriteError, mkdir, readdirEntries, readFile, rename, writeFile, basename, basenameSuffix, dirname, extname, hostEnvironment, hostPlatform, join, relative, resolveFrom, isDirectoryPath } from "./core/platform.ts";
import { createBackend, describeProviderStop, quoteReply, type AnswerDump, type PromptDump, type ProviderStop } from "./ai/backend.ts";
import { parse as parseToml } from "#host/toml";
import { normalizeOptimize, parseContract, type ParsedContract } from "./semantics/contract.ts";
import { INLINE_MODULE, runContractPhase, type ContractPhase } from "./semantics/program.ts";
import { contractsByName, vectorChecked, type ContractsByName } from "./semantics/calls.ts";
import type { Frontend, ProgramBody } from "./semantics/module.ts";
import type {
  SemanticBlock,
  SemanticFunction,
  SemanticProgram,
  SemanticSlot,
  SemanticStatement,
  SemanticValue,
  SemanticType,
} from "./core/semantic-ir.ts";
import { slotType, statementBlocksOf, statementValues, walkValues } from "./core/semantic-ir.ts";
import { resolveObjects } from "./semantics/objects.ts";
import { verifyProgram, type ProgramVerification } from "./toolchain/verify-program.ts";
import type { TestVector } from "./toolchain/verifier.ts";
import { buildProgramDriver } from "./toolchain/driver.ts";
import { buildProgramModule, type ModuleFunction } from "./toolchain/ir-wasm.ts";
import { buildObject as buildMachineObject, machineRefusal, type MachineResult } from "./toolchain/ir-machine.ts";
import { buildProgramHost } from "./runtime/nim-program.ts";
import { usesSqliteSource } from "./runtime/sqlite.ts";
import { usesTritonSource } from "./runtime/triton.ts";
import { httpRuntimeNeeds, mentionsHttpModule } from "./runtime/http-needs.ts";
import { resolveProgram } from "./semantics/ir-resolve.ts";
import type { LiteralKeys } from "./semantics/program-objects.ts";
import { resolveFunction, resolveModule, type FunctionContext } from "./semantics/ir-function.ts";
import { validateSemanticFunction } from "./semantics/ir-validate.ts";
import { optimizeProgram, optimizeSemanticFunction, optimizeSemanticProgram } from "./semantics/optimize-ir.ts";
import { wholeElementArithmetic } from "./semantics/whole-elements.ts";
import { programIsParallel } from "./semantics/parallel.ts";
import type { Threading } from "./core/target.ts";

import { parseSemanticFunction, printSemanticFunction, printSemanticModule } from "./semantics/ir-text.ts";
import { validateSemanticProgram } from "./semantics/ir-validate.ts";
import { parseSemanticProgram, printSemanticProgram } from "./semantics/ir-text.ts";
import { assertAssemblerSupportsArch, callableSymbols } from "./toolchain/assembler.ts";
import {
  evaluateStoredCandidate,
  machine,
  implementationLabel,
  reusableFiles,
  reusedResult,
  reviewCandidates,
  runtimePreparer,
  type CodegenResult,
  type CodegenWorkspace,
  type PreparedRuntime,
} from "./codegen.ts";
import { CompilerError, toCompilerError } from "./core/errors.ts";
import { createJsonStore, flushToDisk, hashText, hashValue, type JsonStore, storeResolve, storeWrite, storeExists, storeRemove, storeMkdirp, storeRead, storeReadIfValid } from "./core/json-store.ts";
import { byName } from "./core/named-record.ts";
import { frontendFor } from "./semantics/frontend.ts";
import { resolveModel, type ModelConfiguration } from "./ai/model.ts";
import {
  readIncremental,
  reusable,
  unitKeys,
  type IncrementalEntry,
  type IncrementalRecord,
  type ReuseLevel,
  type UnitKeys,
} from "./incremental.ts";
import {
  assertBuildableTarget,
  assertLibrarySupported,
  assertRuntimeSupported,
  EXECUTABLE_SUFFIX,
  normalizeTarget,
  optimizationOptions,
  programVerificationFor,
} from "./core/target.ts";
import { run } from "./core/process.ts";
import { toolchainForTarget } from "./core/toolchain.ts";

import { COMPILER_VERSION, engineStamp, toolchainFingerprints } from "./core/version.ts";
import {
  type ProgramMismatch,
  DEFAULT_BENCHMARK,
  DEFAULT_GENERATION,
  DEFAULT_TEST,
  type Candidate,
  type BenchmarkResult,
  type CandidateOutcome,
  type Runner,
  type RuntimeKind,
  RUNTIME_KINDS,
  BACKENDS,
  type BackendKind,
  BUILD_MODES,
  type BuildMode,
  type BuildStatus,
  type LibraryKind,
  OUTPUT_KINDS,
  type FunctionContract,
  type ObjectLayout,
  type ProgramContract,
  type FileContract,
  type GenerationConfig,
  type Objective,
  type OptimizeSpec,
  type OutputKind,
  type SourceInput,
  type SourceModule,
  type TestConfig,
  type TargetSpec,
  type VerificationMode,
  type VerificationResult,
} from "./core/types.ts";

export const STATE_DIRECTORY = ".blaze";

/**
 * How many times a build regenerates a program that did not print what its
 * source prints. Every round costs a full generation of the functions the
 * program is the only oracle for, so this is deliberately small: the loop is
 * for a program that is one mistake away from agreeing, not for one that is
 * not going to.
 */
const PROGRAM_REPAIR_ROUNDS = 2;

export type Reporter = (stage: string, status: "ok" | "fail" | "info", message: string) => void;

export interface BuildOptions {
  /** Directory the compiler was run from; state lives in `<cwd>/.blaze`. */
  cwd: string;
  /** Model specification, overriding AI_MODEL. */
  model?: string;
  /** Reuse previously built and verified candidates instead of asking the model. */
  reuse: boolean;
  maxCandidates?: number;
  maxAttempts?: number;
  /**
   * Ask the user a yes/no question. A build that has no way to ask — a pipe, a
   * test, a script — answers for itself, so nothing ever blocks on a terminal
   * that is not there.
   */
  confirm?: (question: string) => Promise<boolean>;
  /**
   * Rebuild every function whatever the engine says, and without asking: the
   * stored candidates and objects are kept, and what was reviewed from
   * different inputs is asked for again.
   */
  recompile?: boolean;
  /** Extra model requests one attempt may spend on an answer with no implementation. */
  maxRetries?: number;
  /** Candidates reviewed at the same time; 1 reviews them one at a time. */
  candidateConcurrency?: number;
  /** Functions reviewed at the same time; 1 reviews them one at a time. */
  functionConcurrency?: number;
  randomCases?: number;
  maxLength?: number;
  /** What the build delivers; overrides the input file. */
  output?: OutputKind;
  /** What lowers the IR; overrides the input file. */
  backend?: BackendKind;
  /** How the toolchain builds; overrides the input file. */
  mode?: BuildMode;
  /** The runtime to link against; overrides the input file. */
  runtime?: RuntimeKind;
  /** Print the prompt sent to the model for every attempt. */
  debug?: boolean;
  /** How the delivered program is checked; overrides the project file. */
  verify?: VerificationMode;
  /**
   * The arguments a program is checked with: the source and the delivered
   * binary are both run with them, so a program that reads the command line is
   * checked against the source reading the same one.
   */
  arguments?: readonly string[];
}

export interface BuildOutcome {
  project: string;
  build: BuildStatus;
  /** Every function the build compiled, by name. */
  contracts: Record<string, FunctionContract>;
  /** The validated contract graph every file of the program took part in. */
  program: ProgramContract;
  /** The statements the build delivered a program for, when it is one. */
  body?: ProgramBody;
  candidates: Record<string, Candidate[]>;
  verification: Record<string, VerificationResult[]>;
  benchmark: Record<string, BenchmarkResult[]>;
  generation: Record<string, unknown>;
  outputKind: OutputKind;
  outputPath: string | null;
  outputAssemblyPath: string | null;
}

export interface ProjectPaths {
  id: string;
  root: string;
  input: string;
  contract: string;
  candidates: string;
  generation: string;
  /** What an earlier build proved per function, and what a build may reuse. */
  incremental: string;
  verification: string;
  benchmark: string;
  build: string;
  work: string;
  output: string;
  outputBinary: string;
  outputAssembly: string;
  outputSource: string;
  outputIr: string;
  outputModule: string;
  outputHost: string;
  outputObject: string;
  outputProgram: string;
}

/**
 * Normalizes the requested deliverable. A project that names none is built
 * through the boundary: the compiler resolves the semantic IR of a function
 * from the source and writes the target code from it, so no register, offset or
 * calling convention is ever a model's to choose.
 */
function resolveOutputKind(requested: OutputKind | undefined): OutputKind {
  if (requested === undefined) return "ir";
  if (!OUTPUT_KINDS.includes(requested)) {
    throw new CompilerError("InputError", "input", `unknown output kind "${String(requested)}"`, `expected one of ${OUTPUT_KINDS.join(", ")}`, "", "", "");
  }
  return requested;
}

/**
 * Normalizes the requested lowering. A project that names none gets the one
 * its output kind implies, because a module can only come from the backend
 * that encodes one.
 *
 * The two axes are separate and both are real: `output` is how far the build
 * carries the IR and `backend` is what writes the artifact it carries it into.
 * A `c` backend delivers the C, the assembly or an object without becoming a
 * different backend, so naming one is not naming the other.
 *
 * What each backend can deliver is a table rather than a test per pair, so a
 * backend added later states its reach once. A module links into nothing this
 * build links, and a `c` backend writes no module, so the two are each other's
 * only partner today.
 */
const BACKEND_DELIVERS: Record<BackendKind, readonly OutputKind[]> = {
  c: ["ir", "c", "asm", "machine"],
  wasm: ["wasm"],
  machine: ["machine"],
};

/**
 * The backend an output kind names when a project names none. Each kind is
 * delivered by the backend that writes it: a module by the one that encodes a
 * module, an object by the one that encodes an object, and the text a C
 * compiler reads by the one that writes it.
 */
export function impliedBackend(output: OutputKind): BackendKind {
  if (output === "wasm") return "wasm";
  if (output === "machine") return "machine";
  return "c";
}

function resolveBackend(requested: BackendKind | undefined, output: OutputKind): BackendKind {
  if (requested === undefined) return impliedBackend(output);
  if (!BACKENDS.includes(requested)) {
    throw new CompilerError("InputError", "input", `unknown backend "${String(requested)}"`, `expected one of ${BACKENDS.join(", ")}`, "", "", "");
  }
  if (!BACKEND_DELIVERS[requested].includes(output)) {
    const deliverable = BACKEND_DELIVERS[requested].join(", ");
    throw new CompilerError("InputError", "input", `the "${requested}" backend cannot deliver the "${output}" output kind`, `it delivers ${deliverable}; build it without --backend, or name one of ${BACKENDS.filter((backend) => BACKEND_DELIVERS[backend].includes(output)).join(", ")}`, "", "", "");
  }
  return requested;
}

/**
 * Normalizes the requested build mode. `debug` is the default: a build that
 * names none is optimized for reading, which is the mode that shows a reader
 * what the compiler wrote.
 */
function resolveBuildMode(requested: BuildMode | undefined): BuildMode {
  if (requested === undefined) return "debug";
  if (!BUILD_MODES.includes(requested)) {
    throw new CompilerError("InputError", "input", `unknown mode "${String(requested)}"`, `expected one of ${BUILD_MODES.join(", ")}`, "", "", "");
  }
  return requested;
}

/**
 * Normalizes the requested runtime. `none` is the default: the compiler emits
 * the runtime itself, and only a named host replaces it.
 */
function resolveRuntimeKind(requested: RuntimeKind | undefined, output: OutputKind): RuntimeKind {
  if (output === "wasm" && requested !== undefined && requested !== "none") {
    throw new CompilerError("InputError", "input", `a WebAssembly module cannot link the "${requested}" runtime`, "a wasm module imports no host runtime; build it with --output machine, or drop --runtime", "", "", "");
  }
  if (requested === undefined) return "none";
  if (!RUNTIME_KINDS.includes(requested)) {
    throw new CompilerError("InputError", "input", `unknown runtime "${String(requested)}"`, `expected one of ${RUNTIME_KINDS.join(", ")}`, "", "", "");
  }
  return requested;
}

/**
 * The libraries a source asks to link beside its runtime.
 *
 * The target decides which of them exist: SQLite is available on both targets,
 * Triton is not available on QNX, and the refusal names the target rather than
 * letting the source lower to objects that cannot link. A source that asks for
 * neither links neither, so a build that does not use a library does not carry
 * one.
 */
function libraryKindsFor(source: string, target: TargetSpec): LibraryKind[] {
  const libraries: LibraryKind[] = [];
  if (usesSqliteSource(source)) libraries.push("sqlite");
  if (usesTritonSource(source)) {
    assertLibrarySupported(target, "triton");
    libraries.push("triton");
  }
  return libraries;
}

/**
 * A project is named after its `blaze.toml`, or after the directory that
 * holds one: a directory with a blaze.toml in it is the project. Any other
 * `.toml` file names its own project, so examples can stay flat.
 */
export function projectIdFor(inputPath: string): string {
  const name = basenameSuffix(inputPath, extname(inputPath));
  if (name === "blaze") {
    const directory = basename(dirname(inputPath));
    if (directory !== "" && directory !== "." && directory !== "..") return directory;
  }
  return name === "" ? "project" : name;
}

/**
 * The directory one project file's store lives in.
 *
 * The name alone is not a directory two projects can share, because a name is
 * not unique: `a/app.toml` and `b/app.toml` are both `app`, and both were
 * stored under `.blaze/projects/app` — one project's `incremental.json` erased
 * by the other's, and a candidate object linked for one under the other. The
 * readable name is kept and the path is hashed beside it, so the directory
 * says which project it is and is still unique.
 */
function projectStoreId(absoluteInput: string): string {
  return `${projectIdFor(absoluteInput)}-${hashText(absoluteInput).slice(0, STORE_HASH_LENGTH)}`;
}

/** How much of a path's hash a store directory carries, which is what tells one name's entry from another's. */
const STORE_HASH_LENGTH = 12;

/**
 * The store directory a project name refers to.
 *
 * A store directory carries the readable name and a hash of the path beside
 * it, because a name is not unique and two projects sharing one directory
 * overwrite each other's cache. A command that is handed a bare name rather
 * than a path therefore looks the directory up by that name rather than
 * computing one: the exact set of directories named for a project is what it
 * is asked about, and a name with nothing stored under it is the answer the
 * caller already reports.
 *
 * The name has to be the whole of it, not a prefix of it. A store directory for
 * `app-2` also begins `app-`, so matching on the prefix answered `app` with
 * another project's contract and candidates — and reported its results under
 * the name asked for.
 */
async function storedPaths(store: JsonStore, root: string, project: string): Promise<ProjectPaths> {
  const prefix = `${project}-`;
  const entries = await readdirEntries(join(root, "projects")).catch(() => []);
  const names = entries.map((entry) => String((entry as unknown as Record<string, unknown>)["name"]));
  const found = names.filter(
    (entry) => entry.startsWith(prefix) && entry.length === prefix.length + STORE_HASH_LENGTH,
  );
  if (found.length === 0) return projectPaths(project, project);
  // More than one is two projects with the same name and different paths, which
  // a name alone cannot tell apart. The one that wrote its record last is the one
  // whose answers are the most recent ones, and that is what this reads.
  const written: [string, number][] = await Promise.all(
    found.map(async (entry) => {
      const paths = projectPaths(project, entry);
      const pathFields = paths as unknown as Record<string, unknown>;
      const recordPath = String(pathFields["build"]);
      const build = (await storeExists(store, recordPath)) ? await storeRead<BuildStatus>(store, recordPath) : undefined;
      const buildFields = build as unknown as Record<string, unknown> | undefined;
      return [entry, Date.parse(buildFields === undefined ? "" : String(buildFields["updatedAt"] ?? "")) || 0] as [string, number];
    }),
  );
  written.sort((left, right) => right[1] - left[1]);
  return projectPaths(project, written[0]?.[0] as string);
}

function projectPaths(id: string, storeId: string): ProjectPaths {
  const root = `projects/${storeId}`;
  return {
    id,
    root,
    input: `${root}/input.json`,
    contract: `${root}/contract.json`,
    candidates: `${root}/candidates.json`,
    incremental: `${root}/incremental.json`,
    generation: `${root}/generation.json`,
    verification: `${root}/verification.json`,
    benchmark: `${root}/benchmark.json`,
    build: `${root}/build.json`,
    work: `${root}/work`,
    output: `${root}/output`,
    outputBinary: `${root}/output/${id}`,
    outputAssembly: `${root}/output/${id}.s`,
    outputSource: `${root}/output/${id}.c`,
    outputIr: `${root}/output/${id}.ir`,
    outputModule: `${root}/output/${id}.wasm`,
    outputHost: `${root}/output/${id}.host.mjs`,
    outputObject: `${root}/output/${id}.o`,
    outputProgram: `${root}/output/${id}.program`,
  };
}

/** The project input a record holds, at the type the phase reads it as. */
function sourceInputOf(value: unknown): SourceInput {
  return value as SourceInput;
}

/** A project file, plus what the compiler needs to read the program it names. */
interface ProjectInput {
  input: SourceInput;
  /** The module the build compiles, with the path the project knows it by. */
  entry: SourceModule;
  /** The directory the project file lives in; imports resolve against it. */
  directory: string;
}

function readInput(path: string): ProjectInput {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    throw new CompilerError("InputError", "input", `cannot read input file ${path}`, cause instanceof Error ? cause.message : String(cause), "", "", "");
  }
  // A source file is not a project file. Saying so beats reporting a TOML
  // parse error on code the compiler was never meant to read directly.
  if (extname(path) !== ".toml") {
    throw new CompilerError("InputError", "input", `${path} is a source file, not a project file`, "blaze builds the TOML project file, which names the source file to compile; run blaze build with the blaze.toml beside it", "", "", "");
  }
  let parsed: unknown;
  try {
    parsed = parseToml(text);
  } catch (cause) {
    throw new CompilerError("InputError", "input", `${path} is not valid TOML`, cause instanceof Error ? cause.message : String(cause), "", "", "");
  }
  const input = parsed as Partial<SourceInput> & { sourceFile?: string };
  if (typeof input.language !== "string") {
    throw new CompilerError("InputError", "input", `${path} must define "language"`, "", "", "", "");
  }
  // A host table names a file for a path the project holds, and every entry is
  // a path of its own: a table with a value that is not a path, or a key that
  // is not one, is a project that cannot be read the way it says.
  const hostValue = (input as Record<string, unknown>)["host"];
  if (hostValue !== undefined) {
    const table = hostValue;
    if (typeof table !== "object" || table === null || Array.isArray(table)) {
      throw new CompilerError("InputError", "input", `${path} has a "host" that is not a table`, "", "", "", "");
    }
    for (const [from, to] of Object.entries(table as Record<string, unknown>)) {
      if (typeof to !== "string" || String(to).length === 0 || from === "") {
        throw new CompilerError("InputError", "input", `${path} has a host replacement that is not a path`, `"${from}" is read as ${typeof to === "string" ? JSON.stringify(to) : typeof to}`, "", "", "");
      }
    }
  }
  rejectCredentials(path, input);
  const directory = dirname(path);
  // `sourceFile` names a source file next to the project file, so the example
  // projects compile the real file instead of a copy of it pasted into the
  // project file. Its path is the one the program is known by, so it names
  // every contract.
  let entryPath = INLINE_MODULE;
  const sourceFile = (input as Record<string, unknown>)["sourceFile"];
  if (sourceFile !== undefined) {
    if (typeof sourceFile !== "string" || String(sourceFile).length === 0) {
      throw new CompilerError("InputError", "input", `${path} has an empty "sourceFile"`, "", "", "", "");
    }
    const sourcePath = resolveFrom(directory, String(sourceFile));
    try {
      entryPath = relative(directory, sourcePath);
      (input as Record<string, unknown>)["source"] = readFileSync(sourcePath, "utf8");
    } catch (cause) {
      throw new CompilerError("InputError", "input", `cannot read source file ${sourcePath}`, cause instanceof Error ? cause.message : String(cause), "", "", "");
    }
  }

  const sourceText = (input as Record<string, unknown>)["source"];
  if (typeof sourceText !== "string" || String(sourceText).trim().length === 0) {
    throw new CompilerError("InputError", "input", `${path} must define "source" or "sourceFile"`, "", "", "", "");
  }
  // A module map names the file a host specifier is built from. The key is the
  // boundary the sources import, and the value is a path inside the project:
  // anything else would let a project file silently rename its own sources.
  const modules = (input as Record<string, unknown>)["modules"];
  if (modules !== undefined) {
    if (modules === null || typeof modules !== "object" || Array.isArray(modules)) {
      throw new CompilerError("InputError", "input", `${path} has a "modules" that is not a table`, 'write "[modules]" with entries such as \"#platform\" = "core/platform-native.ts"', "", "", "");
    }
    for (const [specifier, target] of Object.entries(modules as Record<string, unknown>)) {
      if (!specifier.startsWith("#")) {
        throw new CompilerError("InputError", "input", `${path} maps "${specifier}", which is not a host specifier`, "only a #-prefixed import is the boundary a project may map to its own file", "", "", "");
      }
      const targetText = String(target);
      if (typeof target !== "string" || targetText.length === 0 || targetText.startsWith("/") || targetText.includes("..")) {
        throw new CompilerError("InputError", "input", `${path} maps "${specifier}" to ${JSON.stringify(target)}`, "the mapped module is a path inside the project, such as \"core/platform-native.ts\"", "", "", "");
      }
    }
  }
  return { input: input as SourceInput, entry: { path: entryPath, source: String(sourceText) }, directory };
}

/** Reads a module the program imports, by the path its importer used. */
function moduleReader(directory: string): (path: string) => string | null {
  return (path) => {
    const full = resolveFrom(directory, path);
    return existsSync(full) ? readFileSync(full, "utf8") : null;
  };
}

/**
 * A key in a project file is a leak waiting to happen; the environment holds
 * credentials. The words are what name one however the key spells it, and a
 * key is matched on the shape of its name rather than on a list of the exact
 * ones: a six word list passes `x-api-key` and `apiKey2` straight through,
 * and both are written to the store whole.
 */
const CREDENTIAL_WORDS: readonly string[] = [
  "apikey",
  "auth",
  "bearer",
  "credential",
  "key",
  "passwd",
  "password",
  "secret",
  "token",
];

function rejectCredentials(path: string, input: Record<string, unknown>): void {
  // The key itself is what leaks, wherever it sits: a project is written into
  // the store whole, so a credential named at the top level is stored just as
  // much as one nested under a provider.
  const scan = (fields: Record<string, unknown>, where: string): void => {
    for (const [key, value] of Object.entries(fields)) {
      const at = where === "" ? key : `${where}.${key}`;
      // The name is matched with its punctuation and its case taken out, so
      // that `x-api-key`, `api_key` and `apiKey2` are one shape of a key.
      const name = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (CREDENTIAL_WORDS.some((word) => name.includes(word))) {
        throw new CompilerError("InputError", "input", `${path} puts a credential in "${at}"`, "a project names its provider and model; the API key comes from the environment", "", "", "");
      }
      // An array is an object here, so the branch above already walks into
      // it, by index. There is no second kind of container to look for.
      if (typeof value === "object" && value !== null) scan(value as Record<string, unknown>, at);
    }
  };
  scan(input, "");
}

/** Turns the project's model selection into the spec the resolver understands. */
export function modelSpec(selection: SourceInput["model"], path: string): string | undefined {
  if (selection === undefined) return undefined;
  if (typeof selection === "string") return selection;
  if (typeof selection !== "object" || selection === null) {
    throw new CompilerError("InputError", "input", `${path} has a "model" that is neither a string nor an object`, "", "", "", "");
  }
  const table = selection as Record<string, unknown>;
  const provider = table["provider"];
  const model = table["model"];
  const file = table["file"];
  if (String(provider) === "replay") {
    if (file === undefined || String(file).length === 0) {
      throw new CompilerError("InputError", "input", `${path} selects the replay provider without a "file"`, 'the offline provider serves recorded IR: "model": { "provider": "replay", "file": "candidate.json" }', "", "", "");
    }
    return `replay:${file}`;
  }
  // A table that names nothing is a project with no model configured: the
  // commented-out provider lines kept between builds leave exactly this
  // behind, and a build runs the rules alone. One half of the pair named and
  // the other not is a selection gone wrong, and is reported.
  if (provider === undefined && model === undefined && file === undefined) return undefined;
  if (provider === undefined || String(provider).length === 0 || model === undefined || String(model).length === 0) {
    throw new CompilerError("InputError", "input", `${path} must name both a provider and a model`, '"model": { "provider": "openrouter", "model": "anthropic/claude-sonnet-4.5" }', "", "", "");
  }
  return `${provider}/${model}`;
}

/**
 * The most re-requests one attempt may be asked to spend. The wait between
 * them backs off and then stops growing, so a project cannot buy a build
 * that sits silent for days: past this many, asking again is not a retry
 * strategy, it is a build with no answer coming.
 */
export const MAX_RETRIES = 16;

/**
 * The generation settings a project file gets wrong, refused before any work
 * starts. A value the compiler cannot honour is a typo in a file rather than
 * a provider failure, and it is checked here so it is reported as the input
 * error it is instead of being multiplied by every candidate of every
 * function and then reported as a request that failed.
 */
function assertGenerationInput(path: string, input: SourceInput): void {
  const generation = (input as unknown as Record<string, unknown>)["generation"] as Record<string, unknown> | undefined;
  if (generation === undefined) return;
  const refuse = (setting: string, value: number, why: string): void => {
    throw new CompilerError("InputError", "input", `${path} sets "generation.${setting}" to ${value}`, `"generation.${setting}" must be ${why}`, "", "", "");
  };
  const timeoutRaw = generation["timeoutSeconds"];
  const timeoutSeconds = timeoutRaw === undefined ? undefined : Number(timeoutRaw);
  if (timeoutSeconds !== undefined && (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)) {
    refuse("timeoutSeconds", timeoutSeconds, "a positive number of seconds");
  }
  const retriesRaw = generation["maxRetries"];
  const maxRetries = retriesRaw === undefined ? undefined : Number(retriesRaw);
  if (maxRetries !== undefined && (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > MAX_RETRIES)) {
    refuse("maxRetries", maxRetries, `a whole number of re-requests from 0 to ${MAX_RETRIES}`);
  }
  // Both of these count the work a build does, so a zero of either asks for
  // none: it is a typo, and reporting it later as a model that produced no
  // candidate sent looking for a provider problem where there was none.
  for (const setting of ["maxCandidates", "maxAttempts"] as const) {
    const raw = generation[setting];
    const value = raw === undefined ? undefined : Number(raw);
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
      refuse(setting, value, "a whole number of at least 1");
    }
  }
}

/** A model request is only bounded when the project asks for a budget. */
function requestTimeoutMs(input: SourceInput): number | undefined {
  const generation = (input as unknown as Record<string, unknown>)["generation"] as Record<string, unknown> | undefined;
  const raw = generation?.["timeoutSeconds"];
  return raw === undefined ? undefined : Number(raw) * 1000;
}

/** The prompts a build sends, for `--debug`. Diagnostics belong on stderr. */
function printPrompt(dump: PromptDump): void {
  // The artifact is named as well as the attempt: a build reviews the IR of
  // every candidate and then the target of the one it selected, and both are
  // asked for by the same candidate and round.
  const fields = dump as unknown as Record<string, unknown>;
  const at = `${String(fields["stage"])} ${String(fields["candidate"])}.${String(fields["attempt"])}`;
  hostWriteError(
    `\n-- prompt ${at}: system --\n${String(fields["system"])}\n-- prompt ${at}: user --\n${String(fields["user"])}\n`,
  );
}

/**
 * What a model answered with, for `--debug`. Only the answers that were not
 * reviews are printed: a refusal names a line of one of them, and a reply the
 * compiler could read is already in the build log as the verdicts and the
 * proposals that came out of it.
 */
function printAnswer(dump: AnswerDump): void {
  const fields = dump as unknown as Record<string, unknown>;
  const at = `${String(fields["stage"])} ${String(fields["candidate"])}.${String(fields["attempt"])} request ${String(fields["retry"])}`;
  // An answer that was nothing at all is printed as nothing: a retry line reads
  // the same whether the model wrote an essay or a single space.
  const quoted = quoteReply(String(fields["answer"]));
  hostWriteError(`\n-- answer ${at} --\n${quoted.length === 0 ? "(nothing)" : quoted.join("\n")}\n`);
}

function testConfigFor(input: SourceInput, options: BuildOptions): TestConfig {
  const test = (input as unknown as Record<string, unknown>)["test"] as Record<string, unknown> | undefined;
  const given = options as unknown as Record<string, unknown>;
  return {
    randomCases: Number(given["randomCases"] ?? (test === undefined ? undefined : test["randomCases"]) ?? DEFAULT_TEST.randomCases),
    maxLength: Number(given["maxLength"] ?? (test === undefined ? undefined : test["maxLength"]) ?? DEFAULT_TEST.maxLength),
    seed: Number((test === undefined ? undefined : test["seed"]) ?? DEFAULT_TEST.seed),
  };
}

function generationConfigFor(input: SourceInput, options: BuildOptions): GenerationConfig {
  const generation = (input as unknown as Record<string, unknown>)["generation"] as Record<string, unknown> | undefined;
  const given = options as unknown as Record<string, unknown>;
  const optional = (key: string): number | undefined => {
    const option = given[key];
    if (option !== undefined) return Number(option);
    const selected = generation === undefined ? undefined : generation[key];
    return selected === undefined ? undefined : Number(selected);
  };
  const pick = (key: string, fallback: number): number => optional(key) ?? fallback;
  return {
    maxCandidates: pick("maxCandidates", DEFAULT_GENERATION.maxCandidates),
    maxAttempts: pick("maxAttempts", DEFAULT_GENERATION.maxAttempts),
    maxRetries: pick("maxRetries", DEFAULT_GENERATION.maxRetries),
    candidateConcurrency: pick("candidateConcurrency", DEFAULT_GENERATION.candidateConcurrency),
    functionConcurrency: pick("functionConcurrency", DEFAULT_GENERATION.functionConcurrency),
    timeoutSeconds: optional("timeoutSeconds"),
  };
}

async function writeBuildRecord(store: JsonStore, buildPath: string, build: BuildStatus): Promise<void> {
  await storeWrite(store, buildPath, build);
}

/** The path a project's build record is written to. */
function buildPathOf(paths: ProjectPaths): string {
  return String((paths as unknown as Record<string, unknown>)["build"]);
}

/**
 * How long ago a record says it was written, in the words a person reads: the
 * build that is about to be redone is usually a build from this session, and
 * an ISO timestamp says less about that than "2 minutes ago". A time this
 * compiler cannot read is the timestamp itself, because a guess would be
 * worse than the text it stands in for.
 */
function agoFrom(iso: string | undefined): string {
  if (iso === undefined) return "at an unrecorded time";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 45) return "moments ago";
  const names: readonly string[] = ["minute", "hour", "day"];
  const sizes: readonly number[] = [60, 3600, 86400];
  for (let at = 0; at < names.length; at += 1) {
    const name = names[at] as string;
    const size = sizes[at] as number;
    const count = Math.round(seconds / size);
    if (count < 60) return `${count} ${name}${count === 1 ? "" : "s"} ago`;
  }
  const days = Math.round(seconds / 86400);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * Records that a project was rejected before any build could start. The
 * record carries what the last build named, because that is the build this
 * one failed to be, and it is marked failed so nothing reads it as the
 * project's last success.
 */
async function recordRejected(
  store: JsonStore,
  paths: ProjectPaths,
  id: string,
  previous: BuildStatus | undefined,
  target: TargetSpec | undefined,
  cause: unknown,
): Promise<CompilerError> {
  const failure = toCompilerError(cause, "InputError", "input", "", "", "", "", "");
  const error = new CompilerError(failure.category, failure.stage, failure.message, failure.detail, failure.functionName, failure.candidate, id);
  const stamp = new Date().toISOString();
  // The target the project named is known before most refusals, and a record
  // that named the default target instead would tell a later reader the
  // project was a Linux build that failed rather than a QNX build that was
  // refused. Only a refusal before the target was read falls back to the last
  // build's target, and only a project that never had one falls back to the
  // default.
  const recordTarget = target ?? previous?.target ?? normalizeTarget(undefined);
  // The engine is this one, not the last build's: the record says which
  // compiler rejected the project, and a record written before this compiler
  // existed has nothing to compare a later build against.
  const engine = engineStamp(await toolchainFingerprints());
  // A rejected build still selected the profile it would have used. Selection
  // can fail for a target this host cannot build, and that refusal is the
  // record's subject, so the field is left out rather than replacing the
  // diagnostic.
  let toolchain: string | undefined;
  try {
    toolchain = toolchainForTarget(recordTarget).id;
  } catch {
    toolchain = previous?.toolchain;
  }
  const pathFields = paths as unknown as Record<string, unknown>;
  const inputStorePath = String(pathFields["input"]);
  const contractPath = String(pathFields["contract"]);
  await writeBuildRecord(store, buildPathOf(paths), {
    id,
    input: inputStorePath,
    contract: contractPath,
    target: recordTarget,
    status: "failed",
    outputKind: previous?.outputKind ?? "machine",
    backend: previous?.backend ?? "c",
    mode: previous?.mode ?? "debug",
    ...(toolchain === undefined ? {} : { toolchain }),
    runtime: previous?.runtime ?? "none",
    createdAt: previous?.createdAt ?? stamp,
    updatedAt: stamp,
    sourceHash: previous?.sourceHash ?? "",
    contractHash: previous?.contractHash ?? "",
    model: previous?.model ?? "unset",
    modelConfig: previous?.modelConfig ?? "unset",
    compilerVersion: COMPILER_VERSION,
    engine,
    error: error.toJSON(),
  });
  return error;
}

/* -------------------------------------------------------------------------- */
/* build                                                                      */
/* -------------------------------------------------------------------------- */

/** One function a build compiles, with the file that declares it. */
interface CompilationUnit {
  file: string;
  contract: FunctionContract;
  parsed: ParsedContract;
}

/**
 * Every function the program declares, as the IR holds it: the signature, the
 * conditions, the effects and the body. The IR is what a review reads and what
 * the compiler lowers, so a function is described here once and everything
 * downstream reads the same description.
 */
function functionContext(phase: { program: ProgramContract; objectNames: Record<string, string> }): FunctionContext {
  const fields = phase as unknown as Record<string, unknown>;
  const program = fields["program"] as ProgramContract;
  const objectNames = fields["objectNames"] as Record<string, string>;
  const functions: Record<string, FunctionContract> = {};
  for (const file of program.files) {
    const declared = (file as unknown as Record<string, unknown>)["functions"] as Record<string, FunctionContract>;
    for (const contract of Object.values(declared)) {
      const fn = (contract as unknown as Record<string, unknown>)["function"] as Record<string, unknown>;
      functions[String(fn["symbol"])] = contract;
    }
  }
  const language = (program as unknown as Record<string, unknown>)["language"] as string;
  return { objectNames, functions, language };
}

/**
 * The program's own statements, resolved and with the arithmetic of a loop over
 * whole numbers computed in whole numbers.
 *
 * The pass is asked of the program's statements and of the functions it is
 * handed, because what a buffer holds is what every write into it and every
 * call site of every function leaves in it — a question the program's
 * statements alone cannot answer, and one the resolved functions answer
 * together.
 */
function resolvedDriver(
  body: ProgramBody,
  program: ProgramContract,
  objectNames: Record<string, string>,
  objectLayouts: Record<string, ObjectLayout>,
  objectKeys: LiteralKeys,
): SemanticProgram {
  const driver = resolveProgram(body, program, objectNames, objectLayouts, objectKeys);
  const fields = driver as unknown as Record<string, unknown>;
  const files = (program as unknown as Record<string, unknown>)["files"] as FileContract[];
  wholeElementArithmetic(
    fields["bodies"] as SemanticFunction[],
    fields["entry"] as SemanticBlock | null,
    vectorChecked(contractsByName(files)),
  );
  return driver;
}

function semanticFunctions(
  program: ProgramContract,
  objectNames: Record<string, string>,
  body: ProgramBody | undefined,
  objectLayouts: Record<string, ObjectLayout>,
  objectKeys: LiteralKeys,
): Record<string, SemanticFunction> {
  const functions: Record<string, FunctionContract> = {};
  for (const file of program.files) {
    const declared = (file as unknown as Record<string, unknown>)["functions"] as Record<string, FunctionContract>;
    for (const contract of Object.values(declared)) {
      const fn = (contract as unknown as Record<string, unknown>)["function"] as Record<string, unknown>;
      functions[String(fn["symbol"])] = contract;
    }
  }
  const language = (program as unknown as Record<string, unknown>)["language"] as string;
  const context: FunctionContext = { objectNames, functions, language };
  const resolved: Record<string, SemanticFunction> = {};
  for (const file of program.files) {
    const declared = (file as unknown as Record<string, unknown>)["functions"] as Record<string, FunctionContract>;
    for (const contract of Object.values(declared)) {
      const fn = (contract as unknown as Record<string, unknown>)["function"] as Record<string, unknown>;
      resolved[String(fn["symbol"])] = resolveFunction(contract, context);
    }
  }
  // What a buffer of a program holds is a question about every write into it and
  // every call site of every function that is handed one, so the arithmetic of a
  // loop over whole numbers is settled here rather than by a per-function pass:
  // it is asked of these bodies, which are the ones every backend is handed.
  if (body !== undefined) {
    const driver = resolveProgram(body, program, objectNames, objectLayouts, objectKeys);
    const fields = driver as unknown as Record<string, unknown>;
    const files = (program as unknown as Record<string, unknown>)["files"] as FileContract[];
    wholeElementArithmetic(
      Object.values(resolved),
      fields["entry"] as SemanticBlock | null,
      vectorChecked(contractsByName(files)),
    );
  }
  // Every body is resolved before any of them is checked, because a function is
  // checked against the others: a loop marked parallel is proved against what
  // the functions it calls write, and that is a question about the program.
  const callees = new Map(Object.entries(resolved));
  for (const file of program.files) {
    const declared = (file as unknown as Record<string, unknown>)["functions"] as Record<string, FunctionContract>;
    for (const contract of Object.values(declared)) {
      // A function is checked before it is shown to anything, so a function
      // that is not one a backend may lower never reaches a model.
      const fn = (contract as unknown as Record<string, unknown>)["function"] as Record<string, unknown>;
      validateSemanticFunction(resolved[String(fn["symbol"])], contract, callees);
    }
  }
  return resolved;
}

/** What generation produced for one function of a build. */
interface UnitGeneration {
  unit: CompilationUnit;
  result: CodegenResult;
}

/** A unit and what it generated, with the fields they are held by. */
function unitGenerationOf(unit: CompilationUnit, result: CodegenResult): UnitGeneration {
  return { unit, result };
}

/**
 * The functions a build compiles. A program compiles every function the program
 * exports, because every one of them is something the program may call; a
 * library entry compiles the one function the project named.
 */
/** One stored function's outcome, with the fields it was given. */
function storedFunctionOf(
  candidateId: string,
  verification: VerificationResult | undefined,
  benchmark: BenchmarkResult | undefined,
): StoredCommandOutcome["functions"][string] {
  const entry: StoredCommandOutcome["functions"][string] = { candidate: candidateId };
  if (verification !== undefined) entry.verification = verification;
  if (benchmark !== undefined) entry.benchmark = benchmark;
  return entry;
}

/** The iterations a stored project's benchmark asks for. */
function benchmarkIterationsOf(input: SourceInput): number {
  const inputFields = input as unknown as Record<string, unknown>;
  const benchmark = inputFields["benchmark"] as Record<string, unknown> | undefined;
  if (benchmark === undefined) return DEFAULT_BENCHMARK.iterations;
  const iterations = benchmark["iterations"] as number | undefined;
  return iterations === undefined ? DEFAULT_BENCHMARK.iterations : iterations;
}

/** The contract a stored unit holds, at the type the evaluator reads it as. */
function storedContractOf(unit: unknown): FunctionContract {
  return unitContract(unit) as unknown as FunctionContract;
}

/** The parsed contract a stored unit holds, at the type the evaluator reads. */
function storedParsedOf(unit: unknown): ParsedContract {
  return (unit as unknown as Record<string, unknown>)["parsed"] as ParsedContract;
}

/** The contract a compilation unit holds, as the record its layout stores. */
function unitContract(unit: unknown): Record<string, unknown> {
  return (unit as unknown as Record<string, unknown>)["contract"] as Record<string, unknown>;
}

/** The function a contract describes, read by key. */
function contractFunction(contract: Record<string, unknown>): Record<string, unknown> {
  return contract["function"] as Record<string, unknown>;
}

/** The key a function's artifacts are held under: its symbol, which is unique. */
function unitKey(unit: unknown): string {
  return String(contractFunction(unitContract(unit))["symbol"]);
}

/**
 * The key a function's records are held under: the name the source gave it,
 * and the file beside it when two files gave a function the same name. A record
 * a reader opens names the function the source named; the symbols behind it are
 * the link's, not the source's.
 */
function unitNameKey(unit: unknown, units: readonly CompilationUnit[]): string {
  const name = String(contractFunction(unitContract(unit))["name"]);
  let count = 0;
  for (const other of units) {
    if (String(contractFunction(unitContract(other))["name"]) === name) count += 1;
  }
  const file = (unit as unknown as Record<string, unknown>)["file"] as string;
  return count > 1 ? `${file}:${name}` : name;
}

function compilationUnits(program: ProgramContract, isProgram: boolean): CompilationUnit[] {
  const units: CompilationUnit[] = [];
  for (const file of program.files) {
    const fields = file as unknown as Record<string, unknown>;
    const declared = fields["functions"] as Record<string, FunctionContract>;
    const filePath = fields["path"] as string;
    const entry = (program as unknown as Record<string, unknown>)["entry"] as Record<string, unknown>;
    for (const [name, contract] of Object.entries(declared)) {
      if (!isProgram && !(String(entry["file"]) === String(filePath) && String(entry["function"]) === name)) continue;
      units.push({ file: String(filePath), contract, parsed: parseContract(contract) });
    }
  }
  return units;
}

/**
 * The IR of every function of a program, as the module of the program holds it.
 *
 * A program is one module: every function of it is in the module, and a call of
 * another function of the program is a call of the index that function has in
 * it. What the module holds is the implementation that was chosen for each
 * function — the candidate the build proved — and the functions the program
 * declares for itself, which the build compiles no candidate of.
 */
async function programFunctions(
  base: string,
  units: readonly UnitGeneration[],
  program: ProgramContract,
  driver: SemanticProgram,
): Promise<ModuleFunction[]> {
  const functions: ModuleFunction[] = [];
  const known = new Set<string>();
  for (const entry of units) {
    const fields = entry as unknown as Record<string, unknown>;
    const result = fields["result"] as Record<string, unknown>;
    const selected = result["selected"];
    if (selected === null || selected === undefined) continue;
    const unit = fields["unit"] as CompilationUnit;
    const name = unitKey(unit);
    const text = await readFile(join(join(base, name), `${String(selected)}.ir`), "utf8");
    const fn = parseSemanticFunction(text, program);
    const contract = (unit as unknown as Record<string, unknown>)["contract"] as FunctionContract;
    functions.push({ fn, contract });
    known.add(String((fn as unknown as Record<string, unknown>)["symbol"]));
  }
  const bodies = (driver as unknown as Record<string, unknown>)["bodies"] as SemanticFunction[];
  for (const body of bodies) {
    const symbol = String((body as unknown as Record<string, unknown>)["symbol"]);
    if (known.has(symbol)) continue;
    functions.push({ fn: body });
    known.add(symbol);
  }
  return functions;
}

/**
 * The machine backend's answer about a program: whether it can lower every
 * function of it, and what it said about the one it cannot.
 *
 * The question is asked of the whole program because the lowering of a program
 * is one thing: the objects of its functions are linked into one binary and the
 * driver that calls them is written in C, so a program with a machine object
 * beside a C one is a program with two conventions in it. A function the
 * machine backend refuses is therefore a reason for the whole program to be
 * lowered by the C backend.
 *
 * The IR asked about is the IR a candidate starts from: the function the
 * compiler resolved, folded the way a candidate is folded. A model may write
 * another candidate of it, and a candidate the machine backend refuses is a
 * candidate the build rejects as any other.
 */
function machineRefusalOf(
  units: readonly CompilationUnit[],
  semantics: Readonly<Record<string, SemanticFunction>>,
  contracts: ContractsByName,
  target: TargetSpec,
): { function: string; reason: string; detail: string | undefined } | null {  const callees = new Map(Object.entries(semantics));
  for (const unit of units) {
    const contract = unitContract(unit) as unknown as FunctionContract;
    const fnInfo = contractFunction(unitContract(unit));
    const name = String(fnInfo["name"]);
    const fn = semantics[String(fnInfo["symbol"])];
    if (fn === undefined) continue;
    const refusal = machineRefusal({
      fn: optimizeSemanticFunction(structuredClone(fn), callees),
      contract,
      callable: callableSymbols(contract, contracts),
      target,
    });
    if (refusal !== null) {
      const fields = refusal as unknown as Record<string, unknown>;
      return { function: name, reason: String(fields["reason"]), detail: fields["detail"] as string | undefined };
    }
  }
  return null;
}

/**
 * What the machine backend lowers a program's declared functions into, and
 * what the driver keeps.
 *
 * A program declares its functions in the body it runs: every one of them is a
 * body of the program, and the machine backend lowers a body into an object
 * the driver links beside itself. A body the backend refuses keeps the
 * definition the driver writes — but only where the boundary lets it: a call
 * between a machine object and a function the driver writes down has to hand
 * every argument over as both conventions carry it, and one that hands a
 * reference or a text over does not. The caller of such a boundary is lowered
 * the same way the callee was, and the answer is read again until it stops
 * moving: a body pushed back into C may push the one that calls it back with
 * it.
 */
interface ProgramLowering {
  /** The symbols lowered into machine objects. */
  lowered: ReadonlySet<string>;
  /**
   * The symbols of the bodies the driver writes down, which a machine object
   * calls. The driver writes them as functions the linker can see, because an
   * object's reference to one has to resolve to the definition the driver
   * carries.
   */
  visible: ReadonlySet<string>;
  /** Why each body that stayed was left, which is what the build log says. */
  notes: readonly string[];
  /** The symbols an object of this program may name a call of. */
  callable: ReadonlySet<string>;
}

/**
 * Whether a value of the type a call hands over can cross between the two
 * backends.
 *
 * The machine backend carries a number in a register where the C backend
 * carries it in a number, and an array as the pointer both already carry, so
 * those cross whole. A reference is the address itself in one and the double
 * the address converts to in the other, and a text is a block of the runtime's
 * own in one and a C string in the other: neither is the same value on the two
 * sides of the boundary, so neither crosses.
 */
function crossesBackends(type: SemanticType): boolean {
  const kind = String((type as unknown as Record<string, unknown>)["kind"]);
  return (
    kind === "primitive" ||
    kind === "ptr" ||
    kind === "slice" ||
    kind === "array" ||
    kind === "void"
  );
}

/**
 * The machine lowering of a program's declared functions.
 *
 * The IR asked about is the IR the program was resolved into, which is the one
 * the objects are written from — there is no candidate of a body the program
 * declares, so there is nothing to fold here that a later lowering would not
 * see.
 */
export function programLoweringOf(
  driver: SemanticProgram,
  covered: ReadonlySet<string>,
  target: TargetSpec,
): ProgramLowering {
  const fields = driver as unknown as Record<string, unknown>;
  const bodies = fields["bodies"] as SemanticFunction[];
  const signatures = fields["functions"] as SemanticFunction[];
  const callable = new Set<string>([
    ...bodies.map((body) => String((body as unknown as Record<string, unknown>)["symbol"])),
    ...signatures.map((signature) => String((signature as unknown as Record<string, unknown>)["symbol"])),
  ]);
  // A body a contracted function covers is compiled as that function's own
  // object, so the backend was asked about it already.
  const lowered = new Set<string>(
    bodies
      .filter((body) => !covered.has(String((body as unknown as Record<string, unknown>)["name"])))
      .map((body) => String((body as unknown as Record<string, unknown>)["symbol"])),
  );
  const notes: string[] = [];
  for (const body of bodies) {
    const symbol = String((body as unknown as Record<string, unknown>)["symbol"]);
    if (!lowered.has(symbol)) continue;
    const refusal = machineRefusal({ fn: body, callable, target });
    if (refusal !== null) {
      const refusalFields = refusal as unknown as Record<string, unknown>;
      const reason = String(refusalFields["reason"]);
      const detail = refusalFields["detail"] as string | undefined;
      lowered.delete(symbol);
      notes.push(
        `the machine backend refused to lower ${String((body as unknown as Record<string, unknown>)["name"])} (${reason}); the driver keeps its C`,
      );
      if (detail !== undefined && detail.trim() !== "") notes.push(detail.trim());
    }
  }
  // A call between one side and the other is the boundary, and it decides both
  // sides together: every body that calls across an incompatible edge is
  // lowered by the same backend as the callee is.
  let moved = true;
  while (moved) {
    moved = false;
    for (const edge of callsWithin(driver)) {
      const edgeFields = edge as unknown as Record<string, unknown>;
      const caller = String(edgeFields["caller"]);
      const callee = String(edgeFields["callee"]);
      if (lowered.has(caller) === lowered.has(callee)) continue;
      const found = bodies.find((body) => String((body as unknown as Record<string, unknown>)["symbol"]) === callee);
      if (found === undefined) continue;
      const foundFields = found as unknown as Record<string, unknown>;
      const returns = foundFields["returns"] as SemanticType;
      const params = foundFields["params"] as SemanticSlot[];
      const incompatible = !crossesBackends(returns) || params.some((param) => !crossesBackends(slotType(param)));
      if (!incompatible) continue;
      const dropped = lowered.has(caller) ? caller : callee;
      if (lowered.delete(dropped)) {
        moved = true;
        const partner = dropped === caller ? callee : caller;
        notes.push(
          `the machine backend left ${dropped} in the driver: a call it shares with ${partner} hands over what only one convention carries`,
        );
      }
    }
  }
  // A body the driver writes down that an object calls is written as a
  // function the linker can see, so the object's reference resolves to it.
  // This includes bodies referenced by contracted (unit) functions, which are
  // compiled as objects of their own and may hand the driver a callback.
  const visible = new Set<string>(
    callsWithin(driver)
      .filter((edge) => {
        const edgeFields = edge as unknown as Record<string, unknown>;
        return lowered.has(String(edgeFields["caller"])) && !lowered.has(String(edgeFields["callee"]));
      })
      .map((edge) => String((edge as unknown as Record<string, unknown>)["callee"])),
  );
  return { lowered, visible, notes, callable };
}

/**
 * Every call one function of a program makes of another, with the name of the
 * function that makes it: the edges of a boundary the two backends share.
 */
function callsWithin(program: SemanticProgram): { caller: string; callee: string }[] {
  const edges: { caller: string; callee: string }[] = [];
  const fields = program as unknown as Record<string, unknown>;
  const bodies = fields["bodies"] as SemanticFunction[];
  for (const body of bodies) {
    const bodyFields = body as unknown as Record<string, unknown>;
    const entry = bodyFields["entry"] as SemanticBlock;
    const symbol = String(bodyFields["symbol"]);
    for (const callee of directCalleesOf(entry)) edges.push({ caller: symbol, callee });
  }
  const entry = fields["entry"] as SemanticBlock;
  for (const callee of directCalleesOf(entry)) edges.push({ caller: "", callee });
  return edges;
}

/** Every function name a body or the program's own statements call directly. */
function directCalleesOf(block: SemanticBlock): string[] {
  const names: string[] = [];
  const blocks: SemanticBlock[] = [block];
  while (blocks.length > 0) {
    const visited = blocks.pop() as SemanticBlock;
    const visitedFields = visited as unknown as Record<string, unknown>;
    for (const statement of visitedFields["statements"] as Record<string, unknown>[]) {
      for (const value of statementValues(statement as unknown as SemanticStatement)) {
        walkValues(value, (inner) => {
          const fields = inner as unknown as Record<string, unknown>;
          const kind = String(fields["k"]);
          if (kind === "call") {
            const call = fields["call"] as Record<string, unknown>;
            names.push(String(call["callee"]));
          }
          if (kind === "functionRef") names.push(String(fields["name"]));
        });
      }
      if (String(statement["k"]) === "call") {
        const call = statement["call"] as Record<string, unknown>;
        names.push(String(call["callee"]));
      }
      for (const inner of statementBlocksOf(statement as unknown as SemanticStatement)) blocks.push(inner);
    }
    const terminator = visitedFields["terminator"] as Record<string, unknown>;
    if (String(terminator["k"]) === "return" && terminator["value"] !== null) {
      walkValues(terminator["value"] as SemanticValue, (inner) => {
        const fields = inner as unknown as Record<string, unknown>;
        const kind = String(fields["k"]);
        if (kind === "call") {
          const call = fields["call"] as Record<string, unknown>;
          names.push(String(call["callee"]));
        }
        if (kind === "functionRef") names.push(String(fields["name"]));
      });
    }
  }
  return [...new Set(names)];
}

/**
 * What a program cannot be, when it is built as WebAssembly.
 *
 * A program is one module: every function of it and the body it runs, with the
 * entry of the module as the driver the C backend writes in C. What a module
 * cannot reach is what the host ABI does not carry, and a server to answer
 * requests on is the one thing a program may want that a module cannot have.
 */
function assertProgramOutput(output: OutputKind, source: string): void {
  if (output !== "wasm") return;
  if (!/\bhttp\b/.test(source)) return;
  throw new CompilerError("InputError", "input", "a WebAssembly module cannot serve HTTP requests", "the host ABI of a wasm module carries the runtime services the module imports, and a server is not one " +
      "of them; build the program with another output kind", "", "", "");
}

/** What a build may reuse of one function: how much, and what is missing. */
interface UnitReuse {
  level: ReuseLevel | null;
  entry: IncrementalEntry | undefined;
  /** The stored files the build would have to deliver but cannot find. */
  missing: string[];
}

interface UnitReuseRequest {
  entry: IncrementalEntry | undefined;
  keys: UnitKeys;
  workspace: CodegenWorkspace;
  functionName: string;
  output: OutputKind;
  lowering: BackendKind;
  linksObjects: boolean;
  /** The contract graph a stored candidate is read against. */
  program: ProgramContract;
  /** The functions of this build a stored candidate may call. */
  callable: ReadonlySet<string>;
  /** `--reuse` asks a model for nothing, so what it cannot reuse is an error. */
  required: boolean;
  id: string;
}

/**
 * Whether a stored implementation calls out of the program it belongs to.
 *
 * Every output kind answers in the IR, so this reads the same text the build
 * that stored it decided on. A record whose text cannot be read is one nothing
 * can say the calls of, and it is answered as one that *does* call out: `false`
 * is the answer that asks for no executable, and a candidate whose files are not
 * known is exactly the one whose executable has not been checked. Answering it
 * that way fails the demand for the executable, which fails this unit's reuse
 * and builds it again — the refusal stays inside the unit, which is what the
 * lenient reading was reaching for.
 */
function callsOutOfProgram(
  text: string,
  program: ProgramContract,
  callable: ReadonlySet<string>,
): boolean {
  try {
    const fn = parseSemanticFunction(text, program);
    const calls = (fn as unknown as Record<string, unknown>)["calls"] as { callee: string }[];
    return calls.some((edge) => callable.has(String((edge as unknown as Record<string, unknown>)["callee"])));
  } catch {
    return true;
  }
}

/**
 * How much of what an earlier build stored for a function this build may
 * reuse. That flag is the whole difference between the two: without it a
 * function that cannot be reused is built again, with it the build fails
 * rather than ask a model for anything.
 */
function unitReuse(request: UnitReuseRequest): UnitReuse {
  const requestFields = request as unknown as Record<string, unknown>;
  const entry = requestFields["entry"] as Record<string, unknown> | undefined;
  const keys = requestFields["keys"] as Record<string, unknown>;
  const required = requestFields["required"] as boolean;
  const functionName = String(requestFields["functionName"]);
  const id = String(requestFields["id"]);
  if (entry === undefined || String(entry["reviewKey"]) !== String(keys["review"])) {
    if (!required) return { level: null, entry: undefined, missing: [] };
    throw new CompilerError("StorageError", "reuse", entry === undefined
          ? `no stored implementation to reuse for ${functionName}`
          : `the stored implementation of ${functionName} was reviewed from different inputs`, entry === undefined
          ? `nothing is stored for ${id}; run blaze build without --reuse to build it`
          : "its contract, the functions it is linked against, the target, the options, the model or the compiler's own review of a function changed; run blaze build without --reuse to build it again", "", "", "");
  }
  // The stored candidate's own IR decides which files it produced: one that
  // calls a function of the program is never linked on its own, so its
  // executable is a file no build ever writes and demanding it would make
  // every such function a cache miss for the life of the project. An entry a
  // build cannot read is treated as one that links on its own, so a corrupt
  // record costs the files that are genuinely there and is rebuilt otherwise.
  const selected = String(entry["selected"]);
  const candidates = entry["candidates"] as Record<string, unknown>[];
  const stored = candidates.find((candidate) => String(candidate["id"]) === selected);
  const callable = requestFields["callable"] as ReadonlySet<string>;
  const missing = reusableFiles(
    requestFields["workspace"] as CodegenWorkspace,
    selected,
    requestFields["output"] as OutputKind,
    requestFields["lowering"] as BackendKind,
    requestFields["linksObjects"] as boolean,
    stored === undefined || !callsOutOfProgram(String(stored["text"]), requestFields["program"] as ProgramContract, callable),
  ).filter((file) => !existsSync(file));
  return {
    level: reusable(entry as unknown as IncrementalEntry | undefined, keys as unknown as UnitKeys, missing.length === 0),
    entry: entry as unknown as IncrementalEntry | undefined,
    missing,
  };
}


/**
 * The program as its own toolchain runs it: the entry module beside the project
 * file, or the inline source written out so it can be run at all.
 */
async function programSource(
  base: string,
  id: string,
  project: ProjectInput,
  body: ProgramBody,
  language: string,
): Promise<{ path: string }> {
  const bodyFields = body as unknown as Record<string, unknown>;
  const projectFields = project as unknown as Record<string, unknown>;
  const file = String(bodyFields["file"]);
  if (file !== INLINE_MODULE) {
    return { path: resolveFrom(String(projectFields["directory"]), file) };
  }
  // The source is written under the name its own toolchain runs it by: a
  // Python source is run by python3, which reads a file of any name, and the
  // name is what says what the source is.
  const extension = language.toLowerCase() === "python" ? "py" : "ts";
  const path = `${base}/${id}.program.${extension}`;
  const entry = projectFields["entry"] as Record<string, unknown>;
  await writeFile(path, String(entry["source"]), "utf8");
  return { path };
}

/**
 * What a round of the program loop found, in the words the build log uses: the
 * line the two outputs part on, or how the program stopped before they could.
 */
function describeProgramFailure(mismatch: ProgramMismatch | undefined): string {
  const fields = mismatch as unknown as Record<string, unknown> | undefined;
  const failure = fields === undefined ? undefined : fields["failure"];
  if (fields !== undefined && failure !== undefined) {
    const actual = String(fields["actualOutput"]);
    const printed =
      actual === "" ? "printed nothing" : `printed ${actual.split("\n").length} line(s) and then stopped`;
    return `${String(failure)}: it ${printed}, where the source prints ${JSON.stringify(fields["expected"])} on line ${String(fields["line"])}`;
  }
  const line = fields === undefined ? "" : String(fields["line"]);
  const expected = fields === undefined ? undefined : fields["expected"];
  const actual = fields === undefined ? undefined : fields["actual"];
  return `the program does not print what the source prints: line ${line}, the source prints ${JSON.stringify(expected)}, the program prints ${JSON.stringify(actual)}`;
}

/** The machine fallback a build records, with the fields it holds. */
function backendFallbackOf(fn: string, reason: string): { function: string; reason: string } {
  return { function: fn, reason };
}

/** The machine object a build writes, called with the values it holds. */
function buildMachineObjectFor(
  fn: SemanticFunction,
  target: TargetSpec,
  callable: ReadonlySet<string>,
  objectPath: string,
): Promise<MachineResult> {
  return buildMachineObject({ fn, target, callable, objectPath });
}

/** The runner of a program module, built from the values the build holds. */
async function buildProgramModuleRunner(
  functions: ModuleFunction[],
  entry: SemanticBlock,
  modulePath: string,
  hostPath: string,
  language: string,
): Promise<Runner> {
  const result = await buildProgramModule({ functions, entry, modulePath, hostPath, language });
  return (result as unknown as Record<string, unknown>)["runner"] as Runner;
}

/** The generation record a build writes, with the values it holds. */
function generationRecordOf(
  selected: Record<string, string>,
  outcomes: Record<string, CandidateOutcome[]>,
  modelDurationNs: string,
): Record<string, unknown> {
  return { selected, outcomes, modelDurationNs };
}

/** The outcome a build answers, with the values it holds. */
function buildOutcomeOf(
  project: string,
  build: BuildStatus,
  contracts: Record<string, FunctionContract>,
  program: ProgramContract,
  body: ProgramBody | undefined,
  candidates: Record<string, Candidate[]>,
  verification: Record<string, VerificationResult[]>,
  benchmark: Record<string, BenchmarkResult[]>,
  generation: Record<string, unknown>,
  outputKind: OutputKind,
  outputPath: string | null,
  outputAssemblyPath: string | null,
): BuildOutcome {
  return {
    project,
    build,
    contracts,
    program,
    ...(body === undefined ? {} : { body }),
    candidates,
    verification,
    benchmark,
    generation,
    outputKind,
    outputPath,
    outputAssemblyPath,
  };
}

/** Copies a delivered file beside its target and renames it over. */
async function copyDelivered(from: string, to: string): Promise<void> {
  const beside = `${to}.delivered`;
  await copyFile(from, beside);
  await rename(beside, to);
}

/** Delivers one file into the store and records it. */
async function deliverStored(
  store: JsonStore,
  base: string,
  delivered: string[],
  from: string,
  to: string,
): Promise<void> {
  const target = storeResolve(store, to);
  await copyDelivered(join(base, from), target);
  delivered.push(target);
}

/** A runner value at the type the caller holds it as. */
function runnerOf(value: Runner): Runner {
  return value;
}

/** The driver of a program, built from the values the build holds. */
async function buildProgramDriverFor(
  objective: Objective,
  mode: BuildMode,
  target: TargetSpec,
  program: SemanticProgram,
  workDirectory: string,
  objectPaths: string[],
  loweredBodies: string[],
  sharedBodies: string[],
  runtimeObjectPath: string | undefined,
  includeHttpHeader: boolean,
  lowering: BackendKind,
  includeSqliteHeader: boolean,
  tls: boolean,
  libraryObjectPaths: string[],
  threads: Threading[],
  outputPath: string,
): Promise<Runner> {
  return await buildProgramDriver({
    objective,
    mode,
    target,
    program,
    workDirectory,
    objectPaths,
    loweredBodies,
    sharedBodies,
    runtimeObjectPath,
    includeHttpHeader,
    lowering,
    includeSqliteHeader,
    tls,
    libraryObjectPaths,
    threads,
    outputPath,
  });
}

/** The Nim host of a program, built from the values the build holds. */
async function buildProgramHostFor(
  mode: BuildMode,
  program: SemanticProgram,
  workDirectory: string,
  objectPaths: string[],
  outputPath: string,
): Promise<Runner> {
  return await buildProgramHost({ mode, program, workDirectory, objectPaths, outputPath });
}



/** An incremental entry, with the values the build proved for it. */
function incrementalEntryOf(
  reviewKey: string,
  objectKey: string,
  file: string,
  selected: string,
  candidates: Candidate[],
  outcomes: CandidateOutcome[],
  benchmarkVector: TestVector | null,
): IncrementalEntry {
  return { reviewKey, objectKey, file, selected, candidates, outcomes, benchmarkVector };
}

/** The answer a retry notice describes, at the type the printer reads. */
function answerDumpOf(
  stage: AnswerDump["stage"],
  candidate: number,
  attempt: number,
  retry: number,
  answer: string,
): AnswerDump {
  return { stage, candidate, attempt, retry, answer };
}

/** The verification of a program, called with the values the build holds. */
function verifyProgramFor(
  language: string,
  sourcePath: string,
  directory: string,
  runner: Runner,
  args: string[],
): Promise<ProgramVerification> {
  return verifyProgram({ language, sourcePath, directory, runner, arguments: args });
}

/** The contract phase a request object names, called with values it already holds. */
function contractPhaseFor(
  frontend: Frontend,
  input: SourceInput,
  entry: SourceModule,
  read: (path: string) => string | null,
  host: Readonly<Record<string, string>> | undefined,
): ContractPhase {
  return runContractPhase({
    frontend,
    input,
    entry,
    read,
    ...(host === undefined ? {} : { host }),
  });
}

export async function runBuild(
  inputPath: string,
  options: BuildOptions,
  reporter: Reporter,
  mode: "build" | "generate",
): Promise<BuildOutcome> {
  const fields = options as unknown as Record<string, unknown>;
  const store = createJsonStore(join(String(fields["cwd"]), STATE_DIRECTORY));
  const absoluteInput = resolveFrom(String(fields["cwd"]), inputPath);
  const id = projectIdFor(absoluteInput);
  const paths = projectPaths(id, projectStoreId(absoluteInput));
  const pathFields = paths as unknown as Record<string, unknown>;
  const workPath = String(pathFields["work"]);
  const buildRecordPath = String(pathFields["build"]);
  const inputStorePath = String(pathFields["input"]);
  const candidatesPath = String(pathFields["candidates"]);
  const verificationPath = String(pathFields["verification"]);
  const benchmarkPath = String(pathFields["benchmark"]);
  const generationPath = String(pathFields["generation"]);

  // These read the project and reject it before there is a build record to
  // reject it in, so a project that no longer names a build that can run used
  // to fail with the last successful build still on record: every reader of
  // the project was told the last thing it did succeeded.
  // A record that is not JSON is no record at all, exactly as the incremental
  // cache is not: a build that cannot parse what the last one said goes on to
  // build, and a project that failed on a corrupt record had no way back short
  // of deleting the file by hand. A record that cannot be read is a different
  // thing, and is a fault: going on to build would overwrite it.
  const previousBuild = await storeReadIfValid<BuildStatus>(store, buildRecordPath);
  let project: ProjectInput;
  let target: TargetSpec;
  let targetForRecord: TargetSpec | undefined;
  let toolchainId: string | undefined;
  let outputKind: OutputKind;
  let runtimeKind: RuntimeKind;
  let backendKind: BackendKind;
  let buildMode: BuildMode;
  let libraries: LibraryKind[] = [];
  let usesSqlite = false;
  let inputFields: Record<string, unknown> = {};
  let projectFields: Record<string, unknown> = {};
  try {
    project = readInput(absoluteInput);
    projectFields = project as unknown as Record<string, unknown>;
    inputFields = projectFields["input"] as Record<string, unknown>;
    const input = sourceInputOf(projectFields["input"]);
    assertGenerationInput(absoluteInput, input);
    target = assertBuildableTarget(normalizeTarget(inputFields["target"] as Partial<TargetSpec> | undefined), inputFields["entry"] as string | undefined);
    targetForRecord = target;
    toolchainId = String((toolchainForTarget(target) as unknown as Record<string, unknown>)["id"]);
    outputKind = resolveOutputKind((fields["output"] as OutputKind | undefined) ?? (inputFields["output"] as OutputKind | undefined));
    runtimeKind = resolveRuntimeKind((fields["runtime"] as RuntimeKind | undefined) ?? (inputFields["runtime"] as RuntimeKind | undefined), outputKind);
    assertRuntimeSupported(target, runtimeKind);
    // HTTP programs need the facil runtime even when the user did not ask for
    // it: the generated code references blaze_http_* symbols.
    if (runtimeKind === "none" && mentionsHttpModule(String((projectFields["entry"] as Record<string, unknown>)["source"]))) runtimeKind = "facil";
    // A program that uses SQLite links the SQLite library beside the runtime
    // it runs on. A wasm module links no library at all, and a program hosted
    // by Nim is lowered by the host's own emitter, which knows no library, so
    // both are refused here rather than failing later at the link.
    usesSqlite = usesSqliteSource(String((projectFields["entry"] as Record<string, unknown>)["source"]));
    libraries = libraryKindsFor(String((projectFields["entry"] as Record<string, unknown>)["source"]), target);
    if (usesSqlite && outputKind === "wasm") {
      throw new CompilerError("InputError", "input", "a WebAssembly module cannot use SQLite", "a wasm module links no library; build it with --output machine, or drop the SQLite calls", "", "", "");
    }
    if (usesSqlite && runtimeKind === "nim") {
      throw new CompilerError("InputError", "input", "a program hosted by Nim cannot use SQLite", "the Nim host links the runtime and no library; build it with --runtime none, or drop the SQLite calls", "", "", "");
    }
    backendKind = resolveBackend((fields["backend"] as BackendKind | undefined) ?? (inputFields["backend"] as BackendKind | undefined), outputKind);
    buildMode = resolveBuildMode((fields["mode"] as BuildMode | undefined) ?? (inputFields["mode"] as BuildMode | undefined));
  } catch (cause) {
    throw await recordRejected(store, paths, id, previousBuild, targetForRecord, cause);
  }

  // The mode is the first thing a build says, before it names the model or
  // resolves anything: it is the one setting that changes what the generated
  // program carries, and it is chosen here, so a reader is told what was
  // selected before anything built can be looked at.
  reporter("mode", "info", `Mode: ${buildMode} (${optimizationOptions(buildMode, undefined).join(" ")})`);
  const input = inputFields as unknown as SourceInput;
  // A source comparison runs the delivered program on this host. A program
  // built for another host cannot be run here, so the build records that it
  // made no comparison rather than trying to run the wrong machine's code.
  const programVerification = programVerificationFor(target, inputFields["verifyProgram"] as boolean | undefined, fields["verify"] as VerificationMode | undefined);

  // --model wins over the project file, which wins over AI_MODEL.
  const requested = (fields["model"] as string | undefined) ?? modelSpec(inputFields["model"] as SourceInput["model"], absoluteInput);
  // Whether a model is configured at all, the same reading resolveModel
  // makes. A build with none still runs: it lowers the IR the rules resolved
  // and verified, and reviews nothing.
  const environment = hostEnvironment();
  const modelRequested = (requested ?? environment.AI_MODEL ?? "") !== "";
  // A generate exists to show what a model made of the IR, so with none
  // configured there is nothing to show: it refuses rather than handing back
  // the IR as it stands under a generate's name.
  if (String(mode) === "generate" && !modelRequested) {
    throw await recordRejected(
      store,
      paths,
      id,
      previousBuild,
      targetForRecord,
      new CompilerError("InputError", "input", "generate asks a model", "set AI_MODEL or pass --model provider/model; blaze build runs the rules alone without one", "", "", ""),
    );
  }
  // A reused build is answered by the model that reviewed the stored candidate,
  // so that is the model to name.
  const previousFields = previousBuild as unknown as Record<string, unknown> | undefined;
  const previousModel = previousFields === undefined ? undefined : previousFields["model"] as string | undefined;
  const modelName = (fields["reuse"] as boolean) ? previousModel : (requested ?? environment.AI_MODEL);
  // The model is part of every answer this compiler gives, so it is named
  // before anything can fail, including a model that cannot be reached.
  reporter("model", "info", `Model: ${modelName ?? "(unset)"}`);

  // The engine is read before anything is written, because a build that is
  // going to stop must stop without having touched the record of the last one.
  const toolchain = await toolchainFingerprints();
  const toolchainFields = toolchain as unknown as Record<string, unknown>;
  const engine = engineStamp(toolchain);
  // A record written by a different engine is a proof about a compiler that
  // no longer exists, and every function in it has to be asked for again, so
  // it is the one change that costs a build its whole cache. It is announced
  // and, on a terminal, confirmed: the question is what a person can answer
  // and a script cannot, and a build that has no way to ask answers for
  // itself. `--recompile` is the same answer given in advance.
  const previousEngine = previousFields === undefined ? undefined : previousFields["engine"] as string | undefined;
  const engineChanged = previousEngine !== undefined && String(previousEngine) !== engine;
  if (engineChanged && (fields["reuse"] as boolean) !== true) {
    reporter(
      "engine",
      "info",
      `Engine changed: ${previousEngine} -> ${engine} (last build ${agoFrom(previousFields === undefined ? undefined : previousFields["updatedAt"] as string | undefined)})`,
    );
    reporter(
      "engine",
      "info",
      "The stored objects were built by different rules, so every function is reviewed again from the semantic IR",
    );
    if ((fields["recompile"] as boolean | undefined) !== true && fields["confirm"] !== undefined) {
      const recompile = await (fields["confirm"] as (question: string) => Promise<boolean>)("Recompile every function from scratch? [y/N] ");
      if (!recompile) {
        throw new CompilerError("CancelledError", "engine", `the engine changed (${previousEngine} -> ${engine}) and the recompile was declined`, "nothing was built and the last build is still the project's; run blaze build --recompile to rebuild it", "", "", "");
      }
    }
  }
  // What an earlier build stored is what this build does not look at when the
  // engine moved under it, and what it does not look at when it was told to
  // recompile. The two are the same decision: the announcement above promised
  // a rebuild, so the stored candidates go with it even where the keys alone
  // would have let them through. A `--reuse` build discards nothing — it asks
  // no model for anything, so there is nothing to rebuild, and it reports the
  // mismatch against what it was promised instead.
  const discardStored = (fields["recompile"] as boolean | undefined) === true || (engineChanged && (fields["reuse"] as boolean) !== true);

  await storeMkdirp(store, paths.root);
  await storeMkdirp(store, workPath);
  if ((fields["recompile"] as boolean | undefined) === true) {
    try { await storeRemove(store, join(workPath, "program.c")); } catch {}
  }
  await storeMkdirp(store, paths.output);
  // The project is stored as the record the rest of the compiler reads, which
  // is JSON whatever the project file is, so `blaze test` and `blaze benchmark`
  // re-run a build against the project it was given.
  await storeWrite(store, inputStorePath, input);

  const createdAt = new Date().toISOString();
  const build: BuildStatus = {
    id,
    input: inputPath,
    contract: paths.contract,
    target,
    status: "building",
    outputKind,
    backend: backendKind,
    mode: buildMode,
    ...(toolchainId === undefined ? {} : { toolchain: toolchainId }),
    runtime: runtimeKind,
    createdAt,
    updatedAt: createdAt,
    sourceHash: "",
    contractHash: "",
    model: modelName ?? "unset",
    modelConfig: modelName ?? (previousFields === undefined ? undefined : previousFields["modelConfig"] as string | undefined) ?? "unset",
    compilerVersion: COMPILER_VERSION,
    engine,
    // The flag is the record of a build that was told to recompile. An engine
    // change that forced one is already visible as the stamp, which moved.
    ...((fields["recompile"] as boolean | undefined) === true ? { recompiled: true } : {}),
  };
  await writeBuildRecord(store, buildPathOf(paths), build);

  /**
   * The model is resolved on first use rather than up front: a build that
   * reuses every function it needs asks no model anything, so it must not
   * require a model to be configured, or even reachable. Resolving it names it
   * in the build record, which is written again at the end of the build.
   */
  let resolvedModel: ModelConfiguration | undefined;
  const requireModel = (): ModelConfiguration => {
    if (resolvedModel === undefined) {
      resolvedModel = resolveModel(requested);
      const modelFields = resolvedModel as unknown as Record<string, unknown>;
      (build as unknown as Record<string, unknown>)["model"] = String(modelFields["id"]);
      (build as unknown as Record<string, unknown>)["modelConfig"] = String(modelFields["id"]);
    }
    return resolvedModel;
  };


  try {
    // The contract phase comes first and asks no model: every file of the
    // program is read, contracted and validated before any target code exists.
    const phase = contractPhaseFor(
      frontendFor(String(inputFields["language"])),
      input,
      projectFields["entry"] as SourceModule,
      moduleReader(String(projectFields["directory"])),
      inputFields["host"] as Readonly<Record<string, string>> | undefined,
    );
    const phaseFields = phase as unknown as Record<string, unknown>;
    const program = phaseFields["program"] as ProgramContract;
    const body = phaseFields["body"] as ProgramBody | undefined;
    const objectNames = phaseFields["objectNames"] as Record<string, string>;
    const objectLayouts = phaseFields["objectLayouts"] as Record<string, ObjectLayout>;
    const objectKeys = phaseFields["objectKeys"] as LiteralKeys;
    const modules = phaseFields["modules"] as SourceModule[];
    const programFields = program as unknown as Record<string, unknown>;
    const files = programFields["files"] as FileContract[];
    const entry = programFields["entry"] as Record<string, unknown>;
    const units = compilationUnits(program, body !== undefined);
    const semantics = semanticFunctions(program, objectNames, body, objectLayouts, objectKeys);
    // The IR of every function is resolved and checked here, before a model is
    // asked for anything: a function no backend may lower never reaches one.
    reporter(
      "ir",
      "ok",
      `Semantic IR: ${Object.keys(semantics).length} function(s) resolved and validated, ${Object.values(semantics).reduce((total, fn) => total + ((fn as unknown as Record<string, unknown>)["ensures"] as string[]).length, 0)} postcondition(s) to check them against`,
    );
    const sourceHash = hashValue(modules.map((module) => {
      const moduleFields = module as unknown as Record<string, unknown>;
      return [String(moduleFields["path"]), String(moduleFields["source"])];
    }));
    build.sourceHash = sourceHash;
    build.contractHash = hashValue(program);
    await storeWrite(store, paths.contract, program);
    reporter(
      "contract",
      "ok",
      body === undefined
        ? `Program contract: ${program.files.length} file(s), ${contractedFunctionCount(program)} contracted function(s), entry ${String(String(entry["function"]))} in ${String(entry["file"])}`
        : `Program contract: ${program.files.length} file(s), ${units.length} compiled function(s), program ${String(entry["file"])}`,
    );
    // The program's own statements are held to the same deterministic rewrites
    // a function's are: a top-level loop of a program is a loop like any other,
    // and what it computes on every turn is computed once above it. This is
    // settled before the machine backend is asked about the program, because
    // the question is about the IR that was resolved, and the IR that was
    // resolved is what the optimizer wrote.
    // Resolving a program and writing out the source the toolchain runs are
    // the same for every round: only the objects it links change.
    const driver =
      body === undefined
        ? undefined
        : optimizeSemanticProgram(
            resolvedDriver(body as ProgramBody, program, objectNames, objectLayouts, objectKeys),
          );
    // The IR is checked here, before a toolchain is asked for anything: a
    // program no backend may lower never reaches gcc, nim or a linker.
    if (driver !== undefined) {
      const driverFields = driver as unknown as Record<string, unknown>;
      const bodies = driverFields["bodies"] as SemanticFunction[];
      validateSemanticProgram(
        driver,
        undefined,
        new Map(bodies.map((fn) => [String((fn as unknown as Record<string, unknown>)["name"]), fn])),
      );
      reporter("ir", "ok", "Program IR: the program is resolved and validated");
    }
    // The machine backend is asked whether it can lower this program before
    // anything is generated. The lowering of a program is one thing: the
    // objects of its functions are linked into one binary and the driver that
    // calls them is written in C, so a program with a machine object beside a
    // C one is a program with two conventions in it. A program the machine
    // backend refuses is therefore lowered by the C backend, and the build says
    // so rather than leaving a reader to wonder why the objects are not the
    // ones the project asked for.
    let bodyLowering: ProgramLowering | undefined;
    if (backendKind === "machine") {
      const refusal = machineRefusalOf(units, semantics, contractsByName(files), target);
      if (refusal !== null) {
        const refusalFields = refusal as unknown as Record<string, unknown>;
        const reason = String(refusalFields["reason"]);
        const detail = refusalFields["detail"] as string | undefined;
        reporter(
          "assemble",
          "info",
          `The machine backend refused to lower ${String(refusalFields["function"])} (${reason}); the C backend is used instead`,
        );
        if (detail !== undefined && detail.trim() !== "") {
          reporter("assemble", "info", detail.trim());
        }
        backendKind = "c";
        build.backend = "c";
        build.backendFallback = backendFallbackOf(String(refusalFields["function"]), reason);
      } else if (driver !== undefined) {
        // Every function the program declares for itself is lowered the same
        // way the functions a candidate implements are: into an object the
        // driver links beside itself. What the backend refused stays in the
        // driver, and so does everything whose call to it would hand over
        // what only one convention carries.
        bodyLowering = programLoweringOf(driver, new Set(units.map(unitKey)), target);
        for (const note of (bodyLowering as unknown as Record<string, unknown>)["notes"] as string[]) reporter("assemble", "info", note);
      }
    }
    await writeBuildRecord(store, buildPathOf(paths), build);

    assertAssemblerSupportsArch(target);
    if (body !== undefined) assertProgramOutput(outputKind, String((projectFields["entry"] as Record<string, unknown>)["source"]));

    // What an earlier build proved per function. It is read before this build
    // writes to it, and it is written as each function is proved, so a build
    // that fails on a later function still leaves the earlier ones reusable.
    // A recompile reads it as empty, so nothing earlier is reused and every
    // function is asked for again: what this build proves is still recorded,
    // which is the point of recompiling rather than of forgetting.
    const incremental = discardStored
      ? (Object.create(null) as IncrementalRecord)
      : await readIncremental(store, paths.incremental);
    const base = storeResolve(store, workPath);
    // What every function of this build was compiled against, so nothing is
    // reused across a change of contract, target, options or model.
    const test = testConfigFor(input, options);
    const benchmarkConfig = { iterations: (inputFields["benchmark"] as Record<string, unknown> | undefined)?.["iterations"] as number | undefined ?? DEFAULT_BENCHMARK.iterations };
    // A program links the object of every function it calls, and running it is
    // what proves the functions it is the only oracle for. A build that stops
    // at candidate selection has no program to link or to run, and so has no
    // proof to record for those functions either.
    const checksProgram = body !== undefined && String(mode) === "build";
    // Which model an implementation came from is part of what it is, so asking
    // for a different one rebuilds. A build that names no model reuses what the
    // last build used rather than invalidating everything for want of a name.
    const modelKey = (fields["reuse"] as boolean)
      ? (previousFields === undefined ? "unset" : String(previousFields["model"] ?? "unset"))
      : (requested ?? environment.AI_MODEL ?? (previousFields === undefined ? undefined : previousFields["model"] as string | undefined) ?? "unset");
    // What the compiler itself is decides what an implementation is and how it
    // is proved, and it is in the key so that editing the prompt, the runtime
    // or the assembler rules rebuilds rather than reuses an object that the
    // build would then be reporting as freshly proved by rules that no longer
    // exist. It is two hashes and not one because it decides two things: the
    // review key covers everything that decides what a function is or what a
    // model said about it, and the object key the sources that decide what it
    // is lowered into. An edit to the second leaves the first standing, so the
    // candidates an earlier build reviewed are put through the toolchain as it
    // is now rather than asked for again.
    const generation = generationConfigFor(input, options);
    const keyOf = (unit: CompilationUnit): UnitKeys =>
      unitKeys({
        contract: storedContractOf(unit),
        file: String((unit as unknown as Record<string, unknown>)["file"]),
        program,
        target,
        output: outputKind,
        backend: backendKind,
        mode: buildMode,
        runtime: runtimeKind,
        test,
        benchmark: benchmarkConfig,
        generation,
        model: modelKey,
        compilerVersion: COMPILER_VERSION,
        review: String(toolchainFields["review"]),
        lowering: String(toolchainFields["lowering"]),
      });
    // One runtime for the whole build: every candidate of every function links
    // the same one, and the driver that runs the program links it too. The
    // HTTP runtime is built for the program that is being built: how many
    // connections its server may hold, and whether it speaks TLS.
    const http = httpRuntimeNeeds(body, [
      ...modules.map((module) => String((module as unknown as Record<string, unknown>)["source"])),
      String(entry["source"]),
    ]);
    const prepareRuntime = runtimePreparer({
      lowering: backendKind,
      mode: buildMode,
      runtime: runtimeKind,
      target,
      workspace: { workDirectory: base, functionName: String(entry["file"]) },
      libraries,
      http,
    });

    // The machine, one measurement at a time however many functions are being
    // generated.
    const machines = machine();
    // The incremental record, one writer at a time. It is a queue of its own
    // rather than a second machine: `Machine.run` admits shared work alongside
    // other shared work and `Machine.measure` is the timing phase, so neither is
    // a writer. Two of these writes overlap and each is a rename that wins
    // outright, so the earlier snapshot can land last and drop the entry of
    // whichever function finished first.
    let writing: Promise<void> = Promise.resolve();
    /** The functions this build took from an earlier one, by function name. */
    const reusedByFunction = new Map<string, string>();
    /**
     * What the program is the only oracle for, and so cannot be recorded as
     * proved until the program has run: a function whose contract states what
     * it does rather than what it returns.
     */
    const awaitingProgram = new Map<string, IncrementalEntry>();
    /**
     * Every function of the program, by the name the source gave it. The
     * outline has already decided, for each call, whether it is made or
     * written out (see semantics/calls.ts), so what a candidate may reference
     * and what its prompt has to carry both follow from one function's own
     * recorded calls rather than from the set of units this build happens to
     * compile.
     */
    const contracts = contractsByName(files);

    /**
     * Records what this build proved: every function it verified against its
     * own vectors, and the ones the program it just ran is the only oracle
     * for. The record is rewritten whole, so it never keeps a function this
     * program no longer compiles.
     */
    const prove = async (): Promise<void> => {
      // Keyed by whatever the source named the function, and `__proto__` is a
      // legal name: on an object with the usual prototype, assigning to it
      // replaces the prototype instead of adding an entry, and the record
      // this writes out is missing every entry it was going to keep.
      const proved = Object.create(null) as IncrementalRecord;
      for (const unit of units) {
        const key = unitNameKey(unit, units);
        const entry = awaitingProgram.get(key) ?? incremental[key];
        if (entry !== undefined) proved[key] = entry;
      }
      await storeWrite(store, paths.incremental, proved);
    };

    // What a round of generation produced, by function. A repair round replaces
    // only the units it regenerates, so a program is never half rebuilt.
    const generatedByFunction = new Map<string, UnitGeneration>();
    const unitsGenerated = (): UnitGeneration[] =>
      units.flatMap((unit) => {
        const entry = generatedByFunction.get(unitKey(unit));
        return entry === undefined ? [] : [entry];
      });
    /** How many candidates a unit has written, so a round names new ones. */
    const written = new Map<string, number>();

    /** The implementation a unit contributed to the program that mismatched. */
    const implementationOf = (key: string): string | undefined => {
      const entry = generatedByFunction.get(key);
      if (entry === undefined) return undefined;
      const entryFields = entry as unknown as Record<string, unknown>;
      const result = entryFields["result"] as Record<string, unknown>;
      const selected = result["selected"];
      if (selected === null || selected === undefined) return undefined;
      const candidates = result["candidates"] as Record<string, unknown>[];
      const chosen = candidates.find((candidate) => String(candidate["id"]) === String(selected));
      return chosen === undefined ? undefined : String(chosen["text"]);
    };

    /**
     * One round of generation. Every unit, unless the round is repairing a
     * program: then only the units the program is the sole oracle for, because
     * a function that was verified against its own contract cannot be what made
     * the program print the wrong thing. A repair round also reuses nothing:
     * the program has just said the implementation is wrong, so it is asked
     * for again.
     */
    const generateUnit = async (unit: CompilationUnit, mismatch: ProgramMismatch | undefined): Promise<void> => {
      const key = unitNameKey(unit, units);
      const artifactKey = unitKey(unit);
      const functionName = String(contractFunction(unitContract(unit))["name"]);
      const unitContractValue = unitContract(unit) as unknown as FunctionContract;
      const previous = mismatch === undefined ? undefined : implementationOf(key);
      if (mismatch !== undefined && (((unitContractValue as unknown as Record<string, unknown>)["ensures"] as string[]).length > 0 || previous === undefined)) return;
      const workspace = { workDirectory: `${base}/${artifactKey}`, functionName };
      await mkdir(workspace.workDirectory, { recursive: true });
      const keys = keyOf(unit);
      const reuse = unitReuse({
        entry: incremental[key],
        keys,
        workspace,
        functionName,
        output: outputKind,
        lowering: backendKind,
        linksObjects: checksProgram,
        program,
        callable: callableSymbols(storedContractOf(unit), contracts),
        required: fields["reuse"] as boolean,
        id,
      });
      const sequenceStart = written.get(key) ?? 0;
      const reuseFields = reuse as unknown as Record<string, unknown>;
      const reuseLevel = reuseFields["level"] === null ? null : String(reuseFields["level"]);
      const reuseEntry = reuseFields["entry"] as Record<string, unknown> | undefined;
      const reuseMissing = reuseFields["missing"] as string[];

      if (mismatch === undefined && reuseLevel === "object" && reuseEntry !== undefined) {
        const result = reusedResult(reuseEntry as unknown as IncrementalEntry);
        const resultFields = result as unknown as Record<string, unknown>;
        // A repair round generates after the stored candidates, so it never
        // writes over the object this build is about to link.
        written.set(functionName, sequenceStart + (resultFields["candidates"] as Candidate[]).length);
        reusedByFunction.set(key, String(reuseEntry["selected"]));
        generatedByFunction.set(artifactKey, unitGenerationOf(unit as CompilationUnit, result as CodegenResult));
        return;
      }

      if (reuseLevel === "assembly" && reuseMissing.length > 0) {
        reporter(
          "reuse",
          "info",
          `${functionName} is rebuilt from its stored implementation: ${reuseMissing.map((file) => basename(file)).join(", ")} ${reuseMissing.length === 1 ? "is" : "are"} gone`,
        );
      }

      const result = await reviewCandidates({
        mode: buildMode,
        contract: storedContractOf(unit),
        unitFile: String((unit as unknown as Record<string, unknown>)["file"]),
        parsed: storedParsedOf(unit),
        program,
        base: semantics[String(contractFunction(storedContractOf(unit) as unknown as Record<string, unknown>)["symbol"])] as SemanticFunction,
        functions: semantics,
        // A program is one module, so the functions a candidate calls are in
        // the module beside it. A build that compiles one function on its own
        // has nothing to hold beside it, and carries none.
        ...(body === undefined ? {} : { programFunctions: Object.values(semantics) }),
        target,
        output: outputKind,
        lowering: backendKind,
        runtime: runtimeKind,
        // A build with no model configured runs the rules alone, so there is
        // no backend to build and nothing here to ask.
        ...(modelRequested
          ? {
              backend: () => {
                if (fields["reuse"] as boolean) {
                  throw new CompilerError("StorageError", "reuse", `the stored implementation of ${functionName} no longer satisfies its contract`, "run blaze build without --reuse to review it again", "", "", "");
                }
                return createBackend(requireModel(), {
                  timeoutMs: requestTimeoutMs(input),
                  retries: (generation as unknown as Record<string, unknown>)["maxRetries"] as number,
                  onRetry: (notice) => {
                    const noticeFields = notice as unknown as Record<string, unknown>;
                    const stage = String(noticeFields["stage"]);
                    const candidate = String(noticeFields["candidate"]);
                    const attempt = Number(noticeFields["attempt"]);
                    const retry = Number(noticeFields["retry"]);
                    const retries = Number(noticeFields["retries"]);
                    const reason = String(noticeFields["reason"]);
                    const stop = noticeFields["stop"];
                    const answer = noticeFields["answer"];
                    // An answer that could not be read is also told how its request
                    // ended and what the request cost: one cut short by the output
                    // limit, one a content filter took and one the model finished on
                    // its own are not the same failure to wait out, and a gateway
                    // that reports the tokens is the only place they are counted.
                    const finish = stop === undefined ? "" : `, ${describeProviderStop(stop as ProviderStop)}`;
                    reporter(
                      "review",
                      "info",
                      `Asking again: ${functionName}, ${stage} of candidate ${candidate}, round ${attempt}, ${reason}${finish}; request ${retry} of ${retries}, waiting for ${modelName ?? "(unset)"}`,
                    );
                    // What the model wrote is not a line of the build log: a refusal
                    // names a line of it, so it is the only way to see the answer the
                    // refusal is about. It is printed beside the prompt, under the
                    // same `--debug`.
                    if ((fields["debug"] as boolean | undefined) === true && answer !== undefined) {
                      printAnswer(answerDumpOf(stage as AnswerDump["stage"], Number(candidate), attempt, retry, String(answer)));
                    }
                  },
                  ...((fields["debug"] as boolean | undefined) === true ? { onPrompt: printPrompt } : {}),
                });
              },
            }
          : {}),
        generation,
        test,
        benchmark: benchmarkConfig,
        prepareRuntime,
        workspace,
        callable: callableSymbols(unitContractValue, contracts),
        machine: machines,
        // A repair round asks the model again, so what an earlier build stored
        // is not what it starts from. Otherwise the stored implementation is
        // tried first, and a model is asked only when it does not satisfy the
        // contract.
        existing: mismatch === undefined && reuseLevel !== null ? ((reuseEntry === undefined ? undefined : reuseEntry["candidates"]) as Candidate[] ?? []) : [],
        sequenceStart,
        ...(mismatch === undefined || previous === undefined
          ? {}
          : { programFailure: { mismatch, previous } }),
        onNote: (note) => {
          reporter("review", "info", `${functionName}: ${note}`);
        },
        onReview: (notice) => {
          const noticeFields = notice as unknown as Record<string, unknown>;
          const stage = String(noticeFields["stage"]);
          const candidate = String(noticeFields["candidate"]);
          const candidates = String(noticeFields["candidates"]);
          const attempt = String(noticeFields["attempt"]);
          const attempts = String(noticeFields["attempts"]);
          reporter(
            "review",
            "info",
            `Reviewing the ${stage === "ir" ? "semantic IR" : implementationLabel(outputKind)}: ${functionName}, candidate ${candidate} of ${candidates}, round ${attempt} of ${attempts}, waiting for ${modelName ?? "(unset)"}`,
          );
        },
      });
      written.set(functionName, sequenceStart + ((result as unknown as Record<string, unknown>)["candidates"] as Candidate[]).length);
      reusedByFunction.delete(key);
      generatedByFunction.set(artifactKey, unitGenerationOf(unit as CompilationUnit, result as CodegenResult));

      // A function is proved by its own vectors, or by the program it is
      // part of, so an entry is only written once something has said so.
      const resultFields = result as unknown as Record<string, unknown>;
      const selected = resultFields["selected"];
      if (selected === null || selected === undefined) return;
      const resultOutcomes = resultFields["outcomes"] as Record<string, unknown>[];
      const entry = incrementalEntryOf(
        String((keys as unknown as Record<string, unknown>)["review"]),
        String((keys as unknown as Record<string, unknown>)["object"]),
        String((unit as unknown as Record<string, unknown>)["file"]),
        String(selected),
        resultFields["candidates"] as Candidate[],
        resultOutcomes as unknown as CandidateOutcome[],
        resultFields["benchmarkVector"] as TestVector | null,
      );
      const selectedOutcome = resultOutcomes.find((outcome) => String(outcome["candidate"]) === String(selected));
      const verified = selectedOutcome !== undefined && selectedOutcome["verification"] !== undefined;
      if (verified) {
        incremental[key] = entry;
        // The record is a whole file that every function adds itself to, so
        // two functions finishing together would each read the record before
        // the other wrote it, and one entry would be lost. One writer at a
        // time costs nothing: this is a write of a few kilobytes, and the
        // functions it is waiting for are still waiting on a model.
        const writeIncremental = (): Promise<void> => storeWrite(store, paths.incremental, { ...incremental });
        const writeNext = writing.then(writeIncremental, writeIncremental);
        writing = writeNext.then(
          () => {},
          () => {},
        );
        await writeNext;
      } else if (checksProgram) {
        awaitingProgram.set(key, entry);
      }
    };

    /**
     * One round of generation. Every unit, unless the round is repairing a
     * program: then only the units the program is the sole oracle for, because
     * a function that was verified against its own contract cannot be what made
     * the program print the wrong thing. A repair round also reuses nothing:
     * the program has just said the implementation is wrong, so it is asked
     * for again.
     *
     * Functions are as independent of each other as candidates are, so several
     * are generated at once. What they share is the machine, and that is
     * serialized: `machine` hands it to one candidate at a time, so nothing is
     * ever assembled, verified or timed beside something else doing the same.
     * What overlaps between functions is the waiting, which is where the time
     * a build spends goes.
     */
    const generateUnits = async (mismatch: ProgramMismatch | undefined): Promise<void> => {
      // Units are handed out in contract order, and every result is filed
      // under its function name, so a build reads the same way whatever order
      // the functions finish in.
      let next = 0;
      const worker = async (): Promise<void> => {
        while (next < units.length) {
          const index = next;
          next += 1;
          await generateUnit(units[index], mismatch);
        }
      };
      const workers = Math.max(1, Math.min((generation as unknown as Record<string, unknown>)["functionConcurrency"] as number, units.length));
      // A function that fails outright fails the build, so every worker is
      // allowed to settle before the first failure is reported: a function
      // still being generated must not go on writing work files after the
      // build has given up on it.
      const settled = await Promise.allSettled(Array.from({ length: workers }, () => worker()));
      const settledFields = settled as unknown as Record<string, unknown>[];
      const failure = settledFields.find((entry) => String(entry["status"]) === "rejected");
      if (failure !== undefined && String(failure["status"]) === "rejected") throw failure["reason"];
    };

    /** What every unit generated so far, as the build records it. */
    const record = async (): Promise<Record<string, string>> => {
      const generated = unitsGenerated();
      // Keyed by whatever the source named the function, so these are built
      // from entries rather than assigned into: a function called `__proto__`
      // would otherwise replace the prototype of the record instead of adding
      // an entry, and the record this build writes out would be missing it.
      const candidateValues: Record<string, Candidate[]> = Object.create(null) as Record<string, Candidate[]>;
      const verificationValues: Record<string, VerificationResult[]> = Object.create(null) as Record<string, VerificationResult[]>;
      const benchmarkValues: Record<string, BenchmarkResult[]> = Object.create(null) as Record<string, BenchmarkResult[]>;
      const selectedValues: Record<string, string> = Object.create(null) as Record<string, string>;
      const generationFunctions: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const entry of generated) {
        const entryFields = entry as unknown as Record<string, unknown>;
        const unit = entryFields["unit"] as CompilationUnit;
        const resultFields = entryFields["result"] as Record<string, unknown>;
        const functionName = String(contractFunction(unitContract(unit))["name"]);
        const key = unitNameKey(unit, units);
        const outcomes = resultFields["outcomes"] as Record<string, unknown>[];
        candidateValues[key] = resultFields["candidates"] as Candidate[];
        verificationValues[key] = outcomes.map((outcome) => outcome["verification"]).filter((verification): verification is VerificationResult => verification !== undefined);
        benchmarkValues[key] = outcomes.map((outcome) => outcome["benchmark"]).filter((benchmark): benchmark is BenchmarkResult => benchmark !== undefined);
        const valid = outcomes.filter((outcome) => outcome["valid"] as boolean).length;
        reporter(
          "review",
          valid > 0 ? "ok" : "fail",
          `${implementationLabel(outputKind)} for ${functionName}: ${(resultFields["candidates"] as unknown[]).length} candidate(s), ${valid} valid`,
        );
        if (resultFields["selected"] === null) {
          const detail = outcomes
            .map((outcome) => {
              const failure = outcome["failure"] as Record<string, unknown> | undefined;
              return failure === undefined
                ? `${String(outcome["candidate"])}:`
                : `${String(outcome["candidate"])}: ${String(failure["category"] ?? "")} ${String(failure["message"] ?? "")}\n${String(failure["detail"] ?? "")}`;
            })
            .join("\n");
          throw new CompilerError("VerificationError", "verify", `no candidate for ${functionName} satisfied the contract`, detail.trim(), functionName, "", "");
        }
        selectedValues[key] = String(resultFields["selected"]);
        const generationValue: Record<string, unknown> = {};
        for (const name of Object.keys(resultFields)) {
          const value = resultFields[name];
          generationValue[name] = typeof value === "bigint" ? String(value) : value;
        }
        generationFunctions[key] = generationValue;
      }
      const candidates = JSON.parse(JSON.stringify(candidateValues)) as Record<string, Candidate[]>;
      const verification = JSON.parse(JSON.stringify(verificationValues)) as Record<string, VerificationResult[]>;
      const benchmark = JSON.parse(JSON.stringify(benchmarkValues)) as Record<string, BenchmarkResult[]>;
      const selected = JSON.parse(JSON.stringify(selectedValues)) as Record<string, string>;
      await storeWrite(store, candidatesPath, candidates);
      await storeWrite(store, generationPath, {
        model: String((build as unknown as Record<string, unknown>)["model"]),
        modelConfig: String((build as unknown as Record<string, unknown>)["modelConfig"]),
        compilerVersion: COMPILER_VERSION,
        functions: JSON.parse(JSON.stringify(generationFunctions)),
        modelDurationNs: String(
          generated.reduce((total, entry) => {
            const resultFields = (entry as unknown as Record<string, unknown>)["result"] as Record<string, unknown>;
            return total + Number(resultFields["modelDurationNs"]);
          }, 0),
        ),
      });
      await storeWrite(store, verificationPath, verification);
      await storeWrite(store, benchmarkPath, benchmark);
      return selected;
    };

    // A function whose contract states what it does is not checked on its own:
    // the program it belongs to is the only oracle it has, and only a build has
    // that program. So a build generates, links and runs, and generates again
    // with what the program printed until the two agree or the rounds run out.
    const programRounds =
      body === undefined || String(mode) !== "build" || (fields["reuse"] as boolean) ? 1 : PROGRAM_REPAIR_ROUNDS + 1;
    let checked: ProgramVerification | undefined;
    let mismatch: ProgramMismatch | undefined;
    let selected: Record<string, string> = {};
    const programFile = body === undefined ? undefined : await programSource(base, id, project, body as ProgramBody, String(inputFields["language"]));
    // The linked program is named for the platform it was written for, and the
    // delivered program is the project's own name beside its sources.
    const programBinary = `program${EXECUTABLE_SUFFIX}`;
    const programPath = join(base, programBinary);
    // A program built as WebAssembly is one module and one host: the module
    // holds every function of the program and the body it runs, and the host is
    // what runs the entry of it.
    const programModule = join(base, "program.wasm");
    const programHost = join(base, "program.host.mjs");
    const deliveredProgram = join(project.directory, `${id}${EXECUTABLE_SUFFIX}`);
    for (let round = 1; round <= programRounds; round += 1) {
      await generateUnits(mismatch);
      selected = await record();
      if (driver === undefined || programFile === undefined || String(mode) !== "build") break;
      const runtime = await (prepareRuntime as unknown as (capture: undefined) => Promise<PreparedRuntime | undefined>)(undefined);
      const objectPaths = unitsGenerated().map((entry) => {
        const entryFields = entry as unknown as Record<string, unknown>;
        const unit = entryFields["unit"] as CompilationUnit;
        const result = entryFields["result"] as Record<string, unknown>;
        return join(join(base, unitKey(unit)), `${String(result["selected"])}.o`);
      });
      // `-fopenmp` is asked for when an object of the program carries a loop the
      // compiler proved its turns independent: the C backend writes that loop as
      // a pragma and only the OpenMP runtime serves it, so an object with one in
      // it links `GOMP_parallel` and fails to link without the flag. A program's
      // own statements are not the whole of this — its functions are objects of
      // their own, compiled one at a time, and the loop the driver holds nothing
      // of may be in any of them.
      // The driver is C, so a parallel loop in its own statements is OpenMP's,
      // while a function of the program lowered by the machine backend asks for
      // pthreads beside it. A program can want both, and asks for neither when
      // nothing of it was written as a team of threads.
      const threads: Threading[] = [];
      // Every function the program declares for itself that no candidate
      // covered is an object of its own, written by the machine backend
      // beside the ones the candidates were written into. What the backend
      // left in the driver stays there: the driver writes its definition,
      // and an object that calls it calls a function the linker can see.
      const loweredBodies: string[] = [];
      const driverFields = driver === undefined ? {} : driver as unknown as Record<string, unknown>;
      const driverBodies = (driverFields["bodies"] ?? []) as SemanticFunction[];
      const driverEntry = driverFields["entry"] as SemanticBlock | undefined;
      if (backendKind === "machine" && bodyLowering !== undefined) {
        const loweringFields = bodyLowering as unknown as Record<string, unknown>;
        const lowered = loweringFields["lowered"] as Set<string>;
        const callable = loweringFields["callable"] as ReadonlySet<string>;
        for (const body of driverBodies) {
          const symbol = String((body as unknown as Record<string, unknown>)["symbol"]);
          if (!lowered.has(symbol)) continue;
          const result = await buildMachineObjectFor(body, target, callable, join(base, `${symbol}.o`));
          const resultFields = result as unknown as Record<string, unknown>;
          objectPaths.push(String(resultFields["objectPath"]));
          loweredBodies.push(symbol);
          if (resultFields["threads"] !== undefined && !threads.includes("pthread")) threads.push("pthread");
        }
      }
      if (driverEntry !== undefined && programIsParallel(driverEntry, driverBodies)) threads.push("openmp");
      for (const entry of unitsGenerated()) {
        const entryFields = entry as unknown as Record<string, unknown>;
        const result = entryFields["result"] as Record<string, unknown>;
        const selected = result["selected"];
        if (selected === null || selected === undefined) continue;
        const outcomes = result["outcomes"] as Record<string, unknown>[];
        const outcome = outcomes.find((one) => String(one["candidate"]) === String(selected));
        const threading = outcome === undefined ? undefined : outcome["threads"] as string[] | undefined;
        for (const raw of threading ?? []) {
          const name = raw as Threading;
          if (!threads.includes(name)) threads.push(name);
        }
      }
      const isHttp = runtimeKind === "facil" || mentionsHttpModule(String((projectFields["entry"] as Record<string, unknown>)["source"]));
      let runtimeObjectPath: string | undefined;
      if (runtime !== undefined) runtimeObjectPath = String((runtime as unknown as Record<string, unknown>)["objectPath"]);
      const sharedBodyNames: string[] = bodyLowering === undefined ? [] : (bodyLowering as unknown as Record<string, unknown>)["visible"] as string[];
      let runner: Runner;
      if (backendKind === "wasm") {
        runner = await buildProgramModuleRunner(
          await programFunctions(base, unitsGenerated(), program, driver as SemanticProgram),
          driverEntry as SemanticBlock,
          programModule,
          programHost,
          String(inputFields["language"]),
        );
      } else if (isHttp || runtimeKind === "none") {
        const driverObjective: Objective = String(normalizeOptimize(inputFields["optimize"] as Partial<OptimizeSpec> | undefined).primary) as Objective;
        const driverMode: BuildMode = buildMode;
        const driverTarget: TargetSpec = target;
        const driverProgram: SemanticProgram = driver as SemanticProgram;
        const driverWork: string = base;
        const driverObjects: string[] = objectPaths;
        const driverLowered: string[] = loweredBodies;
        const driverShared: string[] = sharedBodyNames;
        const driverRuntime: string | undefined = runtimeObjectPath;
        const driverHttp: boolean = runtimeKind === "facil";
        const driverBackend: BackendKind = backendKind;
        const driverSqlite: boolean = usesSqlite;
        const driverTls: boolean = (http as unknown as Record<string, unknown>)["tls"] as boolean;
        const runtimeLibraryValues = runtime === undefined ? undefined : (runtime as unknown as Record<string, unknown>)["libraryObjects"] as Record<string, unknown>[] | undefined;
        const driverLibraries: string[] = (runtimeLibraryValues ?? []).map((library) => String(library["objectPath"]));
        const driverThreads: Threading[] = threads;
        const driverOutput: string = programPath;
        runner = runnerOf(await buildProgramDriverFor(
          driverObjective,
          driverMode,
          driverTarget,
          driverProgram,
          driverWork,
          driverObjects,
          driverLowered,
          driverShared,
          driverRuntime,
          driverHttp,
          driverBackend,
          driverSqlite,
          driverTls,
          driverLibraries,
          driverThreads,
          driverOutput,
        ));
      } else {
        runner = await buildProgramHostFor(
          buildMode,
          driver as SemanticProgram,
          base,
          objectPaths,
          programPath,
        );
      }
      // The project may ask that the delivered program not be run at all, and
      // a program built for another host cannot be run here: either way there
      // is no output the build can compare, so it is delivered as it was
      // linked and what it prints later is not the build's to say.
      if (programVerification === "none") break;
      checked = await verifyProgramFor(
        String(inputFields["language"]),
        String((programFile as unknown as Record<string, unknown>)["path"]),
        String(projectFields["directory"]),
        runner,
        fields["arguments"] as string[],
      );
      // A program that stopped is as repairable as one that printed the wrong
      // thing, so the rounds are spent on it rather than on ending the build.
      const checkedFields = checked as unknown as Record<string, unknown>;
      if (checkedFields["passed"] as boolean) break;
      mismatch = checkedFields["difference"] as ProgramMismatch | undefined;
      if (round < programRounds) {
        reporter("verify", "info", `${describeProgramFailure(mismatch)}; generating the functions it is the only oracle for again`);
      }
    }
    if (checked !== undefined) {
      const checkedFields = checked as unknown as Record<string, unknown>;
      if (!(checkedFields["passed"] as boolean)) {
        const difference = checkedFields["difference"] as Record<string, unknown> | undefined;
        const failureOutput = difference === undefined ? undefined : difference["failureOutput"];
        throw new CompilerError("VerificationError", "verify", difference === undefined ? "the program does not print what the source prints" : String(difference["failure"] ?? "the program does not print what the source prints"), [
            `line ${difference === undefined ? "" : String(difference["line"])}: the source prints ${JSON.stringify(difference === undefined ? undefined : difference["expected"])}, the program prints ${JSON.stringify(difference === undefined ? undefined : difference["actual"])}`,
            ...(failureOutput === undefined ? [] : [`the program wrote to standard error:\n${String(failureOutput)}`]),
          ].join("\n"), "", "", "");
      }
      const actual = String(checkedFields["actual"]);
      reporter(
        "verify",
        "ok",
        `Program output matches the source (${actual.split("\n").filter((line) => line !== "").length} line(s))`,
      );
    } else if (driver !== undefined && String(mode) === "build" && programVerification === "none") {
      // A program whose output is not checked is delivered without the
      // comparison, and the build says why rather than leaving the absence of
      // a verdict where a verdict would be.
      reporter(
        "verify",
        "ok",
        (inputFields["verifyProgram"] as boolean | undefined) === false
          ? "Program output is not checked (verifyProgram = false)"
          : `Program output is not checked: the program is built for ${target.os}, and this host is ${hostPlatform()}`,
      );
    }
    // The program has agreed with its source, so the functions it is the only
    // oracle for are proved now, and the record of what this build proved is
    // written whole.
    if (checked !== undefined) await prove();
    // A build that delivered a program says whether it checked that program's
    // output. A function-only build has no program and leaves the field out.
    if (driver !== undefined && String(mode) === "build") build.programVerification = programVerification;

    const generated = unitsGenerated();
    // Keyed by whatever the source named the function, so these are built from
    // entries for the reason `record` above spells out.
    const candidateEntries: (readonly [string, Candidate[]])[] = [];
    const verificationEntries: (readonly [string, VerificationResult[]])[] = [];
    const benchmarkEntries: (readonly [string, BenchmarkResult[]])[] = [];
    const outcomeEntries: (readonly [string, CandidateOutcome[]])[] = [];
    for (const entry of generated) {
      const entryFields = entry as unknown as Record<string, unknown>;
      const unit = entryFields["unit"] as CompilationUnit;
      const functionName = String(contractFunction(unitContract(unit))["name"]);
      const key = unitNameKey(unit, units);
      const resultFields = entryFields["result"] as Record<string, unknown>;
      const outcomes = resultFields["outcomes"] as Record<string, unknown>[];
      const selectedCandidate = String(resultFields["selected"]);
      candidateEntries.push([key, resultFields["candidates"] as Candidate[]]);
      outcomeEntries.push([key, outcomes as unknown as CandidateOutcome[]]);
      verificationEntries.push([
        key,
        outcomes.map((outcome) => outcome["verification"]).filter((verification): verification is VerificationResult => verification !== undefined),
      ]);
      benchmarkEntries.push([
        key,
        outcomes.map((outcome) => outcome["benchmark"]).filter((benchmark): benchmark is BenchmarkResult => benchmark !== undefined),
      ]);
      const outcome = outcomes.find((one) => String(one["candidate"]) === selectedCandidate);
      if (reusedByFunction.has(key)) {
        reporter(
          "assemble",
          "ok",
          `${implementationLabel(outputKind)} for ${functionName} was not rebuilt: candidate ${outcome === undefined ? selectedCandidate : String(outcome["candidate"])} is reused from the build that verified it`,
        );
        continue;
      }
      reporter("assemble", "ok", `${implementationLabel(outputKind)} built into a testable implementation`);
      if (outcome === undefined || outcome["verification"] === undefined) {
        reporter("verify", "info", `${functionName} returns no value to verify, so the program it is part of is what checks it`);
        continue;
      }
      const verificationFields = outcome["verification"] as Record<string, unknown>;
      const benchmarkFields = outcome["benchmark"] as Record<string, unknown> | undefined;
      reporter(
        "verify",
        "ok",
        `Correctness verified for ${functionName} (${String(verificationFields["cases"])} test vectors, tolerance ${verificationFields["tolerance"] === undefined ? "exact" : String(verificationFields["tolerance"])})`,
      );
      reporter(
        "benchmark",
        "ok",
        `Benchmark completed for ${functionName} (${benchmarkFields === undefined ? "0" : String(benchmarkFields["iterations"])} iterations, ${benchmarkFields === undefined ? "0" : String(benchmarkFields["durationNs"])} ns)`,
      );
    }
    const candidates = byName(candidateEntries);
    const verification = byName(verificationEntries);
    const benchmark = byName(benchmarkEntries);
    const outcomes = byName(outcomeEntries);

    let outputPath: string | null = null;
    let outputAssemblyPath: string | null = null;
    if (String(mode) === "build") {
      const delivered: string[] = [];
      // A file that is replaced may be the file of a program that is still
      // running: a rebuild while the old binary serves is the usual way round,
      // and the file of a running program cannot be written. The copy is made
      // beside its target and renamed over it, and a rename replaces the name
      // the running program is held by rather than the program itself.
      if (body !== undefined) {
        // The program was linked and run above, by the round that agreed with
        // the source, so what is delivered is what was checked.
        if (outputKind === "wasm") {
          // A program built as WebAssembly is one module and one host: the
          // module holds every function of the program and the body it runs,
          // and the host is the runtime it runs under. A module nobody can run
          // is not a deliverable, so the host is delivered beside it.
          await deliverStored(store, base, delivered, "program.wasm", paths.outputModule);
          await deliverStored(store, base, delivered, "program.host.mjs", paths.outputHost);
          outputPath = storeResolve(store, paths.outputModule);
        } else {
          //
          // The program beside the project's sources is stripped, and the store's
          // copy is not. A delivered binary is something a person runs, and a
          // symbol table, a build id and the unwind tables of a program with no
          // exceptions are 10-20% of a small binary for nothing. The store's copy
          // is made before the strip, so it keeps them.
          await deliverStored(store, base, delivered, programBinary, paths.outputBinary);
          run("strip", ["--strip-unneeded", programPath]);
          await copyDelivered(programPath, deliveredProgram);
          await deliverStored(store, base, delivered, runtimeKind === "nim" ? "program_host.nim" : "program.c", paths.outputProgram);
          delivered.push(deliveredProgram);
          outputPath = storeResolve(store, paths.outputBinary);
        }
      } else {
        const firstUnit = units[0] as CompilationUnit;
        const firstContract = unitContract(firstUnit) as unknown as FunctionContract;
        const key = unitNameKey(firstUnit, units);
        const artifactKey = unitKey(firstUnit);
        const functionName = String(contractFunction(unitContract(firstUnit))["name"]);
        const winner = selected[key];
        // A candidate that calls another function of the program is linked only
        // into that program, so the backend never writes a binary of its own for
        // it and there is nothing to deliver beside the IR. This is the same
        // question `codegen.ts:materialize` asks before it links a harness, read
        // off the IR that is delivered below, and a candidate whose IR cannot be
        // read is answered as one that calls out: the copy fails inside the
        // build rather than a binary that was never written being delivered.
        const implementation = await readFile(join(base, `${artifactKey}/${winner}.ir`), "utf8");
        const standalone = !callsOutOfProgram(implementation, program, callableSymbols(firstContract, contracts));
        // What the build delivers is the target the lowering produced, beside
        // the IR it was lowered from, which is the text a model wrote and the
        // one a later repair round is shown. Every kind answers in the IR, so
        // what differs is only the file the compiler wrote.
        await deliverStored(store, base, delivered, `${functionName}/${winner}.ir`, paths.outputIr);
        if (outputKind === "wasm") {
          await deliverStored(store, base, delivered, `${functionName}/${winner}.wasm`, paths.outputModule);
          // The host is the runtime a module runs under, and a module nobody
          // can run is not a deliverable: the host is delivered beside it.
          await deliverStored(store, base, delivered, `${functionName}/${winner}.host.mjs`, paths.outputHost);
          outputPath = storeResolve(store, paths.outputModule);
        } else if (outputKind === "ir") {
          if (standalone) {
            await deliverStored(store, base, delivered, `${functionName}/${winner}${EXECUTABLE_SUFFIX}`, paths.outputBinary);
            outputPath = storeResolve(store, paths.outputBinary);
          }
        } else if (backendKind === "machine") {
          // The object is the artifact the compiler wrote, so it is what the
          // build delivers beside the IR it was written from. A `machine`
          // build also delivers the executable, which is what a person runs.
          await deliverStored(store, base, delivered, `${functionName}/${winner}.o`, paths.outputObject);
          outputAssemblyPath = storeResolve(store, paths.outputObject);
          outputPath = storeResolve(store, paths.outputObject);
          if (outputKind === "machine" && standalone) {
            await deliverStored(store, base, delivered, `${functionName}/${winner}${EXECUTABLE_SUFFIX}`, paths.outputBinary);
            outputPath = storeResolve(store, paths.outputBinary);
          }
        } else {
          // The delivered text is the one the object was built from, so it can
          // be fed straight back to the toolchain that reads it.
          const target = outputKind === "c" ? paths.outputSource : paths.outputAssembly;
          await deliverStored(store, base, delivered, `${functionName}/${winner}.${outputKind === "c" ? "c" : "s"}`, target);
          outputAssemblyPath = storeResolve(store, target);
          outputPath = storeResolve(store, target);
          if (outputKind === "machine" && standalone) {
            await deliverStored(store, base, delivered, `${functionName}/${winner}${EXECUTABLE_SUFFIX}`, paths.outputBinary);
            outputPath = storeResolve(store, paths.outputBinary);
          }
        }
      }
      // The build record is written next and names these files as what the
      // build produced, so they are on the disk before it says so: a copy
      // still in the page cache when the machine loses power leaves a
      // successful build record pointing at nothing.
      for (const path of delivered) await flushToDisk(path);
      reporter("output", "ok", `Output (${outputKind}):\n${delivered.map((path) => `  ${path}`).join("\n")}`);
    }
    // A build with no program to check has proved everything its functions
    // could prove on their own, so the record of that is written now.
    if (checked === undefined) await prove();
    build.status = "success";
    build.selectedCandidates = selected;
    build.reused = Object.fromEntries(reusedByFunction);
    // The deliverable this build actually produced. A build that only
    // generated candidates delivered nothing, and saying it delivered the
    // assembly pointed automation at a file that was never written.
    if (outputPath !== null) build.output = relative(store.root, outputPath);
    build.updatedAt = new Date().toISOString();
    await writeBuildRecord(store, buildPathOf(paths), build);

    const generationRecord = generationRecordOf(
      selected,
      outcomes,
      String(
        generated.reduce((total, entry) => {
          const resultFields = (entry as unknown as Record<string, unknown>)["result"] as Record<string, unknown>;
          return total + Number(resultFields["modelDurationNs"]);
        }, 0),
      ),
    );
    return buildOutcomeOf(
      id,
      build,
      Object.fromEntries(units.map((unit) => [unitNameKey(unit, units), unitContract(unit) as unknown as FunctionContract])),
      program,
      body,
      candidates,
      verification,
      benchmark,
      generationRecord,
      outputKind,
      outputPath,
      outputAssemblyPath,
    );
  } catch (cause) {
    // The project is known from here on, so the CLI can point at the record.
    const failure = toCompilerError(cause, "AiReviewError", mode, "", "", "", "", "");
    const error = new CompilerError(failure.category, failure.stage, failure.message, failure.detail, failure.functionName, failure.candidate, id);
    build.status = "failed";
    build.error = error.toJSON();
    build.updatedAt = new Date().toISOString();
    await writeBuildRecord(store, buildPathOf(paths), build);
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* test / benchmark / inspect                                                 */
/* -------------------------------------------------------------------------- */

export interface StoredCommandOutcome {
  project: string;
  /** What was re-tested or re-measured, by function name. */
  functions: Record<string, { candidate: string; verification?: VerificationResult; benchmark?: BenchmarkResult }>;
}

async function loadStored(
  store: JsonStore,
  root: string,
  project: string,
): Promise<{ paths: ProjectPaths; program: ProgramContract; units: CompilationUnit[] }> {
  const paths = await storedPaths(store, root, project);
  const pathsFields = paths as unknown as Record<string, unknown>;
  const contractPath = String(pathsFields["contract"]);
  const buildPath = String(pathsFields["build"]);
  if (!(await storeExists(store, contractPath))) {
    throw new CompilerError("StorageError", "load", `unknown project "${project}"`, `no contract at ${contractPath}`, "", "", "");
  }
  const program = await storeRead<ProgramContract>(store, contractPath);
  const programFields = program as unknown as Record<string, unknown>;
  const entry = programFields["entry"] as Record<string, unknown>;
  // A stored program records which functions it compiled, so `blaze test` and
  // `blaze benchmark` work on every one of them rather than on an entry the
  // program does not have.
  const build = (await storeExists(store, buildPath)) ? await storeRead<BuildStatus>(store, buildPath) : undefined;
  const buildFields = build as unknown as Record<string, unknown> | undefined;
  const compiled = buildFields === undefined || buildFields["selectedCandidates"] === undefined ? {} : buildFields["selectedCandidates"] as Record<string, string>;
  const all = compilationUnits(program, entry["function"] === null);
  const units = all.filter(
    (unit) => Object.keys(compiled).length === 0 || compiled[unitNameKey(unit, all)] !== undefined,
  );
  return { paths, program, units };
}

export async function runStored(
  project: string,
  options: BuildOptions,
  reporter: Reporter,
  action: "test" | "benchmark",
): Promise<StoredCommandOutcome> {
  const fields = options as unknown as Record<string, unknown>;
  const root = join(String(fields["cwd"]), STATE_DIRECTORY);
  const store = createJsonStore(root);
  const loaded = await loadStored(store, root, project);
  const loadedFields = loaded as unknown as Record<string, unknown>;
  const paths = loadedFields["paths"] as ProjectPaths;
  const program = loadedFields["program"] as ProgramContract;
  const units = loadedFields["units"] as CompilationUnit[];
  const programFields = program as unknown as Record<string, unknown>;
  const files = programFields["files"] as FileContract[];
  const entry = programFields["entry"] as Record<string, unknown>;
  const pathFields = paths as unknown as Record<string, unknown>;
  const candidatesPath = String(pathFields["candidates"]);
  const inputPath = String(pathFields["input"]);
  const buildRecordPath = String(pathFields["build"]);
  const workPath = String(pathFields["work"]);
  const verificationPath = String(pathFields["verification"]);
  const benchmarkPath = String(pathFields["benchmark"]);
  if (units.length === 0) {
    throw new CompilerError("StorageError", action, `project "${project}" compiled no function`, "run blaze build first", "", "", "");
  }
  if (!(await storeExists(store, candidatesPath))) {
    throw new CompilerError("StorageError", action, `project "${project}" has no stored candidates`, "run blaze build first", "", "", "");
  }
  const input = await storeExists(store, inputPath) ? await storeRead<SourceInput>(store, inputPath) : ({} as SourceInput);
  const inputFields = input as unknown as Record<string, unknown>;
  const build = await storeReadIfValid<BuildStatus>(store, buildRecordPath);
  // A build that failed selected nothing, so there is no candidate here that
  // is the project's. Falling back to the last one stored would re-measure an
  // implementation that was never delivered and write that measurement into
  // the record as the project's own.
  const buildFields = build as unknown as Record<string, unknown> | undefined;
  const buildStatus = buildFields === undefined ? undefined : String(buildFields["status"]);
  if (build !== undefined && buildStatus !== "success") {
    const errorFields = buildFields === undefined ? undefined : buildFields["error"] as Record<string, unknown> | undefined;
    throw new CompilerError("StorageError", action, `project "${project}" has no successful build to ${action}`, [
        `the last build of this project ${buildStatus === "building" ? "never finished" : "failed"}: ${errorFields === undefined ? "no diagnostic is recorded" : String(errorFields["message"] ?? "no diagnostic is recorded")}`,
        `run ${STATE_DIRECTORY} > projects > ${project} > build.json for the whole of it, then build again`,
      ].join("\n"), "", "", "");
  }
  // Every record below is keyed by whatever the source named its functions,
  // and `__proto__` is a legal identifier. On an object with the usual
  // prototype, reading that key answers from `Object.prototype` rather than
  // reporting the function as absent, and writing it replaces the prototype
  // instead of adding an entry, so the record the build wrote is quietly
  // missing the one function it kept. A record with no prototype holds what
  // it holds and nothing else.
  const stored = Object.create(null) as Record<string, Candidate[]>;
  const candidatesByName = await storeRead<Record<string, Candidate[]>>(store, candidatesPath);
  for (const name of Object.keys(candidatesByName)) {
    const candidates = candidatesByName[name];
    if (Array.isArray(candidates)) stored[name] = candidates;
  }

  reporter("model", "info", `Model: ${buildFields === undefined || buildFields["model"] === undefined ? "unknown" : String(buildFields["model"])}`);
  const output = (buildFields === undefined ? undefined : buildFields["outputKind"] as OutputKind | undefined) ?? "machine";
  const lowering = (buildFields === undefined ? undefined : buildFields["backend"] as BackendKind | undefined) ?? impliedBackend(output);
  const mode = (buildFields === undefined ? undefined : buildFields["mode"] as BuildMode | undefined) ?? "debug";
  // The contract names no target, so the one the build ran for is what the
  // stored candidate is tested and measured against.
  const target = (buildFields === undefined ? undefined : buildFields["target"] as TargetSpec | undefined) ?? normalizeTarget(inputFields["target"] as Partial<TargetSpec> | undefined);
  const runtime = resolveRuntimeKind((fields["runtime"] as RuntimeKind | undefined) ?? (buildFields === undefined ? undefined : buildFields["runtime"] as RuntimeKind | undefined) ?? inputFields["runtime"] as RuntimeKind | undefined, output);
  assertRuntimeSupported(target, runtime);
  const libraries = libraryKindsFor(String(inputFields["source"]), target);
  const base = storeResolve(store, workPath);
  const prepareRuntime = runtimePreparer({
    lowering,
    mode,
    runtime,
    target,
    workspace: { workDirectory: base, functionName: String(entry["file"]) },
    libraries,
    // The runtime is built for the program the stored candidates belong to, so
    // it is built for the same program the build built it for: the source of
    // the project is what says what its server holds and whether it speaks
    // TLS.
    http: httpRuntimeNeeds(undefined, [String(inputFields["source"])]),
  });
  // A stored candidate is given the same symbols the build that stored it was
  // given, which is what its own recorded calls say rather than what the build
  // happened to compile: the outline decided which of them is a call, and a
  // candidate is measured against the same rule it was checked under.
  const contracts = contractsByName(files);
  // `blaze test` measures stored candidates one at a time, but it measures
  // them the way a build does, so it goes through the same machine.
  const machines = machine();
  // A stored candidate is folded against the whole program too, so the bodies
  // it may inline are resolved here exactly as the build resolved them. The
  // object layouts are a property of the contracted files and nothing else, so
  // the same program answers the same names without the phase being run again.
  const objectNamesResult = resolveObjects(files);
  const objectNameFields = objectNamesResult as unknown as Record<string, unknown>;
  const names = objectNameFields["names"] as Map<string, string>;
  const functions = semanticFunctions(program, Object.fromEntries(names), undefined, {}, new Map());

  // Both records are collected as entries and written whole, the way a build
  // writes its own, so a name that is a key of neither is never half written.
  const verificationEntries: [string, VerificationResult[]][] = [];
  const benchmarkEntries: [string, BenchmarkResult[]][] = [];
  const functionEntries: [string, StoredCommandOutcome["functions"][string]][] = [];
  for (const unit of units) {
    const key = unitNameKey(unit, units);
    const artifactKey = unitKey(unit);
    const functionName = String(contractFunction(unitContract(unit))["name"]);
    const candidates = stored[key] ?? [];
    const chosen = ((buildFields === undefined ? undefined : buildFields["selectedCandidates"]) as Record<string, string> | undefined)?.[key];
    const candidate = candidates.find((entry) => String((entry as unknown as Record<string, unknown>)["id"]) === chosen);
    if (candidate === undefined) {
      throw new CompilerError("StorageError", action, `project "${project}" has no candidate to ${action} for ${functionName}`, "", "", "", "");
    }
    const workspace = { workDirectory: `${base}/${artifactKey}`, functionName };
    const result = await evaluateStoredCandidate({
      mode,
      contract: storedContractOf(unit),
      parsed: storedParsedOf(unit),
      program,
      functions,
      // A program is one module, so the functions a candidate calls are in
      // the module beside it. A build that compiles one function on its own
      // has nothing to hold beside it, and carries none.
      ...(entry["function"] === null ? { programFunctions: Object.values(functions) } : {}),
      target,
      output,
      lowering,
      runtime,
      candidate,
      workspace,
      callable: callableSymbols(storedContractOf(unit), contracts),
      prepareRuntime,
      machine: machines,
      test: testConfigFor(input, options),
      benchmark: { iterations: benchmarkIterationsOf(input) },
    });
    const resultFields = result as unknown as Record<string, unknown>;
    const resultVerification = resultFields["verification"] as VerificationResult | undefined;
    const resultBenchmark = resultFields["benchmark"] as BenchmarkResult | undefined;
    functionEntries.push([
      key,
      storedFunctionOf(
        String((candidate as unknown as Record<string, unknown>)["id"]),
        resultVerification,
        resultBenchmark,
      ),
    ]);
    verificationEntries.push([key, resultVerification === undefined ? [] : [resultVerification]]);
    benchmarkEntries.push([key, resultBenchmark === undefined ? [] : [resultBenchmark]]);

    // A function that states no postcondition has no vector to run, so there is
    // nothing to report for it here.
    if (resultVerification === undefined && resultBenchmark === undefined) {
      reporter(action, "info", `${functionName} has no vectors to run, so the program it is part of is what checks it`);
      continue;
    }
    if (String(action) === "test") {
      const verificationFields = resultVerification as unknown as Record<string, unknown>;
      reporter(
        "verify",
        (verificationFields["passed"] as boolean) === true ? "ok" : "fail",
        `Correctness verified for ${functionName} (${verificationFields["cases"] === undefined ? "0" : String(verificationFields["cases"])} test vectors)`,
      );
    } else {
      const benchmarkFields = resultBenchmark as unknown as Record<string, unknown>;
      reporter(
        "benchmark",
        "ok",
        `Benchmark completed for ${functionName} (${benchmarkFields["iterations"] === undefined ? "0" : String(benchmarkFields["iterations"])} iterations, ${benchmarkFields["durationNs"] === undefined ? "0" : String(benchmarkFields["durationNs"])} ns)`,
      );
    }
  }
  // A record a re-measure rewrites whole, so it never keeps a function this
  // program no longer compiles, and a name any source may use is a key of it.
  await storeWrite(store, verificationPath, byName(verificationEntries));
  await storeWrite(store, benchmarkPath, byName(benchmarkEntries));
  return { project, functions: byName(functionEntries) };
}

export interface SemanticIrOptions {
  /**
   * IR text to read instead of resolving the source, as a model or a person
   * writes it. Whatever wrote it, the program is validated against the
   * contract before it is printed, so nothing reaches a backend unchecked.
   */
  from?: string;
  /** The function to describe, rather than the program the project runs. */
  function?: string;
  /** Every function of every file, rather than one. */
  all?: boolean;
}

/**
 * The semantic IR of a project's program: what the program does, before any
 * target is chosen. Printing it is how a person reads what the compiler
 * resolved; reading it back is how IR that was written rather than resolved is
 * checked against the contract it claims to implement.
 */
export async function runSemanticIr(inputPath: string, options: SemanticIrOptions): Promise<string> {
  const fields = options as unknown as Record<string, unknown>;
  const { input, entry, directory } = readInput(inputPath);
  const inputFields = input as unknown as Record<string, unknown>;
  const phase = contractPhaseFor(
    frontendFor(String(inputFields["language"])),
    input,
    entry,
    moduleReader(directory),
    inputFields["host"] as Readonly<Record<string, string>> | undefined,
  );
  const phaseFields = phase as unknown as Record<string, unknown>;
  const contract = phaseFields["program"] as ProgramContract;
  const body = phaseFields["body"] as ProgramBody | undefined;
  const objectNames = phaseFields["objectNames"] as Record<string, string>;
  const objectLayouts = phaseFields["objectLayouts"] as Record<string, ObjectLayout>;
  const objectKeys = phaseFields["objectKeys"] as LiteralKeys;
  const semantics = semanticFunctions(contract, objectNames, body, objectLayouts, objectKeys);
  // A function is the unit the IR describes, so a function can be asked for by
  // name, and every function of the program can be asked for at once.
  if (fields["function"] !== undefined || (fields["all"] as boolean | undefined) === true) {
    if (fields["function"] === undefined) {
      return contract.files
        .map((file) => {
          const fileFields = file as unknown as Record<string, unknown>;
          return printSemanticModule(resolveModule(String(fileFields["path"]), fileFields["functions"] as Record<string, FunctionContract>, functionContext(phase)));
        })
        .join("\n");
    }
    const wanted = Object.values(semantics).find((fn) => String((fn as unknown as Record<string, unknown>)["name"]) === String(fields["function"]));
    if (wanted === undefined) {
      throw new CompilerError("InputError", "ir", `${projectIdFor(inputPath)} has no function called ${String(fields["function"])}`, `it declares ${Object.keys(semantics).join(", ") || "nothing"}`, "", "", "");
    }
    // What the backends are handed is folded, so what is printed here is what
    // was lowered rather than what the frontend resolved.
    return printSemanticFunction(optimizeSemanticFunction(structuredClone(wanted), new Map(Object.entries(semantics))));
  }
  if (body === undefined) {
    throw new CompilerError("InputError", "ir", `${projectIdFor(inputPath)} has no program body`, "this project declares functions and runs nothing of its own; ask for one with --function, or for all of them with --all", "", "", "");
  }
  const callees = new Map(Object.entries(semantics));
  const program =
    fields["from"] === undefined
      ? resolveProgram(body as ProgramBody, contract, objectNames, objectLayouts, objectKeys)
      : parseSemanticProgram(readFileSync(String(fields["from"]), "utf8"), contract);
  const programFields = program as unknown as Record<string, unknown>;
  const programBodies = programFields["bodies"] as SemanticFunction[];
  validateSemanticProgram(
    program,
    contract,
    new Map(programBodies.map((fn) => [String((fn as unknown as Record<string, unknown>)["name"]), fn])),
  );
  // As for a function: the program the backends lower is folded, so the one
  // printed here is the one they were handed.
  return printSemanticProgram(optimizeProgram(program, callees));
}

export async function inspectProject(project: string, cwd: string): Promise<BuildStatus> {
  const root = join(cwd, STATE_DIRECTORY);
  const store = createJsonStore(root);
  const paths = await storedPaths(store, root, project);
  const pathFields = paths as unknown as Record<string, unknown>;
  const buildRecordPath = String(pathFields["build"]);
  if (!(await storeExists(store, buildRecordPath))) {
    throw new CompilerError("StorageError", "inspect", `unknown project "${project}"`, `no build record at ${buildRecordPath}`, "", "", "");
  }
  return storeRead<BuildStatus>(store, buildRecordPath);
}

export async function listProjects(cwd: string): Promise<string[]> {
  const root = join(cwd, STATE_DIRECTORY);
  const projectsRoot = join(root, "projects");
  const entries = await readdirEntries(projectsRoot).catch(() => []);
  const names = entries.map((entry) => String((entry as unknown as Record<string, unknown>)["name"]));
  return names.filter((name) => isDirectoryPath(join(projectsRoot, name)));
}

/** One line of `blaze projects`: the project and the build it last had. */
export async function projectStateLine(project: string, cwd: string): Promise<string> {
  const build = await inspectProject(project, cwd).catch(() => undefined);
  if (build === undefined) return project;
  const buildFields = build as unknown as Record<string, unknown>;
  const selected = (buildFields["selectedCandidates"] ?? {}) as Record<string, string>;
  const names = Object.keys(selected);
  const label = names.length === 0
    ? "-"
    : names.map((name) => `${name}#${selected[name]}`).join(",");
  return `${project}  ${String(buildFields["status"])}  ${String(buildFields["model"])}  ${label}`;
}

/** How many functions the program contract covers, for the build report. */
function contractedFunctionCount(program: ProgramContract): number {
  return program.files.reduce((total, file) => total + Object.keys((file as unknown as Record<string, unknown>)["functions"] as Record<string, unknown>).length, 0);
}

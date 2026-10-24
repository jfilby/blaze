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

import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { createBackend, describeProviderStop, quoteReply, type AnswerDump, type PromptDump } from "./ai/backend.ts";
import { parse as parseToml } from "smol-toml";
import { normalizeOptimize, parseContract, type ParsedContract } from "./semantics/contract.ts";
import { INLINE_MODULE, runContractPhase } from "./semantics/program.ts";
import { contractsByName, vectorChecked, type ContractsByName } from "./semantics/calls.ts";
import type { ProgramBody } from "./semantics/module.ts";
import type {
  SemanticBlock,
  SemanticFunction,
  SemanticProgram,
  SemanticType,
} from "./core/semantic-ir.ts";
import { slotType, statementBlocksOf, statementValues, walkValues } from "./core/semantic-ir.ts";
import { resolveObjects } from "./semantics/objects.ts";
import { verifyProgram, type ProgramVerification } from "./toolchain/verify-program.ts";
import { buildProgramDriver } from "./toolchain/driver.ts";
import { buildProgramModule, type ModuleFunction } from "./toolchain/ir-wasm.ts";
import { buildObject as buildMachineObject, machineRefusal } from "./toolchain/ir-machine.ts";
import { buildProgramHost } from "./runtime/nim-program.ts";
import { usesSqliteSource } from "./runtime/sqlite.ts";
import { httpRuntimeNeeds } from "./runtime/http-needs.ts";
import { resolveProgram } from "./semantics/ir-resolve.ts";
import type { LiteralKeys } from "./semantics/program-objects.ts";
import { resolveFunction, resolveModule, type FunctionContext } from "./semantics/ir-function.ts";
import { validateSemanticFunction } from "./semantics/ir-validate.ts";
import { optimizeSemanticFunction, optimizeSemanticProgram } from "./semantics/optimize-ir.ts";
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
} from "./codegen.ts";
import { CompilerError, toCompilerError } from "./core/errors.ts";
import { createJsonStore, flushToDisk, hashText, hashValue, type JsonStore } from "./core/json-store.ts";
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
import { assertBuildableTarget, EXECUTABLE_SUFFIX, normalizeTarget, optimizationOptions } from "./core/target.ts";
import { run } from "./core/process.ts";

import { COMPILER_VERSION, engineStamp, toolchainFingerprints } from "./core/version.ts";
import {
  type ProgramMismatch,
  DEFAULT_BENCHMARK,
  DEFAULT_GENERATION,
  DEFAULT_TEST,
  type Candidate,
  type BenchmarkResult,
  type CandidateOutcome,
  type RuntimeKind,
  RUNTIME_KINDS,
  BACKENDS,
  type BackendKind,
  BUILD_MODES,
  type BuildMode,
  type BuildStatus,
  OUTPUT_KINDS,
  type FunctionContract,
  type ObjectLayout,
  type ProgramContract,
  type GenerationConfig,
  type ModelSelection,
  type OutputKind,
  type SourceInput,
  type SourceModule,
  type TestConfig,
  type TargetSpec,
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

export interface Reporter {
  stage(stage: string, status: "ok" | "fail" | "info", message: string): void;
}

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
    throw new CompilerError({
      category: "InputError",
      stage: "input",
      message: `unknown output kind "${String(requested)}"`,
      detail: `expected one of ${OUTPUT_KINDS.join(", ")}`,
    });
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
    throw new CompilerError({
      category: "InputError",
      stage: "input",
      message: `unknown backend "${String(requested)}"`,
      detail: `expected one of ${BACKENDS.join(", ")}`,
    });
  }
  if (!BACKEND_DELIVERS[requested].includes(output)) {
    const deliverable = BACKEND_DELIVERS[requested].join(", ");
    throw new CompilerError({
      category: "InputError",
      stage: "input",
      message: `the "${requested}" backend cannot deliver the "${output}" output kind`,
      detail: `it delivers ${deliverable}; build it without --backend, or name one of ${BACKENDS.filter((backend) => BACKEND_DELIVERS[backend].includes(output)).join(", ")}`,
    });
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
    throw new CompilerError({
      category: "InputError",
      stage: "input",
      message: `unknown mode "${String(requested)}"`,
      detail: `expected one of ${BUILD_MODES.join(", ")}`,
    });
  }
  return requested;
}

/**
 * Normalizes the requested runtime. `none` is the default: the compiler emits
 * the runtime itself, and only a named host replaces it.
 */
function resolveRuntimeKind(requested: RuntimeKind | undefined, output: OutputKind): RuntimeKind {
  if (output === "wasm" && requested !== undefined && requested !== "none") {
    throw new CompilerError({
      category: "InputError",
      stage: "input",
      message: `a WebAssembly module cannot link the "${requested}" runtime`,
      detail: "a wasm module imports no host runtime; build it with --output machine, or drop --runtime",
    });
  }
  if (requested === undefined) return "none";
  if (!RUNTIME_KINDS.includes(requested)) {
    throw new CompilerError({
      category: "InputError",
      stage: "input",
      message: `unknown runtime "${String(requested)}"`,
      detail: `expected one of ${RUNTIME_KINDS.join(", ")}`,
    });
  }
  return requested;
}

/**
 * A project is named after its `blaze.toml`, or after the directory that
 * holds one: a directory with a blaze.toml in it is the project. Any other
 * `.toml` file names its own project, so examples can stay flat.
 */
export function projectIdFor(inputPath: string): string {
  const name = basename(inputPath, extname(inputPath));
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
async function storedPaths(store: JsonStore, project: string): Promise<ProjectPaths> {
  const prefix = `${project}-`;
  const found = (await store.list("projects")).filter(
    (entry) => entry.startsWith(prefix) && entry.length === prefix.length + STORE_HASH_LENGTH,
  );
  if (found.length === 0) return projectPaths(project, project);
  // More than one is two projects with the same name and different paths, which
  // a name alone cannot tell apart. The one that wrote its record last is the one
  // whose answers are the most recent ones, and that is what this reads.
  const written: [string, number][] = await Promise.all(
    found.map(async (entry) => {
      const paths = projectPaths(project, entry);
      const build = (await store.exists(paths.build)) ? await store.read<BuildStatus>(paths.build) : undefined;
      return [entry, Date.parse(build?.updatedAt ?? "") || 0] as [string, number];
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
    throw new CompilerError({
      category: "InputError",
      stage: "input",
      message: `cannot read input file ${path}`,
      detail: cause instanceof Error ? cause.message : String(cause),
    });
  }
  // A source file is not a project file. Saying so beats reporting a TOML
  // parse error on code the compiler was never meant to read directly.
  if (extname(path) !== ".toml") {
    throw new CompilerError({
      category: "InputError",
      stage: "input",
      message: `${path} is a source file, not a project file`,
      detail: "blaze builds the TOML project file, which names the source file to compile; run blaze build with the blaze.toml beside it",
    });
  }
  let parsed: unknown;
  try {
    parsed = parseToml(text);
  } catch (cause) {
    throw new CompilerError({
      category: "InputError",
      stage: "input",
      message: `${path} is not valid TOML`,
      detail: cause instanceof Error ? cause.message : String(cause),
    });
  }
  const input = parsed as Partial<SourceInput> & { sourceFile?: string };
  if (typeof input.language !== "string") {
    throw new CompilerError({ category: "InputError", stage: "input", message: `${path} must define "language"` });
  }
  rejectCredentials(path, input);
  const directory = dirname(path);
  // `sourceFile` names a source file next to the project file, so the example
  // projects compile the real file instead of a copy of it pasted into the
  // project file. Its path is the one the program is known by, so it names
  // every contract.
  let entryPath = INLINE_MODULE;
  if (input.sourceFile !== undefined) {
    if (typeof input.sourceFile !== "string" || input.sourceFile === "") {
      throw new CompilerError({
        category: "InputError",
        stage: "input",
        message: `${path} has an empty "sourceFile"`,
      });
    }
    const sourcePath = resolve(directory, input.sourceFile);
    try {
      entryPath = relative(directory, sourcePath);
      input.source = readFileSync(sourcePath, "utf8");
    } catch (cause) {
      throw new CompilerError({
        category: "InputError",
        stage: "input",
        message: `cannot read source file ${sourcePath}`,
        detail: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  if (typeof input.source !== "string" || input.source.trim() === "") {
    throw new CompilerError({
      category: "InputError",
      stage: "input",
      message: `${path} must define "source" or "sourceFile"`,
    });
  }
  return { input: input as SourceInput, entry: { path: entryPath, source: input.source }, directory };
}

/** Reads a module the program imports, by the path its importer used. */
function moduleReader(directory: string): (path: string) => string | null {
  return (path) => {
    const full = resolve(directory, path);
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
        throw new CompilerError({
          category: "InputError",
          stage: "input",
          message: `${path} puts a credential in "${at}"`,
          detail: "a project names its provider and model; the API key comes from the environment",
        });
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
    throw new CompilerError({
      category: "InputError",
      stage: "input",
      message: `${path} has a "model" that is neither a string nor an object`,
    });
  }
  const { provider, model, file } = selection as ModelSelection;
  if (provider === "replay") {
    if (file === undefined || file === "") {
      throw new CompilerError({
        category: "InputError",
        stage: "input",
        message: `${path} selects the replay provider without a "file"`,
        detail: 'the offline provider serves recorded IR: "model": { "provider": "replay", "file": "candidate.json" }',
      });
    }
    return `replay:${file}`;
  }
  // A table that names nothing is a project with no model configured: the
  // commented-out provider lines kept between builds leave exactly this
  // behind, and a build runs the rules alone. One half of the pair named and
  // the other not is a selection gone wrong, and is reported.
  if (provider === undefined && model === undefined && file === undefined) return undefined;
  if (provider === undefined || provider === "" || model === undefined || model === "") {
    throw new CompilerError({
      category: "InputError",
      stage: "input",
      message: `${path} must name both a provider and a model`,
      detail: '"model": { "provider": "openrouter", "model": "anthropic/claude-sonnet-4.5" }',
    });
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
  const generation = input.generation;
  if (generation === undefined) return;
  const refuse = (setting: string, value: number, why: string): void => {
    throw new CompilerError({
      category: "InputError",
      stage: "input",
      message: `${path} sets "generation.${setting}" to ${value}`,
      detail: `"generation.${setting}" must be ${why}`,
    });
  };
  const timeoutSeconds = generation.timeoutSeconds;
  if (timeoutSeconds !== undefined && (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)) {
    refuse("timeoutSeconds", timeoutSeconds, "a positive number of seconds");
  }
  const maxRetries = generation.maxRetries;
  if (maxRetries !== undefined && (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > MAX_RETRIES)) {
    refuse("maxRetries", maxRetries, `a whole number of re-requests from 0 to ${MAX_RETRIES}`);
  }
  // Both of these count the work a build does, so a zero of either asks for
  // none: it is a typo, and reporting it later as a model that produced no
  // candidate sent looking for a provider problem where there was none.
  for (const setting of ["maxCandidates", "maxAttempts"] as const) {
    const value = generation[setting];
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
      refuse(setting, value, "a whole number of at least 1");
    }
  }
}

/** A model request is only bounded when the project asks for a budget. */
function requestTimeoutMs(input: SourceInput): number | undefined {
  const seconds = input.generation?.timeoutSeconds;
  return seconds === undefined ? undefined : seconds * 1000;
}

/** The prompts a build sends, for `--debug`. Diagnostics belong on stderr. */
function printPrompt(dump: PromptDump): void {
  // The artifact is named as well as the attempt: a build reviews the IR of
  // every candidate and then the target of the one it selected, and both are
  // asked for by the same candidate and round.
  const at = `${dump.stage} ${dump.candidate}.${dump.attempt}`;
  process.stderr.write(
    `\n-- prompt ${at}: system --\n${dump.system}\n-- prompt ${at}: user --\n${dump.user}\n`,
  );
}

/**
 * What a model answered with, for `--debug`. Only the answers that were not
 * reviews are printed: a refusal names a line of one of them, and a reply the
 * compiler could read is already in the build log as the verdicts and the
 * proposals that came out of it.
 */
function printAnswer(dump: AnswerDump): void {
  const at = `${dump.stage} ${dump.candidate}.${dump.attempt} request ${dump.retry}`;
  // An answer that was nothing at all is printed as nothing: a retry line reads
  // the same whether the model wrote an essay or a single space.
  const quoted = quoteReply(dump.answer);
  process.stderr.write(`\n-- answer ${at} --\n${quoted.length === 0 ? "(nothing)" : quoted.join("\n")}\n`);
}

function testConfigFor(input: SourceInput, options: BuildOptions): TestConfig {
  return {
    randomCases: options.randomCases ?? input.test?.randomCases ?? DEFAULT_TEST.randomCases,
    maxLength: options.maxLength ?? input.test?.maxLength ?? DEFAULT_TEST.maxLength,
    seed: input.test?.seed ?? DEFAULT_TEST.seed,
  };
}

function generationConfigFor(input: SourceInput, options: BuildOptions): GenerationConfig {
  return {
    maxCandidates: options.maxCandidates ?? input.generation?.maxCandidates ?? DEFAULT_GENERATION.maxCandidates,
    maxAttempts: options.maxAttempts ?? input.generation?.maxAttempts ?? DEFAULT_GENERATION.maxAttempts,
    maxRetries: options.maxRetries ?? input.generation?.maxRetries ?? DEFAULT_GENERATION.maxRetries,
    candidateConcurrency:
      options.candidateConcurrency ?? input.generation?.candidateConcurrency ?? DEFAULT_GENERATION.candidateConcurrency,
    functionConcurrency:
      options.functionConcurrency ?? input.generation?.functionConcurrency ?? DEFAULT_GENERATION.functionConcurrency,
    timeoutSeconds: input.generation?.timeoutSeconds ?? DEFAULT_GENERATION.timeoutSeconds,
  };
}

async function writeBuildRecord(store: JsonStore, paths: ProjectPaths, build: BuildStatus): Promise<void> {
  await store.write(paths.build, build);
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
  const units: readonly (readonly [string, number])[] = [
    ["minute", 60],
    ["hour", 3600],
    ["day", 86400],
  ];
  for (const [name, size] of units) {
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
  cause: unknown,
): Promise<CompilerError> {
  const failure = toCompilerError(cause, { category: "InputError", stage: "input" });
  const error = new CompilerError({ ...failure.toJSON(), project: id });
  const stamp = new Date().toISOString();
  // The engine is this one, not the last build's: the record says which
  // compiler rejected the project, and a record written before this compiler
  // existed has nothing to compare a later build against.
  const engine = engineStamp(await toolchainFingerprints());
  await writeBuildRecord(store, paths, {
    id,
    input: paths.input,
    contract: paths.contract,
    target: previous?.target ?? normalizeTarget(undefined),
    status: "failed",
    outputKind: previous?.outputKind ?? "machine",
    backend: previous?.backend ?? "c",
    mode: previous?.mode ?? "debug",
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
  return {
    objectNames: phase.objectNames,
    functions: Object.fromEntries(phase.program.files.flatMap((file) => Object.entries(file.functions))),
    language: phase.program.language,
  };
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
  wholeElementArithmetic(driver.bodies, driver.entry, vectorChecked(contractsByName(program.files)));
  return driver;
}

function semanticFunctions(
  program: ProgramContract,
  objectNames: Record<string, string>,
  body: ProgramBody | undefined,
  objectLayouts: Record<string, ObjectLayout>,
  objectKeys: LiteralKeys,
): Record<string, SemanticFunction> {
  const context: FunctionContext = {
    objectNames,
    functions: Object.fromEntries(program.files.flatMap((file) => Object.entries(file.functions))),
    language: program.language,
  };
  const resolved: Record<string, SemanticFunction> = {};
  for (const file of program.files) {
    for (const contract of Object.values(file.functions)) {
      resolved[contract.function.name] = resolveFunction(contract, context);
    }
  }
  // What a buffer of a program holds is a question about every write into it and
  // every call site of every function that is handed one, so the arithmetic of a
  // loop over whole numbers is settled here rather than by a per-function pass:
  // it is asked of these bodies, which are the ones every backend is handed.
  if (body !== undefined) {
    wholeElementArithmetic(
      Object.values(resolved),
      resolveProgram(body, program, objectNames, objectLayouts, objectKeys).entry,
      vectorChecked(contractsByName(program.files)),
    );
  }
  // Every body is resolved before any of them is checked, because a function is
  // checked against the others: a loop marked parallel is proved against what
  // the functions it calls write, and that is a question about the program.
  const callees = new Map(Object.entries(resolved));
  for (const file of program.files) {
    for (const [name, contract] of Object.entries(file.functions)) {
      // A function is checked before it is shown to anything, so a function
      // that is not one a backend may lower never reaches a model.
      validateSemanticFunction(resolved[name], contract, callees);
    }
  }
  return resolved;
}

/** What generation produced for one function of a build. */
interface UnitGeneration {
  unit: CompilationUnit;
  result: CodegenResult;
}

/**
 * The functions a build compiles. A program compiles every function the program
 * exports, because every one of them is something the program may call; a
 * library entry compiles the one function the project named.
 */
function compilationUnits(program: ProgramContract, isProgram: boolean): CompilationUnit[] {
  const units: CompilationUnit[] = [];
  for (const file of program.files) {
    for (const [name, contract] of Object.entries(file.functions)) {
      if (!isProgram && !(program.entry.file === file.path && program.entry.function === name)) continue;
      units.push({ file: file.path, contract, parsed: parseContract(contract) });
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
    const selected = entry.result.selected;
    if (selected === null || selected === undefined) continue;
    const name = entry.unit.contract.function.name;
    const text = await readFile(join(base, name, `${selected}.ir`), "utf8");
    const fn = parseSemanticFunction(text, program);
    functions.push({ fn, contract: entry.unit.contract });
    known.add(fn.symbol);
  }
  for (const body of driver.bodies) {
    if (known.has(body.symbol)) continue;
    functions.push({ fn: body });
    known.add(body.symbol);
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
    const name = unit.contract.function.name;
    const fn = semantics[name];
    if (fn === undefined) continue;
    const refusal = machineRefusal({
      fn: optimizeSemanticFunction(structuredClone(fn), callees),
      contract: unit.contract,
      callable: callableSymbols(unit.contract, contracts),
      target,
    });
    if (refusal !== null) return { function: name, reason: refusal.reason, detail: refusal.detail };
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
  return (
    type.kind === "primitive" ||
    type.kind === "ptr" ||
    type.kind === "slice" ||
    type.kind === "array" ||
    type.kind === "void"
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
  const callable = new Set<string>([
    ...driver.bodies.map((body) => body.symbol),
    ...driver.functions.map((signature) => signature.symbol),
  ]);
  // A body a contracted function covers is compiled as that function's own
  // object, so the backend was asked about it already.
  const lowered = new Set<string>(
    driver.bodies.filter((body) => !covered.has(body.name)).map((body) => body.symbol),
  );
  const notes: string[] = [];
  for (const body of driver.bodies) {
    if (!lowered.has(body.symbol)) continue;
    const refusal = machineRefusal({ fn: body, callable, target });
    if (refusal !== null) {
      lowered.delete(body.symbol);
      notes.push(
        `the machine backend refused to lower ${body.name} (${refusal.reason}); the driver keeps its C`,
      );
      if (refusal.detail !== undefined && refusal.detail.trim() !== "") notes.push(refusal.detail.trim());
    }
  }  // A call between one side and the other is the boundary, and it decides both
  // sides together: every body that calls across an incompatible edge is
  // lowered by the same backend as the callee is.
  let moved = true;
  while (moved) {
    moved = false;
    for (const edge of callsWithin(driver)) {
      if (lowered.has(edge.caller) === lowered.has(edge.callee)) continue;
      const callee = driver.bodies.find((body) => body.symbol === edge.callee);
      if (callee === undefined) continue;
      const incompatible = !crossesBackends(callee.returns) || callee.params.some((param) => !crossesBackends(slotType(param)));
      if (!incompatible) continue;
      const dropped = lowered.has(edge.caller) ? edge.caller : edge.callee;
      if (lowered.delete(dropped)) {
        moved = true;
        const partner = dropped === edge.caller ? edge.callee : edge.caller;
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
      .filter((edge) => lowered.has(edge.caller) && !lowered.has(edge.callee))
      .map((edge) => edge.callee),
  );
  return { lowered, visible, notes, callable };
}

/**
 * Every call one function of a program makes of another, with the name of the
 * function that makes it: the edges of a boundary the two backends share.
 */
function callsWithin(program: SemanticProgram): { caller: string; callee: string }[] {
  const edges: { caller: string; callee: string }[] = [];
  for (const body of program.bodies) {
    for (const callee of directCalleesOf(body.entry)) edges.push({ caller: body.symbol, callee });
  }
  for (const callee of directCalleesOf(program.entry)) edges.push({ caller: "", callee });
  return edges;
}

/** Every function name a body or the program's own statements call directly. */
function directCalleesOf(block: SemanticBlock): string[] {
  const names: string[] = [];
  const visit = (visited: SemanticBlock): void => {
    for (const statement of visited.statements) {
      for (const value of statementValues(statement)) {
        walkValues(value, (inner) => {
          if (inner.k === "call") names.push(inner.call.callee);
          if (inner.k === "functionRef") names.push(inner.name);
        });
      }
      if (statement.k === "call") names.push(statement.call.callee);
      for (const inner of statementBlocksOf(statement)) visit(inner);
    }
    // A block ends in a terminator, and the value a return hands back is a value
    // the block computes: the call of a closure a body ends with is the call a
    // boundary between the backends has to be read from, so the walk of a block
    // reaches it the way it reaches every statement's values.
    if (visited.terminator.k === "return" && visited.terminator.value !== null) {
      walkValues(visited.terminator.value, (inner) => {
        if (inner.k === "call") names.push(inner.call.callee);
        if (inner.k === "functionRef") names.push(inner.name);
      });
    }
  };
  visit(block);
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
  throw new CompilerError({
    category: "InputError",
    stage: "input",
    message: "a WebAssembly module cannot serve HTTP requests",
    detail:
      "the host ABI of a wasm module carries the runtime services the module imports, and a server is not one " +
      "of them; build the program with another output kind",
  });
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
    return parseSemanticFunction(text, program).calls.some((edge) => callable.has(edge.callee));
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
  const { entry, keys, required } = request;
  if (entry === undefined || entry.reviewKey !== keys.review) {
    if (!required) return { level: null, entry: undefined, missing: [] };
    throw new CompilerError({
      category: "StorageError",
      stage: "reuse",
      message:
        entry === undefined
          ? `no stored implementation to reuse for ${request.functionName}`
          : `the stored implementation of ${request.functionName} was reviewed from different inputs`,
      detail:
        entry === undefined
          ? `nothing is stored for ${request.id}; run blaze build without --reuse to build it`
          : "its contract, the functions it is linked against, the target, the options, the model or the compiler's own review of a function changed; run blaze build without --reuse to build it again",
    });
  }
  // The stored candidate's own IR decides which files it produced: one that
  // calls a function of the program is never linked on its own, so its
  // executable is a file no build ever writes and demanding it would make
  // every such function a cache miss for the life of the project. An entry a
  // build cannot read is treated as one that links on its own, so a corrupt
  // record costs the files that are genuinely there and is rebuilt otherwise.
  const stored = entry.candidates.find((candidate) => candidate.id === entry.selected);
  const missing = reusableFiles(
    request.workspace,
    entry.selected,
    request.output,
    request.lowering,
    request.linksObjects,
    stored === undefined || !callsOutOfProgram(stored.text, request.program, request.callable),
  ).filter((file) => !existsSync(file));
  return { level: reusable(entry, keys, missing.length === 0), entry, missing };
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
  if (body.file !== INLINE_MODULE) return { path: resolve(project.directory, body.file) };
  // The source is written under the name its own toolchain runs it by: a
  // Python source is run by python3, which reads a file of any name, and the
  // name is what says what the source is.
  const extension = language.toLowerCase() === "python" ? "py" : "ts";
  const path = `${base}/${id}.program.${extension}`;
  await writeFile(path, project.entry.source, "utf8");
  return { path };
}

/**
 * What a round of the program loop found, in the words the build log uses: the
 * line the two outputs part on, or how the program stopped before they could.
 */
function describeProgramFailure(mismatch: ProgramMismatch | undefined): string {
  if (mismatch?.failure !== undefined) {
    const printed =
      mismatch.actualOutput === "" ? "printed nothing" : `printed ${mismatch.actualOutput.split("\n").length} line(s) and then stopped`;
    return `${mismatch.failure}: it ${printed}, where the source prints ${JSON.stringify(mismatch.expected)} on line ${mismatch.line}`;
  }
  return `the program does not print what the source prints: line ${mismatch?.line}, the source prints ${JSON.stringify(mismatch?.expected)}, the program prints ${JSON.stringify(mismatch?.actual)}`;
}

export async function runBuild(
  inputPath: string,
  options: BuildOptions,
  reporter: Reporter,
  mode: "build" | "generate",
): Promise<BuildOutcome> {
  const store = createJsonStore(join(options.cwd, STATE_DIRECTORY));
  const absoluteInput = resolve(options.cwd, inputPath);
  const id = projectIdFor(absoluteInput);
  const paths = projectPaths(id, projectStoreId(absoluteInput));

  // These read the project and reject it before there is a build record to
  // reject it in, so a project that no longer names a build that can run used
  // to fail with the last successful build still on record: every reader of
  // the project was told the last thing it did succeeded.
  // A record that is not JSON is no record at all, exactly as the incremental
  // cache is not: a build that cannot parse what the last one said goes on to
  // build, and a project that failed on a corrupt record had no way back short
  // of deleting the file by hand. A record that cannot be read is a different
  // thing, and is a fault: going on to build would overwrite it.
  const previousBuild = await store.readIfValid<BuildStatus>(paths.build);
  let project: ProjectInput;
  let target: TargetSpec;
  let outputKind: OutputKind;
  let runtimeKind: RuntimeKind;
  let backendKind: BackendKind;
  let buildMode: BuildMode;
  let usesSqlite = false;
  try {
    project = readInput(absoluteInput);
    const input = project.input;
    assertGenerationInput(absoluteInput, input);
    target = assertBuildableTarget(normalizeTarget(input.target), input.entry);
    outputKind = resolveOutputKind(options.output ?? input.output);
    runtimeKind = resolveRuntimeKind(options.runtime ?? input.runtime, outputKind);
    // HTTP programs need the facil runtime even when the user did not ask for
    // it: the generated code references blaze_http_* symbols.
    if (runtimeKind === "none" && /\bhttp\b/.test(project.entry.source)) runtimeKind = "facil";
    // A program that uses SQLite links the SQLite library beside the runtime
    // it runs on. A wasm module links no library at all, and a program hosted
    // by Nim is lowered by the host's own emitter, which knows no library, so
    // both are refused here rather than failing later at the link.
    usesSqlite = usesSqliteSource(project.entry.source);
    if (usesSqlite && outputKind === "wasm") {
      throw new CompilerError({
        category: "InputError",
        stage: "input",
        message: "a WebAssembly module cannot use SQLite",
        detail: "a wasm module links no library; build it with --output machine, or drop the SQLite calls",
      });
    }
    if (usesSqlite && runtimeKind === "nim") {
      throw new CompilerError({
        category: "InputError",
        stage: "input",
        message: "a program hosted by Nim cannot use SQLite",
        detail: "the Nim host links the runtime and no library; build it with --runtime none, or drop the SQLite calls",
      });
    }
    backendKind = resolveBackend(options.backend ?? input.backend, outputKind);
    buildMode = resolveBuildMode(options.mode ?? input.mode);
  } catch (cause) {
    throw await recordRejected(store, paths, id, previousBuild, cause);
  }

  // The mode is the first thing a build says, before it names the model or
  // resolves anything: it is the one setting that changes what the generated
  // program carries, and it is chosen here, so a reader is told what was
  // selected before anything built can be looked at.
  reporter.stage("mode", "info", `Mode: ${buildMode} (${optimizationOptions(buildMode).join(" ")})`);
  const input = project.input;

  // --model wins over the project file, which wins over AI_MODEL.
  const requested = options.model ?? modelSpec(input.model, absoluteInput);
  // Whether a model is configured at all, the same reading resolveModel
  // makes. A build with none still runs: it lowers the IR the rules resolved
  // and verified, and reviews nothing.
  const modelRequested = (requested ?? process.env.AI_MODEL ?? "") !== "";
  // A generate exists to show what a model made of the IR, so with none
  // configured there is nothing to show: it refuses rather than handing back
  // the IR as it stands under a generate's name.
  if (mode === "generate" && !modelRequested) {
    throw await recordRejected(
      store,
      paths,
      id,
      previousBuild,
      new CompilerError({
        category: "InputError",
        stage: "input",
        message: "generate asks a model",
        detail: "set AI_MODEL or pass --model provider/model; blaze build runs the rules alone without one",
      }),
    );
  }
  // A reused build is answered by the model that reviewed the stored candidate,
  // so that is the model to name.
  const modelName = options.reuse ? previousBuild?.model : (requested ?? process.env.AI_MODEL);
  // The model is part of every answer this compiler gives, so it is named
  // before anything can fail, including a model that cannot be reached.
  reporter.stage("model", "info", `Model: ${modelName ?? "(unset)"}`);

  // The engine is read before anything is written, because a build that is
  // going to stop must stop without having touched the record of the last one.
  const toolchain = await toolchainFingerprints();
  const engine = engineStamp(toolchain);
  // A record written by a different engine is a proof about a compiler that
  // no longer exists, and every function in it has to be asked for again, so
  // it is the one change that costs a build its whole cache. It is announced
  // and, on a terminal, confirmed: the question is what a person can answer
  // and a script cannot, and a build that has no way to ask answers for
  // itself. `--recompile` is the same answer given in advance.
  const previousEngine = previousBuild?.engine;
  const engineChanged = previousEngine !== undefined && previousEngine !== engine;
  if (engineChanged && options.reuse !== true) {
    reporter.stage(
      "engine",
      "info",
      `Engine changed: ${previousEngine} -> ${engine} (last build ${agoFrom(previousBuild?.updatedAt)})`,
    );
    reporter.stage(
      "engine",
      "info",
      "The stored objects were built by different rules, so every function is reviewed again from the semantic IR",
    );
    if (options.recompile !== true && options.confirm !== undefined) {
      const recompile = await options.confirm("Recompile every function from scratch? [y/N] ");
      if (!recompile) {
        throw new CompilerError({
          category: "CancelledError",
          stage: "engine",
          message: `the engine changed (${previousEngine} -> ${engine}) and the recompile was declined`,
          detail: "nothing was built and the last build is still the project's; run blaze build --recompile to rebuild it",
        });
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
  const discardStored = options.recompile === true || (engineChanged && options.reuse !== true);

  await store.mkdirp(paths.root);
  await store.mkdirp(paths.work);
  if (options.recompile === true) {
    try { await store.remove(join(paths.work, "program.c")); } catch {}
  }
  await store.mkdirp(paths.output);
  // The project is stored as the record the rest of the compiler reads, which
  // is JSON whatever the project file is, so `blaze test` and `blaze benchmark`
  // re-run a build against the project it was given.
  await store.write(paths.input, input);

  const createdAt = new Date().toISOString();
  const build: BuildStatus = {
    id,
    input: paths.input,
    contract: paths.contract,
    target,
    status: "building",
    outputKind,
    backend: backendKind,
    mode: buildMode,
    runtime: runtimeKind,
    createdAt,
    updatedAt: createdAt,
    sourceHash: "",
    contractHash: "",
    model: modelName ?? "unset",
    modelConfig: modelName ?? previousBuild?.modelConfig ?? "unset",
    compilerVersion: COMPILER_VERSION,
    engine,
    // The flag is the record of a build that was told to recompile. An engine
    // change that forced one is already visible as the stamp, which moved.
    ...(options.recompile === true ? { recompiled: true } : {}),
  };
  await writeBuildRecord(store, paths, build);

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
      build.model = resolvedModel.id;
      build.modelConfig = resolvedModel.id;
    }
    return resolvedModel;
  };


  try {
    // The contract phase comes first and asks no model: every file of the
    // program is read, contracted and validated before any target code exists.
    const phase = runContractPhase({
      frontend: frontendFor(input.language),
      input,
      entry: project.entry,
      read: moduleReader(project.directory),
    });
    const program = phase.program;
    const units = compilationUnits(program, phase.body !== undefined);
    const semantics = semanticFunctions(program, phase.objectNames, phase.body, phase.objectLayouts, phase.objectKeys);
    // The IR of every function is resolved and checked here, before a model is
    // asked for anything: a function no backend may lower never reaches one.
    reporter.stage(
      "ir",
      "ok",
      `Semantic IR: ${Object.keys(semantics).length} function(s) resolved and validated, ${Object.values(semantics).reduce((total, fn) => total + fn.ensures.length, 0)} postcondition(s) to check them against`,
    );
    const sourceHash = hashValue(phase.modules.map((module) => [module.path, module.source]));
    build.sourceHash = sourceHash;
    build.contractHash = hashValue(program);
    await store.write(paths.contract, program);
    reporter.stage(
      "contract",
      "ok",
      phase.body === undefined
        ? `Program contract: ${program.files.length} file(s), ${contractedFunctionCount(program)} contracted function(s), entry ${String(program.entry.function)} in ${program.entry.file}`
        : `Program contract: ${program.files.length} file(s), ${units.length} compiled function(s), program ${program.entry.file}`,
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
      phase.body === undefined
        ? undefined
        : optimizeSemanticProgram(
            resolvedDriver(phase.body, program, phase.objectNames, phase.objectLayouts, phase.objectKeys),
          );
    // The IR is checked here, before a toolchain is asked for anything: a
    // program no backend may lower never reaches gcc, nim or a linker.
    if (driver !== undefined) {
      validateSemanticProgram(driver, undefined, new Map(driver.bodies.map((fn) => [fn.name, fn])));
      reporter.stage("ir", "ok", "Program IR: the program is resolved and validated");
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
      const refusal = machineRefusalOf(units, semantics, contractsByName(program.files), target);
      if (refusal !== null) {
        reporter.stage(
          "assemble",
          "info",
          `The machine backend refused to lower ${refusal.function} (${refusal.reason}); the C backend is used instead`,
        );
        if (refusal.detail !== undefined && refusal.detail.trim() !== "") {
          reporter.stage("assemble", "info", refusal.detail.trim());
        }
        backendKind = "c";
        build.backend = "c";
        build.backendFallback = { function: refusal.function, reason: refusal.reason };
      } else if (driver !== undefined) {
        // Every function the program declares for itself is lowered the same
        // way the functions a candidate implements are: into an object the
        // driver links beside itself. What the backend refused stays in the
        // driver, and so does everything whose call to it would hand over
        // what only one convention carries.
        bodyLowering = programLoweringOf(driver, new Set(units.map((unit) => unit.contract.function.name)), target);
        for (const note of bodyLowering.notes) reporter.stage("assemble", "info", note);
      }
    }
    await writeBuildRecord(store, paths, build);

    assertAssemblerSupportsArch(target);
    if (phase.body !== undefined) assertProgramOutput(outputKind, project.entry.source);

    // What an earlier build proved per function. It is read before this build
    // writes to it, and it is written as each function is proved, so a build
    // that fails on a later function still leaves the earlier ones reusable.
    // A recompile reads it as empty, so nothing earlier is reused and every
    // function is asked for again: what this build proves is still recorded,
    // which is the point of recompiling rather than of forgetting.
    const incremental = discardStored
      ? (Object.create(null) as IncrementalRecord)
      : await readIncremental(store, paths.incremental);
    const base = store.resolve(paths.work);
    // What every function of this build was compiled against, so nothing is
    // reused across a change of contract, target, options or model.
    const test = testConfigFor(input, options);
    const benchmarkConfig = { iterations: input.benchmark?.iterations ?? DEFAULT_BENCHMARK.iterations };
    // A program links the object of every function it calls, and running it is
    // what proves the functions it is the only oracle for. A build that stops
    // at candidate selection has no program to link or to run, and so has no
    // proof to record for those functions either.
    const checksProgram = phase.body !== undefined && mode === "build";
    // Which model an implementation came from is part of what it is, so asking
    // for a different one rebuilds. A build that names no model reuses what the
    // last build used rather than invalidating everything for want of a name.
    const modelKey = options.reuse
      ? (previousBuild?.model ?? "unset")
      : (requested ?? process.env.AI_MODEL ?? previousBuild?.model ?? "unset");
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
        contract: unit.contract,
        file: unit.file,
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
        review: toolchain.review,
        lowering: toolchain.lowering,
      });
    // One runtime for the whole build: every candidate of every function links
    // the same one, and the driver that runs the program links it too. The
    // HTTP runtime is built for the program that is being built: how many
    // connections its server may hold, and whether it speaks TLS.
    const http = httpRuntimeNeeds(phase.body, [...phase.modules.map((module) => module.source), project.entry.source]);
    const prepareRuntime = runtimePreparer({
      lowering: backendKind,
      mode: buildMode,
      runtime: runtimeKind,
      target,
      workspace: { workDirectory: base, functionName: program.entry.file },
      libraries: usesSqlite ? ["sqlite"] : [],
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
    const records = {
      run<T>(task: () => T | Promise<T>): Promise<T> {
        const next = writing.then(task, task);
        writing = next.then(
          () => {},
          () => {},
        );
        return next;
      },
    };
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
    const contracts = contractsByName(program.files);

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
        const functionName = unit.contract.function.name;
        const entry = awaitingProgram.get(functionName) ?? incremental[functionName];
        if (entry !== undefined) proved[functionName] = entry;
      }
      await store.write(paths.incremental, proved);
    };

    // What a round of generation produced, by function. A repair round replaces
    // only the units it regenerates, so a program is never half rebuilt.
    const generatedByFunction = new Map<string, UnitGeneration>();
    const unitsGenerated = (): UnitGeneration[] =>
      units.flatMap((unit) => {
        const entry = generatedByFunction.get(unit.contract.function.name);
        return entry === undefined ? [] : [entry];
      });
    /** How many candidates a unit has written, so a round names new ones. */
    const written = new Map<string, number>();

    /** The implementation a unit contributed to the program that mismatched. */
    const implementationOf = (functionName: string): string | undefined => {
      const entry = generatedByFunction.get(functionName);
      const selected = entry?.result.selected;
      if (entry === undefined || selected === null || selected === undefined) return undefined;
      return entry.result.candidates.find((candidate) => candidate.id === selected)?.text;
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
      const functionName = unit.contract.function.name;
      const previous = mismatch === undefined ? undefined : implementationOf(functionName);
      if (mismatch !== undefined && (unit.contract.ensures.length > 0 || previous === undefined)) return;
      const workspace = { workDirectory: `${base}/${functionName}`, functionName };
      await mkdir(workspace.workDirectory, { recursive: true });
      const keys = keyOf(unit);
      const reuse = unitReuse({
        entry: incremental[functionName],
        keys,
        workspace,
        functionName,
        output: outputKind,
        lowering: backendKind,
        linksObjects: checksProgram,
        program,
        callable: callableSymbols(unit.contract, contracts),
        required: options.reuse,
        id,
      });
      const sequenceStart = written.get(functionName) ?? 0;

      if (mismatch === undefined && reuse.level === "object" && reuse.entry !== undefined) {
        const result = reusedResult(reuse.entry);
        // A repair round generates after the stored candidates, so it never
        // writes over the object this build is about to link.
        written.set(functionName, sequenceStart + result.candidates.length);
        reusedByFunction.set(functionName, reuse.entry.selected);
        generatedByFunction.set(functionName, { unit, result });
        return;
      }

      if (reuse.level === "assembly" && reuse.missing.length > 0) {
        reporter.stage(
          "reuse",
          "info",
          `${functionName} is rebuilt from its stored implementation: ${reuse.missing.map((file) => basename(file)).join(", ")} ${reuse.missing.length === 1 ? "is" : "are"} gone`,
        );
      }

      const result = await reviewCandidates({
        mode: buildMode,
        contract: unit.contract,
        unitFile: unit.file,
        parsed: unit.parsed,
        program,
        base: semantics[functionName] as SemanticFunction,
        functions: semantics,
        // A program is one module, so the functions a candidate calls are in
        // the module beside it. A build that compiles one function on its own
        // has nothing to hold beside it, and carries none.
        ...(phase.body === undefined ? {} : { programFunctions: Object.values(semantics) }),
        target,
        output: outputKind,
        lowering: backendKind,
        runtime: runtimeKind,
        // A build with no model configured runs the rules alone, so there is
        // no backend to build and nothing here to ask.
        ...(modelRequested
          ? {
              backend: () => {
                if (options.reuse) {
                  throw new CompilerError({
                    category: "StorageError",
                    stage: "reuse",
                    message: `the stored implementation of ${functionName} no longer satisfies its contract`,
                    detail: "run blaze build without --reuse to review it again",
                  });
                }
                return createBackend(requireModel(), {
                  timeoutMs: requestTimeoutMs(input),
                  retries: generation.maxRetries,
                  onRetry: ({ stage, candidate, attempt, retry, retries, reason, stop, answer }) => {
                    // An answer that could not be read is also told how its request
                    // ended and what the request cost: one cut short by the output
                    // limit, one a content filter took and one the model finished on
                    // its own are not the same failure to wait out, and a gateway
                    // that reports the tokens is the only place they are counted.
                    const finish = stop === undefined ? "" : `, ${describeProviderStop(stop)}`;
                    reporter.stage(
                      "review",
                      "info",
                      `Asking again: ${functionName}, ${stage} of candidate ${candidate}, round ${attempt}, ${reason}${finish}; request ${retry} of ${retries}, waiting for ${modelName ?? "(unset)"}`,
                    );
                    // What the model wrote is not a line of the build log: a refusal
                    // names a line of it, so it is the only way to see the answer the
                    // refusal is about. It is printed beside the prompt, under the
                    // same `--debug`.
                    if (options.debug === true && answer !== undefined) {
                      printAnswer({ stage, candidate, attempt, retry, answer });
                    }
                  },
                  ...(options.debug === true ? { onPrompt: printPrompt } : {}),
                });
              },
            }
          : {}),
        generation,
        test,
        benchmark: benchmarkConfig,
        prepareRuntime,
        workspace,
        callable: callableSymbols(unit.contract, contracts),
        machine: machines,
        // A repair round asks the model again, so what an earlier build stored
        // is not what it starts from. Otherwise the stored implementation is
        // tried first, and a model is asked only when it does not satisfy the
        // contract.
        existing: mismatch === undefined && reuse.level !== null ? (reuse.entry?.candidates ?? []) : [],
        sequenceStart,
        ...(mismatch === undefined || previous === undefined
          ? {}
          : { programFailure: { mismatch, previous } }),
        onNote: (note) => {
          reporter.stage("review", "info", `${functionName}: ${note}`);
        },
        onReview: ({ stage, candidate, candidates, attempt, attempts }) => {
          reporter.stage(
            "review",
            "info",
            `Reviewing the ${stage === "ir" ? "semantic IR" : implementationLabel(outputKind)}: ${functionName}, candidate ${candidate} of ${candidates}, round ${attempt} of ${attempts}, waiting for ${modelName ?? "(unset)"}`,
          );
        },
      });
      written.set(functionName, sequenceStart + result.candidates.length);
      reusedByFunction.delete(functionName);
      generatedByFunction.set(functionName, { unit, result });

      // A function is proved by its own vectors, or by the program it is
      // part of, so an entry is only written once something has said so.
      const selected = result.selected;
      if (selected === null) return;
      const entry: IncrementalEntry = {
        reviewKey: keys.review,
        objectKey: keys.object,
        file: unit.file,
        selected,
        candidates: result.candidates,
        outcomes: result.outcomes,
        benchmarkVector: result.benchmarkVector,
      };
      const verified = result.outcomes.find((outcome) => outcome.candidate === selected)?.verification !== undefined;
      if (verified) {
        incremental[functionName] = entry;
        // The record is a whole file that every function adds itself to, so
        // two functions finishing together would each read the record before
        // the other wrote it, and one entry would be lost. One writer at a
        // time costs nothing: this is a write of a few kilobytes, and the
        // functions it is waiting for are still waiting on a model.
        await records.run(() => store.write(paths.incremental, { ...incremental }));
      } else if (checksProgram) {
        awaitingProgram.set(functionName, entry);
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
      const workers = Math.max(1, Math.min(generation.functionConcurrency, units.length));
      // A function that fails outright fails the build, so every worker is
      // allowed to settle before the first failure is reported: a function
      // still being generated must not go on writing work files after the
      // build has given up on it.
      const settled = await Promise.allSettled(Array.from({ length: workers }, () => worker()));
      const failure = settled.find((entry) => entry.status === "rejected");
      if (failure !== undefined && failure.status === "rejected") throw failure.reason;
    };

    /** What every unit generated so far, as the build records it. */
    const record = async (): Promise<Record<string, string>> => {
      const generated = unitsGenerated();
      // Keyed by whatever the source named the function, so these are built
      // from entries rather than assigned into: a function called `__proto__`
      // would otherwise replace the prototype of the record instead of adding
      // an entry, and the record this build writes out would be missing it.
      const candidateEntries: (readonly [string, Candidate[]])[] = [];
      const verificationEntries: (readonly [string, VerificationResult[]])[] = [];
      const benchmarkEntries: (readonly [string, BenchmarkResult[]])[] = [];
      const selectedEntries: (readonly [string, string])[] = [];
      for (const entry of generated) {
        const functionName = entry.unit.contract.function.name;
        candidateEntries.push([functionName, entry.result.candidates]);
        verificationEntries.push([
          functionName,
          entry.result.outcomes
            .map((outcome) => outcome.verification)
            .filter((outcome): outcome is VerificationResult => outcome !== undefined),
        ]);
        benchmarkEntries.push([
          functionName,
          entry.result.outcomes
            .map((outcome) => outcome.benchmark)
            .filter((outcome): outcome is BenchmarkResult => outcome !== undefined),
        ]);
        const valid = entry.result.outcomes.filter((outcome) => outcome.valid).length;
        reporter.stage(
          "review",
          valid > 0 ? "ok" : "fail",
          `${implementationLabel(outputKind)} for ${functionName}: ${entry.result.candidates.length} candidate(s), ${valid} valid`,
        );
        // What ships is what the toolchain built and verified, so a function
        // with no valid candidate stops the build before anything is delivered.
        if (entry.result.selected === null) {
          const detail = entry.result.outcomes
            .map(
              (outcome) =>
                `${outcome.candidate}: ${outcome.failure?.category ?? ""} ${outcome.failure?.message ?? ""}\n${outcome.failure?.detail ?? ""}`,
            )
            .join("\n");
          throw new CompilerError({
            category: "VerificationError",
            stage: "verify",
            message: `no candidate for ${functionName} satisfied the contract`,
            function: functionName,
            detail: detail.trim(),
          });
        }
        selectedEntries.push([functionName, entry.result.selected]);
      }
      const candidates = byName(candidateEntries);
      const verification = byName(verificationEntries);
      const benchmark = byName(benchmarkEntries);
      const selected = byName(selectedEntries);
      await store.write(paths.candidates, candidates);
      await store.write(paths.generation, {
        model: build.model,
        modelConfig: build.modelConfig,
        compilerVersion: COMPILER_VERSION,
        functions: Object.fromEntries(
          generated.map((entry) => [
            entry.unit.contract.function.name,
            {
              file: entry.unit.file,
              selected: entry.result.selected,
              benchmarkVector: entry.result.benchmarkVector,
              outcomes: entry.result.outcomes,
            },
          ]),
        ),
        modelDurationNs: String(
          generated.reduce((total, entry) => total + entry.result.modelDurationNs, 0n),
        ),
      });
      await store.write(paths.verification, verification);
      await store.write(paths.benchmark, benchmark);
      return selected;
    };

    // A function whose contract states what it does is not checked on its own:
    // the program it belongs to is the only oracle it has, and only a build has
    // that program. So a build generates, links and runs, and generates again
    // with what the program printed until the two agree or the rounds run out.
    const programRounds =
      phase.body === undefined || mode !== "build" || options.reuse ? 1 : PROGRAM_REPAIR_ROUNDS + 1;
    let checked: ProgramVerification | undefined;
    let mismatch: ProgramMismatch | undefined;
    let selected: Record<string, string> = {};
    const programFile = phase.body === undefined ? undefined : await programSource(base, id, project, phase.body, input.language);
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
      if (driver === undefined || programFile === undefined || mode !== "build") break;
      const runtime = await prepareRuntime();
      const objectPaths = unitsGenerated().map((entry) =>
        join(base, entry.unit.contract.function.name, `${entry.result.selected as string}.o`),
      );
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
      const loweredBodies = new Set<string>();
      if (backendKind === "machine" && bodyLowering !== undefined) {
        for (const body of driver.bodies) {
          if (!bodyLowering.lowered.has(body.symbol)) continue;
          const result = await buildMachineObject({
            fn: body,
            target,
            callable: bodyLowering.callable,
            objectPath: join(base, `${body.symbol}.o`),
          });
          objectPaths.push(result.objectPath);
          loweredBodies.add(body.symbol);
          if (result.threads && !threads.includes("pthread")) threads.push("pthread");
        }
      }
      if (programIsParallel(driver.entry, driver.bodies)) threads.push("openmp");
      for (const entry of unitsGenerated()) {
        const selected = entry.result.selected;
        if (selected === null) continue;
        for (const threading of entry.result.outcomes.find((outcome) => outcome.candidate === selected)?.threads ?? []) {
          if (!threads.includes(threading)) threads.push(threading);
        }
      }
      const isHttp = runtimeKind === "facil" || /\bhttp\b/.test(project.entry.source);
      const runner =
        backendKind === "wasm"
          ? (await buildProgramModule({
              // The module holds every function of the program: the candidate
              // that was chosen for each of them, and the body the program runs
              // as its entry.
              functions: await programFunctions(base, unitsGenerated(), program, driver),
              entry: driver.entry,
              modulePath: programModule,
              hostPath: programHost,
              language: input.language,
            })).runner
          : isHttp || runtimeKind === "none"
            ? await buildProgramDriver({
                objective: normalizeOptimize(input.optimize).primary,
                mode: buildMode,
                target,
                program: driver,
                workDirectory: base,
                objectPaths,
                loweredBodies: [...loweredBodies],
                // A body that stayed in the driver and is called by an object
                // is the definition the object's reference resolves to, so it
                // is written as a function the linker can see.
                sharedBodies: bodyLowering === undefined ? [] : [...bodyLowering.visible],
                ...(runtime === undefined ? {} : { runtimeObjectPath: runtime.objectPath }),
                includeHttpHeader: runtimeKind === "facil",
                lowering: backendKind,
                includeSqliteHeader: usesSqlite,
                tls: http.tls,
                libraryObjectPaths: (runtime?.libraryObjects ?? []).map((library) => library.objectPath),
                threads,
                outputPath: programPath,
              })
            : await buildProgramHost({
                mode: buildMode,
                program: driver,
                workDirectory: base,
                objectPaths,
                outputPath: programPath,
              });
      // The project may ask that the delivered program not be run at all: a
      // program that serves rather than prints, or one that cannot run where
      // it is built, has no output the build can compare, so it is delivered
      // as it was linked and what it prints later is not the build's to say.
      if (input.verifyProgram === false) break;
      checked = await verifyProgram({
        language: input.language,
        sourcePath: programFile.path,
        directory: project.directory,
        runner,
        arguments: options.arguments,
      });
      // A program that stopped is as repairable as one that printed the wrong
      // thing, so the rounds are spent on it rather than on ending the build.
      if (checked.passed) break;
      mismatch = checked.difference;
      if (round < programRounds) {
        reporter.stage("verify", "info", `${describeProgramFailure(mismatch)}; generating the functions it is the only oracle for again`);
      }
    }
    if (checked !== undefined && !checked.passed) {
      const difference = checked.difference;
      throw new CompilerError({
        category: "VerificationError",
        stage: "verify",
        message: difference?.failure ?? "the program does not print what the source prints",
        detail: [
          `line ${difference?.line}: the source prints ${JSON.stringify(difference?.expected)}, the program prints ${JSON.stringify(difference?.actual)}`,
          ...(difference?.failureOutput === undefined ? [] : [`the program wrote to standard error:\n${difference.failureOutput}`]),
        ].join("\n"),
      });
    }
    if (checked !== undefined) {
      reporter.stage(
        "verify",
        "ok",
        `Program output matches the source (${checked.actual.split("\n").filter((line) => line !== "").length} line(s))`,
      );
    } else if (driver !== undefined && mode === "build" && input.verifyProgram === false) {
      // A program whose output the project does not ask to check is delivered
      // without the comparison, and the build says so, rather than leaving the
      // absence of a verdict where a verdict would be.
      reporter.stage("verify", "ok", "Program output is not checked (verifyProgram = false)");
    }
    // The program has agreed with its source, so the functions it is the only
    // oracle for are proved now, and the record of what this build proved is
    // written whole.
    if (checked !== undefined) await prove();

    const generated = unitsGenerated();
    // Keyed by whatever the source named the function, so these are built from
    // entries for the reason `record` above spells out.
    const candidateEntries: (readonly [string, Candidate[]])[] = [];
    const verificationEntries: (readonly [string, VerificationResult[]])[] = [];
    const benchmarkEntries: (readonly [string, BenchmarkResult[]])[] = [];
    const outcomeEntries: (readonly [string, CandidateOutcome[]])[] = [];
    for (const entry of generated) {
      const functionName = entry.unit.contract.function.name;
      candidateEntries.push([functionName, entry.result.candidates]);
      outcomeEntries.push([functionName, entry.result.outcomes]);
      verificationEntries.push([
        functionName,
        entry.result.outcomes
          .map((outcome) => outcome.verification)
          .filter((outcome): outcome is VerificationResult => outcome !== undefined),
      ]);
      benchmarkEntries.push([
        functionName,
        entry.result.outcomes
          .map((outcome) => outcome.benchmark)
          .filter((outcome): outcome is BenchmarkResult => outcome !== undefined),
      ]);
      const outcome = entry.result.outcomes.find((entry2) => entry2.candidate === entry.result.selected);
      if (reusedByFunction.has(functionName)) {
        // Nothing was assembled or run for this function: what it delivered is
        // what an earlier build built, linked and verified for these inputs.
        reporter.stage(
          "assemble",
          "ok",
          `${implementationLabel(outputKind)} for ${functionName} was not rebuilt: candidate ${outcome?.candidate ?? entry.result.selected} is reused from the build that verified it`,
        );
        continue;
      }
      reporter.stage("assemble", "ok", `${implementationLabel(outputKind)} built into a testable implementation`);
      if (outcome?.verification === undefined) {
        // A function whose contract states what it does rather than what it
        // returns has no vector to run, so nothing was verified here. The
        // program it belongs to is what says whether the two agree.
        reporter.stage("verify", "info", `${functionName} returns no value to verify, so the program it is part of is what checks it`);
        continue;
      }
      reporter.stage(
        "verify",
        "ok",
        `Correctness verified for ${functionName} (${outcome.verification.cases} test vectors, tolerance ${outcome.verification.tolerance ?? "exact"})`,
      );
      reporter.stage(
        "benchmark",
        "ok",
        `Benchmark completed for ${functionName} (${outcome.benchmark?.iterations ?? 0} iterations, ${outcome.benchmark?.durationNs ?? 0} ns)`,
      );
    }
    const candidates = byName(candidateEntries);
    const verification = byName(verificationEntries);
    const benchmark = byName(benchmarkEntries);
    const outcomes = byName(outcomeEntries);

    let outputPath: string | null = null;
    let outputAssemblyPath: string | null = null;
    if (mode === "build") {
      const delivered: string[] = [];
      // A file that is replaced may be the file of a program that is still
      // running: a rebuild while the old binary serves is the usual way round,
      // and the file of a running program cannot be written. The copy is made
      // beside its target and renamed over it, and a rename replaces the name
      // the running program is held by rather than the program itself.
      const replace = async (from: string, to: string) => {
        const beside = `${to}.delivered`;
        await copyFile(from, beside);
        await rename(beside, to);
      };
      const deliver = async (from: string, to: string) => {
        await replace(join(base, from), store.resolve(to));
        delivered.push(store.resolve(to));
      };
      if (phase.body !== undefined) {
        // The program was linked and run above, by the round that agreed with
        // the source, so what is delivered is what was checked.
        if (outputKind === "wasm") {
          // A program built as WebAssembly is one module and one host: the
          // module holds every function of the program and the body it runs,
          // and the host is the runtime it runs under. A module nobody can run
          // is not a deliverable, so the host is delivered beside it.
          await deliver("program.wasm", paths.outputModule);
          await deliver("program.host.mjs", paths.outputHost);
          outputPath = store.resolve(paths.outputModule);
        } else {
          //
          // The program beside the project's sources is stripped, and the store's
          // copy is not. A delivered binary is something a person runs, and a
          // symbol table, a build id and the unwind tables of a program with no
          // exceptions are 10-20% of a small binary for nothing. The store's copy
          // is made before the strip, so it keeps them.
          await deliver(programBinary, paths.outputBinary);
          run("strip", ["--strip-unneeded", programPath]);
          await replace(programPath, deliveredProgram);
          await deliver(runtimeKind === "nim" ? "program_host.nim" : "program.c", paths.outputProgram);
          delivered.push(deliveredProgram);
          outputPath = store.resolve(paths.outputBinary);
        }
      } else {
        const functionName = units[0].contract.function.name;
        const winner = selected[functionName];
        // A candidate that calls another function of the program is linked only
        // into that program, so the backend never writes a binary of its own for
        // it and there is nothing to deliver beside the IR. This is the same
        // question `codegen.ts:materialize` asks before it links a harness, read
        // off the IR that is delivered below, and a candidate whose IR cannot be
        // read is answered as one that calls out: the copy fails inside the
        // build rather than a binary that was never written being delivered.
        const implementation = await readFile(join(base, `${functionName}/${winner}.ir`), "utf8");
        const standalone = !callsOutOfProgram(implementation, program, callableSymbols(units[0].contract, contracts));
        // What the build delivers is the target the lowering produced, beside
        // the IR it was lowered from, which is the text a model wrote and the
        // one a later repair round is shown. Every kind answers in the IR, so
        // what differs is only the file the compiler wrote.
        await deliver(`${functionName}/${winner}.ir`, paths.outputIr);
        if (outputKind === "wasm") {
          await deliver(`${functionName}/${winner}.wasm`, paths.outputModule);
          // The host is the runtime a module runs under, and a module nobody
          // can run is not a deliverable: the host is delivered beside it.
          await deliver(`${functionName}/${winner}.host.mjs`, paths.outputHost);
          outputPath = store.resolve(paths.outputModule);
        } else if (outputKind === "ir") {
          if (standalone) {
            await deliver(`${functionName}/${winner}${EXECUTABLE_SUFFIX}`, paths.outputBinary);
            outputPath = store.resolve(paths.outputBinary);
          }
        } else if (backendKind === "machine") {
          // The object is the artifact the compiler wrote, so it is what the
          // build delivers beside the IR it was written from. A `machine`
          // build also delivers the executable, which is what a person runs.
          await deliver(`${functionName}/${winner}.o`, paths.outputObject);
          outputAssemblyPath = store.resolve(paths.outputObject);
          outputPath = store.resolve(paths.outputObject);
          if (outputKind === "machine" && standalone) {
            await deliver(`${functionName}/${winner}${EXECUTABLE_SUFFIX}`, paths.outputBinary);
            outputPath = store.resolve(paths.outputBinary);
          }
        } else {
          // The delivered text is the one the object was built from, so it can
          // be fed straight back to the toolchain that reads it.
          const target = outputKind === "c" ? paths.outputSource : paths.outputAssembly;
          await deliver(`${functionName}/${winner}.${outputKind === "c" ? "c" : "s"}`, target);
          outputAssemblyPath = store.resolve(target);
          outputPath = store.resolve(target);
          if (outputKind === "machine" && standalone) {
            await deliver(`${functionName}/${winner}${EXECUTABLE_SUFFIX}`, paths.outputBinary);
            outputPath = store.resolve(paths.outputBinary);
          }
        }
      }
      // The build record is written next and names these files as what the
      // build produced, so they are on the disk before it says so: a copy
      // still in the page cache when the machine loses power leaves a
      // successful build record pointing at nothing.
      for (const path of delivered) await flushToDisk(path);
      reporter.stage("output", "ok", `Output (${outputKind}):\n${delivered.map((path) => `  ${path}`).join("\n")}`);
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
    await writeBuildRecord(store, paths, build);

    return {
      project: id,
      build,
      contracts: Object.fromEntries(units.map((unit) => [unit.contract.function.name, unit.contract])),
      program,
      ...(phase.body === undefined ? {} : { body: phase.body }),
      candidates,
      verification,
      benchmark,
      generation: {
        selected,
        outcomes,
        modelDurationNs: String(generated.reduce((total, entry) => total + entry.result.modelDurationNs, 0n)),
      },
      outputKind,
      outputPath,
      outputAssemblyPath,
    };
  } catch (cause) {
    // The project is known from here on, so the CLI can point at the record.
    const failure = toCompilerError(cause, { category: "AiReviewError", stage: mode });
    const error = new CompilerError({ ...failure.toJSON(), project: id });
    build.status = "failed";
    build.error = error.toJSON();
    build.updatedAt = new Date().toISOString();
    await writeBuildRecord(store, paths, build);
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
  project: string,
): Promise<{ paths: ProjectPaths; program: ProgramContract; units: CompilationUnit[] }> {
  const paths = await storedPaths(store, project);
  if (!(await store.exists(paths.contract))) {
    throw new CompilerError({
      category: "StorageError",
      stage: "load",
      message: `unknown project "${project}"`,
      detail: `no contract at ${paths.contract}`,
    });
  }
  const program = await store.read<ProgramContract>(paths.contract);
  // A stored program records which functions it compiled, so `blaze test` and
  // `blaze benchmark` work on every one of them rather than on an entry the
  // program does not have.
  const build = (await store.exists(paths.build)) ? await store.read<BuildStatus>(paths.build) : undefined;
  const compiled = build?.selectedCandidates === undefined ? {} : build.selectedCandidates;
  const units = compilationUnits(program, program.entry.function === null)
    .filter((unit) => Object.keys(compiled).length === 0 || compiled[unit.contract.function.name] !== undefined);
  return { paths, program, units };
}

export async function runStored(
  project: string,
  options: BuildOptions,
  reporter: Reporter,
  action: "test" | "benchmark",
): Promise<StoredCommandOutcome> {
  const store = createJsonStore(join(options.cwd, STATE_DIRECTORY));
  const { paths, program, units } = await loadStored(store, project);
  if (units.length === 0) {
    throw new CompilerError({
      category: "StorageError",
      stage: action,
      message: `project "${project}" compiled no function`,
      detail: "run blaze build first",
    });
  }
  if (!(await store.exists(paths.candidates))) {
    throw new CompilerError({
      category: "StorageError",
      stage: action,
      message: `project "${project}" has no stored candidates`,
      detail: "run blaze build first",
    });
  }
  const input = await store.exists(paths.input) ? await store.read<SourceInput>(paths.input) : ({} as SourceInput);
  const build = await store.readIfValid<BuildStatus>(paths.build);
  // A build that failed selected nothing, so there is no candidate here that
  // is the project's. Falling back to the last one stored would re-measure an
  // implementation that was never delivered and write that measurement into
  // the record as the project's own.
  if (build !== undefined && build.status !== "success") {
    throw new CompilerError({
      category: "StorageError",
      stage: action,
      message: `project "${project}" has no successful build to ${action}`,
      detail: [
        `the last build of this project ${build.status === "building" ? "never finished" : "failed"}: ${build.error?.message ?? "no diagnostic is recorded"}`,
        `run ${STATE_DIRECTORY} > projects > ${project} > build.json for the whole of it, then build again`,
      ].join("\n"),
    });
  }
  // Every record below is keyed by whatever the source named its functions,
  // and `__proto__` is a legal identifier. On an object with the usual
  // prototype, reading that key answers from `Object.prototype` rather than
  // reporting the function as absent, and writing it replaces the prototype
  // instead of adding an entry, so the record the build wrote is quietly
  // missing the one function it kept. A record with no prototype holds what
  // it holds and nothing else.
  const stored = Object.create(null) as Record<string, Candidate[]>;
  for (const [name, candidates] of Object.entries(await store.read<Record<string, Candidate[]>>(paths.candidates))) {
    if (Array.isArray(candidates)) stored[name] = candidates;
  }

  reporter.stage("model", "info", `Model: ${build?.model ?? "unknown"}`);
  const output = build?.outputKind ?? "machine";
  const lowering = build?.backend ?? impliedBackend(output);
  const mode = build?.mode ?? "debug";
  const runtime = resolveRuntimeKind(options.runtime ?? build?.runtime ?? input.runtime, output);
  // The contract names no target, so the one the build ran for is what the
  // stored candidate is tested and measured against.
  const target = build?.target ?? normalizeTarget(input.target);
  const base = store.resolve(paths.work);
  const prepareRuntime = runtimePreparer({
    lowering,
    mode,
    runtime,
    target,
    workspace: { workDirectory: base, functionName: program.entry.file },
    libraries: usesSqliteSource(input.source) ? ["sqlite"] : [],
    // The runtime is built for the program the stored candidates belong to, so
    // it is built for the same program the build built it for: the source of
    // the project is what says what its server holds and whether it speaks
    // TLS.
    http: httpRuntimeNeeds(undefined, [input.source]),
  });
  // A stored candidate is given the same symbols the build that stored it was
  // given, which is what its own recorded calls say rather than what the build
  // happened to compile: the outline decided which of them is a call, and a
  // candidate is measured against the same rule it was checked under.
  const contracts = contractsByName(program.files);
  // `blaze test` measures stored candidates one at a time, but it measures
  // them the way a build does, so it goes through the same machine.
  const machines = machine();
  // A stored candidate is folded against the whole program too, so the bodies
  // it may inline are resolved here exactly as the build resolved them. The
  // object layouts are a property of the contracted files and nothing else, so
  // the same program answers the same names without the phase being run again.
  const functions = semanticFunctions(program, Object.fromEntries(resolveObjects(program.files).names), undefined, {}, new Map());

  // Both records are collected as entries and written whole, the way a build
  // writes its own, so a name that is a key of neither is never half written.
  const verificationEntries: [string, VerificationResult[]][] = [];
  const benchmarkEntries: [string, BenchmarkResult[]][] = [];
  const functionEntries: [string, StoredCommandOutcome["functions"][string]][] = [];
  for (const unit of units) {
    const functionName = unit.contract.function.name;
    const candidates = stored[functionName] ?? [];
    const chosen = build?.selectedCandidates?.[functionName];
    const candidate = candidates.find((entry) => entry.id === chosen);
    if (candidate === undefined) {
      throw new CompilerError({
        category: "StorageError",
        stage: action,
        message: `project "${project}" has no candidate to ${action} for ${functionName}`,
      });
    }
    const workspace = { workDirectory: `${base}/${functionName}`, functionName };
    const result = await evaluateStoredCandidate({
      mode,
      contract: unit.contract,
      parsed: unit.parsed,
      program,
      functions,
      // A program is one module, so the functions a candidate calls are in
      // the module beside it. A build that compiles one function on its own
      // has nothing to hold beside it, and carries none.
      ...(program.entry.function === null ? { programFunctions: Object.values(functions) } : {}),
      target,
      output,
      lowering,
      runtime,
      candidate,
      workspace,
      callable: callableSymbols(unit.contract, contracts),
      prepareRuntime,
      machine: machines,
      test: testConfigFor(input, options),
      benchmark: { iterations: input.benchmark?.iterations ?? DEFAULT_BENCHMARK.iterations },
    });
    functionEntries.push([
      functionName,
      {
        candidate: candidate.id,
        ...(result.verification === undefined ? {} : { verification: result.verification }),
        ...(result.benchmark === undefined ? {} : { benchmark: result.benchmark }),
      },
    ]);
    verificationEntries.push([functionName, result.verification === undefined ? [] : [result.verification]]);
    benchmarkEntries.push([functionName, result.benchmark === undefined ? [] : [result.benchmark]]);

    // A function that states no postcondition has no vector to run, so there is
    // nothing to report for it here.
    if (result.verification === undefined && result.benchmark === undefined) {
      reporter.stage(action, "info", `${functionName} has no vectors to run, so the program it is part of is what checks it`);
      continue;
    }
    if (action === "test") {
      reporter.stage(
        "verify",
        result.verification?.passed === true ? "ok" : "fail",
        `Correctness verified for ${functionName} (${result.verification?.cases ?? 0} test vectors)`,
      );
    } else {
      reporter.stage(
        "benchmark",
        "ok",
        `Benchmark completed for ${functionName} (${result.benchmark?.iterations ?? 0} iterations, ${result.benchmark?.durationNs ?? 0} ns)`,
      );
    }
  }
  // A record a re-measure rewrites whole, so it never keeps a function this
  // program no longer compiles, and a name any source may use is a key of it.
  await store.write(paths.verification, byName(verificationEntries));
  await store.write(paths.benchmark, byName(benchmarkEntries));
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
  const { input, entry, directory } = readInput(inputPath);
  const phase = runContractPhase({
    frontend: frontendFor(input.language),
    input,
    entry,
    read: moduleReader(directory),
  });
  const semantics = semanticFunctions(phase.program, phase.objectNames, phase.body, phase.objectLayouts, phase.objectKeys);
  // A function is the unit the IR describes, so a function can be asked for by
  // name, and every function of the program can be asked for at once.
  if (options.function !== undefined || options.all === true) {
    if (options.function === undefined) {
      return phase.program.files
        .map((file) => printSemanticModule(resolveModule(file.path, file.functions, functionContext(phase))))
        .join("\n");
    }
    const wanted = semantics[options.function];
    if (wanted === undefined) {
      throw new CompilerError({
        category: "InputError",
        stage: "ir",
        message: `${projectIdFor(inputPath)} has no function called ${options.function}`,
        detail: `it declares ${Object.keys(semantics).join(", ") || "nothing"}`,
      });
    }
    // What the backends are handed is folded, so what is printed here is what
    // was lowered rather than what the frontend resolved.
    return printSemanticFunction(optimizeSemanticFunction(structuredClone(wanted), new Map(Object.entries(semantics))));
  }
  if (phase.body === undefined) {
    throw new CompilerError({
      category: "InputError",
      stage: "ir",
      message: `${projectIdFor(inputPath)} has no program body`,
      detail: "this project declares functions and runs nothing of its own; ask for one with --function, or for all of them with --all",
    });
  }
  const callees = new Map(Object.entries(semantics));
  const program =
    options.from === undefined
      ? resolveProgram(phase.body, phase.program, phase.objectNames, phase.objectLayouts, phase.objectKeys)
      : parseSemanticProgram(readFileSync(options.from, "utf8"), phase.program);
  validateSemanticProgram(program, phase.program, new Map(program.bodies.map((fn) => [fn.name, fn])));
  // As for a function: the program the backends lower is folded, so the one
  // printed here is the one they were handed.
  return printSemanticProgram(optimizeSemanticProgram(program, callees));
}

export async function inspectProject(project: string, cwd: string): Promise<BuildStatus> {
  const store = createJsonStore(join(cwd, STATE_DIRECTORY));
  const paths = await storedPaths(store, project);
  if (!(await store.exists(paths.build))) {
    throw new CompilerError({
      category: "StorageError",
      stage: "inspect",
      message: `unknown project "${project}"`,
      detail: `no build record at ${paths.build}`,
    });
  }
  return store.read<BuildStatus>(paths.build);
}

export async function listProjects(cwd: string): Promise<string[]> {
  const store = createJsonStore(join(cwd, STATE_DIRECTORY));
  const entries = await readdir(store.resolve("projects"), { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

/** How many functions the program contract covers, for the build report. */
function contractedFunctionCount(program: ProgramContract): number {
  return program.files.reduce((total, file) => total + Object.keys(file.functions).length, 0);
}

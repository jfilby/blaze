/**
 * The compiler pipeline.
 *
 *   program -> contract phase -> target generation -> verification -> output
 *
 * The contract phase (semantics/program.ts) reads and contracts every file of
 * the program and validates the whole graph. Nothing generates target code
 * until that phase has produced a valid program contract, and every backend is
 * handed the source and that contract.
 *
 * Everything the compiler produces lives under `.blaze/` in the directory the
 * compiler was run from: JSON build records, intermediate artifacts and the
 * final output. The build record is written before and after the run, so a
 * failed build is as inspectable as a successful one.
 */

import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { createBackend, type PromptDump } from "./ai/backend.ts";
import { parseContract, type ParsedContract } from "./semantics/contract.ts";
import { INLINE_MODULE, runContractPhase } from "./semantics/program.ts";
import type { ProgramBody } from "./semantics/module.ts";
import { verifyProgram, type ProgramVerification } from "./toolchain/verify-program.ts";
import { buildProgramDriver } from "./toolchain/driver.ts";
import { buildProgramHost } from "./runtime/nim-program.ts";
import { resolveProgram } from "./toolchain/program.ts";
import { assertAssemblerSupportsArch } from "./toolchain/assembler.ts";
import {
  evaluateStoredCandidate,
  generateCandidates,
  implementationLabel,
  runtimePreparer,
  type CodegenResult,
} from "./codegen.ts";
import { CompilerError, toCompilerError } from "./core/errors.ts";
import { createJsonStore, hashValue, type JsonStore } from "./core/json-store.ts";
import { frontendFor } from "./semantics/frontend.ts";
import { resolveModel } from "./ai/model.ts";
import { assertBuildableTarget, EXECUTABLE_SUFFIX, normalizeTarget } from "./core/target.ts";
import {
  type ProgramMismatch,
  DEFAULT_BENCHMARK,
  DEFAULT_GENERATION,
  DEFAULT_TEST,
  type AssemblyCandidate,
  type BenchmarkResult,
  type CandidateOutcome,
  type RuntimeKind,
  RUNTIME_KINDS,
  type BuildStatus,
  OUTPUT_KINDS,
  type FunctionContract,
  type ProgramContract,
  type GenerationConfig,
  type ModelSelection,
  type OutputKind,
  type SourceInput,
  type SourceModule,
  type TestConfig,
  type VerificationResult,
} from "./core/types.ts";

export const COMPILER_VERSION = "0.1.0";
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
  /** Reuse previously generated and verified assembly instead of calling the model. */
  reuse: boolean;
  maxCandidates?: number;
  maxAttempts?: number;
  /** Extra model requests one attempt may spend on an answer with no implementation. */
  maxRetries?: number;
  /** Candidates generated at the same time; 1 generates them one at a time. */
  concurrency?: number;
  randomCases?: number;
  maxLength?: number;
  /** What the build delivers; overrides the input file. */
  output?: OutputKind;
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
  candidates: Record<string, AssemblyCandidate[]>;
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
  verification: string;
  benchmark: string;
  build: string;
  work: string;
  output: string;
  outputBinary: string;
  outputAssembly: string;
  outputSource: string;
  outputModule: string;
  outputWebAssemblyText: string;
  outputProgram: string;
}

/** Normalizes the requested deliverable. */
function resolveOutputKind(requested: OutputKind | undefined): OutputKind {
  if (requested === undefined) return "machine";
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
 * A project is named after its `blaze.json`, or after the directory that
 * holds one: a directory with a blaze.json in it is the project. Any other
 * input file names its own project, so examples can stay flat.
 */
function projectIdFor(inputPath: string): string {
  const name = basename(inputPath, extname(inputPath));
  if (name === "blaze") {
    const directory = basename(dirname(inputPath));
    if (directory !== "" && directory !== "." && directory !== "..") return directory;
  }
  return name === "" ? "project" : name;
}

function projectPaths(id: string): ProjectPaths {
  const root = `projects/${id}`;
  return {
    id,
    root,
    input: `${root}/input.json`,
    contract: `${root}/contract.json`,
    candidates: `${root}/candidates.json`,
    generation: `${root}/generation.json`,
    verification: `${root}/verification.json`,
    benchmark: `${root}/benchmark.json`,
    build: `${root}/build.json`,
    work: `${root}/work`,
    output: `${root}/output`,
    outputBinary: `${root}/output/${id}`,
    outputAssembly: `${root}/output/${id}.s`,
    outputSource: `${root}/output/${id}.c`,
    outputModule: `${root}/output/${id}.wasm`,
    outputWebAssemblyText: `${root}/output/${id}.wat`,
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
  let parsed: unknown;
  // A source file is not a project file. Saying so beats reporting a JSON
  // parse error on code the compiler was never meant to read directly.
  if (!text.trimStart().startsWith("{")) {
    throw new CompilerError({
      category: "InputError",
      stage: "input",
      message: `${path} is a source file, not a project file`,
      detail: "blaze builds the JSON project file, which names the source file to compile; run blaze build with the blaze.json beside it",
    });
  }
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new CompilerError({
      category: "InputError",
      stage: "input",
      message: `${path} is not valid JSON`,
      detail: cause instanceof Error ? cause.message : String(cause),
    });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new CompilerError({ category: "InputError", stage: "input", message: `${path} must contain a JSON object` });
  }
  const input = parsed as Partial<SourceInput> & { sourceFile?: string };
  if (typeof input.language !== "string") {
    throw new CompilerError({ category: "InputError", stage: "input", message: `${path} must define "language"` });
  }
  rejectCredentials(path, input);
  const directory = dirname(path);
  // `sourceFile` names a source file next to the project file, so the example
  // projects compile the real file instead of a copy of it pasted into JSON.
  // Its path is the one the program is known by, so it names every contract.
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

/** A key in a project file is a leak waiting to happen; the environment holds them. */
const CREDENTIAL_KEYS = ["apiKey", "api_key", "apikey", "token", "secret", "password"];

function rejectCredentials(path: string, input: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "object" || value === null) continue;
    for (const field of Object.keys(value as Record<string, unknown>)) {
      if (!CREDENTIAL_KEYS.includes(field.toLowerCase())) continue;
      throw new CompilerError({
        category: "InputError",
        stage: "input",
        message: `${path} puts a credential in "${key}.${field}"`,
        detail: "a project names its provider and model; the API key comes from the environment",
      });
    }
  }
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
        detail: 'the offline provider serves recorded assembly: "model": { "provider": "replay", "file": "candidate.json" }',
      });
    }
    return `replay:${file}`;
  }
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

/** A model request is only bounded when the project asks for a budget. */
function requestTimeoutMs(input: SourceInput): number | undefined {
  const seconds = input.generation?.timeoutSeconds;
  return seconds === undefined ? undefined : seconds * 1000;
}

/** The prompts a build sends, for `--debug`. Diagnostics belong on stderr. */
function printPrompt(dump: PromptDump): void {
  const at = `${dump.candidate}.${dump.attempt}`;
  process.stderr.write(
    `\n-- prompt ${at}: system --\n${dump.system}\n-- prompt ${at}: user --\n${dump.user}\n`,
  );
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
    concurrency: options.concurrency ?? input.generation?.concurrency ?? DEFAULT_GENERATION.concurrency,
    timeoutSeconds: input.generation?.timeoutSeconds ?? DEFAULT_GENERATION.timeoutSeconds,
  };
}

async function writeBuildRecord(store: JsonStore, paths: ProjectPaths, build: BuildStatus): Promise<void> {
  await store.write(paths.build, build);
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

/** A program is delivered as a binary, so a program build links one. */
function assertProgramOutput(output: OutputKind): void {
  if (output === "machine") return;
  throw new CompilerError({
    category: "InputError",
    stage: "input",
    message: `a program is delivered as a binary, not as ${output}`,
    detail:
      'build a program with "output": "machine" (the default), or make the entry module export the function to compile',
  });
}

/** The stored candidates a build may reuse, per function. */
async function reusableCandidates(
  store: JsonStore,
  paths: ProjectPaths,
  options: BuildOptions,
  id: string,
  previousBuild: BuildStatus | undefined,
  sourceHash: string,
): Promise<Record<string, AssemblyCandidate[]>> {
  if (!options.reuse) return {};
  // A build that failed has no contract hash of its own, so it is reported as
  // the failure it was instead of as a change of source.
  if (previousBuild !== undefined && previousBuild.status !== "success") {
    throw new CompilerError({
      category: "StorageError",
      stage: "reuse",
      message: `the last build of ${id} failed`,
      detail: previousBuild.error?.message ?? "run blaze build without --reuse to rebuild it",
    });
  }
  if (previousBuild !== undefined && previousBuild.sourceHash !== sourceHash) {
    throw new CompilerError({
      category: "StorageError",
      stage: "reuse",
      message: `the source of ${id} changed since the stored build`,
      detail: "run blaze build without --reuse to regenerate",
    });
  }
  if (!(await store.exists(paths.candidates))) {
    throw new CompilerError({
      category: "StorageError",
      stage: "reuse",
      message: `no stored assembly to reuse for ${id}`,
      detail: `expected ${paths.candidates}`,
    });
  }
  return store.read<Record<string, AssemblyCandidate[]>>(paths.candidates);
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
): Promise<{ path: string }> {
  if (body.file !== INLINE_MODULE) return { path: resolve(project.directory, body.file) };
  const path = `${base}/${id}.program.ts`;
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
  const paths = projectPaths(id);

  const project = readInput(absoluteInput);
  const input = project.input;
  const target = assertBuildableTarget(normalizeTarget(input.target), input.entry);
  const outputKind = resolveOutputKind(options.output ?? input.output);
  const runtimeKind = resolveRuntimeKind(options.runtime ?? input.runtime, outputKind);

  // A build that reuses stored assembly never calls a model, so it must not
  // require model configuration. The previous record is read before this build
  // overwrites it, which is what makes the source change check meaningful.
  const previousBuild = (await store.exists(paths.build)) ? await store.read<BuildStatus>(paths.build) : undefined;
  // --model wins over the project file, which wins over AI_MODEL.
  const requested = options.model ?? modelSpec(input.model, absoluteInput);
  // A reused build is answered by the model that generated the stored assembly,
  // so that is the model to name.
  const modelName = options.reuse ? previousBuild?.model : (requested ?? process.env.AI_MODEL);
  // The model is part of every answer this compiler gives, so it is named
  // before anything can fail, including a model that cannot be reached.
  reporter.stage("model", "info", `Model: ${modelName ?? "(unset)"}`);

  const model = options.reuse ? undefined : resolveModel(requested);

  await store.mkdirp(paths.root);
  await store.mkdirp(paths.work);
  await store.mkdirp(paths.output);
  await copyFile(absoluteInput, store.resolve(paths.input));

  const createdAt = new Date().toISOString();
  const build: BuildStatus = {
    id,
    input: paths.input,
    contract: paths.contract,
    target,
    status: "building",
    outputKind,
    runtime: runtimeKind,
    createdAt,
    updatedAt: createdAt,
    sourceHash: "",
    contractHash: "",
    model: model?.id ?? modelName ?? "unset",
    modelConfig: model?.id ?? previousBuild?.modelConfig ?? "reused",
    compilerVersion: COMPILER_VERSION,
  };
  await writeBuildRecord(store, paths, build);

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
    const sourceHash = hashValue(phase.modules.map((module) => [module.path, module.source]));
    build.sourceHash = sourceHash;
    build.contractHash = hashValue(program);
    await store.write(paths.contract, program);
    await writeBuildRecord(store, paths, build);
    reporter.stage(
      "contract",
      "ok",
      phase.body === undefined
        ? `Program contract: ${program.files.length} file(s), ${contractedFunctionCount(program)} contracted function(s), entry ${String(program.entry.function)} in ${program.entry.file}`
        : `Program contract: ${program.files.length} file(s), ${units.length} compiled function(s), program ${program.entry.file}`,
    );

    assertAssemblerSupportsArch(target);
    if (phase.body !== undefined) assertProgramOutput(outputKind);

    const stored = await reusableCandidates(store, paths, options, id, previousBuild, sourceHash);
    const base = store.resolve(paths.work);
    // One runtime for the whole build: every candidate of every function links
    // the same one, and the driver that runs the program links it too.
    const prepareRuntime = runtimePreparer({
      output: outputKind,
      runtime: runtimeKind,
      workspace: { workDirectory: base, functionName: program.entry.file },
    });
    const generation = generationConfigFor(input, options);

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
      return entry.result.candidates.find((candidate) => candidate.id === selected)?.assembly;
    };

    /**
     * One round of generation. Every unit, unless the round is repairing a
     * program: then only the units the program is the sole oracle for, because
     * a function that was verified against its own contract cannot be what made
     * the program print the wrong thing.
     */
    const generateUnits = async (mismatch: ProgramMismatch | undefined): Promise<void> => {
      for (const unit of units) {
        const functionName = unit.contract.function.name;
        const previous = mismatch === undefined ? undefined : implementationOf(functionName);
        if (mismatch !== undefined && (unit.contract.definition === undefined || previous === undefined)) continue;
        const workspace = { workDirectory: `${base}/${functionName}`, functionName };
        await mkdir(workspace.workDirectory, { recursive: true });
        const sequenceStart = written.get(functionName) ?? 0;
        const result = await generateCandidates({
          contract: unit.contract,
          unitFile: unit.file,
          parsed: unit.parsed,
          program,
          sources: phase.modules,
          target,
          output: outputKind,
          runtime: runtimeKind,
          backend: () =>
            createBackend(model ?? resolveModel(requested), {
              timeoutMs: requestTimeoutMs(input),
              retries: generation.maxRetries,
              onRetry: ({ candidate, attempt, retry, retries, reason }) => {
                reporter.stage(
                  "generate",
                  "info",
                  `Asking again: ${functionName}, candidate ${candidate}, attempt ${attempt}, ${reason}; request ${retry} of ${retries}, waiting for ${modelName ?? "(unset)"}`,
                );
              },
              ...(options.debug === true ? { onPrompt: printPrompt } : {}),
            }),
          generation,
          test: testConfigFor(input, options),
          benchmark: { iterations: input.benchmark?.iterations ?? DEFAULT_BENCHMARK.iterations },
          workspace,
          prepareRuntime,
          // A repair round asks the model again, so the stored candidates of a
          // reused build are not what it starts from.
          existing: mismatch === undefined ? (stored[functionName] ?? []) : [],
          sequenceStart,
          ...(mismatch === undefined || previous === undefined
            ? {}
            : { programFailure: { mismatch, previous } }),
          onGenerate: ({ candidate, candidates, attempt, attempts, repair }) => {
            reporter.stage(
              "generate",
              "info",
              `${repair ? "Repairing" : "Generating"} ${implementationLabel(outputKind)}: ${functionName}, candidate ${candidate} of ${candidates}, attempt ${attempt} of ${attempts}, waiting for ${modelName ?? "(unset)"}`,
            );
          },
        });
        written.set(functionName, sequenceStart + result.candidates.length);
        generatedByFunction.set(functionName, { unit, result });
      }
    };

    /** What every unit generated so far, as the build records it. */
    const record = async (): Promise<Record<string, string>> => {
      const generated = unitsGenerated();
      const candidates: Record<string, AssemblyCandidate[]> = {};
      const verification: Record<string, VerificationResult[]> = {};
      const benchmark: Record<string, BenchmarkResult[]> = {};
      const outcomes: Record<string, CandidateOutcome[]> = {};
      const selected: Record<string, string> = {};
      for (const entry of generated) {
        const functionName = entry.unit.contract.function.name;
        candidates[functionName] = entry.result.candidates;
        outcomes[functionName] = entry.result.outcomes;
        verification[functionName] = entry.result.outcomes
          .map((outcome) => outcome.verification)
          .filter((outcome): outcome is VerificationResult => outcome !== undefined);
        benchmark[functionName] = entry.result.outcomes
          .map((outcome) => outcome.benchmark)
          .filter((outcome): outcome is BenchmarkResult => outcome !== undefined);
        const valid = entry.result.outcomes.filter((outcome) => outcome.valid).length;
        reporter.stage(
          "generate",
          valid > 0 ? "ok" : "fail",
          `${implementationLabel(outputKind)} generated for ${functionName}: ${entry.result.candidates.length} candidate(s), ${valid} valid`,
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
            category: "AiGenerationError",
            stage: "verify",
            message: `no candidate for ${functionName} satisfied the contract`,
            function: functionName,
            detail: detail.trim(),
          });
        }
        selected[functionName] = entry.result.selected;
      }
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
    // Resolving a program and writing out the source the toolchain runs are
    // the same for every round: only the objects it links change.
    const driver = phase.body === undefined ? undefined : resolveProgram(phase.body, program);
    const programFile = phase.body === undefined ? undefined : await programSource(base, id, project, phase.body);
    // The linked program is named for the platform it was written for, and the
    // delivered program is the project's own name beside its sources.
    const programBinary = `program${EXECUTABLE_SUFFIX}`;
    const programPath = `${base}/${programBinary}`;
    const deliveredProgram = join(project.directory, `${id}${EXECUTABLE_SUFFIX}`);
    for (let round = 1; round <= programRounds; round += 1) {
      await generateUnits(mismatch);
      selected = await record();
      if (driver === undefined || programFile === undefined || mode !== "build") break;
      const runtime = await prepareRuntime();
      const objectPaths = unitsGenerated().map(
        (entry) => `${base}/${entry.unit.contract.function.name}/${entry.result.selected as string}.o`,
      );
      const runner =
        runtimeKind === "none"
          ? await buildProgramDriver({
              program: driver,
              workDirectory: base,
              objectPaths,
              ...(runtime === undefined ? {} : { runtimeObjectPath: runtime.objectPath }),
              outputPath: programPath,
            })
          : await buildProgramHost({
              program: driver,
              workDirectory: base,
              objectPaths,
              outputPath: programPath,
            });
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
    }

    const generated = unitsGenerated();
    const candidates: Record<string, AssemblyCandidate[]> = {};
    const verification: Record<string, VerificationResult[]> = {};
    const benchmark: Record<string, BenchmarkResult[]> = {};
    const outcomes: Record<string, CandidateOutcome[]> = {};
    for (const entry of generated) {
      const functionName = entry.unit.contract.function.name;
      candidates[functionName] = entry.result.candidates;
      outcomes[functionName] = entry.result.outcomes;
      verification[functionName] = entry.result.outcomes
        .map((outcome) => outcome.verification)
        .filter((outcome): outcome is VerificationResult => outcome !== undefined);
      benchmark[functionName] = entry.result.outcomes
        .map((outcome) => outcome.benchmark)
        .filter((outcome): outcome is BenchmarkResult => outcome !== undefined);
      const outcome = entry.result.outcomes.find((entry2) => entry2.candidate === entry.result.selected);
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

    let outputPath: string | null = null;
    let outputAssemblyPath: string | null = null;
    if (mode === "build") {
      const delivered: string[] = [];
      const deliver = async (from: string, to: string) => {
        await copyFile(join(base, from), store.resolve(to));
        delivered.push(store.resolve(to));
      };
      if (phase.body !== undefined) {
        // The program was linked and run above, by the round that agreed with
        // the source, so what is delivered is what was checked.
        await deliver(programBinary, paths.outputBinary);
        await deliver(runtimeKind === "none" ? "program.c" : "program_host.nim", paths.outputProgram);
        // The build belongs to the project beside its sources, so the program
        // it produced is named after the project and lands there. The store
        // keeps its own copy, which is what a later `blaze test` runs.
        await copyFile(programPath, deliveredProgram);
        delivered.push(deliveredProgram);
        outputPath = store.resolve(paths.outputBinary);
      } else {
        const functionName = units[0].contract.function.name;
        const winner = selected[functionName];
        if (outputKind === "c") {
          await deliver(`${functionName}/${winner}.c`, paths.outputSource);
          outputPath = store.resolve(paths.outputSource);
        } else if (outputKind === "wasm") {
          await deliver(`${functionName}/${winner}.wat`, paths.outputWebAssemblyText);
          await deliver(`${functionName}/${winner}.wasm`, paths.outputModule);
          outputPath = store.resolve(paths.outputModule);
          outputAssemblyPath = store.resolve(paths.outputWebAssemblyText);
        } else {
          // The delivered assembly is the assembled one, architecture prelude
          // included, so it can be fed straight back to the assembler.
          await deliver(`${functionName}/${winner}.s`, paths.outputAssembly);
          outputAssemblyPath = store.resolve(paths.outputAssembly);
          outputPath = store.resolve(paths.outputAssembly);
          if (outputKind === "machine") {
            await deliver(`${functionName}/${winner}${EXECUTABLE_SUFFIX}`, paths.outputBinary);
            outputPath = store.resolve(paths.outputBinary);
          }
        }
      }
      reporter.stage("output", "ok", `Output (${outputKind}):\n${delivered.map((path) => `  ${path}`).join("\n")}`);
    }

    build.status = "success";
    build.selectedCandidates = selected;
    build.output = outputPath === null ? paths.outputAssembly : paths.outputBinary;
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
    const failure = toCompilerError(cause, { category: "AiGenerationError", stage: mode });
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
  const paths = projectPaths(project);
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
  const build = await store.exists(paths.build) ? await store.read<BuildStatus>(paths.build) : undefined;
  const stored = await store.read<Record<string, AssemblyCandidate[]>>(paths.candidates);

  reporter.stage("model", "info", `Model: ${build?.model ?? "unknown"}`);
  const output = build?.outputKind ?? "machine";
  const runtime = resolveRuntimeKind(options.runtime ?? build?.runtime ?? input.runtime, output);
  // The contract names no target, so the one the build ran for is what the
  // stored candidate is tested and measured against.
  const target = build?.target ?? normalizeTarget(input.target);
  const base = store.resolve(paths.work);
  const prepareRuntime = runtimePreparer({
    output,
    runtime,
    workspace: { workDirectory: base, functionName: program.entry.file },
  });

  const verification = (await store.exists(paths.verification))
    ? await store.read<Record<string, VerificationResult[]>>(paths.verification)
    : {};
  const benchmark = (await store.exists(paths.benchmark))
    ? await store.read<Record<string, BenchmarkResult[]>>(paths.benchmark)
    : {};
  const functions: StoredCommandOutcome["functions"] = {};
  for (const unit of units) {
    const functionName = unit.contract.function.name;
    const candidates = stored[functionName] ?? [];
    const chosen = build?.selectedCandidates?.[functionName];
    const candidate =
      chosen === undefined ? candidates[candidates.length - 1] : candidates.find((entry) => entry.id === chosen);
    if (candidate === undefined) {
      throw new CompilerError({
        category: "StorageError",
        stage: action,
        message: `project "${project}" has no candidate to ${action} for ${functionName}`,
      });
    }
    const workspace = { workDirectory: `${base}/${functionName}`, functionName };
    const result = await evaluateStoredCandidate({
      contract: unit.contract,
      parsed: unit.parsed,
      target,
      output,
      runtime,
      candidate,
      workspace,
      prepareRuntime,
      test: testConfigFor(input, options),
      benchmark: { iterations: input.benchmark?.iterations ?? DEFAULT_BENCHMARK.iterations },
    });
    functions[functionName] = {
      candidate: candidate.id,
      ...(result.verification === undefined ? {} : { verification: result.verification }),
      ...(result.benchmark === undefined ? {} : { benchmark: result.benchmark }),
    };
    verification[functionName] = result.verification === undefined ? [] : [result.verification];
    benchmark[functionName] = result.benchmark === undefined ? [] : [result.benchmark];

    // A function whose contract states what it does rather than what it returns
    // has no vector to run, so there is nothing to report for it here.
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
  await store.write(paths.verification, verification);
  await store.write(paths.benchmark, benchmark);
  return { project, functions };
}

export async function inspectProject(project: string, cwd: string): Promise<BuildStatus> {
  const store = createJsonStore(join(cwd, STATE_DIRECTORY));
  const paths = projectPaths(project);
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

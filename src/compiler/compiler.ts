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
import { copyFile, readdir } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { createBackend, type PromptDump } from "./ai/backend.ts";
import { parseContract, type ParsedContract } from "./semantics/contract.ts";
import { entryContract, INLINE_MODULE, runContractPhase } from "./semantics/program.ts";
import { assertAssemblerSupportsArch } from "./toolchain/assembler.ts";
import { evaluateStoredCandidate, generateCandidates, implementationLabel, runtimePreparer } from "./codegen.ts";
import { CompilerError, toCompilerError } from "./core/errors.ts";
import { createJsonStore, hashValue, type JsonStore } from "./core/json-store.ts";
import { frontendFor } from "./semantics/frontend.ts";
import { resolveModel } from "./ai/model.ts";
import { assertBuildableTarget, normalizeTarget } from "./core/target.ts";
import {
  DEFAULT_BENCHMARK,
  DEFAULT_GENERATION,
  DEFAULT_TEST,
  type AssemblyCandidate,
  type BenchmarkResult,
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
}

export interface BuildOutcome {
  project: string;
  build: BuildStatus;
  contract: FunctionContract;
  /** The validated contract graph every file of the program took part in. */
  program: ProgramContract;
  candidates: AssemblyCandidate[];
  verification: VerificationResult[];
  benchmark: BenchmarkResult[];
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
    const contract = entryContract(program);
    const parsed = parseContract(contract);
    const sourceHash = hashValue(phase.modules.map((module) => [module.path, module.source]));
    build.sourceHash = sourceHash;
    build.contractHash = hashValue(program);
    await store.write(paths.contract, program);
    await writeBuildRecord(store, paths, build);
    reporter.stage(
      "contract",
      "ok",
      `Program contract: ${program.files.length} file(s), ${contractedFunctionCount(program)} contracted function(s), entry ${contract.function.name} in ${program.entry.file}`,
    );

    assertAssemblerSupportsArch(target);

    const existing: AssemblyCandidate[] = [];
    if (options.reuse) {
      // A build that failed has no contract hash of its own, so it is reported
      // as the failure it was instead of as a change of source.
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
      existing.push(...(await store.read<AssemblyCandidate[]>(paths.candidates)));
    }

    const workspace = { workDirectory: store.resolve(paths.work), functionName: contract.function.name };
    const generation = generateCandidates({
      contract,
      parsed,
      program,
      sources: phase.modules,
      target,
      output: outputKind,
      runtime: runtimeKind,
      backend: () =>
        createBackend(model ?? resolveModel(requested), {
          timeoutMs: requestTimeoutMs(input),
          ...(options.debug === true ? { onPrompt: printPrompt } : {}),
        }),
      generation: generationConfigFor(input, options),
      test: testConfigFor(input, options),
      benchmark: { iterations: input.benchmark?.iterations ?? DEFAULT_BENCHMARK.iterations },
      workspace,
      prepareRuntime: runtimePreparer({ output: outputKind, runtime: runtimeKind, workspace }),
      existing,
      onGenerate: ({ candidate, candidates, attempt, attempts, repair }) => {
        reporter.stage(
          "generate",
          "info",
          `${repair ? "Repairing" : "Generating"} ${implementationLabel(outputKind)}: candidate ${candidate} of ${candidates}, attempt ${attempt} of ${attempts}, waiting for ${modelName ?? "(unset)"}`,
        );
      },
    });

    const result = await generation;
    await store.write(paths.candidates, result.candidates);
    await store.write(paths.generation, {
      model: build.model,
      modelConfig: build.modelConfig,
      compilerVersion: COMPILER_VERSION,
      selected: result.selected,
      benchmarkVector: result.benchmarkVector,
      outcomes: result.outcomes,
    });
    await store.write(
      paths.verification,
      result.outcomes.map((outcome) => outcome.verification).filter((entry) => entry !== undefined),
    );
    await store.write(
      paths.benchmark,
      result.outcomes.map((outcome) => outcome.benchmark).filter((entry) => entry !== undefined),
    );

    const generated = result.outcomes.filter((outcome) => outcome.valid).length;
    const label = implementationLabel(outputKind);
    reporter.stage(
      "generate",
      generated > 0 ? "ok" : "fail",
      `${label} generated: ${result.candidates.length} candidate(s), ${generated} valid`,
    );

    if (result.selected === null) {
      const detail = result.outcomes
        .map((outcome) => `${outcome.candidate}: ${outcome.failure?.category ?? ""} ${outcome.failure?.message ?? ""}\n${outcome.failure?.detail ?? ""}`)
        .join("\n");
      throw new CompilerError({
        category: "AiGenerationError",
        stage: "verify",
        message: `no candidate for ${contract.function.name} satisfied the contract`,
        function: contract.function.name,
        detail: detail.trim(),
      });
    }

    const selectedOutcome = result.outcomes.find((outcome) => outcome.candidate === result.selected);
    reporter.stage("assemble", "ok", `${label} built into a testable implementation`);
    reporter.stage(
      "verify",
      "ok",
      `Correctness verified (${selectedOutcome?.verification?.cases ?? 0} test vectors, tolerance ${selectedOutcome?.verification?.tolerance ?? "exact"})`,
    );
    reporter.stage(
      "benchmark",
      "ok",
      `Benchmark completed (${selectedOutcome?.benchmark?.iterations ?? 0} iterations, ${selectedOutcome?.benchmark?.durationNs ?? 0} ns)`,
    );

    // The delivered implementation is the one the toolchain actually built and
    // verified, so what ships is what passed.
    let outputPath: string | null = null;
    let outputAssemblyPath: string | null = null;
    if (mode === "build") {
      const work = store.resolve(paths.work);
      const selected = result.selected;
      const delivered: string[] = [];
      const deliver = async (from: string, to: string) => {
        await copyFile(join(work, from), store.resolve(to));
        delivered.push(store.resolve(to));
      };
      if (outputKind === "c") {
        await deliver(`${selected}.c`, paths.outputSource);
        outputPath = store.resolve(paths.outputSource);
      } else if (outputKind === "wasm") {
        await deliver(`${selected}.wat`, paths.outputWebAssemblyText);
        await deliver(`${selected}.wasm`, paths.outputModule);
        outputPath = store.resolve(paths.outputModule);
        outputAssemblyPath = store.resolve(paths.outputWebAssemblyText);
      } else {
        // The delivered assembly is the assembled one, architecture prelude
        // included, so it can be fed straight back to the assembler.
        await deliver(`${selected}.s`, paths.outputAssembly);
        outputAssemblyPath = store.resolve(paths.outputAssembly);
        outputPath = store.resolve(paths.outputAssembly);
        if (outputKind === "machine") {
          await deliver(`${selected}.exe`, paths.outputBinary);
          outputPath = store.resolve(paths.outputBinary);
        }
      }
      reporter.stage("output", "ok", `Output (${outputKind}):\n${delivered.map((path) => `  ${path}`).join("\n")}`);
    }

    build.status = "success";
    build.selectedCandidate = result.selected;
    build.output = outputPath === null ? paths.outputAssembly : paths.outputBinary;
    build.updatedAt = new Date().toISOString();
    await writeBuildRecord(store, paths, build);

    return {
      project: id,
      build,
      contract,
      program,
      candidates: result.candidates,
      verification: result.outcomes.map((outcome) => outcome.verification).filter((entry) => entry !== undefined),
      benchmark: result.outcomes.map((outcome) => outcome.benchmark).filter((entry) => entry !== undefined),
      generation: { selected: result.selected, outcomes: result.outcomes, modelDurationNs: String(result.modelDurationNs) },
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
  candidate: string;
  verification?: VerificationResult;
  benchmark?: BenchmarkResult;
}

async function loadStored(store: JsonStore, project: string): Promise<{ paths: ProjectPaths; contract: FunctionContract; parsed: ParsedContract }> {
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
  const contract = entryContract(program);
  return { paths, contract, parsed: parseContract(contract) };
}

export async function runStored(
  project: string,
  options: BuildOptions,
  reporter: Reporter,
  action: "test" | "benchmark",
): Promise<StoredCommandOutcome> {
  const store = createJsonStore(join(options.cwd, STATE_DIRECTORY));
  const { paths, contract, parsed } = await loadStored(store, project);
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
  const candidates = await store.read<AssemblyCandidate[]>(paths.candidates);
  const chosen = build?.selectedCandidate;
  const candidate =
    chosen === undefined ? candidates[candidates.length - 1] : candidates.find((entry) => entry.id === chosen);
  if (candidate === undefined) {
    throw new CompilerError({
      category: "StorageError",
      stage: action,
      message: `project "${project}" has no candidate to ${action}`,
    });
  }
  // The contract names no target, so the one the build ran for is what the
  // stored candidate is tested and measured against.
  const target = build?.target ?? normalizeTarget(input.target);

  reporter.stage("model", "info", `Model: ${build?.model ?? "unknown"}`);
  const output = build?.outputKind ?? "machine";
  const runtime = resolveRuntimeKind(options.runtime ?? build?.runtime ?? input.runtime, output);
  const workspace = { workDirectory: store.resolve(paths.work), functionName: contract.function.name };
  const result = await evaluateStoredCandidate({
    contract,
    parsed,
    target,
    output,
    runtime,
    candidate,
    workspace,
    prepareRuntime: runtimePreparer({ output, runtime, workspace }),
    test: testConfigFor(input, options),
    benchmark: { iterations: input.benchmark?.iterations ?? DEFAULT_BENCHMARK.iterations },
  });

  await store.write(paths.verification, result.verification === undefined ? [] : [result.verification]);
  await store.write(paths.benchmark, result.benchmark === undefined ? [] : [result.benchmark]);

  if (action === "test") {
    reporter.stage(
      "verify",
      result.verification?.passed === true ? "ok" : "fail",
      `Correctness verified (${result.verification?.cases ?? 0} test vectors)`,
    );
  } else {
    reporter.stage(
      "benchmark",
      "ok",
      `Benchmark completed (${result.benchmark?.iterations ?? 0} iterations, ${result.benchmark?.durationNs ?? 0} ns)`,
    );
  }
  return { project, candidate: candidate.id, verification: result.verification, benchmark: result.benchmark };
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

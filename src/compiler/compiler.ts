/**
 * The compiler pipeline.
 *
 *   source -> frontend -> contract -> AI -> assembly -> assembler -> verifier
 *          -> native output
 *
 * Everything the compiler produces lives under `.blaze/` in the directory the
 * compiler was run from: JSON build records, intermediate artifacts and the
 * final output. The build record is written before and after the run, so a
 * failed build is as inspectable as a successful one.
 */

import { readFileSync } from "node:fs";
import { copyFile, readdir } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { createBackend, type PromptDump } from "./ai/backend.ts";
import { parseContract, type ParsedContract } from "./semantics/contract.ts";
import { assertAssemblerSupportsArch } from "./toolchain/assembler.ts";
import { evaluateStoredCandidate, generateCandidates, implementationLabel } from "./codegen.ts";
import { CompilerError, toCompilerError } from "./core/errors.ts";
import { createJsonStore, hashText, hashValue, type JsonStore } from "./core/json-store.ts";
import { frontendFor } from "./semantics/frontend.ts";
import { resolveModel } from "./ai/model.ts";
import { normalizeTarget } from "./core/target.ts";
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
  type GenerationConfig,
  type ModelSelection,
  type OutputKind,
  type SourceInput,
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

function readInput(path: string): SourceInput {
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

  // `sourceFile` names a source file next to the input, so the example projects
  // compile the real file instead of a copy of it pasted into JSON.
  if (input.sourceFile !== undefined) {
    if (typeof input.sourceFile !== "string" || input.sourceFile === "") {
      throw new CompilerError({
        category: "InputError",
        stage: "input",
        message: `${path} has an empty "sourceFile"`,
      });
    }
    const sourcePath = resolve(dirname(path), input.sourceFile);
    try {
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
  return input as SourceInput;
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
  process.stderr.write(
    `\n-- prompt ${dump.attempt}: system --\n${dump.system}\n-- prompt ${dump.attempt}: user --\n${dump.user}\n`,
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

  const input = readInput(absoluteInput);
  const target = normalizeTarget(input.target);
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

  const sourceHash = hashText(input.source);
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
    sourceHash,
    contractHash: "",
    model: model?.id ?? modelName ?? "unset",
    modelConfig: model?.id ?? previousBuild?.modelConfig ?? "reused",
    compilerVersion: COMPILER_VERSION,
  };
  await writeBuildRecord(store, paths, build);

  try {
    const contract = await frontendFor(input.language).compile(input);
    const parsed = parseContract(contract);
    build.contractHash = hashValue(contract);
    await store.write(paths.contract, contract);
    reporter.stage("contract", "ok", `Contract generated for ${contract.function.name}`);

    assertAssemblerSupportsArch(contract.target);

    const existing: AssemblyCandidate[] = [];
    if (options.reuse) {
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

    const generation = generateCandidates({
      contract,
      parsed,
      target: contract.target,
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
      workspace: { workDirectory: store.resolve(paths.work), functionName: contract.function.name },
      existing,
      onGenerate: (attempt, attempts) => {
        reporter.stage(
          "generate",
          "info",
          `Generating ${implementationLabel(outputKind)}: attempt ${attempt} of ${attempts}, waiting for ${modelName ?? "(unset)"}`,
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
  const contract = await store.read<FunctionContract>(paths.contract);
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
  const target =
    chosen === undefined ? candidates[candidates.length - 1] : candidates.find((entry) => entry.id === chosen);
  if (target === undefined) {
    throw new CompilerError({
      category: "StorageError",
      stage: action,
      message: `project "${project}" has no candidate to ${action}`,
    });
  }

  reporter.stage("model", "info", `Model: ${build?.model ?? "unknown"}`);
  const result = await evaluateStoredCandidate({
    contract,
    parsed,
    target: contract.target,
    output: build?.outputKind ?? "machine",
    runtime: resolveRuntimeKind(options.runtime ?? build?.runtime ?? input.runtime, build?.outputKind ?? "machine"),
    candidate: target,
    workspace: { workDirectory: store.resolve(paths.work), functionName: contract.function.name },
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
  return { project, candidate: target.id, verification: result.verification, benchmark: result.benchmark };
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

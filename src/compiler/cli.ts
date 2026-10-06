#!/usr/bin/env node
/**
 * blaze - the AI native compiler command line interface.
 *
 *   blaze build <input>        frontend, contract, generation, verification, output
 *   blaze generate <input>     the same pipeline up to candidate selection
 *   blaze init                 write a new project file in this directory
 *   blaze test <project>       re-verify the selected candidate of a build
 *   blaze benchmark <project>  re-benchmark the selected candidate of a build
 *   blaze inspect <project>    print the build record
 *   blaze projects             list the projects in .blaze/projects
 *
 * All state is written to `.blaze/` in the current directory. Model
 * configuration comes from --model or AI_MODEL; see model.ts.
 */

import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { CompilerError, isCompilerError, type SerializedCompilerError } from "./core/errors.ts";
import {
  MAX_RETRIES,
  STATE_DIRECTORY,
  inspectProject,
  listProjects,
  projectIdFor,
  runBuild,
  runSemanticIr,
  runStored,
  type BuildOptions,
  type Reporter,
  type SemanticIrOptions,
} from "./compiler.ts";
import { targetSummary } from "./core/target.ts";
import {
  BACKENDS,
  BUILD_MODES,
  type BuildMode,
  type BackendKind,
  OUTPUT_KINDS,
  RUNTIME_KINDS,
  type BuildStatus,
  type OutputKind,
  type RuntimeKind,
} from "./core/types.ts";
import { NO_TITLE_ANIMATION, startBuildTitle, type TitleAnimation } from "./core/terminal-title.ts";

/**
 * The tab title of a command that is working. A command that answers at once
 * never owns the tab: it would replace the shell's own title for a blink.
 */
function titleAnimation(label: string): TitleAnimation {
  if (!process.stdout.isTTY) return NO_TITLE_ANIMATION;
  return startBuildTitle(label);
}

/** The file that describes a project, and the default input of `blaze build`. */
const PROJECT_FILE = "blaze.toml";

const USAGE = `blaze - AI native compiler

A build resolves the source into the semantic IR, has the model review that,
lowers the revised IR to the target, has the model review it again, and compiles
the result. The model verifies and proposes; the compiler writes every program
and applies the proposals it accepts, refusing the rest with a reason.

Usage:
  blaze build [input.toml] [arguments...] build a function, or a program
  blaze generate [input.toml]              build and validate the candidates
  blaze ir [input.toml] [options]          print the semantic IR
  blaze init                               write a ${PROJECT_FILE} here
  blaze test <project>                     re-verify the selected candidate
  blaze benchmark <project>                re-benchmark the selected candidate
  blaze inspect <project>                  print the build record
  blaze projects                           list ${STATE_DIRECTORY}/projects

build, generate and ir take ./${PROJECT_FILE} when no path is given, and a directory
holding one names its project; any other .toml names its own. State is written
to ${STATE_DIRECTORY}/ in the current directory. Arguments after the path are the program's
own, so \`blaze build 12\` checks it the way it runs.

generation.timeoutSeconds in ${PROJECT_FILE} bounds one model request; unset, a
build waits as long as the model takes.

Options:
  --model <provider/model>  overrides AI_MODEL, which the project also sets;
                            the credential comes from the environment
  --reuse                   build only from what an earlier build verified
  --recompile               rebuild every function, without asking
  --from <file>             read the IR from a file instead of resolving the
                            source, and validate it against the contract
  --function <name>         one function as the IR holds it, not the program
  --all                     every function of every file, as the IR holds it
  --output <kind>           ir, c, asm, machine or wasm (default ir)
  --backend <name>          c, wasm or machine; defaults to the output's
  --mode <name>             debug (-O0 -g, default), release (-O3), or danger
                            (release, with the runtime's guards left out)
  --runtime <name>          host runtime: none or nim (default none)
  --max-candidates <n>      candidates to build per function (default 5)
  --max-attempts <n>        review rounds per candidate (default 3)
  --max-retries <n>         re-requests for an unreadable answer (default 3)
  --candidate-concurrency <n> candidates reviewed at once (default 4)
  --function-concurrency <n> functions reviewed at once (default 3)
  --debug                   print the prompt sent for every review
  --random-cases <n>        randomized test cases per build
  --max-length <n>          maximum generated buffer length
  -h, --help                show this help

Model providers, selected by the AI_MODEL prefix:
  openai/gpt-5                    OPENAI_API_KEY or AI_API_KEY
  anthropic/claude-sonnet-4-5     ANTHROPIC_API_KEY or AI_API_KEY
  google/gemini-2.5-pro           GOOGLE_GENERATIVE_AI_API_KEY or AI_API_KEY
  openrouter/<vendor>/<model>     OPENROUTER_API_KEY or AI_API_KEY
  opencode-go/<model>             OPENCODE_API_KEY or AI_API_KEY
  commandcode/<model>             COMMANDCODE_API_KEY, COMMAND_CODE_API_KEY or AI_API_KEY
  openai-compatible/<model>       OPENCODE_API_KEY or AI_API_KEY and AI_BASE_URL
  replay:<file>                   no credential, offline

Environment:
  AI_MODEL, AI_API_KEY, OPENCODE_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY,
  GOOGLE_GENERATIVE_AI_API_KEY, OPENROUTER_API_KEY, AI_BASE_URL, AI_REPLAY_FILE
  COMMANDCODE_API_KEY, COMMAND_CODE_API_KEY, COMMANDCODE_BASE_URL,
  OPENCODE_GO_BASE_URL
  OPENROUTER_SITE_URL, OPENROUTER_APP_NAME   optional OpenRouter attribution
`;

function consoleReporter(): Reporter {
  return {
    stage(stage, status, message) {
      const mark = status === "ok" ? "✓" : status === "fail" ? "✗" : "·";
      // Every message names the step it is about, so the stage is not printed
      // again beside it.
      void stage;
      process.stdout.write(`${mark} ${message}\n`);
    },
  };
}

/** The project `blaze build` builds when no path is given. */
function defaultProjectFile(): string {
  const candidate = resolve(process.cwd(), PROJECT_FILE);
  if (!existsSync(candidate)) {
    throw new CompilerError({
      category: "InputError",
      stage: "input",
      message: `no ${PROJECT_FILE} in ${process.cwd()}`,
      detail: "run from a project directory, or name the input: blaze build <input.toml>",
    });
  }
  return candidate;
}

/**
 * The project file a new project starts from. Machine code is the default
 * because it is the artifact the compiler itself writes: the object is encoded
 * by `toolchain/ir-machine.ts` and no toolchain touches it, so a project that
 * names nothing gets the one build that needs nothing installed.
 */
const PROJECT_FILE_TEMPLATE = `# The project blaze build builds in this directory, named after it.
language = "typescript"
sourceFile = "main.ts"

# Machine code: the compiler encodes the object itself. The other output kinds
# are ir, c, asm and wasm, and \`blaze --help\` says what each one is.
output = "machine"
backend = "machine"

# A project names its provider and model, never its key: the credential comes
# from the environment, and AI_MODEL names the pair when this does not.
# [model]
# provider = "openrouter"
# model = "anthropic/claude-sonnet-4.5"
`;

/**
 * Writes the project file of a new project. One that is already there is not
 * overwritten: a project file holds what a person wrote, and a build running
 * by the same name would read the new one and never the old.
 */
function initProject(): void {
  const path = resolve(process.cwd(), PROJECT_FILE);
  if (existsSync(path)) {
    throw new CompilerError({
      category: "InputError",
      stage: "input",
      message: `${path} already exists`,
      detail: "blaze init writes a new project file; edit the one that is there, or remove it and run this again",
    });
  }
  writeFileSync(path, PROJECT_FILE_TEMPLATE, "utf8");
  process.stdout.write(`created ${path}\n\nWrite ${PROJECT_FILE}'s sourceFile, then run blaze build.\n`);
}

/**
 * Asks the one question `blaze build` asks, and only where there is somebody
 * to answer it: a terminal. A build whose input is a pipe or a file takes the
 * answer a person would give, because a prompt read from a script's next line
 * is worse than no prompt — and the announcement the question follows is on
 * stdout either way, so a log says what happened.
 */
async function terminalConfirm(question: string): Promise<boolean> {
  if (process.stdin.isTTY !== true) return true;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await prompt.question(question)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    prompt.close();
  }
}

function optionNumber(value: string | undefined, name: string, minimum = 1, maximum?: number): number | undefined {
  if (value === undefined) return undefined;
  // Strictly: `parseInt` reads "4x" as 4 and the flag then asks for something
  // the user did not type, which is the one reading a number must not allow.
  // A zero is refused for a count that cannot be zero and allowed for the two
  // the compiler takes one of: no re-requests, and no random cases.
  const whole = minimum === 0 ? /^(?:0|[1-9]\d*)$/ : /^[1-9]\d*$/;
  if (!whole.test(value)) {
    throw new Error(`${name} must be ${minimum === 0 ? "a non-negative" : "a positive"} integer, got "${value}"`);
  }
  const parsed = Number(value);
  // The cap on re-requests is the compiler's, not the command line's: without
  // it here a build sits in its backoff loop for as long as the user asked.
  if (maximum !== undefined && parsed > maximum) {
    throw new Error(`${name} must be at most ${maximum}, got "${value}"`);
  }
  return parsed;
}

function buildOptions(values: Record<string, unknown>, arguments_: readonly string[] = []): BuildOptions {
  const output = values.output;
  if (output !== undefined && !OUTPUT_KINDS.includes(output as OutputKind)) {
    throw new Error(`--output must be one of ${OUTPUT_KINDS.join(", ")}, got "${String(output)}"`);
  }
  const runtime = values.runtime;
  if (runtime !== undefined && !RUNTIME_KINDS.includes(runtime as RuntimeKind)) {
    throw new Error(`--runtime must be one of ${RUNTIME_KINDS.join(", ")}, got "${String(runtime)}"`);
  }
  const backend = values.backend;
  if (backend !== undefined && !BACKENDS.includes(backend as BackendKind)) {
    throw new Error(`--backend must be one of ${BACKENDS.join(", ")}, got "${String(backend)}"`);
  }
  const mode = values.mode;
  if (mode !== undefined && !BUILD_MODES.includes(mode as BuildMode)) {
    throw new Error(`--mode must be one of ${BUILD_MODES.join(", ")}, got "${String(mode)}"`);
  }
  const recompile = values.recompile === true;
  // The two ask opposite things of the record: `--reuse` builds only from what
  // is stored, `--recompile` builds only what is not, so a build asking for
  // both is refused rather than resolved in favour of either.
  if (recompile && values.reuse === true) {
    throw new Error("--recompile and --reuse ask for opposite builds: one rebuilds everything, the other rebuilds nothing");
  }
  return {
    cwd: process.cwd(),
    reuse: values.reuse === true,
    ...(recompile ? { recompile: true } : {}),
    confirm: terminalConfirm,
    // What is left on the command line after the command and the project is
    // what the program is given: `blaze build 12` checks it the way it runs.
    arguments: [...arguments_],
    ...(values.debug === true ? { debug: true } : {}),
    ...(typeof values.model === "string" ? { model: values.model } : {}),
    ...(output === undefined ? {} : { output: output as OutputKind }),
    ...(mode === undefined ? {} : { mode: mode as BuildMode }),
    ...(runtime === undefined ? {} : { runtime: runtime as RuntimeKind }),
    ...(backend === undefined ? {} : { backend: backend as BackendKind }),
    ...(optionNumber(values["max-candidates"] as string | undefined, "--max-candidates") === undefined
      ? {}
      : { maxCandidates: optionNumber(values["max-candidates"] as string | undefined, "--max-candidates") }),
    ...(optionNumber(values["max-attempts"] as string | undefined, "--max-attempts") === undefined
      ? {}
      : { maxAttempts: optionNumber(values["max-attempts"] as string | undefined, "--max-attempts") }),
    ...(optionNumber(values["max-retries"] as string | undefined, "--max-retries", 0, MAX_RETRIES) === undefined
      ? {}
      : { maxRetries: optionNumber(values["max-retries"] as string | undefined, "--max-retries", 0, MAX_RETRIES) }),
    ...(optionNumber(values["candidate-concurrency"] as string | undefined, "--candidate-concurrency") === undefined
      ? {}
      : { candidateConcurrency: optionNumber(values["candidate-concurrency"] as string | undefined, "--candidate-concurrency") }),
    ...(optionNumber(values["function-concurrency"] as string | undefined, "--function-concurrency") === undefined
      ? {}
      : { functionConcurrency: optionNumber(values["function-concurrency"] as string | undefined, "--function-concurrency") }),
    ...(optionNumber(values["random-cases"] as string | undefined, "--random-cases", 0) === undefined
      ? {}
      : { randomCases: optionNumber(values["random-cases"] as string | undefined, "--random-cases", 0) }),
    ...(optionNumber(values["max-length"] as string | undefined, "--max-length") === undefined
      ? {}
      : { maxLength: optionNumber(values["max-length"] as string | undefined, "--max-length") }),
  };
}

/**
 * A build nobody asked for is not a fault, so it is reported as the decision
 * it was: the record it leaves behind is the last build's, and pointing at a
 * diagnostic file for a build that never started would send a reader looking
 * for an error that is not there.
 */
function reportCancelled(error: SerializedCompilerError): void {
  process.stdout.write(`\n· ${error.message}\n`);
  if (error.detail !== undefined && error.detail.trim() !== "") {
    process.stdout.write(`\n${error.detail.trim()}\n`);
  }
}

function reportError(error: SerializedCompilerError): void {
  process.stderr.write(`\n✗ ${error.stage} failed: ${error.message}\n`);
  const context = [
    error.function === undefined ? undefined : `  function:  ${error.function}`,
    error.candidate === undefined ? undefined : `  candidate: ${error.candidate}`,
  ].filter((line) => line !== undefined);
  if (context.length > 0) process.stderr.write(`${context.join("\n")}\n`);
  if (error.detail !== undefined && error.detail.trim() !== "") {
    process.stderr.write(`\n${error.detail.trim()}\n`);
  }
  if (error.project !== undefined) {
    process.stderr.write(`\nThe build record keeps the full diagnostic in ${STATE_DIRECTORY}/projects/${error.project}/build.json\n`);
  }
}

/** The candidate each compiled function selected, in one column. */
function selectedLabel(build: BuildStatus): string {
  const selected = build.selectedCandidates ?? {};
  const names = Object.keys(selected);
  if (names.length === 0) return "-";
  return names.map((name) => `${name}#${selected[name]}`).join(",");
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      model: { type: "string" },
      reuse: { type: "boolean" },
      recompile: { type: "boolean" },
      output: { type: "string" },
      runtime: { type: "string" },
      mode: { type: "string" },
      backend: { type: "string" },
      debug: { type: "boolean" },
      "max-candidates": { type: "string" },
      "max-attempts": { type: "string" },
      "max-retries": { type: "string" },
      "candidate-concurrency": { type: "string" },
      "function-concurrency": { type: "string" },
      "random-cases": { type: "string" },
      "max-length": { type: "string" },
      help: { type: "boolean", short: "h" },
      from: { type: "string" },
      function: { type: "string" },
      all: { type: "boolean" },
    },
  });
  const values = parsed.values as Record<string, unknown>;
  const [command, argument, ...rest] = parsed.positionals;

  if (values.help === true || command === undefined) {
    process.stdout.write(USAGE);
    return command === undefined && values.help !== true ? 1 : 0;
  }

  const options = buildOptions(values, rest);

  switch (command) {
    case "build":
    case "generate": {
      // With no argument, build the project described by ./blaze.toml.
      const input = argument ?? defaultProjectFile();
      const title = titleAnimation(projectIdFor(resolve(input)));
      try {
        const outcome = await runBuild(input, options, consoleReporter(), command);
        if (command === "generate") {
          process.stdout.write(`\nProject: ${STATE_DIRECTORY}/projects/${outcome.project}\n`);
        }
      } catch (cause) {
        title.stop("fail");
        throw cause;
      }
      title.stop("ok");
      return 0;
    }
    case "init": {
      initProject();
      return 0;
    }
    case "test":
    case "benchmark": {
      if (argument === undefined) {
        process.stderr.write(`blaze ${command} needs a project name\n\n${USAGE}`);
        return 1;
      }
      const title = titleAnimation(argument);
      try {
        await runStored(argument, options, consoleReporter(), command);
      } catch (cause) {
        title.stop("fail");
        throw cause;
      }
      title.stop("ok");
      return 0;
    }
    case "ir": {
      const irOptions: SemanticIrOptions = {
        ...(typeof values.from === "string" ? { from: values.from } : {}),
        ...(typeof values.function === "string" ? { function: values.function } : {}),
        ...(values.all === true ? { all: true } : {}),
      };
      const input = argument ?? defaultProjectFile();
      process.stdout.write(await runSemanticIr(input, irOptions));
      return 0;
    }
    case "inspect": {
      if (argument === undefined) {
        process.stderr.write(`blaze inspect needs a project name\n\n${USAGE}`);
        return 1;
      }
      const build = await inspectProject(argument, process.cwd());
      process.stdout.write(`${JSON.stringify(build, null, 2)}\n`);
      return 0;
    }
    case "projects": {
      const projects = await listProjects(process.cwd());
      if (projects.length === 0) {
        process.stdout.write(`no projects in ${STATE_DIRECTORY}/projects\n`);
        return 0;
      }
      for (const project of projects) {
        const build = await inspectProject(project, process.cwd()).catch(() => undefined);
        const state =
          build === undefined
            ? ""
            : `  ${build.status}  ${selectedLabel(build)}  ${build.model}  ${targetSummary(build.target)}`;
        process.stdout.write(`${project}${state}\n`);
      }
      return 0;
    }
    default:
      process.stderr.write(`unknown command "${command}"\n\n${USAGE}`);
      return 1;
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (cause) {
  const failure = isCompilerError(cause)
    ? cause.toJSON()
    : {
        category: "InputError" as const,
        stage: "cli",
        message: cause instanceof Error ? cause.message : String(cause),
        detail: cause instanceof Error ? cause.stack : undefined,
      };
  // A declined recompile is the one exit that is not a fault: nothing was
  // built, nothing was damaged, and the last build is still the project's.
  if (failure.category === "CancelledError") reportCancelled(failure);
  else reportError(failure);
  process.exitCode = 1;
}

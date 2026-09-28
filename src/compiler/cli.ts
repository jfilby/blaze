#!/usr/bin/env node
/**
 * blaze - the AI native compiler command line interface.
 *
 *   blaze build <input>        frontend, contract, generation, verification, output
 *   blaze generate <input>     the same pipeline up to candidate selection
 *   blaze test <project>       re-verify the selected candidate of a build
 *   blaze benchmark <project>  re-benchmark the selected candidate of a build
 *   blaze inspect <project>    print the build record
 *   blaze projects             list the projects in .blaze/projects
 *
 * All state is written to `.blaze/` in the current directory. Model
 * configuration comes from --model or AI_MODEL; see model.ts.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
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

Usage:
  blaze build [input.toml] [arguments...] build a function, or a program
  blaze generate [input.toml] [options]  generate and validate candidates
  blaze ir [input.toml] [options] print the semantic IR: the program the
                            project runs, one function, or every function
  blaze test <project> [options]         re-verify the selected candidate
  blaze benchmark <project> [options]    re-benchmark the selected candidate
  blaze inspect <project>                print the build record
  blaze projects                         list projects in ${STATE_DIRECTORY}/projects

  blaze build                       build the ./blaze.toml in this directory
  blaze build <input.toml>          build the given input instead

A project is described by a ${PROJECT_FILE} file, and a directory that holds one is
named after that directory, so "blaze build examples/hello_world/${PROJECT_FILE}"
builds project hello_world. Any other .toml file names its own project.

A project names its provider and model, never its key:

  [model]
  provider = "openrouter"
  model = "anthropic/claude-sonnet-4.5"

The credential comes from the environment. --model overrides the project, and
the project overrides AI_MODEL.

The compiler waits for the model for as long as it takes and says which model
it is waiting on. Set generation.timeoutSeconds to bound one model request
instead, for example in a build that must not hang: every request is given the
whole of that budget, and one that overruns it fails the build at once rather
than being asked for again.

A build is incremental. A function whose contract, the functions it is linked
against, the target, the options, the model and the compiler's own sources are
all unchanged keeps the object an earlier build verified, and the model is only
asked for what changed. Editing a comment in the project changes nothing a
build is keyed on, so it rebuilds nothing; editing the compiler itself rebuilds
everything, because the stored objects were built by rules that have moved.

On a terminal, a command that works animates the tab title as the blaze brand
next to a spinner, and settles it on the outcome: a check mark for a build that
produced an object, a cross for one that did not. A command whose output is a
pipe or a file never writes a title, so a log holds nothing but the build.

Options:
  --model <provider/model>  model configuration, overrides AI_MODEL
  --reuse                   build only from what an earlier build verified, and
                            fail rather than ask a model for anything
  --from <file>              read IR from the file instead of resolving the
                            source, and validate it against the contract
  --function <name>          print one function of the project as the IR holds
                            it, rather than the program it runs
  --all                      print every function of every file as the IR holds it
  --output <kind>           what is generated: ir (semantic IR the compiler lowers),
                            c, asm, machine or wasm (default ir)
  --runtime <name>           host runtime: none or nim (default none)
  --max-candidates <n>      number of candidates to generate, each generated
                            from the contract alone
  --max-attempts <n>        attempts per candidate: the first generates, the
                            rest repair the output the last one was rejected for
  --max-retries <n>         extra model requests one attempt spends on an answer
                            that carries no implementation; they cost no repair
                            attempt
  --candidate-concurrency <n> candidates to generate at the same time (default 4);
                            verification and benchmarking stay serial
  --function-concurrency <n> functions to generate at the same time (default 3);
                            assembles, verification and benchmarking stay serial
  --debug                   print the prompt sent to the model for every attempt
  --random-cases <n>        randomized test cases per build
  --max-length <n>          maximum generated buffer length
  -h, --help                show this help

Model providers, selected by the AI_MODEL prefix:
  openai/gpt-5                    OPENAI_API_KEY or AI_API_KEY
  anthropic/claude-sonnet-4-5     ANTHROPIC_API_KEY or AI_API_KEY
  google/gemini-2.5-pro           GOOGLE_GENERATIVE_AI_API_KEY or AI_API_KEY
  openrouter/<vendor>/<model>     OPENROUTER_API_KEY or AI_API_KEY
  commandcode/<model>             COMMANDCODE_API_KEY, COMMAND_CODE_API_KEY or AI_API_KEY
  openai-compatible/<model>       AI_API_KEY and AI_BASE_URL
  replay:<file>                   no credential, offline

Environment:
  AI_MODEL, AI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY,
  GOOGLE_GENERATIVE_AI_API_KEY, OPENROUTER_API_KEY, AI_BASE_URL, AI_REPLAY_FILE
  COMMANDCODE_API_KEY, COMMAND_CODE_API_KEY, COMMANDCODE_BASE_URL
  OPENROUTER_SITE_URL, OPENROUTER_APP_NAME   optional OpenRouter attribution
`;

function consoleReporter(): Reporter {
  return {
    stage(stage, status, message) {
      const mark = status === "ok" ? "✓" : status === "fail" ? "✗" : "·";
      process.stdout.write(`${mark} ${message}\n`);
      void stage;
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
  return {
    cwd: process.cwd(),
    reuse: values.reuse === true,
    // What is left on the command line after the command and the project is
    // what the program is given: `blaze build 12` checks it the way it runs.
    arguments: [...arguments_],
    ...(values.debug === true ? { debug: true } : {}),
    ...(typeof values.model === "string" ? { model: values.model } : {}),
    ...(output === undefined ? {} : { output: output as OutputKind }),
    ...(runtime === undefined ? {} : { runtime: runtime as RuntimeKind }),
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
      output: { type: "string" },
      runtime: { type: "string" },
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
  reportError(
    isCompilerError(cause)
      ? cause.toJSON()
      : {
          category: "InputError",
          stage: "cli",
          message: cause instanceof Error ? cause.message : String(cause),
          detail: cause instanceof Error ? cause.stack : undefined,
        },
  );
  process.exitCode = 1;
}

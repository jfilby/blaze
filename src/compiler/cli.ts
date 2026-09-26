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
  STATE_DIRECTORY,
  inspectProject,
  listProjects,
  runBuild,
  runStored,
  type BuildOptions,
  type Reporter,
} from "./compiler.ts";
import { targetSummary } from "./core/target.ts";
import { OUTPUT_KINDS, RUNTIME_KINDS, type OutputKind, type RuntimeKind } from "./core/types.ts";

/** The file that describes a project, and the default input of `blaze build`. */
const PROJECT_FILE = "blaze.json";

const USAGE = `blaze - AI native compiler

Usage:
  blaze build [input.json] [options]     build a function into native output
  blaze generate [input.json] [options]  generate and validate assembly candidates
  blaze test <project> [options]         re-verify the selected candidate
  blaze benchmark <project> [options]    re-benchmark the selected candidate
  blaze inspect <project>                print the build record
  blaze projects                         list projects in ${STATE_DIRECTORY}/projects

  blaze build                       build the ./blaze.json in this directory
  blaze build <input.json>          build the given input instead

A project is described by a ${PROJECT_FILE} file, and a directory that holds one is
named after that directory, so "blaze build examples/hello_world/${PROJECT_FILE}"
builds project hello_world. Any other input file names its own project.

A project names its provider and model, never its key:

  "model": { "provider": "openrouter", "model": "anthropic/claude-sonnet-4.5" }

The credential comes from the environment. --model overrides the project, and
the project overrides AI_MODEL.

The compiler waits for the model for as long as it takes and says which model
it is waiting on. Set generation.timeoutSeconds to make a model request give up
instead, for example in a build that must not hang.

Options:
  --model <provider/model>  model configuration, overrides AI_MODEL
  --reuse                   reuse stored assembly instead of generating
  --output <kind>           deliverable: c, asm, machine or wasm (default machine)
  --runtime <name>           host runtime: none or nim (default none)
  --max-candidates <n>      number of candidates to generate, each generated
                            from the contract alone
  --max-attempts <n>        attempts per candidate: the first generates, the
                            rest repair the output the last one was rejected for
  --debug                   print the prompt sent to the model for every attempt
  --random-cases <n>        randomized test cases per build
  --max-length <n>          maximum generated buffer length
  -h, --help                show this help

Model providers, selected by the AI_MODEL prefix:
  openai/gpt-5                    OPENAI_API_KEY or AI_API_KEY
  anthropic/claude-sonnet-4-5     ANTHROPIC_API_KEY or AI_API_KEY
  google/gemini-2.5-pro           GOOGLE_GENERATIVE_AI_API_KEY or AI_API_KEY
  openrouter/<vendor>/<model>     OPENROUTER_API_KEY or AI_API_KEY
  openai-compatible/<model>       AI_API_KEY and AI_BASE_URL
  replay:<file>                   no credential, offline

Environment:
  AI_MODEL, AI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY,
  GOOGLE_GENERATIVE_AI_API_KEY, OPENROUTER_API_KEY, AI_BASE_URL, AI_REPLAY_FILE
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
      detail: "run from a project directory, or name the input: blaze build <input.json>",
    });
  }
  return candidate;
}

function optionNumber(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got "${value}"`);
  }
  return parsed;
}

function buildOptions(values: Record<string, unknown>): BuildOptions {
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
    ...(optionNumber(values["random-cases"] as string | undefined, "--random-cases") === undefined
      ? {}
      : { randomCases: optionNumber(values["random-cases"] as string | undefined, "--random-cases") }),
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
      "random-cases": { type: "string" },
      "max-length": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const values = parsed.values as Record<string, unknown>;
  const [command, argument] = parsed.positionals;

  if (values.help === true || command === undefined) {
    process.stdout.write(USAGE);
    return command === undefined && values.help !== true ? 1 : 0;
  }

  const options = buildOptions(values);

  switch (command) {
    case "build":
    case "generate": {
      // With no argument, build the project described by ./blaze.json.
      const input = argument ?? defaultProjectFile();
      const outcome = await runBuild(input, options, consoleReporter(), command);
      if (command === "generate") {
        process.stdout.write(`\nProject: ${STATE_DIRECTORY}/projects/${outcome.project}\n`);
      }
      return 0;
    }
    case "test":
    case "benchmark": {
      if (argument === undefined) {
        process.stderr.write(`blaze ${command} needs a project name\n\n${USAGE}`);
        return 1;
      }
      await runStored(argument, options, consoleReporter(), command);
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
            : `  ${build.status}  ${build.selectedCandidate ?? "-"}  ${build.model}  ${targetSummary(build.target)}`;
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

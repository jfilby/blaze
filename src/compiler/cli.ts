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

import { existsSync, writeFileSync, readFile, resolveFrom, parseArgs, isDirectoryPath, hostArguments, hostAsk, hostCwd, hostSetExitCode, hostStdoutIsTTY, hostWriteError, hostWriteOut } from "./core/platform.ts";
import { CompilerError } from "./core/errors.ts";
import {
  MAX_RETRIES,
  inspectProject,
  argumentTail,
  differentBool,
  exceeds,
  isZero,
  isIntegerText,
  numeric,
  projectsReport,
  projectIdFor,
  runBuild,
  runSemanticIr,
  reportFailure,
  runStored,
  type BuildOptions,
  type Reporter,
  type SemanticIrOptions,
} from "./compiler.ts";

/** The directory a build writes its state to. */
const STATE_DIRECTORY = ".blaze";
import { compareRecordsReport, compareStatesReport } from "./core/compare.ts";
import {
  BACKENDS,
  BUILD_MODES,
  type BuildMode,
  type BackendKind,
  OUTPUT_KINDS,
  RUNTIME_KINDS,
  type BuildStatus,
  type OutputKind,
  type VerificationMode,
  type RuntimeKind,
} from "./core/types.ts";
import { BRAND, NO_TITLE_ANIMATION, startBuildTitle, stopTitleAnimation, type TitleAnimation } from "./core/terminal-title.ts";

/**
 * The tab title of a command that is working. A command that answers at once
 * never owns the tab: it would replace the shell's own title for a blink.
 */
function titleAnimation(label: string): TitleAnimation {
  if (!hostStdoutIsTTY()) return NO_TITLE_ANIMATION;
  return startBuildTitle(label, BRAND, undefined, undefined);
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
  blaze compare <a> <b>                    compare two builds or project states
  blaze projects                           list ${STATE_DIRECTORY}/projects

build, generate and ir take ./${PROJECT_FILE} when no path is given, and a directory
holding one names its project; any other .toml names its own. State is written
to ${STATE_DIRECTORY}/ in the current directory. Arguments after the path are the program's
own, so \`blaze build 12\` checks it the way it runs.

generation.timeoutSeconds in ${PROJECT_FILE} bounds one model request; unset, a
build waits as long as the model takes.

Options:
  --model <provider/model>  overrides AI_MODEL, which the project also sets;
                            the credential comes from the environment. With no
                            model anywhere, a build runs the rules alone: it
                            lowers the IR as resolved and reviews nothing
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
  --verify <mode>           source (run the program beside its source) or none
                            (deliver without a comparison); a cross build
                            defaults to none
  --runtime <name>          host runtime: none, nim or facil (default none)
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
  opencode-zen/<model>            OPENCODE_API_KEY or AI_API_KEY
  nebius/<vendor>/<model>         NEBIUS_API_KEY or AI_API_KEY
  commandcode/<model>             COMMANDCODE_API_KEY, COMMAND_CODE_API_KEY or AI_API_KEY
  openai-compatible/<model>       OPENCODE_API_KEY or AI_API_KEY and AI_BASE_URL
  replay:<file>                   no credential, offline

Environment:
  AI_MODEL, AI_API_KEY, OPENCODE_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY,
  GOOGLE_GENERATIVE_AI_API_KEY, OPENROUTER_API_KEY, AI_BASE_URL, AI_REPLAY_FILE
  NEBIUS_API_KEY, NEBIUS_BASE_URL
  COMMANDCODE_API_KEY, COMMAND_CODE_API_KEY, COMMANDCODE_BASE_URL,
  OPENCODE_GO_BASE_URL, OPENCODE_ZEN_BASE_URL
  OPENROUTER_SITE_URL, OPENROUTER_APP_NAME   optional OpenRouter attribution
`;

function consoleReporter(): Reporter {
  return (stage: string, status: "ok" | "fail" | "info", message: string) => {
    const state = String(status);
    const mark = state === "ok" ? "✓" : state === "fail" ? "✗" : "·";
    // Every message names the step it is about, so the stage is not printed
    // again beside it.
    void stage;
    hostWriteOut(`${mark} ${message}\n`);
  };
}

/** The project `blaze build` builds when no path is given. */
function defaultProjectFile(): string {
  const candidate = resolveFrom(hostCwd(), PROJECT_FILE);
  if (!existsSync(candidate)) {
    throw new CompilerError("InputError", "input", `no ${PROJECT_FILE} in ${hostCwd()}`, "run from a project directory, or name the input: blaze build <input.toml>", "", "", "");
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
  const path = resolveFrom(hostCwd(), PROJECT_FILE);
  if (existsSync(path)) {
    throw new CompilerError("InputError", "input", `${path} already exists`, "blaze init writes a new project file; edit the one that is there, or remove it and run this again", "", "", "");
  }
  writeFileSync(path, PROJECT_FILE_TEMPLATE, "utf8");
  hostWriteOut(`created ${path}\n\nWrite ${PROJECT_FILE}'s sourceFile, then run blaze build.\n`);
}

/**
 * Asks the one question `blaze build` asks, and only where there is somebody
 * to answer it: a terminal. A build whose input is a pipe or a file takes the
 * answer a person would give, because a prompt read from a script's next line
 * is worse than no prompt — and the announcement the question follows is on
 * stdout either way, so a log says what happened.
 */
function terminalConfirm(question: string): boolean {
  const answer = hostAsk(question);
  if (answer === "") return true;
  if (answer.trim() === "y" || answer.trim() === "Y") return true;
  if (answer.trim() === "yes" || answer.trim() === "YES") return true;
  return false;
}

function optionNumber(value: string, name: string, minimum: number, maximum: number): number | undefined {
  if (value === "") return undefined;
  // Strictly: `parseInt` reads "4x" as 4 and the flag then asks for something
  // the user did not type, which is the one reading a number must not allow.
  // A zero is refused for a count that cannot be zero and allowed for the two
  // the compiler takes one of: no re-requests, and no random cases.
  if (!isIntegerText(value, isZero(minimum))) {
    throw new Error(`${name} must be ${isZero(minimum) ? "a non-negative" : "a positive"} integer, got "${value}"`);
  }
  const parsed = numeric(value);
  // The cap on re-requests is the compiler's, not the command line's: without
  // it here a build sits in its backoff loop for as long as the user asked.
  if (exceeds(parsed, maximum)) {
    throw new Error(`${name} must be at most ${maximum}, got "${value}"`);
  }
  return parsed;
}

/** Whether a text names a verification mode the build accepts. */
function isVerificationMode(value: string): boolean {
  return value === "source" || value === "none";
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
  const rawVerify = values.verify;
  let verify: VerificationMode | undefined = undefined;
  if (rawVerify !== undefined) {
    if (typeof rawVerify === "string") {
      const held = rawVerify as string;
      if (!isVerificationMode(held)) {
        throw new Error(`--verify must be one of source, none, got "${held}"`);
      }
      verify = held as VerificationMode;
    } else {
      throw new Error(`--verify must be one of source, none, got "${String(rawVerify)}"`);
    }
  }
  const recompile = values.recompile ? true : false;
  // The two ask opposite things of the record: `--reuse` builds only from what
  // is stored, `--recompile` builds only what is not, so a build asking for
  // both is refused rather than resolved in favour of either.
  if (recompile && values.reuse) {
    throw new Error("--recompile and --reuse ask for opposite builds: one rebuilds everything, the other rebuilds nothing");
  }
  return {
    cwd: hostCwd(),
    reuse: values.reuse ? true : false,
    retainRecords: false,
    ...(recompile ? { recompile: true } : {}),
    confirm: terminalConfirm,
    // What is left on the command line after the command and the project is
    // what the program is given: `blaze build 12` checks it the way it runs.
    arguments: arguments_,
    ...(values.debug ? { debug: true } : {}),
    ...(typeof values.model === "string" ? { model: values.model } : {}),
    ...(output === undefined ? {} : { output: output as OutputKind }),
    ...(mode === undefined ? {} : { mode: mode as BuildMode }),
    ...(verify === undefined ? {} : { verify: verify as VerificationMode }),
    ...(runtime === undefined ? {} : { runtime: runtime as RuntimeKind }),
    ...(backend === undefined ? {} : { backend: backend as BackendKind }),
    ...(optionNumber(String(values["max-candidates"] ?? ""), "--max-candidates", 1, -1) === undefined
      ? {}
      : { maxCandidates: optionNumber(String(values["max-candidates"] ?? ""), "--max-candidates", 1, -1) }),
    ...(optionNumber(String(values["max-attempts"] ?? ""), "--max-attempts", 1, -1) === undefined
      ? {}
      : { maxAttempts: optionNumber(String(values["max-attempts"] ?? ""), "--max-attempts", 1, -1) }),
    ...(optionNumber(String(values["max-retries"] ?? ""), "--max-retries", 0, MAX_RETRIES) === undefined
      ? {}
      : { maxRetries: optionNumber(String(values["max-retries"] ?? ""), "--max-retries", 0, MAX_RETRIES) }),
    ...(optionNumber(String(values["candidate-concurrency"] ?? ""), "--candidate-concurrency", 1, -1) === undefined
      ? {}
      : { candidateConcurrency: optionNumber(String(values["candidate-concurrency"] ?? ""), "--candidate-concurrency", 1, -1) }),
    ...(optionNumber(String(values["function-concurrency"] ?? ""), "--function-concurrency", 1, -1) === undefined
      ? {}
      : { functionConcurrency: optionNumber(String(values["function-concurrency"] ?? ""), "--function-concurrency", 1, -1) }),
    ...(optionNumber(String(values["random-cases"] ?? ""), "--random-cases", 0, -1) === undefined
      ? {}
      : { randomCases: optionNumber(String(values["random-cases"] ?? ""), "--random-cases", 0, -1) }),
    ...(optionNumber(String(values["max-length"] ?? ""), "--max-length", 1, -1) === undefined
      ? {}
      : { maxLength: optionNumber(String(values["max-length"] ?? ""), "--max-length", 1, -1) }),
  };
}

/**
 * A build nobody asked for is not a fault, so it is reported as the decision
 * it was: the record it leaves behind is the last build's, and pointing at a
 * diagnostic file for a build that never started would send a reader looking
 * for an error that is not there.
 */

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs([...argv], {
      model: { type: "string" },
      reuse: { type: "boolean" },
      recompile: { type: "boolean" },
      output: { type: "string" },
      runtime: { type: "string" },
      mode: { type: "string" },
      verify: { type: "string" },
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
  });
  const values = parsed.values as unknown as Record<string, unknown>;
  const positionals = parsed.positionals as readonly string[];
  const command = positionals[0];
  const argument = positionals[1];

  if (values.help || command === undefined) {
    hostWriteOut(USAGE);
    return command === undefined && !values.help ? 1 : 0;
  }

  const options = buildOptions(values, argumentTail(positionals, 2));

  switch (command) {
    case "build":
    case "generate": {
      // With no argument, build the project described by ./blaze.toml.
      const input = argument ?? defaultProjectFile();
      const title = titleAnimation(projectIdFor(resolveFrom(input, ".")));
      try {
        await runBuild(input, options, consoleReporter(), command);
        if (command === "generate") {
          hostWriteOut(`\nProject: ${STATE_DIRECTORY}/projects/${projectIdFor(input)}\n`);
        }
      } catch (cause) {
        stopTitleAnimation(title, "fail");
        throw cause;
      }
      stopTitleAnimation(title, "ok");
      return 0;
    }
    case "init": {
      initProject();
      return 0;
    }
    case "test":
    case "benchmark": {
      if (argument === undefined) {
        hostWriteError(`blaze ${command} needs a project name\n\n${USAGE}`);
        return 1;
      }
      const title = titleAnimation(argument);
      try {
        await runStored(argument, options, consoleReporter(), command);
      } catch (cause) {
        stopTitleAnimation(title, "fail");
        throw cause;
      }
      stopTitleAnimation(title, "ok");
      return 0;
    }
    case "ir": {
      const irOptions: SemanticIrOptions = {
        ...(typeof values.from === "string" ? { from: values.from } : {}),
        ...(typeof values.function === "string" ? { function: values.function } : {}),
        ...(values.all ? { all: true } : {}),
      };
      const input = argument ?? defaultProjectFile();
      hostWriteOut(await runSemanticIr(input, irOptions));
      return 0;
    }
    case "inspect": {
      if (argument === undefined) {
        hostWriteError(`blaze inspect needs a project name\n\n${USAGE}`);
        return 1;
      }
      const build = await inspectProject(argument, hostCwd()) as unknown as Record<string, unknown>;
      hostWriteOut(`${JSON.stringify(build)}\n`);
      return 0;
    }
    case "compare": {
      if (argument === undefined || positionals[2] === undefined) {
        hostWriteError(`blaze compare needs two build records\n\n${USAGE}`);
        return 1;
      }
      const leftDirectory = isDirectoryPath(argument);
      if (differentBool(leftDirectory, isDirectoryPath(positionals[2] as string))) {
        throw new Error("compare needs two build records or two project state directories");
      }
      let report = "";
      if (leftDirectory) {
        report = await compareStatesReport(argument, positionals[2] as string);
      } else {
        report = compareRecordsReport(
          JSON.parse(await readFile(argument, "utf8")) as BuildStatus,
          JSON.parse(await readFile(positionals[2] as string, "utf8")) as BuildStatus,
        );
      }
      if (report === "") {
        hostWriteOut("The build records agree\n");
        return 0;
      }
      hostWriteOut(`The build records differ:\n${report}\n`);
      return 1;
    }
    case "projects": {
      hostWriteOut(await projectsReport(hostCwd()));
      return 0;
    }
    default:
      hostWriteError(`unknown command "${command}"\n\n${USAGE}`);
      return 1;
  }
}

try {
  hostSetExitCode(await main(hostArguments()));
} catch (cause) {
  reportFailure(cause as any);
}

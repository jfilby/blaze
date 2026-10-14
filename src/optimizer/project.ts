/**
 * Resolve and read a blaze project, so an optimization run can target it.
 *
 * A project is a directory holding blaze.toml, or a .toml file naming its
 * own. The project file names a sourceFile, which is what the optimization
 * passes read to learn what the program does.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { EXECUTABLE_SUFFIX } from "../compiler/core/target.ts";
import { modelSpec, projectIdFor } from "../compiler/compiler.ts";
import { parse as parseToml } from "smol-toml";
import { repositoryRoot } from "./repository.ts";
import { extractProjectContext } from "./tavily.ts";

/** The file a project is read from. */
export const PROJECT_FILE = "blaze.toml";

/** The table a project file holds its benchmark in. */
const BENCHMARK_TABLE = "benchmark";

/**
 * What the project file names for timing the program its build produces.
 *
 * A run aimed at a project is judged by that program, so the entry says how
 * much of it to run: `command` is what a measurement times, and `directory` is
 * where it runs, which is where the program it names is written.
 */
export interface ProjectBenchmark {
  /** The shell command a measurement times. */
  readonly command: string;
  /** The directory the command runs in, relative to the project file. */
  readonly directory: string;
  /**
   * The name a build delivers the program under, beside the project's own
   * sources: the project's own name, which is the name a build of it writes
   * there and the one the freshly built program is written under.
   */
  readonly program: string;
}

/** A blaze project an optimization run is targeting. */
export interface ProjectInfo {
  /** Absolute path to the project file. */
  readonly tomlPath: string;
  /** The directory holding the project file, where a build writes its state. */
  readonly directory: string;
  /** Absolute path to the source file the project names. */
  readonly sourcePath: string;
  /** The source text of the project. */
  readonly source: string;
  /** What the source does: domains, function names and patterns. */
  readonly context: string;
  /**
   * The model the project is compiled with, as the compiler reads its own
   * selection: `provider/model`, or null when it names none.
   *
   * This is what `blazeup` asks when the environment names no `AI_MODEL`,
   * because the project is what the build is aimed at and it already knows
   * what it is compiled with.
   */
  readonly model: string | null;
  /**
   * What the project file names for timing the program its build produces, or
   * null when it names nothing.
   *
   * A project that names nothing is a project a run cannot be judged by, and
   * that is the answer rather than a run that times something else: how much
   * of the program to do is the project's own to say, and a command nobody
   * chose can use all the machine's memory.
   */
  readonly benchmark: ProjectBenchmark | null;
}

/** Thrown when a project path cannot be read. */
export class ProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectError";
  }
}

/**
 * Read the project a path names.
 *
 * @param argument A directory containing blaze.toml, or a .toml file itself
 * @returns The project, with its source text and extracted context
 * @throws ProjectError when the path does not name a readable project
 */
export async function loadProject(argument: string): Promise<ProjectInfo> {
  const inputPath = resolve(process.cwd(), argument);

  // A directory names its own project file; anything else is the file itself.
  let tomlPath: string;
  if (existsSync(inputPath) && !inputPath.endsWith(".toml")) {
    tomlPath = join(inputPath, PROJECT_FILE);
  } else {
    tomlPath = inputPath;
  }

  if (!existsSync(tomlPath)) {
    throw new ProjectError(`no ${PROJECT_FILE} at ${tomlPath}`);
  }

  let toml: Readonly<Record<string, unknown>>;
  try {
    toml = parseToml(await readFile(tomlPath, "utf8")) as Readonly<Record<string, unknown>>;
  } catch (cause) {
    throw new ProjectError(
      `failed to parse ${tomlPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  if (typeof toml.sourceFile !== "string" || toml.sourceFile === "") {
    throw new ProjectError(`${tomlPath} does not name a sourceFile`);
  }

  const sourcePath = resolve(dirname(tomlPath), toml.sourceFile as string);
  if (!existsSync(sourcePath)) {
    throw new ProjectError(`source file not found: ${sourcePath}`);
  }

  const source = await readFile(sourcePath, "utf8");
  return {
    tomlPath,
    directory: dirname(tomlPath),
    sourcePath,
    source,
    context: extractProjectContext(source),
    model: projectModel(toml, tomlPath),
    benchmark: readBenchmark(toml, tomlPath, dirname(tomlPath)),
  };
}

/**
 * What the project file's `[benchmark]` table names, or null when it names none.
 *
 * The table is the project's own answer to what a measurement of it runs, and
 * it is read rather than derived: a project's program is a program the machine
 * can be asked too much of — `./binarytrees 16` and `./binarytrees 18` are the
 * same program a gigabyte apart — so the size of the work is written down by
 * whoever chose it, and a run that guessed one would be measuring a program
 * nobody asked it to run.
 *
 * @throws ProjectError when the table is there but cannot be read, saying what
 *   is missing and printing an entry that holds it
 */
function readBenchmark(
  toml: Readonly<Record<string, unknown>>,
  tomlPath: string,
  directory: string,
): ProjectBenchmark | null {
  const table = toml[BENCHMARK_TABLE];
  if (table === undefined || table === null) return null;
  if (typeof table !== "object" || Array.isArray(table)) {
    throw new ProjectError(
      `${tomlPath}: [benchmark] must be a table naming a command to time\n\n${benchmarkExample(tomlPath)}`,
    );
  }

  const entry = table as Readonly<Record<string, unknown>>;
  const command = entry["command"];
  if (typeof command !== "string" || command.trim() === "") {
    throw new ProjectError(
      `${tomlPath}: [benchmark] names no command to time\n\n` +
        `A measurement times the program the project builds, so the entry has to say what to run:\n\n` +
        benchmarkExample(tomlPath),
    );
  }

  const workingDirectory = entry["working_dir"];
  if (workingDirectory !== undefined && typeof workingDirectory !== "string") {
    throw new ProjectError(`${tomlPath}: [benchmark] working_dir must be a path`);
  }

  return {
    command,
    directory: benchmarkDirectory(
      typeof workingDirectory === "string" ? workingDirectory : undefined,
      directory,
    ),
    program: deliveredProgram(tomlPath),
  };
}

/**
 * The directory a benchmark's command runs in.
 *
 * The project's own table is read the way the project's own `sourceFile` is:
 * against the project file, which is where the entry is written and beside
 * which the sources it names live. A path that names nothing there is read
 * against the base of the repository, because a project's path from the head
 * of that is a natural way to write one down as well, and a directory nothing
 * holds is a command that never runs.
 *
 * Nothing is resolved when the entry names nothing: the command runs where the
 * sources are, which is the project's own directory.
 */
function benchmarkDirectory(workingDirectory: string | undefined, projectDirectory: string): string {
  if (workingDirectory === undefined || workingDirectory.trim() === "") return projectDirectory;
  const beside = resolve(projectDirectory, workingDirectory);
  if (existsSync(beside)) return beside;
  const fromRoot = resolve(repositoryRoot(), workingDirectory);
  return existsSync(fromRoot) ? fromRoot : beside;
}

/**
 * The name a project's build delivers its program under, beside its sources.
 *
 * It is the project's own name, which is what the compiler writes there when it
 * builds a program: a measurement writes the program it just built under the
 * same name, in the directory the command runs in, so a command written for the
 * project's own build finds the freshly built one.
 */
export function deliveredProgram(tomlPath: string): string {
  return `${projectIdFor(tomlPath)}${EXECUTABLE_SUFFIX}`;
}

/**
 * The `[benchmark]` entry a project that names none is handed.
 *
 * It is an example and it is never a default: how much of the program to run
 * is the project's own to say, so nothing here is timed until somebody writes
 * the entry down.
 */
export function benchmarkExample(tomlPath: string): string {
  return [
    "[benchmark]",
    `command = "./${deliveredProgram(tomlPath)} 16"`,
    'working_dir = "."',
  ].join("\n");
}

/**
 * The model the project file names, read the way the compiler reads it.
 *
 * The compiler's own reader is used rather than a second reading of the same
 * key: a selection the compiler refuses has to be refused here too, for the
 * same reason and in the same words, and a project that names a model the
 * optimizer cannot ask is a project the optimizer says so about.
 */
function projectModel(toml: Readonly<Record<string, unknown>>, path: string): string | null {
  const selection = toml["model"];
  if (selection === undefined || selection === null) return null;
  try {
    return modelSpec(selection as never, path) ?? null;
  } catch (cause) {
    throw new ProjectError(
      `${path} names a model that cannot be used: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

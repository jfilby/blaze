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
import { parse as parseToml } from "smol-toml";
import { extractProjectContext } from "./tavily.ts";

const PROJECT_FILE = "blaze.toml";

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

  let toml: { sourceFile?: string };
  try {
    toml = parseToml(await readFile(tomlPath, "utf8")) as { sourceFile?: string };
  } catch (cause) {
    throw new ProjectError(
      `failed to parse ${tomlPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  if (!toml.sourceFile) {
    throw new ProjectError(`${tomlPath} does not name a sourceFile`);
  }

  const sourcePath = resolve(dirname(tomlPath), toml.sourceFile);
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
  };
}

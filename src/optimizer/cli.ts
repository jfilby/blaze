#!/usr/bin/env node
/**
 * blazeopt - compiler optimization research tool.
 *
 *   blazeopt [project]     search for compiler optimization research
 *
 * With no project path, searches for general compiler optimization research.
 * With a project path, reads the project's source to understand what the
 * program does and crafts a targeted query.
 *
 * The API key comes from the TAVILY_API_KEY environment variable.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parse as parseToml } from "smol-toml";
import { craftQuery, extractProjectContext, formatResults, searchTavily, tavilyApiKey } from "./tavily.ts";

const USAGE = `blazeopt - compiler optimization research

Searches for compiler optimization research using Tavily. With no project
path, searches for general compiler optimization research. With a project
path, reads the project's source to understand what the program does and
crafts a targeted query.

Usage:
  blazeopt [project]                     search for optimization research

A project is a directory containing blaze.toml or a .toml file naming its
own. The source file is read from the sourceFile key of the project.

Options:
  -h, --help                              show this help

Environment:
  TAVILY_API_KEY                          enables the search
`;

/**
 * `blazeopt [projectPath]` — search for compiler optimization research.
 *
 * With no project path, searches for general compiler optimization research.
 * With a project path, reads the project's source to understand what the
 * program does and crafts a targeted query.
 */
async function runTavily(argument: string | undefined): Promise<number> {
  const apiKey = tavilyApiKey();
  if (!apiKey) {
    process.stderr.write(
      "TAVILY_API_KEY is not set. Get a key at https://tavily.com and set it:\n" +
        "  export TAVILY_API_KEY=tvly-...\n",
    );
    return 1;
  }

  let projectContext: string | undefined;

  if (argument !== undefined) {
    // Resolve the project path: a directory containing blaze.toml, or a .toml file
    const inputPath = resolve(process.cwd(), argument);
    let tomlPath: string;
    if (existsSync(inputPath) && !inputPath.endsWith(".toml")) {
      tomlPath = join(inputPath, "blaze.toml");
    } else {
      tomlPath = inputPath;
    }

    if (!existsSync(tomlPath)) {
      process.stderr.write(`no blaze.toml at ${tomlPath}\n`);
      return 1;
    }

    try {
      const toml = parseToml(await readFile(tomlPath, "utf8")) as { sourceFile?: string };
      if (!toml.sourceFile) {
        process.stderr.write(`${tomlPath} does not name a sourceFile\n`);
        return 1;
      }
      const sourcePath = resolve(dirname(tomlPath), toml.sourceFile);
      if (!existsSync(sourcePath)) {
        process.stderr.write(`source file not found: ${sourcePath}\n`);
        return 1;
      }
      const source = await readFile(sourcePath, "utf8");
      projectContext = extractProjectContext(source);
    } catch (cause) {
      process.stderr.write(`failed to read project: ${cause instanceof Error ? cause.message : String(cause)}\n`);
      return 1;
    }
  }

  const query = craftQuery(projectContext);
  try {
    const response = await searchTavily(query, apiKey);
    process.stdout.write(formatResults(response) + "\n");
  } catch (cause) {
    process.stderr.write(`tavily search failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
    return 1;
  }
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
    },
  });

  if (parsed.values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const positionals = parsed.positionals;
  if (positionals.length === 0) {
    return await runTavily(undefined);
  }
  if (positionals.length === 1) {
    return await runTavily(positionals[0]);
  }
  process.stderr.write(`too many arguments\n\n${USAGE}`);
  return 1;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (cause) {
  process.stderr.write(`blazeopt failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exitCode = 1;
}

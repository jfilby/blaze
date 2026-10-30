/**
 * What the TypeScript frontend still refuses of the compiler's own sources.
 *
 * Self-hosting starts with a measurement: the compiler cannot compile itself
 * while its own files are outside the subset the frontend reads. This walks the
 * sources a compiler binary is made of and reads each one as the frontend would
 * read it, so the refusals become a work queue instead of a guess.
 *
 * The report is a test fixture rather than a compiler command for now. It is
 * read by `self-host.test.ts`, and a slice that teaches the frontend one more
 * construct lowers the number it reports.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isCompilerError } from "../core/errors.ts";
import { typeScriptFrontend } from "../semantics/typescript.ts";

/** The package root, which is the tree a compiler binary is built from. */
const COMPILER_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * The directories that hold no compiler.
 *
 * The tests and benchmarks are run by Node and are not part of the binary. A
 * scratch program imports the test helpers to print a middle state, so it is
 * not part of the binary either.
 */
const NOT_COMPILER: ReadonlySet<string> = new Set(["node_modules", ".blaze", "test", "bench", "scratch"]);

/** One source the frontend cannot read, and what it said about it. */
export interface RefusedSource {
  /** Project-relative path, with `/` separators. */
  path: string;
  /** How many refusals the frontend counted, including ones it did not list. */
  count: number;
  /** The refusals the frontend reported, in the order it wrote them. */
  messages: string[];
}

/** One message the frontend writes, with the sources that earned it. */
export interface RefusalKind {
  message: string;
  count: number;
  /** Project-relative paths, in the order they were walked. */
  files: string[];
}

/** What one read of the compiler's sources answers. */
export interface SelfHostGap {
  /** The sources that make up the compiler, tests and benchmarks excluded. */
  files: string[];
  /** The sources the frontend reads whole. */
  clean: string[];
  /** The sources it refuses, with the reasons. */
  refused: RefusedSource[];
  /** Every refusal, grouped by the message the frontend wrote. */
  refusals: RefusalKind[];
  /** The number of refusals, which is the budget a slice lowers. */
  total: number;
}

/** Every source of the compiler, in a stable order. */
async function compilerSources(directory = COMPILER_ROOT): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => (left.name < right.name ? -1 : 1));
  for (const entry of entries) {
    if (NOT_COMPILER.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await compilerSources(path)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) found.push(path);
  }
  return found;
}

/** The path the report states, which is relative to the compiler package. */
function projectPath(path: string): string {
  return relative(COMPILER_ROOT, path).split(sep).join("/");
}

/**
 * How many refusals one source earned.
 *
 * The frontend reports every construct it cannot read in one error, and the
 * detail is cut after a maximum. The count in the message is the whole number,
 * so the budget is read from there rather than from the lines that survived the
 * cut.
 */
function countOf(message: string): number {
  const found = /^(\d+) constructs? of /.exec(message);
  return found === null ? 1 : Number(found[1]);
}

/** The refusal messages one source earned. */
function messagesOf(source: string): string[] {
  const rows = source.split("\n");
  const messages: string[] = [];
  for (const row of rows) {
    const trimmed = row.trim();
    if (!trimmed.startsWith("line ")) continue;
    const colon = trimmed.indexOf(":");
    if (colon < 0) continue;
    messages.push(trimmed.slice(colon + 1).trim());
  }
  return messages;
}

/**
 * Reads every compiler source and answers what the frontend refused.
 *
 * A source is read by `analyze` rather than by a whole build because this is a
 * measurement of the parser: it asks what syntax the file uses, not whether the
 * program it describes is valid. Imports are recorded and not followed, so a
 * file is counted once however many other files import it.
 */
export async function selfHostGap(directory = COMPILER_ROOT): Promise<SelfHostGap> {
  const paths = await compilerSources(directory);
  const clean: string[] = [];
  const refused: RefusedSource[] = [];
  const grouped = new Map<string, RefusalKind>();
  let total = 0;

  for (const path of paths) {
    const source = await readFile(path, "utf8");
    const name = projectPath(path);
    try {
      typeScriptFrontend.analyze(source, name);
      clean.push(name);
    } catch (error) {
      const message = isCompilerError(error) ? error.message : String(error);
      const detail = isCompilerError(error) ? (error.detail ?? "") : "";
      const messages = messagesOf(detail);
      const count = countOf(message);
      // A refusal with no line is the source the parser could not name; it is
      // one refusal and it is reported under the message the error carries.
      if (messages.length === 0) messages.push(message);
      refused.push({ path: name, count, messages });
      total += count;
      for (const one of messages) {
        const found = grouped.get(one);
        if (found === undefined) grouped.set(one, { message: one, count: 1, files: [name] });
        else {
          found.count += 1;
          found.files.push(name);
        }
      }
    }
  }

  const refusals = [...grouped.values()].sort(
    (left, right) => right.count - left.count || (left.message < right.message ? -1 : 1),
  );
  return { files: paths.map(projectPath), clean, refused, refusals, total };
}

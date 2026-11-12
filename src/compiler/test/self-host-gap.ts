/**
 * What the TypeScript frontend still refuses of the compiler's own sources.
 *
 * Self-hosting starts with a measurement: the compiler cannot compile itself
 * while its own files are outside the subset the frontend reads. This walks the
 * sources a compiler binary is made of and reads them as the module graph the
 * frontend reads, so the refusals become a work queue instead of a guess.
 *
 * The graph matters: a file read on its own is refused for every construct that
 * is only waiting for an import to be bound. A map held in a field another file
 * types, a value another file exports, and a list a linked signature fills are
 * all read as soon as the module graph links them. Counting the standalone read
 * charges the parser for gaps that are not its own, so the report reads the
 * same graph a build reads and counts what survives the link.
 *
 * The report is a test fixture rather than a compiler command for now. It is
 * read by `self-host.test.ts`, and a slice that teaches the frontend one more
 * construct lowers the number it reports.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isCompilerError } from "../core/errors.ts";
import { readModuleGraph, type ModuleRead, type ModuleRecord } from "../semantics/module-graph.ts";
import { readTypeScriptModule, typeScriptFrontend } from "../semantics/typescript.ts";

/** The package root, which is the tree a compiler binary is built from. */
const COMPILER_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * The module the compiler binary starts from.
 *
 * It is the only file read as a program: the values at the top of another file
 * are declarations a module holds, not statements that run. A fixture with no
 * `cli.ts` measures its first source as the entry instead, so a test can still
 * ask the report a question about a tree of its own.
 */
const ENTRY = "cli.ts";

/**
 * The directories that hold no compiler.
 *
 * The tests and benchmarks are run by Node and are not part of the binary. A
 * scratch program imports the test helpers to print a middle state, so it is
 * not part of the binary either.
 */
const NOT_COMPILER: ReadonlySet<string> = new Set(["node_modules", ".blaze", "test", "bench", "scratch"]);

/**
 * The sources a Node host provides for the model boundaary.
 *
 * `ai/review-node.ts` is what `package.json` maps `#host/model` to, and it is
 * the only file that names the AI SDK and `zod`; `ai/commandcode.ts` is the one
 * provider it carries. A native build maps the same boundary to
 * `ai/review-native.ts` (the host boundary of the spec) and never compiles either of these,
 * so the report measures the sources a native binary is made of. The Node
 * compiler still loads them at run time through the manifest's `imports`.
 */
const HOST_SOURCES: ReadonlySet<string> = new Set([
  "ai/review-node.ts",
  "ai/commandcode.ts",
  "core/platform-node.ts",
]);

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

/** The path the report states, which is relative to the measured tree. */
function projectPath(directory: string, path: string): string {
  return relative(directory, path).split(sep).join("/");
}

/**
 * What one module's last read refused, as the report states it.
 *
 * The read counts every construct it refused, and lists the ones that survived
 * the cut. Both are the frontend's own numbers, so the report never has to parse
 * an error message to find out what a file earned.
 */
function refusalOf(record: ModuleRecord): RefusedSource | null {
  if (record.refused.length === 0 && record.refusedCount === 0) return null;
  const messages = record.refused.map((entry) => entry.message);
  // A read that counted a refusal and listed none is one the report cannot
  // name by a line; it is still one refusal, reported under a message of its
  // own rather than dropped from the queue.
  if (messages.length === 0) messages.push(`the frontend reads nothing of ${record.path}`);
  return { path: record.path, count: record.refusedCount, messages };
}

/**
 * Reads one module, answering a refusal the tokenizer states as an error.
 *
 * Most refusals are gathered as the parser reads on, but a file the tokenizer
 * cannot split at all — a regular expression whose pattern runs off the line —
 * has no analysis to link. It is one refusal, the graph keeps measuring the
 * files that import it without it, and the message is the one the frontend
 * wrote.
 */
function readModuleOrRefuse(source: string, path: string, entry: boolean, context?: unknown): ModuleRead {
  try {
    return readTypeScriptModule(source, path, entry, context);
  } catch (error) {
    const message = isCompilerError(error) ? error.message : String(error);
    const detail = isCompilerError(error) ? (error.detail ?? "") : "";
    const found = /line (\d+)/.exec(detail);
    return {
      analysis: { path, imports: [], functions: [], default: null, body: [] },
      refused: [{ line: found === null ? 1 : Number(found[1]), message, detail }],
      count: 1,
    };
  }
}

/**
 * Reads every compiler source as the module graph a build reads and answers
 * what the frontend refused.
 *
 * Every source is a root, so a file no import reaches is still measured: the
 * graph is the whole tree, not one binary's closure. The entry is read as a
 * program and the rest as libraries, exactly as a build reads them, and every
 * file whose imports bind a type, a value or a signature is read again with
 * them — that second read is the one the report counts.
 */
export async function selfHostGap(directory = COMPILER_ROOT): Promise<SelfHostGap> {
  const paths = await compilerSources(directory);
  const sources = new Map<string, string>();
  for (const path of paths) sources.set(projectPath(directory, path), await readFile(path, "utf8"));

  const files = [...sources.keys()].filter((path) => !HOST_SOURCES.has(path)).sort();
  if (files.length === 0) return { files: [], clean: [], refused: [], refusals: [], total: 0 };
  const entryPath = files.includes(ENTRY) ? ENTRY : (files[0] as string);
  const records = readModuleGraph({
    frontend: typeScriptFrontend,
    // The project maps the two host boundaries to the adapters a native build
    // links; the measurement reads the same files a native build reads.
    modules: {
      "#host/model": "ai/review-native.ts",
      "#host/platform": "core/platform-native.ts",
    },
    entry: { path: entryPath, source: sources.get(entryPath) ?? "" },
    roots: files.filter((path) => path !== entryPath),
    read: (path) => sources.get(path) ?? null,
    // The report is about what the frontend reads of a file, not about which
    // packages the tree depends on: an import the tree does not hold is left
    // unbound and the file is still measured.
    requireImports: false,
    // A package is not a source of the compiler: the report asks what the
    // frontend reads of the tree a binary is built from, and a package the
    // tree installs is measured by the test that reads the package.
    resolvePackages: false,
    // A measurement reads every file: answering a refusal keeps the imports the
    // rest of the tree links against, where throwing would stop the walk.
    reader: readModuleOrRefuse,
  }).sort((left, right) => (left.path < right.path ? -1 : 1));

  const clean: string[] = [];
  const refused: RefusedSource[] = [];
  const grouped = new Map<string, RefusalKind>();
  let total = 0;

  for (const record of records) {
    const refusal = refusalOf(record);
    if (refusal === null) {
      clean.push(record.path);
      continue;
    }
    refused.push(refusal);
    total += refusal.count;
    for (const one of refusal.messages) {
      const found = grouped.get(one);
      if (found === undefined) grouped.set(one, { message: one, count: 1, files: [record.path] });
      else {
        found.count += 1;
        found.files.push(record.path);
      }
    }
  }

  const refusals = [...grouped.values()].sort(
    (left, right) => right.count - left.count || (left.message < right.message ? -1 : 1),
  );
  return { files, clean, refused, refusals, total };
}

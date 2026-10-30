/**
 * The host boundary, held by a test.
 *
 * A compiler that runs on a native runtime cannot import a Node module. The
 * compiler asks `core/platform.ts` for a host service instead, and that module
 * answers from `core/platform-node.ts`, which is the one file allowed to name a
 * Node module. This test keeps a new `node:` import out of every other source.
 *
 * The check parses the file rather than matching its text: the WASM host
 * runtime is written as a string that holds `import { readFileSync } from
 * "node:fs"`, and that string is a program the compiler writes, not a module
 * the compiler imports.
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const COMPILER_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The one source that may name the Node modules the compiler runs on. */
const ADAPTER = "core/platform-node.ts";

/** The directories that hold no compiler binary. */
const NOT_COMPILER: ReadonlySet<string> = new Set(["node_modules", ".blaze", "test", "bench", "scratch"]);

/** Every compiler source, as a path relative to the package. */
async function compilerSources(): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : 1));
    for (const entry of entries) {
      if (NOT_COMPILER.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".ts")) {
        found.push(relative(COMPILER_ROOT, path).split(sep).join("/"));
      }
    }
  };
  await walk(COMPILER_ROOT);
  return found;
}

/** The Node modules one source imports, as the import declarations state them. */
function nodeImports(path: string, source: string): string[] {
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const modules: string[] = [];
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (ts.isStringLiteral(specifier) && specifier.text.startsWith("node:")) modules.push(specifier.text);
  }
  return modules;
}

test("the compiler names a Node module only in the platform adapter", async () => {
  const offenders: string[] = [];
  for (const path of await compilerSources()) {
    if (path === ADAPTER) continue;
    const source = await readFile(join(COMPILER_ROOT, path), "utf8");
    const modules = nodeImports(path, source);
    if (modules.length > 0) offenders.push(`${path}: ${modules.join(", ")}`);
  }
  assert.deepEqual(offenders, [], "import a host service from core/platform.ts, not from a Node module");
});

test("the platform adapter is the file the boundary names", async () => {
  const sources = await compilerSources();
  assert.ok(sources.includes(ADAPTER), "the adapter is part of the compiler");
  const adapter = await readFile(join(COMPILER_ROOT, ADAPTER), "utf8");
  assert.ok(nodeImports(ADAPTER, adapter).length > 0, "the adapter is where the Node modules are named");
  const boundary = await readFile(join(COMPILER_ROOT, "core/platform.ts"), "utf8");
  assert.deepEqual(nodeImports("core/platform.ts", boundary), [], "the platform interface names no host module");
});

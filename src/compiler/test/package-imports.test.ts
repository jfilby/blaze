/**
 * A module that imports an installed package.
 *
 * A native compiler cannot load `node_modules` the way Node does: the module
 * graph reads the file a package names and compiles it with the program. These
 * tests are the resolution an import is — the entry a package's `exports`
 * answers, a subpath of it, the relative imports inside the package — and the
 * closure the compiler's own TOML dependency is read as, held as a budget the
 * way the compiler's own sources are.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { isCompilerError } from "../core/errors.ts";
import { readModuleGraph, type ModuleRead } from "../semantics/module-graph.ts";
import { typeScriptFrontend } from "../semantics/typescript.ts";

/** The compiler's own directory, which holds the packages it depends on. */
const COMPILER_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * A read that answers a refusal instead of stopping the walk.
 *
 * A package read for its whole closure has files the frontend refuses today,
 * and a graph that stopped at the first would hide the rest of the package.
 */
function tolerant(source: string, path: string, entry: boolean, context?: unknown): ModuleRead {
  try {
    return typeScriptFrontend.read!(source, path, entry, context);
  } catch (error) {
    return {
      analysis: { path, imports: [], functions: [], default: null, body: [] },
      refused: [{ line: 1, message: isCompilerError(error) ? error.message : String(error), detail: "" }],
      count: 1,
    };
  }
}

/** The records a graph read of an in-memory project answers. */
function graphOf(files: Record<string, string>): string[] {
  const main = files["main.ts"] as string;
  return readModuleGraph({
    frontend: typeScriptFrontend,
    entry: { path: "main.ts", source: main },
    read: (path: string) => files[path] ?? null,
    reader: tolerant,
  }).map((record) => record.path);
}

test("an import names the entry its package's exports answers", () => {
  const paths = graphOf({
    "main.ts": 'import { a } from "small";\nexport function f(): number {\n  return a();\n}\n',
    "node_modules/small/package.json": JSON.stringify({
      name: "small",
      type: "module",
      exports: { import: "./dist/index.js", require: "./dist/index.cjs" },
    }),
    "node_modules/small/dist/index.js": 'import { part } from "./part.js";\nexport function a() {\n  return part();\n}\n',
    "node_modules/small/dist/part.js": "export function part() {\n  return 1;\n}\n",
    "node_modules/small/dist/index.cjs": "module.exports = {};\n",
  });
  assert.ok(paths.includes("node_modules/small/dist/index.js"), `the import reads the entry: ${paths.join(", ")}`);
  assert.ok(paths.includes("node_modules/small/dist/part.js"), "the entry's own import is read");
  // The module is imported as an ES module, so the `import` condition is the
  // one that answers and the CommonJS file beside it is not part of the program.
  assert.ok(!paths.includes("node_modules/small/dist/index.cjs"), "the CommonJS entry is not read");
});

test("a specifier after the package name is a subpath its exports map", () => {
  const paths = graphOf({
    "main.ts": 'import { part } from "small/part";\nexport function f(): number {\n  return part();\n}\n',
    "node_modules/small/package.json": JSON.stringify({
      name: "small",
      type: "module",
      exports: { ".": "./dist/index.js", "./part": "./dist/part.js" },
    }),
    "node_modules/small/dist/index.js": "export function a() {\n  return 1;\n}\n",
    "node_modules/small/dist/part.js": "export function part() {\n  return 2;\n}\n",
  });
  assert.ok(paths.includes("node_modules/small/dist/part.js"), `the subpath resolves: ${paths.join(", ")}`);
  assert.ok(!paths.includes("node_modules/small/dist/index.js"), "the package's own entry is not read for a subpath");
});

test("a package the tree does not hold is refused where it is imported", () => {
  assert.throws(
    () =>
      graphOf({
        "main.ts": 'import { a } from "absent-package";\nexport function f(): number {\n  return a();\n}\n',
      }),
    /is not an installed package/,
  );
});

test("the compiler's TOML dependency is read from the package it is installed as", () => {
  const read = (path: string): string | null => {
    const full = join(COMPILER_ROOT, path);
    return existsSync(full) ? readFileSync(full, "utf8") : null;
  };
  const source = [
    'import { parse } from "smol-toml";',
    "export function readProject(text: string): string {",
    "  return text;",
    "}",
    "",
  ].join("\n");
  const records = readModuleGraph({
    frontend: typeScriptFrontend,
    entry: { path: "package-entry.ts", source },
    read,
    reader: tolerant,
  });
  const paths = records.map((record) => record.path);
  assert.ok(paths.includes("node_modules/smol-toml/dist/index.js"), "the package's entry is read");
  assert.ok(paths.includes("node_modules/smol-toml/dist/parse.js"), "the module the entry imports is read");
  // The budget is a ratchet: the package is 1000 lines of JavaScript written
  // for Node, and every construct the frontend learns lowers this number. What
  // is left needs the host classes `Date` and `Temporal`, the enumeration of a
  // dynamic record, and the values a JavaScript source reads without stating
  // their type.
  const total = records.reduce((count, record) => count + record.refusedCount, 0);
  assert.ok(total <= 28, `the package is read but for 28 constructs: ${total}`);
});

/**
 * What is read from a project, and what is refused.
 *
 * A project path is what targets a run at one blaze project, so it is read
 * before any pass — a path that names no project has to be refused before
 * anything is spent on the run, and what it names has to be a project file
 * with a source file behind it. The context the source is read for is what
 * the research query and the proposals are steered by.
 */

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { loadProject, ProjectError } from "../project.ts";
import { craftQuery, extractProjectContext } from "../tavily.ts";
import { scratch } from "./scratch.ts";

/** A project directory naming a source file. */
async function project(source = "export function f(x: number): number { return x; }\n"): Promise<string> {
  const dir = await scratch("blazeopt-project-");
  await writeFile(join(dir, "blaze.toml"), "sourceFile = \"main.ts\"\noutput = \"machine\"\n");
  await writeFile(join(dir, "main.ts"), source);
  return dir;
}

test("a project directory is read, with its source and its context", async () => {
  const dir = await project([
    "export function fib(n: number): number {",
    "  for (let i = 0; i < n; i += 1) { total += i * i; }",
    "  return total;",
    "}",
  ].join("\n"));

  const read = await loadProject(dir);

  assert.equal(read.sourcePath, join(dir, "main.ts"));
  assert.match(read.source, /fib/);
  assert.match(read.context, /recursive algorithms/);
  assert.match(read.context, /loops/);
  assert.match(read.context, /functions: fib/);
});

test("a project file may be named instead of the directory", async () => {
  const dir = await project();
  const read = await loadProject(join(dir, "blaze.toml"));

  assert.equal(read.directory, dir);
});

test("a path that names no project is refused", async () => {
  const dir = await project();

  await assert.rejects(() => loadProject(join(dir, "nope")), (cause) => {
    assert.ok(cause instanceof ProjectError);
    assert.match(cause.message, /no blaze\.toml at/);
    return true;
  });
  await assert.rejects(() => loadProject(join(dir, "missing.toml")), /no blaze\.toml at/);
});

test("a project file that names no source is refused", async () => {
  const dir = await scratch("blazeopt-project-");
  await writeFile(join(dir, "blaze.toml"), "output = \"machine\"\n");

  await assert.rejects(() => loadProject(dir), /does not name a sourceFile/);
});

test("a project whose source file is not there is refused", async () => {
  const dir = await scratch("blazeopt-project-");
  await writeFile(join(dir, "blaze.toml"), "sourceFile = \"gone.ts\"\n");

  await assert.rejects(() => loadProject(dir), /source file not found/);
});

test("a project file that cannot be parsed is refused, saying why", async () => {
  const dir = await scratch("blazeopt-project-");
  await writeFile(join(dir, "blaze.toml"), "this is not = = toml\n");

  await assert.rejects(() => loadProject(dir), /failed to parse/);
});

test("the query is steered by what the source does", () => {
  const general = craftQuery();
  const targeted = craftQuery("domains: tree algorithms; functions: checksum");

  assert.match(general, /^compiler optimization techniques research 2025 2026/);
  assert.match(targeted, /for tree algorithms/);
  assert.doesNotMatch(targeted, /functions:/);
});

test("a source holding nothing distinctive is read as holding nothing", () => {
  assert.equal(extractProjectContext(""), "");
  assert.equal(craftQuery(extractProjectContext("")), craftQuery(""));
});

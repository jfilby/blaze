/**
 * What is read back out of the tree the coding agent worked in, and what is
 * taken out of it.
 *
 * The agent is a program of its own with tools of its own, so nothing it
 * wrote is known in advance: what the tree says it wrote is the whole of
 * what a run has to judge. Each way an edit can be outside that is named
 * here rather than written over — a path that is no part of the compiler, a
 * path the suite the change is judged by is made of, a path nothing had
 * committed at all — and each is taken back out without touching anything
 * else, because the tree is the user's repository.
 */

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { changedPaths, editVerdict, putBack, revertEdits, setAside } from "../agentic.ts";
import { scratch } from "./scratch.ts";

/** A scratch git repository shaped like the blaze one: a compiler package
 *  with its own test directory, beside a file of the user's own. */
async function repository(): Promise<string> {
  const dir = await scratch("blazeopt-tree-");
  await mkdir(join(dir, "src", "compiler", "test"), { recursive: true });
  await writeFile(join(dir, "AGENTS.md"), "# Instructions\n");
  await writeFile(join(dir, "src", "compiler", "codegen.ts"), "// the compiler\n");
  await writeFile(join(dir, "src", "compiler", "test", "ir.test.ts"), "test('x', () => {});\n");
  await writeFile(join(dir, "notes.md"), "# the user's own work\n");
  git(dir, "init", "--quiet");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "test");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "baseline");
  return dir;
}

function git(dir: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
}

test("every path the tree holds differently is named, including a new one", async () => {
  const dir = await repository();
  await writeFile(join(dir, "src", "compiler", "codegen.ts"), "// changed\n");
  await writeFile(join(dir, "src", "compiler", "new-file.ts"), "// written by the agent\n");

  assert.deepEqual(changedPaths(dir).sort(), ["src/compiler/codegen.ts", "src/compiler/new-file.ts"]);
});

test("a file of the compiler may be edited, and one of its tests may not", async () => {
  const dir = await repository();

  assert.equal(editVerdict("src/compiler/codegen.ts", dir), "compiler");
  assert.equal(editVerdict("src/compiler/semantics/repair.ts", dir), "compiler");
  assert.equal(editVerdict("src/compiler/test/ir.test.ts", dir), "test-file");
  assert.equal(editVerdict("src/compiler/codegen.test.ts", dir), "test-file");
});

test("a file that is no part of the compiler may not be edited", async () => {
  const dir = await repository();

  // The optimizer that runs the agent is not the compiler, and neither is
  // anything else in the repository: a change there is somebody else's.
  for (const path of [
    "notes.md",
    "AGENTS.md",
    "src/optimizer/agentic.ts",
    "../outside.ts",
    "/an/absolute/path.ts",
    "src/compiler/../../escape.ts",
  ]) {
    assert.equal(editVerdict(path, dir), "outside-compiler", path);
  }
});

test("a revert restores what the agent wrote and leaves the user's work alone", async () => {
  const dir = await repository();
  await writeFile(join(dir, "src", "compiler", "codegen.ts"), "// the change the agent made\n");
  await writeFile(join(dir, "notes.md"), "# the user's edit in progress\n");

  revertEdits(["src/compiler/codegen.ts"], dir);

  assert.equal(await readFile(join(dir, "src", "compiler", "codegen.ts"), "utf8"), "// the compiler\n");
  assert.equal(await readFile(join(dir, "notes.md"), "utf8"), "# the user's edit in progress\n");
});

test("a file nothing had committed is removed rather than restored", async () => {
  const dir = await repository();
  await writeFile(join(dir, "src", "compiler", "new-file.ts"), "// written by the agent\n");

  revertEdits(["src/compiler/new-file.ts"], dir);

  assert.equal(existsSync(join(dir, "src", "compiler", "new-file.ts")), false);
  assert.deepEqual(changedPaths(dir), []);
});

test("a revert of nothing is nothing to do", async () => {
  const dir = await repository();

  revertEdits([], dir);

  assert.deepEqual(changedPaths(dir), []);
});

test("what an agent staged is taken back out too", async () => {
  const dir = await repository();
  await writeFile(join(dir, "src", "compiler", "codegen.ts"), "// staged by the agent\n");
  git(dir, "add", "-A");

  revertEdits(["src/compiler/codegen.ts"], dir);

  // A checkout of the index would restore the change rather than take it
  // out, so the path is unstaged first.
  assert.equal(await readFile(join(dir, "src", "compiler", "codegen.ts"), "utf8"), "// the compiler\n");
  assert.deepEqual(changedPaths(dir), []);
});

test("a change taken aside and put back measures the same compiler twice", async () => {
  const dir = await repository();
  const changed = "// the change the agent made\n";
  await writeFile(join(dir, "src", "compiler", "codegen.ts"), changed);

  const aside = setAside(["src/compiler/codegen.ts"], dir);
  revertEdits(["src/compiler/codegen.ts"], dir);
  assert.equal(await readFile(join(dir, "src", "compiler", "codegen.ts"), "utf8"), "// the compiler\n");

  putBack(aside, dir);

  assert.equal(await readFile(join(dir, "src", "compiler", "codegen.ts"), "utf8"), changed);
  assert.deepEqual(changedPaths(dir), ["src/compiler/codegen.ts"]);
});

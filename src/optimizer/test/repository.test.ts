/**
 * What the commands do to a repository, and what they must not do.
 *
 * The compiler's package is a directory inside the blaze repository, and
 * the optimizer runs against that repository rather than owning it. So a
 * command given the whole tree — an `add` with no path, a `checkout` of the
 * working directory — takes the user's own work with it: their uncommitted
 * changes would be committed under a blazeopt message, or thrown away by
 * a revert. Every one of these is checked against a scratch repository that
 * holds a change of its own beside the one a pass made.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { commitChanges, uncommittedChanges } from "../cli.ts";
import { scratch } from "./scratch.ts";

/** A scratch git repository with one commit and a file a pass may write. */
async function repository(): Promise<{ dir: string; compilerFile: string; userFile: string }> {
  const dir = await scratch("blazeopt-git-");
  const compilerFile = join(dir, "compiler.ts");
  const userFile = join(dir, "notes.md");
  await writeFile(compilerFile, "// the compiler\n");
  await writeFile(userFile, "# the user's own work\n");
  git(dir, "init", "--quiet");
  // A test repository has no identity of its own, and a commit without one
  // is an error rather than a commit.
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "test");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "baseline");
  return { dir, compilerFile, userFile };
}

function git(dir: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
}

/** What HEAD holds for a file. */
function committed(dir: string, file: string): string {
  return spawnSync("git", ["show", `HEAD:${file}`], { cwd: dir, encoding: "utf8" }).stdout;
}

test("what is uncommitted in the tree is named, and an untracked file is not", async () => {
  const { dir } = await repository();
  await writeFile(join(dir, "compiler.ts"), "// changed\n");
  // A file nobody has committed is not anybody's tracked work: nothing the
  // optimizer does stages or restores one.
  await writeFile(join(dir, "scratch.txt"), "untracked\n");

  assert.deepEqual(uncommittedChanges(dir), [" M compiler.ts"]);
});

test("a clean tree has nothing uncommitted", async () => {
  const { dir } = await repository();
  assert.deepEqual(uncommittedChanges(dir), []);
});

test("a commit stages only the files the pass wrote", async () => {
  const { dir, compilerFile, userFile } = await repository();
  const userWork = "// the user's edit in progress\n";
  const passChange = "// the compiler\n// an improvement\n";
  await writeFile(userFile, userWork);
  await writeFile(compilerFile, passChange);

  commitChanges("code-review", ["compiler.ts: an improvement"], ["compiler.ts"], dir);

  assert.equal(committed(dir, "compiler.ts"), passChange);
  // The user's edit is still in the working tree, and still uncommitted.
  assert.equal(await readFile(userFile, "utf8"), userWork);
  assert.deepEqual(uncommittedChanges(dir), [" M notes.md"]);
  assert.equal(
    spawnSync("git", ["log", "-1", "--pretty=%s"], { cwd: dir, encoding: "utf8" }).stdout.trim(),
    "blazeopt: code-review — 1 improvement(s)",
  );
});

test("a change that rewrites a line into itself commits nothing", async () => {
  const { dir, compilerFile } = await repository();
  const before = await readFile(compilerFile, "utf8");
  // Write the same text back, which is what a change that changes nothing
  // leaves behind.
  await writeFile(compilerFile, before);

  commitChanges("research", ["compiler.ts: nothing changed"], ["compiler.ts"], dir);

  assert.equal(
    spawnSync("git", ["log", "--oneline"], { cwd: dir, encoding: "utf8" }).stdout.trim().split("\n").length,
    1,
    "no new commit",
  );
});

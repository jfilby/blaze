/**
 * What one turn of the loop does with the agent's work.
 *
 * The agent is spawned with tools of its own, so everything it does to the
 * tree is read back out of the tree rather than known in advance. A turn that
 * ends with nothing to keep is still a turn that happened, and one whose
 * agent wrote where it may not has to take that back out: the next turn works
 * on the same repository, and a change nobody has judged is a change the next
 * turn would be working on top of.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { changedPaths } from "../agentic.ts";
import { readAgentEdits } from "../cli.ts";
import { scratch } from "./scratch.ts";

/** A scratch git repository holding the compiler package beside the
 *  repository's own instruction file and some work of the user's. */
async function repository(): Promise<{ dir: string; compilerFile: string; testFile: string; note: string }> {
  const dir = await scratch("blazeopt-turn-");
  await mkdir(join(dir, "src", "compiler", "test"), { recursive: true });
  await writeFile(join(dir, "AGENTS.md"), "# Instructions\n");
  await writeFile(join(dir, "src", "compiler", "codegen.ts"), "// the compiler\n");
  await writeFile(join(dir, "src", "compiler", "test", "ir.test.ts"), "test('x', () => {});\n");
  const note = join(dir, "notes.md");
  await writeFile(note, "# the user's own work\n");
  git(dir, "init", "--quiet");
  // A test repository has no identity of its own, and a commit without one
  // is an error rather than a commit.
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "test");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "baseline");
  return { dir, compilerFile: join(dir, "src", "compiler", "codegen.ts"), testFile: join(dir, "src", "compiler", "test", "ir.test.ts"), note };
}

function git(dir: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
}

/** What the tree says the agent wrote is what the turn keeps and refuses. */
test("what the tree says the agent wrote is what the turn keeps and refuses", async () => {
  const { dir } = await repository();
  await writeFile(join(dir, "src", "compiler", "codegen.ts"), "// an improvement\n");
  await writeFile(join(dir, "src", "compiler", "test", "ir.test.ts"), "test('x', () => { changed(); });\n");
  await writeFile(join(dir, "AGENTS.md"), "# Instructions\n\nrewritten\n");

  const { files, refused } = readAgentEdits(dir);

  assert.deepEqual(files, ["src/compiler/codegen.ts"]);
  assert.deepEqual(
    refused.map((entry) => entry.file).sort(),
    ["AGENTS.md", "src/compiler/test/ir.test.ts"],
  );
  // Every refusal is named for what it is, in the words a record carries.
  assert.deepEqual(
    refused.map((entry) => entry.reason).sort(),
    ["the file is not inside the compiler", "the tests are the gate, not a target"],
  );
});

test("a turn takes back what the agent may not have written", async () => {
  const { dir, testFile } = await repository();
  await writeFile(join(dir, "src", "compiler", "codegen.ts"), "// an improvement\n");
  await writeFile(testFile, "test('x', () => { changed(); });\n");
  await writeFile(join(dir, "AGENTS.md"), "# Instructions\n\nrewritten\n");

  readAgentEdits(dir);

  // The instruction file and the test file are back the way they were, so the
  // change is judged by the suite it was written under.
  assert.match(await readFile(testFile, "utf8"), /^test\('x', \(\) => \{\}\);\n$/);
  assert.match(await readFile(join(dir, "AGENTS.md"), "utf8"), /^# Instructions\n$/);
  // What the turn keeps is the only thing left in the tree.
  assert.deepEqual(changedPaths(dir), ["src/compiler/codegen.ts"]);
});

test("a turn whose agent wrote only where it may not keeps nothing", async () => {
  const { dir, note } = await repository();
  await writeFile(join(dir, "AGENTS.md"), "# Instructions\n\nrewritten by the agent\n");

  const { files, refused } = readAgentEdits(dir);

  assert.deepEqual(files, []);
  assert.equal(refused.length, 1);
  // The tree is whole again, and the user's own work was never in the way.
  assert.deepEqual(changedPaths(dir), []);
  assert.equal(await readFile(note, "utf8"), "# the user's own work\n");
});

test("a new file in a new directory is one file, not a directory", async () => {
  const { dir } = await repository();
  // The agent wrote a new pass into a directory the repository does not hold
  // yet: a run that read that as a directory would take the files with it.
  await mkdir(join(dir, "src", "compiler", "semantics"), { recursive: true });
  await writeFile(join(dir, "src", "compiler", "semantics", "new-pass.ts"), "// a new pass\n");
  await writeFile(join(dir, "src", "compiler", "semantics", "helper.ts"), "// a helper\n");

  const { files } = readAgentEdits(dir);

  assert.deepEqual(files.sort(), ["src/compiler/semantics/helper.ts", "src/compiler/semantics/new-pass.ts"]);
});

test("a file the agent may have written is kept, and one it may not is removed", async () => {
  const { dir } = await repository();
  await mkdir(join(dir, "src", "compiler", "semantics"), { recursive: true });
  await writeFile(join(dir, "src", "compiler", "semantics", "new-pass.ts"), "// a new pass\n");
  await mkdir(join(dir, "src", "optimizer"), { recursive: true });
  await writeFile(join(dir, "src", "optimizer", "not-mine.ts"), "// not the optimizer's to write\n");

  const { files, refused } = readAgentEdits(dir);

  assert.deepEqual(files, ["src/compiler/semantics/new-pass.ts"]);
  assert.equal(refused.length, 1);
  // The file outside the compiler is gone, and the one inside it is still there.
  assert.equal(await readFile(join(dir, "src", "compiler", "semantics", "new-pass.ts"), "utf8"), "// a new pass\n");
  assert.deepEqual(changedPaths(dir), ["src/compiler/semantics/new-pass.ts"]);
});

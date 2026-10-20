/**
 * A SQLite program, built and run.
 *
 * The build's own verification is the assertion: the source runs on node and
 * the delivered binary runs beside it, and the two have to print the same
 * thing. The test asserts that the build succeeded, and that the binary
 * printed what the source prints.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runBuild } from "../compiler.ts";
import { scratch } from "./scratch.ts";
import { writeProject } from "./project.ts";
import { run } from "../core/process.ts";

const QUIET = { stage: () => {} };

/**
 * A program that opens a database in memory, creates a table, inserts a row and
 * reads it back.
 *
 * The database is in memory because the two runs of the verification must not
 * share one: the source runs first and the binary second, both in the
 * project's own directory, so a program that keeps its data in a file writes it
 * in the source run and finds it again in the binary run.
 */
const PROGRAM = `const db = sqlite.open(":memory:");
sqlite.exec(db, "CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT)");

const insert = sqlite.prepare(db, "INSERT INTO notes (body) VALUES (?)");
sqlite.bindText(insert, 1, "the first note");
sqlite.step(insert);
sqlite.finalize(insert);

const read = sqlite.prepare(db, "SELECT id, body FROM notes ORDER BY id");
while (sqlite.step(read) > 0) {
  console.log(sqlite.columnNumber(read, 0), sqlite.columnText(read, 1));
}
sqlite.finalize(read);
sqlite.close(db);
`;

interface Built {
  binary: string;
  stdout: string;
}

/** Builds a program and runs the binary it delivered. */
async function buildProgram(source: string, backend: "c" | "machine" = "c"): Promise<Built> {
  const directory = await scratch(`blaze-sqlite-${backend}-`);
  await writeFile(join(directory, "main.ts"), source, "utf8");
  await writeProject(join(directory, "blaze.toml"), {
    language: "typescript",
    sourceFile: "main.ts",
    output: "machine",
    backend,
    mode: "debug",
    runtime: "none",
  });
  const outcome = await runBuild(
    "blaze.toml",
    { cwd: directory, reuse: false, model: "openai-compatible/stub", maxAttempts: 1 },
    QUIET,
    "build",
  );
  assert.equal(outcome.build.status, "success", `${backend} build succeeded`);
  assert.ok(outcome.outputPath !== null, `${backend} build delivered a binary`);
  const binary = outcome.outputPath as string;
  const ran = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(ran.code, 0, ran.stderr);
  return { binary, stdout: ran.stdout };
}

test("a program that uses SQLite is built and prints what its source prints", async () => {
  const built = await buildProgram(PROGRAM);
  assert.equal(built.stdout.trim(), "1 the first note", "the program printed the row it read back");
});

test("the machine backend builds a program that uses SQLite too", async () => {
  const built = await buildProgram(PROGRAM, "machine");
  assert.equal(built.stdout.trim(), "1 the first note", "the machine backend printed the row it read back");
});

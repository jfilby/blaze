/**
 * The SQLite facility: every call of it, exercised by a program.
 *
 * The program calls each entry point of the ABI and is built and run, so that
 * every one of them is exercised by a program and not only by a unit test.
 * The build's own verification is the assertion: the source runs on node and
 * the binary runs beside it, and the two have to print the same thing, which
 * is what says that the C adapter and the JavaScript prelude agree.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runBuild } from "../compiler.ts";
import { generateProgramDriver } from "../toolchain/driver.ts";
import { phaseOf } from "./phase.ts";
import { resolveProgram } from "../semantics/ir-resolve.ts";
import { scratch } from "./scratch.ts";
import { writeProject } from "./project.ts";
import { run } from "../core/process.ts";

const QUIET = { stage: () => {} };

/**
 * A program that calls every call of the facility.
 *
 * The database is in memory, because the two runs of the verification must
 * not share one: the source runs first and the binary second, both in the
 * project's own directory.
 */
const PROGRAM = `const db = sqlite.open(":memory:");
console.log(sqlite.exec(db, "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, score REAL, note TEXT)"));

const insert = sqlite.prepare(db, "INSERT INTO t (name, score, note) VALUES (?, ?, ?)");
sqlite.bindText(insert, 1, "first");
sqlite.bindNumber(insert, 2, 1.5);
sqlite.bindNull(insert, 3);
console.log(sqlite.step(insert));
sqlite.finalize(insert);
console.log(sqlite.changes(db));
console.log(sqlite.lastInsertRowid(db));

const read = sqlite.prepare(db, "SELECT id, name, score, note FROM t");
console.log(sqlite.columnCount(read));
while (sqlite.step(read) > 0) {
  console.log(sqlite.columnType(read, 0), sqlite.columnType(read, 1), sqlite.columnType(read, 2), sqlite.columnType(read, 3));
  console.log(sqlite.columnNumber(read, 0), sqlite.columnText(read, 1), sqlite.columnNumber(read, 2));
}
sqlite.finalize(read);
console.log(sqlite.error(db));
sqlite.close(db);
`;

/** The expected output of the program above. */
const EXPECTED = ["1", "0", "1", "1", "4", "1 3 2 0", "1 first 1.5", "not an error"].join("\n");

test("a program that calls every call of the SQLite facility is built and run", async () => {
  const directory = await scratch("blaze-sqlite-facility-");
  await writeFile(join(directory, "main.ts"), PROGRAM, "utf8");
  await writeProject(join(directory, "blaze.toml"), {
    language: "typescript",
    sourceFile: "main.ts",
    output: "machine",
    backend: "c",
    mode: "debug",
    runtime: "none",
  });
  const outcome = await runBuild(
    "blaze.toml",
    { cwd: directory, reuse: false, model: "openai-compatible/stub", maxAttempts: 1 },
    QUIET,
    "build",
  );
  assert.equal(outcome.build.status, "success", "the build succeeded");
  assert.ok(outcome.outputPath !== null, "the build delivered a binary");
  const ran = run(outcome.outputPath as string, [], { timeoutMs: 60_000 });
  assert.equal(ran.code, 0, ran.stderr);
  assert.equal(ran.stdout.trim(), EXPECTED, "every call of the facility answered what it should");
});

/** The driver a program that uses SQLite is written as. */
function driverFor(source: string): string {
  const phase = phaseOf("typescript", { "main.ts": source }, "main.ts");
  if (phase.body === undefined) throw new Error("no program body");
  const resolved = resolveProgram(phase.body, phase.program, phase.objectNames, phase.objectLayouts, phase.objectKeys);
  return generateProgramDriver(resolved, false, "c", true);
}

test("the calls of the SQLite facility lower to the entry points of the ABI", () => {
  const written = driverFor(`const db = sqlite.open(":memory:");
const stmt = sqlite.prepare(db, "SELECT 1");
sqlite.bindText(stmt, 1, "a");
sqlite.bindNumber(stmt, 1, 2);
sqlite.bindNull(stmt, 1);
sqlite.step(stmt);
sqlite.columnCount(stmt);
sqlite.columnType(stmt, 0);
sqlite.columnNumber(stmt, 0);
sqlite.columnText(stmt, 0);
sqlite.finalize(stmt);
sqlite.exec(db, "SELECT 1");
sqlite.changes(db);
sqlite.lastInsertRowid(db);
sqlite.error(db);
sqlite.close(db);
`);
  for (const symbol of [
    "blaze_sqlite_open",
    "blaze_sqlite_prepare",
    "blaze_sqlite_bind_text",
    "blaze_sqlite_bind_number",
    "blaze_sqlite_bind_null",
    "blaze_sqlite_step",
    "blaze_sqlite_column_count",
    "blaze_sqlite_column_type",
    "blaze_sqlite_column_number",
    "blaze_sqlite_column_text",
    "blaze_sqlite_finalize",
    "blaze_sqlite_exec",
    "blaze_sqlite_changes",
    "blaze_sqlite_last_insert_rowid",
    "blaze_sqlite_error",
    "blaze_sqlite_close",
  ]) {
    assert.match(written, new RegExp(symbol), `${symbol} is called by the driver`);
  }
  assert.match(written, /#include "blaze_sqlite\.h"/, "the driver includes the header of the ABI");
});

test("a program that does not use SQLite includes no SQLite header", () => {
  const phase = phaseOf("typescript", { "main.ts": 'console.log("hello");' }, "main.ts");
  if (phase.body === undefined) throw new Error("no program body");
  const resolved = resolveProgram(phase.body, phase.program, phase.objectNames, phase.objectLayouts, phase.objectKeys);
  const written = generateProgramDriver(resolved, false, "c", false);
  assert.ok(!written.includes("blaze_sqlite"), "a program that does not use SQLite names no SQLite symbol");
});

test("a function of a program body may use SQLite", async () => {
  const program = `const db = sqlite.open(":memory:");
sqlite.exec(db, "CREATE TABLE notes (id INTEGER PRIMARY KEY)");
const insert = sqlite.prepare(db, "INSERT INTO notes (id) VALUES (?)");
sqlite.bindNumber(insert, 1, 1);
sqlite.step(insert);
sqlite.finalize(insert);

function rows(db: number): number {
  let count = 0;
  const read = sqlite.prepare(db, "SELECT id FROM notes");
  while (sqlite.step(read) > 0) {
    count = count + 1;
  }
  sqlite.finalize(read);
  return count;
}

console.log(rows(db));
sqlite.close(db);
`;
  const directory = await scratch("blaze-sqlite-function-");
  await writeFile(join(directory, "main.ts"), program, "utf8");
  await writeProject(join(directory, "blaze.toml"), {
    language: "typescript",
    sourceFile: "main.ts",
    output: "machine",
    backend: "c",
    mode: "debug",
    runtime: "none",
  });
  const outcome = await runBuild(
    "blaze.toml",
    { cwd: directory, reuse: false, model: "openai-compatible/stub", maxAttempts: 1 },
    QUIET,
    "build",
  );
  assert.equal(outcome.build.status, "success", "the build succeeded");
  const ran = run(outcome.outputPath as string, [], { timeoutMs: 60_000 });
  assert.equal(ran.code, 0, ran.stderr);
  assert.equal(ran.stdout.trim(), "1", "the function of the program body read the row");
});

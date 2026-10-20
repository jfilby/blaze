/**
 * The SQLite ABI: the table of the entry points, the header it generates, the
 * allowlist the sandboxes admit, and the adapter that implements it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { SQLITE_ABI, isSqliteSymbol, sqliteHeaderSource, usesSqliteSource } from "../runtime/sqlite.ts";
import { sqliteAdapterSource } from "../runtime/sqlite-build.ts";
import { isRuntimeSymbol } from "../runtime/abi.ts";

test("the SQLite ABI declares every entry the API promises", () => {
  const header = sqliteHeaderSource();
  for (const entry of SQLITE_ABI) {
    assert.ok(header.includes(entry.symbol), `${entry.symbol} must be declared in the SQLite header`);
    assert.ok(entry.summary.length > 0, `${entry.symbol} must say what it does`);
    assert.ok(entry.ownership.length > 0, `${entry.symbol} must say what it owns`);
  }
  // The API of the facility is the whole of the table: nothing is named twice.
  const symbols = SQLITE_ABI.map((entry) => entry.symbol);
  assert.equal(new Set(symbols).size, symbols.length, "no entry point is declared twice");
});

test("the SQLite header declares the entry points with the types the ABI holds", () => {
  const header = sqliteHeaderSource();
  assert.match(header, /double blaze_sqlite_open\(const char\* path\);/);
  assert.match(header, /void blaze_sqlite_close\(double db\);/);
  assert.match(header, /double blaze_sqlite_exec\(double db, const char\* sql\);/);
  assert.match(header, /double blaze_sqlite_prepare\(double db, const char\* sql\);/);
  assert.match(header, /void blaze_sqlite_bind_text\(double stmt, double index, const char\* value\);/);
  assert.match(header, /void blaze_sqlite_bind_number\(double stmt, double index, double value\);/);
  assert.match(header, /void blaze_sqlite_bind_null\(double stmt, double index\);/);
  assert.match(header, /double blaze_sqlite_step\(double stmt\);/);
  assert.match(header, /double blaze_sqlite_column_count\(double stmt\);/);
  assert.match(header, /double blaze_sqlite_column_type\(double stmt, double index\);/);
  assert.match(header, /double blaze_sqlite_column_number\(double stmt, double index\);/);
  assert.match(header, /const char\* blaze_sqlite_column_text\(double stmt, double index\);/);
  assert.match(header, /void blaze_sqlite_finalize\(double stmt\);/);
  assert.match(header, /double blaze_sqlite_changes\(double db\);/);
  assert.match(header, /double blaze_sqlite_last_insert_rowid\(double db\);/);
  assert.match(header, /const char\* blaze_sqlite_error\(double db\);/);
});

test("the SQLite header keeps SQLite's own types out of it", () => {
  const header = sqliteHeaderSource();
  assert.ok(!header.includes("sqlite3"), "the SQLite header must not expose SQLite's own types");
  assert.ok(!header.includes("SQLITE_OK"), "the SQLite header must not expose SQLite's own constants");
  assert.ok(!header.includes("SQLITE_ROW"), "the SQLite header must not expose SQLite's own constants");
});

test("SQLite symbols are allowed by the runtime symbol boundary", () => {
  for (const entry of SQLITE_ABI) {
    assert.ok(isSqliteSymbol(entry.symbol), `${entry.symbol} must be a SQLite symbol`);
    assert.ok(isRuntimeSymbol(entry.symbol), `${entry.symbol} must be a generatable symbol`);
  }
  assert.ok(!isSqliteSymbol("blaze_rt_allocate"), "a core runtime symbol is not a SQLite symbol");
  assert.ok(!isSqliteSymbol("blaze_sqlite_unknown"), "an unknown symbol is not a SQLite symbol");
});

test("the adapter implements exactly the entry points the ABI names", () => {
  const source = sqliteAdapterSource();
  const written = [...source.matchAll(/^(?:double|void|const char\*) (blaze_sqlite_[a-z_]+)\(/gm)].map((match) => match[1]);
  for (const entry of SQLITE_ABI) {
    assert.ok(written.includes(entry.symbol), `the adapter must implement ${entry.symbol}`);
  }
  assert.equal(written.length, SQLITE_ABI.length, "the adapter implements nothing the ABI does not name");
});

test("the adapter keeps SQLite's types to itself", () => {
  const source = sqliteAdapterSource();
  // The adapter is the only place SQLite's own types appear: the boundary is
  // a number and a pointer to text.
  assert.ok(source.includes("sqlite3_open"), "the adapter opens the database");
  assert.ok(source.includes("sqlite3_prepare_v2"), "the adapter compiles the statements");
  assert.ok(!source.includes("sqlite3* blaze_sqlite_"), "no entry point hands a SQLite type to a program");
});

test("a source that names the facility is a source that uses it", () => {
  assert.ok(usesSqliteSource("const db = sqlite.open(\":memory:\");"), "a source that calls the facility uses it");
  assert.ok(!usesSqliteSource("console.log(\"hello\");"), "a source that does not name the facility does not use it");
});

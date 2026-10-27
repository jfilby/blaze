/**
 * The blaze SQLite runtime ABI, backed by the SQLite C library.
 *
 * The boundary is one table, and everything else is generated from it: the C
 * header a program includes, the allowlist the sandboxes admit, and the
 * implementation that answers the entry points. The shape is the shape of
 * `runtime/http.ts`, and it is the shape a SQLite facility has to have, so that
 * the two sides of it cannot drift.
 */

import { withoutComments } from "../util/source.ts";

export const SQLITE_NAME = "blaze_sqlite";

/** One entry point of the SQLite ABI. */
export interface SqliteEntry {
  symbol: string;
  returns: string;
  params: readonly (readonly [name: string, type: string])[];
  summary: string;
  ownership: string;
}

function sqliteEntry(
  symbol: string,
  returns: string,
  params: readonly (readonly [string, string])[],
  summary: string,
  ownership: string,
): SqliteEntry {
  return { symbol, returns, params, summary, ownership };
}

/**
 * The SQLite ABI, in call order. Every entry is implemented by the adapter
 * (`runtime/sqlite-build.ts`) over the vendored amalgamation and declared in
 * the generated `blaze_sqlite.h`. Nothing here names a SQLite type: a program
 * that links only the compiler runtime never sees this header.
 *
 * A handle is a number that holds a pointer. The adapter boxes every handle it
 * answers, so a handle is a value the runtime knows and printing one prints a
 * number and not the bytes of a struct it points at.
 */
export const SQLITE_ABI: readonly SqliteEntry[] = [
  sqliteEntry(
    "blaze_sqlite_open",
    "double",
    [["path", "const char*"]],
    "Opens the database at the path, creating it when it is not there. The path \":memory:\" is a database in memory.",
    "Returns an owned handle; a path that cannot be opened is a failure and the program stops with SQLite's own message.",
  ),
  sqliteEntry(
    "blaze_sqlite_close",
    "void",
    [["db", "double"]],
    "Closes the connection and finalizes the statements it holds.",
    "The handle is no longer valid after this; closing it twice is ignored.",
  ),
  sqliteEntry(
    "blaze_sqlite_exec",
    "double",
    [
      ["db", "double"],
      ["sql", "const char*"],
    ],
    "Runs the statements of the SQL that answer no rows.",
    "Answers 1 when the statements ran and 0 when they did not; the message of the failure is kept by the connection and is read with blaze_sqlite_error.",
  ),
  sqliteEntry(
    "blaze_sqlite_prepare",
    "double",
    [
      ["db", "double"],
      ["sql", "const char*"],
    ],
    "Compiles one statement.",
    "Returns an owned handle; a statement that does not compile is a failure and the program stops with SQLite's own message.",
  ),
  sqliteEntry(
    "blaze_sqlite_bind_text",
    "void",
    [
      ["stmt", "double"],
      ["index", "double"],
      ["value", "const char*"],
    ],
    "Binds a parameter to text. The index is 1-based, as SQLite counts them.",
    "The text is copied by SQLite, so the program may release its own copy at any time.",
  ),
  sqliteEntry(
    "blaze_sqlite_bind_number",
    "void",
    [
      ["stmt", "double"],
      ["index", "double"],
      ["value", "double"],
    ],
    "Binds a parameter to a number.",
    "The number is a double, as every number of a program is.",
  ),
  sqliteEntry(
    "blaze_sqlite_bind_null",
    "void",
    [
      ["stmt", "double"],
      ["index", "double"],
    ],
    "Binds a parameter to null.",
    "Nothing is owned.",
  ),
  sqliteEntry(
    "blaze_sqlite_step",
    "double",
    [["stmt", "double"]],
    "Runs the statement one row at a time.",
    "Answers 1 while there is a row and 0 when there is none; a row that cannot be read is a failure and the program stops with SQLite's own message.",
  ),
  sqliteEntry(
    "blaze_sqlite_column_count",
    "double",
    [["stmt", "double"]],
    "How many columns the row has.",
    "Answers the count.",
  ),
  sqliteEntry(
    "blaze_sqlite_column_type",
    "double",
    [
      ["stmt", "double"],
      ["index", "double"],
    ],
    "The kind of the column: 0 null, 1 integer, 2 float, 3 text, 4 blob.",
    "Answers the kind; the index of a column is 0-based, as SQLite counts them.",
  ),
  sqliteEntry(
    "blaze_sqlite_column_number",
    "double",
    [
      ["stmt", "double"],
      ["index", "double"],
    ],
    "The column as a number.",
    "Answers the number; a whole number above 2^53 is not the number it was.",
  ),
  sqliteEntry(
    "blaze_sqlite_column_text",
    "const char*",
    [
      ["stmt", "double"],
      ["index", "double"],
    ],
    "The column as text.",
    "Returns a copy of the text in the runtime's own text, so the program holds it after the statement is stepped again. A null column answers an empty text.",
  ),
  sqliteEntry(
    "blaze_sqlite_finalize",
    "void",
    [["stmt", "double"]],
    "Releases the statement.",
    "The handle is no longer valid after this; finalizing it twice is ignored.",
  ),
  sqliteEntry(
    "blaze_sqlite_changes",
    "double",
    [["db", "double"]],
    "How many rows the last statement changed.",
    "Answers the count.",
  ),
  sqliteEntry(
    "blaze_sqlite_last_insert_rowid",
    "double",
    [["db", "double"]],
    "The rowid of the last row inserted.",
    "Answers the rowid.",
  ),
  sqliteEntry(
    "blaze_sqlite_error",
    "const char*",
    [["db", "double"]],
    "The message of the last failure of the connection.",
    "Returns a copy of the message in the runtime's own text.",
  ),
];

/** Symbols generated SQLite code may reference. Nothing else resolves at link time. */
export const SQLITE_SYMBOLS: Record<string, true> = Object.fromEntries(
  SQLITE_ABI.map((item) => [item.symbol, true as const]),
);

/** True when generated code is allowed to reference a SQLite symbol. */
export function isSqliteSymbol(symbol: string): boolean {
  return SQLITE_SYMBOLS[symbol] === true;
}

/**
 * Whether a source uses the SQLite facility.
 *
 * The facility is named as a global, in the manner of `http`: the source names
 * it and the compiler reads the calls out of it. The word is what says so, and
 * the same rule the HTTP facility uses: the verification has to decide from
 * the source whether to give it a `sqlite` to call, so the rule has to be one
 * the source can be asked about.
 */
export function usesSqliteSource(source: string): boolean {
  // The word is read from the code: a comment that mentions SQLite is prose
  // about a program nobody runs, and linking the library for it is a cost the
  // program pays without using it.
  return /\bsqlite\b/.test(withoutComments(source));
}

const SQLITE_HEADER_PREAMBLE = `#ifndef BLAZE_SQLITE_H
#define BLAZE_SQLITE_H

#include <stddef.h>
#include <stdint.h>

/*
 * The blaze SQLite runtime ABI, backed by the SQLite C library. A handle is
 * a number that holds a pointer: it is boxed by the runtime, so a program that
 * prints one prints a number and not the bytes of a struct it points at.
 */
`;

const SQLITE_HEADER_EPILOGUE = `
#endif
`;

/** The C header a program that uses SQLite includes. */
export function sqliteHeaderSource(): string {
  const declarations = SQLITE_ABI.map((item) => {
    return `${item.returns} ${item.symbol}(${
      item.params.length === 0 ? "void" : item.params.map(([name, type]) => `${type} ${name}`).join(", ")
    });`;
  }).join("\n");
  return `${SQLITE_HEADER_PREAMBLE}\n${declarations}\n${SQLITE_HEADER_EPILOGUE}`;
}

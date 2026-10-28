/**
 * Builtins: the functions a source may call that the program does not declare.
 *
 * They are fixed by the compiler, not by the source, so one table states what
 * each takes and what it returns. A frontend reads them from a source name, the
 * object pass types a call through them, and the driver emits them.
 */

import type { Effect, TypeExpr } from "../core/types.ts";
import type { SemanticType } from "../core/semantic-ir.ts";
import { TEXT } from "../core/semantic-ir.ts";

export interface BuiltinSignature {
  params: SemanticType[];
  returns: SemanticType;
  /** How many arguments the call must have, when the count is fixed. */
  arity?: number;
  /** Every count the call may have, when more than one form lowers. Argument
   * positions past the count are named by params all the same, so the first
   * `arities.length` params of the longest form decide each argument's type. */
  arities?: readonly number[];
  /**
   * What the call does beyond answering: a call that reads the world is not a
   * value the optimizer may compute twice or move, so what a builtin has an
   * effect on is stated here.
   */
  effects?: readonly Effect[];
  /**
   * True when only a module function may call it.
   *
   * The HTTP API of a module function is one: a module function holds the
   * request and the response in references, and a program body holds them in
   * dynamic values, and the two are not the same thing. A program body reads
   * the request with `req.path` and answers it with `res.end`.
   */
  moduleOnly?: boolean;
}

const F64: TypeExpr = { kind: "primitive", name: "f64" };
const I64: TypeExpr = { kind: "primitive", name: "i64" };
const USIZE: TypeExpr = { kind: "primitive", name: "usize" };
const U64: TypeExpr = { kind: "primitive", name: "u64" };
const U256: TypeExpr = { kind: "primitive", name: "u256" };
const ANY: TypeExpr = { kind: "ref", of: null };

/**
 * What a call of the SQLite facility has an effect on.
 *
 * A database is a file and a statement is a read of it, so every call of the
 * facility reads the filesystem and does I/O. Without these the optimizer may
 * copy a call out of a loop, because a call with no effects is a value it may
 * compute twice, and a loop that writes rows may be marked parallel.
 */
const SQLITE_EFFECTS: readonly Effect[] = ["filesystem", "io"];

/**
 * The name a block of bytes a program laid out is allocated under. The
 * runtime provides the block and the views over it are the compiler's: what the
 * program writes is `new SharedArrayBuffer(bytes)`, and this is what that is.
 */
export const SHARED = "sharedBlock";

/** The name the length of `process.argv` is read under. */
export const ARGV_LENGTH = "argvLength";

/** The name the nth argument a program was given is read under. */
export const ARGV = "argv";

export const BUILTINS: Record<string, BuiltinSignature> = {
  "Math.max": { params: [F64, F64], returns: F64, arity: 2 },
  "blaze_rt_dict_new": { params: [], returns: F64, arity: 0 },
  "blaze_rt_dict_get": { params: [F64, TEXT], returns: F64, arity: 2 },
  "blaze_rt_dict_set": { params: [F64, TEXT, F64], returns: F64, arity: 3 },
  "blaze_rt_dict_has": { params: [F64, TEXT], returns: F64, arity: 2 },
  "blaze_rt_dict_len": { params: [F64], returns: F64, arity: 1 },
  "Math.min": { params: [F64, F64], returns: F64, arity: 2 },
  "Math.sqrt": { params: [F64], returns: F64, arity: 1 },
  "Math.abs": { params: [F64], returns: F64, arity: 1 },
  "Math.floor": { params: [F64], returns: F64, arity: 1 },
  "Math.round": { params: [F64], returns: F64, arity: 1 },
  "Math.trunc": { params: [F64], returns: F64, arity: 1 },
  "Math.ceil": { params: [F64], returns: F64, arity: 1 },
  "Math.random": { params: [], returns: F64, arity: 0 },
  /**
   * The magnitude of a whole number, which is a whole number. The `Math.abs`
   * above answers a fraction, and a language whose whole numbers are whole
   * answers the magnitude of one as a whole number: the two are two kinds of
   * number, and the printer writes them differently.
   */
  "whole.abs": { params: [I64], returns: I64, arity: 1 },
  /** The smaller of two whole numbers, which is a whole number. */
  "whole.min": { params: [I64, I64], returns: I64, arity: 2 },
  /** The larger of two whole numbers, which is a whole number. */
  "whole.max": { params: [I64, I64], returns: I64, arity: 2 },
  /**
   * A number as a whole number: the floor of it, the ceiling of it, and the
   * whole part of it. The three are the answers of the languages whose whole
   * numbers are whole numbers, and each is a whole number.
   */
  "whole.floor": { params: [F64], returns: I64, arity: 1 },
  "whole.ceil": { params: [F64], returns: I64, arity: 1 },
  "whole.trunc": { params: [F64], returns: I64, arity: 1 },
  [SHARED]: { params: [USIZE], returns: { kind: "ptr", of: { kind: "primitive", name: "u8" } }, arity: 1 },
  [ARGV_LENGTH]: { params: [], returns: USIZE, arity: 0 },
  /**
   * `argv(n)` is the nth argument the program was given, read as the number
   * it states: the runtime reads each argument once, before the program runs,
   * and the answer is the number the language gives — 0b101 is five and " 10 "
   * is ten. The argument the program was not given is NaN.
   */
  [ARGV]: { params: [USIZE], returns: F64, arity: 1 },
  /** `u256_from_u64x2(low, high)` builds a `u256` from two 64-bit halves, so a
   *  value that fits in 128 bits can be constructed from its low and high limbs
   *  and the upper limbs are zero. */
  "u256_from_u64x2": { params: [U64, U64], returns: U256, arity: 2 },
  /** `u256_from_u64x4(l0, l1, l2, l3)` builds a `u256` from four 64-bit limbs,
   *  least significant first, so any 256-bit value can be constructed. */
  "u256_from_u64x4": { params: [U64, U64, U64, U64], returns: U256, arity: 4 },
  /** `u256_add_mod(a, b, m)` computes (a + b) mod m without u256 wraparound. */
  "u256_add_mod": { params: [U256, U256, U256], returns: U256, arity: 3 },
  /** `u256_sub_mod(a, b, m)` computes (a - b) mod m without u256 wraparound. */
  "u256_sub_mod": { params: [U256, U256, U256], returns: U256, arity: 3 },
  /** `u256_mul_mod(a, b, m)` computes (a * b) mod m without u256 wraparound. */
  "u256_mul_mod": { params: [U256, U256, U256], returns: U256, arity: 3 },
  /** `u256_div(a, b)` computes integer division a / b. */
  "u256_div": { params: [U256, U256], returns: U256, arity: 2 },
  /** `u256_invert_mod(a, m)` computes the number `x` below `m` for which
   *  `a * x` is one modulo `m`. The modulus must be odd; a value with no
   *  inverse answers zero. */
  "u256_invert_mod": { params: [U256, U256], returns: U256, arity: 2 },
  "require": { params: [ANY], returns: ANY, arity: 1 },
  /** `text.indexOf(needle)` answers where the needle first says itself in the
   *  text, counted in bytes from the front, and -1 where it never does. */
  "text.indexOf": { params: [TEXT, TEXT], returns: F64, arity: 2 },
  /** `text.slice(start, stop)` answers the text between two indexes, and
   *  `text.slice(start)` the text from one index to the end. An index below
   *  zero counts back from the end, and an index past the end stops there. */
  "text.slice": { params: [TEXT, F64, F64], returns: TEXT, arities: [2, 3] },
  /** `text.trim()` answers the text with the whitespace at both ends gone:
   *  the ends of a line a file is read with arrive still attached to it. */
  "text.trim": { params: [TEXT], returns: TEXT, arity: 1 },
  "JSON.stringify": { params: [ANY], returns: ANY, arity: 1 },
  "JSON.parse": { params: [ANY], returns: ANY, arity: 1 },
  /** `JSON.get(value, key)` reads one field of a dynamic object the runtime
   *  parsed, and answers the value the field names. A field the object does
   *  not carry, and a value that is not an object at all, answer nothing. */
  "JSON.get": { params: [ANY, TEXT], returns: ANY, arity: 2 },
  "crypto.createHash": { params: [ANY], returns: ANY, arity: 1 },
  "fs.readFileSync": { params: [ANY, ANY], returns: ANY, arity: 2 },
  /** `process.env.NAME` reads an environment variable as the text it is set
   *  to. A name the environment does not set is the empty text, which is what
   *  a program reads a configuration value that is not there as. */
  "process.env": { params: [TEXT], returns: TEXT, arity: 1 },
  "hasher.update": { params: [ANY, ANY, ANY], returns: ANY, arity: 3 },
  "hasher.update.digest": { params: [ANY, ANY], returns: ANY, arity: 2 },
  "array.new": { params: [], returns: ANY, arity: 0 },
  "array.push": { params: [ANY, ANY], returns: ANY, arity: 2 },
  /** `a[i]` where `a` is a dynamic array: the element the runtime holds. */
  "array.get": { params: [ANY, USIZE], returns: F64, arity: 2 },
  /** `a.length` where `a` is a dynamic array: how many elements it holds. */
  "array.length": { params: [ANY], returns: USIZE, arity: 1 },
  "fetch": { params: [ANY, ANY, ANY, ANY], returns: ANY, arity: 4 },
  /** `http.request(url, method, headers, body)` performs one request synchronously,
   * and `http.request(url, options, callback)` opens a buffered request whose
   * `data`/`end`/`error` events fire when the request is sent: the callback is
   * given the response, every `res.on` listener of it fires when the response
   * has arrived, and `req.on("error")` fires when the request could not be made. */
  "http.request": { params: [ANY, ANY, ANY, ANY], returns: ANY, arities: [3, 4] },
  "Bun.serve": { params: [ANY], returns: ANY, arity: 1 },
  "process.exit": { params: [ANY], returns: ANY, arity: 1 },
  "parseInt": { params: [ANY], returns: F64, arity: 1 },
  /** `Number(value)` reads the number a value is written at: a string is the
   * number its text states, a dynamic value is the number it holds, and a
   * reading of text is what `+text` is the sign in front of one. */
  "Number": { params: [ANY], returns: F64, arity: 1 },
  /** `http.serve(port)` starts an HTTP server on the port and runs it until the
   * process is stopped. Every route answers with "Hello, World". The call never
   * returns while the server runs. */
  "http.serve": { params: [USIZE], returns: { kind: "void" }, arity: 1 },
  /** `http.serveSettings(port, maxClients, maxBodySize, maxHeaderSize, timeout, threads, workers)`
   * starts an HTTP server with resource limits, a connection timeout (seconds)
   * and a thread/worker count. The call never returns while the server runs. */
  "http.serveSettings": {
    params: [USIZE, USIZE, USIZE, USIZE, USIZE, USIZE, USIZE],
    returns: { kind: "void" },
    arity: 7,
  },
  /** `http.serveTls(port, cert, key)` starts an HTTPS (TLS) server on the port
   * using the given certificate and private key files. The call never returns
   * while the server runs. */
  "http.serveTls": { params: [USIZE, ANY, ANY], returns: { kind: "void" }, arity: 3 },
  /* ---------------------------------------------------------------------- */
  /* Triton / kernel builtins                                                 */
  /* ---------------------------------------------------------------------- */
  "tl.load": { params: [ANY, ANY, ANY], returns: F64, arities: [1, 2, 3] },
  "tl.store": { params: [ANY, ANY, ANY, ANY], returns: { kind: "void" }, arities: [2, 3, 4] },
  "tl.program_id": { params: [ANY], returns: F64, arities: [0, 1] },
  "tl.num_programs": { params: [ANY], returns: F64, arities: [0, 1] },
  "tl.arange": { params: [ANY, ANY], returns: F64, arity: 2 },
  "tl.full": { params: [ANY, ANY, ANY], returns: F64, arities: [2, 3] },
  "tl.zeros": { params: [ANY, ANY], returns: F64, arities: [1, 2] },
  "tl.ones": { params: [ANY, ANY], returns: F64, arities: [1, 2] },
  "tl.where": { params: [ANY, ANY, ANY], returns: ANY, arity: 3 },
  "tl.math.exp": { params: [ANY], returns: F64, arity: 1 },
  "tl.math.log": { params: [ANY], returns: F64, arity: 1 },
  "tl.math.sin": { params: [ANY], returns: F64, arity: 1 },
  "tl.math.cos": { params: [ANY], returns: F64, arity: 1 },
  /** `blaze_error_clear()` clears the pending error flag a try block starts with. */
  "blaze_error_clear": { params: [], returns: { kind: "void" }, arity: 0 },
  /** `blaze_had_error()` is 1 when the last awaited call failed, else 0. */
  "blaze_had_error": { params: [], returns: F64, arity: 0 },
  /** `blaze_last_error()` is the message of the last failure, for `catch (e)`. */
  "blaze_last_error": { params: [], returns: ANY, arity: 0 },
  "http.createServer": { params: [ANY], returns: ANY, arity: 1 },
  "server.listen": { params: [ANY, ANY, ANY, ANY], returns: ANY, arity: 4 },
  "server.close": { params: [ANY], returns: ANY, arity: 1 },
  "Promise": { params: [ANY], returns: ANY, arity: 1 },
  "Promise.await": { params: [ANY], returns: F64, arity: 1 },
  "resolve": { params: [ANY], returns: ANY, arity: 1 },
  "reject": { params: [ANY], returns: ANY, arity: 1 },
  /** The longer names a Promise executor is written with for the same pair:
   * the parameters `onFulfilled` and `onRejected` resolve the promise the
   * executor call is written in, exactly where `resolve` and `reject` do. */
  "onFulfilled": { params: [ANY], returns: ANY, arity: 1 },
  "onRejected": { params: [ANY], returns: ANY, arity: 1 },
  "req.on": { params: [ANY, ANY, ANY], returns: ANY, arity: 3 },
  /** `req.path` is the path the request was sent to, and `req.method` the
   *  method it was sent with: the two a program routes on. Both are read as
   *  text, so a program compares them with the strings it wrote. */
  "req.path": { params: [ANY], returns: ANY, arity: 1 },
  "req.method": { params: [ANY], returns: ANY, arity: 1 },
  /** The events of a response an `http.request(url, options, callback)` call
   * handed to its callback: the `data` and `end` listeners fire when the
   * response has arrived and an `error` listener when it never did. */
  "res.on": { params: [ANY, ANY, ANY], returns: ANY, arity: 3 },
  /** `req.write(text)` buffers the body bytes a client request is sent with. */
  "req.write": { params: [ANY, ANY], returns: ANY, arity: 2 },
  /** `req.end()` sends the buffered request, and the events the callback of
   * the `http.request` call registered fire when it is sent. */
  "req.end": { params: [ANY], returns: ANY, arity: 1 },
  /** `req.text()` is the body of the request, as text. */
  "req.text": { params: [ANY], returns: ANY, arity: 1 },
  /**
   * `req.header(name)` is the value of a header of the request, as text. A
   * header the request does not carry is an empty string, and the name the
   * header is asked for is read the way the protocol spells it: the search
   * is case-insensitive, because the peer spells the name its own way.
   */
  "req.header": { params: [ANY, ANY], returns: ANY, arity: 2 },
  "res.writeHead": { params: [ANY, ANY], returns: ANY, arity: 2 },
  /** `res.setHeader(name, value)` sets a header of the response, and is
   *  written before the body is sent. */
  "res.setHeader": { params: [ANY, ANY, ANY], returns: ANY, arity: 3 },
  "res.end": { params: [ANY, ANY], returns: ANY, arity: 2 },
  "tasks.push": { params: [ANY, ANY], returns: ANY, arity: 2 },
  /** `http.sseSubscribe(res)` turns a response into an event stream: the
   *  connection stays open and every event published afterwards is written to
   *  it. It answers 1 when the connection became an event stream, 0 when it
   *  did not. */
  "http.sseSubscribe": { params: [ANY], returns: F64, arity: 1 },
  /** `http.ssePublish(text)` writes an event to every event stream that is
   *  open, and answers how many of them it was written to. */
  "http.ssePublish": { params: [ANY], returns: F64, arity: 1 },
  /** `http.sseCount()` answers how many event streams are open. */
  "http.sseCount": { params: [], returns: F64, arity: 0 },

  /* ---------------------------------------------------------------------- */
  /* The HTTP API a module function may use                                  */
  /* ---------------------------------------------------------------------- */

  /*
   * The calls below are the HTTP API a *module* function has. A program body
   * has its own spelling of the same things (`req.path`, `res.end(body)`), and
   * the two are separate because the two carry their handles differently: a
   * program body holds a handle in a dynamic value, and a module function
   * holds it in a reference. What a call *does* is the same in both, and the
   * name here is the one the compiler binds, not the one a source writes.
   *
   * The request and the response are borrowed: they are the runtime's own, and
   * they are valid for as long as the request is being served.
   */

  /** The path the request was sent to, as text. */
  "http.requestPath": { params: [ANY], returns: TEXT, arity: 1, moduleOnly: true },
  /** The method the request was sent with, as text. */
  "http.requestMethod": { params: [ANY], returns: TEXT, arity: 1, moduleOnly: true },
  /**
   * The value of a header of the request, as text. A header the request does
   * not carry is an empty string, which is what a program reads it as.
   */
  "http.requestHeader": { params: [ANY, ANY], returns: TEXT, arity: 2, moduleOnly: true },
  /** The body of the request, as text. */
  "http.requestBody": { params: [ANY], returns: TEXT, arity: 1, moduleOnly: true },
  /** Sets the status the response is answered with. */
  "http.responseStatus": { params: [ANY, ANY], returns: { kind: "void" }, arity: 2, moduleOnly: true },
  /** Sets a header of the response. It is written before the body is sent. */
  "http.responseHeader": { params: [ANY, ANY, ANY], returns: { kind: "void" }, arity: 3, moduleOnly: true },
  /** Sets the body of the response, as text. */
  "http.responseBody": { params: [ANY, ANY], returns: { kind: "void" }, arity: 2, moduleOnly: true },
  /**
   * Sends the response and ends the request. It is written with a body and
   * without one: the body is set and then the response is sent.
   */
  "http.responseEnd": { params: [ANY, ANY], returns: { kind: "void" }, arities: [1, 2], moduleOnly: true },
  /** `performance.now()` is the milliseconds on a monotonic clock: the time a
   *  duration is measured over, which a clock that can be moved is no good
   *  for. It reads the clock, so it is not a value the optimizer may compute
   *  twice or move. */
  "performance.now": { params: [], returns: F64, arity: 0, effects: ["clock"] },

  /* ---------------------------------------------------------------------- */
  /* The SQLite facility.                                                     */
  /* ---------------------------------------------------------------------- */

  /**
   * `sqlite.open(path)` opens the database at the path, creating it when it
   * is not there; `":memory:"` is a database in memory. It answers a handle,
   * which is a number the program holds.
   */
  "sqlite.open": { params: [ANY], returns: F64, arity: 1, effects: SQLITE_EFFECTS },
  /** `sqlite.close(db)` closes the connection and finalizes what it holds. */
  "sqlite.close": { params: [ANY], returns: { kind: "void" }, arity: 1, effects: SQLITE_EFFECTS },
  /**
   * `sqlite.exec(db, sql)` runs the statements of the SQL that answer no
   * rows. It answers 1 when they ran and 0 when they did not.
   */
  "sqlite.exec": { params: [ANY, ANY], returns: F64, arity: 2, effects: SQLITE_EFFECTS },
  /** `sqlite.prepare(db, sql)` compiles one statement and answers a handle. */
  "sqlite.prepare": { params: [ANY, ANY], returns: F64, arity: 2, effects: SQLITE_EFFECTS },
  /**
   * `sqlite.bindText(stmt, index, text)` binds a parameter to text. The index
   * is 1-based, as SQLite counts them.
   */
  "sqlite.bindText": { params: [ANY, F64, ANY], returns: { kind: "void" }, arity: 3, effects: SQLITE_EFFECTS },
  /** `sqlite.bindNumber(stmt, index, number)` binds a parameter to a number. */
  "sqlite.bindNumber": { params: [ANY, F64, F64], returns: { kind: "void" }, arity: 3, effects: SQLITE_EFFECTS },
  /** `sqlite.bindNull(stmt, index)` binds a parameter to null. */
  "sqlite.bindNull": { params: [ANY, F64], returns: { kind: "void" }, arity: 2, effects: SQLITE_EFFECTS },
  /**
   * `sqlite.step(stmt)` runs the statement one row at a time. It answers 1
   * while there is a row and 0 when there is none.
   */
  "sqlite.step": { params: [ANY], returns: F64, arity: 1, effects: SQLITE_EFFECTS },
  /** `sqlite.columnCount(stmt)` answers how many columns the row has. */
  "sqlite.columnCount": { params: [ANY], returns: F64, arity: 1, effects: SQLITE_EFFECTS },
  /**
   * `sqlite.columnType(stmt, index)` answers the kind of the column: 0 null,
   * 1 integer, 2 float, 3 text, 4 blob. The index of a column is 0-based, as
   * SQLite counts them.
   */
  "sqlite.columnType": { params: [ANY, F64], returns: F64, arity: 2, effects: SQLITE_EFFECTS },
  /** `sqlite.columnNumber(stmt, index)` answers the column as a number. */
  "sqlite.columnNumber": { params: [ANY, F64], returns: F64, arity: 2, effects: SQLITE_EFFECTS },
  /** `sqlite.columnText(stmt, index)` answers the column as text. */
  "sqlite.columnText": { params: [ANY, F64], returns: ANY, arity: 2, effects: SQLITE_EFFECTS },
  /** `sqlite.finalize(stmt)` releases the statement. */
  "sqlite.finalize": { params: [ANY], returns: { kind: "void" }, arity: 1, effects: SQLITE_EFFECTS },
  /** `sqlite.changes(db)` answers how many rows the last statement changed. */
  "sqlite.changes": { params: [ANY], returns: F64, arity: 1, effects: SQLITE_EFFECTS },
  /** `sqlite.lastInsertRowid(db)` answers the rowid of the last row inserted. */
  "sqlite.lastInsertRowid": { params: [ANY], returns: F64, arity: 1, effects: SQLITE_EFFECTS },
  /** `sqlite.error(db)` answers the message of the last failure of the connection. */
  "sqlite.error": { params: [ANY], returns: ANY, arity: 1, effects: SQLITE_EFFECTS },
};

export const BUILTIN_NAMES: readonly string[] = Object.keys(BUILTINS);

/**
 * The builtin a source name calls, or null when the name is not one of them.
 *
 * A call is named by whatever the source called it, and `toString` is a legal
 * name: reading it off the table with `[...]` answers from `Object.prototype`,
 * so a call the program does not declare reads as a builtin whose `params` is
 * undefined, and the reader that goes on to count them throws a TypeError
 * instead of reporting the call the program does not compile.
 */
export function builtinFor(name: string): BuiltinSignature | null {
  return Object.prototype.hasOwnProperty.call(BUILTINS, name) ? BUILTINS[name] : null;
}

/** The builtins a `Math.` call may name, as the error message lists them. */
export const MATH_NAMES: readonly string[] = BUILTIN_NAMES.filter((name) => name.startsWith("Math."));

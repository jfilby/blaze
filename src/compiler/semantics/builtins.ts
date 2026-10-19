/**
 * Builtins: the functions a source may call that the program does not declare.
 *
 * They are fixed by the compiler, not by the source, so one table states what
 * each takes and what it returns. A frontend reads them from a source name, the
 * object pass types a call through them, and the driver emits them.
 */

import type { TypeExpr } from "../core/types.ts";

export interface BuiltinSignature {
  params: TypeExpr[];
  returns: TypeExpr;
  /** How many arguments the call must have, when the count is fixed. */
  arity?: number;
  /** Every count the call may have, when more than one form lowers. Argument
   * positions past the count are named by params all the same, so the first
   * `arities.length` params of the longest form decide each argument's type. */
  arities?: readonly number[];
}

const F64: TypeExpr = { kind: "primitive", name: "f64" };
const USIZE: TypeExpr = { kind: "primitive", name: "usize" };
const U64: TypeExpr = { kind: "primitive", name: "u64" };
const U256: TypeExpr = { kind: "primitive", name: "u256" };
const ANY: TypeExpr = { kind: "ref", of: null };

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
  "Math.min": { params: [F64, F64], returns: F64, arity: 2 },
  "Math.sqrt": { params: [F64], returns: F64, arity: 1 },
  "Math.abs": { params: [F64], returns: F64, arity: 1 },
  "Math.floor": { params: [F64], returns: F64, arity: 1 },
  "Math.round": { params: [F64], returns: F64, arity: 1 },
  "Math.trunc": { params: [F64], returns: F64, arity: 1 },
  "Math.ceil": { params: [F64], returns: F64, arity: 1 },
  "Math.random": { params: [], returns: F64, arity: 0 },
  [SHARED]: { params: [USIZE], returns: { kind: "ptr", of: { kind: "primitive", name: "u8" } }, arity: 1 },
  [ARGV_LENGTH]: { params: [], returns: USIZE, arity: 0 },
  [ARGV]: { params: [USIZE], returns: ANY, arity: 1 },
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
  "require": { params: [ANY], returns: ANY, arity: 1 },
  "JSON.stringify": { params: [ANY], returns: ANY, arity: 1 },
  "JSON.parse": { params: [ANY], returns: ANY, arity: 1 },
  "crypto.createHash": { params: [ANY], returns: ANY, arity: 1 },
  "fs.readFileSync": { params: [ANY, ANY], returns: ANY, arity: 2 },
  "hasher.update": { params: [ANY, ANY, ANY], returns: ANY, arity: 3 },
  "hasher.update.digest": { params: [ANY, ANY], returns: ANY, arity: 2 },
  "array.new": { params: [], returns: ANY, arity: 0 },
  "array.push": { params: [ANY, ANY], returns: ANY, arity: 2 },
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
  /** The events of a response an `http.request(url, options, callback)` call
   * handed to its callback: the `data` and `end` listeners fire when the
   * response has arrived and an `error` listener when it never did. */
  "res.on": { params: [ANY, ANY, ANY], returns: ANY, arity: 3 },
  /** `req.write(text)` buffers the body bytes a client request is sent with. */
  "req.write": { params: [ANY, ANY], returns: ANY, arity: 2 },
  /** `req.end()` sends the buffered request, and the events the callback of
   * the `http.request` call registered fire when it is sent. */
  "req.end": { params: [ANY], returns: ANY, arity: 1 },
  "req.text": { params: [ANY], returns: ANY, arity: 1 },
  "res.writeHead": { params: [ANY, ANY], returns: ANY, arity: 2 },
  "res.end": { params: [ANY, ANY], returns: ANY, arity: 2 },
  "tasks.push": { params: [ANY, ANY], returns: ANY, arity: 2 },
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

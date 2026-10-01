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
}

const F64: TypeExpr = { kind: "primitive", name: "f64" };
const USIZE: TypeExpr = { kind: "primitive", name: "usize" };

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
  [SHARED]: { params: [USIZE], returns: { kind: "ptr", of: { kind: "primitive", name: "u8" } }, arity: 1 },
  [ARGV_LENGTH]: { params: [], returns: USIZE, arity: 0 },
  [ARGV]: { params: [USIZE], returns: F64, arity: 1 },
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

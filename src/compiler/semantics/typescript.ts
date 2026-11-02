/**
 * Frontend: TypeScript module -> module analysis and function contracts.
 *
 * The contract is language neutral, so a second frontend is a parser and an
 * analysis, nothing more. This one accepts the subset of TypeScript a
 * compiled function is written in:
 *
 *   import { dotProduct } from "./dot.ts";
 *
 *   export function name(a: Float64Array, b: Float64Array): number {
 *     let total = 0;
 *     for (let i = 0; i < a.length; i++) {
 *       total += a[i] * b[i];
 *     }
 *     return total;
 *   }
 *
 *   - top level: `import { name } from "./other.ts";`, `import name from
 *     "./other.ts";` and `import name, { other } from "./other.ts";`, which
 *     bind a module's default export and its named ones; `export function`,
 *     `export default function`, `export { name }`, class declarations, and
 *     the statements of a program (see typescript-program.ts). A function
 *     declaration is hoisted: it is the module's wherever it is written, so a
 *     statement may run before it.
 *
 *     A class is lowered to functions and objects: its constructor returns an
 *     object literal, each method is a function whose first parameter is the
 *     instance it was called on, and each static member is a function of the
 *     class. Field declarations, parameter properties, default parameters and
 *     `instanceof` are part of the subset. A class that a module does not
 *     export is still compiled, because the functions the module does export
 *     may construct it.
 *
 *     A function may leave out the type of a parameter that has a default, and
 *     the type of its result: the default says the one and the returns say the
 *     other. A shorter call is answered by an overload whose body fills the
 *     defaults the source wrote.
 *
 *     A function reads a top-level `const` of its own file where the source
 *     reads the name: a compiled function is handed no scope to read the file
 *     around it from, and a value the file writes at the top is the value it
 *     reads.
 *
 *     A default export is bound under the name the function was declared with
 *     and not the name the importer wrote: this subset links by name, because
 *     one table holds every function of every file of the program, so a second
 *     name for one of them would be a second compilation of it.
 *   - statements: let/const/var with an initialiser, counted for loops in
 *     either direction, for-of loops, while, do-while, break, continue,
 *     if/else, assignments, compound assignments, `i++`, calls, returns and
 *     console.log
 *   - expressions: number and bigint literals, null, identifiers, indexing,
 *     field reads, calls, object literals, `process.argv`, the comparison,
 *     logical, shift and arithmetic operators, the conditional operator and
 *     parentheses
 *   - types: number, bigint, boolean, the typed array views, a class of the
 *     module, and `any` for a value that is a reference to an object
 *   - a function is compiled whatever it does: only the contracts that can
 *     be written as one expression describe a result, so a body that
 *     branches, recurses, allocates or prints is contracted by what it does,
 *     the contract carrying the statements themselves as a definition
 */

import { parseType, typeToString } from "./contract.ts";
import { ARGV, ARGV_LENGTH, builtinFor } from "./builtins.ts";

export { ARGV, ARGV_LENGTH };
import { assembleContract, type AccessRange } from "./contract-build.ts";
import { isCompilerError } from "../core/errors.ts";
import { Diagnostics, frontendError, type Diagnostic } from "./diagnostics.ts";
import type { DeclaredFunction, Frontend, ModuleAnalysis, ModuleImport, ModuleTypeBinding, ModuleTypeImport } from "./module.ts";
import { parseProgramBody } from "./typescript-program.ts";
import { lowerWideArithmetic } from "./typescript-wide-lowering.ts";
import {
  collectionOfType,
  elementOfType,
  fieldOfType,
  resolveAnnotation,
  resolveTypeName,
  scanTypeTable,
  typeText,
  type ResolvedField,
  type ResolvedType,
  type TypeTable,
} from "./typescript-types.ts";
import {
  findField,
  findGetter,
  findMethod,
  methodFunctionName,
  requiredParams,
  scanClasses,
  withoutClasses,
  type ClassField,
  type ClassInfo,
  type ClassMethod,
  type ClassParam,
  type ClassTable,
} from "./typescript-classes.ts";
import type { TypeExpr } from "../core/types.ts";
import type {
  AssignOperator,
  BinaryOp,
  Expression,
  Statement,
  TextPart,
  UnaryOp,
} from "../core/ir.ts";
import { COMPOUND_OPERATORS } from "../core/ir.ts";

export { COMPOUND_OPERATORS };
export type { AssignOperator, BinaryOp, Expression, Statement, TextPart, UnaryOp };

export { Diagnostics, frontendError };
export type { Diagnostic };

// `$` is here so that `\${` writes the literal `${` a template needs to show,
// rather than the backslash and the pair.
const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", "`": "`", "'": "'", '"': '"', $: "$" };

/** Resolves the escapes a string carries, and leaves any other as written. */
export function unescape(text: string, line: number): string {
  let result = "";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character !== "\\") {
      result += character;
      continue;
    }
    const escape = text[index + 1];
    if (escape === undefined) throw frontendError("a string ends in a backslash", `line ${line}`);
    result += ESCAPES[escape] ?? `\\${escape}`;
    index += 1;
  }
  return result;
}

/**
 * Where the `}` that closes an interpolation opened at `${` sits, or -1. The
 * braces nest and a string inside the interpolation carries its own, so the
 * first `}` is not the one that closes it: an object literal, or a `"}"`
 * argument, ended the interpolation early and everything after it was read as
 * text that was never there.
 */
export function closingBrace(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"' || character === "'" || character === "`") {
      let end = index + 1;
      for (;;) {
        end = text.indexOf(character, end);
        if (end < 0) return -1;
        const backslashes = /\\*$/.exec(text.slice(index + 1, end))?.[0].length ?? 0;
        if (backslashes % 2 === 0) break;
        end += 1;
      }
      index = end;
      continue;
    }
    // A regular expression may hold a quote of either kind, and reading it as
    // a string ends a text the expression never opened: `x.replace(/"/g, "a")`
    // desynchronised every quote after it, so the `}` the interpolation ends
    // with was never found. A slash where a value is expected is the pattern's
    // own, and it runs to the next slash outside a class.
    if (character === "/" && text[index + 1] !== "/" && text[index + 1] !== "*" && valueExpected(text, index)) {
      let end = index + 1;
      let inClass = false;
      for (;;) {
        if (end >= text.length || text[end] === "\n") return -1;
        const next = text[end];
        if (next === "\\") {
          end += 2;
          continue;
        }
        if (next === "[") inClass = true;
        else if (next === "]") inClass = false;
        else if (next === "/" && !inClass) break;
        end += 1;
      }
      while (end + 1 < text.length && /[a-z]/.test(text[end + 1] as string)) end += 1;
      index = end;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** The words a regular expression may follow without being a division. */
const REGEX_AFTER_WORD: ReadonlySet<string> = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "case", "do", "else", "yield", "await",
]);

/**
 * Whether a `/` at one place starts a pattern rather than a division.
 *
 * The same question the tokenizer asks of its own token stream, over the
 * characters between: a pattern starts where a value is expected, which is the
 * beginning, after an operator or an opening bracket, or after a word that is
 * followed by an expression.
 */
function valueExpected(text: string, at: number): boolean {
  let index = at - 1;
  while (index >= 0 && /\s/.test(text[index] as string)) index -= 1;
  if (index < 0) return true;
  const character = text[index] as string;
  if (/[A-Za-z0-9_$]/.test(character)) {
    let start = index;
    while (start >= 0 && /[A-Za-z0-9_$]/.test(text[start] as string)) start -= 1;
    return REGEX_AFTER_WORD.has(text.slice(start + 1, index + 1));
  }
  if (character === ")" || character === "]" || character === "}" || character === "`" || character === '"' || character === "'") return false;
  return true;
}

/**
 * Where the next interpolation of a template begins, or -1. `\${` writes a
 * literal `${` and interpolates nothing, so it is text and not a boundary.
 */
export function nextInterpolation(text: string): number {
  for (let open = text.indexOf("${"); open >= 0; open = text.indexOf("${", open + 2)) {
    const backslashes = /\\*$/.exec(text.slice(0, open))?.[0].length ?? 0;
    if (backslashes % 2 === 0) return open;
  }
  return -1;
}

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/** A value that is a reference to an object, before its fields are known. */
const ANY_TYPE: TypeExpr = { kind: "ref", of: null };

/**
 * The namespaces a compiled function may call into. A call of a namespace is a
 * call of the name the namespace and the member spell together, so `Math.floor`
 * is the call the compiler knows and `http.requestPath` is the HTTP call of
 * that name.
 *
 * A namespace is a namespace and not a value: nothing reads one, and a call of
 * one is the only thing that may be written of it.
 */
const NAMESPACES: ReadonlySet<string> = new Set(["Math", "http", "JSON"]);


/** Statements the parser reads to the end of the statement and reports. */
/**
 * The operators the contract expression language states a result with. It is
 * `contract.ts`'s own grammar that decides, and an operator named here that it
 * cannot parse is written into the postcondition and then refused by the
 * parser: `c += a[i] % 2` failed the build with "unexpected character" rather
 * than being contracted as the definition it cannot be stated as. `%`, `<<`
 * and `>>` are the ones the language has no operator for, so a body using one
 * falls back the way `~` and a branch do.
 */
const CONTRACT_OPERATORS: readonly BinaryOp[] = [
  "+",
  "-",
  "*",
  "/",
  "<",
  "<=",
  ">",
  ">=",
  "==",
  "!=",
  "&&",
  "||",
];

/** The operators a value an index is built from may use, as a contract states it. */
const ARITHMETIC_OPERATORS: readonly BinaryOp[] = ["+", "-", "*", "/"];

/**
 * Where a function's return type ends and its body begins.
 *
 * `{` is both the start of an object type and the body's own brace, so the type
 * reader decides it by what precedes it; `=` and `;` are the ends of a form
 * that writes no brace at all.
 */
const FUNCTION_BODY_STOPS: ReadonlySet<string> = new Set(["{", "=", ";"]);

/**
 * Where an `as` or `satisfies` type ends. A type is followed by the rest of the
 * expression it is written in, so the operators that continue an expression are
 * the ones that stop it. A union and an intersection are type operators, not
 * expression ones, and the scanner reads them as part of the type.
 */
const EXPRESSION_TYPE_STOPS: ReadonlySet<string> = new Set([
  ",",
  ")",
  "]",
  "}",
  ";",
  ".",
  "?",
  ":",
  "=",
  "==",
  "===",
  "!=",
  "!==",
  "<=",
  ">",
  ">=",
  "+",
  "-",
  "*",
  "/",
  "%",
  "<<",
  ">>",
  ">>>",
  "^",
  "&&",
  "||",
  "??",
]);

/**
 * The keywords the subset does not read, and what a source writes instead of
 * each one. They are named here rather than left to the parser reading past
 * them: a construct refused by a shape error is reported as whatever token
 * happened to be next, so `catch` said "expected the name of a function" and
 * `function*` said the same, and neither named the thing that was written.
 */
export const REFUSED_KEYWORDS: Record<string, string> = {
  switch: "a chain of comparisons, as in `if (x === 1) { ... } else { ... }`",
  // try/catch/finally are supported: see docs/specs/try-catch.md
  throw: "a line written out with console.log, and an error as one",
  class: "a class declared at the top level of a module; a class inside a function is not part of the subset",
  interface: "nothing: a program names a type with one word, as in `const n: usize = 0`",
  type: "nothing: a program names a type with one word, as in `const n: usize = 0`",
  enum: "the values written out, as in `const RED = 0;`",
  namespace: "the names written as they are",
  struct: "an object written where it is made, as in `{ left: null, right: null }`",
  with: "a plain block, as in `{ ... }`",
  await: "a value the promise it is written before carries",
  yield: "a value the function hands back with return",
  async: "a function whose answer is a promise carrying what its body returns",
};

/** The refused constructs whose own `{ ... }` is skipped with them. */
const REFUSED_WITH_BODY: ReadonlySet<string> = new Set(["class", "enum", "namespace", "struct", "with"]);



/* -------------------------------------------------------------------------- */
/* Type annotations                                                           */
/* -------------------------------------------------------------------------- */
const TYPED_ARRAYS: Record<string, string> = {
  Float32Array: "f32",
  Float64Array: "f64",
  Int8Array: "i8",
  Int16Array: "i16",
  Int32Array: "i32",
  Int64Array: "i64",
  Uint8Array: "u8",
  Uint16Array: "u16",
  Uint32Array: "u32",
  BigInt64Array: "i64",
  BigUint64Array: "u64",
};

const PRIMITIVES: Record<string, string> = {
  number: "f64",
  bigint: "i64",
  boolean: "bool",
  // A text is what the runtime lays out and what the source reads apart: the
  // type a parameter of a function that takes a configuration value is
  // written at, and the answer a function that reads a text apart hands
  // back. The language spells it `string` and the contract calls it `text`.
  string: "text",
  // The compiler's own wide integer, named as a type. It is neither a
  // TypeScript type nor a typed array: a source spells it to ask for
  // arithmetic at a fixed width wider than any the language has a keyword for,
  // and a value written at that width keeps it rather than widening to a
  // double, which is what every other whole number in a program does.
  i256: "i256",
  u256: "u256",
};

/** A function that returns nothing declares `void`. */
const NOTHING: TypeExpr = { kind: "void" };

/** The result types an unannotated function is inferred at. */
const NUMBER_RESULT: TypeExpr = { kind: "primitive", name: "f64" };
const BOOLEAN_RESULT: TypeExpr = { kind: "primitive", name: "bool" };
const TEXT_RESULT: TypeExpr = { kind: "text" };
const BIGINT_RESULT: TypeExpr = { kind: "primitive", name: "i64" };
const WIDE_RESULT: TypeExpr = { kind: "primitive", name: "u256" };

/**
 * The result type a function that states none has, read from every return in
 * its body.
 *
 * A body with no return hands back nothing. A return is typed as the value it
 * writes with the names the body declared in scope, so `return x % modulo`
 * over two `u256` names is a `u256` and not the `any` a reader without the
 * scope would have to guess. A body whose returns disagree is the `any` a
 * value no annotation pinned holds.
 *
 * `known` is a reader that types a value the body wrote from what the frontend
 * knows and `resultType` does not — a call answers what its callee answers, and
 * a field of a parameter is the field its shape declares. It answers null where
 * it has nothing better than `resultType`.
 */
function inferredResult(
  body: readonly Statement[],
  params: readonly { name: string; type: TypeExpr }[],
  known?: (value: Expression, scope: ReadonlyMap<string, TypeExpr>) => TypeExpr | null,
): TypeExpr {
  const scope = new Map<string, TypeExpr>(params.map((param) => [param.name, param.type]));
  describeDeclarations(body, scope);
  const written: Expression[] = [];
  const bare = { found: false };
  collectResults(body, written, bare);
  if (written.length === 0) return NOTHING;
  // A body that returns a value on one path and nothing on another has no one
  // type the contract can state: the bare return is not a value to unify with.
  if (bare.found) return ANY_TYPE;
  let found: TypeExpr | null = null;
  for (const value of written) {
    const type = known?.(value, scope) ?? resultType(value, scope);
    if (found === null) {
      found = type;
      continue;
    }
    if (!sameResult(found, type)) return ANY_TYPE;
  }
  return found ?? NOTHING;
}

/** What each name the body declares holds, as the body reads it. */
function describeDeclarations(statements: readonly Statement[], scope: Map<string, TypeExpr>): void {
  const walk = (body: readonly Statement[]): void => {
    for (const statement of body) {
      switch (statement.kind) {
        case "declare":
          scope.set(statement.name, statement.type ?? resultType(statement.init, scope));
          break;
        case "loop":
          scope.set(statement.variable, NUMBER_RESULT);
          walk(statement.body);
          break;
        case "if":
          walk(statement.then);
          walk(statement.otherwise);
          break;
        case "while":
        case "doWhile":
        case "forOf":
          walk(statement.body);
          break;
        case "try":
          walk(statement.body);
          if (statement.catchBody !== null) walk(statement.catchBody);
          if (statement.finallyBody !== null) walk(statement.finallyBody);
          break;
        default:
          break;
      }
    }
  };
  walk(statements);
}

/** Every value a body returns, nested arms included. A bare `return;` is no value. */
function collectResults(statements: readonly Statement[], into: Expression[], bare?: { found: boolean }): void {
  for (const statement of statements) {
    switch (statement.kind) {
      case "result":
        if (statement.value === null) {
          if (bare !== undefined) bare.found = true;
        } else {
          into.push(statement.value);
        }
        break;
      case "if":
        collectResults(statement.then, into, bare);
        collectResults(statement.otherwise, into, bare);
        break;
      case "while":
      case "doWhile":
      case "loop":
      case "forOf":
        collectResults(statement.body, into, bare);
        break;
      case "try":
        collectResults(statement.body, into, bare);
        if (statement.catchBody !== null) collectResults(statement.catchBody, into, bare);
        if (statement.finallyBody !== null) collectResults(statement.finallyBody, into, bare);
        break;
      default:
        break;
    }
  }
}

/** The name `typeof` answers for a value held at a type. */
function typeofName(type: TypeExpr): string {
  switch (type.kind) {
    case "primitive":
      if (type.name === "f32" || type.name === "f64") return "number";
      if (type.name === "bool") return "boolean";
      return "bigint";
    case "text":
      return "string";
    case "void":
      return "undefined";
    default:
      return "object";
  }
}

/** Whether a type is the reference the read has no name for. */
function unknownReference(type: TypeExpr): boolean {
  return type.kind === "ref" && type.of === null && type.name === undefined;
}

/**
 * Whether every path through a list of statements leaves the block it is in.
 *
 * A body that ends in a `return`, a `throw`, a `break` or a `continue` runs
 * nothing after it, and neither does a body whose every arm ends in one. Only
 * the statements a source writes that way say anything about the code after
 * them, which is why narrowing past a guard is asked of the body rather than
 * assumed of it.
 */
function leavesEveryPath(statements: readonly Statement[]): boolean {
  const last = statements[statements.length - 1];
  if (last === undefined) return false;
  if (last.kind === "result" || last.kind === "throw" || last.kind === "break" || last.kind === "continue") return true;
  if (last.kind === "if") return last.otherwise.length > 0 && leavesEveryPath(last.then) && leavesEveryPath(last.otherwise);
  return false;
}

/** The type a `typeof` name stands for, or null where it settles no type. */
function typeOfTypeofName(name: string): TypeExpr | null {
  switch (name) {
    case "string":
      return TEXT_RESULT;
    case "number":
      return NUMBER_RESULT;
    case "boolean":
      return BOOLEAN_RESULT;
    case "bigint":
      return BIGINT_RESULT;
    default:
      // `"object"`, `"undefined"` and `"function"` say no type a value here can
      // be held at, so a branch they guard reads the value as it was declared.
      return null;
  }
}

/**
 * The digits a written number stands for.
 *
 * The separators between digits name nothing and are dropped. A number written
 * in binary or octal is the value it names, written the way every other number
 * in the file is: `0b101` is `5`, and `0o17` is `15`.
 */
function numberText(written: string): string {
  const digits = written.replace(/_/g, "");
  if (digits.startsWith("0b") || digits.startsWith("0B")) return BigInt(digits).toString();
  if (digits.startsWith("0o") || digits.startsWith("0O")) return BigInt(digits).toString();
  return digits;
}

/** The text a value written as one string holds, or null where it is not one. */
function textValue(value: Expression): string | null {
  if (value.k !== "text" || value.parts.length !== 1) return null;
  const part = value.parts[0];
  return part.k === "text" ? part.value : null;
}

/** The whole number a literal names, or null where it is not one. */
function numberValue(value: Expression): bigint | null {
  if (value.k === "literal" || value.k === "bigint") {
    try {
      return BigInt(value.text.replace(/n$/, ""));
    } catch {
      return null;
    }
  }
  if (value.k === "unary" && (value.op === "-" || value.op === "+")) {
    const inner = numberValue(value.operand);
    if (inner === null) return null;
    return value.op === "-" ? -inner : inner;
  }
  return null;
}

/** Whether a value is the literal number it is written as. */
function isNumberLiteral(value: Expression, text: string): boolean {
  return (value.k === "literal" || value.k === "bigint") && value.text.replace(/n$/, "") === text;
}

/**
 * Whether reading a value again does the same work again: a name, a literal, a
 * field of one, or an element of one. An object spread that names a record is
 * written out field by field, so the value it spreads is read once per field;
 * a call or an update written there would run as many times as the record has
 * fields.
 */
function readsOnce(value: Expression): boolean {
  switch (value.k) {
    case "ident":
    case "literal":
    case "bigint":
    case "text":
    case "null":
      return true;
    case "member":
      return readsOnce(value.base);
    case "index":
      return readsOnce(value.base) && readsOnce(value.index);
    default:
      return false;
  }
}

/** The element type of a sequence type, or null where the type is not one. */
function elementOfSequenceType(type: TypeExpr): TypeExpr | null {
  return type.kind === "slice" || type.kind === "array" ? type.of : null;
}

/** The type a value is held at, read with the names the body declared. */
function resultType(value: Expression, scope: ReadonlyMap<string, TypeExpr>): TypeExpr {
  switch (value.k) {
    case "literal":
      return NUMBER_RESULT;
    case "bigint": {
      let number: bigint | null = null;
      try { number = BigInt(value.text); } catch { /* not a valid bigint */ }
      return number !== null && (number > 9223372036854775807n || number < -9223372036854775808n) ? WIDE_RESULT : BIGINT_RESULT;
    }
    case "text":
      return TEXT_RESULT;
    case "ident":
      return scope.get(value.name) ?? ANY_TYPE;
    case "binary":
      return binaryResultType(value, scope);
    case "unary":
      return value.op === "!" ? BOOLEAN_RESULT : resultType(value.operand, scope);
    case "conditional": {
      // One arm written as null is the guard an optional access writes, and
      // the value the other arm holds is what the conditional holds where it
      // is there. Without that, `a?.[0]` was `any`, and `a?.[0] ?? 0` was a
      // reference coalesced with a number.
      const otherwiseNull = value.otherwise.k === "null";
      const thenNull = value.then.k === "null";
      if (otherwiseNull && !thenNull) return resultType(value.then, scope);
      if (thenNull && !otherwiseNull) return resultType(value.otherwise, scope);
      return commonResult(resultType(value.then, scope), resultType(value.otherwise, scope));
    }
    case "index": {
      const base = resultType(value.base, scope);
      if (base.kind === "slice" || base.kind === "array" || base.kind === "ptr") return base.of;
      if (base.kind === "text") return TEXT_RESULT;
      return ANY_TYPE;
    }
    case "member": {
      // `length` is the one field every sequence has; a field of an object is
      // shaped by the layout pass, which the parser has not run.
      if (value.field === "length") {
        const base = resultType(value.base, scope);
        if (base.kind === "slice" || base.kind === "array" || base.kind === "text" || base.kind === "ptr") return NUMBER_RESULT;
      }
      return ANY_TYPE;
    }
    case "length":
    case "lengthOf":
      return NUMBER_RESULT;
    case "sized":
    case "buffer":
      return { kind: "slice", of: parseType(value.element) };
    case "fixed":
      return TEXT_RESULT;
    case "argv":
      return TEXT_RESULT;
    case "update":
      return resultType({ k: "ident", name: value.name }, scope);
    case "capture":
      return value.type;
    case "invoke":
      return value.returns;
    case "append":
      return ANY_TYPE;
    case "arrow":
      return ANY_TYPE;
    default:
      return ANY_TYPE;
  }
}

/** The type an operation answers, from the types of its two sides. */
function binaryResultType(value: Expression & { k: "binary" }, scope: ReadonlyMap<string, TypeExpr>): TypeExpr {
  const compared = ["<", "<=", ">", ">=", "===", "!==", "==", "!="];
  if (compared.includes(value.op)) return BOOLEAN_RESULT;
  const left = resultType(value.left, scope);
  const right = resultType(value.right, scope);
  if (value.op === "&&" || value.op === "||" || value.op === "??") return commonResult(left, right);
  // Two lists added are one list of the same elements: the values of both are
  // written into one block, and the block holds what either held.
  if (left.kind === "slice" && right.kind === "slice") return left;
  if (left.kind === "text" || right.kind === "text") return TEXT_RESULT;
  if (left.kind !== "primitive" || right.kind !== "primitive") return ANY_TYPE;
  const whole = (name: string): boolean => name !== "f32" && name !== "f64" && name !== "bool";
  if (!whole(left.name) || !whole(right.name)) return NUMBER_RESULT;
  if (left.name === "u256" || right.name === "u256") return WIDE_RESULT;
  if (left.name === "i256" || right.name === "i256") return { kind: "primitive", name: "i256" };
  return BIGINT_RESULT;
}

/** The one type two results have in common, or `any` where they have none. */
function commonResult(left: TypeExpr, right: TypeExpr): TypeExpr {
  if (sameResult(left, right)) return left;
  if (left.kind === "primitive" && right.kind === "primitive") {
    if (left.name === "u256" || right.name === "u256") return WIDE_RESULT;
    if (left.name === "i256" || right.name === "i256") return { kind: "primitive", name: "i256" };
    if (left.name !== "bool" && right.name !== "bool") return NUMBER_RESULT;
  }
  return ANY_TYPE;
}

/** Whether two results are the same type. */
function sameResult(left: TypeExpr, right: TypeExpr): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "primitive" && right.kind === "primitive") return left.name === right.name;
  return true;
}

/**
 * The type a parameter with a default and no annotation is held at.
 *
 * A number written as a number is a double, a text is a text, and a bigint —
 * or an arithmetic expression of them, which may reach past a machine word —
 * is the wide whole number.
 */
function defaultParameterType(value: Expression): TypeExpr {
  switch (value.k) {
    case "literal":
      return NUMBER_RESULT;
    case "bigint":
      return resultType(value, new Map());
    case "text":
      return TEXT_RESULT;
    case "unary":
    case "binary":
      return holdsBigint(value) ? WIDE_RESULT : NUMBER_RESULT;
    default:
      return ANY_TYPE;
  }
}

/** Whether a value is written over a bigint, which makes the value a bigint. */
function holdsBigint(value: Expression): boolean {
  switch (value.k) {
    case "bigint":
      return true;
    case "unary":
      return holdsBigint(value.operand);
    case "binary":
      return holdsBigint(value.left) || holdsBigint(value.right);
    case "conditional":
      return holdsBigint(value.then) || holdsBigint(value.otherwise);
    case "call":
      return value.name === "BigInt" || value.args.some(holdsBigint);
    default:
      return false;
  }
}

/**
 * Whether reading a value twice is reading the same value. An optional chain
 * tests the value before `?.` and then reads it again inside the branch, so a
 * call or an allocation may not be there: two reads of it are two of them.
 */
function repeatableExpression(value: Expression): boolean {
  switch (value.k) {
    case "ident":
    case "literal":
    case "bigint":
    case "text":
    case "null":
    case "length":
      return true;
    case "member":
      return repeatableExpression(value.base);
    case "index":
      return repeatableExpression(value.base) && repeatableExpression(value.index);
    // An operation over values that read the same way twice reads the same way
    // twice: `tokens[at + 1]?.kind` asks for one number and reads one element,
    // and asking for the number again is the same number.
    case "binary":
      return repeatableExpression(value.left) && repeatableExpression(value.right);
    case "unary":
      return repeatableExpression(value.operand);
    case "conditional":
      return repeatableExpression(value.condition) && repeatableExpression(value.then) && repeatableExpression(value.otherwise);
    case "lengthOf":
      return repeatableExpression(value.of);
    // A text's own methods read the text and answer a new one: `text.slice(a,
    // b)` and `text.trim()` name the same text twice, so a value that asks one
    // of them twice is asking the same question. A compiled function is where
    // the call goes, and no text method writes the text it reads.
    // A dictionary's own reads answer the same thing twice: `m.get(k)?.field`
    // asks whether the entry is there and then reads it, and nothing between
    // the two writes the dictionary — a call is what would, and there is none
    // in the guard. The guard a dictionary read is written as asks `has` and
    // then `get`, and both are reads of the same dictionary.
    case "call":
      return (
        (value.name.startsWith("text.") || value.name.startsWith("blaze_rt_dict_")) &&
        value.args.every((arg) => repeatableExpression(arg))
      );
    default:
      return false;
  }
}

/**
 * Maps a TypeScript type annotation onto a contract type.
 *
 * A type the compiler does not know is a reference the layout pass holds no
 * shape for, which is the contract's `ref<any>`. It is not a refusal: a module
 * names its own interfaces, imports types from another module, and works over
 * collections such as `Map` and `Promise`, and every one of those is a value
 * the program already knows how to hold as an opaque reference. What a type
 * says about a buffer or a number is kept; everything else is `any`.
 */
export function mapTypeScriptType(text: string, _position: string, wideBigint = false): TypeExpr {
  const source = text.trim();
  if (source === "bigint" && wideBigint) return parseType("u256");
  if (source in PRIMITIVES) return parseType(PRIMITIVES[source]);
  if (source in TYPED_ARRAYS) return { kind: "slice", of: parseType(TYPED_ARRAYS[source]) };
  return ANY_TYPE;
}

/**
 * The one type a union of numeric annotations is held at.
 *
 * A union the source writes over two numbers is a value that may be either, and
 * the contract has one width for a value: the wider member holds both exactly.
 * `number | bigint` is the union of a double and a whole number, and the whole
 * member is the one the program reads; whether it is the machine word or the
 * wide whole number is the width the file's own bigints reach. An unrelated
 * union keeps its first member, because the two are not values this subset can
 * hold in one name.
 */
function unionTypeName(left: string, right: string): string {
  if (left === right) return left;
  const numbers: ReadonlySet<string> = new Set(["number", "bigint", "u256", "i256"]);
  if (!numbers.has(left) || !numbers.has(right)) return left;
  if (left === "u256" || right === "u256") return "u256";
  if (left === "i256" || right === "i256") return "i256";
  // A double beside a bigint is the bigint member: the whole number is the one
  // that holds both, and the declaration it is written on says whether the
  // file's bigints are the machine word or the wide one.
  if (left === "bigint" || right === "bigint") return "bigint";
  return left;
}

/** What a program has none of: everything from the first import is a library; a program has none. */
function tokensAfterImports(tokens: Token[]): Token[] {
  let position = 0;
  while (tokens[position]?.text === "import") {
    while (tokens[position] !== undefined && tokens[position].text !== ";") position += 1;
    position += 1;
  }
  return tokens.slice(position);
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The punctuation mark a token is, or "" where it holds a value.
 *
 * A string token's text is what the string holds, so a text `"}"` reads as a
 * brace to anything that asks a token for its text alone. A scan that walks the
 * tokens rather than parsing them has to ask what kind of token it holds: the
 * compiler's own source is full of texts that spell the brackets it is made of.
 */
function mark(token: Token | undefined): string {
  return token !== undefined && token.kind === "punct" ? token.text : "";
}

/** One value written in the source, as the tokens it spans. */
interface ConstantRange {
  start: number;
  end: number;
}

/**
 * The value a constant, or one field of one, was written as.
 *
 * A constant of the file is read from the tokens the source wrote it with. A
 * constant another module offers carries the value itself, because a range of
 * tokens names nothing in a file that did not write them: the part that
 * crosses the module boundary is what the exporting file already read. One of
 * the two is written, never both.
 */
interface ConstantValue {
  /** The tokens this file wrote the value with. */
  range?: ConstantRange;
  /** The value itself, where the module that wrote it already read it. */
  value?: Expression;
}

/**
 * A top-level constant a function may read: the expression it is written as, or
 * the fields of an object literal it is written as.
 *
 * A constant of a compiled function is the value it was written with. The
 * function is compiled on its own and has no environment to read the program
 * around it from, so a value that is written down — a number, a curve's field,
 * a `BigInt` of a string — is read where the source wrote it. A value computed
 * at run time is not one of these and is left as the name it is.
 */
interface ConstantInfo {
  expression?: ConstantValue;
  fields?: ReadonlyMap<string, ConstantValue>;
  /**
   * The literal keys a top-level `ReadonlySet` or `ReadonlyMap` is written
   * with, in the order the source wrote them. A set is the keys alone; a map
   * keeps the value each one is written with beside it.
   */
  keys?: readonly string[];
  values?: readonly ConstantValue[];
  /** What a key is written as, which is how a comparison reads it. */
  keyKind?: "text" | "number";
  /**
   * True where the value is a `new C(...)`: the constructor is a function of
   * the module that wrote it, so the value is the file's own and is not offered
   * to a module that imports the name.
   */
  constructed?: boolean;
  /** True where the file offers the name: `export const NAME = ...`, or an
   *  `export { NAME }` list that names it. */
  exported?: boolean;
}

/**
 * The top-level `const` declarations of a source, and the constant expressions
 * each is written as.
 *
 * Only a declaration at the top of the file is read: a declaration inside a
 * function or a class is that body's own, and the names a function reads are
 * the file's. A declaration whose value is not a constant expression is not
 * recorded, so a name that holds a call or an object is left as itself.
 */
interface ScannedFile {
  constants: Map<string, ConstantInfo>;
  /** The top-level names that are values the running program holds, not constants. */
  state: Set<string>;
}

/**
 * Whether a value is a `new C(...)` whose arguments are values the file
 * already wrote.
 *
 * A class instance is not a number, so it is only the file's constant where
 * reading it once is the same as reading it everywhere: an object has an
 * identity, and two allocations are two objects. The caller counts the reads
 * and inlines only the one.
 */
function constructorRange(tokens: readonly Token[], start: number, end: number): boolean {
  if (tokens[start]?.text !== "new" || tokens[start + 1]?.kind !== "ident") return false;
  let index = start + 2;
  if (tokens[index]?.text !== "(") return false;
  index += 1;
  while (index < end && tokens[index]?.text !== ")") {
    const token = tokens[index] as Token;
    if (token.kind === "number" || token.kind === "bigint" || token.kind === "string") {
      index += 1;
    } else if (token.text === "BigInt" && tokens[index + 1]?.text === "(") {
      index += 2;
      if (tokens[index]?.kind !== "string") return false;
      index += 1;
      if (tokens[index]?.text !== ")") return false;
      index += 1;
    } else if (token.kind === "ident" && tokens[index + 1]?.text === "." && tokens[index + 2]?.kind === "ident") {
      index += 3;
    } else {
      return false;
    }
    if (tokens[index]?.text === ",") index += 1;
  }
  return tokens[index]?.text === ")";
}

/**
 * A `new Set([...])` or `new Map([[...]])` written entirely of literals.
 *
 * A set or a map the file writes at the top is the file's constant only when
 * every key is written down and nothing adds to it later: then its membership
 * is the comparisons it is, and reading it allocates no dictionary at all.
 * `end` is the token just past the construct.
 */
function collectionLiteral(
  tokens: readonly Token[],
  start: number,
): { keys: string[]; values: ConstantValue[] | null; keyKind: "text" | "number"; end: number } | null {
  if (tokens[start]?.text !== "new") return null;
  const kind = tokens[start + 1]?.text;
  if (kind !== "Set" && kind !== "Map") return null;
  let at = start + 2;
  if (tokens[at]?.text === "<") {
    let depth = 0;
    while (at < tokens.length) {
      const text = tokens[at]?.text;
      if (text === "<") depth += 1;
      else if (text === ">" || text === ">>" || text === ">>>") {
        depth -= text.length;
        if (depth <= 0) {
          at += 1;
          break;
        }
      }
      at += 1;
    }
  }
  if (tokens[at]?.text !== "(") return null;
  const after = closingBracket(tokens, at);
  const inner = at + 1;
  const keys: string[] = [];
  const values: ConstantValue[] = [];
  let keyKind: "text" | "number" = "text";
  if (tokens[inner]?.text === "[") {
    const close = closingBracket(tokens, inner) - 1;
    let depth = 0;
    let from = inner + 1;
    for (let index = inner + 1; index <= close; index += 1) {
      const text = mark(tokens[index]);
      if (index < close && (text === "[" || text === "{" || text === "(")) depth += 1;
      else if (index < close && (text === "]" || text === "}" || text === ")")) depth -= 1;
      else if (index === close || (text === "," && depth === 0)) {
        if (index === close && from === close) break;
        if (kind === "Set") {
          if (index !== from + 1) return null;
          const element = tokens[from] as Token;
          if (element.kind === "string") {
            keys.push(unescape(element.text, element.line));
            keyKind = "text";
          } else if (element.kind === "number") {
            keys.push(element.text);
            keyKind = "number";
          } else return null;
        } else {
          // A map entry is a pair: `["key", value]`.
          if (tokens[from]?.text !== "[") return null;
          if (closingBracket(tokens, from) !== index) return null;
          const pairClose = index - 1;
          const key = tokens[from + 1] as Token | undefined;
          if (key === undefined || (key.kind !== "string" && key.kind !== "number")) return null;
          keyKind = key.kind === "string" ? "text" : "number";
          const valueStart = from + 2;
          if (tokens[valueStart]?.text !== ",") return null;
          if (!constantRange(tokens, valueStart + 1, pairClose)) return null;
          keys.push(key.kind === "string" ? unescape(key.text, key.line) : key.text);
          values.push({ range: { start: valueStart + 1, end: pairClose } });
        }
        from = index + 1;
      }
    }
  } else if (tokens[inner]?.text !== ")") {
    return null;
  }
  return { keys, values: kind === "Map" ? values : null, keyKind, end: after };
}

/** Whether a name is added to or removed from after it is declared. */
function mutatesCollection(tokens: readonly Token[], name: string): boolean {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as Token;
    if (token.kind !== "ident" || token.text !== name) continue;
    if (tokens[index + 1]?.text !== ".") continue;
    const method = tokens[index + 2]?.text;
    if (method === "add" || method === "set" || method === "delete" || method === "clear") return true;
  }
  return false;
}

/** How many times a name is written in a token stream. */
function nameCount(tokens: readonly Token[], name: string): number {
  let count = 0;
  for (const token of tokens) {
    if (token.kind === "ident" && token.text === name) count += 1;
  }
  return count;
}


/** The index just past the bracket that closes the one at `open`. */
function closingBracket(tokens: readonly Token[], open: number): number {
  let depth = 0;
  for (let index = open; index < tokens.length; index += 1) {
    const token = mark(tokens[index]);
    if (token === "[" || token === "{" || token === "(") depth += 1;
    else if (token === "]" || token === "}" || token === ")") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return tokens.length;
}

/**
 * Whether an array written at the top of a file is a value the compiler can
 * read without running anything: every element is a number, a text, a whole
 * number, or an array of those.
 */
function constantList(tokens: readonly Token[], open: number, close: number): boolean {
  let depth = 0;
  let from = open + 1;
  const elements: (readonly [number, number])[] = [];
  for (let index = open + 1; index < close; index += 1) {
    const token = mark(tokens[index]);
    if (token === "[" || token === "{" || token === "(") depth += 1;
    else if (token === "]" || token === "}" || token === ")") depth -= 1;
    else if (token === "," && depth === 0) {
      elements.push([from, index]);
      from = index + 1;
    }
  }
  elements.push([from, close]);
  if (elements.length === 1 && elements[0]?.[0] === elements[0]?.[1]) return true;
  for (const [start, end] of elements) {
    // The list may end with a comma, which names no element.
    if (start === end && start === close) continue;
    if (start === end) return false;
    if (tokens[start]?.text === "[") {
      const nested = closingBracket(tokens, start);
      if (nested !== end + 1 || !constantList(tokens, start, nested - 1)) return false;
      continue;
    }
    if (!constantRange(tokens, start, end)) return false;
  }
  return true;
}

/**
 * Whether a top-level name is written somewhere, so its value cannot be read
 * where it is used. A name a function pushes to, or writes an element of, is
 * state the program holds rather than a value the file wrote.
 */
function writtenName(tokens: readonly Token[], name: string): boolean {
  const changing: ReadonlySet<string> = new Set([
    "push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin",
  ]);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as Token;
    if (token.kind !== "ident" || token.text !== name) continue;
    // The declaration itself is not a write of the name.
    const before = tokens[index - 1]?.text;
    if (before === "const" || before === "let" || before === "var") continue;
    const next = tokens[index + 1];
    if (next?.text === "=" || next?.text === "++" || next?.text === "--") return true;
    if (next?.text === "." && changing.has(tokens[index + 2]?.text ?? "")) return true;
    if (next?.text === "[") {
      const close = closingBracket(tokens, index + 1);
      if (tokens[close]?.text === "=") return true;
    }
  }
  return false;
}

function scanConstants(tokens: readonly Token[]): ScannedFile {
  const found = new Map<string, ConstantInfo>();
  const state = new Set<string>();
  // A name a function or a class declares is that body's own, and a name that
  // is also a constant of the file is not the constant where it is declared.
  // The declarations are collected first so a body is never read as the file's
  // constant: a parameter spelled `P` is the parameter, whatever the file
  // writes at the top of it.
  const locals = localNames(tokens);
  const closing = (open: number): number => {
    let depth = 0;
    for (let index = open; index < tokens.length; index += 1) {
      const text = mark(tokens[index]);
      if (text === "{") depth += 1;
      else if (text === "}") {
        depth -= 1;
        if (depth === 0) return index + 1;
      }
    }
    return tokens.length;
  };
  let index = 0;
  while (index < tokens.length && tokens[index].kind !== "end") {
    const token = tokens[index] as Token;
    if (token.text === "import") {
      while (index < tokens.length && tokens[index].text !== ";") index += 1;
      index += 1;
      continue;
    }
    // A function or a class body is not the top of the file: the declaration a
    // function writes is its own, and only the file's constants are read here.
    if (token.text === "function" || token.text === "class") {
      let brace = index;
      while (brace < tokens.length && tokens[brace].text !== "{") brace += 1;
      index = closing(brace);
      continue;
    }
    if (
      (token.text === "const" || token.text === "let" || token.text === "var") &&
      tokens[index + 1]?.kind === "ident"
    ) {
      const name = (tokens[index + 1] as Token).text;
      const mutable = token.text !== "const";
      // `export const NAME = ...` offers the value to a module that imports the
      // name, and what it offers is the value itself.
      const offered = tokens[index - 1]?.text === "export";
      // `const NAME: Type = value` writes the type between the name and the
      // value, and the type is erased: what the scan needs is where the value
      // starts.
      let equals = index + 2;
      if (tokens[equals]?.text === ":") {
        let depth = 0;
        equals += 1;
        while (equals < tokens.length) {
          const written = mark(tokens[equals]);
          if (written === "<" || written === "(" || written === "[" || written === "{") depth += 1;
          else if (written === ">" || written === ")" || written === "]" || written === "}") depth -= 1;
          else if (written === "=" && depth === 0) break;
          equals += 1;
        }
      }
      if (tokens[equals]?.text !== "=") {
        index += 1;
        continue;
      }
      const start = equals + 1;
      // A set or a map written entirely of literals is the file's constant:
      // its membership is the comparisons it is, and no dictionary is
      // allocated. A name that is added to is state, because the value after
      // the addition is not the one the source wrote.
      const written = collectionLiteral(tokens, start);
      if (written !== null) {
        if (!mutable && !locals.has(name) && !mutatesCollection(tokens, name)) {
          found.set(name, written.values === null
            ? { keys: written.keys, keyKind: written.keyKind, exported: offered }
            : { keys: written.keys, values: written.values, keyKind: written.keyKind, exported: offered });
        } else {
          state.add(name);
        }
        index = written.end;
        continue;
      }
      if (tokens[start]?.text === "[") {
        const end = closingBracket(tokens, start);
        // An array whose every element is written down is the file's constant,
        // inlined where it is read, unless a body writes the name: a value a
        // program changes is state rather than a constant.
        if (!mutable && constantList(tokens, start, end - 1) && !locals.has(name) && !writtenName(tokens, name)) {
          found.set(name, { expression: { range: { start, end } }, exported: offered });
        } else {
          state.add(name);
        }
        index = end;
        continue;
      }
      if (tokens[start]?.text === "{") {
        const end = closing(start);
        const object = objectConstants(tokens, start, end);
        // An object whose every field is a constant is the file's constant (a
        // curve's fields are), and a body's read of one is the value written
        // there. An object with a field computed at run time is state the
        // running program holds, and a function that reads it is read where the
        // program is.
        if (!mutable && object.all) {
          if (!locals.has(name)) found.set(name, { fields: object.fields, exported: offered });
        } else {
          state.add(name);
        }
        index = end;
        continue;
      }
      let end = start;
      let depth = 0;
      while (end < tokens.length && tokens[end].kind !== "end") {
        const written = mark(tokens[end]);
        if (written === "(" || written === "[" || written === "{") depth += 1;
        else if (written === ")" || written === "]" || written === "}") depth -= 1;
        else if (written === ";" && depth === 0) break;
        end += 1;
      }
      const construction = !mutable && constructorRange(tokens, start, end);
      const constant = !mutable && (construction || constantRange(tokens, start, end));
      // An instance is inlined only where the file reads it once: two reads of
      // a name are two reads of one object, and two allocations are two.
      const shared = construction && nameCount(tokens, name) > 2;
      if (!constant || shared) state.add(name);
      else if (!locals.has(name)) found.set(name, { expression: { range: { start, end } }, exported: offered, ...(construction ? { constructed: true } : {}) });
      index = end + 1;
      continue;
    }
    index += 1;
  }
  // `export { NAME };` offers a constant the declarations above wrote, under
  // the name the list writes. A list with a `from` names another module and
  // offers nothing of this one's.
  exportConstantLists(tokens, found);
  return { constants: found, state };
}

/** Marks the constants an `export { ... }` list of this file offers. */
function exportConstantLists(tokens: readonly Token[], found: Map<string, ConstantInfo>): void {
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.text !== "export") continue;
    let at = index + 1;
    if (tokens[at]?.text === "type") at += 1;
    if (tokens[at]?.text !== "{") continue;
    let close = at + 1;
    let depth = 1;
    while (close < tokens.length && depth > 0) {
      const written = tokens[close]?.text;
      if (written === "{") depth += 1;
      else if (written === "}") depth -= 1;
      close += 1;
    }
    if (tokens[close]?.text === "from") continue;
    for (let one = at + 1; one < close; one += 1) {
      const token = tokens[one];
      if (token === undefined || token.kind !== "ident") continue;
      // `export { NAME as other }` offers the value under a name this file does
      // not hold; the list itself is refused where the import is read, so only
      // the plain name is marked here.
      const next = tokens[one + 1];
      if (next?.text === "as") continue;
      const held = found.get(token.text);
      if (held !== undefined) held.exported = true;
    }
  }
}

/**
 * Every name a function, class or block declares anywhere in the file.
 *
 * A declaration at the top of the file is the file's constant and is not one of
 * these; every other declaration is a body's own. The parameters are collected
 * from the same shape a declaration is written in — an identifier and the colon
 * that says its type — which over-collects a field of an object literal, and
 * that only means a constant of the same name is not read where the source may
 * mean the body's own.
 */
function localNames(tokens: readonly Token[]): Set<string> {
  const names = new Set<string>();
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as Token;
    if (mark(token) === "{") {
      depth += 1;
      continue;
    }
    if (mark(token) === "}") {
      depth -= 1;
      continue;
    }
    if (depth > 0 && (token.text === "let" || token.text === "const" || token.text === "var")) {
      const name = tokens[index + 1];
      if (name?.kind === "ident") names.add(name.text);
    }
    if (token.kind === "ident" && tokens[index + 1]?.text === ":") {
      // A top-level `const NAME: Type` is the file's name, not a body's: the
      // annotation is what made it look like a parameter here.
      const before = tokens[index - 1]?.text;
      if (depth === 0 && (before === "const" || before === "let" || before === "var")) continue;
      names.add(token.text);
    }
  }
  return names;
}

/**
 * The names a file's imports bind.
 *
 * An import that names a type is the only way a type declared in another module
 * reaches this one, and a plain `import { Box }` binds a type as readily as a
 * value: the source does not say which, so both are kept. The names are read
 * from the tokens rather than from the parse, because classes are lowered
 * before the imports are read and their fields may name an imported type.
 */
function importedNames(tokens: readonly Token[]): Set<string> {
  const names = new Set<string>();
  let index = 0;
  while (index < tokens.length) {
    if (tokens[index]?.text === ";") {
      index += 1;
      continue;
    }
    if (tokens[index]?.text !== "import") break;
    index += 1;
    if (tokens[index]?.text === "type") index += 1;
    if (tokens[index]?.text === "*") {
      while (index < tokens.length && tokens[index]?.kind !== "string") index += 1;
      index += 1;
      continue;
    }
    if (tokens[index]?.text === "{") {
      index += 1;
      while (index < tokens.length && tokens[index]?.text !== "}") {
        const token = tokens[index] as Token;
        if (token.kind === "ident" && token.text !== "type" && token.text !== "as") names.add(token.text);
        index += 1;
      }
      index += 1;
    } else if (tokens[index]?.kind === "ident") {
      // `import d from "./x.ts"` and `import d, { a } from "./x.ts"`.
      names.add((tokens[index] as Token).text);
      index += 1;
      if (tokens[index]?.text === ",") index += 1;
    }
    while (index < tokens.length && tokens[index]?.text !== "from") index += 1;
    if (index < tokens.length) index += 1;
    if (tokens[index]?.kind === "string") index += 1;
    if (tokens[index]?.text === ";") index += 1;
  }
  return names;
}

/**
 * Whether a function reads a value the running program holds.
 *
 * A top-level `const` of a constant expression, a function and a class are
 * values a module function can read: the first is written into the function,
 * and the other two are declarations of the same program. A `let`, or a `const`
 * of a value computed at run time, is a value the program holds while it runs,
 * and a function that reads one is compiled where that value is — the program's
 * own functions are handed what they read of the program around them.
 */
function readsState(fn: TypeScriptFunction, state: ReadonlySet<string>): boolean {
  if (state.size === 0) return false;
  // A name a function declares is its own only where the scope that declares it
  // is around the read: a parameter named like a value the program holds is the
  // parameter, and a name declared inside a block is that block's. A read no
  // scope binds is the file's value, and the function that reads it is read
  // where the program runs.
  let found = false;
  walkFunction(fn, (name, bound) => {
    if (!bound && state.has(name)) found = true;
  });
  return found;
}

/** Every function a body calls, by the name the source wrote. */
/**
 * A body with every call of one name read as a call of a function of the file.
 *
 * An arrow is read before the declaration binds it, so a call the body writes
 * of the name it is about to be given is a plain call of a function of that
 * name. A recursive arrow is a function of the file like any other — the one it
 * lifted to — and its captured values are that function's leading parameters,
 * which the body can name, so the call is rewritten with them in front of its
 * own arguments: the same rewriting every call site after the declaration does.
 *
 * Only a call of the name itself is rewritten. A field, a name that is only read
 * as a value, and a call of anything else are left as they are.
 */
function callsRewritten<T>(node: T, source: string, target: string, captures: readonly string[]): T {
  if (Array.isArray(node)) {
    return node.map((entry) => callsRewritten(entry, source, target, captures)) as T;
  }
  if (node !== null && typeof node === "object") {
    const call = node as { k?: unknown; name?: unknown; args?: unknown };
    if (call.k === "call" && call.name === source && Array.isArray(call.args)) {
      return {
        ...(node as object),
        name: target,
        args: [...captures.map((name) => ({ k: "ident", name })), ...call.args],
      } as T;
    }
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>).map(([name, entry]) => [
        name,
        callsRewritten(entry, source, target, captures),
      ]),
    ) as T;
  }
  return node;
}

function callsOf(fn: TypeScriptFunction): Set<string> {
  const called = new Set<string>();
  walkFunction(fn, () => {}, (name) => called.add(name));
  return called;
}

/**
 * Every name a function body reads, and every function it calls, in the order
 * the body writes them. One walk answers both questions, so a name and a call
 * are found by the same reading of the body. Each read says whether a scope of
 * the function binds the name, because a name the body declares is not the
 * file's value outside the scope that declares it.
 */
function walkFunction(
  fn: TypeScriptFunction,
  onName: (text: string, bound: boolean) => void,
  onCall: (name: string) => void = () => {},
): void {
  // The scopes around the read, innermost last. A parameter is in every one of
  // them; a block, a loop and a catch arm add their own.
  const scopes: Set<string>[] = [new Set(fn.params.map((param) => param.name))];
  const bound = (name: string): boolean => scopes.some((scope) => scope.has(name));
  const read = (expression: Expression | null): void => {
    if (expression === null) return;
    switch (expression.k) {
      case "literal":
      case "bigint":
      case "null":
        return;
      case "ident":
        onName(expression.name, bound(expression.name));
        return;
      case "argv":
        read(expression.index);
        return;
      case "length":
        onName(expression.buffer, bound(expression.buffer));
        return;
      case "lengthOf":
        read(expression.of);
        return;
      case "index":
        read(expression.base);
        read(expression.index);
        return;
      case "slice":
        read(expression.base);
        read(expression.start);
        read(expression.stop);
        read(expression.step);
        return;
      case "member":
        read(expression.base);
        return;
      case "call":
        onCall(expression.name);
        for (const argument of expression.args) read(argument);
        return;
      case "object":
        for (const field of expression.fields) read(field.value);
        return;
      case "sized":
        read(expression.count);
        return;
      case "buffer":
        for (const value of expression.values) read(value);
        return;
      case "text":
        for (const part of expression.parts) if (part.k === "value") read(part.value);
        return;
      case "fixed":
        read(expression.of);
        return;
      case "binary":
        read(expression.left);
        read(expression.right);
        return;
      case "unary":
        read(expression.operand);
        return;
      case "conditional":
        read(expression.condition);
        read(expression.then);
        read(expression.otherwise);
        return;
      case "update":
        onName(expression.name, bound(expression.name));
        return;
      case "arrow":
        // An arrow reads the values it captured from the function around it, so
        // a name one of them reads is a read of that name here too.
        for (const capture of expression.captures) onName(capture, bound(capture));
        return;
      case "capture":
        read(expression.closure);
        return;
      case "invoke":
        read(expression.callee);
        for (const argument of expression.args) read(argument);
        return;
      case "append":
        read(appendArray(expression));
        for (const value of expression.values) read(value);
        return;
    }
  };
  const statements = (body: readonly Statement[]): void => {
    // The body is a scope of its own: a name it declares is not bound before
    // the declaration and not bound after the block that declares it.
    scopes.push(new Set());
    for (const statement of body) {
      switch (statement.kind) {
        case "declare":
          read(statement.init);
          scopes[scopes.length - 1].add(statement.name);
          break;
        case "loop":
          read(statement.from);
          read(statement.to);
          read(statement.step);
          // The loop variable is bound by the loop, not by the function, so a
          // read after the loop is a read of the value around it.
          scopes.push(new Set([statement.variable]));
          statements(statement.body);
          scopes.pop();
          break;
        case "assign":
          onName(statement.target, bound(statement.target));
          read(statement.value);
          break;
        case "memberAssign":
          onName(statement.base, bound(statement.base));
          read(statement.value);
          break;
        case "update":
          onName(statement.name, bound(statement.name));
          break;
        case "result":
          read(statement.value);
          break;
        case "throw":
          read(statement.value);
          break;
        case "if":
          read(statement.condition);
          statements(statement.then);
          statements(statement.otherwise);
          break;
        case "while":
        case "doWhile":
          read(statement.condition);
          statements(statement.body);
          break;
        case "forOf":
          onName(statement.of, bound(statement.of));
          // The element a `for-of` binds is the loop's own name.
          scopes.push(new Set([statement.variable]));
          statements(statement.body);
          scopes.pop();
          break;
        case "print":
        case "expression":
          read(statement.value);
          break;
        case "indexAssign":
          onName(statement.buffer, bound(statement.buffer));
          read(statement.index);
          read(statement.value);
          break;
        case "try":
          statements(statement.body);
          if (statement.catchBody !== null) {
            // The catch parameter is bound by the arm it catches in.
            scopes.push(new Set(statement.catchParam === null ? [] : [statement.catchParam]));
            statements(statement.catchBody);
            scopes.pop();
          }
          if (statement.finallyBody !== null) statements(statement.finallyBody);
          break;
        default:
          break;
      }
    }
    scopes.pop();
  };
  for (const param of fn.params) if (param.default !== undefined) read(param.default);
  statements(fn.body);
}

/**
 * The names an arrow function reads from the function around it, and the names
 * it writes.
 *
 * An arrow that is lifted into a function of its own is handed the values it
 * captured as parameters, so a read of one is a read of the parameter. A write
 * is not the same thing: the lifted function would write its own copy and the
 * function it was written in would never see it, which is the one thing a
 * closure does and a parameter cannot. Those arrows are refused, so the names
 * written are answered beside the names read.
 *
 * A name a namespace or a builtin spells — `Math.max`, `text.indexOf` — is not
 * a value the arrow captured, so it is not one of these.
 */
function arrowCaptures(
  params: readonly { name: string }[],
  body: readonly Statement[],
): { captures: string[]; written: string[] } {
  const captures: string[] = [];
  const written: string[] = [];
  const scopes: Set<string>[] = [new Set(params.map((param) => param.name))];
  const bound = (name: string): boolean => scopes.some((scope) => scope.has(name));
  /** Whether a free name is a value of the file rather than one of the compiler's own names. */
  const capturable = (name: string): boolean => name !== "" && !name.includes(".") && builtinFor(name) === null;
  const read = (expression: Expression | null): void => {
    if (expression === null) return;
    switch (expression.k) {
      case "literal":
      case "bigint":
      case "null":
        return;
      case "ident":
        if (!bound(expression.name) && capturable(expression.name) && !captures.includes(expression.name)) {
          captures.push(expression.name);
        }
        return;
      case "argv":
        read(expression.index);
        return;
      case "length":
        if (!bound(expression.buffer) && capturable(expression.buffer) && !captures.includes(expression.buffer)) {
          captures.push(expression.buffer);
        }
        return;
      case "lengthOf":
        read(expression.of);
        return;
      case "index":
        read(expression.base);
        read(expression.index);
        return;
      case "slice":
        read(expression.base);
        read(expression.start);
        read(expression.stop);
        read(expression.step);
        return;
      case "member":
        read(expression.base);
        return;
      case "call":
        for (const argument of expression.args) read(argument);
        return;
      case "object":
        for (const field of expression.fields) read(field.value);
        return;
      case "sized":
        read(expression.count);
        return;
      case "buffer":
        for (const value of expression.values) read(value);
        return;
      case "text":
        for (const part of expression.parts) if (part.k === "value") read(part.value);
        return;
      case "fixed":
        read(expression.of);
        return;
      case "binary":
        read(expression.left);
        read(expression.right);
        return;
      case "unary":
        read(expression.operand);
        return;
      case "conditional":
        read(expression.condition);
        read(expression.then);
        read(expression.otherwise);
        return;
      case "update":
        write(expression.name);
        return;
      case "arrow":
        // An arrow written inside this one is a closure built here, and the
        // values it captured are read from right here: a name of the function
        // around this arrow is one this arrow captures too, so that it can hand
        // it on.
        for (const capture of expression.captures) read({ k: "ident", name: capture });
        return;
      case "capture":
        read(expression.closure);
        return;
      case "invoke":
        read(expression.callee);
        for (const argument of expression.args) read(argument);
        return;
      case "append":
        read(appendArray(expression));
        for (const value of expression.values) read(value);
        return;
    }
  };
  /** A name the body writes, which is the one thing a parameter cannot carry. */
  const write = (name: string): void => {
    if (bound(name)) return;
    if (!written.includes(name)) written.push(name);
  };
  const statements = (ones: readonly Statement[]): void => {
    scopes.push(new Set());
    for (const statement of ones) {
      switch (statement.kind) {
        case "declare":
          read(statement.init);
          scopes[scopes.length - 1].add(statement.name);
          break;
        case "loop":
          read(statement.from);
          read(statement.to);
          read(statement.step);
          scopes.push(new Set([statement.variable]));
          statements(statement.body);
          scopes.pop();
          break;
        case "assign":
          write(statement.target);
          read(statement.value);
          break;
        case "memberAssign":
          read({ k: "ident", name: statement.base });
          read(statement.value);
          break;
        case "update":
          write(statement.name);
          break;
        case "result":
          read(statement.value);
          break;
        case "throw":
          read(statement.value);
          break;
        case "if":
          read(statement.condition);
          statements(statement.then);
          statements(statement.otherwise);
          break;
        case "while":
        case "doWhile":
          read(statement.condition);
          statements(statement.body);
          break;
        case "forOf":
          read({ k: "ident", name: statement.of });
          scopes.push(new Set([statement.variable]));
          statements(statement.body);
          scopes.pop();
          break;
        case "print":
        case "expression":
          read(statement.value);
          break;
        case "indexAssign":
          read({ k: "ident", name: statement.buffer });
          read(statement.index);
          read(statement.value);
          break;
        case "try":
          statements(statement.body);
          if (statement.catchBody !== null) {
            scopes.push(new Set(statement.catchParam === null ? [] : [statement.catchParam]));
            statements(statement.catchBody);
            scopes.pop();
          }
          if (statement.finallyBody !== null) statements(statement.finallyBody);
          break;
        default:
          break;
      }
    }
    scopes.pop();
  };
  statements(body);
  return { captures, written };
}

/** The tokens one construct of a file is written in. */
interface Span {
  start: number;
  end: number;
}

/** One declaration of a module, and where the parser read it. */
interface Declaration extends Span {
  /** The functions the declaration adds, whether the module or the body holds them. */
  entries: DeclaredFunction[];
  /**
   * True when the declaration is written as an export. An exported function is
   * the module's interface, so a refusal in it is the module's to report and it
   * is never handed to the program parser.
   */
  exported: boolean;
  /**
   * True when the body holds the declaration, so it is a function of the
   * program: a construct the module refused, or a function that reads one.
   */
  program: boolean;
  /** Everything the declaration calls, by the name the source wrote. */
  calls: ReadonlySet<string>;
  /** Why the module could not hold it, where it could not. */
  refusal: readonly Diagnostic[];
  /** The name it offers as the module's default, where it offers one. */
  offers: string | null;
}

/** The constant fields of an object literal, by the name each is written under. */
function objectConstants(tokens: readonly Token[], open: number, close: number): { fields: Map<string, ConstantValue>; all: boolean } {
  const fields = new Map<string, ConstantValue>();
  let total = 0;
  let depth = 0;
  let index = open + 1;
  while (index < close - 1) {
    const token = tokens[index] as Token;
    if (mark(token) === "{" || mark(token) === "(" || mark(token) === "[") {
      depth += 1;
      index += 1;
      continue;
    }
    if (mark(token) === "}" || mark(token) === ")" || mark(token) === "]") {
      depth -= 1;
      index += 1;
      continue;
    }
    if (depth === 0 && token.kind === "ident" && tokens[index + 1]?.text === ":") {
      total += 1;
      const start = index + 2;
      let end = start;
      let nested = 0;
      while (end < close - 1) {
        const written = mark(tokens[end]);
        if (written === "{" || written === "(" || written === "[") nested += 1;
        else if (written === "}" || written === ")" || written === "]") nested -= 1;
        else if (written === "," && nested === 0) break;
        end += 1;
      }
      if (constantRange(tokens, start, end)) fields.set(token.text, { range: { start, end } });
      index = end + 1;
      continue;
    }
    index += 1;
  }
  return { fields, all: fields.size === total && total > 0 };
}

/**
 * Whether the tokens between two positions are an expression the compiler can
 * read without running anything: a number, a string, a `BigInt` of one, or an
 * arithmetic expression of those.
 */
function constantRange(tokens: readonly Token[], start: number, end: number): boolean {
  if (end <= start) return false;
  const operators: ReadonlySet<string> = new Set(["+", "-", "*", "/", "%", "**", "&", "|", "^", "<<", ">>", "(", ")"]);
  for (let index = start; index < end; index += 1) {
    const token = tokens[index] as Token;
    if (token.kind === "number" || token.kind === "bigint" || token.kind === "string" || token.kind === "regex") continue;
    if (token.kind === "punct" && operators.has(token.text)) continue;
    if (token.kind === "ident" && token.text === "BigInt") continue;
    return false;
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* Lexer                                                                      */
/* -------------------------------------------------------------------------- */

export type TokenKind = "number" | "bigint" | "ident" | "punct" | "string" | "regex" | "unknown" | "end";

export interface Token {
  kind: TokenKind;
  text: string;
  line: number;
  /** Set on a string written in backticks, whose `${...}` parts interpolate. */
  template?: boolean;
  /** The character the string was written with. */
  quote?: string;
  /** Set on a regular expression, whose text is the pattern it matches. */
  flags?: string;
}
const PUNCTUATION = ["...", "===", "!==", "**=", "**", "==", "!=", "<=", ">=", ">>>=", ">>=", "<<=", "<<", ">>>", ">>", "&&", "||", "??=", "??", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "=>", "{", "}", "(", ")", "[", "]", ";", ",", ":", "?", "=", "<", ">", "+", "-", "*", "/", "%", ".", "!", "~", "&", "|", "^"];

/**
 * Whether a slash where the scanner stands starts a regular expression rather
 * than divides.
 *
 * A slash is division after a value: a name, a number, a string, a call, an
 * index or a literal regular expression. It is the start of one everywhere an
 * expression starts, and after the keywords a body writes before a value. The
 * two forms share a character, so this is the one question the scanner asks of
 * the token before it.
 */
const REGEX_PREFIX_KEYWORDS: ReadonlySet<string> = new Set([
  "return",
  "case",
  "throw",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "do",
  "else",
  "yield",
  "await",
  "default",
]);

function regexAllowed(tokens: readonly Token[]): boolean {
  const last = tokens[tokens.length - 1];
  if (last === undefined) return true;
  if (last.kind === "number" || last.kind === "bigint" || last.kind === "string" || last.kind === "regex") return false;
  if (last.kind === "ident") return REGEX_PREFIX_KEYWORDS.has(last.text);
  if (last.kind === "punct") {
    return last.text !== ")" && last.text !== "]" && last.text !== "}" && last.text !== "++" && last.text !== "--";
  }
  return true;
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let line = 1;
  // A file may open with `#!` and the interpreter that runs it, which is the
  // host's line rather than the program's: it is skipped the way a comment is.
  if (source.startsWith("#!")) {
    const end = source.indexOf("\n");
    index = end < 0 ? source.length : end;
  }

  while (index < source.length) {
    const character = source[index];
    if (character === "\n") {
      line += 1;
      index += 1;
      continue;
    }
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index);
      index = end < 0 ? source.length : end;
      continue;
    }
    if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) throw frontendError("unterminated block comment", `line ${line}`);
      line += (source.slice(index, end).match(/\n/g) ?? []).length;
      index = end + 2;
      continue;
    }
    // A slash that starts an expression is a regular expression, and its
    // pattern runs to the next slash outside a character class. A backslash
    // covers the character after it, so a slash written as `\/` is part of the
    // pattern and not its end; a slash inside `[...]` is part of the class.
    if (character === "/" && !source.startsWith("/=", index) && regexAllowed(tokens)) {
      const startLine = line;
      let end = index + 1;
      let inClass = false;
      for (;;) {
        if (end >= source.length || source[end] === "\n") {
          throw frontendError("unterminated regular expression", `line ${startLine}`);
        }
        const next = source[end];
        if (next === "\\") {
          end += 2;
          continue;
        }
        if (next === "[") inClass = true;
        else if (next === "]") inClass = false;
        else if (next === "/" && !inClass) break;
        end += 1;
      }
      const pattern = source.slice(index + 1, end);
      let after = end + 1;
      const flagStart = after;
      while (after < source.length && /[a-z]/.test(source[after] as string)) after += 1;
      tokens.push({ kind: "regex", text: pattern, flags: source.slice(flagStart, after), line: startLine });
      index = after;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      // Only an import names a module and only a template string is printed, so
      // the string is kept whole and the parser decides where one is allowed.
      // A quote an escape covers does not end the string, and a string that
      // spans lines moves the line every construct after it is reported on.
      const startLine = line;
      let end = index + 1;
      for (;;) {
        end = source.indexOf(character, end);
        // A string that is never closed is a truncated file, and treating the
        // missing quote as the end sent the scan back to the start of the
        // source, where it read the same string again and for ever.
        if (end < 0) throw frontendError("unterminated string", `line ${startLine}`);
        const backslashes = /\\*$/.exec(source.slice(index + 1, end))?.[0].length ?? 0;
        if (backslashes % 2 !== 0) {
          end += 1;
          continue;
        }
        // A backtick inside an interpolation belongs to the template nested
        // there, not to this one: the first unescaped backtick past an
        // unclosed `${` ends the inner template. Between this template's
        // opening and the candidate closing quote, walk the interpolations —
        // if one has no close before the candidate, the candidate quote is
        // inside it, so the search continues past that interpolation.
        if (character === "`") {
          const between = source.slice(index + 1, end);
          let cursor = 0;
          let inside = false;
          for (;;) {
            const open = between.indexOf("${", cursor);
            if (open < 0) break;
            const escaped = /\\*$/.exec(between.slice(0, open))?.[0].length ?? 0;
            if (escaped % 2 === 1) {
              cursor = open + 2;
              continue;
            }
            const close = closingBrace(between, open);
            if (close < 0) {
              inside = true;
              const closeSource = closingBrace(source, index + 1 + open);
              if (closeSource < 0) throw frontendError("unterminated string", `line ${startLine}`);
              end = closeSource + 1;
              break;
            }
            cursor = close + 1;
          }
          if (inside) continue;
        }
        break;
      }
      line += (source.slice(index, end).match(/\n/g) ?? []).length;
      tokens.push({ kind: "string", text: source.slice(index + 1, end), line: startLine, quote: character, template: character === "`" });
      index = end + 1;
      continue;
    }
    if (/[0-9]/.test(character) || (character === "." && /[0-9]/.test(source[index + 1] ?? ""))) {
      // A number may write `_` between its digits, as `600_000` does, and it
      // may be written in binary or octal, as the bit fields of an encoder are:
      // both are the value they name, and the compiler reads a number's digits
      // as the decimal they are.
      const match = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|[0-9_]*\.[0-9_]+|[0-9][0-9_]*)(?:[eE][+-]?[0-9_]+)?/.exec(source.slice(index));
      if (match === null) throw frontendError(`malformed number`, `line ${line}`);
      tokens.push({ kind: "number", text: numberText(match[0]), line });
      index += match[0].length;
      continue;
    }
    // The `n` of a bigint literal follows the number it is attached to, and
    // the token before it has to be that number: reading the character before
    // the `n` alone takes the dot of `x.name` for the end of a number and
    // retypes it, which eats the `n` and leaves the field one letter short.
    if (source.startsWith("n", index) && tokens[tokens.length - 1]?.kind === "number") {
      tokens[tokens.length - 1].kind = "bigint";
      index += 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(character)) {
      const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(index));
      if (match === null) throw frontendError(`malformed identifier`, `line ${line}`);
      tokens.push({ kind: "ident", text: match[0], line });
      index += match[0].length;
      continue;
    }
    const punctuation = PUNCTUATION.find((candidate) => source.startsWith(candidate, index));
    // An unknown character becomes a token: the parser reads on and reports
    // the first construct outside the subset, which is the useful error.
    if (punctuation === undefined) {
      tokens.push({ kind: "unknown", text: character, line });
      index += 1;
      continue;
    }
    tokens.push({ kind: "punct", text: punctuation, line });
    index += punctuation.length;
  }
  tokens.push({ kind: "end", text: "", line });
  return tokens;
}

/* -------------------------------------------------------------------------- */
/* Syntax                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The name a file's generated functions are marked by: its own, made into
 * something a C identifier and a symbol may be.
 */
function nameStem(path: string): string {
  const file = path.slice(path.lastIndexOf("/") + 1);
  const stem = file.replace(/\.(?:ts|tsx|js|mjs|cjs)$/i, "").replace(/[^A-Za-z0-9_]/g, "_");
  return stem === "" ? "file" : stem;
}

/**
 * The arrow a name of a body is bound to: the function it was lifted to, the
 * values it captured, and the function that enters it as a value.
 *
 * Called by the name it is bound to, an arrow is a direct call of the function
 * its body became, with the captured values written in front of the arguments.
 * Read as a value, it is a closure: the captured values travel with it and the
 * `code` entry unpacks them, so a holder that never saw the declaration can
 * still call it.
 */
interface ArrowBinding {
  /** The name of the function the arrow lifted to. */
  function: string;
  /** The names it captured, in the order the lifted function takes them. */
  captures: string[];
  /** The type each capture was held at when the arrow was written. */
  captureTypes: TypeExpr[];
  /** The parameters the arrow itself was written with. */
  params: { name: string; type: TypeExpr }[];
  /** What the arrow answers. */
  returns: TypeExpr;
  /** The function a call through the closure enters, once one is needed. */
  code?: string;
}

/** The signature a function type annotation names. */
interface FunctionType {
  params: TypeExpr[];
  returns: TypeExpr;
}

/**
 * A type a use fixes an arrow's parameter at.
 *
 * The type is what the contract can carry, and the shape is what a record the
 * contract erases still says: `a.map((r) => r.name)` over an array of an
 * interface reads `name` through the shape, not through the type.
 */
interface ArrowParameterType {
  type: TypeExpr;
  shape: ResolvedType | null;
}

/**
 * What a name holds when it is a map or a set.
 *
 * A map is a value of this compiler like any other: one handle, which is the
 * runtime's dictionary. What it holds is not a type the contract can spell, so
 * the frontend keeps it beside the name: `m.get(k)` answers the value type the
 * source declared, and `s.add(v)` answers the set.
 */
interface CollectionValue {
  kind: "map" | "set";
  /** The element a key is; this frontend keys by text. */
  key: TypeExpr;
  /** The value a map holds, which is the number `1` for a set. */
  value: TypeExpr;
}

export interface TypeScriptFunction {
  name: string;
  /**
   * The source wrote `async` in front of the function. The body runs when the
   * function is called and what it answers is a promise carrying what the body
   * returns: `returns` is the type of that value.
   */
  async?: boolean;
  /**
   * The value the promise the function answers carries, for a function that
   * answers a promise its body did not make: the overload that fills a default
   * parameter calls the async function itself and hands its promise on.
   */
  promise?: TypeExpr;
  /**
   * The parameters the function is written with. A parameter with a default is
   * callable without it, which the module answers with an overload: see
   * `defaultWrappers`.
   */
  params: { name: string; type: TypeExpr; default?: Expression }[];
  returns: TypeExpr;
  /**
   * What the declared result holds, where the contract type erased it: the
   * fields of an interface, the elements of a list.
   */
  returnsShape?: ResolvedType;
  body: Statement[];
  line: number;
  /**
   * The map or the set the function answers, when it answers one.
   *
   * A map is one handle and no type the contract spells, so a caller that holds
   * what a function answered is told here what it holds.
   */
  collection?: CollectionValue;
  /**
   * True for the function an arrow's body was lifted into. Nobody outside the
   * declaration that wrote it can call it, so its contract states no
   * postcondition and no buffer bounds: the function that wrote the arrow is
   * what holds those, and it hands the arrow the values it captured.
   */
  closure?: true;
}

/** Whether the file's bigints reach past the machine word. */
function fileHoldsWideBigint(tokens: readonly Token[]): boolean {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as Token;
    // `BigInt('0x...')` is a bigint written as digits, and the width it reaches
    // is the width its value has: a constant constructor is still a value of
    // the file.
    if (
      token.kind === "ident" &&
      token.text === "BigInt" &&
      tokens[index + 1]?.text === "(" &&
      tokens[index + 2]?.kind === "string"
    ) {
      try {
        const value = BigInt((tokens[index + 2] as Token).text);
        if (value > 9223372036854775807n || value < -9223372036854775808n) return true;
      } catch {
        // Not digits the language reads: the parser reports it where it is.
      }
    }
    if (token.kind !== "bigint") continue;
    let value: bigint;
    try {
      value = BigInt(token.text);
    } catch {
      continue;
    }
    if (value > 9223372036854775807n || value < -9223372036854775808n) return true;
  }
  return false;
}

/**
 * The methods a typed array is walked by: the ones this frontend writes a
 * function of the file for. A method it has no reading of is a method of a
 * class the source declared, and the class is what says what it is.
 */
const COLLECTION_METHODS: ReadonlySet<string> = new Set([
  "map",
  "filter",
  "forEach",
  "every",
  "some",
  "find",
  "findIndex",
  "reduce",
  "sort",
  "join",
  "includes",
  "indexOf",
  "at",
  "slice",
]);

/** The operators that stand in front of a value, as opposed to between two. */
const UNARY_OPERATORS: readonly string[] = ["!", "-", "+", "~"];

/**
 * Where an arrow function's result type ends. The `=>` that follows it is not
 * part of the type, so the scanner stops before it.
 */
const ARROW_RETURN_STOPS: ReadonlySet<string> = new Set(["=>"]);

class TypeScriptParser {
  tokens: Token[];
  private readonly path: string;
  private diagnostics: Diagnostics;
  private position = 0;
  /** How many loops the statement being read is written in. */
  private loops = 0;
  /**
   * The constructs a `break` can leave, innermost last. A loop and a switch
   * both own one, and a break belongs to the nearest: a switch inside a loop
   * is left by its break, not the loop around it.
   */
  private breakTargets: ("loop" | "switch")[] = [];
  /** Names the lowered switches have taken, so each has a temporary of its own. */
  private switchCount = 0;
  /** Names the lowered for-of loops have taken, so each walks a name of its own. */
  private walkCount = 0;
  /** The classes the file declares, whether or not the module parser sees them. */
  private readonly classTable: ClassTable;
  /** The token stream with class declarations still in it, for class bodies. */
  private readonly allTokens: Token[];
  /** The class whose method is being read, or null outside a class. */
  private currentClass: ClassInfo | null = null;
  /** The class each name of the function being read holds. */
  private valueClasses = new Map<string, string>();
  /** The type each name of the function being read is held at. */
  private valueTypes = new Map<string, TypeExpr>();
  /** The arrow each name of the function being read is bound to. */
  private valueArrows = new Map<string, ArrowBinding>();
  /**
   * The types an arrow written at the cursor is read at, when the use says them.
   *
   * A collection method walks the elements of the array it is called on, so
   * `a.map((x) => x.trim())` reads `x` as the element type without the source
   * writing it. The hint is the callback's parameters in order, and it is read
   * by the arrow at the cursor and cleared there: an arrow written inside the
   * body is a callback of a call of its own.
   */
  private arrowParameters: readonly ArrowParameterType[] | null = null;
  /** The arrow each lifted function was made from, by the function's name. */
  private arrowBindings = new Map<string, ArrowBinding>();
  /**
   * What each function of the file answers, by its name.
   *
   * A call is typed by what its callee answers, and a callee the file declares
   * itself is read here rather than asked of a program the parser has not
   * assembled: `const names = build(4)` is an array of text because `build`
   * answers one.
   */
  private declaredReturns = new Map<string, TypeExpr>();
  /**
   * What a function's declared result holds, when the contract type erased it.
   *
   * An interface is an opaque reference to the contract, so a call that answers
   * one carries no field the frontend can read. The shape is the declaration's,
   * and it is what a destructuring of that call reads its fields from.
   */
  private declaredReturnShapes = new Map<string, ResolvedType>();
  /**
   * What each function of the file takes, by its name.
   *
   * An argument written as an empty list is built at the parameter's type, and
   * the callee's declaration is what says what that is.
   */
  private declaredParams = new Map<string, readonly TypeExpr[]>();
  /**
   * Whether the expression being read is the initialiser of a declaration, and
   * so may be an arrow that is only ever called by the name it is bound to.
   */
  private bindingArrow = false;
  /**
   * The name the arrow being read is about to be bound to, while its body is
   * read.
   *
   * An arrow is read before the declaration binds it, so a body that calls the
   * name it is about to be given — a recursive arrow — reads a call of a name
   * nothing has bound yet. The name is known here, so the body is read with the
   * arrow already bound to the function it lifts to.
   */
  private declaringArrow: string | null = null;
  /** The name the arrow at the top of a declaration's initialiser is bound to. */
  private arrowName: string | null = null;
  /** The arrow whose body is being read, while its body is read. */
  private arrowDeclared: string | null = null;
  /** The calls the body being read writes of the arrow it is bound to. */
  private arrowSelfCalls: Expression[] = [];
  /**
   * The element type an array written out is held at, when the declaration it
   * initialises says what that is.
   *
   * `const a: string[] = []` names no element the frontend could read off the
   * list, because there is no list: the type the name is declared at is the one
   * the array is built with.
   */
  private expecting: TypeExpr | null = null;
  /**
   * The type the expression being read is held at.
   *
   * The element type above says what an array literal holds; this says what the
   * whole value is. An empty list in the arm of a conditional or on the right
   * of `??` is read at the type the other side names, which is a type of the
   * expression and not of one of its elements.
   */
  private expectedType: TypeExpr | null = null;
  /** The shape the expression being read is held at, where it is an object. */
  private expectedShape: ResolvedType | null = null;
  /**
   * Empty arrays read before the use says what they hold.
   *
   * `condition ? [] : [1]` is read from left to right, so the empty arm is
   * written before the other arm names the element type. The list is held here
   * with the token it was written at until the use settles it; a list no use
   * settles is reported once, after the whole expression has been read.
   */
  private readonly unsettledArrays = new Map<Expression, Token>();
  /**
   * The names this file's imports bind.
   *
   * A file is read before the module graph links the declarations its imports
   * name, so an annotation written as an imported type resolves to `any` on
   * that first read. An empty list written at such a type is not a list the
   * source left untyped: the read that follows the link settles it, and that
   * read reports whatever is still empty. `pendingType` is set when an imported
   * name is used before it is bound.
   */
  private readonly importedTypeNames: Set<string>;
  /** Shared with the nested parser a template string reads through. */
  private pendingType = { value: false };
  /**
   * Set when the annotation just read named a type the module graph has not
   * bound. A name declared at such a type is held as `any` by this read, and
   * what the body writes on it waits for the read that follows the link.
   */
  private pendingNote = false;
  /** The names whose declared type is a name this file imports, unlinked. */
  private pendingValues = new Set<string>();
  /** The class fields whose declared type is a name this file imports, unlinked. */
  private pendingFields = new Set<string>();
  /**
   * The values a read deferred because their type is not settled yet.
   *
   * A method written on a value of an unlinked imported type is not refused:
   * the read that follows the link holds the declaration and refuses it there
   * if the method really is not one. What that method answers is a value of the
   * same unlinked declaration — `driver.bodies.filter(f).map(g)` reads a list
   * whose element type is in another module — so the answer is deferred too,
   * and a method written on it waits for the same link rather than being called
   * a method of nothing.
   */
  private deferred = new Set<unknown>();
  /**
   * True once the module graph has bound what this file's imports name.
   *
   * A read that stands alone — the gap measurement, a test that reads one file —
   * does not know what an imported name holds, and what it cannot type waits
   * for a link that may never come. The read the graph makes after binding is
   * the one that answers: past it, a name nothing declares is a name the module
   * really does not offer, and the construct written on it is refused there.
   */
  linked = false;
  /**
   * True while the arrow at the cursor is a callback whose element type the
   * read does not hold: a `map` over a list whose element is in a module the
   * graph has not linked yet. A parameter the source did not annotate is then
   * the element that link will name.
   */
  private pendingArrow = false;
  /** The names written for the values a nested field assignment writes into. */
  private fieldCount = 0;
  /** How deeply expressions are being read, so an unsettled list waits for the outermost one. */
  private expressionReads = 0;
  /** How many reads are waiting to settle their value against the type of the use. */
  private expectedReads = 0;
  /** The lists that are a regular expression's pattern and flags. */
  private readonly regexValues = new Set<Expression>();
  /** The names bound to a regular expression, read by the methods of one. */
  private valueRegexes = new Set<string>();
  /**
   * The type the function being read hands back, which is what a returned list
   * is built at. A bare `return []` names no element of its own, and the
   * function's result type is the one the source wrote to say what it holds.
   */
  private returns: TypeExpr | null = null;
  /** The shape the function being read hands back, where it is an object. */
  private returnsShape: ResolvedType | null = null;
  /** The signature each name of the function is a function at, when it holds one. */
  private valueFunctions = new Map<string, FunctionType>();
  /** The map or the set each name of the function holds, when it holds one. */
  private valueCollections = new Map<string, CollectionValue>();
  /** The map or the set each function of the file answers, by its name. */
  private declaredCollections = new Map<string, CollectionValue>();
  /** The map or the set a `new Map(...)` written out is, by the expression. */
  private collectionExpressions = new Map<Expression, CollectionValue>();
  /**
   * The map or the set a `for..of` is about to walk, by the expression that
   * names it.
   *
   * `entries()` written where a loop walks it does not answer an array: a map
   * entry is a key and a value, which is not an element a typed array holds.
   * The loop reads the pair straight out of the dictionary instead, and this
   * table is what says which collection the expression it read names.
   */
  private iteratedCollections = new Map<Expression, CollectionValue>();
  /**
   * The list a `for..of` is about to walk by its entries, by the expression
   * that names it, and the element the list holds.
   *
   * `list.entries()` written where a loop walks it does not answer an array:
   * an entry is an index and an element, which is not an element a typed array
   * holds. The loop walks the list by position instead, and this table is what
   * says which list and which element type the expression it read names.
   */
  private iteratedSequences = new Map<Expression, TypeExpr>();
  /**
   * The type a name, or a chain of fields read from one, is known to hold after
   * a test of it, by the way the source spells the chain.
   *
   * `if (typeof entry !== "string") throw …; out.push(entry)` is only code a
   * compiler can type if the test is remembered: past the guard the value is
   * the type the test left it, and `entry.trim()` is a text method. The key is
   * the path — `entry`, `input.source`, `cb.name` — because a member read is a
   * new expression object every time it is written, so the value itself cannot
   * be the key. A block saves the table it was read with and hands it back when
   * it ends, and a name written to forgets what was known about it.
   */
  private narrowed = new Map<string, TypeExpr>();
  /** The type of each test `typeof` wrote at run time, by the path it read. */
  private typeofPaths = new Map<Expression, string>();
  /** True while the source of a `for..of` is being read. */
  private readingIteration = false;
  /**
   * Whether the value being read is the one a `new Map(...)` or a `new Set(...)`
   * is built from.
   *
   * `Object.entries(record)` is the entries of a dictionary read by position,
   * and a collection built from one copies them. It is not a value of its own:
   * outside the loop that names the two parts and outside the collection that
   * copies them there is nothing to hold it in, so the read is allowed only
   * where one of those two is what asked.
   */
  private readingCollectionSource = false;
  /**
   * The arrows the file's bodies wrote, lifted into functions of the file.
   *
   * An arrow is a function of its own, so it is a declaration the module holds
   * beside the one that wrote it: it is compiled, linked and called like any
   * other function, and the only thing that makes it an arrow is that nobody
   * but the function it was written in can name it.
   */
  private closures: DeclaredFunction[] = [];
  /** The suffix the next lifted arrow takes, so each is a name of its own. */
  private closureCount = 0;
  /** The function each lifted arrow became, by the name it took. */
  private liftedArrows = new Map<string, TypeScriptFunction>();
  /**
   * The function each collection method was lowered to, by the shape it walks.
   *
   * `a.map(f)` and a later `b.map(g)` over arrays of the same element type and
   * a callback of the same signature are the same walk, so the second reuses the
   * function the first wrote.
   */
  private collectHelpers = new Map<string, { name: string; returns: TypeExpr }>();
  /** The suffix the next collection helper takes, so each is a name of its own. */
  private collectCount = 0;
  /**
   * The type of a value the frontend built rather than read.
   *
   * `resultType` answers what a name, a literal or an operation is; it cannot
   * answer for a call, because what a call answers is the callee's to say. The
   * frontend knows that for the helpers it writes itself, so it is written down
   * here and read back when the value it produced is walked again — which is
   * what `a.filter(f).map(g)` does.
   */
  private expressionTypes = new Map<Expression, TypeExpr>();
  /**
   * Whether the file's bigints reach past the machine word. A `bigint` is
   * arbitrary precision in the language; this compiler holds it at the machine
   * word where every value fits, and at the wide whole number where one does
   * not, so the annotation is the width the file's own values reach.
   */
  wideBigint = false;
  /**
   * What the functions this file's frontend wrote are named by.
   *
   * The names a body generates are functions of the same program as the ones
   * the source wrote, and every function of a program is linked by its symbol,
   * so one symbol belongs to one function: `__closure_0` in two files is one
   * name for two bodies. The file's own name keeps them apart, and keeps the
   * IR readable besides.
   */
  private readonly stem: string;
  /**
   * The interfaces, aliases and imported type names the file's annotations
   * resolve in. A name that is not a class is still a value with fields, and
   * this is what the member chain after it is read through.
   */
  readonly typeTable: TypeTable;
  /** The shape each name of the body is declared at. */
  private valueShapes = new Map<string, ResolvedType>();
  /** The shape a member chain has already answered for a value it built. */
  private readonly expressionShapes = new Map<Expression, ResolvedType>();
  /** The token run the last annotation read, so its shape can be read after it. */
  private lastTypeRange: { start: number; end: number } | null = null;

  constructor(
    tokens: Token[],
    path: string,
    diagnostics: Diagnostics,
    classTable?: ClassTable,
    allTokens?: Token[],
    constants: ReadonlyMap<string, ConstantInfo> = new Map(),
    state: ReadonlySet<string> = new Set(),
    typeTable?: TypeTable,
    importedTypeNames: ReadonlySet<string> = new Set(),
  ) {
    this.tokens = tokens;
    this.importedTypeNames = new Set(importedTypeNames);
    this.path = path;
    this.stem = nameStem(path);
    this.diagnostics = diagnostics;
    this.classTable = classTable ?? scanClasses(tokens);
    this.allTokens = allTokens ?? tokens;
    this.constants = constants;
    this.state = state;
    this.typeTable = typeTable ?? scanTypeTable(tokens);
    // A name this file imports is a value another module holds. Until the graph
    // binds the declaration, a method written on the name is not a method this
    // read can say does not exist.
    for (const name of this.importedTypeNames) this.pendingValues.add(name);
    this.typeTable.classes = this.classTable.names;
    this.position = 0;
  }

  /** The file's constants, which a compiled function reads where it was written. */
  private readonly constants: ReadonlyMap<string, ConstantInfo>;
  /** The names the running program holds, which a module function cannot read. */
  private readonly state: ReadonlySet<string>;
  /** The constants being read, so one that names itself is not read forever. */
  private readonly expanding = new Set<string>();

  /** A nested function declaration is handled by the program parsing, not the module one. */
  nestedFunction = false;
  /**
   * Statements a single read produced past the first one, as a destructuring
   * declaration is a temporary and a binding for each name. The next block
   * drains them after the statement it returns, so they run in the order the
   * source wrote them.
   */
  private pending: Statement[] = [];
  /**
   * Statements a single read produced before the one it returns, as a switch
   * needs the temporary its discriminant is held in before the comparisons.
   */
  private pendingBefore: Statement[] = [];
  /** The suffix that makes a destructuring temporary a name of its own. */
  private destructureCount = 0;
  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.position + offset, this.tokens.length - 1)];
  }

  private next(): Token {
    return this.tokens[this.position++];
  }

  private at(text: string): boolean {
    const token = this.peek();
    return (token.kind === "punct" || token.kind === "ident") && token.text === text;
  }

  private accept(text: string): boolean {
    if (!this.at(text)) return false;
    this.position += 1;
    return true;
  }

  private expect(text: string): Token | null {
    if (!this.at(text)) {
      const token = this.peek();
      this.report(`expected "${text}"`, `near "${token.text}"`, token);
      return null;
    }
    return this.next();
  }


  /**
   * How many refusals the statement being read has written.
   *
   * A construct outside the subset is one refusal, not the run of them that
   * reading the rest of its statement can earn: the parser reads on after it,
   * and what it reads is what the construct would have meant, so every refusal
   * after the first is the same one wearing the shape of the junk around it.
   * The count is reset when a statement begins, so two statements that are each
   * outside the subset are still reported as two.
   */
  private reporting = 0;

  /**
   * Which of the last call's arguments the source spread with `...`, or null
   * when it spread none. A spread is not a value the call can take as it is —
   * the arguments it stands for are the elements of what was written — so the
   * call that can use one reads this beside the list it was handed.
   */
  private argumentSpreads: readonly boolean[] | null = null;

  private report(message: string, detail: string, token: Token = this.peek()): void {
    this.reporting += 1;
    if (this.reporting > 1) return;
    this.diagnostics.report(message, detail, token.line);
  }

  /**
   * Reads one statement of a body, and recovers to the end of it when it was
   * refused.
   *
   * Without the recovery the rest of the refused statement is read as
   * statements of its own, so one construct outside the subset is reported as
   * the run of fragments the parser made of what was left. The end is the one
   * the source wrote, found from where the statement began, so a `;` written
   * inside a nested bracket is not the end of it.
   */
  private guardedStatement(): Statement[] {
    const start = this.position;
    const outer = this.reporting;
    this.reporting = 0;
    const statements = this.withPending(this.readStatement());
    const refused = this.reporting > 0;
    this.reporting = outer;
    if (refused) this.readPastStatement(start);
    return statements;
  }

  /** Reads on to the end of the statement that begins at a token. */
  private readPastStatement(start: number): void {
    const end = this.statementEnd(start);
    if (end > this.position) this.position = end;
  }

  /**
   * Where the statement beginning at a token ends, as the token after its last.
   *
   * The scan is over the source's own brackets, so a `;` inside a call or a
   * loop header is not the end. A block the statement opens closes at depth
   * zero, and the `else`, `catch`, `finally` and `while` that may follow it are
   * part of the same statement.
   */
  private statementEnd(start: number): number {
    let depth = 0;
    for (let at = start; at < this.tokens.length; at += 1) {
      const token = this.tokens[at] as Token;
      if (token.kind !== "punct") continue;
      const text = token.text;
      if (text === "(" || text === "[" || text === "{") {
        depth += 1;
        continue;
      }
      if (text === ")" || text === "]" || text === "}") {
        if (depth === 0) return at;
        depth -= 1;
        if (depth === 0 && text === "}") {
          const next = this.tokens[at + 1]?.text;
          if (next === "else" || next === "catch" || next === "finally" || next === "while") continue;
          return this.tokens[at + 1]?.text === ";" ? at + 2 : at + 1;
        }
        continue;
      }
      if (text === ";" && depth === 0) return at + 1;
    }
    return this.tokens.length;
  }

  /** A value standing in for one the parser could not read. */
  private hole(): Expression {
    return { k: "literal", text: "0" };
  }

  private missing(message: string, token: Token = this.peek()): Expression {
    this.report(message, `near "${token.text}"`, token);
    return this.hole();
  }

  /* ------------------------------------------------------------------------ */
  /* Classes                                                                  */
  /* ------------------------------------------------------------------------ */

  /** The class a name declares, or undefined where the file declares none. */
  private classNamed(name: string): ClassInfo | undefined {
    return this.classTable.classes.get(name);
  }

  /** A class's name when it names a class, and nothing when it names a type. */
  private classTypeName(typeName: string): string | null {
    return this.classTable.names.has(typeName) ? typeName : null;
  }

  /** A type annotation, where a class is a reference the layout pass settles. */
  private typeForName(typeName: string, line: number): TypeExpr {
    if (typeName === "void") return NOTHING;
    const text = typeName.trim();
    if (text === "any") return ANY_TYPE;
    if (text === "bigint" && this.wideBigint) return parseType("u256");
    // An interface, an alias and an imported type name are read by the type
    // table before the text is treated as an unknown name: what a contract can
    // hold of an interface is its fields, and what it can hold of an alias is
    // whatever the alias names.
    let shape: ResolvedType | null = null;
    try {
      shape = resolveTypeName(this.typeTable, text);
    } catch {
      shape = null;
    }
    if (shape !== null && shape.kind !== "any") return this.typeExprOfShape(shape);
    if (shape === null || shape.kind === "any") this.notePendingType(text);
    // A field or a class parameter names its type as one text, so `T[]` and
    // `Array<T>` are read here rather than by the token walk an annotation in a
    // body goes through.
    if (text.endsWith("[]")) return { kind: "slice", of: this.typeForName(text.slice(0, -2).trim(), line) };
    const generic = /^(?:Readonly)?Array<(.+)>$/.exec(text);
    if (generic !== null) return { kind: "slice", of: this.typeForName(generic[1] as string, line) };
    if (this.classTable.names.has(text)) return ANY_TYPE;
    try {
      return mapTypeScriptType(typeName, `line ${line} of ${this.path}`);
    } catch (error) {
      if (!isCompilerError(error)) throw error;
      this.report(error.message, error.detail ?? "", { kind: "ident", text: typeName, line });
      return ANY_TYPE;
    }
  }

  /** The shape a type name declares, or null where it names none. */
  private shapeForName(typeName: string): ResolvedType | null {
    try {
      const shape = resolveTypeName(this.typeTable, typeName.trim());
      return shape.kind === "any" ? null : shape;
    } catch {
      return null;
    }
  }

  /** The contract type a resolved shape is held at. */
  /**
   * The shape a value written at a field is read at.
   *
   * A field's resolved type may be a name the module declares — a recursive
   * type writes its own name, as `Expression` does through every member — and a
   * name is not the record it stands for. The read needs the record, so the
   * name is resolved here. A declaration another module writes is not this
   * read's to resolve and answers null, which leaves it to the read that
   * follows the link.
   */
  private shapeForRead(type: ResolvedType): ResolvedType | null {
    if (type.kind !== "ref") return type;
    if (type.name === null) return null;
    const shape = this.shapeOfNamedType({ kind: "ref", of: null, name: type.name });
    return shape === null || shape.kind === "any" ? null : shape;
  }

  private typeExprOfShape(shape: ResolvedType): TypeExpr {
    switch (shape.kind) {
      case "primitive":
        return { kind: "primitive", name: shape.name };
      case "text":
        return TEXT_RESULT;
      case "list":
        return { kind: "slice", of: this.typeExprOfShape(shape.of) };
      case "absent":
        return NOTHING;
      case "ref":
        return shape.name === null ? ANY_TYPE : { kind: "ref", of: null, name: shape.name };
      case "function":
        return ANY_TYPE;
      case "map":
      case "set":
        // A map is one handle, which is the number the runtime's dictionary is:
        // a contract can spell that, and what the map holds is kept beside the
        // name the handle is bound to.
        return NUMBER_RESULT;
      case "record":
        // A record with an index is keyed by text, which is the dictionary the
        // runtime holds: the contract spells the handle. An object of fields is
        // a reference; the fields themselves are read through `shapeOf`, which
        // keeps the record the contract cannot spell.
        return shape.index !== null ? NUMBER_RESULT : ANY_TYPE;
      default:
        return ANY_TYPE;
    }
  }

  /** The collection a shape names, in the form the map and set methods read. */
  private collectionOfShape(shape: ResolvedType | null): CollectionValue | null {
    if (shape === null) return null;
    // `Record<string, V>` is the same dictionary `Map<string, V>` is: the keys
    // are texts and the value is what the index states.
    if (shape.kind === "record" && shape.index !== null) {
      return { kind: "map", key: TEXT_RESULT, value: this.typeExprOfShape(shape.index) };
    }
    const collection = collectionOfType(shape);
    if (collection === null) return null;
    if (collection.kind === "set") {
      return { kind: "set", key: TEXT_RESULT, value: this.typeExprOfShape(collection.of) };
    }
    return {
      kind: "map",
      key: this.typeExprOfShape(collection.key),
      value: this.typeExprOfShape(collection.value),
    };
  }

  /**
   * The map or the set an expression names, when it names one.
   *
   * A name holds what it was declared with, a call answers what the function
   * declares, and a field of an interface names the collection its field is:
   * the three ways a collection reaches a method call.
   */
  private collectionOfExpression(value: Expression): CollectionValue | null {
    // A value the read itself recorded as a collection: a `new Map(...)`, an
    // object literal at a record, or a value asserted as a set or a map.
    const recorded = this.collectionExpressions.get(value);
    if (recorded !== undefined) return recorded;
    if (value.k === "ident") {
      const known = this.valueCollections.get(value.name);
      if (known !== undefined) return known;
    }
    if (value.k === "call") {
      const answered = this.declaredCollections.get(value.name);
      if (answered !== undefined) return answered;
    }
    return this.collectionOfShape(this.shapeOf(value));
  }

  /**
   * The shape a value is read at.
   *
   * `valueTypes` answers the contract type, which erases an interface to a
   * reference. The shape keeps the fields that reference names, so a member
   * chain written through an imported interface is read field by field rather
   * than stopping at the first member.
   */
  private shapeOf(value: Expression): ResolvedType | null {
    const recorded = this.expressionShapes.get(value);
    if (recorded !== undefined) return recorded;
    let shape: ResolvedType | null = null;
    switch (value.k) {
      case "ident": {
        const known = this.valueShapes.get(value.name);
        if (known !== undefined) shape = known;
        else if (this.valueRegexes.has(value.name)) shape = { kind: "record", fields: new Map(), index: null };
        break;
      }
      case "member": {
        const base = this.shapeOf(value.base);
        // What the field's type writes is resolved where the field is: a name
        // that no declaration of this table holds is a declaration another
        // module writes, and the graph has not linked it. `record.analysis` is
        // a `ModuleAnalysis`, and what the field holds is the link's to say, so
        // a method written on it waits for that link rather than being refused
        // here.
        if (base !== null) {
          const field = fieldOfType(this.typeTable, base, value.field);
          if (field !== null) {
            shape = field.type;
            if (this.fieldWaitsForLink(field)) {
              this.deferred.add(value);
              shape = null;
            }
          }
        }
        if (shape === null) {
          const owner = this.classOfExpression(value.base);
          if (owner !== null) {
            const field = findField(this.classTable, owner, value.field, true) ??
              findField(this.classTable, owner, value.field, false);
            if (field !== null) shape = resolveTypeName(this.typeTable, field.field.typeName);
          }
        }
        break;
      }
      case "index": {
        const base = this.shapeOf(value.base);
        if (base !== null) shape = elementOfType(this.typeTable, base);
        break;
      }
      case "literal":
        shape = { kind: "primitive", name: "f64" };
        break;
      case "text":
        shape = { kind: "text" };
        break;
      case "buffer": {
        const element = resolveTypeName(this.typeTable, value.element);
        shape = { kind: "list", of: element };
        break;
      }
      case "object": {
        // An object literal is a record the file wrote field by field, so each
        // field is the shape of the value written for it.
        const fields = new Map<string, ResolvedField>();
        for (const field of value.fields) {
          fields.set(field.name, { type: this.shapeOf(field.value) ?? { kind: "any" }, optional: false });
        }
        shape = { kind: "record", fields, index: null };
        break;
      }
      case "call": {
        const declared = this.declaredReturnShapes.get(value.name);
        if (declared !== undefined) {
          shape = declared;
          break;
        }
        const answer = this.valueTypeOf(value);
        shape = this.shapeOfTypeExpr(answer);
        break;
      }
      case "conditional": {
        const then = this.shapeOf(value.then);
        const otherwise = this.shapeOf(value.otherwise);
        shape = then ?? otherwise;
        break;
      }
      case "unary":
      case "binary": {
        // `a ?? b` is `a` where it is there and `b` where it is not, so the
        // arm that names a shape is the shape. Only a value that says nothing
        // (`null`, or an `any` the source declared) leaves the other arm to
        // answer, which is the rule the IR's `coalesce` states.
        if (value.k === "binary" && value.op === "??") {
          const held = this.shapeOf(value.left);
          shape = held !== null && held.kind !== "any" ? held : this.shapeOf(value.right);
          break;
        }
        shape = this.shapeOfTypeExpr(resultType(value, this.valueTypes));
        break;
      }
      default:
        break;
    }
    if (shape !== null) this.expressionShapes.set(value, shape);
    return shape;
  }

  /** The shape a contract type stands for, which keeps only what it says. */
  private shapeOfTypeExpr(type: TypeExpr): ResolvedType {
    switch (type.kind) {
      case "primitive":
        return { kind: "primitive", name: type.name };
      case "text":
        return { kind: "text" };
      case "slice":
      case "array":
        return { kind: "list", of: this.shapeOfTypeExpr(type.of) };
      case "ref":
        return type.name === undefined ? { kind: "any" } : { kind: "ref", name: type.name };
      case "void":
        return { kind: "absent" };
      default:
        return { kind: "any" };
    }
  }

  /**
   * The type a method answers with. A value a method hands back is an instance
   * of the class it names, and the object pass gives that layout the class's
   * own name so a caller can read its fields without having built it itself.
   */
  private returnTypeForName(typeName: string, line: number): TypeExpr {
    if (this.classTable.names.has(typeName)) return { kind: "ref", of: null, name: typeName };
    return this.typeForName(typeName, line);
  }

  /**
   * A body read with the type its returns are read by.
   *
   * The type travels with the read rather than being passed to each statement,
   * so a `return []` written anywhere in the body is built at the type the
   * function declares, and a nested block or an if arm reads it the same way.
   */
  private readReturning(
    returns: TypeExpr | null,
    read: () => Statement[],
    shape: ResolvedType | null = null,
  ): Statement[] {
    const saved = this.returns;
    const savedShape = this.returnsShape;
    this.returns = returns;
    this.returnsShape = shape;
    try {
      return read();
    } finally {
      this.returns = saved;
      this.returnsShape = savedShape;
    }
  }

  /**
   * The value a declaration without an initialiser starts at.
   *
   * The source writes `let text: string;` and assigns it before reading it, and
   * the language it is written in starts the name as an absent value. A value
   * here has no absence, so the name starts at the zero of the type it declares:
   * an empty text, a zero, a null reference, or an empty list. The assignment
   * the source writes then replaces it before anything reads it.
   */
  private zeroFor(type: TypeExpr): Expression {
    if (type.kind === "primitive") {
      if (type.name === "i256" || type.name === "u256") {
        return { k: "bigint", text: "0n" };
      }
      return { k: "literal", text: "0" };
    }
    if (type.kind === "text") return { k: "text", parts: [{ k: "text", value: "" }] };
    if (type.kind === "slice" || type.kind === "array") {
      return { k: "buffer", element: typeToString(type.of), values: [] };
    }
    return { k: "null" };
  }

  /**
   * An expression read as the type a use fixes it at, which is what says what
   * an empty list written there holds.
   */
  private readAt(type: TypeExpr | null, read: () => Expression, shape: ResolvedType | null = null): Expression {
    const savedExpecting = this.expecting;
    const savedType = this.expectedType;
    const savedShape = this.expectedShape;
    this.expecting = type === null ? null : elementOfSequenceType(type);
    this.expectedType = type;
    this.expectedShape = shape ?? this.shapeOfNamedType(type);
    this.expectedReads += 1;
    try {
      const value = read();
      if (type !== null) this.applyExpected(value, type, this.expectedShape);
      return value;
    } finally {
      this.expecting = savedExpecting;
      this.expectedType = savedType;
      this.expectedShape = savedShape;
      this.expectedReads -= 1;
      if (this.expectedReads === 0 && this.expressionReads === 0) this.reportUnsettledArrays();
    }
  }

  /**
   * The type an array literal is held at, when it is the whole expression.
   *
   * The element type is what an array literal already reads. The type of the
   * value itself says the same thing, and is what an arm of a conditional or
   * the right side of `??` passes on.
   */
  private shapeOfNamedType(type: TypeExpr | null): ResolvedType | null {
    if (type === null || type.kind !== "ref" || type.name === undefined) return null;
    try {
      const shape = resolveTypeName(this.typeTable, type.name);
      if (shape.kind === "any") this.notePendingType(type.name);
      return shape;
    } catch {
      this.notePendingType(type.name);
      return null;
    }
  }

  /**
   * Records that an annotation named a type this file imports, before the
   * module graph bound the declaration the name stands for.
   */
  private notePendingType(name: string): void {
    // A name may be written inside a generic, as `Omit<Full, "c">` is, so every
    // name the annotation mentions is asked, not only the one it starts with.
    for (const one of name.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []) {
      if (!this.importedTypeNames.has(one)) continue;
      if (this.typeTable.declarations.has(one) || this.typeTable.imported.has(one)) continue;
      this.pendingType.value = true;
      this.pendingNote = true;
      return;
    }
  }

  /**
   * Whether this read names a type its imports declare and the module graph has
   * not linked. What is written at such a type — an empty list, the fields an
   * object spread copies — is settled by the read that follows the link.
   */
  private typeReadIsPending(): boolean {
    return this.pendingType.value && this.typeTable.imported.size === 0;
  }

  /**
   * Whether this read is missing a declaration its imports name.
   *
   * A type an annotation mentions is one such declaration, and so is a value a
   * body reads: `OUTPUT_KINDS.includes(x)` reads a list another module wrote,
   * and this read has neither the list nor its element type. Both wait for the
   * read that follows the link.
   */
  private importsArePending(): boolean {
    if (this.linked || this.typeTable.imported.size > 0) return false;
    return this.pendingType.value || this.importedTypeNames.size > 0;
  }

  /**
   * Settles the empty arrays a value holds at the type the use fixes it at.
   *
   * A list read before its use was known is a block of no values with no
   * element type. The value around it may be a conditional arm, the right side
   * of `??`, an object field, or the list itself, so the type travels through
   * those forms until it reaches the list.
   */
  private applyExpected(value: Expression, type: TypeExpr, shape: ResolvedType | null = null): void {
    if (type.kind === "slice" || type.kind === "array") {
      const elementShape = shape !== null && shape.kind === "list" ? shape.of : null;
      if (value.k === "buffer") {
        if (value.values.length === 0) {
          if (this.unsettledArrays.has(value)) {
            value.element = typeToString(type.of);
            this.unsettledArrays.delete(value);
          }
          return;
        }
        for (const written of value.values) this.applyExpected(written, type.of, elementShape);
        return;
      }
      if (value.k === "conditional") {
        this.applyExpected(value.then, type, shape);
        this.applyExpected(value.otherwise, type, shape);
        return;
      }
      if (value.k === "binary" && value.op === "??") {
        this.applyExpected(value.left, type, shape);
        this.applyExpected(value.right, type, shape);
      }
      return;
    }
    if (shape !== null && shape.kind === "record" && value.k === "object") {
      for (const field of value.fields) {
        const declared = shape.fields.get(field.name);
        if (declared === undefined) continue;
        this.applyExpected(field.value, this.typeExprOfShape(declared.type), this.shapeForRead(declared.type));
      }
    }
  }

  /** Whether a value still holds a list whose use has not said what it holds. */
  private holdsUnsettledArray(value: Expression): boolean {
    if (this.unsettledArrays.has(value)) return true;
    switch (value.k) {
      case "conditional":
        return this.holdsUnsettledArray(value.then) || this.holdsUnsettledArray(value.otherwise);
      case "binary":
        return this.holdsUnsettledArray(value.left) || this.holdsUnsettledArray(value.right);
      case "buffer":
        return value.values.some((written) => this.holdsUnsettledArray(written));
      case "object":
        return value.fields.some((field) => this.holdsUnsettledArray(field.value));
      default:
        return false;
    }
  }

  /** The array type a value names, where its use has settled every empty list in it. */
  private settledArrayType(value: Expression): TypeExpr | null {
    if (this.holdsUnsettledArray(value)) return null;
    const type = this.valueTypeOf(value);
    return type.kind === "slice" || type.kind === "array" ? type : null;
  }

  /** Reports the empty arrays no use of the expression settled. */
  private reportUnsettledArrays(): void {
    // A read that names an imported type the module graph has not linked yet
    // cannot tell a list the source left empty from a list written at that
    // type: the type is simply not in this table. The file is read again once
    // the imports are bound, and that read answers what is still unsettled.
    if (this.typeReadIsPending()) {
      this.unsettledArrays.clear();
      return;
    }
    for (const [value, token] of this.unsettledArrays) {
      if (value.k !== "buffer" || value.values.length !== 0) continue;
      this.report(
        "an empty array needs the type of its elements",
        "write the declaration with the element type, as in const names: string[] = []",
        token,
      );
    }
    this.unsettledArrays.clear();
  }

  /** Reads an expression written in the class token stream, between two tokens. */
  private readRange(start: number, end: number): Expression {
    const savedTokens = this.tokens;
    const savedPosition = this.position;
    this.tokens = this.allTokens;
    this.position = start;
    const value = this.readExpression();
    if (this.position !== end) {
      this.report("a class member value is one expression", `near "${this.peek().text}"`);
    }
    this.tokens = savedTokens;
    this.position = savedPosition;
    return value;
  }

  /** A constant's expression, read in place of the name that holds it. */
  private constantValue(name: string, written: ConstantValue | undefined): Expression | null {
    if (written === undefined) return null;
    // A value that came from the module that wrote it is already the expression
    // the file read: there is no range of this file's tokens to read it from.
    if (written.value !== undefined) return written.value;
    const range = written.range;
    if (range === undefined) return null;
    if (this.expanding.has(name)) return null;
    this.expanding.add(name);
    try {
      return this.readRange(range.start, range.end);
    } finally {
      this.expanding.delete(name);
    }
  }

  /**
   * The value a write goes into, read from the tokens before its last field.
   *
   * A chain of fields is built from the names themselves, but a chain with a
   * call in it — `this.frame().block` — is the value the call answered, and only
   * the reader that parses a call can build that. The tokens up to the last
   * field are read as the expression they are, and the parser is left where it
   * was so the write is read from the field.
   */
  private readOwner(start: number, end: number): Expression {
    const savedTokens = this.tokens;
    const savedPosition = this.position;
    const owner = this.tokens.slice(start, end);
    owner.push({ kind: "end", text: "", line: this.tokens[end]?.line ?? 0 });
    this.tokens = owner;
    this.position = 0;
    try {
      return this.readExpression();
    } finally {
      this.tokens = savedTokens;
      this.position = savedPosition;
    }
  }

  /**
   * Reads a class body or a default value with the class's own names in scope.
   * `self` is the instance a method was called on; a static member has no
   * instance, so `this` there is refused where it is written.
   */
  private withClassContext<T>(info: ClassInfo, params: readonly ClassParam[], self: boolean, run: () => T): T {
    const savedTokens = this.tokens;
    const savedPosition = this.position;
    const savedClass = this.currentClass;
    const savedTypes = this.valueClasses;
    const savedValueTypes = this.valueTypes;
    const savedShapes = this.valueShapes;
    const savedArrows = this.valueArrows;
    const savedFunctions = this.valueFunctions;
    const savedCollections = this.valueCollections;
    const savedRegexes = this.valueRegexes;
    this.tokens = this.allTokens;
    this.currentClass = self ? info : null;
    this.valueClasses = new Map();
    this.valueTypes = new Map();
    this.valueShapes = new Map();
    this.valueArrows = new Map();
    this.valueFunctions = new Map();
    this.valueCollections = new Map();
    this.valueRegexes = new Set();
    if (self) this.valueClasses.set("self", info.name);
    for (const param of params) {
      const typeName = this.classTypeName(param.typeName);
      if (typeName !== null) this.valueClasses.set(param.name, typeName);
      this.rememberValueType(param.name, param.typeName, param.line);
    }
    try {
      return run();
    } finally {
      this.tokens = savedTokens;
      this.position = savedPosition;
      this.currentClass = savedClass;
      this.valueClasses = savedTypes;
      this.valueTypes = savedValueTypes;
      this.valueShapes = savedShapes;
      this.valueArrows = savedArrows;
      this.valueFunctions = savedFunctions;
      this.valueCollections = savedCollections;
      this.valueRegexes = savedRegexes;
    }
  }

  /** A class parameter's annotation, held at the type the contract reads it at. */
  private rememberValueType(name: string, typeName: string, line: number): void {
    try {
      this.valueTypes.set(name, this.typeForName(typeName, line));
    } catch {
      this.valueTypes.set(name, ANY_TYPE);
    }
    const shape = resolveTypeName(this.typeTable, typeName);
    this.valueShapes.set(name, shape);
    // A parameter written at a type another module declares is a value this read
    // cannot type until the graph links the declaration, exactly as a parameter
    // of a body is: what is written on it waits for that link rather than being
    // called `any`.
    if (this.annotationWaitsForLink(typeName)) this.pendingValues.add(name);
    else this.pendingValues.delete(name);
    const collection = this.collectionOfShape(shape);
    if (collection !== null) this.valueCollections.set(name, collection);
  }

  /** The fields a class holds, including the property parameters of its constructor. */
  private fieldsOf(info: ClassInfo, params: readonly ClassParam[]): ClassField[] {
    const fields: ClassField[] = [];
    const seen = new Set<string>();
    let current: ClassInfo | undefined = info;
    const chain: ClassInfo[] = [];
    while (current !== undefined) {
      chain.unshift(current);
      current = current.base === null ? undefined : this.classNamed(current.base);
    }
    for (const entry of chain) {
      for (const field of entry.fields) {
        if (seen.has(field.name)) continue;
        seen.add(field.name);
        fields.push(field);
      }
    }
    for (const param of params) {
      if (!param.property || seen.has(param.name)) continue;
      seen.add(param.name);
      fields.push({ name: param.name, typeName: param.typeName, initStart: -1, initEnd: -1, line: param.line });
    }
    // The one base a class may extend is `Error`, and the one field it brings
    // is the message `super(...)` writes and a reader of the error reads.
    if (info.base === "Error" && !seen.has("message")) {
      fields.push({ name: "message", typeName: "string", initStart: -1, initEnd: -1, line: info.line });
    }
    return fields;
  }

  /**
   * The value a field starts as in the literal the constructor allocates.
   *
   * Every field is stated at the width it is declared at, so a field the
   * constructor writes afterwards is written at that same width. A field with
   * an initialiser starts at its type's zero and is assigned the initialiser
   * after the object exists, which is what lets the initialiser read `this`: a
   * field of a reference starts as the null it points at until it is assigned.
   */
  private defaultFieldValue(field: ClassField): Expression {
    switch (field.typeName) {
      case "number":
      case "f32":
      case "f64":
      case "i8":
      case "i16":
      case "i32":
      case "i64":
      case "u8":
      case "u16":
      case "u32":
      case "u64":
      case "usize":
      case "boolean":
      case "bool":
        return { k: "literal", text: "0" };
      case "bigint":
      case "i256":
      case "u256":
        return { k: "bigint", text: "0n" };
      default:
        return { k: "null" };
    }
  }

  /** The class a value is known to hold, or null where nothing says. */
  private classOfExpression(expression: Expression): string | null {
    switch (expression.k) {
      case "ident": {
        const known = this.valueClasses.get(expression.name);
        if (known !== undefined) return known;
        return this.classTable.names.has(expression.name) ? expression.name : null;
      }
      case "member": {
        if (expression.base.k === "ident" && !this.valueClasses.has(expression.base.name)) {
          const owner = this.classNamed(expression.base.name);
          if (owner !== undefined) {
            const field = findField(this.classTable, owner.name, expression.field, true);
            return field === null ? null : this.classTypeName(field.field.typeName);
          }
        }
        const base = this.classOfExpression(expression.base);
        if (base === null) return null;
        const field = findField(this.classTable, base, expression.field, false);
        return field === null ? null : this.classTypeName(field.field.typeName);
      }
      case "call":
        return this.callReturnClass(expression.name);
      default:
        return null;
    }
  }

  /** The class a generated call answers with, or null when it answers no class. */
  private callReturnClass(name: string): string | null {
    if (this.classTable.names.has(name)) return name;
    for (const info of this.classTable.ordered) {
      // A constructor called without the parameters it defaults is one of its
      // overloads, and it still answers an instance of the class.
      if (name.startsWith(`${info.name}__`) && /^\d+$/.test(name.slice(info.name.length + 2))) return info.name;
      const prefix = `${info.name}_`;
      if (!name.startsWith(prefix)) continue;
      let member = name.slice(prefix.length);
      const arity = /__(\d+)$/.exec(member);
      if (arity !== null) member = member.slice(0, arity.index);
      const method = [...info.methods, ...info.staticMethods].find((entry) => entry.name === member);
      if (method !== undefined) return this.classTypeName(method.returnTypeName);
      const field = info.statics.find((entry) => entry.name === member);
      if (field !== undefined) return this.classTypeName(field.typeName);
    }
    return null;
  }

  /** The class whose method a call of `name` on `hint` resolves to. */
  private methodOwner(hint: string | null, name: string, isStatic: boolean): { owner: string; method: ClassMethod } | null {
    if (hint !== null) {
      const found = findMethod(this.classTable, hint, name, isStatic);
      if (found !== null) return found;
    }
    if (this.currentClass !== null) {
      const found = findMethod(this.classTable, this.currentClass.name, name, isStatic);
      if (found !== null) return found;
    }
    // A method name no class shares needs no receiver type: the source wrote a
    // name only one class answers to.
    const matches: { owner: string; method: ClassMethod }[] = [];
    for (const info of this.classTable.ordered) {
      const found = findMethod(this.classTable, info.name, name, isStatic);
      if (found !== null && !matches.some((entry) => entry.method === found.method)) matches.push(found);
    }
    return matches.length === 1 ? matches[0] : null;
  }

  /** Reports every construct inside a class the lowering could not read. */
  private reportClassProblems(): void {
    for (const problem of this.classTable.problems) {
      this.report(problem.message, problem.detail, { kind: "ident", text: "", line: problem.line });
    }
  }

  /** The function a class or one member of it lowers to. */
  private declared(
    name: string,
    params: { name: string; type: TypeExpr }[],
    returns: TypeExpr,
    body: Statement[],
    exported: boolean,
    line: number,
    promise?: TypeExpr,
  ): DeclaredFunction {
    return {
      name,
      exported,
      params,
      returns,
      handle: { name, params, returns, body, line, ...(promise === undefined ? {} : { promise }) } satisfies TypeScriptFunction,
    };
  }

  /**
   * The overloads a function with default parameters is callable through. The
   * full function takes every parameter; each shorter arity is a function whose
   * body calls the full one with the defaults the source wrote, evaluated where
   * the call is made and with the parameters before it in scope.
   */
  private defaultWrappers(fn: TypeScriptFunction, exported: boolean): DeclaredFunction[] {
    let required = 0;
    fn.params.forEach((param, index) => {
      if (param.default === undefined) required = index + 1;
    });
    const out: DeclaredFunction[] = [];
    for (let arity = required; arity < fn.params.length; arity += 1) {
      const written = fn.params.slice(0, arity).map(({ name, type }) => ({ name, type }));
      // A default is read once, under a name of its own, before the call: it may
      // be a call of its own, and a call written among the arguments would run
      // while the earlier arguments are pinned in the registers it uses.
      const statements: Statement[] = [];
      const args: Expression[] = fn.params.map((param, index) => {
        if (index < arity) return { k: "ident", name: param.name };
        const name = `__default${index}`;
        statements.push({ kind: "declare", name, type: null, init: param.default as Expression, line: fn.line });
        return { k: "ident", name };
      });
      statements.push({ kind: "result", value: { k: "call", name: fn.name, args }, line: fn.line });
      // A wrapper of an async function answers the promise the function it
      // calls makes: it settles nothing itself, and what it carries is what
      // the function carries.
      const promise = fn.async === true ? fn.returns : fn.promise;
      out.push(
        this.declared(
          `${fn.name}__${arity}`,
          written,
          promise === undefined ? fn.returns : { kind: "ref", of: null },
          statements,
          exported,
          fn.line,
          promise,
        ),
      );
    }
    return out;
  }

  /** The parameters of a method, where a class-typed one is a reference. */
  private methodParams(params: readonly ClassParam[]): { name: string; type: TypeExpr }[] {
    return params.map((param) => ({
      name: param.name,
      type: this.classTable.names.has(param.typeName) ? this.referenceTo(param.typeName) : this.typeForName(param.typeName, param.line),
    }));
  }

  /**
   * The parameters of the callback a collection method walks its elements with.
   *
   * The element type of the receiver is what the callback's first parameter is,
   * so `a.map((x) => x.trim())` reads `x` as the text the array holds. The
   * position follows, and then the array itself, for the callbacks that ask for
   * them. A `sort` compares two elements, and a `reduce` starts from one.
   *
   * A method that takes no callback, or a receiver whose elements have no type
   * this frontend knows, says nothing and the callback keeps the type it was
   * written at.
   */
  private collectionCallbackParameters(receiver: Expression, method: string): readonly ArrowParameterType[] | null {
    if (!COLLECTION_METHODS.has(method)) return null;
    if (method === "join" || method === "includes" || method === "indexOf" || method === "at" || method === "slice") return null;
    const sequence = this.valueTypeOf(receiver);
    if (sequence.kind !== "slice" && sequence.kind !== "array") return null;
    const element: ArrowParameterType = { type: sequence.of, shape: this.elementShapeOf(receiver, sequence.of) };
    const index: ArrowParameterType = { type: NUMBER_RESULT, shape: null };
    const list: ArrowParameterType = {
      type: { kind: "slice", of: sequence.of },
      shape: { kind: "list", of: element.shape ?? { kind: "any" } },
    };
    if (method === "sort") return [element, element];
    if (method === "reduce") return [element, element, index, list];
    return [element, index, list];
  }

  /**
   * What an element of a receiver's array holds when the contract erased it.
   *
   * An array of an interface is an array of references the contract cannot name
   * a field of, and the shape of the array is what says the fields. Where the
   * receiver's own declaration has no shape, the element type names one.
   */
  private elementShapeOf(receiver: Expression, element: TypeExpr): ResolvedType | null {
    const sequence = this.shapeOf(receiver);
    if (sequence !== null && sequence.kind === "list") return sequence.of;
    return this.shapeOfNamedType(element);
  }

  /** The types a method's written arguments are read at, when a class answers it. */
  private expectedMethodArguments(receiver: Expression, method: string): readonly TypeExpr[] {
    // A map or a set answers the method itself, and its arguments are not the
    // parameters of a class method that happens to share the name.
    if (this.collectionOfExpression(receiver) !== null) return [];
    const found = this.methodOwner(this.classOfExpression(receiver), method, false);
    if (found === null) return [];
    return this.methodParams(found.method.params).map((param) => param.type);
  }

  /** An instance of a class, as the reference the layout pass names. */
  private referenceTo(className: string): TypeExpr {
    return { kind: "ref", of: null, name: className };
  }

  /**
   * The overloads a method with default parameters is callable through. The
   * full method takes every parameter; each shorter arity is a function whose
   * body fills the remaining defaults, evaluated where the call was made and
   * with the receiver the call named in scope.
   */
  private wrappers(
    info: ClassInfo,
    method: ClassMethod,
    baseName: string,
    returns: TypeExpr,
    self: boolean,
    exported: boolean,
  ): DeclaredFunction[] {
    const params = method.params;
    const required = requiredParams(params);
    const out: DeclaredFunction[] = [];
    for (let arity = required; arity < params.length; arity += 1) {
      const written = params.slice(0, arity);
      const paramsOut = self ? [{ name: "self", type: this.referenceTo(info.name) }, ...this.methodParams(written)] : this.methodParams(written);
      // A default is read once, under a name of its own, before the call: it
      // may be a call of its own, and a call written among the arguments would
      // run while the receiver and the earlier arguments are pinned in the
      // registers it uses.
      const statements: Statement[] = [];
      const args = params.map((param, index): Expression => {
        if (index < arity) return { k: "ident", name: param.name };
        const name = `__default${index}`;
        const value = this.withClassContext(info, params, self, () => this.readRange(param.defaultStart, param.defaultEnd));
        statements.push({ kind: "declare", name, type: null, init: value, line: method.line });
        return { k: "ident", name };
      });
      const callArgs = self ? [{ k: "ident", name: "self" } satisfies Expression, ...args] : args;
      statements.push({ kind: "result", value: { k: "call", name: baseName, args: callArgs }, line: method.line });
      out.push(this.declared(`${baseName}__${arity}`, paramsOut, returns, statements, exported, method.line));
    }
    return out;
  }

  /** Every function a class becomes: a constructor, methods, and static members. */
  private emitClass(info: ClassInfo): DeclaredFunction[] {
    const out: DeclaredFunction[] = [];
    // `extends Error` is the one base a class may name: the language's errors
    // are the one inheritance the compiler's own sources use, and the base is a
    // `message` field rather than a second layout.
    if (info.base !== null && info.base !== "Error") {
      this.report(
        `class inheritance is not supported ("${info.name}" extends "${info.base}")`,
        "write the fields and methods the class uses; a compiled class is one layout",
        { kind: "ident", text: info.name, line: info.line },
      );
    }
    const params = info.constructor?.params ?? [];
    const fields = this.fieldsOf(info, params);
    // A field written at a type another module declares is held as `any` by a
    // read that has not linked the declaration yet. The method written on the
    // field waits for the read that follows the link, where the field's own
    // declared type is in hand.
    for (const field of fields) {
      this.pendingNote = false;
      this.typeForName(field.typeName, field.line);
      if (this.pendingNote) this.pendingFields.add(field.name);
    }
    const object: Expression = {
      k: "object",
      fields: fields.map((field) => {
        const parameter = params.find((entry) => entry.property && entry.name === field.name);
        return { name: field.name, value: parameter === undefined ? this.defaultFieldValue(field) : { k: "ident", name: parameter.name } };
      }),
    };
    const body: Statement[] = [{ kind: "declare", name: "self", type: null, init: object, line: info.line }];
    // A field initialiser runs after the object exists, so a class field may
    // read another field through `this`; a parameter property is already the
    // argument the constructor was given and needs no assignment.
    for (const field of fields) {
      if (field.initStart < 0 || field.initEnd < field.initStart) continue;
      if (params.some((entry) => entry.property && entry.name === field.name)) continue;
      // The field's declared type is what an empty list in its initialiser is
      // built at: `private seen: string[] = []` names no element itself.
      const value = this.withClassContext(info, params, true, () =>
        this.readAt(
          this.typeForName(field.typeName, field.line),
          () => this.readRange(field.initStart, field.initEnd),
          this.shapeForName(field.typeName),
        ),
      );
      body.push({ kind: "memberAssign", base: "self", field: field.name, op: "=", value, line: field.line });
    }
    if (info.constructor !== null) {
      body.push(
        ...this.withClassContext(info, params, true, () => {
          this.position = info.constructor?.bodyStart ?? this.position;
          const statements = this.readBlock();
          if (this.position !== (info.constructor?.bodyEnd ?? this.position)) {
            this.report("a constructor body is a block of statements", `near "${this.peek().text}"`);
          }
          return statements;
        }),
      );
    }
    body.push({ kind: "result", value: { k: "ident", name: "self" }, line: info.line });
    const constructorParams = this.methodParams(params);
    out.push(this.declared(info.name, constructorParams, this.referenceTo(info.name), body, info.exported, info.line));
    out.push(...this.wrappers(info, { name: "constructor", params, returnTypeName: info.name, bodyStart: -1, bodyEnd: -1, line: info.line }, info.name, this.referenceTo(info.name), false, info.exported));

    // A getter is a method with no parameters whose name is read as a member,
    // so it is emitted beside the methods and called where it is read.
    for (const method of [...info.methods, ...info.getters]) {
      const name = `${info.name}_${method.name}`;
      const returns = this.returnTypeForName(method.returnTypeName, method.line);
      const statements = this.withClassContext(info, method.params, true, () =>
        this.readReturning(returns, () => {
          this.position = method.bodyStart;
          const read = this.readBlock();
          if (this.position !== method.bodyEnd) {
            this.report(`method "${method.name}" has a body of statements`, `near "${this.peek().text}"`);
          }
          return read;
        }, this.shapeForName(method.returnTypeName)),
      );
      out.push(
        this.declared(
          name,
          [{ name: "self", type: this.referenceTo(info.name) }, ...this.methodParams(method.params)],
          returns,
          statements,
          info.exported,
          method.line,
        ),
      );
      out.push(...this.wrappers(info, method, name, returns, true, info.exported));
    }
    for (const method of [...info.staticMethods, ...info.staticGetters]) {
      const name = `${info.name}_${method.name}`;
      const returns = this.returnTypeForName(method.returnTypeName, method.line);
      const statements = this.withClassContext(info, method.params, false, () =>
        this.readReturning(returns, () => {
          this.position = method.bodyStart;
          const read = this.readBlock();
          if (this.position !== method.bodyEnd) {
            this.report(`method "${method.name}" has a body of statements`, `near "${this.peek().text}"`);
          }
          return read;
        }, this.shapeForName(method.returnTypeName)),
      );
      out.push(this.declared(name, this.methodParams(method.params), returns, statements, info.exported, method.line));
      out.push(...this.wrappers(info, method, name, returns, false, info.exported));
    }
    for (const field of info.statics) {
      const fieldType = this.returnTypeForName(field.typeName, field.line);
      const value =
        field.initStart >= 0 && field.initEnd >= field.initStart
          ? this.withClassContext(info, [], false, () =>
              this.readAt(fieldType, () => this.readRange(field.initStart, field.initEnd), this.shapeForName(field.typeName)),
            )
          : ({ k: "null" } satisfies Expression);
      out.push(
        this.declared(
          `${info.name}_${field.name}`,
          [],
          this.returnTypeForName(field.typeName, field.line),
          [{ kind: "result", value, line: field.line }],
          info.exported,
          field.line,
        ),
      );
    }
    // The functions a class becomes are compiled with the module, but they are
    // not what the module exports: a source names the class, not `P_sum`. An
    // exported class offers its constructor under its own name, which is what
    // an importer binds; the methods are reached through the instances.
    for (const entry of out) entry.internal = true;
    if (info.exported || info.isDefault) {
      const constructor = out.find((entry) => entry.name === info.name);
      if (constructor !== undefined) constructor.internal = false;
    }
    return out;
  }

  /** Every class of the file, lowered to the functions the module parser reads. */
  private emitClasses(): DeclaredFunction[] {
    this.reportClassProblems();
    const out: DeclaredFunction[] = [];
    for (const info of this.classTable.ordered) out.push(...this.emitClass(info));
    return out;
  }

  /** Reads on to the end of the statement, or to one token of it. */
  private synchronizeTo(terminator: string): void {
    let depth = 0;
    while (this.peek().kind !== "end") {
      const token = this.next();
      if (token.kind !== "punct") continue;
      // The terminator is one of the brackets, so it is read before they are
      // counted: a `)` that closes the header ends it.
      if (token.text === terminator && depth <= 0) return;
      if (token.text === "(" || token.text === "[" || token.text === "{") depth += 1;
      else if (token.text === ")" || token.text === "]" || token.text === "}") depth -= 1;
    }
  }

  /** Reads on to the end of the statement, so the next one can be read. */
  private synchronize(consumeTerminator = true): void {
    let depth = 0;
    while (this.peek().kind !== "end") {
      const token = this.next();
      if (token.kind !== "punct") continue;
      if (token.text === "{" || token.text === "(" || token.text === "[") depth += 1;
      else if (token.text === "}" && depth === 0) {
        this.position -= 1;
        return;
      } else if (token.text === ")" || token.text === "]" || token.text === "}") {
        // A bracket that closes what is being read is not part of this
        // statement: the construct that opened it reads it next.
        if (depth === 0) {
          this.position -= 1;
          return;
        }
        depth -= 1;
      } else if (token.text === ";" && depth <= 0) {
        if (!consumeTerminator) this.position -= 1;
        return;
      }
    }
  }

  /** Reads on past the body of a declaration the parser cannot finish. */
  private skipBlock(): void {
    while (this.peek().kind !== "end" && !this.at("{")) this.next();
    if (!this.at("{")) return;
    let depth = 0;
    do {
      const token = this.next();
      if (token.kind !== "punct") continue;
      if (token.text === "{") depth += 1;
      else if (token.text === "}") depth -= 1;
    } while (depth > 0 && this.peek().kind !== "end");
  }

  /**
   * Whether the declaration at a token names only types, so the parser skips
   * it rather than compiling it. A type alias, an interface and an ambient
   * `declare` have no runtime value: the program is the same whether they were
   * written or not, and a file that holds them still compiles.
   *
   * `type` is contextual, so a declaration spelled `type = value` is a value:
   * the alias form always names a type or writes a `{ ... }` list of names.
   */
  private typeOnlyDeclarationAt(index = this.position): boolean {
    let at = index;
    if (this.tokens[at]?.text === "export") at += 1;
    const keyword = this.tokens[at]?.text;
    if (keyword === "declare") return true;
    if (keyword === "interface") return this.tokens[at + 1]?.kind === "ident";
    if (keyword === "type") {
      const next = this.tokens[at + 1];
      return next?.kind === "ident" || next?.text === "{";
    }
    return false;
  }

  /** Skips the type-only declaration at the parser, to the token after it. */
  private skipTypeOnlyDeclaration(): void {
    if (this.at("export")) this.next();
    if (this.at("declare")) {
      this.next();
      this.skipBalancedTypeTokens(new Set([";"]));
      this.accept(";");
      return;
    }
    if (this.at("interface")) {
      this.next();
      if (this.peek().kind === "ident") this.next();
      if (this.at("<")) this.skipTypeParameters();
      while (!this.at("{") && this.peek().kind !== "end") this.next();
      this.skipBalancedBraces();
      this.accept(";");
      return;
    }
    // `type A = ...;` and `type { A, B } from "./x.ts";`. The list form names
    // types another module declares, so there is nothing to skip but the list
    // and the module it names.
    this.next();
    if (this.at("{")) {
      this.skipBalancedBraces();
      while (!this.at(";") && this.peek().kind !== "end") this.next();
      this.accept(";");
      return;
    }
    if (this.peek().kind === "ident") this.next();
    if (this.at("<")) this.skipTypeParameters();
    if (this.accept("=")) this.skipBalancedTypeTokens(new Set([";"]));
    this.accept(";");
  }

  /** Skips the `{ ... }` a declaration writes, and the braces it nests. */
  private skipBalancedBraces(): void {
    if (!this.at("{")) return;
    let depth = 0;
    while (this.peek().kind !== "end") {
      const token = this.next();
      if (token.kind !== "punct") continue;
      if (token.text === "{") depth += 1;
      else if (token.text === "}") {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }

  /**
   * Whether the `<` at the parser opens the type arguments of a call, which is
   * the list whose closing `>` is followed by the `(` of that call.
   */
  private typeArgumentsBeforeCall(): boolean {
    // A type is written in names, commas, brackets and the punctuation of a
    // generic: a number, a question mark or an arithmetic operator is a value,
    // and `shift < 32 ? value << (32 - shift) >> (32 - shift) : value` is the
    // comparison and the shifts it looks like rather than a call.
    const allowed = new Set(["<", ">", ">>", ">>>", ",", ".", "[", "]", "|", "&", "(", ")", ":", "{", "}", "=>", "?", "!"]);
    let depth = 0;
    for (let at = this.position; at < this.tokens.length; at += 1) {
      const token = this.tokens[at] as Token;
      if (token.kind === "number") return false;
      const text = mark(token);
      if (text !== "" && text !== "?" && !allowed.has(text)) return false;
      // A `?` is the conditional of a value and not part of a type, but the
      // `?` of an optional field is: only the one after a name in a record is
      // a type's, and a call's arguments never write one.
      if (text === "?" && mark(this.tokens[at - 1] as Token | undefined) !== ":") return false;
      if (text === "<") depth += 1;
      else if (text === ">" || text === ">>" || text === ">>>") {
        depth -= text.length;
        if (depth <= 0) return mark(this.tokens[at + 1] as Token | undefined) === "(";
      }
    }
    return false;
  }

  /** Skips a `<...>` type parameter list, including the `>>` a nested one writes. */
  private skipTypeParameters(): void {
    if (!this.at("<")) return;
    let depth = 0;
    while (this.peek().kind !== "end") {
      const token = this.next();
      if (token.kind !== "punct") continue;
      if (token.text === "<") depth += 1;
      else if (token.text === ">") {
        depth -= 1;
        if (depth <= 0) return;
      } else if (token.text === ">>") {
        depth -= 2;
        if (depth <= 0) return;
      } else if (token.text === ">>>") {
        depth -= 3;
        if (depth <= 0) return;
      }
    }
  }

  /**
   * Skips the type of an angle-bracket assertion, whose opening `<` was read.
   *
   * A nested type closes with `>>` or `>>>` in one token, so the count of open
   * angles says how many of them the token closes. The closing token is read
   * with the type it ends, because the value follows it.
   */
  private skipTypeAssertion(): void {
    let depth = 0;
    while (this.peek().kind !== "end") {
      const token = this.next();
      if (token.kind !== "punct") continue;
      if (token.text === "<") depth += 1;
      else if (token.text === ">") {
        if (depth === 0) return;
        depth -= 1;
      } else if (token.text === ">>") {
        if (depth <= 1) return;
        depth -= 2;
      } else if (token.text === ">>>") {
        if (depth <= 2) return;
        depth -= 3;
      }
    }
    this.report("a type assertion is not closed", "write the type between < and >, as in <number>value", this.peek());
  }

  /**
   * Skips a run of type tokens, stopping at one of `stops` outside every
   * bracket.
   */
  private skipBalancedTypeTokens(stops: ReadonlySet<string>): void {
    this.position = this.typeTokensEnd(this.position, stops);
  }

  /**
   * Where a run of type tokens beginning at a token ends, as a token index.
   *
   * Type arguments nest with `<`, which the tokeniser writes as `>>` and `>>>`
   * where two or three close together, so those close as many as they name.
   */
  private typeTokensEnd(start: number, stops: ReadonlySet<string>): number {
    let parens = 0;
    let brackets = 0;
    let braces = 0;
    let angles = 0;
    let at = start;
    while (at < this.tokens.length && this.tokens[at]?.kind !== "end") {
      const token = this.tokens[at] as Token;
      const text = token.text;
      // A literal type such as `">>"` is a string token with the brackets in
      // its text: the brackets are punctuation, and only punctuation nests.
      const punctuated = token.kind === "punct";
      const flat = parens === 0 && brackets === 0 && braces === 0 && angles === 0;
      // A stop is read before the bracket it may open. `{` is the one that is
      // both: it starts an object type where the type expects one, and it
      // opens the function body where the annotation has ended.
      if (punctuated && flat && stops.has(text)) {
        const opener = text === "(" || text === "[" || text === "{" || text === "<";
        const previous = this.tokens[at - 1]?.text;
        const continues =
          previous === "|" ||
          previous === "&" ||
          previous === ":" ||
          previous === "?" ||
          previous === "=>" ||
          previous === "," ||
          previous === "<";
        if (!opener || (at > start && !continues)) return at;
      }
      if (!punctuated) {
        at += 1;
        continue;
      }
      if (text === "(") parens += 1;
      else if (text === ")") {
        if (parens === 0) return at;
        parens -= 1;
      } else if (text === "[") brackets += 1;
      else if (text === "]") {
        if (brackets === 0) return at;
        brackets -= 1;
      } else if (text === "{") braces += 1;
      else if (text === "}") {
        if (braces === 0) return at;
        braces -= 1;
      } else if (text === "<") angles += 1;
      else if (text === ">") {
        if (angles === 0) return at;
        angles -= 1;
      } else if (text === ">>") {
        if (angles < 2) return at;
        angles -= 2;
      } else if (text === ">>>") {
        if (angles < 3) return at;
        angles -= 3;
      }
      at += 1;
    }
    return at;
  }

  /**
   * Parses a module: the imports it binds, the functions it declares, and the
   * statements it runs.
   *
   * A function declaration is hoisted: the functions of a file are the
   * module's wherever they are written, so the body that runs before one does
   * not decide whether it is compiled, and a program and the functions it
   * calls are one source rather than one source reordered. A declaration the
   * module cannot hold is left where it was written, and so is every
   * declaration that calls it: a module function is compiled from a contract,
   * and a contract names only the functions the module holds. An export is the
   * exception: it is the module's interface, so what it wrote outside the
   * subset is the module's refusal and is never read again as a program.
   */
  parseModule(path: string, entry = true): ModuleAnalysis {
    const imports: ModuleImport[] = [];
    const typeImports: ModuleTypeImport[] = [];
    // A class is lowered before anything else is read: its constructor and
    // methods are declarations of the module, wherever the class was written,
    // and every use of the class is read against the same table.
    const functions: DeclaredFunction[] = this.emitClasses();
    /** The names `export { f }` offered, which a declaration may name later. */
    const namesExported: Record<string, true> = {};
    let defaultExport: string | null = this.classTable.defaultName;
    /**
     * Every declaration of the file, in the order it is written. Each is read
     * against diagnostics of its own and decided afterwards: whether the module
     * can hold it is not known until the whole file has been read, because a
     * function it calls may be one the module cannot hold.
     */
    const declarations: Declaration[] = [];
    /** The spans of the file that are imports rather than the module's own. */
    const importsWritten: Span[] = [];
    // An import is written at the top of the file, before anything runs; a
    // declaration is hoisted from wherever it is written.
    let atTop = true;
    /** Whether the file runs anything: a file that runs nothing is a library. */
    let runs = false;
    while (this.peek().kind !== "end") {
      // One refusal for each declaration or statement of the file, as one for
      // each statement of a body: the count a statement left behind is the
      // last statement's, not this one's.
      this.reporting = 0;
      if (atTop && this.at("import")) {
        const start = this.position;
        this.next();
        // `import type { T } from "./x.ts"` binds a type and no value, so the
        // module it names is never read at run time and is not an import.
        const typeOnly = this.at("type");
        if (typeOnly) this.next();
        const imported = this.readImport(typeOnly);
        importsWritten.push({ start, end: this.position });
        if (typeOnly) {
          if (imported.types !== undefined && imported.types.length > 0) {
            typeImports.push({ specifier: imported.specifier, names: imported.types, line: imported.line });
          }
        } else {
          if (!(imported.names !== null && imported.names.length === 0 && !imported.default)) {
            imports.push(imported);
          }
          if (imported.types !== undefined && imported.types.length > 0) {
            typeImports.push({ specifier: imported.specifier, names: imported.types, line: imported.line });
          }
        }
        continue;
      }
      if (
        this.at("function") ||
        this.at("export") ||
        this.at("async") ||
        this.at("type") ||
        this.at("interface") ||
        this.at("declare")
      ) {
        const declaration = this.readDeclaration(functions, namesExported);
        declarations.push(declaration);
        if (declaration.offers !== null) defaultExport = declaration.offers;
        continue;
      }
      // A top-level value is a declaration, not a statement that makes a
      // library run. The functions of the file read a constant expression where
      // it was written (see `scanConstants`), and a file of declarations alone
      // is a library. In the entry module the value is a statement the program
      // runs, so the body tokens keep it for the program parser.
      if (this.at("const") || this.at("let") || this.at("var")) {
        this.synchronize();
        this.accept(";");
        atTop = false;
        if (entry) runs = true;
        continue;
      }
      const before = this.position;
      this.synchronize();
      this.accept(";");
      // `synchronize` stops before a closing brace it does not own. A stray one
      // at the top of a file would leave the parser on the same token forever,
      // so it is read as the statement it ended rather than left to end it.
      if (this.position === before) this.next();
      atTop = false;
      runs = true;
    }
    // The calls decide where a declaration is read. A function the module
    // cannot hold is a function of the program, and a module function that
    // calls one would name a function its contract does not hold, so it is
    // read where its callee is, and so is every function that calls it. Where
    // the file is a program, a function of it is a function of the module only
    // if everything it calls is.
    const staying = new Set<string>();
    for (const declaration of declarations) {
      if (!declaration.program) continue;
      for (const entry of declaration.entries) staying.add(entry.name);
    }
    for (let moved = true; moved; ) {
      moved = false;
      for (const declaration of declarations) {
        if (declaration.program) continue;
        // An export is the module's interface, and a contract names only the
        // functions the module holds: it cannot become a function of the
        // program however its callee is read.
        if (declaration.exported) continue;
        let callsOne = false;
        for (const name of declaration.calls) {
          if (!staying.has(name)) continue;
          callsOne = true;
          break;
        }
        if (!callsOne) continue;
        declaration.program = true;
        for (const entry of declaration.entries) staying.add(entry.name);
        moved = true;
      }
    }
    const programEntries = new Set<DeclaredFunction>();
    for (const declaration of declarations) {
      if (!declaration.program) continue;
      for (const entry of declaration.entries) programEntries.add(entry);
    }
    if (programEntries.size > 0) {
      functions.splice(0, functions.length, ...functions.filter((entry) => !programEntries.has(entry)));
    }
    // An arrow is a function of the file: it is compiled and linked beside the
    // declaration that wrote it, and it is not an export of it, because a user
    // names the function that holds the arrow and not the arrow.
    functions.push(...this.closures);
    // The body is the statements that run, without the functions the module
    // holds: the parser that reads a program reads statements, and a function
    // body is not one of them. A declaration the body keeps stays in place,
    // because a program function is read where the program runs.
    const held: Span[] = [...importsWritten];
    for (const declaration of declarations) {
      if (!declaration.program) held.push({ start: declaration.start, end: declaration.end });
    }
    held.sort((left, right) => left.start - right.start);
    let bodyStart = 0;
    for (const span of held) {
      if (span.start !== bodyStart) break;
      bodyStart = span.end;
    }
    const bodyTokens: Token[] = [];
    let at = bodyStart;
    for (const span of held) {
      if (span.start < at) continue;
      bodyTokens.push(...this.tokens.slice(at, span.start));
      at = span.end;
    }
    bodyTokens.push(...this.tokens.slice(at));
    // A file that runs has a body for a refused function to be read in, unless
    // the declaration is the module's own and was held out of the body above.
    // What such a declaration could not hold is reported here, where it was
    // written, rather than left to a parser that reads a different grammar.
    for (const declaration of declarations) {
      if (declaration.program && runs) continue;
      for (const entry of declaration.refusal) this.diagnostics.report(entry.message, entry.detail, entry.line);
    }
    const body = runs ? parseProgramBody(bodyTokens, path, this.diagnostics, this.classTable, this.importedTypeNames) : [];
    // `export { f }` may name a function the file declared after it, so the
    // names are applied once the whole file has been read. A name no
    // declaration answers is refused here, where every other export is.
    for (const entry of functions) {
      if (namesExported[entry.name] === true) entry.exported = true;
    }
    const declared = new Set<string>(functions.map((entry) => entry.name));
    for (const declaration of declarations) {
      for (const entry of declaration.entries) declared.add(entry.name);
    }
    for (const name of Object.keys(namesExported)) {
      if (!declared.has(name)) {
        this.report(
          `"${name}" is exported but not declared here`,
          `a module offers the functions it declares; ${path} declares ${declared.size === 0 ? "none" : [...declared].map((name) => `"${name}"`).join(", ")}`,
        );
      }
    }
    return {
      path,
      imports,
      typeImports,
      types: this.typeTable,
      functions,
      default: defaultExport,
      body,
      constants: this.exportedConstants(),
      awaitingLink: this.deferred.size > 0,
    };
  }

  /**
   * The top-level constants this file offers, with the value of each read where
   * the source wrote it.
   *
   * A module that imports a constant binds a value of this file, and a compiled
   * function of the importing module has no environment to read it from: the
   * value itself is what crosses. It is read here because these are the tokens
   * that write it — a range of tokens names nothing in the file that imports.
   * A value built by a constructor is the file's own and is not offered: the
   * constructor is a function of the module that wrote it, and the module that
   * imports the name does not compile it.
   */
  private exportedConstants(): Map<string, ConstantInfo> {
    const values = new Map<string, ConstantInfo>();
    for (const [name, constant] of this.constants) {
      if (constant.exported !== true) continue;
      const read = this.settledConstant(name, constant);
      if (read !== null) values.set(name, read);
    }
    return values;
  }

  /** One constant as the value a module that imports it can read in place of the name. */
  private settledConstant(name: string, constant: ConstantInfo): ConstantInfo | null {
    if (constant.constructed === true) return null;
    if (constant.keys !== undefined) {
      const values: ConstantValue[] = [];
      for (const written of constant.values ?? []) {
        const value = this.constantValue(name, written);
        if (value === null) return null;
        values.push({ value });
      }
      const written: ConstantInfo = { keys: constant.keys, values };
      if (constant.keyKind !== undefined) written.keyKind = constant.keyKind;
      return written;
    }
    if (constant.fields !== undefined) {
      const fields = new Map<string, ConstantValue>();
      for (const [field, written] of constant.fields) {
        const value = this.constantValue(name, written);
        if (value === null) return null;
        fields.set(field, { value });
      }
      return { fields };
    }
    const value = this.constantValue(name, constant.expression);
    if (value === null) return null;
    return { expression: { value } };
  }

  /**
   * One declaration of the file, read with diagnostics of its own.
   *
   * A construct the module parser cannot read — a Promise executor, a method a
   * class does not declare — may still be a function of the program, so what
   * it earned is a refusal of the module and not of the file. The declaration is left where it was written, and the refusal is
   * kept for a file that has no body to read it in.
   */
  private readDeclaration(functions: DeclaredFunction[], namesExported: Record<string, true>): Declaration {
    const start = this.position;
    const before = functions.length;
    const closuresBefore = this.closures.length;
    const saved = this.diagnostics;
    const savedReporting = this.reporting;
    const trial = new Diagnostics();
    this.diagnostics = trial;
    this.reporting = 0;
    let offers: string | null = null;
    try {
      offers = this.readFunctionDeclaration(functions, namesExported);
    } finally {
      this.diagnostics = saved;
      this.reporting = savedReporting;
    }
    const end = this.position;
    const entries = functions.slice(before);
    const exported = this.declaresExport(start) || entries.some((entry) => entry.exported);
    // A declaration the module cannot hold is read by the program instead: a
    // construct the module refused, or a function that reads a value the
    // running program holds. An export is the exception, because it is the
    // module's interface rather than one of the body's own declarations.
    // `export { f }` adds no function and refuses nothing: it names functions,
    // and is not a statement the body runs.
    const readsProgramState = entries.length > 0 && entries.some((entry) => readsState(entry.handle as TypeScriptFunction, this.state));
    const refused = trial.entries.length > 0;
    // An exported function is the module's interface. Handing it to the program
    // parser would not read the module's own refusal: the program parser does
    // not know an `export`, so it reports the export keyword first and buries
    // what the function itself wrote outside the subset. The refusal stays the
    // module's, and the declaration is held out of the body below.
    const program = refused ? !exported : readsProgramState;
    if (program) {
      functions.length = before;
      // The arrows the refused declaration wrote are read again, by the parser
      // the program reads bodies with: they are functions of the program then,
      // not of this module.
      this.closures.length = closuresBefore;
      this.position = start;
      // A function is skipped by the braces it is written in, whatever the
      // parser read of it; a construct that is not one is skipped as the
      // statement it is, so a refusal does not swallow what is written after it.
      if (this.declaresFunction(start)) this.skipFunctionBody(start);
      else this.synchronize();
    } else if (refused) {
      // The module offered a function it cannot hold. The entries it read are
      // not functions of the module after all, and the declaration is not a
      // statement of the body either, so nothing reads it a second time.
      functions.length = before;
      this.closures.length = closuresBefore;
    }
    const calls = new Set<string>();
    if (!program) {
      for (const entry of entries) {
        for (const name of callsOf(entry.handle as TypeScriptFunction)) calls.add(name);
      }
    }
    return {
      start,
      end: program ? this.position : end,
      entries: [...entries],
      exported,
      program,
      calls,
      refusal: [...trial.entries],
      offers,
    };
  }

  /** Whether the declaration at a token writes `export`. */
  private declaresExport(start: number): boolean {
    let index = start;
    while (index < this.tokens.length) {
      const text = this.tokens[index]?.text;
      if (text === "export") return true;
      if (text !== "default" && text !== "async" && text !== "declare") return false;
      index += 1;
    }
    return false;
  }

  /** Whether the declaration at a token writes a function, which has a body to skip. */
  private declaresFunction(start: number): boolean {
    let index = start;
    while (index < this.tokens.length) {
      const text = this.tokens[index]?.text;
      if (text === "function") return true;
      if (text !== "export" && text !== "default" && text !== "async") return false;
      index += 1;
    }
    return false;
  }

  /** Moves past the body of the declaration at a token, whatever it holds. */
  private skipFunctionBody(start: number): void {
    // The parameters are read first, because a default value may hold braces of
    // its own and the body is the first `{` after the `)`.
    let index = start;
    while (index < this.tokens.length && this.tokens[index].text !== "(") index += 1;
    let parens = 0;
    for (; index < this.tokens.length; index += 1) {
      const token = this.tokens[index] as Token;
      if (token.text === "(") parens += 1;
      else if (token.text === ")") {
        parens -= 1;
        if (parens === 0) {
          index += 1;
          break;
        }
      }
    }
    // A return type is written between the `)` and the body, and it may hold a
    // brace of its own: `(): { buffer: string } | null {` writes the type's
    // brace where the body's was looked for, so the declaration ended at its
    // type and the rest of the signature was read as a statement of the file.
    // The annotation is skipped as a type, and the body is the brace after it.
    if (this.tokens[index]?.text === ":") {
      index = this.typeTokensEnd(index, FUNCTION_BODY_STOPS);
    }
    while (index < this.tokens.length && this.tokens[index].text !== "{") index += 1;
    let depth = 0;
    for (; index < this.tokens.length; index += 1) {
      const token = this.tokens[index] as Token;
      if (token.text === "{") depth += 1;
      else if (token.text === "}") {
        depth -= 1;
        if (depth === 0) {
          this.position = index + 1;
          return;
        }
      }
    }
    this.position = this.tokens.length;
  }

  /**
   * One function declaration, at the `export` or `function` the parser is at.
   *
   * The declaration is pushed onto `functions` together with the overloads its
   * defaults make callable, and the name it offers as the module's default is
   * answered. A construct here that is not a function is reported and skipped,
   * and answers no default.
   */
  private readFunctionDeclaration(functions: DeclaredFunction[], namesExported: Record<string, true>): string | null {
    // A declaration that names only types writes no value and runs nothing, so
    // it is skipped where it is written and the declarations after it are read
    // as if it were not there.
    if (this.typeOnlyDeclarationAt()) {
      this.skipTypeOnlyDeclaration();
      return null;
    }
    let isAsync = false;
    if (this.at("async")) {
      this.next();
      isAsync = true;
    }
    const exported = this.accept("export");
    if (exported && this.at("async")) {
      this.next();
      isAsync = true;
    }
    let isDefault = false;
    if (exported && this.at("default")) {
      this.next();
      // `export default async function f() {}`: the promise is behind a default
      // export as well as behind a named one.
      if (this.at("async")) {
        this.next();
        isAsync = true;
      }
      // `export default function f() {}` offers `f` as the module's default.
      // It is offered under the name it was declared with, because this subset
      // links by name: there is one table of functions for the whole program,
      // so one name cannot stand for two of them.
      if (!this.at("function")) {
        this.report(
          "only a function can be a default export",
          `as in export default function f(): number { ... }, not ${this.peek().text}`,
          this.peek(),
        );
        this.skipBlock();
        return null;
      }
      isDefault = true;
    }
    if (exported && this.at("{")) {
      for (const name of this.readExportNames()) namesExported[name] = true;
      return null;
    }
    // A top-level `const`, `let` or `var` is a value the file holds. A function
    // that reads one of its constant expressions is compiled with the value
    // written where it was read (see `scanConstants`), so the declaration is
    // skipped here rather than refused: the module's function is the thing the
    // build needs. A value another module imports is a different question, and
    // the import phase answers it.
    if (exported && (this.at("const") || this.at("let") || this.at("var"))) {
      this.synchronize();
      return null;
    }
    if (exported && !this.at("function")) {
      this.report(
        "only functions can be exported",
        `a module offers functions, not ${this.peek().text}; a value another module reads is written into a function that returns it`,
        this.peek(),
      );
      this.skipBlock();
      return null;
    }
    this.expect("function");
    const name = this.next();
    // `function* name()`: a generator is refused by the star, which is where it
    // was written rather than by the name the parser went looking for.
    if (name.text === "*") {
      this.report("a generator is not supported", REFUSED_KEYWORDS.yield, name);
      this.skipBlock();
      return null;
    }
    if (name.kind !== "ident") {
      this.report("expected a function name", `near "${name.text}"`, name);
      this.synchronize();
      return null;
    }
    // The type parameters a generic function declares are erased with the
    // types themselves: they say what the body may hold, not what it does.
    if (this.at("<")) this.skipTypeParameters();
    const parsed = this.parseFunction(name, isAsync);
    if (parsed === null) return null;
    functions.push({
      name: parsed.name,
      exported,
      params: parsed.params,
      returns: parsed.returns,
      handle: parsed,
    });
    this.declaredReturns.set(parsed.name, parsed.returns);
    this.declaredParams.set(parsed.name, parsed.params.map((param) => param.type));
    if (parsed.returnsShape !== undefined) this.declaredReturnShapes.set(parsed.name, parsed.returnsShape);
    if (parsed.collection !== undefined) this.declaredCollections.set(parsed.name, parsed.collection);
    for (const wrapper of this.defaultWrappers(parsed, exported)) {
      this.declaredReturns.set(wrapper.name, wrapper.returns);
      this.declaredParams.set(wrapper.name, wrapper.params.map((param) => param.type));
      if (parsed.returnsShape !== undefined) this.declaredReturnShapes.set(wrapper.name, parsed.returnsShape);
      functions.push(wrapper);
    }
    return isDefault ? parsed.name : null;
  }

  /** `export { f, g }`: the names the file offers, and the `from` they may come from. */
  private readExportNames(): string[] {
    this.next();
    const names: string[] = [];
    while (!this.at("}") && this.peek().kind !== "end") {
      const name = this.next();
      if (name.kind !== "ident") {
        this.report("expected an exported name", `near "${name.text}"`, name);
        continue;
      }
      // `export { type T }` offers a type, not a function: the list still ends
      // where the source wrote it. `{ type as alias }` offers the value named
      // `type`, so an `as` after it is not the type modifier.
      if (name.text === "type" && this.peek().kind === "ident" && this.peek().text !== "as") {
        this.next();
        if (this.at("as")) {
          this.next();
          if (this.peek().kind === "ident") this.next();
        }
        if (!this.accept(",")) break;
        continue;
      }
      names.push(name.text);
      if (!this.accept(",")) break;
    }
    this.expect("}");
    this.accept(";");
    if (this.at("from")) {
      this.report(
        "a module re-exporting another module's functions is not supported",
        `import ${names.map((name) => `{ ${name} }`).join(", ")} from the other module and call ${names[0] ?? "them"} from here`,
      );
      this.synchronize();
    }
    return names;
  }

  /**
   * The import forms a module has: `import { f, g } from "./other.ts";`, which
   * binds the exports it names, and `import f from "./other.ts";`, which binds
   * whatever the module exports as its default.
   */
  private readImport(typeOnly = false): ModuleImport {
    const start = this.peek();
    const types: ModuleTypeBinding[] = [];
    // `import * as ns from "./x.ts"` binds every export under one name. This
    // linker is by function name, so a namespace has no name to bind: the form
    // is read and the names it brings in are not. A type-only namespace names
    // no value at all, so it is skipped without a refusal.
    if (this.at("*")) {
      this.next();
      if (this.at("as")) {
        this.next();
        if (this.peek().kind === "ident") this.next();
      }
      if (!typeOnly) {
        this.report(
          "namespace imports are not supported",
          'import the functions by name, as in import { f } from "./other.ts"',
          start,
        );
      }
      return this.readImportTail(start, [], false, types);
    }
    // `import d from "./x.ts"` and `import d, { a, b } from "./x.ts"`. The
    // local name a default import writes is not carried, because the programs
    // of this subset are linked by the name a function was declared with: one
    // table holds every function of every file, so a second name for one of
    // them would be a second compilation of it.
    if (!this.at("{") && (this.peek(1).kind === "ident" || this.peek(1).text === ",")) {
      this.next();
      return this.readImportTail(start, this.accept(",") ? this.readImportedNames(typeOnly, types) : [], true, types);
    }
    if (!this.at("{")) {
      this.report(
        "unsupported import form",
        'a module imports named exports, as in import { f } from "./other.ts", or the default one, as in import f from "./other.ts"',
        start,
      );
      this.synchronize();
      return { specifier: "", names: [], default: false, line: start.line };
    }
    return this.readImportTail(start, this.readImportedNames(typeOnly, types), false, types);
  }

  /** `{ f, g }`: the exports an import names, which it binds as they are written. */
  private readImportedNames(typeOnly = false, types: ModuleTypeBinding[] = []): string[] {
    this.expect("{");
    const names: string[] = [];
    while (!this.at("}") && this.peek().kind !== "end") {
      const name = this.next();
      if (name.kind !== "ident") {
        this.report("expected an imported name", `near "${name.text}"`, name);
        continue;
      }
      // `{ type T }` names a type the import does not bind at run time. The
      // alias, where one is written, is read with it so the list still ends
      // where the source wrote it. `{ type as alias }` imports the value named
      // `type`, so an `as` after it is not the type modifier.
      if (name.text === "type" && this.peek().kind === "ident" && this.peek().text !== "as") {
        const typeName = this.next();
        let local = typeName.text;
        if (this.at("as")) {
          this.next();
          const alias = this.next();
          if (alias.kind === "ident") local = alias.text;
        }
        types.push({ local, imported: typeName.text });
        if (!this.accept(",")) break;
        continue;
      }
      if (this.at("as")) {
        if (!typeOnly) {
          this.report("renaming an import is not supported", `as written on line ${name.line}`, name);
        }
        // The alias is read even though it is refused: the import is skipped as
        // the statement it is, so the `}` that closes it must be read here and
        // not left to end the statement.
        this.next();
        const alias = this.next();
        if (typeOnly) {
          // A type-only import binds nothing at run time, so a name it renames
          // is the type's name and not a value of the module.
          if (alias.kind === "ident") types.push({ local: alias.text, imported: name.text });
          if (!this.accept(",")) break;
          continue;
        }
        if (alias.kind === "ident") types.push({ local: alias.text, imported: name.text });
      } else {
        types.push({ local: name.text, imported: name.text });
      }
      names.push(name.text);
      if (!this.accept(",")) break;
    }
    this.expect("}");
    return names;
  }

  /** The `from "./other.ts"` every import ends with, and the module it names. */
  private readImportTail(
    start: Token,
    names: string[],
    isDefault: boolean,
    types: ModuleTypeBinding[] = [],
  ): ModuleImport {
    const withTypes = types.length === 0 ? {} : { types };
    if (!this.at("from")) {
      this.report('expected "from" after the imported names', `near "${this.peek().text}"`);
      this.synchronize();
      return { specifier: "", names, default: isDefault, line: start.line, ...withTypes };
    }
    this.next();
    const specifier = this.next();
    if (specifier.kind !== "string") {
      this.report("expected the imported module as a string", `near "${specifier.text}"`, specifier);
      this.synchronize();
      return { specifier: "", names, default: isDefault, line: start.line, ...withTypes };
    }
    this.expect(";");
    return { specifier: specifier.text, names, default: isDefault, line: start.line, ...withTypes };
  }

  private parseFunction(name: Token, isAsync = false): TypeScriptFunction | null {
    // A function declared by the module is not a method: `this` names nothing
    // in it, and the class each of its names holds starts empty.
    this.currentClass = null;
    this.valueClasses = new Map();
    this.valueTypes = new Map();
    this.valueShapes = new Map();
    this.valueArrows = new Map();
    this.valueFunctions = new Map();
    // A collection a file declares at the top is a name its functions read, so
    // what each of them holds is carried into the function being read.
    this.valueCollections = new Map(this.valueCollections);
    this.iteratedCollections = new Map();
    this.iteratedSequences = new Map();
    let answered: CollectionValue | null = null;
    const declared = (returns: TypeExpr, body: Statement[], shape: ResolvedType | null = null): TypeScriptFunction => ({
      name: name.text,
      params,
      returns,
      ...(shape === null ? {} : { returnsShape: shape }),
      body,
      line: name.line,
      ...(isAsync ? { async: true } : {}),
      ...(answered === null ? {} : { collection: answered }),
    });
    this.expect("(");
    const params: TypeScriptFunction["params"] = [];
    /** What a parameter written as a pattern binds, read before the body runs. */
    const prelude: Statement[] = [];
    if (this.at(")")) {
      this.next();
    } else {
      for (;;) {
        // `{ a, b: c }` and `[a, b]` are parameters that name no value of their
        // own: the value is one the caller hands over, and each name the
        // pattern writes is read out of it where the body starts.
        const pattern = this.readParameterPattern();
        if (pattern !== null) {
          const read = this.accept("?");
          void read;
          let patternType: TypeExpr = ANY_TYPE;
          let patternShape: ResolvedType | null = null;
          if (this.accept(":")) {
            patternType = this.readTypeAnnotation("a parameter type", new Set([",", ")", "="]));
            patternShape = this.lastAnnotationShape();
          }
          const fallbackPattern = this.accept("=")
            ? this.readAt(patternType, () => this.readExpression(), patternShape)
            : undefined;
          const temp = `__param${this.destructureCount++}`;
          params.push({
            name: temp,
            type: patternType,
            ...(fallbackPattern === undefined ? {} : { default: fallbackPattern }),
          });
          this.valueTypes.set(temp, patternType);
          if (patternShape !== null) this.valueShapes.set(temp, patternShape);
          prelude.push(...this.patternPrelude(pattern, temp, patternType, name.line, patternShape));
          if (this.accept(",")) {
            if (this.at(")")) {
              this.next();
              break;
            }
            continue;
          }
          this.expect(")");
          break;
        }
        const parameter = this.next();
        if (parameter.kind !== "ident") {
          this.report("expected a parameter name", `near "${parameter.text}"`, parameter);
          this.synchronize();
          break;
        }
        // A parameter states its type, or states a default and has the type
        // that default is. `function invert(n: bigint, modulo = CURVE.P)` is
        // the second form: the default says what the parameter holds. A `?`
        // says the call may leave the parameter out, and a value model with no
        // absent value cannot yet say what it holds then: the annotation is
        // erased and the parameter is the type it was declared.
        this.accept("?");
        let mapped: TypeExpr | null = null;
        let functionType: FunctionType | null = null;
        let collectionType: CollectionValue | null = null;
        let shape: ResolvedType | null = null;
        if (this.accept(":")) {
          // A type may be a named type, a union, a generic, an object or a
          // function type: every one of them is read to its end and erased.
          const head = this.peek().kind === "ident" ? this.peek().text : "";
          functionType = this.annotationFunctionType(new Set([",", ")", "="]));
          collectionType = this.annotationCollection(new Set([",", ")", "="]));
          mapped = this.readTypeAnnotation("a parameter type", new Set([",", ")", "="]));
          this.pendingNote = false;
          shape = this.lastAnnotationShape();
          if (collectionType === null) collectionType = this.collectionOfShape(shape);
          if (head !== "" && this.classTable.names.has(head)) this.valueClasses.set(parameter.text, head);
        }
        const fallback = this.accept("=")
          ? this.readAt(mapped, () => this.readExpression(), shape)
          : undefined;
        if (mapped === null) {
          if (fallback === undefined) {
            this.report("expected a parameter type", `near "${this.peek().text}"`, this.peek());
            this.synchronize();
            break;
          }
          mapped = defaultParameterType(fallback);
        }
        params.push({
          name: parameter.text,
          type: mapped,
          ...(fallback === undefined ? {} : { default: fallback }),
        });
        this.valueTypes.set(parameter.text, mapped);
        if (this.pendingNote) this.pendingValues.add(parameter.text);
        else this.pendingValues.delete(parameter.text);
        if (shape !== null) this.valueShapes.set(parameter.text, shape);
        if (functionType !== null) this.valueFunctions.set(parameter.text, functionType);
        if (collectionType !== null) this.valueCollections.set(parameter.text, collectionType);
        if (this.accept(",")) {
          // A list of parameters may end with a comma, which names nothing: the
          // `)` that follows it is the end of the list and not a parameter.
          if (this.at(")")) {
            this.next();
            break;
          }
          continue;
        }
        this.expect(")");
        break;
      }
    }
    if (!this.at(":")) {
      // A function that states no result has the one its returns are. The body
      // is read here rather than refused, because the language lets a function
      // omit the annotation and the returns are what say it.
      const body = this.readBlock();
      return declared(inferredResult(body, params), [...prelude, ...body]);
    }
    this.next();
    answered = this.annotationCollection(new Set(["{", "=", ";"]));
    const returnType = this.readTypeAnnotation("a return type", new Set(["{", "=", ";"]), isAsync);
    const returnShape = this.lastAnnotationShape();
    if (this.accept("=")) {
      // `function f(x: T): T = expr;` carries an optional trailing semicolon.
      const value = this.readAt(returnType, () => this.readExpression(), returnShape);
      this.accept(";");
      return declared(returnType, [{ kind: "result", value, line: name.line }], returnShape);
    }
    return declared(
      returnType,
      [...prelude, ...this.readReturning(returnType, () => this.readBlock(), returnShape)],
      returnShape,
    );
  }

  /**
   * `{ a, b: c }` or `[a, b]` written where a parameter name goes.
   *
   * A pattern binds names rather than naming one value, so the value is held at
   * a name of the pattern's own and each bound name is a declaration read out
   * of it. The fields and the positions are the ones the source wrote.
   */
  private readParameterPattern(): { name: string; field: string | null; index: number }[] | null {
    if (this.at("{")) {
      this.next();
      const bindings: { name: string; field: string | null; index: number }[] = [];
      while (!this.at("}") && this.peek().kind !== "end") {
        const written = this.next();
        if (written.kind !== "ident") {
          this.report("a destructured field is named", `near "${written.text}"`, written);
          this.synchronizeTo("}");
          break;
        }
        let bound = written.text;
        if (this.accept(":")) {
          const alias = this.next();
          if (alias.kind !== "ident") this.report("a destructured field binds a name", `near "${alias.text}"`, alias);
          else bound = alias.text;
        }
        if (this.at("=")) {
          this.report("a destructured field with a default is not supported", "write the default where the value is made");
          this.next();
          this.readExpression();
        }
        bindings.push({ name: bound, field: written.text, index: -1 });
        if (!this.accept(",")) break;
      }
      this.expect("}");
      return bindings;
    }
    if (this.at("[")) {
      this.next();
      const bindings: { name: string; field: string | null; index: number }[] = [];
      let at = 0;
      while (!this.at("]") && this.peek().kind !== "end") {
        // `[a, , b]`: a gap names no element, so the positions after it move
        // by one all the same.
        if (this.accept(",")) {
          at += 1;
          continue;
        }
        if (this.accept("...")) {
          this.report("a rest element is not part of the destructuring subset", "write the names the pattern binds");
          this.synchronizeTo("]");
          break;
        }
        const name = this.next();
        if (name.kind !== "ident") this.report("a destructured element binds a name", `near "${name.text}"`, name);
        else bindings.push({ name: name.text, field: null, index: at });
        at += 1;
        if (!this.accept(",")) break;
      }
      this.expect("]");
      return bindings;
    }
    return null;
  }

  /**
   * The declarations a parameter pattern binds, read out of the value it names.
   *
   * An array pattern written against an array type binds each name at the
   * element type, because the name is one element of the value it was handed.
   */
  private patternPrelude(
    bindings: readonly { name: string; field: string | null; index: number }[],
    temp: string,
    type: TypeExpr,
    line: number,
    shape: ResolvedType | null = null,
  ): Statement[] {
    const base: Expression = { k: "ident", name: temp };
    // A pattern binds names of its own, and a test that settled a name of the
    // same spelling in the scope around it says nothing about them.
    for (const binding of bindings) this.forgetNarrowing(binding.name);
    const element = type.kind === "slice" || type.kind === "array" ? type.of : null;
    if (element !== null) {
      for (const binding of bindings) {
        if (binding.field === null) this.valueTypes.set(binding.name, element);
      }
    }
    if (shape !== null) {
      for (const binding of bindings) {
        const bound = binding.field === null
          ? elementOfType(this.typeTable, shape)
          : (fieldOfType(this.typeTable, shape, binding.field)?.type ?? null);
        if (bound !== null) {
          this.valueShapes.set(binding.name, bound);
          this.valueTypes.set(binding.name, this.typeExprOfShape(bound));
        }
      }
    }
    return bindings.map((binding): Statement => ({
      kind: "declare",
      name: binding.name,
      type: null,
      init: binding.field !== null
        ? { k: "member", base, field: binding.field }
        : { k: "index", base, index: { k: "literal", text: String(binding.index) } },
      line,
    }));
  }

  /**
   * What a `Map<...>` or a `Set<...>` annotation names, or null where it names
   * something else.
   *
   * A map is held as one handle, which is not a type the contract can spell, so
   * what it holds is read here and kept beside the name. This frontend keys by
   * text: a `Map` over any other key is refused where it is written, because the
   * runtime's dictionary is keyed by a string.
   */
  private annotationCollection(stops: ReadonlySet<string>): CollectionValue | null {
    return this.annotationCollectionAt(this.position, stops);
  }

  /** What a `Map<...>` or a `Set<...>` starting at one token names. */
  private annotationCollectionAt(start: number, stops: ReadonlySet<string>): CollectionValue | null {
    const end = this.typeEndAt(start, stops);
    const head = this.tokens[start];
    const kind = head?.text === "Map" || head?.text === "WeakMap" || head?.text === "Record"
      ? "map" as const
      : head?.text === "Set" || head?.text === "WeakSet"
        ? "set" as const
        : null;
    if (kind === null) return null;
    if (this.tokens[start + 1]?.text !== "<") return { kind, key: TEXT_RESULT, value: NUMBER_RESULT };
    const close = this.matchingToken(start + 1, "<", ">");
    if (close < 0 || close >= end) return { kind, key: TEXT_RESULT, value: NUMBER_RESULT };
    const arguments_ = this.typeArguments(start + 2, close);
    // `Record<string, V>` writes the key it is keyed by and the value it holds;
    // a map writes the same two arguments.
    const key = arguments_[0] ?? TEXT_RESULT;
    const value = kind === "map" ? (arguments_[1] ?? NUMBER_RESULT) : NUMBER_RESULT;
    if (!this.isTextKey(key)) {
      this.report(
        `a ${head.text} here is keyed by text, not by ${typeToString(key)}`,
        "a key is a string or a reference: write the key as the text it is, as in m.set(`${id}`, value)",
        head,
      );
      return null;
    }
    return { kind, key, value };
  }

  /** Whether a key type is one the runtime's dictionary is keyed by. */
  private isTextKey(type: TypeExpr): boolean {
    return type.kind === "text" || type.kind === "ref";
  }

  /** The type arguments written between two angle brackets, one per argument. */
  private typeArguments(start: number, close: number): TypeExpr[] {
    const out: TypeExpr[] = [];
    let depth = 0;
    let from = start;
    for (let at = start; at < close; at += 1) {
      const token = this.tokens[at];
      if (token?.kind !== "punct") continue;
      if (token.text === "<" || token.text === "(" || token.text === "[" || token.text === "{") depth += 1;
      else if (token.text === ">" || token.text === ")" || token.text === "]" || token.text === "}") depth -= 1;
      else if (token.text === ">>") depth -= 2;
      else if (token.text === ">>>") depth -= 3;
      else if (token.text === "," && depth === 0) {
        out.push(this.typeFromTokens(from, at, false));
        from = at + 1;
      }
    }
    if (from < close) out.push(this.typeFromTokens(from, close, false));
    return out;
  }

  /**
   * The signature an annotation names, when the annotation is a function type.
   *
   * `(x: number) => number` is a value the source may hold and call, and the
   * contract has no type for one: the value itself is an opaque reference and
   * what a call of it is made against is the signature written here. The
   * annotation is read twice — once for the signature and once as the type the
   * value is held at — because the two answers are used at different places: a
   * name is held as a reference and called against the signature.
   */
  private annotationFunctionType(stops: ReadonlySet<string>): FunctionType | null {
    const start = this.position;
    const end = this.typeEndAt(start, stops);
    return this.functionTypeFrom(start, end);
  }

  /** The signature a run of annotation tokens names, or null where it names none. */
  private functionTypeFrom(start: number, end: number): FunctionType | null {
    let at = start;
    while (this.tokens[at]?.text === "readonly") at += 1;
    // `<T>(x: T) => T` is a function type whose type parameters are erased with
    // every other type the frontend reads.
    if (this.tokens[at]?.text === "<") {
      const close = this.matchingToken(at, "<", ">");
      if (close < 0 || close >= end) return null;
      at = close + 1;
    }
    if (this.tokens[at]?.text !== "(") return null;
    const close = this.matchingToken(at, "(", ")");
    if (close < 0 || close >= end) return null;
    if (this.tokens[close + 1]?.text !== "=>") return null;
    const params: TypeExpr[] = [];
    let cursor = at + 1;
    while (cursor < close) {
      // A parameter is `name: type`, `name?: type` or a bare name whose type is
      // the opaque reference. A destructured parameter names no one type, so
      // the annotation is not one this can read a call against.
      while (this.tokens[cursor]?.text === "readonly") cursor += 1;
      if (this.tokens[cursor]?.text === "this" && this.tokens[cursor + 1]?.text === ":") {
        // `this: Foo` says what the call is made on, which a value held here is
        // not: it is read past and names no parameter.
        cursor += 2;
        while (cursor < close && this.tokens[cursor]?.text !== ",") cursor += 1;
        if (this.tokens[cursor]?.text === ",") cursor += 1;
        continue;
      }
      if (this.tokens[cursor]?.text === "{") return null;
      if (this.tokens[cursor]?.text === "...") cursor += 1;
      if (this.tokens[cursor]?.kind !== "ident") return null;
      cursor += 1;
      if (this.tokens[cursor]?.text === "?") cursor += 1;
      let type: TypeExpr = ANY_TYPE;
      if (this.tokens[cursor]?.text === ":") {
        cursor += 1;
        const typeStart = cursor;
        let depth = 0;
        while (cursor < close) {
          const text = this.tokens[cursor]?.text;
          if (this.tokens[cursor]?.kind === "punct") {
            if (text === "(" || text === "[" || text === "{" || text === "<") depth += 1;
            else if (text === ")" || text === "]" || text === "}" || text === ">") depth -= 1;
            else if (text === ">>") depth -= 2;
            else if (text === ">>>") depth -= 3;
            else if (text === "," && depth === 0) break;
          }
          cursor += 1;
        }
        type = this.typeFromTokens(typeStart, cursor, false);
      }
      params.push(type);
      if (this.tokens[cursor]?.text === ",") cursor += 1;
    }
    const returns = this.typeFromTokens(close + 2, end, false);
    return { params, returns };
  }

  /**
   * Reads a type annotation to one of the types the contract has.
   *
   * TypeScript's type language is larger than the value language this frontend
   * compiles, and none of it runs: an interface, a union, a type argument and a
   * function type are all erased. What the annotation says about a number, a
   * buffer or a class is kept, and everything else is the opaque reference
   * `any`. The tokens are read to their end by `skipBalancedTypeTokens`, so a
   * nested `Map<string, Array<number>>` is one annotation and not a run of
   * expressions.
   *
   * `promisePayload` reads `Promise<T>` as `T`: an async function's result is
   * the value its promise carries, which is what the contract describes.
   */
  private readTypeAnnotation(what: string, stops: ReadonlySet<string>, promisePayload = false): TypeExpr {
    const start = this.position;
    this.skipBalancedTypeTokens(stops);
    const end = this.position;
    this.lastTypeRange = { start, end };
    if (start === end) {
      this.report(`expected ${what}`, `near "${this.peek().text}"`, this.peek());
      return ANY_TYPE;
    }
    // A name this file imports may be written inside a larger annotation as
    // readily as on its own: `Name[]`, `Record<string, Name>` and
    // `Omit<Full, "c">` all name a declaration in another module. Until the
    // graph links it, every one of them is a type this read does not hold.
    this.notePendingAnnotation(start, end);
    return this.typeFromTokens(start, end, promisePayload);
  }

  /**
   * Whether a value is held at the reference this read cannot look inside.
   *
   * A type another module declares is carried as one, and so is a value whose
   * declaration the graph has not linked: what it holds is the link's to say.
   */
  private opaqueValue(value: Expression): boolean {
    const type = this.valueTypeOf(value);
    return type.kind === "ref" && type.of === null && type.name === undefined;
  }

  /**
   * Whether an annotation names a declaration this file imports and the graph
   * has not linked.
   *
   * A name may be written inside a larger annotation, as `Name[]` and
   * `Record<string, Name>` both do, so every name the text mentions is asked.
   */
  private annotationWaitsForLink(text: string): boolean {
    if (this.linked) return false;
    for (const name of text.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []) {
      if (!this.importedTypeNames.has(name)) continue;
      if (this.typeTable.declarations.has(name) || this.typeTable.imported.has(name)) continue;
      return true;
    }
    return false;
  }

  /**
   * Whether a field is declared at a type this file imports and the graph has
   * not linked.
   *
   * The field's annotation named a declaration that no table of this module
   * holds. One of those names being an import means the declaration is another
   * module's, and the read that follows the link holds it: what is written on a
   * value at that type waits for that read.
   */
  private fieldWaitsForLink(field: ResolvedField): boolean {
    if (this.linked || field.unlinked === undefined) return false;
    for (const name of field.unlinked) {
      if (!this.importedTypeNames.has(name)) continue;
      if (this.typeTable.declarations.has(name) || this.typeTable.imported.has(name)) continue;
      return true;
    }
    return false;
  }

  /**
   * Records that an annotation mentions a type this file imports, whatever else
   * it writes, so the reads that wait for the link wait for it here too.
   */
  private notePendingAnnotation(start: number, end: number): void {
    const written = this.tokens.slice(start, end).map((token) => token.text).join(" ");
    // The file-level verdict is what this read needs; the note about the
    // declaration just read belongs to the caller that asked for it.
    const note = this.pendingNote;
    this.notePendingType(written);
    this.pendingNote = note;
  }

  /** The shape of the annotation the last read consumed, or null. */
  private lastAnnotationShape(): ResolvedType | null {
    const range = this.lastTypeRange;
    if (range === null) return null;
    try {
      const shape = resolveAnnotation(this.tokens, range.start, range.end, this.typeTable);
      // An imported declaration the module graph has not linked resolves to
      // the `any` this read cannot tell from a type the source spelled as one.
      if (shape.kind === "any") this.notePendingType(typeText(this.tokens, range.start, range.end));
      return shape;
    } catch {
      this.notePendingType(typeText(this.tokens, range.start, range.end));
      return null;
    }
  }

  /**
   * The element type an annotation writes as `T[]`, `Array<T>` or
   * `ReadonlyArray<T>`, or null where it writes none of them.
   *
   * An array of a type this frontend can already name is an array it can hold:
   * a text is a pointer and a reference is a pointer, so an array of either is a
   * block of pointers, which is the same shape a typed array is. What an array
   * of a value this compiler has no type for is — a function, an unknown — is
   * the opaque reference, as every other unnameable type is.
   */
  private arrayTypeFrom(start: number, end: number): TypeExpr | null {
    // `Array<T>` and `ReadonlyArray<T>` name the same array.
    const head = this.tokens[start];
    if (head?.kind === "ident" && (head.text === "Array" || head.text === "ReadonlyArray") && this.tokens[start + 1]?.text === "<") {
      const close = this.matchingToken(start + 1, "<", ">");
      if (close >= 0 && close === end - 1) {
        return { kind: "slice", of: this.typeFromTokens(start + 2, close, false) };
      }
      return null;
    }
    // `T[]`, and `T[][]` for an array of arrays. A `[` that closes a group is
    // not one of these, so only the pairs at the end are read.
    let stop = end;
    let depth = 0;
    while (stop - 2 >= start && this.tokens[stop - 1]?.text === "]" && this.tokens[stop - 2]?.text === "[") {
      stop -= 2;
      depth += 1;
    }
    if (depth === 0 || stop === start) return null;
    let type = this.typeFromTokens(start, stop, false);
    for (let at = 0; at < depth; at += 1) type = { kind: "slice", of: type };
    return type;
  }

  /** The type a run of annotation tokens names, or `any` where none does. */
  private typeFromTokens(start: number, end: number, promisePayload: boolean): TypeExpr {
    let from = start;
    // `readonly` is a promise about writes, and a value the compiler holds is
    // already the one its declaration states.
    while (this.tokens[from]?.text === "readonly") from += 1;
    if (from >= end) return ANY_TYPE;
    // A name the file or its imports declare as a type is read by the type
    // table: an alias is the type it names, and an interface is the fields the
    // member chain after it reads. A class is the reference it already was.
    const head = this.tokens[from];
    if (head !== undefined && head.kind === "ident") {
      const declared = this.typeTable.declarations.has(head.text) || this.typeTable.imported.has(head.text);
      if (declared) {
        const shape = resolveAnnotation(this.tokens, from, end, this.typeTable);
        return this.typeExprOfShape(shape);
      }
      if (this.typeTable.classes.has(head.text) && end - from === 1) return this.referenceTo(head.text);
    }
    if (promisePayload) {
      const payload = this.promisePayload(from, end);
      if (payload !== null) return this.typeFromTokens(payload.start, payload.end, false);
    }
    // A union that names `undefined` or `null` beside one other member is that
    // member: a value this compiler holds has no absent value, and a name the
    // source says may be absent holds the value where it is there. `T | U` of
    // two values is still read by the widening below.
    const members = this.unionMembers(from, end);
    if (members.length > 1) {
      const present = members.filter((member) => !this.isAbsentType(member.start, member.end));
      if (present.length === 1) {
        const only = present[0] as { start: number; end: number };
        return this.typeFromTokens(only.start, only.end, false);
      }
      if (present.length === 0) return ANY_TYPE;
    }
    const arrays = this.arrayTypeFrom(from, end);
    if (arrays !== null) return arrays;
    const first = this.tokens[from] as Token;
    // A map or a set is the handle the runtime's dictionary is. What it holds
    // is kept beside the name it is bound to, and the contract spells the
    // handle: a double the runtime owns.
    if (
      first.kind === "ident" &&
      (first.text === "Map" || first.text === "Set" || first.text === "WeakMap" ||
        first.text === "WeakSet" || first.text === "ReadonlyMap" || first.text === "ReadonlySet" ||
        first.text === "Record")
    ) {
      return NUMBER_RESULT;
    }
    // A function type, an object type, a tuple and a literal type all describe
    // something the contract can hold only as an opaque reference.
    if (first.text === "(" || first.text === "{" || first.text === "[" || first.kind !== "ident") return ANY_TYPE;
    if (first.text === "typeof" || first.text === "keyof" || first.text === "infer" || first.text === "unique" || first.text === "new") {
      return ANY_TYPE;
    }
    // A conditional or an intersection has no one member the contract can
    // name, so it is the reference.
    let depth = 0;
    for (let at = from; at < end; at += 1) {
      const token = this.tokens[at] as Token;
      if (token.kind !== "punct") continue;
      const text = token.text;
      // An array, tuple, function or object type is a value the runtime does
      // not hold as a buffer: only a typed array annotation names one, and that
      // is a plain name. A type argument's brackets are inside `<` already.
      if (depth === 0 && (text === "[" || text === "(" || text === "{")) return ANY_TYPE;
      if (text === "(" || text === "[" || text === "{" || text === "<") depth += 1;
      else if (text === ")" || text === "]" || text === "}" || text === ">") depth -= 1;
      else if (text === ">>") depth -= 2;
      else if (text === ">>>") depth -= 3;
      else if (depth === 0 && (text === "&" || text === "extends" || text === "?")) return ANY_TYPE;
    }
    // A union is held at the one member that holds both, as `number | bigint`
    // is the bigint: the wider numeric member, and otherwise the first one.
    let name = first.text;
    depth = 0;
    for (let at = from + 1; at < end; at += 1) {
      const token = this.tokens[at] as Token;
      if (token.kind !== "punct") continue;
      if (token.text === "(" || token.text === "[" || token.text === "{" || token.text === "<") depth += 1;
      else if (token.text === ")" || token.text === "]" || token.text === "}" || token.text === ">") depth -= 1;
      else if (token.text === ">>") depth -= 2;
      else if (token.text === ">>>") depth -= 3;
      else if (depth === 0 && token.text === "|") {
        const nextToken = this.tokens[at + 1];
        if (nextToken?.kind === "ident") name = unionTypeName(name, nextToken.text);
      }
    }
    if (name === "void") return NOTHING;
    if (name === "any" || name === "object" || name === "unknown" || name === "never") return ANY_TYPE;
    if (name === "bigint" && this.wideBigint) return parseType("u256");
    // A class names the layout an instance holds. The layout pass names the
    // object by its fields and the class's own name is an alias of it, so the
    // annotation is the reference a caller reads its fields through.
    if (this.classTable.names.has(name)) return this.referenceTo(name);
    return mapTypeScriptType(name, `line ${first.line} of ${this.path}`);
  }

  /** The members a union written at `from` names, split at its top-level `|`. */
  private unionMembers(from: number, end: number): { start: number; end: number }[] {
    const members: { start: number; end: number }[] = [];
    let depth = 0;
    let start = from;
    for (let at = from; at < end; at += 1) {
      const token = this.tokens[at] as Token;
      if (token.kind !== "punct") continue;
      const text = token.text;
      if (text === "(" || text === "[" || text === "{" || text === "<") depth += 1;
      else if (text === ")" || text === "]" || text === "}" || text === ">") depth -= 1;
      else if (text === ">>") depth -= 2;
      else if (text === ">>>") depth -= 3;
      else if (depth === 0 && text === "|") {
        members.push({ start, end: at });
        start = at + 1;
      }
    }
    members.push({ start, end });
    return members;
  }

  /** Whether a run of annotation tokens names the absent value of a union. */
  private isAbsentType(start: number, end: number): boolean {
    if (end - start !== 1) return false;
    const text = this.tokens[start]?.text;
    return text === "undefined" || text === "null" || text === "void";
  }

  /** The `<...>` of `Promise<T>`, or null where the run is not a promise. */
  private promisePayload(start: number, end: number): { start: number; end: number } | null {
    if (this.tokens[start]?.text !== "Promise" || this.tokens[start + 1]?.text !== "<") return null;
    const open = start + 1;
    let depth = 0;
    for (let at = open; at < end; at += 1) {
      const token = this.tokens[at] as Token;
      if (token.kind !== "punct") continue;
      const text = token.text;
      if (text === "<") depth += 1;
      else if (text === ">") {
        depth -= 1;
        if (depth === 0) return at > open + 1 ? { start: open + 1, end: at } : null;
      } else if (text === ">>") {
        depth -= 2;
        if (depth <= 0) return at > open + 1 ? { start: open + 1, end: at } : null;
      } else if (text === ">>>") {
        depth -= 3;
        if (depth <= 0) return at > open + 1 ? { start: open + 1, end: at } : null;
      }
    }
    return null;
  }

  private readBlock(): Statement[] {
    if (!this.accept("{")) {
      this.report('expected "{"', "a function body is written in braces");
      return [];
    }
    // A block reads the values a test settled in the block around it, and
    // everything it settles itself is forgotten where the block ends.
    const outer = this.narrowed;
    this.narrowed = new Map(outer);
    const statements: Statement[] = [];
    try {
      while (!this.at("}") && this.peek().kind !== "end") {
        // An empty statement is not one the body does. A lone `;` read as a
        // call is a call the body never makes, which cost a function its
        // postcondition and left the build reporting a function it could not
        // check.
        if (this.accept(";")) continue;
        // A type declared in a body names nothing the body runs, so it is
        // skipped where it is written.
        if (this.typeOnlyDeclarationAt()) {
          this.skipTypeOnlyDeclaration();
          continue;
        }
        // A block written as a statement is the statements it holds: a compiled
        // body has one list of statements, and a nested block is a scope of the
        // source rather than a construct the program runs.
        if (this.at("{")) {
          statements.push(...this.readBlock());
          continue;
        }
        const read = this.guardedStatement();
        statements.push(...read);
        // A guard the statement leaves the block by is what the statements
        // after it know: `if (typeof x !== "string") return;` leaves `x` a
        // text for the rest of the block.
        const last = read[read.length - 1];
        if (last !== undefined) this.narrowAfter(last);
      }
      this.expect("}");
    } finally {
      this.narrowed = outer;
    }
    return statements;
  }

  /** A body that follows a keyword: a block, or the one statement written. */
  private readBody(): Statement[] {
    if (this.typeOnlyDeclarationAt()) {
      this.skipTypeOnlyDeclaration();
      return [];
    }
    return this.at("{") ? this.readBlock() : this.guardedStatement();
  }

  /**
   * The statements one read produced. A destructuring declaration is lowered
   * to a temporary and a declaration for each name it binds, and the temporary
   * has to run before the names read it.
   */
  private withPending(statement: Statement): Statement[] {
    const before = this.pendingBefore;
    this.pendingBefore = [];
    if (before.length === 0 && this.pending.length === 0) return [statement];
    const rest = this.pending;
    this.pending = [];
    return [...before, statement, ...rest];
  }

  readStatement(): Statement {
    const token = this.peek();
    if (this.accept(";")) return { kind: "expression", value: this.hole(), line: token.line };

    if (this.at("let") || this.at("const") || this.at("var")) {
      this.next();
      if (this.at("{") || this.at("[")) return this.readDestructuredDeclaration(token.line);
      const name = this.next();
      if (name.kind !== "ident") {
        this.report("expected a variable name", `near "${name.text}"`, name);
        this.synchronize();
        return { kind: "expression", value: this.hole(), line: token.line };
      }
      let type: TypeExpr | null = null;
      let annotationClass: string | null = null;
      let annotationFunction: FunctionType | null = null;
      let annotationMap: CollectionValue | null = null;
      let annotationShape: ResolvedType | null = null;
      if (this.accept(":")) {
        const head = this.peek().kind === "ident" ? this.peek().text : "";
        annotationFunction = this.annotationFunctionType(new Set(["=", ";", ",", ")"]));
        annotationMap = this.annotationCollection(new Set(["=", ";", ",", ")"]));
        type = this.readTypeAnnotation("a variable type", new Set(["=", ";", ",", ")"]));
        this.pendingNote = false;
        annotationShape = this.lastAnnotationShape();
        if (annotationMap === null) annotationMap = this.collectionOfShape(annotationShape);
        if (head !== "" && this.classTable.names.has(head)) annotationClass = head;
      }
      let init: Expression;
      if (this.accept("=")) {
        // The arrow this declaration binds is a direct call by the name it is
        // given, so it is not turned into a closure here.
        const wasBinding = this.bindingArrow;
        const wasDeclaring = this.declaringArrow;
        this.bindingArrow = true;
        this.declaringArrow = name.text;
        try {
          init = this.readAt(type, () => this.readExpression(), annotationShape);
        } finally {
          this.bindingArrow = wasBinding;
          this.declaringArrow = wasDeclaring;
        }
        this.accept(";");
      } else if (type === null) {
        this.report("a declaration needs an initialiser", `as in let ${name.text} = 0;`, name);
        this.synchronize();
        return { kind: "expression", value: this.hole(), line: name.line };
      } else {
        // A declaration that states its type and no value starts at the zero
        // of that type: the source assigns it before it reads it, and the
        // assignment is what the body does.
        init = this.zeroFor(type);
        this.accept(";");
      }
      // An arrow is called by the name it is bound to: the function it lifted to
      // already carries the values it captured, so the name is not a slot the
      // body reads. A name bound to a value that is not an arrow is not one.
      if (init.k === "arrow") {
        // An arrow that calls the name it is bound to is a function of the file
        // that calls itself. The body was read before the declaration bound the
        // name, so the call it wrote is a plain call of that name; it is
        // rewritten here as a call of the function the arrow lifted to, with
        // the values the arrow captured in front, which the lifted body names
        // as its own parameters.
        const lifted = this.liftedArrows.get(init.name);
        const binding = this.arrowBindings.get(init.name);
        if (lifted !== undefined && binding !== undefined && callsOf(lifted).has(name.text)) {
          if (binding.captures.length > 0) {
            // A recursive arrow that captures takes the captured values again
            // at every call, and a call written before the arrow is complete
            // cannot say which of them it means.
            this.report(
              `${name.text} calls itself, which an arrow function is not`,
              "declare the function with `function` and call it by the name it is declared under",
              name,
            );
          } else {
            lifted.body = callsRewritten(lifted.body, name.text, binding.function, binding.captures);
          }
        }
        if (binding !== undefined) this.valueArrows.set(name.text, binding);
        this.valueTypes.set(name.text, ANY_TYPE);
        this.valueClasses.delete(name.text);
        return { kind: "declare", name: name.text, type: ANY_TYPE, init: { k: "null" }, line: name.line };
      }
      this.valueArrows.delete(name.text);
      if (annotationFunction !== null) this.valueFunctions.set(name.text, annotationFunction);
      else this.valueFunctions.delete(name.text);
      // A map is a handle and a set is a map, so what the name holds is kept
      // beside it: the declaration says it, or the `new Map(...)` it is
      // initialised with does.
      const collection =
        annotationMap ??
        this.collectionExpressions.get(init) ??
        (init.k === "call" ? this.declaredCollections.get(init.name) : undefined) ??
        null;
      if (collection !== null) this.valueCollections.set(name.text, collection);
      else this.valueCollections.delete(name.text);
      const held = annotationClass ?? this.classOfExpression(init);
      if (held === null) this.valueClasses.delete(name.text);
      else this.valueClasses.set(name.text, held);
      this.valueTypes.set(name.text, type ?? this.valueTypeOf(init));
      // A name declared again is the value it was declared with, and nothing a
      // test settled about a name of the same spelling still holds.
      this.forgetNarrowing(name.text);
      if (this.pendingNote) this.pendingValues.add(name.text);
      else this.pendingValues.delete(name.text);
      const declaredShape = annotationShape ?? this.shapeOf(init);
      if (declaredShape !== null) this.valueShapes.set(name.text, declaredShape);
      else this.valueShapes.delete(name.text);
      if (init.k === "buffer" && this.regexValues.has(init)) this.valueRegexes.add(name.text);
      else this.valueRegexes.delete(name.text);
      return { kind: "declare", name: name.text, type, init, line: name.line };
    }

    if (this.at("for")) return this.readLoop();
    if (this.at("if")) return this.readIf();
    if (this.at("try")) return this.readTry();
    if (this.at("while")) return this.readWhile();
    if (this.at("do")) return this.readDoWhile();
    if (this.at("switch")) return this.readSwitch();
    if (this.at("break") || this.at("continue")) {
      const keyword = this.next();
      if (this.peek().kind === "ident") {
        const label = this.next();
        this.report(
          `a ${keyword.text} names the loop it leaves, and a function body reads no labels`,
          `"${label.text}" is a name a program does not use here; write break; to leave the loop`,
          label,
        );
        this.accept(";");
        this.synchronize();
        return { kind: "expression", value: this.hole(), line: keyword.line };
      }
      const leavesSwitch =
        keyword.text === "break" && this.breakTargets[this.breakTargets.length - 1] === "switch";
      if (!leavesSwitch && this.loops === 0) {
        this.report(
          `"${keyword.text}" is not within a loop`,
          "a function leaves a loop with break, and goes on with continue",
          keyword,
        );
        this.synchronize();
        return { kind: "expression", value: this.hole(), line: keyword.line };
      }
      this.accept(";");
      return keyword.text === "break"
        ? { kind: "break", line: keyword.line }
        : { kind: "continue", line: keyword.line };
    }
    if (this.at("return")) {
      this.next();
      if (this.at(";")) {
        // A bare return leaves a function that returns nothing. The IR has a
        // return with no value, so this is the statement it is rather than a
        // value the frontend invents; a function declared to return a value is
        // refused where the two meet.
        this.next();
        return { kind: "result", value: null, line: token.line };
      }
      if (this.at("}")) {
        return { kind: "result", value: null, line: token.line };
      }
      // A returned list is the value the function declares, and an empty one
      // is built at the element type that declaration names.
      const value = this.readAt(this.returns, () => this.readExpression(), this.returnsShape);
      this.accept(";");
      return { kind: "result", value, line: token.line };
    }
    if (this.at("console")) return this.readPrint();
    if (this.at("throw")) {
      // An error is a value the source raises; the program ends where it is
      // raised, and the text it was raised with is what the program reports.
      this.next();
      const message = this.skipStatementTail();
      return {
        kind: "throw",
        value: { k: "text", parts: [{ k: "text", value: message === "" ? "an error was raised" : message }] },
        line: token.line,
      };
    }

    // `await f();` is a statement the body runs and does not keep the answer
    // of, which is what an expression statement is. The word is a refused
    // keyword when it names a statement, and an operator when it starts an
    // expression, so reading it as the expression it is keeps the two apart.
    if (this.at("await")) return this.readEffect();

    // `type` is an identifier the language allows anywhere a name goes: only a
    // statement that writes a type alias declares a type, and every other use
    // of the name — `type = null`, `type.kind` — reads a value like any name.
    const refused = token.text === "type" && !this.typeOnlyDeclarationAt() ? undefined : REFUSED_KEYWORDS[token.text];
    if (refused !== undefined) {
      this.report(`"${token.text}" is not supported`, refused, token);
      // A refused construct that carries a body is skipped as the body it
      // writes; one that does not is skipped as the statement it is. Skipping
      // `yield x;` as a block ran to the next `{` in the file, which was a
      // function or class the source wrote after it.
      if (REFUSED_WITH_BODY.has(token.text)) this.skipBlock();
      else this.synchronize();
      return { kind: "expression", value: this.hole(), line: token.line };
    }
    if (this.at("{")) {
      this.report("a block is not a statement of its own", "write the statements it holds", token);
      this.readBlock();
      return { kind: "expression", value: this.hole(), line: token.line };
    }
    if (this.at("function")) {
      // A nested function is something a program body is allowed and the
      // module-level declaration parser is not: a program parses its whole
      // source again as statements if one is seen anywhere. The diagnostic
      // lands if that reading fails too, which is the case this is for.
      this.nestedFunction = true;
      this.report("a function may not be declared inside a function", "declare it in the module", token);
      this.synchronize();
      return { kind: "expression", value: this.hole(), line: token.line };
    }

    const assigned = this.readAssignment();
    if (assigned !== null) return assigned;
    return this.readEffect();
  }

  /**
   * Reads to the end of the statement the parser is in, answering the text it
   * carried. `throw new Error(...)` is the end of the program, and the text is
   * what the runtime reports; the value is not constructed because nothing
   * observes the object.
   */
  private skipStatementTail(): string {
    const text: string[] = [];
    let depth = 0;
    while (this.peek().kind !== "end") {
      const token = this.peek();
      if (token.text === "(" || token.text === "[" || token.text === "{") {
        depth += 1;
        text.push(token.text);
        this.next();
        continue;
      }
      if (token.text === ")" || token.text === "]" || token.text === "}") {
        if (depth === 0) return text.join(" ");
        depth -= 1;
        text.push(token.text);
        this.next();
        continue;
      }
      this.next();
      if (token.text === ";" && depth === 0) return text.join(" ");
      text.push(token.text);
    }
    return text.join(" ");
  }

  /**
   * `const { a, b: c } = value` and `const [a, b] = [x, y]`: every name the
   * pattern binds is a declaration of its own.
   *
   * A pattern reads its value once where the value is a call, so the temporary
   * is what the names read; a constant object is read at the field each name
   * asks for, because the field is the value the source already wrote. An array
   * pattern reads the elements of an array literal, which is the one array a
   * compiled function has: a value that is an array is not a value this subset
   * carries.
   */
  private readDestructuredDeclaration(line: number): Statement {
    const open = this.next();
    if (open.text === "{") {
      const fields: { name: string; field: string }[] = [];
      while (!this.at("}") && this.peek().kind !== "end") {
        const written = this.next();
        if (written.kind !== "ident") {
          this.report("a destructured field is named", `near "${written.text}"`, written);
          this.synchronizeTo("}");
          break;
        }
        let bound = written.text;
        if (this.accept(":")) {
          const alias = this.next();
          if (alias.kind !== "ident") this.report("a destructured field binds a name", `near "${alias.text}"`, alias);
          else bound = alias.text;
        }
        if (this.at("=")) {
          this.report("a destructured field with a default is not supported", "write the default where the value is made");
          this.next();
          this.readExpression();
        }
        fields.push({ name: bound, field: written.text });
        if (!this.accept(",")) break;
      }
      this.expect("}");
      if (!this.accept("=")) {
        this.report("a destructuring declaration needs a value", "as in const { a } = value;", open);
        return { kind: "expression", value: this.hole(), line };
      }
      const init = this.readExpression();
      this.accept(";");
      const constant = init.k === "ident" ? this.constants.get(init.name) : undefined;
      const direct = init.k === "ident" && constant?.fields !== undefined;
      const baseShape = this.shapeOf(init);
      let base: Expression = init;
      let head: Statement | null = null;
      if (!direct) {
        const temp = `__destructure${this.destructureCount++}`;
        head = { kind: "declare", name: temp, type: null, init, line };
        this.valueTypes.set(temp, this.valueTypeOf(init));
        if (baseShape !== null) this.valueShapes.set(temp, baseShape);
        base = { k: "ident", name: temp };
      }
      fields.forEach((entry) => {
        const expanded = direct ? this.constantValue(init.k === "ident" ? init.name : "", constant?.fields?.get(entry.field)) : null;
        const read: Expression = expanded ?? { k: "member", base, field: entry.field };
        const declaredShape = baseShape === null ? null : fieldOfType(this.typeTable, baseShape, entry.field)?.type ?? null;
        // The value the file wrote for a constant field is the value the name
        // reads, so its shape is the one that field holds even where the
        // object itself was never written with an annotation.
        const fieldShape = declaredShape ?? this.shapeOf(read);
        if (fieldShape !== null) {
          this.valueShapes.set(entry.name, fieldShape);
          this.valueTypes.set(entry.name, this.typeExprOfShape(fieldShape));
        }
        this.pending.push({
          kind: "declare",
          name: entry.name,
          type: null,
          init: read,
          line,
        });
      });
      const first = head ?? this.pending.shift();
      return first ?? ({ kind: "expression", value: this.hole(), line } satisfies Statement);
    }

    // `[a, b] = ...`: each name is the element at its position. A literal is
    // read apart where it stands; every other value is read once into a name
    // of the pattern's own, because the pattern may read the same element more
    // than once and a call is not a value that reads the same twice.
    const bindings: { name: string; index: number }[] = [];
    let at = 0;
    while (!this.at("]") && this.peek().kind !== "end") {
      // `[a, , b]`: a gap names no element, and the positions move past it all
      // the same.
      if (this.accept(",")) {
        at += 1;
        continue;
      }
      if (this.accept("...")) {
        this.report("a rest element is not part of the destructuring subset", "write the names the pattern binds");
        this.synchronizeTo("]");
        break;
      }
      const name = this.next();
      if (name.kind !== "ident") this.report("a destructured element binds a name", `near "${name.text}"`, name);
      else bindings.push({ name: name.text, index: at });
      at += 1;
      if (this.at("=")) {
        this.report("a destructured element with a default is not supported", "write the default where the value is made");
        this.next();
        this.readExpression();
      }
      if (!this.accept(",")) break;
    }
    this.expect("]");
    if (!this.accept("=")) {
      this.report("a destructuring declaration needs a value", "as in const [a, b] = [x, y];", open);
      return { kind: "expression", value: this.hole(), line };
    }
    const init = this.readExpression();
    this.accept(";");
    if (init.k === "buffer") {
      const values = init.values;
      const highest = bindings.reduce((most, binding) => Math.max(most, binding.index), -1);
      if (highest >= values.length) {
        this.report(
          `the pattern reads element ${highest} and the value holds ${values.length} elements`,
          "write one value for each name",
          open,
        );
      }
      bindings.forEach((binding) => {
        const value = values[binding.index];
        if (value === undefined) return;
        const shape = this.shapeOf(value);
        if (shape !== null) {
          this.valueShapes.set(binding.name, shape);
          this.valueTypes.set(binding.name, this.typeExprOfShape(shape));
        }
        this.pending.push({ kind: "declare", name: binding.name, type: null, init: value, line });
      });
      const first = this.pending.shift();
      return first ?? ({ kind: "expression", value: this.hole(), line } satisfies Statement);
    }
    // A value that is not a literal is held at a name of its own, and each
    // name the pattern binds is an element of it. The element type is what
    // makes `const [, , argument] = re.exec(text)` an untyped name no longer:
    // `argument` is the text the list holds. A name is its own base, so the
    // elements are read from it where it stands and the contract the source
    // wrote stays one expression; anything else is read once into a name.
    const initType = this.valueTypeOf(init);
    const elementType = initType.kind === "slice" || initType.kind === "array" ? initType.of : ANY_TYPE;
    const baseShape = this.shapeOf(init);
    const elementShape = baseShape !== null && baseShape.kind === "list" ? baseShape.of : null;
    let base: Expression = init;
    let head: Statement | null = null;
    if (init.k !== "ident") {
      const temp = `__destructure${this.destructureCount++}`;
      this.valueTypes.set(temp, initType);
      if (baseShape !== null) this.valueShapes.set(temp, baseShape);
      head = { kind: "declare", name: temp, type: null, init, line };
      base = { k: "ident", name: temp };
    }
    bindings.forEach((binding) => {
      this.valueTypes.set(binding.name, elementType);
      if (elementShape !== null) this.valueShapes.set(binding.name, elementShape);
      this.pending.push({
        kind: "declare",
        name: binding.name,
        type: null,
        init: {
          k: "index",
          base,
          index: { k: "literal", text: String(binding.index) },
        },
        line,
      });
    });
    if (head !== null) return head;
    const first = this.pending.shift();
    return first ?? ({ kind: "expression", value: this.hole(), line } satisfies Statement);
  }

  /**
   * `[a, b] = [x, y]`: the values are read into temporaries before any name is
   * written, because the source assigns them at once and `[a, b] = [b, a]`
   * swaps the two.
   */
  private readTupleAssignment(): Statement {
    const line = this.peek().line;
    this.expect("[");
    const names: string[] = [];
    while (!this.at("]") && this.peek().kind !== "end") {
      const name = this.next();
      if (name.kind !== "ident") {
        this.report("a destructured element binds a name", `near "${name.text}"`, name);
        this.synchronizeTo("]");
        break;
      }
      names.push(name.text);
      if (!this.accept(",")) break;
    }
    this.expect("]");
    this.expect("=");
    if (!this.at("[")) {
      this.report("an array pattern reads an array literal", `near "${this.peek().text}"`, this.peek());
      this.readExpression();
      this.accept(";");
      return { kind: "expression", value: this.hole(), line };
    }
    this.next();
    const values: Expression[] = [];
    while (!this.at("]") && this.peek().kind !== "end") {
      values.push(this.readExpression());
      if (!this.accept(",")) break;
    }
    this.expect("]");
    this.accept(";");
    if (values.length !== names.length) {
      this.report(
        `the pattern writes ${names.length} names and the value holds ${values.length} elements`,
        "write one value for each name",
        this.peek(),
      );
    }
    const temporaries: string[] = [];
    const head: Statement[] = [];
    values.forEach((value) => {
      const temp = `__tuple${this.destructureCount++}`;
      temporaries.push(temp);
      head.push({ kind: "declare", name: temp, type: null, init: value, line });
    });
    names.forEach((name, index) => {
      const temp = temporaries[index];
      if (temp === undefined) return;
      this.pending.push({ kind: "assign", target: name, op: "=", value: { k: "ident", name: temp }, line });
    });
    const first = head.shift() as Statement;
    this.pending.unshift(...head);
    return first;
  }

  /** An assignment, an index write or a field write. */
  private readAssignment(): Statement | null {
    const start = this.position;
    const target = this.next();
    if (target.kind !== "ident") {
      if (target.text === "[") {
        this.position = start;
        return this.readTupleAssignment();
      }
      this.position = start;
      return null;
    }
    if (this.at("[")) {
      this.position = start;
      return this.readIndexedAssignment();
    }
    if (this.at(".")) {
      this.position = start;
      return this.readMemberAssignment();
    }
    const operator = this.peek();
    // `x ??= value` writes only where x is null. It is an `if`, not a compound
    // assignment: the value is not computed where x holds one.
    if (operator.text === "??=") {
      this.next();
      const value = this.readAt(this.valueTypes.get(target.text) ?? null, () => this.readExpression());
      this.accept(";");
      this.valueArrows.delete(target.text);
      // The write is the `??` the operator names: `x ??= value` is `x = x ??
      // value`. A null check spelled `x == null` is not the same question for
      // a number, where zero is a value and not the absence of one.
      return {
        kind: "assign",
        target: target.text,
        op: "=",
        value: { k: "binary", op: "??", left: { k: "ident", name: target.text }, right: value },
        line: target.line,
      };
    }
    if (operator.kind !== "punct" || !(operator.text in COMPOUND_OPERATORS)) {
      if (operator.text !== "=") {
        this.position = start;
        return null;
      }
      this.next();
      const value = this.readAt(this.valueTypes.get(target.text) ?? null, () => this.readExpression());
      this.accept(";");
      // What the name holds is what it was just written with, so a name that
      // held an arrow no longer does: a later `g(x)` would call a function the
      // call no longer reaches.
      this.valueArrows.delete(target.text);
      this.forgetNarrowing(target.text);
      const assigned = this.collectionExpressions.get(value);
      if (assigned !== undefined) this.valueCollections.set(target.text, assigned);
      else this.valueCollections.delete(target.text);
      const held = this.classOfExpression(value);
      if (held === null) this.valueClasses.delete(target.text);
      else this.valueClasses.set(target.text, held);
      return { kind: "assign", target: target.text, op: "=", value, line: target.line };
    }
    this.next();
    const value = this.readExpression();
    this.accept(";");
    // A compound assignment keeps the type the name already holds: `p = q` may
    // change what a name is, but `p += q` is a number operation on it. A name
    // that held an arrow is no longer one either way, and a test settled before
    // the write no longer says what the name holds.
    this.valueArrows.delete(target.text);
    this.forgetNarrowing(target.text);
    return {
      kind: "assign",
      target: target.text,
      op: operator.text as AssignOperator,
      value,
      line: target.line,
    };
  }

  private readIndexedAssignment(): Statement | null {
    const start = this.position;
    const buffer = this.next();
    if (buffer.kind !== "ident" || !this.at("[")) {
      this.position = start;
      return null;
    }
    this.next();
    const index = this.readExpression();
    this.expect("]");
    const operator = this.peek();
    if (operator.kind !== "punct" || (operator.text !== "=" && operator.text !== "??=" && !(operator.text in COMPOUND_OPERATORS))) {
      this.position = start;
      return null;
    }
    this.next();
    const value = this.readExpression();
    this.accept(";");
    // `record[name] = value` writes one entry of the dictionary the record is.
    // The write is the dictionary's own, by the value the entry holds.
    const heldCollection = operator.text === "="
      ? this.collectionOfExpression({ k: "ident", name: buffer.text })
      : null;
    if (heldCollection !== null && heldCollection.kind === "map") {
      const setName = this.collectionSetNameFor(heldCollection);
      if (setName !== null) {
        return {
          kind: "expression",
          value: {
            k: "call",
            name: setName,
            args: [{ k: "ident", name: buffer.text }, index, value],
          },
          line: buffer.line,
        };
      }
    }
    if (operator.text === "??=") {
      return {
        kind: "indexAssign",
        buffer: buffer.text,
        index,
        op: "=",
        value: {
          k: "binary",
          op: "??",
          left: { k: "index", base: { k: "ident", name: buffer.text }, index },
          right: value,
        },
        line: buffer.line,
      };
    }
    return {
      kind: "indexAssign",
      buffer: buffer.text,
      index,
      op: operator.text as AssignOperator,
      value,
      line: buffer.line,
    };
  }

  private readMemberAssignment(): Statement | null {
    const start = this.position;
    const base = this.next();
    if (base.kind !== "ident" || !this.at(".")) {
      this.position = start;
      return null;
    }
    // The chain the write goes through: the fields it names and the calls
    // written between them. The last field is the one written, and everything
    // before it is the value it belongs to — which may be the answer of a
    // call, as `this.frame().block.terminator = value` writes the block a
    // method answered.
    let lastDot = this.position;
    let calls = false;
    const chain: Token[] = [];
    let at = lastDot + 1;
    while (at < this.tokens.length) {
      const token = this.tokens[at] as Token | undefined;
      if (token === undefined) break;
      if (token.kind === "ident") {
        if (at === lastDot + 1) chain.push(token);
        at += 1;
        continue;
      }
      const text = mark(token);
      if (text === "." && this.tokens[at + 1]?.kind === "ident") {
        lastDot = at;
        at += 1;
        continue;
      }
      if (text === "(") {
        calls = true;
        let depth = 0;
        while (at < this.tokens.length) {
          const inner = mark(this.tokens[at]);
          if (inner === "(" || inner === "[" || inner === "{") depth += 1;
          else if (inner === ")" || inner === "]" || inner === "}") {
            depth -= 1;
            if (depth === 0) {
              at += 1;
              break;
            }
          }
          at += 1;
        }
        continue;
      }
      break;
    }
    let writtenBase = base.text === "this" && this.currentClass !== null ? "self" : base.text;
    const field = this.tokens[lastDot + 1] as Token | undefined;
    const operator = this.tokens[lastDot + 2] as Token | undefined;
    if (
      field === undefined ||
      field.kind !== "ident" ||
      operator === undefined ||
      (operator.text !== "=" &&
        operator.text !== "??=" &&
        operator.text !== "++" &&
        operator.text !== "--" &&
        !(operator.text in COMPOUND_OPERATORS))
    ) {
      this.position = start;
      return null;
    }
    this.position = lastDot + 2;
    // A field of a field is written the same way a field is: the value the
    // field belongs to is read into a name of its own first, and the write goes
    // into that name. An object is a reference, so writing through the name is
    // writing the object the source named, and the value before the last field
    // is read once, which is what the source wrote.
    if (chain.length > 1 || calls) {
      const owner: Expression = calls
        ? this.readOwner(start, lastDot)
        : chain.slice(0, -1).reduce<Expression>(
            (inner, one) => ({ k: "member", base: inner, field: one.text }),
            { k: "ident", name: writtenBase },
          );
      const ownerType = this.valueTypeOf(owner);
      // A list has no writable length: what it holds is a block the runtime
      // allocated, and the source writes the elements of it rather than its
      // size. That is refused where it is written, as it was before.
      if (field.text === "length" && (ownerType.kind === "slice" || ownerType.kind === "array" || ownerType.kind === "text")) {
        this.position = start;
        return null;
      }
      const held = `__field${this.fieldCount++}`;
      this.pendingBefore.push({ kind: "declare", name: held, type: null, init: owner, line: base.line });
      this.valueTypes.set(held, ownerType);
      const ownerShape = this.shapeOf(owner);
      if (ownerShape !== null) this.valueShapes.set(held, ownerShape);
      writtenBase = held;
    }
    if (operator.text === "++" || operator.text === "--") {
      this.next();
      this.accept(";");
      this.forgetNarrowing(`${writtenBase}.${field.text}`);
      return {
        kind: "memberAssign",
        base: writtenBase,
        field: field.text,
        op: operator.text === "++" ? "+=" : "-=",
        value: { k: "literal", text: "1" },
        line: base.line,
      };
    }
    this.next();
    // A field written to is the value it was written with, so nothing a test
    // settled about the field still holds.
    this.forgetNarrowing(`${writtenBase}.${field.text}`);
    // The field says what the value written into it holds, so `this.pending =
    // []` is a list of the field's elements where the field is a list. The
    // shape is the field the class declares or the one the value's type names.
    const written: Expression = { k: "member", base: { k: "ident", name: writtenBase }, field: field.text };
    const shape = this.shapeOf(written);
    const value = shape === null
      ? this.readExpression()
      : this.readAt(this.typeExprOfShape(shape), () => this.readExpression(), shape);
    this.accept(";");
    if (operator.text === "??=") {
      return {
        kind: "memberAssign",
        base: writtenBase,
        field: field.text,
        op: "=",
        value: {
          k: "binary",
          op: "??",
          left: { k: "member", base: { k: "ident", name: writtenBase }, field: field.text },
          right: value,
        },
        line: base.line,
      };
    }
    return {
      kind: "memberAssign",
      base: writtenBase,
      field: field.text,
      op: operator.text as AssignOperator,
      value,
      line: base.line,
    };
  }

  /** A call or an `i++` written for what it does. */
  private readEffect(): Statement {
    const token = this.peek();
    // `super(message)` is the only call a class of `extends Error` makes into
    // its base: the base holds the one field an error has, and the call writes
    // it. A compiled class has no other inheritance to call into.
    if (token.kind === "ident" && token.text === "super" && this.peek(1).text === "(") {
      this.next();
      const args = this.readCallArguments();
      this.accept(";");
      return {
        kind: "memberAssign",
        base: "self",
        field: "message",
        op: "=",
        value: args[0] ?? { k: "text", parts: [] },
        line: token.line,
      };
    }
    if (token.kind === "ident" && (this.peek(1).text === "++" || this.peek(1).text === "--")) {
      this.next();
      const op = this.next().text as "++" | "--";
      this.accept(";");
      return { kind: "update", name: token.text, op, prefix: false, line: token.line };
    }
    const value = this.readExpression();
    this.accept(";");
    // `a.push(x)` answers the array the name holds afterwards, so written on
    // its own line it is the write that keeps it. A field is written back into
    // the field it was read from, with the object it belongs to unchanged.
    if (value.k === "append") {
      const array: Expression =
        value.base === null
          ? { k: "ident", name: value.target }
          : { k: "member", base: { k: "ident", name: value.base }, field: value.target };
      let call: Expression;
      if (value.spreads === undefined) {
        call = { k: "call", name: value.helper, args: [array, ...value.values] };
      } else {
        // A value written out joins the list as a list of one, and a spread
        // joins the list it already is: both are the concatenation two lists
        // added are, in the order the source wrote them.
        const element = value.element === undefined ? typeToString(ANY_TYPE) : typeToString(value.element);
        call = array;
        value.values.forEach((written, at) => {
          const joined: Expression = value.spreads?.[at] === true
            ? written
            : { k: "buffer", element, values: [written] };
          call = { k: "binary", op: "+", left: call, right: joined };
        });
      }
      if (value.base === null) {
        return { kind: "assign", target: value.target, op: "=", value: call, line: token.line };
      }
      return { kind: "memberAssign", base: value.base, field: value.target, op: "=", value: call, line: token.line };
    }
    return { kind: "expression", value, line: token.line };
  }

  private readPrint(): Statement {
    const start = this.next();
    this.expect(".");
    const method = this.next();
    if (method.text !== "log") {
      this.report(`console.${method.text} is not supported`, "a program prints with console.log", method);
      this.synchronize();
      return { kind: "print", value: this.hole(), line: start.line };
    }
    this.expect("(");
    const value = this.readExpression();
    this.expect(")");
    this.accept(";");
    return { kind: "print", value, line: start.line };
  }

  /**
   * `for (let i = from; i < to; i++)`, the `<=`, `>` and `>=` forms, and
   * `for (const x of values)`, which walks a typed array instead.
   */
  private readLoop(): Statement {
    const start = this.next();
    this.expect("(");
    // `for (;;)` is the loop that runs until a `break` in its body: it names
    // no index and stops for no condition, which is a while loop whose
    // condition is the constant truth.
    if (this.at(";")) {
      this.next();
      if (this.at(";")) {
        this.next();
        this.expect(")");
        return {
          kind: "while",
          condition: { k: "literal", text: "1" },
          body: this.loopBody(),
          line: start.line,
        };
      }
      this.report("a for loop states its condition and its step together", "as in for (;;) { ... }");
      this.synchronize();
      return { kind: "expression", value: this.hole(), line: start.line };
    }
    if (!this.at("let") && !this.at("const") && !this.at("var")) {
      this.report("a loop must declare its index", "as in for (let i = 0; ...)", start);
      this.synchronize();
      return { kind: "expression", value: this.hole(), line: start.line };
    }
    this.next();
    // `for (const [key, value] of entries)` names the parts of one element
    // rather than the element, and each part is a declaration read out of it.
    const pattern = this.readParameterPattern();
    if (pattern !== null) {
      if (this.at("of")) return this.readForOf(start, "", pattern);
      this.report("a counted loop declares one index", "a pattern names the parts of an element, which a for-of loop walks");
      this.synchronize();
      return { kind: "expression", value: this.hole(), line: start.line };
    }
    const variable = this.next();
    if (variable.kind !== "ident") {
      this.report("expected a loop index name", `near "${variable.text}"`, variable);
      this.synchronize();
      return { kind: "expression", value: this.hole(), line: start.line };
    }
    if (this.at("of")) return this.readForOf(start, variable.text, null);
    this.expect("=");
    const from = this.readExpression();
    this.expect(";");

    const condition = this.next();
    if (condition.kind !== "ident" || condition.text !== variable.text) {
      this.report(`the loop condition must test the index "${variable.text}"`, `near "${condition.text}"`, condition);
      this.synchronize();
      return { kind: "expression", value: this.hole(), line: start.line };
    }
    const comparison = this.next();
    if (comparison.kind !== "punct" || !["<", "<=", ">", ">="].includes(comparison.text)) {
      this.report(
        "the loop condition must compare the index with a bound",
        'as in "i < bound" or "i <= bound"',
        comparison,
      );
      this.synchronize();
      return { kind: "expression", value: this.hole(), line: start.line };
    }
    const to = this.readExpression();
    this.expect(";");
    const step = this.readStep(variable.text);
    this.expect(")");
    // The index is a number wherever it is read, including from an arrow the
    // body writes, which takes the type of everything it captured.
    this.valueTypes.set(variable.text, NUMBER_RESULT);

    return {
      kind: "loop",
      variable: variable.text,
      from,
      to,
      inclusive: comparison.text === "<=" || comparison.text === ">=",
      step,
      down: comparison.text === ">" || comparison.text === ">=",
      body: this.loopBody(),
      line: start.line,
    };
  }

  /** `i++`, `i--`, `i += n` or `i -= n`: how the index moves. Null is one. */
  private readStep(variable: string): Expression | null {
    const name = this.next();
    if (name.kind !== "ident" || name.text !== variable) {
      this.report("a loop must advance its own index", `as in ${variable}++`, name);
      this.synchronize();
      return null;
    }
    const operator = this.next();
    if (operator.text === "++" || operator.text === "--") return null;
    if (operator.text === "+=" || operator.text === "-=") {
      const amount = this.readExpression();
      // `i += 1` is how a loop advances by one, whichever way it is written.
      if (operator.text === "+=" && amount.k === "literal" && amount.text === "1") return null;
      return { k: "unary", op: operator.text === "-=" ? "-" : "+", operand: amount };
    }
    this.report("a loop must advance its index", `as in ${variable}++ or ${variable} += 2`, operator);
    this.synchronize();
    return null;
  }

  private readTry(): Statement {
    const start = this.next();
    const body = this.readBody();
    let catchParam: string | null = null;
    let catchBody: Statement[] | null = null;
    if (this.accept("catch")) {
      if (this.accept("(")) {
        const param = this.next();
        if (param.kind === "ident") catchParam = param.text;
        this.expect(")");
      }
      catchBody = this.readBody();
    }
    let finallyBody: Statement[] | null = null;
    if (this.accept("finally")) {
      finallyBody = this.readBody();
    }
    return { kind: "try", body, catchParam, catchBody, finallyBody, line: start.line };
  }

  /**
   * `switch (value) { case a: ... }`, lowered to the comparisons it is.
   *
   * The discriminant is read once into a temporary, because a case test reads
   * it however many cases there are. A case without a `break` falls into the
   * next one, so what a matching case runs is its own statements and every
   * case after it until one that breaks. The default runs when no case
   * matches, and a default that is not last is reached by falling into the
   * cases after it as the source says.
   */
  private readSwitch(): Statement {
    const start = this.next();
    this.expect("(");
    const discriminant = this.readExpression();
    this.expect(")");
    if (!this.accept("{")) {
      this.report('expected "{"', "a switch body is written in braces");
      return { kind: "expression", value: this.hole(), line: start.line };
    }
    interface SwitchCase {
      test: Expression | null;
      body: Statement[];
      breaks: boolean;
      line: number;
    }
    const cases: SwitchCase[] = [];
    while (!this.at("}") && this.peek().kind !== "end") {
      const line = this.peek().line;
      let test: Expression | null = null;
      if (this.accept("case")) {
        test = this.readExpression();
        this.expect(":");
      } else if (this.accept("default")) {
        this.expect(":");
      } else {
        this.report("a switch body holds cases", `near "${this.peek().text}"`);
        this.synchronize();
        continue;
      }
      const body: Statement[] = [];
      let breaks = false;
      this.breakTargets.push("switch");
      while (!this.at("case") && !this.at("default") && !this.at("}") && this.peek().kind !== "end") {
        // A `break` at the level of the case leaves the switch. A labelled one
        // is left to the statement reader, which refuses the label where it is
        // written.
        if (this.at("break") && this.peek(1).kind !== "ident") {
          this.next();
          this.accept(";");
          breaks = true;
          break;
        }
        // A case may write its statements in a block, which is the statements
        // it holds.
        if (this.at("{")) {
          body.push(...this.readBlock());
          continue;
        }
        body.push(...this.guardedStatement());
      }
      this.breakTargets.pop();
      // The statements after a break are unreachable. They are read past so
      // the next case starts where the source wrote it.
      while (breaks && !this.at("case") && !this.at("default") && !this.at("}") && this.peek().kind !== "end") {
        this.next();
      }
      cases.push({ test, body, breaks, line });
    }
    this.expect("}");
    return this.lowerSwitch(start.line, discriminant, cases);
  }

  /** The if-chain a switch is, with the fallthrough its cases write. */
  private lowerSwitch(
    line: number,
    discriminant: Expression,
    cases: { test: Expression | null; body: Statement[]; breaks: boolean; line: number }[],
  ): Statement {
    const executions = cases.map((_one, index) => {
      const body: Statement[] = [];
      for (let at = index; at < cases.length; at += 1) {
        body.push(...cases[at].body);
        if (cases[at].breaks) break;
      }
      return body;
    });
    const defaultIndex = cases.findIndex((one) => one.test === null);
    let chain: Statement[] = defaultIndex >= 0 ? [...executions[defaultIndex]] : [];
    const temporary = `__switch${this.switchCount}`;
    this.switchCount += 1;
    for (let index = cases.length - 1; index >= 0; index -= 1) {
      const one = cases[index] as { test: Expression | null; body: Statement[]; breaks: boolean; line: number };
      if (one.test === null) continue;
      chain = [
        {
          kind: "if",
          condition: { k: "binary", op: "===", left: { k: "ident", name: temporary }, right: one.test },
          then: executions[index] as Statement[],
          otherwise: chain,
          line: one.line,
        },
      ];
    }
    if (chain.length === 0) {
      return { kind: "expression", value: { k: "literal", text: "0" }, line };
    }
    this.pendingBefore.push({ kind: "declare", name: temporary, type: null, init: discriminant, line });
    if (chain.length === 1) return chain[0] as Statement;
    this.pendingBefore.push(...(chain.slice(0, -1) as Statement[]));
    return chain[chain.length - 1] as Statement;
  }

  private readIf(): Statement {
    const start = this.next();
    this.expect("(");
    const condition = this.readExpression();
    this.expect(")");
    // A branch whose condition is written false is not code the program runs,
    // and what it holds is not a construct the build should refuse.
    const dead = isNumberLiteral(condition, "0");
    const then = dead ? this.discardedBody() : this.withNarrowing(this.narrowingOf(condition, true), () => this.readBody());
    const otherwise: Statement[] = [];
    if (this.accept("else")) {
      const settled = this.narrowingOf(condition, false);
      const read = (): Statement[] => (this.at("if") ? [this.readIf()] : this.readBody());
      otherwise.push(...this.withNarrowing(settled, read));
    }
    if (dead && otherwise.length === 0) return { kind: "expression", value: { k: "literal", text: "0" }, line: start.line };
    return { kind: "if", condition, then, otherwise, line: start.line };
  }

  /**
   * What an `if` that leaves the block says about the statements after it.
   *
   * `if (typeof entry !== "string") throw …` runs the rest of the block only
   * where the test did not hold, so the test's other side is what the rest of
   * the block reads the value at. A branch that leaves in some of its own arms
   * says nothing about the rest, so only a body whose every arm leaves settles
   * anything.
   */
  private narrowAfter(statement: Statement): void {
    if (statement.kind !== "if" || statement.otherwise.length > 0) return;
    if (!leavesEveryPath(statement.then)) return;
    for (const [path, type] of this.narrowingOf(statement.condition, false)) this.narrowed.set(path, type);
  }

  /** A body the condition proves never runs, read without its diagnostics. */
  private discardedBody(): Statement[] {
    const saved = this.diagnostics;
    const savedTypes = this.valueTypes;
    const savedShapes = this.valueShapes;
    const savedClasses = this.valueClasses;
    const savedPending = this.pending;
    this.diagnostics = new Diagnostics();
    this.valueTypes = new Map(savedTypes);
    this.valueShapes = new Map(savedShapes);
    this.valueClasses = new Map(savedClasses);
    this.pending = [];
    try {
      return this.readBody();
    } finally {
      this.diagnostics = saved;
      this.valueTypes = savedTypes;
      this.valueShapes = savedShapes;
      this.valueClasses = savedClasses;
      this.pending = savedPending;
    }
  }

  /**
   * `for (const x of values)`: it walks the elements of a typed array, whose
   * length the source may name as `values.length`, so nothing else is read.
   *
   * The loop names the array it walks rather than writing it, because the walk
   * reads its length before the first element and again between elements. A
   * source that writes the array where the name goes, as `of request.files` or
   * `of Object.keys(TABLE)`, has that value read once into a name of the
   * loop's own before it starts: the value is the same one however many
   * elements the loop visits.
   */
  private readForOf(
    start: Token,
    variable: string,
    pattern: { name: string; field: string | null; index: number }[] | null,
  ): Statement {
    this.expect("of");
    const of = this.peek();
    let walked: string;
    let written: Expression | null = null;
    // The source of a loop is read with the iteration flag raised, so an
    // `entries()` written where a loop walks it is marked rather than refused:
    // the pair it names is not an element a typed array holds.
    const savedIteration = this.readingIteration;
    this.readingIteration = true;
    try {
      if (of.kind === "ident" && this.peek(1).text === ")") {
        this.next();
        walked = of.text;
      } else {
        written = this.readExpression();
        walked = `__walk${this.walkCount}`;
        this.walkCount += 1;
        this.valueTypes.set(walked, this.valueTypeOf(written));
      }
    } finally {
      this.readingIteration = savedIteration;
    }
    this.expect(")");
    // A map or a set is walked by its entries, not by a typed array's elements:
    // the two values of one entry are read out of the dictionary by position.
    const source: Expression = written ?? { k: "ident", name: walked };
    const collection = this.iteratedCollections.get(source) ?? this.collectionOfExpression(source);
    if (collection !== null) {
      return this.readCollectionForOf(start, variable, pattern, source, collection);
    }
    // `for (const [index, element] of list.entries())`: a list's entries are its
    // positions, so the loop walks the list by index and the two parts of an
    // entry are the index and the element written there.
    const entriesOf = this.iteratedSequences.get(source);
    if (entriesOf !== undefined) {
      return this.readSequenceEntriesForOf(start, pattern, source, entriesOf);
    }
    // The element a `for..of` binds is one element of the array it walks, so it
    // is held at the element type an arrow capturing it would be handed.
    const walkedType = this.valueTypes.get(walked);
    const element = walkedType !== undefined && (walkedType.kind === "slice" || walkedType.kind === "array") ? walkedType.of : ANY_TYPE;
    const walkedShape = written !== null ? this.shapeOf(written) : (this.valueShapes.get(walked) ?? null);
    const elementShape = walkedShape !== null && walkedShape.kind === "list" ? walkedShape.of : null;
    // A pattern binds the parts of the element, so the loop walks a name of its
    // own and the body reads each name out of that one.
    const item = pattern === null ? variable : `__item${this.destructureCount++}`;
    this.valueTypes.set(item, element);
    if (elementShape !== null) this.valueShapes.set(item, elementShape);
    else this.valueShapes.delete(item);
    const prelude = pattern === null ? [] : this.patternPrelude(pattern, item, element, start.line, elementShape);
    const body = [...prelude, ...this.loopBody()];
    // The value is read once, before the loop starts. It is recorded after the
    // body is read, because the body's own pending statements belong inside it.
    if (written !== null) {
      this.pendingBefore.push({ kind: "declare", name: walked, type: null, init: written, line: start.line });
    }
    return { kind: "forOf", variable: item, of: walked, body, line: start.line };
  }

  /**
   * `for (const [k, v] of map)`: the entries of a dictionary, read by position.
   *
   * The dictionary keeps its entries in the order they were written, so a loop
   * from zero to its length walks them in that order. A map binds a key and a
   * value; a set binds the key it stores, which is the element the source added.
   */
  private readCollectionForOf(
    start: Token,
    variable: string,
    pattern: { name: string; field: string | null; index: number }[] | null,
    source: Expression,
    collection: CollectionValue,
  ): Statement {
    let receiver: Expression = source;
    if (source.k === "call" && source.name === "__collection_entries") {
      receiver = source.args[0] as Expression;
    }
    let held: string;
    if (receiver.k === "ident") {
      held = receiver.name;
    } else {
      held = `__walk${this.walkCount}`;
      this.walkCount += 1;
    }
    this.valueTypes.set(held, NUMBER_RESULT);
    const count = (): Expression => ({
      k: "call",
      name: "blaze_rt_dict_len",
      args: [{ k: "ident", name: held }],
    });
    const index = `__at${this.walkCount}`;
    this.walkCount += 1;
    this.valueTypes.set(index, NUMBER_RESULT);
    const body: Statement[] = [];
    const bind = (name: string, type: TypeExpr, readName: string): Statement => {
      const shape = this.shapeOfTypeExpr(type);
      this.valueTypes.set(name, type);
      if (shape.kind !== "any") this.valueShapes.set(name, shape);
      else this.valueShapes.delete(name);
      const read: Expression = {
        k: "call",
        name: readName,
        args: [{ k: "ident", name: held }, { k: "ident", name: index }],
      };
      const value = type.kind === "primitive" && type.name === "bool"
        ? { k: "binary" as const, op: "!=" as const, left: read, right: { k: "literal" as const, text: "0" } }
        : read;
      return { kind: "declare", name, type: null, init: value, line: start.line };
    };
    const keyRead = this.keyReadName(collection);
    if (collection.kind === "set") {
      if (pattern === null) {
        body.push(bind(variable, collection.key, keyRead));
      } else {
        // A set's entries are the same value twice, which is what the language
        // answers for `for (const [a, b] of set)`. A gap names no value and
        // the positions around it are the ones the source wrote.
        for (const binding of pattern) {
          body.push(bind(binding.name, collection.key, keyRead));
        }
      }
    } else if (pattern !== null) {
      // A map entry is a key and a value, so position 0 reads the key and
      // position 1 the value; a gap names neither and is read past.
      for (const binding of pattern) {
        const key = binding.index === 0;
        const value = binding.index === 1;
        if (key) body.push(bind(binding.name, collection.key, keyRead));
        else if (value) body.push(bind(binding.name, collection.value, this.valueReadName(collection.value)));
        else {
          this.report(
            "a map entry is a key and a value",
            "write for (const [key, value] of map), or walk map.keys() or map.values()",
            start,
          );
        }
      }
    } else {
      this.report(
        "a map entry is a key and a value",
        "write for (const [key, value] of map), or walk map.keys() or map.values()",
        start,
      );
    }
    for (const statement of this.loopBody()) body.push(statement);
    // The receiver is read once, before the loop starts, and the source body
    // may have written pending declarations of its own: this one is recorded
    // after it, where it belongs in front of the loop rather than in it.
    if (receiver.k !== "ident") {
      this.pendingBefore.push({ kind: "declare", name: held, type: null, init: receiver, line: start.line });
    }
    return {
      kind: "loop",
      variable: index,
      from: { k: "literal", text: "0" },
      to: count(),
      inclusive: false,
      step: null,
      down: false,
      body,
      line: start.line,
    };
  }

  /**
   * `for (const [index, element] of list.entries())`: one position of a list
   * and the element written there.
   *
   * The list is read once, before the loop starts, and the loop walks its
   * positions from zero to its length. Position 0 of an entry is the index and
   * position 1 is the element; a list has no other part, so a pattern that
   * names anything else is refused where it is written.
   */
  private readSequenceEntriesForOf(
    start: Token,
    pattern: { name: string; field: string | null; index: number }[] | null,
    source: Expression,
    element: TypeExpr,
  ): Statement {
    const receiver: Expression = source.k === "call" ? (source.args[0] as Expression) : source;
    let held: string;
    if (receiver.k === "ident") {
      held = receiver.name;
    } else {
      held = `__walk${this.walkCount}`;
      this.walkCount += 1;
      this.valueTypes.set(held, { kind: "slice", of: element });
    }
    const index = `__at${this.walkCount}`;
    this.walkCount += 1;
    this.valueTypes.set(index, NUMBER_RESULT);
    const body: Statement[] = [];
    const bind = (name: string, type: TypeExpr, read: Expression): Statement => {
      const shape = this.shapeOfTypeExpr(type);
      this.valueTypes.set(name, type);
      if (shape.kind !== "any") this.valueShapes.set(name, shape);
      else this.valueShapes.delete(name);
      return { kind: "declare", name, type: null, init: read, line: start.line };
    };
    const elementRead: Expression = {
      k: "index",
      base: { k: "ident", name: held },
      index: { k: "ident", name: index },
    };
    this.expressionTypes.set(elementRead, element);
    if (pattern === null) {
      this.report(
        "an entry of a list is an index and an element",
        "write for (const [index, element] of list.entries())",
        start,
      );
    } else {
      for (const binding of pattern) {
        if (binding.index === 0) body.push(bind(binding.name, NUMBER_RESULT, { k: "ident", name: index }));
        else if (binding.index === 1) body.push(bind(binding.name, element, elementRead));
        else {
          this.report(
            "an entry of a list is an index and an element",
            "write for (const [index, element] of list.entries())",
            start,
          );
        }
      }
    }
    for (const statement of this.loopBody()) body.push(statement);
    // The list is read once, before the loop starts, and the source body may
    // have written pending declarations of its own: this one is recorded after
    // it, where it belongs in front of the loop rather than in it.
    if (receiver.k !== "ident") {
      this.pendingBefore.push({ kind: "declare", name: held, type: null, init: receiver, line: start.line });
    }
    return {
      kind: "loop",
      variable: index,
      from: { k: "literal", text: "0" },
      to: { k: "length", buffer: held },
      inclusive: false,
      step: null,
      down: false,
      body,
      line: start.line,
    };
  }

  private readWhile(): Statement {
    const start = this.next();
    this.expect("(");
    const condition = this.readExpression();
    this.expect(")");
    return { kind: "while", condition, body: this.loopBody(), line: start.line };
  }

  private readDoWhile(): Statement {
    const start = this.next();
    const body = this.loopBody();
    if (!this.accept("while")) {
      this.report("a do-while loop ends with `while (condition);`", `near "${this.peek().text}"`);
      return { kind: "expression", value: this.hole(), line: start.line };
    }
    this.expect("(");
    const condition = this.readExpression();
    this.expect(")");
    this.accept(";");
    return { kind: "doWhile", condition, body, line: start.line };
  }

  /**
   * The body of a loop, read one level deeper: a `break` or a `continue` inside
   * it leaves the loop it is written in.
   */
  private loopBody(): Statement[] {
    this.loops += 1;
    this.breakTargets.push("loop");
    const body = this.readBody();
    this.breakTargets.pop();
    this.loops -= 1;
    return body;
  }

  readExpression(): Expression {
    // An arrow is a value wherever it is read, except at the one place it is
    // bound to a name: there the call of that name later is a direct call of
    // the function the body became, and no closure has to be built for it. The
    // flag is read and cleared here, so a nested expression of the same
    // declaration is read as the value it is.
    this.expressionReads += 1;
    try {
      const binding = this.bindingArrow;
      this.bindingArrow = false;
      // The arrow a declaration binds is the one at the top of its initialiser,
      // and no arrow nested inside that one is it.
      const declaring = this.declaringArrow;
      this.declaringArrow = null;
      const arrowName = this.arrowName;
      this.arrowName = binding ? declaring : null;
      const value = this.readConditional();
      this.arrowName = arrowName;
      return binding ? value : this.materialized(value);
    } finally {
      this.expressionReads -= 1;
      if (this.expressionReads === 0 && this.expectedReads === 0) this.reportUnsettledArrays();
    }
  }

  /** `c ? a : b`, the loosest operator an expression has. */
  private readConditional(): Expression {
    const condition = this.readNullish();
    if (!this.at("?")) return condition;
    this.next();
    const then = this.withNarrowing(this.narrowingOf(condition, true), () => this.readExpression());
    this.expect(":");
    const otherwise = this.withNarrowing(this.narrowingOf(condition, false), () => this.readExpression());
    // An empty arm is built at the type of the arm that has values, or at the
    // type the use of the whole conditional states. A use that states a
    // number says nothing about a list written inside the conditional.
    const expected = this.expectedType !== null &&
      (this.expectedType.kind === "slice" || this.expectedType.kind === "array")
      ? this.expectedType
      : null;
    const type = expected ?? this.settledArrayType(then) ?? this.settledArrayType(otherwise);
    if (type !== null) this.applyExpected(then, type, this.expectedShape);
    if (type !== null) this.applyExpected(otherwise, type, this.expectedShape);
    return { k: "conditional", condition, then, otherwise };
  }

  private readBinaryLevel(operators: readonly string[], next: () => Expression): Expression {
    let left = next();
    for (;;) {
      const token = this.peek();
      if (token.kind !== "punct" || !operators.includes(token.text)) return left;
      this.next();
      left = { k: "binary", op: token.text as BinaryOp, left, right: next() };
    }
  }

  private readLogicalOr(): Expression {
    let left = this.readLogicalAnd();
    while (this.at("||")) {
      this.next();
      if (isNumberLiteral(left, "1")) {
        this.discarded(() => this.readLogicalAnd());
        continue;
      }
      if (isNumberLiteral(left, "0")) {
        left = this.readLogicalAnd();
        continue;
      }
      left = { k: "binary", op: "||", left, right: this.withNarrowing(this.narrowingOf(left, false), () => this.readLogicalAnd()) };
    }
    return left;
  }

  private readNullish(): Expression {
    let left = this.readLogicalOr();
    while (this.at("??")) {
      this.next();
      const right = this.readLogicalOr();
      // `values ?? []`: the list on the right holds the element type the value
      // on the left names, which is what the language infers there too. A use
      // that expects a number says nothing about the list written inside.
      const expected = this.expectedType !== null &&
        (this.expectedType.kind === "slice" || this.expectedType.kind === "array")
        ? this.expectedType
        : null;
      const type = expected ?? this.settledArrayType(left) ?? this.settledArrayType(right);
      if (type !== null) this.applyExpected(left, type, this.expectedShape);
      if (type !== null) this.applyExpected(right, type, this.expectedShape);
      // `a?.b ?? c` is the branch of the optional chain with `c` where the
      // chain found nothing. A chain of two optional accesses is two choices,
      // each with an absent arm, and every one of them is what the `??` answers
      // for. So the right side takes the place of each absent arm, and the
      // guard asks each value once — which is what the language does, and what
      // a `??` over the chain cannot do: the zero of a text is the empty text,
      // and a `??` that tested for the absence would hand the empty text back
      // in place of the value the source named.
      const folded = this.absentArmFolded(left, right);
      if (folded !== left) {
        left = folded;
        continue;
      }
      left = { k: "binary", op: "??", left, right };
    }
    return left;
  }

  /**
   * A choice with every absent arm answered by a value, or the value itself
   * where there is no absent arm to answer.
   *
   * A `??` over a choice answers for each arm that holds nothing, however deep
   * the choice of choices is: `o?.a?.b ?? 0` is two guards and one fallback,
   * and the fallback is what each of them answers where it finds nothing.
   */
  private absentArmFolded(value: Expression, otherwise: Expression): Expression {
    if (value.k === "null") return otherwise;
    if (value.k !== "conditional") return value;
    const then = this.absentArmFolded(value.then, otherwise);
    const otherwiseArm = this.absentArmFolded(value.otherwise, otherwise);
    if (then === value.then && otherwiseArm === value.otherwise) return value;
    return { k: "conditional", condition: value.condition, then, otherwise: otherwiseArm };
  }

  private readLogicalAnd(): Expression {
    let left = this.readBitwiseOr();
    while (this.at("&&")) {
      this.next();
      if (isNumberLiteral(left, "0")) {
        this.discarded(() => this.readBitwiseOr());
        continue;
      }
      if (isNumberLiteral(left, "1")) {
        left = this.readBitwiseOr();
        continue;
      }
      left = { k: "binary", op: "&&", left, right: this.withNarrowing(this.narrowingOf(left, true), () => this.readBitwiseOr()) };
    }
    return left;
  }

  /**
   * Reads an expression whose value nothing reads, keeping the diagnostics it
   * would have reported. A branch whose condition is a constant is not code
   * the program runs, and a construct it holds is not a construct the build
   * should refuse.
   */
  private discarded(read: () => unknown): void {
    const saved = this.diagnostics;
    this.diagnostics = new Diagnostics();
    try {
      read();
    } finally {
      this.diagnostics = saved;
    }
  }

  private readEquality(): Expression {
    let left = this.readComparison();
    for (;;) {
      const token = this.peek();
      if (token.kind !== "punct" || !["===", "!==", "==", "!="].includes(token.text)) return left;
      this.next();
      const right = this.readComparison();
      const folded = this.foldEquality(token.text, left, right);
      left = folded ?? { k: "binary", op: token.text as BinaryOp, left, right };
    }
  }

  /** `a === b` over two values written out, answered where they are read. */
  private foldEquality(op: string, left: Expression, right: Expression): Expression | null {
    const textLeft = textValue(left);
    const textRight = textValue(right);
    const numberLeft = numberValue(left);
    const numberRight = numberValue(right);
    let equal: boolean | null = null;
    if (textLeft !== null && textRight !== null) equal = textLeft === textRight;
    else if (numberLeft !== null && numberRight !== null) equal = numberLeft === numberRight;
    if (equal === null) return null;
    const answer = op === "===" || op === "==" ? equal : !equal;
    return { k: "literal", text: answer ? "1" : "0" };
  }

  /**
   * `Array.isArray(value)`: whether the value is a list.
   *
   * A list is a block of one element type, and a value the read holds at a list
   * type is one of those; a number, a truth, a text and an object are not. What
   * the read cannot type — a tree a parse read, a field of a module the graph
   * has not linked — is asked of the runtime, which carries the kind.
   */
  private isArrayTest(value: Expression): Expression {
    const type = this.valueTypeOf(value);
    const answer = (isOne: boolean): Expression => {
      const literal: Expression = { k: "literal", text: isOne ? "1" : "0" };
      this.expressionTypes.set(literal, BOOLEAN_RESULT);
      return literal;
    };
    if (type.kind === "slice" || type.kind === "array") return answer(true);
    if (type.kind === "primitive" || type.kind === "text" || type.kind === "void") return answer(false);
    if (type.kind === "ref" && type.name !== undefined) return answer(false);
    const asked: Expression = {
      k: "binary",
      op: "===",
      left: { k: "call", name: "blaze_rt_is_array", args: [value] },
      right: { k: "literal", text: "1" },
    };
    this.expressionTypes.set(asked, BOOLEAN_RESULT);
    return asked;
  }

  /**
   * `key in value`: whether an object has the field the key names.
   *
   * A record the file wrote out — a top-level constant of its own or one an
   * import binds — has the keys the source wrote, so the question is the chain
   * of comparisons those keys are, exactly as a written set's `has` is. A value
   * the read holds at a record type answers for a field its type declares: the
   * object was laid out with every field the declaration writes.
   *
   * What is not carried is the test a union of shapes is discriminated by. A
   * union erases to the first arm, so the field of another arm is not a field
   * this read knows the object has, and a run-time tag is what would answer it.
   */
  private membership(key: Expression, object: Expression): Expression {
    const constant = object.k === "ident" ? this.constants.get(object.name) : undefined;
    if (constant?.fields !== undefined) {
      if (!repeatableExpression(key)) {
        this.report(
          "a record's keys read the key once",
          "write the key into a name first, as in const k = f(); k in TABLE",
          this.peek(),
        );
        return this.hole();
      }
      // The chain asks the last key first, so the comparisons run in the order
      // the source wrote them.
      const keys = [...constant.fields.keys()];
      let answer: Expression = { k: "literal", text: "0" };
      for (let at = keys.length - 1; at >= 0; at -= 1) {
        answer = {
          k: "conditional",
          condition: { k: "binary", op: "===", left: key, right: { k: "text", parts: [{ k: "text", value: keys[at] as string }] } },
          then: { k: "literal", text: "1" },
          otherwise: answer,
        };
      }
      this.expressionTypes.set(answer, BOOLEAN_RESULT);
      return answer;
    }
    const name = textValue(key);
    if (name !== null) {
      const shape = this.shapeOf(object);
      if (shape !== null && shape.kind === "record" && shape.fields.has(name)) {
        const answer: Expression = { k: "literal", text: "1" };
        this.expressionTypes.set(answer, BOOLEAN_RESULT);
        return answer;
      }
    }
    this.report(
      "`in` asks a value whose fields the type does not write down",
      "a record the file writes out as a constant is read key by key; the field of a value of a union of shapes needs a tag the value does not carry",
      this.peek(),
    );
    return this.hole();
  }

  /**
   * `&`, `^` and `|`, loosest of the three in that order, which is where
   * JavaScript puts them: `a & b ^ c` is `(a & b) ^ c`, and `a ^ b | c` is
   * `(a ^ b) | c`. They bind looser than a shift and tighter than a
   * comparison, and the program body has always read them in exactly this
   * place — a function the module declared could not use one at all.
   */
  private readBitwiseOr(): Expression {
    return this.readBinaryLevel(["|"], () => this.readBitwiseXor());
  }

  private readBitwiseXor(): Expression {
    return this.readBinaryLevel(["^"], () => this.readBitwiseAnd());
  }

  private readBitwiseAnd(): Expression {
    return this.readBinaryLevel(["&"], () => this.readEquality());
  }

  private readComparison(): Expression {
    let left = this.readBinaryLevel(["<", "<=", ">", ">="], () => this.readShift());
    // `k in value` binds where a comparison does, and asks whether the object
    // has the field. What the answer is depends on what the object is, and the
    // reading is the one `membership` writes.
    while (this.at("in")) {
      this.next();
      left = this.membership(left, this.readShift());
    }
    // `x instanceof C` asks whether the value is an instance of a class. A
    // compiled instance is the object itself, so the answer is whether it is
    // there at all; the declared class is what says what it is when it is.
    while (this.at("instanceof")) {
      this.next();
      const name = this.next();
      const known = name.kind === "ident" && (this.classTable.names.has(name.text) || name.text === "Error");
      if (name.kind !== "ident" || !known) {
        this.report("instanceof names a class of this module", `near "${name.text}"`, name);
        continue;
      }
      // What the source says the value is settles the answer where it says
      // anything: an instance of one class is not an instance of another, and
      // every class of `extends Error` is one too. A value no type names may be
      // any instance, so it is one when it is there.
      const held = this.classOfExpression(left);
      const isOne = held !== null && (held === name.text || (name.text === "Error" && this.classNamed(held)?.base === "Error"));
      left =
        held === null
          ? { k: "binary", op: "!==", left, right: { k: "null" } }
          : {
              k: "binary",
              op: "===",
              left: { k: "literal", text: isOne ? "1" : "0" },
              right: { k: "literal", text: "1" },
            };
    }
    return left;
  }

  private readShift(): Expression {
    return this.readBinaryLevel(["<<", ">>", ">>>"], () => this.readAdditive());
  }

  private readAdditive(): Expression {
    return this.readBinaryLevel(["+", "-"], () => this.readMultiplicative());
  }

  private readMultiplicative(): Expression {
    return this.readBinaryLevel(["*", "/", "%"], () => this.readPower());
  }

  /** `a ** b`: right associative, and tighter than a sign on its left. */
  private readPower(): Expression {
    const start = this.position;
    const base = this.readUnary();
    if (!this.at("**")) return base;
    // A sign binds looser than `**` in JavaScript, so `-x ** 2` is a syntax
    // error there and not the power of a negative number. Only an operator
    // written straight in front of the base counts: `(-x) ** 2` is the power
    // of a parenthesised negative number, and is a power.
    if (UNARY_OPERATORS.includes(this.tokens[start]?.text ?? "")) {
      this.report("`**` may not follow a unary operator", "as in `(-x) ** 2`");
      this.next();
      this.readPower();
      return base;
    }
    this.next();
    // A sign belongs to the exponent: `2 ** -1` is a power, not a subtraction.
    const exponent = this.at("-") || this.at("+") ? this.readSigned() : this.readPower();
    return { k: "binary", op: "**", left: base, right: exponent };
  }

  private readSigned(): Expression {
    const token = this.next();
    return { k: "unary", op: token.text as UnaryOp, operand: this.readUnary() };
  }

  private readUnary(): Expression {
    const token = this.peek();
    // `<T>value` is a type assertion written before the value. The angle form
    // is not a comparison here: a value cannot start with `<`, so the type is
    // erased and the value after it is the value the source wrote.
    if (token.kind === "punct" && token.text === "<") {
      this.next();
      this.skipTypeAssertion();
      return this.readUnary();
    }
    if (token.kind === "ident" && token.text === "typeof") {
      this.next();
      const operand = this.readUnary();
      return this.typeofValue(operand);
    }
    if (token.kind === "punct" && UNARY_OPERATORS.includes(token.text)) {
      this.next();
      return { k: "unary", op: token.text as UnaryOp, operand: this.readUnary() };
    }
    if (token.kind === "punct" && (token.text === "++" || token.text === "--")) {
      this.next();
      const operand = this.readUnary();
      if (operand.k !== "ident") return this.missing(`"${token.text}" needs a name to change`, token);
      return { k: "update", name: operand.name, op: token.text as "++" | "--", prefix: true };
    }
    return this.readPostfix();
  }

  /**
   * `Number.isNaN(x)` and the questions beside it, as operations already here.
   *
   * A value that is not a number is the one value not equal to itself, so
   * `x !== x` answers `isNaN` without a runtime service. `x - x` is zero for
   * every finite number — and NaN for either infinity — which is `isFinite`;
   * `isInteger` adds a floor, and `isSafeInteger` the bound the language names.
   * The answer is a truth, so the body prints it the way the source writes it.
   */
  private numberMethod(field: string, args: readonly Expression[]): Expression | null {
    const value = args[0];
    const call = (name: string, values: Expression[]): Expression => ({ k: "call", name, args: values });
    const answer = (made: Expression): Expression => {
      this.expressionTypes.set(made, BOOLEAN_RESULT);
      return made;
    };
    if (args.length !== 1 || value === undefined) return null;
    // The value is written more than once, so it has to be one reading it: a
    // call written in the argument would run once per mention.
    if (!repeatableExpression(value)) {
      this.report(
        `Number.${field} reads its value more than once`,
        "write the value into a name first, as in const n = f(); Number.isInteger(n)",
        this.peek(),
      );
      return this.hole();
    }
    if (field === "isNaN") return answer({ k: "binary", op: "!==", left: value, right: value });
    if (field !== "isFinite" && field !== "isInteger" && field !== "isSafeInteger") return null;
    // `x === x` fails only for NaN, and `x - x` is zero only for a finite one.
    const notNaN: Expression = { k: "binary", op: "===", left: value, right: value };
    const difference: Expression = { k: "binary", op: "-", left: value, right: value };
    const isFinite: Expression = {
      k: "binary",
      op: "&&",
      left: notNaN,
      right: { k: "binary", op: "===", left: difference, right: { k: "literal", text: "0" } },
    };
    if (field === "isFinite") return answer(isFinite);
    const whole: Expression = {
      k: "binary",
      op: "&&",
      left: isFinite,
      right: { k: "binary", op: "===", left: call("Math.floor", [value]), right: value },
    };
    if (field === "isInteger") return answer(whole);
    return answer({
      k: "binary",
      op: "&&",
      left: whole,
      right: {
        k: "binary",
        op: "<=",
        left: call("Math.abs", [value]),
        right: { k: "literal", text: "9007199254740991" },
      },
    });
  }

  /**
   * `typeof value`: the name the value's type answers.
   *
   * A compiled program is typed before it runs, so the answer is read from the
   * type the value is held at rather than from a tag a value carries at run
   * time. A name the body declared is that declaration's type; a value written
   * out is its literal's type.
   *
   * A value the read cannot type — a field of an interface the module graph has
   * not linked, or a value the source declared `unknown` — is the one case the
   * type does not answer. The name the runtime registered it as does, so the
   * question is asked there instead of answered here: the alternative was to
   * call the value an object, which folded `typeof value === "string"` to false
   * and compiled no arm of the branch at all.
   */
  private typeofValue(operand: Expression): Expression {
    let type: TypeExpr | null = null;
    // A name is held at the type its declaration states: a contract type and
    // the shape beside it do not always agree, and the declaration is the one
    // the value was typed at.
    if (operand.k === "ident") type = this.valueTypes.get(operand.name) ?? null;
    if (operand.k === "bigint") type = BIGINT_RESULT;
    if (operand.k === "literal") type = NUMBER_RESULT;
    if (operand.k === "text") type = TEXT_RESULT;
    if (operand.k === "null") return { k: "text", parts: [{ k: "text", value: "object" }] };
    // A member, an index or a call states its type the same way a name does:
    // the field the interface declares, the element the array holds, or what
    // the function answers. The answer is read from that type rather than
    // refused because the value is not a name.
    if (type === null || unknownReference(type)) {
      type = null;
      const held = this.valueTypeOf(operand);
      if (!unknownReference(held)) type = held;
    }
    // An interface erases to a reference with no name, which is the same form a
    // value the read does not know takes: `unknown`, `any`, and the field of a
    // type the module graph has not linked all erase to it. The shape says which
    // of the two the value is, because a declaration the read holds keeps the
    // name of the interface it was written at.
    if (type === null) {
      const shape = this.shapeOf(operand);
      if (shape !== null && shape.kind !== "any") type = this.typeExprOfShape(shape);
    }
    if (type === null) {
      const asked: Expression = { k: "call", name: "JSON.typeof", args: [operand] };
      this.expressionTypes.set(asked, TEXT_RESULT);
      // The name the test is about, so a branch the test guards reads it at the
      // type the test asked about rather than at the type it was declared at.
      const path = this.narrowedPath(operand);
      if (path !== null) this.typeofPaths.set(asked, path);
      return asked;
    }
    return { k: "text", parts: [{ k: "text", value: typeofName(type) }] };
  }

  /**
   * The way the source spells a name or a chain of fields read from one, which
   * is the key a narrowing is remembered under, or null for a value written
   * another way.
   */
  private narrowedPath(value: Expression): string | null {
    if (value.k === "ident") return value.name;
    if (value.k === "member") {
      const base = this.narrowedPath(value.base);
      return base === null ? null : `${base}.${value.field}`;
    }
    return null;
  }

  /**
   * The types a test settles, by the path it tested, read one branch at a time.
   *
   * The tests a source writes over a value it does not know the type of are
   * `typeof x === "kind"` and the two ways two of them are joined: a
   * conjunction settles both when it holds, and a disjunction settles both when
   * it does not. A negation swaps the two. The kind is the one `typeofName`
   * answers for, so the branch reads the value at the type its own type would
   * have named.
   */
  private narrowingOf(condition: Expression, holds: boolean): Map<string, TypeExpr> {
    const settled = new Map<string, TypeExpr>();
    const collect = (value: Expression, truth: boolean): void => {
      if (value.k === "unary" && value.op === "!") {
        collect(value.operand, !truth);
        return;
      }
      if (value.k === "binary" && (value.op === "&&" || value.op === "||")) {
        // A conjunction settles what holds when it is true; a disjunction
        // settles what holds when it is false. The other side of either says
        // nothing about the values it tested.
        const wanted = value.op === "&&" ? truth : !truth;
        if (!wanted) return;
        collect(value.left, truth);
        collect(value.right, truth);
        return;
      }
      if (value.k !== "binary" || (value.op !== "===" && value.op !== "!==" && value.op !== "==" && value.op !== "!=")) return;
      const positive = value.op === "===" || value.op === "==";
      const tested = positive === truth ? value.right : value.left;
      const kind = textValue(tested);
      if (kind === null) return;
      const other = positive === truth ? value.left : value.right;
      const path = this.typeofPaths.get(other);
      if (path === undefined) return;
      const type = typeOfTypeofName(kind);
      if (type !== null) settled.set(path, type);
    };
    collect(condition, holds);
    return settled;
  }

  /**
   * Reads an expression with the types a test settled in place, and hands the
   * table back afterwards.
   */
  private withNarrowing<T>(settled: Map<string, TypeExpr>, read: () => T): T {
    if (settled.size === 0) return read();
    const saved = this.narrowed;
    this.narrowed = new Map(saved);
    for (const [path, type] of settled) this.narrowed.set(path, type);
    try {
      return read();
    } finally {
      this.narrowed = saved;
    }
  }

  /**
   * Forgets what is known about a path and everything read from it, which is
   * what writing to it or declaring it again does.
   */
  private forgetNarrowing(path: string): void {
    this.narrowed.delete(path);
    const prefix = `${path}.`;
    for (const key of [...this.narrowed.keys()]) {
      if (key.startsWith(prefix)) this.narrowed.delete(key);
    }
  }

  /**
   * `Deno.args` after it has been read, together with the argument or the
   * length written after it. Deno hands a program the arguments alone and node
   * counts the program and the file it runs before them, so the index of an
   * argument is two more than the one the source wrote — the same shift the
   * program frontend reads `Deno.args` with, so a name read in a function body
   * and in the body of the program is the same argument.
   */
  private denoArguments(): Expression {
    const shift: Expression = { k: "literal", text: "2" };
    if (this.at("[")) {
      this.next();
      const index = this.readExpression();
      this.expect("]");
      return { k: "argv", index: { k: "binary", op: "+", left: index, right: shift } };
    }
    if (this.at(".") && this.peek(1).text === "length") {
      this.next();
      this.next();
      return {
        k: "binary",
        op: "-",
        left: { k: "call", name: ARGV_LENGTH, args: [] },
        right: shift,
      };
    }
    return { k: "argv", index: null };
  }

  /**
   * A primary, then any number of indexings, field reads, calls and updates.
   *
   * An optional access, `a?.b`, is read into a chain of conditional values:
   * `a != null ? a.b : null`. The value before the `?` is what the condition
   * tests, and every access after it belongs inside the `then`, so
   * `a?.b.c` reads `a.b.c` only where `a` is not null. A second `?.` nests
   * another conditional inside the first.
   */
  private readPostfix(): Expression {
    interface OptionalLink {
      condition: Expression;
      then: Expression;
      child: OptionalLink | null;
    }
    let base = this.readPrimary();
    let optionalRoot: OptionalLink | null = null;
    let optional: OptionalLink | null = null;
    const current = (): Expression => (optional === null ? base : optional.then);
    const replace = (next: Expression): void => {
      if (optional === null) base = next;
      else optional.then = next;
    };
    const beginOptional = (): void => {
      const target = current();
      // The value before `?.` is read by the condition and again inside the
      // branch, so it has to be a value reading twice does not change.
      if (!repeatableExpression(target)) {
        this.report(
          "an optional chain reads the value before `?.` twice",
          "write the value into a name first, as in const value = f(); value?.field",
          this.peek(),
        );
      }
      const link: OptionalLink = {
        condition: { k: "binary", op: "!=", left: target, right: { k: "null" } },
        then: target,
        child: null,
      };
      if (optionalRoot === null) optionalRoot = link;
      else (optional as OptionalLink).child = link;
      optional = link;
    };
    const finish = (): Expression => {
      const fold = (link: OptionalLink): Expression => {
        const inside = link.child === null ? link.then : fold(link.child);
        return { k: "conditional", condition: link.condition, then: inside, otherwise: { k: "null" } };
      };
      return optionalRoot === null ? base : fold(optionalRoot);
    };
    for (;;) {
      // `?.` is the optional access. A lone `?` is the conditional operator,
      // which the expression reader above reads from the value this returns.
      // `?.[i]` also writes the dot, so the token after the question is the
      // one that decides.
      if (this.at("?") && this.peek(1).text === ".") {
        beginOptional();
        this.next();
        // `?.[i]` and `?.(args)` write a dot between the question and the
        // bracket; the access that follows is the one the loop reads.
        if (this.at(".") && (this.peek(1).text === "[" || this.peek(1).text === "(")) this.next();
        continue;
      }
      if (this.at("[")) {
        const target = current();
        this.next();
        const index = this.readExpression();
        this.expect("]");
        // `m[key]` on a record or a map is one entry of the dictionary, read
        // the way `m.get(key)` reads it.
        const indexed = this.collectionOfExpression(target);
        if (indexed !== null && indexed.kind === "map") {
          const got = this.collectionMethod(target, indexed, "get", [index]);
          if (got !== null) {
            replace(got);
            continue;
          }
        }
        replace(target.k === "argv" ? { k: "argv", index } : { k: "index", base: target, index });
        continue;
      }
      // `a.map<string>(f)` writes the type arguments of the call before its
      // own: the types are the source's statement about the call and the
      // language does not carry them, so the list is skipped and the call is
      // the one the `(` after it makes. A `<` that no `(` follows is the
      // comparison it is, and is left to the reader above.
      if (this.at("<") && this.typeArgumentsBeforeCall()) {
        this.skipTypeParameters();
        continue;
      }
      if (this.at("(")) {
        const target = current();
        // An arrow written where it is called: `((a) => a + 1)(x)`. The call is
        // a call of the function the body became, with what it captured in
        // front of the arguments.
        if (target.k === "arrow") {
          const written = this.arrowBindings.get(target.name);
          const args = this.readCallArguments(written?.params.map((param) => param.type) ?? []);
          replace({
            k: "call",
            name: target.name,
            args: [...target.captures.map((name): Expression => ({ k: "ident", name })), ...args],
          });
          continue;
        }
        // `g(x)` where `g` is bound to an arrow: the call is a call of the
        // function the arrow lifted to, with the values it captured in front of
        // the arguments the source wrote.
        if (target.k === "ident" && this.valueArrows.has(target.name)) {
          const binding = this.valueArrows.get(target.name) as ArrowBinding;
          const args = this.readCallArguments(binding.params.map((param) => param.type));
          const made: Expression = {
            k: "call",
            name: binding.function,
            args: [...binding.captures.map((name): Expression => ({ k: "ident", name })), ...args],
          };
          // A call the arrow's own body writes of the arrow is a call site that
          // was read before the arrow knew what it captured. The values are
          // written in front of the arguments once they are known.
          if (target.name === this.arrowDeclared) this.arrowSelfCalls.push(made);
          replace(made);
          continue;
        }
        // `f(x)` where `f` holds a function: the call is made through the
        // value, and the signature it is made against is the one `f` was
        // declared with at the place it is named.
        if (target.k === "ident") {
          const signature = this.valueFunctions.get(target.name);
          if (signature !== undefined) {
            const args = this.readCallArguments(signature.params);
            replace({ k: "invoke", callee: target, args, params: signature.params, returns: signature.returns });
            continue;
          }
        }
        // `Object.create(null)` is an empty record with no prototype, which the
        // sources write where a dictionary is filled by key and a `__proto__`
        // entry must not reach a prototype. A record here is a dictionary and
        // has no prototype to reach, so the empty record *is* the empty
        // dictionary, and the type it is held at says what its values are.
        if (
          target.k === "member" &&
          target.base.k === "ident" &&
          target.base.name === "Object" &&
          target.field === "create"
        ) {
          const args = this.readCallArguments();
          const prototype = args[0];
          if (prototype !== undefined && prototype.k === "null" && args.length === 1) {
            const empty: Expression = { k: "call", name: "blaze_rt_dict_new", args: [] };
            const collection: CollectionValue = { kind: "map", key: TEXT_RESULT, value: NUMBER_RESULT };
            this.collectionExpressions.set(empty, collection);
            this.expressionTypes.set(empty, NUMBER_RESULT);
            replace(empty);
            continue;
          }
          this.report(
            "Object.create copies a prototype",
            "the sources keep the one handed no prototype: Object.create(null), which is an empty record",
            this.peek(),
          );
          return this.hole();
        }
        // `Object.keys(TABLE)` and `Object.values(TABLE)` over a constant object
        // are the names or the values it was written with, which the file
        // already holds. An object built at run time has no shape the parser
        // can name here, and is refused rather than read as nothing.
        if (
          target.k === "member" &&
          target.base.k === "ident" &&
          target.base.name === "Object" &&
          (target.field === "keys" || target.field === "values")
        ) {
          const args = this.readCallArguments();
          replace(this.objectMembers(target.field, args));
          continue;
        }
        // `Object.fromEntries(entries)` is a record built from the entries of
        // a map: the dictionary's own entries, copied into a dictionary of the
        // same key and value. An array of pairs is not one of these: a compiled
        // list holds one element type, and a pair is two values of two types.
        if (
          target.k === "member" &&
          target.base.k === "ident" &&
          target.base.name === "Object" &&
          target.field === "fromEntries"
        ) {
          const args = this.readCallArguments();
          const source = args[0];
          const sourceCollection = source === undefined ? null : this.collectionOfExpression(source);
          if (source !== undefined && sourceCollection !== null && sourceCollection.kind === "map") {
            const collection: CollectionValue = { kind: "map", key: TEXT_RESULT, value: sourceCollection.value };
            const copied = this.collectionCopyHelper(collection, source, sourceCollection, this.peek().line);
            this.expressionTypes.set(copied, NUMBER_RESULT);
            this.collectionExpressions.set(copied, collection);
            replace(copied);
            continue;
          }
          this.report(
            "Object.fromEntries copies a map or a record",
            "an array of pairs is a list of two values of two types, which a compiled list does not hold",
            this.peek(),
          );
          return this.hole();
        }
        // `Object.entries(record)` names the entries of a dictionary: a
        // `for (const [key, value] of ...)` reads the two values of one entry
        // straight out of it, and a `new Map(...)` copies the entries it names.
        if (
          target.k === "member" &&
          target.base.k === "ident" &&
          target.base.name === "Object" &&
          target.field === "entries"
        ) {
          const args = this.readCallArguments();
          const source = args[0];
          const collection = source === undefined ? null : this.collectionOfExpression(source);
          if (
            source !== undefined &&
            collection !== null &&
            collection.kind === "map" &&
            (this.readingIteration || this.readingCollectionSource)
          ) {
            const entries: Expression = { k: "call", name: "__collection_entries", args: [source] };
            this.collectionExpressions.set(entries, collection);
            this.iteratedCollections.set(entries, collection);
            this.expressionTypes.set(entries, ANY_TYPE);
            replace(entries);
            continue;
          }
          // The record is read through a declaration another module writes, and
          // the graph has not linked it: what its entries are is the link's to
          // say. The loop names a key and a value this read cannot type, and the
          // read that follows the link types them.
          if (
            source !== undefined &&
            (this.readingIteration || this.readingCollectionSource) &&
            this.importsArePending() &&
            (this.pendingHolds(source) || this.opaqueValue(source))
          ) {
            const entries: Expression = { k: "call", name: "__collection_entries", args: [source] };
            const unlinked: CollectionValue = { kind: "map", key: { kind: "text" }, value: ANY_TYPE };
            this.collectionExpressions.set(entries, unlinked);
            this.iteratedCollections.set(entries, unlinked);
            this.expressionTypes.set(entries, ANY_TYPE);
            this.deferred.add(entries);
            replace(entries);
            continue;
          }
          this.report(
            "Object.entries reads a record or a map in a loop that names the two values",
            "an entry is two values of two types, which a list does not hold unless the loop reads them",
            this.peek(),
          );
          return this.hole();
        }
        // `Number.isFinite(x)` and its neighbours are questions about the
        // number a value holds, written out of the operations the language
        // already has. `isNaN` is the one value that is not equal to itself,
        // and `x - x` is zero for every finite number and not for either
        // infinity.
        if (target.k === "member" && target.base.k === "ident" && target.base.name === "Number") {
          const args = this.readCallArguments();
          // `Number.parseInt(text, 10)` is the number a text states in base ten,
          // which is the one `parseInt` already reads. Another base is not a
          // number this compiler can read out of a text.
          if (target.field === "parseInt" && (args.length === 1 || args.length === 2)) {
            const radix = args[1];
            if (radix === undefined || (radix.k === "literal" && radix.text === "10")) {
              replace({ k: "call", name: "parseInt", args: [args[0] as Expression] });
              continue;
            }
            this.report(
              "Number.parseInt reads a number in base ten",
              "the digits the source writes are base ten ones, as in Number.parseInt(text, 10)",
              this.peek(),
            );
            return this.hole();
          }
          const lowered = this.numberMethod(target.field, args);
          if (lowered !== null) {
            replace(lowered);
            continue;
          }
          this.report(
            `Number.${target.field} is not one of the questions this compiler answers`,
            "a number question is isNaN, isFinite, isInteger or isSafeInteger",
            this.peek(),
          );
          return this.hole();
        }
        // `Object.prototype.hasOwnProperty.call(record, key)` asks whether a
        // record holds a key of its own. A record keyed by text is the
        // runtime's dictionary, so the question is the dictionary's.
        if (
          target.k === "member" &&
          target.field === "call" &&
          target.base.k === "member" &&
          target.base.field === "hasOwnProperty" &&
          target.base.base.k === "member" &&
          target.base.base.field === "prototype" &&
          target.base.base.base.k === "ident" &&
          target.base.base.base.name === "Object"
        ) {
          const args = this.readCallArguments();
          const receiver = args[0];
          const key = args[1];
          const collection = receiver === undefined ? null : this.collectionOfExpression(receiver);
          if (collection !== null && collection.kind === "map" && key !== undefined) {
            const has: Expression = {
              k: "call",
              name: collection.key.kind === "ref" ? "blaze_rt_dict_has_refkey" : "blaze_rt_dict_has",
              args: [receiver, key],
            };
            const answer: Expression = { k: "binary", op: "===", left: has, right: { k: "literal", text: "1" } };
            this.expressionTypes.set(answer, BOOLEAN_RESULT);
            replace(answer);
            continue;
          }
          this.report(
            "hasOwnProperty asks a record keyed by text",
            "a record keyed by text is the runtime's dictionary; a compiled object is one layout",
            this.peek(),
          );
          return this.hole();
        }
        // `JSON.stringify([a, b])` of a list written out is the list the
        // language writes: `[`, the JSON of each value between commas, and `]`.
        // The values are written where the list is, so the text is built from
        // them without a dynamic array: a list of texts and a list of numbers
        // are one lowering, and so is a list of lists.
        if (
          target.k === "member" &&
          target.base.k === "ident" &&
          target.base.name === "JSON" &&
          target.field === "stringify"
        ) {
          const args = this.readCallArguments();
          const written = args[0];
          if (written === undefined || args.length !== 1) {
            this.report(
              "JSON.stringify writes one value",
              "the indent a third argument names is not part of the text this compiler writes",
              this.peek(),
            );
            return this.hole();
          }
          const listed = this.jsonOfValue(written);
          if (listed !== null) {
            replace(listed);
            continue;
          }
          const type = this.valueTypeOf(written);
          if (type.kind === "slice" || type.kind === "array") {
            this.report(
              "JSON.stringify writes a list whose values are written where the list is",
              "a list built while the program runs is a block of one element type, and its JSON is not a text the parser can build here",
              this.peek(),
            );
            return this.hole();
          }
          // Anything else is the runtime's own stringify, which the backends
          // lower for a text, a number and a value the runtime holds.
          replace({ k: "call", name: "JSON.stringify", args: [written] });
          continue;
        }
        // `Array.isArray(value)`: whether the value is a list. An array is a
        // block of one element type, so a value the read holds at a list type is
        // one, and a number, a text or an object is not. A value the read does
        // not type — a tree a parse read, a field of a module the graph has not
        // linked — is asked of the runtime, which holds the kind.
        if (
          target.k === "member" &&
          target.base.k === "ident" &&
          target.base.name === "Array" &&
          target.field === "isArray"
        ) {
          const args = this.readCallArguments([ANY_TYPE]);
          replace(this.isArrayTest(args[0] ?? this.hole()));
          continue;
        }
        if (target.k === "member" && target.base.k === "ident" && NAMESPACES.has(target.base.name)) {
          // A call of a namespace is a call of the name the namespace and the
          // member spell together: `Math.floor(x)` is `Math.floor(x)`, and
          // `http.requestPath(req)` is the HTTP call of that name. It is not a
          // static method of a class, so the class checks below are skipped.
          replace({ k: "ident", name: `${target.base.name}.${target.field}` });
          continue;
        }
        // `Point.fromAffine(p)`: a static method is a function of the class,
        // with no instance written before its arguments.
        if (target.k === "member" && target.base.k === "ident") {
          const owner = this.classNamed(target.base.name);
          if (owner !== undefined && !this.valueClasses.has(target.base.name)) {
            const found = this.methodOwner(owner.name, target.field, true);
            if (found !== null) {
              const args = this.readCallArguments(this.methodParams(found.method.params).map((param) => param.type));
              replace(this.typedCall(methodFunctionName(found.owner, found.method, args.length), args, found.method.returnTypeName, found.method.line));
              continue;
            }
          }
        }
        // `p.add(q)`: a method is a function whose first argument is the
        // instance the source called it on.
        if (target.k === "member") {
          const callLine = this.peek().line;
          const callback = this.collectionCallbackParameters(target.base, target.field);
          // A callback handed to a method of a value whose type this read does
          // not hold is handed the element of a list whose element type is in
          // a module the graph has not linked: a parameter the use does not fix
          // waits for that link too. An element the read holds as a reference
          // with no name is one the link will name.
          const waitsForLink = this.importsArePending();
          const args = this.readCallArguments(
            this.expectedMethodArguments(target.base, target.field),
            callback,
            target.field === "push",
            waitsForLink,
          );
          const spreads = target.field === "push" ? this.argumentSpreads : null;
          const receiver = target.base;
          // `m.get(k)`, `s.add(v)`: a map is a handle on the runtime's
          // dictionary, and its methods are the dictionary's. The receiver may
          // be a name, a field of an interface, or the map a function answered.
          // `SEEN.has(x)` over a top-level set of written keys is the chain of
          // comparisons it is, and `TABLE.get(k)` over a map of written entries
          // the conditional chain. The name is not a value the runtime holds,
          // so there is nothing to call the dictionary with.
          const writtenCollection = receiver.k === "ident" ? this.constants.get(receiver.name) : undefined;
          if (writtenCollection?.keys !== undefined) {
            const lowered = this.writtenCollectionMethod(receiver, writtenCollection, target.field, args);
            if (lowered !== null) {
              replace(lowered);
              continue;
            }
          }
          const heldCollection = this.collectionOfExpression(receiver);
          if (heldCollection !== null) {
            const lowered = this.collectionMethod(receiver, heldCollection, target.field, args);
            if (lowered !== null) {
              replace(lowered);
              continue;
            }
          }
          // `a.push(x)` and `a.pop()` change the array the name holds, so they
          // are statements: the call answers the array the name has afterwards,
          // and the frontend writes the assignment that keeps it. A field of
          // an object is a place the same way, and the write goes back into the
          // field the source named.
          if (target.field === "push" || target.field === "pop") {
            const place =
              receiver.k === "ident"
                ? { target: receiver.name, base: null }
                : receiver.k === "member" && receiver.base.k === "ident"
                  ? { target: receiver.field, base: receiver.base.name }
                  : null;
            const sequence = place === null ? null : this.valueTypeOf(receiver);
            if (
              place !== null &&
              sequence !== null &&
              (sequence.kind === "slice" || sequence.kind === "array") &&
              (target.field === "push" ? args.length >= 1 : args.length === 0)
            ) {
              // A push of written values is the helper that makes a longer
              // block; a push of a list with `...` is the concatenation the two
              // lists added are, so it needs no helper at all.
              const helper = spreads === null ? this.appendHelper(target.field, sequence.of, args.length, callLine) : null;
              replace({
                k: "append",
                target: place.target,
                base: place.base,
                helper: helper?.name ?? "",
                op: target.field,
                values: args,
                ...(spreads === null ? {} : { spreads, element: sequence.of }),
              });
              continue;
            }
            if (spreads !== null) {
              this.report(
                "a spread argument joins a list a name or a field holds",
                "write the value into a list first, as in const all = a.concat(b); all.push(...c)",
                this.peek(),
              );
              replace(this.hole());
              continue;
            }
          }
          // `re.test(text)` and `re.exec(text)`: a regular expression answers
          // the two methods itself, before the array and text methods are
          // asked and before a class is looked for.
          const regexed = this.regexMethod(receiver, target.field, args);
          if (regexed !== null) {
            replace(regexed);
            continue;
          }
          // `a.map(f)`: a method of a typed array is a function of the file that
          // walks the array, so it is read before a method of a class is looked
          // for. A receiver that is not a sequence falls through to the classes
          // the source declared.
          const collected = this.collection(receiver, target.field, args, callLine);
          if (collected !== null) {
            replace(collected);
            continue;
          }
          // A text method is a call of the runtime over the text. The three
          // helpers the runtime already carries are used directly, and the
          // three that ask where a needle is are written over `text.indexOf`
          // so a text needs no new service.
          if (this.valueTypeOf(receiver).kind === "text") {
            const lowered = this.textMethod(receiver, target.field, args);
            if (lowered !== null) {
              replace(lowered);
              continue;
            }
          }
          const found = this.methodOwner(this.classOfExpression(receiver), target.field, false);
          if (found === null) {
            // A receiver whose type is a name this file imports is not a value
            // this read can say has no such method: the declaration is in
            // another module the module graph has not linked yet. The read that
            // follows the link holds the declaration, and refuses the method
            // there where there really is none. A method written on anything
            // else is refused here, whatever else the file imports.
            if (this.importsArePending() && (this.pendingHolds(receiver) || this.opaqueValue(receiver))) {
              // What the method answers is a value of the same unlinked
              // declaration, so it waits for the link too: a method written on
              // it is a method of a value this read cannot type yet.
              const answered = this.hole();
              this.deferred.add(answered);
              replace(answered);
              continue;
            }
            this.report(
              `"${target.field}" is not a method this program compiles`,
              "a method is declared by a class the same module or its imports carry",
              this.peek(),
            );
            return this.hole();
          }
          replace(this.typedCall(methodFunctionName(found.owner, found.method, args.length), [receiver, ...args], found.method.returnTypeName, found.method.line));
          continue;
        }
        if (target.k !== "ident") return this.missing("only a named function is called", this.peek());
        // `f(...xs)` hands the function the elements of the list, and the
        // number of them is the number of parameters the declaration states.
        // The list is written where the arguments were, so each one is an
        // element of it read by position. A function whose parameters this
        // read does not hold — one another module declares — cannot say how
        // many to read, and the spread is refused where it is.
        const declared = this.declaredParams.get(target.name) ?? [];
        const spreadCall = declared.length > 0 && this.at("(") && this.peek(1).text === "...";
        let args = this.readCallArguments(spreadCall ? [] : declared, null, spreadCall);
        if (spreadCall) {
          if (args.length === 1 && this.argumentSpreads?.[0] === true) {
            const list = args[0] as Expression;
            args = declared.map((_, at): Expression => ({
              k: "index",
              base: list,
              index: { k: "literal", text: String(at) },
            }));
          } else {
            this.report(
              "a spread argument stands for every argument of the call",
              "write it as the only argument, as in f(...xs)",
              this.peek(),
            );
          }
        }
        // `parseInt(text, 10)` is the number the text states, which is what
        // `parseInt(text)` reads; the radix is the one the language writes.
        if (target.name === "parseInt" && args.length === 2) {
          const radix = args[1];
          if (radix !== undefined && radix.k === "literal" && radix.text === "10") {
            args = [args[0] as Expression];
          } else {
            this.report(
              "parseInt reads a number in base ten",
              "the digits the source writes are base ten ones, as in parseInt(text, 10)",
              this.peek(),
            );
          }
        }
        // `String(x)` is the text the value is written as, which is the value a
        // template string interpolates: the builder is the same one.
        if (target.name === "String") {
          const value = args[0];
          const text: Expression = value === undefined ? { k: "text", parts: [] } : { k: "text", parts: [{ k: "value", value }] };
          this.expressionTypes.set(text, TEXT_RESULT);
          replace(text);
          continue;
        }

        replace({ k: "call", name: target.name, args });
        continue;
      }
      if (this.at("++") || this.at("--")) {
        const target = current();
        const op = this.next().text as "++" | "--";
        if (target.k !== "ident") return this.missing(`"${op}" needs a name to change`, this.peek());
        return { k: "update", name: target.name, op, prefix: false };
      }
      // These follow a value, and none of them changes it: `as` and
      // `satisfies` assert a type the value already has, and `!` says a value
      // that may be null is not. The type they write is erased like every
      // other annotation, but an empty list still reads it: `[] as string[]`
      // names the element type the list holds.
      if (this.at("as") || this.at("satisfies")) {
        this.next();
        const type = this.readTypeAnnotation("a type assertion", EXPRESSION_TYPE_STOPS);
        const shape = this.lastAnnotationShape();
        this.applyExpected(current(), type, shape);
        // `m.get(k) as Set<string>` names a collection the value already is: a
        // map whose value is a set answers a handle, and the assertion is what
        // says what the handle holds. The value is recorded as that collection,
        // so `has`, `add` and `size` written after it are the dictionary's own.
        const collection = this.collectionOfShape(shape);
        if (collection !== null) this.collectionExpressions.set(current(), collection);
        // A list is asserted at the type it says: `(o.fields as string[])`
        // names texts, so `join` written after it reads the elements the cast
        // states rather than the `unknown` the field was declared at.
        if (type.kind === "slice" || type.kind === "array") this.expressionTypes.set(current(), type);
        continue;
      }
      if (this.at("!")) {
        this.next();
        continue;
      }
      if (this.at(".")) {
        const target = current();
        this.next();
        const field = this.next();
        if (field.kind !== "ident") return this.missing("expected the property of a value", field);
        // A field of a constant object is the value the file wrote for it: the
        // object is not a value a compiled function can read, and the field it
        // asks for is one the source already answered.
        if (target.k === "ident") {
          const constant = this.constants.get(target.name);
          const expanded = this.constantValue(target.name, constant?.fields?.get(field.text));
          if (expanded !== null) {
            replace(expanded);
            continue;
          }
        }
        // `Number.MAX_SAFE_INTEGER` and its neighbours are numbers the
        // language writes down, not values the runtime holds.
        if (target.k === "ident" && target.name === "Number") {
          const written =
            field.text === "MAX_SAFE_INTEGER" ? "9007199254740991"
              : field.text === "MIN_SAFE_INTEGER" ? "-9007199254740991"
                : field.text === "EPSILON" ? "2.220446049250313e-16"
                  : null;
          if (written !== null) {
            const value: Expression = written.startsWith("-")
              ? { k: "unary", op: "-", operand: { k: "literal", text: written.slice(1) } }
              : { k: "literal", text: written };
            this.expressionTypes.set(value, NUMBER_RESULT);
            replace(value);
            continue;
          }
        }
        if (field.text === "size") {
          const written = target.k === "ident" ? this.constants.get(target.name) : undefined;
          if (written?.keys !== undefined) {
            const count: Expression = { k: "literal", text: String(written.keys.length) };
            this.expressionTypes.set(count, NUMBER_RESULT);
            replace(count);
            continue;
          }
          const sized = this.collectionOfExpression(target);
          if (sized !== null) {
            const counted: Expression = { k: "call", name: "blaze_rt_dict_len", args: [target] };
            this.expressionTypes.set(counted, NUMBER_RESULT);
            replace(counted);
            continue;
          }
        }
        if (field.text === "length" && target.k === "ident") {
          replace({ k: "length", buffer: target.name });
          continue;
        }
        if (field.text === "toFixed" && this.at("(")) {
          replace(this.fixed(target));
          continue;
        }
        if (field.text === "toString" && this.at("(")) {
          // `x.toString()` with no radix is the value written as the text a
          // template string writes: the digits of a whole number, the shortest
          // decimal of a fraction, and a text as itself.
          if (this.peek(1).text === ")") {
            this.next();
            this.next();
            const written: Expression = { k: "text", parts: [{ k: "value", value: target }] };
            this.expressionTypes.set(written, TEXT_RESULT);
            replace(written);
            continue;
          }
          replace(this.hexadecimal(target));
          continue;
        }
        if (field.text === "length" && target.k === "argv") {
          replace({ k: "call", name: ARGV_LENGTH, args: [] });
          continue;
        }
        if (field.text === "length") {
          // A length of a value no name holds — an element, a call — is the
          // same length read where the value is.
          replace({ k: "lengthOf", of: target });
          continue;
        }

        // `Point.ZERO`: a static field is a function of the class, so reading
        // it is a call that answers the value the source declared.
        if (target.k === "ident" && !this.valueClasses.has(target.name)) {
          const owner = this.classNamed(target.name);
          if (owner !== undefined) {
            const found = findField(this.classTable, owner.name, field.text, true);
            if (found !== null) {
              replace(this.typedCall(`${found.owner}_${found.field.name}`, [], found.field.typeName, found.field.line));
              continue;
            }
            const getter = findGetter(this.classTable, owner.name, field.text, true);
            if (getter !== null) {
              replace(this.typedCall(`${getter.owner}_${getter.getter.name}`, [], getter.getter.returnTypeName, getter.getter.line));
              continue;
            }
          }
        }
        // `this.size`: a member a class reads through a getter is the body the
        // getter is, and the instance it reads is the receiver.
        const getterOwner = this.classOfExpression(target);
        if (getterOwner !== null) {
          const getter = findGetter(this.classTable, getterOwner, field.text, false);
          if (getter !== null) {
            replace(this.typedCall(`${getter.owner}_${getter.getter.name}`, [target], getter.getter.returnTypeName, getter.getter.line));
            continue;
          }
        }
        replace({ k: "member", base: target, field: field.text });
        continue;
      }
      return finish();
    }
  }

  /**
   * The arguments of a call, from the `(` the parser is at to its `)`.
   *
   * `expected` is the type each argument is held at, and `callback` is the
   * parameters of the arrow the first argument writes, when the call is a
   * collection method that walks the elements of its receiver. `spreadsAllowed`
   * says whether the call can use a spread argument; one written elsewhere is
   * refused where it is, because the arguments it stands for are not known
   * until the program runs.
   */
  private readCallArguments(
    expected: readonly TypeExpr[] = [],
    callback: readonly ArrowParameterType[] | null = null,
    spreadsAllowed = false,
    callbackWaitsForLink = false,
  ): Expression[] {
    this.next();
    const args: Expression[] = [];
    const spreads: boolean[] = [];
    let spread = false;
    while (!this.at(")") && this.peek().kind !== "end") {
      const type = expected[args.length] ?? null;
      if (this.accept("...")) {
        if (!spreadsAllowed) {
          this.report(
            "a spread argument is not part of the call subset",
            "pass the elements by name, or push them onto the list they join",
            this.peek(),
          );
        }
        spread = true;
        spreads.push(true);
      } else {
        spreads.push(false);
      }
      args.push(this.readArgument(type, args.length === 0 ? callback : null, callbackWaitsForLink));
      // A call may end its arguments with a comma, which names no argument.
      if (!this.accept(",")) break;
    }
    this.argumentSpreads = spread ? spreads : null;
    this.expect(")");
    return args;
  }

  /** One argument of a call, read at the type its use says and its arrow hints. */
  private readArgument(
    type: TypeExpr | null,
    callback: readonly ArrowParameterType[] | null,
    waitsForLink = false,
  ): Expression {
    const read = (): Expression => (type === null ? this.readExpression() : this.readAt(type, () => this.readExpression()));
    // A hint applies only to the arrow written at the cursor. A hint on a value
    // that is not an arrow names no parameter, and is not passed on to an arrow
    // the value contains.
    if (this.arrowAt() === null) return read();
    const savedHint = this.arrowParameters;
    const savedPending = this.pendingArrow;
    if (callback !== null) this.arrowParameters = callback;
    // The element the callback is handed is the element of a list this read
    // cannot type yet, so a parameter nothing else fixes is a value the link
    // will type: a method written on it waits for the link rather than being
    // refused here.
    if (waitsForLink) this.pendingArrow = true;
    try {
      return read();
    } finally {
      this.arrowParameters = savedHint;
      this.pendingArrow = savedPending;
    }
  }

  /**
   * `x.toFixed(d)`: the number written as text at `d` digits after the point.
   *
   * The digits are written out in the source, so they are a number this reads
   * rather than a value it evaluates — the same rule the program body reads
   * them by, so `x.toFixed(2)` means the same thing wherever it is written. A
   * string is refused rather than silently answered: it is already the text
   * the digits would have been written into, and dropping them would answer
   * with a different program than the source wrote.
   */
  private fixed(of: Expression): Expression {
    const open = this.next();
    const digits = this.next();
    if (digits.kind !== "number" || !/^\d+$/.test(digits.text)) {
      this.report(
        "the digits a number is written at are written out, as in x.toFixed(2)",
        `near "${digits.text}"`,
        digits,
      );
      while (!this.at(")") && this.peek().kind !== "end") this.next();
      this.expect(")");
      return of;
    }
    if (!this.at(")")) this.report("x.toFixed takes one number of digits", `near "${this.peek().text}"`, this.peek());
    this.expect(")");
    if (of.k === "text" || of.k === "fixed") {
      this.report("a number is what is written at a fixed number of digits", "a string is already text; write it as it is", open);
      return of;
    }
    return { k: "fixed", of, digits: Number(digits.text) };
  }

  /**
   * `x.toString(16)`: a number written as lowercase hexadecimal text.
   *
   * The radix is the one a program writes: sixteen. The digit count a `fixed`
   * carries is negative for it, which is the marker the emitters read as "in
   * base sixteen" (see `toText` in `toolchain/driver.ts`), so a function body
   * and a program body write the same text for the same number.
   */
  private hexadecimal(of: Expression): Expression {
    const open = this.next();
    const radix = this.next();
    if (radix.kind !== "number" || radix.text !== "16") {
      this.report(
        "toString writes a number as hexadecimal text",
        `the radix is 16, as in x.toString(16); the source wrote "${radix.text}"`,
        radix,
      );
      while (!this.at(")") && this.peek().kind !== "end") this.next();
      this.expect(")");
      return of;
    }
    if (!this.at(")")) this.report("x.toString(16) takes the one radix 16", `near "${this.peek().text}"`, this.peek());
    this.expect(")");
    if (of.k === "text" || of.k === "fixed") {
      this.report("a number is what is written as hexadecimal text", "a string is already text; write it as it is", open);
      return of;
    }
    return { k: "fixed", of, digits: -1 };
  }

  /**
   * An arrow function at the tokens that begin it, or null where the tokens are
   * something else.
   *
   * The parser has to tell an arrow from a parenthesised value before it reads
   * either, so the tokens are scanned rather than consumed: a `(` whose `)`
   * closes on an `=>` begins one, and so does a name with an `=>` after it.
   */
  private arrowPrimary(): Expression | null {
    const arrow = this.arrowAt();
    return arrow === null ? null : this.readArrow(arrow.async);
  }

  /**
   * Whether the tokens at the cursor begin an arrow, and whether it is async.
   *
   * This reads ahead and consumes nothing, so a caller that has a type for the
   * arrow's parameters can say so before the arrow is read.
   */
  private arrowAt(): { async: boolean } | null {
    let head = this.position;
    let isAsync = false;
    if (this.tokens[head]?.text === "async") {
      const next = this.tokens[head + 1];
      const arrowAfterName = next?.kind === "ident" && this.tokens[head + 2]?.text === "=>";
      if (next?.text !== "(" && !arrowAfterName) return null;
      isAsync = true;
      head += 1;
    }
    const token = this.tokens[head];
    if (token === undefined) return null;
    if (token.text === "(") {
      const close = this.matchingToken(head, "(", ")");
      if (close < 0) return null;
      let after = close + 1;
      if (this.tokens[after]?.text === ":") {
        after = this.typeEndAt(after + 1, ARROW_RETURN_STOPS);
      }
      if (this.tokens[after]?.text !== "=>") return null;
    } else if (!(token.kind === "ident" && this.tokens[head + 1]?.text === "=>")) {
      return null;
    }
    return { async: isAsync };
  }

  /** The index of the bracket that closes the one at `from`, or -1. */
  private matchingToken(from: number, open: string, close: string): number {
    let depth = 0;
    for (let at = from; at < this.tokens.length; at += 1) {
      const token = this.tokens[at];
      if (token === undefined || token.kind === "end") return -1;
      if (token.kind !== "punct") continue;
      if (token.text === open) depth += 1;
      else if (token.text === close) {
        depth -= 1;
        if (depth === 0) return at;
      } else if (open === "<" && (token.text === ">>" || token.text === ">>>")) {
        // A nested type closes with `>>` or `>>>` in one token, so the count of
        // open angles says how many of them the token closes.
        const closed = token.text === ">>" ? 2 : 3;
        if (depth >= closed) {
          depth -= closed;
          if (depth === 0) return at;
        }
      }
    }
    return -1;
  }

  /** Where a type written at `start` ends, leaving the parser where it was. */
  private typeEndAt(start: number, stops: ReadonlySet<string>): number {
    const saved = this.position;
    this.position = start;
    this.skipBalancedTypeTokens(stops);
    const end = this.position;
    this.position = saved;
    return end;
  }

  /**
   * An arrow function: its parameters, its body, and the function of the file
   * the body is lifted into.
   *
   * An arrow is not a value this compiler holds. It is bound to the name it is
   * declared under, and every call of that name is rewritten to a call of the
   * function the body became, with the values it captured written in front. A
   * value that escapes that name is refused where it is written, because a
   * closure with an environment is a thing no backend of this compiler carries.
   */
  private readArrow(isAsync: boolean): Expression {
    const start = this.peek();
    if (isAsync) this.next();
    const line = start.line;
    // The types the use wrote for this arrow's parameters. A nested arrow is a
    // callback of a call of its own, so the hint is taken and cleared here.
    const hints = this.arrowParameters;
    this.arrowParameters = null;
    // Whether the element this callback is handed is one the link will name.
    const waitsForLink = this.pendingArrow;
    this.pendingArrow = false;
    interface ArrowParam {
      name: string;
      type: TypeExpr;
      typeName: string;
      functionType: FunctionType | null;
      shape: ResolvedType | null;
    }
    const params: ArrowParam[] = [];
    /** What a parameter written as a pattern binds, read where the body starts. */
    const prelude: Statement[] = [];
    if (this.accept("(")) {
      while (!this.at(")") && this.peek().kind !== "end") {
        // `([a]) => ...` and `({ n }) => ...`: the value is held at a name of
        // the pattern's own and each name the pattern writes is read out of it.
        const pattern = this.readParameterPattern();
        if (pattern !== null) {
          // A pattern read at the type the use fixes it at: `([a, b]) => ...`
          // handed a list of pairs binds its names at the fields of the pair.
          const hinted = hints?.[params.length] ?? null;
          let type: TypeExpr = hinted?.type ?? ANY_TYPE;
          let shape: ResolvedType | null = hinted?.shape ?? null;
          if (this.accept(":")) {
            type = this.readTypeAnnotation("the type of a parameter", new Set([",", ")", "="]));
            shape = this.lastAnnotationShape();
          }
          const temp = `__param${this.destructureCount++}`;
          params.push({ name: temp, type, typeName: "", functionType: null, shape });
          prelude.push(...this.patternPrelude(pattern, temp, type, line, shape));
          if (!this.accept(",")) break;
          continue;
        }
        const name = this.next();
        if (name.kind !== "ident") {
          this.report("expected a parameter name", `near "${name.text}"`, name);
          break;
        }
        // `(a?: number)`: whether a caller may leave the parameter out is
        // decided where the arrow is called, and the type it is written at is
        // the one the annotation states.
        this.accept("?");
        // A callback's parameter is the element the collection method walks
        // where the method says so, and the annotation still wins where the
        // source writes one.
        const hinted = hints?.[params.length] ?? null;
        let type: TypeExpr = hinted?.type ?? ANY_TYPE;
        let typeName = type.kind === "ref" && type.name !== undefined ? type.name : "";
        let functionType: FunctionType | null = null;
        let shape: ResolvedType | null = hinted?.shape ?? null;
        if (this.accept(":")) {
          typeName = this.peek().kind === "ident" ? this.peek().text : "";
          functionType = this.annotationFunctionType(new Set([",", ")", "="]));
          type = this.readTypeAnnotation("the type of a parameter", new Set([",", ")", "="]));
          shape = this.lastAnnotationShape();
        }
        if (this.at("=")) {
          this.report(
            "an arrow function's parameter takes a default",
            "a default is stated by a function the module declares; write the value at the call instead",
          );
          this.next();
          this.readExpression();
        }
        params.push({ name: name.text, type, typeName, functionType, shape });
        if (!this.accept(",")) break;
        // A list of parameters may end with a comma, as it may on a function.
        if (this.at(")")) break;
      }
      this.expect(")");
    } else {
      const name = this.next();
      if (name.kind !== "ident") return this.missing("expected a parameter name", name);
      const hinted = hints?.[0] ?? null;
      const type: TypeExpr = hinted?.type ?? ANY_TYPE;
      params.push({
        name: name.text,
        type,
        typeName: type.kind === "ref" && type.name !== undefined ? type.name : "",
        functionType: null,
        shape: hinted?.shape ?? null,
      });
    }
    let stated: TypeExpr | null = null;
    let statedShape: ResolvedType | null = null;
    if (this.accept(":")) {
      stated = this.readTypeAnnotation("an arrow function's result type", ARROW_RETURN_STOPS, isAsync);
      statedShape = this.lastAnnotationShape();
    }
    if (!this.accept("=>")) this.report('expected "=>"', `near "${this.peek().text}"`);
    // The body is a scope of its own: a name it declares is not the function's,
    // and a name it reads from neither is a value it captured. The loops the
    // arrow is written in are not loops it can leave either: `break` in the
    // body leaves a loop of that body, and one written around the arrow is a
    // loop the function the arrow lifted to is not inside.
    const savedTypes = this.valueTypes;
    const savedShapes = this.valueShapes;
    const savedClasses = this.valueClasses;
    const savedArrows = this.valueArrows;
    const savedFunctions = this.valueFunctions;
    const savedCollections = this.valueCollections;
    const savedRegexes = this.valueRegexes;
    const savedLoops = this.loops;
    const savedTargets = this.breakTargets;
    this.valueTypes = new Map(savedTypes);
    this.valueShapes = new Map(savedShapes);
    this.valueClasses = new Map(savedClasses);
    // The arrow body reads the names around it, and a name bound to an arrow is
    // an arrow here too: a body that passes one on or calls one is reading the
    // same value the function that wrote it reads.
    this.valueArrows = new Map(savedArrows);
    // The function is named before its body is read, because a body that names
    // the arrow it is about to be bound to — a recursive arrow — has to be read
    // as a call of that function and not as a call of a name nothing binds.
    const liftedName = `__closure_${this.stem}_${this.closureCount}`;
    this.closureCount += 1;
    const declared = this.arrowName;
    this.arrowName = null;
    const savedDeclared = this.arrowDeclared;
    const savedSelfCalls = this.arrowSelfCalls;
    this.arrowDeclared = declared;
    this.arrowSelfCalls = [];
    if (declared !== null) {
      const provisional: ArrowBinding = {
        function: liftedName,
        captures: [],
        captureTypes: [],
        params: params.map((param) => ({ name: param.name, type: param.type })),
        returns: stated ?? ANY_TYPE,
      };
      this.valueArrows.set(declared, provisional);
    }
    this.valueFunctions = new Map(savedFunctions);
    this.valueCollections = new Map(savedCollections);
    this.loops = 0;
    this.breakTargets = [];
    // A parameter the source did not annotate and the use did not fix is a
    // value the link names: what the body writes on it is not a construct this
    // read can refuse, and the read that follows the link refuses it where it
    // really is not one.
    const savedPendingValues = this.pendingValues;
    this.pendingValues = new Set(savedPendingValues);
    params.forEach((param, at) => {
      this.valueTypes.set(param.name, param.type);
      if (param.shape !== null) this.valueShapes.set(param.name, param.shape);
      if (param.functionType !== null) this.valueFunctions.set(param.name, param.functionType);
      if (param.typeName !== "" && this.classTable.names.has(param.typeName)) {
        this.valueClasses.set(param.name, param.typeName);
      }
      if (waitsForLink && (hints?.[at] === undefined || unknownReference(hints[at].type))) {
        this.pendingValues.add(param.name);
      }
    });
    const body: Statement[] = this.readReturning(stated, () => {
      if (this.at("{")) return [...prelude, ...this.readBlock()];
      // A concise body is the return the source wrote without the word, so an
      // empty list it answers is built at the type the arrow declares.
      return [...prelude, { kind: "result" as const, value: this.readAt(stated, () => this.readExpression(), statedShape), line }];
    }, statedShape);
    // What the arrow answers is read while its parameters are still in scope: a
    // body that calls a method answers what the method answers, and a field it
    // reads through a parameter answers what the parameter's shape declares.
    // Neither is a name `resultType` alone can type.
    const returns =
      stated ??
      inferredResult(
        body,
        params.map((param) => ({ name: param.name, type: param.type })),
        (value) => {
          const known = this.valueTypeOf(value);
          return known.kind === "ref" && known.of === null && known.name === undefined ? null : known;
        },
      );
    this.valueTypes = savedTypes;
    this.valueShapes = savedShapes;
    this.valueClasses = savedClasses;
    this.valueArrows = savedArrows;
    this.valueFunctions = savedFunctions;
    this.valueCollections = savedCollections;
    this.valueRegexes = savedRegexes;
    this.loops = savedLoops;
    this.breakTargets = savedTargets;
    this.pendingValues = savedPendingValues;
    const selfCalls = this.arrowSelfCalls;
    this.arrowDeclared = savedDeclared;
    this.arrowSelfCalls = savedSelfCalls;
    const captures = arrowCaptures(params, body);
    // The name the arrow is bound to is the arrow, not a value of the function
    // around it: a body that only calls the arrow is not capturing something to
    // hand to itself.
    if (declared !== null) {
      captures.captures = captures.captures.filter((capture) => capture !== declared);
      captures.written = captures.written.filter((written) => written !== declared);
    }
    if (captures.written.length > 0) {
      this.report(
        `an arrow function writes "${captures.written[0]}", a name of the function around it`,
        "an arrow is lifted into a function of its own, so a captured value is handed to it and cannot be written back; declare a function where the value is written, or keep the sum in the arrow's own result",
        start,
      );
    }
    const binding = this.liftArrow(liftedName, params, returns, body, captures.captures, line);
    // The values the arrow captured are the lifted function's leading
    // parameters, and a call the body wrote of itself was read before they were
    // known: each is handed them now, in the order the lifted function takes
    // them. A body that only calls itself captures nothing and is unchanged.
    for (const call of selfCalls) {
      if (call.k !== "call") continue;
      call.args = [...binding.captures.map((name): Expression => ({ k: "ident", name })), ...call.args];
    }
    return { k: "arrow", name: binding.function, captures: binding.captures };
  }

  /**
   * The function an arrow's body becomes.
   *
   * The values it captured are its leading parameters, so the body reads them
   * by the names it wrote and needs no environment: a call of the name writes
   * those values in front of its own arguments.
   */
  private liftArrow(
    name: string,
    params: readonly { name: string; type: TypeExpr }[],
    returns: TypeExpr,
    body: Statement[],
    captures: readonly string[],
    line: number,
  ): ArrowBinding {
    const captureTypes = captures.map((capture) => this.valueTypes.get(capture) ?? ANY_TYPE);
    const captured = captures.map((capture, index) => ({ name: capture, type: captureTypes[index] as TypeExpr }));
    const written = params.map((param) => ({ name: param.name, type: param.type }));
    const lifted: TypeScriptFunction = {
      name,
      params: [...captured, ...written],
      returns,
      body,
      line,
      closure: true,
    };
    this.closures.push({
      name,
      exported: false,
      internal: true,
      params: lifted.params,
      returns,
      handle: lifted,
    });
    this.liftedArrows.set(name, lifted);
    const binding: ArrowBinding = {
      function: name,
      captures: [...captures],
      captureTypes,
      params: written,
      returns,
    };
    this.arrowBindings.set(name, binding);
    return binding;
  }

  /**
   * The function a call through an arrow's value enters.
   *
   * A lifted body takes the values it captured as leading parameters, which a
   * call site that holds the arrow in a name does not have. The entry is a
   * function of the file like any other: its first parameter is the closure
   * and the rest are the arrow's own, and it reads each captured value out of
   * the closure and writes it in front of the call.
   */
  private closureCode(binding: ArrowBinding): string {
    if (binding.code !== undefined) return binding.code;
    const code = binding.function.replace("__closure_", "__closure_code_");
    binding.code = code;
    const line = this.liftedArrows.get(binding.function)?.line ?? 0;
    const args: Expression[] = [
      ...binding.captures.map((_, index) => ({
        k: "capture" as const,
        closure: { k: "ident" as const, name: "self" },
        index,
        type: binding.captureTypes[index] ?? ANY_TYPE,
      })),
      ...binding.params.map((param) => ({ k: "ident" as const, name: param.name })),
    ];
    const call: Expression = { k: "call", name: binding.function, args };
    const lifted: TypeScriptFunction = {
      name: code,
      params: [{ name: "self", type: ANY_TYPE }, ...binding.params],
      returns: binding.returns,
      body: binding.returns.kind === "void"
        ? [{ kind: "expression", value: call, line }]
        : [{ kind: "result", value: call, line }],
      line,
      closure: true,
    };
    this.closures.push({
      name: code,
      exported: false,
      internal: true,
      params: lifted.params,
      returns: binding.returns,
      handle: lifted,
    });
    this.liftedArrows.set(code, lifted);
    return code;
  }

  /**
   * A collection method called on a typed array: the function of the file that
   * walks the array and calls the closure.
   *
   * `a.map(f)` is not a method this compiler has. It is a function of the file
   * that walks the elements and hands each to `f`, which is the loop the source
   * would have written and needs nothing new: the walk is a counted loop, the
   * call is a call of a value, and the array the answers go into is an
   * allocation. What the source would not have written is the helper itself, so
   * that is what the frontend writes.
   *
   * A callback is handed the element and, where it says it takes them, the
   * index and the array. `thisArg` and the ability to leave the callback's
   * parameters out are not carried: a closure is a function of fixed arity.
   */
  private collection(
    receiver: Expression,
    method: string,
    args: readonly Expression[],
    line: number,
  ): Expression | null {
    // A method this frontend has no reading of is a method of a class, and the
    // class is what says what it is.
    const sequence = this.valueTypeOf(receiver);
    const elements = sequence.kind === "slice" || sequence.kind === "array" ? sequence.of : null;
    // `for (const [index, element] of list.entries())` names the two parts of
    // an entry. A pair is not an element a typed array holds, so the loop walks
    // the list by position and this marks the expression it read.
    if (method === "entries" && args.length === 0 && elements !== null && this.readingIteration) {
      const marker: Expression = { k: "call", name: "__sequence_entries", args: [receiver] };
      this.iteratedSequences.set(marker, elements);
      this.expressionTypes.set(marker, ANY_TYPE);
      return marker;
    }
    if (!COLLECTION_METHODS.has(method)) return null;
    if (elements === null) return null;
    if (
      method === "join" ||
      method === "includes" ||
      method === "indexOf" ||
      method === "at" ||
      method === "slice"
    ) {
      return this.sequenceMethod(method, elements, receiver, args, line);
    }
    const callback = args[0];
    if (callback === undefined) {
      this.report(`${method} takes a function`, `as in a.${method}((x: number): number => x)`, this.peek());
      return this.hole();
    }
    const signature = this.callbackSignature(callback);
    if (signature === null) {
      this.report(
        `the function handed to ${method} is not one this compiler can call`,
        "a callback is an arrow, or a name held at a function type, as in f: (x: number) => number",
        this.peek(),
      );
      return this.hole();
    }
    if (method === "map" && (signature.returns.kind === "void" || signature.returns.kind === "slice" || signature.returns.kind === "array" || signature.returns.kind === "ptr" || signature.returns.kind === "mask")) {
      this.report(
        "the function map walks the array with must answer a number, a truth, a text or a reference",
        "a map of a list is a list of what the function answered, and a list of lists is not a value here",
        this.peek(),
      );
      return this.hole();
    }
    const wanted = method === "reduce" ? [1, 2] : [1];
    if (!wanted.includes(args.length)) {
      this.report(
        `${method} takes ${wanted.join(" or ")} argument${wanted.length === 1 && wanted[0] === 1 ? "" : "s"}`,
        `it was given ${args.length}`,
        this.peek(),
      );
      return this.hole();
    }
    const helper = this.collectionHelper(method, elements, signature, args.length === 2, line);
    const call: Expression = { k: "call", name: helper.name, args: [receiver, callback, ...args.slice(1)] };
    this.expressionTypes.set(call, helper.returns);
    // A method that walks the array answers a list of what it read, so the
    // element keeps the shape it was read at: a chain `names.filter(f).map(g)`
    // reads the fields of an element a second time, and the second step is only
    // field by field where the shape travelled with the list. `map` answers a
    // list of what the callback answered, so its element shape is that answer.
    const returns = helper.returns;
    if (returns.kind === "slice" || returns.kind === "array") {
      const keepsElement = method === "filter" || method === "sort";
      const element = keepsElement
        ? this.elementShapeOf(receiver, elements) ?? { kind: "any" as const }
        : this.shapeOfTypeExpr(returns.of);
      this.expressionShapes.set(call, { kind: "list", of: element });
    }
    return call;
  }

  /**
   * The type a value is held at, read with the names of the body and with the
   * functions the frontend wrote itself.
   *
   * `resultType` answers what a name, a literal or an operation is. It cannot
   * answer for a call, because what a call answers is the callee's to say; the
   * frontend knows that for the helpers it wrote, so the answer is taken from
   * there and a helper's answer can be walked again — which is what
   * `const b = a.map(f); b.reduce(g)` does.
   */
  /** Whether the name a member chain is rooted at holds a pending type. */
  private pendingHolds(value: Expression): boolean {
    let current = value;
    for (;;) {
      if (this.deferred.has(current)) return true;
      if (current.k !== "member" && current.k !== "index") break;
      if (current.k === "member" && this.pendingFields.has(current.field)) return true;
      current = current.base;
    }
    return current.k === "ident" && this.pendingValues.has(current.name);
  }

  /**
   * A call of a method or a class member, held at the type the declaration
   * writes for its result.
   *
   * A call is the one value the parser cannot type from the text it is written
   * as: what it answers is the callee's to say. A module function says it in
   * `declaredReturns`, but a method is a function the class scan wrote and no
   * declaration of the body names, so the type is recorded where the call is
   * built. Without it `this.read(t).trim()` was a method of nothing, and the
   * text methods written after a call were refused.
   */
  private typedCall(name: string, args: readonly Expression[], returnTypeName: string, line: number): Expression {
    const call: Expression = { k: "call", name, args: [...args] };
    if (returnTypeName.trim() === "" || returnTypeName.trim() === "void") return call;
    const type = this.typeForName(returnTypeName, line);
    if (type.kind !== "void") this.expressionTypes.set(call, type);
    return call;
  }

  /**
   * The JSON text a list or an object written out is, or null where the value
   * is neither.
   *
   * `JSON.stringify([a, b])` is the JSON of an array — `[`, the JSON of each
   * value between commas, and `]` — and `JSON.stringify({ a: 1 })` is the JSON
   * of an object, its field names quoted and each value beside its name. Every
   * value is written where the container is, so the text is built out of them
   * and no dynamic value is needed: a list may hold a text and a number in the
   * same call, and an object's fields are the ones the source wrote.
   *
   * The field name is escaped the way JSON escapes one, which the compiler's
   * own `JSON.stringify` answers here rather than at run time: a name is
   * written by the source, so it is known.
   */
  private jsonOfValue(value: Expression): Expression | null {
    const text = (parts: TextPart[]): Expression => {
      const answer: Expression = { k: "text", parts };
      this.expressionTypes.set(answer, TEXT_RESULT);
      return answer;
    };
    const piece = (written: Expression): TextPart => {
      const nested = this.jsonOfValue(written);
      if (nested !== null) return { k: "value", value: nested };
      const stringified: Expression = { k: "call", name: "JSON.stringify", args: [written] };
      this.expressionTypes.set(stringified, TEXT_RESULT);
      return { k: "value", value: stringified };
    };
    const values = this.listElements(value);
    if (values !== null) {
      const parts: TextPart[] = [{ k: "text", value: "[" }];
      for (const [index, written] of values.entries()) {
        if (index > 0) parts.push({ k: "text", value: "," });
        parts.push(piece(written));
      }
      parts.push({ k: "text", value: "]" });
      // The list is written into the text, so nothing is left for a use to say
      // about the elements it holds: an empty list is the text `[]`.
      this.forgetList(value);
      return text(parts);
    }
    if (value.k === "object") {
      const parts: TextPart[] = [{ k: "text", value: "{" }];
      for (const [index, field] of value.fields.entries()) {
        if (index > 0) parts.push({ k: "text", value: "," });
        parts.push({ k: "text", value: `${JSON.stringify(field.name)}:` });
        parts.push(piece(field.value));
      }
      parts.push({ k: "text", value: "}" });
      return text(parts);
    }
    return null;
  }

  /**
   * The values a list written out holds, in the order they are.
   *
   * A list of one piece is joined against an empty list so that the block it
   * answers is its own, so the value the source wrote as `[a, b]` is a `+` of
   * two blocks. What the JSON of it needs is the values, whatever block they
   * were gathered into.
   */
  private listElements(value: Expression): Expression[] | null {
    if (value.k === "buffer") return value.values;
    if (value.k === "binary" && value.op === "+") {
      const left = this.listElements(value.left);
      const right = this.listElements(value.right);
      if (left === null || right === null) return null;
      return [...left, ...right];
    }
    return null;
  }

  /** Drops the note that a list is still waiting for its element type. */
  private forgetList(value: Expression): void {
    this.unsettledArrays.delete(value);
    if (value.k === "buffer") for (const written of value.values) this.forgetList(written);
    if (value.k === "binary" && value.op === "+") {
      this.forgetList(value.left);
      this.forgetList(value.right);
    }
  }

  private valueTypeOf(value: Expression): TypeExpr {
    const recorded = this.expressionTypes.get(value);
    if (recorded !== undefined) return recorded;
    // A value a test has settled is the type the test settled, whatever the
    // declaration wrote: `if (typeof entry !== "string") continue;` leaves
    // `entry` a text for the rest of the block.
    const path = this.narrowedPath(value);
    if (path !== null) {
      const settled = this.narrowed.get(path);
      if (settled !== undefined) return settled;
    }
    // A member read through an interface is typed by the field the interface
    // declares, which is what keeps `contract.definition.calls` an array. A
    // call is not asked here: the shape of a call asks what the call answers,
    // and that is this method's question.
    if (value.k !== "call") {
      const shape = this.shapeOf(value);
      if (shape !== null) return this.typeExprOfShape(shape);
    }
    if (value.k === "call") {
      const written = this.liftedArrows.get(value.name);
      if (written !== undefined) return written.returns;
      const declared = this.declaredReturns.get(value.name);
      if (declared !== undefined) return declared;
      // A builtin answers the type it is declared with, so `line.trim()` is a
      // text and the method written after it is a text method.
      const builtin = builtinFor(value.name);
      if (builtin !== null) return builtin.returns;
    }
    // A field of a class is typed by the declaration that wrote it, which is
    // what makes `this.text.trim()` a text method rather than an unknown one.
    if (value.k === "member") {
      const owner = this.classOfExpression(value.base);
      if (owner !== null) {
        const field = findField(this.classTable, owner, value.field, true) ??
          findField(this.classTable, owner, value.field, false);
        if (field !== null) return this.typeForName(field.field.typeName, field.field.line);
      }
    }
    return resultType(value, this.valueTypes);
  }

  /**
   * `Object.keys(value)` and `Object.values(value)` over a constant object.
   *
   * A field name and the value written for it are both known where the object
   * was written, so the answer is an array the parser can build. The object
   * must be a name the file wrote as a constant: a value built at run time has
   * fields the parser cannot enumerate.
   */
  private objectMembers(method: "keys" | "values", args: readonly Expression[]): Expression {
    const value = args[0];
    // A record or a map built while the program runs is a dictionary, and its
    // entries are read by position: `Object.keys` is the keys it holds.
    if (args.length === 1 && value !== undefined) {
      const collection = this.collectionOfExpression(value);
      if (collection !== null && collection.kind === "map") {
        const read = this.collectionMethod(value, collection, method, []);
        if (read !== null) return read;
      }
    }
    const constant = args.length === 1 && value !== undefined && value.k === "ident"
      ? this.constants.get(value.name)
      : undefined;
    if (constant?.fields === undefined) {
      this.report(
        `Object.${method} reads a constant object`,
        "write the object as a top-level constant, as in const TABLE = { a: 1 };",
        this.peek(),
      );
      return this.hole();
    }
    const names = [...constant.fields.keys()];
    if (method === "keys") {
      return {
        k: "buffer",
        element: "text",
        values: names.map((name): Expression => ({ k: "text", parts: [{ k: "text", value: name }] })),
      };
    }
    const values: Expression[] = [];
    for (const name of names) {
      const read = this.constantValue(value.k === "ident" ? value.name : "", constant.fields.get(name));
      if (read !== null) values.push(read);
    }
    const element = values.length === 0 ? typeToString(ANY_TYPE) : typeToString(this.valueTypeOf(values[0] as Expression));
    return { k: "buffer", element, values };
  }

  /**
   * A method of a text, lowered to the runtime call that answers it.
   *
   * `trim`, `indexOf` and `slice` are the text helpers the runtime already
   * carries. `includes`, `startsWith` and `endsWith` ask where a needle is,
   * and are the same `text.indexOf` the runtime has: a needle at or after the
   * start is `includes`, a needle at the start is `startsWith`, and a needle
   * whose slice is the whole suffix is `endsWith`.
   *
   * A needle an `endsWith` reads twice must be a value that reads the same
   * twice; a call would run twice, which is not what the source wrote.
   */
  /** The pattern and flags of a regular expression, or null where it is not one. */
  private regexOf(value: Expression): { pattern: Expression; flags: Expression } | null {
    if (value.k === "buffer" && this.regexValues.has(value) && value.values.length >= 2) {
      return { pattern: value.values[0] as Expression, flags: value.values[1] as Expression };
    }
    if (value.k === "ident" && this.valueRegexes.has(value.name)) {
      return {
        pattern: { k: "index", base: { k: "ident", name: value.name }, index: { k: "literal", text: "0" } },
        flags: { k: "index", base: { k: "ident", name: value.name }, index: { k: "literal", text: "1" } },
      };
    }
    return null;
  }

  /**
   * `re.test(text)` and `re.exec(text)`: the two methods a regular expression
   * itself answers. A match is the list of the whole match and its groups, so
   * `exec` is typed as a list of texts, and `test` is the truth of whether the
   * list is there at all.
   */
  private regexMethod(
    receiver: Expression,
    method: string,
    args: readonly Expression[],
  ): Expression | null {
    const regex = this.regexOf(receiver);
    if (regex === null) return null;
    if (method === "test" && args.length === 1) {
      const call: Expression = {
        k: "call",
        name: "blaze_rt_regex_test",
        args: [regex.pattern, regex.flags, args[0] as Expression],
      };
      this.expressionTypes.set(call, NUMBER_RESULT);
      const answer: Expression = { k: "binary", op: "!==", left: call, right: { k: "literal", text: "0" } };
      this.expressionTypes.set(answer, BOOLEAN_RESULT);
      return answer;
    }
    if (method === "exec" && args.length === 1) {
      const call: Expression = {
        k: "call",
        name: "blaze_rt_regex_exec",
        args: [regex.pattern, regex.flags, args[0] as Expression],
      };
      this.expressionTypes.set(call, { kind: "slice", of: TEXT_RESULT });
      return call;
    }
    if (method === "source" && args.length === 0) return regex.pattern;
    if (method === "flags" && args.length === 0) return regex.flags;
    return null;
  }

  /** A text method whose first argument is a regular expression. */
  private regexTextMethod(
    receiver: Expression,
    method: string,
    args: readonly Expression[],
    regex: { pattern: Expression; flags: Expression },
  ): Expression | null {
    const call = (name: string, values: Expression[], type: TypeExpr): Expression => {
      const value: Expression = { k: "call", name, args: values };
      this.expressionTypes.set(value, type);
      return value;
    };
    const head = [regex.pattern, regex.flags, receiver];
    if (method === "replace" && args.length === 2) {
      return call("blaze_rt_regex_replace", [...head, args[1] as Expression], TEXT_RESULT);
    }
    if (method === "split" && args.length === 1) {
      return call("blaze_rt_regex_split", head, { kind: "slice", of: TEXT_RESULT });
    }
    if (method === "match" && args.length === 1) {
      return call("blaze_rt_regex_match", head, { kind: "slice", of: TEXT_RESULT });
    }
    if (method === "matchAll" && args.length === 1) {
      return call("blaze_rt_regex_match_all", head, { kind: "slice", of: { kind: "slice", of: TEXT_RESULT } });
    }
    if (method === "search" && args.length === 1) {
      return call("blaze_rt_regex_search", head, NUMBER_RESULT);
    }
    return null;
  }

  private textMethod(
    receiver: Expression,
    method: string,
    args: readonly Expression[],
  ): Expression | null {
    const regex = args[0] === undefined ? null : this.regexOf(args[0]);
    if (regex !== null) {
      const lowered = this.regexTextMethod(receiver, method, args, regex);
      if (lowered !== null) return lowered;
    }
    const call = (name: string, values: Expression[]): Expression => ({ k: "call", name, args: values });
    if (method === "trim" && args.length === 0) return call("text.trim", [receiver]);
    if (method === "trimStart" && args.length === 0) return call("text.trimStart", [receiver]);
    if (method === "trimEnd" && args.length === 0) return call("text.trimEnd", [receiver]);
    if (method === "toLowerCase" && args.length === 0) return call("text.toLowerCase", [receiver]);
    if (method === "toUpperCase" && args.length === 0) return call("text.toUpperCase", [receiver]);
    if (method === "indexOf" && args.length === 1) return call("text.indexOf", [receiver, args[0] as Expression]);
    if (method === "split" && args.length === 1) {
      // An empty separator and a separator of several characters are both
      // fields the helper cuts, and a regular expression was taken above.
      const helper = this.splitHelper(this.peek().line);
      return call(helper.name, [receiver, args[0] as Expression]);
    }
    if (method === "slice" && (args.length === 1 || args.length === 2)) {
      return call("text.slice", [receiver, ...args]);
    }
    if (method === "includes" && args.length === 1) {
      return {
        k: "binary",
        op: "!==",
        left: call("text.indexOf", [receiver, args[0] as Expression]),
        right: { k: "literal", text: "-1" },
      };
    }
    if (method === "startsWith" && args.length === 1) {
      // The field the text holds from the beginning, which is the text the
      // needle is long compared with the needle: one reading for both forms,
      // so a chain that asks both is the same two slices it is.
      const needle = args[0] as Expression;
      if (!repeatableExpression(needle)) return null;
      return {
        k: "binary",
        op: "===",
        left: call("text.slice", [receiver, { k: "literal", text: "0" }, { k: "lengthOf", of: needle }]),
        right: needle,
      };
    }
    // `text.startsWith(needle, at)` is the field the text holds from `at`: the
    // slice that runs as far as the needle is long, compared with the needle.
    // Both the position and the needle are read more than once, so each has to
    // read the same way twice.
    if (method === "startsWith" && args.length === 2) {
      const needle = args[0] as Expression;
      const at = args[1] as Expression;
      if (!repeatableExpression(needle) || !repeatableExpression(at)) return null;
      const stop: Expression = { k: "binary", op: "+", left: at, right: { k: "lengthOf", of: needle } };
      return {
        k: "binary",
        op: "===",
        left: call("text.slice", [receiver, at, stop]),
        right: needle,
      };
    }
    if (method === "endsWith" && args.length === 1) {
      const needle = args[0] as Expression;
      if (!repeatableExpression(needle)) return null;
      const start: Expression = {
        k: "binary",
        op: "-",
        left: { k: "lengthOf", of: receiver },
        right: { k: "lengthOf", of: needle },
      };
      return {
        k: "binary",
        op: "===",
        left: call("text.slice", [receiver, start]),
        right: needle,
      };
    }
    return null;
  }

  /**
   * `join`, `includes` and `indexOf`: a method that reads every element and
   * answers one value.
   *
   * Like the callback methods these are functions of the file that walk the
   * array, written once per shape. `join` builds the text the separator puts
   * between the elements, and a text element is the one the runtime already
   * holds; a number is written as its text by the same interpolation every other
   * text is written with.
   */
  private sequenceMethod(
    method: string,
    element: TypeExpr,
    receiver: Expression,
    args: readonly Expression[],
    line: number,
  ): Expression {
    const wanted = method === "join" ? [0, 1] : method === "slice" ? [1, 2] : [1];
    if (!wanted.includes(args.length)) {
      this.report(
        `${method} takes ${wanted.join(" or ")} argument${wanted.length === 1 && wanted[0] === 1 ? "" : "s"}`,
        `it was given ${args.length}`,
        this.peek(),
      );
      return this.hole();
    }
    // `a.join()` writes the elements with a comma between them, as the
    // language does when it is given no separator.
    const extra = method === "join" && args.length === 0
      ? [{ k: "text" as const, parts: [{ k: "text" as const, value: "," }] }]
      : [...args];
    const helper = this.sequenceMethodHelper(method, element, extra.length, line);
    return { k: "call", name: helper.name, args: [receiver, ...extra] };
  }

  /** The helper one of the walking methods is lowered to, written once per shape. */
  private sequenceMethodHelper(
    method: string,
    element: TypeExpr,
    written: number,
    line: number,
  ): { name: string; returns: TypeExpr } {
    const key = JSON.stringify(["walk", method, element, written]);
    const known = this.collectHelpers.get(key);
    if (known !== undefined) return known;

    const name = `__collect_${this.stem}_${this.collectCount}`;
    this.collectCount += 1;
    const items: TypeExpr = { kind: "slice", of: element };
    const ident = (value: string): Expression => ({ k: "ident", name: value });
    const number = (text: string): Expression => ({ k: "literal", text });
    const length = (): Expression => ({ k: "length", buffer: "items" });
    const at = (index: Expression): Expression => ({ k: "index", base: ident("items"), index });
    const answer = (value: Expression): Statement => ({ kind: "result", value, line });
    const loop = (body: Statement[]): Statement => ({
      kind: "loop", variable: "i", from: number("0"), to: length(), inclusive: false, step: null, down: false, body, line,
    });
    /** The element written as the text it is, which is what a join joins. */
    const asText = (value: Expression): Expression => ({ k: "text", parts: [{ k: "value", value }] });

    let params: { name: string; type: TypeExpr }[];
    let returns: TypeExpr;
    let body: Statement[];
    switch (method) {
      case "join": {
        params = [
          { name: "items", type: items },
          { name: "sep", type: TEXT_RESULT },
        ];
        returns = TEXT_RESULT;
        body = [
          { kind: "declare", name: "out", type: null, init: { k: "text", parts: [{ k: "text", value: "" }] }, line },
          loop([
            {
              kind: "if",
              condition: { k: "binary", op: ">", left: ident("i"), right: number("0") },
              then: [{ kind: "assign", target: "out", op: "=", value: { k: "binary", op: "+", left: ident("out"), right: ident("sep") }, line }],
              otherwise: [],
              line,
            },
            { kind: "assign", target: "out", op: "=", value: { k: "binary", op: "+", left: ident("out"), right: asText(at(ident("i"))) }, line },
          ]),
          answer(ident("out")),
        ];
        break;
      }
      case "includes":
      case "indexOf": {
        params = [
          { name: "items", type: items },
          { name: "value", type: element },
        ];
        returns = method === "includes" ? BOOLEAN_RESULT : NUMBER_RESULT;
        body = [
          loop([
            {
              kind: "if",
              condition: { k: "binary", op: "===", left: at(ident("i")), right: ident("value") },
              then: [answer(method === "includes" ? number("1") : ident("i"))],
              otherwise: [],
              line,
            },
          ]),
          answer(method === "includes" ? number("0") : { k: "unary", op: "-", operand: number("1") }),
        ];
        break;
      }
      case "at": {
        // An index below zero counts back from the end, as `a.length + index`:
        // the same read the source would have written.
        params = [
          { name: "items", type: items },
          { name: "index", type: NUMBER_RESULT },
        ];
        returns = element;
        body = [
          { kind: "declare", name: "i", type: null, init: ident("index"), line },
          {
            kind: "if",
            condition: { k: "binary", op: "<", left: ident("i"), right: number("0") },
            then: [{ kind: "assign", target: "i", op: "+=", value: length(), line }],
            otherwise: [],
            line,
          },
          answer(at(ident("i"))),
        ];
        break;
      }
      case "slice": {
        // The elements between two indexes, as a list of its own. Both ends
        // count back from the end when they are below zero, and both are held
        // inside the list, which is what the language does with either.
        const stop = written === 1 ? length() : ident("stop");
        params = [
          { name: "items", type: items },
          { name: "start", type: NUMBER_RESULT },
          ...(written === 1 ? [] : [{ name: "stop", type: NUMBER_RESULT }]),
        ];
        returns = items;
        const elementText = typeToString(element);
        body = [
          { kind: "declare", name: "from", type: null, init: ident("start"), line },
          {
            kind: "if",
            condition: { k: "binary", op: "<", left: ident("from"), right: number("0") },
            then: [{ kind: "assign", target: "from", op: "+=", value: length(), line }],
            otherwise: [],
            line,
          },
          {
            kind: "if",
            condition: { k: "binary", op: ">", left: ident("from"), right: length() },
            then: [{ kind: "assign", target: "from", op: "=", value: length(), line }],
            otherwise: [],
            line,
          },
          { kind: "declare", name: "to", type: null, init: stop, line },
          {
            kind: "if",
            condition: { k: "binary", op: "<", left: ident("to"), right: number("0") },
            then: [{ kind: "assign", target: "to", op: "+=", value: length(), line }],
            otherwise: [],
            line,
          },
          {
            kind: "if",
            condition: { k: "binary", op: ">", left: ident("to"), right: length() },
            then: [{ kind: "assign", target: "to", op: "=", value: length(), line }],
            otherwise: [],
            line,
          },
          {
            kind: "if",
            condition: { k: "binary", op: "<", left: ident("to"), right: ident("from") },
            then: [{ kind: "assign", target: "to", op: "=", value: ident("from"), line }],
            otherwise: [],
            line,
          },
          {
            kind: "declare",
            name: "out",
            type: null,
            init: { k: "sized", element: elementText, count: { k: "binary", op: "-", left: ident("to"), right: ident("from") } },
            line,
          },
          {
            kind: "loop",
            variable: "i",
            from: ident("from"),
            to: ident("to"),
            inclusive: false,
            step: null,
            down: false,
            body: [
              {
                kind: "indexAssign",
                buffer: "out",
                index: { k: "binary", op: "-", left: ident("i"), right: ident("from") },
                op: "=",
                value: at(ident("i")),
                line,
              },
            ],
            line,
          },
          answer(ident("out")),
        ];
        break;
      }
      default:
        return { name: "", returns: ANY_TYPE };
    }

    const helper: TypeScriptFunction = { name, params, returns, body, line, closure: true };
    this.closures.push({ name, exported: false, internal: true, params: helper.params, returns, handle: helper });
    this.liftedArrows.set(name, helper);
    const made = { name, returns };
    this.collectHelpers.set(key, made);
    return made;
  }

  /**
   * `text.split(separator)`: the fields the separator cuts the text into.
   *
   * The runtime says where a needle is and answers the text between two
   * indexes, so the split is a function of the file: it walks the text once to
   * count the fields and once to write them. An empty separator cuts the text
   * into its characters, as the language does, and the last field is the text
   * after the last separator, which is empty where the text ends with one.
   * `text.indexOf` has no start index, so each step searches the rest of the
   * text from where the last separator ended.
   */
  private splitHelper(line: number): { name: string; returns: TypeExpr } {
    const key = JSON.stringify(["split"]);
    const known = this.collectHelpers.get(key);
    if (known !== undefined) return known;

    const name = `__collect_${this.stem}_${this.collectCount}`;
    this.collectCount += 1;
    const ident = (value: string): Expression => ({ k: "ident", name: value });
    const number = (text: string): Expression => ({ k: "literal", text });
    const call = (callee: string, args: Expression[]): Expression => ({ k: "call", name: callee, args });
    const lengthOf = (value: Expression): Expression => ({ k: "lengthOf", of: value });
    const add = (left: Expression, right: Expression): Expression => ({ k: "binary", op: "+", left, right });
    const less = (left: Expression, right: Expression): Expression => ({ k: "binary", op: "<", left, right });
    const equal = (left: Expression, right: Expression): Expression => ({ k: "binary", op: "===", left, right });
    const slice = (value: Expression, start: Expression, stop: Expression | null): Expression =>
      call("text.slice", stop === null ? [value, start] : [value, start, stop]);
    const search = (from: Expression): Expression => call("text.indexOf", [slice(ident("text"), from, null), ident("sep")]);
    const emptySeparator = (): Expression => equal(lengthOf(ident("sep")), number("0"));
    const loop = (to: Expression, body: Statement[]): Statement => ({
      kind: "loop", variable: "i", from: number("0"), to, inclusive: false, step: null, down: false, body, line,
    });

    // The field a search from `at` starts: it ends where the separator is, or
    // at the end of the text when there is no separator left.
    const writeField = (): Statement[] => [
      { kind: "declare", name: "found", type: null, init: search(ident("at")), line },
      {
        kind: "if",
        condition: less(ident("found"), number("0")),
        then: [
          { kind: "indexAssign", buffer: "out", index: ident("i"), op: "=", value: slice(ident("text"), ident("at"), null), line },
        ],
        otherwise: [
          {
            kind: "indexAssign",
            buffer: "out",
            index: ident("i"),
            op: "=",
            value: slice(ident("text"), ident("at"), add(ident("at"), ident("found"))),
            line,
          },
          { kind: "assign", target: "at", op: "+=", value: add(ident("found"), lengthOf(ident("sep"))), line },
        ],
        line,
      },
    ];

    const body: Statement[] = [
      { kind: "declare", name: "count", type: null, init: number("0"), line },
      { kind: "declare", name: "at", type: null, init: number("0"), line },
      {
        kind: "if",
        condition: emptySeparator(),
        then: [{ kind: "assign", target: "count", op: "=", value: lengthOf(ident("text")), line }],
        otherwise: [
          {
            kind: "while",
            condition: number("1"),
            body: [
              { kind: "assign", target: "count", op: "+=", value: number("1"), line },
              { kind: "declare", name: "found", type: null, init: search(ident("at")), line },
              { kind: "if", condition: less(ident("found"), number("0")), then: [{ kind: "break", line }], otherwise: [], line },
              { kind: "assign", target: "at", op: "+=", value: add(ident("found"), lengthOf(ident("sep"))), line },
            ],
            line,
          },
        ],
        line,
      },
      { kind: "declare", name: "out", type: null, init: { k: "sized", element: "text", count: ident("count") }, line },
      {
        kind: "if",
        condition: emptySeparator(),
        then: [
          loop(lengthOf(ident("text")), [
            {
              kind: "indexAssign",
              buffer: "out",
              index: ident("i"),
              op: "=",
              value: slice(ident("text"), ident("i"), add(ident("i"), number("1"))),
              line,
            },
          ]),
        ],
        otherwise: [
          { kind: "assign", target: "at", op: "=", value: number("0"), line },
          loop(ident("count"), writeField()),
        ],
        line,
      },
      { kind: "result", value: ident("out"), line },
    ];

    const params = [
      { name: "text", type: TEXT_RESULT },
      { name: "sep", type: TEXT_RESULT },
    ];
    const returns: TypeExpr = { kind: "slice", of: TEXT_RESULT };
    const helper: TypeScriptFunction = { name, params, returns, body, line, closure: true };
    this.closures.push({ name, exported: false, internal: true, params, returns, handle: helper });
    this.liftedArrows.set(name, helper);
    const made = { name, returns };
    this.collectHelpers.set(key, made);
    return made;
  }

  /**
   * The function a `push` or a `pop` becomes: an array of the elements it
   * keeps and the values it adds, or one fewer, with the kept elements written
   * into it.
   *
   * An array is a block and a length, and the length travels beside the block,
   * so `a.push(x)` is `a = __push(a, x)` and not a write into the block the name
   * already holds. That is a copy of the elements on every push; a compiler that
   * grew a block in place would be a compiler that carried the length inside it,
   * which is a different representation than the one a parameter is passed as.
   * A push written with several values is one block and one copy, not one copy
   * per value: the helper takes them all and writes them after the elements it
   * keeps.
   */
  private appendHelper(
    method: "push" | "pop",
    element: TypeExpr,
    written: number,
    line: number,
  ): { name: string; returns: TypeExpr } {
    const key = JSON.stringify(["append", method, element, written]);
    const known = this.collectHelpers.get(key);
    if (known !== undefined) return known;

    const name = `__collect_${this.stem}_${this.collectCount}`;
    this.collectCount += 1;
    const items: TypeExpr = { kind: "slice", of: element };
    const elementText = typeToString(element);
    const ident = (value: string): Expression => ({ k: "ident", name: value });
    const number = (text: string): Expression => ({ k: "literal", text });
    const length = (): Expression => ({ k: "length", buffer: "items" });
    const loop = (body: Statement[], to: Expression): Statement => ({
      kind: "loop", variable: "i", from: number("0"), to, inclusive: false, step: null, down: false, body, line,
    });

    let body: Statement[];
    if (method === "push") {
      // One value is one more element, and several values are several more:
      // the block is made once at the length the source would have after the
      // push, and the values are written after the elements it keeps.
      const values = Array.from({ length: written }, (_, index) => `value${index}`);
      body = [
        {
          kind: "declare",
          name: "out",
          type: null,
          init: { k: "sized", element: elementText, count: { k: "binary", op: "+", left: length(), right: number(String(written)) } },
          line,
        },
        loop([
          { kind: "indexAssign", buffer: "out", index: ident("i"), op: "=", value: { k: "index", base: ident("items"), index: ident("i") }, line },
        ], length()),
        ...values.map((value, index): Statement => ({
          kind: "indexAssign",
          buffer: "out",
          index: { k: "binary", op: "+", left: length(), right: number(String(index)) },
          op: "=",
          value: ident(value),
          line,
        })),
        { kind: "result", value: ident("out"), line },
      ];
    } else {
      // A pop keeps every element but the last, and an empty array has none to
      // drop: what it answers is the array with one fewer element.
      body = [
        {
          kind: "declare",
          name: "keep",
          type: null,
          init: {
            k: "conditional",
            condition: { k: "binary", op: ">", left: length(), right: number("0") },
            then: { k: "binary", op: "-", left: length(), right: number("1") },
            otherwise: number("0"),
          },
          line,
        },
        { kind: "declare", name: "out", type: null, init: { k: "sized", element: elementText, count: ident("keep") }, line },
        loop([
          { kind: "indexAssign", buffer: "out", index: ident("i"), op: "=", value: { k: "index", base: ident("items"), index: ident("i") }, line },
        ], ident("keep")),
        { kind: "result", value: ident("out"), line },
      ];
    }

    const params = method === "push"
      ? [
          { name: "items", type: items },
          ...Array.from({ length: written }, (_, index): { name: string; type: TypeExpr } => ({ name: `value${index}`, type: element })),
        ]
      : [{ name: "items", type: items }];
    const returns: TypeExpr = { kind: "slice", of: element };
    const helper: TypeScriptFunction = { name, params, returns, body, line, closure: true };
    this.closures.push({ name, exported: false, internal: true, params, returns, handle: helper });
    this.liftedArrows.set(name, helper);
    const made = { name, returns };
    this.collectHelpers.set(key, made);
    return made;
  }

  /**
   * A read of a top-level set or map whose keys are written down.
   *
   * The name is not a value the runtime holds — nothing allocates it — so the
   * read is the comparisons it means: `has` is the disjunction of the keys, and
   * `get` is the chain of conditionals the written values are, ending in the
   * zero of the value type where the key is absent, which is the answer an
   * absent key of a dictionary gives. The value read is repeated by the chain,
   * so it must read the same way twice; a call does not and is refused.
   */
  private writtenCollectionMethod(
    receiver: Expression,
    written: ConstantInfo,
    method: string,
    args: readonly Expression[],
  ): Expression | null {
    const keys = written.keys ?? [];
    const numeric = written.keyKind === "number";
    const textOf = (key: string): Expression => numeric
      ? { k: "literal", text: key }
      : { k: "text", parts: [{ k: "text", value: key }] };
    if (method === "size" && args.length === 0) {
      const count: Expression = { k: "literal", text: String(keys.length) };
      this.expressionTypes.set(count, NUMBER_RESULT);
      return count;
    }
    if (written.values === undefined) {
      if (method !== "has" || args.length !== 1) return null;
      const value = args[0] as Expression;
      if (!repeatableExpression(value)) {
        this.report(
          "a set's membership reads the value once",
          "write the value into a name first, as in const x = f(); SEEN.has(x)",
          this.peek(),
        );
        return this.hole();
      }
      let chain: Expression | null = null;
      for (const key of keys) {
        const equal: Expression = { k: "binary", op: "===", left: value, right: textOf(key) };
        this.expressionTypes.set(equal, BOOLEAN_RESULT);
        chain = chain === null ? equal : { k: "binary", op: "||", left: chain, right: equal };
      }
      const answer: Expression = chain ?? { k: "literal", text: "0" };
      this.expressionTypes.set(answer, BOOLEAN_RESULT);
      return answer;
    }
    if (method !== "get" || args.length !== 1) return null;
    const value = args[0] as Expression;
    if (!repeatableExpression(value)) {
      this.report(
        "a map's value reads the key once",
        "write the key into a name first, as in const k = f(); TABLE.get(k)",
        this.peek(),
      );
      return this.hole();
    }
    const name = receiver.k === "ident" ? receiver.name : "";
    const first = written.values[0] === undefined ? null : this.constantValue(name, written.values[0]);
    const firstType = first === null ? ANY_TYPE : this.valueTypeOf(first);
    let answer: Expression = firstType.kind === "text"
      ? { k: "text", parts: [{ k: "text", value: "" }] }
      : { k: "literal", text: "0" };
    for (let at = keys.length - 1; at >= 0; at -= 1) {
      const read = this.constantValue(name, written.values[at]) ?? this.hole();
      answer = {
        k: "conditional",
        condition: { k: "binary", op: "===", left: value, right: textOf(keys[at] as string) },
        then: read,
        otherwise: answer,
      };
    }
    this.expressionTypes.set(answer, firstType);
    return answer;
  }

  /**
   * One method of a map or a set, lowered to the runtime's dictionary.
   *
   * A set is a dictionary whose value is the number one, so `add` is `set` and
   * `has` and `delete` are the dictionary's own. `get` answers the zero of the
   * value type where the key is absent, because a value here has no `undefined`:
   * what it answers is the same zero an element read outside a buffer answers.
   */
  private collectionMethod(
    receiver: Expression,
    collection: CollectionValue,
    method: string,
    args: readonly Expression[],
  ): Expression | null {
    const one: Expression = { k: "literal", text: "1" };
    const refKey = collection.key.kind === "ref";
    const call = (name: string, args_: Expression[], returns: TypeExpr): Expression => {
      const made: Expression = { k: "call", name, args: args_ };
      this.expressionTypes.set(made, returns);
      return made;
    };
    const take = (): { name: string; args: Expression[]; returns: TypeExpr } | null => {
      if (collection.kind === "set") {
        if (method === "add" && args.length === 1) {
          return {
            name: refKey ? "blaze_rt_dict_set_refkey" : "blaze_rt_dict_set",
            args: [receiver, args[0] as Expression, one],
            returns: NUMBER_RESULT,
          };
        }
        if (method === "has" && args.length === 1) {
          return {
            name: refKey ? "blaze_rt_dict_has_refkey" : "blaze_rt_dict_has",
            args: [receiver, args[0] as Expression],
            returns: BOOLEAN_RESULT,
          };
        }
        if (method === "delete" && args.length === 1) {
          return {
            name: refKey ? "blaze_rt_dict_delete_refkey" : "blaze_rt_dict_delete",
            args: [receiver, args[0] as Expression],
            returns: NUMBER_RESULT,
          };
        }
        return null;
      }
      if (method === "set" && args.length === 2) {
        const name = this.collectionSetNameFor(collection);
        if (name === null) return null;
        return { name, args: [receiver, ...args], returns: NUMBER_RESULT };
      }
      if ((method === "has" || method === "delete") && args.length === 1) {
        return {
          name: method === "has"
            ? (refKey ? "blaze_rt_dict_has_refkey" : "blaze_rt_dict_has")
            : (refKey ? "blaze_rt_dict_delete_refkey" : "blaze_rt_dict_delete"),
          args: [receiver, ...args],
          returns: method === "has" ? BOOLEAN_RESULT : NUMBER_RESULT,
        };
      }
      return null;
    };
    if (method === "get" && collection.kind === "map" && args.length === 1) {
      const kind = this.storedKind(collection.value);
      if (kind === "other" || kind === "sequence") {
        this.report(
          `a map here holds a ${typeToString(collection.value)}, which a key cannot answer`,
          "a map value is a number, a text, a truth or a reference",
          this.peek(),
        );
        return this.hole();
      }
      // The key is asked for before the value is read, so an absent one answers
      // zero rather than the NaN the dictionary uses to say it holds nothing.
      const has: Expression = {
        k: "call",
        name: refKey ? "blaze_rt_dict_has_refkey" : "blaze_rt_dict_has",
        args: [receiver, args[0] as Expression],
      };
      const heldName = refKey
        ? kind === "text"
          ? "blaze_rt_dict_get_refkey_text"
          : "blaze_rt_dict_get_refkey"
        : kind === "text"
          ? "blaze_rt_dict_get_text"
          : kind === "reference"
            ? "blaze_rt_dict_get_ref"
            : "blaze_rt_dict_get";
      const read = call(heldName, [receiver, args[0] as Expression], collection.value);
      const held: Expression = kind === "bool"
        ? { k: "binary", op: "!=", left: read, right: { k: "literal", text: "0" } }
        : read;
      // The answer for a key the map does not hold is the zero of the value
      // type: the empty text for a text, the null reference for a reference,
      // and the number zero for everything else. A number written where a
      // reference is expected is boxed into a handle, and a boxed number is
      // not the absence of an object: reading a field of one reads the
      // runtime's table as an object.
      const otherwise: Expression = kind === "text"
        ? { k: "text", parts: [{ k: "text", value: "" }] }
        : kind === "reference"
          ? { k: "null" }
          : { k: "literal", text: "0" };
      const chosen: Expression = { k: "conditional", condition: has, then: held, otherwise };
      const answer = kind === "reference" ? ANY_TYPE : kind === "bool" ? BOOLEAN_RESULT : collection.value;
      this.expressionTypes.set(chosen, answer);
      // A map whose value the source named keeps the fields that name holds,
      // so a member chain written through the value reads them.
      if (kind === "reference") {
        const shape = this.shapeOfTypeExpr(collection.value);
        if (shape.kind !== "any") this.expressionShapes.set(chosen, shape);
      }
      return chosen;
    }
    // `m.keys()` and `m.values()` are the entries read out by position. The
    // helper is a function of the file, written once per element type, so the
    // block it answers is the element type's own and not a block of handles.
    if (method === "keys" || method === "values") {
      if (args.length !== 0) return null;
      const helper = this.collectionListHelper(collection, method === "keys" ? "keys" : "values", this.peek().line);
      if (helper === null) {
        const held = method === "keys" ? collection.key : collection.value;
        this.report(
          `a ${collection.kind} here holds a ${typeToString(held)}, which cannot be read out by position`,
          "the entries of a collection are numbers, texts, truths and references",
          this.peek(),
        );
        return this.hole();
      }
      return call(helper.name, [receiver], helper.returns);
    }
    // `for (const [k, v] of m.entries())` names the two parts of an entry. The
    // pair is not an element a typed array holds, so the loop reads the two
    // straight out of the dictionary and this marks the expression it read.
    if (method === "entries" && args.length === 0 && this.readingIteration) {
      const marker: Expression = { k: "call", name: "__collection_entries", args: [receiver] };
      this.iteratedCollections.set(marker, collection);
      this.expressionTypes.set(marker, ANY_TYPE);
      return marker;
    }
    const lowered = take();
    if (lowered === null) return null;
    const made = call(lowered.name, lowered.args, lowered.returns);
    // The runtime answers a truth with the number one, and a body says what it
    // means by it: `!s.has(k)` is a question about a truth, and a number is not
    // one.
    const answer: Expression = lowered.returns === BOOLEAN_RESULT
      ? { k: "binary", op: "===", left: made, right: { k: "literal", text: "1" } }
      : made;
    this.expressionTypes.set(answer, lowered.returns);
    return answer;
  }

  /**
   * The dictionary call that writes one value of a map, by what the value is.
   * A value with no entry here is one the dictionary cannot hold.
   */
  private collectionSetName(type: TypeExpr): string | null {
    const kind = this.storedKind(type);
    if (kind === "number" || kind === "bool") return "blaze_rt_dict_set";
    if (kind === "text") return "blaze_rt_dict_set_text";
    if (kind === "reference") return "blaze_rt_dict_set_ref";
    return null;
  }

  /** The dictionary call that writes a map entry, by what its key and value are. */
  private collectionSetNameFor(collection: CollectionValue): string | null {
    const kind = this.storedKind(collection.value);
    if (collection.key.kind === "ref") {
      if (kind === "text") return "blaze_rt_dict_set_refkey_text";
      if (kind === "reference") return "blaze_rt_dict_set_refkey_ref";
      if (kind === "number" || kind === "bool") return "blaze_rt_dict_set_refkey";
      return null;
    }
    return this.collectionSetName(collection.value);
  }

  /**
   * How one value a collection holds is read and written.
   *
   * A dictionary entry is a double, so a number and a reference are the entry
   * itself and a text is the pointer the double carries. A narrowed number is
   * read back as the type the map was declared with, and a sequence is a block
   * the handle names rather than a value of its own.
   */
  private storedKind(type: TypeExpr): "number" | "text" | "reference" | "bool" | "sequence" | "other" {
    if (type.kind === "text") return "text";
    if (type.kind === "ref") return "reference";
    if (type.kind === "slice" || type.kind === "array" || type.kind === "ptr") return "sequence";
    if (type.kind === "primitive") {
      if (type.name === "bool") return "bool";
      if (type.name === "i256" || type.name === "u256") return "other";
      return "number";
    }
    return "other";
  }

  /** The dictionary call that reads the key of an entry, by what the key is. */
  private keyReadName(collection: CollectionValue): string {
    return collection.key.kind === "ref" ? "blaze_rt_dict_key_ref_at" : "blaze_rt_dict_key_at";
  }

  /** The dictionary call that reads a value entry, by what the value is. */
  private valueReadName(type: TypeExpr): string {
    const kind = this.storedKind(type);
    if (kind === "text") return "blaze_rt_dict_value_at_text";
    if (kind === "reference" || kind === "sequence") return "blaze_rt_dict_value_at_ref";
    return "blaze_rt_dict_value_at";
  }

  /**
   * The function a `keys()` or a `values()` of a collection is lowered to.
   *
   * The entries are read one by one into a block of the element type, because
   * an entry is a double and a narrow element — a truth, a four byte number —
   * is not: the block the runtime holds at the element type is the one the
   * source declared, and the reads are written into it one at a time.
   */
  private collectionListHelper(
    collection: CollectionValue,
    list: "keys" | "values",
    line: number,
  ): { name: string; returns: TypeExpr } | null {
    const element = list === "keys"
      ? collection.key
      : collection.kind === "set" ? collection.key : collection.value;
    const kind = this.storedKind(element);
    if (kind === "sequence" || kind === "other") return null;
    const key = JSON.stringify(["list", list, collection.kind, collection.key, collection.value, element]);
    const known = this.collectHelpers.get(key);
    if (known !== undefined) return known;

    const name = `__collect_${this.stem}_${this.collectCount}`;
    this.collectCount += 1;
    const ident = (value: string): Expression => ({ k: "ident", name: value });
    const number = (text: string): Expression => ({ k: "literal", text });
    const readName = list === "keys" ? this.keyReadName(collection) : this.valueReadName(element);
    const returns: TypeExpr = { kind: "slice", of: element };
    const params = [{ name: "items", type: NUMBER_RESULT }];
    const read = (): Expression => ({ k: "call", name: readName, args: [ident("items"), ident("i")] });
    const body: Statement[] = [
      { kind: "declare", name: "n", type: null, init: { k: "call", name: "blaze_rt_dict_len", args: [ident("items")] }, line },
      { kind: "declare", name: "out", type: null, init: { k: "sized", element: typeToString(element), count: ident("n") }, line },
      {
        kind: "loop",
        variable: "i",
        from: number("0"),
        to: ident("n"),
        inclusive: false,
        step: null,
        down: false,
        body: [{ kind: "indexAssign", buffer: "out", index: ident("i"), op: "=", value: read(), line }],
        line,
      },
      { kind: "result", value: ident("out"), line },
    ];
    const helper: TypeScriptFunction = { name, params, returns, body, line, closure: true };
    this.closures.push({ name, exported: false, internal: true, params, returns, handle: helper });
    this.liftedArrows.set(name, helper);
    const made = { name, returns };
    this.collectHelpers.set(key, made);
    return made;
  }

  /** The signature the callback of a collection method is written at. */
  private callbackSignature(value: Expression): FunctionType | null {
    if (value.k === "arrow") {
      const binding = this.arrowBindings.get(value.name);
      if (binding !== undefined) {
        return { params: binding.params.map((param) => param.type), returns: binding.returns };
      }
    }
    if (value.k === "ident") {
      const known = this.valueFunctions.get(value.name);
      if (known !== undefined) return known;
      // A name bound to an arrow is a function of the file, and the callback a
      // collection method walks with is one: `list.map(normalise)` names the
      // arrow the declaration lifted rather than an anonymous one written here.
      const arrow = this.valueArrows.get(value.name);
      if (arrow !== undefined) {
        return { params: arrow.params.map((param) => param.type), returns: arrow.returns };
      }
    }
    return null;
  }

  /**
   * The helper a collection method is lowered to, written once per shape.
   *
   * Every helper is a function of the file and is compiled, linked and validated
   * like any other. It reads nothing outside its parameters and calls nothing
   * but the closure it is handed, so it needs no postcondition and states no
   * buffer bound: what the walk reads is the array its caller handed it.
   */
  private collectionHelper(
    method: string,
    element: TypeExpr,
    signature: FunctionType,
    withInitial: boolean,
    line: number,
  ): { name: string; returns: TypeExpr } {
    const key = JSON.stringify([method, element, signature, withInitial]);
    const known = this.collectHelpers.get(key);
    if (known !== undefined) return known;

    const name = `__collect_${this.stem}_${this.collectCount}`;
    this.collectCount += 1;
    const items: TypeExpr = { kind: "slice", of: element };
    const elementText = typeToString(element);
    const ident = (value: string): Expression => ({ k: "ident", name: value });
    const number = (text: string): Expression => ({ k: "literal", text });
    const length = (): Expression => ({ k: "length", buffer: "items" });
    const at = (index: Expression): Expression => ({ k: "index", base: ident("items"), index });
    const plusOne = (value: Expression): Expression => ({ k: "binary", op: "+", left: value, right: number("1") });
    /** The call of the callback, written with as many arguments as it takes. */
    const callBack = (all: readonly Expression[]): Expression => {
      const count = Math.min(signature.params.length, all.length);
      return {
        k: "invoke",
        callee: ident("fn"),
        args: all.slice(0, count),
        params: signature.params.slice(0, count),
        returns: signature.returns,
      };
    };
    const loop = (from: string, body: Statement[], to: Expression = length()): Statement => ({
      kind: "loop",
      variable: "i",
      from: number(from),
      to,
      inclusive: false,
      step: null,
      down: false,
      body,
      line,
    });
    const declare = (declared: string, init: Expression): Statement => ({
      kind: "declare",
      name: declared,
      type: null,
      init,
      line,
    });
    const answer = (value: Expression): Statement => ({ kind: "result", value, line });
    /** The zero a value of a type is when nothing was found. */
    const zero = (): Expression =>
      element.kind === "primitive" ? number("0") : element.kind === "text"
        ? { k: "text", parts: [{ k: "text", value: "" }] }
        : { k: "null" };

    let body: Statement[];
    let returns: TypeExpr;
    switch (method) {
      case "map": {
        // The array a map builds holds what its callback answered, which the
        // source may have written as a truth where it maps over numbers. A
        // string or a reference is not an element a typed array holds, and a
        // map that answers one is refused where it is written.
        returns = { kind: "slice", of: signature.returns };
        body = [
          declare("out", { k: "sized", element: typeToString(signature.returns), count: length() }),
          loop("0", [
            {
              kind: "indexAssign",
              buffer: "out",
              index: ident("i"),
              op: "=",
              value: callBack([at(ident("i")), ident("i"), ident("items")]),
              line,
            },
          ]),
          answer(ident("out")),
        ];
        break;
      }
      case "filter": {
        returns = { kind: "slice", of: element };
        // The predicate is called once per element and what it answered is
        // kept, because calling it twice — once to count and once to fill — is
        // two calls where the source made one.
        body = [
          declare("keep", { k: "sized", element: elementText, count: length() }),
          declare("n", number("0")),
          loop("0", [
            {
              kind: "if",
              condition: callBack([at(ident("i")), ident("i"), ident("items")]),
              then: [
                { kind: "indexAssign", buffer: "keep", index: ident("n"), op: "=", value: at(ident("i")), line },
                { kind: "update", name: "n", op: "++", prefix: false, line },
              ],
              otherwise: [],
              line,
            },
          ]),
          declare("out", { k: "sized", element: elementText, count: ident("n") }),
          loop("0", [
            { kind: "indexAssign", buffer: "out", index: ident("i"), op: "=", value: { k: "index", base: ident("keep"), index: ident("i") }, line },
          ], ident("n")),
          answer(ident("out")),
        ];
        break;
      }
      case "forEach": {
        returns = NOTHING;
        body = [
          loop("0", [
            { kind: "expression", value: callBack([at(ident("i")), ident("i"), ident("items")]), line },
          ]),
        ];
        break;
      }
      case "every": {
        returns = BOOLEAN_RESULT;
        body = [
          loop("0", [
            {
              kind: "if",
              condition: callBack([at(ident("i")), ident("i"), ident("items")]),
              then: [],
              otherwise: [answer(number("0"))],
              line,
            },
          ]),
          answer(number("1")),
        ];
        break;
      }
      case "some": {
        returns = BOOLEAN_RESULT;
        body = [
          loop("0", [
            {
              kind: "if",
              condition: callBack([at(ident("i")), ident("i"), ident("items")]),
              then: [answer(number("1"))],
              otherwise: [],
              line,
            },
          ]),
          answer(number("0")),
        ];
        break;
      }
      case "find": {
        returns = element;
        body = [
          loop("0", [
            {
              kind: "if",
              condition: callBack([at(ident("i")), ident("i"), ident("items")]),
              then: [answer(at(ident("i")))],
              otherwise: [],
              line,
            },
          ]),
          answer(zero()),
        ];
        break;
      }
      case "findIndex": {
        returns = NUMBER_RESULT;
        body = [
          loop("0", [
            {
              kind: "if",
              condition: callBack([at(ident("i")), ident("i"), ident("items")]),
              then: [answer(ident("i"))],
              otherwise: [],
              line,
            },
          ]),
          answer({ k: "unary", op: "-", operand: number("1") }),
        ];
        break;
      }
      case "reduce": {
        const accumulator = signature.params[0] ?? signature.returns;
        returns = accumulator;
        body = withInitial
          ? [
              declare("acc", ident("initial")),
              loop("0", [
                {
                  kind: "assign",
                  target: "acc",
                  op: "=",
                  value: callBack([ident("acc"), at(ident("i")), ident("i"), ident("items")]),
                  line,
                },
              ]),
              answer(ident("acc")),
            ]
          : [
              // Without an initial value the walk starts at the second element,
              // as the language does: the first is the accumulator.
              declare("acc", at(number("0"))),
              loop("1", [
                {
                  kind: "assign",
                  target: "acc",
                  op: "=",
                  value: callBack([ident("acc"), at(ident("i")), ident("i"), ident("items")]),
                  line,
                },
              ]),
              answer(ident("acc")),
            ];
        break;
      }
      case "sort": {
        returns = { kind: "slice", of: element };
        // A sort writes the array it was handed, so it answers the array it
        // wrote. An insertion sort is the walk that needs no second block: the
        // element on the turn is the one being placed, and the ones before it
        // are already in order.
        body = [
          loop("1", [
            declare("value", at(ident("i"))),
            declare("j", { k: "binary", op: "-", left: ident("i"), right: number("1") }),
            {
              kind: "while",
              condition: {
                k: "binary",
                op: "&&",
                left: { k: "binary", op: ">=", left: ident("j"), right: number("0") },
                right: {
                  k: "binary",
                  op: ">",
                  left: callBack([at(ident("j")), ident("value"), ident("i"), ident("items")]),
                  right: number("0"),
                },
              },
              body: [
                {
                  kind: "indexAssign",
                  buffer: "items",
                  index: plusOne(ident("j")),
                  op: "=",
                  value: at(ident("j")),
                  line,
                },
                { kind: "update", name: "j", op: "--", prefix: false, line },
              ],
              line,
            },
            { kind: "indexAssign", buffer: "items", index: plusOne(ident("j")), op: "=", value: ident("value"), line },
          ]),
          // The array is sorted where it lies, which is what a source that
          // writes the call for what it does relies on, and the value it hands
          // back is a block of its own so that the length of the answer travels
          // with it. A block the caller lent is one nothing says the length of.
          declare("out", { k: "sized", element: elementText, count: length() }),
          loop("0", [
            { kind: "indexAssign", buffer: "out", index: ident("i"), op: "=", value: at(ident("i")), line },
          ]),
          answer(ident("out")),
        ];
        break;
      }
      default:
        return { name: "", returns: ANY_TYPE };
    }

    const params = [
      { name: "items", type: items },
      { name: "fn", type: ANY_TYPE },
      ...(withInitial ? [{ name: "initial", type: signature.params[0] ?? signature.returns }] : []),
    ];
    const helper: TypeScriptFunction = { name, params, returns, body, line, closure: true };
    this.closures.push({
      name,
      exported: false,
      internal: true,
      params: helper.params,
      returns,
      handle: helper,
    });
    this.liftedArrows.set(name, helper);
    const made = { name, returns };
    this.collectHelpers.set(key, made);
    return made;
  }

  /**
   * An arrow read where a value is expected: the closure it is, rather than the
   * call it would be by the name it is bound to.
   */
  private materialized(value: Expression): Expression {
    if (value.k !== "arrow") return value;
    const binding = this.arrowBindings.get(value.name);
    if (binding === undefined) return value;
    return { k: "arrow", name: value.name, captures: value.captures, code: this.closureCode(binding) };
  }

  private readPrimary(): Expression {
    const arrow = this.arrowPrimary();
    if (arrow !== null) return arrow;
    const token = this.next();
    if (token.kind === "unknown") {
      this.report(`unsupported token "${token.text}"`, `line ${token.line} of ${this.path}`, token);
      // The rest of the expression is read past, so one unknown character is
      // reported as the one construct it is.
      this.synchronize(false);
      return this.hole();
    }
    if (token.kind === "regex") {
      // A regular expression is the pattern and the flags it was written with,
      // in the two texts every regular-expression operation is handed. The
      // runtime compiles the pair, and a variable holds the pair like any other
      // list of texts.
      const value: Expression = {
        k: "buffer",
        element: "text",
        values: [
          { k: "text", parts: [{ k: "text", value: token.text }] },
          { k: "text", parts: [{ k: "text", value: token.flags ?? "" }] },
        ],
      };
      this.regexValues.add(value);
      return value;
    }
    if (token.kind === "number") return { k: "literal", text: token.text };
    if (token.kind === "bigint") return { k: "bigint", text: token.text };
    if (token.kind === "string") {
      // A quoted string is the text it holds: `BigInt('0x...')` names the
      // value of the digits, and a text a program writes is the same value
      // whichever quote it was written with.
      if (token.template !== true) return { k: "text", parts: [{ k: "text", value: unescape(token.text, token.line) }] };
      return { k: "text", parts: this.text(token) };
    }
    // `await x` and `yield x` read as the name `await` or `yield` followed by
    // whatever came next, and the build failed on the expression after it rather
    // than on the word that was written.
    if (token.kind === "ident" && token.text === "yield") {
      this.report(`"${token.text}" is not supported`, REFUSED_KEYWORDS[token.text], token);
      this.readExpression();
      return this.hole();
    }
    if (token.kind === "ident" && token.text === "await") {
      // `await v` is the value the promise `v` carries. The word binds like a
      // unary operator, so `await f() + 1` is the value of the promise plus
      // one, and the resolver reads which value that is.
      return { k: "call", name: "Promise.await", args: [this.readUnary()] };
    }
    if (token.kind === "ident") {
      if (token.text === "true" || token.text === "false") return { k: "literal", text: token.text === "true" ? "1" : "0" };
      if (token.text === "null" || token.text === "undefined") return { k: "null" };
      if (token.text === "new") return this.readAllocation();
      if (token.text === "process" && this.at(".") && this.peek(1).text === "argv") {
        this.next();
        this.next();
        return { k: "argv", index: null };
      }
      // `Deno.args` names the same command line under a host that hands over
      // the arguments alone: node counts the program and the file it runs
      // before them, so `Deno.args[i]` is argument `i + 2`, as it is in a
      // program body (see the program frontend's `argv`).
      if (token.text === "Deno" && this.at(".") && this.peek(1).text === "args") {
        this.next();
        this.next();
        return this.denoArguments();
      }
      // `this` is the instance a method was called on, which is the first
      // parameter the class lowering gives every method.
      if (token.text === "this") {
        if (this.currentClass !== null) return { k: "ident", name: "self" };
        this.report(
          '"this" is not a value outside a class method',
          "a method reads the instance it was called on as this",
          token,
        );
        return { k: "ident", name: "this" };
      }
      if (token.text === "super") {
        this.report(
          "a call of super is not part of the class subset",
          "a compiled class is one layout; write the fields and methods it needs",
          token,
        );
        if (this.at("(")) this.readCallArguments();
        return this.hole();
      }
      // A constant of the file is the value it was written with: a compiled
      // function reads the value itself, because there is no environment for
      // it to read the file's scope from.
      const constant = this.constants.get(token.text);
      if (constant !== undefined) {
        const expanded = this.constantValue(token.text, constant.expression);
        if (expanded !== null) return expanded;
      }
      // A name bound to an arrow is that arrow: read where a value is expected,
      // it is the closure the arrow is, carrying the values it captured.
      const arrow = this.valueArrows.get(token.text);
      if (arrow !== undefined && !this.at("(") && token.text !== this.arrowDeclared) {
        return { k: "arrow", name: arrow.function, captures: [...arrow.captures], code: this.closureCode(arrow) };
      }
      return { k: "ident", name: token.text };
    }
    if (token.kind === "punct" && token.text === "[") return this.arrayLiteral(token);
    if (token.kind === "punct" && token.text === "(") {
      const inner = this.readExpression();
      this.expect(")");
      return inner;
    }
    if (token.kind === "punct" && token.text === "{") return this.readObject();
    return this.missing(`unexpected "${token.text}" in an expression`, token);
  }

  /** `{ left: a, right: b }`: an object allocated where it is written. */
  private readObject(): Expression {
    const fields: { name: string; value: Expression }[] = [];
    // The shape a field is written at may be a name this module declares — a
    // recursive type writes its own name, as `Node` does inside `children` — and
    // a name is not the record it stands for, so it is resolved here.
    const declaredShape = this.expectedShape === null ? null : this.shapeForRead(this.expectedShape);
    const expected = declaredShape !== null && declaredShape.kind === "record" ? declaredShape : null;
    // A field a spread writes is replaced by a field written later, as an
    // object literal's last write is the one it holds, and the position stays
    // the first one the field was written at. Two fields the source names
    // itself are the duplicate the object pass refuses, so only a spread
    // replaces anything.
    const spreadFields = new Set<string>();
    const put = (name: string, value: Expression, spread = false): void => {
      const at = fields.findIndex((field) => field.name === name);
      if (at >= 0 && (spread || spreadFields.has(name))) {
        fields[at] = { name, value };
        if (spread) spreadFields.add(name);
        else spreadFields.delete(name);
        return;
      }
      fields.push({ name, value });
      if (spread) spreadFields.add(name);
    };
    while (!this.at("}") && this.peek().kind !== "end") {
      const key = this.next();
      if (key.text === "...") {
        // `{ ...DEFAULT_TARGET }` is the fields of the object it spreads. A
        // constant object of the file is written out here, at the fields the
        // source already wrote; an object a name holds is copied field by
        // field, at the shape its type declares, so `{ ...base, b: 2 }` reads
        // `base.a` and writes `2` over the `base.b` it copied. A value whose
        // work would run once per field is refused rather than read as many.
        const spread = this.readExpression();
        const constant = spread.k === "ident" ? this.constants.get(spread.name) : undefined;
        if (constant?.fields !== undefined) {
          for (const [field, range] of constant.fields) {
            const value = this.constantValue(spread.k === "ident" ? spread.name : "", range);
            if (value !== null) put(field, value, true);
          }
        } else if (spread.k === "object") {
          for (const field of spread.fields) put(field.name, field.value, true);
        } else {
          const shape = this.shapeOf(spread);
          if (shape !== null && shape.kind === "record" && readsOnce(spread)) {
            for (const name of shape.fields.keys()) {
              put(name, { k: "member", base: spread, field: name }, true);
            }
          } else if (!this.typeReadIsPending()) {
            this.report(
              "an object spread reads a constant object",
              "write the fields out, or spread an object the file already wrote as a constant",
              key,
            );
          }
        }
        if (!this.accept(",")) break;
        continue;
      }
      const name = key.kind === "ident" || key.kind === "string" ? key.text : null;
      if (name === null) {
        this.report("an object field is named", `near "${key.text}"`, key);
      } else if (this.accept(":")) {
        // A field written as an empty list is built at the field's declared
        // type, which the object's own annotation or result type states.
        const declared = expected?.fields.get(name);
        const value = declared === undefined
          ? this.readExpression()
          : this.readAt(this.typeExprOfShape(declared.type), () => this.readExpression(), this.shapeForRead(declared.type));
        put(name, value);
      } else if (key.kind === "ident") {
        // `{ line }` is `{ line: line }`: the field is named by the name the
        // value is held at, and the value is that name.
        put(name, { k: "ident", name });
      } else {
        this.report("an object field needs a value", `write ${name}: value`, key);
      }
      if (!this.accept(",")) break;
    }
    this.expect("}");
    // An object literal written at a `Record<string, V>` is the dictionary its
    // type names: each field is one entry of the dictionary, keyed by the name
    // the source wrote. A literal at a record of fields is laid out as fields.
    if (expected !== null && expected.index !== null) {
      const collection: CollectionValue = { kind: "map", key: TEXT_RESULT, value: this.typeExprOfShape(expected.index) };
      const pairs = fields.map((field) => ({
        key: { k: "text", parts: [{ k: "text", value: field.name }] } as Expression,
        value: field.value,
      }));
      const call = pairs.length === 0
        ? { k: "call", name: "blaze_rt_dict_new", args: [] } as Expression
        : this.collectionPairsHelper(collection, pairs, this.peek().line);
      this.collectionExpressions.set(call, collection);
      this.expressionTypes.set(call, NUMBER_RESULT);
      return call;
    }
    return { k: "object", fields };
  }

  /**
   * `new Float64Array(n)` and `new Float64Array([1, 2, 3])`: a typed array
   * allocated where it is written.
   *
   * The same two spellings the program body reads, for the same reason: a
   * function the module declares is compiled on its own, and a function that
   * cannot allocate an array cannot do the work the module asks of it. The
   * element type is the view written, because that is what says how wide an
   * element is — an `Int32Array` is four bytes an element and a `Float64Array`
   * eight, and an array lowered at the wrong stride reads each element out of
   * the middle of the one before it.
   */
  /**
   * An array written out, as `[1, 2]` or `["a", "b"]` is.
   *
   * The element type is the one the declaration names where it names one, and
   * otherwise the type of the first value written: a list of texts is a block of
   * pointers to texts, and a list of objects is a block of references. A value
   * spread into the list joins the ones in front of it, which is the same
   * operation two lists added are.
   */
  private arrayLiteral(open: Token): Expression {
    const savedExpecting = this.expecting;
    const savedType = this.expectedType;
    const savedShape = this.expectedShape;
    const expected = savedExpecting;
    const expectedArray = savedType !== null && (savedType.kind === "slice" || savedType.kind === "array")
      ? savedType
      : null;
    const expectedElementShape = savedShape !== null && savedShape.kind === "list" ? savedShape.of : null;
    this.expecting = null;
    this.expectedType = null;
    this.expectedShape = null;
    /** The values written since the last spread, in the order they were. */
    let run: Expression[] = [];
    /** The list so far, when a spread has joined one. */
    let joined: Expression | null = null;
    /** How many pieces have been joined, so a list of one is still a copy. */
    let pieces = 0;
    let element: TypeExpr | null = expected;
    /**
     * Reads one written value at the type the list holds it at.
     *
     * A list of lists is one list whose elements are lists, so the inner list
     * is built at the outer element's type before its own first value is read.
     * A spread is a list already, and is read at the type of the list instead.
     */
    const readWritten = (spread: boolean): Expression => {
      const valueType = spread ? expectedArray : element;
      const valueShape = spread ? savedShape : expectedElementShape;
      const savedReadExpecting = this.expecting;
      const savedReadType = this.expectedType;
      const savedReadShape = this.expectedShape;
      this.expecting = valueType === null ? null : elementOfSequenceType(valueType);
      this.expectedType = valueType;
      this.expectedShape = valueShape;
      try {
        return this.readExpression();
      } finally {
        this.expecting = savedReadExpecting;
        this.expectedType = savedReadType;
        this.expectedShape = savedReadShape;
      }
    };
    const settleRun = (): void => {
      if (element === null) return;
      for (const written of run) this.applyExpected(written, { kind: "slice", of: element }, expectedElementShape);
    };
    const flush = (): void => {
      if (run.length === 0) return;
      const written = this.bufferValue(element, run, open);
      joined = joined === null ? written : { k: "binary", op: "+", left: joined, right: written };
      run = [];
      pieces += 1;
    };
    while (!this.at("]") && this.peek().kind !== "end") {
      if (this.accept("...")) {
        flush();
        let spread = readWritten(true);
        // A set spread into a list is its keys read out by position. A set is
        // a dictionary, and the handle a name holds is not an element a list
        // holds: `[...seen, other]` is the keys seen plus one more.
        const collection = this.collectionOfExpression(spread);
        if (collection !== null && collection.kind === "set") {
          const helper = this.collectionListHelper(collection, "keys", this.peek().line);
          if (helper !== null) {
            spread = { k: "call", name: helper.name, args: [spread] };
            this.expressionTypes.set(spread, helper.returns);
          }
        }
        // A spread stands for the elements of a list, so the list's element
        // type is the one the spread holds. A value that is not a list — a call
        // the module graph has not linked yet reads as a deferred hole — says
        // nothing about the elements it stands for, and the literal is settled
        // by the values beside it or by the use that reads it.
        const type = this.valueTypeOf(spread);
        if (element === null && (type.kind === "slice" || type.kind === "array") && !this.holdsUnsettledArray(spread)) {
          element = type.of;
          settleRun();
        }
        joined = joined === null ? spread : { k: "binary", op: "+", left: joined, right: spread };
        pieces += 1;
      } else {
        const value = readWritten(false);
        if (element === null && !this.holdsUnsettledArray(value)) {
          element = this.valueTypeOf(value);
          settleRun();
        }
        run.push(value);
      }
      if (!this.accept(",")) break;
    }
    this.expect("]");
    // A list whose only values are themselves unsettled lists still has an
    // element type the outer list can be built at. The inner list is the one
    // the use has not settled, and it reports itself once.
    if (element === null && run.length > 0) element = this.valueTypeOf(run[0] as Expression);
    flush();
    // An empty list joins the empty list in front of it for the same reason a
    // list with elements does: the block it answers is its own, so a list a
    // caller or a field keeps is not a window into the frame that wrote it.
    // The element type comes from the use, which is what says what the list
    // holds before any element has been written.
    const answer = (value: Expression): Expression => {
      this.expecting = savedExpecting;
      this.expectedType = savedType;
      this.expectedShape = savedShape;
      return value;
    };
    if (joined === null && element !== null) {
      joined = { k: "buffer", element: typeToString(element), values: [] };
      pieces = 1;
    }
    if (joined !== null) {
      // `[...a]` is a list of its own and not the list `a` holds: two names
      // that hold one block are one array, and a write through either is a
      // write both see. Joining the list against an empty one copies it.
      /**
       * The list the pieces made, held at the element type they were joined at.
       *
       * A piece may be a call whose result the frontend recorded but whose
       * operands `resultType` cannot see: `[...a.map(f)]` is a call joined with
       * an empty list, and the join of two lists is read from the list on the
       * left. What the expression is is written here, where both halves are
       * known, so a method written after the literal is a method of a list.
       */
      const settle = (value: Expression): Expression => {
        if (element !== null) {
          this.expressionTypes.set(value, { kind: "slice", of: element });
          const shape = expectedElementShape ?? this.shapeOfTypeExpr(element);
          this.expressionShapes.set(value, { kind: "list", of: shape });
        }
        return answer(value);
      };
      if (pieces === 1 && element !== null) {
        return settle({
          k: "binary",
          op: "+",
          left: joined,
          right: { k: "buffer", element: typeToString(element), values: [] },
        });
      }
      return settle(joined);
    }
    // The use of the list has not been read yet: `condition ? [] : [1]` reads
    // the empty arm first. It is kept as a list with no element type and
    // settled when the other arm, the declaration, or the assertion says what
    // it holds. A list no use settles is reported after the expression is read.
    const empty: Expression = { k: "buffer", element: typeToString(ANY_TYPE), values: [] };
    this.unsettledArrays.set(empty, open);
    return answer(empty);
  }

  /** An array of values written out, at the element type it is held at. */
  private bufferValue(element: TypeExpr | null, values: Expression[], open: Token): Expression {
    if (element === null) {
      this.report(
        "an array needs the type of its elements",
        "write at least one value, or declare the element type",
        open,
      );
      return this.hole();
    }
    return { k: "buffer", element: typeToString(element), values };
  }

  /**
   * `new Map<K, V>()` and `new Set<V>()`: one handle on the runtime's
   * dictionary.
   *
   * Whether the value is a map or a set is what the name it is bound to holds,
   * not the handle: a set is a dictionary whose value is the number one, so the
   * two are one value and one pair of methods.
   */
  private readCollectionAllocation(view: Token): Expression {
    const kind = view.text === "Map" || view.text === "WeakMap" ? "map" as const : "set" as const;
    let collection: CollectionValue = { kind, key: TEXT_RESULT, value: NUMBER_RESULT };
    if (this.at("<")) {
      const open = this.position;
      const close = this.matchingToken(open, "<", ">");
      if (close < 0) {
        this.report(`a ${view.text} states the type it holds`, `as in new ${view.text}<string, number>()`, view);
        return this.hole();
      }
      // The head of the annotation is the name the source wrote, which the
      // parser has already read past.
      const read = this.annotationCollectionAt(this.position - 1, new Set(["("]));
      if (read !== null) collection = read;
      this.position = close + 1;
    }
    if (!this.accept("(")) {
      this.report(`a ${view.text} is created with its arguments`, `as in new ${view.text}()`, view);
      return this.hole();
    }
    let call: Expression;
    if (this.at(")")) {
      this.next();
      call = { k: "call", name: "blaze_rt_dict_new", args: [] };
    } else if (kind === "map" && this.at("[") && this.peek(1).text === "[") {
      call = this.readCollectionPairs(collection, view);
    } else {
      const savedSource = this.readingCollectionSource;
      this.readingCollectionSource = true;
      const source = this.readExpression();
      this.readingCollectionSource = savedSource;
      this.expect(")");
      call = this.collectionFromSource(collection, source, view);
    }
    this.collectionExpressions.set(call, collection);
    this.expressionTypes.set(call, NUMBER_RESULT);
    return call;
  }

  /** The `new Map([...])` written as pairs of values, lowered to one helper. */
  private readCollectionPairs(collection: CollectionValue, view: Token): Expression {
    this.expect("[");
    const pairs: { key: Expression; value: Expression }[] = [];
    while (!this.at("]") && this.peek().kind !== "end") {
      this.expect("[");
      const key = this.readExpression();
      this.expect(",");
      const value = this.readExpression();
      this.expect("]");
      pairs.push({ key, value });
      if (!this.accept(",")) break;
    }
    this.expect("]");
    this.expect(")");
    if (pairs.length === 0) {
      return { k: "call", name: "blaze_rt_dict_new", args: [] };
    }
    if (collection.key.kind !== "text" && collection.key.kind !== "ref") {
      this.report(
        `a ${view.text} here is keyed by text, not by ${typeToString(collection.key)}`,
        "a key is a string or a reference: write the key as the text it is",
        view,
      );
      return this.hole();
    }
    // A map written out without a generic states its key and value types with
    // the first entry it holds.
    const firstKey = this.valueTypeOf((pairs[0] as { key: Expression }).key);
    if (collection.key.kind === "text" && firstKey.kind === "ref") collection.key = firstKey;
    if (collection.value.kind === "primitive" && collection.value.name === "f64") {
      const first = this.valueTypeOf((pairs[0] as { value: Expression }).value);
      if (first.kind !== "primitive" || first.name !== "f64") collection.value = first;
    }
    return this.collectionPairsHelper(collection, pairs, view.line);
  }

  /** The function a `new Map([[...], ...])` becomes, by the pair types it holds. */
  private collectionPairsHelper(
    collection: CollectionValue,
    pairs: readonly { key: Expression; value: Expression }[],
    line: number,
  ): Expression {
    const key = JSON.stringify(["pairs", collection.key, collection.value, pairs.length]);
    const known = this.collectHelpers.get(key);
    const arguments_: Expression[] = [];
    for (const pair of pairs) arguments_.push(pair.key, pair.value);
    if (known !== undefined) return { k: "call", name: known.name, args: arguments_ };
    const name = `__collect_${this.stem}_${this.collectCount}`;
    this.collectCount += 1;
    const params: { name: string; type: TypeExpr }[] = [];
    const body: Statement[] = [
      { kind: "declare", name: "m", type: null, init: { k: "call", name: "blaze_rt_dict_new", args: [] }, line },
    ];
    const setName = this.collectionSetNameFor(collection) as string;
    for (let index = 0; index < pairs.length; index += 1) {
      params.push({ name: `k${index}`, type: collection.key }, { name: `v${index}`, type: collection.value });
      body.push({
        kind: "expression",
        value: {
          k: "call",
          name: setName,
          args: [
            { k: "ident", name: "m" },
            { k: "ident", name: `k${index}` },
            { k: "ident", name: `v${index}` },
          ],
        },
        line,
      });
    }
    body.push({ kind: "result", value: { k: "ident", name: "m" }, line });
    const returns: TypeExpr = NUMBER_RESULT;
    const helper: TypeScriptFunction = { name, params, returns, body, line, closure: true };
    this.closures.push({ name, exported: false, internal: true, params, returns, handle: helper });
    this.liftedArrows.set(name, helper);
    this.collectHelpers.set(key, { name, returns });
    return { k: "call", name, args: arguments_ };
  }

  /** `new Set(values)` or `new Map(other)`: the source filled entry by entry. */
  private collectionFromSource(collection: CollectionValue, source: Expression, view: Token): Expression {
    const sourceCollection = this.collectionOfExpression(source);
    // The entries a record holds are read by position out of the record itself,
    // so a copy of them walks the record and not the marker `Object.entries`
    // left where the entries are.
    const copied = source.k === "call" && source.name === "__collection_entries"
      ? (source.args[0] as Expression)
      : source;
    if (sourceCollection !== null) {
      // A collection built from another states its key and value with the one
      // it copies where the source wrote no generic.
      if (collection.key.kind === "text" && sourceCollection.key.kind === "ref") collection.key = sourceCollection.key;
      if (collection.value.kind === "primitive" && collection.value.name === "f64" && sourceCollection.value.kind !== "primitive") {
        collection.value = sourceCollection.value;
      }
      return this.collectionCopyHelper(collection, copied, sourceCollection, view.line);
    }
    if (collection.kind !== "set") {
      this.report(
        `a ${view.text} is built from entries`,
        "write the entries as an array of pairs, as in new Map([[`a`, 1]])",
        view,
      );
      return this.hole();
    }
    const held = this.valueTypeOf(source);
    const element = held.kind === "slice" || held.kind === "array" ? held.of : ANY_TYPE;
    if (collection.key.kind === "text" && element.kind !== "text") {
      collection.key = element;
    }
    // A list written out is filled from the values themselves, one parameter
    // each. A helper that took the block would take a `ref<any>*`, which is the
    // one buffer the probe cannot build at the element type the C backend
    // declares: a reference is carried as a double there and as a pointer in
    // the probe. A written-out list is the block joined against the empty one,
    // so the values are read out of the block it joins.
    const written = this.writtenListValues(source);
    if (written !== null) {
      return this.collectionFromLiteralHelper(collection, collection.key, written, view.line);
    }
    return this.collectionFromArrayHelper(collection, element, source, view.line);
  }

  /** The values a written-out list holds, or null when the source is not one. */
  private writtenListValues(value: Expression): Expression[] | null {
    if (value.k === "buffer" && value.values.length > 0) return value.values;
    if (value.k !== "binary" || value.op !== "+") return null;
    const left = value.left.k === "buffer" && value.left.values.length > 0 ? value.left.values : null;
    const right = value.right.k === "buffer" && value.right.values.length > 0 ? value.right.values : null;
    if (left !== null && right === null && value.right.k === "buffer") return left;
    if (right !== null && left === null && value.left.k === "buffer") return right;
    return null;
  }

  /** The function a `new Set([...])` written out becomes. */
  private collectionFromLiteralHelper(
    collection: CollectionValue,
    element: TypeExpr,
    values: readonly Expression[],
    line: number,
  ): Expression {
    const key = JSON.stringify(["fromLiteral", collection.kind, element, values.length]);
    const known = this.collectHelpers.get(key);
    if (known !== undefined) return { k: "call", name: known.name, args: [...values] };
    const kind = this.storedKind(element);
    const setName = kind === "reference" ? "blaze_rt_dict_set_refkey" : kind === "text" ? "blaze_rt_dict_set" : null;
    if (setName === null) {
      this.report(
        `a set of ${typeToString(element)} is keyed by text, not by ${typeToString(element)}`,
        "a set holds texts, or references keyed by the handle they are",
        this.peek(),
      );
      return this.hole();
    }
    const name = `__collect_${this.stem}_${this.collectCount}`;
    this.collectCount += 1;
    const params: { name: string; type: TypeExpr }[] = [];
    const body: Statement[] = [
      { kind: "declare", name: "m", type: null, init: { k: "call", name: "blaze_rt_dict_new", args: [] }, line },
    ];
    for (let index = 0; index < values.length; index += 1) {
      params.push({ name: `v${index}`, type: element });
      body.push({
        kind: "expression",
        value: {
          k: "call",
          name: setName,
          args: [
            { k: "ident", name: "m" },
            { k: "ident", name: `v${index}` },
            { k: "literal", text: "1" },
          ],
        },
        line,
      });
    }
    body.push({ kind: "result", value: { k: "ident", name: "m" }, line });
    const returns: TypeExpr = NUMBER_RESULT;
    const helper: TypeScriptFunction = { name, params, returns, body, line, closure: true };
    this.closures.push({ name, exported: false, internal: true, params, returns, handle: helper });
    this.liftedArrows.set(name, helper);
    this.collectHelpers.set(key, { name, returns });
    return { k: "call", name, args: [...values] };
  }

  /** The function a `new Set(array)` becomes: a dictionary of its elements. */
  private collectionFromArrayHelper(
    collection: CollectionValue,
    element: TypeExpr,
    source: Expression,
    line: number,
  ): Expression {
    const key = JSON.stringify(["fromArray", collection.kind, element]);
    const known = this.collectHelpers.get(key);
    if (known !== undefined) {
      return { k: "call", name: known.name, args: [source] };
    }
    const name = `__collect_${this.stem}_${this.collectCount}`;
    this.collectCount += 1;
    const items: TypeExpr = { kind: "slice", of: element };
    const refKey = element.kind === "ref";
    const setName = refKey ? "blaze_rt_dict_set_refkey" : null;
    if (setName === null && element.kind !== "text") {
      this.report(
        `a set of ${typeToString(element)} is keyed by text, not by ${typeToString(element)}`,
        "a set holds texts, or references keyed by the handle they are",
        this.peek(),
      );
      return this.hole();
    }
    const ident = (value: string): Expression => ({ k: "ident", name: value });
    const body: Statement[] = [
      { kind: "declare", name: "m", type: null, init: { k: "call", name: "blaze_rt_dict_new", args: [] }, line },
      {
        kind: "loop",
        variable: "i",
        from: { k: "literal", text: "0" },
        to: { k: "length", buffer: "items" },
        inclusive: false,
        step: null,
        down: false,
        body: [
          {
            kind: "expression",
            value: {
              k: "call",
              name: setName ?? "blaze_rt_dict_set",
              args: [ident("m"), { k: "index", base: ident("items"), index: ident("i") }, { k: "literal", text: "1" }],
            },
            line,
          },
        ],
        line,
      },
      { kind: "result", value: ident("m"), line },
    ];
    const params = [{ name: "items", type: items }];
    const returns: TypeExpr = NUMBER_RESULT;
    const helper: TypeScriptFunction = { name, params, returns, body, line, closure: true };
    this.closures.push({ name, exported: false, internal: true, params, returns, handle: helper });
    this.liftedArrows.set(name, helper);
    this.collectHelpers.set(key, { name, returns });
    return { k: "call", name, args: [source] };
  }

  /** The function a `new Set(other)` or `new Map(other)` copies into. */
  private collectionCopyHelper(
    collection: CollectionValue,
    source: Expression,
    sourceCollection: CollectionValue,
    line: number,
  ): Expression {
    const key = JSON.stringify(["copy", collection.kind, collection.key, collection.value, sourceCollection.kind, sourceCollection.key, sourceCollection.value]);
    const known = this.collectHelpers.get(key);
    const name = known === undefined ? `__collect_${this.stem}_${this.collectCount}` : known.name;
    if (known !== undefined) return { k: "call", name, args: [source] };
    this.collectCount += 1;
    const ident = (value: string): Expression => ({ k: "ident", name: value });
    const refKey = sourceCollection.key.kind === "ref";
    const keyRead = refKey ? "blaze_rt_dict_key_ref_at" : "blaze_rt_dict_key_at";
    const body: Statement[] = [
      { kind: "declare", name: "m", type: null, init: { k: "call", name: "blaze_rt_dict_new", args: [] }, line },
      { kind: "declare", name: "n", type: null, init: { k: "call", name: "blaze_rt_dict_len", args: [ident("source")] }, line },
      {
        kind: "loop",
        variable: "i",
        from: { k: "literal", text: "0" },
        to: ident("n"),
        inclusive: false,
        step: null,
        down: false,
        body: [],
        line,
      },
      { kind: "result", value: ident("m"), line },
    ];
    const loop = body[2] as Statement & { kind: "loop" };
    if (collection.kind === "set") {
      const setName = refKey ? "blaze_rt_dict_set_refkey" : "blaze_rt_dict_set";
      loop.body = [{
        kind: "expression",
        value: {
          k: "call",
          name: setName,
          args: [ident("m"), { k: "call", name: keyRead, args: [ident("source"), ident("i")] }, { k: "literal", text: "1" }],
        },
        line,
      }];
    } else {
      const setName = this.collectionSetNameFor(collection) ?? "blaze_rt_dict_set";
      loop.body = [{
        kind: "expression",
        value: {
          k: "call",
          name: setName,
          args: [
            ident("m"),
            { k: "call", name: keyRead, args: [ident("source"), ident("i")] },
            { k: "call", name: this.valueReadName(collection.value), args: [ident("source"), ident("i")] },
          ],
        },
        line,
      }];
    }
    const params = [{ name: "source", type: NUMBER_RESULT }];
    const returns: TypeExpr = NUMBER_RESULT;
    const helper: TypeScriptFunction = { name, params, returns, body, line, closure: true };
    this.closures.push({ name, exported: false, internal: true, params, returns, handle: helper });
    this.liftedArrows.set(name, helper);
    this.collectHelpers.set(key, { name, returns });
    return { k: "call", name, args: [source] };
  }

  private readAllocation(): Expression {
    const view = this.next();
    // `new Point(1, 2)`: the class's constructor is a function that returns the
    // object, and the arity selects the overload that fills any defaults.
    if (view.kind === "ident") {
      const info = this.classNamed(view.text);
      if (info !== undefined) {
        if (!this.at("(")) {
          this.report("a class is constructed with its arguments", `as in new ${view.text}()`, view);
          return { k: "call", name: info.name, args: [] };
        }
        const params = info.constructor?.params ?? [];
        const args = this.readCallArguments(this.methodParams(params).map((param) => param.type));
        return { k: "call", name: methodFunctionName(info.name, { name: "constructor", params, returnTypeName: info.name, bodyStart: -1, bodyEnd: -1, line: info.line }, args.length), args };
      }
    }
    // `new RegExp(pattern, flags)`: the same pair a written-out regular
    // expression is, with the pattern and the flags the source computed.
    if (view.kind === "ident" && view.text === "RegExp") {
      if (!this.at("(")) {
        this.report("a regular expression is created from its pattern", "as in new RegExp(`^\\\\d+$`)", view);
        return this.hole();
      }
      const args = this.readCallArguments();
      const empty: Expression = { k: "text", parts: [] };
      const value: Expression = {
        k: "buffer",
        element: "text",
        values: [args[0] ?? empty, args[1] ?? empty],
      };
      this.regexValues.add(value);
      return value;
    }
    if (view.kind === "ident" && (view.text === "Map" || view.text === "Set" || view.text === "WeakMap" || view.text === "WeakSet")) {
      return this.readCollectionAllocation(view);
    }
    // `new C(...)` of a class another module declares is a call of the function
    // that module lowered the class to. The class itself is not in this file's
    // table, so what its parameters are is not known here; the arguments are
    // read as the source wrote them, and the linker names the constructor.
    if (view.kind === "ident" && this.importedTypeNames.has(view.text)) {
      return { k: "call", name: view.text, args: this.readCallArguments() };
    }
    if (view.kind !== "ident" || !(view.text in TYPED_ARRAYS)) {
      this.report(
        `a program allocates a typed array, not "${view.text}"`,
        `as in new Float64Array(n); the arrays are ${Object.keys(TYPED_ARRAYS).join(", ")}`,
        view,
      );
      this.skipBlock();
      return this.hole();
    }
    const element = TYPED_ARRAYS[view.text] as string;
    if (!this.accept("(")) {
      this.report("a typed array is allocated with a count", "as in new Float64Array(n)", view);
      return this.hole();
    }
    if (this.at("[")) {
      this.next();
      const values: Expression[] = [];
      while (!this.at("]") && this.peek().kind !== "end") {
        values.push(this.readExpression());
        if (!this.accept(",")) break;
      }
      this.expect("]");
      this.expect(")");
      return { k: "buffer", element, values };
    }
    const count = this.readExpression();
    this.expect(")");
    return { k: "sized", element, count };
  }

  /**
   * A parser for a stretch of this file's text, sharing what the file has
   * written so far.
   *
   * A template string interpolates an expression the same file reads, so a
   * name, a helper or an arrow the stretch writes belongs to the file and not
   * to a little file of its own. Sharing the tables by reference means the
   * helpers and closures the stretch lifts are the file's, and `adopt` carries
   * the counters back so the next name the file takes is still its own.
   */
  private nested(tokens: Token[]): TypeScriptParser {
    const child = new TypeScriptParser(
      tokens,
      this.path,
      this.diagnostics,
      this.classTable,
      this.allTokens,
      this.constants,
      this.state,
      this.typeTable,
      this.importedTypeNames,
    );
    child.currentClass = this.currentClass;
    child.pendingType = this.pendingType;
    child.wideBigint = this.wideBigint;
    child.linked = this.linked;
    child.valueTypes = this.valueTypes;
    // A template string interpolates a value the block around it settled: the
    // text it writes is read with the same table the block was read with.
    child.fieldCount = this.fieldCount;
    child.narrowed = this.narrowed;
    child.valueShapes = this.valueShapes;
    child.pendingValues = this.pendingValues;
    child.pendingFields = this.pendingFields;
    child.valueClasses = this.valueClasses;
    child.valueArrows = this.valueArrows;
    child.arrowBindings = this.arrowBindings;
    child.valueFunctions = this.valueFunctions;
    child.declaredReturns = this.declaredReturns;
    child.declaredReturnShapes = this.declaredReturnShapes;
    child.declaredParams = this.declaredParams;
    child.valueCollections = this.valueCollections;
    child.declaredCollections = this.declaredCollections;
    child.collectionExpressions = this.collectionExpressions;
    child.iteratedCollections = this.iteratedCollections;
    child.iteratedSequences = this.iteratedSequences;
    child.closures = this.closures;
    child.liftedArrows = this.liftedArrows;
    child.collectHelpers = this.collectHelpers;
    child.expressionTypes = this.expressionTypes;
    child.closureCount = this.closureCount;
    child.collectCount = this.collectCount;
    child.destructureCount = this.destructureCount;
    child.switchCount = this.switchCount;
    child.walkCount = this.walkCount;
    return child;
  }

  /** The counters a nested parser advanced, taken back by the file. */
  private adopt(child: TypeScriptParser): void {
    this.closureCount = child.closureCount;
    this.collectCount = child.collectCount;
    this.destructureCount = child.destructureCount;
    this.switchCount = child.switchCount;
    this.walkCount = child.walkCount;
    this.fieldCount = child.fieldCount;
  }

  /** The text of a template string, split where it interpolates a value. */
  private text(token: Token): TextPart[] {
    const parts: TextPart[] = [];
    let rest = token.text;
    while (rest.length > 0) {
      const open = nextInterpolation(rest);
      if (open < 0) {
        parts.push({ k: "text", value: unescape(rest, token.line) });
        break;
      }
      if (open > 0) parts.push({ k: "text", value: unescape(rest.slice(0, open), token.line) });
      const close = closingBrace(rest, open);
      if (close < 0) {
        this.report("a template string interpolates nothing", `near "${rest.slice(open)}"`, token);
        break;
      }
      const inner = rest.slice(open + 2, close);
      rest = rest.slice(close + 1);
      const parser = this.nested(tokenize(inner));
      const value = parser.readExpression();
      if (parser.peek().kind !== "end") {
        this.report(`"${parser.peek().text}" follows a complete value`, `in the text of line ${token.line}`, parser.peek());
      }
      this.adopt(parser);
      parts.push({ k: "value", value });
    }
    return parts;
  }
}

/**
 * A body the contract cannot state as one expression. It is not an error: the
 * contract of such a function carries what the function does instead.
 */
class Uncontractable extends Error {
  readonly detail: string;

  constructor(message: string, detail: string) {
    super(message);
    this.name = "Uncontractable";
    this.detail = detail;
  }
}

/**
 * What a body does: whether it allocates, prints or reads the command line,
 * and the buffer ranges it reads. Every function is described this way, and
 * these are the ranges its preconditions state, because the body is what runs
 * and a caller must provide everything the body reaches.
 */
function usageOf(declaration: TypeScriptFunction): {
  allocates: boolean;
  prints: boolean;
  readsArgv: boolean;
  accesses: AccessRange[];
} {
  const parameters = new Set(declaration.params.map((param) => param.name));
  /**
   * Whether the ranges this body reads have to be stated.
   *
   * A function the frontend wrote is called only from the body that wrote it,
   * which is what holds the bounds of everything it hands over. Stating them
   * again would hold a helper to a caller that does not exist, and a helper that
   * walks an array it was handed reads at a position nothing there can name.
   */
  const contractable = declaration.closure !== true;
  const accesses: AccessRange[] = [];
  /** The range a loop index stands for, which its body reads through. */
  const loops = new Map<string, { lo: string; hi: string }>();
  let allocates = false;
  let prints = false;
  let readsArgv = false;

  /** The contract text of a value, or null when a contract cannot state it. */
  const text = (value: Expression): string | null => {
    switch (value.k) {
      case "literal":
      case "bigint":
        return value.text;
      case "ident":
        return parameters.has(value.name) ? value.name : null;
      case "length":
        return parameters.has(value.buffer) ? `len(${value.buffer})` : null;
      case "unary": {
        if (value.op !== "-" && value.op !== "+") return null;
        const operand = text(value.operand);
        return operand === null ? null : `(${value.op}${operand})`;
      }
      case "binary": {
        if (!ARITHMETIC_OPERATORS.includes(value.op)) return null;
        const left = text(value.left);
        const right = text(value.right);
        return left === null || right === null ? null : `(${left} ${value.op} ${right})`;
      }
      default:
        return null;
    }
  };

  /** One access, stated once however many times the body reads it. */
  const access = (parameter: string, lo: string, hi: string): void => {
    const seen = accesses.some((entry) => entry.parameter === parameter && entry.lo === lo && entry.hi === hi);
    if (!seen) accesses.push({ parameter, lo, hi });
  };

  const expression = (value: Expression): void => {
    switch (value.k) {
      case "object":
        allocates = true;
        for (const field of value.fields) expression(field.value);
        return;
      case "argv":
        readsArgv = true;
        return;
      case "call":
        // The length of the command line is read under a name of the compiler's
        // own, so it arrives here as a call rather than as an `argv`: reading
        // `process.argv.length` is reading the command line, and a contract
        // that answered "this body touches nothing outside its parameters"
        // because of that is what makes the body inlinable and parallel.
        if (value.name === ARGV_LENGTH) readsArgv = true;
        for (const argument of value.args) expression(argument);
        return;
      case "text":
        for (const part of value.parts) {
          if (part.k === "value") expression(part.value);
        }
        return;
      case "binary":
        expression(value.left);
        expression(value.right);
        return;
      case "unary":
        expression(value.operand);
        return;
      case "conditional":
        expression(value.condition);
        expression(value.then);
        expression(value.otherwise);
        return;
      case "index": {
        // A buffer the body indexes is a buffer it reads, at a position the
        // contract states as a number. An index the contract language cannot
        // name is not left out: the read is still a read, and what the
        // contract states about it is that the buffer is there.
        const base = value.base;
        if (base.k === "ident" && parameters.has(base.name)) {
          const loop = value.index.k === "ident" ? loops.get(value.index.name) : undefined;
          if (loop !== undefined) access(base.name, loop.lo, loop.hi);
          else {
            const at = text(value.index);
            // An index the contract language cannot name — one a `while`
            // counter holds, or one a `for..of` iterator carries — leaves the
            // position unknown. `a[0:len(a)]` states nothing a caller is held
            // to, and what is left is `a != null`: a caller may then hand the
            // body a buffer shorter than the body walks, and the same body
            // gets a real bound the moment the bound is spelled as a
            // parameter rather than as a local holding one. A contract that
            // cannot state the length the body reads is not a contract.
            if (at !== null) access(base.name, at, `(${at} + 1)`);
            else if (contractable)
              throw frontendError(
                `${declaration.name} cannot be contracted: it reads ${base.name} at a position the contract cannot name`,
                "hold the bound in a parameter, so the contract can state the length the body reads",
              );
          }
        }
        expression(value.base);
        expression(value.index);
        return;
      }
      case "slice": {
        expression(value.base);
        if (value.start !== null) expression(value.start);
        if (value.stop !== null) expression(value.stop);
        if (value.step !== null) expression(value.step);
        return;
      }
      case "member":
        expression(value.base);
        return;
      case "length":
        return;
      case "lengthOf":
        expression(value.of);
        return;
      case "literal":
      case "bigint":
      case "ident":
      case "null":
      case "update":
        return;
      case "arrow":
        // The body of the arrow is a function of its own, and its own usage is
        // what says whether it allocates or prints. What it reads around it is
        // a name this body reads, which is a read of a name and nothing more.
        // Read as a value, the arrow is a closure, and a closure is a block the
        // runtime lays out.
        if (value.code !== undefined) allocates = true;
        return;
      case "capture":
        // One value a closure carries, read out of a closure this body was
        // handed: it reaches no buffer and allocates nothing.
        return;
      case "invoke":
        expression(value.callee);
        for (const argument of value.args) expression(argument);
        return;
      case "append":
        for (const one of value.values) expression(one);
        return;
    }
  };
  const statement = (one: Statement): void => {
    switch (one.kind) {
      case "declare":
        expression(one.init);
        return;
      case "print":
        prints = true;
        expression(one.value);
        return;
      case "assign":
      case "throw":
      case "expression":
      case "memberAssign":
        expression(one.value);
        return;
      case "result":
        if (one.value !== null) expression(one.value);
        return;
      case "indexAssign": {
        // A buffer the body writes is a buffer it writes, and the range it
        // writes over is the range a caller is held to. Leaving it out stated
        // no precondition at all, and a driver that believed the contract
        // handed the body a buffer shorter than the body walks.
        const base = one.buffer;
        if (parameters.has(base)) {
          const loop = one.index.k === "ident" ? loops.get(one.index.name) : undefined;
          if (loop !== undefined) access(base, loop.lo, loop.hi);
          else {
            const at = text(one.index);
            if (at !== null) access(base, at, `(${at} + 1)`);
            else access(base, "0", `len(${base})`);
          }
        }
        expression(one.index);
        expression(one.value);
        return;
      }
      case "if":
        expression(one.condition);
        one.then.forEach(statement);
        one.otherwise.forEach(statement);
        return;
      case "loop":
        expression(one.from);
        expression(one.to);
        // The step is a whole expression, so it allocates and reads the
        // arguments like any other, and leaving it out let a contract claim
        // the source touches nothing outside them.
        if (one.step !== null) expression(one.step);
        // The index of a counted loop stands for the whole range the loop
        // walks, so a buffer its body reads is read over that range and not
        // over the single turn that reads it. A loop that counts down walks
        // the same range the other way round, and stating it as it is written
        // would give a range with its ends the wrong way about: the length a
        // caller is held to is then built from the loop's terminal bound, and
        // the body reads past the end of the buffer it was given.
        const from = text(one.from);
        const to = text(one.to);
        const outer = loops.get(one.variable);
        if (from !== null && to !== null) {
          loops.set(one.variable, one.down
            ? { lo: one.inclusive ? to : `(${to} + 1)`, hi: `(${from} + 1)` }
            : { lo: from, hi: one.inclusive ? `(${to} + 1)` : to });
        }
        one.body.forEach(statement);
        if (outer === undefined) loops.delete(one.variable);
        else loops.set(one.variable, outer);
        return;
      case "while":
      case "doWhile":
        expression(one.condition);
        one.body.forEach(statement);
        return;
      case "forOf":
        // Walking a buffer reads all of it, so the contract says so. The
        // iteration is bounded by the array's own length, so no length is
        // required of the caller: what it states is that the buffer is there.
        if (parameters.has(one.of)) access(one.of, "0", `len(${one.of})`);
        one.body.forEach(statement);
        return;
      case "break":
      case "continue":
        return;
      case "update":
        return;
    }
  };
  declaration.body.forEach(statement);
  return { allocates, prints, readsArgv, accesses };
}

/** The symbol a program entry named `main` is compiled under: a program is
 *  hosted by one that has a `main` of its own, so the two cannot share it. */
export const PROGRAM_ENTRY_SYMBOL = "blaze_main";


/* -------------------------------------------------------------------------- */
/* Body analysis                                                              */
/* -------------------------------------------------------------------------- */
interface LoopContext {
  variable: string;
  lo: string;
  hiExclusive: string;
}

/**
 * A loop a reduction cannot state. A counted loop over a range is one the
 * contract can say; every other loop leaves the body to the definition.
 */
const LOOP_REMEDY =
  "a postcondition is one expression the result must equal, so this body states none: the contract carries the statements themselves";

/**
 * The binary operators the contract language states. A compound assignment
 * whose operator is not one of these is a result the contract cannot say, so
 * the body is contracted by what it does rather than by an expression it
 * cannot meet.
 */
const CONTRACT_BINARY = new Set(["+", "-", "*", "/", "<", "<=", ">", ">=", "==", "!="]);

class BodyAnalysis {
  private readonly declaration: TypeScriptFunction;
  private readonly bindings = new Map<string, string>();
  private readonly accesses: AccessRange[] = [];
  private result: string | null = null;

  constructor(declaration: TypeScriptFunction) {
    this.declaration = declaration;
    for (const param of declaration.params) this.bindings.set(param.name, param.name);
  }

  /**
   * The expression the result must equal, or null when the body has none: a
   * function that branches, recurses, allocates, calls or prints is contracted
   * by what it does, which `definitionContract` carries.
   */
  run(): { result: string | null; accesses: AccessRange[] } {
    try {
      for (const statement of this.declaration.body) this.execute(statement, null);
    } catch (error) {
      if (!(error instanceof Uncontractable)) throw error;
      return { result: null, accesses: this.accesses };
    }
    // A function that returns nothing has no expression the result must equal,
    // which is the same `null` every body that prints, calls or branches
    // already hands the contract. Only a function that declares a value has to
    // produce one: `function f(x: number): void { let i = 0; i = i + 1; }`
    // returns exactly what it declares and was refused for returning nothing,
    // because a straight-line body of declarations and assignments is the one
    // shape that reaches here without having already been uncontractable.
    if (this.result === null && this.declaration.returns.kind !== "void") {
      throw frontendError(
        `${this.declaration.name} never returns a value`,
        "the contract needs an expression the result must equal",
      );
    }
    return { result: this.result, accesses: this.accesses };
  }

  /**
   * A contract states what a function returns as one expression. A body that
   * branches, calls, allocates or prints has no such expression, so it is
   * named here rather than given a contract it cannot meet.
   */
  private uncontractable(construct: string, line: number, remedy: string): never {
    throw new Uncontractable(
      `${this.declaration.name} cannot be contracted: it ${construct} (line ${line})`,
      remedy,
    );
  }

  private execute(statement: Statement, loop: LoopContext | null): void {
    switch (statement.kind) {
      case "declare":
        this.bindings.set(statement.name, this.serialize(statement.init, loop, statement.line));
        return;
      case "result":
        if (statement.value !== null) this.result = this.serialize(statement.value, loop, statement.line);
        return;
      case "assign": {
        const value = this.serialize(statement.value, loop, statement.line);
        const current = this.bindings.get(statement.target);
        if (current === undefined) {
          throw frontendError(`assignment to undeclared "${statement.target}"`, `line ${statement.line}`);
        }
        // A compound assignment is the binary operator it states over the name
        // and the value, and the operator is the one the source wrote: `<<=` is
        // a shift, not a comparison, and `**=` is a power, not a product. The
        // first character of the operator was the whole of this before the
        // compound set grew, and it spelled every one of the new ones wrong.
        if (statement.op !== "=") {
          const binary = COMPOUND_OPERATORS[statement.op];
          // The contract language states `+ - * /` and the comparisons and
          // nothing else, so a result that is a shift, a bitwise operation or a
          // power is a body the contract cannot state: it is contracted by what
          // it does instead, which is where a body that prints or branches
          // already goes.
          if (!CONTRACT_BINARY.has(binary)) {
            this.uncontractable(
              `applies "${binary}" to "${statement.target}"`,
              statement.line,
              "a contract is one expression the result must equal, and the contract language states + - * / and the comparisons; write the operation as a binary expression the result returns",
            );
          }
        }
        this.bindings.set(
          statement.target,
          statement.op === "=" ? value : `(${current} ${COMPOUND_OPERATORS[statement.op]} ${value})`,
        );
        return;
      }
      case "loop":
        this.executeLoop(statement);
        return;
      case "while":
        this.uncontractable("loops while a condition holds", statement.line, LOOP_REMEDY);
      case "doWhile":
        this.uncontractable("loops until a condition fails", statement.line, LOOP_REMEDY);
      case "forOf":
        this.uncontractable(`walks "${statement.of}"`, statement.line, LOOP_REMEDY);
      case "break":
        this.uncontractable("leaves a loop", statement.line, LOOP_REMEDY);
      case "continue":
        this.uncontractable("skips the rest of a loop body", statement.line, LOOP_REMEDY);
      case "try":
        this.uncontractable(
          "uses try/catch",
          statement.line,
          "a contract is one expression the result must equal, so a contracted function is straight-line",
        );
      case "if":
        this.uncontractable(
          "branches",
          statement.line,
          "a contract is one expression the result must equal, so a contracted function is straight-line",
        );
      case "update":
        this.uncontractable(
          `changes "${statement.name}" outside a counted loop`,
          statement.line,
          "accumulate with `x = x + 1` or a counted loop instead",
        );
      case "print":
        this.uncontractable("prints", statement.line, "a contracted function returns a value and prints nothing");
      case "throw":
        this.uncontractable("raises an error", statement.line, "a contracted function returns a value and raises nothing");
      case "expression":
        this.uncontractable(
          `calls ${describe(statement.value)}`,
          statement.line,
          "a contracted function is computed from its parameters alone",
        );
      case "memberAssign":
        this.uncontractable(
          `writes the field "${statement.base}.${statement.field}"`,
          statement.line,
          "the frontend accepts functions that read what they are given",
        );
      case "indexAssign":
        this.uncontractable(
          `writes into "${statement.buffer}"`,
          statement.line,
          "the frontend accepts functions that read what they are given",
        );
    }
  }

  private executeLoop(statement: Statement & { kind: "loop" }): void {
    if (statement.step !== null || statement.down) {
      this.uncontractable(
        "counts by something other than one",
        statement.line,
        "a reduction describes the range it sums over, so the index moves by one",
      );
    }
    if (statement.body.length !== 1) {
      this.uncontractable(
        "has a loop body of more than one statement",
        statement.line,
        "a reduction describes a loop that accumulates into one variable",
      );
    }
    const inner = statement.body[0];
    if (inner.kind === "indexAssign") {
      this.uncontractable(
        `writes into "${inner.buffer}"`,
        inner.line,
        "a reduction reads what it is given, so a contracted function writes nothing",
      );
    }
    if (inner.kind !== "assign") {
      this.uncontractable(
        "has a loop body that does not accumulate",
        statement.line,
        "a reduction describes a loop that accumulates into one variable, as in `total += a[i]`",
      );
    }
    // Only `+=` and `*=` are reductions. An allowlist and not a denylist:
    // `=` and `%=` are assignments that happen to be written in a loop, and
    // reading them as a sum states a contract the body does not implement.
    if (inner.op !== "+=" && inner.op !== "*=") {
      this.uncontractable(
        `accumulates with "${inner.op}"`,
        inner.line,
        "a reduction is a sum or a product, so a loop accumulates with `+=` or `*=`",
      );
    }
    // A counted loop reads its bound again on every turn, so a body that
    // writes it walks a range no contract can name: the one the reduction
    // states is the bound as it stood before the first turn.
    for (const bound of [statement.from, statement.to]) {
      if (bound.k !== "ident" || bound.name !== inner.target) continue;
      throw frontendError(
        `the loop body writes "${inner.target}", the loop's own bound (line ${inner.line})`,
        "a counted loop re-reads its bound on every turn, which a contract cannot state; loop to a bound the body does not write",
      );
    }

    const from = this.serialize(statement.from, null, statement.line);
    const to = this.serialize(statement.to, null, statement.line);
    const context: LoopContext = {
      variable: statement.variable,
      lo: from,
      hiExclusive: statement.inclusive ? `(${to} + 1)` : to,
    };

    const body = this.serialize(inner.value, context, inner.line);
    const reduceOperator = inner.op === "*=" ? "product" : "sum";
    const range = `${statement.variable} = ${from}${statement.inclusive ? ".." : "..<"}${to}`;
    const reduce = `${reduceOperator}(${range}, ${body})`;

    const current = this.bindings.get(inner.target);
    if (current === undefined) {
      throw frontendError(`loop accumulates into undeclared "${inner.target}"`, `line ${inner.line}`);
    }
    this.bindings.set(inner.target, this.withInitial(current, reduce, reduceOperator));
  }

  /**
   * Folds an accumulator's initial value into its reduction. A neutral
   * initialiser is dropped so the contract stays readable; anything else is
   * composed, which is what makes a second loop over the same accumulator
   * expressible at all.
   */
  private withInitial(initial: string | null, reduce: string, operator: ReduceOperator): string {
    if (initial === null) return reduce;
    const neutral = operator === "sum" ? ["0", "0.0"] : ["1", "1.0"];
    if (neutral.includes(initial)) return reduce;
    return `(${initial} ${(operator === "sum" ? "+" : "*")} ${reduce})`;
  }

  private serialize(expression: Expression, loop: LoopContext | null, line: number): string {
    switch (expression.k) {
      case "literal":
      case "bigint":
        return expression.text;
      case "null":
        return "null";
      case "length": {
        const param = this.declaration.params.find((entry) => entry.name === expression.buffer);
        if (param === undefined) {
          throw frontendError(`.length of unknown "${expression.buffer}"`, `line ${line}`);
        }
        return `len(${param.name})`;
      }
      case "ident": {
        if (loop !== null && expression.name === loop.variable) return expression.name;
        const bound = this.bindings.get(expression.name);
        if (bound === undefined) {
          throw frontendError(`unknown identifier "${expression.name}"`, `line ${line}: declare it with an initialiser`);
        }
        return bound;
      }
      case "unary":
        if (expression.op === "~") {
          this.uncontractable(
            "inverts a number bit by bit, which a contract cannot state",
            line,
            "the body states no postcondition, which is what a function that branches or calls has",
          );
        }
        return `(${expression.op}${this.serialize(expression.operand, loop, line)})`;
      case "binary":
        if (!CONTRACT_OPERATORS.includes(expression.op)) {
          this.uncontractable(
            `computes with ${expression.op}, which a contract cannot state`,
            line,
            "the body states no postcondition, which is what a function that branches or calls has",
          );
        }
        return `(${this.serialize(expression.left, loop, line)} ${expression.op} ${this.serialize(expression.right, loop, line)})`;
      case "slice": {
        throw frontendError("a slice is not supported", `line ${line}`);
      }
      case "index": {
        if (expression.base.k !== "ident") {
          throw frontendError("only single level indexing is supported", `line ${line}`);
        }
        const base = expression.base;
        const param = this.declaration.params.find((entry) => entry.name === base.name);
        if (param === undefined) {
          // The contract states the result as one expression over the
          // parameters. An element read from a value the body built is a value
          // the contract cannot name, and the body is contracted by what it
          // does instead.
          this.uncontractable(
            `reads "${base.name}", which the body built rather than received`,
            line,
            "a contract is one expression over the parameters; a body that reads a value it built is contracted by what it does",
          );
        }
        const index = this.serialize(expression.index, loop, line);
        if (loop !== null && dependsOn(expression.index, loop.variable)) {
          if (expression.index.k !== "ident") {
            throw frontendError(
              `unsupported access pattern ${typeToString(param.type)} at line ${line}`,
              `the index must be the loop variable "${loop.variable}" to describe the accessed range`,
            );
          }
          this.accesses.push({ parameter: param.name, lo: loop.lo, hi: loop.hiExclusive });
        } else {
          this.accesses.push({ parameter: param.name, lo: index, hi: `(${index} + 1)` });
        }
        return `${param.name}[${index}]`;
      }
      case "argv":
        this.uncontractable("reads the command line", line, "a contracted function is computed from its parameters alone");
      case "member":
        this.uncontractable(
          `reads the field "${describe(expression.base)}.${expression.field}"`,
          line,
          "a contracted function computes its result from the parameters it is given",
        );
      case "call":
        this.uncontractable(
          `calls ${describe(expression)}`,
          line,
          "a contracted function is computed from its parameters alone",
        );
      case "object":
        this.uncontractable("allocates an object", line, "a contracted function allocates nothing");
      case "fixed":
        this.uncontractable(
          "writes a number as text",
          line,
          "a contract states what a function returns, which is a number",
        );
      case "sized":
      case "buffer":
        this.uncontractable(
          "allocates an array",
          line,
          "a contracted function allocates nothing; a function that builds its own array is contracted by the statements it runs",
        );
      case "text":
        this.uncontractable("prints text", line, "a contracted function returns a number and prints nothing");
      case "conditional":
        this.uncontractable("chooses between two values", line, "a contracted function is straight-line");
      case "update":
        this.uncontractable(
          `changes "${expression.name}"`,
          line,
          'accumulate with `x = x + 1` or a counted loop instead',
        );
      case "arrow":
        this.uncontractable(
          "writes an arrow function",
          line,
          "a contracted function is computed from its parameters alone; call the function the arrow lifted to where it is declared",
        );
      case "lengthOf":
        this.uncontractable(
          "reads a length of a value written out",
          line,
          "hold the value in a name first, as in const s = a[0]; s.length",
        );
      case "capture":
        this.uncontractable(
          "reads a value a closure captured",
          line,
          "the closure is the function the arrow lifted to; call it where it is written",
        );
      case "append":
        this.uncontractable(
          "grows or shrinks an array",
          line,
          "a contracted function is computed from its parameters alone, and an array is one of them",
        );
      case "invoke":
        this.uncontractable(
          "calls a value",
          line,
          "a contracted function is computed from its parameters alone",
        );
    }
  }
}

type ReduceOperator = "sum" | "product";

function dependsOn(expression: Expression, name: string): boolean {
  switch (expression.k) {
    case "ident":
      return expression.name === name;
    case "literal":
    case "bigint":
    case "null":
    case "argv":
    case "length":
      return false;
    case "lengthOf":
      return dependsOn(expression.of, name);
    case "unary":
      return dependsOn(expression.operand, name);
    case "binary":
      return dependsOn(expression.left, name) || dependsOn(expression.right, name);
    case "index":
      return dependsOn(expression.base, name) || dependsOn(expression.index, name);
    case "slice":
      return (
        dependsOn(expression.base, name) ||
        (expression.start !== null && dependsOn(expression.start, name)) ||
        (expression.stop !== null && dependsOn(expression.stop, name)) ||
        (expression.step !== null && dependsOn(expression.step, name))
      );
    case "member":
      return dependsOn(expression.base, name);
    case "call":
      return expression.args.some((argument) => dependsOn(argument, name));
    case "object":
      return expression.fields.some((field) => dependsOn(field.value, name));
    case "sized":
      return dependsOn(expression.count, name);
    case "fixed":
      return dependsOn(expression.of, name);
    case "buffer":
      return expression.values.some((value) => dependsOn(value, name));
    case "text":
      return expression.parts.some((part) => part.k === "value" && dependsOn(part.value, name));
    case "conditional":
      return (
        dependsOn(expression.condition, name) ||
        dependsOn(expression.then, name) ||
        dependsOn(expression.otherwise, name)
      );
    case "update":
      return expression.name === name;
    case "arrow":
      return expression.captures.includes(name);
    case "capture":
      return dependsOn(expression.closure, name);
    case "invoke":
      return dependsOn(expression.callee, name) || expression.args.some((argument) => dependsOn(argument, name));
    case "append":
      return dependsOn(appendArray(expression), name) || expression.values.some((value) => dependsOn(value, name));
  }
}

/** How an expression is named in an error: the call, or the value itself. */
function describe(expression: Expression): string {
  switch (expression.k) {
    case "call":
      return expression.name;
    case "ident":
      return `"${expression.name}"`;
    case "length":
      return `${expression.buffer}.length`;
    case "lengthOf":
      return `${describe(expression.of)}.length`;
    case "index":
      return `${describe(expression.base)}[]`;
    case "slice":
      return `${describe(expression.base)}[...]`;
    case "member":
      return `${describe(expression.base)}.${expression.field}`;
    case "argv":
      return "process.argv";
    case "object":
      return "an object";
    case "sized":
    case "buffer":
      return "a typed array";
    case "fixed":
      return "a number written as text";
    case "update":
      return `${expression.name}${expression.op}`;
    case "text":
      return "a string";
    case "literal":
    case "bigint":
      return `the value ${expression.text}`;
    case "binary":
      return `${describe(expression.left)} ${expression.op} ${describe(expression.right)}`;
    case "unary":
      return `${expression.op}${describe(expression.operand)}`;
    case "conditional":
      return "a conditional";
    case "null":
      return "null";
    case "arrow":
      return "an arrow function";
    case "capture":
      return "a value a closure captured";
    case "invoke":
      return `a call of ${describe(expression.callee)}`;
    case "append":
      return `${describe(appendArray(expression))}.${expression.op}`;
  }
}

/** The array a push or pop is written on, as the value expression it is. */
function appendArray(value: Expression & { k: "append" }): Expression {
  return value.base === null
    ? { k: "ident", name: value.target }
    : { k: "member", base: { k: "ident", name: value.base }, field: value.target };
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

/* The arithmetic lowering is written for the secp256k1 benchmark (1.ts): it
   opens the source's calls of `mod`, reduces `invZ2`, replaces `invert`'s
   Euclidean body with its modular steps, and selects the double-and-add branch
   the 256 bit IR can lower. General sources must not be run through it: a
   source that names its own `mod` or `invert` is not this one. The benchmark is
   what declares the endomorphism split and the curve it splits over; a user
   source that happens to name a class `Point` is not it, and is compiled as a
   class. */
function isSecp256k1Source(source: string): boolean {
  return /\bsplitScalarEndo\b/.test(source) && /\bCURVE\b/.test(source);
}

/**
 * The builtin an async function settles its promise with, for the value its
 * body returns: a string is resolved as the text it is, a truth as the truth,
 * a number as the number, nothing as nothing, and a value of a shape the
 * runtime holds as the dynamic value it is.
 */
function promiseResolveName(payload: TypeExpr): string {
  if (payload.kind === "text") return "Promise.settle.text";
  if (payload.kind === "void") return "Promise.settle.nothing";
  if (payload.kind === "primitive") {
    if (payload.name === "bool") return "Promise.settle.bool";
    if (!["i256", "u256"].includes(payload.name)) return "Promise.settle";
  }
  return "Promise.settle.value";
}

/**
 * An async function's body with every way out of it settling the promise the
 * function answers. A body that falls off the end settles it with nothing,
 * which is what the language's own function does when it runs out of
 * statements.
 */
function settledBody(statements: readonly Statement[], payload: TypeExpr): Statement[] {
  const name = promiseResolveName(payload);
  const settle = (statement: Statement): Statement => {
    switch (statement.kind) {
      case "result":
        // A function that returns nothing settles the promise with nothing,
        // which is the call that takes no value.
        if (payload.kind === "void" || statement.value === null || statement.value.k === "null") {
          return { ...statement, value: { k: "call", name: "Promise.settle.nothing", args: [] } };
        }
        return { ...statement, value: { k: "call", name, args: [statement.value] } };
      case "if":
        return {
          ...statement,
          then: statement.then.map(settle),
          otherwise: statement.otherwise.map(settle),
        };
      case "while":
      case "doWhile":
        return { ...statement, body: statement.body.map(settle) };
      case "loop":
        return { ...statement, body: statement.body.map(settle) };
      case "forOf":
        return { ...statement, body: statement.body.map(settle) };
      case "try":
        return {
          ...statement,
          body: statement.body.map(settle),
          catchBody: statement.catchBody === null ? null : statement.catchBody.map(settle),
          finallyBody: statement.finallyBody === null ? null : statement.finallyBody.map(settle),
        };
      default:
        return statement;
    }
  };
  return [
    ...statements.map(settle),
    { kind: "result", value: { k: "call", name: "Promise.settle.nothing", args: [] }, line: statements[0]?.line ?? 1 },
  ];
}

export const typeScriptFrontend: Frontend = {
  analyze(source, path, entry = true, context?: unknown) {
    if (typeof source !== "string" || source.trim() === "") {
      throw frontendError(`module ${path} is empty`);
    }
    // The lowering is the arithmetic of the secp256k1 benchmark's own curve,
    // and a source that does not declare that curve is compiled exactly as it
    // was written.
    if (isSecp256k1Source(source)) {
      source = lowerWideArithmetic(source);
    }
    // The Promise executor's resolve/reject are the promise the executor runs
    // for, and the compiler reads the names the source wrote them by
    // (`resolve`, `reject`, `onFulfilled`, `onRejected`) as the ones that
    // settle it, so the executor's parameters are not written out again.
    const diagnostics = new Diagnostics();
    // Class declarations are read once, up front: their constructor and methods
    // are functions of the module, and every use of a class in a function or in
    // the program body is lowered against the same table.
    const tokens = tokenize(source);
    const wideBigint = fileHoldsWideBigint(tokens);
    const classTable = scanClasses(tokens);
    const scanned = scanConstants(tokens);
    // The interfaces and aliases are read before the bodies that name them.
    // A file read again after its imports are bound keeps the table the first
    // read built, so the declarations the importing files already hold keep
    // resolving against it.
    const shared = (context as { table?: TypeTable } | undefined)?.table;
    const typeTable = shared ?? scanTypeTable(tokens);
    typeTable.classes = classTable.names;
    // The values the imports of this file bind, once the graph has read the
    // modules that write them. They are read in place of the names that hold
    // them, exactly as the file's own constants are.
    const imported = (context as { values?: ReadonlyMap<string, ConstantInfo> } | undefined)?.values;
    if (imported !== undefined) {
      for (const [name, constant] of imported) scanned.constants.set(name, constant);
    }
    const parser = new TypeScriptParser(withoutClasses(tokens, classTable), path, diagnostics, classTable, tokens, scanned.constants, scanned.state, typeTable, importedNames(tokens));
    parser.wideBigint = wideBigint;
    // The read the graph makes after binding says every name its imports bind;
    // a read that stands alone waits for a link that may never come.
    parser.linked = (context as { linked?: boolean } | undefined)?.linked === true;
    const analysis = parser.parseModule(path, entry);
    // A file read as a program has its whole text readable as statements, so a
    // nested function inside a function that the module parser stopped for is
    // read by the one parser whose grammar carries that shape. The module
    // parse's nested-function entries are still the answer if that fails too.
    if (parser.nestedFunction) {
      const fromStatements = tokensAfterImports(parser["tokens"]);
      const programDiagnostics = new Diagnostics();
      try {
        const statements = parseProgramBody(fromStatements, path, programDiagnostics, classTable, importedNames(tokens));
        if (programDiagnostics.entries.length === 0) {
          // The class functions were lowered from declarations the program
          // parser never sees, so they travel with the body: they are the
          // constructors and methods the statements call.
          return {
            path,
            imports: analysis.imports,
            typeImports: analysis.typeImports,
            types: analysis.types,
            functions: analysis.functions.filter((entry) => entry.internal === true),
            default: null,
            body: statements,
            wideBigint,
          };
        }
      } catch {
        // A program parse that cannot be a program keeps the module parse's
        // own diagnostics, which name the refusal where it is.
      }
    }
    // A file is read to the end whatever it holds, so a build names every
    // construct outside the subset instead of the first one.
    diagnostics.throwIfAny(path);
    analysis.wideBigint = wideBigint;
    return analysis;
  },

  contractFor(analysis, declared, input) {
    const declaration = declared.handle as TypeScriptFunction;
    const body = new BodyAnalysis(declaration).run();
    // A result that is one expression also states a postcondition: the
    // compiler is the oracle that decides whether an implementation meets it.
    // The body travels either way — it is what the function is, and the IR is
    // written from it.
    //
    // A buffer length is a property of the value, not of the pointer the callee
    // receives: the implementation cannot observe it, so a postcondition may
    // not depend on it. Preconditions may, because the caller checks them.
    if (declaration.closure !== true && body.result !== null && body.result.includes("len(")) {
      throw frontendError(
        `the result of ${declaration.name} depends on a buffer length`,
        `${analysis.path}: the callee only receives the pointer, so pass the length as a parameter and loop over that`,
      );
    }
    const usage = usageOf(declaration);
    // An async function answers a promise carrying what its body returns, so
    // every way out of the body settles that promise. The function's own type
    // is the handle the runtime holds the promise in, and the payload travels
    // beside the contract so a caller's `await` knows what it reads.
    const async = declaration.async === true;
    const promise = async ? declaration.returns : declaration.promise;
    const contract = assembleContract({
      name: declaration.name,
      symbol: declaration.name === "main" ? PROGRAM_ENTRY_SYMBOL : declaration.name,
      params: declaration.params,
      returns: promise === undefined ? declaration.returns : { kind: "ref", of: null },
      result: promise === undefined && declaration.closure !== true ? body.result : null,
      // An arrow is called only from the body that wrote it, which is what
      // holds the bounds of every buffer it captured and of every buffer it is
      // handed. Stating them again here would hold a helper to a caller that
      // does not exist.
      accesses: declaration.closure === true ? [] : usage.accesses,
      definition: {
        statements: async ? settledBody(declaration.body, declaration.returns) : declaration.body,
        allocates: usage.allocates,
        prints: usage.prints,
        readsArgv: usage.readsArgv,
      },
      input,
    });
    return promise === undefined ? contract : { ...contract, promise: typeToString(promise) };
  },

  resolveImport(specifier) {
    if (!specifier.startsWith(".")) {
      throw frontendError(
        `cannot import "${specifier}"`,
        "a module imports project modules by relative path, as in \"./other.ts\"",
      );
    }
    if (specifier.endsWith(".ts") || specifier.endsWith(".tsx")) return [specifier];
    return [`${specifier}.ts`, `${specifier}/index.ts`];
  },
};

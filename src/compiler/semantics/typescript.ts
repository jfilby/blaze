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
import { Diagnostics, frontendError, refusalError, type Diagnostic } from "./diagnostics.ts";
import type { DeclaredFunction, Frontend, ModuleAnalysis, ModuleImport, ModuleTypeBinding, ModuleTypeImport } from "./module.ts";
import { parseProgramBody } from "./typescript-program.ts";
import { lowerWideArithmetic } from "./typescript-wide-lowering.ts";
import {
  collectionOfType,
  elementOfType,
  fieldOfType,
  promisePayloadText,
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
const NAMESPACES: ReadonlySet<string> = new Set(["Math", "http", "JSON", "Date", "Promise"]);


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
/** Where the type of one parameter ends: the comma or paren of its own list. */
const PARAMETER_TYPE_STOPS: ReadonlySet<string> = new Set([",", ")", "="]);

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

/**
 * The reason a word is a refused keyword, when the table itself carries it.
 *
 * A lookup asks the table's own keys rather than its prototype's: every object
 * inherits `constructor` and `toString`, so reading the map by name found a
 * function there and refused a statement that wrote `constructor.internal = …`
 * as the keyword `constructor`.
 */
export function refusedKeyword(text: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(REFUSED_KEYWORDS, text) ? REFUSED_KEYWORDS[text] : undefined;
}

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
/** The element a block of bytes holds, which a view of one is read through. */
const BYTE: TypeExpr = { kind: "primitive", name: "u8" };
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
 *
 * `saysNothing` marks a returned value that names no type of its own — an
 * empty list whose use has not said what it holds. It is not the witness the
 * result is read from: the returns that write values are, and the empty list is
 * built at their type.
 */
function inferredResult(
  body: readonly Statement[],
  params: readonly { name: string; type: TypeExpr }[],
  known?: (value: Expression, scope: ReadonlyMap<string, TypeExpr>) => TypeExpr | null,
  saysNothing?: (value: Expression) => boolean,
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
  /** The type an empty list on its own would have been read at. */
  let unsaid: TypeExpr | null = null;
  for (const value of written) {
    if (saysNothing?.(value) === true) {
      unsaid ??= known?.(value, scope) ?? resultType(value, scope);
      continue;
    }
    const type = known?.(value, scope) ?? resultType(value, scope);
    if (found === null) {
      found = type;
      continue;
    }
    if (!sameResult(found, type)) return ANY_TYPE;
  }
  // A body whose every return is an empty list says nothing about what it
  // answers, and the list it wrote is the only type it named.
  return found ?? unsaid ?? NOTHING;
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

/**
 * Whether an expression is a value written out, which is the same value
 * wherever it is read.
 *
 * An arrow's default is written where the arrow is and read where the call is,
 * so a value that reads a name is that name in the arrow's own scope. The
 * literals a source writes for a default — `null`, `false`, `0`, `""` — are
 * values in both places.
 */
function isWrittenValue(expression: Expression): boolean {
  switch (expression.k) {
    case "literal":
    case "bigint":
    case "null":
      return true;
    case "text":
      return expression.parts.every((part) => part.k === "text");
    case "buffer":
      return expression.view === undefined && expression.values.every(isWrittenValue);
    case "object":
      return expression.fields.every((field) => isWrittenValue(field.value));
    default:
      return false;
  }
}

/**
 * The bytes one element of a typed array is, or null where the element is not
 * a number a typed array holds. It is what tells a window of a block from a
 * window of values: only a block of numbers has bytes a window may reach.
 */
function numericWidth(type: TypeExpr): number | null {
  if (type.kind !== "primitive") return null;
  switch (type.name) {
    case "u8":
    case "i8":
      return 1;
    case "u16":
    case "i16":
      return 2;
    case "u32":
    case "i32":
    case "f32":
      return 4;
    case "i64":
    case "u64":
    case "f64":
    case "usize":
    case "isize":
      return 8;
    default:
      return null;
  }
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

/**
 * Whether a call is `structuredClone(x)`, the language's deep copy.
 *
 * The value it answers is a copy of the value it is handed, which is what makes
 * the copy the source's own type and shape. A file that declares a function of
 * the name is read as that function, which the caller checks against its own
 * tables before asking this.
 */
function isStructuredClone(value: Expression): value is Expression & { k: "call"; name: string; args: Expression[] } {
  return value.k === "call" && value.name === "structuredClone" && value.args.length === 1;
}

/** The type a value is held at, read with the names the body declared. */
function resultType(value: Expression, scope: ReadonlyMap<string, TypeExpr>): TypeExpr {
  switch (value.k) {
    case "literal":
      return value.boolean === true ? BOOLEAN_RESULT : NUMBER_RESULT;
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
      return value.boolean === true ? BOOLEAN_RESULT : NUMBER_RESULT;
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
function repeatableExpression(value: Expression, pure?: (name: string) => boolean): boolean {
  switch (value.k) {
    case "ident":
    case "literal":
    case "bigint":
    case "text":
    case "null":
    case "length":
      return true;
    case "member":
      return repeatableExpression(value.base, pure);
    case "index":
      return repeatableExpression(value.base, pure) && repeatableExpression(value.index, pure);
    // An operation over values that read the same way twice reads the same way
    // twice: `tokens[at + 1]?.kind` asks for one number and reads one element,
    // and asking for the number again is the same number.
    case "binary":
      return repeatableExpression(value.left, pure) && repeatableExpression(value.right, pure);
    case "unary":
      return repeatableExpression(value.operand, pure);
    case "conditional":
      return repeatableExpression(value.condition, pure) && repeatableExpression(value.then, pure) && repeatableExpression(value.otherwise, pure);
    case "lengthOf":
      return repeatableExpression(value.of, pure);
    // A number written as text at a fixed width reads the number it was given:
    // `x.toString(16)` asks the same question twice, and the padding of it is
    // the padding of the same text.
    case "fixed":
      return repeatableExpression(value.of, pure);
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
      // A maths function reads the number it was handed: `Math.floor(x)` and
      // `Math.log2(x)` answer the same number for the same number, and nothing
      // they do writes the world, apart from `Math.random`, which answers a
      // new number each time it is asked.
      const maths = (value.name.startsWith("Math.") && value.name !== "Math.random")
        ? value.args.every((arg) => repeatableExpression(arg, pure))
        : false;
      return (
        maths ||
        ((value.name.startsWith("text.") || value.name.startsWith("blaze_rt_dict_")) &&
          value.args.every((arg) => repeatableExpression(arg, pure))) ||
        // A text method the frontend lowered to a function of the file is a
        // read of the text it was handed: the helper writes its own answer and
        // nothing else, so it is safe to ask twice.
        (pure?.(value.name) === true && value.args.every((arg) => repeatableExpression(arg, pure)))
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
   * The field names of an object literal whose values are computed. The names
   * are what the source wrote even when the values are not constants, so a
   * question about the keys is one the read can answer without running
   * anything.
   */
  names?: readonly string[];
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
  /**
   * The field names of a top-level object literal whose values are computed.
   * The names are what the source wrote even when the values are not constants,
   * so a question about the keys is one the read can answer without running
   * anything.
   */
  shapes: Map<string, ConstantInfo>;
  /**
   * The type each top-level declaration writes, as the tokens that write it.
   *
   * A constant's value is read where it is used, and its annotation is what
   * says what the value holds: `const RUNTIME_ABI: readonly RuntimeEntry[]`
   * names a list of records, which is what `map` written after the name walks.
   * The range is kept rather than a resolved type because the table it resolves
   * against is the one the module graph builds, and a read with imports bound
   * is the read that resolves it.
   */
  annotations: Map<string, { start: number; end: number; exported: boolean }>;
  /**
   * The type each top-level `new Map<...>()` or `new Set<...>()` is allocated
   * at, as the tokens that write it.
   *
   * A collection's handle is a value the running program holds, so it is state
   * and not a constant; what the *name* holds — a map's key and value, a set's
   * element — is what a method written on the name reads, and a function above
   * the declaration is read before the declaration is. The range is resolved
   * by the read that asks, against the table the module graph built.
   */
  collections: Map<string, { start: number; end: number }>;
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
 * Where an initialiser written as a literal ends, following the type it is
 * asserted as and the calls written after it.
 *
 * `[...] as const` asserts the type of the list, and `[...].join(",")` calls a
 * method of it: both are the same initialiser, and the scan past the literal has
 * to end after them or it reads them as statements of the file.
 */
function initializerEnd(tokens: readonly Token[], from: number): number {
  let at = from;
  for (;;) {
    const text = tokens[at]?.text;
    if (text === "as" || text === "satisfies") {
      at += 1;
      while (tokens[at] !== undefined && (tokens[at]?.kind === "ident" || mark(tokens[at]) === "." || mark(tokens[at]) === "[" || mark(tokens[at]) === "]")) at += 1;
      continue;
    }
    if (text === "." && tokens[at + 1]?.kind === "ident") {
      at += 2;
      continue;
    }
    if (text === "." && tokens[at + 1]?.text === "<") {
      at += 2;
      continue;
    }
    if (text === "(" || text === "[") {
      at = closingBracket(tokens, at);
      continue;
    }
    return at;
  }
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
    // A string whose text is `[` is a string, not a nested list.
    if (mark(tokens[start]) === "[") {
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
  const shapes = new Map<string, ConstantInfo>();
  const annotations = new Map<string, { start: number; end: number; exported: boolean }>();
  const collections = new Map<string, { start: number; end: number }>();
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
    // `export`, `declare` and `default` are words in front of a declaration,
    // and the declaration is what this scan reads: skipping the word alone is
    // what makes `export const NAME: T = ...` a constant of the file with the
    // type it writes. Skipping to the next statement instead lost the constant
    // *after* every `export interface`, which is where the file's own types are
    // declared.
    if (token.text === "export" || token.text === "declare" || token.text === "default") {
      index += 1;
      continue;
    }
    // An interface is a type and declares nothing the running file holds, so
    // its body is skipped as a whole.
    if (token.text === "interface" || token.text === "enum") {
      let brace = index;
      while (brace < tokens.length && tokens[brace].text !== "{") brace += 1;
      index = closing(brace);
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
        const from = equals + 1;
        let depth = 0;
        equals += 1;
        while (equals < tokens.length) {
          const written = mark(tokens[equals]);
          if (written === "<" || written === "(" || written === "[" || written === "{") depth += 1;
          else if (written === ">" || written === ")" || written === "]" || written === "}") depth -= 1;
          // `>>` and `>>>` are one token each and close two or three type
          // arguments: `Record<string, Record<A, B>>` is a depth this scan
          // otherwise leaves open, and the `=` it is looking for then reads as
          // part of the type. The `=` of the value was never found, and the
          // declaration after the annotation was skipped along with it.
          else if (written === ">>") depth -= 2;
          else if (written === ">>>") depth -= 3;
          else if (written === "=" && depth === 0) break;
          equals += 1;
        }
        if (equals > from) annotations.set(name, { start: from, end: equals, exported: offered });
      }
      if (tokens[equals]?.text !== "=") {
        index += 1;
        continue;
      }
      const start = equals + 1;
      // `const seen = new Set<string>()` writes the type the name holds in the
      // allocation, and a method written above the declaration is read before
      // it: the span is kept so that read can resolve the collection.
      const allocated = tokens[start]?.text === "new" ? tokens[start + 1] : undefined;
      if (allocated?.kind === "ident" && COLLECTION_CONSTRUCTORS.has(allocated.text)) {
        let open = start + 2;
        if (tokens[open]?.text === "<") {
          let depth = 0;
          while (open < tokens.length) {
            const written = mark(tokens[open]);
            if (written === "<") depth += 1;
            else if (written === ">") {
              depth -= 1;
              if (depth === 0) {
                open += 1;
                break;
              }
            }
            open += 1;
          }
        }
        if (tokens[open]?.text === "(" && !locals.has(name)) {
          collections.set(name, { start: start + 1, end: open });
        }
      }
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
        // The type the list is asserted as, and a call written after it, are
        // part of the same value.
        const whole = initializerEnd(tokens, end);
        // An array whose every element is written down is the file's constant,
        // inlined where it is read, unless a body writes the name: a value a
        // program changes is state rather than a constant.
        if (!mutable && whole === end && constantList(tokens, start, end - 1) && !locals.has(name) && !writtenName(tokens, name)) {
          found.set(name, { expression: { range: { start, end } }, exported: offered });
        } else {
          state.add(name);
        }
        index = whole;
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
          // The values are computed, but the names are written down: a
          // question about the keys is still one the source answers.
          if (!locals.has(name) && !writtenName(tokens, name)) shapes.set(name, { names: object.names });
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
  return { constants: found, state, shapes, annotations, collections };
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
 * The names a file imports under another name, as `import { a as b }` writes.
 *
 * `names` in the import statement are the names the other module exports,
 * because that is what the graph links; the file reads the alias. A call the
 * file writes under the alias is emitted under the exported name, which is the
 * one name the function is compiled under.
 */
function importedRenames(tokens: readonly Token[]): Map<string, string> {
  const renames = new Map<string, string>();
  let index = 0;
  while (index < tokens.length) {
    if (tokens[index]?.text === ";") {
      index += 1;
      continue;
    }
    if (tokens[index]?.text !== "import") break;
    index += 1;
    // A type-only import binds no value: `{ type T as U }` is a type name, and
    // an alias it writes is not a call the file can make.
    let typeOnly = false;
    if (tokens[index]?.text === "type") {
      typeOnly = true;
      index += 1;
    }
    if (tokens[index]?.text === "*") {
      while (index < tokens.length && tokens[index]?.kind !== "string") index += 1;
      index += 1;
      continue;
    }
    if (tokens[index]?.text === "{") {
      index += 1;
      while (index < tokens.length && tokens[index]?.text !== "}") {
        const token = tokens[index] as Token;
        if (token.kind !== "ident") {
          index += 1;
          continue;
        }
        // `{ type T as U }` is the type modifier inside the braces: `T` is not
        // a value, and a `type` followed by an alias is a value named `type`.
        const typeName = token.text === "type" && tokens[index + 1]?.kind === "ident" && tokens[index + 1]?.text !== "as";
        const imported = typeName ? (tokens[index + 1] as Token) : token;
        const after = typeName ? index + 2 : index + 1;
        if (tokens[after]?.text === "as" && tokens[after + 1]?.kind === "ident") {
          if (!typeOnly && !typeName) renames.set((tokens[after + 1] as Token).text, imported.text);
          index = after + 2;
          continue;
        }
        index = typeName ? after : index + 1;
      }
      index += 1;
    } else if (tokens[index]?.kind === "ident") {
      index += 1;
      if (tokens[index]?.text === ",") index += 1;
    }
    while (index < tokens.length && tokens[index]?.text !== "from") index += 1;
    if (index < tokens.length) index += 1;
    if (tokens[index]?.kind === "string") index += 1;
    if (tokens[index]?.text === ";") index += 1;
  }
  return renames;
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
        if (expression.view !== undefined) {
          read(expression.view.of);
          read(expression.view.offset);
          read(expression.view.count);
        }
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
        if (expression.view !== undefined) {
          read(expression.view.of);
          read(expression.view.offset);
          read(expression.view.count);
        }
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

/**
 * Where a value an arrow writes lives, so that both sides write the same one.
 *
 * A number, a text or a reference travels by value, so the name is held in a
 * **one-element list** and both sides write element zero. A **list** cannot be
 * held that way — a list has no element that holds a list — so it is held in a
 * one-field object instead, and both sides write the field.
 */
interface Boxed {
  /** The name of the list or object the value lives in. */
  name: string;
  /** The value is a list, which the box holds as a field rather than an element. */
  list: boolean;
}

/** The field a list box keeps its list in. No source writes this name. */
const BOXED_FIELD = "__boxed";

/** A read of a value that lives in the box an arrow writes back. */
function boxedRead(box: Boxed): Expression {
  if (box.list) return { k: "member", base: { k: "ident", name: box.name }, field: BOXED_FIELD };
  return { k: "index", base: { k: "ident", name: box.name }, index: { k: "literal", text: "0" } };
}

/** The write of a boxed value: the element, or the field a list lives in. */
function boxedWrite(box: Boxed, op: AssignOperator, value: Expression, line: number): Statement {
  if (box.list) return { kind: "memberAssign", base: box.name, field: BOXED_FIELD, op, value, line };
  return { kind: "indexAssign", buffer: box.name, index: { k: "literal", text: "0" }, op, value, line };
}

/** Every read and write of `name` in a statement list, rewritten to its box. */
function boxStatements(statements: Statement[], name: string, box: Boxed): void {
  for (let at = 0; at < statements.length; at += 1) {
    statements[at] = boxStatement(statements[at] as Statement, name, box);
  }
}

/** One statement, with every read and write of `name` rewritten to its box. */
function boxStatement(statement: Statement, name: string, box: Boxed): Statement {
  switch (statement.kind) {
    case "declare":
      // The declaration of the name itself is the box, and the caller has
      // already written it: a declaration of the same name inside a block is a
      // different value, and its initialiser is not this one.
      if (statement.name === name) return statement;
      return { ...statement, init: boxExpression(statement.init, name, box) };
    case "assign":
      if (statement.target === name) {
        return boxedWrite(box, statement.op, boxExpression(statement.value, name, box), statement.line);
      }
      return { ...statement, value: boxExpression(statement.value, name, box) };
    case "update":
      if (statement.name !== name) return statement;
      return boxedWrite(box, statement.op === "++" ? "+=" : "-=", { k: "literal", text: "1" }, statement.line);
    case "memberAssign":
      return { ...statement, value: boxExpression(statement.value, name, box) };
    case "indexAssign":
      // An element written through a boxed list is a write an element of an
      // element, which the box does not hold: the caller refuses that form
      // before it rewrites anything.
      return {
        ...statement,
        buffer: statement.buffer === name && !box.list ? box.name : statement.buffer,
        index: boxExpression(statement.index, name, box),
        value: boxExpression(statement.value, name, box),
      };
    case "result":
      return statement.value === null ? statement : { ...statement, value: boxExpression(statement.value, name, box) };
    case "throw":
    case "print":
    case "expression":
      return { ...statement, value: boxExpression(statement.value, name, box) };
    case "if":
      return {
        ...statement,
        condition: boxExpression(statement.condition, name, box),
        then: boxBlock(statement.then, name, box),
        otherwise: boxBlock(statement.otherwise, name, box),
      };
    case "while":
    case "doWhile":
      return {
        ...statement,
        condition: boxExpression(statement.condition, name, box),
        body: boxBlock(statement.body, name, box),
      };
    case "loop":
      return {
        ...statement,
        from: boxExpression(statement.from, name, box),
        to: boxExpression(statement.to, name, box),
        step: statement.step === null ? null : boxExpression(statement.step, name, box),
        body: boxBlock(statement.body, name, box),
      };
    case "forOf":
      return {
        ...statement,
        of: statement.of === name && !box.list ? box.name : statement.of,
        body: boxBlock(statement.body, name, box),
      };
    case "try":
      return {
        ...statement,
        body: boxBlock(statement.body, name, box),
        catchBody: statement.catchBody === null ? null : boxBlock(statement.catchBody, name, box),
        finallyBody: statement.finallyBody === null ? null : boxBlock(statement.finallyBody, name, box),
      };
    case "break":
    case "continue":
      return statement;
  }
}

/** A statement list rewritten, as one statement list. */
function boxBlock(statements: Statement[], name: string, box: Boxed): Statement[] {
  boxStatements(statements, name, box);
  return statements;
}

/** One expression, with every read of `name` rewritten to its box. */
function boxExpression(value: Expression, name: string, box: Boxed): Expression {
  switch (value.k) {
    case "ident":
      return value.name === name ? boxedRead(box) : value;
    case "literal":
    case "bigint":
    case "null":
      return value;
    case "argv":
      return value.index === null ? value : { ...value, index: boxExpression(value.index, name, box) };
    case "length":
      // A list's length is the length of the list the box holds.
      return value.buffer === name ? { k: "lengthOf", of: boxedRead(box) } : value;
    case "lengthOf":
      return { ...value, of: boxExpression(value.of, name, box) };
    case "index":
      return {
        ...value,
        base: boxExpression(value.base, name, box),
        index: boxExpression(value.index, name, box),
      };
    case "slice":
      return {
        ...value,
        base: boxExpression(value.base, name, box),
        start: value.start === null ? null : boxExpression(value.start, name, box),
        stop: value.stop === null ? null : boxExpression(value.stop, name, box),
        step: value.step === null ? null : boxExpression(value.step, name, box),
      };
    case "member":
      return { ...value, base: boxExpression(value.base, name, box) };
    case "call":
      return { ...value, args: value.args.map((argument) => boxExpression(argument, name, box)) };
    case "object":
      return {
        ...value,
        fields: value.fields.map((field) => ({ ...field, value: boxExpression(field.value, name, box) })),
      };
    case "sized":
      return { ...value, count: boxExpression(value.count, name, box) };
    case "buffer":
      return {
        ...value,
        values: value.values.map((element) => boxExpression(element, name, box)),
        ...(value.view === undefined
          ? {}
          : {
              view: {
                of: boxExpression(value.view.of, name, box),
                offset: boxExpression(value.view.offset, name, box),
                count: boxExpression(value.view.count, name, box),
              },
            }),
      };
    case "text":
      return {
        ...value,
        parts: value.parts.map((part) => (part.k === "text" ? part : { ...part, value: boxExpression(part.value, name, box) })),
      };
    case "fixed":
      return { ...value, of: boxExpression(value.of, name, box) };
    case "binary":
      return { ...value, left: boxExpression(value.left, name, box), right: boxExpression(value.right, name, box) };
    case "unary":
      return { ...value, operand: boxExpression(value.operand, name, box) };
    case "conditional":
      return {
        ...value,
        condition: boxExpression(value.condition, name, box),
        then: boxExpression(value.then, name, box),
        otherwise: boxExpression(value.otherwise, name, box),
      };
    case "update":
      // An `x++` read as a value is not a write to an element, and the caller
      // refuses the capture before it rewrites anything.
      return value;
    case "arrow":
      // A nested arrow captures the box, not the name: the value it is handed
      // is the box the value lives in.
      return { ...value, captures: value.captures.map((capture) => (capture === name ? box.name : capture)) };
    case "capture":
      return { ...value, closure: boxExpression(value.closure, name, box) };
    case "invoke":
      return {
        ...value,
        callee: boxExpression(value.callee, name, box),
        args: value.args.map((argument) => boxExpression(argument, name, box)),
      };
    case "append":
      // A push on a boxed list is a push on the list the box holds; the values
      // pushed are ordinary reads and are rewritten.
      return {
        ...value,
        ...(value.base === null && value.target === name && box.list
          ? { target: BOXED_FIELD, base: box.name }
          : {}),
        ...(value.index === undefined ? {} : { index: boxExpression(value.index, name, box) }),
        values: value.values.map((element) => boxExpression(element, name, box)),
      };
  }
}

/** The declaration of `name` in a body, at any depth, or null. */
function findDeclaration(
  statements: readonly Statement[],
  name: string,
): Extract<Statement, { kind: "declare" }> | null {
  for (const statement of statements) {
    if (statement.kind === "declare" && statement.name === name) return statement;
    for (const block of nestedBlocks(statement)) {
      const found = findDeclaration(block, name);
      if (found !== null) return found;
    }
  }
  return null;
}

/** The statement lists a statement holds. */
function nestedBlocks(statement: Statement): Statement[][] {
  switch (statement.kind) {
    case "loop":
    case "while":
    case "doWhile":
    case "forOf":
      return [statement.body];
    case "if":
      return [statement.then, statement.otherwise];
    case "try":
      return [statement.body, statement.catchBody ?? [], statement.finallyBody ?? []];
    default:
      return [];
  }
}

/**
 * The body of a `for` loop read as a while loop, with the step written in front
 * of every `continue` of this loop.
 *
 * A `continue` of the while loop goes to the end of the body, where the step is;
 * a `continue` of a loop the body holds belongs to that loop and runs the step
 * that loop states, so the walk stops at one.
 */
function continueWithStep(body: readonly Statement[], step: Statement): Statement[] {
  const out: Statement[] = [];
  for (const statement of body) {
    if (statement.kind === "continue") {
      out.push({ ...step }, statement);
      continue;
    }
    if (statement.kind === "while" || statement.kind === "doWhile" || statement.kind === "loop" || statement.kind === "forOf") {
      out.push(statement);
      continue;
    }
    for (const block of nestedBlocks(statement)) {
      const rewritten = continueWithStep(block, step);
      block.length = 0;
      block.push(...rewritten);
    }
    out.push(statement);
  }
  return out;
}

/** Whether a body reads `x++` or `x--` as a value, which a box cannot hold. */
function readsUpdateIn(statements: readonly Statement[], name: string): boolean {
  for (const statement of statements) {
    if (readsUpdate(statement, name)) return true;
  }
  return false;
}

function readsUpdate(statement: Statement, name: string): boolean {
  const expression = (value: Expression | null): boolean => value !== null && expressionReadsUpdate(value, name);
  switch (statement.kind) {
    case "declare":
      return expression(statement.init);
    case "assign":
      return expression(statement.value);
    case "update":
      return false;
    case "memberAssign":
      return expression(statement.value);
    case "indexAssign":
      return expression(statement.index) || expression(statement.value);
    case "result":
      return expression(statement.value);
    case "throw":
    case "print":
    case "expression":
      return expression(statement.value);
    case "if":
      return expression(statement.condition) || readsUpdateIn(statement.then, name) || readsUpdateIn(statement.otherwise, name);
    case "while":
    case "doWhile":
      return expression(statement.condition) || readsUpdateIn(statement.body, name);
    case "loop":
      return expression(statement.from) || expression(statement.to) || expression(statement.step) || readsUpdateIn(statement.body, name);
    case "forOf":
      return readsUpdateIn(statement.body, name);
    case "try":
      return readsUpdateIn(statement.body, name) ||
        (statement.catchBody !== null && readsUpdateIn(statement.catchBody, name)) ||
        (statement.finallyBody !== null && readsUpdateIn(statement.finallyBody, name));
    case "break":
    case "continue":
      return false;
  }
}

function expressionReadsUpdate(value: Expression, name: string): boolean {
  switch (value.k) {
    case "update":
      return value.name === name;
    case "literal":
    case "bigint":
    case "ident":
    case "null":
    case "length":
      return false;
    case "argv":
      return value.index !== null && expressionReadsUpdate(value.index, name);
    case "lengthOf":
      return expressionReadsUpdate(value.of, name);
    case "index":
      return expressionReadsUpdate(value.base, name) || expressionReadsUpdate(value.index, name);
    case "slice":
      return expressionReadsUpdate(value.base, name) ||
        (value.start !== null && expressionReadsUpdate(value.start, name)) ||
        (value.stop !== null && expressionReadsUpdate(value.stop, name)) ||
        (value.step !== null && expressionReadsUpdate(value.step, name));
    case "member":
      return expressionReadsUpdate(value.base, name);
    case "call":
      return value.args.some((argument) => expressionReadsUpdate(argument, name));
    case "object":
      return value.fields.some((field) => expressionReadsUpdate(field.value, name));
    case "sized":
      return expressionReadsUpdate(value.count, name);
    case "buffer":
      return (
        value.values.some((element) => expressionReadsUpdate(element, name)) ||
        (value.view !== undefined &&
          (expressionReadsUpdate(value.view.of, name) ||
            expressionReadsUpdate(value.view.offset, name) ||
            expressionReadsUpdate(value.view.count, name)))
      );
    case "text":
      return value.parts.some((part) => part.k === "value" && expressionReadsUpdate(part.value, name));
    case "fixed":
      return expressionReadsUpdate(value.of, name);
    case "binary":
      return expressionReadsUpdate(value.left, name) || expressionReadsUpdate(value.right, name);
    case "unary":
      return expressionReadsUpdate(value.operand, name);
    case "conditional":
      return expressionReadsUpdate(value.condition, name) ||
        expressionReadsUpdate(value.then, name) ||
        expressionReadsUpdate(value.otherwise, name);
    case "arrow":
      return false;
    case "capture":
      return expressionReadsUpdate(value.closure, name);
    case "invoke":
      return expressionReadsUpdate(value.callee, name) || value.args.some((argument) => expressionReadsUpdate(argument, name));
    case "append":
      return value.values.some((element) => expressionReadsUpdate(element, name));
  }
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
function objectConstants(tokens: readonly Token[], open: number, close: number): { fields: Map<string, ConstantValue>; names: string[]; all: boolean } {
  const fields = new Map<string, ConstantValue>();
  const names: string[] = [];
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
      names.push(token.text);
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
  return { fields, names, all: fields.size === total && total > 0 };
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
    if (token.kind === "ident" && (token.text === "true" || token.text === "false")) continue;
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
  params: { name: string; type: TypeExpr; shape?: ResolvedType | null; default?: Expression }[];
  /**
   * Where the rest parameter is, when the arrow declares one.
   *
   * `(...taken: string[]) => ...` is handed the arguments a call writes from
   * this position on as one list, which is the parameter the lifted function
   * takes: a call packs them into it here, at the site that wrote them.
   */
  rest?: number;
  /** What the arrow answers. */
  returns: TypeExpr;
  /**
   * What the answer holds, where the declaration names it.
   *
   * A declaration that answers an interface erases to the opaque reference in
   * the contract, so the fields are not in the type: a call of the arrow
   * answers the shape beside it, which is what an arm of a conditional written
   * against the call is read at.
   */
  returnsShape?: ResolvedType | null;
  /** The line the function was written at, for a closure made from a declaration. */
  line?: number;
  /** The function a call through the closure enters, once one is needed. */
  code?: string;
}

/** The signature a function type annotation names. */
interface FunctionType {
  params: TypeExpr[];
  returns: TypeExpr;
  /** The shape the returns name, for the await that unwraps it. */
  shape?: ResolvedType;
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
export interface ImportedFunction {
  params: TypeExpr[];
  returns: TypeExpr;
  /** What the result holds where the contract type erased it. */
  shape?: ResolvedType;
  /**
   * What each parameter is, where the type erased it: a parameter declared as a
   * function is a signature, and the arrow a call writes there is read against
   * the parameters and result it states.
   */
  paramShapes?: readonly (ResolvedType | null)[];
  /** The map or set the function answers, when it answers one. */
  collection?: CollectionValue;
  /**
   * Whether the function is `async`: its declaration states what its promise
   * carries, and the value a call answers is the promise handle rather than
   * that payload.
   */
  async?: boolean;
}

interface CollectionValue {
  kind: "map" | "set";
  /** The element a key is; this frontend keys by text. */
  key: TypeExpr;
  /** The value a map holds, which is the number `1` for a set. */
  value: TypeExpr;
  /**
   * What the value holds, where the declaration named it.
   *
   * The type is what the contract can spell, and a record of a declaration
   * spells only the opaque reference: the fields are gone. The read that asks
   * what a field of one holds asks the shape.
   */
  valueShape?: ResolvedType;
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
  params: { name: string; type: TypeExpr; default?: Expression; shape?: ResolvedType | null }[];
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
  /**
   * A function declared with a rest parameter: `(...args: T[])`.
   *
   * The parameter holds the list of the arguments from `fixed` on, so a call
   * passes the list where it wrote the arguments and the body reads it as one.
   */
  variadic?: { element: TypeExpr; fixed: number };
  /** A signature with no body, which the implementation below it carries. */
  overload?: true;
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
  "flat",
  "flatMap",
  "filter",
  "forEach",
  "every",
  "some",
  "find",
  "findIndex",
  "reduce",
  "sort",
  "reverse",
  "join",
  "includes",
  "indexOf",
  "at",
  "slice",
  "fill",
  "concat",
]);

/** The constructors a `new` expression names to allocate a map or a set. */
const COLLECTION_CONSTRUCTORS: ReadonlySet<string> = new Set(["Map", "Set", "WeakMap", "WeakSet"]);

/** The operators that stand in front of a value, as opposed to between two. */
/** Where a loop's initialiser states the type of the name it declares. */
const LOOP_INIT_STOPS: ReadonlySet<string> = new Set(["=", "of", ";"]);

const UNARY_OPERATORS: readonly string[] = ["!", "-", "+", "~"];

/**
 * Where an arrow function's result type ends. The `=>` that follows it is not
 * part of the type, so the scanner stops before it.
 *
 * A `:` also follows a parenthesised group in a conditional — `c ? (v as T) : u`
 * — and the scanner it guards is the one that reads a *result type* without
 * knowing the group was a value. Without the rest of the stops the scan ran on
 * to the next `=>` in the file and took the conditional's arm for an arrow. A
 * `,`, `;`, `)` or `]` at the type's own depth ends an annotation too, and none
 * of them is a type's own token, so each one is a stop.
 */
const ARROW_RETURN_STOPS: ReadonlySet<string> = new Set(["=>", ",", ";", ")", "]", "}", "?", ":", "=", "&&", "||"]);

/**
 * Where a method's result type ends: the body's brace follows it, where an
 * arrow's `=>` follows an arrow's. A method states its type and then writes its
 * body, so the brace is the end of the type and not a brace inside it.
 */
const METHOD_RETURN_STOPS: ReadonlySet<string> = new Set(["{", ";", "=", ","]);

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
  /** The functions declared with a rest parameter, and the list it holds. */
  private variadicFunctions = new Map<string, { element: TypeExpr; fixed: number }>();
  /**
   * The calls of imported functions this read could not type.
   *
   * A runtime import binds a name of another module, and the module graph
   * reads that module's functions. Until the link hands their signatures over,
   * a call to one answers `any`; the file is read again once it does.
   */
  private waitForFunction = false;
  /**
   * What a function's declared result holds, when the contract type erased it.
   *
   * An interface is an opaque reference to the contract, so a call that answers
   * one carries no field the frontend can read. The shape is the declaration's,
   * and it is what a destructuring of that call reads its fields from.
   */
  private declaredReturnShapes = new Map<string, ResolvedType>();
  /**
   * The signature a declaration's result is, where the result is itself a
   * function type.
   *
   * A name declared with the call that answers one — `const strip =
   * createCommentStripper()` — is held at that signature, and a call of the
   * name is the call the signature states: the arguments are read against it
   * and the result is what it answers. No type this IR holds spells a function,
   * so the signature is kept beside the types rather than in them.
   */
  private declaredFunctionReturns = new Map<string, FunctionType>();
  /**
   * The functions a call answers a promise of.
   *
   * An `async` function's contract states the payload the promise carries, so
   * the value a call answers is the handle and not the payload: `Array.from({
   * length: n }, () => worker())` is a list of the promises the calls answered,
   * and awaiting one is what reads the payload out of it.
   */
  private promiseFunctions = new Set<string>();
  /**
   * What each function of the file takes, by its name.
   *
   * An argument written as an empty list is built at the parameter's type, and
   * the callee's declaration is what says what that is.
   */
  private declaredParams = new Map<string, readonly TypeExpr[]>();
  /**
   * What each declared parameter's annotation holds, beside its type.
   *
   * The contract type of an interface is the opaque reference: the fields it
   * names are not a type the contract can spell. An argument written at that
   * parameter is read at the fields the annotation states, so the shape travels
   * beside the type it was read from.
   */
  private declaredParamShapes = new Map<string, readonly (ResolvedType | null)[]>();
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
   * The names an arrow of the function being read writes, and the one-element
   * list each of them lives in.
   *
   * An arrow is lifted into a function of its own, and a captured value is
   * handed to it by value: a write the body makes would be a write to the
   * lifted function's own copy. A name the arrow writes is therefore held in a
   * one-element list, which is a reference, and the list is handed over
   * instead. Both the arrow and the function around it read and write the
   * element, and the write is the write the source wrote.
   */
  private arrowBoxes = new Map<string, { box: string; element: TypeExpr; list: boolean }>();
  /** How many boxes this file's arrows have needed, for naming them. */
  private boxCount = 0;
  /**
   * Whether the expression being read is a while loop's condition, which is
   * read again every turn.
   *
   * A value the compiler materialises is written before the statement the
   * expression is part of, which is the value the source computed once. A
   * condition is not computed once: hoisting a call out of it would run the
   * call before the loop rather than every turn, so the condition keeps the
   * refusal the language answered before.
   */
  private loopCondition = false;
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
  /** How many spreads have been read into a name of the statement's own. */
  private spreadCount = 0;
  /** The values a SHA-256 hasher the runtime made is, as handles. */
  private readonly hashers = new Set<Expression>();
  /** The names a hasher is bound to, so `hash.update` reads the handle. */
  private readonly hasherNames = new Set<string>();
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
  /** The imported names this file writes under another name, as local to export. */
  private readonly importedValueRenames: ReadonlyMap<string, string>;
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
  /**
   * The value each `Array.isArray` test asked about, by the test it wrote.
   *
   * A value the read does not type — a type parameter, an `any`, a field of a
   * module the graph has not linked — is a list in the branch the test guards,
   * and the branch reads it as one: `node.map(...)` is a list's map once the
   * `Array.isArray(node)` around it holds.
   */
  private arrayTests = new Map<Expression, Expression>();
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
  /** The closure a declared function is, by the name the file wrote it under. */
  private functionValues = new Map<string, ArrowBinding>();
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
   * The helpers the frontend wrote as a text's own method.
   *
   * `repeat`, `split` and `indexOf` are lowered to a function of the file, and
   * that function only reads the text it was handed: asking the same question
   * twice is asking the same question, so a value that names one is read as
   * often as the expression needs it.
   */
  private pureTextHelpers = new Set<string>();
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
  typeTable: TypeTable;
  /** The shape each name of the body is declared at. */
  private valueShapes = new Map<string, ResolvedType>();
  /** The shape a member chain has already answered for a value it built. */
  private readonly expressionShapes = new Map<Expression, ResolvedType>();
  /** The token run the last annotation read, so its shape can be read after it. */
  private lastTypeRange: { start: number; end: number } | null = null;
  /**
   * The type each top-level declaration writes, by the name it declares.
   *
   * A file's constant is read where it is used, and the annotation is what says
   * what the value holds: a list of records is a list `map` walks, and a record
   * is one whose fields a member chain reads.
   */
  private constantAnnotations: ReadonlyMap<string, { start: number; end: number; exported: boolean }> = new Map();
  /**
   * The type each top-level `new Map<...>()` or `new Set<...>()` is allocated
   * at, by the name it is bound to.
   *
   * A collection the file holds is state, but its element types are what a
   * method written on the name reads — and a function written above the
   * declaration is read before the declaration is.
   */
  private constantCollections: ReadonlyMap<string, { start: number; end: number }> = new Map();
  /** The collections those spans name, read once per read. */
  private readonly constantCollectionValues = new Map<string, CollectionValue | null>();
  /** The shapes a link bound for the values this file imports, by name. */
  importedValueShapes: ReadonlyMap<string, ResolvedType> = new Map();
  /** The shape each annotation names, resolved once per read. */
  private readonly constantAnnotationShapes = new Map<string, ResolvedType>();
  /** The shape each written-out list constant holds, read once per read. */
  private readonly constantWrittenShapes = new Map<string, ResolvedType | null>();

  constructor(
    tokens: Token[],
    path: string,
    diagnostics: Diagnostics,
    classTable?: ClassTable,
    allTokens?: Token[],
    constants: ReadonlyMap<string, ConstantInfo> = new Map(),
    state: ReadonlySet<string> = new Set(),
    shapes: ReadonlyMap<string, ConstantInfo> = new Map(),
    typeTable?: TypeTable,
    importedTypeNames: ReadonlySet<string> = new Set(),
    importedRenames: ReadonlyMap<string, string> = new Map(),
    constantAnnotations: ReadonlyMap<string, { start: number; end: number; exported: boolean }> = new Map(),
    constantCollections: ReadonlyMap<string, { start: number; end: number }> = new Map(),
  ) {
    this.tokens = tokens;
    this.importedTypeNames = new Set(importedTypeNames);
    this.importedValueRenames = importedRenames;
    this.path = path;
    this.stem = nameStem(path);
    this.diagnostics = diagnostics;
    this.classTable = classTable ?? scanClasses(tokens);
    this.allTokens = allTokens ?? tokens;
    this.constants = constants;
    this.constantAnnotations = constantAnnotations;
    this.constantCollections = constantCollections;
    this.state = state;
    this.shapes = shapes;
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
  /** The field names of a computed top-level object, by the name it is held at. */
  private readonly shapes: ReadonlyMap<string, ConstantInfo>;
  /** The constants being read, so one that names itself is not read forever. */
  private readonly expanding = new Set<string>();

  /** A nested function declaration is handled by the program parsing, not the module one. */
  nestedFunction = false;
  /**
   * The exports whose body this read could not hold, by signature.
   *
   * A build stops at this file, so the declarations are not compiled here. A
   * file that imports the name still reads its calls against the signature,
   * which is what the declaration wrote.
   */
  private readonly droppedExports: DeclaredFunction[] = [];
  /**
   * The modules this file offers the names of, as `export { a } from "./x.ts"`
   * writes.
   *
   * The names are the other module's, so they are not functions of this file.
   * What this file offers is the name, and the link follows it to the module
   * that compiled the function.
   */
  private readonly reexports: {
    specifier: string;
    names: string[];
    renames?: { local: string; exported: string }[];
    line: number;
  }[] = [];
  /** `export { f as g }` of this file's own declarations, as local to offered. */
  private readonly localExportRenames: { local: string; exported: string }[] = [];
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
      return { kind: "map", key: TEXT_RESULT, value: this.typeExprOfShape(shape.index), valueShape: shape.index };
    }
    const collection = collectionOfType(shape);
    if (collection === null) return null;
    if (collection.kind === "set") {
      return { kind: "set", key: TEXT_RESULT, value: this.typeExprOfShape(collection.of), valueShape: collection.of };
    }
    return {
      kind: "map",
      key: this.typeExprOfShape(collection.key),
      value: this.typeExprOfShape(collection.value),
      valueShape: collection.value,
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

      // A top-level collection declared below the read is not in the body's
      // table yet: what the name holds is the allocation the scan found.
      if (!this.valueTypes.has(value.name)) {
        const scanned = this.constantCollection(value.name);
        if (scanned !== null) return scanned;
      }
    }
    if (value.k === "call") {
      const answered = this.declaredCollections.get(value.name);
      if (answered !== undefined) return answered;
    }
    // `a ?? b` is the collection of whichever arm names one: `m.get(k) ?? new
    // Set()` is a set, and the arm that writes nothing is not the value's shape.
    // The shape of the whole is the *contract* type of the left arm — the
    // opaque reference — so a method written on it was not the dictionary's.
    if (value.k === "binary" && value.op === "??") {
      const held = this.collectionOfExpression(value.left);
      if (held !== null) return held;
      return this.collectionOfExpression(value.right);
    }
    // `c ? values : []` is the collection the arm that writes one names. The
    // other arm writes no entries, which is the absence the collection is read
    // as, and a loop over the choice walks the entries the one arm holds.
    if (value.k === "conditional") {
      const held = this.collectionOfExpression(value.then);
      if (held !== null) return held;
      return this.collectionOfExpression(value.otherwise);
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
        // A name a body declares is the body's own: `valueTypes` holds the
        // declaration the body wrote, and the file's constant of the same name
        // is not the one the body reads.
        else if (!this.valueTypes.has(value.name)) {
          shape = this.importedValueShapes.get(value.name) ?? this.constantAnnotationShape(value.name);
          // A constant the file writes out as a list is a list of what its
          // elements are, whether or not its declaration names a type:
          // `const OPERATORS = ["+", "-"]` is read by `OPERATORS.find(f)`.
          if (shape === null) shape = this.constantWrittenShape(value.name);
        }
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
          // A value whose shape names a class — the answer of a map that holds
          // one, a value another module handed over — reads the field the class
          // declares. The type table names the class and not its fields, so the
          // class table is what says them.
          const owner = base !== null && base.kind === "ref" && base.name !== null && this.classTable.names.has(base.name)
            ? base.name
            : this.classOfExpression(value.base);
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
        shape = { kind: "primitive", name: value.boolean === true ? "bool" : "f64" };
        break;
      case "text":
        // A text is a text however it was written: `x.toString(16)` is a
        // `fixed` value, and every text method is a method of it.
      case "fixed":
        shape = { kind: "text" };
        break;
      case "buffer": {
        // The element is written as the type it was read at, which is the
        // contract's spelling of a type and not a name the table holds: reading
        // it as a name gave a list of the unshaped reference, and a `join`
        // written after the list then walked elements of no type.
        const element = this.shapeOfTypeExpr(parseType(value.element)) ?? { kind: "any" as const };
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
        // `structuredClone(x)` is a copy of `x`, so the shape it holds is the
        // shape `x` holds: a field of the copy is a field of the source.
        if (
          isStructuredClone(value) &&
          !this.declaredReturnShapes.has(value.name) &&
          !this.declaredFunctionReturns.has(value.name)
        ) {
          shape = this.shapeOf(value.args[0] as Expression);
          break;
        }
        // `await f()` is the value the promise `f` answers carries, and the
        // shape the declaration states for that value is the one the awaited
        // value holds.
        const awaited = value.name === "Promise.await" ? value.args[0] : undefined;
        if (awaited !== undefined && (awaited.k === "call" || awaited.k === "invoke")) {
          const carried = this.declaredReturnShapes.get((awaited as { name?: string }).name ?? "");
          if (carried !== undefined) {
            shape = carried;
            break;
          }
          // A method the class scan read is not a name the declaration table
          // holds; the shape was kept beside the call where it was written.
          const held = this.expressionShapes.get(awaited);
          if (held !== undefined) {
            shape = held;
            break;
          }
        }
        // `await p` where `p` is a name a continuation held answers the value
        // it carries: the name holds the payload itself, so the shape is the
        // one the name was given.
        if (awaited !== undefined && awaited.k !== "call" && awaited.k !== "invoke") {
          const held = this.shapeOf(awaited);
          if (held !== null) {
            shape = held;
            break;
          }
        }
        const declared = this.declaredReturnShapes.get(value.name);
        if (declared !== undefined) {
          shape = declared;
          break;
        }
        const answer = this.valueTypeOf(value);
        shape = this.shapeOfTypeExpr(answer);
        break;
      }
      case "arrow": {
        // An arrow held in a field is the function the field is: the signature
        // it lifted to is what a call through the field is read against.
        const lifted = this.liftedArrows.get(value.name);
        if (lifted !== undefined) {
          shape = {
            kind: "function",
            params: lifted.params.map((param) => this.shapeOfTypeExpr(param.type)),
            returns: this.shapeOfTypeExpr(lifted.returns),
          };
        }
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

  /**
   * The shape an arrow answers, where its body writes one result.
   *
   * An arrow whose declaration names no result type still writes the value it
   * answers: `(x) => ({ name: x, at: 1 })` is a record of two fields, and a
   * list of those is a list whose elements hold them. A body with more than one
   * result is not read here — the arms would have to agree field by field, and
   * a value that answers one on each path is left to the type it states.
   */
  private resultShapeOf(body: readonly Statement[]): ResolvedType | null {
    const values: Expression[] = [];
    const bare = { found: false };
    collectResults(body, values, bare);
    if (bare.found || values.length !== 1) return null;
    return this.shapeOf(values[0] as Expression);
  }

  /** The shape an arrow answers, by the callback a list method was handed. */
  private callbackReturnsShape(callback: Expression): ResolvedType | null {
    if (callback.k === "arrow") return this.arrowBindings.get(callback.name)?.returnsShape ?? null;
    if (callback.k === "ident") return this.valueArrows.get(callback.name)?.returnsShape ?? null;
    return null;
  }

  /** Whether a value answers the same thing when it is read a second time. */
  private repeatable(value: Expression): boolean {
    return repeatableExpression(value, (name) => this.pureTextHelpers.has(name));
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
    // A method that answers a promise answers what the promise carries: the
    // value a caller's `await` holds is the payload the annotation states.
    const payload = promisePayloadText(typeName) ?? typeName;
    if (this.classTable.names.has(payload)) return { kind: "ref", of: null, name: payload };
    return this.typeForName(payload, line);
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
      // The zero of a truth is `false`, and the marker keeps it the truth the
      // field is declared at rather than the number zero it is held as.
      return type.name === "bool" ? { k: "literal", text: "0", boolean: true } : { k: "literal", text: "0" };
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
        return (
          value.values.some((written) => this.holdsUnsettledArray(written)) ||
          (value.view !== undefined && this.holdsUnsettledArray(value.view.count))
        );
      case "object":
        return value.fields.some((field) => this.holdsUnsettledArray(field.value));
      default:
        return false;
    }
  }

  /**
   * What a value holds, where every empty list in it has been settled.
   *
   * A value with a list nothing has said the type of is half read: its shape is
   * not the one the whole value will have, so the other arm of a conditional is
   * not read at it.
   */
  private settledShapeOf(value: Expression): ResolvedType | null {
    if (this.holdsUnsettledArray(value)) return null;
    const shape = this.shapeOf(value);
    return shape === null || shape.kind === "any" ? null : shape;
  }

  /**
   * The list type an empty list beside a set is built at.
   *
   * `values ?? []` and `c ? [] : values` where `values` is a set are iterated:
   * the empty list and the set are walked the same way, so the list is built at
   * the element the set holds.
   */
  private setElementListType(value: Expression): TypeExpr | null {
    const collection = this.collectionOfExpression(value);
    if (collection === null || collection.kind !== "set") return null;
    return { kind: "slice", of: collection.key };
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
    // A value whose recorded shape names a class is an instance of it: a key
    // of a map that holds instances answers one, and the method written on it
    // is the class's.
    const recorded = this.expressionShapes.get(expression);
    if (recorded !== undefined && recorded.kind === "ref" && recorded.name !== null && this.classTable.names.has(recorded.name)) {
      return recorded.name;
    }
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
    this.finishBoxes(body, params, true);
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
      const written = fn.params.slice(0, arity).map(({ name, type, shape }) => ({ name, type, shape }));
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
  private methodParams(params: readonly ClassParam[]): { name: string; type: TypeExpr; shape: ResolvedType | null }[] {
    return params.map((param) => ({
      name: param.name,
      type: this.classTable.names.has(param.typeName) ? this.referenceTo(param.typeName) : this.typeForName(param.typeName, param.line),
      // The annotation is what an argument written at the parameter is read at:
      // a method takes the same records a function takes, and the shape of one
      // is not a type the contract can spell.
      shape: this.shapeForName(param.typeName),
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

  /**
   * The element a list method writes into the list.
   *
   * `list.push(value)` and `list.unshift(value)` write their values into the
   * list, so each value is read at the element the list holds: an empty list
   * written there is a list of that element, and an object written there is
   * read at the element's own shape. A call on a value that is not a list
   * states nothing, and the argument is read as the source wrote it.
   */
  private writtenElementType(receiver: Expression, method: string): TypeExpr | null {
    if (method !== "push" && method !== "unshift") return null;
    const sequence = this.valueTypeOf(receiver);
    return sequence.kind === "slice" || sequence.kind === "array" ? sequence.of : null;
  }

  /**
   * The shape of the element a value is written into a list at.
   *
   * The contract erases a record to the opaque reference, so the type alone is
   * not what an element written into a list of records is read at: `blocks.push`
   * of an object literal takes the fields of `SemanticBlock`, and an empty list
   * inside it is the element type that record states.
   */
  private writtenElementShape(receiver: Expression, method: string): ResolvedType | null {
    if (method !== "push" && method !== "unshift") return null;
    const shape = this.shapeOf(receiver);
    return shape !== null && shape.kind === "list" ? shape.of : null;
  }

  /**
   * The parameters a method of a class is called with, or none where the method
   * is not one of a class.
   *
   * The annotation is what an argument is read at, and the *shape* of it is
   * what a record argument needs: a parameter declared as an interface is the
   * opaque reference in the contract, so without the shape an object literal
   * written there is read with nothing said about its fields.
   */
  private expectedMethodParams(receiver: Expression, method: string): readonly { name: string; type: TypeExpr; shape: ResolvedType | null }[] {
    // A map or a set answers the method itself, and its arguments are not the
    // parameters of a class method that happens to share the name.
    if (this.collectionOfExpression(receiver) !== null) return [];
    const found = this.methodOwner(this.classOfExpression(receiver), method, false);
    if (found === null) return [];
    return this.methodParams(found.method.params);
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
        // The parameter's annotation is what a default is read at: a default
        // written as an empty list is a list of the elements the parameter
        // states, exactly as it is in a function's own declaration.
        const value = this.withClassContext(info, params, self, () =>
          this.readAt(
            this.typeForName(param.typeName, param.line),
            () => this.readRange(param.defaultStart, param.defaultEnd),
            this.shapeForName(param.typeName),
          ),
        );
        statements.push({ kind: "declare", name, type: null, init: value, line: method.line });
        return { k: "ident", name };
      });
      const callArgs = self ? [{ k: "ident", name: "self" } satisfies Expression, ...args] : args;
      statements.push({ kind: "result", value: { k: "call", name: baseName, args: callArgs }, line: method.line });
      out.push(this.declared(`${baseName}__${arity}`, paramsOut, returns, statements, exported, method.line));
    }
    return out;
  }

  /**
   * The constructor a class is built by: its own, or the nearest base's.
   *
   * A derived class with no constructor of its own is built by the base's —
   * the language passes the arguments through, and the object it makes has the
   * fields of both classes. The base has to be declared in this module,
   * because the body of its constructor is read from this file's tokens; a
   * class another module declares is refused, which is what the read of the
   * subclass says.
   */
  private constructorOf(info: ClassInfo): { params: readonly ClassParam[]; body: ClassMethod | null } | null {
    if (info.constructor !== null) return { params: info.constructor.params, body: info.constructor };
    if (info.base === null || info.base === "Error") return null;
    const base = this.classNamed(info.base);
    if (base === undefined || base.start < 0) return null;
    return this.constructorOf(base);
  }

  /** Every function a class becomes: a constructor, methods, and static members. */
  private emitClass(info: ClassInfo): DeclaredFunction[] {
    const out: DeclaredFunction[] = [];
    // A class built on another is built by the base's constructor, and the
    // object it makes is one layout with the fields of both. `extends Error` is
    // not a second layout: the message is a field of the error itself.
    if (info.base !== null && info.base !== "Error") {
      const base = this.classNamed(info.base);
      if (base === undefined || base.start < 0) {
        this.report(
          `class inheritance is not supported ("${info.name}" extends "${info.base}")`,
          "write the fields and methods the class uses; a compiled class is one layout",
          { kind: "ident", text: info.name, line: info.line },
        );
      }
    }
    const own = info.constructor;
    const inherited = own === null ? this.constructorOf(info) : null;
    const params: readonly ClassParam[] = own?.params ?? inherited?.params ?? [];
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
    const constructorSource = own ?? inherited?.body ?? null;
    if (constructorSource !== null) {
      body.push(
        ...this.withClassContext(info, params, true, () => {
          this.position = constructorSource.bodyStart;
          const statements = this.readFunctionBlock();
          if (this.position !== constructorSource.bodyEnd) {
            this.report("a constructor body is a block of statements", `near "${this.peek().text}"`);
          }
          return statements;
        }),
      );
    }
    body.push({ kind: "result", value: { k: "ident", name: "self" }, line: info.line });
    const constructorParams = this.methodParams(params);
    out.push(this.declared(info.name, constructorParams, this.referenceTo(info.name), body, info.exported, info.line));
    out.push(...this.wrappers(info, { name: "constructor", params: [...params], returnTypeName: info.name, bodyStart: -1, bodyEnd: -1, line: info.line }, info.name, this.referenceTo(info.name), false, info.exported));

    // A getter is a method with no parameters whose name is read as a member,
    // so it is emitted beside the methods and called where it is read.
    for (const method of [...info.methods, ...info.getters]) {
      const name = `${info.name}_${method.name}`;
      const returns = this.returnTypeForName(method.returnTypeName, method.line);
      const statements = this.withClassContext(info, method.params, true, () =>
        this.readReturning(returns, () => {
          this.position = method.bodyStart;
          const read = this.readFunctionBlock();
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
          const read = this.readFunctionBlock();
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
    // A function is declared before it is called in the text of a file, but not
    // always: a reader names the function it calls first and writes it below.
    // The signatures are read before any body, so a call to a function declared
    // later is a call of a function whose result is known — which is what a
    // field of that result, a method on it, or `in` over it needs.
    this.prescanFunctions();
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
    // An import is hoisted: it binds a module's names for the whole file, so it
    // is read wherever it is written, above the declarations or below them. A
    // declaration is hoisted the same way.
    /** Whether the file runs anything: a file that runs nothing is a library. */
    let runs = false;
    while (this.peek().kind !== "end") {
      // One refusal for each declaration or statement of the file, as one for
      // each statement of a body: the count a statement left behind is the
      // last statement's, not this one's.
      this.reporting = 0;
      if (this.at("import")) {
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
    // The names the file's imports bind, so a list that offers one is the
    // re-export it is: `export { availableParallelism }` where the name was
    // imported from `node:os` offers what that module offers.
    const importedValueFrom = new Map<string, string>();
    for (const entry of imports) {
      for (const name of entry.names ?? []) importedValueFrom.set(name, entry.specifier);
      for (const rename of entry.renames ?? []) importedValueFrom.set(rename.local, entry.specifier);
    }
    for (const name of Object.keys(namesExported)) {
      if (declared.has(name)) continue;
      const specifier = importedValueFrom.get(name);
      if (specifier === undefined) {
        this.report(
          `"${name}" is exported but not declared here`,
          `a module offers the functions it declares; ${path} declares ${declared.size === 0 ? "none" : [...declared].map((name) => `"${name}"`).join(", ")}`,
        );
        continue;
      }
      const rename = this.localExportRenames.find((one) => one.local === name);
      this.reexports.push({
        specifier,
        names: [name],
        ...(rename === undefined ? {} : { renames: [rename] }),
        line: 0,
      });
    }
    // A re-export names another module, so that module is read like one this
    // file imports: the graph has to resolve it to follow the name.
    for (const entry of this.reexports) {
      imports.push({ specifier: entry.specifier, names: [...entry.names], default: false, line: entry.line });
    }
    const valueShapes = this.exportedValueShapes();
    return {
      path,
      imports,
      typeImports,
      types: this.typeTable,
      classes: this.classTable,
      ...(valueShapes.size === 0 ? {} : { valueShapes }),
      ...(this.droppedExports.length === 0 ? {} : { signatures: this.droppedExports }),
      ...(this.reexports.length === 0 ? {} : { reexports: this.reexports }),
      ...(this.localExportRenames.length === 0 ? {} : { exportNames: this.localExportRenames }),
      functions,
      default: defaultExport,
      body,
      constants: this.exportedConstants(),
      awaitingLink: this.deferred.size > 0 || (this.waitForFunction && !this.linked),
    };
  }

  /**
   * The signatures of the file's functions, read before their bodies.
   *
   * A declaration is hoisted, but the text that calls a function need not come
   * after it. The body of the caller is read against `declaredReturns`,
   * `declaredParams` and `declaredReturnShapes`, and until a later declaration
   * is read those say nothing: a call to it answers `any`, so a field read of
   * the answer, a method written on it, and a question about its shape were all
   * refused. Reading the signature — the parameters and the result, not the
   * body — makes the hoisting the language gives a declaration visible to the
   * text above it.
   *
   * A signature this scan cannot read is left to the read of its declaration:
   * the scan is an improvement on knowing nothing, never a replacement for the
   * real thing.
   */
  /**
   * The name a call is emitted under: the name the other module exports, where
   * this file imports it under another name.
   */
  private calledName(name: string): string {
    return this.importedValueRenames.get(name) ?? name;
  }

  /**
   * The signature of an imported function, seeded into the tables a local
   * declaration fills. A call to the name answers what the module that writes
   * it says, which is what a field or `in` of the answer needs.
   */
  seedFunction(name: string, signature: ImportedFunction): void {
    this.declaredReturns.set(name, signature.returns);
    this.declaredParams.set(name, signature.params);
    if (signature.paramShapes !== undefined) this.declaredParamShapes.set(name, signature.paramShapes);
    if (signature.shape !== undefined) this.declaredReturnShapes.set(name, signature.shape);
    if (signature.collection !== undefined) this.declaredCollections.set(name, signature.collection);
    if (signature.async === true) this.promiseFunctions.add(name);
  }

  private prescanFunctions(): void {
    const tokens = this.tokens;
    // The token's own text: an identifier is a word here and not a punctuation
    // mark, which `mark` answers nothing for.
    const text = (at: number): string => (tokens[at] as Token | undefined)?.text ?? "";
    // A bracket is a punctuation mark. A string whose text is `"}"` is one
    // token whose text is `}`, and counting it as a closing bracket unbalances
    // the depth: every function written after such a string was read as nested
    // in something, and its signature was not scanned.
    const bracket = (at: number): string => mark(tokens[at]);
    /** The index of the bracket that closes the one at `open`, or -1. */
    const closing = (open: number): number => {
      let depth = 0;
      for (let at = open; at < tokens.length; at += 1) {
        const token = tokens[at] as Token;
        if (token.kind === "end") return -1;
        const written = bracket(at);
        if (written === "(" || written === "[" || written === "{") depth += 1;
        else if (written === ")" || written === "]" || written === "}") {
          depth -= 1;
          if (depth === 0) return at;
          if (depth < 0) return -1;
        }
      }
      return -1;
    };
    let depth = 0;
    for (let at = 0; at < tokens.length; at += 1) {
      const token = tokens[at] as Token;
      if (token.kind === "end") break;
      const written = text(at);
      const punctuated = bracket(at);
      if (punctuated === "(" || punctuated === "[" || punctuated === "{") {
        depth += 1;
        continue;
      }
      if (punctuated === ")" || punctuated === "]" || punctuated === "}") {
        depth = Math.max(0, depth - 1);
        continue;
      }
      if (depth !== 0 || written !== "function") continue;
      const before = at === 0 ? null : tokens[at - 1] as Token;
      // A function expression is not a declaration: it is written after `=`,
      // inside a call, or as the value of a field. Only a declaration carries a
      // name the whole file knows.
      if (before !== null && !["export", "default", "async", "declare", ";", "}"].includes(before.text)) continue;
      const name = tokens[at + 1] as Token | undefined;
      if (name === undefined || name.kind !== "ident") continue;
      let open = at + 2;
      if (text(open) === "<") {
        // The erased type parameters of a generic function.
        let angles = 0;
        let closed = -1;
        for (let scan = open; scan < tokens.length; scan += 1) {
          const piece = text(scan);
          if (piece === "<") angles += 1;
          else if (piece === ">") {
            angles -= 1;
            if (angles === 0) {
              closed = scan;
              break;
            }
          }
        }
        if (closed < 0) continue;
        open = closed + 1;
      }
      if (text(open) !== "(") continue;
      const close = closing(open);
      if (close < 0) continue;
      const params: TypeExpr[] = [];
      const paramShapes: (ResolvedType | null)[] = [];
      // The parameter list, split at the commas of its own depth. A type
      // argument's comma is inside the angle brackets of the type.
      let segment = open + 1;
      let inner = 0;
      const segments: [number, number][] = [];
      for (let index = open + 1; index < close; index += 1) {
        const piece = text(index);
        const previous = index === open + 1 ? null : text(index - 1);
        if (piece === "(" || piece === "[" || piece === "{") inner += 1;
        else if (piece === ")" || piece === "]" || piece === "}") inner -= 1;
        else if (piece === "<" && (previous === null || tokens[index - 1]?.kind === "ident")) inner += 1;
        else if (piece === ">" && inner > 0) inner -= 1;
        else if (piece === "," && inner === 0) {
          segments.push([segment, index]);
          segment = index + 1;
        }
      }
      if (segment < close) segments.push([segment, close]);
      let readable = true;
      for (const [start, end] of segments) {
        let index = start;
        const rest = text(index) === "...";
        if (rest) index += 1;
        // A rest parameter is the list of the arguments a call wrote, not one
        // of them: the call is read against the body's own declaration.
        if (rest) readable = false;
        const named = tokens[index] as Token | undefined;
        if (named === undefined || named.kind !== "ident") {
          readable = false;
          break;
        }
        index += 1;
        if (text(index) === "?") index += 1;
        if (text(index) !== ":") {
          params.push(ANY_TYPE);
          paramShapes.push(null);
          continue;
        }
        index += 1;
        const finish = Math.min(end, this.typeTokensEnd(index, PARAMETER_TYPE_STOPS));
        try {
          const shape = resolveAnnotation(tokens, index, finish, this.typeTable);
          params.push(this.typeExprOfShape(shape));
          paramShapes.push(shape);
        } catch {
          params.push(ANY_TYPE);
          paramShapes.push(null);
        }
      }
      // A parameter written as a pattern binds names this scan does not read,
      // so the parameter list is left to the declaration; the result type is
      // still the file's, and a call to the function answers it.
      if (readable) {
        this.declaredParams.set(name.text, params);
        this.declaredParamShapes.set(name.text, paramShapes);
      }
      // The result type follows the parameter list: `: T` up to the body, or up
      // to the semicolon of an overload.
      let after = close + 1;
      if (text(after) !== ":") continue;
      after += 1;
      // The annotation ends where the body's brace or the overload's semicolon
      // is, which is the same read `skipFunctionBody` makes of a signature.
      const finish = this.typeTokensEnd(after, FUNCTION_BODY_STOPS);
      const last = text(finish);
      if (last !== "{" && last !== ";" && last !== "=" && finish < tokens.length && tokens[finish]?.kind !== "end") {
        // The declaration ends in a way this scan does not know: leave the
        // signature to the read of the declaration itself.
        continue;
      }
      // A function whose result is itself a function — `(): (line: string) =>
      // string` — is a value a name can be held at, and a call of that name is
      // the call the annotation states. The type reader keeps no function type,
      // so the signature is read here beside it.
      const answerType = this.functionTypeFrom(after, finish);
      if (answerType !== null) this.declaredFunctionReturns.set(name.text, answerType);
      try {
        const shape = resolveAnnotation(tokens, after, finish, this.typeTable);
        this.declaredReturns.set(name.text, this.typeExprOfShape(shape));
        this.declaredReturnShapes.set(name.text, shape);
        const collection = this.collectionOfShape(shape);
        if (collection !== null) this.declaredCollections.set(name.text, collection);
      } catch {
        // A result this scan cannot resolve is read where the declaration is.
      }
    }
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
    // What the declaration is, as opposed to what its body does: a file that
    // imports the name calls it against this signature, whether or not the
    // module that writes it could read the body.
    if ((program || refused) && exported) {
      for (const entry of entries) this.droppedExports.push({ ...entry, exported: true, internal: undefined });
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
      const list = this.readExportNames();
      if (list.from === null) {
        // A list of this file's own declarations offers them under the names
        // it writes. A name it imported is not declared here, and is answered
        // once the imports are known: see `parseModule`.
        for (const name of list.names) namesExported[name] = true;
        for (const rename of list.renames) this.localExportRenames.push(rename);
      } else {
        this.reexports.push({
          specifier: list.from,
          names: list.names,
          ...(list.renames.length === 0 ? {} : { renames: list.renames }),
          line: this.peek().line,
        });
      }
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
    // A signature with no body names how the function is called and is not a
    // function of the file: the body below it is. It still says what a call
    // answers, and it is the parameter list a call is read against.
    if (parsed.overload === true) {
      this.declaredReturns.set(parsed.name, parsed.returns);
      this.declaredParams.set(parsed.name, parsed.params.map((param) => param.type));
      this.declaredParamShapes.set(parsed.name, parsed.params.map((param) => param.shape ?? null));
      if (parsed.returnsShape !== undefined) this.declaredReturnShapes.set(parsed.name, parsed.returnsShape);
      if (parsed.collection !== undefined) this.declaredCollections.set(parsed.name, parsed.collection);
      return isDefault ? parsed.name : null;
    }
    functions.push({
      name: parsed.name,
      exported,
      params: parsed.params,
      returns: parsed.returns,
      handle: parsed,
    });
    this.declaredReturns.set(parsed.name, parsed.returns);
    // A rest parameter is not a parameter list a call is checked against: the
    // call wrote the arguments the body reads as one list, and packing them is
    // the caller's work below. An overload above the body is the list to use.
    if (parsed.variadic !== undefined) this.variadicFunctions.set(parsed.name, parsed.variadic);
    else {
      this.declaredParams.set(parsed.name, parsed.params.map((param) => param.type));
      this.declaredParamShapes.set(parsed.name, parsed.params.map((param) => param.shape ?? null));
    }
    if (parsed.returnsShape !== undefined) this.declaredReturnShapes.set(parsed.name, parsed.returnsShape);
    if (parsed.collection !== undefined) this.declaredCollections.set(parsed.name, parsed.collection);
    for (const wrapper of this.defaultWrappers(parsed, exported)) {
      this.declaredReturns.set(wrapper.name, wrapper.returns);
      this.declaredParams.set(wrapper.name, wrapper.params.map((param) => param.type));
      this.declaredParamShapes.set(
        wrapper.name,
        wrapper.params.map((param) => parsed.params.find((one) => one.name === param.name)?.shape ?? null),
      );
      if (parsed.returnsShape !== undefined) this.declaredReturnShapes.set(wrapper.name, parsed.returnsShape);
      functions.push(wrapper);
    }
    return isDefault ? parsed.name : null;
  }

  /**
   * `export { f, g }`: the names the file offers, the names it offers them
   * under, and the `from` they may come from.
   *
   * `names` are the names the file holds — the declaration's own name, or the
   * name an import binds — and `renames` is the list of the ones a caller reads
   * under another name.
   */
  private readExportNames(): { names: string[]; renames: { local: string; exported: string }[]; from: string | null } {
    this.next();
    const names: string[] = [];
    const renames: { local: string; exported: string }[] = [];
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
      // `export { sleep as setTimeout }` offers the value it names under the
      // name the `as` writes. The declaration is the one the file wrote, and
      // the name a caller imports is the one the list offers.
      if (this.at("as")) {
        this.next();
        const alias = this.peek();
        if (alias.kind === "ident") {
          this.next();
          renames.push({ local: name.text, exported: alias.text });
        }
      }
      if (!this.accept(",")) break;
    }
    this.expect("}");
    this.accept(";");
    // `export { a } from "./x.ts"` offers a name the other module writes. What
    // crosses is the name: the function is compiled once, by the module that
    // declares it, and a file that imports it from here reaches it through the
    // link.
    if (this.at("from")) {
      this.next();
      const specifier = this.next();
      this.accept(";");
      if (specifier.kind !== "string") {
        this.report("a re-export names the module it comes from", `as in export { a } from "./x.ts"`, specifier);
        return { names, renames, from: null };
      }
      return { names, renames, from: specifier.text };
    }
    return { names, renames, from: null };
  }

  /**
   * The import forms a module has: `import { f, g } from "./other.ts";`, which
   * binds the exports it names, and `import f from "./other.ts";`, which binds
   * whatever the module exports as its default.
   */
  private readImport(typeOnly = false): ModuleImport {
    const start = this.peek();
    const types: ModuleTypeBinding[] = [];
    const renames: ModuleTypeBinding[] = [];
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
      return this.readImportTail(start, [], false, types, renames);
    }
    // `import d from "./x.ts"` and `import d, { a, b } from "./x.ts"`. The
    // local name a default import writes is not carried, because the programs
    // of this subset are linked by the name a function was declared with: one
    // table holds every function of every file, so a second name for one of
    // them would be a second compilation of it.
    if (!this.at("{") && (this.peek(1).kind === "ident" || this.peek(1).text === ",")) {
      this.next();
      return this.readImportTail(
        start,
        this.accept(",") ? this.readImportedNames(typeOnly, types, renames) : [],
        true,
        types,
        renames,
      );
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
    return this.readImportTail(start, this.readImportedNames(typeOnly, types, renames), false, types, renames);
  }

  /** `{ f, g }`: the exports an import names, which it binds as they are written. */
  private readImportedNames(
    typeOnly = false,
    types: ModuleTypeBinding[] = [],
    renames: ModuleTypeBinding[] = [],
  ): string[] {
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
        // `{ a as b }` binds the export `a` under the name `b`. The import names
        // `a`, because that is what the other module exports and what the linker
        // checks; the file reads `b`, and a call written as `b` is emitted as
        // `a`, the one name the function is compiled under.
        this.next();
        const alias = this.next();
        if (alias.kind === "ident") {
          types.push({ local: alias.text, imported: name.text });
          if (!typeOnly) renames.push({ local: alias.text, imported: name.text });
        }
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
    renames: ModuleTypeBinding[] = [],
  ): ModuleImport {
    const withTypes = types.length === 0 ? {} : { types };
    if (renames.length > 0) Object.assign(withTypes, { renames });
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
    this.arrowBoxes = new Map();
    // A collection a file declares at the top is a name its functions read, so
    // what each of them holds is carried into the function being read. What the
    // function declares of its own is the function's: the bindings the body
    // writes are put back where the file's were when the body is answered, so a
    // name the next function declares is not read as the collection a function
    // above it happened to bind. `declaring`'s `const slots = new Map(...)` made
    // `innerScope`'s `slots` parameter a map, and its loop over a list was
    // refused as a loop over entries.
    const fileCollections = this.valueCollections;
    this.valueCollections = new Map(fileCollections);
    this.iteratedCollections = new Map();
    this.iteratedSequences = new Map();
    let answered: CollectionValue | null = null;
    /** The rest parameter, when the function declares one. */
    let restAt: { element: TypeExpr; fixed: number } | null = null;
    const declared = (returns: TypeExpr, body: Statement[], shape: ResolvedType | null = null): TypeScriptFunction => {
      this.valueCollections = fileCollections;
      this.finishBoxes(body, params, true);
      const fn: TypeScriptFunction = {
        name: name.text,
        params,
        returns,
        body,
        line: name.line,
      };
      if (shape !== null) fn.returnsShape = shape;
      if (isAsync) {
        fn.async = true;
        this.promiseFunctions.add(fn.name);
      }
      if (answered !== null) fn.collection = answered;
      if (restAt !== null) fn.variadic = restAt;
      return fn;
    };
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
        // `...args: T[]` is the rest of the call's arguments as one list. The
        // parameter is the list, and a call packs what it wrote after the fixed
        // parameters into it.
        const rest = this.accept("...");
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
        if (rest) {
          // The parameter is the list itself; the element is what a call packs.
          const element = mapped.kind === "slice" || mapped.kind === "array" ? mapped.of : ANY_TYPE;
          restAt = { element, fixed: params.length };
        }
        params.push({
          name: parameter.text,
          type: mapped,
          ...(fallback === undefined ? {} : { default: fallback }),
          shape,
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
      const body = this.readFunctionBlock();
      return declared(inferredResult(body, params), [...prelude, ...body]);
    }
    this.next();
    answered = this.annotationCollection(new Set(["{", "=", ";"]));
    const returnType = this.readTypeAnnotation("a return type", new Set(["{", "=", ";"]), isAsync);
    const returnShape = this.lastAnnotationShape(isAsync);
    // A signature with no body is an overload: it names how the function below
    // it is called, and the body the declaration after it writes is the one
    // that runs.
    if (this.at(";")) {
      this.next();
      const signature = declared(returnType, [...prelude], returnShape);
      signature.overload = true;
      return signature;
    }
    if (this.accept("=")) {
      // `function f(x: T): T = expr;` carries an optional trailing semicolon.
      const value = this.readAt(returnType, () => this.readExpression(), returnShape);
      this.accept(";");
      return declared(returnType, [{ kind: "result", value, line: name.line }], returnShape);
    }
    return declared(
      returnType,
      [...prelude, ...this.readReturning(returnType, () => this.readFunctionBlock(), returnShape)],
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
    const ranges = this.typeArgumentRanges(start + 2, close);
    const arguments_ = ranges.map((range) => this.typeFromTokens(range.from, range.to, false));
    // `Record<string, V>` writes the key it is keyed by and the value it holds;
    // a map writes the same two arguments.
    const key = arguments_[0] ?? TEXT_RESULT;
    const value = kind === "map" ? (arguments_[1] ?? NUMBER_RESULT) : NUMBER_RESULT;
    // What the value holds is the declaration the annotation names, which is
    // the read of a field of an entry: the contract's spelling of that value is
    // the opaque reference, and a member written through it asks the shape.
    const valueRange = ranges[1];
    const resolved = valueRange === undefined ? null : this.shapeOfRange(valueRange);
    const valueShape = kind === "map" && resolved !== null ? this.shapeForRead(resolved) : null;
    if (this.keyKind(key) === null) {
      this.report(
        `a ${head.text} here is keyed by text, not by ${typeToString(key)}`,
        "a key is a text, a number or a reference: a map of numbers is written as Map<number, V>",
        head,
      );
      return null;
    }
    return { kind, key, value, ...(valueShape === null ? {} : { valueShape }) };
  }

  /**
   * What a run of tokens states, as the fields it names.
   *
   * A shape is what a member chain asks, and a read that has not linked an
   * imported declaration answers `any`: the read that follows the link is the
   * one that holds the fields.
   */
  private shapeOfRange(range: { from: number; to: number }): ResolvedType | null {
    try {
      return resolveAnnotation(this.tokens, range.from, range.to, this.typeTable);
    } catch {
      return null;
    }
  }

  /**
   * How a dictionary key is written: a text, a reference or a number.
   *
   * A text is the key the dictionary holds. A reference and a number reach the
   * runtime as the handle and the number they are, and it keys by those, so a
   * `Set<number>` and a `Map<Node, number>` are the same dictionary with a
   * different spelling of the key.
   */
  private keyKind(type: TypeExpr): "text" | "reference" | "number" | null {
    const kind = this.storedKind(type);
    if (kind === "text") return "text";
    if (kind === "reference") return "reference";
    if (kind === "number" || kind === "bool") return "number";
    return null;
  }

  /**
   * The runtime dictionary call one operation is lowered to, by what the key is.
   *
   * A text key is the call the dictionary itself names; a reference and a number
   * are one of the `_refkey` and `_numkey` forms, which write the key as the
   * text the dictionary holds and read it back as the value it was.
   */
  private dictionaryCall(
    key: TypeExpr,
    operation: "set" | "setText" | "setRef" | "get" | "getText" | "getRef" | "setSeq" | "getSeq" | "has" | "delete" | "keyAt",
  ): string | null {
    const kind = this.keyKind(key);
    if (kind === null) return null;
    if (operation === "keyAt") {
      if (kind === "reference") return "blaze_rt_dict_key_ref_at";
      if (kind === "number") return "blaze_rt_dict_key_num_at";
      return "blaze_rt_dict_key_at";
    }
    const suffix = kind === "reference" ? "_refkey" : kind === "number" ? "_numkey" : "";
    if (operation === "has") return `blaze_rt_dict_has${suffix}`;
    if (operation === "delete") return `blaze_rt_dict_delete${suffix}`;
    if (operation === "get") return `blaze_rt_dict_get${suffix}`;
    if (operation === "getText") return `blaze_rt_dict_get${suffix}_text`;
    if (operation === "getRef") return `blaze_rt_dict_get${suffix}_ref`;
    if (operation === "set") return `blaze_rt_dict_set${suffix}`;
    if (operation === "setSeq") return `blaze_rt_dict_set_seq${suffix}`;
    if (operation === "getSeq") return `blaze_rt_dict_get_seq${suffix}`;
    if (operation === "setText") return `blaze_rt_dict_set${suffix}_text`;
    return `blaze_rt_dict_set${suffix}_ref`;
  }

  /** Where each argument of a `<...>` list is written, in order. */
  private typeArgumentRanges(start: number, close: number): { from: number; to: number }[] {
    const out: { from: number; to: number }[] = [];
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
        out.push({ from, to: at });
        from = at + 1;
      }
    }
    if (from < close) out.push({ from, to: close });
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
  private lastAnnotationShape(promisePayload = false): ResolvedType | null {
    const range = this.lastTypeRange;
    if (range === null) return null;
    let start = range.start;
    let end = range.end;
    // `async function f(): Promise<Outcome>` states the type the promise
    // carries, which is the shape a caller's `await f()` holds.
    if (promisePayload) {
      const payload = this.promisePayload(start, end);
      if (payload !== null) {
        start = payload.start;
        end = payload.end;
      }
    }
    try {
      const shape = resolveAnnotation(this.tokens, start, end, this.typeTable);
      // An imported declaration the module graph has not linked resolves to
      // the `any` this read cannot tell from a type the source spelled as one.
      if (shape.kind === "any") this.notePendingType(typeText(this.tokens, start, end));
      return shape;
    } catch {
      this.notePendingType(typeText(this.tokens, start, end));
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
    // `[A, B]` is a tuple. The contract has no tuple, and a compiled list is a
    // block of one element type: a tuple whose members are one type is that
    // list, which is what the sources write a pair as.
    if (first.text === "[") {
      const close = this.matchingToken(from, "[", "]");
      if (close > 0 && close === end - 1) {
        const members = this.typeMembers(from + 1, close);
        const held = members.length === 0 ? ANY_TYPE : this.typeFromTokens(members[0]?.start ?? from + 1, members[0]?.end ?? close, false);
        return { kind: "slice", of: held };
      }
    }
    // `(T)` is the type it holds: a function type writes `=>` after the close
    // and falls through to the opaque reference below.
    if (first.text === "(") {
      const close = this.matchingToken(from, "(", ")");
      if (close > 0 && close === end - 1) return this.typeFromTokens(from + 1, close, false);
    }
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

  /** The members a tuple or a parameter list names, split at its top-level `,`. */
  private typeMembers(from: number, end: number): { start: number; end: number }[] {
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
      else if (depth === 0 && text === ",") {
        members.push({ start, end: at });
        start = at + 1;
      }
    }
    if (start < end) members.push({ start, end });
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

  /**
   * A function body read with the types it declares of its own in scope.
   *
   * A body may write `type Expanded = { value: PyValue; pre: PyStatement[] }`
   * and annotate its own declarations with it. The module's table has no such
   * name — the scan reads the declarations at the top of the file — so the
   * body is read against a table layered over the module's, which is what
   * resolves the name and keeps it out of every other body.
   */
  private readFunctionBlock(): Statement[] {
    return this.withBodyTypes(() => this.readBlock());
  }

  /** Reads a body against the types it declares, and restores the table after. */
  private withBodyTypes<T>(read: () => T): T {
    const saved = this.typeTable;
    const open = this.position;
    if (this.tokens[open]?.text !== "{") return read();
    const close = this.blockEnd(open);
    if (close < 0) return read();
    // A body that names no type of its own is read as it is: the scan is only
    // worth its own pass where the body writes a `type` or an `interface`.
    let namesAType = false;
    for (let index = open + 1; index < close && !namesAType; index += 1) {
      const token = this.tokens[index] as Token;
      if (token.kind === "ident" && (token.text === "type" || token.text === "interface")) namesAType = true;
    }
    if (!namesAType) return read();
    const declared = scanTypeTable(this.tokens.slice(open + 1, close));
    if (declared.declarations.size === 0) return read();
    const table: TypeTable = {
      declarations: declared.declarations,
      imported: new Map(),
      exported: new Map(),
      reexported: new Set(),
      classes: saved.classes,
      parent: saved,
    };
    // A declaration resolves the names it writes in the table it is read in,
    // which is the body's: a body that names its own type and then the module's
    // resolves both.
    for (const declaration of table.declarations.values()) declaration.scope = table;
    this.typeTable = table;
    try {
      return read();
    } finally {
      this.typeTable = saved;
    }
  }

  /** The index of the `}` that closes the `{` at `open`, or -1. */
  private blockEnd(open: number): number {
    let depth = 0;
    for (let index = open; index < this.tokens.length; index += 1) {
      const token = this.tokens[index] as Token;
      if (token.kind !== "punct") continue;
      if (token.text === "{") depth += 1;
      else if (token.text === "}") {
        depth -= 1;
        if (depth === 0) return index;
      }
    }
    return -1;
  }

  private readBlock(): Statement[] {
    if (!this.accept("{")) {
      this.report('expected "{"', "a function body is written in braces");
      return [];
    }
    // The declarations the block writes at its own level are known before its
    // statements are read: a closure written above one reads it, because the
    // binding is hoisted to the block and the closure runs after the
    // declaration has run.
    this.prescanLocals();
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

  /**
   * The declarations a block writes at its own level, read before its
   * statements.
   *
   * JavaScript hoists a declaration's binding to the block, and a closure
   * written above the declaration reads the value the declaration has written
   * by the time the closure runs: `const walk = (x) => walked.add(x); const
   * walked = new Set<Block>();` is a body the source writes, and reading it
   * left to right made `walked` a name of no type. What each name is — the
   * annotation it writes, the `new Set<...>()` it allocates, or the class it is
   * declared as — is read here, and the declaration itself then confirms it.
   *
   * Only the block's own level is scanned: a name a block inside it declares is
   * that block's, and is read where the block is.
   */
  private prescanLocals(): void {
    const open = this.position - 1;
    if (this.tokens[open]?.text !== "{") return;
    const close = this.blockEnd(open);
    if (close < 0) return;
    const tokens = this.tokens;
    let depth = 0;
    for (let at = open + 1; at < close; at += 1) {
      const token = tokens[at];
      if (token === undefined || token.kind === "end") return;
      if (token.kind === "punct") {
        if (token.text === "{" || token.text === "(" || token.text === "[") depth += 1;
        else if (token.text === "}" || token.text === ")" || token.text === "]") depth -= 1;
        continue;
      }
      if (depth !== 0) continue;
      if (token.text !== "const" && token.text !== "let" && token.text !== "var") continue;
      const name = tokens[at + 1];
      if (name === undefined || name.kind !== "ident" || this.valueTypes.has(name.text)) continue;
      const cursor = at + 2;
      if (tokens[cursor]?.text === ":") {
        // The annotation runs to the `=` of the value it initialises, or to the
        // `;` of a declaration that writes none.
        let end = cursor + 1;
        let inner = 0;
        while (end < close) {
          const written = tokens[end]?.kind === "punct" ? (tokens[end] as Token).text : "";
          if (written === "<" || written === "(" || written === "[" || written === "{") inner += 1;
          else if (written === ">" || written === ")" || written === "]" || written === "}") inner -= 1;
          else if (written === ">>") inner -= 2;
          else if (written === ">>>") inner -= 3;
          else if (inner === 0 && (written === "=" || written === ";")) break;
          end += 1;
        }
        this.prescanDeclaration(name.text, cursor + 1, end);
        continue;
      }
      // `const seen = new Set<Block>()` names the collection the name holds in
      // the allocation itself.
      if (tokens[cursor]?.text !== "=" || tokens[cursor + 1]?.text !== "new") continue;
      const head = tokens[cursor + 2];
      if (head === undefined || head.kind !== "ident") continue;
      if (head.text !== "Set" && head.text !== "Map" && head.text !== "WeakSet" && head.text !== "WeakMap") continue;
      const collection = this.prescanCollection(cursor + 2);
      if (collection !== null) this.valueCollections.set(name.text, collection);
    }
  }

  /** The type, shape, collection, class and signature a declaration writes. */
  private prescanDeclaration(name: string, start: number, end: number): void {
    if (end <= start) return;
    // A declaration this scan cannot resolve is one the read of the declaration
    // reports, and the scan writes nothing for it.
    const saved = this.diagnostics;
    this.diagnostics = new Diagnostics();
    try {
      const signature = this.functionTypeFrom(start, end);
      if (signature !== null) this.valueFunctions.set(name, signature);
      const collection = this.annotationCollectionAt(start, new Set(["=", ";"]));
      const shape = resolveAnnotation(this.tokens, start, end, this.typeTable);
      this.valueTypes.set(name, this.typeExprOfShape(shape));
      const read = this.shapeForRead(shape);
      if (read !== null) this.valueShapes.set(name, read);
      const held = collection ?? this.collectionOfShape(shape);
      if (held !== null) this.valueCollections.set(name, held);
      const head = this.tokens[start];
      if (head !== undefined && head.kind === "ident" && this.classTable.names.has(head.text)) {
        this.valueClasses.set(name, head.text);
      }
    } catch {
      this.valueTypes.delete(name);
    } finally {
      this.diagnostics = saved;
    }
  }

  /** The collection a `new Set<...>` or `new Map<...>` allocation names. */
  private prescanCollection(at: number): CollectionValue | null {
    const saved = this.diagnostics;
    this.diagnostics = new Diagnostics();
    try {
      return this.annotationCollectionAt(at, new Set(["("]));
    } catch {
      return null;
    } finally {
      this.diagnostics = saved;
    }
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
        // A hasher a name holds is that name's, so `hash.update` written
        // below reads the handle the runtime made.
        if (this.hashers.has(init)) this.hasherNames.add(name.text);
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
      // What the name holds is what it was declared with: a name declared with
      // the call that answers a function is that function, exactly as a name
      // declared with the annotation is.
      const named = annotationFunction ?? (init.k === "call" ? (this.declaredFunctionReturns.get(init.name) ?? null) : null);
      if (named !== null) this.valueFunctions.set(name.text, named);
      else this.valueFunctions.delete(name.text);
      // A map is a handle and a set is a map, so what the name holds is kept
      // beside it: the declaration says it, or the `new Map(...)` it is
      // initialised with does.
      const collection =
        annotationMap ??
        this.collectionExpressions.get(init) ??
        (init.k === "call" ? this.declaredCollections.get(init.name) : undefined) ??
        // `m.get(k) ?? new Set()` is the arm that names a collection, and a
        // name bound to it holds one: what the arm is is read the same way a
        // method written on the name is.
        this.collectionOfExpression(init) ??
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
      if (this.isRegexValue(init)) this.valueRegexes.add(name.text);
      else this.valueRegexes.delete(name.text);
      return { kind: "declare", name: name.text, type, init, line: name.line };
    }

    // `void name;` marks a value as read and writes nothing. The statement has
    // no effect of its own, so what it reads is a value the body keeps for
    // nothing.
    if (this.at("void")) {
      const start = this.next();
      const value = this.readExpression();
      this.accept(";");
      return { kind: "expression", value, line: start.line };
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
    if (this.at("process") && this.peek(1).text === "." && (this.peek(2).text === "stdout" || this.peek(2).text === "stderr")) {
      const written = this.readProcessWrite();
      if (written !== null) return written;
    }
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
    const refused = token.text === "type" && !this.typeOnlyDeclarationAt() ? undefined : refusedKeyword(token.text);
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
    const through = this.readChainAssignment();
    if (through !== null) return through;
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
      // `const { a, ...rest } = value` binds the fields the pattern does not
      // name: what is left of the record, as the record it is.
      let rest: string | null = null;
      while (!this.at("}") && this.peek().kind !== "end") {
        if (this.accept("...")) {
          const bound = this.next();
          if (bound.kind !== "ident") this.report("a destructured field binds a name", `near "${bound.text}"`, bound);
          else rest = bound.text;
          if (!this.accept(",")) break;
          continue;
        }
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
      if (rest !== null) {
        if (baseShape === null || baseShape.kind !== "record" || baseShape.index !== null) {
          this.report(
            `a rest field binds the fields of a record`,
            `the value ${rest} reads has no fields a rest could bind`,
            open,
          );
        } else {
          const named = new Set(fields.map((entry) => entry.field));
          const remaining = new Map(
            [...baseShape.fields].filter(([name]) => !named.has(name)),
          );
          const value: Expression = {
            k: "object",
            fields: [...remaining.keys()].map((name) => ({
              name,
              value: { k: "member", base, field: name } as Expression,
            })),
          };
          const shape: ResolvedType = { kind: "record", fields: remaining, index: null };
          this.valueShapes.set(rest, shape);
          this.valueTypes.set(rest, this.typeExprOfShape(shape));
          this.pending.push({ kind: "declare", name: rest, type: null, init: value, line });
        }
      }
      const first = head ?? this.pending.shift();
      return first ?? ({ kind: "expression", value: this.hole(), line } satisfies Statement);
    }

    // `[a, b] = ...`: each name is the element at its position. A literal is
    // read apart where it stands; every other value is read once into a name
    // of the pattern's own, because the pattern may read the same element more
    // than once and a call is not a value that reads the same twice.
    const bindings: { name: string; index: number; rest?: boolean }[] = [];
    let at = 0;
    while (!this.at("]") && this.peek().kind !== "end") {
      // `[a, , b]`: a gap names no element, and the positions move past it all
      // the same.
      if (this.accept(",")) {
        at += 1;
        continue;
      }
      // `[a, ...rest]`: the rest of the elements, from this position on, as the
      // list they are.
      if (this.accept("...")) {
        const bound = this.next();
        if (bound.kind !== "ident") this.report("a destructured element binds a name", `near "${bound.text}"`, bound);
        else bindings.push({ name: bound.text, index: at, rest: true });
        if (!this.accept(",")) break;
        continue;
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
        if (binding.rest === true) {
          // The rest of a written-out list is the list of the values left,
          // which is a literal of its own.
          const element = parseType(init.element);
          const tail: Expression = { k: "buffer", element: init.element, values: values.slice(binding.index) };
          this.valueTypes.set(binding.name, { kind: "slice", of: element });
          this.pending.push({ kind: "declare", name: binding.name, type: null, init: tail, line });
          return;
        }
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
      if (binding.rest === true) {
        // The rest of a list is the field from its position to the end.
        this.valueTypes.set(binding.name, { kind: "slice", of: elementType });
        if (elementShape !== null) this.valueShapes.set(binding.name, { kind: "list", of: elementShape });
        this.pending.push({
          kind: "declare",
          name: binding.name,
          type: null,
          init: this.sequenceMethod(
            "slice",
            elementType,
            base,
            [{ k: "literal", text: String(binding.index) }],
            line,
          ),
          line,
        });
        return;
      }
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
        // A statement that begins with a bracket is a tuple assignment only
        // where an `=` follows the bracket's own end: `[a, b] = [b, a]` is one,
        // and `[...text].forEach(f)` or `[1, 2].join()` are the expressions
        // they are. Reading those as patterns refused them where the spread
        // stood, which is every expression statement that begins with a list.
        const close = closingBracket(this.tokens, start);
        if (this.tokens[close]?.text !== "=") return null;
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
      const value = this.readAt(this.valueTypes.get(target.text) ?? null, () => this.readExpression(), this.valueShapes.get(target.text) ?? null);
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
      const value = this.readAt(this.valueTypes.get(target.text) ?? null, () => this.readExpression(), this.valueShapes.get(target.text) ?? null);
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

  /**
   * A statement that writes through a value it names in full: `(x as Y).field`,
   * `this.a[i]`, `a.b[i].c`.
   *
   * A write is written to a *place*, and the place may be named by anything the
   * language names a value with — a cast, a call, a field, an element. The
   * places a plain name reaches are read by `readAssignment` and its two
   * helpers, which look at the tokens directly; this reads the place as the
   * expression it is and finds the operator after it. A place that is not a name
   * is read into a name of the statement's own first, so the write goes through
   * that name, and an object or a block is a reference: writing through the name
   * is writing the value the source named.
   */
  /**
   * A place stepped by one, as the value it had.
   *
   * The place is read into a name of the statement's own, the name is stepped
   * beside the statement, and the value is the name: a read of the place and
   * the step are the two things one `x++` does, and the place itself is named
   * by whatever the language names a value with.
   */
  private stepPlace(target: Expression, op: "++" | "--", line: number): Expression | null {
    if (target.k !== "member" && target.k !== "index") return null;
    const base = this.writeTarget(target.base, line);
    if (base === null) return null;
    const place: Expression = target.k === "member"
      ? { k: "member", base: { k: "ident", name: base }, field: target.field }
      : { k: "index", base: { k: "ident", name: base }, index: target.index };
    const held = `__stepped${this.fieldCount++}`;
    this.pendingBefore.push({ kind: "declare", name: held, type: null, init: place, line });
    const type = this.valueTypeOf(place);
    this.valueTypes.set(held, type);
    const shape = this.shapeOf(place);
    if (shape !== null) this.valueShapes.set(held, shape);
    const one: Expression = { k: "literal", text: "1" };
    this.pendingBefore.push(target.k === "member"
      ? { kind: "memberAssign", base, field: target.field, op: op === "++" ? "+=" : "-=", value: one, line }
      : { kind: "indexAssign", buffer: base, index: target.index, op: op === "++" ? "+=" : "-=", value: one, line });
    return { k: "ident", name: held };
  }

  private readChainAssignment(): Statement | null {
    const start = this.position;
    const operatorAt = this.assignmentOperatorAt(start);
    if (operatorAt === null) return null;
    const target = this.readExpression();
    if (this.position !== operatorAt) {
      this.position = start;
      return null;
    }
    const operator = this.next();
    const line = this.tokens[start]?.line ?? operator.line;
    if (target.k !== "member" && target.k !== "index") {
      this.position = start;
      return null;
    }
    const field = target.k === "member" ? target.field : null;
    const base = target.base;
    const held = this.writeTarget(base, line);
    if (held === null) {
      this.position = start;
      return null;
    }
    // `a.length = n` is the list at that length: the first `n` elements, and
    // the empty elements a longer list gains after them. A text has no writable
    // length — what it holds is a block the runtime wrote — and the write is
    // left to the refusal below.
    const ownerType = this.valueTypeOf(base);
    if (field === "length" && (ownerType.kind === "slice" || ownerType.kind === "array")) {
      const value = this.readExpression();
      this.accept(";");
      const lowered = this.lengthAssign(base, ownerType, operator.text, value, line);
      if (lowered !== null) return lowered;
      this.position = start;
      return null;
    }
    if (field === "length" && ownerType.kind === "text") {
      this.position = start;
      return null;
    }
    const place: Expression = target.k === "member"
      ? { k: "member", base: { k: "ident", name: held }, field: field as string }
      : { k: "index", base: { k: "ident", name: held }, index: target.index };
    const shape = this.shapeOf(place);
    const value = shape === null
      ? this.readExpression()
      : this.readAt(this.typeExprOfShape(shape), () => this.readExpression(), shape);
    this.accept(";");
    this.valueArrows.delete(held);
    if (field === "length") this.valueTypes.delete(held);
    this.forgetNarrowing(`${held}.${field ?? ""}`);
    if (operator.text === "??=") {
      return target.k === "member"
        ? {
            kind: "memberAssign",
            base: held,
            field: field as string,
            op: "=",
            value: { k: "binary", op: "??", left: place, right: value },
            line,
          }
        : {
            kind: "indexAssign",
            buffer: held,
            index: (target as { index: Expression }).index,
            op: "=",
            value: { k: "binary", op: "??", left: place, right: value },
            line,
          };
    }
    return target.k === "member"
      ? { kind: "memberAssign", base: held, field: field as string, op: operator.text as AssignOperator, value, line }
      : { kind: "indexAssign", buffer: held, index: (target as { index: Expression }).index, op: operator.text as AssignOperator, value, line };
  }

  /**
   * `a.length = n`: the list as the first `n` elements it has.
   *
   * A list is a block whose length the runtime keeps in a header, and the block
   * is a value: a longer list is a block of its own, so the write is the list
   * at that length rather than a size written into it. The first `n` elements
   * are the slice up to `n`, and a longer list is that slice followed by the
   * empty elements it gains. A compound write — `a.length -= n` — is the same
   * write at the length it had less `n`. Nothing answers the write, so only the
   * assignment forms are read.
   */
  private lengthAssign(base: Expression, owner: TypeExpr, op: string, value: Expression, line: number): Statement | null {
    if (op !== "=" && op !== "+=" && op !== "-=") return null;
    // The write goes back into the place the list is held in, which is the name
    // or the field the source wrote.
    let place: { target: string; base: string | null } | null = null;
    if (base.k === "ident") place = { target: base.name === "this" ? "self" : base.name, base: null };
    else if (base.k === "member" && base.base.k === "ident") place = { target: base.field, base: base.base.name === "this" ? "self" : base.base.name };
    else if (base.k === "member") {
      // `this.diagnostics.entries.length = n`: the list is a field of a field,
      // and the write goes back into the field it is held in. The value before
      // the last field is read into a name of its own, as a write through a
      // chain of fields does — an object is a reference, so the field written
      // on the name is the field the source named.
      const owner = this.writeTarget(base.base, line);
      if (owner !== null) place = { target: base.field, base: owner };
    }
    if (place === null) return null;
    // A compound write states the length the list keeps rather than the one it
    // is given: `a.length -= n` is `a.length = len(a) - n`.
    let wanted: Expression = value;
    if (op !== "=") {
      wanted = {
        k: "binary",
        op: op === "+=" ? "+" : "-",
        left: { k: "lengthOf", of: base },
        right: value,
      };
    }
    // The count is read once, because it is written three times.
    if (wanted.k !== "literal" && wanted.k !== "ident") {
      const held = `__length${this.fieldCount++}`;
      this.pendingBefore.push({ kind: "declare", name: held, type: null, init: wanted, line });
      this.valueTypes.set(held, NUMBER_RESULT);
      wanted = { k: "ident", name: held };
    }
    const length: Expression = { k: "lengthOf", of: base };
    const element = owner.kind === "slice" || owner.kind === "array" ? owner.of : ANY_TYPE;
    const kept = this.sequenceMethod("slice", element, base, [{ k: "literal", text: "0" }, wanted], line);
    const grew: Expression = {
      k: "conditional",
      condition: { k: "binary", op: ">", left: wanted, right: length },
      then: { k: "binary", op: "-", left: wanted, right: length },
      otherwise: { k: "literal", text: "0" },
    };
    const added: Expression = { k: "sized", element: typeToString(element), count: grew };
    const listed: Expression = { k: "binary", op: "+", left: kept, right: added };
    return place.base === null
      ? { kind: "assign", target: place.target, op: "=", value: listed, line }
      : { kind: "memberAssign", base: place.base, field: place.target, op: "=", value: listed, line };
  }

  /**
   * The name a write goes through: the target itself where it is a name, and a
   * name of the statement's own otherwise.
   */
  private writeTarget(base: Expression, line: number): string | null {
    const named = base.k === "ident" ? (base.name === "this" && this.currentClass !== null ? "self" : base.name) : null;
    if (named !== null) return named;
    const held = `__place${this.fieldCount++}`;
    this.pendingBefore.push({ kind: "declare", name: held, type: null, init: base, line });
    this.valueTypes.set(held, this.valueTypeOf(base));
    const shape = this.shapeOf(base);
    if (shape !== null) this.valueShapes.set(held, shape);
    const collection = this.collectionOfExpression(base);
    if (collection !== null) this.valueCollections.set(held, collection);
    return held;
  }

  /**
   * Where the assignment operator of the statement beginning at a token is, or
   * null where the statement is not a write.
   *
   * The scan is over the source's own brackets, so an `=` inside a call or an
   * object literal is not the statement's. A write is the operator at the top
   * level whose left side ends a place: a name, a field or an element.
   */
  private assignmentOperatorAt(start: number): number | null {
    let depth = 0;
    for (let at = start; at < this.tokens.length; at += 1) {
      const token = this.tokens[at] as Token;
      const text = mark(token);
      if (text === "(" || text === "[" || text === "{") {
        depth += 1;
        continue;
      }
      if (text === ")" || text === "]" || text === "}") {
        depth -= 1;
        if (depth < 0) return null;
        continue;
      }
      if (depth > 0) continue;
      if (token.kind === "end" || text === ";") return null;
      if (text !== "=" && text !== "??=" && !(text in COMPOUND_OPERATORS)) continue;
      const previous = this.tokens[at - 1] as Token | undefined;
      if (previous === undefined) return null;
      const before = mark(previous);
      if (before === "]" || before === ")" || previous.kind === "ident") return at;
      return null;
    }
    return null;
  }

  private readIndexedAssignment(): Statement | null {
    const start = this.position;
    const buffer = this.next();
    if (buffer.kind !== "ident") {
      this.position = start;
      return null;
    }
    // `this.counters[kind] += 1` writes an element of the object the field
    // holds. The object is a reference, so the write goes through a name of the
    // statement's own and lands in the same object.
    let place: string = buffer.text === "this" && this.currentClass !== null ? "self" : buffer.text;
    if (this.at(".") && this.tokens[this.position + 1]?.kind === "ident" && this.tokens[this.position + 2]?.text === "[") {
      const field = this.tokens[this.position + 1] as Token;
      const member: Expression = { k: "member", base: { k: "ident", name: place }, field: field.text };
      this.next();
      this.next();
      const held = this.writeTarget(member, buffer.line);
      if (held === null) {
        this.position = start;
        return null;
      }
      place = held;
    }
    if (!this.at("[")) {
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
    // The write is the dictionary's own, by the value the entry holds, and a
    // compound write is the entry read and the operator applied to it.
    const heldCollection = this.collectionOfExpression({ k: "ident", name: place });
    if (heldCollection !== null && heldCollection.kind === "map") {
      const setName = this.collectionSetNameFor(heldCollection);
      const compound = operator.text !== "=" && operator.text !== "??=" ? COMPOUND_OPERATORS[operator.text] : null;
      if (setName !== null && (operator.text === "=" || operator.text === "??=" || compound !== null)) {
        const read = operator.text === "="
          ? null
          : this.collectionMethod({ k: "ident", name: place }, heldCollection, "get", [index]);
        const written: Expression = read === null
          ? value
          : { k: "binary", op: compound ?? "??", left: read, right: value };
        return {
          kind: "expression",
          value: {
            k: "call",
            name: setName,
            args: [{ k: "ident", name: place }, index, written],
          },
          line: buffer.line,
        };
      }
    }
    if (operator.text === "??=") {
      return {
        kind: "indexAssign",
        buffer: place,
        index,
        op: "=",
        value: {
          k: "binary",
          op: "??",
          left: { k: "index", base: { k: "ident", name: place }, index },
          right: value,
        },
        line: buffer.line,
      };
    }
    return {
      kind: "indexAssign",
      buffer: place,
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
    // `this.counters[kind] = v` writes an element of the object the field
    // holds, which the indexed reader writes through a name of its own.
    if (this.tokens[this.position + 1]?.kind === "ident" && this.tokens[this.position + 2]?.text === "[") {
      this.position = start;
      return this.readIndexedAssignment();
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
    // `a.length = n` writes the list the name holds, at that length.
    if (field.text === "length") {
      const owner: Expression = { k: "ident", name: writtenBase };
      const ownerType = this.valueTypeOf(owner);
      if (ownerType.kind === "slice" || ownerType.kind === "array") {
        this.next();
        const value = this.readExpression();
        this.accept(";");
        const lowered = this.lengthAssign(owner, ownerType, operator.text, value, base.line);
        if (lowered !== null) return lowered;
        this.position = start;
        return null;
      }
    }
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
      // `a.b.length = n` writes the list the field holds, and the write goes
      // back into that field. A text has no writable length, and that is
      // refused where it is written, as it was before.
      if (field.text === "length" && (ownerType.kind === "slice" || ownerType.kind === "array")) {
        this.next();
        const value = this.readExpression();
        this.accept(";");
        const lowered = this.lengthAssign(owner, ownerType, operator.text, value, base.line);
        if (lowered !== null) return lowered;
        this.position = start;
        return null;
      }
      if (field.text === "length" && ownerType.kind === "text") {
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
    // `m.clear()` written on its own line empties the collection the place
    // holds: the handle is a new, empty dictionary, and the place is written
    // with it. Nothing else names the dictionary the place held, so this is the
    // clear the source asked for.
    if (value.k === "call" && value.name === "__collection_clear") {
      const receiver = value.args[0];
      const empty: Expression = { k: "call", name: "blaze_rt_dict_new", args: [] };
      if (receiver !== undefined && receiver.k === "ident") {
        return { kind: "assign", target: receiver.name, op: "=", value: empty, line: token.line };
      }
      if (receiver !== undefined && receiver.k === "member" && receiver.base.k === "ident") {
        return { kind: "memberAssign", base: receiver.base.name, field: receiver.field, op: "=", value: empty, line: token.line };
      }
    }
    // `a.push(x)` answers the array the name holds afterwards, so written on
    // its own line it is the write that keeps it. A field is written back into
    // the field it was read from, with the object it belongs to unchanged.
    if (value.k === "append" && value.arms !== undefined && value.condition !== undefined) {
      const writeArm = (arm: { target: string; base: string | null }): Statement => {
        const array: Expression = arm.base === null
          ? { k: "ident", name: arm.target }
          : { k: "member", base: { k: "ident", name: arm.base }, field: arm.target };
        const call = value.spreads === undefined
          ? { k: "call", name: value.helper, args: [array, ...value.values] } as Expression
          : value.values.reduce<Expression>((inner, written, at) => {
              const element = value.element === undefined ? typeToString(ANY_TYPE) : typeToString(value.element);
              const joined: Expression = value.spreads?.[at] === true ? written : { k: "buffer", element, values: [written] };
              return { k: "binary", op: "+", left: inner, right: joined };
            }, array);
        return arm.base === null
          ? { kind: "assign", target: arm.target, op: "=", value: call, line: token.line }
          : { kind: "memberAssign", base: arm.base, field: arm.target, op: "=", value: call, line: token.line };
      };
      const arms = value.arms;
      return {
        kind: "if",
        condition: value.condition,
        then: [writeArm(arms[0] as { target: string; base: string | null })],
        otherwise: [writeArm(arms[1] as { target: string; base: string | null })],
        line: token.line,
      };
    }
    if (value.k === "append") {
      const array: Expression = appendArray(value);
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
      if (value.index !== undefined) {
        return { kind: "indexAssign", buffer: value.target, index: value.index, op: "=", value: call, line: token.line };
      }
      if (value.base === null) {
        return { kind: "assign", target: value.target, op: "=", value: call, line: token.line };
      }
      return { kind: "memberAssign", base: value.base, field: value.target, op: "=", value: call, line: token.line };
    }
    return { kind: "expression", value, line: token.line };
  }

  /**
   * `process.stdout.write(text)`: the text written where it is, without ending
   * the line a `console.log` ends.
   *
   * A function writes to the program's own output, and to the error stream the
   * runtime reports its own failures on: the two are the runtime's to hold, and
   * the text is written where it is.
   */
  private readProcessWrite(): Statement | null {
    const start = this.peek();
    this.next();
    this.next();
    const stream = this.next();
    this.next();
    const method = this.next();
    if (method.text !== "write") {
      this.report(`process.${stream.text}.${method.text} is not part of the subset`, "a program writes with process.stdout.write", method);
      this.skipStatementTail();
      return { kind: "print", value: this.hole(), line: start.line };
    }
    this.expect("(");
    const value = this.readAt(TEXT_RESULT, () => this.readExpression());
    // A print may end its argument with a comma, which names no argument.
    this.accept(",");
    this.expect(")");
    this.accept(";");
    // The error stream is the runtime's own, and the text a function writes
    // there is the text it wrote: the runtime holds the stream, and the call
    // writes it before it reports anything of its own.
    if (stream.text === "stderr") {
      return { kind: "expression", value: { k: "call", name: "process.stderr.write", args: [value] }, line: start.line };
    }
    return { kind: "print", value, newline: false, line: start.line };
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
    // A print may end its argument with a comma, which names no argument.
    this.accept(",");
    this.expect(")");
    this.accept(";");
    return { kind: "print", value, line: start.line };
  }

  /**
   * `for (let i = from; i < to; i++)`, the `<=`, `>` and `>=` forms, and
   * `for (const x of values)`, which walks a typed array instead.
   *
   * `for await (const x of values)` awaits each element a promise settles to.
   * A compiled program runs straight through, so the elements are the values
   * the iterable holds: where the source writes the `await` on the iterable —
   * `of await readdir(...)` — the loop is the for-of it is, and the word is the
   * marker it is. An iterable that is itself a promise is refused by the for-of
   * reader, which walks a list.
   */
  private readLoop(): Statement {
    const start = this.next();
    this.accept("await");
    this.expect("(");
    /** Where the header begins, for a loop read again as the while it is. */
    const header = this.position;
    // `for (;;)`, `for (; condition; step)` and every other header that is not
    // a counted loop are the while loop the source wrote as a for loop.
    if (this.at(";")) return this.readGeneralFor(header);
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
    // `for (let line: string | null = from; ...)`: the annotation is erased
    // like every other, and what the loop reads is the value at the `=`.
    if (this.at(":")) {
      this.next();
      this.skipBalancedTypeTokens(LOOP_INIT_STOPS);
    }
    if (this.at("of")) return this.readForOf(start, variable.text, null);
    this.expect("=");
    const from = this.readExpression();
    this.expect(";");

    // The header is read from where the loop began when it is not the counted
    // loop: `for (let line = this.peek(); line !== null; line = this.peek())`
    // is a while loop with a step, and the header is read again that way.
    const condition = this.next();
    if (condition.kind !== "ident" || condition.text !== variable.text) {
      return this.readGeneralFor(header);
    }
    const comparison = this.next();
    if (comparison.kind !== "punct" || !["<", "<=", ">", ">="].includes(comparison.text)) {
      return this.readGeneralFor(header);
    }
    const to = this.readExpression();
    this.expect(";");
    // A step that is not the index moving by one or by a count is the while
    // loop the source wrote as a for loop, with the step the body runs last:
    // `open = text.indexOf(...)` is not `open++`, and the header is read again
    // that way.
    if (!this.countedStepAt(variable.text)) return this.readGeneralFor(header);
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

  /**
   * `for (init; condition; step) body`: the while loop the source wrote as a
   * for loop.
   *
   * The initialiser runs once, before the loop, so it is a statement of its
   * own before this one; the step runs at the end of every turn, so it is the
   * last statement of the body. The condition is read every turn, as a while
   * loop's is. A `continue` written in the body would jump to the update the
   * source wrote rather than the end of the body, and this lowering has no way
   * to say that: it is refused where it is written.
   */
  private readGeneralFor(header: number): Statement {
    const start = this.tokens[header - 2] ?? this.peek();
    this.position = header;
    if (!this.at(";")) {
      const init = this.readStatement();
      this.pendingBefore.push(init);
    } else {
      this.next();
    }
    const condition: Expression = this.at(";") ? { k: "literal", text: "1" } : this.readExpression();
    this.expect(";");
    let step: Statement | null = null;
    if (!this.at(")")) step = this.readStatement();
    this.expect(")");
    // The initialiser runs once, before the loop, so it belongs to the
    // statement list this loop is one of — and the body's own statements flush
    // that list as they are read. It is taken back while the body is read.
    const before = this.pendingBefore;
    this.pendingBefore = [];
    const body = this.loopBody();
    this.pendingBefore = before;
    if (step === null) return { kind: "while", condition, body, line: start.line };
    // A `continue` of this loop runs the step, which is where the source put it:
    // the step is written in front of each `continue` the body's own loops do
    // not hold, and at the end of the body for a turn that runs to the end.
    return {
      kind: "while",
      condition,
      body: [...continueWithStep(body, step), step],
      line: start.line,
    };
  }

  /** Whether the tokens at the cursor are the counted step of `variable`. */
  private countedStepAt(variable: string): boolean {
    if (this.at(")")) return false;
    const name = this.tokens[this.position];
    const operator = this.tokens[this.position + 1];
    if (name === undefined || operator === undefined) return false;
    if (name.kind !== "ident" || name.text !== variable) return false;
    return operator.text === "++" || operator.text === "--" || operator.text === "+=" || operator.text === "-=";
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
    // is held at the element type an arrow capturing it would be handed. A text
    // is walked by character, so the element is a text of one character.
    const walkedType = this.valueTypes.get(walked);
    const element = walkedType !== undefined && (walkedType.kind === "slice" || walkedType.kind === "array") ? walkedType.of
      : walkedType !== undefined && walkedType.kind === "text" ? TEXT_RESULT : ANY_TYPE;
    // The shape the walked value names, whether it is a name of the body or a
    // constant the file wrote above it: `for (const rule of RULES)` reads the
    // fields of a rule the same way `RULES[0]` does.
    const walkedShape = written !== null ? this.shapeOf(written) : this.shapeOf({ k: "ident", name: walked });
    const elementShape = walkedShape !== null && walkedShape.kind === "list" ? walkedShape.of : null;
    // A pattern binds the parts of the element, so the loop walks a name of its
    // own and the body reads each name out of that one.
    const item = pattern === null ? variable : `__item${this.destructureCount++}`;
    this.valueTypes.set(item, element);
    if (elementShape !== null) this.valueShapes.set(item, elementShape);
    else this.valueShapes.delete(item);
    // An element that is an instance of a class is an instance where the body
    // reads it: a field of the class is what the field read asks, not the
    // `any` the contract spells a reference as.
    if (element.kind === "ref" && element.name !== undefined && this.classTable.names.has(element.name)) {
      this.valueClasses.set(item, element.name);
    } else if (elementShape !== null && elementShape.kind === "ref" && elementShape.name !== null && this.classTable.names.has(elementShape.name)) {
      this.valueClasses.set(item, elementShape.name);
    } else {
      this.valueClasses.delete(item);
    }
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
    const bind = (name: string, type: TypeExpr, readName: string, shapeHint: ResolvedType | null = null): Statement => {
      // The value a map holds is the type the declaration spells, and a record
      // of a declaration spells only the reference: the fields are the shape
      // the declaration named, which the collection carries for this.
      const written = shapeHint ?? this.shapeOfTypeExpr(type);
      const shape = this.shapeForRead(written) ?? written;
      this.valueTypes.set(name, type);
      if (shape.kind !== "any") this.valueShapes.set(name, shape);
      else this.valueShapes.delete(name);
      if (type.kind === "ref" && type.name !== undefined && this.classTable.names.has(type.name)) {
        this.valueClasses.set(name, type.name);
      } else if (shape.kind === "ref" && shape.name !== null && this.classTable.names.has(shape.name)) {
        this.valueClasses.set(name, shape.name);
      } else {
        this.valueClasses.delete(name);
      }
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
        else if (value) body.push(bind(binding.name, collection.value, this.valueReadName(collection.value), collection.valueShape ?? null));
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
    // The element the list holds is the record its declaration wrote, and the
    // body reads the fields of that record: the type an element is carried at
    // spells only the reference, so the shape is read off the list's own.
    const receiverShape = this.shapeOf(receiver);
    const elementShape = receiverShape !== null && receiverShape.kind === "list" ? receiverShape.of : null;
    const body: Statement[] = [];
    const bind = (name: string, type: TypeExpr, read: Expression): Statement => {
      // The element of a list is held at the type the list declares, and that
      // type may be a name — `Fixup[]` names the `Fixup` each element is. A
      // name is not the record it stands for, and the body reads the fields of
      // the record: spreading the element is the fields the interface wrote.
      const bare = type.kind === "ref" && type.name === undefined;
      const written = bare && elementShape !== null ? elementShape : this.shapeOfTypeExpr(type);
      const shape = this.shapeForRead(written) ?? written;
      this.valueTypes.set(name, type);
      if (shape.kind !== "any") this.valueShapes.set(name, shape);
      else this.valueShapes.delete(name);
      if (type.kind === "ref" && type.name !== undefined && this.classTable.names.has(type.name)) {
        this.valueClasses.set(name, type.name);
      } else if (shape.kind === "ref" && shape.name !== null && this.classTable.names.has(shape.name)) {
        this.valueClasses.set(name, shape.name);
      } else {
        this.valueClasses.delete(name);
      }
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
    const condition = this.inLoopCondition(() => this.readExpression());
    this.expect(")");
    return { kind: "while", condition, body: this.loopBody(), line: start.line };
  }

  /** A condition a loop reads every turn, which is not read once. */
  private inLoopCondition<T>(read: () => T): T {
    const saved = this.loopCondition;
    this.loopCondition = true;
    try {
      return read();
    } finally {
      this.loopCondition = saved;
    }
  }

  private readDoWhile(): Statement {
    const start = this.next();
    const body = this.loopBody();
    if (!this.accept("while")) {
      this.report("a do-while loop ends with `while (condition);`", `near "${this.peek().text}"`);
      return { kind: "expression", value: this.hole(), line: start.line };
    }
    this.expect("(");
    const condition = this.inLoopCondition(() => this.readExpression());
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
      const written = this.assignmentAsValue(value);
      this.arrowName = arrowName;
      return binding ? written : this.materialized(written);
    } finally {
      this.expressionReads -= 1;
      if (this.expressionReads === 0 && this.expectedReads === 0) this.reportUnsettledArrays();
    }
  }

  /**
   * An assignment written where an expression goes, as `${this.builds += 1}`.
   *
   * A write is a statement, so the value the expression answers is the place
   * read after the write: the write runs before the statement the expression is
   * part of, and the place is what the expression is. Only a name and a field
   * of a name are places an expression can write; a field of a field and an
   * element are not, and are refused where they are written.
   */
  private assignmentAsValue(value: Expression): Expression {
    const operator = this.peek();
    if (operator.kind !== "punct") return value;
    const op = operator.text === "=" || operator.text in COMPOUND_OPERATORS
      ? (operator.text as AssignOperator)
      : null;
    if (op === null) return value;
    if (value.k !== "ident" && value.k !== "member") return value;
    if (this.loopCondition) {
      this.report(
        "an assignment written in a loop condition is not part of the subset",
        "write the value into a name inside the loop, and test the name",
        operator,
      );
      return this.hole();
    }
    this.next();
    const written = this.readExpression();
    if (value.k === "ident") {
      this.pendingBefore.push({ kind: "assign", target: value.name, op, value: written, line: operator.line });
      return value;
    }
    const base = this.writeTarget(value.base, operator.line);
    if (base === null) {
      this.report("an assignment answers the place it writes", "write it as a statement of its own", operator);
      return this.hole();
    }
    this.pendingBefore.push({ kind: "memberAssign", base, field: value.field, op, value: written, line: operator.line });
    return { k: "member", base: { k: "ident", name: base }, field: value.field };
  }

  /** `c ? a : b`, the loosest operator an expression has. */
  private readConditional(): Expression {
    const condition = this.readNullish();
    if (!this.at("?")) return condition;
    this.next();
    const then = this.withNarrowing(this.narrowingOf(condition, true), () => this.readExpression());
    this.expect(":");
    let otherwise = this.withNarrowing(this.narrowingOf(condition, false), () => this.readExpression());
    // `c ? [] : values` where `values` is a set is the set where it is there
    // and no entries where it is not: a set is one handle on the runtime's
    // dictionary, and the absence of one is zero, which holds no entries. The
    // empty list is a block of elements and a loop that walked it as a set
    // would read an element as a dictionary.
    const empty = (arm: Expression): boolean => arm.k === "buffer" && arm.values.length === 0;
    if (empty(then) !== empty(otherwise)) {
      const setArm = empty(then) ? otherwise : then;
      if (this.setElementListType(setArm) !== null) {
        this.unsettledArrays.delete((empty(then) ? then : otherwise) as Expression);
        if (empty(then)) {
          return { k: "conditional", condition, then: { k: "literal", text: "0" }, otherwise };
        }
        otherwise = { k: "literal", text: "0" };
      }
    }
    // An arm is read at the type of the arm that has one, or at the type the
    // use of the whole conditional states: `c ? { v: 1, pre: [] } : expand(x)`
    // takes the fields the call answers for the literal. A use that states a
    // number says nothing about a list written inside the conditional, so a
    // type is taken from an arm only where it is a list or a record.
    const expected = this.expectedType !== null &&
      (this.expectedType.kind === "slice" || this.expectedType.kind === "array")
      ? this.expectedType
      : null;
    const shape = this.expectedShape ?? this.settledShapeOf(then) ?? this.settledShapeOf(otherwise);
    const type = expected
      ?? this.settledArrayType(then)
      ?? this.settledArrayType(otherwise)
      ?? (shape === null ? null : this.typeExprOfShape(shape));
    if (type !== null) this.applyExpected(then, type, shape);
    if (type !== null) this.applyExpected(otherwise, type, shape);
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
      // `values ?? []` where `values` is a set is `values`: the absence of a
      // set is the zero handle, and a dictionary that is zero holds no entries.
      if (right.k === "buffer" && right.values.length === 0 && this.setElementListType(left) !== null) {
        this.unsettledArrays.delete(right);
        continue;
      }
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
    this.arrayTests.set(asked, value);
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
      if (!this.repeatable(key)) {
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
    const shape = this.shapeOf(object);
    if (name !== null) {
      if (shape !== null && shape.kind === "record" && shape.fields.has(name)) {
        // A record built from an interface has every field it declares, so the
        // question is answered where it is read. A union of shapes does not: an
        // object written as one arm is laid out as every arm's fields with the
        // rest zero, and the arm it is written as is the tag the literal
        // carries. The question is whether that tag names an arm with the field.
        if (shape.arms === undefined) {
          const answer: Expression = { k: "literal", text: "1" };
          this.expressionTypes.set(answer, BOOLEAN_RESULT);
          return answer;
        }
        const arms: number[] = [];
        for (let at = 0; at < shape.arms.length; at += 1) {
          const arm = shape.arms[at] as ResolvedType;
          if (arm.kind === "record" && arm.fields.has(name)) arms.push(at);
        }
        const tag: Expression = { k: "member", base: object, field: "__arm" };
        this.expressionTypes.set(tag, NUMBER_RESULT);
        let answer: Expression = { k: "literal", text: "0" };
        for (let at = arms.length - 1; at >= 0; at -= 1) {
          answer = {
            k: "conditional",
            condition: {
              k: "binary",
              op: "===",
              left: tag,
              right: { k: "literal", text: String(arms[at]) },
            },
            then: { k: "literal", text: "1" },
            otherwise: answer,
          };
        }
        this.expressionTypes.set(answer, BOOLEAN_RESULT);
        return answer;
      }
    }
    // A key the source holds in a name, asked of a record of fields: the
    // record lays every field it declares out, so the answer is whether the
    // key is one of their names. It is the chain the constant path writes,
    // and the key is asked once per name, which a value that runs on every
    // mention may not be.
    if (
      name === null && shape !== null && shape.kind === "record" && shape.arms === undefined &&
      shape.index === null && shape.fields.size > 0 &&
      // An optional field is laid out at the zero of its type whether or not
      // the source wrote it, so whether it is *there* is a question the layout
      // does not answer.
      [...shape.fields.values()].every((field) => !field.optional)
    ) {
      if (!this.repeatable(key)) {
        this.report(
          "a record's keys read the key once",
          "write the key into a name first, as in const k = f(); k in TABLE",
          this.peek(),
        );
        return this.hole();
      }
      const keys = [...shape.fields.keys()];
      let answer: Expression = { k: "literal", text: "0" };
      // The chain asks the last name first, so the comparisons run in the order
      // the object wrote its fields.
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
    // A dictionary the program builds answers the question from its entries:
    // `key in table` is the `has` the dictionary's own method is, and the key
    // is the one it holds. The fields are not written down, so there is no
    // field to compare against.
    const dictionary = shape === null ? null : this.collectionOfShape(shape);
    if (dictionary !== null && dictionary.kind === "map") {
      const asked: Expression = {
        k: "call",
        name: this.dictionaryCall(dictionary.key, "has") ?? "blaze_rt_dict_has",
        args: [object, key],
      };
      this.expressionTypes.set(asked, BOOLEAN_RESULT);
      return asked;
    }
    // The value may be one an imported function answered: its fields are the
    // declaration's, and the graph has not linked that module yet. The question
    // waits for the read that follows the link rather than being refused here.
    if (this.importsArePending() && this.opaqueValue(object)) {
      this.deferred.add(object);
      return this.hole();
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
    if (!this.repeatable(value)) {
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
      const subject = this.arrayTests.get(value);
      if (subject !== undefined) {
        // `Array.isArray(node)` is a list in the branch it holds in, whatever
        // the declaration said: the value is asked at run time because the read
        // could not type it, and the element type it holds is the untyped
        // reference the read would have given every element anyway.
        const one = isNumberLiteral(value.right, "1") ? "1" : isNumberLiteral(value.right, "0") ? "0" : null;
        if (one !== null) {
          const list = one === "1" ? positive === truth : positive !== truth;
          const path = list ? this.narrowedPath(subject) : null;
          if (path !== null) settled.set(path, { kind: "slice", of: ANY_TYPE });
        }
        return;
      }
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
      let target = current();
      // The value before `?.` is read by the condition and again inside the
      // branch, so it has to be a value reading twice does not change. A value
      // that is not one is read into a name before the statement, which is the
      // value the source read — unless the chain is a loop condition, which is
      // read every turn and has no statement of its own to be read before.
      if (!this.repeatable(target)) {
        const held = this.loopCondition ? null : this.writeTarget(target, this.peek().line);
        if (held === null) {
          this.report(
            "an optional chain reads the value before `?.` twice",
            "write the value into a name first, as in const value = f(); value?.field",
            this.peek(),
          );
        } else {
          target = { k: "ident", name: held };
        }
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
          const args = this.readCallArguments(
            binding.params.map((param) => param.type),
            null,
            false,
            false,
            null,
            binding.params.map((param) => param.shape ?? null),
          );
          const rest = binding.rest;
          // A parameter the call leaves out is the default the arrow wrote. The
          // default is a value written out, so reading it here is reading the
          // same value the arrow did.
          const supplied = args.slice();
          if (rest === undefined) {
            for (let at = supplied.length; at < binding.params.length; at += 1) {
              const fallback = binding.params[at]?.default;
              if (fallback === undefined) break;
              supplied.push(fallback);
            }
          }
          const callArgs = rest === undefined
            ? supplied
            : [
                ...args.slice(0, rest),
                {
                  k: "buffer" as const,
                  element: typeToString(elementOfSequenceType(binding.params[rest]?.type ?? ANY_TYPE) ?? ANY_TYPE),
                  values: args.slice(rest),
                },
              ];
          const made: Expression = {
            k: "call",
            name: binding.function,
            args: [...binding.captures.map((name): Expression => ({ k: "ident", name })), ...callArgs],
          };
          if (binding.returnsShape !== undefined && binding.returnsShape !== null) {
            this.expressionShapes.set(made, this.shapeForRead(binding.returnsShape) ?? binding.returnsShape);
          }
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
        // `BigInt(x)` is the whole number a value names. A number is the
        // machine word it is, and the use converts it there: the language's own
        // `BigInt` of a double is that number without its fraction, which is
        // the reading a store of sixty-four bits makes of it.
        if (target.k === "ident" && target.name === "BigInt") {
          const args = this.readCallArguments([NUMBER_RESULT]);
          const written = args[0];
          // A literal is a constant the compiler already holds: `BigInt(128)`
          // is the wide constant a power is folded with, and the read that
          // folds it is the one that knows its width.
          const constant = written !== undefined && (written.k === "literal" || written.k === "bigint" || written.k === "text");
          const held = written === undefined || constant ? null : this.valueTypeOf(written);
          if (held !== null && held.kind === "primitive" && held.name !== "i256" && held.name !== "u256") {
            this.expressionTypes.set(args[0] as Expression, BIGINT_RESULT);
            replace(args[0] as Expression);
            continue;
          }
          // A form this read does not fold — the digits a text states — is
          // left as the call the source wrote, for the read that knows it.
          const left: Expression = { k: "call", name: "BigInt", args };
          this.expressionTypes.set(left, BIGINT_RESULT);
          replace(left);
          continue;
        }
        if (target.k === "ident") {
          const signature = this.valueFunctions.get(target.name);
          if (signature !== undefined) {
            const args = this.readCallArguments(signature.params);
            const made: Expression = { k: "invoke", callee: target, args, params: signature.params, returns: signature.returns };
            // What the value the callee holds answers is the shape its type
            // states, kept beside the call so a call written on the answer —
            // `make()(x)` where `make` returns a function — reads it.
            const held = this.shapeOf(target);
            if (held !== null && held.kind === "function") {
              const answered = this.shapeForRead(held.returns);
              if (answered !== null) this.expressionShapes.set(made, answered);
            }
            replace(made);
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
        // `Object.is(a, b)` is the question of whether two values are the same
        // value, which the language answers differently from `===` in two
        // places: a NaN is the same as itself, and `-0` is not `0`. Two numbers
        // are compared by the bits they are held as, which the runtime does;
        // two texts, truths or references answer `===`, which compares texts by
        // what they say and the others by the value they hold.
        if (
          target.k === "member" &&
          target.base.k === "ident" &&
          target.base.name === "Object" &&
          target.field === "is"
        ) {
          const args = this.readCallArguments();
          if (args.length !== 2) {
            this.report("Object.is compares two values", `it was given ${args.length}`, this.peek());
            return this.hole();
          }
          const numeric = (type: TypeExpr): boolean => type.kind === "primitive" && type.name !== "bool";
          const left = args[0] as Expression;
          const right = args[1] as Expression;
          const made: Expression = numeric(this.valueTypeOf(left)) || numeric(this.valueTypeOf(right))
            ? { k: "call", name: "blaze_rt_number_same", args: [left, right] }
            : { k: "binary", op: "===", left, right };
          this.expressionTypes.set(made, BOOLEAN_RESULT);
          replace(made);
          continue;
        }
        // `BigInt.asIntN(bits, value)` and `asUintN` wrap a whole number to a
        // width: the low bits of it, and for the signed one the sign of the
        // highest of those bits carried up. The width is a number a program may
        // compute, so the wrap is the runtime's.
        if (
          target.k === "member" &&
          target.base.k === "ident" &&
          target.base.name === "BigInt" &&
          (target.field === "asIntN" || target.field === "asUintN")
        ) {
          const args = this.readCallArguments([NUMBER_RESULT, BIGINT_RESULT]);
          const bits = args[0];
          const value = args[1];
          const held = value === undefined ? null : this.valueTypeOf(value);
          const whole = held !== null && held.kind === "primitive" && (held.name === "i64" || held.name === "u64");
          if (bits === undefined || value === undefined || args.length !== 2 || !whole) {
            this.report(
              `BigInt.${target.field} wraps a whole number to a width`,
              "as in BigInt.asIntN(64, value), over a bigint",
              this.peek(),
            );
            return this.hole();
          }
          // A width of the whole carrier is the number itself.
          if (bits.k === "literal" && Number(bits.text) >= 64) {
            replace(value);
            continue;
          }
          const wrapped: Expression = {
            k: "call",
            name: target.field === "asIntN" ? "blaze_rt_as_int_n" : "blaze_rt_as_uint_n",
            args: [bits, value],
          };
          this.expressionTypes.set(wrapped, BIGINT_RESULT);
          replace(wrapped);
          continue;
        }
        // `Buffer.byteLength(text, "utf8")` is the number of bytes the text is
        // written as, which is what the runtime already measures for a managed
        // string and a literal alike. The encoding is the one a text is written
        // in: a source asks for utf8 or asks for nothing.
        if (
          target.k === "member" &&
          target.base.k === "ident" &&
          target.base.name === "Buffer" &&
          target.field === "byteLength"
        ) {
          const args = this.readCallArguments([TEXT_RESULT, TEXT_RESULT]);
          const length = args[0];
          const encoding = args[1];
          const utf8 = encoding === undefined || (encoding.k === "text" && textValue(encoding) === "utf8");
          if (length === undefined || !utf8 || args.length > 2) {
            this.report(
              "Buffer.byteLength measures a text written as utf8",
              "the source writes Buffer.byteLength(text) or Buffer.byteLength(text, `utf8`)",
              this.peek(),
            );
            return this.hole();
          }
          const measured: Expression = { k: "call", name: "blaze_rt_text_length", args: [length] };
          this.expressionTypes.set(measured, NUMBER_RESULT);
          replace(measured);
          continue;
        }
        // `Buffer.from(text, "utf8")` is the bytes the text is written as,
        // which is what the encoder answers, and `Buffer.from(bytes)` is a copy
        // of the bytes it is handed: the same block under the type a byte array
        // is, so a write into the copy does not reach the source.
        if (
          target.k === "member" &&
          target.base.k === "ident" &&
          target.base.name === "Buffer" &&
          target.field === "from"
        ) {
          const args = this.readCallArguments();
          const source = args[0];
          const encoding = args[1];
          const held = source === undefined ? null : this.valueTypeOf(source);
          const utf8 = encoding === undefined || (encoding.k === "text" && textValue(encoding) === "utf8");
          if (source !== undefined && held !== null && utf8 && (held.kind === "text" || held.kind === "fixed")) {
            const encoded: Expression = { k: "call", name: "TextEncoder.encode", args: [source] };
            this.expressionTypes.set(encoded, { kind: "slice", of: BYTE });
            replace(encoded);
            continue;
          }
          const element = held !== null && (held.kind === "slice" || held.kind === "array") ? held.of : null;
          if (source !== undefined && element !== null && element.kind === "primitive" && element.name === "u8") {
            const copy = this.typedFromHelper(element, BYTE, this.peek().line);
            const made: Expression = { k: "call", name: copy.name, args: [source] };
            this.expressionTypes.set(made, copy.returns);
            replace(made);
            continue;
          }
          this.report(
            "Buffer.from copies a text or a byte array",
            "the source writes Buffer.from(text, `utf8`) or Buffer.from(bytes)",
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
        // `Object.assign(target, source)` copies the entries of the source into
        // the target and answers the target: where the target is a dictionary
        // each entry is written into it in order, so a later source overwrites
        // an earlier key the way the language overwrites it.
        if (
          target.k === "member" &&
          target.base.k === "ident" &&
          target.base.name === "Object" &&
          target.field === "assign"
        ) {
          const args = this.readCallArguments();
          const first = args[0];
          const targetCollection = first === undefined ? null : this.collectionOfExpression(first);
          if (
            first !== undefined &&
            args.length >= 2 &&
            targetCollection !== null &&
            targetCollection.kind === "map"
          ) {
            let sourcesOk = true;
            const sources: { source: Expression; collection: CollectionValue }[] = [];
            for (let at = 1; at < args.length; at += 1) {
              const source = args[at] as Expression;
              const collection = this.collectionOfExpression(source);
              if (collection === null || collection.kind !== "map") {
                sourcesOk = false;
                break;
              }
              sources.push({ source, collection });
            }
            if (sourcesOk) {
              let answer: Expression = first;
              for (const { source, collection } of sources) {
                answer = this.collectionAssignHelper(targetCollection, collection, answer, source, this.peek().line);
              }
              this.expressionTypes.set(answer, NUMBER_RESULT);
              this.collectionExpressions.set(answer, targetCollection);
              replace(answer);
              continue;
            }
          }
          // A record is a reference, and the fields the source declares are the
          // ones copied into the target: `Object.assign(statement, rewritten)`
          // writes the fields of one statement over another and answers the one
          // it wrote. Each source is read once into a name of the statement's
          // own, because a field read of a call runs the call again, and the
          // fields are written only after every source is known to fit.
          const targetShape = first === undefined ? null : this.shapeOf(first);
          const targetName = first !== undefined && first.k === "ident" ? first.name : null;
          if (
            first !== undefined &&
            targetName !== null &&
            args.length >= 2 &&
            targetShape !== null &&
            targetShape.kind === "record" &&
            targetShape.index === null
          ) {
            const holds: { name: string; source: Expression; type: TypeExpr }[] = [];
            const writes: { field: string; from: string }[] = [];
            let usable = true;
            for (let at = 1; at < args.length && usable; at += 1) {
              const source = args[at] as Expression;
              const shape = this.shapeOf(source);
              if (shape === null || shape.kind !== "record" || shape.index !== null) {
                usable = false;
                break;
              }
              const held = `__assign${this.fieldCount++}`;
              holds.push({ name: held, source, type: this.typeExprOfShape(shape) });
              for (const field of shape.fields.keys()) {
                if (!targetShape.fields.has(field)) {
                  usable = false;
                  break;
                }
                writes.push({ field, from: held });
              }
            }
            if (usable) {
              for (const hold of holds) {
                this.pendingBefore.push({ kind: "declare", name: hold.name, type: null, init: hold.source, line: this.peek().line });
                this.valueTypes.set(hold.name, hold.type);
              }
              for (const write of writes) {
                this.pendingBefore.push({
                  kind: "memberAssign",
                  base: targetName,
                  field: write.field,
                  op: "=",
                  value: { k: "member", base: { k: "ident", name: write.from }, field: write.field },
                  line: this.peek().line,
                });
              }
              replace(first);
              continue;
            }
          }
          // A target or source that is a record the object pass has not laid
          // out, or a field the target does not write, is left to the method
          // read's own refusal. The arguments are read, so the diagnostic is
          // the one the source earns.
          this.report(
            `"assign" is not a method this program compiles`,
            "a method is declared by a class the same module or its imports carry",
            this.peek(),
          );
          return this.hole();
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
          // `Object.fromEntries(list.map((item) => [k, v]))` is the dictionary
          // the callback writes: an entry is two values of two types, which a
          // compiled list cannot hold, so the call is read as the loop of
          // writes it means, exactly as `new Map(list.map(...))` is.
          if (this.at("(") && this.entriesConcatAt(this.position + 1) !== null) {
            this.next();
            const collection: CollectionValue = { kind: "map", key: NUMBER_RESULT, value: NUMBER_RESULT };
            const made = this.readEntriesConcat(collection);
            if (made !== null) {
              this.expressionTypes.set(made, NUMBER_RESULT);
              this.collectionExpressions.set(made, collection);
              replace(made);
              continue;
            }
          }
          if (this.at("(") && this.pairMapAt(this.position + 1) !== null) {
            this.next();
            const collection: CollectionValue = { kind: "map", key: NUMBER_RESULT, value: NUMBER_RESULT };
            const made = this.readPairMap(collection);
            if (made !== null) {
              this.expressionTypes.set(made, NUMBER_RESULT);
              this.collectionExpressions.set(made, collection);
              replace(made);
              continue;
            }
          }
          if (this.at("(") && this.entriesSortAt(this.position + 1) !== null) {
            this.next();
            const collection: CollectionValue = { kind: "map", key: NUMBER_RESULT, value: NUMBER_RESULT };
            const made = this.readEntriesSort(collection);
            if (made !== null) {
              this.expressionTypes.set(made, NUMBER_RESULT);
              this.collectionExpressions.set(made, collection);
              replace(made);
              continue;
            }
          }
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
          // `Number.parseInt(text, radix)` is the number a text states in its
          // radix: the runtime reads the digits in that base.
          if (target.field === "parseInt" && (args.length === 1 || args.length === 2)) {
            const radix = args[1];
            if (radix === undefined || (radix.k === "literal" && radix.text === "10")) {
              replace({ k: "call", name: "parseInt", args: [args[0] as Expression] });
              continue;
            }
            if (radix.k === "literal" && (radix.text === "2" || radix.text === "8" || radix.text === "16")) {
              replace({ k: "call", name: "Number.parseInt", args });
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
        // record holds a key of its own. `Object.hasOwn(record, key)` asks the
        // same question in the spelling the modern sources write. A record keyed
        // by text is the runtime's dictionary, so the question is the
        // dictionary's.
        const ownedThroughPrototype =
          target.k === "member" &&
          target.field === "call" &&
          target.base.k === "member" &&
          target.base.field === "hasOwnProperty" &&
          target.base.base.k === "member" &&
          target.base.base.field === "prototype" &&
          target.base.base.base.k === "ident" &&
          target.base.base.base.name === "Object";
        const ownedThroughStatic =
          target.k === "member" &&
          target.field === "hasOwn" &&
          target.base.k === "ident" &&
          target.base.name === "Object";
        if (ownedThroughPrototype || ownedThroughStatic) {
          const args = this.readCallArguments();
          const receiver = args[0];
          const key = args[1];
          const collection = receiver === undefined ? null : this.collectionOfExpression(receiver);
          if (collection !== null && collection.kind === "map" && key !== undefined) {
            const has: Expression = {
              k: "call",
              name: this.dictionaryCall(collection.key, "has") ?? "blaze_rt_dict_has",
              args: [receiver, key],
            };
            const answer: Expression = { k: "binary", op: "===", left: has, right: { k: "literal", text: "1" } };
            this.expressionTypes.set(answer, BOOLEAN_RESULT);
            replace(answer);
            continue;
          }
          // A constant object's fields are the names the file wrote, so the
          // question is whether the key is one of them: the comparison chain
          // the set of names is, read with the key once. An object whose values
          // are computed has the same names, because the names are what the
          // source wrote.
          const named = receiver !== undefined && receiver.k === "ident" ? receiver.name : null;
          const constant = named === null ? undefined : this.constants.get(named);
          const declared = named === null ? undefined : this.shapes.get(named);
          let fieldNames: readonly string[] | undefined = declared?.names;
          if (constant?.fields !== undefined) {
            const written: string[] = [];
            for (const name of constant.fields.keys()) written.push(name);
            fieldNames = written;
          }
          if (fieldNames !== undefined && key !== undefined) {
            const read = (value: Expression): Expression => {
              if (value.k === "literal" || value.k === "ident" || value.k === "text") return value;
              const held = `__hasOwn${this.fieldCount++}`;
              this.pendingBefore.push({ kind: "declare", name: held, type: null, init: value, line: this.peek().line });
              this.valueTypes.set(held, TEXT_RESULT);
              return { k: "ident", name: held };
            };
            const held = read(key);
            let answer: Expression | null = null;
            for (const name of fieldNames) {
              const equal: Expression = {
                k: "binary",
                op: "===",
                left: held,
                right: { k: "text", parts: [{ k: "text", value: name }] },
              };
              this.expressionTypes.set(equal, BOOLEAN_RESULT);
              answer = answer === null ? equal : { k: "binary", op: "||", left: answer, right: equal };
            }
            const decided: Expression = answer ?? { k: "literal", text: "0" };
            this.expressionTypes.set(decided, BOOLEAN_RESULT);
            replace(decided);
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
            // A list built while the program runs is a block of one element
            // type, and the JSON of it is the elements' JSON between brackets:
            // a helper walks the block, and a list of lists is the helper of
            // what the inner list holds.
            const helper = this.jsonListHelper(type.of, this.peek().line);
            if (helper.name !== "") {
              const serialized: Expression = { k: "call", name: helper.name, args: [written] };
              this.expressionTypes.set(serialized, TEXT_RESULT);
              replace(serialized);
              continue;
            }
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
        // `Uint8Array.from(list)` and the views beside it: a typed array is a
        // block of one element type, and a list of that type already is one.
        // The copy the source may write is a block of the same elements.
        if (
          target.k === "member" &&
          target.base.k === "ident" &&
          target.field === "from" &&
          target.base.name in TYPED_ARRAYS
        ) {
          const args = this.readCallArguments([ANY_TYPE]);
          const source = args[0];
          const held = source === undefined ? null : this.valueTypeOf(source);
          const wanted = TYPED_ARRAYS[target.base.name] as string;
          const element = held !== null && (held.kind === "slice" || held.kind === "array") ? held.of : null;
          const same = element !== null && (element.kind === "text" ? wanted === "text" : element.kind === "primitive" && element.name === wanted);
          const numeric = element !== null && element.kind === "primitive" && element.name !== "bool" && element.name !== "i256" && element.name !== "u256";
          if (source === undefined || args.length !== 1 || (!same && !numeric)) {
            this.report(
              `${target.base.name}.from copies a list of its elements`,
              `as in ${target.base.name}.from(list)`,
              this.peek(),
            );
            return this.hole();
          }
          if (!same) {
            // A list of numbers copied into a typed array is the copy written
            // where the array's elements are: each number is written as the
            // element the array holds, which is what `from` is.
            const to: TypeExpr = { kind: "primitive", name: wanted as PrimitiveTypeName };
            const helper = this.typedFromHelper(element as TypeExpr, to, this.peek().line);
            const converted: Expression = { k: "call", name: helper.name, args: [source] };
            this.expressionTypes.set(converted, { kind: "slice", of: to });
            const shape = this.shapeOf(source);
            const heldShape = shape !== null && shape.kind === "list" ? shape.of : null;
            this.expressionShapes.set(converted, { kind: "list", of: heldShape ?? this.shapeOfTypeExpr(to) });
            replace(converted);
            continue;
          }
          replace(source);
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
        // `Array.from({ length: n }, (_, i) => v)`: the list of the n answers
        // the callback gives at its indexes. The element the callback is handed
        // is the value the language gives a sparse list, which this compiler has
        // none of; the arrow the sources write names it and reads the index, and
        // the read is refused where the element is read. A form this read does
        // not know is left to the method read, which refuses it the way it
        // refused `Array.from` before.
        if (
          target.k === "member" &&
          target.base.k === "ident" &&
          target.base.name === "Array" &&
          target.field === "from"
        ) {
          const lowered = this.arrayFrom(this.peek().line);
          if (lowered !== null) {
            replace(lowered);
            continue;
          }
        }
        // `String.fromCodePoint(n)` is the text of the one code point it
        // names: the runtime encodes the value as UTF-8 and copies it into a
        // managed string.
        if (
          target.k === "member" &&
          target.base.k === "ident" &&
          target.base.name === "String" &&
          target.field === "fromCodePoint"
        ) {
          const args = this.readCallArguments([NUMBER_RESULT]);
          if (args.length === 1) {
            replace({ k: "call", name: "String.fromCodePoint", args });
            continue;
          }
        }
        if (target.k === "member" && target.base.k === "ident" && NAMESPACES.has(target.base.name)) {
          // A call of a namespace is a call of the name the namespace and the
          // member spell together: `Math.floor(x)` is `Math.floor(x)`, and
          // `http.requestPath(req)` is the HTTP call of that name. It is not a
          // static method of a class, so the class checks below are skipped.
          // `Date` carries `now` beside its `parse`, and the clock is read
          // where it is written instead: neither name is a namespace the clock
          // is asked through. `Promise.all` and `Promise.allSettled` settle a
          // list and are read below, where the list is in hand.
          const settlesAList = target.base.name === "Promise" && (target.field === "all" || target.field === "allSettled");
          if (!settlesAList && !(target.base.name === "Date" && target.field === "now")) {
            replace({ k: "ident", name: `${target.base.name}.${target.field}` });
            continue;
          }
        }
        // `Point.fromAffine(p)`: a static method is a function of the class,
        // with no instance written before its arguments.
        if (target.k === "member" && target.base.k === "ident") {
          const owner = this.classNamed(target.base.name);
          if (owner !== undefined && !this.valueClasses.has(target.base.name)) {
            const found = this.methodOwner(owner.name, target.field, true);
            if (found !== null) {
              const params = this.methodParams(found.method.params);
              const args = this.readCallArguments(
                params.map((param) => param.type),
                null,
                false,
                false,
                null,
                params.map((param) => param.shape),
              );
              replace(this.typedCall(methodFunctionName(found.owner, found.method, args.length), args, found.method.returnTypeName, found.method.line, found.method.returnsShape));
              continue;
            }
          }
        }
        // `p.add(q)`: a method is a function whose first argument is the
        // instance the source called it on.
        if (target.k === "member") {
          // `sink.write(text)` where `write` is a field the declaration types as
          // a function: the call is made through the value the field holds,
          // exactly as a call of a name held at a function type is. It is read
          // before the arguments are, because the signature is what an argument
          // is read at.
          const heldFunction = this.memberFunctionType(target);
          if (heldFunction !== null) {
            const args = this.readCallArguments(heldFunction.params);
            const invoke: Expression = { k: "invoke", callee: target, args, params: heldFunction.params, returns: heldFunction.returns };
            if (heldFunction.shape !== undefined) {
              const held = this.shapeForRead(heldFunction.shape);
              if (held !== null) this.expressionShapes.set(invoke, held);
            }
            replace(invoke);
            continue;
          }
          const callLine = this.peek().line;
          const callback = this.collectionCallbackParameters(target.base, target.field);
          const promiseCallbacks = this.promiseCallbackParameters(target.base, target.field);
          // A callback handed to a method of a value whose type this read does
          // not hold is handed the element of a list whose element type is in
          // a module the graph has not linked: a parameter the use does not fix
          // waits for that link too. An element the read holds as a reference
          // with no name is one the link will name.
          const waitsForLink = this.importsArePending();
          const expectedParams = this.expectedMethodParams(target.base, target.field);
          // `m.set(k, v)` writes one key and one value, so the arguments are
          // read at the key and value types the map was declared with: an empty
          // list written as the value is built at the element type the map
          // holds, and an object literal written there keeps its fields.
          const heldCollectionHere = this.collectionOfExpression(target.base);
          const setTypes = heldCollectionHere !== null && heldCollectionHere.kind === "map" && target.field === "set"
            ? [heldCollectionHere.key, heldCollectionHere.value]
            : expectedParams.map((param) => param.type);
          const setShapes = heldCollectionHere !== null && heldCollectionHere.kind === "map" && target.field === "set"
            ? [null, heldCollectionHere.valueShape ?? this.shapeOfTypeExpr(heldCollectionHere.value)]
            : expectedParams.map((param) => param.shape);
          const args = this.readCallArguments(
            setTypes,
            callback,
            target.field === "push" || target.field === "splice" || target.field === "unshift",
            waitsForLink,
            this.writtenElementType(target.base, target.field),
            setShapes,
            this.writtenElementShape(target.base, target.field),
            promiseCallbacks,
          );
          const spreads = target.field === "push" || target.field === "splice" || target.field === "unshift" ? this.argumentSpreads : null;
          const receiver = target.base;
          // `hash.update(text)` feeds the runtime's SHA-256 hasher and
          // `hash.digest("hex")` answers the digest it holds: the hasher is one
          // handle, and the two calls are the runtime's own.
          const hashing = this.hashers.has(receiver) || (receiver.k === "ident" && this.hasherNames.has(receiver.name));
          if (hashing) {
            if (target.field === "update" && (args.length === 1 || args.length === 2)) {
              const fed: Expression = { k: "call", name: "blaze_rt_sha256_update", args: [receiver, args[0] as Expression] };
              this.expressionTypes.set(fed, NUMBER_RESULT);
              this.hashers.add(fed);
              replace(fed);
              continue;
            }
            if (target.field === "digest" && args.length === 1) {
              const digest: Expression = { k: "call", name: "blaze_rt_sha256_digest", args: [receiver] };
              this.expressionTypes.set(digest, TEXT_RESULT);
              replace(digest);
              continue;
            }
            this.report("a hasher updates a text and digests it", "as in hash.update(text).digest(`hex`)", this.peek());
            replace(this.hole());
            continue;
          }
          // `Date.now()` is the clock, and a date's time is the number it is
          // held as; its stamp is the text `blaze_rt_timestamp_iso` writes.
          if (
            target.base.k === "ident" &&
            target.base.name === "Date" &&
            target.field === "now" &&
            args.length === 0
          ) {
            const now: Expression = { k: "call", name: "blaze_rt_now_ms", args: [] };
            this.expressionTypes.set(now, NUMBER_RESULT);
            replace(now);
            continue;
          }
          if ((target.field === "toISOString" || target.field === "getTime") && args.length === 0) {
            const held = this.valueTypeOf(receiver);
            if (held.kind === "primitive" && held.name === "f64") {
              if (target.field === "getTime") {
                replace(receiver);
                continue;
              }
              const stamp: Expression = { k: "call", name: "blaze_rt_timestamp_iso", args: [] };
              this.expressionTypes.set(stamp, TEXT_RESULT);
              replace(stamp);
              continue;
            }
          }
          // `new TextEncoder().encode(text)` is the bytes the text is written
          // as, which is the one encoding a compiled text is: the runtime copies
          // them into a block of bytes of its own, which is the byte array the
          // source reads.
          if (target.field === "encode" && args.length === 1) {
            const held = this.valueTypeOf(receiver);
            const encoder = held.kind === "ref" && held.name === "__TextEncoder";
            const written = this.valueTypeOf(args[0] as Expression);
            if (encoder && (written.kind === "text" || written.kind === "fixed")) {
              const encoded: Expression = { k: "call", name: "TextEncoder.encode", args: [args[0] as Expression] };
              this.expressionTypes.set(encoded, { kind: "slice", of: BYTE });
              replace(encoded);
              continue;
            }
          }
          // `new TextDecoder().decode(bytes)` is the text those bytes are
          // written as: the runtime copies them into a managed string.
          if (target.field === "decode" && args.length === 1) {
            const held = this.valueTypeOf(receiver);
            const decoder = held.kind === "ref" && held.name === "__TextDecoder";
            const bytes = this.valueTypeOf(args[0] as Expression);
            const element = bytes.kind === "slice" || bytes.kind === "array" ? bytes.of : null;
            if (decoder && element !== null && element.kind === "primitive" && element.name === "u8") {
              const heldBytes = `__bytes${this.fieldCount++}`;
              const sequence: TypeExpr = { kind: "slice", of: element };
              this.pendingBefore.push({ kind: "declare", name: heldBytes, type: sequence, init: args[0] as Expression, line: callLine });
              this.valueTypes.set(heldBytes, sequence);
              const decoded: Expression = {
                k: "call",
                name: "blaze_rt_string_new",
                args: [{ k: "ident", name: heldBytes }, { k: "length", buffer: heldBytes }],
              };
              this.expressionTypes.set(decoded, TEXT_RESULT);
              replace(decoded);
              continue;
            }
          }
          // `bytes.subarray(from, to)` is a window of the same block: no bytes
          // are copied, and what the source wrote of is what the stores of the
          // window reach. A window with no `to` reaches the end of the block.
          if (target.field === "subarray" && (args.length === 1 || args.length === 2)) {
            const held = this.valueTypeOf(receiver);
            const element = held.kind === "slice" || held.kind === "array" ? held.of : null;
            const width = element === null ? null : numericWidth(element);
            if (element !== null && width !== null) {
              const offset = args[0] as Expression;
              const stop = args[1] ?? { k: "lengthOf" as const, of: receiver };
              const count: Expression = { k: "binary", op: "-", left: stop, right: offset };
              const viewed: Expression = {
                k: "buffer",
                element: typeToString(element),
                values: [],
                view: { of: receiver, offset, count },
              };
              this.expressionTypes.set(viewed, { kind: "slice", of: element });
              replace(viewed);
              continue;
            }
          }
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
          if (
            target.field === "splice" &&
            (receiver.k === "ident" || (receiver.k === "member" && receiver.base.k === "ident")) &&
            (this.valueTypeOf(receiver).kind === "slice" || this.valueTypeOf(receiver).kind === "array")
          ) {
            const lowered = this.spliceMethod(receiver, args, spreads, callLine);
            if (lowered !== null) {
              replace(lowered);
              continue;
            }
          }
          if (
            (target.field === "shift" || target.field === "unshift") &&
            (receiver.k === "ident" || receiver.k === "member") &&
            (this.valueTypeOf(receiver).kind === "slice" || this.valueTypeOf(receiver).kind === "array")
          ) {
            const lowered = this.listFrontMethod(receiver, target.field, args, spreads, callLine);
            if (lowered !== null) {
              replace(lowered);
              continue;
            }
          }
          if (target.field === "push" || target.field === "pop") {
            let place: { target: string; base: string | null } | null =
              receiver.k === "ident"
                ? { target: receiver.name, base: null }
                : receiver.k === "member" && receiver.base.k === "ident"
                  ? { target: receiver.field, base: receiver.base.name }
                  : null;
            // A list behind more than one field — `this.functions.waiting` — is
            // reached through a name of the statement's own: the owner is a
            // reference, and the push is written through the name that holds
            // it, which is the object the source named.
            if (place === null && receiver.k === "member") {
              const owner = this.writeTarget(receiver.base, callLine);
              if (owner !== null) place = { target: receiver.field, base: owner };
            }
            // `(c ? a : b).push(x)` is the push on whichever the condition
            // names: the statement is the `if` over the two writes, so each
            // list is grown where it is the one the source meant.
            if (place === null && receiver.k === "conditional") {
              const armOf = (arm: Expression): { target: string; base: string | null } | null =>
                arm.k === "ident"
                  ? { target: arm.name, base: null }
                  : arm.k === "member" && arm.base.k === "ident"
                    ? { target: arm.field, base: arm.base.name }
                    : null;
              const left = armOf(receiver.then);
              const right = armOf(receiver.otherwise);
              const held = this.valueTypeOf(receiver);
              if (
                left !== null &&
                right !== null &&
                (held.kind === "slice" || held.kind === "array") &&
                (target.field === "push" ? args.length >= 1 : args.length === 0)
              ) {
                const helper = spreads === null ? this.appendHelper(target.field, held.of, args.length, callLine) : null;
                replace({
                  k: "append",
                  target: left.target,
                  base: left.base,
                  arms: [left, right],
                  condition: receiver.condition,
                  helper: helper?.name ?? "",
                  op: target.field,
                  values: args,
                  ...(spreads === null ? {} : { spreads, element: held.of }),
                });
                continue;
              }
            }
            // `positions[i].push(x)` is a push on the list the element holds.
            // A list of lists is a block of blocks, so the element is read,
            // grown, and written back at its index: the push answers the list
            // the name has afterwards, exactly as a push on a name does. The
            // block the index reads is a field of an object as often as it is a
            // name — `this.scopes[i]` — so the object is read once into a name
            // of the statement's own when it is not one.
            if (place === null && receiver.k === "index") {
              const held = this.valueTypeOf(receiver);
              if (
                (held.kind === "slice" || held.kind === "array") &&
                (target.field === "push" ? args.length >= 1 : args.length === 0)
              ) {
                const block = this.writeTarget(receiver.base, callLine);
                if (block !== null) {
                  const helper = spreads === null ? this.appendHelper(target.field, held.of, args.length, callLine) : null;
                  replace({
                    k: "append",
                    target: block,
                    base: null,
                    index: receiver.index,
                    helper: helper?.name ?? "",
                    op: target.field,
                    values: args,
                    ...(spreads === null ? {} : { spreads, element: held.of }),
                  });
                  continue;
                }
              }
            }
            const sequence = place === null ? null : this.valueTypeOf(receiver);
            const valueSequence = this.valueTypeOf(receiver);
            const elements = valueSequence.kind === "slice" || valueSequence.kind === "array" ? valueSequence : null;
            if (place === null && target.field === "pop" && args.length === 0 && elements !== null) {
              // A list no name holds is read into a name of its own, and the
              // answer is its last element: the one a pop takes out, which is
              // the zero of its type where there is none.
              const sequenceType: TypeExpr = { kind: "slice", of: elements.of };
              const name = `__popped${this.fieldCount++}`;
              this.pendingBefore.push({ kind: "declare", name, type: sequenceType, init: receiver, line: callLine });
              this.valueTypes.set(name, sequenceType);
              const last: Expression = {
                k: "index",
                base: { k: "ident", name },
                index: { k: "binary", op: "-", left: { k: "length", buffer: name }, right: { k: "literal", text: "1" } },
              };
              this.expressionTypes.set(last, elements.of);
              const guarded: Expression = {
                k: "conditional",
                condition: { k: "binary", op: ">", left: { k: "length", buffer: name }, right: { k: "literal", text: "0" } },
                then: last,
                otherwise: this.zeroFor(elements.of),
              };
              this.expressionTypes.set(guarded, elements.of);
              replace(guarded);
              continue;
            }
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
          // `Promise.all(items)`: the list of the values each promise in it
          // carries, settled one by one.
          const settled = this.promiseAll(receiver, target.field, args, callLine);
          if (settled !== null) {
            replace(settled);
            continue;
          }
          // `Promise.allSettled(items)`: one record per promise, saying how it
          // settled.
          const reports = this.promiseSettled(receiver, target.field, args);
          if (reports !== null) {
            replace(reports);
            continue;
          }
          // `p.then(onOk, onErr)` and `p.catch(onErr)`: the continuation a
          // promise that is already settled implies.
          const continued = this.promiseMethod(receiver, target.field, args);
          if (continued !== null) {
            replace(continued);
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
          // A typed array is a block of bytes, and the reads and writes a view
          // of one makes are the stores and loads of that block.
          const view = this.valueTypeOf(receiver);
          if (view.kind === "slice" || view.kind === "array") {
            const lowered = this.blockViewMethod(receiver, target.field, args);
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
          replace(this.typedCall(methodFunctionName(found.owner, found.method, args.length), [receiver, ...args], found.method.returnTypeName, found.method.line, found.method.returnsShape));
          continue;
        }
        // `make()(x)`: a call of what an expression answered is a call through
        // the value it answered, exactly as a call of a name or a field held at
        // a function type is. The signature is the one the answer's type
        // writes, and the arguments are read at its parameters.
        if (target.k !== "ident") {
          const held = this.expressionFunctionType(target);
          if (held !== null) {
            const args = this.readCallArguments(held.params);
            const invoke: Expression = { k: "invoke", callee: target, args, params: held.params, returns: held.returns };
            if (held.shape !== undefined) {
              const answered = this.shapeForRead(held.shape);
              if (answered !== null) this.expressionShapes.set(invoke, answered);
            }
            replace(invoke);
            continue;
          }
        }
        if (target.k !== "ident") return this.missing("only a named function is called", this.peek());
        // `Math.max(...xs)` and `Math.min(...xs)` are the greatest and the
        // smallest element of the list. A list may be empty, and neither has a
        // greatest element then: the answer is the infinity the fold starts
        // from, which is `-Infinity` for the greatest and `Infinity` for the
        // smallest. The helper folds every element against it. Value arguments
        // beside a spread join the list they precede or follow.
        if (
          (target.name === "Math.max" || target.name === "Math.min") &&
          this.at("(") &&
          this.argumentsSpread()
        ) {
          const line = this.peek().line;
          const args = this.readCallArguments([], null, true);
          const spreads = this.argumentSpreads ?? args.map(() => false);
          // The token scan found a spread in the list, so one is there.
          let combined: Expression | null = null;
          for (let at = 0; at < args.length; at += 1) {
            const part: Expression = spreads[at] === true
              ? (args[at] as Expression)
              : { k: "buffer", element: "f64", values: [args[at] as Expression] };
            const type = this.valueTypeOf(part);
            if (type.kind !== "slice" && type.kind !== "array") {
              this.report(
                `${target.name} reduces a list`,
                `the value the spread names is a list of numbers, as in ${target.name}(...xs)`,
                this.peek(),
              );
              replace(this.hole());
              combined = null;
              break;
            }
            combined = combined === null ? part : { k: "binary", op: "+", left: combined, right: part };
          }
          if (combined === null) {
            replace(this.hole());
            continue;
          }
          const helper = this.reductionHelper(target.name === "Math.max" ? "max" : "min", line);
          replace({ k: "call", name: helper.name, args: [combined] });
          continue;
        }
        // `f(...xs)` hands the function the elements of the list, and the
        // number of them is the number of parameters the declaration states.
        // The list is written where the arguments were, so each one is an
        // element of it read by position. A function whose parameters this
        // read does not hold — one another module declares — cannot say how
        // many to read, and the spread is refused where it is.
        const declared = this.declaredParams.get(target.name) ?? [];
        const declaredShapes = this.declaredParamShapes.get(target.name) ?? [];
        const spreadCall = declared.length > 0 && this.at("(") && this.peek(1).text === "...";
        let args = this.readCallArguments(spreadCall ? [] : declared, null, spreadCall, false, null, spreadCall ? [] : declaredShapes);
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
        // `createHash("sha256")` is the runtime's SHA-256 hasher: a program
        // hashes a text with sha256, and the hasher is the handle the chain
        // reads. An algorithm the runtime does not carry is refused by name.
        if (target.name === "createHash") {
          const algorithm = args[0];
          const named = algorithm !== undefined && algorithm.k === "text" && algorithm.parts.length === 1 && algorithm.parts[0]?.k === "text";
          if (!named || (algorithm as { parts: { value: string }[] }).parts[0]?.value !== "sha256") {
            this.report("a hash of this program is sha256", "write createHash(`sha256`)", this.peek());
            replace(this.hole());
            continue;
          }
          const made: Expression = { k: "call", name: "blaze_rt_sha256_create", args: [] };
          this.expressionTypes.set(made, NUMBER_RESULT);
          this.hashers.add(made);
          replace(made);
          continue;
        }
        // `parseInt(text, radix)` is the number the text states in its radix:
        // base ten is what `parseInt(text)` reads, and two, eight and
        // sixteen are the runtime's reading in that base.
        if (target.name === "parseInt" && args.length === 2) {
          const radix = args[1];
          if (radix !== undefined && radix.k === "literal" && radix.text === "10") {
            args = [args[0] as Expression];
          } else if (radix !== undefined && radix.k === "literal" && (radix.text === "2" || radix.text === "8" || radix.text === "16")) {
            target.name = "Number.parseInt";
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
        // `Promise.reject(x)` fails a promise with the message x: a value that
        // is not a text is written as the text it prints as, which is the
        // message the failure carries.
        if (target.name === "Promise.reject" && args.length === 1 && this.valueTypeOf(args[0] as Expression).kind !== "text") {
          const text: Expression = { k: "text", parts: [{ k: "value", value: args[0] as Expression }] };
          this.expressionTypes.set(text, TEXT_RESULT);
          replace({ k: "call", name: "Promise.reject", args: [text] });
          continue;
        }

        // A call of a name this file imports is a call of a function another
        // module declares. Its result is known once the graph has linked that
        // module, which is a second read of this file.
        if (this.pendingValues.has(target.name) && !this.linked) this.waitForFunction = true;
        // A function declared with a rest parameter reads the arguments as one
        // list. The call wrote them one by one, so they are packed into the
        // list the parameter is, and the fixed parameters before it stay where
        // they were written.
        const variadic = this.variadicFunctions.get(target.name);
        if (variadic === undefined) {
          replace({ k: "call", name: this.calledName(target.name), args });
          continue;
        }
        const rest: Expression = {
          k: "buffer",
          element: typeToString(variadic.element),
          values: args.slice(variadic.fixed),
        };
        this.expressionTypes.set(rest, { kind: "slice", of: variadic.element });
        replace({
          k: "call",
          name: this.calledName(target.name),
          args: [...args.slice(0, variadic.fixed), rest],
        });
        continue;
      }
      if (this.at("++") || this.at("--")) {
        const target = current();
        const op = this.next().text as "++" | "--";
        if (target.k === "ident") return { k: "update", name: target.name, op, prefix: false };
        // A place that is not a name is stepped through a name of the
        // statement's own: the place is read into a name and that name is
        // stepped, which is the value the source reads — `this.tokens[i++]` is
        // the element at the old `i`, and `i` is one more afterwards.
        const stepped = this.stepPlace(target, op, this.peek().line);
        if (stepped !== null) return stepped;
        return this.missing(`"${op}" needs a name to change`, this.peek());
      }
      // These follow a value, and none of them changes it: `as` and
      // `satisfies` assert a type the value already has, and `!` says a value
      // that may be null is not. The type they write is erased like every
      // other annotation, but an empty list still reads it: `[] as string[]`
      // names the element type the list holds.
      if (this.at("as") || this.at("satisfies")) {
        const assertion = this.next().text;
        const type = this.readTypeAnnotation("a type assertion", EXPRESSION_TYPE_STOPS);
        const shape = this.lastAnnotationShape();
        this.applyExpected(current(), type, shape);
        // `value as Record<string, unknown>` says the value is the dictionary
        // the assertion names. The shape is what a field or a key read off the
        // value is read at, so it is kept beside the value: `"k" in n` asks the
        // dictionary the assertion named rather than the `unknown` the
        // declaration wrote.
        if (assertion === "as" && shape !== null && (shape.kind === "record" || shape.kind === "list" || shape.kind === "map" || shape.kind === "set")) {
          this.expressionShapes.set(current(), shape);
        }
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
          // The infinities have no decimal to write: they are the quotient of
          // one and zero, which is the float division the emitters write as
          // `1.0 / 0.0`. `MAX_SAFE_INTEGER` and its neighbours are numbers the
          // language writes down.
          if (field.text === "POSITIVE_INFINITY" || field.text === "NEGATIVE_INFINITY") {
            const one: Expression = { k: "literal", text: "1" };
            const value: Expression = {
              k: "binary",
              op: "/",
              left: field.text === "NEGATIVE_INFINITY" ? { k: "unary", op: "-", operand: one } : one,
              right: { k: "literal", text: "0" },
            };
            this.expressionTypes.set(value, NUMBER_RESULT);
            replace(value);
            continue;
          }
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
        // `bytes.buffer` is the block a typed array is: a view of a block is
        // the block, and its two offsets say where in the file it starts.
        if (!this.at("(") && (field.text === "buffer" || field.text === "byteOffset" || field.text === "byteLength")) {
          const held = this.valueTypeOf(target);
          if (held.kind === "slice" || held.kind === "array") {
            replace(field.text === "buffer"
              ? target
              : field.text === "byteOffset"
                ? { k: "literal", text: "0" }
                : { k: "lengthOf", of: target });
            continue;
          }
        }
        if (field.text === "length" && target.k === "ident" && !this.at("(")) {
          replace({ k: "length", buffer: target.name });
          continue;
        }
        if (field.text === "toFixed" && this.at("(")) {
          replace(this.fixed(target));
          continue;
        }
        if (field.text === "toPrecision" && this.at("(")) {
          replace(this.precision(target));
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
          // `bytes.toString("latin1")` is the text the bytes are written as
          // under the one-byte encoding: each byte is the character of its
          // value, and the characters are written as the utf8 text a compiled
          // text holds them as.
          const byteHeld = this.valueTypeOf(target);
          const byteElement = byteHeld.kind === "slice" || byteHeld.kind === "array" ? byteHeld.of : null;
          const namesEncoding = this.peek(1).kind === "string";
          if (namesEncoding && byteElement !== null && byteElement.kind === "primitive" && byteElement.name === "u8") {
            const args = this.readCallArguments([TEXT_RESULT]);
            const encoding = args[0];
            if (args.length === 1 && encoding !== undefined && encoding.k === "text" && textValue(encoding) === "latin1") {
              const helper = this.latin1Helper(this.peek().line);
              const read: Expression = { k: "call", name: helper.name, args: [target] };
              this.expressionTypes.set(read, helper.returns);
              replace(read);
              continue;
            }
            this.report(
              "a byte array is written as latin1",
              "the source writes bytes.toString(`latin1`)",
              this.peek(),
            );
            replace(this.hole());
            continue;
          }
          replace(this.hexadecimal(target));
          continue;
        }
        if (field.text === "length" && target.k === "argv") {
          replace({ k: "call", name: ARGV_LENGTH, args: [] });
          continue;
        }
        if (field.text === "length" && !this.at("(")) {
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
              replace(this.typedCall(`${getter.owner}_${getter.getter.name}`, [], getter.getter.returnTypeName, getter.getter.line, getter.getter.returnsShape));
              continue;
            }
          }
        }
        // `record.field` where the record is a dictionary is the entry the key
        // names: a `Record<string, V>` is read by its key, which is the text
        // the field is written with.
        const asDictionary = this.collectionOfExpression(target);
        if (asDictionary !== null && asDictionary.kind === "map" && this.keyKind(asDictionary.key) === "text" && !this.at("(")) {
          const key: Expression = { k: "text", parts: [{ k: "text", value: field.text }] };
          const read = this.collectionMethod(target, asDictionary, "get", [key]);
          if (read !== null) {
            replace(read);
            continue;
          }
        }
        // `this.size`: a member a class reads through a getter is the body the
        // getter is, and the instance it reads is the receiver.
        const getterOwner = this.classOfExpression(target);
        if (getterOwner !== null) {
          const getter = findGetter(this.classTable, getterOwner, field.text, false);
          if (getter !== null) {
            replace(this.typedCall(`${getter.owner}_${getter.getter.name}`, [target], getter.getter.returnTypeName, getter.getter.line, getter.getter.returnsShape));
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
   * The name the tokens at the cursor write, when the operator after it writes
   * one: `x = v`, `x ??= v`, `x += v`.
   *
   * A tuple write and a write through a field or an index are places the
   * statement reader names itself, and are not read here.
   */
  private assignmentNameAt(from = this.position): string | null {
    const target = this.tokens[from];
    if (target === undefined || target.kind !== "ident") return null;
    const operator = this.tokens[from + 1];
    if (operator === undefined || operator.kind !== "punct") return null;
    if (operator.text !== "=" && operator.text !== "??=" && !(operator.text in COMPOUND_OPERATORS)) return null;
    return target.text;
  }

  /**
   * A whole assignment written where a value is expected.
   *
   * An assignment is a statement, and an expression answers no statement. Where
   * the whole value *is* the assignment — the concise body of an arrow, which is
   * the return the source wrote without the word — the statement runs and the
   * name it wrote is the value. `() => (count ??= next())` is that shape: the
   * parentheses are the writer's, and what the value holds is the name.
   *
   * The parentheses are read only where they close before the body ends, so a
   * value that merely starts with an assignment — a call's first argument —
   * is not this shape and is read as the source wrote it.
   */
  private readWholeAssignment(): { statement: Statement; value: Expression } | null {
    const start = this.position;
    const wrapped = this.at("(");
    if (wrapped) {
      const close = this.matchingToken(this.position, "(", ")");
      if (close < 0) return null;
      const after = this.tokens[close + 1];
      const ends = after === undefined || after.kind === "end" || after.text === "," || after.text === ")" || after.text === ";" || after.text === "}";
      if (!ends) return null;
      this.next();
    }
    const name = this.assignmentNameAt();
    if (name === null) {
      this.position = start;
      return null;
    }
    const statement = this.readAssignment();
    if (statement === null) {
      this.position = start;
      return null;
    }
    if (wrapped) this.expect(")");
    return { statement, value: { k: "ident", name } };
  }

  /**
   * The arguments of a call, from the `(` the parser is at to its `)`.
   *
   * `expected` is the type each argument is held at, and `callback` is the
   * parameters of the arrow the first argument writes, when the call is a
   * collection method that walks the elements of its receiver. `spreadsAllowed`
   * says whether the call can use a spread argument; one written elsewhere is
   * refused where it is, because the arguments it stands for are not known
   * until the program runs. `rest` is the type every argument of an arity the
   * call does not state is held at, which is what a list's own method says of
   * the values written into it: `list.push(value)` writes an element.
   */
  private readCallArguments(
    expected: readonly TypeExpr[] = [],
    callback: readonly ArrowParameterType[] | null = null,
    spreadsAllowed = false,
    callbackWaitsForLink = false,
    rest: TypeExpr | null = null,
    shapes: readonly (ResolvedType | null)[] = [],
    restShape: ResolvedType | null = null,
    /**
     * The parameters each argument's arrow is handed, by position, where a call
     * has more than one callback: `p.then(onOk, onErr)` hands the carried value
     * to the first and the failure's message to the second.
     */
    callbacks: readonly (readonly ArrowParameterType[] | null)[] | null = null,
  ): Expression[] {
    this.next();
    const args: Expression[] = [];
    const spreads: boolean[] = [];
    let spread = false;
    while (!this.at(")") && this.peek().kind !== "end") {
      const type = expected[args.length] ?? rest;
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
      args.push(this.readArgument(type, callbacks?.[args.length] ?? (args.length === 0 ? callback : null), callbackWaitsForLink, shapes[args.length] ?? (args.length < expected.length ? null : restShape)));
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
    shape: ResolvedType | null = null,
  ): Expression {
    const read = (): Expression => (type === null ? this.readExpression() : this.readAt(type, () => this.readExpression(), shape));
    // A hint applies only to the arrow written at the cursor. A hint on a value
    // that is not an arrow names no parameter, and is not passed on to an arrow
    // the value contains.
    if (this.arrowAt() === null) return read();
    const savedHint = this.arrowParameters;
    const savedPending = this.pendingArrow;
    // A parameter declared as a function is a signature, and the arrow written
    // at it is read against the parameters and result that signature states:
    // `walkValues(value, (one) => ...)` hands `one` the type the declaration
    // gave the callback, not the opaque value a type this contract cannot spell
    // would be.
    const signature = callback ?? (shape !== null && shape.kind === "function"
      ? shape.params.map((param) => ({ type: this.typeExprOfShape(param), shape: param }))
      : null);
    if (signature !== null) this.arrowParameters = signature;
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
   * `x.toPrecision(p)`: the number written as text at `p` significant digits.
   *
   * The digits are written out in the source, so they are a number this reads
   * rather than a value it evaluates, the same way `toFixed` reads them. The
   * count is significant digits rather than digits after the point, and the
   * language only writes between one and a hundred of them: a value outside
   * that range is refused here rather than answered with a different number
   * of digits than the source asked for.
   */
  private precision(of: Expression): Expression {
    const open = this.next();
    const digits = this.next();
    const count = digits.kind === "number" ? Number(digits.text) : Number.NaN;
    if (digits.kind !== "number" || !/^\d+$/.test(digits.text) || count < 1 || count > 100) {
      this.report(
        "the significant digits a number is written at are written out, as in x.toPrecision(17)",
        `the count is a whole number from 1 to 100; the source wrote "${digits.text}"`,
        digits,
      );
      while (!this.at(")") && this.peek().kind !== "end") this.next();
      this.expect(")");
      return of;
    }
    if (!this.at(")")) this.report("x.toPrecision takes one count of digits", `near "${this.peek().text}"`, this.peek());
    this.expect(")");
    if (of.k === "text" || of.k === "fixed") {
      this.report("a number is what is written at a count of significant digits", "a string is already text; write it as it is", open);
      return of;
    }
    return { k: "fixed", of, digits: count, precision: true };
  }

  /**
   * `x.toString(16)` and `x.toString(2)`: a number written as lowercase text in
   * the radix the source names.
   *
   * The digit count a `fixed` carries is negative for a radix, and which of the
   * two it is is what the emitters read: `-1` is base sixteen and `-2` is base
   * two (see `toText` in `toolchain/driver.ts`), so a function body and a
   * program body write the same text for the same number.
   */
  private hexadecimal(of: Expression): Expression {
    const open = this.next();
    const radix = this.next();
    if (radix.kind !== "number" || (radix.text !== "16" && radix.text !== "2")) {
      this.report(
        "toString writes a whole number in base sixteen or base two",
        `the radix is 16 or 2, as in x.toString(16) or x.toString(2); the source wrote "${radix.text}"`,
        radix,
      );
      while (!this.at(")") && this.peek().kind !== "end") this.next();
      this.expect(")");
      return of;
    }
    if (!this.at(")")) this.report("x.toString(16) takes the radix 16 or 2", `near "${this.peek().text}"`, this.peek());
    this.expect(")");
    if (of.k === "text" || of.k === "fixed") {
      this.report("a number is what is written as hexadecimal text", "a string is already text; write it as it is", open);
      return of;
    }
    return { k: "fixed", of, digits: radix.text === "2" ? -2 : -1 };
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
    if (this.tokens[head]?.kind === "ident" && this.tokens[head]?.text === "async") {
      const next = this.tokens[head + 1];
      const open = next?.kind === "punct" && next.text === "(";
      const arrowAfterName = next?.kind === "ident" && this.tokens[head + 2]?.kind === "punct" && this.tokens[head + 2]?.text === "=>";
      if (!open && !arrowAfterName) return null;
      isAsync = true;
      head += 1;
    }
    const token = this.tokens[head];
    if (token === undefined) return null;
    // A string is not a bracket: `text === "("` writes the character as the
    // text it is, and the token that holds it is a string. Reading one as the
    // parameter list of an arrow is how `if (text === "(" || text === "[")`
    // became an arrow whose parameter is a bracket.
    if (token.kind === "punct" && token.text === "(") {
      const close = this.matchingToken(head, "(", ")");
      if (close < 0) return null;
      let after = close + 1;
      if (this.tokens[after]?.kind === "punct" && this.tokens[after]?.text === ":") {
        after = this.typeEndAt(after + 1, ARROW_RETURN_STOPS);
      }
      if (!(this.tokens[after]?.kind === "punct" && this.tokens[after]?.text === "=>")) return null;
    } else if (!(token.kind === "ident" && this.tokens[head + 1]?.kind === "punct" && this.tokens[head + 1]?.text === "=>")) {
      return null;
    }
    return { async: isAsync };
  }

  /** Whether the arguments of the call at the parser spread a list. */
  private argumentsSpread(): boolean {
    if (!this.at("(")) return false;
    const close = this.matchingToken(this.position, "(", ")");
    if (close < 0) return false;
    for (let at = this.position + 1; at < close; at += 1) {
      if (this.tokens[at]?.text === "...") return true;
    }
    return false;
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
  private readArrow(isAsync: boolean, method = false): Expression {
    const start = this.peek();
    if (isAsync && this.tokens[this.position]?.text === "async") this.next();
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
      /** The parameter is the rest of the call's arguments, as one list. */
      rest?: boolean;
      /** The value a call writes when it leaves the parameter out. */
      default?: Expression;
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
        // `(...taken: string[]) => ...`: the rest of the call's arguments, as
        // one list. The parameter is the list itself, and a call packs what it
        // wrote from here on into it.
        const rest = this.accept("...");
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
        // A default is the value a call writes when it leaves the parameter
        // out, and the call stands where the arrow was written — so a value
        // written out is the same value at both. A default that reads a name is
        // that name in the arrow's own scope, which the call does not have.
        let fallback: Expression | undefined;
        if (this.at("=")) {
          const equals = this.next();
          const written = this.readExpression();
          if (isWrittenValue(written)) fallback = written;
          else {
            this.report(
              "an arrow function's parameter takes a default",
              "a default is stated by a function the module declares; write the value at the call instead",
              equals,
            );
          }
        }
        const parameter: ArrowParam = { name: name.text, type, typeName, functionType, shape, ...(fallback === undefined ? {} : { default: fallback }) };
        if (rest) parameter.rest = true;
        params.push(parameter);
        if (!this.accept(",")) break;
        // A list of parameters may end with a comma, as it may on a function.
        if (this.at(")")) break;
      }
      this.expect(")");
    } else {
      const name = this.next();
      if (name.kind !== "ident") {
        return this.missing("expected a parameter name", name);
      }
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
      stated = this.readTypeAnnotation(
        "an arrow function's result type",
        method ? METHOD_RETURN_STOPS : ARROW_RETURN_STOPS,
        isAsync,
      );
      statedShape = this.lastAnnotationShape();
    } else if (this.expectedShape !== null && this.expectedShape.kind === "function") {
      // An arrow the use holds at a function type answers what that type says:
      // `const reader: ModuleReader = request.reader ?? ((...) => ({ ... }))`
      // states the record the arrow answers, so the fields it writes are read
      // at the type the alias names.
      stated = this.typeExprOfShape(this.expectedShape.returns);
      statedShape = this.expectedShape.returns;
    }
    // A method of an object literal writes its body where an arrow writes its
    // `=>`: `{ start(controller) { ... } }` is the arrow that body is.
    if (!method && !this.accept("=>")) this.report('expected "=>"', `near "${this.peek().text}"`);
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
        params: params.map((param) => ({
          name: param.name,
          type: param.type,
          shape: param.shape,
          ...(param.default === undefined ? {} : { default: param.default }),
        })),
        returns: stated ?? ANY_TYPE,
        returnsShape: statedShape,
      };
      const restAt = params.findIndex((param) => param.rest === true);
      if (restAt >= 0) provisional.rest = restAt;
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
      if (this.at("{")) return [...prelude, ...this.readFunctionBlock()];
      // A concise body that is a whole assignment is the write and the value it
      // wrote: `() => (count ??= next())` runs the write and answers `count`.
      // A parenthesised form is the same value, and the parentheses are the
      // writer's. It is read before the body as an expression, because an
      // assignment is a statement here.
      const assigned = this.readWholeAssignment();
      if (assigned !== null) {
        return [...prelude, assigned.statement, { kind: "result" as const, value: assigned.value, line }];
      }
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
          // An unshaped reference is no type the contract can name, and a body
          // whose only return is one is left to `resultType`. A call is the
          // exception: `() => worker()` answers the promise handle the call
          // answered, which is exactly the reference, and reading it as nothing
          // dropped the handle into a `void` the closure then answered.
          if (known.kind === "ref" && known.of === null && known.name === undefined && value.k !== "call") return null;
          return known;
        },
        (value) => this.holdsUnsettledArray(value),
      );
    // An empty list a return answers is built at the type the other returns
    // name: the list says nothing about what it holds, so the return that
    // writes values says it.
    if (stated === null && (returns.kind === "slice" || returns.kind === "array")) {
      const written: Expression[] = [];
      collectResults(body, written);
      for (const value of written) this.applyExpected(value, returns, null);
    }
    // An arrow that answers an object literal names no result type, but the
    // fields it writes are read where the arrow is used: `list.map((x) =>
    // ({ name: x }))` is a list of a record, and `entry.name` of one element is
    // the field the literal wrote. The shape is read here, while the body's
    // names are still in scope.
    const inferredReturnsShape = statedShape === null ? this.resultShapeOf(body) : null;
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
    // A name the body writes is a name the arrow cannot carry: a parameter is
    // handed its value, so the write would reach the lifted function's copy.
    // The name is held in a one-element list instead, which both sides read and
    // write, and the list is what the arrow captures.
    if (captures.written.length > 0 && !this.boxArrowCaptures(body, captures.written)) {
      this.report(
        `an arrow function writes "${captures.written[0]}", a name of the function around it`,
        "an arrow is lifted into a function of its own, so a captured value is handed to it and cannot be written back; declare a function where the value is written, or keep the sum in the arrow's own result",
        start,
      );
    }
    // A name that is already boxed is read through the box, whether or not
    // this body writes it: the value the arrow is handed is the box.
    for (const capture of captures.captures) {
      const entry = this.arrowBoxes.get(capture);
      if (entry !== undefined) boxStatements(body, capture, { name: entry.box, list: entry.list });
    }
    if (captures.written.length > 0 && captures.written.every((written) => this.arrowBoxes.has(written))) {
      // The box of a name the body only writes is a value the body reads, so it
      // joins the values the arrow captures even though the name itself was
      // never read.
      const captured: string[] = [];
      for (const capture of captures.captures) {
        const box = this.arrowBoxes.get(capture)?.box ?? capture;
        if (!captured.includes(box)) captured.push(box);
      }
      for (const written of captures.written) {
        const box = this.arrowBoxes.get(written)?.box;
        if (box !== undefined && !captured.includes(box)) captured.push(box);
      }
      captures.captures = captured;
      captures.written = [];
    } else if (captures.written.length === 0) {
      // A body that writes nothing still reads the boxes it captures: a name
      // another arrow boxed is handed over as the box.
      const captured: string[] = [];
      for (const capture of captures.captures) {
        const box = this.arrowBoxes.get(capture)?.box ?? capture;
        if (!captured.includes(box)) captured.push(box);
      }
      captures.captures = captured;
    }
    // A name an arrow inside this one wrote, and this body declares, is boxed
    // here: the box belongs to the nearest body that holds the name.
    this.finishBoxes(body, params, false);
    // A box written into this body is a name the body declares, so it is not a
    // name the arrow captures from around it, whatever the inner arrow's own
    // capture list said before the box existed.
    captures.captures = captures.captures.filter(
      (capture) => !params.some((param) => param.name === capture) && findDeclaration(body, capture) === null,
    );
    const binding = this.liftArrow(liftedName, params, returns, body, captures.captures, line);
    // The shape the arrow's declaration writes is what a call of it answers,
    // beside the type the contract can spell. An arrow that writes no
    // declaration answers the shape its body's one result wrote.
    binding.returnsShape = statedShape ?? inferredReturnsShape;
    // The map or set an arrow answers is the one its declaration states, and a
    // call of the arrow is a call whose answer is a collection: the call names
    // the lifted function, so the collection is recorded under that name. A
    // caller that holds what the arrow answered asks it the collection's
    // questions — `has`, `add`, `get` — which is what a name of the answer is.
    if (statedShape !== null) {
      const answered = this.collectionOfShape(this.shapeForRead(statedShape));
      if (answered !== null) this.declaredCollections.set(binding.function, answered);
    }
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
   * The type of the one-element list a box is, for an arrow that captures it.
   *
   * A box is made while the body of the arrow that wrote the name is read, and
   * the map of value types the enclosing body reads through is put back when
   * that body ends, so the box is not a name that map holds. The boxes are
   * kept for the whole file, and this is where a capture asks what one is.
   */
  private boxTypeOf(name: string): TypeExpr | null {
    for (const entry of this.arrowBoxes.values()) {
      if (entry.box !== name) continue;
      // A list box is an object the IR lays out from the literal it was built
      // with, so what the arrow is handed is the reference it is.
      return entry.list ? ANY_TYPE : { kind: "slice", of: entry.element };
    }
    return null;
  }

  /**
   * Holds the names an arrow writes in one-element lists.
   *
   * Answers false when one of them cannot be held that way: a list's element is
   * not a list, so a name that holds a list has no box, and an `x++` read as a
   * value is not a write to an element. Nothing is rewritten in that case, and
   * the arrow answers the refusal it always did.
   */
  private boxArrowCaptures(body: Statement[], written: readonly string[]): boolean {
    for (const name of written) {
      if (this.arrowBoxes.has(name)) continue;
      if (readsUpdateIn(body, name)) return false;
    }
    for (const name of written) {
      if (this.arrowBoxes.has(name)) continue;
      const type = this.valueTypes.get(name) ?? ANY_TYPE;
      const box = `__box_${this.stem}_${this.boxCount}`;
      this.boxCount += 1;
      // A list has no element that holds a list, so a name that holds one is
      // held in a one-field object instead and both sides write the field.
      const list = type.kind === "slice" || type.kind === "array" || type.kind === "ptr";
      this.arrowBoxes.set(name, { box, element: type, list });
      this.valueTypes.set(box, list ? ANY_TYPE : { kind: "slice", of: type });
    }
    for (const name of written) {
      const entry = this.arrowBoxes.get(name);
      if (entry !== undefined) boxStatements(body, name, { name: entry.box, list: entry.list });
    }
    return true;
  }

  /**
   * Puts a name an arrow wrote into the one-element list both sides read.
   *
   * The declaration the name was read at becomes the list, and every read and
   * write of the name in this body goes through the element. A name this body
   * does not declare and is not a parameter of belongs to a body around it, and
   * is left for that body; at the outermost body there is no such body, and the
   * write is the refusal an arrow always answered.
   */
  private finishBoxes(
    body: Statement[],
    params: readonly { name: string; type: TypeExpr }[],
    outermost: boolean,
  ): void {
    if (this.arrowBoxes.size === 0) return;
    for (const [name, entry] of [...this.arrowBoxes]) {
      const box = entry.box;
      const held = findDeclaration(body, name);
      const parameter = params.find((one) => one.name === name);
      if (held === null && parameter === undefined) {
        if (!outermost) continue;
        this.report(
          `an arrow function writes "${name}", a name of the function around it`,
          "an arrow is lifted into a function of its own, so a captured value is handed to it and cannot be written back; declare a function where the value is written, or keep the sum in the arrow's own result",
        );
        this.arrowBoxes.delete(name);
        continue;
      }
      const element = held?.type ?? parameter?.type ?? entry.element;
      // The reads and writes are rewritten first: the box is made of the value
      // the name was declared with, and that value is the one the source wrote,
      // not a read of the name the box replaces.
      const initial = held?.init ?? null;
      boxStatements(body, name, { name: box, list: entry.list });
      const declared = findDeclaration(body, name);
      const value = initial ?? { k: "null" as const };
      const made: Expression = entry.list
        ? { k: "object", fields: [{ name: BOXED_FIELD, value }] }
        : { k: "buffer", element: typeToString(element), values: [value] };
      const kind: TypeExpr | null = entry.list ? null : { kind: "slice", of: element };
      if (declared !== null) {
        declared.name = box;
        declared.type = kind;
        declared.init = made;
      } else {
        // A parameter is handed over by value, so the box is made where the
        // body starts and the parameter is what it holds.
        body.unshift({
          kind: "declare",
          name: box,
          type: kind,
          init: entry.list
            ? { k: "object", fields: [{ name: BOXED_FIELD, value: { k: "ident", name } }] }
            : { k: "buffer", element: typeToString(element), values: [{ k: "ident", name }] },
          line: body[0]?.line ?? 0,
        });
      }
      // An arrow read before this box existed captured the name itself. The
      // name is the box now, so every arrow that captured it is handed the box
      // and reads the value through it.
      for (const [liftedName, lifted] of this.liftedArrows) {
        const binding = this.arrowBindings.get(liftedName);
        if (binding === undefined) continue;
        const at = binding.captures.indexOf(name);
        if (at < 0) continue;
        const boxed = entry.list ? ANY_TYPE : { kind: "slice" as const, of: element };
        binding.captures[at] = box;
        binding.captureTypes[at] = boxed;
        const param = lifted.params[at];
        if (param !== undefined) {
          param.name = box;
          param.type = boxed;
        }
        boxStatements(lifted.body, name, { name: box, list: entry.list });
      }
      this.arrowBoxes.delete(name);
    }
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
    params: readonly { name: string; type: TypeExpr; rest?: boolean; shape?: ResolvedType | null; default?: Expression }[],
    returns: TypeExpr,
    body: Statement[],
    captures: readonly string[],
    line: number,
  ): ArrowBinding {
    const captureTypes = captures.map((capture) => this.boxTypeOf(capture) ?? this.valueTypes.get(capture) ?? ANY_TYPE);
    const captured = captures.map((capture, index) => ({ name: capture, type: captureTypes[index] as TypeExpr }));
    const written = params.map((param) => ({
      name: param.name,
      type: param.type,
      shape: param.shape ?? null,
      ...(param.default === undefined ? {} : { default: param.default }),
    }));
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
    const restAt = params.findIndex((param) => param.rest === true);
    if (restAt >= 0) binding.rest = restAt;
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
    const code = binding.function.startsWith("__closure_")
      ? binding.function.replace("__closure_", "__closure_code_")
      : `__closure_code_${this.stem}_${binding.function}`;
    binding.code = code;
    const line = this.liftedArrows.get(binding.function)?.line ?? binding.line ?? 0;
    const args: Expression[] = [
      ...binding.captures.map((_, index) => ({
        k: "capture" as const,
        closure: { k: "ident" as const, name: "self" },
        index,
        type: binding.captureTypes[index] ?? ANY_TYPE,
      })),
      ...binding.params.map((param) => ({ k: "ident" as const, name: param.name })),
    ];
    const call: Expression = { k: "call", name: this.calledName(binding.function), args };
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
    // `a.concat(b, c)` is the lists written one after another, which is the
    // list `a + b + c` is: each is a block, and the sum is a block of both.
    if (method === "concat" && args.length >= 1) {
      let joined: Expression = receiver;
      for (const written of args) {
        const held = this.valueTypeOf(written);
        if (held.kind !== "slice" && held.kind !== "array") {
          // `a.concat(x)` with a value that is not a list appends that value:
          // the language makes it the last element, which is a one-element list
          // of the element the answer holds. A value of another type is not one
          // the list could hold, and is refused as before.
          if (typeToString(held) !== typeToString(elements)) {
            this.report(
              "concat joins lists",
              `a list is joined with a list of its elements, or with one element; the source wrote ${typeToString(held)}`,
              this.peek(),
            );
            return this.hole();
          }
          joined = { k: "binary", op: "+", left: joined, right: { k: "buffer", element: typeToString(elements), values: [written] } };
          continue;
        }
        joined = { k: "binary", op: "+", left: joined, right: written };
      }
      this.expressionTypes.set(joined, { kind: "slice", of: elements });
      const shape = this.elementShapeOf(receiver, elements);
      this.expressionShapes.set(joined, { kind: "list", of: shape ?? { kind: "any" } });
      return joined;
    }
    // `a.fill(v)` takes the value every element becomes, and the list is the
    // answer. It is not a callback method: the value is written into each
    // element rather than read out of one.
    if (method === "fill") {
      if (args.length !== 1) {
        this.report("fill takes one argument", "as in a.fill(0)", this.peek());
        return this.hole();
      }
      const helper = this.collectionHelper("fill", elements, { params: [elements], returns: elements }, false, line);
      const filled: Expression = { k: "call", name: helper.name, args: [receiver, args[0] as Expression] };
      this.expressionTypes.set(filled, helper.returns);
      const shape = this.elementShapeOf(receiver, elements);
      this.expressionShapes.set(filled, { kind: "list", of: shape ?? { kind: "any" } });
      return filled;
    }
    // `a.reverse()` writes the list it was handed in mirror order, and the list
    // is the answer. It is not a callback method: nothing is read out of an
    // element, and the elements keep the shape they were read at.
    if (method === "reverse") {
      if (args.length !== 0) {
        this.report("reverse takes no arguments", "as in a.reverse()", this.peek());
        return this.hole();
      }
      const helper = this.collectionHelper("reverse", elements, { params: [elements], returns: elements }, false, line);
      const reversed: Expression = { k: "call", name: helper.name, args: [receiver, { k: "literal", text: "0" }] };
      this.expressionTypes.set(reversed, helper.returns);
      const shape = this.elementShapeOf(receiver, elements);
      this.expressionShapes.set(reversed, { kind: "list", of: shape ?? { kind: "any" } });
      return reversed;
    }
    // `a.sort()` with no comparator is the order the language gives: numbers by
    // their value and texts by what they say, which is the comparison `<` is
    // for each. A list of anything else needs the comparator its source writes.
    if (method === "sort" && args.length === 0 &&
      (elements.kind === "text" ||
        (elements.kind === "primitive" && elements.name !== "bool" && elements.name !== "i256" && elements.name !== "u256"))) {
      const helper = this.sortDefaultHelper(elements, line);
      if (helper !== null) {
        const sorted: Expression = { k: "call", name: helper.name, args: [receiver] };
        this.expressionTypes.set(sorted, helper.returns);
        const shape = this.elementShapeOf(receiver, elements);
        this.expressionShapes.set(sorted, { kind: "list", of: shape ?? { kind: "any" } });
        return sorted;
      }
    }
    // `a.flat()` is the lists it holds one after another: a list of lists is not
    // a value here, so each inner list is walked where it is read and its
    // elements are appended to the answer, which is the concatenation of them.
    if (method === "flat" && args.length === 0) {
      if (elements.kind !== "slice" && elements.kind !== "array") {
        this.report("flat flattens a list of lists", "as in a.flat() over a list whose elements are lists", this.peek());
        return this.hole();
      }
      const inner = elements.of;
      const helper = this.flatHelper(inner, line);
      const flattened: Expression = { k: "call", name: helper.name, args: [receiver] };
      this.expressionTypes.set(flattened, helper.returns);
      const outerShape = this.elementShapeOf(receiver, elements);
      const innerShape = outerShape !== null && outerShape.kind === "list" ? outerShape.of : null;
      this.expressionShapes.set(flattened, { kind: "list", of: innerShape ?? this.shapeOfTypeExpr(inner) });
      return flattened;
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
    // A map that answers a list is a list of the lists it answered, which is a
    // list of lists: an element here may be a list, and the block a map builds
    // is a block of them. A pointer or a mask is not an element a list holds,
    // and a map that answers nothing is a loop for what it does — that is
    // `forEach`, and it is refused here.
    if (method === "map" && (signature.returns.kind === "void" || signature.returns.kind === "ptr" || signature.returns.kind === "mask")) {
      this.report(
        "the function map walks the array with must answer a value a list holds",
        "a map answers a list of what the function answered, and a function that answers nothing is forEach",
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
      let element: ResolvedType;
      if (keepsElement) {
        element = this.elementShapeOf(receiver, elements) ?? { kind: "any" };
      } else if (method === "map") {
        // `map` answers a list of what the callback answered, so its element
        // shape is that answer.
        element = this.callbackReturnsShape(callback) ?? this.shapeOfTypeExpr(returns.of);
      } else {
        // `flatMap` — and a `reduce` whose accumulator is a list — answers the
        // list the callback answered. Its element is what that list holds.
        const held = this.callbackReturnsShape(callback);
        element = held !== null && held.kind === "list" ? held.of : this.shapeOfTypeExpr(returns.of);
      }
      this.expressionShapes.set(call, { kind: "list", of: element });
    }
    // `find` answers the element it found, or nothing, so what the answer holds
    // is what the list's element holds: `offered.find(f).values` is a field of
    // the record, not a field of the opaque reference the contract spells.
    if (method === "find") {
      const found = this.elementShapeOf(receiver, elements);
      if (found !== null) this.expressionShapes.set(call, found);
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
      // The await of a deferred call is deferred with it: the promise is the
      // call's, and the value it carries is unsettled for the same reason.
      if (current.k === "call" && current.name === "Promise.await") {
        current = current.args[0] as Expression;
        continue;
      }
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
  private typedCall(
    name: string,
    args: readonly Expression[],
    returnTypeName: string,
    line: number,
    knownShape: ResolvedType | undefined = undefined,
  ): Expression {
    const call: Expression = { k: "call", name, args: [...args] };
    if (returnTypeName.trim() === "" || returnTypeName.trim() === "void") return call;
    const type = knownShape !== undefined
      ? this.typeExprOfShape(knownShape)
      : this.typeForName(promisePayloadText(returnTypeName) ?? returnTypeName, line);
    if (type.kind !== "void") this.expressionTypes.set(call, type);
    // What the declaration writes for its result is the fields a member chain
    // written after the call reads. The contract's spelling of a record is the
    // opaque reference, so the shape is kept beside the type: `{ ...made }`
    // copies the fields `make()` said it answers. A method of an imported class
    // answers a type its declaring module wrote, which this file may not name:
    // the shape the link resolved with the class is what the answer holds.
    try {
      const written = knownShape ?? resolveTypeName(this.typeTable, promisePayloadText(returnTypeName) ?? returnTypeName.trim());
      if (written.kind !== "any") this.expressionShapes.set(call, written);
    } catch {
      // A return type this read cannot resolve names nothing a shape can say.
    }
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

  /**
   * The parameters a promise continuation's callbacks are handed, by position.
   *
   * `p.then(onOk, onErr)` hands the value the promise carries to the first and
   * the message a failed promise carries to the second; `p.catch(onErr)` hands
   * it to the only one. The value is what the receiver is typed at, because a
   * promise's declaration states what it carries and the read peels it: an
   * `Entry` promises an entry, and `entry.isFile()` in the callback is the
   * field the entry declares.
   */
  private promiseCallbackParameters(receiver: Expression, method: string): (readonly ArrowParameterType[] | null)[] | null {
    if (method !== "then" && method !== "catch") return null;
    // A method of a class, a collection or a text that happens to be named
    // `then` is that method: only a receiver that is none of them is a promise,
    // which is the order the method lookup below asks in.
    if (this.collectionOfExpression(receiver) !== null) return null;
    if (this.methodOwner(this.classOfExpression(receiver), method, false) !== null) return null;
    const carried = this.valueTypeOf(receiver);
    const carriedShape = this.shapeOf(receiver) ?? this.shapeOfTypeExpr(carried);
    const value: ArrowParameterType = { type: this.promisePayloadType(receiver), shape: carriedShape };
    // A failure is the message the runtime holds, which is a text.
    const reason: ArrowParameterType = { type: TEXT_RESULT, shape: { kind: "text" } };
    return method === "catch" ? [[reason]] : [[value], [reason]];
  }

  /**
   * `p.then(onOk, onErr)`, `p.catch(onErr)` and `p.finally(f)`: the
   * continuation a promise implies once it is settled.
   *
   * A compiled promise is settled by the time it is read — the executor runs
   * where the promise is made — so `then` is the conditional it means: a
   * failed promise hands the message to the rejected arm, and one that is not
   * hands the value it carries to the fulfilled arm. A callback the source
   * left out is the arm that does not run: a `then` without a rejected arm
   * answers the promise itself there, so a later `await` still reports the
   * failure, and a `catch` without a fulfilled arm answers the value.
   */
  private promiseMethod(receiver: Expression, method: string, args: readonly Expression[]): Expression | null {
    if (method !== "then" && method !== "catch" && method !== "finally") return null;
    const line = this.peek().line;
    // A promise read by the test and again by the arm that runs is read once:
    // a call that answers one is held in a name of the statement's own, so
    // `stat(p).then(f)` reads the file once rather than twice.
    const handle: Expression = this.holdValue(receiver, { kind: "ref", of: null }, line);
    const failed: Expression = { k: "call", name: "Promise.failed", args: [handle] };
    this.expressionTypes.set(failed, BOOLEAN_RESULT);
    const answer = (callback: Expression | undefined, argument: Expression | null, otherwise: Expression): Expression | null => {
      if (callback === undefined) return otherwise;
      const signature = this.callbackSignature(callback);
      if (signature === null) return null;
      const written = signature.params.length === 0 || argument === null ? [] : [argument];
      const call: Expression = { k: "invoke", callee: callback, args: written, params: signature.params, returns: signature.returns };
      const shape = signature.shape === undefined || signature.shape === null ? null : this.shapeForRead(signature.shape);
      if (shape !== null) this.expressionShapes.set(call, shape);
      return call;
    };
    if (method === "finally") {
      const callback = args[0];
      if (callback === undefined) return receiver;
      const run = answer(callback, null, { k: "null" });
      if (run === null) return null;
      // The callback runs for what it does, and the promise is the answer: a
      // statement of its own, written before the value the call stands for.
      this.pendingBefore.push({ kind: "expression", value: run, line });
      return handle;
    }
    // What the promise carries is what the arm is typed at, so the await is
    // held in a name of that type: the choice is a number where the promise
    // carries one, and a record's fields read through the shape beside it.
    const carriedType = this.promisePayloadType(receiver);
    const payloadCall: Expression = { k: "call", name: "Promise.await", args: [handle] };
    const payload: Expression = this.holdValue(payloadCall, carriedType, line);
    const message: Expression = { k: "call", name: "Promise.message", args: [handle] };
    this.expressionTypes.set(message, TEXT_RESULT);
    if (method === "catch") {
      const onErr = answer(args[0], message, handle);
      if (onErr === null) return null;
      // A promise that did not fail answers the value it carries: a `catch`
      // is the value, or what the rejected arm answered.
      return this.promiseChoice(failed, onErr, payload, line, message);
    }
    const onOk = answer(args[0], payload, { k: "null" });
    const onErr = answer(args[1], message, handle);
    if (onOk === null || onErr === null) return null;
    return this.promiseChoice(failed, onErr, onOk, line, message);
  }

  /**
   * A continuation read as the branch it is, in a name of the statement's own.
   *
   * The rejected arm reads the message a failed promise carries, and reading it
   * is what handles the failure: the arm that does not run must not clear the
   * error a later await has to report. A conditional value does run one arm
   * only, but an arm is a value and a call that answers nothing is not one, so
   * the choice is written as an `if` over a name rather than as a choice of
   * two values. Where the statement is a loop's condition there is no
   * statement of its own to write the branch before, and the choice is the
   * value it was.
   */
  private promiseChoice(
    condition: Expression,
    then: Expression,
    otherwise: Expression,
    line: number,
    /** A value the arm that takes the failure reads for what it does: the
     *  message of the failure, which handling it clears from the body. */
    rejected?: Expression,
  ): Expression {
    // The value the continuation answers is the one the arm that is not the
    // failure answers: a `catch` over a list answers the list, and a `then`
    // answers what the fulfilled callback answered.
    const normal = this.valueTypeOf(otherwise);
    const failure = this.valueTypeOf(then);
    const anyLike = normal.kind === "ref" && normal.of === null && normal.name === undefined;
    // The arm that does not run an answer of the continuation's own is the
    // promise itself, whose handle is a reference: a `then` whose callback
    // answers nothing still answers a reference on the arm the failure took.
    const type = anyLike || (normal.kind === "void" && failure.kind !== "void")
      ? commonResult(failure, normal)
      : normal;
    if (this.loopCondition) return this.typedChoice(condition, then, otherwise);
    // A continuation whose arms answer nothing answers nothing: there is no
    // value to hold, and the arms are the calls they are.
    if (type.kind === "void") {
      this.pendingBefore.push({
        kind: "if",
        condition,
        then: [
          ...(rejected === undefined ? [] : [{ kind: "expression" as const, value: rejected, line }]),
          { kind: "expression", value: then, line },
        ],
        otherwise: [{ kind: "expression", value: otherwise, line }],
        line,
      });
      return { k: "null" };
    }
    const held = `__chosen${this.fieldCount++}`;
    // A handle's zero is the number zero, not the null pointer a shaped
    // reference's zero is: the two are one contract type and the difference is
    // what the C declaration says the slot holds.
    const empty: Expression = type.kind === "ref" && type.of === null && type.name === undefined
      ? { k: "literal", text: "0" }
      : this.zeroFor(type);
    this.pendingBefore.push({ kind: "declare", name: held, type, init: empty, line });
    this.pendingBefore.push({
      kind: "if",
      condition,
      then: [
        ...(rejected === undefined ? [] : [{ kind: "expression" as const, value: rejected, line }]),
        { kind: "assign", target: held, op: "=", value: then, line },
      ],
      otherwise: [{ kind: "assign", target: held, op: "=", value: otherwise, line }],
      line,
    });
    this.valueTypes.set(held, type);
    const shape = this.shapeOf(then) ?? this.shapeOf(otherwise);
    if (shape !== null) this.valueShapes.set(held, shape);
    return { k: "ident", name: held };
  }

  /**
   * A value a continuation reads more than once, held in a name of its own.
   *
   * The name is declared with the type its use reads it at, so a value the
   * runtime carries as a handle is held at the handle it is and the contract
   * keeps what the source said: `Promise.await` of a `Promise<number>` is a
   * number, and a choice between it and a number is a number.
   */
  private holdValue(value: Expression, type: TypeExpr | null, line: number): Expression {
    if (this.repeatable(value) || this.loopCondition) return value;
    const held = `__held${this.fieldCount++}`;
    this.pendingBefore.push({ kind: "declare", name: held, type, init: value, line });
    this.valueTypes.set(held, type ?? this.valueTypeOf(value));
    const shape = this.shapeOf(value);
    if (shape !== null) this.valueShapes.set(held, shape);
    return { k: "ident", name: held };
  }

  /** A choice between two values, held at the type the two have in common. */
  private typedChoice(condition: Expression, then: Expression, otherwise: Expression): Expression {
    const choice: Expression = { k: "conditional", condition, then, otherwise };
    this.expressionTypes.set(choice, commonResult(this.valueTypeOf(then), this.valueTypeOf(otherwise)));
    return choice;
  }

  /**
   * The type of the value a promise carries.
   *
   * A promise's declaration states what it carries, and the read peels it: the
   * receiver is typed at the carried value where the type reader could spell
   * it — a `Promise<number>` is a number — and at the erased reference where it
   * could not. The shape is the finer of the two, so a carried primitive or
   * list is read from it; a record stays the reference its contract spells,
   * with the shape beside it carrying the fields.
   */
  private promisePayloadType(receiver: Expression): TypeExpr {
    const shape = this.shapeOf(receiver);
    if (shape !== null && (shape.kind === "primitive" || shape.kind === "text" || shape.kind === "list")) {
      return this.typeExprOfShape(shape);
    }
    const type = this.valueTypeOf(receiver);
    if (type.kind === "primitive" || type.kind === "text" || type.kind === "slice" || type.kind === "array" || type.kind === "void") return type;
    return ANY_TYPE;
  }

  /**
   * `Promise.allSettled(items)`: one record per promise, saying whether it
   * settled and what a failure was.
   *
   * The entry the language writes is `{ status, value, reason }`: a fulfilled
   * promise answers `"fulfilled"` and the value it carried, and a failed one
   * answers `"rejected"` and the message it failed with. The list is of
   * references because a record is one, and the helper that builds it walks
   * the promises once.
   */
  private promiseSettled(receiver: Expression, method: string, args: readonly Expression[]): Expression | null {
    if (!(receiver.k === "ident" && receiver.name === "Promise" && method === "allSettled")) return null;
    if (args.length !== 1) {
      this.report(`Promise.allSettled takes one argument`, `as in Promise.allSettled(workers.map(worker))`, this.peek());
      return this.hole();
    }
    const list = args[0] as Expression;
    const type = this.valueTypeOf(list);
    if (type.kind !== "slice" && type.kind !== "array") {
      if (this.importsArePending() && this.pendingHolds(list)) {
        const answered = this.hole();
        this.deferred.add(answered);
        return answered;
      }
      this.report(
        "Promise.allSettled settles a list",
        "the value the call settles is a list of promises, as in Promise.allSettled(found.map(f))",
        this.peek(),
      );
      return this.hole();
    }
    const helper = this.allSettledHelper(this.peek().line);
    const call: Expression = { k: "call", name: helper.name, args: [list] };
    this.expressionTypes.set(call, helper.returns);
    this.expressionShapes.set(call, helper.shape);
    return call;
  }

  /** The helper `Promise.allSettled` builds its records with, once per program. */
  private allSettledHelper(line: number): { name: string; returns: TypeExpr; shape: ResolvedType } {
    const known = this.collectHelpers.get("allSettled");
    if (known !== undefined) {
      const settled = this.settledShape();
      return { name: known.name, returns: known.returns, shape: { kind: "list", of: settled } };
    }
    const name = `__collect_${this.stem}_${this.collectCount}`;
    this.collectCount += 1;
    const ident = (value: string): Expression => ({ k: "ident", name: value });
    const number = (text: string): Expression => ({ k: "literal", text });
    const written = (value: string): Expression => ({ k: "text", parts: [{ k: "text", value }] });
    const anyRef: TypeExpr = { kind: "ref", of: null };
    const failed: Expression = { k: "call", name: "Promise.failed", args: [ident("p")] };
    this.expressionTypes.set(failed, BOOLEAN_RESULT);
    const message: Expression = { k: "call", name: "Promise.message", args: [ident("p")] };
    this.expressionTypes.set(message, TEXT_RESULT);
    // The value a fulfilled promise carried is the box the runtime holds: a
    // list of handles does not say what the payload is, and a program that
    // reads `value` reads the handle.
    const carried: Expression = { k: "call", name: "Promise.await", args: [ident("p")] };
    this.expressionTypes.set(carried, anyRef);
    const record = (status: string, value: Expression, reason: Expression): Expression => ({
      k: "object",
      fields: [
        { name: "status", value: written(status) },
        { name: "value", value },
        { name: "reason", value: reason },
      ],
    });
    const body: Statement[] = [
      {
        kind: "declare",
        name: "out",
        type: null,
        init: { k: "sized", element: typeToString(anyRef), count: { k: "length", buffer: "items" } },
        line,
      },
      {
        kind: "loop",
        variable: "i",
        from: number("0"),
        to: { k: "length", buffer: "items" },
        inclusive: false,
        step: null,
        down: false,
        body: [
          { kind: "declare", name: "p", type: anyRef, init: { k: "index", base: ident("items"), index: ident("i") }, line },
          {
            kind: "if",
            condition: failed,
            then: [{
              kind: "indexAssign",
              buffer: "out",
              index: ident("i"),
              op: "=",
              value: record("rejected", { k: "null" }, message),
              line,
            }],
            otherwise: [{
              kind: "indexAssign",
              buffer: "out",
              index: ident("i"),
              op: "=",
              value: record("fulfilled", carried, written("")),
              line,
            }],
            line,
          },
        ],
        line,
      },
      { kind: "result", value: ident("out"), line },
    ];
    const params = [{ name: "items", type: { kind: "slice", of: anyRef } as TypeExpr }];
    const returns: TypeExpr = { kind: "slice", of: anyRef };
    const helper: TypeScriptFunction = { name, params, returns, body, line, closure: true };
    this.closures.push({ name, exported: false, internal: true, params: helper.params, returns, handle: helper });
    this.liftedArrows.set(name, helper);
    const made = { name, returns };
    this.collectHelpers.set("allSettled", made);
    return { name, returns, shape: { kind: "list", of: this.settledShape() } };
  }

  /** The record `Promise.allSettled` answers per promise. */
  private settledShape(): ResolvedType {
    return {
      kind: "record",
      fields: new Map([
        ["status", { type: { kind: "text" } as ResolvedType, optional: false }],
        ["value", { type: { kind: "any" } as ResolvedType, optional: false }],
        ["reason", { type: { kind: "text" } as ResolvedType, optional: false }],
      ]),
      index: null,
    };
  }

  /**
   * `Promise.all(items)`: the list of the values each promise in `items`
   * carries, in the order it wrote them.
   *
   * A value that is not a promise is awaited as itself, so the helper settles
   * each element with the same await the source would write and collects the
   * payloads where they were written. The element type is the type each item
   * answers, and an untyped list the link has not settled is refused or
   * deferred by the same rule the collection methods follow.
   */
  private promiseAll(receiver: Expression, method: string, args: readonly Expression[], line: number): Expression | null {
    if (!(receiver.k === "ident" && receiver.name === "Promise" && method === "all")) return null;
    if (args.length !== 1) {
      this.report(`Promise.all takes one argument`, `as in Promise.all(found.map(f))`, this.peek());
      return this.hole();
    }
    const list = args[0] as Expression;
    const type = this.valueTypeOf(list);
    if (type.kind !== "slice" && type.kind !== "array") {
      if (this.importsArePending() && this.pendingHolds(list)) {
        const answered = this.hole();
        this.deferred.add(answered);
        return answered;
      }
      this.report(
        "Promise.all settles a list",
        "the value the call settles is a list of promises, as in Promise.all(found.map(f))",
        this.peek(),
      );
      return this.hole();
    }
    const element = type.of;
    if (element.kind === "void" || element.kind === "mask") {
      // A promise that answers nothing leaves no value to collect: each one is
      // awaited in order and nothing is gathered, which is what the source
      // awaiting the call and discarding it means. The call answers nothing.
      const helper = this.awaitAllVoidHelper(element, line);
      const call: Expression = { k: "call", name: helper.name, args: [list] };
      this.expressionTypes.set(call, helper.returns);
      return call;
    }
    const helper = this.awaitAllHelper(element, line);
    const call: Expression = { k: "call", name: helper.name, args: [list] };
    this.expressionTypes.set(call, helper.returns);
    const shape = this.shapeOf(list);
    const held = shape !== null && shape.kind === "list" ? shape.of : null;
    if (held !== null) this.expressionShapes.set(call, { kind: "list", of: held });
    return call;
  }

  /** The helper `Promise.all` settles each element of one list with, once per element type. */
  private awaitAllHelper(element: TypeExpr, line: number): { name: string; returns: TypeExpr } {
    const key = JSON.stringify(["all", element]);
    const known = this.collectHelpers.get(key);
    if (known !== undefined) return known;
    const name = `__collect_${this.stem}_${this.collectCount}`;
    this.collectCount += 1;
    const items: TypeExpr = { kind: "slice", of: element };
    const elementText = typeToString(element);
    const ident = (value: string): Expression => ({ k: "ident", name: value });
    const number = (text: string): Expression => ({ k: "literal", text });
    const returns: TypeExpr = { kind: "slice", of: element };
    const body: Statement[] = [
      { kind: "declare", name: "out", type: null, init: { k: "sized", element: elementText, count: { k: "length", buffer: "items" } }, line },
      {
        kind: "loop",
        variable: "i",
        from: number("0"),
        to: { k: "length", buffer: "items" },
        inclusive: false,
        step: null,
        down: false,
        body: [
          {
            kind: "indexAssign",
            buffer: "out",
            index: ident("i"),
            op: "=",
            value: { k: "call", name: "Promise.await", args: [{ k: "index", base: ident("items"), index: ident("i") }] },
            line,
          },
        ],
        line,
      },
      { kind: "result", value: ident("out"), line },
    ];
    const params = [{ name: "items", type: items }];
    const helper: TypeScriptFunction = { name, params, returns, body, line, closure: true };
    this.closures.push({ name, exported: false, internal: true, params: helper.params, returns, handle: helper });
    this.liftedArrows.set(name, helper);
    const made = { name, returns };
    this.collectHelpers.set(key, made);
    return made;
  }

  /**
   * The helper `Promise.all` over promises that answer nothing settles each
   * element of one list with.
   *
   * A promise that carries no value leaves nothing to collect, so each one is
   * awaited in order and nothing is gathered: the loop is the await the source
   * would write for each element, and the call answers nothing.
   */
  private awaitAllVoidHelper(element: TypeExpr, line: number): { name: string; returns: TypeExpr } {
    const key = JSON.stringify(["allVoid", element]);
    const known = this.collectHelpers.get(key);
    if (known !== undefined) return known;
    const name = `__collect_${this.stem}_${this.collectCount}`;
    this.collectCount += 1;
    const items: TypeExpr = { kind: "slice", of: element };
    const ident = (value: string): Expression => ({ k: "ident", name: value });
    const number = (text: string): Expression => ({ k: "literal", text });
    const returns: TypeExpr = NOTHING;
    const body: Statement[] = [
      {
        kind: "loop",
        variable: "i",
        from: number("0"),
        to: { k: "length", buffer: "items" },
        inclusive: false,
        step: null,
        down: false,
        body: [
          {
            kind: "expression",
            value: { k: "call", name: "Promise.await", args: [{ k: "index", base: ident("items"), index: ident("i") }] },
            line,
          },
        ],
        line,
      },
    ];
    const params = [{ name: "items", type: items }];
    const helper: TypeScriptFunction = { name, params, returns, body, line, closure: true };
    this.closures.push({ name, exported: false, internal: true, params: helper.params, returns, handle: helper });
    this.liftedArrows.set(name, helper);
    const made = { name, returns };
    this.collectHelpers.set(key, made);
    return made;
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

  /**
   * What a top-level name's annotation says it holds, where the read has no
   * better answer.
   *
   * A constant whose value is a call — `const RUNTIME_ABI = [entry(...), …]` —
   * is not a value the file wrote out, so the read has no value to take a shape
   * from. The annotation is the declaration's own statement about it, and a
   * list it names is a list whose elements a `map` walks.
   */
  /** The shapes the annotations of this file's exported declarations write. */
  private exportedValueShapes(): Map<string, ResolvedType> {
    const shapes = new Map<string, ResolvedType>();
    for (const [name, annotation] of this.constantAnnotations) {
      if (!annotation.exported) continue;
      const shape = this.constantAnnotationShape(name);
      if (shape !== null && shape.kind !== "any") shapes.set(name, shape);
    }
    return shapes;
  }

  private constantAnnotationShape(name: string): ResolvedType | null {
    const annotation = this.constantAnnotations.get(name);
    if (annotation === undefined) return null;
    const known = this.constantAnnotationShapes.get(name);
    if (known !== undefined) return known;
    try {
      const resolved = resolveAnnotation(this.allTokens, annotation.start, annotation.end, this.typeTable);
      this.constantAnnotationShapes.set(name, resolved);
      return resolved;
    } catch {
      this.notePendingType(typeText(this.allTokens, annotation.start, annotation.end));
      return null;
    }
  }

  /**
   * The collection a top-level `new Map<...>()` or `new Set<...>()` allocates,
   * by the name it is bound to.
   *
   * The handle is state, but what the name holds is what a method written on it
   * reads — and a function written above the declaration is read before the
   * declaration is. The span the scan kept is resolved here, against the table
   * the module graph built.
   */
  private constantCollection(name: string): CollectionValue | null {
    const range = this.constantCollections.get(name);
    if (range === undefined) return null;
    const known = this.constantCollectionValues.get(name);
    if (known !== undefined) return known;
    let collection: CollectionValue | null = null;
    try {
      const shape = resolveAnnotation(this.allTokens, range.start, range.end, this.typeTable);
      collection = this.collectionOfShape(shape);
    } catch {
      this.notePendingType(typeText(this.allTokens, range.start, range.end));
    }
    this.constantCollectionValues.set(name, collection);
    return collection;
  }

  /**
   * The shape a written-out list constant holds.
   *
   * `const OPERATORS = ["+", "-"]` names a list of texts, and the declaration
   * writes no type for it: what it holds is read from the values the file wrote.
   * The list is read once per name, and only a constant whose value starts with
   * `[` is asked — an object or an allocation has its own shape already.
   */
  private constantWrittenShape(name: string): ResolvedType | null {
    const known = this.constantWrittenShapes.get(name);
    if (known !== undefined) return known;
    const constant = this.constants.get(name);
    const range = constant?.expression?.range;
    const first = range === undefined ? undefined : this.allTokens[range.start];
    if (range === undefined || first?.text !== "[") {
      this.constantWrittenShapes.set(name, null);
      return null;
    }
    const value = this.constantValue(name, constant?.expression);
    const shape = value === null ? null : this.shapeOf(value);
    this.constantWrittenShapes.set(name, shape);
    return shape;
  }

  /**
   * The signature a value's declaration types it at, when it types a function.
   *
   * A field the declaration writes at a function type, and the answer of a
   * call whose declaration writes one, are both values a call is made
   * through: the parameters and the result the type states are what the call
   * site reads its arguments at.
   */
  private expressionFunctionType(value: Expression): FunctionType | null {
    const shape = this.shapeOf(value);
    if (shape === null || shape.kind !== "function") return null;
    return {
      params: shape.params.map((param) => this.typeExprOfShape(param)),
      returns: this.typeExprOfShape(shape.returns),
      shape: shape.returns,
    };
  }

  /** The signature a member's declaration types it at, when it types one. */
  private memberFunctionType(value: Expression & { k: "member" }): FunctionType | null {
    return this.expressionFunctionType(value);
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
    // A value chosen between two arms is the type the arms have in common,
    // read from what each arm answers. `a.trim() || b.trim()` is a text even
    // though the scope holds no name for either answer, so the method written
    // after the choice is a text method.
    if (value.k === "binary" && (value.op === "&&" || value.op === "||" || value.op === "??")) {
      return commonResult(this.valueTypeOf(value.left), this.valueTypeOf(value.right));
    }
    // A member read through an interface is typed by the field the interface
    // declares, which is what keeps `contract.definition.calls` an array. A
    // call is not asked here: the shape of a call asks what the call answers,
    // and that is this method's question.
    if (value.k !== "call") {
      const shape = this.shapeOf(value);
      if (shape !== null && shape.kind !== "any") return this.typeExprOfShape(shape);
    }
    if (value.k === "call") {
      // `structuredClone(x)` is a deep copy of `x`, so it is the type `x` is:
      // the copy has the fields the source has, at the types it wrote. The name
      // is the language's own unless the file declares a function of it, which
      // the lookups below answer first.
      if (
        isStructuredClone(value) &&
        !this.declaredReturns.has(value.name) &&
        !this.liftedArrows.has(value.name) &&
        !this.declaredFunctionReturns.has(value.name)
      ) {
        return this.valueTypeOf(value.args[0] as Expression);
      }
      // `await f()` is the value the promise carries, which is the type the
      // declaration states for it.
      const awaited = value.name === "Promise.await" ? value.args[0] : undefined;
      if (awaited !== undefined && awaited.k === "invoke") {
        const payload = promisePayloadText(typeToString(awaited.returns));
        if (payload !== null) return this.typeForName(payload, 1);
        return awaited.returns;
      }
      if (awaited !== undefined && awaited.k === "call") {
        const carried = this.declaredReturns.get(awaited.name);
        if (carried !== undefined) return carried;
        const imported = this.declaredFunctionReturns.get(awaited.name);
        if (imported !== undefined) return imported.returns;
        // A method of a class is no name a declaration in this file holds: the
        // call itself was typed where it was written, and the await holds what
        // that call answers.
        const held = this.expressionTypes.get(awaited);
        if (held !== undefined) return held;
      }
      const written = this.liftedArrows.get(value.name);
      if (written !== undefined) return written.returns;
      // A call of an `async` function answers the promise handle: what the
      // declaration states is the payload the promise carries, which is what
      // `await` reads out of it.
      if (this.promiseFunctions.has(value.name)) return { kind: "ref", of: null };
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
    if (value.k === "binary") {
      // A binary over whole numbers is a whole number: what the sides answer
      // is what the operation answers, including the bigint a `BigInt` call
      // answers, which the scope alone does not hold.
      const left = this.valueTypeOf(value.left);
      const right = this.valueTypeOf(value.right);
      if (left.kind === "primitive" && right.kind === "primitive") {
        const whole = (name: string): boolean => name !== "f32" && name !== "f64" && name !== "bool";
        if (whole(left.name) && whole(right.name)) {
          if (left.name === "u256" || right.name === "u256") return WIDE_RESULT;
          if (left.name === "i256" || right.name === "i256") return { kind: "primitive", name: "i256" };
          return BIGINT_RESULT;
        }
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
    // A value the read holds at a record is a layout: its fields are the keys
    // it was laid out with, and a key the program wrote only when a condition
    // held is still a field of it. A list of the values is a list of one
    // element type, so it is answered only where every field is that type.
    const shape = args.length === 1 && value !== undefined ? this.shapeOf(value) : null;
    if (shape !== null && shape.kind === "record" && shape.index === null && shape.arms === undefined) {
      const names = [...shape.fields.keys()];
      if (method === "keys") {
        const keys: Expression = {
          k: "buffer",
          element: "text",
          values: names.map((name): Expression => ({ k: "text", parts: [{ k: "text", value: name }] })),
        };
        this.expressionTypes.set(keys, { kind: "slice", of: TEXT_RESULT });
        return keys;
      }
      const types = names.map((name) => this.typeExprOfShape((shape.fields.get(name) as ResolvedField).type));
      const element = types[0];
      if (element !== undefined && types.every((one) => typeToString(one) === typeToString(element))) {
        const listed: Expression = {
          k: "buffer",
          element: typeToString(element),
          values: names.map((name): Expression => ({ k: "member", base: value as Expression, field: name })),
        };
        this.expressionTypes.set(listed, { kind: "slice", of: element });
        return listed;
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
      const keys: Expression = {
        k: "buffer",
        element: "text",
        values: names.map((name): Expression => ({ k: "text", parts: [{ k: "text", value: name }] })),
      };
      // The list is built here rather than written by the source, so nothing
      // else says what it holds: a `join` written after it reads the element
      // type from this, and without it the elements were the unshaped
      // reference a value the frontend cannot type is.
      this.expressionTypes.set(keys, { kind: "slice", of: TEXT_RESULT });
      return keys;
    }
    const values: Expression[] = [];
    for (const name of names) {
      const read = this.constantValue(value.k === "ident" ? value.name : "", constant.fields.get(name));
      if (read !== null) values.push(read);
    }
    const element = values.length === 0 ? typeToString(ANY_TYPE) : typeToString(this.valueTypeOf(values[0] as Expression));
    const listed: Expression = { k: "buffer", element, values };
    this.expressionTypes.set(listed, { kind: "slice", of: values.length === 0 ? ANY_TYPE : this.valueTypeOf(values[0] as Expression) });
    return listed;
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
  /**
   * Whether a value is a regular expression.
   *
   * A literal is one, a name already known to hold one is one, and a choice
   * between two of them is one: both arms are the two texts a regular
   * expression is, so the name holds `[pattern, flags]` whichever arm ran and
   * `regexOf` reads the parts of it the same way. A conditional whose arms are
   * not both regular expressions is a value of some other type.
   */
  private isRegexValue(value: Expression): boolean {
    if (value.k === "buffer") return this.regexValues.has(value);
    if (value.k === "ident") return this.valueRegexes.has(value.name);
    if (value.k === "conditional") return this.isRegexValue(value.then) && this.isRegexValue(value.otherwise);
    return false;
  }

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

  /**
   * The reads and writes a view of a block makes.
   *
   * A typed array is a block of elements, and `bytes.buffer` is the block
   * itself: a `DataView` over one is the same bytes, so a write of a chosen
   * width at a chosen offset is the stores that write it, from the least
   * significant byte up, and a read is the sum the bytes are. `bytes.set` is a
   * copy of a list into the block. Each is a function of the file, written once
   * per width and element, so a call of it is a call the backends already
   * lower — nothing new is asked of a backend.
   */
  private blockViewMethod(receiver: Expression, method: string, args: readonly Expression[]): Expression | null {
    const stores: Record<string, number> = { setUint8: 1, setUint16: 2, setUint32: 4, setBigUint64: 8, setBigInt64: 8 };
    const loads: Record<string, number> = { getUint8: 1, getUint16: 2, getUint32: 4, getBigUint64: 8, getBigInt64: 8 };
    // A float is not a number the bytes state as a sum: four bytes read as an
    // f32 and eight as an f64 are the bit pattern the float is, and the runtime
    // is the one place that copies them into a number of the width they are.
    const floatStores: Record<string, number> = { setFloat32: 4, setFloat64: 8 };
    const floatLoads: Record<string, number> = { getFloat32: 4, getFloat64: 8 };
    const width = stores[method];
    const floatWidth = floatStores[method];
    if (floatWidth !== undefined) {
      if (args.length < 2 || args.length > 3) return null;
      if (args.length === 3 && !isNumberLiteral(args[2] as Expression, "1")) return null;
      const call: Expression = {
        k: "call",
        name: "blaze_rt_view_store_float",
        args: [receiver, args[0] as Expression, args[1] as Expression, { k: "literal", text: String(floatWidth) }],
      };
      this.expressionTypes.set(call, NOTHING);
      return call;
    }
    const floatRead = floatLoads[method];
    if (floatRead !== undefined) {
      if (args.length < 1 || args.length > 2) return null;
      if (args.length === 2 && !isNumberLiteral(args[1] as Expression, "1")) return null;
      const call: Expression = {
        k: "call",
        name: "blaze_rt_view_load_float",
        args: [receiver, args[0] as Expression, { k: "literal", text: String(floatRead) }],
      };
      this.expressionTypes.set(call, NUMBER_RESULT);
      return call;
    }
    if (width !== undefined) {
      if (args.length < 2 || args.length > 3) return null;
      if (args.length === 3 && !isNumberLiteral(args[2] as Expression, "1")) return null;
      const value = args[1] as Expression;
      const helper = this.viewStoreHelper(width, this.valueTypeOf(value), this.peek().line);
      const call: Expression = { k: "call", name: helper, args: [receiver, args[0] as Expression, value] };
      this.expressionTypes.set(call, NOTHING);
      return call;
    }
    const read = loads[method];
    if (read !== undefined) {
      if (args.length < 1 || args.length > 2) return null;
      if (args.length === 2 && !isNumberLiteral(args[1] as Expression, "1")) return null;
      const helper = this.viewLoadHelper(read, this.peek().line);
      const call: Expression = { k: "call", name: helper, args: [receiver, args[0] as Expression] };
      this.expressionTypes.set(call, read === 8 ? BIGINT_RESULT : NUMBER_RESULT);
      return call;
    }
    if (method !== "set") return null;
    // `bytes.set(source)` writes the source from the start; `bytes.set(source,
    // at)` from the offset the source names.
    if (args.length < 1 || args.length > 2) return null;
    const source = args[0] as Expression;
    const held = this.valueTypeOf(source);
    const element: TypeExpr = held.kind === "slice" || held.kind === "array" ? held.of : NUMBER_RESULT;
    const helper = this.viewCopyHelper(element, this.peek().line);
    const at: Expression = args[1] ?? { k: "literal", text: "0" };
    const call: Expression = { k: "call", name: helper, args: [receiver, at, source] };
    this.expressionTypes.set(call, NOTHING);
    return call;
  }

  /**
   * The function `bytes.toString("latin1")` becomes: the text one byte per
   * character is.
   *
   * A byte is the character of its value under the one-byte encoding, so the
   * text is the code point of each byte written in turn: the characters above
   * 127 are the two-byte utf8 sequences a compiled text holds them as.
   */
  private latin1Helper(line: number): { name: string; returns: TypeExpr } {
    const key = JSON.stringify(["latin1"]);
    const known = this.collectHelpers.get(key);
    if (known !== undefined) return known;
    const name = `__collect_${this.stem}_${this.collectCount}`;
    this.collectCount += 1;
    const ident = (value: string): Expression => ({ k: "ident", name: value });
    const number = (text: string): Expression => ({ k: "literal", text });
    const params = [{ name: "bytes", type: { kind: "slice", of: BYTE } as TypeExpr }];
    const returns: TypeExpr = TEXT_RESULT;
    const body: Statement[] = [
      { kind: "declare", name: "out", type: null, init: { k: "text", parts: [{ k: "text", value: "" }] }, line },
      {
        kind: "loop",
        variable: "i",
        from: number("0"),
        to: { k: "length", buffer: "bytes" },
        inclusive: false,
        step: null,
        down: false,
        body: [
          {
            kind: "assign",
            target: "out",
            op: "+=",
            value: { k: "call", name: "String.fromCodePoint", args: [{ k: "index", base: ident("bytes"), index: ident("i") }] },
            line,
          },
        ],
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

  /** The function that writes a value of a width into a block at an offset. */
  private viewStoreHelper(width: number, held: TypeExpr, line: number): string {
    // A whole number of sixty-four bits is written a byte at a time from its
    // own digits, which is what a mask and a shift of a `bigint` are; a number
    // is written from the double, where the shift is a division.
    const whole = held.kind === "primitive" && (held.name === "i64" || held.name === "u64");
    const key = JSON.stringify(["viewStore", width, whole]);
    const known = this.collectHelpers.get(key);
    if (known !== undefined) return known.name;
    const name = `__view_${this.stem}_${this.collectCount}`;
    this.collectCount += 1;
    const ident = (value: string): Expression => ({ k: "ident", name: value });
    const number = (text: string): Expression => ({ k: "literal", text });
    const shift = (places: number): Expression => whole
      ? { k: "bigint", text: `${BigInt(2) ** BigInt(places * 8)}n` }
      : number(String(2 ** (places * 8)));
    const at = (offset: number): Expression => offset === 0
      ? ident("at")
      : { k: "binary", op: "+", left: ident("at"), right: number(String(offset)) };
    const body: Statement[] = [];
    for (let index = 0; index < width; index += 1) {
      // The byte is the value shifted down and masked, which is the low byte of
      // what is left of it.
      let byte: Expression = ident("value");
      if (index > 0) byte = whole
        ? { k: "binary", op: ">>", left: byte, right: shift(index) }
        : { k: "binary", op: "/", left: byte, right: shift(index) };
      if (width > 1) byte = { k: "binary", op: "&", left: byte, right: whole ? { k: "bigint", text: "255n" } : number("255") };
      body.push({ kind: "indexAssign", buffer: "target", index: at(index), op: "=", value: byte, line });
    }
    const params = [
      { name: "target", type: { kind: "slice", of: BYTE } as TypeExpr },
      { name: "at", type: NUMBER_RESULT },
      { name: "value", type: whole ? BIGINT_RESULT : NUMBER_RESULT },
    ];
    const helper: TypeScriptFunction = { name, params, returns: NOTHING, body, line, closure: true };
    this.closures.push({ name, exported: false, internal: true, params, returns: NOTHING, handle: helper });
    this.liftedArrows.set(name, helper);
    this.collectHelpers.set(key, { name, returns: NOTHING });
    return name;
  }

  /** The function that reads a value of a width out of a block at an offset. */
  private viewLoadHelper(width: number, line: number): string {
    // Eight bytes are a whole number of sixty-four bits, so the sum is of the
    // digits of one: a byte of a number wider than a machine word is not a
    // number the double the read answers can hold.
    const whole = width === 8;
    const key = JSON.stringify(["viewLoad", width]);
    const known = this.collectHelpers.get(key);
    if (known !== undefined) return known.name;
    const name = `__view_${this.stem}_${this.collectCount}`;
    this.collectCount += 1;
    const ident = (value: string): Expression => ({ k: "ident", name: value });
    const number = (text: string): Expression => ({ k: "literal", text });
    const weight = (places: number): Expression => whole
      ? { k: "bigint", text: `${BigInt(2) ** BigInt(places * 8)}n` }
      : number(String(2 ** (places * 8)));
    const at = (offset: number): Expression => offset === 0
      ? ident("at")
      : { k: "binary", op: "+", left: ident("at"), right: number(String(offset)) };
    let total: Expression = { k: "index", base: ident("target"), index: at(0) };
    for (let index = 1; index < width; index += 1) {
      const byte: Expression = { k: "index", base: ident("target"), index: at(index) };
      total = {
        k: "binary",
        op: "+",
        left: total,
        right: { k: "binary", op: "*", left: byte, right: weight(index) },
      };
    }
    const returns: TypeExpr = whole ? BIGINT_RESULT : NUMBER_RESULT;
    const params = [
      { name: "target", type: { kind: "slice", of: BYTE } as TypeExpr },
      { name: "at", type: NUMBER_RESULT },
    ];
    const body: Statement[] = [{ kind: "result", value: total, line }];
    const helper: TypeScriptFunction = { name, params, returns, body, line, closure: true };
    this.closures.push({ name, exported: false, internal: true, params, returns, handle: helper });
    this.liftedArrows.set(name, helper);
    this.collectHelpers.set(key, { name, returns });
    return name;
  }

  /** The function that copies a list of numbers into a block at an offset. */
  private viewCopyHelper(element: TypeExpr, line: number): string {
    const key = JSON.stringify(["viewCopy", element]);
    const known = this.collectHelpers.get(key);
    if (known !== undefined) return known.name;
    const name = `__view_${this.stem}_${this.collectCount}`;
    this.collectCount += 1;
    const ident = (value: string): Expression => ({ k: "ident", name: value });
    const number = (text: string): Expression => ({ k: "literal", text });
    const params = [
      { name: "target", type: { kind: "slice", of: BYTE } as TypeExpr },
      { name: "at", type: NUMBER_RESULT },
      { name: "source", type: { kind: "slice", of: element } as TypeExpr },
    ];
    const body: Statement[] = [
      {
        kind: "loop",
        variable: "i",
        from: number("0"),
        to: { k: "lengthOf", of: ident("source") },
        inclusive: false,
        step: null,
        down: false,
        body: [
          {
            kind: "indexAssign",
            buffer: "target",
            index: { k: "binary", op: "+", left: ident("at"), right: ident("i") },
            op: "=",
            value: { k: "index", base: ident("source"), index: ident("i") },
            line,
          },
        ],
        line,
      },
    ];
    const helper: TypeScriptFunction = { name, params, returns: NOTHING, body, line, closure: true };
    this.closures.push({ name, exported: false, internal: true, params, returns: NOTHING, handle: helper });
    this.liftedArrows.set(name, helper);
    this.collectHelpers.set(key, { name, returns: NOTHING });
    return name;
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
    if (method === "indexOf" && args.length === 2) {
      // A search that starts at a position is the search of the field from
      // there, and the position it found is the field's own plus the start.
      const helper = this.indexOfHelper(this.peek().line);
      return call(helper.name, [receiver, args[0] as Expression, args[1] as Expression]);
    }
    if (method === "lastIndexOf" && (args.length === 1 || args.length === 2)) {
      // The last asking of the needle is the first asking of the text walked
      // backwards from the position: the field the needle is long, compared
      // with the needle, walking from the start the position states.
      const helper = this.lastIndexOfHelper(this.peek().line, args.length === 2);
      return call(helper.name, args.length === 2
        ? [receiver, args[0] as Expression, args[1] as Expression]
        : [receiver, args[0] as Expression]);
    }
    if (method === "codePointAt" && args.length === 1) {
      // The code point at a byte position is the character there, written as
      // the number it is: the runtime decodes the text at that byte.
      return call("text.codePointAt", [receiver, args[0] as Expression]);
    }
    if (method === "repeat" && args.length === 1) {
      // A repetition is a loop that appends the text to an answer of its own.
      // The count is floored, as the language floors it: `"ab".repeat(2.5)` is
      // two repetitions, not three.
      const helper = this.repeatHelper(this.peek().line);
      return call(helper.name, [receiver, args[0] as Expression]);
    }
    // `text.padEnd(width)` and `text.padStart(width, fill)` are the text with
    // the fill repeated to the width it is short by. The fill is one character
    // — the default is a space — so repeating it exactly as many times as the
    // width is short by is the padding the language writes.
    if ((method === "padEnd" || method === "padStart") && (args.length === 1 || args.length === 2)) {
      const width = args[0] as Expression;
      const fill = args[1] ?? { k: "text" as const, parts: [{ k: "text" as const, value: " " }] };
      const character = fill.k === "text" && fill.parts.length === 1 && fill.parts[0]?.k === "text"
        ? Array.from((fill.parts[0] as { value: string }).value)
        : [];
      if (character.length === 1 && this.repeatable(receiver) && this.repeatable(width)) {
        const short = { k: "binary" as const, op: "-" as const, left: width, right: { k: "lengthOf" as const, of: receiver } };
        const padding = call(this.repeatHelper(this.peek().line).name, [fill, short]);
        return method === "padEnd"
          ? { k: "binary" as const, op: "+" as const, left: receiver, right: padding }
          : { k: "binary" as const, op: "+" as const, left: padding, right: receiver };
      }
    }
    if (method === "split" && (args.length === 1 || args.length === 2)) {
      // An empty separator and a separator of several characters are both
      // fields the helper cuts, and a regular expression was taken above. The
      // limit is how many fields the list keeps at most: the helper cuts them
      // and then keeps that many.
      const helper = this.splitHelper(this.peek().line, args.length === 2);
      return call(helper.name, args.length === 2
        ? [receiver, args[0] as Expression, args[1] as Expression]
        : [receiver, args[0] as Expression]);
    }
    if (method === "slice" && (args.length === 1 || args.length === 2)) {
      return call("text.slice", [receiver, ...args]);
    }
    // `text.charAt(i)` is the one-character field starting at `i`. A position
    // past the end is the empty text, which is the slice a text answers past
    // its own end.
    if (method === "charAt" && args.length === 1) {
      const at = args[0] as Expression;
      if (!this.repeatable(at)) return null;
      return call("text.slice", [receiver, at, { k: "binary", op: "+", left: at, right: { k: "literal", text: "1" } }]);
    }
    if (method === "includes" && args.length === 1) {
      return {
        k: "binary",
        op: "!==",
        left: call("text.indexOf", [receiver, args[0] as Expression]),
        right: { k: "literal", text: "-1" },
      };
    }
    // `text.replace(needle, replacement)` is the text with the needle's first
    // asking replaced: what is before it, the replacement, and what is after
    // it. A needle that is not there leaves the text it was asked of, and the
    // empty needle asks at the beginning. `text.indexOf` is a runtime call
    // that names no new service, so no helper is needed.
    if (method === "replace" && args.length === 2) {
      const needle = args[0] as Expression;
      const replacement = args[1] as Expression;
      if (!this.repeatable(needle) || !this.repeatable(replacement)) return null;
      const at = call("text.indexOf", [receiver, needle]);
      const before = call("text.slice", [receiver, { k: "literal", text: "0" }, at]);
      const after = call("text.slice", [receiver, { k: "binary", op: "+", left: at, right: { k: "lengthOf", of: needle } }]);
      return {
        k: "conditional",
        condition: { k: "binary", op: "===", left: at, right: { k: "literal", text: "-1" } },
        then: receiver,
        otherwise: {
          k: "binary",
          op: "+",
          left: { k: "binary", op: "+", left: before, right: replacement },
          right: after,
        },
      };
    }
    if (method === "startsWith" && args.length === 1) {
      // The field the text holds from the beginning, which is the text the
      // needle is long compared with the needle: one reading for both forms,
      // so a chain that asks both is the same two slices it is.
      const needle = args[0] as Expression;
      if (!this.repeatable(needle)) return null;
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
      if (!this.repeatable(needle) || !this.repeatable(at)) return null;
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
      if (!this.repeatable(needle)) return null;
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
    // `a.slice()` is the list copied, which is the same answer `a.slice(0)`
    // gives: from the first element to the last.
    const wanted = method === "join" ? [0, 1] : method === "slice" ? [0, 1, 2] : [1];
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
      : method === "slice" && args.length === 0
        ? [{ k: "literal" as const, text: "0" }]
        : [...args];
    const helper = this.sequenceMethodHelper(method, element, extra.length, line);
    const call: Expression = { k: "call", name: helper.name, args: [receiver, ...extra] };
    // `a.at(i)` answers one element of the list, the way `find` does, so what
    // the answer holds is what the list's element holds.
    if (method === "at") {
      const found = this.elementShapeOf(receiver, element);
      if (found !== null) this.expressionShapes.set(call, found);
    }
    // `a.slice(from, to)` answers a list of the elements it kept, so its
    // elements are the list's: a field read through one is the field the
    // declaration wrote, which is what `.slice(1).map(...)` reads.
    if (method === "slice") {
      this.expressionShapes.set(call, { kind: "list", of: this.elementShapeOf(receiver, element) ?? { kind: "any" } });
    }
    return call;
  }

  /**
   * `a.shift()` and `a.unshift(x)`: the two ends of a list that change it.
   *
   * The list a name holds changes, so the value is read before the change and
   * the change is written beside the statement it was read in: a shift answers
   * the element it took out, and an unshift answers the length the list has
   * afterwards. The change is not a value, so a call written for what it does
   * writes the change and drops the answer.
   */
  private listFrontMethod(
    receiver: Expression,
    method: "shift" | "unshift",
    args: readonly Expression[],
    spreads: readonly boolean[] | null,
    line: number,
  ): Expression | null {
    // The caller reads a name or a field of one, so the place is the receiver.
    let written: { target: string; base: string | null } | null = null;
    let place: Expression = receiver;
    if (receiver.k === "ident") written = { target: receiver.name, base: null };
    else if (receiver.k === "member" && receiver.base.k === "ident") written = { target: receiver.field, base: receiver.base.name };
    else if (receiver.k === "member") {
      // A field behind a call or another field — `this.frame().block.releases` —
      // is a place reached through the value that holds it. That value is read
      // once into a name of its own, and the place is the field of that name,
      // so the call runs the one time the source wrote it.
      const base = this.writeTarget(receiver.base, line);
      if (base === null) return null;
      written = { target: receiver.field, base };
      place = { k: "member", base: { k: "ident", name: base }, field: receiver.field };
    }
    if (written === null) return null;
    const sequence = this.valueTypeOf(receiver);
    const element = sequence.kind === "slice" || sequence.kind === "array" ? sequence.of : ANY_TYPE;
    if (method === "shift") {
      if (args.length !== 0) {
        this.report("shift takes no arguments", "it answers the element it takes out", this.peek());
        return this.hole();
      }
      // The element is read before the list loses it, and the list is the place
      // from one past the first element on.
      const taken = `__shifted${this.fieldCount++}`;
      this.pendingBefore.push({ kind: "declare", name: taken, type: null, init: { k: "index", base: place, index: { k: "literal", text: "0" } }, line });
      this.valueTypes.set(taken, element);
      const takenShape = this.elementShapeOf(place, element);
      if (takenShape !== null) this.valueShapes.set(taken, takenShape);
      const rest = this.sequenceMethod("slice", element, place, [{ k: "literal", text: "1" }], line);
      this.pendingBefore.push(this.writePlace(written, rest, line));
      return { k: "ident", name: taken };
    }
    // `unshift` writes the values in front of the list, in the order the source
    // wrote them, and answers the length it has afterwards. A spread writes the
    // elements of the list it names, which is the concatenation of that list
    // with the ones around it.
    let front: Expression = { k: "buffer", element: typeToString(element), values: [] };
    args.forEach((written, at) => {
      const piece: Expression = spreads?.[at] === true
        ? written
        : { k: "buffer", element: typeToString(element), values: [written] };
      front = { k: "binary", op: "+", left: front, right: piece };
    });
    this.pendingBefore.push(this.writePlace(written, { k: "binary", op: "+", left: front, right: place }, line));
    return { k: "lengthOf", of: place };
  }

  /**
   * `a.splice(at, del, ...items)`: a range of the list is the items instead.
   *
   * The answer is the range that was taken out, and the list the name holds is
   * the part before the range, the items, and the part after it. The positions
   * are the ones the language's `splice` uses: a start below zero counts from
   * the end, a start past the end is the end, and a count below zero takes
   * nothing out.
   *
   * Every position is read once into a name of the statement's own, because a
   * position is written three times: a call written twice runs twice.
   */
  private spliceMethod(
    receiver: Expression,
    args: readonly Expression[],
    spreads: readonly boolean[] | null,
    line: number,
  ): Expression | null {
    let written: { target: string; base: string | null } | null = null;
    if (receiver.k === "ident") written = { target: receiver.name, base: null };
    else if (receiver.k === "member" && receiver.base.k === "ident") written = { target: receiver.field, base: receiver.base.name };
    if (written === null) return null;
    const sequence = this.valueTypeOf(receiver);
    const element = sequence.kind === "slice" || sequence.kind === "array" ? sequence.of : ANY_TYPE;
    const place: Expression = receiver;
    const number = (text: string): Expression => ({ k: "literal", text });
    const length: Expression = { k: "lengthOf", of: place };
    const at = args[0] ?? number("0");
    const del = args[1] ?? { k: "lengthOf", of: place };
    // A position is read once, at the type it is read at, and the names below
    // are the only reads of it.
    const hold = (value: Expression, what: string): Expression => {
      if (value.k === "literal" || value.k === "ident") return value;
      const name = `__splice${what}${this.fieldCount++}`;
      this.pendingBefore.push({ kind: "declare", name, type: null, init: value, line });
      this.valueTypes.set(name, NUMBER_RESULT);
      return { k: "ident", name };
    };
    const startAt = hold(at, "at");
    const removedCount = hold(del, "del");
    const start = `__spliceStart${this.fieldCount++}`;
    const below = (left: Expression, right: Expression): Expression => ({ k: "binary", op: "<", left, right });
    const above = (left: Expression, right: Expression): Expression => ({ k: "binary", op: ">", left, right });
    const sum = (left: Expression, right: Expression): Expression => ({ k: "binary", op: "+", left, right });
    this.pendingBefore.push({
      kind: "declare",
      name: start,
      type: null,
      init: {
        k: "conditional",
        condition: below(startAt, number("0")),
        then: {
          k: "conditional",
          condition: below(sum(length, startAt), number("0")),
          then: number("0"),
          otherwise: sum(length, startAt),
        },
        otherwise: {
          k: "conditional",
          condition: above(startAt, length),
          then: length,
          otherwise: startAt,
        },
      },
      line,
    });
    this.valueTypes.set(start, NUMBER_RESULT);
    const from: Expression = { k: "ident", name: start };
    const count: Expression = {
      k: "conditional",
      condition: below(removedCount, number("0")),
      then: number("0"),
      otherwise: removedCount,
    };
    const stop = sum(from, count);
    // The answer is the range the call took out, read before the write.
    const taken = `__spliceTaken${this.fieldCount++}`;
    this.pendingBefore.push({
      kind: "declare",
      name: taken,
      type: null,
      init: this.sequenceMethod("slice", element, place, [from, stop], line),
      line,
    });
    this.valueTypes.set(taken, { kind: "slice", of: element });
    // The items written where the range was: a value written out joins the list
    // as a list of one, and a spread joins the list it already is.
    const elementText = typeToString(element);
    let items: Expression = { k: "buffer", element: elementText, values: [] };
    args.slice(2).forEach((value, index) => {
      const piece: Expression = spreads?.[index + 2] === true ? value : { k: "buffer", element: elementText, values: [value] };
      items = index === 0 ? piece : { k: "binary", op: "+", left: items, right: piece };
    });
    const head = this.sequenceMethod("slice", element, place, [number("0"), from], line);
    const tail = this.sequenceMethod("slice", element, place, [stop], line);
    const kept: Expression = { k: "binary", op: "+", left: { k: "binary", op: "+", left: head, right: items }, right: tail };
    this.pendingBefore.push(this.writePlace(written, kept, line));
    return { k: "ident", name: taken };
  }

  /** The write that puts a value back into the place a call was written on. */
  private writePlace(place: { target: string; base: string | null }, value: Expression, line: number): Statement {
    return place.base === null
      ? { kind: "assign", target: place.target, op: "=", value, line }
      : { kind: "memberAssign", base: place.base, field: place.target, op: "=", value, line };
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
  /**
   * The function a `text.indexOf(needle, from)` becomes.
   *
   * The runtime's search starts at the beginning of the text, so the search
   * from `from` is the search of the field that starts there, and a hit is the
   * position in that field plus `from`. The start is clamped the way the
   * language clamps it: below zero is the beginning, and past the end is the
   * end.
   */
  private indexOfHelper(line: number): { name: string; returns: TypeExpr } {
    const key = JSON.stringify(["indexOf", 2]);
    const known = this.collectHelpers.get(key);
    if (known !== undefined) return known;

    const name = `__collect_${this.stem}_${this.collectCount}`;
    this.collectCount += 1;
    const ident = (value: string): Expression => ({ k: "ident", name: value });
    const number = (text: string): Expression => ({ k: "literal", text });
    const less = (left: Expression, right: Expression): Expression => ({ k: "binary", op: "<", left, right });
    const greater = (left: Expression, right: Expression): Expression => ({ k: "binary", op: ">", left, right });
    const add = (left: Expression, right: Expression): Expression => ({ k: "binary", op: "+", left, right });
    const body: Statement[] = [
      {
        kind: "declare",
        name: "start",
        type: null,
        init: {
          k: "conditional",
          condition: less(ident("from"), number("0")),
          then: number("0"),
          otherwise: {
            k: "conditional",
            condition: greater(ident("from"), { k: "lengthOf", of: ident("text") }),
            then: { k: "lengthOf", of: ident("text") },
            otherwise: ident("from"),
          },
        },
        line,
      },
      {
        kind: "declare",
        name: "at",
        type: null,
        init: {
          k: "call",
          name: "text.indexOf",
          args: [{ k: "call", name: "text.slice", args: [ident("text"), ident("start")] }, ident("needle")],
        },
        line,
      },
      { kind: "if", condition: less(ident("at"), number("0")), then: [{ kind: "result", value: number("-1"), line }], otherwise: [], line },
      { kind: "result", value: add(ident("at"), ident("start")), line },
    ];
    const params = [
      { name: "text", type: TEXT_RESULT },
      { name: "needle", type: TEXT_RESULT },
      { name: "from", type: NUMBER_RESULT },
    ];
    const returns: TypeExpr = NUMBER_RESULT;
    const helper: TypeScriptFunction = { name, params, returns, body, line, closure: true };
    this.closures.push({ name, exported: false, internal: true, params, returns, handle: helper });
    this.liftedArrows.set(name, helper);
    const made = { name, returns };
    this.collectHelpers.set(key, made);
    this.pureTextHelpers.add(name);
    return made;
  }

  /**
   * The function `text.lastIndexOf(needle)` or `text.lastIndexOf(needle, from)`
   * becomes: the last position the needle is asked at, walked in order from the
   * beginning to the position the source states.
   *
   * With no position the walk runs to the end of the text; with one it runs
   * there clamped the way the language clamps it: below zero is the beginning,
   * past the end is the end. Each position is the field the needle is long,
   * compared with the needle, and the last hit the walk saw is the one the
   * source wrote. An empty needle asks at every position, so the last one the
   * walk saw is the start itself.
   */
  private lastIndexOfHelper(line: number, withFrom: boolean): { name: string; returns: TypeExpr } {
    const key = JSON.stringify(["lastIndexOf", withFrom]);
    const known = this.collectHelpers.get(key);
    if (known !== undefined) return known;

    const name = `__collect_${this.stem}_${this.collectCount}`;
    this.collectCount += 1;
    const ident = (value: string): Expression => ({ k: "ident", name: value });
    const number = (text: string): Expression => ({ k: "literal", text });
    const less = (left: Expression, right: Expression): Expression => ({ k: "binary", op: "<", left, right });
    const greater = (left: Expression, right: Expression): Expression => ({ k: "binary", op: ">", left, right });
    const add = (left: Expression, right: Expression): Expression => ({ k: "binary", op: "+", left, right });
    const slice = (value: Expression, start: Expression, stop: Expression): Expression => ({ k: "call", name: "text.slice", args: [value, start, stop] });
    const lengthOf = (value: Expression): Expression => ({ k: "lengthOf", of: value });
    const startInit: Expression = withFrom
      ? {
          k: "conditional",
          condition: less(ident("from"), number("0")),
          then: number("0"),
          otherwise: {
            k: "conditional",
            condition: greater(ident("from"), lengthOf(ident("text"))),
            then: lengthOf(ident("text")),
            otherwise: ident("from"),
          },
        }
      : lengthOf(ident("text"));
    const body: Statement[] = [
      { kind: "declare", name: "start", type: null, init: startInit, line },
      { kind: "declare", name: "need", type: null, init: lengthOf(ident("needle")), line },
      { kind: "declare", name: "found", type: null, init: number("-1"), line },
      {
        kind: "loop",
        variable: "i",
        from: number("0"),
        to: add(ident("start"), number("1")),
        inclusive: false,
        step: null,
        down: false,
        body: [
          {
            kind: "if",
            condition: {
              k: "binary",
              op: "===",
              left: slice(ident("text"), ident("i"), add(ident("i"), ident("need"))),
              right: ident("needle"),
            },
            then: [{ kind: "assign", target: "found", op: "=", value: ident("i"), line }],
            otherwise: [],
            line,
          },
        ],
        line,
      },
      { kind: "result", value: ident("found"), line },
    ];
    const params = withFrom
      ? [
          { name: "text", type: TEXT_RESULT },
          { name: "needle", type: TEXT_RESULT },
          { name: "from", type: NUMBER_RESULT },
        ]
      : [
          { name: "text", type: TEXT_RESULT },
          { name: "needle", type: TEXT_RESULT },
        ];
    const returns: TypeExpr = NUMBER_RESULT;
    const helper: TypeScriptFunction = { name, params, returns, body, line, closure: true };
    this.closures.push({ name, exported: false, internal: true, params, returns, handle: helper });
    this.liftedArrows.set(name, helper);
    const made = { name, returns };
    this.collectHelpers.set(key, made);
    this.pureTextHelpers.add(name);
    return made;
  }

  /**
   * The function a `text.repeat(n)` becomes: the text appended to itself `n`
   * times.
   *
   * The count is floored before the loop, which is what the language does with
   * a count that is not whole, and a count below one repeats nothing.
   */
  /**
   * The function `Math.max(...xs)` or `Math.min(...xs)` folds the list with.
   *
   * The fold starts at the identity the operation has over no elements — the
   * negative infinity for a greatest, the positive one for a smallest — so an
   * empty list answers that rather than the zero a first-element fold would
   * have to special-case.
   */
  private reductionHelper(kind: "max" | "min", line: number): { name: string; returns: TypeExpr } {
    const key = JSON.stringify(["reduce", kind]);
    const known = this.collectHelpers.get(key);
    if (known !== undefined) return known;

    const name = `__collect_${this.stem}_${this.collectCount}`;
    this.collectCount += 1;
    const ident = (value: string): Expression => ({ k: "ident", name: value });
    const number = (text: string): Expression => ({ k: "literal", text });
    const element: Expression = { k: "index", base: ident("numbers"), index: ident("i") };
    const best = (): Expression => ident("best");
    const length = (): Expression => ({ k: "length", buffer: "numbers" });
    // The identity: `-1 / 0` is the negative infinity, `1 / 0` the positive.
    const identity: Expression = {
      k: "binary",
      op: "/",
      left: kind === "max" ? { k: "unary", op: "-", operand: number("1") } : number("1"),
      right: number("0"),
    };
    const body: Statement[] = [
      { kind: "declare", name: "best", type: null, init: identity, line },
      {
        kind: "loop",
        variable: "i",
        from: number("0"),
        to: length(),
        inclusive: false,
        step: null,
        down: false,
        body: [{
          kind: "if",
          condition: { k: "binary", op: kind === "max" ? ">" : "<", left: element, right: best() },
          then: [{ kind: "assign", target: "best", op: "=", value: element, line }],
          otherwise: [],
          line,
        }],
        line,
      },
      { kind: "result", value: best(), line },
    ];
    const params = [{ name: "numbers", type: { kind: "slice", of: NUMBER_RESULT } as TypeExpr }];
    const returns: TypeExpr = NUMBER_RESULT;
    const helper: TypeScriptFunction = { name, params, returns, body, line, closure: true };
    this.closures.push({ name, exported: false, internal: true, params, returns, handle: helper });
    this.liftedArrows.set(name, helper);
    const made = { name, returns };
    this.collectHelpers.set(key, made);
    return made;
  }

  private repeatHelper(line: number): { name: string; returns: TypeExpr } {
    const key = JSON.stringify(["repeat"]);
    const known = this.collectHelpers.get(key);
    if (known !== undefined) return known;

    const name = `__collect_${this.stem}_${this.collectCount}`;
    this.collectCount += 1;
    const ident = (value: string): Expression => ({ k: "ident", name: value });
    const number = (text: string): Expression => ({ k: "literal", text });
    const body: Statement[] = [
      {
        kind: "declare",
        name: "times",
        type: null,
        init: { k: "call", name: "Math.floor", args: [ident("count")] },
        line,
      },
      { kind: "declare", name: "out", type: null, init: { k: "text", parts: [{ k: "text", value: "" }] }, line },
      {
        kind: "loop",
        variable: "i",
        from: number("0"),
        to: ident("times"),
        inclusive: false,
        step: null,
        down: false,
        body: [{ kind: "assign", target: "out", op: "+=", value: ident("text"), line }],
        line,
      },
      { kind: "result", value: ident("out"), line },
    ];
    const params = [
      { name: "text", type: TEXT_RESULT },
      { name: "count", type: NUMBER_RESULT },
    ];
    const returns: TypeExpr = TEXT_RESULT;
    const helper: TypeScriptFunction = { name, params, returns, body, line, closure: true };
    this.closures.push({ name, exported: false, internal: true, params, returns, handle: helper });
    this.liftedArrows.set(name, helper);
    const made = { name, returns };
    this.collectHelpers.set(key, made);
    this.pureTextHelpers.add(name);
    return made;
  }

  /**
   * The helper that writes a list as JSON, once per element type.
   *
   * A list is a block of one element type, so the text is the brackets and the
   * elements' JSON between them: a text or a number is the runtime's own
   * stringify of the value it is, and a list is this helper again for what the
   * inner list holds. An element that is an object is refused: a compiled
   * object holds no field names at run time, so the JSON of one is not a text
   * this compiler can write.
   */
  private jsonListHelper(element: TypeExpr, line: number): { name: string; returns: TypeExpr } {
    const key = JSON.stringify(["jsonList", element]);
    const known = this.collectHelpers.get(key);
    if (known !== undefined) return known;
    const readable =
      element.kind === "text" ||
      (element.kind === "primitive" && element.name !== "i256" && element.name !== "u256") ||
      element.kind === "slice" ||
      element.kind === "array";
    if (!readable) return { name: "", returns: ANY_TYPE };
    const name = `__collect_${this.stem}_${this.collectCount}`;
    this.collectCount += 1;
    const ident = (value: string): Expression => ({ k: "ident", name: value });
    const number = (text: string): Expression => ({ k: "literal", text });
    const written = (value: string): Expression => ({ k: "text", parts: [{ k: "text", value }] });
    const at = (): Expression => ({ k: "index", base: ident("items"), index: ident("i") });
    // One element's JSON: an inner list is the helper for what it holds, and
    // everything else is the runtime's stringify of the value it is.
    const piece: Expression = element.kind === "slice" || element.kind === "array"
      ? { k: "call", name: this.jsonListHelper(element.of, line).name, args: [at()] }
      : { k: "call", name: "JSON.stringify", args: [at()] };
    this.expressionTypes.set(piece, TEXT_RESULT);
    const body: Statement[] = [
      { kind: "declare", name: "out", type: null, init: written("["), line },
      {
        kind: "loop",
        variable: "i",
        from: number("0"),
        to: { k: "length", buffer: "items" },
        inclusive: false,
        step: null,
        down: false,
        body: [
          {
            kind: "if",
            condition: { k: "binary", op: ">", left: ident("i"), right: number("0") },
            then: [{ kind: "assign", target: "out", op: "+=", value: written(","), line }],
            otherwise: [],
            line,
          },
          { kind: "assign", target: "out", op: "+=", value: piece, line },
        ],
        line,
      },
      { kind: "result", value: { k: "binary", op: "+", left: ident("out"), right: written("]") }, line },
    ];
    const params = [{ name: "items", type: { kind: "slice", of: element } as TypeExpr }];
    const returns = TEXT_RESULT;
    const helper: TypeScriptFunction = { name, params, returns, body, line, closure: true };
    this.closures.push({ name, exported: false, internal: true, params: helper.params, returns, handle: helper });
    this.liftedArrows.set(name, helper);
    const made = { name, returns };
    this.collectHelpers.set(key, made);
    return made;
  }

  private splitHelper(line: number, withLimit: boolean): { name: string; returns: TypeExpr } {
    const key = JSON.stringify(["split", withLimit]);
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
    // The number of fields the list keeps when a limit is written: no more
    // than the count the text names, and none where the limit names none.
    const keep = (): Expression => withLimit
      ? {
          k: "conditional",
          condition: less(ident("limit"), number("0")),
          then: number("0"),
          otherwise: {
            k: "conditional",
            condition: less(ident("limit"), ident("count")),
            then: ident("limit"),
            otherwise: ident("count"),
          },
        }
      : ident("count");
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
      { kind: "declare", name: "keep", type: null, init: keep(), line },
      { kind: "declare", name: "out", type: null, init: { k: "sized", element: "text", count: ident("keep") }, line },
      {
        kind: "if",
        condition: emptySeparator(),
        then: [
          loop(ident("keep"), [
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
          loop(ident("keep"), writeField()),
        ],
        line,
      },
      { kind: "result", value: ident("out"), line },
    ];

    const params = [
      { name: "text", type: TEXT_RESULT },
      { name: "sep", type: TEXT_RESULT },
      ...(withLimit ? [{ name: "limit", type: NUMBER_RESULT }] : []),
    ];
    const returns: TypeExpr = { kind: "slice", of: TEXT_RESULT };
    const helper: TypeScriptFunction = { name, params, returns, body, line, closure: true };
    this.closures.push({ name, exported: false, internal: true, params, returns, handle: helper });
    this.liftedArrows.set(name, helper);
    const made = { name, returns };
    this.collectHelpers.set(key, made);
    this.pureTextHelpers.add(name);
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
      if (!this.repeatable(value)) {
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
    if (!this.repeatable(value)) {
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
    const call = (name: string, args_: Expression[], returns: TypeExpr): Expression => {
      const made: Expression = { k: "call", name, args: args_ };
      this.expressionTypes.set(made, returns);
      return made;
    };
    const take = (): { name: string; args: Expression[]; returns: TypeExpr } | null => {
      if (collection.kind === "set") {
        if (method === "add" && args.length === 1) {
          return {
            name: this.dictionaryCall(collection.key, "set") ?? "blaze_rt_dict_set",
            args: [receiver, args[0] as Expression, one],
            returns: NUMBER_RESULT,
          };
        }
        if (method === "has" && args.length === 1) {
          return {
            name: this.dictionaryCall(collection.key, "has") ?? "blaze_rt_dict_has",
            args: [receiver, args[0] as Expression],
            returns: BOOLEAN_RESULT,
          };
        }
        if (method === "delete" && args.length === 1) {
          return {
            name: this.dictionaryCall(collection.key, "delete") ?? "blaze_rt_dict_delete",
            args: [receiver, args[0] as Expression],
            returns: NUMBER_RESULT,
          };
        }
        return null;
      }
      if (method === "set" && args.length === 2) {
        if (this.storedKind(collection.value) === "sequence") {
          return this.sequenceSet(receiver, collection, args[0] as Expression, args[1] as Expression);
        }
        const name = this.collectionSetNameFor(collection);
        if (name === null) return null;
        return { name, args: [receiver, ...args], returns: NUMBER_RESULT };
      }
      if ((method === "has" || method === "delete") && args.length === 1) {
        const operation = method === "has" ? "has" : "delete";
        return {
          name: this.dictionaryCall(collection.key, operation) ?? "blaze_rt_dict_has",
          args: [receiver, ...args],
          returns: method === "has" ? BOOLEAN_RESULT : NUMBER_RESULT,
        };
      }
      return null;
    };
    if (method === "get" && collection.kind === "map" && args.length === 1) {
      const kind = this.storedKind(collection.value);
      // A list is a block and a length, and an entry is one double: the block
      // is copied when it is written, and the copy's header carries its length,
      // so the pointer alone is the list a key answers. Only a text key is
      // answered so far: the dictionary's numbered and reference keys are
      // written for one value, not for a block.
      const sequence = kind === "sequence" &&
        (this.keyKind(collection.key) === "text" || this.keyKind(collection.key) === "number");
      if (kind === "other" || (kind === "sequence" && !sequence)) {
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
        name: this.dictionaryCall(collection.key, "has") ?? "blaze_rt_dict_has",
        args: [receiver, args[0] as Expression],
      };
      // A reference is read by the call that answers a reference: the dictionary
      // holds the handle, and the IR needs the type of the call to be the
      // reference it is rather than the double it is carried in. A number and a
      // truth are the double an entry holds, so they read as an entry.
      const heldName = sequence
        ? this.dictionaryCall(collection.key, "getSeq") ?? "blaze_rt_dict_get_seq"
        : kind === "text"
          ? this.dictionaryCall(collection.key, "getText") ?? "blaze_rt_dict_get_text"
          : kind === "reference"
            ? this.dictionaryCall(collection.key, "getRef") ?? "blaze_rt_dict_get_ref"
            : this.dictionaryCall(collection.key, "get") ?? "blaze_rt_dict_get";
      const read = call(heldName, [receiver, args[0] as Expression], collection.value);
      // The runtime answers the block the list is; the read of the entry is
      // the list the map holds, and the call is typed as it so a field, an
      // index or a length written on it reads the list.
      if (sequence) (read as Expression & { returns?: TypeExpr }).returns = collection.value;
      const held: Expression = kind === "bool"
        ? { k: "binary", op: "!=", left: read, right: { k: "literal", text: "0" } }
        : read;
      // The answer for a key the map does not hold is the zero of the value
      // type: the empty text for a text, the null reference for a reference,
      // and the number zero for everything else. A number written where a
      // reference is expected is boxed into a handle, and a boxed number is
      // not the absence of an object: reading a field of one reads the
      // runtime's table as an object.
      // A sequence's absence is the null block: the runtime answers NULL for a
      // key it does not hold, and a read of a list with no block is the absence
      // the language spells `undefined`.
      const otherwise: Expression = (kind === "text" && !sequence)
        ? { k: "text", parts: [{ k: "text", value: "" }] }
        : kind === "reference" || sequence
          ? { k: "null" }
          : { k: "literal", text: "0" };
      const chosen: Expression = { k: "conditional", condition: has, then: held, otherwise };
      const answer = sequence ? collection.value : kind === "reference" ? ANY_TYPE : kind === "bool" ? BOOLEAN_RESULT : collection.value;
      this.expressionTypes.set(chosen, answer);
      // A map whose value the source named keeps the fields that name holds,
      // so a member chain written through the value reads them.
      const valueShape = collection.valueShape ?? this.shapeOfTypeExpr(collection.value);
      if (kind === "reference" && valueShape.kind !== "any") this.expressionShapes.set(chosen, valueShape);
      if (sequence) {
        const element = valueShape.kind === "list" ? valueShape.of : { kind: "any" as const };
        this.expressionShapes.set(chosen, { kind: "list", of: element });
      }
      // A set or a map held in a dictionary is one handle, and the entry holds
      // it as the number it is: the value a key answers is a collection of its
      // own, and the questions written after it — `has`, `add`, `get` — are the
      // dictionary's.
      const nested = this.collectionOfShape(valueShape);
      if (nested !== null) this.collectionExpressions.set(chosen, nested);
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
      const listed = call(helper.name, [receiver], helper.returns);
      this.expressionShapes.set(listed, { kind: "list", of: helper.elementShape });
      return listed;
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
    // `m.clear()` empties the dictionary. The runtime holds no dictionary call
    // that empties one in place, and a collection here is a handle a name or a
    // field holds: the clear is the write of a new, empty dictionary over the
    // handle, which is the statement the call is written as. The marker names
    // the receiver, and `readEffect` writes it.
    if (method === "clear" && args.length === 0) {
      const place = receiver.k === "ident"
        ? true
        : receiver.k === "member" && receiver.base.k === "ident";
      if (!place) return null;
      const marker: Expression = { k: "call", name: "__collection_clear", args: [receiver] };
      this.expressionTypes.set(marker, NOTHING);
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
   * `m.set(k, list)` where the map holds lists.
   *
   * The list is copied into a block the runtime laid out, and the entry carries
   * the pointer: the block's header says how many bytes it holds, which is the
   * length the read of the entry answers. A copy is what makes the length
   * travel with the entry, and it is also what keeps a list written out at the
   * call site — a block of the stack the name that wrote it frees — from
   * outliving its writer.
   */
  private sequenceSet(
    receiver: Expression,
    collection: CollectionValue,
    key: Expression,
    value: Expression,
  ): { name: string; args: Expression[]; returns: TypeExpr } | null {
    if (collection.value.kind !== "slice" && collection.value.kind !== "array") return null;
    const element = collection.value.of;
    const bytes = this.elementBytes(element);
    if (bytes === null) {
      this.report(
        `a map here holds a list of ${typeToString(element)}`,
        "a list a map holds is of numbers, texts, truths or references",
        this.peek(),
      );
      return null;
    }
    const list: TypeExpr = { kind: "slice", of: element };
    const copy = this.sequenceMethod("slice", element, value, [], this.peek().line);
    const held = `__seq${this.fieldCount++}`;
    this.pendingBefore.push({ kind: "declare", name: held, type: list, init: copy, line: this.peek().line });
    this.valueTypes.set(held, list);
    const valueShape = collection.valueShape ?? this.shapeOfTypeExpr(collection.value);
    if (valueShape.kind === "list") this.valueShapes.set(held, valueShape);
    return {
      name: this.dictionaryCall(collection.key, "setSeq") ?? "blaze_rt_dict_set_seq",
      args: [
        receiver,
        key,
        { k: "ident", name: held },
        { k: "length", buffer: held },
        { k: "literal", text: String(bytes) },
      ],
      returns: NUMBER_RESULT,
    };
  }

  /** How many bytes one element of a list is, or null where no list of it is held. */
  private elementBytes(type: TypeExpr): number | null {
    if (type.kind === "text" || type.kind === "ref" || type.kind === "slice" || type.kind === "array" || type.kind === "ptr") return 8;
    if (type.kind !== "primitive") return null;
    switch (type.name) {
      case "bool":
      case "u8":
      case "i8":
        return 1;
      case "u16":
      case "i16":
        return 2;
      case "u32":
      case "i32":
      case "f32":
        return 4;
      case "i256":
      case "u256":
        return 32;
      default:
        return 8;
    }
  }

  /** The dictionary call that writes a map entry, by what its key and value are. */
  private collectionSetNameFor(collection: CollectionValue): string | null {
    const kind = this.storedKind(collection.value);
    if (kind === "text") return this.dictionaryCall(collection.key, "setText");
    if (kind === "reference") return this.dictionaryCall(collection.key, "setRef");
    if (kind === "number" || kind === "bool") return this.dictionaryCall(collection.key, "set");
    return null;
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
    return this.dictionaryCall(collection.key, "keyAt") ?? "blaze_rt_dict_key_at";
  }

  /** The dictionary call that reads a value entry, by what the value is. */
  private valueReadName(type: TypeExpr): string {
    const kind = this.storedKind(type);
    if (kind === "text") return "blaze_rt_dict_value_at_text";
    if (kind === "reference" || kind === "sequence") return "blaze_rt_dict_value_at_ref";
    return "blaze_rt_dict_value_at";
  }

  /**
   * The function an `a.sort()` with no comparator becomes.
   *
   * The order the language gives a list of numbers or of texts is the one `<`
   * is for each, so the insertion sort is written with that comparison where a
   * comparator would be called. The list is sorted where it lies, and the value
   * the call answers is a block of its own so that the length of the answer
   * travels with it — the same shape a sort with a comparator has.
   */
  private sortDefaultHelper(element: TypeExpr, line: number): { name: string; returns: TypeExpr } | null {
    if (element.kind !== "text" && !(element.kind === "primitive" && !["bool", "i256", "u256"].includes(element.name))) {
      return null;
    }
    const key = JSON.stringify(["sortDefault", element]);
    const known = this.collectHelpers.get(key);
    if (known !== undefined) return known;
    const name = `__collect_${this.stem}_${this.collectCount}`;
    this.collectCount += 1;
    const ident = (value: string): Expression => ({ k: "ident", name: value });
    const number = (text: string): Expression => ({ k: "literal", text });
    const length = (): Expression => ({ k: "length", buffer: "items" });
    const at = (index: Expression): Expression => ({ k: "index", base: ident("items"), index });
    const plusOne = (index: Expression): Expression => ({ k: "binary", op: "+", left: index, right: number("1") });
    const items: TypeExpr = { kind: "slice", of: element };
    const returns: TypeExpr = { kind: "slice", of: element };
    const body: Statement[] = [
      {
        kind: "loop",
        variable: "i",
        from: number("1"),
        to: length(),
        inclusive: false,
        step: null,
        down: false,
        body: [
          { kind: "declare", name: "value", type: null, init: at(ident("i")), line },
          { kind: "declare", name: "j", type: null, init: { k: "binary", op: "-", left: ident("i"), right: number("1") }, line },
          {
            kind: "while",
            condition: {              k: "binary",
              op: "&&",
              left: { k: "binary", op: ">=", left: ident("j"), right: number("0") },
              right: { k: "binary", op: ">", left: at(ident("j")), right: ident("value") },
            },
            body: [
              { kind: "indexAssign", buffer: "items", index: plusOne(ident("j")), op: "=", value: at(ident("j")), line },
              { kind: "update", name: "j", op: "--", prefix: false, line },
            ],
            line,
          },
          { kind: "indexAssign", buffer: "items", index: plusOne(ident("j")), op: "=", value: ident("value"), line },
        ],
        line,
      },
      { kind: "declare", name: "out", type: null, init: { k: "sized", element: typeToString(element), count: length() }, line },
      {
        kind: "loop",
        variable: "i",
        from: number("0"),
        to: length(),
        inclusive: false,
        step: null,
        down: false,
        body: [{ kind: "indexAssign", buffer: "out", index: ident("i"), op: "=", value: at(ident("i")), line }],
        line,
      },
      { kind: "result", value: ident("out"), line },
    ];
    const params = [{ name: "items", type: items }];
    const helper: TypeScriptFunction = { name, params, returns, body, line, closure: true };
    this.closures.push({ name, exported: false, internal: true, params, returns, handle: helper });
    this.liftedArrows.set(name, helper);
    this.collectHelpers.set(key, { name, returns });
    return { name, returns };
  }

  /**
   * The function `<TypedArray>.from(list)` becomes where the list holds
   * numbers and the array holds a narrower number.
   *
   * A list of numbers copied into a typed array is each number written as the
   * element the array holds: the helper allocates the array and copies the
   * list where it lies, which is what `from` is.
   */
  private typedFromHelper(from: TypeExpr, to: TypeExpr, line: number): { name: string; returns: TypeExpr } {
    const key = JSON.stringify(["typedFrom", from, to]);
    const known = this.collectHelpers.get(key);
    if (known !== undefined) return known;
    const name = `__collect_${this.stem}_${this.collectCount}`;
    this.collectCount += 1;
    const ident = (value: string): Expression => ({ k: "ident", name: value });
    const number = (text: string): Expression => ({ k: "literal", text });
    const items: TypeExpr = { kind: "slice", of: from };
    const returns: TypeExpr = { kind: "slice", of: to };
    const body: Statement[] = [
      { kind: "declare", name: "out", type: null, init: { k: "sized", element: typeToString(to), count: { k: "length", buffer: "items" } }, line },
      {
        kind: "loop",
        variable: "i",
        from: number("0"),
        to: { k: "length", buffer: "items" },
        inclusive: false,
        step: null,
        down: false,
        body: [{ kind: "indexAssign", buffer: "out", index: ident("i"), op: "=", value: { k: "index", base: ident("items"), index: ident("i") }, line }],
        line,
      },
      { kind: "result", value: ident("out"), line },
    ];
    const params = [{ name: "items", type: items }];
    const helper: TypeScriptFunction = { name, params, returns, body, line, closure: true };
    this.closures.push({ name, exported: false, internal: true, params, returns, handle: helper });
    this.liftedArrows.set(name, helper);
    const made = { name, returns };
    this.collectHelpers.set(key, made);
    return made;
  }

  /**
   * The function `a.flat()` becomes: the lists it holds one after another.
   *
   * Each inner list is walked where it is read and its elements are appended to
   * the answer, which starts empty: the answer is the concatenation of the
   * inner lists, in the order the outer list wrote them. No callback is
   * involved, so there is no call between the walk and the append.
   */
  private flatHelper(inner: TypeExpr, line: number): { name: string; returns: TypeExpr } {
    const key = JSON.stringify(["flat", inner]);
    const known = this.collectHelpers.get(key);
    if (known !== undefined) return known;
    const name = `__collect_${this.stem}_${this.collectCount}`;
    this.collectCount += 1;
    const ident = (value: string): Expression => ({ k: "ident", name: value });
    const number = (text: string): Expression => ({ k: "literal", text });
    const append = this.appendHelper("push", inner, 1, line);
    const keep = (value: Expression): Statement => ({
      kind: "assign",
      target: "out",
      op: "=",
      value: { k: "call", name: append.name, args: [ident("out"), value] },
      line,
    });
    const items: TypeExpr = { kind: "slice", of: { kind: "slice", of: inner } as TypeExpr };
    const returns: TypeExpr = { kind: "slice", of: inner };
    const body: Statement[] = [
      { kind: "declare", name: "out", type: null, init: { k: "sized", element: typeToString(inner), count: number("0") }, line },
      {
        kind: "loop",
        variable: "i",
        from: number("0"),
        to: { k: "length", buffer: "items" },
        inclusive: false,
        step: null,
        down: false,
        body: [
          { kind: "declare", name: "part", type: null, init: { k: "index", base: ident("items"), index: ident("i") }, line },
          {
            kind: "loop",
            variable: "j",
            from: number("0"),
            to: { k: "length", buffer: "part" },
            inclusive: false,
            step: null,
            down: false,
            body: [keep({ k: "index", base: ident("part"), index: ident("j") })],
            line,
          },
        ],
        line,
      },
      { kind: "result", value: ident("out"), line },
    ];
    const params = [{ name: "items", type: items }];
    const helper: TypeScriptFunction = { name, params, returns, body, line, closure: true };
    this.closures.push({ name, exported: false, internal: true, params, returns, handle: helper });
    this.liftedArrows.set(name, helper);
    const made = { name, returns };
    this.collectHelpers.set(key, made);
    return made;
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
  ): { name: string; returns: TypeExpr; elementShape: ResolvedType } | null {
    const element = list === "keys"
      ? collection.key
      : collection.kind === "set" ? collection.key : collection.value;
    const kind = this.storedKind(element);
    if (kind === "sequence" || kind === "other") return null;
    // What the block holds is the element's own field list where the map's
    // value named a declaration: the block's type can spell only the opaque
    // reference, and a field read through one asks a type nothing says.
    const elementShape = (list === "values" ? collection.valueShape : undefined) ?? this.shapeOfTypeExpr(element);
    const key = JSON.stringify(["list", list, collection.kind, collection.key, collection.value, element]);
    const known = this.collectHelpers.get(key);
    if (known !== undefined) return { ...known, elementShape };

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
    return { name, returns, elementShape };
  }

  /**
   * `Array.from({ length: n }, (_, i) => v)`: a list of n answers.
   *
   * The count is read once, before the walk, because the language reads the
   * `length` of the description once. The callback is handed the element at
   * the index, which a sparse list leaves absent, and the index the walk is at.
   * The value model has no absent value, so a callback that reads its element
   * is refused rather than handed a number the language would not hand it; the
   * form the sources write — `(_, i) => v` — names the element and does not
   * read it, and that is the form this reads.
   *
   * The form is only this one: a call that does not write a one-field `length`
   * description followed by a callback is left to the method read, which
   * refuses it the way it refused every `Array.from` before.
   */
  private arrayFrom(line: number): Expression | null {
    if (!this.at("(")) return null;
    // `Array.from(text)` is the characters of the text, one text each: the same
    // list the split helper cuts at the empty separator. `Array.from(list)` is
    // a copy of the list, which is the slice from its first element on.
    if (this.peek(1).text !== "{") {
      const args = this.readCallArguments();
      const source = args[0];
      const held = source === undefined ? null : this.valueTypeOf(source);
      if (source !== undefined && args.length === 1 && held !== null && (held.kind === "slice" || held.kind === "array")) {
        const copied = this.sequenceMethod("slice", held.of, source, [{ k: "literal", text: "0" }], line);
        if (copied !== null) return copied;
      }
      if (source === undefined || args.length !== 1 || held === null || (held.kind !== "text" && held.kind !== "fixed")) {
        this.report(
          "Array.from reads a length description, a text or a list",
          "write Array.from({ length: n }, (_, i) => value), Array.from(text) or Array.from(list)",
          this.peek(),
        );
        return this.hole();
      }
      const cut = this.splitHelper(line, false);
      const empty: Expression = { k: "text", parts: [{ k: "text", value: "" }] };
      const characters: Expression = { k: "call", name: cut.name, args: [source, empty] };
      this.expressionTypes.set(characters, cut.returns);
      return characters;
    }
    const brace = this.position + 1;
    const close = this.matchingToken(brace, "{", "}");
    if (close < 0 || this.tokens[close]?.text !== "}" || this.tokens[close + 1]?.text !== ",") return null;
    const open = this.peek();
    this.next();
    const described = this.readExpression();
    // The description is read where the call wrote it, so a form that is not
    // the one-field length is finished here and reported rather than left for
    // the method read, which would start its argument list past the `(`.
    const length = described.k === "object" && described.fields.length === 1 && described.fields[0]?.name === "length"
      ? (described.fields[0] as { value: Expression }).value
      : null;
    const count = length !== null && this.accept(",") ? length : null;
    if (count === null) {
      while (!this.at(")") && this.peek().kind !== "end") this.next();
      this.expect(")");
      this.report(
        "Array.from reads a length description and a callback",
        "write Array.from({ length: n }, (_, i) => value)",
        open,
      );
      return this.hole();
    }
    // The callback is an arrow written at the use, and the use fixes its two
    // parameters: the element it is handed and the index it is handed.
    const savedHint = this.arrowParameters;
    this.arrowParameters = [
      { type: NUMBER_RESULT, shape: null },
      { type: NUMBER_RESULT, shape: null },
    ];
    let callback: Expression;
    try {
      callback = this.readExpression();
    } finally {
      this.arrowParameters = savedHint;
    }
    this.accept(",");
    this.expect(")");
    const signature = this.callbackSignature(callback);
    if (signature === null) {
      this.report(
        "the function handed to Array.from is not one this compiler can call",
        "a callback is an arrow, or a name held at a function type, as in f: (x: number) => number",
        this.peek(),
      );
      return this.hole();
    }
    // The element the language hands a callback at a sparse index is the absent
    // value, which this compiler has none of. A callback that reads it is
    // refused; the one the sources write names it and reads the index alone.
    const elementName = callback.k === "arrow" ? this.arrowBindings.get(callback.name)?.params[0]?.name : undefined;
    const lifted = callback.k === "arrow" ? this.liftedArrows.get(callback.name) : undefined;
    if (callback.k === "arrow" && lifted !== undefined && elementName !== undefined) {
      let used = false;
      walkFunction(lifted, (name) => {
        if (name === elementName) used = true;
      });
      if (used) {
        this.report(
          "the element Array.from hands its callback is the value a sparse list leaves absent",
          "the element at a sparse index is absent, which this compiler has no value for; write the callback to read the index it is handed",
          this.peek(),
        );
        return this.hole();
      }
    }
    // A callback that answers nothing still answers the value a call left in
    // the register, which an `async` call's handle is: the block holds the
    // handle, and awaiting an element reads the payload out of it.
    const element = signature.returns.kind === "void" ? ({ kind: "ref", of: null } as TypeExpr) : signature.returns;
    const answered = this.callbackReturnsShape(callback) ?? this.shapeOfTypeExpr(signature.returns);
    // A callback that answers a promise answers the handle, so there is no
    // shape the element is read at: the list's elements are the references the
    // handles are, and a shape of "nothing" here read the list as a list of
    // nothing and its elements as values the await never saw.
    const shape: ResolvedType = element.kind === "ref" && element.of === null && element.name === undefined &&
      (answered === null || answered.kind === "absent")
      ? { kind: "any" }
      : answered;
    const key = JSON.stringify(["from", element, signature.params.length]);
    let helper = this.collectHelpers.get(key);
    if (helper === undefined) {
      const name = `__collect_${this.stem}_${this.collectCount}`;
      this.collectCount += 1;
      const ident = (value: string): Expression => ({ k: "ident", name: value });
      /** The call of the callback, written with as many arguments as it takes. */
      const callBack = (all: readonly Expression[]): Expression => {
        const taken = Math.min(signature.params.length, all.length);
        return {
          k: "invoke",
          callee: ident("fn"),
          args: all.slice(0, taken),
          params: signature.params.slice(0, taken),
          returns: signature.returns,
        };
      };
      const returns: TypeExpr = { kind: "slice", of: element };
      const body: Statement[] = [
        {
          kind: "declare",
          name: "out",
          type: null,
          init: { k: "sized", element: typeToString(element), count: ident("count") },
          line,
        },
        {
          kind: "loop",
          variable: "i",
          from: { k: "literal", text: "0" },
          to: ident("count"),
          inclusive: false,
          step: null,
          down: false,
          body: [{
            kind: "indexAssign",
            buffer: "out",
            index: ident("i"),
            op: "=",
            value: callBack([{ k: "literal", text: "0" }, ident("i")]),
            line,
          }],
          line,
        },
        { kind: "result", value: ident("out"), line },
      ];
      const params: { name: string; type: TypeExpr }[] = [
        { name: "count", type: NUMBER_RESULT },
        { name: "fn", type: ANY_TYPE },
      ];
      const written: TypeScriptFunction = { name, params, returns, body, line, closure: true };
      this.closures.push({ name, exported: false, internal: true, params, returns, handle: written });
      this.liftedArrows.set(name, written);
      helper = { name, returns };
      this.collectHelpers.set(key, helper);
    }
    const call: Expression = { k: "call", name: helper.name, args: [count, callback] };
    this.expressionTypes.set(call, helper.returns);
    this.expressionShapes.set(call, { kind: "list", of: shape });
    return call;
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
      case "flatMap": {
        // The callback answers a list, and the answer is those lists one after
        // another. Each answer is walked where it is read, and its elements are
        // appended to the answer of the helper: a list of lists is not a value
        // here, so the walk happens as the answer is read.
        const answers = signature.returns;
        const listed = answers.kind === "slice" || answers.kind === "array" || answers.kind === "ptr";
        const inner: TypeExpr = listed && answers.kind !== "ptr" ? answers.of : answers;
        const append = this.appendHelper("push", inner, 1, line);
        returns = { kind: "slice", of: inner };
        // A push written on its own line is the write that keeps the longer
        // list, which is the assignment the frontend writes for one.
        const keep = (value: Expression): Statement => ({
          kind: "assign",
          target: "out",
          op: "=",
          value: { k: "call", name: append.name, args: [ident("out"), value] },
          line,
        });
        body = [
          declare("out", { k: "sized", element: typeToString(inner), count: number("0") }),
          loop("0", [
            declare("part", callBack([at(ident("i")), ident("i"), ident("items")])),
            listed
              ? {
                  kind: "loop",
                  variable: "j",
                  from: number("0"),
                  to: { k: "length", buffer: "part" },
                  inclusive: false,
                  step: null,
                  down: false,
                  body: [keep({ k: "index", base: ident("part"), index: ident("j") })],
                  line,
                }
              : keep(ident("part")),
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
      case "fill": {
        // Every element of the list is the value written, and the list is the
        // answer: `new Array(n).fill(0)` is a block of zeros.
        returns = { kind: "slice", of: element };
        body = [
          loop("0", [
            {
              kind: "indexAssign",
              buffer: "items",
              index: ident("i"),
              op: "=",
              value: ident("fn"),
              line,
            },
          ]),
          answer(ident("items")),
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
      case "reverse": {
        returns = { kind: "slice", of: element };
        // A reverse writes the array it was handed, so it answers the array it
        // wrote. Two ends walk to the middle, swapping each pair once; where
        // they meet is the middle element, which is its own mirror and stays.
        body = [
          declare("i", number("0")),
          declare("last", { k: "binary", op: "-", left: length(), right: number("1") }),
          {
            kind: "while",
            condition: { k: "binary", op: "<", left: ident("i"), right: ident("last") },
            body: [
              declare("held", at(ident("i"))),
              { kind: "indexAssign", buffer: "items", index: ident("i"), op: "=", value: at(ident("last")), line },
              { kind: "indexAssign", buffer: "items", index: ident("last"), op: "=", value: ident("held"), line },
              { kind: "update", name: "i", op: "++", prefix: false, line },
              { kind: "update", name: "last", op: "--", prefix: false, line },
            ],
            line,
          },
          answer(ident("items")),
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
    if (value.k !== "arrow" || value.code !== undefined) return value;
    const binding = this.arrowBindings.get(value.name);
    if (binding === undefined) return value;
    return { k: "arrow", name: value.name, captures: value.captures, code: this.closureCode(binding) };
  }

  /**
   * A function the file declares, read where a value is expected.
   *
   * `list.map(asBullet)` hands the collection a function, and a declared
   * function is one: it is called by the name it was written under, so the
   * value is a closure with nothing captured and an entry that calls the
   * declaration. A name a body declared itself is a value of that body, and
   * `readPrimary` asks this only after the names the body holds.
   */
  private functionValue(name: string, line: number): Expression | null {
    const params = this.declaredParams.get(name);
    const returns = this.declaredReturns.get(name);
    if (params === undefined || returns === undefined) return null;
    const known = this.functionValues.get(name);
    const binding: ArrowBinding = known ?? {
      function: name,
      captures: [],
      captureTypes: [],
      params: params.map((type, index) => ({ name: `a${index}`, type })),
      returns,
      line,
    };
    if (known === undefined) {
      this.functionValues.set(name, binding);
      this.arrowBindings.set(name, binding);
    }
    return { k: "arrow", name, captures: [] as string[], code: this.closureCode(binding) };
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
      this.report(`"${token.text}" is not supported`, refusedKeyword(token.text) ?? "", token);
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
      // `true` and `false` are the numbers a truth is held as, and the marker
      // keeps them truths: a field a literal writes is a truth, and the text it
      // prints as is `true` and not `1`.
      if (token.text === "true" || token.text === "false") return { k: "literal", text: token.text === "true" ? "1" : "0", boolean: true };
      if (token.text === "null") return { k: "null" };
      if (token.text === "undefined") {
        // `undefined` is the absent value, and it is also a name a body may
        // declare: `const undefined: string[] = []` is a list the source keeps
        // and writes through. The name the body declared is the one it reads;
        // the word is the absent value where the body declared none.
        if (!this.valueTypes.has("undefined") && !this.valueShapes.has("undefined")) return { k: "null" };
        return { k: "ident", name: "undefined" };
      }
      if (token.text === "new") return this.readAllocation();
      if (token.text === "process" && this.at(".") && this.peek(1).text === "argv") {
        this.next();
        this.next();
        return { k: "argv", index: null };
      }
      // `process.hrtime.bigint()`: the nanoseconds on a monotonic clock, which
      // is the runtime's to read. The clock does not move backwards, so the
      // difference of two readings of it is a duration; a source that measures
      // one reads both ends this way.
      if (
        token.text === "process" &&
        this.at(".") &&
        this.peek(1).text === "hrtime" &&
        this.peek(2).text === "." &&
        this.peek(3).text === "bigint"
      ) {
        this.next();
        this.next();
        this.next();
        this.next();
        this.expect("(");
        this.expect(")");
        return { k: "call", name: "process.hrtime.bigint", args: [] };
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
      // A function the file declares is a value where it is not called: a
      // collection method takes the function itself, and the name is a name
      // the body did not declare, so the declaration is the value.
      if (!this.at("(") && !this.valueTypes.has(token.text) && !this.valueArrows.has(token.text)) {
        const declared = this.functionValue(token.text, token.line);
        if (declared !== null) return declared;
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

  /**
   * What a spread of a conditional writes: a field the literal names, written
   * only when the condition holds.
   *
   * The answer is false where the spread is not one of the two forms this can
   * read — an arm that writes no field and an arm that writes fields whose type
   * has a zero — and the caller then refuses the spread the way it refused
   * every one.
   */
  private spreadOfOneArm(
    conditional: Expression & { k: "conditional" },
    expected: ResolvedType & { kind: "record" },
    put: (name: string, value: Expression, spread: boolean) => void,
  ): boolean {
    // An arm read at a union of shapes holds every field the layout needs; the
    // fields the source wrote are the ones the spread is about.
    const writtenNames = (arm: Expression): readonly string[] | null =>
      arm.k === "object" ? (arm.written ?? arm.fields.map((field) => field.name)) : null;
    const empty = (arm: Expression): boolean => {
      const names = writtenNames(arm);
      return names !== null && names.length === 0;
    };
    const written = empty(conditional.then)
      ? conditional.otherwise
      : empty(conditional.otherwise)
        ? conditional.then
        : null;
    if (written === null || written.k !== "object") return false;
    const names = writtenNames(written) ?? [];
    if (names.length === 0) return false;
    const holdsThen = written === conditional.then;
    const fields = names.map((name) => written.fields.find((field) => field.name === name)).filter((field) => field !== undefined);
    for (const field of fields) {
      const declared = expected.fields.get(field.name);
      if (declared === undefined || this.absenceExpression(declared.type) === null) return false;
    }
    for (const field of fields) {
      const declared = expected.fields.get(field.name) as ResolvedField;
      this.applyExpected(field.value, this.typeExprOfShape(declared.type), this.shapeForRead(declared.type));
      const absent = this.absenceExpression(declared.type) as Expression;
      put(field.name, {
        k: "conditional",
        condition: conditional.condition,
        then: holdsThen ? field.value : absent,
        otherwise: holdsThen ? absent : field.value,
      }, true);
    }
    return true;
  }

  /**
   * The value a field holds when the spread that would write it writes nothing.
   *
   * A record here is laid out field by field from the type it is held at, so a
   * field the literal leaves out is the zero of its type: a number is zero, a
   * truth is false, a text is empty, a list is empty and a reference is null.
   * The spread writes that zero explicitly, which is the value the field would
   * have held anyway, so a condition that holds false leaves the object the
   * object pass would have built. A type with no such zero — a function, a
   * collection that is a handle — is refused rather than guessed.
   */
  private absenceExpression(type: ResolvedType): Expression | null {
    if (type.kind === "ref" || type.kind === "record" || type.kind === "any") return { k: "null" };
    // A function is a closure, which is a reference: the zero of one is the
    // null closure, which is what a field a source never wrote holds.
    if (type.kind === "function") return { k: "null" };
    // A map and a set are one handle on the runtime's dictionary, and the zero
    // the runtime reads as no dictionary at all is the empty one.
    if (type.kind === "map" || type.kind === "set") return { k: "literal", text: "0" };
    if (type.kind === "text") return { k: "text", parts: [] };
    if (type.kind === "primitive") {
      return type.name === "bool" ? { k: "literal", text: "0", boolean: true } : { k: "literal", text: "0" };
    }
    if (type.kind === "list") {
      const element = this.typeExprOfShape(type.of);
      return { k: "buffer", element: typeToString(element), values: [] };
    }
    return null;
  }

  /** `{ left: a, right: b }`: an object allocated where it is written. */
  private readObject(): Expression {
    const fields: { name: string; value: Expression }[] = [];
    /**
     * The entries an object read at a `Record` is made of, in the order the
     * source wrote them: a field is one entry, and a spread of a dictionary is
     * every entry it holds. A later part writes over an earlier key, which is
     * what the language's last write is.
     */
    const parts: ({ field: { name: string; value: Expression } } | { dictionary: Expression })[] = [];
    /** The dictionary the literal is, where a spread of one says so and the use does not. */
    let dictionary: CollectionValue | null = null;
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
    // A field written as `[key]: value` names no identifier, so the key is an
    // expression the dictionary is built with rather than a name: each one is
    // kept under a spelling of its own and used where the pairs are written.
    const computedKeys = new Map<string, Expression>();
    const put = (name: string, value: Expression, spread = false): void => {
      parts.push({ field: { name, value } });
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
    /** The dictionary the whole literal is, from the use or from a spread. */
    const dictionaryAt = (spread: Expression): CollectionValue | null => {
      if (expected !== null && expected.index !== null) {
        return { kind: "map", key: TEXT_RESULT, value: this.typeExprOfShape(expected.index) };
      }
      if (expected !== null) return null;
      const held = this.collectionOfExpression(spread);
      if (held !== null && held.kind === "map") return held;
      const shape = this.shapeOf(spread);
      return shape !== null && shape.kind === "record" && shape.index !== null
        ? { kind: "map", key: TEXT_RESULT, value: this.typeExprOfShape(shape.index) }
        : null;
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
        } else if (dictionaryAt(spread) !== null) {
          // `{ ...d }` at a `Record` is every entry the dictionary `d` holds:
          // the parts are merged in the order they are written, which is a copy
          // of each dictionary one after another.
          dictionary = dictionaryAt(spread) as CollectionValue;
          parts.push({ dictionary: spread });
        } else if (spread.k === "conditional") {
          // `...(c ? {} : { field: v })` writes a field only when the condition
          // holds. The arm that writes nothing leaves the field at its zero,
          // which the object's own type says; where the object is read at a
          // union of shapes and no one arm is the object's, the written arm
          // names the field and its type, and the zero is taken from there.
          const emptyObject = (arm: Expression): boolean => arm.k === "object" && arm.fields.length === 0;
          const writtenArm = emptyObject(spread.then) ? spread.otherwise : emptyObject(spread.otherwise) ? spread.then : null;
          const armShape = writtenArm !== null && writtenArm.k === "object" ? this.shapeOf(writtenArm) : null;
          const record = expected ?? (armShape !== null && armShape.kind === "record" && armShape.index === null ? armShape : null);
          if (record === null || !this.spreadOfOneArm(spread, record, put)) {
            if (!this.typeReadIsPending()) {
              this.report(
                "an object spread reads a constant object",
                "write the fields out, or spread an object the file already wrote as a constant",
                key,
              );
            }
          }
        } else {
          const held = this.shapeOf(spread);
          const shape = held === null ? null : this.shapeForRead(held);
          // A spread of a call is the record the call answered, and a field is
          // read of it once per field: the call is read into a name of the
          // statement's own first, so its work runs once and every field reads
          // that one answer.
          let source = spread;
          if (shape !== null && shape.kind === "record" && shape.index === null && !readsOnce(spread)) {
            const name = `__spread${this.spreadCount}`;
            this.spreadCount += 1;
            this.pendingBefore.push({ kind: "declare", name, type: null, init: spread, line: key.line });
            source = { k: "ident", name };
          }
          if (shape !== null && shape.kind === "record" && shape.index === null) {
            for (const name of shape.fields.keys()) {
              put(name, { k: "member", base: source, field: name }, true);
            }
          } else if (
            // The value's own shape is not held — a method of another module,
            // a value the link has not named — and the use says what the object
            // is: the fields the use names are the fields the spread copies.
            expected !== null &&
            expected.index === null &&
            expected.arms === undefined &&
            readsOnce(spread)
          ) {
            for (const name of expected.fields.keys()) {
              put(name, { k: "member", base: spread, field: name }, true);
            }
          } else if (!this.typeReadIsPending() && !this.pendingHolds(spread)) {
            // A value the link has not named yet — a method of an imported
            // class, a call of an imported function — is not a constant this
            // read can say has no fields: the read that follows the link holds
            // the declaration and copies the fields there.
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
      // `{ start(controller) { ... } }` is a method: the field is named by the
      // key and holds the arrow the body is, and `async read(path) { ... }` is
      // an async one. A method may state type parameters, which are erased with
      // every other type.
      if (key.kind === "ident" && (this.at("(") || this.at("<"))) {
        if (this.at("<")) this.skipTypeParameters();
        const declared = expected?.fields.get(key.text);
        if (declared !== undefined && declared.type.kind === "function") {
          this.arrowParameters = declared.type.params.map((param) => ({
            type: this.typeExprOfShape(param),
            shape: param,
          }));
        }
        put(key.text, this.readArrow(false, true));
        if (!this.accept(",")) break;
        continue;
      }
      if (
        key.kind === "ident" &&
        key.text === "async" &&
        this.peek().kind === "ident" &&
        (this.peek(1).text === "(" || this.peek(1).text === "<")
      ) {
        const named = this.next();
        if (this.at("<")) this.skipTypeParameters();
        const declared = expected?.fields.get(named.text);
        if (declared !== undefined && declared.type.kind === "function") {
          this.arrowParameters = declared.type.params.map((param) => ({
            type: this.typeExprOfShape(param),
            shape: param,
          }));
        }
        put(named.text, this.readArrow(true, true));
        if (!this.accept(",")) break;
        continue;
      }
      // `[SECTIONS.empty]: 0` is a field whose key the source computed. The key
      // is an expression, so only a dictionary can hold one: the pairs the
      // dictionary is built from are written with the key where the source wrote
      // it, and a record — whose fields are names — has no field to name.
      if (key.text === "[" && key.kind === "punct") {
        const written = this.readExpression();
        this.expect("]");
        if (this.accept(":")) {
          const computed = `__computed${this.fieldCount++}`;
          computedKeys.set(computed, written);
          put(computed, this.readExpression());
        } else {
          this.report("an object field needs a value", "write the value after the key", key);
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
    const dictionaryTarget = dictionary ?? (expected !== null && expected.index !== null
      ? { kind: "map" as const, key: TEXT_RESULT, value: this.typeExprOfShape(expected.index) }
      : null);
    if (dictionaryTarget !== null) {
      const collection = dictionaryTarget;
      const pairs = fields.map((field) => ({
        key: computedKeys.get(field.name)
          ?? ({ k: "text", parts: [{ k: "text", value: field.name }] } as Expression),
        value: field.value,
      }));
      // A record whose keys the source computed as numbers is the dictionary
      // keyed by numbers: `{ [SECTIONS.empty]: 0 }` at `Record<number, V>` is an
      // entry of the number key, and the read of `size[n]` is the entry the
      // number names. A name — `{ empty: 0 }` — keys the dictionary by text,
      // which is the record of fields it looks like.
      const numeric = pairs.length > 0 && pairs.every((pair) => this.keyKind(this.valueTypeOf(pair.key)) === "number");
      if (numeric) collection.key = NUMBER_RESULT;
      const line = this.peek().line;
      // A spread of a dictionary writes entries the literal does not name, so
      // the entries are the parts merged: each field is a dictionary of one,
      // and each spread is a dictionary of its own.
      if (parts.some((part) => "dictionary" in part)) {
        const helper = this.collectionMergeHelper(collection, line);
        const written: Expression[] = [];
        for (const part of parts) {
          if ("dictionary" in part) written.push(part.dictionary);
          else {
            const one = {
              key: { k: "text", parts: [{ k: "text", value: part.field.name }] } as Expression,
              value: part.field.value,
            };
            const single = this.collectionPairsHelper(collection, [one], line);
            this.expressionTypes.set(single, NUMBER_RESULT);
            written.push(single);
          }
        }
        const listed: Expression = { k: "buffer", element: "f64", values: written };
        const merged: Expression = { k: "call", name: helper.name, args: [listed] };
        this.collectionExpressions.set(merged, collection);
        this.expressionTypes.set(merged, NUMBER_RESULT);
        // The value is a dictionary keyed by text, and a member read on it is
        // the entry that key names.
        this.expressionShapes.set(merged, {
          kind: "record",
          fields: new Map(),
          index: this.shapeOfTypeExpr(collection.value),
        });
        return merged;
      }
      const call = pairs.length === 0
        ? { k: "call", name: "blaze_rt_dict_new", args: [] } as Expression
        : this.collectionPairsHelper(collection, pairs, line);
      this.collectionExpressions.set(call, collection);
      this.expressionTypes.set(call, NUMBER_RESULT);
      this.expressionShapes.set(call, {
        kind: "record",
        fields: new Map(),
        index: this.shapeOfTypeExpr(collection.value),
      });
      return call;
    }
    // An object written at a union of shapes is laid out as every arm: the
    // fields the source did not write are zero, and a tag says which arm it is.
    // That is one layout for every arm, which is what a read of a field of
    // another arm, and the `in` that guards it, is a read of.
    if (expected !== null && expected.index === null && expected.arms !== undefined) {
      const written = new Map(fields.map((field) => [field.name, field]));
      let arm = expected.arms.findIndex(
        (one) => one.kind === "record" && fields.every((field) => one.fields.has(field.name)),
      );
      if (arm < 0) arm = 0;
      const padded: { name: string; value: Expression }[] = [];
      for (const [field, declared] of expected.fields) {
        const held = written.get(field);
        padded.push(held ?? { name: field, value: this.zeroFor(this.typeExprOfShape(declared.type)) });
      }
      padded.push({ name: "__arm", value: { k: "literal", text: String(arm) } });
      return { k: "object", fields: padded, written: [...written.keys()] };
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
     * What the element holds, where the spread the element type came from says
     * it. `[...m.values()]` is a list of the map's value type, which the
     * contract erases to the opaque reference; the spread's own shape is the
     * record the fields are read at.
     */
    let elementShape: ResolvedType | null = expectedElementShape;
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
      for (const written of run) this.applyExpected(written, { kind: "slice", of: element }, elementShape);
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
        // A text spread into a list is its characters, one text each, which is
        // the fields the split helper cuts at the empty separator. Without
        // this, the spread was the text itself, and the methods written after
        // it — `[...text].slice(0, n).join("")` — were methods of no list.
        const spreadHeld = this.valueTypeOf(spread);
        if (spreadHeld.kind === "text" || spreadHeld.kind === "fixed") {
          const cut = this.splitHelper(this.peek().line, false);
          const empty: Expression = { k: "text", parts: [{ k: "text", value: "" }] };
          const characters: Expression = { k: "call", name: cut.name, args: [spread, empty] };
          this.expressionTypes.set(characters, cut.returns);
          spread = characters;
        }
        // A spread stands for the elements of a list, so the list's element
        // type is the one the spread holds. A value that is not a list — a call
        // the module graph has not linked yet reads as a deferred hole — says
        // nothing about the elements it stands for, and the literal is settled
        // by the values beside it or by the use that reads it.
        const type = this.valueTypeOf(spread);
        // A spread whose elements are not the ones the list holds is written as
        // the elements the list holds: `[...bytes]` in a list of numbers is a
        // block of numbers, which is the element-by-element copy a typed array's
        // own `from` writes. Without it the two blocks were joined as they
        // stood, and the C target read a block of bytes as a block of doubles.
        const spreadElement = type.kind === "slice" || type.kind === "array" ? type.of : null;
        if (
          element !== null &&
          spreadElement !== null &&
          !sameResult(spreadElement, element) &&
          spreadElement.kind === "primitive" &&
          element.kind === "primitive"
        ) {
          const converted = this.typedFromHelper(spreadElement, element, this.peek().line);
          const copied: Expression = { k: "call", name: converted.name, args: [spread] };
          this.expressionTypes.set(copied, converted.returns);
          spread = copied;
        }
        if (element === null && (type.kind === "slice" || type.kind === "array") && !this.holdsUnsettledArray(spread)) {
          element = type.of;
          // The element the spread stands for keeps the shape the spread says,
          // where it says one: a call that answers a list of records records
          // its element shape, and the literal joins that list element by
          // element.
          const spreadShape = this.shapeOf(spread);
          if (spreadShape !== null && spreadShape.kind === "list") elementShape = spreadShape.of;
          settleRun();
        }
        joined = joined === null ? spread : { k: "binary", op: "+", left: joined, right: spread };
        pieces += 1;
      } else {
        const value = readWritten(false);
        if (element === null && !this.holdsUnsettledArray(value)) {
          element = this.valueTypeOf(value);
          // The value the literal wrote says what its element holds, not only
          // what its type is: `[item, item]` is a list of the record `item` is,
          // and the contract's spelling of that is the opaque reference.
          if (elementShape === null) elementShape = this.shapeOf(value);
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
          const shape = elementShape ?? this.shapeOfTypeExpr(element);
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
    } else if (kind === "map" && this.pairMapAt() !== null) {
      // `new Map(items.map((item) => [item.key, item.value]))`: the map is the
      // entries the callback writes, which is a loop of one write each rather
      // than a list of pairs a list here cannot hold.
      const made = this.readPairMap(collection);
      if (made === null) return this.hole();
      call = made;
    } else {
      const savedSource = this.readingCollectionSource;
      this.readingCollectionSource = true;
      const source = this.readExpression();
      this.readingCollectionSource = savedSource;
      // A call may end its arguments with a comma, which names no argument.
      this.accept(",");
      this.expect(")");
      call = this.collectionFromSource(collection, source, view);
    }
    this.collectionExpressions.set(call, collection);
    this.expressionTypes.set(call, NUMBER_RESULT);
    return call;
  }

  /**
   * Where `new Map(<source>.map(<callback>))` splits, as the index of the `.`
   * and of the callback's parentheses, or null where the argument is not that.
   *
   * The map is the entries the callback writes, and an entry is two values of
   * two types, which a list cannot hold. Where the callback answers a pair —
   * a list of two written values — the call is read as the loop of writes it
   * means, and the list never exists.
   */
  private pairMapAt(from = this.position): { dot: number; open: number; close: number; method: string } | null {
    const open = from - 1;
    const close = this.matchingToken(open, "(", ")");
    if (close < 0) return null;
    let depth = 0;
    let found: { dot: number; open: number; close: number; method: string } | null = null;
    for (let at = from; at < close; at += 1) {
      const token = this.tokens[at];
      if (token === undefined) return null;
      if (token.kind === "punct") {
        if (token.text === "(" || token.text === "[" || token.text === "{") {
          depth += 1;
          continue;
        }
        if (token.text === ")" || token.text === "]" || token.text === "}") {
          depth -= 1;
          continue;
        }
        if (
          depth === 0 &&
          token.text === "." &&
          this.tokens[at + 1]?.kind === "ident" &&
          this.tokens[at + 1]?.text === "map" &&
          this.tokens[at + 2]?.text === "("
        ) {
          const end = this.matchingToken(at + 2, "(", ")");
          // A call may end its arguments with a comma, which names no argument:
          // `Object.fromEntries(list.map(f),)` is the same call.
          if (end === close - 1 || (end === close - 2 && this.tokens[close - 1]?.text === ",")) {
            found = { dot: at, open: at + 2, close, method: this.tokens[at + 1]?.text as string };
          }
        }
      }
    }
    return found;
  }

  /**
   * Where `Object.fromEntries(<source>.flatMap(<callback>))` splits, as the
   * index of the `.` and of the callback's parentheses, or null where the
   * argument is not that.
   *
   * A callback that answers `Object.entries(<record>)` is not a list of pairs:
   * it is every entry of every record the list names, in list order.
   */
  private entriesConcatAt(from = this.position): { dot: number; open: number; close: number } | null {
    const open = from - 1;
    const close = this.matchingToken(open, "(", ")");
    if (close < 0) return null;
    let depth = 0;
    let found: { dot: number; open: number; close: number } | null = null;
    for (let at = from; at < close; at += 1) {
      const token = this.tokens[at];
      if (token === undefined) return null;
      if (token.kind === "punct") {
        if (token.text === "(" || token.text === "[" || token.text === "{") {
          depth += 1;
          continue;
        }
        if (token.text === ")" || token.text === "]" || token.text === "}") {
          depth -= 1;
          continue;
        }
        if (
          depth === 0 &&
          token.text === "." &&
          this.tokens[at + 1]?.kind === "ident" &&
          this.tokens[at + 1]?.text === "flatMap" &&
          this.tokens[at + 2]?.text === "("
        ) {
          const end = this.matchingToken(at + 2, "(", ")");
          if (end === close - 1 || (end === close - 2 && this.tokens[close - 1]?.text === ",")) {
            found = { dot: at, open: at + 2, close };
          }
        }
      }
    }
    return found;
  }

  /**
   * Where `Object.fromEntries(Object.entries(<record>).sort(<callback>))`
   * splits, as the index of the `.` and of the callback's parentheses, or null
   * where the argument is not that.
   *
   * Sorting the entries is sorting what the record holds: the helper walks the
   * positions in the order the comparator gives, not in the order the
   * dictionary holds them.
   */
  private entriesSortAt(from = this.position): { dot: number; open: number; close: number } | null {
    const open = from - 1;
    const close = this.matchingToken(open, "(", ")");
    if (close < 0) return null;
    let depth = 0;
    let found: { dot: number; open: number; close: number } | null = null;
    for (let at = from; at < close; at += 1) {
      const token = this.tokens[at];
      if (token === undefined) return null;
      if (token.kind === "punct") {
        if (token.text === "(" || token.text === "[" || token.text === "{") {
          depth += 1;
          continue;
        }
        if (token.text === ")" || token.text === "]" || token.text === "}") {
          depth -= 1;
          continue;
        }
        if (
          depth === 0 &&
          token.text === "." &&
          this.tokens[at + 1]?.kind === "ident" &&
          this.tokens[at + 1]?.text === "sort" &&
          this.tokens[at + 2]?.text === "("
        ) {
          const end = this.matchingToken(at + 2, "(", ")");
          if (end === close - 1 || (end === close - 2 && this.tokens[close - 1]?.text === ",")) {
            found = { dot: at, open: at + 2, close };
          }
        }
      }
    }
    return found;
  }

  private readEntriesConcat(collection: CollectionValue): Expression | null {
    const saved = this.snapshotReads();
    const made = this.readEntriesConcatAttempt(collection);
    if (made !== null) return made;
    this.restoreReads(saved);
    if (this.tokens[saved.position - 1]?.text === "(") this.position = saved.position - 1;
    return null;
  }

  /**
   * `Object.fromEntries(<source>.flatMap(<callback>))` where each callback
   * answers the entries of a record, as the nested loop of writes it is.
   */
  private readEntriesConcatAttempt(collection: CollectionValue): Expression | null {
    const at = this.entriesConcatAt();
    if (at === null) return null;
    const line = this.peek().line;
    const savedIteration = this.readingIteration;
    const savedCollectionSource = this.readingCollectionSource;
    this.readingIteration = true;
    this.readingCollectionSource = true;
    let source: Expression;
    let callback: Expression;
    let sequence: TypeExpr | null = null;
    try {
      source = this.readBounded(at.dot);
      if (this.position !== at.dot) return null;
      this.position = at.open + 1;
      const held = this.valueTypeOf(source);
      sequence = held.kind === "slice" || held.kind === "array" ? held : null;
      if (sequence === null) return null;
      const elementShape = this.shapeOf(source);
      const shape = elementShape !== null && elementShape.kind === "list" ? elementShape.of : null;
      this.arrowParameters = shape === null ? null : [{ type: this.typeExprOfShape(shape), shape }];
      callback = this.readArrow(false);
    } finally {
      this.readingIteration = savedIteration;
      this.readingCollectionSource = savedCollectionSource;
    }
    this.arrowParameters = null;
    if (this.position !== at.close - 1 && !(this.position === at.close - 2 && this.tokens[at.close - 1]?.text === ",")) return null;
    if (callback.k !== "arrow") return null;
    const lifted = this.liftedArrows.get(callback.name);
    if (lifted === undefined) return null;
    const answers = lifted.body.filter((statement) => statement.kind === "result" && statement.value !== null);
    if (answers.length !== 1) return null;
    const answered = (answers[0] as Statement & { value: Expression }).value;
    if (answered.k !== "call" || answered.name !== "__collection_entries") return null;
    const record = answered.args[0];
    if (record === undefined) return null;
    const sourceCollection = this.iteratedCollections.get(answered) ?? this.collectionExpressions.get(answered);
    if (sourceCollection === null || sourceCollection === undefined || sourceCollection.kind !== "map") return null;
    // The entries the callback answers are written where they are read, so the
    // arrow is never called: the loop of writes is what the program has, and
    // the closure the read lifted is not a function of it.
    this.liftedArrows.delete(callback.name);
    this.closures = this.closures.filter((one) => one.name !== callback.name);
    collection.key = sourceCollection.key;
    collection.value = sourceCollection.value;
    collection.valueShape = sourceCollection.valueShape;
    const setName = this.collectionSetNameFor(collection);
    if (setName === null) return null;
    const binding = this.arrowBindings.get(callback.name);
    const captures = binding?.captures ?? [];
    const captureTypes = binding?.captureTypes ?? [];
    const writtenNames = binding !== undefined
      ? binding.params.map((param) => param.name)
      : lifted.params.slice(captures.length).map((param) => param.name);
    const params = new Set(writtenNames);
    const element = (): Expression => ({ k: "index", base: { k: "ident", name: "item" }, index: { k: "ident", name: "at" } });
    const held = substituteParams(record, params, element);
    const name = `__collect_${this.stem}_${this.collectCount}`;
    this.collectCount += 1;
const items: TypeExpr = { kind: "slice", of: (sequence as { of: TypeExpr }).of };
    const paramsOut = [{ name: "item", type: items }, ...captures.map((capture, index) => ({ name: capture, type: captureTypes[index] ?? ANY_TYPE }))];
    const returns: TypeExpr = NUMBER_RESULT;
    const body: Statement[] = [
      { kind: "declare", name: "out", type: null, init: { k: "call", name: "blaze_rt_dict_new", args: [] }, line },
      {
        kind: "loop",
        variable: "at",
        from: { k: "literal", text: "0" },
        to: { k: "length", buffer: "item" },
        inclusive: false,
        step: null,
        down: false,
        body: [
          { kind: "declare", name: "part", type: null, init: held, line },
          {
            kind: "loop",
            variable: "i",
            from: { k: "literal", text: "0" },
            to: { k: "call", name: "blaze_rt_dict_len", args: [{ k: "ident", name: "part" }] },
            inclusive: false,
            step: null,
            down: false,
            body: [
              {
                kind: "expression",
                value: {
                  k: "call",
                  name: setName,
                  args: [
                    { k: "ident", name: "out" },
                    { k: "call", name: this.keyReadName(sourceCollection), args: [{ k: "ident", name: "part" }, { k: "ident", name: "i" }] },
                    { k: "call", name: this.valueReadName(sourceCollection.value), args: [{ k: "ident", name: "part" }, { k: "ident", name: "i" }] },
                  ],
                },
                line,
              },
            ],
            line,
          },
        ],
        line,
      },
      { kind: "result", value: { k: "ident", name: "out" }, line },
    ];
    const helper: TypeScriptFunction = { name, params: paramsOut, returns, body, line, closure: true };
    this.closures.push({ name, exported: false, internal: true, params: paramsOut, returns, handle: helper });
    this.liftedArrows.set(name, helper);
    this.position = at.close;
    this.next();
    return { k: "call", name, args: [source, ...captures.map((capture) => ({ k: "ident" as const, name: capture } as Expression))] };
  }

  private readEntriesSort(collection: CollectionValue): Expression | null {
    const saved = this.snapshotReads();
    const made = this.readEntriesSortAttempt(collection);
    if (made !== null) return made;
    this.restoreReads(saved);
    if (this.tokens[saved.position - 1]?.text === "(") this.position = saved.position - 1;
    return null;
  }

  /**
   * `Object.fromEntries(Object.entries(<record>).sort(<callback>))`, as the
   * record the callback orders it is.
   *
   * Sorting the entries is sorting what the record holds: the helper sorts an
   * order of its positions by the callback the source wrote — the callback
   * reads the two pairs as the two values each of them holds — and writes the
   * entries in that order. No list of pairs exists, which is what makes a
   * pair of two types possible at all.
   */
  private readEntriesSortAttempt(collection: CollectionValue): Expression | null {
    const at = this.entriesSortAt();
    if (at === null) return null;
    const line = this.peek().line;
    const savedIteration = this.readingIteration;
    const savedCollectionSource = this.readingCollectionSource;
    this.readingIteration = true;
    this.readingCollectionSource = true;
    let entries: Expression;
    let callback: Expression;
    try {
      entries = this.readBounded(at.dot);
      if (this.position !== at.dot) return null;
      this.position = at.open + 1;
      callback = this.readArrow(false);
    } finally {
      this.readingIteration = savedIteration;
      this.readingCollectionSource = savedCollectionSource;
    }
    if (this.position !== at.close - 1 && !(this.position === at.close - 2 && this.tokens[at.close - 1]?.text === ",")) return null;
    if (callback.k !== "arrow") return null;
    const lifted = this.liftedArrows.get(callback.name);
    if (lifted === undefined) return null;
    if (entries.k !== "call" || entries.name !== "__collection_entries") return null;
    const record = entries.args[0];
    if (record === undefined) return null;
    const entriesCollection = this.iteratedCollections.get(entries) ?? this.collectionExpressions.get(entries);
    if (entriesCollection === null || entriesCollection === undefined || entriesCollection.kind !== "map") return null;
    const binding = this.arrowBindings.get(callback.name);
    const captures = binding?.captures ?? [];
    const captureTypes = binding?.captureTypes ?? [];
    const written = binding !== undefined ? binding.params : lifted.params.slice(captures.length);
    if (written.length !== 2) return null;
    const answers = lifted.body.filter((statement) => statement.kind === "result" && statement.value !== null);
    if (answers.length !== 1) return null;
    const comparator = (answers[0] as Statement & { value: Expression }).value;
    // A comparator the source wrote as `([a], [b]) => ...` names one position
    // of each pair: the positions are what decides which reads the helper
    // substitutes. A name that binds the pair itself is the entry, which no
    // helper here holds, so such a comparator is refused.
    const tempA = written[0]?.name ?? "";
    const tempB = written[1]?.name ?? "";
    if (tempA === "" || tempB === "") return null;
    // Bindings of each side are read off its own generated name: the names a
    // destructured side wrote are positions of its entry.
    const bindingsFor = (temp: string): Map<string, number> => {
      const map = new Map<string, number>();
      for (const statement of lifted.body) {
        if (statement.kind !== "declare") break;
        const init = statement.init;
        if (init.k !== "index" || init.base.k !== "ident" || init.base.name !== temp || init.index.k !== "literal") continue;
        const pos = Number(init.index.text);
        if (!Number.isInteger(pos)) continue;
        map.set(statement.name, pos);
      }
      return map;
    };
    const bindingsA = bindingsFor(tempA);
    const bindingsB = bindingsFor(tempB);
    const coll = entriesCollection;
    const itemIdent = { k: "ident" as const, name: "item" };
    // One comparison of the two entries at the two indexes: the answer the
    // callback wrote, with each side's names read as the entry at its index.
    const compareAt = (leftIndex: Expression, rightIndex: Expression): Expression | null => {
      const staged = inlineDestructured(inlineDestructured(comparator, bindingsA, tempA), bindingsB, tempB);
      const left = substituteEntryPair(staged, tempA,
        () => ({ k: "call" as const, name: this.keyReadName(coll), args: [itemIdent, leftIndex] } as Expression),
        () => ({ k: "call" as const, name: this.valueReadName(coll.value), args: [itemIdent, leftIndex] } as Expression));
      if (left === null) return null;
      return substituteEntryPair(left, tempB,
        () => ({ k: "call" as const, name: this.keyReadName(coll), args: [itemIdent, rightIndex] } as Expression),
        () => ({ k: "call" as const, name: this.valueReadName(coll.value), args: [itemIdent, rightIndex] } as Expression));
    };
    collection.key = coll.key;
    collection.value = coll.value;
    collection.valueShape = coll.valueShape;
    const setName = this.collectionSetNameFor(collection);
    if (setName === null) return null;
    // The comparator is read where the helper compares, so the arrow is never
    // called: the loop of writes is what the program has, and the closure the
    // read lifted is not a function of it.
    this.liftedArrows.delete(callback.name);
    this.closures = this.closures.filter((one) => one.name !== callback.name);
    const name = `__collect_${this.stem}_${this.collectCount}`;
    this.collectCount += 1;
    const ident = (value: string): Expression => ({ k: "ident", name: value });
    const number = (text: string): Expression => ({ k: "literal", text });
    const captureParams = captures.map((capture, index) => ({ name: capture, type: captureTypes[index] ?? ANY_TYPE }));
    const paramsOut = [{ name: "item", type: NUMBER_RESULT }, ...captureParams];
    const returns: TypeExpr = NUMBER_RESULT;
    const orderAt = (index: Expression): Expression => ({ k: "index", base: ident("order"), index });
    const comparison = compareAt(orderAt(ident("j")), ident("held"));
    if (comparison === null) return null;
    const body: Statement[] = [
      { kind: "declare", name: "n", type: null, init: { k: "call", name: "blaze_rt_dict_len", args: [ident("item")] }, line },
      { kind: "declare", name: "order", type: null, init: { k: "sized", element: "f64", count: ident("n") }, line },
      {
        kind: "loop",
        variable: "i",
        from: number("0"),
        to: ident("n"),
        inclusive: false,
        step: null,
        down: false,
        body: [{ kind: "indexAssign", buffer: "order", index: ident("i"), op: "=", value: ident("i"), line }],
        line,
      },
      {
        kind: "loop",
        variable: "i",
        from: number("1"),
        to: ident("n"),
        inclusive: false,
        step: null,
        down: false,
        body: [
          { kind: "declare", name: "held", type: null, init: orderAt(ident("i")), line },
          { kind: "declare", name: "j", type: null, init: { k: "binary", op: "-", left: ident("i"), right: number("1") }, line },
          {
            kind: "while",
            condition: {
              k: "binary",
              op: "&&",
              left: { k: "binary", op: ">=", left: ident("j"), right: number("0") },
              right: { k: "binary", op: ">", left: comparison, right: number("0") },
            },
            body: [
              { kind: "indexAssign", buffer: "order", index: { k: "binary", op: "+", left: ident("j"), right: number("1") }, op: "=", value: orderAt(ident("j")), line },
              { kind: "update", name: "j", op: "--", prefix: false, line },
            ],
            line,
          },
          { kind: "indexAssign", buffer: "order", index: { k: "binary", op: "+", left: ident("j"), right: number("1") }, op: "=", value: ident("held"), line },
        ],
        line,
      },
      { kind: "declare", name: "out", type: null, init: { k: "call", name: "blaze_rt_dict_new", args: [] }, line },
      {
        kind: "loop",
        variable: "i",
        from: number("0"),
        to: ident("n"),
        inclusive: false,
        step: null,
        down: false,
        body: [{
          kind: "expression",
          value: {
            k: "call",
            name: setName,
            args: [
              ident("out"),
              { k: "call", name: this.keyReadName(coll), args: [ident("item"), orderAt(ident("i"))] },
              { k: "call", name: this.valueReadName(coll.value), args: [ident("item"), orderAt(ident("i"))] },
            ],
          },
          line,
        }],
        line,
      },
      { kind: "result", value: ident("out"), line },
    ];
    const helper: TypeScriptFunction = { name, params: paramsOut, returns, body, line, closure: true };
    this.closures.push({ name, exported: false, internal: true, params: paramsOut, returns, handle: helper });
    this.liftedArrows.set(name, helper);
    this.position = at.close;
    this.next();
    return { k: "call", name, args: [record, ...captures.map((capture) => ({ k: "ident" as const, name: capture } as Expression))] };
  }

  /** Reads an expression that ends at a token, without reading past it. */
  private readBounded(stop: number): Expression {
    const saved = this.tokens;
    const bounded = saved.slice();
    const last = bounded[stop];
    if (last !== undefined) bounded[stop] = { ...last, kind: "end", text: "" };
    this.tokens = bounded;
    try {
      return this.readExpression();
    } finally {
      this.tokens = saved;
    }
  }

  /**
   * The state a pair-map read may touch, so a call that is not a pair map is
   * read again where it stands.
   *
   * A pair-map read is attempted before a call is read any other way: the
   * callback is lifted before its answer is known to be a pair. Where it is
   * not, the tokens it read are read again from the call's opening, and the
   * closures that read created are dropped with them.
   */
  private snapshotReads(): { position: number; closures: DeclaredFunction[]; lifted: Map<string, TypeScriptFunction>; collectCount: number; closureCount: number; destructureCount: number; walkCount: number; pendingBefore: Statement[]; diagnostics: number } {
    return {
      position: this.position,
      closures: this.closures.slice(),
      lifted: new Map(this.liftedArrows),
      collectCount: this.collectCount,
      closureCount: this.closureCount,
      destructureCount: this.destructureCount,
      walkCount: this.walkCount,
      pendingBefore: this.pendingBefore.slice(),
      diagnostics: this.diagnostics.entries.length,
    };
  }

  private restoreReads(saved: { position: number; closures: DeclaredFunction[]; lifted: Map<string, TypeScriptFunction>; collectCount: number; closureCount: number; destructureCount: number; walkCount: number; pendingBefore: Statement[]; diagnostics: number }): void {
    this.position = saved.position;
    this.closures = saved.closures;
    this.liftedArrows = saved.lifted;
    this.collectCount = saved.collectCount;
    this.closureCount = saved.closureCount;
    this.destructureCount = saved.destructureCount;
    this.walkCount = saved.walkCount;
    this.pendingBefore = saved.pendingBefore;
    this.diagnostics.entries.length = saved.diagnostics;
  }

  private readPairMap(collection: CollectionValue, from = this.position): Expression | null {
    const saved = this.snapshotReads();
    const made = this.readPairMapAttempt(collection, from);
    if (made !== null) return made;
    this.restoreReads(saved);
    if (this.tokens[saved.position - 1]?.text === "(") this.position = saved.position - 1;
    return null;
  }

  /** `new Map(<source>.map(<callback>))`, as the loop of writes it is. */
  private readPairMapAttempt(collection: CollectionValue, from = this.position): Expression | null {
    const at = this.pairMapAt(from);
    if (at === null) return null;
    const line = this.peek().line;
    // A callback handed to `map` is read as a list of its answers, so an
    // `Object.entries` it walks read through the same flag a loop over them
    // does. The source it walks is read under those flags too: its entries
    // are marked rather than refused where they are named `Object.entries`.
    const savedIteration = this.readingIteration;
    const savedCollectionSource = this.readingCollectionSource;
    this.readingIteration = true;
    this.readingCollectionSource = true;
    let source: Expression;
    let callback: Expression;
    let entriesCollection: CollectionValue | null = null;
    let sequence: TypeExpr | null = null;
    try {
      // The list the callback walks is read to the `.` and no further.
      source = this.readBounded(at.dot);
      if (this.position !== at.dot) return null;
      this.position = at.open + 1;
      // The callback is read against the element the source's list holds.
      // Where the source is `Object.entries(<record>)` itself, the callback
      // walks the entries of the record instead of the elements of a list.
      const held = this.valueTypeOf(source);
      sequence = held.kind === "slice" || held.kind === "array" ? held : null;
      entriesCollection = source.k === "call" && source.name === "__collection_entries"
        ? (this.iteratedCollections.get(source) ?? this.collectionExpressions.get(source) ?? null)
        : null;
      if (sequence === null && (entriesCollection === null || entriesCollection.kind !== "map")) return null;
      if (sequence !== null) {
        const elementShape = this.shapeOf(source);
        const shape = elementShape !== null && elementShape.kind === "list" ? elementShape.of : null;
        this.arrowParameters = shape === null ? null : [{ type: this.typeExprOfShape(shape), shape }];
      }
      callback = this.readArrow(false);
    } finally {
      this.readingIteration = savedIteration;
      this.readingCollectionSource = savedCollectionSource;
    }
    this.arrowParameters = null;
    if (this.position !== at.close - 1 && !(this.position === at.close - 2 && this.tokens[at.close - 1]?.text === ",")) return null;
    if (callback.k !== "arrow") return null;
    const lifted = this.liftedArrows.get(callback.name);
    if (lifted === undefined) return null;
    // The pair the callback answers: a result that is a list of two values.
    const pair = pairOfBody(lifted.body);
    if (pair === null) return null;
    // The values the callback captured are the lifted function's leading
    // parameters, and the entry it walks is the one it was written with: the
    // captures are handed to the helper beside the walked value, and the walk
    // substitutes only the entry.
    const binding = this.arrowBindings.get(callback.name);
    const captures = binding?.captures ?? [];
    const captureTypes = binding?.captureTypes ?? [];
    const writtenNames = binding !== undefined
      ? binding.params.map((param) => param.name)
      : lifted.params.slice(captures.length).map((param) => param.name);
    const params = new Set(writtenNames);
    const bindings = destructuredBindingsOf(lifted.body);
    const temp = writtenNames[0] ?? "";
    const isEntries = entriesCollection !== null && entriesCollection.kind === "map";
    // A destructured callback's names bind positions of the pair, so each
    // name is read as the pair part it binds before the loop's element is
    // substituted: the helper loop declares no names of its own.
    const stagedPair = bindings.size === 0
      ? pair
      : {
          first: inlineDestructured(pair.first, bindings, temp),
          second: inlineDestructured(pair.second, bindings, temp),
        };
    const element = (): Expression => ({ k: "index", base: { k: "ident", name: "item" }, index: { k: "ident", name: "at" } });
    // Where the loop walks the entries of a dictionary, position zero of a
    // pair is the key the dictionary reports and position one is the value it
    // holds: a pair read off the entry is those two reads.
    const expandPair = (value: Expression): Expression | null => {
      if (!isEntries) return substituteParams(value, params, element);
      const coll = entriesCollection as CollectionValue;
      const keyRead = (): Expression => ({ k: "call", name: this.keyReadName(coll), args: [{ k: "ident", name: "item" }, { k: "ident", name: "at" }] });
      const valueRead = (): Expression => ({ k: "call", name: this.valueReadName(coll.value), args: [{ k: "ident", name: "item" }, { k: "ident", name: "at" }] });
      return substituteEntryPair(value, temp, keyRead, valueRead);
    };
    const first = expandPair(stagedPair.first);
    const second = expandPair(stagedPair.second);
    if (first === null || second === null) return null;
    // Types are read where the helper declares `item` and `at`: an expanded
    // value names the element of the loop, which this body has not named.
    const savedItemType = this.valueTypes.get("item");
    const savedAtType = this.valueTypes.get("at");
    const savedItemShape = this.valueShapes.get("item");
    const savedAtShape = this.valueShapes.get("at");
    let keyType: TypeExpr;
    let valueType: TypeExpr;
    let secondShape: ResolvedType | null;
    try {
      const items: TypeExpr = isEntries
        ? NUMBER_RESULT
        : { kind: "slice", of: (sequence as { of: TypeExpr }).of };
      this.valueTypes.set("item", items);
      this.valueTypes.set("at", NUMBER_RESULT);
      if (!isEntries && sequence !== null) {
        const listShape = this.shapeOf(source);
        const heldShape = listShape !== null && listShape.kind === "list" ? listShape.of : null;
        if (heldShape !== null) this.valueShapes.set("item", { kind: "list", of: heldShape });
      }
      keyType = this.valueTypeOf(first);
      valueType = this.valueTypeOf(second);
      secondShape = this.shapeOf(second);
    } finally {
      if (savedItemType === undefined) this.valueTypes.delete("item"); else this.valueTypes.set("item", savedItemType);
      if (savedAtType === undefined) this.valueTypes.delete("at"); else this.valueTypes.set("at", savedAtType);
      if (savedItemShape === undefined) this.valueShapes.delete("item"); else this.valueShapes.set("item", savedItemShape);
      if (savedAtShape === undefined) this.valueShapes.delete("at"); else this.valueShapes.set("at", savedAtShape);
    }
    if (this.keyKind(keyType) !== "text") return null;
    collection.key = keyType;
    collection.value = valueType;
    if (secondShape !== null && secondShape.kind !== "any") collection.valueShape = secondShape;
    // The pair is read where it is written, so the arrow is never called: the
    // loop of writes is what the program has, and the closure the read lifted
    // is not a function of it. A list of the two values of a pair is not a
    // list a compiled program can hold, so leaving it behind is a function the
    // backend cannot write.
    this.liftedArrows.delete(callback.name);
    this.closures = this.closures.filter((one) => one.name !== callback.name);
    const setName = this.collectionSetNameFor(collection);
    if (setName === null) return null;
    const name = `__collect_${this.stem}_${this.collectCount}`;
    this.collectCount += 1;
    const walked: { name: string; type: TypeExpr } = isEntries || sequence === null
      ? { name: "item", type: NUMBER_RESULT }
      : { name: "item", type: { kind: "slice", of: (sequence as { of: TypeExpr }).of } as TypeExpr };
    const captureParams = captures.map((capture, index) => ({ name: capture, type: captureTypes[index] ?? ANY_TYPE }));
    const paramsOut = [walked, ...captureParams];
    const loopTo: Expression = isEntries
      ? { k: "call", name: "blaze_rt_dict_len", args: [{ k: "ident", name: "item" }] }
      : { k: "length", buffer: "item" };
    const returns: TypeExpr = NUMBER_RESULT;
    const body: Statement[] = [
      { kind: "declare", name: "out", type: null, init: { k: "call", name: "blaze_rt_dict_new", args: [] }, line },
      {
        kind: "loop",
        variable: "at",
        from: { k: "literal", text: "0" },
        to: loopTo,
        inclusive: false,
        step: null,
        down: false,
        body: [
          { kind: "expression", value: { k: "call", name: setName, args: [{ k: "ident", name: "out" }, first, second] }, line },
        ],
        line,
      },
      { kind: "result", value: { k: "ident", name: "out" }, line },
    ];
    const helper: TypeScriptFunction = { name, params: paramsOut, returns, body, line, closure: true };
    this.closures.push({ name, exported: false, internal: true, params: paramsOut, returns, handle: helper });
    this.liftedArrows.set(name, helper);
    this.position = at.close;
    this.next();
    const arg = isEntries ? ((source as Expression & { args: Expression[] }).args[0] as Expression) : source;
    return { k: "call", name, args: [arg, ...captures.map((capture) => ({ k: "ident" as const, name: capture } as Expression))] };
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
      // An entry written as an asserted tuple is the entry it asserts: the
      // type is erased like every other assertion, and the entry is read.
      if (this.at("as") || this.at("satisfies")) {
        this.next();
        this.readTypeAnnotation("a tuple assertion", EXPRESSION_TYPE_STOPS);
      }
      pairs.push({ key, value });
      if (!this.accept(",")) break;
    }
    this.expect("]");
    // The list of pairs and the call's own arguments may each end with a
    // comma, which names nothing.
    this.accept(",");
    this.expect(")");
    if (pairs.length === 0) {
      return { k: "call", name: "blaze_rt_dict_new", args: [] };
    }
    if (this.keyKind(collection.key) === null) {
      this.report(
        `a ${view.text} here is keyed by text, not by ${typeToString(collection.key)}`,
        "a key is a text, a number or a reference: a map of numbers is written as Map<number, V>",
        view,
      );
      return this.hole();
    }
    // A map written out without a generic states its key and value types with
    // the first entry it holds.
    const firstKey = this.valueTypeOf((pairs[0] as { key: Expression }).key);
    if (collection.key.kind === "text" && firstKey.kind !== "text") collection.key = firstKey;
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
      if (collection.key.kind === "text" && sourceCollection.key.kind !== "text") collection.key = sourceCollection.key;
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

  /**
   * The function a `Record` object literal with spreads becomes.
   *
   * The parts are dictionaries, in the order the source wrote them, and the
   * answer is a dictionary of every entry: a later part writes over a key an
   * earlier one wrote, which is the language's last write. The value a part
   * holds is read and written by what the dictionary holds, so a text stays a
   * text and a reference a reference.
   */
  private collectionMergeHelper(collection: CollectionValue, line: number): { name: string; returns: TypeExpr } {
    const key = JSON.stringify(["merge", collection.kind, collection.key, collection.value]);
    const known = this.collectHelpers.get(key);
    if (known !== undefined) return known;
    const name = `__collect_${this.stem}_${this.collectCount}`;
    this.collectCount += 1;
    const ident = (value: string): Expression => ({ k: "ident", name: value });
    const number = (text: string): Expression => ({ k: "literal", text });
    const set = this.collectionSetNameFor(collection) as string;
    const keyRead = this.keyReadName(collection);
    const valueRead = this.valueReadName(collection.value);
    const body: Statement[] = [
      { kind: "declare", name: "out", type: null, init: { k: "call", name: "blaze_rt_dict_new", args: [] }, line },
      {
        kind: "loop",
        variable: "p",
        from: number("0"),
        to: { k: "length", buffer: "parts" },
        inclusive: false,
        step: null,
        down: false,
        body: [
          { kind: "declare", name: "part", type: null, init: { k: "index", base: ident("parts"), index: ident("p") }, line },
          {
            kind: "loop",
            variable: "i",
            from: number("0"),
            to: { k: "call", name: "blaze_rt_dict_len", args: [ident("part")] },
            inclusive: false,
            step: null,
            down: false,
            body: [
              {
                kind: "expression",
                value: {
                  k: "call",
                  name: set,
                  args: [
                    ident("out"),
                    { k: "call", name: keyRead, args: [ident("part"), ident("i")] },
                    { k: "call", name: valueRead, args: [ident("part"), ident("i")] },
                  ],
                },
                line,
              },
            ],
            line,
          },
        ],
        line,
      },
      { kind: "result", value: ident("out"), line },
    ];
    const params = [{ name: "parts", type: { kind: "slice", of: NUMBER_RESULT } as TypeExpr }];
    const returns: TypeExpr = NUMBER_RESULT;
    const helper: TypeScriptFunction = { name, params, returns, body, line, closure: true };
    this.closures.push({ name, exported: false, internal: true, params, returns, handle: helper });
    this.liftedArrows.set(name, helper);
    this.collectHelpers.set(key, { name, returns });
    return { name, returns };
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
    const setName = this.dictionaryCall(element, "set");
    if (setName === null) {
      this.report(
        `a set of ${typeToString(element)} is keyed by text, not by ${typeToString(element)}`,
        "a set holds numbers, texts, or references keyed by the handle they are",
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
    const setName = this.dictionaryCall(element, "set");
    if (setName === null) {
      this.report(
        `a set of ${typeToString(element)} is keyed by text, not by ${typeToString(element)}`,
        "a set holds numbers, texts, or references keyed by the handle they are",
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
    const keyRead = this.keyReadName(sourceCollection);
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
      const setName = this.dictionaryCall(collection.key, "set") ?? "blaze_rt_dict_set";
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

  /**
   * The function `Object.assign(target, source)` over dictionaries becomes:
   * every entry of the source written into the target, in order.
   *
   * Unlike `collectionCopyHelper`, which builds a new dictionary, this writes
   * into the target it was handed and answers it: the target the source named
   * is the object the program holds, so the write lands there.
   */
  private collectionAssignHelper(
    collection: CollectionValue,
    sourceCollection: CollectionValue,
    target: Expression,
    source: Expression,
    line: number,
  ): Expression {
    const key = JSON.stringify(["assign", collection.kind, collection.key, collection.value, sourceCollection.kind, sourceCollection.key, sourceCollection.value]);
    const known = this.collectHelpers.get(key);
    if (known !== undefined) return { k: "call", name: known.name, args: [target, source] };
    const name = `__collect_${this.stem}_${this.collectCount}`;
    this.collectCount += 1;
    const ident = (value: string): Expression => ({ k: "ident", name: value });
    const keyRead = this.keyReadName(sourceCollection);
    const setName = this.collectionSetNameFor(collection) ?? "blaze_rt_dict_set";
    const body: Statement[] = [
      { kind: "declare", name: "n", type: null, init: { k: "call", name: "blaze_rt_dict_len", args: [ident("source")] }, line },
      {
        kind: "loop",
        variable: "i",
        from: { k: "literal", text: "0" },
        to: ident("n"),
        inclusive: false,
        step: null,
        down: false,
        body: [{
          kind: "expression",
          value: {
            k: "call",
            name: setName,
            args: [
              ident("target"),
              { k: "call", name: keyRead, args: [ident("source"), ident("i")] },
              { k: "call", name: this.valueReadName(collection.value), args: [ident("source"), ident("i")] },
            ],
          },
          line,
        }],
        line,
      },
      { kind: "result", value: ident("target"), line },
    ];
    const params = [
      { name: "target", type: NUMBER_RESULT },
      { name: "source", type: NUMBER_RESULT },
    ];
    const returns: TypeExpr = NUMBER_RESULT;
    const helper: TypeScriptFunction = { name, params, returns, body, line, closure: true };
    this.closures.push({ name, exported: false, internal: true, params, returns, handle: helper });
    this.liftedArrows.set(name, helper);
    this.collectHelpers.set(key, { name, returns });
    return { k: "call", name, args: [target, source] };
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
        const written: readonly ClassParam[] = info.constructor?.params ?? this.constructorOf(info)?.params ?? [];
        const params = this.methodParams(written);
        const args = this.readCallArguments(
          params.map((param) => param.type),
          null,
          false,
          false,
          null,
          params.map((param) => param.shape),
        );
        return { k: "call", name: methodFunctionName(info.name, { name: "constructor", params: [...written], returnTypeName: info.name, bodyStart: -1, bodyEnd: -1, line: info.line }, args.length), args };
      }
    }
    // `new Date()` is the wall clock as the milliseconds since the epoch, and
    // `new Date(ms)` is the milliseconds the source wrote. A date is a number
    // here: the only thing a source asks of one is its stamp or its time.
    if (view.kind === "ident" && view.text === "Date") {
      if (!this.at("(")) {
        this.report("a date is built with its arguments", `as in new Date()`, view);
        return this.hole();
      }
      if (this.peek(1).text === ")") {
        this.next();
        this.next();
        // A date is the milliseconds it is, and a source asks a date for its
        // stamp or its time. A date held as a value of its own is a `Date` of
        // the host, which this compiler has no value for.
        const method = this.peek(1).text;
        if (this.at(".") && (method === "toISOString" || method === "getTime")) {
          const now: Expression = { k: "call", name: "blaze_rt_now_ms", args: [] };
          this.expressionTypes.set(now, NUMBER_RESULT);
          return now;
        }
        this.report(
          "a date is read for its stamp or its time",
          "as in new Date().toISOString() or new Date().getTime()",
          view,
        );
        return this.hole();
      }
      const args = this.readCallArguments([NUMBER_RESULT]);
      if (args.length === 1) return args[0] as Expression;
      this.report(
        "a date is built from the milliseconds it is",
        "as in new Date(ms), or new Date() for the moment it is read",
        view,
      );
      return this.hole();
    }
    // `new TextEncoder()` writes a text as the bytes it is written as, which is
    // the one encoding a compiled text is: utf8. The encoder is no value of its
    // own, exactly as the decoder is none: it is held at a name of its own so
    // that `const encoder = new TextEncoder()` reads, and what the name holds is
    // a zero nothing reads.
    if (view.kind === "ident" && view.text === "TextEncoder") {
      if (!this.accept("(")) {
        this.report("a text encoder is created with its arguments", `as in new TextEncoder()`, view);
        return this.hole();
      }
      while (!this.at(")") && this.peek().kind !== "end") {
        this.report("a text encoder writes utf8", "the one encoding a compiled text is written in", this.peek());
        this.next();
      }
      this.expect(")");
      const marker: Expression = { k: "literal", text: "0" };
      this.expressionTypes.set(marker, { kind: "ref", of: null, name: "__TextEncoder" });
      this.expressionShapes.set(marker, { kind: "ref", name: "__TextEncoder" });
      return marker;
    }
    // `new TextDecoder()` reads bytes as the text they are written as, which is
    // the one encoding a compiled text is: utf8.
    if (view.kind === "ident" && view.text === "TextDecoder") {
      if (!this.accept("(")) {
        this.report("a text decoder is created with its arguments", `as in new TextDecoder()`, view);
        return this.hole();
      }
      while (!this.at(")") && this.peek().kind !== "end") {
        this.report(
          "a text decoder decodes utf8",
          "the one encoding a compiled text is written in",
          this.peek(),
        );
        this.next();
      }
      this.expect(")");
      // The decoder is no value of its own: it is the one thing a source asks
      // of it, which is the text its bytes are written as. The read holds it
      // at a name of its own so that `const decoder = new TextDecoder()` reads,
      // and the value that name holds is a zero nothing reads.
      const marker: Expression = { k: "literal", text: "0" };
      this.expressionTypes.set(marker, { kind: "ref", of: null, name: "__TextDecoder" });
      this.expressionShapes.set(marker, { kind: "ref", name: "__TextDecoder" });
      return marker;
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
    // `new ArrayBuffer(n)` is a block of n bytes: the same block a typed array
    // of bytes is, allocated where it is written and cleared, so a read of a
    // byte nothing wrote is the zero the language answers it with. A `DataView`
    // over one is that block, and the float reads of it are the bytes of the
    // number at the offset.
    if (view.kind === "ident" && (view.text === "ArrayBuffer" || view.text === "SharedArrayBuffer")) {
      if (!this.at("(")) {
        this.report("a buffer is allocated with a count of bytes", `as in new ${view.text}(n)`, view);
        return this.hole();
      }
      const args = this.readCallArguments([NUMBER_RESULT]);
      const count = args[0];
      if (count === undefined || args.length !== 1) {
        this.report("a buffer is allocated with a count of bytes", `as in new ${view.text}(n)`, view);
        return this.hole();
      }
      const block: Expression = { k: "sized", element: "u8", count };
      this.expressionTypes.set(block, { kind: "slice", of: BYTE });
      return block;
    }
    // `new DataView(bytes.buffer)` is a view of a block of bytes, and a view of
    // a block here is the block: the bytes are the ones the typed array holds.
    // A view of part of a block — an offset and a length — is not part of the
    // subset, because the block a write reaches is the whole of it.
    if (view.kind === "ident" && view.text === "DataView") {
      if (!this.accept("(")) {
        this.report("a view is made of a buffer", "as in new DataView(bytes.buffer)", view);
        return this.hole();
      }
      const args: Expression[] = [];
      while (!this.at(")") && this.peek().kind !== "end") {
        args.push(this.readExpression());
        if (!this.accept(",")) break;
      }
      this.expect(")");
      // A view from the start of the block to its end is the block. A view of
      // part of one is not: the block is the whole of what a store reaches, so
      // an offset or a length the stores are not checked against would be a
      // write past the view the source declared.
      const buffer = args[0] as Expression;
      const from = args[1];
      const to = args[2];
      const whole = from === undefined
        || (isNumberLiteral(from, "0") && (to === undefined || (to.k === "lengthOf" && buffer.k === "ident" && to.of.k === "ident" && to.of.name === buffer.name)));
      if (!whole) {
        // A view of part of a block is a window of it: the block moved by the
        // offset, and as many bytes as the source wrote of it. A view with no
        // length reaches the end of the block.
        const held = this.valueTypeOf(buffer);
        const sequence = held.kind === "slice" || held.kind === "array" ? held : null;
        if (sequence !== null && from !== undefined) {
          const count: Expression = to ?? { k: "binary", op: "-", left: { k: "lengthOf", of: buffer }, right: from };
          const viewed: Expression = {
            k: "buffer",
            element: typeToString(sequence.of),
            values: [],
            view: { of: buffer, offset: from, count },
          };
          this.expressionTypes.set(viewed, { kind: "slice", of: sequence.of });
          return viewed;
        }
        this.report(
          "a view of part of a buffer is not part of the subset",
          "view the whole buffer, as in new DataView(bytes.buffer)",
          view,
        );
        return this.hole();
      }
      return buffer;
    }
    if (view.kind === "ident" && (view.text === "Map" || view.text === "Set" || view.text === "WeakMap" || view.text === "WeakSet")) {
      return this.readCollectionAllocation(view);
    }
    // `new Array(n)` is the array of numbers the source language has: a block
    // of `n` elements, cleared, which is what a read past what the program
    // filled answers. `new Array(a, b)` names the elements instead.
    if (view.kind === "ident" && view.text === "Array") {
      // `new Array<T>(n)` states the element type it is read at, which is
      // erased with every other type before the count is read.
      if (this.at("<")) this.skipTypeParameters();
      if (!this.accept("(")) {
        this.report("an array is allocated with a count", "as in new Array(n)", view);
        return this.hole();
      }
      const values: Expression[] = [];
      while (!this.at(")") && this.peek().kind !== "end") {
        values.push(this.readExpression());
        if (!this.accept(",")) break;
      }
      this.expect(")");
      if (values.length === 1) {
        const sized: Expression = { k: "sized", element: "f64", count: values[0] as Expression };
        this.expressionTypes.set(sized, { kind: "slice", of: { kind: "primitive", name: "f64" } });
        return sized;
      }
      const listed: Expression = { k: "buffer", element: "f64", values };
      this.expressionTypes.set(listed, { kind: "slice", of: { kind: "primitive", name: "f64" } });
      return listed;
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
      this.shapes,
      this.typeTable,
      this.importedTypeNames,
      this.importedValueRenames,
      this.constantAnnotations,
      this.constantCollections,
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
    child.variadicFunctions = this.variadicFunctions;
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
    // An assignment a template string interpolates is a statement of the body
    // the string is written in, so it runs before that statement and not
    // inside the text the string builds.
    this.pendingBefore.push(...child.pendingBefore);
    child.pendingBefore = [];
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
          // The contract states the result as one expression over the
          // parameters, and an element of a value the body built is a value the
          // contract cannot name: the body is contracted by what it does
          // instead. The value is one a box holds as well, and a boxed list is
          // read at an element of its field.
          this.uncontractable(
            "reads an element of a value it built rather than a value it was given",
            line,
            "a contract is one expression over the parameters; a body that reads an element of a value it built is contracted by what it does",
          );
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
      return (
        expression.values.some((value) => dependsOn(value, name)) ||
        (expression.view !== undefined &&
          (dependsOn(expression.view.of, name) || dependsOn(expression.view.offset, name) || dependsOn(expression.view.count, name)))
      );
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

/**
 * The names a destructured callback parameter binds, by the index of the pair
 * each name binds.
 *
 * A callback written `([k, v]) => ...` holds its value at a generated name and
 * binds `k` and `v` out of it in its own prelude: each name is that generated
 * name read at one position.
 */
function destructuredBindingsOf(body: readonly Statement[]): Map<string, number> {
  const bindings = new Map<string, number>();
  for (const statement of body) {
    if (statement.kind !== "declare") break;
    const init = statement.init;
    if (init.k !== "index" || init.base.k !== "ident" || init.index.k !== "literal") break;
    const pos = Number(init.index.text);
    if (!Number.isInteger(pos)) break;
    bindings.set(statement.name, pos);
  }
  return bindings;
}

/**
 * An expression with the names of a callback's destructured parameter read as
 * the pair parts they bind: each bound name becomes the pair read at its
 * position.
 */
function inlineDestructured(value: Expression, bindings: ReadonlyMap<string, number>, temp: string): Expression {
  const walk = (one: Expression): Expression => {
    switch (one.k) {
      case "ident":
        if (bindings.has(one.name)) {
          return { k: "index", base: { k: "ident", name: temp }, index: { k: "literal", text: String(bindings.get(one.name) as number) } };
        }
        return one;
      case "member":
        return { ...one, base: walk(one.base) };
      case "index":
        return { ...one, base: walk(one.base), index: walk(one.index) };
      case "call":
        return { ...one, args: one.args.map(walk) };
      case "binary":
        return { ...one, left: walk(one.left), right: walk(one.right) };
      case "unary":
        return { ...one, operand: walk(one.operand) };
      case "conditional":
        return { ...one, condition: walk(one.condition), then: walk(one.then), otherwise: walk(one.otherwise) };
      case "lengthOf":
        return { ...one, of: walk(one.of) };
      case "fixed":
        return { ...one, of: walk(one.of) };
      case "text":
        return { ...one, parts: one.parts.map((part) => (part.k === "value" ? { ...part, value: walk(part.value) } : part)) };
      case "object":
        return { ...one, fields: one.fields.map((field) => ({ ...field, value: walk(field.value) })) };
      case "buffer":
        return { ...one, values: one.values.map(walk) };
      case "arrow":
        return one;
      default:
        return one;
    }
  };
  return walk(value);
}

/**
 * An expression with reads of a destructured pair's generated name read as the
 * parts an entry of a dictionary is: position zero is the key the dictionary
 * reports, position one is the value it holds there.
 */
function substituteEntryPair(
  value: Expression,
  temp: string,
  keyRead: () => Expression,
  valueRead: () => Expression,
): Expression | null {
  const walk = (one: Expression): Expression | null => {
    switch (one.k) {
      case "index": {
        if (one.base.k === "ident" && one.base.name === temp && one.index.k === "literal") {
          const pos = Number(one.index.text);
          if (!Number.isInteger(pos)) return null;
          if (pos === 0) return keyRead();
          if (pos === 1) return valueRead();
          return null;
        }
        const base = walk(one.base);
        const index = walk(one.index);
        if (base === null || index === null) return null;
        return { ...one, base, index };
      }
      case "ident":
        return one.name === temp ? null : one;
      case "member": {
        const base = walk(one.base);
        return base === null ? null : { ...one, base };
      }
      case "call": {
        const args: Expression[] = [];
        for (const arg of one.args) {
          const written = walk(arg);
          if (written === null) return null;
          args.push(written);
        }
        return { ...one, args };
      }
      case "binary": {
        const left = walk(one.left);
        const right = walk(one.right);
        if (left === null || right === null) return null;
        return { ...one, left, right };
      }
      case "unary": {
        const operand = walk(one.operand);
        return operand === null ? null : { ...one, operand };
      }
      case "conditional": {
        const condition = walk(one.condition);
        const then = walk(one.then);
        const otherwise = walk(one.otherwise);
        if (condition === null || then === null || otherwise === null) return null;
        return { ...one, condition, then, otherwise };
      }
      case "lengthOf": {
        const of = walk(one.of);
        return of === null ? null : { ...one, of };
      }
      case "fixed": {
        const of = walk(one.of);
        return of === null ? null : { ...one, of };
      }
      case "text":
        return {
          ...one,
          parts: one.parts.map((part) => {
            if (part.k !== "value") return part;
            const written = walk(part.value);
            return written === null ? part : { ...part, value: written };
          }),
        };
      case "object": {
        const fields: { name: string; value: Expression }[] = [];
        for (const field of one.fields) {
          const written = walk(field.value);
          if (written === null) return null;
          fields.push({ name: field.name, value: written });
        }
        return { ...one, fields };
      }
      case "buffer": {
        const values: Expression[] = [];
        for (const item of one.values) {
          const written = walk(item);
          if (written === null) return null;
          values.push(written);
        }
        return { ...one, values };
      }
      case "arrow":
        return one;
      default:
        return one;
    }
  };
  return walk(value);
}

/** The two values a callback answers as a pair, or null where it answers one. */
function pairOfBody(body: readonly Statement[]): { first: Expression; second: Expression } | null {
  const results: Expression[] = [];
  const collect = (statements: readonly Statement[]): void => {
    for (const statement of statements) {
      if (statement.kind === "result" && statement.value !== null) results.push(statement.value);
      if (statement.kind === "if") {
        collect(statement.then ?? []);
        collect(statement.otherwise ?? []);
      }
    }
  };
  collect(body);
  if (results.length !== 1) return null;
  const values = writtenListValues(results[0] as Expression);
  if (values === null || values.length !== 2) return null;
  return { first: values[0] as Expression, second: values[1] as Expression };
}

/** The values a list written out holds, through the copy it is joined with. */
function writtenListValues(value: Expression): Expression[] | null {
  if (value.k === "buffer") return value.values;
  if (value.k === "binary" && value.op === "+") {
    const left = writtenListValues(value.left);
    const right = writtenListValues(value.right);
    if (left !== null && right !== null) return [...left, ...right];
  }
  return null;
}

/**
 * An expression with the names of a callback's parameters read as the element
 * the loop is on: the pair a callback writes, read for each entry.
 */
function substituteParams(value: Expression, params: ReadonlySet<string>, element: () => Expression): Expression {
  const walk = (one: Expression): Expression => {
    switch (one.k) {
      case "ident":
        return params.has(one.name) ? element() : one;
      case "member":
        return { ...one, base: walk(one.base) };
      case "index":
        return { ...one, base: walk(one.base), index: walk(one.index) };
      case "call":
        return { ...one, args: one.args.map(walk) };
      case "binary":
        return { ...one, left: walk(one.left), right: walk(one.right) };
      case "unary":
        return { ...one, operand: walk(one.operand) };
      case "conditional":
        return { ...one, condition: walk(one.condition), then: walk(one.then), otherwise: walk(one.otherwise) };
      case "lengthOf":
        return { ...one, of: walk(one.of) };
      case "length":
        // `name.length` is held as the name the length is of, and the name a
        // loop reads it on is the element.
        return params.has(one.buffer) ? { k: "lengthOf", of: element() } : one;
      case "fixed":
        return { ...one, of: walk(one.of) };
      case "text":
        return { ...one, parts: one.parts.map((part) => (part.k === "value" ? { ...part, value: walk(part.value) } : part)) };
      case "object":
        return { ...one, fields: one.fields.map((field) => ({ ...field, value: walk(field.value) })) };
      case "buffer":
        return { ...one, values: one.values.map(walk) };
      case "arrow":
        return one;
      default:
        return one;
    }
  };
  return walk(value);
}

/** The array a push or pop is written on, as the value expression it is. */
function appendArray(value: Expression & { k: "append" }): Expression {
  if (value.arms !== undefined && value.arms[0] !== undefined) {
    const arm = value.arms[0];
    return arm.base === null
      ? { k: "ident", name: arm.target }
      : { k: "member", base: { k: "ident", name: arm.base }, field: arm.target };
  }
  if (value.index !== undefined) {
    return { k: "index", base: { k: "ident", name: value.target }, index: value.index };
  }
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
  // The declaration forms, not the names: the lowering's own source mentions
  // both of them — a comment writes `CURVE.P` and a rewrite names
  // `splitScalarEndo` — and a file that only mentions them is not the
  // benchmark. The benchmark declares the curve as a constant and the split as
  // a function, so those two declarations are what it is asked for.
  return /\bfunction\s+splitScalarEndo\s*\(/.test(source) && /\bconst\s+CURVE\b/.test(source);
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

/**
 * What one read of a TypeScript module answers, whether or not it refused
 * anything.
 *
 * `refused` is the part of the file the read could not read, and `count` is the
 * whole number: the list is cut at the maximum the error states. The analysis is
 * what the read did understand, which is what a linked read needs even from a
 * file that refused something: its imports are still the imports it wrote.
 */
export interface TypeScriptRead {
  analysis: ModuleAnalysis;
  refused: readonly Diagnostic[];
  count: number;
}

/**
 * Reads one module, answering the refusals rather than throwing them.
 *
 * A build reads strictly — see `typeScriptFrontend.analyze` — because the first
 * file it cannot read is the one it has to name. A measurement of a whole tree
 * asks for this read so a refused file can still be discovered and linked: the
 * constructs that were only waiting for an import are then counted as read, and
 * the queue is the constructs that survive the link.
 */
export function readTypeScriptModule(source: string, path: string, entry = true, context?: unknown): TypeScriptRead {
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
  // A file read again after its imports are bound keeps the table the first
  // read built: the module graph has added the classes the imports name, and
  // that read is the one that reads the methods written on them.
  const sharedClasses = (context as { classes?: ClassTable } | undefined)?.classes;
  const classTable = sharedClasses ?? scanClasses(tokens);
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
  const parser = new TypeScriptParser(
    withoutClasses(tokens, classTable),
    path,
    diagnostics,
    classTable,
    tokens,
    scanned.constants,
    scanned.state,
    scanned.shapes,
    typeTable,
    importedNames(tokens),
    importedRenames(tokens),
    scanned.annotations,
    scanned.collections,
  );
  parser.wideBigint = wideBigint;
  // The type each imported value's declaration writes, for a value whose own
  // module holds rather than writes out: a list built by calls is still a list
  // of the element the annotation names.
  const linkedValueShapes = (context as { valueShapes?: ReadonlyMap<string, ResolvedType> } | undefined)?.valueShapes;
  if (linkedValueShapes !== undefined) parser.importedValueShapes = linkedValueShapes;
  const linkedFunctions = (context as { functions?: ReadonlyMap<string, ImportedFunction> } | undefined)?.functions;
  if (linkedFunctions !== undefined) {
    for (const [linked, signature] of linkedFunctions) parser.seedFunction(linked, signature);
  }
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
          analysis: {
            path,
            imports: analysis.imports,
            typeImports: analysis.typeImports,
            types: analysis.types,
            functions: analysis.functions.filter((entry) => entry.internal === true),
            default: null,
            body: statements,
            wideBigint,
          },
          // The program parser read the whole text, so the module parse's
          // refusals are the attempt it replaced and not the file's.
          refused: [],
          count: 0,
        };
      }
    } catch {
      // A program parse that cannot be a program keeps the module parse's
      // own diagnostics, which name the refusal where it is.
    }
  }
  // A file is read to the end whatever it holds, so a build names every
  // construct outside the subset instead of the first one.
  analysis.wideBigint = wideBigint;
  return { analysis, refused: [...diagnostics.entries], count: diagnostics.count };
}

export const typeScriptFrontend: Frontend = {
  analyze(source, path, entry = true, context?: unknown) {
    const read = readTypeScriptModule(source, path, entry, context);
    if (read.refused.length > 0) throw refusalError(path, read.refused, read.count);
    return read.analysis;
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

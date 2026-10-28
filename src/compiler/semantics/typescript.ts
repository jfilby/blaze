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
import { ARGV, ARGV_LENGTH } from "./builtins.ts";

export { ARGV, ARGV_LENGTH };
import { assembleContract, type AccessRange } from "./contract-build.ts";
import { isCompilerError } from "../core/errors.ts";
import { Diagnostics, frontendError, type Diagnostic } from "./diagnostics.ts";
import type { DeclaredFunction, Frontend, ModuleAnalysis, ModuleImport } from "./module.ts";
import { parseProgramBody } from "./typescript-program.ts";
import { lowerWideArithmetic } from "./typescript-wide-lowering.ts";
import {
  findField,
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
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
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
const NAMESPACES: ReadonlySet<string> = new Set(["Math", "http"]);


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
  await: "a straight line: a compiled program has no promise to wait for",
  yield: "a value the function hands back with return",
  async: "a straight line: a compiled program has nothing to wait for",
};



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
 */
function inferredResult(body: readonly Statement[], params: readonly { name: string; type: TypeExpr }[]): TypeExpr {
  const scope = new Map<string, TypeExpr>(params.map((param) => [param.name, param.type]));
  describeDeclarations(body, scope);
  const written: Expression[] = [];
  collectResults(body, written);
  if (written.length === 0) return NOTHING;
  let found: TypeExpr | null = null;
  for (const value of written) {
    const type = resultType(value, scope);
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

/** Every value a body returns, nested arms included. */
function collectResults(statements: readonly Statement[], into: Expression[]): void {
  for (const statement of statements) {
    switch (statement.kind) {
      case "result":
        into.push(statement.value);
        break;
      case "if":
        collectResults(statement.then, into);
        collectResults(statement.otherwise, into);
        break;
      case "while":
      case "doWhile":
      case "loop":
      case "forOf":
        collectResults(statement.body, into);
        break;
      case "try":
        collectResults(statement.body, into);
        if (statement.catchBody !== null) collectResults(statement.catchBody, into);
        if (statement.finallyBody !== null) collectResults(statement.finallyBody, into);
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
    case "conditional":
      return commonResult(resultType(value.then, scope), resultType(value.otherwise, scope));
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

/** Maps a TypeScript type annotation onto a contract type. */
export function mapTypeScriptType(text: string, position: string, wideBigint = false): TypeExpr {
  const source = text.trim();
  if (source === "bigint" && wideBigint) return parseType("u256");
  if (source in PRIMITIVES) return parseType(PRIMITIVES[source]);
  if (source in TYPED_ARRAYS) return { kind: "slice", of: parseType(TYPED_ARRAYS[source]) };
  throw frontendError(
    `unsupported TypeScript type "${source}"`,
    `at ${position}; supported: ${Object.keys(PRIMITIVES).join(", ")}, ${Object.keys(TYPED_ARRAYS).join(", ")}`,
  );
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

/** One value written in the source, as the tokens it spans. */
interface ConstantRange {
  start: number;
  end: number;
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
  expression?: ConstantRange;
  fields?: ReadonlyMap<string, ConstantRange>;
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

/** How many times a name is written in a token stream. */
function nameCount(tokens: readonly Token[], name: string): number {
  let count = 0;
  for (const token of tokens) {
    if (token.kind === "ident" && token.text === name) count += 1;
  }
  return count;
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
      if (tokens[index].text === "{") depth += 1;
      else if (tokens[index].text === "}") {
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
      tokens[index + 1]?.kind === "ident" &&
      tokens[index + 2]?.text === "="
    ) {
      const name = (tokens[index + 1] as Token).text;
      const mutable = token.text !== "const";
      const start = index + 3;
      if (tokens[start]?.text === "{") {
        const end = closing(start);
        const object = objectConstants(tokens, start, end);
        // An object whose every field is a constant is the file's constant (a
        // curve's fields are), and a body's read of one is the value written
        // there. An object with a field computed at run time is state the
        // running program holds, and a function that reads it is read where the
        // program is.
        if (!mutable && object.all) {
          if (!locals.has(name)) found.set(name, { fields: object.fields });
        } else {
          state.add(name);
        }
        index = end;
        continue;
      }
      let end = start;
      let depth = 0;
      while (end < tokens.length && tokens[end].kind !== "end") {
        const written = tokens[end] as Token;
        if (written.text === "(" || written.text === "[" || written.text === "{") depth += 1;
        else if (written.text === ")" || written.text === "]" || written.text === "}") depth -= 1;
        else if (written.text === ";" && depth === 0) break;
        end += 1;
      }
      const construction = !mutable && constructorRange(tokens, start, end);
      const constant = !mutable && (construction || constantRange(tokens, start, end));
      // An instance is inlined only where the file reads it once: two reads of
      // a name are two reads of one object, and two allocations are two.
      const shared = construction && nameCount(tokens, name) > 2;
      if (!constant || shared) state.add(name);
      else if (!locals.has(name)) found.set(name, { expression: { start, end } });
      index = end + 1;
      continue;
    }
    index += 1;
  }
  return { constants: found, state };
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
    if (token.text === "{") {
      depth += 1;
      continue;
    }
    if (token.text === "}") {
      depth -= 1;
      continue;
    }
    if (depth > 0 && (token.text === "let" || token.text === "const" || token.text === "var")) {
      const name = tokens[index + 1];
      if (name?.kind === "ident") names.add(name.text);
    }
    if (token.kind === "ident" && tokens[index + 1]?.text === ":") names.add(token.text);
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
  // A name the function declares is its own, whatever the file calls it: a
  // parameter spelled like a value the program holds is the parameter, and the
  // function that reads it needs no scope to read it from.
  const local = declaredNames(fn);
  let found = false;
  walkFunction(fn, (name) => {
    if (!local.has(name) && state.has(name)) found = true;
  });
  return found;
}

/** Every name a function binds: its parameters, its declarations and the names it counts with. */
function declaredNames(fn: TypeScriptFunction): Set<string> {
  const names = new Set<string>(fn.params.map((param) => param.name));
  walkFunction(fn, () => {}, undefined, (name) => names.add(name));
  return names;
}

/** Every function a body calls, by the name the source wrote. */
function callsOf(fn: TypeScriptFunction): Set<string> {
  const called = new Set<string>();
  walkFunction(fn, () => {}, (name) => called.add(name));
  return called;
}

/**
 * Every name a function body reads, and every function it calls, in the order
 * the body writes them. One walk answers both questions, so a name and a call
 * are found by the same reading of the body.
 */
function walkFunction(
  fn: TypeScriptFunction,
  onName: (text: string) => void,
  onCall: (name: string) => void = () => {},
  onDeclare: (name: string) => void = () => {},
): void {
  const read = (expression: Expression | null): void => {
    if (expression === null) return;
    switch (expression.k) {
      case "literal":
      case "bigint":
      case "null":
        return;
      case "ident":
        onName(expression.name);
        return;
      case "argv":
        read(expression.index);
        return;
      case "length":
        onName(expression.buffer);
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
        onName(expression.name);
        return;
    }
  };
  const statements = (body: readonly Statement[]): void => {
    for (const statement of body) {
      switch (statement.kind) {
        case "declare":
          onDeclare(statement.name);
          read(statement.init);
          break;
        case "loop":
          onDeclare(statement.variable);
          read(statement.from);
          read(statement.to);
          read(statement.step);
          statements(statement.body);
          break;
        case "assign":
          onName(statement.target);
          read(statement.value);
          break;
        case "memberAssign":
          onName(statement.base);
          read(statement.value);
          break;
        case "update":
          onName(statement.name);
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
          onDeclare(statement.variable);
          onName(statement.of);
          statements(statement.body);
          break;
        case "print":
        case "expression":
          read(statement.value);
          break;
        case "indexAssign":
          onName(statement.buffer);
          read(statement.index);
          read(statement.value);
          break;
        case "try":
          if (statement.catchParam !== null) onDeclare(statement.catchParam);
          statements(statement.body);
          if (statement.catchBody !== null) statements(statement.catchBody);
          if (statement.finallyBody !== null) statements(statement.finallyBody);
          break;
        default:
          break;
      }
    }
  };
  for (const param of fn.params) if (param.default !== undefined) read(param.default);
  statements(fn.body);
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
function objectConstants(tokens: readonly Token[], open: number, close: number): { fields: Map<string, ConstantRange>; all: boolean } {
  const fields = new Map<string, ConstantRange>();
  let total = 0;
  let depth = 0;
  let index = open + 1;
  while (index < close - 1) {
    const token = tokens[index] as Token;
    if (token.text === "{" || token.text === "(" || token.text === "[") {
      depth += 1;
      index += 1;
      continue;
    }
    if (token.text === "}" || token.text === ")" || token.text === "]") {
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
        const written = tokens[end] as Token;
        if (written.text === "{" || written.text === "(" || written.text === "[") nested += 1;
        else if (written.text === "}" || written.text === ")" || written.text === "]") nested -= 1;
        else if (written.text === "," && nested === 0) break;
        end += 1;
      }
      if (constantRange(tokens, start, end)) fields.set(token.text, { start, end });
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
    if (token.kind === "number" || token.kind === "bigint" || token.kind === "string") continue;
    if (token.kind === "punct" && operators.has(token.text)) continue;
    if (token.kind === "ident" && token.text === "BigInt") continue;
    return false;
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* Lexer                                                                      */
/* -------------------------------------------------------------------------- */

export type TokenKind = "number" | "bigint" | "ident" | "punct" | "string" | "unknown" | "end";

export interface Token {
  kind: TokenKind;
  text: string;
  line: number;
  /** Set on a string written in backticks, whose `${...}` parts interpolate. */
  template?: boolean;
  /** The character the string was written with. */
  quote?: string;
}
const PUNCTUATION = ["===", "!==", "**=", "**", "==", "!=", "<=", ">=", ">>>=", ">>=", "<<=", "<<", ">>>", ">>", "&&", "||", "??=", "??", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "=>", "{", "}", "(", ")", "[", "]", ";", ",", ":", "?", "=", "<", ">", "+", "-", "*", "/", "%", ".", "!", "~", "&", "|", "^"];

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let line = 1;

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
      const match = /^(?:0[xX][0-9a-fA-F]+|[0-9]*\.[0-9]+|[0-9]+)(?:[eE][+-]?[0-9]+)?/.exec(source.slice(index));
      if (match === null) throw frontendError(`malformed number`, `line ${line}`);
      tokens.push({ kind: "number", text: match[0], line });
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

export interface TypeScriptFunction {
  name: string;
  /**
   * The parameters the function is written with. A parameter with a default is
   * callable without it, which the module answers with an overload: see
   * `defaultWrappers`.
   */
  params: { name: string; type: TypeExpr; default?: Expression }[];
  returns: TypeExpr;
  body: Statement[];
  line: number;
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

/** The operators that stand in front of a value, as opposed to between two. */
const UNARY_OPERATORS: readonly string[] = ["!", "-", "+", "~"];

class TypeScriptParser {
  tokens: Token[];
  private readonly path: string;
  private diagnostics: Diagnostics;
  private position = 0;
  /** How many loops the statement being read is written in. */
  private loops = 0;
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
  /**
   * Whether the file's bigints reach past the machine word. A `bigint` is
   * arbitrary precision in the language; this compiler holds it at the machine
   * word where every value fits, and at the wide whole number where one does
   * not, so the annotation is the width the file's own values reach.
   */
  wideBigint = false;

  constructor(
    tokens: Token[],
    path: string,
    diagnostics: Diagnostics,
    classTable?: ClassTable,
    allTokens?: Token[],
    constants: ReadonlyMap<string, ConstantInfo> = new Map(),
    state: ReadonlySet<string> = new Set(),
  ) {
    this.tokens = tokens;
    this.path = path;
    this.diagnostics = diagnostics;
    this.classTable = classTable ?? scanClasses(tokens);
    this.allTokens = allTokens ?? tokens;
    this.constants = constants;
    this.state = state;
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

  private report(message: string, detail: string, token: Token = this.peek()): void {
    this.diagnostics.report(message, detail, token.line);
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
    if (typeName === "any" || this.classTable.names.has(typeName)) return ANY_TYPE;
    if (typeName === "bigint" && this.wideBigint) return parseType("u256");
    try {
      return mapTypeScriptType(typeName, `line ${line} of ${this.path}`);
    } catch (error) {
      if (!isCompilerError(error)) throw error;
      this.report(error.message, error.detail ?? "", { kind: "ident", text: typeName, line });
      return ANY_TYPE;
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
  private constantExpression(name: string, range: ConstantRange | undefined): Expression | null {
    if (range === undefined || this.expanding.has(name)) return null;
    this.expanding.add(name);
    try {
      return this.readRange(range.start, range.end);
    } finally {
      this.expanding.delete(name);
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
    this.tokens = this.allTokens;
    this.currentClass = self ? info : null;
    this.valueClasses = new Map();
    this.valueTypes = new Map();
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
    }
  }

  /** A class parameter's annotation, held at the type the contract reads it at. */
  private rememberValueType(name: string, typeName: string, line: number): void {
    try {
      this.valueTypes.set(name, this.typeForName(typeName, line));
    } catch {
      this.valueTypes.set(name, ANY_TYPE);
    }
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
  ): DeclaredFunction {
    return {
      name,
      exported,
      params,
      returns,
      handle: { name, params, returns, body, line } satisfies TypeScriptFunction,
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
      out.push(this.declared(`${fn.name}__${arity}`, written, fn.returns, statements, exported, fn.line));
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
    if (info.base !== null) {
      this.report(
        `class inheritance is not supported ("${info.name}" extends "${info.base}")`,
        "write the fields and methods the class uses; a compiled class is one layout",
        { kind: "ident", text: info.name, line: info.line },
      );
    }
    const params = info.constructor?.params ?? [];
    const fields = this.fieldsOf(info, params);
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
      const value = this.withClassContext(info, params, true, () => this.readRange(field.initStart, field.initEnd));
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

    for (const method of info.methods) {
      const name = `${info.name}_${method.name}`;
      const returns = this.returnTypeForName(method.returnTypeName, method.line);
      const statements = this.withClassContext(info, method.params, true, () => {
        this.position = method.bodyStart;
        const read = this.readBlock();
        if (this.position !== method.bodyEnd) {
          this.report(`method "${method.name}" has a body of statements`, `near "${this.peek().text}"`);
        }
        return read;
      });
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
    for (const method of info.staticMethods) {
      const name = `${info.name}_${method.name}`;
      const returns = this.returnTypeForName(method.returnTypeName, method.line);
      const statements = this.withClassContext(info, method.params, false, () => {
        this.position = method.bodyStart;
        const read = this.readBlock();
        if (this.position !== method.bodyEnd) {
          this.report(`method "${method.name}" has a body of statements`, `near "${this.peek().text}"`);
        }
        return read;
      });
      out.push(this.declared(name, this.methodParams(method.params), returns, statements, info.exported, method.line));
      out.push(...this.wrappers(info, method, name, returns, false, info.exported));
    }
    for (const field of info.statics) {
      const value =
        field.initStart >= 0 && field.initEnd >= field.initStart
          ? this.withClassContext(info, [], false, () => this.readRange(field.initStart, field.initEnd))
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
   * Parses a module: the imports it binds, the functions it declares, and the
   * statements it runs.
   *
   * A function declaration is hoisted: the functions of a file are the
   * module's wherever they are written, so the body that runs before one does
   * not decide whether it is compiled, and a program and the functions it
   * calls are one source rather than one source reordered. A declaration the
   * module cannot hold is left where it was written, and so is every
   * declaration that calls it: a module function is compiled from a contract,
   * and a contract names only the functions the module holds.
   */
  parseModule(path: string): ModuleAnalysis {
    const imports: ModuleImport[] = [];
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
      if (atTop && this.at("import")) {
        const start = this.position;
        this.next();
        imports.push(this.readImport());
        importsWritten.push({ start, end: this.position });
        continue;
      }
      if (this.at("function") || this.at("export") || this.at("async")) {
        const declaration = this.readDeclaration(functions, namesExported);
        declarations.push(declaration);
        if (declaration.offers !== null) defaultExport = declaration.offers;
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
    // A file that runs nothing is a library: it has no body for a function the
    // module cannot hold to be read in, so the refusal the declaration earned
    // is the module's, reported where it was written.
    if (!runs) {
      for (const declaration of declarations) {
        if (!declaration.program) continue;
        for (const entry of declaration.refusal) this.diagnostics.report(entry.message, entry.detail, entry.line);
      }
    }
    const body = runs ? parseProgramBody(bodyTokens, path, this.diagnostics, this.classTable) : [];
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
    return { path, imports, functions, default: defaultExport, body };
  }

  /**
   * One declaration of the file, read with diagnostics of its own.
   *
   * A construct the module parser cannot read — an `async` function, a Promise
   * executor, a method a class does not declare — may still be a function of
   * the program, so what it earned is a refusal of the module and not of the
   * file. The declaration is left where it was written, and the refusal is
   * kept for a file that has no body to read it in.
   */
  private readDeclaration(functions: DeclaredFunction[], namesExported: Record<string, true>): Declaration {
    const start = this.position;
    const before = functions.length;
    const saved = this.diagnostics;
    const trial = new Diagnostics();
    this.diagnostics = trial;
    let offers: string | null = null;
    try {
      offers = this.readFunctionDeclaration(functions, namesExported);
    } finally {
      this.diagnostics = saved;
    }
    const end = this.position;
    const entries = functions.slice(before);
    // Everything the module cannot hold is read by the program instead: a
    // construct the module refused, or a function that reads a value the
    // running program holds. `export { f }` adds no function and refuses
    // nothing: it names functions, and is not a statement the body runs.
    const readsProgramState = entries.length > 0 && entries.some((entry) => readsState(entry.handle as TypeScriptFunction, this.state));
    const program = trial.entries.length > 0 || readsProgramState;
    if (program) {
      functions.length = before;
      this.position = start;
      // A function is skipped by the braces it is written in, whatever the
      // parser read of it; a construct that is not one is skipped as the
      // statement it is, so a refusal does not swallow what is written after it.
      if (this.declaresFunction(start)) this.skipFunctionBody(start);
      else this.synchronize();
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
      program,
      calls,
      refusal: [...trial.entries],
      offers,
    };
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
    if (this.at("async")) {
      const at = this.next();
      this.report("an async function is not supported", REFUSED_KEYWORDS.async, at);
      this.skipBlock();
      return null;
    }
    const exported = this.accept("export");
    if (exported && this.at("async")) {
      const at = this.next();
      this.report("an async function is not supported", REFUSED_KEYWORDS.async, at);
      this.skipBlock();
      return null;
    }
    let isDefault = false;
    if (exported && this.at("default")) {
      this.next();
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
    const parsed = this.parseFunction(name);
    if (parsed === null) return null;
    functions.push({
      name: parsed.name,
      exported,
      params: parsed.params,
      returns: parsed.returns,
      handle: parsed,
    });
    functions.push(...this.defaultWrappers(parsed, exported));
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
  private readImport(): ModuleImport {
    const start = this.peek();
    // `import d from "./x.ts"` and `import d, { a, b } from "./x.ts"`. The
    // local name a default import writes is not carried, because the programs
    // of this subset are linked by the name a function was declared with: one
    // table holds every function of every file, so a second name for one of
    // them would be a second compilation of it.
    if (!this.at("{") && !this.at("*") && (this.peek(1).kind === "ident" || this.peek(1).text === ",")) {
      this.next();
      return this.readImportTail(start, this.accept(",") ? this.readImportedNames() : [], true);
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
    return this.readImportTail(start, this.readImportedNames(), false);
  }

  /** `{ f, g }`: the exports an import names, which it binds as they are written. */
  private readImportedNames(): string[] {
    this.expect("{");
    const names: string[] = [];
    while (!this.at("}") && this.peek().kind !== "end") {
      const name = this.next();
      if (name.kind !== "ident") {
        this.report("expected an imported name", `near "${name.text}"`, name);
        continue;
      }
      if (this.at("as")) {
        this.report("renaming an import is not supported", `as written on line ${name.line}`, name);
        // The alias is read even though it is refused: the import is skipped as
        // the statement it is, so the `}` that closes it must be read here and
        // not left to end the statement.
        this.next();
        if (this.peek().kind === "ident") this.next();
      }
      names.push(name.text);
      if (!this.accept(",")) break;
    }
    this.expect("}");
    return names;
  }

  /** The `from "./other.ts"` every import ends with, and the module it names. */
  private readImportTail(start: Token, names: string[], isDefault: boolean): ModuleImport {
    if (!this.at("from")) {
      this.report('expected "from" after the imported names', `near "${this.peek().text}"`);
      this.synchronize();
      return { specifier: "", names, default: isDefault, line: start.line };
    }
    this.next();
    const specifier = this.next();
    if (specifier.kind !== "string") {
      this.report("expected the imported module as a string", `near "${specifier.text}"`, specifier);
      this.synchronize();
      return { specifier: "", names, default: isDefault, line: start.line };
    }
    this.expect(";");
    return { specifier: specifier.text, names, default: isDefault, line: start.line };
  }

  private parseFunction(name: Token): TypeScriptFunction | null {
    // A function declared by the module is not a method: `this` names nothing
    // in it, and the class each of its names holds starts empty.
    this.currentClass = null;
    this.valueClasses = new Map();
    this.valueTypes = new Map();
    this.expect("(");
    const params: TypeScriptFunction["params"] = [];
    if (this.at(")")) {
      this.next();
    } else {
      for (;;) {
        const parameter = this.next();
        if (parameter.kind !== "ident") {
          this.report("expected a parameter name", `near "${parameter.text}"`, parameter);
          this.synchronize();
          break;
        }
        // A parameter states its type, or states a default and has the type
        // that default is. `function invert(n: bigint, modulo = CURVE.P)` is
        // the second form: the default says what the parameter holds.
        let mapped: TypeExpr | null = null;
        if (this.accept(":")) {
          const type = this.peek();
          if (type.kind !== "ident") {
            this.report("expected a parameter type", `near "${type.text}"`, type);
            this.synchronize();
            break;
          }
          mapped = this.readTypeAnnotation("a parameter type");
          if (type.text && this.classTable.names.has(type.text)) this.valueClasses.set(parameter.text, type.text);
        }
        const fallback = this.accept("=") ? this.readExpression() : undefined;
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
        if (this.accept(",")) continue;
        this.expect(")");
        break;
      }
    }
    if (!this.at(":")) {
      // A function that states no result has the one its returns are. The body
      // is read here rather than refused, because the language lets a function
      // omit the annotation and the returns are what say it.
      const body = this.readBlock();
      return { name: name.text, params, returns: inferredResult(body, params), body, line: name.line };
    }
    this.next();
    const returns = this.peek();
    if (returns.kind !== "ident") {
      this.report("expected a return type", `near "${returns.text}"`, returns);
      this.skipBlock();
      return null;
    }
    const returnType = this.readTypeAnnotation("a return type");
    if (this.accept("=")) {
      // `function f(x: T): T = expr;` carries an optional trailing semicolon.
      const value = this.readExpression();
      this.accept(";");
      return {
        name: name.text,
        params,
        returns: returnType,
        body: [{ kind: "result", value, line: name.line }],
        line: name.line,
      };
    }
    return { name: name.text, params, returns: returnType, body: this.readBlock(), line: name.line };
  }

  /**
   * A type annotation, which may name a union of types. The union is held at
   * the one type that holds both members, so `number | bigint` is the bigint
   * member at the width the file's bigints reach.
   */
  private readTypeAnnotation(what: string): TypeExpr {
    const first = this.next();
    if (first.kind !== "ident") {
      this.report(`expected ${what}`, `near "${first.text}"`, first);
      return ANY_TYPE;
    }
    let name = first.text;
    while (this.accept("|")) {
      const other = this.next();
      if (other.kind !== "ident") {
        this.report(`expected ${what} after "|"`, `near "${other.text}"`, other);
        continue;
      }
      name = unionTypeName(name, other.text);
    }
    return this.mapType({ ...first, text: name });
  }

  /** A type annotation as the contract sees it; an unreadable one is `any`. */
  private mapType(token: Token): TypeExpr {
    if (token.text === "any" || token.text === "object" || token.text === "unknown") return ANY_TYPE;
    if (token.text === "void") return NOTHING;
    if (token.text === "bigint" && this.wideBigint) return parseType("u256");
    // A class names the layout an instance holds. The layout pass names the
    // object by its fields and the class's own name is an alias of it, so the
    // annotation is the reference a caller reads its fields through.
    if (this.classTable.names.has(token.text)) return this.referenceTo(token.text);
    try {
      return mapTypeScriptType(token.text, `line ${token.line} of ${this.path}`);
    } catch (error) {
      if (!isCompilerError(error)) throw error;
      this.report(error.message, error.detail ?? "", token);
      return ANY_TYPE;
    }
  }

  private readBlock(): Statement[] {
    if (!this.accept("{")) {
      this.report('expected "{"', "a function body is written in braces");
      return [];
    }
    const statements: Statement[] = [];
    while (!this.at("}") && this.peek().kind !== "end") {
      // An empty statement is not one the body does. A lone `;` read as a
      // call is a call the body never makes, which cost a function its
      // postcondition and left the build reporting a function it could not
      // check.
      if (this.accept(";")) continue;
      statements.push(...this.withPending(this.readStatement()));
    }
    this.expect("}");
    return statements;
  }

  /** A body that follows a keyword: a block, or the one statement written. */
  private readBody(): Statement[] {
    return this.at("{") ? this.readBlock() : this.withPending(this.readStatement());
  }

  /**
   * The statements one read produced. A destructuring declaration is lowered
   * to a temporary and a declaration for each name it binds, and the temporary
   * has to run before the names read it.
   */
  private withPending(statement: Statement): Statement[] {
    if (this.pending.length === 0) return [statement];
    const rest = this.pending;
    this.pending = [];
    return [statement, ...rest];
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
      if (this.accept(":")) {
        const annotation = this.peek();
        type = annotation.kind === "ident" ? this.readTypeAnnotation("a variable type") : null;
        if (annotation.kind === "ident" && this.classTable.names.has(annotation.text)) annotationClass = annotation.text;
      }
      if (!this.accept("=")) {
        this.report("a declaration needs an initialiser", `as in let ${name.text} = 0;`, name);
        this.synchronize();
        return { kind: "expression", value: this.hole(), line: name.line };
      }
      const init = this.readExpression();
      this.accept(";");
      const held = annotationClass ?? this.classOfExpression(init);
      if (held === null) this.valueClasses.delete(name.text);
      else this.valueClasses.set(name.text, held);
      this.valueTypes.set(name.text, type ?? resultType(init, this.valueTypes));
      return { kind: "declare", name: name.text, type, init, line: name.line };
    }

    if (this.at("for")) return this.readLoop();
    if (this.at("if")) return this.readIf();
    if (this.at("try")) return this.readTry();
    if (this.at("while")) return this.readWhile();
    if (this.at("do")) return this.readDoWhile();
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
      if (this.loops === 0) {
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
        this.report("a return states what the function returns", "return must carry a value", token);
        this.next();
        return { kind: "result", value: this.hole(), line: token.line };
      }
      const value = this.readExpression();
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

    const refused = REFUSED_KEYWORDS[token.text];
    if (refused !== undefined) {
      this.report(`"${token.text}" is not supported`, refused, token);
      this.skipBlock();
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
      let base: Expression = init;
      let head: Statement | null = null;
      if (!direct) {
        const temp = `__destructure${this.destructureCount++}`;
        head = { kind: "declare", name: temp, type: null, init, line };
        base = { k: "ident", name: temp };
      }
      fields.forEach((entry) => {
        const expanded = direct ? this.constantExpression(init.k === "ident" ? init.name : "", constant?.fields?.get(entry.field)) : null;
        this.pending.push({
          kind: "declare",
          name: entry.name,
          type: null,
          init: expanded ?? { k: "member", base, field: entry.field },
          line,
        });
      });
      const first = head ?? this.pending.shift();
      return first ?? ({ kind: "expression", value: this.hole(), line } satisfies Statement);
    }

    // `[a, b] = [x, y]`: the value is the array literal the source wrote, and
    // each name is the element at its position. A value that is not an array
    // literal is not an array this subset carries.
    const names: string[] = [];
    while (!this.at("]") && this.peek().kind !== "end") {
      if (this.accept("...")) {
        this.report("a rest element is not part of the destructuring subset", "write the names the pattern binds");
        this.synchronizeTo("]");
        break;
      }
      const name = this.next();
      if (name.kind !== "ident") this.report("a destructured element binds a name", `near "${name.text}"`, name);
      else names.push(name.text);
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
        `the pattern binds ${names.length} names and the value holds ${values.length} elements`,
        "write one value for each name",
        open,
      );
    }
    names.forEach((name, index) => {
      const value = values[index];
      if (value === undefined) return;
      this.pending.push({ kind: "declare", name, type: null, init: value, line });
    });
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
    if (operator.kind !== "punct" || !(operator.text in COMPOUND_OPERATORS)) {
      if (operator.text !== "=") {
        this.position = start;
        return null;
      }
      this.next();
      const value = this.readExpression();
      this.accept(";");
      const held = this.classOfExpression(value);
      if (held === null) this.valueClasses.delete(target.text);
      else this.valueClasses.set(target.text, held);
      return { kind: "assign", target: target.text, op: "=", value, line: target.line };
    }
    this.next();
    const value = this.readExpression();
    this.accept(";");
    // A compound assignment keeps the type the name already holds: `p = q` may
    // change what a name is, but `p += q` is a number operation on it.
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
    if (operator.kind !== "punct" || (operator.text !== "=" && !(operator.text in COMPOUND_OPERATORS))) {
      this.position = start;
      return null;
    }
    this.next();
    const value = this.readExpression();
    this.accept(";");
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
    this.next();
    const field = this.next();
    const operator = this.peek();
    if (field.kind !== "ident" || (operator.text !== "=" && operator.text !== "++" && operator.text !== "--" && !(operator.text in COMPOUND_OPERATORS))) {
      this.position = start;
      return null;
    }
    if (operator.text === "++" || operator.text === "--") {
      this.next();
      this.accept(";");
      return {
        kind: "memberAssign",
        base: base.text === "this" && this.currentClass !== null ? "self" : base.text,
        field: field.text,
        op: operator.text === "++" ? "+=" : "-=",
        value: { k: "literal", text: "1" },
        line: base.line,
      };
    }
    this.next();
    const value = this.readExpression();
    this.accept(";");
    return {
      kind: "memberAssign",
      base: base.text === "this" && this.currentClass !== null ? "self" : base.text,
      field: field.text,
      op: operator.text as AssignOperator,
      value,
      line: base.line,
    };
  }

  /** A call or an `i++` written for what it does. */
  private readEffect(): Statement {
    const token = this.peek();
    if (token.kind === "ident" && (this.peek(1).text === "++" || this.peek(1).text === "--")) {
      this.next();
      const op = this.next().text as "++" | "--";
      this.accept(";");
      return { kind: "update", name: token.text, op, prefix: false, line: token.line };
    }
    const value = this.readExpression();
    this.accept(";");
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
    if (!this.at("let") && !this.at("const") && !this.at("var")) {
      this.report("a loop must declare its index", "as in for (let i = 0; ...)", start);
      this.synchronize();
      return { kind: "expression", value: this.hole(), line: start.line };
    }
    this.next();
    const variable = this.next();
    if (variable.kind !== "ident") {
      this.report("expected a loop index name", `near "${variable.text}"`, variable);
      this.synchronize();
      return { kind: "expression", value: this.hole(), line: start.line };
    }
    if (this.at("of")) return this.readForOf(start, variable.text);
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

  private readIf(): Statement {
    const start = this.next();
    this.expect("(");
    const condition = this.readExpression();
    this.expect(")");
    // A branch whose condition is written false is not code the program runs,
    // and what it holds is not a construct the build should refuse.
    const dead = isNumberLiteral(condition, "0");
    const then = dead ? this.discardedBody() : this.readBody();
    const otherwise: Statement[] = [];
    if (this.accept("else")) {
      if (this.at("if")) otherwise.push(this.readIf());
      else otherwise.push(...this.readBody());
    }
    if (dead && otherwise.length === 0) return { kind: "expression", value: { k: "literal", text: "0" }, line: start.line };
    return { kind: "if", condition, then, otherwise, line: start.line };
  }

  /** A body the condition proves never runs, read without its diagnostics. */
  private discardedBody(): Statement[] {
    const saved = this.diagnostics;
    const savedTypes = this.valueTypes;
    const savedClasses = this.valueClasses;
    const savedPending = this.pending;
    this.diagnostics = new Diagnostics();
    this.valueTypes = new Map(savedTypes);
    this.valueClasses = new Map(savedClasses);
    this.pending = [];
    try {
      return this.readBody();
    } finally {
      this.diagnostics = saved;
      this.valueTypes = savedTypes;
      this.valueClasses = savedClasses;
      this.pending = savedPending;
    }
  }

  /**
   * `for (const x of values)`: it walks the elements of a typed array, whose
   * length the source may name as `values.length`, so nothing else is read.
   */
  private readForOf(start: Token, variable: string): Statement {
    this.expect("of");
    const of = this.next();
    if (of.kind !== "ident") {
      this.report("a for-of loop walks a typed array by name", `near "${of.text}"`, of);
      this.skipLoop();
      return { kind: "expression", value: this.hole(), line: start.line };
    }
    this.expect(")");
    return { kind: "forOf", variable, of: of.text, body: this.loopBody(), line: start.line };
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
    const body = this.readBody();
    this.loops -= 1;
    return body;
  }

  /**
   * Reads past a loop whose header the parser could not finish, so the
   * statements after it are read from the start of the next one rather than
   * from somewhere inside a body.
   */
  private skipLoop(): void {
    this.synchronizeTo(")");
    if (this.at("{")) this.skipBlock();
    else this.synchronize();
  }

  readExpression(): Expression {
    return this.readConditional();
  }

  /** `c ? a : b`, the loosest operator an expression has. */
  private readConditional(): Expression {
    const condition = this.readNullish();
    if (!this.at("?")) return condition;
    this.next();
    const then = this.readExpression();
    this.expect(":");
    const otherwise = this.readExpression();
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
      left = { k: "binary", op: "||", left, right: this.readLogicalAnd() };
    }
    return left;
  }

  private readNullish(): Expression {
    return this.readBinaryLevel(["??"], () => this.readLogicalOr());
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
      left = { k: "binary", op: "&&", left, right: this.readBitwiseOr() };
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
    // `x instanceof C` asks whether the value is an instance of a class. A
    // compiled instance is the object itself, so the answer is whether it is
    // there at all; the declared class is what says what it is when it is.
    while (this.at("instanceof")) {
      this.next();
      const name = this.next();
      if (name.kind !== "ident" || !this.classTable.names.has(name.text)) {
        this.report("instanceof names a class of this module", `near "${name.text}"`, name);
        continue;
      }
      // What the source says the value is settles the answer where it says
      // anything: an instance of one class is not an instance of another. A
      // value no type names may be any instance, so it is one when it is there.
      const held = this.classOfExpression(left);
      left =
        held === null
          ? { k: "binary", op: "!==", left, right: { k: "null" } }
          : {
              k: "binary",
              op: "===",
              left: { k: "literal", text: held === name.text ? "1" : "0" },
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
    if (token.kind === "ident" && token.text === "typeof") {
      this.next();
      const operand = this.readUnary();
      return this.typeofValue(operand, token);
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
   * `typeof value`: the name the value's type answers.
   *
   * A compiled program is typed before it runs, so the answer is read from the
   * type the value is held at rather than from a tag a value carries at run
   * time. A name the body declared is that declaration's type; a value written
   * out is its literal's type.
   */
  private typeofValue(operand: Expression, token: Token): Expression {
    let type: TypeExpr | null = null;
    if (operand.k === "ident") type = this.valueTypes.get(operand.name) ?? null;
    if (operand.k === "bigint") type = BIGINT_RESULT;
    if (operand.k === "literal") type = NUMBER_RESULT;
    if (operand.k === "text") type = TEXT_RESULT;
    if (operand.k === "null") return { k: "text", parts: [{ k: "text", value: "object" }] };
    if (type === null) {
      this.report(
        "typeof reads the type a name is declared at",
        `write the value into a name with the type it holds, near line ${token.line}`,
        token,
      );
      return { k: "text", parts: [{ k: "text", value: "undefined" }] };
    }
    return { k: "text", parts: [{ k: "text", value: typeofName(type) }] };
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

  /** A primary, then any number of indexings, field reads, calls and updates. */
  private readPostfix(): Expression {
    let base = this.readPrimary();
    for (;;) {
      if (this.at("[")) {
        this.next();
        const index = this.readExpression();
        this.expect("]");
        base = base.k === "argv" ? { k: "argv", index } : { k: "index", base, index };
        continue;
      }
      if (this.at("(")) {
        if (base.k === "member" && base.base.k === "ident" && NAMESPACES.has(base.base.name)) {
          // A call of a namespace is a call of the name the namespace and the
          // member spell together: `Math.floor(x)` is `Math.floor(x)`, and
          // `http.requestPath(req)` is the HTTP call of that name.
          base = { k: "ident", name: `${base.base.name}.${base.field}` };
        }
        // `Point.fromAffine(p)`: a static method is a function of the class,
        // with no instance written before its arguments.
        if (base.k === "member" && base.base.k === "ident") {
          const owner = this.classNamed(base.base.name);
          if (owner !== undefined && !this.valueClasses.has(base.base.name)) {
            const found = this.methodOwner(owner.name, base.field, true);
            if (found !== null) {
              const args = this.readCallArguments();
              base = { k: "call", name: methodFunctionName(found.owner, found.method, args.length), args };
              continue;
            }
          }
        }
        // `p.add(q)`: a method is a function whose first argument is the
        // instance the source called it on.
        if (base.k === "member") {
          const args = this.readCallArguments();
          const receiver = base.base;
          const found = this.methodOwner(this.classOfExpression(receiver), base.field, false);
          if (found === null) {
            this.report(
              `"${base.field}" is not a method this program compiles`,
              "a method is declared by a class the same module or its imports carry",
              this.peek(),
            );
            return this.hole();
          }
          base = {
            k: "call",
            name: methodFunctionName(found.owner, found.method, args.length),
            args: [receiver, ...args],
          };
          continue;
        }
        if (base.k !== "ident") return this.missing("only a named function is called", this.peek());
        const args = this.readCallArguments();
        base = { k: "call", name: base.name, args };
        continue;
      }
      if (this.at("++") || this.at("--")) {
        const op = this.next().text as "++" | "--";
        if (base.k !== "ident") return this.missing(`"${op}" needs a name to change`, this.peek());
        return { k: "update", name: base.name, op, prefix: false };
      }
      // These follow a value, so they are read here rather than as the name of
      // the next expression statement: `n as number` and `n!` are not
      // identifiers, and reading them as names reported the use of a name the
      // source never wrote instead of the construct it wrote.
      if (this.at("as") || this.at("satisfies") || this.at("!")) {
        const operator = this.next();
        this.report(
          `"${operator.text}" is not supported`,
          operator.text === "!"
            ? "a compiled function takes the value a name holds, as it is"
            : "a compiled function states the type a value already has, as its signature does",
          operator,
        );
        if (operator.text !== "!") this.next();
        continue;
      }
      if (this.at(".")) {
        this.next();
        const field = this.next();
        if (field.kind !== "ident") return this.missing("expected the property of a value", field);
        // A field of a constant object is the value the file wrote for it: the
        // object is not a value a compiled function can read, and the field it
        // asks for is one the source already answered.
        if (base.k === "ident") {
          const constant = this.constants.get(base.name);
          const expanded = this.constantExpression(base.name, constant?.fields?.get(field.text));
          if (expanded !== null) {
            base = expanded;
            continue;
          }
        }
        if (field.text === "length" && base.k === "ident") {
          base = { k: "length", buffer: base.name };
          continue;
        }
        if (field.text === "toFixed" && this.at("(")) {
          base = this.fixed(base);
          continue;
        }
        if (field.text === "toString" && this.at("(")) {
          base = this.hexadecimal(base);
          continue;
        }
        if (field.text === "length" && base.k === "argv") {
          base = { k: "call", name: ARGV_LENGTH, args: [] };
          continue;
        }
        // `Point.ZERO`: a static field is a function of the class, so reading
        // it is a call that answers the value the source declared.
        if (base.k === "ident" && !this.valueClasses.has(base.name)) {
          const owner = this.classNamed(base.name);
          if (owner !== undefined) {
            const found = findField(this.classTable, owner.name, field.text, true);
            if (found !== null) {
              base = { k: "call", name: `${found.owner}_${found.field.name}`, args: [] };
              continue;
            }
          }
        }
        base = { k: "member", base, field: field.text };
        continue;
      }
      return base;
    }
  }

  /** The arguments of a call, from the `(` the parser is at to its `)`. */
  private readCallArguments(): Expression[] {
    this.next();
    const args: Expression[] = [];
    if (!this.at(")")) {
      do {
        args.push(this.readExpression());
      } while (this.accept(","));
    }
    this.expect(")");
    return args;
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

  private readPrimary(): Expression {
    const token = this.next();
    if (token.kind === "unknown") {
      this.report(`unsupported token "${token.text}"`, `line ${token.line} of ${this.path}`, token);
      // The rest of the expression is read past, so one unknown character is
      // reported as the one construct it is.
      this.synchronize(false);
      return this.hole();
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
      // A function body is a straight line: there is no promise to wait for
      // inside one, so the word is named where it was written rather than read
      // past as the name of a value.
      this.report(`"${token.text}" is not supported`, REFUSED_KEYWORDS[token.text], token);
      this.readExpression();
      return this.hole();
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
        const expanded = this.constantExpression(token.text, constant.expression);
        if (expanded !== null) return expanded;
      }
      return { k: "ident", name: token.text };
    }
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
    while (!this.at("}") && this.peek().kind !== "end") {
      const key = this.next();
      const name = key.kind === "ident" || key.kind === "string" ? key.text : null;
      if (name === null) {
        this.report("an object field is named", `near "${key.text}"`, key);
      } else {
        this.expect(":");
        fields.push({ name, value: this.readExpression() });
      }
      if (!this.accept(",")) break;
    }
    this.expect("}");
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
        const args = this.readCallArguments();
        const params = info.constructor?.params ?? [];
        return { k: "call", name: methodFunctionName(info.name, { name: "constructor", params, returnTypeName: info.name, bodyStart: -1, bodyEnd: -1, line: info.line }, args.length), args };
      }
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
      const parser = new TypeScriptParser(tokenize(inner), this.path, this.diagnostics, this.classTable);
      parser.currentClass = this.currentClass;
      parser.valueClasses = new Map(this.valueClasses);
      parser.valueTypes = new Map(this.valueTypes);
      parser.wideBigint = this.wideBigint;
      const value = parser.readExpression();
      if (parser.peek().kind !== "end") {
        this.report(`"${parser.peek().text}" follows a complete value`, `in the text of line ${token.line}`, parser.peek());
      }
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
            else
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
      case "literal":
      case "bigint":
      case "ident":
      case "null":
      case "length":
      case "update":
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
      case "result":
      case "throw":
      case "expression":
      case "memberAssign":
        expression(one.value);
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
        this.result = this.serialize(statement.value, loop, statement.line);
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
          throw frontendError(`indexing unknown parameter "${expression.base.name}"`, `line ${line}`);
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
  }
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

export const typeScriptFrontend: Frontend = {
  analyze(source, path) {
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
    const parser = new TypeScriptParser(withoutClasses(tokens, classTable), path, diagnostics, classTable, tokens, scanned.constants, scanned.state);
    parser.wideBigint = wideBigint;
    const analysis = parser.parseModule(path);
    // A file read as a program has its whole text readable as statements, so a
    // nested function inside a function that the module parser stopped for is
    // read by the one parser whose grammar carries that shape. The module
    // parse's nested-function entries are still the answer if that fails too.
    if (parser.nestedFunction) {
      const fromStatements = tokensAfterImports(parser["tokens"]);
      const programDiagnostics = new Diagnostics();
      try {
        const statements = parseProgramBody(fromStatements, path, programDiagnostics, classTable);
        if (programDiagnostics.entries.length === 0) {
          // The class functions were lowered from declarations the program
          // parser never sees, so they travel with the body: they are the
          // constructors and methods the statements call.
          return {
            path,
            imports: analysis.imports,
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
    if (body.result !== null && body.result.includes("len(")) {
      throw frontendError(
        `the result of ${declaration.name} depends on a buffer length`,
        `${analysis.path}: the callee only receives the pointer, so pass the length as a parameter and loop over that`,
      );
    }
    const usage = usageOf(declaration);
    return assembleContract({
      name: declaration.name,
      symbol: declaration.name === "main" ? PROGRAM_ENTRY_SYMBOL : declaration.name,
      params: declaration.params,
      returns: declaration.returns,
      result: body.result,
      accesses: usage.accesses,
      definition: {
        statements: declaration.body,
        allocates: usage.allocates,
        prints: usage.prints,
        readsArgv: usage.readsArgv,
      },
      input,
    });
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

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
 *   - top level: `import { name } from "./other.ts";`, function declarations
 *     with or without `export`, and the statements of a program (see
 *     typescript-program.ts), which come after every declaration
 *   - statements: let/const/var with an initialiser, counted for loops in
 *     either direction, for-of loops, while, do-while, break, continue,
 *     if/else, assignments, compound assignments, `i++`, calls, returns and
 *     console.log
 *   - expressions: number and bigint literals, null, identifiers, indexing,
 *     field reads, calls, object literals, `process.argv`, the comparison,
 *     logical, shift and arithmetic operators, the conditional operator and
 *     parentheses
 *   - types: number, bigint, boolean, the typed array views, and `any` for a
 *     value that is a reference to an object
 *   - a function is compiled whatever it does: only the contracts that can
 *     be written as one expression describe a result, so a body that
 *     branches, recurses, allocates or prints is contracted by what it does,
 *     the contract carrying the statements themselves as a definition
 */

import { parseType, typeToString } from "./contract.ts";
import { ARGV, ARGV_LENGTH } from "./builtins.ts";

export { ARGV, ARGV_LENGTH };
import { assembleContract, bufferContract, type AccessRange } from "./contract-build.ts";
import { normalizeNumeric, normalizeOptimize } from "./contract.ts";
import { CompilerError, isCompilerError } from "../core/errors.ts";
import type { DeclaredFunction, Frontend, ModuleAnalysis, ModuleImport } from "./module.ts";
import { parseProgramBody } from "./typescript-program.ts";
import type { Effect, FunctionContract, SourceInput, TypeExpr } from "../core/types.ts";
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

export function frontendError(message: string, detail?: string): CompilerError {
  return new CompilerError({ category: "FrontendError", stage: "frontend", message, detail });
}

/* -------------------------------------------------------------------------- */
/* Diagnostics                                                                 */
/* -------------------------------------------------------------------------- */

/** One construct the parser could not read, and where it was written. */
export interface Diagnostic {
  line: number;
  message: string;
  detail: string;
}

/** How many constructs one file may be reported to have before the list is cut. */
const MAXIMUM_DIAGNOSTICS = 24;

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

/**
 * Every construct of one file that is outside the subset, gathered as the
 * parser reads on. A file is fixed in one pass, so a build says everything
 * that is wrong with it at once rather than one construct per run.
 */
export class Diagnostics {
  readonly entries: Diagnostic[] = [];
  private dropped = 0;

  report(message: string, detail: string, line: number): void {
    if (this.entries.length < MAXIMUM_DIAGNOSTICS) {
      this.entries.push({ line, message, detail });
      return;
    }
    this.dropped += 1;
  }

  throwIfAny(path: string): void {
    if (this.entries.length === 0) return;
    const found = this.entries.map((entry) => `  line ${entry.line}: ${entry.message}\n    ${entry.detail}`);
    if (this.dropped > 0) found.push(`  and ${this.dropped} more`);
    throw frontendError(
      `${this.entries.length + this.dropped} construct${this.entries.length + this.dropped === 1 ? "" : "s"} of ${path} ${this.entries.length + this.dropped === 1 ? "is" : "are"} outside the subset the compiler reads`,
      found.join("\n"),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/** A value that is a reference to an object, before its fields are known. */
const ANY_TYPE: TypeExpr = { kind: "ref", of: null };


/** Statements the parser reads to the end of the statement and reports. */
/** The operators the contract expression language states a result with. */
const CONTRACT_OPERATORS: readonly BinaryOp[] = [
  "+",
  "-",
  "*",
  "/",
  "%",
  "<<",
  ">>",
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
const ARITHMETIC_OPERATORS: readonly BinaryOp[] = ["+", "-", "*", "/", "%"];

const UNSUPPORTED_STATEMENTS = ["switch", "try", "throw", "class", "interface", "type", "enum", "import"];

/** What a function body may say, as the refusals of what it may not say state it. */
const FUNCTION_BODY =
  "a function is declarations, counted loops, while and do-while loops, for-of loops, break and continue, conditionals, calls, assignments, returns and console.log";

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
};

/** A function that returns nothing declares `void`. */
const NOTHING: TypeExpr = { kind: "void" };

/** Maps a TypeScript type annotation onto a contract type. */
export function mapTypeScriptType(text: string, position: string): TypeExpr {
  const source = text.trim();
  if (source in PRIMITIVES) return parseType(PRIMITIVES[source]);
  if (source in TYPED_ARRAYS) return { kind: "slice", of: parseType(TYPED_ARRAYS[source]) };
  throw frontendError(
    `unsupported TypeScript type "${source}"`,
    `at ${position}; supported: ${Object.keys(PRIMITIVES).join(", ")}, ${Object.keys(TYPED_ARRAYS).join(", ")}`,
  );
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
const PUNCTUATION = ["===", "!==", "**=", "**", "==", "!=", "<=", ">=", "<<", ">>", "&&", "||", "??=", "??", "++", "--", "+=", "-=", "*=", "/=", "%=", "=>", "{", "}", "(", ")", "[", "]", ";", ",", ":", "?", "=", "<", ">", "+", "-", "*", "/", "%", ".", "!", "~", "&", "|", "^"];

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
        if (backslashes % 2 === 0) break;
        end += 1;
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
    if (source.startsWith("n", index) && /[0-9.]/.test(source[index - 1] ?? "")) {
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
  params: { name: string; type: TypeExpr }[];
  returns: TypeExpr;
  body: Statement[];
  line: number;
}

class TypeScriptParser {
  private readonly tokens: Token[];
  private readonly path: string;
  private readonly diagnostics: Diagnostics;
  private position = 0;
  /** How many loops the statement being read is written in. */
  private loops = 0;

  constructor(tokens: Token[], path: string, diagnostics: Diagnostics) {
    this.tokens = tokens;
    this.path = path;
    this.diagnostics = diagnostics;
  }
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
   * statements it runs. A program is the last thing a module says, so the
   * first statement ends the declarations.
   */
  parseModule(path: string): ModuleAnalysis {
    const imports: ModuleImport[] = [];
    const functions: DeclaredFunction[] = [];
    while (this.peek().kind !== "end") {
      if (this.at("import")) {
        this.next();
        imports.push(this.readImport());
        continue;
      }
      const token = this.peek();
      if (token.kind !== "ident" || (token.text !== "export" && token.text !== "function")) {
        // The body runs to the end of the file: a declaration after it belongs
        // to a library, not to a program.
        return { path, imports, functions, body: parseProgramBody(this.tokens.slice(this.position), path, this.diagnostics) };
      }
      const exported = this.accept("export");
      if (exported && this.at("default")) {
        this.report("a default export is not supported", "export the function by name", token);
        this.skipBlock();
        continue;
      }
      if (exported && !this.at("function")) {
        this.report("only functions can be exported", `a module offers functions, not ${this.peek().text}`, token);
        this.synchronize();
        continue;
      }
      this.expect("function");
      const name = this.next();
      if (name.kind !== "ident") {
        this.report("expected a function name", `near "${name.text}"`, name);
        this.synchronize();
        continue;
      }
      const parsed = this.parseFunction(name);
      if (parsed === null) continue;
      functions.push({
        name: parsed.name,
        exported,
        params: parsed.params,
        returns: parsed.returns,
        handle: parsed,
      });
    }
    return { path, imports, functions, body: [] };
  }

  /** `import { f, g } from "./other.ts";` is the only import form a module has. */
  private readImport(): ModuleImport {
    const start = this.peek();
    if (!this.at("{")) {
      this.report(
        "unsupported import form",
        'a module imports named exports, as in import { f } from "./other.ts"',
        start,
      );
      this.synchronize();
      return { specifier: "", names: [], line: start.line };
    }
    this.next();
    const names: string[] = [];
    while (!this.at("}") && this.peek().kind !== "end") {
      const name = this.next();
      if (name.kind !== "ident") {
        this.report("expected an imported name", `near "${name.text}"`, name);
        continue;
      }
      if (this.at("as")) this.report("renaming an import is not supported", `as written on line ${name.line}`, name);
      names.push(name.text);
      if (!this.accept(",")) break;
    }
    this.expect("}");
    if (!this.at("from")) {
      this.report('expected "from" after the imported names', `near "${this.peek().text}"`);
      this.synchronize();
      return { specifier: "", names, line: start.line };
    }
    this.next();
    const specifier = this.next();
    if (specifier.kind !== "string") {
      this.report("expected the imported module as a string", `near "${specifier.text}"`, specifier);
      this.synchronize();
      return { specifier: "", names, line: start.line };
    }
    this.expect(";");
    return { specifier: specifier.text, names, line: start.line };
  }

  private parseFunction(name: Token): TypeScriptFunction | null {
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
        this.expect(":");
        const type = this.next();
        if (type.kind !== "ident") {
          this.report("expected a parameter type", `near "${type.text}"`, type);
          this.synchronize();
          break;
        }
        params.push({ name: parameter.text, type: this.mapType(type) });
        if (this.accept(",")) continue;
        this.expect(")");
        break;
      }
    }
    if (!this.at(":")) {
      this.report(
        "every function declares what it returns",
        `as in function ${name.text}(): number { ... }`,
        name,
      );
      this.skipBlock();
      return null;
    }
    this.next();
    const returns = this.next();
    if (returns.kind !== "ident") {
      this.report("expected a return type", `near "${returns.text}"`, returns);
      this.skipBlock();
      return null;
    }
    const returnType = this.mapType(returns);
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

  /** A type annotation as the contract sees it; an unreadable one is `any`. */
  private mapType(token: Token): TypeExpr {
    if (token.text === "any" || token.text === "object" || token.text === "unknown") return ANY_TYPE;
    if (token.text === "void") return NOTHING;
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
      statements.push(this.readStatement());
    }
    this.expect("}");
    return statements;
  }

  /** A body that follows a keyword: a block, or the one statement written. */
  private readBody(): Statement[] {
    return this.at("{") ? this.readBlock() : [this.readStatement()];
  }

  readStatement(): Statement {
    const token = this.peek();
    if (this.accept(";")) return { kind: "expression", value: this.hole(), line: token.line };

    if (this.at("let") || this.at("const") || this.at("var")) {
      this.next();
      const name = this.next();
      if (name.kind !== "ident") {
        this.report("expected a variable name", `near "${name.text}"`, name);
        this.synchronize();
        return { kind: "expression", value: this.hole(), line: token.line };
      }
      let type: TypeExpr | null = null;
      if (this.accept(":")) {
        const annotation = this.next();
        type = annotation.kind === "ident" ? this.mapType(annotation) : null;
      }
      if (!this.accept("=")) {
        this.report("a declaration needs an initialiser", `as in let ${name.text} = 0;`, name);
        this.synchronize();
        return { kind: "expression", value: this.hole(), line: name.line };
      }
      const init = this.readExpression();
      this.accept(";");
      return { kind: "declare", name: name.text, type, init, line: name.line };
    }

    if (this.at("for")) return this.readLoop();
    if (this.at("if")) return this.readIf();
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

    if (UNSUPPORTED_STATEMENTS.includes(token.text)) {
      this.report(
        `"${token.text}" is not supported`,
        FUNCTION_BODY,
        token,
      );
      this.synchronize();
      return { kind: "expression", value: this.hole(), line: token.line };
    }
    if (this.at("{")) {
      this.report("a block is not a statement of its own", "write the statements it holds", token);
      this.readBlock();
      return { kind: "expression", value: this.hole(), line: token.line };
    }
    if (this.at("function")) {
      this.report("a function may not be declared inside a function", "declare it in the module", token);
      this.synchronize();
      return { kind: "expression", value: this.hole(), line: token.line };
    }

    const assigned = this.readAssignment();
    if (assigned !== null) return assigned;
    return this.readEffect();
  }

  /** An assignment, an index write or a field write. */
  private readAssignment(): Statement | null {
    const start = this.position;
    const target = this.next();
    if (target.kind !== "ident") {
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
      return { kind: "assign", target: target.text, op: "=", value, line: target.line };
    }
    this.next();
    const value = this.readExpression();
    this.accept(";");
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
    if (!this.accept("=")) {
      this.position = start;
      return null;
    }
    const value = this.readExpression();
    this.accept(";");
    return { kind: "indexAssign", buffer: buffer.text, index, value, line: buffer.line };
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
    if (field.kind !== "ident" || !this.at("=")) {
      this.position = start;
      return null;
    }
    this.next();
    const value = this.readExpression();
    this.accept(";");
    return { kind: "memberAssign", base: base.text, field: field.text, op: "=", value, line: base.line };
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

  private readIf(): Statement {
    const start = this.next();
    this.expect("(");
    const condition = this.readExpression();
    this.expect(")");
    const then = this.readBody();
    const otherwise: Statement[] = [];
    if (this.accept("else")) {
      if (this.at("if")) otherwise.push(this.readIf());
      else otherwise.push(...this.readBody());
    }
    return { kind: "if", condition, then, otherwise, line: start.line };
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
    return this.readBinaryLevel(["||"], () => this.readLogicalAnd());
  }

  private readNullish(): Expression {
    return this.readBinaryLevel(["??"], () => this.readLogicalOr());
  }

  private readLogicalAnd(): Expression {
    return this.readBinaryLevel(["&&"], () => this.readEquality());
  }

  private readEquality(): Expression {
    return this.readBinaryLevel(["===", "!==", "==", "!="], () => this.readComparison());
  }

  private readComparison(): Expression {
    return this.readBinaryLevel(["<", "<=", ">", ">="], () => this.readShift());
  }

  private readShift(): Expression {
    return this.readBinaryLevel(["<<", ">>"], () => this.readAdditive());
  }

  private readAdditive(): Expression {
    return this.readBinaryLevel(["+", "-"], () => this.readMultiplicative());
  }

  private readMultiplicative(): Expression {
    return this.readBinaryLevel(["*", "/", "%"], () => this.readPower());
  }

  /** `a ** b`: right associative, and tighter than a sign on its left. */
  private readPower(): Expression {
    const base = this.readUnary();
    if (!this.at("**")) return base;
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
    if (token.kind === "punct" && (token.text === "!" || token.text === "-" || token.text === "+" || token.text === "~")) {
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
        if (base.k === "member" && base.base.k === "ident" && base.base.name === "Math") {
          base = { k: "ident", name: `Math.${base.field}` };
        }
        if (base.k !== "ident") return this.missing("only a named function is called", this.peek());
        this.next();
        const args: Expression[] = [];
        if (!this.at(")")) {
          do {
            args.push(this.readExpression());
          } while (this.accept(","));
        }
        this.expect(")");
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
        if (field.text === "length" && base.k === "ident") {
          base = { k: "length", buffer: base.name };
          continue;
        }
        if (field.text === "length" && base.k === "argv") {
          base = { k: "call", name: ARGV_LENGTH, args: [] };
          continue;
        }
        base = { k: "member", base, field: field.text };
        continue;
      }
      return base;
    }
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
      if (token.template !== true) {
        this.report("a quoted string is not a value", "write text as a template string, as in `depth ${depth}`", token);
        return { k: "literal", text: "0" };
      }
      return { k: "text", parts: this.text(token) };
    }
    if (token.kind === "ident") {
      if (token.text === "true" || token.text === "false") return { k: "literal", text: token.text === "true" ? "1" : "0" };
      if (token.text === "null" || token.text === "undefined") return { k: "null" };
      if (token.text === "process" && this.at(".") && this.peek(1).text === "argv") {
        this.next();
        this.next();
        return { k: "argv", index: null };
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
      const parser = new TypeScriptParser(tokenize(inner), this.path, this.diagnostics);
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
 * What a body does, as the contract states it when no expression can: whether
 * it allocates, prints or reads the command line, and the buffer ranges it
 * reads. The ranges are the ones the contracted path collects too, so a
 * definition says which buffers it reads and how long they must be, exactly
 * as a reduction does.
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
        // name — one that reads a local, or a call — is left out rather than
        // guessed at.
        const base = value.base;
        if (base.k === "ident" && parameters.has(base.name)) {
          const loop = value.index.k === "ident" ? loops.get(value.index.name) : undefined;
          if (loop !== undefined) access(base.name, loop.lo, loop.hi);
          else {
            const at = text(value.index);
            if (at !== null) access(base.name, at, `(${at} + 1)`);
          }
        }
        expression(value.base);
        expression(value.index);
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
      case "expression":
      case "memberAssign":
        expression(one.value);
        return;
      case "indexAssign":
        expression(one.index);
        expression(one.value);
        return;
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
        // over the single turn that reads it.
        const from = text(one.from);
        const to = text(one.to);
        const outer = loops.get(one.variable);
        if (from !== null && to !== null) loops.set(one.variable, { lo: from, hi: one.inclusive ? `(${to} + 1)` : to });
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

/**
 * The contract of a function whose result is not one expression. It states the
 * signature, what the function does to the world, and the statements it runs:
 * the program contract, the target and the module source are what a backend
 * writes from, and the compiler checks the result by running the program.
 * What the body reads is stated the same way a reduction states it, so a
 * caller is still refused the buffers the body would read out of bounds.
 */
/** The symbol a program entry named `main` is compiled under: a program is
 *  hosted by one that has a `main` of its own, so the two cannot share it. */
const PROGRAM_ENTRY_SYMBOL = "blaze_main";

function definitionContract(declaration: TypeScriptFunction, input: SourceInput): FunctionContract {
  const usage = usageOf(declaration);
  const buffers = bufferContract(declaration.params, usage.accesses);
  const effects: Effect[] = [];
  if (usage.allocates) effects.push("memory");
  if (usage.prints) effects.push("io");
  if (usage.readsArgv) effects.push("syscall");
  return {
    version: "1",
    function: {
      name: declaration.name,
      symbol: declaration.name === "main" ? PROGRAM_ENTRY_SYMBOL : declaration.name,
      params: declaration.params.map((param) => ({ name: param.name, type: typeToString(param.type) })),
      returns: typeToString(declaration.returns),
    },
    requires: buffers.requires,
    ensures: [],
    memory: { reads: buffers.reads, writes: [], aliasing: [] },
    effects,
    numeric: normalizeNumeric(input.numeric),
    optimize: normalizeOptimize(input.optimize),
    definition: { statements: declaration.body, objects: {}, ...usage },
  };
}

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
  "a contract is one expression the result must equal, so this body is contracted as a definition: the contract carries the statements themselves";

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
    if (this.result === null) {
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
        this.bindings.set(
          statement.target,
          statement.op === "=" ? value : `(${current} ${statement.op[0]} ${value})`,
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
    if (inner.op === "-=" || inner.op === "/=") {
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
            "the body is contracted as a definition, which is what a function that branches or calls has",
          );
        }
        return `(${expression.op}${this.serialize(expression.operand, loop, line)})`;
      case "binary":
        if (!CONTRACT_OPERATORS.includes(expression.op)) {
          this.uncontractable(
            `computes with ${expression.op}, which a contract cannot state`,
            line,
            "the body is contracted as a definition, which is what a function that branches or calls has",
          );
        }
        return `(${this.serialize(expression.left, loop, line)} ${expression.op} ${this.serialize(expression.right, loop, line)})`;
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
    case "member":
      return dependsOn(expression.base, name);
    case "call":
      return expression.args.some((argument) => dependsOn(argument, name));
    case "object":
      return expression.fields.some((field) => dependsOn(field.value, name));
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
    case "member":
      return `${describe(expression.base)}.${expression.field}`;
    case "argv":
      return "process.argv";
    case "object":
      return "an object";
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

export const typeScriptFrontend: Frontend = {
  analyze(source, path) {
    if (typeof source !== "string" || source.trim() === "") {
      throw frontendError(`module ${path} is empty`);
    }
    const diagnostics = new Diagnostics();
    const analysis = new TypeScriptParser(tokenize(source), path, diagnostics).parseModule(path);
    // A file is read to the end whatever it holds, so a build names every
    // construct outside the subset instead of the first one.
    diagnostics.throwIfAny(path);
    return analysis;
  },

  contractFor(analysis, declared, input) {
    const declaration = declared.handle as TypeScriptFunction;
    const body = new BodyAnalysis(declaration).run();
    // A result that is one expression is the contract: it states the semantics
    // a backend has to meet, and the compiler is the oracle that decides it.
    if (body.result === null) return definitionContract(declaration, input);
    // A buffer length is a property of the value, not of the pointer the callee
    // receives: the implementation cannot observe it, so the result may not
    // depend on it. Preconditions may, because the caller checks them.
    if (body.result.includes("len(")) {
      throw frontendError(
        `the result of ${declaration.name} depends on a buffer length`,
        `${analysis.path}: the callee only receives the pointer, so pass the length as a parameter and loop over that`,
      );
    }
    return assembleContract({
      name: declaration.name,
      symbol: declaration.name === "main" ? PROGRAM_ENTRY_SYMBOL : declaration.name,
      params: declaration.params,
      returns: declaration.returns,
      result: body.result,
      accesses: body.accesses,
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

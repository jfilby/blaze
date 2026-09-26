/**
 * Frontend: the statements a TypeScript module runs.
 *
 * A module is either a library of functions or a program. This file reads the
 * program: the statements of the entry module, in the order they run. The
 * subset is what a program needs to drive the functions the compiler compiles:
 *
 *   const a = new Float64Array([1, 2, 3, 4]);
 *   const total = dotProduct(a, b, a.length);
 *   console.log(`done: ${total}`);
 *   main();
 *
 *   - statements: const declarations, `console.log` and a call kept for what
 *     it does
 *   - values: number literals, string and template literals, typed array
 *     literals, names, `name.length`, `name[index]`, `process.argv` and calls
 *   - a template string interpolates values; its text is taken as written, with
 *     the escapes in ESCAPES resolved and any other escape left as written
 *
 * The statements are not contracted. The contract phase (see program.ts) keeps
 * them as the program, and the driver the compiler emits runs them.
 */

import type { ProgramStatement, ProgramText, ProgramValue } from "./module.ts";
import type { Diagnostics, Token } from "./typescript.ts";
import { ARGV, ARGV_LENGTH, tokenize, unescape } from "./typescript.ts";
import { BUILTINS, MATH_NAMES } from "./builtins.ts";

/** The array views a program can allocate. */
const VIEWS: Record<string, string> = {
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

const VIEWS_LIST = Object.keys(VIEWS).join(", ");

const MATH = MATH_NAMES.join(", ");

class ProgramParser {
  private readonly tokens: Token[];
  private readonly path: string;
  private readonly diagnostics: Diagnostics;
  private position = 0;

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

  private expect(text: string): void {
    if (this.accept(text)) return;
    const token = this.peek();
    this.fail(`expected "${text}"`, token);
  }

  private fail(message: string, token: Token = this.peek()): void {
    this.diagnostics.report(
      message,
      `near "${token.text}"; a program declares values with const, prints them with console.log, and calls what it runs`,
      token.line,
    );
  }

  /** Reads on to the end of the statement, so the next one can be read. */
  private synchronize(): void {
    let depth = 0;
    while (this.peek().kind !== "end") {
      const token = this.next();
      if (token.kind !== "punct") continue;
      if (token.text === "(" || token.text === "[" || token.text === "{") depth += 1;
      else if (token.text === ")" || token.text === "]" || token.text === "}") depth -= 1;
      else if (token.text === ";" && depth <= 0) return;
    }
  }

  private identifier(what: string): string {
    const token = this.peek();
    if (token.kind !== "ident") {
      this.fail(`expected ${what}`, token);
      return "";
    }
    this.next();
    return token.text;
  }
  /** The statements of the body, to the end of the tokens it was given. */
  body(): ProgramStatement[] {
    const statements: ProgramStatement[] = [];
    while (this.peek().kind !== "end") {
      statements.push(this.statement());
      this.accept(";");
    }
    return statements;
  }

  /** The value a statement the parser could not read stands for. */
  private nothing(): ProgramValue {
    return { k: "number", text: "0" };
  }

  private statement(): ProgramStatement {
    const line = this.peek().line;
    if (this.accept(";")) return { kind: "print", value: this.nothing(), line };
    if (this.at("const") || this.at("let") || this.at("var")) {
      this.next();
      const name = this.identifier("the name of a declared value");
      this.expect("=");
      return { kind: "declare", name, value: this.value(), line };
    }
    if (this.at("console")) {
      this.next();
      this.expect(".");
      const method = this.next();
      if (method.text !== "log") {
        this.fail(`console.${method.text} is not part of a program`, method);
        this.synchronize();
        return { kind: "print", value: this.nothing(), line };
      }
      this.expect("(");
      const value = this.value();
      this.expect(")");
      return { kind: "print", value, line };
    }
    if (this.at("for") || this.at("while") || this.at("if")) {
      this.fail(
        `"${this.peek().text}" is not a statement of a program`,
        this.peek(),
      );
      this.synchronize();
      return { kind: "print", value: this.nothing(), line };
    }
    // A call kept for what it does, as in `main();`.
    if (this.peek().kind === "ident" && this.peek(1).text === "(") {
      const name = this.identifier("the name of the function to call");
      this.expect("(");
      const args: ProgramValue[] = [];
      if (!this.at(")")) {
        do {
          args.push(this.value());
        } while (this.accept(","));
      }
      this.expect(")");
      return { kind: "invoke", function: name, args, line };
    }
    const token = this.peek();
    this.fail(`"${token.text}" is not a statement of a program`, token);
    this.synchronize();
    return { kind: "print", value: this.nothing(), line };
  }

  private value(): ProgramValue {
    const token = this.peek();
    if (token.kind === "number") {
      this.next();
      return { k: "number", text: token.text };
    }
    if (this.at("-") && this.peek(1).kind === "number") {
      this.next();
      return { k: "number", text: `-${this.next().text}` };
    }
    if (token.kind === "string") {
      this.next();
      return { k: "text", parts: this.parts(token) };
    }
    if (token.kind !== "ident") {
      this.fail(`"${token.text}" is not a value`, token);
      return this.nothing();
    }
    if (token.text === "new") {
      this.next();
      return this.bufferLiteral();
    }
    return this.nameOrCall();
  }

  /** A name, a call, a length, an element of a name, or an argument. */
  private nameOrCall(): ProgramValue {
    const token = this.peek();
    if (token.kind === "ident" && token.text === "process" && this.peek(1).text === "." && this.peek(2).text === "argv") {
      this.next();
      this.next();
      this.next();
      return this.argv();
    }
    const name = this.identifier("a name");
    if (name === "Math" && this.at(".") && !MATH_NAMES.includes(`Math.${this.peek(1).text}`)) {
      this.fail(`Math.${this.peek(1).text} is not a function of a program; call one of ${MATH}`, this.peek(1));
      this.synchronize();
      return { k: "name", name };
    }
    if (name === "Math" && this.at(".") && MATH_NAMES.includes(`Math.${this.peek(1).text}`)) {
      this.next();
      const builtin = this.identifier("the function of Math");
      this.expect("(");
      const args = this.arguments();
      const arity = BUILTINS[`Math.${builtin}`].arity;
      if (args.length !== arity) {
        this.fail(`Math.${builtin} takes ${arity} argument${arity === 1 ? "" : "s"}`);
      }
      return { k: "call", function: `Math.${builtin}`, args };
    }
    if (this.accept("(")) return { k: "call", function: name, args: this.arguments() };
    if (this.accept(".")) {
      const member = this.identifier("the property of a value");
      if (member !== "length") {
        this.fail(`${name}.${member} is not part of a program`);
        return { k: "name", name };
      }
      return { k: "length", buffer: name };
    }
    if (this.accept("[")) {
      const index = this.value();
      this.expect("]");
      return { k: "element", buffer: name, index };
    }
    return { k: "name", name };
  }

  /** The arguments of a call, up to its closing parenthesis. */
  private arguments(): ProgramValue[] {
    const args: ProgramValue[] = [];
    if (!this.at(")")) {
      do {
        args.push(this.value());
      } while (this.accept(","));
    }
    this.expect(")");
    return args;
  }

  /**
   * `process.argv` as a program sees it: `argv[0]` is 0, and `argv[i]` for
   * i >= 1 is the (i - 1)th argument the program was given. The path node runs
   * the source with is not an argument of the program.
   */
  private argv(): ProgramValue {
    if (this.accept("[")) {
      const index = this.value();
      this.expect("]");
      if (index.k === "number" && Number(index.text) === 0) return { k: "number", text: "0" };
      return { k: "call", function: ARGV, args: [index] };
    }
    if (this.accept(".")) {
      const member = this.identifier("the property of a value");
      if (member !== "length") {
        this.fail(`process.argv.${member} is not part of a program`);
        return { k: "number", text: "0" };
      }
      return { k: "call", function: ARGV_LENGTH, args: [] };
    }
    return { k: "call", function: ARGV_LENGTH, args: [] };
  }

  /** `new Float64Array([1, 2, 3])`: the values are the elements of the buffer. */
  private bufferLiteral(): ProgramValue {
    const view = this.identifier("a typed array name");
    if (!(view in VIEWS)) {
      this.fail(`a program cannot allocate ${view}; supported: ${VIEWS_LIST}`);
      return this.nothing();
    }
    this.expect("(");
    this.expect("[");
    const values: string[] = [];
    if (!this.at("]")) {
      do {
        const element = this.peek();
        if (element.kind !== "number") {
          this.fail(`"${element.text}" is not a number`, element);
          return this.nothing();
        }
        this.next();
        values.push(element.text);
      } while (this.accept(","));
    }
    this.expect("]");
    this.expect(")");
    return { k: "buffer", values };
  }

  /** The text of a string, split where a template string interpolates. */
  private parts(token: Token): ProgramText[] {
    if (token.template !== true) return [{ k: "text", value: unescape(token.text, token.line) }];
    const parts: ProgramText[] = [];
    let rest = token.text;
    while (rest.length > 0) {
      const open = rest.indexOf("${");
      if (open < 0) {
        parts.push({ k: "text", value: unescape(rest, token.line) });
        break;
      }
      if (open > 0) parts.push({ k: "text", value: unescape(rest.slice(0, open), token.line) });
      const close = rest.indexOf("}", open);
      if (close < 0) {
        this.fail("a template string interpolates nothing", token);
        break;
      }
      const inner = rest.slice(open + 2, close);
      rest = rest.slice(close + 1);
      parts.push({ k: "value", value: this.interpolated(inner) });
    }
    return parts;
  }

  /** One expression, on its own: what a template string interpolates. */
  private interpolated(source: string): ProgramValue {
    const parser = new ProgramParser(tokenize(source), this.path, this.diagnostics);
    const value = parser.value();
    if (parser.peek().kind !== "end") parser.fail(`"${parser.peek().text}" follows a complete value`, parser.peek());
    return value;
  }
}

/**
 * Reads the statements of a module from the first token of its body to the end
 * of the file. A program is the last thing a module says, so the caller checks
 * that no declaration follows.
 */
export function parseProgramBody(tokens: Token[], path: string, diagnostics: Diagnostics): ProgramStatement[] {
  return new ProgramParser(tokens, path, diagnostics).body();
}

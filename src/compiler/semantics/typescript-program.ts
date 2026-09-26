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
 *
 *   - statements: const declarations and `console.log`
 *   - values: number literals, string and template literals, typed array
 *     literals, names, `name.length`, `name[index]` and calls
 *   - a template string interpolates values; its text is taken as written, with
 *     the escapes in ESCAPES resolved and any other escape left as written
 *
 * The statements are not contracted. The contract phase (see program.ts) keeps
 * them as the program, and the driver the compiler emits runs them.
 */

import type { ProgramStatement, ProgramText, ProgramValue } from "./module.ts";
import type { Token } from "./typescript.ts";
import { frontendError, tokenize, unknownTokenError } from "./typescript.ts";

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

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", "`": "`", "'": "'", '"': '"' };

const VIEWS_LIST = Object.keys(VIEWS).join(", ");

/** Resolves the escapes a string carries, and leaves any other as written. */
function unescape(text: string, path: string, line: number): string {
  let result = "";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character !== "\\") {
      result += character;
      continue;
    }
    const escape = text[index + 1];
    if (escape === undefined) throw frontendError("a string ends in a backslash", `line ${line} of ${path}`);
    result += ESCAPES[escape] ?? `\\${escape}`;
    index += 1;
  }
  return result;
}

class ProgramParser {
  private readonly tokens: Token[];
  private readonly path: string;
  private position = 0;

  constructor(tokens: Token[], path: string) {
    this.tokens = tokens;
    this.path = path;
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
    this.next();
    return true;
  }

  private expect(text: string): void {
    if (this.accept(text)) return;
    const token = this.peek();
    throw frontendError(
      `expected "${text}"`,
      `line ${token.line} of ${this.path} near "${token.text}"; a program declares values with const and prints them with console.log`,
    );
  }

  private fail(message: string, token: Token = this.peek()): never {
    throw frontendError(message, `line ${token.line} of ${this.path} near "${token.text}"`);
  }

  private identifier(what: string): string {
    const token = this.peek();
    if (token.kind !== "ident") this.fail(`expected ${what}`, token);
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

  private statement(): ProgramStatement {
    if (this.peek().kind === "unknown") throw unknownTokenError(this.peek(), this.path);
    const line = this.peek().line;
    if (this.at("const") || this.at("let")) {
      this.next();
      const name = this.identifier("the name of a declared value");
      this.expect("=");
      return { kind: "declare", name, value: this.value(), line };
    }
    if (this.at("console")) {
      this.next();
      this.expect(".");
      const method = this.peek();
      if (method.text !== "log") {
        throw frontendError(
          `console.${method.text} is not part of a program`,
          `line ${method.line} of ${this.path}: a program prints what it computed with console.log`,
        );
      }
      this.next();
      this.expect("(");
      const value = this.value();
      this.expect(")");
      return { kind: "print", value, line };
    }
    const token = this.peek();
    throw frontendError(
      `"${token.text}" is not a statement of a program`,
      `line ${token.line} of ${this.path}: a program declares values with const and prints them with console.log`,
    );
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
    if (token.kind === "unknown") throw unknownTokenError(token, this.path);
    if (token.kind !== "ident") this.fail(`"${token.text}" is not a value`);
    if (token.text === "new") {
      this.next();
      return this.bufferLiteral();
    }
    return this.nameOrCall();
  }

  /** A name, a call, a length, or an element of a name. */
  private nameOrCall(): ProgramValue {
    const name = this.identifier("a name");
    if (this.accept("(")) {
      const args: ProgramValue[] = [];
      if (!this.at(")")) {
        do {
          args.push(this.value());
        } while (this.accept(","));
      }
      this.expect(")");
      return { k: "call", function: name, args };
    }
    if (this.accept(".")) {
      const member = this.identifier("the property of a value");
      if (member !== "length") {
        throw frontendError(
          `${name}.${member} is not part of a program`,
          `line ${this.peek().line} of ${this.path}: a program reads a buffer with .length and with an index`,
        );
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

  /** `new Float64Array([1, 2, 3])`: the values are the elements of the buffer. */
  private bufferLiteral(): ProgramValue {
    const view = this.identifier("a typed array name");
    if (!(view in VIEWS)) this.fail(`a program cannot allocate ${view}; supported: ${VIEWS_LIST}`);
    this.expect("(");
    this.expect("[");
    const values: string[] = [];
    if (!this.at("]")) {
      do {
        const element = this.peek();
        if (element.kind !== "number") this.fail(`"${element.text}" is not a number`);
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
    if (token.template !== true) return [{ k: "text", value: unescape(token.text, this.path, token.line) }];
    const parts: ProgramText[] = [];
    let rest = token.text;
    while (rest.length > 0) {
      const open = rest.indexOf("${");
      if (open < 0) {
        parts.push({ k: "text", value: unescape(rest, this.path, token.line) });
        break;
      }
      if (open > 0) parts.push({ k: "text", value: unescape(rest.slice(0, open), this.path, token.line) });
      const close = rest.indexOf("}", open);
      if (close < 0) this.fail("a template string interpolates nothing", token);
      const inner = rest.slice(open + 2, close);
      rest = rest.slice(close + 1);
      parts.push({ k: "value", value: this.interpolated(inner) });
    }
    return parts;
  }

  /** One expression, on its own: what a template string interpolates. */
  private interpolated(source: string): ProgramValue {
    const parser = new ProgramParser(tokenize(source), this.path);
    const value = parser.value();
    if (parser.peek().kind !== "end") parser.fail(`"${parser.peek().text}" follows a complete value`);
    return value;
  }
}

/**
 * Reads the statements of a module from the first token of its body to the end
 * of the file. A program is the last thing a module says, so the caller checks
 * that no declaration follows.
 */
export function parseProgramBody(tokens: Token[], path: string): ProgramStatement[] {
  return new ProgramParser(tokens, path).body();
}

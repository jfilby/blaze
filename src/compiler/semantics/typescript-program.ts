/**
 * Frontend: the statements a TypeScript module runs.
 *
 * A module is either a library of functions or a program. This file reads the
 * program: the statements of the entry module, in the order they run. A program
 * is not contracted — the contract phase (see program.ts) keeps it as the
 * program and the driver the compiler emits runs it — so what is read here is
 * the source language, not anything a contract can state:
 *
 *   const n = Number(process.argv[1]);
 *   const a = new Float64Array([1, 2, 3, 4]);
 *   let total = 0;
 *   for (let i = 0; i < a.length; i++) total += a[i];
 *   if (total > 0) console.log(`done: ${total}`);
 *   else console.log("nothing to add");
 *   main();
 *
 * The statements, in the order they are recognized:
 *
 *   - a block: `{ ... }`
 *   - a declaration: `const`, `let` or `var`, a name, an optional `: Type` and
 *     a value; only `const` binds a value the program may not change
 *   - a choice: `if (c) body else body`, where the body is a block or a single
 *     statement, and an `else if` is an `if` as the other branch
 *   - a loop: `while (c) body`, `do body while (c)`, a counted
 *     `for (let i = from; i < to; i++) body` whose step is `i++`, `i--`,
 *     `i += n` or `i -= n`, and a `for (const x of a) body`
 *   - `break` and `continue`
 *   - `console.log(v, ...)`
 *   - an assignment: `name = v`, `name += v`, and the compound forms, on a name
 *     or on one element of a buffer
 *   - `name++`, `name--` and their prefix forms, as a statement of their own
 *   - a call kept for what it does, as in `main();`
 *
 * The values, loosest binding first: the conditional `c ? a : b`; `??`; `||`;
 * `&&`; `===`, `!==`, `==` and `!=`; `<`, `<=`, `>` and `>=`; `<<` and `>>`;
 * `+` and `-`; `*`, `/` and `%`; `**`, which is right associative and binds
 * tighter than the unary operators to its left, as it does in JavaScript; and
 * the unary `!`, `-`, `+` and `~`. A name carries what is written after it: a
 * call, `[index]` or `.length`; a `++` or a `--` is a statement of its own, so
 * a program reads neither as a value. What a value is on its own: a
 * number, a bigint as `12n`, a string or a template string, `true`, `false`,
 * `null` and `undefined`, a name, `( expr )`, `new Float64Array([1, 2])`,
 * `process.argv` with `[i]` and `.length`, and `Math.max` and the five other
 * builtins.
 *
 * A template string interpolates values; its text is taken as written, with the
 * escapes in ESCAPES resolved and any other escape left as written. A negative
 * number is a unary `-` over the number, not a number of its own.
 *
 * Anything else — a `switch`, a `try`, a declaration of a function or a class,
 * a call of a method, a `new Uint8Array(n)` with a count — is refused with the
 * line it was written on, and the rest of the file is still read, so one
 * program reports every construct it cannot run.
 */

import type {
  ProgramAssignOp,
  ProgramBinaryOp,
  ProgramStatement,
  ProgramText,
  ProgramUnaryOp,
  ProgramValue,
} from "./module.ts";
import type { Diagnostics, Token } from "./typescript.ts";
import { ARGV, ARGV_LENGTH, closingBrace, nextInterpolation, tokenize, unescape } from "./typescript.ts";
import { BUILTINS, MATH_NAMES } from "./builtins.ts";
import type { PrimitiveTypeName } from "../core/types.ts";

/** The array views a program can allocate, and the element each one holds. */
const VIEWS: Record<string, PrimitiveTypeName> = {
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

/** What an assignment may be written with. */
const ASSIGN_OPS: readonly ProgramAssignOp[] = ["=", "+=", "-=", "*=", "/=", "%="];

/** Assignments a program has, written to say what they do. */
const OTHER_ASSIGN_OPS: readonly string[] = ["**=", "??="];

/** The comparisons a counted loop may count on, as the source writes them. */
const COUNT_OPS: readonly string[] = ["<", "<=", ">", ">="];

const UNARY_OPS: readonly ProgramUnaryOp[] = ["-", "+", "!", "~"];

/** The operators a value may use, loosest binding first. */
const BINARY_LEVELS: readonly (readonly ProgramBinaryOp[])[] = [
  ["??"],
  ["||"],
  ["&&"],
  ["|"],
  ["^"],
  ["&"],
  ["===", "!==", "==", "!="],
  ["<", "<=", ">", ">="],
  ["<<", ">>"],
  ["+", "-"],
  ["*", "/", "%"],
];

/**
 * The constructs a program cannot run that carry a block of their own. They
 * are read past as a whole, so the statements after one are read from the
 * start of the next, and they are never read as a call of a name.
 */
const BLOCK_KEYWORDS: readonly string[] = [
  "catch",
  "class",
  "do",
  "else",
  "enum",
  "finally",
  "for",
  "function",
  "if",
  "interface",
  "namespace",
  "struct",
  "switch",
  "try",
  "while",
  "with",
];

/** What the third clause of a counted loop says, or that it says nothing. */
interface LoopStep {
  /** The step, or null for an index that moves one the way it already travels. */
  value: ProgramValue | null;
  /** Set when the clause is no step at all, so the header is no loop. */
  refused: boolean;
}

class ProgramParser {
  private readonly tokens: Token[];
  private readonly path: string;
  private readonly diagnostics: Diagnostics;
  private position = 0;
  /** Set when the construct read was reported, so it is not reported twice. */
  private refused = false;
  /** Set while the value being read is the operand of a unary operator. */
  private unaryOperand = false;

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
      `near "${token.text}"; a program runs declarations, assignment, blocks, if, while, do-while, for and for-of, break, continue, console.log and calls, over numbers, bigints, booleans, strings, names, buffers, Math and process.argv`,
      token.line,
    );
  }

  /**
   * Reads on to the token that closes what the parser is in — the `;` that ends
   * a statement, or the `)` that ends a call or a loop header — so the next
   * statement is read from the start of it.
   */
  private synchronize(stop = ";"): void {
    let depth = 0;
    while (this.peek().kind !== "end") {
      const token = this.next();
      if (token.kind !== "punct") continue;
      if (token.text === "(" || token.text === "[" || token.text === "{") depth += 1;
      else if (token.text === stop && depth === 0) return;
      else if (token.text === ")" || token.text === "]" || token.text === "}") depth -= 1;
    }
  }

  /** Reads past an argument list the parser will not read. */
  private skipArguments(): void {
    if (!this.at("(")) return;
    this.next();
    this.synchronize(")");
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
      const statement = this.statement();
      if (statement !== null) statements.push(statement);
      this.accept(";");
    }
    return statements;
  }

  /** The statements a keyword is followed by, as a block or as one statement. */
  private statements(): ProgramStatement[] {
    if (this.at("{")) return this.braces();
    const statement = this.statement();
    return statement === null ? [] : [statement];
  }

  /** A statement, or null when it does nothing: a lone `;`, or one refused. */
  private statement(): ProgramStatement | null {
    const line = this.peek().line;
    if (this.accept(";")) return null;
    if (this.at("{")) return this.block();
    if (this.at("const") || this.at("let") || this.at("var")) return this.declaration();
    if (this.at("if")) return this.conditional();
    if (this.at("while")) return this.whileLoop();
    if (this.at("do")) return this.doWhileLoop();
    if (this.at("for")) return this.countedLoop();
    if (this.at("break")) {
      this.next();
      return { kind: "break", line };
    }
    if (this.at("continue")) {
      this.next();
      return { kind: "continue", line };
    }
    if (this.at("++") || this.at("--")) {
      const op = this.next().text as "++" | "--";
      const name = this.identifier("the name of the value to move");
      return { kind: "update", name, op, prefix: true, line };
    }
    if (this.at("console")) return this.print();
    if (this.peek().kind === "ident") {
      const statement = this.named();
      if (statement !== undefined) return statement;
    }
    // A name with something written after it is a value, and a program runs a
    // value by printing it or by passing it to what it calls.
    const token = this.peek();
    const member = this.peek(1);
    if (token.kind === "ident" && member.kind === "punct" && (member.text === "." || member.text === "(")) {
      const what = member.text === "." ? `${token.text}.${this.peek(2).text}` : `${token.text}(...)`;
      this.fail(`"${what}" is not a statement of a program; a program calls what it compiles`, token);
    } else {
      this.fail(`"${token.text}" is not a statement of a program; a program cannot run it`, token);
    }
    if (token.kind === "ident" && BLOCK_KEYWORDS.includes(token.text)) this.skipBlock();
    else this.synchronize();
    return null;
  }

  /** Reads past the block a refused construct carries, as `class C { ... }`. */
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

  /** `{ ... }`: what a block runs, whatever else runs. */
  private block(): ProgramStatement {
    const line = this.peek().line;
    return { kind: "block", body: this.braces(), line };
  }

  /** The statements between two braces, up to the closing one. */
  private braces(): ProgramStatement[] {
    this.expect("{");
    const body: ProgramStatement[] = [];
    while (this.peek().kind !== "end" && !this.at("}")) {
      const statement = this.statement();
      if (statement !== null) body.push(statement);
      this.accept(";");
    }
    this.expect("}");
    return body;
  }

  /** `const a = 1`: a name, what it holds, and whether it may change. */
  private declaration(): ProgramStatement {
    const line = this.peek().line;
    const keyword = this.next().text;
    const name = this.identifier("the name of a declared value");
    let type: string | null = null;
    if (this.accept(":")) type = this.annotation("the type of a declared value");
    this.expect("=");
    return { kind: "declare", name, mutable: keyword !== "const", type, value: this.value(), line };
  }

  /** `: Type`, which a program names with a single token. */
  private annotation(what: string): string {
    const token = this.peek();
    if (token.kind !== "ident") {
      this.fail(`expected ${what}`, token);
      return "";
    }
    this.next();
    // `Array<f64>` and the like name a type with more than one token; a
    // program has no such type, but the value that carries it still parses.
    if (this.at("<")) {
      this.fail("a program names a type with one word, as in const n: usize = 0", token);
      this.skipAngles();
    }
    return token.text;
  }

  /** Reads past a type written with angle brackets. */
  private skipAngles(): void {
    let depth = 0;
    while (this.peek().kind !== "end") {
      const token = this.next();
      if (token.kind !== "punct") continue;
      if (token.text === "<") depth += 1;
      else if (token.text === ">") depth -= 1;
      else if (token.text === ";" || token.text === "{" || token.text === "=") return;
      if (depth <= 0) return;
    }
  }

  /** `if (c) body else body`, where the second body may be another `if`. */
  private conditional(): ProgramStatement {
    const line = this.peek().line;
    this.expect("if");
    this.expect("(");
    const condition = this.value();
    this.expect(")");
    const then = this.statements();
    // The `;` of `if (c) a = 1; else b = 2;` closes nothing, and the `else`
    // is still the branch of the `if`.
    this.accept(";");
    const otherwise: ProgramStatement[] = [];
    if (this.accept("else")) {
      if (this.at("if")) {
        otherwise.push(this.conditional());
      } else {
        otherwise.push(...this.statements());
      }
    }
    return { kind: "if", condition, then, otherwise, line };
  }

  /** `while (c) body`. */
  private whileLoop(): ProgramStatement {
    const line = this.peek().line;
    this.expect("while");
    this.expect("(");
    const condition = this.value();
    this.expect(")");
    return { kind: "while", condition, body: this.statements(), line };
  }

  /** `do body while (c)`: the body runs before the condition is read. */
  private doWhileLoop(): ProgramStatement {
    const line = this.peek().line;
    this.expect("do");
    const body = this.statements();
    this.expect("while");
    this.expect("(");
    const condition = this.value();
    this.expect(")");
    this.accept(";");
    return { kind: "doWhile", condition, body, line };
  }

  /**
   * `for (const x of a) body` and `for (let i = from; i < to; i++) body`. The
   * step is how far the index moves between two turns, and it runs whether the
   * body does or not, so it is the header of the loop and not of its body.
   */
  private countedLoop(): ProgramStatement | null {
    const line = this.peek().line;
    this.expect("for");
    this.expect("(");
    if (this.at("const") || this.at("let") || this.at("var")) {
      const bound = this.peek(1);
      if (bound.kind === "ident" && this.peek(2).text === "of") {
        this.next();
        this.next();
        this.next();
        const of = this.identifier("the name of the buffer to walk");
        this.expect(")");
        return { kind: "forOf", variable: bound.text, of, body: this.statements(), line };
      }
      // The keyword only says how the index may change; a program counts on
      // the name either way.
      this.next();
    }
    const variable = this.identifier("the name of the loop variable");
    if (variable === "") return this.skipLoop();
    let type: string | null = null;
    if (this.accept(":")) type = this.annotation("the type of the loop variable");
    if (!this.accept("=")) {
      this.fail("a loop starts with for (let i = from; i < to; i++)", this.peek());
      return this.skipLoop();
    }
    const from = this.value();
    if (!this.accept(";")) {
      this.fail("a loop is written for (let i = from; i < to; i++)", this.peek());
      return this.skipLoop();
    }
    const counted = this.peek();
    if (counted.kind !== "ident" || counted.text !== variable) {
      this.fail(`a loop counts on "${variable}", not on "${counted.text}"`, counted);
      return this.skipLoop();
    }
    this.next();
    const comparison = this.peek();
    if (comparison.kind !== "punct" || !COUNT_OPS.includes(comparison.text)) {
      this.fail(`a loop counts on <, <=, > or >=, not on "${comparison.text}"`, comparison);
      return this.skipLoop();
    }
    this.next();
    const down = comparison.text === ">" || comparison.text === ">=";
    const to = this.value();
    if (!this.accept(";")) {
      this.fail("a loop is written for (let i = from; i < to; i++)", this.peek());
      return this.skipLoop();
    }
    const step = this.step(variable, down, comparison.text);
    if (step.refused) return this.skipLoop();
    this.expect(")");
    return {
      kind: "for",
      variable,
      from,
      to,
      inclusive: comparison.text === "<=" || comparison.text === ">=",
      down,
      type,
      step: step.value,
      body: this.statements(),
      line,
    };
  }

  /**
   * Reads on past a loop header the parser cannot finish, and past the body
   * that follows it, so the statements after the loop are read from the start
   * of the next one.
   */
  private skipLoop(): null {
    this.synchronize(")");
    // The body is read whatever the header said, so the statements after the
    // loop are read from the start of the next one.
    if (this.peek().kind !== "end") this.statements();
    return null;
  }

  /**
   * The third clause of a counted loop: how far the index moves. `i++` the way
   * the index already travels is no step at all, and `i -= n` is the value n
   * counted backwards, which a program writes as it wrote it.
   */
  private step(variable: string, down: boolean, comparison: string): LoopStep {
    const token = this.peek();
    if (token.kind !== "ident" || token.text !== variable) {
      this.fail("a loop advances its index", token);
      return { value: null, refused: true };
    }
    this.next();
    const move = this.peek();
    if (move.text === "++" || move.text === "--") {
      this.next();
      // A step that runs against the comparison is not a loop this compiler
      // can describe: node counts `i < 3` with `i--` for ever, so the two
      // readings are not two spellings of one loop. It is refused rather than
      // turned round, which would run a body the source did not write.
      if ((move.text === "--") !== down) {
        this.fail(`the loop counts on "${comparison}" but its index moves with "${move.text}"`, move);
        return { value: null, refused: true };
      }
      // The step is how far and which way the index moves, signed as the
      // source writes it, because a driver adds it: `i--` is a step of minus
      // one exactly as `i -= 1` is, and a step of plus one here moved the
      // index the wrong way and ran a descending loop for ever.
      return { value: { k: "number", text: move.text === "--" ? "-1" : "1" }, refused: false };
    }
    const op = this.assignOperator();
    if (op !== "+=" && op !== "-=") {
      if (!this.refused) this.fail("a loop advances its index", move);
      this.refused = false;
      return { value: null, refused: true };
    }
    const value = this.value();
    if (op === "+=") return { value, refused: false };
    if (value.k === "number") return { value: { k: "number", text: `-${value.text}` }, refused: false };
    return { value: { k: "unary", op: "-", operand: value }, refused: false };
  }

  /** `console.log(v, ...)`: the values a program writes out. */
  private print(): ProgramStatement | null {
    const line = this.peek().line;
    this.next();
    this.expect(".");
    const method = this.next();
    if (method.text !== "log") {
      this.fail(`console.${method.text} is not part of a program; a program prints with console.log`, method);
      this.synchronize();
      return null;
    }
    this.expect("(");
    return { kind: "print", values: this.arguments(), line };
  }

  /**
   * The statements that start with a name: an assignment, one element of a
   * buffer, an update, or a call. Undefined when the name is followed by none
   * of them and the caller should say so, null when it already has.
   */
  private named(): ProgramStatement | null | undefined {
    const name = this.peek();
    if (name.kind !== "ident") return undefined;
    const token = this.peek(1);
    if (token.text === "++" || token.text === "--") {
      this.next();
      this.next();
      return { kind: "update", name: name.text, op: token.text as "++" | "--", prefix: false, line: name.line };
    }
    if (token.text === "[") {
      this.next();
      this.next();
      const index = this.value();
      this.expect("]");
      const after = this.peek();
      const op = this.assignOperator();
      if (op === null) {
        if (this.refused) {
          this.synchronize();
          return null;
        }
        // Reading an element is a value, and a program runs a value by printing
        // it or by passing it to what it calls.
        const what = after.text === "." ? `${name.text}[i].${this.peek(1).text}` : `${name.text}[i]`;
        this.fail(`"${what}" is not a statement of a program; a program cannot run it`, after);
        this.synchronize();
        return null;
      }
      return { kind: "elementAssign", buffer: name.text, index, op, value: this.value(), line: name.line };
    }
    if (token.text === "(" && !BLOCK_KEYWORDS.includes(name.text)) {
      this.next();
      this.next();
      return { kind: "invoke", function: name.text, args: this.arguments(), line: name.line };
    }
    if (ASSIGN_OPS.includes(token.text as ProgramAssignOp)) {
      this.next();
      const op = this.next().text as ProgramAssignOp;
      return { kind: "assign", name: name.text, op, value: this.value(), line: name.line };
    }
    if (OTHER_ASSIGN_OPS.includes(token.text)) {
      this.fail(`"${name.text} ${token.text}" is not an assignment a program can make`, token);
      this.synchronize();
      return null;
    }
    return undefined;
  }

  /**
   * The operator of an assignment, or null when the source wrote none. An
   * operator a program has no assignment for is reported here and refused as
   * "reported", so the statement it was written on is not reported twice.
   */
  private assignOperator(): ProgramAssignOp | null {
    const token = this.peek();
    if (ASSIGN_OPS.includes(token.text as ProgramAssignOp)) {
      this.next();
      return token.text as ProgramAssignOp;
    }
    if (OTHER_ASSIGN_OPS.includes(token.text)) {
      this.fail(`"${token.text}" is not an assignment a program can make`, token);
      this.next();
      this.refused = true;
    }
    return null;
  }

  /* ---------------------------------------------------------------------- */
  /* Values                                                                  */
  /* ---------------------------------------------------------------------- */

  private value(): ProgramValue {
    return this.conditionalValue();
  }

  /** `c ? a : b`, loosest of the operators. */
  private conditionalValue(): ProgramValue {
    const condition = this.binary(0);
    if (!this.accept("?")) return condition;
    const then = this.value();
    this.expect(":");
    return { k: "conditional", condition, then, otherwise: this.value() };
  }

  private binary(level: number): ProgramValue {
    if (level === BINARY_LEVELS.length) return this.unary();
    const ops = BINARY_LEVELS[level];
    let left = this.binary(level + 1);
    for (;;) {
      const token = this.peek();
      if (token.kind !== "punct" || !ops.includes(token.text as ProgramBinaryOp)) return left;
      this.next();
      left = { k: "binary", op: token.text as ProgramBinaryOp, left, right: this.binary(level + 1) };
    }
  }

  /**
   * A sign, a `!`, a `~`, and the `++` and `--` that are not a value. The
   * powers read a unary on their right, so `2 ** -1` is a value, and a unary
   * has no power on its right, because JavaScript makes `-2 ** 2` an error
   * rather than a number: write `-(2 ** 2)`.
   */
  private unary(): ProgramValue {
    const token = this.peek();
    if (token.kind === "punct" && (UNARY_OPS as readonly string[]).includes(token.text)) {
      this.next();
      const enclosing = this.unaryOperand;
      this.unaryOperand = true;
      const operand = this.unary();
      this.unaryOperand = enclosing;
      return { k: "unary", op: token.text as ProgramUnaryOp, operand };
    }
    if (token.text === "++" || token.text === "--") {
      const name = this.peek(1);
      this.next();
      if (name.kind === "ident") this.next();
      this.fail(`"${token.text}${name.text}" is not a value; a program runs ++ and -- as statements`, token);
      return name.kind === "ident" ? { k: "name", name: name.text } : this.nothing();
    }
    return this.power();
  }

  /** `**`, which is right associative and whose right side may carry a sign. */
  private power(): ProgramValue {
    const left = this.postfix();
    if (!this.at("**")) return left;
    if (this.unaryOperand) {
      this.fail("`**` may not follow a unary operator", this.peek());
      this.next();
      return { k: "binary", op: "**", left, right: this.unary() };
    }
    this.next();
    return { k: "binary", op: "**", left, right: this.unary() };
  }

  /** What is written after a value: a call, an element, a length, a count. */
  private postfix(): ProgramValue {
    const value = this.primary();
    if (this.at("++") || this.at("--")) {
      const op = this.next().text;
      const name = value.k === "name" ? value.name : "this value";
      this.fail(`"${name}${op}" is not a value; a program runs ++ and -- as statements`);
      return value;
    }
    if (this.at("[")) {
      if (value.k !== "name") {
        this.fail("a program cannot read an element of a value; it reads a[i] of a name");
        this.next();
        return value;
      }
      this.next();
      const index = this.value();
      this.expect("]");
      return { k: "element", buffer: value.name, index };
    }
    if (this.at(".")) {
      if (value.k !== "name") {
        this.fail("a program cannot read a member of a value; it reads the length of a name");
        this.next();
        this.identifier("the property of a value");
        return value;
      }
      this.next();
      const member = this.identifier("the property of a value");
      if (member !== "length") {
        this.fail(`${value.name}.${member} is not a value a program can read; a program reads name.length`);
        return value;
      }
      return { k: "length", of: value.name };
    }
    if (this.at("(")) {
      if (value.k !== "name") {
        this.fail("a program cannot call a value; it calls a name");
        this.skipArguments();
        return value;
      }
      this.next();
      return { k: "call", function: value.name, args: this.arguments() };
    }
    return value;
  }

  /** A value on its own. */
  private primary(): ProgramValue {
    const token = this.peek();
    if (token.kind === "number") {
      this.next();
      return { k: "number", text: token.text };
    }
    if (token.kind === "bigint") {
      this.next();
      return { k: "bigint", text: token.text };
    }
    if (token.kind === "string") {
      this.next();
      return { k: "text", parts: this.parts(token) };
    }
    if (token.kind === "ident") {
      if (token.text === "new") {
        this.next();
        return this.bufferLiteral();
      }
      if (token.text === "null" || token.text === "undefined") {
        this.next();
        return { k: "null" };
      }
      if (token.text === "true" || token.text === "false") {
        this.next();
        return { k: "boolean", value: token.text === "true" };
      }
      if (token.text === "process" && this.peek(1).text === "." && this.peek(2).text === "argv") {
        this.next();
        this.next();
        this.next();
        return this.argv();
      }
      if (token.text === "Math" && this.peek(1).text === ".") return this.math();
      this.next();
      return { k: "name", name: token.text };
    }
    if (this.accept("(")) {
      // Brackets end the operand of a unary operator: `-(2 ** 2)` is the
      // negation of a power, and JavaScript reads it as one.
      const enclosing = this.unaryOperand;
      this.unaryOperand = false;
      const value = this.value();
      this.expect(")");
      this.unaryOperand = enclosing;
      return value;
    }
    this.fail(`"${token.text}" is not a value a program can read`, token);
    return this.nothing();
  }

  /** `Math.max(a, b)` and the five other functions of a program. */
  private math(): ProgramValue {
    const token = this.next();
    this.next();
    const builtin = this.identifier("the function of Math");
    if (!MATH_NAMES.includes(`Math.${builtin}`)) {
      this.fail(`Math.${builtin} is not a function of a program; call one of ${MATH}`, token);
      this.skipArguments();
      return { k: "name", name: "Math" };
    }
    this.expect("(");
    const args = this.arguments();
    const arity = BUILTINS[`Math.${builtin}`].arity;
    if (args.length !== arity) {
      this.fail(`Math.${builtin} takes ${arity} argument${arity === 1 ? "" : "s"}`);
    }
    return { k: "call", function: `Math.${builtin}`, args };
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

  /** The value a statement the parser could not read stands for. */
  private nothing(): ProgramValue {
    return { k: "number", text: "0" };
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
        this.fail(`process.argv.${member} is not part of a program; a program reads argv.length`, this.peek());
        return { k: "number", text: "0" };
      }
    }
    return { k: "call", function: ARGV_LENGTH, args: [] };
  }

  /** `new Float64Array([1, x, 3])`: the values are the elements of the buffer. */
  private bufferLiteral(): ProgramValue {
    const view = this.identifier("a typed array name");
    if (!(view in VIEWS)) {
      this.fail(`a program cannot allocate ${view}; supported: ${VIEWS_LIST}`);
      this.skipArguments();
      return this.nothing();
    }
    this.expect("(");
    // A program has no length to fill with zeros: it writes the values down.
    if (!this.at("[")) {
      this.fail(`a program writes a typed array as the values it holds, as in new ${view}([1, 2])`);
      this.skipArguments();
      return this.nothing();
    }
    this.next();
    const values: ProgramValue[] = [];
    if (!this.at("]")) {
      do {
        const element = this.peek();
        if (element.kind === "string") {
          this.fail(`"${element.text}" is not a number; a buffer holds numbers`, element);
          this.skipArguments();
          return this.nothing();
        }
        values.push(this.value());
      } while (this.accept(","));
    }
    this.expect("]");
    this.expect(")");
    return { k: "buffer", element: VIEWS[view] as PrimitiveTypeName, values };
  }

  /** The text of a string, split where a template string interpolates. */
  private parts(token: Token): ProgramText[] {
    if (token.template !== true) return [{ k: "text", value: unescape(token.text, token.line) }];
    const parts: ProgramText[] = [];
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
    if (parser.peek().kind !== "end") {
      parser.fail(`"${parser.peek().text}" follows a complete value`, parser.peek());
    }
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

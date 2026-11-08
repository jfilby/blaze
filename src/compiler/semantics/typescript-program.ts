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
 *   - a function: `function f(n: number) { ... }`, declared where it is written
 *     and run when it is called. A function of a program is compiled on its own,
 *     so every name it reads of the scope around it is a parameter of its own,
 *     and what it hands back is what its body returns
 *   - a return: `return value;`, which ends the function it is written in
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
 *   - an `async` function, which answers a promise carrying what its body
 *     returns. The body runs when the function is called, so the promise is
 *     settled by the time the call answers
 *   - `await v`, which is the value the promise `v` carries. A value that is
 *     not a promise is awaited as itself
 *   - `try { ... } catch (e) { ... }` and `finally { ... }`: a compiled program
 *     cannot raise, so there is nothing to catch; the blocks are read past
 *
 * The values, loosest binding first: the conditional `c ? a : b`; `??`; `||`;
 * `&&`; `===`, `!==`, `==` and `!=`; `<`, `<=`, `>` and `>=`; `<<` and `>>`;
 * `+` and `-`; `*`, `/` and `%`; `**`, which is right associative and binds
 * tighter than the unary operators to its left, as it does in JavaScript; and
 * the unary `!`, `-`, `+` and `~`. A name carries what is written after it: a
 * call, `[index]` or `.length`; a `++` or a `--` is a statement of its own, so
 * a program reads neither as a value. What a value is on its own: a
 * number, a bigint as `12n`, a string or a template string, `true`, `false`,
 * `null` and `undefined`, a name, `( expr )`, `Float64Array.BYTES_PER_ELEMENT`,
 * `process.argv` and `Deno.args` with `[i]`, `.length` and `.slice(n)`, and
 * `Math.max` and the six other builtins.
 *
 * A typed array is a value in three shapes: the values it holds, as in
 * `new Float64Array([1, 2])`; a count the program settles on when it runs, as in
 * `new Float64Array(n)`; and a window of a block the program laid out, as in
 * `new Float64Array(block, offset, n)` over a `new SharedArrayBuffer(bytes)`.
 * `new Response(...)` is read as a value a compiled program does not inspect,
 * and an object literal may hold a method written in shorthand whose body is
 * read past. A list written on its own is the first of those, as in
 * `const a = [1, 2]`: a `number` is a double whatever it was written beside,
 * and this subset has one array of numbers rather than the several TypeScript
 * has.
 * `a.fill(x)` writes one value into every element of an array and answers the
 * array, and `x.toFixed(d)` answers a number written as text at `d` digits.
 *
 * A template string interpolates values; its text is taken as written, with the
 * escapes in ESCAPES resolved and any other escape left as written. A negative
 * number is a unary `-` over the number, not a number of its own.
 *
 * Anything else — a `switch`, a class declared inside a function, a generator,
 * a call of
 * a method the two above are not — is refused with the line it was written on
 * and what to write instead, and the rest of the file is still read, so one
 * program reports every construct it cannot run.
 */

import type {
  ProgramAssignOp,
  ProgramBinaryOp,
  ProgramParameter,
  ProgramStatement,
  ProgramText,
  ProgramUnaryOp,
  ProgramValue,
} from "./module.ts";
import type { Diagnostics, Token } from "./typescript.ts";
import { ARGV_LENGTH, REFUSED_KEYWORDS, closingBrace, nextInterpolation, refusedKeyword, tokenize, unescape } from "./typescript.ts";
import { BUILTINS, MATH_NAMES } from "./builtins.ts";
import type { PrimitiveTypeName } from "../core/types.ts";
import {
  findField,
  findGetter,
  findMethod,
  methodFunctionName,
  scanClasses,
  type ClassInfo,
  type ClassMethod,
  type ClassTable,
} from "./typescript-classes.ts";

/** One arm of a `switch`: its case, or its default, and the body written after it. */
interface SwitchArm {
  test: ProgramValue | null;
  body: ProgramStatement[];
  /** The arm ended with a `break`, which leaves the switch. */
  broke: boolean;
}

/**
 * Whether a body ends by leaving the `switch` it is the arm of.
 *
 * `break` at the end of an arm leaves the switch; a `return` leaves the
 * function the switch is in, which leaves the switch as well. Anything else
 * runs into the arm after it.
 */
function leavesSwitch(body: readonly ProgramStatement[]): boolean {
  const last = body[body.length - 1];
  return last !== undefined && (last.kind === "result" || last.kind === "break" || last.kind === "continue");
}

/** Whether a `break` is written anywhere in these statements, nested ones included. */
function holdsBreak(body: readonly ProgramStatement[]): boolean {
  for (const statement of body) {
    if (statement.kind === "break") return true;
    for (const inner of programBodies(statement)) {
      if (holdsBreak(inner)) return true;
    }
  }
  return false;
}

/** The statement lists a statement is made of. */
function programBodies(statement: ProgramStatement): ProgramStatement[][] {
  switch (statement.kind) {
    case "if":
      return [statement.then, statement.otherwise];
    case "while":
    case "doWhile":
    case "for":
    case "forOf":
    case "block":
    case "function":
      return [statement.body];
    default:
      return [];
  }
}

/** The array views a program can allocate, and the element each one holds. */
const VIEWS: Record<string, PrimitiveTypeName> = {
  // `new Array(n)` is the array of numbers the source language has: a block of
  // `n` elements, cleared, which is what a read past what the program filled
  // answers. `new Array(a, b)` is the two values written out.
  Array: "f64",
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

/**
 * How wide one element of a view is, in bytes. `BYTES_PER_ELEMENT` is the
 * number the language holds for a view, and a program reads it to count the
 * bytes of a buffer it lays out itself.
 */
const VIEW_BYTES: Record<string, number> = {
  i8: 1,
  u8: 1,
  i16: 2,
  u16: 2,
  i32: 4,
  u32: 4,
  i64: 8,
  u64: 8,
  f32: 4,
  f64: 8,
};

const VIEWS_LIST = Object.keys(VIEWS).join(", ");

const MATH = MATH_NAMES.join(", ");

/** What an assignment may be written with. */
const ASSIGN_OPS: readonly ProgramAssignOp[] = ["=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>=", ">>>=", "**="];

/** Assignments a program has, written to say what they do. */
const OTHER_ASSIGN_OPS: readonly string[] = ["??="];

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
  ["<<", ">>", ">>>"],
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

/** What a program may say, as the refusals of what it may not say state it. */
const PROGRAM_BODY =
  "a program runs declarations, function declarations, return, assignment, blocks, if, while, do-while, for and for-of, break, continue, console.log and calls, over numbers, bigints, booleans, strings, names, buffers, Math, process.argv and Deno.args";

/**
 * The name a method is called by. A method every array has is called by the
 * name the compiler knows it by, so that `a.push(x)` is the same call
 * wherever `a` was written, and the receiver is passed as the first argument.
 */
function methodCall(object: string, member: string): string {
  if (member === "push") return "array.push";
  return `${object}.${member}`;
}

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
  /** How many refusals the statement being read has written. */
  private reporting = 0;
  /** Set while the value being read is the operand of a unary operator. */
  private unaryOperand = false;
  /** The classes the file declares, lowered by the module frontend. */
  private readonly classTable: ClassTable;
  /** The names the file's imports bind, which may name a class of another module. */
  private readonly importedNames: ReadonlySet<string>;
  /** The class each name of the function being read holds. */
  private valueClasses = new Map<string, string>();
  /**
   * The dictionary a name holds, where it was allocated as a `Set` or a `Map`.
   *
   * A set and a map are one handle on the runtime's dictionary, and the
   * program has no other way to say which methods a name answers: `add` is a
   * set's and `get` is a map's, and both are written of a value no type in the
   * body states.
   */
  private collections = new Map<string, "set" | "map">();
  /** The dictionary an allocation names, so the declaration binds its kind. */
  private collectionValues = new Map<ProgramValue, "set" | "map">();
  /** How many switches the reader has lowered, for naming their subjects. */
  private switchCount = 0;
  /** How many values a `for ... of` read into a name of their own. */
  private walkCount = 0;
  /**
   * The statements a pattern declaration wrote before the one the reader
   * answers with.
   *
   * `const [a, b] = values` names one value and writes two declarations, and a
   * statement is what the callers of `statement` push: the declarations are
   * queued here and every reader of statements drains the queue first, so the
   * names are declared in the scope the pattern was written in rather than in a
   * block of the reader's making.
   */
  private pending: ProgramStatement[] = [];
  /** The class whose method is being read, or null in the program body. */
  private currentClass: ClassInfo | null = null;

  constructor(tokens: Token[], path: string, diagnostics: Diagnostics, classTable?: ClassTable, imported: ReadonlySet<string> = new Set()) {
    this.tokens = tokens;
    this.path = path;
    this.diagnostics = diagnostics;
    this.classTable = classTable ?? scanClasses(tokens);
    this.importedNames = imported;
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.position + offset, this.tokens.length - 1)];
  }

  private next(): Token {
    return this.tokens[this.position++];
  }

  /**
   * The parameters of an arrow, which are read to their closing bracket and
   * whose annotations the program erases: a program has one type for a number
   * and one for a text, and the words the source writes for them say nothing it
   * can act on.
   */
  private arrowParams(): { name: string; type: string | null }[] {
    const params: { name: string; type: string | null }[] = [];
    this.expect("(");
    if (!this.at(")")) {
      for (;;) {
        const name = this.identifier("the name of a parameter");
        this.accept("?");
        let type: string | null = null;
        if (this.accept(":")) {
          type = this.skipArrowType(new Set([",", ")"]));
        }
        params.push({ name, type });
        if (!this.accept(",")) break;
      }
    }
    this.expect(")");
    return params;
  }

  /** The result type an arrow states, which the program erases with it. */
  private arrowResultType(): void {
    if (!this.at(":")) return;
    this.next();
    this.skipArrowType(new Set(["=>"]));
  }

  /** Reads past a type written in an arrow's annotation, to the first stop. */
  private skipArrowType(stops: ReadonlySet<string>): string {
    const written: string[] = [];
    let depth = 0;
    while (this.peek().kind !== "end") {
      const token = this.peek();
      if (token.kind === "punct") {
        if (depth === 0 && stops.has(token.text)) break;
        if (depth === 0 && (token.text === "{" || token.text === ";" || token.text === "}")) break;
        if (token.text === "(" || token.text === "[" || token.text === "<") depth += 1;
        else if (token.text === ")" || token.text === "]" || token.text === ">") {
          if (depth === 0) break;
          depth -= 1;
        }
      }
      written.push(token.text);
      this.next();
    }
    return written.join("");
  }

  /**
   * Whether the `=>` of an arrow follows the closing bracket at `index`, with
   * the result type an arrow may state between them.
   *
   * `(a: number): number => a` writes a type where `(a: number) => a` writes
   * nothing, and the arrow is the same arrow either way. Reading only the second
   * form found the arrow in neither, so the parameter list was read as a
   * parenthesised value and the build complained about the `:` after the name.
   */
  private arrowFollows(index: number): boolean {
    let at = index + 1;
    if (this.peek(at).text === "=>") return true;
    if (this.peek(at).text !== ":") return false;
    at += 1;
    let depth = 0;
    while (this.peek(at).kind !== "end") {
      const token = this.peek(at);
      if (token.kind === "punct") {
        if (token.text === "=>") return depth === 0;
        if (token.text === "(" || token.text === "[" || token.text === "<") depth += 1;
        else if (token.text === ")" || token.text === "]" || token.text === ">") {
          if (depth === 0) return false;
          depth -= 1;
        } else if (depth === 0 && (token.text === "{" || token.text === ";" || token.text === "," || token.text === "}")) {
          return false;
        }
      }
      at += 1;
    }
    return false;
  }

  /**
   * The arguments of a `parseInt` call, whose radix is the base ten one.
   *
   * `parseInt(text, 10)` is the number the text states, which is what
   * `parseInt(text)` reads. Another base is not a number this grammar reads
   * out of a text, and is refused where it is written.
   */
  private baseTenRadix(args: ProgramValue[], token: Token): ProgramValue[] {
    if (args.length !== 2) return args;
    const radix = args[1];
    if (radix !== undefined && radix.k === "number" && radix.text === "10") return [args[0] as ProgramValue];
    this.fail(
      "parseInt reads a number in base ten",
      token,
      "the digits the source writes are base ten ones, as in parseInt(text, 10)",
    );
    return args;
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
    // A closing bracket the parser expected and did not find ends the
    // construct somewhere the source did not. Reading on to the bracket of the
    // same kind ends the construct where the source wrote it, so what follows
    // it is read as the statement it is rather than as the rest of this one.
    if (text === ")" || text === "]" || text === "}") this.recoverToClosing(text);
  }

  /**
   * Reads on to the closing bracket of one kind, and consumes it.
   *
   * A closer of another kind at depth zero is one this construct does not own:
   * it is left for the construct that opened it.
   */
  private recoverToClosing(text: string): void {
    let depth = 0;
    while (this.peek().kind !== "end") {
      const token = this.peek();
      if (token.kind === "punct") {
        if (token.text === "(" || token.text === "[" || token.text === "{") depth += 1;
        else if (token.text === ")" || token.text === "]" || token.text === "}") {
          if (depth === 0) {
            if (token.text === text) this.next();
            return;
          }
          depth -= 1;
        }
      }
      this.next();
    }
  }

  private fail(message: string, token: Token = this.peek(), detail = PROGRAM_BODY): void {
    this.reporting += 1;
    if (this.reporting > 1) return;
    this.diagnostics.report(message, `near "${token.text}"; ${detail}`, token.line);
  }

  /**
   * Reads one statement, reporting at most one refusal for it and reading past
   * what it could not read to the end of the statement.
   *
   * A statement is the unit the recovery is at: the first construct outside the
   * subset is what the build names, and what the rest of the statement earns is
   * the same construct read as the junk it is. The enclosing statement keeps its
   * own count, so a nested statement's refusal is not hidden by its parent's.
   */
  private guardedStatement(): ProgramStatement | null {
    const start = this.position;
    const outer = this.reporting;
    this.reporting = 0;
    const statement = this.statement();
    const refused = this.reporting > 0;
    this.reporting = outer;
    if (refused) {
      const end = this.statementEnd(start);
      if (end > this.position) this.position = end;
    }
    return statement;
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
      const statement = this.guardedStatement();
      statements.push(...this.drainPending());
      if (statement !== null) statements.push(statement);
      this.accept(";");
    }
    statements.push(...this.drainPending());
    return statements;
  }

  /** The statements a read queued before the one it answered with. */
  private drainPending(): ProgramStatement[] {
    const queued = this.pending;
    this.pending = [];
    return queued;
  }

  /** The statements a keyword is followed by, as a block or as one statement. */
  private statements(): ProgramStatement[] {
    if (this.at("{")) return this.braces();
    const statement = this.guardedStatement();
    const queued = this.drainPending();
    const written = statement === null ? [] : [statement];
    // A pattern written as the one statement of an arm needs a scope: its names
    // are the arm's own, so the queued declarations and the statement are the
    // block the arm runs.
    return queued.length === 0 ? written : [{ kind: "block", body: [...queued, ...written], line: this.peek().line }];
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
    if (this.at("switch")) return this.switchStatement();
    if (this.at("process") && this.peek(1).text === "." ) {
      const written = this.processWrite();
      if (written !== undefined) return written;
    }
    if (this.at("void")) {
      this.next();
      // `void name;` marks a value as read and writes nothing. The statement
      // has no effect, and the name is what the source wanted read; anything
      // else written after `void` is a value read for an effect, which this
      // program cannot run as a statement.
      const name = this.next();
      if (name.kind !== "ident" || !this.at(";")) {
        this.fail(
          "a value written with void is read for its effect, which a program cannot run as a statement",
          name,
        );
        this.synchronize(";");
        this.accept(";");
        return null;
      }
      this.next();
      return null;
    }
    if (this.at("async")) {
      this.next();
      if (!this.at("function")) {
        const at = this.peek();
        this.fail(
          '"async" is read in front of a function',
          at,
          "write `async function f() { ... }` or an async arrow, as in `async (x) => x`",
        );
        this.skipBlock();
        return null;
      }
      // `async function f() { ... }` is a function like any other, and what it
      // answers is a promise carrying what its body returns.
      return this.declaredFunction(true);
    }
    if (this.at("break")) {
      this.next();
      return { kind: "break", line };
    }
    if (this.at("continue")) {
      this.next();
      return { kind: "continue", line };
    }
    if (this.at("await")) {
      this.next();
      const value = this.value();
      this.accept(";");
      // `await x;` is a call of the promise the value is, written as a
      // statement: what it waits for has already run by the time the program
      // reads it, so the statement is the reading of it.
      return { kind: "invoke", function: "Promise.await", args: [value], line };
    }
    if (this.at("++") || this.at("--")) {
      const op = this.next().text as "++" | "--";
      const name = this.identifier("the name of the value to move");
      return { kind: "update", name, op, prefix: true, line };
    }
    if (this.at("console")) return this.print();
    if (this.at("throw")) {
      this.next();
      this.synchronize(";");
      this.accept(";");
      return null;
    }
    if (this.at("return")) {
      this.next();
      const value = this.value();
      this.accept(";");
      return { kind: "result", value, line };
    }
    if (this.at("function")) return this.declaredFunction();
    if (this.peek().kind === "ident") {
      const statement = this.named();
      if (statement !== undefined) return statement;
    }
    const token = this.peek();
    if (this.at("try")) {
      return this.tryStatement();
    }
    const refused = refusedKeyword(token.text);
    if (refused !== undefined) {
      this.fail(`"${token.text}" is not part of a program`, token, refused);
      this.skipBlock();
      return null;
    }
    // A name with something written after it is a value, and a program runs a
    // value by printing it or by passing it to what it calls.
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
      const statement = this.guardedStatement();
      body.push(...this.drainPending());
      if (statement !== null) body.push(statement);
      this.accept(";");
    }
    this.expect("}");
    body.push(...this.drainPending());
    return body;
  }

  /**
   * `try { ... } catch (e) { ... } finally { ... }`: a body that runs, an arm
   * that runs when the call it made failed, and a body that runs either way.
   *
   * A compiled program cannot raise, so what the catch arm catches is the
   * failure of a call that was awaited: the runtime keeps the failure pending
   * until the next call is made, and the arm reads it there. The statements
   * are written as the ones the source means: the pending failure is cleared
   * before the body runs, the arm runs when a failure is pending, and the
   * finally body runs after both of them.
   */
  private tryStatement(): ProgramStatement {
    const line = this.peek().line;
    this.next();
    const body = this.at("{") ? this.braces() : [];
    let caught: ProgramStatement[] | null = null;
    let parameter: string | null = null;
    let finallyBody: ProgramStatement[] = [];
    while (this.at("catch") || this.at("finally")) {
      const keyword = this.next().text;
      if (keyword === "catch") {
        if (this.at("(")) {
          this.next();
          parameter = this.identifier("the name of the error");
          this.accept(")");
        }
        caught = this.at("{") ? this.braces() : [];
        continue;
      }
      finallyBody = this.at("{") ? this.braces() : [];
    }
    const statements: ProgramStatement[] = [
      { kind: "invoke", function: "blaze_error_clear", args: [], line },
      ...body,
    ];
    if (caught !== null) {
      const arm: ProgramStatement[] =
        parameter === null
          ? caught
          : [
              {
                kind: "declare",
                name: parameter,
                mutable: false,
                type: null,
                value: { k: "call", function: "blaze_last_error", args: [] },
                line,
              },
              ...caught,
            ];
      statements.push({
        kind: "if",
        condition: { k: "call", function: "blaze_had_error", args: [] },
        then: arm,
        otherwise: [],
        line,
      });
    }
    statements.push(...finallyBody);
    return { kind: "block", body: statements, line };
  }

  /** `const a = 1`: a name, what it holds, and whether it may change. */
  private declaration(): ProgramStatement {
    const line = this.peek().line;
    const keyword = this.next().text;
    // `const [a, b] = values` names the parts of a value rather than the value
    // itself, and each name is one element of it.
    if (this.at("[")) return this.destructured(keyword, line);
    const name = this.identifier("the name of a declared value");
    let type: string | null = null;
    let annotationClass: string | null = null;
    if (this.accept(":")) {
      const annotation = this.peek();
      if (annotation.kind === "ident" && this.classTable.names.has(annotation.text)) annotationClass = annotation.text;
      type = this.annotation("the type of a declared value");
    }
    this.expect("=");
    const value = this.value();
    // A list of texts states its element in the values it writes: the
    // annotation's `string` is not a typed array's element name, and reading
    // the list at it made the block a text. The value is what the declaration
    // holds.
    if (value.k === "words" || (value.k === "conditional" && value.then.k === "words" && value.otherwise.k === "words")) type = null;
    const held = annotationClass ?? this.classOfValue(value);
    if (held === null) this.valueClasses.delete(name);
    else this.valueClasses.set(name, held);
    const collection = this.collectionValues.get(value);
    if (collection === undefined) this.collections.delete(name);
    else this.collections.set(name, collection);
    return { kind: "declare", name, mutable: keyword !== "const", type, value, line };
  }

  /**
   * `const [a, b] = values`: the pattern's names, each one element of the value.
   *
   * The value is read once into a name of the statement's own, because the
   * pattern names as many elements of it as it writes names and a call in it
   * must run once. A rest element — `...rest`, the list from that position on —
   * is a slice of the value, which a program has no value for, so it is refused
   * and the name still binds the element at its position to keep the body
   * readable.
   */
  private destructured(keyword: string, line: number): ProgramStatement {
    this.expect("[");
    const names: { name: string; rest: boolean }[] = [];
    while (!this.at("]") && this.peek().kind !== "end") {
      const rest = this.accept("...");
      names.push({ name: this.identifier("the name of a declared value"), rest });
      if (!this.accept(",")) break;
    }
    this.expect("]");
    this.expect("=");
    const value = this.value();
    const rest = names.find((entry) => entry.rest);
    if (rest !== undefined) {
      this.fail(
        "a rest element of a pattern is the list from that position on",
        this.peek(),
        `${PROGRAM_BODY}; a rest element needs a slice of the list, which a program does not carry`,
      );
    }
    const held = `__pattern${this.walkCount++}`;
    const written: ProgramStatement[] = [
      { kind: "declare", name: held, mutable: false, type: null, value, line },
    ];
    for (const [index, entry] of names.entries()) {
      this.valueClasses.delete(entry.name);
      written.push({
        kind: "declare",
        name: entry.name,
        mutable: keyword !== "const",
        type: null,
        value: { k: "element", buffer: held, index: { k: "number", text: String(index) } },
        line,
      });
    }
    // The names are the scope's, not a block's: all but the last are queued and
    // the last is the statement this read answers with.
    this.pending.push(...written.slice(0, -1));
    return written[written.length - 1] as ProgramStatement;
  }

  /** `: Type`, which a program names with a single token. */
  private annotation(what: string): string {
    const token = this.peek();
    if (token.text === "{") {
      // An object type written where a type is expected: the program erases it,
      // and its fields are not a parameter list. A `;` inside the braces is the
      // separator a field is written with, not the end of the annotation.
      this.skipType(new Set([",", ")", "=", ";"]));
      return "any";
    }
    if (token.kind !== "ident") {
      this.fail(`expected ${what}`, token);
      return "";
    }
    this.next();
    // `Array<f64>` and the like name a type with more than one token. A program
    // has no such type of its own, so the annotation is erased: the value keeps
    // the type it is written with and the name states nothing the program reads.
    let name = token.text;
    if (this.at("<")) {
      this.skipAngles();
      name = "any";
    }
    // A union, an intersection, an array suffix and an object arm are part of
    // the same annotation, and the program erases them with the name.
    this.skipType(new Set([",", ")", "=", ";", "}", "{"]));
    // A class names a value the program holds as a reference, which is the one
    // type the source needs no fields spelled for.
    if (this.classTable.names.has(token.text)) return "any";
    return name;
  }

  /**
   * Reads past the rest of a type a program erases: a union's bars, a type's
   * brackets and a member object's braces, to the token the annotation stops at.
   */
  private skipType(stops: ReadonlySet<string>): void {
    let depth = 0;
    while (this.peek().kind !== "end") {
      const token = this.peek();
      if (token.kind === "punct") {
        if (depth === 0 && stops.has(token.text)) return;
        if (token.text === "(" || token.text === "[" || token.text === "<") depth += 1;
        else if (token.text === ")" || token.text === "]" || token.text === ">") {
          if (depth === 0) return;
          depth -= 1;
        } else if (token.text === "{" || token.text === "}") {
          if (token.text === "{" && depth === 0) depth += 1;
          else if (token.text === "}") {
            if (depth === 0) return;
            depth -= 1;
          }
        }
      }
      this.next();
    }
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
        // The buffer is a value, not only a name: `for (const file of
        // phase.program.files)` walks a field of an object. A value that is a
        // bare name walks as it was; any other value is read into a name of
        // its own first, so the walk reads the name it was read into.
        const of = this.value();
        this.expect(")");
        const body = this.statements();
        if (of.k === "name") {
          return { kind: "forOf", variable: bound.text, of: of.name, body, line };
        }
        const named = `walk${this.walkCount}`;
        this.walkCount += 1;
        const declared: ProgramStatement = { kind: "declare", name: named, mutable: false, type: null, value: of, line };
        const loop: ProgramStatement = { kind: "forOf", variable: bound.text, of: named, body, line };
        return { kind: "block", body: [declared, loop], line };
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

  /**
   * `function f(n: number) { ... }`: a function the program declares, which
   * runs when it is called. A program declares a function where it writes it,
   * inside another function as well as at the top of the program, and what it
   * reads of the scope around it is given to it at every call.
   */
  private declaredFunction(isAsync = false): ProgramStatement {
    const line = this.peek().line;
    this.expect("function");
    // `function* name()`: the star is where the generator was written, and it
    // is refused here rather than reported as the missing name of a function
    // the source did write.
    if (this.at("*")) {
      const star = this.next();
      this.fail("a generator is not part of a program", star, REFUSED_KEYWORDS.yield);
      this.skipBlock();
      return { kind: "invoke", function: "", args: [], line };
    }
    const name = this.identifier("the name of a function");
    const params: ProgramParameter[] = [];
    const previous = new Map(this.valueClasses);
    this.expect("(");
    if (!this.at(")")) {
      for (;;) {
        const parameter = this.identifier("the name of a parameter");
        let type: string | null = null;
        let held: string | null = null;
        // `x?: T` says the call may leave the parameter out. A program has no
        // absent value of its own, so the `?` states nothing the program reads:
        // the parameter is the type it was declared, and a call that omits it
        // is the shorter arity a default names.
        this.accept("?");
        if (this.accept(":")) {
          const annotation = this.peek();
          if (annotation.kind === "ident" && this.classTable.names.has(annotation.text)) held = annotation.text;
          type = this.annotation("the type of a parameter");
        }
        if (held !== null) this.valueClasses.set(parameter, held);
        // A parameter the source wrote no type for is read at the type its
        // callers pass it at, which is what the call sites of the program say.
        // A default is what a shorter arity hands over, and the parameter is
        // still one the function reads.
        const fallback = this.accept("=") ? this.value() : undefined;
        params.push({ name: parameter, type, ...(fallback === undefined ? {} : { default: fallback }) });
        if (!this.accept(",")) break;
      }
    }
    this.expect(")");
    // A return type is what the body works out, so a program writes none: a
    // function that returns something says so with its `return`.
    if (this.accept(":")) this.annotation("the type a function returns");
    const body = this.at("{") ? this.braces() : this.statements();
    this.valueClasses = previous;
    return { kind: "function", name, params, body, line, ...(isAsync ? { async: true } : {}) };
  }

  /**
   * `switch (value) { case a: ... default: ... }`: the chain of comparisons it
   * is.
   *
   * The subject is read once into a name of the switch's own, and every arm is
   * an `if` that compares the name with the arm's case. An arm that does not
   * end by leaving the switch runs into the arm after it, which is what the
   * language's fallthrough is: the two bodies are one body. A `break` at the
   * end of an arm is the arm leaving the switch, and it is dropped with the end
   * of that body.
   */
  private switchStatement(): ProgramStatement {
    const line = this.peek().line;
    this.next();
    this.expect("(");
    const subject = this.value();
    this.expect(")");
    this.expect("{");
    const arms = this.switchArms();
    this.expect("}");
    const held = `__switch${this.switchCount++}`;
    const chain = this.switchChain(arms, held, line);
    const declared: ProgramStatement = { kind: "declare", name: held, mutable: false, type: null, value: subject, line };
    return { kind: "block", body: [declared, ...chain], line };
  }

  /**
   * The arms of a switch, read to the brace that closes it.
   *
   * A `break` anywhere but the end of an arm leaves the switch from inside a
   * nested statement, which the chain of comparisons cannot say: it is refused
   * rather than read as a break of whatever loop the switch is in. A `default`
   * before a case runs into the case after it, which is the same fault.
   */
  private switchArms(): SwitchArm[] {
    const arms: SwitchArm[] = [];
    while (!this.at("}") && this.peek().kind !== "end") {
      const read = this.switchArm();
      if (read === null) break;
      arms.push(read);
    }
    let stray = false;
    for (const arm of arms) {
      if (holdsBreak(arm.body)) stray = true;
    }
    if (stray) {
      this.fail(
        "a switch arm leaves the switch from inside a nested statement",
        this.peek(),
        "a switch is the chain of comparisons its cases are, and a break of the switch is the end of an arm",
      );
      return [];
    }
    let fallback = false;
    for (const arm of arms) {
      if (arm.test === null) fallback = true;
    }
    if (fallback) {
      const last = arms[arms.length - 1];
      if (last === undefined || last.test !== null) {
        this.fail("a default before a case runs into the case after it", this.peek(), "write the default last");
        return [];
      }
    }
    return arms;
  }

  /** One arm of a switch: its case, or its default, and the body after it. */
  private switchArm(): SwitchArm | null {
    let test: ProgramValue | null = null;
    if (this.accept("case")) {
      test = this.value();
      this.expect(":");
    } else if (this.accept("default")) {
      this.expect(":");
    } else {
      this.fail("a switch holds the cases it compares with", this.peek());
      this.synchronizeToBrace();
      return null;
    }
    const body: ProgramStatement[] = [];
    while (!this.at("case") && !this.at("default") && !this.at("}") && this.peek().kind !== "end") {
      const statement = this.guardedStatement();
      if (statement !== null) body.push(statement);
      this.accept(";");
    }
    // The break that ends the body is the arm leaving the switch, and the arm
    // does not run into the next one.
    const last = body[body.length - 1];
    const broke = last !== undefined && last.kind === "break";
    if (broke) body.pop();
    return { test, body, broke };
  }

  /**
   * The chain of comparisons the arms are, folded from the last arm back.
   *
   * An arm that does not leave the switch runs into the body of the arm after
   * it, and that body is the one already folded: the two are one body.
   */
  private switchChain(arms: readonly SwitchArm[], held: string, line: number): ProgramStatement[] {
    const last = arms[arms.length - 1];
    const hasDefault = last !== undefined && last.test === null;
    const fallback: ProgramStatement[] = hasDefault && last !== undefined ? last.body : [];
    const tests: SwitchArm[] = [];
    for (const arm of arms) {
      if (arm.test !== null) tests.push(arm);
    }
    let next: ProgramStatement[] = fallback;
    let chain: ProgramStatement[] = fallback;
    for (let at = tests.length - 1; at >= 0; at -= 1) {
      const arm = tests[at];
      if (arm === undefined) continue;
      const fallsThrough = !arm.broke && !leavesSwitch(arm.body);
      const body: ProgramStatement[] = fallsThrough ? [...arm.body, ...next] : arm.body;
      const caseValue: ProgramValue = arm.test === null ? { k: "number", text: "0" } : arm.test;
      const same: ProgramValue = { k: "binary", op: "===", left: { k: "name", name: held }, right: caseValue };
      chain = [{ kind: "if", condition: same, then: body, otherwise: chain, line }];
      next = body;
    }
    return chain;
  }

  /** Reads past the rest of a switch whose arms could not be read. */
  private synchronizeToBrace(): void {
    let depth = 0;
    while (this.peek().kind !== "end") {
      if (this.at("{")) depth += 1;
      else if (this.at("}")) {
        if (depth === 0) return;
        depth -= 1;
      }
      this.next();
    }
  }

  /**
   * `process.stdout.write(text)`: the text written where it is, without ending
   * the line a `console.log` ends.
   *
   * A program writes to its own output, and to the error stream the runtime
   * reports its own failures on: the two are the runtime's to hold, and the text
   * is written where it is.
   */
  private processWrite(): ProgramStatement | null | undefined {
    const line = this.peek().line;
    const stream = this.peek(2).text;
    if (this.peek(3).text !== "." || (stream !== "stdout" && stream !== "stderr")) return undefined;
    const method = this.peek(4).text;
    if (method !== "write") return undefined;
    this.next();
    this.next();
    this.next();
    this.next();
    this.next();
    this.expect("(");
    const values = this.arguments();
    if (stream === "stderr") {
      return { kind: "invoke", function: "process.stderr.write", args: values, line };
    }
    return { kind: "print", values, newline: false, line };
  }

  /** `console.log(v, ...)`: the values a program writes out. */
  private print(): ProgramStatement | null {
    const line = this.peek().line;
    this.next();
    this.expect(".");
    const method = this.next();
    if (method.text !== "log" && method.text !== "error") {
      this.fail(`console.${method.text} is not part of a program; a program prints with console.log`, method);
      this.synchronize();
      return null;
    }
    this.expect("(");
    const values = this.arguments();
    if (method.text === "error") {
      // The error stream is the runtime's own: the values are written the way
      // `console.log` writes them, separated by a space and ended by a line,
      // and the text goes to the stream the runtime reports its failures on.
      const parts: ProgramText[] = [];
      values.forEach((value, index) => {
        if (index > 0) parts.push({ k: "text", value: " " });
        parts.push({ k: "value", value });
      });
      parts.push({ k: "text", value: "\n" });
      return { kind: "invoke", function: "process.stderr.write", args: [{ k: "text", parts }], line };
    }
    return { kind: "print", values, line };
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
    // `a.fill(x)` written for what it does rather than for the array it hands
    // back: the same spelling bound to a name is an expression, and a statement
    // has nowhere to put the array it answers with.
    if (token.text === "." && this.peek(2).text === "fill" && this.peek(3).text === "(") {
      this.next();
      this.next();
      this.next();
      this.next();
      const value = this.value();
      this.expect(")");
      this.accept(";");
      return { kind: "fill", buffer: name.text, value, line: name.line };
    }
    if (token.text === "(" && !BLOCK_KEYWORDS.includes(name.text)) {
      this.next();
      this.next();
      return { kind: "invoke", function: name.text, args: this.arguments(), line: name.line };
    }
    if (token.text === "." && this.peek(2).kind === "ident" && this.peek(3).text === "(") {
      const object = name.text === "this" ? "self" : name.text;
      const method = this.peek(2).text;
      this.next();
      this.next();
      this.next();
      this.next();
      const methodArgs = this.arguments();
      this.accept(";");
      // A set's write, question and removal, and a map's, are the dictionary
      // calls the value is one handle on.
      const collection = this.collections.get(object);
      if (collection === "set" && (method === "add" || method === "has" || method === "delete")) {
        const one: ProgramValue = { k: "number", text: "1" };
        const functionName = method === "add" ? "blaze_rt_dict_set" : method === "has" ? "blaze_rt_dict_has" : "blaze_rt_dict_delete";
        const args = method === "add"
          ? [{ k: "name", name: object } as ProgramValue, methodArgs[0] as ProgramValue, one]
          : [{ k: "name", name: object } as ProgramValue, methodArgs[0] as ProgramValue];
        return { kind: "invoke", function: functionName, args, line: name.line };
      }
      if (collection === "map" && (method === "get" || method === "has" || method === "delete")) {
        const functionName = method === "get" ? "blaze_rt_dict_get" : method === "has" ? "blaze_rt_dict_has" : "blaze_rt_dict_delete";
        return {
          kind: "invoke",
          function: functionName,
          args: [{ k: "name", name: object } as ProgramValue, methodArgs[0] as ProgramValue],
          line: name.line,
        };
      }
      // A method of a class is a function of the class, with the instance it
      // was written on as its first argument; a static method has none.
      if (!this.valueClasses.has(object)) {
        const owner = this.classNamed(object);
        if (owner !== undefined) {
          const found = this.methodOwner(owner.name, method, true);
          if (found !== null) {
            return { kind: "invoke", function: this.methodName(found.owner, found.method, methodArgs.length), args: methodArgs, line: name.line };
          }
        }
      }
      const hint = this.valueClasses.get(object) ?? (this.classNamed(object) !== undefined ? object : null);
      const found = this.methodOwner(hint, method, false);
      if (found !== null) {
        return {
          kind: "invoke",
          function: this.methodName(found.owner, found.method, methodArgs.length),
          args: [{ k: "name", name: object }, ...methodArgs],
          line: name.line,
        };
      }
      const namespaces = new Set(["JSON", "crypto", "fs", "Math", "console", "process", "Deno", "Bun", "http", "sqlite", "posix"]);
      const args = namespaces.has(object) ? methodArgs : [{ k: "name", name: object } as ProgramValue, ...methodArgs];
      return { kind: "invoke", function: methodCall(object, method), args, line: name.line };
    }
    if (token.text === ".") {
      // A field of an object is written the way a name is: the object is read
      // for what it holds, and the field is written into it. The read of the
      // same spelling is a value, and a statement has nowhere to put it.
      this.next();
      this.next();
      const field = this.identifier("the property of a value");
      if (this.at("++") || this.at("--")) {
        const op = this.next().text === "++" ? "+=" : "-=";
        this.accept(";");
        return {
          kind: "fieldAssign",
          object: name.text === "this" ? "self" : name.text,
          field,
          op,
          value: { k: "number", text: "1" },
          line: name.line,
        };
      }
      const op = this.assignOperator();
      if (op === null) {
        if (this.refused) {
          this.synchronize();
          return null;
        }
        this.fail(`"${name.text}.${field}" is not a statement of a program; a program cannot run it`, this.peek());
        this.synchronize();
        return null;
      }
      return {
        kind: "fieldAssign",
        object: name.text === "this" ? "self" : name.text,
        field,
        op,
        value: this.value(),
        line: name.line,
      };
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
    const otherwise = this.value();
    // `c ? ["openmp"] : []` is one list of texts: the empty arm is the list
    // the other arm writes, whatever the written-out list is a list of.
    const empty = (value: ProgramValue): boolean => value.k === "buffer" && value.values.length === 0;
    if (then.k === "words" && empty(otherwise)) return { k: "conditional", condition, then, otherwise: { k: "words", values: [] } };
    if (otherwise.k === "words" && empty(then)) return { k: "conditional", condition, then: { k: "words", values: [] }, otherwise };
    return { k: "conditional", condition, then, otherwise };
  }

  private binary(level: number): ProgramValue {
    if (level === BINARY_LEVELS.length) return this.unary();
    const ops = BINARY_LEVELS[level];
    let left = this.binary(level + 1);
    for (;;) {
      const token = this.peek();
      // `x instanceof C` asks whether the value is there as an instance of a
      // class. A compiled instance is the object itself, so the answer is
      // whether the reference is one at all.
      if (level === 7 && token.kind === "ident" && token.text === "instanceof") {
        this.next();
        const name = this.identifier("the name of a class");
        if (!this.classTable.names.has(name) && name !== "Error") {
          this.fail(`instanceof names a class of this module, not "${name}"`, token);
        }
        const held = this.classOfValue(left);
        const isOne = held !== null && (held === name || (name === "Error" && this.classTable.classes.get(held)?.base === "Error"));
        left =
          held === null
            ? { k: "binary", op: "!==", left, right: { k: "null" } }
            : { k: "boolean", value: isOne };
        continue;
      }
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
    if (token.text === "typeof") {
      // `typeof x` is the name of the kind `x` holds. A value written out is a
      // kind the text is, so the answer is the text itself and no service is
      // asked for; a value the program computes is asked at run time through
      // the `JSON.typeof` the module frontend lowers and the three backends
      // already carry. The operator binds tighter than `**`, as it does in the
      // language, so it is read where a unary operator is.
      this.next();
      const enclosing = this.unaryOperand;
      this.unaryOperand = true;
      const operand = this.unary();
      this.unaryOperand = enclosing;
      const written = this.writtenKind(operand);
      if (written !== null) return { k: "text", parts: [{ k: "text", value: written }] };
      return { k: "call", function: "JSON.typeof", args: [operand] };
    }
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

  /**
   * The name `typeof` answers for a value written out, or null where the value
   * is computed.
   *
   * A literal's kind is the syntax's to say: `1` is a number, `1n` a bigint, a
   * text a string, and `null` an object. A sign in front of one does not change
   * its kind. Anything else — a name, a field, a call — is a value whose kind
   * only the run knows, and `JSON.typeof` is what asks it.
   */
  private writtenKind(value: ProgramValue): string | null {
    if (value.k === "number") return "number";
    if (value.k === "whole") return "bigint";
    if (value.k === "boolean") return "boolean";
    if (value.k === "text") return "string";
    if (value.k === "null") return "object";
    if (value.k === "unary" && (value.op === "-" || value.op === "+")) return this.writtenKind(value.operand);
    return null;
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
    let value = this.primary();
    if (this.at("++") || this.at("--")) {
      const op = this.next().text;
      const name = value.k === "name" ? value.name : "this value";
      this.fail(`"${name}${op}" is not a value; a program runs ++ and -- as statements`);
      return value;
    }
    for (;;) {
      if (this.at("as") || this.at("satisfies")) {
        this.next();
        this.annotation("a type");
        continue;
      }
      if (this.at("[")) {
        this.next();
        const index = this.value();
        this.expect("]");
        if (value.k === "argv") value = { k: "argv", index, offset: value.offset };
        else if (value.k === "name") value = { k: "element", buffer: value.name, index };
        else {
          this.fail("a program cannot read an element of a value; it reads a[i] of a name");
          return value;
        }
        continue;
      }
      if (this.at(".")) {
        const dot = this.peek();
        this.next();
        const member = this.identifier("the property of a value");
        // `req.path` and `req.method` read the request the handler was given:
        // the path it was asked for and the method it was sent with. They are
        // read as text, so a program routes on them the way it routes on any
        // string it wrote. The request is named `req` because that is the name
        // the runtime answers to, the way `req.text()` is.
        if ((member === "path" || member === "method") && value.k === "name" && value.name === "req") {
          if (this.at("(")) this.skipArguments();
          value = {
            k: "text",
            parts: [{ k: "value", value: { k: "call", function: `req.${member}`, args: [value] } }],
          };
          continue;
        }
        // `x.toFixed(2)` writes a number as text at two digits, and `a.fill(x)`
        // writes a number into every element of an array. Both are written of
        // whatever the value is, and both answer the value they were written of.
        if (member === "toFixed" && this.at("(")) return this.fixed(value);
        if (member === "toPrecision" && this.at("(")) return this.precision(value);
        if (member === "toString" && this.at("(")) return this.hexString(value);
        if (member === "fill" && this.at("(")) return this.filled(value);
        if (member === "length" && value.k === "name" && !this.at("(")) {
          value = { k: "length", of: value.name };
          continue;
        }
        if (member === "env" && value.k === "name" && value.name === "process" && this.at(".")) {
          // `process.env.NAME` reads the environment variable NAME, as the
          // text it is set to. The name is the spelling of the variable, and
          // the value is read when the program runs, so a key a program is
          // given arrives without ever being written into the source.
          this.next();
          const variable = this.identifier("the name of the environment variable");
          value = {
            k: "call",
            function: "process.env",
            args: [{ k: "text", parts: [{ k: "text", value: variable }] }],
          };
          continue;
        }
        if (member === "argv" && value.k === "name" && value.name === "process") {
          value = { k: "argv", index: null, offset: 0 };
          continue;
        }
        if (member === "trim" && this.at("(")) {
          // `s.trim()` answers the text with the whitespace at both ends gone:
          // a value read out of a file of configuration arrives with the end
          // of the line it sat on still attached, and a key read with it would
          // never compare equal to the key that was written.
          this.next();
          this.expect(")");
          value = { k: "call", function: "text.trim", args: [value] };
          continue;
        }
        if ((member === "trimStart" || member === "trimEnd") && this.at("(")) {
          // One end of the text, which is the end a line of a file carries:
          // a program cuts a line apart and trims the piece it read.
          this.next();
          this.expect(")");
          value = { k: "call", function: member === "trimStart" ? "text.trimStart" : "text.trimEnd", args: [value] };
          continue;
        }
        if (member === "indexOf" && this.at("(")) {
          // `s.indexOf(needle)` answers where the needle first says itself in
          // the text, counted from the front, and -1 where it never does.
          this.next();
          const args = [value, ...this.arguments()];
          if (args.length !== 2) {
            this.fail("s.indexOf(needle) takes the one text it looks for", this.peek());
          }
          value = { k: "call", function: "text.indexOf", args };
          continue;
        }
        if ((member === "includes" || member === "startsWith") && this.at("(")) {
          // A needle at or after the start is `includes`; a needle at the
          // start is `startsWith`. Both are where `text.indexOf` says the
          // needle is.
          this.next();
          const args = [value, ...this.arguments()];
          if (args.length !== 2) {
            this.fail(`s.${member}(needle) takes the one text it looks for`, this.peek());
          }
          value = {
            k: "binary",
            op: member === "includes" ? "!==" : "===",
            left: { k: "call", function: "text.indexOf", args },
            right: { k: "number", text: member === "includes" ? "-1" : "0" },
          };
          continue;
        }
        if (member === "endsWith" && this.at("(")) {
          // The suffix a text ends with is the slice from its length less the
          // needle's, and the text ends with the needle where that slice is
          // the needle. Both lengths are read from a name or a literal, which
          // is what a program function's text is.
          this.next();
          const args = [value, ...this.arguments()];
          if (args.length === 2) {
            const needle = args[1] as ProgramValue;
            const start = args[0] === undefined ? null : textLength(args[0]);
            const end = textLength(needle);
            if (start !== null && end !== null) {
              value = {
                k: "binary",
                op: "===",
                left: { k: "call", function: "text.slice", args: [value, { k: "binary", op: "-", left: start, right: end }] },
                right: needle,
              };
              continue;
            }
          }
          this.fail("s.endsWith(needle) takes the one text it looks for", this.peek());
        }
        if (member === "slice" && this.at("(") && value.k !== "argv") {
          // `s.slice(start, end)` answers the text between two indexes, and
          // `s.slice(start)` the text from one index to the end. The slice of
          // `process.argv` is the command line, and is the argv below.
          this.next();
          const args = [value, ...this.arguments()];
          if (args.length < 2 || args.length > 3) {
            this.fail("s.slice(start) or s.slice(start, end) slices a text", this.peek());
          }
          value = { k: "call", function: "text.slice", args };
          continue;
        }
        if (member === "slice") {
          // `a.slice(n)` on argv reads the same command line, advanced past the
          // first n arguments, so `args[i]` names argument `i + n` of it.
          let offset = value.k === "argv" ? value.offset : 0;
          if (this.at("(")) {
            this.next();
            if (!this.at(")")) {
              const first = this.value();
              if (first.k === "number") offset += Number(first.text);
            }
            this.accept(")");
          }
          value = { k: "argv", index: null, offset };
          continue;
        }
        if (member === "size" && !this.at("(") && value.k === "name" && this.collections.has(value.name)) {
          value = { k: "call", function: "blaze_rt_dict_len", args: [value] };
          continue;
        }
        if (this.at("(") && value.k === "name" && this.collections.get(value.name) !== undefined) {
          const kind = this.collections.get(value.name) as "set" | "map";
          const one: ProgramValue = { k: "number", text: "1" };
          if (kind === "set" && (member === "add" || member === "delete" || member === "has")) {
            this.next();
            const args = this.arguments();
            if (args.length !== 1) this.fail(`a set's ${member} takes the one value`, this.peek());
            const called: ProgramValue = member === "add"
              ? { k: "call", function: "blaze_rt_dict_set", args: [value, args[0] as ProgramValue, one] }
              : { k: "call", function: member === "has" ? "blaze_rt_dict_has" : "blaze_rt_dict_delete", args: [value, args[0] as ProgramValue] };
            // The runtime answers one or zero, and a program's truth is the
            // comparison that says so: `s.has(k)` prints and branches the way a
            // truth does rather than as the number it is held as.
            value = member === "has"
              ? { k: "binary", op: "!==", left: called, right: { k: "number", text: "0" } }
              : called;
            continue;
          }
          if (kind === "map" && (member === "get" || member === "has" || member === "delete")) {
            this.next();
            const args = this.arguments();
            if (args.length !== 1) this.fail(`a map's ${member} takes the one key`, this.peek());
            const called: ProgramValue = {
              k: "call",
              function: member === "get" ? "blaze_rt_dict_get" : member === "has" ? "blaze_rt_dict_has" : "blaze_rt_dict_delete",
              args: [value, args[0] as ProgramValue],
            };
            value = member === "has"
              ? { k: "binary", op: "!==", left: called, right: { k: "number", text: "0" } }
              : called;
            continue;
          }
        }
        if (this.at("(")) {
          this.next();
          // `C.method(args)`: a static method is a function of the class.
          if (value.k === "name" && !this.valueClasses.has(value.name)) {
            const owner = this.classNamed(value.name);
            if (owner !== undefined) {
              const found = this.methodOwner(owner.name, member, true);
              if (found !== null) {
                const args = this.arguments();
                value = { k: "call", function: this.methodName(found.owner, found.method, args.length), args };
                continue;
              }
            }
          }
          // `p.method(args)`: the instance the call is written on is the first
          // argument of the function the method lowers to.
          const found = this.methodOwner(this.classOfValue(value), member, false);
          if (found !== null) {
            const args = [value, ...this.arguments()];
            value = {
              k: "call",
              function: this.methodName(found.owner, found.method, args.length - 1),
              args,
            };
            continue;
          }
          // `Number.parseInt(text, 10)` is the number the text states in base
          // ten, which is the call `parseInt` already is.
          if (value.k === "name" && value.name === "Number" && member === "parseInt") {
            const written = this.arguments();
            value = { k: "call", function: "parseInt", args: this.baseTenRadix(written, this.peek()) };
            continue;
          }
          const namespaces = new Set(["JSON", "crypto", "fs", "Math", "console", "process", "Deno", "Bun", "http", "performance", "sqlite", "Promise", "posix"]);
          const prepend = !(value.k === "name" && namespaces.has(value.name));
          let args: ProgramValue[];
          if (value.k === "name" && value.name === "http" && member === "createServer") {
            args = this.arguments();
          } else {
            args = prepend ? [value, ...this.arguments()] : this.arguments();
          }
          const object = this.valuePath(value);
          value = { k: "call", function: methodCall(object, member), args };
          continue;
        }
        // `C.FIELD`: a static field is a function that answers the value.
        if (value.k === "name" && !this.valueClasses.has(value.name)) {
          const owner = this.classNamed(value.name);
          if (owner !== undefined) {
            const field = findField(this.classTable, owner.name, member, true);
            if (field !== null) {
              value = { k: "call", function: `${field.owner}_${field.field.name}`, args: [] };
              continue;
            }
            const getter = findGetter(this.classTable, owner.name, member, true);
            if (getter !== null) {
              value = { k: "call", function: `${getter.owner}_${getter.getter.name}`, args: [] };
              continue;
            }
          }
        }
        // `c.size`: a member a class reads through a getter is the body the
        // getter became, called with the instance the read names.
        if (value.k === "name") {
          const owner = this.classOfValue(value);
          if (owner !== null) {
            const getter = findGetter(this.classTable, owner, member, false);
            if (getter !== null) {
              value = { k: "call", function: `${getter.owner}_${getter.getter.name}`, args: [value] };
              continue;
            }
          }
        }
        if (value.k === "name" || value.k === "field" || value.k === "call") {
          value = { k: "field", object: value, field: member };
          continue;
        }
        this.fail(
          "a program cannot read a member of a value; it reads a field of a name, and writes a number as x.toFixed(digits)",
          dot,
        );
        if (this.at("(")) this.skipArguments();
        return value;
      }
      if (this.at("(")) {
        if (value.k !== "name" && value.k !== "field" && value.k !== "call") {
          this.fail("a program cannot call a value; it calls a name");
          this.skipArguments();
          return value;
        }
        this.next();
        const fn = this.valuePath(value);
        const named = this.arguments();
        value = { k: "call", function: fn, args: fn === "parseInt" ? this.baseTenRadix(named, this.peek()) : named };
        continue;
      }
      break;
    }
    return value;
  }

  /**
   * `a.fill(x)`: every element of the array written as `x`, and the array
   * itself, so that `const b = a.fill(1)` names the array it filled. Whether
   * what it is written of is an array is not settled here: the resolver reads
   * the value and names what it holds, which is the answer that says it.
   */
  private filled(buffer: ProgramValue): ProgramValue {
    this.expect("(");
    const value = this.value();
    this.expect(")");
    return { k: "fill", buffer, value };
  }

  /**
   * `x.toFixed(d)`: the number written as text at `d` digits after the point.
   * The count is written out in the source, so it is a number the parser reads
   * rather than a value it evaluates.
   */
  private fixed(of: ProgramValue): ProgramValue {
    const open = this.peek();
    this.next();
    const digits = this.peek();
    if (digits.kind !== "number" || !/^\d+$/.test(digits.text)) {
      this.fail("the digits a number is written at are written out, as in x.toFixed(2)", digits);
      this.skipArguments();
      return this.nothing();
    }
    this.next();
    if (!this.at(")")) this.fail("x.toFixed takes one number of digits", this.peek());
    this.expect(")");
    if (of.k === "text" || of.k === "fixed") {
      this.fail("a number is what is written at a fixed number of digits; a string is already text", open);
    }
    return { k: "fixed", of, digits: Number(digits.text) };
  }

  /**
   * `x.toPrecision(p)`: the number written as text at `p` significant digits.
   * The count is written out in the source, so it is a number the parser reads
   * rather than a value it evaluates, and it is between one and a hundred.
   */
  private precision(of: ProgramValue): ProgramValue {
    const open = this.peek();
    this.next();
    const digits = this.peek();
    const count = digits.kind === "number" ? Number(digits.text) : Number.NaN;
    if (digits.kind !== "number" || !/^\d+$/.test(digits.text) || count < 1 || count > 100) {
      this.fail("the significant digits a number is written at are written out, as in x.toPrecision(17)", digits);
      this.skipArguments();
      return this.nothing();
    }
    this.next();
    if (!this.at(")")) this.fail("x.toPrecision takes one count of digits", this.peek());
    this.expect(")");
    if (of.k === "text" || of.k === "fixed") {
      this.fail("a number is what is written at a count of significant digits; a string is already text", open);
    }
    return { k: "fixed", of, digits: count, precision: true };
  }

  /**
   * `x.toString(16)` and `x.toString(2)`: a whole number written as lowercase
   * text in the radix the source names.
   */
  private hexString(of: ProgramValue): ProgramValue {
    const open = this.peek();
    this.next();
    if (this.at(")")) {
      this.expect(")");
      return of;
    }
    const token = this.peek();
    if (token.kind !== "number" || (token.text !== "16" && token.text !== "2")) {
      this.fail("toString writes a whole number in base sixteen or base two", token);
      this.skipArguments();
      return of;
    }
    this.next();
    if (!this.at(")")) this.fail("x.toString(16) takes the radix 16 or 2", this.peek());
    this.expect(")");
    if (of.k === "text" || of.k === "fixed") {
      this.fail("a number is what is written in a radix; a string is already text", open);
      return of;
    }
    return { k: "fixed", of, digits: token.text === "2" ? -2 : -1 };
  }


  /** The path a value is called by, for a call written of it. */
  private valuePath(value: ProgramValue): string {
    if (value.k === "name") return value.name;
    if (value.k === "field") return `${this.valuePath(value.object)}.${value.field}`;
    if (value.k === "call") return value.function;
    return "this value";
  }

  /** A value on its own. */
  private primary(): ProgramValue {
    const token = this.peek();
    // A regular expression is a value a function reads, and the module frontend
    // carries the two texts it is made of. A program body holds it as the text
    // it was written as, which is enough to skip a constant the program does
    // not read.
    if (token.kind === "regex") {
      this.next();
      return { k: "text", parts: [{ k: "text", value: `/${token.text}/${token.flags ?? ""}` }] };
    }
    if (token.kind === "ident" && token.text === "async") {
      this.next();
      // `async (...) => body` and `async x => body`: an arrow function whose
      // body runs when it is called, and whose answer is a promise carrying
      // what that body returns.
      if (this.peek().text === "(") {
        let depth = 1;
        let i = 1;
        while (depth > 0 && this.peek(i).kind !== "end") {
          const t = this.peek(i);
          if (t.kind === "punct") {
            if (t.text === "(") depth += 1;
            else if (t.text === ")") {
              depth -= 1;
              if (depth === 0) break;
            }
          }
          i += 1;
        }
        if (this.arrowFollows(i)) {
          const line = this.peek().line;
          const params = this.arrowParams();
          this.arrowResultType();
          this.accept("=>");
          if (this.at("{")) {
            const body = this.braces();
            return { k: "arrow", params, body, async: true };
          }
          const value = this.value();
          return { k: "arrow", params, body: [{ kind: "result", value, line }], async: true };
        }
      }
      if (this.peek().kind === "ident" && this.peek(1).text === "=>") {
        const line = this.peek().line;
        const name = this.next().text;
        this.next(); // =>
        if (this.at("{")) {
          const body = this.braces();
          return { k: "arrow", params: [{ name, type: null }], body, async: true };
        }
        const value = this.value();
        return { k: "arrow", params: [{ name, type: null }], body: [{ kind: "result", value, line }], async: true };
      }
      // `async function () { ... }`: a function expression written the long
      // way, which is the same arrow with a promise behind it.
      if (this.peek().kind === "ident" && this.peek().text === "function") {
        this.next();
        const params: { name: string; type: string | null }[] = [];
        if (this.accept("(")) {
          while (!this.at(")") && this.peek().kind !== "end") {
            const name = this.peek().text;
            this.next();
            params.push({ name, type: null });
            if (!this.accept(",")) break;
          }
          this.expect(")");
        }
        if (this.peek().kind === "ident") this.next();
        const body = this.at("{") ? this.braces() : [];
        return { k: "arrow", params, body, async: true };
      }
      return this.nothing();
    }
    if (token.kind === "number") {
      this.next();
      return { k: "number", text: token.text };
    }
    if (token.kind === "bigint") {
      this.next();
      return { k: "whole", text: token.text };
    }
    if (token.kind === "string") {
      this.next();
      return { k: "text", parts: this.parts(token) };
    }
    // `await x` and `yield x` read as the name `await` or `yield` and whatever
    // came after it, so the build failed on the expression rather than on the
    // word that was written. They are refused where the word is.
    if (token.kind === "ident" && token.text === "await") {
      this.next();
      const value = this.value();
      return { k: "call", function: "Promise.await", args: [value] };
    }
    if (token.kind === "ident" && token.text === "yield") {
      this.next();
      this.fail(`"${token.text}" is not part of a program`, token, refusedKeyword(token.text));
      return this.value();
    }
    if (token.kind === "ident" && token.text === "function") {
      this.next();
      // A function expression used as a value (such as a Promise executor)
      // is read as an arrow: its parameters and body are kept, so the
      // surrounding call can invoke it.
      const params: { name: string; type: string | null }[] = [];
      if (this.accept("(")) {
        while (!this.at(")") && this.peek().kind !== "end") {
          const name = this.peek().text;
          this.next();
          params.push({ name, type: null });
          if (!this.accept(",")) break;
        }
        this.expect(")");
      }
      if (this.peek().kind === "ident") this.next(); // optional name
      const body = this.at("{") ? this.braces() : [];
      return { k: "arrow", params, body };
    }
    if (token.kind === "ident" && this.peek(1).text === "=>") {
      const line = token.line;
      const name = this.next().text;
      this.next(); // =>
      if (this.at("{")) {
        const body = this.braces();
        return { k: "arrow", params: [{ name, type: null }], body };
      }
      const value = this.value();
      return { k: "arrow", params: [{ name, type: null }], body: [{ kind: "result", value, line }] };
    }
    if (token.kind === "ident") {
      if (token.text === "new") {
        this.next();
        if (this.peek().text === "Promise") {
          this.next();
          // Parse `new Promise(arrow)` so the arrow is registered and lowered.
          this.expect("(");
          const callback = this.value();
          this.expect(")");
          return { k: "call", function: "Promise", args: [callback] };
        }
        const constructed = this.peek();
        if (constructed.kind === "ident" && this.classTable.names.has(constructed.text)) {
          const info = this.classNamed(constructed.text) as ClassInfo;
          this.next();
          this.expect("(");
          const args = this.arguments();
          const params = info.constructor?.params ?? [];
          const method: ClassMethod = {
            name: "constructor",
            params,
            returnTypeName: info.name,
            bodyStart: -1,
            bodyEnd: -1,
            line: info.line,
          };
          return { k: "call", function: this.methodName(info.name, method, args.length), args };
        }
        // `new C(...)` of a class another module declares is a call of the
        // function that module lowered it to; the class is not in this file's
        // table, and its constructor takes the arguments the source wrote.
        if (constructed.kind === "ident" && this.importedNames.has(constructed.text)) {
          this.next();
          this.expect("(");
          const args = this.arguments();
          return { k: "call", function: constructed.text, args };
        }
        // `new Set<string>()` and `new Map<K, V>()` are one handle on the
        // runtime's dictionary. The set and the map are the same value; what
        // the source calls it is which methods it answers, and the declaration
        // binds that beside the name.
        if (constructed.kind === "ident" && (constructed.text === "Set" || constructed.text === "Map")) {
          this.next();
          const kind = constructed.text === "Set" ? "set" : "map";
          // A dictionary is keyed by a string: a set or a map of numbers or
          // references is keyed by another spelling the runtime has, and the
          // program body writes the text one.
          let keyedByText = true;
          if (this.at("<")) {
            const key = this.peek(1);
            keyedByText = key.kind === "ident" && key.text === "string";
            this.skipAngles();
          }
          this.expect("(");
          if (!keyedByText) {
            this.fail(`${constructed.text} is keyed by a string in a program`, this.peek());
            this.skipArguments();
            this.expect(")");
            return this.nothing();
          }
          if (!this.at(")")) {
            // A dictionary built from an iterable is a copy of entries the
            // program would have to walk: the empty dictionary and the writes
            // that fill it are the form this subset holds.
            this.fail(`a ${constructed.text} is built empty, and filled by its own writes`, this.peek());
            this.skipArguments();
          }
          this.expect(")");
          const made: ProgramValue = { k: "call", function: "blaze_rt_dict_new", args: [] };
          this.collectionValues.set(made, kind);
          return made;
        }
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
        return this.argv("process.argv");
      }
      // Deno names the same command line as node does, and a benchmark written
      // for one is run by the other without being rewritten.
      if (token.text === "Deno" && this.peek(1).text === "." && this.peek(2).text === "args") {
        this.next();
        this.next();
        this.next();
        return this.argv("Deno.args");
      }
      if (token.text === "Math" && this.peek(1).text === ".") return this.math();
      if (token.text in VIEWS && this.peek(1).text === ".") return this.viewWidth(token);
      if (token.text === "this") {
        this.next();
        if (this.currentClass === null) {
          this.fail('"this" is not a value outside a class method', token);
        }
        return { k: "name", name: "self" };
      }
      this.next();
      return { k: "name", name: token.text };
    }
    // `[1, 2, 3]`: an array written out where it is made, which is what
    // `new Float64Array([1, 2, 3])` spells out in full. An empty list is a
    // block of no elements, which the runtime still has to hand back.
    if (this.accept("[")) return this.arrayLiteral();
    // `{ a: 1, b: 2 }`: an object, allocated where it is written, with every
    // field inside the same literal.
    if (this.accept("{")) return this.objectLiteral();
    if (this.peek().kind === "punct" && this.peek().text === "(") {
      // Detect an arrow function `(params) => body` and read it past.
      let depth = 1;
      let i = 1;
      while (depth > 0 && this.peek(i).kind !== "end") {
        const t = this.peek(i);
        if (t.kind === "punct") {
          if (t.text === "(") depth += 1;
          else if (t.text === ")") {
            depth -= 1;
            if (depth === 0) break;
          }
        }
        i += 1;
      }
      if (this.arrowFollows(i)) {
        const line = this.peek().line;
        const params = this.arrowParams();
        this.arrowResultType();
        this.accept("=>");
        if (this.at("{")) {
          const body = this.braces();
          return { k: "arrow", params, body };
        }
        const value = this.value();
        return { k: "arrow", params, body: [{ kind: "result", value, line }] };
      }
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

  /** `{ a: 1, b: x.y }`: an object, allocated where it is written. */
  private objectLiteral(): ProgramValue {
    const fields: { name: string; value: ProgramValue }[] = [];
    const spreads: ProgramValue[] = [];
    if (!this.at("}")) {
      for (;;) {
        if (this.at("}")) break;
        if (this.at("...")) {
          // `...rest`: the fields another value writes are not this literal's
          // fields to write down, so the value spread is kept beside them and
          // the layout pass expands the ones it can read.
          this.next();
          spreads.push(this.value());
          if (!this.accept(",")) break;
          continue;
        }
        if (this.at("async")) this.next();
        let name: string;
        if (this.peek().kind === "string") {
          const tok = this.next();
          name = tok.text.replace(/^["']|["']$/g, "");
        } else {
          name = this.identifier("the name of a field");
        }
        if (this.at("(")) {
          this.next();
          let depth = 1;
          while (depth > 0 && this.peek().kind !== "end") {
            const t = this.next();
            if (t.kind === "punct") {
              if (t.text === "(") depth += 1;
              else if (t.text === ")") depth -= 1;
            }
          }
          while (this.peek().kind !== "end" && !this.at("{")) this.next();
          if (this.at("{")) {
            let bdepth = 0;
            do {
              const t = this.next();
              if (t.kind === "punct") {
                if (t.text === "{") bdepth += 1;
                else if (t.text === "}") bdepth -= 1;
              }
            } while (bdepth > 0 && this.peek().kind !== "end");
          }
          // A method written in shorthand is read past and takes no part in
          // the object's layout: it is behaviour the program does not store.
          if (!this.accept(",")) break;
          continue;
        }
        let value: ProgramValue;
        if (this.accept(":")) {
          value = this.value();
        } else {
          value = { k: "name", name };
        }
        fields.push({ name, value });
        if (!this.accept(",")) break;
      }
    }
    this.expect("}");
    return spreads.length === 0 ? { k: "object", fields } : { k: "object", fields, spreads };
  }

  /**
   * `Float64Array.BYTES_PER_ELEMENT`: how wide one element of a view is. The
   * width belongs to the language rather than to the program, so it is read
   * here as a number written out, and a program counts the bytes of a buffer
   * with it rather than writing the count down.
   */
  private viewWidth(view: Token): ProgramValue {
    this.next();
    this.next();
    const member = this.identifier("the property of a view");
    if (member !== "BYTES_PER_ELEMENT") {
      this.fail(
        `${view.text}.${member} is not part of a program; a program reads ${view.text}.BYTES_PER_ELEMENT`,
        view,
      );
      return this.nothing();
    }
    return { k: "number", text: String(VIEW_BYTES[VIEWS[view.text] as string]) };
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
        if (this.at(")")) break;
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

  /* ---------------------------------------------------------------------- */
  /* Classes                                                                */
  /* ---------------------------------------------------------------------- */

  private classNamed(name: string): ClassInfo | undefined {
    return this.classTable.classes.get(name);
  }

  private classTypeName(typeName: string): string | null {
    return this.classTable.names.has(typeName) ? typeName : null;
  }

  /** The class a value is known to hold, or null where nothing says. */
  private classOfValue(value: ProgramValue): string | null {
    switch (value.k) {
      case "name": {
        const known = this.valueClasses.get(value.name);
        if (known !== undefined) return known;
        return this.classTable.names.has(value.name) ? value.name : null;
      }
      case "field": {
        if (value.object.k === "name" && !this.valueClasses.has(value.object.name)) {
          const owner = this.classNamed(value.object.name);
          if (owner !== undefined) {
            const field = findField(this.classTable, owner.name, value.field, true);
            return field === null ? null : this.classTypeName(field.field.typeName);
          }
        }
        const base = this.classOfValue(value.object);
        if (base === null) return null;
        const field = findField(this.classTable, base, value.field, false);
        return field === null ? null : this.classTypeName(field.field.typeName);
      }
      case "call":
        return this.callReturnClass(value.function);
      default:
        return null;
    }
  }

  private callReturnClass(name: string): string | null {
    if (this.classTable.names.has(name)) return name;
    for (const info of this.classTable.ordered) {
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

  private methodOwner(hint: string | null, name: string, isStatic: boolean): { owner: string; method: ClassMethod } | null {
    if (hint !== null) {
      const found = findMethod(this.classTable, hint, name, isStatic);
      if (found !== null) return found;
    }
    if (this.currentClass !== null) {
      const found = findMethod(this.classTable, this.currentClass.name, name, isStatic);
      if (found !== null) return found;
    }
    const matches: { owner: string; method: ClassMethod }[] = [];
    for (const info of this.classTable.ordered) {
      const found = findMethod(this.classTable, info.name, name, isStatic);
      if (found !== null && !matches.some((entry) => entry.method === found.method)) matches.push(found);
    }
    return matches.length === 1 ? matches[0] : null;
  }

  /** The function a construction or method call names, with defaults filled. */
  private methodName(owner: string, method: ClassMethod, arity: number): string {
    return methodFunctionName(owner, method, arity);
  }

  /**
   * The command line a program was given, as `process.argv` and `Deno.args`
   * both name it. Node counts the program and the file it runs before the
   * arguments, and Deno hands over the arguments alone: `Deno.args[i]` is the
   * argument `process.argv[i + 2]` is, and `Deno.args.length` is two shorter
   * than the length node reports. A benchmark written for one host is run by
   * this one without being rewritten, and it reads the argument it was given.
   */
  private argv(written: string): ProgramValue {
    const shift = written === "Deno.args" ? 2 : 0;
    // `process.argv[i]` and `Deno.args[i]` name argument `i` (or `i + shift`
    // for Deno, which does not count the program and the file it runs).
    if (this.accept("[")) {
      const index = this.value();
      this.expect("]");
      return { k: "argv", index, offset: shift };
    }
    if (this.accept(".")) {
      const member = this.identifier("the property of a value");
      if (member === "length") {
        const length: ProgramValue = { k: "call", function: ARGV_LENGTH, args: [] };
        return shift === 0 ? length : { k: "binary", op: "-", left: length, right: { k: "number", text: String(shift) } };
      }
      if (member === "slice") {
        // `process.argv.slice(n)` reads the same command line, advanced past
        // the first `n` arguments, so `args[i]` names argument `i + n`.
        let offset = shift;
        if (this.at("(")) {
          this.next();
          if (!this.at(")")) {
            const first = this.value();
            if (first.k === "number") offset += Number(first.text);
          }
          this.accept(")");
        }
        return { k: "argv", index: null, offset };
      }
      this.fail(`${written}.${member} is not part of a program; a program reads argv.length`, this.peek());
      return { k: "number", text: "0" };
    }
    return { k: "argv", index: null, offset: shift };
  }

  /**
   * `new SharedArrayBuffer(bytes)`: a block of bytes the program lays out, which
   * the views over it read and write. It is what a program allocates when it
   * wants one array to be three arrays of it, as the language allows.
   */
  private sharedBuffer(): ProgramValue {
    this.next();
    this.expect("(");
    const count = this.value();
    this.expect(")");
    return { k: "shared", count };
  }

  /** `new Float64Array([1, x, 3])`: the values are the elements of the buffer. */
  private bufferLiteral(): ProgramValue {
    // A block of bytes is not a view of one, and it is read before the view
    // name is: the two are allocated the same way and named differently.
    if (this.peek().text === "SharedArrayBuffer" || this.peek().text === "ArrayBuffer") {
      return this.sharedBuffer();
    }
    const view = this.identifier("a typed array name");
    if (view === "Response") {
      if (this.at("(")) {
        this.next();
        if (!this.at(")")) {
          do { this.value(); } while (this.accept(","));
        }
        this.expect(")");
      }
      return this.nothing();
    }
    if (!(view in VIEWS)) {
      this.fail(`a program cannot allocate ${view}; supported: ${VIEWS_LIST}`);
      this.skipArguments();
      return this.nothing();
    }
    this.expect("(");
    // `new Float64Array(n)` is a block of n elements the program sizes when it
    // runs, and `new Float64Array(block, offset, n)` is a window of one that
    // was laid out: both take counts, and both are cleared.
    if (!this.at("[")) {
      const args = this.arguments();
      if (args.length === 1) {
        return { k: "sized", element: VIEWS[view] as PrimitiveTypeName, count: args[0] };
      }
      // `new Array(a, b)` names the elements, which is what the source language
      // does with more than one argument, and what a list written out is.
      if (args.length !== 3 && view === "Array") {
        return { k: "buffer", element: "f64" as PrimitiveTypeName, values: args };
      }
      if (args.length === 3) {
        return { k: "view", element: VIEWS[view] as PrimitiveTypeName, of: args[0], offset: args[1], count: args[2] };
      }
      this.fail(
        `a program allocates a typed array as the values it holds, as in new ${view}([1, 2]), or as a count of elements, as in new ${view}(n), or as a view of a block, as in new ${view}(block, offset, n)`,
      );
      return this.nothing();
    }
    this.next();
    const values = this.elements();
    this.expect(")");
    return { k: "buffer", element: VIEWS[view] as PrimitiveTypeName, values };
  }

  /**
   * `[1, x, 3]`: the values a typed array holds. It is the same list whether it
   * was written as `new Float64Array([...])` or on its own as `const a = [...]`,
   * because a `number` is a double whatever it was written next to, and this
   * subset has one array of numbers rather than the several TypeScript has.
   */
  private arrayLiteral(): ProgramValue {
    const values = this.elements();
    const texts = values.filter((value) => value.k === "text" || value.k === "fixed").length;
    if (texts === values.length && texts > 0) return { k: "words", values };
    if (texts > 0) {
      this.fail("an array holds one kind of value", this.peek());
      return { k: "buffer", element: "f64", values: [] };
    }
    return { k: "buffer", element: "f64", values };
  }

  /**
   * The elements between the brackets, or what stopped reading them. The left
   * bracket is already read, because both callers looked at it before deciding
   * this is a list of elements rather than an index or a block.
   */
  private elements(): ProgramValue[] {
    const values: ProgramValue[] = [];
    if (this.at("]")) {
      this.next();
      return values;
    }
    for (;;) {
      values.push(this.value());
      if (!this.accept(",")) break;
      // A trailing comma is written in the source and has no element behind it.
      if (this.at("]")) break;
    }
    this.expect("]");
    return values;
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
 * The length of a text a program value holds, where the value is a name or a
 * literal: a length is what `text.slice` and `endsWith` need, and a value the
 * program builds is not one the parser can measure.
 */
function textLength(value: ProgramValue): ProgramValue | null {
  if (value.k === "name") return { k: "length", of: value.name };
  if (value.k === "text" && value.parts.length === 1) {
    const part = value.parts[0];
    if (part !== undefined && part.k === "text") return { k: "number", text: String(part.value.length) };
  }
  return null;
}

/**
 * Reads the statements of a module from the first token of its body to the end
 * of the file. A program is the last thing a module says, so the caller checks
 * that no declaration follows.
 */
export function parseProgramBody(
  tokens: Token[],
  path: string,
  diagnostics: Diagnostics,
  classes?: ClassTable,
  imported: ReadonlySet<string> = new Set(),
): ProgramStatement[] {
  return new ProgramParser(tokens, path, diagnostics, classes, imported).body();
}

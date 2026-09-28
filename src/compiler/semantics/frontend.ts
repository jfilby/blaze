/**
 * Frontend: Nim module -> module analysis and function contracts.
 *
 * The frontend is the only component that understands the source language. It
 * parses a module into what it declares and imports (see module.ts), and turns
 * one declared proc at a time into a contract. Nothing about its internal AST
 * or IR leaves the file.
 *
 * Supported Nim subset:
 *
 *   import ./other
 *
 *   proc name(p: T, ...): R =
 *     var acc: T = <literal>
 *     for i in <from> ..< <to>:
 *       acc += <expr>
 *     result = acc
 *
 *   - statements: var/let declarations, counted for loops, assignments,
 *     compound assignments, result/return, expression bodies
 *   - expressions: integer and float literals, identifiers, indexing,
 *     + - * / and parentheses
 *   - parameter types: primitives, ptr T, openArray[T], array[N, T]
 *   - pure functions only: writing through a pointer or an indexed element is
 *     rejected, so every accepted contract has effects: [] and writes: []
 *
 * A parsed proc is lowered into the shared IR (see the lowering section), so a
 * Nim proc and a TypeScript function are the same thing to everything past the
 * frontend: a signature, a body and the conditions it is held to.
 */
import { isFloatType, parseType, typeToString } from "./contract.ts";
import { assembleContract, type AccessRange } from "./contract-build.ts";
import { CompilerError } from "../core/errors.ts";
import { typeScriptFrontend } from "./typescript.ts";
import type { Frontend, ModuleImport } from "./module.ts";
import type { Expression, Statement } from "../core/ir.ts";
import type { TypeExpr } from "../core/types.ts";

function frontendError(message: string, detail?: string): CompilerError {
  return new CompilerError({ category: "FrontendError", stage: "frontend", message, detail });
}

/* -------------------------------------------------------------------------- */
/* Nim types                                                                  */
/* -------------------------------------------------------------------------- */

const NIM_PRIMITIVES: Record<string, string> = {
  bool: "bool",
  byte: "u8",
  char: "u8",
  uint8: "u8",
  uint16: "u16",
  uint32: "u32",
  uint64: "u64",
  int8: "i8",
  int16: "i16",
  int32: "i32",
  int64: "i64",
  int: "i64",
  float32: "f32",
  float64: "f64",
  float: "f64",
  uint: "u64",
  usize: "usize",
  isize: "isize",
};

/** Maps a Nim type expression onto a contract type expression. */
function mapNimType(text: string, position: string): TypeExpr {
  const source = text.trim();
  // `in` walks the prototype chain, and a Nim type named `constructor` or
  // `toString` is a legal one: the guard passed and the table answered with
  // `Object.prototype`'s own member, so the type parser was handed a function
  // and the source was refused with a TypeError instead of the diagnostic
  // naming the type it does not support.
  if (Object.prototype.hasOwnProperty.call(NIM_PRIMITIVES, source)) {
    return parseType(NIM_PRIMITIVES[source]);
  }
  const pointer = /^ptr\s+(.+)$/.exec(source);
  if (pointer !== null) return { kind: "ptr", of: mapNimType(pointer[1], position) };
  const openArray = /^openArray\[\s*(\w+)\s*\]$/.exec(source);
  if (openArray !== null) return { kind: "slice", of: mapNimType(openArray[1], position) };
  const array = /^array\[\s*([^,\]]+)\s*,\s*(.+?)\s*\]$/.exec(source);
  if (array !== null) {
    const [, lengthText, elementText] = array;
    const range = /^(\d+)\s*\.\.\s*(\d+)$/.exec(lengthText.trim());
    // `array[lo..hi, T]` holds every element from lo to hi, so its length is
    // the two bounds and not the upper one alone: `array[1..3, T]` is three
    // elements, and the buffer, the preconditions and every index the body
    // reads are all wrong when it is four.
    const length = range === null ? Number.parseInt(lengthText.trim(), 10) : Number(range[2]) - Number(range[1]) + 1;
    if (!Number.isInteger(length) || length <= 0) {
      throw frontendError(`unsupported array length "${lengthText}"`, `at ${position}`);
    }
    return { kind: "array", of: mapNimType(elementText, position), length };
  }
  throw frontendError(`unsupported Nim type "${source}"`, `at ${position}; supported: primitives, ptr T, openArray[T], array[N, T]`);
}

/* -------------------------------------------------------------------------- */
/* Expressions                                                                */
/* -------------------------------------------------------------------------- */

type NimExpr =
  | { k: "literal"; text: string }
  | { k: "ident"; name: string }
  | { k: "index"; base: NimExpr; index: NimExpr }
  | { k: "binary"; op: "+" | "-" | "*" | "/"; left: NimExpr; right: NimExpr }
  | { k: "negate"; operand: NimExpr };

type ExprToken = { text: string; kind: "number" | "ident" | "op" | "end" };

const EXPR_OPERATORS = ["+", "-", "*", "/", "(", ")", "[", "]"];

class ExpressionReader {
  private readonly tokens: ExprToken[];
  private readonly source: string;
  private readonly context: string;
  private position = 0;

  constructor(source: string, context: string) {
    this.source = source;
    this.context = context;
    this.tokens = tokenizeExpression(source, context);
  }

  read(): NimExpr {
    const expression = this.readAdditive();
    const trailing = this.peek();
    if (trailing.kind !== "end") this.fail(`unexpected "${trailing.text}"`);
    return expression;
  }

  private peek(): ExprToken {
    return this.tokens[this.position];
  }

  private fail(message: string): never {
    throw frontendError(`${message} in "${this.source}"`, `at ${this.context}`);
  }

  private readAdditive(): NimExpr {
    let left = this.readMultiplicative();
    for (;;) {
      const token = this.peek();
      if (token.kind !== "op" || (token.text !== "+" && token.text !== "-")) return left;
      this.position += 1;
      left = { k: "binary", op: token.text, left, right: this.readMultiplicative() };
    }
  }

  private readMultiplicative(): NimExpr {
    let left = this.readUnary();
    for (;;) {
      const token = this.peek();
      if (token.kind !== "op" || (token.text !== "*" && token.text !== "/")) return left;
      this.position += 1;
      left = { k: "binary", op: token.text, left, right: this.readUnary() };
    }
  }

  private readUnary(): NimExpr {
    const token = this.peek();
    if (token.kind === "op" && token.text === "-") {
      this.position += 1;
      return { k: "negate", operand: this.readUnary() };
    }
    if (token.kind === "op" && token.text === "+") {
      this.position += 1;
      return this.readUnary();
    }
    return this.readPostfix();
  }

  private readPostfix(): NimExpr {
    let base = this.readPrimary();
    while (this.peek().kind === "op" && this.peek().text === "[") {
      this.position += 1;
      const index = this.readAdditive();
      const closing = this.peek();
      if (closing.kind !== "op" || closing.text !== "]") this.fail('expected "]"');
      this.position += 1;
      base = { k: "index", base, index };
    }
    return base;
  }

  private readPrimary(): NimExpr {
    const token = this.tokens[this.position++];
    if (token === undefined) this.fail("unexpected end of expression");
    if (token.kind === "number") return { k: "literal", text: token.text };
    if (token.kind === "ident") return { k: "ident", name: token.text };
    if (token.kind === "op" && token.text === "(") {
      const inner = this.readAdditive();
      const closing = this.peek();
      if (closing.kind !== "op" || closing.text !== ")") this.fail('expected ")"');
      this.position += 1;
      return inner;
    }
    this.fail(`unexpected "${token.text}"`);
  }
}

function tokenizeExpression(source: string, context: string): ExprToken[] {
  const tokens: ExprToken[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (/[0-9]/.test(character) || (character === "." && /[0-9]/.test(source[index + 1] ?? ""))) {
      const match = /^(?:0[xX][0-9a-fA-F]+|[0-9]*\.[0-9]+|[0-9]+)(?:[eE][+-]?[0-9]+)?(?:'f32|'f64)?/.exec(source.slice(index));
      if (match === null) throw frontendError(`malformed number in "${source}"`, `at ${context}`);
      tokens.push({ kind: "number", text: exactFloatLiteral(match[0]) });
      index += match[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(character)) {
      const match = /^[A-Za-z_][A-Za-z0-9_']*/.exec(source.slice(index));
      if (match === null) throw frontendError(`malformed identifier in "${source}"`, `at ${context}`);
      tokens.push({ kind: "ident", text: match[0] });
      index += match[0].length;
      continue;
    }
    const operator = EXPR_OPERATORS.find((candidate) => source.startsWith(candidate, index));
    if (operator === undefined) {
      throw frontendError(`unsupported token "${character}" in "${source}"`, `at ${context}`);
    }
    tokens.push({ kind: "op", text: operator });
    index += operator.length;
  }
  tokens.push({ kind: "end", text: "" });
  return tokens;
}

/**
 * Rounds a Nim float32 literal to the value it denotes and prints enough digits
 * to reproduce that value exactly, so the contract carries no precision loss
 * for the reference implementation.
 */
function exactFloatLiteral(text: string): string {
  if (text.endsWith("'f32")) return Math.fround(Number(text.slice(0, -4))).toPrecision(17);
  if (text.endsWith("'f64")) return text.slice(0, -4);
  return text;
}

function parseNimExpression(source: string, context: string): NimExpr {
  return new ExpressionReader(source, context).read();
}

/* -------------------------------------------------------------------------- */
/* Statements                                                                 */
/* -------------------------------------------------------------------------- */

/** The parser's own statement node. The IR is not this: it is what the node lowers to. */
type Stmt =
  | { kind: "declare"; name: string; typeText: string | null; init: NimExpr | null; line: number }
  | { kind: "loop"; variable: string; from: NimExpr; to: NimExpr; exclusive: boolean; body: Stmt[]; line: number }
  | { kind: "assign"; target: string; op: "=" | "+=" | "*=" | "-="; value: NimExpr; line: number }
  | { kind: "result"; value: NimExpr; line: number }
  | { kind: "indexAssign"; base: string; index: NimExpr; value: NimExpr; line: number };

/* -------------------------------------------------------------------------- */
/* Lowering                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The Nim AST is what the parser reads; the IR is what the compiler compiles.
 * A parsed proc is lowered into the same statements and expressions every
 * other frontend produces, so there is one semantic IR in this compiler rather
 * than one per source language, and the resolvers, validators and backends
 * downstream read a Nim proc exactly as they read a TypeScript one.
 *
 * A Nim proc is a smaller language than the one the IR describes — a proc
 * assigns a result, loops over a range, and does little else — so the lowering
 * is a total mapping rather than a translation, and nothing here decides
 * anything the AST has already decided.
 */

/** The value a Nim local holds before it is written, which is one rule for both readers. */
function zeroLiteral(type: TypeExpr | null, statement: Stmt & { kind: "declare" }): string {
  if (type === null) {
    throw frontendError(`cannot infer the initial value of "${statement.name}" (line ${statement.line})`, "add an explicit initialiser");
  }
  // The contract language has no `f32` suffix: a float is written as the
  // number it denotes, and zero is the one value every float width holds
  // exactly, so the width the declaration names does not reach the text.
  // The Nim spelling `0.0'f32` is source syntax, and the contract tokenizer
  // has no operator that starts with `'`, so a proc declaring a float
  // without an initialiser could not be contracted at all.
  if (type.kind === "primitive" && isFloatType(type.name)) return "0.0";
  if (type.kind === "primitive") return "0";
  throw frontendError(`variables of type ${typeToString(type)} are not supported (line ${statement.line})`);
}

/** One Nim expression, as the IR writes it. */
function nimExpression(expression: NimExpr): Expression {
  switch (expression.k) {
    case "literal":
      return { k: "literal", text: expression.text };
    case "ident":
      return { k: "ident", name: expression.name };
    case "index":
      return { k: "index", base: nimExpression(expression.base), index: nimExpression(expression.index) };
    case "binary":
      return { k: "binary", op: expression.op, left: nimExpression(expression.left), right: nimExpression(expression.right) };
    case "negate":
      return { k: "unary", op: "-", operand: nimExpression(expression.operand) };
  }
}

/** Every statement a proc body runs, as the IR writes them. */
function nimStatements(statements: readonly Stmt[]): Statement[] {
  return statements.map((statement): Statement => {
    switch (statement.kind) {
      case "declare": {
        const type = statement.typeText === null ? null : mapNimType(statement.typeText, `line ${statement.line}`);
        return {
          kind: "declare",
          name: statement.name,
          type,
          init:
            statement.init === null
              ? { k: "literal", text: zeroLiteral(type, statement) }
              : nimExpression(statement.init),
          line: statement.line,
        };
      }
      case "loop":
        return {
          kind: "loop",
          variable: statement.variable,
          from: nimExpression(statement.from),
          to: nimExpression(statement.to),
          inclusive: !statement.exclusive,
          step: null,
          down: false,
          body: nimStatements(statement.body),
          line: statement.line,
        };
      case "assign":
        return { kind: "assign", target: statement.target, op: statement.op, value: nimExpression(statement.value), line: statement.line };
      case "result":
        return { kind: "result", value: nimExpression(statement.value), line: statement.line };
      case "indexAssign":
        return {
          kind: "indexAssign",
          buffer: statement.base,
          index: nimExpression(statement.index),
          value: nimExpression(statement.value),
          line: statement.line,
        };
    }
  });
}

interface SourceLine {
  number: number;
  indent: number;
  text: string;
}

function toSourceLines(source: string): SourceLine[] {
  return source
    .split(/\r?\n/)
    .map((raw, index) => {
      const withoutComment = raw.replace(/#.*$/, "");
      const expanded = withoutComment.replace(/\t/g, "  ");
      if (expanded.trim() === "") return null;
      return { number: index + 1, indent: expanded.length - expanded.trimStart().length, text: expanded.trim() };
    })
    .filter((line): line is SourceLine => line !== null);
}

/**
 * The block starting at `start`: the run of lines indented at least as far as
 * the first, stopping where the source dedents out of it. Selecting every
 * later line that is indented enough instead reaches across a dedent and welds
 * the next construct's body onto this one, so a second block-bodied proc is
 * swallowed into the first and never declared at all.
 */
function blockAt(lines: SourceLine[], start: number): SourceLine[] {
  const first = lines[start];
  if (first === undefined) return [];
  const block: SourceLine[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const entry = lines[index];
    if (entry.indent < first.indent) break;
    block.push(entry);
  }
  return block;
}


function parseStatement(line: SourceLine, following: SourceLine[]): Stmt {
  const context = `line ${line.number}`;
  const declaration = /^(var|let)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*([^=]+?))?\s*(?:=\s*(.+))?$/.exec(line.text);
  if (declaration !== null) {
    const [, , name, typeText, init] = declaration;
    if (init === undefined) return { kind: "declare", name, typeText: typeText?.trim() ?? null, init: null, line: line.number };
    return {
      kind: "declare",
      name,
      typeText: typeText?.trim() ?? null,
      init: parseNimExpression(init, context),
      line: line.number,
    };
  }

  const loop = /^for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+(.+?)\s*(\.\.<|\.\.)\s*(.+?):$/.exec(line.text);
  if (loop !== null) {
    const [, variable, fromText, operator, toText] = loop;
    const bodyIndent = following[0]?.indent;
    if (bodyIndent === undefined || bodyIndent <= line.indent) {
      throw frontendError(`empty loop body at line ${line.number}`, "a for loop must contain at least one statement");
    }
    const body = blockAt(following, 0);
    return {
      kind: "loop",
      variable,
      from: parseNimExpression(fromText, context),
      to: parseNimExpression(toText, context),
      exclusive: operator === "..<",
      body: parseBlock(body),
      line: line.number,
    };
  }

  const controlFlow = /^(if|elif|else|while|case|of|break|continue|discard|raise|defer|try|except|yield)\b/.exec(line.text);
  if (controlFlow !== null) {
    throw frontendError(
      `"${controlFlow[1]}" is not supported (line ${line.number})`,
      "the frontend only accepts declarations, counted loops, assignments and result expressions",
    );
  }

  const returned = /^(?:result|return)\s*=\s*(.+)$/.exec(line.text) ?? /^return\s+(.+)$/.exec(line.text);
  if (returned !== null) return { kind: "result", value: parseNimExpression(returned[1], context), line: line.number };

  const indexed = /^([A-Za-z_][A-Za-z0-9_]*)\[\s*(.+?)\s*\]\s*=\s*(.+)$/.exec(line.text);
  if (indexed !== null) {
    return {
      kind: "indexAssign",
      base: indexed[1],
      index: parseNimExpression(indexed[2], context),
      value: parseNimExpression(indexed[3], context),
      line: line.number,
    };
  }

  const assignment = /^([A-Za-z_][A-Za-z0-9_]*)\s*(\+=|-=|\*=|=)\s*(.+)$/.exec(line.text);
  if (assignment !== null) {
    const [, target, operator, value] = assignment;
    return {
      kind: "assign",
      target,
      op: operator as "=" | "+=" | "*=" | "-=",
      value: parseNimExpression(value, context),
      line: line.number,
    };
  }

  if (/^proc\b|^func\b|^iterator\b|^template\b|^import\b|^type\b|^const\b|^var\b|^let\b/.test(line.text)) {
    throw frontendError(`unsupported declaration at line ${line.number}`, "the frontend accepts pure procedures only");
  }

  return { kind: "result", value: parseNimExpression(line.text, context), line: line.number };
}

function parseBlock(lines: SourceLine[]): Stmt[] {
  const statements: Stmt[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const statement = parseStatement(line, lines.slice(index + 1));
    statements.push(statement);
    index += statement.kind === "loop" ? 1 + statement.body.length : 1;
  }
  return statements;
}

/* -------------------------------------------------------------------------- */
/* Procedures                                                                 */
/* -------------------------------------------------------------------------- */

interface NimProc {
  name: string;
  params: { name: string; type: TypeExpr; line: number }[];
  returns: TypeExpr;
  body: Stmt[];
  line: number;
}

function parseProcedures(source: string): NimProc[] {
  const lines = toSourceLines(source);
  const procedures: NimProc[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/^proc\b/.test(line.text)) continue;
    const header = line.text.replace(/^proc\s+/, "").replace(/\s*\{[^{}]*\}\s*$/, "");
    const equals = header.indexOf("=");
    if (equals < 0) throw frontendError(`proc at line ${line.number} has no body`);
    const signature = header.slice(0, equals).trim();
    const nameMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:\((.*)\))?\s*(?::\s*(.+))?$/.exec(signature);
    if (nameMatch === null) throw frontendError(`cannot parse proc signature "${signature}"`, `at line ${line.number}`);

    const params: NimProc["params"] = [];
    const parameterList = nameMatch[2];
    if (parameterList !== undefined && parameterList.trim() !== "") {
      for (const piece of splitTopLevel(parameterList, ",")) {
        const parameter = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+)$/.exec(piece.trim());
        if (parameter === null) {
          throw frontendError(`cannot parse parameter "${piece.trim()}"`, `at line ${line.number}; parameters need a type`);
        }
        params.push({
          name: parameter[1],
          type: mapNimType(parameter[2], `line ${line.number}`),
          line: line.number,
        });
      }
    }

    const returnType = (nameMatch[3] ?? "").trim();
    if (returnType === "" || returnType === "void") {
      throw frontendError(`proc ${nameMatch[1]} has no return type`, "the contract needs a defined result");
    }
    // Nim allows an expression body on the header line: `proc f(x: T): T = expr`.
    const expressionBody = header.slice(equals + 1).trim();
    const body: SourceLine[] =
      expressionBody !== ""
        ? [{ number: line.number, indent: line.indent + 2, text: expressionBody }]
        : blockAt(lines, index + 1);
    procedures.push({
      name: nameMatch[1],
      params,
      returns: mapNimType(returnType, `line ${line.number}`),
      body: parseBlock(body),
      line: line.number,
    });
    index += expressionBody === "" ? body.length : 0;
  }

  return procedures;
}

function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of text) {
    if (character === "(" || character === "[" || character === "{") depth += 1;
    if (character === ")" || character === "]" || character === "}") depth -= 1;
    if (character === separator && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts;
}

/* -------------------------------------------------------------------------- */
/* Body analysis                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The expression a proc body reduces its result to, and every buffer range it
 * reads. A proc that assigns no result is refused rather than carried: the
 * contract phase has to be able to say what the function returns.
 */
class BodyAnalysis {
  private readonly bindings = new Map<string, string>();
  readonly accesses: AccessRange[] = [];
  private result: string | null = null;

  private readonly proc: NimProc;
  private readonly context: string;

  constructor(proc: NimProc, context: string) {
    this.proc = proc;
    this.context = context;
    for (const param of proc.params) this.bindings.set(param.name, param.name);
  }

  run(statements: Stmt[]): { result: string; accesses: AccessRange[] } {
    for (const statement of statements) this.execute(statement, null);
    if (this.result === null) {
      throw frontendError(`proc ${this.proc.name} never assigns a result`, `at ${this.context}`);
    }
    return { result: this.result, accesses: this.accesses };
  }

  private execute(statement: Stmt, loop: LoopContext | null): void {
    switch (statement.kind) {
      case "declare": {
        const type = statement.typeText === null ? null : mapNimType(statement.typeText, `line ${statement.line}`);
        if (statement.init === null) {
          this.bindings.set(statement.name, zeroLiteral(type, statement));
          return;
        }
        this.bindings.set(statement.name, this.serialize(statement.init, loop, statement.line));
        return;
      }
      case "assign": {
        if (statement.op === "-=") {
          throw frontendError(`"-=" is not supported (line ${statement.line})`, "express subtraction inside the accumulated expression instead");
        }
        const value = this.serialize(statement.value, loop, statement.line);
        if (statement.target === "result") {
          this.result = value;
          return;
        }
        if (!this.bindings.has(statement.target)) {
          throw frontendError(`assignment to undeclared "${statement.target}" (line ${statement.line})`);
        }
        const current = this.bindings.get(statement.target) as string;
        this.bindings.set(statement.target, statement.op === "=" ? value : `(${current} ${statement.op[0]} ${value})`);
        return;
      }
      case "result": {
        this.result = this.serialize(statement.value, loop, statement.line);
        return;
      }
      case "loop": {
        this.executeLoop(statement);
        return;
      }
      case "indexAssign":
        throw frontendError(
          `writing through "${statement.base}[...]" is not supported (line ${statement.line})`,
          "version 0.1 accepts pure functions; the contract would have to describe the write",
        );
    }
  }

  private executeLoop(statement: Stmt & { kind: "loop" }): void {
    if (statement.body.length !== 1) {
      throw frontendError(
        `loop body at line ${statement.line} must contain exactly one statement`,
        "version 0.1 supports accumulator loops, if/while and early returns are rejected",
      );
    }
    const inner = statement.body[0];
    if (inner.kind === "indexAssign") {
      throw frontendError(
        `writing through "${inner.base}[...]" is not supported (line ${inner.line})`,
        "version 0.1 accepts pure functions; the contract would have to describe the write",
      );
    }
    if (inner.kind !== "assign") {
      throw frontendError(`loop body at line ${statement.line} must accumulate into a variable`, "expected `acc += ...`");
    }
    // Only `+=` and `*=` are reductions. An allowlist and not a denylist: `=`
    // is an assignment that happens to be written in a loop, and reading it as
    // a sum states a contract the body does not implement.
    if (inner.op !== "+=" && inner.op !== "*=") {
      throw frontendError(`"${inner.op}" inside a loop is not supported (line ${inner.line})`);
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
    const loopContext: LoopContext = {
      variable: statement.variable,
      lo: from,
      hiExclusive: statement.exclusive ? to : `(${to} + 1)`,
    };

    // The reduction keeps the loop's own range: `..<` stays half-open, so an
    // empty range is empty instead of wrapping around an unsigned bound.
    const rangeOperator = statement.exclusive ? "..<" : "..";
    const reduceOperator = inner.op === "*=" ? "product" : "sum";
    const body = this.serialize(inner.value, loopContext, inner.line);
    const reduce = `${reduceOperator}(${statement.variable} = ${from}${rangeOperator}${to}, ${body})`;

    if (inner.target === "result") {
      this.result = this.withInitial(this.result, reduce, inner.op === "*=" ? "*" : "+");
      return;
    }
    if (!this.bindings.has(inner.target)) {
      throw frontendError(`loop accumulates into undeclared "${inner.target}" (line ${inner.line})`);
    }
    const current = this.bindings.get(inner.target) as string;
    this.bindings.set(inner.target, this.withInitial(current, reduce, inner.op === "*=" ? "*" : "+"));
  }

  /**
   * Folds an accumulator's initial value into its reduction. A neutral
   * initialiser is dropped so the contract stays readable; anything else is
   * composed, which is what makes a second loop over the same accumulator
   * expressible at all.
   */
  private withInitial(initial: string | null, reduce: string, operator: "+" | "*"): string {
    if (initial === null) return reduce;
    const neutral = operator === "+" ? ["0", "0.0"] : ["1", "1.0"];
    if (neutral.includes(initial)) return reduce;
    return `(${initial} ${operator} ${reduce})`;
  }


  private serialize(expression: NimExpr, loop: LoopContext | null, line: number): string {
    switch (expression.k) {
      case "literal":
        return expression.text;
      case "ident": {
        if (loop !== null && expression.name === loop.variable) return expression.name;
        const bound = this.bindings.get(expression.name);
        if (bound === undefined) {
          throw frontendError(`unknown identifier "${expression.name}" (line ${line})`, "the frontend requires an explicit initialiser for every local");
        }
        return bound;
      }
      case "negate":
        return `(-${this.serialize(expression.operand, loop, line)})`;
      case "binary":
        return `(${this.serialize(expression.left, loop, line)} ${expression.op} ${this.serialize(expression.right, loop, line)})`;
      case "index": {
        if (expression.base.k !== "ident") {
          throw frontendError(`only single level indexing is supported (line ${line})`);
        }
        const base = expression.base;
        const parameter = this.proc.params.find((param) => param.name === base.name);
        if (parameter === undefined) {
          throw frontendError(`indexing unknown parameter "${expression.base.name}" (line ${line})`);
        }
        const indexText = this.serialize(expression.index, loop, line);
        if (loop !== null && dependsOn(expression.index, loop.variable)) {
          if (expression.index.k !== "ident") {
            throw frontendError(
              `unsupported access pattern ${typeToString(parameter.type)} at line ${line}`,
              `the index must be the loop variable "${loop.variable}" to describe the accessed range`,
            );
          }
          this.accesses.push({ parameter: parameter.name, lo: loop.lo, hi: loop.hiExclusive });
        } else {
          this.accesses.push({ parameter: parameter.name, lo: indexText, hi: `(${indexText} + 1)` });
        }
        return `${parameter.name}[${indexText}]`;
      }
    }
  }
}

interface LoopContext {
  variable: string;
  lo: string;
  hiExclusive: string;
}

function dependsOn(expression: NimExpr, name: string): boolean {
  switch (expression.k) {
    case "ident":
      return expression.name === name;
    case "literal":
      return false;
    case "negate":
      return dependsOn(expression.operand, name);
    case "binary":
      return dependsOn(expression.left, name) || dependsOn(expression.right, name);
    case "index":
      return dependsOn(expression.base, name) || dependsOn(expression.index, name);
  }
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

export const nimFrontend: Frontend = {
  analyze(source, path) {
    if (typeof source !== "string" || source.trim() === "") {
      throw frontendError(`module ${path} is empty`);
    }
    const functions = parseProcedures(source).map((procedure) => ({
      name: procedure.name,
      // Every top level proc of a Nim module is part of its interface.
      exported: true,
      params: procedure.params.map((param) => ({ name: param.name, type: param.type })),
      returns: procedure.returns,
      handle: procedure,
    }));
    if (functions.length === 0) {
      throw frontendError(`no proc found in ${path}`, "a module declares pure procs");
    }
    // A Nim module of this compiler is a library of procs: nothing in it runs.
    return { path, imports: parseImports(source), functions, body: [] };
  },

  contractFor(analysis, declared, input) {
    const procedure = declared.handle as NimProc;
    const body = new BodyAnalysis(procedure, `${analysis.path}: proc ${procedure.name}`).run(procedure.body);
    // A proc is a library function, so it allocates nothing, prints nothing and
    // reads no command line: what it does beyond computing its result is
    // nothing, whatever the reduction says it returns.
    return assembleContract({
      name: procedure.name,
      params: procedure.params.map((param) => ({ name: param.name, type: param.type })),
      returns: procedure.returns,
      result: body.result,
      accesses: body.accesses,
      definition: {
        statements: nimStatements(procedure.body),
        allocates: false,
        prints: false,
        readsArgv: false,
      },
      input,
    });
  },

  resolveImport(specifier) {
    if (!specifier.startsWith(".")) {
      throw frontendError(
        `cannot import "${specifier}"`,
        "a module imports project modules by relative path, as in `import ./other`",
      );
    }
    return [specifier.endsWith(".nim") ? specifier : `${specifier}.nim`];
  },
};

export function frontendFor(language: string): Frontend {
  const name = language.toLowerCase();
  if (name === "nim") return nimFrontend;
  if (name === "typescript" || name === "ts") return typeScriptFrontend;
  throw frontendError(`unsupported language "${language}"`, "supported languages: nim, typescript");
}

/* -------------------------------------------------------------------------- */
/* Imports                                                                    */
/* -------------------------------------------------------------------------- */

/** `import ./other` and `include ./other` name another file of the project. */
function parseImports(source: string): ModuleImport[] {
  const imports: ModuleImport[] = [];
  for (const line of toSourceLines(source)) {
    const match = /^(?:import|include)\s+(.+)$/.exec(line.text);
    if (match === null) continue;
    for (const piece of match[1].split(",")) {
      const specifier = piece.trim().replace(/^['"]|['"]$/g, "").split(/\s+/)[0];
      // An unqualified import brings every export of the module into scope.
      imports.push({ specifier, names: null, line: line.number });
    }
  }
  return imports;
}

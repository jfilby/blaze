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
import { pythonFrontend } from "./python.ts";
import type { Frontend, ModuleImport } from "./module.ts";
import type { AssignOperator, BinaryOp, Expression, Statement } from "../core/ir.ts";
import type { PrimitiveTypeName, TypeExpr } from "../core/types.ts";

function fieldOf(value: unknown, key: string): any {
  return (value as Record<string, unknown>)[key];
}

function setFieldOn(value: unknown, key: string, next: unknown): void {
  (value as Record<string, unknown>)[key] = next;
}

function frontendError(message: string, detail?: string): CompilerError {
  return new CompilerError("FrontendError", "frontend", message, detail, "", "", "");
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
  readonly tokens: ExprToken[];
  readonly source: string;
  readonly context: string;
  position = 0;

  constructor(source: string, context: string) {
    this.source = source;
    this.context = context;
    this.tokens = tokenizeExpression(source, context);
  }

  read(): NimExpr {
    const expression = this.readAdditive();
    const trailing = this.peek();
    if (String(fieldOf(trailing, "kind")) !== "end") this.fail(`unexpected "${String(fieldOf(trailing, "text"))}"`);
    return expression;
  }

  private peek(): ExprToken {
    return (fieldOf(this, "tokens") as readonly ExprToken[])[Number(fieldOf(this, "position"))];
  }

  /** One token further, which every reader of a token advances by. */
  private advance(): void {
    setFieldOn(this, "position", Number(fieldOf(this, "position")) + 1);
  }

  private fail(message: string): never {
    throw frontendError(`${message} in "${String(fieldOf(this, "source"))}"`, `at ${String(fieldOf(this, "context"))}`);
  }

  private readAdditive(): NimExpr {
    let left = this.readMultiplicative();
    for (;;) {
      const token = this.peek();
      const kind = String(fieldOf(token, "kind"));
      const text = String(fieldOf(token, "text"));
      if (kind !== "op" || (text !== "+" && text !== "-")) return left;
      this.advance();
      left = { k: "binary", op: text as "+" | "-", left, right: this.readMultiplicative() };
    }
  }

  private readMultiplicative(): NimExpr {
    let left = this.readUnary();
    for (;;) {
      const token = this.peek();
      const kind = String(fieldOf(token, "kind"));
      const text = String(fieldOf(token, "text"));
      if (kind !== "op" || (text !== "*" && text !== "/")) return left;
      this.advance();
      left = { k: "binary", op: text as "*" | "/", left, right: this.readUnary() };
    }
  }

  private readUnary(): NimExpr {
    const token = this.peek();
    const kind = String(fieldOf(token, "kind"));
    const text = String(fieldOf(token, "text"));
    if (kind === "op" && text === "-") {
      this.advance();
      return { k: "negate", operand: this.readUnary() };
    }
    if (kind === "op" && text === "+") {
      this.advance();
      return this.readUnary();
    }
    return this.readPostfix();
  }

  private readPostfix(): NimExpr {
    let base = this.readPrimary();
    while (String(fieldOf(this.peek(), "kind")) === "op" && String(fieldOf(this.peek(), "text")) === "[") {
      this.advance();
      const index = this.readAdditive();
      const closing = this.peek();
      if (String(fieldOf(closing, "kind")) !== "op" || String(fieldOf(closing, "text")) !== "]") this.fail('expected "]"');
      this.advance();
      base = { k: "index", base, index };
    }
    return base;
  }

  private readPrimary(): NimExpr {
    const tokens = fieldOf(this, "tokens") as readonly ExprToken[];
    const at = Number(fieldOf(this, "position"));
    setFieldOn(this, "position", at + 1);
    const token = tokens[at];
    if (token === undefined) this.fail("unexpected end of expression");
    const kind = String(fieldOf(token, "kind"));
    const text = String(fieldOf(token, "text"));
    if (kind === "number") return { k: "literal", text };
    if (kind === "ident") return { k: "ident", name: text };
    if (kind === "op" && text === "(") {
      const inner = this.readAdditive();
      const closing = this.peek();
      if (String(fieldOf(closing, "kind")) !== "op" || String(fieldOf(closing, "text")) !== ")") this.fail('expected ")"');
      this.advance();
      return inner;
    }
    this.fail(`unexpected "${text}"`);
  }
}

function tokenizeExpression(source: string, context: string): ExprToken[] {
  const tokens: ExprToken[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source.slice(index, index + 1);
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (/[0-9]/.test(character) || (character === "." && /[0-9]/.test(source.slice(index + 1, index + 2)))) {
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
  const name = String(fieldOf(statement, "name"));
  const line = Number(fieldOf(statement, "line"));
  if (type === null) {
    throw frontendError(`cannot infer the initial value of "${name}" (line ${line})`, "add an explicit initialiser");
  }
  // The contract language has no `f32` suffix: a float is written as the
  // number it denotes, and zero is the one value every float width holds
  // exactly, so the width the declaration names does not reach the text.
  // The Nim spelling `0.0'f32` is source syntax, and the contract tokenizer
  // has no operator that starts with `'`, so a proc declaring a float
  // without an initialiser could not be contracted at all.
  if (String(fieldOf(type, "kind")) === "primitive" && isFloatType(String(fieldOf(type, "name")) as PrimitiveTypeName)) return "0.0";
  if (String(fieldOf(type, "kind")) === "primitive") return "0";
  throw frontendError(`variables of type ${typeToString(type)} are not supported (line ${line})`);
}

/** One Nim expression, as the IR writes it. */
function nimExpression(expression: NimExpr): Expression {
  switch (String(fieldOf(expression, "k")) as NimExpr["k"]) {
    case "literal":
      return { k: "literal", text: String(fieldOf(expression, "text")) };
    case "ident":
      return { k: "ident", name: String(fieldOf(expression, "name")) };
    case "index":
      return { k: "index", base: nimExpression(fieldOf(expression, "base") as NimExpr), index: nimExpression(fieldOf(expression, "index") as NimExpr) };
    case "binary":
      return { k: "binary", op: String(fieldOf(expression, "op")) as BinaryOp, left: nimExpression(fieldOf(expression, "left") as NimExpr), right: nimExpression(fieldOf(expression, "right") as NimExpr) };
    case "negate":
      return { k: "unary", op: "-", operand: nimExpression(fieldOf(expression, "operand") as NimExpr) };
  }
}

/** Every statement a proc body runs, as the IR writes them. */
function nimStatements(statements: readonly Stmt[]): Statement[] {
  return statements.map((statement): Statement => {
    switch (String(fieldOf(statement, "kind")) as Stmt["kind"]) {
      case "declare": {
        const typeText = fieldOf(statement, "typeText") as string | null;
        const line = Number(fieldOf(statement, "line"));
        const type = typeText === null ? null : mapNimType(typeText, `line ${line}`);
        const init = fieldOf(statement, "init") as NimExpr | null;
        return {
          kind: "declare",
          name: String(fieldOf(statement, "name")),
          type,
          init:
            init === null
              ? { k: "literal", text: zeroLiteral(type, statement as Stmt & { kind: "declare" }) }
              : nimExpression(init),
          line,
        };
      }
      case "loop":
        return {
          kind: "loop",
          variable: String(fieldOf(statement, "variable")),
          from: nimExpression(fieldOf(statement, "from") as NimExpr),
          to: nimExpression(fieldOf(statement, "to") as NimExpr),
          inclusive: fieldOf(statement, "exclusive") !== true,
          step: null,
          down: false,
          body: nimStatements(fieldOf(statement, "body") as readonly Stmt[]),
          line: Number(fieldOf(statement, "line")),
        };
      case "assign":
        return { kind: "assign", target: String(fieldOf(statement, "target")), op: String(fieldOf(statement, "op")) as AssignOperator, value: nimExpression(fieldOf(statement, "value") as NimExpr), line: Number(fieldOf(statement, "line")) };
      case "result":
        return { kind: "result", value: nimExpression(fieldOf(statement, "value") as NimExpr), line: Number(fieldOf(statement, "line")) };
      case "indexAssign":
        return {
          kind: "indexAssign",
          buffer: String(fieldOf(statement, "base")),
          index: nimExpression(fieldOf(statement, "index") as NimExpr),
          op: "=",
          value: nimExpression(fieldOf(statement, "value") as NimExpr),
          line: Number(fieldOf(statement, "line")),
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
    if (Number(fieldOf(entry, "indent")) < Number(fieldOf(first, "indent"))) break;
    block.push(entry);
  }
  return block;
}


function parseStatement(line: SourceLine, following: SourceLine[]): Stmt {
  const lineNumber = Number(fieldOf(line, "number"));
  const lineIndent = Number(fieldOf(line, "indent"));
  const text = String(fieldOf(line, "text"));
  const context = `line ${lineNumber}`;
  const declaration = /^(var|let)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*([^=]+?))?\s*(?:=\s*(.+))?$/.exec(text);
  if (declaration !== null) {
    const [, , name, typeText, init] = declaration;
    if (init === undefined) return { kind: "declare", name, typeText: typeText?.trim() ?? null, init: null, line: lineNumber };
    return {
      kind: "declare",
      name,
      typeText: typeText?.trim() ?? null,
      init: parseNimExpression(init, context),
      line: lineNumber,
    };
  }

  const loop = /^for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+(.+?)\s*(\.\.<|\.\.)\s*(.+?):$/.exec(text);
  if (loop !== null) {
    const [, variable, fromText, operator, toText] = loop;
    const first = following[0];
    const bodyIndent = first === undefined ? undefined : Number(fieldOf(first, "indent"));
    if (bodyIndent === undefined || bodyIndent <= lineIndent) {
      throw frontendError(`empty loop body at line ${lineNumber}`, "a for loop must contain at least one statement");
    }
    const body = blockAt(following, 0);
    return {
      kind: "loop",
      variable,
      from: parseNimExpression(fromText, context),
      to: parseNimExpression(toText, context),
      exclusive: operator === "..<",
      body: parseBlock(body),
      line: lineNumber,
    };
  }

  const controlFlow = /^(if|elif|else|while|case|of|break|continue|discard|raise|defer|try|except|yield)\b/.exec(text);
  if (controlFlow !== null) {
    throw frontendError(
      `"${controlFlow[1]}" is not supported (line ${lineNumber})`,
      "the frontend only accepts declarations, counted loops, assignments and result expressions",
    );
  }

  const returned = /^(?:result|return)\s*=\s*(.+)$/.exec(text) ?? /^return\s+(.+)$/.exec(text);
  if (returned !== null) return { kind: "result", value: parseNimExpression(returned[1], context), line: lineNumber };

  const indexed = /^([A-Za-z_][A-Za-z0-9_]*)\[\s*(.+?)\s*\]\s*=\s*(.+)$/.exec(text);
  if (indexed !== null) {
    return {
      kind: "indexAssign",
      base: indexed[1],
      index: parseNimExpression(indexed[2], context),
      value: parseNimExpression(indexed[3], context),
      line: lineNumber,
    };
  }

  const assignment = /^([A-Za-z_][A-Za-z0-9_]*)\s*(\+=|-=|\*=|=)\s*(.+)$/.exec(text);
  if (assignment !== null) {
    const [, target, operator, value] = assignment;
    return {
      kind: "assign",
      target,
      op: operator as "=" | "+=" | "*=" | "-=",
      value: parseNimExpression(value, context),
      line: lineNumber,
    };
  }

  if (/^proc\b|^func\b|^iterator\b|^template\b|^import\b|^type\b|^const\b|^var\b|^let\b/.test(text)) {
    throw frontendError(`unsupported declaration at line ${lineNumber}`, "the frontend accepts pure procedures only");
  }

  return { kind: "result", value: parseNimExpression(text, context), line: lineNumber };
}

function parseBlock(lines: SourceLine[]): Stmt[] {
  const statements: Stmt[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const statement = parseStatement(line, lines.slice(index + 1));
    statements.push(statement);
    index += String(fieldOf(statement, "kind")) === "loop" ? 1 + (fieldOf(statement, "body") as readonly Stmt[]).length : 1;
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
    const lineText = String(fieldOf(line, "text"));
    if (!/^proc\b/.test(lineText)) continue;
    const lineNumber = Number(fieldOf(line, "number"));
    const lineIndent = Number(fieldOf(line, "indent"));
    const header = lineText.replace(/^proc\s+/, "").replace(/\s*\{[^{}]*\}\s*$/, "");
    const equals = header.indexOf("=");
    if (equals < 0) throw frontendError(`proc at line ${lineNumber} has no body`);
    const signature = header.slice(0, equals).trim();
    const nameMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:\((.*)\))?\s*(?::\s*(.+))?$/.exec(signature);
    if (nameMatch === null) throw frontendError(`cannot parse proc signature "${signature}"`, `at line ${lineNumber}`);

    const params: NimProc["params"] = [];
    const parameterList = nameMatch[2];
    if (parameterList !== undefined && parameterList.trim() !== "") {
      for (const piece of splitTopLevel(parameterList, ",")) {
        const parameter = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+)$/.exec(piece.trim());
        if (parameter === null) {
          throw frontendError(`cannot parse parameter "${piece.trim()}"`, `at line ${lineNumber}; parameters need a type`);
        }
        params.push({
          name: parameter[1],
          type: mapNimType(parameter[2], `line ${lineNumber}`),
          line: lineNumber,
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
        ? [{ number: lineNumber, indent: lineIndent + 2, text: expressionBody }]
        : blockAt(lines, index + 1);
    procedures.push({
      name: nameMatch[1],
      params,
      returns: mapNimType(returnType, `line ${lineNumber}`),
      body: parseBlock(body),
      line: lineNumber,
    });
    index += expressionBody === "" ? body.length : 0;
  }

  return procedures;
}

function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (let at = 0; at < text.length; at += 1) {
    const character = text.slice(at, at + 1);
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
  readonly bindings = new Map<string, string>();
  readonly accesses: AccessRange[] = [];
  result: string | null = null;

  readonly proc: NimProc;
  readonly context: string;

  constructor(proc: NimProc, context: string) {
    this.proc = proc;
    this.context = context;
    const bindings = fieldOf(this, "bindings") as Map<string, string>;
    for (const param of fieldOf(proc, "params") as readonly { readonly name: string }[]) bindings.set(String(fieldOf(param, "name")), String(fieldOf(param, "name")));
  }

  run(statements: Stmt[]): { result: string; accesses: AccessRange[] } {
    for (const statement of statements) this.execute(statement, null);
    const result = fieldOf(this, "result") as string | null;
    if (result === null) {
      throw frontendError(`proc ${String(fieldOf(fieldOf(this, "proc"), "name"))} never assigns a result`, `at ${String(fieldOf(this, "context"))}`);
    }
    return { result, accesses: fieldOf(this, "accesses") as AccessRange[] };
  }

  private execute(statement: Stmt, loop: LoopContext | null): void {
    const bindings = fieldOf(this, "bindings") as Map<string, string>;
    switch (String(fieldOf(statement, "kind")) as Stmt["kind"]) {
      case "declare": {
        const declaration = statement as Stmt & { kind: "declare" };
        const typeText = fieldOf(declaration, "typeText") as string | null;
        const lineNumber = Number(fieldOf(declaration, "line"));
        const type = typeText === null ? null : mapNimType(typeText, `line ${lineNumber}`);
        const init = fieldOf(declaration, "init") as NimExpr | null;
        if (init === null) {
          bindings.set(String(fieldOf(declaration, "name")), zeroLiteral(type, declaration));
          return;
        }
        bindings.set(String(fieldOf(declaration, "name")), this.serialize(init, loop, lineNumber));
        return;
      }
      case "assign": {
        const op = String(fieldOf(statement, "op"));
        const lineNumber = Number(fieldOf(statement, "line"));
        if (op === "-=") {
          throw frontendError(`"-=" is not supported (line ${lineNumber})`, "express subtraction inside the accumulated expression instead");
        }
        const value = this.serialize(fieldOf(statement, "value") as NimExpr, loop, lineNumber);
        const target = String(fieldOf(statement, "target"));
        if (target === "result") {
          // The postcondition is the oracle the generated code is proved
          // against, so it has to state what the body computes. `result += x`
          // folds into the accumulator, and reading it as `result = x` states
          // a contract the body does not implement -- which silently accepts
          // any code that returns x. A compound assign before `result` holds
          // anything reduces from the implicit zero, and the sum is x.
          const held = fieldOf(this, "result") as string | null;
          const assigned = op === "=" || held === null
            ? value
            : this.withInitial(held, value, op.slice(0, 1) === "*" ? "*" : "+");
          setFieldOn(this, "result", assigned);
          return;
        }
        if (!bindings.has(target)) {
          throw frontendError(`assignment to undeclared "${target}" (line ${lineNumber})`);
        }
        const current = bindings.get(target) as string;
        bindings.set(target, op === "=" ? value : `(${current} ${op.slice(0, 1)} ${value})`);
        return;
      }
      case "result": {
        setFieldOn(this, "result", this.serialize(fieldOf(statement, "value") as NimExpr, loop, Number(fieldOf(statement, "line"))));
        return;
      }
      case "loop": {
        this.executeLoop(statement as Stmt & { kind: "loop" });
        return;
      }
      case "indexAssign":
        throw frontendError(
          `writing through "${String(fieldOf(statement, "base"))}[...]" is not supported (line ${Number(fieldOf(statement, "line"))})`,
          "version 0.1 accepts pure functions; the contract would have to describe the write",
        );
    }
  }

  private executeLoop(statement: Stmt & { kind: "loop" }): void {
    const body = fieldOf(statement, "body") as readonly Stmt[];
    const line = Number(fieldOf(statement, "line"));
    if (body.length !== 1) {
      throw frontendError(
        `loop body at line ${line} must contain exactly one statement`,
        "version 0.1 supports accumulator loops, if/while and early returns are rejected",
      );
    }
    const inner = body[0];
    if (String(fieldOf(inner, "kind")) === "indexAssign") {
      throw frontendError(
        `writing through "${String(fieldOf(inner, "base"))}[...]" is not supported (line ${Number(fieldOf(inner, "line"))})`,
        "version 0.1 accepts pure functions; the contract would have to describe the write",
      );
    }
    if (String(fieldOf(inner, "kind")) !== "assign") {
      throw frontendError(`loop body at line ${line} must accumulate into a variable`, "expected `acc += ...`");
    }
    // Only `+=` and `*=` are reductions. An allowlist and not a denylist: `=`
    // is an assignment that happens to be written in a loop, and reading it as
    // a sum states a contract the body does not implement.
    const innerOp = String(fieldOf(inner, "op"));
    const innerLine = Number(fieldOf(inner, "line"));
    const target = String(fieldOf(inner, "target"));
    if (innerOp !== "+=" && innerOp !== "*=") {
      throw frontendError(`"${innerOp}" inside a loop is not supported (line ${innerLine})`);
    }

    // A counted loop reads its bound again on every turn, so a body that
    // writes it walks a range no contract can name: the one the reduction
    // states is the bound as it stood before the first turn.
    const bounds: NimExpr[] = [fieldOf(statement, "from") as NimExpr, fieldOf(statement, "to") as NimExpr];
    for (const bound of bounds) {
      if (String(fieldOf(bound, "k")) !== "ident" || String(fieldOf(bound, "name")) !== target) continue;
      throw frontendError(
        `the loop body writes "${target}", the loop's own bound (line ${innerLine})`,
        "a counted loop re-reads its bound on every turn, which a contract cannot state; loop to a bound the body does not write",
      );
    }

    const from = this.serialize(fieldOf(statement, "from") as NimExpr, null, line);
    const to = this.serialize(fieldOf(statement, "to") as NimExpr, null, line);
    const variable = String(fieldOf(statement, "variable"));
    const exclusive = fieldOf(statement, "exclusive") === true;
    const loopContext: LoopContext = {
      variable,
      lo: from,
      hiExclusive: exclusive ? to : `(${to} + 1)`,
    };

    // The reduction keeps the loop's own range: `..<` stays half-open, so an
    // empty range is empty instead of wrapping around an unsigned bound.
    const rangeOperator = exclusive ? "..<" : "..";
    const reduceOperator = innerOp === "*=" ? "product" : "sum";
    const serialized = this.serialize(fieldOf(inner, "value") as NimExpr, loopContext, innerLine);
    const reduce = `${reduceOperator}(${variable} = ${from}${rangeOperator}${to}, ${serialized})`;

    if (target === "result") {
      setFieldOn(this, "result", this.withInitial(fieldOf(this, "result") as string | null, reduce, innerOp === "*=" ? "*" : "+"));
      return;
    }
    const bindings = fieldOf(this, "bindings") as Map<string, string>;
    if (!bindings.has(target)) {
      throw frontendError(`loop accumulates into undeclared "${target}" (line ${innerLine})`);
    }
    const current = bindings.get(target) as string;
    bindings.set(target, this.withInitial(current, reduce, innerOp === "*=" ? "*" : "+"));
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
    switch (String(fieldOf(expression, "k")) as NimExpr["k"]) {
      case "literal":
        return String(fieldOf(expression, "text"));
      case "ident": {
        const name = String(fieldOf(expression, "name"));
        if (loop !== null && name === String(fieldOf(loop, "variable"))) return name;
        const bindings = fieldOf(this, "bindings") as Map<string, string>;
        const bound = bindings.get(name);
        if (bound === undefined) {
          throw frontendError(`unknown identifier "${name}" (line ${line})`, "the frontend requires an explicit initialiser for every local");
        }
        return bound;
      }
      case "negate":
        return `(-${this.serialize(fieldOf(expression, "operand") as NimExpr, loop, line)})`;
      case "binary": {
        const left = this.serialize(fieldOf(expression, "left") as NimExpr, loop, line);
        const right = this.serialize(fieldOf(expression, "right") as NimExpr, loop, line);
        return `(${left} ${String(fieldOf(expression, "op"))} ${right})`;
      }
      case "index": {
        const base = fieldOf(expression, "base") as NimExpr;
        if (String(fieldOf(base, "k")) !== "ident") {
          throw frontendError(`only single level indexing is supported (line ${line})`);
        }
        const baseName = String(fieldOf(base, "name"));
        const params = fieldOf(fieldOf(this, "proc"), "params") as readonly { readonly name: string; readonly type: TypeExpr }[];
        const parameter = params.find((param) => String(fieldOf(param, "name")) === baseName);
        if (parameter === undefined) {
          throw frontendError(`indexing unknown parameter "${baseName}" (line ${line})`);
        }
        const indexExpression = fieldOf(expression, "index") as NimExpr;
        const indexText = this.serialize(indexExpression, loop, line);
        const accesses = fieldOf(this, "accesses") as AccessRange[];
        if (loop !== null && dependsOn(indexExpression, String(fieldOf(loop, "variable")))) {
          if (String(fieldOf(indexExpression, "k")) !== "ident") {
            throw frontendError(
              `unsupported access pattern ${typeToString(fieldOf(parameter, "type") as TypeExpr)} at line ${line}`,
              `the index must be the loop variable "${String(fieldOf(loop, "variable"))}" to describe the accessed range`,
            );
          }
          accesses.push({ parameter: String(fieldOf(parameter, "name")), lo: String(fieldOf(loop, "lo")), hi: String(fieldOf(loop, "hiExclusive")) });
        } else {
          accesses.push({ parameter: String(fieldOf(parameter, "name")), lo: indexText, hi: `(${indexText} + 1)` });
        }
        return `${String(fieldOf(parameter, "name"))}[${indexText}]`;
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
  switch (String(fieldOf(expression, "k")) as NimExpr["k"]) {
    case "ident":
      return String(fieldOf(expression, "name")) === name;
    case "literal":
      return false;
    case "negate":
      return dependsOn(fieldOf(expression, "operand") as NimExpr, name);
    case "binary":
      return dependsOn(fieldOf(expression, "left") as NimExpr, name) || dependsOn(fieldOf(expression, "right") as NimExpr, name);
    case "index":
      return dependsOn(fieldOf(expression, "base") as NimExpr, name) || dependsOn(fieldOf(expression, "index") as NimExpr, name);
  }
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

export const nimFrontend: Frontend = {
  analyze(source, path, _entry = true) {
    if (typeof source !== "string" || source.trim() === "") {
      throw frontendError(`module ${path} is empty`);
    }
    const functions = [];
    for (const procedure of parseProcedures(source)) {
      const params = [];
      for (const param of fieldOf(procedure, "params") as readonly { readonly name: string; readonly type: TypeExpr }[]) {
        params.push({ name: String(fieldOf(param, "name")), type: fieldOf(param, "type") as TypeExpr });
      }
      functions.push({
        name: String(fieldOf(procedure, "name")),
        // Every top level proc of a Nim module is part of its interface.
        exported: true,
        params,
        returns: fieldOf(procedure, "returns") as TypeExpr,
        handle: procedure,
      });
    }
    if (functions.length === 0) {
      throw frontendError(`no proc found in ${path}`, "a module declares pure procs");
    }
    // A Nim module of this compiler is a library of procs: nothing in it runs.
    // Nim has no default export: every proc of a module is part of its
    // interface, so `import f from "./other.nim"` has nothing to bind to here.
    return { path, imports: parseImports(source), functions, default: null, body: [] };
  },

  contractFor(analysis, declared, input) {
    const procedure = fieldOf(declared, "handle") as NimProc;
    const procedureName = String(fieldOf(procedure, "name"));
    const body = new BodyAnalysis(procedure, `${String(fieldOf(analysis, "path"))}: proc ${procedureName}`).run(fieldOf(procedure, "body") as Stmt[]);
    const params = [];
    for (const param of fieldOf(procedure, "params") as readonly { readonly name: string; readonly type: TypeExpr }[]) {
      params.push({ name: String(fieldOf(param, "name")), type: fieldOf(param, "type") as TypeExpr });
    }
    // A proc is a library function, so it allocates nothing, prints nothing and
    // reads no command line: what it does beyond computing its result is
    // nothing, whatever the reduction says it returns.
    return assembleContract({
      name: procedureName,
      params,
      returns: fieldOf(procedure, "returns") as TypeExpr,
      result: String(fieldOf(body, "result")),
      accesses: fieldOf(body, "accesses") as AccessRange[],
      definition: {
        statements: nimStatements(fieldOf(procedure, "body") as Stmt[]),
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
  if (name === "python" || name === "py") return pythonFrontend;
  throw frontendError(`unsupported language "${language}"`, "supported languages: nim, typescript, python");
}

/* -------------------------------------------------------------------------- */
/* Imports                                                                    */
/* -------------------------------------------------------------------------- */

/** `import ./other` and `include ./other` name another file of the project. */
function parseImports(source: string): ModuleImport[] {
  const imports: ModuleImport[] = [];
  for (const line of toSourceLines(source)) {
    const match = /^(?:import|include)\s+(.+)$/.exec(String(fieldOf(line, "text")));
    if (match === null) continue;
    for (const piece of match[1].split(",")) {
      const specifier = piece.trim().replace(/^['"]|['"]$/g, "").split(/\s+/)[0];
      // An unqualified import brings every export of the module into scope.
      imports.push({ specifier, names: null, default: false, line: Number(fieldOf(line, "number")) });
    }
  }
  return imports;
}

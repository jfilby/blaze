/**
 * Frontend: TypeScript -> Native Function Contract.
 *
 * The contract is language neutral, so a second frontend is a parser and an
 * analysis, nothing more. This one accepts the pure subset of TypeScript that
 * a numeric kernel is written in:
 *
 *   export function name(a: Float64Array, b: Float64Array): number {
 *     let total = 0;
 *     for (let i = 0; i < a.length; i++) {
 *       total += a[i] * b[i];
 *     }
 *     return total;
 *   }
 *
 *   - declarations: function, with a block body or an expression body
 *   - statements: let/const with a literal initialiser, counted for loops,
 *     assignments, compound assignments, return
 *   - expressions: number and bigint literals, identifiers, indexing,
 *     `.length` of a typed array, + - * / and parentheses
 *   - types: number, bigint, boolean and the typed array views
 *   - pure functions only: writing into a view is rejected, so every accepted
 *     contract has effects: [] and writes: []
 */

import { parseType, typeToString } from "./contract.ts";
import { assembleContract, type AccessRange } from "./contract-build.ts";
import { CompilerError } from "../core/errors.ts";
import type { FunctionContract, SourceInput, TypeExpr } from "../core/types.ts";
import type { Frontend } from "./frontend.ts";

function frontendError(message: string, detail?: string): CompilerError {
  return new CompilerError({ category: "FrontendError", stage: "frontend", message, detail });
}

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
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

/** Maps a TypeScript type annotation onto a contract type. */
function mapTypeScriptType(text: string, position: string): TypeExpr {
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

type TokenKind = "number" | "bigint" | "ident" | "punct" | "string" | "end";

interface Token {
  kind: TokenKind;
  text: string;
  line: number;
}

const PUNCTUATION = ["=>", "===", "!==", "==", "!=", "<=", ">=", "&&", "||", "++", "--", "+=", "-=", "*=", "/=", "{", "}", "(", ")", "[", "]", ";", ",", ":", "=", "<", ">", "+", "-", "*", "/", ".", "!"];

function tokenize(source: string): Token[] {
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
      throw frontendError("string literals are not supported", `line ${line}: the contract types describe numbers, not text`);
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
    if (punctuation === undefined) {
      throw frontendError(`unsupported token "${character}"`, `line ${line}`);
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

type Expression =
  | { k: "literal"; text: string }
  | { k: "bigint"; text: string }
  | { k: "ident"; name: string }
  | { k: "length"; buffer: string }
  | { k: "index"; base: Expression; index: Expression }
  | { k: "binary"; op: "+" | "-" | "*" | "/"; left: Expression; right: Expression }
  | { k: "negate"; operand: Expression };

type AssignOperator = "=" | "+=" | "*=" | "-=" | "/=";

type Statement =
  | { kind: "declare"; name: string; init: Expression; line: number }
  | { kind: "loop"; variable: string; from: Expression; to: Expression; inclusive: boolean; body: Statement[]; line: number }
  | { kind: "assign"; target: string; op: AssignOperator; value: Expression; line: number }
  | { kind: "result"; value: Expression; line: number }
  | { kind: "indexAssign"; buffer: string; index: Expression; value: Expression; line: number };

interface TypeScriptFunction {
  name: string;
  params: { name: string; type: TypeExpr }[];
  returns: TypeExpr;
  body: Statement[];
  line: number;
}

class TypeScriptParser {
  private readonly tokens: Token[];
  private position = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
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

  private expect(text: string): Token {
    if (!this.at(text)) {
      const token = this.peek();
      throw frontendError(`expected "${text}"`, `line ${token.line} near "${token.text}"`);
    }
    return this.next();
  }

  private fail(message: string): never {
    const token = this.peek();
    throw frontendError(message, `line ${token.line} near "${token.text}"`);
  }

  /** Parses every exported function in the file. */
  parseFunctions(): TypeScriptFunction[] {
    const functions: TypeScriptFunction[] = [];
    while (this.peek().kind !== "end") {
      if (this.accept("export")) this.expect("function");
      else this.expect("function");
      const name = this.next();
      if (name.kind !== "ident") this.fail("expected a function name");
      functions.push(this.parseFunction(name));
    }
    return functions;
  }

  private parseFunction(name: Token): TypeScriptFunction {
    this.expect("(");
    const params: TypeScriptFunction["params"] = [];
    if (!this.at(")")) {
      for (;;) {
        const parameter = this.next();
        if (parameter.kind !== "ident") this.fail("expected a parameter name");
        this.expect(":");
        const type = this.next();
        if (type.kind !== "ident") this.fail("expected a parameter type");
        params.push({ name: parameter.text, type: mapTypeScriptType(type.text, `line ${type.line}`) });
        if (this.accept(",")) continue;
        this.expect(")");
        break;
      }
    }
    this.expect(":");
    const returns = this.next();
    if (returns.kind !== "ident") this.fail("expected a return type");
    const returnType = mapTypeScriptType(returns.text, `line ${returns.line}`);
    if (this.accept("=")) {
      // `function f(x: T): T = expr;` carries an optional trailing semicolon.
      const value = this.readExpression();
      this.accept(";");
      return { name: name.text, params, returns: returnType, body: [{ kind: "result", value, line: name.line }], line: name.line };
    }
    return { name: name.text, params, returns: returnType, body: this.readBlock(), line: name.line };
  }

  private readBlock(): Statement[] {
    this.expect("{");
    const statements: Statement[] = [];
    while (!this.at("}")) {
      if (this.peek().kind === "end") this.fail("unterminated function body");
      statements.push(this.readStatement());
    }
    this.expect("}");
    return statements;
  }

  private readStatement(): Statement {
    const token = this.peek();

    if (this.at("let") || this.at("const")) {
      this.next();
      const name = this.next();
      if (name.kind !== "ident") this.fail("expected a variable name");
      if (this.accept(":")) {
        const type = this.next();
        mapTypeScriptType(type.kind === "ident" ? type.text : "", `line ${type.line}`);
      }
      this.expect("=");
      const init = this.readExpression();
      this.expect(";");
      return { kind: "declare", name: name.text, init, line: name.line };
    }

    if (this.at("for")) return this.readLoop();
    if (this.at("return")) {
      this.next();
      const value = this.readExpression();
      this.expect(";");
      return { kind: "result", value, line: token.line };
    }
    if (this.at("if") || this.at("while") || this.at("switch") || this.at("try") || this.at("throw")) {
      throw frontendError(
        `"${token.text}" is not supported (line ${token.line})`,
        "the frontend only accepts declarations, counted loops, assignments and returns",
      );
    }

    const indexed = this.readIndexedAssignment();
    if (indexed !== null) return indexed;

    const target = this.next();
    if (target.kind !== "ident") this.fail("expected an assignment target");
    const operator = this.next();
    if (operator.kind !== "punct" || !["=", "+=", "-=", "*=", "/="].includes(operator.text)) {
      this.fail(`unsupported assignment operator "${operator.text}"`);
    }
    const value = this.readExpression();
    this.expect(";");
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
    if (!this.at("=")) {
      this.position = start;
      return null;
    }
    this.next();
    const value = this.readExpression();
    this.expect(";");
    return { kind: "indexAssign", buffer: buffer.text, index, value, line: buffer.line };
  }

  /** `for (let i = from; i < to; i++)` and the `<=` form. */
  private readLoop(): Statement {
    const start = this.peek();
    this.expect("for");
    this.expect("(");
    if (!this.at("let") && !this.at("const") && !this.at("var")) {
      this.fail("a loop must declare its index, as in for (let i = 0; ...)");
    }
    this.next();
    const variable = this.next();
    if (variable.kind !== "ident") this.fail("expected a loop index name");
    this.expect("=");
    const from = this.readExpression();
    this.expect(";");

    const condition = this.next();
    if (condition.kind !== "ident" || condition.text !== variable.text) {
      this.fail(`the loop condition must test the index "${variable.text}"`);
    }
    const comparison = this.next();
    if (comparison.kind !== "punct" || (comparison.text !== "<" && comparison.text !== "<=")) {
      this.fail('the loop condition must be "i < bound" or "i <= bound"');
    }
    const to = this.readExpression();
    this.expect(";");

    const step = this.next();
    if (step.kind === "punct" && step.text === "--") {
      throw frontendError("counting down is not supported", `line ${start.line}`);
    }
    if (step.kind !== "ident" || step.text !== variable.text) {
      this.fail("a loop must advance its index by one, as in i++");
    }
    const operator = this.next();
    if (operator.text === "++") {
      // i++
    } else if (operator.text === "+=") {
      const amount = this.next();
      if (amount.text !== "1") this.fail("a loop must advance its index by one");
    } else {
      this.fail("a loop must advance its index by one, as in i++");
    }
    this.expect(")");

    const body = this.at("{") ? this.readBlock() : [this.readStatement()];
    return {
      kind: "loop",
      variable: variable.text,
      from,
      to,
      inclusive: comparison.text === "<=",
      body,
      line: start.line,
    };
  }

  readExpression(): Expression {
    let left = this.readTerm();
    for (;;) {
      const token = this.peek();
      if (token.kind !== "punct" || !["+", "-", "*", "/"].includes(token.text)) return left;
      this.next();
      left = { k: "binary", op: token.text as "+" | "-" | "*" | "/", left, right: this.readTerm() };
    }
  }

  /** A primary followed by any number of `a[i]` indexings. */
  private readTerm(): Expression {
    let base = this.readPrimary();
    while (this.at("[")) {
      this.next();
      const index = this.readExpression();
      this.expect("]");
      base = { k: "index", base, index };
    }
    return base;
  }

  private readPrimary(): Expression {
    const token = this.next();
    if (token.kind === "number") return { k: "literal", text: token.text };
    if (token.kind === "bigint") return { k: "bigint", text: token.text };
    if (token.kind === "ident") {
      if (token.text === "true" || token.text === "false") return { k: "literal", text: token.text === "true" ? "1" : "0" };
      if (this.at(".")) {
        this.next();
        const member = this.next();
        if (member.text !== "length") {
          throw frontendError(`.${member.text} is not supported`, `line ${member.line}; only .length of a typed array`);
        }
        return { k: "length", buffer: token.text };
      }
      return { k: "ident", name: token.text };
    }
    if (token.kind === "punct") {
      if (token.text === "(") {
        const inner = this.readExpression();
        this.expect(")");
        return inner;
      }
      if (token.text === "-") return { k: "negate", operand: this.readTerm() };
      if (token.text === "+") return this.readTerm();
    }
    this.fail(`unexpected "${token.text}" in an expression`);
  }
}

/* -------------------------------------------------------------------------- */
/* Body analysis                                                              */
/* -------------------------------------------------------------------------- */

interface LoopContext {
  variable: string;
  lo: string;
  hiExclusive: string;
}

class BodyAnalysis {
  private readonly declaration: TypeScriptFunction;
  private readonly bindings = new Map<string, string>();
  private readonly accesses: AccessRange[] = [];
  private result: string | null = null;

  constructor(declaration: TypeScriptFunction) {
    this.declaration = declaration;
    for (const param of declaration.params) this.bindings.set(param.name, param.name);
  }

  run(): { result: string; accesses: AccessRange[] } {
    for (const statement of this.declaration.body) this.execute(statement, null);
    if (this.result === null) {
      throw frontendError(`${this.declaration.name} never returns a value`, "the contract needs an expression the result must equal");
    }
    return { result: this.result, accesses: this.accesses };
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
      case "indexAssign":
        throw frontendError(
          `writing into "${statement.buffer}" is not supported (line ${statement.line})`,
          "the frontend accepts pure functions; the contract would have to describe the write",
        );
    }
  }

  private executeLoop(statement: Statement & { kind: "loop" }): void {
    if (statement.body.length !== 1) {
      throw frontendError(
        `loop body at line ${statement.line} must contain exactly one statement`,
        "version 0.1 supports accumulator loops; branches and early returns are rejected",
      );
    }
    const inner = statement.body[0];
    if (inner.kind === "indexAssign") {
      throw frontendError(
        `writing into "${inner.buffer}" is not supported (line ${inner.line})`,
        "the frontend accepts pure functions",
      );
    }
    if (inner.kind !== "assign") {
      throw frontendError(
        `loop body at line ${statement.line} must accumulate into a variable`,
        "expected `total += ...`",
      );
    }
    if (inner.op === "-=" || inner.op === "/=") {
      throw frontendError(`"${inner.op}" inside a loop is not supported (line ${inner.line})`);
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
    this.bindings.set(inner.target, this.withInitial(current, reduce, reduceOperator, inner.line));
  }

  /** Drops a neutral initialiser so the contract stays readable. */
  private withInitial(initial: string | null, reduce: string, operator: ReduceOperator, line: number): string {
    if (initial === null) return reduce;
    const neutral = operator === "sum" ? ["0", "0.0"] : ["1", "1.0"];
    if (neutral.includes(initial)) return reduce;
    const symbol = operator === "sum" ? "+" : "*";
    if (/[ (]/.test(initial)) {
      throw frontendError(
        `cannot prove the initial value on line ${line} is the identity of "${symbol}"`,
        `initial = ${initial}`,
      );
    }
    return `(${initial} ${symbol} ${reduce})`;
  }

  private serialize(expression: Expression, loop: LoopContext | null, line: number): string {
    switch (expression.k) {
      case "literal":
      case "bigint":
        return expression.text;
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
      case "negate":
        return `(-${this.serialize(expression.operand, loop, line)})`;
      case "binary":
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
    case "length":
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

export const typeScriptFrontend: Frontend = {
  async compile(input: SourceInput): Promise<FunctionContract> {
    if (typeof input.source !== "string" || input.source.trim() === "") {
      throw frontendError("input.source is empty");
    }
    const declarations = new TypeScriptParser(tokenize(input.source)).parseFunctions();
    if (declarations.length === 0) {
      throw frontendError("no function found in source", "the frontend accepts pure functions");
    }
    const entry = input.entry;
    const declaration =
      entry === undefined || entry === ""
        ? declarations[0]
        : declarations.find((candidate) => candidate.name === entry);
    if (declaration === undefined) {
      throw frontendError(`entry "${entry}" not found`, `available: ${declarations.map((candidate) => candidate.name).join(", ")}`);
    }

    const analysis = new BodyAnalysis(declaration).run();
    // A buffer length is a property of the value, not of the pointer the callee
    // receives: the implementation cannot observe it, so the result may not
    // depend on it. Preconditions may, because the caller checks them.
    if (analysis.result.includes("len(")) {
      throw frontendError(
        `the result of ${declaration.name} depends on a buffer length`,
        "the callee only receives the pointer, so pass the length as a parameter and loop over that",
      );
    }
    return assembleContract({
      name: declaration.name,
      params: declaration.params,
      returns: declaration.returns,
      result: analysis.result,
      accesses: analysis.accesses,
      input,
    });
  },
};

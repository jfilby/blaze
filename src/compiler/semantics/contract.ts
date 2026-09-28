/**
 * Native Function Contract DSL.
 *
 * This module owns everything about contract *semantics*:
 *
 *   - type expressions (`ptr<f32>`, `slice<f32>`, `usize`, ...)
 *   - the typed expression language used by `requires` and `ensures`
 *   - static type checking of those expressions
 *   - evaluation of those expressions, which is the compiler's reference
 *     implementation of the contracted function
 *
 * The contract is the semantic truth of the pipeline. The AI proposes an
 * implementation; the oracle derived here decides whether it is correct.
 */

import { CompilerError } from "../core/errors.ts";
import {
  PRIMITIVE_TYPES,
  type Effect,
  type FunctionContract,
  type NumericContract,
  type Objective,
  type OptimizeSpec,
  type PrimitiveTypeName,
  type TypeExpr,
} from "../core/types.ts";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

const INTEGER_NAMES: Record<string, true> = {
  i8: true,
  i16: true,
  i32: true,
  i64: true,
  u8: true,
  u16: true,
  u32: true,
  u64: true,
  usize: true,
  isize: true,
};

const FLOAT_NAMES: Record<string, true> = { f32: true, f64: true };

export function isIntegerType(name: PrimitiveTypeName): boolean {
  return INTEGER_NAMES[name] === true;
}

export function isFloatType(name: PrimitiveTypeName): boolean {
  return FLOAT_NAMES[name] === true;
}

export function isNumericType(name: PrimitiveTypeName): boolean {
  return INTEGER_NAMES[name] === true || FLOAT_NAMES[name] === true;
}

/**
 * Whether a result of this type is read as a signed value. Both hosts have to
 * agree on it: the native harness prints one with `%lld` and the WebAssembly
 * host reads a BigInt, and a `u64` above 2^63 printed signed comes back as a
 * negative number for a candidate that returned exactly what the contract
 * promised.
 */
export function isSignedIntegerType(name: PrimitiveTypeName): boolean {
  return name === "isize" || (isIntegerType(name) && name.startsWith("i"));
}

export function integerBits(name: PrimitiveTypeName): number {
  switch (name) {
    case "i8":
    case "u8":
    case "bool":
      return 8;
    case "i16":
    case "u16":
      return 16;
    case "i32":
    case "u32":
      return 32;
    default:
      return 64;
  }
}

export function isSignedType(name: PrimitiveTypeName): boolean {
  return name === "isize" || name.startsWith("i");
}

export function parsePrimitiveName(name: string): PrimitiveTypeName {
  const match = PRIMITIVE_TYPES.find((entry) => entry === name);
  if (match === undefined) {
    throw new CompilerError({
      category: "ContractError",
      stage: "contract",
      message: `unknown type "${name}"`,
      detail: `known types: ${PRIMITIVE_TYPES.join(", ")}`,
    });
  }
  return match;
}

export function parseType(text: string): TypeExpr {
  const source = text.trim();
  if (source === "void") return { kind: "void" };
  const composite = /^([A-Za-z_][A-Za-z0-9_]*)\s*<(.+)>$/.exec(source);
  if (composite === null) {
    return { kind: "primitive", name: parsePrimitiveName(source) };
  }

  const [, head, argument] = composite;
  if (head === "ptr" || head === "slice") {
    return { kind: head, of: parseType(argument) };
  }
  if (head === "ref") {
    // `ref<any>` is a reference the source left unshaped, and `ref<Object1>`
    // names the object it points at, which is a layout rather than a type.
    const inner = argument.trim();
    if (inner === "any") return { kind: "ref", of: null };
    if (/^[A-Z][A-Za-z0-9_]*$/.test(inner)) return { kind: "ref", of: null, name: inner };
    return { kind: "ref", of: parseType(inner) };
  }
  if (head === "array") {
    const parts = argument.split(",");
    if (parts.length === 1) return { kind: "array", of: parseType(parts[0]), length: null };
    if (parts.length === 2) {
      const length = Number.parseInt(parts[1].trim(), 10);
      if (!Number.isInteger(length) || length <= 0) {
        throw new CompilerError({
          category: "ContractError",
          stage: "contract",
          message: `invalid array length in "${text}"`,
        });
      }
      return { kind: "array", of: parseType(parts[0]), length };
    }
  }
  throw new CompilerError({
    category: "ContractError",
    stage: "contract",
    message: `unsupported type expression "${text}"`,
  });
}

export function typeToString(type: TypeExpr): string {
  switch (type.kind) {
    case "primitive":
      return type.name;
    case "ptr":
    case "slice":
      return `${type.kind}<${typeToString(type.of)}>`;
    case "array":
      return type.length === null ? `array<${typeToString(type.of)}>` : `array<${typeToString(type.of)},${type.length}>`;
    case "ref":
      if (type.name !== undefined) return `ref<${type.name}>`;
      return type.of === null ? "ref<any>" : `ref<${typeToString(type.of)}>`;
    case "void":
      return "void";
  }
}

export type BufferType = Extract<TypeExpr, { kind: "ptr" | "slice" | "array" }>;

export function isBufferType(type: TypeExpr): type is BufferType {
  return type.kind === "ptr" || type.kind === "slice" || type.kind === "array";
}

/** Element type of a buffer type, or null for anything else. */
export function elementType(type: TypeExpr): TypeExpr | null {
  return isBufferType(type) ? type.of : null;
}

/** The element type of a buffer type, refusing a type that is not one. */
export function bufferElement(type: TypeExpr): TypeExpr {
  if (isBufferType(type)) return type.of;
  throw contractError(`${typeToString(type)} is not a buffer`);
}

/* -------------------------------------------------------------------------- */
/* Expressions                                                                */
/* -------------------------------------------------------------------------- */

export type ReduceOp = "sum" | "product" | "min" | "max";

export type Expr =
  | { t: "int"; value: bigint }
  | { t: "float"; value: number }
  | { t: "bool"; value: boolean }
  | { t: "null" }
  | { t: "var"; name: string }
  | { t: "index"; base: Expr; index: Expr }
  | { t: "call"; name: string; args: Expr[] }
  | { t: "reduce"; op: ReduceOp; varName: string; from: Expr; to: Expr; exclusive: boolean; body: Expr }
  | { t: "unary"; op: "!" | "-"; operand: Expr }
  | { t: "binary"; op: BinaryOp; left: Expr; right: Expr };

export type BinaryOp =
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "&&"
  | "||"
  | "+"
  | "-"
  | "*"
  | "/";

type Token =
  | { kind: "number"; text: string }
  | { kind: "ident"; text: string }
  | { kind: "op"; text: string }
  | { kind: "end" };

const OPERATORS = [
  "..<",
  "..",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "<",
  ">",
  "+",
  "-",
  "*",
  "/",
  "!",
  "(",
  ")",
  "[",
  "]",
  ",",
  "=",
];

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (/[0-9]/.test(character) || (character === "." && /[0-9]/.test(source[index + 1] ?? ""))) {
      const match = /^(?:0[xX][0-9a-fA-F]+|[0-9]*\.[0-9]+|[0-9]+)(?:[eE][+-]?[0-9]+)?/.exec(source.slice(index));
      if (match === null) {
        throw new CompilerError({ category: "ContractError", stage: "contract", message: `bad number in "${source}"` });
      }
      tokens.push({ kind: "number", text: match[0] });
      index += match[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(character)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(index));
      if (match === null) {
        throw new CompilerError({ category: "ContractError", stage: "contract", message: `bad identifier in "${source}"` });
      }
      tokens.push({ kind: "ident", text: match[0] });
      index += match[0].length;
      continue;
    }
    const operator = OPERATORS.find((candidate) => source.startsWith(candidate, index));
    if (operator === undefined) {
      throw new CompilerError({
        category: "ContractError",
        stage: "contract",
        message: `unexpected character "${character}" in expression "${source}"`,
      });
    }
    tokens.push({ kind: "op", text: operator });
    index += operator.length;
  }
  tokens.push({ kind: "end" });
  return tokens;
}

const COMPARISONS: BinaryOp[] = ["==", "!=", "<", "<=", ">", ">="];

class ExpressionParser {
  private readonly tokens: Token[];
  private position = 0;

  private readonly source: string;

  constructor(source: string, tokens: Token[]) {
    this.source = source;
    this.tokens = tokens;
  }

  parse(): Expr {
    const expression = this.parseOr();
    const trailing = this.peek();
    if (trailing.kind !== "end") {
      throw this.error(`unexpected "${trailing.text}"`);
    }
    return expression;
  }

  private peek(): Token {
    return this.tokens[this.position];
  }

  private next(): Token {
    return this.tokens[this.position++];
  }

  private acceptOp(text: string): boolean {
    const token = this.peek();
    if (token.kind === "op" && token.text === text) {
      this.position += 1;
      return true;
    }
    return false;
  }

  private expectOp(text: string): void {
    if (!this.acceptOp(text)) throw this.error(`expected "${text}"`);
  }

  private error(message: string): CompilerError {
    return new CompilerError({
      category: "ContractError",
      stage: "contract",
      message: `${message} in expression "${this.source}"`,
    });
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.acceptOp("||")) left = { t: "binary", op: "||", left, right: this.parseAnd() };
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseComparison();
    while (this.acceptOp("&&")) left = { t: "binary", op: "&&", left, right: this.parseComparison() };
    return left;
  }

  private parseComparison(): Expr {
    const left = this.parseAdditive();
    const token = this.peek();
    if (token.kind === "op" && COMPARISONS.includes(token.text as BinaryOp)) {
      this.next();
      return { t: "binary", op: token.text as BinaryOp, left, right: this.parseAdditive() };
    }
    return left;
  }

  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    for (;;) {
      const token = this.peek();
      if (token.kind === "op" && (token.text === "+" || token.text === "-")) {
        this.next();
        left = { t: "binary", op: token.text, left, right: this.parseMultiplicative() };
        continue;
      }
      return left;
    }
  }

  private parseMultiplicative(): Expr {
    let left = this.parseUnary();
    for (;;) {
      const token = this.peek();
      if (token.kind === "op" && (token.text === "*" || token.text === "/")) {
        this.next();
        left = { t: "binary", op: token.text, left, right: this.parseUnary() };
        continue;
      }
      return left;
    }
  }

  private parseUnary(): Expr {
    if (this.acceptOp("!")) return { t: "unary", op: "!", operand: this.parseUnary() };
    if (this.acceptOp("-")) return { t: "unary", op: "-", operand: this.parseUnary() };
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let base = this.parsePrimary();
    while (this.acceptOp("[")) {
      const index = this.parseOr();
      this.expectOp("]");
      base = { t: "index", base, index };
    }
    return base;
  }

  private parsePrimary(): Expr {
    const token = this.next();
    if (token.kind === "number") {
      return /[.eE]/.test(token.text) && !/^0[xX]/.test(token.text)
        ? { t: "float", value: Number(token.text) }
        : { t: "int", value: token.text.startsWith("0x") || token.text.startsWith("0X") ? BigInt(token.text) : BigInt(token.text) };
    }
    if (token.kind === "op" && token.text === "(") {
      const inner = this.parseOr();
      this.expectOp(")");
      return inner;
    }
    if (token.kind === "ident") {
      if (token.text === "true" || token.text === "false") return { t: "bool", value: token.text === "true" };
      if (token.text === "null") return { t: "null" };
      if (this.acceptOp("(")) return this.parseCall(token.text);
      return { t: "var", name: token.text };
    }
    throw this.error(`unexpected "${token.kind === "end" ? "<end of input>" : token.text}"`);
  }

  private parseCall(name: string): Expr {
    if ((name === "sum" || name === "product" || name === "min" || name === "max") && this.peek().kind === "ident") {
      const variable = this.next();
      if (variable.kind !== "ident") throw this.error("expected reduction variable");
      this.expectOp("=");
      const from = this.parseOr();
      // `a..b` is inclusive, `a..<b` is the half-open range of a counted loop
      // and stays empty when the bound has been reached.
      const exclusive = this.acceptOp("..<");
      if (!exclusive) this.expectOp("..");
      const to = this.parseOr();
      this.expectOp(",");
      const body = this.parseOr();
      this.expectOp(")");
      return { t: "reduce", op: name, varName: variable.text, from, to, exclusive, body };
    }

    const args: Expr[] = [];
    if (!this.acceptOp(")")) {
      for (;;) {
        args.push(this.parseOr());
        if (this.acceptOp(",")) continue;
        this.expectOp(")");
        break;
      }
    }
    return { t: "call", name, args };
  }
}

/** Guards the reference implementation against pathological ranges. */
const MAXIMUM_REDUCTION_TERMS = 1n << 24n;

export function parseExpression(source: string): Expr {
  return new ExpressionParser(source, tokenize(source)).parse();
}

/* -------------------------------------------------------------------------- */
/* Values                                                                     */
/* -------------------------------------------------------------------------- */

export interface BufferValue {
  readonly type: TypeExpr;
  readonly values: readonly Value[];
}

export type Value = bigint | number | boolean | null | BufferValue;

export function isBufferValue(value: Value): value is BufferValue {
  return typeof value === "object" && value !== null && "values" in value;
}

export function formatValue(value: Value): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "nan";
    if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
    return Number.isInteger(value) ? value.toString() : value.toPrecision(17);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null) return "null";
  return `[${value.values.map(formatValue).join(", ")}]`;
}

/* -------------------------------------------------------------------------- */
/* Static typing                                                              */
/* -------------------------------------------------------------------------- */

export type TypeEnv = ReadonlyMap<string, TypeExpr>;

/** The name a contract's object exports, which is its name unless it is renamed. */
export function symbolOf(contract: FunctionContract): string {
  return contract.function.symbol ?? contract.function.name;
}

export function signatureTypeEnv(contract: FunctionContract): TypeEnv {
  const env = new Map<string, TypeExpr>();
  for (const param of contract.function.params) {
    env.set(param.name, parseType(param.type));
  }
  env.set("result", parseType(contract.function.returns));
  return env;
}

function contractError(message: string, detail?: string): CompilerError {
  return new CompilerError({ category: "ContractError", stage: "contract", message, detail });
}

/** A static type as seen by the type checker; `null` is a type of its own. */
export interface NullType {
  kind: "null";
}

export type StaticType = TypeExpr | NullType;

const NULL_TYPE: NullType = { kind: "null" };

function describeType(type: StaticType): string {
  return type.kind === "null" ? "null" : typeToString(type);
}

function numericType(left: StaticType, right: StaticType): TypeExpr {
  if (left.kind !== "primitive" || !isNumericType(left.name) || right.kind !== "primitive" || !isNumericType(right.name)) {
    throw contractError(`arithmetic requires numeric operands, got ${describeType(left)} and ${describeType(right)}`);
  }
  if (isFloatType(left.name) || isFloatType(right.name)) {
    return { kind: "primitive", name: isFloatType(left.name) ? left.name : (right.name as "f32" | "f64") };
  }
  return { kind: "primitive", name: widerInteger(left.name, right.name) };
}

/**
 * What `==` and `!=` may compare: two numbers, two booleans, two nulls, or a
 * null and something that can be one. The operands are checked because the
 * values are compared by their own kinds later, where a contract that reached
 * the evaluator said nothing useful about what it meant.
 */
function comparable(op: string, left: StaticType, right: StaticType): void {
  if (left.kind === "primitive" && right.kind === "primitive") {
    if (isNumericType(left.name) && isNumericType(right.name)) return;
    if (left.name === "bool" && right.name === "bool") return;
  } else if (left.kind === "null" && right.kind === "null") {
    return;
  } else if (left.kind === "null" || right.kind === "null") {
    const other = left.kind === "null" ? right : left;
    if (other.kind === "ptr" || other.kind === "slice" || other.kind === "array" || other.kind === "ref") return;
  }
  throw contractError(`${op} requires comparable operands, got ${describeType(left)} and ${describeType(right)}`);
}

function widerInteger(left: PrimitiveTypeName, right: PrimitiveTypeName): PrimitiveTypeName {
  if (left === "usize" || right === "usize") return "usize";
  if (left === "isize" || right === "isize") return "isize";
  if (integerBits(left) !== integerBits(right)) {
    return integerBits(left) > integerBits(right) ? left : right;
  }
  return isSignedType(left) === isSignedType(right) ? left : isSignedType(left) ? (right as PrimitiveTypeName) : left;
}

export function typeOf(expression: Expr, env: TypeEnv): StaticType {
  switch (expression.t) {
    case "int":
      return { kind: "primitive", name: "i64" };
    case "float":
      return { kind: "primitive", name: "f64" };
    case "bool":
      return { kind: "primitive", name: "bool" };
    case "null":
      return NULL_TYPE;
    case "var": {
      const type = env.get(expression.name);
      if (type === undefined) {
        throw contractError(`unknown identifier "${expression.name}"`, `known: ${[...env.keys()].join(", ")}`);
      }
      return type;
    }
    case "index": {
      const base = typeOf(expression.base, env);
      const index = typeOf(expression.index, env);
      if (base.kind !== "ptr" && base.kind !== "slice" && base.kind !== "array") {
        throw contractError(`cannot index ${describeType(base)}`);
      }
      if (index.kind !== "primitive" || !isIntegerType(index.name)) {
        throw contractError(`index must be an integer, got ${describeType(index)}`);
      }
      return base.of;
    }
    case "reduce": {
      // A range runs over the integers i between its bounds, so a bound may be
      // any number: a counted loop in a language whose numbers are doubles
      // needs one. `a..b` includes b, `a..<b` does not.
      const from = typeOf(expression.from, env);
      const to = typeOf(expression.to, env);
      for (const bound of [from, to]) {
        if (bound.kind !== "primitive" || !isNumericType(bound.name)) {
          throw contractError(`reduction bounds must be numbers, got ${describeType(bound)}`);
        }
      }
      const inner = new Map(env);
      inner.set(expression.varName, { kind: "primitive", name: "usize" });
      const body = typeOf(expression.body, inner);
      if (body.kind !== "primitive" || !isNumericType(body.name)) {
        throw contractError(`reduction body must be numeric, got ${describeType(body)}`);
      }
      if (expression.op === "min" || expression.op === "max") {
        return body;
      }
      return expression.op === "sum" ? sumType(body) : productType(body);
    }
    case "call": {
      if (expression.name === "len") {
        if (expression.args.length !== 1) throw contractError("len() takes exactly one argument");
        const argument = typeOf(expression.args[0], env);
        if (argument.kind === "null" || argument.kind === "primitive") {
          throw contractError(`len() requires a buffer, got ${describeType(argument)}`);
        }
        return { kind: "primitive", name: "usize" };
      }
      if ((expression.name === "min" || expression.name === "max") && expression.args.length >= 2) {
        let type = typeOf(expression.args[0], env);
        for (const argument of expression.args.slice(1)) {
          type = numericType(type, typeOf(argument, env));
        }
        return type;
      }
      throw contractError(`unknown function "${expression.name}()"`);
    }
    case "unary": {
      const operand = typeOf(expression.operand, env);
      if (expression.op === "!") {
        if (operand.kind !== "primitive" || operand.name !== "bool") {
          throw contractError(`! requires bool, got ${describeType(operand)}`);
        }
        return operand;
      }
      if (operand.kind !== "primitive" || !isNumericType(operand.name)) {
        throw contractError(`unary - requires a number, got ${describeType(operand)}`);
      }
      return operand;
    }
    case "binary": {
      const left = typeOf(expression.left, env);
      const right = typeOf(expression.right, env);
      switch (expression.op) {
        case "==":
        case "!=":
          comparable(expression.op, left, right);
          return { kind: "primitive", name: "bool" };
        case "<":
        case "<=":
        case ">":
        case ">=": {
          numericType(left, right);
          return { kind: "primitive", name: "bool" };
        }
        case "&&":
        case "||": {
          if (left.kind !== "primitive" || left.name !== "bool" || right.kind !== "primitive" || right.name !== "bool") {
            throw contractError(`${expression.op} requires bool operands, got ${describeType(left)} and ${describeType(right)}`);
          }
          return { kind: "primitive", name: "bool" };
        }
        default:
          return numericType(left, right);
      }
    }
  }
}

function sumType(body: TypeExpr): TypeExpr {
  if (body.kind !== "primitive" || !isNumericType(body.name)) {
    throw contractError(`sum() body must be numeric, got ${describeType(body)}`);
  }
  // A sum of whole numbers is a whole number, and it is not held at the width
  // of the elements: summing 52 bytes of 5 is 260, not 4.
  if (isIntegerType(body.name)) return { kind: "primitive", name: isSignedType(body.name) ? "i64" : "u64" };
  return body;
}

function productType(body: TypeExpr): TypeExpr {
  if (body.kind !== "primitive" || !isNumericType(body.name)) {
    throw contractError(`product() body must be numeric, got ${describeType(body)}`);
  }
  // A product of whole numbers is held wider for the same reason a sum is:
  // multiplying 4 bytes of 5 is 625, not 113, and wrapping at the element
  // width made a correct implementation read as a wrong one.
  if (isIntegerType(body.name)) return { kind: "primitive", name: isSignedType(body.name) ? "i64" : "u64" };
  return body;
}

export interface EvalContext {
  readonly env: TypeEnv;
  readonly values: ReadonlyMap<string, Value>;
}

function wrapInteger(value: bigint, name: PrimitiveTypeName): bigint {
  if (name === "bool") return value === 0n ? 0n : 1n;
  const bits = integerBits(name);
  return isSignedType(name) ? BigInt.asIntN(bits, value) : BigInt.asUintN(bits, value);
}

function roundFloat(value: number, type: StaticType): number {
  if (type.kind === "primitive" && type.name === "f32") return Math.fround(value);
  return value;
}

function asNumber(value: Value, type: StaticType): number {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  throw contractError(`expected a number, got ${formatValue(value)} (${describeType(type)})`);
}

function compareValues(left: Value, right: Value): number {
  if (typeof left === "bigint" && typeof right === "bigint") {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  if (typeof left === "number" && typeof right === "number") {
    // Nothing is ordered against not-a-number. Answering that nothing is
    // greater made every `>` and `>=` on a NaN true, so a result of NaN
    // satisfied a postcondition it broke, and a comparison that should fail
    // let an unchecked input through.
    if (Number.isNaN(left) || Number.isNaN(right)) return Number.NaN;
    return left < right ? -1 : left > right ? 1 : 0;
  }
  if (typeof left === "bigint" && typeof right === "number") return compareIntegerToFloat(left, right);
  if (typeof left === "number" && typeof right === "bigint") return -compareIntegerToFloat(right, left);
  throw contractError(`cannot compare ${formatValue(left)} with ${formatValue(right)}`);
}

/**
 * Compares a 64-bit integer with a double without losing precision: every
 * double at or above 2^53 is an exact integer, so both sides can be brought to
 * exact integers before comparing.
 */
function compareIntegerToFloat(integer: bigint, float: number): number {
  if (Number.isNaN(float)) return Number.NaN;
  if (float === Number.POSITIVE_INFINITY) return -1;
  if (float === Number.NEGATIVE_INFINITY) return 1;
  if (!Number.isInteger(float)) {
    // A whole number is never equal to a fraction, and it is below one when
    // it is at or below its floor. Comparing against the floor made 2 >= 2.5
    // and 1 == 1.5 true, and rounded the bound in the program's favour.
    return integer <= BigInt(Math.floor(float)) ? -1 : 1;
  }
  // The order is the integer against the float. Reading it the other way
  // round reported 1 >= 2.0 as true, because 2 is the greater of the two.
  const exact = BigInt(float);
  return integer < exact ? -1 : integer > exact ? 1 : 0;
}

function valuesEqual(left: Value, right: Value): boolean {
  if (isBufferValue(left) || isBufferValue(right) || left === null || right === null) {
    return left === right;
  }
  if (typeof left === "boolean" || typeof right === "boolean") {
    return left === right;
  }
  return compareValues(left, right) === 0;
}

export function evaluate(expression: Expr, context: EvalContext): Value {
  switch (expression.t) {
    case "int":
      return expression.value;
    case "float":
      return expression.value;
    case "bool":
      return expression.value;
    case "null":
      return null;
    case "var": {
      if (!context.values.has(expression.name)) {
        throw contractError(`unbound identifier "${expression.name}"`);
      }
      return context.values.get(expression.name) as Value;
    }
    case "index": {
      const base = evaluate(expression.base, context);
      if (!isBufferValue(base)) {
        throw contractError(`cannot index ${formatValue(base)}`);
      }
      const indexValue = evaluate(expression.index, context);
      if (typeof indexValue !== "bigint") {
        throw contractError(`index must be an integer, got ${formatValue(indexValue)}`);
      }
      if (indexValue < 0n || indexValue >= BigInt(base.values.length)) {
        throw contractError(
          `index ${indexValue} out of bounds for ${expression.base.t === "var" ? expression.base.name : "expression"} of length ${base.values.length}`,
        );
      }
      return base.values[Number(indexValue)];
    }
    case "call": {
      if (expression.name === "len") {
        const argument = evaluate(expression.args[0], context);
        if (!isBufferValue(argument)) {
          throw contractError(`len() requires a buffer, got ${formatValue(argument)}`);
        }
        return BigInt(argument.values.length);
      }
      const values = expression.args.map((argument) => evaluate(argument, context));
      if (expression.name === "min") {
        return values.reduce((best, value) => (compareValues(value, best) < 0 ? value : best));
      }
      if (expression.name === "max") {
        return values.reduce((best, value) => (compareValues(value, best) > 0 ? value : best));
      }
      throw contractError(`unknown function "${expression.name}()"`);
    }
    case "reduce": {
      const from = evaluate(expression.from, context);
      const to = evaluate(expression.to, context);
      if (typeof from !== "bigint") {
        throw contractError("the lower bound of a reduction must be an integer", `got ${formatValue(from)}`);
      }
      const count = reductionCount(from, to, expression.exclusive);
      const innerValues = new Map(context.values);
      let accumulator: Value | null = null;
      const bodyEnv = new Map(context.env);
      bodyEnv.set(expression.varName, { kind: "primitive", name: "usize" });
      const bodyType = typeOf(expression.body, bodyEnv);
      if (count > MAXIMUM_REDUCTION_TERMS) {
        throw contractError(
          `reduction over ${count} terms exceeds the limit of ${MAXIMUM_REDUCTION_TERMS}`,
          "the bounds are derived from the test inputs, which are far larger than the contract intends",
        );
      }
      for (let term = 0n; term < count; term += 1n) {
        const index = from + term;
        innerValues.set(expression.varName, index);
        const value = evaluate(expression.body, { env: bodyEnv, values: innerValues });
        if (accumulator === null) {
          accumulator = value;
          continue;
        }
        accumulator = applyReduce(expression.op, accumulator, value, bodyType);
      }
      if (accumulator === null) {
        // An empty reduction yields the identity of the operator. min/max have
        // no identity, so an empty range is a contract error for them.
        if (bodyType.kind !== "primitive" || !isNumericType(bodyType.name)) {
          throw contractError("empty reduction requires a numeric body");
        }
        if (expression.op === "min" || expression.op === "max") {
          throw contractError(`empty ${expression.op}() reduction has no result`);
        }
        const one = expression.op === "sum" ? 0 : 1;
        accumulator = isIntegerType(bodyType.name) ? BigInt(one) : roundFloat(one, bodyType);
      }
      return normalizeReduceResult(accumulator, expression.op, bodyType);
    }
    case "unary": {
      const operand = evaluate(expression.operand, context);
      if (expression.op === "!") {
        if (typeof operand !== "boolean") throw contractError(`! requires bool, got ${formatValue(operand)}`);
        return !operand;
      }
      const type = typeOf(expression.operand, context.env);
      if (type.kind === "primitive" && isIntegerType(type.name)) {
        if (typeof operand !== "bigint") throw contractError(`unary - requires an integer, got ${formatValue(operand)}`);
        return wrapInteger(-operand, type.name);
      }
      return roundFloat(-asNumber(operand, type), type);
    }
    case "binary":
      return evaluateBinary(expression, context);
  }
}

/**
 * How many integers a reduction covers: those i with from <= i < to, or
 * from <= i <= to when the range is inclusive. A fractional bound is rounded
 * the way a counted loop reaches it, up for a half open range and down for an
 * inclusive one.
 */
function reductionCount(from: bigint, to: Value, exclusive: boolean): bigint {
  if (typeof to === "bigint") {
    const span = to - from;
    if (exclusive) return span > 0n ? span : 0n;
    return span >= 0n ? span + 1n : 0n;
  }
  if (typeof to !== "number" || !Number.isFinite(to)) {
    throw contractError(`a reduction bound must be a finite number, got ${formatValue(to)}`);
  }
  const remaining = to - Number(from);
  if (exclusive) return remaining > 0 ? BigInt(Math.ceil(remaining)) : 0n;
  return remaining >= 0 ? BigInt(Math.floor(remaining)) + 1n : 0n;
}

function applyReduce(op: ReduceOp, accumulator: Value, value: Value, bodyType: StaticType): Value {
  if (op === "min") return compareValues(value, accumulator) < 0 ? value : accumulator;
  if (op === "max") return compareValues(value, accumulator) > 0 ? value : accumulator;
  if (op === "sum") {
    if (typeof accumulator === "bigint" && typeof value === "bigint") return accumulator + value;
    return roundFloat(asNumber(accumulator, bodyType) + asNumber(value, bodyType), bodyType);
  }
  if (typeof accumulator === "bigint" && typeof value === "bigint") return accumulator * value;
  return roundFloat(asNumber(accumulator, bodyType) * asNumber(value, bodyType), bodyType);
}

function normalizeReduceResult(value: Value, op: ReduceOp, bodyType: StaticType): Value {
  // The reduction is held at the type it has, which is wider than the elements
  // it sums: a sum of 100 bytes of 5 is 500, and not 244.
  if (op !== "sum" && op !== "product" || bodyType.kind === "null") return value;
  const type = op === "sum" ? sumType(bodyType) : productType(bodyType);
  if (type.kind === "primitive" && isIntegerType(type.name) && typeof value === "bigint") {
    return wrapInteger(value, type.name);
  }
  if (type.kind === "primitive" && type.name === "f32" && typeof value === "number") {
    return Math.fround(value);
  }
  return value;
}


function evaluateBinary(expression: Expr & { t: "binary" }, context: EvalContext): Value {
  if (expression.op === "&&" || expression.op === "||") {
    const left = evaluate(expression.left, context);
    if (typeof left !== "boolean") throw contractError(`${expression.op} requires bool operands`);
    if (expression.op === "&&" && !left) return false;
    if (expression.op === "||" && left) return true;
    const right = evaluate(expression.right, context);
    if (typeof right !== "boolean") throw contractError(`${expression.op} requires bool operands`);
    return right;
  }

  const type = typeOf(expression, context.env);
  const left = evaluate(expression.left, context);
  const right = evaluate(expression.right, context);

  switch (expression.op) {
    case "==":
      return valuesEqual(left, right);
    case "!=":
      return !valuesEqual(left, right);
    case "<":
      return compareValues(left, right) < 0;
    case "<=":
      return compareValues(left, right) <= 0;
    case ">":
      return compareValues(left, right) > 0;
    case ">=":
      return compareValues(left, right) >= 0;
    case "+":
    case "-":
    case "*":
    case "/":
      break;
  }

  if (type.kind === "null") throw contractError("arithmetic on null");
  if (type.kind !== "primitive" || !isNumericType(type.name)) {
    throw contractError(`arithmetic requires numeric operands, got ${describeType(type)}`);
  }

  if (isIntegerType(type.name)) {
    if (typeof left !== "bigint" || typeof right !== "bigint") {
      throw contractError(`integer arithmetic requires integer operands, got ${formatValue(left)} and ${formatValue(right)}`);
    }
    if (expression.op === "+") return wrapInteger(left + right, type.name);
    if (expression.op === "-") return wrapInteger(left - right, type.name);
    if (expression.op === "*") return wrapInteger(left * right, type.name);
    if (right === 0n) throw contractError("division by zero");
    return wrapInteger(left / right, type.name);
  }

  const leftNumber = asNumber(left, type);
  const rightNumber = asNumber(right, type);
  if (expression.op === "+") return roundFloat(leftNumber + rightNumber, type);
  if (expression.op === "-") return roundFloat(leftNumber - rightNumber, type);
  if (expression.op === "*") return roundFloat(leftNumber * rightNumber, type);
  return roundFloat(leftNumber / rightNumber, type);
}

/* -------------------------------------------------------------------------- */
/* Contract validation and the reference implementation                       */
/* -------------------------------------------------------------------------- */

const OBJECTIVES: readonly Objective[] = ["latency", "throughput", "size", "energy", "balanced"];
const EFFECTS: readonly Effect[] = [
  "memory",
  "io",
  "filesystem",
  "network",
  "syscall",
  "random",
  "clock",
  "panic",
  "exception",
  "atomic",
];


export interface ParsedContract {
  contract: FunctionContract;
  env: TypeEnv;
  requires: Expr[];
  ensures: Expr[];
  /**
   * The expression the result must equal, or null for a contract that carries
   * a definition instead: a function whose result is not one expression is
   * checked by the program it is part of, not by a postcondition.
   */
  resultDefinition: Expr | null;
}

/**
 * Fully type-checks a contract. Every stage before the AI runs this, so a
 * malformed contract never reaches a model.
 */
export function parseContract(contract: FunctionContract): ParsedContract {
  if (contract.version !== "1") {
    throw contractError(`unsupported contract version "${contract.version}"`);
  }
  if (contract.function.name === "") throw contractError("contract function needs a name");
  if (contract.function.returns.trim() === "") throw contractError("contract function needs a return type");

  const env = signatureTypeEnv(contract);
  parseType(contract.function.returns);
  const seen = new Set<string>();
  for (const param of contract.function.params) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(param.name)) throw contractError(`invalid parameter name "${param.name}"`);
    if (seen.has(param.name)) throw contractError(`duplicate parameter "${param.name}"`);
    seen.add(param.name);
    parseType(param.type);
  }

  const requires = contract.requires.map((text) => checkBoolean(text, "requires", env));
  const ensures = contract.ensures.map((text) => checkBoolean(text, "ensures", env));

  for (const objective of [contract.optimize.primary, contract.optimize.secondary]) {
    if (objective !== undefined && !OBJECTIVES.includes(objective)) {
      throw contractError(`unknown optimization objective "${objective}"`, `known: ${OBJECTIVES.join(", ")}`);
    }
  }
  for (const effect of contract.effects) {
    if (!EFFECTS.includes(effect)) throw contractError(`unknown effect "${effect}"`, `known: ${EFFECTS.join(", ")}`);
  }
  for (const statement of contract.memory.reads) validateRange(statement, env, "memory.reads");
  for (const statement of contract.memory.writes) validateRange(statement, env, "memory.writes");
  for (const statement of contract.memory.aliasing) validateAliasing(statement, env);

  // The body is checked whether or not a postcondition states what the result
  // must equal: it is what the function is, and a postcondition beside it says
  // nothing about whether it can be lowered.
  validateDefinition(contract);
  const definitions = ensures
    .map((expression, index) => ({ index, right: isResultDefinition(expression) ? expression.right : null }))
    .filter((entry) => entry.right !== null);
  if (definitions.length === 0) return { contract, env, requires, ensures, resultDefinition: null };
  const distinct = new Set(definitions.map((entry) => contract.ensures[entry.index]));
  if (distinct.size > 1) {
    throw contractError("contract defines the result in more than one way", [...distinct].join(" | "));
  }

  return { contract, env, requires, ensures, resultDefinition: definitions[0].right as Expr };
}

/** What the body of a function may not leave out: its statements, and a layout that fits itself. */
function validateDefinition(contract: FunctionContract): void {
  const definition = contract.definition;
  if (definition.statements.length === 0) {
    throw contractError(`the definition of ${contract.function.name} is empty`, "a function body states what it does");
  }
  for (const [name, object] of Object.entries(definition.objects)) {
    if (object.name !== name) {
      throw contractError(`object ${name} is named "${object.name}"`, "the layout and the field that names it must agree");
    }
    if (object.size <= 0 || object.align <= 0) {
      throw contractError(`object ${name} has no size`, `size ${object.size}, align ${object.align}`);
    }
    const seen = new Set<string>();
    let expected = 0;
    for (const field of object.fields) {
      const type = parseType(field.type);
      // A field name is written into the C and Nim declarations and into the
      // prompt, verbatim, so a name that is not an identifier is refused here
      // rather than emitted as code that cannot compile.
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field.name)) {
        throw contractError(`invalid field name "${field.name}"`, `in ${name}`);
      }
      // A name written twice in a literal is one field to the body, but the
      // layout holds a field per declaration, and a struct that declares the
      // same member twice is code no compiler takes.
      if (seen.has(field.name)) {
        throw contractError(`field ${name}.${field.name} is declared twice`, `in ${name}`);
      }
      seen.add(field.name);
      if (field.offset < expected) {
        throw contractError(
          `field ${name}.${field.name} overlaps the field before it`,
          `offset ${field.offset} comes after ${expected}`,
        );
      }
      expected = field.offset + sizeOfType(type);
      parseType(field.type);
    }
    if (expected > object.size) {
      throw contractError(
        `a field of ${name} lies outside the object`,
        `the last field ends at ${expected}, the object is ${object.size} bytes`,
      );
    }
  }
}

/** The bytes one value of a type takes in an object. */
function sizeOfType(type: TypeExpr): number {
  if (type.kind !== "primitive") return 8;
  switch (type.name) {
    case "bool":
    case "i8":
    case "u8":
      return 1;
    case "i16":
    case "u16":
      return 2;
    case "i32":
    case "u32":
    case "f32":
      return 4;
    default:
      return 8;
  }
}

function checkBoolean(text: string, label: string, env: TypeEnv): Expr {
  const expression = parseExpression(text);
  const type = typeOf(expression, env);
  if (type.kind === "null" || type.kind !== "primitive" || type.name !== "bool") {
    throw contractError(`${label} entry must be a boolean expression`, `"${text}" is ${describeType(type)}`);
  }
  return expression;
}

function isResultDefinition(expression: Expr): expression is Expr & { t: "binary"; op: "=="; left: { t: "var"; name: string }; right: Expr } {
  return expression.t === "binary" && expression.op === "==" && expression.left.t === "var" && expression.left.name === "result";
}

function validateRange(statement: string, env: TypeEnv, label: string): void {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\[([^:]+):(.+)\]$/.exec(statement.trim());
  if (match === null) throw contractError(`${label} entry "${statement}" is not a range like "a[0:n]"`);
  const [, name, from, to] = match;
  const type = env.get(name);
  if (type === undefined) throw contractError(`${label} refers to unknown parameter "${name}"`);
  if (!isBufferType(type)) throw contractError(`${label} entry "${statement}" is not a buffer`);
  // Ranges are half open, so their bounds are numbers rather than indices.
  for (const bound of [from, to]) {
    const boundType = typeOf(parseExpression(bound), env);
    if (boundType.kind !== "primitive" || !isNumericType(boundType.name)) {
      throw contractError(`${label} bound "${bound}" must be a number`);
    }
  }
}

function validateAliasing(statement: string, env: TypeEnv): void {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\s+mayAlias\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(true|false)$/.exec(statement.trim());
  if (match === null) throw contractError(`memory.aliasing entry "${statement}" is not "a mayAlias b = false"`);
  for (const name of [match[1], match[2]]) {
    const type = env.get(name);
    if (type === undefined) throw contractError(`memory.aliasing refers to unknown parameter "${name}"`);
    if (!isBufferType(type)) throw contractError(`memory.aliasing requires buffer parameters, got "${name}: ${typeToString(type)}"`);
  }
}

/* -------------------------------------------------------------------------- */
/* Reference implementation                                                   */
/* -------------------------------------------------------------------------- */

export function isTrue(value: Value): boolean {
  if (typeof value !== "boolean") {
    throw contractError(`condition evaluated to ${formatValue(value)}, expected true or false`);
  }
  return value;
}

/** Preconditions that the given arguments violate. */
export function preconditionFailures(parsed: ParsedContract, values: ReadonlyMap<string, Value>): string[] {
  const failures: string[] = [];
  for (const [index, requirement] of parsed.requires.entries()) {
    let outcome: Value;
    try {
      outcome = evaluate(requirement, { env: parsed.env, values });
    } catch (error) {
      failures.push(`${parsed.contract.requires[index]}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (!isTrue(outcome)) failures.push(parsed.contract.requires[index]);
  }
  return failures;
}

/**
 * The reference return value, derived from the contract's result definition. A
 * contract that carries a definition has none, and has no reference value: it
 * is the program it belongs to that says what it returns.
 */
export function referenceResult(parsed: ParsedContract, values: ReadonlyMap<string, Value>): Value {
  if (parsed.resultDefinition === null) {
    throw contractError(
      `${parsed.contract.function.name} states what it does, not what it returns`,
      "a contract with a definition is checked by the program it is part of",
    );
  }
  return evaluate(parsed.resultDefinition, { env: parsed.env, values });
}

/** Postconditions that the given result violates. */
export function postconditionFailures(parsed: ParsedContract, values: ReadonlyMap<string, Value>, result: Value): string[] {
  const failures: string[] = [];
  const bound = new Map(values);
  bound.set("result", result);
  for (const [index, condition] of parsed.ensures.entries()) {
    let outcome: Value;
    try {
      outcome = evaluate(condition, { env: parsed.env, values: bound });
    } catch (error) {
      failures.push(`${parsed.contract.ensures[index]}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (!isTrue(outcome)) failures.push(parsed.contract.ensures[index]);
  }
  return failures;
}

/* -------------------------------------------------------------------------- */
/* Numeric comparison                                                         */
/* -------------------------------------------------------------------------- */

const EPSILON: Record<string, number> = { f32: 1.1920929e-7, f64: 2.220446049250313e-16 };
const TOLERANCE_CAP: Record<string, number> = { f32: 1e-2, f64: 1e-9 };

/**
 * Relative tolerance for comparing a candidate result with the reference.
 *
 * Summation order is not part of the contract, so a vectorized or reassociated
 * implementation is allowed to differ in the last bits. The bound scales with
 * the number of accumulated terms and stays well below a real semantic error.
 */
export function comparisonTolerance(returns: TypeExpr, terms: number): number | null {
  if (returns.kind !== "primitive" || !isFloatType(returns.name)) return null;
  const epsilon = EPSILON[returns.name];
  const cap = TOLERANCE_CAP[returns.name];
  return Math.min(cap, 8 * Math.max(1, terms) * epsilon);
}

export function valuesMatch(expected: Value, actual: Value, tolerance: number | null): boolean {
  if (typeof expected === "bigint" || typeof actual === "bigint") {
    if (typeof expected === "bigint" && typeof actual === "bigint") return expected === actual;
    // The reference computes in the type its expression has and the candidate
    // in the type it returns, so one side is a whole number and the other a
    // double. They agree when the double is that whole number and no other,
    // and a double past 2^53 cannot name every whole number, so it is compared
    // as the number it is.
    const whole = typeof expected === "bigint" ? expected : actual;
    const floating = typeof expected === "bigint" ? actual : expected;
    if (typeof whole !== "bigint" || typeof floating !== "number") return false;
    if (!Number.isInteger(floating)) return false;
    if (floating > Number.MAX_SAFE_INTEGER || floating < Number.MIN_SAFE_INTEGER) return floating === Number(whole);
    return BigInt(floating) === whole;
  }
  if (typeof expected === "boolean" || typeof actual === "boolean") {
    return typeof expected === "boolean" && typeof actual === "boolean" && expected === actual;
  }
  if (typeof expected === "number" && typeof actual === "number") {
    if (Number.isNaN(expected) || Number.isNaN(actual)) return Number.isNaN(expected) && Number.isNaN(actual);
    if (!Number.isFinite(expected) || !Number.isFinite(actual)) return expected === actual;
    if (expected === actual) return true;
    if (tolerance === null) return false;
    const scale = Math.max(Math.abs(expected), Math.abs(actual));
    return Math.abs(expected - actual) <= tolerance * Math.max(scale, Number.MIN_VALUE);
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Default blocks                                                             */
/* -------------------------------------------------------------------------- */

export const DEFAULT_NUMERIC: NumericContract = {
  floatingPoint: "ieee754",
  rounding: "nearest",
  fastMath: false,
};

export const DEFAULT_OPTIMIZE: OptimizeSpec = {
  primary: "throughput",
  secondary: "size",
};

export function normalizeNumeric(partial: Partial<NumericContract> | undefined): NumericContract {
  if (partial === undefined) return { ...DEFAULT_NUMERIC };
  const fastMath = partial.fastMath ?? DEFAULT_NUMERIC.fastMath;
  if (fastMath !== false && fastMath !== "safe" && fastMath !== "aggressive") {
    throw contractError(`numeric.fastMath must be false, "safe" or "aggressive"`);
  }
  return { floatingPoint: "ieee754", rounding: "nearest", fastMath };
}

export function normalizeOptimize(partial: Partial<OptimizeSpec> | undefined): OptimizeSpec {
  const optimize: OptimizeSpec = {
    primary: partial?.primary ?? DEFAULT_OPTIMIZE.primary,
    ...(partial?.secondary === undefined ? {} : { secondary: partial.secondary }),
  };
  for (const objective of [optimize.primary, optimize.secondary]) {
    if (objective !== undefined && !OBJECTIVES.includes(objective)) {
      throw contractError(`unknown optimization objective "${objective}"`, `known: ${OBJECTIVES.join(", ")}`);
    }
  }
  return optimize;
}


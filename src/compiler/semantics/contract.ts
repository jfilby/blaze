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
import { wholeOf, type SemanticType } from "../core/semantic-ir.ts";

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
  u256: true,
  i256: true,
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
    case "u256":
      return 256;
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
    throw new CompilerError("ContractError", "contract", `unknown type "${name}"`, `known types: ${PRIMITIVE_TYPES.join(", ")}`, "", "", "");
  }
  return match;
}

function textTypeExpr(): TypeExpr {
  return { kind: "text" };
}

function voidTypeExpr(): TypeExpr {
  return { kind: "void" };
}

function sliceTypeExpr(of: TypeExpr): TypeExpr {
  return { kind: "slice", of };
}

function ptrTypeExpr(of: TypeExpr): TypeExpr {
  return { kind: "ptr", of };
}

function maskTypeExpr(of: TypeExpr): TypeExpr {
  return { kind: "mask", of };
}

function primitiveTypeExpr(name: PrimitiveTypeName): TypeExpr {
  return { kind: "primitive", name };
}

function refTypeExpr(of: TypeExpr | null): TypeExpr {
  return { kind: "ref", of };
}

function namedRefTypeExpr(of: TypeExpr | null, name: string): TypeExpr {
  return { kind: "ref", of, name };
}

function arrayTypeExpr(of: TypeExpr, length: number | null): TypeExpr {
  return { kind: "array", of, length };
}

export function parseType(text: string): TypeExpr {
  const source = text.trim();
  if (source === "text") return textTypeExpr();
  if (source === "void") return voidTypeExpr();
  // `typeText` writes a slice as `[]T` and a pointer as `T*`, and the text the
  // IR is written in is read back by this: the two forms have to name the type
  // they were written from.
  if (source.startsWith("[]")) return sliceTypeExpr(parseType(source.slice(2)));
  if (source.endsWith("[]")) return sliceTypeExpr(parseType(source.slice(0, -2)));
  if (source.endsWith("*")) return ptrTypeExpr(parseType(source.slice(0, -1)));
  const composite = /^([A-Za-z_][A-Za-z0-9_]*)\s*<(.+)>$/.exec(source);
  if (composite === null) {
    return primitiveTypeExpr(parsePrimitiveName(source));
  }

  const [, head, argument] = composite;
  if (head === "ptr") return ptrTypeExpr(parseType(argument));
  if (head === "slice") return sliceTypeExpr(parseType(argument));
  if (head === "mask") return maskTypeExpr(parseType(argument));
  if (head === "ref") {
    // `ref<any>` is a reference the source left unshaped, and `ref<Object1>`
    // names the object it points at, which is a layout rather than a type.
    const inner = argument.trim();
    if (inner === "any") return refTypeExpr(null);
    if (/^[A-Z][A-Za-z0-9_]*$/.test(inner)) return namedRefTypeExpr(null, inner);
    return refTypeExpr(parseType(inner));
  }
  if (head === "array") {
    const parts = argument.split(",");
    if (parts.length === 1) return arrayTypeExpr(parseType(parts[0]), null);
    if (parts.length === 2) {
      const length = Number.parseInt(parts[1].trim(), 10);
      // An array of no elements is the array an empty literal is, and a layout
      // states the type a field holds once it has been written.
      if (!Number.isInteger(length) || length < 0) {
        throw new CompilerError("ContractError", "contract", `invalid array length in "${text}"`, "", "", "", "");
      }
      return arrayTypeExpr(parseType(parts[0]), length);
    }
  }
  throw new CompilerError("ContractError", "contract", `unsupported type expression "${text}"`, "", "", "", "");
}

export function typeToString(type: TypeExpr): string {
  const fields = type as unknown as Record<string, unknown>;
  const kind = String(fields["kind"]);
  const of = fields["of"] as TypeExpr | null | undefined;
  const name = fields["name"] as string | undefined;
  const nameText = name === undefined ? undefined : String(name);
  const length = fields["length"] as number | null | undefined;
  if (kind === "primitive") return String(name);
  if (kind === "ptr" || kind === "slice" || kind === "mask") return `${kind}<${typeToString(of as TypeExpr)}>`;
  if (kind === "array") {
    const element = typeToString(of as TypeExpr);
    return length === null || length === undefined ? `array<${element}>` : `array<${element},${length}>`;
  }
  if (kind === "ref") {
    // The text codecs are compile-time markers: the frontend tracks one by a
    // name no contract can hold, and the value that crosses as one is the
    // zero the name holds.
    if (nameText === "__TextEncoder" || nameText === "__TextDecoder") return "f64";
    if (nameText !== undefined) return `ref<${nameText}>`;
    return of === null || of === undefined ? "ref<any>" : `ref<${typeToString(of)}>`;
  }
  if (kind === "text") return "text";
  return "void";
}

/**
 * How the contract type language spells a type the IR holds, which is the
 * language a signature is stated in. A buffer is a pointer to its first
 * element, which is what a caller hands over and what the body reads; the IR
 * writes the same type as a slice and the contract as the pointer it is.
 */
export function contractText(type: SemanticType): string {
  const fields = type as unknown as Record<string, unknown>;
  const kind = String(fields["kind"]);
  const name = fields["name"] as string | undefined;
  const nameText = name === undefined ? undefined : String(name);
  if (kind === "primitive") return nameText === undefined ? "" : nameText;
  if (kind === "text") return "text";
  if (kind === "ptr" || kind === "slice" || kind === "mask" || kind === "array") {
    const of = contractText(fields["of"] as SemanticType);
    const length = fields["length"] as number | null | undefined;
    return kind === "array" && length !== null && length !== undefined ? `array<${of},${length}>` : `${kind}<${of}>`;
  }
  if (kind === "ref") return nameText === undefined ? "ref<any>" : `ref<${nameText}>`;
  return "void";
}

export type BufferType = Extract<TypeExpr, { kind: "ptr" | "slice" | "array" | "mask" }>;

export function isBufferType(type: TypeExpr): type is BufferType {
  const kind = String((type as unknown as Record<string, unknown>)["kind"]);
  return kind === "ptr" || kind === "slice" || kind === "array" || kind === "mask";
}

/** Element type of a buffer type, or null for anything else. */
export function elementType(type: TypeExpr): TypeExpr | null {
  return isBufferType(type) ? (type as unknown as Record<string, unknown>)["of"] as TypeExpr : null;
}

/** The element type of a buffer type, refusing a type that is not one. */
export function bufferElement(type: TypeExpr): TypeExpr {
  if (isBufferType(type)) return (type as unknown as Record<string, unknown>)["of"] as TypeExpr;
  throw contractError(`${typeToString(type)} is not a buffer`);
}

/* -------------------------------------------------------------------------- */
/* Expressions                                                                */
/* -------------------------------------------------------------------------- */

export type ReduceOp = "sum" | "product" | "min" | "max";

export type Expr =
  | { t: "int"; value: Whole }
  | { t: "float"; value: number }
  | { t: "bool"; value: boolean }
  | { t: "null" }
  | { t: "var"; name: string }
  | { t: "index"; base: Expr; index: Expr }
  | { t: "slice"; base: Expr; start: Expr | null; stop: Expr | null; step: Expr | null }
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

type TokenKind = "number" | "ident" | "op" | "end";

/** One token of a condition, with its kind and the text the source wrote. */
class Token {
  readonly kind: TokenKind;
  readonly text: string;

  constructor(kind: TokenKind, text: string) {
    this.kind = kind;
    this.text = text;
  }
}

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
  ":",
];

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const character = String(source[index]);
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (/[0-9]/.test(character) || (character === "." && /[0-9]/.test(source[index + 1] ?? ""))) {
      const match = /^(?:0[xX][0-9a-fA-F]+|[0-9]*\.[0-9]+|[0-9]+)(?:[eE][+-]?[0-9]+)?/.exec(source.slice(index));
      if (match === null) {
        throw new CompilerError("ContractError", "contract", `bad number in "${source}"`, "", "", "", "");
      }
      tokens.push(new Token("number", match[0]));
      index += match[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(character)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(index));
      if (match === null) {
        throw new CompilerError("ContractError", "contract", `bad identifier in "${source}"`, "", "", "", "");
      }
      tokens.push(new Token("ident", match[0]));
      index += match[0].length;
      continue;
    }
    const operator = OPERATORS.find((candidate) => source.startsWith(candidate, index));
    if (operator === undefined) {
      throw new CompilerError("ContractError", "contract", `unexpected character "${character}" in expression "${source}"`, "", "", "", "");
    }
    tokens.push(new Token("op", operator));
    index += operator.length;
  }
  tokens.push(new Token("end", ""));
  return tokens;
}

const COMPARISONS: BinaryOp[] = ["==", "!=", "<", "<=", ">", ">="];

/** A reduced range, with its bounds and body. */
function reduceExpression(
  op: ReduceOp,
  varName: string,
  from: Expr,
  to: Expr,
  exclusive: boolean,
  body: Expr,
): Expr {
  return { t: "reduce", op, varName, from, to, exclusive, body };
}

/** A call of a contract function, with the arguments it passes. */
function callExpression(name: string, args: Expr[]): Expr {
  return { t: "call", name, args };
}

/** A number, text or name condition, with the value it holds. */
function floatExpression(value: number): Expr {
  return { t: "float", value };
}

function intExpression(value: Whole): Expr {
  return { t: "int", value };
}

function boolExpression(value: boolean): Expr {
  return { t: "bool", value };
}

function nullExpression(): Expr {
  return { t: "null" };
}

function variableExpression(name: string): Expr {
  return { t: "var", name };
}

/** A sliced value, with its bounds. */
function sliceExpression(base: Expr, start: Expr | null, stop: Expr | null, step: Expr | null): Expr {
  return { t: "slice", base, start, stop, step };
}

/** An indexed value, with the index it reads. */
function indexExpression(base: Expr, index: Expr): Expr {
  return { t: "index", base, index };
}

/** A unary condition, with the value it reads. */
function unaryExpression(op: "!" | "-", operand: Expr): Expr {
  return { t: "unary", op, operand };
}

/** A binary condition, with the values it joins. */
function binaryExpression(op: BinaryOp, left: Expr, right: Expr): Expr {
  return { t: "binary", op, left, right };
}

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
    return new CompilerError("ContractError", "contract", `${message} in expression "${this.source}"`, "", "", "", "");
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.acceptOp("||")) left = binaryExpression("||", left, this.parseAnd());
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseComparison();
    while (this.acceptOp("&&")) left = binaryExpression("&&", left, this.parseComparison());
    return left;
  }

  private parseComparison(): Expr {
    const left = this.parseAdditive();
    const token = this.peek();
    if (token.kind === "op" && COMPARISONS.includes(token.text as BinaryOp)) {
      this.next();
      return binaryExpression(token.text as BinaryOp, left, this.parseAdditive());
    }
    return left;
  }

  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    for (;;) {
      const token = this.peek();
      if (token.kind === "op" && (token.text === "+" || token.text === "-")) {
        this.next();
        left = binaryExpression(token.text as BinaryOp, left, this.parseMultiplicative());
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
        left = binaryExpression(token.text as BinaryOp, left, this.parseUnary());
        continue;
      }
      return left;
    }
  }

  private parseUnary(): Expr {
    if (this.acceptOp("!")) return unaryExpression("!", this.parseUnary());
    if (this.acceptOp("-")) return unaryExpression("-", this.parseUnary());
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let base = this.parsePrimary();
    while (this.acceptOp("[")) {
      if (this.peek().kind === "op" && (this.peek() as any).text === ":") {
        // base[:stop:step], base[::step], or base[:].
        this.next();
        let start: Expr | null = null;
        let stop: Expr | null = null;
        let step: Expr | null = null;
        if (this.peek().kind === "op" && (this.peek() as any).text === ":") {
          // base[::step] or base[:].
          this.next();
          if (!(this.peek().kind === "op" && (this.peek() as any).text === "]")) {
            step = this.parseOr();
          }
        } else if (!(this.peek().kind === "op" && (this.peek() as any).text === "]")) {
          // base[:stop] or base[:stop:step].
          stop = this.parseOr();
          if (this.acceptOp(":")) {
            if (!(this.peek().kind === "op" && (this.peek() as any).text === "]")) {
              step = this.parseOr();
            }
          }
        }
        this.expectOp("]");
        base = sliceExpression(base, start, stop, step);
      } else {
        const first = this.parseOr();
        if (this.acceptOp(":")) {
          // base[start:stop:step], base[start:], or base[start::step].
          let start: Expr | null = first;
          let stop: Expr | null = null;
          let step: Expr | null = null;
          if (!(this.peek().kind === "op" && (this.peek() as any).text === "]") && !(this.peek().kind === "op" && (this.peek() as any).text === ":")) {
            stop = this.parseOr();
          }
          if (this.acceptOp(":")) {
            if (!(this.peek().kind === "op" && (this.peek() as any).text === "]")) {
              step = this.parseOr();
            }
          }
          this.expectOp("]");
          base = sliceExpression(base, start, stop, step);
        } else {
          this.expectOp("]");
          base = indexExpression(base, first);
        }
      }
    }
    return base;
  }

  private parsePrimary(): Expr {
    const token = this.next();
    if (token.kind === "number") {
      if (/[.eE]/.test(token.text) && !/^0[xX]/.test(token.text)) return floatExpression(Number(token.text));
      return intExpression(wholeFromText(token.text));
    }
    if (token.kind === "op" && token.text === "(") {
      const inner = this.parseOr();
      this.expectOp(")");
      return inner;
    }
    if (token.kind === "ident") {
      if (token.text === "true" || token.text === "false") return boolExpression(token.text === "true");
      if (token.text === "null") return nullExpression();
      if (this.acceptOp("(")) return this.parseCall(token.text);
      return variableExpression(token.text);
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
      return reduceExpression(name, variable.text, from, to, exclusive, body);
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
    return callExpression(name, args);
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

/**
 * A whole number the evaluator carries: a sign and the magnitude it has.
 *
 * The contract language's integers are signed and can reach the top of the
 * 256-bit range, which no one machine word holds. The magnitude is an unsigned
 * 256-bit value; a sign is kept beside it, and every operation that wraps to a
 * contract type computes the two's-complement bits first, so a negative and an
 * unsigned value of the same bits are told apart by the type the source wrote.
 */
export interface Whole {
  readonly negative: boolean;
  readonly magnitude: bigint;
}

export type Value = Whole | bigint | number | boolean | string | null | BufferValue;

export function isWhole(value: Value): value is Whole {
  return typeof value === "object" && value !== null && (value as unknown as Record<string, unknown>)["magnitude"] !== undefined;
}

export function isBufferValue(value: Value): value is BufferValue {
  return typeof value === "object" && value !== null && (value as unknown as Record<string, unknown>)["values"] !== undefined && !isWhole(value);
}

export function formatValue(value: Value): string {
  if (isWhole(value)) return formatWhole(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "nan";
    if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
    return Number.isInteger(value) ? value.toString() : value.toPrecision(17);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return `"${value}"`;
  if (value === null) return "null";
  return `[${value.values.map(formatValue).join(", ")}]`;
}

/* -------------------------------------------------------------------------- */
/* Static typing                                                              */
/* -------------------------------------------------------------------------- */

export type TypeEnv = ReadonlyMap<string, TypeExpr>;

/** The name a contract's object exports, which is its name unless it is renamed. */
export function symbolOf(contract: FunctionContract): string {
  const fn = (contract as unknown as Record<string, unknown>)["function"] as Record<string, unknown>;
  const symbol = fn["symbol"];
  return symbol === undefined || symbol === null ? String(fn["name"]) : String(symbol);
}

export function signatureTypeEnv(contract: FunctionContract): TypeEnv {
  const env = new Map<string, TypeExpr>();
  const fn = (contract as unknown as Record<string, unknown>)["function"] as Record<string, unknown>;
  for (const param of fn["params"] as Record<string, unknown>[]) {
    const name = String(param["name"]);
    const type = String(param["type"]);
    env.set(name, type === "text" ? primitiveTypeExpr("usize") : parseType(type));
  }
  // The contract expression language has no string: a text is a number the
  // contract cannot say anything about, so it is the number a string is stored
  // as.
  env.set("result", String(fn["returns"]) === "text" ? primitiveTypeExpr("usize") : parseType(String(fn["returns"])));
  return env;
}

function contractError(message: string, detail?: string): CompilerError {
  return new CompilerError("ContractError", "contract", message, detail, "", "", "");
}

/* -------------------------------------------------------------------------- */
/* Whole numbers                                                              */
/* -------------------------------------------------------------------------- */

/** Every bit a whole number has. */
const WHOLE_MASK = 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffn;
/** The highest bit of a 256-bit whole number. */
const WHOLE_SIGN = 0x8000000000000000000000000000000000000000000000000000000000000000n;
/** A digit lookup missed: a value no digit and no magnitude can take. */
const NO_DIGIT = WHOLE_MASK;
/** The double at 2^256, which no 256-bit whole number reaches. */
const WHOLE_LIMIT = 115792089237316195423570985008687907853269984665640564039457584007913129639936;

/** A whole number with nothing in it. */
function zeroWhole(): Whole {
  return { negative: false, magnitude: 0n };
}

/** A whole number holding the small integer a count or a length names. */
function wholeOfNumber(value: number): Whole {
  if (!Number.isFinite(value)) throw contractError(`a count must be finite, got ${value}`);
  if (value === 0) return zeroWhole();
  const negative = value < 0;
  const magnitude = Math.abs(Math.trunc(value));
  if (magnitude >= WHOLE_LIMIT) return { negative, magnitude: WHOLE_MASK };
  const text = `${magnitude}`;
  return { negative, magnitude: wholeToBigInt(wholeFromDecimal(text)) };
}

/** The whole number represented by a run of decimal digits. */
function wholeFromDecimal(text: string): Whole {
  let magnitude = 0n;
  let at = 0;
  while (at < text.length) {
    const digit = digitOf(String(text[at]));
    at += 1;
    if (digit === NO_DIGIT) throw contractError(`"${text}" is not a number`);
    if (digit >= 10n) throw contractError(`"${text}" is not a decimal number`);
    magnitude = (magnitude * 10n + digit) & WHOLE_MASK;
  }
  return { negative: false, magnitude };
}

/** The value of one written digit, or NO_DIGIT where the character is none. */
function digitOf(character: string): bigint {
  if (character === "0") return 0n;
  if (character === "1") return 1n;
  if (character === "2") return 2n;
  if (character === "3") return 3n;
  if (character === "4") return 4n;
  if (character === "5") return 5n;
  if (character === "6") return 6n;
  if (character === "7") return 7n;
  if (character === "8") return 8n;
  if (character === "9") return 9n;
  const lower = character.toLowerCase();
  if (lower === "a") return 10n;
  if (lower === "b") return 11n;
  if (lower === "c") return 12n;
  if (lower === "d") return 13n;
  if (lower === "e") return 14n;
  if (lower === "f") return 15n;
  return NO_DIGIT;
}

/** The character a digit is written as, for a digit below sixteen. */
function digitText(digit: bigint): string {
  if (digit === 0n) return "0";
  if (digit === 1n) return "1";
  if (digit === 2n) return "2";
  if (digit === 3n) return "3";
  if (digit === 4n) return "4";
  if (digit === 5n) return "5";
  if (digit === 6n) return "6";
  if (digit === 7n) return "7";
  if (digit === 8n) return "8";
  if (digit === 9n) return "9";
  if (digit === 10n) return "a";
  if (digit === 11n) return "b";
  if (digit === 12n) return "c";
  if (digit === 13n) return "d";
  if (digit === 14n) return "e";
  return "f";
}

/** A whole number written in the source, decimal or hexadecimal. */
function wholeFromText(text: string): Whole {
  let at = 0;
  let negative = false;
  if (String(text[at]) === "-") {
    negative = true;
    at += 1;
  } else if (String(text[at]) === "+") {
    at += 1;
  }
  let base = 10n;
  let baseNumber = 10;
  if (String(text[at]) === "0" && (String(text[at + 1]) === "x" || String(text[at + 1]) === "X")) {
    base = 16n;
    baseNumber = 16;
    at += 2;
  }
  let magnitude = 0n;
  while (at < text.length) {
    const character = String(text[at]);
    at += 1;
    if (character === "_") continue;
    const digit = digitOf(character);
    if (digit === NO_DIGIT || digit >= BigInt(baseNumber)) {
      throw contractError(`"${text}" is not a number`);
    }
    magnitude = (magnitude * base + digit) & WHOLE_MASK;
  }
  return { negative: negative && magnitude !== 0n, magnitude };
}

/** A whole number as the digits it is, with a minus in front of a negative. */
function formatWhole(value: Whole): string {
  const fields = value as unknown as Record<string, unknown>;
  const negative = fields["negative"] as boolean;
  let magnitude = fields["magnitude"] as bigint;
  if (magnitude === 0n) return "0";
  let text = "";
  while (magnitude > 0n) {
    const digit = magnitude % 10n;
    text = digitText(digit) + text;
    magnitude = magnitude / 10n;
  }
  return negative ? `-${text}` : text;
}

/** A whole number as a double, through the decimal the C library reads. */
function wholeToNumber(value: Whole): number {
  return Number(formatWhole(value));
}

/** The two's-complement bits a whole number is, at 256 bits. */
function wholeBits(value: Whole): bigint {
  const fields = value as unknown as Record<string, unknown>;
  const negative = fields["negative"] as boolean;
  const magnitude = fields["magnitude"] as bigint;
  if (!negative) return magnitude & WHOLE_MASK;
  return ((WHOLE_MASK - magnitude) + 1n) & WHOLE_MASK;
}

/** The whole number a 256-bit two's-complement value names. */
function wholeFromBits(bits: bigint): Whole {
  const low = bits & WHOLE_MASK;
  if ((low & WHOLE_SIGN) !== 0n) {
    const magnitude = ((WHOLE_MASK - low) + 1n) & WHOLE_MASK;
    return { negative: magnitude !== 0n, magnitude };
  }
  return { negative: false, magnitude: low };
}

/** The bits a type of the given width keeps. */
function widthMask(width: number): bigint {
  if (width >= 256) return WHOLE_MASK;
  if (width === 8) return 0xffn;
  if (width === 16) return 0xffffn;
  if (width === 32) return 0xffffffffn;
  return 0xffffffffffffffffn;
}

/** The bit that says a signed value of the given width is negative. */
function widthSign(width: number): bigint {
  if (width >= 256) return WHOLE_SIGN;
  if (width === 8) return 0x80n;
  if (width === 16) return 0x8000n;
  if (width === 32) return 0x80000000n;
  return 0x8000000000000000n;
}

/** The whole number a type holds, from the bits an operation computed. */
function wrapWhole(value: Whole, name: PrimitiveTypeName): Whole {
  if (name === "bool") {
    const bits = wholeBits(value) & WHOLE_MASK;
    return { negative: false, magnitude: bits === 0n ? 0n : 1n };
  }
  const width = integerBits(name);
  const mask = widthMask(width);
  const low = wholeBits(value) & mask;
  if (!isSignedType(name)) return { negative: false, magnitude: low };
  const sign = widthSign(width);
  if ((low & sign) !== 0n) {
    const magnitude = ((mask - low) + 1n) & mask;
    return { negative: true, magnitude };
  }
  return { negative: false, magnitude: low };
}

/** The whole number a type holds, from a 256-bit two's-complement value. */
function wrapWholeBits(bits: bigint, name: PrimitiveTypeName): Whole {
  return wrapWhole(wholeFromBits(bits), name);
}

/** The whole number an external test or harness value names. */
function wholeOfValue(value: bigint | Whole): Whole {
  if (isWhole(value)) return value;
  if (value < 0n) return { negative: true, magnitude: (0n - value) & WHOLE_MASK };
  return { negative: false, magnitude: value & WHOLE_MASK };
}

/** Left compared with right, as the mathematical values they are. */
function compareWhole(left: Whole, right: Whole): number {
  const leftFields = left as unknown as Record<string, unknown>;
  const rightFields = right as unknown as Record<string, unknown>;
  const leftNegative = leftFields["negative"] as boolean;
  const rightNegative = rightFields["negative"] as boolean;
  const leftMagnitude = leftFields["magnitude"] as bigint;
  const rightMagnitude = rightFields["magnitude"] as bigint;
  if (leftNegative !== rightNegative) return leftNegative ? -1 : 1;
  if (leftMagnitude === rightMagnitude) return 0;
  const less = leftMagnitude < rightMagnitude;
  if (leftNegative) return less ? 1 : -1;
  return less ? -1 : 1;
}

/** Whether a whole number is the zero. */
function wholeIsZero(value: Whole): boolean {
  return (value as unknown as Record<string, unknown>)["magnitude"] === 0n;
}

/** The bits the sum, difference or product of two whole numbers has. */
function wholeAdd(left: Whole, right: Whole): bigint {
  return (wholeBits(left) + wholeBits(right)) & WHOLE_MASK;
}

function wholeSubtract(left: Whole, right: Whole): bigint {
  return (wholeBits(left) - wholeBits(right)) & WHOLE_MASK;
}

function wholeMultiply(left: Whole, right: Whole): bigint {
  return (wholeBits(left) * wholeBits(right)) & WHOLE_MASK;
}

/** The quotient two whole numbers have, truncating toward zero as the language does. */
function wholeDivide(left: Whole, right: Whole): Whole {
  if (wholeIsZero(right)) throw contractError("division by zero");
  const leftFields = left as unknown as Record<string, unknown>;
  const rightFields = right as unknown as Record<string, unknown>;
  const magnitude = (leftFields["magnitude"] as bigint) / (rightFields["magnitude"] as bigint);
  const negative = magnitude !== 0n && leftFields["negative"] !== rightFields["negative"];
  return { negative, magnitude };
}

/** The whole number a double that is already an integer names. */
function wholeFromIntegerFloat(value: number): Whole {
  if (value === 0) return zeroWhole();
  const negative = value < 0;
  let remaining = Math.abs(value);
  if (remaining >= WHOLE_LIMIT) return { negative, magnitude: WHOLE_MASK };
  // A double above 2^53 names an integer only with trailing zero bits, and
  // its decimal text is the shortest that round trips, not its value. Halving
  // it until the digits are exact, then multiplying them back, keeps every
  // bit the double holds.
  let shift = 0;
  while (remaining > 9007199254740992) {
    remaining = remaining / 2;
    shift += 1;
  }
  let whole = wholeOfNumber(remaining);
  while (shift > 0) {
    whole = wholeFromBits(wholeMultiply(whole, wholeOfNumber(2)));
    shift -= 1;
  }
  if (negative) return wholeFromBits((0n - wholeBits(whole)) & WHOLE_MASK);
  return whole;
}


/** A whole number against a double, exactly, including values past 2^53. */
function compareWholeToFloat(whole: Whole, float: number): number {
  if (Number.isNaN(float)) return 0 / 0;
  if (float === 1 / 0) return -1;
  if (float === -1 / 0) return 1;
  if (float > 0 && float >= WHOLE_LIMIT) return -1;
  if (float < 0 && -float >= WHOLE_LIMIT) return 1;
  if (!Number.isInteger(float)) {
    const floor = wholeFromIntegerFloat(Math.floor(float));
    return compareWhole(whole, floor) <= 0 ? -1 : 1;
  }
  return compareWhole(whole, wholeFromIntegerFloat(float));
}

/** A static type as seen by the type checker; `null` is a type of its own. */
export interface NullType {
  kind: "null";
}

export type StaticType = TypeExpr | NullType;

function describeType(type: StaticType): string {
  return String((type as unknown as Record<string, unknown>)["kind"]) === "null" ? "null" : typeToString(type as TypeExpr);
}

function numericType(left: StaticType, right: StaticType): TypeExpr {
  const leftFields = left as unknown as Record<string, unknown>;
  const rightFields = right as unknown as Record<string, unknown>;
  const leftKind = String(leftFields["kind"]);
  const rightKind = String(rightFields["kind"]);
  const leftName = leftFields["name"] as PrimitiveTypeName;
  const rightName = rightFields["name"] as PrimitiveTypeName;
  if (leftKind !== "primitive" || !isNumericType(leftName) || rightKind !== "primitive" || !isNumericType(rightName)) {
    throw contractError(`arithmetic requires numeric operands, got ${describeType(left)} and ${describeType(right)}`);
  }
  if (isFloatType(leftName) || isFloatType(rightName)) {
    return primitiveTypeExpr(isFloatType(leftName) ? leftName : (rightName as "f32" | "f64"));
  }
  return primitiveTypeExpr(widerInteger(leftName, rightName));
}

/**
 * What `==` and `!=` may compare: two numbers, two booleans, two nulls, or a
 * null and something that can be one. The operands are checked because the
 * values are compared by their own kinds later, where a contract that reached
 * the evaluator said nothing useful about what it meant.
 */
function comparable(op: string, left: StaticType, right: StaticType): void {
  const leftFields = left as unknown as Record<string, unknown>;
  const rightFields = right as unknown as Record<string, unknown>;
  const leftKind = String(leftFields["kind"]);
  const rightKind = String(rightFields["kind"]);
  if (leftKind === "text" && rightKind === "text") return;
  if (leftKind === "primitive" && rightKind === "primitive") {
    if (isNumericType(leftFields["name"] as PrimitiveTypeName) && isNumericType(rightFields["name"] as PrimitiveTypeName)) return;
    if (String(leftFields["name"]) === "bool" && String(rightFields["name"]) === "bool") return;
  } else if (leftKind === "null" && rightKind === "null") {
    return;
  } else if (leftKind === "null" || rightKind === "null") {
    const otherKind = leftKind === "null" ? rightKind : leftKind;
    if (otherKind === "ptr" || otherKind === "slice" || otherKind === "array" || otherKind === "ref") return;
  }
  throw contractError(`${op} requires comparable operands, got ${describeType(left)} and ${describeType(right)}`);
}
/**
 * The whole number two whole numbers are computed as, which is the rule the
 * semantic IR types the same expression with (`core/semantic-ir.ts:wholeOf`).
 * The evaluator and the backends answer one program, so the two read the rule
 * from one place rather than each keeping its own.
 */
function widerInteger(left: PrimitiveTypeName, right: PrimitiveTypeName): PrimitiveTypeName {
  return wholeOf(left, right);
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
      return { kind: "null" };
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
    case "slice": {
      const base = typeOf(expression.base, env);
      if (base.kind !== "ptr" && base.kind !== "slice" && base.kind !== "array") {
        throw contractError(`cannot slice ${describeType(base)}`);
      }
      // A slice of a buffer is a buffer of the same element type.
      return base;
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

function wrapInteger(value: Whole, name: PrimitiveTypeName): Whole {
  return wrapWholeBits(wholeBits(value), name);
}

function roundFloat(value: number, type: StaticType): number {
  if (type.kind === "primitive" && type.name === "f32") return Math.fround(value);
  return value;
}

function asNumber(value: Value, type: StaticType): number {
  if (isWhole(value)) return wholeToNumber(value);
  if (typeof value === "bigint") return wholeToNumber(wholeOfValue(value));
  if (typeof value === "number") return value;
  throw contractError(`expected a number, got ${formatValue(value)} (${describeType(type)})`);
}

function compareValues(left: Value, right: Value): number {
  const leftWhole = isWhole(left) ? left : typeof left === "bigint" ? wholeOfValue(left) : null;
  const rightWhole = isWhole(right) ? right : typeof right === "bigint" ? wholeOfValue(right) : null;
  if (leftWhole !== null && rightWhole !== null) return compareWhole(leftWhole, rightWhole);
  if (typeof left === "number" && typeof right === "number") {
    // Nothing is ordered against not-a-number. Answering that nothing is
    // greater made every `>` and `>=` on a NaN true, so a result of NaN
    // satisfied a postcondition it broke, and a comparison that should fail
    // let an unchecked input through.
    if (Number.isNaN(left) || Number.isNaN(right)) return 0 / 0;
    return left < right ? -1 : left > right ? 1 : 0;
  }
  if (leftWhole !== null && typeof right === "number") return compareWholeToFloat(leftWhole, right);
  if (typeof left === "number" && rightWhole !== null) return -compareWholeToFloat(rightWhole, left);
  throw contractError(`cannot compare ${formatValue(left)} with ${formatValue(right)}`);
}

/**
 * Compares a 64-bit integer with a double without losing precision: every
 * double at or above 2^53 is an exact integer, so both sides can be brought to
 * exact integers before comparing.
 */

function valuesEqual(left: Value, right: Value): boolean {
  if (isBufferValue(left) || isBufferValue(right) || left === null || right === null) {
    return left === right;
  }
  // A text is the word it says itself: it compares the way it was written,
  // which is what the harness read off the line and what the reference said.
  if (typeof left === "string" || typeof right === "string") {
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
      const held = context.values.get(expression.name) as Value;
      return typeof held === "bigint" ? wholeOfValue(held) : held;
    }
    case "index": {
      const base = evaluate(expression.base, context);
      if (!isBufferValue(base)) {
        throw contractError(`cannot index ${formatValue(base)}`);
      }
      const indexValue = evaluate(expression.index, context);
      const indexWhole = isWhole(indexValue) ? indexValue : typeof indexValue === "bigint" ? wholeOfValue(indexValue) : null;
      if (indexWhole === null) {
        throw contractError(`index must be an integer, got ${formatValue(indexValue)}`);
      }
      if (compareWhole(indexWhole, zeroWhole()) < 0 || compareWhole(indexWhole, wholeOfNumber(base.values.length)) >= 0) {
        throw contractError(
          `index ${formatValue(indexWhole)} out of bounds for ${expression.base.t === "var" ? expression.base.name : "expression"} of length ${base.values.length}`,
        );
      }
      return base.values[wholeToNumber(indexWhole)];
    }
    case "slice": {
      const base = evaluate(expression.base, context);
      if (!isBufferValue(base)) {
        throw contractError(`cannot slice ${formatValue(base)}`);
      }
      const len = base.values.length;
      const sliceBound = (bound: Expr | null, defaultValue: number): number => {
        if (bound === null) return defaultValue;
        const value = evaluate(bound, context);
        const whole = isWhole(value) ? value : typeof value === "bigint" ? wholeOfValue(value) : null;
        if (whole === null) {
          throw contractError(`slice bound must be an integer, got ${formatValue(value)}`);
        }
        let n = wholeToNumber(whole);
        if (n < 0) n = len + n;
        return n;
      };
      let step = 1;
      if (expression.step !== null) {
        const stepValue = evaluate(expression.step, context);
        const stepWhole = isWhole(stepValue) ? stepValue : typeof stepValue === "bigint" ? wholeOfValue(stepValue) : null;
        if (stepWhole === null) {
          throw contractError(`slice step must be an integer, got ${formatValue(stepValue)}`);
        }
        step = wholeToNumber(stepWhole);
      }
      if (step === 0) {
        throw contractError("slice step must not be zero");
      }
      const start = sliceBound(expression.start, step > 0 ? 0 : len - 1);
      const stop = sliceBound(expression.stop, step > 0 ? len : -1);
      const sliced: Value[] = [];
      if (step > 0) {
        for (let i = Math.max(0, Math.min(start, len)); i < Math.max(0, Math.min(stop, len)); i += step) {
          sliced.push(base.values[i]);
        }
      } else {
        for (let i = Math.min(len - 1, Math.max(start, -1)); i > Math.max(-1, Math.min(stop, -1)); i += step) {
          sliced.push(base.values[i]);
        }
      }
      return { kind: "buffer", type: base.type, values: sliced } as Value;
    }
    case "call": {
      if (expression.name === "len") {
        const argument = evaluate(expression.args[0], context);
        if (!isBufferValue(argument)) {
          throw contractError(`len() requires a buffer, got ${formatValue(argument)}`);
        }
        return wholeOfNumber(argument.values.length);
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
      const fromWhole = isWhole(from) ? from : typeof from === "bigint" ? wholeOfValue(from) : null;
      if (fromWhole === null) {
        throw contractError("the lower bound of a reduction must be an integer", `got ${formatValue(from)}`);
      }
      const count = reductionCount(fromWhole, to, expression.exclusive);
      const innerValues = new Map(context.values);
      let accumulator: Value | null = null;
      const bodyEnv = new Map(context.env);
      bodyEnv.set(expression.varName, { kind: "primitive", name: "usize" });
      const bodyType = typeOf(expression.body, bodyEnv);
      if (wholeToNumber(count) > MAXIMUM_REDUCTION_TERMS) {
        throw contractError(
          `reduction over ${count} terms exceeds the limit of ${MAXIMUM_REDUCTION_TERMS}`,
          "the bounds are derived from the test inputs, which are far larger than the contract intends",
        );
      }
      for (let term = zeroWhole(); compareWhole(term, count) < 0; term = wholeFromBits(wholeAdd(term, wholeOfNumber(1)))) {
        const index = wholeFromBits(wholeAdd(fromWhole, term));
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
        accumulator = isIntegerType(bodyType.name) ? wholeOfNumber(one) : roundFloat(one, bodyType);
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
        const whole = isWhole(operand) ? operand : typeof operand === "bigint" ? wholeOfValue(operand) : null;
        if (whole === null) throw contractError(`unary - requires an integer, got ${formatValue(operand)}`);
        const bits = (0n - wholeBits(whole)) & WHOLE_MASK;
        return wrapInteger(wholeFromBits(bits), type.name);
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
function reductionCount(from: Whole, to: Value, exclusive: boolean): Whole {
  const target = isWhole(to) ? to : typeof to === "bigint" ? wholeOfValue(to) : null;
  if (target !== null) {
    if (compareWhole(target, from) <= 0) return zeroWhole();
    const span = wholeFromBits(wholeSubtract(target, from));
    if (exclusive) return span;
    return wholeFromBits(wholeAdd(span, wholeOfNumber(1)));
  }
  if (typeof to !== "number" || !Number.isFinite(to)) {
    throw contractError(`a reduction bound must be a finite number, got ${formatValue(to)}`);
  }
  const remaining = to - wholeToNumber(from);
  if (exclusive) return wholeOfNumber(remaining > 0 ? Math.ceil(remaining) : 0);
  return wholeOfNumber(remaining >= 0 ? Math.floor(remaining) + 1 : 0);
}

function applyReduce(op: ReduceOp, accumulator: Value, value: Value, bodyType: StaticType): Value {
  if (op === "min") return compareValues(value, accumulator) < 0 ? value : accumulator;
  if (op === "max") return compareValues(value, accumulator) > 0 ? value : accumulator;
  if (op === "sum") {
    const left = isWhole(accumulator) ? accumulator : typeof accumulator === "bigint" ? wholeOfValue(accumulator) : null;
    const right = isWhole(value) ? value : typeof value === "bigint" ? wholeOfValue(value) : null;
    if (left !== null && right !== null) return wholeFromBits(wholeAdd(left, right));
    return roundFloat(asNumber(accumulator, bodyType) + asNumber(value, bodyType), bodyType);
  }
  const left = isWhole(accumulator) ? accumulator : typeof accumulator === "bigint" ? wholeOfValue(accumulator) : null;
  const right = isWhole(value) ? value : typeof value === "bigint" ? wholeOfValue(value) : null;
  if (left !== null && right !== null) return wholeFromBits(wholeMultiply(left, right));
  return roundFloat(asNumber(accumulator, bodyType) * asNumber(value, bodyType), bodyType);
}

function normalizeReduceResult(value: Value, op: ReduceOp, bodyType: StaticType): Value {
  // The reduction is held at the type it has, which is wider than the elements
  // it sums: a sum of 100 bytes of 5 is 500, and not 244.
  if (op !== "sum" && op !== "product" || bodyType.kind === "null") return value;
  const type = op === "sum" ? sumType(bodyType) : productType(bodyType);
  if (type.kind === "primitive" && isIntegerType(type.name)) {
    const whole = isWhole(value) ? value : typeof value === "bigint" ? wholeOfValue(value) : null;
    if (whole !== null) return wrapInteger(whole, type.name);
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
    const leftWhole = isWhole(left) ? left : typeof left === "bigint" ? wholeOfValue(left) : null;
    const rightWhole = isWhole(right) ? right : typeof right === "bigint" ? wholeOfValue(right) : null;
    if (leftWhole === null || rightWhole === null) {
      throw contractError(`integer arithmetic requires integer operands, got ${formatValue(left)} and ${formatValue(right)}`);
    }
    if (expression.op === "+") return wrapInteger(wholeFromBits(wholeAdd(leftWhole, rightWhole)), type.name);
    if (expression.op === "-") return wrapInteger(wholeFromBits(wholeSubtract(leftWhole, rightWhole)), type.name);
    if (expression.op === "*") return wrapInteger(wholeFromBits(wholeMultiply(leftWhole, rightWhole)), type.name);
    if (wholeIsZero(rightWhole)) throw contractError("division by zero");
    return wrapInteger(wholeDivide(leftWhole, rightWhole), type.name);
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
  // The value a promise carries travels beside the signature, so a contract
  // that states one states a type the contract language reads.
  if (contract.promise !== undefined) parseType(contract.promise);
  const seen = new Set<string>();
  for (const param of contract.function.params) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(param.name)) throw contractError(`invalid parameter name "${param.name}"`);
    if (seen.has(param.name)) throw contractError(`duplicate parameter "${param.name}"`);
    seen.add(param.name);
    if (param.type !== "text") parseType(param.type);
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
  const value = evaluate(parsed.resultDefinition, { env: parsed.env, values });
  // Callers compare this value with the candidate's printed result, which is a
  // host whole number, so a Whole leaves through the boundary as one.
  return isWhole(value) ? wholeToBigInt(value) : value;
}

/** The host form of a whole number: its sign and its magnitude. */
function wholeToBigInt(value: Whole): bigint {
  const fields = value as unknown as Record<string, unknown>;
  const magnitude = fields["magnitude"] as bigint;
  return fields["negative"] === true ? -magnitude : magnitude;
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
  const expectedWhole = isWhole(expected) ? expected : typeof expected === "bigint" ? wholeOfValue(expected) : null;
  const actualWhole = isWhole(actual) ? actual : typeof actual === "bigint" ? wholeOfValue(actual) : null;
  if (expectedWhole !== null || actualWhole !== null) {
    if (expectedWhole !== null && actualWhole !== null) return compareWhole(expectedWhole, actualWhole) === 0;
    // The reference computes in the type its expression has and the candidate
    // in the type it returns, so one side is a whole number and the other a
    // double. They agree when the double is that whole number and no other.
    if (expectedWhole !== null && typeof actual === "number") return compareWholeToFloat(expectedWhole, actual) === 0;
    if (actualWhole !== null && typeof expected === "number") return compareWholeToFloat(actualWhole, expected) === 0;
    return false;
  }
  // A text result is the word it says itself: it matches the word the
  // candidate printed and nothing about a number.
  if (typeof expected === "string" || typeof actual === "string") {
    return typeof expected === "string" && typeof actual === "string" && expected === actual;
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
    return Math.abs(expected - actual) <= tolerance * Math.max(scale, 5e-324);
  }
  if (expected === null || actual === null) return expected === actual;
  if (isBufferValue(expected) && isBufferValue(actual)) {
    if (expected.values.length !== actual.values.length) return false;
    return expected.values.every((value, index) => valuesMatch(value, actual.values[index] as Value, tolerance));
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


/**
 * Resolving a program into the semantic IR.
 *
 * The contract phase hands back the statements of a program exactly as the
 * frontend parsed them: names, literals, operators and calls, with no types.
 * This module turns them into the semantic IR, by resolving every call against
 * the program contract, every name against the scope it was declared in, and
 * every value against the type it is used at. What comes out is a program a
 * backend can read: every value states the type it is, every block ends in
 * exactly one way out, and nothing names a target.
 *
 * It happens in two steps. The first resolves the source into a tree of names,
 * types and calls, which is where every refusal is decided: a number no use has
 * fixed is a double until one does, a name is the variable it was declared as,
 * and an array is written out in the element type the use of it fixes. The
 * second writes that tree down as the IR, which is where the choices a target
 * used to make are made once and for every target instead: what a block owns
 * and frees, where a loop is left for, which value a name is written under
 * when a program writes one arm of a short-circuit operator out twice, and how
 * a value is printed.
 *
 * A program is driven, not interpreted, so a name is written down once: a
 * declaration names the variable the program declares, and every later use of
 * that name is that variable. A name declared again in a nested block is a
 * different variable, which is what the source means by it.
 *
 * ## Numbers
 *
 * A program prints numbers the way the language it was written in prints them,
 * because the build compares the program's output against the output of the
 * source running on its own toolchain. Both drivers therefore format a number
 * the way the console of the source language prints one:
 *
 *   - zero prints as `0`, and a negative zero as `-0`, which is what the
 *     source prints for it
 *   - the digits are the shortest decimal that reads back as the same double
 *   - a value with an exponent from -6 up to 20 is written in full
 *     (`0.00001`, `123456789012345680000`), and anything outside that range in
 *     exponential form (`1e-7`, `1e+21`)
 *   - a negative value carries a leading `-`
 *   - a value that is not finite prints as `Infinity`, `-Infinity` or `NaN`,
 *     which have no decimal to be the shortest of
 *
 * Integers keep their integral form (`70`, not `70.0`), which is what a length
 * or a count prints as.
 *
 * ## Types
 *
 * A number written in the source is a double, as it is in TypeScript, unless a
 * use fixes it to something else: passing it to a `u32` parameter declares it
 * as one. A whole number the program counts with is whole: a length, a loop
 * index, a value read from a whole array. `/` and `**` are always floating
 * point, because `7 / 2` is `3.5` in the language the source was written in.
 *
 * A string is a value the program builds, not a number, so it has no contract
 * type: it is declared as a string, and `+` on a string is concatenation.
 */

import { contractText, parseType, typeToString } from "./contract.ts";
import { isWholeNumberText } from "./objects.ts";
import type { LiteralKeys } from "./program-objects.ts";
import { statementBlocksOf, statementValues, walkValues } from "../core/semantic-ir.ts";
import { CompilerError } from "../core/errors.ts";
import type { CaptureRef } from "../core/semantic-ir.ts";
import { mapTypeScriptType, PROGRAM_ENTRY_SYMBOL } from "./typescript.ts";
import type {
  ProgramAssignOp,
  ProgramBody,
  ProgramBinaryOp,
  ProgramStatement,
  ProgramText,
  ProgramUnaryOp,
  ProgramValue,
} from "./module.ts";
import type { CallEdge, Effect, FunctionSignature, ObjectLayout, PrimitiveTypeName, ProgramContract, TypeExpr } from "../core/types.ts";
import type { Expression, Statement } from "../core/ir.ts";
import { ARGV, ARGV_LENGTH, SHARED, builtinFor, type BuiltinSignature } from "./builtins.ts";
import { rulesFor, type LanguageRules } from "./language.ts";
import {
  BOOLEAN,
  NUMERIC,
  TEXT,
  VOID,
  commonNumber,
  isBoolean,
  isCarriedAsAddress,
  isFloat,
  isReference,
  isSequence,
  isWide,
  isTextType,
  isWhole,
  wholeOf,
  valueKind,
  type ArithOp,
  type CompareOp,
  type SemanticBlock,
  type SemanticCall,
  type SemanticFunction,
  type SemanticProgram,
  type SemanticSlot,
  type SemanticStatement,
  type SemanticType,
  type SemanticValue,
  type UnaryOp,
  compoundAsBinary,
  roundedBound,
} from "../core/semantic-ir.ts";
import { foldWhole, modularReduction, wholeConstant, wholePower, wholeText, wrapped } from "./whole-arithmetic.ts";

/* -------------------------------------------------------------------------- */
/* What a name holds                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A number, whole or not. `type` stays null until a use fixes it.
 *
 * `bigint` is what the language's own `1n` is and nothing else: a whole number
 * the program wrote with an `n` beside it. It is a flag rather than a type of
 * its own because the IR holds it as the `i64` it is, and what the flag adds is
 * the two things a machine word does not say on its own — the arithmetic is
 * whole rather than floating, and the value is written with an `n` after it.
 * A whole number that is not a bigint is one a whole operator produced, and it
 * prints and computes as the number the language prints and computes.
 */
interface NumberHeld {
  kind: "number";
  /** The name the program declares it under. */
  name: string;
  mutable: boolean;
  type: PrimitiveTypeName | null;
  text: string;
  bigint?: true;
}

/** An array the program allocated, written out element by element. */
interface ArrayHeld {
  kind: "array";
  name: string;
  mutable: boolean;
  element: PrimitiveTypeName | null;
  /** How many elements it holds, or null when the program settled on the count. */
  length: number | null;
  /** The elements as they were written, in the type the array is used at. */
  values: DraftValue[];
}

/** A reference to an object one of the compiled functions returned. */
interface ObjectHeld {
  kind: "object";
  name: string;
  mutable: boolean;
  type: TypeExpr;
  /**
   * The value a promise held carries, or undefined when the name does not hold
   * a promise. A promise is a handle the runtime owns, so the name holds it as
   * a reference; what `await` reads out of it is the value here.
   */
  promise?: { payload: TypeExpr };
}

/** A string, as text when the program wrote it out, or built at run time. */
interface TextHeld {
  kind: "text";
  name: string;
  mutable: boolean;
  /** The text as written, or null when the program built the string. */
  value: string | null;
  /** True when this mutable text local is stored in a shared cell (boxed). */
  boxed?: boolean;
  /**
   * True when the string is one the function was given rather than one it
   * declared. A function is given a string by value, and a function that
   * reads it is given the string: the binding of a parameter is the
   * parameter's own, not one a nested function shares with it.
   */
  parameter?: boolean;
}

/** The command line bound to a name, as `const args = process.argv.slice(n)`;
 *  `args[i]` reads argument `i + offset` of it. */
interface ArgvHeld {
  kind: "argv";
  name: string;
  mutable: boolean;
  /** How many leading arguments the slice skips. */
  offset: number;
}

/** What a declared name holds. */
type Held = NumberHeld | ArrayHeld | ObjectHeld | TextHeld | ArgvHeld;

/** A name as a declaration states it, before it is declared. */
type WithoutName<T> = T extends unknown ? Omit<T, "name"> : never;

/* -------------------------------------------------------------------------- */
/* What a program resolves to                                                 */
/* -------------------------------------------------------------------------- */

/** A call to a function the program compiled, with every argument placed. */
interface DraftCall {
  name: string;
  signature: FunctionSignature;
  args: DraftValue[];
  returns: SemanticType;
  /** What the call does beyond computing its result. */
  effects: Effect[];
  /** A function the compiler itself provides, as `Math.abs` is. */
  builtin: boolean;
  /** The grid a kernel is launched on, when the call is a grid launch. */
  grid?: DraftValue;
  /**
   * True when what the call hands back is a bigint, which is what the callee
   * declared: `function f(): bigint` hands back a bigint and one declared
   * `: number` hands back a double, and the language prints the first with an
   * `n` after it and the second without.
   */
  bigint: boolean;
  /**
   * The same question of a wide number, which a signature cannot answer: a
   * `u256` is this compiler's own spelling of a bigint too wide for a machine
   * word, so whether the source wrote it with an `n` beside it is read from the
   * body the callee returns. Null where the callee is not one this build holds.
   */
  wide: boolean | null;
  /**
   * What the call answers when it answers a promise: the type of the value the
   * promise carries. A promise is a handle, so its type alone says nothing
   * about the value `await` reads out of it.
   */
  promise?: { payload: TypeExpr };
  /**
   * True when the call is an `await`, whose argument is the promise the source
   * wrote the word before. The resolver reads the argument's type at the use
   * and answers the promise's value, or the value itself when what was awaited
   * is not a promise.
   */
  awaiting?: true;
}

/** One piece of a string: text as written, or a value interpolated into it. */
type DraftTextPart = { k: "text"; value: string } | { k: "value"; value: DraftValue };

/** A value the program does, before it is written down as the IR states it. */
type DraftValue =
  /** A number literal, of the type it is used at. */
  | { k: "literal"; held: NumberHeld }
  /** A typed array literal, of the element type it is used at. */
  | { k: "buffer"; held: ArrayHeld }
  /** A typed array of a count the program settled on when it ran. */
  | { k: "sized"; element: PrimitiveTypeName; count: DraftValue; held: ArrayHeld }
  /** A window of a block at a byte offset, of a count of elements. */
  | { k: "view"; element: PrimitiveTypeName; of: DraftValue; offset: DraftValue; count: DraftValue; held: ArrayHeld }
  /** Every element of an array written as one value. */
  | { k: "fill"; buffer: DraftValue; value: DraftValue; held: ArrayHeld }
  /** A value the program declared, read by the name it was declared as. */
  | { k: "reference"; name: string; held: Held }
  /** A string the program builds. */
  | { k: "text"; parts: DraftTextPart[] }
  /** A number written as text at the number of digits the source asked for. */
  | { k: "fixed"; of: DraftValue; digits: number }
  | { k: "call"; call: DraftCall }
  /** The length of an array. */
  | { k: "length"; buffer: string; bufferType: TypeExpr; type: PrimitiveTypeName }
  /** The length of a string, counted the way an array length is. */
  | { k: "stringLength"; of: DraftValue }
  /** One element of an array. */
  | { k: "element"; buffer: string; bufferType: TypeExpr; index: DraftValue; type: PrimitiveTypeName }
  | { k: "boolean"; value: boolean }
  /** Nothing, of the type a use fixes it at. */
  | { k: "null"; type: TypeExpr | null }
  /** `a == b`, over numbers or over strings. */
  | { k: "compare"; how: "number" | "string"; negate: boolean; left: DraftValue; right: DraftValue }
  /** `a === null`. */
  | { k: "isNull"; operand: DraftValue; negate: boolean }
  /** A binary operation, and the whole number it is a bigint over when it is one. */
  | { k: "binary"; op: ProgramBinaryOp; left: DraftValue; right: DraftValue; type: TypeExpr | null; bigint?: true }
  | { k: "unary"; op: ProgramUnaryOp; operand: DraftValue; type: TypeExpr | null; bigint?: true }
  | {
      k: "conditional";
      condition: DraftValue;
      then: DraftValue;
      otherwise: DraftValue;
      type: TypeExpr | null;
      bigint?: true;
    }
  /** A field of one object a name holds, read out of it. */
  | { k: "field"; object: DraftValue; layout: string; field: string; type: TypeExpr; bigint?: true }
  /** An object literal, resolved so it is allocated wherever it is written. */
  | { k: "object"; fields: { name: string; value: DraftValue }[]; layout: string; type: TypeExpr }
  /**
   * A reference to a program function, as a function pointer. `symbol` is the
   * symbol of a function of another file of the program: it is compiled on its
   * own and linked beside the program, and the program hands the runtime its
   * address.
   */
  | { k: "function"; name: string; captures: CaptureRef[]; symbol?: string };

/** A statement the program runs, before it is written down as blocks. */
type DraftStatement =
  | { kind: "declare"; name: string; held: Held; value: DraftValue; line: number }
  | { kind: "assign"; name: string; op: ProgramAssignOp; value: DraftValue; type: TypeExpr | null; line: number }
  | {
      kind: "elementAssign";
      buffer: string;
      index: DraftValue;
      op: ProgramAssignOp;
      value: DraftValue;
      type: TypeExpr;
      line: number;
    }
  /** A field of an object written, as `node.left = null` is. */
  | { kind: "fieldAssign"; object: string; type: TypeExpr; layout: string; field: string; value: DraftValue; line: number }
  | { kind: "update"; name: string; op: "++" | "--"; prefix: boolean; type: TypeExpr; line: number }
  /** `a.fill(x)`: the array is written from its first element, as one value. */
  | { kind: "fill"; buffer: DraftValue; value: DraftValue; held: ArrayHeld; line: number }
  | { kind: "print"; values: DraftValue[]; line: number }
  | { kind: "invoke"; call: DraftCall; line: number }
  | { kind: "if"; condition: DraftValue; then: DraftStatement[]; otherwise: DraftStatement[]; line: number }
  | { kind: "try"; body: DraftStatement[]; catchParam: string | null; catchBody: DraftStatement[] | null; finallyBody: DraftStatement[] | null; line: number }
  | { kind: "while"; condition: DraftValue; body: DraftStatement[]; line: number }
  | { kind: "doWhile"; condition: DraftValue; body: DraftStatement[]; line: number }
  | {
      kind: "for";
      variable: string;
      type: TypeExpr;
      from: DraftValue;
      to: DraftValue;
      inclusive: boolean;
      down: boolean;
      step: DraftValue | null;
      body: DraftStatement[];
      line: number;
    }
  | {
      kind: "forOf";
      variable: string;
      type: TypeExpr;
      of: string;
      length: DraftValue;
      line: number;
      body: DraftStatement[];
    }
  | { kind: "break"; line: number }
  | { kind: "continue"; line: number }
  | { kind: "block"; body: DraftStatement[]; line: number }
  /** What a function hands back, which ends the block it was written in. */
  | { kind: "result"; value: DraftValue | null; line: number };

/** A program with every name and type resolved, ready to be written down. */
interface DraftProgram {
  file: string;
  statements: DraftStatement[];
  functions: FunctionSignature[];
  /** The functions the program declares, with the body each of them runs. */
  declared: ProgramFunctionDraft[];
  objects: Record<string, ObjectLayout>;
  /**
   * The functions of other files of the program that are registered as the
   * handlers of an HTTP server, by their symbols.
   */
  httpHandlers: string[];
}

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/** The type of a value of a primitive name. */
function numeric(name: PrimitiveTypeName): TypeExpr {
  return { kind: "primitive", name };
}

const USIZE: TypeExpr = { kind: "primitive", name: "usize" };

/** Nothing, as the type a reference that names nothing is read as. */
const REF_NULL: TypeExpr = { kind: "ref", of: null };

function programError(message: string, body: ProgramBody, line: number, detail?: string): CompilerError {
  return new CompilerError({
    category: "ContractError",
    stage: "program",
    message,
    detail: detail ?? (line === 0 ? body.file : `line ${line} of ${body.file}`),
  });
}

function primitive(type: SemanticType | null): PrimitiveTypeName | null {
  return type !== null && type.kind === "primitive" ? type.name : null;
}

function elementOf(type: TypeExpr): PrimitiveTypeName | null {
  return type.kind === "ptr" || type.kind === "slice" || type.kind === "array" ? primitive(type.of) : null;
}

function isBufferType(type: TypeExpr): boolean {
  return type.kind === "ptr" || type.kind === "slice" || type.kind === "array";
}

/** True of a type a value is counted with, rather than measured. */
/** The whole number type two whole numbers have in common. */
/**
 * True when a number written in the source is a whole number. This is the one
 * rule both resolvers ask, so a loop written in a function body and the same
 * loop written at the top of a module count in the same width.
 */
const isWholeLiteral = isWholeNumberText;

/**
 * The value a whole number written in the source is, or null where the text is
 * not one. `BigInt` takes a sign on a decimal literal only, so a negative
 * hexadecimal one is negated rather than converted with its sign: handing it
 * the text as written raised a SyntaxError out of the compiler, which is the
 * one thing the check the value feeds is there to keep from happening.
 */
function integerLiteral(text: string): bigint | null {
  if (/^[+-]?0[xX]/.test(text)) {
    const negative = text.startsWith("-");
    const body = negative ? text.slice(1) : text;
    const clean = body.endsWith("n") ? body.slice(0, -1) : body;
    return (negative ? -1n : 1n) * BigInt(clean);
  }
  const clean = text.endsWith("n") ? text.slice(0, -1) : text;
  return /^[+-]?[0-9]+$/.test(clean) ? BigInt(clean) : null;
}

/** The range an `i64` holds, which is the range a bigint literal is written at. */
const I64_MAX = 9223372036854775807n;
const I64_MIN = -9223372036854775808n;

/** The range a `u64` holds, so a bigint that fits in it can be typed as `u64`
   when a `u64` is expected rather than being widened to `u256`. */
const U64_MAX = 18446744073709551615n;

/**
 * True of a value that is a whole number as written, and so of a loop index
 * built from it. A literal the source wrote without a point is one whatever
 * type it is read back at; anything else is whole only when the type it
 * resolved to is.
 */
function countsWhole(value: DraftValue): boolean {
  if (value.k === "literal") {
    return value.held.type === null
      ? isWholeLiteral(value.held.text)
      : isWhole(value.held.type);
  }
  const name = primitive(draftType(value));
  return name !== null && isWhole(name);
}
/**
 * The whole number two whole numbers are computed as, in a program. The source
 * wrote both of them as doubles and the driver has to answer as one, so a
 * length — read as a `usize`, and only because a length is read as one — is
 * computed with a signed number: `length - 10` is -7 here, where the contract
 * language's own rule, which keeps a whole pair unsigned, would answer a very
 * large unsigned number. `core/semantic-ir.ts:wholeOf` is that rule, and is
 * what a contract is evaluated with.
 *
 * That exception is about signedness and says nothing about width, so it is
 * asked only of a pair that has a length in it. Answering it by the first
 * signed name present made `u32 << i8` an `i8` — a 32 bit value computed at
 * eight, with its high bits gone before the shift — and every `>>`, `&`, `|`,
 * `^` and `%` over a mixed pair with the narrow side signed.
 */
function programWholeOf(a: PrimitiveTypeName, b: PrimitiveTypeName): PrimitiveTypeName {
  if (a === b) return a;
  const names: readonly PrimitiveTypeName[] = [a, b];
  const length = names.some((name) => name === "usize" || name === "isize");
  if (length && names.some((name) => name !== "usize" && name !== "isize" && isSigned(name))) return "isize";
  return wholeOf(a, b);
}

/** Whether a whole number is a signed one, which is what a length meets. */
function isSigned(name: PrimitiveTypeName): boolean {
  return name === "i8" || name === "i16" || name === "i32" || name === "i64" || name === "isize";
}


/**
 * The type an operation on two numbers has in a program: a double, whatever the
 * source typed them as. Every number in a program is a double, and the
 * arithmetic is the language's own, so `7 / 2` is 3.5 and a `Uint32Array`
 * holding 4000000000 added to 1 is 4000000001 rather than a negative number
 * from a type narrower than the answer. The operators the language has no
 * floating form for — a remainder, a shift, the bitwise pair — are whole by
 * another rule (`wholeResult`), and a length is a whole number because a
 * length is read as one, not because arithmetic on it is.
 */
function numericResult(left: PrimitiveTypeName | null, right: PrimitiveTypeName | null, _floating: boolean): PrimitiveTypeName {
  // A wide number is the exception to the rule above, and it is the one that
  // matters: the answer is a double because a double is wide enough for every
  // value a program counts with, and a `u256` is not one of them. Widening a
  // wide number to a double here would drop every limb above the first before
  // a backend was handed the value at all, so an operation over one keeps the
  // width it was written at.
  if (left !== null && isWide(left)) return left;
  if (right !== null && isWide(right)) return right;
  return "f64";
}

/**
 * The type an operation on two bigints has: the `i64` a bigint is.
 *
 * A bigint is the one number in a program that is not a double, and the reason
 * is arithmetic rather than spelling: `9007199254740993n + 1n` is
 * 9007199254740994, and a double answers 9007199254992 for it because it holds
 * a whole number exactly only up to 2^53. So the answer here is the whole
 * number the operands already are, which is what `wholeResult` gives for a
 * whole operator and what a bigint needs for the rest.
 */
const BIGINT_TYPE: PrimitiveTypeName = "i64";

/**
 * True when the value is a bigint, which is a whole number the program wrote an
 * `n` beside. A call carries the answer its callee's body gives rather than
 * working it out here, which is what `wide` on a call is for.
 */
function isBigint(value: DraftValue): boolean {
  switch (value.k) {
    case "literal":
    case "reference":
      return value.held.kind === "number" && value.held.bigint === true;
    case "binary":
    case "unary":
    case "conditional":
      return value.bigint === true;
    case "field":
      // A field the layout holds a whole number in holds a whole number: the
      // layout is what says the kind of the value.
      return value.bigint === true;
    case "call":
      // What a call hands back is what the callee declared it returns. Without
      // this `console.log(f())` for a `f(): bigint` printed the number without
      // the `n` that is what says it is a bigint, and `f() + 1n` was refused as
      // a bigint mixed with a number.
      if (value.call.bigint) return true;
      // A `u256` is the compiler's own spelling of a bigint too wide for a
      // machine word, and nothing in the signature says whether the program
      // wrote it with an `n` beside it. A wide number the source wrote as a
      // number prints its digits and one it wrote as a bigint prints them with
      // the marker, and the source this program is checked against is what
      // settles which.
      //
      // What the callee returned is what says it, and it is read from the
      // callee's own body with this call's arguments: a signature states the
      // width and the width is not the marker, so reading it off the arguments
      // as this once did answered for a call that has none. `console.log(five())`
      // for `function five(): u256 { return 5n; }` printed `5` where the source
      // prints `5n`, and the build was refused for a number it had computed.
      // The mark is the callee's answer, read from the body it returns with
      // this call's arguments in place of its parameters. A wide number with no
      // such answer — a callee this build holds no body for, or one whose paths
      // disagree — is not marked, which is what the source prints for a number
      // written without an `n`.
      return value.call.wide === true;
    default:
      return false;
  }
}

/**
 * Whether what a function hands back is a bigint, which is what its signature
 * declares: a source spells a bigint `bigint` and every other number `number`,
 * and the contract type those two map to is `i64` and `f64`. Nothing else a
 * function can declare returns a bare `i64`.
 */
function returnsBigint(returns: string): boolean {
  return parseType(returns).kind === "primitive" && returns.trim() === "i64";
}

/**
 * Whether what a wide-returning function hands back is a bigint, which is read
 * from the body it returns with this call's arguments in place of its
 * parameters.
 *
 * A `u256` is the compiler's own spelling of a bigint too wide for a machine
 * word, so a signature states the width and the width is not the marker: the
 * source writes `5n` where a bigint is meant and `5` where a number is, and the
 * language prints the first with an `n` and the second without. Reading the
 * marker off the arguments — which is what this once did — answers for every
 * call that has arguments and for none that has none, so `console.log(five())`
 * printed `5` where the source prints `5n`.
 *
 * Reading it from the callee's body is what settles it, because the body is
 * what says what the function returns: `return 5n` is a bigint whatever the
 * arguments were and `return n` hands back the parameter as it arrived, which
 * is the one place the call itself is the answer.
 */
function returnsWideBigint(body: readonly Statement[], written: readonly DraftValue[], params: readonly string[]): boolean {
  const results: Expression[] = [];
  const walk = (statements: readonly Statement[]): void => {
    for (const statement of statements) {
      switch (statement.kind) {
        case "result":
          if (statement.value !== null) results.push(statement.value);
          break;
        case "if":
          walk(statement.then);
          walk(statement.otherwise);
          break;
        case "while":
        case "doWhile":
        case "loop":
        case "forOf":
          walk(statement.body);
          break;
        default:
          break;
      }
    }
  };
  walk(body);
  if (results.length === 0) return false;
  // A return on one path and not another is a value that is sometimes a bigint
  // and sometimes a number, and which of the two prints an `n` is decided by
  // the path that ran. Every path answering the same way is the only case this
  // settles, and a mixed one is left unmarked rather than marked wrongly.
  const marks = results.map((result) => wideMark(result, written, params));
  const marked = marks[0] as boolean;
  return marks.every((mark) => mark === marked) ? marked : false;
}

/** The mark of one return expression, with the call's arguments in place. */
function wideMark(expression: Expression, written: readonly DraftValue[], params: readonly string[]): boolean {
  switch (expression.k) {
    case "bigint":
      return true;
    case "ident": {
      const position = params.indexOf(expression.name);
      return position >= 0 && position < written.length && isBigint(written[position] as DraftValue);
    }
    case "binary":
      return wideMark(expression.left, written, params) && wideMark(expression.right, written, params);
    case "unary":
      return wideMark(expression.operand, written, params);
    case "conditional":
      return wideMark(expression.then, written, params) && wideMark(expression.otherwise, written, params);
    default:
      // A literal was written without an `n` and is a number, and a call is
      // settled by the body of the function it names rather than by anything
      // here: `returnsWideBigint` reads that body where the callee is reached.
      return false;
  }
}

/**
 * The same mark read from a function the program declared, whose body is
 * resolved rather than still the contract's.
 *
 * It is the same question asked of the same thing: what the callee returns, with
 * this call's arguments in place of the parameters it returns them from. A
 * `return 5n` is a bigint whatever it was called with, and `return n` is the
 * parameter as it arrived.
 */
function declaredWideBigint(compiled: DraftProgram | null, written: readonly DraftValue[], params: readonly string[]): boolean {
  if (compiled === null) return false;
  const results = returnsIn(compiled.statements);
  if (results.length === 0) return false;
  const marks = results.map((result) => {
    const value = result.value;
    // A bare return hands back nothing, which is not a wide bigint.
    if (value === null) return false;
    // A return of a parameter is the one place the call is the answer: `return n`
    // hands back the argument as it arrived, and the argument at this position is
    // what says whether it was written as a bigint.
    if (value.k === "reference") {
      const position = params.indexOf(value.name);
      if (position >= 0 && position < written.length) return isBigint(written[position] as DraftValue);
    }
    return isBigint(value);
  });
  const marked = marks[0] as boolean;
  return marks.every((mark) => mark === marked) ? marked : false;
}

/** True when the value is a string, which is the one type a number is not. */
function isSequenceType(type: TypeExpr | null): boolean {
  return type !== null && (type.kind === "slice" || type.kind === "array" || type.kind === "ptr");
}

function holdsArray(value: DraftValue): boolean {
  switch (value.k) {
    case "buffer":
    case "sized":
    case "view":
    case "fill":
      return true;
    case "reference":
      return value.held.kind === "array";
    case "binary":
      return isSequenceType(value.type);
    case "conditional":
      return isSequenceType(value.type);
    default:
      return false;
  }
}

function holdsText(value: DraftValue): boolean {
  switch (value.k) {
    case "text":
    case "fixed":
      return true;
    case "reference":
      return value.held.kind === "text";
    case "binary":
      // A binary that is a text is one the program built: `+` over two texts,
      // and a short-circuit operator whose arms are of different kinds, which
      // is written as the text of the arm that answers. The `??` asks whether a
      // value is nothing rather than whether it holds, and is left as it was.
      return value.type === null && (value.op === "+" || value.op === "&&" || value.op === "||");
    case "conditional":
      return value.type === null;
    case "call":
      // A call that hands back a string is a string, the way the type of the
      // call says it is: printing one is printing the text it answered.
      return value.call.returns.kind === "text";
    case "literal":
    case "buffer":
    case "sized":
    case "view":
    case "fill":
    case "length":
    case "stringLength":
    case "element":
    case "boolean":
    case "compare":
    case "isNull":
    case "unary":
    case "null":
    case "field":
    case "function":
    case "object":
      return false;
  }
}

/** The type a resolved value has, or null when it is a string. */
function draftType(value: DraftValue): TypeExpr | null {
  switch (value.k) {
    case "literal":
      return value.held.type === null ? null : { kind: "primitive", name: value.held.type };
    case "sized":
    case "view":
    case "fill":
      return { kind: "array", of: { kind: "primitive", name: value.held.element ?? "f64" }, length: value.held.length };
    case "buffer":
      return { kind: "slice", of: { kind: "primitive", name: value.held.element ?? "f64" } };
    case "reference":
      return heldType(value.held);
    case "text":
    case "fixed":
      return null;
    case "field":
      return value.type;
    case "function":
      return VOID;
    case "object":
      return value.type;
    case "call":
      // A call that hands back a string is a string, and a string is a value
      // the type of a draft does not spell.
      return value.call.returns.kind === "text" ? null : value.call.returns;
    case "length":
    case "stringLength":
    case "element":
      return { kind: "primitive", name: value.k === "stringLength" ? "usize" : value.type };
    case "boolean":
    case "compare":
    case "isNull":
      return { kind: "primitive", name: "bool" };
    case "null":
      return { kind: "ref", of: null };
    case "binary":
    case "unary":
    case "conditional":
      return value.type;
  }
}

/**
 * The type of the value a resolved value carries, for a promise that is settled
 * with it: a string is the text it is, a value the type does not fix is a
 * number, and a value of a shape nothing names is read dynamically.
 */
function payloadTypeOf(value: DraftValue): TypeExpr {
  if (holdsText(value)) return TEXT;
  return draftType(value) ?? numeric("f64");
}

/**
 * The promise a value is, or undefined when the value is not one.
 *
 * A promise is a handle the runtime owns, and a name that holds one holds the
 * handle. What the name says beside the handle is the type of the value the
 * promise carries, which is what `await` answers; a handle with no payload
 * named is a promise whose value is read dynamically.
 */
function promiseOf(value: DraftValue): { payload: TypeExpr } | undefined {
  switch (value.k) {
    case "reference":
      return value.held.kind === "object" ? value.held.promise : undefined;
    case "call":
      return value.call.promise;
    case "conditional": {
      // Both arms have to be promises for the choice to be one: an arm that is
      // a number is awaited as itself, and reading it as a handle would read
      // the number as an address.
      const then = promiseOf(value.then);
      const otherwise = promiseOf(value.otherwise);
      if (then === undefined || otherwise === undefined) return undefined;
      return contractTextOfType(then.payload) === contractTextOfType(otherwise.payload) ? then : { payload: { kind: "ref", of: null } };
    }
    default:
      return undefined;
  }
}

/** How a type is written, for comparing two payload types. */
function contractTextOfType(type: TypeExpr): string {
  return type.kind === "text" ? "text" : typeToString(type);
}

/**
 * The type a promise built from an executor carries, read off the values the
 * executor settles the promise with. A promise settled with a number carries a
 * number and one settled with a string carries a string; a promise settled with
 * both, or with a value this cannot see, carries a value read dynamically.
 */
function executorPayload(program: DraftProgram, callee?: (name: string) => DraftProgram | null): TypeExpr {
  const found: TypeExpr[] = [];
  const seen = new Set<string>();
  const note = (value: DraftValue): void => {
    switch (value.k) {
      case "call": {
        const settled = value.call.name === "resolve" || value.call.name === "onFulfilled";
        if (settled && value.call.args[0] !== undefined) found.push(payloadTypeOf(value.call.args[0]));
        for (const argument of value.call.args) {
          note(argument);
          // A callback the executor hands to a call settles the promise too:
          // `res.on("end", () => resolve(body))` is where a promise built
          // around an event is settled.
          if (argument.k === "function" && argument.name !== undefined && !seen.has(argument.name)) {
            seen.add(argument.name);
            const nested = callee?.(argument.name) ?? null;
            if (nested !== null) walk(nested.statements);
          }
        }
        if (value.call.grid !== undefined) note(value.call.grid);
        return;
      }
      case "text":
        for (const part of value.parts) if (part.k === "value") note(part.value);
        return;
      case "binary":
        note(value.left);
        note(value.right);
        return;
      case "unary":
        note(value.operand);
        return;
      case "conditional":
        note(value.condition);
        note(value.then);
        note(value.otherwise);
        return;
      case "field":
        note(value.object);
        return;
      case "object":
        for (const field of value.fields) note(field.value);
        return;
      case "fixed":
        note(value.of);
        return;
      default:
        return;
    }
  };
  const walk = (statements: readonly DraftStatement[]): void => {
    for (const statement of statements) {
      switch (statement.kind) {
        case "declare":
        case "assign":
          note(statement.value);
          continue;
        case "result":
          if (statement.value !== null) note(statement.value);
          continue;
        case "elementAssign":
          note(statement.index);
          note(statement.value);
          continue;
        case "fieldAssign":
          note(statement.value);
          continue;
        case "print":
          statement.values.forEach(note);
          continue;
        case "fill":
          note(statement.value);
          continue;
        case "if":
          note(statement.condition);
          walk(statement.then);
          walk(statement.otherwise);
          continue;
        case "while":
        case "doWhile":
          note(statement.condition);
          walk(statement.body);
          continue;
        case "for":
          note(statement.from);
          note(statement.to);
          if (statement.step !== null) note(statement.step);
          walk(statement.body);
          continue;
        case "forOf":
          walk(statement.body);
          continue;
        case "try":
          walk(statement.body);
          if (statement.catchBody !== null) walk(statement.catchBody);
          if (statement.finallyBody !== null) walk(statement.finallyBody);
          continue;
        case "block":
          walk(statement.body);
          continue;
        default:
          continue;
      }
    }
  };
  walk(program.statements);
  const first = found[0];
  if (first === undefined) return { kind: "ref", of: null };
  const written = contractTextOfType(first);
  return found.every((type) => contractTextOfType(type) === written) ? first : { kind: "ref", of: null };
}

/** Every value a body returns, as the statements of it were resolved. */
function returnedValues(statements: readonly DraftStatement[]): DraftValue[] {
  const values: DraftValue[] = [];
  const walk = (list: readonly DraftStatement[]): void => {
    for (const statement of list) {
      switch (statement.kind) {
        case "result":
          if (statement.value !== null) values.push(statement.value);
          continue;
        case "if":
          walk(statement.then);
          walk(statement.otherwise);
          continue;
        case "while":
        case "doWhile":
          walk(statement.body);
          continue;
        case "for":
        case "forOf":
          walk(statement.body);
          continue;
        case "try":
          walk(statement.body);
          if (statement.catchBody !== null) walk(statement.catchBody);
          if (statement.finallyBody !== null) walk(statement.finallyBody);
          continue;
        case "block":
          walk(statement.body);
          continue;
        default:
          continue;
      }
    }
  };
  walk(statements);
  return values;
}

/** The promise a plain function's body answers, when its returns are one. */
function returnedPromise(statements: readonly DraftStatement[]): { payload: TypeExpr } | undefined {
  for (const value of returnedValues(statements)) {
    const promise = promiseOf(value);
    if (promise !== undefined) return promise;
  }
  return undefined;
}

/**
 * The type a declared name is read as. A number no use has fixed is a double,
 * as it is in the language it was written in, and an array is a slice of the
 * element type a use of it fixes.
 */
function heldType(held: Held): TypeExpr | null {
  switch (held.kind) {
    case "text":
      return null;
    case "array":
      return { kind: "slice", of: { kind: "primitive", name: held.element ?? "f64" } };
    case "object":
      return held.type;
    case "number":
      return { kind: "primitive", name: held.type ?? "f64" };
    case "argv":
      // A name bound to the command line is read as an argument value, which
      // the runtime hands back as a number.
      return { kind: "primitive", name: "f64" };
  }
  throw new Error(`unreachable: held type ${(held as Held).kind}`);
}

/** The type an array is written out as, which is the type its name is read as. */
function arrayType(held: ArrayHeld): TypeExpr {
  return { kind: "array", of: { kind: "primitive", name: held.element ?? "f64" }, length: held.length };
}

/**
 * Every exported function of the program, and what each of them does.
 *
 * The body travels with the signature because what a function hands back as a
 * wide number is read from it: a `u256` signature says how wide the answer is
 * and not whether the source wrote it with an `n` beside it.
 */
function contractsOf(program: ProgramContract): Map<string, CompiledFunction> {
  const contracts = new Map<string, CompiledFunction>();
  for (const file of program.files) {
    for (const [name, contract] of Object.entries(file.functions)) {
      contracts.set(name, {
        signature: contract.function,
        effects: contract.effects,
        body: contract.definition.statements,
        ...(contract.promise === undefined ? {} : { promise: contract.promise }),
      });
    }
  }
  return contracts;
}

/**
 * The whole number a whole operator yields. `%`, a shift and a bitwise operator
 * are operations on whole numbers whatever the literals they were written as,
 * and `1 << 4` is 16 rather than a shift of two doubles, so the result is a whole
 * number: the one the operands share when both are already whole, and an i64
 * otherwise.
 *
 * A wide number is the exception, and it is the one that matters for the same
 * reason `numericResult` makes it: an operation over one keeps the width it was
 * written at, because a machine word is not wide enough to hold the three limbs
 * above the first and they are gone before a backend is handed the value. A
 * literal beside one is the widening rather than a narrower number, so it is
 * not what stops this.
 */
function wholeResult(left: PrimitiveTypeName | null, right: PrimitiveTypeName | null): PrimitiveTypeName {
  if (left !== null && isWide(left)) return left;
  if (right !== null && isWide(right)) return right;
  return left !== null && right !== null && isWhole(left) && isWhole(right) ? programWholeOf(left, right) : "i64";
}

/**
 * The type one side of an operation is read at, which is the width the whole is
 * computed at — unless the value is not a number that width holds.
 *
 * A whole number and a fraction are the one pair where reading the fraction at
 * the whole one is not a conversion but a different number: `1.5` read as a
 * `u256` is 1, and `a + 1.5` is then `a + 1`. The operation states one width, so
 * the side keeps its own and the validator names the pair it cannot compute.
 */
function sideType(value: DraftValue, result: TypeExpr | null): TypeExpr | null {
  if (result === null) return null;
  const held = primitive(result);
  if (held === null || !isWhole(held)) return result;
  const written = primitive(draftType(value));
  // A literal with no type of its own is a number as the source wrote it, and
  // what it was written as is in its text: `1.5` is a fraction whatever it is
  // initializing, and a whole result does not hold one.
  if (written === null) return value.k === "literal" && !isWholeLiteral(value.held.text) ? null : result;
  return isWhole(written) ? result : null;
}

/** The array forms a declaration is the allocation of, rather than an alias of. */
const ARRAY_FORMS: ReadonlySet<string> = new Set(["buffer", "sized", "view"]);

/** The operators only whole numbers have. */
const WHOLE_OPERATORS: readonly ProgramBinaryOp[] = ["//", "%", "<<", ">>", "&", "|", "^"];
/**
 * The operators the language converts rather than refuses: `>>>` reads both of
 * its sides as the unsigned 32 bit numbers JavaScript reads them as, whatever
 * they are, and answers one of those.
 */
const CONVERTING_OPERATORS: readonly ProgramBinaryOp[] = [">>>"];
/** The compound assignments only whole numbers have. */
const WHOLE_ASSIGNMENTS: readonly ProgramAssignOp[] = ["%=", "&=", "|=", "^=", "<<=", ">>=", ">>>="];

/**
 * What each compound assignment states as the binary operator it applies. A
 * store is the only write the IR states and it states no operators, so a
 * compound write to a field is a read of that field, the binary form applied
 * to it, and the store — which is the same program, because `p.x += 1` is
 * `p.x = p.x + 1` in the language.
 */
const COMPOUND_BINARY: Record<Exclude<ProgramAssignOp, "=">, ProgramBinaryOp> = {
  "+=": "+",
  "-=": "-",
  "*=": "*",
  "/=": "/",
  "//=": "//",
  "%=": "%",
  "&=": "&",
  "|=": "|",
  "^=": "^",
  "<<=": "<<",
  ">>=": ">>",
  ">>>=": ">>>",
  "**=": "**",
};
const EQUALITY: readonly ProgramBinaryOp[] = ["===", "!==", "==", "!="];

const LOGICAL: readonly ProgramBinaryOp[] = ["&&", "||", "??"];

/** What the operators a binary expression is written with state in the IR. */
const ARITHMETIC: Record<ProgramBinaryOp, ArithOp | null> = {
  "+": "add",
  "-": "sub",
  "*": "mul",
  "/": "div",
  "//": "floorDiv",
  "%": "mod",
  "**": "pow",
  "<<": "shl",
  ">>": "shr",
  ">>>": "ushr",
  "&": "and",
  "|": "or",
  "^": "xor",
  "<": null,
  "<=": null,
  ">": null,
  ">=": null,
  "===": null,
  "!==": null,
  "==": null,
  "!=": null,
  "&&": null,
  "||": null,
  "??": null,
};

const COMPARISONS: Record<ProgramBinaryOp, CompareOp | null> = {
  "+": null,
  "-": null,
  "*": null,
  "/": null,
  "//": null,
  "%": null,
  "**": null,
  "<<": null,
  ">>": null,
  ">>>": null,
  "&": null,
  "|": null,
  "^": null,
  "<": "lt",
  "<=": "le",
  ">": "gt",
  ">=": "ge",
  "===": null,
  "!==": null,
  "==": null,
  "!=": null,
  "&&": null,
  "||": null,
  "??": null,
};

const UNARY: Record<ProgramUnaryOp, UnaryOp> = { "-": "neg", "+": "pos", "!": "not", "~": "bitNot" };

/** The two `Math.` builtins that are one operation rather than a call. */
const EXTREMES: Record<string, "min" | "max"> = { "Math.min": "min", "Math.max": "max" };

/**
 * The builtin that answers a call in whole numbers, where the language says
 * the answer keeps the kind of the number it was given.
 */
const WHOLE_ANSWERS: Record<string, string> = {
  "Math.abs": "whole.abs",
  "Math.min": "whole.min",
  "Math.max": "whole.max",
};

/* -------------------------------------------------------------------------- */
/* What a function reads of the scope around it                               */
/* -------------------------------------------------------------------------- */

/** The functions one value of a program calls, in the order it first calls them. */
function callsInValue(value: ProgramValue, called: string[]): void {
  switch (value.k) {
    case "call":
      if (!called.includes(value.function)) called.push(value.function);
      value.args.forEach((argument) => callsInValue(argument, called));
      return;
    case "unary":
      callsInValue(value.operand, called);
      return;
    case "binary":
      callsInValue(value.left, called);
      callsInValue(value.right, called);
      return;
    case "conditional":
      callsInValue(value.condition, called);
      callsInValue(value.then, called);
      callsInValue(value.otherwise, called);
      return;
    case "text":
      for (const part of value.parts) if (part.k === "value") callsInValue(part.value, called);
      return;
    case "object":
      for (const field of value.fields) callsInValue(field.value, called);
      return;
    case "fixed":
      callsInValue(value.of, called);
      return;
    case "shared":
      callsInValue(value.count, called);
      return;
    case "sized":
      callsInValue(value.count, called);
      return;
    case "view":
      callsInValue(value.of, called);
      callsInValue(value.offset, called);
      callsInValue(value.count, called);
      return;
    case "fill":
      callsInValue(value.buffer, called);
      callsInValue(value.value, called);
      return;
    case "element":
      callsInValue(value.index, called);
      return;
    case "name":
    case "length":
    case "number":
    case "whole":
    case "boolean":
    case "null":
    case "buffer":
      return;
  }
}

/**
 * The names a body calls, which is what a function is given for.
 *
 * Every statement is walked, not only the ones that are a call of their own: a
 * call written as `let y = inner(x)` makes the same call as `inner(x)`, and one
 * that is not seen here is a call whose captures are never handed on to the
 * function that makes it — `closure` reads this list to decide what the caller
 * of a callee has to be given in turn, so a name it misses is a name the
 * caller is not handed and a body refused for reading it.
 */
function calledNames(body: readonly ProgramStatement[]): string[] {
  const called: string[] = [];
  const walk = (statements: readonly ProgramStatement[]): void => {
    for (const statement of statements) {
      switch (statement.kind) {
        case "invoke":
          if (!called.includes(statement.function)) called.push(statement.function);
          statement.args.forEach((argument) => callsInValue(argument, called));
          continue;
        case "declare":
          callsInValue(statement.value, called);
          continue;
        case "assign":
          callsInValue(statement.value, called);
          continue;
        case "elementAssign":
          callsInValue(statement.index, called);
          callsInValue(statement.value, called);
          continue;
        case "fieldAssign":
          callsInValue(statement.value, called);
          continue;
        case "print":
          statement.values.forEach((value) => callsInValue(value, called));
          continue;
        case "result":
          if (statement.value !== null) callsInValue(statement.value, called);
          continue;
        case "if":
          callsInValue(statement.condition, called);
          walk(statement.then);
          walk(statement.otherwise);
          continue;
        case "while":
        case "doWhile":
          callsInValue(statement.condition, called);
          walk(statement.body);
          continue;
        case "for":
          callsInValue(statement.from, called);
          callsInValue(statement.to, called);
          if (statement.step !== null) callsInValue(statement.step, called);
          walk(statement.body);
          continue;
        case "forOf":
        case "block":
          walk(statement.body);
          continue;
        case "update":
        case "break":
        case "continue":
        case "function":
          continue;
      }
    }
  };
  walk(body);
  return called;
}

/**
 * The names a body reads that it does not declare itself, in the order they
 * were first read. A function of a program is compiled on its own, so every
 * name it reads of the scope it is declared in is a parameter of its own: this
 * is the list of what it reads, and the types are the types the scope it was
 * declared in holds.
 *
 * A name declared in the block a read is written in shadows one of the same
 * name outside it, so the walk carries the scopes rather than collecting every
 * name the body mentions: a body that declares `let i` of its own inside a loop
 * reads the `i` around it nowhere, and one that only reads the `i` it declared
 * reads nothing at all.
 */
function readsAround(body: readonly ProgramStatement[], parameters: ReadonlySet<string>): string[] {
  const read: string[] = [];
  const scopes: Set<string>[] = [new Set(parameters)];
  const seen = (name: string): boolean => scopes.some((scope) => scope.has(name));
  const note = (name: string): void => {
    if (seen(name) || read.includes(name)) return;
    read.push(name);
  };
  const walk = (statements: readonly ProgramStatement[]): void => {
    for (const statement of statements) {
      switch (statement.kind) {
        case "declare":
          // A declaration is a name of the block it is written in, whether the
          // value it holds is read before it: `const n = +Deno.args[0]` reads
          // the command line and declares `n` in the same breath.
          value(statement.value);
          scopes[scopes.length - 1].add(statement.name);
          continue;
        // The name a statement writes to is read to write it: `total += n`
        // reads `total` and writes it, and `n` is not the only name the turn
        // touches. A name that is not noted here is a name the function is not
        // handed at the call, and the body that wrote it is then refused for
        // reading a name nothing declared.
        case "assign":
          note(statement.name);
          value(statement.value);
          continue;
        case "elementAssign":
          note(statement.buffer);
          value(statement.index);
          value(statement.value);
          continue;
        case "fieldAssign":
          note(statement.object);
          value(statement.value);
          continue;
        case "update":
          note(statement.name);
          continue;
        case "print":
          statement.values.forEach(value);
          continue;
        case "invoke":
          statement.args.forEach(value);
          continue;
        case "if":
          value(statement.condition);
          scopes.push(new Set());
          walk(statement.then);
          scopes.pop();
          scopes.push(new Set());
          walk(statement.otherwise);
          scopes.pop();
          continue;
        case "while":
        case "doWhile":
          value(statement.condition);
          scopes.push(new Set());
          walk(statement.body);
          scopes.pop();
          continue;
        case "for":
          // The bounds are read before the counter is declared, which is the
          // order the resolver writes them in: a loop that counts from a value
          // of the counter's own name counts from the one around it
          // (`for (let limit = limit; ...)`). Opening the counter's scope first
          // would hide that name from itself and drop it from the parameters.
          value(statement.from);
          value(statement.to);
          if (statement.step !== null) value(statement.step);
          scopes.push(new Set([statement.variable]));
          walk(statement.body);
          scopes.pop();
          continue;
        case "forOf":
          // What is walked is read where the walk is written, so the counter
          // the walk declares does not hide it.
          note(statement.of);
          scopes.push(new Set([statement.variable]));
          walk(statement.body);
          scopes.pop();
          continue;
        case "block":
          scopes.push(new Set());
          walk(statement.body);
          scopes.pop();
          continue;
        case "break":
        case "continue":
          continue;
        case "result":
          if (statement.value !== null) value(statement.value);
          continue;
        case "function": {
          // A function reads the scope it is declared in when it is *called*,
          // and the call is what passes the names: what the declaration itself
          // is written with is its own parameters, which are its own scope.
          // The names the nested function reads off the scope around this one
          // are the reads the enclosing function has it in the scope: the
          // call passes them through, so it names them as reads of its own.
          for (const name of readsAround(statement.body, new Set(statement.params.map((param) => param.name)))) {
            note(name);
          }
          continue;
        }
      }
    }
  };
  const value = (one: ProgramValue): void => {
    switch (one.k) {
      case "name":
        note(one.name);
        return;
      case "length":
        note(one.of);
        return;
      case "element":
        note(one.buffer);
        value(one.index);
        return;
      case "object":
        for (const field of one.fields) value(field.value);
        return;
      case "field":
        value(one.object);
        return;
      case "call":
        one.args.forEach(value);
        return;
      case "unary":
        value(one.operand);
        return;
      case "binary":
        value(one.left);
        value(one.right);
        return;
      case "conditional":
        value(one.condition);
        value(one.then);
        value(one.otherwise);
        return;
      case "text":
        one.parts.forEach((part) => {
          if (part.k === "value") value(part.value);
        });
        return;
      case "arrow": {
        // An arrow is called where it is written, so the names its body reads
        // are the names the function around it reads: the call passes them.
        for (const name of readsAround(one.body, new Set(one.params.map((param) => param.name)))) {
          note(name);
        }
        return;
      }
      case "fixed":
        value(one.of);
        return;
      case "shared":
        value(one.count);
        return;
      case "sized":
        value(one.count);
        return;
      case "view":
        value(one.of);
        value(one.offset);
        value(one.count);
        return;
      case "fill":
        value(one.buffer);
        value(one.value);
        return;
      case "number":
      case "whole":
      case "boolean":
      case "null":
      case "buffer":
        return;
    }
  };
  walk(body);
  return read;
}

/**
 * What a name a function of a program is given holds. A buffer parameter is an
 * array the function may write to, and its length is whatever the caller laid
 * out, which the IR holds no number for; a pointer is a reference to a block
 * rather than a run of elements, so a name of one is not a name an element is
 * read out of; and everything else is a number.
 */
function heldOf(text: string): Held {
  if (text === "text" || text === "boxedtext") {
    return { kind: "text", name: "", mutable: true, value: null, boxed: text === "boxedtext" };
  }
  const type = parseType(text);
  if (type.kind === "slice" || type.kind === "array") {
    return { kind: "array", name: "", mutable: true, element: elementOf(type) ?? "f64", length: null, values: [] };
  }
  if (type.kind === "ptr" || type.kind === "ref") {
    return { kind: "object", name: "", mutable: true, type };
  }
  return { kind: "number", name: "", mutable: true, type: primitive(type), text: "" };
}

/**
 * The type a parameter of a program is read at, as the signature states it. A
 * string is a string, whether it is passed by value or as the cell a mutable
 * one is shared through.
 */
function parameterType(text: string): SemanticType {
  return text === "text" || text === "boxedtext" ? TEXT : parseType(text);
}

/**
 * The type a value is read as when it is passed as a parameter of that type. A
 * string is read as a string by what it holds, not by what the use asks for, so
 * a parameter of that type fixes nothing about the value it is given.
 */
function parameterExpect(text: string): TypeExpr | null {
  return text === "text" || text === "boxedtext" ? null : parseType(text);
}

/**
 * What the call sites of a program say about the parameters the source wrote
 * no type for. A function of a program is compiled on its own, and what a
 * parameter is read as is what its callers pass it: a string where a string is
 * passed, a number where a number is, and a shape the compiler does not know
 * where anything else is.
 *
 * The kinds are read at the call sites, and a program is resolved again and
 * again until they stop changing: a parameter of a function is read at the type
 * the callers of that function pass it at, and a caller may itself be read at a
 * type only a later round settles.
 */
class Observations {
  /** The kinds seen at each parameter of each function, by name and position. */
  private readonly kinds = new Map<string, string[][]>();
  /** True when a kind was seen at a parameter that was not seen there before. */
  changed = false;

  /** What a parameter of a function is read at, given what its callers pass. */
  kindOf(name: string, position: number): "text" | "number" | "other" {
    const seen = this.kinds.get(name)?.[position];
    if (seen === undefined || seen.length === 0) return "other";
    if (seen.length === 1) return seen[0] as "text" | "number";
    // A parameter its callers pass two shapes of is a shape the compiler does
    // not know: it is read at whatever the caller passed it.
    return "other";
  }

  /** What a caller passed at a parameter of a function. */
  record(name: string, position: number, kind: "text" | "number"): void {
    let positions = this.kinds.get(name);
    if (positions === undefined) {
      positions = [];
      this.kinds.set(name, positions);
    }
    let seen = positions[position];
    if (seen === undefined) {
      seen = [];
      positions[position] = seen;
    }
    if (seen.includes(kind)) return;
    seen.push(kind);
    this.changed = true;
  }
}

/** The type a parameter the source wrote no type for is read at. */
function inferredType(kind: "text" | "number" | "other"): string {
  if (kind === "text") return "text";
  if (kind === "number") return "f64";
  return "ref<any>";
}

/**
 * The parameters a trampoline is declared with. What calls a trampoline is not
 * a program: the HTTP adapter passes it two values, and the program passes it
 * the value of the event and the names the arrow captured, so a trampoline is
 * given room for as many as the arrow holds and for the two the adapter
 * passes.
 */
function trampolineParameters(count: number): string {
  return Array.from({ length: Math.max(2, count) }, (_, index) => `void *p${index}`).join(", ");
}

/**
 * The parameters a trampoline of a callback is declared with: the value of the
 * event the callback is given, and the bundle of the values it captured.
 *
 * What calls a callback is not a program and is given one value to hand it —
 * the handle a response came through, or the message a request failed with —
 * so the values the callback captured are carried beside it, in a bundle the
 * trampoline reads them out of.
 */
function callbackParameters(): string {
  return "void *p0, void *p1";
}

/**
 * How one value is handed to a callback: a string and a buffer are pointers,
 * and a number is the value the caller passed.
 */
function callbackValue(type: string, value: string): string {
  if (type === "text") return `(const char *)(uintptr_t)(${value})`;
  if (type === "boxedtext") return `(char **)(uintptr_t)(${value})`;
  const parsed = parseType(type);
  if (parsed.kind === "slice" || parsed.kind === "array" || parsed.kind === "ptr") {
    return `(void*)(uintptr_t)(${value})`;
  }
  return `(double)(uintptr_t)(${value})`;
}

/**
 * One value a callback captured, read out of the bundle it was carried in.
 *
 * The bundle holds a number as the number it is and a reference as the
 * address of it, so the field the value is read out of is the one its type
 * says. A number read out of the address field was rounded to a whole number
 * on the way, so a callback that captured `1.5` was given `1`.
 */
function captureValue(param: string, capture: SemanticType, bundle: string): string {
  if (param === "text") return `(const char *)(uintptr_t)(${bundle}.pointer)`;
  if (param === "boxedtext") return `(char **)(uintptr_t)(${bundle}.pointer)`;
  if (isCarriedAsAddress(capture)) return `(void*)(uintptr_t)(${bundle}.pointer)`;
  return `(${bundle}.number)`;
}

/** Whether a parameter type is a buffer, whose length travels beside it. */
function isBufferParameter(type: string): boolean {
  if (type === "text" || type === "boxedtext") return false;
  const parsed = parseType(type);
  return parsed.kind === "slice" || parsed.kind === "array" || parsed.kind === "ptr";
}

/**
 * The arguments a captured value is handed to the function by.
 *
 * A buffer is one value and its length is another: the function is compiled
 * with the length as the parameter that follows the pointer, and the bundle
 * the capture travels in carries it in the number beside the address. A value
 * that is not a buffer is the one argument it is.
 */
function captureArguments(param: string, capture: SemanticType, bundle: string): string[] {
  const value = captureValue(param, capture, bundle);
  return isBufferParameter(param) ? [value, `(size_t)(${bundle}.number)`] : [value];
}

/**
 * The names the captures of a handler are held under, one for each of them.
 *
 * A handler the runtime calls is given the request and the response and
 * nothing else, so the names it captured are held here instead: the program
 * writes them when the server is created, and the trampoline that calls the
 * handler reads them when a request arrives.
 */
function captureHolders(draft: ProgramFunctionDraft): string[] {
  return draft.captured.map((_, index) => `blaze_capture_${draft.name}_${index}`);
}

/**
 * The trampoline of a handler the runtime calls: it is given the request and
 * the response, and it reads the names the handler captured from where the
 * program left them.
 */
function serverHandlerTrampoline(
  trampolineName: string,
  draft: ProgramFunctionDraft,
  holders: readonly string[],
  call: string,
): { name: string; body: string }[] {
  /* The holders are declared above the trampoline that reads them, and in a
     unit of their own: a unit that opens a block is a definition, and the
     prototypes the file carries are taken from those. A holder holds a value
     as it was captured, so a number it holds is the number it is. */
  const declarations = holders.map((holder) => `static blaze_capture_t ${holder};`).join("\n");
  return [
    { name: `${trampolineName}_captures`, body: declarations },
    {
      name: trampolineName,
      body: `static void ${trampolineName}(${trampolineParameters(draft.params.length)}) {\n  ${call}\n}`,
    },
  ];
}

/** A function the program declared, and what has been settled about it. */
interface ProgramFunctionDraft {
  name: string;
  /**
   * The names the body reads of the scope it is declared in, each with the
   * binding it was read from and not only its name. A name is resolved at every
   * call site, and a declaration that shadows it between the function's
   * declaration and its call is a different binding that happens to answer to
   * the same name — passing that one changes what the call computes without
   * anything being wrong with it visibly.
   */
  captured: { name: string; type: SemanticType; held: Held; boxed: boolean }[];
  /**
   * The parameters the source wrote, in the order it wrote them. A type of null
   * is one the source wrote no type for: what it is read at is what the call
   * sites of the function say, and a function nobody calls is read at whatever
   * the program holds.
   */
  params: { name: string; type: TypeExpr | null }[];
  body: ProgramStatement[];
  line: number;
  /** Set once the scope it is declared in has settled the type of every name. */
  signature: FunctionSignature | null;
  /** The body, resolved, once the names it reads are all declared. */
  compiled: DraftProgram | null;
  /**
   * The source wrote `async` in front of the function. The body runs when the
   * function is called and what the function answers is a promise carrying
   * what the body returns; `payload` is the type of that value, and what a
   * caller's `await` reads out of the promise.
   */
  async?: boolean;
  /** The value the promise an async function answers carries. */
  payload?: TypeExpr;
  /**
   * True when the program handed this function to something as a callback.
   * What calls it is not a program, and passes it two values rather than the
   * arguments the source wrote, so it is called through a trampoline of its own.
   */
  callback: boolean;
  /**
   * True when this function is the handler a server was given. The runtime
   * calls the handler with the request and the response, and the names the
   * handler captured are not among them: the program leaves them where the
   * trampoline that calls the handler reads them.
   */
  serverHandler: boolean;
}

/** A declared function whose body has been read, and so is settled whole. */
type SettledFunction = ProgramFunctionDraft & { signature: FunctionSignature; compiled: DraftProgram };

/**
 * What every function of one program shares: the table they are called by, the
 * bodies waiting for the scope they were declared in to settle, and the names
 * the program holds. A function declared inside a function is compiled on its
 * own and called like any other, so the whole program reads and writes one
 * table rather than a table per scope.
 */
interface ProgramFunctions {
  readonly table: Map<string, ProgramFunctionDraft>;
  /** The bodies whose scope has settled and whose body has not been read yet. */
  waiting: ProgramFunctionDraft[];
  /** The bodies being read right now, which a call of one of them reaches. */
  readonly settling: Set<ProgramFunctionDraft>;
  /** The names the program holds, so a generated name is not one of them. */
  readonly used: Set<string>;
  /** What the call sites say about the parameters the source wrote no type for. */
  readonly observed: Observations;
}

/**
 * Every `return` in a body, in the order the program wrote them, however deep
 * in a branch it is. A return inside a loop is one of them: what a function
 * hands back is what every path hands back, and a loop that may run no turns
 * is a path that falls off the end — the one that hands back nothing at all.
 */
function returnsIn(statements: readonly DraftStatement[]): (DraftStatement & { kind: "result" })[] {
  const found: (DraftStatement & { kind: "result" })[] = [];
  for (const statement of statements) {
    switch (statement.kind) {
      case "result":
        found.push(statement);
        break;
      case "if":
        found.push(...returnsIn(statement.then), ...returnsIn(statement.otherwise));
        break;
      case "block":
      case "while":
      case "doWhile":
      case "for":
      case "forOf":
        found.push(...returnsIn(statement.body));
        break;
      case "try":
        found.push(...returnsIn(statement.body));
        if (statement.catchBody !== null) found.push(...returnsIn(statement.catchBody));
        if (statement.finallyBody !== null) found.push(...returnsIn(statement.finallyBody));
        break;
      default:
        break;
    }
  }
  return found;
}

/** The type a number is, as the semantic IR states a type rather than as text. */
function isNumberType(type: SemanticType): boolean {
  const name = primitive(type);
  return name !== null && NUMERIC.includes(name);
}

/** The wide number a type is, as the semantic IR states a type rather than as text. */
function isWideType(type: SemanticType): boolean {
  if (type.kind === "text") return false;
  const name = primitive(type as TypeExpr);
  return name !== null && isWide(name);
}

/**
 * The layout a reference names, or null when it names none. A field of a
 * reference the layouts do not name is a field of whatever holds it, which is
 * what a tree of one shape is, and a read of its field is a read of the layout
 * of that object rather than of a shape of its own.
 */
function referenceLayout(type: TypeExpr): string | undefined {
  return type.kind === "ref" ? type.name : undefined;
}

/**
 * Whether control leaves a block rather than continuing past it, which is what
 * an `if` with two arms that each leave means for the block it is written in.
 */
function leaves(block: SemanticBlock): boolean {
  return block.terminator.k !== "next";
}

/* -------------------------------------------------------------------------- */
/* Resolver                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One compiled function of the program, as the resolver reads it: what it is
 * called with and hands back, what it does beyond computing, and the body it
 * runs. The body is here because whether a wide number it hands back was
 * written as a bigint is read from what it returns.
 */
interface CompiledFunction {
  signature: FunctionSignature;
  effects: Effect[];
  body: readonly Statement[];
  /** The value the promise an async function answers carries. */
  promise?: string;
}

class ProgramResolver {
  private readonly scopes: Map<string, Held>[] = [new Map()];
  private readonly body: ProgramBody;
  private readonly contracts: Map<string, CompiledFunction>;
  private readonly objects: Record<string, ObjectLayout>;
  /** The layout name each literal's shape is laid out as, keyed by its shape key. */
  private readonly objectLayoutNames: Map<string, string>;
  /**
   * The shape every object literal of the body was laid out at, by the literal
   * itself. The layout pass walked the whole program before it named anything,
   * so this is the only place that can say which of two shapes a literal ended
   * up in.
   */
  private readonly literalKeys: LiteralKeys;
  /** An array another name was given, and the array it is the same array as. */
  private readonly aliases: [ArrayHeld, ArrayHeld][] = [];
  /** How many loops the statement being resolved is written in. */
  private loops = 0;
  /** The functions the program declares, and what they share. */
  private readonly functions: ProgramFunctions;
  /**
   * The functions of other files of the program that are registered as the
   * handlers of an HTTP server, by their symbols.
   */
  private readonly httpHandlers: string[] = [];
  /**
   * The rules of that language, asked of the language rather than of the code
   * that reads them: a whole number beside a fraction is refused in one
   * language and promoted to a fraction in the other.
   */
  private readonly rules: LanguageRules;

  constructor(
    body: ProgramBody,
    contracts: Map<string, CompiledFunction>,
    objects: Record<string, ObjectLayout>,
    functions: ProgramFunctions,
    objectLayoutNames: Map<string, string> = new Map(),
    literalKeys: LiteralKeys = new Map(),
    language: string = "typescript",
  ) {
    this.body = body;
    this.contracts = contracts;
    this.objects = objects;
    this.functions = functions;
    this.objectLayoutNames = objectLayoutNames;
    this.literalKeys = literalKeys;
    this.rules = rulesFor(language);
  }

  resolve(): DraftProgram {
    const statements = this.statements(this.body.statements, false);
    // A body is read when it is called, because what a call is typed by is
    // what the body hands back. A function nobody calls is read here, at the
    // end of the scope it was declared in, which is the same body either way.
    for (const draft of [...this.functions.waiting]) this.settle(draft);
    return {
      file: this.body.file,
      statements,
      functions: [...this.contracts.values()].map((contract) => contract.signature),
      declared: [...this.functions.table.values()],
      objects: this.objects,
      httpHandlers: [...this.httpHandlers],
    };
  }

  /**
   * A function the program declared, with the names it reads of the scope
   * around it given to it as parameters. A program has no environment for a
   * function to close over: it is compiled on its own and called, so what it
   * reads of the scope it is written in is passed to it at every call, and the
   * call site is where that scope is.
   */
  private declared(statement: ProgramStatement & { kind: "function" }, declaredHere: readonly string[] = []): void {
    // A function bound to the block it is declared in is bound once, whatever
    // the statement it is written at: the block hoists it and the statement
    // that reached it finds it already there.
    if (this.functions.table.has(statement.name)) return;
    const params = statement.params.map((param) => {
      // A parameter the source wrote no type for is read at the type its
      // callers pass it at, which is what the call sites of the program say.
      // The kind is settled in `closure`, once the call sites have been read.
      if (param.type === null) return { name: param.name, type: null };
      return { name: param.name, type: this.annotation(param.type, statement.line) };
    });
    // Every name the body reads of the scope around it is a parameter of the
    // function, of the type the scope holds it at: a function of a program is
    // compiled on its own, so what it reads from around it is passed to it at
    // every call, and the call is where that scope is.
    const captures: { name: string; type: SemanticType; held: Held; boxed: boolean }[] = [];
    for (const name of readsAround(statement.body, new Set(statement.params.map((param) => param.name)))) {
      const held = this.lookup(name) ?? this.topLevelText(name);
      if (declaredHere.includes(name)) {
        throw programError(
          `${statement.name} reads "${name}", which the block it is declared in declares`,
          this.body,
          statement.line,
          `line ${statement.line} of ${this.body.file}: a name a block declares shadows the one around it for the whole of the block, so this function would have to be given the block's "${name}" and a function of a program is declared before the block is read; declare it outside the block, or give it the name as a parameter`,
        );
      }
      if (held === undefined) {
        // A named program function is referenced by name rather than captured,
        // so a function that reads one needs no parameter for it.
        if (this.functions.table.has(name)) continue;
        const decl = this.body.statements.find((item) => item.kind === "declare" && item.name === name);
        if (decl !== undefined && decl.kind === "declare" && decl.value.k === "text") {
          // A const string the program declares is written inline where it is
          // read, so a function that reads one needs no parameter for it.
          continue;
        }
        throw programError(
          `"${name}" is not declared`,
          this.body,
          statement.line,
          `line ${statement.line} of ${this.body.file}: ${statement.name} reads "${name}" of the scope it is declared in, and a name it reads is one the scope holds`,
        );
      }
      // A mutable text local captured by a nested program function is boxed:
      // the function is given a pointer to the shared cell that holds it, so a
      // write inside the function updates the caller's binding. A const string
      // is passed by value: the function is given the string itself, and a
      // const string written out in full is written inline where it is read.
      // A string the function was given is passed by value as well: it is the
      // function's own binding, and a function that reads it reads a copy.
      if (held.kind === "text") {
        if (!held.mutable && held.value !== null) continue;
        captures.push({ name, type: TEXT, held, boxed: held.mutable && held.parameter !== true });
        continue;
      }
      const type = heldType(held);
      if (type === null) {
        throw programError(
          `"${name}" is a string`,
          this.body,
          statement.line,
          `line ${statement.line} of ${this.body.file}: a function of a program is given a number or a buffer; a string is written inside it rather than read out of it`,
        );
      }
      captures.push({ name, type, held, boxed: false });
    }
    const draft: ProgramFunctionDraft = {
      name: statement.name,
      captured: captures,
      params,
      body: statement.body,
      line: statement.line,
      // What the function hands back is settled by reading its body, and the
      // names it is given are settled here, where the scope it reads is.
      signature: null,
      compiled: null,
      callback: false,
      serverHandler: false,
      ...(statement.async === true ? { async: true } : {}),
    };
    this.functions.table.set(statement.name, draft);
    this.functions.used.add(statement.name);
    this.functions.waiting.push(draft);
    // A function is also given what the functions it calls read, so the closure
    // is settled as soon as there is a call to settle it from.
    this.closure();
  }

  /**
   * What every function of the program is given: the names it reads of the
   * scope it is declared in, and the names the functions it calls read, to a
   * fixed point. A function is compiled on its own and every call passes it
   * what it needs, so a function that calls one needs what that one needs: a
   * body that calls a helper which reads `n` reads `n` itself, whether or not
   * it says so.
   */
  private closure(): void {
    for (let round = 0; round <= this.functions.table.size; round += 1) {
      let changed = false;
      for (const draft of this.functions.table.values()) {
        for (const called of calledNames(draft.body)) {
          const other = this.functions.table.get(called);
          if (other === undefined) continue;
          for (const capture of other.captured) {
            if (draft.params.some((param) => param.name === capture.name)) continue;
            if (draft.captured.some((one) => one.name === capture.name)) continue;
            draft.captured.push(capture);
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
    for (const draft of this.functions.table.values()) {
      // The parameters the source wrote come first, in the order it wrote them,
      // and the names the body reads of the scope around it come after: a
      // function of a program is compiled on its own, so what it reads from
      // around it is passed to it after the arguments the source wrote.
      const params = [
        ...draft.params.map((param, position) => ({
          name: param.name,
          // A parameter the source wrote no type for is read at the type its
          // callers pass it at.
          type:
            param.type === null
              ? inferredType(this.functions.observed.kindOf(draft.name, position))
              : contractText(param.type),
        })),
        ...draft.captured.map((capture) => ({
          // The name a capture arrives under is the name the scope it was taken
          // from holds it by, which is the name the body reads it by.
          name: capture.held.name,
          // A mutable string is shared through a cell, and the cell is what the
          // function is given; a string that is not written through is the
          // string itself.
          type: capture.boxed ? "boxedtext" : contractText(capture.type),
        })),
      ];
      draft.signature = {
        name: draft.name,
        symbol: draft.name === "main" ? PROGRAM_ENTRY_SYMBOL : draft.name,
        // A program is hosted by a driver that has a `main` of its own, so a
        // function the program declares under the name `main` is compiled
        // under another symbol. A module declares its functions before its
        // first statement and so is mangled by the frontend (see
        // `PROGRAM_ENTRY_SYMBOL`), but a program body is read from the first
        // statement and declares `main` there — secp256k1 declares its curve
        // constants first and its `main` last. Both are the same program, so
        // both spell the entry the one way, or the C the driver is written in
        // carries two `main` definitions and the link fails.
        params,
        returns: draft.signature?.returns ?? "void",
      };
    }
  }

  /**
   * The body of one function, read once however many call it. What it hands
   * back settles what a call of it is typed by, so a call reads the body of
   * what it calls before it types the call: a function of a program is
   * compiled on its own, and what it returns is part of its signature.
   */
  private settle(draft: ProgramFunctionDraft): void {
    if (draft.compiled !== null) return;
    if (this.functions.settling.has(draft)) {
      throw programError(
        `"${draft.name}" calls itself`,
        this.body,
        draft.line,
        `line ${draft.line} of ${this.body.file}: what a function hands back is settled by reading its body, and a function that calls itself is its own answer; write it as a function of the module, which is contracted and may recurse`,
      );
    }
    this.functions.settling.add(draft);
    // The body leaves the queue before it is read: reading it reaches the bodies
    // declared inside it, and those are settled from the queue this one is on.
    this.functions.waiting = this.functions.waiting.filter((one) => one !== draft);
    try {
      const body = this.read(draft);
      // What a function hands back is read from every `return` in its body and
      // not from the one at the top of it, because a return is a statement a
      // branch may hold: `if (x > 0) return 1; else return 2;` returns from both
      // arms and has no return at the top at all. Every return is a path out, so
      // the return type is the one they have in common, and two that have none
      // is a function the contract language cannot state.
      const results = returnsIn(body.statements);
      const answered = results.map((result) => this.returned(result));
      const first = answered[0];
      let returns = { kind: "void" } as TypeExpr;
      if (first === undefined) {
        // A body with no return at all hands back nothing, and that is the
        // answer a fold over no paths must not invent one for.
      } else if (results.every((result) => result.value !== null && isBigint(result.value))) {
        returns = numeric(BIGINT_TYPE);
      } else if (answered.every((type) => isNumberType(type))) {
        // Every number in a program is a double, and the one exception is a wide
        // number: a wide number beside a double is the wide one rather than the
        // three limbs above the first dropped before a backend is handed it.
        const wide = answered.find((type) => isWideType(type));
        returns = wide ?? numeric("f64");
      } else if (answered.some((type) => typeToString(type) !== typeToString(first ?? type))) {
        throw programError(
          `"${draft.name}" returns more than one type`,
          this.body,
          draft.line,
          `line ${draft.line} of ${this.body.file}: the function returns ${answered.map((type) => typeToString(type)).join(" and ")}, and a call is written against one return type; return the same type from every path`,
        );
      } else {
        returns = first;
      }
      if (draft.async === true) {
        // An async function answers a promise carrying what its body returns:
        // the value the body made is the promise's payload, and the type the
        // function itself returns is the handle the runtime holds it in. The
        // promise is settled before the call returns, so what `await` reads is
        // what the body returned.
        draft.payload = returns;
        returns = { kind: "ref", of: null };
      } else {
        // A plain function whose body returns a promise answers one to its
        // callers: `function get() { return new Promise(...); }` is awaited as
        // the promise it made, which is the one the value it returns carries.
        const promise = returnedPromise(body.statements);
        if (promise !== undefined) draft.payload = promise.payload;
      }
      draft.signature = { ...(draft.signature as FunctionSignature), returns: typeToString(returns) };
      draft.compiled = body;
    } finally {
      this.functions.settling.delete(draft);
    }
    // A function declared inside the body that was just read reads the scope it
    // was declared in, which is now settled: it is read here rather than at the
    // end of the program, so the function it is called from is compiled whole.
    for (const waiting of [...this.functions.waiting]) this.settle(waiting);
  }

  /**
   * What a function hands back, read as the type the body made it.
   *
   * A literal the return did not fix a type for is the thing it was written as:
   * `return 2` hands back a number and `return true` hands back a truth, and a
   * return that reads as nothing at all would settle the function as one that
   * returns nothing — which is a different function from the one written.
   */
  private returned(result: DraftStatement & { kind: "result" }): TypeExpr {
    if (result.value === null) return { kind: "void" };
    const written = draftType(result.value);
    if (written !== null) return written;
    const value = result.value;
    if (value.k === "literal") return numeric(isBigint(value) ? BIGINT_TYPE : "f64");
    if (value.k === "boolean") return { kind: "primitive", name: "bool" };
    // A string the body hands back is the string it is: a text is a value the
    // type of a draft does not spell, and a function that returns one from
    // every path is a function the call sites read the text of.
    if (holdsText(value)) return TEXT;
    return { kind: "void" };
  }

  /**
   * The statements of one function, resolved with its own parameters and every
   * name it reads of the scope around it declared as parameters of its own. The
   * types of those names are the types the scope it was declared in holds, and
   * they are settled at the declaration: a function is called from inside the
   * scope it was written in.
   */
  private read(draft: ProgramFunctionDraft): DraftProgram {
    if (draft.signature === null) {
      throw programError(
        `"${draft.name}" reads a name the scope around it does not hold`,
        this.body,
        draft.line,
        `line ${draft.line} of ${this.body.file}: declare the name above the function that reads it, or take it as a parameter of the function`,
      );
    }
    // A body is a program of its own: the same contracts and the same
    // functions, with the parameters and the captured names declared before
    // the first statement of the body runs.
    const inner = new ProgramResolver(
      this.body,
      this.contracts,
      this.objects,
      this.functions,
      this.objectLayoutNames,
      this.literalKeys,
    );
    inner.open();
    for (const [position, param] of draft.signature.params.entries()) {
      const held = heldOf(param.type);
      // A string the source wrote as a parameter is the function's own
      // binding: a function that reads it is given the string, and not the
      // cell a mutable local is shared through.
      if (held.kind === "text" && position < draft.params.length) held.parameter = true;
      inner.declareName(param.name, draft.line, held);
    }
    const statements = inner.statements(draft.body);
    inner.close();
    return {
      file: this.body.file,
      statements,
      functions: [...this.contracts.values()].map((contract) => contract.signature),
      declared: [],
      objects: this.objects,
      httpHandlers: [],
    };
  }

  /** The names the program holds, so a generated name is not one of them. */
  taken(): Set<string> {
    return this.functions.used;
  }

  /* ---------------------------------------------------------------------- */
  /* Scopes                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * The binding a name of the scope around holds, or nothing where the scope
   * holds none. The scope alone answers: a name is bound where it is declared,
   * and a declaration that shadows a name outside it is a binding of its own.
   */
  private lookup(name: string): Held | undefined {
    for (let index = this.scopes.length - 1; index >= 0; index -= 1) {
      const held = this.scopes[index].get(name);
      if (held !== undefined) return held;
    }
    return undefined;
  }

  /**
   * A const string the program declares at its top, which is written inline
   * where it is read: a function that reads one needs no parameter for it.
   *
   * The answer is a binding of its own, and it is not one the scope holds: a
   * name the program declares is bound when it is declared, and this is the
   * string as it was written out, which every reader of it agrees on.
   */
  private topLevelText(name: string): Held | undefined {
    const decl = this.body.statements.find((item) => item.kind === "declare" && item.name === name);
    if (decl !== undefined && decl.kind === "declare" && decl.value.k === "text") {
      const written = decl.value.parts
        .filter((part: any) => part.k === "text")
        .map((part: any) => part.value)
        .join("");
      const allText = decl.value.parts.every((part: any) => part.k === "text");
      return { kind: "text", name, mutable: decl.mutable, value: allText ? written : null } as Held;
    }
    return undefined;
  }

  private held(name: string, line: number): Held {
    const held = this.lookup(name) ?? this.topLevelText(name);
    if (held === undefined) {
      throw programError(
        `"${name}" is not declared`,
        this.body,
        line,
        `${this.body.file}: a program declares a value with const or let before it uses it`,
      );
    }
    return held;
  }

  /**
   * Whether a name counts with a wide number, which is not a machine word a
   * shift may be read at. Asked before the count is read, because reading one
   * at the width of a machine word is a conversion of the low limb rather than
   * the number the source wrote, and the shape of the refusal is what the
   * validator states.
   */
  private countsWide(name: string, line: number): boolean {
    const held = this.held(name, line);
    if (held.kind !== "number" || held.type === null) return false;
    return isWide(held.type);
  }

  private declareName(name: string, line: number, held: WithoutName<Held>): Held {
    if (this.scopes[this.scopes.length - 1].has(name)) {
      throw programError(`"${name}" is declared twice in the same block`, this.body, line);
    }
    // A name that shadows one outside this block is written down under a name
    // of its own. The IR names a value by the name the source wrote and has no
    // scope chain of its own, so two bindings answering to one name are one name
    // to everything downstream — and a function that captured the outer one is
    // handed the inner at its call site, because the call site is a different
    // scope and reads the name there. Renaming the shadowing declaration is what
    // keeps the two apart: the outer keeps the name the source wrote, and the
    // capture carries the binding rather than the name, so the call still passes
    // the binding it took.
    const bound = this.lookup(name) === undefined ? name : this.freshName(name);
    const declared = { ...held, name: bound } as Held;
    this.functions.used.add(name);
    this.scopes[this.scopes.length - 1].set(name, declared);
    return declared;
  }

  /**
   * A name no declaration of this program is written under, for a binding that
   * shadows another one of the same name.
   */
  private freshName(name: string): string {
    for (let index = 2; ; index += 1) {
      const candidate = `${name}_${index}`;
      if (this.scopes.every((scope) => !scope.has(candidate))) return candidate;
    }
  }

  private open(): void {
    this.scopes.push(new Map());
  }

  private close(): void {
    this.scopes.pop();
  }

  private mutable(held: Held, name: string, line: number): void {
    if (!held.mutable) {
      throw programError(
        `"${name}" is declared with const and cannot be changed`,
        this.body,
        line,
        `line ${line} of ${this.body.file}: write it with let, or declare it again where it changes`,
      );
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Statements                                                              */
  /* ---------------------------------------------------------------------- */

  private statements(list: readonly ProgramStatement[], hoisted = true): DraftStatement[] {
    // A function declared inside a function is bound to the body it is declared
    // in rather than to the statement it is written at, so a body may call what
    // it declares further down: the names such a function reads are the ones
    // the body holds, which is where they are declared. The top of a program is
    // the one block read in the order it runs, because what a function declared
    // there reads is whatever the program has declared by the time it is called.
    //
    // Reading that pass in order is what makes the block's *own* declarations
    // invisible to it, and a name the block declares shadows the one around it
    // for the whole of the block — a function declared beside it reads the
    // block's, not the one outside. So the names this block declares are
    // collected first and handed to the pass, which refuses a function that
    // reads one rather than resolving it to the binding outside. Answering 12
    // where the language answers 210 is not a shape worth carrying.
    if (hoisted) {
      const declaredHere: string[] = [];
      for (const statement of list) if (statement.kind === "declare") declaredHere.push(statement.name);
      for (const statement of list) {
        if (statement.kind === "function" && !this.functions.table.has(statement.name)) {
          this.declared(statement, declaredHere);
        }
      }
    }
    return list.flatMap((statement) => {
      const resolved = this.statement(statement);
      return resolved === null ? [] : [resolved];
    });
  }

  private block(body: ProgramStatement[]): DraftStatement[] {
    this.open();
    const resolved = this.statements(body);
    this.close();
    return resolved;
  }

  /** What a statement is, or null when it is a name the program binds. */
  private statement(statement: ProgramStatement): DraftStatement | null {
    switch (statement.kind) {
      case "declare":
        return this.declaration(statement);
      case "assign":
        return this.assignment(statement);
      case "fieldAssign":
        return this.fieldAssignment(statement);
      case "elementAssign":
        return this.elementAssignment(statement);
      case "fill":
        return this.filled(statement);
      case "update": {
        const held = this.held(statement.name, statement.line);
        this.mutable(held, statement.name, statement.line);
        if (held.kind !== "number" && held.kind !== "text") {
          throw programError(`"${statement.name}" is not a number`, this.body, statement.line);
        }
        if (held.kind === "text") {
          throw programError(`"${statement.name}" is a string`, this.body, statement.line, `line ${statement.line} of ${this.body.file}: only a number goes up and down`);
        }
        return {
          kind: "update",
          name: held.name,
          op: statement.op,
          prefix: statement.prefix,
          type: { kind: "primitive", name: held.type ?? "f64" },
          line: statement.line,
        };
      }
      case "print":
        return {
          kind: "print",
          values: statement.values.map((value) => {
            const resolved = this.value(value, null, statement.line);
            this.assertPrintable(resolved, statement.line);
            return resolved;
          }),
          line: statement.line,
        };
      case "invoke": {
        // `await v;` written as a statement: what the promise carries is not
        // read, but awaiting it still runs what settling it ran and still makes
        // the failure it carries one a catch arm sees. A value that is not a
        // promise is nothing to wait for: a call written there is the call the
        // statement runs, and a name is a reading with no effect.
        if (statement.function === "Promise.await") {
          const operand = this.value(statement.args[0] as ProgramValue, null, statement.line);
          if (promiseOf(operand) === undefined) {
            if (operand.k === "call") return { kind: "invoke", call: operand.call, line: statement.line };
            return { kind: "block", body: [], line: statement.line };
          }
          return { kind: "invoke", call: this.awaitCall(operand), line: statement.line };
        }
        const call = this.call({ k: "call", function: statement.function, args: statement.args }, statement.line);
        if (statement.grid !== undefined) {
          call.grid = this.value(statement.grid, null, statement.line);
        }
        return { kind: "invoke", call, line: statement.line };
      }
      case "if":
        return {
          kind: "if",
          condition: this.condition(statement.condition, statement.line),
          then: this.block(statement.then),
          otherwise: this.block(statement.otherwise),
          line: statement.line,
        };

      case "while": {
        // The body of a loop is a scope of its own, as the body of every other
        // block is: a name it declares is not a name outside it, and a name
        // outside it may be declared again inside it.
        this.open();
        const body = this.looped(statement.body);
        this.close();
        return {
          kind: "while",
          condition: this.condition(statement.condition, statement.line),
          body,
          line: statement.line,
        };
      }
      case "doWhile": {
        this.open();
        const body = this.looped(statement.body);
        this.close();
        return {
          kind: "doWhile",
          condition: this.condition(statement.condition, statement.line),
          body,
          line: statement.line,
        };
      }
      case "for":
        return this.counted(statement);
      case "forOf":
        return this.each(statement);
      case "break":
      case "continue":
        // Nothing else means anything outside a loop, so a program that writes
        // one there is refused here rather than written down.
        if (this.loops === 0) {
          throw programError(
            `"${statement.kind}" is not within a loop`,
            this.body,
            statement.line,
            `line ${statement.line} of ${this.body.file}: a program leaves a loop with break, and goes on with continue`,
          );
        }
        return statement.kind === "break"
          ? { kind: "break", line: statement.line }
          : { kind: "continue", line: statement.line };
      case "block":
        return { kind: "block", body: this.block(statement.body), line: statement.line };
      case "result":
        return {
          kind: "result",
          value: statement.value === null ? null : this.value(statement.value, null, statement.line),
          line: statement.line,
        };
      case "function":
        // A function is a name the program binds, and a name runs when it is
        // called: what is written here is its signature, and its body is
        // compiled once the scope it was declared in has every name in it.
        if (this.functions.table.has(statement.name) && this.functions.table.get(statement.name)?.line !== statement.line) {
          throw programError(
            `"${statement.name}" is declared twice`,
            this.body,
            statement.line,
            `line ${statement.line} of ${this.body.file}: a program compiles every function it declares under the name it is called by`,
          );
        }
        this.declared(statement);
        return null;
    }
  }

  private declaration(statement: ProgramStatement & { kind: "declare" }): DraftStatement {
    let annotation = statement.type === null ? null : this.annotation(statement.type, statement.line);
    // An empty array literal declared without an annotation is a dynamic array,
    // so it is resolved and checked as `any`.

    if (annotation === null && statement.value.k === "buffer" && statement.value.values.length === 0) {
      annotation = { kind: "ref", of: null };
    }

    // `const args = process.argv.slice(n)` binds `args` to the command line
    // advanced past the first `n` arguments: `args[i]` reads argument
    // `i + n` of it. The name is only ever indexed, so the binding stores the
    // first slice element as its value.
    if (statement.value.k === "argv") {
      const held: WithoutName<ArgvHeld> = { kind: "argv", mutable: statement.mutable, offset: statement.value.offset };
      const declared = this.declareName(statement.name, statement.line, held);
      const callValue = { k: "call", function: ARGV, args: [{ k: "number", text: String(held.offset) }] } as ProgramValue & { k: "call" };
      const value: DraftValue = { k: "call", call: this.call(callValue, statement.line) };
      return { kind: "declare", name: declared.name, held: declared, value, line: statement.line };
    }

    const value = this.value(statement.value, annotation, statement.line);
    const mutable = statement.mutable;
    // A declaration names the name the program declares, and the value is
    // written as it stands: what it is, the reader reads off what it holds.
    const declare = (held: WithoutName<Held>): DraftStatement => {
      const declared = this.declareName(statement.name, statement.line, held);
      return { kind: "declare", name: declared.name, held: declared, value, line: statement.line };
    };
    switch (value.k) {
      // A typed array is a name of its own, whichever of the three forms the
      // source wrote it in, and a fill is that array with every element
      // written: the fill is what the value is, and the name holds the array.
      case "buffer":
      case "sized":
      case "view":
      case "fill":
        if (value.k === "buffer" && Array.isArray(value.held.values) && value.held.values.length === 0) {
          const emptyArrayValue = this.value({ k: "call", function: "array.new", args: [] }, annotation, statement.line);
          const held = { kind: "object", mutable, type: { kind: "ref", of: null } as TypeExpr } as any;
          const declared = this.declareName(statement.name, statement.line, held);
          return { kind: "declare", name: declared.name, held: declared, value: emptyArrayValue, line: statement.line };
        }
        return declare({
          kind: "array",
          mutable,
          element: annotation === null ? value.held.element : elementOf(annotation),
          length: value.held.length,
          values: value.held.values,
        });
      case "fixed":
        return declare({ kind: "text", mutable, value: null });
      case "text": {
        const written = value.parts
          .filter((part) => part.k === "text")
          .map((part) => part.value)
          .join("");
        return declare({
          kind: "text",
          mutable,
          value: value.parts.every((part) => part.k === "text") ? written : null,
        });
      }
      case "reference": {
        const held = value.held;
        if (held.kind === "number") {
          return declare({ kind: "number", mutable, type: annotation !== null && primitive(annotation) !== null ? primitive(annotation)! : held.type, text: held.text, ...(held.bigint === true ? { bigint: true } : {}) });
        }
        if (held.kind === "array") {
          const alias: ArrayHeld = {
            kind: "array",
            name: "",
            mutable,
            element: held.element,
            length: held.length,
            values: [],
          };
          const named = this.declareName(statement.name, statement.line, alias);
          this.aliases.push([named as ArrayHeld, held]);
          return { kind: "declare", name: named.name, held: named, value, line: statement.line };
        }
        if (held.kind === "text") return declare({ kind: "text", mutable, value: held.value });
        if (held.kind === "object") {
          return declare({
            kind: "object",
            mutable,
            type: held.type,
            ...(held.promise === undefined ? {} : { promise: held.promise }),
          });
        }
        // A name bound to `process.argv` is a reference to an argument value.
        return declare({ kind: "object", mutable, type: { kind: "ref", of: null } });
      }
      case "function":
        // A name bound to a function (a lambda) is called by inlining its body
        // where the call is written, so the name itself is never read: declare
        // a placeholder the optimizer removes.
        return declare({ kind: "number", mutable, type: "i64", text: "0" });
      case "null":
        return declare({ kind: "object", mutable, type: REF_NULL });
      case "boolean":
        return declare({ kind: "number", mutable, type: "bool", text: value.value ? "true" : "false" });
      case "length":
        return declare({ kind: "number", mutable, type: value.type, text: "" });
      case "stringLength":
        return declare({ kind: "number", mutable, type: "usize", text: "" });
      case "element":
        return declare({ kind: "number", mutable, type: value.type, text: "" });
      case "field": {
        const parsed = value.type;
        if (parsed.kind === "ref" || parsed.kind === "ptr") {
          return declare({ kind: "object", mutable, type: parsed });
        }
        const name = primitive(parsed);
        if (name === null || !NUMERIC.includes(name)) {
          throw programError(
            `a program cannot hold ${typeToString(parsed)}`,
            this.body,
            statement.line,
            `line ${statement.line} of ${this.body.file}: a program holds numbers, strings and references`,
          );
        }
        return declare({ kind: "number", mutable, type: name, text: "" });
      }
      case "object":
        return declare({ kind: "object", mutable, type: value.type });
      case "literal":
        return declare({
          kind: "number",
          mutable,
          type: annotation !== null && annotation.kind === "primitive" ? annotation.name : value.held.type,
          text: value.held.text,
          ...(value.held.bigint === true ? { bigint: true } : {}),
        });
      case "compare":
      case "isNull":
        return declare({ kind: "number", mutable, type: "bool", text: "" });
      case "call": {
        const promise = value.call.promise;
        if (promise !== undefined) {
          // A promise is a handle the program holds, and what it carries is
          // what `await` reads out of it: the name keeps both.
          return declare({ kind: "object", mutable, type: value.call.returns, promise });
        }
        const returns = primitive(value.call.returns);
        if (returns !== null) {
          // A `u256` is the compiler's own spelling of a bigint, and a call that
          // hands one back is a bigint when everything it was made of was: the
          // name it is bound to keeps the mark, or printing it writes digits
          // where the source wrote them with the `n` that says which of the two
          // they are.
          const bigint = isBigint(value);
          return declare({ kind: "number", mutable, type: returns, text: "", ...(bigint ? { bigint: true } : {}) });
        }
        // A block of bytes is what the views over it are taken of, and a
        // program holds one as the reference it is.
        if (value.call.returns.kind === "text") {
          // A name bound to a call that hands back a string holds the string
          // it answered: a text is what the program holds, and the calls the
          // compiler provides answer the texts a program reads apart.
          return declare({ kind: "text", mutable, value: null });
        }
        if (value.call.returns.kind === "ref" || value.call.returns.kind === "ptr") {
          return declare({ kind: "object", mutable, type: value.call.returns });
        }
        throw programError(
          `${value.call.name} returns ${contractText(value.call.returns)}`,
          this.body,
          statement.line,
          `line ${statement.line} of ${this.body.file}: a program holds numbers, strings and references`,
        );
      }
      case "binary":
      case "unary":
      case "conditional": {
        const promise = promiseOf(value);
        if (promise !== undefined) {
          // A choice between promises is a promise: what it carries is what
          // the arm that was taken carries.
          return declare({ kind: "object", mutable, type: REF_NULL, promise });
        }
        // A string the program built is a string: `+` over two texts is one,
        // and a name bound to one holds a string rather than the number the
        // contract type language has no word for. The type of a text is
        // written as nothing, so the text is found by what the value holds.
        if (holdsText(value)) return declare({ kind: "text", mutable, value: null });
        const type = value.type;
        if (type === null) return declare({ kind: "number", mutable, type: "f64", text: "" });
        if (type.kind === "ref" || type.kind === "ptr") {
          return declare({ kind: "object", mutable, type });
        }
        const name = primitive(type);
        if (name === null || !NUMERIC.includes(name)) {
          throw programError(
            `a program cannot hold ${typeToString(type)}`,
            this.body,
            statement.line,
            `line ${statement.line} of ${this.body.file}: a program holds numbers, strings and references`,
          );
        }
        return declare({ kind: "number", mutable, type: name, text: "", ...(value.bigint === true ? { bigint: true } : {}) });
      }
      default:
        throw programError(
          `a program cannot hold this value`,
          this.body,
          statement.line,
          `line ${statement.line} of ${this.body.file}: a program holds numbers, strings and references`,
        );
    }
  }

  /**
   * A field of an object written, as `node.left = null` is. A plain `=` is one
   * store, and a compound one is a read of the field, the operation applied to
   * what was there, and the store of the answer.
   */
  private fieldAssignment(statement: ProgramStatement & { kind: "fieldAssign" }): DraftStatement {
    const held = this.held(statement.object, statement.line);
    if (held.kind !== "object") {
      throw programError(
        `"${statement.object}" is not an object`,
        this.body,
        statement.line,
        `line ${statement.line} of ${this.body.file}: a program writes the fields of an object it holds, as in node.left = null`,
      );
    }
    // The layout a name of an object holds carries with it: the field is a
    // field of the layout the reference points at, or nothing answers.
    if (held.type.kind !== "ref" || held.type.name === undefined) {
      throw programError(
        `"${statement.object}" is not an object the layout names`,
        this.body,
        statement.line,
        `line ${statement.line} of ${this.body.file}: a field write is a field of a layout, and a program writes the fields of the objects it laid out`,
      );
    }
    const laid = held.type.name;
    const layout = this.objects[laid] as ObjectLayout | undefined;
    if (layout === undefined) {
      throw programError(
        `"${laid}" is not a layout the program lays out`,
        this.body,
        statement.line,
        `line ${statement.line} of ${this.body.file}: a program writes the fields of the objects it laid out, and nothing else lays out ${laid}`,
      );
    }
    const found = layout.fields.find((field) => field.name === statement.field);
    if (found === undefined) {
      throw programError(
        `${laid} has no field "${statement.field}"`,
        this.body,
        statement.line,
        `line ${statement.line} of ${this.body.file}: write the field an object holds, or read one the layout states`,
      );
    }
    // What is written is read back at the type the layout gives the field, so a
    // field of a whole number is written a whole number and one of a reference
    // is written a reference.
    const type = parseType(found.type);
    const value = this.value(statement.value, type, statement.line);
    const object: DraftValue = { k: "reference", name: held.name, held };
    const read: DraftValue = { k: "field", object, layout: laid, field: statement.field, type };
    return {
      kind: "fieldAssign",
      object: held.name,
      type: held.type,
      layout: laid,
      field: statement.field,
      value:
        statement.op === "="
          ? value
          : {
              k: "binary",
              op: COMPOUND_BINARY[statement.op],
              left: read,
              right: value,
              type,
              ...(isBigint(value) ? { bigint: true as const } : {}),
            },
      line: statement.line,
    };
  }

  private assignment(statement: ProgramStatement & { kind: "assign" }): DraftStatement {
    const held = this.held(statement.name, statement.line);
    this.mutable(held, statement.name, statement.line);
    if (held.kind === "array") {
      throw programError(
        `"${statement.name}" is a buffer`,
        this.body,
        statement.line,
        `line ${statement.line} of ${this.body.file}: write an element of it, as in ${statement.name}[0] = 0`,
      );
    }
    if (held.kind === "object") {
      if (statement.op !== "=") {
        throw programError(
          `"${statement.op}" is not supported on an object reference`,
          this.body,
          statement.line,
          `line ${statement.line} of ${this.body.file}: assign a new reference, as in ${statement.name} = ${statement.name}`,
        );
      }
      const written = this.value(statement.value, null, statement.line);
      // What the name holds after the write is what was written: a promise is
      // a promise and a value that is not one clears what the name said before.
      if (promiseOf(written) === undefined) delete held.promise;
      else held.promise = promiseOf(written);
      return { kind: "assign", name: held.name, op: statement.op, value: written, type: null, line: statement.line };
    }
    if (held.kind === "text") {
      const written = this.value(statement.value, null, statement.line);
      // A number written into a string becomes its text, as `s += 1` does in
      // the language, rather than an error the source does not raise.
      const value = holdsText(written) ? written : { k: "text" as const, parts: [{ k: "value" as const, value: written }] };
      return { kind: "assign", name: held.name, op: statement.op, value, type: null, line: statement.line };
    }
    const name = held.kind === "number" ? held.type ?? "f64" : "f64";
    // A compound assignment writes its operator down on the type of the name,
    // so `%=` on a double is a target no compiler accepts. The operator decides
    // what the name may be, as it does in a binary expression, where a whole
    // operator needs whole numbers.
    if (WHOLE_ASSIGNMENTS.includes(statement.op) && !isWhole(name)) {
      throw programError(
        `"${statement.op.slice(0, -1)}" needs whole numbers`,
        this.body,
        statement.line,
        `line ${statement.line} of ${this.body.file}: "${statement.name}" is a ${name}, and "${statement.op}" rounds it to a whole number`,
      );
    }
    const type = numeric(name);
    // The count of a shift is a machine word, whatever the number being shifted
    // is: the kernel takes one word of count, and a count typed at the width of
    // a wide number is the low half of the number being shifted.
    const counted = statement.op === "<<=" || statement.op === ">>=" || statement.op === ">>>=";
    return {
      kind: "assign",
      name: held.name,
      op: statement.op,
      value: this.value(statement.value, counted ? USIZE : type, statement.line),
      type,
      line: statement.line,
    };
  }

  /**
   * `a.fill(x)` written for what it does: every element of the array written as
   * one value. The array is written from its first element, which is a name the
   * compiler makes rather than one the program declared, so two fills in one
   * block do not count with the same one.
   */
  private filled(statement: ProgramStatement & { kind: "fill" }): DraftStatement {
    const held = this.held(statement.buffer, statement.line);
    if (held.kind !== "array") {
      throw programError(
        `"${statement.buffer}" is not a buffer`,
        this.body,
        statement.line,
        `line ${statement.line} of ${this.body.file}: only an array has elements to fill`,
      );
    }
    const element = held.element ?? "f64";
    held.element ??= element;
    return {
      kind: "fill",
      buffer: this.reference(statement.buffer, statement.line),
      value: this.value(statement.value, numeric(element), statement.line),
      held: { ...held, mutable: true },
      line: statement.line,
    };
  }

  private elementAssignment(statement: ProgramStatement & { kind: "elementAssign" }): DraftStatement {
    const held = this.held(statement.buffer, statement.line);
    // Writing an element writes the array, not the name: a name declared with
    // const still names an array the program may change.
    if (held.kind !== "array") {
      throw programError(`"${statement.buffer}" is not a buffer`, this.body, statement.line, `line ${statement.line} of ${this.body.file}: only an array has elements`);
    }
    const element = held.element ?? "f64";
    held.element ??= element;
    const type = numeric(element);
    const index = this.value(statement.index, USIZE, statement.line);
    this.within(index, held, statement.line);
    return {
      kind: "elementAssign",
      buffer: held.name,
      index,
      op: statement.op,
      value: this.value(statement.value, type, statement.line),
      type,
      line: statement.line,
    };
  }

  private counted(statement: ProgramStatement & { kind: "for" }): DraftStatement {
    const bound = this.value(statement.to, null, statement.line);
    const boundType = primitive(draftType(bound) ?? numeric("f64")) ?? "f64";

    // What the index is follows from what it is built from, which is the
    // value it starts at and the value it moves by. The bound only says where
    // the loop stops: a loop that starts at 0 and steps by 1 counts in whole
    // numbers whatever it stops at, and a loop that starts at 0.5 counts in
    // halves however whole the bound is. Reading the start as whole when it is
    // not truncates it where it is declared, and the program counts from 0.
    const written = statement.step === null ? null : this.value(statement.step, null, statement.line);
    const stepIsWhole = written === null || countsWhole(written);
    const start = this.value(statement.from, null, statement.line);
    const whole = countsWhole(start) && stepIsWhole;
    // The width is the one a whole number the loop is built from was written
    // at. A number written in the source carries no width of its own — it is
    // a double until a use gives it another — so a loop over two of them
    // settles on the width arithmetic on a whole number uses, and it is not
    // the rule that makes `length - 10` a double. A bound of another width is
    // left out of it: it is only ever compared against, and the comparison
    // promotes the index to the bound's width, which is the one the language
    // makes.
    const startType = primitive(draftType(start));
    const widths = [startType, isWhole(boundType) ? boundType : null].filter(
      (name): name is PrimitiveTypeName => name !== null && isWhole(name),
    );
    const counted = whole ? (widths.length === 0 ? "i64" : programWholeOf(widths[0], widths[1] ?? widths[0])) : "f64";
    const type = numeric(statement.down && counted.startsWith("u") ? "i64" : counted);
    const from = this.value(statement.from, type, statement.line);
    // The bound is drafted at the width the loop counts in, unless the loop
    // counts in whole numbers and the bound is not one: a fraction read at a
    // whole width is a number the program never wrote, and the loop compares
    // against it as the fraction it is.
    const wholeCounter = primitive(type) !== null && isWhole(primitive(type) as PrimitiveTypeName);
    const to = wholeCounter && !countsWhole(bound)
      ? this.value(statement.to, null, statement.line)
      : this.value(statement.to, type, statement.line);
    const step = written === null ? null : this.value(statement.step as ProgramValue, type, statement.line);
    this.open();
    // A counter written as a bigint is one: `for (let i = 0n; ...)` counts in
    // bigints, so the counter is flagged the way the value it starts at is.
    const bigint = isBigint(from) || (step !== null && isBigint(step));
    const variable = this.declareName(statement.variable, statement.line, {
      kind: "number",
      mutable: true,
      type: primitive(type),
      text: "",
      ...(bigint ? { bigint: true } : {}),
    });
    const body = this.looped(statement.body);
    this.close();
    return {
      kind: "for",
      variable: variable.name,
      type,
      from,
      to,
      inclusive: statement.inclusive,
      down: statement.down,
      step,
      body,
      line: statement.line,
    };
  }

  /** The statements of a loop body, where a break and a continue may be. */
  private looped(body: ProgramStatement[]): DraftStatement[] {
    this.loops += 1;
    const resolved = this.statements(body);
    this.loops -= 1;
    return resolved;
  }

  private each(statement: ProgramStatement & { kind: "forOf" }): DraftStatement {
    const held = this.held(statement.of, statement.line);
    if (held.kind !== "array") {
      throw programError(
        `"${statement.of}" is not a buffer`,
        this.body,
        statement.line,
        `line ${statement.line} of ${this.body.file}: a program walks the arrays it allocated`,
      );
    }
    const element = held.element ?? "f64";
    held.element ??= element;
    this.open();
    const variable = this.declareName(statement.variable, statement.line, {
      kind: "number",
      mutable: false,
      type: element,
      text: "",
    });
    const body = this.looped(statement.body);
    this.close();
    return {
      kind: "forOf",
      variable: variable.name,
      type: numeric(element),
      of: held.name,
      length: { k: "length", buffer: held.name, bufferType: arrayType(held), type: "usize" },
      body,
      line: statement.line,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Values                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * True when a bigint is anywhere in the value as the source wrote it, which
   * is the question the language answers when it refuses to mix the two.
   *
   * It is asked of the value before it is resolved, because the two operators
   * that read both sides as something other than what they are — `>>>` and `**`
   * — are answered before the sides are resolved at all. It walks a name and
   * the two operations that compute a value out of other values, and answers
   * false for everything else: a length, an element and a call are numbers the
   * program read rather than wrote, and a function's own `bigint` is the `i64`
   * the contract states it as.
   */
  private bigintWritten(value: ProgramValue, line: number): boolean {
    switch (value.k) {
      case "whole":
        return true;
      case "name": {
        if (this.functions.table.has(value.name)) return false;
        const held = this.lookup(value.name) ?? this.topLevelText(value.name);
        if (held === undefined) return false;
        return held.kind === "number" && held.bigint === true;
      }
      case "binary":
        return this.bigintWritten(value.left, line) || this.bigintWritten(value.right, line);
      case "unary":
        return this.bigintWritten(value.operand, line);
      case "conditional":
        return this.bigintWritten(value.then, line) || this.bigintWritten(value.otherwise, line);
      case "object":
        return value.fields.some((field) => this.bigintWritten(field.value, line));
      default:
        return false;
    }
  }

  /** A condition: the truth of a value, which need not be a boolean. */
  private condition(value: ProgramValue, line: number): DraftValue {
    const resolved = this.value(value, null, line);
    if (resolved.k === "compare" || resolved.k === "isNull" || resolved.k === "boolean") return resolved;
    return resolved;
  }

  private value(value: ProgramValue, expect: TypeExpr | null, line: number): DraftValue {
    // A bigint read where a double is expected is the one conversion a program
    // makes that is never the same number: a double holds a whole number
    // exactly only up to 2^53, so reading 9007199254740993n as one answers
    // 9007199254992. The language refuses the use rather than rounding it, and
    // so does this, at the one place every use passes through: a call's
    // argument, a name written, an element written, a counter stepped and a
    // chosen arm all arrive here with the type their use fixed them at.
    //
    // A language that promotes does not refuse: a whole number beside a
    // fraction is a fraction there, and the whole number is read as the
    // fraction it is. That is the one place the two kinds of number meet, and
    // the language is what says which way they meet.
    const wanted = primitive(expect);
    if (this.rules.promotion === "refuse" && this.bigintWritten(value, line) && wanted !== null && isFloat(numeric(wanted))) {
      const read = numeric(wanted);
      throw programError(
        `a bigint is read as a ${typeToString(read)}`,
        this.body,
        line,
        `line ${line} of ${this.body.file}: a bigint is a whole number and a ${typeToString(read)} is not, and a bigint above 2^53 is not the number a double holds; write it as a number, or keep it a bigint`,
      );
    }
    switch (value.k) {
      case "number": {
        const held: NumberHeld = { kind: "number", name: "", mutable: false, type: null, text: value.text };
        if (expect !== null && primitive(expect) !== null) this.expectNumber(expect, held, line);
        return { k: "literal", held };
      }
      case "whole": {
        // A bigint is a whole number, and a whole number here is an `i64`. A
        // literal outside that range is not a value the program can hold: it
        // was written out as the low sixty-four bits of itself, so
        // `18446744073709551615n` printed -1 where the source prints itself.
        const literal = integerLiteral(value.text);
        if (literal === null) {
          return {
            k: "literal",
            held: { kind: "number", name: "", mutable: false, type: "i64", text: value.text, bigint: true },
          };
        }
        // When a `u64` is expected and the value fits in 64 unsigned bits, type
        // it as `u64` so it can be passed to `u256_from_u64x2` or
        // `u256_from_u64x4` without first being widened to `u256`.
        if (expect !== null && expect.kind === "primitive" && expect.name === "u64" && literal >= 0n && literal <= U64_MAX) {
          return {
            k: "literal",
            held: { kind: "number", name: "", mutable: false, type: "u64", text: value.text, bigint: true },
          };
        }
        if (literal > I64_MAX || literal < I64_MIN) {
          return {
            k: "literal",
            held: { kind: "number", name: "", mutable: false, type: "u256", text: value.text, bigint: true },
          };
        }
        return {
          k: "literal",
          held: { kind: "number", name: "", mutable: false, type: "i64", text: value.text, bigint: true },
        };
      }
      case "boolean":
        return { k: "boolean", value: value.value };
      case "null":
        return { k: "null", type: expect };
      case "arrow": {
        // Register the arrow as an anonymous function of the program, so its
        // body is compiled on its own. Its value is not yet a first-class
        // function pointer; lowering passes it to callback sites by name.
        const name = `__arrow_${line}`;
        // The parameters a Promise executor names its own resolve and reject by:
        // they are not values of the program, so a body that calls one resolves
        // the promise the executor runs for. The same reading answers whichever
        // of the four names the source wrote the pair by.
        const executorParams = new Set(["resolve", "reject", "onFulfilled", "onRejected"]);
        const params: { name: string; type: string }[] = value.params
          .filter((param) => !executorParams.has(param.name))
          .map((param) => ({ name: param.name, type: param.type === null ? "any" : param.type }));
        const statement: ProgramStatement & { kind: "function" } = {
          kind: "function",
          name,
          params,
          body: value.body,
          line,
          ...(value.async === true ? { async: true } : {}),
        };
        this.declared(statement);
        const declaredFn = this.functions.table.get(name);
        const captures = declaredFn?.captured.map((capture) => {
          const held = capture.held;
          // A number the program wrote out is the number it was written as,
          // wherever it is read; a number it computed is read by the name it
          // was declared under.
          const name = held.kind === "number" && !held.mutable && held.text !== "" ? held.text : held.name;
          return { name, type: capture.type };
        }) ?? [];
        return { k: "function", name, captures };
      }      case "shared": {
        // A block of bytes is what a view is taken of, and the runtime lays it
        // out: the program asks for a number of bytes and is given a block.
        const count = this.value(value.count, USIZE, line);
        return { k: "call", call: this.shared(count, line) };
      }
      case "sized":
        return {
          k: "sized",
          element: value.element,
          count: this.value(value.count, USIZE, line),
          held: this.arrayed(value.element, null),
        };
      case "view": {
        const of = this.value(value.of, null, line);
        const block = draftType(of);
        // A view is a window of a block of bytes, and a block is what a view
        // reads: a number is not a block however it is written.
        if (block === null || !isReference(block)) {
          throw programError(
            "a view is taken of a block of bytes",
            this.body,
            line,
            `line ${line} of ${this.body.file}: a view reads the block a name holds, as in new Float64Array(block, 0, n)`,
          );
        }
        return {
          k: "view",
          element: value.element,
          of,
          offset: this.value(value.offset, USIZE, line),
          count: this.value(value.count, USIZE, line),
          held: this.arrayed(value.element, null),
        };
      }
      case "fill": {
        // `a.fill(x)` answers the array with every element written, so what the
        // name is declared under is the array and what the source wrote happens
        // to it.
        const buffer = this.value(value.buffer, null, line);
        const held = this.arrayOf(buffer, line);
        return {
          k: "fill",
          buffer,
          value: this.value(value.value, numeric(held.element ?? "f64"), line),
          held: { ...held, mutable: true },
        };
      }
      case "buffer": {
        const held: ArrayHeld = {
          kind: "array",
          name: "",
          mutable: false,
          // The view the array was allocated from is what says the width of an
          // element. Left null for a use to fix, every array became a run of
          // doubles, so an `Int32Array` was lowered as `[f64; N]` and each of
          // its elements read eight bytes out of a four byte stride.
          element: value.element,
          length: value.values.length,
          // The elements take the type of the array they are written into,
          // which a use of the array fixes.
          values: value.values.map((element) => this.value(element, { kind: "primitive", name: value.element }, line)),
        };
        if (expect !== null) this.expectArray(expect, held, line);
        return { k: "buffer", held };
      }
      case "text":
        return { k: "text", parts: this.parts(value.parts, line) };
      case "fixed": {
        // What is written at a fixed number of digits is a number: a string is
        // already the text the digits would have been written into, and the
        // digits would be dropped rather than refused.
        const of = this.value(value.of, null, line);
        if (holdsText(of)) {
          throw programError(
            "a string is not written at a fixed number of digits",
            this.body,
            line,
            `line ${line} of ${this.body.file}: a string is already text; write it as it is`,
          );
        }
        return { k: "fixed", of, digits: value.digits };
      }
      case "name": {
        // A named program function is passed by name rather than by value, the
        // way an arrow function is: the call site that receives it lowers the
        // reference to the function's trampoline.
        if (this.functions.table.has(value.name)) {
          const declaredFn = this.functions.table.get(value.name);
          // A function handed to something as a callback is called by
          // something that is not a program, and passes it two values rather
          // than the arguments the source wrote.
          if (declaredFn !== undefined) declaredFn.callback = true;
          const captures = declaredFn?.captured.map((capture) => {
            const held = capture.held;
            // A number the program wrote out is the number it was written as,
            // wherever it is read; a number it computed is read by the name it
            // was declared under.
            const name = held.kind === "number" && !held.mutable && held.text !== "" ? held.text : held.name;
            return { name, type: capture.type };
          }) ?? [];
          return { k: "function", name: value.name, captures };
        }
        // A function of another file of the program is handed over by name as
        // well: the runtime calls it, and what calls it is the driver, which
        // links the object the function was compiled into.
        const contract = this.contracts.get(value.name);
        if (contract !== undefined) {
          return { k: "function", name: value.name, captures: [], symbol: contract.signature.symbol };
        }
        // An array is used at one element type, whichever name it is passed by.
        const held = this.held(value.name, line);
        if (held.kind === "array" && expect !== null) this.expectArray(expect, held, line);
        // A const string is the text it was written as, wherever it is read, so
        // it is written inline as the literal it is: a function that reads one
        // needs no parameter for it and no capture passed at the call.
        if (held.kind === "text" && !held.mutable && held.value !== null) {
          return { k: "text", parts: [{ k: "text", value: held.value }] };
        }
        return this.reference(value.name, line);
      }
      case "argv": {
        // `process.argv[i]` reads argument `i` of the command line, and
        // `process.argv.slice(n)[i]` reads argument `i + n`; either way the
        // argument is a number the runtime reads out of the arguments array.
        const offset = value.offset;
        const index = value.index === null ? { k: "number", text: String(offset) } : value.index;
        const argument = offset === 0
          ? index
          : index.k === "number"
            ? { k: "number", text: String(Number(index.text) + offset) }
            : { k: "binary", op: "+", left: index, right: { k: "number", text: String(offset) } };
        return {
          k: "call",
          call: this.call(
            { k: "call", function: ARGV, args: [argument] } as ProgramValue & { k: "call" },
            line,
          ),
        };
      }
      case "length": {
        const held = this.held(value.of, line);
        if (held.kind === "text") {
          return { k: "stringLength", of: { k: "reference", name: held.name, held } };
        }
        // A dynamic array is a value the runtime holds rather than a block of
        // bytes, so its length is read through the runtime.
        if (held.kind === "object") {
          return {
            k: "call",
            call: this.call(
              {
                k: "call",
                function: "array.length",
                args: [{ k: "name", name: held.name }],
              } as ProgramValue & { k: "call" },
              line,
            ),
          };
        }
        if (held.kind !== "array") {
          throw programError(
            `"${value.of}" has no length`,
            this.body,
            line,
            `${this.body.file}: a length belongs to an array or a string`,
          );
        }
        if (expect !== null && primitive(expect) !== "usize") {
          this.coerce("a length", USIZE, expect, line);
        }
        return { k: "length", buffer: held.name, bufferType: arrayType(held), type: "usize" };
      }
      case "field": {
        // The base of the read is resolved first: it is a name or another
        // field, and whatever it resolves to is the object read here is of.
        const base = this.value(value.object, null, line);
        // The layout a base points at: a name of an object slot carries the
        // layout it holds, and a field read of one is a reference to the layout
        // the field it read is a field of, so either way the name is there.
        let laid: string | undefined;
        if (base.k === "field") {
          // The layout of what the field holds, when the layout gives the field a
          // shape of its own: a literal written into a literal is an object of
          // its own, laid out beside the one it was written into, and a read of
          // what that field holds is a read of *that* layout rather than one
          // further down the same one. A field of a reference no layout names is
          // a field of the object it was read of, which is what a tree of one
          // shape is: every `left` of it names the layout the tree itself is.
          laid = referenceLayout(base.type);
          if (laid === undefined) laid = base.layout;
        } else if (base.k === "reference" && base.held.kind === "number") {
          laid = "JSON";
        } else if (base.k === "reference" && base.held.kind === "object" && base.held.type.kind === "ref") {
          if (base.held.type.name !== undefined) {
            laid = base.held.type.name;
          } else {
            // A dynamic value (such as the result of JSON.parse) has no fixed
            // layout; read its field through the JSON runtime.
            laid = "JSON";
          }
        } else if (base.k === "call") {
          // A field of what a call answered is a field of the layout the call
          // says it returns: `new Point(1, 2).x` reads the object the
          // constructor just built, and a method whose answer names its class
          // names the layout a caller reads.
          laid = referenceLayout(base.call.returns);
          if (laid === undefined) {
            throw programError(
              `the answer of "${base.call.signature.name}" has no layout to read a field of`,
              this.body,
              line,
              `line ${line} of ${this.body.file}: a field read is a field of a layout, and a program reads the fields of the objects it laid out`,
            );
          }
        } else {
          throw programError(
            base.k === "reference" ? `"${base.name}" is not an object the layout names` : "a field is read of something a program does not hold by name",
            this.body,
            line,
            `line ${line} of ${this.body.file}: a field read is a field of a layout, and a program reads the fields of the objects it laid out`,
          );
        }
        // The layout the base points at is the one the program lays out, and the
        // field is a field of it or nothing the program answers.
        const layout = laid === "JSON" ? undefined : (this.objects[laid as string] as ObjectLayout | undefined);
        if (laid !== "JSON" && layout === undefined) {
          throw programError(
            `"${laid}" is not a layout the program lays out`,
            this.body,
            line,
            `line ${line} of ${this.body.file}: a program reads the fields of the objects it laid out, and nothing else lays out ${laid}`,
          );
        }
        if (laid === "JSON") {
          return {
            k: "field",
            object: base,
            layout: laid as string,
            field: value.field,
            type: { kind: "primitive", name: "f64" },
          };
        }
        const found = layout!.fields.find((field) => field.name === value.field);
        if (found === undefined) {
          throw programError(
            `${laid} has no field "${value.field}"`,
            this.body,
            line,
            `line ${line} of ${this.body.file}: write the field an object holds, or read one the layout states`,
          );
        }
        const fieldType = parseType(found.type);
        // A field the layout holds a whole number in is a whole number: the
        // layout is what says the kind of the value, and the two kinds print
        // differently.
        const whole = fieldType.kind === "primitive" && fieldType.name === BIGINT_TYPE;
        return {
          k: "field",
          object: base,
          layout: laid as string,
          field: value.field,
          type: fieldType,
          ...(whole ? { bigint: true as const } : {}),
        };
      }
      case "object": {
        // The shape of the literal is the one the layout pass laid it out at,
        // read off this literal rather than derived from the parse tree: which
        // of two shapes folded into which is decided once the whole program has
        // been walked, and only that pass can say.
        const key = this.literalKeys.get(value);
        let layout = key === undefined ? undefined : this.objectLayoutNames.get(key);
        if ((key === undefined || layout === undefined) && value.fields.length > 0) {
          const fieldNames = new Set(value.fields.map((field: any) => field.name));
          const candidate = Object.values(this.objects).find((item: any) =>
            item.fields.length === value.fields.length &&
            item.fields.every((entry: any) => fieldNames.has(entry.name)),
          );
          if (candidate !== undefined) {
            layout = candidate!.name;
          } else {
          }
        }
        if (layout === undefined) {
          throw programError(
            "an object the program built is not laid out by it",
            this.body,
            line,
            `line ${line} of ${this.body.file}: the program lays out the objects its bodies write at the shapes they write; a literal of a shape the layout pass cannot read is refused where it is read`,
          );
        }
        const laid = this.objects[layout as string];
        // Every field is written as the type the layout gives it: a null is a
        // reference to nothing and holds no type of its own until the field it
        // is written into says which reference it is.
        const fields = value.fields.map((field) => {
          const declared = laid?.fields.find((entry) => entry.name === field.name)?.type;
          return {
            name: field.name,
            value: this.value(field.value, declared === undefined ? null : parseType(declared), line),
          };
        });
        return { k: "object", fields, layout, type: { kind: "ref", of: null, name: layout } };
      }
      case "element": {
        const held = this.held(value.buffer, line);
        // `args[i]` where `args` is `process.argv.slice(n)` reads argument
        // `i + n` of the command line, which the runtime hands back as a
        // number.
        if (held.kind === "argv") {
          const index = value.index;
          const argument = held.offset === 0
            ? index
            : index.k === "number"
              ? { k: "number", text: String(Number(index.text) + held.offset) }
              : { k: "binary", op: "+", left: index, right: { k: "number", text: String(held.offset) } };
          return {
            k: "call",
            call: this.call(
              { k: "call", function: ARGV, args: [argument] } as ProgramValue & { k: "call" },
              line,
            ),
          };
        }
        if (held.kind !== "array" && held.kind !== "object") {
          throw programError(
            `"${value.buffer}" is not a buffer`,
            this.body,
            line,
            `${this.body.file}: only an array has elements`,
          );
        }
        // A dynamic array is a value the runtime holds rather than a block of
        // bytes, so an element of one is read through the runtime.
        if (held.kind === "object") {
          return {
            k: "call",
            call: this.call(
              {
                k: "call",
                function: "array.get",
                args: [{ k: "name", name: held.name }, value.index],
              } as ProgramValue & { k: "call" },
              line,
            ),
          };
        }
        const element = (held.element ?? "f64") as PrimitiveTypeName;
        held.element ??= element;
        const index = this.value(value.index, USIZE, line);
        this.within(index, held, line);
        if (expect !== null) {
          this.coerce(`an element of ${value.buffer}`, { kind: "primitive", name: element }, expect, line);
        }
        return { k: "element", buffer: held.name, bufferType: arrayType(held), index, type: element };
      }
      case "call": {
        const folded = this.writtenBigInt(value);
        if (folded !== null) return folded;
        return { k: "call", call: this.call(value, line) };
      }
      case "unary":
        return this.unary(value, line);
      case "conditional": {
        const condition = this.condition(value.condition, line);
        const then = this.value(value.then, null, line);
        const otherwise = this.value(value.otherwise, expect, line);
        const type = expect ?? this.common(then, otherwise, line);
        // A choice between two bigints is a bigint: `x > 0 ? 1n : 2n` is the
        // whole number the arms are, and the flag is what writes it with the
        // `n` the language writes it with.
        if (isBigint(then) && isBigint(otherwise)) return { k: "conditional", condition, then, otherwise, type, bigint: true };
        return { k: "conditional", condition, then, otherwise, type };
      }
      case "binary":
        return this.binary(value, expect, line);
    }
  }

  /** What an array of a count the program settled on holds, before it is named. */
  private arrayed(element: PrimitiveTypeName, length: number | null): ArrayHeld {
    return { kind: "array", name: "", mutable: false, element, length, values: [] };
  }

  /** The call a block of bytes is laid out by. */
  private shared(count: DraftValue, line: number): DraftCall {
    const builtin = builtinFor(SHARED);
    if (builtin === null) throw programError("a block of bytes is not a call this compiler makes", this.body, line);
    return {
      name: SHARED,
      signature: {
        name: SHARED,
        symbol: SHARED,
        params: builtin.params.map((type, index) => ({ name: `argument${index}`, type: contractText(type) })),
        returns: contractText(builtin.returns),
      },
      args: [count],
      returns: builtin.returns,
      effects: [],
      builtin: true,
      bigint: false,
      // A block of bytes is laid out by the compiler itself and hands back a
      // reference, so no wide number is involved.
      wide: null,
    };
  }

  /** The array a value holds, or the diagnostic of what the value is instead. */
  private arrayOf(value: DraftValue, line: number): ArrayHeld {
    if (value.k === "reference" && value.held.kind === "array") return value.held;
    if (value.k === "buffer" || value.k === "sized" || value.k === "view" || value.k === "fill") return value.held;
    throw programError(
      "an array is what is written into element by element",
      this.body,
      line,
      `line ${line} of ${this.body.file}: a program fills the arrays it allocated, as in a.fill(1)`,
    );
  }

  private reference(name: string, line: number): DraftValue {
    const held = this.held(name, line);
    return { k: "reference", name: held.name, held };
  }

  private parts(parts: ProgramText[], line: number): DraftTextPart[] {
    return parts.map((part) =>
      part.k === "text"
        ? { k: "text" as const, value: part.value }
        : { k: "value" as const, value: this.value(part.value, null, line) },
    );
  }

  private unary(value: ProgramValue & { k: "unary" }, line: number): DraftValue {
    if (value.op === "-" || value.op === "+") {
      // The most negative value is written as a magnitude and a sign in front
      // of it, so the literal this reads is one past the top of the range. The
      // sign is folded in here, where the value it makes is in range, rather
      // than refused as a literal no `i64` holds.
      if (value.op === "-" && value.operand.k === "whole") {
        const literal = integerLiteral(value.operand.text);
        if (literal !== null && literal === -I64_MIN) {
          return {
            k: "literal",
            held: { kind: "number", name: "", mutable: false, type: "i64", text: `-${value.operand.text}` },
          };
        }
      }
      // A number written with its sign is one literal, so a use can still fix
      // its type without a conversion.
      if (value.operand.k === "number") {
        const text = value.op === "-" ? `-${value.operand.text}` : value.operand.text;
        return { k: "literal", held: { kind: "number", name: "", mutable: false, type: null, text } };
      }
      const resolved = this.value(value.operand, null, line);
      // A sign in front of a number is the number itself. A sign in front of a
      // string is the number the text names: the `+content` of a Promise the
      // HTTP answers in text is the read `Number(content)` makes of it.
      if (value.op === "+" && holdsText(resolved)) {
        return { k: "call", call: this.call({ k: "call", function: "Number", args: [value.operand] } as ProgramValue & { k: "call" }, line) };
      }
      if (value.op === "+") return resolved;
    }
    const operand = this.value(value.operand, null, line);
    if (value.op === "!") {
      if (holdsText(operand)) {
        return { k: "compare", how: "string", negate: true, left: operand, right: { k: "text", parts: [{ k: "text", value: "" }] } };
      }
      // `!a` over a reference asks whether it is nothing, which is the null
      // test and not its negation: `!node.left` is the arm a leaf takes. The
      // function lowering has always answered it this way; here it fell
      // through to the truth below and the validator refused the program with
      // a diagnostic naming a truth the source never wrote.
      // A use that fixed no type is a number here: nothing else is written
      // without one, and it is not a truth.
      const held = draftType(operand);
      if (held !== null && isReference(held)) {
        return { k: "isNull", operand, negate: false };
      }
      if (held === null || !isBoolean(held)) {
        throw programError("`!` needs something that is a truth", this.body, line, `line ${line} of ${this.body.file}: a number is not a truth, so the program says what it means by it`);
      }
      return { k: "unary", op: "!", operand, type: { kind: "primitive", name: "bool" } };
    }
    // `~` inverts a whole number bit by bit, and a number written in the source
    // is whole here because it is written without a point.
    if (value.op === "~") {
      // Inverting a number gives a signed one, as it does in the language: the
      // bits of 3 inverted are -4, and not a very large unsigned number. A wide
      // number is the one exception, because a signed machine word is not wide
      // enough to hold the three limbs above the first and they would be gone
      // before a backend was handed the value: a complement of four limbs is
      // what `~` is over a `u256`.
      const name = primitive(draftType(operand));
      if (name !== null && !isWhole(name)) throw programError("~ needs a whole number", this.body, line);
      if (name !== null && isWide(name)) return { k: "unary", op: value.op, operand, type: numeric(name) };
      // `-` and `~` answer a bigint as a bigint: `~5n` is `-6n` in the language
      // and not `-6`, and the difference is the `n` the printer writes after the
      // digits. The mark is on the operand rather than on the operator, so a
      // number with an `n` beside it keeps it and a number without one does not
      // gain it — and the validator's bigint rule only fires in the other
      // direction, so nothing downstream would have objected.
      return isBigint(operand) ? { k: "unary", op: value.op, operand, type: numeric("i64"), bigint: true } : { k: "unary", op: value.op, operand, type: numeric("i64") };
    }
    const type = primitive(draftType(operand)) ?? "f64";
    return isBigint(operand) ? { k: "unary", op: value.op, operand, type: numeric(type), bigint: true } : { k: "unary", op: value.op, operand, type: numeric(type) };
  }

  private binary(value: ProgramValue & { k: "binary" }, expect: TypeExpr | null, line: number): DraftValue {
    const op = value.op;
    if (LOGICAL.includes(op)) {
      // `a && b` is `b` when `a` holds, so the arms have a type of their own.
      const left = this.condition(value.left, line);
      const right = this.value(value.right, op === "??" ? null : expect, line);
      // `a ?? b` is `b` when `a` is nothing, so it has the type of whichever
      // arm holds; a number no use has fixed is a double, as it is written.
      const type =
        op === "??"
          ? holdsText(left) || holdsText(right)
            ? null
            : (draftType(left) ?? draftType(right) ?? numeric("f64"))
          : this.logicalType(left, right, line);
      return { k: "binary", op, left, right, type };
    }
    if (EQUALITY.includes(op)) {
      const left = this.value(value.left, null, line);
      const right = this.value(value.right, null, line);
      const compared = this.equality(op, left, right, line);
      if (compared.k === "boolean") return compared;
      return { ...compared, negate: op === "!==" || op === "!=" };
    }
    if (CONVERTING_OPERATORS.includes(op)) {
      // `>>>` is the shift the language converts rather than refuses: both of
      // its sides are read as the unsigned 32 bit numbers the language reads
      // them as, whatever they are, and what it answers is one of those. A
      // number written in a program is a double, so `x >>> 1` is the shift of
      // a double truncated to a whole number, which is what the source means.
      // A bigint is the one value it does not answer: the language reads both
      // sides as 32 bit numbers and a bigint is not one, so it raises rather
      // than truncating, and so does this.
      if (this.bigintWritten(value.left, line) || this.bigintWritten(value.right, line)) {
        throw programError(
          `"${op}" needs numbers`,
          this.body,
          line,
          `line ${line} of ${this.body.file}: both sides are read as 32 bit numbers, and a bigint is a whole number of sixty-four bits; use >> , which shifts a bigint as it is written`,
        );
      }
      const type = numeric("u32");
      return {
        k: "binary",
        op,
        left: this.value(value.left, type, line),
        right: this.value(value.right, type, line),
        type,
      };
    }
    const left = this.value(value.left, null, line);
    const leftName = primitive(draftType(left));
    // The count of a shift is the machine word every backend writes it at, which
    // the whole-number rule below cannot see: a count beside a wide number is
    // written as the count of the shift rather than as a number of the width
    // being shifted, and counting on the rule here would refuse `a << n` for a
    // program number `n` that the emitter writes correctly. A count that is
    // itself a wide number is refused rather than truncated differently on each
    // target, and the validator is where that refusal is stated.
    const counted = op === "<<" || op === ">>" || op === ">>>";
    const wideValue = leftName !== null && isWide(leftName);
    const wideCount = value.right.k === "name" && this.countsWide(value.right.name, line);
    const right = this.value(
      value.right,
      counted && wideValue && !wideCount ? USIZE : left.k === "literal" ? draftType(left) : null,
      line,
    );
    if (op === "+" && (holdsText(left) || holdsText(right))) {
      if (!holdsText(left) || !holdsText(right)) {
        throw programError(
          'a string is only added to a string',
          this.body,
          line,
          `line ${line} of ${this.body.file}: write the number as text, as in \`\${value}\``,
        );
      }
      return { k: "binary", op: "+", left, right, type: null };
    }
    if (op === "+" && (holdsArray(left) || holdsArray(right))) {
      if (!holdsArray(left) || !holdsArray(right)) {
        throw programError(
          'a list is only added to a list',
          this.body,
          line,
          `line ${line} of ${this.body.file}: write the list out, as in [1, 2, 3, 4]`,
        );
      }
      const type = draftType(left) ?? draftType(right);
      return { k: "binary", op: "+", left, right, type };
    }
    if (op === "**") {
      // A power of whole numbers is a whole number: it is folded where both
      // sides are written out, written as the products it is where the exponent
      // is a small constant, and refused otherwise. A double's power is what
      // the library answers, and a wide number is not one.
      const power = this.power(left, right);
      if (power !== null) return power;
      if (isBigint(left) || isBigint(right)) {
        throw programError(
          '"**" needs numbers',
          this.body,
          line,
          `line ${line} of ${this.body.file}: a power is a double and a bigint is a whole number, and the language raises on one raised to another; multiply it out, or convert it with Number()`,
        );
      }
      return {
        k: "binary",
        op,
        left: this.asNumber(left, line),
        right: this.asNumber(right, line),
        type: numeric("f64"),
      };
    }
    if (holdsText(left) || holdsText(right)) {
      throw programError(
        `"${op}" needs a number`,
        this.body,
        line,
        `line ${line} of ${this.body.file}: a string is added to a string, and compared with == and ===`,
      );
    }
    if (WHOLE_OPERATORS.includes(op)) {
      // `%`, a shift and a bitwise operator need whole numbers, and the
      // language raises on anything else rather than rounding it.
      for (const [what, side] of [["the left", left], ["the right", right]] as const) {
        // The count of a shift over a wide number is the one side the rule does
        // not hold: it is written as the machine word the kernel reads it at,
        // whatever the number written as the count is, because a count of the
        // width being shifted is the low half of the number being shifted.
        if (what === "the right" && counted && wideValue) continue;
        const name = primitive(draftType(side));
        const written = side.k === "literal" ? side.held.text : null;
        if (name === null && (written === null || isWholeLiteral(written))) continue;
        if (name !== null && isWhole(name)) continue;
        throw programError(
          `"${op}" needs whole numbers`,
          this.body,
          line,
          `line ${line} of ${this.body.file}: ${what} is ${
            name === null && written !== null ? `the value ${written}` : `a ${typeToString(draftType(side) ?? numeric("f64"))}`
          }, and "${op}" rounds it to a whole number`,
        );
      }
    }
    // A bigint is not a number the language adds to another, and the reason is
    // the one the arithmetic is refused for rather than the one it is rounded
    // for: `1n + 1.5` is a type error in the language, and a program that
    // answered it as a whole number would be answering a different program.
    const leftBig = isBigint(left);
    const rightBig = isBigint(right);
    // A wide number is not a number the language raises on: the language has no
    // such type, so a `u256` beside a bigint is the compiler's own widening of
    // one rather than a mix of two kinds, and what the widening holds is the
    // validator's rule (`semantics/ir-validate.ts:wideningReason`) rather than
    // this one.
    const wideBeside = [left, right].some((value) => {
      const name = primitive(draftType(value));
      return name !== null && isWide(name);
    });
    if (leftBig !== rightBig && !wideBeside && this.rules.promotion === "refuse") {
      // What each side is, rather than which of the two is a bigint: a `u256`
      // is held at sixty-four bits and so reads as one here, and naming the two
      // as "a bigint and a bigint" says of a program that nothing is wrong.
      // What the language calls the value, which is not the contract's name for
      // it: every number that is not a bigint is a number to a program, and it
      // is held at sixty-four bits here without being one.
      const side = (value: DraftValue, big: boolean): string => {
        if (big) return "a bigint";
        if (holdsText(value)) return "a string";
        const name = primitive(draftType(value));
        if (name !== null && isWide(name)) return `a ${name}`;
        return "a number";
      };
      throw programError(
        `"${op}" cannot mix ${side(left, leftBig)} and ${side(right, rightBig)}`,
        this.body,
        line,
        `line ${line} of ${this.body.file}: the language adds, subtracts, multiplies, divides and compares a bigint with another bigint and raises on a number beside one; convert it with Number() and say which of the two you meant`,
      );
    }
    // The right side's own name, read once here: the left one was read where the
    // count of a shift was decided, because a count beside a wide number is the
    // machine word the kernel takes.
    const wholeRightName = primitive(draftType(right));
    // A comparison holds or it does not. A whole operator needs whole numbers
    // and yields one, whatever the literals it was written with: `7 % 3` is 1.
    const whole = WHOLE_OPERATORS.includes(op);
    // The rules of the language the program was written in are asked of the
    // language: a division of two whole numbers is a whole division in one
    // language and a true division in another, and the answer of a true
    // division is a fraction however whole its sides were.
    const rules = this.rules;
    const trueDivision = op === "/" && rules.division === "true";
    // A whole number beside a fraction is a fraction in a language that
    // promotes: `1 + 1.5` is 2.5 there, and the answer is the fraction it is.
    // The whole number is read as the fraction it is, and the answer is not a
    // whole number, so it is written the way a fraction is written.
    const promoted = leftBig !== rightBig && rules.promotion === "promote";
    const type = COMPARISONS[op] !== null
      ? numeric("bool")
      : trueDivision || promoted
        ? numeric("f64")
        : // A wide number beside a bigint keeps its own width: the `i64` a bigint
        // is computed in would drop the three limbs above the first before a
        // backend is handed the value, which is the same reason `wholeResult`
        // and `numericResult` ask about a wide number before anything else.
        wideBeside
        ? numeric(wholeResult(leftName, wholeRightName))
        : leftBig
          ? numeric(BIGINT_TYPE)
          : whole
            ? numeric(wholeResult(leftName, wholeRightName))
            : numeric(numericResult(leftName, wholeRightName, op === "/"));
    return leftBig && !trueDivision && !promoted
      ? { k: "binary", op, left, right, type, bigint: true }
      : { k: "binary", op, left, right, type };
  }

  /**
   * The value of a power of whole numbers, or null where it is not one this
   * program can answer.
   *
   * A constant base and a constant exponent are folded at the width that holds
   * the answer. A base the program reads is multiplied by itself for each count
   * of a small exponent, because a power of a whole number is a product of them
   * and no kernel has a wide power.
   */
  private power(left: DraftValue, right: DraftValue): DraftValue | null {
    const exponent = right.k === "literal" ? integerLiteral(right.held.text) : null;
    if (exponent === null || exponent < 0n) return null;
    const name = primitive(draftType(left));
    if (name === null || !isWhole(name)) return null;
    // A bigint and a number are not mixed, and a power is where that rule is
    // easiest to miss: `2n ** 3` is a bigint raised by a number, which the
    // language raises on rather than reading one as the other. A wide number
    // is the exception: it is the compiler's own widening, and the exponent of
    // one is a count it reads as a whole number.
    if (isBigint(left) !== isBigint(right) && !isWide(name)) return null;
    if (left.k === "literal") {
      const base = integerLiteral(left.held.text);
      if (base === null) return null;
      const exact = wholePower(base, exponent);
      if (exact === null) return null;
      const wide = isWide(name) || exact > I64_MAX || exact < I64_MIN;
      const held = wide ? "u256" : "i64";
      return {
        k: "literal",
        held: {
          kind: "number",
          name: "",
          mutable: false,
          type: held,
          text: wrapped(exact, held).toString(),
          ...(isBigint(left) ? { bigint: true as const } : {}),
        },
      };
    }
    // A value that computes something would run again for every factor, and
    // the program wrote it once. A name is a read, and a read has no side
    // effect, and the count of factors a read is written out for is small.
    if (left.k !== "reference" || exponent > 64n) return null;
    if (exponent === 0n) {
      return {
        k: "literal",
        held: {
          kind: "number",
          name: "",
          mutable: false,
          type: isWide(name) ? "u256" : "i64",
          text: "1",
          ...(isBigint(left) ? { bigint: true as const } : {}),
        },
      };
    }
    let product: DraftValue = left;
    for (let factor = 1n; factor < exponent; factor += 1n) {
      product = {
        k: "binary",
        op: "*",
        left: product,
        right: left,
        type: numeric(isWide(name) ? "u256" : "i64"),
        ...(isBigint(left) ? { bigint: true as const } : {}),
      };
    }
    return product;
  }

  /**
   * `BigInt(x)` of a value written out, answered here rather than at a runtime
   * that has no such call.
   */
  private writtenBigInt(value: ProgramValue & { k: "call" }): DraftValue | null {
    if (value.function !== "BigInt" || value.args.length !== 1) return null;
    const argument = value.args[0] as ProgramValue;
    const text = argument.k === "number" || argument.k === "whole"
      ? argument.text
      : argument.k === "text" && argument.parts.length === 1 && argument.parts[0].k === "text"
        ? argument.parts[0].value
        : null;
    if (text === null) return null;
    const literal = integerLiteral(text);
    if (literal === null) return null;
    const wide = literal > I64_MAX || literal < I64_MIN;
    return {
      k: "literal",
      held: {
        kind: "number",
        name: "",
        mutable: false,
        type: wide ? "u256" : "i64",
        text: wrapped(literal, wide ? "u256" : "i64").toString(),
        bigint: true,
      },
    };
  }

  private equality(
    op: ProgramBinaryOp,
    left: DraftValue,
    right: DraftValue,
    line: number,
  ): { k: "compare"; how: "number" | "string"; negate: boolean; left: DraftValue; right: DraftValue } | { k: "isNull"; operand: DraftValue; negate: boolean } | { k: "boolean"; value: boolean } {
    if (left.k === "null" && right.k === "null") {
      return { k: "isNull", operand: left, negate: op === "!==" || op === "!=" };
    }
    if (right.k === "null") {
      if (draftType(left) === null || holdsText(left)) {
        throw programError("a string is never null", this.body, line, `line ${line} of ${this.body.file}: a string is as long as it is`);
      }
      return { k: "isNull", operand: left, negate: op === "!==" || op === "!=" };
    }
    if (left.k === "null") {
      if (draftType(right) === null || holdsText(right)) {
        throw programError("a string is never null", this.body, line, `line ${line} of ${this.body.file}: a string is as long as it is`);
      }
      return { k: "isNull", operand: right, negate: op === "!==" || op === "!=" };
    }
    // `==` compares across types, as it does in the language: a number is the
    // text of a number. `===` is false when the two are of different types.
    const loose = op === "==" || op === "!=";
    const stringSide = holdsText(left) || holdsText(right);
    if (stringSide) {
      if (!loose && !(holdsText(left) && holdsText(right))) {
        // A string is never the number it is compared with, so the answer is
        // known here rather than in a backend, which cannot compare them.
        return { k: "boolean", value: op === "!==" };
      }
      return {
        k: "compare",
        how: "string",
        negate: false,
        left: this.asText(left),
        right: this.asText(right),
      };
    }
    return { k: "compare", how: "number", negate: false, left, right };
  }

  /** A value as the text of the language it was written in. */
  private asText(value: DraftValue): DraftValue {
    if (holdsText(value)) return value;
    return { k: "text", parts: [{ k: "value", value }] };
  }

  private asNumber(value: DraftValue, line: number): DraftValue {
    if (holdsText(value) || value.k === "null") {
      throw programError("a number is needed", this.body, line);
    }
    return value;
  }

  /**
   * The type the arms of a short-circuit operator have in common, which is the
   * type of the arm the operator hands back.
   *
   * An arm that is a number or a truth is the test that decides whether the
   * other arm is handed back, so the two may be of different kinds: a number
   * beside a text is the test, and the text is the value the operator is
   * written as. The number is written as the text of that number when it is
   * the arm that answers.
   */
  private logicalType(left: DraftValue, right: DraftValue, line: number): TypeExpr | null {
    const a = primitive(draftType(left));
    const b = primitive(draftType(right));
    const test = (name: PrimitiveTypeName | null): boolean => name !== null && (NUMERIC.includes(name) || name === "bool");
    if (holdsText(left) && test(b)) return null;
    if (holdsText(right) && test(a)) return null;
    return this.common(left, right, line);
  }

  /** The type two values of one expression have in common. */
  private common(left: DraftValue, right: DraftValue, line: number): TypeExpr | null {
    const a = draftType(left);
    const b = draftType(right);
    // Two numbers no use has fixed are doubles, as they are written; two
    // strings are text, and have no type at all.
    if (a === null && b === null) return holdsText(left) || holdsText(right) ? null : numeric("f64");
    if (a === null) return b;
    if (b === null) return a;
    if (a.kind === "primitive" && b.kind === "primitive" && a.name === b.name) return a;
    if (primitive(a) === null || primitive(b) === null) {
      if (a.kind === "slice" && b.kind === "slice") return a;
      // Two references are references: a choice between two promises, or
      // between two values the runtime holds, is a value the runtime holds.
      if (a.kind === "ref" || b.kind === "ref") return a.kind === "ref" ? a : b;
      throw programError(
        `a value of ${typeToString(a)} cannot be used where ${typeToString(b)} is`,
        this.body,
        line,
      );
    }
    if (!NUMERIC.includes(primitive(a)!) || !NUMERIC.includes(primitive(b)!)) {
      if (a.kind === "ref" || b.kind === "ref") return a.kind === "ref" ? a : b;
      throw programError(
        `a value of ${typeToString(a)} cannot be used where ${typeToString(b)} is`,
        this.body,
        line,
      );
    }
    return { kind: "primitive", name: numericResult(primitive(a), primitive(b), false) };
  }

  /**
   * The builtin a call is answered by, when the answer of the call keeps the
   * kind of the number it was given.
   *
   * The compiler's `Math.abs` answers a fraction, and a language whose whole
   * numbers are whole answers the magnitude of one as a whole number. The
   * language is what says which one a program means, and the call is answered
   * by the whole one where the language says so.
   */
  private answeredBy(name: string, builtin: BuiltinSignature, args: readonly DraftValue[]): { name: string; builtin: BuiltinSignature } {
    if (!this.rules.wholeAnswers) return { name, builtin };
    const whole = WHOLE_ANSWERS[name];
    if (whole === undefined || args.length === 0) return { name, builtin };
    // Every side has to be a whole number: the answer of a call over a whole
    // number and a fraction is a fraction, which is what the language says.
    if (!args.every((argument) => isBigint(argument))) return { name, builtin };
    const answered = builtinFor(whole);
    return answered === null ? { name, builtin } : { name: whole, builtin: answered };
  }

  /**
   * The call `await v` becomes, against the value `v` carries.
   *
   * A promise is a handle the runtime owns, and what is read out of it is the
   * value it was settled with: a string is read as the bytes it is, a number as
   * the number, a truth as the truth, and a value of a shape the compiler does
   * not name as the dynamic value it is.
   */
  private awaitCall(operand: DraftValue): DraftCall {
    const known = promiseOf(operand)?.payload;
    const payload = known ?? numeric("f64");
    const callee = known === undefined
      ? "Promise.await"
      : payload.kind === "text"
        ? "Promise.await.text"
        : isBoolean(payload)
          ? "Promise.await.bool"
          : payload.kind === "primitive" && isWhole(payload.name)
            ? "Promise.await.whole"
            : payload.kind === "void"
              ? "Promise.await.nothing"
              : payload.kind === "ref"
                ? "Promise.await.value"
                : "Promise.await";
    const builtin = builtinFor(callee) as BuiltinSignature;
    return {
      name: callee,
      signature: {
        name: callee,
        symbol: callee,
        params: [{ name: "promise", type: "ref<any>" }],
        returns: contractText(builtin.returns),
      },
      args: [operand],
      returns: builtin.returns,
      effects: [],
      builtin: true,
      bigint: false,
      wide: null,
      awaiting: true,
    };
  }

  /**
   * What a builtin that answers a promise says about the value that promise
   * carries. `Promise.resolve(v)` carries `v` and a promise built from an
   * executor carries what the executor settles it with. A promise whose value
   * cannot be read here carries a value read dynamically.
   */
  /** The call a resolved promise is written as, against the value it carries. */
  private resolvedCall(operand: DraftValue, callee: string): DraftCall {
    const builtin = builtinFor(callee) as BuiltinSignature;
    return {
      name: callee,
      signature: {
        name: callee,
        symbol: callee,
        params: builtin.params.map((type, index) => ({ name: `argument${index}`, type: contractText(type) })),
        returns: contractText(builtin.returns),
      },
      args: [operand],
      returns: builtin.returns,
      effects: [],
      builtin: true,
      bigint: false,
      wide: null,
      promise: { payload: payloadTypeOf(operand) },
    };
  }

  private builtinPromise(name: string, args: readonly DraftValue[]): { promise?: { payload: TypeExpr } } | null {
    const payload = { payload: { kind: "ref", of: null } as TypeExpr };
    if (name === "Promise") {
      const executor = args[0];
      let carried: TypeExpr = payload.payload;
      if (executor !== undefined && executor.k === "function" && typeof executor.name === "string") {
        const draft = this.functions.table.get(executor.name);
        if (draft !== undefined) {
          this.settle(draft);
          if (draft.compiled !== null) {
            carried = executorPayload(draft.compiled, (name) => {
              const nested = this.functions.table.get(name);
              if (nested === undefined) return null;
              this.settle(nested);
              return nested.compiled;
            });
          }
        }
      }
      return { promise: { payload: carried } };
    }
    if (name === "Promise.resolve") return { promise: { payload: payloadTypeOf(args[0] as DraftValue) } };
    if (name === "Promise.resolve.text") return { promise: { payload: TEXT } };
    if (name === "Promise.resolve.bool") return { promise: { payload: BOOLEAN } };
    if (name === "Promise.resolve.nothing") return { promise: { payload: VOID } };
    if (name === "Promise.resolve.value") return { promise: payload };
    if (name === "Promise.reject") return { promise: payload };
    return null;
  }

  private call(value: ProgramValue & { k: "call" }, line: number): DraftCall {
    const builtin = builtinFor(value.function);
    if (builtin !== null) {
      if (builtin.moduleOnly === true) {
        throw programError(
          `${value.function} is the HTTP API of a module function`,
          this.body,
          line,
          "a program body reads the request with req.path, req.method and req.text(), and answers it with res.writeHead, res.setHeader and res.end",
        );
      }
      const counts = builtin.arities ?? [builtin.arity ?? builtin.params.length];
      if (!counts.includes(value.args.length)) {
        throw programError(
          `${value.function} takes ${counts.join(" or ")} argument(s), not ${value.args.length}`,
          this.body,
          line,
        );
      }
      const args = value.args.map((argument, position) =>
        this.value(argument, builtin.params[position].kind === "text" ? null : builtin.params[position], line),
      );
      // `await v` is not a call the runtime makes before the operand is read:
      // what is awaited decides which value is read out of the promise, so the
      // call is written as the one that reads that value.
      if (value.function === "Promise.await") {
        return this.awaitCall(args[0] as DraftValue);
      }
      // `asyncio.run(v)` is the value the coroutine's promise carries: a
      // Python program has no top-level `await`, so this is where it reads one.
      if (value.function === "asyncio.run") {
        return this.awaitCall(args[0] as DraftValue);
      }
      // `Promise.resolve(v)` carries the value `v` is, so the call is written
      // as the one that resolves a value of that shape: a string as a string,
      // a truth as a truth, and a value of a shape nothing names as the dynamic
      // value it is.
      if (value.function === "Promise.resolve") {
        const argument = args[0] as DraftValue;
        const payload = payloadTypeOf(argument);
        const callee = payload.kind === "text"
          ? "Promise.resolve.text"
          : isBoolean(payload)
            ? "Promise.resolve.bool"
            : payload.kind === "ref"
              ? "Promise.resolve.value"
              : "Promise.resolve";
        return this.resolvedCall(argument, callee);
      }
      // The answer of a call that takes a number and answers a number keeps the
      // kind of the number it was given, in a language that says so: Python's
      // `abs` of a whole number is a whole number, and the compiler's
      // `Math.abs` answers a fraction. The two are two kinds of number, and
      // the printer writes them differently, so the call is answered by the
      // whole one where the language says so.
      const answered = this.answeredBy(value.function, builtin, args);
      // The handler a server is given is called by the runtime, which passes
      // it the request and the response and nothing else. The names the
      // handler captured are not among them, so the handler is marked here and
      // the trampoline that calls it reads them from where the program left
      // them.
      if (value.function === "http.createServer") {
        const handler = args[0];
        if (handler !== undefined && handler.k === "function" && typeof handler.name === "string") {
          const draft = this.functions.table.get(handler.name);
          if (draft !== undefined) {
            draft.serverHandler = true;
          } else if (handler.symbol !== undefined) {
            // A handler of another file of the program is compiled on its own
            // and linked beside the program, and the driver writes the bridge
            // between the runtime and it.
            this.httpHandlers.push(handler.symbol);
          }
        }
      }
      return {
        name: answered.name,
        signature: {
          name: answered.name,
          symbol: answered.name,
          params: answered.builtin.params.map((type, index) => ({ name: `argument${index}`, type: contractText(type) })),
          returns: contractText(answered.builtin.returns),
        },
        args,
        returns: answered.builtin.returns,
        // What the builtin does beyond answering: a builtin that reads the
        // world is not a value the optimizer may compute twice or move.
        effects: [...(answered.builtin.effects ?? [])],
        builtin: true,
        // A builtin that answers a whole number answers a bigint, which is
        // what says the answer is a whole number and not a fraction: the
        // printer writes the two differently.
        bigint: returnsBigint(contractText(answered.builtin.returns)),
        // A builtin is written by the compiler and returns a number of its
        // own, so the question a wide number asks it does not arise.
        wide: null,
        ...(answered.name.startsWith("Promise") ? { ...(this.builtinPromise(answered.name, args) ?? {}) } : {}),
      };
    }
    // A function the program declared is called like any other: it is compiled
    // on its own, and what it hands back is settled by reading its body, so a
    // call reads the body of what it calls before it types the call.
    const declared = this.functions.table.get(value.function);
    if (declared !== undefined) {
      // What the arguments are written as is what the parameters the source
      // wrote no type for are read at. The kinds are read here, at the call
      // site, and the program is read again until they stop changing: a
      // parameter of a function is read at the type the callers of that
      // function pass it at, and a caller may itself be read at a type only a
      // later round settles.
      for (const [position, argument] of value.args.entries()) {
        if (declared.params[position]?.type !== null) continue;
        const kind = this.kindOf(argument, line);
        if (kind === "text" || kind === "number") {
          this.functions.observed.record(value.function, position, kind);
        }
      }
      this.settle(declared);
      const signature = declared.signature as FunctionSignature;
      // The arguments the source wrote are the ones it takes: what it reads of
      // the scope around it is passed at every call and counted by neither.
      const arity = signature.params.length - declared.captured.length;
      if (value.args.length !== arity) {
        const expected = signature.params
          .slice(0, arity)
          .map((param) => `${param.name}: ${param.type}`)
          .join(", ");
        throw programError(
          `${value.function} takes ${arity} argument(s), not ${value.args.length}`,
          this.body,
          line,
          `line ${line} of ${this.body.file}: ${expected}`,
        );
      }
      // What the function reads of the scope it was declared in is passed to it
      // at every call, after the arguments the source wrote: the call is the
      // only place the two scopes meet, so the call is what hands them over.
      const written = value.args.map((argument, position) => {
        const wanted = signature.params[position].type;
        const resolved = this.value(argument, parameterExpect(wanted), line);
        // A parameter written as a string is given a string: a number is not
        // one, and the language has no way of turning a number into a string
        // the caller did not write. A value the runtime holds is a string when
        // it holds one, and the runtime renders it at the use.
        const given = draftType(resolved);
        if ((wanted === "text" || wanted === "boxedtext") && given !== null && isNumberType(given)) {
          throw programError(
            `"${signature.params[position].name}" is given a value that is not a string`,
            this.body,
            line,
            `line ${line} of ${this.body.file}: a parameter written as a string is given a string`,
          );
        }
        return resolved;
      });
      // The binding the capture was taken from, not a name looked up here: the
      // call is in a different scope from the declaration, and a declaration
      // that shadows the name between the two is a different binding that
      // answers to the same one. `let base = 1; function f(x) { return x + base;
      // } { let base = 100; console.log(f(10)); }` answers 11, and passing the
      // inner binding answered 110.
      const captured = declared.captured.map((capture, position) => {
        const paramType = signature.params[value.args.length + position].type;
        if (paramType !== "text" && paramType !== "boxedtext") {
          const expected = parseType(paramType);
          if (capture.held.kind === "array") this.expectArray(expected, capture.held, line);
        }
        return { k: "reference", name: capture.held.name, held: capture.held } satisfies DraftValue;
      });
      const held = primitive(parseType(signature.returns));
      return {
        name: signature.symbol,
        signature,
        args: [...written, ...captured],
        returns: parseType(signature.returns),
        effects: [],
        builtin: false,
        bigint: returnsBigint(signature.returns),
        wide:
          held !== null && isWide(held)
            ? declaredWideBigint(
                declared.compiled,
                written,
                signature.params.slice(0, arity).map((param) => param.name),
              )
            : null,
        ...(declared.payload === undefined ? {} : { promise: { payload: declared.payload } }),
      };
    }
    // A function with default parameters is callable at a shorter arity
    // through the overload the module declares for it, which is the name with
    // the count the call is written with.
    const overloadName = `${value.function}__${value.args.length}`;
    const overload = this.contracts.get(overloadName);
    const contract = overload ?? this.contracts.get(value.function);
    if (contract === undefined) {
      const compiled = [...this.contracts.keys()];
      throw programError(
        `"${value.function}" is not a function of this program`,
        this.body,
        line,
        `the program compiles ${compiled.join(", ") || "no functions"}; a program calls the functions the program exports`,
      );
    }
    const signature = contract.signature;
    if (value.args.length !== signature.params.length) {
      const expected = signature.params.map((param) => `${param.name}: ${param.type}`).join(", ");
      throw programError(
        `${value.function} takes ${signature.params.length} argument(s), not ${value.args.length}`,
        this.body,
        line,
        `${this.body.file}: ${expected}`,
      );
    }
    const given = value.args.map((arg, position) => this.value(arg, parseType(signature.params[position].type), line));
    const held = primitive(parseType(signature.returns));
    return {
      name: signature.symbol,
      signature,
      args: given,
      returns: parseType(signature.returns),
      effects: contract.effects,
      builtin: false,
      bigint: returnsBigint(signature.returns),
      wide:
        held !== null && isWide(held)
          ? returnsWideBigint(
              contract.body,
              given,
              signature.params.map((param) => param.name),
            )
          : null,
      // A function of another file that is async answers a promise, and what
      // the promise carries is stated beside its contract.
      ...(contract.promise === undefined ? {} : { promise: { payload: parseType(contract.promise) } }),
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Uses                                                                    */
  /* ---------------------------------------------------------------------- */

  /**
   * What a value is written as, for the parameter it is passed as: a string, a
   * number, or a shape the compiler does not know. A parameter the source wrote
   * no type for is read at the shape its callers pass it at, and this is what
   * says so.
   *
   * The shape is read off the source rather than off the resolved value, so
   * that a name is read at the shape the scope holds it at and not at the shape
   * the parameter it is passed as happens to be read at: a name a caller was
   * given is a name whatever the parameter it is passed as is.
   */
  private kindOf(value: ProgramValue, line: number): "text" | "number" | "other" {
    switch (value.k) {
      case "number":
      case "whole":
        return "number";
      case "text":
      case "fixed":
        return "text";
      case "name": {
        // A named function is a function, and no parameter of a program is read
        // at one.
        if (this.functions.table.has(value.name)) return "other";
        const held = this.lookup(value.name) ?? this.topLevelText(value.name);
        if (held === undefined) return "other";
        if (held.kind === "text") return "text";
        if (held.kind === "number") return "number";
        return "other";
      }
      case "call": {
        const builtin = builtinFor(value.function);
        if (builtin !== null) {
          return isNumberType(builtin.returns) ? "number" : "other";
        }
        const declared = this.functions.table.get(value.function);
        if (declared === undefined || declared.signature === null) return "other";
        const returns = declared.signature.returns;
        if (returns === "text" || returns === "boxedtext") return "text";
        return isNumberType(parseType(returns)) ? "number" : "other";
      }
      case "binary": {
        // A string added to a string is a string, and every other operation is
        // a number. The `||` and `&&` operators answer one of their two sides,
        // so they answer what the left one is.
        if (value.op === "+") {
          const left = this.kindOf(value.left, line);
          const right = this.kindOf(value.right, line);
          return left === "text" && right === "text" ? "text" : "number";
        }
        if (value.op === "||" || value.op === "&&") return this.kindOf(value.left, line);
        return "number";
      }
      case "unary":
        // A sign in front of a value reads it as a number, whatever it was.
        return value.op === "+" || value.op === "-" ? "number" : "other";
      case "conditional":
        return this.kindOf(value.then, line);
      case "length":
      case "element":
        return "number";
      default:
        return "other";
    }
  }

  /** A number is used at one type; the program declares it that way. */
  private expectNumber(expect: TypeExpr, held: NumberHeld, line: number): void {
    const wanted = primitive(expect);
    if (wanted === null || !NUMERIC.includes(wanted)) {
      throw programError(
        `a number cannot be used as ${typeToString(expect)}`,
        this.body,
        line,
        `line ${line} of ${this.body.file}: a number goes to a numeric parameter, and an array parameter takes an array`,
      );
    }
    if (held.type !== null && held.type !== wanted) {
      throw programError(
        `the value ${held.text} is used as ${typeToString({ kind: "primitive", name: held.type })} and as ${typeToString(expect)}`,
        this.body,
        line,
        `line ${line} of ${this.body.file}: one value in a program has one type`,
      );
    }
    held.type = wanted;
  }

  /** An array is used at one element type, and at a length a parameter fixes. */
  private expectArray(expect: TypeExpr, held: ArrayHeld, line: number): void {
    // An array is a reference, so it may be passed where an unshaped reference
    // (`any`) is expected: the array is boxed into the dynamic value it names.
    if (expect.kind === "ref" && expect.of === null && expect.name === undefined) {
      return;
    }
    if (!isBufferType(expect)) {
      throw programError(
        `a typed array cannot be used as ${typeToString(expect)}`,
        this.body,
        line,
        `line ${line} of ${this.body.file}: a buffer parameter takes the array the program allocated`,
      );
    }
    const wanted = elementOf(expect);
    if (wanted !== null) {
      // An alias names the same array, so it is written down once. Every name
      // for it takes the element type, or the call would read the same bytes
      // as a type the array was never written at.
      const group = this.aliased(held);
      const fixed = group.find((member) => member.element !== null && member.element !== wanted);
      if (fixed !== undefined) {
        throw programError(
          `an array of ${fixed.element} is used where ${wanted} is expected`,
          this.body,
          line,
          `line ${line} of ${this.body.file}: allocate the array with the element type the parameter takes`,
        );
      }
      for (const member of group) member.element = wanted;
    }
    if (expect.kind === "array" && expect.length !== null && expect.length !== held.length) {
      throw programError(
        `an array of ${held.length} element(s) is used where ${expect.length} is expected`,
        this.body,
        line,
        `line ${line} of ${this.body.file}: a parameter with a fixed length takes an array of exactly that length`,
      );
    }
  }

  /**
   * The arrays that are one array: the name itself, every name given for it
   * and every array those names are the same as.
   */
  private aliased(held: ArrayHeld): ArrayHeld[] {
    const group = new Set<ArrayHeld>([held]);
    for (let grown = true; grown; ) {
      grown = false;
      for (const [alias, source] of this.aliases) {
        if (group.has(source) && !group.has(alias)) {
          group.add(alias);
          grown = true;
        }
        if (group.has(alias) && !group.has(source)) {
          group.add(source);
          grown = true;
        }
      }
    }
    return [...group];
  }

  /** A literal index the array does not have is refused where it is written. */
  private within(index: DraftValue, held: ArrayHeld, line: number): void {
    if (index.k !== "literal") return;
    // An array the program sized when it ran is as long as the count it settled
    // on, and that count is a value: there is no bound to refuse a read against.
    if (held.length === null) return;
    const at = integerLiteral(index.held.text);
    if (at === null) return;
    if (at < 0n || at >= BigInt(held.length)) {
      throw programError(
        `${held.name}[${index.held.text}] is outside the array`,
        this.body,
        line,
        `line ${line} of ${this.body.file}: ${held.name} holds ${held.length} element(s), 0 to ${held.length - 1}`,
      );
    }
  }

  private coerce(what: string, from: TypeExpr, to: TypeExpr, line: number): void {
    // A `ref<any>` (an unshaped reference) accepts any value.
    if (to.kind === "ref" && to.of === null) return;
    const source = primitive(from);
    const target = primitive(to);
    if (source === null || target === null || !NUMERIC.includes(source) || !NUMERIC.includes(target)) {
      throw programError(`${what} cannot be used as ${typeToString(to)}`, this.body, line);
    }
  }

  /** The type an annotation names, as a contract type. */
  private annotation(text: string, line: number): TypeExpr {
    if (text.trim() === "any" || text.trim() === "object" || text.trim() === "unknown") {
      return { kind: "ref", of: null };
    }
    try {
      return mapTypeScriptType(text, `line ${line} of ${this.body.file}`, this.body.wideBigint === true);
    } catch (error) {
      if (!(error instanceof CompilerError)) throw error;
      throw programError(error.message, this.body, line, error.detail ?? undefined);
    }
  }

  /** An array has no printed form, so it may not reach a console.log. */
  private assertPrintable(value: DraftValue, line: number): void {
    if (value.k === "text") {
      for (const part of value.parts) {
        if (part.k === "value") this.assertPrintable(part.value, line);
      }
      return;
    }
    if (value.k === "null") return;
    if (holdsText(value)) return;
    // A number and a truth are what a console.log prints, however they were
    // computed: a value of a primitive type is one of them, and a literal is a
    // number no use has fixed the type of yet.
    if (value.k === "literal" || draftType(value)?.kind === "primitive") return;
    // A field read is printed as whatever the field holds, and a reference is
    // one the driver prints as `null` or as the object behind it. The field's
    // own type is the layout's, so this is the same question the printed
    // value answers: a field of a reference type is not a buffer.
    if (value.k === "field") return;
    const held = value.k === "buffer" || (value.k === "reference" && value.held.kind === "array");
    if (held) {
      throw programError(
        "a program cannot print a buffer",
        this.body,
        line,
        `line ${line} of ${this.body.file}: print a number, or a string that interpolates one`,
      );
    }
    if (value.k === "reference" && value.held.kind === "object" &&
        (((value.held.type as { name?: string }).name !== undefined) || ((value.held.type as { of?: TypeExpr | null }).of !== null))) {
      throw programError(
        "a program cannot print an object",
        this.body,
        line,
        `line ${line} of ${this.body.file}: print a number, or a string that interpolates one`,
      );
    }
    // A dynamic value (`any`) may be a string at run time, so printing one is
    // allowed; the runtime prints it as text.
    const type = draftType(value);
    if (type !== null && type.kind === "ref" && (type as { of: TypeExpr | null }).of === null && (type as { name?: string }).name === undefined) {
      return;
    }
    throw programError(
      "a program prints a number or a string",
      this.body,
      line,
      `line ${line} of ${this.body.file}: a buffer has no printed form`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Writing the IR down                                                        */
/* -------------------------------------------------------------------------- */

/** The blocks a loop leaves, which a break and a continue are written as. */
interface LoopTarget {
  header: string;
  exit: string;
  /**
   * True when a `break` inside the loop leaves it. A loop whose condition is
   * always true does not end by its condition, and the code after it runs only
   * if the body leaves it.
   */
  left?: boolean;
}

/** One block being written, what it owns, and the loop whose body it is. */
interface BlockFrame {
  block: SemanticBlock;
  /** The loop this block is written in, which a break and a continue leave. */
  loop: LoopTarget | null;
  /** True for the body of the loop above, which a break leaves as well. */
  body: boolean;
}

/**
 * True when writing a value twice would run it twice.
 *
 * The rule is the one the validator holds a value to (see `hasCall` in
 * `core/semantic-ir.ts`), and the two have to agree: the resolver hoists what
 * the validator will not accept written twice, and a value the resolver says
 * nothing runs in and the validator says runs in is written twice.
 */
function draftHasCall(value: DraftValue): boolean {
  switch (value.k) {
    case "call":
    case "fixed":
    case "fill":
    case "sized":
    case "view":
    // A buffer is laid out at run time, a length is asked of the runtime and
    // an object is built at run time: all three are calls.
    case "buffer":
    case "length":
    case "stringLength":
    case "object":
      return true;
    case "literal":
    case "boolean":
    case "function":
    case "null":
    case "reference":
      return false;
    case "element":
      return draftHasCall(value.index);
    case "text":
      // A string written out in the source is laid down in the object beside
      // the code; one with anything computed in it is built at run time.
      return value.parts.some((part) => part.k === "value");
    case "compare":
      // A comparison of two texts is the runtime's own.
      if (value.how === "string") return true;
      return draftHasCall(value.left) || draftHasCall(value.right);
    case "isNull":
      return draftHasCall(value.operand);
    case "unary":
      return draftHasCall(value.operand);
    case "binary": {
      // A power is `pow`, and two texts put together are a string built at run
      // time: the runtime measures the two, allocates the answer and copies
      // the parts into it.
      if (value.op === "**") return true;
      if (value.op === "+" && value.type !== null && value.type.kind === "text") return true;
      // A product and a quotient of a whole number wider than a machine word
      // are the runtime kernel, for the same reason a power is.
      if (
        (value.op === "*" || value.op === "/" || value.op === "%") &&
        value.type !== null &&
        value.type.kind === "primitive" &&
        (value.type.name === "u256" || value.type.name === "i256")
      ) {
        return true;
      }
      return draftHasCall(value.left) || draftHasCall(value.right);
    }
    case "conditional":
      return draftHasCall(value.condition) || draftHasCall(value.then) || draftHasCall(value.otherwise);
    case "field":
      return draftHasCall(value.object);
  }
}

/** Who owns what a call of a type hands back. */
function ownership(returns: SemanticType): "none" | "borrowed" | "owned" {
  if (returns.kind === "ref") return "owned";
  if (returns.kind === "ptr") return "borrowed";
  return "none";
}

/**
 * Writing a resolved program down as the semantic IR: one block per place
 * control can be, one name for every value a target used to write out twice,
 * and every allocation named by the block that made it.
 */
class ProgramLowering {
  private readonly frames: BlockFrame[] = [];
  /** The names the program holds, so a generated one is not one of them. */
  private readonly used: Set<string>;
  /** Mutable text locals that are captured by a nested program function, and so
   *  are stored in a shared cell rather than by value. Built once on the outer
   *  lowering and shared with every function body lowering it hands work to,
   *  so a declaration inside a function is boxed the same way the captures of
   *  it are. */
  private readonly boxedTexts: Set<string>;
  /** What a value hoisted, to be written before the statement it is used in. */
  private pending: SemanticStatement[] = [];
  private counters: Record<"t" | "a" | "i", number> = { t: 0, a: 0, i: 0 };
  private blockCount = 0;

  /**
   * The language the program was written in, whose rules are asked of the
   * language: a remainder takes the sign of its left side in one and of its
   * divisor in the other.
   */
  private readonly language: string;
  /**
   * The rules of that language, asked of the language rather than of the code
   * that reads them.
   */
  private readonly rules: LanguageRules;
  /** The layout of every object the program lays out, by the name it has. */
  private readonly layouts: Record<string, ObjectLayout>;

  constructor(
    used: Set<string>,
    boxedTexts?: Set<string>,
    language: string = "typescript",
    layouts: Record<string, ObjectLayout> = {},
  ) {
    this.used = used;
    this.boxedTexts = boxedTexts ?? new Set();
    this.language = language;
    this.layouts = layouts;
    this.rules = rulesFor(language);
  }

  lower(program: DraftProgram): SemanticProgram {
    // Mutable text locals captured by a nested program function are boxed: they
    // are stored in a shared cell rather than by value. The cell is named by
    // the binding the capture was taken from, and the parameter the capture
    // arrives under is named by the source, which are two names when the
    // declaration was renamed to keep the two apart — so both are boxed.
    for (const draft of program.declared) {
      if (draft.signature === null || draft.compiled === null) continue;
      for (const capture of draft.captured) {
        // A string the function writes through is shared through a cell, and
        // the cell is named by the binding the capture was taken from and by
        // the name the capture arrives under, which are two names when the
        // declaration was renamed to keep the two apart — so both are boxed.
        if (capture.boxed) {
          this.boxedTexts.add(capture.held.name);
          this.boxedTexts.add(capture.name);
        }
      }
    }
    // A function the program declares is a function of its own, lowered by a
    // lowering of its own: the names it holds are its own, and a name it
    // generates is not one the program around it generated.
    const settled = program.declared.filter(
      (draft): draft is SettledFunction => draft.signature !== null && draft.compiled !== null,
    );
    const bodies = settled.map((draft) => this.function(draft));
    const trampolines = settled
      .filter((draft) => draft.name.startsWith("__arrow_"))
      .flatMap((draft) => {
        const suffix = draft.name.slice("__arrow_".length);
        const trampolineName = `__arrow_trampoline_${suffix}`;
        // A handler the runtime calls is given the request and the response and
        // nothing else, so the names it captured are read from where the
        // program left them rather than from the call.
        if (draft.serverHandler) {
          const holders = captureHolders(draft);
          const written = draft.signature.params.slice(0, draft.params.length);
          const captured = draft.signature.params.slice(draft.params.length);
          const args = [
            ...written.map((param, index) => callbackValue(param.type, `p${index}`)),
            ...captured.flatMap((param, index) =>
              captureArguments(param.type, draft.captured[index]?.type ?? param.type, holders[index] ?? "((blaze_capture_t){ 0 })"),
            ),
          ].join(", ");
          const call = args.length > 0 ? `${draft.name}(${args});` : `${draft.name}();`;
          return serverHandlerTrampoline(trampolineName, draft, holders, call);
        }
        // A captured text local arrives as the pointer to the shared cell that
        // holds it, so it is passed on as the pointer it is; every other
        // parameter is narrowed into the double the trampoline is called with.
        // What calls the trampoline is given one value — the value of the
        // event — so the names the arrow captured are read out of the bundle
        // it is handed beside it, one for each of them.
        const args = draft.signature.params
          .flatMap((param, index) =>
            index < draft.params.length
              ? [callbackValue(param.type, index === 0 ? "p0" : "0")]
              : captureArguments(
                  param.type,
                  draft.captured[index - draft.params.length]?.type ?? param.type,
                  `((blaze_capture_t *)p1)[${index - draft.params.length}]`,
                ),
          )
          .join(", ");
        const call = args.length > 0 ? `${draft.name}(${args});` : `${draft.name}();`;
        const body = `static void ${trampolineName}(${callbackParameters()}) {\n  ${call}\n}`;
        return [{ name: trampolineName, body }];
      });
    // A named function the program hands to something as a callback is called
    // through a trampoline of its own: what calls it is not a program, and
    // passes it two values rather than the arguments the source wrote.
    const callbacks = settled
      .filter((draft) => draft.callback)
      .flatMap((draft) => {
        const trampolineName = `__callback_${draft.name}`;
        // A handler the runtime calls is given the request and the response
        // and nothing else, so the names it captured are read from where the
        // program left them rather than from the call.
        if (draft.serverHandler) {
          const holders = captureHolders(draft);
          const written = draft.signature.params.slice(0, draft.params.length);
          const captured = draft.signature.params.slice(draft.params.length);
          const args = [
            ...written.map((param, index) => callbackValue(param.type, `p${index}`)),
            ...captured.flatMap((param, index) =>
              captureArguments(param.type, draft.captured[index]?.type ?? param.type, holders[index] ?? "((blaze_capture_t){ 0 })"),
            ),
          ].join(", ");
          const call = args.length > 0 ? `${draft.name}(${args});` : `${draft.name}();`;
          return serverHandlerTrampoline(trampolineName, draft, holders, call);
        }
        const args = draft.signature.params
          .slice(0, draft.params.length)
          .map((param, index) => callbackValue(param.type, `p${index}`))
          .join(", ");
        const call = args.length > 0 ? `${draft.name}(${args});` : `${draft.name}();`;
        const body = `static void ${trampolineName}(${trampolineParameters(draft.params.length)}) {\n  ${call}\n}`;
        return [{ name: trampolineName, body }];
      });
    // A block starts open and is closed by what ends it: a program ends by
    // handing back nothing, and a function ends by handing back what it
    // returns or by falling off the end of its body.
    const entry: SemanticBlock = { id: "entry", statements: [], releases: [], terminator: { k: "next" } };
    this.enter(entry, null);
    this.statements(program.statements);
    this.leave();
    if (entry.terminator.k === "next") entry.terminator = { k: "return", value: null };
    return {
      file: program.file,
      language: this.language,
      entry,
      functions: [...program.functions, ...settled.map((draft) => draft.signature)],
      bodies,
      objects: program.objects,
      extraFunctions: [...trampolines, ...callbacks],
      httpHandlers: [...program.httpHandlers],
    };
  }

  /** One function the program declared, as the IR holds a function whole. */
  private function(draft: SettledFunction): SemanticFunction {
    const signature = draft.signature as FunctionSignature;
    // The parameters are the parameters of the signature the resolver settled,
    // read back as the types the body reads them at: a buffer is a pointer to
    // its first element, and a number is the number it is.
    const params = signature.params.map((param) => {
      if (param.type === "text" || param.type === "boxedtext") {
        return {
          kind: "text" as const,
          name: param.name,
          mutable: true,
          // A string the function writes through is shared through a cell, and
          // a string it is given is the string itself.
          boxed: param.type === "boxedtext" || this.boxedTexts.has(param.name),
        };
      }
      return {
        kind: "value" as const,
        name: param.name,
        mutable: false,
        type: parseType(param.type) as SemanticType,
      };
    });
    // The body is lowered on its own: its own entry block, its own names, and
    // a value of its own for each parameter it is given.
    const inner = new ProgramLowering(new Set(this.used), this.boxedTexts, this.language, this.layouts);
    const entry = inner.body(draft.compiled as DraftProgram);
    // An async function answers a promise carrying what its body returns, so
    // every way out of the body settles that promise before the call returns.
    // The body itself is unchanged: it runs straight through, which is what a
    // compiled program does, and the promise is settled with the value the
    // return made.
    if (draft.async === true) inner.settleReturns(entry);
    const allocates = entry.releases.length > 0;
    return {
      name: signature.name,
      symbol: signature.symbol,
      params,
      returns: parseType(signature.returns),
      requires: [],
      ensures: [],
      // What a function of a program does beyond computing its result is what
      // its body does: it allocates what it allocates, prints what it prints,
      // and reads the command line only where the source reads it.
      effects: allocates ? ["memory"] : [],
      allocates,
      prints: printsOf(entry),
      readsArgv: readsArgvOf(entry),
      objects: {},
      calls: callsOf(entry),
      entry,
    };
  }

  /**
   * The block one body runs in. A function's parameters are the parameters of
   * the function itself, so the body reads them as it reads any other name and
   * nothing in the block declares them again.
   */
  private body(program: DraftProgram): SemanticBlock {
    const entry: SemanticBlock = { id: "entry", statements: [], releases: [], terminator: { k: "next" } };
    this.enter(entry, null);
    this.statements(program.statements);
    this.leave();
    // A body that falls off the end hands back what the function returns, which
    // is nothing at all unless the source returns something.
    if (entry.terminator.k === "next") entry.terminator = { k: "return", value: null };
    return entry;
  }

  /**
   * Every way out of an async function settles the promise the function
   * answers. A body that returns a value settles it with that value, and one
   * that falls off the end settles it with nothing — which is what the
   * language's own function does when it runs out of statements.
   */
  private settleReturns(block: SemanticBlock): void {
    if (block.terminator.k === "return") {
      block.terminator = { k: "return", value: this.settled(block.terminator.value) };
    }
    for (const statement of block.statements) {
      for (const nested of statementBlocksOf(statement)) this.settleReturns(nested);
    }
  }

  /** The promise a settled return answers, carrying the value it returned. */
  private settled(value: SemanticValue | null): SemanticValue {
    const payload: SemanticType = value === null ? VOID : value.type;
    const callee = value === null
      ? "Promise.settle.nothing"
      : payload.kind === "text"
        ? "Promise.settle.text"
        : isBoolean(payload)
          ? "Promise.settle.bool"
          : payload.kind === "ref"
            ? "Promise.settle.value"
            : "Promise.settle";
    const builtin = builtinFor(callee) as BuiltinSignature;
    return {
      k: "call",
      type: REF_NULL,
      call: {
        callee,
        signature: {
          name: callee,
          symbol: callee,
          params: builtin.params.map((type, index) => ({ name: `argument${index}`, type: contractText(type) })),
          returns: contractText(builtin.returns),
        },
        args: value === null ? [] : [value],
        argTypes: value === null ? [] : [payload],
        returns: builtin.returns,
        effects: ["memory"],
        ownership: "none",
        retain: false,
        builtin: true,
      },
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Blocks                                                                  */
  /* ---------------------------------------------------------------------- */

  private enter(block: SemanticBlock, loop: LoopTarget | null, body = false): void {
    // Whatever a value of the block about to be written hoisted belongs to
    // the block being written now, not to the one being entered.
    if (this.frames.length > 0) this.flush();
    this.frames.push({ block, loop, body });
  }

  private leave(): void {
    this.flush();
    this.frames.pop();
  }

  /** The statements a value hoisted, written where the program wrote them. */
  private flush(): void {
    const block = this.frame().block;
    for (const before of this.pending) block.statements.push(before);
    this.pending = [];
  }

  private frame(): BlockFrame {
    return this.frames[this.frames.length - 1];
  }

  /** A block id nothing else names. */
  private blockId(): string {
    this.blockCount += 1;
    return `b${this.blockCount}`;
  }

  /** A block of its own, which a name declared in it is not a name outside it. */
  private arm(body: readonly DraftStatement[], loop: LoopTarget | null, ofLoop = false): SemanticBlock {
    const block: SemanticBlock = { id: this.blockId(), statements: [], releases: [], terminator: { k: "next" } };
    this.enter(block, loop, ofLoop);
    this.statements(body);
    this.leave();
    return block;
  }

  /**
   * One statement, after whatever a value of it hoisted. An array literal and
   * a value written out twice are written before the statement that uses them,
   * in the block the program wrote them in.
   */
  private statement(statement: SemanticStatement): void {
    this.flush();
    this.frame().block.statements.push(statement);
  }

  /**
   * A name the compiler gives a value, from the counter of its kind. A name a
   * program declared is never rewritten, so a generated name that would be one
   * of them is the next one along.
   */
  private generated(kind: "t" | "a" | "i"): string {
    let name: string;
    do {
      this.counters[kind] += 1;
      name = `${kind}${this.counters[kind]}`;
    } while (this.used.has(name));
    this.used.add(name);
    return name;
  }

  /** A slot that holds a value of this type, so a name of it can be declared. */
  private slot(name: string, type: SemanticType, mutable: boolean): SemanticSlot {
    if (isTextType(type)) return { kind: "text", name, mutable, boxed: this.boxedTexts.has(name) };
    if (type.kind === "ref" || type.kind === "ptr") return { kind: "object", name, mutable, type };
    return { kind: "value", name, mutable, type };
  }

  /** The slot a declaration makes, and the type the name is read as. */
  private declared(held: Held): SemanticSlot {
    if (held.kind === "text") return { kind: "text", name: held.name, mutable: held.mutable, boxed: held.boxed === true || this.boxedTexts.has(held.name) };
    if (held.kind === "array") {
      return {
        kind: "buffer",
        name: held.name,
        mutable: held.mutable,
        element: numeric(held.element ?? "f64"),
        length: held.length,
      };
    }
    if (held.kind === "object") return { kind: "object", name: held.name, mutable: held.mutable, type: held.type };
    if (held.kind === "argv") return { kind: "value", name: held.name, mutable: held.mutable, type: numeric("f64") };
    return { kind: "value", name: held.name, mutable: held.mutable, type: numeric(held.type ?? "f64") };
  }

  /* ---------------------------------------------------------------------- */
  /* Statements                                                              */
  /* ---------------------------------------------------------------------- */

  private statements(list: readonly DraftStatement[]): void {
    for (const statement of list) {
      // A `break` or a `continue` leaves the block, so what the source wrote
      // after it is dead and is written nowhere. A block the program reaches
      // again is a block the loop writes, so a later statement of the same
      // block is the one the program runs next time round.
      // A `break` or a `continue` leaves the block, and a `return` ends the
      // function, so what the source wrote after either is dead and is written
      // nowhere. A block that ends where nothing arrives ends there too: an
      // `if` whose every arm leaves and a loop that never ends are both
      // statements nothing after them can be reached from, and what the source
      // wrote after them is dead as well.
      const end = this.frame().block.terminator.k;
      if (end === "jump" || end === "return" || end === "unreachable") break;
      this.draft(statement);
    }
  }

  private draft(statement: DraftStatement): void {
    switch (statement.kind) {
      case "declare": {
        // An array the program wrote is the name it is declared as, not a name
        // of its own: the declaration is the allocation, whether the values
        // were written out, the count was settled on when the program ran, or
        // the array is a window of a block. A fill is the one array form the
        // declaration is not: the fill is a loop, and a loop is a statement of
        // its own, so the array is written under a name first and the name
        // declared here is that array again.
        const slot = this.declared(statement.held);
        const written: DraftValue | null =
          statement.held.kind === "array" && ARRAY_FORMS.has(statement.value.k) ? statement.value : null;
        const allocated =
          written !== null && (written.k === "buffer" || written.k === "sized" || written.k === "view");
        const value = allocated ? this.buffer(written, statement.line) : this.value(statement.value, null, statement.line);
        // A name that is nothing is declared as the reference it is, so the
        // name reads as what it holds. An array another name already holds is
        // named again rather than allocated again, so the block owns it once.
        const held = value.k === "nothing" && slot.kind === "object" ? { ...value, type: slot.type } : value;
        // A view holds no block of its own: the block it looks into belongs to
        // the name the program gave it, and what that block frees is freed
        // after every view of it, because a block frees in the reverse of the
        // order the program took it. Freeing a view would free bytes in the
        // middle of a block, which is not a block at all.
        if (allocated && written !== null && written.k !== "view") this.own(slot.name);
        if (value.k === "newObject") this.own(slot.name);
        this.statement({ k: "let", slot, value: held, line: statement.line });
        return;
      }
      case "fieldAssign": {
        // The object is the name the program bound, read as the reference it
        // is: a store is written through a reference, and the validator holds a
        // store of anything else to be a name the program did not bind.
        const object: SemanticValue = { k: "local", type: statement.type, name: statement.object };
        this.statement({
          k: "storeField",
          object,
          layout: statement.layout,
          field: statement.field,
          value: this.value(statement.value, null, statement.line),
          line: statement.line,
        });
        return;
      }
      case "assign": {
        const value = this.value(statement.value, statement.type, statement.line);
        // A wide number has no compound operator a backend can write, and a
        // floor division has no compound form C has, so the compound is
        // written as the binary form every backend either writes or refuses
        // by name.
        const wide = compoundAsBinary(statement.op, statement.type ?? numeric("f64"), { k: "local", type: statement.type ?? numeric("f64"), name: statement.name }, value);
        this.statement({
          k: "set",
          name: statement.name,
          op: wide === null ? statement.op : wide.op,
          value: wide === null ? value : wide.value,
          line: statement.line,
        });
        return;
      }
      case "elementAssign": {
        const index = this.value(statement.index, USIZE, statement.line);
        const value = this.value(statement.value, statement.type, statement.line);
        // The same rule over one element rather than a slot.
        const element = statement.type ?? numeric("f64");
        const wide = compoundAsBinary(statement.op, element, { k: "element", type: element, of: { k: "local", type: element, name: statement.buffer }, index }, value);
        this.statement({
          k: "setElement",
          buffer: statement.buffer,
          index,
          op: wide === null ? statement.op : wide.op,
          value: wide === null ? value : wide.value,
          line: statement.line,
        });
        return;
      }
      case "update":
        this.statement({ k: "step", name: statement.name, op: statement.op, prefix: statement.prefix, line: statement.line });
        return;
      case "fill": {
        // The same statement `a.fill(x)` writes when it is bound to a name: the
        // array is written from an index the compiler names, so two fills in one
        // block do not count with the same one.
        const array = this.value(statement.buffer, null, statement.line);
        if (array.k !== "local") {
          throw new CompilerError({
            category: "ContractError",
            stage: "program",
            message: "a fill is written of an array the program did not name",
            detail: "fill an array a name holds",
          });
        }
        const element = numeric(statement.held.element ?? "f64");
        this.pending.push({
          k: "fill",
          buffer: array.name,
          index: this.generated("i"),
          value: this.value(statement.value, element, statement.line),
          type: element,
          line: statement.line,
        });
        return;
      }
      case "print":
        this.print(statement);
        return;
      case "invoke":
        this.statement({ k: "call", call: this.call(statement.call, statement.line), line: statement.line });
        return;
      case "if": {
        const condition = this.truth(this.value(statement.condition, null, statement.line));
        const then = this.arm(statement.then, this.frame().loop);
        const otherwise = statement.otherwise.length === 0 ? null : this.arm(statement.otherwise, this.frame().loop);
        this.statement({ k: "if", condition, then, otherwise, line: statement.line });
        // An `if` with an arm on each side, each of which leaves, is a statement
        // nothing after it can be reached from. The block says so, rather than
        // falling out of itself into a return of nothing: a function declared to
        // return a number does not end by handing back whatever the register
        // held, and a function that returns from every path returns.
        if (otherwise !== null && this.frame().block.terminator.k === "next" && leaves(then) && leaves(otherwise)) {
          this.frame().block.terminator = { k: "unreachable" };
        }
        return;
      }
      case "while": {
        const condition = this.truth(this.value(statement.condition, null, statement.line));
        const { target, ...info } = this.loop(statement.body);
        const loop = { kind: "while" as const, condition, ...info };
        const cond = statement.condition as { k?: string; value?: boolean; text?: string };
        const isConstantTrue =
          (cond.k === "boolean" && cond.value === true) ||
          (cond.k === "literal" && (cond.text === "true" || cond.text === "1"));
        // A loop whose condition is always true does not end by its condition,
        // and the code after it runs only where the body leaves it. A body that
        // leaves the loop may or may not do so, and a body that does not leaves
        // it never.
        const neverExits = isConstantTrue && target.left !== true;
        if (neverExits) (loop as { neverExits?: boolean }).neverExits = true;
        this.statement({
          k: "loop",
          loop,
          line: statement.line,
        });
        if (neverExits) {
          if (this.frame().block.terminator.k === "next") {
            this.frame().block.terminator = { k: "unreachable" };
          }
        }
        return;
      }
      case "doWhile": {
        const condition = this.truth(this.value(statement.condition, null, statement.line));
        this.statement({
          k: "loop",
          loop: { kind: "doWhile", condition, ...this.loopInfo(statement.body) },
          line: statement.line,
        });
        return;
      }
      case "for": {
        const type = statement.type;
        const from = this.value(statement.from, type, statement.line);
        // The bound is where the loop stops, and the comparison that stops it
        // is between the counter and the bound. A counter that counts in whole
        // numbers and a bound that is a fraction are compared as the numbers
        // they are: `for (let i = 0; i < 5.5; i++)` counts six turns. A bound
        // read at the counter's width would stop the loop at five, so a bound
        // that is not a whole number is rounded to the whole number the
        // comparison against it answers the same — the ceiling of it for a
        // counter that counts up to a bound it does not reach, and the floor of
        // it for one that counts down. A counter that counts in fractions is
        // compared against the bound as it is, and the bound is left alone.
        const wholeCounter = primitive(type) !== null && isWhole(primitive(type) as PrimitiveTypeName);
        const to = wholeCounter && !countsWhole(statement.to)
          ? roundedBound(this.value(statement.to, null, statement.line), statement.down === statement.inclusive)
          : this.value(statement.to, type, statement.line);
        const step = statement.step === null ? null : this.value(statement.step, type, statement.line);
        this.statement({
          k: "loop",
          loop: {
            kind: "counted",
            variable: statement.variable,
            type,
            from,
            to,
            inclusive: statement.inclusive,
            down: statement.down,
            step,
            ...this.loopInfo(statement.body),
          },
          line: statement.line,
        });
        return;
      }
      case "forOf": {
        const length = this.value(statement.length, USIZE, statement.line);
        const index = this.generated("i");
        this.statement({
          k: "loop",
          loop: {
            kind: "each",
            index,
            element: statement.variable,
            elementType: statement.type,
            of: statement.of,
            length,
            ...this.loopInfo(statement.body),
          },
          line: statement.line,
        });
        return;
      }
      case "break":
      case "continue":
        this.jump(statement.kind === "break");
        return;
      case "block":
        this.statement({ k: "block", body: this.arm(statement.body, this.frame().loop), line: statement.line });
        return;
      case "result": {
        // What a function hands back ends the block it was written in, and
        // whatever that value hoisted is written before the block ends. A bare
        // return hands back nothing.
        this.flush();
        this.frame().block.terminator = {
          k: "return",
          value: statement.value === null ? null : this.value(statement.value, null, statement.line),
        };
        return;
      }
    }
  }

  /**
   * The blocks a loop leaves, and the block that holds it: the test is named
   * before the body is written, and control resumes in the block the loop was
   * written in, which is the one the loop statement is in.
   */
  private loop(
    body: readonly DraftStatement[],
  ): { header: string; exit: string; body: SemanticBlock; target: LoopTarget } {
    const header = this.blockId();
    // Control resumes in the block the loop was written in, which is the one
    // the loop statement is in, and never in a block of its own.
    const target: LoopTarget = { header, exit: this.frame().block.id };
    return { header, exit: target.exit, body: this.arm(body, target, true), target };
  }

  /**
   * The loop a body runs in, without the target the loop itself holds: the
   * target says whether the loop is left, and only the loop itself asks.
   */
  private loopInfo(body: readonly DraftStatement[]): { header: string; exit: string; body: SemanticBlock } {
    const { target, ...info } = this.loop(body);
    return info;
  }

  /**
   * The end of the block a `break` or a `continue` is written in, after
   * freeing what the blocks it leaves own: innermost first, up to and
   * including the body of the loop it leaves. The blocks the loop itself sits
   * in are not left, and keep what they own.
   */
  private jump(leaving: boolean): void {
    const frame = this.frame();
    const target = frame.loop;
    if (target === null) return;
    // A loop that is left does not hold the code after it: the loop may end
    // by its `break` and the code after it runs.
    if (leaving) target.left = true;
    const names: string[] = [];
    for (let index = this.frames.length - 1; index >= 0; index -= 1) {
      const left = this.frames[index];
      names.push(...left.block.releases);
      // The body of the loop is left too, and it is the last block that is:
      // every block it holds carries the same loop, so the body itself is what
      // says where the walk stops. The blocks left are freed here rather than
      // when they end, which is why they keep what they own for the fall out
      // of the block the jump is written in.
      if (left.body) break;
    }
    frame.block.terminator = {
      k: "jump",
      target: leaving ? target.exit : target.header,
      releases: names,
    };
  }

  /**
   * A name the block being written owns, freed when the block ends. What a
   * block owns is freed in the reverse of the order the program took it, so the
   * list is the order the runtime is given rather than the order it happened in.
   */
  private own(name: string): void {
    this.frame().block.releases.unshift(name);
  }

  /** What a console.log writes, one value at a time and then the line. */
  private print(statement: DraftStatement & { kind: "print" }): void {
    statement.values.forEach((item, position) => {
      const value = this.value(item, null, statement.line);
      if (position > 0) {
        this.statement({ k: "printText", value: { k: "text", type: TEXT, parts: [{ k: "text", value: " " }] }, line: statement.line });
      }
      this.printed(value, isBigint(item), statement.line);
    });
    this.statement({ k: "printNewline", line: statement.line });
  }

  /** One printed value, the way the runtime writes what it holds. */
  private printed(value: SemanticValue, bigint: boolean, line: number): void {
    switch (valueKind(value)) {
      case "text":
        this.statement({ k: "printText", value, line });
        return;
      case "number":
        this.statement({ k: "printNumber", value, line, bigint });
        return;
      case "boolean":
      case "reference":
        this.statement({ k: "printText", value: { k: "toText", type: TEXT, of: value, digits: null }, line });
        return;
      case "null":
        this.statement({ k: "printText", value: { k: "text", type: TEXT, parts: [{ k: "text", value: "null" }] }, line });
        return;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Values                                                                  */
  /* ---------------------------------------------------------------------- */

  private value(value: DraftValue, as: TypeExpr | null, line: number): SemanticValue {
    switch (value.k) {
      case "literal": {
        // A number no use has fixed is a double, as it is in the language it
        // was written in; a use that fixed it is the one that names it.
        const name = value.held.type ?? primitive(as) ?? "f64";
        return { k: "const", type: numeric(name), text: value.held.text };
      }
      case "buffer":
      case "sized":
      case "view":
        return this.array(value, line);
      case "fill": {
        // The array is written under a name of its own, and the fill runs
        // where the source wrote it: a name reads the array, and every element
        // of it is written before the statement that uses the name.
        // The array the fill writes into is the one the name holds, or the one
        // the source allocated in the same breath: `a.fill(1)` fills what `a`
        // is, and `new Float64Array(n).fill(1)` fills what it just made. An
        // allocation written in the breath of the fill is written under a name
        // of its own first, so the fill has a name to walk.
        const array = this.value(value.buffer, null, line);
        if (array.k !== "local") {
          throw new CompilerError({
            category: "ContractError",
            stage: "program",
            message: "a fill is written of an array the program allocated",
            detail: "the resolver resolved the array to a name; the lowering writes it down under that name",
          });
        }
        const element = numeric(value.held.element ?? "f64");
        this.pending.push({
          k: "fill",
          buffer: array.name,
          index: this.generated("i"),
          value: this.value(value.value, element, line),
          type: element,
          line,
        });
        return array;
      }
      case "fixed":
        return { k: "toText", type: TEXT, of: this.value(value.of, null, line), digits: value.digits };
      case "reference":
        return { k: "local", type: this.localType(value.held), name: value.name };
      case "text":
        return { k: "text", type: TEXT, parts: value.parts.map((part) => part.k === "text" ? part : { k: "value", value: this.written(part.value, line) }) };
      case "boolean":
        return { k: "bool", type: BOOLEAN, value: value.value };
      case "null":
        return { k: "nothing", type: value.type ?? VOID };
      case "function":
        return {
          k: "functionRef",
          type: VOID,
          name: value.name,
          captures: value.captures,
          ...(value.symbol === undefined ? {} : { symbol: value.symbol }),
        };
      case "field": {
        // The base is written down first: it is a name of an object slot, or
        // the field of one the resolver has already read, and both answer as
        // the value a field is read of.
        const object = value.object;
        if (object.k !== "reference" && object.k !== "field" && object.k !== "call") {
          throw new CompilerError({
            category: "ContractError",
            stage: "program",
            message: "a field is read of something the resolver did not read an object of",
            detail: "the field read's object is neither a name nor another field read; the resolver refuses one that is",
          });
        }
        if (object.k === "reference" && object.held.kind !== "object") {
          throw new CompilerError({
            category: "ContractError",
            stage: "program",
            message: `"${object.name}" is not an object`,
            detail: "the field read's object is a name of a slot that is not an object; the resolver refuses one that is",
          });
        }
        const base =
          object.k === "reference"
            ? { k: "local" as const, type: (object.held as ObjectHeld).type, name: (object.held as ObjectHeld).name }
            : this.value(object, null, line);
        return {
          k: "loadField",
          type: value.type,
          object: base,
          layout: value.layout,
          field: value.field,
        };
      }
      case "object": {
        // The fields are written as the values the literal holds, not as the
        // text they print: an object field is whatever type the layout gives
        // it, and a number printed as text is not a number. A field the layout
        // holds at a wide width takes a whole constant written at a narrower
        // one widened to the width it is stored at.
        const fields = value.fields.map((field) => ({
          name: field.name,
          value: this.stored(value.layout, field.name, this.value(field.value, null, line)),
        }));
        return { k: "newObject", type: value.type, layout: value.layout, fields };
      }
      case "length":
        return { k: "length", type: numeric(value.type), of: { k: "local", type: value.bufferType, name: value.buffer } };
      case "stringLength":
        return { k: "length", type: numeric("usize"), of: this.value(value.of, null, line) };
      case "element":
        return {
          k: "element",
          type: numeric(value.type),
          of: { k: "local", type: value.bufferType, name: value.buffer },
          index: this.value(value.index, USIZE, line),
        };
      case "call":
        if (value.call.awaiting === true) {
          // A value that is not a promise is awaited as itself: the operand is
          // the value, and the call is only how the word was written down.
          const operand = value.call.args[0] as DraftValue;
          if (promiseOf(operand) === undefined) return this.value(operand, as, line);
        }
        return this.builtin(value.call, line);
      case "compare": {
        // Two strings are compared as the strings they are, at no number at
        // all, which is the only comparison with no operand behind it.
        if (value.how === "string") {
          return {
            k: "compare",
            type: BOOLEAN,
            op: value.negate ? "ne" : "eq",
            operand: TEXT,
            left: this.value(value.left, null, line),
            right: this.value(value.right, null, line),
          };
        }
        const operand = this.compared(value.left, value.right);
        return {
          k: "compare",
          type: BOOLEAN,
          op: value.negate ? "ne" : "eq",
          operand,
          left: this.value(value.left, operand, line),
          right: this.value(value.right, operand, line),
        };
      }
      case "isNull":
        return { k: "isNull", type: BOOLEAN, operand: this.value(value.operand, null, line), negate: value.negate };
      case "unary":
        return {
          k: "unary",
          type: value.type ?? numeric("f64"),
          op: UNARY[value.op],
          operand: this.value(value.operand, value.type, line),
        };
      case "binary":
        return this.binary(value, line);
      case "conditional":
        return {
          k: "select",
          type: value.type ?? TEXT,
          condition: this.truth(this.value(value.condition, null, line)),
          then: this.value(value.then, value.type, line),
          otherwise: this.value(value.otherwise, value.type, line),
        };
    }
  }

  /**
   * The type two values are compared at, which is the double they are. A
   * number in a program is a double whichever array it was read out of, and
   * compared as one of the two it answers a different question: a
   * `Uint32Array` holding 4000000000 is above every signed 32 bit number, and
   * read as a signed one it is negative, so `a[0] > b[0]` is false where the
   * source says true.
   *
   * A bigint is the one value a program holds that is not a double, and it is
   * compared as the whole number it is: `9007199254740993n === 9007199254740995n`
   * is false, and read as two doubles the two are the same number and it is
   * true. The two sides of a comparison that mixes one with a number are
   * refused by the resolver, because the language compares them exactly and an
   * `i64` beside a fraction is not that comparison.
   */
  private readonly operand: TypeExpr = numeric("f64");

  /**
   * The type two values of a program are compared at, which is the double they
   * are — with the one exception a wide number is.
   *
   * A wide number is not a machine word, so there is no double it is read as:
   * the kernel compares two of them limb by limb, and a pair that includes one
   * is compared at the wide number itself or not at all. This is the rule
   * `semantics/ir-function.ts` reads through `commonNumber` for a body inside a
   * function, and it is read here through the same one, so the same comparison
   * is the same IR whether it is written in a function or in a program body.
   */
  private compared(left: DraftValue, right: DraftValue): TypeExpr {
    const here = primitive(draftType(left));
    const there = primitive(draftType(right));
    // A comparison states the width both sides are read at, and a literal with
    // no type of its own is read at the width beside it: `0 < curve.n` over a
    // `u256` is a comparison of two wide numbers, not of a double and a wide
    // number.
    if (here !== null && isWide(here)) return numeric(here);
    if (there !== null && isWide(there)) return numeric(there);
    const pair = commonNumber(here === null ? null : numeric(here), there === null ? null : numeric(there));
    if (pair !== null && pair.kind === "primitive" && isWide(pair.name)) return numeric(pair.name);
    return isBigint(left) && isBigint(right) ? numeric(BIGINT_TYPE) : this.operand;
  }

  /** A value as text, which is how a string carries a number. */
  private written(value: DraftValue, line: number): SemanticValue {
    const mapped = this.value(value, null, line);
    if (isTextType(mapped.type)) return mapped;
    return { k: "toText", type: TEXT, of: mapped, digits: null };
  }

  /**
   * An array literal is written out as a name of its own, where the program
   * wrote it, and the block it was written in owns it: a name reads that
   * array, and it is freed when the block ends.
   */
  private array(value: DraftValue & { k: "buffer" | "sized" | "view" }, line: number): SemanticValue {
    const held = value.held;
    const name = this.generated("a");
    const slot: SemanticSlot = {
      kind: "buffer",
      name,
      mutable: false,
      element: numeric(held.element ?? "f64"),
      length: held.length,
    };
    this.pending.push({ k: "let", slot, value: this.buffer(value, line), line });
    // A view holds no block of its own: the block it looks into was declared
    // before it, and what that block frees is freed after every view of it,
    // because a block frees in the reverse of the order the program took it.
    if (value.k !== "view") this.own(name);
    return { k: "local", type: arrayType(held), name };
  }

  /** A typed array, in the form the program wrote it. */
  private buffer(value: DraftValue & { k: "buffer" | "sized" | "view" }, line: number): SemanticValue {
    const held = value.held;
    const element = numeric(held.element ?? "f64");
    if (value.k === "sized") {
      // The count the program settled on is the length of the array, and the
      // block is cleared: a read past what the program filled is the zero the
      // language answers it with.
      return {
        k: "buffer",
        type: arrayType(held),
        element,
        length: null,
        count: this.value(value.count, USIZE, line),
        view: null,
        values: [],
      };
    }
    if (value.k === "view") {
      return {
        k: "buffer",
        type: arrayType(held),
        element,
        length: null,
        count: this.value(value.count, USIZE, line),
        view: { of: this.held(this.value(value.of, null, line), line), offset: this.value(value.offset, USIZE, line) },
        values: [],
      };
    }
    return {
      k: "buffer",
      type: arrayType(held),
      element,
      length: held.length,
      count: null,
      view: null,
      values: held.values.map((item) => this.value(item, element, line)),
    };
  }

  /**
   * The value a view is taken of, which the emitter has to name to keep the
   * block alive: a view of a value that is not a name is written under one.
   */
  private held(value: SemanticValue, line: number): SemanticValue {
    if (value.k === "local") return value;
    const name = this.generated("a");
    this.pending.push({ k: "let", slot: this.slot(name, value.type, false), value, line });
    this.own(name);
    return { k: "local", type: value.type, name };
  }

  /**
   * A value written under a name before the statement that uses it: the left
   * arm of a short-circuit operator decides first, and the source form of it
   * writes that arm out twice, so a call in it is run once.
   */
  private temporary(value: SemanticValue, line: number): SemanticValue {
    const name = this.generated("t");
    this.pending.push({ k: "let", slot: this.slot(name, value.type, false), value, line });
    return { k: "local", type: value.type, name };
  }

  /** The left arm of `&&`, `||` and `??`, which is never written out twice. */
  private decide(value: DraftValue, line: number): SemanticValue {
    const mapped = this.value(value, null, line);
    if (!draftHasCall(value)) return mapped;
    return this.temporary(mapped, line);
  }

  private binary(value: DraftValue & { k: "binary" }, line: number): SemanticValue {
    const op = value.op;
    // The left arm decides first, and the source form of these operators
    // writes it out twice, so a call in it is written under a name first.
    if (op === "&&" || op === "||") {
      return {
        k: "logical",
        // The arms have the type they have in common, and a truth and a truth
        // is one; a string pair has no common type the resolver recorded, and
        // `&&` and `||` hand back one of the arms, so the arm's own type is the
        // type of the expression. `??` below reads the same null the same way.
        type: value.type ?? TEXT,
        op: op === "&&" ? "and" : "or",
        left: this.decide(value.left, line),
        right: this.value(value.right, value.type, line),
      };
    }
    if (op === "??") {
      return {
        k: "coalesce",
        type: value.type ?? TEXT,
        left: this.decide(value.left, line),
        right: this.value(value.right, value.type, line),
      };
    }
    // The two sides of a comparison are compared as the double they are, which
    // is what a number in a program is whichever array it was read out of — as
    // the whole number they are when both of them are bigints, and as the wide
    // number they are when one of them is one.
    const comparison = COMPARISONS[op];
    if (comparison !== null) {
      const operand = this.compared(value.left, value.right);
      return {
        k: "compare",
        type: BOOLEAN,
        op: comparison,
        operand,
        left: this.value(value.left, operand, line),
        right: this.value(value.right, operand, line),
      };
    }
    // Both sides are read at the one width the operation states, so a number
    // written as a fraction beside a whole number is read as the fraction it
    // is: `a + 1.5` over a `u256` is a mix the kernel has no answer for, and
    // reading 1.5 as four limbs answers `a + 1` instead. A side that cannot be
    // read at the width keeps its own type, and the validator names the pair.
    const left = this.value(value.left, sideType(value.left, value.type), line);
    // The count of a shift is the machine word the source wrote the shift by, and
    // not the number being shifted: the kernel every backend shifts a wide number
    // with takes one word of count, and a four-limb count is a count of 256 bits
    // that each target truncates to a different answer.
    const counted = op === "<<" || op === ">>" || op === ">>>";
    const right = this.value(value.right, counted ? numeric("usize") : sideType(value.right, value.type), line);
    // An array added to an array is the one operation that joins two
    // sequences: the elements of the right follow those of the left.
    if (op === "+" && isSequence(left.type) && isSequence(right.type)) {
      return { k: "arith", type: left.type, op: "arrayConcat", left, right };
    }
    // A string added to a string is the one operation with no number behind
    // it: the two arms were text, and it is text the IR states.
    if (value.type === null) return { k: "arith", type: TEXT, op: "concat", left, right };
    // The answer is the width the two sides are computed at: a wide number keeps
    // its width (a `u256` beside an `i64` is still a `u256`), and anything else
    // is a double. The draft states no width of its own when a program value is
    // written without an annotation. A whole operator keeps the width its two
    // whole sides are computed at: `i % 2` is `i64`, not the `f64` the two sides
    // were each read as when one of them was a count. `>>>` is a converting
    // operator: it reads both sides as unsigned 32 bit numbers and answers one
    // of those, so its type is the one the draft already fixed. A bigint
    // operation is computed at sixty-four bits, which the draft already states.
    const leftPrim = left.type.kind === "primitive" ? left.type.name : null;
    const rightPrim = right.type.kind === "primitive" ? right.type.name : null;
    // A wide number keeps the width its two whole sides are computed at, and a
    // bigint operation is computed at sixty-four bits. Both are already stated
    // by the draft, so only fall back to the arithmetic rule when neither.
    // The rules of the language the program was written in are asked of the
    // language: a division of two whole numbers is a whole division in one
    // language and a true division in another, and a remainder takes the sign
    // of its left side in one and of its divisor in the other.
    const rules = this.rules;
    const trueDivision = op === "/" && rules.division === "true";
    const type = trueDivision
      ? numeric("f64")
      : value.bigint && !isWideType(left.type) && !isWideType(right.type)
        ? numeric(BIGINT_TYPE)
        : CONVERTING_OPERATORS.includes(op)
          ? value.type
          : WHOLE_OPERATORS.includes(op)
            ? numeric(wholeResult(leftPrim, rightPrim))
            : numeric(numericResult(leftPrim, rightPrim, op === "/"));
    const arithmetic = op === "%" && rules.remainder === "floored" ? "floorMod" : (ARITHMETIC[op] as ArithOp);
    const folded = this.foldedValue(arithmetic, left, right, type);
    if (folded !== null) return folded;
    // A wide remainder is the kernels' answer, not the machine's: the product
    // of two 256 bit numbers does not fit in one, and a `%` of the low half is
    // a different number from the remainder of the whole.
    if (arithmetic === "mod" && type.kind === "primitive" && type.name === "u256") {
      const reduced = modularReduction(left, right, (name, args) => this.wideKernel(name, args));
      if (reduced !== null) return reduced;
    }
    return { k: "arith", type, op: arithmetic, left, right };
  }

  /**
   * A whole number written into a field, at the width the layout holds it at.
   *
   * The layout says a field is a `u256` because the field is what the source
   * writes a bigint into, and a constant written at a narrower width is the
   * same number widened into the field. A computed value is left as it is: the
   * conversion of one is a value the lowering would have to write down, and
   * the layout pass and the resolver agree on the width of every expression
   * that computes one.
   */
  private stored(layout: string, field: string, value: SemanticValue): SemanticValue {
    const declared = this.layouts[layout]?.fields.find((entry) => entry.name === field)?.type;
    if (declared === undefined) return value;
    const type = parseType(declared);
    if (type.kind !== "primitive" || !isWhole(type.name)) return value;
    if (value.k !== "const" || value.type.kind !== "primitive" || !isWhole(value.type.name)) return value;
    const number = wholeText(value.text);
    if (number === null) return value;
    return wholeConstant(number, type) ?? value;
  }

  /**
   * A whole-number operation on two constants, answered here rather than by
   * the target.
   *
   * The answer is the one the type holds, so a fold and the code the same
   * operation would have been lowered to agree. A text that is not a whole
   * number, or an operation whose answer the type cannot state (a division by
   * zero), is left to the ordinary path.
   */
  private foldedValue(op: ArithOp, left: SemanticValue, right: SemanticValue, type: SemanticType): SemanticValue | null {
    if (left.k !== "const" || right.k !== "const") return null;
    if (type.kind !== "primitive" || !isWhole(type.name)) return null;
    if (left.type.kind !== "primitive" || !isWhole(left.type.name)) return null;
    if (right.type.kind !== "primitive" || !isWhole(right.type.name)) return null;
    const first = wholeText(left.text);
    const second = wholeText(right.text);
    if (first === null || second === null) return null;
    const value = foldWhole(op, first, second, type.name);
    if (value === null) return null;
    return wholeConstant(value, type);
  }

  /** A call of one of the wide modular kernels, as the builtin it is. */
  private wideKernel(name: string, args: readonly SemanticValue[]): SemanticValue | null {
    const builtin = builtinFor(name);
    if (builtin === null) return null;
    const signature: FunctionSignature = {
      name,
      symbol: name,
      params: builtin.params.map((type, at) => ({ name: `argument${at}`, type: contractText(type) })),
      returns: contractText(builtin.returns),
    };
    return {
      k: "call",
      type: builtin.returns,
      call: {
        callee: name,
        signature,
        args: [...args],
        argTypes: [...builtin.params],
        returns: builtin.returns,
        effects: [],
        ownership: "none",
        retain: false,
        builtin: true,
      },
    };
  }

  /**
   * A value as the truth a branch tests.
   *
   * A machine word is a truth as it stands; a wide number is four limbs and is
   * compared with zero, which is the test the source wrote with `!== 0n`.
   */
  private truth(value: SemanticValue): SemanticValue {
    if (!isWideType(value.type)) return value;
    return {
      k: "compare",
      type: BOOLEAN,
      op: "ne",
      operand: value.type,
      left: value,
      right: { k: "const", type: value.type, text: "0" },
    };
  }

  /** A call, or the one builtin that is an operation rather than a call. */
  private builtin(call: DraftCall, line: number): SemanticValue {
    if (call.builtin) {
      const extreme = EXTREMES[call.name];
      if (extreme !== undefined) {
        const type = this.operand;
        return {
          k: "arith",
          type,
          op: extreme,
          left: this.value(call.args[0], type, line),
          right: this.value(call.args[1], type, line),
        };
      }
      if (call.name === ARGV_LENGTH) return { k: "argv", type: call.returns, index: null };
      if (call.name === ARGV) return { k: "argv", type: call.returns, index: this.value(call.args[0], USIZE, line) };
    }
    return { k: "call", type: call.returns, call: this.call(call, line) };
  }

  private call(call: DraftCall, line: number): SemanticCall {
    return {
      callee: call.name,
      signature: call.signature,
      args: call.args.map((argument, position) =>
        this.value(argument, parameterExpect(call.signature.params[position].type), line),
      ),
      // A call of a count the call lower in arities names carries one type per
      // argument the call was made with, and the types the rest of the
      // signature names are the ones the longer form would have read them at.
      argTypes: call.signature.params.map((param) => parameterType(param.type)).slice(0, call.args.length),
      returns: call.returns,
      effects: call.effects,
      // What the caller owns is what the callee made: a block of bytes is laid
      // out with one reference of its own, and a pointer a function was handed
      // is borrowed for as long as the caller holds it.
      ownership: call.name === SHARED ? "owned" : ownership(call.returns),
      retain: false,
      builtin: call.builtin,
      // A grid launch is the call a kernel is launched with, and it is written
      // only where it was stated: an ordinary call has no grid, and a property
      // holding `undefined` is not the same value as one that says nothing
      // when the IR is compared against what the text reads back.
      ...(call.grid === undefined ? {} : { grid: this.value(call.grid, null, line) }),
    };
  }

  /** The type a declared name is read as, which nothing may leave untyped. */
  private localType(held: Held): SemanticType {
    // An array is read as the array it was allocated as, so a name of one and
    // the name it was declared under are one value to a backend.
    if (held.kind === "array") return arrayType(held);
    return heldType(held) ?? TEXT;
  }
}

/** Whether a body and the blocks inside it print anything. */
function printsOf(block: SemanticBlock): boolean {
  for (const statement of block.statements) {
    if (statement.k === "printText" || statement.k === "printNumber") return true;
    for (const nested of statementBlocksOf(statement)) if (printsOf(nested)) return true;
  }
  return block.terminator.k === "return" && block.terminator.value !== null && printsValue(block.terminator.value);
}

/** Whether a value, or anything inside it, is the command line. */
function printsValue(value: SemanticValue): boolean {
  let found = false;
  walkValues(value, (one) => {
    if (one.k === "argv") found = true;
  });
  return found;
}

/** Whether a body reads the command line the program was started with. */
function readsArgvOf(block: SemanticBlock): boolean {
  for (const statement of block.statements) {
    for (const value of statementValues(statement)) {
      if (printsValue(value)) return true;
    }
    for (const nested of statementBlocksOf(statement)) if (readsArgvOf(nested)) return true;
  }
  // What a block answers is a value of the block like any other, and a function
  // that reads the command line only to answer it reads it: `return
  // Number(process.argv[1])`. Leaving the terminator out is what answered "this
  // body has no effect" for it, and a body with no effect is one a caller may
  // run on two threads and one the inliner may fold into either.
  return block.terminator.k === "return" && block.terminator.value !== null && printsValue(block.terminator.value);
}

/** Every call a body makes, in the order it first makes each. */
function callsOf(block: SemanticBlock): CallEdge[] {
  const edges: CallEdge[] = [];
  const seen = new Set<string>();
  const walk = (one: SemanticBlock): void => {
    for (const statement of one.statements) {
      for (const value of statementValues(statement)) {
        walkValues(value, (inner) => {
          if (inner.k !== "call" || seen.has(inner.call.callee)) return;
          seen.add(inner.call.callee);
          edges.push({ callee: inner.call.callee, strategy: "call" });
        });
      }
      for (const nested of statementBlocksOf(statement)) walk(nested);
    }
    if (one.terminator.k === "return" && one.terminator.value !== null) {
      walkValues(one.terminator.value, (inner) => {
        if (inner.k !== "call" || seen.has(inner.call.callee)) return;
        seen.add(inner.call.callee);
        edges.push({ callee: inner.call.callee, strategy: "call" });
      });
    }
  };
  walk(block);
  return edges;
}

/* -------------------------------------------------------------------------- */
/* Entry                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Resolves the statements of a program against the contracts of the program it
 * calls, and writes them down as the semantic IR: every name, type, signature,
 * block and allocation is fixed here, so a backend is handed a program it can
 * read rather than a tree it has to decide anything about.
 */
export function resolveProgram(
  body: ProgramBody,
  program: ProgramContract,
  objectNames: Record<string, string> = {},
  objectLayouts: Record<string, ObjectLayout> = {},
  objectKeys: LiteralKeys = new Map(),
): SemanticProgram {
  // The layouts are the ones the phase named for the whole program: the
  // objects the functions write and the objects the body writes are one
  // counter, and a literal the body writes is built at the layout its own
  // shape was named as.
  const layouts: Record<string, ObjectLayout> = { ...objectLayouts };
  for (const file of program.files) {
    for (const contract of Object.values(file.functions)) {
      Object.assign(layouts, contract.definition?.objects ?? {});
    }
  }
  // A parameter the source wrote no type for is read at the type its callers
  // pass it at, and what the callers pass is read at the types the parameters
  // of the functions they call are read at. The program is therefore read
  // again and again until the kinds stop changing: what one round settles,
  // the next round reads at, and the round after that settles what that read
  // says. The kinds are kept beside the resolution rather than inside it, so
  // every round starts from what the last one learned.
  const observed = new Observations();
  let resolved: SemanticProgram | null = null;
  for (let round = 0; round < 16; round += 1) {
    observed.changed = false;
    const resolver = new ProgramResolver(
      body,
      contractsOf(program),
      layouts,
      {
        table: new Map(),
        waiting: [],
        settling: new Set(),
        used: new Set(),
        observed,
      },
      new Map(Object.entries(objectNames)),
      objectKeys,
      program.language,
    );
    resolved = new ProgramLowering(resolver.taken(), undefined, program.language, layouts).lower(resolver.resolve());
    if (!observed.changed) break;
  }
  return resolved as SemanticProgram;
}

// A backend is handed what this module resolved, so the type of it is named
// here as well as in the model: this is the module a driver reads.
export type { SemanticProgram };

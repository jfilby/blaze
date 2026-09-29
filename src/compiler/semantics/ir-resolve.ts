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

import { parseType, typeToString } from "./contract.ts";
import { CompilerError } from "../core/errors.ts";
import { mapTypeScriptType } from "./typescript.ts";
import type {
  ProgramAssignOp,
  ProgramBody,
  ProgramBinaryOp,
  ProgramStatement,
  ProgramText,
  ProgramUnaryOp,
  ProgramValue,
} from "./module.ts";
import type { Effect, FunctionSignature, ObjectLayout, PrimitiveTypeName, ProgramContract, TypeExpr } from "../core/types.ts";
import { ARGV, ARGV_LENGTH, builtinFor } from "./builtins.ts";
import {
  BOOLEAN,
  commonNumber,
  NUMERIC,
  TEXT,
  VOID,
  isTextType,
  isWhole,
  wholeOf,
  valueKind,
  type ArithOp,
  type CompareOp,
  type SemanticBlock,
  type SemanticCall,
  type SemanticProgram,
  type SemanticSlot,
  type SemanticStatement,
  type SemanticType,
  type SemanticValue,
  type UnaryOp,
} from "../core/semantic-ir.ts";

/* -------------------------------------------------------------------------- */
/* What a name holds                                                          */
/* -------------------------------------------------------------------------- */

/** A number, whole or not. `type` stays null until a use fixes it. */
interface NumberHeld {
  kind: "number";
  /** The name the program declares it under. */
  name: string;
  mutable: boolean;
  type: PrimitiveTypeName | null;
  text: string;
}

/** An array the program allocated, written out element by element. */
interface ArrayHeld {
  kind: "array";
  name: string;
  mutable: boolean;
  element: PrimitiveTypeName | null;
  length: number;
  /** The elements as they were written, in the type the array is used at. */
  values: DraftValue[];
}

/** A reference to an object one of the compiled functions returned. */
interface ObjectHeld {
  kind: "object";
  name: string;
  mutable: boolean;
  type: TypeExpr;
}

/** A string, as text when the program wrote it out, or built at run time. */
interface TextHeld {
  kind: "text";
  name: string;
  mutable: boolean;
  /** The text as written, or null when the program built the string. */
  value: string | null;
}

/** What a declared name holds. */
type Held = NumberHeld | ArrayHeld | ObjectHeld | TextHeld;

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
  returns: TypeExpr;
  /** What the call does beyond computing its result. */
  effects: Effect[];
  /** A function the compiler itself provides, as `Math.abs` is. */
  builtin: boolean;
}

/** One piece of a string: text as written, or a value interpolated into it. */
type DraftTextPart = { k: "text"; value: string } | { k: "value"; value: DraftValue };

/** A value the program does, before it is written down as the IR states it. */
type DraftValue =
  /** A number literal, of the type it is used at. */
  | { k: "literal"; held: NumberHeld }
  /** A typed array literal, of the element type it is used at. */
  | { k: "buffer"; held: ArrayHeld }
  /** A value the program declared, read by the name it was declared as. */
  | { k: "reference"; name: string; held: Held }
  /** A string the program builds. */
  | { k: "text"; parts: DraftTextPart[] }
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
  | { k: "binary"; op: ProgramBinaryOp; left: DraftValue; right: DraftValue; type: TypeExpr | null }
  | { k: "unary"; op: ProgramUnaryOp; operand: DraftValue; type: TypeExpr | null }
  | {
      k: "conditional";
      condition: DraftValue;
      then: DraftValue;
      otherwise: DraftValue;
      type: TypeExpr | null;
    };

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
  | { kind: "update"; name: string; op: "++" | "--"; prefix: boolean; type: TypeExpr; line: number }
  | { kind: "print"; values: DraftValue[]; line: number }
  | { kind: "invoke"; call: DraftCall; line: number }
  | { kind: "if"; condition: DraftValue; then: DraftStatement[]; otherwise: DraftStatement[]; line: number }
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
  | { kind: "block"; body: DraftStatement[]; line: number };

/** A program with every name and type resolved, ready to be written down. */
interface DraftProgram {
  file: string;
  statements: DraftStatement[];
  functions: FunctionSignature[];
  objects: Record<string, ObjectLayout>;
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

function primitive(type: TypeExpr | null): PrimitiveTypeName | null {
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
/** True when a number written in the source is a whole number. */
function isWholeLiteral(text: string): boolean {
  return /^[+-]?\d+$/.test(text) || /^[+-]?0[xX][0-9a-fA-F]+$/.test(text);
}

/**
 * The value a whole number written in the source is, or null where the text is
 * not one. `BigInt` takes a sign on a decimal literal only, so a negative
 * hexadecimal one is negated rather than converted with its sign: handing it
 * the text as written raised a SyntaxError out of the compiler, which is the
 * one thing the check the value feeds is there to keep from happening.
 */
function integerLiteral(text: string): bigint | null {
  if (/^[+-]?0[xX][0-9a-fA-F]+$/.test(text)) {
    const negative = text.startsWith("-");
    return (negative ? -1n : 1n) * BigInt(negative ? text.slice(1) : text);
  }
  return /^[+-]?[0-9]+$/.test(text) ? BigInt(text) : null;
}

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
 * The type an operation on two whole numbers has: the one they have in
 * common. A number written in the source is a double, as it is in the
 * language it was written in, and a side with no type makes the operation a
 * double. A floating operation is always floating: `7 / 2` is `3.5` in
 * TypeScript, and the driver has to agree.
 */
function numericResult(left: PrimitiveTypeName | null, right: PrimitiveTypeName | null, floating: boolean): PrimitiveTypeName {
  if (floating) return "f64";
  const whole = (side: PrimitiveTypeName | null): PrimitiveTypeName | null =>
    side !== null && isWhole(side) ? side : null;
  const a = whole(left);
  const b = whole(right);
  // A number in the source is a double, as it is in the language it was written
  // in, and arithmetic on one is a double: a length is a whole number, and
  // `length - 10` is -7 rather than a very large unsigned number.
  if (a !== null && b !== null) return wholeOf(a, b);
  return "f64";
}

/** True when the value is a string, which is the one type a number is not. */
function holdsText(value: DraftValue): boolean {
  switch (value.k) {
    case "text":
      return true;
    case "reference":
      return value.held.kind === "text";
    case "binary":
      return value.op === "+" && value.type === null;
    case "conditional":
      return value.type === null;
    case "literal":
    case "buffer":
    case "call":
    case "length":
    case "stringLength":
    case "element":
    case "boolean":
    case "compare":
    case "isNull":
    case "unary":
    case "null":
      return false;
  }
}

/** The type a resolved value has, or null when it is a string. */
function draftType(value: DraftValue): TypeExpr | null {
  switch (value.k) {
    case "literal":
      return value.held.type === null ? null : { kind: "primitive", name: value.held.type };
    case "buffer":
      return { kind: "slice", of: { kind: "primitive", name: value.held.element ?? "f64" } };
    case "reference":
      return heldType(value.held);
    case "text":
      return null;
    case "call":
      return value.call.returns;
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
  }
}

/** The type an array is written out as, which is the type its name is read as. */
function arrayType(held: ArrayHeld): TypeExpr {
  return { kind: "array", of: { kind: "primitive", name: held.element ?? "f64" }, length: held.length };
}

/** Every exported function of the program, and what each of them does. */
function contractsOf(program: ProgramContract): Map<string, { signature: FunctionSignature; effects: Effect[] }> {
  const contracts = new Map<string, { signature: FunctionSignature; effects: Effect[] }>();
  for (const file of program.files) {
    for (const [name, contract] of Object.entries(file.functions)) {
      contracts.set(name, { signature: contract.function, effects: contract.effects });
    }
  }
  return contracts;
}

/**
 * The whole number a whole operator yields. `%`, a shift and a bitwise operator
 * are operations on whole numbers whatever the literals were written as, and
 * `1 << 4` is 16 rather than a shift of two doubles, so the result is a whole
 * number: the one the operands share when both are already whole, and an i64
 * otherwise.
 */
function wholeResult(left: PrimitiveTypeName | null, right: PrimitiveTypeName | null): PrimitiveTypeName {
  return left !== null && right !== null && isWhole(left) && isWhole(right) ? wholeOf(left, right) : "i64";
}

/** The operators only whole numbers have. */
const WHOLE_OPERATORS: readonly ProgramBinaryOp[] = ["%", "<<", ">>", "&", "|", "^"];
/** The compound assignments only whole numbers have. */
const WHOLE_ASSIGNMENTS: readonly ProgramAssignOp[] = ["%="];
const EQUALITY: readonly ProgramBinaryOp[] = ["===", "!==", "==", "!="];

const LOGICAL: readonly ProgramBinaryOp[] = ["&&", "||", "??"];

/** What the operators a binary expression is written with state in the IR. */
const ARITHMETIC: Record<ProgramBinaryOp, ArithOp | null> = {
  "+": "add",
  "-": "sub",
  "*": "mul",
  "/": "div",
  "%": "mod",
  "**": "pow",
  "<<": "shl",
  ">>": "shr",
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
  "%": null,
  "**": null,
  "<<": null,
  ">>": null,
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

/* -------------------------------------------------------------------------- */
/* Resolver                                                                   */
/* -------------------------------------------------------------------------- */

class ProgramResolver {
  private readonly scopes: Map<string, Held>[] = [new Map()];
  private readonly used = new Set<string>();
  private readonly body: ProgramBody;
  private readonly contracts: Map<string, { signature: FunctionSignature; effects: Effect[] }>;
  private readonly objects: Record<string, ObjectLayout>;
  /** An array another name was given, and the array it is the same array as. */
  private readonly aliases: [ArrayHeld, ArrayHeld][] = [];
  /** How many loops the statement being resolved is written in. */
  private loops = 0;

  constructor(body: ProgramBody, contracts: Map<string, { signature: FunctionSignature; effects: Effect[] }>, objects: Record<string, ObjectLayout>) {
    this.body = body;
    this.contracts = contracts;
    this.objects = objects;
  }

  resolve(): DraftProgram {
    const statements = this.statements(this.body.statements);
    return {
      file: this.body.file,
      statements,
      functions: [...this.contracts.values()].map((contract) => contract.signature),
      objects: this.objects,
    };
  }

  /** The names the program holds, so a generated name is not one of them. */
  taken(): Set<string> {
    return this.used;
  }

  /* ---------------------------------------------------------------------- */
  /* Scopes                                                                  */
  /* ---------------------------------------------------------------------- */

  private lookup(name: string): Held | undefined {
    for (let index = this.scopes.length - 1; index >= 0; index -= 1) {
      const held = this.scopes[index].get(name);
      if (held !== undefined) return held;
    }
    return undefined;
  }

  private held(name: string, line: number): Held {
    const held = this.lookup(name);
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

  private declareName(name: string, line: number, held: WithoutName<Held>): Held {
    if (this.scopes[this.scopes.length - 1].has(name)) {
      throw programError(`"${name}" is declared twice in the same block`, this.body, line);
    }
    const declared = { ...held, name } as Held;
    this.used.add(name);
    this.scopes[this.scopes.length - 1].set(name, declared);
    return declared;
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

  private statements(list: readonly ProgramStatement[]): DraftStatement[] {
    return list.map((statement) => this.statement(statement));
  }

  private block(body: ProgramStatement[]): DraftStatement[] {
    this.open();
    const resolved = this.statements(body);
    this.close();
    return resolved;
  }

  private statement(statement: ProgramStatement): DraftStatement {
    switch (statement.kind) {
      case "declare":
        return this.declaration(statement);
      case "assign":
        return this.assignment(statement);
      case "elementAssign":
        return this.elementAssignment(statement);
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
        const call = this.call({ k: "call", function: statement.function, args: statement.args }, statement.line);
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
      case "while":
        return {
          kind: "while",
          condition: this.condition(statement.condition, statement.line),
          body: this.looped(statement.body),
          line: statement.line,
        };
      case "doWhile":
        return {
          kind: "doWhile",
          condition: this.condition(statement.condition, statement.line),
          body: this.looped(statement.body),
          line: statement.line,
        };
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
    }
  }

  private declaration(statement: ProgramStatement & { kind: "declare" }): DraftStatement {
    const annotation = statement.type === null ? null : this.annotation(statement.type, statement.line);
    const value = this.value(statement.value, annotation, statement.line);
    const mutable = statement.mutable;
    // A declaration names the name the program declares, and the value is
    // written as it stands: what it is, the reader reads off what it holds.
    const declare = (held: WithoutName<Held>): DraftStatement => {
      const declared = this.declareName(statement.name, statement.line, held);
      return { kind: "declare", name: declared.name, held: declared, value, line: statement.line };
    };
    switch (value.k) {
      case "buffer":
        return declare({
          kind: "array",
          mutable,
          element: annotation === null ? value.held.element : elementOf(annotation),
          length: value.held.length,
          values: value.held.values,
        });
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
          return declare({ kind: "number", mutable, type: held.type, text: held.text });
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
        return declare({ kind: "object", mutable, type: held.type });
      }
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
      case "literal":
        return declare({ kind: "number", mutable, type: value.held.type, text: value.held.text });
      case "compare":
      case "isNull":
        return declare({ kind: "number", mutable, type: "bool", text: "" });
      case "call": {
        const returns = primitive(value.call.returns);
        if (returns !== null) return declare({ kind: "number", mutable, type: returns, text: "" });
        if (value.call.returns.kind === "ref") {
          return declare({ kind: "object", mutable, type: value.call.returns });
        }
        throw programError(
          `${value.call.name} returns ${typeToString(value.call.returns)}`,
          this.body,
          statement.line,
          `line ${statement.line} of ${this.body.file}: a program holds numbers, strings and references`,
        );
      }
      case "binary":
      case "unary":
      case "conditional": {
        const type = value.type;
        if (type === null) return declare({ kind: "text", mutable, value: null });
        const name = primitive(type);
        if (name === null || !NUMERIC.includes(name)) {
          throw programError(
            `a program cannot hold ${typeToString(type)}`,
            this.body,
            statement.line,
            `line ${statement.line} of ${this.body.file}: a program holds numbers, strings and references`,
          );
        }
        return declare({ kind: "number", mutable, type: name, text: "" });
      }
    }
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
      throw programError(
        `"${statement.name}" is a reference to an object`,
        this.body,
        statement.line,
        `line ${statement.line} of ${this.body.file}: a program reads what a function returned`,
      );
    }
    if (held.kind === "text") {
      const written = this.value(statement.value, null, statement.line);
      // A number written into a string becomes its text, as `s += 1` does in
      // the language, rather than an error the source does not raise.
      const value = holdsText(written) ? written : { k: "text" as const, parts: [{ k: "value" as const, value: written }] };
      return { kind: "assign", name: held.name, op: statement.op, value, type: null, line: statement.line };
    }
    const name = held.type ?? "f64";
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
    return {
      kind: "assign",
      name: held.name,
      op: statement.op,
      value: this.value(statement.value, type, statement.line),
      type,
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
    const counted = whole ? (widths.length === 0 ? "i64" : wholeOf(widths[0], widths[1] ?? widths[0])) : "f64";
    const type = numeric(statement.down && counted.startsWith("u") ? "i64" : counted);
    const from = this.value(statement.from, type, statement.line);
    const to = this.value(statement.to, type, statement.line);
    const step = written === null ? null : this.value(statement.step as ProgramValue, type, statement.line);
    this.open();
    const variable = this.declareName(statement.variable, statement.line, {
      kind: "number",
      mutable: true,
      type: primitive(type),
      text: "",
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

  /** A condition: the truth of a value, which need not be a boolean. */
  private condition(value: ProgramValue, line: number): DraftValue {
    const resolved = this.value(value, null, line);
    if (resolved.k === "compare" || resolved.k === "isNull" || resolved.k === "boolean") return resolved;
    return resolved;
  }

  private value(value: ProgramValue, expect: TypeExpr | null, line: number): DraftValue {
    switch (value.k) {
      case "number": {
        const held: NumberHeld = { kind: "number", name: "", mutable: false, type: null, text: value.text };
        if (expect !== null && primitive(expect) !== null) this.expectNumber(expect, held, line);
        return { k: "literal", held };
      }
      case "bigint":
        return { k: "literal", held: { kind: "number", name: "", mutable: false, type: "i64", text: value.text } };
      case "boolean":
        return { k: "boolean", value: value.value };
      case "null":
        return { k: "null", type: expect };
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
      case "name": {
        // An array is used at one element type, whichever name it is passed by.
        const held = this.held(value.name, line);
        if (held.kind === "array" && expect !== null) this.expectArray(expect, held, line);
        return this.reference(value.name, line);
      }
      case "length": {
        const held = this.held(value.of, line);
        if (held.kind === "text") {
          return { k: "stringLength", of: { k: "reference", name: held.name, held } };
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
      case "element": {
        const held = this.held(value.buffer, line);
        if (held.kind !== "array") {
          throw programError(
            `"${value.buffer}" is not a buffer`,
            this.body,
            line,
            `${this.body.file}: only an array has elements`,
          );
        }
        const element = held.element ?? "f64";
        held.element ??= element;
        const index = this.value(value.index, USIZE, line);
        this.within(index, held, line);
        if (expect !== null) {
          this.coerce(`an element of ${value.buffer}`, { kind: "primitive", name: element }, expect, line);
        }
        return { k: "element", buffer: held.name, bufferType: arrayType(held), index, type: element };
      }
      case "call":
        return { k: "call", call: this.call(value, line) };
      case "unary":
        return this.unary(value, line);
      case "conditional": {
        const condition = this.condition(value.condition, line);
        const then = this.value(value.then, null, line);
        const otherwise = this.value(value.otherwise, expect, line);
        const type = expect ?? this.common(then, otherwise, line);
        return { k: "conditional", condition, then, otherwise, type };
      }
      case "binary":
        return this.binary(value, expect, line);
    }
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
      // A number written with its sign is one literal, so a use can still fix
      // its type without a conversion.
      if (value.operand.k === "number") {
        const text = value.op === "-" ? `-${value.operand.text}` : value.operand.text;
        return { k: "literal", held: { kind: "number", name: "", mutable: false, type: null, text } };
      }
      if (value.op === "+") return this.value(value.operand, null, line);
    }
    const operand = this.value(value.operand, null, line);
    if (value.op === "!") {
      if (holdsText(operand)) {
        return { k: "compare", how: "string", negate: true, left: operand, right: { k: "text", parts: [{ k: "text", value: "" }] } };
      }
      return { k: "unary", op: "!", operand, type: { kind: "primitive", name: "bool" } };
    }
    // `~` inverts a whole number bit by bit, and a number written in the source
    // is whole here because it is written without a point.
    if (value.op === "~") {
      // Inverting a number gives a signed one, as it does in the language: the
      // bits of 3 inverted are -4, and not a very large unsigned number.
      const name = primitive(draftType(operand));
      if (name !== null && !isWhole(name)) throw programError("~ needs a whole number", this.body, line);
      return { k: "unary", op: value.op, operand, type: numeric("i64") };
    }
    const type = primitive(draftType(operand)) ?? "f64";
    return { k: "unary", op: value.op, operand, type: numeric(type) };
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
          : this.common(left, right, line);
      return { k: "binary", op, left, right, type };
    }
    if (EQUALITY.includes(op)) {
      const left = this.value(value.left, null, line);
      const right = this.value(value.right, null, line);
      const compared = this.equality(op, left, right, line);
      if (compared.k === "boolean") return compared;
      return { ...compared, negate: op === "!==" || op === "!=" };
    }
    const left = this.value(value.left, null, line);
    const right = this.value(value.right, left.k === "literal" ? draftType(left) : null, line);
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
    if (op === "**") {
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
    const leftName = primitive(draftType(left));
    const rightName = primitive(draftType(right));
    // A comparison holds or it does not. A whole operator needs whole numbers
    // and yields one, whatever the literals it was written with: `7 % 3` is 1.
    const whole = WHOLE_OPERATORS.includes(op);
    const type = COMPARISONS[op] !== null
      ? numeric("bool")
      : whole
        ? numeric(wholeResult(leftName, rightName))
        : numeric(numericResult(leftName, rightName, op === "/"));
    return { k: "binary", op, left, right, type };
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

  private call(value: ProgramValue & { k: "call" }, line: number): DraftCall {
    const builtin = builtinFor(value.function);
    if (builtin !== null) {
      if (value.args.length !== builtin.params.length) {
        throw programError(
          `${value.function} takes ${builtin.params.length} argument(s), not ${value.args.length}`,
          this.body,
          line,
        );
      }
      return {
        name: value.function,
        signature: {
          name: value.function,
          symbol: value.function,
          params: builtin.params.map((type, index) => ({ name: `argument${index}`, type: typeToString(type) })),
          returns: typeToString(builtin.returns),
        },
        args: value.args.map((argument, position) => this.value(argument, builtin.params[position], line)),
        returns: builtin.returns,
        effects: [],
        builtin: true,
      };
    }
    const contract = this.contracts.get(value.function);
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
    return {
      name: signature.symbol,
      signature,
      args: value.args.map((arg, position) => this.value(arg, parseType(signature.params[position].type), line)),
      returns: parseType(signature.returns),
      effects: contract.effects,
      builtin: false,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Uses                                                                    */
  /* ---------------------------------------------------------------------- */

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
    const source = primitive(from);
    const target = primitive(to);
    if (source === null || target === null || !NUMERIC.includes(source) || !NUMERIC.includes(target)) {
      throw programError(`${what} cannot be used as ${typeToString(to)}`, this.body, line);
    }
  }

  /** The type an annotation names, as a contract type. */
  private annotation(text: string, line: number): TypeExpr {
    try {
      return mapTypeScriptType(text, `line ${line} of ${this.body.file}`);
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
    const held = value.k === "buffer" || (value.k === "reference" && value.held.kind === "array");
    if (held) {
      throw programError(
        "a program cannot print a buffer",
        this.body,
        line,
        `line ${line} of ${this.body.file}: print a number, or a string that interpolates one`,
      );
    }
    if (value.k === "reference" && value.held.kind === "object") {
      throw programError(
        "a program cannot print an object",
        this.body,
        line,
        `line ${line} of ${this.body.file}: print a number, or a string that interpolates one`,
      );
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
}

/** One block being written, what it owns, and the loop whose body it is. */
interface BlockFrame {
  block: SemanticBlock;
  /** The loop this block is written in, which a break and a continue leave. */
  loop: LoopTarget | null;
  /** True for the body of the loop above, which a break leaves as well. */
  body: boolean;
}

/** True when writing a value twice would run it twice. */
function draftHasCall(value: DraftValue): boolean {
  switch (value.k) {
    case "call":
      return true;
    case "buffer":
    case "literal":
    case "boolean":
    case "null":
    case "length":
    case "reference":
      return false;
    case "element":
      return draftHasCall(value.index);
    case "stringLength":
      return draftHasCall(value.of);
    case "text":
      return value.parts.some((part) => part.k === "value" && draftHasCall(part.value));
    case "compare":
      return draftHasCall(value.left) || draftHasCall(value.right);
    case "isNull":
      return draftHasCall(value.operand);
    case "unary":
      return draftHasCall(value.operand);
    case "binary":
      return draftHasCall(value.left) || draftHasCall(value.right);
    case "conditional":
      return draftHasCall(value.condition) || draftHasCall(value.then) || draftHasCall(value.otherwise);
  }
}

/** Who owns what a call of a type hands back. */
function ownership(returns: TypeExpr): "none" | "borrowed" | "owned" {
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
  /** What a value hoisted, to be written before the statement it is used in. */
  private pending: SemanticStatement[] = [];
  private counters: Record<"t" | "a" | "i", number> = { t: 0, a: 0, i: 0 };
  private blockCount = 0;

  constructor(used: Set<string>) {
    this.used = used;
  }

  lower(program: DraftProgram): SemanticProgram {
    const entry: SemanticBlock = { id: "entry", statements: [], releases: [], terminator: { k: "return", value: null } };
    this.enter(entry, null);
    this.statements(program.statements);
    this.leave();
    return {
      file: program.file,
      entry,
      functions: program.functions,
      objects: program.objects,
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
    if (isTextType(type)) return { kind: "text", name, mutable };
    if (type.kind === "ref" || type.kind === "ptr") return { kind: "object", name, mutable, type };
    return { kind: "value", name, mutable, type };
  }

  /** The slot a declaration makes, and the type the name is read as. */
  private declared(held: Held): SemanticSlot {
    if (held.kind === "text") return { kind: "text", name: held.name, mutable: held.mutable };
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
      if (this.frame().block.terminator.k === "jump") break;
      this.draft(statement);
    }
  }

  private draft(statement: DraftStatement): void {
    switch (statement.kind) {
      case "declare": {
        const slot = this.declared(statement.held);
        // An array the program wrote out is the name it is declared as, not a
        // name of its own: the declaration is the allocation.
        const value = statement.value.k === "buffer" && statement.held.kind === "array"
          ? this.buffer(statement.held, statement.line)
          : this.value(statement.value, null, statement.line);
        // A name that is nothing is declared as the reference it is, so the
        // name reads as what it holds. An array another name already holds is
        // named again rather than allocated again, so the block owns it once.
        const held = value.k === "nothing" && slot.kind === "object" ? { ...value, type: slot.type } : value;
        if (slot.kind === "buffer" && statement.value.k !== "reference") this.own(slot.name);
        this.statement({ k: "let", slot, value: held, line: statement.line });
        return;
      }
      case "assign":
        this.statement({
          k: "set",
          name: statement.name,
          op: statement.op,
          value: this.value(statement.value, statement.type, statement.line),
          line: statement.line,
        });
        return;
      case "elementAssign":
        this.statement({
          k: "setElement",
          buffer: statement.buffer,
          index: this.value(statement.index, USIZE, statement.line),
          op: statement.op,
          value: this.value(statement.value, statement.type, statement.line),
          line: statement.line,
        });
        return;
      case "update":
        this.statement({ k: "step", name: statement.name, op: statement.op, prefix: statement.prefix, line: statement.line });
        return;
      case "print":
        this.print(statement);
        return;
      case "invoke":
        this.statement({ k: "call", call: this.call(statement.call, statement.line), line: statement.line });
        return;
      case "if": {
        const condition = this.value(statement.condition, null, statement.line);
        const then = this.arm(statement.then, this.frame().loop);
        const otherwise = statement.otherwise.length === 0 ? null : this.arm(statement.otherwise, this.frame().loop);
        this.statement({ k: "if", condition, then, otherwise, line: statement.line });
        return;
      }
      case "while": {
        const condition = this.value(statement.condition, null, statement.line);
        this.statement({
          k: "loop",
          loop: { kind: "while", condition, ...this.loop(statement.body) },
          line: statement.line,
        });
        return;
      }
      case "doWhile": {
        const condition = this.value(statement.condition, null, statement.line);
        this.statement({
          k: "loop",
          loop: { kind: "doWhile", condition, ...this.loop(statement.body) },
          line: statement.line,
        });
        return;
      }
      case "for": {
        const type = statement.type;
        const from = this.value(statement.from, type, statement.line);
        const to = this.value(statement.to, type, statement.line);
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
            ...this.loop(statement.body),
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
            ...this.loop(statement.body),
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
    }
  }

  /**
   * The blocks a loop leaves, and the block that holds it: the test is named
   * before the body is written, and control resumes in the block the loop was
   * written in, which is the one the loop statement is in.
   */
  private loop(body: readonly DraftStatement[]): { header: string; exit: string; body: SemanticBlock } {
    const header = this.blockId();
    // Control resumes in the block the loop was written in, which is the one
    // the loop statement is in, and never in a block of its own.
    const target: LoopTarget = { header, exit: this.frame().block.id };
    return { header, exit: target.exit, body: this.arm(body, target, true) };
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
      this.printed(value, statement.line);
    });
    this.statement({ k: "printNewline", line: statement.line });
  }

  /** One printed value, the way the runtime writes what it holds. */
  private printed(value: SemanticValue, line: number): void {
    switch (valueKind(value)) {
      case "text":
        this.statement({ k: "printText", value, line });
        return;
      case "number":
        this.statement({ k: "printNumber", value, line });
        return;
      case "boolean":
      case "reference":
        this.statement({ k: "printText", value: { k: "toText", type: TEXT, of: value }, line });
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
        return this.array(value, line);
      case "reference":
        return { k: "local", type: this.localType(value.held), name: value.name };
      case "text":
        return { k: "text", type: TEXT, parts: value.parts.map((part) => part.k === "text" ? part : { k: "value", value: this.written(part.value, line) }) };
      case "boolean":
        return { k: "bool", type: BOOLEAN, value: value.value };
      case "null":
        return { k: "nothing", type: value.type ?? VOID };
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
        return this.builtin(value.call, line);
      case "compare":
        return {
          k: "compare",
          type: BOOLEAN,
          op: value.negate ? "ne" : "eq",
          operand: value.how === "string" ? TEXT : this.operand(value.left, value.right),
          left: this.value(value.left, null, line),
          right: this.value(value.right, null, line),
        };
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
          condition: this.value(value.condition, null, line),
          then: this.value(value.then, value.type, line),
          otherwise: this.value(value.otherwise, value.type, line),
        };
    }
  }

  /** The type two values are compared at, which is the double they are. */
  private operand(left: DraftValue, right: DraftValue): TypeExpr {
    const type = commonNumber(draftType(left), draftType(right));
    return type !== null && !isTextType(type) ? type : numeric("f64");
  }

  /** A value as text, which is how a string carries a number. */
  private written(value: DraftValue, line: number): SemanticValue {
    const mapped = this.value(value, null, line);
    if (isTextType(mapped.type)) return mapped;
    return { k: "toText", type: TEXT, of: mapped };
  }

  /**
   * An array literal is written out as a name of its own, where the program
   * wrote it, and the block it was written in owns it: a name reads that
   * array, and it is freed when the block ends.
   */
  private array(value: DraftValue & { k: "buffer" }, line: number): SemanticValue {
    const name = this.generated("a");
    const held = value.held;
    const slot: SemanticSlot = {
      kind: "buffer",
      name,
      mutable: false,
      element: numeric(held.element ?? "f64"),
      length: held.length,
    };
    this.pending.push({ k: "let", slot, value: this.buffer(held, line), line });
    this.own(name);
    return { k: "local", type: arrayType(held), name };
  }

  /** A typed array, written out element by element in the type it is used at. */
  private buffer(held: ArrayHeld, line: number): SemanticValue {
    const element = numeric(held.element ?? "f64");
    return {
      k: "buffer",
      type: arrayType(held),
      element,
      length: held.length,
      values: held.values.map((item) => this.value(item, element, line)),
    };
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
        // The arms have the type they have in common, which a truth and a
        // truth is; only a string pair has none, and nothing prints that.
        type: value.type ?? BOOLEAN,
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
    // The two sides of a comparison are compared as the one type they have in
    // common, so a whole number and a literal are compared as whole numbers
    // rather than as two different ones.
    const comparison = COMPARISONS[op];
    if (comparison !== null) {
      const operand = this.operand(value.left, value.right);
      return {
        k: "compare",
        type: BOOLEAN,
        op: comparison,
        operand,
        left: this.value(value.left, operand, line),
        right: this.value(value.right, operand, line),
      };
    }
    const left = this.value(value.left, value.type, line);
    const right = this.value(value.right, value.type, line);
    // A string added to a string is the one operation with no number behind
    // it: the two arms were text, and it is text the IR states.
    if (value.type === null) return { k: "arith", type: TEXT, op: "concat", left, right };
    return { k: "arith", type: value.type, op: ARITHMETIC[op] as ArithOp, left, right };
  }

  /** A call, or the one builtin that is an operation rather than a call. */
  private builtin(call: DraftCall, line: number): SemanticValue {
    if (call.builtin) {
      const extreme = EXTREMES[call.name];
      if (extreme !== undefined) {
        const type = this.operand(call.args[0], call.args[1]);
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
      args: call.args.map((argument, position) => this.value(argument, parseType(call.signature.params[position].type), line)),
      argTypes: call.signature.params.map((param) => parseType(param.type)),
      returns: call.returns,
      effects: call.effects,
      ownership: ownership(call.returns),
      retain: false,
      builtin: call.builtin,
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

/* -------------------------------------------------------------------------- */
/* Entry                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Resolves the statements of a program against the contracts of the program it
 * calls, and writes them down as the semantic IR: every name, type, signature,
 * block and allocation is fixed here, so a backend is handed a program it can
 * read rather than a tree it has to decide anything about.
 */
export function resolveProgram(body: ProgramBody, program: ProgramContract): SemanticProgram {
  const objects: Record<string, ObjectLayout> = {};
  for (const file of program.files) {
    for (const contract of Object.values(file.functions)) {
      Object.assign(objects, contract.definition.objects);
    }
  }
  const resolver = new ProgramResolver(body, contractsOf(program), objects);
  return new ProgramLowering(resolver.taken()).lower(resolver.resolve());
}

// A backend is handed what this module resolved, so the type of it is named
// here as well as in the model: this is the module a driver reads.
export type { SemanticProgram };

/**
 * Resolving a program.
 *
 * The contract phase hands back the statements of a program exactly as the
 * frontend parsed them: names, literals, operators and calls, with no types.
 * This module turns them into a program a driver emitter can write down, by
 * resolving every call against the program contract, every name against the
 * scope it was declared in, and every value against the type it is used at.
 *
 * A program is driven, not interpreted, so a name is written down once: a
 * declaration names the variable the driver declares, and every later use of
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
 * A string is a value the driver builds, not a number, so it has no contract
 * type: it is declared as a string, and `+` on a string is concatenation.
 */

import { parseType, typeToString } from "../semantics/contract.ts";
import { CompilerError } from "../core/errors.ts";
import { mapTypeScriptType } from "../semantics/typescript.ts";
import type {
  ProgramAssignOp,
  ProgramBody,
  ProgramBinaryOp,
  ProgramStatement,
  ProgramText,
  ProgramUnaryOp,
  ProgramValue,
} from "../semantics/module.ts";
import type { FunctionSignature, ObjectLayout, PrimitiveTypeName, ProgramContract, TypeExpr } from "../core/types.ts";
import { BUILTINS } from "../semantics/builtins.ts";

/* -------------------------------------------------------------------------- */
/* Bindings                                                                   */
/* -------------------------------------------------------------------------- */

/** A number, whole or not. `type` stays null until a use fixes it. */
export interface ScalarBinding {
  kind: "scalar";
  /** The name the driver declares it under. */
  name: string;
  mutable: boolean;
  type: PrimitiveTypeName | null;
  text: string;
}

/** A buffer the program allocated, written out element by element. */
export interface BufferBinding {
  kind: "buffer";
  name: string;
  mutable: boolean;
  element: PrimitiveTypeName | null;
  length: number;
  /** The elements as they were written, in the type the buffer is used at. */
  values: ResolvedValue[];
}

/** A reference to an object one of the compiled functions returned. */
export interface ReferenceBinding {
  kind: "reference";
  name: string;
  mutable: boolean;
  type: TypeExpr;
}

/** A string, as text when the program wrote it out, or built at run time. */
export interface StringBinding {
  kind: "string";
  name: string;
  mutable: boolean;
  /** The text as written, or null when the program built the string. */
  value: string | null;
}

/** What a declared name holds. */
export type Binding = ScalarBinding | BufferBinding | ReferenceBinding | StringBinding;

/** A binding as a declaration states it, before the driver names its variable. */
type WithoutName<T> = T extends unknown ? Omit<T, "name"> : never;

/** A call to a function the program compiled, with every argument placed. */
export interface ResolvedCall {
  name: string;
  signature: FunctionSignature;
  args: ResolvedValue[];
  returns: TypeExpr;
  /** A function the compiler itself provides, as `Math.max` is. */
  builtin: boolean;
}

/** A value the driver can write down. */
export type ResolvedValue =
  /** A number literal, of the type it is used at. */
  | { k: "literal"; binding: ScalarBinding }
  /** A typed array literal, of the element type it is used at. */
  | { k: "buffer"; binding: BufferBinding }
  /** A value the program declared, read by the variable it was declared as. */
  | { k: "reference"; name: string; binding: Binding }
  /** A string the program builds. */
  | { k: "text"; parts: ResolvedTextPart[] }
  | { k: "call"; call: ResolvedCall }
  /** The length of a buffer. */
  | { k: "length"; buffer: string; type: PrimitiveTypeName }
  /** The length of a string, counted the way a buffer length is. */
  | { k: "stringLength"; of: ResolvedValue }
  /** One element of a buffer. */
  | { k: "element"; buffer: string; index: ResolvedValue; type: PrimitiveTypeName }
  | { k: "boolean"; value: boolean }
  | { k: "null" }
  /** `a == b`, over numbers or over strings. */
  | { k: "compare"; how: "number" | "string"; negate: boolean; left: ResolvedValue; right: ResolvedValue }
  /** `a === null`. */
  | { k: "isNull"; operand: ResolvedValue; negate: boolean }
  | { k: "binary"; op: ProgramBinaryOp; left: ResolvedValue; right: ResolvedValue; type: TypeExpr | null }
  | { k: "unary"; op: ProgramUnaryOp; operand: ResolvedValue; type: TypeExpr | null }
  | {
      k: "conditional";
      condition: ResolvedValue;
      then: ResolvedValue;
      otherwise: ResolvedValue;
      type: TypeExpr | null;
    };

export type ResolvedTextPart = { k: "text"; value: string } | { k: "value"; value: ResolvedValue };

export type ResolvedStatement =
  | { kind: "declare"; name: string; binding: Binding; value: ResolvedValue; line: number }
  | { kind: "assign"; name: string; op: ProgramAssignOp; value: ResolvedValue; type: TypeExpr | null; line: number }
  | {
      kind: "elementAssign";
      buffer: string;
      index: ResolvedValue;
      op: ProgramAssignOp;
      value: ResolvedValue;
      type: TypeExpr;
      line: number;
    }
  | { kind: "update"; name: string; op: "++" | "--"; prefix: boolean; type: TypeExpr; line: number }
  | { kind: "print"; values: ResolvedValue[]; line: number }
  | { kind: "invoke"; call: ResolvedCall; line: number }
  | { kind: "if"; condition: ResolvedValue; then: ResolvedStatement[]; otherwise: ResolvedStatement[]; line: number }
  | { kind: "while"; condition: ResolvedValue; body: ResolvedStatement[]; line: number }
  | { kind: "doWhile"; condition: ResolvedValue; body: ResolvedStatement[]; line: number }
  | {
      kind: "for";
      variable: string;
      type: TypeExpr;
      from: ResolvedValue;
      to: ResolvedValue;
      inclusive: boolean;
      down: boolean;
      step: ResolvedValue | null;
      body: ResolvedStatement[];
      line: number;
    }
  | { kind: "forOf"; variable: string; type: TypeExpr; of: string; length: ResolvedValue; line: number; body: ResolvedStatement[] }
  | { kind: "break"; line: number }
  | { kind: "continue"; line: number }
  | { kind: "block"; body: ResolvedStatement[]; line: number };

/** A program with every name and type resolved, ready to be written down. */
export interface ResolvedProgram {
  file: string;
  statements: ResolvedStatement[];
  functions: FunctionSignature[];
  objects: Record<string, ObjectLayout>;
}

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

const NUMERIC: readonly PrimitiveTypeName[] = ["i8", "i16", "i32", "i64", "u8", "u16", "u32", "u64", "f32", "f64", "usize", "isize"];

/** The type of a value of a primitive name. */
function numeric(name: PrimitiveTypeName): TypeExpr {
  return { kind: "primitive", name };
}

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
function isWhole(type: PrimitiveTypeName): boolean {
  return type !== "f32" && type !== "f64" && type !== "bool";
}

const WHOLE_RANK: Record<string, number> = { i8: 1, u8: 1, i16: 2, u16: 2, i32: 3, u32: 3, i64: 4, u64: 4, isize: 4, usize: 4 };

/** The whole number type two whole numbers have in common. */
function wholeOf(a: PrimitiveTypeName, b: PrimitiveTypeName): PrimitiveTypeName {
  if (a === b) return a;
  const rank = Math.max(WHOLE_RANK[a] ?? 0, WHOLE_RANK[b] ?? 0);
  const top = [a, b].filter((type) => (WHOLE_RANK[type] ?? 0) === rank);
  for (const signed of ["i64", "isize", "i32", "i16", "i8"]) {
    if (top.includes(signed as PrimitiveTypeName)) return signed as PrimitiveTypeName;
  }
  for (const unsigned of ["usize", "u64", "u32", "u16", "u8"]) {
    if (top.includes(unsigned as PrimitiveTypeName)) return unsigned as PrimitiveTypeName;
  }
  return "i64";
}

/** True when a number written in the source is a whole number. */
function isWholeLiteral(text: string): boolean {
  return /^[+-]?\d+$/.test(text) || /^[+-]?0[xX][0-9a-fA-F]+$/.test(text);
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
export function isStringValue(value: ResolvedValue): boolean {
  switch (value.k) {
    case "text":
      return true;
    case "reference":
      return value.binding.kind === "string";
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
export function typeOfValue(value: ResolvedValue): TypeExpr | null {
  switch (value.k) {
    case "literal":
      return value.binding.type === null ? null : { kind: "primitive", name: value.binding.type };
    case "buffer":
      return { kind: "slice", of: { kind: "primitive", name: value.binding.element ?? "f64" } };
    case "reference":
      if (value.binding.kind === "string") return null;
      if (value.binding.kind === "buffer") {
        return { kind: "slice", of: { kind: "primitive", name: value.binding.element ?? "f64" } };
      }
      if (value.binding.kind === "reference") return value.binding.type;
      return { kind: "primitive", name: value.binding.type ?? "f64" };
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
      return { kind: "primitive", name: "bool" };
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
 * The type two numbers are compared at. One whole number and one written
 * literal are compared as whole numbers, which is exact; anything else is
 * compared as the double the language compares them as.
 */
export function commonNumber(left: TypeExpr | null, right: TypeExpr | null): TypeExpr | null {
  const a = primitive(left);
  const b = primitive(right);
  // A number no use has fixed is a double, and takes the type of the side it
  // is compared with, so a whole number is not compared as a double.
  if (a === null && b === null) return null;
  if (a === null) return NUMERIC.includes(b as PrimitiveTypeName) ? right : null;
  if (b === null) return NUMERIC.includes(a) ? left : null;
  if (!NUMERIC.includes(a) || !NUMERIC.includes(b)) return null;
  return a === b ? left : numeric(numericResult(a, b, false));
}

/** Every exported function of the program, by name. */
function signaturesOf(program: ProgramContract): Map<string, FunctionSignature> {
  const signatures = new Map<string, FunctionSignature>();
  for (const file of program.files) {
    for (const [name, contract] of Object.entries(file.functions)) signatures.set(name, contract.function);
  }
  return signatures;
}

/** The operators that hold or do not, rather than compute. */
export const COMPARISON_OPERATORS: readonly ProgramBinaryOp[] = ["<", "<=", ">", ">="];

/** The operators only whole numbers have. */
const WHOLE_OPERATORS: readonly ProgramBinaryOp[] = ["%", "<<", ">>", "&", "|", "^"];
/** The compound assignments only whole numbers have. */
const WHOLE_ASSIGNMENTS: readonly ProgramAssignOp[] = ["%="];
const EQUALITY: readonly ProgramBinaryOp[] = ["===", "!==", "==", "!="];

const LOGICAL: readonly ProgramBinaryOp[] = ["&&", "||", "??"];

/* -------------------------------------------------------------------------- */
/* Resolver                                                                   */
/* -------------------------------------------------------------------------- */

class ProgramResolver {
  private readonly scopes: Map<string, Binding>[] = [new Map()];
  private readonly used = new Set<string>();
  private readonly body: ProgramBody;
  private readonly signatures: Map<string, FunctionSignature>;
  private readonly objects: Record<string, ObjectLayout>;
  /** A buffer another name was given, and the buffer it is the same array as. */
  private readonly aliases: [BufferBinding, BufferBinding][] = [];
  /** How many loops the statement being resolved is written in. */
  private loops = 0;

  constructor(body: ProgramBody, signatures: Map<string, FunctionSignature>, objects: Record<string, ObjectLayout>) {
    this.body = body;
    this.signatures = signatures;
    this.objects = objects;
  }

  resolve(): ResolvedProgram {
    const statements = this.statements(this.body.statements);
    return {
      file: this.body.file,
      statements,
      functions: [...this.signatures.values()],
      objects: this.objects,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Scopes                                                                  */
  /* ---------------------------------------------------------------------- */

  /** The name the driver declares a source name under: unique per declaration. */
  private unique(name: string): string {
    let candidate = name;
    for (let index = 2; this.used.has(candidate); index += 1) candidate = `${name}_${index}`;
    this.used.add(candidate);
    return candidate;
  }

  private lookup(name: string): Binding | undefined {
    for (let index = this.scopes.length - 1; index >= 0; index -= 1) {
      const binding = this.scopes[index].get(name);
      if (binding !== undefined) return binding;
    }
    return undefined;
  }

  private binding(name: string, line: number): Binding {
    const binding = this.lookup(name);
    if (binding === undefined) {
      throw programError(
        `"${name}" is not declared`,
        this.body,
        line,
        `${this.body.file}: a program declares a value with const or let before it uses it`,
      );
    }
    return binding;
  }

  private declareBinding(name: string, line: number, binding: WithoutName<Binding>): Binding {
    if (this.scopes[this.scopes.length - 1].has(name)) {
      throw programError(`"${name}" is declared twice in the same block`, this.body, line);
    }
    const declared = { ...binding, name: this.unique(name) } as Binding;
    this.scopes[this.scopes.length - 1].set(name, declared);
    return declared;
  }

  private open(): void {
    this.scopes.push(new Map());
  }

  private close(): void {
    this.scopes.pop();
  }

  private mutable(binding: Binding, name: string, line: number): void {
    if (!binding.mutable) {
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

  private statements(list: readonly ProgramStatement[]): ResolvedStatement[] {
    return list.map((statement) => this.statement(statement));
  }

  private block(body: ProgramStatement[]): ResolvedStatement[] {
    this.open();
    const resolved = this.statements(body);
    this.close();
    return resolved;
  }

  private statement(statement: ProgramStatement): ResolvedStatement {
    switch (statement.kind) {
      case "declare":
        return this.declaration(statement);
      case "assign":
        return this.assignment(statement);
      case "elementAssign":
        return this.elementAssignment(statement);
      case "update": {
        const binding = this.binding(statement.name, statement.line);
        this.mutable(binding, statement.name, statement.line);
        if (binding.kind !== "scalar" && binding.kind !== "string") {
          throw programError(`"${statement.name}" is not a number`, this.body, statement.line);
        }
        if (binding.kind === "string") {
          throw programError(`"${statement.name}" is a string`, this.body, statement.line, `line ${statement.line} of ${this.body.file}: only a number goes up and down`);
        }
        return {
          kind: "update",
          name: binding.name,
          op: statement.op,
          prefix: statement.prefix,
          type: { kind: "primitive", name: binding.type ?? "f64" },
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
        // A driver writes these as the C and Nim statements they are, and
        // neither of them means anything outside a loop.
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

  private declaration(statement: ProgramStatement & { kind: "declare" }): ResolvedStatement {
    const annotation = statement.type === null ? null : this.annotation(statement.type, statement.line);
    const value = this.value(statement.value, annotation, statement.line);
    const mutable = statement.mutable;
    // A declaration names the variable the driver declares, and the value is
    // written as it stands: what it is, the emitter reads off the binding.
    const declare = (binding: WithoutName<Binding>): ResolvedStatement => {
      const declared = this.declareBinding(statement.name, statement.line, binding);
      return { kind: "declare", name: declared.name, binding: declared, value, line: statement.line };
    };
    switch (value.k) {
      case "buffer":
        return declare({
          kind: "buffer",
          mutable,
          element: annotation === null ? null : elementOf(annotation),
          length: value.binding.length,
          values: value.binding.values,
        });
      case "text": {
        const written = value.parts
          .filter((part) => part.k === "text")
          .map((part) => part.value)
          .join("");
        return declare({
          kind: "string",
          mutable,
          value: value.parts.every((part) => part.k === "text") ? written : null,
        });
      }
      case "reference": {
        const held = value.binding;
        if (held.kind === "scalar") {
          return declare({ kind: "scalar", mutable, type: held.type, text: held.text });
        }
        if (held.kind === "buffer") {
          const alias: BufferBinding = {
            kind: "buffer",
            name: "",
            mutable,
            element: held.element,
            length: held.length,
            values: [],
          };
          const named = this.declareBinding(statement.name, statement.line, alias);
          this.aliases.push([named as BufferBinding, held]);
          return { kind: "declare", name: named.name, binding: named, value, line: statement.line };
        }
        if (held.kind === "string") return declare({ kind: "string", mutable, value: held.value });
        return declare({ kind: "reference", mutable, type: held.type });
      }
      case "null":
        return declare({ kind: "reference", mutable, type: { kind: "ref", of: null } });
      case "boolean":
        return declare({ kind: "scalar", mutable, type: "bool", text: value.value ? "true" : "false" });
      case "length":
        return declare({ kind: "scalar", mutable, type: value.type, text: "" });
      case "stringLength":
        return declare({ kind: "scalar", mutable, type: "usize", text: "" });
      case "element":
        return declare({ kind: "scalar", mutable, type: value.type, text: "" });
      case "literal":
        return declare({ kind: "scalar", mutable, type: value.binding.type, text: value.binding.text });
      case "compare":
      case "isNull":
        return declare({ kind: "scalar", mutable, type: "bool", text: "" });
      case "call": {
        const returns = primitive(value.call.returns);
        if (returns !== null) return declare({ kind: "scalar", mutable, type: returns, text: "" });
        if (value.call.returns.kind === "ref") {
          return declare({ kind: "reference", mutable, type: value.call.returns });
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
        if (type === null) return declare({ kind: "string", mutable, value: null });
        const name = primitive(type);
        if (name === null || !NUMERIC.includes(name)) {
          throw programError(
            `a program cannot hold ${typeToString(type)}`,
            this.body,
            statement.line,
            `line ${statement.line} of ${this.body.file}: a program holds numbers, strings and references`,
          );
        }
        return declare({ kind: "scalar", mutable, type: name, text: "" });
      }
    }
  }

  private assignment(statement: ProgramStatement & { kind: "assign" }): ResolvedStatement {
    const binding = this.binding(statement.name, statement.line);
    this.mutable(binding, statement.name, statement.line);
    if (binding.kind === "buffer") {
      throw programError(
        `"${statement.name}" is a buffer`,
        this.body,
        statement.line,
        `line ${statement.line} of ${this.body.file}: write an element of it, as in ${statement.name}[0] = 0`,
      );
    }
    if (binding.kind === "reference") {
      throw programError(
        `"${statement.name}" is a reference to an object`,
        this.body,
        statement.line,
        `line ${statement.line} of ${this.body.file}: a program reads what a function returned`,
      );
    }
    if (binding.kind === "string") {
      const written = this.value(statement.value, null, statement.line);
      // A number written into a string becomes its text, as `s += 1` does in
      // the language, rather than an error the source does not raise.
      const value = isStringValue(written) ? written : { k: "text" as const, parts: [{ k: "value" as const, value: written }] };
      return { kind: "assign", name: binding.name, op: statement.op, value, type: null, line: statement.line };
    }
    const name = binding.type ?? "f64";
    // A compound assignment writes its operator down on the C type of the
    // name, so `%=` on a double is C no compiler accepts. The operator
    // decides what the name may be, as it does in a binary expression, where
    // a whole operator needs whole numbers.
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
      name: binding.name,
      op: statement.op,
      value: this.value(statement.value, type, statement.line),
      type,
      line: statement.line,
    };
  }

  private elementAssignment(statement: ProgramStatement & { kind: "elementAssign" }): ResolvedStatement {
    const binding = this.binding(statement.buffer, statement.line);
    // Writing an element writes the array, not the name: a name declared with
    // const still names an array the program may change.
    if (binding.kind !== "buffer") {
      throw programError(`"${statement.buffer}" is not a buffer`, this.body, statement.line, `line ${statement.line} of ${this.body.file}: only an array has elements`);
    }
    const element = binding.element ?? "f64";
    binding.element ??= element;
    const type = numeric(element);
    const index = this.value(statement.index, numeric("usize"), statement.line);
    this.within(index, binding, statement.line);
    return {
      kind: "elementAssign",
      buffer: binding.name,
      index,
      op: statement.op,
      value: this.value(statement.value, type, statement.line),
      type,
      line: statement.line,
    };
  }

  private counted(statement: ProgramStatement & { kind: "for" }): ResolvedStatement {
    const bound = this.value(statement.to, null, statement.line);
    const boundType = primitive(typeOfValue(bound) ?? numeric("f64")) ?? "f64";
    // The step decides what the index is. A loop that moves by whole numbers
    // counts with a whole number whatever the bound is, because the index only
    // ever takes whole values: a program cannot tell the two apart, and a
    // whole number is what an array is indexed with.
    const written = statement.step === null ? null : this.value(statement.step, null, statement.line);
    const stepIsWhole =
      written === null ||
      (written.k === "literal" &&
        (isWholeLiteral(written.binding.text) || (written.binding.type !== null && isWhole(written.binding.type))));
    // An index that moves by fractions counts in fractions, whatever the bound
    // is: a whole index would add a half to nothing and stand still.
    const whole = isWhole(boundType) && stepIsWhole;
    // The index takes the width of the bound it counts to, which is what
    // `wholeOf` settles between two whole numbers. It is not arithmetic on a
    // number in the source, which is a double, so the rule that makes
    // `length - 10` a double does not reach it.
    const counted = whole ? wholeOf(boundType, boundType) : stepIsWhole ? "i64" : "f64";
    const type = numeric(statement.down && counted.startsWith("u") ? "i64" : counted);
    const from = this.value(statement.from, type, statement.line);
    const to = this.value(statement.to, type, statement.line);
    const step = written === null ? null : this.value(statement.step as ProgramValue, type, statement.line);
    this.open();
    const variable = this.declareBinding(statement.variable, statement.line, {
      kind: "scalar",
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
  private looped(body: ProgramStatement[]): ResolvedStatement[] {
    this.loops += 1;
    const resolved = this.statements(body);
    this.loops -= 1;
    return resolved;
  }

  private each(statement: ProgramStatement & { kind: "forOf" }): ResolvedStatement {
    const buffer = this.binding(statement.of, statement.line);
    if (buffer.kind !== "buffer") {
      throw programError(
        `"${statement.of}" is not a buffer`,
        this.body,
        statement.line,
        `line ${statement.line} of ${this.body.file}: a program walks the arrays it allocated`,
      );
    }
    const element = buffer.element ?? "f64";
    buffer.element ??= element;
    this.open();
    const variable = this.declareBinding(statement.variable, statement.line, {
      kind: "scalar",
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
      of: buffer.name,
      length: { k: "length", buffer: buffer.name, type: "usize" },
      body,
      line: statement.line,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Values                                                                  */
  /* ---------------------------------------------------------------------- */

  /** A condition: the truth of a value, which need not be a boolean. */
  private condition(value: ProgramValue, line: number): ResolvedValue {
    const resolved = this.value(value, null, line);
    if (resolved.k === "compare" || resolved.k === "isNull" || resolved.k === "boolean") return resolved;
    return resolved;
  }

  private value(value: ProgramValue, expect: TypeExpr | null, line: number): ResolvedValue {
    switch (value.k) {
      case "number": {
        const binding: ScalarBinding = { kind: "scalar", name: "", mutable: false, type: null, text: value.text };
        if (expect !== null && primitive(expect) !== null) this.expectNumber(expect, binding, line);
        return { k: "literal", binding };
      }
      case "bigint":
        return { k: "literal", binding: { kind: "scalar", name: "", mutable: false, type: "i64", text: value.text } };
      case "boolean":
        return { k: "boolean", value: value.value };
      case "null":
        return { k: "null" };
      case "buffer": {
        const binding: BufferBinding = {
          kind: "buffer",
          name: "",
          mutable: false,
          element: null,
          length: value.values.length,
          // The elements take the type of the array they are written into,
          // which a use of the array fixes.
          values: value.values.map((element) => this.value(element, null, line)),
        };
        if (expect !== null) this.expectBuffer(expect, binding, line);
        return { k: "buffer", binding };
      }
      case "text":
        return { k: "text", parts: this.parts(value.parts, line) };
      case "name": {
        // A buffer is used at one element type, whichever name it is passed by.
        const held = this.binding(value.name, line);
        if (held.kind === "buffer" && expect !== null) this.expectBuffer(expect, held, line);
        return this.reference(value.name, line);
      }
      case "length": {
        const binding = this.binding(value.of, line);
        if (binding.kind === "string") {
          return { k: "stringLength", of: { k: "reference", name: binding.name, binding } };
        }
        if (binding.kind !== "buffer") {
          throw programError(
            `"${value.of}" has no length`,
            this.body,
            line,
            `${this.body.file}: a length belongs to an array or a string`,
          );
        }
        if (expect !== null && primitive(expect) !== "usize") {
          this.coerce("a length", { kind: "primitive", name: "usize" }, expect, line);
        }
        return { k: "length", buffer: binding.name, type: "usize" };
      }
      case "element": {
        const binding = this.binding(value.buffer, line);
        if (binding.kind !== "buffer") {
          throw programError(
            `"${value.buffer}" is not a buffer`,
            this.body,
            line,
            `${this.body.file}: only an array has elements`,
          );
        }
        const element = binding.element ?? "f64";
        binding.element ??= element;
        const index = this.value(value.index, numeric("usize"), line);
        this.within(index, binding, line);
        if (expect !== null) {
          this.coerce(`an element of ${value.buffer}`, { kind: "primitive", name: element }, expect, line);
        }
        return { k: "element", buffer: binding.name, index, type: element };
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

  private reference(name: string, line: number): ResolvedValue {
    const binding = this.binding(name, line);
    return { k: "reference", name: binding.name, binding };
  }

  private parts(parts: ProgramText[], line: number): ResolvedTextPart[] {
    return parts.map((part) =>
      part.k === "text"
        ? { k: "text" as const, value: part.value }
        : { k: "value" as const, value: this.value(part.value, null, line) },
    );
  }

  private unary(value: ProgramValue & { k: "unary" }, line: number): ResolvedValue {
    if (value.op === "-" || value.op === "+") {
      // A number written with its sign is one literal, so a use can still fix
      // its type without a conversion in the driver.
      if (value.operand.k === "number") {
        const text = value.op === "-" ? `-${value.operand.text}` : value.operand.text;
        return { k: "literal", binding: { kind: "scalar", name: "", mutable: false, type: null, text } };
      }
      if (value.op === "+") return this.value(value.operand, null, line);
    }
    const operand = this.value(value.operand, null, line);
    if (value.op === "!") {
      if (isStringValue(operand)) {
        return { k: "compare", how: "string", negate: true, left: operand, right: { k: "text", parts: [{ k: "text", value: "" }] } };
      }
      return { k: "unary", op: "!", operand, type: { kind: "primitive", name: "bool" } };
    }
    // `~` inverts a whole number bit by bit, and a number written in the source
    // is whole here because it is written without a point.
    if (value.op === "~") {
      // Inverting a number gives a signed one, as it does in the language: the
      // bits of 3 inverted are -4, and not a very large unsigned number.
      const name = primitive(typeOfValue(operand));
      if (name !== null && !isWhole(name)) throw programError("~ needs a whole number", this.body, line);
      return { k: "unary", op: value.op, operand, type: numeric("i64") };
    }
    const type = primitive(typeOfValue(operand)) ?? "f64";
    return { k: "unary", op: value.op, operand, type: numeric(type) };
  }

  private binary(value: ProgramValue & { k: "binary" }, expect: TypeExpr | null, line: number): ResolvedValue {
    const op = value.op;
    if (LOGICAL.includes(op)) {
      // `a && b` is `b` when `a` holds, so the arms have a type of their own.
      const left = this.condition(value.left, line);
      const right = this.value(value.right, op === "??" ? null : expect, line);
      // `a ?? b` is `b` when `a` is nothing, so it has the type of whichever
      // arm holds; a number no use has fixed is a double, as it is written.
      const type =
        op === "??"
          ? isStringValue(left) || isStringValue(right)
            ? null
            : (typeOfValue(left) ?? typeOfValue(right) ?? numeric("f64"))
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
    const right = this.value(value.right, left.k === "literal" ? typeOfValue(left) : null, line);
    if (op === "+" && (isStringValue(left) || isStringValue(right))) {
      if (!isStringValue(left) || !isStringValue(right)) {
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
    if (isStringValue(left) || isStringValue(right)) {
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
        const name = primitive(typeOfValue(side));
        const written = side.k === "literal" ? side.binding.text : null;
        if (name === null && (written === null || isWholeLiteral(written))) continue;
        if (name !== null && isWhole(name)) continue;
        throw programError(
          `"${op}" needs whole numbers`,
          this.body,
          line,
          `line ${line} of ${this.body.file}: ${what} is ${
            name === null && written !== null ? `the value ${written}` : `a ${typeToString(typeOfValue(side) ?? numeric("f64"))}`
          }, and "${op}" rounds it to a whole number`,
        );
      }
    }
    const leftName = primitive(typeOfValue(left));
    const rightName = primitive(typeOfValue(right));
    // A comparison holds or it does not. A whole operator needs whole numbers
    // and yields one, whatever the literals it was written with: `7 % 3` is 1.
    const whole = WHOLE_OPERATORS.includes(op);
    const type = COMPARISON_OPERATORS.includes(op)
      ? numeric("bool")
      : numeric(
          numericResult(
            whole ? (leftName ?? "i64") : leftName,
            whole ? (rightName ?? "i64") : rightName,
            op === "/",
          ),
        );
    return { k: "binary", op, left, right, type };
  }

  private equality(
    op: ProgramBinaryOp,
    left: ResolvedValue,
    right: ResolvedValue,
    line: number,
  ): { k: "compare"; how: "number" | "string"; negate: boolean; left: ResolvedValue; right: ResolvedValue } | { k: "isNull"; operand: ResolvedValue; negate: boolean } | { k: "boolean"; value: boolean } {
    if (left.k === "null" && right.k === "null") {
      return { k: "isNull", operand: left, negate: op === "!==" || op === "!=" };
    }
    if (right.k === "null") {
      if (typeOfValue(left) === null || isStringValue(left)) {
        throw programError("a string is never null", this.body, line, `line ${line} of ${this.body.file}: a string is as long as it is`);
      }
      return { k: "isNull", operand: left, negate: op === "!==" || op === "!=" };
    }
    if (left.k === "null") {
      if (typeOfValue(right) === null || isStringValue(right)) {
        throw programError("a string is never null", this.body, line, `line ${line} of ${this.body.file}: a string is as long as it is`);
      }
      return { k: "isNull", operand: right, negate: op === "!==" || op === "!=" };
    }
    // `==` compares across types, as it does in the language: a number is the
    // text of a number. `===` is false when the two are of different types.
    const loose = op === "==" || op === "!=";
    const stringSide = isStringValue(left) || isStringValue(right);
    if (stringSide) {
      if (!loose && !(isStringValue(left) && isStringValue(right))) {
        // A string is never the number it is compared with, so the answer is
        // known here rather than in the driver, which cannot compare them.
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
  private asText(value: ResolvedValue): ResolvedValue {
    if (isStringValue(value)) return value;
    return { k: "text", parts: [{ k: "value", value }] };
  }

  private asNumber(value: ResolvedValue, line: number): ResolvedValue {
    if (isStringValue(value) || value.k === "null") {
      throw programError("a number is needed", this.body, line);
    }
    return value;
  }

  /** The type two values of one expression have in common. */
  private common(left: ResolvedValue, right: ResolvedValue, line: number): TypeExpr | null {
    const a = typeOfValue(left);
    const b = typeOfValue(right);
    // Two numbers no use has fixed are doubles, as they are written; two
    // strings are text, and have no type at all.
    if (a === null && b === null) return isStringValue(left) || isStringValue(right) ? null : numeric("f64");
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

  private call(value: ProgramValue & { k: "call" }, line: number): ResolvedCall {
    const builtin = BUILTINS[value.function];
    if (builtin !== undefined) {
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
        builtin: true,
      };
    }
    const signature = this.signatures.get(value.function);
    if (signature === undefined) {
      const compiled = [...this.signatures.keys()];
      throw programError(
        `"${value.function}" is not a function of this program`,
        this.body,
        line,
        `the program compiles ${compiled.join(", ") || "no functions"}; a program calls the functions the program exports`,
      );
    }
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
      builtin: false,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Uses                                                                    */
  /* ---------------------------------------------------------------------- */

  /** A number is used at one type; the driver declares it that way. */
  private expectNumber(expect: TypeExpr, binding: ScalarBinding, line: number): void {
    const wanted = primitive(expect);
    if (wanted === null || !NUMERIC.includes(wanted)) {
      throw programError(
        `a number cannot be used as ${typeToString(expect)}`,
        this.body,
        line,
        `line ${line} of ${this.body.file}: a number goes to a numeric parameter, and a buffer parameter takes an array`,
      );
    }
    if (binding.type !== null && binding.type !== wanted) {
      throw programError(
        `the value ${binding.text} is used as ${typeToString({ kind: "primitive", name: binding.type })} and as ${typeToString(expect)}`,
        this.body,
        line,
        `line ${line} of ${this.body.file}: one value in a program has one type`,
      );
    }
    binding.type = wanted;
  }

  /** A buffer is used at one element type, and at a length a parameter fixes. */
  private expectBuffer(expect: TypeExpr, binding: BufferBinding, line: number): void {
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
      // An alias names the same array, so the driver writes one array down.
      // Every name for it takes the element type, or the call would read the
      // same bytes as a type the array was never written at.
      const group = this.aliased(binding);
      const fixed = group.find((member) => member.element !== null && member.element !== wanted);
      if (fixed !== undefined) {
        throw programError(
          `an array of ${fixed.element} is used where ${wanted} is expected`,
          this.body,
          line,
          `line ${line} of this.body.file: allocate the array with the element type the parameter takes`,
        );
      }
      for (const member of group) member.element = wanted;
    }
    if (expect.kind === "array" && expect.length !== null && expect.length !== binding.length) {
      throw programError(
        `an array of ${binding.length} element(s) is used where ${expect.length} is expected`,
        this.body,
        line,
        `line ${line} of ${this.body.file}: a parameter with a fixed length takes an array of exactly that length`,
      );
    }
  }

  /**
   * The buffers that are one array: the binding itself, every name given for
   * it and every array those names are the same as.
   */
  private aliased(binding: BufferBinding): BufferBinding[] {
    const group = new Set<BufferBinding>([binding]);
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
  private within(index: ResolvedValue, binding: BufferBinding, line: number): void {
    if (index.k !== "literal" || !isWholeLiteral(index.binding.text)) return;
    const at = BigInt(index.binding.text);
    if (at < 0n || at >= BigInt(binding.length)) {
      throw programError(
        `${binding.name}[${index.binding.text}] is outside the array`,
        this.body,
        line,
        `line ${line} of ${this.body.file}: ${binding.name} holds ${binding.length} element(s), 0 to ${binding.length - 1}`,
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

  /** A buffer has no printed form, so it may not reach a console.log. */
  private assertPrintable(value: ResolvedValue, line: number): void {
    if (value.k === "text") {
      for (const part of value.parts) {
        if (part.k === "value") this.assertPrintable(part.value, line);
      }
      return;
    }
    if (value.k === "null") return;
    if (isStringValue(value)) return;
    // A number and a truth are what a console.log prints, however they were
    // computed: a value of a primitive type is one of them, and a literal is a
    // number no use has fixed the type of yet.
    if (value.k === "literal" || typeOfValue(value)?.kind === "primitive") return;
    const held = value.k === "buffer" || (value.k === "reference" && value.binding.kind === "buffer");
    if (held) {
      throw programError(
        "a program cannot print a buffer",
        this.body,
        line,
        `line ${line} of ${this.body.file}: print a number, or a string that interpolates one`,
      );
    }
    if (value.k === "reference" && value.binding.kind === "reference") {
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

/**
 * Resolves the statements of a program against the contracts of the program it
 * calls. A driver emitter needs no further context: every name, type and
 * signature it writes down is fixed here.
 */
export function resolveProgram(body: ProgramBody, program: ProgramContract): ResolvedProgram {
  const objects: Record<string, ObjectLayout> = {};
  for (const file of program.files) {
    for (const contract of Object.values(file.functions)) {
      Object.assign(objects, contract.definition?.objects ?? {});
    }
  }
  return new ProgramResolver(body, signaturesOf(program), objects).resolve();
}

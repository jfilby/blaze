/**
 * Resolving a program.
 *
 * The contract phase hands back the statements of a program exactly as the
 * frontend parsed them: names, literals and calls, with no types. This module
 * turns them into a program the driver emitters can write down, by resolving
 * every call against the program contract and every value against the type it
 * is used at.
 *
 * A program is driven, not interpreted, so the value language is deliberately
 * small: buffers the program allocates from literals, numbers, strings built
 * from a template, and calls to the functions the program exports. Anything
 * else is refused here, naming the file and line it was written on.
 *
 * ## Numbers
 *
 * A program prints numbers the way the language it was written in prints them,
 * because the build compares the program's output against the output of the
 * source running on its own toolchain. Both drivers therefore format a number
 * the way `Number::toString` does:
 *
 *   - zero prints as `0`, and a negative zero as `0`
 *   - the digits are the shortest decimal that reads back as the same double
 *   - a value with an exponent from -6 up to 20 is written in full
 *     (`0.00001`, `123456789012345680000`), and anything outside that range in
 *     exponential form (`1e-7`, `1e+21`)
 *   - a negative value carries a leading `-`
 *
 * Integers keep their integral form (`70`, not `70.0`), which is what a length
 * or a count prints as.
 */

import { parseType, typeToString } from "../semantics/contract.ts";
import { CompilerError } from "../core/errors.ts";
import type { ProgramBody, ProgramStatement, ProgramText, ProgramValue } from "../semantics/module.ts";
import type { FunctionSignature, PrimitiveTypeName, ProgramContract, TypeExpr } from "../core/types.ts";

/**
 * What a declared name holds. The same object is shared with the statement
 * that declares it, so a type fixed by a later use is the type the driver
 * declares it with.
 */
export type Binding =
  | { kind: "buffer"; element: PrimitiveTypeName | null; length: number; values: string[] }
  | { kind: "scalar"; type: PrimitiveTypeName | null; text: string }
  | { kind: "string"; value: string };

/** A call to a function the program compiled, with every argument placed. */
export interface ResolvedCall {
  name: string;
  signature: FunctionSignature;
  args: ResolvedValue[];
  returns: TypeExpr;
}

/** A value the driver can write down. */
export type ResolvedValue =
  /** A number literal, of the type it is used at. */
  | { k: "literal"; binding: Extract<Binding, { kind: "scalar" }> }
  /** A typed array literal, of the element type it is used at. */
  | { k: "buffer"; binding: Extract<Binding, { kind: "buffer" }> }
  /** A value the program declared, read by name. */
  | { k: "reference"; name: string; binding: Binding }
  /** A string the program builds. */
  | { k: "text"; parts: ResolvedTextPart[] }
  /** The result of a compiled function. */
  | { k: "call"; call: ResolvedCall }
  /** The length of a buffer. */
  | { k: "length"; buffer: string; type: PrimitiveTypeName }
  /** One element of a buffer. */
  | { k: "element"; buffer: string; index: ResolvedValue; type: PrimitiveTypeName };

export type ResolvedTextPart = { k: "text"; value: string } | { k: "value"; value: ResolvedValue };

export type ResolvedStatement =
  | { kind: "declare"; name: string; value: ResolvedValue; line: number }
  | { kind: "print"; value: ResolvedValue; line: number };

/** A program with every name and type resolved, ready to be written down. */
export interface ResolvedProgram {
  /** The entry module the statements were written in. */
  file: string;
  statements: ResolvedStatement[];
  /** Every function of the program: what the driver declares and links. */
  functions: FunctionSignature[];
}

const NUMERIC: readonly PrimitiveTypeName[] = ["i8", "i16", "i32", "i64", "u8", "u16", "u32", "u64", "f32", "f64", "usize", "isize"];

function programError(message: string, body: ProgramBody, line: number, detail?: string): CompilerError {
  return new CompilerError({
    category: "ContractError",
    stage: "program",
    message,
    detail: detail ?? (line === 0 ? body.file : `line ${line} of ${body.file}`),
  });
}

function primitive(type: TypeExpr): PrimitiveTypeName | null {
  return type.kind === "primitive" ? type.name : null;
}

function elementOf(type: TypeExpr): PrimitiveTypeName | null {
  return type.kind === "ptr" || type.kind === "slice" || type.kind === "array" ? primitive(type.of) : null;
}

function isBufferType(type: TypeExpr): boolean {
  return type.kind === "ptr" || type.kind === "slice" || type.kind === "array";
}

/** The type a resolved value has, or null when it is a string. */
export function typeOfValue(value: ResolvedValue): TypeExpr | null {
  switch (value.k) {
    case "literal":
      return { kind: "primitive", name: value.binding.type ?? "f64" };
    case "buffer":
      return { kind: "slice", of: { kind: "primitive", name: value.binding.element ?? "f64" } };
    case "reference":
      if (value.binding.kind === "string") return null;
      if (value.binding.kind === "buffer") {
        return { kind: "slice", of: { kind: "primitive", name: value.binding.element ?? "f64" } };
      }
      return { kind: "primitive", name: value.binding.type ?? "f64" };
    case "text":
      return null;
    case "call":
      return value.call.returns;
    case "length":
      return { kind: "primitive", name: value.type };
    case "element":
      return { kind: "primitive", name: value.type };
  }
}

/** Every exported function of the program, by name. */
function signaturesOf(program: ProgramContract): Map<string, FunctionSignature> {
  const signatures = new Map<string, FunctionSignature>();
  for (const file of program.files) {
    for (const [name, contract] of Object.entries(file.functions)) signatures.set(name, contract.function);
  }
  return signatures;
}

class ProgramResolver {
  private readonly bindings = new Map<string, Binding>();
  private readonly body: ProgramBody;
  private readonly signatures: Map<string, FunctionSignature>;

  constructor(body: ProgramBody, signatures: Map<string, FunctionSignature>) {
    this.body = body;
    this.signatures = signatures;
  }

  resolve(): ResolvedProgram {
    const statements = this.body.statements.map((statement) => this.statement(statement));
    // A value the program never uses has no use to fix its type, so the
    // driver's own default stands.
    for (const binding of this.bindings.values()) {
      if (binding.kind === "buffer") binding.element ??= "f64";
      if (binding.kind === "scalar") binding.type ??= "f64";
    }
    return { file: this.body.file, statements, functions: [...this.signatures.values()] };
  }

  private statement(statement: ProgramStatement): ResolvedStatement {
    if (statement.kind === "print") {
      const value = this.value(statement.value, null, statement.line);
      this.assertPrintable(value, statement.line);
      return { kind: "print", value, line: statement.line };
    }
    if (this.bindings.has(statement.name)) {
      throw programError(`"${statement.name}" is declared twice`, this.body, statement.line);
    }
    const value = this.value(statement.value, null, statement.line);
    if (value.k === "literal") {
      this.bindings.set(statement.name, value.binding);
    } else if (value.k === "buffer") {
      this.bindings.set(statement.name, value.binding);
    } else if (value.k === "text") {
      const parts = value.parts.filter((part) => part.k === "value");
      if (parts.length > 0) {
        throw programError(
          `"${statement.name}" interpolates a value`,
          this.body,
          statement.line,
          `line ${statement.line} of ${this.body.file}: a program declares a string it writes out, and prints the values it builds`,
        );
      }
      this.bindings.set(statement.name, { kind: "string", value: value.parts.map((part) => part.value).join("") });
    } else if (value.k === "call") {
      const returns = primitive(value.call.returns);
      if (returns === null) {
        throw programError(
          `${value.call.name} returns ${typeToString(value.call.returns)}`,
          this.body,
          statement.line,
          `line ${statement.line} of ${this.body.file}: a program holds numbers, not buffers`,
        );
      }
      this.bindings.set(statement.name, { kind: "scalar", type: returns, text: "" });
    } else {
      // A name, a length or an element: the declaration holds what that holds.
      if (value.k === "reference") {
        this.bindings.set(statement.name, value.binding);
      } else if (value.k === "length") {
        this.bindings.set(statement.name, { kind: "scalar", type: value.type, text: "" });
      } else {
        this.bindings.set(statement.name, { kind: "scalar", type: value.type, text: "" });
      }
    }
    return { kind: "declare", name: statement.name, value, line: statement.line };
  }

  private value(value: ProgramValue, expect: TypeExpr | null, line: number): ResolvedValue {
    switch (value.k) {
      case "number": {
        const binding: Extract<Binding, { kind: "scalar" }> = { kind: "scalar", type: null, text: value.text };
        this.expectNumber(expect, binding, line);
        return { k: "literal", binding };
      }
      case "buffer": {
        const binding: Extract<Binding, { kind: "buffer" }> = {
          kind: "buffer",
          element: null,
          length: value.values.length,
          values: value.values,
        };
        this.expectBuffer(expect, binding, line);
        return { k: "buffer", binding };
      }
      case "text":
        return { k: "text", parts: this.parts(value.parts, line) };
      case "name":
        return this.reference(value);
      case "length": {
        const binding = this.binding(value.buffer, line);
        if (binding.kind !== "buffer") {
          throw programError(`"${value.buffer}" is not a buffer`, this.body, line, `${this.body.file}: only a buffer has a length`);
        }
        if (expect !== null && primitive(expect) !== "usize") {
          this.coerce("a length", { kind: "primitive", name: "usize" }, expect, line);
        }
        return { k: "length", buffer: value.buffer, type: "usize" };
      }
      case "element": {
        const binding = this.binding(value.buffer, line);
        if (binding.kind !== "buffer") {
          throw programError(`"${value.buffer}" is not a buffer`, this.body, line, `${this.body.file}: only a buffer has elements`);
        }
        const element = binding.element ?? "f64";
        binding.element ??= element;
        const index = this.value(value.index, { kind: "primitive", name: "usize" }, line);
        if (expect !== null) this.coerce(`an element of ${value.buffer}`, { kind: "primitive", name: element }, expect, line);
        return { k: "element", buffer: value.buffer, index, type: element };
      }
      case "call":
        return { k: "call", call: this.call(value, line) };
    }
  }

  private reference(value: ProgramValue & { k: "name" }): ResolvedValue {
    return { k: "reference", name: value.name, binding: this.binding(value.name, 0) };
  }

  private parts(parts: ProgramText[], line: number): ResolvedTextPart[] {
    return parts.map((part) =>
      part.k === "text" ? { k: "text" as const, value: part.value } : { k: "value" as const, value: this.value(part.value, null, line) },
    );
  }

  private call(value: ProgramValue & { k: "call" }, line: number): ResolvedCall {
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
      name: value.function,
      signature,
      args: value.args.map((arg, position) => this.value(arg, parseType(signature.params[position].type), line)),
      returns: parseType(signature.returns),
    };
  }

  private binding(name: string, line: number): Binding {
    const binding = this.bindings.get(name);
    if (binding === undefined) {
      throw programError(
        `"${name}" is not declared`,
        this.body,
        line,
        `${this.body.file}: a program declares a value with const before it uses it`,
      );
    }
    return binding;
  }

  /** A number is used at one type; the driver declares it that way. */
  private expectNumber(expect: TypeExpr | null, binding: Extract<Binding, { kind: "scalar" }>, line: number): void {
    if (expect === null) return;
    const wanted = primitive(expect);
    if (wanted === null || !NUMERIC.includes(wanted)) {
      throw programError(
        `a number cannot be passed as ${typeToString(expect)}`,
        this.body,
        line,
        `line ${line} of ${this.body.file}: a number goes to a numeric parameter, and a buffer parameter takes an array`,
      );
    }
    if (binding.type !== null && binding.type !== wanted) {
      throw programError(
        `"${binding.text}" is used as ${typeToString({ kind: "primitive", name: binding.type })} and as ${typeToString(expect)}`,
        this.body,
        line,
        `line ${line} of ${this.body.file}: one value in a program has one type`,
      );
    }
    binding.type = wanted;
  }

  /** A buffer is used at one element type, and at a length a parameter fixes. */
  private expectBuffer(expect: TypeExpr | null, binding: Extract<Binding, { kind: "buffer" }>, line: number): void {
    if (expect === null) return;
    if (!isBufferType(expect)) {
      throw programError(
        `a typed array cannot be passed as ${typeToString(expect)}`,
        this.body,
        line,
        `line ${line} of ${this.body.file}: a buffer parameter takes the array the program allocated`,
      );
    }
    const wanted = elementOf(expect);
    if (wanted !== null) {
      if (binding.element !== null && binding.element !== wanted) {
        throw programError(
          `an array of ${binding.element} is passed where ${wanted} is expected`,
          this.body,
          line,
          `line ${line} of ${this.body.file}: allocate the array with the element type the parameter takes`,
        );
      }
      binding.element = wanted;
    }
    if (expect.kind === "array" && expect.length !== null && expect.length !== binding.length) {
      throw programError(
        `an array of ${binding.length} element(s) is passed where ${expect.length} is expected`,
        this.body,
        line,
        `line ${line} of ${this.body.file}: a parameter with a fixed length takes an array of exactly that length`,
      );
    }
  }

  private coerce(what: string, from: TypeExpr, to: TypeExpr, line: number): void {
    const source = primitive(from);
    const target = primitive(to);
    if (source === null || target === null || NUMERIC.includes(source) === false || NUMERIC.includes(target) === false) {
      throw programError(`${what} cannot be passed as ${typeToString(to)}`, this.body, line);
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
    if (value.k === "reference" && value.binding.kind !== "buffer") return;
    if (value.k === "buffer" || (value.k === "reference" && value.binding.kind === "buffer")) {
      throw programError(
        "a program cannot print a buffer",
        this.body,
        line,
        `line ${line} of ${this.body.file}: print a number, or a string that interpolates one`,
      );
    }
    if (typeOfValue(value) === null) {
      throw programError(
        "a program prints a number or a string",
        this.body,
        line,
        `line ${line} of ${this.body.file}: a buffer has no printed form`,
      );
    }
  }
}

/**
 * Resolves the statements of a program against the contracts of the program it
 * calls. A driver emitter needs no further context: every name, type and
 * signature it writes down is fixed here.
 */
export function resolveProgram(body: ProgramBody, program: ProgramContract): ResolvedProgram {
  return new ProgramResolver(body, signaturesOf(program)).resolve();
}

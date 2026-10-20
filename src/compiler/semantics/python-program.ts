/**
 * Frontend: the statements a Python module runs.
 *
 * A module is either a library of functions or a program. This file reads the
 * program: the statements of the entry module, in the order they run. A
 * program is not contracted — the contract phase (see program.ts) keeps it as
 * the program and the driver the compiler emits runs it — so what is read here
 * is the source language, not anything a contract can state:
 *
 *   from helpers import dot
 *
 *   def main() -> int:
 *       a = [1.0, 2.0, 3.0]
 *       b = [4.0, 5.0, 6.0]
 *       print(dot(a, b))
 *       return 0
 *
 *   if __name__ == "__main__":
 *       main()
 *
 * The values a program holds are the program's own: a number, a text, a
 * boolean, a nothing, a name, a call, an element, a field, a list, a dict and
 * the operators over them.
 */

import type {
  ProgramAssignOp,
  ProgramBinaryOp,
  ProgramStatement,
  ProgramText,
  ProgramUnaryOp,
  ProgramValue,
} from "./module.ts";
import type { PrimitiveTypeName } from "../core/types.ts";
import type { PyStatement, PyTextPart, PyValue } from "./python.ts";
import { builtinName, conditionIsBoolean, describeValue } from "./python.ts";
import { frontendError } from "./diagnostics.ts";

/** The operators a program value may use, as Python writes them. */
const BINARY_OPERATORS: Record<string, ProgramBinaryOp> = {
  "+": "+",
  "-": "-",
  "*": "*",
  "/": "/",
  "//": "//",
  "%": "%",
  "==": "==",
  "!=": "!=",
  "<": "<",
  "<=": "<=",
  ">": ">",
  ">=": ">=",
  "and": "&&",
  "or": "||",
};

/** The operators a value may be written with, in front of it. */
const UNARY_OPERATORS: Record<string, ProgramUnaryOp> = {
  "-": "-",
  "+": "+",
  "~": "~",
  not: "!",
};

/** The compound assignments a name may be given. */
const ASSIGN_OPERATORS: Record<string, ProgramAssignOp> = {
  "+=": "+=",
  "-=": "-=",
  "*=": "*=",
  "/=": "/=",
  "//=": "//=",
  "%=": "%=",
};

/**
 * What the names a program body binds hold, as far as the body says.
 *
 * A dict is an object, and its fields are read by their key: `d["key"]` is a
 * field of the object the name holds, and not an element of a buffer. The
 * keys a dict holds are what says which of the two a read is, so they are
 * carried with the name.
 */
interface Bindings {
  /** The names that hold a dict, and the keys each of them holds. */
  readonly dicts: Map<string, Set<string>>;
}

/** The bindings of a program body that holds nothing yet. */
function noBindings(): Bindings {
  return { dicts: new Map() };
}

/**
 * A Python value, as the program model holds it.
 *
 * A whole number is a whole number of the program model: the kind a TypeScript
 * source writes `1n` for, which is the `i64` a Python `int` is. A fraction is
 * a number, which is a double.
 */
function programValue(one: PyValue, bindings: Bindings): ProgramValue {
  switch (one.k) {
    case "number":
      return one.whole ? { k: "whole", text: one.text } : { k: "number", text: one.text };
    case "text":
      return { k: "text", parts: text(one.parts, bindings) };
    case "boolean":
      return { k: "boolean", value: one.value };
    case "none":
      return { k: "null" };
    case "name":
      return { k: "name", name: one.name };
    case "call": {
      // `len(x)` is the length of the list or of the text `x` holds, and the
      // program model reads a length off the name it is written by.
      if (one.name === "len" && one.args.length === 1 && one.args[0].k === "name") {
        return { k: "length", of: one.args[0].name };
      }
      // The length of the command line is the length of the list of texts
      // Python holds, which is the file the program runs and the arguments it
      // was given.
      if (one.name === "len" && one.args.length === 1 && isSysArgv(one.args[0])) {
        return { k: "call", function: "argvLength", args: [] };
      }
      // The length of a text written out is the length of a name: the program
      // model reads a length off the name it is written by, and a text written
      // out is not one.
      if (one.name === "len" && one.args.length === 1) {
        throw frontendError(
          "the length of a value written out is not read",
          "write the value into a name and take the length of that, as in `s = 'hello'` and then `len(s)`",
        );
      }
      // `str(x)` is the text of the value, which the runtime writes.
      if (one.name === "str" && one.args.length === 1) {
        return { k: "text", parts: [{ k: "value", value: programValue(one.args[0], bindings) }] };
      }
      return { k: "call", function: builtinName(one.name), args: one.args.map((argument) => programValue(argument, bindings)) };
    }
    case "index": {
      // `sys.argv[i]` is the command line of the program: the compiler counts
      // the program and the file it runs before the arguments, and Python
      // counts the file alone, so the argument a Python program reads at `i`
      // is the one the compiler holds at `i + 1`.
      if (isSysArgv(one.base)) {
        return { k: "argv", index: programValue(one.index, bindings), offset: 1 };
      }
      // A dict is an object, and its fields are read by their key: `d["key"]`
      // is a field of the object the name holds, and not an element of a
      // buffer of numbers.
      if (one.base.k === "name" && one.index.k === "text") {
        const keys = bindings.dicts.get(one.base.name);
        if (keys !== undefined) {
          const key = textOf(one.index);
          if (key === null) {
            throw frontendError(
              "the key of a dict is written as it is",
              "a dict is read by the key it was written with, as in d[\"left\"]",
            );
          }
          if (!keys.has(key)) {
            throw frontendError(
              `the dict holds no key "${key}"`,
              `the keys it holds are ${[...keys].map((held) => `"${held}"`).join(", ")}`,
            );
          }
          return { k: "field", object: { k: "name", name: one.base.name }, field: key };
        }
      }
      if (one.base.k !== "name") {
        throw frontendError(
          `a program cannot read an element of ${describeValue(one.base)}`,
          "a list is read by its index, as in a[0]",
        );
      }
      return { k: "element", buffer: one.base.name, index: programValue(one.index, bindings) };
    }
    case "field": {
      // A dict has no fields: Python reads one by its key, and a field of it
      // is an attribute the language does not have.
      if (one.base.k === "name" && bindings.dicts.has(one.base.name)) {
        throw frontendError(
          "a dict is read by its key",
          `as in ${one.base.name}["${one.field}"], which is how Python reads a field of a dict`,
        );
      }
      return { k: "field", object: programValue(one.base, bindings), field: one.field };
    }
    case "list": {
      // A list written out is a buffer of the numbers it holds, and the width
      // of an element is what the list holds it at.
      const whole = one.items.every((item) => item.k === "number" && item.whole);
      const element: PrimitiveTypeName = whole ? "i64" : "f64";
      return { k: "buffer", element, values: one.items.map((item) => programValue(item, bindings)) };
    }
    case "dict":
      return { k: "object", fields: one.entries.map((entry) => ({ name: entry.name, value: programValue(entry.value, bindings) })) };
    case "binary": {
      const operator = BINARY_OPERATORS[one.op];
      if (operator === undefined) {
        throw frontendError(
          `"${one.op}" is not an operator a program has`,
          "the operators of a program are the arithmetic, the comparison and the logical ones",
        );
      }
      return { k: "binary", op: operator, left: programValue(one.left, bindings), right: programValue(one.right, bindings) };
    }
    case "unary": {
      const operator = UNARY_OPERATORS[one.op];
      if (operator === undefined) {
        throw frontendError(
          `"${one.op}" is not an operator a program has`,
          "the operators of a program are the arithmetic, the comparison and the logical ones",
        );
      }
      return { k: "unary", op: operator, operand: programValue(one.operand, bindings) };
    }
    case "conditional":
      return {
        k: "conditional",
        condition: programValue(one.condition, bindings),
        then: programValue(one.then, bindings),
        otherwise: programValue(one.otherwise, bindings),
      };
  }
}

/** The text of a value written as it is, or null when it is not one text. */
function textOf(value: PyValue): string | null {
  if (value.k !== "text") return null;
  if (value.parts.length !== 1) return null;
  const part = value.parts[0];
  return part.k === "text" ? part.value : null;
}

/** The parts of a string, as the program model holds them. */
function text(parts: readonly PyTextPart[], bindings: Bindings): ProgramText[] {
  return parts.map((part) =>
    part.k === "text" ? { k: "text", value: part.value } : { k: "value", value: programValue(part.value, bindings) },
  );
}

/**
 * A Python statement, as the program model holds it.
 */
function statement(one: PyStatement, bindings: Bindings): ProgramStatement {
  switch (one.k) {
    case "declare": {
      const value = programValue(one.value, bindings);
      bound(bindings, one.name, one.value);
      return {
        kind: "declare",
        name: one.name,
        mutable: true,
        type: null,
        value,
        line: one.line,
      };
    }
    case "assign": {
      const operator = ASSIGN_OPERATORS[one.op];
      if (operator === undefined) {
        throw frontendError(
          `"${one.op}" is not an assignment a program can make`,
          "a program assigns a name a value, as in `x = 1`",
        );
      }
      const value = programValue(one.value, bindings);
      bound(bindings, one.name, one.value);
      return { kind: "assign", name: one.name, op: operator, value, line: one.line };
    }
    case "return":
      return { kind: "result", value: programValue(one.value ?? { k: "none" }, bindings), line: one.line };
    case "if":
      conditionIsBoolean(one.condition, one.line);
      return {
        kind: "if",
        condition: programValue(one.condition, bindings),
        then: one.then.map((inside) => statement(inside, bindings)),
        otherwise: one.otherwise.map((inside) => statement(inside, bindings)),
        line: one.line,
      };
    case "while":
      conditionIsBoolean(one.condition, one.line);
      return {
        kind: "while",
        condition: programValue(one.condition, bindings),
        body: one.body.map((inside) => statement(inside, bindings)),
        line: one.line,
      };
    case "for":
      return {
        kind: "for",
        variable: one.variable,
        from: programValue(one.from, bindings),
        to: programValue(one.to, bindings),
        inclusive: false,
        down: false,
        type: null,
        step: one.step === null ? null : programValue(one.step, bindings),
        body: one.body.map((inside) => statement(inside, bindings)),
        line: one.line,
      };
    case "break":
      return { kind: "break", line: one.line };
    case "continue":
      return { kind: "continue", line: one.line };
    case "pass":
      return { kind: "block", body: [], line: one.line };
    case "print":
      return { kind: "print", values: one.values.map((value) => programValue(value, bindings)), line: one.line };
    case "try": {
      // A compiled program cannot raise, so there is nothing to catch: the
      // body runs and the block that catches is not read. The block that runs
      // whatever happens does run, and it runs after the body.
      const body = [...one.body, ...(one.finallyBody ?? [])].map((inside) => statement(inside, bindings));
      return { kind: "block", body, line: one.line };
    }
    case "call": {
      const called = one.value;
      if (called.k !== "call") {
        throw frontendError(`"${describeValue(called)}" is not a call`, "a statement of a program is a call");
      }
      return {
        kind: "invoke",
        function: builtinName(called.name),
        args: called.args.map((argument) => programValue(argument, bindings)),
        line: one.line,
      };
    }
    case "function":
      throw frontendError(
        "a function of a program is declared at the top of the module",
        "a function is declared at the top of the file it is written in",
      );
  }
}

/**
 * What a name holds, as far as the body says: a dict is an object, and the
 * keys it holds are what a read of it by a key is checked against.
 */
function bound(bindings: Bindings, name: string, value: PyValue): void {
  if (value.k === "dict") {
    bindings.dicts.set(name, new Set(value.entries.map((entry) => entry.name)));
    return;
  }
  bindings.dicts.delete(name);
}

/** Whether a value is the command line of a Python program. */
function isSysArgv(value: PyValue): boolean {
  return value.k === "field" && value.field === "argv" && value.base.k === "name" && value.base.name === "sys";
}

/**
 * The statements of a Python module that run, as the program model holds them.
 */
export function lowerProgramBody(body: readonly PyStatement[]): ProgramStatement[] {
  const bindings = noBindings();
  return body.map((one) => statement(one, bindings));
}

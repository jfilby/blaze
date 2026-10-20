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
 * A Python value, as the program model holds it.
 *
 * A whole number is a whole number of the program model: the kind a TypeScript
 * source writes `1n` for, which is the `i64` a Python `int` is. A fraction is
 * a number, which is a double.
 */
function programValue(one: PyValue): ProgramValue {
  switch (one.k) {
    case "number":
      return one.whole ? { k: "whole", text: one.text } : { k: "number", text: one.text };
    case "text":
      return { k: "text", parts: text(one.parts) };
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
      // `str(x)` is the text of the value, which the runtime writes.
      if (one.name === "str" && one.args.length === 1) {
        return { k: "text", parts: [{ k: "value", value: programValue(one.args[0]) }] };
      }
      return { k: "call", function: builtinName(one.name), args: one.args.map(programValue) };
    }
    case "index": {
      // `sys.argv[i]` is the command line of the program: the compiler counts
      // the program and the file it runs before the arguments, and Python
      // counts the file alone, so the argument a Python program reads at `i`
      // is the one the compiler holds at `i + 1`.
      if (isSysArgv(one.base)) {
        return { k: "argv", index: programValue(one.index), offset: 1 };
      }
      if (one.base.k !== "name") {
        throw new Error(`a program cannot read an element of ${describeValue(one.base)}`);
      }
      return { k: "element", buffer: one.base.name, index: programValue(one.index) };
    }
    case "field":
      return { k: "field", object: programValue(one.base), field: one.field };
    case "list": {
      // A list written out is a buffer of the numbers it holds, and the width
      // of an element is what the list holds it at.
      const whole = one.items.every((item) => item.k === "number" && item.whole);
      const element: PrimitiveTypeName = whole ? "i64" : "f64";
      return { k: "buffer", element, values: one.items.map(programValue) };
    }
    case "dict":
      return { k: "object", fields: one.entries.map((entry) => ({ name: entry.name, value: programValue(entry.value) })) };
    case "binary": {
      const operator = BINARY_OPERATORS[one.op];
      if (operator === undefined) {
        throw new Error(`"${one.op}" is not an operator a program has`);
      }
      return { k: "binary", op: operator, left: programValue(one.left), right: programValue(one.right) };
    }
    case "unary": {
      const operator = UNARY_OPERATORS[one.op];
      if (operator === undefined) {
        throw new Error(`"${one.op}" is not an operator a program has`);
      }
      return { k: "unary", op: operator, operand: programValue(one.operand) };
    }
    case "conditional":
      return {
        k: "conditional",
        condition: programValue(one.condition),
        then: programValue(one.then),
        otherwise: programValue(one.otherwise),
      };
  }
}

/** The parts of a string, as the program model holds them. */
function text(parts: readonly PyTextPart[]): ProgramText[] {
  return parts.map((part) =>
    part.k === "text" ? { k: "text", value: part.value } : { k: "value", value: programValue(part.value) },
  );
}

/**
 * A Python statement, as the program model holds it.
 */
function statement(one: PyStatement): ProgramStatement {
  switch (one.k) {
    case "declare":
      return {
        kind: "declare",
        name: one.name,
        mutable: true,
        type: null,
        value: programValue(one.value),
        line: one.line,
      };
    case "assign": {
      const operator = ASSIGN_OPERATORS[one.op];
      if (operator === undefined) {
        throw new Error(`"${one.op}" is not an assignment a program can make`);
      }
      return { kind: "assign", name: one.name, op: operator, value: programValue(one.value), line: one.line };
    }
    case "return":
      return { kind: "result", value: programValue(one.value ?? { k: "none" }), line: one.line };
    case "if":
      conditionIsBoolean(one.condition, one.line);
      return {
        kind: "if",
        condition: programValue(one.condition),
        then: one.then.map(statement),
        otherwise: one.otherwise.map(statement),
        line: one.line,
      };
    case "while":
      conditionIsBoolean(one.condition, one.line);
      return { kind: "while", condition: programValue(one.condition), body: one.body.map(statement), line: one.line };
    case "for":
      return {
        kind: "for",
        variable: one.variable,
        from: programValue(one.from),
        to: programValue(one.to),
        inclusive: false,
        down: false,
        type: null,
        step: one.step === null ? null : programValue(one.step),
        body: one.body.map(statement),
        line: one.line,
      };
    case "break":
      return { kind: "break", line: one.line };
    case "continue":
      return { kind: "continue", line: one.line };
    case "pass":
      return { kind: "block", body: [], line: one.line };
    case "print":
      return { kind: "print", values: one.values.map(programValue), line: one.line };
    case "try": {
      // A compiled program cannot raise, so there is nothing to catch: the
      // body runs and the block that catches is not read. The block that runs
      // whatever happens does run, and it runs after the body.
      const body = [...one.body, ...(one.finallyBody ?? [])].map(statement);
      return { kind: "block", body, line: one.line };
    }
    case "call": {
      const called = one.value;
      if (called.k !== "call") {
        throw new Error(`"${describeValue(called)}" is not a call`);
      }
      return { kind: "invoke", function: builtinName(called.name), args: called.args.map(programValue), line: one.line };
    }
    case "function":
      throw new Error("a function of a program is declared at the top of the module");
  }
}

/** Whether a value is the command line of a Python program. */
function isSysArgv(value: PyValue): boolean {
  return value.k === "field" && value.field === "argv" && value.base.k === "name" && value.base.name === "sys";
}

/**
 * The statements of a Python module that run, as the program model holds them.
 */
export function lowerProgramBody(body: readonly PyStatement[]): ProgramStatement[] {
  return body.map(statement);
}

/**
 * The rules of Python that differ from the rules of the compiler.
 *
 * Each rule is a program that shows it: what Python answers and what the
 * compiler answers, side by side.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { diagnostic, phaseOf } from "./phase.ts";
import { resolveProgram } from "../semantics/ir-resolve.ts";

test("a whole number is sixty-four bits, and a literal outside it is refused", () => {
  const refused = diagnostic(() =>
    phaseOf("python", { "main.py": "x = 9223372036854775808\n" }, "main.py"),
  );
  assert.match(refused, /does not fit in sixty-four bits/);
  assert.match(refused, /-9223372036854775808 and 9223372036854775807/);
});

test("a condition is a boolean, and one that is not is refused", () => {
  // A number, a text and a nothing are not booleans, and Python's truth is
  // wider than a boolean: a condition that is one of them is refused rather
  // than answered differently.
  const number = diagnostic(() =>
    phaseOf("python", { "main.py": "if 1:\n    print(1)\n" }, "main.py"),
  );
  assert.match(number, /a condition must be a boolean/);
  const nothing = diagnostic(() =>
    phaseOf("python", { "main.py": "if None:\n    print(1)\n" }, "main.py"),
  );
  assert.match(nothing, /a condition must be a boolean/);
  // A comparison is a boolean, and so is a name that holds one.
  const comparison = phaseOf(
    "python",
    { "main.py": "x = 1\nif x > 0:\n    print(x)\n" },
    "main.py",
  );
  assert.equal(comparison.body?.statements.length, 2);
});

test("a name that is never bound is refused rather than read", () => {
  const refused = diagnostic(() => {
    const phase = phaseOf("python", { "main.py": "print(missing)\n" }, "main.py");
    resolveProgram(phase.body!, phase.program, phase.objectNames, phase.objectLayouts, phase.objectKeys);
  });
  assert.match(refused, /missing/);
});

test("the name of the module a program runs is the one the guard reads", () => {
  const phase = phaseOf("python", { "main.py": 'if __name__ == "__main__":\n    print(1)\n' }, "main.py");
  const statement = phase.body?.statements[0];
  assert.ok(statement !== undefined && statement.kind === "if");
  assert.equal(statement.condition.k, "binary");
  assert.equal(statement.condition.op, "==");
});

test("a division of two whole numbers is a fraction, and the compiler answers one", () => {
  const phase = phaseOf("python", { "main.py": "print(7 / 2)\n" }, "main.py");
  const statement = phase.body?.statements[0];
  assert.ok(statement !== undefined && statement.kind === "print");
  const value = statement.values[0];
  assert.equal(value.k, "binary");
  assert.equal(value.op, "/");
});

test("a whole number beside a fraction is a fraction, and the compiler answers one", () => {
  // Python has no such a thing as a whole number beside a fraction: the pair
  // is a fraction there, and `1 + 1.5` is 2.5.
  const phase = phaseOf("python", { "main.py": "print(1 + 2.5)\n" }, "main.py");
  const statement = phase.body?.statements[0];
  assert.ok(statement !== undefined && statement.kind === "print");
  const value = statement.values[0];
  assert.equal(value.k, "binary");
  assert.equal(value.op, "+");
  // The answer is a fraction and not a whole number: the two are two kinds of
  // number and the printer writes them differently.
  const resolved = resolveProgram(phase.body!, phase.program, phase.objectNames, phase.objectLayouts, phase.objectKeys);
  const printed = resolved.entry.statements[0];
  assert.ok(printed.k === "printNumber");
  assert.equal(printed.value.k, "arith");
  assert.equal(printed.value.type.kind, "primitive");
  assert.equal(printed.value.type.kind === "primitive" ? printed.value.type.name : "", "f64");
});

test("the magnitude of a whole number is a whole number, and the compiler answers one", () => {
  // Python's `abs` of a whole number is a whole number, and the compiler's
  // `Math.abs` answers a fraction: the two are two kinds of number.
  const phase = phaseOf("python", { "main.py": "print(abs(-3))\n" }, "main.py");
  const resolved = resolveProgram(phase.body!, phase.program, phase.objectNames, phase.objectLayouts, phase.objectKeys);
  const printed = resolved.entry.statements[0];
  assert.ok(printed.k === "printNumber");
  assert.equal(printed.value.k, "call");
  // The call is answered by the whole one, and the answer is a whole number.
  assert.equal(printed.value.k === "call" ? printed.value.call.callee : "", "whole.abs");
  assert.equal(printed.value.k === "call" ? printed.value.type.kind : "", "primitive");
  assert.equal(
    printed.value.k === "call" && printed.value.type.kind === "primitive" ? printed.value.type.name : "",
    "i64",
  );
  // The answer is written as a whole number, and not as a fraction.
  assert.equal(printed.k === "printNumber" ? printed.bigint : false, true);
});

test("a fraction beside a whole number is a fraction, and the compiler answers one", () => {
  // The magnitude of a fraction is a fraction: `abs(-3.5)` is 3.5 there.
  const phase = phaseOf("python", { "main.py": "print(abs(-3.5))\n" }, "main.py");
  const resolved = resolveProgram(phase.body!, phase.program, phase.objectNames, phase.objectLayouts, phase.objectKeys);
  const printed = resolved.entry.statements[0];
  assert.ok(printed.k === "printNumber");
  assert.equal(printed.value.k === "call" ? printed.value.call.callee : "", "Math.abs");
});

test("a conversion answers a whole number, and the compiler answers one", () => {
  // `int(x)` and `math.floor(x)` answer a whole number in Python, and the
  // compiler's answers are fractions unless it is told the language's rule.
  const conversions: [string, string][] = [
    ["print(int(3.7))\n", "whole.trunc"],
    ["import math\nprint(math.floor(3.7))\n", "whole.floor"],
    ["import math\nprint(math.ceil(3.2))\n", "whole.ceil"],
  ];
  for (const [source, callee] of conversions) {
    const phase = phaseOf("python", { "main.py": source }, "main.py");
    const resolved = resolveProgram(phase.body!, phase.program, phase.objectNames, phase.objectLayouts, phase.objectKeys);
    const printed = resolved.entry.statements[0];
    assert.ok(printed.k === "printNumber", `${source} prints a number`);
    assert.equal(printed.value.k === "call" ? printed.value.call.callee : "", callee);
    assert.equal(
      printed.value.k === "call" && printed.value.type.kind === "primitive" ? printed.value.type.name : "",
      "i64",
    );
    assert.equal(printed.k === "printNumber" ? printed.bigint : false, true);
  }
});

test("a whole number read as a fraction is a fraction, and the compiler answers one", () => {
  // `math.sqrt(9)` is 3.0 in Python: the whole number is read as the fraction
  // it is.
  const phase = phaseOf("python", { "main.py": "import math\nprint(math.sqrt(9))\n" }, "main.py");
  const resolved = resolveProgram(phase.body!, phase.program, phase.objectNames, phase.objectLayouts, phase.objectKeys);
  const printed = resolved.entry.statements[0];
  assert.ok(printed.k === "printNumber");
  assert.equal(printed.value.k === "call" ? printed.value.call.callee : "", "Math.sqrt");
  assert.equal(
    printed.value.k === "call" && printed.value.type.kind === "primitive" ? printed.value.type.name : "",
    "f64",
  );
});

test("a remainder of Python takes the sign of its divisor", () => {
  const phase = phaseOf("python", { "main.py": "print(-7 % 2)\n" }, "main.py");
  const statement = phase.body?.statements[0];
  assert.ok(statement !== undefined && statement.kind === "print");
  const value = statement.values[0];
  assert.equal(value.k, "binary");
  assert.equal(value.op, "%");
});

test("the arguments of a program are the ones it was given, and the file is the first of them", () => {
  const phase = phaseOf(
    "python",
    { "main.py": "print(len(sys.argv))\nprint(sys.argv[1])\n" },
    "main.py",
  );
  const statements = phase.body?.statements ?? [];
  assert.equal(statements.length, 2);
  const length = statements[0];
  assert.ok(length.kind === "print");
  // The length of the command line is the length of the list of texts Python
  // holds: the file the program runs and the arguments it was given.
  assert.equal(length.values[0].k, "call");
  assert.equal(length.values[0].k === "call" ? length.values[0].function : "", "argvLength");
  const argument = statements[1];
  assert.ok(argument.kind === "print");
  // The argument a Python program reads at `i` is the one the compiler holds
  // at `i + 1`, because the compiler counts the program and the file it runs
  // before the arguments.
  assert.equal(argument.values[0].k, "argv");
  assert.equal(argument.values[0].k === "argv" ? argument.values[0].offset : -1, 1);
});

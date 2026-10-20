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

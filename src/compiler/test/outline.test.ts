/**
 * The two views a model reads a body through: the semantic outline the whole
 * prompt carries, and the IR syntax a candidate whose answer is the IR is told
 * to write it in.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { functionOutline } from "../ai/outline.ts";
import { IR_EXAMPLE, IR_SYNTAX, type IrFormKind } from "../ai/ir-format.ts";
import { parseSemanticFunction, printSemanticFunction } from "../semantics/ir-text.ts";
import { validateSemanticFunction } from "../semantics/ir-validate.ts";
import type { FunctionContract, ProgramContract } from "../core/types.ts";
import { programWithSemantics } from "./phase.ts";

/** A program of an entry that calls a library function, so its body is contracted. */
function library(name: string, body: readonly string[]): { files: Record<string, string>; entry: string } {
  return {
    files: {
      "main.ts": `import { ${name} } from "./lib.ts";\nconsole.log(${name}(2, 3, 4));\n`,
      "lib.ts": [...body, ""].join("\n"),
    },
    entry: "main.ts",
  };
}

/** The behaviour of the function `r` of a program, as a code generator is shown it. */
function outline(body: readonly string[]): string {
  const program = library("r", body);
  return functionOutline(programWithSemantics("typescript", program.files, program.entry).semantics.r);
}

test("the outline reads as the source was written, with every type the compiler resolved", () => {
  // A body that branches, loops every way a body can, and reads a buffer: the
  // whole of the constructs one is written from.
  const written = outline([
    "export function r(values: Float64Array, limit: number): number {",
    "  let total = 0;",
    "  for (const value of values) {",
    "    if (value > limit) break;",
    "    total += value;",
    "  }",
    "  let i = 0;",
    "  while (i < values.length) {",
    "    i = i + 1;",
    "    if (i == 1) continue;",
    "  }",
    "  do { total = total - 1; } while (total > 0);",
    "  return total;",
    "}",
  ]);

  // The shape is the source's: a name, the type it is read as, a condition
  // that reads as a condition and a loop that reads as the loop written.
  assert.match(written, /^function r\(values: \[\]f64, limit: f64\) -> f64$/m);
  assert.match(written, /^ {2}let mutable total: f64 = 0$/m);
  assert.match(written, /^ {2}for value: f64 of values:$/m);
  assert.match(written, /^ {4}if value > limit:$/m);
  assert.match(written, /^ {6}break$/m);
  assert.match(written, /^ {4}total \+= value$/m);
  assert.match(written, /^ {2}while i < len\(values\):$/m);
  assert.match(written, /^ {6}continue$/m);
  assert.match(written, /^ {2}do while total > 0:$/m);
  assert.match(written, /^ {2}return total$/m);
  // A precondition is a fact about the body as well as about the caller, so it
  // travels with the body the candidate is written from.
  assert.match(written, /^requires "values != null"$/m);

  // What the compiler resolves for its own lowering, and a model has no use
  // for, is not in it: a block name, what a block owns, the source line a
  // diagnostic points at, and the index a for-of loop counts on.
  for (const internal of [/block entry/, /releases\[/, /@\d+$/m, /index i\d/, /\blocal\[/]) {
    assert.doesNotMatch(written, internal);
  }
});

test("the outline states a counted loop as the three parts it runs on", () => {
  const written = outline([
    "export function r(n: number): number {",
    "  let sum = 0;",
    "  for (let index = 4; index <= n; index += 2) { sum += index; }",
    "  return sum;",
    "}",
  ]);

  // The bound and the step are the loop's, not a guess from the source: an
  // inclusive loop runs one time more than an exclusive one, and a backend
  // that reads the wrong one of them is off by an iteration.
  assert.match(written, /^ {2}for \(index: f64 = 4; index <= n; index \+= 2\):$/m);
  assert.match(written, /^ {4}sum \+= index$/m);
});

test("the outline states a loop that counts down by a step the direction is not also in", () => {
  // A step the loop names is the signed amount the index moves by, so a loop
  // counting down carries a negative one. Writing it as a subtraction as well
  // shows the model `i -= -1`, and a model that implements the outline it was
  // given counts up where the source counted down.
  const named = outline([
    "export function r(n: number): number {",
    "  let sum = 0;",
    "  for (let index = n; index > 0; index -= 1) { sum += index; }",
    "  return sum;",
    "}",
  ]);
  assert.match(named, /^ {2}for \(index: f64 = n; index > 0; index \+= -1\):$/m);

  // A loop that names no step moves one the way it travels, so the direction is
  // the only thing that says which way round it counts.
  const unnamed = outline([
    "export function r(n: number): number {",
    "  let sum = 0;",
    "  for (let index = n; index > 0; index--) { sum += index; }",
    "  return sum;",
    "}",
  ]);
  assert.match(unnamed, /^ {2}for \(index: f64 = n; index > 0; index -= 1\):$/m);
});

test("the outline states a whole number as one and a double as it was written", () => {
  const written = outline([
    "export function r(a: Float64Array): number {",
    "  a[0] = 9;",
    "  return +process.argv[2] || 0;",
    "}",
  ]);

  // A number is a double until a use fixes it, and the ones a use fixed are
  // the ones a bare number does not already say.
  assert.match(written, /^ {2}a\[0:usize\] = 9$/m);
  assert.match(written, /^ {2}return argv\(2:usize\) \|\| 0$/m);
});

test("the outline names the layout and the fields a value was resolved to", () => {
  const written = outline([
    "export function r(depth: number): any {",
    "  return depth-- > 0",
    "    ? { left: r(depth), right: r(depth) }",
    "    : { left: null, right: null };",
    "}",
  ]);

  // The layout, its fields and the null reference in it are what the compiler
  // gave the program, and none of them are written in the source. The value a
  // post-decrement leaves behind is bound before the step runs, which is the
  // one thing about it a backend cannot infer from the name.
  assert.match(written, /^ {2}--depth$/m);
  assert.match(written, /^ {2}let \w+: f64 = depth$/m);
  assert.match(
    written,
    /return \(\w+ > 0\) \? new Object1 \{ left: r\(depth\), right: r\(depth\) \} : new Object1 \{ left: null, right: null \}$/m,
  );
});

test("the IR syntax the prompt states is the syntax the compiler reads an answer back with", () => {
  const program = library("clamp", [
    "export function clamp(x: number, lo: number, hi: number): number {",
    "  if (x < lo) { return lo; }",
    "  const h = hi;",
    "  if (x > h) { return h; }",
    "  for (let i = 0; i < 2; i++) { console.log(x); }",
    "  return x;",
    "}",
  ]);
  const contracted = programWithSemantics("typescript", program.files, program.entry);
  const read = parseSemanticFunction(IR_EXAMPLE, contracted.program);

  // The example the prompt carries is read by the parser a build reads an
  // answer with, and prints back as itself. A form the prompt states and the
  // parser does not agree on leaves a model with no way to write an answer.
  assert.equal(printSemanticFunction(read).trimEnd(), IR_EXAMPLE.trimEnd());
});

/**
 * A program whose function the forms of the syntax are written in. It has the
 * three parameters the example reads and it calls another function, so a form
 * that is a call is a call the contract the parser binds to declares.
 */
function calling(): { files: Record<string, string>; entry: string } {
  return {
    files: {
      "main.ts": `import { clamp } from "./lib.ts";\nconsole.log(clamp(2, 3, 4));\n`,
      "lib.ts": [
        "export function clamp(x: number, lo: number, hi: number): number {",
        "  if (x < lo) { return lo; }",
        "  const h = hi + scale(x);",
        "  if (x > h) { return h; }",
        "  for (let i = 0; i < 2; i++) { console.log(x); }",
        "  return x;",
        "}",
        "export function scale(x: number): number {",
        "  return x * 0;",
        "}",
        "",
      ].join("\n"),
    },
    entry: "main.ts",
  };
}

/**
 * The lines a form is written as, in the place the syntax says it is written: a
 * type is the type of a constant, a value is the value a `let` is given, and a
 * terminator is the last line of a block of its own. Every line is written at
 * the indentation it is read at inside the entry block.
 */
function linesAs(form: IrFormKind, text: string): string[] {
  switch (form) {
    case "type":
      return [`let value[${text}] t immutable = const[f64] 0`];
    case "value":
      return [`let value[f64] t immutable = ${text}`];
    case "statement":
    case "block":
      return text.split("\n");
    case "terminator":
      return ["block b_form: releases[]", text];
  }
}

test("every form the prompt states is a line the parser reads an answer back with", () => {
  const program = calling();
  const contracted = programWithSemantics("typescript", program.files, program.entry);
  // The header is read back out of the contract rather than out of the text, so
  // it is the compiler's own and is not written out again here: what is under
  // test is the body, which is every form of the syntax the prompt carries.
  const printed = printSemanticFunction(contracted.semantics.clamp).split("\n");
  const entry = printed.findIndex((line) => line.startsWith("  block "));
  const header = printed.slice(0, entry + 1);

  for (const line of IR_SYNTAX) {
    if (typeof line === "string") continue;
    const body = linesAs(line.form, line.text).map((written) => `    ${written}`);
    try {
      parseSemanticFunction([...header, ...body, ""].join("\n"), contracted.program);
    } catch (cause) {
      const error = cause as { detail?: string };
      assert.fail(`the prompt states a form the parser refuses: ${line.text}\n${error.detail ?? String(cause)}`);
    }
  }
});

/**
 * A function of a program that reads the command line and prints, so its
 * contract states two effects and its IR is the header a build refused an
 * answer of `main` over.
 */
function reported(): { program: ProgramContract; contract: FunctionContract; ir: string } {
  const files = {
    "main.ts": `import { r } from "./lib.ts";\nconsole.log(r(2));\n`,
    "lib.ts": [
      "export function r(n: number): number {",
      "  console.log(process.argv[2]);",
      "  return n;",
      "}",
      "",
    ].join("\n"),
  };
  const contracted = programWithSemantics("typescript", files, "main.ts");
  const file = contracted.program.files.find((entry) => entry.path === "lib.ts");
  const contract = file?.functions.r;
  if (contract === undefined) throw new Error("the function under test was not contracted");
  return { program: contracted.program, contract, ir: printSemanticFunction(contracted.semantics.r) };
}

test("a header list written with commas is the header the contract states", () => {
  const contracted = reported();
  assert.match(contracted.ir, /^ {2}effects io syscall$/m, "the frontend writes the list side by side");

  // The contract holds the effects in an array and a model writes them the way
  // the array holds them. Which effects there are is the contract's to fix
  // either way, so a comma between two of them is a spelling and not a
  // different body — and a build that read it as a refusal threw away every
  // candidate it was given over a punctuation.
  const read = parseSemanticFunction(contracted.ir.replace("effects io syscall", "effects io, syscall"), contracted.program);
  assert.deepEqual(read.effects, contracted.contract.effects);
  assert.match(printSemanticFunction(read), /^ {2}effects io syscall$/m);
});

test("a statement that states no line of the source is the statement it was written as", () => {
  const contracted = reported();
  // The mark is what a diagnostic names the place in a program by, and nothing
  // is lowered from it, so an answer that leaves every one of them out says
  // the same thing in fewer characters.
  const unmarked = contracted.ir.replace(/ @\d+$/gm, "");
  assert.ok(!unmarked.includes("@"), "the answer states no line of the source at all");

  const read = parseSemanticFunction(unmarked, contracted.program);
  // It is held to the contract like any other answer, so what makes it lowerable
  // is unchanged: the mark was never part of that.
  validateSemanticFunction(read, contracted.contract);
  assert.equal(printSemanticFunction(read).replace(/ @\d+$/gm, ""), unmarked);
  assert.notEqual(printSemanticFunction(read), contracted.ir, "the lines of the source are lost, not stated");
});

test("a list of names written with commas is the list without them", () => {
  const contracted = reported();
  // What a block frees is stated in its head, and a candidate writes the names
  // the way it writes every other list. Which names a block frees is the
  // reader's to take whatever separates them.
  const listed = contracted.ir.replace("block entry: releases[]", "block entry: releases[n, t]");
  assert.deepEqual(parseSemanticFunction(listed, contracted.program).entry.releases, ["n", "t"]);
  assert.match(printSemanticFunction(parseSemanticFunction(listed, contracted.program)), /^ {2}block entry: releases\[n t\]$/m);
});

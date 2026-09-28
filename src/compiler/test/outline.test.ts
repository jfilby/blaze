/**
 * The two views a model reads a body through: the semantic outline the whole
 * prompt carries, and the IR syntax a candidate whose answer is the IR is told
 * to write it in.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { functionOutline } from "../ai/outline.ts";
import { IR_EXAMPLE } from "../ai/ir-format.ts";
import { parseSemanticFunction, printSemanticFunction } from "../semantics/ir-text.ts";
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

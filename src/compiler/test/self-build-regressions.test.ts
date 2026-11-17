/**
 * Regressions found by asking the compiler to read its own sources.
 *
 * Each source here is a construct the compiler writes and the frontend used to
 * refuse, or a type rule that disagreed with itself. They are kept as small
 * programs so a change to the object pass, the boxing pass or the type rules is
 * caught without waiting for a whole self-build.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { phaseOf, semanticsOf } from "./phase.ts";
import { semanticFunctionProblems } from "../semantics/ir-validate.ts";

/** Contracts and resolves a program, returning the IR of one function. */
function resolved(source: string, name: string) {
  const phase = phaseOf("typescript", { "1.ts": `${source}\nmain();\n` }, "1.ts");
  const fn = semanticsOf(phase)[name];
  assert.ok(fn !== undefined, `${name} is resolved`);
  const contract = phase.program.files[0].functions[name];
  assert.ok(contract !== undefined, `${name} has a contract`);
  return { fn, contract };
}

test("a counted loop's index is in scope in its bound and its step", () => {
  // The index is read in the `to` bound and the step of this `for`, not only in
  // its body. The object pass, the IR function and the reduction contract each
  // used to refuse the loop as using an undeclared name.
  const source = [
    "function scan(size: number): number {",
    "  let total = 0;",
    "  for (let offset = 0; offset < size + offset - offset; offset += offset - offset + 1) total += 1;",
    "  return total;",
    "}",
  ].join("\n");
  const { fn, contract } = resolved(source, "scan");
  assert.deepEqual(semanticFunctionProblems(fn, contract), []);
});

test("a dynamic value is read as the text or number it is compared with", () => {
  const source = [
    "function probe(value: any, n: number): boolean {",
    '  return value === "known" && value > n;',
    "}",
  ].join("\n");
  const { fn, contract } = resolved(source, "probe");
  assert.deepEqual(semanticFunctionProblems(fn, contract), []);
});

test("a dynamic value is read as a truth beside a boolean", () => {
  const source = [
    "function probe(value: any): boolean {",
    "  return value === true;",
    "}",
  ].join("\n");
  const { fn, contract } = resolved(source, "probe");
  assert.deepEqual(semanticFunctionProblems(fn, contract), []);
});

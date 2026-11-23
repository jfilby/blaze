/**
 * The compact form a contract takes on disk.
 *
 * The object pass gives every function the one whole-program layout table.
 * Left as it stands, a contract serializes that table once per function — for
 * a compiler that compiles itself, thousands of copies of its module graph.
 * These tests keep the one table on the program and write it back into every
 * definition on read, so a consumer still sees a self-contained function.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { compactContract, expandContract } from "../core/contract-store.ts";
import { programOf } from "./phase.ts";

const source = [
  "class Pair {",
  "  first: number = 0;",
  "  second: number = 0;",
  "}",
  "export function make(a: number, b: number): Pair {",
  "  const p = new Pair();",
  "  p.first = a;",
  "  p.second = b;",
  "  return p;",
  "}",
  "export function sum(p: Pair): number {",
  "  return p.first + p.second;",
  "}",
  "main();",
].join("\n");

test("a stored contract keeps the shared layout table once", () => {
  const program = programOf("typescript", { "main.ts": source }, "main.ts");
  const functions = Object.values(program.files[0].functions);
  assert.ok(functions.length > 1, "the program has functions to share between");
  // Every definition carries the one table the object pass wrote.
  const first = functions[0]!.definition.objects;
  for (const fn of functions) assert.equal(fn.definition.objects, first, "the table is shared in memory");

  const compact = compactContract(program) as Record<string, unknown>;
  assert.ok(compact["objects"] !== undefined, "the table is written at the program level");
  const stored = compact["files"] as { functions: Record<string, { definition: Record<string, unknown> }> }[];
  for (const file of stored) {
    for (const fn of Object.values(file.functions)) {
      assert.equal(fn.definition["objects"], undefined, "no definition carries the table on disk");
    }
  }
});

test("a read contract writes the shared table back into every definition", () => {
  const program = programOf("typescript", { "main.ts": source }, "main.ts");
  const compact = compactContract(program);
  // JSON is the disk form: the reader sees the parsed value, not the live one.
  const restored = expandContract(JSON.parse(JSON.stringify(compact)));
  const functions = Object.values(restored.files[0].functions);
  assert.ok(functions.length > 1, "the program has functions to share between");
  for (const fn of functions) {
    assert.deepEqual(fn.definition.objects, functions[0]!.definition.objects, "every definition sees the table");
  }
  assert.equal(functions[0]!.definition.objects, functions[functions.length - 1]!.definition.objects, "the table is one shared object");
});

test("a function named like an inherited key survives the compact form", () => {
  const program = programOf("typescript", { "main.ts": "export function __proto__(x: number): number { return x; }\nmain();" }, "main.ts");
  const compact = compactContract(program) as Record<string, unknown>;
  const files = compact["files"] as { functions: Record<string, unknown> }[];
  assert.ok(Object.prototype.hasOwnProperty.call(files[0]!.functions, "__proto__"), "the function is an own key on disk");
  const restored = expandContract(JSON.parse(JSON.stringify(compact)));
  assert.ok(Object.prototype.hasOwnProperty.call(restored.files[0]!.functions, "__proto__"), "the function is an own key on read");
});

test("a contract written before the compact form is read unchanged", () => {
  const program = programOf("typescript", { "main.ts": source }, "main.ts");
  const restored = expandContract(JSON.parse(JSON.stringify(program)));
  const functions = Object.values(restored.files[0].functions);
  assert.ok(functions[0]!.definition.objects !== undefined, "a contract without a program-level table keeps its own");
});

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
import { readTypeScriptModule } from "../semantics/typescript.ts";

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
  // its body. The object pass, the IR function and the IR validator each used
  // to refuse the loop as using an undeclared name; the frontend also has to
  // give up stating a reduction whose bound names its own index.
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

test("a member read through a cast keeps the field's type", () => {
  // A cast to a declared type names its layout (`Piece__module`), while the
  // declaration is held under the bare name. The field a member read takes
  // from that layout used to be lost, so `Array.from` over a text field was
  // refused where the compiler source writes it.
  const source = [
    "interface Piece { value: string }",
    "interface Box { parts: Piece[] }",
    "function letters(box: Box): string[] {",
    "  return Array.from((box.parts[0] as { value: string }).value);",
    "}",
    "",
  ].join("\n");
  const read = readTypeScriptModule(source, "module.ts", false);
  assert.equal(read.count, 0, read.refused.map((one) => `${one.line}: ${one.message}`).join("; "));
  const { fn, contract } = resolved(source, "letters");
  assert.deepEqual(semanticFunctionProblems(fn, contract), []);
});

test("a conditional spread writes a field the expected type does not state", () => {
  // `...(rest ? { rest: true } : {})` writes a field the descriptor's type does
  // not declare. The arm that writes nothing leaves that type's zero, which is
  // taken from the value the written arm gives it.
  const source = [
    "interface Param { name: string; type: number }",
    "function make(rest: boolean): Param[] {",
    '  return [{ name: "x", type: 1, ...(rest ? { rest: true as const } : {}) }];',
    "}",
    "",
  ].join("\n");
  const read = readTypeScriptModule(source, "module.ts", false);
  assert.equal(read.count, 0, read.refused.map((one) => `${one.line}: ${one.message}`).join("; "));
  const { fn, contract } = resolved(source, "make");
  assert.deepEqual(semanticFunctionProblems(fn, contract), []);
});

test("a conditional spread writes an unknown-typed field a declaration leaves out", () => {
  // The IR resolver writes a descriptor's `promise` field only when the held
  // value has one. The field's value is read through a `fieldOf` helper typed
  // `any`; its absence is the language's null, which is what `undefined` lowers
  // to, so the field can be written in both arms of the spread.
  const source = [
    "function fieldOf(value: unknown, key: string): any {",
    "  return (value as Record<string, unknown>)[key];",
    "}",
    "function descriptor(held: unknown): unknown {",
    "  return { kind: \"object\", ...(fieldOf(held, \"promise\") === undefined ? {} : { promise: fieldOf(held, \"promise\") }) };",
    "}",
    "",
  ].join("\n");
  const read = readTypeScriptModule(source, "module.ts", false);
  assert.equal(read.count, 0, read.refused.map((one) => `${one.line}: ${one.message}`).join("; "));
  const { fn, contract } = resolved(source, "descriptor");
  assert.deepEqual(semanticFunctionProblems(fn, contract), []);
});

test("instanceof a built-in collection reads for a value the type does not name", () => {
  // A map and a set are one dictionary handle and a date is a number, so none
  // of them has a runtime kind to ask. The answer is the one the other built-in
  // classes give an untyped value: whether the value is there at all.
  const source = [
    "function tag(value: object): string {",
    "  return value instanceof Map ? `map` : value instanceof Set ? `set` : `object`;",
    "}",
    "",
  ].join("\n");
  const read = readTypeScriptModule(source, "module.ts", false);
  assert.equal(read.count, 0, read.refused.map((one) => `${one.line}: ${one.message}`).join("; "));
  const { fn, contract } = resolved(source, "tag");
  assert.deepEqual(semanticFunctionProblems(fn, contract), []);
});

test("a callback read through a cast is called through the value", () => {
  // The target review callback is read off an opaque request with a cast to a
  // function type. The cast's shape has to survive the handle-to-pointer read,
  // so an optional call of the local is an `invoke` of the value and not a call
  // of a function the program does not compile.
  const source = [
    "interface Progress { stage: string }",
    "export function review(request: unknown): void {",
    "  const notify = (request as { onReview?: ((progress: Progress) => void) }).onReview;",
    '  notify?.({ stage: "target" });',
    "}",
    "",
  ].join("\n");
  const read = readTypeScriptModule(source, "module.ts", false);
  assert.equal(read.count, 0, read.refused.map((one) => `${one.line}: ${one.message}`).join("; "));
  const fn = read.analysis.functions.find((one) => one.name === "review");
  const handle = fn?.handle as { body?: unknown } | undefined;
  const body = JSON.stringify(handle?.body ?? []);
  assert.match(body, /"k":"invoke"/, "the callback is called through its value");
});

test("a function reading a module collection stays a function of the module", () => {
  // A map the module writes is read through its getter, which a compiled
  // function can call. A function that reads it is not one the running program
  // holds as a name, so it stays with the module rather than its program body.
  const source = [
    "const tags = new Map<string, string>();",
    "function add(key: string, value: string): void { tags.set(key, value); }",
    "",
  ].join("\n");
  const read = readTypeScriptModule(source, "module.ts", false);
  assert.equal(read.count, 0, read.refused.map((one) => `${one.line}: ${one.message}`).join("; "));
  assert.ok(read.analysis.functions.some((fn) => fn.name === "add"), "the reader is a module function");
  assert.equal(read.analysis.body.length, 0, "a library module has no program body");
});

test("a non-exported generator is a function of the module", () => {
  // A library module has no program body: a function written after `function*`
  // must be prescanned as the module's function, not left as top-level code.
  const source = [
    "export function head(): string {",
    "  return first().join(\",\");",
    "}",
    "function* first(): Generator<string> {",
    '  yield "a";',
    "}",
    "",
  ].join("\n");
  const read = readTypeScriptModule(source, "module.ts", false);
  assert.equal(read.count, 0, read.refused.map((one) => `${one.line}: ${one.message}`).join("; "));
  assert.ok(read.analysis.functions.some((fn) => fn.name === "first"), "the generator is a module function");
  assert.equal(read.analysis.body.length, 0, "a library module has no program body");
});

test("a generator reads as the list its yields write", () => {
  // The JSON store walks a value in bounded batches with `yield` and `yield*`.
  // A generator is read as the list it yields, so the `Generator<string>` a
  // function states is the list a caller walks with for..of.
  const source = [
    "function* chunks(): Generator<string> {",
    '  yield "a";',
    "  yield* more();",
    "}",
    "function* more(): Generator<string> {",
    '  yield "b";',
    "}",
    "",
  ].join("\n");
  const read = readTypeScriptModule(source, "module.ts", false);
  assert.equal(read.count, 0, read.refused.map((one) => `${one.line}: ${one.message}`).join("; "));
  const collected = read.analysis.functions.find((fn) => fn.name === "chunks");
  assert.deepEqual(collected?.returns, { kind: "slice", of: { kind: "text" } });
});

test("in asks whether an index is one a list holds", () => {
  // The structural hash walks a sparse list with `index in array`. A list holds
  // the indexes it wrote, so the question is the bounds question, and the index
  // is read once for the two comparisons.
  const source = [
    "function present(list: number[], index: number): boolean {",
    "  return index in list;",
    "}",
    "",
  ].join("\n");
  const read = readTypeScriptModule(source, "module.ts", false);
  assert.equal(read.count, 0, read.refused.map((one) => `${one.line}: ${one.message}`).join("; "));
  const { fn, contract } = resolved(source, "present");
  assert.deepEqual(semanticFunctionProblems(fn, contract), []);
});

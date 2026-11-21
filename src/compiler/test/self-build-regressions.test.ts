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
import { phaseOf, programOf, semanticsOf } from "./phase.ts";
import { semanticFunctionProblems } from "../semantics/ir-validate.ts";
import { readTypeScriptModule } from "../semantics/typescript.ts";
import { printSemanticFunction } from "../semantics/ir-text.ts";

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

test("an optional method parameter is callable without the argument", () => {
  // A method's `?` makes a shorter arity: the wrapper answers the zero of the
  // type it left out, so a call of the shorter form keeps its arity.
  const source = [
    "class Hub {",
    "  send(tag: string, extra?: number): string { return tag; }",
    "}",
    "export function demo(hub: Hub): string { return hub.send(`a`); }",
    "",
  ].join("\n");
  const read = readTypeScriptModule(source, "module.ts", false);
  assert.equal(read.count, 0, read.refused.map((one) => `${one.line}: ${one.message}`).join("; "));
  const fn = read.analysis.functions.find((one) => one.name === "demo");
  const handle = fn?.handle as { body?: unknown } | undefined;
  assert.match(JSON.stringify(handle?.body ?? []), /Hub_send__1/, "the shorter arity is called");
});

test("a function type with no parameters takes no arguments", () => {
  const source = "export function f(x: unknown): void { (x as () => void)(); }\n";
  const read = readTypeScriptModule(source, "module.ts", false);
  assert.equal(read.count, 0, read.refused.map((one) => `${one.line}: ${one.message}`).join("; "));
  const fn = read.analysis.functions.find((one) => one.name === "f");
  const handle = fn?.handle as { body?: unknown } | undefined;
  const body = JSON.stringify(handle?.body ?? []);
  assert.match(body, /"params":\[\]/, "the invoke states no parameters");
});

test("a second cast still states the function's signature", () => {
  // `x as unknown as (n: number) => void` used to read the first assertion's
  // type, so the call became a named call and lost its function value.
  const source = "export function f(x: unknown): void { (x as unknown as (n: number) => void)(1); }\n";
  const read = readTypeScriptModule(source, "module.ts", false);
  assert.equal(read.count, 0, read.refused.map((one) => `${one.line}: ${one.message}`).join("; "));
  const fn = read.analysis.functions.find((one) => one.name === "f");
  const handle = fn?.handle as { body?: unknown } | undefined;
  const body = JSON.stringify(handle?.body ?? []);
  assert.match(body, /"k":"invoke"/, "the value is called through its signature");
});

test("a promise's settle functions read as callbacks", () => {
  // The machine's queue passes `resolve` and `reject` on to `then` inside the
  // executor that declares them. They are the builtins that settle the promise
  // rather than an invoke of a name the executor no longer holds.
  const source = [
    "export const take = <T>(task: () => T | Promise<T>): Promise<T> =>",
    "  new Promise<T>((resolve, reject) => {",
    "    Promise.resolve().then(task).then(resolve, reject).finally(() => {});",
    "  });",
    "",
  ].join("\n");
  const read = readTypeScriptModule(source, "module.ts", false);
  assert.equal(read.count, 0, read.refused.map((one) => `${one.line}: ${one.message}`).join("; "));
  for (const fn of read.analysis.functions) {
    const handle = fn.handle as { body?: unknown } | undefined;
    const body = JSON.stringify(handle?.body ?? []);
    assert.doesNotMatch(body, /__refused_/, `${fn.name} has no refused hole`);
  }
  const settleCalls = read.analysis.functions.some((fn) => {
    const handle = fn.handle as { body?: unknown } | undefined;
    return JSON.stringify(handle?.body ?? []).includes('"name":"resolve"');
  });
  assert.ok(settleCalls, "the settle callback is a builtin call");
});

test("a call through valueOf and call keeps the value it names", () => {
  const source = [
    "export function demo(o: object, fn: (...args: unknown[]) => unknown): unknown {",
    "  const boxed = o.valueOf();",
    "  return fn.call(boxed, 1, 2);",
    "}",
    "",
  ].join("\n");
  const read = readTypeScriptModule(source, "module.ts", false);
  assert.equal(read.count, 0, read.refused.map((one) => `${one.line}: ${one.message}`).join("; "));
  const fn = read.analysis.functions.find((one) => one.name === "demo");
  const handle = fn?.handle as { body?: unknown } | undefined;
  const body = JSON.stringify(handle?.body ?? []);
  assert.match(body, /"k":"invoke"/, "the call goes through the function value");
});

test("a rest function type is called at the arity the source wrote", () => {
  const source = [
    "interface Emit { print: unknown }",
    "export function demo(emit: Emit): unknown[] {",
    "  return (emit.print as unknown as (...args: unknown[]) => unknown[])(1, 2, 3, 4, 5, 6);",
    "}",
    "",
  ].join("\n");
  const read = readTypeScriptModule(source, "module.ts", false);
  assert.equal(read.count, 0, read.refused.map((one) => `${one.line}: ${one.message}`).join("; "));
  const fn = read.analysis.functions.find((one) => one.name === "demo");
  const handle = fn?.handle as { body?: unknown } | undefined;
  const arityOf = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const one of value) arityOf(one);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const call = value as { k?: string; args?: unknown[]; params?: unknown[] };
    if (call.k === "invoke" && call.args !== undefined) {
      assert.equal(call.params?.length, call.args.length, "the invoke states one type per argument");
      assert.equal(call.args.length, 6, "six arguments were written");
    }
    for (const one of Object.values(value)) arityOf(one);
  };
  arityOf(handle?.body ?? []);
});

test("a text and a reference pass to a dynamic number parameter", () => {
  const source = [
    "function takesNumber(n: number): number { return n; }",
    "export function demo(text: string, value: unknown): number {",
    "  return takesNumber(text) + takesNumber(value);",
    "}",
    "",
  ].join("\n");
  const read = readTypeScriptModule(source, "module.ts", false);
  assert.equal(read.count, 0, read.refused.map((one) => `${one.line}: ${one.message}`).join("; "));
  const { fn, contract } = resolved(source, "demo");
  assert.deepEqual(semanticFunctionProblems(fn, contract), [], "the calls resolve");
});

test("the length of a dynamic value asks the runtime", () => {
  const source = [
    "export function demo(value: unknown): number {",
    "  if (!Array.isArray(value) || value.length === 0) return 0;",
    "  return value.length;",
    "}",
    "",
  ].join("\n");
  const read = readTypeScriptModule(source, "module.ts", false);
  assert.equal(read.count, 0, read.refused.map((one) => `${one.line}: ${one.message}`).join("; "));
  const { fn, contract } = resolved(source, "demo");
  assert.deepEqual(semanticFunctionProblems(fn, contract), [], "the length reads resolve");
});

test("an index that arrived as text is read as a number", () => {
  const source = [
    "function entry(): [string, string] { return [`a`, `b`]; }",
    "export function demo(): string {",
    "  const pair = entry();",
    "  const at = pair[0] as unknown as number;",
    "  const words = [`x`, `y`];",
    "  return words[at];",
    "}",
    "",
  ].join("\n");
  const read = readTypeScriptModule(source, "module.ts", false);
  assert.equal(read.count, 0, read.refused.map((one) => `${one.line}: ${one.message}`).join("; "));
  const { fn, contract } = resolved(source, "demo");
  assert.deepEqual(semanticFunctionProblems(fn, contract), [], "the element read resolves");
});

test("fieldOf on a named record reads the field at its type", () => {
  const source = [
    "function fieldOf(value: unknown, key: string): any { return value; }",
    "interface Size { value: number; next: number }",
    "function read(): Size { return { value: 2, next: 3 }; }",
    "export function demo(): number {",
    "  const size = read();",
    "  return (fieldOf(size, `next`) as number) + (fieldOf(size, `value`) as number);",
    "}",
    "main();",
  ].join("\n");
  const { fn, contract } = resolved(source, "demo");
  assert.deepEqual(semanticFunctionProblems(fn, contract), [], "the two fields add as numbers");
});

test("a wide result answers a function declared to return a number", () => {
  const source = [
    "function wide(text: string): bigint { return BigInt(text); }",
    "export function demo(text: string): number | bigint { return wide(text); }",
    "",
  ].join("\n");
  const read = readTypeScriptModule(source, "module.ts", false);
  assert.equal(read.count, 0, read.refused.map((one) => `${one.line}: ${one.message}`).join("; "));
  const { fn, contract } = resolved(source, "demo");
  assert.deepEqual(semanticFunctionProblems(fn, contract), [], "the wide result converts");
});

test("a block of bytes passes where a text is expected", () => {
  const source = [
    "function write(_path: string, _text: string): void { return; }",
    "export function demo(path: string): void {",
    "  const bytes: number[] = [72, 105];",
    "  write(path, bytes as unknown as string);",
    "}",
    "main();",
  ].join("\n");
  const { fn, contract } = resolved(source, "demo");
  assert.deepEqual(semanticFunctionProblems(fn, contract), [], "the byte block converts to text");
});

test("a wide number shifts by a machine-word count", () => {
  const source = [
    "export function demo(n: bigint, shift: bigint): bigint {",
    "  return n << shift;",
    "}",
    "main();",
  ].join("\n");
  const { fn, contract } = resolved(source, "demo");
  assert.deepEqual(semanticFunctionProblems(fn, contract), [], "the shift count narrows");
});

test("an absent conditional arm takes the type the other arm answers", () => {
  const source = [
    "export function demo(flag: boolean): string[] {",
    "  const held: string[] | undefined = flag ? [`a`] : undefined;",
    "  return held ?? [`b`];",
    "}",
    "main();",
  ].join("\n");
  const { fn, contract } = resolved(source, "demo");
  assert.deepEqual(semanticFunctionProblems(fn, contract), [], "both arms read at the list type");
});

test("a folded typeof comparison is a boolean a logical accepts", () => {
  const source = [
    "export function demo(text: string, flag: boolean): boolean {",
    "  return typeof text !== `string` || flag;",
    "}",
    "main();",
  ].join("\n");
  const { fn, contract } = resolved(source, "demo");
  assert.deepEqual(semanticFunctionProblems(fn, contract), [], "the folded truth is boolean");
});

test("a folded Array.isArray test is a boolean a negation accepts", () => {
  const source = [
    "function fieldOf(v: unknown, k: string): any { return v; }",
    "export function demo(candidate: unknown): void {",
    "  const candidates = fieldOf(candidate, 'candidates') as unknown[];",
    "  if (!Array.isArray(candidates)) return;",
    "}",
    "main();",
  ].join("\n");
  const { fn, contract } = resolved(source, "demo");
  assert.deepEqual(semanticFunctionProblems(fn, contract), [], "the folded truth negates");
});

test("fieldOf's field shape decides a chained method on an unshaped read", () => {
  const source = [
    "function fieldOf(v: unknown, k: string): any { return v; }",
    "interface L { params: string[] }",
    "export function demo(l: L, n: number): unknown {",
    "  return fieldOf(l, 'params').slice(n);",
    "}",
    "main();",
  ].join("\n");
  const { fn, contract } = resolved(source, "demo");
  assert.deepEqual(semanticFunctionProblems(fn, contract), [], "slice is the list's method");
});

test("negating an unsigned wide number writes its two's complement", () => {
  const source = [
    "export function demo(n: u256): u256 { return -n; }",
    "",
  ].join("\n");
  const read = readTypeScriptModule(source, "module.ts", false);
  assert.equal(read.count, 0, read.refused.map((one) => `${one.line}: ${one.message}`).join("; "));
  const { fn, contract } = resolved(source, "demo");
  assert.deepEqual(semanticFunctionProblems(fn, contract), [], "the negation resolves");
});

test("a dynamic value written into a list slot reads its block", () => {
  const source = [
    "function fieldOf(value: unknown, key: string): unknown { return value; }",
    "export function demo(value: unknown): number {",
    "  let items: number[] = [];",
    "  items = fieldOf(value, `items`) as number[];",
    "  return items.length;",
    "}",
    "",
  ].join("\n");
  const read = readTypeScriptModule(source, "module.ts", false);
  assert.equal(read.count, 0, read.refused.map((one) => `${one.line}: ${one.message}`).join("; "));
  const { fn, contract } = resolved(source, "demo");
  assert.deepEqual(semanticFunctionProblems(fn, contract), [], "the assignment resolves");
});

test("a dynamic value asserted as a list reads through the runtime", () => {
  const source = [
    "function fieldOf(value: unknown, key: string): unknown { return value; }",
    "export function demo(parsed: unknown): number {",
    "  const lines = fieldOf(parsed, `requires`) as string[];",
    "  return lines.length;",
    "}",
    "",
  ].join("\n");
  const read = readTypeScriptModule(source, "module.ts", false);
  assert.equal(read.count, 0, read.refused.map((one) => `${one.line}: ${one.message}`).join("; "));
  const { fn, contract } = resolved(source, "demo");
  assert.deepEqual(semanticFunctionProblems(fn, contract), [], "the asserted list resolves");
});

test("a machine whole passed to a wide parameter is widened", () => {
  const source = [
    "function takesWide(n: u256): u256 { return n; }",
    "export function demo(n: bigint): u256 { return takesWide(n); }",
    "",
  ].join("\n");
  const read = readTypeScriptModule(source, "module.ts", false);
  assert.equal(read.count, 0, read.refused.map((one) => `${one.line}: ${one.message}`).join("; "));
  const { fn, contract } = resolved(source, "demo");
  assert.deepEqual(semanticFunctionProblems(fn, contract), [], "the wide call resolves");
});

test("keys of an empty literal are an empty list", () => {
  const source = [
    "export function demo(): number {",
    "  const selected = {} as Record<string, string>;",
    "  return Object.keys(selected).length;",
    "}",
    "",
  ].join("\n");
  const read = readTypeScriptModule(source, "module.ts", false);
  assert.equal(read.count, 0, read.refused.map((one) => `${one.line}: ${one.message}`).join("; "));
  const fn = read.analysis.functions.find((one) => one.name === "demo");
  const handle = fn?.handle as { body?: unknown } | undefined;
  assert.doesNotMatch(JSON.stringify(handle?.body ?? []), /__refused_/, "the read has no refused hole");
});

test("a dictionary handle viewed as a named record crosses at the declare", () => {
  // The contract pass reads the result of `unitContract` as a dictionary
  // handle; viewing it as a named record crosses through the pointer it names.
  const source = [
    "interface Contract { name: string }",
    "function unitContract(unit: unknown): Record<string, unknown> { return {}; }",
    "export function demo(): string {",
    "  const contract = unitContract(1) as unknown as Contract;",
    "  return contract.name;",
    "}",
    "",
  ].join("\n");
  const read = readTypeScriptModule(source, "module.ts", false);
  assert.equal(read.count, 0, read.refused.map((one) => `${one.line}: ${one.message}`).join("; "));
  const { fn, contract } = resolved(source, "demo");
  assert.deepEqual(semanticFunctionProblems(fn, contract), [], "the declare resolves");
});

test("a cast of a call result does not cross a reference to a pointer", () => {
  const source = [
    "interface T { name: string }",
    "function get(o: unknown): unknown { return o; }",
    "export function f(o: unknown): T { return get(o) as T; }",
    "",
  ].join("\n");
  const read = readTypeScriptModule(source, "module.ts", false);
  assert.equal(read.count, 0, read.refused.map((one) => `${one.line}: ${one.message}`).join("; "));
  const fn = read.analysis.functions.find((one) => one.name === "f");
  const handle = fn?.handle as { body?: unknown } | undefined;
  assert.doesNotMatch(JSON.stringify(handle?.body ?? []), /blaze_pointer_of_handle/, "the call result keeps its reference");
});

test("a reference written into a number slot crosses as its handle", () => {
  // `Record<string, unknown>` is a dictionary handle in the contract, while a
  // named record is a reference. Writing one into the other asks the runtime
  // for the handle the reference names.
  const source = [
    "interface Project { name: string }",
    "export function demo(p: Project): string {",
    "  let fields: Record<string, unknown> = {};",
    "  fields = p;",
    '  return String(fields["name"]);',
    "}",
    "",
  ].join("\n");
  const read = readTypeScriptModule(source, "module.ts", false);
  assert.equal(read.count, 0, read.refused.map((one) => `${one.line}: ${one.message}`).join("; "));
  const { fn, contract } = resolved(source, "demo");
  assert.deepEqual(semanticFunctionProblems(fn, contract), [], "the assignment resolves");
  const ir = printSemanticFunction(fn);
  assert.match(ir, /blaze_rt_number_of_ref/, "the reference becomes a handle");
});

test("a field read on an empty fallback goes by name", () => {
  // `fieldOf(x, "left") ?? {}` narrows to an empty object in one arm, and the
  // body reads `k` on the choice. The descriptor answers absence for that arm
  // instead of laying a field the literal never wrote.
  const source = [
    "export function tag(x: unknown): string {",
    "  const left = x as { left?: { k: string } };",
    "  const chosen = left.left ?? {};",
    '  return String(chosen.k);',
    "}",
    "",
  ].join("\n");
  const read = readTypeScriptModule(source, "module.ts", false);
  assert.equal(read.count, 0, read.refused.map((one) => `${one.line}: ${one.message}`).join("; "));
  const fn = read.analysis.functions.find((one) => one.name === "tag");
  const handle = fn?.handle as { body?: unknown } | undefined;
  assert.doesNotMatch(JSON.stringify(handle?.body ?? []), /__refused_/, "the read has no refused hole");
});

test("a recursive arrow passed to some reads through an array test", () => {
  // `Array.isArray` narrows an untyped value to a list in the branch it holds,
  // so `some` is the collection method and the self-reference is its callback.
  const source = [
    "export function walk(n: unknown): boolean {",
    "  const visit = (node: unknown): boolean =>",
    "    Array.isArray(node) ? node.some(visit) : node !== null;",
    "  return visit(n);",
    "}",
    "",
  ].join("\n");
  const read = readTypeScriptModule(source, "module.ts", false);
  assert.equal(read.count, 0, read.refused.map((one) => `${one.line}: ${one.message}`).join("; "));
  for (const fn of read.analysis.functions) {
    const handle = fn.handle as { body?: unknown } | undefined;
    assert.doesNotMatch(JSON.stringify(handle?.body ?? []), /__refused_/, `${fn.name} has no hole`);
  }
});

test("a map and a set narrow through instanceof", () => {
  const source = [
    "export function read(value: object): string {",
    "  if (value instanceof Map) return [...value.entries()].length.toString();",
    "  if (value instanceof Set) return [...value].length.toString();",
    "  return `none`;",
    "}",
    "",
  ].join("\n");
  const read = readTypeScriptModule(source, "module.ts", false);
  assert.equal(read.count, 0, read.refused.map((one) => `${one.line}: ${one.message}`).join("; "));
  const fn = read.analysis.functions.find((one) => one.name === "read");
  const handle = fn?.handle as { body?: unknown } | undefined;
  const body = JSON.stringify(handle?.body ?? []);
  assert.match(body, /entryPairs|__entries|__pairs/, "map entries are read as pairs");
});

test("a number added to or compared with a text writes as text", () => {
  const source = [
    "export function demo(index: number): string {",
    '  return `item ${index}` + (index === 1 ? `!` : `?`);',
    "}",
    "",
  ].join("\n");
  const read = readTypeScriptModule(source, "module.ts", false);
  assert.equal(read.count, 0, read.refused.map((one) => `${one.line}: ${one.message}`).join("; "));
});

test("an object returned at a declared type lays out its optional fields", () => {
  // Two literals that write the same declared interface must be one layout,
  // even where one leaves an optional field out: a read of that field through
  // an unshaped reference then has one offset to choose.
  const source = [
    "interface Call { name: string; grid?: number; awaiting?: boolean }",
    "export function a(): Call { return { name: `a`, grid: 1, awaiting: true }; }",
    "export function b(): Call { return { name: `b` }; }",
    "",
  ].join("\n");
  const read = readTypeScriptModule(source, "module.ts", false);
  assert.equal(read.count, 0, read.refused.map((one) => `${one.line}: ${one.message}`).join("; "));
  for (const name of ["a", "b"]) {
    const fn = read.analysis.functions.find((one) => one.name === name);
    const handle = fn?.handle as { body?: { value?: { fields?: { name: string }[] } }[] } | undefined;
    const fields = (handle?.body?.[0]?.value?.fields ?? []).map((field) => field.name);
    assert.deepEqual(fields, ["name", "grid", "awaiting"], `${name} writes every declared field`);
  }
});

test("an object with no fields still has a size", () => {
  // Every layout a contract holds is allocated by a backend, so an empty
  // object is a byte rather than a zero-sized layout no backend can pass.
  const program = programOf("typescript", { "1.ts": "function f(): any { const empty = {}; return empty; }\nmain();\n" }, "1.ts");
  const objects = program.files[0]?.functions["f"]?.definition.objects ?? {};
  assert.ok(Object.values(objects).length > 0, "the empty object has a layout");
  for (const layout of Object.values(objects)) {
    assert.ok(Number(layout.size) > 0, "the layout can be allocated");
  }
});

test("a field of globalThis reads through its host service", () => {
  // The wasm boundary reads the host's WebAssembly off `globalThis`. A field of
  // the host object is a service the platform answers, not a name a compiled
  // function holds, so the cast and the bracket read still lower to that call.
  const source = [
    "interface Engine { validate(bytes: number[]): boolean }",
    "export function probe(bytes: number[]): boolean {",
    '  const engine = (globalThis as unknown as Record<string, unknown>)["WebAssembly"] as Engine | undefined;',
    "  return engine === undefined ? false : engine.validate(bytes);",
    "}",
    "",
  ].join("\n");
  const read = readTypeScriptModule(source, "module.ts", false);
  assert.equal(read.count, 0, read.refused.map((one) => `${one.line}: ${one.message}`).join("; "));
  const fn = read.analysis.functions.find((one) => one.name === "probe");
  const handle = fn?.handle as { body?: unknown } | undefined;
  assert.match(JSON.stringify(handle?.body ?? []), /webAssemblyEngine/);
});

test("a recursive arrow passed as a callback reads as a function value", () => {
  // The probe walker hands itself to `some`. Inside its own body the name is a
  // function value, not an unbound name the object pass would refuse.
  const source = [
    "export function walk(value: unknown[]): boolean {",
    "  const visit = (node: unknown): boolean => {",
    "    if (Array.isArray(node)) return node.some(visit);",
    "    return node !== null;",
    "  };",
    "  return visit(value);",
    "}",
    "",
  ].join("\n");
  const read = readTypeScriptModule(source, "module.ts", false);
  assert.equal(read.count, 0, read.refused.map((one) => `${one.line}: ${one.message}`).join("; "));
  const closure = read.analysis.functions.find((one) => one.name.startsWith("__closure_module"));
  assert.ok(closure !== undefined, "the arrow is lifted to a function");
  const handle = closure.handle as { body?: unknown } | undefined;
  const body = JSON.stringify(handle?.body ?? []);
  assert.doesNotMatch(body, /"name":"visit"/, "the self-reference is not an unbound name");
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

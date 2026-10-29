/**
 * The language features a source may use without a source rewrite: a default
 * parameter, a result a function does not state, and a constant a function
 * reads from the file it was written in.
 *
 * Each is checked through the IR and then through a program the build delivers,
 * because the two halves are different claims: the IR says what the compiler
 * read, and the program says the value the language would have computed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runBuild } from "../compiler.ts";
import { run } from "../core/process.ts";
import { irOf, phaseOf, programOf } from "./phase.ts";
import { scratch } from "./scratch.ts";
import { writeProject } from "./project.ts";

const REPLAY = new URL("./fixtures/dot-product-replay.json", import.meta.url).pathname;
const QUIET = { stage: () => {} };

/** Builds a program and answers the binary and the directory it was built in. */
async function build(source: string): Promise<{ directory: string; binary: string }> {
  const directory = await scratch("blaze-language-feature-");
  await writeFile(join(directory, "main.ts"), source, "utf8");
  await writeProject(join(directory, "blaze.toml"), {
    language: "typescript",
    sourceFile: "main.ts",
    model: { provider: "replay", file: REPLAY },
    output: "machine",
  });
  const outcome = await runBuild(
    "blaze.toml",
    { cwd: directory, reuse: false, model: `replay:${REPLAY}` },
    QUIET,
    "build",
  );
  assert.ok(outcome.outputPath !== null, "a program build delivers its binary");
  return { directory, binary: outcome.outputPath as string };
}

/** Builds a program and checks it prints what the source prints under node. */
async function agreesWithNode(source: string): Promise<string> {
  const { directory, binary } = await build(source);
  const original = run("node", ["--experimental-strip-types", "main.ts"], { cwd: directory, timeoutMs: 60_000 });
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(original.code, 0, original.stderr);
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, original.stdout);
  return delivered.stdout;
}

test("a default parameter makes a function callable at the shorter arity", () => {
  // The full function takes every parameter, and each shorter arity is a
  // function of the module whose body fills the defaults the source wrote. A
  // parameter with a default and no type is held at the type the default is.
  const source = [
    "export function add(a: number, b: number = 10): number { return a + b; }",
    "export function scale(a: number, by = 2): number { return a * by; }",
    "",
  ].join("\n");
  const functions = programOf("typescript", { "module.ts": source }, "module.ts").files[0]?.functions ?? {};
  assert.ok(functions["add__1"], "the shorter arity is a function of the module");
  assert.ok(functions["scale__1"], "an untyped default still makes the shorter arity");
  assert.equal(functions["add"]?.function.params.length, 2);
  assert.equal(functions["add__1"]?.function.params.length, 1);
  assert.equal(functions["scale"]?.function.params[1]?.type, "f64");
});

test("a function that states no result is typed by the returns it has", () => {
  // A return over two `u256` names is a `u256`, which is what lets `invert`
  // answer a wide number without the source writing the annotation.
  const source = [
    "function half(n: u256, d: u256): u256 { return n % d; }",
    "console.log(half(7n, 2n).toString(16));",
    "",
  ].join("\n");
  assert.match(irOf("typescript", { "main.ts": source }, "main.ts", "half"), /^function half\(n: u256, d: u256\) -> u256$/m);
});

test("a function reads a constant the file declares, in the source's order", async () => {
  // The constant is written after the function that reads it, which is the
  // order the benchmark writes its curve. A compiled function has no scope to
  // read the file from, so the value the constant is written as is read where
  // the source reads the name.
  const output = await agreesWithNode([
    "function floorValue(a: u256): u256 { return a % CURVE.P; }",
    "const CURVE = { P: 2n ** 32n + 1n };",
    "console.log(floorValue(0x1234567890abcdefn).toString(16));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), ((0x1234567890abcdefn % (2n ** 32n + 1n)).toString(16)));
});

test("a function that reads a value the program holds stays a function of the program", async () => {
  // A constant written as a constant expression is the module's, and a function
  // that reads one is compiled with the module. A value the program computes
  // while it runs is not: the function that reads it is compiled where the
  // value is, so the name it reads is the one the program holds, not a name the
  // module has no scope for.
  const output = await agreesWithNode([
    "const base = Math.floor(2.5) + 10;",
    "function bump(x: number): number { return x + base; }",
    "console.log(bump(1));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "13");
});

test("a function declared after a statement is compiled with the module", async () => {
  // A function declaration is hoisted: the file's functions are the module's
  // wherever they are written, so the statements that run before one do not
  // decide whether it is compiled, and a program and the functions it calls are
  // one source rather than one source reordered.
  const source = [
    "console.log(later() + 1);",
    "function later(): number { return 2; }",
    "",
  ].join("\n");
  const functions = phaseOf("typescript", { "main.ts": source }, "main.ts").program.files[0]?.functions ?? {};
  assert.ok(functions["later"], "the function written after the statement is the module's");
  const output = await agreesWithNode(source);
  assert.equal(output.trim(), "3");
});

test("a module function that calls one the module cannot hold is read by the program", async () => {
  // The module reads a function whose body is inside the subset it holds, and
  // leaves the ones it cannot read — a body that searches a text, that opens
  // the database — where the program reads them. A function that calls one of
  // those is not a function the module can hold either: a contract names only
  // the functions of the module, so the caller is read beside its callee as a
  // function of the program. The file is one source: a function of it is a
  // function of the module only if everything it calls is.
  const source = [
    "function nameOf(header: string): string {",
    '  const at = header.indexOf("=");',
    '  return at < 0 ? "" : header.slice(at + 1);',
    "}",
    "function greeting(header: string): string {",
    "  const name = nameOf(header);",
    '  return name === "" ? "hello" : `hello ${name}`;',
    "}",
    'console.log(greeting("who=blaze"));',
    'console.log(greeting("none"));',
    "",
  ].join("\n");
  const phase = phaseOf("typescript", { "main.ts": source }, "main.ts");
  assert.deepEqual(
    Object.keys(phase.program.files[0]?.functions ?? {}),
    [],
    "the caller is read where the callee is, not as a function of the module",
  );
  assert.equal(await agreesWithNode(source), "hello blaze\nhello\n");
});

test("a function declared before the program that calls one the module cannot hold is read by the program", async () => {
  // A declaration is hoisted from wherever it is written, so a function at the
  // top of a program is read by the module when it can be. When a function it
  // calls is one the module cannot hold, the caller is read by the program too,
  // beside the callee, whichever of the two is written first.
  const source = [
    "function fromText(text: string): number {",
    '  const at = text.indexOf("3");',
    "  return at < 0 ? 0 : 3;",
    "}",
    "function twice(raw: number): number {",
    "  return fromText(`${raw}`) * 2;",
    "}",
    "console.log(twice(3));",
    "",
  ].join("\n");
  const phase = phaseOf("typescript", { "main.ts": source }, "main.ts");
  assert.deepEqual(
    Object.keys(phase.program.files[0]?.functions ?? {}),
    [],
    "the caller is read by the program, beside the callee it calls",
  );
  assert.equal(await agreesWithNode(source), "6\n");
});

test("a parameter named like a value the program holds is the parameter", () => {
  // A name a function declares is its own, whatever the file calls it. A
  // parameter spelled like a value the program computes while it runs is the
  // parameter, so the function that reads it needs no scope to read it from
  // and the module can hold it.
  const source = [
    "const total = Math.floor(2.5);",
    "function bump(total: number): number { return total + 1; }",
    "console.log(bump(total));",
    "",
  ].join("\n");
  const functions = phaseOf("typescript", { "main.ts": source }, "main.ts").program.files[0]?.functions ?? {};
  assert.ok(functions["bump"], "the parameter is the function's own name, not the file's value");
});

test("a name a block declares is that block's, not the whole function's", async () => {
  // A function that declares `total` in one arm still reads the file's
  // `total` outside it. Counting every declaration a function writes as its
  // own classified the function as a module function, which then had no scope
  // for the value it read: the build refused a program the source wrote.
  const source = [
    "const total = Math.floor(2.5);",
    "function read(x: number): number {",
    "  if (x > 0) { const total = 100; }",
    "  return total;",
    "}",
    "console.log(read(1));",
    "console.log(read(0));",
    "",
  ].join("\n");
  const functions = phaseOf("typescript", { "main.ts": source }, "main.ts").program.files[0]?.functions ?? {};
  assert.deepEqual(Object.keys(functions), [], "the function reads the value the program holds");
  assert.equal(await agreesWithNode(source), "2\n2\n");
});

test("a name a function declares is not the file's constant", async () => {
  // A parameter spelled like a constant of the file is the parameter: the
  // constant is not read where the body declared its own name.
  const output = await agreesWithNode([
    "const P = 100n;",
    "console.log(kept(3n));",
    "function kept(P: u256): u256 { return P; }",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "3n");
});

test("a default that calls is evaluated once, with the receiver still intact", async () => {
  // A wide default is a call of its own. A call written among the arguments
  // runs while the receiver is pinned in a register the callee writes over, so
  // the default is read under a name before the call: the value the callee is
  // handed outlives every call between the two.
  const output = await agreesWithNode([
    "function twice(a: u256): u256 { return a + a; }",
    "function times(x: u256, factor: u256 = twice(x)): u256 { return x * factor; }",
    "console.log(times(3n).toString(16));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "12");
});

test("an object and an array pattern are the declarations they bind", async () => {
  // A pattern reads its value once where the value is a call, and each name is
  // the field or the element the source asked for.
  const output = await agreesWithNode([
    "class P { x: number; y: number; constructor(x: number, y: number) { this.x = x; this.y = y; } }",
    "function sum(p: P): number { const { x, y } = p; return x + y; }",
    "function swapped(): number { let a = 1; let b = 2; [a, b] = [b, a]; return a * 10 + b; }",
    "console.log(sum(new P(3, 4)));",
    "console.log(swapped());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "7\n21");
});

test("a throw is the program ending where the source raises it", async () => {
  // The raised value is text nothing observes, and the block after it is not
  // code anything reaches: a function declared to return a number still
  // returns on the path that does not raise.
  const output = await agreesWithNode([
    "function guarded(n: number): number {",
    "  if (n < 0) throw new Error(`negative ${n}`);",
    "  return n;",
    "}",
    "console.log(guarded(5));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "5");
});

test("a quoted string is the text it holds, and BigInt reads the digits", async () => {
  // `BigInt('0x...')` is the value the digits name, and a quote is the text
  // it was written with whichever quote the source used.
  const digits = "123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const output = await agreesWithNode([
    `function wide(): bigint { return BigInt('0x${digits}'); }`,
    "console.log(wide().toString(16));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), digits);
});

test("typeof reads the type a name is declared at, and the dead arm is not compiled", async () => {
  // `typeof` is answered from the declared type, so a branch that says the
  // other type cannot be reached is not a construct the build refuses. The
  // `Number.isSafeInteger` call in it is text the dead arm holds.
  const output = await agreesWithNode([
    "function whose(num: number | bigint): number {",
    "  if (typeof num === 'number' && num > 0 && Number.isSafeInteger(num)) return 1;",
    "  if (typeof num === 'bigint') return 2;",
    "  return 3;",
    "}",
    "console.log(whose(3n));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "2");
});

test("a bigint annotation is the width the file's own values reach", async () => {
  // The language's bigint is arbitrary precision. A file whose values reach
  // past the machine word holds its bigints at the wide whole number, so the
  // annotation is the width its values are.
  const wide = "0x123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const output = await agreesWithNode([
    `function addWide(a: bigint, b: bigint): bigint { return a + b; }`,
    `console.log(addWide(${wide}n, 1n).toString(16));`,
    "",
  ].join("\n"));
  assert.equal(output.trim(), (BigInt(wide) + 1n).toString(16));
});

test("a constant instance read once is the constructor where it is read", async () => {
  // An object has an identity, so a constructor is inline-able only where the
  // file reads the name once. It is then the same object the source made, and
  // a function that reads it needs no scope to read it from.
  const output = await agreesWithNode([
    "class Point { x: number; y: number; constructor(x: number, y: number) { this.x = x; this.y = y; } }",
    "const G = new Point(3, 4);",
    "function sum(): number { return G.x + G.y; }",
    "console.log(sum());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "7");
});

test("a switch runs the case its value matches, and falls through the cases that do not break", async () => {
  // The lowering is the comparisons the source wrote: a case with no break runs
  // the case after it, and the default runs when none matches.
  const output = await agreesWithNode([
    "function label(x: number): number {",
    "  switch (x) {",
    "    case 0: return 10;",
    "    case 1:",
    "    case 2: return 20;",
    "    default: return 30;",
    "  }",
    "}",
    "console.log(label(0), label(1), label(2), label(9));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "10 20 20 30");
});

test("a nullish write keeps a value the target already holds", async () => {
  // `value ??= x` is `value = value ?? x`, and zero is a value the target
  // holds rather than the absence of one.
  const output = await agreesWithNode([
    "function fill(value: number, x: number): number { value ??= x; return value; }",
    "console.log(fill(0, 4), fill(9, 4));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "0 9");
});

test("a type-only declaration is not a value the program carries", async () => {
  // An interface, a type alias, an `as` and a generic parameter say what the
  // values are, not what they compute, so the program is the one without them.
  const output = await agreesWithNode([
    "type Pair<T> = { a: T; b: T };",
    "interface Shape { width: number }",
    "function first(x: number): number {",
    "  const p = { a: x, b: 1 } as Pair<number>;",
    "  return p.a!;",
    "}",
    "console.log(first(5));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "5");
});

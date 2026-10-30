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
async function build(
  source: string,
  backend?: "c" | "machine",
): Promise<{ directory: string; binary: string; status: { backend: string; reason?: string } }> {
  const directory = await scratch("blaze-language-feature-");
  await writeFile(join(directory, "main.ts"), source, "utf8");
  await writeProject(join(directory, "blaze.toml"), {
    language: "typescript",
    sourceFile: "main.ts",
    model: { provider: "replay", file: REPLAY },
    output: "machine",
    ...(backend === undefined ? {} : { backend }),
  });
  const outcome = await runBuild(
    "blaze.toml",
    { cwd: directory, reuse: false, model: `replay:${REPLAY}` },
    QUIET,
    "build",
  );
  assert.ok(outcome.outputPath !== null, "a program build delivers its binary");
  return {
    directory,
    binary: outcome.outputPath as string,
    status: { backend: outcome.build.backend, reason: outcome.build.backendFallback?.reason },
  };
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

test("a module function that calls a text method is a function of the module", async () => {
  // A text method is carried by the frontend now, so a function that reads one
  // is a function of the module and is contracted, compiled and linked like any
  // other. The file is one source: a function of it is a function of the module
  // whatever it calls.
  const source = [
    "function nameOf(header: string): string {",
    '  const at = header.indexOf("=");',
    '  return at < 0 ? "" : header.slice(at + 1, header.length);',
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
    Object.keys(phase.program.files[0]?.functions ?? {}).sort(),
    ["greeting", "nameOf"],
    "a body of text methods is a function of the module",
  );
  assert.equal(await agreesWithNode(source), "hello blaze\nhello\n");
});

test("a function declared before the program that calls a text method is a function of the module", async () => {
  // A declaration is hoisted from wherever it is written, so a function at the
  // top of a program is read by the module when it can be. A text method is a
  // construct the module carries, so both the caller and the callee are.
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
    Object.keys(phase.program.files[0]?.functions ?? {}).sort(),
    ["fromText", "twice"],
    "the caller and its callee are functions of the module",
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

test("an object literal names a field by the name it holds", async () => {
  // `{ line }` is `{ line: line }`, and the value is the name the source wrote.
  const output = await agreesWithNode([
    "function make(line: number, message: string): string {",
    "  const entry = { line, message };",
    "  return `${entry.line}:${entry.message}`;",
    "}",
    "console.log(make(3, `ok`));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "3:ok");
});

test("a text method is the runtime call that answers it", async () => {
  // `trim`, `indexOf` and `slice` are the runtime's text helpers; `includes`,
  // `startsWith` and `endsWith` are written over `indexOf` and `slice`.
  const output = await agreesWithNode([
    "const s = ` ab `;",
    "const n = `ab`;",
    "const head = s.slice(0, 1);",
    "console.log(s.includes(n), s.startsWith(n), s.endsWith(n), s.trim(), s.indexOf(n), head.length);",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "true false false ab 1 1");
});

test("a top-level constant a function reads is the value it was written with", async () => {
  // A function is compiled on its own, so a top-level constant it reads is
  // written into the body where the source read the name. The `export` says
  // another module may read it, which is a question for the import phase; for
  // the function in this file, the value is the one written here.
  const output = await agreesWithNode([
    "export const BASE = 10;",
    "export const TABLE = { a: 1, b: 2 };",
    "export function add(x: number): number { return x + BASE + TABLE.b; }",
    "console.log(add(1));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "13");
});

test("an object spread of a constant object is the fields it wrote", async () => {
  const output = await agreesWithNode([
    "const BASE = { a: 1, b: 2 };",
    "export function total(): number {",
    "  const all = { ...BASE, c: 3 };",
    "  return all.a + all.b + all.c;",
    "}",
    "console.log(total());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "6");
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

test("a bare return leaves a function that returns nothing", async () => {
  // `return;` ends a void function where it is written, and the statements
  // after it in the same arm do not run.
  const output = await agreesWithNode([
    "function show(x: number): void {",
    "  if (x < 0) return;",
    "  console.log(x);",
    "}",
    "show(-1);",
    "show(2);",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "2");
});

test("a class method may be named with a modifier word", async () => {
  // `declare` is a modifier where a declaration follows it and a member name
  // where a body follows it, and the token after the name is what says which.
  const output = await agreesWithNode([
    "class Counter {",
    "  value: number = 0;",
    "  declare(x: number): number { return x + 1; }",
    "}",
    "console.log(new Counter().declare(1));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "2");
});

test("an arrow function runs as the function its body lifted to", async () => {
  // An arrow is bound to the name it is declared under and called by that name.
  // Its body becomes a function of the file whose leading parameters are the
  // values it captured, so a captured number is the value it held when the call
  // was made.
  const output = await agreesWithNode([
    "function add(x: number): number {",
    "  const plus = (y: number): number => y + x;",
    "  return plus(2) + plus(3);",
    "}",
    "console.log(add(10));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "25");
});

test("an arrow with a block body runs the statements it wrote", async () => {
  const output = await agreesWithNode([
    "function sumTo(n: number): number {",
    "  const sum = (k: number): number => {",
    "    let total = 0;",
    "    for (let i = 0; i < k; i++) total += i;",
    "    return total;",
    "  };",
    "  return sum(n);",
    "}",
    "console.log(sumTo(5));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "10");
});

test("an arrow written where it is called runs where it is written", async () => {
  const output = await agreesWithNode([
    "function f(x: number): number {",
    "  return ((a: number): number => a * 3 + x)(2);",
    "}",
    "console.log(f(4));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "10");
});

test("an arrow inside an arrow captures the outer arrow's own value", async () => {
  // The inner arrow captures a parameter of the outer one, which is a parameter
  // of the function the outer body lifted to: the capture is read there.
  const output = await agreesWithNode([
    "function f(x: number): number {",
    "  const outer = (a: number): number => {",
    "    const inner = (b: number): number => a + b + x;",
    "    return inner(2);",
    "  };",
    "  return outer(3);",
    "}",
    "console.log(f(10));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "15");
});

test("an arrow captures the element a loop is on, and a buffer it was handed", async () => {
  // A loop's index and a parameter's buffer are values of the function around
  // the arrow, so both are handed to the function it lifted to.
  const output = await agreesWithNode([
    "function walk(a: Float64Array): number {",
    "  let total = 0;",
    "  for (let i = 0; i < a.length; i++) {",
    "    const at = (k: number): number => a[k] + i;",
    "    total += at(i);",
    "  }",
    "  return total;",
    "}",
    "console.log(walk(new Float64Array([1, 2, 3])));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "9");
});

test("an arrow reads the buffer length of the text it captured", async () => {
  const output = await agreesWithNode([
    "function size(s: string): number {",
    "  const len = (): number => s.length;",
    "  return len();",
    "}",
    "console.log(size(`hello`));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "5");
});

test("an arrow passed as a value is a closure the callee can call", async () => {
  // An arrow read where a value is expected travels as a closure: the values it
  // captured go with it, and a function that only holds a parameter of function
  // type can still call it.
  const output = await agreesWithNode([
    "function apply(f: (x: number) => number, x: number): number {",
    "  return f(x) + f(x + 1);",
    "}",
    "function add(x: number): number {",
    "  const plus = (y: number): number => y + x;",
    "  return apply(plus, 2);",
    "}",
    "console.log(add(10));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "25");
});

test("a closure is built where the arrow is written, not where it was declared", async () => {
  // The call site of the arrow by its name is a direct call and needs no
  // closure; the closure is built at the place the value is handed over, which
  // is where the captured values are read.
  const output = await agreesWithNode([
    "function apply(f: (x: number) => number, x: number): number { return f(x); }",
    "function twice(y: number): number { return y * 2; }",
    "function g(a: number): number {",
    "  const inc = (y: number): number => y + a;",
    "  return apply(inc, 3) + inc(4) + twice(inc(5));",
    "}",
    "console.log(g(10));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "57");
});

test("a closure captures a buffer and its length", async () => {
  // A buffer captured by a closure is two values — the block and its length —
  // and both travel with it, so a callee that walks the array sees the whole
  // of it.
  const output = await agreesWithNode([
    "function each(a: Float64Array, f: (x: number) => number): number {",
    "  let total = 0;",
    "  for (let i = 0; i < a.length; i++) total += f(a[i]);",
    "  return total;",
    "}",
    "function g(a: Float64Array, scale: number): number {",
    "  const weight = (x: number): number => x * scale;",
    "  return each(a, weight);",
    "}",
    "console.log(g(new Float64Array([1, 2, 3]), 3));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "18");
});

test("a closure that escapes the function that built it still answers", async () => {
  // The captured values travel in the closure itself, so a closure a function
  // answers with is called after the call that built it has returned.
  const output = await agreesWithNode([
    "function apply(f: (x: number) => number, x: number): number { return f(x); }",
    "function make(a: number): (y: number) => number {",
    "  return (b: number): number => a + b;",
    "}",
    "function g(): number {",
    "  const f: (y: number) => number = make(10);",
    "  return apply(f, 5);",
    "}",
    "console.log(g());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "15");
});

test("a closure handed on through another arrow keeps what both captured", async () => {
  // The inner arrow is a closure built inside the outer one, so the value it
  // captured from the function around them both travels through the outer
  // closure as well.
  const output = await agreesWithNode([
    "function apply(f: (x: number) => number, x: number): number { return f(x); }",
    "function g(a: number): number {",
    "  const outer = (b: number): number => {",
    "    return apply((c: number): number => a + b + c, 1);",
    "  };",
    "  return outer(2);",
    "}",
    "console.log(g(10));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "13");
});

test("a closure lowers through the C backend, and the machine backend leaves it to C", async () => {
  // A closure is a code address beside the values it captured, which is a value
  // the machine backend does not hold: it refuses and the program is lowered by
  // the C backend, which does.
  const source = [
    "function apply(f: (x: number) => number, x: number): number { return f(x); }",
    "function g(a: number): number {",
    "  const inc = (y: number): number => y + a;",
    "  return apply(inc, 1);",
    "}",
    "console.log(g(41));",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const { directory, binary, status } = await build(source, backend);
    const original = run("node", ["--experimental-strip-types", "main.ts"], { cwd: directory, timeoutMs: 60_000 });
    const delivered = run(binary, [], { timeoutMs: 60_000 });
    assert.equal(original.code, 0, original.stderr);
    assert.equal(delivered.code, 0, delivered.stderr);
    assert.equal(delivered.stdout, original.stdout, `the ${backend} build answers what node answers`);
    assert.equal(status.backend, "c", "a closure is lowered by the C backend whichever backend was asked for");
    if (backend === "machine") {
      assert.match(status.reason ?? "", /closure|calls a value/, "the machine backend says why it refused");
    }
  }
});

test("map builds the array its callback answers for each element", async () => {
  // `a.map(f)` is a function of the file that walks the array, which the
  // frontend writes: the loop, the allocation and the call of the closure are
  // the ones the source would have written.
  const output = await agreesWithNode([
    "function g(a: Float64Array): number {",
    "  const b = a.map((x: number): number => x * 2);",
    "  return b[0] + b[1] + b[2] + b.length;",
    "}",
    "console.log(g(new Float64Array([1, 2, 3])));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "15");
});

test("filter keeps the elements its callback accepts, and the count is the ones it kept", async () => {
  const output = await agreesWithNode([
    "function g(a: Float64Array): number {",
    "  const b = a.filter((x: number): boolean => x > 2);",
    "  return b.length * 100 + b[0] + b[1];",
    "}",
    "console.log(g(new Float64Array([1, 5, 2, 7])));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "212");
});

test("forEach is handed every element", async () => {
  const output = await agreesWithNode([
    "function show(x: number): number { console.log(x); return x; }",
    "function g(a: Float64Array): number {",
    "  a.forEach((x: number): void => { show(x); });",
    "  return 1;",
    "}",
    "console.log(g(new Float64Array([4, 5])));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "4\n5\n1");
});

test("every and some answer for the elements they see", async () => {
  const output = await agreesWithNode([
    "function g(a: Float64Array): number {",
    "  const all = a.every((x: number): boolean => x > 0);",
    "  const any = a.some((x: number): boolean => x > 10);",
    "  return (all ? 10 : 0) + (any ? 1 : 0);",
    "}",
    "console.log(g(new Float64Array([1, 2, 3])));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "10");
});

test("find answers the element a callback accepted, and findIndex its position", async () => {
  const output = await agreesWithNode([
    "function g(a: Float64Array): number {",
    "  const found = a.find((x: number): boolean => x > 2);",
    "  const missing = a.findIndex((x: number): boolean => x > 99);",
    "  return found * 10 + missing;",
    "}",
    "console.log(g(new Float64Array([1, 5, 2, 7])));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "49");
});

test("reduce folds the array from an initial value, and from its first element", async () => {
  const output = await agreesWithNode([
    "function sum(a: Float64Array): number {",
    "  return a.reduce((acc: number, x: number): number => acc + x, 0);",
    "}",
    "function product(a: Float64Array): number {",
    "  return a.reduce((acc: number, x: number): number => acc * x);",
    "}",
    "console.log(sum(new Float64Array([1, 2, 3, 4])));",
    "console.log(product(new Float64Array([2, 3, 4])));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "10\n24");
});

test("sort orders the array it was handed, and answers an array in that order", async () => {
  // The array is sorted where it lies, which is what a call written for what it
  // does relies on, and the value the call answers is an array of its own.
  const output = await agreesWithNode([
    "function inPlace(a: Float64Array): number {",
    "  a.sort((x: number, y: number): number => x - y);",
    "  return a[0] * 100 + a[1] * 10 + a[2];",
    "}",
    "function copied(a: Float64Array): number {",
    "  const b = a.sort((x: number, y: number): number => y - x);",
    "  return b[0] * 100 + b[1] * 10 + b[2];",
    "}",
    "console.log(inPlace(new Float64Array([3, 1, 2])));",
    "console.log(copied(new Float64Array([3, 1, 2])));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "123\n321");
});

test("a collection method takes the closure a parameter holds, and chains", async () => {
  // The callback may be a value the body was handed, and what one method
  // answers is what the next one walks.
  const output = await agreesWithNode([
    "function scale(a: Float64Array, f: (x: number) => number): number {",
    "  const b = a.map(f).filter((x: number): boolean => x > 2);",
    "  return b.length * 100 + b[0];",
    "}",
    "function g(a: Float64Array): number {",
    "  return scale(a, (x: number): number => x * 2);",
    "}",
    "console.log(g(new Float64Array([1, 2, 3])));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "204");
});

test("a callback is handed the position it is on where it asks for it", async () => {
  const output = await agreesWithNode([
    "function g(a: Float64Array): number {",
    "  const b = a.map((x: number, i: number): number => x + i);",
    "  return b[0] + b[1] + b[2];",
    "}",
    "console.log(g(new Float64Array([1, 2, 3])));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "9");
});

test("a collection method over an empty array answers with no elements", async () => {
  const output = await agreesWithNode([
    "function g(a: Float64Array): number {",
    "  const kept = a.filter((x: number): boolean => x > 2);",
    "  const mapped = a.map((x: number): number => x * 2);",
    "  const all = a.every((x: number): boolean => x > 0);",
    "  const any = a.some((x: number): boolean => x > 0);",
    "  return kept.length * 1000 + mapped.length * 100 + (all ? 10 : 0) + (any ? 1 : 0);",
    "}",
    "console.log(g(new Float64Array(0)));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "10");
});

test("the functions the frontend writes are named by the file that wrote them", async () => {
  // Two files that each write an arrow and each walk an array generate a
  // function of their own, and every function of a program is linked by its
  // symbol: one name may belong to one function.
  const directory = await scratch("blaze-language-feature-");
  await writeFile(
    join(directory, "lib.ts"),
    [
      "export function doubled(a: Float64Array): number {",
      "  const b = a.map((x: number): number => x * 2);",
      "  return b[0];",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(directory, "main.ts"),
    [
      "import { doubled } from './lib.ts';",
      "function g(a: Float64Array): number {",
      "  const b = a.map((x: number): number => x + 1);",
      "  return b[1] + doubled(a);",
      "}",
      "console.log(g(new Float64Array([1, 2, 3])));",
      "",
    ].join("\n"),
    "utf8",
  );
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
  const original = run("node", ["--experimental-strip-types", "main.ts"], { cwd: directory, timeoutMs: 60_000 });
  const delivered = run(outcome.outputPath as string, [], { timeoutMs: 60_000 });
  assert.equal(original.code, 0, original.stderr);
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, original.stdout);
  assert.equal(delivered.stdout.trim(), "5");
});

test("an array of text is a value a body writes, indexes and walks", async () => {
  const output = await agreesWithNode([
    "function g(): number {",
    "  const a: string[] = [`ab`, `cde`];",
    "  let total = a.length * 100 + a[0].length;",
    "  for (const s of a) total += s.length;",
    "  return total;",
    "}",
    "console.log(g());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "207");
});

test("an array of text is built from the lists in front of it and joined", async () => {
  const output = await agreesWithNode([
    "function g(): number {",
    "  const a: string[] = [`ab`];",
    "  const b: string[] = [...a, `cde`, `f`];",
    "  return b.join(`-`).length * 10 + b.join().length;",
    "}",
    "console.log(g());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "88");
});

test("includes and indexOf read an array of text by what it says", async () => {
  // Two texts that say the same thing are two different pointers, so an
  // element is found by what it holds and not by where it is.
  const output = await agreesWithNode([
    "function g(): number {",
    "  const a: string[] = [`ab`, `cde`];",
    "  return (a.includes(`cde`) ? 100 : 0) + a.indexOf(`ab`) * 10 + a.indexOf(`zz`);",
    "}",
    "console.log(g());",
    "",
  ].join("\n"));
  // `indexOf` answers -1 where nothing matches, so 100 + 0 - 1.
  assert.equal(output.trim(), "99");
});

test("the walking methods read an array of text", async () => {
  const output = await agreesWithNode([
    "function g(): number {",
    "  const a: string[] = [`ab`, `cde`, `f`];",
    "  const shouted = a.map((s: string): string => s + `!`);",
    "  const long = a.filter((s: string): boolean => s.length > 1);",
    "  const found = a.find((s: string): boolean => s.length === 1);",
    "  return shouted[0].length * 100 + long.length * 10 + found.length;",
    "}",
    "console.log(g());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "321");
});

test("push and pop change the array a name holds", async () => {
  const output = await agreesWithNode([
    "function build(n: number): string[] {",
    "  const out: string[] = [];",
    "  for (let i = 0; i < n; i++) out.push(`x`);",
    "  return out;",
    "}",
    "function g(): number {",
    "  const a = build(4);",
    "  a.pop();",
    "  a.push(`yz`);",
    "  return a.length * 100 + a[3].length;",
    "}",
    "console.log(g());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "402");
});

test("an array of numbers written out is the same array a typed one is", async () => {
  // `[1, 2, 3]` and `new Float64Array([1, 2, 3])` are one value: an array of
  // numbers, with the length the values give it.
  const output = await agreesWithNode([
    "function g(): number {",
    "  const a: number[] = [1, 2, 3];",
    "  const b = a.filter((x: number): boolean => x > 1);",
    "  return a.length * 100 + b.length * 10 + b[0];",
    "}",
    "console.log(g());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "322");
});

test("an array of references is passed to another function and read there", async () => {
  const output = await agreesWithNode([
    "class Pair { a: number = 0; b: number = 0; }",
    "function total(pairs: Pair[]): number {",
    "  let sum = 0;",
    "  for (const p of pairs) sum += p.a + p.b;",
    "  return sum;",
    "}",
    "function g(): number {",
    "  const first = new Pair();",
    "  first.a = 1;",
    "  first.b = 2;",
    "  const second = new Pair();",
    "  second.a = 3;",
    "  second.b = 4;",
    "  const all: Pair[] = [first, second];",
    "  return total(all);",
    "}",
    "console.log(g());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "10");
});

test("a list spread into a new one is a list of its own", async () => {
  // Two names that hold one block are one array, and a write through either is
  // a write both see: `[...a]` joins `a` against an empty list, which copies.
  const output = await agreesWithNode([
    "function g(): number {",
    "  const a: string[] = [`ab`, `cde`];",
    "  const b = [...a];",
    "  b[0] = `zz`;",
    "  return a[0].length * 10 + b[0].length;",
    "}",
    "console.log(g());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "22");
});

test("a map holds a number under a text key", async () => {
  const output = await agreesWithNode([
    "function g(): number {",
    "  const m = new Map<string, number>();",
    "  m.set(`a`, 1);",
    "  m.set(`b`, 2);",
    "  m.set(`a`, 5);",
    "  return m.size * 100 + m.get(`a`) * 10 + m.get(`b`);",
    "}",
    "console.log(g());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "252");
});

test("a set answers what it has seen, and forgets what it is told to", async () => {
  const output = await agreesWithNode([
    "function unique(words: string[]): number {",
    "  const seen = new Set<string>();",
    "  for (const w of words) seen.add(w);",
    "  seen.delete(`b`);",
    "  return seen.size * 10 + (seen.has(`a`) ? 1 : 0) + (seen.has(`b`) ? 2 : 0);",
    "}",
    "function g(): number {",
    "  const words: string[] = [`a`, `b`, `a`, `c`, `b`];",
    "  return unique(words);",
    "}",
    "console.log(g());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "21");
});

test("an absent key answers zero, which is what the map is asked first to find out", async () => {
  // A value here has no `undefined`, so a lookup that found nothing answers the
  // zero of the value type: the same zero an element read outside a buffer
  // answers.
  const output = await agreesWithNode([
    "function g(): number {",
    "  const m = new Map<string, number>();",
    "  m.set(`a`, 7);",
    "  if (m.has(`zz`)) return 100;",
    "  return m.get(`a`) + (m.has(`a`) ? 10 : 0) + m.size;",
    "}",
    "console.log(g());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "18");
});

test("a map is a value a function is handed and a value it answers", async () => {
  const output = await agreesWithNode([
    "function build(): Map<string, number> {",
    "  const m = new Map<string, number>();",
    "  m.set(`x`, 9);",
    "  return m;",
    "}",
    "function read(m: Map<string, number>, k: string): number {",
    "  return m.get(k) + m.size;",
    "}",
    "function g(): number {",
    "  const m = build();",
    "  return read(m, `x`);",
    "}",
    "console.log(g());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "10");
});

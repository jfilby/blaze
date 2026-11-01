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
  files: Record<string, string> = {},
): Promise<{ directory: string; binary: string; status: { backend: string; reason?: string } }> {
  const directory = await scratch("blaze-language-feature-");
  for (const [name, text] of Object.entries(files)) await writeFile(join(directory, name), text, "utf8");
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
async function agreesWithNode(source: string, files: Record<string, string> = {}): Promise<string> {
  const { directory, binary } = await build(source, undefined, files);
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

test("a text is trimmed at one end and keeps the other", async () => {
  // A line read out of a file carries its newline at the back, and a field cut
  // out of a line carries the space that was written in front of it: one end
  // at a time is what the source asks for.
  const output = await agreesWithNode([
    "export function cut(line: string): string {",
    "  return line.trimStart() + `|` + line.trimEnd();",
    "}",
    "console.log(cut(`  hi  `));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "hi  |  hi");
});

test("a number is read out of a text in base ten", async () => {
  // `Number.parseInt(text, 10)` is the number the text states, which is the
  // reading `parseInt` already does. The radix is the one the language writes.
  const output = await agreesWithNode(
    ['import { read } from "./lib.ts";', "console.log(read(`42`));", ""].join("\n"),
    {
      "lib.ts": [
        "export function read(text: string): number {",
        "  return Number.parseInt(text, 10);",
        "}",
        "",
      ].join("\n"),
    },
  );
  assert.equal(output.trim(), "42");
});

test("a push with a spread joins the list it names", async () => {
  // The elements a spread stands for are the ones the list holds, so the push
  // is the list it appends to joined with the one it was handed: the
  // concatenation two lists added are. Values written beside a spread join as
  // one-element lists, in the order the source wrote them.
  const output = await agreesWithNode([
    "function total(): number {",
    "  const all: number[] = [1];",
    "  const more: number[] = [2, 3];",
    "  all.push(...more);",
    "  all.push(4, ...more);",
    "  let sum = 0;",
    "  for (const x of all) sum += x;",
    "  return sum;",
    "}",
    "console.log(total());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "15");
});

test("a set written at the top of a module answers its membership", async () => {
  // The keys are written down, so the membership is the comparisons it means
  // and no dictionary is allocated: a function of the module reads the name
  // without the module being a program that holds it.
  const output = await agreesWithNode(
    [
      'import { score, allowed } from "./lib.ts";',
      "console.log(score(`a`) + score(`b`) + score(`c`) + allowed());",
      "",
    ].join("\n"),
    {
      "lib.ts": [
        'const ALLOWED: ReadonlySet<string> = new Set(["a", "c"]);',
        "export function score(x: string): number {",
        "  return ALLOWED.has(x) ? 10 : 0;",
        "}",
        "export function allowed(): number { return ALLOWED.size; }",
        "",
      ].join("\n"),
    },
  );
  assert.equal(output.trim(), "22");
});

test("a map written at the top of a module answers the value of a key", async () => {
  const output = await agreesWithNode(
    [
      'import { weigh, counted } from "./lib.ts";',
      "console.log(weigh(`a`) + weigh(`b`) + counted());",
      "",
    ].join("\n"),
    {
      "lib.ts": [
        'const WEIGHT = new Map([["a", 2], ["b", 5]]);',
        "export function weigh(x: string): number {",
        "  return WEIGHT.get(x);",
        "}",
        "export function counted(): number { return WEIGHT.size; }",
        "",
      ].join("\n"),
    },
  );
  assert.equal(output.trim(), "9");
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

test("the names and values of a constant object are arrays", async () => {
  const output = await agreesWithNode([
    "const TABLE = { a: 1, b: 2 };",
    "export function total(): number {",
    "  const names = Object.keys(TABLE);",
    "  const values = Object.values(TABLE);",
    "  return names.length + values[0] + values[1];",
    "}",
    "console.log(total());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "5");
});

test("a for-of walks a list written where the loop names it", async () => {
  // The loop names the array it walks, because it reads the length before the
  // first element and again between elements. A list written where the name
  // goes is read once into a name of the loop's own before it starts.
  const output = await agreesWithNode([
    "function total(): number {",
    "  let sum = 0;",
    "  for (const x of [1, 2, 3]) sum += x;",
    "  return sum;",
    "}",
    "console.log(total());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "6");
});

test("a parameter written as a pattern binds the names it writes", async () => {
  // `{ a, b: c }` and `[a, b]` name no value of their own: the value is the one
  // the caller hands over, and each name is a declaration read out of it.
  const output = await agreesWithNode([
    "function sum({ a, b: c }: { a: number; b: number }): number {",
    "  return a + c;",
    "}",
    "function pair([a, b]: number[]): number {",
    "  return a * b;",
    "}",
    "console.log(sum({ a: 1, b: 2 }), pair([3, 4]));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "3 12");
});

test("an arrow function's parameter may be written as a pattern", async () => {
  const output = await agreesWithNode([
    "function total(): number {",
    "  const add = ([a]: number[]) => a;",
    "  const row: number[] = [7, 8];",
    "  return add(row);",
    "}",
    "console.log(total());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "7");
});

test("a list may end with a comma, as may a list of parameters", async () => {
  const output = await agreesWithNode([
    "function add(a: number, b: number,): number {",
    "  return a + b;",
    "}",
    "console.log(add(1, 2,));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "3");
});

test("a for-of names the parts of the element it walks", async () => {
  // `for (const [a, b] of rows)` binds the parts of one element rather than the
  // element: the loop walks a name of its own and each name is read out of it.
  const output = await agreesWithNode([
    "function total(): number {",
    "  const rows: number[][] = [[1, 2], [3, 4]];",
    "  let sum = 0;",
    "  for (const [a, b] of rows) sum += a + b;",
    "  return sum;",
    "}",
    "console.log(total());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "10");
});

test("a for loop with no condition runs until its body breaks", async () => {
  // `for (;;)` names no index and states no condition, so it is the loop whose
  // only way out is the break its body writes.
  const output = await agreesWithNode([
    "function firstPowerOfTwo(n: number): number {",
    "  let value = 1;",
    "  for (;;) {",
    "    if (value >= n) break;",
    "    value *= 2;",
    "  }",
    "  return value;",
    "}",
    "console.log(firstPowerOfTwo(10));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "16");
});

test("a getter is a method a member read calls", async () => {
  // `get double()` is a body with no parameters whose name is read as a member:
  // the read is the call, and a getter may read another getter.
  const output = await agreesWithNode([
    "class Counter {",
    "  n: number = 3;",
    "  get double(): number { return this.n * 2; }",
    "  get triple(): number { return this.double + this.n; }",
    "  static get zero(): number { return 0; }",
    "}",
    "const counter = new Counter();",
    "console.log(counter.double, counter.triple, Counter.zero);",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "6 9 0");
});

test("a number may write a separator between its digits", async () => {
  // `600_000` names the value of its digits: the separator is for reading, and
  // the parser writes the digits without it.
  const output = await agreesWithNode([
    "function big(): number { return 600_000; }",
    "function mask(): number { return 0xF_F; }",
    "function tenth(): number { return 1e1_0; }",
    "function wide(): bigint { return 1_000n; }",
    "console.log(big(), mask(), tenth(), wide());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "600000 255 10000000000 1000n");
});

test("a block written as a statement is the statements it holds", async () => {
  // A nested block is a scope of the source, not a construct the program runs:
  // the body it belongs to holds its statements in order. A switch case may
  // write its statements in a block the same way.
  const output = await agreesWithNode([
    "function pick(n: number): number {",
    "  switch (n) {",
    "    case 1: {",
    "      const base = 10;",
    "      return base + 2;",
    "    }",
    "    default: {",
    "      return 0;",
    "    }",
    "  }",
    "}",
    "function scoped(n: number): number {",
    "  {",
    "    const twice = n * 2;",
    "    return twice;",
    "  }",
    "}",
    "console.log(pick(1), pick(2), scoped(5));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "12 0 10");
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

test("an optional element is read once and holds the element's type", async () => {
  // The value before `?.` is the condition and the value inside the branch, so
  // a position it computes is written into a name first rather than computed
  // twice. A chain that answers a number is the number beside the absence of
  // one, not a dynamic value beside it: a choice of a number and `NULL` is not
  // a conditional expression, and every backend refused it.
  const output = await agreesWithNode(
    ["import { report } from `./optional.ts`;", "report();", ""].join("\n").replace(/`/g, '"'),
    {
      "optional.ts": [
        "export function has(names: string[], at: number): number {",
        "  return names[at + 1]?.length ? 1 : 0;",
        "}",
        "export function report(): void {",
        "  const names = [`a`, `bb`];",
        "  console.log(has(names, 0));",
        "  console.log(has(names, 5));",
        "  console.log(has(names, 1));",
        "}",
        "",
      ].join("\n").replace(/`/g, '"'),
    },
  );
  assert.equal(output.trim(), "1\n0\n0");
});

test("JSON writes a value as the text it is", async () => {
  // `JSON.stringify` is a text in the language: a map key, a template and a
  // concatenation all read it as one. A list and an object written where the
  // call is are the text their values spell, so a list may hold a text and a
  // number in the same call and needs no dynamic array.
  const files = {
    "json.ts": [
      "export function number(x: number): string { return JSON.stringify(x); }",
      "export function text(x: string): string { return JSON.stringify(x); }",
      "export function list(name: string, at: number): string { return JSON.stringify([name, at]); }",
      "export function shape(): string { return JSON.stringify({ a: 1, b: `two` }); }",
      "export function both(x: string): string { return JSON.stringify(JSON.parse(x)); }",
      "export function keyed(): number {",
      "  const seen = new Map<string, number>();",
      "  seen.set(JSON.stringify([`k`, 1]), 7);",
      "  return seen.get(JSON.stringify([`k`, 1]));",
      "}",
      "",
    ].join("\n"),
  };
  const source = [
    'import { number, text, list, shape, both, keyed } from "./json.ts";',
    "console.log(number(42));",
    'console.log(text("hi"));',
    'console.log(list("a", 2));',
    "console.log(shape());",
    'console.log(both("[1,2,3]"));',
    'console.log(both("{\\"a\\":1}"));',
    "console.log(keyed());",
    "",
  ].join("\n");
  const output = await agreesWithNode(source, files);
  assert.equal(
    output.trim(),
    ['42', '"hi"', '["a",2]', '{"a":1,"b":"two"}', "[1,2,3]", '{"a":1}', "7"].join("\n"),
  );
  // The C backend reads the same IR, so the same program lands on the same
  // text there too.
  const { directory, binary } = await build(source, "c", files);
  const original = run("node", ["--experimental-strip-types", "main.ts"], { cwd: directory, timeoutMs: 60_000 });
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, original.stdout);
});

test("a text a method answers is a text", async () => {
  // What a call answers is the callee's to say, and a method is a function the
  // class scan wrote rather than a declaration of the body. Without the type
  // the declaration writes for its result, `this.read().trim()` was a text
  // method written on nothing and was refused.
  const output = await agreesWithNode([
    "class Reader {",
    "  private label: string;",
    "  constructor(label: string) { this.label = label; }",
    "  text(): string { return this.label; }",
    "  static empty(): string { return `  `; }",
    "  get banner(): string { return `[${this.label}]`; }",
    "}",
    "class Trimmed {",
    "  private reader: Reader;",
    "  constructor(reader: Reader) { this.reader = reader; }",
    "  run(): string {",
    "    const first = this.reader.text().trim().toUpperCase();",
    "    const second = Reader.empty().trim();",
    "    const third = this.reader.banner.trim();",
    "    return `${first}:${second.length}:${third}`;",
    "  }",
    "}",
    "console.log(new Trimmed(new Reader(`  hi  `)).run());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "HI:0:[  hi  ]");
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

test("a regular expression reads, cuts, replaces and walks the texts it matches", async () => {
  // A pattern and its flags are the two texts a variable holds, and the
  // runtime compiles the pair: `test` and `exec` are the expression's own
  // methods, and `replace`, `split`, `matchAll` and `search` are the text's.
  const source = [
    "const ID = /^([A-Za-z_][A-Za-z0-9_]*)/;",
    "function check(s: string): number {",
    "  let n = 0;",
    "  if (ID.test(s)) n += 1;",
    "  const m = ID.exec(s);",
    "  if (m !== null && m[1] === `abc`) n += 10;",
    "  if (/^\\d+$/.test(s)) n += 100;",
    "  return n;",
    "}",
    "function parts(s: string): number { return s.split(/\\s+/).length; }",
    "function swap(s: string): string { return s.replace(/([a-z]+)-([a-z]+)/, `$2 $1`); }",
    "function letters(s: string): number {",
    "  let n = 0;",
    "  for (const match of s.matchAll(/[a-z]+/g)) n += match[0].length;",
    "  return n;",
    "}",
    "function where(s: string): number { return s.search(/[0-9]/); }",
    "function dynamic(s: string): boolean { return new RegExp(`^\\\\d+$`).test(s); }",
    "function insensitive(s: string): boolean { return /^abc$/i.test(s); }",
    "console.log(check(`abc`), check(`123`), parts(`a  b c`), swap(`one-two`), letters(`ab cd e`), where(`ab12`), dynamic(`42`), insensitive(`ABC`));",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const { directory, binary } = await build(source, backend);
    const original = run("node", ["--experimental-strip-types", "main.ts"], { cwd: directory, timeoutMs: 60_000 });
    const delivered = run(binary, [], { timeoutMs: 60_000 });
    assert.equal(original.code, 0, original.stderr);
    assert.equal(delivered.code, 0, delivered.stderr);
    assert.equal(delivered.stdout, original.stdout, `the ${backend} build answers what node answers`);
    assert.equal(delivered.stdout.trim(), "11 100 3 two one 5 2 true true");
  }
});

test("destructuring binds each name at the type of the value it reads", async () => {
  // A pattern names parts of a value rather than the value itself: an element
  // is the type the list holds, and a field is the type the object declares.
  // The two names therefore read text methods, whichever way the value was
  // written.
  const output = await agreesWithNode([
    "function second(parts: string[]): string {",
    "  const [, head, argument] = parts;",
    "  return head.trim() + `|` + argument.trim();",
    "}",
    "function both(text: string): string {",
    "  const parts = text.split(/\\s+/);",
    "  const [left, right] = parts;",
    "  return left.trim() + right.trim() + `|` + second(parts);",
    "}",
    "console.log(both(`left   a   b`));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "lefta|a|b");
});

test("a match a regular expression answers is read apart by the names the source binds", async () => {
  // `exec` answers the whole match and its groups as a list of texts, so a
  // pattern written over it reads each group at the text type the runtime
  // answers.
  const output = await agreesWithNode([
    "const PAIR = /^(\\w+)=(\\S+)$/;",
    "function read(text: string): string {",
    "  const match = PAIR.exec(text);",
    "  if (match === null) return ``;",
    "  const [, name, value] = match;",
    "  return `${name.trim()}:${value.trim()}`;",
    "}",
    "console.log(read(`who=blaze`), read(`none`));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "who:blaze");
});

test("a destructured field is typed by the result an interface declares", async () => {
  // The contract holds an interface as a reference and erases its fields, so
  // the shape the declaration writes is what keeps `left` a text. An object
  // literal is a record the file wrote field by field, and its fields are the
  // same way.
  const output = await agreesWithNode([
    "interface Pair { left: string; right: string }",
    "function pair(): Pair { return { left: ` a `, right: `b` }; }",
    "function read(): string {",
    "  const { left, right } = pair();",
    "  const { text } = { text: ` c ` };",
    "  return left.trim() + right + text.trim();",
    "}",
    "console.log(read());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "abc");
});

test("a class extends Error and super writes its message", async () => {
  // `extends Error` is the one base a compiled class may name: the base holds
  // the message `super(...)` writes, and every such class is an instance of
  // Error. The class's own fields sit beside it in the same layout.
  const output = await agreesWithNode([
    "class Failure extends Error {",
    "  readonly stage: string;",
    "  constructor(stage: string, message: string) { super(message); this.stage = stage; }",
    "  describe(): string { return `${this.stage}: ${this.message}`; }",
    "}",
    "const f = new Failure(`parse`, `bad`);",
    "console.log(f.describe());",
    "console.log(f instanceof Error);",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "parse: bad\ntrue");
});

test("a class another module declares is constructed by its name", async () => {
  // The constructor is a function of the module that declared the class, so a
  // call in another module names the same function; the class itself is not in
  // the importing file's table.
  const output = await agreesWithNode(
    [
      'import { Failure } from "./errors.ts";',
      "const f = new Failure(`bad`);",
      "console.log(f.message);",
      "",
    ].join("\n"),
    { "errors.ts": "export class Failure {\n  message: string;\n  constructor(message: string) { this.message = message; }\n}\n" },
  );
  assert.equal(output.trim(), "bad");
});

test("a top-level array of written values is read where a function uses it", async () => {
  // A function is compiled on its own and has no environment to read the
  // file's scope from, so an array the file wrote down — every element a value
  // the compiler can read without running anything — is written into the body
  // where the function uses it, unless a body writes the name.
  const output = await agreesWithNode(
    [
      'import { has, joined, count } from "./names.ts";',
      'console.log(has("ada"));',
      'console.log(has("bob"));',
      "console.log(joined());",
      "console.log(count());",
      "",
    ].join("\n"),
    {
      "names.ts": [
        'const NAMES: readonly string[] = ["ada", "grace"];',
        "export function has(name: string): boolean { return NAMES.includes(name); }",
        'export function joined(): string { return NAMES.join(","); }',
        "export function count(): number { return NAMES.length; }",
        "",
      ].join("\n"),
    },
  );
  assert.equal(output.trim(), "true\nfalse\nada,grace\n2");
});

test("typeof reads the type of a member, an element and a call", async () => {
  // A value that is not a name is typed by what it reads: the field an
  // interface declares, the element an array holds, and the result a function
  // answers. `typeof` reads that type instead of asking for a name.
  const output = await agreesWithNode(
    [
      'import { check } from "./typeof.ts";',
      "console.log(check(10, 20, 30));",
      "",
    ].join("\n"),
    {
      "typeof.ts": [
        "interface Named { name: string; count: number }",
        "function total(): number { return 42; }",
        "export function check(a: number, b: number, c: number): number {",
        "  const named: Named = { name: `x`, count: a };",
        "  const xs: string[] = [`a`, `b`];",
        "  let n = 0;",
        '  if (typeof named.name === "string") n += b;',
        '  if (typeof xs[0] === "string") n += c;',
        '  if (typeof total() === "number") n += 1;',
        '  if (typeof named.count === "number") n += 2;',
        '  if (typeof named === "object") n += 4;',
        "  return n;",
        "}",
        "",
      ].join("\n"),
    },
  );
  assert.equal(output.trim(), "57");
});

test("a short-circuited comparison holds at equality", async () => {
  // The branch on `a && b` asks each arm for its own sense, and the arm that
  // settles the whole reaches the branch directly. Reading the arm that did not
  // settle it through the flags the other comparison left answered `<=` and
  // `===` the wrong way at equality.
  const source = [
    "function classify(n: number): string {",
    "  if (n === n && n <= 100) return `at most`;",
    "  if (n === n && n === 100) return `equal`;",
    "  return `above`;",
    "}",
    "console.log(classify(100));",
    "console.log(classify(50));",
    "console.log(classify(101));",
    "",
  ].join("\n");
  const output = await agreesWithNode(source);
  assert.equal(output.trim(), "at most\nat most\nabove");
  // The C backend reads the same IR, so the same program lands on the same
  // text there too.
  const { directory, binary } = await build(source, "c");
  const original = run("node", ["--experimental-strip-types", "main.ts"], { cwd: directory, timeoutMs: 60_000 });
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, original.stdout);
});

test("a number question is answered out of the number itself", async () => {
  // `Number.isNaN`, `isFinite`, `isInteger` and `isSafeInteger` are operations
  // the language already has: a value unequal to itself, a difference that is
  // zero, a floor, and the bound the language names.
  const output = await agreesWithNode(
    [
      'import { classify, biggest, smallest } from "./numbers.ts";',
      "console.log(classify(3));",
      "console.log(classify(3.5));",
      "console.log(classify(1 / 0));",
      "console.log(classify(0 / 0));",
      "console.log(classify(biggest()));",
      "console.log(smallest());",
      "",
    ].join("\n"),
    {
      "numbers.ts": [
        "export function classify(x: number): string {",
        "  if (Number.isNaN(x)) return `nan`;",
        "  if (!Number.isFinite(x)) return `infinite`;",
        "  if (!Number.isInteger(x)) return `fraction`;",
        "  if (Number.isSafeInteger(x)) return `safe`;",
        "  return `big`;",
        "}",
        "export function biggest(): number { return Number.MAX_SAFE_INTEGER; }",
        "export function smallest(): number { return Number.MIN_SAFE_INTEGER; }",
        "",
      ].join("\n"),
    },
  );
  assert.equal(output.trim(), "safe\nfraction\ninfinite\nnan\nsafe\n-9007199254740991");
});

test("a record keyed by text is the runtime's dictionary", async () => {
  // `Record<string, V>` is the same dictionary `Map<string, V>` is: a field
  // written as a literal is one entry, `r[key]` reads one entry, and the own
  // keys of the record are the entries it holds. `Object.fromEntries` copies a
  // map's entries into one.
  const output = await agreesWithNode(
    [
      'import { make, get, count, has, copy, sum } from "./record.ts";',
      "const t = make();",
      'console.log(get(t, "a"));',
      'console.log(get(t, "c"));',
      "console.log(count(t));",
      'console.log(has(t, "b"));',
      'console.log(has(t, "z"));',
      'const c = copy();',
      'console.log(get(c, "x") + get(c, "y"));',
      "console.log(sum(t));",
      "",
    ].join("\n"),
    {
      "record.ts": [
        "export function make(): Record<string, number> {",
        "  const t: Record<string, number> = { a: 1, b: 2 };",
        '  t["c"] = 3;',
        "  return t;",
        "}",
        "export function get(t: Record<string, number>, k: string): number { return t[k]; }",
        "export function count(t: Record<string, number>): number { return Object.keys(t).length; }",
        "export function has(t: Record<string, number>, k: string): boolean {",
        "  return Object.prototype.hasOwnProperty.call(t, k);",
        "}",
        "export function copy(): Record<string, number> {",
        "  const m = new Map<string, number>();",
        '  m.set("x", 7);',
        '  m.set("y", 8);',
        "  return Object.fromEntries(m);",
        "}",
        "export function sum(t: Record<string, number>): number {",
        "  let total = 0;",
        "  for (const [key, value] of Object.entries(t)) total += value;",
        "  return total;",
        "}",
        "",
      ].join("\n"),
    },
  );
  assert.equal(output.trim(), "1\n3\n3\ntrue\nfalse\n15\n6");
});

test("a method on a field of an imported interface waits for the link", async () => {
  // A file is read before its imports are linked, so a parameter written at an
  // imported type is `any` on that read. A method written on a field of it is
  // not refused there: the read that follows the link holds the declaration and
  // reads the method against the field's own type.
  const output = await agreesWithNode(
    [
      'import { make } from "./names.ts";',
      'import { greeting } from "./greet.ts";',
      "console.log(greeting(make()));",
      "",
    ].join("\n"),
    {
      "names.ts": "export interface Name {\n  text: string;\n}\nexport function make(): Name {\n  return { text: `  ada  ` };\n}\n",
      "greet.ts": 'import { type Name } from "./names.ts";\nexport function greeting(name: Name): string {\n  return `hello ${name.text.trim()}`;\n}\n',
    },
  );
  assert.equal(output.trim(), "hello ada");
});

test("a text folds to lower or upper case", async () => {
  // The runtime folds the ASCII letters of the bytes the source wrote and
  // copies every other byte as it is, which is what the text helpers count.
  const source = [
    "function parse(word: string): number {",
    "  if (word.toLowerCase() === `yes`) return 1;",
    "  if (word.toUpperCase() === `NO`) return 2;",
    "  return 0;",
    "}",
    "function fold(word: string): string {",
    "  return word.toUpperCase() + word.toLowerCase();",
    "}",
    "console.log(parse(`YES`) * 10 + parse(`no`));",
    "console.log(fold(`aB_9!`));",
    "",
  ].join("\n");
  const output = await agreesWithNode(source);
  assert.equal(output.trim(), "12\nAB_9!ab_9!");
  // The C backend calls the same runtime helper, so the same program lands on
  // the same text.
  const { directory, binary } = await build(source, "c");
  const original = run("node", ["--experimental-strip-types", "main.ts"], { cwd: directory, timeoutMs: 60_000 });
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, original.stdout);
});

test("a text field of an object literal is a text when it is read", async () => {
  // The layout pass types a string literal as the text it is, so a field the
  // body wrote with one reads as text: `obj.text.trim()` is a text method and
  // `+` concatenates it. Typing the literal as a number made every such field
  // a number and refused the body.
  const output = await agreesWithNode([
    "function read(): string {",
    "  const pair = { left: ` a `, right: `b` };",
    "  return pair.left.trim() + pair.right;",
    "}",
    "console.log(read());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "ab");
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

test("String writes a value as the text a template string writes it as", async () => {
  // `String(x)` is the text a value is written as, which is the builder a
  // template string already uses.
  const output = await agreesWithNode([
    "function g(n: number, s: string): number {",
    "  return (String(n) + s).length + String(n).length;",
    "}",
    "console.log(g(12, `34`));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "6");
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

test("at reads one element and slice copies a range", async () => {
  // An index below zero counts back from the end, and a slice is a list of its
  // own: writing into it is not a write into the list it was taken from.
  const output = await agreesWithNode([
    "function g(): number {",
    "  const a: string[] = [`ab`, `cde`, `f`];",
    "  const b = a.slice(1, 3);",
    "  const c = a.slice(2);",
    "  b[0] = `zz`;",
    "  return a.at(-1).length * 100 + a.at(0).length * 10 + c.length + b[0].length;",
    "}",
    "console.log(g());",
    "",
  ].join("\n"));
  // 100 + 20 + 1 + 2.
  assert.equal(output.trim(), "123");
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

test("a collection callback reads its parameter as the element the array holds", async () => {
  // The element type of the array is the callback's parameter, so the source
  // writes no annotation and the body still reads a text.
  const output = await agreesWithNode([
    "function g(): number {",
    "  const a: string[] = [` ab `, `cde`, ` f `];",
    "  const trimmed = a.map((s) => s.trim());",
    "  const long = a.filter((s) => s.length > 1);",
    "  return trimmed[0].length * 100 + long.length * 10 + trimmed[2].length;",
    "}",
    "console.log(g());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "231");
});

test("sort and reduce read their parameters as the elements the array holds", async () => {
  const output = await agreesWithNode([
    "function g(): number {",
    "  const a: number[] = [3, 1, 2];",
    "  const ordered = a.sort((x, y) => x - y);",
    "  const sum = a.reduce((acc, x) => acc + x, 0);",
    "  return ordered[0] * 100 + ordered[2] * 10 + sum;",
    "}",
    "console.log(g());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "136");
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

test("a push of several values keeps every element in the order it was written", async () => {
  // The values are one more element each and the block grows once, so the
  // elements it keeps stay in front and the values follow in order.
  const output = await agreesWithNode([
    "function g(): string {",
    "  const a: string[] = [];",
    "  a.push(`a`, `b`, `c`);",
    "  const b: number[] = [9];",
    "  b.push(1, 2);",
    "  return `${a.length}${a.join(``)}${b.length}${b[0]}${b[2]}`;",
    "}",
    "console.log(g());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "3abc392");
});

test("a text split answers the fields the separator cuts", async () => {
  // The separator may be absent, may end the text, and may be several
  // characters; an empty one cuts the text into its characters.
  const output = await agreesWithNode([
    "function g(): string {",
    "  const a = `a,b,c`.split(`,`);",
    "  const b = `a,`.split(`,`);",
    "  const c = `abc`.split(`;`);",
    "  const d = `xyz`.split(``);",
    "  const e = `a::b`.split(`::`);",
    "  return `${a.length}${a[0]}${a[2]}${b.length}${b[1].length}${c.length}${c[0]}${d.length}${d[1]}${d[2]}${e.length}${e[1]}`;",
    "}",
    "console.log(g());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "3ac201abc3yz2b");
});

test("a nullish fallback keeps the type of the value it falls back from", async () => {
  // The field is a text the interface declares, and the fallback is a text:
  // the value the declaration binds is a text, so the trim written after it
  // is a text method rather than an unknown one.
  const output = await agreesWithNode([
    "interface Box { value?: string }",
    "function f(): string {",
    "  const box: Box = { value: `  x  ` };",
    "  const s = box.value ?? ``;",
    "  return s.trim();",
    "}",
    "console.log(f());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "x");
});

test("a template string that calls a collection helper uses the file's helper", async () => {
  // The expression inside `${...}` is part of the same file, so the walk and
  // the arrow it calls are functions of the file and not of a little file the
  // interpolation wrote for itself.
  const output = await agreesWithNode([
    "function g(): string {",
    "  const a: number[] = [1, 2, 3];",
    "  return `${a.map((x) => x * 2).join(`-`)}`;",
    "}",
    "console.log(g());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "2-4-6");
});

test("a declaration without a value starts at the zero of its type", async () => {
  // `let text: string;` states the type and leaves the value to the assignment
  // the source writes next. A value here has no absent one, so the name starts
  // at the zero of its type and the assignment replaces it before it is read.
  const output = await agreesWithNode([
    "function g(): number {",
    "  let text: string;",
    "  let n: number;",
    "  let flag: boolean;",
    "  let values: number[];",
    "  text = ` ab `;",
    "  n = 4;",
    "  flag = true;",
    "  values = [1, 2, 3];",
    "  return text.trim().length * 10 + (flag ? n : 0) + values.length;",
    "}",
    "console.log(g());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "27");
});

test("an empty list a function answers is a block of its own", async () => {
  // The list is built where it is returned, so it cannot be the frame of the
  // function that answered it: each call takes a block of its own, and a write
  // through one is not a write through the other.
  const output = await agreesWithNode([
    "function empty(): number[] {",
    "  return [];",
    "}",
    "function g(): number {",
    "  const a = empty();",
    "  const b = empty();",
    "  a.push(1);",
    "  b.push(2);",
    "  b.push(3);",
    "  return a.length * 10 + b.length;",
    "}",
    "console.log(g());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "12");
});

test("an empty list takes its element type from the use", async () => {
  // The ways the source writes an untyped list — a conditional arm, a `??`
  // fallback, an assertion, an object field, a nested list, and a call
  // argument — are built at the element type the use names, and an
  // unannotated conditional takes the element type of its other arm.
  const output = await agreesWithNode([
    "interface Box { values: number[]; }",
    "function takes(values: number[]): number { return 0; }",
    "function choose(flag: boolean): number {",
    "  const values: number[] = flag ? [] : [1, 2];",
    "  return values.length;",
    "}",
    "function fallback(values: number[] | null): number {",
    "  const kept = values ?? [];",
    "  return kept.length;",
    "}",
    "function asserted(): number {",
    "  const values = [] as number[];",
    "  return values.length;",
    "}",
    "function made(): Box { return { values: [] }; }",
    "function nested(): number {",
    "  const grid: number[][] = [[], [1]];",
    "  const row = grid[0];",
    "  return row.length;",
    "}",
    "function g(): number {",
    "  const box: Box = { values: [] };",
    "  const madeBox = made();",
    "  const inferred = false ? [] : [3, 4];",
    "  return choose(false) * 10000",
    "    + fallback(null) * 1000",
    "    + asserted() * 100",
    "    + madeBox.values.length * 10",
    "    + nested()",
    "    + inferred.length",
    "    + takes([])",
    "    + box.values.length;",
    "}",
    "console.log(g());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "20002");
});

test("an object spread copies the fields of a typed object", async () => {
  // `{ ...p, y: p.y + 1 }` is the fields of `p` copied into a new object, with
  // the field written after the spread replacing the one it copied: the value
  // `p` holds is not changed, and the copy is an object of its own.
  const output = await agreesWithNode([
    "interface Point { x: number; y: number }",
    "function moved(p: Point): Point {",
    "  const copy = { ...p, y: p.y + 1 };",
    "  return copy;",
    "}",
    "const a: Point = { x: 1, y: 2 };",
    "const b = moved(a);",
    "b.x = 7;",
    "console.log(`${a.x} ${a.y} ${b.x} ${b.y}`);",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "1 2 7 3");
});

test("a class field holds a list and grows it", async () => {
  // `private items: number[] = []` is a field whose type is the list the
  // initialiser writes, and `this.items.push(x)` writes the field back into the
  // object the method was called on.
  const output = await agreesWithNode([
    "class Bag {",
    "  private items: number[] = [];",
    "  add(value: number): void {",
    "    this.items.push(value);",
    "  }",
    "  size(): number {",
    "    return this.items.length;",
    "  }",
    "  total(): number {",
    "    let sum = 0;",
    "    for (const item of this.items) sum += item;",
    "    return sum;",
    "  }",
    "}",
    "const bag = new Bag();",
    "bag.add(3);",
    "bag.add(4);",
    "console.log(bag.size(), bag.total());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "2 7");
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

test("a map holds a reference, and a read answers the fields it names", async () => {
  const output = await agreesWithNode([
    "class Box {",
    "  value: number;",
    "  constructor(value: number) { this.value = value; }",
    "}",
    "function g(): number {",
    "  const m = new Map<string, Box>();",
    "  const a = new Box(7);",
    "  const b = new Box(3);",
    "  m.set(`a`, a);",
    "  m.set(`b`, b);",
    "  const found = m.get(`a`);",
    "  return found.value * 10 + m.size;",
    "}",
    "console.log(g());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "72");
});

test("a set holds references, and asks for the one it was given", async () => {
  const output = await agreesWithNode([
    "class Box {",
    "  value: number;",
    "  constructor(value: number) { this.value = value; }",
    "}",
    "function g(): number {",
    "  const s = new Set<Box>();",
    "  const a = new Box(1);",
    "  const b = new Box(2);",
    "  const from = new Set<Box>([a, b, a]);",
    "  s.add(a);",
    "  s.add(b);",
    "  s.add(a);",
    "  return s.size * 10 + from.size + (s.has(a) ? 1 : 0) + (s.has(b) ? 2 : 0);",
    "}",
    "console.log(g());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "25");
});

test("a map is built from entries and walked in the order they were written", async () => {
  const output = await agreesWithNode([
    "function g(): number {",
    "  const m = new Map<string, number>([[`a`, 1], [`b`, 2], [`c`, 3]]);",
    "  let total = 0;",
    "  for (const [k, v] of m) total += v;",
    "  for (const k of m.keys()) total += k.length;",
    "  for (const v of m.values()) total += v;",
    "  return total;",
    "}",
    "console.log(g());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "15");
});

test("a set is built from the elements written out", async () => {
  const output = await agreesWithNode([
    "function g(): number {",
    "  const s = new Set<string>([`a`, `b`, `a`]);",
    "  return s.size * 10 + (s.has(`a`) ? 1 : 0) + (s.has(`b`) ? 2 : 0);",
    "}",
    "console.log(g());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "23");
});

test("a map and a set are copied into collections of their own", async () => {
  const output = await agreesWithNode([
    "function g(): number {",
    "  const a = new Map<string, number>([[`a`, 1], [`b`, 2]]);",
    "  const b = new Map(a);",
    "  b.set(`c`, 3);",
    "  const first = new Set<string>([`a`, `b`]);",
    "  const second = new Set(first);",
    "  second.add(`c`);",
    "  return a.size * 100 + b.size * 10 + second.size;",
    "}",
    "console.log(g());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "233");
});

test("the values of a map of references are walked one by one", async () => {
  const output = await agreesWithNode([
    "class Box {",
    "  value: number;",
    "  constructor(value: number) { this.value = value; }",
    "}",
    "function g(): number {",
    "  const m = new Map<string, Box>();",
    "  m.set(`a`, new Box(2));",
    "  m.set(`b`, new Box(5));",
    "  let total = 0;",
    "  for (const b of m.values()) total += b.value;",
    "  return total;",
    "}",
    "console.log(g());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "7");
});

test("a map a function is handed is walked by its entries", async () => {
  const output = await agreesWithNode([
    "function read(m: Map<string, number>): number {",
    "  let total = 0;",
    "  for (const v of m.values()) total += v;",
    "  for (const k of m.keys()) total += k.length;",
    "  for (const [key, value] of m) total += value;",
    "  return total;",
    "}",
    "function g(): number {",
    "  const m = new Map<string, number>();",
    "  m.set(`a`, 2);",
    "  m.set(`bb`, 3);",
    "  return read(m);",
    "}",
    "console.log(g());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "13");
});

test("a list walked by its entries names the index and the element", async () => {
  // `entries()` of a list is a pair the source reads as position and element,
  // which no typed array holds: the loop walks the list by index instead.
  const output = await agreesWithNode([
    "function g(): string {",
    "  const names: string[] = [`ab`, `cde`, `f`];",
    "  let out = ``;",
    "  for (const [index, name] of names.entries()) out += String(index) + name;",
    "  return out;",
    "}",
    "console.log(g());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "0ab1cde2f");
});

test("an entry of a list read through a field names the element's fields", async () => {
  const output = await agreesWithNode([
    "class Item {",
    "  name: string;",
    "  constructor(name: string) { this.name = name; }",
    "}",
    "function g(items: Item[]): number {",
    "  let total = 0;",
    "  for (const [at, item] of items.entries()) total += at + item.name.length;",
    "  return total;",
    "}",
    "function main(): number {",
    "  const items: Item[] = [new Item(`ab`), new Item(`cde`)];",
    "  return g(items);",
    "}",
    "console.log(main());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "6");
});

test("a list spread from a call is joined with the values around it", async () => {
  // `[...rest.map(f)]` is a call's list joined with the empty list the copy
  // starts from, and the join is a list of the same elements: the method
  // written after it reads what the call answered.
  const output = await agreesWithNode([
    "function lines(): string {",
    "  const rest: string[] = [`a`, `b`];",
    "  return [`- head`, ...rest.map((line) => `  ${line}`)].join(`|`);",
    "}",
    "console.log(lines());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "- head|  a|  b");
});

test("a set spread into a list adds the keys it holds", async () => {
  // A set is a dictionary, so the handle a name holds is not an element a list
  // holds: the spread reads the keys it has out by position.
  const output = await agreesWithNode([
    "function g(): string {",
    "  const seen = new Set<string>();",
    "  seen.add(`a`);",
    "  seen.add(`b`);",
    "  const all = new Set<string>([...seen, `c`]);",
    "  let out = ``;",
    "  for (const key of all.keys()) out += key;",
    "  return out;",
    "}",
    "console.log(g());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "abc");
});

test("a map is keyed by a reference, and answers the text it holds", async () => {
  const output = await agreesWithNode([
    "class Box {",
    "  value: number;",
    "  constructor(value: number) { this.value = value; }",
    "}",
    "function g(): number {",
    "  const m = new Map<Box, string>();",
    "  const a = new Box(1);",
    "  const b = new Box(2);",
    "  m.set(a, `one`);",
    "  m.set(b, `two`);",
    "  let seen = 0;",
    "  for (const [box, text] of m) seen += box.value + text.length;",
    "  return (m.get(a) === `one` ? 10 : 0) + m.size + seen;",
    "}",
    "console.log(g());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "21");
});

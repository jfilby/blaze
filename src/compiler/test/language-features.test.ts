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
async function agreesWithNode(
  source: string,
  files: Record<string, string> = {},
  backend?: "c" | "machine",
): Promise<string> {
  const { directory, binary } = await build(source, backend, files);
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

test("a place that is not a name is stepped by one", async () => {
  // `this.tokens[i++]` is the element at the old `i`, and `i` is one more
  // afterwards. The place is read into a name of the statement's own and the
  // step happens beside the statement, so the value is the one the source read
  // even where the statement returns.
  const output = await agreesWithNode([
    "interface Cursor { position: number; tokens: string[] }",
    "export function demo(): string {",
    "  const cursor: Cursor = { position: 1, tokens: [`a`, `b`, `c`] };",
    "  const first = cursor.tokens[cursor.position++];",
    "  const second = cursor.tokens[cursor.position++];",
    "  return `${first}${second}${cursor.position}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "bc3");
});

test("a write goes through the place the source named in full", async () => {
  // A write is written to a place, and the place may be named by anything the
  // language names a value with: a cast, a field of a field, an element of a
  // field. The place is read into a name of the statement's own, so the value
  // before the last field is read once, and the write goes through that name —
  // which is the value the source named, because an object is a reference.
  const output = await agreesWithNode([
    "interface Nested { at: number }",
    "interface Box { value: number; nested: Nested }",
    "interface Holder { items: number[] }",
    "export function demo(): string {",
    "  const box: Box = { value: 0, nested: { at: 0 } };",
    "  const holder: Holder = { items: [1, 2, 3] };",
    "  (box as Box).nested.at = 7;",
    "  holder.items[1] = 9;",
    "  holder.items[2] += 4;",
    "  return `${box.nested.at + holder.items[1] + holder.items[2]}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "23");
});

test("a constructor with more than one default parameter is read", async () => {
  // A parameter default ends at the comma of its own parameter list, and a
  // field initialised with a generic call keeps the comma inside its type
  // arguments: the one ends the parameter and the other is part of the value.
  const output = await agreesWithNode([
    "class Box {",
    "  private readonly label: string;",
    "  private readonly count: number;",
    "  private readonly table = new Map<string, number>([[\`a\`, 1]]);",
    "  constructor(label: string = \`c\`, count: number = 2) {",
    "    this.label = label;",
    "    this.count = count;",
    "  }",
    "  value(): string { return \`\${this.label} \${this.count} \${this.table.size}\`; }",
    "}",
    "export function demo(): string { return new Box().value(); }",
    "console.log(demo());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "c 2 1");
});

test("a program erases the type of a value it casts and of a parameter it types", async () => {
  // A program has one type for a number and one for a text, so an annotation is
  // read and erased: a union of types is the token run the type is, and `as`
  // says a type the value already has.
  const output = await agreesWithNode([
    "function label(value: string | undefined): string {",
    "  if (value === undefined) return `none`;",
    "  return value;",
    "}",
    "const total = (2 + 3) as number;",
    "console.log(`${label(`x`)} ${total}`);",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "x 5");
});

test("`in` on a union reads the arm the value is", async () => {
  // A union of shapes is one layout: every field of every arm, zero where the
  // arm that wrote the value did not write it, and a tag that says which arm it
  // is. `"refused" in outcome` is the tag naming an arm that has the field, so
  // the field of another arm is a field the value really holds as zero rather
  // than a read past the object it was laid out as.
  const output = await agreesWithNode([
    "type Outcome = { refused: string } | { applied: number };",
    "function pick(flag: boolean): Outcome {",
    "  if (flag) return { refused: `no` };",
    "  return { applied: 7 };",
    "}",
    "export function demo(): string {",
    "  const a = pick(true);",
    "  const b = pick(false);",
    "  const first = (\"refused\" in a) ? a.refused : `applied`;",
    "  const second = (\"refused\" in b) ? b.refused : `${b.applied}`;",
    "  return `${first}|${second}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "no|7");
});

test("a call to a function another module declares answers what it says", async () => {
  // A runtime import binds a name, and the function is compiled by the module
  // that writes it. The graph reads that module, so the call answers the
  // result its declaration writes — which is what a field of the answer and
  // `in` over it need, and what the first read of this file deferred.
  const sources = {
    "lib.ts": [
      "export interface Proposal { rule: string }",
      "export function read(value: string): { proposal: Proposal } | { unusable: string } {",
      "  if (value === ``) return { unusable: `empty` };",
      "  return { proposal: { rule: value } };",
      "}",
      "",
    ].join("\n"),
  };
  const main = [
    'import { read } from "./lib.ts";',
    "function f(value: string): number {",
    "  const answer = read(value);",
    "  if (\"unusable\" in answer) return 0;",
    "  return answer.proposal.rule.length;",
    "}",
    "console.log(`${f(``)} ${f(`xyz`)}`);",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(main, sources, backend);
    assert.equal(output.trim(), "0 3", `the ${backend} backend reads the linked answer`);
  }
});

test("a function with a rest parameter reads the arguments as one list", async () => {
  // `(...args: any[])` is the list of everything the call wrote, and a text and
  // a number beside each other are boxed into the handles a dynamic value is.
  // The overloads above the body say how the function is called; the body says
  // what the arguments are.
  const source = [
    "function pick(a: string, b: number): string;",
    "function pick(b: string, a: number): string;",
    "function pick(...args: any[]): string {",
    "  if (args.length >= 2) return `${args[0]}:${args[1]}`;",
    "  return `${args[0]}`;",
    "}",
    "export function demo(): string {",
    "  return `${pick(`x`, 3)} ${pick(4, `y`)}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "x:3 4:y", `the ${backend} backend reads the rest list`);
  }
});

test("a list of dynamic values holds a text and a number beside each other", async () => {
  // A dynamic value is a handle: a text and a number are boxed into one, and a
  // handle read back as a text is unboxed. The machine backend kept the text's
  // pointer in a slot whose reader asked the runtime to unbox a handle, and
  // then passed the handle where the convention wants a double.
  const source = [
    "export function demo(): string {",
    "  const list: any[] = [`x`, 3];",
    "  return `${list[0]}|${list[1]}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "x|3", `the ${backend} backend boxes a dynamic element`);
  }
});

test("an import binds an exported name under the name the file writes", async () => {
  // `import { read as readOne, TABLE as NAMES }` binds a function and a value
  // under another name. The function is compiled once, by the name its module
  // declared, and the call the file writes under the alias is emitted under
  // that name; the value is bound under the alias and read where it is written.
  const sources = {
    "lib.ts": [
      "export interface Entry { name: string }",
      "export const NAMES: string[] = [`a`, `b`];",
      "export function read(value: string): Entry {",
      "  return { name: `${value}!` };",
      "}",
      "",
    ].join("\n"),
  };
  const main = [
    "import { read as readOne, NAMES as TABLE } from \"./lib.ts\";",
    "import type { Entry as Item } from \"./lib.ts\";",
    "function use(item: Item): string { return item.name; }",
    "export function demo(): string {",
    "  return `${use(readOne(`x`))} ${TABLE.length} ${TABLE[0]}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(main, sources, backend);
    assert.equal(output.trim(), "x! 2 a", `the ${backend} backend reads a renamed import`);
  }
});

test("a call of an arrow that answers a set is a set", async () => {
  // An arrow's declared result names the collection it answers, and the call is
  // written as a call of the function the arrow lifted to: without the answer
  // recorded under that name, `has`, `add` and `size` were methods of nothing.
  const source = [
    "function namesOf(name: string): Set<string> {",
    "  const found = new Set<string>();",
    "  if (name.length > 0) found.add(name);",
    "  return found;",
    "}",
    "export function demo(): string {",
    "  const set = namesOf(`a`);",
    "  const missing = namesOf(``);",
    "  set.add(`b`);",
    "  return `${set.has(`a`)} ${set.has(`b`)} ${missing.has(`a`)} ${set.size}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "true true false 2", `the ${backend} backend knows what the arrow answered`);
  }
});

test("a map holds a reference under a number key and under a reference key", async () => {
  // The dictionary keeps the reference as the handle it is, and the read of it
  // is the call that answers a reference: a call answered as the double the
  // handle is carried in typed the value a number, and reading a field of it
  // read the runtime's table as an object.
  const source = [
    "class Box {",
    "  value: number;",
    "  constructor(value: number) { this.value = value; }",
    "}",
    "function g(): number {",
    "  const byNumber = new Map<number, Box>();",
    "  byNumber.set(1, new Box(4));",
    "  const byKey = new Map<Box, Box>();",
    "  const key = new Box(2);",
    "  byKey.set(key, new Box(5));",
    "  return byNumber.get(1).value * 10 + byKey.get(key).value;",
    "}",
    "console.log(g());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "45", `the ${backend} backend reads a reference from the dictionary`);
  }
});

test("an assignment written in a template string writes before the text", async () => {
  // `${this.builds += 1}` is a write and a read of the same place. The write is
  // a statement, so it runs before the statement the string is part of, and the
  // string interpolates what the write left there — the number `1`, not zero.
  const source = [
    "class Counter {",
    "  builds: number;",
    "  constructor() { this.builds = 0; }",
    "  next(): string { return `n${this.builds += 1}`; }",
    "}",
    "export function demo(): string {",
    "  const counter = new Counter();",
    "  let label = 0;",
    "  const one = `a${label += 1}`;",
    "  const two = `${counter.next()}`;",
    "  return `${one} ${two} ${label}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "a1 n1 1", `the ${backend} backend writes an interpolated assignment`);
  }
});

test("an arrow that appends to a captured list appends to the caller's list", async () => {
  // A list is a reference, but a push answers a longer list and the name is
  // bound to the answer: an arrow that pushes holds the list in a one-field
  // object, and both sides write the field. The scalar box is a one-element
  // list, which cannot hold a list.
  const source = [
    "export function demo(): string {",
    "  const found: number[] = [];",
    "  const add = (n: number): void => { found.push(n); };",
    "  add(3);",
    "  add(4);",
    "  return `${found.length} ${found[0] + found[1]}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "2 7", `the ${backend} backend appends to the caller's list`);
  }
});

test("two arrows append to two captured lists", async () => {
  // The list one arrow appends to is read by another, and both are boxes: the
  // names an arrow captures are the boxes, whichever arrow made them.
  const source = [
    "export function demo(): string {",
    "  const names: string[] = [];",
    "  const out: string[] = [];",
    "  const note = (n: string): void => { names.push(n); };",
    "  const copy = (): void => { for (let i = 0; i < names.length; i += 1) out.push(names[i]); };",
    "  note(`a`);",
    "  note(`b`);",
    "  copy();",
    "  return `${out.length} ${out[0]} ${out[1]} ${names[0]} ${names[1]}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "2 a b a b", `the ${backend} backend appends to both lists`);
  }
});

test("a for loop that is not a counted loop is the while loop it is", async () => {
  // The initialiser runs once before the loop, the condition is read every
  // turn, and the step runs at the end of a turn — and in front of every
  // continue, which is where the source put it.
  const source = [
    "class Peek {",
    "  at = 0;",
    "  values: number[] = [1, 2, 3];",
    "  peek(): number | null { return this.at < this.values.length ? this.values[this.at] : null; }",
    "  step(): void { this.at += 1; }",
    "}",
    "export function demo(): string {",
    "  const p = new Peek();",
    "  let out = ``;",
    "  for (let line = p.peek(); line !== null && line > 0; line = p.peek()) {",
    "    out = `${out}${line}`;",
    "    p.step();",
    "  }",
    "  let skipped = ``;",
    "  for (let i = 0; i < 5; i += 1) {",
    "    if (i === 2) continue;",
    "    skipped = `${skipped}${i}`;",
    "  }",
    "  return `${out}|${skipped}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "123|0134", `the ${backend} backend runs the general for loop`);
  }
});

test("new Array is a block of numbers, and fill writes every element", async () => {
  // The source language's `Array` is this compiler's array of numbers: a block
  // of the count written, cleared, which is what a read past what the program
  // filled answers. `new Array(a, b)` names the elements instead.
  const source = [
    "export function demo(): string {",
    "  const xs: number[] = new Array(3).fill(-1);",
    "  xs[1] = 5;",
    "  const named: number[] = new Array(1, 2, 3);",
    "  const empty: number[] = new Array();",
    "  return `${xs.length} ${xs[0]} ${xs[1]} ${xs[2]} ${named.join(`,`)} ${empty.length}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "3 -1 5 -1 1,2,3 0", `the ${backend} backend allocates the array`);
  }
});

test("a switch is the chain of comparisons its cases are", async () => {
  // The subject is read once into a name of the switch's own, and each arm is
  // an if that compares the name with the case. An arm that does not end by
  // leaving the switch runs into the arm after it, which is the fallthrough.
  const source = [
    "function name(n: number): string {",
    "  let out = `?`;",
    "  switch (n) {",
    "    case 0:",
    "      out = `zero`;",
    "      break;",
    "    case 1:",
    "    case 2:",
    "      out = `small`;",
    "      break;",
    "    default:",
    "      out = `big`;",
    "  }",
    "  return out;",
    "}",
    "function fall(n: number): number {",
    "  let total = 0;",
    "  switch (n) {",
    "    case 1:",
    "      total += 2;",
    "    case 2:",
    "      total += 3;",
    "      break;",
    "    default:",
    "      return 7;",
    "  }",
    "  return total;",
    "}",
    "console.log(`${name(0)} ${name(2)} ${name(9)} ${fall(0)} ${fall(1)} ${fall(2)}`);",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "zero small big 7 5 3", `the ${backend} backend compares the cases`);
  }
});

test("a list is written at a length, and a program writes without ending the line", async () => {
  // `a.length = n` is the first `n` elements and the empty ones a longer list
  // gains. `process.stdout.write` writes where it is, and does not end the line
  // the way a console does.
  const source = [
    "class Pool {",
    "  items: number[] = [];",
    "  add(n: number): void { this.items.push(n); }",
    "  trim(n: number): void { this.items.length = n; }",
    "}",
    "export function demo(): string {",
    "  const xs: number[] = [1, 2, 3, 4];",
    "  xs.length = 2;",
    "  const grown: number[] = [1];",
    "  grown.length = 3;",
    "  const p = new Pool();",
    "  p.add(1);",
    "  p.add(2);",
    "  p.trim(1);",
    "  return `${xs.join(`,`)} ${grown.length} ${p.items.join(`,`)}`;",
    "}",
    "process.stdout.write(demo());",
    "console.log(` done`);",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "1,2 3 1 done", `the ${backend} backend writes the list and the line`);
  }
});

test("splice is a range of a list replaced by the values written", async () => {
  // The answer is the range the call took out, read before the write, and the
  // list is the part before the range, the values, and the part after it. A
  // start below zero counts from the end, a start past the end is the end, and
  // a count below zero takes nothing out.
  const source = [
    "class Pool {",
    "  items: string[] = [];",
    "  add(s: string): void { this.items.push(s); }",
    "  drop(at: number, n: number): void { this.items.splice(at, n); }",
    "  insert(at: number, s: string): void { this.items.splice(at, 0, s); }",
    "}",
    "export function demo(): string {",
    "  const xs: number[] = [1, 2, 3, 4];",
    "  const removed = xs.splice(1, 2);",
    "  const head: number[] = [0];",
    "  xs.splice(0, 0, ...head, 9);",
    "  xs.splice(1, 1);",
    "  const last = xs.splice(-1, 5);",
    "  const p = new Pool();",
    "  p.add(`a`);",
    "  p.add(`b`);",
    "  p.add(`c`);",
    "  p.drop(1, 1);",
    "  p.insert(1, `d`);",
    "  return `${removed.join(`,`)}|${xs.join(`,`)}|${last.join(`,`)}|${p.items.join(`,`)}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "2,3|0,1|4|a,d,c", `the ${backend} backend splices the list`);
  }
});

test("shift takes the first element off a list and unshift puts one in front", async () => {
  // The list a name holds changes, so the element is read before the change and
  // the change is written beside the statement the call was read in: a shift
  // answers the element it took out, and an unshift answers the length.
  const source = [
    "class Queue {",
    "  items: number[] = [];",
    "  add(n: number): void { this.items.push(n); }",
    "  take(): number { return this.items.shift(); }",
    "  front(n: number): void { this.items.unshift(n); }",
    "}",
    "export function demo(): string {",
    "  const xs: number[] = [1, 2, 3];",
    "  const first = xs.shift();",
    "  xs.unshift(9);",
    "  const length = xs.unshift(8, 7);",
    "  const q = new Queue();",
    "  q.add(1);",
    "  q.add(2);",
    "  q.front(0);",
    "  const taken = q.take();",
    "  return `${first} ${xs.join(`,`)} ${length} ${taken} ${q.items.length}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "1 8,7,9,2,3 5 0 2", `the ${backend} backend changes the ends of the list`);
  }
});

test("a list the parser built is a list of the type it holds", async () => {
  // `Object.keys(TABLE)` is a list the parser builds from the names the file
  // wrote. Its element type is written as a type and not as a name the table
  // holds, so reading it as a name gave a list of the unshaped reference: a
  // `join` or a `map` written after it walked elements of no type.
  const source = [
    "const TABLE = { a: 1, b: 2 };",
    "export function demo(): string {",
    "  const keys = Object.keys(TABLE);",
    "  const values = Object.values(TABLE);",
    "  const upper = keys.map((key: string): string => key.toUpperCase());",
    "  return `${keys.join(`, `)}|${values.join(`, `)}|${upper.join(``)}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "a, b|1, 2|AB", `the ${backend} backend walks the list it built`);
  }
});

test("flatMap is the lists its callback answers, one after another", async () => {
  // The callback answers a list, and the answer is those lists in order. A list
  // of lists is not a value here, so each answer is walked where it is read and
  // its elements are appended to the answer of the helper.
  const source = [
    "export function demo(): string {",
    "  const xs: number[] = [1, 2, 3];",
    "  const grown = xs.flatMap((x: number): number[] => [x, x + 10]);",
    "  const doubled = xs.flatMap((x: number): number => x * 2);",
    "  const some = xs.flatMap((x: number): number[] => (x > 1 ? [x] : []));",
    "  return `${grown.join(`,`)}|${doubled.join(`,`)}|${some.join(`,`)}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "1,11,2,12,3,13|2,4,6|2,3", `the ${backend} backend flattens the answers`);
  }
});

test("an arrow's default is the value its call left out", async () => {
  // The default is the value written where the arrow is, so a call that leaves
  // the parameter out writes it there.
  const source = [
    "export function demo(): string {",
    "  const bump = (x: number, by: number = 1): number => x + by;",
    "  const text = (name: string, suffix: string = `!`): string => name + suffix;",
    "  return `${bump(2)} ${bump(2, 10)} ${text(`ab`)}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "3 12 ab!", `the ${backend} backend writes the default its call left out`);
  }
});

test("Array.from writes the answer of its callback at every index of a length", async () => {
  // `Array.from({ length: n }, (_, i) => v)` is n answers, each read at its
  // index. The count is read once, before the walk, and the callback is the
  // function the arrow became: the values it captured travel with it, and the
  // element it is handed is the absent one a sparse index has.
  const source = [
    "export function demo(): string {",
    "  const prefix = `p`;",
    "  const parts = Array.from({ length: 3 }, (_, index) => `${prefix}${index}`);",
    "  const none = Array.from({ length: 0 }, () => 1);",
    "  return `${parts.join(`, `)}|${none.length}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "p0, p1, p2|0", `the ${backend} backend walks the length`);
  }
});

test("a list pushed to in a loop keeps what every turn appended", async () => {
  // `push` answers a longer list, so the turn stores a block a function built
  // into a name that outlives it. The loop may only reuse a turn's storage when
  // nothing it built is still wanted, and an array a helper builds is as much
  // the turn's block as an object is.
  const source = [
    "export function demo(): string {",
    "  const names: string[] = [`a`, `b`];",
    "  const out: string[] = [];",
    "  for (let i = 0; i < names.length; i += 1) out.push(`x`);",
    "  return `${out.length} ${out[0]} ${out[1]}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "2 x x", `the ${backend} backend keeps every appended value`);
  }
});

test("an arrow that only reads a name another arrow writes reads its box", async () => {
  // The name a writing arrow holds is a box, and the declaration is the box.
  // An arrow that only reads the name captured the name itself, which no
  // longer exists: it is handed the box and reads the value through it.
  const source = [
    "export function demo(): string {",
    "  let total = 0;",
    "  let note = ``;",
    "  const add = (n: number): void => { total = total + n; };",
    "  const say = (t: string): void => { note = note + t; };",
    "  const read = (): string => `${total} ${note}`;",
    "  add(2);",
    "  add(3);",
    "  say(`x`);",
    "  return read();",
    "}",
    "console.log(demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "5 x", `the ${backend} backend hands over the box`);
  }
});

test("an arrow writes a name of the function around it", async () => {
  // An arrow is lifted into a function of its own, and the values it captured
  // are handed to it by value: a write would reach the lifted function's copy.
  // A name the arrow writes is held in a one-element list instead, which is a
  // reference, so both sides write the element the source wrote.
  const source = [
    "function twice(f: (n: number) => void, n: number): void {",
    "  f(n);",
    "  f(n);",
    "}",
    "export function demo(): string {",
    "  let total = 0;",
    "  let note = ``;",
    "  const add = (n: number): void => { total = total + n; };",
    "  const say = (t: string): void => { note = note + t; };",
    "  twice(add, 2);",
    "  twice(add, 5);",
    "  for (let i = 0; i < 2; i += 1) say(`${i}`);",
    "  return `${total} ${note}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "14 01", `the ${backend} backend writes the captured name`);
  }
});

test("a destructured rest element is the list from its position on", async () => {
  // `const [head, ...rest] = list` binds `head` to the first element and `rest`
  // to the field from the second to the end, which is the list the slice of a
  // sequence answers.
  const source = [
    "export function demo(): string {",
    "  const [head, ...rest] = `a,b,c`.split(`,`);",
    "  const [first, ...more] = [1, 2, 3];",
    "  return `${head} ${rest.length} ${rest[1]} ${first} ${more.length} ${more[0]}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "a 2 c 1 2 2", `the ${backend} backend binds the rest`);
  }
});

test("a value marked with void is read and writes nothing", async () => {
  // `void unused;` is how a source says it read a value it has no use for. The
  // statement has no effect, and the value is the one the name holds.
  const source = [
    "function takes(dir: string, unused: number): string {",
    "  void unused;",
    "  return dir;",
    "}",
    "console.log(takes(`a`, 1));",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "a", `the ${backend} backend reads the value and drops it`);
  }
});

test("a text is searched from a position", async () => {
  // `indexOf(needle, from)` is the search of the field that starts at `from`,
  // and the position it answers is that field's plus the start. A start below
  // zero is the beginning and a start past the end is the end.
  const source = [
    "export function demo(): string {",
    "  const text = `a,b,c`;",
    "  const one = text.indexOf(`,`, 0);",
    "  const two = text.indexOf(`,`, 2);",
    "  const three = text.indexOf(`,`, 9);",
    "  const four = text.indexOf(`,`, -3);",
    "  const five = text.indexOf(`b`, 10);",
    "  return `${one} ${two} ${three} ${four} ${five}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "1 3 -1 1 -1", `the ${backend} backend searches from the position`);
  }
});

test("a choice of a length and a number is a number", async () => {
  // The two arms of `from > text.length ? text.length : from` are a length and
  // a double. The choice between them is one number, and reading it as the
  // reference an unstated arm is refused the addition that follows it.
  const source = [
    "export function demo(): string {",
    "  const text = `abc`;",
    "  const from = 2;",
    "  const start = from > text.length ? text.length : from;",
    "  const clamp = from < 0 ? 0 : (from > text.length ? text.length : from);",
    "  return `${start + 1} ${clamp + 1}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "3 3", `the ${backend} backend types the choice`);
  }
});

test("a map of a callback's pairs is the entries it writes", async () => {
  // `new Map(items.map((item) => [item.key, item.value]))` is a loop of one
  // write each; an entry is two values of two types, which a list cannot hold.
  const source = [
    "interface Module { path: string; source: string }",
    "function describe(at: number): string { return `n${at}`; }",
    "export function demo(): string {",
    "  const modules: Module[] = [{ path: `a`, source: `x` }, { path: `b`, source: `y` }];",
    "  const byPath = new Map(modules.map((module) => [module.path, module.source]));",
    "  const byName = new Map([`p`, `q`].map((name) => [name, describe(name.length)]));",
    "  const second = byPath.get(`b`);",
    "  const q = byName.get(`q`);",
    "  return `${byPath.size} ${second === undefined ? `none` : second} ${q === undefined ? `none` : q}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "2 y n1", `the ${backend} backend builds the map from the pairs`);
  }
});

test("Object.fromEntries of a callback's pairs is the entries it writes", async () => {
  // `Object.fromEntries(items.map((item) => [item.key, item]))` is a loop of
  // one write each: an entry is two values of two types, which a list cannot
  // hold, and the record the call answers is the dictionary it wrote.
  const source = [
    "interface Entry { name: string; value: number }",
    "export function demo(): string {",
    "  const entries: Entry[] = [{ name: `a`, value: 1 }, { name: `b`, value: 2 }];",
    "  const byName = Object.fromEntries(entries.map((entry) => [entry.name, entry]));",
    "  const a = byName.a;",
    "  return `${Object.keys(byName).length} ${a === undefined ? 0 : a.value}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "2 1", `the ${backend} backend builds the record from the pairs`);
  }
});

test("a method's promise is awaited as the value it carries", async () => {
  const source = [
    "class Store {",
    "  async list(path: string): Promise<string[]> { return [path, `${path}/`]; }",
    "}",
    "export async function demo(): Promise<string> {",
    "  const store = new Store();",
    "  const found = await store.list(`a`);",
    "  return found.map((one) => one.length).join(`-`);",
    "}",
    "console.log(await demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "1-2", `the ${backend} backend awaits the method's list`);
  }
});

test("a recursive record holds the records it is made of", async () => {
  // The answer of a function that builds a node is the node's layout, and a
  // field that holds one is a reference to the same layout: the tree a caller
  // walks is the tree the builder wrote.
  const source = [
    "function checksum(node: any): number {",
    "  if (!node.left) return 1;",
    "  return 1 + checksum(node.left) + checksum(node.right);",
    "}",
    "function createTree(depth: number): any {",
    "  return depth-- > 0",
    "    ? { left: createTree(depth), right: createTree(depth) }",
    "    : { left: null, right: null };",
    "}",
    "console.log(`${checksum(createTree(3))}`);",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "15", `the ${backend} backend walks the recursive record`);
  }
});

test("a spread of a call is the record the call answered", async () => {
  // The call is read once into a name of the statement's own, and every field
  // the spread copies reads that one answer.
  const source = [
    "interface Info { steps: number; region: boolean }",
    "function info(n: number): Info { return { steps: n, region: false }; }",
    "export function demo(): string {",
    "  const made = { kind: `while`, ...info(3) };",
    "  return `${made.kind} ${made.steps} ${made.region}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "while 3 false", `the ${backend} backend spreads the call's record`);
  }
});

test("an empty list beside a set is walked as the set is", async () => {
  // `values ?? []` and `c ? [] : values` are iterated: the empty list holds the
  // set's element, so both loops walk texts.
  const source = [
    "function namesReadBy(value: string): Set<string> { return new Set([value, `${value}!`]); }",
    "export function demo(): string {",
    "  const byKey = new Map<string, Set<string>>();",
    "  byKey.set(`a`, new Set([`x`, `y`]));",
    "  let total = 0;",
    "  for (const name of byKey.get(`a`) ?? []) total += name.length;",
    "  for (const name of `ab` === `` ? [] : namesReadBy(`ab`)) total += name.length;",
    "  for (const name of byKey.get(`missing`) ?? []) total += name.length;",
    "  return `${total}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "7", `the ${backend} backend walks the empty list beside a set`);
  }
});

test("an empty list a flat map answers is built at the other returns' type", async () => {
  const source = [
    "interface Field { name: string }",
    "export function demo(): string {",
    "  const fields: Field[] = [{ name: `a` }, { name: `` }, { name: `b` }];",
    "  const kept = fields.flatMap((field) => {",
    "    if (field.name === ``) return [];",
    "    return [field];",
    "  });",
    "  return `${kept.length} ${kept.map((field) => field.name).join(`-`)}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "2 a-b", `the ${backend} backend settles the empty return`);
  }
});

test("a rest field binds what is left of the record", async () => {
  const source = [
    "interface Pair { left: number; right: number; name: string }",
    "export function demo(): string {",
    "  const pair: Pair = { left: 1, right: 2, name: `x` };",
    "  const { left, ...rest } = pair;",
    "  return `${left} ${rest.right} ${rest.name}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "1 2 x", `the ${backend} backend binds what is left of the record`);
  }
});

test("a record spread into a record is the entries of both", async () => {
  const source = [
    "export function demo(): string {",
    "  const a: Record<string, number> = { x: 1, y: 2 };",
    "  const b: Record<string, number> = { y: 3, z: 4 };",
    "  const both = { ...a, ...b };",
    "  return `${both.x} ${both.y} ${both.z} ${Object.keys(both).length}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "1 3 4 3", `the ${backend} backend merges the two records`);
  }
});

test("a map whose callback answers a list is a list of the lists it answered", async () => {
  const source = [
    "export function demo(): string {",
    "  const pairs = [1, 2].map((x) => [x, x + 1]);",
    "  const first = pairs[0];",
    "  return `${pairs.length} ${first === undefined ? `none` : first.join(`-`)}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "2 1-2", `the ${backend} backend maps to a list of lists`);
  }
});

test("the keys and values of a record are the fields it was laid out with", async () => {
  // A value the read holds at a record is a layout: its keys are the fields it
  // was laid out with, and its values are those fields read.
  const source = [
    "interface Pair { left: number; right: number }",
    "export function demo(): string {",
    "  const pair: Pair = { left: 1, right: 2 };",
    "  const values = Object.values(pair);",
    "  return `${values.length} ${values[0] + values[1]} ${Object.keys(pair).join(`,`)}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "2 3 left,right", `the ${backend} backend reads the record's fields`);
  }
});

test("a list sorts by itself, and a view of part of a buffer is a window", async () => {
  // The order the language gives a list of numbers or texts is the one `<` is
  // for each; a view of part of a block is the block moved by the offset.
  const source = [
    "export function demo(): string {",
    "  const names = [`c`, `a`, `b`];",
    "  names.sort();",
    "  const values = [3, 1, 2];",
    "  values.sort();",
    "  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);",
    "  const view = new DataView(bytes.buffer, 1, 4);",
    "  return `${names.join(``)} ${values.join(``)} ${view.getUint8(0)} ${view.byteLength}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "abc 123 2 4", `the ${backend} backend sorts and views`);
  }
});

test("BigInt.asIntN and asUintN wrap a whole number to a width", async () => {
  // The low bits of the number, and for the signed one the sign of the highest
  // of them carried up: a width of the whole carrier is the number itself.
  const source = [
    "export function demo(): string {",
    "  const wide = 300n;",
    "  const negative = -1n;",
    "  return `${BigInt.asIntN(8, wide)} ${BigInt.asUintN(8, negative)} ${BigInt.asIntN(64, negative)} ${BigInt.asUintN(4, 15n)} ${BigInt.asIntN(4, 9n)}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "44 255 -1 15 -7", `the ${backend} backend wraps the number to the width`);
  }
});

test("an element of a field, an unshift spread and a pop of a value", async () => {
  // Three writes the sources make: an element of the record a field holds, the
  // front of a list with the elements another list holds, and the last element
  // of a list no name holds.
  const source = [
    "class Counter {",
    "  private counters: Record<string, number> = { a: 0 };",
    "  bump(kind: string): number {",
    "    this.counters[kind] += 1;",
    "    return this.counters[kind];",
    "  }",
    "}",
    "export function demo(): string {",
    "  const counter = new Counter();",
    "  counter.bump(`a`);",
    "  counter.bump(`a`);",
    "  const all: string[] = [`b`];",
    "  all.unshift(...[`x`, `y`]);",
    "  const last = `a b c`.split(` `).pop();",
    "  return `${counter.bump(`a`)} ${all.join(`-`)} ${last}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "3 x-y-b c", `the ${backend} backend writes the field's element and the list's front`);
  }
});

test("a date is the clock, and its stamp is the ISO text", async () => {
  // The clock is the host's, and the stamp is UTC to the millisecond. The
  // millisecond itself differs between two reads, so the shape is what both
  // programs write: its length and the characters that place it.
  const source = [
    "export function demo(): string {",
    "  const stamp = new Date().toISOString();",
    "  const time = new Date().getTime();",
    "  return `${stamp.length} ${stamp.startsWith(`20`)} ${stamp.indexOf(`T`)} ${stamp.endsWith(`Z`)} ${time > 1000000000000 ? `late` : `early`} ${Date.now() > 0 ? `clock` : `none`}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "24 true 10 true late clock", `the ${backend} backend stamps the clock`);
  }
});

test("a text decoder reads the bytes of a utf8 text", async () => {
  const source = [
    "export function demo(): string {",
    "  const decoder = new TextDecoder();",
    "  const first = decoder.decode(new Uint8Array([104, 105]));",
    "  const second = new TextDecoder().decode(new Uint8Array([33]));",
    "  return first + second;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "hi!", `the ${backend} backend reads the bytes as text`);
  }
});

test("subarray is a window of the block it was taken of", async () => {
  // No bytes are copied: the window is the block moved by the offset, and it
  // is as long as the source wrote of it.
  const source = [
    "export function demo(): number {",
    "  const bytes = new Uint8Array([1, 2, 3, 4, 5]);",
    "  const part = bytes.subarray(1, 4);",
    "  let total = 0;",
    "  for (const one of part) total += one;",
    "  const tail = bytes.subarray(3);",
    "  return total * 1000 + part.length * 100 + part[2] * 10 + tail.length;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), String(9 * 1000 + 3 * 100 + 4 * 10 + 2), `the ${backend} backend views the block it was taken of`);
  }
});

test("a conditional spread leaves the field the zero of its type", async () => {
  // `...(yes ? { flag: true } : {})` writes a truth only when `yes` holds. A
  // record's field exists either way, so the arm that writes nothing leaves it
  // at the zero of a truth, which is what a test of it reads.
  const source = [
    "interface Options { flag?: boolean; depth?: number }",
    "function read(yes: boolean, depth: number | undefined): string {",
    "  const options: Options = {",
    "    ...(yes ? { flag: true } : {}),",
    "    ...(depth === undefined ? {} : { depth }),",
    "  };",
    "  return `${options.flag ? `yes` : `no`} ${options.depth === 0 ? `zero` : `other`}`;",
    "}",
    "console.log(read(true, undefined));",
    "console.log(read(false, 0));",
    "console.log(read(false, 2));",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim().split("\n").join("|"), "yes other|no zero|no other", `the ${backend} backend writes the zero it left out`);
  }
});

test("a map of lists holds each list whole, with its length", async () => {
  // A dictionary entry is one double, and a list is a block and a length: the
  // list is copied into a block the runtime laid out, whose header says how
  // many bytes it holds, so the pointer alone is the list a key answers.
  const source = [
    "export function demo(): number {",
    "  const lists = new Map<string, number[]>();",
    "  lists.set(`a`, [1, 2]);",
    "  lists.set(`b`, []);",
    "  const held = lists.get(`a`);",
    "  let total = 0;",
    "  if (held !== undefined) {",
    "    for (const one of held) total += one;",
    "    held.push(3);",
    "    lists.set(`a`, held);",
    "  }",
    "  const empty = lists.get(`b`);",
    "  let emptyCount = -1;",
    "  if (empty !== undefined) emptyCount = empty.length;",
    "  const grown = lists.get(`a`);",
    "  const grownCount = grown === undefined ? -1 : grown.length;",
    "  lists.delete(`a`);",
    "  const numbered = new Map<number, number[]>();",
    "  numbered.set(7, [4, 5]);",
    "  const seven = numbered.get(7);",
    "  const sevenCount = seven === undefined ? -1 : seven.length;",
    "  return total * 1000 + emptyCount * 100 + grownCount * 10 + (lists.has(`a`) ? 1 : 0) + sevenCount * 10000;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), String(2 * 10000 + 3 * 1000 + 0 * 100 + 3 * 10 + 0), `the ${backend} backend holds a list in a map`);
  }
});

test("Object.is compares two numbers by the bits they are held as", async () => {
  // `Object.is` is the same-value question: a NaN is the same as itself, and
  // `-0` is not `0`, which `===` answers the other way round for both. A text
  // is compared by what it says.
  const source = [
    "export function demo(): string {",
    "  const zero = 0;",
    "  const nan = 0 / zero;",
    "  return `${Object.is(zero, -0)} ${Object.is(nan, nan)} ${Object.is(2, 2)} ${Object.is(`ab`, `ab`)}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "false true true true", `the ${backend} backend compares two numbers by their bits`);
  }
});

test("a text repeated is the text appended that many times", async () => {
  // `text.repeat(n)` is a function of the file that appends the text to an
  // answer of its own, with the count floored the way the language floors it.
  const source = [
    "export function demo(): string {",
    "  const dash = `-`.repeat(3);",
    "  const pad = ` `.repeat(2.7);",
    "  const none = `x`.repeat(0);",
    "  return `${dash}|${pad}|${none}|`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "---|  ||", `the ${backend} backend repeats the text`);
  }
});

test("an arrow takes the rest of a call's arguments as one list", async () => {
  // `(...taken: string[]) => ...` is called with as many arguments as the call
  // writes; the lifted function's parameter is the list they are packed into.
  const source = [
    "export function demo(): string {",
    "  let count = 0;",
    "  let last = ``;",
    "  const take = (...taken: string[]): void => {",
    "    for (let i = 0; i < taken.length; i += 1) { count += 1; last = taken[i]; }",
    "  };",
    "  take(`a`, `b`);",
    "  take(`c`);",
    "  take();",
    "  return `${count} ${last}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "3 c", `the ${backend} backend packs the rest`);
  }
});

test("an optional chain on a call reads the call once", async () => {
  // `make()?.value` is read by the condition and by the branch, so the call is
  // written into a name first: a call read twice would allocate twice and
  // answer a different object each time.
  const source = [
    "class Box { value: number; constructor(value: number) { this.value = value; } }",
    "class Maker {",
    "  made: number;",
    "  constructor() { this.made = 0; }",
    "  next(): Box { this.made += 1; return new Box(this.made); }",
    "}",
    "export function demo(): string {",
    "  const maker = new Maker();",
    "  const first = maker.next()?.value ?? 0;",
    "  const second = maker.next()?.value ?? 0;",
    "  return `${first} ${second} ${maker.made}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "1 2 2", `the ${backend} backend reads the call once`);
  }
});

test("two calls written the same way are two calls", async () => {
  // Inlining writes a body per call, and two calls written the same way are the
  // same value: a rewrite that replaced every equal call wrote one body and
  // answered with its result twice, so the callee ran once where the source ran
  // it twice and the second answer was the first one.
  const source = [
    "class Counter {",
    "  builds: number;",
    "  constructor() { this.builds = 0; }",
    "  next(): string { this.builds += 1; return `n${this.builds}`; }",
    "}",
    "export function demo(): string {",
    "  const counter = new Counter();",
    "  const two = `${counter.next()}-${counter.next()}`;",
    "  return `${two} ${counter.builds}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "n1-n2 2", `the ${backend} backend runs both calls`);
  }
});

test("a function writes a field and a list of the object it was handed", async () => {
  // An object travels as the double the ABI carries, and a field of it is
  // reached through a pointer. The store cast the double straight to a pointer,
  // which C refuses to compile: the cast has to go through an integer wide
  // enough to hold an address, as the field read already did.
  const source = [
    "interface Inner { list: number[]; count: number }",
    "function addOne(inner: Inner, n: number): void {",
    "  inner.list.push(n);",
    "  inner.count = inner.count + 1;",
    "}",
    "export function demo(): string {",
    "  const inner: Inner = { list: [], count: 0 };",
    "  addOne(inner, 1);",
    "  addOne(inner, 2);",
    "  return `${inner.list.length} ${inner.list[1]} ${inner.count}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "2 2 2", `the ${backend} backend writes the field`);
  }
});

test("a list behind more than one field takes a push", async () => {
  // `o.inner.list.push(x)`: the owner is a reference, so it is read into a name
  // of the statement's own and the push is written through that name. A place
  // one field deep was the only one the append knew, so the deeper one was a
  // method of nothing.
  const output = await agreesWithNode([
    "interface Inner { list: number[] }",
    "interface Outer { inner: Inner }",
    "function make(): Outer {",
    "  const inner: Inner = { list: [] };",
    "  return { inner };",
    "}",
    "export function demo(): string {",
    "  const o = make();",
    "  o.inner.list.push(3);",
    "  o.inner.list.push(4);",
    "  return `${o.inner.list.length} ${o.inner.list[0] + o.inner.list[1]}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "2 7");
});

test("a collection is keyed by a number", async () => {
  // A key is a text, a reference or a number: a number reaches the runtime as
  // the number it is, and the runtime keeps the key as the bits of its double,
  // so two writes of one number are one entry and `-0` is the zero it is.
  const source = [
    "export function demo(): string {",
    "  const seen = new Set<number>();",
    "  seen.add(4);",
    "  seen.add(9);",
    "  seen.add(4);",
    "  let walk = 0;",
    "  for (const value of seen) walk += value;",
    "  const words = new Map<number, string>();",
    "  words.set(1, `a`);",
    "  words.set(2, `b`);",
    "  words.set(-0, `zero`);",
    "  words.set(0, `still zero`);",
    "  const held = words.has(2) ? words.get(2) : `none`;",
    "  const missing = words.has(3) ? `held` : `none`;",
    "  seen.delete(9);",
    "  const after = seen.has(9) ? `held` : `none`;",
    "  return `${walk} ${held} ${missing} ${after} ${words.get(0)} ${seen.size}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "13 b none none still zero 1", `the ${backend} backend keys by a number`);
  }
});

test("an entry a map does not hold is absent, and `?.` reads nothing", async () => {
  // `m.get(k)` asks the dictionary whether it holds the key and reads it only
  // where it does. The answer for a key it does not hold is the zero of the
  // value's own representation: the null reference for a reference, which is
  // what `?.` tests and what `??` replaces. A number written there instead is
  // boxed into a handle, and reading a field of the box reads the runtime's
  // table as an object.
  const source = [
    "interface Info { name: string }",
    "export function demo(): string {",
    "  const m = new Map<string, Info>();",
    "  m.set(`a`, { name: `A` });",
    "  const present = m.get(`a`)?.name ?? `none`;",
    "  const missing = m.get(`zz`)?.name ?? `none`;",
    "  let n = 0;",
    "  if (m.get(`a`)?.name.length > 0) n += 1;",
    "  if (m.get(`zz`)?.name.length > 0) n += 10;",
    "  return `${present} ${missing} ${n}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(source, {}, backend);
    assert.equal(output.trim(), "A none 1", `the ${backend} backend reads an absent entry as absent`);
  }
});

test("an arrow that calls itself may capture a value of the function around it", async () => {
  // The values the arrow captured are leading parameters of the function it was
  // lifted to, and the call its own body writes was read before they were
  // known: each call the body writes of itself hands them over once they are.
  const output = await agreesWithNode([
    "export function demo(): string {",
    "  const step = 2;",
    "  const sum = (n: number): number => n <= 0 ? 0 : n * step + sum(n - 1);",
    "  return `${sum(3)}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "12");
});

test("an arrow that calls itself is a function of the file", async () => {
  // The arrow is read before the declaration binds it, so the call it writes of
  // its own name is read as a call of the function it lifts to. A compiler
  // whose passes walk a tree with an arrow is the program the self-build is.
  const output = await agreesWithNode([
    "interface Node { name: string; children: Node[] }",
    "export function demo(): string {",
    "  const count = (one: Node): number => {",
    "    let total = 1;",
    "    for (const child of one.children) total += count(child);",
    "    return total;",
    "  };",
    "  const fact = (n: number): number => n <= 1 ? 1 : n * fact(n - 1);",
    "  const tree: Node = { name: `a`, children: [] };",
    "  return `${count(tree)} ${fact(5)}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "1 120");
});

test("`Object.create(null)` is an empty record that is filled by key", async () => {
  const output = await agreesWithNode([
    "export function demo(): string {",
    "  const record = Object.create(null) as Record<string, number>;",
    "  record[`a`] = 1;",
    "  record[`b`] = 2;",
    "  let total = 0;",
    "  for (const [name, value] of Object.entries(record)) total += value;",
    "  return `${total}`;",
    "}",
    "console.log(demo());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "3");
});

test("a number written as text outlives the function that wrote it", async () => {
  // The text of a number is written into a buffer the function owns, and a text
  // a function answers is read after it has returned — so the answer is copied
  // into the managed heap before the frame it was written in is gone. Without
  // that, `return String(7)` answered a pointer into a dead frame and the
  // caller's next call wrote over it: the C backend printed the byte the next
  // frame happened to leave there.
  const files = {
    "lib.ts": [
      "export function label(): string {",
      "  return String(7);",
      "}",
      "export function unlabel(): string {",
      "  return `${9}`;",
      "}",
      "",
    ].join("\n"),
    "main.ts": [
      'import { label, unlabel } from "./lib.ts";',
      "console.log(label());",
      "console.log(label() + `!`);",
      "console.log(unlabel() + label());",
      "",
    ].join("\n"),
  };
  for (const backend of ["c", "machine"] as const) {
    const output = await agreesWithNode(files["main.ts"] as string, { "lib.ts": files["lib.ts"] as string }, backend);
    assert.equal(output.trim(), "7\n7!\n97", `the ${backend} backend keeps the text it answered`);
  }
});

test("the entries of a record are walked and copied", async () => {
  // `Object.entries(record)` names the entries of a dictionary. A loop that
  // takes the two parts of one entry reads them straight out of it, and a
  // `new Map(...)` built from the entries copies them — the record is walked by
  // position rather than held as a list of pairs, which the value model has not.
  const output = await agreesWithNode([
    "export function counting(): string {",
    "  const record: Record<string, number> = { a: 1, b: 2 };",
    "  let total = 0;",
    "  for (const [name, value] of Object.entries(record)) total += value;",
    "  return String(total);",
    "}",
    "export function copying(): string {",
    "  const record: Record<string, number> = { a: 1, b: 2 };",
    "  const copy = new Map(Object.entries(record));",
    "  let n = 0;",
    "  if (copy.has(`a`)) n += 1;",
    "  n += copy.get(`b`);",
    "  return String(n);",
    "}",
    "console.log(counting(), copying());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "3 3");
});

test("a guard that asks a text something survives a call into the runtime", async () => {
  // The machine backend keeps a value alive across a call in `xmm6` to `xmm15`,
  // and this target is System V AMD64, where no vector register is preserved by
  // a call: the C runtime is built to that convention and writes them. A guard
  // that asks a text something makes that call, so the two guards here are the
  // shape that answered `NaN` for `n` before the registers were written down
  // around a call that leaves the object.
  const output = await agreesWithNode([
    "export function demo(): string {",
    "  const text = `xxabyy`;",
    "  let n = 0;",
    "  if (text.includes(`xx`)) n += 1;",
    "  if (text.indexOf(`ab`) === 2) n += 10;",
    "  if (text.slice(0, 2) === `xx`) n += 100;",
    "  if (text.endsWith(`yy`)) n += 1000;",
    "  if (text.startsWith(`xx`)) n += 10000;",
    "  return String(n);",
    "}",
    "console.log(demo());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "11111");
});

test("startsWith reads the field the text holds from a position", async () => {
  // `text.startsWith(needle, at)` is the field the text holds from `at`: the
  // slice that runs as far as the needle is long, compared with the needle.
  // One argument is the field the text holds from the beginning.
  const output = await agreesWithNode([
    "export function demo(): string {",
    "  const text = `xxabyy`;",
    "  let n = 0;",
    "  if (text.startsWith(`ab`, 2)) n += 1;",
    "  if (text.startsWith(`ab`, 0)) n += 10;",
    "  if (text.startsWith(``, 3)) n += 100;",
    "  if (text.startsWith(`y`, 20)) n += 1000;",
    "  if (text.startsWith(`xx`)) n += 10000;",
    "  return String(n);",
    "}",
    "console.log(demo());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "10101");
});

test("a method on a field of an imported type waits for the link", async () => {
  // A local interface may write a field at a type another module declares, and
  // the first read does not hold that declaration: what the field holds is the
  // link's to say. A method written on the field's field is not refused there,
  // and the read that follows the link reads it against the declaration.
  const output = await agreesWithNode(
    [
      'import { demo } from "./holder.ts";',
      "console.log(demo());",
      "",
    ].join("\n"),
    {
      "names.ts": "export interface Analysis {\n  imports: string[];\n}\n",
      "holder.ts": [
        'import { type Analysis } from "./names.ts";',
        "export interface Holder { analysis: Analysis }",
        "export function read(record: Holder): string {",
        "  return record.analysis.imports.map((one) => one.toUpperCase()).join(`,`);",
        "}",
        "export function demo(): string {",
        "  return read({ analysis: { imports: [`a`, `b`] } });",
        "}",
        "",
      ].join("\n"),
    },
  );
  assert.equal(output.trim(), "A,B");
});

test("Array.isArray asks whether a value is a list", async () => {
  // A list the read holds is one where it is read; a value the read does not
  // type — the parameter of a function that takes anything — is asked of the
  // runtime, which carries the kind a value was registered as.
  const output = await agreesWithNode(
    [
      'import { demo } from "./lib.ts";',
      "console.log(demo());",
      "",
    ].join("\n"),
    {
      "lib.ts": [
        "export function tag(value: unknown): string {",
        "  if (Array.isArray(value)) return `list`;",
        "  if (typeof value === `number`) return `number`;",
        "  if (typeof value === `string`) return `text`;",
        "  return `other`;",
        "}",
        "export function demo(): string {",
        "  const list: number[] = [1, 2];",
        "  return tag(list) + ` ` + tag(7) + ` ` + tag(`x`);",
        "}",
        "",
      ].join("\n"),
    },
  );
  assert.equal(output.trim(), "list number text");
});

test("a field of a field a call answered is written through a name", async () => {
  // The IR writes one field of one name, and the value the field belongs to may
  // be the answer of a call: `this.frame().block.terminator = value` reads the
  // block once and writes into it, and the object is a reference, so the write
  // is the one the source named.
  const output = await agreesWithNode([
    "class Block {",
    "  terminator: number;",
    "  constructor() { this.terminator = 0; }",
    "}",
    "class Frame {",
    "  block: Block;",
    "  constructor() { this.block = new Block(); }",
    "}",
    "class Builder {",
    "  held: Frame;",
    "  constructor() { this.held = new Frame(); }",
    "  frame(): Frame { return this.held; }",
    "  mark(value: number): number {",
    "    this.frame().block.terminator = value;",
    "    return this.frame().block.terminator;",
    "  }",
    "  count(): number {",
    "    this.frame().block.terminator += 5;",
    "    return this.frame().block.terminator;",
    "  }",
    "}",
    "const builder = new Builder();",
    "console.log(builder.mark(7), builder.count());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "7 12");
});

test("a brace written inside a text is not a brace of the module", async () => {
  // A string token's text is what the string holds, so a scan that asks a
  // token for its text alone reads `"}"` as a brace of the file: the depth of
  // the body around it never returns to zero, and every top-level constant
  // written after it is taken for a body's own name.
  const output = await agreesWithNode(
    [
      'import { read } from "./lib.ts";',
      "console.log(read());",
      "",
    ].join("\n"),
    {
      "lib.ts": [
        'export function brace(): string { return "}"; }',
        'const PREFIX: string = "ab";',
        "export function read(): string { return PREFIX + brace(); }",
        "",
      ].join("\n"),
    },
  );
  assert.equal(output.trim(), "ab}");
});

test("`in` asks whether a written record has a key", async () => {
  // A record the file writes out has the keys the source wrote, so the question
  // is the chain of comparisons those keys are — the same reading a written
  // set's membership gets. A key nothing wrote is the fallback, which is false.
  const output = await agreesWithNode(
    [
      'import { has } from "./lib.ts";',
      "console.log(has(`a`), has(`z`), has(`b`));",
      "",
    ].join("\n"),
    {
      "lib.ts": [
        "const TABLE: Record<string, string> = { a: `x`, b: `y` };",
        "export function has(key: string): boolean { return key in TABLE; }",
        "",
      ].join("\n"),
    },
  );
  assert.equal(output.trim(), "true false true");
});

test("a written set answers a membership of a text method's answer", async () => {
  // The membership is the comparisons the written keys are, and each one reads
  // the value it was handed. A text's own method names the same text however
  // often it is asked, so `WORDS.has(text.trim())` reads it once per key
  // without the source writing the answer into a name first.
  const output = await agreesWithNode(
    [
      'import { isWord } from "./lib.ts";',
      "console.log(isWord(`  return  `), isWord(`  iffy  `));",
      "",
    ].join("\n"),
    {
      "lib.ts": [
        "const WORDS: ReadonlySet<string> = new Set([`return`, `if`]);",
        "export function isWord(text: string): boolean { return WORDS.has(text.trim()); }",
        "",
      ].join("\n"),
    },
  );
  assert.equal(output.trim(), "true false");
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

test("a field of a field is written the object the source named", async () => {
  // `outer.inner.value = 10` writes the object `outer.inner` is, and the value
  // before the last field is read once: the write inside the class method and
  // the write outside it are one write of one object.
  const output = await agreesWithNode([
    "class Inner {",
    "  value: number;",
    "  constructor(value: number) { this.value = value; }",
    "}",
    "class Outer {",
    "  inner: Inner;",
    "  constructor(inner: Inner) { this.inner = inner; }",
    "  bump(): number { this.inner.value = this.inner.value + 1; return this.inner.value; }",
    "}",
    "function g(): number {",
    "  const outer = new Outer(new Inner(1));",
    "  outer.inner.value = 10;",
    "  return outer.bump() + outer.inner.value;",
    "}",
    "console.log(g());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "22");
});

test("a number written in binary or octal is the value it names", async () => {
  // The bit fields an encoder is written with are binary, and the value is the
  // one the digits name: `0b101` is five and `0o17` is fifteen, whether the
  // language writes the number in base two, base eight or base sixteen.
  const output = await agreesWithNode([
    "function bits(): number { return 0b00010; }",
    "function fields(): number { return (1 ? 0b1000 : 0) | (0 ? 0b100 : 0) | 0b10 | 0b1; }",
    "function octal(): number { return 0o17; }",
    "function wide(): bigint { return 0b1111_0000n; }",
    "console.log(bits(), fields(), octal(), wide());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "2 11 15 240n");
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

test("a method named length is the method, not the length of the receiver", async () => {
  // `this.length(1)` is a call of the method the class declares. `.length` is
  // the length of a sequence, and a `(` after it says the name is a method: the
  // length of a sequence is never called.
  const output = await agreesWithNode([
    "class Window {",
    "  width: number;",
    "  constructor(width: number) { this.width = width; }",
    "  length(n: number): number { return this.width + n; }",
    "}",
    "const w = new Window(3);",
    "const xs = new Float64Array(2);",
    "console.log(w.length(4), xs.length);",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "7 2");
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

test("a declared function is a value a collection method can call", async () => {
  // `values.map(label)` names a function of the file rather than an arrow
  // written where the call is. The function is a value: a closure with nothing
  // captured, entered through a function of the file that calls the declaration.
  const output = await agreesWithNode([
    'function label(value: number): string { return `#${value}`; }',
    "function even(value: number): boolean { return value % 2 === 0; }",
    'function withIndex(value: number, index: number): string { return `${index}:${value}`; }',
    "export function render(values: number[]): string {",
    "  const labels = values.map(label).join(\",\");",
    "  const evens = values.filter(even).join(\",\");",
    "  const indexed = values.map(withIndex).join(\",\");",
    "  return [labels, evens, indexed].join(\" | \");",
    "}",
    "console.log(render([1, 2, 3]));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "#1,#2,#3 | 2 | 0:1,1:2,2:3");
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

test("a constant another module exports is read and run by the module that imports it", async () => {
  // The list is written in one module and read in another, and a compiled
  // function has no environment to read it from: the value crosses the link.
  const output = await agreesWithNode(
    [
      'import { describe, prefix } from "./check.ts";',
      "console.log(describe(`asm`) + ` ` + describe(`ir`) + ` ` + prefix(`about`));",
      "",
    ].join("\n"),
    {
      "kinds.ts": "export const KINDS: readonly string[] = [`c`, `asm`, `machine`];\nexport const PREFIX = `ab`;\nexport function unused(): number { return 0; }\n",
      "check.ts": [
        'import { KINDS, PREFIX } from "./kinds.ts";',
        "export function describe(name: string): string {",
        "  return KINDS.includes(name) ? `yes` : `no`;",
        "}",
        "export function prefix(word: string): string {",
        "  return word.startsWith(PREFIX) ? `starts` : `other`;",
        "}",
        "",
      ].join("\n"),
    },
  );
  assert.equal(output.trim(), "yes no starts");
});

test("a chain of methods over an imported element type reads and runs", async () => {
  // The element type of the list is declared in another module, so the first
  // read does not know its fields: the methods written on it wait for the link,
  // and the read that follows the link reads the chain against the fields the
  // interface declares. What it answers is compared with what the source prints.
  const output = await agreesWithNode(
    [
      'import { demo } from "./holder.ts";',
      "console.log(demo());",
      "",
    ].join("\n"),
    {
      "names.ts": "export interface Name {\n  text: string;\n}\n",
      "holder.ts": [
        'import { type Name } from "./names.ts";',
        "export function read(names: Name[]): string {",
        "  return names.filter((name) => name.text.length > 0).map((name) => name.text.trim()).join(`,`);",
        "}",
        "export function demo(): string {",
        "  const names: Name[] = [{ text: ` a ` }, { text: `b` }];",
        "  return read(names);",
        "}",
        "",
      ].join("\n"),
    },
  );
  assert.equal(output.trim(), "a,b");
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

test("a collection written clear is empty afterwards", async () => {
  // `clear()` is a statement, and the handle the field holds is replaced by a
  // new, empty dictionary. A value recorded after the clear is in the new one,
  // and the size the field reports is the entries of that dictionary alone.
  const output = await agreesWithNode([
    "class Ledger {",
    "  private rows: Map<string, number> = new Map();",
    "  private seen: Set<string> = new Set();",
    "  record(name: string, amount: number): number {",
    "    this.rows.set(name, amount);",
    "    this.seen.add(name);",
    "    return this.rows.size + this.seen.size;",
    "  }",
    "  reset(): void {",
    "    this.rows.clear();",
    "    this.seen.clear();",
    "  }",
    "  sizes(): string {",
    "    return `${this.rows.size} ${this.seen.size}`;",
    "  }",
    "}",
    "const ledger = new Ledger();",
    'console.log(ledger.record("a", 1), ledger.record("b", 2));',
    "console.log(ledger.sizes());",
    "ledger.reset();",
    'console.log(ledger.sizes(), ledger.record("c", 3));',
    "",
  ].join("\n"));
  assert.equal(output.trim(), "2 4\n2 2\n0 0 2");
});

test("an arrow's concise body may be the assignment it writes", async () => {
  // `() => (current ??= "none")` runs the write and answers the name, and
  // `() => total += n` is the same shape with the operator it wrote. The
  // parentheses are the writer's; the write is the `??` the operator names, so
  // the value is only computed where the name holds none.
  const output = await agreesWithNode([
    "export function run(name: string | undefined): string {",
    "  let current: string | undefined = name;",
    '  const get = (): string => (current ??= "none");',
    "  let total = 0;",
    "  const add = (n: number): number => total += n;",
    "  const set = (n: number): number => total = n;",
    "  add(2); add(3); set(10);",
    "  return `${get()} ${get()} ${current} ${total}`;",
    "}",
    'console.log(run("a"), run(undefined));',
    "",
  ].join("\n"));
  assert.equal(output.trim(), "a a a 10 none none none 10");
});

test("a push of an empty list writes a list of the element the list holds", async () => {
  // `rows.push([])` writes an empty list into a list of lists. The value is read
  // at the element the outer list holds, so it is a list of texts rather than a
  // list nothing says the element of, and the write is the helper the push
  // lowers to.
  const output = await agreesWithNode([
    "class Rows {",
    "  private rows: string[][] = [];",
    "  add(count: number): number {",
    "    for (let i = 0; i < count; i++) this.rows.push([]);",
    "    return this.rows.length;",
    "  }",
    "}",
    "const rows = new Rows();",
    "console.log(rows.add(3));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "3");
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

test("a map whose value is a set is read through the assertion that names it", async () => {
  // The value a map answers is a handle, and a handle says nothing about what
  // it holds: the assertion is what makes `add`, `has` and `size` the set's.
  const output = await agreesWithNode([
    "function g(): number {",
    "  const groups = new Map<string, Set<string>>();",
    "  const one = new Set<string>();",
    "  one.add(`x`);",
    "  groups.set(`a`, one);",
    "  const found = groups.get(`a`) as Set<string>;",
    "  found.add(`y`);",
    "  return (groups.get(`a`) as Set<string>).size * 10 + found.size;",
    "}",
    "console.log(g());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "22");
});

test("a value whose type the source did not write is tested at run time", async () => {
  // `typeof` of a value the read cannot type is the kind the runtime holds:
  // answering it from the type folded the test to a constant and compiled none
  // of the arms.
  const output = await agreesWithNode([
    "function kind(text: string): number {",
    "  const value = JSON.parse(text);",
    "  if (typeof value === `string`) return 1;",
    "  if (typeof value === `number`) return 2;",
    "  if (typeof value === `boolean`) return 3;",
    "  return 4;",
    "}",
    "console.log(kind(`\"a\"`) * 1000 + kind(`7`) * 100 + kind(`true`) * 10 + kind(`null`));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "1234");
});

test("a test of a value settles what the branch reads it as", async () => {
  // A guard that leaves the block, an arm of a conditional, and the right side
  // of a disjunction all read the value at the type their own test asked for.
  const output = await agreesWithNode([
    "function describe(text: string): string {",
    "  const value = JSON.parse(text);",
    "  if (typeof value === `string`) {",
    "    if (value.trim() === ``) return `blank`;",
    "    return value.trim();",
    "  }",
    "  return typeof value === `number` ? `number` : `other`;",
    "}",
    "function required(text: string): string {",
    "  const value = JSON.parse(text);",
    "  if (typeof value !== `string`) return `missing`;",
    "  return value.trim();",
    "}",
    "function blank(text: string): string {",
    "  const value = JSON.parse(text);",
    "  return typeof value !== `string` || value.trim() === `` ? `blank` : `text`;",
    "}",
    "function g(): string {",
    "  return [describe(`\"  \"`), describe(`\" hi \"`), describe(`4`), required(`\" a\"`), required(`[]`), blank(`\" \"`), blank(`\"b\"`)].join(`|`);",
    "}",
    "console.log(g());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "blank|hi|number|a|missing|blank|text");
});

test("toString with no radix writes a value as the text it is", async () => {
  // The radix sixteen form writes hexadecimal; with no radix at all the value
  // is written the way a template string writes it, which is what a bigint and
  // a number are asked for here.
  const output = await agreesWithNode([
    "function g(): string {",
    "  const n = 12;",
    "  const big = 255n;",
    "  return n.toString() + `,` + big.toString();",
    "}",
    "console.log(g());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "12,255");
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

test("a module re-exports another module's function and the program calls it", async () => {
  // `export { a } from "./x.ts"` offers a name the other module writes: the
  // function is compiled once, by the module that declares it, and a caller
  // that imports it from the re-exporting module reaches the same function.
  const output = await agreesWithNode(
    [
      'import { shout } from "./platform.ts";',
      'console.log(shout(" hi "));',
      "",
    ].join("\n"),
    {
      "platform.ts": 'export { shout } from "./impl.ts";\n',
      "impl.ts": "export function shout(text: string): string {\n  return text.trim().toUpperCase() + `!`;\n}\n",
    },
  );
  assert.equal(output.trim(), "HI!");
});

test("a function-typed field is called through the value the caller wrote", async () => {
  // `Sink` is an interface whose `write` is a function, and the value the
  // program passes is an object literal whose `write` is an arrow that reads a
  // name from the function around it. The call in `greet` goes through the
  // field, so the arrow is carried as the value the field holds.
  const output = await agreesWithNode([
    "interface Sink { write(text: string): void }",
    "function greet(sink: Sink): void {",
    '  sink.write("hello");',
    '  sink.write(" world");',
    "}",
    "export function runIt(): void {",
    '  const mark = ">";',
    "  greet({ write: (text: string): void => { console.log(mark + text); } });",
    "}",
    "runIt();",
    "",
  ].join("\n"));
  assert.equal(output, ">hello\n> world\n");
});

test("a set held in a map is a handle the questions written after it reach", async () => {
  // The map holds the set's handle, and the value a key answers is the set the
  // program wrote there: `has` is the dictionary's own question about it.
  const output = await agreesWithNode([
    "export function hit(): number {",
    "  const sets = new Map<string, Set<string>>();",
    "  const seen = new Set<string>();",
    '  seen.add("alpha");',
    '  sets.set("x", seen);',
    '  return sets.get("x").has("alpha") ? 1 : 0;',
    "}",
    "console.log(hit());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "1");
});

test("a call hands an object literal at the type the declaration states", async () => {
  // The arrow's parameter is an interface, and the value the caller writes is
  // an object literal whose `tags` field is an empty list: the declaration is
  // what says the list holds texts, and the call is what hands it over.
  const output = await agreesWithNode([
    "interface Input { tags: string[]; label: string }",
    "export function run(): string {",
    "  const describe = (one: Input): string => one.label + (one.tags.length === 0 ? `: empty` : `: full`);",
    "  return describe({ tags: [], label: `none` });",
    "}",
    "console.log(run());",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "none: empty");
});

test("a conditional answers the record the arm that has a type answers", async () => {
  // One arm is a literal with an empty list and the other is a call whose
  // declaration states the record: the arm without a type is read at the one
  // with it, so the empty list is a list of the elements the field names.
  const output = await agreesWithNode([
    "interface Expanded { value: string; pre: string[] }",
    "export function f(start: string | null): number {",
    "  const expand = (one: string): Expanded => ({ value: one, pre: [one] });",
    "  const one = start === null ? { value: `none`, pre: [] } : expand(start);",
    "  return one.pre.length;",
    "}",
    "console.log(f(null), f(`ab`));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "0 1");
});

test("a DataView over a typed array writes and reads the bytes of it", async () => {
  // The block a `Uint8Array` is holds the bytes a `DataView` writes: a sixteen
  // bit value is two stores, a thirty-two bit one is four, and `bytes.set`
  // copies a list into the block.
  const output = await agreesWithNode([
    "export function main(): number {",
    "  const bytes = new Uint8Array(12);",
    "  const view = new DataView(bytes.buffer);",
    "  view.setUint16(0, 0x1234, true);",
    "  view.setUint32(2, 0x12345678, true);",
    "  bytes.set([9, 8, 7], 8);",
    "  const a = view.getUint16(0, true);",
    "  const b = view.getUint32(2, true);",
    "  const c = view.getUint8(9);",
    "  console.log(`${a} ${b} ${c} ${bytes.byteLength}`);",
    "  return a;",
    "}",
    "main();",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "4660 305419896 8 12");
});

test("a sixty-four bit store writes the digits of the number it is given", async () => {
  // `setBigUint64` writes eight bytes of the whole number from the least
  // significant up, and `getBigUint64` reads them back as one.
  const output = await agreesWithNode([
    "export function main(): number {",
    "  const bytes = new Uint8Array(16);",
    "  const view = new DataView(bytes.buffer);",
    "  const base = 4294967296;",
    "  const big = BigInt(base) * 3n + 5n;",
    "  view.setBigUint64(0, big, true);",
    "  const back = Number(view.getBigUint64(0, true));",
    "  console.log(`${back} ${bytes[0]} ${bytes[4]} ${bytes[7]}`);",
    "  return back;",
    "}",
    "main();",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "12884901893 5 3 0");
});

test("a reference a conditional spread leaves out is the null it is read as", async () => {
  // The field is written on the arm that holds the object and left at the null
  // reference on the other, and `one.tail === undefined` is that null test.
  const output = await agreesWithNode([
    "interface Handle { name: string; tail?: Box }",
    "class Box { value: number = 1; }",
    "export function f(c: boolean): number {",
    "  const tail = new Box();",
    "  const one: Handle = { name: `a`, ...(c ? {} : { tail }) };",
    "  return one.name.length + (one.tail === undefined ? 0 : one.tail.value);",
    "}",
    "console.log(f(true), f(false));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "1 2");
});

test("a program writes its output and its errors to the streams the source names", async () => {
  // The two stream names are the two streams: the write does not end the line,
  // the console does, and a program body and a function body write the same
  // way.
  for (const backend of ["c", "machine"] as const) {
    const { directory, binary } = await build(
      [
        "export function f(): void {",
        "  process.stdout.write(`out `);",
        "  process.stderr.write(`err `);",
        "  console.log(`line`);",
        "}",
        "f();",
        "",
      ].join("\n"),
      backend,
    );
    const delivered = run(binary, [], { timeoutMs: 60_000 });
    const original = run("node", ["--experimental-strip-types", "main.ts"], { cwd: directory, timeoutMs: 60_000 });
    assert.equal(original.code, 0, original.stderr);
    assert.equal(delivered.code, 0, delivered.stderr);
    assert.equal(delivered.stdout, original.stdout, `the ${backend} backend writes the output stream`);
    assert.equal(delivered.stderr, original.stderr, `the ${backend} backend writes the error stream`);
  }
});

test("a program measures a duration on the clock the runtime reads", async () => {
  // The clock is the runtime's, and a reading is a whole number of nanoseconds:
  // what the source subtracts from a later reading is a duration, and both
  // backends read the same clock the source reads under node.
  const source = [
    "export function measure(): number {",
    "  const started = process.hrtime.bigint();",
    "  const finished = process.hrtime.bigint();",
    "  return finished >= started ? Number(finished - started) : -1;",
    "}",
    "console.log(measure() >= 0 ? `measured` : `backwards`);",
    "",
  ].join("\n");
  for (const backend of ["c", "machine"] as const) {
    const { directory, binary } = await build(source, backend);
    const original = run("node", ["--experimental-strip-types", "main.ts"], { cwd: directory, timeoutMs: 60_000 });
    const delivered = run(binary, [], { timeoutMs: 60_000 });
    assert.equal(original.code, 0, original.stderr);
    assert.equal(delivered.code, 0, delivered.stderr);
    assert.equal(delivered.stdout, original.stdout, `the ${backend} backend reads the clock`);
    assert.equal(delivered.stdout, "measured\n");
  }
});

/**
 * Classes: what a TypeScript class lowers to, and what the pieces are called.
 *
 * A class is not a runtime shape of its own. Its constructor is a function that
 * returns an object literal, its methods are functions whose first parameter is
 * the instance, and its static members are functions of the class. The tests
 * here read that lowering, and the program tests run what it computes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { irOf, programOf, programWithSemantics } from "./phase.ts";
import { typeScriptFrontend } from "../semantics/typescript.ts";

const VECTOR = [
  "class Vector {",
  "  static ORIGIN = new Vector(0, 0);",
  "  x: number;",
  "  y: number;",
  "  constructor(x: number, y: number) { this.x = x; this.y = y; }",
  "  add(p: Vector): Vector { return new Vector(this.x + p.x, this.y + p.y); }",
  "  scale(k: number = 2): number { return this.x * k; }",
  "  static zero(): Vector { return Vector.ORIGIN; }",
  "}",
  "const p = new Vector(1, 2);",
  "const q = p.add(Vector.ORIGIN);",
  "const z = Vector.zero();",
  "console.log(q.x, q.y, p.scale(), z.x);",
  "",
].join("\n");

test("a class becomes a constructor, its methods and its static members", () => {
  const program = programOf("typescript", { "main.ts": VECTOR }, "main.ts");
  const functions = Object.keys(program.files[0].functions);
  assert.ok(functions.includes("Vector"), "the constructor is a function named for the class");
  assert.ok(functions.includes("Vector_add"), "a method is a function of the class");
  assert.ok(functions.includes("Vector_scale"), "the full method takes every parameter");
  assert.ok(functions.includes("Vector_scale__0"), "the default arity is an overload of its own");
  assert.ok(functions.includes("Vector_ORIGIN"), "a static field is read through a function");
  assert.ok(functions.includes("Vector_zero"), "a static method is a function of the class");
});

test("the constructor builds one layout, and a method reads it at its offsets", () => {
  // The constructor returns an object literal, and the object pass lays it out
  // once. The class's own name is an alias of that layout, so a method that
  // answers an instance names the layout a caller reads its fields at.
  const ir = irOf("typescript", { "main.ts": VECTOR }, "main.ts", "Vector_add");
  assert.match(ir, /function Vector_add\(self: ref<Vector>, p: ref<Vector>\) -> ref<Vector>/);
  assert.match(ir, /object Object1 size 16 align 8/);
  assert.match(ir, /field x: f64 at 0/);
  assert.match(ir, /field y: f64 at 8/);
  // The field is read at the layout the parameter names — the class's own name is
  // an alias of the constructor's layout, and the two are the same bytes.
  assert.match(ir, /load_field\[f64\].* (?:Object1|Vector) x/);
});

test("a field names its type in every form the language writes", () => {
  // `readonly`, an object type, a tuple and a union of string literals are all
  // annotations a field may write, and `= []` is built at the element type each
  // one names. A field whose type was read as `any` would leave the empty list
  // without an element.
  const source = [
    "class Ledger {",
    "  private readonly rows: { name: string; count: number }[] = [];",
    "  private readonly turns: [number, number][] = [];",
    "  private readonly states: (\"open\" | \"closed\")[] = [];",
    "  total(): number {",
    "    return this.rows.length + this.turns.length + this.states.length;",
    "  }",
    "}",
    "console.log(new Ledger().total());",
    "",
  ].join("\n");
  const program = programOf("typescript", { "main.ts": source }, "main.ts");
  assert.ok(Object.keys(program.files[0].functions).includes("Ledger_total"));
});

test("a method's result may be a union of object types or a predicate", () => {
  // A result written as a union of object types, or as the object an `is`
  // predicate names, has more than one brace in it. The body is the brace the
  // type does not hold, and every member the class writes after it is read.
  const source = [
    "type Entry = { k: string };",
    "class Table {",
    "  private rows: Entry[] = [];",
    "  private pick(left: Entry, right: Entry): { hit: Entry } | { miss: true } {",
    "    return left.k === right.k ? { hit: left } : { miss: true };",
    "  }",
    "  private isHit(value: Entry | null): value is Entry & { k: \"hit\" } {",
    "    return value !== null && value.k === \"hit\";",
    "  }",
    "  count(): number {",
    "    return this.rows.length + (this.pick(this.rows[0], this.rows[0]).hit ? 1 : 0);",
    "  }",
    "  cache(loop: number): Map<string, { register: number; established: boolean }> {",
    "    return new Map();",
    "  }",
    "}",
    "console.log(new Table().count());",
    "",
  ].join("\n");
  const program = programOf("typescript", { "main.ts": source }, "main.ts");
  const functions = Object.keys(program.files[0].functions);
  assert.ok(functions.includes("Table_pick"), `the union result is read: ${functions.join(", ")}`);
  assert.ok(functions.includes("Table_isHit"), "the predicate result is read");
  assert.ok(functions.includes("Table_count"), "the member after them is read");
  assert.ok(functions.includes("Table_cache"), "an object type inside a type argument is part of the type");
});

test("a method on a field of an imported type waits for the link", () => {
  // A file is read before its imports are linked, so a class field written at
  // an imported type is `any` on that read. A method written on the field is
  // not refused there: the read that follows the link holds the declaration and
  // reads the method against the field's own type.
  const ir = irOf(
    "typescript",
    {
      "names.ts": "export interface Name { text: string }\n",
      "holder.ts": [
        'import { type Name } from "./names.ts";',
        "export class Holder {",
        "  readonly name: Name;",
        "  constructor(name: Name) { this.name = name; }",
        "  read(): string { return this.name.text.trim(); }",
        "}",
        "",
      ].join("\n"),
      "main.ts": 'import { Holder } from "./holder.ts";\nconsole.log(0);\n',
    },
    "main.ts",
    "Holder_read",
  );
  assert.match(ir, /text\.trim/);
});

test("a chain of methods on an imported type waits for the link, callback and all", () => {
  // A method on a value of an unlinked imported type is not refused, and what
  // it answers is a value of the same declaration: the method written on that
  // answer waits too. The callback it hands the method is handed the element of
  // a list whose element type is in the other module, so a parameter the source
  // did not annotate waits for the link as well — a text method written on the
  // element is not this read's to refuse.
  const program = programOf(
    "typescript",
    {
      "names.ts": "export interface Name { text: string }\n",
      "holder.ts": [
        'import { type Name } from "./names.ts";',
        "export function read(names: Name[]): string {",
        "  return names.filter((name) => name.text.length > 0).map((name) => name.text.trim()).join(`,`);",
        "}",
        "",
      ].join("\n"),
      "main.ts": 'import { read } from "./holder.ts";\nconsole.log(0);\n',
    },
    "main.ts",
  );
  const holder = program.files.find((file) => file.path === "holder.ts");
  assert.ok(holder !== undefined, "the file that reads the chain is a module of the program");
  assert.ok(Object.keys(holder.functions).includes("read"), "the chain is a function the program compiles");
});

test("`extends Error` adds the message field and `super` writes it", () => {
  // The one base a class may name is Error, and the one field it brings is the
  // message: `super(message)` is the write of that field, and the class's own
  // fields are laid out beside it.
  const source = [
    "class Failure extends Error {",
    "  readonly stage: string;",
    "  constructor(stage: string, message: string) { super(message); this.stage = stage; }",
    "  describe(): string { return `${this.stage}: ${this.message}`; }",
    "}",
    "console.log(new Failure(`parse`, `bad`).describe());",
    "",
  ].join("\n");
  const ir = irOf("typescript", { "main.ts": source }, "main.ts", "Failure");
  assert.match(ir, /field stage: text/);
  assert.match(ir, /field message: text/);
  assert.match(ir, /store_field .* Object1 message local\[text\] message/);
});

test("a call of a method passes the instance as its first argument", () => {
  const body = typeScriptFrontend.analyze(VECTOR, "main.ts").body;
  const q = body.find((statement) => statement.kind === "declare" && statement.name === "q");
  assert.ok(q !== undefined && q.kind === "declare");
  const value = q.value;
  assert.equal(value.k, "call");
  if (value.k !== "call") return;
  assert.equal(value.function, "Vector_add");
  assert.equal(value.args[0]?.k, "name", "the instance is the first argument");
  assert.equal(value.args[0]?.k === "name" ? value.args[0].name : null, "p");
});

test("a static method call has no instance argument", () => {
  const body = typeScriptFrontend.analyze(VECTOR, "main.ts").body;
  const zero = body.find((statement) => statement.kind === "declare" && statement.name === "z");
  assert.ok(zero !== undefined && zero.kind === "declare");
  assert.equal(zero.value.k, "call");
  if (zero.value.k !== "call") return;
  assert.equal(zero.value.function, "Vector_zero");
  assert.deepEqual(zero.value.args, [], "a static method is called with only what the source wrote");
});

test("a class type is a reference the object pass settles", () => {
  // `Vector` in an annotation is not a primitive and not an unknown type: it is
  // the instance the constructor builds, so the contract states a reference.
  const { program } = programWithSemantics("typescript", { "main.ts": VECTOR }, "main.ts");
  const vector = program.files[0].functions.Vector;
  assert.ok(vector !== undefined);
  assert.match(vector.function.returns, /^ref</);
  const add = program.files[0].functions.Vector_add;
  assert.ok(add !== undefined);
  assert.equal(add.function.params[0]?.type, "ref<Vector>");
});

test("a constructor's default parameters are overloads of the constructor", () => {
  const source = [
    "class Counter {",
    "  value: number;",
    "  constructor(value: number = 7) { this.value = value; }",
    "}",
    "const a = new Counter();",
    "const b = new Counter(2);",
    "console.log(a.value, b.value);",
    "",
  ].join("\n");
  const program = programOf("typescript", { "main.ts": source }, "main.ts");
  assert.ok(program.files[0].functions.Counter__0 !== undefined, "the zero-argument overload is generated");
  const body = typeScriptFrontend.analyze(source, "main.ts").body;
  const a = body.find((statement) => statement.kind === "declare" && statement.name === "a");
  assert.ok(a !== undefined && a.kind === "declare");
  assert.equal(a.value.k, "call");
  if (a.value.k === "call") assert.equal(a.value.function, "Counter__0");
  const b = body.find((statement) => statement.kind === "declare" && statement.name === "b");
  assert.ok(b !== undefined && b.kind === "declare");
  assert.equal(b.value.k, "call");
  if (b.value.k === "call") assert.equal(b.value.function, "Counter", "the written arity is the full constructor");
});

test("instanceof is answered by the class the value is declared as", () => {
  const source = [
    "class A { x: number = 1; }",
    "class B { y: number = 2; }",
    "const a = new A();",
    "const b = new B();",
    "console.log(a instanceof A, a instanceof B, b instanceof A);",
    "",
  ].join("\n");
  const body = typeScriptFrontend.analyze(source, "main.ts").body;
  const print = body.find((statement) => statement.kind === "print");
  assert.ok(print !== undefined && print.kind === "print");
  // `instanceof` is a truth, so a program prints it the way the language writes
  // a truth rather than as the number a comparison used to answer with.
  const answers = print.values.map((value) =>
    value.k === "boolean" ? (value.value ? "true" : "false") : value.k,
  );
  assert.deepEqual(answers, ["true", "false", "false"]);
});

test("a parameter property is a field the constructor fills", () => {
  const source = [
    "class Pair {",
    "  constructor(public a: number, public b: number) {}",
    "  sum(): number { return this.a + this.b; }",
    "}",
    "function f(): number { return new Pair(1, 2).sum(); }",
    "console.log(f());",
    "",
  ].join("\n");
  const ir = irOf("typescript", { "main.ts": source }, "main.ts", "Pair");
  assert.match(ir, /function Pair\(a: f64, b: f64\) -> ref<Pair>/);
  assert.match(ir, /new_object\[ref<Object1>\] Object1 a local\[f64\] a b local\[f64\] b/);
  assert.match(irOf("typescript", { "main.ts": source }, "main.ts", "Pair_sum"), /field a: f64 at 0/);
});

test("an exported class offers its constructor to an importer", () => {
  const library = "export default class Pair { constructor(public a: number, public b: number) {} }\n";
  const program = programOf(
    "typescript",
    { "main.ts": 'import Pair from "./lib.ts";\nconsole.log(1);\n', "lib.ts": library },
    "main.ts",
  );
  const lib = program.files.find((file) => file.path === "lib.ts");
  assert.ok(lib !== undefined);
  assert.ok(lib.functions.Pair !== undefined, "the constructor is the class's exported name");
  assert.equal(
    program.edges.find((edge) => edge.from === "main.ts")?.symbols.includes("Pair"),
    true,
    "the default import binds the class under the name it was declared with",
  );
});

test("the class functions are compiled with the file but are not its exports", () => {
  // A source names the class, not the functions it becomes. They travel in the
  // contract graph because the exported function calls them, and an importer
  // binds only the names the module exports.
  const library = [
    "class Point {",
    "  x: number;",
    "  y: number;",
    "  constructor(x: number, y: number) { this.x = x; this.y = y; }",
    "  sum(): number { return this.x + this.y; }",
    "}",
    "export function total(x: number, y: number): number {",
    "  const p = new Point(x, y);",
    "  return p.sum();",
    "}",
    "",
  ].join("\n");
  const program = programOf(
    "typescript",
    { "main.ts": 'import { total } from "./lib.ts";\nconsole.log(total(1, 2));\n', "lib.ts": library },
    "main.ts",
  );
  const lib = program.files.find((file) => file.path === "lib.ts");
  assert.ok(lib !== undefined);
  assert.ok(lib.functions.Point !== undefined, "the constructor is compiled");
  assert.ok(lib.functions.Point_sum !== undefined, "the method is compiled");
  // The generated names are not offered to another module.
  assert.throws(
    () =>
      programOf(
        "typescript",
        { "main.ts": 'import { Point } from "./lib.ts";\nconsole.log(1);\n', "lib.ts": library },
        "main.ts",
      ),
    /imports "Point" from "\.\/lib\.ts", which does not export it/,
  );
});

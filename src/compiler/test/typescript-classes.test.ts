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
  assert.match(ir, /load_field\[f64\].* Object1 x/);
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
  const answers = print.values.map((value) => (value.k === "number" ? value.text : value.k));
  assert.deepEqual(answers, ["1", "0", "0"]);
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

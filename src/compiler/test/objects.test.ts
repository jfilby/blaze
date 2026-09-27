/**
 * Objects: what a function allocates, and the layout every field sits at.
 *
 * The tree of `src/examples/binarytrees/1.ts` is the case the pass exists for:
 * `createTree` writes a node, `checksum` reads its fields, and neither states a
 * result as one expression, so the contract carries the layout instead.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { typeScriptFrontend } from "../semantics/typescript.ts";
import { programOf } from "./phase.ts";
import { diagnostic } from "./phase.ts";
import { parseContract } from "../semantics/contract.ts";

const TREE = [
  "function checksum(node: any): number {",
  "  if (!node.left) {",
  "    return 1;",
  "  }",
  "  return 1 + checksum(node.left) + checksum(node.right);",
  "}",
  "",
  "function createTree(depth: number): any {",
  "  return depth-- > 0",
  "    ? { left: createTree(depth), right: createTree(depth) }",
  "    : { left: null, right: null };",
  "}",
  "",
  "main();",
  "",
].join("\n");

function contractsOf(files: Record<string, string>, entry: string) {
  return programOf("typescript", files, entry).files.find((file) => file.path === entry)?.functions ?? {};
}

test("an object a program allocates is laid out once, and named in the type that returns it", () => {
  const contracts = contractsOf({ "1.ts": TREE }, "1.ts");
  const createTree = contracts.createTree;
  const checksum = contracts.checksum;
  assert.ok(createTree !== undefined && checksum !== undefined);

  // The body of createTree returns an object literal, so the declared `any`
  // becomes a reference to the object the program lays out.
  assert.equal(createTree.function.returns, "ref<Object1>");
  const objects = createTree.definition?.objects ?? {};
  assert.deepEqual(Object.keys(objects), ["Object1"]);
  assert.deepEqual(objects.Object1, {
    name: "Object1",
    size: 16,
    align: 8,
    fields: [
      { name: "left", type: "ref<any>", offset: 0 },
      { name: "right", type: "ref<any>", offset: 8 },
    ],
  });

  // Every function of the program sees the same object: the node createTree
  // writes is the node checksum reads, and the driver declares it once.
  assert.deepEqual(Object.keys(checksum.definition?.objects ?? {}), ["Object1"]);
  assert.deepEqual(createTree.effects, ["memory"]);
  assert.deepEqual(checksum.effects, []);
});

test("fields of different widths are laid out at their own alignment", () => {
  const analysis = typeScriptFrontend.analyze(
    [
      "export function make(): any {",
      "  return { count: 1, name: 2, wide: 3, ratio: 4 };",
      "}",
      "",
    ].join("\n"),
    "make.ts",
  );
  assert.equal(analysis.functions.length, 1);

  const contracts = contractsOf(
    {
      "make.ts": [
        "export function make(): any {",
        "  return { count: 1, name: 2, wide: 3, ratio: 4 };",
        "}",
        "console.log(`${make()}`);",
        "",
      ].join("\n"),
    },
    "make.ts",
  );
  const objects = contracts.make.definition?.objects ?? {};
  const object = objects.Object1;
  assert.ok(object !== undefined);
  // Every field is a number, so each is a double on its own boundary and the
  // object is the size of four of them.
  assert.deepEqual(
    object.fields.map((field) => [field.name, field.offset]),
    [
      ["count", 0],
      ["name", 8],
      ["wide", 16],
      ["ratio", 24],
    ],
  );
  assert.equal(object.size, 32);
  assert.equal(object.align, 8);
});

test("two objects with the same fields are one object, whatever wrote them", () => {
  const contracts = contractsOf(
    {
      "main.ts": [
        "export function leaf(): any {",
        "  return { left: null, right: null };",
        "}",
        "export function grow(): any {",
        "  return { left: leaf(), right: leaf() };",
        "}",
        "console.log(`${grow()}`);",
        "",
      ].join("\n"),
    },
    "main.ts",
  );
  assert.equal(contracts.grow.function.returns, "ref<Object1>");
  assert.equal(contracts.leaf.function.returns, "ref<Object1>");
  assert.deepEqual(Object.keys(contracts.leaf.definition?.objects ?? {}), ["Object1"]);
});

test("a field name that reads like another shape's key does not give two objects one layout", () => {
  // `{ a: 1, b: 2 }` and `{ "a:f64,b": 2 }` hold different fields, and one
  // key gave both the same eight bytes: `two` then wrote its second double
  // past the end of an allocation the contract said was eight bytes long.
  const contracts = contractsOf(
    {
      "1.ts": [
        "function two(): any { return { a: 1, b: 2 }; }",
        "function one(): any { return { \"a:f64,b\": 2 }; }",
        "main();",
        "",
      ].join("\n"),
    },
    "1.ts",
  );
  const two = contracts.two.definition?.objects ?? {};
  const one = contracts.one.definition?.objects ?? {};
  assert.notDeepEqual(two, one);
  assert.equal(contracts.two.function.returns, "ref<Object1>");
  assert.equal(contracts.one.function.returns, "ref<Object2>");
  assert.deepEqual(two.Object1.fields, [
    { name: "a", type: "f64", offset: 0 },
    { name: "b", type: "f64", offset: 8 },
  ]);
  assert.equal(two.Object1.size, 16);
  assert.deepEqual(one.Object2.fields, [{ name: "a:f64,b", type: "f64", offset: 0 }]);
  assert.equal(one.Object2.size, 8);
});

test("the operand of `??` is a reference, not a double", () => {
  // `node.left ?? null` is the reference `node.left` is, whatever the fallback
  // is: a layout that called it a double wrote a pointer into eight bytes of
  // a double field.
  const contracts = contractsOf(
    {
      "1.ts": [
        "function make(node: any): any {",
        "  const child = node.left ?? null;",
        "  return { child: child, tag: 0 };",
        "}",
        "main();",
        "",
      ].join("\n"),
    },
    "1.ts",
  );
  const object = (contracts.make.definition?.objects ?? {}).Object1;
  assert.ok(object !== undefined);
  assert.deepEqual(
    object.fields.map((field) => [field.name, field.type]),
    [
      ["child", "ref<any>"],
      ["tag", "f64"],
    ],
  );
  assert.equal(object.size, 16);
});

test("the operand of `!` is typed, so a name it uses is still reported", () => {
  const message = diagnostic(() =>
    contractsOf(
      { "1.ts": ["function f(n: number): number {", "  if (!neverDeclared) { return 1; }", "  return 0;", "}", "main();", ""].join("\n") },
      "1.ts",
    ),
  );
  assert.match(message, /uses "neverDeclared" before it is declared/);
});

test("a field the body writes holds what it was written with", () => {
  const contracts = contractsOf(
    {
      "1.ts": [
        "function fill(): any {",
        "  const o = { v: null };",
        "  o.v = 5;",
        "  o.w = 2;",
        "  return o;",
        "}",
        "main();",
        "",
      ].join("\n"),
    },
    "1.ts",
  );
  const object = (contracts.fill.definition?.objects ?? {}).Object1;
  assert.ok(object !== undefined);
  // The body stores doubles, so the layout declares doubles: a field declared
  // as a pointer made the backend write a double where a pointer was read.
  assert.deepEqual(
    object.fields.map((field) => [field.name, field.type]),
    [
      ["v", "f64"],
      ["w", "f64"],
    ],
  );
  assert.equal(object.size, 16);
});

test("a name declared in a branch is not declared after it", () => {
  // One environment for both arms let `x` be read in the other arm and after
  // the statement, where the source would not compile at all.
  const message = diagnostic(() =>
    contractsOf(
      {
        "1.ts": [
          "function f(n: number): number {",
          "  if (n > 0) { const x = 1; }",
          "  return x;",
          "}",
          "main();",
          "",
        ].join("\n"),
      },
      "1.ts",
    ),
  );
  assert.match(message, /uses "x" before it is declared/);
});

test("a field name that is not an identifier is refused before it reaches an emitter", () => {
  const bad = contractsOf(
    {
      "1.ts": [
        "function o(): any {",
        "  return { \"a b\": 1, \"c-d\": 2, \"e;\": 3 };",
        "}",
        "main();",
        "",
      ].join("\n"),
    },
    "1.ts",
  );
  // The C emitter writes a field name into a declaration verbatim, so a name
  // with a space or a semicolon in it is code that cannot compile.
  assert.match(diagnostic(() => parseContract(bad.o)), /invalid field name "a b"/);

  const good = contractsOf(
    { "1.ts": ["function o(): any {", "  return { a: 1, _b: 2, c9: 3 };", "}", "main();", ""].join("\n") },
    "1.ts",
  );
  const parsed = parseContract(good.o);
  assert.deepEqual(
    parsed.contract.definition?.objects?.Object1.fields.map((field) => field.name),
    ["a", "_b", "c9"],
  );
});

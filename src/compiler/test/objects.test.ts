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

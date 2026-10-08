/**
 * Objects: what a function allocates, and the layout every field sits at.
 *
 * The tree of `src/benchmarks/c_backend/binarytrees/1.ts` is the case the pass exists for:
 * `createTree` writes a node, `checksum` reads its fields, and neither states a
 * result as one expression, so the contract carries the layout instead.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { typeScriptFrontend } from "../semantics/typescript.ts";
import { programOf, phaseOf, semanticsOf } from "./phase.ts";
import { diagnostic } from "./phase.ts";
import { printSemanticFunction } from "../semantics/ir-text.ts";
import { parseContract } from "../semantics/contract.ts";
import { resolveFunction } from "../semantics/ir-function.ts";
import { resolveProgram } from "../semantics/ir-resolve.ts";
import { generateProgramDriver } from "../toolchain/driver.ts";
import { statementBlocksOf, type SemanticBlock, type SemanticLoop } from "../core/semantic-ir.ts";

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

test("a field wider than a machine word is laid out as its limbs, not as one pointer", () => {
  // A `u256` is four limbs of eight bytes and every backend holds it that way,
  // so a layout that reserved the default eight bytes for it gave a thirty-two
  // byte field eight bytes of room — and the backends write at the offset the
  // contract names, so writing the wide field went over whatever followed it.
  // It is placed at the alignment of a limb rather than of itself: a field is a
  // sequence of limbs, and aligning the whole of one to thirty-two would pad
  // most of the object out with addressable memory nothing was written to.
  const contracts = contractsOf(
    {
      "make.ts": [
        "export function make(big: u256): any {",
        "  const tail: number = 7;",
        "  return { big: big, tail: tail };",
        "}",
        "console.log(`${make(1n)}`);",
        "",
      ].join("\n"),
    },
    "make.ts",
  );
  const object = (contracts.make.definition?.objects ?? {}).Object1;
  assert.ok(object !== undefined, "the object the body writes is laid out");
  assert.deepEqual(
    object.fields.map((field) => [field.name, field.type, field.offset]),
    [
      ["big", "u256", 0],
      ["tail", "f64", 32],
    ],
  );
  assert.equal(object.size, 40);
  assert.equal(object.align, 8);
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
  // The layouts themselves are the invariant, not which functions carry them:
  // every function states the program's objects, because a function reads an
  // object another wrote and the driver declares one set. What must differ
  // here is the two layouts, and the two return types.
  const two = contracts.two.definition?.objects ?? {};
  const one = contracts.one.definition?.objects ?? {};
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

test("a field written from a loop counter holds the type the literal gave it", () => {
  // The counter is what the loop starts at, not a `usize` whatever it was
  // written at. Typing it `usize` made this field a `size_t` where the same
  // literal gave every other function a `double`, and an object two functions
  // build the same way is one object to the program, so the build was refused.
  const contracts = contractsOf(
    {
      "main.ts": [
        "export function make(n: number): any {",
        "  const o = { value: 0, other: 0 };",
        "  for (let i = 0; i < n; i++) { o.value = i; }",
        "  return o;",
        "}",
        "export function seed(): any { return { value: 0, other: 0 }; }",
        "console.log(`${make(2)} ${seed()}`);",
        "",
      ].join("\n"),
    },
    "main.ts",
  );
  const make = parseContract(contracts.make);
  const seed = parseContract(contracts.seed);
  // Both functions build the object the same way, so both are given the one
  // layout. The field is a double, which is what a number in the source is.
  assert.deepEqual(make.contract.definition?.objects?.Object1.fields.map((field) => [field.name, field.type]), [
    ["value", "f64"],
    ["other", "f64"],
  ]);
  assert.deepEqual(
    seed.contract.definition?.objects?.Object1.fields.map((field) => field.type),
    make.contract.definition?.objects?.Object1.fields.map((field) => field.type),
  );
});

test("a name declared in a loop body is not in scope after the loop", () => {
  // A loop body is a scope, as an `if` arm is. A flat environment let a name
  // declared inside one outlive it, so a body the source would not compile was
  // walked and given a layout built from a name that is not there.
  const refused = diagnostic(() =>
    contractsOf(
      {
        "1.ts": [
          "export function make(n: number): any {",
          "  for (let i = 0; i < n; i++) { const o = { value: 0 }; }",
          "  return o;",
          "}",
          "",
        ].join("\n"),
      },
      "1.ts",
    ),
  );
  assert.match(refused, /uses "o" before it is declared/);
});

test("a field name declared twice in a literal is refused before it reaches an emitter", () => {
  // The C and Nim declarations write the field name verbatim, one per
  // declaration, so a literal that names a field twice declares the same
  // member twice in the struct. That is code no target compiler takes, and it
  // told the model the field sat at two offsets at once.
  const repeated = contractsOf(
    {
      "main.ts": ["export function make(): any {", "  return { a: 1, a: 2 };", "}", "console.log(`${make()}`);", ""].join("\n"),
    },
    "main.ts",
  );
  assert.match(diagnostic(() => parseContract(repeated.make)), /field Object1\.a is declared twice/);
});

test("a call named after an Object.prototype member is refused as an unknown call", () => {
  // A call is named by whatever the source called it, and the builtins are
  // read off a plain object: `toString` answered from `Object.prototype` as a
  // builtin whose `params` was undefined, and counting them threw a TypeError
  // rather than reporting the call the program does not compile.
  for (const name of ["toString", "valueOf", "constructor", "hasOwnProperty", "isPrototypeOf"]) {
    const refused = diagnostic(() =>
      contractsOf(
        { "main.ts": ["export function f(x: number): number {", `  return ${name}(x);`, "}", ""].join("\n") },
        "main.ts",
      ),
    );
    assert.match(refused, new RegExp(`calls "${name}", which the program does not compile`));
  }
});

/**
 * A node the body reads unevenly: `hot` three times, `link` once, the rest never.
 *
 * The reads are inside the function that writes the node, which is what counts
 * them: a field is counted against an object the body can name, and a name the
 * source annotated `any` names no object.
 */
const SKEWED = [
  "function run(count: number): number {",
  "  let head = { link: null, hot: 0, cold: 0, colder: 0 };",
  "  let i = 0;",
  "  while (i < count) {",
  "    head = { link: head, hot: i, cold: 0, colder: 0 };",
  "    i += 1;",
  "  }",
  "  let sum = 0;",
  "  let cur = head;",
  "  while (cur !== null) {",
  "    sum += cur.hot + cur.hot + cur.hot;",
  "    cur = cur.link;",
  "  }",
  "  return sum;",
  "}",
  "main();",
  "",
].join("\n");

/** The same node, walked by a function the source could only type `any`. */
const BLIND = [
  "function walk(cur: any): number {",
  "  let sum = 0;",
  "  while (cur !== null) {",
  "    sum += cur.hot + cur.hot + cur.hot;",
  "    cur = cur.link;",
  "  }",
  "  return sum;",
  "}",
  "function make(count: number): any {",
  "  let head: any = null;",
  "  let i = 0;",
  "  while (i < count) {",
  "    head = { link: head, hot: i, cold: 0, colder: 0 };",
  "    i += 1;",
  "  }",
  "  return walk(head);",
  "}",
  "main();",
  "",
].join("\n");

test("a field the program reads more often is laid out nearer the front of its object", () => {
  const contracts = contractsOf({ "1.ts": SKEWED }, "1.ts");
  const run = contracts.run;
  assert.ok(run !== undefined);
  const layout = run.definition?.objects?.Object1;
  assert.ok(layout !== undefined, "the program lays out the node it walks");

  // `hot` is read three times where every other field is read at most once, so
  // it takes the offset the source wrote it second in and the fields nobody
  // reads are pushed past it. The size does not move: a layout is the same size
  // whatever order it lays its fields out in.
  assert.deepEqual(
    layout.fields.map((field) => [field.name, field.offset]),
    [["hot", 0], ["link", 8], ["cold", 16], ["colder", 24]],
  );
  assert.equal(layout.size, 32);
});

test("a field only an `any` reads is not counted, so the layout is left as the source wrote it", () => {
  // The reads that order a layout are counted against an object the body can
  // name. `cur` is an `any` here, so `cur.hot` is counted against no object and
  // every field counts zero: the order the source wrote is the order kept.
  const contracts = contractsOf({ "1.ts": BLIND }, "1.ts");
  const make = contracts.make;
  assert.ok(make !== undefined);
  const layout = make.definition?.objects?.Object1;
  assert.ok(layout !== undefined);
  assert.deepEqual(
    layout.fields.map((field) => [field.name, field.offset]),
    [["link", 0], ["hot", 8], ["cold", 16], ["colder", 24]],
  );
  assert.equal(layout.size, 32);
});

test("fields read equally often keep the order the source wrote them in", () => {
  // Stability is what keeps every other layout in the program byte for byte
  // what it was: the tree of `binarytrees` reads `left` and `right` once each,
  // and a program that writes a node and never reads it back counts nothing.
  const contracts = contractsOf({ "1.ts": TREE }, "1.ts");
  const layout = contracts.createTree?.definition?.objects?.Object1;
  assert.ok(layout !== undefined);
  assert.deepEqual(
    layout.fields.map((field) => [field.name, field.offset]),
    [["left", 0], ["right", 8]],
  );
  assert.equal(layout.size, 16);
});

test("a list built of a head of nulls and elements after it is one object", () => {
  // A list is written as two literals: the head, whose link is `null` because
  // there is nothing to point at yet, and every element after it, whose link is
  // the element before. They are one object, but the first writes the link as a
  // reference to nothing and the second writes it as a reference to the object
  // the first describes, so the two keys differ and the program lays out two node
  // types where the source wrote one. A traversal typed against the first then
  // reads whichever field sits at the offset it took from it.
  const source = [
    "function build(count: number): any {",
    "  let head = { next: null, item: 0 };",
    "  let i = count;",
    "  while (i > 0) {",
    "    head = { next: head, item: i };",
    "    i -= 1;",
    "  }",
    "  return head;",
    "}",
    "main();",
    "",
  ].join("\n");
  const contracts = contractsOf({ "1.ts": source }, "1.ts");
  const build = contracts.build;
  assert.ok(build !== undefined);
  const objects = Object.keys(build.definition?.objects ?? {});
  assert.deepEqual(objects, ["Object1"], "the head and the elements are one node type");
  const layout = build.definition?.objects?.Object1;
  assert.ok(layout !== undefined);
  // The link is a reference to the object it is in, which is what a list is.
  assert.deepEqual(
    layout.fields.map((field) => [field.name, field.type, field.offset]),
    [["next", "ref<Object1>", 0], ["item", "f64", 8]],
  );
});

/**
 * The width a loop's counter is held at, as the compiler resolved a function
 * body — which is the one place the two resolvers once answered differently.
 */
function counterOf(source: string, name = "main"): string {
  const contracts = contractsOf({ "1.ts": source }, "1.ts");
  const contract = contracts[name];
  assert.ok(contract !== undefined, `the program declares ${name}`);
  // Every function the program declares is handed to the resolver, because a
  // call in the body is compiled against the contract of what it calls.
  const resolved = resolveFunction(contract, { objectNames: {}, functions: contracts });
  const loops: SemanticLoop[] = [];
  const walk = (block: SemanticBlock): void => {
    for (const statement of block.statements) {
      if (statement.k === "loop") {
        loops.push(statement.loop);
        walk(statement.loop.body);
      }
      for (const nested of statementBlocksOf(statement)) walk(nested);
    }
  };
  walk(resolved.entry);
  const counted = loops.filter((loop): loop is Extract<SemanticLoop, { kind: "counted" }> => loop.kind === "counted");
  assert.ok(counted.length > 0, "the body holds a counted loop to read the width of");
  const type = counted[0]?.type;
  return type?.kind === "primitive" ? type.name : "?";
}

test("a counter in a body written in whole numbers is a whole number", () => {
  assert.equal(
    counterOf(["export function main(): number {", "  let total = 0;", "  for (let i = 0; i < 10; i += 1) { total += i; }", "  return total;", "}", "console.log(main());", ""].join("\n")),
    "i64",
  );
});

test("a counter that moves by a whole number other than one is a whole number", () => {
  assert.equal(
    counterOf(["export function main(): number {", "  let total = 0;", "  for (let i = 0; i < 10; i += 2) { total += i; }", "  return total;", "}", "console.log(main());", ""].join("\n")),
    "i64",
  );
});

test("a counter in a body that divides is left a double, because a division is one", () => {
  // `100 / i` is a double whatever both of its sides are, so a body that
  // divides is not a body written entirely in whole numbers and widening the
  // counter would state an integer division the source never wrote.
  assert.equal(
    counterOf(["export function main(): number {", "  let total = 0;", "  for (let i = 1; i < 10; i += 1) { total += 100 / i; }", "  return total;", "}", "console.log(main());", ""].join("\n")),
    "f64",
  );
});

test("a counter that starts in halves is left a double", () => {
  assert.equal(
    counterOf(["export function main(): number {", "  let total = 0;", "  for (let i = 0.5; i < 4; i += 1) { total += i; }", "  return total;", "}", "console.log(main());", ""].join("\n")),
    "f64",
  );
});

test("a counter in a body holding a fraction is left a double", () => {
  assert.equal(
    counterOf(["export function main(): number {", "  let total = 0;", "  for (let i = 0; i < 10; i += 1) { total += i * 0.5; }", "  return total;", "}", "console.log(main());", ""].join("\n")),
    "f64",
  );
});

test("a counter in a body that calls is left a double, because a call answers whatever it answers", () => {
  assert.equal(
    counterOf(
      [
        "export function scaled(x: number): number {",
        "  let acc = x;",
        "  acc = acc * 1.25 + x;",
        "  return acc;",
        "}",
        "export function main(): number {",
        "  let total = 0;",
        "  for (let i = 0; i < 10; i += 1) { total += scaled(i); }",
        "  return total;",
        "}",
        "console.log(main());",
        "",
      ].join("\n"),
    ),
    "f64",
  );
});

test("a loop in a body and the same loop in a module count in the same width", () => {
  // The two resolvers are one compiler answering one question, so the same line
  // of source is one width whichever side of a function boundary it is written
  // on. They once answered differently: an `i64` counter at the top of a module
  // and an `f64` one inside a body.
  const inBody = counterOf(["export function main(): number {", "  let total = 0;", "  for (let i = 0; i < 10; i += 1) { total += i; }", "  return total;", "}", "console.log(main());", ""].join("\n"));
  // The module-level program is the statements of its entry, so the loop is
  // read from the program rather than from a function of it.
  const phase = phaseOf("typescript", { "1.ts": ["let total = 0;", "for (let i = 0; i < 10; i += 1) {", "  total += i;", "}", "console.log(total);", ""].join("\n") }, "1.ts");
  assert.ok(phase.body !== undefined, "the entry module has statements to resolve");
  const program = resolveProgram(phase.body, phase.program, phase.objectNames, phase.objectLayouts, phase.objectKeys);
  const first = program.entry.statements[1];
  assert.ok(first !== undefined && first.k === "loop" && first.loop.kind === "counted");
  assert.equal(first.loop.type.kind === "primitive" ? first.loop.type.name : "?", inBody);
});

test("a counter a body never reads is a whole number, whatever the body computes", () => {
  // The turn builds a tree and adds up what a call returns, which is a body of
  // no whole numbers by any reading — and a counter neither of those reads. A
  // counter nothing reads has a width that reaches no arithmetic at all, so it
  // is a whole number on the simpler of the two grounds the rule allows.
  assert.equal(
    counterOf(
      [
        "function build(x: number): number {",
        "  let acc = x;",
        "  acc = acc * 1.25 + x;",
        "  return acc;",
        "}",
        "export function main(n: number): number {",
        "  let total = 0;",
        "  for (let i = 0; i < n; i += 1) {",
                "    total += build(n);",
        "  }",
        "  return total;",
        "}",
        "console.log(main(4));",
        "",
      ].join("\n"),
    ),
    "i64",
  );
});

test("a counter a body reads is left a double when the body is not wholly whole", () => {
  // The same loop, but the turn reads its counter as well as calling. Now the
  // counter's width is the width the arithmetic runs at, so only a body written
  // entirely in whole numbers may hold it at one.
  assert.equal(
    counterOf(
      [
        "function build(x: number): number {",
        "  let acc = x;",
        "  acc = acc * 1.25 + x;",
        "  return acc;",
        "}",
        "export function main(n: number): number {",
        "  let total = 0;",
        "  for (let i = 0; i < n; i += 1) {",
                "    total += build(i) + i * 0.5;",
        "  }",
        "  return total;",
        "}",
        "console.log(main(4));",
        "",
      ].join("\n"),
    ),
    "f64",
  );
});

test("an object a program body writes is laid out beside the objects the functions write", () => {
  // A literal in a program body is an object the body allocates, and the
  // layouts are one record for the whole program: the body writes a node of
  // its own beside the tree the functions build, and the two are two objects
  // because their fields are not the same ones.
  const phase = phaseOf(
    "typescript",
    {
      "1.ts": [
        "function createTree(depth: number): any {",
        "  return depth-- > 0",
        "    ? { left: createTree(depth), right: createTree(depth) }",
        "    : { left: null, right: null };",
        "}",
        "const point = { x: 1, y: 2 };",
        "const tree = createTree(3);",
        "console.log(tree.left === null, point.x);",
        "",
      ].join("\n"),
    },
    "1.ts",
  );
  assert.ok(phase.body !== undefined, "the entry module has statements to resolve");
  const program = resolveProgram(phase.body, phase.program, phase.objectNames, phase.objectLayouts, phase.objectKeys);
  // The node the functions lay out first, and the point the body writes after
  // it: the counter moves on from where the contract pass left it rather than
  // handing the body an `Object1` that is already the node.
  assert.deepEqual(Object.keys(program.objects), ["Object1", "Object2"]);
  assert.deepEqual(
    program.objects.Object2?.fields.map((field) => [field.name, field.type, field.offset]),
    [["x", "f64", 0], ["y", "f64", 8]],
  );
  assert.deepEqual(program.entry.releases, ["point"], "the object the body built is released when the block ends");
});

test("a literal a program body and a function both write is one object, not two", () => {
  // The shapes are keyed by their fields, so the same fields spelled on both
  // sides of a function boundary are one object with one layout and one name.
  // Two layouts for it would declare two structs of the same bytes and hand
  // the function one of them and the body the other.
  const phase = phaseOf(
    "typescript",
    {
      "1.ts": [
        "function make(a: number, b: number): any {",
        "  return { a: a, b: b };",
        "}",
        "const pair = { a: 1, b: 2 };",
        "const made = make(3, 4);",
        "console.log(made.a, pair.b);",
        "",
      ].join("\n"),
    },
    "1.ts",
  );
  assert.ok(phase.body !== undefined, "the entry module has statements to resolve");
  const program = resolveProgram(phase.body, phase.program, phase.objectNames, phase.objectLayouts, phase.objectKeys);
  assert.deepEqual(Object.keys(program.objects), ["Object1"], "the pair is the object the function writes");
  const written = generateProgramDriver(program);
  assert.match(written, /struct Object1 \{\n\s*double a;/, "one struct, declared once");
  assert.doesNotMatch(written, /struct Object2/, "and not a second one beside it");
});

test("a field read of an `any` is the field the layouts give it, not the reference", () => {
  // The use says nothing — `p` is a reference the source left unshaped — so
  // every field of every layout the program lays out is a field of it. Reading
  // `p.x` used to keep the reference itself, because a number is not a field of
  // a reference and no layout matched: `p.x + p.y` was a sum of two `ref<any>`
  // and the validator refused it, though both layouts say the fields are
  // doubles at offsets 0 and 8.
  const phase = phaseOf(
    "typescript",
    {
      "1.ts": [
        "function make(a: number, b: number): any {",
        "  return { x: a, y: b };",
        "}",
        "function sum(p: any): number {",
        "  return p.x + p.y;",
        "}",
        "main();",
        "",
      ].join("\n"),
    },
    "1.ts",
  );
  const printed = printSemanticFunction(semanticsOf(phase)["sum"] as never);
  assert.match(printed, /add\[f64\] \[load_field\[f64\] local\[ref<any>\] p Object1 x\] \[load_field\[f64\] local\[ref<any>\] p Object1 y\]/);
});

test("two layouts that hold a field the same way are one read of it", () => {
  // `left` at the same offset and of the same type is the same eight bytes
  // whichever object the reference points at, so this is one read rather than
  // a choice between two layouts.
  const phase = phaseOf(
    "typescript",
    {
      "1.ts": [
        "function a(): any {",
        "  return { left: 1, right: 2 };",
        "}",
        "function b(): any {",
        "  return { left: 3, up: 4 };",
        "}",
        "function read(n: any): number {",
        "  return n.left;",
        "}",
        "main();",
        "",
      ].join("\n"),
    },
    "1.ts",
  );
  assert.deepEqual(Object.keys(phase.objectNames).length, 2, "two shapes are two layouts");
  const printed = printSemanticFunction(semanticsOf(phase)["read"] as never);
  assert.match(printed, /load_field\[f64\] local\[ref<any>\] n Object1 left/);
});

test("two layouts that hold a field differently are refused by name", () => {
  // `left` is the first field of one object and the second of the other, so
  // there are two numbers this could read and a backend cannot pick between
  // them. The refusal names both rather than answering the first.
  const message = diagnostic(() => {
    const phase = phaseOf(
      "typescript",
      {
        "1.ts": [
          "function a(): any {",
          "  return { left: 1, right: 2 };",
          "}",
          "function b(): any {",
          "  return { up: 0, left: 2 };",
          "}",
          "function read(n: any): number {",
          "  return n.left;",
          "}",
          "main();",
          "",
        ].join("\n"),
      },
      "1.ts",
    );
    resolveFunction(phase.program.files[0].functions["read"] as never, {
      objectNames: phase.objectNames,
      functions: {},
    });
  });
  assert.match(message, /reads or writes "ref<any>\.left", which Object1 and Object2 could each be a field of/);
});

test("a field no layout holds still answers the reference itself", () => {
  // Nothing the program lays out says what is behind the reference, so the
  // only value the IR can name is the reference — which is what a body that
  // asks whether it was handed an object at all is asking.
  const phase = phaseOf(
    "typescript",
    {
      "1.ts": ["function a(): any {", "  return { left: 1 };", "}", "function read(n: any): boolean {", "  return n.missing === null;", "}", "main();", ""].join("\n"),
    },
    "1.ts",
  );
  const printed = printSemanticFunction(semanticsOf(phase)["read"] as never);
  assert.match(printed, /return \[is_null\[bool\] local\[ref<any>\] n\]/, "the read is of the reference, not of a field");
});

test("a field read is refused where the name is not a reference to an object", () => {
  // The member read is deferred to where the name is resolved, which is the
  // only place a program's name is known to be a reference or not: a number
  // with a field is not a program this compiler can answer.
  const message = diagnostic(() => {
    const phase = phaseOf("typescript", { "1.ts": "let n = 7;\nconsole.log(n.left);\n" }, "1.ts");
    resolveProgram(phase.body!, phase.program, phase.objectNames, phase.objectLayouts, phase.objectKeys);
  });
  assert.match(message, /"n" is not an object/);
  const missing = diagnostic(() => {
    const phase = phaseOf("typescript", { "1.ts": "const p = { a: 1 };\nconsole.log(p.b);\n" }, "1.ts");
    resolveProgram(phase.body!, phase.program, phase.objectNames, phase.objectLayouts, phase.objectKeys);
  });
  assert.match(missing, /has no field "b"/);
});

test("a counter a nested loop of its own shadows is not a read of the outer one", () => {
  // The inner loop declares its own `i`, so the two reads inside it are of that
  // one and the outer counter is read by neither — which is the shadowing the
  // walk has to see through, or a counter would be read by every nested loop
  // that happened to reuse its name.
  assert.equal(
    counterOf(
      [
        "export function main(n: number): number {",
        "  let total = 0;",
        "  for (let i = 0; i < n; i += 1) {",
        "    for (let i = 0; i < 4; i += 1) {",
        "      total += i * 0.5;",
        "    }",
        "  }",
        "  return total;",
        "}",
        "console.log(main(4));",
        "",
      ].join("\n"),
    ),
    "i64",
  );
});

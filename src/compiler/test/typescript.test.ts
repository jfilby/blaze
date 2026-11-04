import assert from "node:assert/strict";
import { test } from "node:test";
import { frontendFor } from "../semantics/frontend.ts";
import { pythonFrontend } from "../semantics/python.ts";
import { readTypeScriptModule } from "../semantics/typescript.ts";
import { CompilerError } from "../core/errors.ts";
import { parseContract } from "../semantics/contract.ts";
import { contractOf, diagnostic, irOf, phaseOf, programOf, programWithSemantics, semanticsOf } from "./phase.ts";
import { parseSemanticFunction, printSemanticFunction } from "../semantics/ir-text.ts";
import type { FunctionContract, ProgramContract } from "../core/types.ts";

/**
 * The contract of one named export of a module that also runs. A function
 * whose contract states what it does cannot be a build's entry on its own:
 * nothing can check it until there is a program, so it is reached the way a
 * build reaches it, as an export of a module that runs.
 */
function contractOfExport(source: string, name: string): FunctionContract {
  const phase = phaseOf("typescript", { "main.ts": `${source}\nconsole.log("run");\n` }, "main.ts");
  const contract = phase.program.files.find((file) => file.path === "main.ts")?.functions[name];
  assert.ok(contract !== undefined, `${name} must be an export of the module`);
  return contract;
}

const typescript = frontendFor("typescript");

test("an arrow's concise body may be the assignment it writes", () => {
  // `() => (current ??= "none")` is the write and the value it wrote: the
  // parentheses are the writer's, the body is the assignment, and the value is
  // the name. The write is the `??` the operator names, so the value is only
  // computed where the name holds none. An assignment is a statement here, so
  // the body reader answers the statement and the name it wrote.
  const body = analyzedBody(
    [
      "export function f(name: string | undefined): string {",
      "  let current: string | undefined = name;",
      '  const get = (): string => (current ??= "none");',
      "  return get() + get() + current;",
      "}",
      "",
    ].join("\n"),
    "__closure_module_0",
  ) as { kind: string; value?: { k?: string; op?: string } }[];
  assert.equal(body.length, 2, "the write and the value it answers");
  const write = body[0] as { kind: string; value?: { k?: string; op?: string } };
  assert.ok(write !== undefined, "the body writes a name");
  assert.ok(write.kind === "assign" || write.kind === "indexAssign", `the body writes the name: ${write.kind}`);
  assert.equal(write.value?.k, "binary");
  assert.equal(write.value?.op, "??", "the value is computed only where the name holds none");
  assert.equal(body[1]?.kind, "result", "what the body answers is the name it wrote");
});

/** The statements one function of a module body was lowered to. */
function analyzedBody(source: string, name: string): unknown[] {
  const analysis = typescript.analyze(source, "module.ts");
  const handle = analysis.functions.find((entry) => entry.name === name)?.handle as { body: unknown[] } | undefined;
  assert.ok(handle !== undefined, `${name} must be a function of the module`);
  return handle.body;
}

/** The first arrow the frontend lifted, which is the callback a call walks with. */
function liftedArrow(source: string): { params: { name: string; type: unknown }[]; body: unknown[] } {
  const analysis = typescript.analyze(source, "module.ts");
  const closure = analysis.functions.find((entry) => entry.name.startsWith("__closure_"));
  assert.ok(closure !== undefined, "the callback is a function of the file");
  return closure.handle as { params: { name: string; type: unknown }[]; body: unknown[] };
}

test("a body that reads a buffer at a position the contract cannot name is refused", () => {
  // The same loop, once bounded by the parameter and once by a local holding
  // it. Naming the bound in a local used to drop the whole length requirement
  // and leave `a != null`, so a caller could hand the body a buffer shorter
  // than the body walks and the read went past the end of it. A contract that
  // cannot state the length a body reads is not a contract, and the difference
  // was an accident of how the bound was spelled.
  const loop = (bound: string, test: string): string =>
    [
      "export function total(a: Float64Array, n: number): number {",
      "  let total = 0;",
      `  ${bound}`,
      `  for (let i = 0; i < ${test}; i += 1) { total += a[i]; }`,
      "  return total;",
      "}",
      "",
    ].join("\n");
  // A bound the contract can name is stated as the length the caller owes,
  // whether it is the parameter itself or a computation of it.
  for (const [test, stated] of [
    ["n", "len(a) >= n"],
    ["n - 0", "len(a) >= (n - 0)"],
  ]) {
    assert.deepEqual(
      contractOf("typescript", loop("let m = 0;", test)).requires,
      ["a != null", stated],
      `a loop counted to \`${test}\` states the length it reads`,
    );
  }
  // A bound it cannot name is refused, however that bound is written.
  for (const [bound, test] of [
    ["let m = n;", "m"],
    ["let m = 0;", "m"],
    ["let m = 0;", "m + n"],
  ]) {
    assert.throws(
      () => contractOf("typescript", loop(bound, test)),
      /cannot be contracted: it reads a at a position the contract cannot name/,
      `a bound written as \`${bound}\` tested by \`${test}\` is not a length the caller is held to`,
    );
  }
});

/** A program that imports a function of its own, and the function it imports. */
const PROGRAM: Record<string, string> = {
  "module.ts": 'import { shifted } from "./lib.ts";\nconsole.log(shifted(5));\n',
  "lib.ts": 'export function shifted(x: u256): u256 {\n  x <<= 2;\n  return x;\n}\n',
};

/** Every function of every file of a program, by name. */
function functionsOf(program: ProgramContract): Record<string, FunctionContract> {
  return Object.fromEntries(program.files.flatMap((file) => Object.entries(file.functions)));
}

/** A library of one function whose body applies `written` to what it is handed. */
function library(written: string): string {
  return `export function shifted(x: u256): u256 {\n  ${written};\n  return x;\n}\n`;
}

test("a compound assignment states the operator the source wrote", async () => {
  // A compound assignment is the binary operator it names over the name and the
  // value, and the postcondition is that expression: the first character of the
  // operator spelled `<<=` as a comparison and `**=` as a product, which for a
  // wide number was a postcondition the contract could not even parse.
  const contract = contractOf("typescript", `export function scaled(x: number): number {\n  x += 2;\n  x *= 3;\n  x -= 1;\n  x /= 2;\n  return x;\n}\n`);
  assert.deepEqual(contract.ensures, ["result == ((((x + 2) * 3) - 1) / 2)"]);
  parseContract(contract);
});

test("a compound the contract language cannot state is contracted by what it does", async () => {
  // The contract language states `+ - * /` and the comparisons, so a result that
  // is a shift, a bitwise operation or a power is a body it cannot state: the
  // body goes to the definition rather than to a postcondition it cannot meet,
  // which is where a body that prints or branches already goes. Before, the
  // operator was spelled by its first character, so `<<=` was read as the
  // comparison `<` and a `u256` body was refused for `u256 == bool`.
  const program = programOf("typescript", PROGRAM, "module.ts");
  const contract = functionsOf(program).shifted;
  assert.deepEqual(contract.ensures, [], "the body states no postcondition");
  assert.ok(contract.definition.statements.length > 0, "the statements are what the body is contracted by");
  parseContract(contract);
  // Every one of the seven new operators is the same answer, and none of them is
  // the operation its first character names.
  for (const written of ["x >>= 1", "x >>>= 1", "x &= 0x0f", "x |= 0xf0", "x ^= 0x01", "x **= 2", "x <<= 2"]) {
    const refused = programOf(
      "typescript",
      { "module.ts": PROGRAM["module.ts"], "lib.ts": library(written) },
      "module.ts",
    );
    assert.deepEqual(
      functionsOf(refused).shifted.ensures,
      [],
      `\`${written}\` is a result the contract language cannot state`,
    );
    parseContract(functionsOf(refused).shifted);
  }
});

test("a block body and an expression body both work", async () => {
  const block = contractOf("typescript", `export function square(x: number): number {\n  return x * x;\n}\n`);
  const expression = contractOf("typescript", `export function square(x: number): number = x * x;\n`);
  assert.deepEqual(block.ensures, ["result == (x * x)"]);
  assert.deepEqual(expression.ensures, ["result == (x * x)"]);
});

test("the entry selects the function, as in the source language", async () => {
  const source = `export function first(x: number): number { return x + 1; }
export function second(x: number): number { return x * 2; }
`;
  assert.equal((contractOf("typescript", source, { entry: "second" })).function.name, "second");
  assert.equal((contractOf("typescript", source)).function.name, "first");
  assert.throws(() => contractOf("typescript", source, { entry: "missing" }), /is not an export of module.ts/);
});

test("an inclusive loop keeps both ends of the range", async () => {
  const contract = contractOf("typescript", `export function total(values: Float64Array, n: number): number {
  let sum = 0;
  for (let i = 0; i <= n; i++) {
    sum += values[i];
  }
  return sum;
}
`);
  assert.deepEqual(contract.ensures, ["result == sum(i = 0..n, values[i])"]);
  assert.deepEqual(contract.memory.reads, ["values[0:(n + 1)]"]);
  parseContract(contract);
});

test("both ways of advancing the index are accepted", async () => {
  const postfix = `export function a(values: Float32Array, n: number): number {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i];
  return sum;
}
`;
  const step = `export function a(values: Float32Array, n: number): number {
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += values[i];
  return sum;
}
`;
  const first = contractOf("typescript", postfix);
  const second = contractOf("typescript", step);
  assert.deepEqual(first.ensures, second.ensures);
  assert.equal(first.function.params[0].type, "slice<f32>");
});

test("a product loop and a non neutral initialiser are kept faithful", async () => {
  const contract = contractOf("typescript", `export function scaled(values: Float64Array, n: number): number {
  let factor = 1;
  for (let i = 0; i < n; i++) factor *= values[i];
  return factor;
}
`);
  assert.deepEqual(contract.ensures, ["result == product(i = 0..<n, values[i])"]);

  const offset = contractOf("typescript", `export function offset(x: number, y: number): number {
  let result = 2.5;
  result += x * y;
  return result;
}
`);
  assert.deepEqual(offset.ensures, ["result == (2.5 + (x * y))"]);
});

test("comments and formatting do not change the contract", async () => {
  const documented = contractOf("typescript", `/**
 * A dot product.
 */
export function dot(a: Float64Array, b: Float64Array, n: number): number {
  // the accumulator
  let total = 0; /* zero */
  for (let i = 0; i < n; i++) {
    total += a[i] * b[i];
  }
  return total;
}
`);
  const plain = contractOf("typescript", `export function dot(a: Float64Array, b: Float64Array, n: number): number {
  let total = 0;
  for (let i = 0; i < n; i++) { total += a[i] * b[i]; }
  return total;
}
`);
  assert.deepEqual(documented.ensures, plain.ensures);
  assert.deepEqual(documented.memory.reads, ["a[0:n]", "b[0:n]"]);
});

test("a result that depends on a buffer length is rejected", async () => {
  // The callee receives a pointer, not a length: no implementation can observe
  // len(a), so a contract whose result depends on it is unimplementable.
  assert.throws(() => contractOf("typescript", `export function bad(a: Float64Array, b: Float64Array): number {
  let total = 0;
  for (let i = 0; i < a.length; i++) total += a[i] * b[i];
  return total;
}
`),
    /depends on a buffer length/,
  );
});

test("a derived bound becomes a precondition the caller checks", async () => {
  const contract = contractOf("typescript", `export function first(values: Float64Array): number {
  let total = 0;
  for (let i = 0; i < 1; i++) total += values[i];
  return total;
}
`);
  assert.deepEqual(contract.requires, ["values != null", "len(values) >= 1"]);
  assert.deepEqual(contract.memory.reads, ["values[0:1]"]);
});

test("a body no one expression states still states what the function does", async () => {
  // Nothing here can be written as `result == ...`, so the contract states the
  // signature, the effects and the body instead of refusing the function. What
  // it does not do is drop the body: every function carries one, and a
  // postcondition is what a body like this has nothing to say.
  const branch = contractOfExport(`export function pick(x: number): number {
  if (x > 0) return x;
  return 0;
}
`, "pick");
  assert.deepEqual(branch.ensures, []);
  assert.deepEqual(branch.effects, []);
  assert.deepEqual(branch.definition.statements.map((statement) => statement.kind), ["if", "result"]);

  const program = contractOfExport(`export function report(depth: number): void {
  let nodes = 0;
  for (let i = 0; i <= depth; i++) {
    console.log(\`depth \${i}\`);
    nodes += 1;
  }
  if (nodes > 0) console.log(\`\${nodes}\`);
}
`, "report");
  assert.deepEqual(program.effects, ["io"]);
  assert.equal(program.definition.prints, true);
  assert.equal(program.definition.allocates, false);
  assert.equal(program.definition.readsArgv, false);

  const allocating = contractOfExport(`export function make(): any {
  return { left: null, right: null };
}
`, "make");
  assert.deepEqual(allocating.effects, ["memory"]);
  assert.equal(allocating.definition.allocates, true);

  const counting = contractOfExport(`export function everyOther(n: number): number {
  let total = 0;
  for (let d = 4; d <= n; d += 2) total += d;
  return total;
}
`, "everyOther");
  assert.deepEqual(counting.ensures, []);
  assert.deepEqual(
    counting.definition.statements.map((statement) => statement.kind),
    ["declare", "loop", "result"],
  );
});

test("a type the compiler does not know is an opaque reference, and an unknown name is still refused", async () => {
  // `string` is the text the contract states, so a function that takes one
  // and hands one back is read: its parameter is the text it is written at.
  const textual = contractOf("typescript", `export function echo(raw: string): string { return raw; }\n`);
  assert.deepEqual(textual.function.params.map((param) => param.type), ["text"]);
  assert.equal(textual.function.returns, "text");

  // A type the compiler has no shape for is the reference the layout pass
  // leaves opaque. It is not a refusal: a module names its own interfaces and
  // imports types from another module, and every one of those is a value the
  // program already knows how to hold.
  const opaque = contractOf("typescript", `export function odd(x: Date): number { return 0; }\n`);
  assert.equal(opaque.function.params[0]?.type, "ref<any>");

  assert.match(
    diagnostic(() => contractOf("typescript", `export function unknown(x: number): number { return y + x; }\n`)),
    /unknown identifier "y"/,
  );
});

test("every construct outside the subset is reported at once", () => {
  // A file is fixed in one pass: the build says everything wrong with it, with
  // the line each construct was written on, rather than one construct per run.
  const message = diagnostic(() =>
    contractOf(
      "typescript",
      [
        "export function spin(x: number): number {",
        "  yield x;",
        "  return 0;",
        "}",
        "export function odd(x: Date): number {",
        "  return 0;",
        "}",
        "export function pick(x: number): number {",
        "  class Hidden {}",
        "  return 0;",
        "}",
        "",
      ].join("\n"),
    ),
  );

  assert.match(message, /2 constructs of module\.ts are outside the subset the compiler reads/);
  assert.match(message, /line 2: "yield" is not supported/);
  assert.match(message, /line 9: "class" is not supported/);
});

test("a regular expression inside an interpolation does not end the text it is written in", () => {
  // The brace that closes an interpolation is found by reading the expression
  // between `${` and `}`. A regular expression may hold a quote of either kind
  // — `x.replace(/"/g, "a")` does — and reading that quote as the start of a
  // text desynchronised every quote after it, so the `}` was never found and
  // the whole file failed with "unterminated string".
  const analysis = typescript.analyze(
    'export function f(x: string): string { return `a ${x.replace(/"/g, "b")} c`; }',
    "module.ts",
    false,
  );

  assert.deepEqual(analysis.functions.map((entry) => entry.name), ["f"]);
});

test("a statement outside the subset is reported once, whatever the rest of it reads", () => {
  // The parser reads on after a construct it cannot read, and what it reads is
  // the construct's own statement read as the junk around it. One statement is
  // one refusal: three methods of a value the module does not declare are three
  // readings of one gap, and the build names the first of them.
  const message = diagnostic(() =>
    contractOf(
      "typescript",
      [
        "export function f(x: number): number {",
        "  const a = x.foo(1).bar(2).baz(3);",
        "  return 0;",
        "}",
      ].join("\n"),
    ),
  );

  assert.match(message, /1 construct of module\.ts is outside the subset the compiler reads/);
  assert.match(message, /"foo" is not a method this program compiles/);
});

test("a refused function's return type is not read as its body", () => {
  // The body of a declaration the module cannot hold is skipped by its braces,
  // and the return type is written before them. A return type with an object in
  // it — `(): { a: string } | null {` — put the type's brace where the body's
  // was looked for, so the declaration ended at its type and the rest of the
  // signature was read as a statement of the file: `"a" is not a statement of a
  // program`, and then the `export` after it.
  const message = diagnostic(() =>
    typescript.analyze(
      [
        "function broken(x: number): { a: string } | null {",
        "  return x.mystery(1);",
        "}",
        "export function g(): number { return 1; }",
      ].join("\n"),
      "module.ts",
    ),
  );

  assert.match(message, /1 construct of module\.ts is outside the subset the compiler reads/);
  assert.match(message, /line 2: "mystery" is not a method this program compiles/);
  assert.doesNotMatch(message, /is not a statement of a program/);
});

test("a statement of a program outside the subset is reported once", () => {
  // The program body recovers at the statement it was reading, so the rest of
  // the pattern is not read as the statements that follow it.
  const message = diagnostic(() =>
    programOf(
      "typescript",
      {
        "main.ts": [
          "const pair = [1, 2];",
          "const [head, ...rest] = pair;",
          'console.log(head);',
        ].join("\n"),
      },
      "main.ts",
    ),
  );

  assert.match(message, /1 construct of main\.ts is outside the subset the compiler reads/);
  assert.match(message, /line 2: expected the name of a declared value/);
});

test("a missing closing bracket ends its own construct, not the rest of the line", () => {
  // `if ("a" in x)` writes a condition the expression grammar does not carry.
  // The `)` is missing where the header expected it, and reading on to the one
  // the source wrote ends the header there: without it the body and the `in`
  // were read as statements of their own.
  const message = diagnostic(() =>
    programOf(
      "typescript",
      { "main.ts": ['const x = 1;', 'if ("a" in x) console.log(1);', 'console.log(2);'].join("\n") },
      "main.ts",
    ),
  );

  assert.match(message, /1 construct of main\.ts is outside the subset the compiler reads/);
  assert.match(message, /line 2: expected "\)"/);
});

test("type-only syntax is erased, and a generic annotation is read to its end", () => {
  // A module is written in TypeScript, and the types it declares are not
  // values: an interface, a type alias, an ambient declaration, an `import
  // type` and an `export type` are all skipped. The annotations that remain are
  // read to their closing bracket, so `Map<string, Array<number>>` is one type
  // and not a comparison against a name.
  const source = [
    'import type { Missing } from "./nowhere.ts";',
    "export interface Shape { readonly width: number; height?: number }",
    "type Pair<T> = { left: T; right: T };",
    "declare const ambient: number;",
    "export type { Shape };",
    "export function area<T extends object>(shape: Shape, values: Map<string, Array<number>>): number {",
    "  const pair = { left: shape.width, right: 1 } as Pair<number>;",
    "  const none = null as Shape | null;",
    "  return pair.left! + pair.right + none!.width;",
    "}",
    "",
  ].join("\n");
  const analysis = typescript.analyze(source, "main.ts");
  assert.deepEqual(analysis.imports, [], "a type-only import names no module to resolve");
  assert.deepEqual(
    analysis.functions.map((declared) => declared.name),
    ["area"],
  );
  assert.equal(analysis.functions[0]?.params[0]?.type.kind, "ref", "an interface is an opaque reference");
  assert.deepEqual(
    analysis.functions[0]?.params[1]?.type,
    { kind: "primitive", name: "f64" },
    "a map is the handle the runtime's dictionary is",
  );
});

test("a type-only import may rename the types it names", () => {
  // The alias of a type-only import names a type and no value, so the module's
  // functions do not import it and the rename is not a rename of a function.
  const source = [
    'import type { Shape as Outline, Width } from "./nowhere.ts";',
    "export function area(shape: Outline): number {",
    "  return shape.width as Width;",
    "}",
    "",
  ].join("\n");
  const analysis = typescript.analyze(source, "main.ts");
  assert.deepEqual(analysis.imports, [], "a type-only import names no module to resolve");
  assert.deepEqual(
    analysis.functions.map((declared) => declared.name),
    ["area"],
  );
});

test("an interface's fields type the member chain the source writes through it", () => {
  // An interface is erased, but the fields it names are not: the next member of
  // a chain is read through the field the interface declares, so a list field
  // is an array and a text field is a text method's receiver.
  const source = [
    "interface Call { callee: string; }",
    "interface Definition { calls: Call[]; }",
    "interface Contract { definition: Definition; name: string; }",
    "type Names = string[];",
    "export function first(contract: Contract, names: Names): string {",
    "  return contract.definition.calls[0].callee + names.join(\",\");",
    "}",
    "",
  ].join("\n");
  const analysis = typescript.analyze(source, "main.ts");
  assert.equal(analysis.functions[0]?.params[0]?.type.kind, "ref", "an interface is still the reference a contract holds");
  assert.equal(analysis.functions[0]?.params[1]?.type.kind, "slice", "an alias is the list it names");
});

test("a type alias names the primitive a contract holds it at", () => {
  const source = [
    "type Count = number;",
    "type Label = string;",
    "export function scaled(count: Count, label: Label): Count {",
    "  return count;",
    "}",
    "",
  ].join("\n");
  const analysis = typescript.analyze(source, "main.ts");
  assert.deepEqual(analysis.functions[0]?.params[0]?.type, { kind: "primitive", name: "f64" });
  assert.deepEqual(analysis.functions[0]?.params[1]?.type, { kind: "text" });
  assert.deepEqual(analysis.functions[0]?.returns, { kind: "primitive", name: "f64" });
});

test("an object spread copies the fields of a typed object", () => {
  // `{ ...base }` is the record's fields read out of the value it names, and a
  // field written after the spread replaces the one copied. The value is read
  // once, so the fields are loads from the same name rather than a second
  // evaluation of it.
  const analysis = typescript.analyze(
    [
      "interface Base { a: string; b: number }",
      "export function f(base: Base): Base {",
      "  return { ...base, b: 2 };",
      "}",
      "",
    ].join("\n"),
    "main.ts",
  );
  const body = ((analysis.functions[0]?.handle ?? { body: [] }) as {
    body: { kind: string; value?: { k: string; fields?: { name: string; value: { k: string; field?: string } }[] } }[];
  }).body;
  const returned = body.find((statement) => statement.kind === "result")?.value;
  assert.equal(returned?.k, "object");
  assert.deepEqual(
    returned?.fields?.map((field) => field.name),
    ["a", "b"],
    "the copied field is replaced, not written twice",
  );
  assert.equal(returned?.fields?.[0]?.value.k, "member");
  assert.equal(returned?.fields?.[0]?.value.field, "a", "the field is read out of the value spread");
  assert.equal(returned?.fields?.[1]?.value.k, "literal", "the field after the spread is the one held");
});

test("an object spread of a value whose reads would repeat is refused", () => {
  // A call written under a spread would run once per field, which is not the
  // value the source wrote. A name or a field of one is the value the spread
  // needs, and anything else is refused where it is written.
  assert.match(
    diagnostic(() =>
      typescript.analyze(
        [
          "interface Base { a: string; b: number }",
          "function make(): Base { return { a: `x`, b: 1 }; }",
          "export function f(): Base {",
          "  return { ...make() };",
          "}",
          "",
        ].join("\n"),
        "main.ts",
      ),
    ),
    /an object spread reads a constant object/,
  );
});

test("`Omit` and `Pick` are the fields they keep", () => {
  // The keys are string literals, so a record's fields are selected by name:
  // `Omit` removes them and `Pick` keeps them. What is left is a record the
  // member chain after it reads field by field.
  const source = [
    "interface Full { a: string; b: number; c: boolean }",
    "export function kept(value: Pick<Full, `b`>): number {",
    "  return value.b + 1;",
    "}",
    "export function left(value: Omit<Full, `b` | `c`>): string {",
    "  return value.a.trim();",
    "}",
    "",
  ].join("\n");
  const analysis = typescript.analyze(source, "main.ts");
  assert.deepEqual(
    analysis.functions.map((declared) => declared.name),
    ["kept", "left"],
  );
});

test("an empty list written into a field is built at the field's elements", () => {
  // The field says what the value written into it holds, so `shelf.names = []`
  // is a list of the field's element type and not a list with no type at all.
  const analysis = typescript.analyze(
    [
      "interface Shelf { names: string[]; }",
      "export function clear(shelf: Shelf): number {",
      "  shelf.names = [];",
      "  return shelf.names.length;",
      "}",
      "",
    ].join("\n"),
    "main.ts",
  );
  const body = ((analysis.functions[0]?.handle ?? { body: [] }) as {
    body: { kind: string; value?: Lowered }[];
  }).body;
  type Lowered = { k: string; element?: string; left?: Lowered; right?: Lowered };
  // A list is its own block, so the empty list is a buffer of no values; the
  // frontend writes two of them so the one a caller keeps is not the one the
  // frame wrote, and the element type is on each.
  const firstBuffer = (value: Lowered | undefined): Lowered | undefined => {
    if (value === undefined) return undefined;
    if (value.k === "buffer") return value;
    return firstBuffer(value.left) ?? firstBuffer(value.right);
  };
  const written = body.find((statement) => statement.kind === "memberAssign")?.value;
  assert.equal(firstBuffer(written)?.element, "text", "the field's element type is the list's");
});

test("an empty list in an object written into a list is built at the record's elements", () => {
  // `statements.push({ ..., then: { releases: [] } })` writes an object into a
  // list of records. The element's *shape* is the record the list was declared
  // with — the contract type erases it to the opaque reference — so the empty
  // list inside is built at the element type the record's field states.
  const source = [
    "interface Block { id: string; releases: string[] }",
    "interface If { k: string; then: Block }",
    "export function add(statements: If[]): number {",
    "  statements.push({ k: `if`, then: { id: `x`, releases: [] } });",
    "  return statements.length;",
    "}",
    "",
  ].join("\n");
  assert.deepEqual(readTypeScriptModule(source, "main.ts", false).refused, []);
});

test("an empty list in a field of an imported type is built at the type's elements", () => {
  // The field is declared in another module, so the read that first parses this
  // file has not linked the declaration the field belongs to. The module graph
  // reads the file again once the imports are bound, and that read settles the
  // empty list at the field's element type.
  const phase = phaseOf(
    "typescript",
    {
      "main.ts": [
        'import type { Box } from "./types.ts";',
        "function width(box: Box): number { return box.values.length; }",
        "const empty: Box = { values: [] };",
        "",
      ].join("\n"),
      "types.ts": "export interface Box { values: number[] }\n",
    },
    "main.ts",
  );
  const declared = (
    (phase.body?.statements ?? []) as {
      kind: string;
      name?: string;
      value?: { k: string; fields?: { name: string; value: { k: string; element?: string } }[] };
    }[]
  ).find((statement) => statement.kind === "declare" && statement.name === "empty");
  const field = declared?.value?.fields?.find((one) => one.name === "values");
  assert.equal(field?.value.k, "buffer");
  assert.equal(field?.value.element, "f64", "the imported field's element type is the list's");
});

test("an object spread of an imported type reads the fields its declaration names", () => {
  // The type and the fields are in another module, and the function takes a
  // subset of them: the spread copies what `Omit` kept and the field after it
  // writes over the one it copied.
  const phase = phaseOf(
    "typescript",
    {
      "main.ts": [
        'import type { Full } from "./types.ts";',
        "export function copy(value: Omit<Full, `c`>): Omit<Full, `c`> {",
        "  return { ...value, b: 2 };",
        "}",
        "console.log(1);",
        "",
      ].join("\n"),
      "types.ts": "export interface Full { a: number; b: number; c: string }\n",
    },
    "main.ts",
  );
  const ir = printSemanticFunction(semanticsOf(phase)["copy"]);
  assert.match(ir, /a \[load_field\[[^\]]+\] local\[[^\]]+\] value [^\]]+ a\]/);
  assert.match(ir, /b const\[f64\] 2/);
});

test("a union laid out with a leading bar is the records it names", () => {
  // The bar the first member is written after states nothing the type is not.
  // Reading it as a member made that member `any`, and a union of anything but
  // records is the one member this compiler's values can hold — so a type laid
  // out one member per line, which is how the sources write a union of shapes,
  // erased to `any` and every member read through it was a method of nothing.
  const analysis = typescript.analyze(
    [
      "type Value =",
      '  | { k: "a"; left: number; right: number }',
      '  | { k: "b"; operand: number };',
      "export function bump(value: Value): Value {",
      "  return { ...value, left: 1 };",
      "}",
      "",
    ].join("\n"),
    "main.ts",
  );
  const body = ((analysis.functions[0]?.handle ?? { body: [] }) as {
    body: { kind: string; value?: { k: string; fields?: { name: string }[] } }[];
  }).body;
  const returned = body.find((statement) => statement.kind === "result")?.value;
  assert.equal(returned?.k, "object", "the union is a record the spread reads");
  const names = returned?.fields?.map((field) => field.name) ?? [];
  for (const field of ["k", "left", "right", "operand"]) {
    assert.ok(names.includes(field), `the spread copies ${field}, which an arm of the union writes`);
  }
  assert.equal(names.filter((name) => name === "left").length, 1, "the field both arms share is copied once");
});

test("a local interface that names an imported type is read after the link", () => {
  // The first read of the file cannot resolve `Holder`, so the field written at
  // it is `any` and `names.join` would be a method of nothing. The read that
  // follows the link binds the declaration, and the field's type is the one the
  // other module wrote: a type expansion made before the link is not the answer
  // the linked read asks for.
  const phase = phaseOf(
    "typescript",
    {
      "main.ts": [
        'import type { Holder } from "./types.ts";',
        "interface Wrapper { holder: Holder }",
        "export function joined(wrapper: Wrapper): string {",
        '  return wrapper.holder.names.join(",");',
        "}",
        'console.log("run");',
        "",
      ].join("\n"),
      "types.ts": "export interface Holder { names: string[] }\n",
    },
    "main.ts",
  );
  const ir = printSemanticFunction(semanticsOf(phase)["joined"]);
  assert.match(ir, /join/, "the field the import types is the list its declaration names");
});

test("a class another module declares is read through its instances", () => {
  // The class is a value of the module that wrote it: its constructor and its
  // methods are functions of that module, and what crosses the link is the
  // description of the class. Without it `counter.add` is a method of nothing,
  // because the field the instance is held in is a name no table of this file
  // declares.
  const phase = phaseOf(
    "typescript",
    {
      "main.ts": [
        'import { Counter } from "./types.ts";',
        "export function twice(): number {",
        "  const counter = new Counter();",
        "  counter.add(1);",
        "  return counter.add(2);",
        "}",
        'console.log("run");',
        "",
      ].join("\n"),
      "types.ts": [
        "export class Counter {",
        "  total = 0;",
        "  add(by: number): number {",
        "    this.total += by;",
        "    return this.total;",
        "  }",
        "}",
        "",
      ].join("\n"),
    },
    "main.ts",
  );
  const ir = printSemanticFunction(semanticsOf(phase)["twice"]);
  assert.match(ir, /Counter_add/, "the method is the function the other module compiled");
  assert.match(ir, /Counter\b/, "the constructor is the one the other module lowered");
});

test("an angle-bracket type assertion is erased", () => {
  // `<T>value` is the other spelling of `value as T`, and it names no runtime
  // work: the value after the closing bracket is the value the source wrote.
  const source = [
    "export function first(a: Array<number>): number {",
    "  const b = <Array<number>>a;",
    "  return <number>b[0];",
    "}",
    "",
  ].join("\n");
  const analysis = typescript.analyze(source, "main.ts");
  assert.deepEqual(
    analysis.functions.map((declared) => declared.name),
    ["first"],
  );
  // The IR of the same body is the element it reads, with no value standing for
  // the assertion: `a[0]` is the expression the source wrote under the type.
  const ir = irOf(
    "typescript",
    {
      "module.ts": [
        "export function first(a: Float64Array): number {",
        "  return <number>a[0];",
        "}",
      ].join("\n"),
    },
    "module.ts",
    "first",
  );
  assert.match(ir, /return \[element\[f64\]/);
});

test("a text method lowers to the runtime call that answers it", () => {
  const source = [
    "export function score(s: string, n: string): number {",
    "  let total = 0;",
    "  if (s.includes(n)) total += 1;",
    "  if (s.startsWith(n)) total += 2;",
    "  if (s.endsWith(n)) total += 4;",
    "  const head = s.trim();",
    "  return total + head.length + s.indexOf(n) + s.slice(0, 1).length;",
    "}",
    "",
  ].join("\n");
  const phase = phaseOf("typescript", { "module.ts": `${source}\nconsole.log(score("a", "a"));\n` }, "module.ts");
  const ir = printSemanticFunction(semanticsOf(phase)["score"]);
  assert.match(ir, /text\.indexOf/);
  assert.match(ir, /text\.slice/);
  assert.match(ir, /text\.trim/);
});

test("a text folds with the case helpers the runtime carries", () => {
  // `toLowerCase` and `toUpperCase` are calls of the runtime over the text,
  // like `trim`, so the value after one is still a text.
  const phase = phaseOf(
    "typescript",
    {
      "module.ts": [
        "export function fold(s: string): number {",
        "  if (s.toLowerCase() === `yes`) return s.toUpperCase().length;",
        "  return 0;",
        "}",
        "console.log(fold(`YES`));",
        "",
      ].join("\n"),
    },
    "module.ts",
  );
  const ir = printSemanticFunction(semanticsOf(phase)["fold"]);
  assert.match(ir, /text\.toLowerCase/);
  assert.match(ir, /text\.toUpperCase/);
});

test("a library with a top-level constant is a library, not a program", () => {
  // A top-level value is a declaration, not a statement that makes the file
  // run. A module the program imports may hold one, and its functions read it
  // where it was written.
  const phase = phaseOf(
    "typescript",
    {
      "main.ts": 'import { f } from "./lib.ts";\nconsole.log(f());\n',
      "lib.ts": "const BASE = 2;\nexport function f(): number { return BASE * 3; }\n",
    },
    "main.ts",
  );
  const library = phase.program.files.find((file) => file.path === "lib.ts");
  assert.ok(library?.functions["f"] !== undefined, "the library's function is a function of the module");
});

test("a switch is lowered to the comparisons and the fallthrough it writes", () => {
  // The discriminant is read once, each case is the comparison the source
  // wrote, a case with no break falls into the next, and the default is what
  // runs when none matches.
  const analysis = typescript.analyze(
    [
      "export function label(x: number): number {",
      "  let total = 0;",
      "  switch (x) {",
      "    case 1: total += 1; break;",
      "    case 2:",
      "    case 3: total += 2; break;",
      "    default: total = 9;",
      "  }",
      "  return total;",
      "}",
      "",
    ].join("\n"),
    "main.ts",
  );
  const body = ((analysis.functions[0]?.handle ?? { body: [] }) as {
    body: { kind: string; condition?: { k: string; op?: string }; then?: { kind: string }[] }[];
  }).body;
  assert.deepEqual(
    body.map((statement) => statement.kind),
    ["declare", "declare", "if", "result"],
  );
  assert.equal(body[2]?.condition?.k, "binary");
  assert.equal(body[2]?.condition?.op, "===");
  assert.deepEqual(
    body[2]?.then?.map((statement) => statement.kind),
    ["assign"],
    "a case that breaks runs only its own statements",
  );
});

test("`??=` writes only where the target is null", () => {
  // It is a conditional write, not a compound assignment: the value is not
  // evaluated where the target already holds one.
  const analysis = typescript.analyze(
    [
      "export function fill(x: number): number {",
      "  let value: number | null = null;",
      "  value ??= x;",
      "  return value;",
      "}",
      "",
    ].join("\n"),
    "main.ts",
  );
  const body = ((analysis.functions[0]?.handle ?? { body: [] }) as {
    body: { kind: string; op?: string; value?: { k: string; op?: string } }[];
  }).body;
  assert.deepEqual(
    body.map((statement) => statement.kind),
    ["declare", "assign", "result"],
  );
  assert.equal(body[1]?.op, "=");
  assert.equal(body[1]?.value?.k, "binary");
  assert.equal(body[1]?.value?.op, "??");
});

test("an optional access guards the accesses written after it", () => {
  // `a?.b.c` is `a != null ? a.b.c : null`: the `.c` is inside the branch, not
  // applied to the null the guard answers. A second `?.` nests another guard
  // inside the first, so each value is tested where it is read.
  //
  // The `??` that follows is the arm the chain takes when it finds nothing, so
  // the two are one choice: `(a != null ? a?.b : null) ?? 0` asks whether `a`
  // is there once and answers the fallback where it is not. A text's zero is
  // the empty text, and a `??` over the chain would take it for a value.
  const analysis = typescript.analyze(
    [
      "export function read(o: any): number {",
      "  return o?.a?.b ?? 0;",
      "}",
      "",
    ].join("\n"),
    "main.ts",
  );
  const body = ((analysis.functions[0]?.handle ?? { body: [] }) as {
    body: { kind: string; value?: { k: string; condition?: { op?: string }; then?: unknown; otherwise?: { k: string } } }[];
  }).body;
  const value = body[0]?.value;
  assert.equal(value?.k, "conditional", "the chain and the `??` are one choice");
  assert.equal(value?.condition?.op, "!=", "the guard is the chain's first link");
  assert.equal(value?.otherwise?.k, "literal", "the fallback is the arm taken when the chain finds nothing");
  const guard = value?.then as { k?: string; k2?: string; otherwise?: { k: string }; then?: { k?: string } };
  assert.equal(guard.k, "conditional", "the second ?. is a second guard");
  assert.equal((guard.then as { k?: string }).k, "member", "the field read is inside the branch");
  assert.equal(guard.otherwise?.k, "literal", "the inner guard answers the fallback too");
});

test("a `??` keeps the type of the arm that names one", () => {
  // `a ?? b` hands back `a` where it is there and `b` where it is not, so the
  // arm that names a type is the type of the whole. A member the interface
  // types is a text, and the method written after the fallback is a text
  // method.
  const analysis = typescript.analyze(
    [
      "interface Result { stderr: string }",
      "export function f(result: Result): boolean {",
      "  const s = result.stderr ?? ``;",
      "  return s.startsWith(`x`);",
      "}",
      "",
    ].join("\n"),
    "main.ts",
  );
  const body = ((analysis.functions[0]?.handle ?? { body: [] }) as {
    body: { kind: string; value?: { k: string; op?: string; left?: { k: string; name?: string } } }[];
  }).body;
  const value = body[body.length - 1]?.value;
  assert.equal(value?.k, "binary");
  assert.equal(value?.op, "===");
  assert.equal(value?.left?.k, "call");
  assert.equal(value?.left?.name, "text.slice", "the fallback is a text, so startsWith reads the field the text holds");
});

test("a method on a value the read cannot look inside waits for the link", () => {
  // The value is a field of a type another module declares, reached through a
  // call, so there is no name to check for a pending import. It is an opaque
  // reference, which is exactly the statement that what it holds is the link's
  // to say: the method waits rather than being refused as a method of nothing.
  const analysis = typescript.analyze(
    [
      'import { type Box } from "./box.ts";',
      "export class Builder {",
      "  private held: Box;",
      "  add(box: Box, value: number): void {",
      "    box.items.push(value);",
      "    this.held.items.push(value);",
      "    this.heavy().items.push(value);",
      "  }",
      "  heavy(): Box { return this.held; }",
      "}",
      "",
    ].join("\n"),
    "module.ts",
  );
  assert.equal(analysis.awaitingLink, true, "the read says it is waiting for the link");
});

test("an arrow that calls itself is a function of the file", () => {
  // An arrow is read before the declaration binds it, so a body that calls the
  // name it is about to be given reads a call of a name nothing bound yet. The
  // call is the lifted function's, so the arrow recurses instead of being
  // refused: a compiler whose parser walks a tree with arrows is the program
  // the self-build is.
  const analysis = typescript.analyze(
    [
      "interface Node { name: string; children: Node[] }",
      "export function depth(node: Node): number {",
      "  const count = (one: Node): number => {",
      "    let total = 1;",
      "    for (const child of one.children) total += count(child);",
      "    return total;",
      "  };",
      "  return count(node);",
      "}",
      "",
    ].join("\n"),
    "module.ts",
  );
  const closure = analysis.functions.find((entry) => entry.name.startsWith("__closure_"));
  assert.ok(closure !== undefined, "the recursive arrow is a function of the file");
  const lifted = closure.handle as { body: unknown[] };
  const printed = JSON.stringify(lifted.body);
  assert.match(printed, new RegExp(`"name":"${closure.name}"`), "the call is the lifted function's own");
  assert.doesNotMatch(printed, /"name":"count"/, "the source name is not called");
});

test("the fields of a recursive type settle the lists written in them", () => {
  // `children: Node[]` names the type of the record it is written on, so the
  // empty list a leaf writes is held at that element type. The field's type is
  // the name, and a name is not the record it stands for: it is resolved.
  const body = JSON.stringify(analyzedBody([
    "interface Node { name: string; children: Node[] }",
    "export function leaf(): Node {",
    "  const one: Node = { name: `b`, children: [] };",
    "  return one;",
    "}",
    "",
  ].join("\n"), "leaf"));
  assert.doesNotMatch(body, /"element":"any"/, "the empty list is held at the field's element type");
});

test("`Object.create(null)` is the empty record", () => {
  const body = JSON.stringify(analyzedBody([
    "export function f(): Record<string, number> {",
    "  const record: Record<string, number> = Object.create(null);",
    "  return record;",
    "}",
    "",
  ].join("\n"), "f"));
  assert.match(body, /blaze_rt_dict_new/, "the empty record is the runtime's dictionary");
});

test("a write through a cast or a chain is a statement of its own", () => {
  const body = JSON.stringify(analyzedBody([
    "interface Nested { at: number }",
    "interface Box { value: number; nested: Nested }",
    "interface Holder { items: number[] }",
    "export function f(box: Box, holder: Holder, at: number): number {",
    "  (box as Box).nested.at = at;",
    "  holder.items[0] = at;",
    "  return box.nested.at;",
    "}",
    "",
  ].join("\n"), "f"));
  assert.match(body, /"kind":"memberAssign"/, "the field of the cast is written");
  assert.match(body, /"kind":"indexAssign"/, "the element of the field is written");
});

test("a union of shapes is one layout with a tag", () => {
  // Every arm writes every field of the union and a tag saying which arm it is;
  // `in` over the union is the tag compared with the arms that have the field.
  const body = JSON.stringify(analyzedBody([
    "type Outcome = { refused: string } | { applied: number };",
    "export function f(flag: boolean): string {",
    "  const outcome: Outcome = flag ? { refused: `no` } : { applied: 1 };",
    "  return (\"refused\" in outcome) ? outcome.refused : `applied`;",
    "}",
    "",
  ].join("\n"), "f"));
  assert.match(body, /"name":"__arm"/, "the literal carries the arm it is");
  assert.match(body, /"name":"applied"/, "a field the arm did not write is still laid out");
  assert.match(body, /"field":"__arm"/, "`in` reads the tag");
});

test("an overload is a signature, and a rest parameter is the list it names", () => {
  // A signature with no body names how the function is called; the body below
  // it is the function of the file. The rest parameter is one parameter that
  // holds the arguments a call wrote, so a call packs them into the list.
  const analysis = typescript.analyze(
    [
      "export function pick(a: string, b: number): string;",
      "export function pick(b: string, a: number): string;",
      "export function pick(...args: any[]): string {",
      "  return `${args.length}`;",
      "}",
      "",
    ].join("\n"),
    "module.ts",
  );
  const picks = analysis.functions.filter((entry) => entry.name === "pick");
  assert.equal(picks.length, 1, "the overloads are not functions of the file");
  const handle = picks[0]?.handle as { variadic?: { fixed: number }; params: unknown[] } | undefined;
  assert.deepEqual(handle?.variadic, { element: { kind: "ref", of: null }, fixed: 0 }, "the rest parameter is the list");
  assert.equal(handle?.params.length, 1, "the list is one parameter");
});

test("a function declared after its caller answers the type it declares", () => {
  // A declaration is hoisted: a reader may call the function it writes below.
  // The body is read against the signatures of the whole file, so a field of
  // the answer and `in` over it are known before the declaration is reached.
  const body = JSON.stringify(analyzedBody([
    "export function f(value: string): number {",
    "  const answer = read(value);",
    "  if (\"unusable\" in answer) return 0;",
    "  return answer.proposal.rule.length;",
    "}",
    "interface Proposal { readonly rule: string }",
    "function read(value: string): { proposal: Proposal } | { unusable: string } {",
    "  if (value === ``) return { unusable: `empty` };",
    "  return { proposal: { rule: value } };",
    "}",
    "",
  ].join("\n"), "f"));
  assert.match(body, /"field":"rule"/, "a field of the answer the later declaration types is read");
  assert.doesNotMatch(body, /"k":"hole"/, "nothing of the function is refused");
});

test("an indexed access names what the field holds", () => {
  // `Outcome["failure"]` is the type the field holds, which is where the source
  // writes the one shape of a value it kept from somewhere else. Reading it as
  // `any` made every method written on the value a method of nothing.
  const body = JSON.stringify(analyzedBody([
    "interface Failure { detail: string | undefined }",
    "interface Outcome { failure: Failure | undefined }",
    "export function f(failure: Outcome[`failure`]): string {",
    "  return failure === undefined || failure.detail === undefined ? `` : failure.detail.trim();",
    "}",
    "",
  ].join("\n"), "f"));
  assert.doesNotMatch(body, /"k":"hole"/, "the value is read at the type the field names");
  assert.match(body, /text\.trim/, "the method is the text method of the field's own type");
});

test("a property parameter is the field it declares", () => {
  // `constructor(private readonly names: Set<string>)` declares a field as well
  // as a parameter, and a read written through `this` is that field: `has` is
  // the dictionary's own membership and not a method of a class nobody wrote.
  const body = JSON.stringify(analyzedBody([
    "export class Names {",
    "  constructor(private readonly names: Set<string>) {}",
    "  asks(x: string): boolean { return this.names.has(x); }",
    "}",
    "",
  ].join("\n"), "Names_asks"));
  assert.match(body, /blaze_rt_dict_has/, "the membership is the runtime dictionary's");
});

test("a class parameter written at an imported type waits for the link", () => {
  // The declaration is another module's, and the first read does not hold it:
  // what is written on the parameter waits for the read that follows the link
  // rather than being called `any` and refusing the method of nothing.
  const analysis = typescript.analyze(
    [
      'import { type Table } from "./table.ts";',
      "export class Reader {",
      "  constructor(table: Table) {}",
      "  names(table: Table): string[] { return table.declarations.map((one) => one.name); }",
      "}",
      "",
    ].join("\n"),
    "module.ts",
  );
  assert.ok(analysis.functions.some((entry) => entry.name === "Reader_names"));
});

test("a `??` keeps the shape of the arm that names one", () => {
  // The contract erases an interface to a reference, so the fields are kept
  // beside the type. A fallback whose left arm is an interface keeps that
  // shape, and a `null` on the left leaves the right arm to name it.
  const shapeOfFallback = (left: string): { name?: string } | undefined => {
    const analysis = typescript.analyze(
      [
        "interface Info { name: string }",
        "export function f(b: Info): string {",
        `  const chosen = ${left} ?? b;`,
        "  return chosen.name.trim();",
        "}",
        "",
      ].join("\n"),
      "main.ts",
    );
    const body = ((analysis.functions[0]?.handle ?? { body: [] }) as {
      body: { kind: string; value?: { k: string; name?: string } }[];
    }).body;
    return body[body.length - 1]?.value;
  };
  assert.equal(shapeOfFallback("b")?.name, "text.trim", "the record's field is a text");
  assert.equal(shapeOfFallback("null")?.name, "text.trim", "a left arm that says nothing takes the right");
});

test("a function that states no result has the one its returns are", () => {
  // The language lets a function leave the annotation off, and the returns say
  // it: a body that hands back a number is a number, and a body with no return
  // at all is the `void` the function is called for what it does.
  assert.equal(contractOf("typescript", "export function twice(x: number) {\n  return x + x;\n}\n").function.returns, "f64");
  assert.equal(phaseOf("typescript", { "main.ts": "function say(x: number) {\n  console.log(x);\n}\nsay(1);\n" }, "main.ts").program.files[0]?.functions["say"]?.function.returns, "void");
  assert.equal(contractOf("typescript", "export function big() {\n  return 9007199254740993n;\n}\n").function.returns, "i64");
});

test("a loop a reduction cannot state is contracted as a definition", () => {
  // while, do-while and for-of have no range a contract can name, so the
  // statements themselves are what the contract carries.
  const contract = contractOfExport(`export function report(values: Float64Array, limit: number): number {
  let total = 0;
  for (const value of values) {
    if (value > limit) break;
    total += value;
  }
  let i = 0;
  while (i < values.length) {
    i = i + 1;
    if (i == 1) continue;
    console.log(\`i \${i}\`);
  }
  do {
    total = total - 1;
  } while (total > 0);
  return total;
}
`, "report");
  assert.deepEqual(contract.ensures, []);
  assert.deepEqual(contract.effects, ["io"]);
  assert.equal(contract.definition?.prints, true);
  assert.deepEqual(
    contract.definition?.statements.map((statement) => statement.kind),
    ["declare", "forOf", "declare", "while", "doWhile", "result"],
  );
  const walk = contract.definition?.statements[1];
  assert.deepEqual(walk?.kind === "forOf" ? walk.body.map((one) => one.kind) : null, ["if", "assign"]);
});

test("arithmetic a contract cannot state is a definition, not a refused build", () => {
  // `%`, `<<` and `>>` have no operator in the contract language. Naming them
  // as operators a contract states a result with wrote `a[i] % 2` into the
  // postcondition, and the parser then refused the whole build with
  // `unexpected character "%"` — for source that runs.
  for (const written of ["a[i] % 2", "a[i] >> 1", "a[i] << 1"]) {
    const contract = contractOfExport(
      `export function report(a: Int32Array, n: number): number {
  let c = 0;
  for (let i = 0; i < n; i++) { c += ${written}; }
  return c;
}
`,
      "report",
    );
    assert.deepEqual(contract.ensures, [], written);
    assert.ok(contract.definition.statements.length > 0, written);
  }
});

test("the language is selected by name", () => {
  assert.equal(frontendFor("typescript"), typescript);
  assert.equal(frontendFor("ts"), typescript);
  // Python is a language the compiler reads, and it is read by its own name
  // and by the short one.
  assert.equal(frontendFor("python"), pythonFrontend);
  assert.equal(frontendFor("py"), pythonFrontend);
  let diagnostic = "";
  try {
    frontendFor("cobol");
  } catch (error) {
    diagnostic = error instanceof CompilerError ? `${error.message}\n${error.detail ?? ""}` : String(error);
  }
  assert.match(diagnostic, /supported languages: nim, typescript, python/);
});

test("a string that is never closed is reported instead of read again and again", () => {
  // Treating the missing quote as the end of the string put the scan back at
  // the start of the source, where it read the same unterminated string over
  // and over: a file truncated mid-edit never came back at all.
  assert.match(
    diagnostic(() => typescript.analyze('export function f(a: number): number {\n  return a;\n}\nconst s = "oops\n', "main.ts")),
    /unterminated string/,
  );
  assert.match(diagnostic(() => typescript.analyze("const c = ';\n", "main.ts")), /unterminated string/);
  assert.match(diagnostic(() => typescript.analyze("const t = `;\n", "main.ts")), /unterminated string/);
});

test("a renamed import is read where it is written, and the file is read past it", () => {
  // `{ scale as fromB }` binds the export under the name the file writes. The
  // alias is read with the rest of the statement, so the `}` that closes the
  // import ends it and the file reads on; a call written under the alias is
  // emitted under the name the module exports.
  const analysis = typescript.analyze('import { scale as fromB } from "./b.ts";\nconsole.log(fromB(2));\n', "main.ts");
  assert.equal(analysis.imports[0]?.renames?.[0]?.local, "fromB");
  assert.equal(analysis.imports[0]?.renames?.[0]?.imported, "scale");
  // A stray closing brace is not a statement, and reading it is what makes the
  // rest of the file reachable: a scanner that stops before one must not stop
  // on it forever.
  assert.match(
    diagnostic(() => typescript.analyze("export function f(): number { return 1; }\n}\n", "main.ts")),
    /"\}" is not a statement of a program/,
  );
});

test("a quote an escape covers does not end the string", () => {
  // The escape has to be read before the string is closed, or the token ends
  // at the escaped quote and the rest of the string is read as a new
  // statement. The construct after it is refused on the line it is written on.
  const message = diagnostic(() =>
    typescript.analyze(
      'export function f(x: number): number {\n  const s = "a\\"b";\n  yield x;\n  return x;\n}\n',
      "main.ts",
    ),
  );
  assert.match(message, /line 3: "yield" is not supported/);
  assert.doesNotMatch(message, /line 2/);
});

test("a string that spans lines moves the line every later diagnostic names", () => {
  // The block comment beside it counts its newlines; a template literal
  // spanning three more lines used to leave every construct after it reported
  // three lines short of where the user wrote it.
  const message = diagnostic(() =>
    typescript.analyze(
      "export function g(x: number): number {\n  console.log(`\nreport\nhere\n`);\n  yield x;\n  return x;\n}\n",
      "main.ts",
    ),
  );
  assert.match(message, /line 6: "yield" is not supported/);
});

test("an interpolation ends at the brace that closes it, not the first one", () => {
  // An object literal or a `"}"` argument inside `${}` carries its own brace,
  // Nothing here is outside the subset, so the module is read: before, the
  // first `}` closed the interpolation and the rest was reported malformed.
  const analysis = typescript.analyze(
    "export function f(x: number): number {\n  console.log(`${x > 0 ? { a: 1 }.a : 0}`);\n  return x;\n}\n",
    "main.ts",
  );
  assert.deepEqual(
    analysis.functions.map((declared) => declared.name),
    ["f"],
  );
});

test("the compound operators parse where their binary ones do", () => {
  // `&=` and the rest were not tokenised, so the source split them into the
  // identifier and a stray `&` and the message landed on the wrong token. Now
  // they are one token, and the binary they name is what they write.
  const source = [
    "export function r(n: number): number {",
    "  let s = 0;",
    "  for (let i = 1; i < n; i += 1) {",
    "    i &= 7;",
    "    i |= 1;",
    "    i ^= 2;",
    "    i <<= 1;",
    "    i >>= 0;",
    "    i >>>= 0;",
    "    i %= 4;",
    "    s += i;",
    "  }",
    "  let b = n;",
    "  b **= 2;",
    "  return s + b;",
    "}",
    "",
  ].join("\n");
  const analysis = typescript.analyze(source, "main.ts");
  assert.deepEqual(
    analysis.functions.map((declared) => declared.name),
    ["r"],
  );
});

test("a template inside an interpolation is part of the template that holds it", () => {
  // The lexer stopped the outer token at the first unescaped backtick, which
  // belonged to the nested template: the outer text was truncated to `"${"`
  // and the parser refused the interpolation.
  const analysis = typescript.analyze(
    "export function f(n: number): number {\n  console.log(`${`inner ${n}`}`);\n  return n;\n}\n",
    "main.ts",
  );
  assert.deepEqual(
    analysis.functions.map((declared) => declared.name),
    ["f"],
  );
});

test("an escaped `\\${` is the text it writes, not an interpolation", () => {
  // It is how a template prints a literal `${`. Reading it as the start of an
  // interpolation left the backslash alone and aborted the whole build with a
  // backslash that had nothing after it.
  const body = typescript.analyze("const n = 5;\nconsole.log(`\\${n}`);\n", "main.ts").body;
  assert.deepEqual(body, [
    { kind: "declare", name: "n", mutable: false, type: null, value: { k: "number", text: "5" }, line: 1 },
    { kind: "print", values: [{ k: "text", parts: [{ k: "text", value: "${n}" }] }], line: 2 },
  ]);
});

test("a function that returns nothing is contracted by what it does, not refused for returning nothing", () => {
  // A body of declarations and assignments is the one shape that reaches the
  // end of the contract analysis without having already been uncontractable:
  // every other statement — a branch, a call, a print, an update — leaves it
  // there first. `void` is what the source declared, so there is no expression
  // the result must equal and none is asked for.
  const contract = contractOfExport(
    [
      "export function tally(n: number): void {",
      "  let i = 0;",
      "  i = i + 1;",
      "  i = i * n;",
      "}",
    ].join("\n"),
    "tally",
  );
  assert.equal(contract.function.returns, "void");
  assert.deepEqual(contract.ensures, [], "a void function has no postcondition to meet");
  assert.equal(contract.definition.statements.length, 3, "the body travels as what the function is");
});

test("a function that declares a value and returns none is still refused", () => {
  // The other side of the same question: `void` is what makes the absence of a
  // result an answer rather than a fault.
  assert.throws(
    () =>
      contractOfExport(
        ["export function tally(n: number): number {", "  let i = 0;", "  i = i + 1;", "}"].join("\n"),
        "tally",
      ),
    /tally never returns a value/,
  );
});

test("an arrow function is lifted into a function of the file, with what it captured in front", () => {
  // An arrow is bound to the name it is declared under and called by that name.
  // Its body becomes a function of the file whose leading parameters are the
  // values it captured, so a call of the name writes those values in front of
  // its own arguments and the body reads them as it read the names around it.
  const analysis = typescript.analyze(
    [
      "export function add(x: number): number {",
      "  const plus = (y: number): number => y + x;",
      "  return plus(2);",
      "}",
      "",
    ].join("\n"),
    "main.ts",
  );
  assert.deepEqual(
    analysis.functions.map((declared) => declared.name),
    ["add", "__closure_main_0"],
  );
  const lifted = analysis.functions[1];
  assert.equal(lifted?.internal, true, "an arrow is not an export of the file");
  assert.deepEqual(
    lifted?.params.map((param) => param.name),
    ["x", "y"],
    "the captured value is the leading parameter",
  );

  const body = ((analysis.functions[0]?.handle ?? { body: [] }) as {
    body: { kind: string; name?: string; value?: { k: string; name?: string; args?: { k: string; name?: string }[] } }[];
  }).body;
  const call = body[1]?.value;
  assert.equal(call?.k, "call");
  assert.equal(call?.name, "__closure_main_0");
  assert.deepEqual(
    call?.args?.map((arg) => (arg.k === "ident" ? arg.name : arg.k)),
    ["x", "literal"],
    "the capture is written in front of the argument the source wrote",
  );
});

test("an arrow written where it is called is a call of the function it lifted to", () => {
  // The call itself is the direct one, and the entry a value would be called
  // through is written beside it because the arrow is a value at the call.
  const analysis = typescript.analyze(
    "export function f(x: number): number {\n  return ((a: number): number => a + x)(2);\n}\n",
    "main.ts",
  );
  assert.deepEqual(
    analysis.functions.map((declared) => declared.name),
    ["f", "__closure_main_0", "__closure_code_main_0"],
  );
  const body = ((analysis.functions[0]?.handle ?? { body: [] }) as {
    body: { kind: string; value?: { k: string; name?: string } }[];
  }).body;
  assert.equal(body[0]?.value?.k, "call");
  assert.equal(body[0]?.value?.name, "__closure_main_0");
});

test("an arrow that escapes the name it is bound to is a closure value", () => {
  // Read where a value is expected, an arrow is a closure: the values it
  // captured travel with it and the entry the frontend writes unpacks them, so
  // a holder that never saw the declaration can still call it.
  const analysis = typescript.analyze(
    [
      "export function take(f: (y: number) => number): number {",
      "  return f(1);",
      "}",
      "export function f(x: number): number {",
      "  const g = (y: number): number => y + x;",
      "  return take(g);",
      "}",
      "",
    ].join("\n"),
    "main.ts",
  );
  const body = ((analysis.functions[1]?.handle ?? { body: [] }) as {
    body: { kind: string; value?: { k: string; name?: string; args?: { k: string; name: string; code?: string; captures?: string[] }[] } }[];
  }).body;
  const passed = body[1]?.value?.args?.[0] as { k: string; name: string; code?: string; captures?: string[] };
  assert.equal(passed?.k, "arrow");
  assert.equal(passed?.name, "__closure_main_0");
  assert.equal(passed?.code, "__closure_code_main_0");
  assert.deepEqual(passed?.captures, ["x"]);

  // The entry reads each captured value out of the closure and writes it in
  // front of the call, so the body itself needs no environment.
  const entry = ((analysis.functions[3]?.handle ?? { body: [] }) as {
    body: { kind: string; value?: { k: string; name?: string; args?: { k: string; name?: string; index?: number }[] } }[];
  }).body;
  const call = entry[0]?.value;
  assert.equal(call?.name, "__closure_main_0");
  assert.deepEqual(call?.args?.map((arg) => arg.k), ["capture", "ident"]);
  assert.equal(call?.args?.[0]?.index, 0);
});

test("a call of a value is a call through the closure, not of a name", () => {
  const analysis = typescript.analyze(
    "export function take(f: (y: number) => number): number {\n  return f(2);\n}\n",
    "main.ts",
  );
  const body = ((analysis.functions[0]?.handle ?? { body: [] }) as {
    body: { kind: string; value?: { k: string; callee?: { k: string; name?: string }; returns?: { kind: string } } }[];
  }).body;
  const call = body[0]?.value;
  assert.equal(call?.k, "invoke");
  assert.equal(call?.callee?.name, "f");
  assert.equal(call?.returns?.kind, "primitive");
});

test("an arrow that writes a name of the function around it writes the list both sides hold", () => {
  // A lifted arrow is handed the values it captured, and a parameter carries a
  // value in but cannot write one back. A name the arrow writes is therefore
  // held in a one-element list, which is a reference: the arrow and the
  // function around it write and read the same element, and the answer is the
  // one the source wrote rather than the copy a parameter would have been.
  const body = analyzedBody(
    [
      "export function f(x: number): number {",
      "  let total = 0;",
      "  const add = (v: number): void => { total += v; };",
      "  add(x);",
      "  return total;",
      "}",
      "",
    ].join("\n"),
    "f",
  ) as {
    kind: string;
    name?: string;
    type?: unknown;
    init?: { k: string; values?: unknown[] };
    value?: { name?: string; args?: { name?: string }[] };
  }[];
  assert.equal(body[0]?.name, "__box_module_0", "the name the arrow writes is a list");
  assert.deepEqual(body[0]?.type, { kind: "slice", of: { kind: "primitive", name: "f64" } });
  assert.equal(body[0]?.init?.k, "buffer");
  assert.equal(body[2]?.value?.name, "__closure_module_0");
  assert.equal(body[2]?.value?.args?.[0]?.name, "__box_module_0", "the arrow is handed the list");
  const read = body[3] as { value?: { base?: { name?: string } } };
  assert.equal(read.value?.base?.name, "__box_module_0", "the result reads the element");
});

test("an arrow that writes a list it captured writes the object both sides hold", () => {
  // A list has no element that holds a list, so the box is a one-field object
  // rather than a one-element list: the name becomes the object, and both sides
  // write the field.
  const body = analyzedBody(
    [
      "export function f(x: number): number {",
      "  const found: number[] = [];",
      "  const add = (v: number): void => { found.push(v); };",
      "  add(x);",
      "  return found.length;",
      "}",
      "",
    ].join("\n"),
    "f",
  ) as {
    kind: string;
    name?: string;
    type?: unknown;
    init?: { k: string; fields?: { name?: string }[] };
    value?: { name?: string; args?: { name?: string }[] };
  }[];
  assert.equal(body[0]?.name, "__box_module_0", "the list the arrow writes is one object");
  assert.equal(body[0]?.init?.k, "object");
  assert.equal(body[0]?.init?.fields?.[0]?.name, "__boxed", "the object holds the list in one field");
  assert.equal(body[2]?.value?.name, "__closure_module_0");
  assert.equal(body[2]?.value?.args?.[0]?.name, "__box_module_0", "the arrow is handed the object");
});

test("a top-level list asserted as const or joined is one value, not two statements", () => {
  // The scan past a top-level initialiser has to end after the type it is
  // asserted as and after a call chained to the list. Read as a statement of
  // its own, `as const` was "a class member value is one expression" and the
  // call after a list was read as the body of nothing.
  const analysis = typescript.analyze(
    [
      "const FRAMES = [`a`, `b`] as const;",
      "export const RULES = [`x`, `y`].join(`-`);",
      "export function f(): number { return FRAMES.length; }",
      "",
    ].join("\n"),
    "module.ts",
    false,
  );
  assert.deepEqual(analysis.imports, []);
});

test("an arrow takes the rest of a call's arguments as one list", () => {
  // `(...taken: string[]) => ...` is handed what the call wrote from that
  // position on, packed into the list the lifted function's parameter is.
  const body = analyzedBody(
    [
      "export function f(): number {",
      "  const take = (...taken: string[]): number => taken.length;",
      "  return take(`a`, `b`) + take();",
      "}",
      "",
    ].join("\n"),
    "f",
  ) as { kind: string; value?: { op?: string; args?: { k?: string; values?: unknown[] }[] } }[];
  const call = body[1];
  assert.equal(call?.kind, "result");
  assert.equal(call?.value?.op, "+");
  const first = (call?.value as unknown as { left: { name?: string; args?: { k?: string; values?: unknown[] }[] } }).left;
  assert.equal(first?.name, "__closure_module_0");
  const packed = first?.args?.[0];
  assert.equal(packed?.k, "buffer", "the arguments are packed into one list");
  assert.equal(packed?.values?.length, 2);
});

test("an optional chain reads a call once, into a name before the statement", () => {
  // `f()?.field` reads `f()` in the condition and again in the branch, so the
  // call is written into a name of the statement's own first and both reads are
  // the name: the call runs once, which is what the source wrote.
  const body = analyzedBody(
    [
      "class Box { value: number; constructor(value: number) { this.value = value; } }",
      "function make(): Box { return new Box(4); }",
      "export function f(): number { return make()?.value ?? 0; }",
      "",
    ].join("\n"),
    "f",
  ) as { kind: string; name?: string; init?: { k?: string }; value?: { k?: string; condition?: { left?: { name?: string } }; then?: { name?: string } } }[];
  const held = body[0];
  assert.equal(held?.kind, "declare");
  assert.equal(held?.init?.k, "call");
  const result = body[1] as {
    kind?: string;
    value?: { condition?: { left?: { name?: string } }; then?: { base?: { name?: string } } };
  };
  assert.equal(result?.kind, "result");
  // The chain is the conditional its two reads become.
  assert.equal(result?.value?.condition?.left?.name, held?.name, "the condition reads the name");
  assert.equal(result?.value?.then?.base?.name, held?.name, "the branch reads the same name");
});

test("an optional chain in a loop condition is not hoisted out of the loop", () => {
  // A condition is read every turn, and a value written before the loop would
  // be read once: the refusal stands rather than the call being moved.
  assert.match(
    diagnostic(() =>
      typescript.analyze(
        [
          "class Box { value: number; constructor(value: number) { this.value = value; } }",
          "function make(): Box { return new Box(4); }",
          "export function f(): number {",
          "  while (make()?.value !== undefined) { break; }",
          "  return 0;",
          "}",
          "",
        ].join("\n"),
        "main.ts",
      ),
    ),
    /an optional chain reads the value before `\?\.` twice/,
  );
});

test("an assignment in a template string is a statement before the one that writes it", () => {
  // `\`n${this.builds += 1}\`` both writes and reads the field. A write is a
  // statement, so it runs before the statement the string is part of, and the
  // value the string interpolates is the place read after it. The write is not
  // inside the text: the text is built from the value the write left behind.
  const body = analyzedBody(
    [
      "class Counter {",
      "  builds: number;",
      "  constructor() { this.builds = 0; }",
      "  next(): string { return `n${this.builds += 1}`; }",
      "}",
      "",
    ].join("\n"),
    "Counter_next",
  ) as { kind: string; base?: string; field?: string; op?: string; value?: { k?: string; parts?: { k: string; value?: unknown }[] } }[];
  const write = body[0];
  assert.equal(write?.kind, "memberAssign");
  assert.equal(write?.base, "self");
  assert.equal(write?.field, "builds");
  assert.equal(write?.op, "+=");
  const result = body[1];
  assert.equal(result?.kind, "result");
  assert.equal(result?.value?.k, "text");
  const interpolated = result?.value?.parts?.[1];
  assert.equal(interpolated?.k, "value");
  assert.deepEqual(interpolated?.value, { k: "member", base: { k: "ident", name: "self" }, field: "builds" });
});

test("an arrow that calls itself hands over the values it captured", () => {
  // The values the arrow captured are the lifted function's leading parameters,
  // and a call the body writes of itself was read before they were known: the
  // call is completed once the body has said what they are.
  const analysis = typescript.analyze(
    [
      "export function f(x: number): number {",
      "  const fact = (n: number): number => n <= 1 ? 1 : n * fact(n - 1) + x;",
      "  return fact(x);",
      "}",
      "",
    ].join("\n"),
    "main.ts",
  );
  const closure = analysis.functions.find((entry) => entry.name.startsWith("__closure_"));
  assert.ok(closure !== undefined, "the arrow is a function of the file");
  const lifted = closure.handle as { params: { name: string }[]; body: unknown[] };
  assert.deepEqual(lifted.params.map((param) => param.name), ["x", "n"], "the captured value leads the parameters");
  assert.match(JSON.stringify(lifted.body), /"name":"x"/, "the call passes the value it captured");
});

test("an arrow's body is a function of its own, so a break leaves a loop of that body", () => {
  // The loop the arrow is written in is not a loop the function it lifted to is
  // inside, so a `break` written in the arrow's body cannot leave it. Reading it
  // as the enclosing loop's break left a stray statement in the lifted body.
  assert.match(
    diagnostic(() =>
      typescript.analyze(
        [
          "export function f(n: number): number {",
          "  let total = 0;",
          "  for (let i = 0; i < n; i++) {",
          "    const step = (): number => { break; };",
          "    total += step();",
          "  }",
          "  return total;",
          "}",
          "",
        ].join("\n"),
        "main.ts",
      ),
    ),
    /"break" is not within a loop/,
  );
  // A loop written inside the arrow's own body is one its break can leave.
  const analysis = typescript.analyze(
    [
      "export function f(n: number): number {",
      "  const sum = (k: number): number => {",
      "    let total = 0;",
      "    for (let i = 0; i < k; i++) total += i;",
      "    return total;",
      "  };",
      "  return sum(n);",
      "}",
      "",
    ].join("\n"),
    "main.ts",
  );
  assert.deepEqual(
    analysis.functions.map((declared) => declared.name),
    ["f", "__closure_main_0"],
  );
});

test("an arrow that writes through a value it captured is still a capture", () => {
  // A field or an element written through a reference is a write the lifted
  // function can make: what it holds is the object itself, so the write is the
  // one the source wrote. Only a write to the captured name is refused.
  const analysis = typescript.analyze(
    [
      "export function f(x: number): number {",
      "  const o = { a: 1 };",
      "  const set = (v: number): void => { o.a = v; };",
      "  set(x);",
      "  return o.a;",
      "}",
      "",
    ].join("\n"),
    "main.ts",
  );
  const lifted = analysis.functions[1];
  assert.deepEqual(
    lifted?.params.map((param) => param.name),
    ["o", "v"],
  );
});

test("a closure and a call through one survive being written as IR and read back", () => {
  // The IR is what a model is shown and what a candidate is read back from, so
  // a closure has to be in the text as the value it is: the function that
  // enters it, the signature that function is declared with, and the values it
  // captured.
  const source = [
    "export function apply(f: (x: number) => number, x: number): number {",
    "  return f(x);",
    "}",
    "export function g(a: number): number {",
    "  const inc = (y: number): number => y + a;",
    "  return apply(inc, 2);",
    "}",
    "",
  ].join("\n");
  // The functions are exports of a module that runs, so the program is the
  // oracle they are resolved against.
  const phase = phaseOf("typescript", { "main.ts": `${source}console.log("run");\n` }, "main.ts");
  const semantics = semanticsOf(phase);
  const g = printSemanticFunction(semantics["g"] as never);
  assert.match(g, /closure\[/, "the arrow is a closure value in the IR");
  const apply = printSemanticFunction(semantics["apply"] as never);
  assert.match(apply, /through /, "the call of the parameter is a call through the closure");
  for (const text of [g, apply]) {
    const reread = parseSemanticFunction(text, phase.program);
    assert.equal(printSemanticFunction(reread), text, "the IR the printer wrote reads back as itself");
  }
});

test("a collection method is a function of the file that walks the array", () => {
  // `a.map(f)` is not a method this compiler has: the frontend writes a
  // function that walks the array and calls the closure, and the call is a
  // call of that function.
  const analysis = typescript.analyze(
    [
      "export function g(a: Float64Array): number {",
      "  const b = a.map((x: number): number => x * 2);",
      "  return b[0];",
      "}",
      "",
    ].join("\n"),
    "main.ts",
  );
  const names = analysis.functions.map((declared) => declared.name);
  assert.ok(names.includes("__collect_main_0"), "the walk is a function of the file");
  const helper = analysis.functions.find((declared) => declared.name === "__collect_main_0");
  assert.equal(helper?.internal, true, "the walk is not an export of the file");
  assert.deepEqual(
    helper?.params.map((param) => param.name),
    ["items", "fn"],
    "the walk takes the array and the closure it calls",
  );
  const body = ((analysis.functions[0]?.handle ?? { body: [] }) as {
    body: { kind: string; init?: { k: string; name?: string; args?: { k: string }[] } }[];
  }).body;
  const call = body[0]?.init;
  assert.equal(call?.k, "call");
  assert.equal(call?.name, "__collect_main_0");
  assert.deepEqual(call?.args?.map((argument) => argument.k), ["ident", "arrow"]);
});

test("a declared function is a closure a collection method can call", () => {
  // A function the file declares is a value where it is not called, and a
  // collection method takes the function itself: the name is a closure with
  // nothing captured, entered through a function of the file that calls the
  // declaration.
  const analysis = typescript.analyze(
    [
      "function twice(x: number): number { return x * 2; }",
      "export function g(a: Float64Array): number {",
      "  const b = a.map(twice);",
      "  return b[0];",
      "}",
      "",
    ].join("\n"),
    "main.ts",
  );
  const names = analysis.functions.map((declared) => declared.name);
  assert.equal(names.filter((name) => name === "twice").length, 1, "the declaration is one function of the file");
  const body = ((analysis.functions.find((declared) => declared.name === "g")?.handle ?? { body: [] }) as {
    body: { kind: string; init?: { k: string; name?: string; args?: { k: string; name?: string; code?: string; captures?: string[] }[] } }[];
  }).body;
  const call = body[0]?.init;
  assert.equal(call?.k, "call");
  assert.equal(call?.name, "__collect_main_0");
  assert.deepEqual(call?.args?.map((argument) => argument.k), ["ident", "arrow"]);
  const closure = call?.args?.[1];
  assert.equal(closure?.name, "twice", "the closure is the declaration");
  assert.equal(closure?.captures?.length, 0, "a declaration captures nothing");
  assert.ok(closure?.code !== undefined, "the closure is entered through a function of the file");
  const entry = analysis.functions.find((declared) => declared.name === closure?.code);
  assert.ok(entry !== undefined, "the entry is a function of the file");
  assert.deepEqual(
    entry?.params.map((param) => param.name),
    ["self", "a0"],
    "the entry takes the closure and then the declaration's parameters",
  );
});

test("a value that is not a function is refused where a callback is expected", () => {
  // A name a body declared itself is that value, and a number is not a
  // callback: only a declared function or an arrow is one.
  assert.match(
    diagnostic(() =>
      typescript.analyze(
        [
          "export function g(a: Float64Array): number {",
          "  const twice = 3;",
          "  const b = a.map(twice);",
          "  return b[0];",
          "}",
          "",
        ].join("\n"),
        "main.ts",
      ),
    ),
    /the function handed to map is not one this compiler can call/,
  );
});

test("a map that answers a list is refused, because a list of lists is not a value", () => {
  assert.match(
    diagnostic(() =>
      typescript.analyze(
        [
          "export function g(a: Float64Array): number {",
          "  const b = a.map((x: number): number[] => [x]);",
          "  return b.length;",
          "}",
          "",
        ].join("\n"),
        "main.ts",
      ),
    ),
    /the function map walks the array with must answer a number, a truth, a text or a reference/,
  );
});

test("a collection callback's parameter is the element its array holds", () => {
  // `xs.map((s) => s.trim())` names no type for `s`: the array is what says it.
  // The callback is a function of the file, so its parameter is read there.
  const arrow = liftedArrow([
    "export function trimmed(xs: string[]): string[] {",
    "  return xs.map((s) => s.trim());",
    "}",
    "",
  ].join("\n"));
  assert.deepEqual(arrow.params.map((param) => param.name), ["s"]);
  assert.deepEqual(arrow.params[0]?.type, { kind: "text" }, "the array's element type is the parameter's");
  assert.match(JSON.stringify(arrow.body), /text\.trim/);
});

test("a collection callback over records reads the fields the interface declares", () => {
  // An array of an interface is an array of references the contract cannot name
  // a field of, and the shape of the array is what the callback reads through.
  const arrow = liftedArrow([
    "interface Entry { name: string }",
    "export function names(entries: Entry[]): string[] {",
    "  return entries.map((entry) => entry.name.trim());",
    "}",
    "",
  ].join("\n"));
  assert.match(JSON.stringify(arrow.body), /"field":"name"/);
  assert.match(JSON.stringify(arrow.body), /text\.trim/);
});

test("a destructured callback binds its names at the element's fields", () => {
  const arrow = liftedArrow([
    "export function heads(xs: [string, number][]): string[] {",
    "  return xs.map(([head]) => head.trim());",
    "}",
    "",
  ].join("\n"));
  assert.match(JSON.stringify(arrow.body), /"name":"head"/);
  assert.match(JSON.stringify(arrow.body), /text\.trim/);
});

test("sort compares elements and reduce folds them, without the source writing their types", () => {
  const compared = liftedArrow([
    "export function ordered(xs: number[]): number[] {",
    "  return xs.sort((a, b) => a - b);",
    "}",
    "",
  ].join("\n"));
  assert.deepEqual(compared.params.map((param) => param.name), ["a", "b"]);
  assert.deepEqual(compared.params.map((param) => param.type), [
    { kind: "primitive", name: "f64" },
    { kind: "primitive", name: "f64" },
  ]);
  const folded = liftedArrow([
    "export function total(xs: number[]): number {",
    "  return xs.reduce((acc, x) => acc + x, 0);",
    "}",
    "",
  ].join("\n"));
  assert.deepEqual(folded.params.map((param) => param.name), ["acc", "x"]);
  assert.deepEqual(folded.params.map((param) => param.type), [
    { kind: "primitive", name: "f64" },
    { kind: "primitive", name: "f64" },
  ]);
});

test("a callback's written annotation is the type it is read at", () => {
  // The receiver holds no element type here, and the annotation is what `s` is.
  const arrow = liftedArrow([
    "export function trimmed(xs: any[]): string[] {",
    "  return xs.map((s: string): string => s.trim());",
    "}",
    "",
  ].join("\n"));
  assert.deepEqual(arrow.params[0]?.type, { kind: "text" });
  assert.match(JSON.stringify(arrow.body), /text\.trim/);
});

test("an array of text is a slice of text, and its literal is a block written out", () => {
  const analysis = typescript.analyze(
    [
      "class Node { value: number = 0; }",
      "export function f(a: string[], b: Node[], c: number[][]): number {",
      "  const d: string[] = [`x`];",
      "  return a.length + b.length + c.length + d.length;",
      "}",
      "",
    ].join("\n"),
    "main.ts",
  );
  const f = analysis.functions.find((declared) => declared.name === "f");
  assert.deepEqual(
    f?.params.map((param) => param.type),
    [
      { kind: "slice", of: { kind: "text" } },
      { kind: "slice", of: { kind: "ref", of: null, name: "Node" } },
      { kind: "slice", of: { kind: "slice", of: { kind: "primitive", name: "f64" } } },
    ],
    "an array of a type the frontend can name is that slice; one it cannot is the reference",
  );
  assert.deepEqual(f?.returns, { kind: "primitive", name: "f64" });
});

test("a method whose result is written as an object type does not hide the methods after it", () => {
  // The `{` of `{ line: number }` is the first token after the result's colon,
  // and the `{` of the body is the one after the type's own closing brace. A
  // scanner that took the first one for the body read the type's fields as
  // members and lost every method written after it.
  const analysis = typescript.analyze(
    [
      "class Box {",
      "  pair(): { a: number; b: number } { return { a: 1, b: 2 }; }",
      "  next(): number { return 3; }",
      "  get size(): number { return 2; }",
      "}",
      "",
    ].join("\n"),
    "main.ts",
  );
  assert.deepEqual(
    analysis.functions.map((declared) => declared.name),
    ["Box", "Box_pair", "Box_next", "Box_size"],
  );
});

test("Array<T> and ReadonlyArray<T> name the same array as T[]", () => {
  for (const written of ["Array<string>", "ReadonlyArray<string>", "string[]", "readonly string[]"]) {
    const analysis = typescript.analyze(
      `export function f(a: ${written}): number {\n  return a.length;\n}\n`,
      "main.ts",
    );
    assert.deepEqual(
      analysis.functions[0]?.params[0]?.type,
      { kind: "slice", of: { kind: "text" } },
      written,
    );
  }
});

test("an empty array is built at the type the use writes it at", () => {
  // The list has no element to read a type from, so the declaration, the
  // result, the other arm of the conditional, the right side of `??`, the
  // object field, or the argument's parameter is what says what it holds.
  const analysis = typescript.analyze(
    [
      "interface Box { values: number[]; }",
      "function takes(values: number[]): number { return values.length; }",
      "export function condition(flag: boolean): number[] {",
      "  return flag ? [] : [1];",
      "}",
      "export function assertion(): number[] {",
      "  return [] as number[];",
      "}",
      "export function object(): Box {",
      "  return { values: [] };",
      "}",
      "export function argument(): number {",
      "  const box: Box = { values: [] };",
      "  return takes(box.values) + takes([]);",
      "}",
      "export function inferred(flag: boolean): number {",
      "  const chosen = flag ? [] : [1, 2];",
      "  return chosen.length;",
      "}",
      "export function nested(): number[][] {",
      "  return [[], [1]];",
      "}",
      "export function nullish(values: number[] | null): number[] {",
      "  return values ?? [];",
      "}",
      "",
    ].join("\n"),
    "main.ts",
  );
  interface Lowered {
    k: string;
    element?: string;
    values?: Lowered[];
    then?: Lowered;
    otherwise?: Lowered;
    fields?: { name: string; value: Lowered }[];
    args?: Lowered[];
    left?: Lowered;
    right?: Lowered;
  }
  const body = (name: string): { kind: string; value?: Lowered; init?: Lowered }[] =>
    ((analysis.functions.find((declared) => declared.name === name)?.handle ?? { body: [] }) as {
      body: { kind: string; value?: Lowered; init?: Lowered }[];
    }).body;
  /** The first list a written value builds, past the copy it joins against. */
  const firstBuffer = (value: Lowered | undefined): Lowered | undefined => {
    if (value === undefined) return undefined;
    if (value.k === "buffer") return value;
    return firstBuffer(value.left) ?? firstBuffer(value.right) ?? firstBuffer(value.then) ?? firstBuffer(value.otherwise);
  };

  const conditional = body("condition")[0]?.value;
  assert.equal(firstBuffer(conditional?.then)?.element, "f64", "the empty arm is the other arm's element");
  assert.equal(firstBuffer(conditional?.otherwise)?.element, "f64");

  assert.equal(firstBuffer(body("assertion")[0]?.value)?.element, "f64", "an assertion names the element type");

  const field = body("object")[0]?.value?.fields?.find((entry) => entry.name === "values");
  assert.equal(firstBuffer(field?.value)?.element, "f64", "an object field is declared by the object's type");

  const argument = body("argument");
  const declaredBox = argument[0]?.init?.fields?.find((entry) => entry.name === "values");
  assert.equal(firstBuffer(declaredBox?.value)?.element, "f64", "a local object's field is declared by its type");
  assert.equal(firstBuffer(argument[1]?.value?.right?.args?.[0])?.element, "f64", "an argument is read at its parameter's type");

  const inferred = body("inferred")[0]?.init;
  assert.equal(firstBuffer(inferred?.then)?.element, "f64", "an unannotated conditional takes the element from its other arm");
  assert.equal(firstBuffer(inferred?.otherwise)?.element, "f64");

  const nested = firstBuffer(body("nested")[0]?.value);
  assert.equal(nested?.element, "slice<f64>", "a list of lists is a list of their element type");
  assert.equal(firstBuffer(nested?.values?.[0])?.element, "f64", "the inner empty list is read at the outer element's type");

  const nullish = body("nullish")[0]?.value;
  assert.equal(nullish?.k, "binary");
  assert.equal(firstBuffer(nullish?.right)?.element, "f64", "the fallback is read at the type of the value it falls back from");
});

test("Array.isArray is settled where the type is written and asked where it is not", () => {
  // A list is a block of one element type, so a value the read holds at a list
  // type is one and a number is not. A value the read does not type is asked of
  // the runtime, which carries the kind.
  const settled = JSON.stringify(analyzedBody([
    "export function ask(list: number[], count: number): boolean {",
    "  return Array.isArray(list) && !Array.isArray(count);",
    "}",
    "",
  ].join("\n"), "ask"));
  assert.doesNotMatch(settled, /blaze_rt_is_array/, "a list and a number are answered where they are read");
  const asked = JSON.stringify(analyzedBody(
    "export function ask(value: unknown): boolean { return Array.isArray(value); }",
    "ask",
  ));
  assert.match(asked, /blaze_rt_is_array/, "a value the read does not type is asked of the runtime");
});

test("a branch Array.isArray holds reads the value as a list", () => {
  // A value the read does not type — a type parameter, an `any`, a field of a
  // module the graph has not linked — is asked of the runtime because the read
  // cannot say what it is. In the branch the test holds in it is a list, so the
  // methods of a list are read there, and the other branch says nothing.
  const source = [
    "function walk<T>(node: T): T {",
    "  if (Array.isArray(node)) return node.map((entry) => entry) as T;",
    "  return node;",
    "}",
    "function each(value: any): number {",
    "  if (!Array.isArray(value)) return 0;",
    "  return value.length;",
    "}",
    "export function run(): number { return each(1); }",
    "",
  ].join("\n");
  assert.deepEqual(readTypeScriptModule(source, "main.ts", false).refused, []);

  const other = [
    "function walk<T>(node: T): T {",
    "  if (Array.isArray(node)) return node;",
    "  return node.map((entry) => entry) as T;",
    "}",
    "",
  ].join("\n");
  assert.match(
    readTypeScriptModule(other, "main.ts", false).refused[0]?.message ?? "",
    /"map" is not a method this program compiles/,
  );
});

test("a collection declared below a function is still what the name holds", () => {
  // A top-level `new Set<string>()` holds a handle the running program has, so
  // it is state and not a constant — but the name is a set, and a function
  // written above the declaration reads `has` on it. The scan keeps the type
  // the allocation writes so that read knows what the name holds.
  const source = [
    "export function known(name: string): boolean { return seen.has(name); }",
    "const seen = new Set<string>();",
    "export function mark(name: string): void { seen.add(name); }",
    "",
  ].join("\n");
  assert.deepEqual(readTypeScriptModule(source, "main.ts", false).refused, []);
});

test("a list method that answers one element keeps the element's shape", () => {
  // `find` and `at` answer one element of the list, so what the answer holds is
  // what the list's element holds: `find(f).values` is a field of the record,
  // not a field of the opaque reference the contract spells.
  const source = [
    "interface Offer { path: string; values: ReadonlyMap<string, number> }",
    "export function found(offered: Offer[], path: string): number {",
    "  const target = offered.find((one) => one.path === path);",
    "  if (target === undefined) return 0;",
    "  return target.values.get(path) ?? 0;",
    "}",
    "export function taken(offered: Offer[], index: number): number {",
    "  return offered.at(index).values.get(`a`) ?? 0;",
    "}",
    "",
  ].join("\n");
  assert.deepEqual(readTypeScriptModule(source, "main.ts", false).refused, []);
});

test("a string that holds a bracket is not a bracket", () => {
  // The signature scan counts brackets, and a string whose text is `{` or `}`
  // is one token: counting it as a bracket put every function after it inside
  // something, so their signatures were never scanned and a call written above
  // one answered nothing.
  const source = [
    "export function open(): string { return `{`; }",
    "export function ask(sizes: number[]): boolean { return rows(sizes).has(`a`); }",
    "function rows(sizes: number[]): Set<string> {",
    "  const found = new Set<string>();",
    "  return found;",
    "}",
    "",
  ].join("\n");
  assert.deepEqual(readTypeScriptModule(source, "main.ts", false).refused, []);
});

test("`in` asks a dictionary whether it holds the key", () => {
  // A dictionary's fields are not written down, so there is no field to compare
  // against: the question is the `has` the dictionary's own entries answer, and
  // the key is the one the dictionary holds.
  const source = [
    "export function asked(args: Record<string, number>, name: string): boolean {",
    "  return name in args;",
    "}",
    "export function seen(names: Map<string, number>, name: string): boolean {",
    "  return name in names;",
    "}",
    "",
  ].join("\n");
  assert.deepEqual(readTypeScriptModule(source, "main.ts", false).refused, []);
  assert.match(JSON.stringify(analyzedBody(source, "asked")), /blaze_rt_dict_has/);
});

test("a map callback's object literal keeps the fields it wrote", () => {
  // `list.map((x) => ({ name: x }))` answers a list of a record the callback
  // wrote, and the declaration names no type for it: the fields are read where
  // the callback's one result is, so `entry.name` of an element is a text and
  // `.trim()` written on it is a text method.
  const source = [
    "export function f(lines: string[]): number {",
    "  return lines.map((line, at) => ({ line, at })).at(0).line.trim().length;",
    "}",
    "",
  ].join("\n");
  assert.deepEqual(readTypeScriptModule(source, "main.ts", false).refused, []);
});

test("a spread of a collection's values keeps the element's shape", () => {
  // `[...counts.values()]` is a list of the map's value type, which the
  // contract erases to the opaque reference. The spread's own shape is the
  // record, so `{ ...entry }` copies the fields the record declares.
  const source = [
    "interface Counted { value: string; count: number }",
    "interface Out { value: string; count: number; reason: string }",
    "function reason(value: string): string { return value; }",
    "export function f(counts: Map<string, Counted>): Out[] {",
    "  const repeated = [...counts.values()];",
    "  return repeated.map((entry) => ({ ...entry, reason: reason(entry.value) }));",
    "}",
    "",
  ].join("\n");
  assert.deepEqual(readTypeScriptModule(source, "main.ts", false).refused, []);
});

test("a text helper is a read, so a needle it answers may be asked twice", () => {
  // `source.startsWith(quote.repeat(3), 2)` reads the needle twice — once for
  // the length, once for the comparison. The repetition is a function of the
  // file that writes its own answer and nothing else, so asking it twice is
  // asking the same question.
  const source = [
    "export function f(source: string, quote: string): boolean {",
    "  return source.startsWith(quote.repeat(3), 2);",
    "}",
    "",
  ].join("\n");
  assert.deepEqual(readTypeScriptModule(source, "main.ts", false).refused, []);
});

test("the infinities are the float quotients they are", () => {
  // A number literal has no spelling for infinity, and the language's words for
  // it are a quotient: `1 / 0` is the positive infinity and `-1 / 0` the
  // negative one. The emitters already write a float division as one.
  const positive = analyzedBody(
    "export function f(): number { return Number.POSITIVE_INFINITY; }",
    "f",
  ) as { kind: string; value?: { k?: string; op?: string } }[];
  const negative = analyzedBody(
    "export function f(): number { return Number.NEGATIVE_INFINITY; }",
    "f",
  ) as { kind: string; value?: { k?: string; op?: string } }[];
  assert.equal(positive[0]?.value?.op, "/");
  assert.equal(negative[0]?.value?.op, "/");
  assert.equal((negative[0]?.value as { left?: { op?: string } }).left?.op, "-");
});

test("the greatest of a list folds from negative infinity", () => {
  // A list may be empty, and no element is greatest then: the fold starts at
  // `-1 / 0`, which is the negative infinity, and every element is compared
  // against it. `Math.min` starts at the positive one.
  const source = [
    "export function f(values: number[]): number {",
    "  return Math.max(...values);",
    "}",
    "",
  ].join("\n");
  const analysis = typescript.analyze(source, "main.ts");
  assert.deepEqual(readTypeScriptModule(source, "main.ts", false).refused, []);
  const helper = analysis.functions.find((declared) => declared.internal === true && declared.name.startsWith("__collect_"));
  assert.ok(helper !== undefined, "the fold is a function of the file");
  assert.deepEqual(helper.params.map((param) => param.name), ["numbers"]);
});

test("a list's length is written by a compound assignment", () => {
  // `code.length -= 2` is the list as its first `len(code) - 2` elements, the
  // same write `code.length = n` is.
  const source = [
    "export function f(code: number[]): number {",
    "  code.length -= 2;",
    "  return code.length;",
    "}",
    "",
  ].join("\n");
  assert.deepEqual(readTypeScriptModule(source, "main.ts", false).refused, []);
});

test("a body that declares undefined reads the name it declared", () => {
  // `undefined` names the absent value, and it is also a name a body may
  // declare: `const undefined: string[] = []` is a list the source writes
  // through. The name the body declared is the one it reads.
  const source = [
    "export function f(names: string[]): string[] {",
    "  const undefined: string[] = [];",
    "  for (const name of names) undefined.push(name);",
    "  return undefined;",
    "}",
    "",
  ].join("\n");
  assert.deepEqual(readTypeScriptModule(source, "main.ts", false).refused, []);
});

test("charAt is the one-character field a position starts", () => {
  const body = analyzedBody(
    "export function f(text: string): string { return text.charAt(0); }",
    "f",
  ) as { kind: string; value?: { k?: string; name?: string } }[];
  assert.equal(body[0]?.value?.k, "call");
  assert.equal(body[0]?.value?.name, "text.slice");
});

test("a constant list whose values spell brackets is a constant", () => {
  // A string whose text is `[` is a string, not a nested list. The scan read
  // the element as a bracket, so the whole list was state and `find` written on
  // it was a method of nothing.
  const source = [
    "const OPERATORS = [`+`, `-`, `(`, `)`, `[`, `]`];",
    "export function f(source: string): number {",
    "  const operator = OPERATORS.find((candidate) => source.startsWith(candidate));",
    "  return operator === undefined ? 0 : operator.length;",
    "}",
    "",
  ].join("\n");
  assert.deepEqual(readTypeScriptModule(source, "main.ts", false).refused, []);
});

test("a field of a field is written through a name of its own", () => {
  // The IR writes one field of one name, so `a.b.c = value` reads `a.b` into a
  // name first: an object is a reference, and writing through the name is
  // writing the object the source named.
  const source = [
    "class Inner { value: number; constructor(value: number) { this.value = value; } }",
    "class Outer {",
    "  inner: Inner;",
    "  constructor(inner: Inner) { this.inner = inner; }",
    "  bump(): number { this.inner.value = this.inner.value + 1; return this.inner.value; }",
    "}",
    'console.log("run");',
    "",
  ].join("\n");
  const body = JSON.stringify(analyzedBody(source, "Outer_bump"));
  assert.match(body, /"kind":"declare","name":"__field0"/, "the value the field belongs to is read once");
  assert.match(body, /"kind":"memberAssign","base":"__field0","field":"value"/, "the write goes into the name the field is");
});

test("a binary and an octal number are read as the values they name", () => {
  // The token the parser reads is the decimal digits of the value, so a number
  // written in base two or base eight is the same value everywhere after it.
  const source = [
    "export function read(): number {",
    "  return 0b1010 + 0o17;",
    "}",
    "",
  ].join("\n");
  const body = JSON.stringify(analyzedBody(source, "read"));
  assert.match(body, /"text":"10"/);
  assert.match(body, /"text":"15"/);
});

test("a constant one module exports is the value the module that imports it reads", () => {
  // A compiled function has no environment to read another module's scope from,
  // so the value crosses the link: the list another module wrote is the list
  // the importing file reads, with the elements that file wrote.
  const ir = irOf(
    "typescript",
    {
      "kinds.ts": "export const KINDS: readonly string[] = [`c`, `asm`];\n",
      "check.ts": 'import { KINDS } from "./kinds.ts";\nexport function isKind(name: string): boolean { return KINDS.includes(name); }\n',
      "main.ts": 'import { isKind } from "./check.ts";\nconsole.log(0);\n',
    },
    "main.ts",
    "isKind",
  );
  assert.match(ir, /\[text "c"\] \[text "asm"\]/, "the elements the other module wrote are the ones the list holds");
});

test("a module that offers only a constant is a library the program may import", () => {
  // A file of declarations is a library whether it declares a function, a type
  // or a value, and a value is imported the same way a function is.
  const program = programOf(
    "typescript",
    {
      "kinds.ts": "export const KINDS: readonly string[] = [`c`, `asm`];\n",
      "check.ts": 'import { KINDS } from "./kinds.ts";\nexport function isKind(name: string): boolean { return KINDS.includes(name); }\n',
      "main.ts": 'import { isKind } from "./check.ts";\nconsole.log(isKind(`c`) ? 1 : 0);\n',
    },
    "main.ts",
  );
  const kinds = program.files.find((file) => file.path === "kinds.ts");
  assert.ok(kinds !== undefined, "the module that only writes a constant is a module of the program");
});

test("an import is hoisted from wherever it is written", () => {
  // An import binds a module's names for the whole file, so it is read where it
  // is written and its names are in scope for every declaration, above it and
  // below. A file that writes a constant and then imports what its functions
  // use is the shape `semantics/ir-function.ts` has.
  const program = programOf(
    "typescript",
    {
      "base.ts": "export const base: number = 3;\n",
      "scale.ts": "export type Scale = number;\n",
      "compute.ts": [
        "const SCALE: number = 2;",
        'import type { Scale } from "./scale.ts";',
        'import { base } from "./base.ts";',
        "export function compute(): Scale { return base * SCALE; }",
        "",
      ].join("\n"),
      "main.ts": 'import { compute } from "./compute.ts";\nconsole.log(compute());\n',
    },
    "main.ts",
  );
  const compute = program.files.find((file) => file.path === "compute.ts");
  assert.ok(compute !== undefined, "the module after the constant is a module of the program");
  assert.ok(compute?.functions.compute !== undefined, "the function after the imports is read");
});

test("a method named length is a call, not the length of its receiver", () => {
  // `.length` of a name is the length of the sequence it holds; a `(` after it
  // says the class declared a method of that name, and the call is the method's.
  const phase = phaseOf(
    "typescript",
    {
      "main.ts": [
        "class Window {",
        "  width: number = 2;",
        "  length(n: number): number { return this.width + n; }",
        "  measure(): number { return this.length(1); }",
        "}",
        "export function f(): number { return new Window().measure(); }",
        'console.log("run");',
        "",
      ].join("\n"),
    },
    "main.ts",
  );
  const functions = Object.keys(phase.program.files[0]?.functions ?? {});
  assert.ok(functions.includes("Window_length"), `the method is a function of the file: ${functions.join(", ")}`);
});

test("a collection allocation may end its arguments with a comma", () => {
  // A call may end its arguments with a comma, which names nothing; a set or a
  // map allocated from a source is written the same way, and the list of pairs
  // a map is built from may end with one too.
  const phase = phaseOf(
    "typescript",
    {
      "main.ts": [
        "export function unique(xs: string[]): Set<string> {",
        "  return new Set<string>(",
        "    xs.filter((x) => x !== ``).map((x) => x),",
        "  );",
        "}",
        "export function counted(xs: string[]): Map<string, number> {",
        "  return new Map<string, number>([",
        "    [`a`, 1],",
        "  ],);",
        "}",
        'console.log("run");',
        "",
      ].join("\n"),
    },
    "main.ts",
  );
  const functions = Object.keys(phase.program.files[0]?.functions ?? {});
  assert.ok(functions.includes("unique"), `the set reads: ${functions.join(", ")}`);
  assert.ok(functions.includes("counted"), "the map reads");
});

test("hasOwnProperty over an object the file wrote is the names it asks", () => {
  // A record keyed by text is the runtime's dictionary, and the frontend asks
  // the dictionary. An object the file wrote is not a dictionary: its fields
  // are the names the source wrote, so the question is whether the key is one
  // of them — the comparison chain those names are, with the key read once.
  const ir = irOf(
    "typescript",
    {
      "main.ts": [
        "const TABLE = { alpha: 1, beta: 2 };",
        "export function has(name: string): boolean {",
        "  return Object.prototype.hasOwnProperty.call(TABLE, name);",
        "}",
        'console.log("run");',
        "",
      ].join("\n"),
    },
    "main.ts",
    "has",
  );
  assert.match(ir, /\[eq\[bool\] text local\[text\] name \[text "alpha"\]\]/);
  assert.match(ir, /\[text "beta"\]/);
});

test("hasOwnProperty reads the names of an object whose values are computed", () => {
  // The values are not constants, so the object is a value the program holds.
  // The names are still what the source wrote, and the question about the keys
  // is one the read answers without running anything.
  typescript.analyze(
    [
      "export const KEYS: Record<string, number> = { alpha: compute(), beta: compute() };",
      "function compute(): number { return 1; }",
      "export function has(name: string): boolean {",
      "  return Object.prototype.hasOwnProperty.call(KEYS, name);",
      "}",
      "",
    ].join("\n"),
    "module.ts",
  );
});

test("a conditional of an empty list and a list keeps the one element type", () => {
  const ir = irOf(
    "typescript",
    {
      "main.ts": [
        "export function f(flag: boolean): number {",
        "  return (flag ? [] : [1, 2]).length;",
        "}",
        'console.log("run");',
        "",
      ].join("\n"),
    },
    "main.ts",
    "f",
  );
  assert.match(ir, /select\[\[\]f64\]/, "the two lengths are one list type");
});

test("a push written for a value is refused, because it answers the array the name holds", () => {
  // The refusal is the lowering's rather than the parser's: the push is read,
  // and what it answers is what nothing here can give.
  assert.match(
    diagnostic(() =>
      programWithSemantics(
        "typescript",
        {
          "main.ts": [
            "export function f(): number {",
            "  const a: string[] = [];",
            "  const n = a.push(`x`);",
            "  return n;",
            "}",
            'console.log("run");',
            "",
          ].join("\n"),
        },
        "main.ts",
      ),
    ),
    /reads the array a push answers/,
  );
});

test("a push of several values is one function of the file with every value", () => {
  // Several values are one more element each, and the block is grown once for
  // all of them: the helper takes the array and the values, not one copy per
  // value.
  const analysis = typescript.analyze(
    [
      "export function f(): number {",
      "  const a: number[] = [];",
      "  a.push(1, 2, 3);",
      "  return a.length;",
      "}",
      "",
    ].join("\n"),
    "main.ts",
  );
  const helper = analysis.functions.find((declared) => declared.name === "__collect_main_0");
  assert.deepEqual(
    helper?.params.map((param) => param.name),
    ["items", "value0", "value1", "value2"],
    "the helper takes the array and one parameter per value",
  );
  const statement = ((analysis.functions[0]?.handle ?? { body: [] }) as {
    body: { kind: string; name?: string; value?: { k: string; name?: string; args?: { k: string }[] } }[];
  }).body.find((one) => one.kind === "assign");
  assert.equal(statement?.value?.k, "call");
  assert.equal(statement?.value?.name, "__collect_main_0");
  assert.deepEqual(
    statement?.value?.args?.map((argument) => argument.k),
    ["ident", "literal", "literal", "literal"],
    "the call hands the array and every value to the helper",
  );
});

test("a value pushed into a list is read at the element the list holds", () => {
  // `rows.push([])` writes an empty list into a list of lists, so the value is
  // a list of the element the outer list holds rather than a list nothing says
  // the element of. The empty list is built at that type and written by the
  // helper the push lowers to.
  const ir = irOf(
    "typescript",
    {
      "main.ts": [
        "export function f(rows: string[][]): number {",
        "  rows.push([]);",
        "  return rows.length;",
        "}",
        'console.log("run");',
        "",
      ].join("\n"),
    },
    "main.ts",
    "f",
  );
  assert.match(ir, /arrayConcat/);
  assert.match(ir, /buffer\[\[text; 0\]\] element\[text\]/);
});

test("a text split is a function of the file that walks the text", () => {
  // A text knows where a needle is and what lies between two indexes, and a
  // split is those two questions asked until the text ends: the frontend
  // writes the walk once rather than the runtime carrying another service.
  const analysis = typescript.analyze(
    [
      "export function f(s: string): number {",
      "  const parts = s.split(`-`);",
      "  return parts.length;",
      "}",
      "",
    ].join("\n"),
    "main.ts",
  );
  const helper = analysis.functions.find((declared) => declared.name === "__collect_main_0");
  assert.equal(helper?.internal, true, "the walk is not an export of the file");
  assert.deepEqual(
    helper?.params.map((param) => param.name),
    ["text", "sep"],
    "the walk takes the text and the separator",
  );
  assert.deepEqual(helper?.returns, { kind: "slice", of: { kind: "text" } });
  const call = ((analysis.functions[0]?.handle ?? { body: [] }) as {
    body: { kind: string; init?: { k: string; name?: string } }[];
  }).body[0]?.init;
  assert.equal(call?.k, "call");
  assert.equal(call?.name, "__collect_main_0");
});

test("a map and a set are one handle on the runtime's dictionary", () => {
  const analysis = typescript.analyze(
    [
      "export function g(): number {",
      "  const m = new Map<string, number>();",
      "  m.set(`a`, 1);",
      "  const s = new Set<string>();",
      "  s.add(`b`);",
      "  return m.get(`a`);",
      "}",
      "",
    ].join("\n"),
    "main.ts",
  );
  const body = ((analysis.functions[0]?.handle ?? { body: [] }) as {
    body: { kind: string; init?: { k: string; name?: string }; value?: { k: string; name?: string } }[];
  }).body;
  assert.equal(body[0]?.init?.name, "blaze_rt_dict_new", "a map is the dictionary the runtime lays out");
  assert.equal(body[1]?.value?.name, "blaze_rt_dict_set", "a set on a map is the dictionary's write");
  assert.equal(body[2]?.init?.name, "blaze_rt_dict_new", "a set is the same dictionary");
  // A lookup is guarded, because an absent key has no `undefined` to answer.
  const result = body[4]?.value as unknown as { k: string; condition?: { name?: string } };
  assert.equal(result?.k, "conditional");
  assert.equal(result?.condition?.name, "blaze_rt_dict_has");
});

test("a collection written clear is a new, empty dictionary", () => {
  // `m.clear()` is a statement, and the runtime holds no dictionary call that
  // empties one in place: the handle a name holds is replaced by a new, empty
  // dictionary, which is the one the clear asks for. The entry after it reads
  // the handle the statement wrote.
  const ir = irOf(
    "typescript",
    {
      "main.ts": [
        "export function f(m: Map<string, number>): number {",
        "  m.clear();",
        "  return m.size;",
        "}",
        'console.log("run");',
        "",
      ].join("\n"),
    },
    "main.ts",
    "f",
  );
  assert.match(ir, /set m = \[call\[f64\] blaze_rt_dict_new \[\]/);
  assert.match(ir, /return \[call\[f64\] blaze_rt_dict_len/);
});

test("a file opens with the interpreter that runs it", () => {
  // `#!/usr/bin/env node` is the host's line rather than the program's, and the
  // entry source is the one an interpreter runs: a source that opens with it is
  // read from the line after it.
  const analysis = typescript.analyze(
    ["#!/usr/bin/env node", "export function f(): number { return 1; }", ""].join("\n"),
    "cli.ts",
  );
  assert.equal(analysis.functions[0]?.name, "f");
});

test("a map states a type that names a type of its own", () => {
  // `Map<string, Set<string>>` closes with one `>>` token, which is the token
  // the shift operators are written with. The count of open angles says how
  // many of them the token closes, so the collection is read rather than the
  // map falling back to its default and the `<` being read as a comparison.
  const body = analyzedBody(
    [
      "class Node { name: string; constructor(name: string) { this.name = name; } }",
      "export function g(): number {",
      "  const m = new Map<Node, Set<string>>();",
      "  const s = new Set<Node>();",
      "  s.add(new Node(`a`));",
      "  m.set(new Node(`b`), s);",
      "  return m.size;",
      "}",
      "",
    ].join("\n"),
    "g",
  ) as { kind: string; init?: { k: string; name?: string } }[];
  assert.equal(body[0]?.init?.name, "blaze_rt_dict_new", "a map of sets is the dictionary the runtime lays out");
  assert.equal(body[1]?.init?.name, "blaze_rt_dict_new", "and so is the set it holds");
});

test("an entry read out of a map is held at the declaration its value names", () => {
  // The dictionary's type can spell only the opaque reference, so a field read
  // of an entry was a read through a reference nothing named: `item.names` was
  // `any`, and the `join` written on it was a method of nothing. What `get`
  // and `values()` answer carries the fields the annotation's declaration
  // wrote, so the member chain after them is read.
  const phase = phaseOf(
    "typescript",
    {
      "main.ts": [
        "interface Item { names: string[] }",
        "export function listed(table: Map<string, Item>, key: string): string {",
        "  const one = table.get(key);",
        '  let out = one === undefined ? "" : one.names.join(",");',
        '  for (const item of table.values()) out += item.names.join(",");',
        "  return out;",
        "}",
        'console.log("run");',
        "",
      ].join("\n"),
    },
    "main.ts",
  );
  const ir = printSemanticFunction(semanticsOf(phase)["listed"]);
  assert.match(ir, /call __collect_/, "the join on an entry's field is the helper that joins a list");
});

test("a record keyed by text is the dictionary a map is", () => {
  // `Record<string, V>` is the same handle `Map<string, V>` is: what the
  // contract can spell is the handle, and the key and value stay beside it. A
  // read by key is the dictionary's read, guarded so an absent key answers the
  // zero of the value rather than the NaN the dictionary uses.
  const ir = irOf(
    "typescript",
    { "main.ts": "export function read(r: Record<string, number>, k: string): number { return r[k]; }\nconsole.log(`run`);\n" },
    "main.ts",
    "read",
  );
  assert.match(ir, /blaze_rt_dict_has/);
  assert.match(ir, /blaze_rt_dict_get/);
});

test("an object literal at a record is the dictionary its type names", () => {
  // A field the literal names is one entry of the dictionary, written by the
  // helper the collection pair reader builds.
  const body = analyzedBody(
    "export function f(): number { const t: Record<string, number> = { a: 1, b: 2 }; return t[`a`]; }",
    "f",
  );
  const declared = body[0] as { init?: { k: string; name?: string } };
  assert.equal(declared.init?.k, "call");
  assert.match(declared.init?.name ?? "", /^__collect_/);
});

test("a map is keyed by a number, and by a value a key cannot be", () => {
  // A key is a text, a reference or a number: a number reaches the runtime as
  // the number it is. A sequence is not a key, because it has no value the
  // dictionary could compare.
  const analysis = typescript.analyze(
    "export function g(): number {\n  const s = new Set<number>();\n  s.add(1);\n  return s.size;\n}\n",
    "main.ts",
  );
  const body = ((analysis.functions.find((entry) => entry.name === "g")?.handle ?? { body: [] }) as {
    body: { value?: { name?: string } }[];
  }).body;
  assert.equal(body[1]?.value?.name, "blaze_rt_dict_set_numkey", "a number is written under a number key");
  assert.match(
    diagnostic(() =>
      typescript.analyze(
        "export function g(): number {\n  const s = new Set<number[]>();\n  return s.size;\n}\n",
        "main.ts",
      ),
    ),
    /a Set here is keyed by text, not by/,
  );
});

test("a map holds a reference, and a set keys by the reference itself", () => {
  const analysis = typescript.analyze(
    [
      "class Box { value: number; constructor(value: number) { this.value = value; } }",
      "export function g(): number {",
      "  const m = new Map<string, Box>();",
      "  const a = new Box(1);",
      "  m.set(`a`, a);",
      "  const found = m.get(`a`);",
      "  const s = new Set<Box>();",
      "  s.add(a);",
      "  return (s.has(a) ? 1 : 0) + found.value;",
      "}",
      "",
    ].join("\n"),
    "main.ts",
  );
  const body = ((analysis.functions.find((entry) => entry.name === "g")?.handle ?? { body: [] }) as {
    body: {
      kind: string;
      init?: { k: string; condition?: { name?: string }; then?: { name?: string } };
      value?: { k: string; name?: string; left?: { name?: string; condition?: { left?: { name?: string } } } };
    }[];
  }).body;
  assert.equal(body[2]?.value?.name, "blaze_rt_dict_set_ref", "a reference value is written as one");
  assert.equal(body[3]?.init?.then?.name, "blaze_rt_dict_get_ref", "a reference value is read as one");
  assert.equal(body[5]?.value?.name, "blaze_rt_dict_set_refkey", "a set of references keys by the handle");
  assert.equal(
    body[6]?.value?.left?.condition?.left?.name,
    "blaze_rt_dict_has_refkey",
    "and asks for the handle it was given",
  );
});

test("an array pattern binds each name at the element type of the value", () => {
  // `const [, head, argument] = parts` names elements rather than the array,
  // so each name is the text the elements are: `argument.trim()` is a text
  // method, and the gap names the position the next name is read at.
  const source = [
    "export function read(parts: string[]): string {",
    "  const [, head, argument] = parts;",
    "  return argument.trim() + head;",
    "}",
    "",
  ].join("\n");
  const body = JSON.stringify(analyzedBody(source, "read"));
  assert.match(body, /"k":"index"/);
  assert.match(body, /text\.trim/);
  const contract = contractOfExport(source, "read");
  assert.deepEqual(
    contract.requires,
    ["parts != null", "len(parts) >= (1 + 1)", "len(parts) >= (2 + 1)"],
    "the gap counts as a position",
  );
});

test("an array pattern reads a value that is not an array literal", () => {
  // The value is one a call answered, read once into a name of the pattern's
  // own: each name is an element of it at the type the list holds.
  const source = [
    "function pair(): string[] { return [`left`, `right`]; }",
    "export function read(): string {",
    "  const [left, right] = pair();",
    "  return left.trim() + right;",
    "}",
    "",
  ].join("\n");
  const body = JSON.stringify(analyzedBody(source, "read"));
  assert.match(body, /"k":"index"/, "each name is an element of the value");
  assert.match(body, /text\.trim/, "the element is the text the list holds");
});

test("a destructured field is the type the function's result declares", () => {
  // An interface is an opaque reference to the contract, so the declared result
  // of `pair()` is erased by the time its call is read. The shape of the
  // declaration is what keeps `left` a text, and it is what `left.trim()` is a
  // method of.
  const source = [
    "interface Pair { left: string; right: string }",
    "function pair(): Pair { return { left: ` a `, right: `b` }; }",
    "export function read(): string {",
    "  const { left, right } = pair();",
    "  return left.trim() + right;",
    "}",
    "",
  ].join("\n");
  const body = JSON.stringify(analyzedBody(source, "read"));
  assert.match(body, /"name":"left"/);
  assert.match(body, /"name":"right"/);
  assert.match(body, /text\.trim/);
});

test("a destructured field of an object literal is the value written for it", () => {
  const source = [
    "export function read(): string {",
    "  const { text } = { text: ` a ` };",
    "  return text.trim();",
    "}",
    "",
  ].join("\n");
  const body = JSON.stringify(analyzedBody(source, "read"));
  assert.match(body, /"name":"text"/);
  assert.match(body, /text\.trim/);
});

test("a map entry read through a gap binds the value at its position", () => {
  const source = [
    "export function read(m: Map<string, string>): string {",
    "  let out = ``;",
    "  for (const [, value] of m) { out += value.trim(); }",
    "  return out;",
    "}",
    "",
  ].join("\n");
  const body = JSON.stringify(analyzedBody(source, "read"));
  assert.match(body, /"name":"value"/);
  assert.match(body, /text\.trim/);
});

test("a list walked by its entries binds the index and the element", () => {
  // An entry of a list is a position and the element written there. Neither is
  // an element a typed array holds, so the loop walks the list by index and the
  // body reads the index as a number and the element as a text.
  const source = [
    "export function read(names: string[]): string {",
    "  let out = ``;",
    "  for (const [index, name] of names.entries()) { out += String(index) + name.trim(); }",
    "  return out;",
    "}",
    "",
  ].join("\n");
  const body = JSON.stringify(analyzedBody(source, "read"));
  assert.match(body, /"name":"index"/);
  assert.match(body, /"name":"name"/);
  assert.match(body, /text\.trim/);
});

test("an entry of a list names no part a list does not have", () => {
  const source = [
    "export function read(names: string[]): number {",
    "  let total = 0;",
    "  for (const [index, name, other] of names.entries()) { total += index; }",
    "  return total;",
    "}",
    "",
  ].join("\n");
  assert.match(
    diagnostic(() => typescript.analyze(source, "module.ts")),
    /an entry of a list is an index and an element/,
  );
});

test("a list built from the result of a call holds the call's elements", () => {
  // The spread piece is a call, and what a call answers is recorded where it is
  // written rather than read back from the text: `resultType` cannot see the
  // list the call answers, so the literal records the element type it joined.
  // The callback of the method written after the literal reads a text, which is
  // the element the joined list holds.
  const source = [
    "export function read(rest: string[]): string[] {",
    "  return [...rest.map((line) => line)].map((line) => line.trim());",
    "}",
    "",
  ].join("\n");
  const analysis = typescript.analyze(source, "module.ts");
  const walkers = analysis.functions.filter((entry) => entry.name.startsWith("__closure_") && !entry.name.includes("_code_"));
  const second = walkers[1]?.handle as { params: { name: string; type: unknown }[] } | undefined;
  assert.ok(second !== undefined, "the second callback is a function of the file");
  assert.deepEqual(second.params[0]?.type, { kind: "text" });
});

test("a value asserted as a set is read as the collection it names", () => {
  // A map whose value is a set answers a handle, and the assertion is what says
  // what the handle holds: `has`, `add` and `size` after it are the dictionary's
  // own methods rather than methods of a class nothing declared.
  const source = [
    "export function read(groups: Map<string, Set<string>>, name: string): boolean {",
    "  const found = groups.get(name) as Set<string>;",
    "  found.add(`x`);",
    "  return found.has(`y`) && found.size > 0;",
    "}",
    "",
  ].join("\n");
  const body = JSON.stringify(analyzedBody(source, "read"));
  assert.match(body, /blaze_rt_dict_has/);
  assert.match(body, /blaze_rt_dict_len/);
});

test("a value asserted as a list is joined by the elements the assertion names", () => {
  const source = [
    "export function read(record: { names: unknown }): string {",
    "  return (record.names as string[]).join(`,`);",
    "}",
    "",
  ].join("\n");
  const body = JSON.stringify(analyzedBody(source, "read"));
  assert.match(body, /"name":"__collect_/);
});

test("typeof of a value the read cannot type is asked at run time", () => {
  // A value the module graph has not linked is a reference with no name, and
  // the type cannot answer for it: the answer is the kind the runtime holds.
  // Folding it to "object" compiled no arm of the branch at all.
  const source = [
    "export function read(value: unknown): string {",
    "  if (typeof value === `string`) return `text`;",
    "  return `other`;",
    "}",
    "",
  ].join("\n");
  const body = JSON.stringify(analyzedBody(source, "read"));
  assert.match(body, /JSON\.typeof/);
});

test("a test of a value settles what the branch reads it as", () => {
  // Past the guard the value is a text, so the body reads a text method: the
  // narrowing is what makes the branch typeable at all.
  const source = [
    "export function read(entry: unknown): string {",
    "  if (typeof entry !== `string`) return ``;",
    "  return entry.trim();",
    "}",
    "",
  ].join("\n");
  const body = JSON.stringify(analyzedBody(source, "read"));
  assert.match(body, /text\.trim/);
});

test("a name spelled type holds a value like any other name", () => {
  // `type` is not a word the language keeps: only a statement that writes a
  // type alias declares a type, and `type = value` reads a value.
  const source = [
    "export function read(entry: { type: string }): string {",
    "  let type = entry.type;",
    "  if (type === `x`) type = `y`;",
    "  return type;",
    "}",
    "",
  ].join("\n");
  const body = JSON.stringify(analyzedBody(source, "read"));
  assert.match(body, /"name":"type"/);
});

test("a refused read still answers the imports it did read", () => {
  // A measurement of a tree needs what a refused file did say: its imports are
  // the imports it wrote, and the rest of the graph resolves against them.
  // `analyze` is this read plus the refusal it answered.
  const source = [
    'import { TABLE } from "./lib.ts";',
    "",
    "export function kept(): number {",
    "  let total = 0;",
    "  for (const value of Object.values(TABLE)) total += value;",
    "  return total;",
    "}",
    "",
    "export function refused(): number {",
    "  return new Date().getTime();",
    "}",
    "",
  ].join("\n");
  const read = readTypeScriptModule(source, "main.ts");
  assert.equal(read.analysis.path, "main.ts");
  assert.deepEqual(
    read.analysis.imports.map((entry) => [entry.specifier, entry.names]),
    [["./lib.ts", ["TABLE"]]],
    "the imports are the imports the file wrote, whatever else it refused",
  );
  assert.ok(read.refused.length > 0, "the file is refused");
  assert.ok(read.count >= read.refused.length, "the count is the whole number, not the listed one");

  // The strict read is the same read followed by the refusal it answered.
  assert.throws(
    () => frontendFor("typescript").analyze(source, "main.ts"),
    (error: unknown) => error instanceof CompilerError && error.message.includes(`${read.count} constructs`),
  );
});

test("an inline object type keeps a field a modifier is written in front of", () => {
  // `readonly` states what a body may write, not the name of the field. The
  // record `{ readonly applied: number }` has a field named `applied`, and
  // reading the modifier as the name dropped it — so a union of shapes written
  // the way the compiler's own sources write one had no fields at all, and
  // `"applied" in outcome` asked a value whose type wrote down nothing.
  const ir = irOf(
    "typescript",
    {
      "main.ts": [
        "type Outcome =",
        "  | { readonly applied: number }",
        "  | { readonly refused: string };",
        "export function copy(outcome: Outcome): Outcome {",
        "  return { ...outcome };",
        "}",
        'console.log("run");',
        "",
      ].join("\n"),
    },
    "main.ts",
    "copy",
  );
  assert.match(ir, /field applied/, "the field the modifier is written in front of is laid out");
  assert.match(ir, /load_field\[[^\]]+\] local\[[^\]]+\] outcome [^\]]+ applied/, "and the spread reads it");
});

test("a method's result is the type its signature writes, whatever form it writes", () => {
  // A class member's return type was read as one leading name: a result written
  // as an object type — `make(): { name: string; size: number }` — became
  // `any`, so `{ ...factory.make() }` had no fields to copy and the member
  // chain after the call asked a value nothing typed. The annotation is read
  // as the text it is, and the shape it names is kept beside the call.
  const ir = irOf(
    "typescript",
    {
      "main.ts": [
        "class Factory {",
        "  make(): { name: string; size: number } {",
        '    return { name: "x", size: 1 };',
        "  }",
        "}",
        "export function copy(factory: Factory): number {",
        "  const made = factory.make();",
        "  const again = { ...made };",
        "  return again.size;",
        "}",
        'console.log("run");',
        "",
      ].join("\n"),
    },
    "main.ts",
    "copy",
  );
  assert.match(ir, /field name/, "the result's fields are laid out");
  assert.match(ir, /load_field\[[^\]]+\] local\[[^\]]+\] made [^\]]+ name/, "the spread copies them");
});

test("a call of a field the declaration types as a function is a call through the value it holds", () => {
  // `write` is a field of `Sink` whose type is a function, not a method of a
  // class: `sink.write(text)` calls the value the field holds, and the call is
  // written as the invocation it is rather than refused as an unknown method.
  const ir = irOf(
    "typescript",
    {
      "main.ts": [
        "interface Sink { write(text: string): void }",
        "export function greet(sink: Sink): void {",
        '  sink.write("hello");',
        "}",
        'greet({ write: (text: string): void => { console.log(text); } });',
        "",
      ].join("\n"),
    },
    "main.ts",
    "greet",
  );
  assert.match(
    ir,
    /call\[void\] through \[load_field\[ref<any>\] local\[ref<any>\] sink [^\]]+ write\]/,
    "the call is made through the value the field holds",
  );
});

test("a top-level constant is read at the type its declaration writes", () => {
  // The value is a list of calls, which is not a constant expression the file
  // wrote out. The annotation is what says the list holds records, so `map`
  // written after the name walks elements whose fields it can read.
  const source = [
    "interface Entry { name: string; size: number }",
    "function entry(name: string, size: number): Entry { return { name, size }; }",
    "const TABLE: readonly Entry[] = [entry(`a`, 1), entry(`b`, 2)];",
    "export function total(): number {",
    "  return TABLE.map((one) => one.size).length;",
    "}",
    "",
  ].join("\n");
  const read = readTypeScriptModule(source, "main.ts", false);
  assert.deepEqual(read.refused, [], "the name is read at the list its declaration writes");
});

test("a word the keyword table does not carry is a name, not a refusal", () => {
  // Every object inherits `constructor` and `toString`, so a lookup that walked
  // the prototype found a function there and refused an assignment written to
  // the name `constructor` as the keyword.
  const source = [
    "export function bump(): number {",
    "  let constructor = 1;",
    "  constructor = constructor + 1;",
    "  return constructor;",
    "}",
    "",
  ].join("\n");
  const read = readTypeScriptModule(source, "main.ts", false);
  assert.deepEqual(read.refused, [], "`constructor` is a name the language allows");
});

test("a spread of a dictionary is refused, not read as an empty record", () => {
  // A dictionary is keyed by a value the program computes, so its fields are
  // not the fields a record of fields has: copying none of them is an object
  // that lost every entry. The read refuses it rather than answering `{}`.
  const source = [
    "export function copy(table: Record<string, string>): Record<string, string> {",
    "  return { ...table };",
    "}",
    "",
  ].join("\n");
  const read = readTypeScriptModule(source, "main.ts", false);
  assert.equal(read.count, 1);
  assert.match(read.refused[0]?.message ?? "", /an object spread reads a constant object/);
});

test("a table of truths is a constant the file wrote, and a spread copies it", () => {
  // A boolean written out is a constant, so a table of them is the file's
  // value rather than state: `{ ...RESERVED }` is the entries it wrote, not a
  // refused spread.
  const source = [
    "const RESERVED: Record<string, true> = { alpha: true, beta: true };",
    "export function copy(): Record<string, true> {",
    "  return { ...RESERVED };",
    "}",
    "",
  ].join("\n");
  const read = readTypeScriptModule(source, "main.ts", false);
  assert.deepEqual(read.refused, [], "the table is a constant the spread copies");
});

test("a class method's default is read at the type its parameter states", () => {
  // The wrapper a shorter arity calls fills the default where the call was
  // made, and the parameter's annotation is what an empty list there holds —
  // the same answer a free function's declaration gives.
  const source = [
    "class Names {",
    "  count(types: string[] = [], renames: readonly string[] = []): number {",
    "    return types.length + renames.length;",
    "  }",
    "}",
    "export function size(names: Names): number { return names.count(); }",
    "",
  ].join("\n");
  const read = readTypeScriptModule(source, "main.ts", false);
  assert.deepEqual(read.refused, [], "the defaults are lists of the elements the parameters name");
});

test("a set or a map held in a dictionary answers its own questions", () => {
  // A set is one handle, so a dictionary holds it as the number it is; what a
  // key answers is the collection of its own, and `has` written after it is the
  // dictionary's question about that collection.
  const source = [
    "export function found(sets: Map<string, Set<string>>, key: string, name: string): boolean {",
    "  return sets.get(key).has(name);",
    "}",
    "export function nested(tables: Map<string, Map<string, number>>, a: string, b: string): number {",
    "  return tables.get(a).get(b);",
    "}",
    "",
  ].join("\n");
  const read = readTypeScriptModule(source, "main.ts", false);
  assert.deepEqual(read.refused, []);
});

test("an exported constant offers the type its declaration writes", () => {
  // The value is built by a call, so it is not a constant expression the file
  // wrote out. The annotation is still the file's statement about the name,
  // and it is what a module that imports it reads it at.
  const source = [
    "export interface Entry { name: string }",
    "function entry(name: string): Entry { return { name }; }",
    "export const TABLE: readonly Entry[] = [entry(`a`)];",
    "",
  ].join("\n");
  const read = readTypeScriptModule(source, "main.ts", false);
  const shapes = read.analysis.valueShapes;
  assert.ok(shapes !== undefined, "the declaration offers the type it writes");
  assert.ok(shapes.has("TABLE"), "the exported name is the one offered");
});

test("an argument is read at the type and the shape the declaration states", () => {
  // A parameter declared as an interface is the opaque reference in the
  // contract, so the shape the annotation names is what says what an object
  // literal written there holds: `args: []` is a list of expressions only if
  // the field's declaration says so.
  const union = [
    "type A = { k: `a`; args: string[] };",
    "type B = { k: `b`; name: string };",
    "type Expr = A | B;",
    "function take(value: Expr): number { return 1; }",
    "export function f(): number { return take({ k: `a`, args: [] }); }",
    "",
  ].join("\n");
  assert.deepEqual(readTypeScriptModule(union, "main.ts", false).refused, []);

  // A name bound to an arrow is not a declaration the module carries, and the
  // call of it reads the arrow's own parameters, which is where the type of an
  // argument comes from.
  const arrow = [
    "interface Entry { kind: string; args: string[] }",
    "export function f(): number {",
    "  const take = (value: Entry): number => value.args.length;",
    "  return take({ kind: `call`, args: [] });",
    "}",
    "",
  ].join("\n");
  assert.deepEqual(readTypeScriptModule(arrow, "main.ts", false).refused, []);
});

test("a method and a constructor read their arguments at their parameters", () => {
  const source = [
    "interface Input { tags: string[] }",
    "class Reader {",
    "  constructor(private input: Input) {}",
    "  count(value: Input): number { return value.tags.length; }",
    "  run(): number { return this.count({ tags: [] }); }",
    "}",
    "export function f(): number { return new Reader({ tags: [] }).run(); }",
    "",
  ].join("\n");
  const read = readTypeScriptModule(source, "main.ts", false);
  assert.deepEqual(read.refused, [], "the constructor and the method state what their arguments hold");
});

test("a type a function body declares is in scope for that body and no other", () => {
  // `type Expanded = { … }` written inside a body is not a declaration of the
  // module: the body's own annotations resolve it, and the next body does not
  // see it.
  const source = [
    "export function inside(): number {",
    "  type Expanded = { value: string; pre: string[] };",
    "  const one: Expanded = { value: `a`, pre: [] };",
    "  return one.pre.length;",
    "}",
    "export function outside(): number {",
    "  const one: Expanded = { value: `a`, pre: [] };",
    "  return 1;",
    "}",
    "",
  ].join("\n");
  const read = readTypeScriptModule(source, "main.ts", false);
  assert.equal(read.refused.length, 1, "the body that did not declare the name still waits for its element type");
  assert.match(read.refused[0]?.message ?? "", /an empty array needs the type of its elements/);
});

test("a conditional's arms share the type and the shape the other arm has", () => {
  // `c ? { value, pre: [] } : expand(x)` reads the literal at what the call
  // answers: the call's declaration states the record, and the empty list in
  // the arm that has no type of its own is settled by it.
  const source = [
    "interface Expanded { value: string; pre: string[] }",
    "export function f(start: string | null): number {",
    "  const expand = (one: string): Expanded => ({ value: one, pre: [] });",
    "  const one = start === null ? { value: ``, pre: [] } : expand(start);",
    "  return one.pre.length;",
    "}",
    "",
  ].join("\n");
  const read = readTypeScriptModule(source, "main.ts", false);
  assert.deepEqual(read.refused, [], "the arm without a type is read at the arm that has one");
});

test("a view of a block reads and writes the bytes of it", () => {
  // A typed array is a block, and `bytes.buffer` is the block itself: a
  // `DataView` over one is the same bytes, so a write of a chosen width is the
  // stores that write it and a read is the sum the bytes are.
  const source = [
    "export function f(): number {",
    "  const bytes = new Uint8Array(8);",
    "  const view = new DataView(bytes.buffer);",
    "  view.setUint32(0, 7, true);",
    "  bytes.set([1, 2], 4);",
    "  return view.getUint32(0, true) + bytes.byteLength;",
    "}",
    "",
  ].join("\n");
  assert.deepEqual(readTypeScriptModule(source, "main.ts", false).refused, []);

  // A view of part of a block is not the block: an offset or a length the
  // stores are not checked against would be a write past the view.
  const partial = [
    "export function f(bytes: Uint8Array): number {",
    "  const view = new DataView(bytes.buffer, 1, 4);",
    "  return view.getUint8(0);",
    "}",
    "",
  ].join("\n");
  const read = readTypeScriptModule(partial, "main.ts", false);
  assert.match(read.refused[0]?.message ?? "", /a view of part of a buffer is not part of the subset/);
});

test("a sixty-four bit view of a block is a store and a load of a whole number", () => {
  // Eight bytes are a whole number of sixty-four bits, and the language writes
  // one with `BigInt(x)`: the value is the machine word the number is, which is
  // what a use of it as a `bigint` converts it to.
  const source = [
    "export function f(): number {",
    "  const bytes = new Uint8Array(16);",
    "  const view = new DataView(bytes.buffer);",
    "  const base = 4;",
    "  const big = BigInt(base) * 3n + 5n;",
    "  view.setBigUint64(0, big, true);",
    "  return Number(view.getBigUint64(0, true));",
    "}",
    "",
  ].join("\n");
  assert.deepEqual(readTypeScriptModule(source, "main.ts", false).refused, []);
});

test("a spread of a conditional writes a reference field only when it holds", () => {
  // `...(c ? {} : { tail })` writes `tail` on one arm and leaves the field at
  // its zero on the other. For a reference the zero is the null reference,
  // which is what the language's `undefined` is: the field is absent when the
  // condition holds, and reading it asks the null test the read already writes.
  const source = [
    "interface Handle { name: string; tail?: Box }",
    "class Box { value: number = 1; }",
    "export function f(c: boolean, tail: Box): number {",
    "  const one: Handle = { name: `a`, ...(c ? {} : { tail }) };",
    "  return one.name.length;",
    "}",
    "",
  ].join("\n");
  assert.deepEqual(readTypeScriptModule(source, "main.ts", false).refused, []);

  // The zero of a text is a value a program may have meant, so a text field is
  // not read as absent.
  const text = [
    "interface Handle { name: string; label?: string }",
    "export function f(c: boolean, label: string): number {",
    "  const one: Handle = { name: `a`, ...(c ? {} : { label }) };",
    "  return one.name.length;",
    "}",
    "",
  ].join("\n");
  assert.match(
    readTypeScriptModule(text, "main.ts", false).refused[0]?.message ?? "",
    /an object spread reads a constant object/,
  );
});

test("a spread copies the fields of the record its value names", () => {
  // The shape a value is held at keeps the name of the record its declaration
  // writes, and a spread copies the fields that record has: a field of a value
  // the source read is spread field by field, as a value the file wrote out as
  // a constant already is.
  const source = [
    "interface Block { id: number; statements: number[] }",
    "interface Placed { block: Block; statement: number }",
    "export function copy(placed: Placed): Block {",
    "  return { ...placed.block };",
    "}",
    "",
  ].join("\n");
  assert.deepEqual(readTypeScriptModule(source, "main.ts", false).refused, []);

  // A dictionary has no fields to copy: what it holds is written by name, and a
  // spread of one would have to guess them.
  const dictionary = [
    "export function copy(all: Record<string, number>): number {",
    "  const one = { ...all };",
    "  return 1;",
    "}",
    "",
  ].join("\n");
  assert.match(
    readTypeScriptModule(dictionary, "main.ts", false).refused[0]?.message ?? "",
    /an object spread reads a constant object/,
  );
});

test("a function writes to the output and to the error stream, and ends a line only where the source does", () => {
  // `process.stdout.write` writes where it is, and `console.log` ends the line
  // after it; the error stream is the runtime's own, and a function writes
  // there through the call the runtime carries.
  const source = [
    "export function f(text: string): void {",
    "  process.stdout.write(text);",
    "  process.stderr.write(text);",
    "  console.log(text);",
    "}",
    "",
  ].join("\n");
  assert.deepEqual(readTypeScriptModule(source, "main.ts", false).refused, []);
  const ir = irOf("typescript", { "main.ts": `${source}\nf(\"a\");\n` }, "main.ts", "f");
  assert.match(ir, /print_text local\[text\] text @2/, "the write is the text and no newline");
  assert.ok(!/print_newline @2/.test(ir), "the write does not end the line");
  assert.match(ir, /print_newline @4/, "the console ends it");
  assert.match(ir, /call\[void\] process\.stderr\.write/, "the error stream is the runtime's call");
});

test("a function reads the monotonic clock as the whole nanoseconds it measures a duration in", () => {
  // `process.hrtime.bigint()` is the runtime's own clock. The reading is a
  // whole number of nanoseconds rather than a fraction of something, so two
  // readings of it differ by a duration the source can keep.
  const source = [
    "export function measure(): number {",
    "  const started = process.hrtime.bigint();",
    "  const finished = process.hrtime.bigint();",
    "  return finished >= started ? Number(finished - started) : -1;",
    "}",
    "",
  ].join("\n");
  assert.deepEqual(readTypeScriptModule(source, "main.ts", false).refused, []);
  const ir = irOf("typescript", { "main.ts": `${source}\nmeasure();\n` }, "main.ts", "measure");
  assert.match(ir, /call\[i64\] process\.hrtime\.bigint/, "the reading is the runtime's own call");
  assert.match(ir, /ge\[bool\] i64 local\[i64\] finished local\[i64\] started/, "two readings compare as whole numbers");
  assert.match(ir, /sub\[i64\]/, "the duration is the difference of two whole numbers");
});

test("an element a list's entries loop binds is the record its declaration names", () => {
  // `for (const [index, fixup] of fixups.entries())` binds each element of the
  // list. The element's type is the one the list declares, and the list names
  // `Fixup`; the record is what the body reads, so spreading the element writes
  // the fields the interface wrote rather than being refused as no object at
  // all.
  const source = [
    "interface Fixup { at: number; wide: boolean }",
    "export function widen(fixups: Fixup[], from: number, bytes: number): Fixup {",
    "  let moved: Fixup = { at: 0, wide: false };",
    "  for (const [index, fixup] of fixups.entries()) {",
    "    if (fixup.at > from) moved = { ...fixup, at: fixup.at - bytes };",
    "  }",
    "  return moved;",
    "}",
    "",
  ].join("\n");
  assert.deepEqual(readTypeScriptModule(source, "main.ts", false).refused, []);
  const ir = irOf("typescript", { "main.ts": `${source}widen([], 0, 1);\n` }, "main.ts", "widen");
  assert.match(ir, /new_object\[ref<Object1>\] Object1 at \[sub\[f64\]/, "the field the spread writes over is the written one");
  assert.match(ir, /wide \[load_field\[f64\] local\[ref<any>\] fixup Object1 wide\]/, "the field the spread copies is read from the element");
});

test("a value a map holds is the record its type names, so its fields and its spread are read", () => {
  // `for (const [name, item] of items)` reads the value a map holds. The type
  // the declaration spells is the reference, and the record is the shape the
  // declaration named: the loop binds the record, so the fields are read where
  // they are written and a spread writes the other fields through.
  const source = [
    "interface Item { at: number; wide: boolean }",
    "export function widen(items: Map<string, Item>): number {",
    "  const first: Item = { at: 0, wide: false };",
    "  let total = first.at;",
    "  for (const [name, item] of items) {",
    "    const copy: Item = { ...item, at: item.at + 1 };",
    "    total += copy.at;",
    "  }",
    "  return total;",
    "}",
    "",
  ].join("\n");
  assert.deepEqual(readTypeScriptModule(source, "main.ts", false).refused, []);
  const ir = irOf("typescript", { "main.ts": `${source}\nconsole.log("run");\n` }, "main.ts", "widen");
  assert.match(ir, /at \[add\[f64\] \[load_field\[f64\] local\[ref<any>\] item Object1 at\] const\[f64\] 1\]/, "the field the spread writes is read from the element");
  assert.match(ir, /wide \[load_field\[f64\] local\[ref<any>\] item Object1 wide\]/, "the field the spread copies is read from the element");
});

test("Extract and Exclude read the type they name the members of", () => {
  // `Extract<Loop, { kind: string }>` names the members of `Loop`, and the type
  // reader keeps a union of records as one record whose members' fields are all
  // there, the ones only a member writes optional. What a value typed through
  // it holds is therefore the union it names the members of, which is what the
  // reads behind it are written at.
  const source = [
    "interface Counted { kind: string; from: number; marks?: string[] }",
    "interface Each { kind: string; of: string }",
    "type Loop = Counted | Each;",
    "type NotEach = Exclude<Loop, Each>;",
    "export function marks(loop: Extract<Loop, { kind: string }>): number {",
    "  const counted: Counted = { kind: `counted`, from: 1, marks: [] };",
    "  const marks = loop.marks ?? [];",
    "  return marks.length + counted.from;",
    "}",
    "export function from(loop: NotEach): number {",
    "  return loop.from;",
    "}",
    "",
  ].join("\n");
  assert.deepEqual(readTypeScriptModule(source, "main.ts", false).refused, []);
  const ir = irOf("typescript", { "main.ts": `${source}\nconsole.log("run");\n` }, "main.ts", "marks");
  assert.match(ir, /load_field\[\[\]text\] local\[ref<any>\] loop Object1 marks/, "a member's field is read through the type Extract names");
  assert.match(ir, /coalesce\[\[\]text\] [^\n]* \[buffer\[\[text; 0\]\] element\[text\] 0 \]/, "the empty list takes the member's element type");
  const excluded = irOf("typescript", { "main.ts": `${source}\nconsole.log("run");\n` }, "main.ts", "from");
  assert.match(excluded, /load_field\[f64\] local\[ref<any>\] loop Object1 from/, "Exclude reads the type whose members it names");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { frontendFor } from "../semantics/frontend.ts";
import { pythonFrontend } from "../semantics/python.ts";
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
  assert.equal(analysis.functions[0]?.params[1]?.type.kind, "ref", "a generic annotation is an opaque reference");
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
    body: { kind: string; value?: { k: string; op?: string; left?: unknown; then?: unknown; otherwise?: { k: string } } }[];
  }).body;
  const value = body[0]?.value;
  assert.equal(value?.k, "binary");
  assert.equal(value?.op, "??");
  const guard = value?.left as { k: string; condition?: { op?: string }; then?: { k: string }; otherwise?: { k: string } };
  assert.equal(guard.k, "conditional");
  assert.equal(guard.condition?.op, "!=");
  assert.equal(guard.otherwise?.k, "null");
  assert.equal((guard.then as { k?: string }).k, "conditional", "the second ?. is a second guard");
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

test("a renamed import is refused where it is written, and the file is read past it", () => {
  // The alias was reported but not consumed, so the `}` that closes the import
  // was read as the end of a statement and left the parser on the same token:
  // a file whose only mistake was a rename never came back at all. The alias
  // is read with the rest of the statement, and the refusal is still reported.
  assert.match(
    diagnostic(() => typescript.analyze('import { scale as fromB } from "./b.ts";\nconsole.log(1);\n', "main.ts")),
    /renaming an import is not supported/,
  );
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

test("an arrow that writes a name of the function around it is refused", () => {
  // A lifted arrow is handed the values it captured, and a parameter carries a
  // value in but cannot write one back. Silently writing a copy would be a
  // program that answers 0 where the source answers 2.
  assert.match(
    diagnostic(() =>
      typescript.analyze(
        [
          "export function f(x: number): number {",
          "  let total = 0;",
          "  const add = (v: number): void => { total += v; };",
          "  add(x);",
          "  return total;",
          "}",
          "",
        ].join("\n"),
        "main.ts",
      ),
    ),
    /an arrow function writes "total", a name of the function around it/,
  );
});

test("an arrow that calls itself is refused", () => {
  // A call of the name passes the values the arrow captured, and the arrow
  // cannot name them until the declaration it is bound to is complete. A
  // function that recurses is declared with `function`.
  assert.match(
    diagnostic(() =>
      typescript.analyze(
        [
          "export function f(x: number): number {",
          "  const fact = (n: number): number => n <= 1 ? 1 : n * fact(n - 1);",
          "  return fact(x);",
          "}",
          "",
        ].join("\n"),
        "main.ts",
      ),
    ),
    /fact calls itself, which an arrow function is not/,
  );
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

test("a collection method whose callback is not a function of the compiler's is refused", () => {
  // A callback is a closure the frontend wrote, so it is an arrow or a name
  // held at a function type. A plain function name is not one: the compiler
  // has no value of it to hand over.
  assert.match(
    diagnostic(() =>
      typescript.analyze(
        [
          "function twice(x: number): number { return x * 2; }",
          "export function g(a: Float64Array): number {",
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

test("a map keyed by anything but text is refused, because a key is a string", () => {
  assert.match(
    diagnostic(() =>
      typescript.analyze(
        "export function g(): number {\n  const s = new Set<number>();\n  return s.size;\n}\n",
        "main.ts",
      ),
    ),
    /a Set here is keyed by text, not by f64/,
  );
});

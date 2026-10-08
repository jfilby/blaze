import assert from "node:assert/strict";
import { test } from "node:test";
import { frontendFor } from "../semantics/frontend.ts";
import { CompilerError } from "../core/errors.ts";
import { parseContract } from "../semantics/contract.ts";
import { contractOf, diagnostic, phaseOf, programOf } from "./phase.ts";
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

test("a type or a name the compiler cannot read is still refused", async () => {
  assert.match(
    diagnostic(() => contractOf("typescript", `export function text(): string { return "hi"; }\n`)),
    /unsupported TypeScript type "string"/,
  );

  assert.match(
    diagnostic(() => contractOf("typescript", `export function odd(x: Date): number { return 0; }\n`)),
    /unsupported TypeScript type "Date"/,
  );

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
        "function noReturn() {",
        "  return 1;",
        "}",
        "export function spin(x: number): number {",
        "  switch (x) { return 1; }",
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

  assert.match(message, /4 constructs of module\.ts are outside the subset the compiler reads/);
  assert.match(message, /line 1: every function declares what it returns/);
  assert.match(message, /line 5: "switch" is not supported/);
  assert.match(message, /line 8: unsupported TypeScript type "Date"/);
  assert.match(message, /line 12: "class" is not supported/);
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
  let diagnostic = "";
  try {
    frontendFor("python");
  } catch (error) {
    diagnostic = error instanceof CompilerError ? `${error.message}\n${error.detail ?? ""}` : String(error);
  }
  assert.match(diagnostic, /supported languages: nim, typescript/);
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

test("a quote an escape covers does not end the string", () => {
  // The escape has to be read before the string is closed, or the token ends
  // at the escaped quote and everything after it is read as a new statement.
  const message = diagnostic(() =>
    typescript.analyze('export function f(x: number): number {\n  const s = "a\\"b";\n  return x;\n}\n', "main.ts"),
  );
  assert.match(message, /line 2: a quoted string is not a value/);
  assert.doesNotMatch(message, /line 3/);
});

test("a string that spans lines moves the line every later diagnostic names", () => {
  // The block comment beside it counts its newlines; a template literal
  // spanning three more lines used to leave every construct after it reported
  // three lines short of where the user wrote it.
  const message = diagnostic(() =>
    typescript.analyze(
      "export function g(x: number): number {\n  console.log(`\nreport\nhere\n`);\n  switch (x) {}\n  return x;\n}\n",
      "main.ts",
    ),
  );
  assert.match(message, /line 6: "switch" is not supported/);
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

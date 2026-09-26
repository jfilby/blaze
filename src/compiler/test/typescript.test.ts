import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { frontendFor } from "../semantics/frontend.ts";
import { CompilerError } from "../core/errors.ts";
import { parseContract } from "../semantics/contract.ts";
import { contractOf, diagnostic } from "./phase.ts";

const typescript = frontendFor("typescript");

const HELLO_WORLD = new URL("../../examples/hello_world/hello_world.ts", import.meta.url).pathname;

test("the shipped example compiles to the expected contract", async () => {
  const source = await readFile(HELLO_WORLD, "utf8");
  const contract = contractOf("typescript", source, { entry: "dotProduct" });

  assert.deepEqual(contract.function, {
    name: "dotProduct",
    symbol: "dotProduct",
    params: [
      { name: "a", type: "slice<f64>" },
      { name: "b", type: "slice<f64>" },
      { name: "n", type: "f64" },
    ],
    returns: "f64",
  });
  assert.deepEqual(contract.ensures, ["result == sum(i = 0..<n, (a[i] * b[i]))"]);
  assert.deepEqual(contract.requires, ["a != null", "len(a) >= n", "b != null", "len(b) >= n"]);
  assert.deepEqual(contract.memory.reads, ["a[0:n]", "b[0:n]"]);
  assert.deepEqual(contract.effects, []);
  parseContract(contract);
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

test("a body whose result is not one expression is contracted by what it does", async () => {
  // Nothing here can be written as `result == ...`, so the contract states the
  // signature, the effects and the body instead of refusing the function.
  const branch = contractOf("typescript", `export function pick(x: number): number {
  if (x > 0) return x;
  return 0;
}
`);
  assert.deepEqual(branch.ensures, []);
  assert.deepEqual(branch.effects, []);
  assert.deepEqual(branch.definition?.statements.map((statement) => statement.kind), ["if", "result"]);

  const program = contractOf("typescript", `export function report(depth: number): void {
  let nodes = 0;
  for (let i = 0; i <= depth; i++) {
    console.log(\`depth \${i}\`);
    nodes += 1;
  }
  if (nodes > 0) console.log(\`\${nodes}\`);
}
`);
  assert.deepEqual(program.effects, ["io"]);
  assert.equal(program.definition?.prints, true);
  assert.equal(program.definition?.allocates, false);
  assert.equal(program.definition?.readsArgv, false);

  const allocating = contractOf("typescript", `export function make(): any {
  return { left: null, right: null };
}
`);
  assert.deepEqual(allocating.effects, ["memory"]);
  assert.equal(allocating.definition?.allocates, true);

  const counting = contractOf("typescript", `export function everyOther(n: number): number {
  let total = 0;
  for (let d = 4; d <= n; d += 2) total += d;
  return total;
}
`);
  assert.deepEqual(counting.ensures, []);
  assert.deepEqual(
    counting.definition?.statements.map((statement) => statement.kind),
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
  const contract = contractOf("typescript", `export function report(values: Float64Array, limit: number): number {
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
`);
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

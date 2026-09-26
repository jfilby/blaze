import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { frontendFor } from "../src/compiler/semantics/frontend.ts";
import { CompilerError } from "../src/compiler/core/errors.ts";
import { parseContract } from "../src/compiler/semantics/contract.ts";
import { contractOf } from "./phase.ts";

const typescript = frontendFor("typescript");

const HELLO_WORLD = new URL("../src/examples/hello_world/hello_world.ts", import.meta.url).pathname;

test("the shipped example compiles to the expected contract", async () => {
  const source = await readFile(HELLO_WORLD, "utf8");
  const contract = contractOf("typescript", source, { entry: "dotProduct" });

  assert.deepEqual(contract.function, {
    name: "dotProduct",
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

test("impure and unsupported constructs are rejected with a reason", async () => {
  assert.throws(() => contractOf("typescript", `export function write(values: Float64Array, n: number): number {
  for (let i = 0; i < n; i++) values[i] = 0;
  return 0;
}
`),
    /writing into "values" is not supported/,
  );

  assert.throws(() => contractOf("typescript", `export function branch(x: number): number {
  if (x > 0) return x;
  return 0;
}
`),
    /"if" is not supported/,
  );

  assert.throws(() => contractOf("typescript", `export function text(): string { return "hi"; }\n`),
    /string literals are not supported|unsupported TypeScript type/,
  );

  assert.throws(() => contractOf("typescript", `export function odd(x: Date): number { return 0; }\n`),
    /unsupported TypeScript type "Date"/,
  );

  assert.throws(() => contractOf("typescript", `export function down(values: Float64Array, n: number): number {
  let total = 0;
  for (let i = n; i > 0; i--) total += values[i];
  return total;
}
`),
    /loop condition|counting down/,
  );

  assert.throws(() => contractOf("typescript", `export function unknown(x: number): number { return y + x; }\n`),
    /unknown identifier "y"/,
  );
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

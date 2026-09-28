import assert from "node:assert/strict";
import { test } from "node:test";
import {
  comparisonTolerance,
  formatValue,
  parseContract,
  parseType,
  postconditionFailures,
  preconditionFailures,
  referenceResult,
  typeOf,
  valuesMatch,
  type BufferValue,
  type Value,
} from "../semantics/contract.ts";
import { contractOf } from "./phase.ts";
import { dotProductBody, returns, ZERO } from "./definition.ts";
import type { FunctionContract } from "../core/types.ts";

function dotProductContract(): FunctionContract {
  return {
    version: "1",
    function: {
      name: "dotProduct",
      symbol: "dotProduct",
      params: [
        { name: "a", type: "ptr<f32>" },
        { name: "b", type: "ptr<f32>" },
        { name: "n", type: "usize" },
      ],
      returns: "f32",
    },
    requires: ["a != null", "b != null", "len(a) >= n", "len(b) >= n"],
    ensures: ["result == sum(i = 0..<n, a[i] * b[i])"],
    memory: { reads: ["a[0:n]", "b[0:n]"], writes: [], aliasing: [] },
    effects: [],
    numeric: { floatingPoint: "ieee754", rounding: "nearest", fastMath: false },
    optimize: { primary: "throughput", secondary: "size" },
    definition: dotProductBody(),
  };
}

function buffer(values: number[], type = "ptr<f32>"): BufferValue {
  return { type: parseType(type), values: values.map((value) => Math.fround(value)) };
}

function argumentsFor(a: number[], b: number[], n: number): Map<string, Value> {
  return new Map<string, Value>([
    ["a", buffer(a)],
    ["b", buffer(b)],
    ["n", BigInt(n)],
  ]);
}

test("parses contract type expressions", () => {
  assert.equal(parseType("ptr<f32>").kind, "ptr");
  assert.equal(parseType("slice<u8>").kind, "slice");
  assert.deepEqual(parseType("array<f64>"), { kind: "array", of: parseType("f64"), length: null });
  assert.deepEqual(parseType("array<f64, 8>"), { kind: "array", of: parseType("f64"), length: 8 });
  assert.throws(() => parseType("matrix<f32>"), /unsupported type expression/);
});

test("an empty half-open reduction yields the identity, not a wrapped bound", () => {
  const parsed = parseContract(dotProductContract());
  assert.equal(referenceResult(parsed, argumentsFor([], [], 0)), 0);
});

test("the reference result matches an independent sum", () => {
  const parsed = parseContract(dotProductContract());
  const a = [1.5, -2.25, 3, 0.5, 8];
  const b = [2, 4, -1, 8, 0.25];
  const expected = a.reduce((total, value, index) => total + Math.fround(value * b[index]), 0);
  assert.equal(referenceResult(parsed, argumentsFor(a, b, a.length)), Math.fround(expected));
});

test("preconditions reject inputs the contract does not promise", () => {
  const parsed = parseContract(dotProductContract());
  assert.deepEqual(preconditionFailures(parsed, argumentsFor([1, 2, 3], [1, 2], 2)), []);
  assert.deepEqual(preconditionFailures(parsed, argumentsFor([1], [1, 2, 3], 2)), ["len(a) >= n"]);

  // A null buffer fails the null check first; the length checks that follow
  // report a diagnostic instead of aborting the run.
  const withNull = preconditionFailures(
    parsed,
    new Map<string, Value>([["a", null], ["b", buffer([1])], ["n", 1n]]),
  );
  assert.equal(withNull[0], "a != null");
  assert.ok(withNull.slice(1).every((entry) => entry.startsWith("len(a) >= n")));
});

test("a null buffer is a precondition failure rather than a crash", () => {
  const parsed = parseContract(dotProductContract());
  const values = new Map<string, Value>([["a", null], ["b", null], ["n", 0n]]);
  const failures = preconditionFailures(parsed, values);
  assert.deepEqual(failures.slice(0, 2), ["a != null", "b != null"]);
  assert.ok(failures.length >= 2);
});

test("postconditions are checked against a candidate result", () => {
  const parsed = parseContract(dotProductContract());
  const values = argumentsFor([1, 2, 3], [1, 1, 1], 3);
  assert.deepEqual(postconditionFailures(parsed, values, 6), []);
  assert.equal(postconditionFailures(parsed, values, 7).length, 1);
});

test("a contract that states no postcondition is a function the program checks", () => {
  // No `result ==` here is not an incomplete contract: the body says what the
  // function is, and the program it is part of is what decides whether it is
  // right. What is not allowed is a body that says nothing.
  const contract = dotProductContract();
  contract.ensures = ["result >= 0"];
  assert.equal(parseContract(contract).resultDefinition, null);

  const empty = dotProductContract();
  empty.definition = { ...empty.definition, statements: [] };
  assert.throws(() => parseContract(empty), /is empty/);
});

test("two different result definitions are rejected", () => {
  const contract = dotProductContract();
  contract.ensures = ["result == sum(i = 0..<n, a[i] * b[i])", "result == n"];
  assert.throws(() => parseContract(contract), /in more than one way/);
});

test("unknown identifiers and non boolean conditions are rejected", () => {
  const contract = dotProductContract();
  contract.requires = ["a != null", "len(c) >= n"];
  assert.throws(() => parseContract(contract), /unknown identifier "c"/);

  const other = dotProductContract();
  other.requires = ["a != null", "n"];
  assert.throws(() => parseContract(other), /must be a boolean expression/);
});

test("memory ranges must refer to declared buffers", () => {
  const contract = dotProductContract();
  contract.memory.reads = ["a[0:n", "missing[0:1]"];
  assert.throws(() => parseContract(contract), /is not a range/);

  const other = dotProductContract();
  other.memory.reads = ["n[0:1]"];
  assert.throws(() => parseContract(other), /is not a buffer/);
});

test("float comparison allows reassociation but not a different result", () => {
  const tolerance = comparisonTolerance(parseType("f32"), 1024);
  assert.ok(tolerance !== null && tolerance > 0 && tolerance < 1e-2);
  assert.equal(valuesMatch(1, Math.fround(1 + 1e-8), tolerance), true);
  assert.equal(valuesMatch(1, 1.5, tolerance), false);
  assert.equal(valuesMatch(Number.NaN, Number.NaN, tolerance), true);
  assert.equal(valuesMatch(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, tolerance), true);
  assert.equal(valuesMatch(Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, tolerance), false);
});

test("integer comparison stays exact", () => {
  assert.equal(comparisonTolerance(parseType("i32"), 1024), null);
  assert.equal(valuesMatch(7n, 7n, null), true);
  assert.equal(valuesMatch(7n, 8n, null), false);
});

test("unsigned wraparound in a bound is visible instead of silent", () => {
  const contract = dotProductContract();
  contract.requires = ["a != null", "b != null", "len(a) >= n", "len(b) >= n"];
  const parsed = parseContract({
    ...contract,
    ensures: ["result == sum(i = 0..n - 1, a[i] * b[i])"],
  });
  assert.equal(referenceResult(parsed, argumentsFor([1, 2], [1, 1], 2)), 3);
});

test("types of contract expressions are inferred from the signature", () => {
  const parsed = parseContract(dotProductContract());
  const env = parsed.env;
  assert.equal(typeOf({ t: "var", name: "a" }, env).kind, "ptr");
  assert.equal(typeOf({ t: "index", base: { t: "var", name: "a" }, index: { t: "var", name: "n" } }, env).kind, "primitive");
  assert.throws(() => typeOf({ t: "index", base: { t: "var", name: "n" }, index: { t: "var", name: "n" } }, env), /cannot index/);
});

test("values render readably in diagnostics", () => {
  assert.equal(formatValue(1n), "1");
  assert.equal(formatValue(Number.NaN), "nan");
  assert.equal(formatValue(Number.POSITIVE_INFINITY), "inf");
  assert.equal(formatValue(null), "null");
  assert.equal(formatValue(buffer([1, 2])), "[1, 2]");
});

function requiresContract(name: string, params: { name: string; type: string }[], requires: string[]): FunctionContract {
  return {
    version: "1",
    function: { name, symbol: name, params, returns: "f64" },
    requires,
    ensures: ["result == 0.0"],
    memory: { reads: [], writes: [], aliasing: [] },
    effects: [],
    numeric: { floatingPoint: "ieee754", rounding: "nearest", fastMath: false },
    optimize: { primary: "throughput", secondary: "size" },
    definition: returns(ZERO),
  };
}

test("nothing is ordered against not-a-number, so a NaN fails every ordering bound", () => {
  // Answering that a NaN is greater than everything made `>` and `>=` true,
  // which passed inputs and results the language says are unordered.
  for (const bound of ["x > 0.0", "x >= 0.0", "x < 1.0", "x <= 1.0"]) {
    const parsed = parseContract(requiresContract("nan", [{ name: "x", type: "f64" }], [bound]));
    assert.deepEqual(
      preconditionFailures(parsed, new Map<string, Value>([["x", Number.NaN]])),
      [bound],
      `${bound} must not hold for a NaN`,
    );
  }
  // A NaN is also not equal to anything, which is what the equality test asks.
  const equal = parseContract(requiresContract("nanEq", [{ name: "x", type: "f64" }], ["x == 0.0"]));
  assert.deepEqual(preconditionFailures(equal, new Map<string, Value>([["x", Number.NaN]])), ["x == 0.0"]);
  const different = parseContract(requiresContract("nanNe", [{ name: "x", type: "f64" }], ["x != 0.0"]));
  assert.deepEqual(preconditionFailures(different, new Map<string, Value>([["x", Number.NaN]])), []);
});

test("a whole number is never equal to a fraction, and is below one only up to its floor", () => {
  // Comparing against the fraction's floor made a length of 1 satisfy a bound
  // of 1.5, so the vectors a build checked were not the ones it promised.
  const atLeast = parseContract(requiresContract("len", [{ name: "n", type: "usize" }], ["n >= 1.5"]));
  assert.deepEqual(preconditionFailures(atLeast, new Map<string, Value>([["n", 1n]])), ["n >= 1.5"]);
  assert.deepEqual(preconditionFailures(atLeast, new Map<string, Value>([["n", 2n]])), []);

  const equal = parseContract(requiresContract("lenEq", [{ name: "n", type: "usize" }], ["n == 1.5"]));
  assert.deepEqual(preconditionFailures(equal, new Map<string, Value>([["n", 1n]])), ["n == 1.5"]);

  const below = parseContract(requiresContract("neg", [{ name: "n", type: "i64" }], ["n < -1.5"]));
  assert.deepEqual(preconditionFailures(below, new Map<string, Value>([["n", -1n]])), ["n < -1.5"]);
  assert.deepEqual(preconditionFailures(below, new Map<string, Value>([["n", -2n]])), []);

  // A bound that is a whole number still compares exactly.
  const whole = parseContract(requiresContract("whole", [{ name: "n", type: "usize" }], ["n >= 2.0"]));
  assert.deepEqual(preconditionFailures(whole, new Map<string, Value>([["n", 2n]])), []);
  assert.deepEqual(preconditionFailures(whole, new Map<string, Value>([["n", 1n]])), ["n >= 2.0"]);
});

test("a product of whole numbers is held wider than its elements, as a sum is", () => {
  // Four bytes of 5 multiply to 625. Held at the element width they wrapped to
  // 113, and a correct implementation was then read as a wrong one.
  const contract = contractOf("typescript", [
    "export function prod(x: Uint8Array, n: number): number {",
    "  let acc = 1;",
    "  for (let i = 0; i < n; i++) acc *= x[i];",
    "  return acc;",
    "}",
    "",
  ].join("\n"), { entry: "prod" });
  assert.deepEqual(contract.ensures, ["result == product(i = 0..<n, x[i])"]);
  const parsed = parseContract(contract);
  const values = new Map<string, Value>([
    ["x", { type: parseType("slice<u8>"), values: [5n, 5n, 5n, 5n] }],
    ["n", 4n],
  ]);
  assert.equal(referenceResult(parsed, values), 625n);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { frontendFor } from "../semantics/frontend.ts";
import { parseContract } from "../semantics/contract.ts";
import { contractOf, programOf } from "./phase.ts";

const DOT_PRODUCT = `proc dotProduct(a: ptr float32, b: ptr float32, n: usize): float32 =
  var acc: float32 = 0.0
  for i in 0 ..< n:
    acc += a[i] * b[i]
  result = acc
`;

test("a counted loop becomes a half open reduction with matching memory ranges", async () => {
  const contract = contractOf("nim", DOT_PRODUCT);
  assert.equal(contract.function.name, "dotProduct");
  assert.deepEqual(contract.function.params, [
    { name: "a", type: "ptr<f32>" },
    { name: "b", type: "ptr<f32>" },
    { name: "n", type: "usize" },
  ]);
  assert.equal(contract.function.returns, "f32");
  assert.deepEqual(contract.ensures, ["result == sum(i = 0..<n, (a[i] * b[i]))"]);
  assert.deepEqual(contract.memory.reads, ["a[0:n]", "b[0:n]"]);
  assert.deepEqual(contract.requires, ["a != null", "len(a) >= n", "b != null", "len(b) >= n"]);
  assert.deepEqual(contract.memory.writes, []);
  assert.deepEqual(contract.effects, []);
  parseContract(contract);
});

test("an inclusive loop range keeps both bounds", async () => {
  const contract = contractOf("nim", `proc range(x: openArray[float32], lo: usize, hi: usize): float32 =
  var acc: float32 = 0.0
  for i in lo .. hi:
    acc += x[i]
  result = acc
`);
  assert.deepEqual(contract.ensures, ["result == sum(i = lo..hi, x[i])"]);
  assert.deepEqual(contract.memory.reads, ["x[lo:(hi + 1)]"]);
  assert.ok(contract.requires.includes("len(x) >= (hi + 1)"));
  parseContract(contract);
});

test("a product loop becomes a product reduction", async () => {
  const contract = contractOf("nim", `proc product(x: ptr float64, n: usize): float64 =
  var acc: float64 = 1.0
  for i in 0 ..< n:
    acc *= x[i]
  result = acc
`);
  assert.deepEqual(contract.ensures, ["result == product(i = 0..<n, x[i])"]);
  parseContract(contract);
});

test("a non neutral initialiser stays in the result", async () => {
  const contract = contractOf("nim", `proc scaled(x: ptr float32, n: usize): float32 =
  var acc: float32 = 2.5
  for i in 0 ..< n:
    acc += x[i]
  result = acc
`);
  assert.deepEqual(contract.ensures, ["result == (2.5 + sum(i = 0..<n, x[i]))"]);
  parseContract(contract);
});

test("a scalar expression body needs no loop", async () => {
  const contract = contractOf("nim", `proc square(x: float64): float64 = x * x\n`);
  assert.deepEqual(contract.ensures, ["result == (x * x)"]);
  assert.deepEqual(contract.requires, []);
  assert.deepEqual(contract.memory.reads, []);
  parseContract(contract);
});

test("a local variable is substituted by the value it holds", async () => {
  const contract = contractOf("nim", `proc offset(x: float32, k: float32): float32 =
  let step: float32 = k
  var total: float32 = 0.0
  total += x * step
  result = total
`);
  assert.deepEqual(contract.ensures, ["result == (0.0 + (x * k))"]);
  parseContract(contract);
});

test("the entry selects the procedure to compile", async () => {
  const source = `proc first(x: float32): float32 = x + 1.0
proc second(x: float32): float32 = x * 2.0
`;
  assert.equal((contractOf("nim", source, { entry: "second" })).function.name, "second");
  assert.equal((contractOf("nim", source, { entry: "first" })).function.name, "first");
  assert.throws(() => contractOf("nim", source, { entry: "missing" }), /is not an export of module.nim/);
});

test("writing through a pointer is rejected instead of mis-modelled", async () => {
  assert.throws(() => contractOf("nim", `proc fill(x: ptr float32, n: usize): float32 =
  for i in 0 ..< n:
    x[i] = 1.0
  result = 0.0
`),
    /writing through/,
  );
});

test("control flow the contract cannot describe is rejected explicitly", async () => {
  assert.throws(() => contractOf("nim", `proc branching(x: float32): float32 =
  if x > 0.0:
    return x
  result = 0.0
`),
    /"if" is not supported/,
  );
});

test("a procedure without a result is rejected", async () => {
  assert.throws(() => contractOf("nim", `proc nothing(x: float32) =\n  discard x\n`), /no return type/);
});

test("unsupported types and languages are rejected", async () => {
  assert.throws(() => contractOf("nim", `proc bad(x: seq[float32]): float32 = 0.0\n`), /unsupported Nim type/);
  assert.throws(() => frontendFor("rust"), /unsupported language/);
});

test("the optimization objective comes from the input, the target does not", () => {
  const contract = contractOf("nim", DOT_PRODUCT, { optimize: { primary: "size" } });
  assert.equal(contract.optimize.primary, "size");
  // The same contract serves every target, so a build target cannot change it.
  assert.deepEqual(contractOf("nim", DOT_PRODUCT, { optimize: { primary: "size" }, target: { cpu: "znver5" } }), contract);
});

test("a float32 literal carries the value it denotes, not a rounded decimal", async () => {
  const contract = contractOf("nim", `proc literal(): float32 = 0.1'f32\n`);
  const literal = Number(contract.ensures[0].split("== ")[1]);
  assert.equal(literal, Math.fround(0.1));
  assert.notEqual(literal, 0.1);
  parseContract(contract);
});

test("a block-bodied proc ends where it dedents, so the next proc keeps its own body", async () => {
  // A proc body is the run of lines that stays indented, not every later line
  // that is: collecting across the dedent welded the second proc's body onto
  // the first and left the second proc undeclared.
  const source = `proc first(x: float32): float32 =
  return x + 1.0
proc second(x: float32): float32 =
  return x * 2.0
`;
  const contracts = programOf("nim", { "module.nim": source }, "module.nim").files.find(
    (file) => file.path === "module.nim",
  )?.functions ?? {};
  assert.deepEqual(Object.keys(contracts), ["first", "second"]);
  assert.deepEqual(contracts.first?.ensures, ["result == (x + 1.0)"]);
  assert.deepEqual(contracts.second?.ensures, ["result == (x * 2.0)"]);
});

test("a loop body ends where it dedents, so a second loop is a second statement", async () => {
  const contract = contractOf("nim", `proc total(x: openArray[float64], n: int): float64 =
  var acc = 0.0
  for i in 0 ..< n:
    acc += x[i]
  for j in 0 ..< n:
    acc += x[j]
  result = acc
`);
  assert.deepEqual(contract.ensures, ["result == (sum(i = 0..<n, x[i]) + sum(j = 0..<n, x[j]))"]);
  parseContract(contract);
});

test("an accumulator seeded with a compound value folds the seed into the reduction", async () => {
  // A parenthesised seed is not the identity, and the fold is how a second
  // loop over the same accumulator is written at all.
  const contract = contractOf("nim", `proc seeded(x: openArray[float64], n: int, k: float64): float64 =
  var acc = 0.0 + k
  for i in 0 ..< n:
    acc += x[i]
  return acc
`);
  assert.deepEqual(contract.ensures, ["result == ((0.0 + k) + sum(i = 0..<n, x[i]))"]);
  parseContract(contract);
});

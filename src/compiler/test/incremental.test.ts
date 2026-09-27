import assert from "node:assert/strict";
import { test } from "node:test";
import { reusable, unitKey, type IncrementalEntry, type UnitKeyInput } from "../incremental.ts";
import type { AssemblyCandidate, CandidateOutcome, FunctionContract, ObjectLayout, ProgramContract } from "../core/types.ts";

function contractOf(name: string, returns: string, objects: Record<string, ObjectLayout> = {}): FunctionContract {
  return {
    version: "1",
    function: {
      name,
      symbol: name,
      params: [{ name: "x", type: "f64" }],
      returns,
    },
    requires: [],
    ensures: [`result == x`],
    memory: { reads: [], writes: [], aliasing: [] },
    effects: [],
    numeric: { floatingPoint: "ieee754", rounding: "nearest", fastMath: false },
    optimize: { primary: "latency" },
    ...(Object.keys(objects).length === 0 ? {} : { definition: { statements: [], objects, allocates: false, prints: false, readsArgv: false } }),
  };
}

function programOf(...functions: FunctionContract[]): ProgramContract {
  return {
    version: "1",
    language: "typescript",
    entry: { file: "main.ts", function: null },
    files: [{ path: "main.ts", functions: Object.fromEntries(functions.map((entry) => [entry.function.name, entry])), imports: [] }],
    edges: [],
  };
}

const INPUT: UnitKeyInput = {
  contract: contractOf("main", "f64"),
  file: "main.ts",
  program: programOf(contractOf("main", "f64"), contractOf("helper", "f64")),
  target: { arch: "x86_64", os: "linux", abi: "sysv", cpu: "", features: [] },
  output: "machine",
  runtime: "none",
  test: { randomCases: 24, maxLength: 1024, seed: 7 },
  benchmark: { iterations: 2000 },
  model: "openai/gpt-5",
  compilerVersion: "0.1.0",
};

function keyOf(overrides: Partial<UnitKeyInput>): string {
  return unitKey({ ...INPUT, ...overrides });
}

test("a key is the same for the same inputs and different for anything else", () => {
  assert.equal(keyOf({}), keyOf({}));
  for (const change of [
    { contract: contractOf("main", "f32") },
    { file: "other.ts" },
    { target: { ...INPUT.target, arch: "aarch64" as const } },
    { output: "asm" as const },
    { runtime: "nim" as const },
    { test: { ...INPUT.test, randomCases: 25 } },
    { benchmark: { iterations: 10 } },
    { model: "anthropic/claude-sonnet-4-5" },
    { compilerVersion: "0.2.0" },
  ]) {
    assert.notEqual(keyOf(change), keyOf({}), JSON.stringify(change));
  }
});

test("a callee whose body changed does not invalidate the caller", () => {
  // The caller is linked against the callee's ABI, and a body is not part of
  // it: the callee is regenerated, and the object that calls it still is right.
  const before = programOf(contractOf("main", "f64"), contractOf("helper", "f64"));
  const after = programOf(contractOf("main", "f64"), { ...contractOf("helper", "f64"), ensures: ["result == (x + 1)"] });
  assert.equal(keyOf({ program: after }), keyOf({ program: before }));
});

test("a callee whose signature or object layout changed invalidates the caller", () => {
  // These are the two changes that can break an object that is not rebuilt.
  const signature = programOf(contractOf("main", "f64"), contractOf("helper", "i32"));
  assert.notEqual(keyOf({ program: signature }), keyOf({}));

  const layout = programOf(
    contractOf("main", "f64"),
    contractOf("helper", "f64", { node: { name: "node", size: 8, align: 8, fields: [] } }),
  );
  assert.notEqual(keyOf({ program: layout }), keyOf({}));
});

function entry(overrides: Partial<IncrementalEntry> = {}): IncrementalEntry {
  const candidate: AssemblyCandidate = {
    id: "c1",
    assembly: ".globl main\nmain:\n  ret\n",
    model: "openai/gpt-5",
    modelConfig: "openai/gpt-5",
    generatedAt: "2026-01-01T00:00:00.000Z",
    candidate: 1,
    round: 1,
  };
  const outcome: CandidateOutcome = { candidate: "c1", valid: true, verification: { candidate: "c1", passed: true, cases: 4, tolerance: null, failures: [], durationNs: 1 } };
  return {
    key: "k",
    file: "main.ts",
    selected: "c1",
    candidates: [candidate],
    outcomes: [outcome],
    benchmarkVector: null,
    ...overrides,
  };
}

test("only what a build proved, and only from the same inputs, may be reused", () => {
  assert.equal(reusable(entry(), "k", true), "object");
  // Files that are gone leave the implementation, which the toolchain rebuilds.
  assert.equal(reusable(entry(), "k", false), "assembly");
  // A key from different inputs is not this object.
  assert.equal(reusable(entry(), "other", true), null);
  assert.equal(reusable(undefined, "k", true), null);
  // A candidate the toolchain rejected is not a proof of anything.
  const rejected = entry({ outcomes: [{ candidate: "c1", valid: false, failure: { category: "AssemblyError", stage: "assemble", message: "no" } }] });
  assert.equal(reusable(rejected, "k", true), null);
  assert.equal(reusable(entry({ selected: "c2" }), "k", true), null);
});

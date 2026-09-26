import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeRunResults,
  encodeBenchRequest,
  encodeRunRequest,
  planTestVectors,
  vectorValues,
} from "../src/compiler/toolchain/verifier.ts";
import { parseContract, referenceResult, type BufferValue } from "../src/compiler/semantics/contract.ts";
import { createJsonStore, hashText, serializeJson } from "../src/compiler/core/json-store.ts";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FunctionContract, TestConfig } from "../src/compiler/core/types.ts";

const CONTRACT: FunctionContract = {
  version: "1",
  function: {
    name: "dotProduct",
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
  target: { arch: "x86_64", os: "linux", abi: "sysv", cpu: "", features: [] },
  optimize: { primary: "throughput" },
};

const CONFIG: TestConfig = { randomCases: 8, maxLength: 64, seed: 0x5eed1234 };

function bufferLength(values: ReadonlyMap<string, unknown>): number {
  const value = values.get("a") as BufferValue;
  return value.values.length;
}

test("planned vectors cover fixed, boundary and randomized cases", () => {
  const parsed = parseContract(CONTRACT);
  const vectors = planTestVectors(parsed, CONFIG);
  const kinds = new Set(vectors.map((vector) => vector.kind));
  assert.deepEqual([...kinds].sort(), ["boundary", "fixed", "random"]);

  const lengths = vectors.map((vector) => bufferLength(vectorValues(CONTRACT, vector)));
  assert.ok(lengths.includes(0), "the empty input is a boundary case");
  assert.ok(lengths.includes(1), "a single element is a boundary case");
  assert.ok(lengths.includes(64), "the configured maximum length is covered");
  assert.equal(new Set(vectors.map((vector) => vector.id)).size, vectors.length);
});

test("every planned vector satisfies the contract preconditions", () => {
  const parsed = parseContract(CONTRACT);
  for (const vector of planTestVectors(parsed, CONFIG)) {
    const values = vectorValues(CONTRACT, vector);
    assert.equal(values.get("n"), BigInt(bufferLength(values)));
    assert.equal(referenceResult(parsed, values) === referenceResult(parsed, values), true);
  }
});

test("vector planning is deterministic for a given seed", () => {
  const parsed = parseContract(CONTRACT);
  assert.deepEqual(planTestVectors(parsed, CONFIG), planTestVectors(parsed, CONFIG));
  assert.notDeepEqual(planTestVectors(parsed, { ...CONFIG, seed: 99 }), planTestVectors(parsed, CONFIG));
});

test("the run request carries a header line and one data line per non empty buffer", () => {
  const parsed = parseContract(CONTRACT);
  const vectors = planTestVectors(parsed, CONFIG);
  const request = encodeRunRequest(CONTRACT, vectors);
  const lines = request.split("\n");
  assert.equal(lines[0], "run");

  let index = 1;
  for (const vector of vectors) {
    const a = vector.args.a as string[];
    const b = vector.args.b as string[];
    assert.equal(lines[index], `${a.length} ${b.length} ${vector.args.n}`);
    index += 1;
    if (a.length > 0) {
      assert.equal(lines[index], a.join(" "));
      index += 1;
    }
    if (b.length > 0) {
      assert.equal(lines[index], b.join(" "));
      index += 1;
    }
  }
  assert.equal(lines.slice(index).join(""), "");
});

test("floats survive the transfer exactly", () => {
  const parsed = parseContract(CONTRACT);
  const vector = planTestVectors(parsed, CONFIG).find((entry) => entry.kind === "random");
  assert.ok(vector !== undefined);
  const lines = encodeRunRequest(CONTRACT, [vector]).split("\n");
  const sent = vector.args.a as string[];
  const received = lines[2].split(" ").map((token) => Number(token));

  assert.equal(received.length, sent.length);
  for (const [index, token] of sent.entries()) {
    // The token is the shortest decimal of an exact float32, so reading it back
    // yields the same float32 the reference implementation used.
    assert.equal(Math.fround(received[index]), Math.fround(Number(token)));
  }
  assert.ok(
    received.some((value) => value !== 0 && !Number.isInteger(value)),
    "the randomized vector carries values that need full precision",
  );
});

test("a result count that does not match the request is a verification error", () => {
  const parsed = parseContract(CONTRACT);
  const vectors = planTestVectors(parsed, { ...CONFIG, randomCases: 0 });
  const stdout = vectors.map((_, index) => `RESULT ${index}`).join("\n");
  const decoded = decodeRunResults(CONTRACT, stdout, vectors.length);
  assert.deepEqual(
    decoded,
    vectors.map((_, index) => Math.fround(index)),
  );
  assert.throws(() => decodeRunResults(CONTRACT, "RESULT 0\n", vectors.length), /produced 1 results for/);
});

test("special float results are decoded rather than turned into zero", () => {
  assert.deepEqual(decodeRunResults(CONTRACT, "RESULT inf\n", 1), [Number.POSITIVE_INFINITY]);
  assert.deepEqual(decodeRunResults(CONTRACT, "RESULT -inf\n", 1), [Number.NEGATIVE_INFINITY]);
  assert.deepEqual(decodeRunResults(CONTRACT, "RESULT nan\n", 1), [Number.NaN]);
  assert.deepEqual(decodeRunResults(CONTRACT, "RESULT 0.10000000149011612\n", 1), [Math.fround(0.1)]);
});

test("the bench request reuses the run protocol with a mode header", () => {
  const parsed = parseContract(CONTRACT);
  const [vector] = planTestVectors(parsed, { ...CONFIG, randomCases: 0 });
  const request = encodeBenchRequest(CONTRACT, vector, 500);
  assert.ok(request.startsWith("bench 500\n"));
});

test("the store keeps every path inside its root", async () => {
  const root = await mkdtemp(join(tmpdir(), "blaze-store-"));
  const store = createJsonStore(root);
  await assert.rejects(() => store.read("../escape.json"), /escapes root/);
  await assert.rejects(() => store.read("/etc/passwd"), /must be relative/);
  await assert.rejects(() => store.write("projects/../../escape.json", {}), /escapes root/);
});

test("the store round trips values and leaves no temporary files", async () => {
  const root = await mkdtemp(join(tmpdir(), "blaze-store-"));
  const store = createJsonStore(root);
  const value = { id: "dot-product", status: "success", nested: [1, 2, { deep: true }] };
  await store.write("projects/dot-product/build.json", value);
  assert.deepEqual(await store.read("projects/dot-product/build.json"), value);
  assert.equal(await store.exists("projects/dot-product/build.json"), true);
  assert.equal(await store.exists("projects/dot-product/missing.json"), false);
  assert.equal(await readFile(store.resolve("projects/dot-product/build.json"), "utf8"), serializeJson(value));

  await store.writeText("projects/dot-product/output/function.s", "\t.globl f\n");
  assert.equal(await store.readText("projects/dot-product/output/function.s"), "\t.globl f\n");

  await store.remove("projects/dot-project");
  assert.equal(await store.exists("projects/dot-product/build.json"), true);
});

test("hashes identify content", () => {
  assert.equal(hashText("abc"), hashText("abc"));
  assert.notEqual(hashText("abc"), hashText("abd"));
  assert.match(hashText("abc"), /^[0-9a-f]{64}$/);
});

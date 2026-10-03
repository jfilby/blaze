import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeRunResults,
  encodeBenchRequest,
  encodeRunRequest,
  planTestVectors,
  vectorValues,
} from "../toolchain/verifier.ts";
import { parseContract, preconditionFailures, referenceResult, valuesMatch, type BufferValue } from "../semantics/contract.ts";
import { createJsonStore, hashText, serializeJson } from "../core/json-store.ts";
import { readIncremental } from "../incremental.ts";
import { run, GENERATED_HEAP_BYTES } from "../core/process.ts";
import { probeFault } from "../codegen.ts";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FunctionContract, TestConfig } from "../core/types.ts";
import { body, dotProductBody } from "./definition.ts";
import { scratch } from "./scratch.ts";

const PYTHON = "python3";

/**
 * A program that grows its heap to a fixed size and then reports that it did.
 * The pages are written, so the memory is real: what is refused under a limit
 * is a heap that cannot grow, not an address space that was merely reserved.
 */
function grower(mib: number): string {
  return [
    "import sys",
    `block = bytearray(${mib} * 1024 * 1024)`,
    "for offset in range(0, len(block), 4096):",
    "    block[offset] = 1",
    'sys.stdout.write("grown\\n")',
  ].join("\n");
}

const CONTRACT: FunctionContract = {
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
  optimize: { primary: "throughput" },
  definition: dotProductBody(),
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
    assert.deepEqual(preconditionFailures(parsed, values), []);
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

/** A contract that sums bytes, which is where a reduction is held too narrowly. */
const BYTES: FunctionContract = {
  ...CONTRACT,
  function: {
    name: "total",
    symbol: "total",
    params: [
      { name: "a", type: "ptr<u8>" },
      { name: "n", type: "usize" },
    ],
    returns: "f64",
  },
  requires: ["a != null", "len(a) >= n"],
  ensures: ["result == sum(i = 0..<n, a[i])"],
  memory: { reads: ["a[0:n]"], writes: [], aliasing: [] },
  definition: body([
    {
      kind: "loop",
      variable: "i",
      from: { k: "literal", text: "0" },
      to: { k: "ident", name: "n" },
      inclusive: false,
      step: null,
      down: false,
      line: 2,
      body: [
        {
          kind: "assign",
          target: "sum",
          op: "+=",
          line: 2,
          value: { k: "index", base: { k: "ident", name: "a" }, index: { k: "ident", name: "i" } },
        },
      ],
    },
    { kind: "result", value: { k: "ident", name: "sum" }, line: 3 },
  ]),
};

/** The values of one call of a function that sums `count` bytes of `value`. */
function bytes(count: number, value: bigint): Map<string, BufferValue | bigint> {
  return new Map<string, BufferValue | bigint>([
    ["a", { type: { kind: "primitive", name: "u8" }, values: new Array(count).fill(value) }],
    ["n", BigInt(count)],
  ]);
}

test("a sum of whole numbers is not held at the width of the elements", () => {
  const parsed = parseContract(BYTES);

  // The language sums 52 bytes of 5 as 260, and not as 4.
  assert.equal(Number(referenceResult(parsed, bytes(52, 5n))), 260);
  assert.equal(Number(referenceResult(parsed, bytes(100, 5n))), 500);
  assert.equal(Number(referenceResult(parsed, bytes(4, 5n))), 20);
});

test("a whole number and the double that holds it are the same result", () => {
  // The reference computes in the type its expression has and the candidate in
  // the type it returns, so `return 42;` is a bigint on one side and a double
  // on the other. They are the same result.
  assert.equal(valuesMatch(42n, 42, null), true);
  assert.equal(valuesMatch(42, 42n, null), true);
  assert.equal(valuesMatch(0n, -0, null), true);
  // A double past 2^53 cannot name every whole number, so the two are compared
  // as the numbers they are, and a difference it cannot hold is not a failure.
  assert.equal(valuesMatch(2n ** 60n, Number(2n ** 60n), null), true);

  assert.equal(valuesMatch(42n, 43, null), false);
  assert.equal(valuesMatch(42n, 42.5, null), false);
  assert.equal(valuesMatch(2n ** 50n, 2n ** 50n + 1n, null), false);
  assert.equal(valuesMatch(1n, true, null), false);
});

test("the store keeps every path inside its root", async () => {
  const root = await scratch("blaze-store-");
  const store = createJsonStore(root);
  await assert.rejects(() => store.read("../escape.json"), /escapes root/);
  await assert.rejects(() => store.read("/etc/passwd"), /must be relative/);
  await assert.rejects(() => store.write("projects/../../escape.json", {}), /escapes root/);
  // Asking whether a path is there is not a reason to allow one that leaves
  // the root: reported as merely absent, an escaping path reads as a build
  // that was never made.
  await assert.rejects(() => store.exists("/etc/passwd"), /must be relative/);
  await assert.rejects(() => store.exists("../../escape.json"), /escapes root/);
});

test("the store round trips values and leaves no temporary files", async () => {
  const root = await scratch("blaze-store-");
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

test("a record that is present but unreadable is a fault, not a record that is not there", async (t) => {
  const root = await scratch("blaze-store-");
  const store = createJsonStore(root);
  const path = "projects/p/build.json";
  await store.mkdirp("projects/p");
  await writeFile(store.resolve(path), '{"selected":"c1"}\n', "utf8");
  await chmod(store.resolve(path), 0o000);
  if (await readFile(store.resolve(path), "utf8").then(() => true, () => false)) {
    t.skip("this user can read a file with no permissions, so there is nothing to refuse");
    return;
  }

  // Told the record is absent, the next write replaces the only copy of it
  // with a build that never read what was there. The file is present and the
  // contents are perfectly good JSON, so nothing about it is a cache to throw
  // away: the fault is ours, and the caller has to be told which.
  await assert.rejects(() => store.readIfValid(path), /cannot read projects\/p\/build\.json/);
  await assert.rejects(() => readIncremental(store, path), /cannot read projects\/p\/build\.json/);

  // What it does tolerate is a record it can do without: one that is not
  // there, and one that is not JSON.
  await chmod(store.resolve(path), 0o644);
  await writeFile(store.resolve(path), "{ not json", "utf8");
  assert.equal(await store.readIfValid(path), undefined);
  assert.deepEqual(Object.keys(await readIncremental(store, path)), []);
  assert.equal(await store.readIfValid("projects/p/absent.json"), undefined);
});

test("hashes identify content", () => {
  assert.equal(hashText("abc"), hashText("abc"));
  assert.notEqual(hashText("abc"), hashText("abd"));
  assert.match(hashText("abc"), /^[0-9a-f]{64}$/);
});

test("a run that never started is told apart from a run that finished", () => {
  // A missing command cannot be spawned at all, which leaves no exit status
  // and no signal: a consumer that reads that as a clean exit decides a
  // program it never ran was correct.
  const missing = run("blaze-no-such-command", [], { timeoutMs: 10_000 });
  assert.equal(missing.spawnError !== undefined, true);
  assert.equal(missing.code, null);
  assert.equal(missing.signal, null);
  assert.equal(missing.timedOut, false);

  // Dying by a signal from outside is not a timeout: a process stopped by
  // something else was blamed for exceeding a limit it never had.
  const stopped = run("sh", ["-c", "kill -TERM $$"], { timeoutMs: 10_000 });
  assert.equal(stopped.signal, "SIGTERM");
  assert.equal(stopped.timedOut, false);
  assert.equal(stopped.spawnError, undefined);

  // Our own timeout is a timeout, and it is the clock that says so rather
  // than a failure to launch: the process did start.
  const slow = run("sleep", ["10"], { timeoutMs: 300 });
  assert.equal(slow.timedOut, true);
  assert.equal(slow.spawnError, undefined);
  assert.equal(slow.code, null);

  // Which is what the probe reports it as, rather than as a probe that never
  // started: the first thing a caller reads is the fault.
  assert.match(probeFault(slow) ?? "", /did not return within \d+ seconds/);
  assert.equal(probeFault(run("blaze-no-such-command", [], { timeoutMs: 10_000 })), "the probe did not start: blaze-no-such-command");

  // Output past the buffer is a failure to run, not a run that printed little.
  const flooded = run("sh", ["-c", "head -c 100000 /dev/zero | tr '\\0' a"], { maxBufferBytes: 1024 });
  assert.equal(flooded.spawnError !== undefined, true);

  const clean = run("sh", ["-c", "exit 0"], { timeoutMs: 10_000 });
  assert.equal(clean.code, 0);
  assert.equal(clean.spawnError, undefined);
  assert.equal(clean.timedOut, false);
});

test("a deadline stops a program that refuses to be stopped", () => {
  // The signal a deadline sends is a request, and this program answers it by
  // doing nothing. A bound that can be refused is not a bound: without a
  // signal that cannot be trapped, this run lasts the full thirty seconds
  // rather than the two it was given, and everything that waits on the bound
  // waits with it.
  const started = process.hrtime.bigint();
  const stubborn = run("sh", ["-c", "trap '' TERM; sleep 30"], { timeoutMs: 2_000 });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 10_000, `the deadline was not enforced: ${elapsedMs.toFixed(0)}ms`);

  assert.equal(stubborn.timedOut, true);
  // A run that never exited has no exit status, and certainly not a
  // successful one: a consumer that reads the status alone would take a
  // program that was killed for running too long for one that finished.
  assert.equal(stubborn.code, null);
  assert.equal(stubborn.spawnError, undefined);
  assert.equal(probeFault(stubborn)?.includes("did not return within"), true);
});

test("a program that grows more heap than it is given is refused, not killed", async (t) => {
  if (run(PYTHON, ["-c", "pass"], { timeoutMs: 30_000 }).spawnError !== undefined) {
    t.skip(`${PYTHON} is needed to grow a heap`);
    return;
  }
  const unbounded = run(PYTHON, ["-c", grower(64)], { timeoutMs: 30_000 });
  assert.equal(unbounded.code, 0, unbounded.stderr);

  // Under a limit the same program is refused by the allocator, which it
  // reports as the error it is. A build that runs generated code without one
  // gets a process killed from outside instead, which says nothing about what
  // the program was doing when it died.
  const bounded = run(PYTHON, ["-c", grower(64)], {
    timeoutMs: 30_000,
    heapBytes: 32 * 1024 * 1024,
  });
  assert.notEqual(bounded.code, 0);
  assert.match(bounded.stderr, /MemoryError|Cannot allocate memory/);

  // A runtime that reserves address space for itself is not a program that
  // allocated too much: V8 claims tens of gigabytes before it allocates a
  // byte, so a limit that counted reservations would refuse it outright. The
  // limit is on the heap, and a node run that loads TypeScript still works.
  const probe = join(await scratch("blaze-heap-"), "probe.ts");
  await writeFile(probe, "const value: number = 1;\nconsole.log(value);\n", "utf8");
  const hosted = run("node", [probe], { timeoutMs: 60_000, heapBytes: GENERATED_HEAP_BYTES });
  assert.equal(hosted.code, 0, hosted.stderr);

  // What a bounded run reports is the program, not the shell that bounded it.
  const stopped = run("sh", ["-c", "kill -TERM $$"], {
    timeoutMs: 30_000,
    heapBytes: GENERATED_HEAP_BYTES,
  });
  assert.equal(stopped.signal, "SIGTERM");
  assert.equal(stopped.spawnError, undefined);
  assert.equal(stopped.timedOut, false);

  // A program that is not there is a program that never ran, which a shell
  // would otherwise report as an exit status a program is free to choose.
  const missing = run("blaze-no-such-command", [], {
    timeoutMs: 30_000,
    heapBytes: GENERATED_HEAP_BYTES,
  });
  assert.equal(missing.spawnError, "blaze-no-such-command");
  assert.equal(missing.code, null);
  assert.equal(missing.signal, null);
});


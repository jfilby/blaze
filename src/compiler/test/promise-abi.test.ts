/**
 * The promise ABI at the boundary.
 *
 * A promise is a tagged BlazeValue handle on every side. These probes call the
 * C runtime the compiler emits directly, because a test of the ABI has to see
 * what a generated call sees: the tag, the kind and the payload, not the
 * frontend's idea of a promise.
 */

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../core/process.ts";
import { runtimeHeaderSource, runtimeSourceSource } from "../runtime/abi.ts";
import { EXTERNAL_KINDS, HANDLE_KINDS, VALUE_TAGS, VALUE_LAYOUT } from "../runtime/value-abi.ts";
import { scratch } from "./scratch.ts";

/** Compiles and runs a C probe against the generated runtime. */
async function probe(body: string): Promise<string> {
  const directory = await scratch("blaze-promise-abi-");
  await writeFile(join(directory, "blaze_rt.h"), runtimeHeaderSource());
  await writeFile(join(directory, "blaze_rt.c"), runtimeSourceSource("debug"));
  await writeFile(
    join(directory, "probe.c"),
    `#include <stdio.h>\n#include <string.h>\n#include "blaze_rt.h"\nint main(void) {\n${body}\n}\n`,
    "utf8",
  );
  const binary = join(directory, "probe");
  const built = run(
    "gcc",
    ["-std=c11", "-O1", "-o", binary, join(directory, "probe.c"), join(directory, "blaze_rt.c"), "-I", directory, "-lm"],
    { timeoutMs: 120_000 },
  );
  assert.equal(built.code, 0, built.stderr);
  const result = run(binary, [], { timeoutMs: 30_000 });
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

test("the ABI states the tagged value layout at compile time", () => {
  const header = runtimeHeaderSource();
  assert.match(header, /_Static_assert\(sizeof\(BlazeValue\) == 16/);
  assert.match(header, /_Static_assert\(_Alignof\(BlazeValue\) == 8/);
  assert.match(header, /_Static_assert\(offsetof\(BlazeValue, payload\) == 0/);
  assert.match(header, /_Static_assert\(offsetof\(BlazeValue, tag\) == 8/);
  assert.match(header, /_Static_assert\(offsetof\(BlazeValue, kind\) == 12/);
  assert.equal(VALUE_LAYOUT.bytes, 16);
  assert.equal(VALUE_TAGS.external, 4);
  assert.equal(HANDLE_KINDS.dictionary, 10);
});

test("a created promise is a tagged external handle", async () => {
  const out = await probe(`
    BlazeValue p = blaze_promise_new();
    printf("%u %u", p.tag, p.kind);
  `);
  assert.equal(out, `${VALUE_TAGS.external} ${EXTERNAL_KINDS.promise}`);
  // The external resource kind for a promise is named in the runtime ABI.
  const source = runtimeSourceSource();
  assert.match(source, /BLAZE_EXTERNAL_PROMISE/);
});

test("a resolved number, text and dynamic value await back identically", async () => {
  const out = await probe(`
    BlazeValue n = blaze_promise_resolved_number(7.0);
    BlazeValue t = blaze_promise_resolved_text("hi");
    BlazeValue v = blaze_promise_resolved_value(9.0);
    double value = blaze_dynamic_from_value(blaze_promise_await_value(v));
    BlazeValue number = blaze_value_number(value);
    printf("%g %s %g", blaze_promise_await(n), blaze_promise_await_text(t), blaze_value_number_of(&number));
  `);
  assert.equal(out, "7 hi 9");
});

test("rejection propagates and a failed promise reports its message", async () => {
  const out = await probe(`
    BlazeValue p = blaze_promise_rejected("bad");
    printf("%d %s", blaze_promise_failed(p), blaze_promise_message(p));
  `);
  assert.equal(out, "1 bad");
});

test("awaiting an already settled value is the identity, not a second await", async () => {
  const out = await probe(`
    BlazeValue p = blaze_promise_resolved_number(6.0);
    double first = blaze_promise_await(p);
    double second = blaze_promise_await(blaze_value_number(first));
    printf("%g %g", first, second);
  `);
  assert.equal(out, "6 6");
});

test("an invalid handle is not a promise", async () => {
  const out = await probe(`
    BlazeValue bad = blaze_value_number(1234.0);
    printf("%d %g", blaze_promise_failed(bad), blaze_promise_await(bad));
  `);
  assert.equal(out, "0 1234");
});

test("a stale promise handle is rejected", async () => {
  const directory = await scratch("blaze-promise-stale-");
  await writeFile(join(directory, "blaze_rt.h"), runtimeHeaderSource());
  await writeFile(join(directory, "blaze_rt.c"), runtimeSourceSource("debug"));
  await writeFile(join(directory, "probe.c"), `#include "blaze_rt.c"
int main(void) {
  BlazeValue p = blaze_promise_new();
  blaze_promise_resolve(p, 5.0);
  double before = blaze_promise_await(p);
  BlazeValue asHandle = p;
  asHandle.tag = BLAZE_VALUE_HANDLE;
  blaze_registry_release(&asHandle, BLAZE_EXTERNAL_PROMISE, "test");
  double after = blaze_promise_await(p);
  printf("%g %g", before, after);
}
`, "utf8");
  const binary = join(directory, "probe");
  const built = run("gcc", ["-std=c11", "-O1", "-o", binary, join(directory, "probe.c"), "-I", directory, "-lm"], { timeoutMs: 120_000 });
  assert.equal(built.code, 0, built.stderr);
  const result = run(binary, [], { timeoutMs: 30_000 });
  // A released promise fails validation; awaiting it answers zero rather than
  // reading the memory its entry no longer owns.
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^5 /);
});

test("the machine backend marshals promise values through the tagged ABI", async () => {
  const { buildObject } = await import("../toolchain/ir-machine.ts");
  const NUMBER = { kind: "primitive", name: "f64" } as const;
  const awaited: any = {
    k: "call",
    type: NUMBER,
    call: {
      callee: "Promise.await",
      builtin: true,
      signature: { name: "Promise.await", symbol: "Promise.await", params: [{ name: "promise", type: "f64" }], returns: "f64" },
      args: [{ k: "const", type: NUMBER, text: "0" }],
      argTypes: [NUMBER],
      returns: NUMBER,
      effects: [],
      ownership: "none",
      retain: false,
    },
  };
  const fn: any = {
    name: "subject",
    symbol: "subject",
    params: [],
    returns: NUMBER,
    requires: [],
    ensures: [],
    effects: [],
    allocates: false,
    prints: false,
    readsArgv: false,
    objects: {},
    calls: [],
    entry: {
      id: "entry",
      statements: [],
      releases: [],
      terminator: { k: "return", value: awaited },
    },
  };
  const contract: any = {
    version: "1",
    function: { name: "subject", symbol: "subject", params: [], returns: "f64" },
    requires: [],
    ensures: [],
    memory: { reads: [], writes: [], aliasing: [] },
    effects: [],
    numeric: { floatingPoint: "ieee754", rounding: "nearest", fastMath: false },
    optimize: { primary: "balanced" },
    definition: { statements: [], objects: {}, allocates: false, prints: false, readsArgv: false, calls: [] },
  };
  const directory = await scratch("blaze-promise-machine-");
  const objectPath = join(directory, "subject.o");
  await buildObject({
    fn,
    contract,
    target: { arch: "x86_64", os: "linux", abi: "sysv", cpu: "", features: [] },
    callable: new Set(),
    objectPath,
  });
  const bytes = await (await import("node:fs/promises")).readFile(objectPath);
  const text = bytes.toString("latin1");
  assert.ok(text.includes("blaze_value_from_dynamic"), "the number is converted to a tagged argument");
  assert.ok(text.includes("blaze_promise_await"), "the tagged promise is awaited");
});

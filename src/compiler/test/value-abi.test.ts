/**
 * The tagged value ABI, as the three runtimes see it.
 *
 * The C header, the Nim adapter and the wasm host state the same record. What
 * is tested here is that they are generated from the one table, that the
 * payload keeps every bit of a double, and that a handle carries the generation
 * that stops a stale one from naming a later object. The C declarations are
 * compiled as well, because a layout that reads well in generated text but
 * does not compile is not an ABI.
 */

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../core/process.ts";
import { runtimeHeaderSource, runtimeSourceSource } from "../runtime/abi.ts";
import {
  EXTERNAL_KINDS,
  HANDLE_KINDS,
  HANDLE_INDEX_BITS,
  VALUE_LAYOUT,
  VALUE_TAGS,
  handleGenerationOf,
  handleIndexOf,
  handlePayload,
  isExternalKind,
  isHandleKind,
  isValueTag,
  valueAbiCDeclaration,
  valueAbiNimDeclaration,
  valueAbiWasmDeclaration,
} from "../runtime/value-abi.ts";
import { scratch } from "./scratch.ts";

test("the three declarations state the one record and the one numbers", () => {
  const c = valueAbiCDeclaration();
  const nim = valueAbiNimDeclaration();
  const wasm = valueAbiWasmDeclaration();

  for (const name of Object.keys(VALUE_TAGS)) {
    const number = String((VALUE_TAGS as Record<string, number>)[name]);
    assert.match(c, new RegExp(`BLAZE_VALUE_${name.toUpperCase()} = ${number}`));
    assert.match(nim, new RegExp(`^  ${name} = ${number},?$`, "m"));
    assert.match(wasm, new RegExp(`VALUE_${name.toUpperCase()} = ${number}`));
  }
  for (const name of Object.keys(HANDLE_KINDS)) {
    const number = String((HANDLE_KINDS as Record<string, number>)[name]);
    assert.match(c, new RegExp(`BLAZE_HANDLE_${name.toUpperCase()} = ${number}`));
    assert.match(nim, new RegExp(`^  ${name} = ${number},?$`, "m"));
    assert.match(wasm, new RegExp(`HANDLE_${name.toUpperCase()} = ${number}`));
  }
  for (const name of Object.keys(EXTERNAL_KINDS)) {
    assert.match(c, new RegExp(`BLAZE_EXTERNAL_${name.toUpperCase()} = `));
    assert.match(nim, new RegExp(`^  ${name} = `, "m"));
  }

  assert.equal(VALUE_LAYOUT.bytes, 16);
  assert.match(c, /uint64_t payload;\s+uint32_t tag;\s+uint32_t kind;/);
  assert.match(nim, /payload: uint64\s+tag: uint32\s+kind: uint32/);
  assert.match(wasm, /VALUE_BYTES = 16/);
});

test("the header carries the value the backends generate calls against", () => {
  const header = runtimeHeaderSource();
  assert.match(header, /typedef struct \{[\s\S]*uint64_t payload;[\s\S]*uint32_t tag;[\s\S]*uint32_t kind;[\s\S]*\} BlazeValue;/);
  assert.match(header, /BlazeValue blaze_value_number\(double number\)/);
  assert.match(header, /double blaze_value_number_of\(const BlazeValue\* value\)/);
});

test("a handle carries its slot and the generation of the slot", () => {
  const payload = handlePayload(7, 3);
  assert.equal(handleIndexOf(payload), 7);
  assert.equal(handleGenerationOf(payload), 3);
  assert.notEqual(handlePayload(7, 3), handlePayload(7, 4), "a reused slot is a different handle");
  assert.notEqual(handlePayload(7, 3), handlePayload(8, 3));
  assert.equal(HANDLE_INDEX_BITS, 32);
});

test("every declared tag and kind answers what it is, and an unknown one does not", () => {
  for (const tag of Object.values(VALUE_TAGS)) assert.ok(isValueTag(tag));
  for (const kind of Object.values(HANDLE_KINDS)) assert.ok(isHandleKind(kind));
  for (const kind of Object.values(EXTERNAL_KINDS)) assert.ok(isExternalKind(kind));
  assert.ok(!isValueTag(99));
  assert.ok(!isHandleKind(99));
  assert.ok(!isExternalKind(99));
  assert.ok(!isHandleKind(VALUE_TAGS.number), "a number is not a handle subtype");
});

test("the generated C keeps NaN, infinities and signed zero unchanged", async () => {
  const directory = await scratch("blaze-value-abi-");
  await writeFile(join(directory, "blaze_rt.h"), runtimeHeaderSource());
  await writeFile(
    join(directory, "probe.c"),
    `#include <math.h>
#include <stdio.h>
#include "blaze_rt.h"

int main(void) {
  const double values[] = { 1.0, -0.0, 1.0 / 0.0, -1.0 / 0.0, 0.0 / 0.0 };
  for (int i = 0; i < 5; i += 1) {
    BlazeValue value = blaze_value_number(values[i]);
    double back = blaze_value_number_of(&value);
    if (value.tag != BLAZE_VALUE_NUMBER) return 1;
    if (isnan(values[i]) ? !isnan(back) : values[i] != back) return 2;
    if (!isnan(values[i]) && signbit(values[i]) != signbit(back)) return 3;
  }
  BlazeValue truth = blaze_value_boolean(1);
  BlazeValue lie = blaze_value_boolean(0);
  BlazeValue none = blaze_value_null();
  if (truth.tag != BLAZE_VALUE_BOOLEAN || truth.payload != 1) return 4;
  if (lie.tag != BLAZE_VALUE_BOOLEAN || lie.payload != 0) return 5;
  if (none.tag != BLAZE_VALUE_NULL) return 6;
  BlazeValue handle = blaze_value_handle(BLAZE_HANDLE_STRING, 7, 3);
  if (!blaze_value_is_handle(&handle, BLAZE_HANDLE_STRING)) return 7;
  if (blaze_value_index(&handle) != 7 || blaze_value_generation(&handle) != 3) return 8;
  if (blaze_value_is(&handle, BLAZE_VALUE_NUMBER)) return 9;
  if (sizeof(BlazeValue) != BLAZE_VALUE_BYTES) return 10;
  return 0;
}
`,
    "utf8",
  );
  const built = run("gcc", ["-std=c11", "-O2", "-o", join(directory, "probe"), join(directory, "probe.c"), "-I", directory, "-lm"], {
    timeoutMs: 120_000,
  });
  assert.equal(built.code, 0, built.stderr);
  const result = run(join(directory, "probe"), [], { timeoutMs: 30_000 });
  assert.equal(result.code, 0, result.stdout + result.stderr);
});

/** Compiles a probe that includes the generated runtime, so its static registry is in scope. */
async function compileRuntimeProbe(directory: string, name: string, body: string): Promise<string> {
  await writeFile(join(directory, "blaze_rt.h"), runtimeHeaderSource());
  await writeFile(join(directory, "blaze_rt.c"), runtimeSourceSource("debug"));
  await writeFile(
    join(directory, `${name}.c`),
    `#include "blaze_rt.c"\nint main(void) {\n${body}\n}\n`,
    "utf8",
  );
  const binary = join(directory, name);
  const built = run("gcc", ["-std=c11", "-O1", "-o", binary, join(directory, `${name}.c`), "-I", directory, "-lm"], {
    timeoutMs: 120_000,
  });
  assert.equal(built.code, 0, built.stderr);
  return binary;
}

test("the registry answers a typed handle with its own length", async () => {
  const directory = await scratch("blaze-registry-");
  const binary = await compileRuntimeProbe(
    directory,
    "length",
    `  const char* literal = "hello";
     BlazeValue text = blaze_registry_register(BLAZE_HANDLE_STRING, (void*)literal, 5, BLAZE_ENTRY_EXTERNAL);
     if (blaze_registry_length(&text, BLAZE_HANDLE_STRING, "test") != 5) return 1;
     return 0;`,
  );
  const result = run(binary, [], { timeoutMs: 30_000 });
  assert.equal(result.code, 0, result.stdout + result.stderr);
});

test("a released handle cannot name the object that reuses its slot", async () => {
  const directory = await scratch("blaze-stale-");
  const binary = await compileRuntimeProbe(
    directory,
    "stale",
    `  BlazeValue first = blaze_registry_register(BLAZE_HANDLE_ARRAY, NULL, 3, BLAZE_ENTRY_OWNED);
     const uint32_t generation = blaze_value_generation(&first);
     blaze_registry_release(&first, BLAZE_HANDLE_ARRAY, "test");
     BlazeValue second = blaze_registry_register(BLAZE_HANDLE_ARRAY, NULL, 9, BLAZE_ENTRY_OWNED);
     if (blaze_value_index(&second) != blaze_value_index(&first)) return 1;
     if (blaze_value_generation(&second) == generation) return 2;
     blaze_registry_get(&first, BLAZE_HANDLE_ARRAY, "test");
     return 0;`,
  );
  const result = run(binary, [], { timeoutMs: 30_000 });
  assert.equal(result.code, 2, "the stale handle is refused");
  assert.match(result.stderr, /stale handle/);
});

test("a wrong handle type and an out-of-range index are refused", async () => {
  for (const [name, body, message] of [
    ["type", `  BlazeValue text = blaze_registry_register(BLAZE_HANDLE_STRING, NULL, 1, BLAZE_ENTRY_OWNED);
                blaze_registry_get(&text, BLAZE_HANDLE_RECORD, "test");
                return 0;`, /wrong handle type/],
    ["index", `  BlazeValue bad = blaze_value_handle(BLAZE_HANDLE_STRING, 9999, 1);
                 blaze_registry_get(&bad, BLAZE_HANDLE_STRING, "test");
                 return 0;`, /index out of range/],
  ] as const) {
    const directory = await scratch(`blaze-bad-handle-${name}-`);
    const binary = await compileRuntimeProbe(directory, name, body);
    const result = run(binary, [], { timeoutMs: 30_000 });
    assert.equal(result.code, 2, `${name} is refused`);
    assert.match(result.stderr, message);
  }
});

test("globals grow on demand and a slot past the table is an error", async () => {
  const directory = await scratch("blaze-globals-");
  const binary = await compileRuntimeProbe(
    directory,
    "globals",
    `  if (blaze_rt_global_set(5000.0, 17.0) != 17.0) return 1;
     if (blaze_rt_global_get(5000.0) != 17.0) return 2;
     if (blaze_rt_global_post_inc(5000.0) != 17.0) return 3;
     if (blaze_rt_global_get(5000.0) != 18.0) return 4;
     blaze_global_at(9999, "test");
     return 0;`,
  );
  const result = run(binary, [], { timeoutMs: 30_000 });
  assert.equal(result.code, 2, "an out-of-range slot is refused");
  assert.match(result.stderr, /global slot 9999 out of range/);
});

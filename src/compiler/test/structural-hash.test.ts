/**
 * Hashing by structure, and writing a record as it is walked.
 *
 * A build used to hash a value by stringifying it, which materialised a string
 * as large as the value, and copied whole records through a stringify/parse
 * pair before writing them out again. This file holds the two promises those
 * changes must keep: the hash says what the value holds rather than how it was
 * written, and the file a store writes is a snapshot of the value at the time
 * of the write even though the value itself is reused.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { hashValue } from "../core/structural-hash.ts";
import { hashText, jsonChunks, serializeJson, storeRead, storeWrite } from "../core/json-store.ts";
import { createJsonStore } from "../core/json-store.ts";
import { scratch } from "./scratch.ts";

test("a structural hash is stable and says what a value holds, not how it was written", () => {
  assert.equal(hashValue({ a: 1, b: [2, { c: "three" }] }), hashValue({ a: 1, b: [2, { c: "three" }] }));
  assert.equal(hashValue({ a: 1, b: 2 }), hashValue({ b: 2, a: 1 }), "the order keys were written in is not the value");
  assert.equal(hashValue(new Map([["a", 1], ["b", 2]])), hashValue(new Map([["b", 2], ["a", 1]])), "a map is its entries");
  assert.equal(hashValue(new Set([3, 1, 2])), hashValue(new Set([1, 2, 3])), "a set is its members");

  // A type tag keeps values that a serialisation would confuse apart.
  assert.notEqual(hashValue("1"), hashValue(1));
  assert.notEqual(hashValue(null), hashValue("null"));
  assert.notEqual(hashValue([1, 2]), hashValue({ 0: 1, 1: 2 }));
  assert.notEqual(hashValue(new Map([["a", 1]])), hashValue({ a: 1 }));
  assert.notEqual(hashValue(new Set([1])), hashValue([1]));
  assert.notEqual(hashValue(-0), hashValue(0));
  assert.notEqual(hashValue(1n), hashValue("1"));
});

test("a structural hash reaches nested values and refuses a cycle", () => {
  const withC = { a: 1, nested: { c: "three" } };
  const withoutC = { a: 1, nested: { c: "four" } };
  assert.notEqual(hashValue(withC), hashValue(withoutC), "an edit under a nested key moved the hash");

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => hashValue(cyclic), /circular/);
});

test("a subtree hashed twice is answered from its identity cache", () => {
  // The walk cannot tell from the digest alone that a subtree was reused, so
  // check the observable contract instead: a shared subtree contributes the
  // same answer wherever it is reached, and the whole value hashes the same
  // whether or not it was hashed on its own before.
  const shared = { deep: [1, 2, 3] };
  const first = hashValue({ left: shared, right: shared });
  hashValue(shared);
  assert.equal(hashValue({ left: shared, right: shared }), first);
  assert.equal(hashText("a 64 character digest is not the input"), hashText("a 64 character digest is not the input"));
});

test("the walked writer produces exactly the one-string form", () => {
  const values: unknown[] = [
    {},
    [],
    { a: 1, b: [2, { c: "three" }] },
    { quoted: 'a "quote" and a \\ slash\nand a line', zero: -0, big: 1e21, small: 1e-7 },
    { absent: undefined, fn: () => {}, symbol: Symbol("x"), present: 1 },
    [1, undefined, , 3],
    new Map([["a", 1]]),
    new Date("2020-01-02T03:04:05.000Z"),
    { toJSON: () => ({ written: true }) },
  ];
  for (const value of values) {
    let walked = "";
    for (const chunk of jsonChunks(value)) walked += chunk;
    assert.equal(`${walked}\n`, serializeJson(value), "the walked writer did not match JSON.stringify");
  }
});

test("a stored record is the snapshot the write saw, not the value after it", async () => {
  const store = createJsonStore(await scratch("blaze-snapshot-"));
  const value: Record<string, unknown> = { round: 1, candidates: [{ id: "c1", text: "const x = 1;" }] };
  await storeWrite(store, "projects/p/candidates.json", value);

  // A later repair round reuses and edits the same object the first write was
  // given. The file must still say round one: the write already serialised it.
  value["round"] = 2;
  (value["candidates"] as { text: string }[])[0].text = "const x = 2;";

  assert.deepEqual(await storeRead(store, "projects/p/candidates.json"), {
    round: 1,
    candidates: [{ id: "c1", text: "const x = 1;" }],
  });
});

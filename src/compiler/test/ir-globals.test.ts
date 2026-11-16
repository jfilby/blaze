/**
 * Globals are compiler entities.
 *
 * A module-level counter is a cell the program allocates in its contract
 * phase, not a runtime call name the lowering discovers by walking string
 * literals. These tests read the IR the compiler produces so the allocation
 * itself is what is checked, not the C a backend happens to emit from it.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { phaseOf, semanticsOf } from "./phase.ts";
import { parseSemanticFunction, printSemanticFunction } from "../semantics/ir-text.ts";

/** Every first-class global a resolved function names, with its slot. */
function globalsIn(value: unknown): { id: string; slot: number | null }[] {
  const found: { id: string; slot: number | null }[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (record["k"] === "global") found.push({ id: String(record["id"]), slot: record["slot"] as number | null });
    for (const child of Object.values(record)) walk(child);
  };
  walk(value);
  return found;
}

const MAIN = [
  'import { nextA } from "./a.ts";',
  'import { nextB } from "./b.ts";',
  "console.log(nextA(), nextB(), nextA());",
  "",
].join("\n");
const A = ["let count = 0;", "export function nextA(): number { count += 1; return count; }", ""].join("\n");
const B = ["let count = 0;", "export function nextB(): number { count += 1; return count; }", ""].join("\n");

/** Builds the two-file program twice, so determinism is observable. */
function build(): Record<string, { id: string; slot: number | null }[]> {
  const phase = phaseOf("typescript", { "main.ts": MAIN, "a.ts": A, "b.ts": B }, "main.ts");
  const semantics = semanticsOf(phase);
  const out: Record<string, { id: string; slot: number | null }[]> = {};
  for (const [name, fn] of Object.entries(semantics)) out[name] = globalsIn(fn);
  return out;
}

test("each module-level number is a first-class global with a stable id", () => {
  const once = build();
  assert.ok(once["nextA"].length > 0, "the counter is read and written through globals");
  assert.ok(once["nextB"].length > 0);
  for (const refs of Object.values(once)) {
    for (const ref of refs) {
      assert.match(ref.id, /^[A-Za-z0-9_$.]+__count$/, "the id is a word that survives IR text");
      assert.equal(typeof ref.slot, "number", "the contract phase assigned a slot");
    }
  }
});

test("allocation is deterministic and gives two files two distinct cells", () => {
  const once = build();
  const twice = build();
  assert.deepEqual(once, twice, "two compilations assign the same slots");
  const a = once["nextA"][0];
  const b = once["nextB"][0];
  assert.notEqual(a.id, b.id, "the files' counters are different globals");
  assert.notEqual(a.slot, b.slot, "and they are different cells");
});

test("every access to one global resolves to the same cell", () => {
  for (const refs of Object.values(build())) {
    const ids = new Set(refs.map((ref) => ref.id));
    for (const id of ids) {
      const slots = new Set(refs.filter((ref) => ref.id === id).map((ref) => ref.slot));
      assert.equal(slots.size, 1, `${id} has one slot across all its reads and writes`);
    }
  }
});

test("global discovery does not inspect call names or decimal string literals", async () => {
  const source = await readFile(new URL("../semantics/program.ts", import.meta.url), "utf8");
  assert.ok(!source.includes("GLOBAL_SLOT_CALLS"), "no runtime-name list");
  assert.ok(!source.includes("eachGlobalSlot"), "no literal-string walk");
  assert.ok(!source.includes("/^[0-9]+$/"), "no decimal-literal test for a global index");
  assert.ok(source.includes('record["k"] === "global"'), "discovery reads the global value's kind");
});

test("a global survives the IR text round trip with its resolved slot", () => {
  const phase = phaseOf("typescript", { "main.ts": MAIN, "a.ts": A, "b.ts": B }, "main.ts");
  const fn = semanticsOf(phase)["nextA"];
  const text = printSemanticFunction(fn);
  assert.match(text, /global\[f64\] a\.ts__count 0/);
  const parsed = parseSemanticFunction(text, phase.program);
  const refs = globalsIn(parsed);
  assert.ok(refs.length > 0, "the parsed body still names its globals");
  for (const ref of refs) {
    assert.equal(ref.id, "a.ts__count");
    assert.equal(ref.slot, 0);
  }
});

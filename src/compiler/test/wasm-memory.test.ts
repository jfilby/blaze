/**
 * The WebAssembly memory plan.
 *
 * Scratch, constants and the host's allocator are one layout, produced once
 * from measured requirements and handed to the module and the host as a plan.
 * These tests check the plan's arithmetic, its validation, and that both sides
 * of a compiled module are written from the same finalized artifact.
 */

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";

import { compileWasm, ENTRY_EXPORT } from "../toolchain/ir-wasm.ts";
import { DATA_BASE_EXPORT, generateWasmProgramHost } from "../toolchain/wasm.ts";
import { TEXT, type SemanticFunction } from "../core/semantic-ir.ts";
import {
  WASM_HOST_OVERHEAD,
  WASM_NULL_GUARD,
  WASM_PAGE_SIZE,
  WASM_REGION_ALIGNMENT,
  planWasmMemory,
  validateWasmMemoryPlan,
  wasmAddressOf,
  wasmAddressPlus,
  wasmAlignUp,
  type WasmMemoryPlan,
} from "../toolchain/wasm-memory.ts";
import { resolveProgram } from "../semantics/ir-resolve.ts";
import { phaseOf, semanticsOf } from "./phase.ts";
import { run } from "../core/process.ts";
import { scratch } from "./scratch.ts";

/** The parts of the engine a case here drives a module with. */
interface Engine {
  Memory: new (shape: { initial: number }) => { buffer: ArrayBuffer };
  Module: new (bytes: Uint8Array) => object;
  Instance: new (module: object, imports: object) => { exports: Record<string, unknown> };
}

const engine = (globalThis as { WebAssembly?: Engine }).WebAssembly;
assert.ok(engine !== undefined, "the engine carries modules");

/** The regions a plan lays out, in order. */
function names(plan: WasmMemoryPlan): string[] {
  return plan.regions.map((region) => region.name);
}

/** The declared minimum of the memory a module imports, read from its bytes. */
function importedMemoryMinimum(bytes: Uint8Array): number {
  let at = 8;
  const varuint = (): number => {
    let value = 0;
    let shift = 0;
    let byte = 0;
    do {
      byte = bytes[at++] as number;
      value |= (byte & 0x7f) << shift;
      shift += 7;
    } while ((byte & 0x80) !== 0);
    return value;
  };
  const skipName = (): void => {
    const length = varuint();
    at += length;
  };
  while (at < bytes.length) {
    const id = bytes[at++] as number;
    const size = varuint();
    const end = at + size;
    if (id === 2) {
      const count = varuint();
      for (let index = 0; index < count; index += 1) {
        skipName(); // module
        skipName(); // imported name
        const kind = bytes[at++] as number;
        if (kind === 0x02) {
          varuint(); // flags
          return varuint(); // minimum
        }
      }
    }
    at = end;
  }
  throw new Error("the module does not import a memory");
}

test("every region is derived from the measured requirements", () => {
  const plan = planWasmMemory({ scratchSizes: [100, 200], staticSize: 50 });
  assert.deepEqual(names(plan), ["reserved", "wide", "static", "runtime"]);
  assert.equal(plan.reserved.offset, 0);
  assert.equal(plan.reserved.size, WASM_NULL_GUARD);
  assert.equal(plan.wide.offset, WASM_NULL_GUARD);
  assert.equal(plan.wide.size, wasmAlignUp(300, WASM_REGION_ALIGNMENT));
  assert.deepEqual([...plan.scratchBases], [0, 100]);
  assert.equal(plan.static.offset, WASM_NULL_GUARD + plan.wide.size);
  assert.equal(plan.static.size, wasmAlignUp(50, WASM_REGION_ALIGNMENT));
  assert.equal(plan.runtime.offset, plan.static.offset + plan.static.size);
  assert.equal(plan.dataBase, plan.runtime.offset);
  assert.equal(plan.pages, 1);
  assert.equal(plan.capacity, plan.totalPages * WASM_PAGE_SIZE);
  assert.ok(plan.runtime.size > 0, "the host has room to allocate");
  assert.notEqual(plan.static.offset, 4096, "the constants are not parked at a fixed address");
});

test("the null guard covers the header the host reads below a pointer", () => {
  assert.ok(WASM_NULL_GUARD >= WASM_HOST_OVERHEAD, "a literal's header is read inside memory");
  const plan = planWasmMemory({ scratchSizes: [], staticSize: 1 });
  assert.ok(plan.static.offset >= WASM_HOST_OVERHEAD);
  assert.ok(wasmAddressOf(plan, { kind: "static", fn: -1, offset: 0 }) >= WASM_HOST_OVERHEAD);
});

test("static data past a page raises the module's minimum", () => {
  const plan = planWasmMemory({ scratchSizes: [], staticSize: 2 * WASM_PAGE_SIZE + 1 });
  assert.equal(plan.pages, 3);
  assert.ok(plan.runtime.offset > 2 * WASM_PAGE_SIZE);
  assert.ok(plan.capacity > plan.runtime.offset);
  assert.ok(plan.pages >= 3, "the pages follow the data rather than a fixed import");
});

test("wide scratch past a page is allocated and raises the minimum", () => {
  const plan = planWasmMemory({ scratchSizes: [WASM_PAGE_SIZE, WASM_PAGE_SIZE], staticSize: 0 });
  assert.ok(plan.wide.size >= 2 * WASM_PAGE_SIZE);
  assert.ok(plan.pages >= 3);
  assert.equal(plan.scratchBases[1], WASM_PAGE_SIZE);
});

test("page and alignment arithmetic is validated", () => {
  assert.throws(() => planWasmMemory({ scratchSizes: [], staticSize: 50, alignment: 3 }), /power of two/);
  assert.throws(() => planWasmMemory({ scratchSizes: [-1], staticSize: 0 }), /non-negative integer/);
  assert.throws(() => planWasmMemory({ scratchSizes: [], staticSize: Number.MAX_SAFE_INTEGER }), /integer/);
  assert.equal(wasmAlignUp(17, 16), 32);
  assert.equal(wasmAlignUp(32, 16), 32);
});

test("invalid regions are refused", () => {
  const plan = planWasmMemory({ scratchSizes: [32], staticSize: 16 });
  const [guard, wide, statics, runtime] = plan.regions;
  const overlapping: WasmMemoryPlan = { ...plan, regions: [guard, wide, statics, { ...runtime, offset: statics.offset }] };
  assert.throws(() => validateWasmMemoryPlan(overlapping), /overlapping/);
  const escaping: WasmMemoryPlan = { ...plan, regions: [guard, wide, statics, { ...runtime, size: runtime.size + 1 }] };
  assert.throws(() => validateWasmMemoryPlan(escaping), /out of bounds/);
  const unaligned: WasmMemoryPlan = { ...plan, regions: [guard, wide, { ...statics, offset: statics.offset + 1 }, runtime] };
  assert.throws(() => validateWasmMemoryPlan(unaligned), /unaligned/);
  const wrongCapacity: WasmMemoryPlan = { ...plan, capacity: plan.capacity - 1 };
  assert.throws(() => validateWasmMemoryPlan(wrongCapacity), /capacity/);
  const wrongBase: WasmMemoryPlan = { ...plan, dataBase: plan.dataBase + 1 };
  assert.throws(() => validateWasmMemoryPlan(wrongBase), /data base/);
});

test("addresses resolve inside their region and boundary violations are refused", () => {
  const plan = planWasmMemory({ scratchSizes: [32, 64], staticSize: 16 });
  assert.equal(wasmAddressOf(plan, { kind: "static", fn: -1, offset: 0 }), plan.static.offset);
  assert.equal(wasmAddressOf(plan, { kind: "scratch", fn: 1, offset: 0 }), plan.wide.offset + 32);
  assert.equal(wasmAddressPlus({ kind: "scratch", fn: 1, offset: 0 }, 8).offset, 8);
  assert.throws(() => wasmAddressOf(plan, { kind: "static", fn: -1, offset: plan.static.size }), /static.*out of bounds/);
  assert.throws(() => wasmAddressOf(plan, { kind: "scratch", fn: 1, offset: 64 }), /scratch.*out of bounds/);
  assert.throws(() => wasmAddressOf(plan, { kind: "scratch", fn: 2, offset: 0 }), /no function 2/);
  assert.throws(() => wasmAddressOf(plan, { kind: "scratch", fn: 0, offset: 32 }), /scratch.*out of bounds/);
});

test("a module whose constants span pages declares those pages", () => {
  const fn: SemanticFunction = {
    name: "subject",
    symbol: "subject",
    params: [],
    returns: TEXT,
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
      terminator: { k: "return", value: { k: "text", type: TEXT, parts: [{ k: "text", value: "x".repeat(2 * WASM_PAGE_SIZE) }] } },
    },
  };
  const compiled = compileWasm({ functions: [{ fn }] });
  assert.ok(compiled.plan.pages >= 3, "two pages of text plus the guard need three pages");
  assert.equal(importedMemoryMinimum(compiled.module), compiled.plan.pages);
  const memory = new engine.Memory({ initial: compiled.plan.totalPages });
  const instance = new engine.Instance(new engine.Module(compiled.module), { env: { memory, pow: Math.pow } });
  assert.equal((instance.exports[DATA_BASE_EXPORT] as { value: number }).value, compiled.plan.dataBase);
});

test("the module, its plan and the host are written from one compilation", () => {
  const files = {
    "main.ts": ['import { twice } from "./lib.ts";', "console.log(twice(21));", ""].join("\n"),
    "lib.ts": [
      "export function plus(a: number, b: number): number { return a + b; }",
      "export function twice(a: number): number { return plus(a, a); }",
      'export function printer(): number { console.log("x"); return 1; }',
      "",
    ].join("\n"),
  };
  // `twice` is lowered first, before `printer` imports anything. Its call of
  // `plus` is resolved after all imports are known, not against a count the
  // first lowering happened to see.
  const phase = phaseOf("typescript", files, "main.ts");
  assert.ok(phase.body !== undefined);
  const driver = resolveProgram(phase.body, phase.program);
  const semantics = semanticsOf(phase);
  const compiled = compileWasm({
    functions: [
      { fn: semantics.twice },
      { fn: semantics.plus },
      { fn: semantics.printer },
    ],
    entry: driver.entry,
  });
  assert.ok(compiled.imports.length > 0, "a later function imported services");
  assert.equal(importedMemoryMinimum(compiled.module), compiled.plan.pages);

  const memory = new engine.Memory({ initial: compiled.plan.totalPages });
  const imports: Record<string, unknown> = { memory, pow: Math.pow };
  for (const service of compiled.imports) imports[service] = () => 0;
  const instance = new engine.Instance(new engine.Module(compiled.module), { env: imports });
  const exports = instance.exports as Record<string, unknown>;
  const dataBase = exports[DATA_BASE_EXPORT] as { value: number };
  assert.equal(dataBase.value, compiled.plan.dataBase);
  const twice = exports["twice"] as (value: number) => number;
  assert.equal(twice(21), 42, "the call index is resolved against the final import count");

  const host = generateWasmProgramHost({
    services: compiled.imports,
    memoryPlan: compiled.plan,
    entry: ENTRY_EXPORT,
  });
  assert.match(host, new RegExp(`memory = new WebAssembly\\.Memory\\({ initial: ${compiled.plan.totalPages} }\\)`));
  assert.match(host, new RegExp(`cursor = ${compiled.plan.dataBase};`));
  assert.match(host, new RegExp(`const ALLOC_LIMIT = ${compiled.plan.capacity};`));
  assert.match(host, new RegExp(`memory\.buffer\.byteLength < ${compiled.plan.pages * WASM_PAGE_SIZE}`));
});

test("a host with no room left fails allocation explicitly", async () => {
  const files = { "main.ts": ["console.log(`n=${42}`);", ""].join("\n") };
  const phase = phaseOf("typescript", files, "main.ts");
  assert.ok(phase.body !== undefined);
  const driver = resolveProgram(phase.body, phase.program);
  const compiled = compileWasm({
    functions: Object.values(semanticsOf(phase)).map((fn) => ({ fn })),
    entry: driver.entry,
  });
  const exhausted = { ...compiled.plan, capacity: compiled.plan.dataBase + 1 };
  const directory = await scratch("blaze-wasm-exhaust-");
  const modulePath = join(directory, "program.wasm");
  const hostPath = join(directory, "program.host.mjs");
  await writeFile(modulePath, compiled.module);
  await writeFile(
    hostPath,
    generateWasmProgramHost({ services: compiled.imports, memoryPlan: exhausted, entry: ENTRY_EXPORT }),
  );
  const result = run(process.execPath, [hostPath, modulePath], { timeoutMs: 60_000 });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /planned memory region/, "exhaustion is reported, not silently aliased");
});

test("no fixed memory-layout constants remain in the compiler or the host", async () => {
  const lowering = await readFile(new URL("../toolchain/ir-wasm.ts", import.meta.url), "utf8");
  assert.ok(!lowering.includes("WIDE_DATA_BASE"), "no hard-coded constants base");
  assert.ok(!lowering.includes("SCRATCH_LIMIT"), "no hard-coded scratch ceiling");
  assert.equal(lowering.match(/lower\(module, one/g)?.length, 1, "the body is lowered once");

  const host = await readFile(new URL("../toolchain/wasm-host-runtime.ts", import.meta.url), "utf8");
  assert.ok(!host.includes("cursor = 65536"), "the host does not start at a fixed address");
  assert.ok(!host.includes("const PAGE = 65536"), "the page size is declared once");
  const wasm = await readFile(new URL("../toolchain/wasm.ts", import.meta.url), "utf8");
  assert.ok(!wasm.includes(": 65536"), "the host's fallback uses the shared page size");
});

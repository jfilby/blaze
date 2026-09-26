import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateWasmHost, wasmSignature, wasmValueType } from "../toolchain/wasm.ts";
import { parseType } from "../semantics/contract.ts";
import { run } from "../core/process.ts";
import { encodeRunRequest, type TestVector } from "../toolchain/verifier.ts";
import type { FunctionContract } from "../core/types.ts";

/** The WebAssembly surface this test uses; @types/node does not declare it. */
interface WasmModuleHandle {
  readonly bytes: Uint8Array;
}
declare const WebAssembly: {
  validate(bytes: Uint8Array): boolean;
  Module: {
    new (bytes: Uint8Array): WasmModuleHandle;
    imports(module: WasmModuleHandle): { module: string; name: string; kind: string }[];
    exports(module: WasmModuleHandle): { name: string; kind: string }[];
  };
};

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
  optimize: { primary: "throughput" },
};

/**
 * A hand assembled module that imports the host's memory and returns a
 * constant. It exercises the whole host path: module validation, buffer
 * placement, the wasm call and result formatting, without a WAT assembler.
 */
function constantModuleBytes(): Uint8Array {
  const utf8 = (text: string): number[] => [...text].map((character) => character.charCodeAt(0));
  /** A length prefixed vector of bytes, as used for names. */
  const bytes = (items: number[]): number[] => [items.length, ...items];
  /** A section: id, byte size, body. */
  const section = (id: number, body: number[]): number[] => [id, body.length, ...body];

  // Type section: one function type, (i32, i32, i32) -> f32.
  const types = section(1, [1, 0x60, 0x03, 0x7f, 0x7f, 0x7f, 0x01, 0x7d]);
  // Import section: one memory import named env.memory with four pages.
  const imports = section(2, [1, ...bytes(utf8("env")), ...bytes(utf8("memory")), 0x02, 0x00, 0x04]);
  // Function section: the one defined function uses type 0.
  const functions = section(3, [1, 0x00]);
  // Export section: "dotProduct" is function 0, the only import is a memory.
  const exports = section(7, [1, ...bytes(utf8("dotProduct")), 0x00, 0x00]);
  // Code section: no locals, f32.const 42, end.
  const body = [0x00, 0x43, 0x00, 0x00, 0x28, 0x42, 0x0b];
  const code = section(10, [1, body.length, ...body]);

  return new Uint8Array([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...types,
    ...imports,
    ...functions,
    ...exports,
    ...code,
  ]);
}

test("contract types map onto WebAssembly value types", () => {
  assert.equal(wasmValueType(parseType("usize")), "i32");
  assert.equal(wasmValueType(parseType("f32")), "f32");
  assert.equal(wasmValueType(parseType("f64")), "f64");
  assert.equal(wasmValueType(parseType("u64")), "i64");
  assert.equal(wasmValueType(parseType("ptr<f32>")), "i32");
  assert.equal(wasmSignature(CONTRACT), "(func (param i32 i32 i32) (result f32))");
});

test("the hand assembled module satisfies the host import and export contract", () => {
  const module = new WebAssembly.Module(constantModuleBytes());
  const imports = WebAssembly.Module.imports(module);
  assert.deepEqual(
    imports.map((entry) => `${entry.module}.${entry.name}:${entry.kind}`),
    ["env.memory:memory"],
  );
  assert.deepEqual(
    WebAssembly.Module.exports(module).map((entry) => entry.name),
    ["dotProduct"],
  );
});

test("the host calls the module, places buffers in its memory and prints results", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blaze-wasm-"));
  const hostPath = join(directory, "host.mjs");
  const modulePath = join(directory, "candidate.wasm");
  await writeFile(hostPath, generateWasmHost(CONTRACT), "utf8");
  await writeFile(modulePath, constantModuleBytes());

  const vector: TestVector = {
    id: "two-elements",
    kind: "fixed",
    args: { a: ["1.5", "-2.25"], b: ["2", "4"], n: "2" },
  };
  const execution = run(process.execPath, [hostPath, modulePath], {
    input: encodeRunRequest(CONTRACT, [vector]),
    timeoutMs: 60_000,
  });

  assert.equal(execution.code, 0, execution.stderr);
  assert.equal(execution.stdout.trim(), "RESULT 42");
});

test("the host reports a module that does not export the contracted function", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blaze-wasm-"));
  const hostPath = join(directory, "host.mjs");
  const modulePath = join(directory, "candidate.wasm");
  const renamed = { ...CONTRACT, function: { ...CONTRACT.function, name: "otherName" } };
  await writeFile(hostPath, generateWasmHost(renamed), "utf8");
  await writeFile(modulePath, constantModuleBytes());

  const execution = run(process.execPath, [hostPath, modulePath], { input: "run\n0 0 0\n", timeoutMs: 60_000 });
  assert.notEqual(execution.code, 0);
  assert.match(execution.stderr, /does not export otherName/);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWasm, generateWasmHost, wasmSignature, wasmValueType } from "../toolchain/wasm.ts";
import { parseType } from "../semantics/contract.ts";
import { CompilerError } from "../core/errors.ts";
import { run } from "../core/process.ts";
import { encodeRunRequest, type TestVector } from "../toolchain/verifier.ts";
import type { FunctionContract } from "../core/types.ts";
import { dotProductBody } from "./definition.ts";

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

/** The bytes of a WebAssembly value type, as the type section spells them. */
const VALUE_TYPE_BYTES: Record<string, number> = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c };

/** The parameter types of a contract, as the module boundary spells them. */
function parameterTypeBytes(contract: FunctionContract): number[] {
  return contract.function.params.map((param) => VALUE_TYPE_BYTES[wasmValueType(parseType(param.type))]);
}

/**
 * A hand assembled module that imports the host's memory, exports one name
 * and returns a constant. It exercises the whole host path: module
 * validation, buffer placement, the wasm call and result formatting, without
 * a WAT assembler.
 */
function constantModuleBytes(exportName: string, parameters: readonly number[] = parameterTypeBytes(CONTRACT), result = 0x7d): Uint8Array {
  const utf8 = (text: string): number[] => [...text].map((character) => character.charCodeAt(0));
  /** A length prefixed vector of bytes, as used for names. */
  const bytes = (items: number[]): number[] => [items.length, ...items];
  /** A section: id, byte size, body. */
  const section = (id: number, body: number[]): number[] => [id, body.length, ...body];

  // Type section: one function type, parameters -> result.
  const types = section(1, [1, 0x60, parameters.length, ...parameters, 0x01, result]);
  // Import section: one memory import named env.memory with four pages.
  const imports = section(2, [1, ...bytes(utf8("env")), ...bytes(utf8("memory")), 0x02, 0x00, 0x04]);
  // Function section: the one defined function uses type 0.
  const functions = section(3, [1, 0x00]);
  // Export section: the given name is function 0, the only import is a memory.
  const exports = section(7, [1, ...bytes(utf8(exportName)), 0x00, 0x00]);
  // Code section: no locals, the constant 42 in the result type, end. An i64
  // result carries -1, which reads unsigned as 2^64 - 1: a value a wasm module
  // can express that a JavaScript BigInt prints as a negative number.
  const body =
    result === 0x7d
      ? [0x00, 0x43, 0x00, 0x00, 0x28, 0x42, 0x0b]
      : result === 0x7e
        ? [0x00, 0x42, 0x7f, 0x0b]
        : [0x00, 0x41, 0x2a, 0x0b];
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

/**
 * A module that reads the last element of the buffer it is given and returns
 * it: `p + n - 1` loaded at the width of the element. The last element is the
 * one that tells the two layouts apart: at a four byte stride the bytes of a
 * narrower buffer are followed by three zero bytes each, so the last element
 * of a three element `u8` buffer lands where the module reads a zero.
 */
function lastElementModuleBytes(exportName: string, scale: number, load: readonly number[]): Uint8Array {
  const utf8 = (text: string): number[] => [...text].map((character) => character.charCodeAt(0));
  const bytes = (items: number[]): number[] => [items.length, ...items];
  const section = (id: number, body: number[]): number[] => [id, body.length, ...body];

  const types = section(1, [1, 0x60, 0x02, 0x7f, 0x7e, 0x01, 0x7f]);
  const imports = section(2, [1, ...bytes(utf8("env")), ...bytes(utf8("memory")), 0x02, 0x00, 0x04]);
  const functions = section(3, [1, 0x00]);
  const exports = section(7, [1, ...bytes(utf8(exportName)), 0x00, 0x00]);
  // No locals: local.get 0, then the last index at the width of the element,
  // then the load, end. The module scales the index itself: a pointer is a
  // byte offset, so how far apart the elements sit is the module's business.
  const body = [
    0x00,
    0x20,
    0x00,
    0x20,
    0x01,
    0xa7,
    0x41,
    0x01,
    0x6b,
    0x41,
    scale,
    0x6c,
    0x6a,
    ...load,
    0x0b,
  ];
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

test("a buffer of a narrow element is laid out one element to its own width", async () => {
  const cases: { type: string; returns: string; scale: number; load: number[]; values: string[] }[] = [
    { type: "ptr<u8>", returns: "u8", scale: 1, load: [0x2d, 0x00, 0x00], values: ["1", "2", "250"] },
    { type: "ptr<u16>", returns: "u16", scale: 2, load: [0x2f, 0x01, 0x00], values: ["1", "2", "60000"] },
  ];

  for (const one of cases) {
    const directory = await mkdtemp(join(tmpdir(), "blaze-wasm-"));
    const contract: FunctionContract = {
      ...CONTRACT,
      function: {
        name: "last",
        symbol: "last",
        params: [
          { name: "a", type: one.type },
          { name: "n", type: "usize" },
        ],
        returns: one.returns,
      },
      requires: ["a != null"],
      ensures: [],
      memory: { reads: ["a[0:n]"], writes: [], aliasing: [] },
    };
    const [hostPath, modulePath] = await hostIn(directory, contract, lastElementModuleBytes("last", one.scale, one.load));
    const vectors: TestVector[] = [
      { id: "only", kind: "fixed", args: { a: one.values, n: String(one.values.length) } },
    ];

    const execution = run(process.execPath, [hostPath, modulePath], {
      input: encodeRunRequest(contract, vectors),
      timeoutMs: 60_000,
    });
    assert.equal(execution.code, 0, `${one.type}: ${execution.stderr}`);
    assert.equal(execution.stdout.trim(), `RESULT ${one.values[2]}`, one.type);
  }
});

/** A contract whose entry the frontend renames, as a TypeScript program is. */
const RENAMED: FunctionContract = {
  ...CONTRACT,
  function: { ...CONTRACT.function, name: "main", symbol: "blaze_main" },
};

/** A host and a module written to a directory of their own, ready to run. */
async function hostIn(directory: string, contract: FunctionContract, module: Uint8Array): Promise<[string, string]> {
  const hostPath = join(directory, "host.mjs");
  const modulePath = join(directory, "candidate.wasm");
  await writeFile(hostPath, generateWasmHost(contract), "utf8");
  await writeFile(modulePath, module);
  return [hostPath, modulePath];
}

test("contract types map onto WebAssembly value types", () => {
  assert.equal(wasmValueType(parseType("usize")), "i64");
  assert.equal(wasmValueType(parseType("f32")), "f32");
  assert.equal(wasmValueType(parseType("f64")), "f64");
  assert.equal(wasmValueType(parseType("u64")), "i64");
  assert.equal(wasmValueType(parseType("ptr<f32>")), "i32");
  // `usize` is 64 bits wide, so it cannot be the i32 a pointer is: a module
  // that took one could not be handed a length the contract promises.
  assert.equal(wasmSignature(CONTRACT), "(func (param i32 i32 i64) (result f32))");
});

test("the hand assembled module satisfies the host import and export contract", () => {
  const module = new WebAssembly.Module(constantModuleBytes("dotProduct"));
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
  const [hostPath, modulePath] = await hostIn(directory, CONTRACT, constantModuleBytes("dotProduct"));

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
  const [hostPath, modulePath] = await hostIn(directory, CONTRACT, constantModuleBytes("otherName"));

  const execution = run(process.execPath, [hostPath, modulePath], { input: "run\n0 0 0\n", timeoutMs: 60_000 });
  assert.notEqual(execution.code, 0);
  assert.match(execution.stderr, /does not export dotProduct/);
});

test("the host calls the export the contract renames its entry to", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blaze-wasm-"));
  // A candidate that follows the prompt exports the symbol, and the host has
  // to be looking for the same name the module boundary is checked against.
  const [hostPath, modulePath] = await hostIn(directory, RENAMED, constantModuleBytes("blaze_main"));

  const execution = run(process.execPath, [hostPath, modulePath], { input: "run\n0 0 0\n", timeoutMs: 60_000 });
  assert.equal(execution.code, 0, execution.stderr);
  assert.equal(execution.stdout.trim(), "RESULT 42");
});

test("a module that exports the unrenamed name is not the contracted function", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blaze-wasm-"));
  const [hostPath, modulePath] = await hostIn(directory, RENAMED, constantModuleBytes("main"));

  const execution = run(process.execPath, [hostPath, modulePath], { input: "run\n0 0 0\n", timeoutMs: 60_000 });
  assert.notEqual(execution.code, 0);
  assert.match(execution.stderr, /does not export blaze_main/);
});

test("the module boundary is checked against the symbol the contract renames to", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blaze-wasm-"));
  // Every rejection a wasm build raises names the function it is about, and
  // the one the module is checked against.
  await assert.rejects(
    buildWasm({
      text: "   \n",
      contract: RENAMED,
      textPath: join(directory, "candidate.wat"),
      modulePath: join(directory, "candidate.wasm"),
      hostPath: join(directory, "host.mjs"),
      candidate: "c1",
    }),
    (error: unknown) => {
      assert.ok(error instanceof CompilerError);
      assert.equal(error.functionName, "blaze_main");
      return true;
    },
  );
});

test("the host runs a contract that takes nothing, whose vectors are blank lines", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blaze-wasm-"));
  const contract: FunctionContract = {
    ...CONTRACT,
    function: { name: "answer", symbol: "blaze_answer", params: [], returns: "i32" },
    requires: [],
    ensures: ["result == 42"],
    memory: { reads: [], writes: [], aliasing: [] },
  };
  const [hostPath, modulePath] = await hostIn(directory, contract, constantModuleBytes("blaze_answer", [], 0x7f));
  const vectors: TestVector[] = [
    { id: "first", kind: "fixed", args: {} },
    { id: "second", kind: "random", args: {} },
  ];

  // A vector of a function with no parameters is an empty line, and the host
  // has to read one per vector rather than skip past them.
  assert.equal(encodeRunRequest(contract, vectors), "run\n\n\n");
  const execution = run(process.execPath, [hostPath, modulePath], {
    input: encodeRunRequest(contract, vectors),
    timeoutMs: 60_000,
  });
  assert.equal(execution.code, 0, execution.stderr);
  assert.equal(execution.stdout, "RESULT 42\nRESULT 42\n");
});

test("an unsigned 64 bit result is printed as the unsigned number it is", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blaze-wasm-"));
  const contract: FunctionContract = {
    ...CONTRACT,
    function: { name: "big", symbol: "blaze_big", params: [], returns: "u64" },
    requires: [],
    ensures: [],
    memory: { reads: [], writes: [], aliasing: [] },
  };
  // A wasm i64 arrives as a JavaScript BigInt, which prints signed. A value
  // from 2^63 up therefore came back as a negative number for a candidate
  // that returned exactly what the contract promised, while the native
  // harness printed the same result unsigned.
  const [hostPath, modulePath] = await hostIn(directory, contract, constantModuleBytes("blaze_big", [], 0x7e));
  const vectors: TestVector[] = [{ id: "only", kind: "fixed", args: {} }];
  const execution = run(process.execPath, [hostPath, modulePath], {
    input: encodeRunRequest(contract, vectors),
    timeoutMs: 60_000,
  });
  assert.equal(execution.code, 0, execution.stderr);
  assert.equal(execution.stdout, "RESULT 18446744073709551615\n");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TRITON_ABI,
  isTritonSymbol,
  tritonHeaderSource,
  usesTritonSource,
} from "../runtime/triton.ts";
import { tritonAdapterSource } from "../runtime/triton-build.ts";
import { isRuntimeSymbol } from "../runtime/abi.ts";

test("the Triton ABI declares every entry the API promises", () => {
  const header = tritonHeaderSource();
  for (const entry of TRITON_ABI) {
    assert.ok(header.includes(entry.symbol), `${entry.symbol} must be declared in the Triton header`);
    assert.ok(entry.summary.length > 0, `${entry.symbol} must say what it does`);
    assert.ok(entry.ownership.length > 0, `${entry.symbol} must say what it owns`);
  }
  const symbols = TRITON_ABI.map((entry) => entry.symbol);
  assert.equal(new Set(symbols).size, symbols.length, "no entry point is declared twice");
});

test("the Triton header declares the entry points with the types the ABI holds", () => {
  const header = tritonHeaderSource();
  assert.match(header, /int blaze_triton_device_init\(void\);/);
  assert.match(header, /void blaze_triton_device_sync\(void\);/);
  assert.match(header, /void\* blaze_triton_malloc\(size_t bytes\);/);
  assert.match(header, /void blaze_triton_free\(void\* ptr\);/);
  assert.match(header, /blaze_triton_memcpy_h2d/);
  assert.match(header, /blaze_triton_memcpy_d2h/);
  assert.match(header, /int blaze_triton_launch\(/);
});

test("the Triton header keeps device types out of it", () => {
  const header = tritonHeaderSource();
  assert.ok(!header.includes("CUdevice"), "the Triton header must not expose device types");
  assert.ok(!header.includes("cuda"), "the Triton header must not expose device types");
});

test("Triton symbols are allowed by the runtime symbol boundary", () => {
  for (const entry of TRITON_ABI) {
    assert.ok(isTritonSymbol(entry.symbol), `${entry.symbol} must be a Triton symbol`);
    assert.ok(isRuntimeSymbol(entry.symbol), `${entry.symbol} must be a generatable symbol`);
  }
  assert.ok(!isTritonSymbol("blaze_rt_allocate"), "a core runtime symbol is not a Triton symbol");
  assert.ok(!isTritonSymbol("blaze_triton_unknown"), "an unknown symbol is not a Triton symbol");
});

test("the adapter implements exactly the entry points the ABI names", () => {
  const source = tritonAdapterSource();
  const written = [...source.matchAll(/^(?:[a-zA-Z][a-zA-Z0-9_\* ]+\s+)+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gm)].map((match) => match[1]).filter((name) => name.startsWith("blaze_triton_"));
  for (const entry of TRITON_ABI) {
    assert.ok(written.includes(entry.symbol), `the adapter must implement ${entry.symbol}`);
  }
  assert.equal(new Set(written).size, TRITON_ABI.length, "the adapter implements nothing the ABI does not name");
  assert.equal(written.length, TRITON_ABI.length, "each entry point implemented once");
});

test("a source that uses Triton is detected", () => {
  assert.ok(usesTritonSource("import triton.language as tl"), "triton imports are detected");
  assert.ok(usesTritonSource("@triton.jit\ndef f():\n    pass\n"), "triton.jit is detected");
  assert.ok(usesTritonSource("tl.load(x)"), "tl.load is detected");
  assert.ok(usesTritonSource("add_kernel[(1,)]()"), "kernel grid launch is detected");
  assert.ok(!usesTritonSource("console.log(\"hello\");"), "normal sources are not detected");
});

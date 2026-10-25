/**
 * The Python frontend on a subset of Triton's source: decorators, `tl.*`
 * builtins, `tl.constexpr`, and the constructs Triton uses that remain outside
 * the subset refused by name with the line they were written on.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
// import { diagnostic } from "./phase.ts";
import { pythonFrontend } from "../semantics/python.ts";

test("a triton kernel is read with decorators, imports and tl.constexpr", () => {
  const source = [
    "import triton",
    "import triton.language as tl",
    "",
    "@triton.jit",
    "def add_kernel(x_ptr: int, y_ptr: int, out_ptr: int, n_elements: int, BLOCK_SIZE: tl.constexpr) -> None:",
    "    pass",
    "",
  ].join("\n");
  const analysis = pythonFrontend.analyze(source, "kernel.py");
  assert.equal(analysis.functions.length, 1);
  const handle = (analysis.functions[0] as any).handle;
  assert.deepEqual(handle.decorators, ["triton.jit"]);
});

test("tl.load, tl.store, tl.program_id, tl.arange are accepted by the frontend", () => {
  const source = [
    "import triton.language as tl",
    "",
    "@triton.jit",
    "def add_kernel(x_ptr: int, y_ptr: int, out_ptr: int, n: int, BLOCK: tl.constexpr) -> None:",
    "    pid = tl.program_id(axis=0)",
    "    offsets = pid * BLOCK + tl.arange(0, BLOCK)",
    "    mask = offsets < n",
    "    x = tl.load(x_ptr + offsets, mask=mask)",
    "    tl.store(out_ptr + offsets, x, mask=mask)",
    "",
  ].join("\n");
  const analysis = pythonFrontend.analyze(source, "kernel.py");
  assert.equal(analysis.functions.length, 1);
});

test("tl.math.exp is accepted by the frontend", () => {
  const source = [
    "import triton.language as tl",
    "",
    "@triton.jit",
    "def exp_kernel(x: float) -> float:",
    "    return tl.math.exp(x)",
    "",
  ].join("\n");
  const analysis = pythonFrontend.analyze(source, "kernel.py");
  assert.equal(analysis.functions.length, 1);
});

test("named arguments are accepted in triton calls", () => {
  const source = [
    "import triton.language as tl",
    "",
    "@triton.jit",
    "def add_kernel(x_ptr: int, y_ptr: int, out_ptr: int, n: int, BLOCK: tl.constexpr) -> None:",
    "    pid = tl.program_id(axis=0)",
    "    offsets = pid * BLOCK + tl.arange(0, BLOCK)",
    "    mask = offsets < n",
    "    x = tl.load(x_ptr + offsets, mask=mask)",
    "    y = tl.load(y_ptr + offsets, mask=mask)",
    "    out = x + y",
    "    tl.store(out_ptr + offsets, out, mask=mask)",
    "",
  ].join("\n");
  const analysis = pythonFrontend.analyze(source, "kernel.py");
  assert.equal(analysis.functions.length, 1);
});

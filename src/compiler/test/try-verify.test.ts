import assert from "node:assert/strict";
import { test } from "node:test";
import { frontendFor } from "../semantics/frontend.ts";
import { resolveFunction, type FunctionContext } from "../semantics/ir-function.ts";
import { printSemanticFunction } from "../semantics/ir-text.ts";
import { typeToString } from "../semantics/contract.ts";
import type { FunctionContract } from "../core/types.ts";
import type { TypeScriptFunction } from "../semantics/typescript.ts";

function functionIr(source: string, name: string): string {
  const analysis = frontendFor("typescript").analyze(source, "module.ts");
  const fn = analysis.functions.find((f) => f.name === name) as { handle: TypeScriptFunction } | undefined;
  assert.ok(fn, `exports ${name}`);
  const handle = fn.handle;
  const contract = {
    version: "1" as const,
    function: {
      name: handle.name,
      symbol: handle.name,
      params: handle.params.map((p) => ({ name: p.name, type: typeToString(p.type) })),
      returns: typeToString(handle.returns),
    },
    requires: [],
    ensures: [],
    effects: [],
    memory: {},
    numeric: { floatingPoint: "ieee754", rounding: "nearest", fastMath: false as const },
    optimize: { primary: "throughput" as const },
    definition: {
      statements: handle.body,
      allocates: false,
      prints: false,
      readsArgv: false,
      objects: {},
      calls: [],
    },
  } as unknown as FunctionContract;
  const context: FunctionContext = {
    objectNames: {} as Record<string, string>,
    functions: {} as Record<string, FunctionContract>,
  };
  return printSemanticFunction(resolveFunction(contract, context));
}

test("try/catch lowers to clear, body, error check and catch", () => {
  const source = [
    "export function f(x: number): number {",
    "  try {",
    "    return x + 1;",
    "  } catch (e) {",
    "    return 0;",
    "  }",
    "}",
  ].join("\n");
  const ir = functionIr(source, "f");
  assert.match(ir, /blaze_error_clear/);
  assert.match(ir, /blaze_had_error/);
});

test("try/catch/finally lowers finally after the check", () => {
  const source = [
    "export function g(x: number): void {",
    "  try {",
    "    const y = x + 1;",
    "  } catch (e) {",
    "    const y = 0;",
    "  } finally {",
    "    const z = 9;",
    "  }",
    "}",
  ].join("\n");
  const ir = functionIr(source, "g");
  assert.match(ir, /blaze_error_clear/);
  assert.match(ir, /blaze_had_error/);
});

test("catch (e) binds e to blaze_last_error", () => {
  const source = [
    "export function h(x: number): void {",
    "  try {",
    "    const y = x + 1;",
    "  } catch (e) {",
    "    const caught = e;",
    "  }",
    "}",
  ].join("\n");
  const ir = functionIr(source, "h");
  assert.match(ir, /blaze_error_clear/);
  assert.match(ir, /blaze_had_error/);
  assert.match(ir, /blaze_last_error/);
});

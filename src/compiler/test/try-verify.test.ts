import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { frontendFor } from "../semantics/frontend.ts";
import { resolveFunction, type FunctionContext } from "../semantics/ir-function.ts";
import { printSemanticFunction } from "../semantics/ir-text.ts";
import { typeToString } from "../semantics/contract.ts";
import { runBuild } from "../compiler.ts";
import { run } from "../core/process.ts";
import { writeProject } from "./project.ts";
import { scratch } from "./scratch.ts";
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

test("a finally runs before the body returns", () => {
  // A finally runs whether or not the body left the block early, and the IR
  // states a return as the end of a block: the value the return hands back is
  // therefore bound to a name of its own, the finally's statements are written
  // between the binding and the return, and the return hands back the name.
  const source = [
    "export function g(x: number): number {",
    "  try {",
    "    return x + 1;",
    "  } finally {",
    "    const z = 9;",
    "  }",
    "}",
  ].join("\n");
  const ir = functionIr(source, "g");

  // The value the return hands back is computed before the finally runs, which
  // is what the language does, and the finally's own statements are written
  // between the binding and the return.
  const bound = /let value\[f64\] (t\d+) immutable = \[add\[f64\]/.exec(ir);
  assert.ok(bound !== null, `the return's value is bound to a name of its own: ${ir}`);
  const name = bound[1];
  const binding = ir.indexOf(`let value[f64] ${name} immutable`);
  const finallyAt = ir.indexOf("let value[f64] z mutable");
  const returnAt = ir.indexOf(`return local[f64] ${name}`);
  assert.ok(binding < finallyAt && finallyAt < returnAt, `the finally runs before the return: ${ir}`);
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

test("a function with a try block is built and answers what the source answers", async () => {
  // The failure a catch arm reads is the runtime's own, so the calls the arm
  // is written with are calls into the runtime: a backend that cannot lower
  // them refuses the function, and the build has nothing to deliver.
  const REPLAY = new URL("./fixtures/dot-product-replay.json", import.meta.url).pathname;
  const directory = await scratch("blaze-try-build-");
  await writeFile(
    join(directory, "main.ts"),
    [
      "function guarded(n: number): number {",
      "  try {",
      "    return n + 1;",
      "  } catch (e) {",
      "    return 0;",
      "  } finally {",
      "    const z = 9;",
      "  }",
      "}",
      "console.log(guarded(41));",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeProject(join(directory, "blaze.toml"), {
    language: "typescript",
    sourceFile: "main.ts",
    model: { provider: "replay", file: REPLAY },
    output: "machine",
  });
  const outcome = await runBuild(
    "blaze.toml",
    { cwd: directory, reuse: false, model: `replay:${REPLAY}` },
    { stage: () => {} },
    "build",
  );
  assert.ok(outcome.outputPath !== null, "a program build delivers its binary");
  const original = run("node", ["main.ts"], { cwd: directory, timeoutMs: 60_000 });
  const delivered = run(outcome.outputPath, [], { timeoutMs: 60_000 });
  assert.equal(original.code, 0, original.stderr);
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, original.stdout);
  assert.equal(delivered.stdout, "42\n");
});

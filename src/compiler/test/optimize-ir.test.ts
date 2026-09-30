/**
 * What the deterministic rewrites do to a function, and that what they do is the
 * same program.
 *
 * The pass in `semantics/optimize-ir.ts` is the compiler's own, applied on every
 * round whether a model proposed anything or not, so it needs the same kind of
 * proof a proposed rewrite does: the artifact it produces has to be one the
 * validator accepts, and the numbers it computes have to be the numbers the IR
 * stated. Both are checked here against hand-written IR, and the second is
 * checked by running the folded C beside the unfolded C of the same function.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateFunctionC } from "../toolchain/ir-c.ts";
import { buildStandaloneRuntime } from "../runtime/standalone.ts";
import { runtimeHeaderSource } from "../runtime/abi.ts";
import { semanticFunctionProblems } from "../semantics/ir-validate.ts";
import { optimizeSemanticFunction } from "../semantics/optimize-ir.ts";
import { printSemanticFunction } from "../semantics/ir-text.ts";
import { run } from "../core/process.ts";
import type { SemanticBlock, SemanticFunction, SemanticSlot, SemanticType, SemanticValue } from "../core/semantic-ir.ts";

const F64: SemanticType = { kind: "primitive", name: "f64" };
const I32: SemanticType = { kind: "primitive", name: "i32" };
const U32: SemanticType = { kind: "primitive", name: "u32" };
const BOOL: SemanticType = { kind: "primitive", name: "bool" };

const constOf = (text: string, type: SemanticType = F64): SemanticValue => ({ k: "const", type, text });

const bin = (op: string, left: SemanticValue, right: SemanticValue, type: SemanticType = F64): SemanticValue => ({
  k: "arith", type, op: op as never, left, right,
});

/** `Math.abs`, which is the shortest call a hand-written fixture can make. */
function absOf(argument: SemanticValue): SemanticValue {
  return {
    k: "call", type: F64,
    call: {
      callee: "Math.abs", builtin: true,
      signature: { name: "Math.abs", symbol: "Math.abs", params: [{ name: "argument0", type: "f64" }], returns: "f64" },
      args: [argument], argTypes: [F64], returns: F64, effects: [], ownership: "none", retain: false,
    },
  };
}

function fnOf(entry: SemanticBlock, returns: SemanticType = { kind: "void" }, params: SemanticSlot[] = []): SemanticFunction {
  return {
    name: "subject", symbol: "subject", params, returns,
    requires: [], ensures: [], effects: [], allocates: false, prints: false, readsArgv: false,
    objects: {}, calls: [], entry,
  };
}

/** The printed IR, which is what a reader compares. */
const printed = (fn: SemanticFunction): string => printSemanticFunction(optimizeSemanticFunction(fn));

function countedLoop(bound: SemanticValue): SemanticBlock["statements"][number] {
  return {
    k: "loop", line: 2,
    loop: {
      kind: "counted", variable: "i", type: I32,
      from: constOf("0", I32), to: bound, step: constOf("1", I32),
      inclusive: false, down: false, header: "b1", exit: "b2",
      body: { id: "b2", releases: [], terminator: { k: "jump", target: "b1", releases: [] }, statements: [] },
    },
  };
}

test("a number written out of two numbers written out is one number", () => {
  // `2 * scale + 8` with every operand a literal is a literal, and the
  // backends then have nothing to compute at run time.
  const before = fnOf({
    id: "entry", releases: [], terminator: { k: "return", value: bin("add", bin("mul", constOf("2"), constOf("4")), constOf("8")) },
    statements: [],
  });
  assert.match(printed(before), /const\[f64\] 16/);
});

test("a division by a power of two that cannot be negative is a shift", () => {
  // `x / 8` is `x >> 3` when x cannot be negative, which is three instructions
  // against a thirty-cycle divide on the machine backend. Unsigned is that
  // case; a signed value is the next test.
  const parameter: SemanticSlot = { kind: "value", name: "x", mutable: false, type: U32 };
  const read: SemanticValue = { k: "local", type: U32, name: "x" };
  const before = fnOf(
    { id: "entry", releases: [], terminator: { k: "return", value: bin("div", read, constOf("8", U32), U32) }, statements: [] },
    U32,
    [parameter],
  );
  const after = printed(before);
  assert.match(after, /\bshr\b/);
  assert.doesNotMatch(after, /\bdiv\b/);
});

test("a division by a power of two that may be negative is left alone", () => {
  // Truncation towards zero and a shift disagree about a negative value: -7 / 2
  // is -3 and -7 >> 1 is -4. A rewrite here would change what the program
  // computes, so the pass refuses the one case it cannot prove.
  const parameter: SemanticSlot = { kind: "value", name: "x", mutable: false, type: I32 };
  const read: SemanticValue = { k: "local", type: I32, name: "x" };
  const before = fnOf(
    { id: "entry", releases: [], terminator: { k: "return", value: bin("div", read, constOf("2", I32), I32) }, statements: [] },
    I32,
    [parameter],
  );
  assert.match(printed(before), /\bdiv\b/);
});

test("a float is folded to the double it actually is, not to a rounder one", () => {
  // 0.1 + 0.2 is not 0.3, and writing 0.3 would be a different program. The
  // answer the pass writes is the double the addition produced, which is what
  // the source language prints for it, and it is left in that form rather than
  // rounded to something a reader would expect. A sum that is exact folds to
  // the obvious number.
  const inexact = fnOf({
    id: "entry", releases: [], terminator: { k: "return", value: bin("add", constOf("0.1"), constOf("0.2")) }, statements: [],
  });
  assert.match(printed(inexact), /const\[f64\] 0\.30000000000000004/);
  const exact = fnOf({
    id: "entry", releases: [], terminator: { k: "return", value: bin("add", constOf("0.25"), constOf("0.5")) }, statements: [],
  });
  assert.match(printed(exact), /const\[f64\] 0\.75/);
});

test("a whole number wraps to the width of the type it is written at", () => {
  // The backends wrap an i32 operation to 32 bits, so a fold that kept 2^31
  // would be a number the target cannot hold.
  const before = fnOf({
    id: "entry", releases: [],
    terminator: { k: "return", value: bin("mul", constOf("65536", I32), constOf("65536", I32), I32) },
    statements: [],
  });
  assert.match(printed(before), /const\[i32\] 0\b/);
});

test("a truth that decides on a literal is the value it decides to", () => {
  // `flag ? 1 : 2` is one of the two, and a select the backends lower to a
  // branch is a branch that was never going to be taken.
  const before = fnOf({
    id: "entry", releases: [],
    terminator: { k: "return", value: { k: "select", type: F64, condition: { k: "bool", type: BOOL, value: true }, then: constOf("1"), otherwise: constOf("2") } },
    statements: [],
  });
  assert.doesNotMatch(printed(before), /\bselect\b/);
  assert.match(printed(before), /const\[f64\] 1\b/);
});

test("a binding nothing reads is dropped", () => {
  // Every rewrite that binds a value adds a `let`, and a `let` the backends
  // still lower is an allocation and a store. This one is read by nobody.
  const before = fnOf({
    id: "entry", releases: [],
    statements: [
      { k: "let", slot: { kind: "value", name: "unused", mutable: false, type: F64 }, value: constOf("1"), line: 1 },
      { k: "printNumber", value: constOf("2"), line: 2 },
    ],
    terminator: { k: "return", value: null },
  });
  assert.doesNotMatch(printed(before), /unused/);
});

test("a binding something reads is kept", () => {
  const before = fnOf({
    id: "entry", releases: [],
    statements: [
      { k: "let", slot: { kind: "value", name: "used", mutable: false, type: F64 }, value: constOf("1"), line: 1 },
      { k: "printNumber", value: { k: "local", type: F64, name: "used" }, line: 2 },
    ],
    terminator: { k: "return", value: null },
  });
  assert.match(printed(before), /used/);
});

test("a binding read only as a call argument is kept", () => {
  // The name is read inside the call, and a walk that stops at the call counts
  // it as read by nobody: the binding is dropped and the call is left reading a
  // name the function no longer declares, which the validator refuses.
  const before = fnOf({
    id: "entry", releases: [],
    statements: [
      { k: "let", slot: { kind: "value", name: "argument", mutable: false, type: F64 }, value: constOf("1"), line: 1 },
      { k: "printNumber", value: absOf({ k: "local", type: F64, name: "argument" }), line: 2 },
    ],
    terminator: { k: "return", value: null },
  });
  const after = printed(before);
  assert.match(after, /let value\[f64\] argument immutable = const\[f64\] 1/);
  assert.match(after, /Math\.abs \[arg\[f64\] local\[f64\] argument\]/);
});

test("a number written out inside a call argument is one number", () => {
  // The argument is a value of its own, so the arithmetic in it is folded the
  // way the same arithmetic anywhere else in the value is.
  const before = fnOf({
    id: "entry", releases: [], terminator: { k: "return", value: null },
    statements: [{ k: "printNumber", value: absOf(bin("mul", constOf("2"), constOf("4"))), line: 1 }],
  });
  assert.match(printed(before), /Math\.abs \[arg\[f64\] const\[f64\] 8\]/);
});

test("a loop bound computed every turn is computed once above the loop", () => {
  // `i < n * 2` recomputes the bound on every turn, and `n * 2` is the same
  // number on every one of them. This is the rewrite the catalogue's
  // `hoist-invariant` cannot make: that one needs a value computed more than
  // once, and this one is computed exactly once per turn.
  const n: SemanticSlot = { kind: "value", name: "n", mutable: false, type: F64 };
  const i: SemanticSlot = { kind: "value", name: "i", mutable: false, type: I32 };
  const readN: SemanticValue = { k: "local", type: F64, name: "n" };
  const before = fnOf({
    id: "entry", releases: [], terminator: { k: "return", value: null },
    statements: [countedLoop(bin("mul", readN, constOf("2"), I32))],
  }, F64, [n, i]);
  const after = printed(before);
  // The bound is bound above the loop and the loop reads the name. What it is
  // bound to is whatever the fold left behind: `n * 2` became `n << 1` on the
  // way, and the hoist moved that, which is the order the two run in.
  assert.match(after, /let value\[i32\] invariant0_0 immutable = /);
  assert.match(after, /to local\[i32\] invariant0_0/);
  // The counter is written by the loop and the step is already a name the
  // program has, so neither is given another.
  assert.doesNotMatch(after, /invariant\d+_\d+ = const\[i32\] 1\b/);
});

test("a loop bound that reads memory is left where it is", () => {
  // The IR holds no length and no null test, so a load hoisted out of a turn
  // that did not read it is a read the source never performed — and an
  // out-of-bounds one. The same reason `hoist-invariant` refuses it.
  const a: SemanticSlot = { kind: "value", name: "a", mutable: false, type: F64 };
  const i: SemanticSlot = { kind: "value", name: "i", mutable: false, type: I32 };
  const length: SemanticValue = { k: "length", type: U32, of: { k: "local", type: F64, name: "a" } };
  const before = fnOf({
    id: "entry", releases: [], terminator: { k: "return", value: null },
    statements: [countedLoop(bin("add", length, constOf("1", U32), U32))],
  }, F64, [a, i]);
  assert.doesNotMatch(printed(before), /invariant/);
});

test("what the pass produces is a function the compiler may lower", () => {
  // The same check the driver makes on a proposed rewrite, applied to the
  // rewrites the compiler applies on its own.
  const n: SemanticSlot = { kind: "value", name: "n", mutable: false, type: F64 };
  const i: SemanticSlot = { kind: "value", name: "i", mutable: false, type: I32 };
  const readN: SemanticValue = { k: "local", type: F64, name: "n" };
  const before = fnOf({
    id: "entry", releases: [], terminator: { k: "return", value: null },
    statements: [
      { k: "let", slot: { kind: "value", name: "unused", mutable: false, type: F64 }, value: constOf("1"), line: 1 },
      { k: "printNumber", value: bin("add", constOf("2"), constOf("3")), line: 2 },
      countedLoop(bin("mul", readN, constOf("2"), I32)),
    ],
  }, { kind: "void" }, [n, i]);
  assert.deepEqual(semanticFunctionProblems(optimizeSemanticFunction(before), undefined as never), []);
});

test("the folded C computes what the unfolded C computes", async () => {
  // The proof that matters: the same function, lowered twice, once through the
  // pass and once not, run side by side. Every number below is written as an
  // expression the pass can rewrite, and the two binaries have to agree.
  const cases: { name: string; expression: SemanticValue; expected: string }[] = [
    { name: "a literal sum", expression: bin("add", constOf("2"), constOf("3")), expected: "5" },
    { name: "a literal product with an identity", expression: bin("mul", constOf("7"), constOf("1")), expected: "7" },
    { name: "a whole division by a power of two", expression: bin("div", constOf("64"), constOf("8"), I32), expected: "8" },
    { name: "a whole remainder by a power of two", expression: bin("mod", constOf("65"), constOf("8"), I32), expected: "1" },
    { name: "a shifted product", expression: bin("mul", constOf("3"), constOf("4"), I32), expected: "12" },
    { name: "an exact float sum", expression: bin("add", constOf("0.25"), constOf("0.5")), expected: "0.75" },
    { name: "a float divided by one", expression: bin("div", constOf("2.5"), constOf("1")), expected: "2.5" },
    { name: "a value against itself subtracted", expression: bin("sub", constOf("9"), constOf("9")), expected: "0" },
  ];
  const directory = await mkdtemp(join(tmpdir(), "blaze-opt-"));
  await writeFile(join(directory, "blaze_rt.h"), runtimeHeaderSource(), "utf8");
  const runtime = await buildStandaloneRuntime(directory);
  for (const one of cases) {
    for (const folded of [false, true]) {
      const fn = fnOf({
        id: "entry", releases: [],
        statements: [{ k: "printNumber", value: one.expression, line: 1 }, { k: "printNewline", line: 2 }],
        terminator: { k: "return", value: null },
      });
      const source = join(directory, `${folded ? "folded" : "plain"}_${one.name.replace(/\W/g, "_")}.c`);
      await writeFile(
        source,
        [
          "#include <stdio.h>",
          generateFunctionC(folded ? optimizeSemanticFunction(fn) : fn),
          "int main(void) { subject(); return 0; }",
          "",
        ].join("\n"),
        "utf8",
      );
      const binary = source.replace(/\.c$/, "");
      const built = run("gcc", ["-std=c11", "-O2", "-I", directory, source, runtime.objectPath, "-o", binary, "-lm"], { timeoutMs: 120_000 });
      assert.equal(built.code, 0, `the C must build: ${built.stderr}`);
      const ran = run(binary, [], { timeoutMs: 60_000 });
      assert.equal(ran.stdout.trimEnd(), one.expected, `${one.name}, ${folded ? "folded" : "unfolded"}`);
    }
  }
});

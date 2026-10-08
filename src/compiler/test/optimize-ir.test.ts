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
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateFunctionC } from "../toolchain/ir-c.ts";
import { buildStandaloneRuntime } from "../runtime/standalone.ts";
import { runtimeHeaderSource } from "../runtime/abi.ts";
import { semanticFunctionProblems } from "../semantics/ir-validate.ts";
import { optimizeSemanticFunction } from "../semantics/optimize-ir.ts";
import { printSemanticFunction } from "../semantics/ir-text.ts";
import { run } from "../core/process.ts";
import { typeText } from "../core/semantic-ir.ts";
import type { SemanticBlock, SemanticFunction, SemanticSlot, SemanticStatement, SemanticType, SemanticValue } from "../core/semantic-ir.ts";
import type { TypeExpr } from "../core/types.ts";
import { cDeclarationType } from "../toolchain/linker.ts";
import { scratch } from "./scratch.ts";

const F64: SemanticType = { kind: "primitive", name: "f64" };
const I32: SemanticType = { kind: "primitive", name: "i32" };
const U32: SemanticType = { kind: "primitive", name: "u32" };
const BOOL: SemanticType = { kind: "primitive", name: "bool" };
const USIZE: SemanticType = { kind: "primitive", name: "usize" };

const constOf = (text: string, type: SemanticType = F64): SemanticValue => ({ k: "const", type, text });

const bin = (op: string, left: SemanticValue, right: SemanticValue, type: SemanticType = F64): SemanticValue => ({
  k: "arith", type, op: op as never, left, right,
});

const cmp = (op: string, left: SemanticValue, right: SemanticValue, type: TypeExpr = { kind: "primitive", name: "f64" }): SemanticValue => ({
  k: "compare", type, op: op as never, operand: left.type, left, right,
});

/**
 * The C spelling of the type a driven expression has. Every case that names a
 * parameter is over a whole number, so the primitive name is the whole answer
 * and a type that is not primitive is a case that was written wrong.
 */
function primitiveOf(type: SemanticType): string {
  if (type.kind !== "primitive") throw new Error(`the equivalence harness drives a ${type.kind}, which it has no C spelling for`);
  return cDeclarationType(type);
}

/** A read of the driven parameter as a double, which is the type that has NaNs. */
const paramF = (name: string): SemanticValue => ({ k: "local", type: F64, name });

/**
 * A read of the one parameter the equivalence harness drives, at the type it
 * reads it as. Every identity this reaches is one that only applies to a value
 * that is not written out, which is why it is a name and not a literal.
 */
const paramI = (name: string): SemanticValue => ({ k: "local", type: I32, name });

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

test("a whole number is folded at the width it is written at, whatever that width is", () => {
  // `usize` and `isize` were the two types missing from the width table, and a
  // buffer's offset is a `usize` — so the arithmetic a window is laid out with,
  // `2 * bytesPerFloat * n`, reached a backend as the tree the source wrote
  // rather than as the fold it was already the shape of. A loop counter is not
  // this case: `ir-resolve.ts` gives a counted loop `i64`, which was in the
  // table already. These are the same rewrites a `u32` gets, at the width the
  // backend gives the type, and they are worth the same.
  const parameter: SemanticSlot = { kind: "value", name: "j", mutable: false, type: USIZE };
  const read: SemanticValue = { k: "local", type: USIZE, name: "j" };
  const returns = (value: SemanticValue): string =>
    printed(
      fnOf({ id: "entry", releases: [], terminator: { k: "return", value }, statements: [] }, USIZE, [parameter]),
    );
  // `j * 8` is a shift, and a shift is the instruction the machine backend has
  // and a multiply is not.
  assert.match(returns(bin("mul", read, constOf("8", USIZE), USIZE)), /\bshl\b/);
  // `j % 8` is a mask, for the same reason: the backend has an `and`.
  assert.match(returns(bin("mod", read, constOf("8", USIZE), USIZE)), /\band\b/);
  // The identities an offset is written with most: `i + 0` and `i * 1`.
  assert.doesNotMatch(returns(bin("add", read, constOf("0", USIZE), USIZE)), /\badd\b/);
  assert.doesNotMatch(returns(bin("mul", read, constOf("1", USIZE), USIZE)), /\bmul\b/);
  // And a whole offset difference, which is what two windows produce.
  assert.match(returns(bin("sub", read, read, USIZE)), /const\[usize\] 0/);
});

test("a `usize` divided by a power of two is a shift, because it cannot be negative", () => {
  // The one case a signed number has to be refused and a `usize` does not: a
  // `usize` is a machine word, so truncation towards zero and a shift cannot
  // disagree about it, and the divide becomes the shift the backend has.
  const parameter: SemanticSlot = { kind: "value", name: "j", mutable: false, type: USIZE };
  const read: SemanticValue = { k: "local", type: USIZE, name: "j" };
  const after = printed(
    fnOf(
      { id: "entry", releases: [], terminator: { k: "return", value: bin("div", read, constOf("4", USIZE), USIZE) }, statements: [] },
      USIZE,
      [parameter],
    ),
  );
  assert.match(after, /\bshr\b/);
  assert.doesNotMatch(after, /\bdiv\b/);
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

test("a whole number wraps to the width of a type a double cannot hold", () => {
  // A double holds every integer exactly only up to 2^53, and the sums a 64 bit
  // wrap forms reach past that: `7 % 3` folded to zero because the sum rounded
  // on the way back down. Every operation and both signs are asked here, because
  // the answer is one question and a wrong one in one case is a wrong program.
  const I64: SemanticType = { kind: "primitive", name: "i64" };
  const U64: SemanticType = { kind: "primitive", name: "u64" };
  const cases: { type: SemanticType; op: string; left: string; right: string; expected: string }[] = [
    { type: I64, op: "mod", left: "7", right: "3", expected: "1" },
    { type: I64, op: "div", left: "7", right: "3", expected: "2" },
    { type: I64, op: "mod", left: "-7", right: "2", expected: "-1" },
    { type: I64, op: "div", left: "-7", right: "2", expected: "-3" },
    { type: I32, op: "mod", left: "7", right: "3", expected: "1" },
    { type: I32, op: "mul", left: "65536", right: "65536", expected: "0" },
  ];
  for (const entry of cases) {
    const before = fnOf({
      id: "entry", releases: [],
      terminator: { k: "return", value: bin(entry.op, constOf(entry.left, entry.type), constOf(entry.right, entry.type), entry.type) },
      statements: [],
    }, entry.type);
    assert.match(printed(before), new RegExp(`const\\[${typeText(entry.type)}\\] ${entry.expected}\\b`), `${typeText(entry.type)}: ${entry.op} ${entry.left} ${entry.right}`);
  }
  // An answer past 2^53 is a number the text cannot carry, so it is left as the
  // arithmetic it came from: the backend wraps it at the width it is written at
  // and the fold does not answer a different number.
  for (const entry of [{ op: "sub", left: "1", right: "2" }, { op: "div", left: "-7", right: "2" }]) {
    const before = fnOf({
      id: "entry", releases: [],
      terminator: { k: "return", value: bin(entry.op, constOf(entry.left, U64), constOf(entry.right, U64), U64) },
      statements: [],
    }, U64);
    assert.match(printed(before), new RegExp(`${entry.op}\\[u64\\]`), `u64: ${entry.op} ${entry.left} ${entry.right}`);
  }
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
      { k: "printNumber", value: constOf("2"), line: 2, bigint: false },
    ],
    terminator: { k: "return", value: null },
  });
  assert.doesNotMatch(printed(before), /unused/);
});

test("a binding read only as a call argument reaches the call", () => {
  // The name is read inside the call, and a walk that stops at the call counts
  // it as read by nobody: the binding is dropped and the call is left reading a
  // name the function no longer declares, which the validator refuses. The
  // name need not survive — a binding read once is put where it is read — but
  // the value it was bound to has to arrive.
  const before = fnOf({
    id: "entry", releases: [],
    statements: [
      { k: "let", slot: { kind: "value", name: "argument", mutable: false, type: F64 }, value: constOf("1"), line: 1 },
      { k: "printNumber", value: absOf({ k: "local", type: F64, name: "argument" }), line: 2, bigint: false },
    ],
    terminator: { k: "return", value: null },
  });
  assert.match(printed(before), /Math\.abs \[arg\[f64\] const\[f64\] 1\]/);
});

test("a binding a statement writes between it and the one read is left alone", () => {
  // `s += 1` reads nothing as a value — the value it carries is the right-hand
  // side — and the name on the left is nowhere in it, so a pass that watches the
  // value's inputs alone puts `"x"` where `s` is read and prints `x` in place of
  // `x1`.
  const before = fnOf({
    id: "entry", releases: [],
    statements: [
      { k: "let", slot: { kind: "value", name: "s", mutable: true, type: F64 }, value: constOf("1"), line: 1 },
      { k: "set", name: "s", op: "+=", value: constOf("2"), line: 2 },
      { k: "printNumber", value: { k: "local", type: F64, name: "s" }, line: 3, bigint: false },
    ],
    terminator: { k: "return", value: null },
  });
  assert.match(printed(before), /set s \+= const\[f64\] 2/);
  assert.match(printed(before), /print_number local\[f64\] s/);
});

test("a number written out inside a call argument is one number", () => {
  // The argument is a value of its own, so the arithmetic in it is folded the
  // way the same arithmetic anywhere else in the value is.
  const before = fnOf({
    id: "entry", releases: [], terminator: { k: "return", value: null },
    statements: [{ k: "printNumber", value: absOf(bin("mul", constOf("2"), constOf("4"))), line: 1, bigint: false }],
  });
  assert.match(printed(before), /Math\.abs \[arg\[f64\] const\[f64\] 8\]/);
});

test("a binding something reads is kept", () => {
  // The name does not have to survive — a binding read once is put where it is
  // read — but what it was bound to has to reach the print, which is what
  // catches a binding dropped as though nothing read it.
  const before = fnOf({
    id: "entry", releases: [],
    statements: [
      { k: "let", slot: { kind: "value", name: "used", mutable: false, type: F64 }, value: constOf("1"), line: 1 },
      { k: "printNumber", value: { k: "local", type: F64, name: "used" }, line: 2, bigint: false },
    ],
    terminator: { k: "return", value: null },
  });
  assert.match(printed(before), /print_number const\[f64\] 1/);
});

test("two loops at the same place in two blocks bind two names", () => {
  // The hoister counted its names out of the statement the loop sat at, so an
  // outer loop that is the third statement of the entry block and a loop nested
  // in it that is the third statement of the outer's own body both said
  // `invariant2_0`. The inner declaration shadowed the outer one for the rest of
  // the block, and a read the source made of the outer value came back as the
  // inner one: a body that hoisted `x * 2` above its outer loop and `k + 1` above
  // its inner one answered 87 where it says 78. The commoning pass counted out
  // of the block and the order the same way, and one body came to hold two
  // bindings both called `commonentry_1` — one for `x * 2` and one for `x / 2`.
  const n: SemanticSlot = { kind: "value", name: "n", mutable: false, type: F64 };
  const i: SemanticSlot = { kind: "value", name: "i", mutable: false, type: I32 };
  const x: SemanticSlot = { kind: "value", name: "x", mutable: true, type: F64 };
  const readN: SemanticValue = { k: "local", type: F64, name: "n" };
  const setX = (value: SemanticValue, line: number): SemanticBlock["statements"][number] => ({
    k: "set", name: "x", op: "=", value, line,
  });
  const loopOver = (body: SemanticBlock["statements"]): SemanticBlock["statements"][number] => {
    const statement = countedLoop(constOf("4", I32)) as Extract<SemanticBlock["statements"][number], { k: "loop" }>;
    return { ...statement, loop: { ...statement.loop, body: { ...statement.loop.body, statements: body } } };
  };
  const inner = loopOver([setX(bin("div", readN, constOf("2")), 4)]);
  // The stores are read back by the answer, so none of them is dropped as dead.
  const entry: SemanticBlock = {
    id: "entry", releases: [], terminator: { k: "return", value: { k: "local", type: F64, name: "x" } },
    statements: [
      setX(bin("mul", readN, constOf("2")), 1),
      setX(bin("div", readN, constOf("2")), 2),
      loopOver([setX(bin("mul", readN, constOf("2")), 3), setX(bin("mul", readN, constOf("3")), 4), inner]),
    ],
  };
  const after = printed(fnOf(entry, F64, [n, i, x]));
  const names = [...after.matchAll(/let value\[\w+\] (\w+) immutable/g)].map((one) => one[1]);
  assert.ok(names.length >= 2, `the body binds a name for each loop:\n${after}`);
  assert.equal(new Set(names).size, names.length, `two bindings answered to one name:\n${after}`);
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
  // The name is one nothing in the body holds, so a second hoist written in a
  // nested block cannot answer to the same spelling and shadow this one.
  assert.match(after, /let value\[i32\] invariant\d+ immutable = /);
  assert.match(after, /to local\[i32\] invariant\d+/);
  // The counter is written by the loop and the step is already a name the
  // program has, so neither is given another.
  assert.doesNotMatch(after, /invariant\d+ = const\[i32\] 1\b/);
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

test("a loop body that computes the same thing every turn computes it once", () => {
  // `sum += n * 2` recomputes `n * 2` on every turn of the loop. Nothing in
  // the loop writes `n`, the multiplication reads no memory and cannot fault,
  // so it is the same number on every turn and is computed once above it.
  const n: SemanticSlot = { kind: "value", name: "n", mutable: false, type: F64 };
  const i: SemanticSlot = { kind: "value", name: "i", mutable: false, type: I32 };
  const sum: SemanticSlot = { kind: "value", name: "sum", mutable: true, type: F64 };
  const readN: SemanticValue = { k: "local", type: F64, name: "n" };
  const loop = countedLoop({ k: "local", type: I32, name: "n" });
  const body = loop.k === "loop" ? loop.loop.body : { id: "b2", releases: [], statements: [], terminator: { k: "jump" as const, target: "b1", releases: [] } };
  body.statements = [
    { k: "set", name: "sum", op: "+=", value: bin("mul", readN, constOf("2")), line: 3 },
    { k: "set", name: "sum", op: "+=", value: bin("mul", readN, constOf("2")), line: 4 },
  ];
  const after = printed(fnOf({ id: "entry", releases: [], terminator: { k: "return", value: null }, statements: [loop] }, F64, [n, i, sum]));
  assert.match(after, /let value\[f64\] invariant\d+ immutable = \[mul\[f64\] local\[f64\] n const\[f64\] 2\]/);
  // The loop body reads the name rather than computing the product twice.
  const inside = after.slice(after.indexOf("for["));
  assert.doesNotMatch(inside, /\[mul\[f64\] local\[f64\] n const\[f64\] 2\]/);
});

test("a loop body that reads a name the loop writes is left where it is", () => {
  // `total += i * 2` inside a loop whose counter is `i`: the product changes on
  // every turn, so binding it above the loop would compute a number the turn
  // the loop takes on its last iteration does not have.
  const n: SemanticSlot = { kind: "value", name: "n", mutable: false, type: I32 };
  const total: SemanticSlot = { kind: "value", name: "total", mutable: true, type: F64 };
  const loop = countedLoop({ k: "local", type: I32, name: "n" });
  const body = loop.k === "loop" ? loop.loop.body : { id: "b2", releases: [], statements: [], terminator: { k: "jump" as const, target: "b1", releases: [] } };
  body.statements = [
    { k: "set", name: "total", op: "+=", value: bin("mul", { k: "local", type: I32, name: "i" }, constOf("2")), line: 3 },
    { k: "set", name: "total", op: "+=", value: bin("mul", { k: "local", type: I32, name: "i" }, constOf("2")), line: 4 },
  ];
  assert.doesNotMatch(printed(fnOf({ id: "entry", releases: [], terminator: { k: "return", value: null }, statements: [loop] }, F64, [n, total])), /invariant/);
});

test("a value a block computes twice is computed once", () => {
  const a: SemanticSlot = { kind: "value", name: "a", mutable: false, type: F64 };
  const b: SemanticSlot = { kind: "value", name: "b", mutable: false, type: F64 };
  const sum: SemanticSlot = { kind: "value", name: "sum", mutable: true, type: F64 };
  const product: SemanticValue = bin("mul", { k: "local", type: F64, name: "a" }, { k: "local", type: F64, name: "b" });
  const after = printed(fnOf({
    id: "entry", releases: [], terminator: { k: "return", value: null },
    statements: [
      { k: "set", name: "sum", op: "+=", value: product, line: 1 },
      { k: "set", name: "sum", op: "+=", value: bin("mul", { k: "local", type: F64, name: "a" }, { k: "local", type: F64, name: "b" }), line: 2 },
    ],
  }, F64, [a, b, sum]));
  assert.match(after, /let value\[f64\] common\w+ immutable = \[mul\[f64\] local\[f64\] a local\[f64\] b\]/);
  const rest = after.slice(after.indexOf("common"));
  assert.equal(rest.match(/\[mul\[f64\] local\[f64\] a local\[f64\] b\]/g)?.length ?? 0, 1);
});

test("a value a block computes twice that one of them writes between is not commoned", () => {
  // `a` is written between the two products, so the second one is a different
  // number and computing the first above the second would be wrong. The write
  // has to stay live for this to be the question it is about: a write nothing
  // reads is removed before anything else runs, and then there is no write
  // between the two products to read across.
  const a: SemanticSlot = { kind: "value", name: "a", mutable: true, type: F64 };
  const b: SemanticSlot = { kind: "value", name: "b", mutable: false, type: F64 };
  const sum: SemanticSlot = { kind: "value", name: "sum", mutable: true, type: F64 };
  const after = printed(fnOf({
    id: "entry", releases: [], terminator: { k: "return", value: { k: "local", type: F64, name: "a" } },
    statements: [
      { k: "set", name: "sum", op: "+=", value: bin("mul", { k: "local", type: F64, name: "a" }, { k: "local", type: F64, name: "b" }), line: 1 },
      { k: "set", name: "a", op: "=", value: constOf("2"), line: 2 },
      { k: "set", name: "sum", op: "+=", value: bin("mul", { k: "local", type: F64, name: "a" }, { k: "local", type: F64, name: "b" }), line: 3 },
    ],
  }, F64, [a, b, sum]));
  assert.doesNotMatch(after, /common/);
});

test("an object a body allocates is not commoned with the one beside it", () => {
  // Two literals of the same shape are two allocations and two sets of fields,
  // so commoning them would give the second write into the first object, and
  // dropping the binding of one would leave the block releasing the same name
  // twice. Neither is the same program.
  const node = (value: string): SemanticValue => ({
    k: "newObject",
    type: { kind: "ref", of: null, name: "Object1" },
    layout: "Object1",
    fields: [{ name: "value", value: constOf(value, I32) }],
  });
  const folded = optimizeSemanticFunction(
    {
      name: "objects",
      symbol: "objects",
      params: [],
      returns: F64,
      requires: [],
      ensures: [],
      effects: [],
      allocates: true,
      prints: true,
      readsArgv: false,
      objects: {
        Object1: {
          name: "Object1",
          size: 8,
          align: 8,
          fields: [{ name: "value", type: "i32", offset: 0 }],
        },
      },
      calls: [],
      entry: {
        id: "entry",
        releases: ["left", "right"],
        statements: [
          { k: "let", slot: { kind: "object", name: "left", mutable: false, type: { kind: "ref", of: null, name: "Object1" } }, value: node("1"), line: 1 },
          { k: "printNumber", value: { k: "loadField", type: I32, object: { k: "local", type: { kind: "ref", of: null, name: "Object1" }, name: "left" }, layout: "Object1", field: "value" }, line: 2, bigint: false },
          { k: "let", slot: { kind: "object", name: "right", mutable: false, type: { kind: "ref", of: null, name: "Object1" } }, value: node("1"), line: 3 },
          { k: "printNumber", value: { k: "loadField", type: I32, object: { k: "local", type: { kind: "ref", of: null, name: "Object1" }, name: "right" }, layout: "Object1", field: "value" }, line: 4, bigint: false },
        ],
        terminator: { k: "return", value: null },
      },
    },
    new Map(),
  );
  const printed = printSemanticFunction(folded);
  assert.match(printed, /new_object\[ref<Object1>\] Object1 value const\[i32\] 1/, "both objects are built");
  assert.equal(printed.split("new_object").length - 1, 2, "two literals are two objects, not one");
  assert.match(printed, /releases\[left right\]/, "and each is released under its own name");
});

test("a value a block computes twice that a nested block writes between is not commoned", () => {
  // The write is inside a nested block, which the block's own statements do not
  // hold: the binding goes at the top of the outer block and the reads it
  // replaces are rewritten inside the nested blocks too, so a name a nested
  // block writes is a name the binding may not read. `a` is written between the
  // two products here, so the second one is a different number.
  const a: SemanticSlot = { kind: "value", name: "a", mutable: true, type: F64 };
  const b: SemanticSlot = { kind: "value", name: "b", mutable: false, type: F64 };
  const sum: SemanticSlot = { kind: "value", name: "sum", mutable: true, type: F64 };
  const after = printed(fnOf({
    id: "entry", releases: [], terminator: { k: "return", value: { k: "local", type: F64, name: "a" } },
    statements: [
      { k: "set", name: "sum", op: "+=", value: bin("mul", { k: "local", type: F64, name: "a" }, { k: "local", type: F64, name: "b" }), line: 1 },
      {
        k: "block",
        line: 2,
        body: {
          id: "inner", releases: [], terminator: { k: "next" },
          statements: [{ k: "set", name: "a", op: "=", value: constOf("2"), line: 2 }],
        },
      },
      { k: "set", name: "sum", op: "+=", value: bin("mul", { k: "local", type: F64, name: "a" }, { k: "local", type: F64, name: "b" }), line: 3 },
    ],
  }, F64, [a, b, sum]));
  assert.doesNotMatch(after, /common/);
});

test("a copy of a name nothing writes is read as the name it copies", () => {
  const a: SemanticSlot = { kind: "value", name: "a", mutable: false, type: F64 };
  const b: SemanticSlot = { kind: "value", name: "b", mutable: false, type: F64 };
  const sum: SemanticSlot = { kind: "value", name: "sum", mutable: true, type: F64 };
  const after = printed(fnOf({
    id: "entry", releases: [], terminator: { k: "return", value: { k: "local", type: F64, name: "sum" } },
    statements: [
      { k: "let", slot: { kind: "value", name: "copy", mutable: false, type: F64 }, value: { k: "local", type: F64, name: "a" }, line: 1 },
      { k: "set", name: "sum", op: "+=", value: { k: "local", type: F64, name: "copy" }, line: 2 },
      { k: "set", name: "sum", op: "+=", value: { k: "local", type: F64, name: "b" }, line: 3 },
    ],
  }, F64, [a, b, sum]));
  assert.doesNotMatch(after, /copy/);
  assert.match(after, /set sum \+= local\[f64\] a/);
});

test("a copy of a name a fill writes is left bound", () => {
  // A fill names the buffer it writes as a bare string, the same as an element
  // write, so a substitution over values cannot reach it: dropping the copy and
  // keeping the fill leaves the fill naming a name the function does not have.
  const ARRAY: SemanticType = { kind: "array", of: F64, length: 4 };
  const USIZE: SemanticType = { kind: "primitive", name: "usize" };
  const values: SemanticSlot = { kind: "value", name: "values", mutable: false, type: ARRAY };
  const total: SemanticSlot = { kind: "value", name: "total", mutable: true, type: F64 };
  const fn = fnOf({
    id: "entry", releases: [], terminator: { k: "return", value: { k: "local", type: F64, name: "total" } },
    statements: [
      { k: "let", slot: { kind: "value", name: "copy", mutable: false, type: ARRAY }, value: { k: "local", type: ARRAY, name: "values" }, line: 1 },
      { k: "fill", buffer: "copy", index: "blaze_fill", value: constOf("1"), type: F64, line: 2 },
      {
        k: "set", name: "total", op: "+=", line: 3,
        value: { k: "element", type: F64, of: { k: "local", type: ARRAY, name: "copy" }, index: constOf("0", USIZE) },
      },
    ],
  }, F64, [values, total]);
  assert.match(printed(fn), /let value\[\[f64; 4\]\] copy/, "the binding the fill names is kept");
  assert.deepEqual(semanticFunctionProblems(fn), [], "the rewritten body still names what it declares");
});

test("a copy of a copy is read as the name the first copy names", () => {
  // `let b = a; let c = b` is a chain, and both bindings go: the read of `c`
  // becomes a read of `a`. Resolving each copy against the copies above it is
  // what keeps the name it would have read from outliving its own binding.
  const a: SemanticSlot = { kind: "value", name: "a", mutable: false, type: F64 };
  const sum: SemanticSlot = { kind: "value", name: "sum", mutable: true, type: F64 };
  const fn = fnOf({
    id: "entry", releases: [], terminator: { k: "return", value: { k: "local", type: F64, name: "sum" } },
    statements: [
      { k: "let", slot: { kind: "value", name: "b", mutable: false, type: F64 }, value: { k: "local", type: F64, name: "a" }, line: 1 },
      { k: "let", slot: { kind: "value", name: "c", mutable: false, type: F64 }, value: { k: "local", type: F64, name: "b" }, line: 2 },
      { k: "set", name: "sum", op: "+=", value: { k: "local", type: F64, name: "c" }, line: 3 },
    ],
  }, F64, [a, sum]);
  const after = printed(fn);
  assert.doesNotMatch(after, /local\[f64\] b|local\[f64\] c/, "neither copy is left to be read");
  assert.match(after, /set sum \+= local\[f64\] a/);
  assert.deepEqual(semanticFunctionProblems(optimizeSemanticFunction(fn)), []);
});

test("a chain of bindings read once is inlined whole", () => {
  // The chain in a loop body, which is where the hoist met it: every name of
  // the chain is read once by the one above it, so every binding is inlined and
  // what is left reads one value. A value that has already been replaced is
  // not looked at again, so a chain that is not resolved as it is recorded
  // leaves the name under it naming nothing — which the validator refuses, and
  // the hoist then carries the same broken read out of the loop.
  const n: SemanticSlot = { kind: "value", name: "n", mutable: false, type: I32 };
  const i: SemanticSlot = { kind: "value", name: "i", mutable: false, type: I32 };
  const loop = countedLoop({ k: "local", type: I32, name: "n" });
  const body = loop.k === "loop" ? loop.loop.body : { id: "b2", releases: [], statements: [], terminator: { k: "jump" as const, target: "b1", releases: [] } };
  let value: SemanticValue = { k: "local", type: I32, name: "n" };
  for (let index = 0; index < 8; index += 1) {
    const name = `v${index}`;
    body.statements.push({
      k: "let", line: 3 + index,
      slot: { kind: "value", name, mutable: false, type: I32 },
      value: bin("add", value, constOf(String(index), I32), I32),
    });
    value = { k: "local", type: I32, name };
  }
  body.statements.push({ k: "printNumber", value, line: 20, bigint: false });
  const fn = fnOf({ id: "entry", releases: [], terminator: { k: "return", value: null }, statements: [loop] }, { kind: "void" }, [n, i]);
  const after = printed(fn);
  // Every name of the chain is bound once and read nowhere else, so none of them
  // is left reading another one of them.
  assert.doesNotMatch(after, /local\[i32\] v\d/);
  assert.deepEqual(semanticFunctionProblems(optimizeSemanticFunction(fn)), []);
});

test("a copy of a name the function writes is kept", () => {
  // `t` is the number the parameter held before the step, and the program reads
  // it after the step: reading the parameter instead would read what the
  // counter holds now, which is a different number.
  const depth: SemanticSlot = { kind: "value", name: "depth", mutable: true, type: F64 };
  const after = printed(fnOf({
    id: "entry", releases: [],
    terminator: { k: "return", value: { k: "compare", type: BOOL, op: "gt", operand: F64, left: { k: "local", type: F64, name: "t" }, right: constOf("0") } },
    statements: [
      { k: "let", slot: { kind: "value", name: "t", mutable: false, type: F64 }, value: { k: "local", type: F64, name: "depth" }, line: 1 },
      { k: "step", name: "depth", op: "--", prefix: false, line: 1 },
    ],
  }, BOOL, [depth]));
  assert.match(after, /local\[f64\] t/);
});

test("a write nothing reads is dropped", () => {
  const a: SemanticSlot = { kind: "value", name: "a", mutable: true, type: F64 };
  const sum: SemanticSlot = { kind: "value", name: "sum", mutable: true, type: F64 };
  const after = printed(fnOf({
    id: "entry", releases: [], terminator: { k: "return", value: { k: "local", type: F64, name: "sum" } },
    statements: [
      { k: "set", name: "a", op: "=", value: constOf("7"), line: 1 },
      { k: "set", name: "sum", op: "+=", value: constOf("2"), line: 2 },
    ],
  }, F64, [a, sum]));
  assert.doesNotMatch(after, /set a =/);
  assert.match(after, /set sum \+=/);
});

test("a write that runs a call is kept whatever reads it", () => {
  const a: SemanticSlot = { kind: "value", name: "a", mutable: true, type: F64 };
  const after = printed(fnOf({
    id: "entry", releases: [], terminator: { k: "return", value: null },
    statements: [{ k: "set", name: "a", op: "=", value: absOf(constOf("2")), line: 1 }],
  }, { kind: "void" }, [a]));
  assert.match(after, /set a = \[call\[f64\] Math\.abs/);
});

test("an `if` whose condition folded is replaced by the arm it selects", () => {
  const sum: SemanticSlot = { kind: "value", name: "sum", mutable: true, type: F64 };
  const after = printed(fnOf({
    id: "entry", releases: [], terminator: { k: "return", value: { k: "local", type: F64, name: "sum" } },
    statements: [
      { k: "if", line: 1, condition: { k: "bool", type: BOOL, value: false }, then: { id: "b1", releases: [], statements: [{ k: "set", name: "sum", op: "+=", value: constOf("9"), line: 1 }], terminator: { k: "next" } }, otherwise: { id: "b2", releases: [], statements: [{ k: "set", name: "sum", op: "+=", value: constOf("1"), line: 2 }], terminator: { k: "next" } } },
    ],
  }, F64, [sum]));
  assert.doesNotMatch(after, /if /);
  assert.match(after, /set sum \+= const\[f64\] 1\b/);
  assert.doesNotMatch(after, /const\[f64\] 9/);
});

test("what the new rewrites produce is a function the compiler may lower", () => {
  // Each rewrite the pass applies on its own, applied together: what they
  // produce is a function the driver would accept from a model, so it is one
  // the compiler may lower.
  const n: SemanticSlot = { kind: "value", name: "n", mutable: false, type: F64 };
  const i: SemanticSlot = { kind: "value", name: "i", mutable: false, type: I32 };
  const sum: SemanticSlot = { kind: "value", name: "sum", mutable: true, type: F64 };
  const readN: SemanticValue = { k: "local", type: F64, name: "n" };
  // The bound is read at the type the slot is declared as: `n` is an `f64`
  // here, and a bound read as an `i32` narrows it, which the validator refuses
  // — a rewrite that produced one would not be a function the compiler may
  // lower, and this test is what says the rewrites produce one.
  const loop = countedLoop(readN);
  const body = loop.k === "loop" ? loop.loop.body : { id: "b2", releases: [], statements: [], terminator: { k: "jump" as const, target: "b1", releases: [] } };
  body.statements = [
    { k: "let", slot: { kind: "value", name: "dead", mutable: false, type: F64 }, value: readN, line: 3 },
    { k: "set", name: "sum", op: "+=", value: bin("mul", readN, constOf("2")), line: 4 },
    { k: "set", name: "sum", op: "+=", value: bin("mul", readN, constOf("2")), line: 5 },
    { k: "if", line: 6, condition: { k: "bool", type: BOOL, value: true }, then: { id: "b3", releases: [], statements: [{ k: "set", name: "sum", op: "+=", value: constOf("3"), line: 6 }], terminator: { k: "next" } }, otherwise: null },
  ];
  const before = fnOf({
    id: "entry", releases: [], terminator: { k: "return", value: { k: "local", type: F64, name: "sum" } },
    statements: [loop],
  }, F64, [n, i, sum]);
  assert.deepEqual(semanticFunctionProblems(optimizeSemanticFunction(before), undefined as never), []);
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
      { k: "printNumber", value: bin("add", constOf("2"), constOf("3")), line: 2, bigint: false },
      countedLoop(bin("mul", readN, constOf("2"), I32)),
    ],
  }, { kind: "void" }, [n, i]);
  assert.deepEqual(semanticFunctionProblems(optimizeSemanticFunction(before), undefined as never), []);
});

test("the folded C computes what the unfolded C computes", async () => {
  // The proof that matters: the same function, lowered twice, once through the
  // pass and once not, run side by side. Every number below is written as an
  // expression the pass can rewrite, and the two binaries have to agree.
  // A case is either a constant expression, which the C driver evaluates, or an
  // expression over a parameter the driver is handed on the command line, so
  // that a fold which only applies to a value that is not written out is
  // reached at all. `inputs` are the arguments both binaries are run with, and
  // `expected` is what each of them has to print for each.
  interface Case {
    name: string;
    expression: SemanticValue;
    expected: string[];
    /** The parameter the expression reads, when it reads one. */
    parameter?: string;
    /** The values the parameter is given, one run apiece. */
    inputs?: string[];
  }
  const cases: Case[] = [
    { name: "a literal sum", expression: bin("add", constOf("2"), constOf("3")), expected: ["5"] },
    { name: "a literal product with an identity", expression: bin("mul", constOf("7"), constOf("1")), expected: ["7"] },
    { name: "a whole division by a power of two", expression: bin("div", constOf("64"), constOf("8"), I32), expected: ["8"] },
    { name: "a whole remainder by a power of two", expression: bin("mod", constOf("65"), constOf("8"), I32), expected: ["1"] },
    { name: "a shifted product", expression: bin("mul", constOf("3"), constOf("4"), I32), expected: ["12"] },
    { name: "an exact float sum", expression: bin("add", constOf("0.25"), constOf("0.5")), expected: ["0.75"] },
    { name: "a float divided by one", expression: bin("div", constOf("2.5"), constOf("1")), expected: ["2.5"] },
    { name: "a value against itself subtracted", expression: bin("sub", constOf("9"), constOf("9")), expected: ["0"] },
    // The identities above are over a value that is not written out, and there
    // they hold only where the value is a number. `x / x` is NaN at every zero
    // and every infinity, and `x - x` is NaN wherever `x` itself is one, so a
    // float folded here is a program that computed a NaN and is handed a one or
    // a zero instead. `literalOf` answers null for a name and null is not zero,
    // so the test this replaces — `literalOf(left) !== 0` — let every name
    // through, and `f(x) { return x / x }` answered 1 at `x = 0`.
    { name: "a float divided by itself", expression: bin("div", paramF("x"), paramF("x")), parameter: "x", inputs: ["0", "1", "2.5", "-4"], expected: ["NaN", "1", "1", "1"] },
    { name: "a float minus itself", expression: bin("sub", paramF("x"), paramF("x")), parameter: "x", inputs: ["0", "1", "2.5", "-4"], expected: ["0", "0", "0", "0"] },
    // A whole number has no NaN and no infinity to divide by, so the fold is
    // still taken there: this is what keeps the identity the backend's own
    // short-circuit already answers.
    { name: "a whole number divided by itself", expression: bin("div", paramI("x"), paramI("x"), I32), parameter: "x", inputs: ["1", "2", "7", "-9"], expected: ["1", "1", "1", "1"] },
    // The identities below are only reachable over a value that is not written
    // out, so they are driven from a parameter the C driver supplies rather
    // than from a literal: `x / 1`, `x % 1`, the bitwise identities and a
    // value against itself are all folds of two operands where one of them is
    // a name, and a case written only out of literals would never reach any of
    // them. Each is checked at a value chosen to break it if it were wrong:
    // a negative one, where a signed shift and a truncation disagree, and a
    // large one, where a mask has to have kept all of its bits.
    { name: "a value divided by one", expression: bin("div", paramI("x"), constOf("1", I32), I32), parameter: "x", inputs: ["-7", "0", "1", "2147483647"], expected: ["-7", "0", "1", "2147483647"] },
    { name: "a value remaindered by one", expression: bin("mod", paramI("x"), constOf("1", I32), I32), parameter: "x", inputs: ["-7", "0", "1", "2147483647"], expected: ["0", "0", "0", "0"] },
    // `x >>> 0` is the value whatever the signedness of x is, because a shift
    // by nothing moves no bit: at `i32` the answer for -7 is -7, and not the
    // 4294967289 an unsigned reading of the same bits would give. The C backend
    // spells `ushr` as `>>`, which at `i32` is an arithmetic shift, so this
    // case is what proves the fold is the identity the language states rather
    // than a conversion the fold happened to introduce.
    { name: "a value right shifted by nothing", expression: bin("ushr", paramI("x"), constOf("0", I32), I32), parameter: "x", inputs: ["-7", "0", "1", "2147483647"], expected: ["-7", "0", "1", "2147483647"] },
    { name: "a value ored with nothing", expression: bin("or", paramI("x"), constOf("0", I32), I32), parameter: "x", inputs: ["-7", "0", "1", "2147483647"], expected: ["-7", "0", "1", "2147483647"] },
    { name: "a value xored with nothing", expression: bin("xor", paramI("x"), constOf("0", I32), I32), parameter: "x", inputs: ["-7", "0", "1", "2147483647"], expected: ["-7", "0", "1", "2147483647"] },
    { name: "a value masked to nothing", expression: bin("and", paramI("x"), constOf("0", I32), I32), parameter: "x", inputs: ["-7", "0", "1", "2147483647"], expected: ["0", "0", "0", "0"] },
    { name: "a value masked to every bit", expression: bin("and", paramI("x"), constOf("255", U32), U32), parameter: "x", inputs: ["-7", "0", "1", "4294967295"], expected: ["249", "0", "1", "255"] },
    { name: "a value ored to every bit", expression: bin("or", paramI("x"), constOf("255", U32), U32), parameter: "x", inputs: ["0", "1", "4294967295"], expected: ["255", "255", "4294967295"] },
    { name: "a value xored to its complement", expression: bin("xor", paramI("x"), constOf("255", U32), U32), parameter: "x", inputs: ["0", "1", "255"], expected: ["255", "254", "0"] },
    { name: "a value against itself, equal", expression: cmp("eq", paramI("x"), paramI("x"), I32), parameter: "x", inputs: ["-7", "0", "1"], expected: ["1", "1", "1"] },
    { name: "a value against itself, not equal", expression: cmp("ne", paramI("x"), paramI("x"), I32), parameter: "x", inputs: ["-7", "0", "1"], expected: ["0", "0", "0"] },
    { name: "a value against itself, less", expression: cmp("lt", paramI("x"), paramI("x"), I32), parameter: "x", inputs: ["-7", "0", "1"], expected: ["0", "0", "0"] },
    { name: "a value against itself, at most", expression: cmp("le", paramI("x"), paramI("x"), I32), parameter: "x", inputs: ["-7", "0", "1"], expected: ["1", "1", "1"] },
    { name: "a value against itself, over", expression: cmp("ge", paramI("x"), paramI("x"), I32), parameter: "x", inputs: ["-7", "0", "1"], expected: ["1", "1", "1"] },
  ];
  const directory = await scratch("blaze-opt-");
  await writeFile(join(directory, "blaze_rt.h"), runtimeHeaderSource(), "utf8");
  const runtime = await buildStandaloneRuntime(directory);
  for (const one of cases) {
    const inputs = one.inputs ?? [""];
    for (const folded of [false, true]) {
      const fn = fnOf(
        {
          id: "entry", releases: [],
          statements: [{ k: "printNumber", value: one.expression, line: 1, bigint: false }, { k: "printNewline", line: 2 }],
          terminator: { k: "return", value: null },
        },
        one.parameter === undefined ? { kind: "void" } : one.expression.type,
        one.parameter === undefined
          ? []
          : [{ kind: "value", name: one.parameter, mutable: false, type: one.expression.type }],
      );
      const source = join(directory, `${folded ? "folded" : "plain"}_${one.name.replace(/\W/g, "_")}.c`);
      // The C driver reads its argument as the type the contract names, so the
      // unfolded and the folded binary are handed the very same number and the
      // only thing being compared is what each computes from it.
      const main =
        one.parameter === undefined
          ? "int main(void) { subject(); return 0; }"
          : [
            "#include <stdlib.h>",
            "int main(int argc, char** argv) {",
            `  subject((${primitiveOf(one.expression.type)})strtol(argv[1], NULL, 10));`,
            "  return 0;",
            "}",
          ].join("\n");
      await writeFile(
        source,
        ["#include <stdio.h>", generateFunctionC(folded ? optimizeSemanticFunction(fn) : fn), main, ""].join("\n"),
        "utf8",
      );
      const binary = source.replace(/\.c$/, "");
      const built = run("gcc", ["-std=c11", "-O2", "-I", directory, source, runtime.objectPath, "-o", binary, "-lm"], { timeoutMs: 120_000 });
      assert.equal(built.code, 0, `the C must build: ${built.stderr}`);
      for (const [at, input] of inputs.entries()) {
        const ran = run(binary, input === "" ? [] : [input], { timeoutMs: 60_000 });
        assert.equal(ran.stdout.trimEnd(), one.expected[at], `${one.name} at ${input === "" ? "no argument" : input}, ${folded ? "folded" : "unfolded"}`);
      }
    }
  }
});

test("an arm that returns keeps its return when the branch it selects is taken", () => {
  // The arm is spliced into the block the `if` was written in, and a return is
  // a terminator rather than a statement. Splicing the statements and dropping
  // the terminator turns this into a function that returns 2.
  const v: SemanticSlot = { kind: "value", name: "v", mutable: false, type: F64 };
  const fn = fnOf({
    id: "entry", releases: [],
    statements: [{
      k: "if",
      condition: { k: "bool", type: { kind: "primitive", name: "bool" }, value: true },
      then: { id: "b1", releases: [], statements: [], terminator: { k: "return", value: constOf("1") } },
      otherwise: null,
      line: 1,
    }],
    terminator: { k: "return", value: constOf("2") },
  }, F64, [v]);
  const after = optimizeSemanticFunction(fn);
  assert.equal(semanticFunctionProblems(after).length, 0, "the rewritten function must still validate");
  const arm = after.entry.statements.find((statement) => statement.k === "if");
  assert.ok(arm !== undefined, "the branch must survive, because its arm returns");
});

test("a name written again before anything reads it is written once", () => {
  // `set a = 1; set a = 2;` leaves `a` holding 2 either way, and the first
  // store is a slot, a value and a store on every target for nothing.
  const a: SemanticSlot = { kind: "value", name: "a", mutable: true, type: F64 };
  const after = printed(fnOf({
    id: "entry", releases: [], terminator: { k: "return", value: { k: "local", type: F64, name: "a" } },
    statements: [
      { k: "set", name: "a", op: "=", value: constOf("1"), line: 1 },
      { k: "set", name: "a", op: "=", value: constOf("2"), line: 2 },
    ],
  }, F64, [a]));
  assert.equal(after.match(/set a = /g)?.length ?? 0, 1, `the dead store survives:\n${after}`);
});

test("a compound assignment reads the name it writes", () => {
  // `s += x` is `s = s + x`, so the name is live whatever a later read says.
  const s: SemanticSlot = { kind: "value", name: "s", mutable: true, type: F64 };
  const x: SemanticSlot = { kind: "value", name: "x", mutable: false, type: F64 };
  const after = printed(fnOf({
    id: "entry", releases: [], terminator: { k: "return", value: { k: "local", type: F64, name: "s" } },
    statements: [{ k: "set", name: "s", op: "+=", value: { k: "local", type: F64, name: "x" }, line: 1 }],
  }, F64, [s, x]));
  assert.match(after, /set s \+=/, `a compound assignment is not a dead store:\n${after}`);
});

test("a name written as itself is not written at all", () => {
  // Folding turns `s += 0` into `s = s`, which is a load and a store of a name
  // into itself.
  const s: SemanticSlot = { kind: "value", name: "s", mutable: true, type: F64 };
  const after = printed(fnOf({
    id: "entry", releases: [], terminator: { k: "return", value: { k: "local", type: F64, name: "s" } },
    statements: [
      { k: "set", name: "s", op: "+=", value: constOf("0"), line: 1 },
      { k: "set", name: "s", op: "=", value: { k: "local", type: F64, name: "s" }, line: 2 },
    ],
  }, F64, [s]));
  assert.doesNotMatch(after, /set s =/, `a name written as itself is written:\n${after}`);
});

test("a store inside a loop body is not a store nothing saw", () => {
  // A loop body is a block of its own, but the block ends by falling through
  // into the one around the loop: `total = total + small + b` writes a name the
  // loop's own condition and the code after the loop both read, so nothing about
  // the body makes it a store nothing ever saw. Counting the block on its own
  // started the count from an empty set, found nothing after the assignment,
  // and deleted the assignment — and with it the binding it read.
  const total: SemanticSlot = { kind: "value", name: "total", mutable: true, type: F64 };
  const small: SemanticSlot = { kind: "value", name: "small", mutable: false, type: F64 };
  const b: SemanticSlot = { kind: "value", name: "b", mutable: false, type: F64 };
  const read = (name: string): SemanticValue => ({ k: "local", type: F64, name });
  const after = printed(fnOf({
    id: "entry",
    releases: [],
    statements: [
      { k: "let", slot: small, value: bin("mul", read("a"), constOf("3.0")), line: 2 },
      { k: "let", slot: total, value: constOf("0"), line: 3 },
      {
        k: "loop",
        line: 4,
        loop: {
          kind: "counted", variable: "i", type: I32,
          from: constOf("0", I32), to: constOf("8", I32), step: constOf("1", I32),
          inclusive: false, down: false, header: "b1", exit: "out",
          body: {
            id: "b2",
            releases: [],
            terminator: { k: "next" },
            statements: [
              { k: "set", name: "total", op: "=", value: bin("add", bin("add", read("total"), read("small")), read("b")), line: 5 },
            ],
          },
        },
      },
    ],
    terminator: { k: "return", value: read("total") },
  }, F64, [
    { kind: "value", name: "a", mutable: false, type: F64 },
    total,
    b,
  ]));
  assert.match(after, /set total = /, `the store inside the loop body is deleted:\n${after}`);
  assert.match(after, /let value\[f64\] small/, `the binding the store read is deleted with it:\n${after}`);
});

test("a plain assignment whose value reads the name is not a dead store", () => {
  // `s = s + x` is `s += x` written out, so the value the name held before is
  // read here and the store is live. Treating every plain assignment as reading
  // nothing concluded that `s = 1` above it was one nothing ever saw.
  const s: SemanticSlot = { kind: "value", name: "s", mutable: true, type: F64 };
  const x: SemanticSlot = { kind: "value", name: "x", mutable: false, type: F64 };
  const read = (name: string): SemanticValue => ({ k: "local", type: F64, name });
  const after = printed(fnOf({
    id: "entry",
    releases: [],
    statements: [
      { k: "set", name: "s", op: "=", value: constOf("1"), line: 1 },
      { k: "set", name: "s", op: "=", value: bin("add", read("s"), read("x")), line: 2 },
    ],
    terminator: { k: "return", value: read("s") },
  }, F64, [s, x]));
  assert.match(after, /set s = const\[f64\] 1/, `a store the next one reads is deleted:\n${after}`);
});

test("a store of a loop's own bound survives, because the loop reads it again", () => {
  // The bound of a counted loop is read on every turn, so a body that writes
  // it has written something the next turn reads. A walk that knows only what
  // follows the body concludes the write was one nothing ever saw, and the loop
  // then counts to the bound it started with.
  const limit: SemanticSlot = { kind: "value", name: "limit", mutable: true, type: I32 };
  const total: SemanticSlot = { kind: "value", name: "total", mutable: true, type: I32 };
  const after = printed(fnOf({
    id: "entry",
    releases: [],
    statements: [
      { k: "let", slot: limit, value: constOf("4", I32), line: 1 },
      { k: "let", slot: total, value: constOf("0", I32), line: 2 },
      {
        k: "loop",
        line: 3,
        loop: {
          kind: "counted", variable: "i", type: I32,
          from: constOf("0", I32), to: { k: "local", type: I32, name: "limit" }, step: constOf("1", I32),
          inclusive: false, down: false, header: "b1", exit: "entry",
          body: {
            id: "b2",
            releases: [],
            terminator: { k: "next" },
            statements: [
              { k: "set", name: "total", op: "+=", value: constOf("1", I32), line: 3 },
              { k: "set", name: "limit", op: "=", value: constOf("9", I32), line: 3 },
            ],
          },
        },
      },
    ],
    terminator: { k: "return", value: { k: "local", type: I32, name: "total" } },
  }, I32, [total]));
  assert.match(after, /set limit = const\[i32\] 9/, `a store the loop reads again is deleted:\n${after}`);
});

test("optimizing a function that is already optimized changes nothing", () => {
  // The pass runs to a fixed point and reports whether it changed anything by
  // comparing objects, so a round that rewrites a statement it did not need to
  // rewrite would keep the loop running for its whole budget.
  const a: SemanticSlot = { kind: "value", name: "a", mutable: false, type: F64 };
  const b: SemanticSlot = { kind: "value", name: "b", mutable: false, type: F64 };
  const once = optimizeSemanticFunction(fnOf({
    id: "entry", releases: [], terminator: { k: "return", value: { k: "local", type: F64, name: "a" } },
    statements: [
      { k: "let", slot: { kind: "value", name: "t", mutable: false, type: F64 }, value: bin("mul", { k: "local", type: F64, name: "a" }, { k: "local", type: F64, name: "b" }), line: 1 },
      { k: "set", name: "unused", op: "=", value: constOf("3"), line: 2 },
      { k: "set", name: "unused", op: "=", value: constOf("4"), line: 3 },
    ],
  }, F64, [a, b]));
  const twice = optimizeSemanticFunction(structuredClone(once));
  assert.equal(printSemanticFunction(twice), printSemanticFunction(once), "the second run is a no-op");
});

/* -------------------------------------------------------------------------- */
/* Unrolling                                                                   */
/* -------------------------------------------------------------------------- */

/** A counted loop with the ends a test writes down and a body of its own. */
function counting(
  to: SemanticValue,
  statements: SemanticBlock["statements"],
  over: Partial<Extract<SemanticStatement, { k: "loop" }>["loop"]> = {},
): SemanticStatement {
  return {
    k: "loop",
    line: 3,
    loop: {
      kind: "counted", variable: "i", type: I32,
      from: constOf("0", I32), to, step: constOf("1", I32),
      inclusive: false, down: false, header: "b1", exit: "entry",
      ...(over as object),
      body: { id: "b2", releases: [], statements, terminator: { k: "next" } },
    },
  };
}

/** `total += i`, which is what a body here mostly does. */
const addTheCounter = (total: string): SemanticStatement => ({
  k: "set", name: total, op: "+=", line: 3,
  value: { k: "local", type: I32, name: "i" },
});

/** A function that sums the counter, with the loop the test is about. */
function countingTo(to: SemanticValue, body: SemanticBlock["statements"], over?: Partial<Extract<SemanticStatement, { k: "loop" }>["loop"]>): SemanticFunction {
  const total: SemanticSlot = { kind: "value", name: "total", mutable: true, type: I32 };
  return fnOf({
    id: "entry",
    releases: [],
    statements: [
      { k: "let", slot: total, value: constOf("0", I32), line: 1 },
      counting(to, body, over),
    ],
    terminator: { k: "return", value: { k: "local", type: I32, name: "total" } },
  }, I32, [total]);
}

test("a loop that never turns is not a loop", () => {
  // `for (i = 0; i < 0; i++)` runs no turn at all, and the body of it is code
  // the source never reached — a counter that starts past its own bound.
  const after = printed(countingTo(constOf("0", I32), [addTheCounter("total")]));
  assert.doesNotMatch(after, /for\[/, `a loop with no turns is gone:\n${after}`);
  assert.doesNotMatch(after, /set total/, `and so is the body it never ran:\n${after}`);
});

test("a loop of a few turns is written out, each turn reading the number it is on", () => {
  // Three turns of `total += i` are 0, 1 and 2, and a counter read as the loop's
  // own name would be a name no block declares any more — the turn leaves the
  // loop, and the counter was declared in it.
  const after = printed(countingTo(constOf("3", I32), [addTheCounter("total")]));
  assert.doesNotMatch(after, /for\[/, `a loop of three turns is written out:\n${after}`);
  assert.match(after, /set total \+= const\[i32\] 0/, `the first turn reads zero:\n${after}`);
  assert.match(after, /set total \+= const\[i32\] 1/, `the second reads one:\n${after}`);
  assert.match(after, /set total \+= const\[i32\] 2/, `the third reads two:\n${after}`);
});

test("a loop of a few turns gives each turn the names it declares of its own", () => {
  // Two turns that both declare `t` are two turns writing the same slot, and the
  // second turn answers what the first one left there. The copy is renamed
  // beside the one it had, so the two are two names.
  const body: SemanticBlock["statements"] = [
    {
      k: "let", line: 3,
      slot: { kind: "value", name: "t", mutable: false, type: I32 },
      value: bin("add", { k: "local", type: I32, name: "total" }, { k: "local", type: I32, name: "i" }, I32),
    },
    { k: "set", name: "total", op: "+=", value: { k: "local", type: I32, name: "t" }, line: 3 },
  ];
  const fn = fnOf({
    id: "entry",
    releases: [],
    statements: [
      { k: "let", slot: { kind: "value", name: "total", mutable: true, type: I32 }, value: constOf("0", I32), line: 1 },
      counting(constOf("2", I32), body),
    ],
    terminator: { k: "return", value: { k: "local", type: I32, name: "total" } },
  }, I32, [{ kind: "value", name: "total", mutable: true, type: I32 }]);
  const after = printed(fn);
  const declared = [...after.matchAll(/let value\[i32\] (unrolled\d+) immutable/g)].map((one) => one[1]);
  assert.equal(declared.length, 2, `each turn declares a name of its own:\n${after}`);
  assert.equal(new Set(declared).size, 2, `and the two are not one name written twice:\n${after}`);
  assert.match(after, /unrolled\d+ immutable = \[add\[i32\] local\[i32\] total const\[i32\] 1\]/,
    `the second turn reads one, not zero:\n${after}`);
});

test("a loop of many turns is left as a loop, because writing it out is more code than it saves", () => {
  // Twenty turns of `total += i` is not twenty statements. Writing them all out
  // makes the loop twenty times the size for a loop that was one: the count is
  // taken when it is small enough to write down and the loop is left alone when
  // it is not. This is measured rather than assumed — unrolling a sixty-four
  // turn loop by copies instead measured four percent slower on the machine
  // backend, because every copy after the first has to work out its own number
  // off a counter that is still moving.
  const after = printed(countingTo(constOf("20", I32), [addTheCounter("total")]));
  assert.match(after, /for\[/, `a long loop is still a loop:\n${after}`);
  assert.match(after, /step const\[i32\] 1/, `with the step it was written with:\n${after}`);
  assert.equal((after.match(/set total \+= /g) ?? []).length, 1, `and one turn of it:\n${after}`);
});

test("a loop whose turns are too many statements together is left as it is written", () => {
  // Two turns of a body of forty statements is eighty statements of code where
  // the loop was forty and a jump. The cap is what stops a pass that makes the
  // code smaller from making it larger.
  const body: SemanticBlock["statements"] = Array.from({ length: 40 }, (_one, at) => ({
    k: "set", name: "total", op: "+=", line: 3,
    value: constOf(String(at), I32),
  }));
  const after = printed(countingTo(constOf("2", I32), body));
  assert.match(after, /for\[/, `a body too large to write out stays a loop:\n${after}`);
  assert.equal((after.match(/set total \+= /g) ?? []).length, 40, `with its body as it was:\n${after}`);
});

test("a loop that counts down is written out the same way it counts up", () => {
  // `for (i = 3; i >= 1; i--)` is three turns reading 3, 2 and 1, and the
  // second turn reads one less than the first — which is what the direction of
  // the step is for, and a turn that added the offset would read 4.
  const fn = countingTo(constOf("1", I32), [addTheCounter("total")], {
    variable: "i", type: I32,
    from: constOf("3", I32), to: constOf("1", I32), step: null,
    inclusive: true, down: true, header: "b1", exit: "entry",
  });
  const after = printed(fn);
  assert.doesNotMatch(after, /for\[/, `three turns are written out:\n${after}`);
  assert.match(after, /set total \+= const\[i32\] 3/, `the first turn reads three:\n${after}`);
  assert.match(after, /set total \+= const\[i32\] 2/, `the second reads two:\n${after}`);
  assert.match(after, /set total \+= const\[i32\] 1/, `the last reads one:\n${after}`);
});

test("a loop whose turn leaves the loop is left as it is written", () => {
  // A `continue` in the body would restart the unrolled loop rather than skip
  // the copy beside it, so the loop stays a loop. What the counter reads after
  // the loop is not asked about here either: the point is that the loop is one
  // the source wrote.
  const after = printed(countingTo(constOf("4", I32), [
    {
      k: "if", line: 3,
      condition: {
        k: "compare", type: BOOL, op: "lt", operand: I32,
        left: { k: "local", type: I32, name: "total" }, right: constOf("5", I32),
      },
      then: { id: "b3", releases: [], statements: [], terminator: { k: "jump", target: "b1", releases: [] } },
      otherwise: null,
    },
    addTheCounter("total"),
  ]));
  assert.match(after, /jump b1/, `the continue is still there:\n${after}`);
  assert.match(after, /for\[/, `and so is the loop it continues:\n${after}`);
});

test("a loop whose turn moves the counter is left as it is written", () => {
  // Which number a turn is on is what an unrolled turn is written against, so
  // a body that moves the counter itself has a turn that cannot be told from
  // the one beside it.
  const after = printed(countingTo(constOf("4", I32), [
    addTheCounter("total"),
    { k: "set", name: "i", op: "+=", value: constOf("0", I32), line: 3 },
  ]));
  assert.match(after, /set i \+= const\[i32\] 0/, `the body still moves the counter:\n${after}`);
  assert.equal((after.match(/set total \+= /g) ?? []).length, 1, `and it is still one turn:\n${after}`);
});

test("a counter that does not move toward its bound is left as it is written", () => {
  // `for (i = 0; i < 4; i--)`: the counter walks away from the bound it counts
  // to. Counting its turns means counting for ever, which is why this stops.
  const fn = countingTo(constOf("4", I32), [addTheCounter("total")], {
    variable: "i", type: I32,
    from: constOf("0", I32), to: constOf("4", I32), step: constOf("-1", I32),
    inclusive: false, down: false, header: "b1", exit: "entry",
  });
  const after = printed(fn);
  assert.match(after, /for\[/, `a loop that never ends is left alone:\n${after}`);
  assert.match(after, /step const\[i32\] -1/, `with the step it was written with:\n${after}`);
});

test("a loop over a buffer is not unrolled, because its length is not a number written out", () => {
  // The counter of a `for ... of` is a whole number too, but the loop counts
  // to a length read at run time, so there is no count to work out here.
  const values: SemanticSlot = { kind: "value", name: "values", mutable: false, type: { kind: "primitive", name: "u8" } };
  const fn = fnOf({
    id: "entry",
    releases: [],
    statements: [{
      k: "loop", line: 2,
      loop: {
        kind: "each", index: "k", element: "v", elementType: I32, of: "values",
        length: { k: "length", type: I32, of: { k: "local", type: { kind: "primitive", name: "u8" }, name: "values" } },
        header: "b1", exit: "entry",
        body: {
          id: "b2", releases: [], terminator: { k: "next" },
          statements: [{ k: "set", name: "k", op: "+=", value: constOf("0", I32), line: 2 }],
        },
      },
    }],
    terminator: { k: "return", value: null },
  }, { kind: "void" }, [values, { kind: "value", name: "k", mutable: true, type: I32 }]);
  const after = printed(fn);
  assert.match(after, /for_of\[/, `a walk over a buffer stays a walk:\n${after}`);
});

test("a statement nothing reaches after a raise is not lowered", () => {
  // A `raise` ends the program, so the store written after it is a load, an
  // add and a store a backend emits for a value nobody ever sees. The raise
  // stays — it is the reason the block ends — and what follows it goes.
  const sum: SemanticSlot = { kind: "value", name: "sum", mutable: true, type: F64 };
  const entry: SemanticBlock = {
    id: "entry", releases: [],
    statements: [
      { k: "raise", message: { k: "text", type: { kind: "text" }, parts: [{ k: "text", value: "no" }] }, line: 1 },
      { k: "set", name: "sum", op: "+=", value: constOf("1"), line: 2 },
      { k: "printNumber", value: constOf("7"), line: 3, bigint: false },
    ],
    terminator: { k: "return", value: null },
  };
  const after = printed(fnOf(entry, F64, [sum]));
  assert.doesNotMatch(after, /set sum \+=/, "the store after the raise is not lowered");
  assert.doesNotMatch(after, /const\[f64\] 7/, "nor is the print after it");
  assert.match(after, /raise/, "the raise itself stays");
});

test("a statement after an if whose two arms both leave is not lowered", () => {
  // Both arms return, so no path reaches what follows the `if` — whichever way
  // the condition went, the block has ended. This is the shape that
  // `pruneKnownBranches` refuses to splice, because it does not know the
  // condition, and it is a different question from that one: the arms are kept
  // and the statement after them is dropped.
  const arm = (value: string): SemanticBlock => ({
    id: `b_${value}`, releases: [], statements: [],
    terminator: { k: "return", value: constOf(value) },
  });
  const entry: SemanticBlock = {
    id: "entry", releases: [],
    statements: [
      {
        k: "if", line: 1,
        condition: { k: "compare", type: BOOL, op: "lt", operand: F64, left: constOf("1"), right: constOf("2") },
        then: arm("1"), otherwise: arm("2"),
      },
      { k: "printNumber", value: constOf("7"), line: 2, bigint: false },
    ],
    terminator: { k: "return", value: null },
  };
  const after = printed(fnOf(entry, F64, []));
  assert.doesNotMatch(after, /const\[f64\] 7/, "nothing reaches the print");
  assert.match(after, /if/, "the if stays: its condition is not known here");
});

test("a statement after an if with a falling arm is kept", () => {
  // The other half, and the one that matters: an `if` with no `otherwise`, or
  // with an arm that falls out of it, can be taken the other way, and then the
  // statement below it runs. Dropping it would delete a live store.
  const entry: SemanticBlock = {
    id: "entry", releases: [],
    statements: [
      {
        k: "if", line: 1,
        condition: { k: "compare", type: BOOL, op: "lt", operand: F64, left: constOf("1"), right: constOf("2") },
        then: { id: "b1", releases: [], statements: [], terminator: { k: "return", value: constOf("1") } },
        otherwise: null,
      },
      { k: "printNumber", value: constOf("7"), line: 7, bigint: false },
    ],
    terminator: { k: "return", value: null },
  };
  assert.match(printed(fnOf(entry, F64, [])), /const\[f64\] 7/, "the else path reaches the print");
});

test("a loop is not a transfer out of the block it is written in", () => {
  // The case a rewrite that reads a loop body's terminator gets wrong: a loop
  // body ends by jumping back to the header, so its terminator is a jump rather
  // than a fall-through, which looks like a transfer out and is the loop
  // working. What follows the loop is reached by every turn of it.
  const entry: SemanticBlock = {
    id: "entry", releases: [],
    statements: [
      {
        k: "loop", line: 1,
        loop: {
          kind: "counted", variable: "i", type: I32,
          from: constOf("0", I32), to: constOf("4", I32), inclusive: false, down: false, step: null,
          header: "b1", exit: "entry",
          body: { id: "b2", releases: [], statements: [], terminator: { k: "jump", target: "b1", releases: [] } },
        },
      },
      { k: "printNumber", value: constOf("7"), line: 7, bigint: false },
    ],
    terminator: { k: "return", value: null },
  };
  assert.match(printed(fnOf(entry, F64, [])), /const\[f64\] 7/, "the loop falls through to the print");
});

test("dropping what a raise makes unreachable still leaves a function the compiler may lower", () => {
  // The cut removes statements, and the validator reads the block that is left:
  // its releases name what it owns, and a binding the dropped statements made
  // is still named there. A cut that broke that would be refused here rather
  // than in a candidate.
  const owned: SemanticSlot = { kind: "object", name: "node", mutable: false, type: { kind: "ref", name: "Point", of: null } };
  const entry: SemanticBlock = {
    id: "entry", releases: ["node"],
    statements: [
      { k: "let", slot: owned, value: { k: "nothing", type: owned.type }, line: 1 },
      { k: "raise", message: { k: "text", type: { kind: "text" }, parts: [{ k: "text", value: "no" }] }, line: 2 },
      { k: "storeField", object: { k: "local", type: owned.type, name: "node" }, layout: "Point", field: "x", value: constOf("1"), line: 3 },
    ],
    terminator: { k: "return", value: null },
  };
  assert.deepEqual(semanticFunctionProblems(optimizeSemanticFunction(fnOf(entry, { kind: "void" }, []))), []);
});


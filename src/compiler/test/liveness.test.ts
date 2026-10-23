/**
 * Where a name is live, and what a call the body makes does to it.
 *
 * The machine backend keeps a name in a register on the answer to two
 * questions, and both of them come from here: whether two names are ever live
 * at once, and whether the value has to still be there after a call. The second
 * one is the subtle half, because a call that comes after a read inside the same
 * value does not see that read's value — an object is allocated before its
 * fields are written and a `select` asks its condition before either arm — and
 * a name on the wrong side of that difference is put in a register the call
 * writes over. So these pin the order, not just the fact of a call.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { nameLiveness, overlaps } from "../semantics/liveness.ts";
import type {
  SemanticBlock,
  SemanticCall,
  SemanticSlot,
  SemanticStatement,
  SemanticType,
  SemanticValue,
} from "../core/semantic-ir.ts";

const F64: SemanticType = { kind: "primitive", name: "f64" };
const BOOL: SemanticType = { kind: "primitive", name: "bool" };
const ANY_REF: SemanticType = { kind: "ref", of: null };
const TEXT: SemanticType = { kind: "text" };

const local = (name: string): SemanticValue => ({ k: "local", type: F64, name });
const number = (text: string): SemanticValue => ({ k: "const", type: F64, text });

/** A call of `f`, which is a call as far as anything here is concerned. */
const callOf = (argument: SemanticValue): SemanticValue => ({
  k: "call",
  type: F64,
  call: {
    callee: "f",
    builtin: false,
    signature: { name: "f", symbol: "f", params: [{ name: "v", type: "f64" }], returns: "f64" },
    args: [argument],
    argTypes: [F64],
    returns: F64,
    effects: [],
    ownership: "none",
    retain: false,
  } satisfies SemanticCall,
});

/** An object built out of a field, which allocates before it fills. */
const objectOf = (field: SemanticValue): SemanticValue => ({
  k: "newObject",
  type: ANY_REF,
  layout: "Point",
  fields: [{ name: "x", value: field }],
});

function block(statements: SemanticStatement[], returns: SemanticValue | null = null): SemanticBlock {
  return { id: "entry", statements, releases: [], terminator: { k: "return", value: returns } };
}

const letOf = (name: string, value: SemanticValue): SemanticStatement => ({
  k: "let",
  slot: { kind: "value", name, mutable: false, type: F64 } satisfies SemanticSlot,
  value,
  line: 1,
});

test("a name read on one side of a call and not the other is live across it", () => {
  // `let held = f(v)` then `let after = v + held`: `v` is read on both sides of
  // the call and has to be there afterwards, and `held` is what the call
  // answered with, so the call cannot take it.
  const facts = nameLiveness(
    block([letOf("held", callOf(local("v"))), letOf("after", { k: "arith", type: F64, op: "add", left: local("v"), right: local("held") })], local("after")),
  );
  assert.equal(facts.get("v")?.acrossCall, true, "v is read again after the call, so the call must not take it");
  assert.equal(facts.get("held")?.acrossCall, false, "the value the call answered with is made by the call");
});

test("a name only the condition of a select reads is dead before either arm calls", () => {
  // The shape `createTree` is: a comparison on a value the source copied, and
  // two arms that each allocate an object. The condition is asked before
  // either arm and the object is allocated before its fields are written, so
  // `t` is dead by the time either of them calls — while `v`, which the arms
  // read to fill the object, is not.
  const arm = (): SemanticValue =>
    ({
      k: "select",
      type: ANY_REF,
      condition: { k: "compare", type: BOOL, op: "gt", operand: F64, left: local("t"), right: number("0") },
      then: objectOf(local("v")),
      otherwise: objectOf(local("v")),
    }) satisfies SemanticValue;
  const facts = nameLiveness(block([letOf("t", local("v"))], arm()));
  assert.equal(facts.get("t")?.acrossCall, false, "the comparison is asked before either arm is built");
  assert.equal(facts.get("v")?.acrossCall, true, "the arms read v after they have allocated");
});

test("a name the return reads again has to survive a call made before it", () => {
  // The same comparison, but the value the condition read is what the function
  // hands back — so it is wanted after the arm, and the arm's allocation is a
  // call it cannot be put in a register across.
  const entry = block(
    [
      letOf("t", local("v")),
      {
        k: "if",
        condition: { k: "compare", type: BOOL, op: "gt", operand: F64, left: local("t"), right: number("0") },
        then: { id: "then", statements: [letOf("made", objectOf(local("v")))], releases: [], terminator: { k: "next" } },
        otherwise: null,
        line: 1,
      },
    ],
    local("t"),
  );
  assert.equal(nameLiveness(entry).get("t")?.acrossCall, true, "the value is wanted again after the arm runs");
});

test("a name a field of an object is written with has to survive the allocation", () => {
  // The allocation comes first, so a name only the field reads is live across
  // the call the allocation is.
  const facts = nameLiveness(block([letOf("made", objectOf(local("v")))], local("made")));
  assert.equal(facts.get("v")?.acrossCall, true, "the field is written after the object is allocated");
});

test("a parameter is live from the first instruction of the body", () => {
  // A parameter's value is written by the prologue, so a run that started at its
  // first read would let another name take its register over the prologue.
  const facts = nameLiveness(block([letOf("out", local("v"))], local("out")), ["v"]);
  const live = facts.get("v")?.live ?? [];
  assert.equal(live[0]?.[0], 0, "the run a parameter is live over starts at the prologue");
});

test("a value no call reaches and one a call reaches are live at once", () => {
  const facts = nameLiveness(
    block([letOf("before", local("v")), letOf("held", callOf(local("v"))), letOf("after", local("held"))], local("after")),
  );
  const before = facts.get("before");
  const held = facts.get("held");
  if (before === undefined || held === undefined) {
    assert.fail("both names are declared and read, so both are live somewhere");
  }
  assert.equal(overlaps(before.live, held.live), false, "one is dead before the other exists, so they can share");
});

test("a loop that calls leaves what it accumulates live across the call", () => {
  const entry: SemanticBlock = {
    id: "entry",
    statements: [
      { k: "let", slot: { kind: "value", name: "sum", mutable: true, type: F64 }, value: number("0"), line: 1 },
      {
        k: "loop",
        loop: {
          kind: "counted",
          variable: "i",
          type: F64,
          from: number("0"),
          to: number("3"),
          inclusive: false,
          down: false,
          step: null,
          header: "head",
          exit: "out",
          body: {
            id: "body",
            statements: [{ k: "set", name: "sum", op: "+=", value: callOf(local("i")), line: 2 }],
            releases: [],
            terminator: { k: "next" },
          },
        },
        line: 2,
      },
    ],
    releases: [],
    terminator: { k: "return", value: local("sum") },
  };
  const facts = nameLiveness(entry);
  assert.equal(facts.get("sum")?.acrossCall, true, "the accumulator is carried from one turn to the next over the call");
  assert.equal(facts.get("i")?.acrossCall, true, "the counter is stepped after the call that reads it");
});

test("a name the left of a difference names is read after the call its right makes", () => {
  // `v - f()` is written right side first: the answer is written down and `v` is
  // read against it, so the call happens first and `v` has to still be there
  // afterwards. A name marked dead before that call is given a register the
  // callee is free to write over before it is read.
  const facts = nameLiveness(
    block([letOf("v", number("1"))], { k: "arith", type: F64, op: "sub", left: local("v"), right: callOf(number("0")) }),
  );
  assert.equal(facts.get("v")?.acrossCall, true, "the value is read after the call, so the call cannot take it");
});

test("a name a concatenation reads after its first part is live across that part", () => {
  // A concatenation is laid out a part at a time from the left, and each part
  // is measured before the buffer that holds them is laid out — a call per
  // part. So the second part is read after the first has been measured, and a
  // name it reads has to still be there: given a register the call writes over
  // it, the join measures the pointer that call left in its place.
  const written: SemanticValue = { k: "text", type: TEXT, parts: [{ k: "text", value: "ab" }] };
  const facts = nameLiveness(
    block([letOf("v", number("1"))], { k: "arith", type: TEXT, op: "concat", left: written, right: local("v") }),
  );
  assert.equal(facts.get("v")?.acrossCall, true, "the part behind the first one is read after the first is measured");
});

test("a name only the other arm of a branch reads is not live across that branch", () => {
  // The arms of a branch run on turns of their own, so the arm that is not
  // taken does not reach the other one: a name the else arm reads is not live
  // where the then arm hands something back to the runtime. Linking the two
  // arms made every such name live across that hand-back, and a name live
  // across a call has to be held in a register the convention asks a callee to
  // preserve — a push and a pop in the prologue and the epilogue for a value
  // the two arms never share.
  const entry = block([
    {
      k: "if",
      condition: { k: "bool", type: BOOL, value: true },
      then: { id: "then", statements: [], releases: ["held"], terminator: { k: "next" } },
      otherwise: { id: "else", statements: [letOf("there", local("b"))], releases: [], terminator: { k: "next" } },
      line: 1,
    },
  ]);
  const facts = nameLiveness(entry, ["b"]);
  assert.equal(facts.get("b")?.acrossCall, false, "the value is read in the other arm, not across the hand-back");
});

test("a name the left of a minimum names is read before the right one is", () => {
  // Both sides of a minimum are taken and then compared, so a name on the left
  // is read before anything on the right — including a call there.
  const facts = nameLiveness(
    block([letOf("v", number("1"))], { k: "arith", type: F64, op: "min", left: local("v"), right: callOf(number("0")) }),
  );
  assert.equal(facts.get("v")?.acrossCall, false, "the value is read before the call on the other side");
});
test("a fill reads the array it writes into and is no definition of it", () => {
  // `a.fill(f(v))` writes every element of the array as one value: the value
  // the walk writes is read once, the array is read as the place the elements
  // go into, and the pointer keeps what it held — so a name another statement
  // reads of the array afterwards is not a register the fill took, and the
  // value's call is one the walk is inside.
  const fill: SemanticStatement = {
    k: "fill",
    buffer: "a",
    index: "blaze_fill_i",
    value: callOf(local("v")),
    type: F64,
    line: 1,
  };
  const facts = nameLiveness(block([fill], local("v")));
  assert.ok(facts.get("a") !== undefined, "the array is read for the walk");
  assert.equal(facts.get("v")?.acrossCall, true, "the value is read where the call is, before the walk runs");
});

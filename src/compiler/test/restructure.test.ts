/**
 * What the cost-guided restructuring pass does to a hot function, and that
 * what it does is the same program.
 *
 * The pass is the one half of the optimizer that crosses a call boundary: a
 * callee the program writes out, called from one hot site, whose body is cheap
 * against the call it removes, is written into the caller — and the caller's
 * call edges and layouts are updated to say what the fused body does. The
 * tests here are hand-written IR, because the question is about the splice, the
 * edges it leaves behind, and the reasons it declines to make it, and a
 * hand-written body is the shortest one that asks it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { restructureHotFunction, type FunctionProfile } from "../semantics/restructure.ts";
import { printSemanticFunction } from "../semantics/ir-text.ts";
import type { CallEdge } from "../core/types.ts";
import type {
  SemanticBlock,
  SemanticCall,
  SemanticFunction,
  SemanticSlot,
  SemanticStatement,
  SemanticTerminator,
  SemanticType,
  SemanticValue,
} from "../core/semantic-ir.ts";

const VOID = { kind: "void" } as const;
const I32 = { kind: "primitive", name: "i32" } as const;

function call(callee: string, returns: SemanticType = VOID): SemanticCall {
  return {
    callee,
    signature: { name: callee, symbol: callee, params: [], returns: returns === VOID ? "void" : "i32" },
    args: [],
    argTypes: [],
    returns,
    effects: [],
    ownership: "none",
    retain: false,
    builtin: false,
  };
}

function fn(name: string, entry: SemanticBlock, calls: CallEdge[] = [], params: SemanticSlot[] = []): SemanticFunction {
  return {
    name,
    symbol: name,
    params,
    returns: VOID,
    requires: [],
    ensures: [],
    effects: [],
    allocates: false,
    prints: false,
    readsArgv: false,
    objects: {},
    calls,
    entry,
  };
}

function entry(statements: SemanticStatement[], terminator: SemanticTerminator = { k: "return", value: null }): SemanticBlock {
  return { id: "entry", releases: [], statements, terminator };
}

const zero: SemanticValue = { k: "const", type: I32, text: "0" };
const one: SemanticValue = { k: "const", type: I32, text: "1" };

/** A counted loop whose turns the compiler can count, so a call inside it is hot. */
function countedLoop(body: SemanticBlock, turns: number): SemanticStatement {
  return {
    k: "loop",
    line: 1,
    loop: {
      kind: "counted",
      variable: "i",
      type: I32,
      from: zero,
      to: { k: "const", type: I32, text: String(turns) },
      step: one,
      inclusive: false,
      down: false,
      header: "b1",
      exit: "b2",
      body,
    },
  };
}

/** A loop over a bound the compiler cannot read, whose cost is the middle case. */
function openLoop(body: SemanticBlock, bound: string): SemanticStatement {
  return {
    k: "loop",
    line: 1,
    loop: {
      kind: "counted",
      variable: "i",
      type: I32,
      from: zero,
      to: { k: "local", type: I32, name: bound },
      step: one,
      inclusive: false,
      down: false,
      header: "b1",
      exit: "b2",
      body,
    },
  };
}

function leaf(): SemanticFunction {
  return fn("leaf", entry([]));
}

/** A helper whose body is one call, so it is cheap against the call it removes. */
function helper(calls: CallEdge[], statements: SemanticStatement[] = [{ k: "call", line: 1, call: call("leaf") }]): SemanticFunction {
  return fn("helper", entry(statements), calls);
}

/** A subject whose body is the loop it calls `helper` from. */
function subjectCallingHelper(loop: SemanticStatement): SemanticFunction {
  return fn(
    "subject",
    entry([loop]),
    [{ callee: "helper", strategy: "inline" }],
    [{ kind: "value", name: "n", mutable: false, type: I32 }],
  );
}

const turn = (callee: string): SemanticBlock => ({
  id: "b2",
  releases: [],
  terminator: { k: "jump", target: "b1", releases: [] },
  statements: [{ k: "call", line: 1, call: call(callee) }],
});

function calleesOf(...functions: SemanticFunction[]): Map<string, SemanticFunction> {
  return new Map(functions.map((one) => [one.name, one]));
}

/** The callees a program writes out and that may therefore be fused. */
function fusible(calls: CallEdge[]): Map<string, SemanticFunction> {
  return calleesOf(helper(calls), leaf());
}

function applied(outcome: ReturnType<typeof restructureHotFunction>): SemanticFunction {
  assert.ok("applied" in outcome, `the fusion holds: ${"refused" in outcome ? outcome.refused : ""}`);
  return outcome.applied;
}

test("a non-leaf callee called once in a loop is fused, and the caller's edges follow", () => {
  // `helper` calls `leaf`, so the review rule refuses it: a callee that calls
  // something is not one that rule can put anywhere. This is the case the
  // restructuring pass exists for, and it is safe because the program's
  // outline already writes `helper` out, which makes `leaf` a call the caller
  // may name.
  const subject = subjectCallingHelper(openLoop(turn("helper"), "n"));
  const fused = applied(restructureHotFunction(subject, fusible([{ callee: "leaf", strategy: "inline" }])));
  assert.deepEqual(
    fused.calls.map((edge) => edge.callee),
    ["leaf"],
    "the caller now names what the fused body calls",
  );
  const ir = printSemanticFunction(fused);
  assert.match(ir, /call leaf/);
  assert.doesNotMatch(ir, /call helper/);
  // The call is still on a hot path: it was inside the loop, and it is inside
  // the loop after the splice.
  const loop = fused.entry.statements[0] as Extract<SemanticStatement, { k: "loop" }>;
  const body = loop.loop.body.statements[0] as Extract<SemanticStatement, { k: "call" }>;
  assert.equal(body.call.callee, "leaf");
});

test("the note says what was fused and how often it ran", () => {
  const subject = subjectCallingHelper(countedLoop(turn("helper"), 40));
  const outcome = restructureHotFunction(subject, fusible([{ callee: "leaf", strategy: "inline" }]));
  assert.ok("note" in outcome, `the fusion holds: ${"refused" in outcome ? outcome.refused : ""}`);
  assert.match(outcome.note, /fused helper into b2 in subject, which runs 40 times/);
});

test("a callee called from more than one site is refused by the call count", () => {
  // Fusing a callee called twice copies its body into both places, which is
  // code growth without a call boundary to remove.
  const twice: SemanticBlock = {
    id: "b2",
    releases: [],
    terminator: { k: "jump", target: "b1", releases: [] },
    statements: [
      { k: "call", line: 1, call: call("helper") },
      { k: "call", line: 2, call: call("helper") },
    ],
  };
  const outcome = restructureHotFunction(subjectCallingHelper(openLoop(twice, "n")), fusible([{ callee: "leaf", strategy: "inline" }]));
  assert.ok("refused" in outcome);
  assert.match(outcome.refused, /helper is called 2 times in subject/);
});

test("a callee called once outside a loop is refused for want of heat", () => {
  // One call removed once is not worth the code it adds, and with no profile
  // there is nothing saying that call is hot.
  const subject = fn("subject", entry([{ k: "call", line: 1, call: call("helper") }]), [{ callee: "helper", strategy: "inline" }]);
  const outcome = restructureHotFunction(subject, fusible([{ callee: "leaf", strategy: "inline" }]));
  assert.ok("refused" in outcome);
  assert.match(outcome.refused, /runs once in subject, and nothing says that call is hot/);
});

test("a profile makes a call outside a loop worth having removed", () => {
  // This is the half of the rule that needs a measurement: a caller the
  // profile has seen run many times pays for the call on every one of them.
  const subject = fn("subject", entry([{ k: "call", line: 1, call: call("helper") }]), [{ callee: "helper", strategy: "inline" }]);
  const profile: FunctionProfile = { callCount: 12000, durationNs: 3_000_000 };
  const fused = applied(restructureHotFunction(subject, fusible([{ callee: "leaf", strategy: "inline" }]), { profile }));
  assert.match(printSemanticFunction(fused), /call leaf/);
});

test("a recursive callee is refused on the recursion, not on its size", () => {
  // A body that reaches itself is not a body the IR can write into another,
  // however deep the reaching goes.
  const subject = subjectCallingHelper(openLoop(turn("helper"), "n"));
  const outcome = restructureHotFunction(subject, fusible([
    { callee: "leaf", strategy: "inline" },
    { callee: "helper", strategy: "inline" },
  ]));
  assert.ok("refused" in outcome);
  assert.match(outcome.refused, /helper reaches itself/);
});

test("a callee that reaches its caller back is refused", () => {
  const subject = subjectCallingHelper(openLoop(turn("helper"), "n"));
  const outcome = restructureHotFunction(subject, fusible([
    { callee: "leaf", strategy: "inline" },
    { callee: "subject", strategy: "call" },
  ]));
  assert.ok("refused" in outcome);
  assert.match(outcome.refused, /helper reaches subject, which is the function it would be written into/);
});

test("a callee whose own call the caller may not name is refused", () => {
  // The outline wrote `helper` out, but `leaf` is a call it keeps. Writing
  // `helper`'s body into the caller would put a call to `leaf` in a function
  // the program does not say may name it, which is an IR the reader refuses.
  const outcome = restructureHotFunction(
    subjectCallingHelper(openLoop(turn("helper"), "n")),
    fusible([{ callee: "leaf", strategy: "call" }]),
  );
  assert.ok("refused" in outcome);
  assert.match(outcome.refused, /helper calls something subject may not name/);
});

test("a callee the program keeps as a call is not a fusion candidate at all", () => {
  // `strategy: "call"` means the outline decided this callee's body was worth
  // verifying on its own and linking beside the caller. Restructuring does not
  // overrule that, and does not spend the rest of its budget looking.
  const loop = openLoop(turn("helper"), "n");
  const subject = fn(
    "subject",
    entry([loop]),
    [{ callee: "helper", strategy: "call" }],
    [{ kind: "value", name: "n", mutable: false, type: I32 }],
  );
  const outcome = restructureHotFunction(subject, calleesOf(
    helper([{ callee: "leaf", strategy: "inline" }]),
    leaf(),
  ));
  assert.ok("refused" in outcome);
  assert.match(outcome.refused, /subject calls nothing the program writes out/);
});

test("a callee whose body costs more than the call is refused on cost", () => {
  // The whole of what a fusion removes is one call. A body of thirty turns of
  // a loop copied in to save one call is code the call was buying for nothing,
  // and the caller is worse off for holding the callee's names.
  const heavy: SemanticStatement[] = [];
  for (let index = 0; index < 6; index += 1) heavy.push({ k: "call", line: index + 1, call: call("leaf") });
  const subject = subjectCallingHelper(countedLoop(turn("helper"), 64));
  const outcome = restructureHotFunction(
    subject,
    calleesOf(helper([{ callee: "leaf", strategy: "inline" }], heavy), leaf()),
  );
  assert.ok("refused" in outcome);
  assert.match(outcome.refused, /helper costs \d+, and removing one call is worth 12/);
});

test("a caller that would grow past the statement budget is refused", () => {
  // Growth is bounded by the caller as well as the callee: one small body
  // copied into an already large function is still growth.
  const body: SemanticStatement[] = [{ k: "call", line: 1, call: call("helper") }];
  for (let index = 0; index < 60; index += 1) {
    body.push({ k: "let", line: index + 2, slot: { kind: "value", name: `v${index}`, mutable: false, type: I32 }, value: zero });
  }
  const loop: SemanticBlock = {
    id: "b2",
    releases: [],
    terminator: { k: "jump", target: "b1", releases: [] },
    statements: body,
  };
  const outcome = restructureHotFunction(
    subjectCallingHelper(openLoop(loop, "n")),
    fusible([{ callee: "leaf", strategy: "inline" }]),
    { maxCallerStatements: 40 },
  );
  assert.ok("refused" in outcome);
  assert.match(outcome.refused, /subject would grow past 40 statements/);
});

test("the estimate reads a callee at its own cost, not at the cost of a name", () => {
  // A call inside a value is the call plus whatever it calls: two calls made
  // one inside the other cost two calls and both bodies, not one. `nested` is
  // a statement holding nothing but a call, so a pass that counted the call
  // node alone would weigh it at one and would fuse it; a pass that counted
  // only the call and not the callee behind it would weigh it at twelve and
  // would still fuse it. It is `leaf` behind the call that puts it over.
  const nested = fn("nested", entry([{ k: "call", line: 1, call: call("leaf") }]), [{ callee: "leaf", strategy: "inline" }]);
  const loop = openLoop(turn("nested"), "n");
  const subject = fn(
    "subject",
    entry([loop]),
    [{ callee: "nested", strategy: "inline" }],
    [{ kind: "value", name: "n", mutable: false, type: I32 }],
  );
  const outcome = restructureHotFunction(subject, calleesOf(nested, leaf()), { maxCalleeCost: 20 });
  assert.ok("refused" in outcome, "the body behind the call is what the estimate is reading");
  assert.match(outcome.refused, /nested costs 2[45], and removing one call is worth 12/);
});

/**
 * The explicit cost contracts: one shared cost model, a call whose callee is
 * absent reported as unknown, and no silent "a call and nothing more" charge
 * in the validator's assessment.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_COST_MODEL, resolveCallCost } from "../semantics/cost-model.ts";
import { refusalFor, turnCostAssessment, turnIsTooCheap, type Callees } from "../semantics/parallel.ts";
import { semanticFunctionOutcome } from "../semantics/ir-validate.ts";
import type { SemanticBlock, SemanticCall, SemanticFunction, SemanticLoop, SemanticStatement, SemanticValue } from "../core/semantic-ir.ts";

const VOID = { kind: "void" } as const;

function call(callee: string): SemanticCall {
  return {
    callee,
    signature: { name: callee, symbol: callee, params: [], returns: "void" },
    args: [],
    argTypes: [],
    returns: VOID,
    effects: [],
    ownership: "none",
    retain: false,
    builtin: false,
  };
}

function callStatement(callee: string): SemanticStatement {
  return { k: "call", line: 1, call: call(callee) };
}

function block(statements: SemanticStatement[]): SemanticBlock {
  return { id: "entry", releases: [], statements, terminator: { k: "return", value: null } };
}

function fn(name: string, statements: SemanticStatement[]): SemanticFunction {
  return {
    name,
    symbol: name,
    params: [],
    returns: VOID,
    requires: [],
    ensures: [],
    effects: [],
    allocates: false,
    prints: false,
    readsArgv: false,
    objects: {},
    calls: [],
    entry: block(statements),
  };
}

test("resolving a call cost states when the callee is unknown", () => {
  const callee = fn("helper", [callStatement("leaf")]);
  const callees: Callees = new Map([["helper", callee]]);
  assert.deepEqual(resolveCallCost("helper", callees), { status: "known", value: DEFAULT_COST_MODEL.call });
  const missing = resolveCallCost("leaf", callees);
  assert.equal(missing.status, "unknown");
  assert.match(missing.status === "unknown" ? missing.reason : "", /leaf/);
  // A builtin is the compiler's own, so it is known without a body in the map.
  assert.deepEqual(resolveCallCost("Math.floor", callees, DEFAULT_COST_MODEL, true), { status: "known", value: DEFAULT_COST_MODEL.call });
});

test("a turn that calls a body the build holds has a known assessment", () => {
  const body = block([callStatement("helper")]);
  const callee = fn("helper", [callStatement("leaf"), callStatement("leaf")]);
  const callees: Callees = new Map([["helper", callee], ["leaf", fn("leaf", [])]]);
  const assessment = turnCostAssessment(body, callees);
  assert.equal(assessment.status, "known");
  assert.ok(assessment.status === "known" && assessment.value > 2, "the callee's body is part of the turn's work");
});

test("a turn that calls a body the build lacks is unknown, not measured as a bare call", () => {
  const body = block([callStatement("helper")]);
  const assessment = turnCostAssessment(body, new Map());
  assert.equal(assessment.status, "unknown");
  assert.match(assessment.status === "unknown" ? assessment.reason : "", /no body/);
});

test("a turn whose cost has no bound is incomplete, not cheap", () => {
  const body = block([callStatement("helper")]);
  const recursive = fn("helper", [callStatement("helper")]);
  const assessment = turnCostAssessment(body, new Map([["helper", recursive]]));
  assert.equal(assessment.status, "incomplete");
});

test("the boolean backend verdict stays conservative for a build with no callees", () => {
  // A backend that runs turns itself has no callee bodies; it must not hand a
  // turn to a thread on a number it could not measure. It keeps the lower bound
  // even though the validator's assessment is unknown.
  const body = block([callStatement("helper")]);
  assert.equal(turnIsTooCheap(body, new Map()), true);
});

const I32 = { kind: "primitive", name: "i32" } as const;
const num = (text: string): SemanticValue => ({ k: "const", type: I32, text });

test("a validator missing a callee body reports incomplete, not a contradictory rejection", () => {
  // The loop is marked parallel and big enough that only the missing callee
  // stands in the way of proving it. The validator cannot know what the callee
  // writes, so its answer is a gap in information, not a failed program.
  const statements: SemanticStatement[] = [callStatement("missing")];
  for (let index = 0; index < 10; index += 1) {
    statements.push({ k: "let", line: index + 2, slot: { kind: "value", name: `v${index}`, mutable: false, type: I32 }, value: num("1") });
  }
  const loop: SemanticStatement = {
    k: "loop",
    line: 1,
    loop: {
      kind: "counted",
      variable: "i",
      type: I32,
      from: num("0"),
      to: num("100"),
      step: num("1"),
      inclusive: false,
      down: false,
      header: "b1",
      exit: "b2",
      parallel: true,
      reductions: [],
      body: { id: "b1", releases: [], statements, terminator: { k: "jump", target: "b1", releases: [] } },
    },
  };
  const subject = fn("subject", [loop]);
  const outcome = semanticFunctionOutcome(subject, undefined, new Map());
  assert.equal(outcome.status, "incomplete");
  assert.match(outcome.status === "incomplete" ? outcome.reason : "", /cannot prove/);
});

test("optimizer and validator price the same loop with the same callee map", () => {
  // A pure callee whose body is known makes the turn large enough to thread.
  // The optimizer's refusal and the validator's verdict are both computed from
  // the same context, so one cannot admit a loop the other rejects.
  const helperStatements: SemanticStatement[] = [];
  for (let index = 0; index < 10; index += 1) {
    helperStatements.push({ k: "let", line: index + 1, slot: { kind: "value", name: `h${index}`, mutable: false, type: I32 }, value: num("1") });
  }
  const callees: Callees = new Map([["helper", fn("helper", helperStatements)]]);
  const statements: SemanticStatement[] = [callStatement("helper")];
  for (let index = 0; index < 10; index += 1) {
    statements.push({ k: "let", line: index + 2, slot: { kind: "value", name: `v${index}`, mutable: false, type: I32 }, value: num("1") });
  }
  const loop: SemanticLoop = {
    kind: "counted",
    variable: "i",
    type: I32,
    from: num("0"),
    to: num("100"),
    step: num("1"),
    inclusive: false,
    down: false,
    header: "b1",
    exit: "b2",
    parallel: true,
    reductions: [],
    body: { id: "b1", releases: [], statements, terminator: { k: "jump" as const, target: "b1", releases: [] } },
  };
  assert.equal(refusalFor(loop, callees, DEFAULT_COST_MODEL), null);
  const subject = fn("subject", [{ k: "loop", line: 1, loop }]);
  assert.equal(semanticFunctionOutcome(subject, undefined, callees, DEFAULT_COST_MODEL).status, "passed");
});

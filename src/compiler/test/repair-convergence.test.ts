/**
 * Repair terminates on the state of the program, not on an arbitrary round
 * count. These tests drive the tracker directly, with no model and no linker.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { RepairConvergence, stateFingerprint, type RepairState } from "../semantics/repair-convergence.ts";

const implementations = (text: string): RepairState => ({ implementations: { f: text } });

test("a verified round converges regardless of how many states were visited", () => {
  const convergence = new RepairConvergence({ maxRounds: 10 });
  assert.deepEqual(convergence.observe(implementations("return 1"), false), { status: "continue" });
  assert.deepEqual(convergence.observe(implementations("return 2"), true), { status: "converged", reason: "the program matches its source" });
});

test("a program that needs more than two rounds can converge", () => {
  const convergence = new RepairConvergence({ maxRounds: 6 });
  for (let round = 1; round <= 4; round += 1) {
    assert.deepEqual(convergence.observe(implementations(`return ${round}`), false), { status: "continue" });
  }
  assert.equal(convergence.observe(implementations("return 5"), true).status, "converged");
});

test("the immediately repeated state is a fixed point, not progress", () => {
  const convergence = new RepairConvergence({ maxRounds: 8 });
  assert.equal(convergence.observe(implementations("return 1"), false).status, "continue");
  const again = convergence.observe(implementations("return 1"), false);
  assert.equal(again.status, "incomplete");
  assert.match(again.status === "incomplete" ? again.reason : "", /fixed point/);
});

test("returning to an earlier state is a cycle", () => {
  const convergence = new RepairConvergence({ maxRounds: 8 });
  assert.equal(convergence.observe(implementations("return 1"), false).status, "continue");
  assert.equal(convergence.observe(implementations("return 2"), false).status, "continue");
  const back = convergence.observe(implementations("return 1"), false);
  assert.equal(back.status, "incomplete");
  assert.match(back.status === "incomplete" ? back.reason : "", /already visited/);
});

test("budget exhaustion is incomplete, never a successful verdict", () => {
  const convergence = new RepairConvergence({ maxRounds: 3 });
  assert.equal(convergence.observe(implementations("return 1"), false).status, "continue");
  assert.equal(convergence.observe(implementations("return 2"), false).status, "continue");
  const exhausted = convergence.observe(implementations("return 3"), false);
  assert.equal(exhausted.status, "incomplete");
  assert.match(exhausted.status === "incomplete" ? exhausted.reason : "", /budget/);
});

test("a mismatch that changes counts as progress even when code does not", () => {
  const convergence = new RepairConvergence({ maxRounds: 4 });
  const first: RepairState = { implementations: { f: "return 1" }, mismatch: "line 1" };
  const second: RepairState = { implementations: { f: "return 1" }, mismatch: "line 2" };
  assert.notEqual(stateFingerprint(first), stateFingerprint(second));
  assert.equal(convergence.observe(first, false).status, "continue");
  assert.equal(convergence.observe(second, false).status, "continue");
});

test("a fingerprint ignores the order unit names were inserted", () => {
  const left: RepairState = { implementations: { a: "1", b: "2" } };
  const right: RepairState = { implementations: { b: "2", a: "1" } };
  assert.equal(stateFingerprint(left), stateFingerprint(right));
});

/**
 * Choosing among candidates that were proved against the contract.
 *
 * A candidate the build did not time has no benchmark at all — a program the
 * harness checks as a whole is measured there, not once per function. The
 * choice has to answer which candidate is faster even then, and a size objective
 * has to choose without any timing at all.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { selectCandidate } from "../codegen.ts";
import type { CandidateOutcome, FunctionContract } from "../core/types.ts";

const contract = (primary: string): FunctionContract =>
  ({ optimize: { primary } }) as unknown as FunctionContract;

const outcome = (candidate: string, over: Partial<CandidateOutcome> = {}): CandidateOutcome =>
  ({ candidate, valid: true, ...over }) as CandidateOutcome;

test("a candidate that was not timed can still be selected", () => {
  // The fallback for a missing benchmark used to read a field of the missing
  // benchmark itself, which threw before the fallback could answer.
  const outcomes = [outcome("c1"), outcome("c2", { benchmark: { durationNs: 12 } } as CandidateOutcome)];
  assert.equal(selectCandidate(outcomes, contract("latency")), "c2");
  assert.equal(selectCandidate([outcome("c1")], contract("latency")), "c1");
});

test("a size objective chooses the smaller candidate without a benchmark", () => {
  const outcomes = [
    outcome("c1", { textSizeBytes: 900 }),
    outcome("c2", { textSizeBytes: 100 }),
    outcome("c3", { textSizeBytes: 500 }),
  ];
  assert.equal(selectCandidate(outcomes, contract("size")), "c2");
});

test("the fastest timed candidate wins", () => {
  const outcomes = [
    outcome("c1", { benchmark: { durationNs: 900 } } as CandidateOutcome),
    outcome("c2", { benchmark: { durationNs: 100 } } as CandidateOutcome),
    outcome("c3", { benchmark: { durationNs: 500 } } as CandidateOutcome),
  ];
  assert.equal(selectCandidate(outcomes, contract("throughput")), "c2");
});

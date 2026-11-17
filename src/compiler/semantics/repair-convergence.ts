/**
 * Convergence-driven program repair.
 *
 * A build used to regenerate a program a fixed number of times. The number was
 * a guess about how many mistakes a program could be away from agreeing, and a
 * program that needed one more round was reported as irreparable even though
 * nothing about it had been proved.
 *
 * Repair is now driven by the state of the program. A round is either verified,
 * moves to a program state not seen before, or stops: a repeated state is a
 * fixed point (the immediately previous one) or a cycle (an earlier one), and
 * neither is progress. The round limit is a resource budget, not a correctness
 * criterion. Exhausting it reports `incomplete`, never a verified success and
 * never a claim that the program cannot be repaired.
 *
 * The tracker is pure: it reads fingerprints handed to it and never touches
 * the program, so its decisions can be tested without running a model.
 */

import { hashText } from "../core/json-store.ts";
import type { RepairBudget } from "../core/types.ts";

/** The observable state a repair round produced. */
export interface RepairState {
  /** The selected implementation of every unit, keyed by the unit's name. */
  readonly implementations: Readonly<Record<string, string>>;
  /** A signature of the first disagreement, when the program did not agree. */
  readonly mismatch?: string;
}

/** Canonical fingerprint of a program state, independent of key insertion order. */
export function stateFingerprint(state: RepairState): string {
  const names = Object.keys(state.implementations).sort();
  const parts = names.map((name) => `${name}=${state.implementations[name]}`);
  return hashText(JSON.stringify({ parts, mismatch: state.mismatch ?? null }));
}

/** What a round says should happen next. */
export type RepairDecision =
  | { readonly status: "continue" }
  | { readonly status: "converged"; readonly reason: string }
  | { readonly status: "incomplete"; readonly reason: string };

/**
 * Tracks the states a repair has visited and decides whether another round is
 * justified. `observe` is called once per round with that round's resulting
 * state and whether the program verified.
 */
export class RepairConvergence {
  private readonly visited = new Map<string, number>();
  private last: string | undefined;
  readonly budget: RepairBudget;

  constructor(budget: RepairBudget) {
    this.budget = budget;
  }

  /** The round that will be observed next, 1-based. */
  get nextRound(): number {
    return this.visited.size + 1;
  }

  /** Records the result of one round and decides the next step. */
  observe(state: RepairState, verified: boolean): RepairDecision {
    if (verified) return { status: "converged", reason: "the program matches its source" };
    const fingerprint = String(stateFingerprint(state));
    if (fingerprint === String(this.last)) {
      return { status: "incomplete", reason: "repair reached a fixed point without verifying" };
    }
    if (this.visited.has(fingerprint)) {
      return { status: "incomplete", reason: "repair returned to a program state it had already visited" };
    }
    this.visited.set(fingerprint, this.nextRound);
    this.last = fingerprint;
    if (this.visited.size >= Math.max(1, this.budget.maxRounds)) {
      return { status: "incomplete", reason: `the repair budget of ${this.budget.maxRounds} round(s) was exhausted` };
    }
    return { status: "continue" };
  }
}

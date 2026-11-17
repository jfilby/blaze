/**
 * The one cost model the optimizer and the validator read.
 *
 * Every number here is a *profitability* weight, not a correctness threshold.
 * A pass may use one to decide which of several equivalent rewrites to apply;
 * it may never use one to decide whether a rewrite preserves the program's
 * meaning. Safety is proved from semantic properties (effects, writes,
 * evaluation order) in `restructure.ts` and `parallel.ts`, independently of
 * these numbers.
 *
 * Keeping the model in one place is what makes an optimizer and a validator
 * agree: both read the same weights, and a call whose callee is not in the
 * callee map resolves to an explicit `unknown` rather than being quietly
 * charged the price of a bare call.
 */

import type { Assessment } from "../core/outcome.ts";
import type { SemanticFunction } from "../core/semantic-ir.ts";

export interface CostModel {
  /** The frame, argument moves, return and spills one call costs. */
  readonly call: number;
  /** One computed value, on any backend. */
  readonly operation: number;
  /** A statement that reaches memory, which a register-only body does not. */
  readonly memoryWrite: number;
  /** A branch whose arm is not known until run time. */
  readonly branch: number;
  /**
   * The weight of one turn of a loop whose count cannot be read. This is a
   * profitability weight only: an unknown loop is never assumed to run a
   * particular number of times when proving a rewrite safe.
   */
  readonly unknownLoopTurn: number;
}

/** The weights a build uses unless it supplies its own. */
export const DEFAULT_COST_MODEL: CostModel = {
  call: 12,
  operation: 1,
  memoryWrite: 4,
  branch: 2,
  unknownLoopTurn: 1,
};

/**
 * The intrinsic cost of one call, resolved through the callee map.
 *
 * A callee the map holds is charged the one call that reaches it; the body
 * behind it is priced by the caller's own walk, which knows how to read loops
 * and branches. A callee the map does not hold is `unknown`: there is no
 * information from which to price its body, and charging the bare call would
 * silently understate the work. A builtin is the compiler's own and is always
 * known at its intrinsic cost.
 */
export function resolveCallCost(
  name: string,
  callees: ReadonlyMap<string, SemanticFunction>,
  model: CostModel = DEFAULT_COST_MODEL,
  builtin: boolean = false,
): Assessment<number> {
  if (builtin) return { status: "known", value: model.call };
  if (!callees.has(name)) {
    return { status: "unknown", reason: `the body of ${name} is not held by this build` };
  }
  return { status: "known", value: model.call };
}

/**
 * One semantic context for a pass pair.
 *
 * The optimizer and the validator answer questions about the same program. They
 * used to be handed the information they needed separately, so one could be
 * given a callee map the other lacked and arrive at a contradictory verdict
 * without anything in the program changing. A `SemanticContext` is the one
 * value that carries both the callee bodies and the cost model: a caller hands
 * the same context to both passes, and they cannot disagree about what a call
 * costs because they cannot be given different information.
 */

import type { SemanticFunction } from "../core/semantic-ir.ts";
import { DEFAULT_COST_MODEL, type CostModel } from "./cost-model.ts";

export interface SemanticContext {
  /** Every function body the pass is allowed to read. */
  readonly callees: ReadonlyMap<string, SemanticFunction>;
  /** The one cost model both passes price operations, calls and loops with. */
  readonly cost: CostModel;
}

/** A context over the given bodies and cost model. */
export function semanticContext(
  callees: ReadonlyMap<string, SemanticFunction> = new Map(),
  cost: CostModel = DEFAULT_COST_MODEL,
): SemanticContext {
  return { callees, cost };
}

/**
 * Accepts the context or a bare callee map, so existing callers that pass a map
 * keep working. A map is read with the default model, which is the same model
 * another caller of the same program gets when it passes a context built from
 * that map.
 */
export function contextOf(value: SemanticContext | ReadonlyMap<string, SemanticFunction> | undefined): SemanticContext {
  if (value === undefined) return semanticContext();
  const candidate = value as unknown as Record<string, unknown>;
  if (typeof candidate["get"] === "function") return semanticContext(value as ReadonlyMap<string, SemanticFunction>);
  return value as SemanticContext;
}

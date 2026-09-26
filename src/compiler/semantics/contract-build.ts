/**
 * Shared contract assembly.
 *
 * Both frontends answer the same two questions once they have analysed a
 * function body: what does the result equal, and which parts of which buffers
 * does it read? Turning that into requires, memory ranges and a contract is
 * language independent, so it lives here rather than in either frontend.
 */

import { isBufferType, normalizeNumeric, normalizeOptimize, typeToString } from "./contract.ts";
import { assertBuildableTarget, normalizeTarget } from "../core/target.ts";
import type { FunctionContract, FunctionParam, SourceInput, TypeExpr } from "../core/types.ts";

/** A half open range `[lo, hi)` of buffer elements the function reads. */
export interface AccessRange {
  parameter: string;
  lo: string;
  hi: string;
}

export interface ContractAssembly {
  /** Name of the function in the source language. */
  name: string;
  params: { name: string; type: TypeExpr }[];
  returns: TypeExpr;
  /** The expression the result must equal, on the right of `result ==`. */
  result: string;
  /** Every buffer range the body reads, in the order it reads them. */
  accesses: AccessRange[];
  input: SourceInput;
}

/** A bound that says nothing, such as `len(a) >= len(a)`, is not a precondition. */
function isTautology(bound: string, parameter: string): boolean {
  return bound === `len(${parameter})`;
}

export function assembleContract(assembly: ContractAssembly): FunctionContract {
  const { name, params, returns, accesses, input } = assembly;

  const parameters: FunctionParam[] = params.map((param) => ({ name: param.name, type: typeToString(param.type) }));
  const target = normalizeTarget(input.target);
  assertBuildableTarget(target, name);

  const reads: string[] = [];
  const seenRanges = new Set<string>();
  for (const access of accesses) {
    const range = `${access.parameter}[${access.lo}:${access.hi}]`;
    if (seenRanges.has(range)) continue;
    seenRanges.add(range);
    reads.push(range);
  }

  const requires: string[] = [];
  for (const param of params) {
    if (!isBufferType(param.type)) continue;
    const touched = accesses.filter((access) => access.parameter === param.name);
    if (touched.length === 0) continue;
    if (param.type.kind === "ptr" || param.type.kind === "slice") {
      requires.push(`${param.name} != null`);
    }
    for (const access of touched) {
      if (isTautology(access.hi, param.name)) continue;
      requires.push(`len(${param.name}) >= ${access.hi}`);
    }
  }

  return {
    version: "1",
    function: { name, params: parameters, returns: typeToString(returns) },
    requires,
    ensures: [`result == ${assembly.result}`],
    memory: { reads, writes: [], aliasing: [] },
    effects: [],
    numeric: normalizeNumeric(input.numeric),
    target,
    optimize: normalizeOptimize(input.optimize),
  };
}

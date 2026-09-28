/**
 * Shared contract assembly.
 *
 * Both frontends answer the same three questions once they have analysed a
 * function body: what does the result equal, which parts of which buffers does
 * it read, and what does the body itself do. Turning those into requires,
 * memory ranges, effects and a contract is language independent, so it lives
 * here rather than in either frontend.
 *
 * The body and the postcondition are separate answers: the body is what the
 * function is, and it travels with every contract, while the postcondition is
 * carried only by a result one expression can state. A function that has one
 * has both.
 *
 * A contract names no target: what runs it is chosen by the build, beside the
 * contract, so one contract serves every backend.
 */

import { isBufferType, normalizeNumeric, normalizeOptimize, typeToString } from "./contract.ts";
import type { Effect, FunctionContract, FunctionDefinition, FunctionParam, SourceInput, TypeExpr } from "../core/types.ts";

/** A half open range `[lo, hi)` of buffer elements the function reads. */
export interface AccessRange {
  parameter: string;
  lo: string;
  hi: string;
}

/**
 * What a frontend has worked out about one function, before it becomes a
 * contract. Both frontends answer this the same way, so the shape is shared.
 */
export interface ContractAssembly {
  /** Name of the function in the source language. */
  name: string;
  /** The name the object exports, when the host has taken the source name. */
  symbol?: string;
  params: { name: string; type: TypeExpr }[];
  returns: TypeExpr;
  /**
   * The expression the result must equal, on the right of `result ==`, or null
   * where the body is not one expression and so states no postcondition.
   */
  result: string | null;
  /** Every buffer range the body reads, in the order it reads them. */
  accesses: AccessRange[];
  /** The body, as the source wrote it. Every function has one. */
  definition: Omit<FunctionDefinition, "calls" | "objects">;
  input: SourceInput;
}

/** A bound that says nothing, such as `len(a) >= len(a)`, is not a precondition. */
function isTautology(bound: string, parameter: string): boolean {
  return bound === `len(${parameter})`;
}

/** What the buffer ranges of a body state about what a caller must provide. */
export interface BufferContract {
  requires: string[];
  reads: string[];
}

/**
 * The preconditions and the reads the ranges a body reads state. Every
 * frontend that says what a body reads says it this way, and every function's
 * reads are collected, whether or not one expression states what its result
 * must equal.
 */
export function bufferContract(
  params: readonly { name: string; type: TypeExpr }[],
  accesses: readonly AccessRange[],
): BufferContract {
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
  return { requires, reads };
}

/**
 * The contract of one function: the body it always carries, and the
 * postcondition it carries when one expression can state what it returns.
 */
export function assembleContract(assembly: ContractAssembly): FunctionContract {
  const { name, params, returns, accesses, input, definition } = assembly;
  const buffers = bufferContract(params, accesses);
  const parameters: FunctionParam[] = params.map((param) => ({ name: param.name, type: typeToString(param.type) }));
  const effects: Effect[] = [];
  if (definition.allocates) effects.push("memory");
  if (definition.prints) effects.push("io");
  if (definition.readsArgv) effects.push("syscall");

  return {
    version: "1",
    function: { name, symbol: assembly.symbol ?? name, params: parameters, returns: typeToString(returns) },
    requires: buffers.requires,
    ensures: assembly.result === null ? [] : [`result == ${assembly.result}`],
    memory: { reads: buffers.reads, writes: [], aliasing: [] },
    effects,
    numeric: normalizeNumeric(input.numeric),
    optimize: normalizeOptimize(input.optimize),
    // The calls are filled in by the whole-program pass in objects.ts, which
    // walks these same bodies knowing which names the program compiles.
    definition: { ...definition, objects: {}, calls: [] },
  };
}

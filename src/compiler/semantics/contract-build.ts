function fieldOf(value: unknown, key: string): any {
  return (value as Record<string, unknown>)[key];
}

function setFieldOn(value: unknown, key: string, next: unknown): void {
  (value as Record<string, unknown>)[key] = next;
}

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
    const range = `${access.parameter}[${fieldOf(access, "lo")}:${fieldOf(access, "hi")}]`;
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
      if (isTautology(fieldOf(access, "hi"), param.name)) continue;
      requires.push(`len(${param.name}) >= ${fieldOf(access, "hi")}`);
    }
  }
  return { requires, reads };
}

/**
 * The symbol a function is compiled under.
 *
 * `main` is the entry point of a C program, and a function of that name is
 * written under another one: the program and the function would be two
 * definitions of the same symbol, and the link would fail on a name the
 * source chose. A Python program is written with a `main` of its own more
 * often than not, and it is the entry point of the program that carries the
 * name.
 */
export function symbolFor(name: string): string {
  return name === "main" ? "blaze_main" : name;
}

/**
 * The contract of one function: the body it always carries, and the
 * postcondition it carries when one expression can state what it returns.
 */
export function assembleContract(assembly: ContractAssembly): FunctionContract {
  const name = String(fieldOf(assembly, "name"));
  const params = fieldOf(assembly, "params") as readonly { name: string; type: TypeExpr }[];
  const returns = fieldOf(assembly, "returns") as TypeExpr;
  const accesses = fieldOf(assembly, "accesses") as readonly AccessRange[];
  const input = fieldOf(assembly, "input");
  const definition = fieldOf(assembly, "definition");
  const declaredSymbol = fieldOf(assembly, "symbol");
  const buffers = bufferContract(params, accesses);
  const parameters: FunctionParam[] = [];
  for (const param of params) parameters[parameters.length] = { name: String(fieldOf(param, "name")), type: typeToString(fieldOf(param, "type")) };
  const effects: Effect[] = [];
  if (fieldOf(definition, "allocates")) effects.push("memory");
  if (fieldOf(definition, "prints")) effects.push("io");
  if (fieldOf(definition, "readsArgv")) effects.push("syscall");
  const statedResult = fieldOf(assembly, "result");
  const body = structuredClone(definition) as unknown as Record<string, unknown>;
  setFieldOn(body, "objects", {});
  setFieldOn(body, "calls", []);

  return {
    version: "1",
    function: { name, symbol: declaredSymbol === undefined || declaredSymbol === null ? symbolFor(name) : String(declaredSymbol), params: parameters, returns: typeToString(returns) },
    requires: buffers.requires,
    ensures: statedResult === null || (returns.kind !== "primitive" && returns.kind !== "text") ? [] : [`result == ${String(statedResult)}`],
    memory: { reads: buffers.reads, writes: [], aliasing: [] },
    effects,
    numeric: normalizeNumeric(fieldOf(input, "numeric")),
    optimize: normalizeOptimize(fieldOf(input, "optimize")),
    // The calls are filled in by the whole-program pass in objects.ts, which
    // walks these same bodies knowing which names the program compiles.
    definition: body as unknown as FunctionDefinition,
  };
}

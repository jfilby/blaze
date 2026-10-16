/**
 * Powers-of-two arrays: buffers a program fills with `1, 2, 4, 8, ...` and then
 * only ever reads by index. Dividing by one of their elements is division by a
 * power of two, which a shift answers exactly instead of the divide
 * instruction, so the divide and its rounding can be dropped.
 *
 * The analysis is whole-program: it works out which arrays hold powers of two,
 * then propagates that fact through the call graph so that a function
 * receiving such an array as a parameter knows it.
 */

import { statementBlocksOf, statementValues } from "../core/semantic-ir.ts";
import { walkSemanticValue } from "./optimize-ir.ts";
import type { SemanticBlock, SemanticFunction, SemanticValue } from "../core/semantic-ir.ts";

/** The result: for each function name, the parameter indices that hold powers of two. */
export interface PowerOfTwoParams {
  readonly params: Map<string, Set<number>>;
}

/** Every call a body makes, nested blocks included. */
function callsIn(body: SemanticBlock): { callee: string; args: SemanticValue[] }[] {
  const found: { callee: string; args: SemanticValue[] }[] = [];
  const walk = (block: SemanticBlock): void => {
    for (const statement of block.statements) {
      for (const value of statementValues(statement)) walkSemanticValue(value, (one) => {
        if (one.k === "call") found.push({ callee: one.call.callee, args: one.call.args });
      });
      for (const nested of statementBlocksOf(statement)) walk(nested);
    }
    if (block.terminator.k === "return" && block.terminator.value !== null) {
      walkSemanticValue(block.terminator.value, (one) => {
        if (one.k === "call") found.push({ callee: one.call.callee, args: one.call.args });
      });
    }
  };
  walk(body);
  return found;
}

/**
 * Whether one function body is the `setPowers` pattern: a single loop that
 * writes `arr[i] = value; value = value * 2` starting from `value = 1`, so
 * after it runs `arr[i] === 2 ** i`. The array it fills is named.
 */
function powerOfTwoFiller(fn: SemanticFunction): string | null {
  const entry = fn.entry;
  const statements = entry.statements;
  if (statements.length !== 2) return null;
  const init = statements[0];
  const loopStatement = statements[1];
  if (init.k !== "let" || init.slot.mutable !== true) return null;
  if (init.value.k !== "const" || Number(init.value.text) !== 1) return null;
  const valueName = init.slot.name;
  if (loopStatement.k !== "loop" || loopStatement.loop.kind !== "counted") return null;
  const loop = loopStatement.loop;
  if (loop.body.statements.length !== 2) return null;
  const [write, update] = loop.body.statements;
  if (write.k !== "setElement" || write.op !== "=") return null;
  if (typeof write.buffer !== "string") return null;
  if (write.index.k !== "local" || write.index.name !== loop.variable) return null;
  if (write.value.k !== "local" || write.value.name !== valueName) return null;
  if (update.k !== "set" || update.op !== "=" || update.name !== valueName) return null;
  if (update.value.k !== "arith" || update.value.op !== "mul") return null;
  if (update.value.left.k !== "local" || update.value.left.name !== valueName) return null;
  if (update.value.right.k !== "const" || Number(update.value.right.text) !== 2) return null;
  return write.buffer;
}

/**
 * Which arrays hold powers of two, for every function, propagated through the
 * call graph to a fixed point.
 *
 * `setPowers(arr)` marks `arr` as a power-of-two array in its caller. When a
 * caller passes a power-of-two array to a function at some parameter position,
 * that parameter is a power-of-two array inside the callee, and the name it is
 * bound to can in turn be passed on. Iterating to a fixed point handles chains
 * of such hand-offs. `entry` is the program's own block: calls out of it count
 * just like calls out of any other function.
 */
export function powerOfTwoParams(
  functions: ReadonlyMap<string, SemanticFunction>,
  entry: SemanticBlock | null,
): PowerOfTwoParams {
  // The functions that are power-of-two fillers, and the array they fill.
  const fillers = new Map<string, string>();
  for (const [name, fn] of functions) {
    const array = powerOfTwoFiller(fn);
    if (array !== null) fillers.set(name, array);
  }
  // The names each function (and the program's entry block) holds that are
  // known to be power-of-two arrays.
  const known = new Map<string, Set<string>>();
  const namesOf = (name: string): Set<string> => {
    const found = known.get(name);
    if (found === undefined) { const fresh = new Set<string>(); known.set(name, fresh); return fresh; }
    return found;
  };
  // Every place calls are made from: each function's body, and the entry block.
  const contexts: { readonly name: string; readonly block: SemanticBlock }[] = [];
  for (const [name, fn] of functions) contexts.push({ name, block: fn.entry });
  if (entry !== null) contexts.push({ name: "<entry>", block: entry });
  // A call `filler(arg)` where `filler` is a known filler marks `arg` as a
  // power-of-two array in the calling context.
  // A caller that passes a known power-of-two array at parameter position `p`
  // makes parameter `p` of the callee a power-of-two array.
  let changed = true;
  while (changed) {
    changed = false;
    for (const { name, block } of contexts) {
      const set = namesOf(name);
      for (const { callee, args } of callsIn(block)) {
        const fillerArray = fillers.get(callee);
        if (fillerArray !== undefined) {
          const argument = args[0];
          if (argument !== undefined && argument.k === "local" && !set.has(argument.name)) {
            set.add(argument.name);
            changed = true;
          }
        }
        const calleeFn = functions.get(callee);
        if (calleeFn === undefined) continue;
        const calleeKnown = namesOf(callee);
        calleeFn.params.forEach((param, position) => {
          if (param.kind !== "value") return;
          const argument = args[position];
          if (argument === undefined || argument.k !== "local") return;
          if (!set.has(argument.name)) return;
          const paramName = param.name;
          if (!calleeKnown.has(paramName)) {
            calleeKnown.add(paramName);
            changed = true;
          }
        });
      }
    }
  }
  const params = new Map<string, Set<number>>();
  for (const [name, fn] of functions) {
    const indices = new Set<number>();
    fn.params.forEach((param, position) => {
      if (param.kind === "value" && namesOf(name).has(param.name)) indices.add(position);
    });
    if (indices.size > 0) params.set(name, indices);
  }
  return { params };
}

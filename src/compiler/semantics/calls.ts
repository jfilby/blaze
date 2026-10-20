/**
 * Calls: what the program does at each call its source wrote.
 *
 * `resolveObjects` records the call graph, because it is the one pass that
 * already walks every body of the program and already knows which names the
 * program compiles. This pass decides, for the graph as a whole, which of
 * those calls the emitted code makes and which it writes out.
 *
 * The decision is per edge but it is a property of the whole graph, so it is
 * made here rather than in a backend and never asked of a candidate.
 *
 * A call is a call by default. The callee is compiled on its own, verified on
 * its own vectors, measured on its own and linked beside the caller, so every
 * caller gets the candidate that won rather than a copy of one. That is what
 * makes cross-calling worth encouraging, and a call is only given up where
 * keeping it costs more than the sharing is worth.
 *
 * It costs one thing. A candidate that references another symbol cannot be
 * linked on its own, so it is judged by the program and by nothing else: no
 * probe, no run of its own, and a fault in it attributed to the program rather
 * than to the function it is in (see codegen.ts). A function with a
 * postcondition never pays this, because that postcondition is checked against
 * vectors whatever the body does, so a body that calls anything is verified as
 * surely as one that does not. So what a call costs is the caller's own check,
 * and the only thing that gives it back is having nothing left to call.
 *
 * A call is therefore written out when three things hold. The callee must not
 * be verified on its own vectors, or writing it out replaces a body that was
 * proved with a copy only the program can see. It must be free of effects,
 * because what it returns is owned by the frame that made it and the caller
 * already has one. And it must not reach the caller back, because a body that
 * contains itself is not a body: that is what keeps a recursive callee a call
 * whatever else is true of it.
 */

import type { CallStrategy, FileContract, FunctionContract } from "../core/types.ts";

/** The functions of the program, by the name the source gave them. */
export type ContractsByName = Map<string, FunctionContract>;

/**
 * Whether a callee is verified on its own, which is what makes its body worth
 * calling rather than copying: a postcondition is checked against vectors, so
 * that body was proved, and a copy of it inside a caller is a second body
 * nothing has proved. A function with no postcondition has no vectors of its
 * own, so the program it is part of is the only thing that can check it.
 */
function isVerified(contract: FunctionContract): boolean {
  return contract.ensures.length > 0;
}

/**
 * The functions the checker runs with vectors of its own.
 *
 * A function with a postcondition is checked against vectors: the checker
 * builds inputs of the declared types and asks whether the function answers
 * what the contract says. A vector is not the program's buffer — it holds the
 * values the declared type allows — so a rewrite that reads the elements of a
 * buffer as whole numbers is not sound in such a function: the contract states
 * what the function answers for every input of the type, and the rewrite
 * answers another one.
 *
 * A body written out is a body of the candidate that carries it, and that
 * candidate is the one the vectors run against, so the bodies written out are
 * left alone as well.
 *
 * A function that calls another function of the program is judged by the program
 * and by nothing else, so what it reads is what the program wrote, and the
 * rewrite is sound in it.
 */
export function vectorChecked(contracts: ContractsByName): Set<string> {
  const checked = new Set<string>();
  for (const contract of contracts.values()) {
    if (!isVerified(contract)) continue;
    const calls = contract.definition.calls.some((edge) => edge.strategy === "call" && contracts.has(edge.callee));
    if (calls) continue;
    checked.add(contract.function.name);
    for (const body of writtenOut(contracts, contract)) checked.add(body.function.name);
  }
  return checked;
}

/**
 * Whether a body owns anything a caller's frame would have to take over. What
 * it allocates, prints or reads is what its own body does, so this is read from
 * the body rather than from the conditions beside it.
 */
function isEffectFree(contract: FunctionContract): boolean {
  const definition = contract.definition;
  return !definition.allocates && !definition.prints && !definition.readsArgv;
}

/**
 * The functions of the program, by name. A name belongs to one function: one
 * symbol belongs to one function, and a symbol is the name unless the source
 * declared `main`, which is refused as a duplicate of the entry (see
 * validateFunctionNames).
 */
export function contractsByName(files: readonly FileContract[]): ContractsByName {
  const contracts: ContractsByName = new Map();
  for (const file of files) {
    for (const [name, contract] of Object.entries(file.functions)) contracts.set(name, contract);
  }
  return contracts;
}

/**
 * Whether writing out the call from `caller` to `callee` ends: that neither
 * of them, nor anything they reach, comes back to either. A function that
 * recurses is what decides this, and it is why the answer is about the whole
 * graph rather than about the one edge.
 *
 * Reaching `callee` again is a body that contains itself, which is not a body
 * a candidate can write: the recursion would have to become a call, and the
 * only symbol it could name is one this candidate is not allowed to reference.
 * Reaching `caller` is the same thing one level out, through mutual recursion.
 */
function terminates(contracts: ContractsByName, caller: string, callee: string): boolean {
  const seen = new Set<string>();
  const stack = (contracts.get(callee)?.definition.calls ?? []).map((edge) => edge.callee);
  while (stack.length > 0) {
    const name = stack.pop() as string;
    if (name === callee || name === caller) return false;
    if (seen.has(name)) continue;
    seen.add(name);
    for (const edge of contracts.get(name)?.definition.calls ?? []) stack.push(edge.callee);
  }
  return true;
}

/**
 * What one call becomes. A call stays a call unless all three of the rules
 * above hold, so the exception is the narrow one: an unverified, effect-free,
 * non-recursive callee is written out, and everything else is called.
 */
export function strategyFor(contracts: ContractsByName, caller: string, callee: string): CallStrategy {
  const target = contracts.get(callee);
  if (target === undefined) return "call";
  if (isVerified(target)) return "call";
  if (!isEffectFree(target)) return "call";
  return terminates(contracts, caller, callee) ? "inline" : "call";
}

/**
 * Decides every call of the program and writes the decision into the contract
 * that made it. Runs immediately after `resolveObjects`, which records the
 * graph it decides.
 */
export function resolveCalls(files: readonly FileContract[]): void {
  const contracts = contractsByName(files);
  for (const contract of contracts.values()) {
    for (const edge of contract.definition.calls) {
      edge.strategy = strategyFor(contracts, contract.function.name, edge.callee);
    }
  }
}

/**
 * Every function a candidate for `contract` has to be able to implement on its
 * own: itself, and everything it reaches through calls it is told to write
 * out. These are the bodies whose needs its prompt has to carry, because a
 * called function brings its own object and its own needs with it and a
 * written-out one does not.
 */
export function writtenOut(contracts: ContractsByName, contract: FunctionContract): FunctionContract[] {
  const bodies = new Map<string, FunctionContract>();
  const stack = [contract];
  while (stack.length > 0) {
    const current = stack.pop() as FunctionContract;
    const name = current.function.name;
    if (bodies.has(name)) continue;
    bodies.set(name, current);
    for (const edge of current.definition.calls) {
      // The edges that are written out form a forest, because `strategyFor`
      // refuses the one whose callee reaches its caller back, so this ends.
      if (edge.strategy !== "inline") continue;
      const reached = contracts.get(edge.callee);
      if (reached !== undefined) stack.push(reached);
    }
  }
  return [...bodies.values()];
}

/**
 * Every function a revision of `contract` may name in a call.
 *
 * A call stays a call unless the outline writes the callee out, and a revision
 * is free to take either road: the outline says which road is the better bet,
 * and the rewrite that takes it is a rule the compiler applies and can refuse.
 * So every callee of every body the outline may write out is a symbol this
 * function may reference, along with what those bodies call in turn: a body
 * written out lands inside this object, so a call written inside it is a call
 * this function makes.
 */
export function callableFrom(contracts: ContractsByName, contract: FunctionContract): FunctionContract[] {
  const reached = new Map<string, FunctionContract>();
  for (const body of writtenOut(contracts, contract)) {
    for (const edge of body.definition.calls) {
      const callee = contracts.get(edge.callee);
      if (callee !== undefined) reached.set(callee.function.name, callee);
    }
  }
  return [...reached.values()];
}

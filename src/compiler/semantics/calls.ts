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
 * postcondition never pays this, because a body that calls anything is
 * contracted as a definition instead, so every caller is a definition and has
 * no vectors to lose. So what a call costs is the caller's own check, and the
 * only thing that gives it back is having nothing left to call.
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
 * Whether a callee is verified on its own, which is what makes its body worth
 * calling rather than copying: a postcondition is checked against vectors, so
 * that body was proved, and a copy of it inside a caller is a second body
 * nothing has proved. It is also the common case — anything the source wrote as
 * one expression is contracted this way — which is why a call is the default.
 */
function isVerified(contract: FunctionContract): boolean {
  return contract.definition === undefined;
}

/** Whether a body owns anything a caller's frame would have to take over. */
function isEffectFree(contract: FunctionContract): boolean {
  const definition = contract.definition;
  // A verified function is straight-line and pure by construction: the
  // frontend refuses to state a result over an allocation, a print or a
  // command line read, so there is nothing in it that owns memory.
  if (definition === undefined) return true;
  return !definition.allocates && !definition.prints && !definition.readsArgv;
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
  const stack = (contracts.get(callee)?.definition?.calls ?? []).map((edge) => edge.callee);
  while (stack.length > 0) {
    const name = stack.pop() as string;
    if (name === callee || name === caller) return false;
    if (seen.has(name)) continue;
    seen.add(name);
    for (const edge of contracts.get(name)?.definition?.calls ?? []) stack.push(edge.callee);
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
    const definition = contract.definition;
    if (definition === undefined) continue;
    for (const edge of definition.calls) {
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
    for (const edge of current.definition?.calls ?? []) {
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
 * Every function a candidate for `contract` reaches by a call, following the
 * bodies it is told to write out. A body written out lands inside this
 * candidate's object, so a call written in it is a call this candidate makes:
 * its symbol has to be one the candidate may reference, and the prompt has to
 * say how it is called under. A candidate that is only shown its own edges
 * therefore cannot write out a body that calls anything, and the assembler
 * turns away the candidate that got it right.
 */
export function calledOut(contracts: ContractsByName, contract: FunctionContract): FunctionContract[] {
  const reached = new Map<string, FunctionContract>();
  for (const body of writtenOut(contracts, contract)) {
    for (const edge of body.definition?.calls ?? []) {
      // A body written out is part of this object, so the calls its own
      // contract records are this candidate's to make. The written-out bodies
      // are already the whole closure, so an edge marked for writing out is a
      // body above rather than a symbol.
      if (edge.strategy !== "call") continue;
      const callee = contracts.get(edge.callee);
      if (callee !== undefined) reached.set(callee.function.name, callee);
    }
  }
  return [...reached.values()];
}

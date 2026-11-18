function fieldOf(value: unknown, key: string): any {
  return (value as Record<string, unknown>)[key];
}

function setFieldOn(value: unknown, key: string, next: unknown): void {
  (value as Record<string, unknown>)[key] = next;
}

/**
 * Cost-guided restructuring of hot functions.
 *
 * The rewrites in `optimize-ir.ts` are local: they fold what is written out,
 * hoist what a loop reads every turn, and unroll a loop of a few turns. None
 * of them crosses a call boundary, and a call is the one thing a source-level
 * rewrite cannot see through. This is the half that does, and it is asked the
 * question the rest of the pass is not: not "is this the same program" but
 * "is the program that comes out cheaper to run".
 *
 * ## What inlining actually saves
 *
 * Writing a callee's body where its call was does not make the body cheaper —
 * it runs the same statements either way. What it removes is the call itself:
 * the argument moves, the frame is set up and torn down, and the callee-saved
 * registers the call forces the caller to spill. So the saving of a fusion is
 * one call, and the price of one is whatever body was copied in. A callee
 * whose body is a thousand statements costs a thousand statements of code to
 * remove a call worth one, which is code growth, not a speedup, and the
 * register allocator is worse off for it because the caller's frame now holds
 * the callee's live names beside its own.
 *
 * The estimate below therefore weighs a call against a straight-line body,
 * weighs a loop's turns into its body, and weighs a call made inside a callee
 * as the call plus the callee behind it. That is a heuristic and not a
 * measurement: it is the estimate a build makes when it has nothing better,
 * and it is deliberately biased against fusion, because a fusion that turns
 * out wrong costs code and a fusion refused costs one call.
 *
 * ## What decides it
 *
 * A fusion is taken when all of these hold, and each is a separate reason to
 * refuse it:
 *
 * - The program already writes the callee out (`strategy: "inline"`), so this
 *   is a shape the outline chose and not one invented here.
 * - The callee is called from exactly one site. Fusing a callee called from
 *   several places copies its body into each.
 * - The site is hot: it sits inside a loop that turns more than once, or a
 *   profile says the caller ran often enough for the call to be worth having.
 * - The callee is not recursive, directly or through the caller. A body that
 *   reaches itself is not a body the IR can hold once written into another.
 * - Every call the fused body makes is one the caller is already allowed to
 *   name, so the artifact the reader gets back is one it can read.
 * - The callee's body is small, in statements and in estimated cost.
 *
 * ## What it does to the IR
 *
 * `inlineCall` does the splice and renames the callee's names and blocks. The
 * call edges are this module's to update: the edge to the fused callee goes
 * away with the call, and the calls the callee's body made are declared on the
 * caller, because the caller now makes them.
 */

import type { SemanticBlock, SemanticFunction, SemanticLoop, SemanticStatement, SemanticValue } from "../core/semantic-ir.ts";
import type { CallEdge } from "../core/types.ts";
import { statementBlocksOf, statementValues, walkValues } from "../core/semantic-ir.ts";
import { inlineCall, inlineRefusal, isSafeToCompute, substituteLocals } from "./repair.ts";
import { DEFAULT_COST_MODEL, resolveCallCost, type CostModel } from "./cost-model.ts";

/* -------------------------------------------------------------------------- */
/* The estimate                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The cost of one turn of a loop, as a structural fact rather than an assumed
 * number. A counted loop whose ends are written out has an exact count; a loop
 * whose count cannot be read is simply unknown, and is never taken to run any
 * particular number of times. Both are profitability inputs only: neither can
 * decide whether a rewrite is safe.
 */
type LoopActivity =
  | { readonly kind: "counted"; readonly turns: number }
  | { readonly kind: "unknown" };

/**
 * How often a call site runs in one run of its caller. Only a counted loop with
 * readable ends contributes a number; a call inside any loop whose count is
 * not known is `repeated`, which is hot by structure and carries no assumed
 * count.
 */
export type CallFrequency =
  | { readonly kind: "once" }
  | { readonly kind: "counted"; readonly turns: number }
  | { readonly kind: "repeated" };

/** What a function costs to run, and how much of it is code. */
interface Estimate {
  /** The estimated cost of one run of the whole function. */
  readonly cost: number;
  /** How many statements the body holds, which is what fusion grows. */
  readonly statements: number;
}

/** What one statement costs, and everything under it. */
function statementCost(
  statement: SemanticStatement,
  callees: ReadonlyMap<string, SemanticFunction>,
  seen: Set<string>,
  model: CostModel,
): Estimate {
  const costs = valuesOf(statement, callees, seen, model);
  switch (statement.k) {
    case "call":
      // A call kept for what it does is the call plus the body behind it.
      return { cost: model.call + costs.cost, statements: 1 + costs.statements };
    case "loop": {
      // A countable loop runs its written number of turns; an unknown one is
      // given the profitability weight, never an assumed turn count.
      const activity = activityOf(fieldOf(statement, "loop"));
      const turns = activity.kind === "counted" ? activity.turns : model.unknownLoopTurn;
      return { cost: turns * costs.cost, statements: 1 + costs.statements };
    }
    case "setElement":
    case "fill":
    case "storeField":
      // A write that reaches memory, which a register-only body does not.
      return { cost: model.memoryWrite + costs.cost, statements: 1 + costs.statements };
    case "if":
      // One arm or the other, so the body is not run twice: what it costs is
      // what it costs to take the arm that is taken, and nothing knows which.
      return { cost: model.branch + costs.cost, statements: 1 + costs.statements };
    case "block":
      return { cost: costs.cost, statements: 1 + costs.statements };
    default:
      return { cost: model.operation + costs.cost, statements: 1 + costs.statements };
  }
}

/** The cost of the values a statement computes, and of the calls inside them. */
function valuesOf(
  statement: SemanticStatement,
  callees: ReadonlyMap<string, SemanticFunction>,
  seen: Set<string>,
  model: CostModel,
): Estimate {
  let cost = 0;
  let statements = 0;
  for (const value of statementValues(statement)) {
    const one = valueCost(value, callees, seen, model);
    cost += one.cost;
    statements += one.statements;
  }
  return { cost, statements };
}

/** The cost of one value, which is its own node plus everything under it. */
function valueCost(
  value: SemanticValue,
  callees: ReadonlyMap<string, SemanticFunction>,
  seen: Set<string>,
  model: CostModel,
): Estimate {
  if (value.k === "call") {
    // A call written inside an argument is the call plus the callee behind it,
    // and the callee behind a call is only read once: a body that reaches
    // itself has already been refused, so the walk terminates.
    const call = fieldOf(value, "call");
    const builtin = fieldOf(call, "builtin") === true;
    const name = String(fieldOf(call, "callee"));
    const assessed = resolveCallCost(name, callees, model, builtin);
    const callee = builtin ? undefined : callees.get(name);
    if (assessed.status === "unknown" || callee === undefined || seen.has(callee.name)) {
      // An unresolved call is charged the intrinsic call cost for
      // *profitability* only. Its safety is decided by `fusionSafety`, never
      // by this number, so the fallback cannot decide correctness.
      return { cost: model.call, statements: 0 };
    }
    const inner = estimate(callee, callees, new Set([...seen, callee.name]), model);
    return { cost: model.call + inner.cost, statements: inner.statements };
  }
  let cost = model.operation;
  let statements = 1;
  for (const child of valueChildrenOf(value)) {
    const one = valueCost(child, callees, seen, model);
    cost += one.cost;
    statements += one.statements;
  }
  return { cost, statements };
}

/**
 * How many turns a loop is taken to run, when that can be read from the loop
 * itself. A counted loop whose ends are written out is counted exactly; every
 * other loop is unknown, and is never assumed to run any particular number of
 * times. This is a structural observation, not a profitability guess, and no
 * correctness decision reads the number.
 */
function activityOf(loop: SemanticLoop): LoopActivity {
  if (loop.kind !== "counted") return { kind: "unknown" };
  const from = constantOf(fieldOf(loop, "from"));
  const to = constantOf(fieldOf(loop, "to"));
  if (from === null || to === null) return { kind: "unknown" };
  const step = loop.step === null ? (loop.down ? -1 : 1) : constantOf(loop.step);
  if (step === null || step === 0) return { kind: "unknown" };
  if (loop.down ? step > 0 : step < 0) return { kind: "counted", turns: 0 };
  const span = Math.abs(to - from);
  const turns = fieldOf(loop, "inclusive") ? Math.floor(span / Math.abs(step)) + 1 : Math.ceil(span / Math.abs(step));
  if (!Number.isSafeInteger(turns)) return { kind: "unknown" };
  return { kind: "counted", turns };
}

/** The number a value is written as, or null when the compiler cannot read it. */
function constantOf(value: SemanticValue): number | null {
  if (value.k !== "const") return null;
  const read = Number(value.text);
  return Number.isSafeInteger(read) ? read : null;
}

/** Every value directly inside another, which is what a cost walk reads. */
function valueChildrenOf(value: SemanticValue): readonly SemanticValue[] {
  switch (value.k) {
    case "arith":
    case "compare": return [fieldOf(value, "left"), fieldOf(value, "right")];
    case "logical":
    case "coalesce": return [value.left, value.right];
    case "select": return [value.condition, value.then, value.otherwise];
    case "unary": return [fieldOf(value, "operand")];
    case "isNull": return [value.operand];
    case "toText": return [value.of];
    case "length": return [fieldOf(value, "of")];
    case "element": return [value.of, value.index];
    case "loadField": return [value.object];
    case "newObject": return value.fields.map((field) => field.value);
    default: return [];
  }
}

/** What a function costs to run, with what it calls read at its own cost. */
export function estimateFunction(
  fn: SemanticFunction,
  callees: ReadonlyMap<string, SemanticFunction>,
  model: CostModel = DEFAULT_COST_MODEL,
): Estimate {
  return estimate(fn, callees, new Set([fn.name]), model);
}

/** The estimate of one function, over a walk that has already read a set of names. */
function estimate(
  fn: SemanticFunction,
  callees: ReadonlyMap<string, SemanticFunction>,
  seen: Set<string>,
  model: CostModel,
): Estimate {
  let cost = 0;
  let statements = 0;
  for (const block of blocksOf(fn.entry)) {
    for (const statement of fieldOf(block, "statements")) {
      const one = statementCost(statement, callees, seen, model);
      cost += one.cost;
      statements += one.statements;
    }
    const terminator = fieldOf(block, "terminator");
    if (terminator.k === "return" && terminator.value !== null) {
      cost += valueCost(terminator.value, callees, seen, model).cost;
    }
  }
  return { cost, statements };
}

/* -------------------------------------------------------------------------- */
/* Deciding                                                                    */
/* -------------------------------------------------------------------------- */

/** A profile of a function, which a build has only after it has run once. */
export interface FunctionProfile {
  /** How many times the function was called while profiling. */
  readonly callCount?: number;
  /** Wall-clock time the function took while profiling. */
  readonly durationNs?: number;
}

/** What one restructuring did or why it did nothing. */
export type RestructureOutcome =
  | {
      /** The function as it is after the rewrite. */
      readonly applied: SemanticFunction;
      /** One line saying what the rewrite did, for the build log. */
      readonly note: string;
    }
  | {
      /** The one reason this function was left as it was. */
      readonly refused: string;
    };

/** How much code growth a fusion may add, and how expensive a body may be. */
export interface RestructureOptions {
  /** The largest callee body that may be fused, in statements. */
  readonly maxCalleeStatements?: number;
  /** The largest caller body that may result, in statements. */
  readonly maxCallerStatements?: number;
  /** What a callee body may cost against the one call its fusion removes. */
  readonly maxCalleeCost?: number;
  /** A profile of the caller, when the build has one. */
  readonly profile?: FunctionProfile;
  /**
   * A call the outline never marked may be fused where the conditions the
   * outline answers hold: the callee is free of effects and reaches neither
   * itself nor the caller.
   *
   * A program's declared functions are bodies with no contracts beside them,
   * and nothing marked their calls: every edge stands as a call because
   * nothing decided otherwise. This is what lets the pass decide — the same
   * three conditions the outline weighs, and the cost guards below — so a hot
   * call in a body of the program is written out where a contracted one
   * marked for it would have been.
   */
  readonly decideUnmarked?: boolean;
  /** The cost model to price the fusion with, shared with the validator. */
  readonly costModel?: CostModel;
}

/** The default growth and cost a fusion is held to: profitability budgets only. */
const MAX_CALLEE_STATEMENTS = 16;
const MAX_CALLER_STATEMENTS = 96;
const MAX_CALLEE_COST = DEFAULT_COST_MODEL.call * 2;

/** One place a callee is called, and how often it runs. */
interface CallSite {
  readonly block: string;
  /** How often the call runs, without assuming a count for an unknown loop. */
  readonly frequency: CallFrequency;
}

/**
 * Combines the activity of a loop with the frequency of the block it contains.
 * A counted loop with a readable count multiplies a counted frequency; a loop
 * whose count is unknown makes the site `repeated`, which carries no number.
 */
function withinLoop(frequency: CallFrequency, activity: LoopActivity): CallFrequency {
  if (activity.kind === "unknown") return { kind: "repeated" };
  if (frequency.kind === "repeated") return frequency;
  const turns = (frequency.kind === "once" ? 1 : frequency.turns) * activity.turns;
  return turns === 1 ? { kind: "once" } : { kind: "counted", turns };
}

/** A fusion this pass may perform, with everything it needs to judge it. */
interface Fusion {
  readonly calleeName: string;
  readonly callee: SemanticFunction;
  readonly site: CallSite;
}

/** Every block of a body, the block itself included, at every depth. */
function blocksOf(block: SemanticBlock): SemanticBlock[] {
  const out: SemanticBlock[] = [];
  const walk = (one: SemanticBlock): void => {
    out.push(one);
    for (const statement of fieldOf(one, "statements")) {
      for (const nested of statementBlocksOf(statement)) walk(nested);
    }
  };
  walk(block);
  return out;
}

/** The number of statements a body holds, nested blocks included. */
function countStatements(block: SemanticBlock): number {
  return blocksOf(block).reduce((sum, one) => sum + fieldOf(one, "statements").length, 0);
}

/** Every call a body makes, in the order it first makes each. */
function directCallees(fn: SemanticFunction): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const visit = (value: SemanticValue): void => {
    walkValues(value, (one) => {
      // Read the call field only on a call node: a value walked from a loop
      // header or a `select` arm is not one, and has no call to name.
      if (one.k !== "call") return;
      // A builtin is the compiler's own rather than a function of the program,
      // so it is not a name the program's call graph states. Writing one into
      // the graph made a fused body declare `call Math.floor`, which the reader
      // of that body then refused: the contract it is read against names the
      // functions of the program and never the compiler's own.
      const call = fieldOf(one, "call");
      const callee = String(fieldOf(call, "callee"));
      if (fieldOf(call, "builtin") === true || fieldOf(call, "through") !== undefined || seen.has(callee)) return;
      seen.add(callee);
      names.push(callee);
    });
  };
  for (const block of blocksOf(fn.entry)) {
    for (const statement of fieldOf(block, "statements")) {
      for (const value of statementValues(statement)) visit(value);
    }
    const terminator = fieldOf(block, "terminator");
    if (terminator.k === "return" && terminator.value !== null) visit(terminator.value);
  }
  return names;
}

/**
 * The callee's every static call site, each with how often it runs.
 *
 * A site inside loops the compiler can count is weighted by the product of
 * their turns. A site inside any loop whose count cannot be read is `repeated`:
 * it runs on every turn, and no number of turns is assumed.
 */
function callSites(fn: SemanticFunction, callee: string): CallSite[] {
  const found: CallSite[] = [];
  const walk = (block: SemanticBlock, frequency: CallFrequency): void => {
    const here = (value: SemanticValue): void => {
      walkValues(value, (one) => {
        if (one.k === "call" && fieldOf(one, "call").callee === callee) found.push({ block: block.id, frequency });
      });
    };
    for (const statement of fieldOf(block, "statements")) {
      for (const value of statementValues(statement)) here(value);
    }
    const terminator = fieldOf(block, "terminator");
    if (terminator.k === "return" && terminator.value !== null) here(terminator.value);
    for (const statement of fieldOf(block, "statements")) {
      const activity = statement.k === "loop" ? activityOf(fieldOf(statement, "loop")) : { kind: "counted", turns: 1 } as const;
      for (const nested of statementBlocksOf(statement)) walk(nested, withinLoop(frequency, activity));
    }
  };
  walk(fn.entry, { kind: "once" });
  return found;
}

/** The callees a function may name because the program writes them out. */
function inlineReachable(fn: SemanticFunction, callees: ReadonlyMap<string, SemanticFunction>): Set<string> {
  const reached = new Set<string>();
  const queue = (fieldOf(fn, "calls") as readonly CallEdge[]).filter((edge) => edge.strategy === "inline").map((edge) => edge.callee);
  while (queue.length > 0) {
    const name = queue.pop() as string;
    if (reached.has(name)) continue;
    reached.add(name);
    const callee = callees.get(name);
    if (callee === undefined) continue;
    for (const edge of fieldOf(callee, "calls") as readonly CallEdge[]) {
      if (edge.strategy === "inline" && !reached.has(edge.callee)) queue.push(edge.callee);
    }
  }
  return reached;
}

/** Whether `start` can reach `target` through any of its calls. */
function reaches(start: SemanticFunction, callees: ReadonlyMap<string, SemanticFunction>, target: string): boolean {
  const seen = new Set<string>();
  const queue = (fieldOf(start, "calls") as readonly CallEdge[]).map((edge) => edge.callee);
  while (queue.length > 0) {
    const name = queue.pop() as string;
    if (name === target) return true;
    if (seen.has(name)) continue;
    seen.add(name);
    const callee = callees.get(name);
    if (callee === undefined) continue;
    for (const edge of fieldOf(callee, "calls")) queue.push(edge.callee);
  }
  return false;
}

/**
 * Whether a callee's own calls may be written into this caller.
 *
 * A call is legal in a fused body when the caller already names it, or when
 * the outline reaches it through calls the program writes out. A callee the
 * caller cannot name is one the reader refuses, so the fusion is refused
 * rather than written and read back as a fault.
 */
function innerCallsLegal(fn: SemanticFunction, callees: ReadonlyMap<string, SemanticFunction>, callee: SemanticFunction): boolean {
  const legal = new Set<string>((fieldOf(fn, "calls") as readonly CallEdge[]).map((edge) => String(edge.callee)));
  for (const name of inlineReachable(fn, callees)) legal.add(name);
  for (const name of directCallees(callee)) {
    if (name === fn.name || name === callee.name) return false;
    if (!legal.has(name)) return false;
  }
  return true;
}

/**
 * Whether a site is hot enough for the call it makes to be worth having.
 *
 * A call inside a loop is hot by structure: it runs on every turn, and no
 * assumed count is needed to say so. A call outside every loop runs once,
 * which is not worth a copy of anything — unless a profile says the caller is
 * called often enough that even one call per run is worth having removed. No
 * profile is the ordinary case, and the answer is then no. This is a
 * profitability decision only; it never decides whether a rewrite is safe.
 */
function isHot(site: CallSite, profile: FunctionProfile | undefined): boolean {
  if (site.frequency.kind === "repeated") return true;
  if (site.frequency.kind === "counted" && site.frequency.turns > 1) return true;
  if (profile === undefined) return false;
  return (profile.callCount ?? 0) > 1 || (fieldOf(profile, "durationNs") ?? 0) > 0;
}

/**
 * Whether a call may be fused into its caller, proved from semantic properties.
 *
 * This is the safety half of the decision, and it is independent of every
 * profitability weight. A fusion is permitted only when the callee is pure
 * (no effects, no allocation, no printing, no command-line reads), deterministic
 * (its return is a value the caller owns, not a reference it must release), its
 * body can be spliced without changing control flow or evaluation order, it
 * does not recurse into itself or its caller, and every call the spliced body
 * makes is one the caller is allowed to name. If any of that cannot be shown,
 * the call stays where it was.
 */
export type FusionSafety =
  | { readonly status: "safe" }
  | { readonly status: "unsafe"; readonly reason: string };

export function fusionSafety(
  caller: SemanticFunction,
  callee: SemanticFunction,
  callees: ReadonlyMap<string, SemanticFunction>,
): FusionSafety {
  if (callee.effects.length > 0) {
    return { status: "unsafe", reason: `${callee.name} has effects (${callee.effects.join(", ")})` };
  }
  if (callee.allocates || callee.prints || callee.readsArgv) {
    return { status: "unsafe", reason: `${callee.name} allocates, prints or reads the command line` };
  }
  // A reference or a text has an owner or a lifetime the caller does not gain
  // by splicing the body in place of the call.
  if (callee.returns.kind === "ref" || callee.returns.kind === "text") {
    return { status: "unsafe", reason: `${callee.name} returns a ${callee.returns.kind}, which the splice would not own` };
  }
  // `inlineRefusal` proves the body is one a splice can hold: one return, no
  // releases, no control flow the caller does not own. The callee's own calls
  // are blanked for this proof because the fused body deliberately leaves them
  // in place; their legality is checked separately below.
  const spliceable = structuredClone(callee);
  setFieldOn(spliceable, "calls", []);
  const refusal = inlineRefusal(spliceable);
  if (refusal !== null) return { status: "unsafe", reason: `${callee.name} cannot be spliced: ${refusal}` };
  if (reaches(callee, callees, callee.name)) return { status: "unsafe", reason: `${callee.name} reaches itself` };
  if (reaches(callee, callees, caller.name)) {
    return { status: "unsafe", reason: `${callee.name} reaches ${caller.name}, which is the function it would be written into` };
  }
  if (!innerCallsLegal(caller, callees, callee)) {
    return { status: "unsafe", reason: `${callee.name} calls something ${caller.name} may not name` };
  }
  return { status: "safe" };
}

/**
 * The one fusion worth doing in this function, or the reason there is none.
 *
 * Every refusal names what stopped it, because a build that cannot say why a
 * call was left in place cannot tell a hot function it should have restructured
 * from a hot function it judged and refused.
 */
function fusionOpportunity(
  fn: SemanticFunction,
  callees: ReadonlyMap<string, SemanticFunction>,
  options: RestructureOptions,
): Fusion | string {
  const maxCalleeStatements = options.maxCalleeStatements ?? MAX_CALLEE_STATEMENTS;
  const maxCallerStatements = options.maxCallerStatements ?? MAX_CALLER_STATEMENTS;
  const maxCalleeCost = options.maxCalleeCost ?? MAX_CALLEE_COST;
  const model = options.costModel ?? DEFAULT_COST_MODEL;
  for (const edge of fieldOf(fn, "calls")) {
    const callee = callees.get(edge.callee);
    // The program writes a callee out only when it is unverified, effect-free
    // and non-recursive; that is the shape this asks about, and it is a
    // decision the outline already made. A body of the program has no outline
    // to decide for it, so where the option says so, the pass decides: the
    // callee is free of effects and reaches neither itself nor the caller,
    // which is the shape the outline would have marked. A call this pass
    // decides about on its own is a call in a body whose shape nothing else
    // described, so the copy it may bring is weighed against the turns the
    // site runs rather than against the call alone.
    const decided = edge.strategy !== "inline" && options.decideUnmarked === true;
    const calleeStatements = decided ? maxCalleeStatements * 2 : maxCalleeStatements;
    const calleeCost = decided ? maxCalleeCost * 2 : maxCalleeCost;
    if (callee === undefined) continue;
    if (edge.strategy !== "inline") {
      if (decided !== true) continue;
      if (fieldOf(callee, "allocates") || fieldOf(callee, "prints") || fieldOf(callee, "readsArgv")) continue;
      if (callee.returns.kind === "ref" || callee.returns.kind === "text") continue;
    }
    if (reaches(callee, callees, callee.name)) return `${callee.name} reaches itself`;
    if (reaches(callee, callees, fn.name)) return `${callee.name} reaches ${fn.name}, which is the function it would be written into`;
    const sites = callSites(fn, edge.callee);
    if (sites.length === 0) continue;
    // Fusing a callee called from several places copies its body into each,
    // which is code growth without a call boundary to remove.
    if (sites.length !== 1) return `${callee.name} is called ${sites.length} times in ${fn.name}`;
    const site = sites[0] as CallSite;
    if (!isHot(site, options.profile)) {
      return `${callee.name} runs once in ${fn.name}, and nothing says that call is hot`;
    }
    if (!innerCallsLegal(fn, callees, callee)) {
      return `${callee.name} calls something ${fn.name} may not name, and writing it out would put that call here`;
    }
    // Safety is proved here, from the callee's semantic properties, before any
    // profitability weight is consulted. A call that cannot be proved safe is
    // left in place; no cost, turn count or budget can overrule that.
    const safety = fusionSafety(fn, callee, callees);
    if (safety.status === "unsafe") {
      if (decided) continue;
      return safety.reason;
    }
    const body = estimateFunction(callee, callees, model);
    if (fieldOf(body, "statements") > calleeStatements) {
      return `${callee.name} is ${fieldOf(body, "statements")} statements, and a fusion may copy at most ${calleeStatements}`;
    }
    // The one thing a fusion removes is the call. A body that costs more than
    // the call is worth is code the call was buying for nothing.
    if (body.cost > calleeCost) {
      return `${callee.name} costs ${body.cost}, and removing one call is worth ${DEFAULT_COST_MODEL.call}`;
    }
    if (countStatements(fn.entry) + fieldOf(body, "statements") > maxCallerStatements) {
      return `${fn.name} would grow past ${maxCallerStatements} statements`;
    }
    return { calleeName: edge.callee, callee, site };
  }
  return `${fn.name} calls nothing the program writes out`;
}

/* -------------------------------------------------------------------------- */
/* Applying                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Puts one callee's body where its single call was, and leaves the caller's
 * call graph saying what the fused body does.
 *
 * `inlineCall` does the splice and drops the edge to the callee. It is handed a
 * copy whose `calls` are empty, because the rule a review proposes is refused
 * for a callee that calls anything: that rule is written for a body that
 * leaves no call behind, and this one deliberately leaves one. The refusal is
 * `inlineRefusal`'s and not this pass's, so the copy leaves it applied to every
 * other ground — the callee must still free nothing, print nothing, return no
 * reference and end by returning — while the one rule it cannot meet is the one
 * this pass exists to answer.
 */
function fuse(fn: SemanticFunction, fusion: Fusion): SemanticFunction | string {
  const context = new Map<string, SemanticFunction>();
  const clone = structuredClone(fusion.callee);
  setFieldOn(clone, "calls", []);
  // A body whose early returns would return from the caller is not one a
  // splice can hold — unless the guard and the value it guards are one value
  // of their own. A body that is a guarded return over declarations and a
  // return is written as the select it means: the arms are chosen values, the
  // condition is asked once, and the splice lands whole.
  selectify(clone);
  context.set(fusion.calleeName, clone);
  const outcome = inlineCall(fn, fieldOf(fusion.site, "block"), fusion.calleeName, { functions: context });
  const applied = fieldOf(outcome, "applied") as SemanticFunction | undefined;
  if (applied === undefined) return String(fieldOf(outcome, "refused"));
  const edges = fieldOf(applied, "calls") as { callee: string; strategy: string }[];
  const declared = new Set(edges.map((edge) => String(fieldOf(edge, "callee"))));
  for (const name of directCallees(applied)) {
    if (!declared.has(name)) edges.push({ callee: name, strategy: "call" });
  }
  // A callee that allocates, prints or reads the command line was refused
  // above, so the caller inherits none of those. A layout the callee read is
  // still a layout the caller reads, and the caller must carry it.
  setFieldOn(applied, "objects", { ...fieldOf(applied, "objects"), ...fusion.callee.objects });
  return applied;
}

/**
 * Restructures one function when a fusion is worth doing.
 *
 * The function handed in is never modified: what comes back is a tree that
 * shares nothing with it, the way every other rewrite in this compiler hands
 * one back. A refusal carries the reason, which is what a build log prints and
 * what the next round reads.
 */
export function restructureHotFunction(
  fn: SemanticFunction,
  callees: ReadonlyMap<string, SemanticFunction>,
  options: RestructureOptions = {},
): RestructureOutcome {
  const fusion = fusionOpportunity(fn, callees, options);
  if (typeof fusion === "string") return { refused: fusion };
  const applied = fuse(fn, fusion);
  if (typeof applied === "string") return { refused: applied };
  const frequency = fusion.site.frequency;
  const howOften = frequency.kind === "counted"
    ? `${frequency.turns} times`
    : frequency.kind === "repeated"
      ? "on every turn of its loop"
      : "once";
  const note = `fused ${fusion.calleeName} into ${fieldOf(fusion.site, "block")} in ${fn.name}, which runs ${howOften}`;
  return { applied, note };
}

/* -------------------------------------------------------------------------- */
/* The body a splice can hold                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Writes a guarded return as the select it means, in place.
 *
 * A body that asks a question, answers it with a return from the arm and goes
 * on to a return of its own is the shape `a(i, j)` is written in — and the
 * shape a splice cannot hold, because an arm's return would return from the
 * function the body was put into. Written as a select it is the same program:
 * the condition is asked once, only the arm that answers is computed, and the
 * body ends in the one return the splice reads.
 *
 * The arm values and everything between the guard and the return have to be
 * computable where they stand and nothing more: a value that reads memory or
 * divides by a number nobody wrote out is left as it was, and so is a body
 * whose shape this is not. What is substituted is the declarations between the
 * guard and the return, in the order they were written, so a declaration a
 * later one reads is already a value when the return is read.
 */
function selectify(fn: SemanticFunction): void {
  const entry = fn.entry;
  // A body the program holds may be no function with an entry block: there is
  // nothing to turn into a select when there is no answer to guard.
  if (entry === undefined) return;
  const terminator = fieldOf(entry, "terminator");
  const answered0 = fieldOf(terminator, "value") as SemanticValue | null;
  if (terminator.k !== "return" || answered0 === null) return;
  const answer0 = answered0;
  if (answer0.k === "call" || !isSafeToCompute(answer0)) return;
  const statements = fieldOf(entry, "statements");
  let guard = -1;
  let at = 0;
  for (const statement of statements) {
    const otherwise = fieldOf(statement, "otherwise");
    const then = fieldOf(statement, "then");
    const thenEnd = fieldOf(then ?? {}, "terminator");
    if (
      statement.k === "if" &&
      otherwise === null &&
      String(fieldOf(thenEnd, "k")) === "return" &&
      fieldOf(thenEnd, "value") !== null
    ) {
      guard = at;
    }
    at += 1;
  }
  if (guard < 0) return;
  const choice = statements[guard] as Extract<SemanticStatement, { k: "if" }>;
  const answered = fieldOf(fieldOf(choice, "then"), "terminator") as { k: "return"; value: SemanticValue };
  if (fieldOf(answered, "value") === null || !isSafeToCompute(fieldOf(answered, "value"))) return;
  // Everything between the guard and the return is a declaration the return
  // reads, and the declarations stand in one scope of their own: what the
  // return reads of them is the value they were written with, which is what
  // the substitution puts in.
  const between = statements.slice(guard + 1);
  const bindings = new Map<string, SemanticValue>();
  for (const statement of between) {
    if (statement.k !== "let" || fieldOf(fieldOf(statement, "slot"), "mutable") === true) return;
    if (!isSafeToCompute(statement.value)) return;
    for (const value of statementValues(statement)) {
      walkValues(value, (inner) => {
        if (inner.k === "call") return;
      });
    }
    bindings.set(String(fieldOf(fieldOf(statement, "slot"), "name")), substituteLocals(structuredClone(statement.value), bindings));
  }
  const answer = substituteLocals(structuredClone(answer0), bindings);
  // The guard reads nothing the declarations bound — they are written after
  // it — and the arms are read once each, where the body read them once each.
  setFieldOn(entry, "statements", statements.slice(0, guard));
  setFieldOn(entry, "terminator", {
    k: "return",
    value: {
      k: "select",
      type: fieldOf(answer0, "type"),
      condition: structuredClone(fieldOf(choice, "condition")),
      then: fieldOf(answered, "value"),
      otherwise: answer,
    },
  });
}

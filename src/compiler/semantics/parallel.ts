/**
 * Which loops may have their turns run at the same time.
 *
 * A loop's turns run one after another in the source, so nothing in the source
 * says which of them could be run side by side. That question has an answer
 * and it is a property of what a turn *writes*: a turn may run at the same time
 * as another exactly when neither writes anything the other reads or writes.
 * A body that writes nothing outside itself is that answer, and nothing weaker
 * will do — a body that accumulates into a name it found, however obviously
 * the accumulation looks, has a turn that reads what the turn before it wrote.
 *
 * So the mark this file sets is a proof, not a guess, and it is set by the
 * compiler and not asked of a model. A model is asked to review an artifact and
 * propose a rewrite out of the catalogue in `repair.ts`; independence is not
 * something a proposal can carry, because a proposal that is wrong about it is
 * a program with a data race in it rather than a program that is a little
 * slower. `ir-validate.ts` asks this file about every loop the IR text claims
 * is parallel, so a mark that arrives from IR text written by hand or by a
 * model is proved rather than believed.
 *
 * What a mark is *not*: an instruction. It says the turns do not depend on each
 * other, so a backend is free to run them in order. The C backend runs them on
 * more than one thread, and a backend with no threads runs the same loop it
 * always did and is correct, which is why this is an IR flag rather than a
 * runtime call the IR cannot make.
 *
 * Allocating is not one of the things that refuses a turn. It used to be: the
 * runtime kept one heap with one free list, so two turns taking a block at once
 * were handed the same block. It keeps a pool of its own per thread now, so a
 * turn that builds values of its own and lets them go is admitted, which is
 * what admits out[i] = build(in[i]) — the shape nearly every loop worth marking
 * has, and one that allocates on every turn.
 *
 * Accumulating into a name the turn found is refused too, and a reduction is
 * the one answer to that which is still the same program: each turn keeps a
 * total of its own and the totals are combined once the loop is done. A sum of
 * whole numbers is the same number however it is grouped, so a loop that adds
 * whole numbers into an accumulator it found is marked and names the
 * accumulator; one that adds anything else is not, because a sum of doubles is
 * not the same number however it is grouped. A turn that leaves the loop with a
 * `break` is refused outright — OpenMP has no `break` in a parallel loop, and a
 * turn that leaves decides whether the next one runs.
 */

import { isWholeNumberText } from "./objects.ts";

function fieldOf(value: unknown, key: string): any {
  return (value as Record<string, unknown>)[key];
}

function setFieldOn(value: unknown, key: string, next: unknown): void {
  (value as Record<string, unknown>)[key] = next;
}
import {
  isInteger,
  isWhole,
  statementBlocksOf,
  statementValues,
  walkValues,
  type SemanticBlock,
  type SemanticCall,
  type SemanticFunction,
  type SemanticLoop,
  type SemanticSlot,
  type SemanticType,
  type SemanticStatement,
  type SemanticReduction,
  type SemanticValue,
} from "../core/semantic-ir.ts";
import type { PrimitiveTypeName } from "../core/types.ts";
import type { Assessment } from "../core/outcome.ts";
import { DEFAULT_COST_MODEL, type CostModel } from "./cost-model.ts";

/** Why a loop may not have its turns run at once, in terms of what its body does. */
export type Refusal = string;

/**
 * Every function a body may call, by contract name.
 *
 * A callee this map does not hold is a callee whose body nobody has read, and a
 * body nobody has read may print, count a reference or write anything — so a
 * call to one is refused. That is the safe reading of an absent entry, and it
 * is why the map is an argument rather than something looked up: a caller that
 * has the bodies says so, and a caller that has not gets the answer that
 * assumes the worst.
 */
export const NO_CALLEES: Callees = new Map();

export type Callees = ReadonlyMap<string, SemanticFunction>;

/** The names a build holds no callee for, so every call through it is refused. */

/**
 * A block and every block nested inside it, itself included.
 *
 * It is walked here rather than imported from `optimize-ir.ts` because that
 * module is what calls this one: the mark is set at the end of a round of
 * rewrites, and the module that sets it has no business importing the module it
 * is set from.
 */
function blocksWithin(block: SemanticBlock): SemanticBlock[] {
  const nested: SemanticBlock[] = [];
  for (const statement of fieldOf(block, "statements") as readonly SemanticStatement[]) {
    for (const one of statementBlocksOf(statement)) {
      for (const inner of blocksWithin(one)) nested[nested.length] = inner;
    }
  }
  const all: SemanticBlock[] = [block];
  for (const one of nested) all[all.length] = one;
  return all;
}

/* -------------------------------------------------------------------------- */
/* The pass                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Marks every loop of a body whose turns do not depend on each other.
 *
 * The mark is set on the loop and nowhere else: nothing about the body changes,
 * so a body that is marked is the body that was proved, and a loop a pass has
 * rewritten since is marked again the next time this runs rather than carrying a
 * verdict about a body that is no longer there.
 */
export function markParallelLoops(
  entry: SemanticBlock,
  callees: Callees = new Map(),
  model: CostModel = DEFAULT_COST_MODEL,
): void {
  for (const block of blocksWithin(entry)) {
    for (const statement of fieldOf(block, "statements") as readonly SemanticStatement[]) {
      if (statement.k !== "loop") continue;
      const loop = fieldOf(statement, "loop") as SemanticLoop;
      if (loop.kind !== "counted" && loop.kind !== "each") continue;
      if (fieldOf(loop, "parallel") === true) continue;
      if (refusalFor(loop, callees, model) !== null) continue;
      // The accumulators go on the loop beside the mark, because that is where
      // a backend reads what to combine: a mark with nothing to combine is a
      // loop whose turns share nothing, and one whose accumulators are named is
      // a loop whose turns share exactly those.
      const loopBody = fieldOf(loop, "body") as SemanticBlock;
      const combined: SemanticReduction[] = [];
      for (const one of reductionsFor(loopBody, loop.kind === "counted" ? String(fieldOf(loop, "variable")) : String(fieldOf(loop, "index"))).values()) combined[combined.length] = one;
      if (combined.length > 0) setFieldOn(loop, "reductions", combined);
      setFieldOn(loop, "parallel", true);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* The rule                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Why the turns of a loop may not run at the same time, or null when they may.
 *
 * Every clause here is a way one turn can reach another. A body that passes all
 * of them writes only what this turn declared for itself, the one element of an
 * array named by this turn's own counter, and whatever a callee it calls writes
 * — which is why the callees are an argument: what a call reaches is the
 * callee's own body, and only the program knows what that body is.
 */
export function refusalFor(
  loop: SemanticLoop,
  callees: Callees = new Map(),
  model: CostModel = DEFAULT_COST_MODEL,
): Refusal | null {
  if (loop.kind === "while") return "a while loop counts to a condition, so one turn decides whether the next runs";
  if (loop.kind === "doWhile") return "a do-while counts to a condition, so one turn decides whether the next runs";
  // The C backend asks for the turns of a parallel loop in the form OpenMP calls
  // canonical — an integer counter from a bound up to a bound, one step at a
  // time — because that is the only shape a pragma may be written against. A
  // loop the pragma cannot be written for is not marked rather than marked and
  // run in order, so what the IR says is what every backend does.
  if (loop.kind === "counted" && !canonicalCounted(loop)) {
    return "the counter is not a whole number counting up one at a time, which is the only shape a parallel loop takes";
  }
  const reach: Reach = { callees, model, reading: new Set(), verdicts: new Map(), wholes: new Map(), costs: new Map() };
  if (turnIsTooCheapIn(fieldOf(loop, "body") as SemanticBlock, reach)) {
    return "a turn of this loop computes so little that a team of threads costs more than the turns it runs";
  }
  // A turn that leaves the loop early is a turn that decides whether the next
  // one runs, which is the whole of what handing the turns to threads forbids:
  // OpenMP has no `break` in a parallel loop at all, so a loop whose body can
  // leave it is not one the pragma may be written against. A turn that skips to
  // the next one with `continue` is fine, and a `break` out of a loop inside this
  // one is that inner loop's own.
  if (leavesItself(loop)) {
    return "the body leaves the loop with a break, and a turn that leaves decides whether the next one runs";
  }
  if (returnsOutOfIt(loop)) {
    return "the body returns out of the function, and a turn that returns returns from the team";
  }
  const counter = loop.kind === "counted" ? String(fieldOf(loop, "variable")) : String(fieldOf(loop, "index"));
  // What the turns combine is worked out before the body is read, because it is
  // the one shared write the body is allowed and everything else about the body
  // is read against it: a write the loop combines is a write the turns do not
  // share, and a write it does not is refused as it was.
  const loopBody = fieldOf(loop, "body") as SemanticBlock;
  const combined = reductionsFor(loopBody, counter);
  return bodyRefusal(loopBody, counter, callees, reach, combined, []);
}

/**
 * Whether a turn of this loop can leave it, which is a block of its own body
 * ending in a jump to where the loop stops.
 *
 * The blocks of a loop nested inside this one are not read, because a `break`
 * there leaves that loop rather than this one — and that loop is read on its own
 * when the rule reaches it, so the one that may not be parallel is refused there.
 */
function leavesItself(loop: Extract<SemanticLoop, { kind: "counted" | "each" }>): boolean {
  const exit = String(fieldOf(loop, "exit"));
  const inside = (block: SemanticBlock): boolean => {
    for (const statement of fieldOf(block, "statements") as readonly SemanticStatement[]) {
      if (statement.k === "loop") continue;
      for (const nested of statementBlocksOf(statement)) {
        const nestedEnd = fieldOf(nested, "terminator") as SemanticBlock["terminator"];
        if (String(fieldOf(nestedEnd, "k")) === "jump" && String(fieldOf(nestedEnd, "target")) === exit) return true;
        if (inside(nested)) return true;
      }
    }
    const blockEnd = fieldOf(block, "terminator") as SemanticBlock["terminator"];
    return String(fieldOf(blockEnd, "k")) === "jump" && String(fieldOf(blockEnd, "target")) === exit;
  };
  return inside(fieldOf(loop, "body") as SemanticBlock);
}

/**
 * Whether a turn of this loop can return out of the function it is written in,
 * which is a turn that returns out of the team rather than out of the loop: the
 * other turns are still running, and the function is gone from under them.
 *
 * Unlike `leavesItself`, this reads the loops nested inside this one as well. A
 * `break` there leaves that loop, so the loop around it may still run its turns
 * at once — but a `return` leaves the function whichever loop it is written in,
 * so a loop anywhere above it has the same turn to lose.
 */
function returnsOutOfIt(loop: Extract<SemanticLoop, { kind: "counted" | "each" }>): boolean {
  return blocksWithin(fieldOf(loop, "body") as SemanticBlock).some((block) => String(fieldOf(fieldOf(block, "terminator"), "k")) === "return");
}

/**
 * The accumulators the turns of a loop combine, read off its body.
 *
 * A name the turn accumulates into with `+=` or `*=` and never assigns outright
 * is a reduction, and a name the turn assigns is not — a turn that decides what
 * the total is has made its answer depend on which turn ran last, which no
 * combining afterwards repairs.
 *
 * A name a turn also reads is not a reduction either. The combining is what
 * makes the accumulator private to the turn, so a read inside the body would
 * read the turn's own partial sum rather than the total the turns are building
 * towards: `total += input[i]; out[i] = total;` is the prefix sum, and the
 * element each turn writes is the total only up to that turn.
 *
 * Whether the combining is the same number in any order is decided per
 * accumulator, by whether every value a turn combines is a whole number. Whole
 * numbers are exact however they are grouped, so a sum or a product of them is
 * the turns' totals added in any order. A value that is not a whole number is a
 * double, and a sum of doubles is not the same number however it is grouped, so
 * that accumulator is refused rather than marked as one whose order does not
 * matter.
 */
export function reductionsFor(body: SemanticBlock, counter: string): Map<string, SemanticReduction> {
  const declared = new Set<string>();
  for (const block of blocksWithin(body)) {
    for (const statement of fieldOf(block, "statements") as readonly SemanticStatement[]) {
      if (statement.k === "let") declared.add(String(fieldOf(fieldOf(statement, "slot"), "name")));
    }
  }
  // What a turn reads, which is the other half of what a reduction has to be.
  // The turns of a parallel loop each keep a total of their own and the totals
  // are combined once the loop is done, so a name one turn writes and another
  // turn reads is a name whose value depends on which turn is running — and the
  // combining is the whole reason it does: the C backend writes
  // `#pragma omp parallel for reduction(+:total)`, which holds `total` private
  // to the thread for the length of the body, so a read of it inside the body
  // sees that thread's partial sum rather than the running total the program
  // means. Read anywhere in the body, an accumulator is refused rather than
  // marked: `total += input[i]; out[i] = total;` is the prefix sum, and no
  // reordering of it is the same array.
  const read = new Set<string>();
  for (const block of blocksWithin(body)) {
    for (const statement of fieldOf(block, "statements") as readonly SemanticStatement[]) {
      for (const value of statementValues(statement)) {
        walkValues(value, (inner) => {
          if (inner.k === "local") read.add(String(fieldOf(inner, "name")));
        });
      }
    }
    const blockEnd = fieldOf(block, "terminator") as SemanticBlock["terminator"];
    if (String(fieldOf(blockEnd, "k")) === "return" && fieldOf(blockEnd, "value") !== null) {
      walkValues(fieldOf(blockEnd, "value") as SemanticValue, (inner) => {
        if (inner.k === "local") read.add(String(fieldOf(inner, "name")));
      });
    }
  }

  const combined = new Map<string, SemanticReduction>();
  for (const block of blocksWithin(body)) {
    for (const statement of fieldOf(block, "statements") as readonly SemanticStatement[]) {
      if (statement.k !== "set") continue;
      const name = String(fieldOf(statement, "name"));
      const op = String(fieldOf(statement, "op"));
      if (declared.has(name) || name === counter) continue;
      if (op !== "+=" && op !== "*=") continue;
      if (read.has(name)) continue;
      // A name two turns both accumulate into with the same operator combines;
      // one written `+=` in a turn and `*=` in another does not, so the first
      // operator seen is the one that must hold for all of them.
      const seen = combined.get(name);
      const reductionOp = op === "+=" ? "+" : "*";
      if (seen !== undefined && String(fieldOf(seen, "op")) !== reductionOp) {
        combined.delete(name);
        continue;
      }
      combined.set(name, { name, op: reductionOp, exact: true });
    }
  }
  return combined;
}

/* -------------------------------------------------------------------------- */
/* Purity                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What reading a body reaches: the callees it may call, and where the reading
 * has got to. A callee is read with the same rule a loop body is read with, so
 * this is one walk rather than a second, weaker one.
 */
interface Reach {
  readonly callees: Callees;
  /** The one cost model shared by the optimizer and the validator. */
  readonly model?: CostModel;
  /** The callees already being read, so a recursive one is not read forever. */
  readonly reading: Set<string>;
  /** What each callee was found to do, kept so a shared callee is read once. */
  readonly verdicts: Map<string, Refusal | null>;
  /** What each callee was found to answer, kept so a shared callee is read once. */
  readonly wholes: Map<string, boolean>;
  /** What each callee's turn was found to cost, kept so a shared callee is priced once. */
  readonly costs: Map<string, TurnCost>;
}

/**
 * Why a called function may not be run by two turns at once.
 *
 * The callee's body is read with the rule a loop body is read with and nothing
 * of it loosened: a callee that writes a name of its own frame, prints,
 * counts a reference or calls something impure is refused, and one whose body
 * the program does not hold is refused too, because a body nobody has read may
 * do anything. Allocating is not on that list — the runtime's allocator keeps a
 * pool per thread, so a callee that builds values and drops them is pure for
 * this purpose however many it builds.
 *
 * Recursion is answered by assuming the answer and checking it afterwards,
 * which is the only reading that terminates: a function that calls itself and
 * writes nothing is pure, and one whose recursion reaches a write is caught
 * where the write is.
 */
function calleeRefusal(name: string, reach: Reach): Refusal | null {
  const verdicts = fieldOf(reach, "verdicts") as Map<string, Refusal | null>;
  const reading = fieldOf(reach, "reading") as Set<string>;
  const known = verdicts.get(name);
  if (known !== undefined) return known;
  if (reading.has(name)) return null;
  const callee = (fieldOf(reach, "callees") as Callees).get(name);
  if (callee === undefined) {
    const refusal = `the body calls ${name}, whose body this build does not hold`;
    verdicts.set(name, refusal);
    return refusal;
  }
  reading.add(name);
  // The parameters belong to one call of the callee, which is what a turn is:
  // every turn that calls this gets its own copy of each, so a write to one is
  // a write to that turn's own frame and reaches nobody else. A callee that
  // reuses an argument — `n -= 1` on the way down a countdown, the way
  // `createTree` spends the depth it was given — was refused here as a write to
  // a name the turn only found, which refused nearly every loop that calls a
  // function written the ordinary way.
  const paramNames: string[] = [];
  for (const param of fieldOf(callee, "params") as readonly SemanticSlot[]) paramNames[paramNames.length] = String(fieldOf(param, "name"));
  const refusal = bodyRefusal(fieldOf(callee, "entry") as SemanticBlock, null, fieldOf(reach, "callees") as Callees, reach, new Map(), paramNames);
  reading.delete(name);
  verdicts.set(name, refusal);
  return refusal;
}

/** Why a call a turn makes may not be made by two turns at once. */
function callRefusal(call: SemanticCall, reach: Reach): Refusal | null {
  // An owned result is a fresh block, and the runtime's allocator keeps a pool
  // of its own per thread, so two turns taking a block at once take them from
  // two cursors and that is a program rather than a corruption. A retained
  // result is different in kind: it is a reference count written through a
  // reference, which is one number every turn of the loop shares.
  const callee = String(fieldOf(call, "callee"));
  if (fieldOf(call, "retain") === true) {
    return `the body calls ${callee} and counts the reference it hands back, which is one number every turn shares`;
  }
  let effect: string | null = null;
  for (const one of fieldOf(call, "effects") as readonly string[]) if (String(one) !== "memory" && effect === null) effect = String(one);
  if (effect !== null) {
    return `the body calls ${callee}, which has the effect ${effect}`;
  }
  return calleeRefusal(callee, reach);
}

/** Whether a counted loop counts the way a parallel loop has to count. */
function canonicalCounted(loop: Extract<SemanticLoop, { kind: "counted" }>): boolean {
  if (!isInteger(fieldOf(loop, "type") as SemanticType)) return false;
  if (fieldOf(loop, "down") === true) return false;
  // `<=` is the second canonical bound OpenMP allows, and a step that is not
  // one is not a canonical loop whatever the counter is.
  const step = fieldOf(loop, "step") as SemanticValue | null;
  if (step !== null) {
    if (step.k !== "const") return false;
    if (Number(fieldOf(step, "text")) !== 1) return false;
  }
  return true;
}

/**
 * How much work one turn of a loop does, counted in the values it computes.
 *
 * Starting a team of threads costs tens of microseconds, and a turn that
 * computes a handful of values does less than that. A loop of those is left
 * alone for a measured reason: on an `out[i] = in[i] * 2 + 1` over four million
 * elements, handing it to four threads measured 1.6 times SLOWER than running
 * it in order — the C compiler already vectorises it, and the loop is bound by
 * the memory it moves rather than by the arithmetic. The same pragma over a
 * loop whose turn computes a thousand values measured 1.9 times faster.
 *
 * What a turn computes *through a call* counts as its own, because the thread
 * runs the callee too: `out[i] = f(values[i])` writes one element and computes
 * two values, and refusing it on that count would refuse exactly the shape the
 * purity analysis exists to admit. A callee already read is counted once, and
 * the whole of a block is read — the value a block ends in is as much of what a
 * turn computes as the statements before it, and a function that computes its
 * answer in a `return` has almost all of its work there.
 *
 * A callee that reaches itself is the one case a count cannot speak for, and it
 * is not counted and refused but not refused at all. Reading a recursive
 * function once gives one turn of it however many turns the recursion actually
 * takes: `createTree` read once is a handful of values, and `createTree` at a
 * depth a program chooses is as many as the program says. The IR holds no bound
 * on how deep a recursion goes, so the cost of one call is not a number this
 * count can answer, and a turn that makes one is not a turn that is cheap — it
 * is a turn whose cost nobody has measured. Refusing it on a threshold would be
 * the absence of a measurement wearing the clothes of one.
 *
 * The threshold is the point between the two measured cases, and a count of
 * values is what the IR holds of the size of a turn.
 */
const MINIMUM_VALUES_PER_TURN = 8;

/**
 * Whether one turn of a loop computes too little to be worth a thread, which
 * is the same question asked without the bodies a caller happens to hold.
 *
 * A backend that runs the turns itself has no program to read a callee out of,
 * and a callee it cannot read adds one value to the count rather than what the
 * callee computes. That is the safe direction to be wrong in: a turn that
 * calls something is measured as cheaper than it is, so it is left to run in
 * order, and a turn nobody measured is never handed to a thread on a number
 * this produced.
 */
export function turnIsTooCheap(body: SemanticBlock, callees: Callees = new Map(), model: CostModel = DEFAULT_COST_MODEL): boolean {
  return turnIsTooCheapIn(body, { callees, model, reading: new Set(), verdicts: new Map(), wholes: new Map(), costs: new Map() });
}

function turnIsTooCheapIn(body: SemanticBlock, reach: Reach): boolean {
  const cost: TurnCost = { values: 0, unbounded: false, unresolved: 0 };
  measureTurn(body, reach, cost);
  return fieldOf(cost, "unbounded") !== true && Number(fieldOf(cost, "values")) < MINIMUM_VALUES_PER_TURN;
}

/**
 * The explicit verdict for the cost of one turn, which a validator reads rather
 * than the bare boolean. An unresolved call is *unknown*, not a value of one:
 * there is no body from which to price it, and the boolean above is only the
 * conservative lower bound a backend uses to decide whether to thread.
 */
export function turnCostAssessment(
  body: SemanticBlock,
  callees: Callees = new Map(),
  model: CostModel = DEFAULT_COST_MODEL,
): Assessment<number> {
  const reach: Reach = { callees, model, reading: new Set(), verdicts: new Map(), wholes: new Map(), costs: new Map() };
  const cost: TurnCost = { values: 0, unbounded: false, unresolved: 0 };
  measureTurn(body, reach, cost);
  if (fieldOf(cost, "unbounded") === true) {
    return { status: "incomplete", reason: "a turn calls a function that reaches itself, so its cost has no bound" };
  }
  const unresolved = Number(fieldOf(cost, "unresolved"));
  if (unresolved > 0) {
    return { status: "unknown", reason: `${unresolved} call(s) in a turn have no body in this build` };
  }
  return { status: "known", value: Number(fieldOf(cost, "values")) };
}

/** What one turn is measured to be: how many values it computes, and whether it calls itself. */
interface TurnCost {
  values: number;
  /** True when a turn calls a function that reaches itself, which this cannot measure. */
  unbounded: boolean;
  /** Calls whose callee this build does not hold, which are unknown rather than cheap. */
  unresolved: number;
}

/** The values a body computes, and those the functions it calls compute. */
function measureTurn(body: SemanticBlock, reach: Reach, cost: TurnCost): void {
  const model: CostModel = fieldOf(reach, "model") ?? DEFAULT_COST_MODEL;
  for (const block of blocksWithin(body)) {
    // What a block ends in is as much of its work as what it does before it, and
    // for a function that computes an answer that answer is nearly all of it.
    const blockEnd = fieldOf(block, "terminator") as SemanticBlock["terminator"];
    if (String(fieldOf(blockEnd, "k")) === "return" && fieldOf(blockEnd, "value") !== null) {
      walkValues(fieldOf(blockEnd, "value") as SemanticValue, (inner) => {
        setFieldOn(cost, "values", Number(fieldOf(cost, "values")) + model.operation);
        if (inner.k === "call") measureCall(String(fieldOf(fieldOf(inner, "call"), "callee")), reach, cost);
      });
    }
    for (const statement of fieldOf(block, "statements") as readonly SemanticStatement[]) {
      for (const value of statementValues(statement)) {
        walkValues(value, (inner) => {
          setFieldOn(cost, "values", Number(fieldOf(cost, "values")) + model.operation);
          if (inner.k !== "call") return;
          measureCall(String(fieldOf(fieldOf(inner, "call"), "callee")), reach, cost);
        });
      }
    }
  }
}

/** What a call a turn makes adds to what the turn is measured to be. */
function measureCall(name: string, reach: Reach, cost: TurnCost): void {
  const callee = (fieldOf(reach, "callees") as Callees).get(name);
  if (callee === undefined) {
    // An unresolved call is recorded as unknown explicitly, rather than being
    // silently charged as a bare call. `turnCostAssessment` surfaces it; the
    // boolean verdict keeps the conservative lower bound for backends that
    // have no callees at all.
    setFieldOn(cost, "unresolved", Number(fieldOf(cost, "unresolved")) + 1);
    return;
  }
  const calleeName = String(fieldOf(callee, "name"));
  const reading = fieldOf(reach, "reading") as Set<string>;
  // A call already being read is this callee reaching itself, and how many
  // turns that is nobody can say from what the IR holds.
  if (reading.has(calleeName)) {
    setFieldOn(cost, "unbounded", true);
    return;
  }
  // A callee reached twice in one assessment is priced once. Without this, a
  // call graph whose callees share callees of their own is walked once per path
  // through it, which is exponential in the depth of the graph — a compiler
  // reading its own graph of thousands of functions never finishes a turn.
  const costs = fieldOf(reach, "costs") as Map<string, TurnCost>;
  const cached = costs.get(calleeName);
  if (cached !== undefined) {
    addCost(cost, cached);
    return;
  }
  const own: TurnCost = { values: 0, unbounded: false, unresolved: 0 };
  reading.add(calleeName);
  measureTurn(fieldOf(callee, "entry") as SemanticBlock, reach, own);
  reading.delete(calleeName);
  costs.set(calleeName, own);
  addCost(cost, own);
}

/** Add one measured cost into another. */
function addCost(into: TurnCost, from: TurnCost): void {
  setFieldOn(into, "values", Number(fieldOf(into, "values")) + Number(fieldOf(from, "values")));
  setFieldOn(into, "unresolved", Number(fieldOf(into, "unresolved")) + Number(fieldOf(from, "unresolved")));
  if (fieldOf(from, "unbounded") === true) setFieldOn(into, "unbounded", true);
}

/** One element of an array the body reaches, and whether the body writes it. */
interface ElementAccess {
  buffer: string;
  readonly index: SemanticValue;
  readonly written: boolean;
}

/**
 * Why the turns of a body may not run at the same time, or null when they may.
 *
 * The names the body declares are its own: a turn that declares `total` has a
 * `total` of its own, because the declaration is written inside the turn and
 * every turn enters it. Everything outside the body belongs to the frame the
 * body is in, and a write to any of that is a write another turn can be reading
 * at the same moment.
 *
 * The names a callee was handed are its own for the same reason, one call
 * further out: every turn that calls it is a separate call, with a separate copy
 * of each parameter. That is what `perCall` carries, and it is why a function
 * that spends its argument — a countdown stepping `n` down — is a callee two
 * turns may both make.
 *
 * An array element is the exception, and it is the exception that makes the
 * rule worth anything: `out[i] = f(values[i])` is the shape nearly every loop
 * worth parallelising is, and refusing it would leave a rule that marks only
 * loops no program keeps. An element written at the counter names a different
 * element on every turn, so those writes never meet, and an element read at the
 * counter is that turn's own element, which nobody else writes. Any other index
 * is refused, because the IR holds no length and nothing here could say the two
 * turns do not name the same one.
 */
function bodyRefusal(
  body: SemanticBlock,
  counter: string | null,
  callees: Callees,
  reach: Reach = { callees, reading: new Set(), verdicts: new Map(), wholes: new Map(), costs: new Map() },
  combined: ReadonlyMap<string, SemanticReduction> = new Map(),
  perCall: readonly string[] = [],
): Refusal | null {
  // A name this body declares is the body's own, and every turn of it has one
  // of its own: the declaration is written inside the turn and every turn
  // enters it. A name the body only found belongs to the frame the body is in,
  // and a write to one of those is a write another turn can be reading at the
  // same moment.
  const declared = new Set<string>(perCall);
  for (const block of blocksWithin(body)) {
    for (const statement of fieldOf(block, "statements") as readonly SemanticStatement[]) {
      if (statement.k === "let") declared.add(String(fieldOf(fieldOf(statement, "slot"), "name")));
    }
  }
  // A name a turn binds to another name is the same buffer under two names, and
  // the element rule below reads a buffer by its name: `let mine = out;` then a
  // write at `mine[i]` and a read at `out[j]` would be two buffers, and two
  // turns could write `out[i]` through one name and read what the other wrote.
  const aliases = new Map<string, string>();
  for (const block of blocksWithin(body)) {
    for (const statement of fieldOf(block, "statements") as readonly SemanticStatement[]) {
      const value = fieldOf(statement, "value") as SemanticValue;
      if (statement.k === "let" && value.k === "local" && String(fieldOf(value, "name")) !== String(fieldOf(fieldOf(statement, "slot"), "name"))) {
        aliases.set(String(fieldOf(fieldOf(statement, "slot"), "name")), String(fieldOf(value, "name")));
      }
    }
  }
  // A name bound to a name bound to a name is the first name's, so the chain is
  // followed until it ends at a name nothing else is bound to.
  const bufferOf = (name: string): string => {
    let at = name;
    while (aliases.has(at)) at = aliases.get(at) as string;
    return at;
  };
  const accesses: ElementAccess[] = [];
  for (const block of blocksWithin(body)) {
    // What a block ends in is as much of its work as what it does before it,
    // and for a function that computes an answer that answer is nearly all of
    // it. A callee that prints, allocates or counts a reference is refused for
    // the call wherever the call is written, and a body whose only call sits in
    // its return is a body whose call was never read: the turns of a loop that
    // calls such a body then print over each other. It is read here for the same
    // reason `measureTurn` reads it there.
    const blockEnd = fieldOf(block, "terminator") as SemanticBlock["terminator"];
    if (String(fieldOf(blockEnd, "k")) === "return" && fieldOf(blockEnd, "value") !== null) {
      let refusal: Refusal | null = null;
      walkValues(fieldOf(blockEnd, "value") as SemanticValue, (inner) => {
        if (refusal === null && inner.k === "call") refusal = callRefusal(fieldOf(inner, "call") as SemanticCall, reach);
      });
      if (refusal !== null) return refusal;
      walkValues(fieldOf(blockEnd, "value") as SemanticValue, (inner) => {
        const of = fieldOf(inner, "of") as SemanticValue;
        if (inner.k === "element" && of.k === "local") {
          accesses.push({ buffer: String(fieldOf(of, "name")), index: fieldOf(inner, "index") as SemanticValue, written: false });
        }
      });
    }
    for (const statement of fieldOf(block, "statements") as readonly SemanticStatement[]) {
      const nestedRefusal = valueRefusal(statement, reach);
      if (nestedRefusal !== null) return nestedRefusal;
      const written = writeRefusal(statement, accesses, declared, reach, combined);
      if (written !== null) return written;
      for (const value of statementValues(statement)) {
        walkValues(value, (inner) => {
          const of = fieldOf(inner, "of") as SemanticValue;
          if (inner.k === "element" && of.k === "local") {
            accesses.push({ buffer: String(fieldOf(of, "name")), index: fieldOf(inner, "index") as SemanticValue, written: false });
          }
        });
      }
    }
  }
  // Every access is renamed to the buffer its name stands for before the rule
  // below reads them, so a write through one name and a read through another are
  // one buffer rather than two.
  for (let at = 0; at < accesses.length; at += 1) {
    const access = accesses[at];
    setFieldOn(access, "buffer", bufferOf(String(fieldOf(access, "buffer"))));
  }
  if (counter === null) {
    return accesses.some((access) => fieldOf(access, "written") === true)
      ? "the body writes an element of an array, and nothing here says which turn writes which"
      : null;
  }
  return elementRefusal(accesses, counter);
}

/**
 * Why the values a statement computes may not be computed by two turns at once.
 *
 * A value that reads memory is fine — nothing writes it — but a value that calls
 * is a value that may print, may count a reference, and is read through the
 * callee's own body. Each of those that a turn cannot do is one thing the whole
 * program shares. The call is read here rather than refused outright, so a body
 * whose callee the compiler can prove writes nothing is not refused for calling
 * it — and neither is one refused for allocating, which the per-thread pool
 * makes safe.
 */
function valueRefusal(statement: SemanticStatement, reach: Reach): Refusal | null {
  for (const value of statementValues(statement)) {
    let heldRefusal: Refusal | null = null;
    walkValues(value, (inner) => {
      if (heldRefusal !== null || inner.k !== "call") return;
      heldRefusal = callRefusal(fieldOf(inner, "call") as SemanticCall, reach);
    });
    if (heldRefusal !== null) return heldRefusal;
  }
  return null;
}

/** Why the array elements a body reaches may not be reached by two turns at once. */
function elementRefusal(accesses: readonly ElementAccess[], counter: string): Refusal | null {
  const atCounter = (index: SemanticValue): boolean => index.k === "local" && String(fieldOf(index, "name")) === counter;
  const written = new Set<string>();
  for (const access of accesses) {
    if (fieldOf(access, "written") !== true) continue;
    if (!atCounter(fieldOf(access, "index") as SemanticValue)) {
      return `the body writes an element of ${String(fieldOf(access, "buffer"))} at an index that is not this turn's counter, so two turns may write the same one`;
    }
    if (written.has(String(fieldOf(access, "buffer")))) {
      return `the body writes ${String(fieldOf(access, "buffer"))} more than once a turn, and only one write a turn is a write the turns cannot share`;
    }
    written.add(String(fieldOf(access, "buffer")));
  }
  for (const access of accesses) {
    if (written.has(String(fieldOf(access, "buffer"))) && !atCounter(fieldOf(access, "index") as SemanticValue)) {
      return `the body reads ${String(fieldOf(access, "buffer"))} at an index that is not this turn's counter, and another turn may be writing that element`;
    }
  }
  return null;
}

/**
 * Why a statement a parallel body may not contain, or null when it may.
 *
 * Every value a statement computes has already been read for calls by the walk
 * above, so what is left here is the writes: a turn that writes nothing another
 * turn reaches cannot be in another turn's way however the two of them are
 * scheduled. An element of an array is recorded rather than judged here, because
 * whether a write to one is this turn's own is a question about the counter,
 * which every access to that array has to be read against.
 */
function writeRefusal(
  statement: SemanticStatement,
  accesses: ElementAccess[],
  declared: ReadonlySet<string>,
  reach: Reach,
  combined: ReadonlyMap<string, SemanticReduction>,
): Refusal | null {
  switch (statement.k) {
    // A name the body declared is the turn's own; anything else is the frame's
    // — unless the loop combines it, which is what a reduction is: a write to
    // one accumulator the turns combine once the loop is done, which is the
    // same number as a turn writing it, so long as combining is exact.
    case "set": {
      const statementName = String(fieldOf(statement, "name"));
      const statementOp = String(fieldOf(statement, "op"));
      if (declared.has(statementName)) return null;
      const reduction = combined.get(statementName);
      if (reduction === undefined) {
        return `the body writes "${statementName}", which every turn of it shares`;
      }
      // A name a turn assigns outright is not a reduction at all — it decided
      // the total rather than adding to it — and one written a different way in
      // another turn is not a combination either.
      const reductionOp = String(fieldOf(reduction, "op"));
      if (statementOp !== (reductionOp === "+" ? "+=" : "*=")) {
        return `the body writes "${statementName}" with ${statementOp}, which is not the ${reductionOp} the turns combine it with`;
      }
      if (!valueIsWhole(fieldOf(statement, "value") as SemanticValue, reach)) {
        return `the body combines "${statementName}" from a value that is not a whole number, and a sum of doubles is not the same number however it is grouped`;
      }
      return null;
    }
    case "step": {
      const stepName = String(fieldOf(statement, "name"));
      return declared.has(stepName)
        ? null
        : `the body steps "${stepName}", which every turn of it shares`;
    }
    case "setElement":
      accesses.push({ buffer: String(fieldOf(statement, "buffer")), index: fieldOf(statement, "index") as SemanticValue, written: true });
      return null;
    case "fill":
      return `the body fills ${String(fieldOf(statement, "buffer"))}, which is every element of it at once`;
    case "storeField":
      return `the body writes the field ${String(fieldOf(statement, "layout"))}.${String(fieldOf(statement, "field"))}, which every turn of it shares`;
    case "printText":
    case "printNumber":
    case "printNewline":
      return "the body prints, and what a program prints is written in the order it was printed";
    case "retain":
      return "the body counts a reference, and the count is one number every turn of it shares";
    case "raise":
      return "the body stops the program, and which turn stopped it first is not the turn that asked to";
    // A call kept for what it does is read like any other: a callee that writes
    // nothing is a call two turns may both make.
    case "call":
      return callRefusal(fieldOf(statement, "call") as SemanticCall, reach);
    // A declared name is the turn's own, so declaring one writes nothing shared.
    // A buffer and an object are each an allocation, and the runtime's
    // allocator keeps a pool of its own per thread, so two turns allocating at
    // once take their blocks from two cursors and push onto two lists. A text
    // is an allocation too when it interpolates, and answers the same way.
    case "let":
      return null;
    default:
      // `if`, `block` and `loop` hold no writes of their own: what is inside
      // them is walked as part of the body.
      return null;
  }
}


/**
 * Whether a value is a whole number, which is what makes combining it the same
 * number however the turns are grouped.
 *
 * A number written without a point is one, however wide a use holds it — the
 * same rule `objects.ts` applies to a loop counter, asked here of a value
 * rather than of a body. Anything else is decided by the type it was resolved
 * to, and an operation is asked of both its sides rather than of the type it
 * carries: the IR states the width an operation runs at, and where a whole
 * number meets a double the statement is a double whatever it says.
 */
function valueIsWhole(value: SemanticValue, reach: Reach): boolean {
  // A number written without a point is a whole number however wide a use
  // holds it, which is the same rule a loop counter is counted by. What decides
  // this is the number, not the width it is carried at: `1` held at `f64` is
  // the whole number 1, and adding it a whole number of times is exact in the
  // same way `1` at `i64` is. What is not safe is a number with a point in it,
  // because that one is a fraction however it is held.
  if (value.k === "const") return isWholeNumberText(String(fieldOf(value, "text")));
  if (value.k === "arith") {
    // A division and a remainder over whole numbers are not whole numbers, and
    // neither is a power: `100 / i` is a double whatever both of its sides are.
    if (DIVIDING.has(String(fieldOf(value, "op")))) return false;
    return valueIsWhole(fieldOf(value, "left") as SemanticValue, reach) && valueIsWhole(fieldOf(value, "right") as SemanticValue, reach);
  }
  // A call answers whatever the body it calls answers, so what the body hands
  // back is the question — not the width the answer is held at, which is what
  // stops a function that returns `1 + 1 + 1` from being read as a double and
  // refused for it.
  if (value.k === "call") return calleeAnswersWhole(String(fieldOf(fieldOf(value, "call"), "callee")), reach);
  const valueType = fieldOf(value, "type") as SemanticType;
  return String(fieldOf(valueType, "kind")) === "primitive" && isWhole(String(fieldOf(valueType, "name")) as PrimitiveTypeName);
}

/**
 * Whether every number a function hands back is a whole number.
 *
 * The answer is read from what the body returns, in every block that returns:
 * `checksum` answers `1`, or `1 + checksum(left) + checksum(right)`, and each of
 * those is whole — so a loop that adds up what it returns may combine them in
 * any order and get the same number.
 *
 * Recursion is answered by assuming and checking afterwards, which is the only
 * reading that terminates: a function that calls itself is taken to answer a
 * whole number while its own body is still being read, and the call inside it
 * is then a call to a whole answer whatever the outer turn finds. A function
 * that reaches itself through a value that is not whole still answers false,
 * because the check is on the value the recursive call sits in rather than on
 * the call being there at all.
 */
function calleeAnswersWhole(name: string, reach: Reach): boolean {
  const wholes = fieldOf(reach, "wholes") as Map<string, boolean>;
  const reading = fieldOf(reach, "reading") as Set<string>;
  const known: boolean | undefined = wholes.get(name);
  if (known !== undefined) return known;
  if (reading.has(name)) return true;
  const callee = (fieldOf(reach, "callees") as Callees).get(name);
  if (callee === undefined) return false;
  reading.add(name);
  let whole = true;
  for (const block of blocksWithin(fieldOf(callee, "entry") as SemanticBlock)) {
    const blockEnd = fieldOf(block, "terminator") as SemanticBlock["terminator"];
    if (String(fieldOf(blockEnd, "k")) !== "return") continue;
    const value = fieldOf(blockEnd, "value") as SemanticValue | null;
    if (value !== null && !valueIsWhole(value, reach)) {
      whole = false;
      break;
    }
  }
  reading.delete(name);
  wholes.set(name, whole);
  return whole;
}

/** The operations whose answer is a double however whole their sides are. */
const DIVIDING: ReadonlySet<string> = new Set(["div", "mod", "pow"]);


/* -------------------------------------------------------------------------- */
/* Asking about a body                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Whether any loop of a program was marked parallel.
 *
 * What the C backend asks before it asks the C compiler for threads, because a
 * `-fopenmp` on a build with no parallel loop in it links a threading runtime
 * into a program that has nothing to run on it.
 */
export function programIsParallel(entry: SemanticBlock, bodies: readonly { entry: SemanticBlock }[]): boolean {
  if (entryIsParallel(entry)) return true;
  return bodies.some((fn) => entryIsParallel(fieldOf(fn, "entry") as SemanticBlock));
}


/** Whether any loop of a body was marked parallel. */
export function entryIsParallel(entry: SemanticBlock): boolean {
  for (const block of blocksWithin(entry)) {
    for (const statement of fieldOf(block, "statements") as readonly SemanticStatement[]) {
      if (statement.k !== "loop") continue;
      const loop = fieldOf(statement, "loop") as SemanticLoop;
      if ((loop.kind === "counted" || loop.kind === "each") && fieldOf(loop, "parallel") === true) return true;
    }
  }
  return false;
}
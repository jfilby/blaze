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
 */

import {
  isInteger,
  statementBlocksOf,
  statementValues,
  walkValues,
  type SemanticBlock,
  type SemanticCall,
  type SemanticFunction,
  type SemanticLoop,
  type SemanticStatement,
  type SemanticValue,
} from "../core/semantic-ir.ts";

/** Why a loop may not have its turns run at once, in terms of what its body does. */
export type Refusal = string;

/**
 * Every function a body may call, by contract name.
 *
 * A callee this map does not hold is a callee whose body nobody has read, and a
 * body nobody has read may print, allocate or write anything — so a call to one
 * is refused. That is the safe reading of an absent entry, and it is why the
 * map is an argument rather than something looked up: a caller that has the
 * bodies says so, and a caller that has not gets the answer that assumes the
 * worst.
 */
export type Callees = ReadonlyMap<string, SemanticFunction>;

/** The names a build holds no callee for, so every call through it is refused. */
export const NO_CALLEES: Callees = new Map();

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
  for (const statement of block.statements) {
    for (const one of statementBlocksOf(statement)) nested.push(...blocksWithin(one));
  }
  return [block, ...nested];
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
export function markParallelLoops(entry: SemanticBlock, callees: Callees = NO_CALLEES): void {
  for (const block of blocksWithin(entry)) {
    for (const statement of block.statements) {
      if (statement.k !== "loop") continue;
      const loop = statement.loop;
      if (loop.kind !== "counted" && loop.kind !== "each") continue;
      if (loop.parallel === true) continue;
      if (refusalFor(loop, callees) === null) loop.parallel = true;
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
export function refusalFor(loop: SemanticLoop, callees: Callees = NO_CALLEES): Refusal | null {
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
  const reach: Reach = { callees, reading: new Set(), verdicts: new Map() };
  if (turnIsTooCheap(loop.body, reach)) {
    return "a turn of this loop computes so little that a team of threads costs more than the turns it runs";
  }
  return bodyRefusal(loop.body, loop.kind === "counted" ? loop.variable : loop.index, callees, reach);
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
  /** The callees already being read, so a recursive one is not read forever. */
  readonly reading: Set<string>;
  /** What each callee was found to do, kept so a shared callee is read once. */
  readonly verdicts: Map<string, Refusal | null>;
}

/**
 * Why a called function may not be run by two turns at once.
 *
 * The callee's body is read with the rule a loop body is read with and nothing
 * of it loosened: a callee that writes a name of its own frame, prints,
 * allocates or calls something impure is refused, and one whose body the program
 * does not hold is refused too, because a body nobody has read may do anything.
 *
 * Recursion is answered by assuming the answer and checking it afterwards,
 * which is the only reading that terminates: a function that calls itself and
 * writes nothing is pure, and one whose recursion reaches a write is caught
 * where the write is.
 */
function calleeRefusal(name: string, reach: Reach): Refusal | null {
  const known = reach.verdicts.get(name);
  if (known !== undefined) return known;
  if (reach.reading.has(name)) return null;
  const callee = reach.callees.get(name);
  if (callee === undefined) {
    const refusal = `the body calls ${name}, whose body this build does not hold`;
    reach.verdicts.set(name, refusal);
    return refusal;
  }
  reach.reading.add(name);
  const refusal = bodyRefusal(callee.entry, null, reach.callees, reach);
  reach.reading.delete(name);
  reach.verdicts.set(name, refusal);
  return refusal;
}

/** Why a call a turn makes may not be made by two turns at once. */
function callRefusal(call: SemanticCall, reach: Reach): Refusal | null {
  // An owned result is a fresh block, and the allocator is one heap with one
  // free list: two turns taking a block at once corrupt it. A retained result is
  // a reference count written through a reference, which is one number every
  // turn of the loop shares.
  if (call.ownership === "owned") {
    return `the body calls ${call.callee}, which allocates what it hands back, and the allocator is one heap`;
  }
  if (call.retain) {
    return `the body calls ${call.callee} and counts the reference it hands back, which is one number every turn shares`;
  }
  const effect = call.effects.find((one) => one !== "memory");
  if (effect !== undefined) {
    return `the body calls ${call.callee}, which has the effect ${effect}`;
  }
  return calleeRefusal(call.callee, reach);
}

/** Whether a counted loop counts the way a parallel loop has to count. */
function canonicalCounted(loop: Extract<SemanticLoop, { kind: "counted" }>): boolean {
  if (!isInteger(loop.type)) return false;
  if (loop.down) return false;
  // `<=` is the second canonical bound OpenMP allows, and a step that is not
  // one is not a canonical loop whatever the counter is.
  if (loop.step !== null) {
    if (loop.step.k !== "const") return false;
    if (Number(loop.step.text) !== 1) return false;
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
 * purity analysis exists to admit. A callee already read is counted once.
 *
 * The threshold is the point between those two, and a count of values is what
 * the IR holds of the size of a turn.
 */
const MINIMUM_VALUES_PER_TURN = 8;

function turnIsTooCheap(body: SemanticBlock, reach: Reach): boolean {
  return valuesIn(body, reach) < MINIMUM_VALUES_PER_TURN;
}

/** The values a body computes, and those the functions it calls compute. */
function valuesIn(body: SemanticBlock, reach: Reach): number {
  let computed = 0;
  for (const block of blocksWithin(body)) {
    for (const statement of block.statements) {
      for (const value of statementValues(statement)) {
        walkValues(value, (inner) => {
          computed += 1;
          if (inner.k !== "call") return;
          const callee = reach.callees.get(inner.call.callee);
          if (callee === undefined || reach.reading.has(callee.name)) return;
          reach.reading.add(callee.name);
          computed += valuesIn(callee.entry, reach);
          reach.reading.delete(callee.name);
        });
      }
    }
  }
  return computed;
}

/** One element of an array the body reaches, and whether the body writes it. */
interface ElementAccess {
  readonly buffer: string;
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
  reach: Reach = { callees, reading: new Set(), verdicts: new Map() },
): Refusal | null {
  // A name this body declares is the body's own, and every turn of it has one
  // of its own: the declaration is written inside the turn and every turn
  // enters it. A name the body only found belongs to the frame the body is in,
  // and a write to one of those is a write another turn can be reading at the
  // same moment.
  const declared = new Set<string>();
  for (const block of blocksWithin(body)) {
    for (const statement of block.statements) {
      if (statement.k === "let") declared.add(statement.slot.name);
    }
  }
  const accesses: ElementAccess[] = [];
  for (const block of blocksWithin(body)) {
    for (const statement of block.statements) {
      const refusal = valueRefusal(statement, reach);
      if (refusal !== null) return refusal;
      const written = writeRefusal(statement, accesses, declared, reach);
      if (written !== null) return written;
      for (const value of statementValues(statement)) {
        walkValues(value, (inner) => {
          if (inner.k === "element" && inner.of.k === "local") {
            accesses.push({ buffer: inner.of.name, index: inner.index, written: false });
          }
        });
      }
    }
  }
  if (counter === null) {
    return accesses.some((access) => access.written)
      ? "the body writes an element of an array, and nothing here says which turn writes which"
      : null;
  }
  return elementRefusal(accesses, counter);
}

/**
 * Why the values a statement computes may not be computed by two turns at once.
 *
 * A value that reads memory is fine — nothing writes it — but a value that calls
 * is a value that allocates, prints or counts a reference, and each of those is
 * one thing the whole program shares. The call is read here rather than
 * refused outright, so a body whose callee the compiler can prove writes nothing
 * is not refused for calling it.
 */
function valueRefusal(statement: SemanticStatement, reach: Reach): Refusal | null {
  for (const value of statementValues(statement)) {
    let refusal: Refusal | null = null;
    walkValues(value, (inner) => {
      if (refusal !== null || inner.k !== "call") return;
      refusal = callRefusal(inner.call, reach);
    });
    if (refusal !== null) return refusal;
  }
  return null;
}

/** Why the array elements a body reaches may not be reached by two turns at once. */
function elementRefusal(accesses: readonly ElementAccess[], counter: string): Refusal | null {
  const atCounter = (index: SemanticValue): boolean => index.k === "local" && index.name === counter;
  const written = new Set<string>();
  for (const access of accesses) {
    if (!access.written) continue;
    if (!atCounter(access.index)) {
      return `the body writes an element of ${access.buffer} at an index that is not this turn's counter, so two turns may write the same one`;
    }
    if (written.has(access.buffer)) {
      return `the body writes ${access.buffer} more than once a turn, and only one write a turn is a write the turns cannot share`;
    }
    written.add(access.buffer);
  }
  for (const access of accesses) {
    if (written.has(access.buffer) && !atCounter(access.index)) {
      return `the body reads ${access.buffer} at an index that is not this turn's counter, and another turn may be writing that element`;
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
): Refusal | null {
  switch (statement.k) {
    // A name the body declared is the turn's own; anything else is the frame's.
    case "set":
      return declared.has(statement.name)
        ? null
        : `the body writes "${statement.name}", which every turn of it shares`;
    case "step":
      return declared.has(statement.name)
        ? null
        : `the body steps "${statement.name}", which every turn of it shares`;
    case "setElement":
      accesses.push({ buffer: statement.buffer, index: statement.index, written: true });
      return null;
    case "fill":
      return `the body fills ${statement.buffer}, which is every element of it at once`;
    case "storeField":
      return `the body writes the field ${statement.layout}.${statement.field}, which every turn of it shares`;
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
      return callRefusal(statement.call, reach);
    // A declared name is the turn's own, so declaring one writes nothing shared.
    // A buffer and an object are each an allocation, and the runtime's
    // allocator is one heap with one free list: two turns allocating at once
    // corrupt it. A text is an allocation too when it interpolates.
    case "let":
      if (statement.slot.kind === "object") {
        return `the body allocates the object "${statement.slot.name}", and the runtime's allocator is one heap`;
      }
      if (statement.slot.kind === "buffer") {
        return `the body allocates the array "${statement.slot.name}", and the runtime's allocator is one heap`;
      }
      return null;
    default:
      // `if`, `block` and `loop` hold no writes of their own: what is inside
      // them is walked as part of the body.
      return null;
  }
}


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
  return bodies.some((fn) => entryIsParallel(fn.entry));
}


/** Whether any loop of a body was marked parallel. */
export function entryIsParallel(entry: SemanticBlock): boolean {
  for (const block of blocksWithin(entry)) {
    for (const statement of block.statements) {
      if (statement.k !== "loop") continue;
      const loop = statement.loop;
      if ((loop.kind === "counted" || loop.kind === "each") && loop.parallel === true) return true;
    }
  }
  return false;
}
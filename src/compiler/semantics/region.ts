/**
 * Which loops may have the storage one turn allocates reused by the next.
 *
 * A program that builds something and then drops it takes fresh storage for
 * every one it builds, and the cost of that is not the arithmetic. On
 * binarytrees at depth 18 the pool this compiler uses today grows to a
 * gigabyte and about three quarters of the run is the kernel handing out fresh
 * pages for it. Rewinding a cursor at the top of every turn measured 2.8 times
 * faster and 59 times smaller, because the next tree is written over the one
 * just walked and the working set stays where the cache can reach it.
 *
 * The reuse is the same program only when nothing a turn allocates is still
 * wanted once that turn has finished. This module is what decides whether the
 * compiler can show that. A loop it cannot show it for keeps taking its storage
 * fresh: a refusal costs memory, and a mistake would corrupt.
 */

import {
  isReference,
  isTextType,
  statementBlocksOf,
  statementValues,
  valueKind,
  walkValues,
  type SemanticBlock,
  type SemanticFunction,
  type SemanticLoop,
  type SemanticStatement,
  type SemanticValue,
} from "../core/semantic-ir.ts";
import { builtinFor } from "./builtins.ts";

/** Why a loop's turns may not reuse the storage the turn before them took. */
export type Refusal = string;

/**
 * Every function a body may call, by contract name.
 *
 * A body this build does not hold is a body nobody has read, so a call to one
 * is refused rather than assumed: this module reads a callee to know what it
 * does with what it is handed, and a callee it cannot read it cannot say.
 */
export type Callees = ReadonlyMap<string, SemanticFunction>;

/** The names a build holds no callee for, so every call through them is refused. */
export const NO_CALLEES: Callees = new Map();

/** A block and every block nested inside it, itself included. */
function blocksWithin(block: SemanticBlock): SemanticBlock[] {
  const blocks: SemanticBlock[] = [block];
  for (const statement of block.statements) {
    for (const inner of statementBlocksOf(statement)) blocks.push(...blocksWithin(inner));
  }
  return blocks;
}

/* -------------------------------------------------------------------------- */
/* The pass                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Marks every loop whose turns may take their storage from a region.
 *
 * The mark is about memory and not about turns. It says nothing about whether
 * two turns may run at once, and a loop may carry it without carrying
 * `parallel` and the other way about.
 *
 * Only one loop on a path is marked, and it is the innermost one that can be.
 * A rewind takes back everything the region has handed out, so a rewind inside
 * a loop that is itself marked would write over what the outer turn had taken
 * before the inner loop began. Which loop those is is decided by the program:
 * the loop the blocks are built in is the one whose turns should pay to rewind,
 * and an outer loop with a marked loop inside it keeps taking its storage fresh.
 */
export function markRegionLoops(entry: SemanticBlock, callees: Callees = NO_CALLEES): void {
  markWithin(entry, callees);
}

/**
 * A loop that can carry a mark at all. Only the two kinds the runtime runs a
 * turn of carry one, so reading the mark off any other kind is reading a field
 * that is not there.
 */
function isMarkedLoop(loop: SemanticLoop): loop is Extract<SemanticLoop, { kind: "counted" | "each" }> {
  return loop.kind === "counted" || loop.kind === "each";
}

/**
 * Marks the loops of a body innermost first, and answers whether any of them
 * was marked — which is what stops the loop around it being marked too.
 */
function markWithin(block: SemanticBlock, callees: Callees): boolean {
  let marked = false;
  for (const statement of block.statements) {
    if (statement.k === "loop") {
      const loop = statement.loop;
      const beneath = markWithin(loop.body, callees);
      if (beneath) {
        marked = true;
        continue;
      }
      // An inner loop that is already marked is one this pass did not mark — it
      // arrived in the IR text, or an earlier pass over this body marked it — and
      // the loop around it must not be marked too. The region runtime keeps one
      // cursor and rewinds it on entry rather than pushing, so two marked loops
      // on one path hand the inner turn the base block the outer turn is still
      // filling, and every block the outer turn took before it is handed out a
      // second time.
      if (isMarkedLoop(loop) && loop.region === true) {
        marked = true;
        continue;
      }
      // A loop whose turns build nothing has no cursor to rewind, so the mark
      // would cost the two calls that open and close a region on every turn of
      // every such loop in the program and buy nothing at all.
      if (
        (loop.kind === "counted" || loop.kind === "each") &&
        turnBuilds(loop, callees) &&
        refusalFor(loop, callees) === null
      ) {
        loop.region = true;
        marked = true;
      }
      continue;
    }
    for (const inner of statementBlocksOf(statement)) {
      if (markWithin(inner, callees)) marked = true;
    }
  }
  return marked;
}

/**
 * Whether a turn of a loop builds a block of its own, which is the one thing
 * the reuse acts on.
 *
 * The answer is read over every block inside the loop, nested loops included: a
 * turn builds whatever the body builds, and a block built by a loop inside it
 * is a block this turn built. Whether the loop around a marked one is then
 * marked is a different question, asked above this one, and answered by which
 * of the two is the innermost that can be.
 *
 * A call to a function this build does not hold is read as building a block,
 * which is the direction that keeps the reuse: a body nobody has read is a
 * body that may allocate, and a loop that loses its mark loses the memory the
 * region saves. Every other answer here can only add a mark, never drop one the
 * program would otherwise have had.
 */
function turnBuilds(loop: SemanticLoop, callees: Callees): boolean {
  const reach: Builds = { callees, reading: new Set(), builds: new Map() };
  for (const block of blocksWithin(loop.body)) {
    for (const statement of block.statements) {
      for (const value of statementValues(statement)) {
        if (buildsIn(value, reach)) return true;
      }
    }
    if (block.terminator.k === "return" && block.terminator.value !== null && buildsIn(block.terminator.value, reach)) {
      return true;
    }
  }
  return false;
}

/** What one walk of the callees of a loop's body is holding. */
interface Builds {
  readonly callees: Callees;
  /** The callees already being read, so a recursive one is not read forever. */
  readonly reading: Set<string>;
  /** What each callee was found to build, kept so a shared callee is read once. */
  readonly builds: Map<string, boolean>;
}

/** Whether a value is, or reaches, a block built where the value was written. */
function buildsIn(value: SemanticValue, reach: Builds): boolean {
  let found = false;
  walkValues(value, (inner) => {
    if (found) return;
    if (inner.k === "newObject") {
      found = true;
    } else if (inner.k === "buffer") {
      // A window into a block another name holds is a block of that name's, not
      // one this turn made.
      found = inner.view === null;
    } else if (inner.k === "call") {
      // A function the compiler itself provides computes its answer out of what
      // it is handed and builds nothing, so it is not a body nobody has read.
      found = !inner.call.builtin && calleeMayBuild(inner.call.callee, reach);
    }
  });
  return found;
}

/**
 * Whether a function builds a block of its own, read the way `calleeBuilds`
 * above reads it and answering the other way round for a body this build does
 * not hold.
 */
function calleeMayBuild(name: string, reach: Builds): boolean {
  const known = reach.builds.get(name);
  if (known !== undefined) return known;
  const callee = reach.callees.get(name);
  // A body nobody has read is a body that may allocate. Assuming and checking
  // afterwards is what breaks a recursion: the answer is what the body holds
  // once the loop of the reading has been cut, which is a body this build can
  // only answer for where it has one.
  if (callee === undefined) return true;
  if (reach.reading.has(name)) return false;
  reach.reading.add(name);
  let builds = false;
  for (const block of blocksWithin(callee.entry)) {
    for (const statement of block.statements) {
      for (const value of statementValues(statement)) {
        if (buildsIn(value, reach)) builds = true;
      }
      if (builds) break;
    }
    if (!builds && block.terminator.k === "return" && block.terminator.value !== null) {
      builds = buildsIn(block.terminator.value, reach);
    }
    if (builds) break;
  }
  reach.reading.delete(name);
  reach.builds.set(name, builds);
  return builds;
}

/* -------------------------------------------------------------------------- */
/* The rule                                                                    */
/* -------------------------------------------------------------------------- */

/** What one walk of a callee's body is holding. */
interface Reach {
  readonly callees: Callees;
  /** The callees already being read, so a recursive one is not read forever. */
  readonly reading: Set<string>;
  /** What each callee was found to build, kept so a shared callee is read once. */
  readonly makes: Map<string, boolean>;
  /** What each callee was found to keep, kept so a shared callee is read once. */
  readonly keeps: Map<string, boolean>;
}

/**
 * Why the turns of a loop may not reuse the storage the turn before them took,
 * or null when they may.
 *
 * There is one clause and it is the whole of it: something the turn allocates
 * is still wanted after the turn ends. Everything below is a way of showing
 * that, and a way of showing it the compiler cannot take is a refusal.
 */
export function refusalFor(loop: SemanticLoop, callees: Callees = NO_CALLEES): Refusal | null {
  if (loop.kind === "while" || loop.kind === "doWhile") {
    return "a turn of a loop that may run any number of times cannot promise what the turn after it still wants";
  }
  return bodyRefusal(loop.body, { callees, reading: new Set(), makes: new Map(), keeps: new Map() });
}

/**
 * Whether anything a turn allocates is still wanted once the turn has ended.
 *
 * The answer is about reachability rather than about types. A block built in
 * the turn and held only by names the turn declares is gone when the turn ends;
 * the same block held by a name the turn found is not. So the walk follows the
 * blocks the turn makes into wherever they are put, and stops as soon as one of
 * them lands somewhere that outlives it.
 */
function bodyRefusal(body: SemanticBlock, reach: Reach): Refusal | null {
  // A name this body declares dies with it, and so does anything only that
  // name holds. A name the body found belongs to the frame the body is in, and
  // a block put into one of those is still wanted when the turn is over.
  const declared = new Set<string>();
  for (const block of blocksWithin(body)) {
    for (const statement of block.statements) {
      if (statement.k === "let") declared.add(statement.slot.name);
    }
  }
  // The names holding a block of this turn. A name is here once a block has
  // been bound to it, which is the only way a block reaches a name at all.
  const held: Set<string> = new Set();

  for (const block of blocksWithin(body)) {
    for (const statement of block.statements) {
      const refusal = statementRefusal(statement, declared, held, reach);
      if (refusal !== null) return refusal;
    }
    if (block.terminator.k === "return" && block.terminator.value !== null && ownsRegionBlock(block.terminator.value, held, reach)) {
      return "the turn hands back something it allocated, and the reuse would write over it";
    }
  }
  return null;
}

/** Why one statement of a turn may not have its blocks reused, or null. */
function statementRefusal(
  statement: SemanticStatement,
  declared: ReadonlySet<string>,
  held: Set<string>,
  reach: Reach,
): Refusal | null {
  // A call written as a value is as much a call as one written as a statement,
  // and what it is handed is as much of this turn's business: `let total =
  // checksum(tree)` hands the tree to `checksum` exactly as `checksum(tree)` on
  // its own line does, and the answer is the same either way.
  for (const value of statementValues(statement)) {
    let refused: Refusal | null = null;
    walkValues(value, (inner) => {
      if (refused !== null || inner.k !== "call") return;
      for (const argument of inner.call.args) {
        if (storesRegionBlock(argument, held, reach) && !calleeKeepsNothing(inner.call.callee, reach)) {
          refused = "the turn hands something it allocated to a function that keeps what it is given";
        }
      }
    });
    if (refused !== null) return refused;
  }

  switch (statement.k) {
    case "let":
      // Read without the reference gate `storesRegionBlock` puts on an escape:
      // this line records which names hold a block rather than asking whether
      // one leaves, and a name wrongly in `held` only refuses a mark later. A
      // call whose declared type is a reference is the shape this exists for.
      if (!ownsRegionBlock(statement.value, held, reach)) return null;
      // A name the turn declares dies with the turn, so a block bound to one is
      // gone before the next turn asks for storage.
      if (declared.has(statement.slot.name)) {
        held.add(statement.slot.name);
        return null;
      }
      return "the turn binds something it allocated to a name that outlives it";
    case "set":
      return storesRegionBlock(statement.value, held, reach)
        ? "the turn writes something it allocated into a name that outlives it"
        : null;
    case "setElement":
    case "fill":
      // An element written into a buffer the turn made is inside the reuse; one
      // written into a buffer the turn found is handed to whatever holds it.
      if (storesRegionBlock(statement.value, held, reach) && !(declared.has(statement.buffer) && held.has(statement.buffer))) {
        return "the turn writes something it allocated into a buffer that outlives it";
      }
      return null;
    case "storeField":
      // A field of a block the turn made is inside the reuse. A field of
      // anything else is not, and putting one there hands the next turn's
      // rewind a value that is still wanted.
      if (storesRegionBlock(statement.value, held, reach) && !ownsRegionBlock(statement.object, held, reach)) {
        return "the turn stores something it allocated into an object that outlives it";
      }
      return null;
    case "retain":
      return ownsRegionBlock(statement.value, held, reach)
        ? "the turn counts something it allocated, and a count outlives the storage it counts"
        : null;
    default:
      // Reading a block is how a turn uses one, printing one and raising with
      // one are both over before the turn ends, and a nested loop or a block
      // is this turn's own body.
      return null;
  }
}

/**
 * Whether putting `value` where this statement puts it hands a block of the
 * turn to something that outlives it.
 *
 * This is `ownsRegionBlock` with the question of what lands there asked first,
 * and on a turn that walks a tree the answer is the difference between the
 * reuse and no reuse at all: `sum += checksum(tree)` *reads* every block the
 * tree is made of and writes a `f64`, and a walk of the value reaches `tree`
 * through both of the calls `checksum` makes with it. Only a value that is a
 * reference can put a block anywhere, so a number is answered before the walk
 * is asked — a store that stores no block is not an escape.
 */
/**
 * Whether this value can put a block anywhere at all.
 *
 * `valueKind` answers "number" for a value of an `array` type, because a
 * printer and a truth test are what mostly read it and neither of those wants a
 * buffer handled as a reference. An array is nevertheless held as a pointer to
 * its first element and lands in a name exactly as a `ptr` does, so asking
 * `valueKind` here is what made every array a turn allocates invisible to the
 * escape walk: `ownsRegionBlock` below counts a buffer written in a turn as the
 * turn's own block, and this gate then answered "number" and never asked.
 */
function carriesRegionBlock(value: SemanticValue): boolean {
  // A text is a block the runtime laid out as much as a buffer is, so a string a
  // turn builds and puts somewhere that outlives the turn is the same escape.
  // Reading only the reference kinds let a loop whose turn built a string into a
  // buffer be reused, and the string the next turn built was written over it.
  return valueKind(value) === "reference" || isTextType(value.type) || isReference(value.type) || value.type.kind === "array";
}

/**
 * Whether putting `value` where this statement puts it hands a block of the
 * turn to something that outlives it.
 *
 * This is `ownsRegionBlock` with the question of what lands there asked first,
 * and on a turn that walks a tree the answer is the difference between the
 * reuse and no reuse at all: `sum += checksum(tree)` *reads* every block the
 * tree is made of and writes a `f64`, and a walk of the value reaches `tree`
 * through both of the calls `checksum` makes with it. Only a value that can
 * carry a block can put one anywhere, so a number is answered before the walk
 * is asked — a store that stores no block is not an escape.
 */
function storesRegionBlock(value: SemanticValue, held: ReadonlySet<string>, reach: Reach): boolean {
  return carriesRegionBlock(value) && ownsRegionBlock(value, held, reach);
}

/**
 * Whether a value is, or reaches, a block this turn allocated.
 *
 * A block is anything the turn made itself. A name holds one once a block has
 * been bound to it, and a call hands one back when the function it names builds
 * any — so a value that is neither, and reads no name that is, is nothing the
 * reuse would touch.
 *
 * A function that builds a block and does not hand it back is still read as
 * handing one back, which refuses more loops than are strictly necessary and
 * never fewer. That direction is the safe one: what this answers decides
 * whether a block is reused, and a block wrongly taken for reusable is a
 * program with a value overwritten under it.
 */
function ownsRegionBlock(value: SemanticValue, held: ReadonlySet<string>, reach: Reach): boolean {
  let found = false;
  walkValues(value, (inner) => {
    if (found) return;
    if (inner.k === "newObject") {
      found = true;
    } else if (inner.k === "buffer") {
      // A window into a block another name holds is not a block of its own, so
      // it is not the turn's to reuse. Every other array is: the runtime takes
      // every one of them from the region's cursor while a region is open, so an
      // array literal written in a turn is as much the turn's as an object is.
      found = inner.view === null;
    } else if (inner.k === "local" && held.has(inner.name)) {
      found = true;
    } else if (inner.k === "call" && calleeBuilds(inner.call.callee, reach)) {
      found = true;
    }
  });
  return found;
}

/**
 * Whether a function builds a block of its own.
 *
 * A function called from a thousand turns is read once, and recursion is broken
 * by assuming. The assumption here is that a function reaching itself builds
 * nothing while its own body is still being read. That is the safe direction:
 * the answer decides whether a block is reused, so answering "no" admits fewer
 * blocks into the turn's own — it never lets a block that outlives its turn be
 * taken for one that does not. Answering the other way for a function that
 * reaches itself would let its blocks out, which is why this says false and not
 * true.
 *
 * A function that writes a block in its answer builds it, and a block written
 * in its return is written all the same — the ordinary way to write a factory is
 * `return { ... }`, so reading only the statements of its blocks reads every
 * factory as building nothing. What it calls is read the same way, or a factory
 * that delegates to another is read as building nothing either.
 */
function calleeBuilds(name: string, reach: Reach): boolean {
  const known = reach.makes.get(name);
  if (known !== undefined) return known;
  const callee = reach.callees.get(name);
  // A body nobody has read may build. A call through a closure is one: the
  // value it calls is a function this build resolved but cannot name here, and
  // what it answers may be a block the turn has to keep. A builtin is the
  // compiler's own and is taken to build nothing.
  if (callee === undefined) return builtinFor(name) === null;
  if (reach.reading.has(name)) return false;
  reach.reading.add(name);
  let builds = false;
  for (const block of blocksWithin(callee.entry)) {
    if (block.terminator.k === "return" && block.terminator.value !== null) {
      walkValues(block.terminator.value, (inner) => {
        if (builds) return;
        if (inner.k === "newObject") builds = true;
        else if (inner.k === "call") builds = calleeBuilds(inner.call.callee, reach);
      });
    }
    for (const statement of block.statements) {
      if (builds) break;
      for (const value of statementValues(statement)) {
        walkValues(value, (inner) => {
          if (builds) return;
          if (inner.k === "newObject") builds = true;
          else if (inner.k === "call") builds = calleeBuilds(inner.call.callee, reach);
        });
      }
    }
    if (builds) break;
  }
  reach.reading.delete(name);
  reach.makes.set(name, builds);
  return builds;
}

/**
 * Whether a function stores or hands back anything it was given.
 *
 * This is the other half of the same question, and it is what lets a turn pass
 * a block it made to a function that only reads it: `checksum` walks a tree and
 * hands back a number, so the tree is still the turn's afterwards. A function
 * this build does not hold is a body nobody has read, and an unread body is
 * taken to keep everything.
 */
function calleeKeepsNothing(name: string, reach: Reach): boolean {
  const known = reach.keeps.get(name);
  if (known !== undefined) return known;
  const callee = reach.callees.get(name);
  if (callee === undefined) return false;
  if (reach.reading.has(name)) return true;
  reach.reading.add(name);
  const keeps = keepsWhatItIsGiven(callee, reach);
  reach.reading.delete(name);
  reach.keeps.set(name, keeps);
  return !keeps;
}

/**
 * Whether a function puts anything it was handed somewhere that outlives the
 * call.
 *
 * A function has no names but its own, so a block it builds can only escape by
 * being written into something it was given — a buffer, a field, a name it
 * found — or by being handed back. That is the whole list.
 */
function keepsWhatItIsGiven(callee: SemanticFunction, reach: Reach): boolean {
  // What the function was given, and everything a name of its own now holds
  // because it was given it. A block it built itself is not in here: it dies
  // with the call unless it is handed back, which is read below.
  const given = new Set(callee.params.map((param) => param.name));
  const declared = new Set<string>();
  const holdsGiven = (value: SemanticValue): boolean => {
    let found = false;
    walkValues(value, (inner) => {
      if (inner.k === "local" && given.has(inner.name)) found = true;
    });
    return found;
  };

  // A call the function was handed a block as an argument hands it on whoever
  // receives it, whatever the call is written as. `let kept = store(node)` is
  // as much a place the block lands as `store(node);` is, and the check this
  // holds was below the `continue` the `let` case returns through — so the one
  // form its own comment names was the one form never read, and a callee whose
  // only hand-off was a bound call was answered as keeping nothing. The loop
  // above it marks its loop for a reuse that hands the block straight back out
  // of the region.
  const handsOn = (value: SemanticValue): boolean => {
    let handed = false;
    walkValues(value, (inner) => {
      if (handed || inner.k !== "call") return;
      if (inner.call.args.some(holdsGiven) && !calleeKeepsNothing(inner.call.callee, reach)) handed = true;
    });
    return handed;
  };

  for (const block of blocksWithin(callee.entry)) {
    for (const statement of block.statements) {
      if (statement.k === "let") {
        declared.add(statement.slot.name);
        // Any binding of what the function was given is an alias of it, and
        // which slot kind it was written as does not change that. `const copy =
        // node;` is an `object` slot rather than a `value` one, and reading
        // only the value bindings missed every reference alias — so a callee
        // that kept the caller's block through one was answered as keeping
        // nothing, and the loop above it was marked for a reuse that would
        // write over a block the caller still holds.
        if (holdsGiven(statement.value)) given.add(statement.slot.name);
        // The hand-off below is read here as well. The `continue` used to skip
        // it, and the comment above it named this very form.
        if (handsOn(statement.value)) return true;
        continue;
      }
      for (const value of statementValues(statement)) {
        if (handsOn(value)) return true;
      }
      switch (statement.k) {
        case "set":
          // A name of its own is as safe as anything else; a name it found is
          // somewhere the caller can still be holding the block it was given.
          if (!declared.has(statement.name) && holdsGiven(statement.value)) return true;
          break;
        case "setElement":
        case "fill":
          if (!declared.has(statement.buffer) && holdsGiven(statement.value)) return true;
          break;
        case "storeField":
          // Writing into an object it was given puts the block where the owner
          // of that object still finds it, and so does writing something it was
          // given into an object of any other kind: only an object built in
          // this very statement is the function's own.
          if (holdsGiven(statement.object)) return true;
          if (holdsGiven(statement.value) && statement.object.k !== "newObject") return true;
          break;
        case "retain":
          if (holdsGiven(statement.value)) return true;
          break;
        default:
          break;
      }
    }
    // A value that is not a reference carries no block at all, so a function
    // answering with one cannot be handing back what it was given however many
    // reads of the given its answer is computed from. This is what keeps
    // `checksum` out of the escape list: it reads a field out of the tree it
    // was given and answers `1 + left + right`, a number, and a walk of that
    // answer reaches `node` through every `loadField` in it. Reading the given
    // is not keeping it; only naming it as the answer is.
    if (
      block.terminator.k === "return" &&
      block.terminator.value !== null &&
      carriesRegionBlock(block.terminator.value) &&
      holdsGiven(block.terminator.value)
    ) {
      return true;
    }
    // A call written in the answer hands the block on whoever receives it, so
    // answering `store(node)` is as much a place the block lands as calling it
    // and handing the answer back.
    if (block.terminator.k === "return" && block.terminator.value !== null) {
      let handsOn = false;
      walkValues(block.terminator.value, (inner) => {
        if (handsOn || inner.k !== "call") return;
        if (inner.call.args.some(holdsGiven) && !calleeKeepsNothing(inner.call.callee, reach)) handsOn = true;
      });
      if (handsOn) return true;
    }
  }
  return false;
}
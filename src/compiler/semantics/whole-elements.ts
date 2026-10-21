/**
 * Whole-number arithmetic for a loop over a buffer whose every element is a
 * whole number.
 *
 * A program of this language counts in doubles, and a loop over the limbs of a
 * field value pays for it in a way nothing else in the program does. The whole
 * of the cost of one turn of a modular addition is the carry, and the carry is
 * a chain: `sum = a[i] + b[i] + carry; whole = Math.floor(sum / 2**24);
 * o[i] = sum - whole * 2**24; carry = whole` is eleven limbs where every turn
 * waits on the one before it, and on the machines this compiler targets `addsd`
 * is four cycles, the multiply that scales it is four, and the `roundsd` that
 * floors it is eight — sixteen cycles a limb, and every one of them on the chain.
 * The arithmetic is not where the time goes. The chain is.
 *
 * The chain is the same chain whether the numbers are doubles or whole numbers,
 * and computed as whole numbers it is two cycles long: an addition, and a shift
 * that carries the carry down. That is an eightfold shortening of the one part of
 * the turn nothing else is waiting on, and it is the whole of what this pass is
 * for.
 *
 * It is sound under two facts, and both are questions about a whole program
 * rather than about one loop.
 *
 * The first is what the buffers hold. Every element a loop reads has to be a
 * whole number, or the whole-number form answers a different number: read as a
 * whole number, `1.5` is `1`, and the loop would carry `1` where the program
 * wrote three quarters. So the pass asks of the program whether every element
 * of every buffer is one, which is a question about every write into every
 * buffer and about every call site of every function.
 *
 * The second is how large those whole numbers are, and it is what separates
 * this from the narrowing `whole-numbers.ts` does. That one asks its question
 * of the arguments of a call and guards the answer at run time, because its
 * arguments come from anywhere. These buffers come from the program — every one
 * is a buffer the program allocated, or a parameter every call site hands one of
 * those — so a bound is a fact about the program and needs no guard. What it
 * does need is for the double form and the whole-number form to be the same
 * number, and that is what the bound is for: every value below it is held
 * exactly by a double, and above it the two part company.
 *
 * A bound is proved as an invariant rather than described. "Every element of
 * this buffer is within ±R" holds at every point of the program if it holds of
 * what the buffer starts as and every write into it lands within R, where every
 * value a write computes is read out of buffers whose own bound is already
 * established. That is a fixpoint read upwards from the start, and it is sound
 * because it is exactly the hypothesis of an induction over the program's own
 * execution: a write whose value cannot be brought within R is what grows R, and
 * a buffer whose R grows past the reach the two forms agree at is left alone.
 *
 * The shape of the loop is a condition too, and a narrow one. A body of
 * declarations, element writes and writes of names is a body whose values this
 * pass can rebuild one at a time; a body with a conditional in it is a body
 * whose values it would have to move between blocks, and moving a value is
 * another program. So the body has to be a chain, and the rest of the function
 * is left exactly as the source wrote it — which is sound because the loop is
 * the only thing whose arithmetic changes, and every value it leaves behind is
 * a whole number.
 *
 * Nothing else about the function is retyped. An element cannot be read at
 * another width — `narrowsTo` refuses a double read as a whole number, because
 * that is the fraction dropped — so a value built out of elements is left as the
 * source built it and bound to a name of its own at the whole width, which is
 * where the machine's own conversion of it is written down. The arrays stay the
 * arrays the program declared, every signature is the one it was declared with,
 * and a read of one of the names the loop made whole from anywhere else is the
 * widening the IR already keeps.
 */

import {
  isFloat,
  isInteger,
  isSequence,
  statementValues,
  type SemanticBlock,
  type SemanticCall,
  type SemanticFunction,
  type SemanticSlot,
  type SemanticStatement,
  type SemanticType,
  type SemanticValue,
} from "../core/semantic-ir.ts";

/** The type a whole number is held at. */
const WHOLE: SemanticType = { kind: "primitive", name: "i64" };

/**
 * The largest magnitude an element may reach and the whole-number form of a loop
 * over it still be the number the program wrote.
 *
 * A whole-number form computes `sum = a[i] + b[i] + carry` and
 * `whole = sum >> 24`, so every value it makes is under twice the reach the
 * buffers are asked for, and `whole * 2**24` is under twice the reach again. A
 * reach of 2^51 therefore leaves every intermediate below 2^53, which is where a
 * double stops holding a whole number exactly.
 *
 * It is three orders of magnitude above what the loops this answers need: a limb
 * of a field value is twenty-four bits, so a reach this loose is a statement
 * about the arithmetic rather than about the program.
 */
const REACH = 2 ** 51;

/** What nothing in the program bounds. */
const UNBOUNDED = Number.POSITIVE_INFINITY;

/* -------------------------------------------------------------------------- */
/* Literals                                                                    */
/* -------------------------------------------------------------------------- */

/** The number a whole literal spells, or null where it is not one. */
function wholeNumber(text: string): number | null {
  const trimmed = text.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) return null;
  const number = Number(trimmed);
  return Number.isSafeInteger(number) ? number : null;
}

/** The number a floating point literal spells, and whether it is a whole one. */
function doubleNumber(text: string): { value: number; whole: boolean } | null {
  const asWhole = wholeNumber(text);
  if (asWhole !== null) return { value: asWhole, whole: true };
  const trimmed = text.trim();
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? { value, whole: Number.isInteger(value) } : null;
}

/** What a literal spells, and whether it is a whole number, whatever it is written at. */
function literalOf(value: SemanticValue): { value: number; whole: boolean } | null {
  if (value.k !== "const") return null;
  if (isFloat(value.type)) return doubleNumber(value.text);
  // A whole number is a whole number whatever it is written at, and a loop the
  // resolver counted is written at a whole width: reading only the floating point
  // spelling of a literal would answer nothing for the ends of every counter it
  // itself narrowed.
  if (!isInteger(value.type)) return null;
  const number = wholeNumber(value.text.replace(/n$/, ""));
  return number === null ? null : { value: number, whole: true };
}

/** The number of places a value is a whole literal, or null where it is not one. */
function placesOf(value: SemanticValue): number | null {
  const literal = literalOf(value);
  if (literal === null || !literal.whole || literal.value < 0 || literal.value > 63) return null;
  return literal.value;
}

/** The number of places a value is a power of two, or null where it is not one. */
function exponentOf(value: SemanticValue): number | null {
  const literal = literalOf(value);
  if (literal === null || !literal.whole || literal.value < 1 || literal.value > 2 ** 52) return null;
  return (literal.value & (literal.value - 1)) === 0 ? Math.log2(literal.value) : null;
}

/* -------------------------------------------------------------------------- */
/* The program, as the two questions read it                                   */
/* -------------------------------------------------------------------------- */

/** One parameter of a function that is a buffer, and where it sits. */
interface Sequence {
  /** The place it sits at in the function's own parameters, which is the argument it is read at. */
  readonly at: number;
  /** The name it is declared and handed over as. */
  readonly name: string;
}

/** One body of the program, and what it is. */
interface Body {
  /** The name it is compiled and called under, or null for the program's own. */
  readonly fn: string | null;
  readonly entry: SemanticBlock;
  /** Every parameter it declares that is a buffer, in the order they are declared. */
  readonly sequences: readonly Sequence[];
  /** Every buffer parameter of every function it calls, by the name it calls it. */
  readonly sequencesByCallee: ReadonlyMap<string, readonly Sequence[]>;
}

/** Every block a statement holds of its own. */
function blocksOf(statement: SemanticStatement): readonly SemanticBlock[] {
  if (statement.k === "if") return statement.otherwise === null ? [statement.then] : [statement.then, statement.otherwise];
  if (statement.k === "loop") return [statement.loop.body];
  if (statement.k === "block") return [statement.body];
  return [];
}

/** Every call of the program a value makes, under the values it is built from. */
function callsUnder(value: SemanticValue, into: SemanticCall[]): void {
  switch (value.k) {
    case "call":
      into.push(value.call);
      for (const argument of value.call.args) callsUnder(argument, into);
      return;
    case "text":
      for (const part of value.parts) if (part.k === "value") callsUnder(part.value, into);
      return;
    case "length":
    case "toText":
      callsUnder(value.of, into);
      return;
    case "isNull":
    case "unary":
      callsUnder(value.operand, into);
      return;
    case "element":
      callsUnder(value.of, into);
      callsUnder(value.index, into);
      return;
    case "argv":
      if (value.index !== null) callsUnder(value.index, into);
      return;
    case "arith":
    case "compare":
    case "logical":
    case "coalesce":
      callsUnder(value.left, into);
      callsUnder(value.right, into);
      return;
    case "buffer":
      if (value.count !== null) callsUnder(value.count, into);
      if (value.view !== null) {
        callsUnder(value.view.of, into);
        callsUnder(value.view.offset, into);
      }
      for (const element of value.values) callsUnder(element, into);
      return;
    case "loadField":
      callsUnder(value.object, into);
      return;
    case "newObject":
      for (const field of value.fields) callsUnder(field.value, into);
      return;
    case "select":
      callsUnder(value.condition, into);
      callsUnder(value.then, into);
      callsUnder(value.otherwise, into);
      return;
    default:
      return;
  }
}

/** The buffer parameters every function of a program declares, by its name. */
function sequencesOf(functions: readonly SemanticFunction[]): ReadonlyMap<string, readonly Sequence[]> {
  const sequences = new Map<string, readonly Sequence[]>();
  for (const fn of functions) {
    sequences.set(
      fn.name,
      fn.params.flatMap((param, at) => (param.kind === "value" && isSequence(param.type) ? [{ at, name: param.name }] : [])),
    );
  }
  return sequences;
}

/** The body of a function, as the questions read it. */
function bodyOf(
  fn: SemanticFunction | null,
  entry: SemanticBlock,
  sequencesByCallee: ReadonlyMap<string, readonly Sequence[]>,
): Body {
  const declared = fn?.name ?? null;
  return {
    fn: declared,
    entry,
    sequences: declared === null ? [] : (sequencesByCallee.get(declared) ?? []),
    sequencesByCallee,
  };
}

/** Every call of the program one statement makes, whether at the top or in a value. */
function callsOf(statement: SemanticStatement): readonly SemanticCall[] {
  const calls: SemanticCall[] = [];
  if (statement.k === "call") calls.push(statement.call);
  for (const value of statementValues(statement)) callsUnder(value, calls);
  return calls;
}

/* -------------------------------------------------------------------------- */
/* What a value is                                                             */
/* -------------------------------------------------------------------------- */

/** What the analysis holds about a value. */
interface Known {
  /** Whether the value is a whole number. */
  readonly whole: boolean;
  /** The largest it reaches, or `Infinity` where nothing bounds it. */
  readonly reach: number;
  /**
   * Where the value is a number brought down by these places from that dividend,
   * and null where it is not one.
   *
   * The compiler names what the source computed, so the quotient a floor is taken
   * of is read out of a name rather than out of the value the name holds, and
   * the name is what a subtraction beside it has to be compared against: it is
   * the only way `o[i] = sum - whole * 2**24` is recognised as the remainder it
   * is when the source wrote `whole` between the two.
   */
  readonly reduced: { readonly places: number; readonly dividend: SemanticValue } | null;
}

/** What nothing in the program states about a value. */
const unknown: Known = { whole: false, reach: UNBOUNDED, reduced: null };

/** A slot that holds a number, which is the one this pass re-types. */
type ValueSlot = Extract<SemanticSlot, { kind: "value" }>;

/** What the analysis knows about the name a value reads, and the buffers beside it. */
interface Where {
  /** What each name the body has declared holds, in the order it declared them. */
  readonly locals: Map<string, Known>;
  /** The body this value is written in, which is what a parameter is asked of. */
  readonly fn: string | null;
  /** What every buffer and parameter of the program holds, as this round read it. */
  readonly facts: ReadonlyMap<string, Known>;
}

/**
 * What the analysis knows about a value.
 *
 * This is the whole of it, and the rewrite asks it as well as the two questions:
 * a loop is one every value of which answers a whole number within the reach, and
 * a buffer's bound is this over every write into it.
 *
 * The one shape it answers that ordinary arithmetic does not is the remainder.
 * `x - Math.floor(x / 2**k) * 2**k` is under `2**k` whatever `x` is, and that
 * is what lets the loops of a modular addition converge at all: a sum of two
 * limbs is twice a limb and the remainder of it is a limb again, so a bound that
 * only ever grew would bound nothing and the analysis would answer nothing.
 */
function knownOf(value: SemanticValue, where: Where): Known {
  switch (value.k) {
    case "const": {
      const literal = literalOf(value);
      return literal === null || !literal.whole ? unknown : { whole: true, reach: Math.abs(literal.value), reduced: null };
    }
    case "local":
      return where.locals.get(value.name) ?? unknown;
    case "element": {
      if (value.of.k !== "local") return unknown;
      return where.facts.get(nameOf(value.of.name, where.fn)) ?? unknown;
    }
    case "unary":
      return value.op === "neg" || value.op === "pos" ? knownOf(value.operand, where) : unknown;
    case "call":
      return knownOfCall(value.call, where);
    case "arith":
      return knownOfArithmetic(value, where);
    case "compare":
      // A comparison answers a truth, which the language reads as one or zero.
      return { whole: true, reach: 1, reduced: null };
    default:
      return unknown;
  }
}

/**
 * Whether a name is one of the four roundings the language spells, and which all
 * answer a whole number whatever they round.
 */
function isRounding(callee: string): boolean {
  return callee === "Math.floor" || callee === "Math.round" || callee === "Math.trunc" || callee === "Math.ceil";
}

/** What a call answers, for the ones the language spells that are about numbers. */
function knownOfCall(call: SemanticCall, where: Where): Known {
  if (!call.builtin) return unknown;
  const argument = call.args[0];
  if (argument === undefined) return unknown;
  if (call.callee === "Math.abs") return knownOf(argument, where);
  // A power of a whole number by a whole number of places is a whole number of
  // places, and its reach is the reach of the base raised to the reach of the
  // count: the only way a loop writing one of these stays bounded is the count
  // being bounded, so a count nothing bounds answers nothing.
  if (call.callee === "Math.pow") {
    const base = knownOf(argument, where);
    const count = call.args[1];
    if (count === undefined) return unknown;
    const places = knownOf(count, where);
    if (!base.whole || !places.whole || base.reach === 0 || places.reach === UNBOUNDED) return unknown;
    return { whole: true, reach: Math.max(1, base.reach) ** Math.ceil(places.reach), reduced: null };
  }
  if (!isRounding(call.callee)) return unknown;
  // Every rounding answers a whole number whatever it rounds. The reach of a
  // floor of a quotient by a power of two is the reach of the dividend brought
  // down by those places, and every other rounding is at most one more than
  // what it rounded — which is the difference between a bound that shrinks with
  // the limbs and one that does not, and the bound that shrinks is what lets a
  // carry be bounded at all.
  const divided = call.callee === "Math.floor" ? quotientOf(argument) : null;
  if (divided !== null) {
    const dividend = knownOf(divided.dividend, where);
    return dividend.whole
      ? {
          whole: true,
          reach: dividend.reach / 2 ** divided.places,
          reduced: { places: divided.places, dividend: divided.dividend },
        }
      : unknown;
  }
  const inside = knownOf(argument, where);
  return inside.whole ? { whole: true, reach: inside.reach + 1, reduced: null } : unknown;
}

/** The dividend and the number of places a value divides by a power of two. */
function quotientOf(value: SemanticValue): { dividend: SemanticValue; places: number } | null {
  if (value.k !== "arith" || value.op !== "div") return null;
  const places = exponentOf(value.right);
  return places === null ? null : { dividend: value.left, places };
}

/** What an arithmetic answers. */
function knownOfArithmetic(value: SemanticValue & { k: "arith" }, where: Where): Known {
  // The remainder comes first, because its answer does not read the sides: it is
  // the one shape whose bound is a fact about the operation rather than about
  // what was operated on.
  const remainder = remainderOf(value, where);
  if (remainder !== null) return remainder;
  const left = knownOf(value.left, where);
  const right = knownOf(value.right, where);
  if (!left.whole || !right.whole) return unknown;
  switch (value.op) {
    case "add":
    case "sub":
      return { whole: true, reach: left.reach + right.reach, reduced: null };
    case "mul": {
      // Multiplying a number brought down by places of a power of two back up by
      // that power of two is what makes it a subtraction's other side a
      // remainder, so the fact travels with it.
      const places = exponentOf(value.right);
      const reduced = left.reduced !== null && places !== null && left.reduced.places === places ? left.reduced : null;
      return { whole: true, reach: left.reach * right.reach, reduced };
    }
    case "shl": {
      const places = placesOf(value.right);
      const reduced = left.reduced !== null && places !== null && left.reduced.places === places ? left.reduced : null;
      return places === null ? unknown : { whole: true, reach: left.reach * 2 ** places, reduced };
    }
    case "shr":
      // A shift carries a value down, and what it carries down is bounded by
      // what it was carried from — a shift is where a carry stops growing.
      return { whole: true, reach: left.reach, reduced: null };
    default:
      // A quotient, a remainder, a power and the two extremal forms are not the
      // same arithmetic over whole numbers as over doubles, so a value built of
      // one is a value this pass does not claim to know.
      return unknown;
  }
}

/**
 * The bound a subtraction answers when it is a value taken back to its own
 * remainder, or null where it is not one.
 *
 * `x - Math.floor(x / 2**k) * 2**k` and `x - (x >> k) * 2**k` are the same
 * remainder written over doubles and over whole numbers, and it is under `2**k`
 * whatever `x` was. What is checked is the shape and not the sides: the sides
 * are a value the whole-number form has to know the reach of elsewhere, and the
 * reach of the remainder is not read out of them.
 */
function remainderOf(value: SemanticValue & { k: "arith" }, where: Where): Known | null {
  if (value.op !== "sub") return null;
  const scaled = shiftedDownOf(value.right, value.left, where);
  return scaled === null ? null : { whole: true, reach: 2 ** scaled - 1, reduced: null };
}

/**
 * The number of places a value is the dividend shifted back up by the number of
 * places it was shifted down, or null where it is not that.
 *
 * The three spellings are the same value: a whole number shifted down and left
 * up, and a dividend divided by a power of two, floored and multiplied back by
 * it. Which of the three a program wrote is a question about the source, and all
 * three are under the power of two whatever the dividend was.
 */
function shiftedDownOf(scaled: SemanticValue, dividend: SemanticValue, where: Where): number | null {
  // The name the source gave the quotient is what the compiler reads here: the
  // floor of a quotient is written down as a declaration of its own, so the
  // places it brought down and what it brought them down from are the places and
  // the dividend that declaration recorded.
  if (scaled.k === "local" && where.locals.get(scaled.name)?.reduced != null) {
    const reduced = where.locals.get(scaled.name)?.reduced ?? null;
    return reduced !== null && sameValue(reduced.dividend, dividend) ? reduced.places : null;
  }
  if (scaled.k === "call" && scaled.call.builtin && scaled.call.callee === "Math.floor") {
    const argument = scaled.call.args[0];
    const divided = argument === undefined ? null : quotientOf(argument);
    if (divided === null || !sameValue(divided.dividend, dividend)) return null;
    const places = exponentOf(scaledRight(argument as SemanticValue));
    return places !== null && places === divided.places ? places : null;
  }
  if (scaled.k === "arith" && scaled.op === "mul") {
    const places = exponentOf(scaled.right);
    if (places === null) return null;
    if (scaled.left.k === "arith" && scaled.left.op === "shr" && sameValue(scaled.left.left, dividend)) {
      const written = placesOf(scaled.left.right);
      return written === places ? places : null;
    }
    if (scaled.left.k === "call" && scaled.left.call.builtin && scaled.left.call.callee === "Math.floor") {
      const argument = scaled.left.call.args[0];
      const divided = argument === undefined ? null : quotientOf(argument);
      if (divided !== null && sameValue(divided.dividend, dividend) && divided.places === places) return places;
    }
    // The name the source gave the quotient, brought back up by the power of two
    // it was brought down by.
    if (scaled.left.k === "local") {
      const reduced = where.locals.get(scaled.left.name)?.reduced ?? null;
      if (reduced !== null && reduced.places === places && sameValue(reduced.dividend, dividend)) return places;
    }
    return null;
  }
  return null;
}

/** The divisor of a quotient, where the value is one. */
function scaledRight(quotient: SemanticValue): SemanticValue {
  return quotient.k === "arith" && quotient.op === "div" ? quotient.right : { k: "nothing", type: WHOLE };
}

/** Whether two values are the same value written twice, which a remainder needs. */
function sameValue(one: SemanticValue, other: SemanticValue): boolean {
  if (one.k !== other.k) return false;
  if (one.k === "local") return one.name === (other as { name: string }).name;
  if (one.k === "const") return literalOf(one)?.value === literalOf(other)?.value;
  if (one.k === "arith") {
    const left = one as { op: string; left: SemanticValue; right: SemanticValue };
    const right = other as { op: string; left: SemanticValue; right: SemanticValue };
    return left.op === right.op && sameValue(left.left, right.left) && sameValue(left.right, right.right);
  }
  return false;
}

/**
 * The reach the counter of a counted loop reaches, which is the reach of the two
 * ends it runs between.
 *
 * Reading the ends rather than naming the whole type is what lets a loop that
 * fills a table of powers be understood: `powers[bit] = Math.pow(2, bit)` holds
 * nothing but the two thousand and forty-eighth the loop ever reaches, and a
 * counter written down only as a whole number would bound nothing at all.
 */
function counterReach(loop: Extract<SemanticStatement, { k: "loop" }>["loop"] & { kind: "counted" }): number {
  const from = knownOf(loop.from, { locals: new Map(), fn: null, facts: new Map() }).reach;
  const to = knownOf(loop.to, { locals: new Map(), fn: null, facts: new Map() }).reach;
  return Math.max(from, to);
}

/** The key a name is asked and answered under, which is what it is a buffer of. */
function nameOf(name: string, fn: string | null): string {
  return fn === null ? `buffer:${name}` : `parameter:${fn}:${name}`;
}

/* -------------------------------------------------------------------------- */
/* The question, asked of a whole program                                      */
/* -------------------------------------------------------------------------- */

/** What every buffer and every sequence parameter of a program holds. */
interface Facts {
  /** The key each is asked under, and what it holds. */
  readonly held: ReadonlyMap<string, Known>;
  /** Every buffer parameter a function declares, by the name it is called. */
  readonly sequences: ReadonlyMap<string, readonly Sequence[]>;
}

/**
 * What every buffer and every sequence parameter of a program holds, asked of
 * every write into every buffer and every call site of every function, and
 * settled by reading the answer upwards until nothing moves.
 *
 * The two halves are read differently because they are asked differently.
 * Whether every element is a whole number is a conjunction over every write, so
 * it is settled downwards from "yes" — which is sound, because a fact that is
 * true and only ever taken away was never stronger than it was. How large they
 * are is a disjunction over every write, so it is settled upwards, and it is an
 * invariant rather than a description: what is proved is that every write lands
 * inside the bound, which is the hypothesis of an induction over the program's
 * own execution.
 */
function elementFacts(bodies: readonly Body[]): Facts {
  const sequences: ReadonlyMap<string, readonly Sequence[]> = bodies[0]?.sequencesByCallee ?? new Map();

  // The places the question is asked of: every buffer the program body declares,
  // and every sequence parameter of every function. A parameter is a buffer the
  // caller hands over, and it is kept apart from a buffer of the program body by
  // its spelling because the two may be written the same name.
  const held = new Map<string, Known>();
  for (const body of bodies) {
    if (body.fn !== null) {
      for (const one of body.sequences) held.set(nameOf(one.name, body.fn), { whole: true, reach: 0, reduced: null });
      continue;
    }
    for (const statement of body.entry.statements) {
      if (statement.k !== "let" || statement.slot.kind !== "buffer") continue;
      held.set(nameOf(statement.slot.name, null), initialOf(statement.value));
    }
  }

  // Every place a call site hands over as a parameter of the callee. What the
  // callee writes into that parameter is what the caller handed it, so a bound
  // read of the parameter is a bound the caller needs too — and without this
  // the two questions never meet, because the parameter's own bound comes from
  // the very buffers this is what pushes it back to. Reading it upwards is what
  // closes that loop into an induction over the program's own execution rather
  // than a descent: the rounds below carry it round as many times as it takes.
  const handed = new Map<string, Set<string>>();
  for (const body of bodies) {
    const reachCalls = (block: SemanticBlock): void => {
      for (const statement of block.statements) {
        for (const call of callsOf(statement)) {
          const names = body.sequencesByCallee.get(call.callee);
          if (names === undefined) continue;
          for (const one of names) {
            const argument = call.args[one.at];
            if (argument === undefined || argument.k !== "local") continue;
            const given = nameOf(one.name, call.callee);
            const found = handed.get(given) ?? new Set<string>();
            found.add(nameOf(argument.name, body.fn));
            handed.set(given, found);
          }
        }
        for (const nested of blocksOf(statement)) reachCalls(nested);
      }
    };
    reachCalls(body.entry);
  }

  /**
   * What one place holds, read into every place that place is a parameter of.
   *
   * The places a bound has to reach are closed under the call graph, and closing
   * them in one step of the recursion rather than leaving it to the rounds is
   * what makes the answer an induction: a buffer handed to a function is bounded
   * by everything that function writes into it, and a parameter is bounded by
   * every buffer it is handed, and one bound read of the two is one bound.
   */
  const spread = (key: string, value: Known, seen: Set<string>): boolean => {
    if (seen.has(key)) return false;
    seen.add(key);
    const before = held.get(key);
    if (before === undefined) return false;
    let moved = false;
    if (!value.whole && before.whole) {
      held.set(key, unknown);
      moved = true;
    } else if (value.whole && before.whole && value.reach > before.reach) {
      held.set(key, { whole: true, reach: value.reach, reduced: null });
      moved = true;
    } else if (!value.whole || !before.whole) {
      return false;
    }
    for (const given of handed.get(key) ?? []) if (spread(given, value, seen)) moved = true;
    return moved;
  };

  // The rounds stop when one of them proves nothing new, and also when there
  // have been more of them than any program needs. A fixpoint the rounds did not
  // reach is a weaker answer than the program would have given — a fact is only
  // ever read into a place whose premises already hold — so stopping early
  // leaves a program this pass rewrites less of and never one it rewrites wrong.
  for (let round = 0; round < 16; round += 1) {
    const facts: Facts = { held: new Map(held), sequences };
    let moved = false;
    // One read of the whole program per round, each body read in the order it is
    // written so that a name is asked about with what has been written into it
    // by then. The writes and the call sites are read together because they are
    // answered by the same walk: an argument a call site hands over is a name of
    // the body it is in, and a buffer the body allocated is one of its names too.
    for (const body of bodies) {
      const where: Where = { locals: new Map(), fn: body.fn, facts: facts.held };
      readBody(body, where, (key, value) => {
        if (spread(key, { whole: value.whole, reach: within(value.reach), reduced: null }, new Set())) moved = true;
      });
    }
    if (!moved) break;
  }

  const answer: Facts = { held, sequences };
  // The reach the two forms agree at is a gate on the answer rather than on the
  // proof: a buffer whose bound the rounds pushed past it is one this pass does
  // not rewrite a loop over, and saying so here is what keeps a loop from being
  // rewritten against a bound nothing holds.
  for (const [key, value] of held) held.set(key, { whole: value.whole, reach: within(value.reach), reduced: null });
  return answer;
}

/**
 * The buffer a conditional subtraction reduces, and the number of places it
 * reduces it by, or null where the conditional is not one.
 *
 * The shape is the one a modular reduction is written in every time: the value
 * is written back as itself when it is already where it belongs and is brought
 * back by a power of two when it is below it. What comes out is under the power
 * of two and below it, and both arms say so — the one that added and the one
 * that did not — which is a fact about the reduction rather than about the
 * values on either side of it.
 */
function reductionOf(statement: Extract<SemanticStatement, { k: "if" }>): { buffer: string; places: number } | null {
  if (statement.condition.k !== "compare" || (statement.condition.op !== "lt" && statement.condition.op !== "le")) return null;
  if (statement.condition.right.k !== "const" || literalOf(statement.condition.right)?.value !== 0) return null;
  if (statement.condition.left.k !== "local" || statement.otherwise === null) return null;
  const value = statement.condition.left.name;
  const brought = reductionArm(statement.then, value);
  // The arm that adds the power of two back and the arm that leaves the value
  // alone have to be one reduction rather than two writes, and what says so is
  // that they write the same element.
  if (brought === null || brought.places === null) return null;
  const kept = reductionArm(statement.otherwise, value);
  if (kept === null || kept.places !== null || kept.buffer !== brought.buffer) return null;
  if (!sameValue(kept.index, brought.index)) return null;
  return { buffer: brought.buffer, places: brought.places };
}

/** One arm of a conditional subtraction: what it writes, and the places it brings back. */
function reductionArm(arm: SemanticBlock, value: string): { buffer: string; index: SemanticValue; places: number | null } | null {
  let found: { buffer: string; index: SemanticValue; places: number | null } | null = null;
  for (const statement of arm.statements) {
    if (statement.k !== "setElement") continue;
    const written = statement.value;
    if (found !== null) return null;
    if (written.k === "local" && written.name === value) {
      found = { buffer: statement.buffer, index: statement.index, places: null };
      continue;
    }
    const places =
      written.k === "arith" && written.op === "add" && written.left.k === "local" && written.left.name === value
        ? exponentOf(written.right)
        : null;
    if (places === null) return null;
    found = { buffer: statement.buffer, index: statement.index, places };
  }
  return found;
}

/**
 * One body read in the order it is written, asking about every element write it
 * makes and every argument it hands a call site.
 *
 * A name a body declares is asked of the value it was bound to, so the walk
 * carries what each name holds as it goes — which is what makes an argument a
 * call site is read at the value the body had at that point and not at the one
 * it had at the end.
 */
function readBody(
  body: Body,
  where: Where,
  answer: (key: string, value: Known) => void,
  skip: ReadonlySet<string> = new Set(),
): void {
  // A buffer the program allocated and a sequence parameter of a function are the
  // two kinds of name whose value is a place in memory rather than a number, and
  // both are asked of what the facts hold for them.
  for (const one of body.sequences) where.locals.set(one.name, where.facts.get(nameOf(one.name, body.fn)) ?? unknown);
  const walk = (block: SemanticBlock, skip: ReadonlySet<string>): void => {
    for (const statement of block.statements) {
      if (statement.k === "let" && statement.slot.kind === "value") {
        where.locals.set(statement.slot.name, knownOf(statement.value, where));
      } else if (statement.k === "let" && statement.slot.kind === "buffer") {
        where.locals.set(statement.slot.name, where.facts.get(nameOf(statement.slot.name, body.fn)) ?? unknown);
      } else if (statement.k === "set") {
        const before = where.locals.get(statement.name);
        const value = knownOf(statement.value, where);
        where.locals.set(
          statement.name,
          before === undefined || !value.whole
            ? value
            : { whole: true, reach: Math.max(before.reach, value.reach), reduced: value.reduced ?? before.reduced },
        );
      } else if (statement.k === "setElement") {
        // A write is asked of the buffer it writes, which is a name of this body
        // if the body declares one and a parameter if it was handed one — unless
        // the write is one arm of a reduction already asked of as a reduction,
        // which is the only way the two arms of one can be asked of together.
        if (!skip.has(statement.buffer)) answer(nameOf(statement.buffer, body.fn), knownOf(statement.value, where));
      } else if (statement.k === "if") {
        // A conditional subtraction is a reduction to a range, and reading its
        // two arms as two writes says nothing of the sort: the value the arm
        // that adds brings back is the value the arm that does not add already
        // was, so the two arms land in the same range where the bound a plain
        // sum of two reads would give says the range is twice as wide and grows
        // every round until there is none.
        const reduction = reductionOf(statement);
        if (reduction !== null) {
              answer(nameOf(reduction.buffer, body.fn), { whole: true, reach: 2 ** reduction.places - 1, reduced: null });
          // The arms of the reduction are walked for everything else they do,
          // and not for the writes that made it a reduction.
          const inside = new Set(skip);
          inside.add(reduction.buffer);
          for (const arm of blocksOf(statement)) walk(arm, inside);
          continue;
        }
      } else if (statement.k === "loop" && statement.loop.kind === "counted") {
        where.locals.set(statement.loop.variable, { whole: true, reach: counterReach(statement.loop), reduced: null });
      } else if (statement.k === "loop" && statement.loop.kind === "each") {
        where.locals.set(statement.loop.index, { whole: true, reach: REACH, reduced: null });
      }
      for (const call of callsOf(statement)) {
        const names = body.sequencesByCallee.get(call.callee);
        if (names === undefined) continue;
        for (const one of names) {
          const argument = call.args[one.at];
          answer(nameOf(one.name, call.callee), argument === undefined ? unknown : knownOf(argument, where));
        }
      }
      for (const nested of blocksOf(statement)) walk(nested, skip);
    }
  };
  walk(body.entry, skip);
}

/** A reach a whole-number form may be reached with, or nothing at all. */
function within(reach: number): number {
  return Number.isFinite(reach) && reach <= REACH ? reach : UNBOUNDED;
}

/** What a buffer the program declared starts out holding. */
function initialOf(value: SemanticValue): Known {
  if (value.k !== "buffer") return unknown;
  // A typed array is zeroed where it is allocated, so the length it is allocated
  // with is not a bound on it and the absence of one is not the absence of a
  // bound: a buffer written out with a length and a buffer allocated to a count
  // both start as the zeros. A view is the one buffer whose start is another
  // buffer's contents, and a buffer whose start this pass cannot see is a buffer
  // it may not bound.
  if (value.view !== null) return unknown;
  if (value.values.length === 0) {
    return value.length !== null || value.count !== null ? { whole: true, reach: 0, reduced: null } : unknown;
  }
  const where: Where = { locals: new Map(), fn: null, facts: new Map() };
  let reach = 0;
  for (const element of value.values) {
    const known = knownOf(element, where);
    if (!known.whole) return unknown;
    reach = Math.max(reach, known.reach);
  }
  return { whole: true, reach, reduced: null };
}

/* -------------------------------------------------------------------------- */
/* The rewrite                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Computes the arithmetic of a loop over whole numbers in whole numbers, for
 * every loop of a program whose buffers hold whole numbers within a reach the two
 * forms agree at.
 *
 * Every body is read before any is rewritten, because whether a loop may be
 * rewritten is a question about the buffers it reads, and those are a question
 * about the whole program.
 *
 * A body named in `leave` is not rewritten. The rewrite reads the elements of a
 * buffer as whole numbers, which is the same number only where the elements
 * are whole numbers, and the checker runs a function with vectors of its own:
 * a vector holds the values the declared type allows, and those are not the
 * program's buffers. So a function the checker runs with vectors is left as the
 * source wrote it.
 */
export function wholeElementArithmetic(
  functions: readonly SemanticFunction[],
  entry: SemanticBlock | null,
  leave: ReadonlySet<string> = new Set(),
): SemanticBlock | null {
  if (functions.length === 0 && entry === null) return entry;
  const sequencesByCallee = sequencesOf(functions);
  const bodies: Body[] = [];
  for (const fn of functions) bodies.push(bodyOf(fn, fn.entry, sequencesByCallee));
  if (entry !== null) bodies.push(bodyOf(null, entry, sequencesByCallee));
  const facts = elementFacts(bodies);
  // The elements of a program are walked under names this pass makes up, and the
  // counter is per function so that the two functions of a program cannot be
  // given the same one.
  const named = new Map<string, number>();
  for (const body of bodies) {
    if (body.fn !== null && leave.has(body.fn)) continue;
    const fresh = (): string => {
      const at = (named.get(body.fn ?? "") ?? 0) + 1;
      named.set(body.fn ?? "", at);
      return `blaze_limb_${at}`;
    };
    rewriteBody(body, facts, fresh);
  }
  return entry;
}

/** One body, with the names it declares and what they hold. */
function rewriteBody(body: Body, facts: Facts, fresh: () => string): void {
  const slots = new Map<string, SemanticSlot>();
  const locals = new Map<string, Known>();
  const where: Where = { locals, fn: body.fn, facts: facts.held };
  // A parameter of a sequence type is a buffer, and what it holds is what the
  // facts say about it; a parameter of any other type is a number this pass only
  // claims what the source declared about it.
  for (const one of body.sequences) locals.set(one.name, facts.held.get(nameOf(one.name, body.fn)) ?? unknown);
  walk(body.entry, where, slots, fresh);
}

/** Every block of a body, with the names and the slots the blocks above declared. */
function walk(block: SemanticBlock, where: Where, slots: Map<string, SemanticSlot>, fresh: () => string): void {
  for (const statement of block.statements) {
    if (statement.k === "let" && statement.slot.kind === "value") {
      slots.set(statement.slot.name, statement.slot);
      where.locals.set(statement.slot.name, knownOf(statement.value, where));
    } else if (statement.k === "loop" && statement.loop.kind === "counted") {
      rewriteLoop(statement.loop, where, slots, fresh);
    }
    for (const nested of blocksOf(statement)) walk(nested, where, slots, fresh);
  }
}

/**
 * Whether a body is a chain of whole numbers within the reach the two forms agree
 * at, and which of its names the whole-number form may read as whole numbers.
 *
 * A name the body binds is one, and a name it writes is one — the second turn of
 * a loop reads what the first left, so a carry written on every turn is a whole
 * number from the first turn on. A name the loop writes on more than one turn
 * holds the largest of what it was given, and one it writes once holds what this
 * turn gave it.
 */
function wholeNumbersOf(
  body: SemanticBlock,
  inside: Where,
  whole: Set<string>,
  slots: ReadonlyMap<string, SemanticSlot>,
): boolean {
  for (const statement of body.statements) {
    if (statement.k === "if") {
      // A reduction's conditional arms are each one chain and write the same
      // whole number along either path. Tallying them here puts the borrow loop
      // into the pass, because the body is not one chain only in syntax; the
      // `if` is a selector between two equally whole expressions, and both
      // write the same names. An arm that cannot be read gives up through
      // `knownOf`, which returns false for anything the `where` cannot hold
      // whole.
      if (reductionOf(statement) === null) return false;
      const condKnown = knownOf(statement.condition, inside);
      if (!condKnown.whole || !(condKnown.reach <= REACH)) return false;
      for (const arm of blocksOf(statement)) {
        for (const nested of arm.statements) {
          if (nested.k !== "let" && nested.k !== "set" && nested.k !== "setElement") return false;
          const nestedKnown = knownOf(nested.value, inside);
          if (!nestedKnown.whole || !(nestedKnown.reach <= REACH)) return false;
          const nestedName = nameWrittenBy(nested);
          if (nestedName === null) continue;
          whole.add(nestedName);
          const before = inside.locals.get(nestedName);
          const slot = slots.get(nestedName);
          const across = slot !== undefined && slot.kind === "value" && !isFloat(slot.type);
          inside.locals.set(
            nestedName,
            before !== undefined && before.whole && across
              ? { whole: true, reach: Math.max(before.reach, nestedKnown.reach), reduced: null }
              : nestedKnown,
          );
        }
      }
      continue;
    }
    if (statement.k !== "let" && statement.k !== "set" && statement.k !== "setElement") return false;
    const name = nameWrittenBy(statement);
    if (name === null && statement.k !== "setElement") return false;
    const known = knownOf(statement.value, inside);
    if (!known.whole || !(known.reach <= REACH)) return false;
    if (name === null) continue;
    whole.add(name);
    const before = inside.locals.get(name);
    const slot = slots.get(name);
    const across = slot !== undefined && slot.kind === "value" && !isFloat(slot.type);
    inside.locals.set(
      name,
      before !== undefined && before.whole && across
        ? { whole: true, reach: Math.max(before.reach, known.reach), reduced: null }
        : known,
    );
  }
  return whole.size > 1;
}

/** The name a statement writes in the body of a loop, or null where it writes none. */
function nameWrittenBy(statement: SemanticStatement): string | null {
  if (statement.k === "let" && statement.slot.kind === "value" && isFloat(statement.slot.type)) return statement.slot.name;
  if (statement.k === "set") return statement.name;
  return null;
}

/**
 * One counted loop, computed in whole numbers where every value of it is a whole
 * number the buffers hold, and left as the source wrote it otherwise.
 *
 * The body has to be a chain: declarations, element writes and writes of names.
 * An arm in it would put a value in a block this pass cannot see the whole of,
 * and moving a value between blocks is another program — which is what the head
 * of this file says about a body that is not a chain, and what the loop it does
 * not rewrite is left as.
 */
function rewriteLoop(
  loop: Extract<SemanticStatement, { k: "loop" }>["loop"] & { kind: "counted" },
  where: Where,
  slots: Map<string, SemanticSlot>,
  fresh: () => string,
): void {
  const body = loop.body;
  // A counter this pass reads as a whole number has to hold whole numbers: a
  // loop that counts in fractions — `for (let i = 0.5; i < n; i++)` — holds a
  // counter that is not a whole number, and reading it as one answered with a
  // number the program never wrote. What the counter holds is what the value
  // it starts at and the value it moves by say, and not the width it is
  // declared at: a counter a program counts in fractions with is a double and
  // holds whole numbers all the same.
  if (!knownOf(loop.from, where).whole) return;
  if (loop.step !== null && !knownOf(loop.step, where).whole) return;
  // A name the body declares is one binding here, and a name the blocks above it
  // declared is one this pass would have to write the whole-number form of on
  // the far side of a boundary — so a loop over a name it shadows is left alone.
  const declaredHere = new Set<string>();
  for (const statement of body.statements) {
    if (statement.k !== "let") continue;
    if (declaredHere.has(statement.slot.name) || slots.has(statement.slot.name)) return;
    declaredHere.add(statement.slot.name);
  }
  const inside: Where = { locals: new Map(where.locals), fn: where.fn, facts: where.facts };
  inside.locals.set(loop.variable, { whole: true, reach: REACH, reduced: null });
  const whole = new Set<string>([loop.variable]);

  // The loop is read once over what the facts hold before anything of it is
  // rewritten, and the read is what decides both things: every value the body
  // computes has to be a whole number within the reach the two forms agree at,
  // and the names it binds and writes are the names the whole-number form may
  // read as whole numbers. Reading it first is what lets a carry carried into
  // the next turn be read as a whole number in the turn that produces it — the
  // name is only whole once the body has said so.
  if (!wholeNumbersOf(body, inside, whole, slots)) return;
  const introduced: SemanticSlot[] = [];
  // The facts the names held before the loop, which is what a name the loop
  // writes has to have held for the loop to write it in whole numbers: a slot
  // that held a fraction holds it still, and reading it as a whole number is a
  // number the program never wrote.
  const before = new Map(where.locals);
  // The slots the loop writes as whole numbers, which are re-typed once the
  // whole loop has been rewritten: a loop that could not be rewritten leaves
  // every slot as it was.
  const retype: ValueSlot[] = [];
  if (!rewriteChain(body, inside, whole, slots, fresh, before, introduced, retype)) return;

  for (const slot of retype) slot.type = WHOLE;
  for (const slot of introduced) if (!slots.has(slot.name)) slots.set(slot.name, slot);
}

/**
 * Rewrites a chain of declarations, element writes and writes of names in whole
 * numbers, over the names `whole` holds whole, and answers whether it could: a
 * statement this pass has no whole-number form for leaves the chain alone and
 * answers false.
 *
 * The bindings the forms introduce are written where they are read, and not
 * above the body: a value the whole-number form reads out of an element is
 * the element as it is where it is read, and a write above it would change
 * what it reads.
 *
 * Nothing is written until the whole chain has been rewritten: a chain that
 * cannot be rewritten leaves the body as it was, and a body half rewritten is
 * a body that reads a name nothing declares.
 */
function rewriteChain(
  body: SemanticBlock,
  inside: Where,
  whole: ReadonlySet<string>,
  slots: Map<string, SemanticSlot>,
  fresh: () => string,
  before: ReadonlyMap<string, Known>,
  introduced: SemanticSlot[],
  retype: ValueSlot[],
): boolean {
  const rewritten: SemanticStatement[] = [];
  for (const statement of body.statements) {
    // The bindings one statement's whole form needs, which are written where
    // that statement reads them.
    const bindings: SemanticStatement[] = [];
    switch (statement.k) {
      case "let": {
        const form = wholeForm(statement.value, inside, whole, fresh, bindings, introduced);
        if (form === null) return false;
        rewritten.push(...bindings, {
          ...statement,
          slot: { kind: "value", name: statement.slot.name, mutable: statement.slot.mutable, type: WHOLE },
          value: form,
        });
        continue;
      }
      case "set": {
        const form = wholeForm(statement.value, inside, whole, fresh, bindings, introduced);
        if (form === null) return false;
        // The slot is the one the block above declared, and re-typing it is what
        // makes every read of the name anywhere in the function a whole number —
        // which the IR keeps, because a whole number read as a double is every
        // value the slot holds said as the wider of the two.
        //
        // It may only be re-typed when the name held a whole number before the
        // loop: a slot that held a fraction holds it still, and a slot read as
        // a whole number is a number the program never wrote.
        const slot = slots.get(statement.name);
        if (slot === undefined || slot.kind !== "value") return false;
        const held = before.get(statement.name);
        if (held === undefined || !held.whole) return false;
        retype.push(slot);
        rewritten.push(...bindings, { ...statement, value: form });
        continue;
      }
      case "setElement": {
        const form = wholeForm(statement.value, inside, whole, fresh, bindings, introduced);
        if (form === null) return false;
        rewritten.push(...bindings, { ...statement, value: form });
        continue;
      }
      case "if": {
        if (reductionOf(statement) === null) return false;
        const then = { ...statement.then, statements: [...statement.then.statements] };
        const otherwise =
          statement.otherwise === null ? null : { ...statement.otherwise, statements: [...statement.otherwise.statements] };
        if (!rewriteChain(then, inside, whole, slots, fresh, before, introduced, retype)) return false;
        if (otherwise !== null && !rewriteChain(otherwise, inside, whole, slots, fresh, before, introduced, retype)) {
          return false;
        }
        rewritten.push(...bindings, { ...statement, then, otherwise });
        continue;
      }
      default:
        return false;
    }
  }
  body.statements = rewritten;
  return true;
}

/** Whether a value is a name or a literal, which is what a whole form reads for free. */
function isName(value: SemanticValue): boolean {
  return value.k === "local" || value.k === "const";
}

/**
 * A binding of a value at the whole width, which is where a value the whole-number
 * form does not rebuild whole is read: the declaration states the width and the
 * machine's own conversion of the value to that width is what the IR asks for.
 */
function narrowBinding(
  value: SemanticValue,
  fresh: () => string,
  bindings: SemanticStatement[],
  introduced: SemanticSlot[],
): SemanticValue {
  const name = fresh();
  const slot: SemanticSlot = { kind: "value", name, mutable: false, type: WHOLE };
  bindings.push({ k: "let", slot, value, line: 0 });
  introduced.push(slot);
  return { k: "local", type: WHOLE, name };
}

/**
 * The whole-number form of a value, or null where the value is not one this pass
 * may rewrite.
 *
 * A name this pass has made whole is read as a whole number. An element read is
 * not — a double cannot be read at a whole number's width — so it is bound to a
 * name of its own, and the name is what the rest of the form reads. A floor of a
 * quotient by a power of two is a shift, which is the same number for every whole
 * number whatever its sign; a floor of anything else is the value it floored,
 * because a whole number is its own floor.
 */
function wholeForm(
  value: SemanticValue,
  where: Where,
  whole: ReadonlySet<string>,
  fresh: () => string,
  bindings: SemanticStatement[],
  introduced: SemanticSlot[],
): SemanticValue | null {
  switch (value.k) {
    case "const": {
      const literal = literalOf(value);
      if (literal === null || !literal.whole) return null;
      return { k: "const", type: WHOLE, text: String(literal.value) };
    }
    case "local":
      return whole.has(value.name) ? { ...value, type: WHOLE } : null;
    case "element": {
      return value.of.k === "local" ? narrowBinding(value, fresh, bindings, introduced) : null;
    }
    case "unary": {
      if (value.op !== "neg" && value.op !== "pos") return null;
      const operand = wholeForm(value.operand, where, whole, fresh, bindings, introduced);
      return operand === null ? null : { ...value, type: WHOLE, operand };
    }
    case "arith": {
      if (value.op === "shr" || value.op === "shl") {
        // A shift is written at the type of what it shifts, so only that side is
        // rewritten; the count is the machine's to mask.
        const left = wholeForm(value.left, where, whole, fresh, bindings, introduced);
        return left === null ? null : { ...value, type: WHOLE, left };
      }
      if (value.op !== "add" && value.op !== "sub" && value.op !== "mul") return null;
      // An operation whose two sides are neither a whole number nor a literal is
      // left as the source wrote it and read at the whole width by the binding
      // that holds it. That is one conversion where converting each side would be
      // two, and it keeps both sides out of the machine's whole-number registers
      // — which is the whole of what an operation two element reads followed by
      // one addition needs: the sum is computed the way the source computed it,
      // and only the addition that carries the carry down is a whole number.
      if (!isName(value.left) && !isName(value.right) && knownOf(value, where).whole) {
        return narrowBinding(value, fresh, bindings, introduced);
      }
      const left = wholeForm(value.left, where, whole, fresh, bindings, introduced);
      if (left === null) return null;
      const right = wholeForm(value.right, where, whole, fresh, bindings, introduced);
      return right === null ? null : { ...value, type: WHOLE, left, right };
    }
    case "call": {
      if (!value.call.builtin) {
        // A call this pass cannot read is a value it cannot claim to know, so it
        // is read at the whole width only where the facts say the whole number is
        // a whole number whatever the call answered — which is nothing here.
        return null;
      }
      const argument = value.call.args[0];
      if (argument === undefined) return null;
      // The magnitude of a value is the value itself only where the value is
      // not below zero, and nothing here says that it is not: a buffer holds
      // whatever was written into it, and a negative one is a number the
      // program wrote. The whole-number form of a magnitude is therefore not
      // the magnitude of the whole number, and the call is left as it was.
      if (value.call.callee === "Math.abs") return null;
      // The one rewriting that changes an operation: a whole number divided by a
      // power of two and floored is that whole number shifted down, because the
      // floor of a quotient and the shift down agree for every whole number and
      // differ only over doubles.
      if (value.call.callee === "Math.floor") {
        const divided = quotientOf(argument);
        if (divided !== null) {
          const left = wholeForm(divided.dividend, where, whole, fresh, bindings, introduced);
          if (left === null) return null;
          const count: SemanticValue = { k: "const", type: WHOLE, text: String(divided.places) };
          return { k: "arith", type: WHOLE, op: "shr", left, right: count };
        }
      }
      // A whole number is its own floor, its own truncation and its own
      // rounding, so all three answer the value they were given.
      if (value.call.callee === "Math.floor" || value.call.callee === "Math.round" || value.call.callee === "Math.trunc") {
        return wholeForm(argument, where, whole, fresh, bindings, introduced);
      }
      return null;
    }
    default:
      return null;
  }
}

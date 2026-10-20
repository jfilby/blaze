/**
 * Whole-number arithmetic for a function every caller hands whole numbers to.
 *
 * A program of this language counts in doubles: `for (let i = 0; i < n; i++)`
 * gives the counter a whole-number name and hands `i + j` to the next function
 * as a `double`, so an expression like `((i + j) * (i + j + 1) >>> 1) + i + 1`
 * is computed in floating point, and every one of its terms costs a floating
 * point operation on a machine whose floating point unit is the scarce thing in
 * a loop. That is the whole difference between this compiler and a compiler
 * whose `int` is a whole number: on the spectral-norm kernel the loop that
 * calls that function measures 133 ms against the 62 ms of a build whose
 * counters are whole numbers, and every millisecond of the difference is a
 * denominator multiplied, converted to a whole number and converted back on
 * every turn.
 *
 * The rewrite is the one a compiler makes when it knows a value is a whole
 * number: compute it as one. It is only sound under two facts, and both are
 * questions about the whole program rather than about one body.
 *
 * The first is what the callers pass. A function whose every caller hands it a
 * whole number at every parameter is a function whose parameters are whole
 * numbers, whatever the source declared them as, and every call site hands its
 * argument over without the conversion it was making. One caller that passes a
 * double is one that leaves the function as it is: a whole-number body reading
 * a double would truncate a value the program never said was whole.
 *
 * The second is how large those whole numbers are. Whole-number arithmetic in a
 * double is only the same arithmetic when nothing overflows and every
 * intermediate is held exactly, and the IR holds no bound on a loop counter —
 * `n` is whatever the command line said. So the body answers the whole-number
 * form only for arguments within a reach where the two are the same number,
 * taken as the widest reach whose every intermediate is under 2^53 and
 * therefore exact. That is a condition the body asks of its own arguments, and
 * it holds for every program whose numbers are small, which is every program
 * that was written to be read.
 *
 * The shape of the body is a condition too, and it is a narrow one: a body of
 * declarations and a return, with nothing in it that runs a loop, reads memory
 * or calls anything. The whole-number form replaces the value the body answers,
 * and standing a value in for a name the body declared duplicates whatever that
 * name was computed from — a call would then run twice on a turn, and a read of
 * memory would be read from where the first read left it. A body that computes
 * one value and hands it back is the body where the substitution is the same
 * program; every other body is left as the source wrote it, which is what every
 * other body in the language gets.
 */

import {
  UNSTATED_LINE,
  isFloat,
  isInteger,
  isUnsigned,
  isWideType,
  slotType,
  statementValues,
  walkValues,
  type ArithOp,
  type SemanticBlock,
  type SemanticCall,
  type SemanticFunction,
  type SemanticProgram,
  type SemanticStatement,
  type SemanticType,
  type SemanticValue,
} from "../core/semantic-ir.ts";
import { isSafeToCompute } from "./repair.ts";

/** The type a whole number is held at. */
const WHOLE = { kind: "primitive", name: "i64" } as const;
/** The same width read as the unsigned number a range test wants. */
const UNSIGNED_WHOLE = { kind: "primitive", name: "u64" } as const;
/** What a truth is written as, which is what a comparison answers. */
const TRUTH = { kind: "primitive", name: "bool" } as const;

/**
 * The largest a whole number may be and still be a double the arithmetic on it
 * is exact for. Every double from here to 2^53 holds a whole number and holds
 * it exactly; one past that is the first value the spacing of a double reaches
 * a whole number, which is what makes every sum and product below it agree
 * with the whole-number answer.
 */
const EXACT = 2 ** 53;

/**
 * The reaches a body is offered, widest first.
 *
 * A reach is the largest magnitude each of a function's parameters is given,
 * and the body is offered the widest one whose every intermediate is exact.
 * Twenty-six of them are a ladder from 2^25 down to one: the answer the
 * spectral-norm kernel wants is 2^25, which is where `s * (s + 1)` is under 2^53
 * with two arguments to spare, and a body that needs less is offered less.
 */
const REACHES: readonly number[] = Array.from({ length: 25 }, (_, power) => 2 ** (25 - power));

/** The operations that are the same arithmetic over whole numbers. */
const EXACT_OPERATIONS: Record<string, true> = { add: true, sub: true, mul: true };
/**
 * The operations the language writes at a whole number whatever the sides are,
 * and of those the ones whose answer is no larger than what went in.
 *
 * A shift to the right moves a value down: `x >> 1` is under `x` whatever `x`
 * was, which is what lets the bound a whole-number form carries be read off
 * the width of the type it is written at. A shift to the left moves it up, and
 * `&`, `|` and `^` keep a bit the sides were both zero at, so none of them has
 * that property and none is rewritten here: a form is only worth having where
 * its bound is an answer, and for these three it would be a guess.
 */
const SHRINKING_WHOLE_OPERATIONS: Record<ArithOp, boolean> = {
  add: false,
  sub: false,
  mul: false,
  div: false,
  floorDiv: false,
  floorMod: false,
  mod: false,
  pow: false,
  min: false,
  max: false,
  shl: false,
  shr: true,
  ushr: true,
  and: false,
  or: false,
  xor: false,
  concat: false,
};
/** The widths a whole number type holds, by the width of its name. */
const WHOLE_BITS: Record<string, number> = { i8: 8, i16: 16, i32: 32, i64: 64, u8: 8, u16: 16, u32: 32, u64: 64 };

/* -------------------------------------------------------------------------- */
/* What a body declares                                                        */
/* -------------------------------------------------------------------------- */

/** Every block a statement holds of its own, which is where a name can hide. */
function blocksOf(statement: SemanticStatement): readonly SemanticBlock[] {
  if (statement.k === "if") return statement.otherwise === null ? [statement.then] : [statement.then, statement.otherwise];
  if (statement.k === "loop") return [statement.loop.body];
  if (statement.k === "block") return [statement.body];
  return [];
}

/** Every block of a body, nested ones included, and every call each of them makes. */
function callsIn(entry: SemanticBlock): SemanticCall[] {
  const calls: SemanticCall[] = [];
  const walk = (block: SemanticBlock): void => {
    for (const statement of block.statements) {
      if (statement.k === "call") calls.push(statement.call);
      // A call is usually written inside the value that uses it — a division,
      // a sum — so the values a statement computes are walked whole rather than
      // read at the top.
      for (const value of statementValues(statement)) {
        walkValues(value, (one) => {
          if (one.k === "call") calls.push(one.call);
        });
      }
      for (const nested of blocksOf(statement)) walk(nested);
    }
  };
  walk(entry);
  return calls;
}

/**
 * Every name a body can read, with the type it is declared at: its parameters,
 * what it declares, and the counter of every loop it holds.
 *
 * This is what says a value is a whole number at a call site. A counter is
 * counted in whole numbers whatever it is read as, and a name the body declared
 * as one holds one; a name in neither list is a value the body got from
 * somewhere this pass cannot see.
 */
function declaredTypes(fn: SemanticFunction | null, entry: SemanticBlock): Map<string, SemanticType> {
  const declared = new Map<string, SemanticType>();
  for (const param of fn?.params ?? []) declared.set(param.name, slotType(param));
  const walk = (block: SemanticBlock): void => {
    for (const statement of block.statements) {
      if (statement.k === "let") declared.set(statement.slot.name, slotType(statement.slot));
      if (statement.k === "loop" && statement.loop.kind === "counted") declared.set(statement.loop.variable, statement.loop.type);
      for (const nested of blocksOf(statement)) walk(nested);
    }
  };
  walk(entry);
  return declared;
}

/* -------------------------------------------------------------------------- */
/* What a caller hands over                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The whole number an argument is, read at the width a whole number is held at,
 * or null where it is not one.
 *
 * Only what the IR already holds as a whole number answers here. A double that
 * happens to be whole is not one this pass may take: handing it over as a whole
 * number would truncate a value nothing bounded, and the caller is not where a
 * bound could be asked for. A name is read at the width of a word rather than
 * at its own, so a `u32` counter arrives whole; a name declared as an unsigned
 * *word* does not, because reading it as a signed one is a different number for
 * every value above the middle of its range, and neither does a name whose width
 * is one this pass does not know.
 */
function wholeArgument(value: SemanticValue, declared: ReadonlyMap<string, SemanticType>): SemanticValue | null {
  switch (value.k) {
    case "const":
      return isInteger(value.type) && /^[+-]?\d+$/.test(value.text) ? { ...value, type: WHOLE } : null;
    case "local": {
      const type = declared.get(value.name);
      if (type === undefined || type.kind !== "primitive" || !isInteger(type)) return null;
      const bits = WHOLE_BITS[type.name];
      // A width this table does not carry is a width this pass does not know,
      // and an unsigned word is a value read as a signed one for every number
      // above the middle of its range.
      if (bits === undefined || (bits === 64 && isUnsigned(type))) return null;
      return { ...value, type: WHOLE };
    }
    case "arith": {
      if (!isInteger(value.type)) return null;
      const left = wholeArgument(value.left, declared);
      const right = wholeArgument(value.right, declared);
      return left === null || right === null ? null : { ...value, left, right };
    }
    default:
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/* The whole-number form of a value                                            */
/* -------------------------------------------------------------------------- */

/** A value computed as a whole number, and the largest it can be. */
interface Form {
  /** The value as the IR holds a whole number, and the type it is written as. */
  readonly value: SemanticValue;
  /**
   * The largest magnitude the value reaches when every whole number it is made
   * of is within the reach the body was offered. A form whose bound reaches
   * 2^53 is not one the whole-number arithmetic agrees with, because a double
   * stops holding a whole number exactly there.
   */
  readonly bound: number;
}

/**
 * The whole-number form of a value, or null where the value is not one this
 * pass may rewrite.
 *
 * The parameters are the whole numbers the reach bounds, and the declarations
 * the body made of them are the ones already given a form. Everything else is a
 * refusal: an operation that is not exact over whole numbers (`/` is not, and a
 * division of two doubles is one), a value out of memory, a call, and a name
 * this body did not declare.
 */
function formOf(
  value: SemanticValue,
  reach: number,
  parameters: ReadonlySet<string>,
  bindings: ReadonlyMap<string, Form>,
): Form | null {
  switch (value.k) {
    case "const": {
      if (!isFloat(value.type) && !isInteger(value.type)) return null;
      const number = Number(value.text);
      if (!Number.isInteger(number) || !Number.isSafeInteger(number)) return null;
      return { value: { k: "const", type: WHOLE, text: String(number) }, bound: Math.abs(number) };
    }
    case "local": {
      if (parameters.has(value.name)) return { value: { ...value, type: WHOLE }, bound: reach };
      // A declaration the body made stands in for the value it was bound to,
      // so a value computed of it is computed out of what that declaration was
      // computed from rather than out of the name. A declaration given no form
      // is one whose value cannot be computed twice — a call, or a read of
      // memory — and a value made of it is one this pass cannot rewrite.
      const bound = bindings.get(value.name);
      return bound === undefined ? null : bound;
    }
    case "arith": {
      // A shift is written at the type it answers, so it is already a
      // whole-number operation: what it needs is an operand that is one, and it
      // answers a whole number of that type whatever the operand was.
      if (SHRINKING_WHOLE_OPERATIONS[value.op] === true) {
        if (value.type.kind !== "primitive" || !isInteger(value.type)) return null;
        const left = formOf(value.left, reach, parameters, bindings);
        const right = formOf(value.right, reach, parameters, bindings);
        if (left === null || right === null) return null;
        const bits = WHOLE_BITS[value.type.name];
        if (bits === undefined) return null;
        // The answer is a whole number of the type the operation is written at,
        // so the bits above it are its ceiling, and a shift carries down as
        // many of them as it is shifted by — masked to the width the shift is
        // carried out at, which is what the backends do with the count and what
        // `>> 40` of a `u32` answers here is the same thing `>> 8` answers.
        const written = value.right.k === "const" && /^\d+$/.test(value.right.text) ? Number(value.right.text) : 0;
        const places = written & (bits - 1);
        return { value: { ...value, left: left.value, right: right.value }, bound: 2 ** Math.max(0, bits - 1 - places) };
      }
      if (!isFloat(value.type) || EXACT_OPERATIONS[value.op] !== true) return null;
      const left = formOf(value.left, reach, parameters, bindings);
      const right = formOf(value.right, reach, parameters, bindings);
      if (left === null || right === null) return null;
      // A sum is as large as the two it is made of and a product as large as
      // the product of them, which is the bound the reach is asked against.
      const bound = value.op === "mul" ? left.bound * right.bound : left.bound + right.bound;
      return { value: { ...value, type: WHOLE, left: left.value, right: right.value }, bound };
    }
    default:
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/* The pass                                                                    */
/* -------------------------------------------------------------------------- */

/** One call of a program's own function, and the names of the body it is in. */
interface CallInBody {
  readonly call: SemanticCall;
  /** The types the calling body declares, which is what its arguments are. */
  readonly declared: ReadonlyMap<string, SemanticType>;
}

/**
 * Computes the arithmetic of a function in whole numbers, for every function
 * of a program that every caller hands whole numbers to.
 *
 * The pass runs once over a whole program, after the rewrites that look at one
 * body at a time are done, because what it needs is the one thing none of them
 * can see: what the callers of a function pass it.
 */
export function wholeNumberArithmetic(program: SemanticProgram): void {
  const callers = new Map<string, CallInBody[]>();
  const declared = new Set(program.bodies.map((fn) => fn.name));
  const collect = (entry: SemanticBlock, types: ReadonlyMap<string, SemanticType>): void => {
    for (const call of callsIn(entry)) {
      if (call.builtin || !declared.has(call.callee)) continue;
      const found = callers.get(call.callee);
      if (found === undefined) callers.set(call.callee, [{ call, declared: types }]);
      else found.push({ call, declared: types });
    }
  };
  collect(program.entry, declaredTypes(null, program.entry));
  for (const fn of program.bodies) collect(fn.entry, declaredTypes(fn, fn.entry));

  for (const fn of program.bodies) {
    const calls = callers.get(fn.name) ?? [];
    // A function nothing calls is not asked: a body no caller reaches is one
    // the pass cannot improve and one whose parameters no test speaks for.
    if (calls.length === 0 || fn.params.length === 0) continue;
    // A wide number is a whole number this pass may not take: it is four limbs,
    // and the whole number a parameter is declared as here is one machine word,
    // so rewriting one would read eight bytes of a thirty-two byte value and
    // answer for it. `WHOLE_BITS` refuses a wide *name* on its own, so this is
    // the other half of the same rule: the parameter is what the arm reads, and
    // nothing about it is left to a table further down.
    if (!fn.params.every((param) => param.kind === "value" && !isWideType(slotType(param)) && (isFloat(slotType(param)) || isInteger(slotType(param))))) continue;
    if (!calls.every(({ call, declared: types }) =>
      call.args.length === fn.params.length && fn.params.every((_, index) => wholeArgument(call.args[index], types) !== null),
    )) continue;
    const arm = wholeNumberArm(fn);
    if (arm === null) continue;
    declareWholeParameters(program, fn, calls);
    fn.entry = arm;
  }
}

/**
 * The body of a function, rewritten to answer in whole numbers when its
 * arguments are small and as it was written otherwise.
 *
 * The arm comes first and every statement the body had follows it, so the
 * whole-number answer skips the floating point work rather than doing it and
 * then choosing not to use it. It is a block that ends in a return and holds
 * nothing else, which is an early return the IR already holds.
 */
function wholeNumberArm(fn: SemanticFunction): SemanticBlock | null {
  const entry = fn.entry;
  if (entry.terminator.k !== "return" || entry.terminator.value === null || !isFloat(entry.terminator.value.type)) return null;
  // A body of declarations and a return is the body this pass rewrites. A loop,
  // an arm, a write or a call in it is one whose values this pass would have to
  // move, and moving a value that reads memory or runs a call is another
  // program: see the head of this file.
  if (!entry.statements.every((statement) => statement.k === "let")) return null;
  const parameters = new Set(fn.params.map((param) => param.name));
  const reads = fn.params.map((param) => ({ k: "local", type: WHOLE, name: param.name }) as const);

  for (const reach of REACHES) {
    // The declarations are bound in the order the body writes them, so a name a
    // declaration is computed of is bound before the one that reads it. A name
    // the body writes again is given none: standing its first value in for the
    // name would answer a read that comes after the write with the value from
    // before it, which is a different number. So is a value that cannot be
    // computed twice, which is a call or a read of memory.
    const bindings = new Map<string, Form>();
    for (const statement of entry.statements) {
      if (statement.k !== "let" || !isSafeToCompute(statement.value)) continue;
      if (statement.slot.mutable) continue;
      const form = formOf(statement.value, reach, parameters, bindings);
      if (form !== null && form.bound < EXACT) bindings.set(statement.slot.name, form);
    }
    const answer = formOf(entry.terminator.value, reach, parameters, bindings);
    if (answer === null || answer.bound >= EXACT) continue;

    // Every parameter within the reach, joined the way the language joins
    // tests. Each one is tested the way a machine tests a range without a
    // branch per side: the reach is added and the sum is read as the unsigned
    // number it is, so one comparison answers "is this between minus the reach
    // and the reach" however far below the range the value is. Every one of
    // them reads a parameter, which a caller passes the same way on every turn
    // of a loop, so a target that can hoist the test out of a loop does and the
    // whole-number path costs nothing to reach.
    let guard: SemanticValue | null = null;
    for (const parameter of reads) {
      const shifted: SemanticValue = {
        k: "arith",
        type: UNSIGNED_WHOLE,
        op: "add",
        left: parameter,
        right: { k: "const", type: UNSIGNED_WHOLE, text: String(reach) },
      };
      const test: SemanticValue = {
        k: "compare",
        type: TRUTH,
        op: "le",
        operand: UNSIGNED_WHOLE,
        left: shifted,
        right: { k: "const", type: UNSIGNED_WHOLE, text: String(2 * reach) },
      };
      guard = guard === null ? test : { k: "logical", type: TRUTH, op: "and", left: guard, right: test };
    }
    if (guard === null) continue;

    return {
      ...entry,
      statements: [
        {
          k: "if",
          condition: guard,
          then: { id: `${entry.id}_whole`, statements: [], releases: [], terminator: { k: "return", value: answer.value } },
          otherwise: null,
          line: UNSTATED_LINE,
        },
        ...entry.statements,
      ],
    };
  }
  return null;
}

/**
 * Re-types the parameters of a function to whole numbers, and every argument
 * every caller passes to it.
 *
 * A parameter is written as a whole number, the signature the program declares
 * it under is written as one, and an argument is written as the whole number it
 * already is. A signature is what the C driver declares the function by and
 * what every call is made against, and a call carries its own copy of it, so
 * all three are written or the program is a C file that does not compile.
 */
function declareWholeParameters(program: SemanticProgram, fn: SemanticFunction, calls: readonly CallInBody[]): void {
  fn.params = fn.params.map((param) => (param.kind === "value" ? { ...param, type: WHOLE } : param));
  const whole = (index: number): boolean => fn.params[index]?.kind === "value";
  const signature = program.functions.find((one) => one.name === fn.name);
  if (signature !== undefined) {
    signature.params = signature.params.map((param, index) => (whole(index) ? { ...param, type: "i64" } : param));
  }
  for (const { call, declared } of calls) {
    call.signature = {
      ...call.signature,
      params: call.signature.params.map((param, index) => (whole(index) ? { ...param, type: "i64" } : param)),
    };
    call.args = call.args.map((argument, index) => (whole(index) ? (wholeArgument(argument, declared) ?? argument) : argument));
    call.argTypes = call.argTypes.map((type, index) => (whole(index) ? WHOLE : type));
  }
}
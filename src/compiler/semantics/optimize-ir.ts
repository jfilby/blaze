/**
 * The rewrites a build applies to the IR on its own, before and after the ones
 * a model proposes.
 *
 * A review proposes, and the rules hold it to: whatever the rules in
 * `repair.ts` do not cover, no build ever does, and the largest thing they do
 * not cover is everything that needs no judgement. Constant folding, the
 * algebraic identities, loop-invariant hoisting, commoning a value a loop
 * computes once, and dropping what nothing reads are all the same on every
 * build, so waiting for a model to propose one is waiting for luck.
 *
 * The pass here is the deterministic half. It is applied to a whole function
 * and to a whole program's own statements, it is applied again after every
 * round a review produced, and it runs to a fixed point, because one of these
 * exposes the next: a fold makes a value hoistable, and a hoist makes two
 * computations the same one.
 *
 * Every rewrite here is value-preserving by construction, and the two places
 * that could have been are guarded and say why: folding a floating-point
 * operation is only exact where IEEE says the result is exact, and moving a
 * computation is only the same program where the value reads nothing the
 * region writes and cannot fault. The test a value has to pass is one answer,
 * in `repair.ts`, whichever rewrite is asking: what `hoist-invariant` and
 * `common-subexpression` hold a model's proposal to is what this holds itself.
 */

import {
  type SemanticBlock,
  type SemanticFunction,
  type SemanticLoop,
  type SemanticProgram,
  type SemanticSlot,
  type SemanticStatement,
  type SemanticType,
  type SemanticValue,
} from "../core/semantic-ir.ts";
import { hasCall, isInteger, isUnsigned, slotType } from "../core/semantic-ir.ts";
import { isBindable, isSafeToCompute, replaceValues, slotFor, valueKey } from "./repair.ts";

/* -------------------------------------------------------------------------- */
/* Numbers                                                                     */
/* -------------------------------------------------------------------------- */

/** The whole-number types, and the width each one holds. */
const WIDTH: Record<string, number> = { i8: 8, i16: 16, i32: 32, i64: 64, u8: 8, u16: 16, u32: 32, u64: 64 };
const FLOAT_TYPES: Record<string, true> = { f32: true, f64: true };
/** The name of a numeric type, which is what a fold wraps to a width. */
type NumericName = "i8" | "i16" | "i32" | "i64" | "u8" | "u16" | "u32" | "u64" | "f32" | "f64";

/** The type a folded truth is written at, which is the one the IR gives it. */
const BOOL = { kind: "primitive", name: "bool" } as const;

/**
 * A number as a JavaScript one, or null when its text is not a number this
 * pass can reason about. A literal wider than 2^53 arrives as text and stays
 * text: a double cannot hold it, so folding through one would change the value.
 */
function asNumber(text: string): number | null {
  const value = Number(text);
  if (!Number.isFinite(value) && !/^-?(inf|nan)$/i.test(text)) return null;
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) return null;
  return value;
}

/** The text a number is written back as, which is the shortest form of it. */
function asText(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "Infinity";
  if (value === -Infinity) return "-Infinity";
  if (Object.is(value, -0)) return "-0";
  return String(value);
}

/** The type a whole number is written at, which is what its range follows. */
function numberType(value: SemanticValue): NumericName | null {
  if (value.type.kind !== "primitive") return null;
  const name = value.type.name;
  return name in WIDTH || FLOAT_TYPES[name] === true ? (name as NumericName) : null;
}

/**
 * A whole number wrapped to the range of its type, as the backends wrap it.
 *
 * The arithmetic is done in whole numbers of the compiler's own rather than in
 * doubles, because a double holds every integer exactly only up to 2^53 and a
 * 64 bit range is wider than that: `7 % 3` at `i64` came out of the double form
 * as zero, because the sum the signed wrap forms reaches 2.77e19 and rounds on
 * the way back down. The answer a backend gives is the answer modulo 2^64, and
 * that is the question this now asks.
 */
function wrapWhole(value: number, name: NumericName): number {
  const width = WIDTH[name];
  if (width === undefined || !Number.isFinite(value)) return value;
  const bits = BigInt(width);
  const modulus = 2n ** bits;
  // A double at or above 2^53 has no fractional part, so this is the very
  // integer the double holds.
  const whole = BigInt(Math.trunc(value));
  if (isUnsigned({ kind: "primitive", name } as SemanticType)) {
    return Number(((whole % modulus) + modulus) % modulus);
  }
  const bound = modulus / 2n;
  return Number(((((whole + bound) % modulus) + modulus) % modulus) - bound);
}

/**
 * Folds one operation on two literals, or answers null when it may not.
 *
 * Floating point is where the care is. `0.1 + 0.2` is not `0.3`, and a fold
 * that rounded it to `0.3` would deliver a program that disagrees with the
 * source it was compiled from. So a float operation is only folded when its
 * answer is exact, which is decided by re-reading it back: if the double the
 * operation produced is the double the folded text parses to, the two are the
 * same number, and if they are not, the operation is left as it was written.
 *
 * A whole number folds whenever it is computed, because the backends wrap to
 * the width of the type and this does the same arithmetic.
 */
function foldArithmetic(op: string, left: number, right: number, name: NumericName): number | null {
  const isFloat = FLOAT_TYPES[name] === true;
  let folded: number;
  switch (op) {
    case "add": folded = left + right; break;
    case "sub": folded = left - right; break;
    case "mul": folded = left * right; break;
    case "div":
      if (right === 0) return null;
      folded = left / right;
      break;
    case "mod":
      if (right === 0) return null;
      folded = left % right;
      break;
    case "pow": folded = left ** right; break;
    case "min": folded = Math.min(left, right); break;
    case "max": folded = Math.max(left, right); break;
    case "shl": folded = left * 2 ** right; break;
    case "shr": folded = Math.trunc(left / 2 ** right); break;
    case "and": folded = toBits(left) & toBits(right); break;
    case "or": folded = toBits(left) | toBits(right); break;
    case "xor": folded = toBits(left) ^ toBits(right); break;
    default: return null;
  }
  if (isFloat) {
    // Only an exact answer is folded, and it is exact when the text written
    // back reads as the very double the operation produced.
    const text = asText(folded);
    const read = Number(text);
    if (Number.isNaN(folded) || Object.is(folded, -0) || Infinity) return folded;
    if (!Object.is(read, folded)) return null;
    return folded;
  }
  return wrapWhole(folded, name);
}

/** Two 32 bit values as the signed integer their bits spell. */
function toBits(value: number): number {
  return value | 0;
}

/* -------------------------------------------------------------------------- */
/* Rewriting one value                                                         */
/* -------------------------------------------------------------------------- */

/** Every value directly inside another. */
export function valueChildren(value: SemanticValue): readonly SemanticValue[] {
  switch (value.k) {
    case "arith":
      return [value.left, value.right];
    case "compare":
      return [value.left, value.right];
    case "logical":
    case "coalesce":
      return [value.left, value.right];
    case "select":
      return [value.condition, value.then, value.otherwise];
    case "unary":
      return [value.operand];
    case "isNull":
      return [value.operand];
    case "toText":
      return [value.of];
    case "length":
      return [value.of];
    case "element":
      return [value.of, value.index];
    case "loadField":
      return [value.object];
    case "newObject":
      return value.fields.map((field) => field.value);
    case "buffer":
      return value.values;
    case "text":
      return value.parts.flatMap((part) => (part.k === "value" ? [part.value] : []));
    case "argv":
      return value.index === null ? [] : [value.index];
    // The arguments of a call are values of their own: a name read in one and a
    // constant written into one are both what the body reads and computes, and
    // a walk that stops at the call answers "nothing here" for both.
    case "call":
      return value.call.args;
    default:
      return [];
  }
}

/** A walk of a value and everything inside it, outermost first. */
export function walkSemanticValue(value: SemanticValue, visit: (value: SemanticValue) => void): void {
  visit(value);
  for (const child of valueChildren(value)) walkSemanticValue(child, visit);
}

/** A value rebuilt with every child replaced. */
function withChildren(value: SemanticValue, children: SemanticValue[]): SemanticValue {
  let at = 0;
  const next = (): SemanticValue => {
    const child = children[at] as SemanticValue;
    at += 1;
    return child;
  };
  switch (value.k) {
    case "arith": return { ...value, left: next(), right: next() };
    case "compare": return { ...value, left: next(), right: next() };
    case "logical":
    case "coalesce": return { ...value, left: next(), right: next() };
    case "select": return { ...value, condition: next(), then: next(), otherwise: next() };
    case "unary": return { ...value, operand: next() };
    case "isNull": return { ...value, operand: next() };
    case "toText": return { ...value, of: next() };
    case "length": return { ...value, of: next() };
    case "element": return { ...value, of: next(), index: next() };
    case "loadField": return { ...value, object: next() };
    case "argv": return value.index === null ? value : { ...value, index: next() };
    // The types of the arguments are the ones the call was made with, and a
    // fold never changes a type, so the folded values line up with them.
    case "call": return { ...value, call: { ...value.call, args: children } };
    case "newObject": return { ...value, fields: value.fields.map((field) => ({ ...field, value: next() })) };
    case "buffer": return { ...value, values: children };
    case "text":
      return {
        ...value,
        parts: value.parts.map((part) => (part.k === "value" ? { k: "value" as const, value: next() } : part)),
      };
    default: return value;
  }
}

/** Every statement of a block that is a block of its own. */
export function nestedSemanticBlocks(block: SemanticBlock): SemanticBlock[] {
  const nested: SemanticBlock[] = [];
  for (const statement of block.statements) {
    for (const one of statementBlocksOf(statement)) nested.push(...nestedSemanticBlocks(one));
  }
  return [block, ...nested];
}

function statementBlocksOf(statement: SemanticStatement): readonly SemanticBlock[] {
  switch (statement.k) {
    case "if": return [statement.then, statement.otherwise].filter((one): one is SemanticBlock => one !== null);
    case "loop": return [statement.loop.body];
    case "block": return [statement.body];
    default: return [];
  }
}

/* -------------------------------------------------------------------------- */
/* Folding                                                                     */
/* -------------------------------------------------------------------------- */

/** The two values of a node that decides on one of them. */
function literalOf(value: SemanticValue): number | null {
  return value.k === "const" ? asNumber(value.text) : null;
}

/**
 * The value one node folds to, or null when it stays as it is written.
 *
 * This is the whole of constant folding and the whole of the algebraic
 * identities in one place, because they are the same question asked of the same
 * node: is there a shorter way to write what this already says? A node over two
 * literals has an answer that is one literal. A node over one literal and an
 * identity has an answer that is the other side. A node over the same value
 * twice has an answer that is that value.
 */
function foldValue(value: SemanticValue): SemanticValue | null {
  switch (value.k) {
    case "arith": {
      const name = numberType(value);
      if (name === null) return null;
      const left = literalOf(value.left);
      const right = literalOf(value.right);
      if (left !== null && right !== null) {
        if (value.op === "concat") return null;
        const folded = foldArithmetic(value.op, left, right, name);
        if (folded === null) return null;
        // A whole number the compiler writes back as text is read by a backend
        // as text, and text carries a number exactly only to 2^53. An answer
        // past that is written as the shortest thing that reads back as the
        // same double, which is a different number: `-7` divided by two at
        // `u64` is 18446744073709551609, and what it was written as was
        // 18446744073709552000. Such an answer is left as the arithmetic it
        // came from, which the backend computes at the width it wraps to.
        if (isInteger(value.type) && !Number.isSafeInteger(folded)) return null;
        return { k: "const", type: value.type, text: asText(folded) };
      }
      // The identities, each of which holds at the type it is written at.
      if (value.right.k === "const" && right !== null && FLOAT_TYPES[name] !== true) {
        if (value.op === "add" && right === 0) return value.left;
        if (value.op === "sub" && right === 0) return value.left;
        if (value.op === "mul" && right === 1) return value.left;
        if (value.op === "mul" && right === 0 && isInteger(value.type)) return value.left;
        if (value.op === "shl" && right === 0) return value.left;
      }
      if (value.left.k === "const" && left !== null) {
        if (value.op === "add" && left === 0) return value.right;
        if (value.op === "mul" && left === 1) return value.right;
        // `0 - x` is the negation of x, and not x: this returned the right
        // side, so `0 - a.length` printed the length rather than its
        // negation. A whole number negates by the same wrap the subtraction
        // does, so it is the negation; a float does not, because `0.0 - 0.0`
        // is a positive zero and negating a zero is a negative one, so that
        // form is left as the subtraction it was written as.
        if (value.op === "sub" && left === 0 && isInteger(value.type)) {
          return { k: "unary", type: value.type, op: "neg", operand: value.right };
        }
        if (value.op === "div" && left === 0 && right !== null && right !== 0) {
          return { k: "const", type: value.type, text: asText(0) };
        }
      }
      // A value against itself is zero, one, or false, and never a fault: the
      // backends short-circuit the division of equal operands where the fault
      // would otherwise be, so this is the same answer they give.
      if (valueKey(value.left) === valueKey(value.right)) {
        if (value.op === "sub") return { k: "const", type: value.type, text: asText(0) };
        if (value.op === "div" && isInteger(value.type) && numberType(value.left) === null) return null;
        if (value.op === "div" && literalOf(value.left) !== 0) {
          return { k: "const", type: value.type, text: asText(1) };
        }
        if (value.op === "min" || value.op === "max") return value.left;
        if (value.op === "and" || value.op === "or") return value.left;
        if (value.op === "xor") return { k: "const", type: value.type, text: asText(0) };
      }
      // A whole number divided and multiplied by a power of two is a shift,
      // which is the instruction the machine backend has and the division is
      // not. A signed division is left alone: truncation towards zero and a
      // shift disagree about a negative value, which is why
      // `reciprocal-multiply` is a floating point rule.
      if (isInteger(value.type) && value.right.k === "const" && right !== null && right > 0) {
        const exponent = Number.isInteger(Math.log2(right)) ? Math.log2(right) : null;
        if (exponent !== null && exponent >= 1 && (isUnsigned(value.type) || value.left.k === "const")) {
          if (value.op === "div") {
            return { ...value, op: "shr", right: { k: "const", type: value.right.type, text: String(exponent) } };
          }
          if (value.op === "mod" && (isUnsigned(value.type) || (literalOf(value.left) ?? -1) >= 0)) {
            return { ...value, op: "and", right: { k: "const", type: value.right.type, text: String(right - 1) } };
          }
        }
        if (exponent !== null && exponent >= 1 && exponent <= 62) {
          if (value.op === "mul") {
            return { ...value, op: "shl", right: { k: "const", type: value.right.type, text: String(exponent) } };
          }
        }
      }
      return null;
    }
    case "compare": {
      const name = numberType(value.left);
      if (name === null) return null;
      const left = literalOf(value.left);
      const right = literalOf(value.right);
      if (left === null || right === null) return null;
      if (FLOAT_TYPES[name] === true && (Number.isNaN(left) || Number.isNaN(right))) {
        // A comparison with a NaN is false whatever the operator is, except
        // `ne`, which is true. The backends answer it that way too.
        return { k: "bool", type: BOOL, value: value.op === "ne" };
      }
      const answer = compare(value.op, left, right);
      if (answer === null) return null;
      return { k: "bool", type: BOOL, value: answer };
    }
    case "logical": {
      if (value.left.k === "bool" && value.right.k === "bool") {
        return { k: "bool", type: BOOL, value: value.op === "and" ? value.left.value && value.right.value : value.left.value || value.right.value };
      }
      if (value.left.k === "bool" && value.right.k === "const" && FLOAT_TYPES[numberType(value.right) ?? ""] !== true) {
        // `false && x` is false and `true || x` is true, and neither runs x.
        if (value.op === "and" && !value.left.value) return { k: "bool", type: BOOL, value: false };
        if (value.op === "or" && value.left.value) return { k: "const", type: value.type, text: "1" };
      }
      return null;
    }
    case "coalesce": {
      if (value.left.k === "nothing") return value.right;
      return null;
    }
    case "select": {
      if (value.condition.k === "bool") {
        return value.condition.value ? value.then : value.otherwise;
      }
      return null;
    }
    case "unary": {
      const operand = literalOf(value.operand);
      if (value.op === "pos") return value.operand;
      if (value.op === "neg" && operand !== null) {
        const name = numberType(value);
        if (name === null) return null;
        return { k: "const", type: value.type, text: asText(FLOAT_TYPES[name] === true ? -operand : wrapWhole(-operand, name)) };
      }
      if (value.operand.k === "bool") {
        if (value.op === "not") return { k: "bool", type: BOOL, value: !value.operand.value };
        return value.operand;
      }
      return null;
    }
    case "isNull": {
      if (value.operand.k === "nothing") return { k: "bool", type: BOOL, value: value.negate };
      return null;
    }
    case "text": {
      // A string of nothing but literals is a literal.
      if (value.parts.every((part) => part.k === "text")) {
        return { k: "text", type: value.type, parts: value.parts };
      }
      return null;
    }
    default:
      return null;
  }
}

/** What one comparison of two numbers answers, or null when it does not. */
function compare(op: string, left: number, right: number): boolean | null {
  switch (op) {
    case "eq": return left === right;
    case "ne": return left !== right;
    case "lt": return left < right;
    case "le": return left <= right;
    case "gt": return left > right;
    case "ge": return left >= right;
    default: return null;
  }
}
/**
 * Folds a value and everything inside it, outermost first, so an inner fold
 * exposes the outer one. A node that folds is not looked at again.
 */
export function foldSemanticValue(value: SemanticValue): SemanticValue {
  const folded = foldValue(value);
  if (folded !== null) return folded;
  const before = valueChildren(value);
  const children = before.map((child) => foldSemanticValue(child));
  if (children.every((child, index) => child === before[index])) return value;
  return withChildren(value, children);
}

/* -------------------------------------------------------------------------- */
/* Over a function                                                             */
/* -------------------------------------------------------------------------- */

/** Every value a block computes, and every one inside those values. */
function valuesOf(block: SemanticBlock, visit: (value: SemanticValue) => void): void {
  const read = (value: SemanticValue | null): void => {
    if (value !== null) walkSemanticValue(value, visit);
  };
  for (const statement of block.statements) {
    switch (statement.k) {
      case "let":
      case "set":
      case "printText":
      case "printNumber":
      case "retain":
      case "storeField": read(statement.value); break;
      case "step": break;
      case "setElement": read(statement.index); read(statement.value); break;
      case "if": read(statement.condition); break;
      case "raise": read(statement.message); break;
      case "call": visit({ k: "call", type: statement.call.returns, call: statement.call }); break;
      case "loop": {
        const loop = statement.loop;
        if (loop.kind === "counted") {
          read(loop.from); read(loop.to); read(loop.step);
        } else if (loop.kind === "each") {
          read(loop.length);
        } else {
          read(loop.condition);
        }
        break;
      }
      default: break;
    }
  }
  if (block.terminator.k === "return") read(block.terminator.value);
}

/** A block with every value in it folded, and with its nested blocks folded. */
function foldBlock(block: SemanticBlock): boolean {
  let changed = false;
  block.statements = block.statements.map((statement) => {
    const folded = foldStatement(statement);
    if (folded !== statement) changed = true;
    return folded;
  });
  for (const statement of block.statements) {
    for (const nested of statementBlocksOf(statement)) {
      if (foldBlock(nested)) changed = true;
    }
  }
  if (block.terminator.k === "return" && block.terminator.value !== null) {
    const folded = foldSemanticValue(block.terminator.value);
    if (folded !== block.terminator.value) {
      block.terminator = { ...block.terminator, value: folded };
      changed = true;
    }
  }
  return changed;
}

function foldStatement(statement: SemanticStatement): SemanticStatement {
  switch (statement.k) {
    case "let": return { ...statement, value: foldSemanticValue(statement.value) };
    case "set": return { ...statement, value: foldSemanticValue(statement.value) };
    case "step": return statement;
    case "printText": return { ...statement, value: foldSemanticValue(statement.value) };
    case "printNumber": return { ...statement, value: foldSemanticValue(statement.value) };
    case "retain": return { ...statement, value: foldSemanticValue(statement.value) };
    case "storeField": return { ...statement, value: foldSemanticValue(statement.value) };
    case "setElement":
      return { ...statement, index: foldSemanticValue(statement.index), value: foldSemanticValue(statement.value) };
    case "if": return { ...statement, condition: foldSemanticValue(statement.condition) };
    case "raise": return { ...statement, message: foldSemanticValue(statement.message) };
    case "loop": return { ...statement, loop: foldLoop(statement.loop) };
    default: return statement;
  }
}

function foldLoop(loop: SemanticLoop): SemanticLoop {
  if (loop.kind === "counted") {
    return { ...loop, from: foldSemanticValue(loop.from), to: foldSemanticValue(loop.to), step: loop.step === null ? null : foldSemanticValue(loop.step) };
  }
  if (loop.kind === "each") return { ...loop, length: foldSemanticValue(loop.length) };
  return { ...loop, condition: foldSemanticValue(loop.condition) };
}

/* -------------------------------------------------------------------------- */
/* Dropping what nothing reads                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Every name a function reads, counted.
 *
 * The count is what makes the removal safe rather than a guess: a `let` whose
 * name is read nowhere is a value nothing looks at, and a `set` of a name
 * that is overwritten before anything reads it is a value nothing ever saw.
 * Both are counted across the whole function, nested blocks included, because a
 * name declared in an arm is read in that arm and nowhere else.
 */
function readCounts(body: Body): Map<string, number> {
  const counts = new Map<string, number>();
  const count = (name: string): void => {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  };
  const walk = (block: SemanticBlock): void => {
    valuesOf(block, (value) => {
      walkSemanticValue(value, (one) => {
        if (one.k === "local") count(one.name);
      });
    });
    for (const statement of block.statements) {
      for (const nested of statementBlocksOf(statement)) walk(nested);
      // A loop's element and counter are read by the loop statement itself, so
      // they are counted as read whatever the body does with them.
      if (statement.k === "loop" && statement.loop.kind === "each") {
        count(statement.loop.index);
        count(statement.loop.element);
      }
    }
  };
  walk(body.entry);
  return counts;
}

/**
 * Drops the bindings nothing reads.
 *
 * This is what makes the other rules here able to run more than once. Every
 * rewrite that binds a value adds a `let`, and nothing removed them, so a
 * function that had been through a few rounds was carrying the names of them
 * all. A name nothing reads is a value nothing looks at, and the backends
 * still lower it: a `let` is an allocation and a store on every target.
 *
 * A name a `release` names is not dropped. The validator requires a block to
 * release what it allocated, in the order it allocated it, and a name that is
 * gone from the statements is still named by that list, so the two have to go
 * together or the validator is right to refuse the function.
 */
function dropUnread(body: Body): boolean {
  const counts = readCounts(body);
  const keep = (name: string, released: boolean): boolean => released || (counts.get(name) ?? 0) > 0;
  const walk = (block: SemanticBlock): boolean => {
    let changed = false;
    block.statements = block.statements.filter((statement) => {
      if (statement.k === "let") {
        if (keep(statement.slot.name, block.releases.includes(statement.slot.name))) return true;
        changed = true;
        return false;
      }
      return true;
    });
    for (const statement of block.statements) {
      for (const nested of statementBlocksOf(statement)) {
        if (walk(nested)) changed = true;
      }
    }
    if (changed) block.releases = block.releases.filter((name) => counts.has(name) || block.releases.includes(name));
    return changed;
  };
  return walk(body.entry);
}

/**
 * Hoists what a loop reads on every turn and never changes.
 *
 * The rule a review can propose hoists a value the loop computes MORE THAN
 * ONCE, which is the wrong end of it: the value that costs is the one computed
 * exactly once per turn and never at all outside — a bound that is a call, a
 * field read, or an expression over the loop's own parameter. That is what this
 * hoists, and it is hoisted for every loop rather than only for one a model
 * named.
 *
 * The value has to be the same on every turn, which is decided the same way the
 * proposed rule decides it: it may not read a name the loop writes (its
 * counter, its element, or anything the body assigns), and it may not read
 * memory, because the IR holds no length and no null test and a load hoisted
 * out of a turn that did not read it is a read the source never performed.
 */
function hoistLoopInvariants(body: Body): boolean {
  let changed = false;
  const walk = (block: SemanticBlock): void => {
    // A hoist inserts a statement above the loop it hoisted out of, so the
    // index moves under the walk and it is stepped rather than mapped.
    for (let at = 0; at < block.statements.length; at += 1) {
      if (hoistOne(block, at)) {
        changed = true;
        at += 1;
      }
    }
    for (const statement of block.statements) {
      for (const nested of statementBlocksOf(statement)) walk(nested);
    }
  };
  walk(body.entry);
  return changed;
}

/**
 * The values a loop statement carries that do not change between turns.
 *
 * A counted loop's bound and step, a for-of's length, a while's condition: the
 * positions the loop reads on every turn and the body never writes. A counter
 * is not among them — the loop writes it — and neither is anything the body
 * assigns.
 */
function loopInvariants(loop: SemanticLoop): SemanticValue[] {
  if (loop.kind === "counted") return [loop.to, ...(loop.step === null ? [] : [loop.step])];
  if (loop.kind === "each") return [loop.length];
  return [loop.condition];
}

/** Every name a loop and its body write, which an invariant may not read. */
function namesWrittenBy(loop: SemanticLoop): Set<string> {
  const written = new Set<string>();
  if (loop.kind === "counted") written.add(loop.variable);
  else if (loop.kind === "each") {
    written.add(loop.index);
    written.add(loop.element);
  }
  const walk = (block: SemanticBlock): void => {
    for (const statement of block.statements) {
      switch (statement.k) {
        case "set":
        case "step": written.add(statement.name); break;
        case "setElement": written.add(statement.buffer); break;
        case "let": written.add(statement.slot.name); break;
        case "loop": {
          const inner = namesWrittenBy(statement.loop);
          for (const name of inner) written.add(name);
          break;
        }
        default: break;
      }
      for (const nested of statementBlocksOf(statement)) walk(nested);
    }
  };
  walk(loop.body);
  return written;
}

/** A value a hoist may not move: one that reads memory or a name that changes. */
function readsMemoryOrChanges(value: SemanticValue, written: ReadonlySet<string>): boolean {
  let unsafe = false;
  walkSemanticValue(value, (one) => {
    if (one.k === "element" || one.k === "loadField" || one.k === "length") unsafe = true;
    if (one.k === "local" && written.has(one.name)) unsafe = true;
  });
  return unsafe;
}

/**
 * Binds every value of a loop that is worth a name, and rewrites the loop to
 * read them.
 *
 * A value that is already a bare name is not given another: it is what the
 * loop reads today, and a name for it would cost a slot and save nothing. A
 * value that reads memory, or that reads a name the loop or its body writes, is
 * left alone for the reason `hoist-invariant` leaves it alone — it is not the
 * same value on every turn, or computing it on a turn that did not read it is a
 * read the source never performed.
 *
 * The bindings go immediately above the loop, in the block it is written in, so
 * each name is in scope for the loop and for whatever follows it that read the
 * value the loop read.
 */
function hoistOne(owner: SemanticBlock, at: number): boolean {
  const statement = owner.statements[at];
  if (statement === undefined || statement.k !== "loop") return false;
  const written = namesWrittenBy(statement.loop);
  const bindings: SemanticStatement[] = [];
  const reads = new Map<string, SemanticValue>();
  let serial = 0;
  const bind = (value: SemanticValue): void => {
    if (reads.has(valueKey(value))) return;
    const name = `invariant${at}_${serial}`;
    serial += 1;
    reads.set(valueKey(value), { k: "local", type: value.type, name });
    bindings.push({ k: "let", slot: slotFor(value, name), value, line: statement.line });
  };
  loopInvariants(statement.loop).forEach((value) => {
    if (value.k === "local" || value.k === "const") return;
    if (readsMemoryOrChanges(value, written)) return;
    bind(value);
  });
  // The body is where the value that costs is. A loop's own bound is read once
  // per turn and is usually a number or a name the loop reads from the frame;
  // what a body computes every turn is an expression over names nothing in the
  // loop writes, and that one is hoisted here rather than waiting for a model
  // to propose it at a site.
  //
  // Once per turn is enough, and is the case the rule a review proposes cannot
  // reach: `hoist-invariant` binds a value computed MORE THAN ONCE, which is
  // the wrong end of it. A body that computes `n * 2` on every turn of a
  // hundred-turn loop computes it ninety-nine times more than it needs to.
  hoistableIn(statement.loop.body, written).forEach(bind);
  if (bindings.length === 0) return false;
  owner.statements[at] = { ...statement, loop: replaceValues(statement.loop, reads) as SemanticLoop };
  owner.statements.splice(at, 0, ...bindings);
  return true;
}

/**
 * Every value a block computes that is worth computing once above it, once for
 * however many turns run.
 *
 * Every block of it is read, itself included, and a value is in the answer once
 * for anywhere it appears: a body that computes the same value twice is the
 * case the rule a review proposes is for, and one that computes it once is the
 * case the rule cannot reach and costs the most.
 */
function hoistableIn(block: SemanticBlock, written: ReadonlySet<string>): SemanticValue[] {
  const roots: SemanticValue[] = [];
  for (const nested of nestedSemanticBlocks(block)) roots.push(...rootsOf(nested));
  const seen = new Set<string>();
  const hoistable: SemanticValue[] = [];
  for (const value of candidates(roots, written)) {
    const key = valueKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    hoistable.push(value);
  }
  return hoistable;
}

function repeatedAmong(roots: readonly SemanticValue[], written: ReadonlySet<string>): SemanticValue[] {
  const counts = new Map<string, number>();
  for (const value of candidates(roots, written)) {
    counts.set(valueKey(value), (counts.get(valueKey(value)) ?? 0) + 1);
  }
  const all = candidates(roots, written);
  return all.filter((value) => (counts.get(valueKey(value)) ?? 0) > 1);
}

/**
 * Every value a set of roots computes that could be bound to a name: one that
 * is computed rather than read, none of it calls, none of it reads a name the
 * region writes, and it can be computed wherever it is moved to.
 *
 * The three tests are the ones `hoist-invariant` and `common-subexpression`
 * hold a proposal to, so a value this binds and a value a rule binds are the
 * same value. A name and a number are excluded because binding one is a slot
 * and a store where reading it was already one instruction.
 */
function candidates(roots: readonly SemanticValue[], written: ReadonlySet<string>): SemanticValue[] {
  const found: SemanticValue[] = [];
  for (const root of roots) {
    walkSemanticValue(root, (value) => {
      if (value.k === "local" || value.k === "const") return;
      if (!isBindable(value) || hasCall(value) || !isSafeToCompute(value)) return;
      let readsWritten = false;
      walkSemanticValue(value, (one) => {
        if (one.k === "local" && written.has(one.name)) readsWritten = true;
      });
      if (readsWritten) return;
      found.push(value);
    });
  }
  return found;
}

/** Every value a block computes in its own right, without its nested blocks. */
function rootsOf(block: SemanticBlock): SemanticValue[] {
  const roots: SemanticValue[] = [];
  const read = (value: SemanticValue | null): void => {
    if (value !== null) roots.push(value);
  };
  for (const statement of block.statements) {
    switch (statement.k) {
      case "let":
      case "set":
      case "printText":
      case "printNumber":
      case "retain":
      case "storeField": read(statement.value); break;
      case "setElement": read(statement.index); read(statement.value); break;
      case "if": read(statement.condition); break;
      case "raise": read(statement.message); break;
      case "call": roots.push({ k: "call", type: statement.call.returns, call: statement.call }); break;
      case "loop": {
        const loop = statement.loop;
        if (loop.kind === "counted") {
          read(loop.from);
          read(loop.to);
          read(loop.step);
        } else if (loop.kind === "each") read(loop.length);
        else read(loop.condition);
        break;
      }
      default: break;
    }
  }
  if (block.terminator.k === "return") read(block.terminator.value);
  return roots;
}

/**
 * Commoning every value a block computes more than once, at the top of that
 * block.
 *
 * This is the rewrite a review can only propose at a site it names, so it
 * happens only when a model happens to name the right block. The values are the
 * ones `common-subexpression` holds a proposal to, so what this binds and what
 * that binds are the same values: computed rather than read, nothing in them
 * calls, and computable wherever they are moved to — which is what makes
 * computing one on a turn that did not read it the same program.
 *
 * The bindings go at the top of the block, which is above every statement that
 * reads one of them and below every statement that writes a name one of them
 * reads, so each is computed once and is the same value everywhere it is used.
 */
function commonWithin(body: Body): boolean {
  let changed = false;
  const walk = (block: SemanticBlock): void => {
    if (commonOne(block)) changed = true;
    for (const statement of block.statements) {
      for (const nested of statementBlocksOf(statement)) walk(nested);
    }
  };
  walk(body.entry);
  return changed;
}

function commonOne(block: SemanticBlock): boolean {
  const repeated = repeatedAmong(rootsOf(block), namesWrittenHere(block));
  if (repeated.length === 0) return false;
  const line = block.statements[0]?.line ?? 0;
  const reads = new Map<string, SemanticValue>();
  const bindings: SemanticStatement[] = [];
  repeated.forEach((value, order) => {
    const name = `common${block.id}_${order}`;
    reads.set(valueKey(value), { k: "local", type: value.type, name });
    bindings.push({ k: "let", slot: slotFor(value, name), value, line });
  });
  block.statements = block.statements.map((statement) => replaceValues(statement, reads) as SemanticStatement);
  if (block.terminator.k === "return" && block.terminator.value !== null) {
    block.terminator = { ...block.terminator, value: replaceValues(block.terminator.value, reads) };
  }
  block.statements.unshift(...bindings);
  return true;
}

/** Every name the statements of a block write, which a binding may not read. */
function namesWrittenHere(block: SemanticBlock): Set<string> {
  const written = new Set<string>();
  for (const statement of block.statements) {
    if (statement.k === "set" || statement.k === "step") written.add(statement.name);
    if (statement.k === "setElement") written.add(statement.buffer);
    if (statement.k === "let") written.add(statement.slot.name);
  }
  return written;
}

/**
 * Replaces every read of a name whose value is another name with a read of
 * that one, and drops the binding.
 *
 * A copy of a name is a slot, a store and a load on every read, for a name the
 * program already has. It is the same program only where nothing writes the
 * name it copies between the binding and the reads: a program that counts a
 * name down and reads the copy afterwards is reading the number it started
 * with, not the one the counter holds now. Nothing writing that name anywhere
 * in the function is the test that says so without having to place every read
 * against every write.
 */
function propagateCopies(body: Body): boolean {
  const writes = new Set<string>();
  const candidates: { name: string; source: string }[] = [];
  for (const block of nestedSemanticBlocks(body.entry)) {
    for (const statement of block.statements) {
      if (statement.k === "set" || statement.k === "step") writes.add(statement.name);
      if (statement.k === "let" && statement.value.k === "local") {
        candidates.push({ name: statement.slot.name, source: statement.value.name });
      }
    }
  }
  const copied = candidates.filter((copy) => !writes.has(copy.source) && !writes.has(copy.name));
  if (copied.length === 0) return false;
  // Keyed by the read of the copy rather than by the read it becomes, because
  // that is the node `replaceValues` finds.
  const reads = new Map<string, SemanticValue>();
  for (const copy of copied) {
    const type = localTypeOf(body, copy.name);
    reads.set(valueKey({ k: "local", type, name: copy.name }), { k: "local", type, name: copy.source });
  }
  const isCopy = (name: string): boolean => copied.some((copy) => copy.name === name);
  const walk = (block: SemanticBlock): void => {
    block.statements = block.statements
      .filter((statement) => !(statement.k === "let" && isCopy(statement.slot.name)))
      .map((statement) => replaceValues(statement, reads) as SemanticStatement);
    for (const statement of block.statements) {
      for (const nested of statementBlocksOf(statement)) walk(nested);
    }
    if (block.terminator.k === "return" && block.terminator.value !== null) {
      block.terminator = { ...block.terminator, value: replaceValues(block.terminator.value, reads) };
    }
    block.releases = block.releases.filter((name) => !isCopy(name));
  };
  walk(body.entry);
  return true;
}

/** The type a name is read as, which is the type its own binding declares. */
function localTypeOf(body: Body, name: string): SemanticType {
  for (const parameter of body.params) if (parameter.name === name) return slotType(parameter);
  for (const block of nestedSemanticBlocks(body.entry)) {
    for (const statement of block.statements) {
      if (statement.k === "let" && statement.slot.name === name) return slotType(statement.slot);
      if (statement.k === "loop") {
        const loop = statement.loop;
        if (loop.kind === "counted" && loop.variable === name) return loop.type;
        if (loop.kind === "each" && loop.element === name) return loop.elementType;
      }
    }
  }
  return { kind: "primitive", name: "bool" };
}

/**
 * Drops a write nothing reads afterwards.
 *
 * A `set` of a name no other statement of the function reads is a value nothing
 * ever saw, and on every target it is a slot, a store and the arithmetic that
 * produced it. One that writes something a call makes is left alone: running
 * the call is what the statement is for when nothing reads what it wrote.
 */
function dropDeadWrites(body: Body): boolean {
  const reads = new Map<string, number>();
  for (const block of nestedSemanticBlocks(body.entry)) {
    valuesOf(block, (value) => {
      walkSemanticValue(value, (one) => {
        if (one.k === "local") reads.set(one.name, (reads.get(one.name) ?? 0) + 1);
      });
    });
  }
  let changed = false;
  for (const block of nestedSemanticBlocks(body.entry)) {
    const before = block.statements.length;
    block.statements = block.statements.filter((statement) => {
      if (statement.k !== "set" || statement.op !== "=") return true;
      if (block.releases.includes(statement.name)) return true;
      if ((reads.get(statement.name) ?? 0) > 0) return true;
      let calls = false;
      walkSemanticValue(statement.value, (one) => {
        if (one.k === "call") calls = true;
      });
      return calls;
    });
    if (block.statements.length !== before) changed = true;
  }
  return changed;
}

/**
 * Takes the arm an `if` whose condition folded to a truth selects, where that
 * can be done without merging two scopes into one.
 *
 * The arms are blocks of their own, so a name one of them declares belongs to
 * it; splicing it into the block the `if` is written in would put that name in
 * a scope it was not declared in, which is left alone rather than renamed.
 */
function pruneKnownBranches(block: SemanticBlock): boolean {
  let changed = false;
  block.statements = block.statements.flatMap((statement) => {
    if (statement.k !== "if" || statement.condition.k !== "bool") return [statement];
    const taken = statement.condition.value ? statement.then : statement.otherwise;
    if (taken === null) {
      changed = true;
      return [];
    }
    if (taken.statements.some(claimsAName)) return [statement];
    changed = true;
    return taken.statements;
  });
  return changed;
}

/** Whether a statement declares a name, which is what stops an arm splicing. */
function claimsAName(statement: SemanticStatement): boolean {
  if (statement.k === "let") return true;
  if (statement.k === "loop") return statement.loop.kind !== "while" && statement.loop.kind !== "doWhile";
  return false;
}

/**
 * What the rewrites read of a function: the body they walk and the names that
 * are already bound in it. A program has the same body and no parameters of its
 * own, which is why this is one shape rather than two entry points over two.
 */
interface Body {
  readonly params: readonly SemanticSlot[];
  readonly entry: SemanticBlock;
}

/* -------------------------------------------------------------------------- */
/* The pass                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Applies the deterministic rewrites to a function, to a fixed point.
 *
 * The point is bounded rather than open-ended: each round folds what the last
 * one exposed, and a round that changes nothing ends it. A fold that makes two
 * computations the same one is what lets the next round find them, so stopping
 * after one pass would leave most of what there is to find unfound.
 *
 * The round is written the way the rewrites are: each one says whether it
 * changed anything, and a round that none of them did is the round after which
 * nothing more would be. Comparing the tree against a copy of itself by
 * writing both out as text is the same answer for far more work.
 */
export function optimizeSemanticFunction(fn: SemanticFunction): SemanticFunction {
  optimizeBody(fn);
  return fn;
}

/**
 * The same rewrites over a program's entry, which is a body with no parameters
 * of its own.
 *
 * A program's statements are the same shape a function's are and reach the
 * same backends, so they are held to the same rewrites: a top-level loop of a
 * program is a loop like any other, and the value its body computes on every
 * turn is computed once above it here as it is in a function.
 */
export function optimizeSemanticEntry(entry: SemanticBlock): SemanticBlock {
  optimizeBody({ params: [], entry });
  return entry;
}

/**
 * The same rewrites over a whole program, which is a body under the functions it
 * calls: the statements of the program itself, with nothing bound in it but what
 * those statements declare.
 */
export function optimizeSemanticProgram(program: SemanticProgram): SemanticProgram {
  optimizeSemanticEntry(program.entry);
  return program;
}

function optimizeBody(body: Body): void {
  for (let round = 0; round < 8; round += 1) {
    let changed = false;
    if (foldAll(body)) changed = true;
    if (pruneAll(body)) changed = true;
    if (hoistLoopInvariants(body)) changed = true;
    if (commonWithin(body)) changed = true;
    if (propagateCopies(body)) changed = true;
    if (dropDeadWrites(body)) changed = true;
    if (dropUnread(body)) changed = true;
    if (!changed) break;
  }
}

/** Folds every block of the function, nested ones included. */
function foldAll(body: Body): boolean {
  let changed = false;
  for (const block of nestedSemanticBlocks(body.entry)) {
    if (foldBlock(block)) changed = true;
  }
  return changed;
}

/** Takes the arm of every `if` whose condition is already a truth. */
function pruneAll(body: Body): boolean {
  let changed = false;
  for (const block of nestedSemanticBlocks(body.entry)) {
    if (pruneKnownBranches(block)) changed = true;
  }
  return changed;
}

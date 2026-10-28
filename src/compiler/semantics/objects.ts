/**
 * Objects: what a function allocates, and where every field of it sits.
 *
 * A function that allocates writes objects where it writes them, so its result
 * cannot be stated as one expression. What the contract can state is the layout
 * of each object: the fields it holds, their types, and the offset of each, so
 * a backend allocates exactly the bytes the source describes and reads a field
 * at the offset the contract names.
 *
 * The pass runs over the whole program, not one function, because a field is
 * often what another function returns: the tree `createTree` builds is the
 * object whose fields `checksum` reads. Objects are therefore named once for
 * the program, by the fields they hold, so two objects written with the same
 * fields are one object whichever function wrote them.
 */

import type { Expression, Statement } from "../core/ir.ts";
import { CompilerError } from "../core/errors.ts";
import type { FileContract, FunctionContract, ObjectLayout, PrimitiveTypeName, TypeExpr } from "../core/types.ts";
import { isWhole, isWide, LIMB_BYTES, limbsOf } from "../core/semantic-ir.ts";
import { builtinFor } from "./builtins.ts";
import { wholeText } from "./whole-arithmetic.ts";
import { isFloatType, parseType, typeToString } from "./contract.ts";
import type { LiteralKeys } from "./program-objects.ts";
import type { ProgramValue } from "./module.ts";

/** The number a reference takes: one pointer. */
const POINTER_SIZE = 8;

export const F64: TypeExpr = { kind: "primitive", name: "f64" };
export const I64: TypeExpr = { kind: "primitive", name: "i64" };
/** The wide number a whole value too large for a machine word is held at. */
const U256: TypeExpr = { kind: "primitive", name: "u256" };

/**
 * The type a `BigInt(...)` of a written value is held at, or null where the
 * argument is not a value the layout pass can read.
 *
 * The body builder folds the call to a literal, and this is the same fold at
 * the one place that runs before it: the type a field holds is decided here,
 * and it has to be the type the value the builder writes is held at.
 */
function bigIntInferred(argument: Expression | undefined): TypeExpr | null {
  if (argument === undefined) return null;
  const text = argument.k === "literal"
    ? argument.text
    : argument.k === "text" && argument.parts.length === 1 && argument.parts[0].k === "text"
      ? argument.parts[0].value
      : null;
  if (text === null) return null;
  const value = wholeText(text);
  if (value === null) return null;
  return value <= 9223372036854775807n && value >= -9223372036854775808n ? I64 : U256;
}

export const USIZE: TypeExpr = { kind: "primitive", name: "usize" };
export const BOOL: TypeExpr = { kind: "primitive", name: "bool" };
/** A reference to an object whose fields the source never pins down. */
export const ANY_REF: TypeExpr = { kind: "ref", of: null };

const COMPARISONS: Record<string, true> = { "<": true, "<=": true, ">": true, ">=": true, "===": true, "!==": true, "==": true, "!=": true };
const LOGICAL: Record<string, true> = { "&&": true, "||": true };

/**
 * What an expression is: a type, or a reference to an object the source wrote.
 * The rules that decide it are exported, because the IR that describes a
 * function body types the same expressions and must reach the same answers: one
 * set of rules, written once, rather than two that drift.
 */
export type Inferred = { kind: "type"; type: TypeExpr } | { kind: "object"; key: string };

/** One object the source writes, before it is named and laid out. */
export interface Shape {
  key: string;
  fields: { name: string; value: Inferred }[];
}

function objectsError(message: string, detail?: string): CompilerError {
  return new CompilerError({ category: "ContractError", stage: "contract", message, detail });
}

/**
 * The size of one field in bytes, and the alignment it is placed at.
 *
 * A scalar is its width, a whole number wider than a machine word is its limbs,
 * and anything else a pointer. The wide case is the one that cannot be left to
 * the default: a `u256` is four limbs of eight bytes and every backend holds it
 * that way, so a layout that gave it the default reserved eight bytes for a
 * thirty-two byte value and placed every field after it twenty-four bytes too
 * early — the backends write the field at the offset the contract names, so
 * they wrote over their neighbours.
 *
 * A wide number is a sequence of limbs rather than one indivisible thing, so it
 * is placed at the alignment of a limb and not at its own size: aligning a
 * thirty-two byte field to thirty-two would pad every object holding one so
 * that most of it is addressable memory nothing was ever written to.
 */
function fieldLayout(type: TypeExpr): { size: number; align: number } {
  if (type.kind !== "primitive") return { size: POINTER_SIZE, align: POINTER_SIZE };
  const limbs = limbsOf(type.name);
  if (limbs !== null) return { size: limbs * LIMB_BYTES, align: LIMB_BYTES };
  const size = scalarSize(type.name);
  return { size, align: size };
}

/** The width of a scalar, which is also the alignment it is placed at. */
function scalarSize(name: PrimitiveTypeName): number {
  switch (name) {
    case "bool":
    case "i8":
    case "u8":
      return 1;
    case "i16":
    case "u16":
      return 2;
    case "i32":
    case "u32":
    case "f32":
      return 4;
    default:
      return 8;
  }
}

function alignUp(offset: number, align: number): number {
  return align <= 1 ? offset : Math.ceil(offset / align) * align;
}

/**
 * Walks one function, typing every expression it evaluates and registering
 * every object it writes. The environment is what the function knows: its
 * parameters as declared, and its own declarations as inferred.
 */
class BodyTypes {
  private environment = new Map<string, Inferred>();
  private readonly results: Inferred[] = [];
  readonly path: string;
  readonly functionName: string;
  private readonly callees: Map<string, TypeExpr>;

  constructor(
    path: string,
    functionName: string,
    params: readonly { name: string; type: TypeExpr }[],
    callees: Map<string, TypeExpr>,
  ) {
    this.path = path;
    this.functionName = functionName;
    this.callees = callees;
    for (const param of params) this.environment.set(param.name, { kind: "type", type: param.type });
  }

  /** The type every return of the function gives, when they agree. */
  result(): Inferred | null {
    const first = this.results[0];
    if (first === undefined) return null;
    const same = this.results.every((entry) => describe(entry) === describe(first));
    return same ? first : null;
  }

  statements(list: readonly Statement[]): void {
    for (const statement of list) this.statement(statement);
  }

  private statement(statement: Statement): void {
    switch (statement.kind) {
      case "declare": {
        const value = this.expression(statement.init);
        // An object literal is what the body stores, and an annotation does
        // not narrow that. Binding the name as the annotated type left
        // `o.field = ...` with nowhere to record what it wrote, so the field
        // was missing from the layout and the body wrote past the end of the
        // object it had allocated.
        const annotated: Inferred = statement.type === null ? value : { kind: "type", type: statement.type };
        this.environment.set(statement.name, value.kind === "object" ? value : annotated);
        return;
      }
      case "assign": {
        const value = this.expression(statement.value);
        // A plain assignment changes what the name holds, and the layout is
        // built from what the body stores. A compound one adds to what was
        // there, so the type it had still holds.
        if (statement.op === "=" || !this.environment.has(statement.target)) {
          this.environment.set(statement.target, value);
        }
        return;
      }
      case "memberAssign": {
        const value = this.expression(statement.value);
        const base = this.environment.get(statement.base);
        if (base !== undefined && base.kind === "object") this.write(base.key, statement.field, value);
        return;
      }
      case "indexAssign":
        this.expression(statement.index);
        this.expression(statement.value);
        return;
      case "update":
        return;
      case "print":
      case "expression":
        this.expression(statement.value);
        return;
      case "result":
        this.results.push(this.expression(statement.value));
        return;
      case "loop": {
        // The index is what the loop counts with, which is the value it starts
        // at and the value it moves by. Typing it `usize` whatever it was
        // written at made a field the body wrote from a counter a different
        // type from the same field written from a written number, and an
        // object two functions build the same way is one object to the
        // program, so the build was refused over a counter.
        const from = this.expression(statement.from);
        this.expression(statement.to);
        const step = statement.step === null ? null : this.expression(statement.step);
        const counted = from.kind === "type" ? (step === null || step.kind !== "type" ? from.type : numeric(from, step)) : null;
        // A loop body is a scope, as an `if` arm is: a name declared in it is
        // not in scope after it, and the index is not in scope before it.
        this.branch(statement.body, statement.variable, { kind: "type", type: counted ?? USIZE });
        return;
      }
      case "if":
        this.expression(statement.condition);
        this.branch(statement.then);
        this.branch(statement.otherwise);
        return;
      case "while":
      case "doWhile":
        this.expression(statement.condition);
        this.branch(statement.body);
        return;
      case "forOf":
        // The loop walks a name it is given, so its variable is one element of it.
        this.branch(statement.body, statement.variable, { kind: "type", type: this.element(statement.of) });
        return;
      case "break":
      case "continue":
        return;
    }
  }

  /**
   * A branch sees what came before it and declares nothing for what follows.
   * One flat environment let a name declared in one arm be read in the other
   * and after the statement, so a body the source would not compile passed.
   * A loop body is a branch like any other, and the name it counts with is
   * bound in it rather than before it, so it shadows an outer name for the
   * loop alone.
   */
  private branch(body: readonly Statement[], variable?: string, bound?: Inferred): void {
    const outer = this.environment;
    this.environment = new Map(outer);
    if (variable !== undefined && bound !== undefined) this.environment.set(variable, bound);
    try {
      this.statements(body);
    } finally {
      this.environment = outer;
    }
  }

  private expression(expression: Expression): Inferred {
    switch (expression.k) {
      case "literal":
        return { kind: "type", type: F64 };
      case "bigint": {
        const trimmed = expression.text.trim();
        let literal: bigint | null = null;
        try { literal = BigInt(trimmed); } catch { literal = null; }
        const outOfRange = literal === null || literal > 9223372036854775807n || literal < -9223372036854775808n;
        return { kind: "type", type: outOfRange ? { kind: "primitive", name: "u256" } : I64 };
      }
      case "null":
        return { kind: "type", type: ANY_REF };
      case "ident": {
        const bound = this.environment.get(expression.name);
        if (bound !== undefined) return bound;
        throw objectsError(
          `${this.path}: ${this.functionName} uses "${expression.name}" before it is declared`,
          "a compiled function declares every name it uses before it uses it",
        );
      }
      case "argv":
        if (expression.index !== null) this.expression(expression.index);
        return { kind: "type", type: expression.index === null ? USIZE : F64 };
      case "length":
        return { kind: "type", type: USIZE };
      case "index": {
        const base = this.expression(expression.base);
        this.expression(expression.index);
        return { kind: "type", type: base.kind === "object" ? ANY_REF : elementOf(base) };
      }
      case "slice": {
        const base = this.expression(expression.base);
        if (expression.start !== null) this.expression(expression.start);
        if (expression.stop !== null) this.expression(expression.stop);
        if (expression.step !== null) this.expression(expression.step);
        return { kind: "type", type: base.kind === "object" ? ANY_REF : (base.kind === "type" && base.type.kind === "array" ? base.type : { kind: "array", of: elementOf(base), length: null }) };
      }
      case "member": {
        const base = this.expression(expression.base);
        if (base.kind === "object") return this.field(base.key, expression.field);
        return { kind: "type", type: ANY_REF };
      }
      case "call": {
        for (const argument of expression.args) this.expression(argument);
        // `BigInt(x)` of a value written out is the whole number it names, and
        // the builder that lowers the body folds it to the literal. What the
        // layout pass needs is the type it is held at, which is the type of the
        // literal the fold produces.
        if (expression.name === "BigInt") {
          const inferred = bigIntInferred(expression.args[0]);
          if (inferred !== null) return { kind: "type", type: inferred };
        }
        const builtin = builtinFor(expression.name);
        if (builtin !== null) {
          const allowed = builtin.arities ?? [builtin.arity ?? builtin.params.length];
          if (!allowed.includes(expression.args.length)) {
            throw objectsError(
              `${expression.name} takes ${allowed.join(" or ")} argument${allowed.length === 1 && allowed[0] === 1 ? "" : "s"}`,
              `${this.path}: ${this.functionName} calls it with ${expression.args.length}`,
            );
          }
          // A string is a reference the contract language does not spell, so
          // what a use infers of it is the same as what it infers of any other
          // reference.
          return { kind: "type", type: builtin.returns.kind === "text" ? ANY_REF : builtin.returns };
        }
        const returns = this.callees.get(expression.name);
        if (returns === undefined) {
          throw objectsError(
            `${this.path}: ${this.functionName} calls "${expression.name}", which the program does not compile`,
            "a function may only call the functions of the program it is part of",
          );
        }
        this.call(expression.name);
        return { kind: "type", type: returns };
      }
      case "object":
        return { kind: "object", key: this.object(expression.fields) };
      case "fixed":
        // The number is read to write it out, so the value it is written of is
        // walked: a name it reads is a name the body has to have declared.
        this.expression(expression.of);
        return { kind: "type", type: F64 };
      case "sized":
        // The count is read to size the block, and the elements are the names
        // the body reaches through the array afterwards, so both are walked: a
        // count that reads an object the body has not declared yet is the same
        // fault here as anywhere else.
        this.expression(expression.count);
        return { kind: "type", type: { kind: "array", of: parseType(expression.element), length: null } };
      case "buffer":
        for (const value of expression.values) this.expression(value);
        return {
          kind: "type",
          type: { kind: "array", of: parseType(expression.element), length: expression.values.length },
        };
      case "text":
        for (const part of expression.parts) {
          if (part.k === "value") this.expression(part.value);
        }
        return { kind: "type", type: F64 };
      case "binary": {
        const left = this.expression(expression.left);
        const right = this.expression(expression.right);
        if (COMPARISONS[expression.op] === true || LOGICAL[expression.op] === true) return { kind: "type", type: BOOL };
        // `??` is neither a comparison nor a short circuit: it hands back one
        // of its operands, so a reference stays a reference instead of
        // becoming the double every other operator is.
        if (expression.op === "??") return coalesce(left, right);
        return { kind: "type", type: numeric(left, right) };
      }
      case "unary": {
        // The operand is walked even for `!`, so a name it uses and an object
        // it allocates are found the way any other operand's are.
        const operand = this.expression(expression.operand);
        return expression.op === "!" ? { kind: "type", type: BOOL } : operand;
      }
      case "conditional": {
        this.expression(expression.condition);
        // Both branches are walked so both objects are laid out, but a choice
        // returns whichever branch it takes: the two name the same thing or
        // the function returns no one object. Reading the type off the branch
        // the source wrote last narrowed the return to an object the other
        // branch never returns, and the code reading it went past the end of
        // a smaller one.
        const first = this.expression(expression.then);
        const second = this.expression(expression.otherwise);
        return describe(first) === describe(second) ? first : { kind: "type", type: ANY_REF };
      }
      case "update":
        return this.environment.get(expression.name) ?? { kind: "type", type: F64 };
    }
  }

  /** What one element of a named buffer holds. */
  private element(name: string): TypeExpr {
    return elementOf(this.expression({ k: "ident", name }));
  }

  /** Registers the object a literal writes, and returns its key. */
  private object(fields: readonly { name: string; value: Expression }[]): string {
    const typed = fields.map((field) => ({ name: field.name, value: this.expression(field.value) }));
    // The key is a function of the shape alone, and the shape is written as
    // JSON so that a field name cannot read like the key of another shape:
    // `{ a: 1, b: 2 }` and `{ "a:f64,b": 2 }` hold different fields, and
    // joining the names and their types with a separator gave both one.
    const key = JSON.stringify(typed.map((field) => [field.name, describe(field.value)]));
    if (!this.registered.has(key)) this.registered.set(key, { key, fields: typed });
    return key;
  }

  /**
   * The value a field of a known object holds, or a reference when it is not
   * one.
   *
   * A field of a shape this body can name is counted as it is read. A field of
   * an `any` is not: nothing says which object an `any` refers to, so the read
   * is counted against no shape and the field stays where the source wrote it.
   */
  private field(key: string, name: string): Inferred {
    const shape = this.registered.get(key);
    const field = shape?.fields.find((entry) => entry.name === name);
    if (field !== undefined) {
      const read = this.reads.get(key);
      if (read === undefined) this.reads.set(key, new Map([[name, 1]]));
      else read.set(name, (read.get(name) ?? 0) + 1);
    }
    return field?.value ?? { kind: "type", type: ANY_REF };
  }

  /** How often each field of each object this body reads was read. */
  readonly reads = new Map<string, Map<string, number>>();

  /**
   * What a field holds once the body has written it. A layout is what the
   * body stores, so a field written as `null` and then as a number is a
   * number, and a field the body writes but the literal never held is a
   * field of the object.
   */
  private write(key: string, name: string, value: Inferred): void {
    const shape = this.registered.get(key);
    if (shape === undefined) return;
    const field = shape.fields.find((entry) => entry.name === name);
    if (field === undefined) shape.fields.push({ name, value });
    else field.value = value;
  }

  /** Every object this function wrote, for the program to name. */
  readonly registered = new Map<string, Shape>();

  /**
   * Every key this body holds an object under, folded onto the key the object is
   * now the same as. A name bound to a value holds the key in the binding, in
   * the shape the literal was registered under and in what the function answers,
   * and a field that says nothing about what it points at is what made two keys
   * one object in the first place.
   */
  renameObjects(remapped: ReadonlyMap<string, string>): void {
    const key = (was: string): string => remapped.get(was) ?? was;
    const value = (inferred: Inferred): Inferred =>
      inferred.kind === "object" ? { kind: "object", key: key(inferred.key) } : inferred;
    const shapes = new Map<string, Shape>();
    for (const [was, shape] of this.registered) {
      shapes.set(key(was), {
        key: key(was),
        fields: shape.fields.map((field) => ({ name: field.name, value: value(field.value) })),
      });
    }
    this.registered.clear();
    for (const [at, shape] of shapes) this.registered.set(at, shape);
    for (const [name, bound] of this.environment) this.environment.set(name, value(bound));
    for (const [at, result] of this.results.entries()) this.results[at] = value(result);
  }
  /**
   * Every program function this body calls, in the order it first calls each.
   * A builtin is not one: the driver answers it, so it is not a symbol this
   * build emits and there is nothing to decide about it.
   */
  readonly called: string[] = [];

  /** Records a call the body makes, once however many times it makes it. */
  private call(name: string): void {
    if (!this.called.includes(name)) this.called.push(name);
  }
}

export function describe(value: Inferred): string {
  return value.kind === "object" ? `object(${value.key})` : typeToString(value.type);
}

export function elementOf(value: Inferred): TypeExpr {
  if (value.kind === "object") return ANY_REF;
  return value.type.kind === "primitive" ? value.type : elementOfType(value.type);
}

function elementOfType(type: TypeExpr): TypeExpr {
  if (type.kind === "primitive" || type.kind === "ref" || type.kind === "void" || type.kind === "text") return F64;
  return type.of ?? F64;
}

/**
 * True when a number written in the source is a whole number, whatever width
 * it is read at.
 *
 * The text decides it rather than the type, because a number the source wrote
 * without a point is a whole number however a use goes on to hold it: `0` is
 * `0` whether it is read as a double or as a machine word, and reading it as a
 * whole number does not reinterpret it.
 */
export function isWholeNumberText(text: string): boolean {
  return /^[+-]?\d+$/.test(text) || /^[+-]?0[xX][0-9a-fA-F]+$/.test(text);
}

/**
 * Whether a loop counts in whole numbers, asked of what it is built from.
 *
 * The bound the loop counts to is deliberately not part of the answer, and that
 * is the whole of the rule. A bound says where counting ends and not what is
 * counted, so a loop that starts at 0 and moves by 1 counts in whole numbers
 * however large the number it stops at — which is the loop the parallel rule
 * can hand to OpenMP, since a canonical loop is exactly this shape.
 *
 * A start or a step that is not whole decides the other way. Reading `0.5` as a
 * whole number truncates it where it was written and counts from the wrong
 * place, which is a different program rather than a faster one, so a loop that
 * starts in halves stays in halves however whole its bound is.
 *
 * A step written `i += 2` reaches here wrapped in a unary, because that is how
 * the parser reads a step that is not one, so the sign is looked through: `+2`
 * is the whole number 2, and a `-` in front of it is not a step a counted loop
 * counts down by — a downward loop says so with `>` rather than with a negative
 * step.
 *
 * This lives here rather than in either resolver because both ask it and the
 * two answers must be one: `for (let i = 0; i < 4; i += 1)` is the same loop
 * whether it is written at the top of a module or inside a function body, and
 * the two paths once answered differently — an `i64` counter in one and an
 * `f64` counter in the other, for one line of source.
 */
export function countsWholeNumber(expression: Expression, inferred: Inferred): boolean {
  if (expression.k === "literal") return isWholeNumberText(expression.text);
  if (expression.k === "unary" && expression.op === "+") return countsWholeNumber(expression.operand, inferred);
  return inferred.kind === "type" && inferred.type.kind === "primitive" && isWhole(inferred.type.name);
}

/**
 * Whether a loop body is written entirely in whole numbers, which is what makes
 * a whole-number counter in it a change of width rather than a change of
 * program.
 *
 * The counter is a whole number wherever the source starts it at a whole number
 * and moves it by one, and the module-level resolver has said so for every
 * module-level loop since it was written. Inside a function body the counter
 * reaches arithmetic that is resolved at the width of what surrounds it, so
 * widening it there is only safe where the body was whole to begin with: a body
 * that computes `total += i * j` over a double accumulator reads the counter
 * through the accumulator's width, and an `i64` in that expression is a number
 * the source never wrote.
 *
 * So this is asked of the body as it is written, and it answers yes only for a
 * body whose every number is a whole number: no fractional literal anywhere in
 * it, and no name read that is not itself a whole number the body was given.
 * That is the narrow case — a loop that counts elements, indexes with the
 * counter and stores whole numbers — and it is the case the parallel rule can
 * hand to a thread, because there is no arithmetic in it to disagree about.
 */
export function bodyIsWhole(body: readonly Statement[], counter: string, whole: ReadonlySet<string>): boolean {
  for (const statement of body) {
    switch (statement.kind) {
      case "declare":
        if (!whole.has(statement.name) && !expressionIsWhole(statement.init, counter, whole)) return false;
        break;
      case "loop":
        if (!expressionIsWhole(statement.from, counter, whole) || !expressionIsWhole(statement.to, counter, whole)) return false;
        if (statement.step !== null && !expressionIsWhole(statement.step, counter, whole)) return false;
        if (!bodyIsWhole(statement.body, statement.variable, whole)) return false;
        break;
      case "assign":
      case "memberAssign":
        if (!expressionIsWhole(statement.value, counter, whole)) return false;
        break;
      case "update":
        if (!whole.has(statement.name)) return false;
        break;
      case "result":
        if (!expressionIsWhole(statement.value, counter, whole)) return false;
        break;
      case "if":
        if (!expressionIsWhole(statement.condition, counter, whole)) return false;
        if (!bodyIsWhole(statement.then, counter, whole) || !bodyIsWhole(statement.otherwise, counter, whole)) return false;
        break;
      case "while":
      case "doWhile":
        if (!expressionIsWhole(statement.condition, counter, whole)) return false;
        if (!bodyIsWhole(statement.body, counter, whole)) return false;
        break;
      case "forOf":
        if (!bodyIsWhole(statement.body, statement.variable, whole)) return false;
        break;
      case "print":
        if (!expressionIsWhole(statement.value, counter, whole)) return false;
        break;
      default:
        break;
    }
  }
  return true;
}

/**
 * Whether a loop body never reads the counter of the loop it is written in.
 *
 * A counter the body does not read is a counter whose width reaches no
 * arithmetic at all: the loop counts with it, and nothing else does. Widening it
 * therefore changes no answer, whatever the rest of the body is written in — a
 * body that builds a tree and adds up a checksum calls two functions and is not a
 * body of whole numbers by any reading, but its counter is read by neither, so
 * the counter may be a whole number all the same.
 *
 * This is what `bodyIsWhole` cannot see. That asks whether the arithmetic is
 * whole, and answers no for a body that calls anything; this asks the narrower
 * question of the counter alone, and the two together widen a counter wherever
 * either holds. A loop whose body does read its counter still needs the whole
 * body to be whole, because there the counter's width is the width the
 * arithmetic runs at.
 *
 * A loop nested inside this one that declares a name of its own shadows the
 * counter for its own body, so a read there is not a read of this counter.
 */
export function bodyIgnoresCounter(body: readonly Statement[], counter: string, shadowed = false): boolean {
  for (const statement of body) {
    switch (statement.kind) {
      case "loop": {
        const hides = shadowed || statement.variable === counter;
        if (expressionReads(statement.from, counter) || expressionReads(statement.to, counter)) return false;
        if (statement.step !== null && expressionReads(statement.step, counter)) return false;
        if (!bodyIgnoresCounter(statement.body, counter, hides)) return false;
        break;
      }
      case "forOf": {
        const hides = shadowed || statement.variable === counter;
        if (!bodyIgnoresCounter(statement.body, counter, hides)) return false;
        break;
      }
      case "if": {
        if (!shadowed && expressionReads(statement.condition, counter)) return false;
        if (!bodyIgnoresCounter(statement.then, counter, shadowed)) return false;
        if (!bodyIgnoresCounter(statement.otherwise, counter, shadowed)) return false;
        break;
      }
      case "while":
      case "doWhile":
        if (!shadowed && expressionReads(statement.condition, counter)) return false;
        if (!bodyIgnoresCounter(statement.body, counter, shadowed)) return false;
        break;
      case "declare":
      case "assign":
      case "update":
      case "result":
      case "print":
        if (!statementIgnoresCounter(statement, counter, shadowed)) return false;
        break;
      default:
        break;
    }
  }
  return true;
}

/** Whether a statement reads the counter of a loop, unless something shadows it. */
function statementIgnoresCounter(statement: Statement, counter: string, shadowed: boolean): boolean {
  if (shadowed) return true;
  const values: Expression[] = [];
  switch (statement.kind) {
    case "declare":
      values.push(statement.init);
      break;
    case "assign":
    case "memberAssign":
    case "result":
    case "print":
      values.push(statement.value);
      break;
    default:
      break;
  }
  // A read of the counter is a name in one of these, and a read of the name the
  // statement writes is not one: `total = i` reads it, `i = 2` does not.
  if (statement.kind === "assign" && statement.target === counter) {
    values.length = 0;
  }
  for (const value of values) {
    if (expressionReads(value, counter)) return false;
  }
  return true;
}

/**
 * Whether a loop body reaches its counter only as an index.
 *
 * The width of a counter reaches the arithmetic of the body wherever the body
 * reads it as a value, and an index is not a value: it is the place in an array
 * the body reaches, and the number of that place is a whole number whatever the
 * counter is counted in. A body that counts the elements of an array and indexes
 * with the counter is therefore a body the counter's width does not reach, and
 * the counter may be a whole number even where the arithmetic of the body is
 * written in fractions.
 *
 * A body that reads the counter as a value as well is left alone: there the
 * counter's width reaches the arithmetic, and a whole number in that arithmetic
 * is a number the source never wrote. A body that writes the counter is left
 * alone as well: what it writes is a number of the width the counter is counted
 * in, and a whole number written into a double counter is a number the source
 * never wrote.
 *
 * A loop nested inside this one that declares a name of its own shadows the
 * counter for its own body, so a read there is not a read of this counter.
 */
export function bodyIndexesCounter(body: readonly Statement[], counter: string, shadowed = false): boolean {
  for (const statement of body) {
    switch (statement.kind) {
      case "loop": {
        const hides = shadowed || statement.variable === counter;
        if (expressionReadsOutsideIndex(statement.from, counter)) return false;
        if (expressionReadsOutsideIndex(statement.to, counter)) return false;
        if (statement.step !== null && expressionReadsOutsideIndex(statement.step, counter)) return false;
        if (!bodyIndexesCounter(statement.body, counter, hides)) return false;
        break;
      }
      case "forOf": {
        const hides = shadowed || statement.variable === counter;
        if (!bodyIndexesCounter(statement.body, counter, hides)) return false;
        break;
      }
      case "if": {
        if (!shadowed && expressionReadsOutsideIndex(statement.condition, counter)) return false;
        if (!bodyIndexesCounter(statement.then, counter, shadowed)) return false;
        if (!bodyIndexesCounter(statement.otherwise, counter, shadowed)) return false;
        break;
      }
      case "while":
      case "doWhile":
        if (!shadowed && expressionReadsOutsideIndex(statement.condition, counter)) return false;
        if (!bodyIndexesCounter(statement.body, counter, shadowed)) return false;
        break;
      case "indexAssign": {
        // The counter may be the index the element is written at. The buffer it
        // is written into is a name and not a read of the counter, and the value
        // written is an ordinary value.
        if (!shadowed) {
          const at = statement.index;
          if (!(at.k === "ident" && at.name === counter) && expressionReads(at, counter)) return false;
          if (expressionReadsOutsideIndex(statement.value, counter)) return false;
        }
        break;
      }
      case "try": {
        if (!bodyIndexesCounter(statement.body, counter, shadowed)) return false;
        if (statement.catchBody !== null && !bodyIndexesCounter(statement.catchBody, counter, shadowed)) return false;
        if (statement.finallyBody !== null && !bodyIndexesCounter(statement.finallyBody, counter, shadowed)) return false;
        break;
      }
      case "declare":
      case "assign":
      case "memberAssign":
      case "update":
      case "result":
      case "print":
      case "expression":
        if (!statementIndexesCounter(statement, counter, shadowed)) return false;
        break;
      default:
        break;
    }
  }
  return true;
}

/** Whether a statement reaches the counter of a loop only as an index. */
function statementIndexesCounter(statement: Statement, counter: string, shadowed: boolean): boolean {
  if (shadowed) return true;
  const values: Expression[] = [];
  switch (statement.kind) {
    case "declare":
      values.push(statement.init);
      break;
    case "assign":
    case "memberAssign":
    case "result":
    case "print":
    case "expression":
      values.push(statement.value);
      break;
    default:
      break;
  }
  for (const value of values) {
    if (expressionReadsOutsideIndex(value, counter)) return false;
  }
  // A statement that writes the counter writes a number of the width the
  // counter is counted in, and a whole number written into a double counter is
  // a number the source never wrote.
  if (statement.kind === "assign" && statement.target === counter) return false;
  if (statement.kind === "update" && statement.name === counter) return false;
  return true;
}

/**
 * Whether an expression reads a name anywhere but as the index of an index.
 *
 * The counter may be the index of an index and nothing else about it: an index
 * written as a call reads the counter inside the call, which is a read of it as
 * a value.
 */
function expressionReadsOutsideIndex(expression: Expression, counter: string): boolean {
  switch (expression.k) {
    case "ident":
      return expression.name === counter;
    case "update":
      return expression.name === counter;
    case "index": {
      if (expression.index.k === "ident" && expression.index.name === counter) {
        return expressionReadsOutsideIndex(expression.base, counter);
      }
      return expressionReads(expression.base, counter) || expressionReads(expression.index, counter);
    }
    case "unary":
      return expressionReadsOutsideIndex(expression.operand, counter);
    case "binary":
      return (
        expressionReadsOutsideIndex(expression.left, counter) || expressionReadsOutsideIndex(expression.right, counter)
      );
    case "conditional":
      return (
        expressionReadsOutsideIndex(expression.condition, counter) ||
        expressionReadsOutsideIndex(expression.then, counter) ||
        expressionReadsOutsideIndex(expression.otherwise, counter)
      );
    case "member":
      return expressionReadsOutsideIndex(expression.base, counter);
    case "call":
      return expression.args.some((argument) => expressionReadsOutsideIndex(argument, counter));
    case "argv":
      return expression.index === null ? false : expressionReadsOutsideIndex(expression.index, counter);
    case "object":
      return expression.fields.some((field) => expressionReadsOutsideIndex(field.value, counter));
    default:
      return false;
  }
}

/** Whether an expression reads a name, wherever in it the name appears. */
function expressionReads(expression: Expression, counter: string): boolean {
  switch (expression.k) {
    case "ident":
      return expression.name === counter;
    case "unary":
      return expressionReads(expression.operand, counter);
    case "binary":
      return expressionReads(expression.left, counter) || expressionReads(expression.right, counter);
    case "conditional":
      return (
        expressionReads(expression.condition, counter) ||
        expressionReads(expression.then, counter) ||
        expressionReads(expression.otherwise, counter)
      );
    case "index":
      return expressionReads(expression.base, counter) || expressionReads(expression.index, counter);
    case "slice":
      return (
        expressionReads(expression.base, counter) ||
        (expression.start !== null && expressionReads(expression.start, counter)) ||
        (expression.stop !== null && expressionReads(expression.stop, counter)) ||
        (expression.step !== null && expressionReads(expression.step, counter))
      );
    case "member":
      return expressionReads(expression.base, counter);
    case "call":
      return expression.args.some((argument) => expressionReads(argument, counter));
    case "argv":
      return expression.index === null ? false : expressionReads(expression.index, counter);
    case "object":
      return expression.fields.some((field) => expressionReads(field.value, counter));
    default:
      return false;
  }
}

/** Whether an expression is written entirely in whole numbers. */
function expressionIsWhole(expression: Expression, counter: string, whole: ReadonlySet<string>): boolean {
  switch (expression.k) {
    case "literal":
      return isWholeNumberText(expression.text);
    case "bigint":
      return true;
    case "ident":
      return expression.name === counter || whole.has(expression.name);
    case "unary":
      return expressionIsWhole(expression.operand, counter, whole);
    case "conditional":
      return (
        expressionIsWhole(expression.condition, counter, whole) &&
        expressionIsWhole(expression.then, counter, whole) &&
        expressionIsWhole(expression.otherwise, counter, whole)
      );
    case "binary":
      // A division and a power over whole numbers are not whole numbers: `100
      // / i` is a double whatever both sides are, and it is read as one, so a
      // body that divides is not a body written entirely in whole numbers.
      if (expression.op === "/" || expression.op === "%" || expression.op === "**") return false;
      return expressionIsWhole(expression.left, counter, whole) && expressionIsWhole(expression.right, counter, whole);
    case "index":
      return expressionIsWhole(expression.base, counter, whole) && expressionIsWhole(expression.index, counter, whole);
    case "slice":
      return (
        expressionIsWhole(expression.base, counter, whole) &&
        (expression.start === null || expressionIsWhole(expression.start, counter, whole)) &&
        (expression.stop === null || expressionIsWhole(expression.stop, counter, whole)) &&
        (expression.step === null || expressionIsWhole(expression.step, counter, whole))
      );
    case "member":
      return expressionIsWhole(expression.base, counter, whole);
    case "argv":
      return expression.index === null || expressionIsWhole(expression.index, counter, whole);
    default:
      // A call hands back whatever it returns and an object and a string are
      // not numbers at all, so a body that has one is not a body written
      // entirely in whole numbers.
      return false;
  }
}

/**
 * What an operation over two numbers yields. A whole 64 bit number is one
 * whatever it is written with, and two floats of one width are that width,
 * because an operation is written as one of the two types it works on and a
 * target multiplies two single-precision values in single precision. Anything
 * else is a double, which is what a number is until a use fixes it.
 */
export function numeric(left: Inferred, right: Inferred): TypeExpr {
  // A wide number keeps its width, for the same reason a machine word does
  // below it: the rule this function ends on is a double because a double holds
  // every value a program counts with, and a value wider than a machine word is
  // not one of them. Narrowing here would drop every limb above the first
  // before a backend is handed the expression at all.
  if (left.kind === "type" && left.type.kind === "primitive" && isWide(left.type.name)) return left.type;
  if (right.kind === "type" && right.type.kind === "primitive" && isWide(right.type.name)) return right.type;
  // An `i64` is kept beside another whole number, which is the `i64` a bigint
  // is: `2n * 3n` is computed at sixty-four bits because both of its sides
  // are. It is not kept beside a double, because an `i64` is not only a
  // bigint — it is the width a loop counter is counted at, and every counter
  // the resolver cannot type more precisely is an `i64`. So `i + 0.5` inside a
  // loop was answered at sixty-four bits, and the half was dropped before any
  // backend saw it: the array it was written into held `i`.
  const leftWhole = left.kind === "type" && left.type.kind === "primitive" && left.type.name === "i64";
  const rightWhole = right.kind === "type" && right.type.kind === "primitive" && right.type.name === "i64";
  const leftFloat = left.kind === "type" && left.type.kind === "primitive" && isFloatType(left.type.name);
  const rightFloat = right.kind === "type" && right.type.kind === "primitive" && isFloatType(right.type.name);
  if (leftWhole && !rightFloat) return I64;
  if (rightWhole && !leftFloat) return I64;
  if (left.kind === "type" && left.type.kind === "primitive" && right.kind === "type" && right.type.kind === "primitive") {
    if (isFloatType(left.type.name) && left.type.name === right.type.name) return left.type;
  }
  return F64;
}

/**
 * What `a ?? b` holds: its left operand, which is a reference where the value
 * being chosen is one. Only an unshaped reference — the null a literal gives,
 * and the `any` the source declared — says nothing, and takes the right.
 */
export function coalesce(left: Inferred, right: Inferred): Inferred {
  if (left.kind === "object") return left;
  if (left.type.kind === "ref" && left.type.of === null && left.type.name === undefined) return right;
  return left;
}

/** A reference that says nothing about what it points at: `null`, or an `any`. */
function unshapedReference(value: Inferred): boolean {
  return value.kind === "type" && value.type.kind === "ref" && value.type.of === null;
}

/**
 * Whether two shapes are the same object, one of which was written with a
 * reference where the other was written with the null that stands for one.
 *
 * A list is built out of two literals: the head, whose link is `null` because
 * there is nothing to point at yet, and every element after it, whose link is
 * the element before. They are the same object — one node type, one link, one
 * value — but the first writes the link as a reference to nothing and the second
 * writes it as a reference to the object the first describes, so the two keys
 * differ and the program lays out two node types where the source wrote one. The
 * traversal is typed against the first and reads the second, and it reads
 * whichever field happens to sit at the offset it took from the first.
 *
 * Nothing else is the same object. Two shaped references to two different
 * objects are two fields of two types and must stay apart: merging them would
 * give one field a type that describes a layout neither of the two has.
 */
function sameShape(left: Shape, right: Shape): boolean {
  if (left.fields.length !== right.fields.length) return false;
  return left.fields.every((field) => {
    const known = right.fields.find((entry) => entry.name === field.name);
    if (known === undefined) return false;
    if (describe(known.value) === describe(field.value)) return true;
    return unshapedReference(known.value) || unshapedReference(field.value);
  });
}

/**
 * Folds every pair of shapes that differ only where one of them says nothing,
 * and answers the key each shape is now the same object as.
 *
 * The walk is over pairs rather than a map, because the relation is not
 * transitive on its own: a shape that says nothing about a field is the same as
 * two shaped ones only if they are the same as each other, and comparing every
 * pair and unioning is what finds the group a shape belongs to. It is a handful
 * of comparisons per program: an object type is written out in full at every
 * literal, so two functions build two objects only when they write different
 * fields.
 */
function uniteShapes(shapes: Map<string, Shape>): Map<string, string> {
  const keys = [...shapes.keys()];
  const parent = new Map<string, string>(keys.map((key) => [key, key]));
  const find = (key: string): string => {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    let walk = key;
    while (walk !== root) {
      const next = parent.get(walk) as string;
      parent.set(walk, root);
      walk = next;
    }
    return root;
  };
  for (let left = 0; left < keys.length; left += 1) {
    for (let right = left + 1; right < keys.length; right += 1) {
      const first = shapes.get(keys[left]);
      const second = shapes.get(keys[right]);
      if (first === undefined || second === undefined) continue;
      if (find(keys[left]) === find(keys[right])) continue;
      if (!sameShape(first, second)) continue;
      // The shape that names what the field points at is kept as the one the
      // group answers to, so a field that is a reference in one literal and a
      // null in the other is a reference afterwards: a null is a value any
      // reference can hold, so reading it as the reference says nothing false.
      const firstShaped = first.fields.some((field) => !unshapedReference(field.value));
      const secondShaped = second.fields.some((field) => !unshapedReference(field.value));
      const keep = firstShaped === secondShaped ? keys[left] : firstShaped ? keys[left] : keys[right];
      parent.set(find(keys[right]), find(keep));
    }
  }
  return new Map(keys.map((key) => [key, find(key)]));
}

/**
 * What a program body's own object literals have to say about the shapes the
 * function bodies already laid out. A shape both wrote is one shape and one
 * layout — which is the whole of why a function can be handed an object the
 * body built and read its fields at the offsets it contracted — and a field
 * the two give different types is a layout this cannot state.
 */
function mergeProgramShapes(
  shapes: Map<string, Shape>,
  owners: Map<string, string>,
  programShapes: ReadonlyMap<string, Shape>,
): void {
  for (const [key, shape] of programShapes) {
    const existing = shapes.get(key);
    if (existing === undefined) {
      shapes.set(key, { key, fields: shape.fields.map((field) => ({ ...field })) });
      owners.set(key, "the program body");
      continue;
    }
    for (const field of shape.fields) {
      const known = existing.fields.find((entry) => entry.name === field.name);
      if (known === undefined) {
        existing.fields.push({ name: field.name, value: field.value });
        continue;
      }
      if (describe(known.value) === describe(field.value)) continue;
      throw objectsError(
        `the program body writes "${field.name}" as ${describe(field.value)}, which ${owners.get(key)} has it as ${describe(known.value)}`,
        "an object is one object to the program, so one field holds one type; write the field in the literal so the two objects have different shapes",
      );
    }
  }
}

/**
 * What every function that writes an object of one key has to say about it.
 *
 * The key is the shape of the literal, so an object two functions build the
 * same way is one object to the program, and the layout has to hold every
 * field either of them writes. Keeping the shape of whichever function was
 * walked last gave the others a layout shorter than their own bodies, and a
 * field they write landed past the end of the allocation. A field two
 * functions give different types is not a layout this can state at all.
 */
function mergeShape(shapes: Map<string, Shape>, owners: Map<string, string>, body: BodyTypes): void {
  for (const [key, shape] of body.registered) {
    const existing = shapes.get(key);
    if (existing === undefined) {
      shapes.set(key, { key, fields: shape.fields.map((field) => ({ ...field })) });
      owners.set(key, body.functionName);
      continue;
    }
    for (const field of shape.fields) {
      const known = existing.fields.find((entry) => entry.name === field.name);
      if (known === undefined) {
        existing.fields.push({ name: field.name, value: field.value });
        continue;
      }
      if (describe(known.value) === describe(field.value)) continue;
      throw objectsError(
        `${body.path}: ${body.functionName} writes "${field.name}" as ${describe(field.value)}, which ${owners.get(key)} has it as ${describe(known.value)}`,
        "an object is one object to the program, so one field holds one type; write the field in the literal so the two objects have different shapes",
      );
    }
  }
}

/**
 * Lays every object of the program out, and writes the layout into the
 * definition of every function that has one. A signature the source left as
 * `any` is narrowed to the object its body actually returns.
 *
 * Returns the name each shape is laid out as, and the key each literal of a
 * program body was laid out at. A function body writes objects, and the IR that
 * describes that body names the layout each of them is: a shape is keyed by the
 * fields it holds, so the same literal in two functions is one object with one
 * name, and only this pass can say which.
 */
export function resolveObjects(
  files: readonly FileContract[],
  programBody: { shapes: ReadonlyMap<string, Shape>; keys: LiteralKeys } = { shapes: new Map(), keys: new Map() },
): { names: Map<string, string>; layouts: Record<string, ObjectLayout>; keys: Map<ProgramValue & { k: "object" }, string> } {
  const programShapes = programBody.shapes;
  const shapes = new Map<string, Shape>();
  const owners = new Map<string, string>();
  // Every function the program compiles is callable, and every one of them has
  // a body, so every one of them is walked here: a body is what lays the
  // objects out, and a function whose shape nothing claims would be an object
  // the rest of the program has to guess the layout of.
  const callees = new Map<string, TypeExpr>();
  const callers = new Map<string, { file: FileContract; name: string; contract: FunctionContract }>();
  for (const file of files) {
    for (const [name, contract] of Object.entries(file.functions)) {
      callees.set(name, parseType(contract.function.returns));
      callers.set(name, { file, name, contract });
    }
  }
  // A program of nothing but statements has no function body for the layouts
  // to be written into, and the layouts are still the ones the body reads its
  // fields at: the names and the layouts are what it needs, and the write into
  // the definitions is for the functions beside it.
  if (callers.size === 0) {
    mergeProgramShapes(shapes, owners, programShapes);
    const names = new Map<string, string>();
    [...shapes.values()].forEach((shape, index) => names.set(shape.key, `Object${index + 1}`));
    const layouts: Record<string, ObjectLayout> = {};
    for (const shape of shapes.values()) {
      const name = names.get(shape.key) as string;
      layouts[name] = layOut(name, shape, names, new Map());
    }
    return { names, layouts, keys: new Map(programBody.keys) };
  }

  // The declared return of every function is known before any body is walked,
  // because one function's body may call another's.
  const bodies = new Map<string, BodyTypes>();
  for (const caller of callers.values()) {
    const definition = caller.contract.definition;
    const body = new BodyTypes(
      caller.file.path,
      caller.name,
      caller.contract.function.params.map((param) => ({ name: param.name, type: parseType(param.type) })),
      callees,
    );
    body.statements(definition.statements);
    bodies.set(caller.name, body);
    mergeShape(shapes, owners, body);
  }
  // The objects a program body writes are merged after the function bodies, so
  // a shape a function writes keeps the name it had before a body could write
  // one beside it: the counter moves on from where the walk of the functions
  // left it, and a shape both wrote is one shape either way.
  mergeProgramShapes(shapes, owners, programShapes);

  // Two shapes that differ only where one of them says nothing about what a
  // reference points at are one object, and the keys that changed are written
  // back into every body that named them: a body holds the object in the name it
  // bound the value to, and a traversal that reads a field through a name bound
  // before the fold would look the old key up and find nothing.
  const remapped = uniteShapes(shapes);
  if ([...remapped].some(([key, root]) => key !== root)) {
    const folded = new Map<string, Shape>();
    for (const [key, root] of remapped) {
      const shape = shapes.get(key);
      if (shape === undefined) continue;
      const held = folded.get(root);
      if (held === undefined) {
        folded.set(root, { key: root, fields: shape.fields.map((field) => ({ ...field })) });
        continue;
      }
      for (const field of shape.fields) {
        const known = held.fields.find((entry) => entry.name === field.name);
        if (known === undefined) {
          held.fields.push({ name: field.name, value: field.value });
          continue;
        }
        // A field one literal wrote as a reference and another as a null is a
        // reference: the null is a value the reference can hold.
        if (unshapedReference(known.value)) known.value = field.value;
      }
    }
    shapes.clear();
    for (const [key, shape] of folded) shapes.set(key, shape);
    for (const body of bodies.values()) body.renameObjects(remapped);
  }

  // Every literal a program body wrote, filed under the key it survived as: the
  // fold moved a shape that unified with another onto the kept key, and a literal
  // is laid out under the key of the shape it ended up in.
  const literalKeys = new Map<ProgramValue & { k: "object" }, string>();
  for (const [literal, key] of programBody.keys) {
    literalKeys.set(literal, remapped.get(key) ?? key);
  }

  const names = new Map<string, string>();
  const ordered = [...shapes.values()];
  ordered.forEach((shape, index) => names.set(shape.key, `Object${index + 1}`));
  const layouts = new Map<string, ObjectLayout>();
  for (const shape of ordered) {
    const name = names.get(shape.key) as string;
    layouts.set(name, layOut(name, shape, names, programReads(bodies)));
  }

  // A method that answers an instance names the class it answers with. The
  // object pass has just named the class's constructor's layout `ObjectN` by
  // its fields, so the class's own name is written beside it as the layout a
  // caller that holds `ref<Class>` reads. It is the same bytes: one layout, two
  // names, and a field read through either is the field at the same offset.
  const aliases = new Map<string, string>();
  for (const caller of callers.values()) {
    const declared = parseType(caller.contract.function.returns);
    if (declared.kind !== "ref" || declared.of !== null || declared.name === undefined) continue;
    if (!callers.has(declared.name) || aliases.has(declared.name)) continue;
    const result = bodies.get(declared.name)?.result();
    if (result === undefined || result === null || result.kind !== "object") continue;
    const layout = names.get(result.key);
    if (layout !== undefined) aliases.set(declared.name, layout);
  }

  const written: Record<string, ObjectLayout> = Object.fromEntries([...layouts.entries()].map(([name, shape]) => [name, shape]));
  for (const [alias, layout] of aliases) {
    const target = written[layout];
    if (target !== undefined) written[alias] = { ...target, name: alias };
  }
  for (const caller of callers.values()) {
    const definition = caller.contract.definition;
    const body = bodies.get(caller.name);
    if (body === undefined) continue;
    definition.objects = written;
    // The call graph of the whole program, recorded by the one pass that walks
    // every body. Which of these calls is written out rather than made is not
    // decided here: it is a property of the whole graph, and `resolveCalls`
    // decides it immediately after this pass runs.
    definition.calls = body.called.map((callee) => ({ callee, strategy: "call" }));
    const result = body.result();
    if (result === null || result.kind !== "object") continue;
    // `any` said a reference without saying to what; the body says which.
    const declared = parseType(caller.contract.function.returns);
    if (declared.kind === "ref" && declared.of === null && declared.name === undefined) {
      caller.contract.function.returns = `ref<${names.get(result.key)}>`;
    }
  }

  return { names, layouts: written, keys: literalKeys };
}


/**
 * How often the program reads each field of each object, counted over every
 * body the contract pass walked.
 */
function programReads(bodies: ReadonlyMap<string, BodyTypes>): Map<string, Map<string, number>> {
  const totals = new Map<string, Map<string, number>>();
  for (const body of bodies.values()) {
    for (const [key, counts] of body.reads) {
      const total = totals.get(key);
      if (total === undefined) {
        totals.set(key, new Map(counts));
        continue;
      }
      for (const [field, count] of counts) total.set(field, (total.get(field) ?? 0) + count);
    }
  }
  return totals;
}

/**
 * The bytes of one object: every field at its own alignment, the object at its own.
 *
 * The fields are laid out in the order the program reads them, most read first.
 * An object the program walks touches the cache lines its read fields fall in and
 * no others, so the fields it reads share the line at the front of the object and
 * the fields it never reads are the ones that cost a line each. Reading a field
 * is counted, not writing one: a write brings in the line the field is on, but
 * every field of a constructed object is written once and only the fields read
 * again are the ones a traversal comes back for.
 *
 * The order is stable, so fields read equally often keep the order the source
 * wrote them in. Every object whose fields are all read, or all unread, is
 * therefore laid out exactly as it was, and this changes nothing for them.
 *
 * Offsets are assigned in this order and not before it, which is what keeps the
 * offsets ascending and the C and Nim struct declarations, whose members gcc
 * lays out in the order they are written, agreeing with what is stated here.
 */
export function layOut(
  name: string,
  shape: Shape,
  names: Map<string, string>,
  reads: Map<string, Map<string, number>>,
): ObjectLayout {
  const counts = reads.get(shape.key) ?? new Map<string, number>();
  const ordered = shape.fields
    .map((field, at) => ({ field, at, count: counts.get(field.name) ?? 0 }))
    .sort((left, right) => right.count - left.count || left.at - right.at)
    .map((entry) => entry.field);
  const fields: { name: string; type: string; offset: number }[] = [];
  let offset = 0;
  let align = 1;
  for (const field of ordered) {
    const type: TypeExpr =
      field.value.kind === "object" ? { kind: "ref", of: null, name: names.get(field.value.key) } : field.value.type;
    const { size, align: fieldAlign } = fieldLayout(type);
    align = Math.max(align, fieldAlign);
    offset = alignUp(offset, fieldAlign);
    fields.push({ name: field.name, type: typeToString(type), offset });
    offset += size;
  }
  return { name, size: alignUp(offset, align), align, fields };
}

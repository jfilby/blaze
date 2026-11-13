function fieldOf(value: unknown, key: string): any {
  return (value as Record<string, unknown>)[key];
}

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
import { fieldOfType, resolveTypeName, type ResolvedType, type TypeTable } from "./typescript-types.ts";
import type { ProgramValue } from "./module.ts";

/** The number a reference takes: one pointer. */
const POINTER_SIZE = 8;

export const F64: TypeExpr = { kind: "primitive", name: "f64" };
export const I64: TypeExpr = { kind: "primitive", name: "i64" };
/** The text a string literal holds: a pointer, like every other reference. */
const TEXT: TypeExpr = { kind: "text" };
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
  const kind = String(fieldOf(argument,"k"));
  let text: string | null = null;
  if (kind === "literal") {
    text = String(fieldOf(argument,"text"));
  } else if (kind === "text") {
    const parts = fieldOf(argument,"parts") as unknown[];
    if (parts.length === 1 && String(fieldOf(parts[0],"k")) === "text") text = String(fieldOf(parts[0],"value"));
  }
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

/**
 * What a field holds when the source wrote a list in it.
 *
 * A list written into a field is a **slice**: the block it allocates carries
 * its length in a header, and the field is a pointer to it. Reading the length
 * of the literal as the length of the field made two literals of different
 * lengths two layouts of one interface -- `{ children: [] }` and
 * `{ children: [a, b] }` cannot be one `Node` -- and it made a field a body
 * pushes to a field whose type still said the length the literal had.
 */
export function asField(value: Inferred): Inferred {
  if (String(fieldOf(value,"kind")) !== "type") return value;
  const type = fieldOf(value,"type") as TypeExpr;
  if (String(fieldOf(type,"kind")) !== "array" || fieldOf(type,"length") === null) return value;
  return { kind: "type", type: { kind: "slice", of: fieldOf(type,"of") as TypeExpr } };
}

function objectsError(message: string, detail?: string): CompilerError {
  return new CompilerError("ContractError", "contract", message, detail, "", "", "");
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
  if (String(fieldOf(type,"kind")) !== "primitive") return { size: POINTER_SIZE, align: POINTER_SIZE };
  const name = fieldOf(type,"name") as PrimitiveTypeName;
  const limbs = limbsOf(name);
  if (limbs !== null) return { size: limbs * LIMB_BYTES, align: LIMB_BYTES };
  const size = scalarSize(name);
  return { size, align: size };
}

/**
 * The contract type a resolved type is held at.
 *
 * A record and a collection are the opaque reference the contract spells; the
 * fields of a record are read where the declaration is, and this is what a
 * field read is held at.
 */
function contractTypeOf(type: ResolvedType): TypeExpr {
  switch (String(fieldOf(type,"kind"))) {
    case "primitive":
      return { kind: "primitive", name: fieldOf(type,"name") as PrimitiveTypeName };
    case "text":
      return { kind: "text" };
    case "list":
      return { kind: "slice", of: contractTypeOf(fieldOf(type,"of") as ResolvedType) };
    case "ref": {
      const name = fieldOf(type,"name") as string | null;
      return name === null ? ANY_REF : { kind: "ref", of: null, name };
    }
    default:
      return ANY_REF;
  }
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
  /**
   * The types the module declares, which say what a field of a reference holds.
   *
   * The contract spells a record as the opaque reference, so the fields are not
   * in it: `info(n).steps` is a field of the record `Info` only when the
   * declaration that names it is read. A program phase hands the table over;
   * nothing else names the fields the source wrote.
   */
  private readonly table: TypeTable | null;
  /**
   * The field a layout lays out, where the value is held at the layout's name.
   *
   * A function that answers an object narrows its contract to the layout its
   * body builds, so a caller holds the answer at `ref<ObjectN>` — a name no
   * type declaration writes. What a field of that answer holds is the shape
   * the layout pass laid out, which is what this asks.
   */
  private readonly layoutField: ((layout: string, field: string) => Inferred | null) | null;

  constructor(
    path: string,
    functionName: string,
    params: readonly { name: string; type: TypeExpr }[],
    callees: Map<string, TypeExpr>,
    table: TypeTable | null = null,
    layoutField: ((layout: string, field: string) => Inferred | null) | null = null,
  ) {
    this.path = path;
    this.functionName = functionName;
    this.callees = callees;
    this.table = table;
    this.layoutField = layoutField;
    for (const param of params) this.environment.set(fieldOf(param,"name"), { kind: "type", type: fieldOf(param,"type") });
  }

  /** The type a field of the reference a value is held at declares. */
  private declaredField(base: Inferred, name: string): TypeExpr | null {
    if (this.table === null || String(fieldOf(base,"kind")) !== "type") return null;
    if (String(String(fieldOf(fieldOf(base,"type"),"kind"))) !== "ref" || fieldOf(fieldOf(base,"type"),"name") === undefined) return null;
    let resolved: ResolvedType;
    try {
      resolved = resolveTypeName(this.table, fieldOf(fieldOf(base,"type"),"name"));
    } catch {
      return null;
    }
    const field = fieldOfType(this.table, resolved, name);
    return field === null ? null : contractTypeOf(fieldOf(field,"type"));
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
    switch (String(fieldOf(statement,"kind"))) {
      case "declare": {
        const value = this.expression(fieldOf(statement,"init"));
        // An object literal is what the body stores, and an annotation does
        // not narrow that. Binding the name as the annotated type left
        // `o.field = ...` with nowhere to record what it wrote, so the field
        // was missing from the layout and the body wrote past the end of the
        // object it had allocated.
        const annotation = fieldOf(statement,"type") as TypeExpr | null;
        const annotated: Inferred = annotation === null ? value : { kind: "type", type: annotation };
        this.environment.set(String(fieldOf(statement,"name")), String(fieldOf(value,"kind")) === "object" ? value : annotated);
        return;
      }
      case "assign": {
        const value = this.expression(fieldOf(statement,"value"));
        // A plain assignment changes what the name holds, and the layout is
        // built from what the body stores. A compound one adds to what was
        // there, so the type it had still holds.
        const target = String(fieldOf(statement,"target"));
        if (String(fieldOf(statement,"op")) === "=" || !this.environment.has(target)) {
          this.environment.set(target, value);
        }
        return;
      }
      case "memberAssign": {
        const value = this.expression(fieldOf(statement,"value"));
        const base = this.environment.get(String(fieldOf(statement,"base")));
        if (base !== undefined && String(fieldOf(base,"kind")) === "object") {
          this.write(String(fieldOf(base,"key")), String(fieldOf(statement,"field")), value);
        }
        return;
      }
      case "indexAssign":
        this.expression(fieldOf(statement,"index"));
        this.expression(fieldOf(statement,"value"));
        return;
      case "update":
        return;
      case "print":
      case "expression":
        this.expression(fieldOf(statement,"value"));
        return;
      case "result": {
        const value = fieldOf(statement,"value");
        if (value !== null) this.results.push(this.expression(value));
        return;
      }
      case "loop": {
        // The index is what the loop counts with, which is the value it starts
        // at and the value it moves by. Typing it `usize` whatever it was
        // written at made a field the body wrote from a counter a different
        // type from the same field written from a written number, and an
        // object two functions build the same way is one object to the
        // program, so the build was refused over a counter.
        const from = this.expression(fieldOf(statement,"from"));
        this.expression(fieldOf(statement,"to"));
        const stepExpression = fieldOf(statement,"step");
        const step = stepExpression === null ? null : this.expression(stepExpression);
        const counted = String(fieldOf(from,"kind")) === "type"
          ? (step === null || String(fieldOf(step,"kind")) !== "type" ? fieldOf(from,"type") : numeric(from, step))
          : null;
        // A loop body is a scope, as an `if` arm is: a name declared in it is
        // not in scope after it, and the index is not in scope before it.
        this.branch(fieldOf(statement,"body"), String(fieldOf(statement,"variable")), { kind: "type", type: counted ?? USIZE });
        return;
      }
      case "if":
        this.expression(fieldOf(statement,"condition"));
        this.branch(fieldOf(statement,"then"), undefined, undefined);
        this.branch(fieldOf(statement,"otherwise"), undefined, undefined);
        return;
      case "while":
      case "doWhile":
        this.expression(fieldOf(statement,"condition"));
        this.branch(fieldOf(statement,"body"), undefined, undefined);
        return;
      case "forOf":
        // The loop walks a name it is given, so its variable is one element of it.
        this.branch(fieldOf(statement,"body"), String(fieldOf(statement,"variable")), { kind: "type", type: this.element(fieldOf(statement,"of")) });
        return;
      case "break":
      case "continue":
        return;
      default:
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
    switch (String(String(String(fieldOf(expression,"k"))))) {
      case "literal":
        return { kind: "type", type: fieldOf(expression,"boolean") === true ? BOOL : F64 };
      case "bigint": {
        const trimmed = fieldOf(expression,"text").trim();
        let literal: bigint | null = null;
        try { literal = BigInt(trimmed); } catch { literal = null; }
        const outOfRange = literal === null || literal > 9223372036854775807n || literal < -9223372036854775808n;
        return { kind: "type", type: outOfRange ? { kind: "primitive", name: "u256" } : I64 };
      }
      case "null":
        return { kind: "type", type: ANY_REF };
      case "ident": {
        const bound = this.environment.get(String(fieldOf(expression,"name")));
        if (bound !== undefined) return bound;
        throw objectsError(
          `${this.path}: ${this.functionName} uses "${String(fieldOf(expression,"name"))}" before it is declared`,
          "a compiled function declares every name it uses before it uses it",
        );
      }
      case "argv":
        if (fieldOf(expression,"index") !== null) this.expression(fieldOf(expression,"index"));
        return { kind: "type", type: fieldOf(expression,"index") === null ? USIZE : F64 };
      case "length":
        return { kind: "type", type: USIZE };
      case "lengthOf":
        // The value the length is of is walked: a call written there is a call
        // the body makes, and the contract states the calls the body makes.
        this.expression(fieldOf(expression,"of"));
        return { kind: "type", type: USIZE };
      case "index": {
        const base = this.expression(fieldOf(expression,"base"));
        this.expression(fieldOf(expression,"index"));
        return { kind: "type", type: String(fieldOf(base,"kind")) === "object" ? ANY_REF : elementOf(base) };
      }
      case "slice": {
        const base = this.expression(fieldOf(expression,"base"));
        if (fieldOf(expression,"start") !== null) this.expression(fieldOf(expression,"start"));
        if (fieldOf(expression,"stop") !== null) this.expression(fieldOf(expression,"stop"));
        if (fieldOf(expression,"step") !== null) this.expression(fieldOf(expression,"step"));
        return { kind: "type", type: String(fieldOf(base,"kind")) === "object" ? ANY_REF : (String(fieldOf(base,"kind")) === "type" && String(fieldOf(fieldOf(base,"type"),"kind")) === "array" ? fieldOf(base,"type") : { kind: "array", of: elementOf(base), length: null }) };
      }
      case "member": {
        const base = this.expression(fieldOf(expression,"base"));
        if (String(fieldOf(base,"kind")) === "object") return this.field(fieldOf(base,"key"), fieldOf(expression,"field"));
        // The field of a reference the type table names is the type the
        // declaration gives it: `info(n).steps` is a number because `Info`
        // says its `steps` is one, and an object literal that writes the field
        // through the reference has the same shape the declaration has.
        const declared = this.declaredField(base, fieldOf(expression,"field"));
        if (declared !== null) return { kind: "type", type: declared };
        if (String(fieldOf(base,"kind")) === "type" && String(fieldOf(fieldOf(base,"type"),"kind")) === "ref" && fieldOf(fieldOf(base,"type"),"name") !== undefined) {
          const laid = this.layoutField?.(fieldOf(fieldOf(base,"type"),"name"), fieldOf(expression,"field")) ?? null;
          if (laid !== null) return laid;
        }
        return { kind: "type", type: ANY_REF };
      }
      case "call": {
        const walked: Inferred[] = [];
        for (const argument of fieldOf(expression,"args") as Expression[]) walked.push(this.expression(argument));
        // `BigInt(x)` of a value written out is the whole number it names, and
        // the builder that lowers the body folds it to the literal. What the
        // layout pass needs is the type it is held at, which is the type of the
        // literal the fold produces.
        if (String(fieldOf(expression,"name")) === "BigInt") {
          const inferred = bigIntInferred(fieldOf(expression,"args")[0]);
          if (inferred !== null) return { kind: "type", type: inferred };
        }
        // A value the read could not settle: it is a reference here, and the
        // resolver refuses the name with the line it is written on.
        if (String(fieldOf(expression,"name")).startsWith("__refused_")) {
          return { kind: "type", type: ANY_REF };
        }
        // A function the program compiles is the name the source bound; a
        // builtin of the same name is the fallback for a name it did not.
        const directOverload = `${String(fieldOf(expression,"name"))}__${fieldOf(expression,"args").length}`;
        const direct = this.callees.get(directOverload) ?? this.callees.get(String(fieldOf(expression,"name")));
        if (direct !== undefined) {
          this.call(this.callees.get(directOverload) !== undefined ? directOverload : String(fieldOf(expression,"name")));
          return { kind: "type", type: direct };
        }
        // The deep copy answers the type of the value it copies, so the layout
        // of a copied value is the layout the source wrote.
        if (String(fieldOf(expression,"name")) === "structuredClone" && walked.length === 1) {
          const held = walked[0] as { kind: "type"; type: TypeExpr } | { kind: "object"; key: unknown };
          return String(fieldOf(held,"kind")) === "type" ? { kind: "type", type: fieldOf(held,"type") } : { kind: "type", type: ANY_REF };
        }
        const builtin = builtinFor(String(fieldOf(expression,"name")));
        if (builtin !== null) {
          const allowed = (fieldOf(builtin,"arities") as number[] | undefined) ?? [(fieldOf(builtin,"arity") as number | undefined) ?? (fieldOf(builtin,"params") as unknown[]).length];
          if (!allowed.includes(fieldOf(expression,"args").length)) {
            throw objectsError(
              `${String(fieldOf(expression,"name"))} takes ${allowed.join(" or ")} argument${allowed.length === 1 && allowed[0] === 1 ? "" : "s"}`,
              `${this.path}: ${this.functionName} calls it with ${fieldOf(expression,"args").length}`,
            );
          }
          // A call that answers a string lays the field out as the text it is:
          // a text and a reference are both a pointer, and a field typed as
          // the unshaped reference would read back as an `any` when the source
          // asked for the string the call answered. A comparison of two texts
          // is a comparison of two texts, not one of a reference and a text.
          const answer = fieldOf(expression,"returns") ?? fieldOf(builtin,"returns");
          return { kind: "type", type: answer };
        }
        // A function with default parameters is callable at a shorter arity
        // through the overload the module declares for it, which is the name
        // with the count the call is written with.
        const overloadName = `${String(fieldOf(expression,"name"))}__${fieldOf(expression,"args").length}`;
        const overload = this.callees.get(overloadName);
        const returns = overload ?? this.callees.get(String(fieldOf(expression,"name")));
        if (returns === undefined) {
          throw objectsError(
            `${this.path}: ${this.functionName} calls "${String(fieldOf(expression,"name"))}", which the program does not compile`,
            "a function may only call the functions of the program it is part of",
          );
        }
        this.call(overload !== undefined ? overloadName : String(fieldOf(expression,"name")));
        return { kind: "type", type: returns };
      }
      case "object":
        return { kind: "object", key: this.object(fieldOf(expression,"fields")) };
      case "fixed":
        // The number is read to write it out, so the value it is written of is
        // walked: a name it reads is a name the body has to have declared.
        this.expression(fieldOf(expression,"of"));
        return { kind: "type", type: F64 };
      case "sized":
        // The count is read to size the block, and the elements are the names
        // the body reaches through the array afterwards, so both are walked: a
        // count that reads an object the body has not declared yet is the same
        // fault here as anywhere else.
        this.expression(fieldOf(expression,"count"));
        return { kind: "type", type: { kind: "array", of: parseType(fieldOf(expression,"element")), length: null } };
      case "buffer":
        if (fieldOf(expression,"view") !== undefined) {
          // A window of a block another value holds is a list of the elements
          // it reaches, and the count is read from the values it was taken of.
          this.expression(fieldOf(fieldOf(expression,"view"),"of"));
          this.expression(fieldOf(fieldOf(expression,"view"),"offset"));
          this.expression(fieldOf(fieldOf(expression,"view"),"count"));
          return { kind: "type", type: { kind: "slice", of: parseType(fieldOf(expression,"element")) } };
        }
        for (const value of fieldOf(expression,"values")) this.expression(value);
        return {
          kind: "type",
          type: { kind: "array", of: parseType(fieldOf(expression,"element")), length: fieldOf(expression,"values").length },
        };
      case "text":
        for (const part of fieldOf(expression,"parts")) {
          if (String(fieldOf(part,"k")) === "value") this.expression(fieldOf(part,"value"));
        }
        return { kind: "type", type: TEXT };
      case "binary": {
        const left = this.expression(fieldOf(expression,"left"));
        const right = this.expression(fieldOf(expression,"right"));
        if (COMPARISONS[String(fieldOf(expression,"op"))] === true || LOGICAL[String(fieldOf(expression,"op"))] === true) return { kind: "type", type: BOOL };
        // `??` is neither a comparison nor a short circuit: it hands back one
        // of its operands, so a reference stays a reference instead of
        // becoming the double every other operator is.
        if (String(fieldOf(expression,"op")) === "??") return coalesce(left, right);
        // A list added to a list is one list, not a number: the layout a field
        // written from a list is given has to hold the array, and reading the
        // two sides as numbers shaped the field as a double.
        const sequence = (one: Inferred): boolean =>
          String(fieldOf(one,"kind")) === "type" && (String(fieldOf(fieldOf(one,"type"),"kind")) === "slice" || String(fieldOf(fieldOf(one,"type"),"kind")) === "array" || String(fieldOf(fieldOf(one,"type"),"kind")) === "ptr");
        if (String(fieldOf(expression,"op")) === "+" && sequence(left) && sequence(right)) return left;
        return { kind: "type", type: numeric(left, right) };
      }
      case "unary": {
        // The operand is walked even for `!`, so a name it uses and an object
        // it allocates are found the way any other operand's are.
        const operand = this.expression(fieldOf(expression,"operand"));
        return String(fieldOf(expression,"op")) === "!" ? { kind: "type", type: BOOL } : operand;
      }
      case "conditional": {
        this.expression(fieldOf(expression,"condition"));
        // Both branches are walked so both objects are laid out, but a choice
        // returns whichever branch it takes: the two name the same thing or
        // the function returns no one object. Reading the type off the branch
        // the source wrote last narrowed the return to an object the other
        // branch never returns, and the code reading it went past the end of
        // a smaller one.
        const first = this.expression(fieldOf(expression,"then"));
        const second = this.expression(fieldOf(expression,"otherwise"));
        if (describe(first) === describe(second)) return first;
        // A null is the absence of a reference, and a choice of one and a
        // shaped reference is the shaped reference: the field holds a `Box*`
        // that is `NULL` on the absent arm, not a handle of no shape. Reading
        // it as the unshaped one laid the field out as a `double` and the C
        // compiler refused to put a `Box*` in it.
        const shaped = (value: Inferred): boolean =>
          String(fieldOf(value,"kind")) === "type" && String(fieldOf(fieldOf(value,"type"),"kind")) === "ref" && fieldOf(fieldOf(value,"type"),"name") !== undefined;
        if (String(fieldOf(fieldOf(expression,"then"),"k")) === "null" && shaped(second)) return second;
        if (String(fieldOf(fieldOf(expression,"otherwise"),"k")) === "null" && shaped(first)) return first;
        // A choice of two lists is one list: the block a name holds is a slice
        // and one written out is an array of its length, and the field that
        // holds either holds a list of the element they share. Reading it as
        // the unshaped reference laid the field out as a handle and the list
        // the other arm holds could not be stored in it.
        const sequenceArm = (value: Inferred): Extract<TypeExpr, { kind: "array" | "slice" | "ptr" }> | null =>
          String(fieldOf(value,"kind")) === "type" && (String(fieldOf(fieldOf(value,"type"),"kind")) === "array" || String(fieldOf(fieldOf(value,"type"),"kind")) === "slice" || String(fieldOf(fieldOf(value,"type"),"kind")) === "ptr")
            ? fieldOf(value,"type")
            : null;
        const firstList = sequenceArm(first);
        const secondList = sequenceArm(second);
        if (firstList !== null && secondList !== null && typeToString(fieldOf(firstList,"of")) === typeToString(fieldOf(secondList,"of"))) {
          return { kind: "type", type: { kind: "slice", of: fieldOf(firstList,"of") } };
        }
        return { kind: "type", type: ANY_REF };
      }
      case "update":
        return this.environment.get(String(fieldOf(expression,"name"))) ?? { kind: "type", type: F64 };
      case "arrow":
        // An arrow is lifted into a function of the file and called by the name
        // it is bound to, so what it is laid out as is the reference every other
        // value the layout pass does not shape is. Read as a value it is a
        // closure, and the function that enters it is one this body reaches:
        // the body cannot be built without it, so it is a call the body makes.
        if (fieldOf(expression,"code") !== undefined) this.call(fieldOf(expression,"code"));
        return { kind: "type", type: ANY_REF };
      case "capture":
        // One of the values a closure carries, read at the type the arrow that
        // captured it reads it at.
        this.expression(fieldOf(expression,"closure"));
        return { kind: "type", type: fieldOf(expression,"type") };
      case "invoke":
        // A call of a value: the closure is read and the arguments are read,
        // and neither names a function of the program.
        this.expression(fieldOf(expression,"callee"));
        for (const argument of fieldOf(expression,"args")) this.expression(argument);
        return { kind: "type", type: fieldOf(expression,"returns") };
      case "append":
        // A push or a pop is a statement, and a statement of the body is walked
        // as the write it became. Reaching here is a value nobody wrote.
        throw objectsError(
          `${this.path}: ${this.functionName} reads the array a ${String(fieldOf(expression,"op"))} answers`,
          "a push and a pop change the array a name holds, and are written as statements",
        );
      default:
        throw objectsError(
          `${this.path}: ${this.functionName} has an expression of no known kind`,
          "the layout pass walks the expressions the frontend reads",
        );
    }
  }

  /** What one element of a named buffer holds. */
  private element(name: string): TypeExpr {
    return elementOf(this.expression({ k: "ident", name }));
  }

  /** Registers the object a literal writes, and returns its key. */
  private object(fields: readonly { name: string; value: Expression }[]): string {
    const typed = fields.map((field) => ({
      name: field.name,
      value: field.name === "__arm"
        ? { kind: "type" as const, type: { kind: "primitive" as const, name: "f64" as const } }
        : asField(this.expression(field.value)),
    }));
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
    const fields = shape === undefined ? [] : fieldOf(shape,"fields") as { name: string; value: Inferred }[];
    const field = fields.find((entry) => String(fieldOf(entry,"name")) === name);
    if (field !== undefined) {
      const read = this.reads.get(key);
      if (read === undefined) this.reads.set(key, new Map([[name, 1]]));
      else read.set(name, (read.get(name) ?? 0) + 1);
    }
    return field === undefined ? { kind: "type", type: ANY_REF } : fieldOf(field,"value") as Inferred;
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
    const fields = fieldOf(shape,"fields") as { name: string; value: Inferred }[];
    const field = fields.find((entry) => String(fieldOf(entry,"name")) === name);
    if (field === undefined) fields.push({ name, value });
    else (field as Record<string, unknown>)["value"] = value;
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
    const value = (inferred: Inferred): Inferred => {
      const fields = inferred as unknown as Record<string, unknown>;
      if (String(fields["kind"]) !== "object") return inferred;
      return { kind: "object", key: key(String(fields["key"])) };
    };
    const shapes = new Map<string, Shape>();
    for (const [was, shape] of this.registered) {
      const fields: { name: string; value: Inferred }[] = [];
      for (const field of fieldOf(shape,"fields") as { name: string; value: Inferred }[]) {
        fields.push({ name: String(fieldOf(field,"name")), value: value(fieldOf(field,"value") as Inferred) });
      }
      shapes.set(key(was), { key: key(was), fields });
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

/** A shape key with every reference's target replaced by a wildcard. */
function wildcardShape(key: string): string {
  return key.replace(/ref<[^<>]*>/g, "ref<*>");
}

export function describe(value: Inferred): string {
  return String(fieldOf(value,"kind")) === "object" ? `object(${String(fieldOf(value,"key"))})` : typeToString(fieldOf(value,"type") as TypeExpr);
}

export function elementOf(value: Inferred): TypeExpr {
  if (String(fieldOf(value,"kind")) === "object") return ANY_REF;
  const type = fieldOf(value,"type") as TypeExpr;
  return String(fieldOf(type,"kind")) === "primitive" ? type : elementOfType(type);
}

function elementOfType(type: TypeExpr): TypeExpr {
  const kind = String(fieldOf(type,"kind"));
  if (kind === "primitive" || kind === "ref" || kind === "void" || kind === "text") return F64;
  return (fieldOf(type,"of") as TypeExpr | null) ?? F64;
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
  const kind = String(fieldOf(expression,"k"));
  if (kind === "literal") return isWholeNumberText(String(fieldOf(expression,"text")));
  if (kind === "unary" && String(fieldOf(expression,"op")) === "+") {
    return countsWholeNumber(fieldOf(expression,"operand") as Expression, inferred);
  }
  const type = fieldOf(inferred,"type") as TypeExpr | undefined;
  return String(fieldOf(inferred,"kind")) === "type" && type !== undefined &&
    String(fieldOf(type,"kind")) === "primitive" && isWhole(fieldOf(type,"name") as PrimitiveTypeName);
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
    switch (String(fieldOf(statement,"kind"))) {
      case "declare":
        if (!whole.has(fieldOf(statement,"name")) && !expressionIsWhole(fieldOf(statement,"init"), counter, whole)) return false;
        break;
      case "loop":
        if (!expressionIsWhole(fieldOf(statement,"from"), counter, whole) || !expressionIsWhole(fieldOf(statement,"to"), counter, whole)) return false;
        if (fieldOf(statement,"step") !== null && !expressionIsWhole(fieldOf(statement,"step"), counter, whole)) return false;
        if (!bodyIsWhole(fieldOf(statement,"body"), fieldOf(statement,"variable"), whole)) return false;
        break;
      case "assign":
      case "memberAssign":
        if (!expressionIsWhole(fieldOf(statement,"value"), counter, whole)) return false;
        break;
      case "update":
        if (!whole.has(fieldOf(statement,"name"))) return false;
        break;
      case "result":
        if (fieldOf(statement,"value") !== null && !expressionIsWhole(fieldOf(statement,"value"), counter, whole)) return false;
        break;
      case "if":
        if (!expressionIsWhole(fieldOf(statement,"condition"), counter, whole)) return false;
        if (!bodyIsWhole(fieldOf(statement,"then"), counter, whole) || !bodyIsWhole(fieldOf(statement,"otherwise"), counter, whole)) return false;
        break;
      case "while":
      case "doWhile":
        if (!expressionIsWhole(fieldOf(statement,"condition"), counter, whole)) return false;
        if (!bodyIsWhole(fieldOf(statement,"body"), counter, whole)) return false;
        break;
      case "forOf":
        if (!bodyIsWhole(fieldOf(statement,"body"), fieldOf(statement,"variable"), whole)) return false;
        break;
      case "print":
        if (!expressionIsWhole(fieldOf(statement,"value"), counter, whole)) return false;
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
    switch (String(fieldOf(statement,"kind"))) {
      case "loop": {
        const hides = shadowed || String(fieldOf(statement,"variable")) === counter;
        if (expressionReads(fieldOf(statement,"from"), counter) || expressionReads(fieldOf(statement,"to"), counter)) return false;
        if (fieldOf(statement,"step") !== null && expressionReads(fieldOf(statement,"step"), counter)) return false;
        if (!bodyIgnoresCounter(fieldOf(statement,"body"), counter, hides)) return false;
        break;
      }
      case "forOf": {
        const hides = shadowed || String(fieldOf(statement,"variable")) === counter;
        if (!bodyIgnoresCounter(fieldOf(statement,"body"), counter, hides)) return false;
        break;
      }
      case "if": {
        if (!shadowed && expressionReads(fieldOf(statement,"condition"), counter)) return false;
        if (!bodyIgnoresCounter(fieldOf(statement,"then"), counter, shadowed)) return false;
        if (!bodyIgnoresCounter(fieldOf(statement,"otherwise"), counter, shadowed)) return false;
        break;
      }
      case "while":
      case "doWhile":
        if (!shadowed && expressionReads(fieldOf(statement,"condition"), counter)) return false;
        if (!bodyIgnoresCounter(fieldOf(statement,"body"), counter, shadowed)) return false;
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
  switch (String(fieldOf(statement,"kind"))) {
    case "declare":
      values.push(fieldOf(statement,"init"));
      break;
    case "assign":
    case "memberAssign":
      values.push(fieldOf(statement,"value"));
      break;
    case "result":
      if (fieldOf(statement,"value") !== null) values.push(fieldOf(statement,"value"));
      break;
    case "print":
      values.push(fieldOf(statement,"value"));
      break;
    default:
      break;
  }
  // A read of the counter is a name in one of these, and a read of the name the
  // statement writes is not one: `total = i` reads it, `i = 2` does not.
  if (String(fieldOf(statement,"kind")) === "assign" && String(fieldOf(statement,"target")) === counter) {
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
    switch (String(fieldOf(statement,"kind"))) {
      case "loop": {
        const hides = shadowed || String(fieldOf(statement,"variable")) === counter;
        if (expressionReadsOutsideIndex(fieldOf(statement,"from"), counter)) return false;
        if (expressionReadsOutsideIndex(fieldOf(statement,"to"), counter)) return false;
        if (fieldOf(statement,"step") !== null && expressionReadsOutsideIndex(fieldOf(statement,"step"), counter)) return false;
        if (!bodyIndexesCounter(fieldOf(statement,"body"), counter, hides)) return false;
        break;
      }
      case "forOf": {
        const hides = shadowed || String(fieldOf(statement,"variable")) === counter;
        if (!bodyIndexesCounter(fieldOf(statement,"body"), counter, hides)) return false;
        break;
      }
      case "if": {
        if (!shadowed && expressionReadsOutsideIndex(fieldOf(statement,"condition"), counter)) return false;
        if (!bodyIndexesCounter(fieldOf(statement,"then"), counter, shadowed)) return false;
        if (!bodyIndexesCounter(fieldOf(statement,"otherwise"), counter, shadowed)) return false;
        break;
      }
      case "while":
      case "doWhile":
        if (!shadowed && expressionReadsOutsideIndex(fieldOf(statement,"condition"), counter)) return false;
        if (!bodyIndexesCounter(fieldOf(statement,"body"), counter, shadowed)) return false;
        break;
      case "indexAssign": {
        // The counter may be the index the element is written at. The buffer it
        // is written into is a name and not a read of the counter, and the value
        // written is an ordinary value.
        if (!shadowed) {
          const at = fieldOf(statement,"index") as Expression;
          if (!(String(fieldOf(at,"k")) === "ident" && String(fieldOf(at,"name")) === counter) && expressionReads(at, counter)) return false;
          if (expressionReadsOutsideIndex(fieldOf(statement,"value"), counter)) return false;
        }
        break;
      }
      case "try": {
        if (!bodyIndexesCounter(fieldOf(statement,"body"), counter, shadowed)) return false;
        if (fieldOf(statement,"catchBody") !== null && !bodyIndexesCounter(fieldOf(statement,"catchBody"), counter, shadowed)) return false;
        if (fieldOf(statement,"finallyBody") !== null && !bodyIndexesCounter(fieldOf(statement,"finallyBody"), counter, shadowed)) return false;
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
  switch (String(fieldOf(statement,"kind"))) {
    case "declare":
      values.push(fieldOf(statement,"init"));
      break;
    case "assign":
    case "memberAssign":
      values.push(fieldOf(statement,"value"));
      break;
    case "result":
      if (fieldOf(statement,"value") !== null) values.push(fieldOf(statement,"value"));
      break;
    case "print":
    case "expression":
      values.push(fieldOf(statement,"value"));
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
  if (String(fieldOf(statement,"kind")) === "assign" && String(fieldOf(statement,"target")) === counter) return false;
  if (String(fieldOf(statement,"kind")) === "update" && String(fieldOf(statement,"name")) === counter) return false;
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
  switch (String(fieldOf(expression,"k"))) {
    case "ident":
      return String(fieldOf(expression,"name")) === counter;
    case "update":
      return String(fieldOf(expression,"name")) === counter;
    case "index": {
      if (String(fieldOf(fieldOf(expression,"index"),"k")) === "ident" && String(fieldOf(fieldOf(expression,"index"),"name")) === counter) {
        return expressionReadsOutsideIndex(fieldOf(expression,"base"), counter);
      }
      return expressionReads(fieldOf(expression,"base"), counter) || expressionReads(fieldOf(expression,"index"), counter);
    }
    case "unary":
      return expressionReadsOutsideIndex(fieldOf(expression,"operand"), counter);
    case "binary":
      return (
        expressionReadsOutsideIndex(fieldOf(expression,"left"), counter) || expressionReadsOutsideIndex(fieldOf(expression,"right"), counter)
      );
    case "conditional":
      return (
        expressionReadsOutsideIndex(fieldOf(expression,"condition"), counter) ||
        expressionReadsOutsideIndex(fieldOf(expression,"then"), counter) ||
        expressionReadsOutsideIndex(fieldOf(expression,"otherwise"), counter)
      );
    case "member":
      return expressionReadsOutsideIndex(fieldOf(expression,"base"), counter);
    case "call":
      for (const argument of fieldOf(expression,"args") as Expression[]) {
        if (expressionReadsOutsideIndex(argument, counter)) return true;
      }
      return false;
    case "argv":
      return fieldOf(expression,"index") === null ? false : expressionReadsOutsideIndex(fieldOf(expression,"index"), counter);
    case "object":
      for (const field of fieldOf(expression,"fields") as { value: Expression }[]) {
        if (expressionReadsOutsideIndex(fieldOf(field,"value") as Expression, counter)) return true;
      }
      return false;
    default:
      return false;
  }
}

/** Whether an expression reads a name, wherever in it the name appears. */
function expressionReads(expression: Expression, counter: string): boolean {
  switch (String(fieldOf(expression,"k"))) {
    case "ident":
      return String(fieldOf(expression,"name")) === counter;
    case "unary":
      return expressionReads(fieldOf(expression,"operand"), counter);
    case "binary":
      return expressionReads(fieldOf(expression,"left"), counter) || expressionReads(fieldOf(expression,"right"), counter);
    case "conditional":
      return (
        expressionReads(fieldOf(expression,"condition"), counter) ||
        expressionReads(fieldOf(expression,"then"), counter) ||
        expressionReads(fieldOf(expression,"otherwise"), counter)
      );
    case "index":
      return expressionReads(fieldOf(expression,"base"), counter) || expressionReads(fieldOf(expression,"index"), counter);
    case "slice":
      return (
        expressionReads(fieldOf(expression,"base"), counter) ||
        (fieldOf(expression,"start") !== null && expressionReads(fieldOf(expression,"start"), counter)) ||
        (fieldOf(expression,"stop") !== null && expressionReads(fieldOf(expression,"stop"), counter)) ||
        (fieldOf(expression,"step") !== null && expressionReads(fieldOf(expression,"step"), counter))
      );
    case "member":
      return expressionReads(fieldOf(expression,"base"), counter);
    case "call":
      for (const argument of fieldOf(expression,"args") as Expression[]) {
        if (expressionReads(argument, counter)) return true;
      }
      return false;
    case "argv":
      return fieldOf(expression,"index") === null ? false : expressionReads(fieldOf(expression,"index"), counter);
    case "object":
      for (const field of fieldOf(expression,"fields") as { value: Expression }[]) {
        if (expressionReads(fieldOf(field,"value") as Expression, counter)) return true;
      }
      return false;
    default:
      return false;
  }
}

/** Whether an expression is written entirely in whole numbers. */
function expressionIsWhole(expression: Expression, counter: string, whole: ReadonlySet<string>): boolean {
  switch (String(fieldOf(expression,"k"))) {
    case "literal":
      return isWholeNumberText(fieldOf(expression,"text"));
    case "bigint":
      return true;
    case "ident":
      return String(fieldOf(expression,"name")) === counter || whole.has(fieldOf(expression,"name"));
    case "unary":
      return expressionIsWhole(fieldOf(expression,"operand"), counter, whole);
    case "conditional":
      return (
        expressionIsWhole(fieldOf(expression,"condition"), counter, whole) &&
        expressionIsWhole(fieldOf(expression,"then"), counter, whole) &&
        expressionIsWhole(fieldOf(expression,"otherwise"), counter, whole)
      );
    case "binary":
      // A division and a power over whole numbers are not whole numbers: `100
      // / i` is a double whatever both sides are, and it is read as one, so a
      // body that divides is not a body written entirely in whole numbers.
      if (String(fieldOf(expression,"op")) === "/" || String(fieldOf(expression,"op")) === "%" || String(fieldOf(expression,"op")) === "**") return false;
      return expressionIsWhole(fieldOf(expression,"left"), counter, whole) && expressionIsWhole(fieldOf(expression,"right"), counter, whole);
    case "index":
      return expressionIsWhole(fieldOf(expression,"base"), counter, whole) && expressionIsWhole(fieldOf(expression,"index"), counter, whole);
    case "slice":
      return (
        expressionIsWhole(fieldOf(expression,"base"), counter, whole) &&
        (fieldOf(expression,"start") === null || expressionIsWhole(fieldOf(expression,"start"), counter, whole)) &&
        (fieldOf(expression,"stop") === null || expressionIsWhole(fieldOf(expression,"stop"), counter, whole)) &&
        (fieldOf(expression,"step") === null || expressionIsWhole(fieldOf(expression,"step"), counter, whole))
      );
    case "member":
      return expressionIsWhole(fieldOf(expression,"base"), counter, whole);
    case "argv":
      return fieldOf(expression,"index") === null || expressionIsWhole(fieldOf(expression,"index"), counter, whole);
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
function inferredType(value: Inferred): TypeExpr | null {
  return String(fieldOf(value,"kind")) === "type" ? fieldOf(value,"type") as TypeExpr : null;
}

export function numeric(left: Inferred, right: Inferred): TypeExpr {
  // A wide number keeps its width, for the same reason a machine word does
  // below it: the rule this function ends on is a double because a double holds
  // every value a program counts with, and a value wider than a machine word is
  // not one of them. Narrowing here would drop every limb above the first
  // before a backend is handed the expression at all.
  const leftType = inferredType(left);
  const rightType = inferredType(right);
  const leftKind = leftType === null ? "" : String(fieldOf(leftType,"kind"));
  const rightKind = rightType === null ? "" : String(fieldOf(rightType,"kind"));
  const leftName = leftType === null ? "" : String(fieldOf(leftType,"name"));
  const rightName = rightType === null ? "" : String(fieldOf(rightType,"name"));
  if (leftKind === "primitive" && isWide(leftName as PrimitiveTypeName)) return leftType as TypeExpr;
  if (rightKind === "primitive" && isWide(rightName as PrimitiveTypeName)) return rightType as TypeExpr;
  // An `i64` is kept beside another whole number, which is the `i64` a bigint
  // is: `2n * 3n` is computed at sixty-four bits because both of its sides
  // are. It is not kept beside a double, because an `i64` is not only a
  // bigint — it is the width a loop counter is counted at, and every counter
  // the resolver cannot type more precisely is an `i64`. So `i + 0.5` inside a
  // loop was answered at sixty-four bits, and the half was dropped before any
  // backend saw it: the array it was written into held `i`.
  const leftWhole = leftKind === "primitive" && leftName === "i64";
  const rightWhole = rightKind === "primitive" && rightName === "i64";
  const leftFloat = leftKind === "primitive" && isFloatType(leftName as PrimitiveTypeName);
  const rightFloat = rightKind === "primitive" && isFloatType(rightName as PrimitiveTypeName);
  if (leftWhole && !rightFloat) return I64;
  if (rightWhole && !leftFloat) return I64;
  if (leftKind === "primitive" && rightKind === "primitive") {
    if (isFloatType(leftName as PrimitiveTypeName) && leftName === rightName) return leftType as TypeExpr;
  }
  return F64;
}

/**
 * What `a ?? b` holds: its left operand, which is a reference where the value
 * being chosen is one. Only an unshaped reference — the null a literal gives,
 * and the `any` the source declared — says nothing, and takes the right.
 */
export function coalesce(left: Inferred, right: Inferred): Inferred {
  if (String(fieldOf(left,"kind")) === "object") return left;
  if (saysNothing(left)) return right;
  return left;
}

/**
 * Whether an inferred value says nothing about what it holds: the unshaped
 * reference `null` is, and the `any` the source declared is. A named
 * reference names an object, so it says something.
 */
export function saysNothing(value: Inferred): boolean {
  const type = fieldOf(value,"type") as TypeExpr | undefined;
  return String(fieldOf(value,"kind")) === "type" && type !== undefined &&
    String(fieldOf(type,"kind")) === "ref" && fieldOf(type,"of") === null && fieldOf(type,"name") === undefined;
}

/** A reference that says nothing about what it points at: `null`, or an `any`. */
function unshapedReference(value: Inferred): boolean {
  const type = fieldOf(value,"type") as TypeExpr | undefined;
  return String(fieldOf(value,"kind")) === "type" && type !== undefined &&
    String(fieldOf(type,"kind")) === "ref" && fieldOf(type,"of") === null;
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
  const leftFields = fieldOf(left,"fields") as { name: string; value: Inferred }[];
  const rightFields = fieldOf(right,"fields") as { name: string; value: Inferred }[];
  if (leftFields.length !== rightFields.length) return false;
  // A pair record is a generated shape with exactly two fields. Its two sides
  // are two values of their own kinds: an unknown reference on one side is the
  // shaped reference the other literal wrote, but it is not a number or a
  // list, so pairs with different field kinds stay apart.
  const pair = leftFields.length === 2 &&
    leftFields.some((field) => String(fieldOf(field,"name")) === "first") &&
    leftFields.some((field) => String(fieldOf(field,"name")) === "second");
  for (const field of leftFields) {
    const fieldName = String(fieldOf(field,"name"));
    const known = rightFields.find((entry) => String(fieldOf(entry,"name")) === fieldName);
    if (known === undefined) return false;
    const fieldValue = fieldOf(field,"value") as Inferred;
    const knownValue = fieldOf(known,"value") as Inferred;
    if (describe(knownValue) === describe(fieldValue)) continue;
    if (!pair) {
      if (unshapedReference(knownValue) || unshapedReference(fieldValue)) continue;
      return false;
    }
    if (unshapedReference(knownValue)) {
      const type = fieldOf(fieldValue,"type") as TypeExpr | undefined;
      if (String(fieldOf(fieldValue,"kind")) === "type" && type !== undefined && String(fieldOf(type,"kind")) === "ref") continue;
      return false;
    }
    if (unshapedReference(fieldValue)) {
      const type = fieldOf(knownValue,"type") as TypeExpr | undefined;
      if (String(fieldOf(knownValue,"kind")) === "type" && type !== undefined && String(fieldOf(type,"kind")) === "ref") continue;
      return false;
    }
    return false;
  }
  return true;
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
  const parent = new Map<string, string>();
  const members = new Map<string, string[]>();
  for (const key of keys) {
    parent.set(key, key);
    members.set(key, [key]);
  }
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
      const firstShaped = (fieldOf(first,"fields") as { value: Inferred }[]).some((field) => !unshapedReference(fieldOf(field,"value") as Inferred));
      const secondShaped = (fieldOf(second,"fields") as { value: Inferred }[]).some((field) => !unshapedReference(fieldOf(field,"value") as Inferred));
      // The relation is not transitive: a shape that says nothing about a
      // reference is the same as either of two shaped ones, and the shaped
      // ones are not the same as each other. A union is made only where every
      // member of one group is the same object as every member of the other.
      const leftGroup = members.get(find(keys[left])) as string[];
      const rightGroup = members.get(find(keys[right])) as string[];
      let compatible = true;
      for (const a of leftGroup) {
        for (const b of rightGroup) {
          const one = shapes.get(a);
          const other = shapes.get(b);
          if (one === undefined || other === undefined || sameShape(one, other)) continue;
          compatible = false;
          break;
        }
        if (!compatible) break;
      }
      if (!compatible) continue;
      const keep = firstShaped === secondShaped ? keys[left] : firstShaped ? keys[left] : keys[right];
      const leftRoot = find(keys[left]);
      const rightRoot = find(keys[right]);
      const root = keep === keys[left] ? leftRoot : rightRoot;
      const gone = root === leftRoot ? rightRoot : leftRoot;
      parent.set(gone, root);
      const merged = members.get(root) as string[];
      merged.push(...(members.get(gone) as string[]));
      members.delete(gone);
    }
  }
  const result = new Map<string, string>();
  for (const key of keys) result.set(key, find(key));
  return result;
}

/**
 * What a program body's own object literals have to say about the shapes the
 * function bodies already laid out. A shape both wrote is one shape and one
 * layout — which is the whole of why a function can be handed an object the
 * body built and read its fields at the offsets it contracted — and a field
 * the two give different types is a layout this cannot state.
 */
function shapeField(name: string, value: Inferred): { name: string; value: Inferred } {
  return { name, value };
}

function shapeFields(shape: Shape): { name: string; value: Inferred }[] {
  return fieldOf(shape,"fields") as { name: string; value: Inferred }[];
}

function mergeProgramShapes(
  shapes: Map<string, Shape>,
  owners: Map<string, string>,
  programShapes: ReadonlyMap<string, Shape>,
): void {
  for (const [key, shape] of programShapes) {
    const existing = shapes.get(key);
    const incoming = shapeFields(shape);
    if (existing === undefined) {
      const fields: { name: string; value: Inferred }[] = [];
      for (const field of incoming) fields.push(shapeField(String(fieldOf(field,"name")), fieldOf(field,"value") as Inferred));
      shapes.set(key, { key, fields });
      owners.set(key, "the program body");
      continue;
    }
    const existingFields = shapeFields(existing);
    for (const field of incoming) {
      const fieldName = String(fieldOf(field,"name"));
      const fieldValue = fieldOf(field,"value") as Inferred;
      const known = existingFields.find((entry) => String(fieldOf(entry,"name")) === fieldName);
      if (known === undefined) {
        existingFields.push(shapeField(fieldName, fieldValue));
        continue;
      }
      const knownValue = fieldOf(known,"value") as Inferred;
      if (describe(knownValue) === describe(fieldValue)) continue;
      throw objectsError(
        `the program body writes "${fieldName}" as ${describe(fieldValue)}, which ${owners.get(key)} has it as ${describe(knownValue)}`,
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
    const incoming = shapeFields(shape);
    if (existing === undefined) {
      const fields: { name: string; value: Inferred }[] = [];
      for (const field of incoming) {
        fields.push(shapeField(String(fieldOf(field,"name")), fieldOf(field,"value") as Inferred));
      }
      shapes.set(key, { key, fields });
      owners.set(key, body.functionName);
      continue;
    }
    const existingFields = shapeFields(existing);
    for (const field of incoming) {
      const fieldName = String(fieldOf(field,"name"));
      const fieldValue = fieldOf(field,"value") as Inferred;
      const known = existingFields.find((entry) => String(fieldOf(entry,"name")) === fieldName);
      if (known === undefined) {
        existingFields.push(shapeField(fieldName, fieldValue));
        continue;
      }
      const knownValue = fieldOf(known,"value") as Inferred;
      if (describe(knownValue) === describe(fieldValue)) continue;
      // A shape the fold has already unified with one that says what its
      // reference points at holds the shaped field, and the unshaped reference
      // the key was written from is the same reference: a body read again in a
      // later round writes the key it wrote before.
      if (unshapedReference(fieldValue)) continue;
      if (unshapedReference(knownValue)) {
        (known as Record<string, unknown>)["value"] = fieldValue;
        continue;
      }
      // A nested object that differs only where one of its own fields says
      // nothing about the reference it points at is the same object: keep the
      // nested type that names the layout.
      if (String(fieldOf(fieldValue,"kind")) === "object" && String(fieldOf(knownValue,"kind")) === "object") {
        const fieldKey = String(fieldOf(fieldValue,"key"));
        const knownKey = String(fieldOf(knownValue,"key"));
        if (wildcardShape(fieldKey) === wildcardShape(knownKey)) {
          if (knownKey.includes("ref<any>")) (known as Record<string, unknown>)["value"] = fieldValue;
          continue;
        }
      }
      throw objectsError(
        `${body.path}: ${body.functionName} writes "${fieldName}" as ${describe(fieldValue)}, which ${owners.get(key)} has it as ${describe(knownValue)}`,
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
  types: ReadonlyMap<string, TypeTable> = new Map(),
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
    for (const contract of Object.values(file.functions)) {
      // A body calls a function by the symbol the link names it by, which is
      // the source name unless another file's function already owns it.
      const symbol = contract.function.symbol;
      callees.set(symbol, parseType(contract.function.returns));
      callers.set(symbol, { file, name: symbol, contract });
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

  // A body is walked once for the objects it writes, and again when a function
  // it calls has an answer the first walk could not name: a call's result is the
  // object the callee's body builds, and the callee's contract names that object
  // only after that body has been walked. Every round re-reads the bodies with
  // the answers the round before settled, and the rounds stop when no answer
  // changed.
  const bodies = new Map<string, BodyTypes>();
  const names = new Map<string, string>();
  const foldedKeys = new Map<string, string>();
  let remapped = new Map<string, string>();
  const walk = (): void => {
    bodies.clear();
    callees.clear();
    for (const [name, caller] of callers) callees.set(name, parseType(caller.contract.function.returns));
    for (const caller of callers.values()) {
      const definition = caller.contract.definition;
      const body = new BodyTypes(
        caller.file.path,
        caller.name,
        caller.contract.function.params.map((param) => ({ name: param.name, type: parseType(param.type) })),
        callees,
        types.get(caller.file.path) ?? null,
        (layout, field) => {
          for (const [key, name] of names) {
            if (name !== layout) continue;
            const shape = shapes.get(key);
            return shape?.fields.find((entry) => entry.name === field)?.value ?? null;
          }
          return null;
        },
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
    remapped = uniteShapes(shapes);
    for (const [key, root] of remapped) {
      if (key !== root) foldedKeys.set(key, root);
    }
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
    // A name a shape already has is kept: a contract was narrowed to it in an
    // earlier round, and a new number would name another object.
    for (const [key, root] of remapped) {
      if (key !== root && names.has(key) && !names.has(root)) names.set(root, names.get(key) as string);
    }
    for (const key of shapes.keys()) {
      if (!names.has(key)) names.set(key, `Object${names.size + 1}`);
    }
  };
  let changed = true;
  for (let round = 0; changed && round <= callers.size; round += 1) {
    walk();
    changed = false;
    for (const caller of callers.values()) {
      const body = bodies.get(caller.name);
      if (body === undefined) continue;
      const result = body.result();
      if (result === null || result.kind !== "object") continue;
      // `any` said a reference without saying to what; the body says which.
      const declared = parseType(caller.contract.function.returns);
      const key = remapped.get(result.key) ?? result.key;
      const layout = names.get(key);
      if (declared.kind === "ref" && declared.of === null && declared.name === undefined && layout !== undefined) {
        caller.contract.function.returns = `ref<${layout}>`;
        changed = true;
      }
    }
  }
  // A shape no body of the last round wrote is a shape an earlier round read
  // with an answer it did not yet have: it is not an object the program has.
  const used = new Set<string>(programShapes.keys());
  for (const body of bodies.values()) {
    for (const key of body.registered.keys()) used.add(key);
  }
  for (const key of [...shapes.keys()]) {
    if (!used.has(key)) shapes.delete(key);
  }

  // Every literal a program body wrote, filed under the key it survived as: the
  // fold moved a shape that unified with another onto the kept key, and a literal
  // is laid out under the key of the shape it ended up in.
  const literalKeys = new Map<ProgramValue & { k: "object" }, string>();
  for (const [literal, key] of programBody.keys) {
    literalKeys.set(literal, remapped.get(key) ?? key);
  }

  const ordered = [...shapes.values()];
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
    const layout = names.get(remapped.get(result.key) ?? result.key);
    if (layout !== undefined) aliases.set(declared.name, layout);
  }

  const written: Record<string, ObjectLayout> = Object.fromEntries([...layouts.entries()].map(([name, shape]) => [name, shape]));
  // Every literal a body registered is one object the body writes: a shape
  // that no round kept still needs the layout its literal was built at.
  const reads = programReads(bodies);
  for (const body of bodies.values()) {
    for (const [key, shape] of body.registered) {
      if (names.has(key)) continue;
      const name = `Object${names.size + 1}`;
      names.set(key, name);
      written[name] = layOut(name, shape, names, reads);
    }
  }
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
  }

  // A shape that was folded into another is still the key a literal body
  // writes under: the IR asks for the name of the shape it saw, and the layout
  // it ended up in is the root's. Follow the folds to the name that survived.
  for (const [key, root] of foldedKeys) {
    let at = root;
    for (let rounds = 0; rounds < foldedKeys.size && foldedKeys.has(at); rounds += 1) {
      at = foldedKeys.get(at) as string;
    }
    const name = names.get(at);
    if (name !== undefined) names.set(key, name);
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

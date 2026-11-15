/**
 * The shapes a program body writes, as the object pass reads a shape.
 *
 * `resolveObjects` walks the function bodies of a program and reads the object
 * literals in them; a program body is statements rather than functions, so the
 * pass does not see its literals and the names it hands out stop short of the
 * objects a program builds for itself. This is that pass's other half: it walks
 * the statements the same way and hands the shapes back in the same form, so
 * every shape of the whole program is named once, laid out once, and the
 * layouts are written into every function definition beside them.
 *
 * It is the same key the contract pass writes — the fields as `[name, type]`
 * pairs, serialized — so a literal a body writes and a literal a function
 * writes over the same fields are one object with one name rather than two.
 *
 * The key of every literal it could read is handed back against the literal
 * itself, so the resolver reads the shape off this pass rather than deriving
 * one of its own: a shape is what the *program* laid out, and the name of it is
 * fixed by the whole walk, after two shapes have been folded into one.
 */
import type { ProgramBody, ProgramStatement, ProgramValue } from "./module.ts";
import type { Inferred, Shape } from "./objects.ts";
import type { PrimitiveTypeName } from "../core/types.ts";
import { ANY_REF, BOOL, F64, I64, addShapeTags, describe } from "./objects.ts";

function fieldOf(value: unknown, key: string): any {
  return (value as Record<string, unknown>)[key];
}

/** Every object literal the pass could read, and the key it was filed under. */
export type LiteralKeys = ReadonlyMap<ProgramValue & { k: "object" }, string>;

/**
 * What a name a literal holds as a field holds, as a contract type.
 *
 * A field of a literal is typed by what it holds, and a name is no different:
 * `{ up: inner }` is a field of the shape `inner` was written at, and the only
 * way to know that shape is to read the name's own declaration. `null` is the
 * answer when the declaration says nothing a shape can be read from — a
 * parameter, a name declared in a block this one is not written in, or a value
 * whose type only a use settles — and the literal is then left out of the pass,
 * which refuses it where the body writes it rather than laying it out at a
 * guess.
 */
export type HeldType = (name: string) => Inferred | null;

/**
 * The type a field value of a literal resolves to.
 *
 * A value the pass cannot read a contract type of is no shape: the literal is
 * left out, and the read of its layout is refused where the body writes it,
 * which is where a missing name can be said rather than commented about.
 */
/** The text a program literal writes into a field, where it is written out. */
function writtenTag(value: ProgramValue): string | null {
  if (value.k !== "text") return null;
  const parts = fieldOf(value, "parts") as readonly { readonly k: string; readonly value: string }[];
  if (parts.length !== 1 || String(fieldOf(parts[0], "k")) !== "text") return null;
  return String(fieldOf(parts[0], "value"));
}

function fieldType(value: ProgramValue, held: HeldType, name?: string): Inferred | null {
  switch (value.k) {
    case "number":
      return { kind: "type", type: F64 };
    case "boolean":
      return { kind: "type", type: BOOL };
    case "whole": {
      const trimmed = String(fieldOf(value, "text")).trim();
      let literal: bigint | null = null;
      try { literal = BigInt(trimmed); } catch { literal = null; }
      const outOfRange = literal === null || literal > 9223372036854775807n || literal < -9223372036854775808n;
      return { kind: "type", type: outOfRange ? { kind: "primitive", name: "u256" } : I64 };
    }
    case "buffer":
      return { kind: "type", type: { kind: "slice", of: { kind: "primitive", name: String(fieldOf(value, "element")) as PrimitiveTypeName } } };
    case "object":
      return { kind: "object", key: keyOf(value, held) };
    // An arrow is a reference to the code it names, which is the value a
    // function-typed field holds. The body it writes is walked by the resolver,
    // and the function it becomes is called through that reference.
    case "arrow":
      return { kind: "type", type: ANY_REF };
    // A string the body wrote out is a pointer to the bytes it names, which
    // is how the backends carry one: the field is a reference to the text, and
    // the reader of the literal handles the value it points at.
    case "text":
      return { kind: "type", type: { kind: "text" } };
    // A name is a field of whatever the name holds, which is its own
    // declaration's answer: a literal is the shape it was written at, and a
    // reference nothing was written from is a reference of no shape — the same
    // answer a `null` gives, because a null is a value any reference can hold.
    case "name":
      return held(String(fieldOf(value, "name")));
    // A null is a reference to nothing, which is how the contract pass types
    // the same field: the link of a tree is written as `null` before anything
    // points at it, and the two spellings are one field of one object.
    case "null":
      return { kind: "type", type: ANY_REF };
    case "conditional": {
      const thenType = fieldType(fieldOf(value, "then") as ProgramValue, held, name);
      const elseType = fieldType(fieldOf(value, "otherwise") as ProgramValue, held, name);
      return thenType !== null ? thenType : (elseType !== null ? elseType : null);
    }
    default:
      // A value with no simpler answer is still laid out as a number of the
      // widest kind a field can hold, which is what the secp256k1 body writes.
      return { kind: "type", type: { kind: "primitive", name: "u256" } };
  }
}

/**
 * The fields a literal writes, spread or not.
 *
 * A spread of an object literal writes that literal's fields, and a spread of a
 * conditional writes the fields either arm writes: both are expanded here, so
 * the shape a literal is filed under is the shape it answers with. A spread of
 * any other value writes fields this pass cannot read — a name, a call — and
 * those fields take no part in the shape, the same answer the pass gives a
 * method a literal writes in shorthand.
 */
export function expandedFields(value: ProgramValue & { k: "object" }): { name: string; value: ProgramValue }[] {
  const out: { name: string; value: ProgramValue }[] = [];
  for (const field of fieldOf(value, "fields") as readonly { readonly name: string; readonly value: ProgramValue }[]) {
    out[out.length] = { name: String(fieldOf(field, "name")), value: fieldOf(field, "value") as ProgramValue };
  }
  for (const spread of (fieldOf(value, "spreads") as readonly ProgramValue[] | undefined) ?? []) {
    if (spread.k === "object") {
      for (const one of expandedFields(spread as ProgramValue & { k: "object" })) out[out.length] = one;
    } else if (spread.k === "conditional") {
      const arms: ProgramValue[] = [fieldOf(spread, "then") as ProgramValue, fieldOf(spread, "otherwise") as ProgramValue];
      for (const arm of arms) {
        if (arm.k === "object") {
          for (const one of expandedFields(arm as ProgramValue & { k: "object" })) out[out.length] = one;
        }
      }
    }
  }
  return out;
}

/**
 * The key a literal is filed under.
 *
 * It is the form the contract pass writes: the fields as `[name, type]` pairs,
 * serialized as one JSON array. A field a body literal holds and the same field
 * a function literal holds therefore spell the same key.
 *
 * A field of a shape the pass cannot read is no key at all, which is how the
 * literal is left out: the read of its layout is refused where the body writes
 * it, rather than laid out at a guess about what the field holds.
 */
function keyOf(value: ProgramValue & { k: "object" }, held: HeldType): string {
  const fields: (readonly [string, string])[] = [];
  for (const field of expandedFields(value)) {
    const fieldName = String(fieldOf(field, "name"));
    const inferred = fieldType(fieldOf(field, "value") as ProgramValue, held, fieldName);
    if (inferred === null) return "";
    fields.push([fieldName, describe(inferred)]);
  }
  return JSON.stringify(fields);
}

/**
 * The literal walk: every object literal the body of a program writes, and
 * every shape they were written at.
 *
 * The walk opens and closes a scope exactly where the resolver opens and closes
 * one, because what a name holds is a question the parse tree answers only in
 * the block it was answered in: a name declared inside an arm of an `if` is gone
 * when the arm ends, and a literal written after that arm naming it is a
 * literal of a shape nothing in the body can say.
 */
class Walk {
  private readonly shapes = new Map<string, Shape>();
  private readonly keys = new Map<ProgramValue & { k: "object" }, string>();
  /**
   * The values the names in scope were declared from, block by block. The value
   * rather than the type, because the type of a name is what a use fixes it to
   * and a literal is written where it was declared.
   */
  private readonly blocks: Map<string, ProgramValue>[] = [new Map()];

  /** What a name holds as a field of a literal, or null when nothing says. */
  private holds(name: string): Inferred | null {
    const blocks = fieldOf(this, "blocks") as Map<string, ProgramValue>[];
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const declared = blocks[index].get(name);
      if (declared !== undefined) return fieldType(declared, (inner) => this.holds(inner), "");
    }
    return null;
  }

  private bind(name: string, value: ProgramValue): void {
    const blocks = fieldOf(this, "blocks") as Map<string, ProgramValue>[];
    blocks[blocks.length - 1].set(name, value);
  }

  private open(): void {
    const blocks = fieldOf(this, "blocks") as Map<string, ProgramValue>[];
    blocks.push(new Map());
  }

  private close(): void {
    const blocks = fieldOf(this, "blocks") as Map<string, ProgramValue>[];
    blocks.pop();
  }

  shapesOf(): Map<string, Shape> {
    return this.shapes;
  }

  keysOf(): Map<ProgramValue & { k: "object" }, string> {
    return this.keys;
  }

  statements(list: readonly ProgramStatement[]): void {
    for (const statement of list) this.statement(statement);
  }

  private statement(statement: ProgramStatement): void {
    switch (statement.kind) {
      case "declare":
        // The value is read before the name is declared, because what the
        // declaration is written from is what it names: a name is in scope from
        // the statement after the one that declares it, exactly as the resolver
        // reads it.
        this.value(fieldOf(statement, "value") as ProgramValue);
        this.bind(String(fieldOf(statement, "name")), fieldOf(statement, "value") as ProgramValue);
        return;
      case "assign":
        this.value(fieldOf(statement, "value") as ProgramValue);
        return;
      case "elementAssign":
        this.value(fieldOf(statement, "index") as ProgramValue);
        this.value(fieldOf(statement, "value") as ProgramValue);
        return;
      case "fieldAssign":
        this.value(fieldOf(statement, "value") as ProgramValue);
        return;
      case "fill":
        this.value(fieldOf(statement, "value") as ProgramValue);
        return;
      case "print":
        for (const value of fieldOf(statement, "values") as readonly ProgramValue[]) this.value(value);
        return;
      case "if":
        this.value(fieldOf(statement, "condition") as ProgramValue);
        // Each arm is a block of its own, and a name declared in one is not a
        // name of the other.
        this.open();
        this.statements(fieldOf(statement, "then") as readonly ProgramStatement[]);
        this.close();
        this.open();
        this.statements(fieldOf(statement, "otherwise") as readonly ProgramStatement[]);
        this.close();
        return;
      case "while":
      case "doWhile":
        this.value(fieldOf(statement, "condition") as ProgramValue);
        this.open();
        this.statements(fieldOf(statement, "body") as readonly ProgramStatement[]);
        this.close();
        return;
      case "for": {
        const from = fieldOf(statement, "from") as ProgramValue;
        this.value(from);
        this.value(fieldOf(statement, "to") as ProgramValue);
        const step = fieldOf(statement, "step") as ProgramValue | null;
        if (step !== null) this.value(step);
        this.open();
        // The counter is a name of the block, and it counts with whatever it
        // counts with: a literal naming it is a field of a double, because a
        // written-out number is one.
        this.bind(String(fieldOf(statement, "variable")), { k: "number", text: from.k === "number" ? String(fieldOf(from, "text")) : "" });
        this.statements(fieldOf(statement, "body") as readonly ProgramStatement[]);
        this.close();
        return;
      }
      case "forOf":
      case "block":
        this.open();
        this.statements(fieldOf(statement, "body") as readonly ProgramStatement[]);
        this.close();
        return;
      case "invoke":
        for (const argument of fieldOf(statement, "args") as readonly ProgramValue[]) this.value(argument);
        return;
      case "function": {
        // The body of a function is a block of its own, and the names its
        // parameters bind are not names the body declares: a literal naming one
        // is a field of a shape only a caller knows. The type the annotation
        // names is what a use of the body can still say, so an annotated
        // parameter answers at that type and one of none answers as the
        // reference a program holds values by.
        this.open();
        for (const param of fieldOf(statement, "params") as readonly { readonly name: string; readonly type: string }[]) {
          const paramName = String(fieldOf(param, "name"));
          if (String(fieldOf(param, "type")) === "number") this.bind(paramName, { k: "number", text: "" });
          // A parameter the source wrote no type for is read at the type its
          // callers pass it at, which is not known here: the shape of a literal
          // naming one is the shape of a reference, which is what a null is.
          else this.bind(paramName, { k: "null" });
        }
        this.statements(fieldOf(statement, "body") as readonly ProgramStatement[]);
        this.close();
        return;
      }
      case "result":
        this.value(fieldOf(statement, "value") as ProgramValue);
        return;
      default:
        return;
    }
  }

  private value(value: ProgramValue): void {
    switch (value.k) {
      case "call":
        for (const argument of fieldOf(value, "args") as readonly ProgramValue[]) this.value(argument);
        return;
      case "unary":
        this.value(fieldOf(value, "operand") as ProgramValue);
        return;
      case "binary":
        this.value(fieldOf(value, "left") as ProgramValue);
        this.value(fieldOf(value, "right") as ProgramValue);
        return;
      case "conditional":
        this.value(fieldOf(value, "condition") as ProgramValue);
        this.value(fieldOf(value, "then") as ProgramValue);
        this.value(fieldOf(value, "otherwise") as ProgramValue);
        return;
      case "text":
        for (const part of fieldOf(value, "parts") as readonly { readonly k: string; readonly value: ProgramValue }[]) {
          if (part.k === "value") this.value(fieldOf(part, "value") as ProgramValue);
        }
        return;
      case "fixed":
        this.value(fieldOf(value, "of") as ProgramValue);
        return;
      case "shared":
        this.value(fieldOf(value, "count") as ProgramValue);
        return;
      case "sized":
        this.value(fieldOf(value, "count") as ProgramValue);
        return;
      case "view":
        this.value(fieldOf(value, "of") as ProgramValue);
        this.value(fieldOf(value, "offset") as ProgramValue);
        this.value(fieldOf(value, "count") as ProgramValue);
        return;
      case "fill":
        this.value(fieldOf(value, "buffer") as ProgramValue);
        this.value(fieldOf(value, "value") as ProgramValue);
        return;
      case "element":
        this.value(fieldOf(value, "index") as ProgramValue);
        return;
      case "field":
        this.value(fieldOf(value, "object") as ProgramValue);
        return;
      case "object": {
        // What a field of this literal holds is read with the names the body
        // declares in scope, so the literal is keyed with them rather than
        // guessed at.
        for (const field of fieldOf(value, "fields") as readonly { readonly value: ProgramValue }[]) this.value(fieldOf(field, "value") as ProgramValue);
        const spreads = fieldOf(value, "spreads") as readonly ProgramValue[] | undefined;
        for (const spread of spreads ?? []) this.value(spread);
        const shape = this.shapeOf(value);
        if (shape !== null && shape.key !== "") {
          (fieldOf(this, "shapes") as Map<string, Shape>).set(shape.key, shape);
          (fieldOf(this, "keys") as Map<ProgramValue & { k: "object" }, string>).set(value, shape.key);
        }
        return;
      }
      case "arrow": {
        // The body of an arrow is written in the same body: the callback of a
        // Promise or of an `http.request` call carries the literals its own
        // statements write. The parameters are values the one that calls the
        // arrow names, so a literal naming one is left out here — the same
        // answer a declaration of a parameter of a function gives.
        this.open();
        this.statements(fieldOf(value, "body") as readonly ProgramStatement[]);
        this.close();
        return;
      }
      default:
        return;
    }
  }

  private shapeOf(value: ProgramValue & { k: "object" }): Shape | null {
    const fields: { name: string; value: Inferred }[] = [];
    const tags: Record<string, string> = {};
    for (const field of expandedFields(value)) {
      const inferred = this.fieldOf(fieldOf(field, "value") as ProgramValue, String(fieldOf(field, "name")));
      if (inferred === null) {
        return null;
      }
      const fieldName = String(fieldOf(field, "name"));
      fields.push({ name: fieldName, value: inferred });
      const tag = writtenTag(fieldOf(field, "value") as ProgramValue);
      if (tag !== null) tags[fieldName] = tag;
    }
    const shape: Shape = { key: this.keyOf(value), fields };
    if (Object.keys(tags).length > 0) addShapeTags(shape, tags);
    return shape;
  }

  /** What one field of a literal holds, read with the names in scope. */
  private fieldOf(value: ProgramValue, name?: string): Inferred | null {
    const inferred = fieldType(value, (name) => this.holds(name), name);
    if (inferred !== null) return inferred;
    // A name is the one thing whose answer is not in the literal itself, and the
    // answer that says nothing is the one the declaration gives: a block nothing
    // was written from is a reference of no shape, which is what a `null` is.
    if (value.k !== "name") return null;
    const declared = this.declaredFrom(String(fieldOf(value, "name")));
    if (declared === undefined) return null;
    if (declared.k === "object" || declared.k === "null") return { kind: "type", type: ANY_REF };
    return null;
  }

  /** The value a name in scope was declared from, wherever the block was. */
  private declaredFrom(name: string): ProgramValue | undefined {
    const blocks = fieldOf(this, "blocks") as Map<string, ProgramValue>[];
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const declared = this.blocks[index].get(name);
      if (declared !== undefined) return declared;
    }
    return undefined;
  }

  private keyOf(value: ProgramValue & { k: "object" }): string {
    const fields: (readonly [string, string])[] = [];
    for (const field of expandedFields(value)) {
      const inferred = this.fieldOf(field.value, field.name);
      if (inferred === null) return "";
      fields.push([field.name, describe(inferred)]);
    }
    return JSON.stringify(fields);
  }
}

/**
 * Every object literal the body of a program writes, by the key the object
 * pass files shapes under, and every literal by that key. The pass walks every
 * statement of the body including the bodies of the functions it declares,
 * because a literal in a function of the program is an object of the same
 * program and is laid out beside the ones the top of the body writes.
 */
export function programShapes(body: ProgramBody): { shapes: Map<string, Shape>; keys: Map<ProgramValue & { k: "object" }, string> } {
  const walk = new Walk();
  walk.statements(fieldOf(body, "statements") as readonly ProgramStatement[]);
  return { shapes: walk.shapesOf(), keys: walk.keysOf() };
}

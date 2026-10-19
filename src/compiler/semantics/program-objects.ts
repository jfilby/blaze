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
import { ANY_REF, BOOL, F64, I64, describe } from "./objects.ts";

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
function fieldType(value: ProgramValue, held: HeldType, name?: string): Inferred | null {
  switch (value.k) {
    case "number":
      return { kind: "type", type: F64 };
    case "boolean":
      return { kind: "type", type: BOOL };
    case "bigint": {
      const trimmed = value.text.trim();
      let literal: bigint | null = null;
      try { literal = BigInt(trimmed); } catch { literal = null; }
      const outOfRange = literal === null || literal > 9223372036854775807n || literal < -9223372036854775808n;
      return { kind: "type", type: outOfRange ? { kind: "primitive", name: "u256" } : I64 };
    }
    case "buffer":
      return { kind: "type", type: { kind: "slice", of: { kind: "primitive", name: value.element } } };
    case "object":
      return { kind: "object", key: keyOf(value, held) };
    // A string the body wrote out is a pointer to the bytes it names, which
    // is how the backends carry one: the field is a reference to the text, and
    // the reader of the literal handles the value it points at.
    case "text":
      return { kind: "type", type: ANY_REF };
    // A name is a field of whatever the name holds, which is its own
    // declaration's answer: a literal is the shape it was written at, and a
    // reference nothing was written from is a reference of no shape — the same
    // answer a `null` gives, because a null is a value any reference can hold.
    case "name":
      return held(value.name);
    // A null is a reference to nothing, which is how the contract pass types
    // the same field: the link of a tree is written as `null` before anything
    // points at it, and the two spellings are one field of one object.
    case "null":
      return { kind: "type", type: ANY_REF };
    case "conditional": {
      const thenType = fieldType(value.then, held, name);
      const elseType = fieldType(value.otherwise, held, name);
      return thenType !== null ? thenType : (elseType !== null ? elseType : null);
    }
    default:
      // A value with no simpler answer is still laid out as a number of the
      // widest kind a field can hold, which is what the secp256k1 body writes.
      return { kind: "type", type: { kind: "primitive", name: "u256" } };
  }
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
  for (const field of value.fields) {
    const inferred = fieldType(field.value, held, field.name);
    if (inferred === null) return "";
    fields.push([field.name, describe(inferred)]);
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
    for (let index = this.blocks.length - 1; index >= 0; index -= 1) {
      const declared = this.blocks[index].get(name);
      if (declared !== undefined) return fieldType(declared, (inner) => this.holds(inner));
    }
    return null;
  }

  private bind(name: string, value: ProgramValue): void {
    this.blocks[this.blocks.length - 1].set(name, value);
  }

  private open(): void {
    this.blocks.push(new Map());
  }

  private close(): void {
    this.blocks.pop();
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
        this.value(statement.value);
        this.bind(statement.name, statement.value);
        return;
      case "assign":
        this.value(statement.value);
        return;
      case "elementAssign":
        this.value(statement.index);
        this.value(statement.value);
        return;
      case "fieldAssign":
        this.value(statement.value);
        return;
      case "fill":
        this.value(statement.value);
        return;
      case "print":
        for (const value of statement.values) this.value(value);
        return;
      case "if":
        this.value(statement.condition);
        // Each arm is a block of its own, and a name declared in one is not a
        // name of the other.
        this.open();
        this.statements(statement.then);
        this.close();
        this.open();
        this.statements(statement.otherwise);
        this.close();
        return;
      case "while":
      case "doWhile":
        this.value(statement.condition);
        this.open();
        this.statements(statement.body);
        this.close();
        return;
      case "for":
        this.value(statement.from);
        this.value(statement.to);
        if (statement.step !== null) this.value(statement.step);
        this.open();
        // The counter is a name of the block, and it counts with whatever it
        // counts with: a literal naming it is a field of a double, because a
        // written-out number is one.
        this.bind(statement.variable, { k: "number", text: statement.from.k === "number" ? statement.from.text : "" });
        this.statements(statement.body);
        this.close();
        return;
      case "forOf":
      case "block":
        this.open();
        this.statements(statement.body);
        this.close();
        return;
      case "invoke":
        for (const argument of statement.args) this.value(argument);
        return;
      case "function": {
        // The body of a function is a block of its own, and the names its
        // parameters bind are not names the body declares: a literal naming one
        // is a field of a shape only a caller knows. The type the annotation
        // names is what a use of the body can still say, so an annotated
        // parameter answers at that type and one of none answers as the
        // reference a program holds values by.
        this.open();
        for (const param of statement.params) {
          if (param.type === "number") this.bind(param.name, { k: "number", text: "" });
          // A parameter the source wrote no type for is read at the type its
          // callers pass it at, which is not known here: the shape of a literal
          // naming one is the shape of a reference, which is what a null is.
          else this.bind(param.name, { k: "null" });
        }
        this.statements(statement.body);
        this.close();
        return;
      }
      case "result":
        this.value(statement.value);
        return;
      default:
        return;
    }
  }

  private value(value: ProgramValue): void {
    switch (value.k) {
      case "call":
        for (const argument of value.args) this.value(argument);
        return;
      case "unary":
        this.value(value.operand);
        return;
      case "binary":
        this.value(value.left);
        this.value(value.right);
        return;
      case "conditional":
        this.value(value.condition);
        this.value(value.then);
        this.value(value.otherwise);
        return;
      case "text":
        for (const part of value.parts) if (part.k === "value") this.value(part.value);
        return;
      case "fixed":
        this.value(value.of);
        return;
      case "shared":
        this.value(value.count);
        return;
      case "sized":
        this.value(value.count);
        return;
      case "view":
        this.value(value.of);
        this.value(value.offset);
        this.value(value.count);
        return;
      case "fill":
        this.value(value.buffer);
        this.value(value.value);
        return;
      case "element":
        this.value(value.index);
        return;
      case "field":
        this.value(value.object);
        return;
      case "object": {
        // What a field of this literal holds is read with the names the body
        // declares in scope, so the literal is keyed with them rather than
        // guessed at.
        for (const field of value.fields) this.value(field.value);
        const shape = this.shapeOf(value);
        if (shape !== null && shape.key !== "") {
          this.shapes.set(shape.key, shape);
          this.keys.set(value, shape.key);
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
        this.statements(value.body);
        this.close();
        return;
      }
      default:
        return;
    }
  }

  private shapeOf(value: ProgramValue & { k: "object" }): Shape | null {
    const fields: { name: string; value: Inferred }[] = [];
    for (const field of value.fields) {
      const inferred = this.fieldOf(field.value, field.name);
      if (inferred === null) {
        return null;
      }
      fields.push({ name: field.name, value: inferred });
    }
    return { key: this.keyOf(value), fields };
  }

  /** What one field of a literal holds, read with the names in scope. */
  private fieldOf(value: ProgramValue, name?: string): Inferred | null {
    const inferred = fieldType(value, (name) => this.holds(name), name);
    if (inferred !== null) return inferred;
    // A name is the one thing whose answer is not in the literal itself, and the
    // answer that says nothing is the one the declaration gives: a block nothing
    // was written from is a reference of no shape, which is what a `null` is.
    if (value.k !== "name") return null;
    const declared = this.declaredFrom(value.name);
    if (declared === undefined) return null;
    if (declared.k === "object" || declared.k === "null") return { kind: "type", type: ANY_REF };
    return null;
  }

  /** The value a name in scope was declared from, wherever the block was. */
  private declaredFrom(name: string): ProgramValue | undefined {
    for (let index = this.blocks.length - 1; index >= 0; index -= 1) {
      const declared = this.blocks[index].get(name);
      if (declared !== undefined) return declared;
    }
    return undefined;
  }

  private keyOf(value: ProgramValue & { k: "object" }): string {
    const fields: (readonly [string, string])[] = [];
    for (const field of value.fields) {
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
  walk.statements(body.statements);
  return { shapes: walk.shapesOf(), keys: walk.keysOf() };
}

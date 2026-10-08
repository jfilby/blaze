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
 */
import type { ProgramBody, ProgramStatement, ProgramValue } from "./module.ts";
import type { Inferred, Shape } from "./objects.ts";
import { ANY_REF, BOOL, F64, I64, describe } from "./objects.ts";

/**
 * The type a field value of a literal resolves to.
 *
 * A value the pass cannot read a contract type of is no shape: the literal is
 * left out, and the read of its layout is refused where the body writes it,
 * which is where a missing name can be said rather than commented about.
 */
function fieldType(value: ProgramValue): Inferred | null {
  switch (value.k) {
    case "number":
      return { kind: "type", type: F64 };
    case "boolean":
      return { kind: "type", type: BOOL };
    case "bigint":
      return { kind: "type", type: I64 };
    case "buffer":
      return { kind: "type", type: { kind: "slice", of: { kind: "primitive", name: value.element } } };
    case "object":
      return { kind: "object", key: shapeKey(value) };
    // A null is a reference to nothing, which is how the contract pass types
    // the same field: the link of a tree is written as `null` before anything
    // points at it, and the two spellings are one field of one object.
    case "null":
      return { kind: "type", type: ANY_REF };
    default:
      return null;
  }
}

/**
 * The key a literal is filed under.
 *
 * It is the form the contract pass writes: the fields as `[name, type]` pairs,
 * serialized as one JSON array. A field a body literal holds and the same field
 * a function literal holds therefore spell the same key.
 */
export function shapeKey(value: ProgramValue & { k: "object" }): string {
  const fields: (readonly [string, string])[] = [];
  for (const field of value.fields) {
    const inferred = fieldType(field.value);
    if (inferred === null) return "";
    fields.push([field.name, describe(inferred)]);
  }
  return JSON.stringify(fields);
}

/** One literal filed under its key, or null when the pass cannot type it. */
function shapeOf(value: ProgramValue & { k: "object" }): Shape | null {
  const fields: { name: string; value: Inferred }[] = [];
  for (const field of value.fields) {
    const inferred = fieldType(field.value);
    if (inferred === null) return null;
    fields.push({ name: field.name, value: inferred });
  }
  return { key: shapeKey(value), fields };
}

/** One value, adding every object literal it writes to the map by its key. */
function visitValue(value: ProgramValue, shapes: Map<string, Shape>): void {
  switch (value.k) {
    case "call":
      for (const argument of value.args) visitValue(argument, shapes);
      return;
    case "unary":
      visitValue(value.operand, shapes);
      return;
    case "binary":
      visitValue(value.left, shapes);
      visitValue(value.right, shapes);
      return;
    case "conditional":
      visitValue(value.condition, shapes);
      visitValue(value.then, shapes);
      visitValue(value.otherwise, shapes);
      return;
    case "text":
      for (const part of value.parts) if (part.k === "value") visitValue(part.value, shapes);
      return;
    case "fixed":
      visitValue(value.of, shapes);
      return;
    case "shared":
      visitValue(value.count, shapes);
      return;
    case "sized":
      visitValue(value.count, shapes);
      return;
    case "view":
      visitValue(value.of, shapes);
      visitValue(value.offset, shapes);
      visitValue(value.count, shapes);
      return;
    case "fill":
      visitValue(value.buffer, shapes);
      visitValue(value.value, shapes);
      return;
    case "element":
      visitValue(value.index, shapes);
      return;
    case "field":
      visitValue(value.object, shapes);
      return;
    case "object": {
      for (const field of value.fields) visitValue(field.value, shapes);
      const shape = shapeOf(value);
      if (shape !== null && shape.key !== "") shapes.set(shape.key, shape);
      return;
    }
    default:
      return;
  }
}

function visitStatement(statement: ProgramStatement, shapes: Map<string, Shape>): void {
  switch (statement.kind) {
    case "declare":
    case "assign":
      visitValue(statement.value, shapes);
      return;
    case "elementAssign":
      visitValue(statement.index, shapes);
      visitValue(statement.value, shapes);
      return;
    case "fill":
      visitValue(statement.value, shapes);
      return;
    case "print":
      for (const value of statement.values) visitValue(value, shapes);
      return;
    case "if":
      visitValue(statement.condition, shapes);
      for (const arm of [...statement.then, ...statement.otherwise]) visitStatement(arm, shapes);
      return;
    case "while":
    case "doWhile":
      visitValue(statement.condition, shapes);
      for (const frame of statement.body) visitStatement(frame, shapes);
      return;
    case "for":
      visitValue(statement.from, shapes);
      visitValue(statement.to, shapes);
      if (statement.step !== null) visitValue(statement.step, shapes);
      for (const frame of statement.body) visitStatement(frame, shapes);
      return;
    case "forOf":
    case "block":
      for (const frame of statement.body) visitStatement(frame, shapes);
      return;
    case "invoke":
      for (const argument of statement.args) visitValue(argument, shapes);
      return;
    case "function":
      for (const frame of statement.body) visitStatement(frame, shapes);
      return;
    case "result":
      visitValue(statement.value, shapes);
      return;
    default:
      return;
  }
}

/**
 * Every object literal the body of a program writes, by the key the object
 * pass files shapes under. The pass walks every statement of the body
 * including the bodies of the functions it declares, because a literal in a
 * function of the program is an object of the same program and is laid out
 * beside the ones the top of the body writes.
 */
export function programShapes(body: ProgramBody): Map<string, Shape> {
  const shapes = new Map<string, Shape>();
  for (const statement of body.statements) visitStatement(statement, shapes);
  return shapes;
}
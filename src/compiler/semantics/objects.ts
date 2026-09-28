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
import type { FileContract, FunctionContract, ObjectLayout, TypeExpr } from "../core/types.ts";
import { BUILTINS } from "./builtins.ts";
import { parseType, typeToString } from "./contract.ts";

/** The number a reference takes: one pointer. */
const POINTER_SIZE = 8;

const F64: TypeExpr = { kind: "primitive", name: "f64" };
const I64: TypeExpr = { kind: "primitive", name: "i64" };
const USIZE: TypeExpr = { kind: "primitive", name: "usize" };
const BOOL: TypeExpr = { kind: "primitive", name: "bool" };
/** A reference to an object whose fields the source never pins down. */
const ANY_REF: TypeExpr = { kind: "ref", of: null };

const COMPARISONS: Record<string, true> = { "<": true, "<=": true, ">": true, ">=": true, "===": true, "!==": true, "==": true, "!=": true };
const LOGICAL: Record<string, true> = { "&&": true, "||": true };

/** What an expression is: a type, or a reference to an object the source wrote. */
type Inferred = { kind: "type"; type: TypeExpr } | { kind: "object"; key: string };

/** One object the source writes, before it is named and laid out. */
interface Shape {
  key: string;
  fields: { name: string; value: Inferred }[];
}

function objectsError(message: string, detail?: string): CompilerError {
  return new CompilerError({ category: "ContractError", stage: "contract", message, detail });
}

/** The size of one field in bytes: a scalar is its width, anything else a pointer. */
function fieldSize(type: TypeExpr): number {
  if (type.kind !== "primitive") return POINTER_SIZE;
  switch (type.name) {
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
      case "bigint":
        return { kind: "type", type: I64 };
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
      case "member": {
        const base = this.expression(expression.base);
        if (base.kind === "object") return this.field(base.key, expression.field);
        return { kind: "type", type: ANY_REF };
      }
      case "call": {
        for (const argument of expression.args) this.expression(argument);
        const builtin = BUILTINS[expression.name];
        if (builtin !== undefined) {
          if (expression.args.length !== builtin.params.length) {
            throw objectsError(
              `${expression.name} takes ${builtin.params.length} argument${builtin.params.length === 1 ? "" : "s"}`,
              `${this.path}: ${this.functionName} calls it with ${expression.args.length}`,
            );
          }
          return { kind: "type", type: builtin.returns };
        }
        const returns = this.callees.get(expression.name);
        if (returns === undefined) {
          throw objectsError(
            `${this.path}: ${this.functionName} calls "${expression.name}", which the program does not compile`,
            "a function may only call the functions of the program it is part of",
          );
        }
        return { kind: "type", type: returns };
      }
      case "object":
        return { kind: "object", key: this.object(expression.fields) };
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

  /** The value a field of a known object holds, or a reference when it is not one. */
  private field(key: string, name: string): Inferred {
    const shape = this.registered.get(key);
    const field = shape?.fields.find((entry) => entry.name === name);
    return field?.value ?? { kind: "type", type: ANY_REF };
  }

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
}

function describe(value: Inferred): string {
  return value.kind === "object" ? `object(${value.key})` : typeToString(value.type);
}

function elementOf(value: Inferred): TypeExpr {
  if (value.kind === "object") return ANY_REF;
  return value.type.kind === "primitive" ? value.type : elementOfType(value.type);
}

function elementOfType(type: TypeExpr): TypeExpr {
  return type.kind === "primitive" || type.kind === "ref" || type.kind === "void" ? F64 : type.of ?? F64;
}

function numeric(left: Inferred, right: Inferred): TypeExpr {
  if (left.kind === "type" && left.type.kind === "primitive" && left.type.name === "i64") return I64;
  if (right.kind === "type" && right.type.kind === "primitive" && right.type.name === "i64") return I64;
  return F64;
}

/**
 * What `a ?? b` holds: its left operand, which is a reference where the value
 * being chosen is one. Only an unshaped reference — the null a literal gives,
 * and the `any` the source declared — says nothing, and takes the right.
 */
function coalesce(left: Inferred, right: Inferred): Inferred {
  if (left.kind === "object") return left;
  if (left.type.kind === "ref" && left.type.of === null && left.type.name === undefined) return right;
  return left;
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
 */
export function resolveObjects(files: readonly FileContract[]): void {
  const shapes = new Map<string, Shape>();
  const owners = new Map<string, string>();
  const callers = new Map<string, { file: FileContract; name: string; contract: FunctionContract }>();
  // Every function the program compiles is callable, whether its contract
  // states what it returns or what it does: a body that calls one needs the
  // other's return type either way, and a function contracted by a
  // postcondition is a function the program still links beside it.
  const callees = new Map<string, TypeExpr>();
  for (const file of files) {
    for (const [name, contract] of Object.entries(file.functions)) {
      callees.set(name, parseType(contract.function.returns));
      if (contract.definition === undefined) continue;
      callers.set(name, { file, name, contract });
    }
  }
  if (callers.size === 0) return;

  // The declared return of every function is known before any body is walked,
  // because one function's body may call another's.
  const bodies = new Map<string, BodyTypes>();
  for (const caller of callers.values()) {
    const definition = caller.contract.definition;
    if (definition === undefined) continue;
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

  const names = new Map<string, string>();
  const ordered = [...shapes.values()];
  ordered.forEach((shape, index) => names.set(shape.key, `Object${index + 1}`));
  const layouts = new Map<string, ObjectLayout>();
  for (const shape of ordered) {
    const name = names.get(shape.key) as string;
    layouts.set(name, layOut(name, shape, names));
  }

  for (const caller of callers.values()) {
    const definition = caller.contract.definition;
    const body = bodies.get(caller.name);
    if (definition === undefined || body === undefined) continue;
    definition.objects = Object.fromEntries([...layouts.entries()].map(([name, shape]) => [name, shape]));
    const result = body.result();
    if (result === null || result.kind !== "object") continue;
    // `any` said a reference without saying to what; the body says which.
    const declared = parseType(caller.contract.function.returns);
    if (declared.kind === "ref" && declared.of === null) {
      caller.contract.function.returns = `ref<${names.get(result.key)}>`;
    }
  }
}

/** The bytes of one object: every field at its own alignment, the object at its own. */
function layOut(name: string, shape: Shape, names: Map<string, string>): ObjectLayout {
  const fields: { name: string; type: string; offset: number }[] = [];
  let offset = 0;
  let align = 1;
  for (const field of shape.fields) {
    const type: TypeExpr =
      field.value.kind === "object" ? { kind: "ref", of: null, name: names.get(field.value.key) } : field.value.type;
    const size = fieldSize(type);
    align = Math.max(align, size);
    offset = alignUp(offset, size);
    fields.push({ name: field.name, type: typeToString(type), offset });
    offset += size;
  }
  return { name, size: alignUp(offset, align), align, fields };
}

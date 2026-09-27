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
  private readonly environment = new Map<string, Inferred>();
  private readonly results: Inferred[] = [];
  private readonly path: string;
  private readonly functionName: string;
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
        this.environment.set(statement.name, statement.type === null ? value : { kind: "type", type: statement.type });
        return;
      }
      case "assign": {
        const value = this.expression(statement.value);
        if (!this.environment.has(statement.target)) this.environment.set(statement.target, value);
        return;
      }
      case "memberAssign":
        this.expression(statement.value);
        return;
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
      case "loop":
        this.environment.set(statement.variable, { kind: "type", type: USIZE });
        this.expression(statement.from);
        this.expression(statement.to);
        if (statement.step !== null) this.expression(statement.step);
        this.statements(statement.body);
        return;
      case "if":
        this.expression(statement.condition);
        this.statements(statement.then);
        this.statements(statement.otherwise);
        return;
      case "while":
      case "doWhile":
        this.expression(statement.condition);
        this.statements(statement.body);
        return;
      case "forOf":
        // The loop walks a name it is given, so its variable is one element of it.
        this.environment.set(statement.variable, { kind: "type", type: this.element(statement.of) });
        this.statements(statement.body);
        return;
      case "break":
      case "continue":
        return;
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
        if (base.kind === "object") {
          const field = this.field(base.key, expression.field);
          this.environment.set(`${this.functionName}.${expression.field}`, field);
          return field;
        }
        this.environment.set(`${this.functionName}.${expression.field}`, { kind: "type", type: ANY_REF });
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
        return { kind: "type", type: numeric(left, right) };
      }
      case "unary":
        return expression.op === "!" ? { kind: "type", type: BOOL } : this.expression(expression.operand);
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
    const key = typed.map((field) => `${field.name}:${describe(field.value)}`).join(",");
    this.registered.set(key, { key, fields: typed });
    return key;
  }

  /** The value a field of a known object holds, or a reference when it is not one. */
  private field(key: string, name: string): Inferred {
    const shape = this.registered.get(key);
    const field = shape?.fields.find((entry) => entry.name === name);
    return field?.value ?? { kind: "type", type: ANY_REF };
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
 * Lays every object of the program out, and writes the layout into the
 * definition of every function that has one. A signature the source left as
 * `any` is narrowed to the object its body actually returns.
 */
export function resolveObjects(files: readonly FileContract[]): void {
  const shapes = new Map<string, Shape>();
  const callers = new Map<string, { file: FileContract; name: string; contract: FunctionContract }>();
  const callees = new Map<string, TypeExpr>();
  for (const file of files) {
    for (const [name, contract] of Object.entries(file.functions)) {
      if (contract.definition === undefined) continue;
      callers.set(name, { file, name, contract });
      callees.set(name, parseType(contract.function.returns));
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
    for (const [key, shape] of body.registered) shapes.set(key, shape);
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

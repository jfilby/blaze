/**
 * Writing a program down.
 *
 * A program's statements are resolved (see program.ts) into a tree of names,
 * types and calls, and this module turns that tree into source. The tree says
 * what the program does; the *target* says how the language it is written in
 * spells it. The walk is here, once, and the two targets — the C driver and
 * the Nim host — differ only in the lines they return, so the two drivers
 * cannot drift apart in what they run.
 *
 * A value with a call in it is written into a temporary before it is used
 * where it would otherwise be written twice, so `a && f()` runs `f` once, as
 * the language the program was written in does.
 */

import { parseType } from "../semantics/contract.ts";
import type { ProgramBinaryOp, ProgramUnaryOp } from "../semantics/module.ts";
import type { TypeExpr } from "../core/types.ts";
import {
  COMPARISON_OPERATORS,
  commonNumber,
  type BufferBinding,
  type ResolvedCall,
  type ResolvedProgram,
  type ResolvedStatement,
  type ResolvedValue,
  isStringValue,
  typeOfValue,
} from "./program.ts";

/** How a value is printed, which is not a question the type alone answers. */
export type PrintKind = "text" | "number" | "boolean" | "null";

/** What a value is, as printing and truth read it. */
export type ValueKind = PrintKind | "reference";

/** What a value is: a string, a number, a truth, nothing, or an object. */
function kindOf(value: ResolvedValue): ValueKind {
  if (value.k === "null") return "null";
  if (isStringValue(value)) return "text";
  if (value.k === "reference" && value.binding.kind === "reference") return "reference";
  // A comparison is a boolean wherever it was written: as `a < b` or as the
  // `a == b` the resolver keeps apart.
  const type = typeOfValue(value);
  if (type !== null && type.kind === "primitive" && type.name === "bool") return "boolean";
  return "number";
}

/**
 * How a target spells what a program does. Every method returns the text of a
 * line, or of a group of them, without indentation: the walk owns the shape of
 * the program, the target owns the language.
 */
export interface ProgramTarget {
  /** Everything above the program body: helpers, object types, the functions. */
  prelude(program: ResolvedProgram): string;
  /** The lines that open the body of the program, runtime and all. */
  openProgram(): string[];
  /** The lines that close it, releasing what the program allocated. */
  closeProgram(releases: string[]): string[];
  /** What the file says after the program body, outside it. */
  epilogue(): string[];

  /** The type a value of this type is declared as. */
  type(type: TypeExpr): string;
  /** The same value read as another type. */
  cast(type: TypeExpr, expression: string): string;
  /** One number as a literal of the type it initializes. */
  literal(text: string, type: string): string;
  /** A line that declares a value; a value of no type is a string. */
  declare(name: string, type: TypeExpr | null, value: string): string;
  /** The lines that allocate a buffer of a known length and write it out. */
  allocate(name: string, element: TypeExpr, length: number, values: string[]): string[];
  /** The lines that name a buffer another name already holds. */
  alias(name: string, element: TypeExpr, source: string, length: string): string[];
  /** One element of a buffer. */
  element(buffer: string, index: string): string;
  /** The line that changes what a name holds. */
  assign(name: string, operator: string, value: string, type: TypeExpr | null): string;
  /** The line that changes one element of a buffer. */
  elementAssign(buffer: string, index: string, operator: string, value: string): string;
  /** The line that moves a number up or down. */
  update(name: string, operator: string, prefix: boolean): string;
  /** The line that frees an allocation when the block it was made in ends. */
  release(name: string): string;

  /** The truth of a value, as a condition reads it. */
  condition(expression: string, kind: ValueKind): string;
  /** A bare block of statements, and the end of any body. */
  openBlock(): string | null;
  closeBody(): string | null;
  /** The statement that stands in for a body that is empty. */
  emptyBody(): string | null;
  /** The header of a conditional, and the `else` that follows its first arm. */
  openIf(condition: string): string;
  openElse(): string;
  /** The headers of the loops, and the lines that close a `do`. */
  openWhile(condition: string): string;
  openDo(condition: string): string[];
  closeDo(condition: string): string[];
  openFor(
    variable: string,
    type: TypeExpr,
    from: string,
    to: string,
    inclusive: boolean,
    down: boolean,
    step: string | null,
  ): string[];
  openForOf(index: string, variable: string, type: TypeExpr, buffer: string, length: string): string[];
  /** The line that leaves the innermost loop, and the one that starts it again. */
  breakLine(): string;
  continueLine(): string;
  /** One of two values, chosen by a condition. */
  conditional(condition: string, then: string, otherwise: string): string;
  /** A call kept for what it does, which may return nothing at all. */
  discard(expression: string, returnsNothing: boolean): string;

  /** One printed value, and the space between two values of one console.log. */
  print(value: string, type: TypeExpr | null, kind: ValueKind): string[];
  separator(): string;
  newline(): string;
  /** A call of a function the program compiled, and one the compiler provides. */
  call(call: ResolvedCall, argumentsText: string[]): string;
  builtin(call: ResolvedCall, argumentsText: string[]): string;
  /** One argument of a call, placed in the type its parameter takes. */
  argument(type: TypeExpr, expression: string): string;

  /** The text of a string, as a literal. */
  stringLiteral(text: string): string;
  /** One string after another. */
  stringConcat(left: string, right: string): string;
  /** The length of a string. */
  stringLength(value: string): string;
  /** Whether two strings are the same text. */
  stringEqual(left: string, right: string): string;
  /** One number written out the way the language writes it. */
  numberText(value: string, type: TypeExpr | null): string;
  /** The line that tests a value against nothing. */
  isNull(value: string, negate: boolean): string;
  /** The text of a value that is nothing. */
  nullLiteral(): string;
  /** The remainder of a division, as C truncates it. */
  modulo(left: string, right: string): string;
  /** One number raised to another, which C and Nim spell differently. */
  power(left: string, right: string): string;
  /** The line that inverts a number bit by bit. */
  bitwiseNot(value: string): string;
  /** The line that inverts a truth. */
  logicalNot(value: string): string;
  /** The operator the language spells for the one the source used. */
  operator(op: ProgramBinaryOp): string;
  /** A name the language reserves, written so that it is not one. */
  escape(name: string): string;
}

/** True when writing a value twice would run it twice. */
function hasCall(value: ResolvedValue): boolean {
  switch (value.k) {
    case "call":
      return true;
    case "buffer":
    case "literal":
    case "boolean":
    case "null":
    case "length":
    case "reference":
      return false;
    case "element":
      return hasCall(value.index);
    case "stringLength":
      return hasCall(value.of);
    case "text":
      return value.parts.some((part) => part.k === "value" && hasCall(part.value));
    case "compare":
      return hasCall(value.left) || hasCall(value.right);
    case "isNull":
      return hasCall(value.operand);
    case "unary":
      return hasCall(value.operand);
    case "binary":
      return hasCall(value.left) || hasCall(value.right);
    case "conditional":
      return hasCall(value.condition) || hasCall(value.then) || hasCall(value.otherwise);
  }
}

/**
 * The type a value is written as. A number no use has fixed is a double, as it
 * is in the language it was written in, and prints as one.
 */
function writtenType(value: ResolvedValue): TypeExpr | null {
  const type = typeOfValue(value);
  if (type !== null) return type;
  return value.k === "literal" ? { kind: "primitive", name: "f64" } : null;
}

/** One line at a depth of a block. */
function indent(depth: number, line: string): string {
  return line === "" ? "" : `${"  ".repeat(depth)}${line}`;
}

const USIZE: TypeExpr = { kind: "primitive", name: "usize" };

class ProgramEmitter {
  private readonly target: ProgramTarget;
  private readonly program: ResolvedProgram;
  /** The body being written, one entry per line. */
  private lines: string[] = [];
  /** Lines that must come before the line being written. */
  private pending: string[] = [];
  /** The buffer literal a binding was written out as, for this statement. */
  private readonly buffers = new Map<BufferBinding, string>();
  /** What each open block must release when it ends, and whether it is a loop. */
  private frames: { releases: string[]; loop: boolean }[] = [];
  /** What the run itself must release when the program ends. */
  private readonly run: string[] = [];
  private depth = 0;
  private counter = 0;

  constructor(program: ResolvedProgram, target: ProgramTarget) {
    this.program = program;
    this.target = target;
  }

  emit(): string {
    const body = this.statements(this.program.statements, 1);
    const opened = this.target.openProgram().map((line) => indent(1, line));
    const closed = this.target.closeProgram(this.run).map((line) => indent(1, line));
    return [this.target.prelude(this.program), ...opened, ...body, ...closed, ...this.target.epilogue(), ""].join("\n");
  }

  /* ---------------------------------------------------------------------- */
  /* Lines                                                                   */
  /* ---------------------------------------------------------------------- */

  private write(line: string): void {
    for (const before of this.pending) this.lines.push(indent(this.depth, before));
    this.pending = [];
    this.lines.push(indent(this.depth, line));
  }

  /** A name no other value of the program can be holding. */
  private fresh(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${this.counter}`;
  }

  /** A value written into a temporary, so a call in it runs once. */
  private temporary(value: ResolvedValue, type: TypeExpr | null): string {
    const name = this.fresh("value");
    this.pending.push(this.target.declare(name, type, this.expression(value, type)));
    return name;
  }

  /* ---------------------------------------------------------------------- */
  /* Statements                                                              */
  /* ---------------------------------------------------------------------- */

  private statements(list: readonly ResolvedStatement[], depth: number): string[] {
    const before = this.lines.length;
    this.depth = depth;
    for (const statement of list) this.statement(statement);
    return this.lines.splice(before);
  }

  private statement(statement: ResolvedStatement): void {
    this.buffers.clear();
    switch (statement.kind) {
      case "declare":
        this.declaration(statement);
        return;
      case "assign":
        this.write(
          this.target.assign(
            this.target.escape(statement.name),
            statement.op,
            this.expression(statement.value, statement.type),
            statement.type,
          ),
        );
        return;
      case "elementAssign":
        this.write(
          this.target.elementAssign(
            this.target.escape(statement.buffer),
            this.expression(statement.index, USIZE),
            statement.op,
            this.expression(statement.value, statement.type),
          ),
        );
        return;
      case "update":
        this.write(this.target.update(this.target.escape(statement.name), statement.op, statement.prefix));
        return;
      case "print":
        this.print(statement.values);
        return;
      case "invoke": {
        this.write(this.target.discard(this.call(statement.call), statement.call.returns.kind === "void"));
        return;
      }
      case "if":
        this.write(this.target.openIf(this.condition(statement.condition)));
        this.body(statement.then);
        if (statement.otherwise.length > 0) {
          this.write(this.target.closeBody() ?? "");
          this.write(this.target.openElse());
          this.body(statement.otherwise);
        }
        this.write(this.target.closeBody() ?? "");
        return;
      case "while":
        this.write(this.target.openWhile(this.condition(statement.condition)));
        this.body(statement.body, true);
        this.write(this.target.closeBody() ?? "");
        return;
      case "doWhile": {
        // The condition is asked for before the body, because a language
        // without a do-while tests it at the top of the loop.
        const condition = this.condition(statement.condition);
        for (const line of this.target.openDo(condition)) this.write(line);
        this.body(statement.body, true);
        for (const line of this.target.closeDo(condition)) this.write(line);
        return;
      }
      case "for": {
        const type = statement.type;
        const to = this.expression(statement.to, type);
        for (const line of this.target.openFor(
          this.target.escape(statement.variable),
          type,
          this.expression(statement.from, type),
          to,
          statement.inclusive,
          statement.down,
          statement.step === null ? null : this.expression(statement.step, type),
        )) {
          this.write(line);
        }
        this.body(statement.body, true);
        this.write(this.target.closeBody() ?? "");
        return;
      }
      case "forOf": {
        const index = this.fresh("index");
        for (const line of this.target.openForOf(
          index,
          this.target.escape(statement.variable),
          statement.type,
          this.target.escape(statement.of),
          this.expression(statement.length),
        )) {
          this.write(line);
        }
        this.body(statement.body, true);
        this.write(this.target.closeBody() ?? "");
        return;
      }
      case "break":
        for (const line of this.releases(true)) this.write(line);
        this.write(this.target.breakLine());
        return;
      case "continue":
        for (const line of this.releases(false)) this.write(line);
        this.write(this.target.continueLine());
        return;
      case "block":
        this.write(this.target.openBlock() ?? "");
        this.body(statement.body);
        this.write(this.target.closeBody() ?? "");
        return;
    }
  }

  private print(values: readonly ResolvedValue[]): void {
    values.forEach((value, position) => {
      if (position > 0) this.write(this.target.separator());
      for (const line of this.target.print(this.expression(value), writtenType(value), kindOf(value))) this.write(line);
    });
    this.write(this.target.newline());
  }

  private declaration(statement: ResolvedStatement & { kind: "declare" }): void {
    const binding = statement.binding;
    const name = this.target.escape(statement.name);
    const value = statement.value;
    if (value.k === "reference" && value.binding.kind === "buffer") {
      // `const b = a` names the same array again, as the language means it.
      const source = value.binding;
      for (const line of this.target.alias(
        name,
        { kind: "primitive", name: source.element ?? "f64" },
        this.target.escape(source.name),
        `${this.target.escape(source.name)}_length`,
      )) {
        this.write(line);
      }
      return;
    }
    if (binding.kind === "buffer") {
      const element = { kind: "primitive" as const, name: binding.element ?? "f64" };
      for (const line of this.target.allocate(name, element, binding.length, binding.values.map((value) => this.expression(value, element)))) {
        this.write(line);
      }
      this.releaseAt(name);
      return;
    }
    if (binding.kind === "string" && binding.value !== null) {
      this.write(this.target.declare(name, null, this.target.stringLiteral(binding.value)));
      return;
    }
    // A number is declared as the number it is, and a string as a string: a
    // literal that no use has fixed is a double, as it is in the language.
    const type =
      binding.kind === "scalar"
        ? { kind: "primitive" as const, name: binding.type ?? "f64" }
        : binding.kind === "string"
          ? null
          : typeOfValue(statement.value);
    this.write(this.target.declare(name, type, this.expression(statement.value, type)));
  }

  /** The statements of one body, in a block of their own. */
  private body(list: readonly ResolvedStatement[], loop = false): void {
    this.frames.push({ releases: [], loop });
    this.depth += 1;
    if (list.length === 0) {
      const empty = this.target.emptyBody();
      if (empty !== null) this.write(empty);
    }
    for (const statement of list) this.statement(statement);
    // What the block allocated is freed before it ends, which is inside the
    // braces of one target and inside the indentation of the other.
    const frame = this.frames.pop();
    for (const line of frame?.releases.reverse() ?? []) this.lines.push(indent(this.depth, line));
    this.depth -= 1;
  }

  /* ---------------------------------------------------------------------- */
  /* Values                                                                  */
  /* ---------------------------------------------------------------------- */

  private condition(value: ResolvedValue): string {
    return this.target.condition(this.expression(value), kindOf(value));
  }

  private call(call: ResolvedCall): string {
    const argumentsText = call.args.map((argument, index) => {
      const type = parseType(call.signature.params[index].type);
      return this.target.argument(type, this.expression(argument, type));
    });
    return call.builtin ? this.target.builtin(call, argumentsText) : this.target.call(call, argumentsText);
  }

  private expression(value: ResolvedValue, as: TypeExpr | null = null): string {
    if (value.k === "literal" && value.binding.type === null && as !== null && as.kind === "primitive") {
      return this.target.literal(value.binding.text, as.name);
    }
    const text = this.raw(value, as);
    if (as === null) return text;
    const from = typeOfValue(value);
    if (from === null || from.kind !== "primitive" || as.kind !== "primitive") return text;
    return from.name === as.name ? text : this.target.cast(as, text);
  }

  private raw(value: ResolvedValue, as: TypeExpr | null): string {
    switch (value.k) {
      case "literal":
        return this.target.literal(value.binding.text, value.binding.type ?? "f64");
      case "boolean":
        return value.value ? "true" : "false";
      case "null":
        return this.target.nullLiteral();
      case "buffer":
        return this.bufferName(value.binding);
      case "reference":
        return this.target.escape(value.name);
      case "length":
        return `${this.target.escape(value.buffer)}_length`;
      case "element":
        return this.target.element(this.target.escape(value.buffer), this.expression(value.index, USIZE));
      case "stringLength":
        return this.target.stringLength(this.expression(value.of));
      case "call":
        return this.call(value.call);
      case "text":
        return this.text(value);
      case "compare":
        return this.compare(value);
      case "isNull":
        return this.target.isNull(this.expression(value.operand), value.negate);
      case "unary":
        return this.unary(value);
      case "binary":
        return this.binary(value);
      case "conditional":
        return this.target.conditional(
          this.condition(value.condition),
          this.expression(value.then, as),
          this.expression(value.otherwise, as),
        );
    }
  }

  /** A string the program builds, one part after another. */
  private text(value: ResolvedValue & { k: "text" }): string {
    if (value.parts.length === 0) return this.target.stringLiteral("");
    let text: string | null = null;
    for (const part of value.parts) {
      const piece =
        part.k === "text"
          ? this.target.stringLiteral(part.value)
          : this.target.numberText(this.expression(part.value), writtenType(part.value));
      text = text === null ? piece : this.target.stringConcat(text, piece);
    }
    return text as string;
  }

  private compare(value: ResolvedValue & { k: "compare" }): string {
    if (value.how === "string") {
      const equal = this.target.stringEqual(this.expression(value.left), this.expression(value.right));
      return value.negate ? this.target.logicalNot(equal) : equal;
    }
    // The two sides are compared as one type, so a whole number and a literal
    // are compared as whole numbers rather than as two different ones.
    const type = commonNumber(typeOfValue(value.left), typeOfValue(value.right));
    const equal = `${this.expression(value.left, type)} == ${this.expression(value.right, type)}`;
    return value.negate ? this.target.logicalNot(equal) : equal;
  }

  private unary(value: ResolvedValue & { k: "unary" }): string {
    if (value.op === "!") return this.target.logicalNot(this.condition(value.operand));
    if (value.op === "~") return this.target.bitwiseNot(this.expression(value.operand, value.type));
    return `(${value.op}${this.expression(value.operand, value.type)})`;
  }

  private binary(value: ResolvedValue & { k: "binary" }): string {
    const op: ProgramBinaryOp = value.op;
    // The left arm of a logical operator decides, and the source form of these
    // operators writes it twice, so a call in it is written out once first.
    if (op === "&&" || op === "||" || op === "??") {
      const type = typeOfValue(value.left);
      const left = hasCall(value.left) ? this.temporary(value.left, type) : this.expression(value.left);
      const right = this.expression(value.right, value.type);
      if (op === "??") {
        // Only a reference or a string can be nothing: a number never is.
        if (value.left.k === "null" || isStringValue(value.left)) {
          return this.target.conditional(this.target.isNull(left, false), right, left);
        }
        return left;
      }
      const test = this.target.condition(left, kindOf(value.left));
      if (op === "&&") return this.target.conditional(test, right, left);
      return this.target.conditional(test, left, right);
    }
    if (op === "%") {
      return this.target.modulo(this.expression(value.left, value.type), this.expression(value.right, value.type));
    }
    if (op === "+" && value.type === null) {
      // A string is added to a string: the driver builds the text.
      return this.target.stringConcat(this.expression(value.left), this.expression(value.right));
    }
    if (op === "**") {
      // A power is floating point even over whole numbers, and Nim spells one
      // with the operator that xors two whole numbers.
      return this.target.power(this.expression(value.left, value.type), this.expression(value.right, value.type));
    }
    const type = COMPARISON_OPERATORS.includes(op)
      ? commonNumber(typeOfValue(value.left), typeOfValue(value.right))
      : value.type;
    return `(${this.expression(value.left, type)} ${this.target.operator(op)} ${this.expression(value.right, type)})`;
  }

  /** The buffer a literal is written out as, allocating it the first time. */
  private bufferName(binding: BufferBinding): string {
    const written = this.buffers.get(binding);
    if (written !== undefined) return written;
    const name = this.fresh("buffer");
    this.buffers.set(binding, name);
    const element = { kind: "primitive" as const, name: binding.element ?? "f64" };
    for (const line of this.target.allocate(name, element, binding.length, binding.values.map((value) => this.expression(value, element)))) {
      this.pending.push(line);
    }
    this.releaseAt(name);
    return name;
  }

  /**
   * What a `break` or a `continue` must free before it leaves: every block it
   * leaves, and a `break` leaves the loop as well. Without this, an allocation
   * made in a loop is never freed on the path that jumps out of it.
   */
  private releases(leavesTheLoop: boolean): string[] {
    const lines: string[] = [];
    for (let index = this.frames.length - 1; index >= 0; index -= 1) {
      const frame = this.frames[index];
      for (const line of [...frame.releases].reverse()) lines.push(line);
      frame.releases.length = 0;
      // A continue stays in the loop it is written in, so it leaves every
      // block but the loop; a break leaves the loop as well.
      if (frame.loop && !leavesTheLoop) break;
    }
    return lines;
  }

  /** Frees an allocation when the block it was made in ends. */
  private releaseAt(name: string): void {
    const frame = this.frames[this.frames.length - 1];
    if (frame === undefined) this.run.push(this.target.release(name));
    else frame.releases.push(this.target.release(name));
  }
}

/** Emits the source of one program in the language a target speaks. */
export function generateProgramSource(program: ResolvedProgram, target: ProgramTarget): string {
  return new ProgramEmitter(program, target).emit();
}

export type { ProgramBinaryOp, ProgramUnaryOp };

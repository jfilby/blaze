/**
 * Writing a program down.
 *
 * A program's statements are resolved (see semantics/ir-resolve.ts) into the
 * semantic IR (see core/semantic-ir.ts), a target-independent tree of types,
 * names, blocks and calls, and this module turns that tree into source. The
 * tree says what the program does; the *target* says how the language it is
 * written in spells it. The walk is here, once, and the two targets — the C
 * driver and the Nim host — differ only in the lines they return, so the two
 * drivers cannot drift apart in what they run.
 *
 * Everything the walk used to have to invent is in the IR by now: every
 * temporary and every generated array is named before the walk sees it, every
 * value states the type it is written as, and every block states what it owns
 * and where control goes when it ends. So the walk decides only the order of
 * the lines and which target method each node asks for.
 */

import { CompilerError } from "../core/errors.ts";
import { NameScope } from "./names.ts";
import type { ProgramBinaryOp, ProgramUnaryOp } from "../semantics/module.ts";
import type { SemanticProgram } from "../semantics/ir-resolve.ts";
import type { TypeExpr } from "../core/types.ts";
import {
  elementTypeOf,
  isNumber,
  isSequence,
  isTextType,
  slotType,
  typeText,
  valueKind,
  type CompareOp,
  type SemanticBlock,
  type SemanticCall,
  type SemanticLoop,
  type SemanticSlot,
  type SemanticStatement,
  type SemanticTerminator,
  type SemanticType,
  type SemanticValue,
  type ValueKind,
} from "../core/semantic-ir.ts";

/**
 * The operator the source wrote for the one the IR states. The targets spell
 * operators as the source language writes them, so the walk translates the one
 * name into the other and leaves the spelling to the target.
 */
const ARITH_OPERATORS: Record<"add" | "sub" | "mul" | "div" | "shl" | "shr" | "and" | "or" | "xor", ProgramBinaryOp> = {
  add: "+",
  sub: "-",
  mul: "*",
  div: "/",
  shl: "<<",
  shr: ">>",
  and: "&",
  or: "|",
  xor: "^",
};

/** The comparison the IR states, as C and Nim both spell it. */
const COMPARE_OPERATORS: Record<CompareOp, string> = {
  eq: "==",
  ne: "!=",
  lt: "<",
  le: "<=",
  gt: ">",
  ge: ">=",
};

/**
 * How a target spells what a program does. Every method returns the text of a
 * line, or of a group of them, without indentation: the walk owns the shape of
 * the program, the target owns the language.
 */
export interface ProgramTarget {
  /** Everything above the program body: helpers, object types, the functions. */
  prelude(program: SemanticProgram): string;
  /** The lines that open the body of the program, runtime and all. */
  openProgram(): string[];
  /** The lines that close it, releasing what the program allocated. */
  closeProgram(releases: readonly string[]): string[];
  /** What the file says after the program body, outside it. */
  epilogue(): string[];

  /** The type a value of this type is declared as. */
  type(type: SemanticType): string;
  /** The same value read as another type. */
  cast(type: SemanticType, expression: string): string;
  /** One number as a literal of the type it initializes. */
  literal(text: string, type: string): string;
  /** A line that declares a value; a value of no type is a string. */
  declare(name: string, type: SemanticType | null, value: string): string;
  /** The lines that allocate a buffer of a known length and write it out. */
  allocate(name: string, element: SemanticType, length: number, values: string[]): string[];
  /** The lines that name a buffer another name already holds. */
  alias(name: string, element: SemanticType, source: string, length: string): string[];
  /** One element of a buffer. */
  element(buffer: string, index: string): string;
  /** The line that changes what a name holds. */
  assign(name: string, operator: string, value: string, type: SemanticType | null): string;
  /** The line that changes one element of a buffer. */
  elementAssign(buffer: string, index: string, operator: string, value: string): string;
  /** The line that moves a number up or down. */
  update(name: string, operator: string, prefix: boolean): string;
  /** The line that frees an allocation when the block it was made in ends. */
  release(name: string): string;
  /** The line that keeps a reference alive across a release of it. */
  retain(value: string): string;
  /** One field of an object, read and written, of the layout it is a field of. */
  field(object: string, layout: string, field: string): string;
  assignField(object: string, layout: string, field: string, value: string): string;
  /** The value an object is built as, allocated and with every field written. */
  buildObject(layout: string, fields: { field: string; value: string }[]): string;
  /** Ends the program with a message. Nothing after it runs. */
  raise(message: string): string;

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
    type: SemanticType,
    from: string,
    to: string,
    inclusive: boolean,
    down: boolean,
    step: string | null,
  ): string[];
  openForOf(index: string, variable: string, type: SemanticType, buffer: string, length: string): string[];
  /** The line that leaves the innermost loop, and the one that starts it again. */
  breakLine(): string;
  continueLine(): string;
  /** One of two values, chosen by a condition. */
  conditional(condition: string, then: string, otherwise: string): string;
  /** A call kept for what it does, which may return nothing at all. */
  discard(expression: string, returnsNothing: boolean): string;

  /** One printed value, read the way printing reads it. */
  print(value: string, type: SemanticType | null, kind: ValueKind): string[];
  /** The newline that ends a line of output. */
  newline(): string;
  /** A call of a function the program compiled, and one the compiler provides. */
  call(call: SemanticCall, argumentsText: string[]): string;
  builtin(call: SemanticCall, argumentsText: string[]): string;
  /** One argument of a call, placed in the type its parameter takes. */
  argument(type: SemanticType, expression: string): string;
  /** How many arguments the program was started with, and one of them. */
  argvCount(): string;
  argv(index: string): string;
  /** The smaller and the larger of two numbers, which the languages spell. */
  min(left: string, right: string): string;
  max(left: string, right: string): string;

  /** The text of a string, as a literal. */
  stringLiteral(text: string): string;
  /** One string after another. */
  stringConcat(left: string, right: string): string;
  /** The length of a string. */
  stringLength(value: string): string;
  /** Whether two strings are the same text. */
  stringEqual(left: string, right: string): string;
  /** A value carried inside a string, as the runtime writes it. */
  toText(expression: string, type: SemanticType): string;
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

/** A node neither target has been taught to write, which is a refusal. */
function emitError(message: string, detail?: string): CompilerError {
  return new CompilerError({ category: "SemanticIrError", stage: "emit", message, detail });
}

/** One line at a depth of a block. */
function indent(depth: number, line: string): string {
  return line === "" ? "" : `${"  ".repeat(depth)}${line}`;
}

const USIZE: TypeExpr = { kind: "primitive", name: "usize" };

class ProgramEmitter {
  private readonly target: ProgramTarget;
  private readonly program: SemanticProgram;
  /** The body being written, one entry per line. */
  private lines: string[] = [];
  /** The loops whose bodies are being written, the innermost last. */
  private readonly loops: { header: string; exit: string }[] = [];
  private depth = 0;
  /** The names the program declared, and the names a target reads them by. */
  private names!: NameScope;

  constructor(program: SemanticProgram, target: ProgramTarget) {
    this.program = program;
    this.target = target;
    this.names = new NameScope((name) => target.escape(name));
  }

  emit(): string {
    const body = this.entry();
    const opened = this.target.openProgram().map((line) => indent(1, line));
    const closed = this.target
      .closeProgram(this.program.entry.releases.map((name) => this.target.release(this.names.read(name))))
      .map((line) => indent(1, line));
    return [this.target.prelude(this.program), ...opened, ...body, ...closed, ...this.target.epilogue(), ""].join("\n");
  }

  /* ---------------------------------------------------------------------- */
  /* Lines                                                                   */
  /* ---------------------------------------------------------------------- */

  private write(line: string): void {
    this.lines.push(indent(this.depth, line));
  }

  /** The statements of the block the run starts in, and where it ends. */
  private entry(): string[] {
    this.depth = 1;
    for (const statement of this.program.entry.statements) this.statement(statement);
    this.terminator(this.program.entry.terminator, null);
    return this.lines;
  }

  /* ---------------------------------------------------------------------- */
  /* Statements                                                              */
  /* ---------------------------------------------------------------------- */

  private statement(statement: SemanticStatement): void {
    switch (statement.k) {
      case "let":
        this.declaration(statement.slot, statement.value);
        return;
      case "set": {
        const type = this.names.typeOf(statement.name, statement.value.type);
        this.write(
          this.target.assign(this.names.read(statement.name), statement.op, this.expression(statement.value, type), type),
        );
        return;
      }
      case "setElement": {
        const buffer = this.names.declared(statement.buffer);
        const element = buffer?.type !== null && buffer?.type !== undefined ? elementTypeOf(buffer.type) : null;
        this.write(
          this.target.elementAssign(
            this.names.read(statement.buffer),
            this.expression(statement.index, USIZE),
            statement.op,
            this.expression(statement.value, element ?? statement.value.type),
          ),
        );
        return;
      }
      case "step":
        this.write(this.target.update(this.names.read(statement.name), statement.op, statement.prefix));
        return;
      case "printText":
      case "printNumber":
        for (const line of this.target.print(
          this.expression(statement.value),
          statement.value.type,
          valueKind(statement.value),
        )) {
          this.write(line);
        }
        return;
      case "printNewline":
        this.write(this.target.newline());
        return;
      case "call":
        this.write(this.target.discard(this.call(statement.call), statement.call.returns.kind === "void"));
        return;
      case "if":
        this.write(this.target.openIf(this.condition(statement.condition)));
        this.body(statement.then, null);
        if (statement.otherwise !== null) {
          this.write(this.target.closeBody() ?? "");
          this.write(this.target.openElse());
          this.body(statement.otherwise, null);
        }
        this.write(this.target.closeBody() ?? "");
        return;
      case "loop":
        this.loop(statement.loop);
        return;
      case "block":
        this.write(this.target.openBlock() ?? "");
        this.body(statement.body, null);
        this.write(this.target.closeBody() ?? "");
        return;
      case "retain":
        this.write(this.target.retain(this.expression(statement.value)));
        return;
      case "raise":
        this.write(this.target.raise(this.expression(statement.message)));
        return;
      case "storeField":
        this.write(
          this.target.assignField(
            this.expression(statement.object),
            statement.layout,
            this.target.escape(statement.field),
            this.expression(statement.value),
          ),
        );
        return;
    }
  }

  private declaration(slot: SemanticSlot, value: SemanticValue): void {
    const name = this.names.declare(slot.name, slotType(slot));
    if (slot.kind === "text") {
      this.write(this.target.declare(name, null, this.expression(value)));
      return;
    }
    if (slot.kind === "buffer") {
      // `const b = a` names the same array again, as the language means it.
      if (value.k === "local" && isSequence(value.type)) {
        for (const line of this.target.alias(
          name,
          slot.element,
          this.names.read(value.name),
          `${this.names.read(value.name)}_length`,
        )) {
          this.write(line);
        }
        return;
      }
      if (value.k !== "buffer") throw emitError(`the emitter cannot write down ${slot.name} as an array`);
      for (const line of this.target.allocate(
        name,
        slot.element,
        value.length,
        value.values.map((one) => this.expression(one, slot.element)),
      )) {
        this.write(line);
      }
      return;
    }
    this.write(this.target.declare(name, slot.type, this.expression(value, slot.type)));
  }

  private loop(loop: SemanticLoop): void {
    this.loops.push({ header: loop.header, exit: loop.exit });
    // The loop owns the names it counts with, so they are declared here rather
    // than in the body, and a later loop may count with the same name again.
    // The buffer a `for..of` iterates is read here, in the scope the loop was
    // entered in, and not in the loop's own. An element declared under the
    // same name as the buffer shadows it, so reading the buffer after the
    // declaration made the loop count over the element it had not taken yet.
    const buffer = loop.kind === "each" ? this.names.read(loop.of) : null;
    const length = loop.kind === "each" ? this.expression(loop.length) : null;
    this.names.enter();
    if (loop.kind === "counted") this.names.declare(loop.variable);
    if (loop.kind === "each") {
      this.names.declare(loop.index);
      this.names.declare(loop.element);
    }
    // A `do` closes itself with its own condition, so it is the one loop the
    // walk does not close with a brace of its own.
    let closedByDo = false;
    switch (loop.kind) {
      case "while":
        this.write(this.target.openWhile(this.condition(loop.condition)));
        this.body(loop.body, loop);
        break;
      case "doWhile": {
        // The condition is asked for before the body, because a language
        // without a do-while tests it at the top of the loop.
        const condition = this.condition(loop.condition);
        for (const line of this.target.openDo(condition)) this.write(line);
        this.body(loop.body, loop);
        for (const line of this.target.closeDo(condition)) this.write(line);
        closedByDo = true;
        break;
      }
      case "counted": {
        const type = loop.type;
        for (const line of this.target.openFor(
          this.names.read(loop.variable),
          type,
          this.expression(loop.from, type),
          this.expression(loop.to, type),
          loop.inclusive,
          loop.down,
          loop.step === null ? null : this.expression(loop.step, type),
        )) {
          this.write(line);
        }
        this.body(loop.body, loop);
        break;
      }
      case "each": {
        for (const line of this.target.openForOf(
          this.names.read(loop.index),
          this.names.read(loop.element),
          loop.elementType,
          buffer as string,
          length as string,
        )) {
          this.write(line);
        }
        this.body(loop.body, loop);
        break;
      }
    }
    if (!closedByDo) this.write(this.target.closeBody() ?? "");
    this.loops.pop();
    this.names.leave();
  }

  /** The statements of one block, and what is done when it ends. */
  private body(block: SemanticBlock, loop: SemanticLoop | null): void {
    this.names.enter();
    this.depth += 1;
    if (block.statements.length === 0 && block.terminator.k === "next") {
      const empty = this.target.emptyBody();
      if (empty !== null) this.write(empty);
    }
    for (const statement of block.statements) this.statement(statement);
    // What the block allocated is freed before it ends, which is inside the
    // braces of one target and inside the indentation of the other. A block
    // that ends in a jump is not fallen out of, and the jump frees what the
    // blocks it leaves own instead — the jump's own releases already say which.
    if (block.terminator.k === "next" || block.terminator.k === "return") {
      for (const name of block.releases) this.lines.push(indent(this.depth, this.target.release(this.names.read(name))));
    }
    this.terminator(block.terminator, loop);
    this.depth -= 1;
    this.names.leave();
  }

  /**
   * Where control goes when a block is done. A jump names the block it leaves,
   * which is either the header of the loop it is in — the run goes on from the
   * top of it — or the block the loop sits in, which the run carries on from.
   */
  private terminator(terminator: SemanticTerminator, loop: SemanticLoop | null): void {
    if (terminator.k !== "jump") return;
    for (const name of terminator.releases) this.write(this.target.release(this.names.read(name)));
    const open = loop ?? this.loops[this.loops.length - 1];
    if (open === undefined) throw emitError("a jump out of a block no loop is written in", terminator.target);
    if (terminator.target === open.header) {
      this.write(this.target.continueLine());
      return;
    }
    if (terminator.target === open.exit) {
      this.write(this.target.breakLine());
      return;
    }
    throw emitError("a jump leaves for a block no loop around it names", terminator.target);
  }

  /* ---------------------------------------------------------------------- */
  /* Values                                                                  */
  /* ---------------------------------------------------------------------- */

  private condition(value: SemanticValue): string {
    return this.target.condition(this.expression(value), valueKind(value));
  }

  private call(call: SemanticCall): string {
    const argumentsText = call.args.map((argument, index) => {
      const type = call.argTypes[index] ?? argument.type;
      return this.target.argument(type, this.expression(argument, type));
    });
    return call.builtin ? this.target.builtin(call, argumentsText) : this.target.call(call, argumentsText);
  }

  private expression(value: SemanticValue, as: SemanticType | null = null): string {
    const text = this.raw(value, as);
    if (as === null) return text;
    // Only a number is written as another number: a reference and a string are
    // the one the value carries, and the resolver has already chosen the type
    // every use reads it as.
    if (!isNumber(value.type) || !isNumber(as)) return text;
    if (value.type.kind === "primitive" && as.kind === "primitive" && value.type.name === as.name) return text;
    return this.target.cast(as, text);
  }

  private raw(value: SemanticValue, as: SemanticType | null): string {
    switch (value.k) {
      case "const":
        // A constant the IR holds as text is a string written out; a number is
        // written as the literal of the type it initializes.
        return isTextType(value.type)
          ? this.target.stringLiteral(value.text)
          : this.target.literal(value.text, typeText(value.type));
      case "bool":
        return value.value ? "true" : "false";
      case "nothing":
        return this.target.nullLiteral();
      case "text":
        return this.text(value);
      case "local":
        return this.names.read(value.name);
      case "length":
        return this.length(value);
      case "element":
        return this.target.element(this.expression(value.of), this.expression(value.index, USIZE));
      case "buffer":
        // The resolver names every array it allocates and puts it in a
        // declaration, so an array read here is one it never wrote down.
        throw emitError("the emitter cannot write down an array that is not a declaration");
      case "newObject":
        // The fields are written where the object is built, so a literal in the
        // arm of a conditional is only built when that arm is taken.
        return this.target.buildObject(
          value.layout,
          value.fields.map((field) => ({ field: this.target.escape(field.name), value: this.expression(field.value) })),
        );
      case "call":
        return this.call(value.call);
      case "loadField":
        return this.target.field(this.expression(value.object), value.layout, this.target.escape(value.field));
      case "toText":
        // A string carried into a string is the string itself: a driver builds
        // text out of pointers, and a number is the one thing it converts.
        if (isTextType(value.of.type)) return this.expression(value.of);
        return this.target.toText(this.expression(value.of), value.of.type);
      case "argv":
        return value.index === null ? this.target.argvCount() : this.target.argv(this.expression(value.index));
      case "compare":
        return this.compare(value);
      case "isNull":
        return this.target.isNull(this.expression(value.operand), value.negate);
      case "unary":
        return this.unary(value);
      case "logical":
        return this.logical(value);
      case "coalesce":
        return this.coalesce(value);
      case "select":
        return this.target.conditional(
          this.condition(value.condition),
          this.expression(value.then, as),
          this.expression(value.otherwise, as),
        );
      case "arith":
        return this.arith(value);
    }
  }

  /** A string the program builds, one part after another. */
  private text(value: SemanticValue & { k: "text" }): string {
    if (value.parts.length === 0) return this.target.stringLiteral("");
    let text: string | null = null;
    for (const part of value.parts) {
      const piece = part.k === "text" ? this.target.stringLiteral(part.value) : this.expression(part.value);
      text = text === null ? piece : this.target.stringConcat(text, piece);
    }
    return text as string;
  }

  /**
   * The length of an array is the sidecar its allocation wrote next to it, and
   * the length of a string is counted by the runtime: the two are spelled the
   * way the target spells them, and only the target knows which is which.
   */
  private length(value: SemanticValue & { k: "length" }): string {
    if (isTextType(value.of.type)) return this.target.stringLength(this.expression(value.of));
    if (value.of.k !== "local") {
      throw emitError("the emitter cannot write down the length of an array", `${value.of.k} names no allocation`);
    }
    return `${this.names.read(value.of.name)}_length`;
  }

  private compare(value: SemanticValue & { k: "compare" }): string {
    if (isTextType(value.operand)) {
      const equal = this.target.stringEqual(this.expression(value.left), this.expression(value.right));
      return value.op === "ne" ? this.target.logicalNot(equal) : equal;
    }
    // The two sides are compared as one type, which the IR states: a whole
    // number and a literal are compared as whole numbers, not as two.
    const left = this.expression(value.left, value.operand);
    const right = this.expression(value.right, value.operand);
    return `${left} ${COMPARE_OPERATORS[value.op]} ${right}`;
  }

  private unary(value: SemanticValue & { k: "unary" }): string {
    if (value.op === "not") return this.target.logicalNot(this.condition(value.operand));
    if (value.op === "bitNot") return this.target.bitwiseNot(this.expression(value.operand, value.type));
    return `(${value.op === "neg" ? "-" : "+"}${this.expression(value.operand, value.type)})`;
  }

  private logical(value: SemanticValue & { k: "logical" }): string {
    const left = this.expression(value.left);
    const test = this.target.condition(left, valueKind(value.left));
    const right = this.expression(value.right, value.type);
    return value.op === "and"
      ? this.target.conditional(test, right, left)
      : this.target.conditional(test, left, right);
  }

  private coalesce(value: SemanticValue & { k: "coalesce" }): string {
    const left = this.expression(value.left);
    // Only a reference or a string can be nothing: a number never is. A name
    // resolves to a reference whatever it holds, so this asks what the value
    // carries: reading a number as a reference compiles the fallback arm away
    // and leaves a comparison that does not compile.
    const kind = valueKind(value.left);
    if (kind === "null" || kind === "text" || kind === "reference") {
      return this.target.conditional(this.target.isNull(left, false), this.expression(value.right, value.type), left);
    }
    return left;
  }

  private arith(value: SemanticValue & { k: "arith" }): string {
    switch (value.op) {
      case "concat":
        // A string is added to a string: the driver builds the text.
        return this.target.stringConcat(this.expression(value.left), this.expression(value.right));
      case "min":
        return this.target.min(this.expression(value.left, value.type), this.expression(value.right, value.type));
      case "max":
        return this.target.max(this.expression(value.left, value.type), this.expression(value.right, value.type));
      case "mod":
        return this.target.modulo(this.expression(value.left, value.type), this.expression(value.right, value.type));
      case "pow":
        // A power is floating point even over whole numbers, and Nim spells one
        // with the operator that xors two whole numbers.
        return this.target.power(this.expression(value.left, value.type), this.expression(value.right, value.type));
      case "add":
      case "sub":
      case "mul":
      case "div":
      case "shl":
      case "shr":
      // The bitwise operators are whole numbers masked whole, and the targets
      // already know how each of them is spelled.
      case "and":
      case "or":
      case "xor": {
        const left = this.expression(value.left, value.type);
        const right = this.expression(value.right, value.type);
        return `(${left} ${this.target.operator(ARITH_OPERATORS[value.op])} ${right})`;
      }
    }
  }
}

/** Emits the source of one program in the language a target speaks. */
export function generateProgramSource(program: SemanticProgram, target: ProgramTarget): string {
  return new ProgramEmitter(program, target).emit();
}

export type { ProgramBinaryOp, ProgramUnaryOp };

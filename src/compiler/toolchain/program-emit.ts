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
import type { FunctionSignature, TypeExpr } from "../core/types.ts";
import { contractText } from "../semantics/contract.ts";
import {
  elementTypeOf,
  isNumber,
  isSequence,
  isTextType,
  slotType,
  typeText,
  VOID,
  type SemanticFunction,
  isFloat,
  isUnsigned,
  valueKind,
  type CompareOp,
  type SemanticBlock,
  type SemanticCall,
  type SemanticLoop,
  type SemanticReduction,
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
const ARITH_OPERATORS: Record<
  "add" | "sub" | "mul" | "div" | "shl" | "shr" | "ushr" | "and" | "or" | "xor",
  ProgramBinaryOp
> = {
  add: "+",
  sub: "-",
  mul: "*",
  div: "/",
  shl: "<<",
  shr: ">>",
  ushr: ">>>",
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
  /**
   * The lines that open a function the program declares, its parameters
   * written as they are given, and the lines that close it, releasing what its
   * body allocated.
   */
  openFunction(signature: FunctionSignature, parameters: { name: string; type: string }[]): string[];
  closeFunction(releases: readonly string[], returned: boolean): string[];
  /** The line a function hands its result back with. */
  returnValue(value: string): string;
  /**
   * The line a block ends with a return that hands back nothing, which is what
   * a body that returns before it reaches the end of itself leaves.
   */
  returnNothing(): string;
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
  /**
   * A number read as a whole number of the given type. A NaN is no count at
   * all and reads as zero, which is what the language reads it as; a cast
   * alone would leave the machine's answer for a NaN there.
   *
   * The type is the one the read is made at, which is not always a full word:
   * `u32 >>> 1` truncates at thirty-two bits and a length at sixty-four, and
   * reading one as the other is a different number rather than a slower one.
   */
  asLength(expression: string, type: SemanticType): string;
  /** One number as a literal of the type it initializes. */
  literal(text: string, type: string): string;
  /** A line that declares a value; a value of no type is a string. */
  declare(name: string, type: SemanticType | null, value: string): string;
  /** The lines that allocate a buffer of a known length and write it out. */
  allocate(name: string, element: SemanticType, length: number, values: string[]): string[];
  /**
   * The lines that allocate a block of a count the program settled on when it
   * ran, and the lines that take a window of a block at a byte offset.
   */
  sized(name: string, element: SemanticType, count: string): string[];
  view(name: string, element: SemanticType, base: string, offset: string, count: string): string[];
  /** The lines that write one value into every element of an array. */
  fill(name: string, index: string, element: SemanticType, value: string): string[];
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

  /**
   * The truth of a value, as a condition reads it. The type is here as well as
   * the kind because a value holds or does not by what it is: a number that is
   * not a number is not a truth, and only the type says it is a float.
   */
  condition(expression: string, kind: ValueKind, type: SemanticType | null): string;
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
  /**
   * The directive that hands a loop to the host's threads, or nothing where the
   * host has none to hand it to.
   *
   * A loop marked parallel says its turns do not depend on each other, so a
   * target that returns nothing runs them in order — which is the same program,
   * because nothing about one turn reaches another. That is the whole of what
   * a target without threads owes the mark, and it is why the mark is in the IR
   * rather than a call the IR makes.
   *
   * The accumulators the turns combine come with it, because a target that does
   * hand the turns to threads has to be told how to combine them: a directive
   * that names no accumulator leaves every turn writing the one the turns share,
   * which is the race the reduction exists to answer.
   */
  parallelDirective(reductions: readonly SemanticReduction[]): string[];
  /** The line that leaves the innermost loop, and the one that starts it again. */
  breakLine(): string;
  continueLine(): string;
  /** One of two values, chosen by a condition. */
  conditional(condition: string, then: string, otherwise: string): string;
  /** A call kept for what it does, which may return nothing at all. */
  discard(expression: string, returnsNothing: boolean): string;

  /**
   * One printed value, read the way printing reads it. `bigint` is what the
   * language writes an `n` after, and it is a word rather than a type because
   * the value is the same whole number either way.
   */
  print(value: string, type: SemanticType | null, kind: ValueKind, bigint: boolean): string[];
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
  /**
   * Two strings in the order they read, as a number that is negative, zero or
   * positive. Equality is its own answer and is asked apart, because a
   * comparison that is not an equality is a question about the order.
   */
  stringCompare(left: string, right: string): string;
  /**
   * A value carried inside a string, as the runtime writes it, at the number
   * of digits the source asked for or as the language writes it where it asked
   * for none.
   */
  toText(expression: string, type: SemanticType, digits: number | null): string;
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
  /**
   * What the block being written hands back, which is the return type of the
   * function it is in and `void` for the body the program starts in. A return
   * inside the body is read at this width, the same one the return that ends
   * the body is read at.
   */
  private returns: SemanticType = VOID;
  private depth = 0;
  /** The names the program declared, and the names a target reads them by. */
  private names!: NameScope;

  constructor(program: SemanticProgram, target: ProgramTarget) {
    this.program = program;
    this.target = target;
    this.names = new NameScope((name) => target.escape(name));
  }

  emit(): string {
    // A function the program declares is a function of the program: it is
    // written above the body that runs, and the program calls it as it calls
    // any other function.
    const declared = this.program.bodies.map((fn) => this.function(fn));
    const body = this.entry();
    const opened = this.target.openProgram().map((line) => indent(1, line));
    const closed = this.target
      .closeProgram(this.program.entry.releases.map((name) => this.target.release(this.names.read(name))))
      .map((line) => indent(1, line));
    return [
      this.target.prelude(this.program),
      ...declared.flatMap((lines) => lines),
      ...opened,
      ...body,
      ...closed,
      ...this.target.epilogue(),
      "",
    ].join("\n");
  }

  /** One function the program declared, as the target writes a function. */
  private function(fn: SemanticFunction): string[] {
    this.names.enter();
    const parameters = fn.params.map((param) => {
      const type = slotType(param);
      return { name: this.names.declare(param.name, type), type: contractText(type) };
    });
    this.lines = [];
    this.depth = 1;
    this.returns = fn.returns;
    for (const statement of fn.entry.statements) this.statement(statement);
    // What a function hands back is written where the source returned it. A body
    // that falls off the end is the one case that needs a line for it, and the
    // line says what the closing brace would: a body that returns from every
    // path — its last block an `if` whose two arms each return — has written
    // every return it has, and a `return;` after them is a statement C refuses
    // in a function that returns something.
    const returned = fn.entry.terminator.k !== "next";
    this.terminator(fn.entry.terminator, null, true);
    const body = this.lines;
    this.lines = [];
    // What the body allocated is read by the names the body declared, so the
    // releases are written while the body is still the scope they are in.
    const releases = fn.entry.releases.map((name) => this.target.release(this.names.read(name)));
    this.names.leave();
    return [
      ...this.target.openFunction(
        {
          name: fn.name,
          symbol: fn.symbol,
          params: parameters.map((param) => ({ name: param.name, type: param.type })),
          returns: contractText(fn.returns),
        },
        parameters,
      ),
      ...body,
      ...this.target.closeFunction(releases, returned),
    ];
  }

  /* ---------------------------------------------------------------------- */
  /* Lines                                                                   */
  /* ---------------------------------------------------------------------- */

  private write(line: string): void {
    this.lines.push(indent(this.depth, line));
  }

  /** The statements of the block the run starts in, and where it ends. */
  private entry(): string[] {
    // The body the program starts in returns nothing, so a return inside it
    // leaves the run with nothing in its hands.
    this.depth = 1;
    this.returns = VOID;
    for (const statement of this.program.entry.statements) this.statement(statement);
    this.terminator(this.program.entry.terminator, null, true);
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
        for (const line of this.target.print(this.expression(statement.value), statement.value.type, valueKind(statement.value), false)) {
          this.write(line);
        }
        return;
      case "printNumber":
        for (const line of this.target.print(
          this.expression(statement.value),
          statement.value.type,
          valueKind(statement.value),
          statement.bigint,
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
      case "fill":
        for (const line of this.target.fill(
          this.names.read(statement.buffer),
          this.names.read(statement.index),
          statement.type,
          this.expression(statement.value, statement.type),
        )) {
          this.write(line);
        }
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
      // A block of a count the program settled on when it ran, a window of a
      // block it laid out, and the values it wrote out are the three ways a
      // program gets an array, and all three are the declaration.
      if (value.view !== null) {
        for (const line of this.target.view(
          name,
          slot.element,
          this.expression(value.view.of),
          this.expression(value.view.offset, USIZE),
          this.expression(value.count as SemanticValue, USIZE),
        )) {
          this.write(line);
        }
        return;
      }
      if (value.count !== null) {
        for (const line of this.target.sized(name, slot.element, this.expression(value.count, USIZE))) {
          this.write(line);
        }
        return;
      }
      for (const line of this.target.allocate(
        name,
        slot.element,
        value.length ?? 0,
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
    // What a counted loop counts from, over and by is read here, in the scope
    // the loop was entered in, and not in the loop's own: a loop that counts
    // from a value of its own variable's name writes
    // `for (double limit_2 = limit_2; ...)`, and the initializer names the
    // loop's own index rather than the one around it.
    const buffer = loop.kind === "each" ? this.names.read(loop.of) : null;
    const length = loop.kind === "each" ? this.expression(loop.length) : null;
    const counted =
      loop.kind === "counted"
        ? {
            type: loop.type,
            from: this.expression(loop.from, loop.type),
            to: this.expression(loop.to, loop.type),
            step: loop.step === null ? null : this.expression(loop.step, loop.type),
          }
        : null;
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
        const reductions = this.combined(loop);
        if (loop.parallel === true) for (const line of this.target.parallelDirective(reductions)) this.write(line);
        const bounds = counted as { type: SemanticType; from: string; to: string; step: string | null };
        for (const line of this.target.openFor(
          this.names.read(loop.variable),
          bounds.type,
          bounds.from,
          bounds.to,
          loop.inclusive,
          loop.down,
          bounds.step,
        )) {
          this.write(line);
        }
        this.body(loop.body, loop);
        break;
      }
      case "each": {
        const reductions = this.combined(loop);
        if (loop.parallel === true) for (const line of this.target.parallelDirective(reductions)) this.write(line);
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

  /**
   * The accumulators a loop's turns combine, with each name read as the scope
   * this loop is written in holds it.
   *
   * The name in the IR is the program's own; what a directive has to name is
   * the local this emitter gave it, which is a different name wherever the
   * program renamed one to keep a turn's copies apart.
   */
  private combined(loop: Extract<SemanticLoop, { kind: "counted" | "each" }>): SemanticReduction[] {
    return (loop.reductions ?? []).map((reduction) => ({ ...reduction, name: this.names.read(reduction.name) }));
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
   * Where control goes when a block is done.
   *
   * A return is written here and not only where the body of a function ends: a
   * block nested in the body can end in one, which is a block that answers
   * before the statements after it run. It hands back what the function returns,
   * read at the width the function returns it at, so an answer written in a
   * whole number is read as the number the caller is waiting for.
   *
   * A jump names the block it leaves, which is either the header of the loop it
   * is in — the run goes on from the top of it — or the block the loop sits in,
   * which the run carries on from.
   */
  private terminator(terminator: SemanticTerminator, loop: SemanticLoop | null, final = false): void {
    if (terminator.k === "return") {
      // A body that returns nothing ends at its closing line, so a return there
      // would say what the closing line already says.
      if (final && terminator.value === null) return;
      this.write(
        terminator.value === null
          ? this.target.returnNothing()
          : this.target.returnValue(this.expression(terminator.value, this.returns)),
      );
      return;
    }
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
    return this.target.condition(this.expression(value), valueKind(value), value.type);
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
    // A number read as a length or an index is read the way the language reads
    // one: a NaN is no length at all, and it is zero. A cast would leave
    // whatever the machine made of the value there instead, which for a NaN is
    // the largest size there is, and an allocation of that ends the run.
    if (isFloat(value.type) && isUnsigned(as)) return this.target.asLength(text, as);
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
        return this.target.toText(this.expression(value.of), value.of.type, value.digits);
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
      const left = this.expression(value.left);
      const right = this.expression(value.right);
      // Two strings are ordered by what they say. Every operator but `eq` and
      // `ne` used to be answered with the equality test, so `"apple" <
      // "banana"` was reported as false — the two are not the same text, which
      // says nothing about which one comes first.
      if (value.op === "eq" || value.op === "ne") {
        const equal = this.target.stringEqual(left, right);
        return value.op === "ne" ? this.target.logicalNot(equal) : equal;
      }
      return `${this.target.stringCompare(left, right)} ${COMPARE_OPERATORS[value.op]} 0`;
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
    const test = this.target.condition(left, valueKind(value.left), value.left.type);
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
      case "ushr":
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

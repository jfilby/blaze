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
import { contractText, parseType } from "../semantics/contract.ts";
import { rulesFor, type TextStyle } from "../semantics/language.ts";
import { RUNTIME_NAME } from "../runtime/abi.ts";
import { isWideType } from "../core/semantic-ir.ts";

function fieldOf(value: unknown, key: string): any {
  return (value as Record<string, unknown>)[key];
}
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
  walkValues,
} from "../core/semantic-ir.ts";

/** Whether a value of this type is a reference to an object the program laid out. */
function isReferenced(type: SemanticType): boolean {
  return type.kind === "ref" && type.name !== undefined;
}

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

/** Whether a type is a value the runtime holds rather than a number or a string. */
function fromDynamicType(type: SemanticType): boolean {
  return type.kind === "ref" && type.of === null && type.name === undefined;
}

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
  /**
   * The lines that name a list a call answered: the block the call handed back
   * and the length its header carries.
   */
  sequence(name: string, element: SemanticType, pointer: string): string[];
  /**
   * The count of elements in the block a value names, read from the header the
   * runtime laid in front of it. A list held in a field or answered by a call
   * has no sidecar count beside a name, so this is what its length is.
   */
  sequenceLength(pointer: string, element: SemanticType): string;
  /** One element of a buffer. */
  element(buffer: string, index: string): string;
  /** The line that changes what a name holds. */
  assign(name: string, operator: string, value: string, type: SemanticType | null): string;
  /** An operation over a wide number, which is a call into the shared kernel. */
  wideBinary(op: string, left: string, right: string, as: SemanticType): string;
  /** A wide multiplication reduced modulo a wide modulus. */
  wideMulMod(left: string, right: string, modulus: string, as: SemanticType): string;
  /** A wide addition reduced modulo a wide modulus. */
  wideAddMod(left: string, right: string, modulus: string, as: SemanticType): string;
  /** A wide subtraction reduced modulo a wide modulus. */
  wideSubMod(left: string, right: string, modulus: string, as: SemanticType): string;
  /** A whole number widened into a wide number, which is not a cast. */
  widen(value: string, as: SemanticType): string;
  /** A comparison over two wide numbers, which is a call into the shared kernel. */
  wideCompare(op: string, left: string, right: string, as: SemanticType): string;
  /** A complement or a negation of a wide number, which is the kernel's too. */
  wideUnary(op: string, operand: string, as: SemanticType): string;
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
  print(
    value: string,
    type: SemanticType | null,
    kind: ValueKind,
    bigint: boolean,
    style: TextStyle,
  ): string[];
  /** The newline that ends a line of output. */
  newline(): string;
  /** A call of a function the program compiled, and one the compiler provides. */
  call(call: SemanticCall, argumentsText: string[]): string;
  builtin(
    call: SemanticCall,
    argumentsText: string[],
    // The line the emitter writes any value of the call by, which a builtin
    // whose own arguments are values the target reads as text asks for.
    expression: (value: SemanticValue, as?: SemanticType | null) => string,
  ): string;
  /** One argument of a call, placed in the type its parameter takes. */
  argument(type: SemanticType, expression: string): string;
  /**
   * A reference held at a layout, in the dynamic handle the ABI carries every
   * value in. A parameter the source wrote no type for is a dynamic value, and
   * the pointer a reference is does not turn into one by itself.
   */
  handle(expression: string): string;
  /** The dynamic handle read back as the reference its layout names. */
  shaped(type: SemanticType, expression: string): string;
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
  /**
   * A value written as text, which is the way the language writes it: a number
   * at its shortest decimal, a boolean and a null as the words the language
   * has for them.
   */
  toText(expression: string, type: SemanticType, digits: number | null, style: TextStyle, precision?: boolean): string;
  /** The line that tests a value against nothing. */
  isNull(value: string, negate: boolean): string;
  /** The text of a value that is nothing. */
  nullLiteral(): string;
  /** The remainder of a division, as C truncates it. */
  modulo(left: string, right: string): string;
  /**
   * A division whose answer is moved down one when the remainder is not zero
   * and the two sides have different signs, which is what a floor division is.
   */
  floorDivide(left: string, right: string, type: SemanticType): string;
  /**
   * A remainder that takes the sign of its divisor rather than the sign of its
   * left side, which is what a floored remainder is.
   */
  floorModulo(left: string, right: string, type: SemanticType): string;
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
  return new CompilerError("SemanticIrError", "emit", message, detail, "", "", "");
}

/** One line at a depth of a block. */
function indent(depth: number, line: string): string {
  return line === "" ? "" : `${"  ".repeat(depth)}${line}`;
}

const USIZE: TypeExpr = { kind: "primitive", name: "usize" };

class ProgramEmitter {
  readonly target: ProgramTarget;
  readonly program: SemanticProgram;
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
  /** When emitting inside a `mod(X, c)` call, the modulus expression `c`, so
     wide arithmetic inside `X` uses modular operations. */
  private modCtx: string | null = null;
  /** When emitting the body of the `invert` function, the modulus expression
     of its second parameter, so every wide operation inside it uses modular
     arithmetic. Needed because the extended Euclidean algorithm updates
     mutable accumulators in a cycle that the backward data-flow analysis
     cannot follow. */
  private invertModulo: string | null = null;
  /** Data-flow result: wide `arith` values (mul/add/sub) whose result is
     always reduced modulo some modulus, mapped to that modulus expression.
     Computed by a backward pass from every `mod(..., c)` call. */
  private modulusForArith = new WeakMap<SemanticValue, string>();
  private buildCounter = 0;
  /** The names of mutable text locals stored in a shared cell (boxed). */
  private readonly boxedTexts: Set<string> = new Set();
  /**
   * The symbols of the bodies the emitter does not write down: they were
   * lowered by the machine backend into objects the driver links beside
   * itself, and what this file writes of them is the declaration a call
   * needs.
   */
  readonly loweredElsewhere: ReadonlySet<string>;
  /** The names the program declared, and the names a target reads them by. */
  names!: NameScope;

  constructor(program: SemanticProgram, target: ProgramTarget, loweredElsewhere: ReadonlySet<string> = new Set()) {
    this.program = program;
    this.target = target;
    this.loweredElsewhere = loweredElsewhere;
    this.names = new NameScope((name) => target.escape(name));
  }

  emit(): string {
    // The prelude is written first, so a target knows what the program holds
    // before the bodies are written out: the driver writes the functions the
    // program declares for itself as functions of its own file, and it can
    // only say which those are once it has seen the program.
    const target = fieldOf(this, "target") as ProgramTarget;
    const program = fieldOf(this, "program") as SemanticProgram;
    const lowered = fieldOf(this, "loweredElsewhere") as ReadonlySet<string>;
    const prelude = (fieldOf(target, "prelude") as (program: SemanticProgram) => string)(program);
    // A function the program declares is a function of the program: it is
    // written above the body that runs, and the program calls it as it calls
    // any other function — unless the machine backend lowered it into an
    // object the driver links beside itself, in which case what stands here is
    // the declaration the prelude wrote and nothing else.
    const declared: string[][] = [];
    for (const fn of fieldOf(program, "bodies") as readonly SemanticFunction[]) {
      if (lowered.has(String(fieldOf(fn, "symbol")))) continue;
      declared[declared.length] = this.function(fn);
    }
    const extra: string[][] = [];
    for (const extraFn of (fieldOf(program, "extraFunctions") as readonly { readonly body: string | SemanticFunction }[] | undefined) ?? []) {
      const body = fieldOf(extraFn, "body");
      if (typeof body === "string") extra[extra.length] = body.split("\n");
      else extra[extra.length] = this.function(body as SemanticFunction);
    }
    // Forward declarations so every function can call every other function
    // (and every trampoline) regardless of definition order. Without these a
    // function body that calls a trampoline defined later in the file is an
    // implicit declaration, which modern C treats as an error.
    const prototypes: string[] = [];
    const collectPrototypes = (units: string[][]) => {
      for (const lines of units) {
        // The first line that opens a block is the definition: a unit may
        // declare what it holds above it, and those lines are not a
        // definition of anything.
        const first = lines.find((line) => line.indexOf("{") >= 0);
        if (first === undefined) continue;
        const brace = first.indexOf("{");
        prototypes.push(first.slice(0, brace).trimEnd() + ";");
      }
    };
    collectPrototypes(declared);
    collectPrototypes(extra);
    const body = this.entry();
    // The style a value is written as text in is a state of the runtime, and
    // it is set once, when the program starts: the way the language writes a
    // number is the language's, and every place the runtime writes a value as
    // text writes it in the style that is set.
    const style = fieldOf(rulesFor(String(fieldOf(program, "language"))), "style");
    const opened: string[] = [];
    for (const line of (this.target.openProgram as unknown as (value: unknown) => string[])(undefined)) opened[opened.length] = indent(1, line);
    opened[opened.length] = indent(1, `${RUNTIME_NAME}_set_text_style(${String(style) === "python" ? 1 : 0});`);
    const releaseNames: string[] = [];
    for (const name of fieldOf(fieldOf(program, "entry"), "releases") as readonly string[]) {
      releaseNames[releaseNames.length] = (fieldOf(this.target, "release") as (...args: any[]) => any)(this.names.read(name));
    }
    const closed: string[] = [];
    for (const line of (fieldOf(this.target, "closeProgram") as (...args: any[]) => any)(releaseNames)) closed[closed.length] = indent(1, line);
    const epilogue = (this.target.epilogue as unknown as (value: unknown) => string[])(undefined);
    return [
      prelude,
      ...prototypes,
      ...declared.flatMap((lines) => lines),
      ...extra.flatMap((lines) => lines),
      ...opened,
      ...body,
      ...closed,
      ...epilogue,
      "",
    ].join("\n");
  }

  /** The style a value is written as text in, which is the language's. */
  private style(): TextStyle {
    return fieldOf(rulesFor(String(fieldOf(fieldOf(this, "program"), "language"))), "style") as TextStyle;
  }

  /** One function the program declared, as the target writes a function. */
  private function(fn: SemanticFunction): string[] {
    this.names.enter();
    const parameters: { name: string; type: string }[] = [];
    for (const param of fieldOf(fn, "params") as readonly SemanticSlot[]) {
      const type = slotType(param);
      const paramName = String(fieldOf(param, "name"));
      const emitted = this.names.declare(paramName, type);
      const boxed = /^text$/.test(String(fieldOf(param, "kind"))) && fieldOf(param, "boxed") === true;
      if (boxed) this.boxedTexts.add(paramName);
      parameters.push({ name: emitted, type: boxed ? "boxedtext" : contractText(type) });
      // An array parameter carries its length beside it, which the body reads
      // under the parameter's own name and `_length`. The call writes that
      // length as the argument that follows the pointer, so the definition has
      // to take it too: a definition that took only the pointer is one the call
      // it is written with does not match.
      if (!boxed && (type.kind === "slice" || type.kind === "array" || type.kind === "ptr")) {
        parameters.push({ name: `${emitted}_length`, type: "usize" });
      }
    }
    this.lines = [];
    this.depth = 1;
    this.returns = fieldOf(fn, "returns") as SemanticType;
    // The `invert` function's extended Euclidean algorithm updates mutable
    // accumulators in a cycle the backward data-flow analysis cannot follow,
    // so every wide operation inside it must use modular arithmetic with the
    // modulo parameter.
    this.invertModulo = String(fieldOf(fn, "name")) === "invert" && parameters.length > 1 ? parameters[1].name : null;
    this.computeModContexts(fn);
    const entry = fieldOf(fn, "entry") as SemanticBlock;
    for (const statement of fieldOf(entry, "statements") as readonly SemanticStatement[]) this.statement(statement);
    // What a function hands back is written where the source returned it. A body
    // that falls off the end is the one case that needs a line for it, and the
    // line says what the closing brace would: a body that returns from every
    // path — its last block an `if` whose two arms each return — has written
    // every return it has, and a `return;` after them is a statement C refuses
    // in a function that returns something.
    const terminator = fieldOf(entry, "terminator") as SemanticTerminator;
    const returned = String(fieldOf(terminator, "k")) !== "next";
    this.terminator(terminator, null, true);
    const body = this.lines;
    this.lines = [];
    // What the body allocated is read by the names the body declared, so the
    // releases are written while the body is still the scope they are in.
    const releases: string[] = [];
    for (const name of fieldOf(entry, "releases") as readonly string[]) releases[releases.length] = (fieldOf(this.target, "release") as (...args: any[]) => any)(this.names.read(name));
    this.names.leave();
    const outputs: string[] = [];
    for (const line of (fieldOf(this.target, "openFunction") as (...args: any[]) => any)(
      {
        name: String(fieldOf(fn, "name")),
        symbol: String(fieldOf(fn, "symbol")),
        params: parameters,
        returns: contractText(fieldOf(fn, "returns") as SemanticType),
      },
      parameters,
    )) outputs[outputs.length] = line;
    for (const line of body) outputs[outputs.length] = line;
    for (const line of (fieldOf(this.target, "closeFunction") as (...args: any[]) => any)(releases, returned)) outputs[outputs.length] = line;
    return outputs;
  }

  /* ---------------------------------------------------------------------- */
  /* Data-flow analysis: modular arithmetic contexts                        */
  /* ---------------------------------------------------------------------- */

  /**
   * Before emitting a function, find every `mod(X, c)` call and mark every
   * wide `arith` value (mul/add/sub) in X's transitive dependency closure as
   * needing modular arithmetic with modulus c. This catches values like
   * `invZ2 = invZ0 * invZ0` that are defined outside a `mod(...)` call but
   * whose result is always reduced modulo the curve prime.
   */
  private computeModContexts(fn: SemanticFunction): void {
    this.modulusForArith = new WeakMap<SemanticValue, string>();

    // Collect every `let` definition: local name -> defining value, walking
    // all blocks reachable from the entry block (if arms, loop bodies, etc.).
    const defByName = new Map<string, SemanticValue>();
    this.collectDefinitions(fn.entry, defByName);

    // Find every `mod(a, c)` call and annotate the arithmetic values that
    // feed into `a` with modulus `c`.
    const worklist: { value: SemanticValue; modulus: string }[] = [];
    this.findModCalls(fn.entry, worklist);

    while (worklist.length > 0) {
      const { value, modulus } = worklist.pop()!;
      this.annotateArithWithModulus(value, modulus, defByName);
    }
  }

  /** Walk every block reachable from `block`, collecting `let` definitions. */
  private collectDefinitions(block: SemanticBlock, defByName: Map<string, SemanticValue>): void {
    for (const stmt of fieldOf(block, "statements") as readonly SemanticStatement[]) {
      if (stmt.k === "let") {
        defByName.set(String(fieldOf(fieldOf(stmt, "slot"), "name")), fieldOf(stmt, "value") as SemanticValue);
      } else if (stmt.k === "if") {
        this.collectDefinitions(fieldOf(stmt, "then") as SemanticBlock, defByName);
        const otherwise = fieldOf(stmt, "otherwise") as SemanticBlock | null;
        if (otherwise !== null) this.collectDefinitions(otherwise, defByName);
      } else if (stmt.k === "loop") {
        this.collectDefinitions(fieldOf(fieldOf(stmt, "loop"), "body") as SemanticBlock, defByName);
      } else if (stmt.k === "block") {
        this.collectDefinitions(fieldOf(stmt, "body") as SemanticBlock, defByName);
      }
    }
  }

  /** Find every `mod(a, c)` call and push `(a, c)` onto the worklist. */
  private findModCalls(
    block: SemanticBlock,
    worklist: { value: SemanticValue; modulus: string }[],
  ): void {
    // Collect every value tree in this block: from statement values and the terminator.
    const values: SemanticValue[] = [];
    for (const stmt of fieldOf(block, "statements") as readonly SemanticStatement[]) {
      this.collectValues(stmt, values);
    }
    this.collectValues(fieldOf(block, "terminator"), values);
    // Walk every value tree for nested `mod(...)` calls.
    for (const value of values) {
      walkValues(value, (v) => {
        if (v.k === "call") {
          const call = fieldOf(v, "call") as SemanticCall;
          const args = fieldOf(call, "args") as readonly SemanticValue[];
          if (fieldOf(call, "builtin") !== true && String(fieldOf(call, "callee")) === "mod" && args.length === 2) {
            const modulus = this.expression(args[1], fieldOf(args[1], "type") as SemanticType);
            worklist.push({ value: args[0], modulus });
          }
        }
      });
    }
    // Recurse into nested blocks.
    for (const stmt of fieldOf(block, "statements") as readonly SemanticStatement[]) {
      if (stmt.k === "if") {
        this.findModCalls(fieldOf(stmt, "then") as SemanticBlock, worklist);
        const otherwise = fieldOf(stmt, "otherwise") as SemanticBlock | null;
        if (otherwise !== null) this.findModCalls(otherwise, worklist);
      } else if (stmt.k === "loop") {
        this.findModCalls(fieldOf(fieldOf(stmt, "loop"), "body") as SemanticBlock, worklist);
      } else if (stmt.k === "block") {
        this.findModCalls(fieldOf(stmt, "body") as SemanticBlock, worklist);
      }
    }
  }

  /** Collect every SemanticValue tree referenced by a statement or terminator. */
  private collectValues(node: unknown, into: SemanticValue[]): void {
    if (node === null || node === undefined) return;
    const n = node as Record<string, unknown>;
    const kind = String(n["k"] ?? "");
    // A statement with a `value` field.
    const value = n["value"];
    if (typeof value === "object" && value !== null && "k" in value) into.push(value as SemanticValue);
    // A call statement: its args are values.
    const call = n["call"];
    if (kind === "call" && typeof call === "object" && call !== null) {
      const args = (call as Record<string, unknown>)["args"];
      if (Array.isArray(args)) for (const arg of args as SemanticValue[]) into.push(arg);
    }
    // An `if` statement: its condition.
    const condition = n["condition"];
    if (kind === "if" && typeof condition === "object" && condition !== null && "k" in condition) into.push(condition as SemanticValue);
    // A `loop` statement: the loop's condition and from/to/step values.
    const loop = n["loop"];
    if (kind === "loop" && typeof loop === "object" && loop !== null) {
      const loopRecord = loop as Record<string, unknown>;
      const loopCondition = loopRecord["condition"];
      if (typeof loopCondition === "object" && loopCondition !== null && "k" in loopCondition) into.push(loopCondition as SemanticValue);
      if (String(loopRecord["kind"] ?? "") === "counted") {
        for (const key of ["from", "to", "step"]) {
          const val = loopRecord[key];
          if (val !== null && typeof val === "object" && "k" in val) into.push(val as SemanticValue);
        }
      }
    }
  }

  /**
   * Annotate every wide `arith` (mul/add/sub) value in `value`'s transitive
   * dependency closure with `modulus`. When a `local` reference is found, its
   * definition is looked up and annotated too, recursively.
   */
  private annotateArithWithModulus(
    value: SemanticValue,
    modulus: string,
    defByName: Map<string, SemanticValue>,
  ): void {
    const visited = new Set<SemanticValue>();
    const stack: SemanticValue[] = [value];

    while (stack.length > 0) {
      const v = stack.pop() as SemanticValue;
      if (visited.has(v)) continue;
      visited.add(v);

      // Annotate wide mul/add/sub arith values.
      if (
        v.k === "arith" &&
        isWideType(fieldOf(v, "type") as SemanticType) &&
        (String(fieldOf(v, "op")) === "mul" || String(fieldOf(v, "op")) === "add" || String(fieldOf(v, "op")) === "sub")
      ) {
        if (!this.modulusForArith.has(v)) {
          this.modulusForArith.set(v, modulus);
        }
      }

      // Trace local references to their definitions.
      if (v.k === "local") {
        const def = defByName.get(String(fieldOf(v, "name")));
        if (def !== undefined) stack.push(def);
        continue;
      }

      // Push children for further walking.
      walkValues(v, (child) => {
        if (child !== v) stack.push(child);
      });
    }
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
    const e = fieldOf(fieldOf(this, "program"), "entry") as SemanticBlock;
    for (const statement of fieldOf(e, "statements") as readonly SemanticStatement[]) this.statement(statement);
    this.terminator(fieldOf(e, "terminator") as SemanticTerminator, null, true);
    return this.lines;
  }

  /* ---------------------------------------------------------------------- */
  /* Statements                                                              */
  /* ---------------------------------------------------------------------- */

  private statement(statement: SemanticStatement): void {
    switch (statement.k) {
      case "let":
        this.declaration(fieldOf(statement, "slot") as SemanticSlot, fieldOf(statement, "value") as SemanticValue);
        return;
      case "set": {
        const name = String(fieldOf(statement, "name"));
        const value = fieldOf(statement, "value") as SemanticValue;
        const type = this.names.typeOf(name, fieldOf(value, "type") as SemanticType);
        const targetName = this.boxedTexts.has(name) ? `*${this.names.read(name)}` : this.names.read(name);
        this.write(
          (fieldOf(this.target, "assign") as (...args: any[]) => any)(targetName, String(fieldOf(statement, "op")), this.expression(value, type), type),
        );
        return;
      }
      case "setElement": {
        const bufferName = String(fieldOf(statement, "buffer"));
        const buffer = this.names.declared(bufferName);
        let element: SemanticType | null = null;
        if (buffer !== undefined) {
          const bufferType = fieldOf(buffer, "type") as SemanticType | null | undefined;
          if (bufferType !== null && bufferType !== undefined) element = elementTypeOf(bufferType);
        }
        const value = fieldOf(statement, "value") as SemanticValue;
        this.write(
          (fieldOf(this.target, "elementAssign") as (...args: any[]) => any)(
            this.names.read(bufferName),
            this.expression(fieldOf(statement, "index") as SemanticValue, USIZE),
            String(fieldOf(statement, "op")),
            this.expression(value, element ?? fieldOf(value, "type") as SemanticType),
          ),
        );
        return;
      }
      case "step":
        this.write((fieldOf(this.target, "update") as (...args: any[]) => any)(this.names.read(String(fieldOf(statement, "name"))), String(fieldOf(statement, "op")), fieldOf(statement, "prefix") === true));
        return;
      case "printText": {
        const value = fieldOf(statement, "value") as SemanticValue;
        for (const line of (this.target.print as unknown as (...args: unknown[]) => string[])(
          this.expression(value, fieldOf(value, "type") as SemanticType),
          fieldOf(value, "type") as SemanticType,
          valueKind(value),
          false,
          this.style(),
          undefined,
        )) {
          this.write(line);
        }
        return;
      }
      case "printNumber": {
        const value = fieldOf(statement, "value") as SemanticValue;
        for (const line of (this.target.print as unknown as (...args: unknown[]) => string[])(
          this.expression(value, fieldOf(value, "type") as SemanticType),
          fieldOf(value, "type") as SemanticType,
          valueKind(value),
          fieldOf(statement, "bigint") === true,
          this.style(),
          undefined,
        )) {
          this.write(line);
        }
        return;
      }
      case "printNewline":
        this.write((fieldOf(this.target, "newline") as (value: unknown) => string)(undefined));
        return;
      case "call": {
        const call = fieldOf(statement, "call") as SemanticCall;
        const grid = fieldOf(call, "grid") as SemanticValue | undefined;
        if (grid !== undefined) {
          const gridExpr = this.expression(grid, fieldOf(grid, "type") as SemanticType);
          this.write(`for (double blaze_grid_i = 0.0; blaze_grid_i < ${gridExpr}; blaze_grid_i += 1.0) {`);
          this.write("  blaze_triton_block_index = blaze_grid_i;");
          this.write("  " + String((fieldOf(this.target, "discard") as (...args: any[]) => any)(this.call(call), String(fieldOf(fieldOf(call, "returns"), "kind")) === "void")) + ";");
          this.write("}");
          return;
        }
        this.write(String((fieldOf(this.target, "discard") as (...args: any[]) => any)(this.call(call), String(fieldOf(fieldOf(call, "returns"), "kind")) === "void")));
        return;
      }
      case "if":
        this.write((fieldOf(this.target, "openIf") as (...args: any[]) => any)(this.condition(fieldOf(statement, "condition") as SemanticValue)));
        this.body(fieldOf(statement, "then") as SemanticBlock, null);
        if (fieldOf(statement, "otherwise") !== null) {
          this.write((fieldOf(this.target, "closeBody") as (value: unknown) => string | null)(undefined) ?? "");
          this.write((fieldOf(this.target, "openElse") as (value: unknown) => string)(undefined));
          this.body(fieldOf(statement, "otherwise") as SemanticBlock, null);
        }
        this.write((fieldOf(this.target, "closeBody") as (value: unknown) => string | null)(undefined) ?? "");
        return;
      case "loop":
        this.loop(fieldOf(statement, "loop") as SemanticLoop);
        return;
      case "block":
        this.write((fieldOf(this.target, "openBlock") as (value: unknown) => string | null)(undefined) ?? "");
        this.body(fieldOf(statement, "body") as SemanticBlock, null);
        this.write((fieldOf(this.target, "closeBody") as (value: unknown) => string | null)(undefined) ?? "");
        return;
      case "fill": {
        const type = fieldOf(statement, "type") as SemanticType;
        const value = fieldOf(statement, "value") as SemanticValue;
        for (const line of (fieldOf(this.target, "fill") as (...args: any[]) => any)(
          this.names.read(String(fieldOf(statement, "buffer"))),
          this.names.read(String(fieldOf(statement, "index"))),
          type,
          this.expression(value, type),
        )) {
          this.write(line);
        }
        return;
      }
      case "retain":
        this.write((fieldOf(this.target, "retain") as (...args: any[]) => any)(this.expression(fieldOf(statement, "value") as SemanticValue, fieldOf(fieldOf(statement, "value"), "type") as SemanticType)));
        return;
      case "raise":
        this.write((fieldOf(this.target, "raise") as (...args: any[]) => any)(this.expression(fieldOf(statement, "message") as SemanticValue, fieldOf(fieldOf(statement, "message"), "type") as SemanticType)));
        return;
      case "storeField":
        this.write(
          (fieldOf(this.target, "assignField") as (...args: any[]) => any)(
            this.expression(fieldOf(statement, "object") as SemanticValue, fieldOf(fieldOf(statement, "object"), "type") as SemanticType),
            String(fieldOf(statement, "layout")),
            (fieldOf(this.target, "escape") as (...args: any[]) => any)(String(fieldOf(statement, "field"))),
            this.expression(fieldOf(statement, "value") as SemanticValue, fieldOf(fieldOf(statement, "value"), "type") as SemanticType),
          ),
        );
        return;
    }
  }

  private declaration(slot: SemanticSlot, value: SemanticValue): void {
    const slotName = String(fieldOf(slot, "name"));
    const slotKind = String(fieldOf(slot, "kind"));
    const name = this.names.declare(slotName, slotType(slot));
    if (slotKind === "text" && fieldOf(slot, "boxed") === true) {
      this.boxedTexts.add(slotName);
      // A mutable text local captured by a nested program function is stored in a
      // shared cell, so writes inside the function update this binding.
      this.write(`char** ${name} = (char**)${RUNTIME_NAME}_allocate(sizeof(char*));`);
      this.write(`if (${name} == NULL) program_fail("out of memory");`);
      this.write(`*${name} = (char*)${this.expression(value, fieldOf(value, "type") as SemanticType)};`);
      return;
    }
    if (slotKind === "text") {
      this.write((fieldOf(this.target, "declare") as (...args: any[]) => any)(name, null, this.expression(value, fieldOf(value, "type") as SemanticType)));
      return;
    }
    if (slotKind === "buffer") {
      const element = fieldOf(slot, "element") as SemanticType;
      // A list a call answered: the block the call handed back, with the length
      // its header carries. A call states one pointer and no count, and a
      // module function lays its answer down at the bytes its header measures.
      if (value.k === "call" && isSequence(fieldOf(value, "type") as SemanticType)) {
        for (const line of (fieldOf(this.target, "sequence") as (...args: any[]) => any)(name, element, this.expression(value, fieldOf(value, "type") as SemanticType))) this.write(line);
        return;
      }
      // `const b = a` names the same array again, as the language means it.
      if (value.k === "local" && isSequence(fieldOf(value, "type") as SemanticType)) {
        const localName = String(fieldOf(value, "name"));
        for (const line of (fieldOf(this.target, "alias") as (...args: any[]) => any)(
          name,
          element,
          this.names.read(localName),
          `${this.names.read(localName)}_length`,
        )) {
          this.write(line);
        }
        return;
      }
      if (value.k !== "buffer") throw emitError(`the emitter cannot write down ${slotName} as an array`);
      // A block of a count the program settled on when it ran, a window of a
      // block it laid out, and the values it wrote out are the three ways a
      // program gets an array, and all three are the declaration.
      const view = fieldOf(value, "view") as { readonly of: SemanticValue; readonly offset: SemanticValue } | null;
      const count = fieldOf(value, "count") as SemanticValue | null;
      if (view !== null) {
        for (const line of (fieldOf(this.target, "view") as (...args: any[]) => any)(
          name,
          element,
          this.expression(fieldOf(view, "of") as SemanticValue, fieldOf(fieldOf(view, "of"), "type") as SemanticType),
          this.expression(fieldOf(view, "offset") as SemanticValue, USIZE),
          this.expression(count as SemanticValue, USIZE),
        )) {
          this.write(line);
        }
        return;
      }
      if (count !== null) {
        for (const line of (fieldOf(this.target, "sized") as (...args: any[]) => any)(name, element, this.expression(count, USIZE))) {
          this.write(line);
        }
        return;
      }
      const items = fieldOf(value, "values") as readonly SemanticValue[];
      const written: string[] = [];
      for (const one of items) written[written.length] = this.expression(one, element);
      const length = fieldOf(value, "length") as number | null;
      for (const line of (fieldOf(this.target, "allocate") as (...args: any[]) => any)(name, element, length ?? 0, written)) {
        this.write(line);
      }
      return;
    }
    this.write((fieldOf(this.target, "declare") as (...args: any[]) => any)(name, fieldOf(slot, "type") as SemanticType, this.expression(value, fieldOf(slot, "type") as SemanticType)));
  }

  private loop(loop: SemanticLoop): void {
    const header = String(fieldOf(loop, "header"));
    const exit = String(fieldOf(loop, "exit"));
    this.loops.push({ header, exit });
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
    const kind = String(fieldOf(loop, "kind"));
    const buffer = kind === "each" ? this.names.read(String(fieldOf(loop, "of"))) : null;
    const length = kind === "each" ? this.expression(fieldOf(loop, "length") as SemanticValue, fieldOf(fieldOf(loop, "length"), "type") as SemanticType) : null;
    const counted = kind === "counted"
        ? {
            type: fieldOf(loop, "type") as SemanticType,
            from: this.expression(fieldOf(loop, "from") as SemanticValue, fieldOf(loop, "type") as SemanticType),
            to: this.expression(fieldOf(loop, "to") as SemanticValue, fieldOf(loop, "type") as SemanticType),
            step: fieldOf(loop, "step") === null ? null : this.expression(fieldOf(loop, "step") as SemanticValue, fieldOf(loop, "type") as SemanticType),
          }
        : null;
    this.names.enter();
    if (kind === "counted") this.names.declare(String(fieldOf(loop, "variable")));
    if (kind === "each") {
      this.names.declare(String(fieldOf(loop, "index")));
      this.names.declare(String(fieldOf(loop, "element")));
    }
    // A `do` closes itself with its own condition, so it is the one loop the
    // walk does not close with a brace of its own.
    let closedByDo = false;
    if (kind === "while") {
      this.write((fieldOf(this.target, "openWhile") as (...args: any[]) => any)(this.condition(fieldOf(loop, "condition") as SemanticValue)));
      this.body(fieldOf(loop, "body") as SemanticBlock, loop);
    } else if (kind === "doWhile") {
      // The condition is asked for before the body, because a language
      // without a do-while tests it at the top of the loop.
      const condition = this.condition(fieldOf(loop, "condition") as SemanticValue);
      for (const line of (fieldOf(this.target, "openDo") as (...args: any[]) => any)(condition)) this.write(line);
      this.body(fieldOf(loop, "body") as SemanticBlock, loop);
      for (const line of (fieldOf(this.target, "closeDo") as (...args: any[]) => any)(condition)) this.write(line);
      closedByDo = true;
    } else if (kind === "counted") {
      const reductions = this.combined(loop as Extract<SemanticLoop, { kind: "counted" | "each" }>);
      if (fieldOf(loop, "parallel") === true) for (const line of (fieldOf(this.target, "parallelDirective") as (...args: any[]) => any)(reductions)) this.write(line);
      const bounds = counted as { type: SemanticType; from: string; to: string; step: string | null };
      for (const line of (fieldOf(this.target, "openFor") as (...args: any[]) => any)(
        this.names.read(String(fieldOf(loop, "variable"))),
        fieldOf(bounds, "type") as SemanticType,
        String(fieldOf(bounds, "from")),
        String(fieldOf(bounds, "to")),
        fieldOf(loop, "inclusive") === true,
        fieldOf(loop, "down") === true,
        fieldOf(bounds, "step") as string | null,
      )) {
        this.write(line);
      }
      this.body(fieldOf(loop, "body") as SemanticBlock, loop);
    } else {
      const reductions = this.combined(loop as Extract<SemanticLoop, { kind: "counted" | "each" }>);
      if (fieldOf(loop, "parallel") === true) for (const line of (fieldOf(this.target, "parallelDirective") as (...args: any[]) => any)(reductions)) this.write(line);
      for (const line of (fieldOf(this.target, "openForOf") as (...args: any[]) => any)(
        this.names.read(String(fieldOf(loop, "index"))),
        this.names.read(String(fieldOf(loop, "element"))),
        fieldOf(loop, "elementType") as SemanticType,
        buffer as string,
        length as string,
      )) {
        this.write(line);
      }
      this.body(fieldOf(loop, "body") as SemanticBlock, loop);
    }
    if (!closedByDo) this.write((fieldOf(this.target, "closeBody") as (value: unknown) => string | null)(undefined) ?? "");
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
    const reductions = (fieldOf(loop, "reductions") as readonly SemanticReduction[] | undefined) ?? [];
    const named: SemanticReduction[] = [];
    for (const reduction of reductions) {
      const name = this.names.read(String(fieldOf(reduction, "name")));
      named[named.length] = { name, op: String(fieldOf(reduction, "op")) as SemanticReduction["op"], exact: fieldOf(reduction, "exact") === true };
    }
    return named;
  }

  /** The statements of one block, and what is done when it ends. */
  private body(block: SemanticBlock, loop: SemanticLoop | null): void {
    this.names.enter();
    this.depth += 1;
    const statements = fieldOf(block, "statements") as readonly SemanticStatement[];
    const blockEnd = fieldOf(block, "terminator") as SemanticTerminator;
    if (statements.length === 0 && String(fieldOf(blockEnd, "k")) === "next") {
      const empty = (fieldOf(this.target, "emptyBody") as (...args: any[]) => any)(undefined);
      if (empty !== null) this.write(String(empty));
    }
    for (const statement of statements) this.statement(statement);
    // What the block allocated is freed before it ends, which is inside the
    // braces of one target and inside the indentation of the other. A block
    // that ends in a jump is not fallen out of, and the jump frees what the
    // blocks it leaves own instead — the jump's own releases already say which.
    const endKind = String(fieldOf(blockEnd, "k"));
    if (endKind === "next" || endKind === "return") {
      for (const name of fieldOf(block, "releases") as readonly string[]) this.lines.push(indent(this.depth, (fieldOf(this.target, "release") as (...args: any[]) => any)(this.names.read(name))));
    }
    this.terminator(blockEnd, loop);
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
    const k = String(fieldOf(terminator, "k"));
    if (k === "return") {
      const value = fieldOf(terminator, "value") as SemanticValue | null;
      // A body that returns nothing ends at its closing line, so a return there
      // would say what the closing line already says.
      if (final && value === null) return;
      this.write(
        value === null
          ? String((fieldOf(this.target, "returnNothing") as (...args: any[]) => any)(undefined))
          : String((fieldOf(this.target, "returnValue") as (...args: any[]) => any)(this.expression(value, this.returns))),
      );
      return;
    }
    if (k !== "jump") return;
    for (const name of fieldOf(terminator, "releases") as readonly string[]) this.write((fieldOf(this.target, "release") as (...args: any[]) => any)(this.names.read(name)));
    const open = loop ?? this.loops[this.loops.length - 1];
    const target = String(fieldOf(terminator, "target"));
    if (open === undefined) throw emitError("a jump out of a block no loop is written in", target);
    if (target === String(fieldOf(open, "header"))) {
      this.write((fieldOf(this.target, "continueLine") as (...args: any[]) => any)(undefined));
      return;
    }
    if (target === String(fieldOf(open, "exit"))) {
      this.write((fieldOf(this.target, "breakLine") as (...args: any[]) => any)(undefined));
      return;
    }
    throw emitError("a jump leaves for a block no loop around it names", target);
  }

  /* ---------------------------------------------------------------------- */
  /* Values                                                                  */
  /* ---------------------------------------------------------------------- */

  private condition(value: SemanticValue): string {
    return String((fieldOf(this.target, "condition") as (...args: any[]) => any)(this.expression(value, fieldOf(value, "type") as SemanticType), valueKind(value), fieldOf(value, "type") as SemanticType));
  }

  private call(call: SemanticCall): string {
    // `mod(X, c)` must reduce X modulo c. The data-flow analysis marks every
    // wide mul/add/sub in X's dependency chain as needing `*_mod` with modulus
    // c, so the `arith` emitter uses modular operations and the result is
    // already in [0, c). But `X` may be a plain local reference whose value was
    // computed with wrapping arithmetic and is not yet reduced (e.g. `return
    // mod(x, modulo)` in `invert`), so apply the kernel's mod in that case.
    const callee = String(fieldOf(call, "callee"));
    const args = fieldOf(call, "args") as readonly SemanticValue[];
    if (fieldOf(call, "builtin") !== true && callee === "mod" && args.length === 2) {
      const first = args[1];
      const modulus = this.expression(first, fieldOf(first, "type") as SemanticType);
      const savedCtx = this.modCtx;
      this.modCtx = modulus;
      const inner = args[0];
      const innerType = fieldOf(inner, "type") as SemanticType;
      let result: string;
      if (inner.k === "arith" && isWideType(innerType)) {
        // The arith emitter uses `*_mod` with modulus c, so the result is
        // already reduced; no extra mod needed.
        result = this.expression(inner, innerType);
      } else {
        // Bind the inner value to a temporary and reduce it modulo c.
        this.buildCounter += 1;
        const out = `blaze_wide_${this.buildCounter}`;
        const tmp = `blaze_wide_tmp_${this.buildCounter}`;
        result = `({ const blaze_u256 ${tmp} = (${this.expression(inner, innerType)}); blaze_u256 ${out}; ${RUNTIME_NAME}_u256_mod(&${out}, &${tmp}, &(${modulus})); ${out}; })`;
      }
      this.modCtx = savedCtx;
      return result;
    }
    const argumentsText: string[] = [];
    const signature = fieldOf(call, "signature") as FunctionSignature;
    const signatureParams = fieldOf(signature, "params") as readonly { readonly type: string }[];
    const argTypes = fieldOf(call, "argTypes") as readonly SemanticType[];
    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index];
      // The argument is placed in the type its parameter takes: a reference a
      // function answers is a pointer, and a parameter the source wrote no type
      // for takes the dynamic handle the ABI carries a value in.
      const writtenParameter = signatureParams[index] === undefined ? undefined : String(fieldOf(signatureParams[index], "type"));
      const parameterType = writtenParameter !== undefined && writtenParameter !== "text" && writtenParameter !== "boxedtext"
        ? parseType(writtenParameter)
        : null;
      const type = parameterType ?? argTypes[index] ?? fieldOf(argument, "type") as SemanticType;
      // A string a function writes through is shared through a cell, and the
      // cell is what the function is given: what is passed is the name of the
      // cell and not the text it holds, for the text in the cell is what the
      // function writes.
      if (writtenParameter === "boxedtext" && argument.k === "local") {
        argumentsText.push(this.names.read(String(fieldOf(argument, "name"))));
      } else {
        // A reference handed to a service the compiler provides is the double
        // the C ABI carries it in, whatever the lowering: the program driver is
        // C in both builds, and only a *function* the machine backend lowered
        // holds a reference in a register as the pointer it is.
        const text = this.expression(argument, type);
        const typeKind = String(fieldOf(type, "kind"));
        const dynamic = type !== null && typeKind === "ref" && fieldOf(type, "of") === null && fieldOf(type, "name") === undefined;
        const boxed = fieldOf(call, "builtin") === true && dynamic && isReferenced(fieldOf(argument, "type") as SemanticType)
          ? `((double)(uintptr_t)(${text}))`
          : String((fieldOf(this.target, "argument") as (...args: any[]) => any)(type, text));
        argumentsText.push(boxed);
      }
      // A callee's array parameter carries its length beside it, so pass the
      // length of this argument as the hidden parameter that follows it.
      // A text and the cell a captured text travels in are not sequences:
      // neither carries a length beside it, so neither is parsed as one.
      // A callee's array parameter carries its length beside it, and a module
      // function's does. A service the compiler itself provides takes the block
      // alone — a list the runtime moves is the bytes its header measures.
      const written = signatureParams[index] === undefined ? undefined : String(fieldOf(signatureParams[index], "type"));
      const paramType = written !== undefined && written !== "text" && written !== "boxedtext" ? parseType(written) : null;
      if (fieldOf(call, "builtin") !== true && paramType !== null && (paramType.kind === "slice" || paramType.kind === "array" || paramType.kind === "ptr")) {
        if (argument.k === "local") {
          argumentsText.push(`${this.names.read(String(fieldOf(argument, "name")))}_length`);
        } else if (argument.k === "buffer") {
          argumentsText.push(String((fieldOf(argument, "values") as readonly SemanticValue[]).length));
        } else {
          argumentsText.push("0");
        }
      }
    }
    const expression = (value: SemanticValue, as: SemanticType | null = null): string => this.expression(value, as);
    return fieldOf(call, "builtin") === true
      ? String((fieldOf(this.target, "builtin") as (...args: any[]) => any)(this.readCaptures(call), argumentsText, expression))
      : String((fieldOf(this.target, "call") as (...args: any[]) => any)(call, argumentsText));
  }

  /**
   * The call as the target reads it. A function reference carries the names of
   * the bindings it captured, and the target knows those bindings by names of
   * its own: a name the source wrote is a name the target renames when another
   * declaration holds it.
   */
  private readCaptures(call: SemanticCall): SemanticCall {
    let changed = false;
    const args: SemanticValue[] = [];
    for (const argument of fieldOf(call, "args") as readonly SemanticValue[]) {
      if (argument.k !== "functionRef") {
        args[args.length] = argument;
        continue;
      }
      const oldCaptures = fieldOf(argument, "captures") as readonly { readonly name: string; readonly type: SemanticType }[];
      const captures: { name: string; type: SemanticType }[] = [];
      let same = true;
      for (let index = 0; index < oldCaptures.length; index += 1) {
        const capture = oldCaptures[index];
        const name = this.names.read(String(fieldOf(capture, "name")));
        if (name !== String(fieldOf(oldCaptures[index], "name"))) same = false;
        captures[captures.length] = { name, type: fieldOf(capture, "type") as SemanticType };
      }
      if (same) {
        args[args.length] = argument;
        continue;
      }
      changed = true;
      args[args.length] = {
        k: "functionRef",
        type: fieldOf(argument, "type") as SemanticType,
        name: String(fieldOf(argument, "name")),
        captures,
      };
    }
    return changed ? {
      callee: String(fieldOf(call, "callee")),
      through: fieldOf(call, "through") as SemanticValue | undefined,
      signature: fieldOf(call, "signature") as FunctionSignature,
      args,
      argTypes: fieldOf(call, "argTypes") as SemanticType[],
      returns: fieldOf(call, "returns") as SemanticType,
      effects: fieldOf(call, "effects") as SemanticCall["effects"],
      ownership: fieldOf(call, "ownership") as SemanticCall["ownership"],
      retain: fieldOf(call, "retain") === true,
      builtin: fieldOf(call, "builtin") === true,
    } : call;
  }

  private expression(value: SemanticValue, as: SemanticType | null = null): string {
    const text = this.raw(value, as);
    if (as === null) return text;
    // A parameter the source wrote no type for takes the dynamic handle, and a
    // reference held at a layout is a pointer: the two are the same address
    // written two ways, and the conversion is the one the ABI makes.
    const asDynamic = as.kind === "ref" && fieldOf(as, "of") === null && fieldOf(as, "name") === undefined;
    const carried = fieldOf(value, "type") as SemanticType;
    const carriedDynamic = carried.kind === "ref" && fieldOf(carried, "of") === null && fieldOf(carried, "name") === undefined;
    if (asDynamic && !carriedDynamic && !isTextType(carried) && isReferenced(carried)) {
      return String((fieldOf(this.target, "handle") as (...args: any[]) => any)(text));
    }
    if (carriedDynamic && as.kind === "ref" && fieldOf(as, "name") !== undefined) {
      return String((fieldOf(this.target, "shaped") as (...args: any[]) => any)(as, text));
    }
    // Only a number is written as another number: a reference and a string are
    // the one the value carries, and the resolver has already chosen the type
    // every use reads it as.
    const fromDynamic = fromDynamicType(carried);
    if (fromDynamic && isNumber(as) && value.k !== "local") return `${RUNTIME_NAME}_to_number(${text})`;
    // A value the runtime holds is written as the string it is when it is
    // handed to a parameter of a string: the runtime renders it, and the
    // string it answers is the text the value holds.
    if (fromDynamic && isTextType(as)) return `${RUNTIME_NAME}_to_text(${text})`;
    // A string a use reads as a number is the number its text states: `+text`
    // is the spelling the language writes it by, and the runtime boxes the
    // pointer it carries and answers the number that text names.
    if (isTextType(carried) && isNumber(as)) {
      return `${RUNTIME_NAME}_to_number(${RUNTIME_NAME}_box_string(${text}))`;
    }
    if (!isNumber(carried) || !isNumber(as)) return text;
    if (carried.kind === "primitive" && as.kind === "primitive" && String(fieldOf(carried, "name")) === String(fieldOf(as, "name"))) return text;
    // A wide number is a struct, and a cast from a scalar to a struct is a
    // conversion to a non-scalar type, which is not a C source at all. The one
    // conversion there is to a wide number is the widening, and it is the
    // kernel's.
    if (isWideType(as)) return String((fieldOf(this.target, "widen") as (...args: any[]) => any)(text, as));
    // A number read as a length or an index is read the way the language reads
    // one: a NaN is no length at all, and it is zero. A cast would leave
    // whatever the machine made of the value there instead, which for a NaN is
    // the largest size there is, and an allocation of that ends the run.
    if (isFloat(carried) && isUnsigned(as)) return String((fieldOf(this.target, "asLength") as (...args: any[]) => any)(text, as));
    return String((fieldOf(this.target, "cast") as (...args: any[]) => any)(as, text));
  }

  private raw(value: SemanticValue, as: SemanticType | null): string {
    switch (value.k) {
      case "const": {
        // A constant the IR holds as text is a string written out; a number is
        // written as the literal of the type it initializes.
        const type = fieldOf(value, "type") as SemanticType;
        return isTextType(type)
          ? String((fieldOf(this.target, "stringLiteral") as (...args: any[]) => any)(String(fieldOf(value, "text"))))
          : String((fieldOf(this.target, "literal") as (...args: any[]) => any)(String(fieldOf(value, "text")), typeText(type)));
      }
      case "bool":
        return fieldOf(value, "value") === true ? "true" : "false";
      case "nothing":
        return String((fieldOf(this.target, "nullLiteral") as (...args: any[]) => any)(undefined));
      case "functionRef":
        return String(fieldOf(value, "name"));
      case "text":
        return this.text(value as SemanticValue & { k: "text" });
      case "local": {
        const name = String(fieldOf(value, "name"));
        if (this.boxedTexts.has(name)) return `*${this.names.read(name)}`;
        return this.names.read(name);
      }
      case "length":
        return this.length(value as SemanticValue & { k: "length" });
      case "element":
        return String((fieldOf(this.target, "element") as (...args: any[]) => any)(
          this.expression(fieldOf(value, "of") as SemanticValue, fieldOf(fieldOf(value, "of"), "type") as SemanticType),
          this.expression(fieldOf(value, "index") as SemanticValue, USIZE),
        ));
      case "buffer":
        // The resolver names every array it allocates and puts it in a
        // declaration, so an array read here is one it never wrote down.
        throw emitError("the emitter cannot write down an array that is not a declaration");
      case "newObject": {
        // The fields are written where the object is built, so a literal in the
        // arm of a conditional is only built when that arm is taken. Each field
        // is written as the type it was resolved to: a value written without a
        // type is written as the text it prints, which the layout's field is
        // whatever type the literal resolved to.
        const fields: { field: string; value: string }[] = [];
        for (const field of fieldOf(value, "fields") as readonly { readonly name: string; readonly value: SemanticValue }[]) {
          const held = fieldOf(field, "value") as SemanticValue;
          fields[fields.length] = {
            field: String((fieldOf(this.target, "escape") as (...args: any[]) => any)(String(fieldOf(field, "name")))),
            value: this.expression(held, fieldOf(held, "type") as SemanticType),
          };
        }
        return String((fieldOf(this.target, "buildObject") as (...args: any[]) => any)(String(fieldOf(value, "layout")), fields));
      }
      case "call":
        return this.call(fieldOf(value, "call") as SemanticCall);
      case "loadField":
        return String((fieldOf(this.target, "field") as (...args: any[]) => any)(
          this.expression(fieldOf(value, "object") as SemanticValue, fieldOf(fieldOf(value, "object"), "type") as SemanticType),
          String(fieldOf(value, "layout")),
          (fieldOf(this.target, "escape") as (...args: any[]) => any)(String(fieldOf(value, "field"))),
        ));
      case "toText": {
        const of = fieldOf(value, "of") as SemanticValue;
        const ofType = fieldOf(of, "type") as SemanticType;
        // A string carried into a string is the string itself: a driver builds
        // text out of pointers, and a number is the one thing it converts.
        if (isTextType(ofType)) return this.expression(of, ofType);
        return String((fieldOf(this.target, "toText") as (...args: any[]) => any)(
          this.expression(of, ofType),
          ofType,
          fieldOf(value, "digits") as number | null,
          this.style(),
          fieldOf(value, "precision") === true,
        ));
      }
      case "argv": {
        const index = fieldOf(value, "index") as SemanticValue | null;
        return index === null
          ? String((fieldOf(this.target, "argvCount") as (...args: any[]) => any)(undefined))
          : String((fieldOf(this.target, "argv") as (...args: any[]) => any)(this.expression(index, USIZE)));
      }
      case "compare":
        return this.compare(value as SemanticValue & { k: "compare" });
      case "isNull":
        return String((fieldOf(this.target, "isNull") as (...args: any[]) => any)(
          this.expression(fieldOf(value, "operand") as SemanticValue, fieldOf(fieldOf(value, "operand"), "type") as SemanticType),
          fieldOf(value, "negate") === true,
        ));
      case "unary":
        return this.unary(value as SemanticValue & { k: "unary" });
      case "logical":
        return this.logical(value as SemanticValue & { k: "logical" });
      case "coalesce":
        return this.coalesce(value as SemanticValue & { k: "coalesce" });
      case "select": {
        const condition = fieldOf(value, "condition") as SemanticValue;
        const then = fieldOf(value, "then") as SemanticValue;
        const otherwise = fieldOf(value, "otherwise") as SemanticValue;
        return String((fieldOf(this.target, "conditional") as (...args: any[]) => any)(
          this.condition(condition),
          this.expression(then, as),
          this.expression(otherwise, as),
        ));
      }
      case "arith":
        return this.arith(value as SemanticValue & { k: "arith" });
      case "closure":
      case "capture":
        // A closure is a value a body holds, and the program's own statements
        // are resolved into calls of names rather than into closures. Reaching
        // here would be a program the resolver never lowered.
        throw emitError("the emitter cannot write down a closure value here", "a program calls the functions it declares by name");
    }
  }

  /** A string the program builds, one part after another. */
  private text(value: SemanticValue & { k: "text" }): string {
    const parts = fieldOf(value, "parts") as readonly { readonly k: string; readonly value: string | SemanticValue }[];
    if (parts.length === 0) return String((fieldOf(this.target, "stringLiteral") as (...args: any[]) => any)(""));
    let text: string | null = null;
    for (const part of parts) {
      const piece = String(fieldOf(part, "k")) === "text"
        ? String((fieldOf(this.target, "stringLiteral") as (...args: any[]) => any)(String(fieldOf(part, "value"))))
        : this.expression(fieldOf(part, "value") as SemanticValue, fieldOf(fieldOf(part, "value"), "type") as SemanticType);
      text = text === null ? piece : String((fieldOf(this.target, "stringConcat") as (...args: any[]) => any)(text, piece));
    }
    return text as string;
  }

  /**
   * The length of an array is the sidecar its allocation wrote next to it, and
   * the length of a string is counted by the runtime: the two are spelled the
   * way the target spells them, and only the target knows which is which.
   */
  private length(value: SemanticValue & { k: "length" }): string {
    const of = fieldOf(value, "of") as SemanticValue;
    const ofType = fieldOf(of, "type") as SemanticType;
    if (isTextType(ofType)) return String((fieldOf(this.target, "stringLength") as (...args: any[]) => any)(this.expression(of, ofType)));
    if (of.k === "local") return `${this.names.read(String(fieldOf(of, "name")))}_length`;
    // A list held in a field or answered by a call has no sidecar count beside
    // a name: the header the runtime laid in front of the block is the count.
    const element = elementTypeOf(ofType);
    if (element !== null && isSequence(ofType)) {
      return String((fieldOf(this.target, "sequenceLength") as (...args: any[]) => any)(this.expression(of, ofType), element));
    }
    throw emitError("the emitter cannot write down the length of an array", `${of.k} names no allocation`);
  }

  private compare(value: SemanticValue & { k: "compare" }): string {
    const operand = fieldOf(value, "operand") as SemanticType;
    const op = String(fieldOf(value, "op"));
    const leftValue = fieldOf(value, "left") as SemanticValue;
    const rightValue = fieldOf(value, "right") as SemanticValue;
    if (isTextType(operand)) {
      const left = this.expression(leftValue, fieldOf(leftValue, "type") as SemanticType);
      const right = this.expression(rightValue, fieldOf(rightValue, "type") as SemanticType);
      // Two strings are ordered by what they say. Every operator but `eq` and
      // `ne` used to be answered with the equality test, so `"apple" <
      // "banana"` was reported as false — the two are not the same text, which
      // says nothing about which one comes first.
      if (op === "eq" || op === "ne") {
        const equal = String((fieldOf(this.target, "stringEqual") as (...args: any[]) => any)(left, right));
        return op === "ne" ? String((fieldOf(this.target, "logicalNot") as (...args: any[]) => any)(equal)) : equal;
      }
      return `${String((fieldOf(this.target, "stringCompare") as (...args: any[]) => any)(left, right))} ${COMPARE_OPERATORS[op as CompareOp]} 0`;
    }
    // A wide number is four limbs and C compares a struct with `==` by identity
    // and has no ordering at all, so a pair of them is the kernel's comparison
    // rather than an operator over two machine words.
    if (isWideType(operand)) {
      return String((fieldOf(this.target, "wideCompare") as (...args: any[]) => any)(op, this.expression(leftValue, operand), this.expression(rightValue, operand), operand));
    }
    // The two sides are compared as one type, which the IR states: a whole
    // number and a literal are compared as whole numbers, not as two.
    const left = this.expression(leftValue, operand);
    const right = this.expression(rightValue, operand);
    return `${left} ${COMPARE_OPERATORS[op as CompareOp]} ${right}`;
  }

  private unary(value: SemanticValue & { k: "unary" }): string {
    const op = String(fieldOf(value, "op"));
    const operand = fieldOf(value, "operand") as SemanticValue;
    const type = fieldOf(value, "type") as SemanticType;
    if (op === "not") return String((fieldOf(this.target, "logicalNot") as (...args: any[]) => any)(this.condition(operand)));
    // A wide complement covers every limb, which C's `~` cannot be asked for
    // over a struct, so it is the kernel's operation rather than an operator. A
    // wide negation never arrives: the validator refuses it, because the answer
    // the language gives is below zero and a wide number holds none.
    if (op === "bitNot" && isWideType(type)) {
      return String((fieldOf(this.target, "wideUnary") as (...args: any[]) => any)(op, this.expression(operand, type), type));
    }
    if (op === "bitNot") return String((fieldOf(this.target, "bitwiseNot") as (...args: any[]) => any)(this.expression(operand, type)));
    return `(${op === "neg" ? "-" : "+"}${this.expression(operand, type)})`;
  }

  private logical(value: SemanticValue & { k: "logical" }): string {
    const leftValue = fieldOf(value, "left") as SemanticValue;
    const rightValue = fieldOf(value, "right") as SemanticValue;
    const resultType = fieldOf(value, "type") as SemanticType;
    const left = this.expression(leftValue, fieldOf(leftValue, "type") as SemanticType);
    const leftType = fieldOf(leftValue, "type") as SemanticType;
    const test = String((fieldOf(this.target, "condition") as (...args: any[]) => any)(left, valueKind(leftValue), leftType));
    const rightIsText = rightValue.k === "text" || (rightValue.k === "const" && isTextType(fieldOf(rightValue, "type") as SemanticType));
    const leftIsAny = leftType.kind === "ref" && fieldOf(leftType, "of") === null && fieldOf(leftType, "name") === undefined;
    const right = rightIsText && leftIsAny
      ? `${RUNTIME_NAME}_box_string(${this.raw(rightValue, null)})`
      : this.expression(rightValue, resultType);
    // A number arm beside a text is the test, and the text is the value the
    // operator hands back, so a number that answers is written as the text of
    // that number.
    const answer = (arm: SemanticValue, written: string): string => {
      const armType = fieldOf(arm, "type") as SemanticType;
      if (isNumber(armType) && isTextType(resultType)) return String((fieldOf(this.target, "toText") as (...args: any[]) => any)(written, armType, null, this.style(), false));
      return written;
    };
    const op = String(fieldOf(value, "op"));
    return op === "and"
      ? String((fieldOf(this.target, "conditional") as (...args: any[]) => any)(test, answer(rightValue, right), answer(leftValue, left)))
      : String((fieldOf(this.target, "conditional") as (...args: any[]) => any)(test, answer(leftValue, left), answer(rightValue, right)));
  }

  private coalesce(value: SemanticValue & { k: "coalesce" }): string {
    const leftValue = fieldOf(value, "left") as SemanticValue;
    const type = fieldOf(value, "type") as SemanticType;
    const left = this.expression(leftValue, fieldOf(leftValue, "type") as SemanticType);
    // Only a reference or a string can be nothing: a number never is. A name
    // resolves to a reference whatever it holds, so this asks what the value
    // carries: reading a number as a reference compiles the fallback arm away
    // and leaves a comparison that does not compile.
    const kind = valueKind(leftValue);
    if (kind === "null" || kind === "text" || kind === "reference") {
      return String((fieldOf(this.target, "conditional") as (...args: any[]) => any)(
        (fieldOf(this.target, "isNull") as (...args: any[]) => any)(left, false),
        this.expression(fieldOf(value, "right") as SemanticValue, type),
        left,
      ));
    }
    return left;
  }

  private arith(value: SemanticValue & { k: "arith" }): string {
    const op = String(fieldOf(value, "op"));
    const type = fieldOf(value, "type") as SemanticType;
    const leftValue = fieldOf(value, "left") as SemanticValue;
    const rightValue = fieldOf(value, "right") as SemanticValue;
    if (op === "concat") {
      // A string is added to a string: the driver builds the text.
      return String((fieldOf(this.target, "stringConcat") as (...args: any[]) => any)(
        this.expression(leftValue, fieldOf(leftValue, "type") as SemanticType),
        this.expression(rightValue, fieldOf(rightValue, "type") as SemanticType),
      ));
    }
    if (op === "arrayConcat") {
      // Array concatenation in a program body is evaluated eagerly and never
      // reaches the emitter; a function body that keeps one is refused.
      throw new Error("arrayConcat is not emitted by the program backend");
    }
    if (op === "min") {
      return String((fieldOf(this.target, "min") as (...args: any[]) => any)(this.expression(leftValue, type), this.expression(rightValue, type)));
    }
    if (op === "max") {
      return String((fieldOf(this.target, "max") as (...args: any[]) => any)(this.expression(leftValue, type), this.expression(rightValue, type)));
    }
    if (op === "mod") {
      // A wide remainder is four limbs and no C operator, so it is a call into
      // the kernel like every other wide operation. Read as `x % y` it is
      // `invalid operands to binary % (have 'blaze_u256' and 'blaze_u256')`
      // and the build failed at the link rather than here.
      if (isWideType(type)) {
        // `mod(mul(a, b), c)` must be a modular multiplication: the plain
        // multiply wraps past 2^256 and loses the high half of the product,
        // so reducing the wrapped value modulo c is not the same as reducing
        // the true product. Use the kernel's mul_mod which computes the full
        // product and reduces it.
        if (leftValue.k === "arith" && String(fieldOf(leftValue, "op")) === "mul") {
          return String((fieldOf(this.target, "wideMulMod") as (...args: any[]) => any)(
            this.expression(fieldOf(leftValue, "left") as SemanticValue, type),
            this.expression(fieldOf(leftValue, "right") as SemanticValue, type),
            this.expression(rightValue, type),
            type,
          ));
        }
        return String((fieldOf(this.target, "wideBinary") as (...args: any[]) => any)(op, this.expression(leftValue, type), this.expression(rightValue, type), type));
      }
      return String((fieldOf(this.target, "modulo") as (...args: any[]) => any)(this.expression(leftValue, type), this.expression(rightValue, type)));
    }
    if (op === "floorDiv") {
      return String((fieldOf(this.target, "floorDivide") as (...args: any[]) => any)(this.expression(leftValue, type), this.expression(rightValue, type), type));
    }
    if (op === "floorMod") {
      return String((fieldOf(this.target, "floorModulo") as (...args: any[]) => any)(this.expression(leftValue, type), this.expression(rightValue, type), type));
    }
    if (op === "pow") {
      // A power is floating point even over whole numbers, and Nim spells one
      // with the operator that xors two whole numbers.
      return String((fieldOf(this.target, "power") as (...args: any[]) => any)(this.expression(leftValue, type), this.expression(rightValue, type)));
    }
    // The bitwise operators are whole numbers masked whole, and the targets
    // already know how each of them is spelled.
    const left = this.expression(leftValue, type);
    // The count of a shift is the machine word the source wrote the shift by,
    // and the kernel takes one word of it: read at the number's own width a
    // count over four limbs is `(unsigned)(a struct)`, which is not C.
    const counted = op === "shl" || op === "shr" || op === "ushr";
    const right = this.expression(rightValue, counted ? USIZE : type);
    // A wide number is four limbs and no C operator, so an operation over
    // one is a call into the kernel every backend shares. Written as a C
    // operator it is `invalid operands to binary + (have 'blaze_u256' and
    // 'blaze_u256')`, and the build failed at the link rather than here.
    if (isWideType(type)) {
      // The modulus this operation should be reduced under: either the
      // `modCtx` from an enclosing `mod(X, c)` call, the `invertModulo`
      // for the `invert` function's extended Euclidean algorithm, or a
      // modulus discovered by the data-flow analysis.
      const modulus = this.modulusForArith.get(value) ?? this.invertModulo ?? this.modCtx;
      if (op === "mul" && modulus !== null) {
        return String((fieldOf(this.target, "wideMulMod") as (...args: any[]) => any)(left, right, modulus, type));
      }
      if ((op === "add" || op === "sub") && modulus !== null) {
        const method = op === "add" ? "wideAddMod" : "wideSubMod";
        return String((fieldOf(this.target, method) as (...args: any[]) => any)(left, right, modulus, type));
      }
      return String((fieldOf(this.target, "wideBinary") as (...args: any[]) => any)(op, left, right, type));
    }
    return `(${left} ${String((fieldOf(this.target, "operator") as (...args: any[]) => any)((ARITH_OPERATORS as Record<string, ProgramBinaryOp>)[op]))} ${right})`;
  }

}

/** Emits the source of one program in the language a target speaks. */
export function generateProgramSource(program: SemanticProgram, target: ProgramTarget, loweredElsewhere: ReadonlySet<string> = new Set()): string {
  return new ProgramEmitter(program, target, loweredElsewhere).emit();
}

export type { ProgramBinaryOp, ProgramUnaryOp };

/**
 * Lowering a function's semantic IR to C.
 *
 * This is the half of the boundary a model does not work: a build resolves the
 * IR of a function, validates it against the contract, and lowers it here.
 * Register allocation, instruction selection, the calling convention and the
 * stack are then the C compiler's, so no register, offset or instruction is
 * ever a choice anything else makes, and none is written here either.
 *
 * The C is the compiler's own, not text a model supplied, so it may use what a
 * program needs: the maths library for a power and a floor. What it may not do
 * is define a second function — the object is linked beside the other objects
 * of the program, and the linker is what resolves what it calls.
 */

import { stat, writeFile } from "node:fs/promises";
import { CompilerError } from "../core/errors.ts";
import { inspectObject } from "./assembler.ts";
import { run } from "../core/process.ts";
import { symbolOf } from "../semantics/contract.ts";
import type { BuildMode, FunctionContract, TargetSpec } from "../core/types.ts";
import { parseType } from "../semantics/contract.ts";
import { ARGV_LENGTH } from "../semantics/builtins.ts";
import {
  elementTypeOf,
  isBoolean,
  isFloat,
  isInteger,
  isNumber,
  isReference,
  isUnsigned,
  isWideType,
  isTextType,
  slotType,
  valueKind,
  type SemanticBlock,
  type SemanticCall,
  type SemanticFunction,
  type SemanticLoop,
  type SemanticStatement,
  type SemanticType,
  type SemanticValue,
  type ValueKind,
  typeText,
} from "../core/semantic-ir.ts";
import { cDeclarationType, cObjectDeclarations } from "./linker.ts";
import { C_KEYWORDS, cEscape, cHeaderNames, cLiteral, cMacroNames, cMemberName, cOperator, cStringLiteral, cSymbolLabel, cSymbolName } from "./c-names.ts";
import { NameScope } from "./names.ts";
import { DEFAULT_ALIGNMENT, RUNTIME_NAME, RUNTIME_SYMBOLS } from "../runtime/abi.ts";
import { archOptions, assemblyOptions, cTargetOptions, loweringOptions, threadingOptions } from "../core/target.ts";
import { entryIsParallel } from "../semantics/parallel.ts";

const NUMBER: SemanticType = { kind: "primitive", name: "f64" };
const USIZE: SemanticType = { kind: "primitive", name: "usize" };
const TEXT = { kind: "text" } as const;

/** The C a value of this type is declared as. A string is a C string. */
function declaredType(type: SemanticType | null): string {
  if (type === null || isTextType(type)) return "const char*";
  return cDeclarationType(type);
}

/**
 * The text a value is written out as, when the emitter is the one writing it:
 * a constant of the text type, and a text whose parts are all written out,
 * which `text` below folds into one literal. Null when the program builds the
 * string while it runs, which is the only case whose length is not a number
 * the emitter can write down.
 *
 * What the C string such a value becomes is its bytes up to a NUL, because
 * that is where the C string ends: an embedded NUL is written as `\000`, so it
 * terminates the literal and is not one of the characters counted.
 */
function literalText(value: SemanticValue): string | null {
  if (value.k === "const" && isTextType(value.type)) return value.text;
  if (value.k === "text" && value.parts.every((part) => part.k === "text")) {
    return value.parts.map((part) => (part.k === "text" ? part.value : "")).join("");
  }
  return null;
}

/**
 * Whether a value the `for` of a loop writes down has to be bound to a name of
 * its own above it.
 *
 * A name the IR already bound is what the `for` would read, and a value the IR
 * wrote out is a literal the `for` would read, so neither is worth a slot and a
 * copy — the C compiler makes that copy and removes it for itself. A call, a
 * load or a length is computed again on every turn, and `optimize-ir` has
 * already lifted the ones it may lift above the loop as names, so what arrives
 * here is a value it could not lift: a bound that reads something the body
 * writes, which is not the same value on every turn.
 */
function readEveryTurn(value: SemanticValue): boolean {
  return value.k !== "local" && value.k !== "const";
}

/**
 * What a generated C function already occupies: the C it compiles against. The
 * two names `Math.round` binds are in it as well, because they are written
 * down rather than counted and a program is free to call a variable either of
 * them.
 */
const TAKEN: Record<string, true> = {
  ...C_KEYWORDS,
  ...cHeaderNames(),
  ...cMacroNames(),
  ...RUNTIME_SYMBOLS,
  blaze_operand: true,
  blaze_rounded: true,
};

function backendError(message: string, detail?: string): CompilerError {
  return new CompilerError({ category: "LinkError", stage: "link", message, detail });
}

function pad(depth: number): string {
  return "  ".repeat(depth);
}

/** The operator each operation the IR states is spelled with in C. */
const ARITHMETIC_OPERATORS: Record<string, string> = {
  add: "+",
  sub: "-",
  mul: "*",
  div: "/",
  mod: "%",
  shl: "<<",
  shr: ">>",
  ushr: ">>",
  and: "&",
  or: "|",
  xor: "^",
};

const COMPARE_OPERATORS: Record<string, string> = {
  eq: "==",
  ne: "!=",
  lt: "<",
  le: "<=",
  gt: ">",
  ge: ">=",
};


/**
 * The maths builtin each source name lowers to. `Math.round` is a half rounded
 * up, and a value that rounds to zero from below keeps its sign, which is what
 * the source language does and what a C `round` rounds away.
 */
function builtinExpression(name: string, args: string[]): string {
  switch (name) {
    case "Math.abs":
      return `fabs(${args[0]})`;
    case "Math.sqrt":
      return `sqrt(${args[0]})`;
    case "Math.floor":
      return `floor(${args[0]})`;
    case "Math.trunc":
      return `trunc(${args[0]})`;
    case "Math.round":
      // The argument is read twice, so it is bound: a value the IR calls is a
      // call that would otherwise run twice.
      return `({ double blaze_operand = ${args[0]}; double blaze_rounded = floor(blaze_operand + 0.5); (blaze_rounded == 0.0 && blaze_operand < 0.0) ? -0.0 : blaze_rounded; })`;
    default:
      throw backendError(
        `this backend cannot lower ${name}`,
        "a maths builtin is lowered to the C library function of the same name",
      );
  }
}

/**
 * Writes a whole number as the digits it is, into a buffer the caller owns.
 *
 * This is a function and not a statement expression because of what a
 * statement expression is: everything declared inside one dies when it ends,
 * so a buffer declared there and handed back out of it is a dangling pointer,
 * and the C compiler reads it as one from `-O1` upwards. A version written as
 * an expression printed an empty string for every number above the width of a
 * double, which is exactly the case this exists for. A function has a frame of
 * its own, so the buffer it fills is still there when it returns.
 */
const WHOLE_NUMBER_HELPER = `/* A whole number as its digits, which is not what a double can hold.
   The magnitude is taken unsigned because the most negative i64 negates to
   itself as a signed value and its digits would then never come out. A u64 is
   twenty digits, so twenty are taken and the caller's buffer holds them with
   room for the sign and the terminator. The count of what was written comes
   back, because a caller that lays a number out beside other text needs the
   length as much as the digits and has nowhere else to learn it. */
static size_t blaze_whole_text(int negative, unsigned long long magnitude, char* out) {
  char digits[20];
  int count = 0;
  do {
    digits[count++] = (char)('0' + (int)(magnitude % 10));
    magnitude /= 10;
  } while (magnitude > 0);
  int used = 0;
  if (negative) out[used++] = '-';
  while (count > 0) out[used++] = digits[--count];
  out[used] = '\\0';
  return (size_t)used;
}`;

/**
 * Writes one function of the IR as C. The C is a translation unit of its own:
 * the runtime header, the layouts of the objects the function reads and writes,
 * and a declaration of every other function of the program it calls, so the
 * compiler can compile it without the rest of the program beside it.
 */
export function generateFunctionC(fn: SemanticFunction): string {
  return new FunctionEmitter(fn).emit();
}

class FunctionEmitter {
  private readonly fn: SemanticFunction;
  private readonly body: string[] = [];
  private readonly names = new NameScope((name) => cEscape(name, TAKEN));
  private readonly loops: { header: string; exit: string }[] = [];
  /**
   * The region loop the code being written is inside the body of, if any.
   *
   * A region is left wherever the turn is left from, so a turn that breaks out
   * of its loop or returns out of the function has to leave it there rather
   * than at the end of the body it never reaches. Only one region is open at a
   * time — `semantics/region.ts` marks a loop only where no loop inside it is
   * marked — so one name is the whole of what has to be remembered.
   */
  private region: { header: string } | null = null;
  /** Every function of the program this one calls, as its C declaration. */
  private readonly externs = new Map<string, string>();
  /** Lines that must come before the statement being written. */
  private pending: string[] = [];
  private depth = 1;
  private temporaries = 0;
  /** Set once a whole number is written out, which is what the helper is for. */
  private wholeNumbers = false;

  constructor(fn: SemanticFunction) {
    this.fn = fn;
  }

  emit(): string {
    // Parameters are the scope the body reads its arguments from, bound before
    // anything is written so a body that shadows one writes a second name.
    const parameters = this.fn.params.map(
      (param) => `${declaredType(slotType(param))} ${this.names.declare(param.name, slotType(param))}`,
    );
    this.block(this.fn.entry, 1);
    const layouts = cObjectDeclarations(this.fn.objects);
    const signature = `${declaredType(this.fn.returns)} ${this.fn.symbol}(${parameters.join(", ") || "void"})`;
    return [
      `/* ${this.fn.name}, as the compiler resolved it, lowered from the semantic IR. Do not edit. */`,
      "#include <stdbool.h>",
      "#include <stdint.h>",
      "#include <math.h>",
      // No `<stdio.h>`: nothing written below is output, and a header a
      // translation unit does not use is one more it parses for every function
      // of the program. The runtime source, which does print, includes it
      // itself.
      "#include <string.h>",
      "",
      `#include "${RUNTIME_NAME}.h"`,
      ...(layouts === "" ? [] : ["", layouts]),
      ...(this.externs.size === 0 ? [] : ["", ...this.externs.values()]),
      ...(this.wholeNumbers ? ["", WHOLE_NUMBER_HELPER] : []),
      "",
      `${signature} {`,
      ...this.body,
      "}",
      "",
    ].join("\n");
  }

  private temporary(prefix: string): string {
    this.temporaries += 1;
    return this.names.reserve(`${prefix}_${this.temporaries}`);
  }

  /**
   * Writes lines, after whatever the value they are written from declared.
   *
   * A value a statement writes down can need a declaration of its own — a
   * whole number is written into a buffer, and the buffer is a local of the
   * statement rather than of the one before it — so the declarations waiting
   * reach the output here, before the line that reads them, rather than at the
   * next statement the block comes to.
   */
  private write(lines: readonly string[]): void {
    this.flush();
    this.body.push(...lines);
  }

  /* ---------------------------------------------------------------------- */
  /* Blocks and statements                                                   */
  /* ---------------------------------------------------------------------- */

  private block(block: SemanticBlock, depth: number): void {
    this.names.enter();
    const outer = this.depth;
    this.depth = depth;
    for (const statement of block.statements) {
      this.flush();
      this.statement(statement, depth);
    }
    this.flush();
    for (const name of block.releases) {
      this.write([`${pad(depth)}${RUNTIME_NAME}_release(${this.names.read(name)});`]);
    }
    this.terminator(block, depth);
    this.depth = outer;
    this.names.leave();
  }

  /** Writes the declarations a value needed, before the line that reads them. */
  private flush(): void {
    if (this.pending.length === 0) return;
    this.body.push(...this.pending.map((line) => `${pad(this.depth)}${line}`));
    this.pending = [];
  }

  /** The declarations waiting to be written, taken rather than left pending. */
  private takePending(): string[] {
    const declared = this.pending;
    this.pending = [];
    return declared;
  }

  private statement(statement: SemanticStatement, depth: number): void {
    switch (statement.k) {
      case "let": {
        const type = slotType(statement.slot);
        const name = this.names.declare(statement.slot.name, type);
        this.write([`${pad(depth)}${declaredType(type)} ${name} = ${this.expression(statement.value, type, depth)};`]);
        return;
      }
      case "set": {
        const type = this.names.typeOf(statement.name, statement.value.type);
        const target = this.names.read(statement.name);
        // A string grows: `+=` is a new value rather than an addition in place,
        // and C adds two pointers by their addresses. It is written as the
        // concatenation the IR states, which is what the other targets do.
        if (statement.op === "+=" && (type === null || isTextType(type))) {
          const held: SemanticValue = { k: "local", type: type ?? { kind: "text" }, name: statement.name };
          this.write([`${pad(depth)}${target} = ${this.concat(held, statement.value, depth)};`]);
          return;
        }
        this.write([`${pad(depth)}${target} ${statement.op} ${this.expression(statement.value, type, depth)};`]);
        return;
      }
      case "setElement": {
        const buffer = this.names.declared(statement.buffer);
        const element = buffer === null || buffer.type === null ? null : elementTypeOf(buffer.type);
        this.write([
          `${pad(depth)}${this.element(statement.buffer, statement.index, depth)} ${statement.op} ${this.expression(statement.value, element ?? statement.value.type, depth)};`,
        ]);
        return;
      }
      case "step":
        this.write([
          `${pad(depth)}${statement.prefix ? statement.op : ""}${this.names.read(statement.name)}${statement.prefix ? "" : statement.op};`,
        ]);
        return;
      case "printText":
        this.printText(statement.value, depth);
        return;
      case "printNumber": {
        // A whole number is written as the integer it is. The runtime's
        // formatter takes a double, and a double holds every `i64` only up to
        // 2^53, so a larger one lost its last digits on the way out.
        const value = statement.value;
        if (isNumber(value.type) && isInteger(value.type)) {
          const text = this.number(this.expression(value, value.type, depth), value.type).text;
          this.write([`${pad(depth)}${RUNTIME_NAME}_print_text(${text});`]);
          return;
        }
        this.write([`${pad(depth)}${RUNTIME_NAME}_print_number(${this.expression(value, NUMBER, depth)});`]);
        return;
      }
      case "printNewline":
        this.write([`${pad(depth)}${RUNTIME_NAME}_print_newline();`]);
        return;
      case "retain":
        this.write([`${pad(depth)}(void)${RUNTIME_NAME}_retain(${this.expression(statement.value, null, depth)});`]);
        return;
      case "call":
        this.write([`${pad(depth)}${this.call(statement.call, depth)};`]);
        return;
      case "raise":
        this.write([`${pad(depth)}${RUNTIME_NAME}_raise(${this.expression(statement.message, TEXT, depth)});`]);
        return;
      case "storeField":
        this.write([
          `${pad(depth)}((struct ${statement.layout}*)${this.expression(statement.object, null, depth)})->${cMemberName(statement.field)} = ${this.expression(statement.value, null, depth)};`,
        ]);
        return;
      case "if":
        this.write([`${pad(depth)}if (${this.condition(statement.condition, depth)}) {`]);
        this.block(statement.then, depth + 1);
        if (statement.otherwise !== null) {
          this.write([`${pad(depth)}} else {`]);
          this.block(statement.otherwise, depth + 1);
        }
        this.write([`${pad(depth)}}`]);
        return;
      case "block":
        this.write([`${pad(depth)}{`]);
        this.block(statement.body, depth + 1);
        this.write([`${pad(depth)}}`]);
        return;
      case "loop":
        this.loop(statement.loop, depth);
        return;
    }
  }

  /**
   * The pragma that hands a loop's turns to the host's threads, with the
   * accumulators the turns combine named on it.
   *
   * OpenMP's `reduction` clause is what the reduction in the IR asks for: each
   * turn keeps a total of its own, and the totals are combined once the loop is
   * done. That is the same number as a turn writing the accumulator, and it is
   * only that because `semantics/parallel.ts` proved the values combined are
   * whole numbers, where combining in any order gives the same number.
   *
   * A loop with no accumulators names none and the pragma is the one it always
   * was: the turns share nothing, so there is nothing to combine.
   */
  private parallelDirective(loop: Extract<SemanticLoop, { kind: "counted" | "each" }>): string {
    const reductions = loop.reductions ?? [];
    if (reductions.length === 0) return "#pragma omp parallel for";
    const clauses = reductions.map((reduction) => `reduction(${reduction.op}:${this.names.read(reduction.name)})`);
    return `#pragma omp parallel for ${clauses.join(" ")}`;
  }

  private loop(loop: SemanticLoop, depth: number): void {
    // The buffer a `for..of` iterates is read here, in the scope the loop was
    // entered in, and not in the loop's own. An element declared under the
    // same name as the buffer shadows it, so reading the buffer after the
    // declaration made the loop subscript the element it had not taken yet.
    const buffer = loop.kind === "each" ? this.names.read(loop.of) : null;
    const walk = loop.kind === "each" ? this.expression(loop.length, USIZE, depth) : null;
    this.names.enter();
    this.loops.push({ header: loop.header, exit: loop.exit });
    switch (loop.kind) {
      case "while":
        this.write([`${pad(depth)}while (${this.condition(loop.condition, depth)}) {`]);
        this.block(loop.body, depth + 1);
        this.write([`${pad(depth)}}`]);
        break;
      case "doWhile":
        this.write([`${pad(depth)}do {`]);
        this.block(loop.body, depth + 1);
        this.write([`${pad(depth)}} while (${this.condition(loop.condition, depth)});`]);
        break;
      case "counted": {
        const type = loop.type;
        const written = declaredType(type);
        const bound = `${COMPARE_OPERATORS[loop.down ? "gt" : "lt"]}${loop.inclusive ? "=" : ""}`;
        // The index is declared under its own name, and a loop that counts
        // from a value of that same name counts from the outer one:
        // `for (let limit = limit; ...)` starts at the `limit` around it. The
        // bounds are read before the index is declared, because after it the
        // name resolves to the loop's own declaration — which is written into
        // the `for` below, so reading it first named a variable the C did not
        // declare yet and the object did not build.
        const given = loop.step;
        const start = this.expression(loop.from, type, depth);
        const end = this.expression(loop.to, type, depth);
        const by = given === null ? null : this.expression(given, type, depth);
        const variable = this.names.declare(loop.variable, type);
        // What the loop counts over is read once. The `for` reads its bound on
        // every turn and adds its step on every turn, so a bound or a step the
        // IR calls is a call the loop makes once per turn. One that is a name or
        // a literal is read as it is, and a temporary for it would be a slot and
        // a copy the C compiler makes and removes for itself — see
        // `readEveryTurn` for what is left once the IR pass has had its turn.
        const from = readEveryTurn(loop.from) ? this.temporary("blaze_from") : null;
        const to = readEveryTurn(loop.to) ? this.temporary("blaze_to") : null;
        const step = given !== null && readEveryTurn(given) ? this.temporary("blaze_step") : null;
        if (from !== null) this.write([`${pad(depth)}${written} ${from} = ${start};`]);
        if (to !== null) this.write([`${pad(depth)}${written} ${to} = ${end};`]);
        if (step !== null) this.write([`${pad(depth)}${written} ${step} = ${by as string};`]);
        // The step is the signed amount the index moves by, so a loop that
        // counts down carries a negative one and adds it like any other:
        // subtracting it from a step of -1 moves the index the other way, and
        // the loop never ends. A step with a name of its own is added by that
        // name, whichever of the two it is.
        const move = by === null ? `${variable}${loop.down ? "--" : "++"}` : `${variable} += ${step ?? (by as string)}`;
        // A loop the compiler proved has turns that do not depend on each other
        // is handed to OpenMP, which is the C compiler's threads and not the
        // compiler's: the pragma asks for a team of them over the turns, and
        // every name the body reads but does not write is shared and read-only
        // by the proof the mark carries. The bounds were hoisted into locals
        // above, so the loop OpenMP is handed is the canonical one — an integer
        // counter from a bound up to a bound — and a bound the loop re-read on
        // every turn is read by one thread rather than by all of them.
        if (loop.parallel === true) {
          this.write([`${pad(depth)}${this.parallelDirective(loop)}`]);
        }
        this.write([`${pad(depth)}for (${written} ${variable} = ${from ?? start}; ${variable} ${bound} ${to ?? end}; ${move}) {`]);
        this.turn(loop, depth + 1);
        this.write([`${pad(depth)}}`]);
        break;
      }
      case "each": {
        const index = this.names.declare(loop.index, USIZE);
        const element = this.names.declare(loop.element, loop.elementType);
        // The length is read once, for the same reason a counted loop's bound
        // is: the walk reads it on every turn. One the IR already named is the
        // name the walk would read anyway.
        const length = readEveryTurn(loop.length) ? this.temporary("blaze_length") : null;
        if (length !== null) this.write([`${pad(depth)}size_t ${length} = ${walk as string};`]);
        if (loop.parallel === true) {
          this.write([`${pad(depth)}${this.parallelDirective(loop)}`]);
        }
        this.write([
          `${pad(depth)}for (size_t ${index} = 0; ${index} < ${length ?? (walk as string)}; ${index}++) {`,
          `${pad(depth + 1)}${declaredType(loop.elementType)} ${element} = ${buffer as string}[${index}];`,
        ]);
        this.turn(loop, depth + 1);
        this.write([`${pad(depth)}}`]);
        break;
      }
    }
    this.loops.pop();
    this.names.leave();
  }

  /**
   * The body of one turn, between a region's beginning and its end where the
   * loop carries the mark.
   *
   * The region begins at the top of the turn and is left at the bottom of it,
   * so the next turn is written over what this one built. A turn that leaves
   * early leaves it early too — see `terminator` — and leaving it twice is
   * nothing, which is why the end is written whether the body ended by jumping
   * out of it or not.
   */
  private turn(loop: Extract<SemanticLoop, { kind: "counted" | "each" }>, depth: number): void {
    if (loop.region !== true) {
      this.block(loop.body, depth);
      return;
    }
    this.write([`${pad(depth)}${RUNTIME_NAME}_region_enter();`]);
    const opened = this.region;
    this.region = { header: loop.header };
    this.block(loop.body, depth);
    this.write([`${pad(depth)}${RUNTIME_NAME}_region_leave();`]);
    this.region = opened;
  }

  /** Where a block ends: the value it hands back, or where it jumps to. */
  private terminator(block: SemanticBlock, depth: number): void {
    const terminator = block.terminator;
    if (terminator.k === "next") return;
    // A block nothing arrives at writes nothing: there is no return to write,
    // no block to leave for, and no path that reaches the end of the function
    // from here — every way through the block has already left.
    if (terminator.k === "unreachable") return;
    if (terminator.k === "return") {
      this.leaveRegion(depth);
      // A body that falls off its end says so with a return carrying nothing,
      // which a function that returns a value has nothing to say with: C will
      // not compile `return;` in one, and nothing reaches it — an arm that
      // returns leaves the end of the body past every path that got there.
      if (terminator.value === null) {
        if (this.fn.returns.kind === "void") this.write([`${pad(depth)}return;`]);
        return;
      }
      this.write([`${pad(depth)}return ${this.expression(terminator.value, this.fn.returns, depth)};`]);
      return;
    }
    // A jump leaves the blocks it is written in, and frees what they owned on
    // the way out. A function allocates no array, and an object it builds
    // belongs to its caller, so there is normally nothing to free here.
    for (const name of terminator.releases) {
      this.write([`${pad(depth)}${RUNTIME_NAME}_release(${this.names.read(name)});`]);
    }
    const open = this.loops[this.loops.length - 1];
    if (open === undefined || (terminator.target !== open.header && terminator.target !== open.exit)) {
      throw backendError(`${this.fn.symbol} jumps for a block no loop around it names`, terminator.target);
    }
    // A `continue` is another turn of the same loop, so the region is still the
    // right one after it; a jump out of the loop the region belongs to is not,
    // and leaves it on the way.
    //
    // Only that loop's own exit ends it. A `break` out of a loop *inside* the
    // marked one lands still inside its body, and leaving there ended the turn's
    // region early: the rest of the turn then allocated from the slab rather than
    // the cursor, and a block released on that path reached the slab's released
    // list while the region was still rewound over the same bytes — two live
    // blocks in one piece of memory from the next turn on.
    if (terminator.target !== open.header && this.region?.header === open.header) this.leaveRegion(depth);
    this.write([`${pad(depth)}${terminator.target === open.header ? "continue;" : "break;"}`]);
  }

  /** Leaves the region the code being written is inside, where there is one. */
  private leaveRegion(depth: number): void {
    if (this.region === null) return;
    this.write([`${pad(depth)}${RUNTIME_NAME}_region_leave();`]);
    this.region = null;
  }

  /* ---------------------------------------------------------------------- */
  /* Values                                                                  */
  /* ---------------------------------------------------------------------- */

  private condition(value: SemanticValue, depth: number): string {
    return this.truth(this.expression(value, null, depth), valueKind(value), value.type);
  }

  /** Whether C text already written answers as a truth. */
  private truth(text: string, kind: ValueKind, type: SemanticType | null): string {
    switch (kind) {
      case "text":
        return `((${text})[0] != '\\0')`;
      case "reference":
        return `((${text}) != NULL)`;
      case "boolean":
        return `(${text})`;
      default:
        // A value that is not a number holds nothing, and `NaN != 0` is true
        // in C, so the test asks for a number that is a number. The value is
        // bound because it is read twice, and a value the IR calls is a call.
        if (isFloat(type)) {
          const arm = this.temporary("blaze_truth");
          return `({ double ${arm} = (${text}); ${arm} == ${arm} && ${arm} != 0; })`;
        }
        return `((${text}) != 0)`;
    }
  }

  private call(call: SemanticCall, depth: number): string {
    const args = call.args.map((argument, index) =>
      this.expression(argument, call.argTypes[index] ?? argument.type, depth),
    );
    if (!call.builtin) {
      this.declareCallee(call);
      return `${call.signature.symbol}(${args.join(", ")})`;
    }
    if (call.callee === ARGV_LENGTH) return `${RUNTIME_NAME}_argv_count()`;
    return builtinExpression(call.callee, args);
  }

  /** A declaration of another function of this program, so the C can call it. */
  private declareCallee(call: SemanticCall): void {
    const symbol = call.signature.symbol;
    if (symbol === this.fn.symbol || this.externs.has(symbol)) return;
    const parameters = call.signature.params
      .map((param) => `${declaredType(parseType(param.type))} ${cEscape(param.name, TAKEN)}`)
      .join(", ");
    this.externs.set(
      symbol,
      `/* defined by another function of this program, and linked beside this one */\nextern ${declaredType(parseType(call.signature.returns))} ${cSymbolName(symbol)}(${parameters || "void"})${cSymbolLabel(symbol)};`,
    );
  }

  private element(buffer: string, index: SemanticValue, depth: number): string {
    return `${this.names.read(buffer)}[${this.expression(index, USIZE, depth)}]`;
  }

  /**
   * An object, allocated and filled as one value. C binds no temporary inside
   * an expression, so the object is built by a statement expression: the one
   * form that keeps an object inside the arm of a conditional it was written
   * in, which is what an object built as a value means.
   */
  private buildObject(value: SemanticValue & { k: "newObject" }): string {
    const name = this.temporary("blaze_object");
    const written = value.fields.map(
      (field) => `((${name})->${cMemberName(field.name)} = ${this.expression(field.value, null, 0)});`,
    );
    const size = `sizeof(struct ${value.layout})`;
    const allocation = this.writesEveryField(value)
      ? `${RUNTIME_NAME}_allocate_uninitialized(${size})`
      : `${RUNTIME_NAME}_object_new(${size}, _Alignof(struct ${value.layout}))`;
    return `({ struct ${value.layout}* ${name} = (struct ${value.layout}*)${allocation}; ${written.join(" ")} ${name}; })`;
  }

  /**
   * Whether an object literal writes every field its layout has, which is what
   * decides the block it is given.
   *
   * One that does is a caller of the runtime's `allocate_uninitialized`, whose
   * own note names an object literal as what it is for: every field of the
   * payload is written before any of it is read, so a block cleared first is a
   * pass over the object the program never asked for. One that leaves a field
   * out keeps the cleared block — a program is allowed to read a field it never
   * wrote, the source answers that read as a zero, and the zero is what the
   * clearing is for.
   *
   * Two things answer no on their own. A layout the function does not carry is
   * a layout the emitter cannot read, so a field it cannot see is not one it
   * can call written. And the uncleared block carries the runtime's default
   * alignment rather than the layout's own: a field is at most a pointer wide,
   * so no layout asks for more than that today, and the check is what keeps
   * that true rather than what makes it true.
   */
  private writesEveryField(value: SemanticValue & { k: "newObject" }): boolean {
    const layout = this.fn.objects[value.layout];
    if (layout === undefined || layout.align > DEFAULT_ALIGNMENT) return false;
    const written = new Set(value.fields.map((field) => field.name));
    return layout.fields.every((field) => written.has(field.name));
  }

  /** A value read as the type a use fixes it at. */
  private expression(value: SemanticValue, as: SemanticType | null, depth: number): string {
    const written = this.raw(value, depth);
    if (as === null || isTextType(value.type) || isTextType(as)) return written;
    if (isNumber(value.type) && isNumber(as)) {
      return value.type.kind === "primitive" && as.kind === "primitive" && value.type.name === as.name
        ? written
        : `(${declaredType(as)})(${written})`;
    }
    if (isReference(value.type) && isReference(as)) return `(${declaredType(as)})(${written})`;
    return written;
  }

  private raw(value: SemanticValue, depth: number): string {
    switch (value.k) {
      case "const":
        // A constant states the type it is written at, and a text one is a
        // string: the numeric literal writer leaves anything that is not a
        // float as the text it was given, so a text constant came out as a
        // bare identifier the C compiler has never heard of.
        if (isTextType(value.type)) return cStringLiteral(value.text);
        if (isWideType(value.type)) return cLiteral(value.text, "u256");
        return cLiteral(value.text, isNumber(value.type) && value.type.kind === "primitive" ? value.type.name : "f64");
      case "bool":
        return value.value ? "1" : "0";
      case "nothing":
        return "NULL";
      case "local":
        return this.names.read(value.name);
      case "text":
        return this.text(value, depth);
      case "toText": {
        const name = this.temporary("blaze_text");
        this.asText(value.of, depth, name);
        return name;
      }
      case "call":
        return this.call(value.call, depth);
      case "newObject":
        return this.buildObject(value);
      case "loadField":
        return `((struct ${value.layout}*)${this.raw(value.object, depth)})->${cMemberName(value.field)}`;
      case "length":
        return this.length(value.of, depth);
      case "element":
        return `${this.raw(value.of, depth)}[${this.expression(value.index, USIZE, depth)}]`;
      case "argv":
        return value.index === null
          ? `${RUNTIME_NAME}_argv_count()`
          : `${RUNTIME_NAME}_argv(${this.expression(value.index, USIZE, depth)})`;
      case "isNull":
        return `((${this.raw(value.operand, depth)}) ${value.negate ? "!=" : "=="} NULL)`;
      case "unary": {
        const operand = this.expression(value.operand, value.type, depth);
        if (value.op === "not") return `((${this.condition(value.operand, depth)}) == 0)`;
        // A wide complement covers every limb, which C's `~` cannot be asked for
        // over a struct, so it is the kernel's operation rather than an operator.
        if (value.op === "bitNot" && isWideType(value.type)) {
          const out = this.temporary("blaze_wide");
          const moved = this.temporary("blaze_wide");
          return (
            `({ blaze_u256 ${out}; ` +
            `blaze_u256 ${moved} = ${this.expression(value.operand, value.type, depth)}; ` +
            `${RUNTIME_NAME}_u256_not(&${out}, &${moved}); ${out}; })`
          );
        }
        if (value.op === "bitNot") return `(~${operand})`;
        // The sign binds to the operand, and the whole is parenthesised so a
        // negation of a product stays a negation of the whole product.
        return `(${value.op === "neg" ? "-" : "+"}${operand})`;
      }
      case "arith":
        return this.arith(value, depth);
      case "compare": {
        // A wide comparison walks limbs in the kernel. C compares a struct with
        // `==` only by identity and has no ordering at all, so the operator the
        // IR names has no spelling here.
        if (isWideType(value.operand)) {
          const left = this.temporary("blaze_wide");
          const right = this.temporary("blaze_wide");
          const kernel = value.op === "eq" || value.op === "ne" ? "equal" : "less";
          const test = `${RUNTIME_NAME}_u256_${kernel}(&${left}, &${right})`;
          const flip = (value.op === "ne" || value.op === "ge" || value.op === "gt") ? "!" : "";
          return (
            `({ const blaze_u256 ${left} = ${this.expression(value.left, value.operand, depth)}; ` +
            `const blaze_u256 ${right} = ${this.expression(value.right, value.operand, depth)}; ` +
            `${flip}${test}; })`
          );
        }
        if (!isTextType(value.operand)) {
          return `(${this.expression(value.left, value.operand, depth)} ${cOperator(COMPARE_OPERATORS[value.op])} ${this.expression(value.right, value.operand, depth)})`;
        }
        // Two strings are compared by what they say and not by where they are:
        // a string built at run time and one written out are two addresses that
        // can say the same thing, and the addresses compared as if the strings
        // did. An absent string is nothing, so it is equal to another absent
        // string and to no other, which is what the driver answers.
        const left = this.temporary("blaze_left");
        const right = this.temporary("blaze_right");
        const operator = cOperator(COMPARE_OPERATORS[value.op]);
        return (
          `({ const char* ${left} = ${this.raw(value.left, depth)}; ` +
          `const char* ${right} = ${this.raw(value.right, depth)}; ` +
          `${left} == NULL || ${right} == NULL ? ${left} ${operator} ${right} ` +
          `: strcmp(${left}, ${right}) ${operator} 0; })`
        );
      }
      case "logical": {
        // The left arm decides and the value is one of the arms, which is what
        // C's own `&&` and `||` are: they return the arm that answered. It is
        // written down as the test and again as the value that answers, so it
        // is bound first.
        const arm = this.temporary("blaze_arm");
        const left = this.raw(value.left, depth);
        const right = this.expression(value.right, value.type, depth);
        return (
          `({ ${declaredType(value.left.type)} ${arm} = ${left}; ` +
          `${this.truth(arm, valueKind(value.left), value.left.type)} ? ` +
          `${value.op === "and" ? right : arm} : ${value.op === "and" ? arm : right}; })`
        );
      }
      case "coalesce": {
        if (valueKind(value.left) !== "null" && valueKind(value.left) !== "reference" && !isTextType(value.left.type)) {
          return this.raw(value.left, depth);
        }
        // The left arm is the test and is what answers when it is there, so it
        // is bound first.
        const arm = this.temporary("blaze_arm");
        const left = this.raw(value.left, depth);
        return (
          `({ ${declaredType(value.left.type)} ${arm} = ${left}; ` +
          `(${arm}) == NULL ? ${this.expression(value.right, value.type, depth)} : ${arm}; })`
        );
      }
      case "select":
        return `((${this.condition(value.condition, depth)}) ? ${this.expression(value.then, value.type, depth)} : ${this.expression(value.otherwise, value.type, depth)})`;
      case "buffer":
        // A function is given an array as a pointer to its first element, so a
        // whole array is a value it is not handed one of.
        throw backendError(`${this.fn.symbol} reads an array the IR holds whole`);
    }
  }

  private arith(value: SemanticValue & { k: "arith" }, depth: number): string {
    if (isWideType(value.type)) return this.wideArith(value, depth);
    if (value.op === "concat") return this.concat(value.left, value.right, depth);
    const left = this.expression(value.left, value.type, depth);
    const right = this.expression(value.right, value.type, depth);
    switch (value.op) {
      case "pow":
        return `pow(${left}, ${right})`;
      case "min":
      case "max": {
        // Each arm answers twice, so both are bound: a value the IR calls is a
        // call that would otherwise run twice.
        const low = this.temporary("blaze_arm");
        const high = this.temporary("blaze_arm");
        const type = declaredType(value.type);
        // A whole number has no NaN and no signed zero, so the order answers
        // it. A float has both, and neither is answered by the order alone: the
        // language carries a NaN through rather than answering one of the arms
        // (`NaN > 1.0` is false in C, so the test alone answers 1.0 where the
        // source answers NaN), and a zero is answered by its sign — a maximum
        // is `+0` and a minimum is `-0` however the two zeros were written.
        if (isFloat(value.type)) {
          // The two arms of the order answer the unequal case, and the fixup is
          // the third: reached only when neither ordered test holds, which with
          // no NaN in either arm means the two are the same value. Two equal
          // values of one sign are a tie the fixup leaves alone, so a zero is
          // the only thing it has to recognise and the sign alone recognises
          // it: `+0.0 == -0.0`, so a difference of signs is a `+0` of a `-0` and
          // nothing else. The test for a zero that used to stand in front of
          // it therefore could not change the answer, and the unequal case does
          // not reach it.
          const ordered = value.op === "min" ? "<" : ">";
          const zero = value.op === "min" ? "-0.0" : "0.0";
          return (
            `({ ${type} ${low} = ${left}; ${type} ${high} = ${right}; ` +
            `isnan(${low}) || isnan(${high}) ? ${low} + ${high} : ` +
            `${low} ${ordered} ${high} ? ${low} : ${high} ${ordered} ${low} ? ${high} : ` +
            `signbit(${low}) != signbit(${high}) ? ${zero} : ${low}; })`
          );
        }
        return (
          `({ ${type} ${low} = ${left}; ${type} ${high} = ${right}; ` +
          `${low} ${value.op === "min" ? "<" : ">"} ${high} ? ${low} : ${high}; })`
        );
      }
      default:
        return `(${left} ${cOperator(ARITHMETIC_OPERATORS[value.op])} ${right})`;
    }
  }

  /**
   * A wide operation as a call into the kernel.
   *
   * C has no arithmetic over a struct, so the operator the IR names cannot be
   * written down: `a + b` over two `blaze_u256` is not a C expression the
   * compiler accepts. The kernel defines each operation as a function taking
   * pointers, which is the one form every target has, so the operands are bound
   * to names first and the call is what computes the answer. Binding them is
   * not tidiness — an operand may itself be a call, and one written into the
   * argument list would run once per mention rather than once per operation.
   *
   * The shift is the one operation whose second operand is a count rather than
   * a value of the type: a `u256` shifted by a `u256` has no meaning, and the
   * count is the machine word the language would have shifted by.
   */
  private wideArith(value: SemanticValue & { k: "arith" }, depth: number): string {
    // The result is declared before the operands rather than after them: the
    // statement expression names it in the call, and a name C reads before its
    // declaration is one it has never heard of.
    if (value.op === "shl" || value.op === "shr") {
      // The count of a shift is the number the source wrote, which is a machine
      // number and not a whole number of the width being shifted. The IR does
      // not stop one being a whole number, and asking the writer for a scalar
      // expression of a value that is one answers `(unsigned)(size_t){...}` —
      // a compound literal where an integer belongs, which does not compile. A
      // build that stops here says what is wrong; the same request answered
      // anyway is a build that fails somewhere else entirely.
      if (isWideType(value.right.type)) {
        throw new CompilerError({
          category: "SemanticIrError",
          stage: "semantic-ir",
          message: `the count of a shift by ${value.op} is a ${typeText(value.right.type)}, which is a whole number rather than the number of bits to move`,
        });
      }
      const out = this.temporary("blaze_wide");
      const moved = this.temporary("blaze_wide");
      const count = this.temporary("blaze_shift");
      return (
        `({ blaze_u256 ${out}; ` +
        `blaze_u256 ${moved} = ${this.expression(value.left, value.type, depth)}; ` +
        `const unsigned ${count} = (unsigned)${this.expression(value.right, USIZE, depth)}; ` +
        `${RUNTIME_NAME}_u256_${value.op}(&${out}, &${moved}, ${count}); ${out}; })`
      );
    }
    const out = this.temporary("blaze_wide");
    const left = this.temporary("blaze_wide");
    const right = this.temporary("blaze_wide");
    return (
      `({ blaze_u256 ${out}; ` +
      `const blaze_u256 ${left} = ${this.expression(value.left, value.type, depth)}; ` +
      `const blaze_u256 ${right} = ${this.expression(value.right, value.type, depth)}; ` +
      `${RUNTIME_NAME}_u256_${value.op}(&${out}, &${left}, &${right}); ${out}; })`
    );
  }

  /** Two texts as one, which is what `+` over text and `+=` into it are. */
  private concat(left: SemanticValue, right: SemanticValue, depth: number): string {
    return this.text(
      {
        k: "text",
        type: TEXT,
        parts: [
          { k: "value", value: left },
          { k: "value", value: right },
        ],
      },
      depth,
    );
  }

  private length(of: SemanticValue, depth: number): string {
    // A string the runtime allocated is as long as the header in front of it
    // says, which is two loads. A string the compiler wrote out is a C literal
    // with no header in front of it, and `blaze_rt_text_length` tells the two
    // apart by the magic word, falling back to a scan for the literal. Emitting
    // `strlen` here instead cost a walk of the whole string on every read, and
    // a read inside a loop walked it once per turn.
    //
    // A literal is measured here rather than at run time at all: the C string
    // written for it is a fixed run of bytes, so its length is a number the
    // emitter can write down, and a whole probe and scan become a literal in
    // the middle of the program.
    if (isTextType(of.type)) {
      const literal = literalText(of);
      // The C string ends at a NUL, so a literal with one in it is as long as
      // what is in front of it and no longer.
      if (literal !== null) return String(Buffer.byteLength(literal.split("\0", 1)[0], "utf8"));
      return `${RUNTIME_NAME}_text_length(${this.raw(of, depth)})`;
    }
    throw backendError(
      `${this.fn.symbol} reads the length of an array, which no C this compiler writes can answer`,
      "an array reaches a function as a pointer to its first element and no length arrives with it",
    );
  }

  /**
   * A text written to the output. A template is written a part at a time, which
   * is what a person reading the output would have done, and it is what the
   * output is: nothing holds the text but this statement, so joining the parts
   * into a managed string first is an allocation and a copy of a string whose
   * length every part already knows. The output is buffered by the runtime
   * either way, so a part written is not a write to the outside.
   *
   * A text that is a value rather than a template has nowhere to be written as
   * a value but the output, so it is written whole.
   */
  private printText(value: SemanticValue, depth: number): void {
    const parts = value.k === "text" ? value.parts : null;
    if (parts === null || parts.length === 0 || parts.every((part) => part.k === "text")) {
      this.write([`${pad(depth)}${RUNTIME_NAME}_print_text(${this.expression(value, TEXT, depth)});`]);
      return;
    }
    for (const part of parts) {
      if (part.k === "text") {
        this.write([
          `${pad(depth)}${RUNTIME_NAME}_print_text_n(${cStringLiteral(part.value)}, ${Buffer.byteLength(part.value, "utf8")});`,
        ]);
        continue;
      }
      const name = this.temporary("blaze_part");
      const length = this.asText(part.value, depth, name);
      this.write([`${pad(depth)}${RUNTIME_NAME}_print_text_n(${name}, ${length});`]);
    }
  }

  /**
   * A string, as one C string. Text the program wrote is a literal; a value
   * interpolated into it is written by the runtime, which is what writes a
   * number the way the source language writes one, so a number interpolated
   * into a string is formatted by the runtime and never by this backend.
   */
  private text(value: SemanticValue & { k: "text" }, depth: number): string {
    if (value.parts.length === 0) return '""';
    if (value.parts.every((part) => part.k === "text")) {
      return value.parts.map((part) => cStringLiteral(part.value)).join("");
    }
    // Every part is bound before the string is laid out, and the parts are
    // joined by the runtime rather than copied into a buffer sized here. A
    // buffer sized from the literals beside them and a fixed room for each
    // interpolated one cut the string at the end of it, silently, and counted
    // what a literal measures in UTF-16 units where the string holds UTF-8
    // bytes. Letting the runtime join them removes both: it measures every part
    // in O(1) where the part is a managed string, and it grows a block
    // geometrically, so a string built in a loop copies its bytes a linear
    // number of times rather than a quadratic one.
    const parts: string[] = value.parts.map(() => this.temporary("blaze_part"));
    const joined = this.temporary("blaze_text");
    for (const [index, part] of value.parts.entries()) {
      if (part.k === "text") this.pending.push(`const char* ${parts[index]} = ${cStringLiteral(part.value)};`);
      else this.asText(part.value, depth, parts[index]);
    }
    const lines: string[] = [];
    // The first part becomes the string the rest are appended to, and it is
    // handed over rather than copied. That is safe because the runtime appends
    // into a block of its own every time, so whatever is left behind is
    // untouched — and it was written as an optimisation the runtime could not
    // make: it appended *in place* when the block carried one reference, and a
    // text block always carries one because nothing ever retains or releases
    // one, so appending to a name a program still held wrote through to it.
    lines.push(`const char* ${joined} = ${parts[0]};`);
    for (const part of parts.slice(1)) {
      lines.push(`${joined} = ${RUNTIME_NAME}_string_append(${joined}, ${part});`);
    }
    lines.push(`${joined};`);
    // A part that is a whole number needed a buffer of its own, and that
    // declaration belongs inside this expression rather than above the
    // statement that holds it: the expression is the statement, and a buffer
    // declared outside it is not part of the value.
    const declared = this.takePending();
    return `({ ${[...declared, ...lines].join(" ")} })`;
  }

  /**
   * A value as text, bound to `name` as a NUL terminated C string, and the C
   * expression for how many bytes it is. A number is written by the runtime's
   * formatter, so it reads the way the source language writes it; a truth and
   * an absence are the words the source prints.
   *
   * The text is bound rather than returned as an expression because the length
   * is read after it, and two arguments of one call are not ordered against
   * each other in C: a value the IR calls would run once per copy, or not at
   * all, depending on which way the compiler read them.
   */
  private asText(value: SemanticValue, depth: number, name: string): string {
    // A conversion is text by its own type, so handed whole it would be read as
    // a string that arrives without a length and measured for one. What it
    // wraps is what knows how long the text is.
    let inner = value;
    while (inner.k === "toText") inner = inner.of;
    value = inner;
    if (isTextType(value.type)) {
      this.pending.push(`const char* ${name} = ${this.raw(value, depth)};`);
      return `strlen(${name})`;
    }
    if (valueKind(value) === "null") {
      this.pending.push(`const char* ${name} = "null";`);
      return "4";
    }
    if (isBoolean(value.type)) {
      const truth = this.temporary("blaze_truth");
      this.pending.push(`const bool ${truth} = ${this.raw(value, depth)};`);
      this.pending.push(`const char* ${name} = ${truth} ? "true" : "false";`);
      return `(${truth} ? 4 : 5)`;
    }
    // A reference is no number of its own. An absent one is nothing, and the
    // word for that is what the source prints; the rest are read as the address
    // the driver prints for one, because a pointer is not a double and casting
    // it to one is not C. It is bound first, since it is read twice.
    //
    // The address is written as the whole number it is rather than handed to
    // the runtime's formatter: an address on a 64 bit machine is above 2^53,
    // which is where a double stops being able to hold every integer, so the
    // formatter wrote a number that was not the address held — the low bits
    // of it were zeros by then.
    if (isReference(value.type)) {
      const pointer = this.temporary("blaze_reference");
      this.pending.push(`const void* ${pointer} = ${this.raw(value, depth)};`);
      const address = this.number(`(uintptr_t)${pointer}`, USIZE);
      this.pending.push(`const char* ${name} = ${pointer} == NULL ? "null" : ${address.text};`);
      return `(${pointer} == NULL ? 4 : ${address.length})`;
    }
    const number = this.number(this.raw(value, depth), value.type);
    this.pending.push(`const char* ${name} = ${number.text};`);
    return number.length;
  }

  /**
   * A number as text, written the way the source language writes it, and the
   * C expression for how many bytes that text is. A whole number is written as
   * the integer it is: the runtime's formatter takes a double, and a double
   * holds every `i64` only up to 2^53, so 9223372036854775807 went out as
   * 9223372036854775808 and every `u64` above 2^53 lost its last digits. A
   * float is the runtime's own.
   *
   * The length is a variable rather than an expression because both writers
   * count what they wrote as they write it: a caller that writes the number
   * out needs the count, and asking for it afterwards means measuring a buffer
   * the runtime has already been asked to measure once.
   */
  private number(read: string, type: SemanticType | null): { text: string; length: string } {
    const buffer = this.temporary("blaze_number");
    const written = this.temporary("blaze_written");
    // A wide number is four limbs and not one integer, so it is formatted by the
    // kernel that already reads one: the machine-integer path below casts it to
    // `unsigned long long`, which is a C error rather than a number, so a program
    // printing or interpolating one did not build.
    if (type !== null && isWideType(type)) {
      this.pending.push(`char ${buffer}[80];`);
      this.pending.push(`size_t ${written};`);
      // The value is bound before the kernel is handed a pointer to it, because
      // a compound literal and a call answer are rvalues and `&` of either is a C
      // error. A call that ran once per use of the value is bound for the same
      // reason the whole-number path binds it.
      const wide = this.temporary("blaze_wide_value");
      return {
        text:
          `({ blaze_u256 ${wide} = ${read}; ${written} = ${RUNTIME_NAME}_u256_format(&${wide}, 10u, ` +
          `(unsigned char*)${buffer}, sizeof ${buffer}); ${buffer}[${written}] = '\\0'; ${buffer}; })`,
        length: written,
      };
    }
    if (type !== null && isInteger(type)) {
      // A whole number is written by dividing it by ten, not by handing it to
      // snprintf: a locale-aware printf call is a dozen instructions more than
      // this loop, and it runs for every whole number a program prints or
      // interpolates.
      //
      // The digits are written by a helper this file emits, into a buffer
      // declared on the line above rather than inside the expression. That is
      // not a style choice: everything declared inside a statement expression
      // dies when it ends, so a buffer declared there and handed back out of
      // it is a dangling pointer, and the C compiler treats it as one from -O1
      // upwards. A version written as an expression printed an empty string for
      // every number too large for a double, which is the case this exists for.
      this.wholeNumbers = true;
      // The declaration carries no indentation of its own: flush adds it when
      // the line is written. The count is declared beside the buffer rather
      // than inside the expression, for the same reason the buffer is.
      this.pending.push(`char ${buffer}[24];`);
      this.pending.push(`size_t ${written};`);
      // The value is bound before it is asked anything of it, because it is
      // asked for its sign and then for its digits, and a value the IR calls is
      // a call that would otherwise run once per copy. The value is declared
      // inside the statement expression, where a temporary that dies with it
      // belongs; the buffer is the one thing that stays outside, for the reason
      // above. An unsigned value has no sign to write, and a signed one takes
      // its magnitude unsigned because the most negative i64 negates to itself
      // as a signed value and its digits would then never come out.
      const value = this.temporary("blaze_whole");
      const negative = isUnsigned(type) ? "0" : `((${value}) < 0 ? 1 : 0)`;
      const magnitude = isUnsigned(type)
        ? `(unsigned long long)(${value})`
        : `(unsigned long long)((${value}) < 0 ? 0ULL - (unsigned long long)(${value}) : (unsigned long long)(${value}))`;
      return {
        text: `({ ${declaredType(type)} ${value} = ${read}; ${written} = blaze_whole_text(${negative}, ${magnitude}, ${buffer}); ${buffer}; })`,
        length: written,
      };
    }
    this.pending.push(`char ${buffer}[64];`);
    this.pending.push(`size_t ${written};`);
    return {
      text:
        `({ ${written} = ${RUNTIME_NAME}_format_number((double)(${read}), ` +
        `(unsigned char*)${buffer}, sizeof ${buffer}); ${buffer}[${written}] = '\\0'; ${buffer}; })`,
      length: written,
    };
  }
}

export interface CompileFunctionRequest {
  /** The function as the IR holds it, already validated against its contract. */
  fn: SemanticFunction;
  contract: FunctionContract;
  target: TargetSpec;
  /** How the C compiler is asked to build, from the project's mode. */
  mode: BuildMode;
  /** Where the C the compiler wrote is kept, and where its object is built. */
  sourcePath: string;
  objectPath: string;
  /** Directories the C includes the runtime header from. */
  includeDirectories?: string[];
  /**
   * Where the assembly is written, when the assembly is what the build
   * delivers. The object is then made of that assembly rather than of the C a
   * second time, so the assembly delivered is the assembly the object was made
   * from, and the C compiler is asked once rather than twice.
   */
  assemblyPath?: string;
}

export interface CompileFunctionResult {
  sourcePath: string;
  objectPath: string;
  objectSizeBytes: number;
  /** The weight of what the build delivers: the C, or the assembly if it asked for one. */
  textSizeBytes: number;
  /** Where the assembly is, when one was asked for. */
  assemblyPath?: string;
}

/**
 * Builds the object of a function the compiler wrote itself, and the assembly
 * it made on the way there when the build delivers that.
 *
 * The C here is the compiler's own, written from an IR it validated, so there
 * is no text to trust and no subset to check it against: what is checked is
 * the contract — the object must define exactly the symbol the function is
 * called by, which is the one thing every backend owes the program it is
 * linked into.
 */
export async function compileFunctionC(request: CompileFunctionRequest): Promise<CompileFunctionResult> {
  const functionName = symbolOf(request.contract);
  const source = generateFunctionC(request.fn);
  await writeFile(request.sourcePath, source, "utf8");

  const archFlag = cTargetOptions(request.target);
  const includes = (request.includeDirectories ?? []).flatMap((directory) => ["-I", directory]);
  // `-fopenmp` is asked for only when the function has a loop the compiler
  // proved its turns independent, because it is the flag that makes the pragma
  // a team of threads rather than a line the C compiler ignores.
  const threads = threadingOptions(entryIsParallel(request.fn.entry) ? ["openmp"] : []);
  // Register allocation, instruction selection and the stack are the C
  // compiler's, which is the point of the boundary: no register, offset or
  // instruction is a model's to choose, on any target. An assembly build
  // delivers what the C compiler decided rather than deciding it again.
  //
  // One pipeline runs either way. A build that delivers the assembly asks for
  // it and assembles the object from it, where the C used to be taken through
  // the whole of the optimisation twice — once for an assembly that was
  // written and never read, and once for the object. The assembly is asked for
  // without `-flto`, because under link-time optimization a `-S` writes the
  // compiler's intermediate form rather than machine code: what the build
  // delivered was a dump of what was about to be handed to the linker, and the
  // size it reported was the size of that dump.
  if (request.assemblyPath !== undefined) {
    const stopped = run(
      "gcc",
      [
        "-std=c11",
        ...assemblyOptions(request.mode, request.contract.optimize.primary),
        "-S",
        ...threads,
        ...archFlag,
        ...includes,
        "-o",
        request.assemblyPath,
        request.sourcePath,
      ],
      { timeoutMs: 120_000 },
    );
    if (stopped.spawnError !== undefined) {
      throw new CompilerError({
        category: "TargetError",
        stage: "compile",
        message: "the C compiler is not available",
        detail: stopped.spawnError,
      });
    }
    if (stopped.code !== 0) {
      throw new CompilerError({
        category: "LinkError",
        stage: "compile",
        message: `the C compiler could not stop at assembly for ${functionName}`,
        detail: `${request.sourcePath}\n${stopped.stderr.trim()}`,
      });
    }
    // The object is the assembly assembled, so the object and the delivered
    // assembly are one compilation rather than two that happen to agree.
    const assembled = run("as", ["--64", ...archOptions(request.target), "-o", request.objectPath, request.assemblyPath], {
      timeoutMs: 120_000,
    });
    if (assembled.spawnError !== undefined) {
      throw new CompilerError({
        category: "TargetError",
        stage: "compile",
        message: "the GNU assembler is not available",
        detail: assembled.spawnError,
      });
    }
    if (assembled.code !== 0) {
      throw new CompilerError({
        category: "LinkError",
        stage: "compile",
        message: `the assembler could not build the object of ${functionName}`,
        detail: `${request.assemblyPath}\n${assembled.stderr.trim()}`,
      });
    }
  } else {
    const compiled = run(
      "gcc",
      [
        "-std=c11",
        ...loweringOptions(request.mode, request.contract.optimize.primary),
        "-c",
        ...threads,
        ...archFlag,
        ...includes,
        "-o",
        request.objectPath,
        request.sourcePath,
      ],
      { timeoutMs: 120_000 },
    );
    if (compiled.spawnError !== undefined) {
      throw new CompilerError({
        category: "TargetError",
        stage: "compile",
        message: "the C compiler is not available",
        detail: compiled.spawnError,
      });
    }
    if (compiled.code !== 0) {
      throw new CompilerError({
        category: "LinkError",
        stage: "compile",
        message: `the C compiler rejected the IR of ${functionName}`,
        detail: `${request.sourcePath}\n${compiled.stderr.trim()}`,
      });
    }
  }

  const info = inspectObject(request.objectPath, functionName);
  if (info.defined.length !== 1 || info.defined[0] !== functionName) {
    throw backendError(
      `the C of ${functionName} defines [${info.defined.join(", ")}] instead of only "${functionName}"`,
      `the object must define exactly the symbol the program calls: ${declaredType(parseType(request.contract.function.returns))} ${functionName}(...)`,
    );
  }

  const delivered = request.assemblyPath ?? request.sourcePath;
  return {
    sourcePath: request.sourcePath,
    objectPath: request.objectPath,
    objectSizeBytes: (await stat(request.objectPath)).size,
    textSizeBytes: (await stat(delivered)).size,
    ...(request.assemblyPath === undefined ? {} : { assemblyPath: request.assemblyPath }),
  };
}


/**
 * Lowering a function's semantic IR to C.
 *
 * This is the half of the boundary the model does not work: a build asks for
 * the IR of a function, validates it against the contract, and lowers it here.
 * Register allocation, instruction selection, the calling convention and the
 * stack are then the C compiler's, so no register, offset or instruction
 * reaches the model and none is written here either.
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
import type { FunctionContract, TargetSpec } from "../core/types.ts";
import { parseType } from "../semantics/contract.ts";
import { ARGV_LENGTH } from "../semantics/builtins.ts";
import {
  elementTypeOf,
  isBoolean,
  isNumber,
  isReference,
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
} from "../core/semantic-ir.ts";
import { cDeclarationType, cMemberName, cObjectDeclarations } from "./linker.ts";
import { C_KEYWORDS, cEscape, cHeaderNames, cLiteral, cMacroNames, cOperator, cStringLiteral } from "./c-names.ts";
import { NameScope } from "./names.ts";
import { RUNTIME_NAME, RUNTIME_SYMBOLS } from "../runtime/abi.ts";

const NUMBER: SemanticType = { kind: "primitive", name: "f64" };
const USIZE: SemanticType = { kind: "primitive", name: "usize" };
const TEXT = { kind: "text" } as const;

/** The C a value of this type is declared as. A string is a C string. */
function declaredType(type: SemanticType | null): string {
  if (type === null || isTextType(type)) return "const char*";
  return cDeclarationType(type);
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
  /** Every function of the program this one calls, as its C declaration. */
  private readonly externs = new Map<string, string>();
  /** Lines that must come before the statement being written. */
  private pending: string[] = [];
  private depth = 1;
  private temporaries = 0;

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
      "#include <string.h>",
      "",
      `#include "${RUNTIME_NAME}.h"`,
      ...(layouts === "" ? [] : ["", layouts]),
      ...(this.externs.size === 0 ? [] : ["", ...this.externs.values()]),
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

  private write(lines: readonly string[]): void {
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

  /** Writes the temporaries a value needed, before the line that reads them. */
  private flush(): void {
    if (this.pending.length === 0) return;
    this.write(this.pending.map((line) => `${pad(this.depth)}${line}`));
    this.pending = [];
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
        this.write([`${pad(depth)}${RUNTIME_NAME}_print_text(${this.expression(statement.value, TEXT, depth)});`]);
        return;
      case "printNumber":
        this.write([`${pad(depth)}${RUNTIME_NAME}_print_number(${this.expression(statement.value, NUMBER, depth)});`]);
        return;
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
        const variable = this.names.declare(loop.variable, type);
        const bound = `${COMPARE_OPERATORS[loop.down ? "gt" : "lt"]}${loop.inclusive ? "=" : ""}`;
        // What the loop counts over is read once. The `for` reads its bound on
        // every turn and adds its step on every turn, so a bound or a step the
        // IR calls is a call the loop makes once per turn.
        const from = this.temporary("blaze_from");
        const to = this.temporary("blaze_to");
        const given = loop.step;
        const step = given === null ? null : this.temporary("blaze_step");
        this.write([`${pad(depth)}${written} ${from} = ${this.expression(loop.from, type, depth)};`]);
        this.write([`${pad(depth)}${written} ${to} = ${this.expression(loop.to, type, depth)};`]);
        if (given !== null && step !== null) {
          this.write([`${pad(depth)}${written} ${step} = ${this.expression(given, type, depth)};`]);
        }
        // The step is the signed amount the index moves by, so a loop that
        // counts down carries a negative one and adds it like any other:
        // subtracting it from a step of -1 moves the index the other way, and
        // the loop never ends.
        const move = step === null ? `${variable}${loop.down ? "--" : "++"}` : `${variable} += ${step}`;
        this.write([`${pad(depth)}for (${written} ${variable} = ${from}; ${variable} ${bound} ${to}; ${move}) {`]);
        this.block(loop.body, depth + 1);
        this.write([`${pad(depth)}}`]);
        break;
      }
      case "each": {
        const index = this.names.declare(loop.index, USIZE);
        const element = this.names.declare(loop.element, loop.elementType);
        // The length is read once, for the same reason a counted loop's bound
        // is: the walk reads it on every turn.
        const length = this.temporary("blaze_length");
        this.write([`${pad(depth)}size_t ${length} = ${walk as string};`]);
        this.write([
          `${pad(depth)}for (size_t ${index} = 0; ${index} < ${length}; ${index}++) {`,
          `${pad(depth + 1)}${declaredType(loop.elementType)} ${element} = ${buffer as string}[${index}];`,
        ]);
        this.block(loop.body, depth + 1);
        this.write([`${pad(depth)}}`]);
        break;
      }
    }
    this.loops.pop();
    this.names.leave();
  }

  /** Where a block ends: the value it hands back, or where it jumps to. */
  private terminator(block: SemanticBlock, depth: number): void {
    const terminator = block.terminator;
    if (terminator.k === "next") return;
    if (terminator.k === "return") {
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
    this.write([`${pad(depth)}${terminator.target === open.header ? "continue;" : "break;"}`]);
  }

  /* ---------------------------------------------------------------------- */
  /* Values                                                                  */
  /* ---------------------------------------------------------------------- */

  private condition(value: SemanticValue, depth: number): string {
    return this.truth(this.expression(value, null, depth), valueKind(value));
  }

  /** Whether C text already written answers as a truth. */
  private truth(text: string, kind: ValueKind): string {
    switch (kind) {
      case "text":
        return `((${text})[0] != '\\0')`;
      case "reference":
        return `((${text}) != NULL)`;
      case "boolean":
        return `(${text})`;
      default:
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
      `/* defined by another function of this program, and linked beside this one */\nextern ${declaredType(parseType(call.signature.returns))} ${symbol}(${parameters || "void"});`,
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
    return (
      `({ struct ${value.layout}* ${name} = (struct ${value.layout}*)${RUNTIME_NAME}_object_new(` +
      `sizeof(struct ${value.layout}), _Alignof(struct ${value.layout})); ${written.join(" ")} ${name}; })`
    );
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
        return cLiteral(value.text, isNumber(value.type) && value.type.kind === "primitive" ? value.type.name : "f64");
      case "bool":
        return value.value ? "1" : "0";
      case "nothing":
        return "NULL";
      case "local":
        return this.names.read(value.name);
      case "text":
        return this.text(value, depth);
      case "toText":
        return this.asText(value.of, depth);
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
        if (value.op === "bitNot") return `(~${operand})`;
        // The sign binds to the operand, and the whole is parenthesised so a
        // negation of a product stays a negation of the whole product.
        return `(${value.op === "neg" ? "-" : "+"}${operand})`;
      }
      case "arith":
        return this.arith(value, depth);
      case "compare": {
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
          `${this.truth(arm, valueKind(value.left))} ? ` +
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
        return (
          `({ ${type} ${low} = ${left}; ${type} ${high} = ${right}; ` +
          `${low} ${value.op === "min" ? "<" : ">"} ${high} ? ${low} : ${high}; })`
        );
      }
      default:
        return `(${left} ${cOperator(ARITHMETIC_OPERATORS[value.op])} ${right})`;
    }
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
    // A string is as long as its bytes. The runtime counts a string it owns
    // from the header it installed before it, which a string written out in the
    // source does not have: it is a C literal, and the header before it is
    // whatever `.rodata` holds there. Both are NUL terminated, so both are as
    // long as the C library says they are.
    if (isTextType(of.type)) return `strlen(${this.raw(of, depth)})`;
    throw backendError(
      `${this.fn.symbol} reads the length of an array, which no C this compiler writes can answer`,
      "an array reaches a function as a pointer to its first element and no length arrives with it",
    );
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
    // Every part is bound and measured before the string is laid out, so the
    // buffer that holds it is exactly as long as the parts are. A buffer sized
    // from the literals beside them and a fixed room for each interpolated one
    // cut the string at the end of it, silently, and counted what a literal
    // measures in UTF-16 units where the string holds UTF-8 bytes.
    const parts: { text: string; length: string }[] = value.parts.map(() => ({
      text: this.temporary("blaze_part"),
      length: this.temporary("blaze_part_length"),
    }));
    // The parts are laid out in a buffer that is the string itself: it is the
    // runtime's own, because its length is only known here, at run time, and a
    // runtime allocation carrying its bytes and its terminator is what a string
    // is. It is a statement expression for the same reason an object is: C
    // binds no temporary inside an expression.
    const buffer = this.temporary("blaze_text");
    const filled = this.temporary("blaze_filled");
    const total = this.temporary("blaze_text_length");
    const lines = value.parts.flatMap((part, index) => {
      const { text, length } = parts[index];
      const written = part.k === "text" ? cStringLiteral(part.value) : this.asText(part.value, depth);
      return [
        `const char* ${text} = ${written};`,
        `size_t ${length} = ${text} == NULL ? 0 : strlen(${text});`,
      ];
    });
    lines.push(`size_t ${total} = ${parts.map((part) => part.length).join(" + ")};`);
    lines.push(`char* ${buffer} = (char*)${RUNTIME_NAME}_allocate(${total} + 1);`);
    lines.push(`size_t ${filled} = 0;`);
    for (const part of parts) {
      lines.push(
        `if (${part.length} != 0) memcpy(${buffer} + ${filled}, ${part.text}, ${part.length}); ${filled} += ${part.length};`,
      );
    }
    lines.push(`${buffer}[${filled}] = '\\0';`);
    lines.push(`${buffer};`);
    return `({ ${lines.join(" ")} })`;
  }

  /**
   * A value as text, as a NUL terminated C string. A number is written by the
   * runtime's formatter, so it reads the way the source language writes it; a
   * truth and an absence are the words the source prints.
   */
  private asText(value: SemanticValue, depth: number): string {
    if (isTextType(value.type)) return this.raw(value, depth);
    if (valueKind(value) === "null") return '"null"';
    if (isBoolean(value.type)) return `(${this.raw(value, depth)} ? "true" : "false")`;
    // A reference is no number of its own. An absent one is nothing, and the
    // word for that is what the source prints; the rest are read as the address
    // the driver prints for one, because a pointer is not a double and casting
    // it to one is not C. It is bound first, since it is read twice.
    if (isReference(value.type)) {
      const pointer = this.temporary("blaze_reference");
      const read = this.raw(value, depth);
      return (
        `({ const void* ${pointer} = ${read}; ` +
        `${pointer} == NULL ? "null" : ${this.number(`(double)(uintptr_t)${pointer}`)}; })`
      );
    }
    return this.number(this.raw(value, depth));
  }

  /** A number as text, written by the runtime the way the source writes one. */
  private number(read: string): string {
    const buffer = this.temporary("blaze_number");
    const written = this.temporary("blaze_written");
    return (
      `({ char ${buffer}[64]; size_t ${written} = ${RUNTIME_NAME}_format_number((double)(${read}), ` +
      `(unsigned char*)${buffer}, sizeof ${buffer}); ${buffer}[${written}] = '\\0'; ${buffer}; })`
    );
  }
}

export interface CompileFunctionRequest {
  /** The function as the IR holds it, already validated against its contract. */
  fn: SemanticFunction;
  contract: FunctionContract;
  target: TargetSpec;
  /** Where the C the compiler wrote is kept, and where its object is built. */
  sourcePath: string;
  objectPath: string;
  /** Directories the C includes the runtime header from. */
  includeDirectories?: string[];
  /**
   * Where the assembly is written, when the assembly is what the build
   * delivers. The C compiler is asked for it as well as for the object, so
   * the assembly delivered is the assembly the object was made from.
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
 * The C a model supplies is checked against a subset before the compiler sees
 * it, because it is text the model wrote and nothing else about it can be
 * trusted. The C here is the compiler's own, so there is no subset to check:
 * what is checked is the contract — the object must define exactly the symbol
 * the function is called by, which is the one thing every backend owes the
 * program it is linked into.
 */
export async function compileFunctionC(request: CompileFunctionRequest): Promise<CompileFunctionResult> {
  const functionName = symbolOf(request.contract);
  const source = generateFunctionC(request.fn);
  await writeFile(request.sourcePath, source, "utf8");

  const archFlag = request.target.cpu === "" ? [] : [`-march=${request.target.cpu}`];
  const includes = (request.includeDirectories ?? []).flatMap((directory) => ["-I", directory]);
  // Register allocation, instruction selection and the stack are the C
  // compiler's, which is the point of the boundary: no register, offset or
  // instruction is a model's to choose, on any target. An assembly build
  // delivers what the C compiler decided rather than deciding it again.
  if (request.assemblyPath !== undefined) {
    const stopped = run(
      "gcc",
      ["-std=c11", "-O2", "-fno-lto", "-S", ...archFlag, ...includes, "-o", request.assemblyPath, request.sourcePath],
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
  }
  const compiled = run(
    "gcc",
    ["-std=c11", "-O2", "-fno-lto", "-c", ...archFlag, ...includes, "-o", request.objectPath, request.sourcePath],
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


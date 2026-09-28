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
} from "../core/semantic-ir.ts";
import { cDeclarationType, cObjectDeclarations } from "./linker.ts";
import { C_KEYWORDS, cEscape, cHeaderNames, cLiteral, cMacroNames, cOperator } from "./c-names.ts";
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

/** What a generated C function already occupies: the C it compiles against. */
const TAKEN: Record<string, true> = {
  ...C_KEYWORDS,
  ...cHeaderNames(),
  ...cMacroNames(),
  ...RUNTIME_SYMBOLS,
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
 * A string, written as a C string literal with everything in it escaped. The
 * runtime's own `string_new` is what builds a string at run time; a literal is
 * for text the program wrote.
 */
function cTextLiteral(text: string): string {
  const escaped = text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "\\r")
    .replace(/\0/g, "\\0");
  return `"${escaped}"`;
}

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
      return `({ double blaze_rounded = floor((${args[0]}) + 0.5); (blaze_rounded == 0.0 && (${args[0]}) < 0.0) ? -0.0 : blaze_rounded; })`;
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
    return `${prefix}_${this.temporaries}`;
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
        this.write([
          `${pad(depth)}${this.names.read(statement.name)} ${statement.op} ${this.expression(statement.value, type, depth)};`,
        ]);
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
          `${pad(depth)}((struct ${statement.layout}*)${this.expression(statement.object, null, depth)})->${statement.field} = ${this.expression(statement.value, null, depth)};`,
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
        const variable = this.names.declare(loop.variable, type);
        const bound = `${COMPARE_OPERATORS[loop.down ? "gt" : "lt"]}${loop.inclusive ? "=" : ""}`;
        // The step is the signed amount the index moves by, so a loop that
        // counts down carries a negative one and adds it like any other:
        // subtracting it from a step of -1 moves the index the other way, and
        // the loop never ends.
        const step =
          loop.step === null
            ? `${variable}${loop.down ? "--" : "++"}`
            : `${variable} += ${this.expression(loop.step, type, depth)}`;
        this.write([
          `${pad(depth)}for (${declaredType(type)} ${variable} = ${this.expression(loop.from, type, depth)}; ${variable} ${bound} ${this.expression(loop.to, type, depth)}; ${step}) {`,
        ]);
        this.block(loop.body, depth + 1);
        this.write([`${pad(depth)}}`]);
        break;
      }
      case "each": {
        const index = this.names.declare(loop.index, USIZE);
        const element = this.names.declare(loop.element, loop.elementType);
        this.write([
          `${pad(depth)}for (size_t ${index} = 0; ${index} < ${this.expression(loop.length, USIZE, depth)}; ${index}++) {`,
          `${pad(depth + 1)}${declaredType(loop.elementType)} ${element} = ${this.names.read(loop.of)}[${index}];`,
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
    const text = this.expression(value, null, depth);
    switch (valueKind(value)) {
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
      .map((param) => `${declaredType(parseType(param.type))} ${param.name}`)
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
      (field) => `((${name})->${field.name} = ${this.expression(field.value, null, 0)});`,
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
        return `((struct ${value.layout}*)${this.raw(value.object, depth)})->${value.field}`;
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
      case "compare":
        return `(${this.expression(value.left, value.operand, depth)} ${cOperator(COMPARE_OPERATORS[value.op])} ${this.expression(value.right, value.operand, depth)})`;
      case "logical": {
        const left = this.expression(value.left, value.type, depth);
        const right = this.expression(value.right, value.type, depth);
        // The left arm decides and the value is one of the arms, which is what
        // C's own `&&` and `||` are: they return the arm that answered.
        return value.op === "and"
          ? `((${this.condition(value.left, depth)}) ? ${right} : ${left})`
          : `((${this.condition(value.left, depth)}) ? ${left} : ${right})`;
      }
      case "coalesce": {
        const left = this.raw(value.left, depth);
        if (valueKind(value.left) !== "null" && valueKind(value.left) !== "reference" && !isTextType(value.left.type)) {
          return left;
        }
        return `((${left}) == NULL ? ${this.expression(value.right, value.type, depth)} : ${left})`;
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
    if (value.op === "concat") {
      return this.text(
        {
          k: "text",
          type: TEXT,
          parts: [
            { k: "value", value: value.left },
            { k: "value", value: value.right },
          ],
        },
        depth,
      );
    }
    const left = this.expression(value.left, value.type, depth);
    const right = this.expression(value.right, value.type, depth);
    switch (value.op) {
      case "pow":
        return `pow(${left}, ${right})`;
      case "min":
        return `(${left} < ${right} ? ${left} : ${right})`;
      case "max":
        return `(${left} > ${right} ? ${left} : ${right})`;
      default:
        return `(${left} ${cOperator(ARITHMETIC_OPERATORS[value.op])} ${right})`;
    }
  }

  private length(of: SemanticValue, depth: number): string {
    if (isTextType(of.type)) return `${RUNTIME_NAME}_string_length(${this.raw(of, depth)})`;
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
      return value.parts.map((part) => cTextLiteral(part.value)).join("");
    }
    // The buffer holds the parts that are written down, and the compiler knows
    // how long each of them is; a value interpolated beside them is bounded by
    // the room left. Both copies stop at the end of it, because a copy that did
    // not wrote past the end of a buffer on the stack.
    const written = value.parts.filter((part) => part.k === "text");
    const room = Math.max(64, written.reduce((total, part) => total + part.value.length, 0) + 256 * (value.parts.length - written.length));
    const buffer = this.temporary("blaze_text");
    const filled = this.temporary("blaze_filled");
    // The parts are laid out in a buffer and handed to the runtime, which is
    // what owns a string. It is a statement expression for the same reason an
    // object is: C binds no temporary inside an expression.
    const lines = [`char ${buffer}[${room}];`, `size_t ${filled} = 0;`];
    for (const part of value.parts) {
      if (part.k === "text") {
        lines.push(
          `for (const char* blaze_c = ${cTextLiteral(part.value)}; *blaze_c != '\\0' && ${filled} < ${room - 1}; ++blaze_c) ${buffer}[${filled}++] = *blaze_c;`,
        );
        continue;
      }
      const length = this.temporary("blaze_written");
      const interpolated = this.asText(part.value, depth);
      lines.push(
        `int ${length} = (int)strlen(${interpolated}); for (int blaze_i = 0; blaze_i < ${length} && ${filled} < ${room - 1}; ++blaze_i) ${buffer}[${filled}++] = ${interpolated}[blaze_i];`,
      );
    }
    lines.push(`${buffer}[${filled}] = '\\0';`);
    lines.push(`${RUNTIME_NAME}_string_new((const unsigned char*)${buffer}, ${filled});`);
    return `({ ${lines.join(" ")} })`;
  }

  /**
   * A value as text, as a NUL terminated C string the runtime owns. A number is
   * written by the runtime's formatter, so it reads the way the source language
   * writes it; a truth and an absence are the words the source prints.
   */
  private asText(value: SemanticValue, depth: number): string {
    if (isTextType(value.type)) return this.raw(value, depth);
    if (valueKind(value) === "null") return '"null"';
    if (isBoolean(value.type)) return `(${this.raw(value, depth)} ? "true" : "false")`;
    const buffer = this.temporary("blaze_number");
    const written = this.temporary("blaze_written");
    const read = this.raw(value, depth);
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


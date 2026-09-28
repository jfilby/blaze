/**
 * The semantic view of a function a model reads.
 *
 * The compiler resolves a function to its semantic IR and lowers that to the
 * target, and the IR is written for the compiler: it names its blocks, it lists
 * what each block owns so the lowering can free it on the way out, it marks
 * every statement with the source line a diagnostic points at, and it writes
 * every value as the operation and the type that produced it. None of that is
 * what a code generator has to know, and a model handed it spends the request
 * working out which part of it is the function.
 *
 * This is the view that stands in for it. It is written from the same resolved
 * IR, so every type and every piece of control flow in it is the one the
 * compiler resolved, and it reads the way the source was written: a name bound
 * to the type it is read as, a condition that reads as a condition, a loop that
 * reads as a loop. What it leaves out is what the compiler needs in order to
 * lower a function and a model has no use for: block names, what a block owns,
 * source lines, and who owns what a call hands back.
 *
 * Nothing here is a target. The same view is what a C, an assembly, a
 * WebAssembly and an IR candidate is written from, and the target and the
 * output language decide what any of them emits.
 */

import { CompilerError } from "../core/errors.ts";
import {
  type ArithOp,
  type CompareOp,
  type SemanticBlock,
  type SemanticFunction,
  type SemanticLoop,
  type SemanticStatement,
  type SemanticTerminator,
  type SemanticValue,
  type UnaryOp,
  slotType,
  typeText,
} from "../core/semantic-ir.ts";

/**
 * How the view is written, stated once for the whole prompt. A model that does
 * not know what `len(x)` or `text(x)` is has to guess at it, and a guess is
 * spent as many tokens as the definition would have been.
 */
export const OUTLINE_NOTATION: readonly string[] = [
  "  x[i]            the i-th element of a buffer, read or written",
  "  x.field         a field of an object",
  "  new Layout { }  a new object of that layout, with its fields written in",
  "  len(x)          how long a buffer is",
  "  text(x)         a value written out as text",
  "  argv(i)         command line argument i, of which there are argv.length",
  "  <>              two pieces of text joined into one",
  "  bit_and(a, b)   bit_or(a, b) and bit_xor(a, b) are the bitwise three",
  "  min(a, b)       the smaller of two numbers, or max(a, b) the larger",
  "  x is null       whether a reference is null, and x is not null the other way",
  "  c ? a : b       a or b, whichever c chooses",
  "  let mutable x   a name the body may change; a let without the word is fixed",
  "  print_text      print text; print_number prints a number; print_newline ends the line",
  "  raise           stop, with a message",
  "  name: TYPE      what a name is read as. A number with no type written after it is a",
  "                  double, and one written as 0:i32 is a whole number, which is the one",
  "                  thing about a number that a bare 0 does not already say",
];

/** One level of body indentation. */
const INDENT = "  ";

/** The operators the IR computes with, as the source language writes them. */
const ARITH_TEXT: Record<ArithOp, string> = {
  add: "+",
  sub: "-",
  mul: "*",
  div: "/",
  mod: "%",
  pow: "**",
  // These two take a name as well as operands, so they cannot be written
  // between their operands without reading as something else.
  min: "min",
  max: "max",
  shl: "<<",
  shr: ">>",
  // Bitwise, and not the `&&` and `||` of a logical value below.
  and: "bit_and",
  or: "bit_or",
  xor: "bit_xor",
  concat: "<>",
};

const COMPARE_TEXT: Record<CompareOp, string> = {
  eq: "==",
  ne: "!=",
  lt: "<",
  le: "<=",
  gt: ">",
  ge: ">=",
};

const UNARY_TEXT: Record<UnaryOp, string> = { neg: "-", pos: "+", not: "!", bitNot: "~" };

/**
 * Whether a value needs a pair of brackets of its own inside another operator.
 * What is already delimited does not: a call, a construction, and the reading
 * of an element, a field or a length are all bracketed by what they are
 * called. The operators are not, so the tree the compiler resolved is the
 * tree that is read, whatever precedence the spelling would otherwise bind.
 */
function needsBrackets(value: SemanticValue): boolean {
  // `min(a, b)` and `max(a, b)` carry brackets of their own.
  if (value.k === "arith") return value.op !== "min" && value.op !== "max";
  switch (value.k) {
    case "compare":
    case "logical":
    case "coalesce":
    case "select":
    case "unary":
    case "isNull":
    // A string is the sum of its parts, and a sum inside a sum is a sum.
    case "text":
      return true;
    default:
      return false;
  }
}

/**
 * One operand of an operator. Every operand goes through here, so an operand
 * that needs brackets is bracketed the same way everywhere it appears.
 */
function operand(value: SemanticValue): string {
  const written = valueText(value);
  return needsBrackets(value) ? `(${written})` : written;
}

/** The fields of an object, written inside the braces of its construction. */
function fieldList(fields: readonly { name: string; value: SemanticValue }[]): string {
  if (fields.length === 0) return "";
  return ` ${fields.map((field) => `${field.name}: ${valueText(field.value)}`).join(", ")} `;
}

/** A for-of loop that walks a whole buffer, which is every one of them. */
function walksWholeBuffer(loop: Extract<SemanticLoop, { kind: "each" }>): boolean {
  return loop.length.k === "length" && loop.length.of.k === "local" && loop.length.of.name === loop.of;
}

/** One value, as the source language would have written it. */
function valueText(value: SemanticValue): string {
  switch (value.k) {
    case "const": {
      // A number is a double until a use fixes it to something else, so the
      // type is written on the ones that are not, and on no other number.
      const name = typeText(value.type);
      return name === "f64" ? value.text : `${value.text}:${name}`;
    }
    case "text":
      return value.parts
        .map((part) => {
          if (part.k === "text") return JSON.stringify(part.value);
          // The join is what writes a part as text, so a value that carries
          // nothing but the conversion contributes the value and not the rest.
          return operand(part.value.k === "toText" ? part.value.of : part.value);
        })
        .join(" <> ");
    case "bool":
      return value.value ? "true" : "false";
    case "nothing":
      return "null";
    case "local":
      return value.name;
    case "length":
      return `len(${valueText(value.of)})`;
    case "element":
      return `${valueText(value.of)}[${valueText(value.index)}]`;
    case "buffer":
      return `[${value.values.map(valueText).join(", ")}]`;
    case "newObject":
      return `new ${value.layout} {${fieldList(value.fields)}}`;
    case "loadField":
      return `${valueText(value.object)}.${value.field}`;
    case "call":
      return `${value.call.callee}(${value.call.args.map(valueText).join(", ")})`;
    case "arith": {
      const operator = ARITH_TEXT[value.op];
      return operator === "min" || operator === "max"
        ? `${operator}(${operand(value.left)}, ${operand(value.right)})`
        : `${operand(value.left)} ${operator} ${operand(value.right)}`;
    }
    case "compare":
      return `${operand(value.left)} ${COMPARE_TEXT[value.op]} ${operand(value.right)}`;
    case "logical":
      return `${operand(value.left)} ${value.op === "and" ? "&&" : "||"} ${operand(value.right)}`;
    case "coalesce":
      return `${operand(value.left)} ?? ${operand(value.right)}`;
    case "select":
      return `${operand(value.condition)} ? ${operand(value.then)} : ${operand(value.otherwise)}`;
    case "unary":
      return `${UNARY_TEXT[value.op]}${operand(value.operand)}`;
    case "isNull":
      return `${operand(value.operand)} is ${value.negate ? "not " : ""}null`;
    case "toText":
      return `text(${valueText(value.of)})`;
    case "argv":
      return value.index === null ? "argv.length" : `argv(${valueText(value.index)})`;
  }
}

/** How a block ends, which is the only way out of it the IR has. */
function terminatorLines(
  terminator: SemanticTerminator,
  depth: number,
  loops: readonly SemanticLoop[],
): string[] {
  if (terminator.k === "next") return [];
  if (terminator.k === "return") {
    const here = INDENT.repeat(depth);
    return [`${here}return${terminator.value === null ? "" : ` ${valueText(terminator.value)}`}`];
  }
  // A jump names one of the two ends of a loop the block sits in. The
  // innermost one is the only one it can name: a break does not cross a loop.
  const loop = loops.findLast(
    (open) => open.exit === terminator.target || open.header === terminator.target,
  );
  if (loop === undefined) {
    throw new CompilerError({
      category: "SemanticIrError",
      stage: "semantic-ir",
      message: `a jump to "${terminator.target}" leaves no loop it is a break or a continue of`,
    });
  }
  return [`${INDENT.repeat(depth)}${loop.exit === terminator.target ? "break" : "continue"}`];
}

/** The statements of a block, and the way the block ends. */
function blockLines(block: SemanticBlock, depth: number, loops: readonly SemanticLoop[]): string[] {
  return [
    ...block.statements.flatMap((statement) => statementLines(statement, depth, loops)),
    ...terminatorLines(block.terminator, depth, loops),
  ];
}

/** A loop as the source wrote it, with the loop it opens carried into its body. */
function loopLines(loop: SemanticLoop, depth: number, loops: readonly SemanticLoop[]): string[] {
  const here = INDENT.repeat(depth);
  const body = blockLines(loop.body, depth + 1, [...loops, loop]);
  switch (loop.kind) {
    case "while":
      return [`${here}while ${valueText(loop.condition)}:`, ...body];
    // The body of a do-while runs before the condition is first tested, which
    // is the one thing about it the spelling has to carry.
    case "doWhile":
      return [`${here}do while ${valueText(loop.condition)}:`, ...body];
    case "counted": {
      const bound = loop.down ? (loop.inclusive ? ">=" : ">") : loop.inclusive ? "<=" : "<";
      const step = loop.step === null ? "1" : valueText(loop.step);
      return [
        `${here}for (${loop.variable}: ${typeText(loop.type)} = ${valueText(loop.from)}; ${loop.variable} ${bound} ${valueText(loop.to)}; ${loop.variable} ${loop.down ? "-=" : "+="} ${step}):`,
        ...body,
      ];
    }
    case "each":
      return [
        `${here}for ${loop.element}: ${typeText(loop.elementType)} of ${loop.of}${walksWholeBuffer(loop) ? "" : ` up to ${valueText(loop.length)}`}:`,
        ...body,
      ];
  }
}

/** One statement, and the blocks under it where it owns any. */
function statementLines(
  statement: SemanticStatement,
  depth: number,
  loops: readonly SemanticLoop[],
): string[] {
  const here = INDENT.repeat(depth);
  switch (statement.k) {
    case "let":
      return [
        `${here}let ${statement.slot.mutable ? "mutable " : ""}${statement.slot.name}: ${typeText(slotType(statement.slot))} = ${valueText(statement.value)}`,
      ];
    case "set":
      return [`${here}${statement.name} ${statement.op} ${valueText(statement.value)}`];
    case "setElement":
      return [
        `${here}${statement.buffer}[${valueText(statement.index)}] ${statement.op} ${valueText(statement.value)}`,
      ];
    case "step":
      return [
        `${here}${statement.prefix ? `${statement.op}${statement.name}` : `${statement.name}${statement.op}`}`,
      ];
    case "if": {
      const lines = [
        `${here}if ${valueText(statement.condition)}:`,
        ...blockLines(statement.then, depth + 1, loops),
      ];
      return statement.otherwise === null
        ? lines
        : [...lines, `${here}else:`, ...blockLines(statement.otherwise, depth + 1, loops)];
    }
    case "loop":
      return loopLines(statement.loop, depth, loops);
    // A block of its own: the names it declares stop meaning past its end.
    case "block":
      return [`${here}{`, ...blockLines(statement.body, depth + 1, loops), `${here}}`];
    case "printText":
      return [`${here}print_text ${valueText(statement.value)}`];
    case "printNumber":
      return [`${here}print_number ${valueText(statement.value)}`];
    case "printNewline":
      return [`${here}print_newline`];
    case "retain":
      return [`${here}retain ${valueText(statement.value)}`];
    case "call":
      return [`${here}${statement.call.callee}(${statement.call.args.map(valueText).join(", ")})`];
    case "raise":
      return [`${here}raise ${valueText(statement.message)}`];
    case "storeField":
      return [
        `${here}${valueText(statement.object)}.${statement.field} = ${valueText(statement.value)}`,
      ];
  }
}

/**
 * The whole of what a function computes, as a model reads it: its signature,
 * the conditions it is held to, and its body with every value in the type the
 * compiler resolved it to.
 */
export function functionOutline(fn: SemanticFunction): string {
  const parameters = fn.params
    .map((param) => `${param.name}: ${typeText(slotType(param))}`)
    .join(", ");
  const header = [
    `function ${fn.name}(${parameters}) -> ${typeText(fn.returns)}`,
    ...fn.requires.map((requirement) => `requires ${JSON.stringify(requirement)}`),
    ...fn.ensures.map((condition) => `ensures ${JSON.stringify(condition)}`),
  ];
  const body = blockLines(fn.entry, 0, []);
  if (body.length === 0) return [...header, "computes nothing"].join("\n");
  return [...header, "body:", ...body.map((line) => INDENT + line)].join("\n");
}

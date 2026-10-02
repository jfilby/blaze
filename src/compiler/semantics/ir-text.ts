/**
 * The semantic IR as text: what a person reads and a model writes.
 *
 * The IR is the whole of what a program does, so its text has to be the whole
 * of it too: every value names the operation and the type it is, every block
 * names itself so the block a `jump` names is one a reader can go and find,
 * and every statement names the source line it was written on where the text
 * states one. No target appears anywhere in it, which is what lets one text
 * lower to every backend.
 *
 * This file is both ends of one form. The printer decides the layout and the
 * parser only ever reads what the printer wrote, so a program survives being
 * written down and read back whole. What the text cannot carry is the
 * contract: the signature of a callee, the functions the program calls, the
 * layouts those functions hand back and the effects a call has are all read
 * back out of the program contract, so a hand-written IR cannot invent a
 * function or lay an object out for itself.
 *
 * The form, line by line. Indentation is two spaces per level, a blank line
 * says nothing, and every line is one statement, one block head or one
 * terminator. A statement may end with `@n`, the line of the source it was
 * written on, which names it in a diagnostic and is nothing else, so an
 * answer that states none is read as a statement of no stated line.
 *
 *   ir 1
 *   file "main.ts"
 *   function dotProduct as main(a: ptr<f64>, b: ptr<f64>, n: usize) -> f64
 *   object Node size 24 align 8
 *     field x: f64 at 0
 *     field next: ref<Node> at 8
 *
 *   block entry: releases[]
 *     let value[i32] t1 immutable = const[i32] 70 @3
 *     let buffer a1 mutable element[i32] 4 = [buffer[[i32; 4]] element[i32] 4 const[i32] 1 const[i32] 2]] @4
 *     for[i32] i1 from const[i32] 0 to [length[usize] local[[i32; 4]] a1] exclusive up step default header b1 exit entry @5
 *       block b2: releases[]
 *         set_element a1 [element[i32] local[[i32; 4]] a1 local[i32] i1] = const[i32] 9 @6
 *         step i1 ++ post @6
 *       jump b1 [a1]
 *     if [gt[i32] local[i32] i1 const[i32] 3] @8
 *       block b3: releases[]
 *         print_text [text "done: " [to_text local[i32] i1]] @9
 *     else
 *       block b4: releases[]
 *         print_newline @9
 *     return
 *
 * A block head names the block and what it owns. The way a block ends is its
 * own line, unless it ends by falling out of itself: `return` ends the
 * program, and `jump b1 [a1]` leaves for a block, freeing what is named after
 * it.
 *
 *   block b2: releases[t1 t2]
 *     jump b1 [t1]
 *
 * The statements, one line each. A statement that owns blocks writes them
 * under itself, the way the source wrote them.
 *
 *   let <slot> = <value>
 *   set <name> <op> <value>
 *   set_element <buffer> <index> <op> <value>
 *   step <name> ++|-- pre|post
 *   if <condition>
 *   while <condition> header <id> exit <id>
 *   do_while <condition> header <id> exit <id>
 *   for <type> <variable> from <value> to <value> inclusive|exclusive up|down step <value|default> header <id> exit <id>
 *   for_of <type> <element> of <name> index <name> length <value> header <id> exit <id>
 *   block <id>
 *   print_text <value>
 *   print_number <value>
 *   print_newline
 *   retain <value>
 *   call <type> <callee> [arg[<type>] <value> ...] ownership=<none|borrowed|owned> retain=<yes|no>
 *   raise <value>
 *   load_field <value> <field>
 *   store_field <value> <field> <value>
 *
 * A slot says what the name holds and whether the program may change it.
 *
 *   value[<type>] <name> mutable|immutable
 *   text <name> mutable|immutable
 *   buffer <name> mutable|immutable element[<type>] <length>
 *   object[<type>] <name> mutable|immutable
 *
 * A value is one word, the type it is in brackets, and whatever else the
 * operation needs. An operation that is made of other values is written in
 * brackets around the whole of it, so a value is never cut short by the one
 * written after it, and a value that is a name and a type alone is written
 * without them.
 *
 *   const[i32] 70
 *   local[i32] t1
 *   bool[bool] true
 *   nothing[ref Node]
 *   [new_object[ref Node] Node left local[ref Node] n right nothing[ref Node]]
 *   argv[usize]
 *   [length[usize] t1]
 *   [element[i32] t1 const[i32] 0]
 *   [add[i32] local[i32] t1 const[i32] 4]
 *   [lt[bool] i32 local[i32] i1 const[i32] 4]
 *   [unary neg[i32] local[i32] t1]
 *   [is_not_null[bool] local[ref Node] n]
 *   [to_text local[i32] i1]
 *   [text "done: " [to_text local[i32] i1]]
 *   [call[f64] main [arg[i32] t1] ownership=owned retain=no]
 *
 * A type is the IR's own name for it: `i32`, `bool`, `text`, `void`, `[]f64`,
 * `[i32; 3]`, `f64*` and `ref Node`. The header states types as the contract
 * names them, `ptr<f64>` and `ref<Node>`, so both spellings are read here.
 *
 * A function is a header and a body, and the header is everything about the
 * function that is not its body: what it is called by, what it is held to,
 * what it does beyond computing its result, the objects it lays out, the calls
 * it makes and the parameters its body reads. The body is the grammar above,
 * written under the header, and a function whose contract states a
 * postcondition rather than a body ends at its parameters.
 *
 *   function createTree(depth: f64) -> ref<Object1>
 *     requires none
 *     ensures none
 *     allocates yes
 *     prints no
 *     reads_argv no
 *     effects memory
 *     object Object1 size 16 align 8
 *       field left: ref<any> at 0
 *       field right: ref<any> at 8
 *     call checksum
 *     param value[f64] depth mutable
 *     block entry: releases[]
 *       let object[ref<Object1>] node = [new_object[ref<Object1>] Object1 ] @3
 *       return local[ref<Object1>] node @5
 *
 * The header is written in that order and read in it, one line per declaration
 * except a run of conditions, which is as long as there are. A symbol that is
 * not the name is written after `as`, as `function main as blaze_main()` is.
 *
 * Every line of that header is read back out of the contract rather than out
 * of the text, so a function written in this form cannot widen its own
 * signature, invent an effect or lay an object out for itself: the contract is
 * what the text is checked against, and a line that disagrees with it is an
 * error naming itself. `none` is how a list with nothing in it is written, a
 * condition is a string in quotes because a condition is a claim in the
 * contract's own language, and a file of functions is a version, the file it
 * was written in, and the functions themselves.
 */

import { CompilerError } from "../core/errors.ts";
import {
  type ArithOp,
  type CompareOp,
  TEXT,
  type Ownership,
  type SemanticAssignOp,
  type SemanticBlock,
  type SemanticCall,
  type SemanticFunction,
  type SemanticLoop,
  type SemanticModule,
  type SemanticProgram,
  type SemanticSlot,
  type SemanticStatement,
  type SemanticTerminator,
  type SemanticTextPart,
  type SemanticType,
  type SemanticValue,
  type UnaryOp,
  UNSTATED_LINE,
  slotType,
  typeEquals,
  typeText,
} from "../core/semantic-ir.ts";
import {
  PRIMITIVE_TYPES,
  type CallEdge,
  type Effect,
  type FunctionContract,
  type FunctionSignature,
  type ObjectLayout,
  type PrimitiveTypeName,
  type ProgramContract,
  type TypeExpr,
} from "../core/types.ts";
import { contractText, parseType, typeToString } from "./contract.ts";
import { builtinFor } from "./builtins.ts";
import { unescape } from "./typescript.ts";

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

/** What the text form carries, so a form written for another one is refused. */
const VERSION = "1";

/** The operators `op=` accepts, which the IR names as they are written. */
const ASSIGN_OPS: readonly SemanticAssignOp[] = ["=", "+=", "*=", "-=", "/=", "%="];

/** The arithmetic a value states, each of which prints as the IR names it. */
const ARITH_OPS: readonly ArithOp[] = [
  "add",
  "sub",
  "mul",
  "div",
  "mod",
  "pow",
  "min",
  "max",
  "shl",
  "shr",
  "ushr",
  "and",
  "or",
  "xor",
  "concat",
];

/** A number the IR text states, or a refusal of what is not one. */
function integer(text: string, what: string): number {
  if (!/^-?\d+$/.test(text)) {
    throw new CompilerError({
      category: "SemanticIrError",
      stage: "ir",
      message: `${what} is not a number`,
      detail: `the IR text states a number of elements, and "${text}" is not one`,
    });
  }
  return Number(text);
}

/** The six comparisons, each of which prints as the IR names it. */
const COMPARE_OPS: readonly CompareOp[] = ["eq", "ne", "lt", "le", "gt", "ge"];

/** The four unary operations, each of which prints as the IR names it. */
const UNARY_OPS: readonly UnaryOp[] = ["neg", "pos", "not", "bitNot"];

/** Who owns what a call hands back, each of which prints as the IR names it. */
const OWNERSHIPS: readonly Ownership[] = ["none", "borrowed", "owned"];

/** The two ways a flag is stated, which is every flag the IR writes as a word. */
const FLAGS: readonly string[] = ["yes", "no"];

/** What a function may do beyond computing its result, as the contract names it. */
const EFFECTS: readonly Effect[] = [
  "memory",
  "io",
  "filesystem",
  "network",
  "syscall",
  "random",
  "clock",
  "panic",
  "exception",
  "atomic"
];

/** What a name may hold, which is the word a slot is written with. */
const SLOT_KINDS: readonly string[] = ["value", "text", "buffer", "object"];

/** The two ways a name was declared, which the IR states as a flag. */
type Mutability = "mutable" | "immutable";

/** The two ways a name is stepped, which the IR states as a flag. */
type Side = "pre" | "post";

/** The two ways a name moves in a statement of its own. */
type StepOp = "++" | "--";

const STEP_OPS: readonly StepOp[] = ["++", "--"];

/** The operator a logical value states, whose own name the arithmetic shares. */
type LogicalOp = Extract<SemanticValue, { k: "logical" }>["op"];

/** The two logical operators, named apart from the arithmetic `and` and `or`. */
const LOGICAL_OPS: Record<"logical_and" | "logical_or", LogicalOp> = {
  logical_and: "and",
  logical_or: "or",
};

/** The two ways a reference is tested for nothing, which the IR states as a flag. */
const NULL_TESTS: Record<"is_null" | "is_not_null", boolean> = { is_null: false, is_not_null: true };

function isArithOp(word: string): word is ArithOp {
  return (ARITH_OPS as readonly string[]).includes(word);
}

function isCompareOp(word: string): word is CompareOp {
  return (COMPARE_OPS as readonly string[]).includes(word);
}

function isPrimitiveName(word: string): word is PrimitiveTypeName {
  return (PRIMITIVE_TYPES as readonly string[]).includes(word);
}

/** A name, a keyword or a type word: everything up to the next delimiter. */
function isWordCharacter(character: string): boolean {
  return /[A-Za-z0-9_$.]/.test(character);
}

/* -------------------------------------------------------------------------- */
/* Strings                                                                     */
/* -------------------------------------------------------------------------- */

/** The escapes a string carries, which are the ones the frontend already reads. */
const ESCAPES: Record<string, string> = {
  "\\": "\\\\",
  '"': '\\"',
  "\n": "\\n",
  "\t": "\\t",
  "\r": "\\r",
};

/** A string as JavaScript writes one, so what a value carries survives a round trip. */
function stringLiteral(value: string): string {
  let text = '"';
  for (const character of value) text += ESCAPES[character] ?? character;
  return `${text}"`;
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                     */
/* -------------------------------------------------------------------------- */

/** What a name was declared as, which the IR states as a flag. */
function mutabilityText(mutable: boolean): Mutability {
  return mutable ? "mutable" : "immutable";
}

/** A function as the contract states it, under the name a call reaches it by. */
function signatureText(signature: FunctionSignature): string {
  const alias = signature.symbol === signature.name ? "" : ` as ${signature.symbol}`;
  const params = signature.params.map((param) => `${param.name}: ${typeToString(parseType(param.type))}`).join(", ");
  return `function ${signature.name}${alias}(${params}) -> ${typeToString(parseType(signature.returns))}`;
}

/** An object layout, with every field it holds on the line under it. */
function objectLines(name: string, layout: ObjectLayout, indent = 0): string[] {
  const pad = " ".repeat(indent);
  const lines = [`${pad}object ${name} size ${layout.size} align ${layout.align}`];
  for (const field of layout.fields) {
    lines.push(`${pad}  field ${field.name}: ${typeToString(parseType(field.type))} at ${field.offset}`);
  }
  return lines;
}

/** What a declared name holds, and whether the program may change it. */
function slotText(slot: SemanticSlot): string {
  const state = mutabilityText(slot.mutable);
  switch (slot.kind) {
    case "value":
      return `value[${typeText(slot.type)}] ${slot.name} ${state}`;
    case "text":
      return `text ${slot.name} ${state}`;
    case "buffer":
      return `buffer ${slot.name} ${state} element[${typeText(slot.element)}] ${slot.length ?? "runtime"}`;
    case "object":
      return `object[${typeText(slot.type)}] ${slot.name} ${state}`;
  }
}

/** One piece of a string: text as written, or a value put into it. */
function partText(part: SemanticTextPart): string {
  return part.k === "text" ? stringLiteral(part.value) : printSemanticValue(part.value);
}

/**
 * A call as its callee, its arguments, and who owns what it hands back. The
 * signature and the effects are not written: they are the contract's to state,
 * and a call the text names is bound to the contract that declares it.
 */
function callText(call: SemanticCall): string {
  const args = call.args
    .map((argument, position) => `arg[${typeText(call.argTypes[position])}] ${printSemanticValue(argument)}`)
    .join(" ");
  const retain = call.retain ? "yes" : "no";
  return `${call.callee} [${args}] ownership=${call.ownership} retain=${retain}`;
}

/** A value as the IR states it: the operation, the type, and what it is made of. */
export function printSemanticValue(value: SemanticValue): string {
  switch (value.k) {
    case "const":
      return `const[${typeText(value.type)}] ${value.text}`;
    case "text":
      return `[text ${value.parts.map(partText).join(" ")}]`;
    case "bool":
      return `bool[${typeText(value.type)}] ${value.value ? "true" : "false"}`;
    case "nothing":
      return `nothing[${typeText(value.type)}]`;
    case "local":
      return `local[${typeText(value.type)}] ${value.name}`;
    case "length":
      return `[length[${typeText(value.type)}] ${printSemanticValue(value.of)}]`;
    case "element":
      return `[element[${typeText(value.type)}] ${printSemanticValue(value.of)} ${printSemanticValue(value.index)}]`;
    case "buffer":
      if (value.view !== null) {
        return `[buffer[${typeText(value.type)}] element[${typeText(value.element)}] view ${printSemanticValue(value.view.offset)} ${printSemanticValue(value.view.of)} ${printSemanticValue(value.count as SemanticValue)}]`;
      }
      if (value.count !== null) {
        return `[buffer[${typeText(value.type)}] element[${typeText(value.element)}] runtime ${printSemanticValue(value.count)}]`;
      }
      return `[buffer[${typeText(value.type)}] element[${typeText(value.element)}] ${value.length} ${value.values.map(printSemanticValue).join(" ")}]`;
    case "newObject":
      return `[new_object[${typeText(value.type)}] ${value.layout} ${value.fields.map((field) => `${field.name} ${printSemanticValue(field.value)}`).join(" ")}]`;
    case "loadField":
      return `[load_field[${typeText(value.type)}] ${printSemanticValue(value.object)} ${value.layout} ${value.field}]`;
    case "call":
      return `[call[${typeText(value.type)}] ${callText(value.call)}]`;
    case "arith":
      return `[${value.op}[${typeText(value.type)}] ${printSemanticValue(value.left)} ${printSemanticValue(value.right)}]`;
    case "compare":
      return `[${value.op}[${typeText(value.type)}] ${typeText(value.operand)} ${printSemanticValue(value.left)} ${printSemanticValue(value.right)}]`;
    case "logical": {
      const word = value.op === "and" ? "logical_and" : "logical_or";
      return `[${word}[${typeText(value.type)}] ${printSemanticValue(value.left)} ${printSemanticValue(value.right)}]`;
    }
    case "coalesce":
      return `[coalesce[${typeText(value.type)}] ${printSemanticValue(value.left)} ${printSemanticValue(value.right)}]`;
    case "select":
      return `[select[${typeText(value.type)}] ${printSemanticValue(value.condition)} ${printSemanticValue(value.then)} ${printSemanticValue(value.otherwise)}]`;
    case "unary":
      return `[unary ${value.op}[${typeText(value.type)}] ${printSemanticValue(value.operand)}]`;
    case "isNull":
      return `[${value.negate ? "is_not_null" : "is_null"}[${typeText(value.type)}] ${printSemanticValue(value.operand)}]`;
    case "toText":
      return `[to_text${value.digits === null ? "" : `@${value.digits}`} ${printSemanticValue(value.of)}]`;
    case "argv":
      return value.index === null
        ? `argv[${typeText(value.type)}]`
        : `[argv[${typeText(value.type)}] ${printSemanticValue(value.index)}]`;
  }
}

/** How a block ends, or null when it ends by falling out of itself. */
function terminatorText(terminator: SemanticTerminator, indent: number): string | null {
  const pad = " ".repeat(indent);
  if (terminator.k === "next") return null;
  if (terminator.k === "return") {
    return terminator.value === null ? `${pad}return` : `${pad}return ${printSemanticValue(terminator.value)}`;
  }
  const releases = terminator.releases.length === 0 ? "" : ` [${terminator.releases.join(" ")}]`;
  return `${pad}jump ${terminator.target}${releases}`;
}

/** A run of statements, each on its own line, two spaces in. */
function statementLines(statements: readonly SemanticStatement[], indent: number): string[] {
  return statements.flatMap((statement) => statementText(statement, indent));
}

/** A block, and the way it ends. The source line is written on a block statement. */
function blockLines(block: SemanticBlock, indent: number, source: number | null): string[] {
  const mark = source === null ? "" : ` @${source}`;
  const lines = [`${" ".repeat(indent)}block ${block.id}: releases[${block.releases.join(" ")}]${mark}`];
  lines.push(...statementLines(block.statements, indent + 2));
  const end = terminatorText(block.terminator, indent);
  if (end !== null) lines.push(end);
  return lines;
}

/** A loop, the block it owns, and the blocks a `break` and a `continue` leave for. */
function loopLines(loop: SemanticLoop, indent: number, line: number): string[] {
  const pad = " ".repeat(indent);
  const mark = ` header ${loop.header} exit ${loop.exit} @${line}`;
  let head: string;
  switch (loop.kind) {
    case "while":
      head = `${pad}while ${printSemanticValue(loop.condition)}`;
      break;
    case "doWhile":
      head = `${pad}do_while ${printSemanticValue(loop.condition)}`;
      break;
    case "counted": {
      const bound = loop.inclusive ? "inclusive" : "exclusive";
      const direction = loop.down ? "down" : "up";
      const step = loop.step === null ? "default" : printSemanticValue(loop.step);
      head = `${pad}for[${typeText(loop.type)}] ${loop.variable} from ${printSemanticValue(loop.from)} to ${printSemanticValue(loop.to)} ${bound} ${direction} step ${step}`;
      break;
    }
    case "each":
      head = `${pad}for_of[${typeText(loop.elementType)}] ${loop.element} of ${loop.of} index ${loop.index} length ${printSemanticValue(loop.length)}`;
      break;
  }
  return [head + mark, ...blockLines(loop.body, indent + 2, null)];
}

/** One statement, and the blocks it owns. */
function statementText(statement: SemanticStatement, indent: number): string[] {
  const pad = " ".repeat(indent);
  const mark = ` @${statement.line}`;
  switch (statement.k) {
    case "let":
      return [`${pad}let ${slotText(statement.slot)} = ${printSemanticValue(statement.value)}${mark}`];
    case "fill":
      return [
        `${pad}fill ${statement.buffer} ${statement.index} element[${typeText(statement.type)}] ${printSemanticValue(statement.value)}${mark}`,
      ];
    case "set":
      return [`${pad}set ${statement.name} ${statement.op} ${printSemanticValue(statement.value)}${mark}`];
    case "setElement":
      return [
        `${pad}set_element ${statement.buffer} ${printSemanticValue(statement.index)} ${statement.op} ${printSemanticValue(statement.value)}${mark}`,
      ];
    case "step": {
      const side: Side = statement.prefix ? "pre" : "post";
      return [`${pad}step ${statement.name} ${statement.op} ${side}${mark}`];
    }
    case "if": {
      const lines = [`${pad}if ${printSemanticValue(statement.condition)}${mark}`, ...blockLines(statement.then, indent + 2, null)];
      if (statement.otherwise !== null) {
        lines.push(`${pad}else`, ...blockLines(statement.otherwise, indent + 2, null));
      }
      return lines;
    }
    case "loop":
      return loopLines(statement.loop, indent, statement.line);
    case "block":
      return blockLines(statement.body, indent, statement.line);
    case "printText":
      return [`${pad}print_text ${printSemanticValue(statement.value)}${mark}`];
    case "printNumber":
      return [`${pad}print_number ${printSemanticValue(statement.value)}${mark}`];
    case "printNewline":
      return [`${pad}print_newline${mark}`];
    case "retain":
      return [`${pad}retain ${printSemanticValue(statement.value)}${mark}`];
    case "call":
      return [`${pad}call[${typeText(statement.call.returns)}] ${callText(statement.call)}${mark}`];
    case "raise":
      return [`${pad}raise ${printSemanticValue(statement.message)}${mark}`];
    case "storeField":
      return [
        `${pad}store_field ${printSemanticValue(statement.object)} ${statement.layout} ${statement.field} ${printSemanticValue(statement.value)}${mark}`,
      ];
  }
}

/** The IR as text: what a person reads and a model writes. */
export function printSemanticProgram(program: SemanticProgram): string {
  const lines: string[] = [`ir ${VERSION}`, `file ${stringLiteral(program.file)}`];
  // A function the program calls from another file is a signature: its body is
  // in that file's object. A function the program declares is a body here, and
  // is written whole.
  const declared = new Set(program.bodies.map((fn) => fn.name));
  for (const signature of program.functions) {
    if (!declared.has(signature.name)) lines.push(signatureText(signature));
  }
  for (const name of Object.keys(program.objects)) lines.push(...objectLines(name, program.objects[name]));
  for (const fn of program.bodies) lines.push("", ...functionLines(fn));
  lines.push("");
  lines.push(...blockLines(program.entry, 0, null));
  return `${lines.join("\n")}\n`;
}

/* -------------------------------------------------------------------------- */
/* Writing a function                                                          */
/* -------------------------------------------------------------------------- */

/** A function as the contract states it, under the name a call reaches it by. */
function functionText(fn: SemanticFunction): string {
  const alias = fn.symbol === fn.name ? "" : ` as ${fn.symbol}`;
  const params = fn.params.map((param) => `${param.name}: ${typeText(slotType(param))}`).join(", ");
  return `function ${fn.name}${alias}(${params}) -> ${typeText(fn.returns)}`;
}

/** What a flag of a function is stated as, which is the word a call states one with. */
function flagText(value: boolean): string {
  return value ? "yes" : "no";
}

/**
 * The conditions a function is held to, one to a line and quoted, because a
 * condition is a claim in the contract's own language and is not a word.
 */
function conditionLines(keyword: "requires" | "ensures", conditions: readonly string[]): string[] {
  if (conditions.length === 0) return [`  ${keyword} none`];
  return conditions.map((condition) => `  ${keyword} ${stringLiteral(condition)}`);
}

/**
 * Everything about a function and then its body: the signature, the conditions
 * it is held to, what it does beyond computing its result, the objects it lays
 * out, the calls it makes, its parameters, and the blocks the body is written
 * as. The header is the whole of what makes this a function rather than a
 * body, so it is written first and in one fixed order, and the body follows it
 * because every function the IR holds has one.
 */
function functionLines(fn: SemanticFunction): string[] {
  const lines = [functionText(fn)];
  lines.push(...conditionLines("requires", fn.requires));
  lines.push(...conditionLines("ensures", fn.ensures));
  lines.push(`  allocates ${flagText(fn.allocates)}`);
  lines.push(`  prints ${flagText(fn.prints)}`);
  lines.push(`  reads_argv ${flagText(fn.readsArgv)}`);
  lines.push(`  effects ${fn.effects.length === 0 ? "none" : fn.effects.join(" ")}`);
  for (const name of Object.keys(fn.objects)) lines.push(...objectLines(name, fn.objects[name], 2));
  for (const edge of fn.calls) lines.push(`  call ${edge.callee}`);
  for (const param of fn.params) lines.push(`  param ${slotText(param)}`);
  lines.push(...blockLines(fn.entry, 2, null));
  return lines;
}

/** The whole function as text: its signature, its conditions, and its body. */
export function printSemanticFunction(fn: SemanticFunction): string {
  return `${functionLines(fn).join("\n")}\n`;
}

/** Every function of a file, as text. */
export function printSemanticModule(module: SemanticModule): string {
  const lines = [`ir ${VERSION}`, `module ${stringLiteral(module.path)}`];
  for (const fn of module.functions) lines.push("", ...functionLines(fn));
  return `${lines.join("\n")}\n`;
}

/* -------------------------------------------------------------------------- */
/* The contract                                                                */
/* -------------------------------------------------------------------------- */

/** What a call is bound to, none of which the text itself carries. */
interface BoundCall {
  readonly signature: FunctionSignature;
  /** What the call does beyond computing its result. */
  readonly effects: Effect[];
  readonly builtin: boolean;
}

/**
 * Where every name the text uses is bound: the functions a program calls, the
 * layouts those functions hand back, and what each of them costs. A name the
 * contract does not declare, and the builtins do not either, is a name the
 * program does not call.
 */
class ContractBinder {
  // A name is whatever the source called the function, and `__proto__` and
  // `constructor` are names a source may use. A table keyed by them has to be
  // a Map: assigning `__proto__` on an object sets its prototype instead of
  // adding a key, and the function silently vanishes from the table it is in.
  private readonly functions = new Map<string, FunctionContract>();
  private readonly layouts = new Map<string, ObjectLayout>();
  /** The functions a program declares, which no contract of the program states. */
  private readonly declared = new Map<string, BoundCall>();

  constructor(contract: ProgramContract) {
    for (const file of contract.files) {
      for (const [name, declared] of Object.entries(file.functions)) {
        this.functions.set(name, declared);
        this.functions.set(declared.function.name, declared);
        this.functions.set(declared.function.symbol, declared);
        for (const [layout, shape] of Object.entries(declared.definition.objects)) {
          this.layouts.set(layout, shape);
        }
      }
    }
  }

  /**
   * The contract of a call, read off the program the call is compiled against.
   * A builtin is the compiler's own and is bound first, as the resolver reads
   * a name: a name both tables declare is the compiler's.
   */
  bind(name: string, line: number): BoundCall {
    const bound = this.lookup(name);
    if (bound !== null) return bound;
    const compiled = this.names().join(", ") || "no functions";
    fail(line, `a function this program declares, one of: ${compiled}`, name);
  }

  /**
   * The contract of a function the text describes whole, which is what its own
   * signature, conditions, flags, layouts and call edges are read against. A
   * builtin is the compiler's own and is never a declaration of its own.
   */
  declaration(name: string, line: number): FunctionContract {
    const declared = builtinFor(name) === null ? this.functions.get(name) : undefined;
    if (declared !== undefined) return declared;
    const compiled = this.names().join(", ") || "no functions";
    fail(line, `a function this program declares, one of: ${compiled}`, name);
  }

  /** What a name the text writes is bound to, or null when the program declares none. */
  find(name: string): BoundCall | null {
    return this.lookup(name);
  }

  /** Every name a call may reach, which an error lists so that it can be fixed. */
  names(): string[] {
    return [...this.functions.keys(), ...this.declared.keys()];
  }

  /**
   * The callees the program records for one function, and an empty list for a
   * name the program does not declare. A body written out brings its own calls
   * into the caller, so a reader closing a call graph asks here.
   */
  callsOf(name: string): string[] {
    return this.functions.get(name)?.definition.calls.map((call) => call.callee) ?? [];
  }

  /** The layout a contract hands back, which the text only names. */
  layout(name: string, line: number): ObjectLayout {
    const shape = this.layouts.get(name);
    if (shape === undefined) {
      const handed = this.names().length === 0 ? "no layouts" : [...this.layouts.keys()].join(", ");
      fail(line, `a layout this program hands back, one of: ${handed}`, name);
    }
    return shape;
  }

  /**
   * What a name is bound to, read by the name the text writes it under. A name
   * no table declares is not a name the program calls.
   */
  private lookup(name: string): BoundCall | null {
    const builtin = builtinFor(name);
    if (builtin !== null) {
      const params = builtin.params.map((type, index) => ({ name: `argument${index}`, type: typeToString(type) }));
      return { signature: { name, symbol: name, params, returns: typeToString(builtin.returns) }, effects: [], builtin: true };
    }
    const own = this.declared.get(name);
    if (own !== undefined) return own;
    const declared = this.functions.get(name);
    if (declared === undefined) return null;
    return { signature: declared.function, effects: declared.effects, builtin: false };
  }

  /**
   * A function the program itself declares, bound as a call of it is bound: the
   * text is the only statement of what it takes and what it hands back, because a
   * program function has no contract of its own.
   */
  declare(signature: FunctionSignature, effects: readonly Effect[]): void {
    this.declared.set(signature.name, { signature, effects: [...effects], builtin: false });
    this.declared.set(signature.symbol, { signature, effects: [...effects], builtin: false });
  }

  /** The declaration of a function the program declares, for a body that names it. */
  declarationOf(name: string): FunctionSignature | null {
    return this.declared.get(name)?.signature ?? null;
  }
}

/* -------------------------------------------------------------------------- */
/* Reading one line                                                            */
/* -------------------------------------------------------------------------- */

/** What a function the program declares is called by. */
function functionSignature(fn: SemanticFunction): FunctionSignature {
  return {
    name: fn.name,
    symbol: fn.symbol,
    params: fn.params.map((param) => ({ name: param.name, type: typeText(slotType(param)) })),
    returns: typeText(fn.returns),
  };
}

/** A line of the text is not a program, said as the line it was written on. */
function fail(line: number, expected: string, found: string): never {
  throw new CompilerError({
    category: "ContractError",
    stage: "ir",
    message: `the IR text is not a program at line ${line}`,
    detail: `line ${line}: expected ${expected}, found "${found}"`,
  });
}

/** One value read out of a line, in the shape the printer wrote it. */
class IrScanner {
  readonly line: number;
  private readonly text: string;
  private readonly binder: ContractBinder;
  private at = 0;
  /**
   * The callees the function being read declared, and null where that does not
   * apply. A scanner reading a call is a body reaching a callee, and a body may
   * only reach one its own function declared, or wrote out.
   */
  declaredCallees: string[] | null = null;
  /**
   * Every callee the function being read may name, and where the reader
   * computes it: the calls its own contract records, closed over the callees it
   * writes out. Empty where a reader is not reading a function's header.
   */
  protected reachable: Set<string> = new Set<string>();

  constructor(text: string, line: number, binder: ContractBinder) {
    this.text = text;
    this.line = line;
    this.binder = binder;
  }

  /* ---------------------------------------------------------------------- */
  /* Words                                                                  */
  /* ---------------------------------------------------------------------- */

  /** A line the reader is on cannot say what the text is meant to say. */
  refuse(expected: string, found: string): never {
    fail(this.line, expected, found);
  }

  /** What the next character is, or nothing where the line has ended. */
  peek(): string {
    return this.at >= this.text.length ? "" : this.text[this.at];
  }

  /** Spaces between the parts of a line say nothing. */
  skip(): void {
    while (this.peek() === " " || this.peek() === "\t") this.at += 1;
  }

  /**
   * A name, a keyword or a type word: everything up to the next delimiter. A
   * name is written bare, and the one thing the text does write in quotes is
   * the text of a string, so a name in quotes is said here rather than left as
   * a quote at the front of what was found.
   */
  word(): string {
    this.skip();
    const start = this.at;
    while (isWordCharacter(this.peek())) this.at += 1;
    if (this.at === start) {
      const quoted = this.peek() === '"' ? "a name is written bare, not in quotes" : "a name";
      this.refuse(quoted, this.text.slice(this.at, this.at + 8));
    }
    return this.text.slice(start, this.at);
  }

  /** A symbol word, as an operator or a number is written. */
  token(): string {
    this.skip();
    const start = this.at;
    while (this.at < this.text.length && !/[\s[\]@,]/.test(this.text[this.at])) this.at += 1;
    return this.text.slice(start, this.at);
  }

  /** A word the text fixes, read so that a wrong one is an error and not a name. */
  keyword(word: string): void {
    const read = this.word();
    if (read !== word) this.refuse(`"${word}"`, read);
  }

  /** What the text fixes at this point, as a bracket, a colon or an arrow is. */
  expect(written: string): void {
    this.skip();
    if (!this.text.startsWith(written, this.at)) this.refuse(`"${written}"`, this.text.slice(this.at));
    this.at += written.length;
  }

  /**
   * A word out of the set the text fixes for it, as an operator is written. A
   * word the set does not hold is an error, and never a name read past.
   */
  oneOf<T extends string>(word: string, options: readonly T[]): T {
    const found = options.find((option) => option === word);
    if (found === undefined) this.refuse(`one of ${options.join(", ")}`, word);
    return found;
  }

  /** A count, as the length of an array is written. */
  integer(): number {
    this.skip();
    const start = this.at;
    while (/[0-9]/.test(this.peek())) this.at += 1;
    if (this.at === start) this.refuse("a count", this.text.slice(this.at, this.at + 8));
    const count = Number.parseInt(this.text.slice(start, this.at), 10);
    const next = this.peek();
    // A count is followed by whatever closes what it counts: `]` in the
    // bracket spelling `[i32; 3]`, and `>` in the angle-bracketed one the
    // signature lines and the object layouts are written in — `array<i32,3>`,
    // which is what `semantics/contract.ts` writes and what `parseType` reads.
    // The reader refused its own printer's spelling, so a function with a
    // fixed-length array could not be read back from what was printed.
    if (next !== "" && !/[\s\]@,>]/.test(next)) this.refuse("a count and what follows it", this.text.slice(start));
    return count;
  }

  /** A string as JavaScript writes one, taken back to the characters it carries. */
  string(): string {
    this.skip();
    if (this.peek() !== '"') this.refuse("a string in quotes", this.text.slice(this.at));
    this.at += 1;
    const start = this.at;
    while (this.peek() !== "" && this.peek() !== '"') this.at += this.peek() === "\\" ? 2 : 1;
    if (this.peek() !== '"') this.refuse('the closing quote of a string', this.text.slice(start));
    const body = this.text.slice(start, this.at);
    this.at += 1;
    return unescape(body, this.line);
  }

  /**
   * The line of the source a statement was written on, which ends its line.
   *
   * The mark is how a diagnostic names the place a statement was written, and
   * nothing is lowered from it, so a line that states none states the same body
   * as a line that does and is read rather than refused.
   */
  mark(): number {
    this.skip();
    if (this.peek() === "@") {
      this.at += 1;
      const start = this.at;
      while (/[0-9]/.test(this.peek())) this.at += 1;
      if (this.at === start) this.refuse("a source line number", this.text.slice(this.at));
      const line = Number.parseInt(this.text.slice(start, this.at), 10);
      this.end();
      return line;
    }
    this.end();
    return UNSTATED_LINE;
  }

  /** Nothing more on this line, which every line that ends in itself does. */
  end(): void {
    this.skip();
    if (this.at < this.text.length) this.refuse("the end of the line", this.text.slice(this.at));
  }

  /**
   * What stands between two names of a list. The text writes a list with its
   * names side by side, and a comma between them is read as the space it
   * stands in for, so both spellings are one list — and what a list holds is
   * checked against the contract either way.
   */
  separator(): void {
    this.skip();
    if (this.peek() === ",") this.at += 1;
  }

  /** A bracketed list of names, which is how releases and arguments are written. */
  names(): string[] {
    this.expect("[");
    const names: string[] = [];
    for (;;) {
      this.separator();
      if (this.peek() === "]") {
        this.at += 1;
        return names;
      }
      if (this.peek() === "") this.refuse('the "]" of a list of names', "");
      names.push(this.word());
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Types                                                                  */
  /* ---------------------------------------------------------------------- */

  /** A type, as the IR names it or as the contract names it. */
  type(): SemanticType {
    const type = this.typeAtom();
    if (type.kind !== "text") return this.pointers(type);
    this.skip();
    if (this.peek() === "*") this.refuse("a pointer to a type the contract declares", "text*");
    return type;
  }

  /** The type a value is, in the brackets the operation is written with. */
  typed(): SemanticType {
    this.expect("[");
    const type = this.type();
    this.expect("]");
    return type;
  }

  /**
   * A type the contract declares, which is what a truth, a comparison and
   * every type a contract type is made of is. The contract type language has
   * no string type, so a text read where one is expected is an error.
   */
  contract(): TypeExpr {
    const type = this.type();
    if (type.kind === "text") this.refuse("a type the contract declares, not text", "text");
    return type;
  }

  /** A type the contract declares, in the brackets a value is written with. */
  contractType(): TypeExpr {
    this.expect("[");
    const type = this.contract();
    this.expect("]");
    return type;
  }

  /** A pointer is a `*` after the type it points at, however many of them. */
  private pointers(type: TypeExpr): TypeExpr {
    for (;;) {
      this.skip();
      if (this.peek() !== "*") return type;
      this.at += 1;
      type = { kind: "ptr", of: type };
    }
  }

  private typeAtom(): SemanticType {
    this.skip();
    if (this.peek() === "[") return this.arrayType();
    const head = this.word();
    if (this.peek() === "<") return this.compositeType(head);
    if (head === "void") return { kind: "void" };
    if (head === "text") return { kind: "text" };
    if (isPrimitiveName(head)) return { kind: "primitive", name: head };
    this.refuse("a type", head);
  }

  /** A slice or an array, which are the two types that start with a bracket. */
  private arrayType(): SemanticType {
    this.at += 1;
    if (this.peek() === "]") {
      this.at += 1;
      return { kind: "slice", of: this.contract() };
    }
    const of = this.contract();
    this.skip();
    let length: number | null = null;
    if (this.peek() === ";") {
      this.at += 1;
      length = this.integer();
      this.skip();
    }
    this.expect("]");
    return { kind: "array", of, length };
  }

  /** A type the contract writes with its own name, as `ptr<f64>` or `ref<Node>`. */
  private compositeType(head: string): SemanticType {
    this.at += 1;
    switch (head) {
      case "ptr":
      case "slice": {
        const of = this.contract();
        this.expect(">");
        return { kind: head, of };
      }
      case "array": {
        const of = this.contract();
        this.skip();
        const length = this.peek() === "," ? this.commaCount() : null;
        this.expect(">");
        return { kind: "array", of, length };
      }
      case "ref": {
        const reference = this.referenceType();
        this.expect(">");
        return reference;
      }
      default:
        this.refuse('a type written as "ptr<...>", "slice<...>", "array<...>" or "ref<...>"', head);
    }
  }

  /**
   * What a `ref` points at, which is nothing at all, a layout by the name it is
   * exported as, or a type the contract declares. A layout is named with a
   * capital, as the contract names one, and nothing else is.
   */
  private referenceType(): SemanticType {
    this.skip();
    const start = this.at;
    while (isWordCharacter(this.peek())) this.at += 1;
    const word = this.text.slice(start, this.at);
    if (word === "any") return { kind: "ref", of: null };
    if (this.peek() === ">") {
      if (!/^[A-Z]/.test(word)) this.refuse("a layout name, written with a capital", word);
      return { kind: "ref", of: null, name: word };
    }
    this.at = start;
    return { kind: "ref", of: this.contract() };
  }

  private commaCount(): number {
    this.at += 1;
    const count = this.integer();
    this.skip();
    return count;
  }

  /* ---------------------------------------------------------------------- */
  /* Values                                                                 */
  /* ---------------------------------------------------------------------- */

  /** A value, which an operation over other values writes in brackets. */
  value(): SemanticValue {
    this.skip();
    const bracketed = this.peek() === "[";
    if (bracketed) this.at += 1;
    // An operation may carry what it was asked for after its name, as
    // `to_text@9` is a number written at nine digits: the name is one word and
    // what follows it is another, and the two are taken apart here.
    const head = this.word();
    let asked: string | null = null;
    if (this.peek() === "@") {
      this.at += 1;
      asked = this.token();
    }
    if (head === "logical_and" || head === "logical_or") {
      return this.closing(bracketed, {
        k: "logical",
        op: LOGICAL_OPS[head],
        // A logical hands back one of its arms, so its type is the type of
        // them: two strings make a string, which the contract type language
        // has no spelling for. Read as a value's own type rather than as a
        // contract's, the way `coalesce` beside it is read.
        type: this.typed(),
        left: this.value(),
        right: this.value(),
      });
    }
    if (isArithOp(head)) {
      return this.closing(bracketed, {
        k: "arith",
        op: head,
        type: this.typed(),
        left: this.value(),
        right: this.value(),
      });
    }
    if (isCompareOp(head)) {
      return this.closing(bracketed, {
        k: "compare",
        op: head,
        type: this.contractType(),
        operand: this.type(),
        left: this.value(),
        right: this.value(),
      });
    }
    switch (head) {
      case "const": {
        const type = this.typed();
        const literal = this.token();
        if (literal === "") this.refuse("a number written out", this.text.slice(this.at));
        return this.bare(bracketed, { k: "const", type, text: literal });
      }
      case "bool": {
        const type = this.contractType();
        const literal = this.word();
        if (literal !== "true" && literal !== "false") this.refuse('"true" or "false"', literal);
        return this.bare(bracketed, { k: "bool", type, value: literal === "true" });
      }
      case "nothing":
        return this.bare(bracketed, { k: "nothing", type: this.typed() });
      case "local": {
        const type = this.typed();
        return this.bare(bracketed, { k: "local", type, name: this.word() });
      }
      case "new_object": {
        const type = this.typed();
        const layout = this.word();
        const fields: { name: string; value: SemanticValue }[] = [];
        while (this.more()) {
          const name = this.word();
          fields.push({ name, value: this.value() });
        }
        return this.closing(bracketed, { k: "newObject", type, layout, fields });
      }
      case "load_field":
        return this.closing(bracketed, {
          k: "loadField",
          type: this.typed(),
          object: this.value(),
          layout: this.word(),
          field: this.word(),
        });
      case "argv": {
        const type = this.typed();
        if (!bracketed) return { k: "argv", type, index: null };
        return this.closed({ k: "argv", type, index: this.value() });
      }
      case "coalesce":
        return this.closing(bracketed, { k: "coalesce", type: this.typed(), left: this.value(), right: this.value() });
      case "select":
        return this.closing(bracketed, {
          k: "select",
          type: this.typed(),
          condition: this.value(),
          then: this.value(),
          otherwise: this.value(),
        });
      case "to_text": {
        // `to_text@9` is a number written at nine digits, and `to_text` is one
        // written as the language writes it.
        if (asked !== null && !/^\d+$/.test(asked)) this.refuse("the digits a number is written at", asked);
        return this.closing(bracketed, {
          k: "toText",
          type: TEXT,
          of: this.value(),
          digits: asked === null ? null : Number(asked),
        });
      }
      case "length":
        return this.closing(bracketed, { k: "length", type: this.typed(), of: this.value() });
      case "element":
        return this.closing(bracketed, { k: "element", type: this.typed(), of: this.value(), index: this.value() });
      case "unary": {
        const op = this.unaryOp();
        return this.closing(bracketed, { k: "unary", op, type: this.typed(), operand: this.value() });
      }
      case "is_null":
      case "is_not_null":
        return this.closing(bracketed, {
          k: "isNull",
          type: this.contractType(),
          operand: this.value(),
          negate: NULL_TESTS[head],
        });
      case "text":
        return this.closed({ k: "text", type: TEXT, parts: this.parts() });
      case "buffer": {
        const type = this.typed();
        this.keyword("element");
        const element = this.typed();
        // `view <offset> <block> <count>`, `runtime <count>`, and a number of
        // elements followed by the values written into them.
        const length = this.word();
        if (length === "view") {
          const offset = this.value();
          const of = this.value();
          return this.closed({ k: "buffer", type, element, length: null, count: this.value(), view: { of, offset }, values: [] });
        }
        if (length === "runtime") {
          return this.closed({ k: "buffer", type, element, length: null, count: this.value(), view: null, values: [] });
        }
        const values: SemanticValue[] = [];
        while (this.more()) values.push(this.value());
        return this.closed({ k: "buffer", type, element, length: integer(length, typeText(type)), count: null, view: null, values });
      }
      case "call": {
        const type = this.typed();
        const call = this.call(type);
        return this.closed({ k: "call", type, call });
      }
      default:
        this.refuse("a value", head);
    }
  }

  /** A unary operation, which the IR names and the text keeps. */
  private unaryOp(): UnaryOp {
    return this.oneOf(this.word(), UNARY_OPS);
  }

  /** The pieces of a string: text as written, or a value put into it. */
  private parts(): SemanticTextPart[] {
    const parts: SemanticTextPart[] = [];
    while (this.more()) {
      this.skip();
      parts.push(this.peek() === '"' ? { k: "text", value: this.string() } : { k: "value", value: this.value() });
    }
    return parts;
  }

  /**
   * A call, bound to the contract that declares the callee and to the list the
   * function declared. The two are not the same: the contract records every
   * call the function may make, and the list is the ones this body makes. A
   * body that reaches past its own list would be lowered into a call the build
   * did not know it had, so it is refused where it is written.
   */
  call(returns: SemanticType): SemanticCall {
    const callee = this.word();
    const bound = this.binder.bind(callee, this.line);
    // A builtin is the compiler's own: it is not one of the program's functions,
    // so the call list a body is written with never named it, and holding a
    // body that reaches for `Math.floor` to a list of the program's own
    // functions is refusing arithmetic over a number for no reason. `bind`
    // above has already said whether the name is one the compiler provides.
    if (this.declaredCallees !== null && !bound.builtin && !this.declaredCallees.includes(callee)) {
      const declared = this.declaredCallees.join(", ") || "no calls";
      fail(this.line, `a call this function declared, one of: ${declared}`, callee);
    }
    const argTypes: SemanticType[] = [];
    const args: SemanticValue[] = [];
    this.expect("[");
    while (this.more()) {
      this.keyword("arg");
      argTypes.push(this.typed());
      args.push(this.value());
    }
    this.expect("]");
    this.keyword("ownership");
    this.expect("=");
    const ownership = this.oneOf(this.word(), OWNERSHIPS);
    this.keyword("retain");
    this.expect("=");
    const retain = this.oneOf(this.word(), FLAGS);
    return {
      callee,
      signature: bound.signature,
      args,
      argTypes,
      returns,
      effects: bound.effects,
      ownership,
      retain: retain === "yes",
      builtin: bound.builtin,
    };
  }

  /** Whether a bracketed list still holds a value, which is how a list ends. */
  private more(): boolean {
    this.skip();
    return this.peek() !== "" && this.peek() !== "]";
  }

  /** Ends an operation that is written in brackets around the whole of it. */
  private closing(bracketed: boolean, value: SemanticValue): SemanticValue {
    if (!bracketed) this.refuse("this operation, written in brackets", value.k);
    return this.closed(value);
  }

  private closed<T>(value: T): T {
    this.expect("]");
    return value;
  }

  private bare<T>(bracketed: boolean, value: T): T {
    if (bracketed) this.refuse("this value, written without brackets", "");
    return value;
  }
}

/* -------------------------------------------------------------------------- */
/* The lines a body is written on                                            */
/* -------------------------------------------------------------------------- */

/** One line of the text, with the indentation it was written at. */
interface IrLine {
  readonly number: number;
  readonly indent: number;
  readonly text: string;
}

/** A block as it was read, with the source line it was written on when it is one. */
interface ReadBlock {
  readonly body: SemanticBlock;
  readonly line: number;
}

/**
 * The lines of the text, with the blank ones dropped. Indentation is two
 * spaces per level, so a line indented by anything else is an error rather
 * than a block the reader has to guess the width of.
 */
function readLines(text: string): IrLine[] {
  const lines: IrLine[] = [];
  const source = text.split("\n");
  for (let index = 0; index < source.length; index += 1) {
    const raw = source[index].endsWith("\r") ? source[index].slice(0, -1) : source[index];
    if (raw.trim() === "") continue;
    let indent = 0;
    while (raw[indent] === " ") indent += 1;
    const number = index + 1;
    if (raw[indent] === "\t") fail(number, "indentation made of spaces", "\t");
    if (indent % 2 !== 0) fail(number, "indentation of two spaces per level", `${indent} spaces`);
    lines.push({ number, indent, text: raw.slice(indent) });
  }
  return lines;
}

/** The first word of a line, which is the statement, block or term it is. */
function headOf(line: IrLine): string {
  const end = line.text.search(/[\s\[]/);
  return end < 0 ? line.text : line.text.slice(0, end);
}

/** The rest of a line, once the word that names what it is has been read. */
function restOf(line: IrLine): string {
  return line.text.slice(headOf(line).length).trim();
}

/**
 * The lines a body is read from: the blocks, the statements in them, and where
 * control goes when they are done. A program's body and a function's body are
 * one grammar, so both readers are this and differ only in what surrounds it.
 */
class BlockReader {
  protected readonly lines: IrLine[];
  protected readonly binder: ContractBinder;
  protected at = 0;

  constructor(lines: IrLine[], binder: ContractBinder) {
    this.lines = lines;
    this.binder = binder;
  }

  /* ---------------------------------------------------------------------- */
  /* Lines                                                                  */
  /* ---------------------------------------------------------------------- */

  protected peek(): IrLine | null {
    return this.at < this.lines.length ? this.lines[this.at] : null;
  }

  /** The line that is read now, which has to be written at this level. */
  protected line(indent: number): IrLine {
    const line = this.peek();
    if (line === null) {
      fail(this.after(), `a line written at ${indent} spaces of indentation`, "the end of the text");
    }
    if (line.indent !== indent) {
      fail(line.number, `a line written at ${indent} spaces of indentation`, `${line.indent} spaces`);
    }
    return line;
  }

  /** The line a line that is missing would have been written on. */
  protected after(): number {
    const line = this.at > 0 ? this.lines[this.at - 1] : null;
    return line === null ? 1 : line.number + 1;
  }

  /**
 * Where an error about a run of lines belongs: the first of them when there
 * was one, and where they should have ended when there was not.
 */
  protected where(seen: IrLine | null): { number: number; text: string } {
    const line = seen ?? this.peek();
    return line === null ? { number: this.after(), text: "the end of the text" } : line;
  }

  protected atIndent(indent: number): boolean {
    const line = this.peek();
    return line !== null && line.indent === indent;
  }

  /** Nothing more on the lines, which every whole text ends with. */
  protected finish(what: string): void {
    const line = this.peek();
    if (line !== null) fail(line.number, what, line.text);
  }

  protected scanner(line: IrLine): IrScanner {
    const scanner = new IrScanner(restOf(line), line.number, this.binder);
    scanner.declaredCallees = this.declaredCallees;
    return scanner;
  }

  /**
   * The callees the function being read declared, and null where that does not
   * apply. A body may only reach a callee its own function declared: one it did
   * not declare is one it was told to write out, so there is nothing to call.
   */
  declaredCallees: string[] | null = null;
  /**
   * Every callee the function being read may name, and where the reader
   * computes it: the calls its own contract records, closed over the callees it
   * writes out. Empty where a reader is not reading a function's header.
   */
  protected reachable: Set<string> = new Set<string>();
  /**
   * Every block the text has declared by the time it is read, in the order it
   * declared them. A body names its own blocks in the terminators of its
   * blocks, so a jump to a name none of them carries is a name there is
   * nothing to read, and the ones that are say which there are.
   */
  protected readonly blocks: string[] = [];
  /* ---------------------------------------------------------------------- */
  /* Blocks                                                                 */
  /* ---------------------------------------------------------------------- */

  /** A block, the statements in it, and where control goes when they are done. */
  protected block(indent: number, statement: boolean): ReadBlock {
    const line = this.line(indent);
    if (headOf(line) !== "block") fail(line.number, '"block" and the name of the block', line.text);
    this.at += 1;
    const scanner = this.scanner(line);
    const id = scanner.word();
    this.blocks.push(id);
    scanner.expect(":");
    scanner.keyword("releases");
    const releases = scanner.names();
    let source = UNSTATED_LINE;
    if (statement) source = scanner.mark();
    else scanner.end();
    const body: SemanticBlock = {
      id,
      statements: this.statements(indent + 2),
      releases,
      terminator: this.terminator(indent),
    };
    return { body, line: source };
  }

  protected terminator(indent: number): SemanticTerminator {
    const line = this.peek();
    if (line === null || line.indent !== indent) return { k: "next" };
    const head = headOf(line);
    if (head !== "return" && head !== "jump") return { k: "next" };
    this.at += 1;
    const scanner = this.scanner(line);
    if (head === "return") {
      scanner.skip();
      const value = scanner.peek() === "" ? null : scanner.value();
      scanner.end();
      return { k: "return", value };
    }
    const target = scanner.word();
    scanner.skip();
    const releases = scanner.peek() === "[" ? scanner.names() : [];
    scanner.end();
    return { k: "jump", target, releases };
  }

  /* ---------------------------------------------------------------------- */
  /* Statements                                                             */
  /* ---------------------------------------------------------------------- */

  protected statements(indent: number): SemanticStatement[] {
    const statements: SemanticStatement[] = [];
    while (this.atIndent(indent)) statements.push(this.statement(indent));
    return statements;
  }

  protected statement(indent: number): SemanticStatement {
    const line = this.line(indent);
    const head = headOf(line);
    const scanner = this.scanner(line);
    this.at += 1;
    switch (head) {
      case "let": {
        const slot = this.slot(scanner);
        scanner.expect("=");
        const value = scanner.value();
        return { k: "let", slot, value, line: scanner.mark() };
      }
      case "set": {
        const name = scanner.word();
        const op = this.assignOp(scanner);
        const value = scanner.value();
        return { k: "set", name, op, value, line: scanner.mark() };
      }
      case "fill": {
        const buffer = scanner.word();
        const index = scanner.word();
        scanner.keyword("element");
        const element = scanner.contractType();
        return { k: "fill", buffer, index, type: element, value: scanner.value(), line: scanner.mark() };
      }
      case "set_element": {
        const buffer = scanner.word();
        const index = scanner.value();
        const op = this.assignOp(scanner);
        const value = scanner.value();
        return { k: "setElement", buffer, index, op, value, line: scanner.mark() };
      }
      case "step": {
        const name = scanner.word();
        const op = scanner.oneOf(scanner.token(), STEP_OPS);
        const side = scanner.word();
        if (side !== "pre" && side !== "post") scanner.refuse('"pre" or "post"', side);
        return { k: "step", name, op, prefix: side === "pre", line: scanner.mark() };
      }
      case "if": {
        const condition = scanner.value();
        const at = scanner.mark();
        const then = this.block(indent + 2, false).body;
        let otherwise: SemanticBlock | null = null;
        const next = this.peek();
        if (next !== null && next.indent === indent && headOf(next) === "else") {
          this.at += 1;
          this.scanner(next).end();
          otherwise = this.block(indent + 2, false).body;
        }
        return { k: "if", condition, then, otherwise, line: at };
      }
      case "while":
      case "do_while": {
        const condition = scanner.value();
        const { header, exit, at } = this.loopTail(scanner);
        const body = this.block(indent + 2, false).body;
        const kind = head === "while" ? "while" : "doWhile";
        return { k: "loop", loop: { kind, condition, header, exit, body }, line: at };
      }
      case "for": {
        const type = scanner.typed();
        const variable = scanner.word();
        scanner.keyword("from");
        const from = scanner.value();
        scanner.keyword("to");
        const to = scanner.value();
        const bound = scanner.word();
        if (bound !== "inclusive" && bound !== "exclusive") {
          scanner.refuse('"inclusive" or "exclusive"', bound);
        }
        const direction = scanner.word();
        if (direction !== "up" && direction !== "down") scanner.refuse('"up" or "down"', direction);
        scanner.keyword("step");
        // A step no loop names is the word `default`, and no value is written
        // with a word that starts with a d.
        scanner.skip();
        let step: SemanticValue | null = null;
        if (scanner.peek() === "d") scanner.keyword("default");
        else step = scanner.value();
        const { header, exit, at } = this.loopTail(scanner);
        const body = this.block(indent + 2, false).body;
        return {
          k: "loop",
          loop: {
            kind: "counted",
            variable,
            type,
            from,
            to,
            inclusive: bound === "inclusive",
            down: direction === "down",
            step,
            header,
            exit,
            body,
          },
          line: at,
        };
      }
      case "for_of": {
        const elementType = scanner.contractType();
        const element = scanner.word();
        scanner.keyword("of");
        const of = scanner.word();
        scanner.keyword("index");
        const index = scanner.word();
        scanner.keyword("length");
        const length = scanner.value();
        const { header, exit, at } = this.loopTail(scanner);
        const body = this.block(indent + 2, false).body;
        return { k: "loop", loop: { kind: "each", index, element, elementType, of, length, header, exit, body }, line: at };
      }
      case "block": {
        // The statement is the head of its own block, so the block reads the line.
        this.at -= 1;
        const read = this.block(indent, true);
        return { k: "block", body: read.body, line: read.line };
      }
      case "print_text":
        return { k: "printText", value: scanner.value(), line: scanner.mark() };
      case "print_newline":
        return { k: "printNewline", line: scanner.mark() };
      case "print_number":
        return { k: "printNumber", value: scanner.value(), line: scanner.mark() };
      case "retain":
        return { k: "retain", value: scanner.value(), line: scanner.mark() };
      case "call": {
        const returns = scanner.typed();
        const call = scanner.call(returns);
        return { k: "call", call, line: scanner.mark() };
      }
      case "raise":
        return { k: "raise", message: scanner.value(), line: scanner.mark() };
      case "store_field": {
        const object = scanner.value();
        const layout = scanner.word();
        const field = scanner.word();
        const value = scanner.value();
        return { k: "storeField", object, layout, field, value, line: scanner.mark() };
      }
      default:
        // A terminator is a word the text owns and a statement position is not
        // a place it is written, which is a thing the words themselves can say:
        // where a terminator goes, and which blocks a jump has to name.
        if (head === "jump" || head === "return") {
          const reaches =
            head === "jump"
              ? `a jump names one of the blocks this text declares: ${this.blocks.join(" ") || "none are declared yet"}`
              : "a return with no value ends the function";
          fail(
            line.number,
            `a statement; a "${head}" is the last line of a block, written at the indentation of the block head it ends, and ${reaches}`,
            line.text,
          );
        }
        fail(line.number, "a statement", line.text);
    }
  }

  /** The blocks a `break` and a `continue` leave a loop for. */
  protected loopTail(scanner: IrScanner): { header: string; exit: string; at: number } {
    scanner.keyword("header");
    const header = scanner.word();
    scanner.keyword("exit");
    const exit = scanner.word();
    return { header, exit, at: scanner.mark() };
  }

  /** An assignment as it is written, which the IR states as an operator. */
  protected assignOp(scanner: IrScanner): SemanticAssignOp {
    return scanner.oneOf(scanner.token(), ASSIGN_OPS);
  }

  /** What a declared name holds, read as the declaration states it. */
  protected slot(scanner: IrScanner): SemanticSlot {
    const kind = scanner.word();
    if (!SLOT_KINDS.includes(kind)) scanner.refuse(`a slot, one of ${SLOT_KINDS.join(", ")}`, kind);
    if (kind === "buffer") {
      const name = scanner.word();
      const mutable = this.mutable(scanner);
      scanner.keyword("element");
      const element = scanner.contractType();
      const length = scanner.word();
      return { kind, name, mutable, element, length: length === "runtime" ? null : integer(length, name) };
    }
    if (kind === "text") {
      const name = scanner.word();
      return { kind, name, mutable: this.mutable(scanner) };
    }
    const type = scanner.typed();
    const name = scanner.word();
    const mutable = this.mutable(scanner);
    return kind === "value" ? { kind, name, mutable, type } : { kind: "object", name, mutable, type };
  }

  /** Whether the program may change a name, which the IR states as a flag. */
  protected mutable(scanner: IrScanner): boolean {
    const state = scanner.word();
    if (state !== "mutable" && state !== "immutable") scanner.refuse('"mutable" or "immutable"', state);
    return state === "mutable";
  }
}

/* -------------------------------------------------------------------------- */
/* The entry points                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Reads IR text back, binding every callee to the contract it was declared in.
 * A line the IR cannot express, a name the contract does not declare, or a
 * malformed type is an error naming the line it was written on, never a
 * silently dropped instruction.
 */
export function parseSemanticProgram(text: string, contract: ProgramContract): SemanticProgram {
  return new ProgramReader(readLines(text), new ContractBinder(contract)).program();
}

/* -------------------------------------------------------------------------- */
/* Reading the program                                                         */
/* -------------------------------------------------------------------------- */

/** One program, read a line at a time in the shape the printer wrote it. */
class ProgramReader extends BlockReader {
  /* ---------------------------------------------------------------------- */
  /* The program                                                            */
  /* ---------------------------------------------------------------------- */

  program(): SemanticProgram {
    const version = this.line(0);
    this.at += 1;
    if (version.text !== `ir ${VERSION}`) fail(version.number, `"ir ${VERSION}"`, version.text);

    const file = this.file();
    const functions: FunctionSignature[] = [];
    const objects: Record<string, ObjectLayout> = {};
    // Every function the program declares is bound before any of their bodies is
    // read, so a function that calls one declared after it is bound the same as
    // one that calls it above: a program function is bound to the whole block it
    // was declared in, not to the line it was written at.
    const declaredAt: number[] = [];
    for (let line = this.peek(); line !== null && line.indent === 0; line = this.peek()) {
      const head = headOf(line);
      if (head !== "function" && head !== "object") break;
      this.at += 1;
      // A function written on one line is a signature: its body is in the
      // object it was compiled into. A function with lines under it is one the
      // program declares, and is read whole.
      if (head === "object") this.object(line, objects);
      else if (this.atIndent(2)) {
        this.declareFunction(line);
        declaredAt.push(this.at - 1);
        // The body is read in the pass below, so this one steps over it to the
        // next line of the program's own indent.
        while (this.peek() !== null && (this.peek() as IrLine).indent > 0) this.at += 1;
      } else functions.push(this.function(line));
    }
    const bodies: SemanticFunction[] = [];
    for (const at of declaredAt) {
      this.at = at + 1;
      bodies.push(this.declared());
    }

    const entry = this.block(0, false).body;
    this.finish("the end of the program");
    return {
      file,
      entry,
      functions: [...functions, ...bodies.map(functionSignature)],
      bodies,
      objects,
    };
  }

  /**
   * A function the program declares, read whole. There is no contract to read
   * it against — a program function is contracted by being its own body — so
   * the text is what it is read from, and every line of it is read to be sure
   * of what it says.
   */
  private declared(): SemanticFunction {
    const header = this.header(this.lines[this.at - 1]);
    const { name, symbol, returns } = header;
    const requires = this.conditions("requires");
    const ensures = this.conditions("ensures");
    const allocates = this.flag("allocates");
    const prints = this.flag("prints");
    const readsArgv = this.flag("reads_argv");
    const effects = this.effectsOf();
    const calls = this.callEdges();
    const declared_ = this.parameters();
    const entry = this.block(2, false).body;
    return {
      name,
      symbol,
      params: declared_,
      returns,
      requires,
      ensures,
      effects,
      allocates,
      prints,
      readsArgv,
      // A function of a program allocates no object: an object a program holds
      // is a reference to one a function handed back, and a program declares no
      // layout of its own.
      objects: {},
      calls,
      entry,
    };
  }

  /**
   * The header of a function the program declares: what it is called, what it
   * takes and what it hands back. It is read once to bind every function before
   * any body is read, and once more with the body it belongs to.
   */
  private header(line: IrLine): { name: string; symbol: string; params: { name: string; type: string }[]; returns: SemanticType; text: string } {
    const scanner = this.scanner(line);
    const name = scanner.word();
    let symbol = name;
    if (scanner.peek() === " ") {
      scanner.keyword("as");
      symbol = scanner.word();
    }
    const params: { name: string; type: string }[] = [];
    scanner.expect("(");
    for (;;) {
      scanner.skip();
      if (scanner.peek() === ")") break;
      const parameter = scanner.word();
      scanner.expect(":");
      // A signature states its types in the contract's own language, so a
      // parameter read off the header is written back the way the resolver
      // wrote it and a call bound to it is the same call.
      params.push({ name: parameter, type: contractText(scanner.type()) });
      scanner.skip();
      if (scanner.peek() !== ",") break;
      scanner.expect(",");
    }
    scanner.expect(")");
    scanner.expect("->");
    const returns = scanner.type();
    scanner.end();
    return { name, symbol, params, returns, text: contractText(returns) };
  }

  /** Binds a function of the program, so a body calling it is read against it. */
  private declareFunction(line: IrLine): void {
    const header = this.header(line);
    this.binder.declare({ name: header.name, symbol: header.symbol, params: header.params, returns: header.text }, []);
  }

  /** The effects a function states, which the line says as a list. */
  private effectsOf(): Effect[] {
    const line = this.line(2);
    this.at += 1;
    if (headOf(line) !== "effects") fail(line.number, '"effects"', line.text);
    const scanner = this.scanner(line);
    const effects: Effect[] = [];
    for (;;) {
      scanner.separator();
      if (scanner.peek() === "") break;
      const word = scanner.word();
      if (word === "none") break;
      effects.push(scanner.oneOf(word, EFFECTS));
    }
    scanner.end();
    return effects;
  }

  /** The conditions a function is held to, which a program function states none of. */
  private conditions(keyword: "requires" | "ensures"): string[] {
    const conditions: string[] = [];
    for (let line = this.peek(); line !== null && line.indent === 2 && headOf(line) === keyword; line = this.peek()) {
      this.at += 1;
      const scanner = this.scanner(line);
      scanner.skip();
      if (scanner.peek() === '"') {
        conditions.push(scanner.string());
        continue;
      }
      const none = scanner.word();
      if (none !== "none") scanner.refuse('"none" or a condition in quotes', none);
      scanner.end();
    }
    return conditions;
  }

  /** What a function does beyond its result, as the word it is written with. */
  private flag(keyword: string): boolean {
    const line = this.line(2);
    this.at += 1;
    if (headOf(line) !== keyword) fail(line.number, `"${keyword}"`, line.text);
    const scanner = this.scanner(line);
    const word = scanner.oneOf(scanner.word(), FLAGS);
    scanner.end();
    return word === "yes";
  }

  /** The parameters of a function, as the slots its body reads them by. */
  private parameters(): SemanticSlot[] {
    const params: SemanticSlot[] = [];
    for (let line = this.peek(); line !== null && line.indent === 2 && headOf(line) === "param"; line = this.peek()) {
      this.at += 1;
      params.push(this.slot(this.scanner(line)));
    }
    return params;
  }

  /** The calls a body makes, in the order the text lists them. */
  private callEdges(): CallEdge[] {
    const calls: CallEdge[] = [];
    for (let line = this.peek(); line !== null && line.indent === 2 && headOf(line) === "call"; line = this.peek()) {
      this.at += 1;
      const scanner = this.scanner(line);
      const callee = scanner.word();
      scanner.end();
      this.binder.bind(callee, line.number);
      calls.push({ callee, strategy: "call" });
    }
    return calls;
  }

  private file(): string {
    const line = this.line(0);
    this.at += 1;
    if (headOf(line) !== "file") fail(line.number, '"file" and the source it was written in', line.text);
    const scanner = this.scanner(line);
    const file = scanner.string();
    scanner.end();
    return file;
  }

  /**
   * A function the program calls. What it takes and what it hands back are the
   * contract's to state, so the line is read to be sure of what it says and
   * the signature is the one the contract binds the name to.
   */
  private function(line: IrLine): FunctionSignature {
    const scanner = this.scanner(line);
    const name = scanner.word();
    let alias = name;
    if (scanner.peek() === " ") {
      scanner.keyword("as");
      alias = scanner.word();
    }
    scanner.expect("(");
    for (;;) {
      scanner.skip();
      if (scanner.peek() === ")") break;
      scanner.word();
      scanner.expect(":");
      scanner.type();
      scanner.skip();
      if (scanner.peek() !== ",") break;
      scanner.expect(",");
    }
    scanner.expect(")");
    scanner.expect("->");
    scanner.type();
    scanner.end();

    const bound = this.binder.find(name) ?? (alias === name ? null : this.binder.find(alias));
    if (bound === null) {
      const compiled = this.binder.names().join(", ") || "no functions";
      fail(line.number, `a function this program declares, one of: ${compiled}`, line.text);
    }
    return bound.signature;
  }

  /**
   * A layout the program hands back, which the contract states. The fields the
   * line names are read to be sure of what it says; the layout itself is the
   * one the contract hands back, so a model cannot lay an object out for itself.
   */
  private object(line: IrLine, objects: Record<string, ObjectLayout>): void {
    const scanner = this.scanner(line);
    const name = scanner.word();
    scanner.keyword("size");
    scanner.integer();
    scanner.keyword("align");
    scanner.integer();
    scanner.end();
    objects[name] = this.binder.layout(name, line.number);

    while (this.atIndent(2) && headOf(this.lines[this.at]) === "field") {
      const field = this.line(2);
      this.at += 1;
      const fields = this.scanner(field);
      fields.word();
      fields.expect(":");
      fields.type();
      fields.keyword("at");
      fields.integer();
      fields.end();
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Reading the function                                                        */
/* -------------------------------------------------------------------------- */

/**
 * One function, read a line at a time in the shape the printer wrote it. The
 * header is read against the contract the function was declared in, so every
 * name, type, condition, effect and layout in it comes from there and a line
 * that says otherwise is an error naming itself rather than a new declaration.
 */
class FunctionReader extends BlockReader {
  /** The one function the text holds, and the end of the text after it. */
  function(): SemanticFunction {
    const fn = this.described();
    this.finish("the end of the function");
    return fn;
  }

  /** Every function of one file, in the order the text lists them. */
  module(): SemanticModule {
    const version = this.line(0);
    this.at += 1;
    if (version.text !== `ir ${VERSION}`) fail(version.number, `"ir ${VERSION}"`, version.text);
    const head = this.line(0);
    this.at += 1;
    if (headOf(head) !== "module") fail(head.number, '"module" and the file it was written in', head.text);
    const scanner = this.scanner(head);
    const path = scanner.string();
    scanner.end();
    const functions: SemanticFunction[] = [];
    while (this.peek() !== null) functions.push(this.described());
    return { path, functions };
  }

  /**
   * One function whole: the signature the contract declares, the header it is
   * held to and does, the objects it lays out, the calls it makes, the slots
   * its parameters are read as, and the body it runs.
   */
  private described(): SemanticFunction {
    const line = this.line(0);
    this.at += 1;
    if (headOf(line) !== "function") {
      fail(line.number, '"function" and the name of the function', line.text);
    }
    const scanner = this.scanner(line);
    const name = scanner.word();
    let symbol = name;
    if (scanner.peek() === " ") {
      scanner.keyword("as");
      symbol = scanner.word();
    }
    const written: { name: string; type: SemanticType }[] = [];
    scanner.expect("(");
    for (;;) {
      scanner.skip();
      if (scanner.peek() === ")") break;
      const param = scanner.word();
      scanner.expect(":");
      written.push({ name: param, type: scanner.type() });
      scanner.skip();
      if (scanner.peek() !== ",") break;
      scanner.expect(",");
    }
    scanner.expect(")");
    scanner.expect("->");
    const returns = scanner.type();
    scanner.end();

    const declared = this.binder.declaration(name, line.number);
    const signature = declared.function;
    if (symbol !== signature.symbol) {
      fail(line.number, `the symbol the contract declares, "${signature.symbol}"`, symbol);
    }
    if (written.length !== signature.params.length) {
      const named = signature.params.map((param) => param.name).join(", ") || "no parameters";
      fail(line.number, `the parameters the contract declares: ${named}`, line.text);
    }
    for (let index = 0; index < written.length; index += 1) {
      const expected = signature.params[index];
      if (written[index].name !== expected.name) {
        fail(line.number, `the parameter the contract declares, "${expected.name}"`, written[index].name);
      }
      if (!typeEquals(written[index].type, parseType(expected.type))) {
        fail(line.number, `the type the contract declares for "${expected.name}", "${expected.type}"`, typeText(written[index].type));
      }
    }
    if (!typeEquals(returns, parseType(signature.returns))) {
      fail(line.number, `the return type the contract declares, "${signature.returns}"`, typeText(returns));
    }

    const requires = this.conditions("requires", declared.requires);
    const ensures = this.conditions("ensures", declared.ensures);
    const allocates = this.flag("allocates", declared.definition.allocates);
    const prints = this.flag("prints", declared.definition.prints);
    const readsArgv = this.flag("reads_argv", declared.definition.readsArgv);
    const effects = this.effects(declared.effects);
    const objects = this.objects();
    const calls = this.calls(declared);
    const params = this.params(signature);
    // Every function the IR holds has a body, so a function written without
    // one is a function that does not describe what the compiler resolved.
    const body = this.peek();
    if (body === null || body.indent !== 2 || headOf(body) !== "block") {
      fail(line.number, 'the body of the function, as "block" and the name of its first block', body?.text ?? "the end of the function");
    }
    const entry = this.block(2, false).body;
    return { name, symbol, params, returns, requires, ensures, effects, allocates, prints, readsArgv, objects, calls, entry };
  }

  /**
   * The conditions a function is held to, one to a line. A condition is a claim
   * in the contract's own language, so it is quoted, and `none` is how a
   * function with no condition of that kind says so.
   */
  private conditions(keyword: "requires" | "ensures", declared: readonly string[]): string[] {
    const conditions: string[] = [];
    let first: IrLine | null = null;
    for (let line = this.peek(); line !== null && line.indent === 2 && headOf(line) === keyword; line = this.peek()) {
      if (first === null) first = line;
      this.at += 1;
      const scanner = this.scanner(line);
      scanner.skip();
      if (scanner.peek() === '"') {
        conditions.push(scanner.string());
      } else {
        const none = scanner.word();
        if (none !== "none") scanner.refuse('"none" or a condition in quotes', none);
      }
      scanner.end();
    }
    const same = conditions.length === declared.length && conditions.every((condition, index) => condition === declared[index]);
    if (!same) {
      const at = this.where(first);
      const stated = declared.length === 0 ? "none" : declared.map(stringLiteral).join(" ");
      fail(at.number, `the ${keyword} the contract states: ${stated}`, at.text);
    }
    return conditions;
  }

  /** What the contract states a function does, as the word it states it with. */
  private flag(keyword: string, declared: boolean): boolean {
    const line = this.line(2);
    this.at += 1;
    const scanner = this.scanner(line);
    const word = scanner.oneOf(scanner.word(), FLAGS);
    scanner.end();
    if ((word === "yes") !== declared) {
      fail(line.number, `${keyword} ${flagText(declared)}, which the contract states`, word);
    }
    return declared;
  }

  /** What a function does beyond computing its result, which the contract states. */
  private effects(declared: readonly Effect[]): Effect[] {
    const line = this.line(2);
    this.at += 1;
    const scanner = this.scanner(line);
    const effects: Effect[] = [];
    for (;;) {
      scanner.separator();
      if (scanner.peek() === "") break;
      const word = scanner.word();
      if (word === "none") break;
      effects.push(scanner.oneOf(word, EFFECTS));
    }
    scanner.end();
    if (effects.length !== declared.length || !effects.every((effect) => declared.includes(effect))) {
      const stated = declared.length === 0 ? "none" : declared.join(" ");
      fail(line.number, `the effects the contract states: ${stated}`, line.text);
    }
    return [...declared];
  }

  /**
   * The layouts the function hands back, each of them the one the contract lays
   * out. The lines are read to be sure of what they say and then compared with
   * the layout the contract hands back, so a model cannot lay out an object for
   * itself by writing a different one down.
   */
  private objects(): Record<string, ObjectLayout> {
    const objects: Record<string, ObjectLayout> = {};
    for (let line = this.peek(); line !== null && line.indent === 2 && headOf(line) === "object"; line = this.peek()) {
      this.at += 1;
      const scanner = this.scanner(line);
      const name = scanner.word();
      scanner.keyword("size");
      scanner.integer();
      scanner.keyword("align");
      scanner.integer();
      scanner.end();
      const written = [line.text];
      while (this.atIndent(4) && headOf(this.lines[this.at]) === "field") {
        const field = this.line(4);
        this.at += 1;
        const fields = this.scanner(field);
        fields.word();
        fields.expect(":");
        fields.type();
        fields.keyword("at");
        fields.integer();
        fields.end();
        written.push(field.text);
      }
      const layout = this.binder.layout(name, line.number);
      const stated = objectLines(name, layout, 0).map((text) => text.trimStart());
      if (written.join("\n") !== stated.join("\n")) {
        fail(line.number, `the layout the contract lays out: ${stated.join(" / ")}`, line.text);
      }
      objects[name] = layout;
    }
    return objects;
  }

  /** The calls the body makes, each of them an edge the contract records. */
  private calls(declared: FunctionContract): CallEdge[] {
    const recorded = declared.definition.calls;
    // What this body may name is not only what this body names. A candidate is
    // handed the body of any callee it is told to write out, and a body written
    // out brings the calls that body makes with it — so `report` writing out
    // `leaf` may call `twice`, because `leaf` is what calls it. Anything past
    // that is not this function's to reach: the set is closed over written-out
    // callees only, so a call behind a real call is still somebody else's.
    this.reachable = new Set<string>(recorded.map((call) => call.callee));
    const queue = recorded.filter((call) => call.strategy === "inline").map((call) => call.callee);
    for (let at = 0; at < queue.length; at += 1) {
      for (const call of this.binder.callsOf(queue[at])) {
        if (this.reachable.has(call)) continue;
        this.reachable.add(call);
        queue.push(call);
      }
    }
    const calls: CallEdge[] = [];
    for (let line = this.peek(); line !== null && line.indent === 2 && headOf(line) === "call"; line = this.peek()) {
      this.at += 1;
      const scanner = this.scanner(line);
      const callee = scanner.word();
      scanner.end();
      this.binder.bind(callee, line.number);
      const edge = recorded.find((call) => call.callee === callee);
      if (edge !== undefined) {
        calls.push({ callee: edge.callee, strategy: edge.strategy });
        continue;
      }
      // A callee this function does not name but may, because it sits behind a
      // body it writes out. It is a real call in this object, so it is a call
      // and not a write-out: the body it came from is already inside.
      if (this.reachable.has(callee)) {
        calls.push({ callee, strategy: "call" });
        continue;
      }
      const reached = [...this.reachable].join(", ") || "no calls";
      fail(line.number, `a call this function may make, one of: ${reached}`, callee);
    }
    // A callee the body writes out is one it declares no call for, so the list
    // a candidate gives is a subset of the contract's, not the whole of it.
    // What it may not do is declare a call twice, which would be a body whose
    // reach the list does not describe.
    for (const edge of calls) {
      if (calls.filter((other) => other.callee === edge.callee).length > 1) {
        fail(this.where(null).number, `each callee declared once, and ${edge.callee} is declared twice`, edge.callee);
      }
    }
    // The body is checked against this list as it is read, so the list is where
    // the reader learns what the body is allowed to reach.
    this.declaredCallees = calls.map((edge) => edge.callee);
    return calls;
  }

  /**
   * The parameters, as the slots the body reads them by. A slot is named and
   * typed by the body, so the contract only fixes which names there are and how
   * many: a parameter the signature declares and no slot reads is a body that
   * left one out.
   */
  private params(declared: FunctionSignature): SemanticSlot[] {
    const params: SemanticSlot[] = [];
    for (let line = this.peek(); line !== null && line.indent === 2 && headOf(line) === "param"; line = this.peek()) {
      this.at += 1;
      const scanner = this.scanner(line);
      const slot = this.slot(scanner);
      scanner.end();
      const expected = declared.params[params.length];
      if (expected === undefined || expected.name !== slot.name) {
        const named = declared.params.map((param) => param.name).join(", ") || "no parameters";
        fail(line.number, `a parameter the signature declares, one of: ${named}`, slot.name);
      }
      params.push(slot);
    }
    if (params.length !== declared.params.length) {
      const at = this.where(null);
      const named = declared.params.map((param) => param.name).join(", ") || "no parameters";
      fail(at.number, `a slot for every parameter the signature declares, one of: ${named}`, at.text);
    }
    return params;
  }
}

/**
 * Reads a function back, binding every callee to the contract it was declared
 * in. The contract is what the header is checked against, so a signature, a
 * condition, an effect, a parameter or a layout the text disagrees with is an
 * error naming its line, never a wider function read back.
 */
export function parseSemanticFunction(text: string, contract: ProgramContract): SemanticFunction {
  return new FunctionReader(readLines(text), new ContractBinder(contract)).function();
}

/** Reads a file's functions back, in the order the text lists them. */
export function parseSemanticModule(text: string, contract: ProgramContract): SemanticModule {
  return new FunctionReader(readLines(text), new ContractBinder(contract)).module();
}


/**
 * The semantic IR: what a program does, once the source language is done with.
 *
 * The IR is target independent and typed at every node. A value states the type
 * it is, an operation states the type it computes, a call states the signature
 * it is made against, and control flow is written as blocks that name the
 * blocks they leave for. Nothing here names a register, a stack offset, a
 * calling convention or a machine instruction, so one program lowers to every
 * target:
 *
 *   Semantic IR  ->  x86-64  |  ARM64  |  WebAssembly
 *
 * Backends choose instruction selection, register allocation, memory layout and
 * calling convention. What they are given is a program they can read: the
 * compiler validates this IR before any backend sees it, so a program that
 * cannot be lowered never reaches a target toolchain.
 */

import type {
  CallEdge,
  Effect,
  FunctionSignature,
  ObjectLayout,
  PrimitiveTypeName,
  TypeExpr,
} from "./types.ts";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/** A string. The contract type language has no string type, so the IR names it. */
export interface TextType {
  kind: "text";
}

/** A value type: a contract type, or a string. */
export type SemanticType = TypeExpr | TextType;

export const TEXT: TextType = { kind: "text" };

export const BOOLEAN: TypeExpr = { kind: "primitive", name: "bool" };

export const VOID: TypeExpr = { kind: "void" };

/** The primitive types a number is written as. */
export const NUMERIC: readonly PrimitiveTypeName[] = [
  "i8",
  "i16",
  "i32",
  "i64",
  "u8",
  "u16",
  "u32",
  "u64",
  "f32",
  "f64",
  "usize",
  "isize",
];

export function isTextType(type: SemanticType): type is TextType {
  return type.kind === "text";
}

export function isNumber(type: SemanticType): type is TypeExpr & { kind: "primitive" } {
  return type.kind === "primitive" && (NUMERIC as readonly string[]).includes(type.name);
}

export function isFloat(type: SemanticType | null): boolean {
  return type !== null && isNumber(type) && type.name.startsWith("f");
}

export function isUnsigned(type: SemanticType): boolean {
  return isNumber(type) && (type.name.startsWith("u") || type.name === "usize");
}

export function isBoolean(type: SemanticType): boolean {
  return type.kind === "primitive" && type.name === "bool";
}

/** A type a reference is held as: a pointer to an object, or a slice. */
export function isReference(type: SemanticType): boolean {
  return type.kind === "ref" || type.kind === "ptr" || type.kind === "slice";
}

/** True for a type this IR knows how to read a length and an element out of. */
export function isSequence(type: SemanticType): boolean {
  return type.kind === "array" || type.kind === "slice" || type.kind === "ptr";
}

/** A type as the IR text names it. The contract text is the canonical form. */
export function typeText(type: SemanticType): string {
  switch (type.kind) {
    case "primitive":
      return type.name;
    case "text":
      return "text";
    case "ptr":
      return `${typeText(type.of)}*`;
    case "slice":
      return `[]${typeText(type.of)}`;
    case "array":
      return type.length === null ? `[${typeText(type.of)}]` : `[${typeText(type.of)}; ${type.length}]`;
    case "ref":
      return type.name === undefined ? "ref<any>" : `ref<${type.name}>`;
    case "void":
      return "void";
  }
}

/** Reads a type back out of the text the IR is written in. */
export function isSemanticType(value: unknown): value is SemanticType {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  switch (kind) {
    case "primitive":
      return (NUMERIC as readonly string[]).includes((value as { name?: string }).name ?? "") ||
        (value as { name?: string }).name === "bool";
    case "text":
    case "void":
      return true;
    case "ptr":
    case "slice":
      return isSemanticType((value as { of?: unknown }).of);
    case "array":
      return (
        isSemanticType((value as { of?: unknown }).of) &&
        ((value as { length?: unknown }).length === null || typeof (value as { length?: unknown }).length === "number")
      );
    case "ref":
      // A reference carries the type it points at under `of`, and the name of
      // the object it points at under `name`. Reading `of` as if it were the
      // name refused a legal `ref<f64>` — the shape `semantics/contract.ts`
      // parses and the shape this IR's own text writes — and accepted a
      // `ref` whose name was a number.
      return (
        ((value as { of?: unknown }).of === null || isSemanticType((value as { of?: unknown }).of)) &&
        ((value as { name?: unknown }).name === undefined || typeof (value as { name?: unknown }).name === "string")
      );
    default:
      return false;
  }
}

/** Two types are the same when a value of one needs no conversion for the other. */
export function typeEquals(left: SemanticType, right: SemanticType): boolean {
  return typeText(left) === typeText(right);
}

const WHOLE_RANK: Record<string, number> = {
  i8: 1,
  u8: 1,
  i16: 2,
  u16: 2,
  i32: 3,
  u32: 3,
  i64: 4,
  u64: 4,
  isize: 4,
  usize: 4,
};

/** The number two numbers are computed as, a whole pair included. */
function promoted(left: PrimitiveTypeName, right: PrimitiveTypeName): PrimitiveTypeName {
  if (left === "f32" || left === "f64" || right === "f32" || right === "f64") {
    return left === "f32" && right === "f32" ? "f32" : "f64";
  }
  return wholeOf(left, right);
}

/**
 * The type two numbers are compared as. A number no use has fixed is a double
 * and takes the type of the side it is compared with, so a whole number is not
 * compared as a double of its own; a whole number compared with a double is a
 * double, so `2 < 2.5` is the comparison the source wrote rather than one
 * rounded to whole numbers.
 */
export function commonNumber(left: SemanticType | null, right: SemanticType | null): SemanticType | null {
  if (left === null && right === null) return null;
  if (left === null) return right !== null && isNumber(right) ? right : null;
  if (right === null) return isNumber(left) ? left : null;
  if (!isNumber(left) || !isNumber(right)) return null;
  return left.name === right.name ? left : { kind: "primitive", name: promoted(left.name, right.name) };
}

/**
 * True when a number is a whole number. `f32`, `f64` and `bool` are not, and
 * everything else is.
 */
export function isWhole(type: PrimitiveTypeName): boolean {
  return type !== "f32" && type !== "f64" && type !== "bool";
}

/** True when a type is a whole number, which is what a shift and a remainder are. */
export function isInteger(type: SemanticType): boolean {
  return isNumber(type) && isWhole(type.name);
}

/**
 * The whole number type two whole numbers have in common. This is the rule
 * `semantics/contract.ts` evaluates an expression with, and the rule every
 * backend is handed the type from, so one program cannot be answered two ways:
 * a `usize` is over everything, an `isize` over the rest, and at one width the
 * unsigned of the pair, because a value above the signed range of that width is
 * above it as an unsigned number and a negative number as a signed one.
 */
export function wholeOf(a: PrimitiveTypeName, b: PrimitiveTypeName): PrimitiveTypeName {
  if (a === b) return a;
  if (a === "usize" || b === "usize") return "usize";
  if (a === "isize" || b === "isize") return "isize";
  const rank = Math.max(WHOLE_RANK[a] ?? 0, WHOLE_RANK[b] ?? 0);
  const widest: readonly PrimitiveTypeName[] = [a, b].filter((name) => (WHOLE_RANK[name] ?? 0) === rank);
  for (const unsigned of ["u64", "u32", "u16", "u8"] as const) {
    if (widest.includes(unsigned)) return unsigned;
  }
  return widest[0] ?? "i64";
}

/**
 * Whether a value of one type may be used where another is expected. A use
 * converts inside a kind and never across kinds: a whole number written where
 * a double is read, an array written where a slice of the same element is
 * read. A number is not a truth and a reference is not an array, so a use that
 * would have to mean one as the other is refused rather than converted.
 */
export function convertibleTo(from: SemanticType, to: SemanticType): boolean {
  if (typeEquals(from, to)) return true;
  if (isNumber(from) && isNumber(to)) return true;
  if (isTextType(from) && isTextType(to)) return true;
  if (isReference(from) && isReference(to)) return true;
  if (isSequence(from) && isSequence(to)) {
    const left = elementTypeOf(from);
    const right = elementTypeOf(to);
    return left !== null && right !== null && (typeEquals(left, right) || (isNumber(left) && isNumber(right)));
  }
  return false;
}

/** The element type of an array, a slice or a pointer, or null if it has none. */
export function elementTypeOf(type: SemanticType): SemanticType | null {
  return type.kind === "array" || type.kind === "slice" || type.kind === "ptr" ? type.of : null;
}

/* -------------------------------------------------------------------------- */
/* Values                                                                     */
/* -------------------------------------------------------------------------- */

/** One piece of a string: text as written, or a value interpolated into it. */
export type SemanticTextPart = { k: "text"; value: string } | { k: "value"; value: SemanticValue };

/** Arithmetic the IR states, each with the type it computes. */
export type ArithOp =
  | "add"
  | "sub"
  | "mul"
  | "div"
  | "mod"
  | "pow"
  | "min"
  | "max"
  | "shl"
  | "shr"
  | "ushr"
  | "and"
  | "or"
  | "xor"
  /** Text added to text. */
  | "concat";

/** The six comparisons, over one operand type. */
export type CompareOp = "eq" | "ne" | "lt" | "le" | "gt" | "ge";

/** What one value computes. */
export type UnaryOp = "neg" | "pos" | "not" | "bitNot";

/** A value, with the type it is. Nothing here is untyped. */
export type SemanticValue =
  /** A number written out, of the type it is used at. */
  | { k: "const"; type: SemanticType; text: string }
  /** A string, written out or built at run time. */
  | { k: "text"; type: TextType; parts: SemanticTextPart[] }
  | { k: "bool"; type: TypeExpr; value: boolean }
  /** Nothing: a null reference, a null string, a value nothing types. */
  | { k: "nothing"; type: SemanticType }
  /** A value the program declared, read by the name it was declared as. */
  | { k: "local"; type: SemanticType; name: string }
  /** The length of an array, a slice or a string. */
  | { k: "length"; type: SemanticType; of: SemanticValue }
  /** One element of an array or a slice. */
  | { k: "element"; type: SemanticType; of: SemanticValue; index: SemanticValue }
  /**
   * A typed array, allocated where the program wrote it out. `length` is the
   * number of elements the program wrote down and `count` the number it
   * settled on when it ran, and a `view` is a window of a block another name
   * holds rather than a block of its own: the byte offset it starts at, and
   * the block it starts in.
   */
  | {
      k: "buffer";
      type: SemanticType;
      element: SemanticType;
      length: number | null;
      count: SemanticValue | null;
      view: { of: SemanticValue; offset: SemanticValue } | null;
      values: SemanticValue[];
    }
  /**
   * An object on the heap, allocated and filled as one value. Its fields are
   * written where the object is built rather than beside it, so an object built
   * in the arm of a conditional is built when that arm is taken — which is what
   * the source means, and what hoisting the allocation out of the arm would
   * stop meaning.
   */
  | { k: "newObject"; type: SemanticType; layout: string; fields: { name: string; value: SemanticValue }[] }
  /**
   * One field of an object, read out of it. A field is a field of a layout, so
   * the access names the layout: a reference is a pointer, and a pointer has
   * no fields of its own.
   */
  | { k: "loadField"; type: SemanticType; object: SemanticValue; layout: string; field: string }
  /** A call, with everything a backend needs to make it. */
  | { k: "call"; type: SemanticType; call: SemanticCall }
  | { k: "arith"; type: SemanticType; op: ArithOp; left: SemanticValue; right: SemanticValue }
  | { k: "compare"; type: TypeExpr; op: CompareOp; operand: SemanticType; left: SemanticValue; right: SemanticValue }
  /** `a && b` and `a || b`, which decide on the left arm and return an arm. */
  | { k: "logical"; type: SemanticType; op: "and" | "or"; left: SemanticValue; right: SemanticValue }
  /** `a ?? b`, which is the right arm when the left one is nothing. */
  | { k: "coalesce"; type: SemanticType; left: SemanticValue; right: SemanticValue }
  /** `condition ? then : otherwise`. */
  | { k: "select"; type: SemanticType; condition: SemanticValue; then: SemanticValue; otherwise: SemanticValue }
  | { k: "unary"; type: SemanticType; op: UnaryOp; operand: SemanticValue }
  /** `a === null` and `a !== null`. */
  | { k: "isNull"; type: TypeExpr; operand: SemanticValue; negate: boolean }
  /** A number written as text, as a string carries it. */
  | { k: "toText"; type: TextType; of: SemanticValue; digits: number | null }
  /** `process.argv`, or one of its arguments. */
  | { k: "argv"; type: SemanticType; index: SemanticValue | null };

/** What a value is, as printing and truth read it. */
export type ValueKind = "text" | "number" | "boolean" | "null" | "reference";

/**
 * What a value holds, read off its type. An empty string is false and an
 * absent reference is false, as they are in the language, so a backend asking
 * for a truth gets one answer for the whole IR.
 */
export function valueKind(value: SemanticValue): ValueKind {
  if (value.k === "nothing") return "null";
  if (isTextType(value.type)) return "text";
  if (isBoolean(value.type)) return "boolean";
  if (isReference(value.type)) return "reference";
  return "number";
}

/** Every value a value is made of, the value itself included. */
export function walkValues(value: SemanticValue, visit: (value: SemanticValue) => void): void {
  visit(value);
  switch (value.k) {
    case "text":
      for (const part of value.parts) if (part.k === "value") walkValues(part.value, visit);
      return;
    case "length":
      walkValues(value.of, visit);
      return;
    case "toText":
      walkValues(value.of, visit);
      return;
    case "isNull":
    case "unary":
      walkValues(value.operand, visit);
      return;
    case "element":
      walkValues(value.of, visit);
      walkValues(value.index, visit);
      return;
    case "argv":
      // The index of an argument is an expression of its own, and a call
      // written in it is a call the value makes: `hasCall` answers for it, and
      // so does the rule that a left arm is written once. An index the walk
      // does not read makes both answer "nothing here", and the backend writes
      // the call down under the test and again under the value.
      if (value.index !== null) walkValues(value.index, visit);
      return;
    case "call":
      for (const argument of value.call.args) walkValues(argument, visit);
      return;
    case "arith":
    case "compare":
    case "logical":
    case "coalesce":
      walkValues(value.left, visit);
      walkValues(value.right, visit);
      return;
    case "buffer":
      if (value.count !== null) walkValues(value.count, visit);
      if (value.view !== null) {
        walkValues(value.view.of, visit);
        walkValues(value.view.offset, visit);
      }
      for (const element of value.values) walkValues(element, visit);
      return;
    case "loadField":
      walkValues(value.object, visit);
      return;
    case "newObject":
      // The fields of an object being built are values of their own: a name
      // read in one and a call written into one are both what the body reads
      // and makes, and a rule that walks a value has to see them.
      for (const field of value.fields) walkValues(field.value, visit);
      return;
    case "select":
      walkValues(value.condition, visit);
      walkValues(value.then, visit);
      walkValues(value.otherwise, visit);
      return;
    default:
      return;
  }
}

/**
 * True when writing a value twice would not write it twice.
 *
 * A backends that keeps a value in a register across the writing of another
 * one may only do that if writing the other one calls nothing: a call is
 * written with the very argument registers a held value sits in, so it takes
 * the register away from whatever was left there.
 *
 * `k === "call"` is not enough to answer that. A value that names no call
 * still makes one on a target that has no instruction for it: a number
 * written as text is a runtime formatter (`ir-machine.ts:1573`), an array the
 * program wrote out is a runtime allocation (`:1656`), an object is one too
 * (`:1686`), a string with anything interpolated in it is an allocation and a
 * copy (`:1452`), a whole number raised to a power is `pow` (`:1210`), an
 * argument of the program is read by a runtime call (`:983`), two strings
 * compared are compared by `strcmp` (`:1324`), and the length of a string is
 * counted by `strlen` (`:1595`). Each of those takes the registers it is
 * written with away from a value held beside it, so each of them is a call as
 * far as this question is concerned.
 *
 * The answer is deliberately one target cannot answer cheaply: a length that
 * one backend reads out of memory with an instruction is a call here all the
 * same, because the other backend asks the runtime and this predicate is one
 * answer for both. Over-answering costs a held value and a reload. Under-
 * answering writes a value into a register a call has taken.
 */
export function hasCall(value: SemanticValue): boolean {
  let called = false;
  walkValues(value, (inner) => {
    if (makesCall(inner)) called = true;
  });
  return called;
 }

/** Whether one value, written on its own, calls anything. */
function makesCall(value: SemanticValue): boolean {
  switch (value.k) {
    case "call":
    case "argv":
    case "toText":
    case "buffer":
    case "newObject":
    case "length":
      return true;
    case "text":
      // A string written out in the source is laid down in the object beside
      // the code; one with anything computed in it is built at run time.
      return value.parts.some((part) => part.k === "value");
    case "arith":
      return value.op === "pow";
    case "compare":
      return isTextType(value.operand);
    default:
      return false;
  }
}

/** The names a value reads, in the order it reads them. */
export function localNames(value: SemanticValue): string[] {
  const names: string[] = [];
  walkValues(value, (inner) => {
    if (inner.k === "local") names.push(inner.name);
  });
  return names;
}

/* -------------------------------------------------------------------------- */
/* Calls                                                                      */
/* -------------------------------------------------------------------------- */

/** Who owns what a call hands back. */
export type Ownership =
  /** Nothing to free: a number, a text that is a literal, anything scalar. */
  | "none"
  /** A reference the callee keeps, which the caller may read but not free. */
  | "borrowed"
  /** A reference the caller owns and must release. */
  | "owned";

/**
 * A call, with everything a backend needs to make it and nothing about how it
 * is made: the callee, the arguments, the type of every argument, the type it
 * returns, the effects it has and who owns what it hands back.
 */
export interface SemanticCall {
  /** The function called, as the contract names it. */
  callee: string;
  /** The signature the call is made against. */
  signature: FunctionSignature;
  args: SemanticValue[];
  /** The type every argument is passed as, one per argument. */
  argTypes: SemanticType[];
  returns: SemanticType;
  /** What the call does beyond computing its result. */
  effects: Effect[];
  ownership: Ownership;
  /** True when the caller must retain the result to keep it alive. */
  retain: boolean;
  /** A function the compiler itself provides, as `Math.abs` is. */
  builtin: boolean;
}

/* -------------------------------------------------------------------------- */
/* Storage                                                                    */
/* -------------------------------------------------------------------------- */

/** What a declared name holds, and the type it is read as. */
export type SemanticSlot =
  /** A number, a truth, a reference: one value of one type. */
  | { kind: "value"; name: string; mutable: boolean; type: SemanticType }
  /** A string, as text when the program wrote it out, or built at run time. */
  | { kind: "text"; name: string; mutable: boolean }
  /**
   * An array the program allocated, written out element by element where the
   * count was settled on when the program ran. A view is a buffer too: it holds
   * no block of its own, and the block it looks into is freed under its own
   * name, which the program declared before it.
   */
  | { kind: "buffer"; name: string; mutable: boolean; element: TypeExpr; length: number | null }
  /** A reference to an object one of the compiled functions returned. */
  | { kind: "object"; name: string; mutable: boolean; type: SemanticType };

/** The type a slot is declared and read as. */
export function slotType(slot: SemanticSlot): SemanticType {
  switch (slot.kind) {
    case "value":
    case "object":
      return slot.type;
    case "text":
      return TEXT;
    case "buffer":
      return { kind: "array", of: slot.element, length: slot.length };
  }
}

/** Every block of a statement that is a block of its own. */
export function statementBlocksOf(statement: SemanticStatement): readonly SemanticBlock[] {
  switch (statement.k) {
    case "if": return [statement.then, statement.otherwise].filter((one): one is SemanticBlock => one !== null);
    case "loop": return [statement.loop.body];
    case "block": return [statement.body];
    default: return [];
  }
}

/**
 * Every value a statement computes, in the order it computes them.
 *
 * A call is one value whose own children are its arguments, which is how a walk
 * of a block already reads it, so a name read as an argument is read here too.
 * A walk that stopped at the call would count a name that is read in one as a
 * name nothing reads, and a pass that drops unread bindings would then drop one
 * a call still reads. A fill reads the value it writes into every element, and
 * writes the array rather than reading it: the array is a name the block owns
 * either way.
 */
export function statementValues(statement: SemanticStatement): readonly SemanticValue[] {
  switch (statement.k) {
    case "let":
    case "set":
    case "printText":
    case "printNumber":
    case "retain":
    case "storeField": return [statement.value];
    case "step": return [];
    case "fill": return [statement.value];
    case "setElement": return [statement.index, statement.value];
    case "if": return [statement.condition];
    case "raise": return [statement.message];
    case "call": return [{ k: "call", type: statement.call.returns, call: statement.call }];
    case "loop": {
      const loop = statement.loop;
      if (loop.kind === "counted") return [loop.from, loop.to, ...(loop.step === null ? [] : [loop.step])];
      return loop.kind === "each" ? [loop.length] : [loop.condition];
    }
    default: return [];
  }
}

/* -------------------------------------------------------------------------- */
/* Control flow                                                               */
/* -------------------------------------------------------------------------- */

/** How a block ends. Every block ends in exactly one of these. */
export type SemanticTerminator =
  /** The block ends and what follows it runs. */
  | { k: "next" }
  /**
   * The function ends, handing back what the block computed. A program ends
   * with nothing to hand back, so its return carries nothing; a function's
   * return carries the value of its declared return type, or nothing for a
   * function that returns nothing. Only the entry block ends this way.
   */
  | { k: "return"; value: SemanticValue | null }
  /**
   * The block is left for another one, after freeing what it owns on the way
   * out. A jump names a loop header (`continue`) or a loop exit (`break`).
   */
  | { k: "jump"; target: string; releases: string[] };

/** A run of statements, and where control goes when they are done. */
export interface SemanticBlock {
  id: string;
  statements: SemanticStatement[];
  /** What this block owns, freed when control leaves it by falling out of it. */
  releases: string[];
  terminator: SemanticTerminator;
}

/** A loop, with the blocks a `break` and a `continue` leave for. */
export type SemanticLoop =
  | {
      kind: "while";
      condition: SemanticValue;
      header: string;
      exit: string;
      body: SemanticBlock;
    }
  | {
      kind: "doWhile";
      condition: SemanticValue;
      header: string;
      exit: string;
      body: SemanticBlock;
    }
  | {
      kind: "counted";
      variable: string;
      type: SemanticType;
      from: SemanticValue;
      to: SemanticValue;
      inclusive: boolean;
      down: boolean;
      /** The step as written, or null for the implicit one. */
      step: SemanticValue | null;
      header: string;
      exit: string;
      body: SemanticBlock;
    }
  | {
      kind: "each";
      /** The index the walk counts with, named once here and nowhere else. */
      index: string;
      element: string;
      elementType: TypeExpr;
      of: string;
      length: SemanticValue;
      header: string;
      exit: string;
      body: SemanticBlock;
    };

/** The operators `op=` accepts. */
export type SemanticAssignOp = "=" | "+=" | "*=" | "-=" | "/=" | "%=";

/**
 * The line of the source a statement was written on, for one that states
 * none. A statement carries that line so a diagnostic can name the place in
 * the program it came from, and nothing is computed from it: the frontend
 * always knows the line, and a candidate that states none is a body that
 * computes the same thing without it.
 */
export const UNSTATED_LINE = 0;

/** What a program does, one statement at a time. */

export type SemanticStatement =
  /** A name declared, with what it holds and what it starts as. */
  | { k: "let"; slot: SemanticSlot; value: SemanticValue; line: number }
  | { k: "set"; name: string; op: SemanticAssignOp; value: SemanticValue; line: number }
  | { k: "setElement"; buffer: string; index: SemanticValue; op: SemanticAssignOp; value: SemanticValue; line: number }
  | { k: "step"; name: string; op: "++" | "--"; prefix: boolean; line: number }
  /** `if`, with the block each arm runs. */
  | { k: "if"; condition: SemanticValue; then: SemanticBlock; otherwise: SemanticBlock | null; line: number }
  | { k: "loop"; loop: SemanticLoop; line: number }
  /** A block of its own, so a name declared in it is not a name outside it. */
  | { k: "block"; body: SemanticBlock; line: number }
  /** Writes text, the way the runtime writes text. */
  | { k: "printText"; value: SemanticValue; line: number }
  /** Writes a number, the way the runtime writes a number. */
  | { k: "printNumber"; value: SemanticValue; line: number }
  | { k: "printNewline"; line: number }
  /** Keeps an owned reference alive across a release of it. */
  | { k: "retain"; value: SemanticValue; line: number }
  /** A call kept for what it does. */
  | { k: "call"; call: SemanticCall; line: number }
  /** Ends the program with a message. Nothing after this runs. */
  | { k: "raise"; message: SemanticValue; line: number }
  /** Writes a field of an object, of the layout the access names. */
  | { k: "storeField"; object: SemanticValue; layout: string; field: string; value: SemanticValue; line: number }
  /**
   * Every element of an array written as one value, as `a.fill(1)` is. The
   * index is a name of the compiler's own, so two fills in one block do not
   * count with the same one.
   */
  | { k: "fill"; buffer: string; index: string; value: SemanticValue; type: SemanticType; line: number };

/* -------------------------------------------------------------------------- */
/* Program                                                                    */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* Functions                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A function the IR holds whole: the signature it is called by, what it is
 * held to, what it does beyond computing its result, and the body that computes
 * it. A function is not a body in this compiler — it is a symbol other
 * functions call, an allocation the program has to account for, and a promise
 * the program is checked against, and a description of only the body would
 * leave the rest of it to be re-derived by every consumer.
 *
 * The body is the same shape the program's is — the same blocks, terminators,
 * ownership and calls — so one walk, one validator and one text form cover both
 * a function and the program that runs it.
 */
export interface SemanticFunction {
  /** The name the function was written as. */
  name: string;
  /** The symbol it is linked by, which the program and its callees call. */
  symbol: string;
  /** The parameters, as the slots the body reads them by. */
  params: SemanticSlot[];
  returns: SemanticType;
  /**
   * The conditions the function is held to, as the contract writes them. The
   * IR does not type them: they are the contract's own language, checked when
   * the contract is parsed, and a condition is a claim about the function
   * rather than a thing the function does.
   */
  requires: string[];
  ensures: string[];
  /** What the function does beyond computing its result. */
  effects: Effect[];
  /** True when the function builds an object and hands it to its caller. */
  allocates: boolean;
  prints: boolean;
  /** True when the function reads the arguments the program was started with. */
  readsArgv: boolean;
  /** The objects of the program, laid out as the contract lays them out. */
  objects: Record<string, ObjectLayout>;
  /** Every call the body makes, in the order it first makes each. */
  calls: CallEdge[];
  /**
   * The body, as the block the function starts in. Every function has one: the
   * body is what the source defined, and a postcondition is a separate claim
   * about what it must return, not a substitute for the body that returns it.
   */
  entry: SemanticBlock;
}

/** Every function of one source file, as the IR holds them. */
export interface SemanticModule {
  /** The source file, relative to the project. */
  path: string;
  functions: SemanticFunction[];
}

/**
 * A program the IR holds whole: the body it runs, the functions that body
 * calls, and the object layouts those functions hand back. No target appears
 * anywhere in it, so the same program lowers to every backend.
 */
export interface SemanticProgram {
  /** The source file the program was written in, relative to the project. */
  file: string;
  /** The body of the program, as the block the run starts in. */
  entry: SemanticBlock;
  /** Every function the program calls, in the order the contract declares them. */
  functions: FunctionSignature[];
  /**
   * The functions the program declares, as the IR holds a function whole. A
   * function the source declared is compiled on its own and called like any
   * other, so it is a body here rather than a run of statements in the block
   * the program starts in.
   */
  bodies: SemanticFunction[];
  objects: Record<string, ObjectLayout>;
}

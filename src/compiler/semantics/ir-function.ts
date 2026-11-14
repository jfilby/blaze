/**
 * Resolving a function into the semantic IR.
 *
 * A function is more than a body: it is a symbol other functions call, a
 * signature its callers are held to, a set of conditions it is checked against,
 * what it does beyond computing its result, and the objects it lays out. The
 * contract states every one of those, and this module copies them into the IR
 * as they stand, so the IR and the contract cannot disagree about what a
 * function is. What is computed here is the one thing a contract does not state
 * as IR: the body, walked into blocks, terminators and typed values.
 *
 * Every function carries the statements the frontend parsed, and they are
 * written down the way a program's are: one block per place control can be,
 * exactly one way out of each, and no value a backend would have to decide
 * anything about. A postcondition is a separate claim about what the result
 * must equal, and it never stands in for the body: a function whose result is
 * one expression has a body here like any other, and the conditions beside it
 * are what an implementation of that body is checked against.
 *
 * ## Types
 *
 * Every expression is typed through the rules `semantics/objects.ts` uses,
 * because that pass is the one that decides the layout of every object the
 * program writes: a field holds what the body stores in it, so the IR and the
 * layout have to reach the same answer or a backend reads a double where a
 * pointer was written. A number the source wrote is a double unless a use fixes
 * it to another width, a length and a count are `usize`, and a bigint is an
 * `i64`.
 *
 * A string is the one value the two spell differently. The IR holds a string as
 * text, because that is what it is, and the layout holds it as the number a
 * string is stored as, because that is what is written. Both are true of the
 * same value, and the check that reads a function body knows it.
 *
 * ## Fields
 *
 * A field belongs to a layout, so every read and write names one. The object a
 * body wrote is laid out as the literal that wrote it, and a field of something
 * the body was given belongs to the layout of the program that holds it — one,
 * or the build is refused naming the layouts that could be meant, because a
 * backend cannot pick between them and a check that guesses is worse than a
 * refusal. Where the program lays out no object with that field at all it says
 * nothing about what is behind the reference, and a read of the field is then
 * the reference itself: that is the only value of the object the IR can name,
 * and it is the one every body that reads it is asking about, which is whether
 * the caller handed over an object at all. A write to such a field is refused:
 * there is no value the IR could store it into.
 *
 * ## Ownership
 *
 * A function body allocates no arrays, and an object it builds is handed to its
 * caller rather than freed on the way out, so no block of a function body owns
 * anything: every `releases` list is empty, and a jump carries no more than the
 * blocks it leaves already carry. A body that allocated an array and returned it
 * would be a different model, and this is not it.
 */

import { contractText, parseType } from "./contract.ts";
import { CompilerError } from "../core/errors.ts";
import { ARGV, ARGV_LENGTH, builtinFor, type BuiltinSignature } from "./builtins.ts";
import { rulesFor } from "./language.ts";
import { ANY_REF, BOOL, F64, I64, USIZE, asField, bodyIgnoresCounter, bodyIndexesCounter, bodyIsWhole, coalesce, countsWholeNumber, describe, elementOf, numeric, saysNothing } from "./objects.ts";
import { isInteger, isNumber, isWhole, isWide, isWideType, wholeOf } from "../core/semantic-ir.ts";
import { foldWhole, modularReduction, wholeConstant, wholePower, wholeText, wholeType } from "./whole-arithmetic.ts";
import type { Inferred } from "./objects.ts";
import type { PrimitiveTypeName } from "../core/types.ts";

/** The largest a `u64` holds, so a bigint that fits can be typed as `u64` when
   one is expected. */
const U64_MAX = 18446744073709551615n;
const U64: TypeExpr = { kind: "primitive", name: "u64" };
/** The range an `i64` holds, so a bigint outside it is a wide number. */
const I64_MAX = 9223372036854775807n;
const I64_MIN = -9223372036854775808n;
/** The wide number a bigint that does not fit in sixty-four bits is. */
const U256: TypeExpr = { kind: "primitive", name: "u256" };
/**
 * The width `>>>` reads both of its sides at: the unsigned 32 bit numbers the
 * language reads them as, whatever they are.
 */
const U32: TypeExpr = { kind: "primitive", name: "u32" };
import type { AssignOperator, BinaryOp, Expression, Statement, UnaryOp as SourceUnaryOp } from "../core/ir.ts";
import type { CallEdge, Effect, FunctionContract, FunctionDefinition, FunctionSignature, ObjectLayout, TypeExpr } from "../core/types.ts";
import {
  BOOLEAN,
  TEXT,
  compoundAsBinary,
  commonNumber,
  hasCall,
  isReference,
  isSequence,
  roundedBound,
  slotType,
  typeEquals,
  typeText,
  valueKind,
  type ArithOp,
  type CompareOp,
  type Ownership,
  type SemanticBlock,
  type SemanticCall,
  type SemanticFunction,
  type SemanticModule,
  type SemanticSlot,
  type SemanticStatement,
  type SemanticTextPart,
  type SemanticType,
  type CaptureRef,
  type SemanticValue,
  type UnaryOp,
  VOID,
} from "../core/semantic-ir.ts";

/** One field of a value read by its name, where the type names no shape. */
function fieldOfValue(value: unknown, key: string): any {
  return (value as Record<string, unknown>)[key];
}

function setFieldValue(value: unknown, key: string, next: unknown): void {
  (value as Record<string, unknown>)[key] = next;
}

/* -------------------------------------------------------------------------- */
/* What a function body needs from the program around it                       */
/* -------------------------------------------------------------------------- */

/** What a function body needs from the program around it. */
export interface FunctionContext {
  /** The name each object the program writes is laid out as, by the shape of the literal that writes it. */
  objectNames: Record<string, string>;
  /** Every function the program compiles, by name: a call is bound against one of these. */
  functions: Record<string, FunctionContract>;
  /**
   * The language the source was written in, whose rules are asked of the
   * language: a division of two whole numbers is a whole division in one and
   * a true division in another. Absent means TypeScript, which is what the
   * compiler read before the rules of a language were asked of it.
   */
  language?: string;
}

/* -------------------------------------------------------------------------- */
/* What a name holds                                                          */
/* -------------------------------------------------------------------------- */

/** A name the body declared, or a parameter it was called with. */
interface Held {
  name: string;
  /**
   * What the layout pass infers for the name, which is what a field of the
   * object it names holds once the body writes one.
   */
  inferred: Inferred;
  /** The slot the body reads the name by, which is how the IR types it. */
  slot: SemanticSlot;
}

/**
 * One object the body wrote, as the layout pass knows it: the key its shape is
 * filed under, and every field written to it so far.
 */
interface Shape {
  key: string;
  fields: { name: string; value: Inferred }[];
}

/** A value as the IR states it, and what the layout pass infers for the same one. */
interface Typed {
  value: SemanticValue;
  inferred: Inferred;
}

/** An object literal, laid out and with every field the body writes. */
interface Literal {
  key: string;
  layout: string;
  fields: { name: string; value: SemanticValue }[];
}

/** A reference to an object whose fields the source left unshaped. */
const REF_NULL: TypeExpr = { kind: "ref", of: null };

/** A source literal that is a number, rather than a text. */
const NUMBER_TEXT = /^(?:0[xX][0-9a-fA-F]+|(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)$/;

/** The inferred type of a source literal that is text. */
function textInferred(): Inferred {
  return { kind: "type", type: { kind: "text" } };
}

/** A number written in the source, which is a double. */
const DOUBLE: Inferred = { kind: "type", type: { kind: "primitive", name: "f64" } };

/** A reference the source left unshaped, which is what `null` is. */
const ANY: Inferred = { kind: "type", type: { kind: "ref", of: null } };

/** A whole number, as a length and an index are counted. */
const WHOLE: Inferred = { kind: "type", type: { kind: "primitive", name: "usize" } };

/* -------------------------------------------------------------------------- */
/* Tables                                                                     */
/* -------------------------------------------------------------------------- */

/** The operators that are operations on whole numbers and yield one. */
const WHOLE_OPERATORS: Record<string, true> = { "//": true, "%": true, "<<": true, ">>": true, "&": true, "|": true, "^": true };

/**
 * The whole number a whole operator yields: the one both operands already are,
 * and an i64 otherwise, because a shift, a remainder or a bitwise operator over
 * a double is not an operation any target has.
 *
 * A wide number is asked before either of those, and it wins over a side that
 * is not one: the operator is on whole numbers, a wide number is one, and
 * answering an `i64` here is a number the high three limbs do not fit in. What
 * the narrower side then does is the validator's rule rather than this one's —
 * a wide number is only answered by the kernel, which is over two of them.
 */
function wholeResult(left: Inferred, right: Inferred): TypeExpr {
  const whole = (side: Inferred): PrimitiveTypeName | null =>
    side.kind === "type" && side.type.kind === "primitive" && isWhole(side.type.name) ? side.type.name : null;
  for (const side of [left, right]) {
    if (side.kind === "type" && side.type.kind === "primitive" && isWide(side.type.name)) {
      return { kind: "primitive", name: side.type.name };
    }
  }
  const a = whole(left);
  const b = whole(right);
  return { kind: "primitive", name: a !== null && b !== null ? wholeOf(a, b) : "i64" };
}

/** What the operators a binary expression is written with state in the IR. */
const ARITHMETIC: Record<BinaryOp, ArithOp | null> = {
  "+": "add",
  "-": "sub",
  "*": "mul",
  "/": "div",
  "//": "floorDiv",
  "%": "mod",
  "**": "pow",
  "<<": "shl",
  ">>": "shr",
  ">>>": "ushr",
  "&": "and",
  "|": "or",
  "^": "xor",
  "<": null,
  "<=": null,
  ">": null,
  ">=": null,
  "===": null,
  "!==": null,
  "==": null,
  "!=": null,
  "&&": null,
  "||": null,
  "??": null,
};

/** The comparison each ordering operator is, as the IR states it. */
const COMPARISONS: Record<BinaryOp, CompareOp | null> = {
  "+": null,
  "-": null,
  "*": null,
  "/": null,
  "//": null,
  "%": null,
  "**": null,
  "<<": null,
  ">>": null,
  ">>>": null,
  "&": null,
  "|": null,
  "^": null,
  "<": "lt",
  "<=": "le",
  ">": "gt",
  ">=": "ge",
  "===": null,
  "!==": null,
  "==": null,
  "!=": null,
  "&&": null,
  "||": null,
  "??": null,
};

/** The comparisons that ask whether two values are the same one. */
const EQUALITY: readonly BinaryOp[] = ["===", "!==", "==", "!="];

/**
 * The compound assignments that need whole numbers, because the operator they
 * apply rounds its target to a whole number. The program path refuses the
 * same writes the same way (semantics/ir-resolve.ts).
 */
const WHOLE_ASSIGNMENTS: readonly AssignOperator[] = ["%=", "&=", "|=", "^=", "<<=", ">>=", ">>>="];

/** What each `op=` writes, as the one operation the IR states it as. */
const COMPOUND: Record<Exclude<AssignOperator, "=">, ArithOp> = {
  "+=": "add",
  "-=": "sub",
  "*=": "mul",
  "/=": "div",
  "//=": "floorDiv",
  "%=": "mod",
  "&=": "and",
  "|=": "or",
  "^=": "xor",
  "<<=": "shl",
  ">>=": "shr",
  ">>>=": "ushr",
  "**=": "pow",
};

/** The two `Math.` builtins that are one operation rather than a call. */
const EXTREMES: Record<string, "min" | "max"> = { "Math.min": "min", "Math.max": "max" };

/** What a unary operator is in the IR. */
const UNARY: Record<SourceUnaryOp, UnaryOp> = {
  "-": "neg",
  "+": "pos",
  "!": "not",
  "~": "bitNot",
};

/* -------------------------------------------------------------------------- */
/* Blocks                                                                     */
/* -------------------------------------------------------------------------- */

/** The blocks a loop leaves, which a break and a continue are written as. */
interface LoopTarget {
  header: string;
  exit: string;
  /** True once a `break` has left the loop, which is what says the loop may end. */
  left: boolean;
}

/** Whether a block ends by leaving it, which is what an `if` arm that leaves does. */
function leaves(block: SemanticBlock): boolean {
  return String(fieldOfValue(fieldOfValue(block, "terminator"), "k")) !== "next";
}

/** One block being written, and the loop whose body it is. */
interface BlockFrame {
  block: SemanticBlock;
  /** The loop this block is written in, which a break and a continue leave. */
  loop: LoopTarget | null;
  /** True for the body of the loop above, which a break leaves as well. */
  body: boolean;
}

/** The arm of a discriminated union a tag test settles a name to. */
interface Narrowing {
  name: string;
  field: string;
  value: string;
  negated?: boolean;
}

/* -------------------------------------------------------------------------- */
/* The body                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Writing one function body down as the semantic IR. The environment is what
 * the function knows — its parameters as declared, and its own declarations as
 * the layout pass infers them — and every block written is a place control can
 * be in.
 */
class FunctionBody {
  private readonly contract: FunctionContract;
  private readonly definition: FunctionDefinition;
  private readonly objects: Record<string, ObjectLayout>;
  /** The type every `return` of this function hands back. */
  private readonly returns: Inferred;

  private readonly frames: BlockFrame[] = [];
  private readonly scopes: Map<string, Held>[] = [new Map()];
  private readonly narrowings: Map<string, { field: string; value: string; negated?: boolean }[]>[] = [new Map()];
  /** The name a switch discriminant was copied from. */
  private readonly tagAliases = new Map<string, { base: string; field: string }>();
  /** The names the body holds, so a generated one is not one of them. */
  private readonly used: Set<string>;
  /** Every object the body wrote, as the layout pass knows them. */
  private readonly shapes = new Map<string, Shape>();
  /** The layout each object the body wrote is laid out as, once it is decided. */
  private readonly layouts = new Map<string, string>();
  /** What a value hoisted, to be written before the statement it is used in. */
  private pending: SemanticStatement[] = [];
  /**
   * The `finally` blocks a leave has to run before it leaves, innermost last.
   *
   * A finally runs whether or not the body it belongs to left the block early,
   * so the body is written with its finally here and every leave it makes runs
   * the finally first.
   */
  private readonly finallys: Statement[][] = [];
  private counters: Record<"t" | "i", number> = { t: 0, i: 0 };
  private blockCount = 0;

  constructor(contract: FunctionContract, definition: FunctionDefinition, context: FunctionContext) {
    this.contract = contract;
    this.definition = definition;
    setFieldValue(this, "context", context);
    this.objects = fieldOfValue(definition, "objects") as Record<string, ObjectLayout>;
    const signature = fieldOfValue(contract, "function") as FunctionSignature;
    this.returns = { kind: "type", type: parseType(String(fieldOfValue(signature, "returns"))) };
    const signatureParams = fieldOfValue(signature, "params") as FunctionSignature["params"];
    for (const param of signatureParams) {
      const type = parseType(String(fieldOfValue(param, "type")));
      // A parameter is a slot the body reads it by. A body that writes one
      // reassigns its own argument, which the language it was written in
      // allows, so the slot is one the body may change.
      this.bind(String(fieldOfValue(param, "name")), {
        name: String(fieldOfValue(param, "name")),
        inferred: { kind: "type", type },
        slot: { kind: "value", name: String(fieldOfValue(param, "name")), mutable: true, type },
      });
    }
    this.used = sourceNames(fieldOfValue(definition, "statements") as readonly Statement[], new Set(signatureParams.map((param) => String(fieldOfValue(param, "name")))));
  }

  /* ---------------------------------------------------------------------- */
  /* Entry                                                                  */
  /* ---------------------------------------------------------------------- */

  /** The body of the function, as the block it starts in. */
  lower(): SemanticBlock {
    const entry: SemanticBlock = { id: "entry", statements: [], releases: [], terminator: { k: "next" } };
    this.enter(entry, null);
    this.statements(fieldOfValue(this.definition, "statements") as readonly Statement[]);
    this.leave();
    // A body that falls off the end returns nothing: a function with no
    // `result` is a function that returns nothing, and its entry block still
    // ends the one way a function ends.
    if (entry.terminator.k === "next") entry.terminator = { k: "return", value: null };
    return entry;
  }

  /* ---------------------------------------------------------------------- */
  /* Names                                                                  */
  /* ---------------------------------------------------------------------- */

  private bind(name: string, held: Held): void {
    this.scopes[this.scopes.length - 1].set(name, held);
  }

  /** The name the body reads, or a refusal where it used one it does not have. */
  private read(name: string, line: number): Held {
    for (let at = this.scopes.length - 1; at >= 0; at -= 1) {
      const held = this.scopes[at].get(name);
      if (held !== undefined) return held;
    }
    throw this.error(
      `uses "${name}" before it is declared`,
      line,
      "a compiled function declares every name it uses before it uses it",
    );
  }

  /**
   * Every name in scope that holds a whole number, for the rule that asks
   * whether a loop body is written entirely in whole numbers.
   *
   * A name is here because it was declared as one — a parameter the source
   * annotated, or a value the body has already resolved to a whole-number
   * width. A name that is not here is one the source wrote as a plain number,
   * which in this language is a double, so a body that reads one is a body whose
   * arithmetic is at that width.
   */
  private wholeNames(): string[] {
    const names: string[] = [];
    for (const scope of this.scopes) {
      for (const [name, held] of scope) {
        const inferred = fieldOfValue(held, "inferred") as Inferred;
        if (String(fieldOfValue(inferred, "kind")) !== "type") continue;
        const type = fieldOfValue(inferred, "type") as TypeExpr;
        if (type.kind !== "primitive") continue;
        if (isWhole(String(type.name) as PrimitiveTypeName)) names.push(name);
      }
    }
    return names;
  }

  private open(): void {
    this.scopes.push(new Map());
    this.narrowings.push(new Map());
  }

  private close(): void {
    this.scopes.pop();
    this.narrowings.pop();
  }

  /**
   * The `finally` blocks a leave has to run before it leaves, written where
   * the leave is written.
   *
   * The innermost finally runs first: it is the one the body is inside, and
   * the one the outer finally surrounds. Each is written with the ones inside
   * it pending, so a leave inside a finally runs that finally's own finally —
   * which the language does not do, and which is why the finally's own body is
   * written with the pending ones popped.
   */
  private finallysWritten(): void {
    if (this.finallys.length === 0) return;
    const bodies = this.finallys.filter((body) => body.length > 0);
    if (bodies.length === 0) return;
    const pending = this.finallys.splice(0, this.finallys.length);
    for (const body of pending) {
      if (body.length === 0) continue;
      this.finallys.push(body);
      this.statements(body);
      this.finallys.pop();
    }
    this.finallys.push(...pending);
  }

  /**
   * A name the compiler gives a value, from the counter of its kind. A name the
   * source declared is never rewritten, so a generated name that would be one
   * of them is the next one along.
   */
  private generated(kind: "t" | "i"): string {
    let name: string;
    do {
      this.counters[kind] += 1;
      name = `${kind}${this.counters[kind]}`;
    } while (this.used.has(name));
    this.used.add(name);
    return name;
  }

  /* ---------------------------------------------------------------------- */
  /* Blocks                                                                 */
  /* ---------------------------------------------------------------------- */

  private enter(block: SemanticBlock, loop: LoopTarget | null, body = false): void {
    // Whatever a value of the block about to be written hoisted belongs to the
    // block being written now, not to the one being entered.
    if (this.frames.length > 0) this.flush();
    this.frames.push({ block, loop, body });
  }

  private leave(): void {
    this.flush();
    this.frames.pop();
  }

  /** The statements a value hoisted, written where the body wrote them. */
  private flush(): void {
    const block = fieldOfValue(this.frame(), "block") as SemanticBlock;
    const statements = fieldOfValue(block, "statements") as SemanticStatement[];
    for (const before of this.pending) statements.push(before);
    this.pending = [];
  }

  /** The arm a tag test settles a name to in the branch that holds. */
  private tagTest(condition: Expression): Narrowing | null {
    if (String(fieldOfValue(condition, "k")) !== "binary") return null;
    const op = String(fieldOfValue(condition, "op"));
    if (op !== "===" && op !== "==" && op !== "!==" && op !== "!=") return null;
    let subject = fieldOfValue(condition, "left") as Expression;
    let test = fieldOfValue(condition, "right") as Expression;
    if (this.tagSubject(subject) === null) {
      subject = fieldOfValue(condition, "right") as Expression;
      test = fieldOfValue(condition, "left") as Expression;
    }
    const tag = this.tagSubject(subject);
    if (tag === null) return null;
    const literal = this.tagLiteral(test);
    if (literal === null) return null;
    return { name: tag.name, field: tag.field, value: literal, negated: op === "!==" || op === "!=" };
  }

  /** The name and field a tag test reads, including a switch temporary. */
  private tagSubject(expression: Expression): { name: string; field: string } | null {
    const kind = String(fieldOfValue(expression, "k"));
    if (kind === "member") {
      const base = fieldOfValue(expression, "base") as Expression;
      if (String(fieldOfValue(base, "k")) !== "ident") return null;
      return { name: String(fieldOfValue(base, "name")), field: String(fieldOfValue(expression, "field")) };
    }
    if (kind !== "ident") return null;
    let name = String(fieldOfValue(expression, "name"));
    let field: string | null = null;
    for (let at = 0; at < 4; at += 1) {
      const alias = this.tagAliases.get(name);
      if (alias === undefined) break;
      name = alias.base;
      field = alias.field;
    }
    return field === null ? null : { name, field };
  }

  /** The text a tag is compared with, where the source wrote it out. */
  private tagLiteral(expression: Expression): string | null {
    const kind = String(fieldOfValue(expression, "k"));
    if (kind === "text") {
      const parts = fieldOfValue(expression, "parts") as readonly Expression[];
      if (parts.length !== 1) return null;
      const part = parts[0];
      if (String(fieldOfValue(part, "k")) !== "text") return null;
      return String(fieldOfValue(part, "value"));
    }
    if (kind === "literal") {
      const text = String(fieldOfValue(expression, "text"));
      if (!NUMBER_TEXT.test(text)) return text;
    }
    return null;
  }

  /** The arm a name is known to hold where the body is written. */
  private narrowingFor(name: string): { field: string; value: string; negated?: boolean }[] | null {
    const found: { field: string; value: string; negated?: boolean }[] = [];
    for (let at = this.narrowings.length - 1; at >= 0; at -= 1) {
      const held = this.narrowings[at].get(name);
      if (held === undefined) continue;
      for (const constraint of held) found.push(constraint);
    }
    return found.length === 0 ? null : found;
  }

  private frame(): BlockFrame {
    return this.frames[this.frames.length - 1];
  }

  private finish(terminator: SemanticBlock["terminator"]): void {
    const block = fieldOfValue(this.frame(), "block") as SemanticBlock;
    setFieldValue(block, "terminator", terminator);
  }

  private currentTerminator(): SemanticBlock["terminator"] {
    return fieldOfValue(fieldOfValue(this.frame(), "block"), "terminator") as SemanticBlock["terminator"];
  }

  private currentLoop(): LoopTarget | null {
    return fieldOfValue(this.frame(), "loop") as LoopTarget | null;
  }

  private write(statement: SemanticStatement): void {
    this.flush();
    const block = fieldOfValue(this.frame(), "block") as SemanticBlock;
    const statements = fieldOfValue(block, "statements") as SemanticStatement[];
    statements.push(statement);
  }

  /** A block id nothing else names. */
  private blockId(): string {
    this.blockCount += 1;
    return `b${this.blockCount}`;
  }

  /**
   * A block of its own, which a name declared in it is not a name outside it.
   *
   * The block is a scope as well as a place control can be in: an `if` arm and
   * a loop body each declare names that belong to them, and a name left bound
   * when the block ends is a name every later read in the function resolves to
   * the block's own declaration rather than the one around it — two variables
   * sharing one IR name, and the outer one read at the inner one's type.
   */
  private arm(
    body: readonly Statement[],
    loop: LoopTarget | null,
    ofLoop = false,
    settled: Narrowing | null = null,
  ): SemanticBlock {
    const block: SemanticBlock = { id: this.blockId(), statements: [], releases: [], terminator: { k: "next" } };
    this.enter(block, loop, ofLoop);
    this.open();
    if (settled !== null) {
      const scope = this.narrowings[this.narrowings.length - 1];
      const settledName = String(fieldOfValue(settled, "name"));
      let held = scope.get(settledName);
      if (held === undefined) {
        held = [];
        scope.set(settledName, held);
      }
      held.push({ field: String(fieldOfValue(settled, "field")), value: String(fieldOfValue(settled, "value")), negated: fieldOfValue(settled, "negated") === true });
    }
    this.statements(body);
    this.close();
    this.leave();
    return block;
  }

  /**
   * The blocks a loop leaves, and the block that holds it: the test is named
   * before the body is written, and control resumes in the block the loop was
   * written in, which is the one the loop statement is in.
   */
  private loop(body: readonly Statement[]): { header: string; exit: string; body: SemanticBlock; target: LoopTarget } {
    const header = this.blockId();
    const target: LoopTarget = { header, exit: String(fieldOfValue(fieldOfValue(this.frame(), "block"), "id")), left: false };
    return { header, exit: target.exit, body: this.arm(body, target, true), target };
  }

  /**
   * The end of the block a `break` or a `continue` is written in, after freeing
   * what the blocks it leaves own: innermost first, up to and including the
   * body of the loop it leaves. The blocks the loop itself sits in are not
   * left, and keep what they own.
   */
  private jump(leaving: boolean, line: number): void {
    const frame = this.frame();
    const target = fieldOfValue(frame, "loop") as LoopTarget | null;
    if (target === null) {
      throw this.error(
        `"${leaving ? "break" : "continue"}" is not within a loop`,
        line,
        "a function leaves a loop with break, and goes on with continue",
      );
    }
    const names: string[] = [];
    for (let at = this.frames.length - 1; at >= 0; at -= 1) {
      const left = this.frames[at];
      const leftBlock = fieldOfValue(left, "block") as SemanticBlock;
      for (const release of fieldOfValue(leftBlock, "releases") as readonly string[]) names.push(release);
      // Every block a loop holds carries the same loop, so the body itself is
      // what says where the walk over the blocks it leaves stops.
      if (fieldOfValue(left, "body") === true) break;
    }
    // A loop that is left does not hold the code after it: the loop may end by
    // its `break` and the code after it runs.
    if (leaving) setFieldValue(target, "left", true);
    const frameBlock = fieldOfValue(frame, "block") as SemanticBlock;
    setFieldValue(frameBlock, "terminator", { k: "jump", target: leaving ? String(fieldOfValue(target, "exit")) : String(fieldOfValue(target, "header")), releases: names });
  }

  /* ---------------------------------------------------------------------- */
  /* Statements                                                             */
  /* ---------------------------------------------------------------------- */

  private statements(list: readonly Statement[]): void {
    for (const statement of list) {
      // A block that ends by returning or by leaving for another one runs
      // nothing after what ended it, and neither does the source it was
      // written from. A block that ends where nothing arrives ends there too:
      // an `if` whose every arm leaves and a loop that never ends are both
      // statements nothing after them can be reached from.
      const frameBlock = fieldOfValue(this.frame(), "block") as SemanticBlock;
      const end = String(fieldOfValue(fieldOfValue(frameBlock, "terminator"), "k"));
      if (end === "jump" || end === "return" || end === "unreachable") break;
      this.statement(statement);
    }
  }

  private statement(statement: Statement): void {
    switch (statement.kind) {
      case "declare":
        return this.declaration(statement);
      case "assign": {
        // The name is written as the type it is read at, so `x += 1` adds a
        // number of that type to a number of that type.
        const held = this.read(String(fieldOfValue(statement, "target")), Number(fieldOfValue(statement, "line")));
        const heldSlot = fieldOfValue(held, "slot") as SemanticSlot;
        const heldInferred = fieldOfValue(held, "inferred") as Inferred;
        // A compound assignment writes its operator down on the type of the
        // name, so `%=` on a double is a target no compiler accepts: the C
        // backend writes `x %= 3.0`, which is not C at all. The operator
        // decides what the name may be, as it does in a binary expression,
        // where a whole operator needs whole numbers. The program path refuses
        // the same write the same way (semantics/ir-resolve.ts).
        if (WHOLE_ASSIGNMENTS.includes(String(fieldOfValue(statement, "op")) as AssignOperator) && !isInteger(slotType(heldSlot))) {
          const name = typeText(slotType(heldSlot));
          throw this.error(
            `"${String(fieldOfValue(statement, "op")).slice(0, -1)}" needs whole numbers`,
            Number(fieldOfValue(statement, "line")),
            `"${String(fieldOfValue(statement, "target"))}" is a ${name}, and "${String(fieldOfValue(statement, "op"))}" rounds it to a whole number`,
          );
        }
        // The count of a shift is a machine word, whatever the number being
        // shifted is — the same rule the binary form follows, over the name
        // rather than over a literal.
        const counted = String(fieldOfValue(statement, "op")) === "<<=" || String(fieldOfValue(statement, "op")) === ">>=" || String(fieldOfValue(statement, "op")) === ">>>=";
        const value = this.typed(fieldOfValue(statement, "value") as Expression, counted ? asType(USIZE) : heldInferred, Number(fieldOfValue(statement, "line"))).value;
        // A number written into a string is written as its text, as `s += 1`
        // is in the language the body was written in, rather than as a refusal
        // the source does not raise.
        const written =
          heldSlot.kind === "text" && !isText(value.type)
            ? { k: "text" as const, type: TEXT, parts: [{ k: "value" as const, value }] }
            : value;
        // A wide number has no compound operator a backend can write, and a
        // floor division has no compound form C has, so the compound is
        // written as the binary form every backend either writes or refuses
        // by name.
        const wide = compoundAsBinary(String(fieldOfValue(statement, "op")) as AssignOperator, slotType(heldSlot), { k: "local", type: slotType(heldSlot), name: String(fieldOfValue(held, "name")) }, written);
        this.write({
          k: "set",
          name: String(fieldOfValue(held, "name")),
          op: wide === null ? String(fieldOfValue(statement, "op")) as AssignOperator : wide.op,
          value: wide === null ? written : wide.value,
          line: Number(fieldOfValue(statement, "line")),
        });
        return;
      }
      case "memberAssign":
        return this.fieldAssignment(statement);
      case "indexAssign": {
        const buffer = this.read(String(fieldOfValue(statement, "buffer")), Number(fieldOfValue(statement, "line")));
        const bufferSlot = fieldOfValue(buffer, "slot") as SemanticSlot;
        const bufferInferred = fieldOfValue(buffer, "inferred") as Inferred;
        const bufferName = String(fieldOfValue(buffer, "name"));
        const bufferType = slotType(bufferSlot);
        // A write into a dynamic value is the entry the key names: the runtime
        // stores it, and there is no buffer to lay an element out in.
        if (!this.isBufferValue(bufferType)) {
          const base: Typed = { value: { k: "local", type: bufferType, name: bufferName }, inferred: bufferInferred };
          const key = this.typed(fieldOfValue(statement, "index") as Expression, null, Number(fieldOfValue(statement, "line")));
          const value = this.typed(fieldOfValue(statement, "value") as Expression, null, Number(fieldOfValue(statement, "line")));
          if (String(fieldOfValue(statement, "op")) !== "=") {
            throw this.error(
              `a compound write of an entry of "${bufferName}" is not part of the subset`,
              Number(fieldOfValue(statement, "line")),
              "read the entry into a name, combine it, and write the name back",
            );
          }
          this.dynamicIndexWrite(base, key, value, Number(fieldOfValue(statement, "line")));
          return;
        }
        const elementType = elementOf(bufferInferred);
        const element = asType(elementType);
        const index = this.typed(fieldOfValue(statement, "index") as Expression, WHOLE, Number(fieldOfValue(statement, "line"))).value;
        const value = this.typed(fieldOfValue(statement, "value") as Expression, element, Number(fieldOfValue(statement, "line"))).value;
        // The same rule as the whole name above, over one element rather than
        // a slot: a wide element has no compound operator a backend writes.
        const wide = compoundAsBinary(String(fieldOfValue(statement, "op")) as AssignOperator, elementType, { k: "element", type: elementType, of: { k: "local", type: slotType(bufferSlot), name: bufferName }, index }, value);
        this.write({
          k: "setElement",
          buffer: bufferName,
          index,
          op: wide === null ? String(fieldOfValue(statement, "op")) as AssignOperator : wide.op,
          value: wide === null ? value : wide.value,
          line: Number(fieldOfValue(statement, "line")),
        });
        return;
      }
      case "update":
        this.write({
          k: "step",
          name: String(fieldOfValue(this.read(String(fieldOfValue(statement, "name")), Number(fieldOfValue(statement, "line"))), "name")),
          op: String(fieldOfValue(statement, "op")) as "++" | "--",
          prefix: fieldOfValue(statement, "prefix") === true,
          line: Number(fieldOfValue(statement, "line")),
        });
        return;
      case "result": {
        // A bare return hands back nothing, and a function declared to return
        // nothing is the one that may write it.
        if (fieldOfValue(statement, "value") === null) {
          this.flush();
          this.finallysWritten();
          this.finish({ k: "return", value: null });
          return;
        }
        const value = this.typed(fieldOfValue(statement, "value") as Expression, this.returns, Number(fieldOfValue(statement, "line"))).value;
        // Whatever the value hoisted is written before the block ends, and what
        // it hoisted into is what the function hands back.
        this.flush();
        // A finally runs before the function returns, and the value the return
        // hands back is computed before the finally runs: the language reads
        // the value of a `return` and then runs the finally and then returns
        // it. The value is therefore bound to a name of its own and the finally
        // is written between the binding and the return.
        if (this.finallys.length > 0 && this.finallys.some((body) => body.length > 0)) {
          const name = this.generated("t");
          const slot: SemanticSlot = { kind: "value", name, mutable: false, type: value.type };
          this.write({ k: "let", slot, value, line: Number(fieldOfValue(statement, "line")) });
          this.finallysWritten();
          this.finish({ k: "return", value: { k: "local", type: value.type, name } });
          return;
        }
        this.finish({ k: "return", value });
        return;
      }
      case "throw": {
        // An error the source raises ends the program: a finally runs before
        // the block leaves, and what follows it is not code anything reaches.
        const written = this.typed(fieldOfValue(statement, "value") as Expression, null, Number(fieldOfValue(statement, "line"))).value;
        const message = isText(written.type) ? written : { k: "toText" as const, type: TEXT, of: written, digits: null };
        this.finallysWritten();
        this.write({ k: "raise", message, line: Number(fieldOfValue(statement, "line")) });
        this.finish({ k: "unreachable" });
        return;
      }
      case "if": {
        const condition = this.truth(this.typed(fieldOfValue(statement, "condition") as Expression, null, Number(fieldOfValue(statement, "line"))).value);
        const settled = this.tagTest(fieldOfValue(statement, "condition") as Expression);
        const then = this.arm(fieldOfValue(statement, "then") as Statement[], this.currentLoop(), false, settled);
        const opposite = settled === null
          ? null
          : { name: String(fieldOfValue(settled, "name")), field: String(fieldOfValue(settled, "field")), value: String(fieldOfValue(settled, "value")), negated: fieldOfValue(settled, "negated") !== true };
        const otherwiseStatements = fieldOfValue(statement, "otherwise") as Statement[];
        const otherwise = otherwiseStatements.length === 0 ? null : this.arm(otherwiseStatements, this.currentLoop(), false, opposite);
        this.write({ k: "if", condition, then, otherwise, line: Number(fieldOfValue(statement, "line")) });
        // An `if` with an arm on each side, each of which leaves, is a statement
        // nothing after it can be reached from. The block says so, rather than
        // falling out of itself into a return of nothing: a function declared to
        // return a number does not end by handing back whatever the register
        // held, and a function that returns from every path returns.
        if (otherwise !== null && this.currentTerminator().k === "next" && leaves(then) && leaves(otherwise)) {
          this.finish({ k: "unreachable" });
        }
        return;
      }
      case "try": {
        // Start the protected block with no pending error, so an error left by
        // an earlier call cannot be mistaken for one this body raised.
        this.write({
          k: "call",
          call: this.semanticCall(
            "blaze_error_clear",
            { name: "blaze_error_clear", symbol: "blaze_error_clear", params: [], returns: "void" },
            [],
            { kind: "void" },
            [],
            true,
            [],
          ),
          line: Number(fieldOfValue(statement, "line")),
        });
        // Run the protected body. It may leave the block early (return / jump),
        // in which case there is nothing to catch and the check below is not
        // reached.
        //
        // A finally runs whether or not the body left the block early, so the
        // body is written with the finally pending: every leave it makes runs
        // the finally first. A leave is written as a statement of the block it
        // is written in, so the finally's own statements are written before it
        // and run before it.
        const finallyBody = fieldOfValue(statement, "finallyBody") as Statement[] | null;
        this.finallys.push(finallyBody ?? []);
        this.statements(fieldOfValue(statement, "body") as Statement[]);
        this.finallys.pop();
        // If the body fell through, an error is pending and there is a catch
        // arm, run it. The catch parameter is bound to `blaze_last_error()` so
        // a `catch (e)` can inspect the error, and it is declared inside the
        // catch arm so it is only initialized when there actually is an error.
        // The arm is written with the finally pending as well: a return out of
        // the arm runs the finally before it returns.
        const catchBodyRaw = fieldOfValue(statement, "catchBody") as Statement[] | null;
        const catchParam = fieldOfValue(statement, "catchParam") as string | null;
        if (catchBodyRaw !== null) {
          this.finallys.push(finallyBody ?? []);
          const catchBody: Statement[] = [];
          if (catchParam !== null) {
            catchBody.push({
              kind: "declare",
              name: catchParam,
              type: null,
              init: { k: "call", name: "blaze_last_error", args: [] } as Expression,
              line: Number(fieldOfValue(statement, "line")),
            });
          }
          for (const one of catchBodyRaw) catchBody.push(one);
          const hadError = this.typed(
            { k: "call", name: "blaze_had_error", args: [] },
            null,
            Number(fieldOfValue(statement, "line")),
          ).value;
          const catchBlock = this.arm(catchBody, this.currentLoop());
          this.finallys.pop();
          this.write({ k: "if", condition: hadError, then: catchBlock, otherwise: null, line: Number(fieldOfValue(statement, "line")) });
        }
        // Finally runs whether or not the catch arm ran.
        this.statements(fieldOfValue(statement, "finallyBody") as Statement[] | null ?? []);
        return;
      }
      case "while": {
        const condition = this.truth(this.typed(fieldOfValue(statement, "condition") as Expression, null, Number(fieldOfValue(statement, "line"))).value);
        const { target, ...info } = this.loop(fieldOfValue(statement, "body") as Statement[]);
        // `while (true)` never leaves its body through the loop's exit, so
        // nothing written after it is reachable — unless the body leaves the
        // loop with a `break`, which is the one way out of it. A loop that may
        // be left is not a loop that never ends, and the code after it runs.
        const conditionText = (fieldOfValue(statement, "condition") as Expression as { text?: string; name?: string }).text ?? (fieldOfValue(statement, "condition") as Expression as { name?: string }).name;
        const neverExits = (conditionText === "true" || conditionText === "1") && fieldOfValue(target, "left") !== true;
        this.write({
          k: "loop",
          loop: { kind: "while", condition, ...info, ...(neverExits ? { neverExits: true } : {}) },
          line: Number(fieldOfValue(statement, "line")),
        });
        if (neverExits) {
          this.finish({ k: "unreachable" });
        }
        return;
      }
      case "doWhile": {
        const condition = this.truth(this.typed(fieldOfValue(statement, "condition") as Expression, null, Number(fieldOfValue(statement, "line"))).value);
        this.write({ k: "loop", loop: { kind: "doWhile", condition, ...this.loop(fieldOfValue(statement, "body") as Statement[]) }, line: Number(fieldOfValue(statement, "line")) });
        return;
      }
      case "loop":
        return this.counted(statement);
      case "forOf": {
        const source = this.read(String(fieldOfValue(statement, "of")), Number(fieldOfValue(statement, "line")));
        const sourceInferred = fieldOfValue(source, "inferred") as Inferred;
        const sourceSlot = fieldOfValue(source, "slot") as SemanticSlot;
        const sourceName = String(fieldOfValue(source, "name"));
        const element = elementOf(sourceInferred);
        const length: SemanticValue = { k: "length", type: USIZE, of: { k: "local", type: slotType(sourceSlot), name: sourceName } };
        const index = this.generated("i");
        this.open();
        this.bind(String(fieldOfValue(statement, "variable")), {
          name: String(fieldOfValue(statement, "variable")),
          inferred: asType(element),
          slot: { kind: "value", name: String(fieldOfValue(statement, "variable")), mutable: false, type: element },
        });
        const walked = this.loop(fieldOfValue(statement, "body") as Statement[]);
        this.close();
        this.write({
          k: "loop",
          loop: { kind: "each", index, element: String(fieldOfValue(statement, "variable")), elementType: element, of: sourceName, length, ...walked },
          line: Number(fieldOfValue(statement, "line")),
        });
        return;
      }
      case "break":
      case "continue":
        // A finally runs before the body leaves, and a break or a continue is
        // a leave: the finally's statements are written before the jump and
        // run before it.
        this.finallysWritten();
        this.jump(statement.kind === "break", Number(fieldOfValue(statement, "line")));
        return;
      case "print":
        return this.print(statement);
      case "expression": {
        // A call kept for what it does. Any other value a statement holds has
        // no effect of its own and the source dropped it too, so there is
        // nothing to write down and nothing to refuse.
        const value = this.typed(fieldOfValue(statement, "value") as Expression, null, Number(fieldOfValue(statement, "line"))).value;
        if (value.k === "call") this.write({ k: "call", call: fieldOfValue(value, "call") as SemanticCall, line: Number(fieldOfValue(statement, "line")) });
        return;
      }
    }
  }

  /**
   * A name the body declares. An object literal is a value like any other: the
   * allocation and the fields that fill it travel together, so the
   * declaration is one `let` holding an object built where it is written.
   */
  private declaration(statement: Statement & { kind: "declare" }): void {
    const line = Number(fieldOfValue(statement, "line"));
    const declaredName = String(fieldOfValue(statement, "name"));
    const init = fieldOfValue(statement, "init") as Expression;
    const declaredType = fieldOfValue(statement, "type") as TypeExpr | null;
    const annotation = declaredType === null ? null : asType(declaredType);
    if (init.k === "object") {
      const built = this.allocated(init, line);
      const builtValue = fieldOfValue(built, "value") as SemanticValue;
      const builtInferred = fieldOfValue(built, "inferred") as Inferred;
      // An annotation does not narrow an object: the layout is what the body
      // allocates, and the fields it writes are of that layout or of none.
      const slot: SemanticSlot = { kind: "object", name: declaredName, mutable: true, type: fieldOfValue(builtValue, "type") as SemanticType };
      this.bind(declaredName, { name: declaredName, inferred: builtInferred, slot });
      this.write({ k: "let", slot, value: builtValue, line });
      return;
    }
    const value = this.typed(init, annotation, line);
    const slot = this.slot(declaredName, value, annotation, line);
    this.bind(declaredName, { name: declaredName, inferred: bound(fieldOfValue(value, "inferred") as Inferred, annotation), slot });
    if (init.k === "member") {
      const base = fieldOfValue(init, "base") as Expression;
      if (base.k === "ident" && declaredName.slice(0, 8) === "__switch") {
        this.tagAliases.set(declaredName, { base: String(fieldOfValue(base, "name")), field: String(fieldOfValue(init, "field")) });
      }
    }
    this.write({ k: "let", slot, value: fieldOfValue(value, "value") as SemanticValue, line });
  }

  /**
   * A field the body writes. A plain `=` is one store, and a compound one reads
   * the field, applies the operator to what was there and stores it back,
   * because a store is the only write the IR states and it states no operators.
   */
  private fieldAssignment(statement: Statement & { kind: "memberAssign" }): void {
    const line = Number(fieldOfValue(statement, "line"));
    const fieldName = String(fieldOfValue(statement, "field"));
    const op = String(fieldOfValue(statement, "op"));
    const base = this.read(String(fieldOfValue(statement, "base")), line);
    const written = this.typed(fieldOfValue(statement, "value") as Expression, null, line);
    const writtenInferred = fieldOfValue(written, "inferred") as Inferred;
    const writtenValue = fieldOfValue(written, "value") as SemanticValue;
    const baseSlot = fieldOfValue(base, "slot") as SemanticSlot;
    const baseInferred = fieldOfValue(base, "inferred") as Inferred;
    const baseName = String(fieldOfValue(base, "name"));
    const layout = this.layoutForWrite(base, fieldName, writtenInferred, line);
    const object: SemanticValue = { k: "local", type: slotType(baseSlot), name: baseName };
    // A layout is what the body stores, so a field written as nothing and then
    // as a number is a number, and a field the body writes but the literal
    // never held is a field of the object.
    if (String(fieldOfValue(baseInferred, "kind")) === "object") this.stored(String(fieldOfValue(baseInferred, "key")), fieldName, writtenInferred);
    this.write({
      k: "storeField",
      object,
      layout,
      field: fieldName,
      value:
        op === "="
          ? writtenValue
          : {
              k: "arith",
              type: this.fieldType(layout, fieldName, line),
              op: COMPOUND[op as keyof typeof COMPOUND],
              left: { k: "loadField", type: this.fieldType(layout, fieldName, line), object, layout, field: fieldName },
              right: writtenValue,
            },
      line,
    });
  }

  /**
   * A loop that counts with a variable. What it counts with follows from what
   * it is built from, which is the value it starts at and the value it moves
   * by; a bound only says where the loop stops.
   */
  private counted(statement: Statement & { kind: "loop" }): void {
    const line = Number(fieldOfValue(statement, "line"));
    const variableName = String(fieldOfValue(statement, "variable"));
    const fromExpression = fieldOfValue(statement, "from") as Expression;
    const toExpression = fieldOfValue(statement, "to") as Expression;
    const stepExpression = fieldOfValue(statement, "step") as Expression | null;
    const bodyStatements = fieldOfValue(statement, "body") as Statement[];
    const from = this.typed(fromExpression, null, line);
    // What the loop counts with follows from the start and the step, so the
    // step is typed once, before the count is settled, and read twice: the
    // value the IR states is built from it and typing it again would run the
    // side effects a typed expression has — an `i++` written as the step
    // becomes a `let` and a `step` of its own — a second time.
    const step = stepExpression === null ? null : this.typed(stepExpression, null, line);
    // A counter that starts and moves by whole numbers counts in whole numbers,
    // and the body decides whether it may: a body written entirely in whole
    // numbers reads the counter at the counter's width whatever that width is,
    // so widening it changes no answer and is what lets the parallel rule hand
    // the loop to a thread. A body that mixes the counter into a double is left
    // alone, because there the counter is read through the accumulator's width
    // and an `i64` in that expression is a number the source never wrote.
    const wholeNames = new Set(this.wholeNames());
    const fromInferred = fieldOfValue(from, "inferred") as Inferred;
    const fromValue = fieldOfValue(from, "value") as SemanticValue;
    const stepInferred = step === null ? null : fieldOfValue(step, "inferred") as Inferred;
    const stepValue = step === null ? null : fieldOfValue(step, "value") as SemanticValue;
    const countsWholeItself = countsWholeNumber(fromExpression, fromInferred) && (step === null || (stepExpression !== null && countsWholeNumber(stepExpression, stepInferred as Inferred)));
    // The counter may be a whole number on any of three grounds: the body's
    // arithmetic is already whole, so reading the counter at either width gives
    // the same number; the body never reads it, so there is no arithmetic for
    // its width to reach; or the body reaches it only as an index, and an index
    // is a whole number whatever the counter is counted in. The second is what
    // admits a loop whose turn calls a function and accumulates what it returns
    // — a body of no whole numbers by any reading, whose counter is read by
    // neither turn — and the third is what admits a loop that counts elements
    // of an array of doubles.
    const countsWhole =
      bodyIsWhole(bodyStatements, variableName, wholeNames) ||
      bodyIgnoresCounter(bodyStatements, variableName) ||
      bodyIndexesCounter(bodyStatements, variableName);
    const counted =
      countsWholeItself && countsWhole
        ? I64
        : fromInferred.kind === "type"
          ? stepInferred === null || stepInferred.kind !== "type"
            ? fromInferred.type
            : numeric(fromInferred, stepInferred)
          : USIZE;
    const type = asType(counted);
    // A number written as the start is counted in the type the loop counts in.
    const starts: SemanticValue =
      fromValue.k === "const" && counted.kind === "primitive" ? { ...fromValue, type: counted } : fromValue;
    // The bound is where the loop stops, and the comparison that stops it is
    // between the counter and the bound. A counter that counts in whole
    // numbers and a bound that is a fraction are compared as the numbers they
    // are: `for (let i = 0; i < 5.5; i++)` counts six turns. A bound read at
    // the counter's width would stop the loop at five, so a bound that is not
    // a whole number is rounded to the whole number the comparison against it
    // answers the same — the ceiling of it for a counter that counts up to a
    // bound it does not reach, and the floor of it for one that counts down. A
    // counter that counts in fractions is compared against the bound as it is,
    // and the bound is left alone.
    const natural = this.typed(toExpression, null, line);
    const naturalInferred = fieldOfValue(natural, "inferred") as Inferred;
    const naturalValue = fieldOfValue(natural, "value") as SemanticValue;
    const wholeCounter = counted.kind === "primitive" && isWhole(counted.name);
    const down = fieldOfValue(statement, "down") === true;
    const inclusive = fieldOfValue(statement, "inclusive") === true;
    const bound: SemanticValue = wholeCounter && !countsWholeNumber(toExpression, naturalInferred)
      ? roundedBound(naturalValue, down === inclusive)
      : naturalValue.k === "const" && counted.kind === "primitive"
        ? { ...naturalValue, type: counted }
        : naturalValue;
    // A number written as the step is counted in the type the loop counts in,
    // for the same reason the start is: the IR states the loop in one width.
    const moves: SemanticValue | null =
      step === null || stepValue === null || stepValue.k !== "const" || counted.kind !== "primitive"
        ? stepValue
        : { ...stepValue, type: counted };
    this.open();
    this.bind(variableName, {
      name: variableName,
      inferred: type,
      slot: { kind: "value", name: variableName, mutable: true, type: counted },
    });
    const walked = this.loop(bodyStatements);
    this.close();
    this.write({
      k: "loop",
      loop: {
        kind: "counted",
        variable: variableName,
        type: counted,
        from: starts,
        to: bound,
        inclusive,
        down,
        step: moves,
        ...walked,
      },
      line,
    });
  }

  /**
   * What a `print` writes: the value the way the runtime writes what it holds,
   * and then the line the console ends it with.
   */
  private print(statement: Statement & { kind: "print" }): void {
    const line = Number(fieldOfValue(statement, "line"));
    const printed = fieldOfValue(statement, "value") as Expression;
    const value = fieldOfValue(this.typed(printed, null, line), "value") as SemanticValue;
    switch (valueKind(value)) {
      case "text":
        this.write({ k: "printText", value, line });
        break;
      case "number":
        // A bigint *parameter* of a function is stated as the `i64` it is, so a
        // function that prints one writes it without the `n` beside it. A bigint
        // the body wrote out is not a parameter — `9007199254740993n` is a
        // bigint the source spelled, and the language prints it with the `n` —
        // and reading the mark off the expression is what tells the two apart.
        // Reading it off nothing hardcoded every one of them as the parameter.
        this.write({ k: "printNumber", value, line, bigint: printed.k === "bigint" });
        break;
      case "boolean":
      case "reference":
        this.write({ k: "printText", value: { k: "toText", type: TEXT, of: value, digits: null }, line });
        break;
      case "null":
        this.write({
          k: "printText",
          value: { k: "text", type: TEXT, parts: [{ k: "text", value: "null" }] },
          line,
        });
        break;
    }
    if (fieldOfValue(statement, "newline") !== false) this.write({ k: "printNewline", line });
  }

  /* ---------------------------------------------------------------------- */
  /* Values                                                                 */
  /* ---------------------------------------------------------------------- */

  private typed(expression: Expression, expect: Inferred | null, line: number): Typed {
    switch (expression.k) {
      case "literal": {
        // A number written in the source is a double unless a use fixes it to
        // another width, and a whole literal is still a double. `true` and
        // `false` are truths the source wrote, so a use that says nothing takes
        // the truth they are rather than the double they are held as.
        const written = numberAt(expect) ?? (fieldOfValue(expression, "boolean") === true === true ? BOOL : F64);
        return {
          value: { k: "const", type: written, text: String(fieldOfValue(expression, "text")) },
          inferred: { kind: "type", type: written },
        };
      }
      case "bigint": {
        // A bigint is a whole number, and a whole number here is an `i64`. A
        // literal that does not fit in one is a wide number, and it is typed as
        // one: a literal typed as an `i64` and holding more than that is
        // answered as the low sixty-four bits of itself, which is a number the
        // source never wrote. The program resolver types it the same way.
        let literal: bigint | null = null;
        try { literal = BigInt(String(fieldOfValue(expression, "text"))); } catch { /* not a valid bigint */ }
        // When a `u64` is expected and the value fits in 64 unsigned bits, type
        // it as `u64` so it can be passed to `u256_from_u64x2` or
        // `u256_from_u64x4` without first being widened to `u256`.
        if (expect !== null && expect.kind === "type" && expect.type.kind === "primitive" && expect.type.name === "u64" && literal !== null && literal >= 0n && literal <= U64_MAX) {
          return { value: { k: "const", type: U64, text: String(fieldOfValue(expression, "text")) }, inferred: asType(U64) };
        }
        if (literal !== null && (literal > I64_MAX || literal < I64_MIN)) {
          return { value: { k: "const", type: U256, text: String(fieldOfValue(expression, "text")) }, inferred: asType(U256) };
        }
        return { value: { k: "const", type: I64, text: String(fieldOfValue(expression, "text")) }, inferred: asType(I64) };
      }
      case "ident": {
        const held = this.read(String(fieldOfValue(expression, "name")), line);
        return { value: { k: "local", type: slotType(fieldOfValue(held, "slot") as SemanticSlot), name: String(fieldOfValue(held, "name")) }, inferred: fieldOfValue(held, "inferred") as Inferred };
      }
      case "null":
        return { value: { k: "nothing", type: referenceAt(expect) ?? REF_NULL }, inferred: ANY };
      case "argv":
        // `process.argv` itself is a count of the arguments the program was
        // given, and one of them is a number.
        if ((fieldOfValue(expression, "index") as Expression | null) === null) return { value: { k: "argv", type: USIZE, index: null }, inferred: asType(USIZE) };
        return { value: { k: "argv", type: F64, index: this.typed(fieldOfValue(expression, "index") as Expression, WHOLE, line).value }, inferred: asType(F64) };
      case "length": {
        const held = this.read(String(fieldOfValue(expression, "buffer")), line);
        return { value: { k: "length", type: USIZE, of: { k: "local", type: slotType(fieldOfValue(held, "slot") as SemanticSlot), name: String(fieldOfValue(held, "name")) } }, inferred: asType(USIZE) };
      }
      case "lengthOf": {
        const operand = this.typed(fieldOfValue(expression, "of") as Expression, null, line);
        // A dynamic value carries its length in the runtime's array, not in a
        // block header: the length is the service that answers it.
        const operandValue = fieldOfValue(operand, "value") as SemanticValue;
        if (!this.isBufferValue(operandValue.type) && operandValue.type.kind !== "text") {
          return this.runtimeCall("blaze_rt_array_length", [operandValue], F64);
        }
        return {
          value: { k: "length", type: USIZE, of: operandValue },
          inferred: asType(USIZE),
        };
      }
      case "index": {
        const base = this.typed(fieldOfValue(expression, "base") as Expression, null, line);
        if ((fieldOfValue(base, "inferred") as Inferred).kind === "object") {
          throw this.error(
            `reads an element of ${describe(fieldOfValue(base, "inferred") as Inferred)}, which is an object`,
            line,
            "an object is read field by field, as in node.left",
          );
        }
        // A value that is not a buffer is a dynamic value: its entries are the
        // runtime's, and the key chooses the service that reads one.
        const baseValue = fieldOfValue(base, "value") as SemanticValue;
        if (!this.isBufferValue(baseValue.type)) {
          const key = this.typed(fieldOfValue(expression, "index") as Expression, null, line);
          return this.dynamicIndexRead(base, key, expect);
        }
        const element = elementOf(fieldOfValue(base, "inferred") as Inferred);
        return {
          value: { k: "element", type: element, of: baseValue, index: this.typed(fieldOfValue(expression, "index") as Expression, WHOLE, line).value },
          inferred: asType(element),
        };
      }
      case "slice": {
        const base = this.typed(fieldOfValue(expression, "base") as Expression, null, line);
        if ((fieldOfValue(expression, "start") as Expression | null) !== null) this.typed(fieldOfValue(expression, "start") as Expression, null, line);
        if ((fieldOfValue(expression, "stop") as Expression | null) !== null) this.typed(fieldOfValue(expression, "stop") as Expression, null, line);
        if ((fieldOfValue(expression, "step") as Expression | null) !== null) this.typed(fieldOfValue(expression, "step") as Expression, null, line);
        return base;
      }
      case "member":
        return this.field(expression, expect, line);
      case "call":
        return this.call(expression, line, expect);
      case "object":
        return this.allocated(expression, line);
      case "sized": {
        // `new Float64Array(n)` is a block of `n` elements the program sizes
        // when it runs, cleared: a read past what the program filled is the
        // zero the language answers it with.
        const element = parseType(String(fieldOfValue(expression, "element")));
        const type: TypeExpr = { kind: "array", of: element, length: null };
        return {
          value: {
            k: "buffer",
            type,
            element,
            length: null,
            count: this.typed(fieldOfValue(expression, "count") as Expression, WHOLE, line).value,
            view: null,
            values: [],
          },
          inferred: asType(type),
        };
      }
      case "buffer": {
        // A list whose element type no use stated is the runtime's dynamic
        // array, which holds the values pushed into it.
        if (fieldOfValue(expression, "dynamic") === true) return this.runtimeCall("blaze_rt_dyn_array_new", [], ANY_REF);
        // `bytes.subarray(from, to)` is a window of a block another name holds:
        // the block moved by the offset, and the elements it reaches are the
        // count the source wrote. Nothing is allocated and nothing is copied.
        const view = fieldOfValue(expression, "view") as { count: Expression; of: Expression; offset: Expression } | undefined;
        if (view !== undefined) {
          const element = parseType(String(fieldOfValue(expression, "element")));
          const type: TypeExpr = { kind: "slice", of: element };
          return {
            value: {
              k: "buffer",
              type,
              element,
              length: null,
              count: this.typed(fieldOfValue(view, "count") as Expression, WHOLE, line).value,
              view: {
                of: this.typed(fieldOfValue(view, "of") as Expression, null, line).value,
                offset: this.typed(fieldOfValue(view, "offset") as Expression, WHOLE, line).value,
              },
              values: [],
            },
            inferred: asType(type),
          };
        }
        // `new Float64Array([1, 2, 3])` is a block whose length the program
        // wrote down, and the elements take the type of the array they are
        // written into rather than the type they were written at.
        const element = parseType(String(fieldOfValue(expression, "element")));
        const type: TypeExpr = { kind: "array", of: element, length: (fieldOfValue(expression, "values") as Expression[]).length };
        return {
          value: {
            k: "buffer",
            type,
            element,
            length: (fieldOfValue(expression, "values") as Expression[]).length,
            count: null,
            view: null,
            values: (fieldOfValue(expression, "values") as Expression[]).map((value) => this.typed(value, { kind: "type", type: element }, line).value),
          },
          inferred: asType(type),
        };
      }
      case "fixed": {
        // What is written at a fixed number of digits is text. A string is
        // already that text, and the digits would be dropped rather than
        // refused, so it is refused here for the reason the program body
        // refuses it.
        const of = this.typed(fieldOfValue(expression, "of") as Expression, null, line).value;
        if (isText(of.type)) {
          throw this.error(
            "a string is not written at a fixed number of digits",
            line,
            "a string is already text; write it as it is",
          );
        }
        return { value: { k: "toText", type: TEXT, of, digits: Number(fieldOfValue(expression, "digits")), ...(fieldOfValue(expression, "precision") as true | undefined === undefined ? {} : { precision: fieldOfValue(expression, "precision") as true | undefined }) }, inferred: asType(USIZE) };
      }
      case "text": {
        const parts: SemanticTextPart[] = [];
        for (const part of fieldOfValue(expression, "parts") as readonly Expression[]) {
          const partValue = fieldOfValue(part, "value") as Expression;
          if (String(fieldOfValue(part, "k")) === "text") {
            parts.push({ k: "text", value: String(fieldOfValue(part, "value")) });
          } else {
            parts.push({ k: "value", value: this.asText(this.typed(partValue, null, line).value) });
          }
        }
        return { value: { k: "text", type: TEXT, parts }, inferred: DOUBLE };
      }
      case "binary":
        return this.binary(expression, line);
      case "unary":
        return this.unary(expression, expect, line);
      case "conditional": {
        const condition = this.truth(this.typed(fieldOfValue(expression, "condition") as Expression, null, line).value);
        const then = this.typed(fieldOfValue(expression, "then") as Expression, expect, line);
        const otherwise = this.typed(fieldOfValue(expression, "otherwise") as Expression, expect, line);
        // An arm written `null` is the absence of the other arm's value, not a
        // value of another type: `a?.[i]` is the element or nothing, and the
        // conditional is a number where the element is one. Two absences are
        // still the unshaped reference a null is.
        const absent = (one: Typed): boolean => (fieldOfValue(one, "value") as SemanticValue).k === "nothing";
        const thenType = (fieldOfValue(then, "value") as SemanticValue).type;
        const otherwiseType = (fieldOfValue(otherwise, "value") as SemanticValue).type;
        const type = absent(otherwise) && !absent(then) ? thenType
          : absent(then) && !absent(otherwise) ? otherwiseType
            : this.common(thenType, otherwiseType, line);
        return {
          value: {
            k: "select",
            type,
            condition,
            then: fieldOfValue(then, "value") as SemanticValue,
            otherwise: fieldOfValue(otherwise, "value") as SemanticValue,
          },
          // Both arms are walked so both objects are laid out, but a choice is
          // whichever arm it takes: two arms that name the same thing, or a
          // reference the source left unshaped. Two lists are one list type
          // even when one arm is empty and the other is not.
          // A choice of two values is the type they have in common, which is
          // exact whenever neither arm is an object: a length and a double are
          // one number, and reading the choice as a length keeps the arithmetic
          // that follows it arithmetic. Two references are a reference, and the
          // source did not say which layout it is.
          inferred: describe(fieldOfValue(then, "inferred") as Inferred) === describe(fieldOfValue(otherwise, "inferred") as Inferred)
            ? fieldOfValue(then, "inferred") as Inferred
            : type.kind === "slice" || type.kind === "array" || type.kind === "primitive" || type.kind === "text"
              ? asType(type)
              : ANY,
        };
      }
      case "update":
        return this.updated(expression, line);
      case "arrow":
        return this.closure(expression, line);
      case "capture": {
        // One of the values a closure carries, read at the type the arrow that
        // captured it reads it at. The closure is the value it travels in, so
        // it is typed first: a name it reads is a name the body has.
        const closure = this.typed(fieldOfValue(expression, "closure") as Expression, null, line).value;
        const captureType = fieldOfValue(expression, "type") as TypeExpr;
        return { value: { k: "capture", type: captureType, closure, index: Number(fieldOfValue(expression, "index")) }, inferred: asType(captureType) };
      }
      case "invoke":
        return this.invoke(expression, line);
      case "append":
        throw this.error(
          `writes ${String(fieldOfValue(expression, "target"))}.${String(fieldOfValue(expression, "op"))} where a value is expected`,
          line,
          "a push and a pop answer the array the name holds afterwards, and the write that keeps it is a statement of its own",
        );
    }
  }

  /**
   * An arrow read as a value: the closure it is.
   *
   * The values it captured are read where the arrow is written, which is the
   * scope the body that wrote it is in, and travel with the closure from there.
   */
  private closure(expression: Expression & { k: "arrow" }, line: number): Typed {
    const code = fieldOfValue(expression, "code") as string | undefined;
    if (code === undefined) {
      throw this.error(
        `reads the arrow function ${String(fieldOfValue(expression, "name"))} as a value, which the frontend lowered no closure entry for`,
        line,
        "an arrow read as a value is entered through a function the frontend writes beside it",
      );
    }
    const context = fieldOfValue(this, "context") as FunctionContext;
    const functions = fieldOfValue(context, "functions") as Record<string, FunctionContract>;
    const lifted = functions[code];
    if (lifted === undefined) {
      throw this.error(
        `calls the arrow function ${code}, which the program does not compile`,
        line,
        "the function an arrow is entered through is a function of the same file",
      );
    }
    const captureNames = fieldOfValue(expression, "captures") as string[];
    const captures = captureNames.map(
      (name) => fieldOfValue(this.typed({ k: "ident", name }, null, line), "value") as SemanticValue,
    );
    return {
      value: {
        k: "closure",
        type: REF_NULL,
        code: String(fieldOfValue(fieldOfValue(lifted, "function"), "symbol")),
        signature: fieldOfValue(lifted, "function") as FunctionSignature,
        captures,
      },
      inferred: ANY,
    };
  }

  private invoke(expression: Expression & { k: "invoke" }, line: number): Typed {
    const calleeExpression = fieldOfValue(expression, "callee") as Expression;
    const params = fieldOfValue(expression, "params") as TypeExpr[];
    const argumentExpressions = fieldOfValue(expression, "args") as Expression[];
    const calleeTyped = this.typed(calleeExpression, null, line);
    const calleeValue = fieldOfValue(calleeTyped, "value") as SemanticValue;
    // A member that is no field of any layout the program lays out reads back
    // as its base — field() answers that way for a read — but calling the
    // object as the value it holds is a jump to data. The load that would
    // hand the call its value does not exist where the method is behaviour of
    // a class rather than a field of an object, and the call is refused here
    // than built to crash.
    if (calleeExpression.k === "member" && calleeValue.k === "local") {
      throw this.error(
        `calls ${String(fieldOfValue(calleeExpression, "field"))}, which is not a field of any object the program lays out`,
        line,
        "a method of a class is called as its function; a value held at a function type reads the field the object lays out",
      );
    }
    const callee = calleeValue;
    if (params.length !== argumentExpressions.length) {
      throw this.error(
        `calls a value with ${argumentExpressions.length} argument${argumentExpressions.length === 1 ? "" : "s"}, but it takes ${params.length}`,
        line,
      );
    }
    const args = argumentExpressions.map((argument, at) => fieldOfValue(this.typed(argument, asType(params[at]), line), "value") as SemanticValue);
    const returns = fieldOfValue(expression, "returns") as SemanticType;
    // The type each argument is handed over as is the one the call site states,
    // not the one the value happens to be: a loop counter handed to a parameter
    // declared as a double is converted where it is passed, exactly as it is in
    // a call of a named function.
    const argTypes: SemanticType[] = params.map((type) => type);
    const signature: FunctionSignature = {
      name: "(closure)",
      symbol: "(closure)",
      params: argTypes.map((type, at) => ({ name: `argument${at}`, type: contractText(type) })),
      returns: contractText(returns),
    };
    return {
      value: {
        k: "call",
        type: returns,
        call: {
          callee: "(closure)",
          through: callee,
          signature,
          args,
          argTypes,
          returns,
          effects: [],
          ownership: ownership(returns),
          retain: false,
          builtin: false,
        },
      },
      inferred: asType(returns),
    };
  }

  /**
   * A field the body reads. A field belongs to a layout, so the access names
   * one: the object the body wrote is laid out as the literal that wrote it,
   * and a field of something the body was given is a field of the layout that
   * holds it.
   */
  private field(expression: Expression & { k: "member" }, expect: Inferred | null, line: number): Typed {
    const base = this.typed(fieldOfValue(expression, "base") as Expression, null, line);
    const object = fieldOfValue(base, "value") as SemanticValue;
    if ((fieldOfValue(base, "inferred") as Inferred).kind === "object") {
      const layout = this.layoutFor(String(fieldOfValue(fieldOfValue(base, "inferred") as Inferred, "key")), line);
      return {
        value: { k: "loadField", type: this.fieldType(layout, String(fieldOfValue(expression, "field")), line), object, layout, field: String(fieldOfValue(expression, "field")) },
        inferred: this.fieldOfValue(String(fieldOfValue(fieldOfValue(base, "inferred") as Inferred, "key")), String(fieldOfValue(expression, "field"))),
      };
    }
    const baseExpression = fieldOfValue(expression, "base") as Expression;
    const baseName = baseExpression.k === "ident" ? String(fieldOfValue(baseExpression, "name")) : null;
    const settled = baseName === null ? null : this.narrowingFor(baseName);
    const layouts = this.layoutsWith(fieldOfValue(base, "inferred") as Inferred, describe(fieldOfValue(base, "inferred") as Inferred), String(fieldOfValue(expression, "field")), expect ?? ANY, line, settled);
    // The program lays out no object with that field at all, so it says
    // nothing about what is behind the reference. The reference is then the
    // only value of the object the IR can name, and it is the one every body
    // that reaches it is asking about: whether the caller handed over an
    // object at all. Naming a layout here would be naming one the program does
    // not have.
    if (layouts.length === 0) return { value: object, inferred: ANY };
    const layout = layouts[0] as string;
    const type = this.fieldType(layout, String(fieldOfValue(expression, "field")), line);
    // The read is at the type the layout gives the field, which is the number
    // behind it rather than the reference: `p.x + p.y` over an `any` is a sum
    // of two doubles because the layouts the program lays out say the fields
    // are doubles, and it was refused as a sum of two references because
    // nothing said what was behind them.
    return {
      value: { k: "loadField", type, object, layout, field: String(fieldOfValue(expression, "field")) },
      inferred: inferredOfField(type),
    };
  }

  /**
   * The layouts a field of something the body was given is a field of: every
   * one that holds a field of that name the use is a use of.
   *
   * A use that says nothing — an `any` the source left unshaped — is a use of
   * whatever the reference points at, so a field of any type is a field of it.
   * That is the difference between reading the link of a node and reading a
   * number out of one: the link was typed as a reference because every layout
   * that has a `left` holds a reference there, and a number was not a field of
   * any of them, so the read degraded to the reference itself and the number
   * behind it was never read.
   *
   * Two layouts that hold the field at the same offset and of the same type
   * are one read whichever of them the object is: `left: f64` at `0` reads the
   * same eight bytes in both. Only the layouts that disagree are a choice a
   * backend cannot make, and those are a refusal naming them.
   */
  private layoutsWith(
    inferred: Inferred,
    what: string,
    field: string,
    use: Inferred,
    line: number,
    settled: readonly { field: string; value: string; negated?: boolean }[] | null = null,
  ): string[] {
    const tagLayouts = fieldOfValue(this.definition, "tagLayouts") as Record<string, Record<string, string[]>> | undefined;
    if (String(fieldOfValue(inferred, "kind")) === "object") return [this.layoutFor(String(fieldOfValue(inferred, "key")), line)];
    // A reference that names the layout it points at is that layout: the
    // program wrote the name, so a field read through it is that layout's
    // field and no other. `Info` and a literal that writes the same field name
    // are two layouts, and only the one the reference names is the value.
    if (String(fieldOfValue(inferred, "kind")) === "type") {
      const named = layoutOf(fieldOfValue(inferred, "type") as TypeExpr) as { name?: string } | null;
      const namedName = named === null ? undefined : fieldOfValue(named, "name") as string | undefined;
      if (namedName !== undefined && (fieldOfValue(this, "objects") as Record<string, ObjectLayout>)[namedName] !== undefined) {
        return [namedName];
      }
    }
    // A reference to nothing in particular behind it: `p.x` in a body whose
    // `p` is an `any` asks what is behind `p`, not for a reference.
    const useType = fieldOfValue(use, "type") as TypeExpr;
    const unshaped = String(fieldOfValue(use, "kind")) === "type" && useType.kind === "ref" && useType.of === null;
    const candidates: { name: string; read: string }[] = [];
    for (const layout of Object.values((fieldOfValue(this, "objects") as Record<string, ObjectLayout>))) {
      const declared = (fieldOfValue(layout, "fields") as readonly { name: string; type: string; offset: number }[]).find((one) => one.name === field);
      if (declared === undefined) continue;
      if (!unshaped && !holds(String(fieldOfValue(declared, "type")), use)) continue;
      candidates.push({ name: String(fieldOfValue(layout, "name")), read: `${String(fieldOfValue(declared, "type"))} at ${String(fieldOfValue(declared, "offset"))}` });
    }
    let considered = candidates;
    if (settled !== null && tagLayouts !== undefined) {
      for (const constraint of settled) {
        const listed = tagLayouts[String(fieldOfValue(constraint, "field"))]?.[String(fieldOfValue(constraint, "value"))];
        if (listed === undefined) continue;
        const narrowed = considered.filter((one) => listed.includes(one.name) !== (fieldOfValue(constraint, "negated") === true));
        if (narrowed.length > 0) considered = narrowed;
      }
    }
    let [first] = considered;
    if (first === undefined) return [];
    let disagreeing = considered.filter((one) => one.read !== first.read).map((one) => one.name);
    if (disagreeing.length > 0 && tagLayouts !== undefined) {
      const taggedNames = new Set<string>();
      const byValue = tagLayouts[field];
      if (byValue !== undefined) {
        for (const value of Object.keys(byValue)) {
          for (const name of byValue[value]) taggedNames.add(name);
        }
      }
      const tagged = considered.filter((one) => taggedNames.has(one.name));
      if (tagged.length > 0) {
        let lowest = 0 / 0;
        for (const one of tagged) {
          const at = Number(one.read.slice(one.read.lastIndexOf(" at ") + 4));
          if (Number.isNaN(lowest) || at < lowest) lowest = at;
        }
        const sameOffset = tagged.filter((one) => Number(one.read.slice(one.read.lastIndexOf(" at ") + 4)) === lowest);
        if (sameOffset.length > 0) considered = sameOffset;
        else considered = tagged;
        first = considered[0];
        disagreeing = considered.filter((one) => one.read !== first.read).map((one) => one.name);
      }
    }
    if (disagreeing.length > 0 && String(fieldOfValue(use, "kind")) === "type" && useType.kind === "ref" && useType.of === null) {
      const text = considered.filter((one) => parseType(one.read.slice(0, one.read.lastIndexOf(" at "))).kind === "text");
      const [tag] = text;
      if (tag !== undefined && text.every((one) => one.read === tag.read)) {
        first = tag;
        disagreeing = [];
        considered = text;
      }
    }
    if (disagreeing.length === 0) return considered.map((one) => one.name);
    throw this.error(
      `reads or writes "${what}.${field}", which ${[first.name, ...disagreeing].join(" and ")} could each be a field of`,
      line,
      "a backend cannot pick between two layouts, so the field is written in the literal that writes the object",
    );
  }

  /** The layout a field the body writes belongs to, or a refusal where there is none. */
  private layoutForWrite(base: Held, field: string, use: Inferred, line: number): string {
    const settled = this.narrowingFor(String(fieldOfValue(base, "name")));
    const layouts = this.layoutsWith(fieldOfValue(base, "inferred") as Inferred, String(fieldOfValue(base, "name")), field, use, line, settled);
    if (layouts.length > 0) return layouts[0];
    throw this.error(
      `writes "${String(fieldOfValue(base, "name"))}.${field}", which no layout the program lays out holds`,
      line,
      `the program lays out ${this.laidOut()}, and a field of an object it does not lay out cannot be written`,
    );
  }

  /** A call, or the one builtin that is an operation rather than a call. */
  private call(expression: Expression & { k: "call" }, line: number, expect: Inferred | null = null): Typed {
    const context = fieldOfValue(this, "context") as FunctionContext;
    const functions = fieldOfValue(context, "functions") as Record<string, FunctionContract>;
    const callArgs = fieldOfValue(expression, "args") as Expression[];
    const callName = String(fieldOfValue(expression, "name"));
    // A value the read could not settle. The read refuses the construct where
    // it is written; this is where a refusal that did not survive in the
    // declaration's trial becomes one the build reports, rather than a zero the
    // program reads a field of.
    if (callName.startsWith("__refused_")) {
      const at = Number(callName.slice("__refused_".length));
      throw this.error(
        "a construct outside the subset the compiler reads reached the body",
        line,
        `the construct on line ${at} of the source was refused, and the value it writes is not one this compiler has`,
      );
    }
    // `await v` is the value the promise `v` carries. A value that is not a
    // promise is awaited as itself, and a promise's value is the type the use
    // asks for: a function's body is typed before it is written, so the use is
    // what says which value is read out of the promise.
    if (callName === "Promise.await") {
      const operand = this.typed(callArgs[0] as Expression, null, line);
      const inferred = fieldOfValue(operand, "inferred") as Inferred;
      const inferredType = fieldOfValue(inferred, "type") as TypeExpr;
      const promise = String(fieldOfValue(inferred, "kind")) === "type" && inferredType.kind === "ref" && inferredType.of === null && inferredType.name === undefined;
      if (!promise) return operand;
      let payload: TypeExpr = expect !== null && String(fieldOfValue(expect, "kind")) === "type" ? fieldOfValue(expect, "type") as TypeExpr : ANY_REF;
      // A use that fixes no type is a use of the value the promise carries,
      // which the contract of an async function states beside its own.
      if (payload.kind === "ref" && payload.of === null && payload.name === undefined) {
        const awaited = callArgs[0];
        if (awaited !== undefined && awaited.k === "call") {
          const awaitedName = String(fieldOfValue(awaited, "name"));
          const awaitedArgs = fieldOfValue(awaited, "args") as Expression[];
          const contract = functions[awaitedName] ?? functions[`${awaitedName}__${awaitedArgs.length}`];
          if (contract !== undefined && fieldOfValue(contract, "promise") !== undefined) payload = parseType(String(fieldOfValue(contract, "promise")));
        }
      }
      const callee = payload.kind === "text"
        ? "Promise.await.text"
        : payload.kind === "primitive" && payload.name === "bool"
          ? "Promise.await.bool"
          : payload.kind === "primitive" && isWhole(payload.name)
            ? "Promise.await.whole"
            : payload.kind === "void"
              ? "Promise.await.nothing"
              : payload.kind === "ref"
                ? "Promise.await.value"
                : "Promise.await";
      const awaited = builtinFor(callee) as BuiltinSignature;
      const returns = fieldOfValue(awaited, "returns") as SemanticType;
      return {
        value: {
          k: "call",
          type: returns,
          call: this.semanticCall(
            callee,
            {
              name: callee,
              symbol: callee,
              params: (fieldOfValue(awaited, "params") as readonly SemanticType[]).map((type, at) => ({ name: `argument${at}`, type: contractText(type) })),
              returns: contractText(returns),
            },
            [fieldOfValue(operand, "value") as SemanticValue],
            returns,
            [],
            true,
            [(fieldOfValue(operand, "value") as SemanticValue).type],
          ),
        },
        inferred: asType(returns),
      };
    }
    // `BigInt(x)` is the whole number a value names, and a literal argument is
    // a value the compiler already holds: folding it is what lets a constant
    // expression be written the way the language writes one, `2n ** BigInt(8n)`.
    if (callName === "BigInt") {
      const folded = this.bigIntCall(expression);
      if (folded !== null) return folded;
    }
    // `new Promise((resolve, reject) => { ... })`: the executor is a function
    // of the file, and the runtime calls it before the handle is answered. The
    // value handed over is the function the executor lifted to, with the values
    // it captured, which the backend calls in front of the promise's own
    // current-promise bookkeeping. The settle parameters were dropped from the
    // lifted function when the frontend read the allocation.
    if (callName === "Promise") {
      const promise = builtinFor("Promise") as BuiltinSignature;
      this.builtinArity("Promise", promise, callArgs.length, line);
      const executor = callArgs[0];
      let handed: SemanticValue;
      if (executor !== undefined && executor.k === "arrow") {
        const lifted = functions[String(fieldOfValue(executor, "name"))];
        if (lifted === undefined) {
          throw this.error(
            `calls the executor ${String(fieldOfValue(executor, "name"))}, which the program does not compile`,
            line,
            "a promise executor is a function of the same file",
          );
        }
        const captures: CaptureRef[] = (fieldOfValue(executor, "captures") as string[]).map((name) => {
          const held = this.typed({ k: "ident", name }, null, line).value;
          return { name, type: fieldOfValue(held, "type") as SemanticType };
        });
        handed = { k: "functionRef", type: VOID, name: String(fieldOfValue(fieldOfValue(lifted, "function"), "symbol")), captures };
      } else if (executor !== undefined) {
        handed = this.typed(executor, null, line).value;
      } else {
        throw this.error("a promise takes one executor", line);
      }
      return {
        value: {
          k: "call",
          type: fieldOfValue(promise, "returns") as SemanticType,
          call: this.semanticCall(
            "Promise",
            {
              name: "Promise",
              symbol: "Promise",
              params: [{ name: "argument0", type: contractText(ANY_REF) }],
              returns: contractText(fieldOfValue(promise, "returns") as SemanticType),
            },
            [handed],
            fieldOfValue(promise, "returns") as SemanticType,
            (fieldOfValue(promise, "effects") as readonly Effect[] | undefined) ?? [],
            true,
            [ANY_REF],
          ),
        },
        inferred: asType(fieldOfValue(promise, "returns") as SemanticType),
      };
    }
    // A function the program compiles is the name the source bound: a local or
    // an import shadows a builtin of the same name, as it does in the language.
    // The builtin is the fallback for a name the program does not declare.
    const directOverload = `${callName}__${callArgs.length}`;
    const direct = functions[directOverload] ?? functions[callName];
    if (direct !== undefined) {
      const called = functions[directOverload] !== undefined ? directOverload : callName;
      const signature = fieldOfValue(direct, "function") as FunctionSignature;
      const signatureParams = fieldOfValue(signature, "params") as FunctionSignature["params"];
      this.arity(called, signatureParams.length, callArgs.length, line);
      const args = callArgs.map((argument, at) => this.typed(argument, asType(parseType(String(fieldOfValue(signatureParams[at], "type")))), line));
      const returns = parseType(String(fieldOfValue(signature, "returns")));
      return {
        value: {
          k: "call",
          type: returns,
          call: this.semanticCall(String(fieldOfValue(signature, "symbol")), signature, args.map((argument) => fieldOfValue(argument, "value") as SemanticValue), returns, fieldOfValue(direct, "effects") as readonly Effect[], false, []),
        },
        inferred: asType(returns),
      };
    }
    // `structuredClone(value)` is the language's deep copy: a scalar or a text
    // is the value itself, and an object, a list or a dictionary is copied by
    // the runtime when the program runs. The copy carries the type the source
    // read the value at, so a field of it reads as it did.
    if (callName === "structuredClone" && callArgs.length === 1) {
      const argument = this.typed(callArgs[0], null, line);
      const type = argument.value.type;
      if (type.kind === "primitive" || type.kind === "text") return argument;
      const signature = {
        name: "structuredClone",
        symbol: "structuredClone",
        params: [{ name: "value", type: contractText(type) }],
        returns: contractText(type),
      };
      return {
        value: {
          k: "call",
          type,
          call: this.semanticCall("structuredClone", signature, [argument.value], type, [], true, [type]),
        },
        inferred: asType(type),
      };
    }
    const builtin = builtinFor(callName);
    if (builtin !== null) {
      this.builtinArity(callName, builtin, callArgs.length, line);
      const builtinParams = fieldOfValue(builtin, "params") as readonly SemanticType[];
      const args = callArgs.map((argument, at) => this.typed(argument, asType(builtinParams[at]), line));
      // What the read of the call knows it answers, where the builtin's own
      // result is the opaque value the ABI carries: a map of lists answers the
      // list it holds, and the call that lowers to the block is typed as one.
      const declaredReturns = fieldOfValue(expression, "returns") as SemanticType | undefined;
      const returns = declaredReturns === undefined ? fieldOfValue(builtin, "returns") as SemanticType : declaredReturns;
      const extreme = EXTREMES[callName];
      if (extreme !== undefined) {
        return {
          value: {
            k: "arith",
            type: this.common(args[0].value.type, args[1].value.type, line),
            op: extreme,
            left: args[0].value,
            right: args[1].value,
          },
          inferred: asType(returns),
        };
      }
      if (callName === ARGV_LENGTH) return { value: { k: "argv", type: returns, index: null }, inferred: asType(returns) };
      if (callName === ARGV) return { value: { k: "argv", type: returns, index: fieldOfValue(args[0], "value") as SemanticValue }, inferred: asType(returns) };
      // The settle functions of a promise carry whatever the source hands
      // them: reading the value at the builtin's untyped parameter would hand
      // a number over as the dynamic reference it is not, and the runtime
      // would settle the promise with the wrong kind.
      const settles = callName === "resolve" || callName === "onFulfilled" ||
        callName === "reject" || callName === "onRejected";
      const handed = settles ? args.map((argument) => (fieldOfValue(argument, "value") as SemanticValue).type) : fieldOfValue(builtin, "params") as readonly SemanticType[];
      return {
        value: {
          k: "call",
          type: returns,
          call: this.semanticCall(
            callName,
            {
              name: callName,
              symbol: callName,
              params: handed.map((type, at) => ({ name: `argument${at}`, type: contractText(type) })),
              returns: contractText(returns),
            },
            args.map((argument) => fieldOfValue(argument, "value") as SemanticValue),
            returns,
            // A builtin's effects are the world it reads: a file question, a
            // command started, a clock read. A call the read knows is free is a
            // value the optimizer may move; one that reads the world is not,
            // and folding it past the statement that frees what it reads undid
            // the order the source wrote.
            (fieldOfValue(builtin, "effects") as readonly Effect[] | undefined) ?? [],
            true,
            handed,
          ),
        },
        inferred: asType(returns),
      };
    }
    // A function with default parameters is callable at every arity from the
    // last parameter without one up to all of them, and each shorter arity is
    // the overload the module declared for it. The full function is the one the
    // source named; the overload is the one that fills what the call left out.
    const overloadName = `${callName}__${callArgs.length}`;
    const overload = functions[overloadName];
    const callee = overload ?? functions[callName];
    const called = overload !== undefined ? overloadName : callName;
    if (callee === undefined) {
      throw this.error(
        `calls "${callName}", which the program does not compile`,
        line,
        `a function may only call the functions of the program it is part of`,
      );
    }
    const signature = fieldOfValue(callee, "function") as FunctionSignature;
    const signatureParams = fieldOfValue(signature, "params") as FunctionSignature["params"];
    this.arity(called, signatureParams.length, callArgs.length, line);
    const args = callArgs.map((argument, at) => this.typed(argument, asType(parseType(String(fieldOfValue(signatureParams[at], "type")))), line));
    const returns = parseType(String(fieldOfValue(signature, "returns")));
    return {
      value: { k: "call", type: returns, call: this.semanticCall(String(fieldOfValue(signature, "symbol")), signature, args.map((argument) => fieldOfValue(argument, "value") as SemanticValue), returns, fieldOfValue(callee, "effects") as readonly Effect[], false, []) },
      inferred: asType(returns),
    };
  }

  /** A call, with every argument placed and who owns what it hands back. */
  private semanticCall(
    callee: string,
    signature: FunctionSignature,
    args: readonly SemanticValue[],
    returns: SemanticType,
    effects: readonly Effect[],
    builtin: boolean,
    argTypes?: readonly SemanticType[],
  ): SemanticCall {
    const callArgs: SemanticValue[] = [];
    for (const one of args) callArgs.push(one);
    const signatureParams = fieldOfValue(signature, "params") as FunctionSignature["params"];
    const callArgTypes: SemanticType[] = [];
    if (argTypes === undefined) {
      for (const param of signatureParams) callArgTypes.push(parseType(String(fieldOfValue(param, "type"))));
    } else {
      for (const one of argTypes) callArgTypes.push(one);
    }
    const callEffects: Effect[] = [];
    for (const one of effects) callEffects.push(one);
    return {
      callee,
      signature,
      args: callArgs,
      argTypes: callArgTypes,
      returns,
      effects: callEffects,
      ownership: ownership(returns),
      retain: false,
      builtin,
    };
  }

  /**
   * The number of arguments a call of this name must have. A builtin that is
   * written in more than one form states the counts it may be written with, and
   * a call of it is one of them.
   */
  private builtinArity(name: string, builtin: BuiltinSignature, written: number, line: number): void {
    const arities = fieldOfValue(builtin, "arities") as readonly number[] | undefined;
    const params = fieldOfValue(builtin, "params") as readonly SemanticType[];
    const expected = arities ?? [params.length];
    if (expected.includes(written)) return;
    const counts = expected.map((count) => `${count} argument${count === 1 ? "" : "s"}`).join(" or ");
    throw this.error(`${name} takes ${counts}, not ${written}`, line);
  }

  private arity(name: string, expected: number, written: number, line: number): void {
    if (expected === written) return;
    throw this.error(`${name} takes ${expected} argument${expected === 1 ? "" : "s"}, not ${written}`, line);
  }

  private binary(expression: Expression & { k: "binary" }, line: number): Typed {
    const op = String(fieldOfValue(expression, "op")) as BinaryOp;
    if (op === "&&" || op === "||") {
      // The left arm decides first, and the source form of these operators
      // writes that arm out twice, so a call in it is written under a name.
      const left = this.decide(fieldOfValue(expression, "left") as Expression, line);
      const right = this.typed(fieldOfValue(expression, "right") as Expression, null, line);
      // They hand back one of their arms, so the IR states the type both arms
      // are, and so does the inferred type: `const n = +Deno.args[0] || 1`
      // binds a number, not the truth the test of it would be.
      const type = this.logicalType((fieldOfValue(left, "value") as SemanticValue).type, (fieldOfValue(right, "value") as SemanticValue).type, line);
      return {
        value: {
          k: "logical",
          type,
          op: op === "&&" ? "and" : "or",
          left: fieldOfValue(left, "value") as SemanticValue,
          right: fieldOfValue(right, "value") as SemanticValue,
        },
        inferred: asType(type),
      };
    }
    if (op === "??") {
      const left = this.decide(fieldOfValue(expression, "left") as Expression, line);
      const right = this.typed(fieldOfValue(expression, "right") as Expression, null, line);
      const held = coalesce(fieldOfValue(left, "inferred") as Inferred, fieldOfValue(right, "inferred") as Inferred);
      // `a ?? b` answers `a` where it is there and `b` where it is not, so the
      // whole is the arm that names the value. A text is inferred as the
      // unshaped reference a string is, so a text read out of a field would
      // lose its type here where the source wrote `field ?? ""`; the value
      // itself says it is a text. A left arm that says nothing leaves the
      // right arm to answer, which is the rule the frontend and `coalesce`
      // state.
      const unshaped = saysNothing(fieldOfValue(left, "inferred") as Inferred);
      const type = isText((fieldOfValue(left, "value") as SemanticValue).type) || (unshaped && isText((fieldOfValue(right, "value") as SemanticValue).type))
        ? TEXT
        : this.typeOf(held, line);
      return {
        value: { k: "coalesce", type, left: fieldOfValue(left, "value") as SemanticValue, right: fieldOfValue(right, "value") as SemanticValue },
        inferred: held,
      };
    }
    // `>>>` is the operator the language converts rather than refuses: both of
    // its sides are read as the unsigned 32 bit numbers the language reads
    // them as, whatever they are, and what it answers is one of those. The
    // program path states it the same way (semantics/ir-resolve.ts), so a
    // function and a program body answer the same question the same way. A
    // shift of a double is a shift no target has: the C backend writes
    // `double >> double`, which is not C at all.
    const converting = op === ">>>";
    // A text written beside a value is the type of the comparison: the field
    // the other side reads is a text field, not a number that happens to share
    // its name. The expectation is the text type itself, not `asType(TEXT)`:
    // that shape is the unshaped reference every string is, which filters
    // nothing.
    const rightExpression = fieldOfValue(expression, "right") as Expression;
    const compareText = rightExpression.k === "text" ||
      (rightExpression.k === "literal" &&
        fieldOfValue(rightExpression, "boolean") !== true &&
        fieldOfValue(rightExpression, "text") !== undefined &&
        !NUMBER_TEXT.test(String(fieldOfValue(rightExpression, "text"))));
    const left = this.typed(fieldOfValue(expression, "left") as Expression, converting ? asType(U32) : compareText ? { kind: "type", type: TEXT } : null, line);
    // The count of a shift is a machine word, whatever the number being shifted
    // is: the kernel every backend shifts with takes one word of count, and a
    // count typed at the width of a wide number is the low half of the number
    // being shifted rather than the number of bits to move. `wholeResult` types
    // both sides at the width of the wide one, which is the value's width and
    // not the count's. The count of a `>>>` is one of the 32 bit numbers the
    // language reads its sides as, so it is read as one of those.
    const counted = op === "<<" || op === ">>";
    const right = this.typed(fieldOfValue(expression, "right") as Expression, counted ? asType(USIZE) : converting ? asType(U32) : null, line);
    // Asking whether a value is there is a different question from comparing
    // two of them, and one the IR states on its own.
    if (EQUALITY.includes(op) && ((fieldOfValue(expression, "left") as Expression).k === "null" || (fieldOfValue(expression, "right") as Expression).k === "null")) {
      const other = (fieldOfValue(expression, "left") as Expression).k === "null" ? right : left;
      return {
        value: { k: "isNull", type: BOOLEAN, operand: fieldOfValue(other, "value") as SemanticValue, negate: op === "!==" || op === "!=" },
        inferred: asType(BOOL),
      };
    }
    const ordering = COMPARISONS[op];
    if (ordering !== null) {
      // A comparison is read at one width, and a literal written beside a wide
      // number is read at that width: `0 < curve.n` is a comparison of two wide
      // numbers.
      // Two texts are ordered by what they say, which is the comparison the
      // text operand names; a number beside one is not the question this asks.
      const bothText = isText((fieldOfValue(left, "value") as SemanticValue).type) && isText((fieldOfValue(right, "value") as SemanticValue).type);
      const wide = isWideType((fieldOfValue(left, "value") as SemanticValue).type) ? (fieldOfValue(left, "value") as SemanticValue).type : isWideType((fieldOfValue(right, "value") as SemanticValue).type) ? (fieldOfValue(right, "value") as SemanticValue).type : null;
      const leftValue = wide === null ? fieldOfValue(left, "value") as SemanticValue : this.wideOperand(fieldOfValue(left, "value") as SemanticValue, wide, line);
      const rightValue = wide === null ? fieldOfValue(right, "value") as SemanticValue : this.wideOperand(fieldOfValue(right, "value") as SemanticValue, wide, line);
      return {
        value: {
          k: "compare",
          type: BOOLEAN,
          op: ordering,
          operand: bothText ? TEXT : this.operand(leftValue, rightValue),
          left: bothText ? this.asText(leftValue) : leftValue,
          right: bothText ? this.asText(rightValue) : rightValue,
        },
        inferred: asType(BOOL),
      };
    }
    if (EQUALITY.includes(op)) {
      const text = isText((fieldOfValue(left, "value") as SemanticValue).type) || isText((fieldOfValue(right, "value") as SemanticValue).type);
      if (text && !(isText((fieldOfValue(left, "value") as SemanticValue).type) && isText((fieldOfValue(right, "value") as SemanticValue).type))) {
        throw this.error(
          `"${op}" compares a ${typeText((fieldOfValue(left, "value") as SemanticValue).type)} and a ${typeText((fieldOfValue(right, "value") as SemanticValue).type)}`,
          line,
          `a string is only compared with a string, and with another string for ===`,
        );
      }
      const wide = isWideType((fieldOfValue(left, "value") as SemanticValue).type) ? (fieldOfValue(left, "value") as SemanticValue).type : isWideType((fieldOfValue(right, "value") as SemanticValue).type) ? (fieldOfValue(right, "value") as SemanticValue).type : null;
      const leftValue = wide === null ? fieldOfValue(left, "value") as SemanticValue : this.wideOperand(fieldOfValue(left, "value") as SemanticValue, wide, line);
      const rightValue = wide === null ? fieldOfValue(right, "value") as SemanticValue : this.wideOperand(fieldOfValue(right, "value") as SemanticValue, wide, line);
      return {
        value: {
          k: "compare",
          type: BOOLEAN,
          op: op === "==" || op === "===" ? "eq" : "ne",
          operand: text ? TEXT : this.operand(leftValue, rightValue),
          left: text ? this.asText(leftValue) : leftValue,
          right: text ? this.asText(rightValue) : rightValue,
        },
        inferred: asType(BOOL),
      };
    }
    // A string added to a string is the one operation with no number behind it.
    if (isText((fieldOfValue(left, "value") as SemanticValue).type) || isText((fieldOfValue(right, "value") as SemanticValue).type)) {
      if (!isText((fieldOfValue(left, "value") as SemanticValue).type) || !isText((fieldOfValue(right, "value") as SemanticValue).type)) {
        throw this.error(
          `"${op}" is written over a ${typeText((fieldOfValue(left, "value") as SemanticValue).type)} and a ${typeText((fieldOfValue(right, "value") as SemanticValue).type)}`,
          line,
          `a string is added to a string, and compared with == and ===`,
        );
      }
      return {
        value: { k: "arith", type: TEXT, op: "concat", left: fieldOfValue(left, "value") as SemanticValue, right: fieldOfValue(right, "value") as SemanticValue },
        inferred: asType(numeric(fieldOfValue(left, "inferred") as Inferred, fieldOfValue(right, "inferred") as Inferred)),
      };
    }
    // An array added to an array joins the two: the elements of the right
    // follow those of the left. Anything else mixed with an array is refused.
    if (isSequence((fieldOfValue(left, "value") as SemanticValue).type) || isSequence((fieldOfValue(right, "value") as SemanticValue).type)) {
      if (!isSequence((fieldOfValue(left, "value") as SemanticValue).type) || !isSequence((fieldOfValue(right, "value") as SemanticValue).type)) {
        throw this.error(
          `"${op}" is written over a ${typeText((fieldOfValue(left, "value") as SemanticValue).type)} and a ${typeText((fieldOfValue(right, "value") as SemanticValue).type)}`,
          line,
          `a list is added to a list, and compared with == and ===`,
        );
      }
      return {
        value: { k: "arith", type: (fieldOfValue(left, "value") as SemanticValue).type, op: "arrayConcat", left: fieldOfValue(left, "value") as SemanticValue, right: fieldOfValue(right, "value") as SemanticValue },
        inferred: fieldOfValue(left, "inferred") as Inferred,
      };
    }
    // `%`, a shift and a bitwise operator are operations on whole numbers
    // whatever the literals were written as: `1 << 4` is 16, not a shift of
    // two doubles, and a target has no shift of anything else.
    //
    // The rules of the language the source was written in are asked of the
    // language: a division of two whole numbers is a whole division in one
    // language and a true division in another, and a remainder takes the sign
    // of its left side in one and of its divisor in the other.
    const rules = rulesFor(String(fieldOfValue(fieldOfValue(this, "context"), "language")));
    const type = op === "/" && rules.division === "true"
      ? F64
      : converting
        ? U32
        : WHOLE_OPERATORS[op] === true
          ? wholeResult(fieldOfValue(left, "inferred") as Inferred, fieldOfValue(right, "inferred") as Inferred)
          : numeric(fieldOfValue(left, "inferred") as Inferred, fieldOfValue(right, "inferred") as Inferred);
    const arithmetic = op === "%" && rules.remainder === "floored" ? "floorMod" : (ARITHMETIC[op] as ArithOp);
    // A power of whole numbers is a whole number: it is folded where both sides
    // are constant, written out as the products it is where the exponent is a
    // small constant, and refused otherwise. A double's power is what the
    // library answers, and a wide number is not one.
    if (op === "**") {
      const power = this.power(fieldOfValue(left, "value") as SemanticValue, fieldOfValue(right, "value") as SemanticValue, line);
      if (power !== null) return power;
      if (isInteger((fieldOfValue(left, "value") as SemanticValue).type) || isInteger((fieldOfValue(right, "value") as SemanticValue).type)) {
        throw this.error(
          '"**" needs numbers',
          line,
          "a power is a double's operation; over whole numbers write the products out, or keep the exponent small and constant",
        );
      }
    }
    // A wide result is computed over two wide numbers. An operand of a
    // narrower whole type is widened into a name of the wide type, which is
    // the store the backends already widen at; a literal is the value itself.
    const leftWide = this.wideOperand(fieldOfValue(left, "value") as SemanticValue, type, line);
    // A shift's right side is the machine word of count, not the shifted
    // value's width: it is read as one above and is not widened with it.
    const rightWide = counted || converting ? fieldOfValue(right, "value") as SemanticValue : this.wideOperand(fieldOfValue(right, "value") as SemanticValue, type, line);
    const folded = this.foldedValue(arithmetic, leftWide, rightWide, type);
    if (folded !== null) return folded;
    // A wide remainder is the kernels' answer, not the machine's: the product
    // of two 256 bit numbers does not fit in one, and a `%` of the low half is
    // a different number from the remainder of the whole.
    if (String(arithmetic) === "mod" && type.kind === "primitive" && type.name === "u256") {
      const reduced = modularReduction(leftWide, rightWide, (name, args) => this.wideKernel(name, args));
      if (reduced !== null) return { value: reduced, inferred: asType(type) };
    }
    return {
      value: { k: "arith", type, op: arithmetic, left: leftWide, right: rightWide },
      inferred: asType(type),
    };
  }

  /** A `BigInt(...)` of a value written out, answered here rather than at a
   * runtime that has no such call. */
  private bigIntCall(expression: Expression & { k: "call" }): Typed | null {
    const callArguments = fieldOfValue(expression, "args") as Expression[];
    if (callArguments.length !== 1) return null;
    const argument = callArguments[0];
    const kind = String(fieldOfValue(argument, "k"));
    let text: string | null = null;
    if (kind === "literal") {
      text = String(fieldOfValue(argument, "text"));
    } else if (kind === "text") {
      const parts = fieldOfValue(argument, "parts") as readonly Expression[];
      if (parts.length === 1 && String(fieldOfValue(parts[0], "k")) === "text") {
        text = String(fieldOfValue(parts[0], "value"));
      }
    }
    if (text === null) return null;
    const value = wholeText(text);
    if (value === null) return null;
    const fits = value <= 9223372036854775807n && value >= -9223372036854775808n;
    const type = fits ? I64 : wholeType("u256");
    const constant = wholeConstant(value, type);
    if (constant === null) return null;
    return { value: constant, inferred: asType(type) };
  }

  /**
   * The value of a power of whole numbers, or null where it is not one this
   * body can answer.
   *
   * A constant base and a constant exponent are folded exactly, at the width
   * that holds the answer. A base the body reads is multiplied by itself for
   * each count of a small exponent — `x ** 2n` is `x * x` — because a power of
   * a whole number is a product of them and the kernels have no wide power.
   */
  private power(base: SemanticValue, exponent: SemanticValue, line: number): Typed | null {
    const count = exponent.k === "const" ? wholeText(String(fieldOfValue(exponent, "text"))) : null;
    if (count === null || count < 0n) return null;
    // A bigint and a number are not mixed, and a power is where that rule is
    // easiest to miss: `2n ** 3` is a bigint raised by a number, which the
    // language raises on rather than reading one as the other.
    if (!isInteger(fieldOfValue(base, "type") as SemanticType) || !isInteger(fieldOfValue(exponent, "type") as SemanticType)) return null;
    if (base.k === "const") {
      const value = wholeText(String(fieldOfValue(base, "text")));
      if (value === null) return null;
      const exact = wholePower(value, count);
      if (exact === null) return null;
      const wide = isWideType(fieldOfValue(base, "type") as SemanticType) || exact > 9223372036854775807n || exact < -9223372036854775808n;
      const type = wide ? wholeType("u256") : I64;
      const constant = wholeConstant(exact, type);
      if (constant === null) return null;
      return { value: constant, inferred: asType(type) };
    }
    if (count > 64n) return null;
    if (count === 0n) {
      const one = wholeConstant(1n, isWideType(fieldOfValue(base, "type") as SemanticType) ? wholeType("u256") : I64);
      if (one === null) return null;
      return { value: one, inferred: asType(fieldOfValue(one, "type") as SemanticType) };
    }
    // A base that computes something would run again for every factor, and the
    // body said it once. It is read once into a name of its own first, and the
    // products are of that name: a sum written as the base of a power is
    // evaluated once, as it is in the language.
    let value = base;
    if (base.k !== "local") {
      const name = this.generated("t");
      const slot: SemanticSlot = { kind: "value", name, mutable: false, type: fieldOfValue(base, "type") as SemanticType };
      this.write({ k: "let", slot, value: base, line });
      value = { k: "local", type: fieldOfValue(base, "type") as SemanticType, name };
    }
    let product: SemanticValue = value;
    for (let factor = 1n; factor < count; factor += 1n) {
      product = { k: "arith", type: fieldOfValue(value, "type") as SemanticType, op: "mul", left: product, right: value };
    }
    return { value: product, inferred: asType(fieldOfValue(value, "type") as SemanticType) };
  }

  /**
   * A whole-number operation on two constants, answered here rather than by
   * the target.
   *
   * The answer is the one the type holds, so a fold and the code the same
   * operation would have been lowered to agree. A text that is not a whole
   * number, or an operation whose answer the type cannot state (a division by
   * zero), is left to the ordinary path.
   */
  private foldedValue(op: ArithOp, left: SemanticValue, right: SemanticValue, type: SemanticType): Typed | null {
    if (left.k !== "const" || right.k !== "const") return null;
    if (type.kind !== "primitive" || !isWhole(type.name)) return null;
    if (!isInteger(left.type) || !isInteger(right.type)) return null;
    const first = wholeText(left.text);
    const second = wholeText(right.text);
    if (first === null || second === null) return null;
    const value = foldWhole(op, first, second, type.name);
    if (value === null) return null;
    const constant = wholeConstant(value, type);
    if (constant === null) return null;
    return { value: constant, inferred: asType(type) };
  }

  /**
   * Whether a value is a buffer, whose elements are read at a position its
   * type measures.
   *
   * A value the read could not name is a dynamic value: its elements are the
   * runtime's entries, read through the dictionary or array services rather
   * than as a buffer.
   */
  private isBufferValue(type: SemanticType): boolean {
    return type.kind === "ptr" || type.kind === "slice" || type.kind === "array" || type.kind === "mask";
  }

  /** A runtime call of one builtin, kept for what it does or read for what it answers. */
  private runtimeCall(name: string, args: readonly SemanticValue[], returns: SemanticType): Typed {
    const builtin = builtinFor(name) as BuiltinSignature;
    const call = this.semanticCall(
      name,
      {
        name,
        symbol: name,
        params: (fieldOfValue(builtin, "params") as readonly SemanticType[]).map((type, at) => ({ name: `argument${at}`, type: contractText(type) })),
        returns: contractText(returns),
      },
      args,
      returns,
      [],
      true,
      fieldOfValue(builtin, "params") as readonly SemanticType[],
    );
    return { value: { k: "call", type: returns, call }, inferred: asType(returns) };
  }

  /**
   * A value read from a dynamic value: an entry of a dictionary, or an element
   * of a dynamic array.
   *
   * The key's kind chooses the service: a text key asks the dictionary, and a
   * number key the dynamic array. A key the read could not name is asked as a
   * text, because a JavaScript table is keyed by name. What the use expects
   * chooses the accessor that answers it without a conversion the value cannot
   * survive: a text read is the text the entry holds, and a value read is the
   * handle the entry holds.
   */
  private dynamicIndexRead(base: Typed, key: Typed, expect: Inferred | null): Typed {
    const expected = expect !== null && String(fieldOfValue(expect, "kind")) === "type" ? fieldOfValue(expect, "type") as TypeExpr : null;
    const textKey = (fieldOfValue(key, "value") as SemanticValue).type.kind !== "primitive";
    let name: string;
    let returns: SemanticType;
    if (!textKey) {
      name = "blaze_rt_array_get";
      returns = F64;
    } else if (expected !== null && expected.kind === "text") {
      name = "blaze_rt_dict_get_text";
      returns = TEXT;
    } else if (expected !== null && this.isBufferValue(expected)) {
      name = "blaze_rt_dict_get_ref";
      returns = expected;
    } else if (expected !== null && expected.kind === "primitive" && expected.name !== "bool") {
      name = "blaze_rt_dict_get";
      returns = F64;
    } else {
      name = "blaze_rt_dict_get_ref";
      returns = ANY_REF;
    }
    return this.runtimeCall(name, [fieldOfValue(base, "value") as SemanticValue, fieldOfValue(key, "value") as SemanticValue], returns);
  }

  /**
   * A write into a dynamic value: the entry a text key names, or the element a
   * number key names.
   *
   * The value chooses the accessor that stores it without a conversion that
   * would lose what it is: a text is written as a text, a reference as the
   * handle it is, and a number as the entry it becomes.
   */
  private dynamicIndexWrite(base: Typed, key: Typed, value: Typed, line: number): void {
    const keyValue = fieldOfValue(key, "value") as SemanticValue;
    const writtenValue = fieldOfValue(value, "value") as SemanticValue;
    const textKey = keyValue.type.kind !== "primitive";
    const kind = writtenValue.type.kind;
    const text = kind === "text";
    const reference = kind === "ref" || kind === "ptr" || kind === "slice" || kind === "array";
    let name: string;
    if (textKey) {
      name = text ? "blaze_rt_dict_set_text" : reference ? "blaze_rt_dict_set_ref" : "blaze_rt_dict_set";
    } else {
      name = text ? "blaze_rt_dict_set_numkey_text" : reference ? "blaze_rt_dict_set_numkey_ref" : "blaze_rt_dict_set_numkey";
    }
    const call = this.runtimeCall(name, [fieldOfValue(base, "value") as SemanticValue, keyValue, writtenValue], F64);
    const callValue = fieldOfValue(call, "value") as SemanticValue;
    if (callValue.k === "call") this.write({ k: "call", call: fieldOfValue(callValue, "call") as SemanticCall, line });
  }

  /** A call of one of the wide modular kernels, as the builtin it is. */
  private wideKernel(name: string, args: readonly SemanticValue[]): SemanticValue | null {
    const builtin = builtinFor(name);
    if (builtin === null) return null;
    return {
      k: "call",
      type: fieldOfValue(builtin, "returns") as SemanticType,
      call: this.semanticCall(
        name,
        {
          name,
          symbol: name,
          params: (fieldOfValue(builtin, "params") as readonly SemanticType[]).map((type, at) => ({ name: `argument${at}`, type: contractText(type) })),
          returns: contractText(fieldOfValue(builtin, "returns") as SemanticType),
        },
        args,
        fieldOfValue(builtin, "returns") as SemanticType,
        [],
        true,
        fieldOfValue(builtin, "params") as readonly SemanticType[],
      ),
    };
  }

  /**
   * A value as the truth a branch tests.
   *
   * A machine word is a truth as it stands — zero is false and everything else
   * is true — and so is the accumulator a target branches on. A wide number is
   * four limbs and is not: it is compared with zero, which is the test the
   * source wrote with `!== 0n`.
   */
  private truth(value: SemanticValue): SemanticValue {
    if (!isWideType(fieldOfValue(value, "type") as SemanticType)) return value;
    return {
      k: "compare",
      type: BOOLEAN,
      op: "ne",
      operand: fieldOfValue(value, "type") as SemanticType,
      left: value,
      right: { k: "const", type: fieldOfValue(value, "type") as SemanticType, text: "0" },
    };
  }

  private unary(expression: Expression & { k: "unary" }, expect: Inferred | null, line: number): Typed {
    const op = String(fieldOfValue(expression, "op"));
    const operandExpression = fieldOfValue(expression, "operand") as Expression;
    // A number written with its sign is one literal, so a use can still fix its
    // type without a conversion.
    if (op === "-" && operandExpression.k === "literal") {
      return { value: { k: "const", type: numberAt(expect) ?? F64, text: `-${String(fieldOfValue(operandExpression, "text"))}` }, inferred: DOUBLE };
    }
    const operand = this.typed(operandExpression, null, line);
    const operandValue = fieldOfValue(operand, "value") as SemanticValue;
    const operandInferred = fieldOfValue(operand, "inferred") as Inferred;
    if (op === "+") return operand;
    if (op === "!") {
      // `!` asks what a value is rather than inverting a number: it is a null
      // test of a reference, an empty-string test of a string, and only a truth
      // is inverted as one.
      if (isText(operandValue.type)) {
        return {
          value: {
            k: "compare",
            type: BOOLEAN,
            op: "ne",
            operand: TEXT,
            left: operandValue,
            right: { k: "text", type: TEXT, parts: [{ k: "text", value: "" }] },
          },
          inferred: asType(BOOL),
        };
      }
      if (isBoolean(operandValue.type)) {
        return { value: { k: "unary", type: BOOLEAN, op: UNARY["!"], operand: operandValue }, inferred: asType(BOOL) };
      }
      if (isReference(operandValue.type)) {
        // `!a` asks whether a reference is nothing, which is the null test and
        // not its negation: `!node.left` is the arm a leaf takes.
        return { value: { k: "isNull", type: BOOLEAN, operand: operandValue, negate: false }, inferred: asType(BOOL) };
      }
      if (isInteger(operandValue.type)) {
        // A whole number is a truth as it stands, and a negation asks whether
        // it is zero. A wide number is four limbs and has no truth of its own,
        // so the test is written as the comparison both kinds answer.
        return {
          value: {
            k: "compare",
            type: BOOLEAN,
            op: "eq",
            operand: operandValue.type,
            left: operandValue,
            right: { k: "const", type: operandValue.type, text: "0" },
          },
          inferred: asType(BOOL),
        };
      }
      throw this.error(
        `negates a ${typeText(operandValue.type)}, which is not a truth`,
        line,
        `a number is not a truth, so the body says what it means by it`,
      );
    }
    const type = numberAt(operandInferred) ?? numeric(operandInferred, operandInferred);
    return { value: { k: "unary", type, op: UNARY[op as SourceUnaryOp], operand: operandValue }, inferred: asType(type) };
  }

  /**
   * `i++` and `++i` used as a value: `i++` hands back the value from before
   * the step and `++i` the one from after it, so the two differ only in the
   * order the step and the snapshot are written in. A step is a statement and
   * a value is not, so the value is written under a name of its own either
   * way, and a snapshot taken after the step is the only difference between
   * the two forms. Taking it before both is what made `++i` hand back the
   * value `i` already had.
   */
  private updated(expression: Expression & { k: "update" }, line: number): Typed {
    const held = this.read(String(fieldOfValue(expression, "name")), line);
    const type = slotType(fieldOfValue(held, "slot") as SemanticSlot);
    const snapshot = this.generated("t");
    const take = (): SemanticStatement => ({
      k: "let",
      slot: { kind: "value", name: snapshot, mutable: false, type },
      value: { k: "local", type, name: String(fieldOfValue(held, "name")) },
      line,
    });
    const step: SemanticStatement = {
      k: "step",
      name: String(fieldOfValue(held, "name")),
      op: String(fieldOfValue(expression, "op")) as "++" | "--",
      prefix: fieldOfValue(expression, "prefix") === true,
      line,
    };
    if (fieldOfValue(expression, "prefix") === true) this.pending.push(step, take());
    else this.pending.push(take(), step);
    return { value: { k: "local", type, name: snapshot }, inferred: fieldOfValue(held, "inferred") as Inferred };
  }

  /* ---------------------------------------------------------------------- */
  /* Objects                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * An object literal: the key its shape is filed under, the layout it is laid
   * out as, and every field as the body writes it.
   */
  private literal(fields: readonly { name: string; value: Expression }[], line: number): Literal {
    // A list written into a field is a slice, which is what the layout pass
    // types it as: the key of a shape is the types of its fields, and a body
    // that spelled this one differently would name a layout nothing lays out.
    const typed: { name: string; value: { [key: string]: unknown } }[] = [];
    for (const field of fields) {
      const fieldName = String(fieldOfValue(field, "name"));
      const fieldExpression = fieldOfValue(field, "value") as Expression;
      const value = this.typed(fieldExpression, null, line);
      const written = fieldOfValue(value, "value") as SemanticValue;
      // A text the source wrote is the text it is. The shape key has to say
      // text where the layout pass says text, or the literal is filed under a
      // key no layout names.
      if (written.k === "text") {
        setFieldValue(value, "inferred", textInferred());
      } else if (written.k === "const") {
        const writtenType = fieldOfValue(written, "type") as SemanticType;
        if (writtenType.kind === "primitive" && writtenType.name === "f64" &&
            fieldExpression.k === "literal" &&
            fieldOfValue(fieldExpression, "boolean") !== true &&
            !NUMBER_TEXT.test(String(fieldOfValue(written, "text")))) {
          setFieldValue(value, "inferred", textInferred());
        }
      }
      setFieldValue(value, "inferred", asField(fieldOfValue(value, "inferred") as Inferred));
      typed[typed.length] = { name: fieldName, value: value as unknown as { [key: string]: unknown } };
    }
    // The key is a function of the shape alone, and the shape is written as
    // JSON so that a field name cannot read like the key of another shape.
    const keyParts: [string, string][] = [];
    for (const field of typed) keyParts[keyParts.length] = [String(fieldOfValue(field, "name")), describe(fieldOfValue(fieldOfValue(field, "value"), "inferred") as Inferred)];
    const key = JSON.stringify(keyParts);
    if (!this.shapes.has(key)) {
      const shapeFields: { name: string; value: Inferred }[] = [];
      for (const field of typed) shapeFields[shapeFields.length] = { name: String(fieldOfValue(field, "name")), value: fieldOfValue(fieldOfValue(field, "value"), "inferred") as Inferred };
      this.shapes.set(key, { key, fields: shapeFields });
    }
    const literalFields: { name: string; value: SemanticValue }[] = [];
    for (const field of typed) literalFields[literalFields.length] = { name: String(fieldOfValue(field, "name")), value: fieldOfValue(fieldOfValue(field, "value"), "value") as SemanticValue };
    return { key, layout: this.layoutFor(key, line), fields: literalFields };
  }

  /**
   * An object literal as a value: the allocation and the fields that fill it
   * are one value, built where the source wrote it, so a literal in the arm of
   * a conditional is built when that arm is taken.
   */
  private allocated(expression: Expression & { k: "object" }, line: number): Typed {
    const literal = this.literal(fieldOfValue(expression, "fields") as readonly { name: string; value: Expression }[], line);
    const type = this.objectType(String(fieldOfValue(literal, "key")), line);
    return { value: { k: "newObject", type, layout: String(fieldOfValue(literal, "layout")), fields: fieldOfValue(literal, "fields") as { name: string; value: SemanticValue }[] }, inferred: { kind: "object", key: String(fieldOfValue(literal, "key")) } };
  }

  /**
   * The layout an object is laid out as, which only the layout pass knows: it
   * merges the shapes of every function that writes the same object into one
   * layout, and a body that named a layout of its own would name one layout for
   * one function and another for the function beside it.
   */
  private layoutFor(key: string, line: number): string {
    const known = this.layouts.get(key);
    if (known !== undefined) return known;
    const objectNames = fieldOfValue(fieldOfValue(this, "context"), "objectNames") as Record<string, string>;
    const exact = objectNames[key];
    if (exact !== undefined) {
      this.layouts.set(key, exact);
      return exact;
    }
    // A function that returns an object has its declared return narrowed to the
    // layout of that object once the layouts are built, so the shape this body
    // writes afterwards is spelled with the narrowed type where the layout pass
    // spelled it with the one the source declared. The object is the same
    // object: the fields it holds are the fields it is laid out as.
    const shape = this.shapes.get(key);
    const objects = fieldOfValue(this, "objects") as Record<string, ObjectLayout>;
    const shapeFields = shape === undefined ? [] : fieldOfValue(shape, "fields") as readonly { name: string; value: Inferred }[];
    const candidates: string[] = shape === undefined ? [] : this.knownLayouts(key, shape);
    const found = [...new Set(candidates)];
    if (found.length === 1) {
      this.layouts.set(key, found[0]);
      return found[0];
    }
    if (found.length > 1 && shape !== undefined) {
      const first = this.shapeSignature(found[0], shapeFields);
      if (found.every((name) => this.shapeSignature(name, shapeFields) === first)) return found[0];
      const literalNames = this.fieldNames(shapeFields);
      for (const name of found) {
        const layout = objects[name];
        if (layout === undefined) continue;
        if (this.sameNames(this.fieldNames(fieldOfValue(layout, "fields") as readonly { name: string }[]), literalNames)) return name;
      }
    }
    if (found.length === 0 && shape !== undefined) {
      // A shape the object pass folded into another can be asked for under the
      // key it had before the fold. The layouts that hold the same fields are
      // the object it was folded into, and a literal writes the same offsets
      // whichever name the pass kept.
      const literalNames = this.fieldNames(shapeFields);
      const objects = fieldOfValue(this, "objects") as Record<string, ObjectLayout>;
      for (const [name, layout] of Object.entries(objects)) {
        if (!this.sameNames(this.fieldNames(fieldOfValue(layout, "fields") as readonly { name: string }[]), literalNames)) continue;
        this.layouts.set(key, name);
        return name;
      }
    }
    if (found.length > 1) {
      console.log(`LAYOUT3 ${key} exact=${objectNames[key] ?? "none"} found=${found.join(",")}`);
      throw this.error(
        `writes an object ${found.join(" and ")} could each be`,
        line,
        `one literal is one object, and the program lays out ${this.laidOut()}`,
      );
    }
    throw this.error(
      "writes an object the program does not lay out",
      line,
      `the object is ${key}, and the program lays out ${this.laidOut()}`,
    );
  }

  /** The layouts the program lays out that hold the fields of one shape, in the order they are written. */
  private knownLayouts(key: string, shape: Shape): string[] {
    const found: string[] = [];
    const objectNames = fieldOfValue(fieldOfValue(this, "context"), "objectNames") as Record<string, string>;
    const objects = fieldOfValue(this, "objects") as Record<string, ObjectLayout>;
    for (const [shapeKey, name] of Object.entries(objectNames)) {
      if (shapeKey === key) continue;
      const layout = objects[name];
      if (layout === undefined || !holdsShape(shape, layout)) continue;
      found.push(name);
      if (found.length > 1) return found;
    }
    return found;
  }

  /** A reference to the layout an object is laid out as. */
  private objectType(key: string, line: number): SemanticType {
    return { kind: "ref", of: null, name: this.layoutFor(key, line) };
  }

  /** What a field of an object the body wrote holds, or a reference when unknown. */
  private fieldOfValue(key: string, field: string): Inferred {
    const shape = this.shapes.get(key);
    const fields = shape === undefined ? [] : fieldOfValue(shape, "fields") as readonly { name: string; value: Inferred }[];
    const found = fields.find((one) => one.name === field);
    return found === undefined ? ANY : fieldOfValue(found, "value") as Inferred;
  }

  /** What a field holds once the body has written it, which the layout is built from. */
  private stored(key: string, field: string, value: Inferred): void {
    const shape = this.shapes.get(key);
    if (shape === undefined) return;
    const fields = fieldOfValue(shape, "fields") as { name: string; value: Inferred }[];
    const known = fields.find((one) => one.name === field);
    if (known === undefined) fields.push({ name: field, value });
    else setFieldValue(known, "value", value);
  }

  /** The fields of one layout, spelled so two layouts of one shape compare equal. */
  private shapeSignature(name: string, shapeFields: readonly { name: string; value: Inferred }[]): string {
    const objects = fieldOfValue(this, "objects") as Record<string, ObjectLayout>;
    const layout = objects[name];
    if (layout === undefined) return "";
    const layoutFields = fieldOfValue(layout, "fields") as readonly { name: string; offset: number; type: string }[];
    let signature = "";
    for (const field of shapeFields) {
      const fieldName = String(fieldOfValue(field, "name"));
      let offset = -1;
      let type = "";
      for (const one of layoutFields) {
        if (one.name === fieldName) {
          offset = Number(fieldOfValue(one, "offset"));
          type = String(fieldOfValue(one, "type"));
        }
      }
      signature = signature + fieldName + "@" + String(offset) + ":" + type + ";";
    }
    return signature;
  }

  /** The names of a list of fields, in the order they are written. */
  private fieldNames(fields: readonly { name: string }[]): string[] {
    const names: string[] = [];
    for (const field of fields) names.push(String(fieldOfValue(field, "name")));
    return names;
  }

  /** True when two lists of field names name the same fields. */
  private sameNames(left: readonly string[], right: readonly string[]): boolean {
    if (left.length !== right.length) return false;
    for (const name of left) {
      let seen = false;
      for (const other of right) if (other === name) seen = true;
      if (!seen) return false;
    }
    return true;
  }

  /** The type a layout gives one field, as the IR states it. */
  private fieldType(layout: string, field: string, line: number): SemanticType {
    const objects = fieldOfValue(this, "objects") as Record<string, ObjectLayout>;
    const declared = objects[layout] === undefined ? undefined : (fieldOfValue(objects[layout], "fields") as readonly { name: string; type: string }[]).find((one) => one.name === field);
    if (declared === undefined) {
      throw this.error(
        `${layout} has no field ${field}`,
        line,
        `a field is written in the literal that writes the object`,
      );
    }
    return parseType(String(fieldOfValue(declared, "type")));
  }

  /** The layouts the program lays out, for a refusal that has to say what there is. */
  private laidOut(): string {
    const names = Object.keys(this.objects);
    return names.length === 0 ? "no objects" : names.join(", ");
  }

  /* ---------------------------------------------------------------------- */
  /* Slots and types                                                        */
  /* ---------------------------------------------------------------------- */

  /** The slot a name declared as this value is read by. */
  private slot(name: string, value: Typed, annotation: Inferred | null, line: number): SemanticSlot {
    const valueValue = fieldOfValue(value, "value") as SemanticValue;
    const valueInferred = fieldOfValue(value, "inferred") as Inferred;
    if (isText(valueValue.type)) return { kind: "text", name, mutable: true, boxed: true };
    const type =
      annotation !== null && String(fieldOfValue(valueInferred, "kind")) !== "object" ? this.typeOf(annotation, line) : this.typeOf(valueInferred, line);
    return this.slotOf(name, type, true);
  }

  /** A slot that holds a value of this type, so a name of it can be declared. */
  private slotOf(name: string, type: SemanticType, mutable: boolean): SemanticSlot {
    if (isText(type)) return { kind: "text", name, mutable, boxed: mutable };
    if (isReference(type)) return { kind: "object", name, mutable, type };
    return { kind: "value", name, mutable, type };
  }

  /** The type the IR states an inferred value as. */
  private typeOf(inferred: Inferred, line: number): SemanticType {
    return String(fieldOfValue(inferred, "kind")) === "type" ? fieldOfValue(inferred, "type") as TypeExpr : this.objectType(String(fieldOfValue(inferred, "key")), line);
  }

  /**
   * The type the arms of a short-circuit operator have in common, which is the
   * type of the arm the operator hands back.
   *
   * An arm that is a number or a truth is the test that decides whether the
   * other arm is handed back, so the two may be of different kinds: a number
   * beside a text is the test, and the text is the value the operator is
   * written as. The number is written as the text of that number when it is
   * the arm that answers.
   */
  private logicalType(left: SemanticType, right: SemanticType, line: number): SemanticType {
    const test = (type: SemanticType): boolean => isNumber(type) || isBoolean(type);
    if (isText(left) && test(right)) return TEXT;
    if (isText(right) && test(left)) return TEXT;
    return this.common(left, right, line);
  }

  /** The type two values of one expression have in common, or a refusal. */
  private common(left: SemanticType, right: SemanticType, line: number): SemanticType {
    // A truth is a type of its own, and two of them share one the way two
    // numbers do: the arms of `a > 0 && b > 0` are both truths, and refusing
    // them refuses every short-circuit operator over a condition.
    if (isBoolean(left) && isBoolean(right)) return left;
    if (isText(left) && isText(right)) return TEXT;
    const number = commonNumber(left, right);
    if (number !== null) return number;
    // Two arrays of one element type are one array, and a conditional of two
    // lengths is an array whose length the branch decides: `flag ? [] : [1, 2]`
    // is a list of numbers, not two lists of different types. The fixed length
    // survives only where both arms have it.
    if ((left.kind === "slice" || left.kind === "array") && (right.kind === "slice" || right.kind === "array")) {
      const of = this.common(left.of, right.of, line);
      if (left.kind === "array" && right.kind === "array" && left.length === right.length) {
        return { kind: "array", of, length: left.length };
      }
      return { kind: "slice", of };
    }
    // A reference is what the expression is about whenever one side is one: the
    // other side is the test that decides whether to hand it back, and a truth
    // or a number beside a reference is that and nothing more. A reference to a
    // layout says which object it is; one the source left unshaped says
    // nothing, and the other arm is then the better answer.
    if (left.kind === "ref") return layoutOf(left) ?? (right.kind === "ref" ? layoutOf(right) ?? left : left);
    if (right.kind === "ref") return layoutOf(right) ?? right;
    throw this.error(
      `a ${typeText(left)} cannot be used where a ${typeText(right)} is`,
      line,
      "one value in an expression has one type",
    );
  }

  /** The type two values are compared as, which is the one number they share. */
  private operand(left: SemanticValue, right: SemanticValue): SemanticType {
    return commonNumber(left.type, right.type) ?? F64;
  }

  /**
   * A whole number written out, read at the wide width its neighbour is: the
   * literal is the value it names, and the kernel takes two wide numbers.
   */
  private widenLiteral(value: SemanticValue, type: SemanticType): SemanticValue {
    if (!isWideType(type) || isWideType(value.type)) return value;
    if (value.k !== "const") return value;
    const number = wholeText(value.text);
    if (number === null || number < 0n) return value;
    return { k: "const", type, text: value.text };
  }

  /**
   * A whole number read at a wide type: a literal is written at that width,
   * and a value that computes something is stored into a name of the wide
   * type, which is where every backend widens a machine word into the wide
   * number's low limb.
   */
  private wideOperand(value: SemanticValue, type: SemanticType, line: number): SemanticValue {
    if (!isWideType(type) || isWideType(value.type)) return value;
    if (value.k === "const") return this.widenLiteral(value, type);
    // A choice of two written values is widened in both arms: it is the value
    // of either, and neither arm needs a store to become the wide number.
    if (value.k === "select") {
      const then = this.wideOperand(value.then, type, line);
      const otherwise = this.wideOperand(value.otherwise, type, line);
      // Both arms are written values that widened; a choice with an arm that
      // did not is left as it is, and the kernel's refusal says why.
      if (!isWideType(then.type) || !isWideType(otherwise.type)) return value;
      return { ...value, type, then, otherwise };
    }
    return value;
  }

  /* ---------------------------------------------------------------------- */
  /* Writing a value down                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * A value written under a name before the statement that uses it: the left
   * arm of a short-circuit operator decides first, and the source form of it
   * writes that arm out twice, so a call in it is run once.
   */
  private hoist(value: SemanticValue, line: number): SemanticValue {
    const name = this.generated("t");
    const type = fieldOfValue(value, "type") as SemanticType;
    this.pending.push({ k: "let", slot: this.slotOf(name, type, false), value, line });
    return { k: "local", type, name };
  }

  /** The left arm of `&&`, `||` and `??`, which is never written out twice. */
  private decide(expression: Expression, line: number): Typed {
    const value = this.typed(expression, null, line);
    const mapped = fieldOfValue(value, "value") as SemanticValue;
    if (!hasCall(mapped)) return value;
    return { value: this.hoist(mapped, line), inferred: fieldOfValue(value, "inferred") as Inferred };
  }

  /** A value as the text a string carries it as. */
  private asText(value: SemanticValue): SemanticValue {
    return isText(fieldOfValue(value, "type") as SemanticType) ? value : { k: "toText", type: TEXT, of: value, digits: null };
  }

  /* ---------------------------------------------------------------------- */
  /* Refusals                                                               */
  /* ---------------------------------------------------------------------- */

  /** A refusal that names the function and the line it was written at. */
  private error(message: string, line: number, detail?: string): CompilerError {
    const name = String(fieldOfValue(fieldOfValue(this.contract, "function"), "name"));
    return new CompilerError("SemanticIrError", "ir", `${name}: ${message}`, detail === undefined ? `line ${line} of ${name}` : `line ${line} of ${name}: ${detail}`, name, "", "");
  }
}

/* -------------------------------------------------------------------------- */
/* What the model says                                                        */
/* -------------------------------------------------------------------------- */

/** Every name the source declares, which a generated name is never one of. */
function sourceNames(list: readonly Statement[], into: Set<string>): Set<string> {
  for (const statement of list) {
    switch (statement.kind) {
      case "declare":
        into.add(String(fieldOfValue(statement, "name")));
        break;
      case "loop":
        into.add(String(fieldOfValue(statement, "variable")));
        sourceNames(fieldOfValue(statement, "body") as Statement[], into);
        break;
      case "if":
        sourceNames(fieldOfValue(statement, "then") as Statement[], into);
        sourceNames(fieldOfValue(statement, "otherwise") as Statement[], into);
        break;
      case "while":
      case "doWhile":
        sourceNames(fieldOfValue(statement, "body") as Statement[], into);
        break;
      case "forOf":
        into.add(String(fieldOfValue(statement, "variable")));
        sourceNames(fieldOfValue(statement, "body") as Statement[], into);
        break;
      default:
        break;
    }
  }
  return into;
}

/** An inferred value as the type the layout pass gives it. */
function asType(type: SemanticType): Inferred {
  // A text is a string, and a string is a reference the contract language does
  // not spell: what a use infers of it is the same as what it infers of any
  // other reference, and the value keeps the text it is.
  if (type.kind === "text") return { kind: "type", type: ANY_REF };
  return { kind: "type", type };
}

/** What a name holds once it is declared: an object is what it was written as. */
function bound(inferred: Inferred, annotation: Inferred | null): Inferred {
  if (String(fieldOfValue(inferred, "kind")) === "object" || annotation === null) return inferred;
  return annotation;
}

/** Who owns what a call of a type hands back. */
function ownership(returns: SemanticType): Ownership {
  // A slice is a block the runtime laid out: the call hands one back and the
  // caller owns it. A pointer is a window into a block someone else owns, and
  // everything else is a number.
  if (returns.kind === "ref" || returns.kind === "slice") return "owned";
  if (returns.kind === "ptr") return "borrowed";
  return "none";
}

/** The number a use fixes a written number to, where it fixes one at all. */
function numberAt(inferred: Inferred | null): TypeExpr | null {
  if (inferred === null || String(fieldOfValue(inferred, "kind")) !== "type") return null;
  const type = fieldOfValue(inferred, "type") as TypeExpr;
  return type.kind === "primitive" ? type : null;
}

/** The reference a use expects, where it expects one at all. */
function referenceAt(inferred: Inferred | null): TypeExpr | null {
  if (inferred === null || String(fieldOfValue(inferred, "kind")) !== "type") return null;
  const type = fieldOfValue(inferred, "type") as TypeExpr;
  return isReference(type) || type.kind === "void" ? type : null;
}

/** Whether a type is a string, which the contract type language does not have. */
function isText(type: SemanticType): boolean {
  return type.kind === "text";
}

/** Whether a type is a truth. */
function isBoolean(type: SemanticType): boolean {
  return type.kind === "primitive" && String(fieldOfValue(type, "name")) === "bool";
}

/** The reference that names the layout it points at, where one does. */
function layoutOf(type: SemanticType): SemanticType | null {
  return type.kind === "ref" && String(fieldOfValue(type, "name")) !== undefined ? type : null;
}

/**
 * Whether a layout holds the fields of a shape.
 *
 * The fields are compared by name rather than by position, because a layout
 * lays them out in the order the program reads them and not in the order a
 * literal writes them. The length is checked because a shape cannot be held by
 * a layout with a field more than it has: every field of the shape must be one
 * the layout declares, and every field the layout declares one of the shape's.
 */
function holdsShape(shape: Shape, layout: ObjectLayout): boolean {
  const shapeFields = fieldOfValue(shape, "fields") as readonly { name: string; value: Inferred }[];
  const layoutFields = fieldOfValue(layout, "fields") as readonly { name: string; type: string }[];
  if (shapeFields.length !== layoutFields.length) return false;
  for (const field of shapeFields) {
    const fieldName = String(fieldOfValue(field, "name"));
    let declared: { name: string; type: string } | undefined;
    for (const entry of layoutFields) if (entry.name === fieldName) declared = entry;
    if (declared === undefined || !holds(String(fieldOfValue(declared, "type")), fieldOfValue(field, "value") as Inferred)) return false;
  }
  return true;
}

/**
 * What a read of a field is: the type the layout gives it, or `ANY` where that
 * type is one the contract language does not spell — a text is a string in the
 * IR, which is not a type an inferred value is, and a reference the source left
 * unshaped is `ref<any>`, which says nothing.
 */
function inferredOfField(type: SemanticType): Inferred {
  if (type.kind === "text") return ANY;
  return { kind: "type", type };
}

/** Whether a use of a value is a use of the kind a field of that type takes. */
function holds(declared: string, use: Inferred): boolean {
  const useType = fieldOfValue(use, "type") as TypeExpr;
  // An object is a pointer, so it is written into a field that holds a
  // reference whatever the source wrote it as.
  if (String(fieldOfValue(use, "kind")) === "object") return isReference(parseType(declared));
  const type = parseType(declared);
  // A string is stored as the number a string is stored as, so a text field is
  // a field a number may be written into, and a string may be written into it
  // as well.
  const numeric = type.kind === "primitive" || isText(type);
  if (isText(useType)) return numeric;
  if (useType.kind === "primitive") return numeric;
  // A field that holds an array holds any array of the same element type: a
  // block written out is an `array` and one a name holds is a `slice`, and the
  // two are the same value.
  // An unshaped reference is what nothing is held at, and an object being laid
  // out starts every field as nothing: nothing fits any field.
  if (useType.kind === "ref" && useType.of === null && useType.name === undefined) return true;
  const arrayed = (one: SemanticType): one is Extract<SemanticType, { kind: "array" | "slice" | "ptr" }> =>
    one.kind === "array" || one.kind === "slice" || one.kind === "ptr";
  if (arrayed(type) && arrayed(useType)) return typeEquals(type.of, useType.of);
  return type.kind === useType.kind;
}

/* -------------------------------------------------------------------------- */
/* Entry                                                                      */
/* -------------------------------------------------------------------------- */

/** One function, as the IR holds it: signature, conditions, effects and body. */
export function resolveFunction(contract: FunctionContract, context: FunctionContext): SemanticFunction {
  const definition = fieldOfValue(contract, "definition") as FunctionDefinition;
  const signature = fieldOfValue(contract, "function") as FunctionSignature;
  const signatureParams = fieldOfValue(signature, "params") as FunctionSignature["params"];
  const params: SemanticSlot[] = [];
  for (const param of signatureParams) {
    params.push({ kind: "value", name: String(fieldOfValue(param, "name")), mutable: true, type: parseType(String(fieldOfValue(param, "type"))) });
  }
  const requires = fieldOfValue(contract, "requires") as readonly string[];
  const requiresOut: string[] = [];
  for (const one of requires) requiresOut.push(one);
  const ensures = fieldOfValue(contract, "ensures") as readonly string[];
  const ensuresOut: string[] = [];
  for (const one of ensures) ensuresOut.push(one);
  const effects = fieldOfValue(contract, "effects") as readonly Effect[];
  const effectsOut: Effect[] = [];
  for (const one of effects) effectsOut.push(one);
  const calls = fieldOfValue(definition, "calls") as readonly CallEdge[];
  const callsOut: CallEdge[] = [];
  for (const one of calls) callsOut.push(one);
  return {
    name: String(fieldOfValue(signature, "name")),
    symbol: String(fieldOfValue(signature, "symbol")),
    params,
    returns: parseType(String(fieldOfValue(signature, "returns"))),
    requires: requiresOut,
    ensures: ensuresOut,
    effects: effectsOut,
    allocates: fieldOfValue(definition, "allocates") === true,
    prints: fieldOfValue(definition, "prints") === true,
    readsArgv: fieldOfValue(definition, "readsArgv") === true,
    objects: fieldOfValue(definition, "objects") as Record<string, ObjectLayout>,
    calls: callsOut,
    entry: new FunctionBody(contract, definition, context).lower(),
  };
}

/** Every function of one file, in the order the contract declares them. */
export function resolveModule(
  path: string,
  contracts: Record<string, FunctionContract>,
  context: FunctionContext,
): SemanticModule {
  return {
    path,
    functions: Object.values(contracts).map((contract) => resolveFunction(contract, context)),
  };
}

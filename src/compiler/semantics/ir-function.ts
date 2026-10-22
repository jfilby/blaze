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
import { ANY_REF, BOOL, F64, I64, USIZE, bodyIgnoresCounter, bodyIndexesCounter, bodyIsWhole, coalesce, countsWholeNumber, describe, elementOf, numeric } from "./objects.ts";
import { isInteger, isWhole, isWide, wholeOf } from "../core/semantic-ir.ts";
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
import type { Effect, FunctionContract, FunctionDefinition, FunctionSignature, ObjectLayout, TypeExpr } from "../core/types.ts";
import {
  BOOLEAN,
  TEXT,
  compoundAsBinary,
  commonNumber,
  hasCall,
  isReference,
  roundedBound,
  slotType,
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
  type SemanticValue,
  type UnaryOp,
} from "../core/semantic-ir.ts";

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

/** A number written in the source, which is a double. */
const DOUBLE: Inferred = { kind: "type", type: F64 };

/** A reference the source left unshaped, which is what `null` is. */
const ANY: Inferred = { kind: "type", type: ANY_REF };

/** A whole number, as a length and an index are counted. */
const WHOLE: Inferred = { kind: "type", type: USIZE };

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
  return block.terminator.k !== "next";
}

/** One block being written, and the loop whose body it is. */
interface BlockFrame {
  block: SemanticBlock;
  /** The loop this block is written in, which a break and a continue leave. */
  loop: LoopTarget | null;
  /** True for the body of the loop above, which a break leaves as well. */
  body: boolean;
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
  private readonly context: FunctionContext;
  private readonly objects: Record<string, ObjectLayout>;
  /** The type every `return` of this function hands back. */
  private readonly returns: Inferred;

  private readonly frames: BlockFrame[] = [];
  private readonly scopes: Map<string, Held>[] = [new Map()];
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
    this.context = context;
    this.objects = definition.objects;
    this.returns = { kind: "type", type: parseType(contract.function.returns) };
    for (const param of contract.function.params) {
      const type = parseType(param.type);
      // A parameter is a slot the body reads it by. A body that writes one
      // reassigns its own argument, which the language it was written in
      // allows, so the slot is one the body may change.
      this.bind(param.name, {
        name: param.name,
        inferred: { kind: "type", type },
        slot: { kind: "value", name: param.name, mutable: true, type },
      });
    }
    this.used = sourceNames(definition.statements, new Set(contract.function.params.map((param) => param.name)));
  }

  /* ---------------------------------------------------------------------- */
  /* Entry                                                                  */
  /* ---------------------------------------------------------------------- */

  /** The body of the function, as the block it starts in. */
  lower(): SemanticBlock {
    const entry: SemanticBlock = { id: "entry", statements: [], releases: [], terminator: { k: "next" } };
    this.enter(entry, null);
    this.statements(this.definition.statements);
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
        if (held.inferred.kind !== "type" || held.inferred.type.kind !== "primitive") continue;
        if (isWhole(held.inferred.type.name)) names.push(name);
      }
    }
    return names;
  }

  private open(): void {
    this.scopes.push(new Map());
  }

  private close(): void {
    this.scopes.pop();
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
    const block = this.frame().block;
    for (const before of this.pending) block.statements.push(before);
    this.pending = [];
  }

  private frame(): BlockFrame {
    return this.frames[this.frames.length - 1];
  }

  private write(statement: SemanticStatement): void {
    this.flush();
    this.frame().block.statements.push(statement);
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
  private arm(body: readonly Statement[], loop: LoopTarget | null, ofLoop = false): SemanticBlock {
    const block: SemanticBlock = { id: this.blockId(), statements: [], releases: [], terminator: { k: "next" } };
    this.enter(block, loop, ofLoop);
    this.open();
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
    const target: LoopTarget = { header, exit: this.frame().block.id, left: false };
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
    const target = frame.loop;
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
      names.push(...left.block.releases);
      // Every block a loop holds carries the same loop, so the body itself is
      // what says where the walk over the blocks it leaves stops.
      if (left.body) break;
    }
    // A loop that is left does not hold the code after it: the loop may end by
    // its `break` and the code after it runs.
    if (leaving) target.left = true;
    frame.block.terminator = { k: "jump", target: leaving ? target.exit : target.header, releases: names };
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
      const end = this.frame().block.terminator.k;
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
        const held = this.read(statement.target, statement.line);
        // A compound assignment writes its operator down on the type of the
        // name, so `%=` on a double is a target no compiler accepts: the C
        // backend writes `x %= 3.0`, which is not C at all. The operator
        // decides what the name may be, as it does in a binary expression,
        // where a whole operator needs whole numbers. The program path refuses
        // the same write the same way (semantics/ir-resolve.ts).
        if (WHOLE_ASSIGNMENTS.includes(statement.op) && !isInteger(slotType(held.slot))) {
          const name = typeText(slotType(held.slot));
          throw this.error(
            `"${statement.op.slice(0, -1)}" needs whole numbers`,
            statement.line,
            `"${statement.target}" is a ${name}, and "${statement.op}" rounds it to a whole number`,
          );
        }
        // The count of a shift is a machine word, whatever the number being
        // shifted is — the same rule the binary form follows, over the name
        // rather than over a literal.
        const counted = statement.op === "<<=" || statement.op === ">>=" || statement.op === ">>>=";
        const value = this.typed(statement.value, counted ? asType(USIZE) : held.inferred, statement.line).value;
        // A number written into a string is written as its text, as `s += 1`
        // is in the language the body was written in, rather than as a refusal
        // the source does not raise.
        const written =
          held.slot.kind === "text" && !isText(value.type)
            ? { k: "text" as const, type: TEXT, parts: [{ k: "value" as const, value }] }
            : value;
        // A wide number has no compound operator a backend can write, and a
        // floor division has no compound form C has, so the compound is
        // written as the binary form every backend either writes or refuses
        // by name.
        const wide = compoundAsBinary(statement.op, slotType(held.slot), { k: "local", type: slotType(held.slot), name: held.name }, written);
        this.write({
          k: "set",
          name: held.name,
          op: wide === null ? statement.op : wide.op,
          value: wide === null ? written : wide.value,
          line: statement.line,
        });
        return;
      }
      case "memberAssign":
        return this.fieldAssignment(statement);
      case "indexAssign": {
        const buffer = this.read(statement.buffer, statement.line);
        const elementType = elementOf(buffer.inferred);
        const element = asType(elementType);
        const index = this.typed(statement.index, WHOLE, statement.line).value;
        const value = this.typed(statement.value, element, statement.line).value;
        // The same rule as the whole name above, over one element rather than
        // a slot: a wide element has no compound operator a backend writes.
        const wide = compoundAsBinary(statement.op, elementType, { k: "element", type: elementType, of: { k: "local", type: slotType(buffer.slot), name: buffer.name }, index }, value);
        this.write({
          k: "setElement",
          buffer: buffer.name,
          index,
          op: wide === null ? statement.op : wide.op,
          value: wide === null ? value : wide.value,
          line: statement.line,
        });
        return;
      }
      case "update":
        this.write({
          k: "step",
          name: this.read(statement.name, statement.line).name,
          op: statement.op,
          prefix: statement.prefix,
          line: statement.line,
        });
        return;
      case "result": {
        const value = this.typed(statement.value, this.returns, statement.line).value;
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
          this.write({ k: "let", slot, value, line: statement.line });
          this.finallysWritten();
          this.frame().block.terminator = { k: "return", value: { k: "local", type: value.type, name } };
          return;
        }
        this.frame().block.terminator = { k: "return", value };
        return;
      }
      case "if": {
        const condition = this.typed(statement.condition, null, statement.line).value;
        const then = this.arm(statement.then, this.frame().loop);
        const otherwise = statement.otherwise.length === 0 ? null : this.arm(statement.otherwise, this.frame().loop);
        this.write({ k: "if", condition, then, otherwise, line: statement.line });
        // An `if` with an arm on each side, each of which leaves, is a statement
        // nothing after it can be reached from. The block says so, rather than
        // falling out of itself into a return of nothing: a function declared to
        // return a number does not end by handing back whatever the register
        // held, and a function that returns from every path returns.
        if (otherwise !== null && this.frame().block.terminator.k === "next" && leaves(then) && leaves(otherwise)) {
          this.frame().block.terminator = { k: "unreachable" };
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
          ),
          line: statement.line,
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
        this.finallys.push(statement.finallyBody ?? []);
        this.statements(statement.body);
        this.finallys.pop();
        // If the body fell through, an error is pending and there is a catch
        // arm, run it. The catch parameter is bound to `blaze_last_error()` so
        // a `catch (e)` can inspect the error, and it is declared inside the
        // catch arm so it is only initialized when there actually is an error.
        // The arm is written with the finally pending as well: a return out of
        // the arm runs the finally before it returns.
        if (statement.catchBody !== null) {
          this.finallys.push(statement.finallyBody ?? []);
          const catchBody: Statement[] =
            statement.catchParam === null
              ? statement.catchBody
              : [
                  {
                    kind: "declare",
                    name: statement.catchParam,
                    type: null,
                    init: { k: "call", name: "blaze_last_error", args: [] } as Expression,
                    line: statement.line,
                  },
                  ...statement.catchBody,
                ];
          const hadError = this.typed(
            { k: "call", name: "blaze_had_error", args: [] },
            null,
            statement.line,
          ).value;
          const catchBlock = this.arm(catchBody, this.frame().loop);
          this.finallys.pop();
          this.write({ k: "if", condition: hadError, then: catchBlock, otherwise: null, line: statement.line });
        }
        // Finally runs whether or not the catch arm ran.
        this.statements(statement.finallyBody ?? []);
        return;
      }
      case "while": {
        const condition = this.typed(statement.condition, null, statement.line).value;
        const { target, ...info } = this.loop(statement.body);
        // `while (true)` never leaves its body through the loop's exit, so
        // nothing written after it is reachable — unless the body leaves the
        // loop with a `break`, which is the one way out of it. A loop that may
        // be left is not a loop that never ends, and the code after it runs.
        const conditionText = (statement.condition as { text?: string; name?: string }).text ?? (statement.condition as { name?: string }).name;
        const neverExits = (conditionText === "true" || conditionText === "1") && !target.left;
        this.write({
          k: "loop",
          loop: { kind: "while", condition, ...info, ...(neverExits ? { neverExits: true } : {}) },
          line: statement.line,
        });
        if (neverExits) {
          this.frame().block.terminator = { k: "unreachable" };
        }
        return;
      }
      case "doWhile": {
        const condition = this.typed(statement.condition, null, statement.line).value;
        this.write({ k: "loop", loop: { kind: "doWhile", condition, ...this.loop(statement.body) }, line: statement.line });
        return;
      }
      case "loop":
        return this.counted(statement);
      case "forOf": {
        const source = this.read(statement.of, statement.line);
        const element = elementOf(source.inferred);
        const length: SemanticValue = { k: "length", type: USIZE, of: { k: "local", type: slotType(source.slot), name: source.name } };
        const index = this.generated("i");
        this.open();
        this.bind(statement.variable, {
          name: statement.variable,
          inferred: asType(element),
          slot: { kind: "value", name: statement.variable, mutable: false, type: element },
        });
        const walked = this.loop(statement.body);
        this.close();
        this.write({
          k: "loop",
          loop: { kind: "each", index, element: statement.variable, elementType: element, of: source.name, length, ...walked },
          line: statement.line,
        });
        return;
      }
      case "break":
      case "continue":
        // A finally runs before the body leaves, and a break or a continue is
        // a leave: the finally's statements are written before the jump and
        // run before it.
        this.finallysWritten();
        this.jump(statement.kind === "break", statement.line);
        return;
      case "print":
        return this.print(statement);
      case "expression": {
        // A call kept for what it does. Any other value a statement holds has
        // no effect of its own and the source dropped it too, so there is
        // nothing to write down and nothing to refuse.
        const value = this.typed(statement.value, null, statement.line).value;
        if (value.k === "call") this.write({ k: "call", call: value.call, line: statement.line });
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
    const annotation = statement.type === null ? null : asType(statement.type);
    if (statement.init.k === "object") {
      const built = this.allocated(statement.init, statement.line);
      // An annotation does not narrow an object: the layout is what the body
      // allocates, and the fields it writes are of that layout or of none.
      const slot: SemanticSlot = { kind: "object", name: statement.name, mutable: true, type: built.value.type };
      this.bind(statement.name, { name: statement.name, inferred: built.inferred, slot });
      this.write({ k: "let", slot, value: built.value, line: statement.line });
      return;
    }
    const value = this.typed(statement.init, annotation, statement.line);
    const slot = this.slot(statement.name, value, annotation, statement.line);
    this.bind(statement.name, { name: statement.name, inferred: bound(value.inferred, annotation), slot });
    this.write({ k: "let", slot, value: value.value, line: statement.line });
  }

  /**
   * A field the body writes. A plain `=` is one store, and a compound one reads
   * the field, applies the operator to what was there and stores it back,
   * because a store is the only write the IR states and it states no operators.
   */
  private fieldAssignment(statement: Statement & { kind: "memberAssign" }): void {
    const base = this.read(statement.base, statement.line);
    const written = this.typed(statement.value, null, statement.line);
    const layout = this.layoutForWrite(base, statement.field, written.inferred, statement.line);
    const object: SemanticValue = { k: "local", type: slotType(base.slot), name: base.name };
    // A layout is what the body stores, so a field written as nothing and then
    // as a number is a number, and a field the body writes but the literal
    // never held is a field of the object.
    if (base.inferred.kind === "object") this.stored(base.inferred.key, statement.field, written.inferred);
    this.write({
      k: "storeField",
      object,
      layout,
      field: statement.field,
      value:
        statement.op === "="
          ? written.value
          : {
              k: "arith",
              type: this.fieldType(layout, statement.field, statement.line),
              op: COMPOUND[statement.op],
              left: { k: "loadField", type: this.fieldType(layout, statement.field, statement.line), object, layout, field: statement.field },
              right: written.value,
            },
      line: statement.line,
    });
  }

  /**
   * A loop that counts with a variable. What it counts with follows from what
   * it is built from, which is the value it starts at and the value it moves
   * by; a bound only says where the loop stops.
   */
  private counted(statement: Statement & { kind: "loop" }): void {
    const from = this.typed(statement.from, null, statement.line);
    // What the loop counts with follows from the start and the step, so the
    // step is typed once, before the count is settled, and read twice: the
    // value the IR states is built from it and typing it again would run the
    // side effects a typed expression has — an `i++` written as the step
    // becomes a `let` and a `step` of its own — a second time.
    const step = statement.step === null ? null : this.typed(statement.step, null, statement.line);
    // A counter that starts and moves by whole numbers counts in whole numbers,
    // and the body decides whether it may: a body written entirely in whole
    // numbers reads the counter at the counter's width whatever that width is,
    // so widening it changes no answer and is what lets the parallel rule hand
    // the loop to a thread. A body that mixes the counter into a double is left
    // alone, because there the counter is read through the accumulator's width
    // and an `i64` in that expression is a number the source never wrote.
    const wholeNames = new Set(this.wholeNames());
    const countsWholeItself = countsWholeNumber(statement.from, from.inferred) && (step === null || (statement.step !== null && countsWholeNumber(statement.step, step.inferred)));
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
      bodyIsWhole(statement.body, statement.variable, wholeNames) ||
      bodyIgnoresCounter(statement.body, statement.variable) ||
      bodyIndexesCounter(statement.body, statement.variable);
    const counted =
      countsWholeItself && countsWhole
        ? I64
        : from.inferred.kind === "type"
          ? step === null || step.inferred.kind !== "type"
            ? from.inferred.type
            : numeric(from.inferred, step.inferred)
          : USIZE;
    const type = asType(counted);
    // A number written as the start is counted in the type the loop counts in.
    const starts: SemanticValue =
      from.value.k === "const" && counted.kind === "primitive" ? { ...from.value, type: counted } : from.value;
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
    const natural = this.typed(statement.to, null, statement.line);
    const wholeCounter = counted.kind === "primitive" && isWhole(counted.name);
    const bound: SemanticValue = wholeCounter && !countsWholeNumber(statement.to, natural.inferred)
      ? roundedBound(natural.value, statement.down === statement.inclusive)
      : natural.value.k === "const" && counted.kind === "primitive"
        ? { ...natural.value, type: counted }
        : natural.value;
    // A number written as the step is counted in the type the loop counts in,
    // for the same reason the start is: the IR states the loop in one width.
    const moves: SemanticValue | null =
      step === null || step.value.k !== "const" || counted.kind !== "primitive"
        ? step?.value ?? null
        : { ...step.value, type: counted };
    this.open();
    this.bind(statement.variable, {
      name: statement.variable,
      inferred: type,
      slot: { kind: "value", name: statement.variable, mutable: true, type: counted },
    });
    const walked = this.loop(statement.body);
    this.close();
    this.write({
      k: "loop",
      loop: {
        kind: "counted",
        variable: statement.variable,
        type: counted,
        from: starts,
        to: bound,
        inclusive: statement.inclusive,
        down: statement.down,
        step: moves,
        ...walked,
      },
      line: statement.line,
    });
  }

  /**
   * What a `print` writes: the value the way the runtime writes what it holds,
   * and then the line the console ends it with.
   */
  private print(statement: Statement & { kind: "print" }): void {
    const value = this.typed(statement.value, null, statement.line).value;
    switch (valueKind(value)) {
      case "text":
        this.write({ k: "printText", value, line: statement.line });
        break;
      case "number":
        // A bigint *parameter* of a function is stated as the `i64` it is, so a
        // function that prints one writes it without the `n` beside it. A bigint
        // the body wrote out is not a parameter — `9007199254740993n` is a
        // bigint the source spelled, and the language prints it with the `n` —
        // and reading the mark off the expression is what tells the two apart.
        // Reading it off nothing hardcoded every one of them as the parameter.
        this.write({ k: "printNumber", value, line: statement.line, bigint: statement.value.k === "bigint" });
        break;
      case "boolean":
      case "reference":
        this.write({ k: "printText", value: { k: "toText", type: TEXT, of: value, digits: null }, line: statement.line });
        break;
      case "null":
        this.write({
          k: "printText",
          value: { k: "text", type: TEXT, parts: [{ k: "text", value: "null" }] },
          line: statement.line,
        });
        break;
    }
    this.write({ k: "printNewline", line: statement.line });
  }

  /* ---------------------------------------------------------------------- */
  /* Values                                                                 */
  /* ---------------------------------------------------------------------- */

  private typed(expression: Expression, expect: Inferred | null, line: number): Typed {
    switch (expression.k) {
      case "literal": {
        // A number written in the source is a double unless a use fixes it to
        // another width, and a whole literal is still a double.
        return { value: { k: "const", type: numberAt(expect) ?? F64, text: expression.text }, inferred: DOUBLE };
      }
      case "bigint": {
        // A bigint is a whole number, and a whole number here is an `i64`. A
        // literal that does not fit in one is a wide number, and it is typed as
        // one: a literal typed as an `i64` and holding more than that is
        // answered as the low sixty-four bits of itself, which is a number the
        // source never wrote. The program resolver types it the same way.
        let literal: bigint | null = null;
        try { literal = BigInt(expression.text); } catch { /* not a valid bigint */ }
        // When a `u64` is expected and the value fits in 64 unsigned bits, type
        // it as `u64` so it can be passed to `u256_from_u64x2` or
        // `u256_from_u64x4` without first being widened to `u256`.
        if (expect !== null && expect.kind === "type" && expect.type.kind === "primitive" && expect.type.name === "u64" && literal !== null && literal >= 0n && literal <= U64_MAX) {
          return { value: { k: "const", type: U64, text: expression.text }, inferred: asType(U64) };
        }
        if (literal !== null && (literal > I64_MAX || literal < I64_MIN)) {
          return { value: { k: "const", type: U256, text: expression.text }, inferred: asType(U256) };
        }
        return { value: { k: "const", type: I64, text: expression.text }, inferred: asType(I64) };
      }
      case "ident": {
        const held = this.read(expression.name, line);
        return { value: { k: "local", type: slotType(held.slot), name: held.name }, inferred: held.inferred };
      }
      case "null":
        return { value: { k: "nothing", type: referenceAt(expect) ?? REF_NULL }, inferred: ANY };
      case "argv":
        // `process.argv` itself is a count of the arguments the program was
        // given, and one of them is a number.
        if (expression.index === null) return { value: { k: "argv", type: USIZE, index: null }, inferred: asType(USIZE) };
        return { value: { k: "argv", type: F64, index: this.typed(expression.index, WHOLE, line).value }, inferred: asType(F64) };
      case "length": {
        const held = this.read(expression.buffer, line);
        return { value: { k: "length", type: USIZE, of: { k: "local", type: slotType(held.slot), name: held.name } }, inferred: asType(USIZE) };
      }
      case "index": {
        const base = this.typed(expression.base, null, line);
        if (base.inferred.kind === "object") {
          throw this.error(
            `reads an element of ${describe(base.inferred)}, which is an object`,
            line,
            "an object is read field by field, as in node.left",
          );
        }
        const element = elementOf(base.inferred);
        return {
          value: { k: "element", type: element, of: base.value, index: this.typed(expression.index, WHOLE, line).value },
          inferred: asType(element),
        };
      }
      case "member":
        return this.field(expression, expect, line);
      case "call":
        return this.call(expression, line);
      case "object":
        return this.allocated(expression, line);
      case "sized": {
        // `new Float64Array(n)` is a block of `n` elements the program sizes
        // when it runs, cleared: a read past what the program filled is the
        // zero the language answers it with.
        const element = parseType(expression.element);
        const type: TypeExpr = { kind: "array", of: element, length: null };
        return {
          value: {
            k: "buffer",
            type,
            element,
            length: null,
            count: this.typed(expression.count, WHOLE, line).value,
            view: null,
            values: [],
          },
          inferred: asType(type),
        };
      }
      case "buffer": {
        // `new Float64Array([1, 2, 3])` is a block whose length the program
        // wrote down, and the elements take the type of the array they are
        // written into rather than the type they were written at.
        const element = parseType(expression.element);
        const type: TypeExpr = { kind: "array", of: element, length: expression.values.length };
        return {
          value: {
            k: "buffer",
            type,
            element,
            length: expression.values.length,
            count: null,
            view: null,
            values: expression.values.map((value) => this.typed(value, { kind: "type", type: element }, line).value),
          },
          inferred: asType(type),
        };
      }
      case "fixed": {
        // What is written at a fixed number of digits is text. A string is
        // already that text, and the digits would be dropped rather than
        // refused, so it is refused here for the reason the program body
        // refuses it.
        const of = this.typed(expression.of, null, line).value;
        if (isText(of.type)) {
          throw this.error(
            "a string is not written at a fixed number of digits",
            line,
            "a string is already text; write it as it is",
          );
        }
        return { value: { k: "toText", type: TEXT, of, digits: expression.digits }, inferred: asType(USIZE) };
      }
      case "text": {
        const parts: SemanticTextPart[] = [];
        for (const part of expression.parts) {
          parts.push(part.k === "text" ? { k: "text", value: part.value } : { k: "value", value: this.asText(this.typed(part.value, null, line).value) });
        }
        return { value: { k: "text", type: TEXT, parts }, inferred: DOUBLE };
      }
      case "binary":
        return this.binary(expression, line);
      case "unary":
        return this.unary(expression, expect, line);
      case "conditional": {
        const condition = this.typed(expression.condition, null, line).value;
        const then = this.typed(expression.then, expect, line);
        const otherwise = this.typed(expression.otherwise, expect, line);
        return {
          value: {
            k: "select",
            type: this.common(then.value.type, otherwise.value.type, line),
            condition,
            then: then.value,
            otherwise: otherwise.value,
          },
          // Both arms are walked so both objects are laid out, but a choice is
          // whichever arm it takes: two arms that name the same thing, or a
          // reference the source left unshaped.
          inferred: describe(then.inferred) === describe(otherwise.inferred) ? then.inferred : ANY,
        };
      }
      case "update":
        return this.updated(expression, line);
    }
  }

  /**
   * A field the body reads. A field belongs to a layout, so the access names
   * one: the object the body wrote is laid out as the literal that wrote it,
   * and a field of something the body was given is a field of the layout that
   * holds it.
   */
  private field(expression: Expression & { k: "member" }, expect: Inferred | null, line: number): Typed {
    const base = this.typed(expression.base, null, line);
    const object = base.value;
    if (base.inferred.kind === "object") {
      const layout = this.layoutFor(base.inferred.key, line);
      return {
        value: { k: "loadField", type: this.fieldType(layout, expression.field, line), object, layout, field: expression.field },
        inferred: this.fieldOf(base.inferred.key, expression.field),
      };
    }
    const layouts = this.layoutsWith(base.inferred, describe(base.inferred), expression.field, expect ?? ANY, line);
    // The program lays out no object with that field at all, so it says
    // nothing about what is behind the reference. The reference is then the
    // only value of the object the IR can name, and it is the one every body
    // that reaches it is asking about: whether the caller handed over an
    // object at all. Naming a layout here would be naming one the program does
    // not have.
    if (layouts.length === 0) return { value: object, inferred: ANY };
    const layout = layouts[0] as string;
    const type = this.fieldType(layout, expression.field, line);
    // The read is at the type the layout gives the field, which is the number
    // behind it rather than the reference: `p.x + p.y` over an `any` is a sum
    // of two doubles because the layouts the program lays out say the fields
    // are doubles, and it was refused as a sum of two references because
    // nothing said what was behind them.
    return {
      value: { k: "loadField", type, object, layout, field: expression.field },
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
  private layoutsWith(inferred: Inferred, what: string, field: string, use: Inferred, line: number): string[] {
    if (inferred.kind === "object") return [this.layoutFor(inferred.key, line)];
    // A reference to nothing in particular behind it: `p.x` in a body whose
    // `p` is an `any` asks what is behind `p`, not for a reference.
    const unshaped = use.kind === "type" && use.type.kind === "ref" && use.type.of === null;
    const candidates: { name: string; read: string }[] = [];
    for (const layout of Object.values(this.objects)) {
      const declared = layout.fields.find((one) => one.name === field);
      if (declared === undefined) continue;
      if (!unshaped && !holds(declared.type, use)) continue;
      candidates.push({ name: layout.name, read: `${declared.type} at ${declared.offset}` });
    }
    const [first] = candidates;
    if (first === undefined) return [];
    const disagreeing = candidates.filter((one) => one.read !== first.read).map((one) => one.name);
    if (disagreeing.length === 0) return candidates.map((one) => one.name);
    throw this.error(
      `reads or writes "${what}.${field}", which ${[first.name, ...disagreeing].join(" and ")} could each be a field of`,
      line,
      "a backend cannot pick between two layouts, so the field is written in the literal that writes the object",
    );
  }

  /** The layout a field the body writes belongs to, or a refusal where there is none. */
  private layoutForWrite(base: Held, field: string, use: Inferred, line: number): string {
    const layouts = this.layoutsWith(base.inferred, base.name, field, use, line);
    if (layouts.length > 0) return layouts[0];
    throw this.error(
      `writes "${base.name}.${field}", which no layout the program lays out holds`,
      line,
      `the program lays out ${this.laidOut()}, and a field of an object it does not lay out cannot be written`,
    );
  }

  /** A call, or the one builtin that is an operation rather than a call. */
  private call(expression: Expression & { k: "call" }, line: number): Typed {
    const builtin = builtinFor(expression.name);
    if (builtin !== null) {
      this.builtinArity(expression.name, builtin, expression.args.length, line);
      const args = expression.args.map((argument, at) => this.typed(argument, asType(builtin.params[at]), line));
      const returns = builtin.returns;
      const extreme = EXTREMES[expression.name];
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
      if (expression.name === ARGV_LENGTH) return { value: { k: "argv", type: returns, index: null }, inferred: asType(returns) };
      if (expression.name === ARGV) return { value: { k: "argv", type: returns, index: args[0].value }, inferred: asType(returns) };
      return {
        value: {
          k: "call",
          type: returns,
          call: this.semanticCall(
            expression.name,
            {
              name: expression.name,
              symbol: expression.name,
              params: builtin.params.map((type, at) => ({ name: `argument${at}`, type: contractText(type) })),
              returns: contractText(returns),
            },
            args.map((argument) => argument.value),
            returns,
            [],
            true,
            builtin.params,
          ),
        },
        inferred: asType(returns),
      };
    }
    const callee = this.context.functions[expression.name];
    if (callee === undefined) {
      throw this.error(
        `calls "${expression.name}", which the program does not compile`,
        line,
        `a function may only call the functions of the program it is part of`,
      );
    }
    const signature = callee.function;
    this.arity(expression.name, signature.params.length, expression.args.length, line);
    const args = expression.args.map((argument, at) => this.typed(argument, asType(parseType(signature.params[at].type)), line));
    const returns = parseType(signature.returns);
    return {
      value: { k: "call", type: returns, call: this.semanticCall(signature.symbol, signature, args.map((argument) => argument.value), returns, callee.effects, false) },
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
    return {
      callee,
      signature,
      args: [...args],
      argTypes: argTypes === undefined
        ? signature.params.map((param) => parseType(param.type))
        : [...argTypes],
      returns,
      effects: [...effects],
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
    const expected = builtin.arities ?? [builtin.params.length];
    if (expected.includes(written)) return;
    const counts = expected.map((count) => `${count} argument${count === 1 ? "" : "s"}`).join(" or ");
    throw this.error(`${name} takes ${counts}, not ${written}`, line);
  }

  private arity(name: string, expected: number, written: number, line: number): void {
    if (expected === written) return;
    throw this.error(`${name} takes ${expected} argument${expected === 1 ? "" : "s"}, not ${written}`, line);
  }

  private binary(expression: Expression & { k: "binary" }, line: number): Typed {
    const op = expression.op;
    if (op === "&&" || op === "||") {
      // The left arm decides first, and the source form of these operators
      // writes that arm out twice, so a call in it is written under a name.
      const left = this.decide(expression.left, line);
      const right = this.typed(expression.right, null, line);
      // They hand back one of their arms, so the IR states the type both arms
      // are, while the layout pass calls the whole of it a truth.
      return {
        value: {
          k: "logical",
          type: this.common(left.value.type, right.value.type, line),
          op: op === "&&" ? "and" : "or",
          left: left.value,
          right: right.value,
        },
        inferred: asType(BOOL),
      };
    }
    if (op === "??") {
      const left = this.decide(expression.left, line);
      const right = this.typed(expression.right, null, line);
      const held = coalesce(left.inferred, right.inferred);
      return {
        value: { k: "coalesce", type: this.typeOf(held, line), left: left.value, right: right.value },
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
    const left = this.typed(expression.left, converting ? asType(U32) : null, line);
    // The count of a shift is a machine word, whatever the number being shifted
    // is: the kernel every backend shifts with takes one word of count, and a
    // count typed at the width of a wide number is the low half of the number
    // being shifted rather than the number of bits to move. `wholeResult` types
    // both sides at the width of the wide one, which is the value's width and
    // not the count's. The count of a `>>>` is one of the 32 bit numbers the
    // language reads its sides as, so it is read as one of those.
    const counted = op === "<<" || op === ">>";
    const right = this.typed(expression.right, counted ? asType(USIZE) : converting ? asType(U32) : null, line);
    // Asking whether a value is there is a different question from comparing
    // two of them, and one the IR states on its own.
    if (EQUALITY.includes(op) && (expression.left.k === "null" || expression.right.k === "null")) {
      const other = expression.left.k === "null" ? right : left;
      return {
        value: { k: "isNull", type: BOOLEAN, operand: other.value, negate: op === "!==" || op === "!=" },
        inferred: asType(BOOL),
      };
    }
    const ordering = COMPARISONS[op];
    if (ordering !== null) {
      return {
        value: { k: "compare", type: BOOLEAN, op: ordering, operand: this.operand(left.value, right.value), left: left.value, right: right.value },
        inferred: asType(BOOL),
      };
    }
    if (EQUALITY.includes(op)) {
      const text = isText(left.value.type) || isText(right.value.type);
      if (text && !(isText(left.value.type) && isText(right.value.type))) {
        throw this.error(
          `"${op}" compares a ${typeText(left.value.type)} and a ${typeText(right.value.type)}`,
          line,
          `a string is only compared with a string, and with another string for ===`,
        );
      }
      return {
        value: {
          k: "compare",
          type: BOOLEAN,
          op: op === "==" || op === "===" ? "eq" : "ne",
          operand: text ? TEXT : this.operand(left.value, right.value),
          left: text ? this.asText(left.value) : left.value,
          right: text ? this.asText(right.value) : right.value,
        },
        inferred: asType(BOOL),
      };
    }
    // A string added to a string is the one operation with no number behind it.
    if (isText(left.value.type) || isText(right.value.type)) {
      if (!isText(left.value.type) || !isText(right.value.type)) {
        throw this.error(
          `"${op}" is written over a ${typeText(left.value.type)} and a ${typeText(right.value.type)}`,
          line,
          `a string is added to a string, and compared with == and ===`,
        );
      }
      return {
        value: { k: "arith", type: TEXT, op: "concat", left: left.value, right: right.value },
        inferred: asType(numeric(left.inferred, right.inferred)),
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
    const rules = rulesFor(this.context.language);
    const type = op === "/" && rules.division === "true"
      ? F64
      : converting
        ? U32
        : WHOLE_OPERATORS[op] === true
          ? wholeResult(left.inferred, right.inferred)
          : numeric(left.inferred, right.inferred);
    const arithmetic = op === "%" && rules.remainder === "floored" ? "floorMod" : (ARITHMETIC[op] as ArithOp);
    return {
      value: { k: "arith", type, op: arithmetic, left: left.value, right: right.value },
      inferred: asType(type),
    };
  }

  private unary(expression: Expression & { k: "unary" }, expect: Inferred | null, line: number): Typed {
    // A number written with its sign is one literal, so a use can still fix its
    // type without a conversion.
    if (expression.op === "-" && expression.operand.k === "literal") {
      return { value: { k: "const", type: numberAt(expect) ?? F64, text: `-${expression.operand.text}` }, inferred: DOUBLE };
    }
    const operand = this.typed(expression.operand, null, line);
    if (expression.op === "+") return operand;
    if (expression.op === "!") {
      // `!` asks what a value is rather than inverting a number: it is a null
      // test of a reference, an empty-string test of a string, and only a truth
      // is inverted as one.
      if (isText(operand.value.type)) {
        return {
          value: {
            k: "compare",
            type: BOOLEAN,
            op: "ne",
            operand: TEXT,
            left: operand.value,
            right: { k: "text", type: TEXT, parts: [{ k: "text", value: "" }] },
          },
          inferred: asType(BOOL),
        };
      }
      if (isBoolean(operand.value.type)) {
        return { value: { k: "unary", type: BOOLEAN, op: UNARY["!"], operand: operand.value }, inferred: asType(BOOL) };
      }
      if (isReference(operand.value.type)) {
        // `!a` asks whether a reference is nothing, which is the null test and
        // not its negation: `!node.left` is the arm a leaf takes.
        return { value: { k: "isNull", type: BOOLEAN, operand: operand.value, negate: false }, inferred: asType(BOOL) };
      }
      throw this.error(
        `negates a ${typeText(operand.value.type)}, which is not a truth`,
        line,
        `a number is not a truth, so the body says what it means by it`,
      );
    }
    const type = numberAt(operand.inferred) ?? numeric(operand.inferred, operand.inferred);
    return { value: { k: "unary", type, op: UNARY[expression.op], operand: operand.value }, inferred: asType(type) };
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
    const held = this.read(expression.name, line);
    const type = slotType(held.slot);
    const snapshot = this.generated("t");
    const take = (): SemanticStatement => ({
      k: "let",
      slot: { kind: "value", name: snapshot, mutable: false, type },
      value: { k: "local", type, name: held.name },
      line,
    });
    const step: SemanticStatement = {
      k: "step",
      name: held.name,
      op: expression.op,
      prefix: expression.prefix,
      line,
    };
    if (expression.prefix) this.pending.push(step, take());
    else this.pending.push(take(), step);
    return { value: { k: "local", type, name: snapshot }, inferred: held.inferred };
  }

  /* ---------------------------------------------------------------------- */
  /* Objects                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * An object literal: the key its shape is filed under, the layout it is laid
   * out as, and every field as the body writes it.
   */
  private literal(fields: readonly { name: string; value: Expression }[], line: number): Literal {
    const typed = fields.map((field) => ({ name: field.name, value: this.typed(field.value, null, line) }));
    // The key is a function of the shape alone, and the shape is written as
    // JSON so that a field name cannot read like the key of another shape.
    const key = JSON.stringify(typed.map((field) => [field.name, describe(field.value.inferred)]));
    if (!this.shapes.has(key)) {
      this.shapes.set(key, { key, fields: typed.map((field) => ({ name: field.name, value: field.value.inferred })) });
    }
    return { key, layout: this.layoutFor(key, line), fields: typed.map((field) => ({ name: field.name, value: field.value.value })) };
  }

  /**
   * An object literal as a value: the allocation and the fields that fill it
   * are one value, built where the source wrote it, so a literal in the arm of
   * a conditional is built when that arm is taken.
   */
  private allocated(expression: Expression & { k: "object" }, line: number): Typed {
    const literal = this.literal(expression.fields, line);
    const type = this.objectType(literal.key, line);
    return { value: { k: "newObject", type, layout: literal.layout, fields: literal.fields }, inferred: { kind: "object", key: literal.key } };
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
    const exact = this.context.objectNames[key];
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
    const found: string[] = shape === undefined ? [] : this.knownLayouts(key, shape);
    if (found.length === 1) {
      this.layouts.set(key, found[0]);
      return found[0];
    }
    if (found.length > 1) {
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
    for (const [shapeKey, name] of Object.entries(this.context.objectNames)) {
      if (shapeKey === key) continue;
      const layout = this.objects[name];
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
  private fieldOf(key: string, field: string): Inferred {
    return this.shapes.get(key)?.fields.find((one) => one.name === field)?.value ?? ANY;
  }

  /** What a field holds once the body has written it, which the layout is built from. */
  private stored(key: string, field: string, value: Inferred): void {
    const shape = this.shapes.get(key);
    if (shape === undefined) return;
    const known = shape.fields.find((one) => one.name === field);
    if (known === undefined) shape.fields.push({ name: field, value });
    else known.value = value;
  }

  /** The type a layout gives one field, as the IR states it. */
  private fieldType(layout: string, field: string, line: number): SemanticType {
    const declared = this.objects[layout]?.fields.find((one) => one.name === field);
    if (declared === undefined) {
      throw this.error(
        `${layout} has no field ${field}`,
        line,
        `a field is written in the literal that writes the object`,
      );
    }
    return parseType(declared.type);
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
    if (isText(value.value.type)) return { kind: "text", name, mutable: true, boxed: true };
    const type =
      annotation !== null && value.inferred.kind !== "object" ? this.typeOf(annotation, line) : this.typeOf(value.inferred, line);
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
    return inferred.kind === "type" ? inferred.type : this.objectType(inferred.key, line);
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
    this.pending.push({ k: "let", slot: this.slotOf(name, value.type, false), value, line });
    return { k: "local", type: value.type, name };
  }

  /** The left arm of `&&`, `||` and `??`, which is never written out twice. */
  private decide(expression: Expression, line: number): Typed {
    const value = this.typed(expression, null, line);
    if (!hasCall(value.value)) return value;
    return { value: this.hoist(value.value, line), inferred: value.inferred };
  }

  /** A value as the text a string carries it as. */
  private asText(value: SemanticValue): SemanticValue {
    return isText(value.type) ? value : { k: "toText", type: TEXT, of: value, digits: null };
  }

  /* ---------------------------------------------------------------------- */
  /* Refusals                                                               */
  /* ---------------------------------------------------------------------- */

  /** A refusal that names the function and the line it was written at. */
  private error(message: string, line: number, detail?: string): CompilerError {
    const name = this.contract.function.name;
    return new CompilerError({
      category: "SemanticIrError",
      stage: "ir",
      function: name,
      message: `${name}: ${message}`,
      detail: detail === undefined ? `line ${line} of ${name}` : `line ${line} of ${name}: ${detail}`,
    });
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
        into.add(statement.name);
        break;
      case "loop":
        into.add(statement.variable);
        sourceNames(statement.body, into);
        break;
      case "if":
        sourceNames(statement.then, into);
        sourceNames(statement.otherwise, into);
        break;
      case "while":
      case "doWhile":
        sourceNames(statement.body, into);
        break;
      case "forOf":
        into.add(statement.variable);
        sourceNames(statement.body, into);
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
  if (inferred.kind === "object" || annotation === null) return inferred;
  return annotation;
}

/** Who owns what a call of a type hands back. */
function ownership(returns: SemanticType): Ownership {
  if (returns.kind === "ref") return "owned";
  if (returns.kind === "ptr") return "borrowed";
  return "none";
}

/** The number a use fixes a written number to, where it fixes one at all. */
function numberAt(inferred: Inferred | null): TypeExpr | null {
  if (inferred === null || inferred.kind !== "type") return null;
  return inferred.type.kind === "primitive" ? inferred.type : null;
}

/** The reference a use expects, where it expects one at all. */
function referenceAt(inferred: Inferred | null): TypeExpr | null {
  if (inferred === null || inferred.kind !== "type") return null;
  return isReference(inferred.type) || inferred.type.kind === "void" ? inferred.type : null;
}

/** Whether a type is a string, which the contract type language does not have. */
function isText(type: SemanticType): boolean {
  return type.kind === "text";
}

/** Whether a type is a truth. */
function isBoolean(type: SemanticType): boolean {
  return type.kind === "primitive" && type.name === "bool";
}

/** The reference that names the layout it points at, where one does. */
function layoutOf(type: SemanticType): SemanticType | null {
  return type.kind === "ref" && type.name !== undefined ? type : null;
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
  if (shape.fields.length !== layout.fields.length) return false;
  return shape.fields.every((field) => {
    const declared = layout.fields.find((entry) => entry.name === field.name);
    return declared !== undefined && holds(declared.type, field.value);
  });
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
  // An object is a pointer, so it is written into a field that holds a
  // reference whatever the source wrote it as.
  if (use.kind === "object") return isReference(parseType(declared));
  const type = parseType(declared);
  // A string is stored as the number a string is stored as, so a text field is
  // a field a number may be written into, and a string may be written into it
  // as well.
  const numeric = type.kind === "primitive" || isText(type);
  if (isText(use.type)) return numeric;
  if (use.type.kind === "primitive") return numeric;
  return type.kind === use.type.kind;
}

/* -------------------------------------------------------------------------- */
/* Entry                                                                      */
/* -------------------------------------------------------------------------- */

/** One function, as the IR holds it: signature, conditions, effects and body. */
export function resolveFunction(contract: FunctionContract, context: FunctionContext): SemanticFunction {
  const definition = contract.definition;
  return {
    name: contract.function.name,
    symbol: contract.function.symbol,
    params: contract.function.params.map((param) => ({
      kind: "value",
      name: param.name,
      mutable: true,
      type: parseType(param.type),
    })),
    returns: parseType(contract.function.returns),
    requires: [...contract.requires],
    ensures: [...contract.ensures],
    effects: [...contract.effects],
    allocates: definition.allocates,
    prints: definition.prints,
    readsArgv: definition.readsArgv,
    objects: definition.objects,
    calls: [...definition.calls],
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

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
 * A function whose contract states a postcondition has no body to write, and
 * the IR says so — its `entry` is null. A function contracted as a definition
 * carries the statements the frontend parsed, and they are written down the way
 * a program's are: one block per place control can be, exactly one way out of
 * each, and no value a backend would have to decide anything about.
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

import { parseType, typeToString } from "./contract.ts";
import { CompilerError } from "../core/errors.ts";
import { ARGV, ARGV_LENGTH, builtinFor } from "./builtins.ts";
import { ANY_REF, BOOL, F64, I64, USIZE, coalesce, describe, elementOf, numeric } from "./objects.ts";
import type { Inferred } from "./objects.ts";
import type { AssignOperator, BinaryOp, Expression, Statement, UnaryOp as SourceUnaryOp } from "../core/ir.ts";
import type { Effect, FunctionContract, FunctionDefinition, FunctionSignature, ObjectLayout, TypeExpr } from "../core/types.ts";
import {
  BOOLEAN,
  TEXT,
  commonNumber,
  hasCall,
  isReference,
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

/** What the operators a binary expression is written with state in the IR. */
const ARITHMETIC: Record<BinaryOp, ArithOp | null> = {
  "+": "add",
  "-": "sub",
  "*": "mul",
  "/": "div",
  "%": "mod",
  "**": "pow",
  "<<": "shl",
  ">>": "shr",
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
  "%": null,
  "**": null,
  "<<": null,
  ">>": null,
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

/** What each `op=` writes, as the one operation the IR states it as. */
const COMPOUND: Record<Exclude<AssignOperator, "=">, ArithOp> = {
  "+=": "add",
  "-=": "sub",
  "*=": "mul",
  "/=": "div",
  "%=": "mod",
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

  private open(): void {
    this.scopes.push(new Map());
  }

  private close(): void {
    this.scopes.pop();
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

  /** A block of its own, which a name declared in it is not a name outside it. */
  private arm(body: readonly Statement[], loop: LoopTarget | null, ofLoop = false): SemanticBlock {
    const block: SemanticBlock = { id: this.blockId(), statements: [], releases: [], terminator: { k: "next" } };
    this.enter(block, loop, ofLoop);
    this.statements(body);
    this.leave();
    return block;
  }

  /**
   * The blocks a loop leaves, and the block that holds it: the test is named
   * before the body is written, and control resumes in the block the loop was
   * written in, which is the one the loop statement is in.
   */
  private loop(body: readonly Statement[]): { header: string; exit: string; body: SemanticBlock } {
    const header = this.blockId();
    const target: LoopTarget = { header, exit: this.frame().block.id };
    return { header, exit: target.exit, body: this.arm(body, target, true) };
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
    frame.block.terminator = { k: "jump", target: leaving ? target.exit : target.header, releases: names };
  }

  /* ---------------------------------------------------------------------- */
  /* Statements                                                             */
  /* ---------------------------------------------------------------------- */

  private statements(list: readonly Statement[]): void {
    for (const statement of list) {
      // A block that ends by returning or by leaving for another one runs
      // nothing after what ended it, and neither does the source it was
      // written from.
      const end = this.frame().block.terminator.k;
      if (end === "jump" || end === "return") break;
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
        const value = this.typed(statement.value, held.inferred, statement.line).value;
        // A number written into a string is written as its text, as `s += 1`
        // is in the language the body was written in, rather than as a refusal
        // the source does not raise.
        this.write({
          k: "set",
          name: held.name,
          op: statement.op,
          value: held.slot.kind === "text" && !isText(value.type) ? { k: "text", type: TEXT, parts: [{ k: "value", value }] } : value,
          line: statement.line,
        });
        return;
      }
      case "memberAssign":
        return this.fieldAssignment(statement);
      case "indexAssign": {
        const buffer = this.read(statement.buffer, statement.line);
        this.write({
          k: "setElement",
          buffer: buffer.name,
          index: this.typed(statement.index, WHOLE, statement.line).value,
          // A function body writes one element of a sequence or writes none:
          // the statement the frontend reads carries no operator.
          op: "=",
          value: this.typed(statement.value, asType(elementOf(buffer.inferred)), statement.line).value,
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
        this.frame().block.terminator = { k: "return", value };
        return;
      }
      case "if": {
        const condition = this.typed(statement.condition, null, statement.line).value;
        const then = this.arm(statement.then, this.frame().loop);
        const otherwise = statement.otherwise.length === 0 ? null : this.arm(statement.otherwise, this.frame().loop);
        this.write({ k: "if", condition, then, otherwise, line: statement.line });
        return;
      }
      case "while": {
        const condition = this.typed(statement.condition, null, statement.line).value;
        this.write({ k: "loop", loop: { kind: "while", condition, ...this.loop(statement.body) }, line: statement.line });
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
    const step = statement.step === null ? null : this.typed(statement.step, null, statement.line);
    // What the loop counts with is the type it starts at and moves by; a bound
    // only says where the loop stops.
    const counted =
      from.inferred.kind === "type"
        ? step === null || step.inferred.kind !== "type"
          ? from.inferred.type
          : numeric(from.inferred, step.inferred)
        : USIZE;
    const type = asType(counted);
    // A number written as the start is counted in the type the loop counts in.
    const starts: SemanticValue =
      from.value.k === "const" && counted.kind === "primitive" ? { ...from.value, type: counted } : from.value;
    const bound = this.typed(statement.to, type, statement.line).value;
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
        step: statement.step === null ? null : this.typed(statement.step, type, statement.line).value,
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
        this.write({ k: "printNumber", value, line: statement.line });
        break;
      case "boolean":
      case "reference":
        this.write({ k: "printText", value: { k: "toText", type: TEXT, of: value }, line: statement.line });
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
      case "bigint":
        return { value: { k: "const", type: I64, text: expression.text }, inferred: asType(I64) };
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
    const layout = layouts[0];
    return {
      value: { k: "loadField", type: this.fieldType(layout, expression.field, line), object, layout, field: expression.field },
      inferred: ANY,
    };
  }

  /**
   * The layouts a field of something the body was given is a field of: every
   * one that holds a field of that name the use is a use of. More than one is a
   * refusal naming the layouts that could be meant, because a backend cannot
   * pick between them and a check that guesses is worse than a refusal.
   */
  private layoutsWith(inferred: Inferred, what: string, field: string, use: Inferred, line: number): string[] {
    if (inferred.kind === "object") return [this.layoutFor(inferred.key, line)];
    const candidates: string[] = [];
    for (const layout of Object.values(this.objects)) {
      const declared = layout.fields.find((one) => one.name === field);
      if (declared === undefined || !holds(declared.type, use)) continue;
      candidates.push(layout.name);
    }
    if (candidates.length < 2) return candidates;
    throw this.error(
      `reads or writes "${what}.${field}", which ${candidates.join(" and ")} could each be a field of`,
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
      this.arity(expression.name, builtin.params.length, expression.args.length, line);
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
              params: builtin.params.map((type, at) => ({ name: `argument${at}`, type: typeToString(type) })),
              returns: typeToString(returns),
            },
            args.map((argument) => argument.value),
            returns,
            [],
            true,
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
    returns: TypeExpr,
    effects: readonly Effect[],
    builtin: boolean,
  ): SemanticCall {
    return {
      callee,
      signature,
      args: [...args],
      argTypes: signature.params.map((param) => parseType(param.type)),
      returns,
      effects: [...effects],
      ownership: ownership(returns),
      retain: false,
      builtin,
    };
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
    const left = this.typed(expression.left, null, line);
    const right = this.typed(expression.right, null, line);
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
    const type = numeric(left.inferred, right.inferred);
    return {
      value: { k: "arith", type, op: ARITHMETIC[op] as ArithOp, left: left.value, right: right.value },
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
        return { value: { k: "isNull", type: BOOLEAN, operand: operand.value, negate: true }, inferred: asType(BOOL) };
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
   * `i++` used as a value: the old value of the name, written under a name of
   * its own, and then the step that changes it. A step is a statement the IR
   * states and a value is not, so the value it hands back is the one taken
   * before the step ran.
   */
  private updated(expression: Expression & { k: "update" }, line: number): Typed {
    const held = this.read(expression.name, line);
    const type = slotType(held.slot);
    const before = this.generated("t");
    this.pending.push({
      k: "let",
      slot: { kind: "value", name: before, mutable: false, type },
      value: { k: "local", type, name: held.name },
      line,
    });
    this.pending.push({ k: "step", name: held.name, op: expression.op, prefix: true, line });
    return { value: { k: "local", type, name: before }, inferred: held.inferred };
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
    if (isText(value.value.type)) return { kind: "text", name, mutable: true };
    const type =
      annotation !== null && value.inferred.kind !== "object" ? this.typeOf(annotation, line) : this.typeOf(value.inferred, line);
    return this.slotOf(name, type, true);
  }

  /** A slot that holds a value of this type, so a name of it can be declared. */
  private slotOf(name: string, type: SemanticType, mutable: boolean): SemanticSlot {
    if (isText(type)) return { kind: "text", name, mutable };
    if (isReference(type)) return { kind: "object", name, mutable, type };
    return { kind: "value", name, mutable, type };
  }

  /** The type the IR states an inferred value as. */
  private typeOf(inferred: Inferred, line: number): SemanticType {
    return inferred.kind === "type" ? inferred.type : this.objectType(inferred.key, line);
  }

  /** The type two values of one expression have in common, or a refusal. */
  private common(left: SemanticType, right: SemanticType, line: number): SemanticType {
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
    return isText(value.type) ? value : { k: "toText", type: TEXT, of: value };
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
function asType(type: TypeExpr): Inferred {
  return { kind: "type", type };
}

/** What a name holds once it is declared: an object is what it was written as. */
function bound(inferred: Inferred, annotation: Inferred | null): Inferred {
  if (inferred.kind === "object" || annotation === null) return inferred;
  return annotation;
}

/** Who owns what a call of a type hands back. */
function ownership(returns: TypeExpr): Ownership {
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

/** Whether a layout holds the fields of a shape, in the order they are written. */
function holdsShape(shape: Shape, layout: ObjectLayout): boolean {
  return shape.fields.every((field, at) => {
    const declared = layout.fields[at];
    return declared !== undefined && declared.name === field.name && holds(declared.type, field.value);
  });
}

/** Whether a use of a value is a use of the kind a field of that type takes. */
function holds(declared: string, use: Inferred): boolean {
  // An object is a pointer, so it is written into a field that holds a
  // reference whatever the source wrote it as.
  if (use.kind === "object") return isReference(parseType(declared));
  if (isText(use.type)) {
    // A string is stored as the number a string is stored as, so a numeric
    // field is a field a string may be written into.
    return parseType(declared).kind === "primitive";
  }
  const type = parseType(declared);
  if (isText(type)) return false;
  if (use.type.kind === "primitive") return type.kind === "primitive";
  return type.kind === use.type.kind;
}

/* -------------------------------------------------------------------------- */
/* Entry                                                                      */
/* -------------------------------------------------------------------------- */

/** One function, as the IR holds it: signature, conditions, effects and body. */
export function resolveFunction(contract: FunctionContract, context: FunctionContext): SemanticFunction {
  const definition = contract.definition;
  const body = definition === undefined ? null : new FunctionBody(contract, definition, context);
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
    allocates: definition?.allocates ?? false,
    prints: definition?.prints ?? false,
    readsArgv: definition?.readsArgv ?? false,
    objects: definition?.objects ?? {},
    calls: [...(definition?.calls ?? [])],
    entry: body === null ? null : body.lower(),
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

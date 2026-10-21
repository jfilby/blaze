/**
 * Applying a proposed fix to the IR.
 *
 * A model never writes IR. It reads the IR the compiler resolved from the
 * source, and when it wants a fix it names one of the rules below and the block
 * the rule is aimed at. This module is where those names become a tree: the
 * proposal is checked against the IR as it stands, applied by rewriting it, and
 * answered with either the revised function or the reason the proposal does
 * not hold here.
 *
 * Every rule is a rewrite of the semantic IR, so what a rule produces is a
 * program the compiler wrote and every validator, printer and backend already
 * reads. Nothing a rule builds is new syntax: a value that was computed twice
 * is bound to a name the IR already has, a callee's body is spliced in under
 * names of its own, and a division is written as the multiplication that equals
 * it. That is the whole contract between the catalogue and the compiler, and it
 * is why a proposal can be refused rather than trusted.
 *
 * The rules are the compiler's vocabulary for every review it asks a model for,
 * so which stage a proposal came from does not change what may be done with it:
 * the artifact under review differs, and the rewrite that answers it is the
 * same one.
 *
 *   hoist-invariant      bind what a loop recomputes unchanged, once, above it
 *   common-subexpression bind what a block computes more than once, once
 *   reciprocal-multiply  turn a division by a power of two into a multiplication
 *   inline-call          put a callee's body where the call was
 */

import {
  hasCall,
  isInteger,
  isReference,
  isTextType,
  slotType,
  type SemanticBlock,
  type SemanticCall,
  type SemanticFunction,
  type SemanticLoop,
  type SemanticSlot,
  type SemanticStatement,
  type SemanticType,
  type SemanticValue,
} from "../core/semantic-ir.ts";
import { printSemanticValue } from "./ir-text.ts";
import type { Proposal } from "../core/proposal.ts";

/* -------------------------------------------------------------------------- */
/* The catalogue                                                              */
/* -------------------------------------------------------------------------- */

/** One rule, as the catalogue states it to a model and as the engine applies it. */
export interface RepairRule {
  /** The name a proposal names it by. */
  readonly name: string;
  /** What the rule does, in one line. */
  readonly summary: string;
  /** When the rule can be applied, and what makes it refused. */
  readonly applies: string;
  /** The arguments it takes, empty for a rule that takes none. */
  readonly args: readonly { readonly name: string; readonly description: string }[];
}

/** Every rule a review may propose, in the order a prompt lists them. */
export const REPAIR_RULES: readonly RepairRule[] = [
  {
    name: "hoist-invariant",
    summary: "Bind every value a loop computes more than once and never changes, once, above the loop.",
    applies:
      "A while, do-while, counted or for-of loop whose body computes the same value twice without the loop " +
      "writing anything that value reads. Three kinds of value are never bound, whatever else they look like: " +
      "a call and an allocation, because running one once instead of twice is not the same program; a read of " +
      "memory, which is an element, a field or a length, because the IR holds no length and no null test, so " +
      "computing it above the test that made it safe is a fault the source could not perform; and a value " +
      "reading a name the region writes. Two writes are the same value only when the whole of them is " +
      "identical: a name, a literal, a type and every operation are compared, so `f(x)` written twice is one " +
      "value and `f(x)` beside `f(y)` is two, which is nothing to bind. A body that repeats only a name or a " +
      "literal has nothing here either, because a name is read rather than computed.",
    args: [],
  },
  {
    name: "common-subexpression",
    summary: "Bind a value a block computes more than once to a name, and read the name instead.",
    applies:
      "Any block, named by its own id, and the blocks nested inside it. The value must be computed at least " +
      "twice across them, must be written the same way every time, must not call anything, must not allocate, " +
      "and must not read a name those blocks write or declare. A read of memory is never one of them: an " +
      "element, a field and a length are all excluded, because the IR holds no length and no null test, so a " +
      "binding would move the read out from under the test that made it safe. A block whose repeated text is " +
      "only a call, a literal, a name or a memory read has nothing this rule can bind, and is refused.",
    args: [],
  },
  {
    name: "reciprocal-multiply",
    summary: "Turn a division by a power of two into a multiplication by its exact reciprocal.",
    applies:
      "A floating point division in the named block whose divisor is written out and is 2, 4, 8 ... up to 1024. " +
      "Both forms are exact in binary floating point, so the result is the same number. A whole number division " +
      "is left alone: truncation towards zero and a shift disagree on a negative value.",
    args: [],
  },
  {
    name: "inline-call",
    summary: "Put the body of a called function where the call was, under names of its own.",
    applies:
      "A call written in the statements of the named block, not in one nested inside it. Every call the " +
      "block makes to the callee is put there, each with the arguments it was written with and under names of " +
      "its own, so a block that calls it five times ends by calling it none. The callee must compute a result " +
      "and do nothing else: no call of its own, no allocation, no printing, no reading of the command line, no " +
      "ownership to hand back, and no block left for anything but the next one.",
    args: [{ name: "callee", description: "the function to put the body of, by the name it is contracted under" }],
  },
];

/* -------------------------------------------------------------------------- */
/* Applying a proposal                                                        */
/* -------------------------------------------------------------------------- */

/** What a review is applied to: the function, and the other functions it may reach. */
export interface RepairContext {
  /** Every function of the program as the IR holds it, by contract name. */
  readonly functions: ReadonlyMap<string, SemanticFunction>;
}

/** What a rule did, or why it did not do it. */
export type RepairOutcome =
  | {
      readonly applied: SemanticFunction;
      readonly note: string;
      /**
       * What the rule could not do where it was applied, oldest first. A rule
       * aimed at a whole block that holds several calls to one callee inlines
       * the ones it can and leaves the rest, and the ones it left are said
       * here rather than dropped.
       */
      readonly partial?: readonly string[];
    }
  | { readonly refused: string };

/**
 * Applies one proposal to one function. The function handed in is never
 * modified: a refused proposal leaves the caller's tree exactly as it was, and
 * an applied one hands back a tree that shares nothing with it.
 */
export function applyProposal(
  fn: SemanticFunction,
  proposal: Proposal,
  context: RepairContext,
): RepairOutcome {
  const rule = REPAIR_RULES.find((entry) => entry.name === proposal.rule);
  if (rule === undefined) {
    return {
      refused: `there is no rule named "${proposal.rule}": the rules are ${REPAIR_RULES.map((entry) => entry.name).join(", ")}`,
    };
  }
  const unknown = Object.keys(proposal.args).filter(
    (name) => !rule.args.some((argument) => argument.name === name),
  );
  if (unknown.length > 0) {
    return {
      refused: `${rule.name} takes no ${unknown.join(" and no ")}: it takes ${
        rule.args.length === 0 ? "nothing at all" : rule.args.map((argument) => argument.name).join(", ")
      }`,
    };
  }

  const revised = structuredClone(fn);
  switch (proposal.rule) {
    case "hoist-invariant":
      return hoistInvariant(revised, proposal.site);
    case "common-subexpression":
      return commonSubexpression(revised, proposal.site);
    case "reciprocal-multiply":
      return reciprocalMultiply(revised, proposal.site);
    case "inline-call":
      return inlineCall(revised, proposal.site, proposal.args.callee ?? "", context);
    default:
      return { refused: `there is no rule named "${proposal.rule}"` };
  }
}

/* -------------------------------------------------------------------------- */
/* Blocks and loops                                                           */
/* -------------------------------------------------------------------------- */

/** A loop as a proposal may name it: the block it is written in, and the loop. */
interface LoopSite {
  readonly owner: SemanticBlock;
  readonly statement: SemanticStatement & { k: "loop" };
  readonly loop: SemanticLoop;
}

/** The blocks a statement is made of, which is what a walk of a body follows. */
function statementBlocks(statement: SemanticStatement): readonly SemanticBlock[] {
  switch (statement.k) {
    case "if":
      return statement.otherwise === null ? [statement.then] : [statement.then, statement.otherwise];
    case "loop":
      return [statement.loop.body];
    case "block":
      return [statement.body];
    default:
      return [];
  }
}

/** A block and every block nested inside it, itself included. */
function nestedBlocks(block: SemanticBlock): SemanticBlock[] {
  const blocks: SemanticBlock[] = [block];
  for (const statement of block.statements) {
    for (const nested of statementBlocks(statement)) blocks.push(...nestedBlocks(nested));
  }
  return blocks;
}

/** Every block of a function, the entry first, then each one nested inside it. */
function blocksOf(fn: SemanticFunction): SemanticBlock[] {
  return nestedBlocks(fn.entry);
}

/** Every loop of a function, with the block each one is written in. */
function loopsOf(fn: SemanticFunction): LoopSite[] {
  const loops: LoopSite[] = [];
  for (const block of blocksOf(fn)) {
    for (const statement of block.statements) {
      if (statement.k === "loop") loops.push({ owner: block, statement, loop: statement.loop });
    }
  }
  return loops;
}

function blockAt(fn: SemanticFunction, site: string): SemanticBlock | null {
  return blocksOf(fn).find((block) => block.id === site) ?? null;
}

function blockNames(fn: SemanticFunction): string {
  return blocksOf(fn)
    .map((block) => block.id)
    .join(", ");
}

/**
 * The loop a site names. A loop is named either by the block it leaves for
 * (`header b1 exit entry`) or by the block it is written in, so a proposal may
 * use whichever id the IR showed the reader. A block that holds two loops names
 * neither of them, and the proposal is refused with both ids rather than applied
 * to whichever came first.
 */
function loopAt(fn: SemanticFunction, site: string): { found: LoopSite } | { refused: string } {
  const loops = loopsOf(fn);
  const byHeader = loops.filter((entry) => entry.loop.header === site);
  if (byHeader.length === 1) return { found: byHeader[0] };
  if (byHeader.length > 1) return { refused: `${byHeader.length} loops leave for block ${site}, so it names none of them` };
  const inBlock = loops.filter((entry) => entry.owner.id === site);
  if (inBlock.length === 1) return { found: inBlock[0] };
  if (inBlock.length > 1) {
    return {
      refused: `block ${site} holds ${inBlock.length} loops (${inBlock.map((entry) => entry.loop.header).join(", ")}); name the one you mean by the block it leaves for`,
    };
  }
  return { refused: `no loop is written in block ${site} or leaves for it; the blocks are ${blockNames(fn)}` };
}

/* -------------------------------------------------------------------------- */
/* Names                                                                      */
/* -------------------------------------------------------------------------- */

/** Every name the function has a slot for, which a rewrite may not reuse. */
function slotNames(fn: SemanticFunction): Set<string> {
  const names = new Set<string>();
  for (const param of fn.params) names.add(param.name);
  for (const block of blocksOf(fn)) {
    for (const statement of block.statements) {
      if (statement.k === "let") names.add(statement.slot.name);
    }
  }
  return names;
}

/** A name no slot of the function has, so a rewrite cannot shadow one. */
export function freshName(taken: Set<string>, prefix: string): string {
  for (let index = 1; ; index += 1) {
    const name = `${prefix}${index}`;
    if (!taken.has(name)) {
      taken.add(name);
      return name;
    }
  }
}

/** Every name a block declares of its own, which a rewrite renames beside it. */
export function declaredNames(block: SemanticBlock): string[] {
  return block.statements.flatMap((statement) => (statement.k === "let" ? [statement.slot.name] : []));
}

/* -------------------------------------------------------------------------- */
/* Values                                                                     */
/* -------------------------------------------------------------------------- */

/** The values a value is made of, in the order they are read. */
function valueChildren(value: SemanticValue): readonly SemanticValue[] {
  switch (value.k) {
    case "text":
      return value.parts.flatMap((part) => (part.k === "value" ? [part.value] : []));
    case "length":
    case "toText":
      return [value.of];
    case "isNull":
    case "unary":
      return [value.operand];
    case "element":
      return [value.of, value.index];
    case "call":
      return value.call.args;
    case "arith":
    case "compare":
    case "logical":
    case "coalesce":
      return [value.left, value.right];
    case "buffer":
      return value.values;
    case "loadField":
      return [value.object];
    case "newObject":
      return value.fields.map((field) => field.value);
    case "select":
      return [value.condition, value.then, value.otherwise];
    default:
      return [];
  }
}

/** A walk of a value that stops descending once the visitor says so. */
function walkValues(value: SemanticValue, visit: (value: SemanticValue) => boolean | void): void {
  if (visit(value) === false) return;
  for (const child of valueChildren(value)) walkValues(child, visit);
}

/** The names a value reads, in the order it reads them. */
function namesRead(value: SemanticValue): string[] {
  const names: string[] = [];
  walkValues(value, (inner) => {
    if (inner.k === "local") names.push(inner.name);
  });
  return names;
}


/**
 * A value a rule may bind to a name: one that is computed rather than read. A
 * call and an allocation are computed too, but running one twice is not the
 * same program as running one once, so neither is ever bound.
 *
 * This says what a value *is*. Whether it may be computed on a turn that did
 * not read it is `isSafeToCompute`, which a value that reads memory or divides
 * whole numbers does not pass — binding one of those moves the computation
 * somewhere it may not have been.
 */
export function isBindable(value: SemanticValue): boolean {
  switch (value.k) {
    case "arith":
    case "compare":
    case "logical":
    case "coalesce":
    case "select":
    case "unary":
    case "isNull":
    case "toText":
    case "element":
    case "length":
    case "loadField":
    case "text":
      return true;
    default:
      return false;
  }
}

/**
 * The operations that divide, and so fault over a divisor of zero.
 *
 * A floor division and a floored remainder are the truncating pair over a
 * negative number, and they fault over a zero divisor exactly as the
 * truncating pair does.
 */
const DIVIDING: RegExp = /^(?:div|mod|floorDiv|floorMod)$/;

/**
 * Whether a value can be computed on a turn when the turn that used to compute
 * it did not happen, and on a turn that used to run where this one now runs
 * instead.
 *
 * Both rules bind a value to a name, and a name is computed once where the
 * value was computed wherever it was read. That is the same program only when
 * the value can be computed every time: a rule that turns a computation which
 * ran inside an arm, or on a turn of a loop that had one, into one that runs on
 * every turn has added an evaluation the source never asked for.
 *
 * Two things in the IR can fault, and neither is guarded at any mode:
 *
 * - A load. `element`, `loadField` and `length` read memory, the IR holds no
 *   length and no null test, so nothing here can say the address is one the
 *   program owns. Hoisting a read out of the arm that guarded it, or out of a
 *   loop that ran no turns, is an out-of-bounds read or a null dereference the
 *   source could not perform. This is also what closes the alias case: a value
 *   is only out of date because something was written through another name for
 *   the same object, and the only way to read through an object is one of these
 *   three, so a value that reads none of them is the same value whatever the
 *   region wrote.
 * - A division or a remainder of whole numbers. There is no whole-number divide
 *   by zero on any target: `idiv` raises `SIGFPE` and `i32.div_s` traps. The
 *   double operation is not this one, and answers an infinity instead of
 *   stopping, so a divisor that is a whole number is what has to be checked.
 *   A floor division and a floored remainder are the same division and the
 *   same remainder: they answer differently over a negative number and they
 *   fault over a zero one, exactly as the truncating pair does.
 *
 * Everything else here is arithmetic on values already in hand, a comparison,
 * or a choice between two of them, and a choice is as lazy as it was.
 */
export function isSafeToCompute(value: SemanticValue): boolean {
  switch (value.k) {
    case "element":
    case "loadField":
    case "length":
      return false;
    case "arith": {
      if (!DIVIDING.test(value.op)) return isSafeToCompute(value.left) && isSafeToCompute(value.right);
      // A whole number answers a division by zero with a fault and a double
      // answers it with an infinity, so only the whole number is the hazard. A
      // divisor written out is a divisor whose value is known.
      if (!isInteger(value.left.type) || !isInteger(value.right.type)) return true;
      if (value.right.k === "const") return Number(value.right.text) !== 0;
      return false;
    }
    case "compare":
      return isSafeToCompute(value.left) && isSafeToCompute(value.right);
    // The operand of these is read on the same turn the whole is, so it has to
    // pass the same test: `-a[i]` is an element read under a negation, and
    // answering true here bound it to a name, which put the read above the
    // guard the source performed it under.
    case "unary":
    case "isNull":
      return isSafeToCompute(value.operand);
    case "logical":
    case "coalesce":
      return isSafeToCompute(value.left) && isSafeToCompute(value.right);
    case "select":
      return (
        isSafeToCompute(value.condition) && isSafeToCompute(value.then) && isSafeToCompute(value.otherwise)
      );
    // An object is allocated and its fields are written, so it is not a value
    // to move: a `let node = { left: ..., right: ... }` bound to another place
    // would run its allocation on a turn it was not written on, and a block
    // that released the name would release it twice.
    case "newObject":
      return false;
    case "call":
      // A call that has an effect is not a value: it reads the world, so
      // computing it twice reads the world twice, and computing it on a turn
      // that did not read it reads the world on a turn the source did not.
      return value.call.effects.length === 0;
    case "toText":
      return isSafeToCompute(value.of);
    case "text":
      // An interpolated part is read on the same turn the whole is, so a part
      // that reads through an object fails the test the read itself fails.
      return value.parts.every((part) => part.k !== "value" || isSafeToCompute(part.value));
    default:
      // A name, a literal, a truth and a null read nothing and compute nothing.
      return true;
  }
}

/**
 * The slot a computed value is bound to, which is what its own type asks for.
 *
 * A binding the body writes again is a place rather than a binding, and says so
 * with `mutable`: the validator holds every write to a name the source declared
 * immutable, so an inlined parameter the callee's own body writes — bound here
 * to the copy it was given — has to be a name that can be written.
 */
export function slotFor(value: SemanticValue, name: string, mutable = false): SemanticSlot {
  if (isTextType(value.type)) return { kind: "text", name, mutable };
  if (isReference(value.type)) return { kind: "object", name, mutable, type: value.type };
  return { kind: "value", name, mutable, type: value.type };
}

/** A type, as a diagnostic names it. */
export function typeLabel(type: SemanticType): string {
  if (type.kind === "primitive") return type.name;
  return type.kind === "text" ? "text" : "a reference";
}

/**
 * Two values are the same value when they are written the same way. The key is
 * canonical, so a value built one way is found wherever an equal one is built
 * another, which is what makes a repeated expression a repeated expression.
 */
export function valueKey(value: SemanticValue): string {
  return JSON.stringify(value, (_name, entry: unknown) =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry as Record<string, unknown>).sort(([left], [right]) => (left < right ? -1 : 1)),
        )
      : entry,
  );
}

function isValueNode(node: unknown): node is SemanticValue {
  return node !== null && typeof node === "object" && typeof (node as { k?: unknown }).k === "string";
}

/**
 * Replaces every occurrence of the values a map holds. A node that is replaced
 * is not looked at again, so a value inside a value that was already replaced
 * is never rewritten into itself.
 */
export function replaceValues<T>(node: T, replacements: ReadonlyMap<string, SemanticValue>): T {
  if (isValueNode(node)) {
    const hit = replacements.get(valueKey(node));
    if (hit !== undefined) return structuredClone(hit) as T;
  }
  if (Array.isArray(node)) return node.map((entry) => replaceValues(entry, replacements)) as T;
  if (node !== null && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>).map(([name, entry]) => [name, replaceValues(entry, replacements)]),
    ) as T;
  }
  return node;
}

/**
 * Replaces what each name a map holds reads, everywhere in a tree, and what
 * each name it writes is written under.
 *
 * A name that is replaced is not looked at again, so an argument bound to a
 * name is not rewritten through that name.
 *
 * The write targets are the reason the second map exists. A `set`, a `step` and
 * a `setElement` name what they write as a bare string rather than as a value,
 * so a substitution that only looked for values left the callee's own name
 * sitting in the caller's frame: the callee's local landed on a name the caller
 * had, and the value the caller read back was a write it never made. That is
 * why `inline-call` used to refuse every callee that wrote anything, which is
 * every accumulator.
 */
export function substituteLocals<T>(node: T, bindings: ReadonlyMap<string, SemanticValue>, writes: ReadonlyMap<string, string> = new Map()): T {
  if (typeof node === "string") return (writes.get(node) ?? node) as T;
  if (isValueNode(node) && node.k === "local") {
    const bound = bindings.get(node.name);
    if (bound !== undefined) return structuredClone(bound) as T;
  }
  if (Array.isArray(node)) return node.map((entry) => substituteLocals(entry, bindings, writes)) as T;
  if (node !== null && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>).map(([name, entry]) => [name, substituteLocals(entry, bindings, writes)]),
    ) as T;
  }
  return node;
}

/** Rewrites every value of a block, and of every block nested inside it. */
function rewriteBlock(block: SemanticBlock, replacements: ReadonlyMap<string, SemanticValue>): void {
  block.statements = block.statements.map((statement) => replaceValues(statement, replacements));
  for (const statement of block.statements) {
    for (const nested of statementBlocks(statement)) rewriteBlock(nested, replacements);
  }
  if (block.terminator.k === "return" && block.terminator.value !== null) {
    block.terminator = { ...block.terminator, value: replaceValues(block.terminator.value, replacements) };
  }
}

/** The values a statement computes in its own right, without its nested blocks. */
function statementValues(statement: SemanticStatement): readonly SemanticValue[] {
  switch (statement.k) {
    case "let":
    case "set":
    case "printText":
    case "printNumber":
    case "retain": return [statement.value];
    // A field is written through an object, and the object is read to find which
    // one: a binding that is read only that way is one this would drop, leaving
    // the write naming a name the block never declared.
    case "storeField": return [statement.object, statement.value];
    case "setElement":
      return [statement.index, statement.value];
    case "if":
      return [statement.condition];
    case "raise":
      return [statement.message];
    case "call":
      return [{ k: "call", type: statement.call.returns, call: statement.call }];
    case "loop": {
      const loop = statement.loop;
      if (loop.kind === "counted") return [loop.from, loop.to, ...(loop.step === null ? [] : [loop.step])];
      if (loop.kind === "each") return [loop.length];
      return [loop.condition];
    }
    default:
      return [];
  }
}

/** Every value a set of blocks computes, themselves included. */
function blockValues(blocks: readonly SemanticBlock[]): SemanticValue[] {
  const values: SemanticValue[] = [];
  for (const block of blocks) {
    for (const statement of block.statements) values.push(...statementValues(statement));
    if (block.terminator.k === "return" && block.terminator.value !== null) values.push(block.terminator.value);
  }
  return values;
}

/**
 * Every name a set of blocks writes, which a value bound to a name may not
 * read: what a statement writes, and the counter of every loop in it, which the
 * loop writes itself and no statement in it mentions. A value that reads a
 * counter is not the same value on every iteration, however few times the loop
 * computes it.
 *
 * `declarations` says whether a name these blocks declare counts as written: a
 * name a loop declares belongs to that loop and is not above it, while a name a
 * block declares is read from the statement that follows it on.
 */
function writtenIn(blocks: readonly SemanticBlock[], declarations: boolean): Set<string> {
  const written = new Set<string>();
  for (const block of blocks) {
    for (const statement of block.statements) {
      switch (statement.k) {
        case "set":
        case "step":
          written.add(statement.name);
          break;
        case "setElement":
          written.add(statement.buffer);
          break;
        case "storeField":
          for (const name of namesRead(statement.object)) written.add(name);
          break;
        case "let":
          if (declarations) written.add(statement.slot.name);
          break;
        case "loop":
          if (statement.loop.kind === "counted") written.add(statement.loop.variable);
          else if (statement.loop.kind === "each") {
            written.add(statement.loop.index);
            written.add(statement.loop.element);
          }
          break;
        default:
          break;
      }
    }
  }
  return written;
}

/**
 * Every name a block nested inside the first one declares. A binding written at
 * the top of the first block reads the name that is in scope there, which is
 * not the one the nested block declares, so a value that reads such a name is
 * a different value above the nested block than inside it.
 */
function shadowedIn(blocks: readonly SemanticBlock[]): ReadonlySet<string> {
  const shadowed = new Set<string>();
  for (const block of blocks.slice(1)) {
    for (const statement of block.statements) {
      if (statement.k === "let") shadowed.add(statement.slot.name);
      else if (statement.k === "loop" && statement.loop.kind === "counted") shadowed.add(statement.loop.variable);
      else if (statement.k === "loop" && statement.loop.kind === "each") {
        shadowed.add(statement.loop.index);
        shadowed.add(statement.loop.element);
      }
    }
  }
  return shadowed;
}

/**
 * The values a set of blocks computes more than once, keyed by how they are
 * written, and only where binding one to a name computes it the same number of
 * times: a value that calls, that allocates, that reads a name these blocks
 * write, or that cannot be computed on a turn that did not use to compute it,
 * is not among them.
 */
function repeatedValues(blocks: readonly SemanticBlock[], written: ReadonlySet<string>): Map<string, SemanticValue> {
  const counts = new Map<string, { value: SemanticValue; count: number }>();
  // Every occurrence counts: a value computed twice in the same expression is
  // computed twice just as much as one computed in two statements.
  for (const root of blockValues(blocks)) {
    walkValues(root, (value) => {
      if (!isBindable(value) || hasCall(value)) return;
      if (namesRead(value).some((name) => written.has(name))) return;
      // A name is computed where it is written, which is above every use and
      // beside every one of them, so the value it holds has to be one that can
      // be computed on a turn that did not read it. This is also what keeps a
      // value that reads through a name the region writes through another one
      // out: a value is only out of date because of a write, and it can only be
      // out of date if it reads what was written.
      if (!isSafeToCompute(value)) return;
      const key = valueKey(value);
      const entry = counts.get(key);
      if (entry === undefined) counts.set(key, { value, count: 1 });
      else entry.count += 1;
    });
  }
  const repeated = new Map<string, SemanticValue>();
  for (const [key, entry] of counts) {
    if (entry.count > 1) repeated.set(key, entry.value);
  }
  return repeated;
}

/**
 * Why a set of blocks has nothing a rule may bind, in terms of what it does
 * compute more than once.
 *
 * A refusal that only says there is nothing to bind leaves a model that was not
 * wrong about the repetition to conclude it was wrong about the repetition, and
 * to propose it again in the next round. The values counted here are the ones
 * written more than once and then dropped, each classified by the same
 * predicate `repeatedValues` drops it on, so a reason stated here and the rule
 * that refused it cannot come to disagree.
 */
function nothingToBind(blocks: readonly SemanticBlock[], written: ReadonlySet<string>, verb: string): string {
  const counts = new Map<string, { value: SemanticValue; count: number }>();
  for (const root of blockValues(blocks)) {
    walkValues(root, (value) => {
      const key = valueKey(value);
      const entry = counts.get(key);
      if (entry === undefined) counts.set(key, { value, count: 1 });
      else entry.count += 1;
    });
  }
  // The value a reader of the IR would have named comes first. A name and a
  // literal are written more than once in almost every body and are never what
  // a proposal is about, so a refusal that led with one would name something
  // the model never proposed and answer none of the question it asked. What is
  // left is a computed value, and the outermost of those is the one a reader
  // would have pointed at: it is the whole of the expression, not a part of it.
  const computed = (value: SemanticValue): boolean => isBindable(value) && !hasCall(value) && value.k !== "newObject";
  const repeated = [...counts.values()]
    .filter((entry) => entry.count > 1)
    .sort((left, right) => {
      const byKind = Number(computed(right.value)) - Number(computed(left.value));
      return byKind !== 0 ? byKind : valueKey(right.value).length - valueKey(left.value).length;
    });
  const reason = (value: SemanticValue): string | null => {
    if (hasCall(value)) return "it calls something, and running a call once instead of twice is not the same program";
    if (value.k === "newObject") return "it allocates, and allocating once instead of twice is not the same program";
    if (namesRead(value).some((name) => written.has(name))) {
      return "it reads a name the region writes, so it is a different value on another pass";
    }
    if (!isBindable(value)) return "it is a name or a literal, which is read rather than computed";
    if (!isSafeToCompute(value)) {
      return "it reads memory, and the IR holds no length and no null test, so binding it would move the read out from under the test that made it safe";
    }
    return null;
  };
  const named = repeated
    .map((entry) => ({ ...entry, reason: reason(entry.value) }))
    .filter((entry): entry is { value: SemanticValue; count: number; reason: string } => entry.reason !== null);
  const [first] = named;
  if (first === undefined) return `computes nothing more than once that can be ${verb}, so there is nothing to do`;
  return (
    `computes \`${printSemanticValue(first.value)}\` ${first.count} times, but ${first.reason}` +
    (named.length === 1
      ? ""
      : `; it also computes ${named.length - 1} other repeated value(s), none of which can be ${verb} either`)
  );
}

/* -------------------------------------------------------------------------- */
/* hoist-invariant                                                            */
/* -------------------------------------------------------------------------- */

function hoistInvariant(fn: SemanticFunction, site: string): RepairOutcome {
  const located = loopAt(fn, site);
  if ("refused" in located) return located;
  const target = located.found;
  // The condition is read once per iteration like the body is, and a value it
  // shares with the body is hoisted above the loop, where both of them read it.
  const region = [...nestedBlocks(target.loop.body), { ...target.owner, statements: [target.statement] }];
  const written = writtenIn(region, true);
  const repeated = repeatedValues(region, written);

  if (repeated.size === 0) {
    return { refused: `has a body that ${nothingToBind(region, written, "hoisted")}` };
  }

  // The largest first: a value that is part of a bigger repeated value is
  // rewritten into the bigger one rather than bound beside it.
  const ordered = [...repeated.values()].sort((left, right) => valueKey(right).length - valueKey(left).length);
  const taken = slotNames(fn);
  const bound = new Map<string, SemanticValue>();
  const hoisted: SemanticStatement[] = [];
  for (const value of ordered) {
    const name = freshName(taken, "hoisted");
    bound.set(valueKey(value), { k: "local", type: value.type, name });
    hoisted.push({ k: "let", slot: slotFor(value, name), value: structuredClone(value), line: target.statement.line });
  }
  const at = target.owner.statements.indexOf(target.statement);
  target.owner.statements[at] = replaceValues(target.statement, bound);
  rewriteBlock(target.loop.body, bound);
  target.owner.statements.splice(at, 0, ...hoisted);
  return {
    applied: fn,
    note: `hoisted ${hoisted.length} value(s) out of ${target.loop.header} as ${hoisted
      .map((statement) => (statement.k === "let" ? statement.slot.name : ""))
      .join(", ")}`,
  };
}

/* -------------------------------------------------------------------------- */
/* common-subexpression                                                        */
/* -------------------------------------------------------------------------- */

function commonSubexpression(fn: SemanticFunction, site: string): RepairOutcome {
  // A loop is named in the IR by the block it leaves for, and that id is
  // also the name a proposal is written against: a body the expression lives in
  // is the block the loop enters by rather than the block it was named from.
  // Resolving a header to that body keeps a rewrite that is valid on the body
  // from being refused on the spelling the reader of the IR actually saw.
  let block = blockAt(fn, site);
  if (block === null) {
    const loop = loopsOf(fn).find((entry) => entry.loop.header === site);
    if (loop !== undefined) block = loop.loop.body;
  }
  if (block === null) return { refused: `no block is named ${site}; the blocks are ${blockNames(fn)}` };

  // A block that ends in a return hands its value back from the statement that
  // wrote it, so the terminator is part of the block this rule reads.
  const scope = nestedBlocks(block);
  // A binding is written at the top of `block`, and a name a block nested
  // inside it declares shadows the name that binding would be written under:
  // the same written value read inside the arm and read at the top of the
  // block are two different values. They share a spelling, which is all the
  // key compares, so the shadowing names are written names here for the same
  // reason a loop's counter is: a value that reads one is not the same value
  // everywhere in the scope.
  const written = writtenIn(scope, false);
  for (const name of shadowedIn(scope)) written.add(name);
  const repeated = repeatedValues(scope, written);
  if (repeated.size === 0) {
    return { refused: nothingToBind(scope, written, "bound") };
  }

  const ordered = [...repeated.values()].sort((left, right) => valueKey(right).length - valueKey(left).length);
  const taken = slotNames(fn);
  const bound = new Map<string, SemanticValue>();
  const names: string[] = [];
  for (const value of ordered) {
    const name = freshName(taken, "shared");
    names.push(name);
    bound.set(valueKey(value), { k: "local", type: value.type, name });
  }
  // Every use is rewritten before the binding is written, so a binding never
  // reads the name it declares.
  for (const nested of nestedBlocks(block)) rewriteBlock(nested, bound);
  // The bindings go as high in the block as every name they read is declared.
  // At the top they are not: a binding computes its value where it is written,
  // so a name the block declares below it is read before that declaration has
  // run, and the C the backend writes for it names a local that does not exist
  // yet — an artifact no compiler takes, on the commonest shape there is, a
  // value repeated across a name the block itself binds. Sitting under the last
  // such declaration is as high as it may go and every use is still below it.
  const declared = new Set(ordered.flatMap((value) => namesRead(value)));
  let at = 0;
  block.statements.forEach((statement, index) => {
    if (statement.k === "let" && declared.has(statement.slot.name)) at = index + 1;
  });
  const line = block.statements[at]?.line ?? block.statements[0]?.line ?? 0;
  block.statements.splice(
    at,
    0,
    ...ordered.map((value, index) => ({
      k: "let" as const,
      slot: slotFor(value, names[index] ?? ""),
      value: structuredClone(value),
      line,
    })),
  );
  return { applied: fn, note: `bound ${names.length} repeated value(s) in ${site} as ${names.join(", ")}` };
}


/* -------------------------------------------------------------------------- */
/* reciprocal-multiply                                                        */
/* -------------------------------------------------------------------------- */

/** The exponent a literal is a power of two by, or null when it is not one. */
function powerOfTwoExponent(text: string): number | null {
  const value = Number(text);
  if (!Number.isInteger(value) || value < 2) return null;
  const exponent = Math.log2(value);
  return Number.isInteger(exponent) && exponent >= 1 && exponent <= 10 ? exponent : null;
}

/** A float type, which is the only one the two forms are the same number in. */
function isFloatType(type: SemanticType): boolean {
  return type.kind === "primitive" && (type.name === "f32" || type.name === "f64");
}

function reciprocalMultiply(fn: SemanticFunction, site: string): RepairOutcome {
  // A loop is named in the IR by the block it leaves for, and that id is
  // also the name a proposal is written against: a body the division lives in
  // is the block the loop enters by rather than the block it was named from.
  // Resolving a header to that body keeps a rewrite that is valid on the body
  // from being refused on the spelling the reader of the IR actually saw.
  let block = blockAt(fn, site);
  if (block === null) {
    const loop = loopsOf(fn).find((entry) => entry.loop.header === site);
    if (loop !== undefined) block = loop.loop.body;
  }
  if (block === null) return { refused: `no block is named ${site}; the blocks are ${blockNames(fn)}` };

  const replacements = new Map<string, SemanticValue>();
  // Deepest first, so a division inside a division is already a multiplication
  // by the time the division around it is rewritten.
  const collect = (value: SemanticValue): void => {
    for (const child of valueChildren(value)) collect(child);
    if (value.k !== "arith" || value.op !== "div") return;
    if (!isFloatType(value.type) || value.right.k !== "const" || !isFloatType(value.right.type)) return;
    const exponent = powerOfTwoExponent(value.right.text);
    if (exponent === null) return;
    replacements.set(valueKey(value), {
      k: "arith",
      type: value.type,
      op: "mul",
      left: replaceValues(value.left, replacements),
      right: { k: "const", type: value.right.type, text: String(2 ** -exponent) },
    });
  };
  for (const value of blockValues(nestedBlocks(block))) collect(value);
  if (replacements.size === 0) {
    return { refused: `divides by nothing that is a power of two, or divides in a type where the two forms are not the same number` };
  }
  for (const nested of nestedBlocks(block)) rewriteBlock(nested, replacements);
  return { applied: fn, note: `turned ${replacements.size} division(s) in ${site} into a multiplication by their reciprocal` };
}

/* -------------------------------------------------------------------------- */
/* inline-call                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A call a statement makes to a callee, with the statement it makes it in.
 *
 * The statement is null for the call the block's own terminator makes, because
 * that one has no statement to be written in: a block hands its value back
 * from its terminator as often as it computes it in a statement.
 */
interface FoundCall {
  readonly statement: SemanticStatement | null;
  readonly call: SemanticCall;
}

/** The call a value makes to a callee in its own right, or null. */
function callValueIn(value: SemanticValue | null, callee: string): SemanticCall | null {
  if (value === null) return null;
  let found: SemanticCall | null = null;
  walkValues(value, (inner) => {
    if (inner.k === "call" && inner.call.callee === callee) found ??= inner.call;
  });
  return found;
}

/**
 * The call a statement makes to a callee in its own right, with its statement.
 *
 * A statement that is itself a call is read the same way as any other: the
 * whole call is one value the statement computes, so a callee written inside
 * its arguments is a call the statement makes too.
 */
function callIn(statement: SemanticStatement, callee: string): FoundCall | null {
  for (const value of statementValues(statement)) {
    const call = callValueIn(value, callee);
    if (call !== null) return { statement, call };
  }
  return null;
}

/**
 * Every call the block makes to a callee, in the order they are written.
 *
 * The terminator's own call is read after the statements', because that is the
 * order the block computes them in.
 */
function callsInBlock(block: SemanticBlock, callee: string): FoundCall[] {
  const found: FoundCall[] = [];
  for (const statement of block.statements) {
    const entry = callIn(statement, callee);
    if (entry !== null) found.push(entry);
  }
  const returned = block.terminator.k === "return" ? callValueIn(block.terminator.value, callee) : null;
  if (returned !== null) found.push({ statement: null, call: returned });
  return found;
}

/**
 * Puts the body of a callee where every call the block makes to it was.
 *
 * A proposal is a rule, a block and a callee: it does not name one of the
 * calls, and when a block makes several of them there is nothing to choose
 * between. Every one is written the same way, so every one is inlined, each
 * under names of its own beside the arguments it was written with — which is
 * the same rewrite one call was, run once per call. A call that cannot be
 * inlined is refused on its own and the rest still are, so what is left in the
 * block is said in `partial` rather than hidden behind a refusal of the whole.
 */
export function inlineCall(fn: SemanticFunction, site: string, calleeName: string, context: RepairContext): RepairOutcome {
  // A loop is named in the IR by the block it leaves for, and that id is
  // also the name a proposal is written against: a call written in a loop's
  // body belongs to the block the loop enters by rather than to the header it
  // was named from. Resolving a header to that body keeps a rewrite that is
  // valid on the body from being refused on the spelling the reader saw.
  let block = blockAt(fn, site);
  if (block === null) {
    const loop = loopsOf(fn).find((entry) => entry.loop.header === site);
    if (loop !== undefined) block = loop.loop.body;
  }
  if (block === null) return { refused: `cannot be written into block ${site}: there is no such block, and the blocks are ${blockNames(fn)}` };
  const callee = context.functions.get(calleeName);
  if (callee === undefined) {
    const names = [...context.functions.keys()].join(", ");
    return { refused: `${calleeName} is not a function of this program: the program has ${names}` };
  }

  // A block hands its value back from its terminator as often as from a
  // statement, so the calls this rule inlines may be written in either. The
  // site is read before the callee is judged: a block that does not make the
  // call at all is the more useful thing to say, and it names the block, so a
  // proposal aimed at the wrong one is corrected rather than told its callee
  // is the problem.
  if (callsInBlock(block, calleeName).length === 0) {
    return { refused: `${calleeName} is not called in block ${site}` };
  }
  const refusal = inlineRefusal(callee);
  if (refusal !== null) return { refused: `${calleeName} ${refusal}` };

  let current = fn;
  let inlined = 0;
  // How many calls this block has already refused. The calls are found again
  // in the tree the previous round produced, because writing one body in front
  // of a call moves the calls written after it, and the one that was refused is
  // still where it was.
  let skipped = 0;
  const partial: string[] = [];
  for (;;) {
    const attempt = structuredClone(current);
    const inBlock = blockAt(attempt, site) as SemanticBlock;
    const target = callsInBlock(inBlock, calleeName)[skipped];
    if (target === undefined) break;
    const outcome = inlineOne(attempt, inBlock, callee, calleeName, target);
    if ("refused" in outcome) {
      partial.push(outcome.refused);
      skipped += 1;
      continue;
    }
    current = outcome.applied;
    inlined += 1;
  }
  if (inlined === 0) return { refused: partial[0] ?? `${calleeName} is not called in block ${site}` };
  const times = inlined === 1 ? "" : ` ${inlined} times`;
  const bound =
    callee.returns.kind === "void"
      ? ""
      : inlined === 1
        ? " and bound what it returns"
        : " and bound what each returns";
  return {
    applied: current,
    note: `inlined ${calleeName} into ${site}${times}${bound}`,
    ...(partial.length === 0 ? {} : { partial }),
  };
}

/**
 * Puts the body of a callee where one call the block makes to it was.
 *
 * The block is the one the named block became in the tree being rewritten,
 * which is not the tree `inlineCall` was handed: the names of an inlined copy
 * are taken from the blocks that are already there, so a body written in front
 * of one call must not leave its names for the next one to trip over.
 *
 * The tree is written in place and handed back, and what it answers is whether
 * this one call could be written at all: the count of the ones that were, and
 * what to say about them, is the caller's to decide.
 */
function inlineOne(
  fn: SemanticFunction,
  block: SemanticBlock,
  callee: SemanticFunction,
  calleeName: string,
  target: FoundCall,
): { applied: SemanticFunction } | { refused: string } {
  const call = target.call;
  const statement = target.statement;
  const line = statement?.line ?? 0;
  if (statement !== null && statement.k === "call" && callee.returns.kind !== "void") {
    return { refused: `${calleeName} returns ${typeLabel(callee.returns)} and is called here only for what it does, so inlining it would bind a result to a name nothing reads` };
  }
  if (call.args.some((argument) => hasCall(argument))) {
    return { refused: `${calleeName} is called with an argument that is itself a call, which would be evaluated after the body inlined in front of it` };
  }

  // A block id is a name like any other, so the ids this function already has
  // are taken before a fresh one is made. The compiler inlines on its own and
  // runs a round per call, so a later round that renamed a block onto an id an
  // earlier round had already left behind put two blocks under one name, which
  // is a function the compiler cannot read back.
  const taken = new Set([...slotNames(fn), ...blocksOf(fn).map((block) => block.id)]);
  // Every name the callee declares is renamed into this function, and its
  // parameters become the arguments the call was made with, so nothing it was
  // written as can be read here as something of this function's. What each
  // name the callee writes is written under here. A local is renamed
  // like any other name, so its writes follow it. A parameter is a different
  // matter: a parameter is a *copy* of the argument, so a write to one must
  // never land on the name the caller passed. `const y = bump(x)` with
  // `bump` writing `x` leaves the caller's `x` at what it was, and a write that
  // reached through would answer 12 where the source answers 11. A written
  // parameter is therefore bound to a temporary of its own, which is the copy
  // the callee was given.
  const scope: Scope = { reads: new Map(), targets: new Map() };
  const before: SemanticStatement[] = [];
  callee.params.forEach((param, index) => {
    const argument = call.args[index];
    if (argument === undefined) return;
    scope.reads.set(param.name, structuredClone(argument));
    if (!writesName(callee, param.name)) return;
    const name = freshName(taken, "inlined");
    const slot = slotFor(argument, name, true);
    before.push({ k: "let", slot, value: structuredClone(argument), line });
    scope.reads.set(param.name, { k: "local", type: slotType(slot), name });
    scope.targets.set(param.name, name);
  });
  // The renaming walks the scopes the callee declares its names in, rather
  // than the spellings: two blocks of one body very often declare one spelling
  // — two loops counted by the same `i`, the commonest counter there is — and
  // those are two bindings. A map by spelling would make them one, and the
  // second loop would count the first one's counter. What a name answers for
  // inside the block it is declared in is that declaration; what it answers
  // for outside it is whatever answered before; and a declaration that shadows
  // a name already in scope — `helper(t, u)` whose `if` arm declares `let t`,
  // which inlined into a caller answered 31 where the program answers 210 — is
  // refused, because a name answers for one binding and the walk would be
  // renaming the shadow over the very reads the parameter's own binding
  // answers for.
  const body = structuredClone(callee.entry);
  const shadowed = renameBindings(body, scope, taken, callee.name);
  if (shadowed !== null) return { refused: shadowed };

  // A block id is a name like any other, and the callee's are its own: its
  // loop body is very often also called `b2`, which is the name the caller's
  // own loop body has. Two blocks under one id is a function the compiler
  // cannot read back, so the callee's blocks are renamed beside everything
  // else it brought with it.
  //
  // Two of the ids a loop names are not blocks of the tree at all: the header
  // it enters by is a name the loop is written with, and it is one the caller's
  // own loop is very often written with too. Left unrenamed, two loops of one
  // function are written with one header, which is one label twice in the code
  // either backend writes. The exit a loop written in the callee's own entry
  // block leaves for is that block, which after the splice is the block the
  // call was written in — so it is the caller's id it is written as here.
  const blocks = new Map<string, string>();
  for (const inner of nestedBlocks(callee.entry)) {
    // The prefix is part of what `freshName` counts, not something added to
    // what it chose: a name it picked as free is free under its own spelling,
    // and `inlined_block1` is the spelling the earlier round left behind.
    if (inner.id !== callee.entry.id) blocks.set(inner.id, freshName(taken, "inlined_block"));
  }
  for (const inner of nestedBlocks(callee.entry)) {
    for (const statement of inner.statements) {
      if (statement.k !== "loop") continue;
      for (const id of [statement.loop.header, statement.loop.exit]) {
        if (id === callee.entry.id) blocks.set(id, block.id);
        else if (!blocks.has(id)) blocks.set(id, freshName(taken, "inlined_block"));
      }
    }
  }
  // The block ids are renamed by a walk of the whole statement rather than by
  // picking the ones a loop names: a jump target, a loop's own header and exit
  // and the block a nested statement carries are all just strings, and each is
  // the callee's own spelling. The statements themselves were renamed by the
  // walk above, one scope at a time, so what is left here is the ids.
  const spliced = body.statements.map((entry) => replaceBlockIds(entry, blocks) as SemanticStatement);
  const result = body.terminator.k === "return" ? body.terminator.value : null;
  const added: SemanticStatement[] = [...before, ...spliced];
  // The result is bound to a name of its own, so the value that was the call
  // reads that name and the call is gone.
  let temp: SemanticValue | null = null;
  if (result !== null) {
    const slot = slotFor(result, freshName(taken, "inlined"));
    added.push({ k: "let", slot, value: result, line });
    temp = { k: "local", type: slotType(slot), name: slot.name };
  }
  const atCall = (read: SemanticValue): ReadonlyMap<string, SemanticValue> =>
    temp === null ? new Map() : new Map([[valueKey(read), temp]]);
  if (statement !== null) {
    const at = block.statements.indexOf(statement);
    // A statement the call was the whole of is replaced by the body, which is
    // the one shape a callee that hands back nothing can be written in: an
    // argument is a value, and no value holds a void. Where the call was
    // written inside the statement — `shell(twice(t))` inlining `twice` — the
    // statement stays and only the call inside it becomes the name, so losing
    // a statement would lose the call around it.
    const whole = statement.k === "call" && statement.call === call;
    const callNode = { k: "call" as const, type: call.returns, call };
    const kept = whole ? [] : [temp === null ? statement : replaceValues(statement, atCall(callNode))];
    block.statements.splice(at, 1, ...added, ...kept);
  } else {
    // A block whose terminator makes the call has no statement to write in
    // front of: the body goes at the end of the block's statements, and the
    // call the terminator reads is the name the body bound.
    block.statements.push(...added);
    if (temp !== null && block.terminator.k === "return") {
      const callNode = { k: "call" as const, type: call.returns, call };
      block.terminator = { ...block.terminator, value: replaceValues(block.terminator.value, atCall(callNode)) };
    }
  }
  dropUnusedEdge(fn, calleeName);
  return { applied: fn };
}

/**
 * Renames the block ids inside a spliced statement, at every depth.
 *
 * A loop names the block it enters and the one it leaves for, a block statement
 * carries one, and a terminator that jumps names one: all of them are the
 * callee's own spelling, and the caller's frame already has names of its own.
 * A block id left unrenamed is two blocks under one name, which the validator
 * refuses, so the callee's loop body is very often also called b2 as the
 * caller's own.
 */
export function replaceBlockIds<T>(node: T, blocks: ReadonlyMap<string, string>): T {
  if (typeof node === "string") return (blocks.get(node) ?? node) as T;
  if (Array.isArray(node)) return node.map((entry) => replaceBlockIds(entry, blocks)) as T;
  if (node !== null && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>).map(([name, entry]) => [name, replaceBlockIds(entry, blocks)]),
    ) as T;
  }
  return node;
}

/**
 * The names a scope answers for, as the spliced body reads them.
 *
 * `reads` is what a read of a spelling is read as — the argument a parameter
 * was made with, or the local a declaration was renamed to. `targets` is what
 * a write of a spelling is written under, which is a bare string in the IR
 * rather than a value: a `set`, a `step` and a `setElement` name what they
 * write, and a `let` names the slot it declares, so both maps travel together.
 */
export interface Scope {
  readonly reads: Map<string, SemanticValue>;
  readonly targets: Map<string, string>;
}

/** Whether a node of a walked tree is a block, which its own scope renames. */
function isBlockNode(node: unknown): node is SemanticBlock {
  return (
    typeof node === "object" &&
    node !== null &&
    !Array.isArray(node) &&
    "statements" in node &&
    "terminator" in node &&
    "releases" in node
  );
}

/**
 * Substitutes what a walked tree reads, without entering a block of it.
 *
 * A block is renamed by the walk that carries its own scope into it, so a
 * substitution that entered one would read the names of the scope outside it
 * and rewrite the block twice — the second time over reads the first had
 * already answered, some of which the block's own declarations shadow.
 */
function substituteShallow<T>(node: T, scope: Scope): T {
  if (isBlockNode(node)) return node;
  if (typeof node === "string") return (scope.targets.get(node) ?? node) as T;
  if (isValueNode(node) && node.k === "local") {
    const bound = scope.reads.get(node.name);
    if (bound !== undefined) return structuredClone(bound) as T;
  }
  if (Array.isArray(node)) return node.map((entry) => substituteShallow(entry, scope)) as T;
  if (node !== null && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>).map(([name, entry]) => [name, substituteShallow(entry, scope)]),
    ) as T;
  }
  return node;
}

/**
 * Substitutes what one statement reads, with the scope it reads it in.
 *
 * What the statement itself declares is left alone: the declaration is renamed
 * where it is made, after this has run, because a value it reads is read
 * before any declaration of its own answers — `let i = i + 1` reads the outer
 * one, and its own slot is written under a name of its own.
 */
function substituteStatement(statement: SemanticStatement, scope: Scope): void {
  if (statement.k === "let") {
    statement.value = substituteShallow(statement.value, scope);
    return;
  }
  if (statement.k === "loop") {
    const loop = statement.loop;
    if (loop.kind === "counted") {
      statement.loop = {
        ...loop,
        from: substituteShallow(loop.from, scope),
        to: substituteShallow(loop.to, scope),
        step: loop.step === null ? null : substituteShallow(loop.step, scope),
      };
    } else if (loop.kind === "each") {
      statement.loop = { ...loop, length: substituteShallow(loop.length, scope) };
    } else {
      statement.loop = { ...loop, condition: substituteShallow(loop.condition, scope) };
    }
    return;
  }
  blockStatement(statement, scope);
}

/** Every statement kind that neither declares nor carries a body of its own. */
function blockStatement(statement: SemanticStatement, scope: Scope): void {
  const rewritten = substituteShallow(statement, scope);
  if (rewritten !== statement) Object.assign(statement, rewritten);
}

/**
 * Renames every name a body declares, one binding at a time, in place.
 *
 * The body is the callee's own, already copied, and the scope it is handed
 * starts at its parameters: every read of one is read as the argument the call
 * was made with, and every write of one lands on the temporary that is the
 * copy. Each block is walked with the scope it is entered with, so a
 * declaration answers for the statements after it in the block and for the
 * blocks they carry, and is gone when the block ends; a loop's counter is
 * declared into a copy of the scope the body alone is renamed with, so it
 * never reaches the statement after the loop.
 *
 * A declaration whose spelling is already answered for in the scope it is made
 * in shadows it, and the answer is the refusal the caller reads: two bindings
 * under one spelling cannot both be renamed by one map, and a body that
 * shadows is left as a call.
 *
 * Exported because the recursion pass splices bodies the same way this does: a
 * body of a cycle of bodies is put inside a loop with the other bodies' turns
 * beside it, and two of them very often declare one spelling — the same
 * counter, the same temporary — and each of those is a binding of its own.
 */
export function renameBindings(block: SemanticBlock, scope: Scope, taken: Set<string>, callee: string): string | null {
  for (const statement of block.statements) {
    substituteStatement(statement, scope);
    // A loop's counter is declared for its body alone, so the body is renamed
    // with a copy of the scope and the block's own never holds it: the
    // statement after the loop reads whatever answered before the loop, and a
    // second loop counted by the same spelling is a binding of its own.
    const counting = statement.k === "loop" && statement.loop.kind !== "while" && statement.loop.kind !== "doWhile";
    const inner: Scope = counting ? { reads: new Map(scope.reads), targets: new Map(scope.targets) } : scope;
    const refused = declareStatement(statement, inner, taken, callee);
    if (refused !== null) return refused;
    for (const nested of statementBlocks(statement)) {
      const refused = renameBindings(nested, inner, taken, callee);
      if (refused !== null) return refused;
    }
  }
  if (block.terminator.k === "return" && block.terminator.value !== null) {
    block.terminator = { ...block.terminator, value: substituteShallow(block.terminator.value, scope) };
  } else {
    block.terminator = substituteShallow(block.terminator, scope);
  }
  block.releases = block.releases.map((name) => scope.targets.get(name) ?? name);
  return null;
}

/**
 * Renames the binding a statement declares, and answers for it in the scope.
 *
 * A `let` declares one slot; a counted loop one counter; a walk an index and
 * an element, each of its own. All of them are renamed where they are made and
 * answered for in the scope they are made in, and a spelling that is already
 * answered for there is the refusal the caller reads.
 */
function declareStatement(statement: SemanticStatement, scope: Scope, taken: Set<string>, callee: string): string | null {
  const declare = (spelling: string, type: SemanticType): string => {
    const renamed = freshName(taken, "inlined");
    scope.reads.set(spelling, { k: "local", type, name: renamed });
    scope.targets.set(spelling, renamed);
    return renamed;
  };
  const refuse = (spelling: string): string =>
    `${callee} declares "${spelling}" in a block of its own, which shadows another name of the function, and a name answers for one binding`;
  if (statement.k === "let") {
    const spelling = statement.slot.name;
    if (scope.reads.has(spelling) || scope.targets.has(spelling)) return refuse(spelling);
    statement.slot = { ...statement.slot, name: declare(spelling, slotType(statement.slot)) };
    return null;
  }
  if (statement.k === "loop") {
    const loop = statement.loop;
    if (loop.kind === "counted") {
      const spelling = loop.variable;
      if (scope.reads.has(spelling) || scope.targets.has(spelling)) return refuse(spelling);
      statement.loop = { ...loop, variable: declare(spelling, loop.type) };
      return null;
    }
    if (loop.kind === "each") {
      for (const spelling of [loop.index, loop.element]) {
        if (scope.reads.has(spelling) || scope.targets.has(spelling)) return refuse(spelling);
      }
      const index = declare(loop.index, { kind: "primitive", name: "usize" });
      const element = declare(loop.element, loop.elementType);
      statement.loop = { ...loop, index, element };
      return null;
    }
  }
  return null;
}

/**
 * Why a callee may not be put where its call was, or null when it may.
 *
 * Exported because it decides what lands inside an object, and `incremental.ts`
 * keys a caller on the bodies its object carries: a build folds every candidate
 * through `inlineCalls` before it lowers it, so a callee this answers null for is
 * a callee whose whole definition belongs in the caller's key, whatever
 * `semantics/calls.ts:strategyFor` decided about the call itself. The two rules
 * answer different questions and they do not agree — `strategyFor` refuses to
 * write out a callee that states what it returns, and this has no such rule — so
 * the key asks this one.
 */
export function inlineRefusal(callee: SemanticFunction): string | null {
  if (callee.entry.terminator.k !== "return") return "ends by leaving for another block, which is not this function's control flow";
  if (callee.allocates) return "allocates an object, whose ownership the blocks it is put into would have to account for";
  if (callee.prints) return "prints, which is an effect the contract of the function it is put into does not state";
  if (callee.readsArgv) return "reads the command line, which is an effect the contract of the function it is put into does not state";
  if (callee.effects.length > 0) return `has the effects ${callee.effects.join(", ")}, which the contract of the function it is put into does not state`;
  if (callee.calls.length > 0) return `calls ${callee.calls.map((edge) => edge.callee).join(", ")}, and inlining one call would put two of them there`;
  if (isReference(callee.returns)) return "hands back a reference, whose ownership the caller would have to take over";
  if (callee.entry.releases.length > 0) return "frees what it owns on the way out, which belongs to its own blocks";
  // A write is no longer refused. It used to be, and the reason was a real
  // defect: a `set`, a `step` and a `setElement` name what they write as a bare
  // string, and a substitution that only looked for values carried the callee's
  // own name into the caller's frame — the callee's local landed on a name the
  // caller had, and the value the caller read back was a write it never made.
  // The substitution now remaps those names beside the values, so an
  // accumulator — the commonest callee in a program written this way — is
  // inlinable rather than refused.
  // Only the entry block may end the function. A block nested inside the
  // callee that returns would return from the *caller* once its body is
  // spliced in, handing back the callee's value where the caller returns
  // nothing or returns something else — so `if (n > 2) { return 3; }` is a
  // body with nowhere to go.
  //
  // A jump is not the same problem, and the reason is that a jump names a loop
  // of its own: the two ways out of a block are the two ends of the loop the
  // block is written in, and every id a loop names is renamed when the body is
  // spliced in — header and exit together, so the jump still lands on the loop
  // it was written for. A `break` in a callee's own loop is therefore a `break`
  // in the caller's copy of that loop, which is the same control flow rather
  // than control flow the caller does not own. A jump whose target is not one
  // of them is not one the IR writes at all.
  const loops = new Set<string>();
  for (const block of nestedBlocks(callee.entry)) {
    for (const statement of block.statements) {
      if (statement.k !== "loop") continue;
      loops.add(statement.loop.header);
      loops.add(statement.loop.exit);
    }
  }
  for (const block of nestedBlocks(callee.entry)) {
    if (block === callee.entry) continue;
    if (block.terminator.k === "return") {
      return "returns from a block of its own, which would return from the function it is put into";
    }
    if (block.terminator.k === "jump" && !loops.has(block.terminator.target)) {
      return "leaves a block for another one, which is control flow the function it is put into does not own";
    }
  }
  return null;
}

/** Whether a body writes the name it was given, which is what a parameter is. */
function writesName(fn: SemanticFunction, name: string): boolean {
  for (const block of blocksOf(fn)) {
    for (const statement of block.statements) {
      const target =
        statement.k === "set" || statement.k === "step"
          ? statement.name
          : statement.k === "setElement"
            ? statement.buffer
            : null;
      if (target === name) return true;
    }
  }
  return false;
}

/**
 * An edge the body no longer makes is not one, whichever block made it. A call
 * is a call wherever it is written, and a return terminator is where a
 * function's own last call usually is: the edges are what the printed artifact
 * declares its callees from, so an edge dropped while a call is left in a
 * terminator is a function the compiler can no longer read back, and a rule
 * that legitimately applied is thrown away along with it.
 */
function dropUnusedEdge(fn: SemanticFunction, callee: string): void {
  let called = false;
  for (const block of blocksOf(fn)) {
    for (const value of blockValues([block])) {
      walkValues(value, (inner) => {
        if (inner.k === "call" && inner.call.callee === callee) called = true;
      });
    }
  }
  if (!called) fn.calls = fn.calls.filter((edge) => edge.callee !== callee);
}

/**
 * The callees a block calls, in the order they are first written in.
 *
 * A block is what decides whether a call may be put there, and every call a
 * block makes to one callee is one proposal — `inlineCall` writes all of them
 * under names of their own — so the calls are collected per block rather than
 * per function.
 */
function calleesInBlock(block: SemanticBlock): string[] {
  const names: string[] = [];
  for (const value of blockValues([block])) {
    walkValues(value, (inner) => {
      if (inner.k === "call" && !names.includes(inner.call.callee)) names.push(inner.call.callee);
    });
  }
  return names;
}

/**
 * Puts the body of every callee this function may inline where its call was.
 *
 * `inline-call` is the rule a review proposes, so it is written for a model to
 * name one site and read back a reason when that site does not hold. Here the
 * compiler asks the same question about every block on its own, and applies
 * the rewrite wherever the answer is yes — the callee's names renamed, its
 * blocks renamed beside them, and the call bound to what the callee hands
 * back. Nothing about the rewrite is different; what differs is who decided.
 *
 * This runs after a review and not inside one, so what a model is shown is the
 * IR the source resolved to and not an already-inlined rewrite of it. The
 * object is lowered from the inlined tree, and the text beside it is printed
 * from the same tree, so the artifact and the code are one thing.
 *
 * Only a callee that calls nothing itself is inlinable — `inlineRefusal`
 * refuses one that does, which is what keeps a recursive pair from being
 * spliced into itself — so a spliced body holds no call and each round
 * strictly removes one. The rounds are bounded by the calls the function was
 * written with, and the bound is here so a tree that breaks that assumption
 * costs a round instead of a build.
 */
export function inlineCalls(fn: SemanticFunction, context: RepairContext): SemanticFunction {
  let current = fn;
  for (let round = 0; round <= fn.calls.length; round += 1) {
    const inlined = inlineOnce(current, context);
    if (inlined === null) return current;
    current = inlined;
  }
  return current;
}

/**
 * The first call in the body whose callee may be put where it was written, as
 * a tree that call has been applied to, or null when the body has none.
 */
function inlineOnce(fn: SemanticFunction, context: RepairContext): SemanticFunction | null {
  for (const block of blocksOf(fn)) {
    for (const callee of calleesInBlock(block)) {
      const attempt = structuredClone(fn);
      const outcome = inlineCall(attempt, block.id, callee, context);
      if ("applied" in outcome) return outcome.applied;
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Sites, as a prompt states them                                             */
/* -------------------------------------------------------------------------- */

function loopDescription(loop: SemanticLoop): string {
  switch (loop.kind) {
    case "counted":
      return `a counted loop over ${loop.variable}`;
    case "each":
      return `a loop over the elements of ${loop.of}`;
    case "while":
      return "a while loop";
    default:
      return "a do-while loop";
  }
}

/**
 * Every block and loop of a function, as a proposal may name it. A review is
 * given this so that the site of a proposal is an id the IR prints, rather than
 * one a reader had to count out of the body.
 */
export function describeSites(fn: SemanticFunction): string[] {
  const loops = loopsOf(fn);
  const bodies = new Set(loops.map((entry) => entry.loop.body.id));
  const lines: string[] = loops.map((entry) => {
    const { loop, owner } = entry;
    return `loop ${loop.header}: ${loopDescription(loop)}, written in block ${owner.id}, leaves for block ${loop.exit}, body is block ${loop.body.id}`;
  });
  for (const block of blocksOf(fn)) {
    if (bodies.has(block.id)) continue;
    const where = block === fn.entry ? "the function body" : "a block inside it";
    lines.push(`block ${block.id}: ${where}, ${block.statements.length} statement(s)`);
  }
  return lines;
}

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
      "writing anything that value reads. A call, an allocation and a read of a name the loop writes are never " +
      "hoisted, because running one once instead of twice is not the same program.",
    args: [],
  },
  {
    name: "common-subexpression",
    summary: "Bind a value a block computes more than once to a name, and read the name instead.",
    applies:
      "Any block, named by its own id. The value must be computed at least twice in that block, must not call " +
      "anything, must not allocate, and must not read a name the block writes.",
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
      "A call written in the statements of the named block, not in one nested inside it. The callee must compute " +
      "a result and do nothing else: no call of its own, no allocation, no printing, no reading of the command " +
      "line, no ownership to hand back, and no block left for anything but the next one.",
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
  | { readonly applied: SemanticFunction; readonly note: string }
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
function freshName(taken: Set<string>, prefix: string): string {
  for (let index = 1; ; index += 1) {
    const name = `${prefix}${index}`;
    if (!taken.has(name)) {
      taken.add(name);
      return name;
    }
  }
}

function declaredNames(block: SemanticBlock): string[] {
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

function hasCall(value: SemanticValue): boolean {
  let called = false;
  walkValues(value, (inner) => {
    if (inner.k === "call") called = true;
  });
  return called;
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
function isBindable(value: SemanticValue): boolean {
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
 *
 * Everything else here is arithmetic on values already in hand, a comparison,
 * or a choice between two of them, and a choice is as lazy as it was.
 */
function isSafeToCompute(value: SemanticValue): boolean {
  switch (value.k) {
    case "element":
    case "loadField":
    case "length":
      return false;
    case "arith": {
      if (value.op !== "div" && value.op !== "mod") return isSafeToCompute(value.left) && isSafeToCompute(value.right);
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

/** The slot a computed value is bound to, which is what its own type asks for. */
export function slotFor(value: SemanticValue, name: string): SemanticSlot {
  if (isTextType(value.type)) return { kind: "text", name, mutable: false };
  if (isReference(value.type)) return { kind: "object", name, mutable: false, type: value.type };
  return { kind: "value", name, mutable: false, type: value.type };
}

/** A type, as a diagnostic names it. */
function typeLabel(type: SemanticType): string {
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
function substituteLocals<T>(node: T, bindings: ReadonlyMap<string, SemanticValue>, writes: ReadonlyMap<string, string> = new Map()): T {
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
    case "retain":
    case "storeField":
      return [statement.value];
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
  const repeated = repeatedValues(region, writtenIn(region, true));

  if (repeated.size === 0) {
    return {
      refused: `has a body that computes nothing more than once, or everything it computes twice changes in it, so there is nothing to hoist out of it`,
    };
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
  const block = blockAt(fn, site);
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
    return { refused: `computes nothing more than once, or what it computes twice is not the same value, so there is nothing to bind` };
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
  const block = blockAt(fn, site);
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

/** A call a statement makes in its own right, with the statement that makes it. */
interface FoundCall {
  readonly statement: SemanticStatement;
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

/** The call a statement makes to a callee in its own right, with its statement. */
interface FoundCall {
  readonly statement: SemanticStatement;
  readonly call: SemanticCall;
}

function callIn(statement: SemanticStatement, callee: string): FoundCall | null {
  if (statement.k === "call") {
    return statement.call.callee === callee ? { statement, call: statement.call } : null;
  }
  for (const value of statementValues(statement)) {
    const call = callValueIn(value, callee);
    if (call !== null) return { statement, call };
  }
  return null;
}

function inlineCall(fn: SemanticFunction, site: string, calleeName: string, context: RepairContext): RepairOutcome {
  const block = blockAt(fn, site);
  if (block === null) return { refused: `cannot be written into block ${site}: there is no such block, and the blocks are ${blockNames(fn)}` };
  const callee = context.functions.get(calleeName);
  if (callee === undefined) {
    const names = [...context.functions.keys()].join(", ");
    return { refused: `${calleeName} is not a function of this program: the program has ${names}` };
  }

  const refusal = inlineRefusal(callee);
  if (refusal !== null) return { refused: `${calleeName} ${refusal}` };

  // A block hands its value back from its terminator as often as from a
  // statement, so the call this rule inlines may be written in either.
  const written = block.statements
    .map((statement) => callIn(statement, calleeName))
    .filter((entry): entry is FoundCall => entry !== null);
  const returned = block.terminator.k === "return" ? callValueIn(block.terminator.value, calleeName) : null;
  if (written.length === 0 && returned === null) return { refused: `${calleeName} is not called in block ${site}` };
  if (written.length + (returned === null ? 0 : 1) > 1) {
    return { refused: `${calleeName} is called more than once in block ${site}, so no single one of them is named` };
  }

  const call = written[0]?.call ?? (returned as SemanticCall);
  const statement = written[0]?.statement ?? null;
  const line = statement?.line ?? 0;
  if (statement !== null && statement.k === "call" && callee.returns.kind !== "void") {
    return { refused: `${calleeName} returns ${typeLabel(callee.returns)} and is called here only for what it does, so inlining it would bind a result to a name nothing reads` };
  }
  if (call.args.some((argument) => hasCall(argument))) {
    return { refused: `${calleeName} is called with an argument that is itself a call, which would be evaluated after the body inlined in front of it` };
  }

  const taken = slotNames(fn);
  // Every name the callee declares is renamed into this function, and its
  // parameters become the arguments the call was made with, so nothing it was
  // written as can be read here as something of this function's.
  const types = slotTypesOf(callee);
  const bindings = new Map<string, SemanticValue>();
  // What each name the callee writes is written under here. A local is renamed
  // like any other name, so its writes follow it. A parameter is a different
  // matter: a parameter is a *copy* of the argument, so a write to one must
  // never land on the name the caller passed. `const y = bump(x)` with
  // `bump` writing `x` leaves the caller's `x` at what it was, and a write that
  // reached through would answer 12 where the source answers 11. A written
  // parameter is therefore bound to a temporary of its own, which is the copy
  // the callee was given.
  const writes = new Map<string, string>();
  const before: SemanticStatement[] = [];
  callee.params.forEach((param, index) => {
    const argument = call.args[index];
    if (argument === undefined) return;
    bindings.set(param.name, structuredClone(argument));
    if (!writesName(callee, param.name)) return;
    const name = freshName(taken, "inlined");
    const slot = slotFor(argument, name);
    before.push({ k: "let", slot, value: structuredClone(argument), line });
    bindings.set(param.name, { k: "local", type: slotType(slot), name });
    writes.set(param.name, name);
  });
  for (const inner of nestedBlocks(callee.entry)) {
    for (const name of declaredNames(inner)) {
      if (bindings.has(name)) continue;
      const renamed = freshName(taken, "inlined");
      bindings.set(name, { k: "local", type: types.get(name) ?? { kind: "primitive", name: "f64" }, name: renamed });
      writes.set(name, renamed);
    }
  }

  // A block id is a name like any other, and the callee's are its own: its
  // loop body is very often also called `b2`, which is the name the caller's
  // own loop body has. Two blocks under one id is a function the compiler
  // cannot read back, so the callee's blocks are renamed beside everything
  // else it brought with it.
  const blocks = new Map<string, string>();
  for (const inner of nestedBlocks(callee.entry)) {
    if (inner.id !== callee.entry.id) blocks.set(inner.id, `inlined_${freshName(taken, "block")}`);
  }
  // The block ids are renamed by a walk of the whole statement rather than by
  // picking the ones a loop names: a jump target, a loop's own header and exit
  // and the block a nested statement carries are all just strings, and each is
  // the callee's own spelling.
  const spliced = callee.entry.statements.map((entry) =>
    replaceBlockIds(substituteLocals(entry, bindings, writes), blocks) as SemanticStatement,
  );
  const handsBack = callee.entry.terminator.k === "return" ? callee.entry.terminator.value : null;
  const result = handsBack === null ? null : substituteLocals(handsBack, bindings, writes);
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
    const rewritten = temp === null ? null : replaceValues(statement, atCall({ k: "call", type: call.returns, call }));
    block.statements.splice(at, 1, ...added, ...(rewritten === null ? [] : [rewritten]));
  } else {
    block.statements.push(...added);
    if (temp !== null && block.terminator.k === "return") {
      const callNode = { k: "call" as const, type: call.returns, call };
      block.terminator = { ...block.terminator, value: replaceValues(block.terminator.value, atCall(callNode)) };
    }
  }
  dropUnusedEdge(fn, calleeName);
  return {
    applied: fn,
    note: `inlined ${calleeName} into ${site}${result === null ? "" : " and bound what it returns"}`,
  };
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
function replaceBlockIds<T>(node: T, blocks: ReadonlyMap<string, string>): T {
  if (typeof node === "string") return (blocks.get(node) ?? node) as T;
  if (Array.isArray(node)) return node.map((entry) => replaceBlockIds(entry, blocks)) as T;
  if (node !== null && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>).map(([name, entry]) => [name, replaceBlockIds(entry, blocks)]),
    ) as T;
  }
  return node;
}

/** Every slot a function has, by name, as the type it is read as. */
function slotTypesOf(fn: SemanticFunction): Map<string, SemanticType> {
  const types = new Map<string, SemanticType>();
  for (const param of fn.params) types.set(param.name, slotType(param));
  for (const block of nestedBlocks(fn.entry)) {
    for (const statement of block.statements) {
      if (statement.k === "let") types.set(statement.slot.name, slotType(statement.slot));
    }
  }
  return types;
}

/** Why a callee may not be put where its call was, or null when it may. */
function inlineRefusal(callee: SemanticFunction): string | null {
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
  for (const block of nestedBlocks(callee.entry)) {
    if (block.terminator.k === "jump") return "leaves a block for another one, which is control flow the function it is put into does not own";
  }
  return null;
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

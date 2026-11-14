/**
 * The check that a semantic IR program is a program, and that a function is a
 * function.
 *
 * Everything a backend needs is stated in the IR, so everything a backend
 * would otherwise read wrongly is worth refusing here: a jump to a block that
 * does not exist, an argument passed as a type the callee does not take, a
 * name that is not a plain identifier, an arm a backend would write twice, a
 * field read from an object no layout has. The problems are collected rather
 * than thrown one at a time, so one run of the compiler says everything that is
 * wrong with a program, in the order the program is written.
 *
 * A function's body is a program body's tree of blocks, read from the
 * function's own lowering rather than from a source file, and the rules below
 * read the two the same way: a function is checked by the eight groups a
 * program is checked by, plus what only a function has — a return that hands
 * back the type the signature declares, a parameter the body reads as the
 * signature declares it, an object the body builds for its caller, and the
 * conditions the contract holds the function to.
 *
 * Nothing here may see a target. A rule that could only be written in terms of
 * a register or a stack offset is a rule this module has to refuse to state.
 *
 * The contract is optional because the IR is what a backend reads, and the IR
 * names no effect and no layout of its own. Given a contract, what a call says
 * it does is checked against what the contract says it does; without one, an
 * effect may only be checked for being a word the contract language uses.
 */

import { CompilerError } from "../core/errors.ts";
import type { Effect, FileContract, FunctionContract, FunctionSignature, ObjectLayout, ProgramContract, TypeExpr } from "../core/types.ts";
type ProgramContractFile = FileContract;
import {
  convertibleTo,
  elementTypeOf,
  commonNumber,
  hasCall,
  isBoolean,
  isFloat,
  isInteger,
  isNumber,
  isReference,
  isSemanticType,
  isSequence,
  isTextType,
  localNames,
  slotType,
  statementBlocksOf,
  isWideType,
  TEXT,
  UNSTATED_LINE,
  typeEquals,
  typeText,
  walkValues,
} from "../core/semantic-ir.ts";
import type {
  SemanticBlock,
  SemanticCall,
  SemanticFunction,
  SemanticLoop,
  SemanticModule,
  SemanticProgram,
  SemanticSlot,
  SemanticStatement,
  SemanticType,
  SemanticValue,
} from "../core/semantic-ir.ts";
import { builtinFor } from "./builtins.ts";
import { cMemberName } from "../toolchain/c-names.ts";
import { contractText, parseType } from "./contract.ts";
import { reductionsFor, refusalFor, type Callees } from "./parallel.ts";
import { refusalFor as regionRefusalFor } from "./region.ts";

function fieldOf(value: unknown, key: string): any {
  return (value as Record<string, unknown>)[key];
}

function setFieldOn(value: unknown, key: string, next: unknown): void {
  (value as Record<string, unknown>)[key] = next;
}

/* -------------------------------------------------------------------------- */
/* Tables                                                                     */
/* -------------------------------------------------------------------------- */

/** The ways a block may end. A block that ends in none of them ends nowhere. */
const TERMINATOR_KINDS: Record<string, true> = { next: true, return: true, jump: true, unreachable: true };

/**
 * Whether a block's last statement is one that leaves whatever its test says:
 * an `if` with an arm on each side and each arm leaving, or a `raise`. It is
 * the proof a block ending where nothing arrives has to carry, so that the
 * claim is checked here rather than trusted from the text that made it.
 */
function endsByLeaving(block: SemanticBlock): boolean {
  const statements = fieldOf(block, "statements") as readonly SemanticStatement[];
  const last = statements[statements.length - 1];
  if (last === undefined) return false;
  if (last.k === "raise") return true;
  if (last.k === "loop" && (fieldOf(last, "loop") as SemanticLoop).kind === "while" && fieldOf(fieldOf(last, "loop"), "neverExits") === true) {
    return true;
  }
  const otherwise = fieldOf(last, "otherwise") as SemanticBlock | null;
  if (last.k !== "if" || otherwise === null) return false;
  const thenBlock = fieldOf(last, "then") as SemanticBlock;
  return String(fieldOf(fieldOf(thenBlock, "terminator"), "k")) !== "next" && String(fieldOf(fieldOf(otherwise, "terminator"), "k")) !== "next";
}

/** The effects a call may say it has, as the contract language names them. */
const EFFECT_NAMES: Record<Effect, true> = {
  memory: true,
  io: true,
  filesystem: true,
  network: true,
  syscall: true,
  random: true,
  clock: true,
  panic: true,
  exception: true,
  atomic: true,
};

/** A name the IR is allowed to carry: an identifier, and nothing else. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The operations that are on whole numbers and yield one. */
const WHOLE_OPERATIONS: Record<string, true> = {
  mod: true,
  floorDiv: true,
  floorMod: true,
  shl: true,
  shr: true,
  ushr: true,
  and: true,
  or: true,
  xor: true,
};

/**
 * The arithmetic a wide number has, which is the arithmetic its kernel has.
 *
 * The kernel defines an add, a subtraction, a product, a quotient, a remainder,
 * the logical operations, the shifts and the comparisons, and nothing else. A
 * power is not there, and an IR that carried one would reach a backend with no
 * instruction and no declaration for it: the C backend would write the C
 * operator over a struct and produce a source that does not compile, and the
 * machine backend would have nothing to emit.
 *
 * The quotient and the remainder are `blaze_rt_u256_div` and `blaze_rt_u256_mod`,
 * restoring division over the four limbs. They were refused here until the
 * kernel grew them, and the refusal is what this list is: a divide was a
 * `u256` operation the compiler had no answer for rather than one it declined
 * to compute.
 *
 * Refusing here is what makes the rest unreachable. The validator is the last
 * thing that runs before a backend is handed the tree, so a program that needs
 * one of the missing operations is told which is missing rather than carried to
 * a target that cannot answer it.
 */
const WIDE_ARITHMETIC: ReadonlySet<string> = new Set([
  "add",
  "sub",
  "mul",
  "div",
  "mod",
  "and",
  "or",
  "xor",
  "shl",
  "shr",
]);

/**
 * The operations whose second operand is a count rather than a value of the
 * type being operated on.
 *
 * A shift is the one operation where that is true by definition rather than by
 * accident: `a u256` moved by `a u256` bits is not a number, and the count is
 * the machine word the source wrote the shift by. It is the only place a wide
 * number is allowed a narrower number beside it.
 */
const COUNTED_OPERATIONS: ReadonlySet<string> = new Set(["shl", "shr"]);

/**
 * What is wrong with pairing a wide number with a narrower one, or null when
 * nothing is.
 *
 * The kernel the wide number is answered by takes two of them, and every
 * backend lowers a wide operation to a call into it — the C backend to a
 * `blaze_u256` compound value, the machine backend to four limb registers. A
 * narrower operand has no such form: the C backend writes a cast from a scalar
 * to a struct, which is a source that does not compile, and the machine backend
 * asks for the single-register width a wide number does not have. Neither is a
 * lowering, so a pair like that is refused here rather than carried to a target
 * that cannot answer it — the same place, and for the same reason, as the
 * operation a wide number does not have at all.
 *
 * A whole number the compiler can read is the one narrower value a pair is
 * admitted with: it is the widening, which every backend answers with the same
 * one machine word in the low limb, and the value is in the wide number's range
 * because the compiler is the one holding it. A whole number it cannot read —
 * a name, a parameter, a call — is not, for the reason the validator's own
 * widening rule gives.
 */
function widePairProblem(left: SemanticValue, right: SemanticValue, result: SemanticType, counted: boolean): string | null {
  if (!isWideType(left.type) && !isWideType(right.type) && !isWideType(result)) return null;
  if (!isWideType(result)) {
    return `a ${typeText(left.type)} and a ${typeText(right.type)} are read as a ${typeText(result)}, and a wide number is not a machine word`;
  }
  // The left side is the value being operated on and the right one is the
  // value it is operated with, except in a shift, where the right one is a
  // count of bits: that is the machine word the source wrote the shift by, and
  // it is the one narrower number a wide number may be beside.
  if (counted) {
    // A shift count is the machine word the source wrote the shift by, and the
    // kernel takes one word of it: a count that is itself a wide number is a
    // count of 256 bits, which every target truncates to a different answer.
    if (isWideType(right.type)) {
      return `a ${typeText(left.type)} is shifted by a ${typeText(right.type)}, and a shift count is the machine word the source wrote the shift by`;
    }
    if (isWideType(left.type)) return null;
  }
  if (isWideType(left.type) && (isWideType(right.type) || wholeLiteral(right))) return null;
  if (isWideType(right.type) && wholeLiteral(left)) return null;
  const narrow = isWideType(left.type) ? right.type : left.type;
  const wide = isWideType(left.type) ? left.type : right.type;
  return `a ${typeText(narrow)} is computed with a ${typeText(wide)}, and the kernel every backend answers a wide number with is over two of them`;
}

/** A whole number written as its digits, which is the one widening there is. */
function wholeLiteral(value: SemanticValue): boolean {
  return value.k === "const" && isInteger(value.type) && WHOLE_TEXT.test(value.text);
}

/* -------------------------------------------------------------------------- */
/* What a body is checked against                                              */
/* -------------------------------------------------------------------------- */

/**
 * What a rule about a body looks a name up in: the layouts the body allocates
 * an object by, the functions it may call, and the contract, when the caller
 * has one. A program holds every layout of every function of the program; a
 * function holds the layouts its own body writes, and — the callee universe is
 * null when nothing declares one — a function checked on its own is not
 * refused a call it cannot resolve, because the file it is in is not the whole
 * program.
 */
interface Context {
  /** The layouts the IR itself carries, as `Object1` and the rest. */
  objects: Record<string, ObjectLayout>;
  /** Every function this body may call, or null where nothing declares them. */
  functions: FunctionSignature[] | null;
  /**
   * Every function of the program as the IR holds it, by name, which is what a
   * loop marked parallel is proved against. A call to a name this does not hold
   * is a call whose body nobody has read, and a parallel loop may not make one.
   */
  callees: Callees;
  /** The whole program contract, where the caller has one. */
  contract?: ProgramContract;
  /** The names the body itself declares, which no other body declares. */
  declared: string[];
}

/**
 * The body being checked: the block it starts in and the tree of blocks written
 * in it. A program body and a function body have the same shape, so one set of
 * rules reads both. What differs is what the body is called in a message, and
 * whether it has one end: a program ends once, in its entry block, while a
 * function may hand back a value from an arm of the body.
 */
interface Body {
  /** The block the body starts in. */
  entry: SemanticBlock;
  tree: Tree;
  /** What a block of this body is a way out of, as a message names it. */
  subject: string;
  /** The body itself, as a message names it. */
  own: string;
  /** True when the body has one end, which is the one its entry block ends in. */
  single: boolean;
}

/** What a program body is checked against: everything the program holds. */
function programContext(program: SemanticProgram, callees: Callees, contract?: ProgramContract): Context {
  return { objects: fieldOf(program, "objects") as Record<string, ObjectLayout>, functions: fieldOf(program, "functions") as unknown as FunctionSignature[], callees, contract, declared: [] };
}

/** What a function body is checked against: what the function itself holds. */
function functionContext(fn: SemanticFunction, callees: Callees, program?: ProgramContract): Context {
  return {
    objects: fieldOf(fn, "objects") as Record<string, ObjectLayout>,
    functions: program === undefined ? null : signaturesOf(program),
    callees,
    contract: program,
    declared: [String(fieldOf(fn, "name")), String(fieldOf(fn, "symbol")), ...(fieldOf(fn, "params") as readonly { name: string }[]).map((param) => String(fieldOf(param, "name")))],
  };
}

/** Every signature the program contract declares, in the order it declares them. */
function signaturesOf(program: ProgramContract): FunctionSignature[] {
  const signatures: FunctionSignature[] = [];
  for (const file of fieldOf(program, "files") as readonly { functions: Record<string, { function: FunctionSignature }> }[]) {
    for (const declared of Object.values(fieldOf(file, "functions") as Record<string, { function: FunctionSignature }>)) signatures.push(fieldOf(declared, "function") as FunctionSignature);
  }
  return signatures;
}

/** A program body, read as a body of its own. */
function programBody(program: SemanticProgram, tree: Tree): Body {
  return { entry: fieldOf(program, "entry") as SemanticBlock, tree, subject: "a program", own: "the program", single: true };
}

/** A function body, read as a body of its own. */
function functionBody(entry: SemanticBlock, tree: Tree): Body {
  return { entry, tree, subject: "a function", own: "the function", single: false };
}

/* -------------------------------------------------------------------------- */
/* Reading a body as a tree                                                   */
/* -------------------------------------------------------------------------- */

/** A loop, with the block a `break` leaves it for. */
interface LoopFrame {
  loop: SemanticLoop;
  /** The block the loop statement is written in. */
  container: SemanticBlock;
  /** The body of the loop, which a jump written in it leaves as well. */
  body: PlacedBlock | null;
}

/** The names a block's statements may read, and what those names hold. */
interface Scope {
  /** The slot every readable name holds. */
  slots: Map<string, SemanticSlot>;
  /** Every name readable here. */
  visible: Set<string>;
}

/** A block, with where it is written and what it may read. */
interface PlacedBlock {
  block: SemanticBlock;
  /** The loops this one is written in, outermost first. */
  loops: LoopFrame[];
  /** The names the block declares itself, in the order it declares them. */
  own: string[];
  /** The slot each of those names holds. */
  /** The block this one is written in, or null for the body of the program. */
  parent: PlacedBlock | null;
  /** What the block's terminator may read, once its own statements are done. */
  final: Scope;
  /**
   * True when reaching this block is a choice the body makes: an arm of an
   * `if`, the body of a loop, or a block written inside one of those. A return
   * written in such a block is an early return, and the block around it still
   * has a way through that does not return.
   */
  guarded: boolean;
  /** How many statements the block around this one writes after this one. */
  rest: number;
}

/** A loop that can carry a mark: the two kinds the runtime runs a turn of. */
type MarkedLoop = Extract<SemanticLoop, { kind: "counted" | "each" }>;

/** A statement, with the block it is written in and what that block may read. */
interface PlacedStatement {
  statement: SemanticStatement;
  block: PlacedBlock;
  /** What may be read where the statement is written. */
  scope: Scope;
}

/** Every block and statement of a body, in the order they are written. */
interface Tree {
  blocks: PlacedBlock[];
  statements: PlacedStatement[];
  /** Every loop the program holds, once each. */
  loops: LoopFrame[];
}

/**
 * Where a message is written, so a message names the block and the line. A
 * statement that states no line of the source is named by its block alone,
 * which is as much as there is to name it by.
 */
function label(blockId: string, line?: number): string {
  return line === undefined || line === UNSTATED_LINE ? `${blockId}: ` : `${blockId}: line ${line}: `;
}

/** The slot a loop names itself, which the loop body reads but no `let` declares. */
function loopSlots(loop: SemanticLoop): SemanticSlot[] {
  if (loop.kind === "counted") {
    return [{ kind: "value", name: loop.variable, mutable: true, type: loop.type }];
  }
  if (loop.kind === "each") {
    return [
      { kind: "value", name: loop.index, mutable: true, type: { kind: "primitive", name: "usize" } },
      { kind: "value", name: loop.element, mutable: false, type: loop.elementType },
    ];
  }
  return [];
}

/** A scope with one more name declared in it. */
function declaring(scope: Scope, slot: SemanticSlot): Scope {
  const slotName = String(fieldOf(slot, "name"));
  const slots = new Map(fieldOf(scope, "slots") as Map<string, SemanticSlot>);
  slots.set(slotName, slot);
  const visible = new Set(fieldOf(scope, "visible") as Set<string>);
  visible.add(slotName);
  return { slots, visible };
}

/** A scope with the names a loop hands its body added, which the body never frees. */
function innerScope(scope: Scope, slots: SemanticSlot[]): Scope {
  if (slots.length === 0) return scope;
  const inner = new Map(fieldOf(scope, "slots") as Map<string, SemanticSlot>);
  const visible = new Set(fieldOf(scope, "visible") as Set<string>);
  for (const slot of slots) {
    const slotName = String(fieldOf(slot, "name"));
    inner.set(slotName, slot);
    visible.add(slotName);
  }
  return { slots: inner, visible };
}

/**
 * One block and everything written in it, each block placed in the loops
 * around it and holding the names it may read. `rest` is how much the block
 * around this one writes after it and `guarded` is whether reaching it at all
 * is a choice the body makes, which is what tells an early return from a
 * return that ends the body.
 */
function walkBlock(
  block: SemanticBlock,
  loops: LoopFrame[],
  scope: Scope,
  tree: Tree,
  parent: PlacedBlock | null = null,
  guarded = false,
  rest = 0,
): PlacedBlock {
  const placed: PlacedBlock = { block, loops, own: [], parent, final: scope, guarded, rest };
  

  let current = scope;
  const statements = fieldOf(block, "statements") as readonly SemanticStatement[];
  const treeStatements = fieldOf(tree, "statements") as { statement: SemanticStatement; block: PlacedBlock; scope: Scope }[];
  const treeBlocks = fieldOf(tree, "blocks") as PlacedBlock[];
  const treeLoops = fieldOf(tree, "loops") as LoopFrame[];
  treeBlocks[treeBlocks.length] = placed;
  for (let at = 0; at < statements.length; at += 1) {
    const statement = statements[at];
    treeStatements[treeStatements.length] = { statement, block: placed, scope: current };
    if (statement.k === "let") {
      const slot = fieldOf(statement, "slot") as SemanticSlot;
      current = declaring(current, slot);
      (fieldOf(placed, "own") as string[])[(fieldOf(placed, "own") as string[]).length] = String(fieldOf(slot, "name"));
      continue;
    }
    const after = statements.length - at - 1;
    if (statement.k === "if") {
      walkBlock(fieldOf(statement, "then") as SemanticBlock, loops, current, tree, placed, true, after);
      const otherwise = fieldOf(statement, "otherwise") as SemanticBlock | null;
      if (otherwise !== null) {
        walkBlock(otherwise, loops, current, tree, placed, true, after);
      }
      continue;
    }
    if (statement.k === "block") {
      walkBlock(fieldOf(statement, "body") as SemanticBlock, loops, current, tree, placed, guarded, after);
      continue;
    }
    if (statement.k === "loop") {
      const loop = fieldOf(statement, "loop") as SemanticLoop;
      const frame: LoopFrame = { loop, container: block, body: null };
      treeLoops[treeLoops.length] = frame;
      const nextLoops: LoopFrame[] = [];
      for (const one of loops) nextLoops[nextLoops.length] = one;
      nextLoops[nextLoops.length] = frame;
      frame.body = walkBlock(
        fieldOf(loop, "body") as SemanticBlock,
        nextLoops,
        innerScope(current, loopSlots(loop)),
        tree,
        placed,
        true,
        after,
      );
    }
  }
  setFieldOn(placed, "final", current);

  return placed;
}

/** The whole program as a tree, each block placed in the blocks around it. */
function readTree(program: SemanticProgram): Tree {
  const tree: Tree = { blocks: [], statements: [], loops: [] };
  walkBlock(fieldOf(program, "entry") as SemanticBlock, [], { slots: new Map(), visible: new Set() }, tree, null, false, 0);
  return tree;
}

/**
 * A function's body as a tree, with the parameters already declared: a
 * parameter is a name the body reads that no `let` of the body declares, so
 * the rules about names are the rules a program is checked by.
 */
function readFunctionTree(fn: SemanticFunction, entry: SemanticBlock): Tree {
  const tree: Tree = { blocks: [], statements: [], loops: [] };
  walkBlock(entry, [], innerScope({ slots: new Map(), visible: new Set() }, fieldOf(fn, "params") as SemanticSlot[]), tree, null, false, 0);
  return tree;
}

/** The name a body hands its caller back, where it hands back a name at all. */
function returnedName(value: SemanticValue | null): string | null {
  if (value === null) return null;
  return value.k === "local" ? String(fieldOf(value, "name")) : null;
}

/**
 * Every value a statement computes, in the order the statement writes them.
 *
 * This is the validator's own list rather than the shared one in
 * `core/semantic-ir.ts`, and it answers a different question: it is what the
 * rules below have to reach, so a value a statement computes and this omits is
 * a value no rule reads at all. `fill` writes one and `call` writes its
 * arguments, and both were missing — which left the value of a fill, every
 * name it mentions and every call written into an argument outside the scope
 * check, the type check, the call rules and the effect rules.
 */
function statementValues(statement: SemanticStatement): SemanticValue[] {
  switch (statement.k) {
    case "let":
    case "set":
    case "printText":
    case "printNumber":
    case "retain":
    case "fill":
      return [fieldOf(statement, "value") as SemanticValue];
    case "raise":
      return [fieldOf(statement, "message") as SemanticValue];
    case "setElement":
      return [fieldOf(statement, "index") as SemanticValue, fieldOf(statement, "value") as SemanticValue];
    case "if":
      return [fieldOf(statement, "condition") as SemanticValue];
    case "storeField":
      return [fieldOf(statement, "object") as SemanticValue, fieldOf(statement, "value") as SemanticValue];
    case "call": {
      // The arguments are what the call is made of, and a call written into one
      // is a call the body makes. The call itself is checked where it is
      // written rather than here, so it is not listed again.
      const call = fieldOf(statement, "call") as SemanticCall;
      const args = fieldOf(call, "args") as readonly SemanticValue[];
      const values: SemanticValue[] = [];
      for (const one of args) values.push(one);
      return values;
    }
    case "loop": {
      const loop = fieldOf(statement, "loop") as SemanticLoop;
      if (loop.kind === "while" || loop.kind === "doWhile") return [fieldOf(loop, "condition") as SemanticValue];
      if (loop.kind === "counted") {
        const from = fieldOf(loop, "from") as SemanticValue;
        const to = fieldOf(loop, "to") as SemanticValue;
        const step = fieldOf(loop, "step") as SemanticValue | null;
        return step === null ? [from, to] : [from, to, step];
      }
      return [fieldOf(loop, "length") as SemanticValue];
    }
    default:
      return [];
  }
}

/** Every call a statement makes, the statement's own call last. */
function statementCalls(statement: SemanticStatement): SemanticCall[] {
  const calls: SemanticCall[] = [];
  for (const value of statementValues(statement)) {
    walked(value, (inner) => {
      if (inner.k === "call") calls.push(fieldOf(inner, "call") as SemanticCall);
    });
  }
  if (statement.k === "call") calls.push(fieldOf(statement, "call") as SemanticCall);
  return calls;
}

/**
 * Every value a statement's values are made of, the fields of an object being
 * built among them: the fields are values of their own and a call written into
 * one is a call the body makes. `walkValues` descends into them, so this is
 * the shared walk and nothing more — walking them here as well would report
 * what is inside a field twice.
 */
function walked(value: SemanticValue, visit: (value: SemanticValue) => void): void {
  walkValues(value, visit);
}

/** The type a sequence holds elements of, or null for anything else. */

/* -------------------------------------------------------------------------- */
/* Rule 1: structure                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The shape of a body: one entry, one way out of every block, and no block a
 * jump names that the body does not hold. What a block may end in is the same
 * for a program and for a function; what differs is the one end a program has
 * and a function does not, and the name of the body a message is written for.
 */
function structureProblems(body: Body): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const tree = fieldOf(body, "tree") as Tree;
  const treeBlocks = fieldOf(tree, "blocks") as readonly PlacedBlock[];

  for (const placed of treeBlocks) {
    const block = fieldOf(placed, "block") as SemanticBlock;
    const blockId = String(fieldOf(block, "id"));
    if (ids.has(blockId)) {
      problems.push(`${label(blockId, undefined)}the block id is used by more than one block`);
      continue;
    }
    ids.add(blockId);
  }

  // The entry block of a program is the one block the IR names, so that a model
  // writing a program back out writes the same program. A function's blocks are
  // named by the lowering that wrote them, and the function is named instead.
  const entry = fieldOf(body, "entry") as SemanticBlock;
  const entryId = String(fieldOf(entry, "id"));
  if (fieldOf(body, "single") === true && entryId !== "entry") {
    problems.push(`entry: the program's entry block is "${entryId}" rather than entry`);
  }

  const headers = new Set<string>();
  for (const frame of fieldOf(tree, "loops") as readonly LoopFrame[]) {
    headers.add(String(fieldOf(fieldOf(frame, "loop"), "header")));
  }

  for (const placed of treeBlocks) {
    const block = fieldOf(placed, "block") as SemanticBlock;
    const blockId = String(fieldOf(block, "id"));
    const where = label(blockId, undefined);
    const terminator = fieldOf(block, "terminator") as SemanticBlock["terminator"];
    const isEntry = block === entry;
    const terminatorKind = String(fieldOf(terminator, "k"));
    if (TERMINATOR_KINDS[terminatorKind] !== true) {
      problems.push(`${where}the block ends in nothing ${String(fieldOf(body, "subject"))} may end in`);
      continue;
    }
    if (terminatorKind === "return" && fieldOf(body, "single") === true && !isEntry) {
      problems.push(`${where}only the entry block ends ${String(fieldOf(body, "own"))}`);
    }
    if (terminatorKind === "unreachable" && !endsByLeaving(block)) {
      // A block that ends where nothing arrives is a claim, and a claim a model
      // or a person writes into IR text is proved here rather than believed:
      // something in the block has to leave, or control does continue past it
      // and the block is ordinary.
      problems.push(`${where}the block ends where nothing arrives, but nothing in it leaves`);
      continue;
    }
    if (terminatorKind === "jump") {
      const target = String(fieldOf(terminator, "target"));
      if (!ids.has(target) && !headers.has(target)) {
        problems.push(`${where}jumps to ${target}, which is not a block of the program`);
      }
    }
  }

  return problems;
}

/* -------------------------------------------------------------------------- */
/* Rule 2: control flow                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The only two ways out of a loop are the only two jumps a program may make: a
 * `continue` back to the header the loop is written in, and a `break` to the
 * block the loop is written in. A body that always breaks is a loop that runs
 * once, which is a language the source allows, so nothing here asks a body to
 * reach its header.
 */
function controlFlowProblems(tree: Tree): string[] {
  const problems: string[] = [];

  for (const placed of fieldOf(tree, "blocks") as readonly PlacedBlock[]) {
    const block = fieldOf(placed, "block") as SemanticBlock;
    const terminator = fieldOf(block, "terminator") as SemanticBlock["terminator"];
    if (String(fieldOf(terminator, "k")) !== "jump") continue;
    const target = String(fieldOf(terminator, "target"));
    let continues = false;
    let breaks = false;
    for (const frame of fieldOf(placed, "loops") as readonly LoopFrame[]) {
      if (String(fieldOf(fieldOf(frame, "loop"), "header")) === target) continues = true;
      if (String(fieldOf(fieldOf(frame, "container"), "id")) === target) breaks = true;
    }
    if (!continues && !breaks) {
      problems.push(`${label(String(fieldOf(block, "id")), undefined)}jump to ${target} leaves no loop`);
    }
  }

  return problems;
}

/* -------------------------------------------------------------------------- */
/* Rule 3: values                                                             */
/* -------------------------------------------------------------------------- */

/** What a compound operator writes, and what it writes it as. */
function compoundProblems(target: SemanticType, value: SemanticValue, operator: string, prefix: string, name: string): string[] {
  if (operator === "+=" && (isTextType(target) || isTextType(value.type))) {
    return isTextType(target) && isTextType(value.type)
      ? []
      : [`${prefix}${operator} writes text into "${name}" and a ${typeText(value.type)}`];
  }
  const wholeCompounds = operator === "%=" || operator === "&=" || operator === "|=" || operator === "^=" || operator === "<<=" || operator === ">>=" || operator === ">>>=";
  if (wholeCompounds) {
    if (!isInteger(target) || !isInteger(value.type)) {
      return [`${prefix}"${name}" is a ${typeText(target)}, which ${operator} cannot write`];
    }
    return [];
  }
  const common = commonNumber(target, value.type);
  if (common === null) {
    return [`${prefix}"${name}" is a ${typeText(target)}, which ${operator} cannot write`];
  }
  if (!typeEquals(common, target)) {
    return [`${prefix}${operator} writes a ${typeText(common)} into "${name}", a ${typeText(target)}`];
  }
  return [];
}

/**
 * Every name a statement reads is one that is still in scope where it is
 * written, and every name it writes is a slot that was declared as one.
 */
function valueProblems(tree: Tree): string[] {
  const problems: string[] = [];
  const statements = fieldOf(tree, "statements") as readonly { statement: SemanticStatement; scope: Scope; block: PlacedBlock }[];

  for (const placed of statements) {
    const statement = fieldOf(placed, "statement") as SemanticStatement;
    const scope = fieldOf(placed, "scope") as Scope;
    const block = fieldOf(placed, "block") as PlacedBlock;
    const statementLine = Number(fieldOf(statement, "line"));
    const prefix = label(String(fieldOf(fieldOf(block, "block"), "id")), statementLine);
    const writes: string[] = [];
    if (statement.k === "set" || statement.k === "step") writes[writes.length] = String(fieldOf(statement, "name"));
    if (statement.k === "setElement" || statement.k === "fill") {
      const bufferName = String(fieldOf(statement, "buffer"));
      const slots = fieldOf(scope, "slots") as Map<string, SemanticSlot>;
      const buffer = slots.get(bufferName);
      if (buffer === undefined) {
        problems.push(`${prefix}"${bufferName}" is not declared where it is written`);
      } else if (!isSequence(slotType(buffer))) {
        problems.push(`${prefix}"${bufferName}" is a ${typeText(slotType(buffer))}, which has no elements to write`);
      }
    }
    if (statement.k === "loop") {
      const loop = fieldOf(statement, "loop") as SemanticLoop;
      if (loop.kind === "each") {
        const loopOf = String(fieldOf(loop, "of"));
        const visible = fieldOf(scope, "visible") as Set<string>;
        if (!visible.has(loopOf)) {
          problems.push(`${prefix}"${loopOf}" is not declared where it is read`);
        } else {
          const slots = fieldOf(scope, "slots") as Map<string, SemanticSlot>;
          const held = slots.get(loopOf);
          const element = held === undefined ? null : elementTypeOf(slotType(held));
          const elementType = fieldOf(loop, "elementType") as TypeExpr;
          if (element !== null && !typeEquals(element, elementType)) {
            problems.push(`${prefix}an element of a ${typeText(slotType(held as SemanticSlot))} is a ${typeText(element)}, not a ${typeText(elementType)}`);
          }
        }
      }
    }

    for (const name of writes) {
      const slots = fieldOf(scope, "slots") as Map<string, SemanticSlot>;
      const slot = slots.get(name);
      if (slot === undefined) {
        problems.push(`${prefix}"${name}" is not declared where it is written`);
        continue;
      }
      if (fieldOf(slot, "mutable") !== true) {
        problems.push(`${prefix}"${name}" is not a name that can be written`);
        continue;
      }
      if (statement.k === "set" && String(fieldOf(statement, "op")) !== "=") {
        problems.push(...compoundProblems(slotType(slot), fieldOf(statement, "value") as SemanticValue, String(fieldOf(statement, "op")), prefix, name));
      }
    }

    for (const value of statementValues(statement)) {
      const visible = fieldOf(scope, "visible") as Set<string>;
      for (const read of localNames(value)) {
        if (!visible.has(read)) problems.push(`${prefix}"${read}" is not declared where it is read`);
      }
      problems.push(...readTypeProblems(prefix, value, scope));
    }
  }

  for (const placed of fieldOf(tree, "blocks") as readonly PlacedBlock[]) {
    const block = fieldOf(placed, "block") as SemanticBlock;
    const end = fieldOf(block, "terminator") as SemanticBlock["terminator"];
    if (String(fieldOf(end, "k")) !== "return" || fieldOf(end, "value") === null) continue;
    const finalScope = fieldOf(placed, "final") as Scope;
    problems.push(...readTypeProblems(label(String(fieldOf(block, "id")), undefined), fieldOf(end, "value") as SemanticValue, finalScope));
  }

  return problems;
}

/**
 * A name a value reads is a slot, and the type the read states is the width a
 * backend reads it at. A read narrower than the slot holds is a value the
 * program lost: `print_number local[i32] n` over an `f64` slot lowers to
 * `printf("%lld", (long long)(n))` and answers 1 where the program holds 1.75,
 * and the width was decided here, so nothing downstream recovers it.
 *
 * A read wider than the slot holds is the other direction and is kept:
 * `semantics/whole-numbers.ts` narrows a parameter to a whole number and its
 * arm past the reach reads that same slot as the double the source wrote, which
 * is every value the slot can hold said as the wider of the two.
 */
function readTypeProblems(prefix: string, value: SemanticValue, scope: Scope): string[] {
  const problems: string[] = [];
  const slots = fieldOf(scope, "slots") as Map<string, SemanticSlot>;
  walkValues(value, (inner) => {
    if (inner.k !== "local") return;
    const name = String(fieldOf(inner, "name"));
    const slot = slots.get(name);
    if (slot === undefined) return;
    const held = slotType(slot);
    const read = fieldOf(inner, "type") as SemanticType;
    if (!narrowsTo(held, read)) {
      problems.push(`${prefix}"${name}" holds a ${typeText(held)} and is read as a ${typeText(read)}, which cannot hold it`);
    }
  });
  return problems;
}

/**
 * Whether a slot of one type may be read as the other, which is not the same
 * question as whether the two are the same type.
 *
 * A buffer is one buffer whatever length it is written at — a slot whose length
 * the program settled on reads as a slice of its elements, and `typeEquals`
 * says `[f64; 4]` and `[]f64` are two types where a backend reads both as the
 * same pointer. Two numbers are one question of width: a whole number held in a
 * wider slot than it is read at has lost its high bits, and a double read as a
 * whole number has lost its fraction. A reference or a text read as something
 * else is a value nothing in the program can carry, whichever is wider.
 *
 * A wide number is the one that has no width to be read at, because it is not
 * one register: it is read at its own width or not at all. Every exemption
 * below is a machine word standing for a machine word, and a four-limb number
 * meeting a double or a sixty-four bit whole number would pass straight through
 * all of them and reach a backend that reads one word of the four — the number
 * the program wrote whole, with its high limbs in whatever was beside it.
 */
function narrowsTo(held: SemanticType, read: SemanticType): boolean {
  if (typeEquals(held, read)) return true;
  if (held.kind === "ref" && held.of === null && held.name === undefined) return true;
  if (read.kind === "ref" && read.of === null && read.name === undefined) return true;
  if (isSequence(held) && isSequence(read)) {
    const left = elementTypeOf(held);
    const right = elementTypeOf(read);
    return left !== null && right !== null && narrowsTo(left, right);
  }
  if (!isNumber(held) || !isNumber(read)) return false;
  if (isWideType(held) || isWideType(read)) return false;
  // A whole number held as a double is every value the slot can hold, said as
  // the wider of the two — which is the arm `whole-numbers.ts` writes past the
  // reach its narrowing holds for. A double read as a whole number is the
  // fraction dropped, so that one is refused and this is not.
  if (!isFloat(held) && isFloat(read)) return true;
  return isFloat(held) === isFloat(read) && wholeRank(read) <= wholeRank(held);
}

/** How wide a whole number is, so a read at a narrower width is told from one at a wider. */
function wholeRank(type: SemanticType): number {
  if (type.kind !== "primitive") return 0;
  return WHOLE_RANK[type.name] ?? 0;
}

/** The width of each whole number, ranked so a pair is compared by size. */
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
  i256: 5,
  u256: 5,
};

/**
 * Why a value handed to a use that reads it as a wide number is refused, or
 * null when the widening is the same number.
 *
 * A wide number is four limbs and the kernel every backend widens with takes one
 * machine word, so a whole number is widened by putting that word in the low limb
 * and nothing above it. That is the same number only where the word is a value
 * the wide number holds. Widening to an unsigned wide number zero-extends, so an
 * unsigned whole number is the same number there; widening to the signed wide
 * number sign-extends, so a signed whole number is the same number there too. A
 * literal is a value the compiler reads rather than one it has to be told, so it
 * is the number it says whatever the wide target. A double is not a set of limbs
 * at all, and the kernel takes a word rather than a fraction.
 */
function wideningReason(value: SemanticValue, as: SemanticType): string | null {
  if (!isWideType(as) || isWideType(value.type)) return null;
  const targetSigned = as.kind === "primitive" && as.name === "i256";
  // A literal is a value the compiler reads, so it is the number it says no
  // matter what the wide target is.
  if (value.k === "const" && isInteger(value.type) && WHOLE_TEXT.test(value.text)) return null;
  // An unsigned whole number holds no value a wide number does not, and it
  // zero-extends into either wide type.
  const unsigned = isInteger(value.type) && value.type.kind === "primitive" && value.type.name.startsWith("u");
  if (unsigned) return null;
  // Widening to a signed wide number sign-extends, so a signed whole number is
  // the same number there as well.
  if (targetSigned && isInteger(value.type)) return null;
  if (isFloat(value.type)) return "a double is not a set of limbs";
  if (isNumber(value.type)) return targetSigned ? "a whole number is not a set of limbs" : "a signed whole number holds values below zero that a wide number does not";
  return "a wide number is four limbs, and this is not one of them";
}

/** A whole number written as its digits, which is a value the compiler reads. */
const WHOLE_TEXT = /^(?:0[xX][0-9a-fA-F]+|[0-9]+)$/;

/* -------------------------------------------------------------------------- */
/* Rule 4: types                                                              */
/* -------------------------------------------------------------------------- */

/** Whether a comparison may read a value of this type as the operand. */
function comparableTo(side: SemanticValue, operand: SemanticType): boolean {
  if (side.k === "nothing" || side.k === "isNull") return true;
  if (typeEquals(side.type, operand)) return true;
  if (isTextType(side.type) && isReference(operand)) return true;
  if (isTextType(operand) && isReference(side.type)) return true;
  if (isNumber(side.type) && isNumber(operand)) return true;
  if (isSequence(side.type) && isReference(operand)) return true;
  return false;
}

/** What one value computes has to be the type the value says it is. */
function valueTypeProblems(prefix: string, value: SemanticValue, context: Context): string[] {
  const problems: string[] = [];

  if (!isSemanticType(fieldOf(value, "type") as SemanticType)) problems.push(`${prefix}${typeText(fieldOf(value, "type") as SemanticType)} is not a type`);

  switch (value.k) {
    case "text":
      if (!isTextType(fieldOf(value, "type") as SemanticType)) problems.push(`${prefix}a string is written as a ${typeText(fieldOf(value, "type") as SemanticType)}`);
      return problems;
    case "bool":
      if (!isBoolean(fieldOf(value, "type") as SemanticType)) problems.push(`${prefix}a truth is written as a ${typeText(fieldOf(value, "type") as SemanticType)}`);
      return problems;
    case "local":
    case "nothing":
    case "const":
      return problems;
    case "length":
      if (!isSequence((fieldOf(value, "of") as SemanticValue).type) && !isTextType((fieldOf(value, "of") as SemanticValue).type)) {
        problems.push(`${prefix}length reads a ${typeText((fieldOf(value, "of") as SemanticValue).type)}, which has no length`);
      }
      if (!isNumber(fieldOf(value, "type") as SemanticType)) {
        problems.push(`${prefix}the length of a ${typeText((fieldOf(value, "of") as SemanticValue).type)} is written as a ${typeText(fieldOf(value, "type") as SemanticType)}`);
      }
      return problems;
    case "element": {
      if (!isSequence((fieldOf(value, "of") as SemanticValue).type)) {
        problems.push(`${prefix}an element is read out of a ${typeText((fieldOf(value, "of") as SemanticValue).type)}, which is not a sequence`);
        return problems;
      }
      // An index is a whole number, and the source may write one as a double —
      // a loop counting in fractions indexes just as well. What has to be a
      // number is the index: a truth or a reference is not a place in an array,
      // and a target has no way to read one as one.
      if (!isNumber((fieldOf(value, "index") as SemanticValue).type)) {
        problems.push(`${prefix}an element is read at a ${typeText((fieldOf(value, "index") as SemanticValue).type)}, which is not a number`);
      }
      const element = elementTypeOf((fieldOf(value, "of") as SemanticValue).type);
      if (element !== null && !typeEquals(element, fieldOf(value, "type") as SemanticType)) {
        problems.push(`${prefix}an element of a ${typeText((fieldOf(value, "of") as SemanticValue).type)} is a ${typeText(element)}, not a ${typeText(fieldOf(value, "type") as SemanticType)}`);
      }
      return problems;
    }
    case "buffer": {
      if (fieldOf(value, "length") === null) {
        // The count the program settled on is a value, and a view writes no
        // values of its own: what it holds is the block it looks into.
        if (fieldOf(value, "count") as SemanticValue | null === null) {
          problems.push(`${prefix}the array declares no elements and settles on no count`);
        } else if (!isNumber((fieldOf(value, "count") as SemanticValue).type)) {
          problems.push(`${prefix}the array is settled on a ${typeText((fieldOf(value, "count") as SemanticValue).type)}, which is not a number`);
        }
        if (fieldOf(value, "view") === null && (fieldOf(value, "values") as readonly SemanticValue[]).length > 0) {
          problems.push(`${prefix}the array settles on a count and writes ${(fieldOf(value, "values") as readonly SemanticValue[]).length} value(s) out`);
        }
        // A window of a block is taken of any sequence: a name bound to a
        // typed array is an array of its length, one that came from a call is a
        // slice, and both are a block of elements the window reaches into.
        if (fieldOf(value, "view") !== null && !isSequence((fieldOf(fieldOf(value, "view"), "of") as SemanticValue).type)) {
          problems.push(`${prefix}a view is taken of a ${typeText((fieldOf(fieldOf(value, "view"), "of") as SemanticValue).type)}, which is not a block of bytes`);
        }
        if (fieldOf(value, "view") !== null && !isNumber((fieldOf(fieldOf(value, "view"), "offset") as SemanticValue).type)) {
          problems.push(`${prefix}the view starts at a ${typeText((fieldOf(fieldOf(value, "view"), "offset") as SemanticValue).type)}, which is not a number`);
        }
        return problems;
      }
      if (fieldOf(value, "view") !== null) {
        problems.push(`${prefix}a view declares ${Number(fieldOf(value, "length"))} elements of its own`);
      }
      if ((fieldOf(value, "values") as readonly SemanticValue[]).length !== Number(fieldOf(value, "length"))) {
        problems.push(`${prefix}the array declares ${Number(fieldOf(value, "length"))} elements and writes ${(fieldOf(value, "values") as readonly SemanticValue[]).length}`);
      }
      for (const element of fieldOf(value, "values") as readonly SemanticValue[]) {
        if (!convertibleTo(element.type, fieldOf(value, "element") as TypeExpr)) {
          problems.push(`${prefix}the array holds a ${typeText(fieldOf(value, "element") as TypeExpr)} and writes a ${typeText(element.type)}`);
          break;
        }
      }
      const element = elementTypeOf(fieldOf(value, "type") as SemanticType);
      if (element === null || !typeEquals(element, fieldOf(value, "element") as TypeExpr)) {
        problems.push(`${prefix}the array is a ${typeText(fieldOf(value, "type") as SemanticType)} and holds a ${typeText(fieldOf(value, "element") as TypeExpr)}`);
      }
      return problems;
    }
    case "newObject": {
      // A field of an object being built is read the way a field of an object
      // already built is read: the layout must be one the program lays out, the
      // field must be one of its fields, and what is written must be readable
      // as the type the layout gives that field.
      if (String(fieldOf(value, "layout")) !== "JSON" && !isLayout(context, String(fieldOf(value, "layout"))) && !isContractLayout(fieldOf(context, "contract") as ProgramContract | undefined, String(fieldOf(value, "layout")))) {
        problems.push(`${prefix}the object ${String(fieldOf(value, "layout"))} is not a layout the program lays out`);
        return problems;
      }
      for (const field of fieldOf(value, "fields") as readonly { name: string; value: SemanticValue }[]) {
        problems.push(...layoutProblems(prefix, String(fieldOf(value, "layout")), String(fieldOf(field, "name")), context));
        const declared = fieldType(String(fieldOf(value, "layout")), String(fieldOf(field, "name")), context);
        if (declared !== null) problems.push(...writeProblems(prefix, `${String(fieldOf(value, "layout"))}.${String(fieldOf(field, "name"))}`, declared, fieldOf(field, "value") as SemanticValue));
      }
      return problems;
    }
    case "loadField": {
      problems.push(...layoutProblems(prefix, String(fieldOf(value, "layout")), String(fieldOf(value, "field")), context));
      const declared = fieldType(String(fieldOf(value, "layout")), String(fieldOf(value, "field")), context);
      if (declared !== null && !fieldReadsAs(declared, fieldOf(value, "type") as SemanticType)) {
        problems.push(`${prefix}${String(fieldOf(value, "layout"))}.${String(fieldOf(value, "field"))} is a ${typeText(declared)}, not a ${typeText(fieldOf(value, "type") as SemanticType)}`);
      }
      return problems;
    }
    case "arith": {
      // A wide number is answered by the kernel, which defines the operations
      // listed above and nothing else. Anything else over one would reach a
      // backend with no instruction for it — the C backend would write a C
      // operator over a struct and produce a source that does not compile, and
      // the machine backend would have nothing to emit — so it is refused here,
      // which is the last point before a backend is handed the tree.
      if (isWideType((fieldOf(value, "left") as SemanticValue).type) || isWideType((fieldOf(value, "right") as SemanticValue).type) || isWideType(fieldOf(value, "type") as SemanticType)) {
        if (!WIDE_ARITHMETIC.has(String(fieldOf(value, "op")))) {
          problems.push(
            `${prefix}${String(fieldOf(value, "op"))} is not defined over a ${typeText((fieldOf(value, "left") as SemanticValue).type)} and a ${typeText((fieldOf(value, "right") as SemanticValue).type)}; a wide number has an add, a subtraction, a product, a quotient, a remainder, the logical operations and the shifts`,
          );
        }
        const pair = widePairProblem(fieldOf(value, "left") as SemanticValue, fieldOf(value, "right") as SemanticValue, fieldOf(value, "type") as SemanticType, COUNTED_OPERATIONS.has(String(fieldOf(value, "op"))));
        if (pair !== null) problems.push(`${prefix}${String(fieldOf(value, "op"))}: ${pair}`);
        // A zero divisor is a number the language raises on, so it is refused by
        // name here rather than answered with the kernel's total zero: the
        // kernel's answer is a total function, and the language is not.
        if ((String(fieldOf(value, "op")) === "div" || String(fieldOf(value, "op")) === "mod") && (fieldOf(value, "right") as SemanticValue).k === "const") {
          try {
            const text = String(fieldOf(fieldOf(value, "right"), "text")).replace(/n$/, "").trim();
            if (text !== "" && BigInt(text) === 0n) {
              problems.push(`${prefix}a wide number cannot be divided by zero`);
            }
          } catch {
            // Not a whole literal (a float text, say): the width rule above is
            // the one that answers it.
          }
        }
        return problems;
      }
      if (String(fieldOf(value, "op")) === "concat") {
        if (!isTextType((fieldOf(value, "left") as SemanticValue).type) || !isTextType((fieldOf(value, "right") as SemanticValue).type) || !isTextType(fieldOf(value, "type") as SemanticType)) {
          problems.push(`${prefix}concat is written over a ${typeText((fieldOf(value, "left") as SemanticValue).type)} and a ${typeText((fieldOf(value, "right") as SemanticValue).type)}`);
        }
        return problems;
      }
      if (String(fieldOf(value, "op")) === "arrayConcat") {
        if (!isSequence((fieldOf(value, "left") as SemanticValue).type) || !isSequence((fieldOf(value, "right") as SemanticValue).type) || !isSequence(fieldOf(value, "type") as SemanticType)) {
          problems.push(`${prefix}arrayConcat is written over a ${typeText((fieldOf(value, "left") as SemanticValue).type)} and a ${typeText((fieldOf(value, "right") as SemanticValue).type)}`);
        }
        return problems;
      }
      if (String(fieldOf(value, "op")) === "add" && (isTextType((fieldOf(value, "left") as SemanticValue).type) || isTextType((fieldOf(value, "right") as SemanticValue).type))) {
        if (!isTextType(fieldOf(value, "type") as SemanticType)) {
          problems.push(`${prefix}text added to a ${typeText((fieldOf(value, "left") as SemanticValue).type)} and a ${typeText((fieldOf(value, "right") as SemanticValue).type)} is a ${typeText(fieldOf(value, "type") as SemanticType)}`);
        }
        return problems;
      }
      // A shift, a remainder and a bitwise operator are operations on whole
      // numbers whatever the literals were written as, so they yield one: there
      // is no shift of two doubles for a target to perform — and no remainder or
      // bitwise combination of two strings either, which is what asking for the
      // whole answer first used to let through: the check for numbers is below
      // this, so a pair of texts over `%` or `&` was accepted and the backend
      // wrote a C operator over two pointers.
      if (WHOLE_OPERATIONS[String(fieldOf(value, "op"))] === true) {
        if (!isInteger(fieldOf(value, "type") as SemanticType)) {
          problems.push(`${prefix}${String(fieldOf(value, "op"))} of a ${typeText((fieldOf(value, "left") as SemanticValue).type)} and a ${typeText((fieldOf(value, "right") as SemanticValue).type)} is a ${typeText(fieldOf(value, "type") as SemanticType)}, which is not a whole number`);
          return problems;
        }
        if (!isNumber((fieldOf(value, "left") as SemanticValue).type) || !isNumber((fieldOf(value, "right") as SemanticValue).type)) {
          problems.push(`${prefix}${String(fieldOf(value, "op"))} over a ${typeText((fieldOf(value, "left") as SemanticValue).type)} and a ${typeText((fieldOf(value, "right") as SemanticValue).type)}`);
        }
        return problems;
      }
      // A power is the one arithmetic operation no target has over whole
      // numbers: `pow` takes and hands back a double, so writing the result as
      // a whole number is a truncation, and `2 ** 40` is 1099511627776 rather
      // than what a 32 bit answer would hold. The resolver gives it a double,
      // whatever the operands are.
      if (String(fieldOf(value, "op")) === "pow" && isInteger(fieldOf(value, "type") as SemanticType)) {
        problems.push(`${prefix}pow of a ${typeText((fieldOf(value, "left") as SemanticValue).type)} and a ${typeText((fieldOf(value, "right") as SemanticValue).type)} is a ${typeText(fieldOf(value, "type") as SemanticType)}, which is not a floating value`);
        return problems;
      }
      // What an operation is written as is one of the two types it works on —
      // `length - 10` is a double and `10 - length` is a whole number, because
      // that is what the language says — and both sides convert to it.
      if (!isNumber((fieldOf(value, "left") as SemanticValue).type) || !isNumber((fieldOf(value, "right") as SemanticValue).type)) {
        problems.push(`${prefix}${String(fieldOf(value, "op"))} over a ${typeText((fieldOf(value, "left") as SemanticValue).type)} and a ${typeText((fieldOf(value, "right") as SemanticValue).type)}`);
        return problems;
      }
      // A shift is written as the type of what it shifts, and `>>>` is the one
      // that converts: JavaScript reads both of its sides as 32 bit unsigned
      // numbers whatever they are, so its answer is its own type and not the
      // type of either side.
      const expected = String(fieldOf(value, "op")) === "shl" || String(fieldOf(value, "op")) === "shr" ? (fieldOf(value, "left") as SemanticValue).type : fieldOf(value, "type") as SemanticType;
      // `>>>` is the one shift that converts, so it is not written as the type
      // of either side: both are read as the unsigned 32 bit numbers the
      // language reads them as, and what it answers is one of those.
      if (String(fieldOf(value, "op")) === "ushr") {
        if (!convertibleTo((fieldOf(value, "left") as SemanticValue).type, fieldOf(value, "type") as SemanticType) || !convertibleTo((fieldOf(value, "right") as SemanticValue).type, fieldOf(value, "type") as SemanticType)) {
          problems.push(`${prefix}${String(fieldOf(value, "op"))} of a ${typeText((fieldOf(value, "left") as SemanticValue).type)} and a ${typeText((fieldOf(value, "right") as SemanticValue).type)} is a ${typeText(fieldOf(value, "type") as SemanticType)}`);
        }
        return problems;
      }
      // A whole pair added, subtracted, multiplied or divided answers a double,
      // and that is the language's own answer rather than a type the IR chose:
      // a program counts in whole numbers and computes in doubles, so `i * i`
      // over a loop index is a double on both sides of the language and here.
      const widened =
        isFloat(fieldOf(value, "type") as SemanticType) && isInteger((fieldOf(value, "left") as SemanticValue).type) && isInteger((fieldOf(value, "right") as SemanticValue).type) && String(fieldOf(value, "op")) !== "min" && String(fieldOf(value, "op")) !== "max";
      if (!widened && !typeEquals(expected, (fieldOf(value, "left") as SemanticValue).type) && !typeEquals(expected, (fieldOf(value, "right") as SemanticValue).type)) {
        problems.push(`${prefix}${String(fieldOf(value, "op"))} of a ${typeText((fieldOf(value, "left") as SemanticValue).type)} and a ${typeText((fieldOf(value, "right") as SemanticValue).type)} is a ${typeText(fieldOf(value, "type") as SemanticType)}, which is neither`);
        return problems;
      }
      if (!convertibleTo((fieldOf(value, "left") as SemanticValue).type, fieldOf(value, "type") as SemanticType) || !convertibleTo((fieldOf(value, "right") as SemanticValue).type, fieldOf(value, "type") as SemanticType)) {
        problems.push(`${prefix}${String(fieldOf(value, "op"))} of a ${typeText((fieldOf(value, "left") as SemanticValue).type)} and a ${typeText((fieldOf(value, "right") as SemanticValue).type)} is a ${typeText(fieldOf(value, "type") as SemanticType)}`);
      }
      return problems;
    }
    case "compare":
      if (!isBoolean(fieldOf(value, "type") as SemanticType)) {
        problems.push(`${prefix}a comparison is written as a ${typeText(fieldOf(value, "type") as SemanticType)}`);
      }
      if (!comparableTo(fieldOf(value, "left") as SemanticValue, (fieldOf(value, "operand") as SemanticValue).type)) {
        problems.push(`${prefix}${String(fieldOf(value, "op"))} compares a ${typeText((fieldOf(value, "left") as SemanticValue).type)} as a ${typeText((fieldOf(value, "operand") as SemanticValue).type)}`);
      }
      if (!comparableTo(fieldOf(value, "right") as SemanticValue, (fieldOf(value, "operand") as SemanticValue).type)) {
        problems.push(`${prefix}${String(fieldOf(value, "op"))} compares a ${typeText((fieldOf(value, "right") as SemanticValue).type)} as a ${typeText((fieldOf(value, "operand") as SemanticValue).type)}`);
      }
      // A wide number is compared by the kernel, over two of them. The operand
      // is what the comparison is read at, so a wide number beside an operand
      // that is not one is a comparison no backend has an instruction for: the
      // C backend casts a struct to whatever the operand is and writes it into a
      // C comparison, and the machine backend asks for the width a wide number
      // does not have. The count of a shift is the one narrower number a wide
      // number may be beside, and it is not a comparison.
      const pair = widePairProblem(fieldOf(value, "left") as SemanticValue, fieldOf(value, "right") as SemanticValue, (fieldOf(value, "operand") as SemanticValue).type, false);
      if (pair !== null) problems.push(`${prefix}${String(fieldOf(value, "op"))}: ${pair}`);
      return problems;
    case "logical": {
      // `&&` and `||` hand back one of their arms rather than a truth, so what
      // they are written as is the type of the arm they hand back. A reference
      // is that type, and the other arm is then the test that decides whether to
      // hand it back — `n > 0 && node.left` is the reference when the test says
      // so — so one reference arm is enough and a number or a truth beside it
      // is the test rather than a second value of another type. A text is that
      // type as well: a number beside a text is the test, and the text is the
      // value the operator hands back. This is the reading the program pass
      // gives the same two arms.
      const arms: [SemanticType, SemanticType] = [(fieldOf(value, "left") as SemanticValue).type, (fieldOf(value, "right") as SemanticValue).type];
      const holds = arms.filter((arm) => convertibleTo(arm, fieldOf(value, "type") as SemanticType));
      // The arms are both of the type, or one of them is the test that decides
      // whether the other is handed back and the other is of the type.
      const tests = arms.filter((arm) => isNumber(arm) || isBoolean(arm)).length;
      if (!(holds.length === arms.length || (holds.length === 1 && tests === 1))) {
        problems.push(`${prefix}${String(fieldOf(value, "op"))} over a ${typeText(arms[0])} and a ${typeText(arms[1])} is a ${typeText(fieldOf(value, "type") as SemanticType)}`);
      }
      return problems;
    }
    case "isNull":
      if (!isBoolean(fieldOf(value, "type") as SemanticType)) problems.push(`${prefix}a null test is written as a ${typeText(fieldOf(value, "type") as SemanticType)}`);
      return problems;
    case "coalesce": {
      // `a ?? b` hands back one of its two arms, the way `&&` and `||` do, so
      // what it is written as is the type both of them convert to. The left arm
      // is the one that decides, and it is only a null test if it can be
      // nothing: a left arm that always holds leaves the right one dead, which
      // is a different program from the one that is written.
      for (const [what, arm] of [["left", fieldOf(value, "left") as SemanticValue], ["right", fieldOf(value, "right") as SemanticValue]] as const) {
        if (!convertibleTo(arm.type, fieldOf(value, "type") as SemanticType)) {
          problems.push(`${prefix}the ${what} arm of ?? is a ${typeText(arm.type)}, and the whole is a ${typeText(fieldOf(value, "type") as SemanticType)}`);
        }
      }
      return problems;
    }
    case "select": {
      // A conditional hands back one of its two arms, so both of them have to be
      // readable as what the whole is written as: the C emitter writes the two
      // arms into one conditional, and a string beside a number is a
      // conditional no compiler takes. What decides it is a question the
      // backends answer, and an array is one of the answers.
      for (const [what, arm] of [["then", fieldOf(value, "then") as SemanticValue], ["otherwise", fieldOf(value, "otherwise") as SemanticValue]] as const) {
        if (!convertibleTo(arm.type, fieldOf(value, "type") as SemanticType)) {
          problems.push(`${prefix}the ${what} arm of a conditional is a ${typeText(arm.type)}, and the whole is a ${typeText(fieldOf(value, "type") as SemanticType)}`);
        }
      }
      return problems;
    }
    case "unary": {
      if (String(fieldOf(value, "op")) === "not") {
        if (!isBoolean((fieldOf(value, "operand") as SemanticValue).type) || !isBoolean(fieldOf(value, "type") as SemanticType)) {
          problems.push(`${prefix}not is written over a ${typeText((fieldOf(value, "operand") as SemanticValue).type)} as a ${typeText(fieldOf(value, "type") as SemanticType)}`);
        }
        return problems;
      }
      if (!isNumber((fieldOf(value, "operand") as SemanticValue).type) || !isNumber(fieldOf(value, "type") as SemanticType)) {
        problems.push(`${prefix}${String(fieldOf(value, "op"))} is written over a ${typeText((fieldOf(value, "operand") as SemanticValue).type)} as a ${typeText(fieldOf(value, "type") as SemanticType)}`);
      }
      // A bitwise inversion is the operation on whole numbers its binary forms
      // are: there is no `~` of a double for a target to perform, so a body
      // that asks for one is refused here rather than handed to a compiler
      // that cannot read it.
      if (String(fieldOf(value, "op")) === "bitNot" && !isInteger(fieldOf(value, "type") as SemanticType)) {
        problems.push(`${prefix}bitNot of a ${typeText((fieldOf(value, "operand") as SemanticValue).type)} is a ${typeText(fieldOf(value, "type") as SemanticType)}, which is not a whole number`);
      }
      // A complement and a negation are the two operations whose answer the
      // language that wrote the program does not hold in an unsigned wide
      // number: `~a` is `-(a) - 1` and `-a` is below zero however wide `a` is,
      // and a `u256` is an unsigned number whose zero is at the bottom of its
      // range. The four limb kernel answers 2^256 - 1 - a and 2^256 - a, which
      // are the same bits and not the number the source wrote — a program
      // checked against the source it was written as prints one and not the
      // other, and there is no spelling of the source's answer this type holds.
      // The signed wide number does hold below zero, so `~a` and `-a` of an
      // `i256` are answered as the two's complement they are.
      if (String(fieldOf(value, "op")) === "bitNot" || String(fieldOf(value, "op")) === "neg") {
        const wide = isWideType((fieldOf(value, "operand") as SemanticValue).type) ? (fieldOf(value, "operand") as SemanticValue).type : fieldOf(value, "type") as SemanticType;
        if (wide.kind === "primitive" && wide.name === "u256") {
          problems.push(`${prefix}${String(fieldOf(value, "op"))} of a ${typeText((fieldOf(value, "operand") as SemanticValue).type)} is a number below zero, and a wide number holds none`);
        }
      }
      return problems;
    }
    case "toText":
      if (!isTextType(fieldOf(value, "type") as SemanticType)) problems.push(`${prefix}text is read as a ${typeText(fieldOf(value, "type") as SemanticType)}`);
      return problems;
    case "argv":
      if (fieldOf(value, "index") as SemanticValue !== null && !isNumber((fieldOf(value, "index") as SemanticValue).type)) {
        problems.push(`${prefix}an argument is read at a ${typeText((fieldOf(value, "index") as SemanticValue).type)}, which is not a number`);
      }
      return problems;
    case "closure":
      if (!isReference(fieldOf(value, "type") as SemanticType)) {
        problems.push(`${prefix}a closure is written as a ${typeText(fieldOf(value, "type") as SemanticType)}, which is not a reference`);
      }
      if ((fieldOf(value, "captures") as readonly { name: string; type: SemanticType }[]).some((capture) => (fieldOf(capture, "type") as SemanticType).kind === "void")) {
        problems.push(`${prefix}a closure captures nothing, and nothing is not a value`);
      }
      return problems;
    case "capture": {
      if (!isReference((fieldOf(value, "closure") as SemanticValue).type)) {
        problems.push(`${prefix}a value is captured out of a ${typeText((fieldOf(value, "closure") as SemanticValue).type)}, which is not a closure`);
      }
      if (Number(fieldOf(value, "index")) < 0) problems.push(`${prefix}a capture is read at ${String(fieldOf(value, "index"))}`);
      return problems;
    }
    default:
      return problems;
  }
}

/** Every value a value holds, checked against the type each states. */
function valueTypeProblemsDeep(prefix: string, value: SemanticValue, context: Context): string[] {
  const problems: string[] = [];
  for (const one of valueTypeProblems(prefix, value, context)) problems.push(one);
  switch (value.k) {
    case "newObject":
      for (const field of fieldOf(value, "fields") as readonly { value: SemanticValue }[]) {
        for (const one of valueTypeProblemsDeep(prefix, fieldOf(field, "value") as SemanticValue, context)) problems.push(one);
      }
      return problems;
    case "loadField":
      for (const one of valueTypeProblemsDeep(prefix, fieldOf(value, "object") as SemanticValue, context)) problems.push(one);
      return problems;
    case "text":
      for (const part of fieldOf(value, "parts") as readonly { k: string; value: SemanticValue }[]) {
        if (part.k === "value") for (const one of valueTypeProblemsDeep(prefix, part.value, context)) problems.push(one);
      }
      return problems;
    case "buffer": {
      const count = fieldOf(value, "count") as SemanticValue | null;
      if (count !== null) for (const one of valueTypeProblemsDeep(prefix, count, context)) problems.push(one);
      const view = fieldOf(value, "view") as { of: SemanticValue; offset: SemanticValue } | null;
      if (view !== null) {
        for (const one of valueTypeProblemsDeep(prefix, fieldOf(view, "of") as SemanticValue, context)) problems.push(one);
        for (const one of valueTypeProblemsDeep(prefix, fieldOf(view, "offset") as SemanticValue, context)) problems.push(one);
      }
      for (const item of fieldOf(value, "values") as readonly SemanticValue[]) for (const one of valueTypeProblemsDeep(prefix, item, context)) problems.push(one);
      return problems;
    }
    case "call": {
      const call = fieldOf(value, "call") as SemanticCall;
      for (const item of fieldOf(call, "args") as readonly SemanticValue[]) for (const one of valueTypeProblemsDeep(prefix, item, context)) problems.push(one);
      return problems;
    }
    case "arith":
    case "compare":
    case "logical":
    case "coalesce":
      for (const one of valueTypeProblemsDeep(prefix, fieldOf(value, "left") as SemanticValue, context)) problems.push(one);
      for (const one of valueTypeProblemsDeep(prefix, fieldOf(value, "right") as SemanticValue, context)) problems.push(one);
      return problems;
    case "select":
      for (const one of valueTypeProblemsDeep(prefix, fieldOf(value, "condition") as SemanticValue, context)) problems.push(one);
      for (const one of valueTypeProblemsDeep(prefix, fieldOf(value, "then") as SemanticValue, context)) problems.push(one);
      for (const one of valueTypeProblemsDeep(prefix, fieldOf(value, "otherwise") as SemanticValue, context)) problems.push(one);
      return problems;
    case "unary":
    case "isNull":
      for (const one of valueTypeProblemsDeep(prefix, fieldOf(value, "operand") as SemanticValue, context)) problems.push(one);
      return problems;
    case "toText":
    case "length":
      for (const one of valueTypeProblemsDeep(prefix, fieldOf(value, "of") as SemanticValue, context)) problems.push(one);
      return problems;
    case "element":
      for (const one of valueTypeProblemsDeep(prefix, fieldOf(value, "of") as SemanticValue, context)) problems.push(one);
      for (const one of valueTypeProblemsDeep(prefix, fieldOf(value, "index") as SemanticValue, context)) problems.push(one);
      return problems;
    case "argv": {
      const index = fieldOf(value, "index") as SemanticValue | null;
      if (index !== null) for (const one of valueTypeProblemsDeep(prefix, index, context)) problems.push(one);
      return problems;
    }
    case "closure":
      for (const one of fieldOf(value, "captures") as readonly SemanticValue[]) for (const item of valueTypeProblemsDeep(prefix, one, context)) problems.push(item);
      return problems;
    case "capture":
      for (const one of valueTypeProblemsDeep(prefix, fieldOf(value, "closure") as SemanticValue, context)) problems.push(one);
      return problems;
    default:
      return problems;
  }
}

/**
 * Whether a field a layout gives a type is the field the IR reads it as. A
 * layout spells a string as the number a string is stored as, because the
 * contract type language has no string type, so a number in a layout and text
 * in the IR are the same field written two ways rather than a conflict. Two
 * numbers are compared the way a use compares two numbers, by whether one
 * converts to the other.
 */
function fieldReadsAs(declared: SemanticType, read: SemanticType): boolean {
  if (isTextType(read) && isNumber(declared)) return true;
  return convertibleTo(declared, read);
}

/**
 * What one field of a layout takes when it is written, which is what one
 * element of a buffer takes and the same three answers: the field holds the
 * type the layout gives it, what is written reads as that type, and a wide
 * number is widened from a whole number and from nothing else. A wide number
 * written where a double is read is the low half of a number the program never
 * computed, so it is refused rather than written where no backend can read it.
 */
function writeProblems(prefix: string, what: string, declared: SemanticType, value: SemanticValue): string[] {
  const problems: string[] = [];
  if (isTextType((fieldOf(value, "type") as SemanticType)) && isNumber(declared)) return problems;
  // Nothing is held at an unshaped reference, and an object being laid out
  // starts every field as nothing: nothing fits a field of any type.
  const writtenType = fieldOf(value, "type") as TypeExpr;
  if (writtenType.kind === "ref" && writtenType.of === null && writtenType.name === undefined) return problems;
  if (!convertibleTo((fieldOf(value, "type") as SemanticType), declared)) {
    problems.push(`${prefix}${what} is a ${typeText(declared)}, not a ${typeText((fieldOf(value, "type") as SemanticType))}`);
  }
  const reason = wideningReason(value, declared);
  if (reason !== null) problems.push(`${prefix}${what} is written where a ${typeText(declared)} is read, and ${reason}`);
  return problems;
}

/** A field of a layout the body lays out, and the type the layout gives it. */
function layoutProblems(prefix: string, layout: string, field: string, context: Context): string[] {
  if (layout === "JSON") return [];
  if (layout !== "JSON" && !isLayout(context, layout) && !isContractLayout(fieldOf(context, "contract") as ProgramContract | undefined, layout)) {
    return [`${prefix}the object ${layout} is not a layout the program lays out`];
  }
  const found = layoutOf(context, layout);
  const fields = found === undefined ? [] : fieldOf(found, "fields") as readonly { name: string; type: string }[];
  let declared: { name: string; type: string } | undefined;
  for (const one of fields) if (one.name === field) declared = one;
  if (declared === undefined) {
    return [`${prefix}${layout} has no field ${field}`];
  }
  return [];
}

/** The layout a body carries, wherever it came from. */
function layoutOf(context: Context, name: string): ObjectLayout | undefined {
  if (isLayout(context, name)) return (fieldOf(context, "objects") as Record<string, ObjectLayout>)[name];
  const contract = fieldOf(context, "contract") as ProgramContract | undefined;
  if (contract === undefined) return undefined;
  for (const file of fieldOf(contract, "files") as readonly ProgramContractFile[]) {
    for (const declared of Object.values(fieldOf(file, "functions") as Record<string, FunctionContract>)) {
      const found = (fieldOf(fieldOf(declared, "definition"), "objects") as Record<string, ObjectLayout>)[name];
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** The type a layout gives a field, as a type the IR states. */
function fieldType(layout: string, field: string, context: Context): SemanticType | null {
  if (layout === "JSON") return { kind: "primitive", name: "f64" };
  const found = layoutOf(context, layout);
  const fields = found === undefined ? [] : fieldOf(found, "fields") as readonly { name: string; type: string }[];
  let declared: { name: string; type: string } | undefined;
  for (const one of fields) if (one.name === field) declared = one;
  return declared === undefined ? null : parseType(String(fieldOf(declared, "type")));
}

/** A layout the IR itself carries. */
function isLayout(context: Context, object: string): boolean {
  return Object.prototype.hasOwnProperty.call(fieldOf(context, "objects"), object);
}

/** A layout a contract lays out, which every function's body can reach. */
function isContractLayout(contract: ProgramContract | undefined, object: string): boolean {
  if (contract === undefined) return false;
  for (const file of fieldOf(contract, "files") as readonly ProgramContractFile[]) {
    for (const declared of Object.values(fieldOf(file, "functions") as Record<string, FunctionContract>)) {
      if (Object.prototype.hasOwnProperty.call(fieldOf(fieldOf(declared, "definition"), "objects"), object)) return true;
    }
  }
  return false;
}

/** The conditions, prints, raises and retains a body writes. */
function typeProblems(context: Context, tree: Tree): string[] {
  const problems: string[] = [];

  for (const placed of fieldOf(tree, "statements") as readonly { statement: SemanticStatement; block: PlacedBlock }[]) {
    const statement = fieldOf(placed, "statement") as SemanticStatement;
    const block = fieldOf(placed, "block") as PlacedBlock;
    const scope = fieldOf(placed, "scope") as Scope;
    const slots = fieldOf(scope, "slots") as Map<string, SemanticSlot>;
    const prefix = label(String(fieldOf(fieldOf(block, "block"), "id")), Number(fieldOf(statement, "line")));

    if (statement.k === "printText" && !isTextType((fieldOf(statement, "value") as SemanticValue).type)) {
      problems.push(`${prefix}print is given a ${typeText((fieldOf(statement, "value") as SemanticValue).type)}, which is not text`);
    }
    if (statement.k === "printNumber" && !isNumber((fieldOf(statement, "value") as SemanticValue).type)) {
      problems.push(`${prefix}a number is printed as a ${typeText((fieldOf(statement, "value") as SemanticValue).type)}`);
    }
    // A bigint is the `i64` the language's `1n` is, and the `n` after it says
    // so. A value of any other width has no such spelling: a double is written
    // as the number it is and a whole number wider than a machine word is
    // written as its digits. A wide number is the one value written as a bigint
    // that is not an `i64`: the language has no `u256`, so every value that is
    // one here was written as a bigint, and the driver writes the marker after
    // the digits the formatter gives it.
    if (statement.k === "printNumber" && fieldOf(statement, "bigint") === true && !isWideType((fieldOf(statement, "value") as SemanticValue).type)) {
      const printed = (fieldOf(statement, "value") as SemanticValue).type;
      if (printed.kind !== "primitive" || printed.name !== "i64") {
        problems.push(`${prefix}a bigint is printed as a ${typeText(printed)}, which is not the sixty-four bit whole number a bigint is`);
      }
    }
    if (statement.k === "raise" && !isTextType((fieldOf(statement, "message") as SemanticValue).type)) {
      problems.push(`${prefix}a program is raised with a ${typeText((fieldOf(statement, "message") as SemanticValue).type)}, which is not text`);
    }
    if (statement.k === "retain" && !isReference((fieldOf(statement, "value") as SemanticValue).type) && !isTextType((fieldOf(statement, "value") as SemanticValue).type)) {
      if ((fieldOf(statement, "value") as SemanticValue).k !== "call") {
        problems.push(`${prefix}a ${typeText((fieldOf(statement, "value") as SemanticValue).type)} is nothing to keep alive`);
      }
    }
    // A name is written with the type it is declared and read as, and the two
    // backends take the declared type as the one that wins: the C emitter casts
    // the value to the slot and the WebAssembly one leaves the stack under the
    // slot's own type. Neither of them checks it, so a value written under `=`
    // and a step over a name that is not a number were lowered without a word.
    // `setElement` below holds itself to exactly this, and a step is an
    // arithmetic move, so it needs a number to move. A declaration holds to it
    // as well: the value it starts as is cast to the slot, so a number declared
    // where a string is written came out as a pointer cast to a double.
    if (statement.k === "let") {
      const declared = slotType(fieldOf(statement, "slot") as SemanticSlot);
      if (!convertibleTo((fieldOf(statement, "value") as SemanticValue).type, declared)) {
        problems.push(`${prefix}"${String(fieldOf(statement, "slot", ))}" holds a ${typeText(declared)}, not a ${typeText((fieldOf(statement, "value") as SemanticValue).type)}`);
      }
      const reason = wideningReason(fieldOf(statement, "value") as SemanticValue, declared);
      if (reason !== null) problems.push(`${prefix}"${String(fieldOf(statement, "slot", ))}" is written where a ${typeText(declared)} is read, and ${reason}`);
    }
    if (statement.k === "set" && String(fieldOf(statement, "op")) === "=") {
      const slot = slots.get(String(fieldOf(statement, "name")));
      const declared = slot === undefined ? null : slotType(slot);
      if (declared !== null && !convertibleTo((fieldOf(statement, "value") as SemanticValue).type, declared)) {
        problems.push(`${prefix}"${String(fieldOf(statement, "name"))}" holds a ${typeText(declared)}, not a ${typeText((fieldOf(statement, "value") as SemanticValue).type)}`);
      }
      if (declared !== null) {
        const reason = wideningReason(fieldOf(statement, "value") as SemanticValue, declared);
        if (reason !== null) problems.push(`${prefix}"${String(fieldOf(statement, "name"))}" is written where a ${typeText(declared)} is read, and ${reason}`);
      }
    }
    if (statement.k === "step") {
      const slot = slots.get(String(fieldOf(statement, "name")));
      const declared = slot === undefined ? null : slotType(slot);
      if (declared !== null && !isNumber(declared)) {
        problems.push(`${prefix}"${String(fieldOf(statement, "name"))}" is a ${typeText(declared)}, which is not a number a step can move`);
      }
    }
    if (statement.k === "setElement") {
      const buffer = slots.get(String(fieldOf(statement, "buffer")));
      const element = buffer === undefined ? null : elementTypeOf(slotType(buffer));
      if (element !== null) {
        if (String(fieldOf(statement, "op")) === "=") {
          if (!convertibleTo((fieldOf(statement, "value") as SemanticValue).type, element)) {
            problems.push(`${prefix}"${String(fieldOf(statement, "buffer"))}" holds a ${typeText(element)}, not a ${typeText((fieldOf(statement, "value") as SemanticValue).type)}`);
          }
          const reason = wideningReason(fieldOf(statement, "value") as SemanticValue, element);
          if (reason !== null) problems.push(`${prefix}"${String(fieldOf(statement, "buffer"))}[...]" is written where a ${typeText(element)} is read, and ${reason}`);
        } else {
          problems.push(...compoundProblems(element, fieldOf(statement, "value") as SemanticValue, String(fieldOf(statement, "op")), prefix, `${String(fieldOf(statement, "buffer"))}[...]`));
        }
      }
    }
    // A field written is read back the same way a field read is, so it takes
    // the same three checks: the layout is one the program lays out, the field
    // is one of its fields, and what is written is readable as the type that
    // layout gives it. The object it is written through is a reference, or the
    // C emitter casts whatever it holds to that layout and writes through it.
    if (statement.k === "storeField") {
      problems.push(...layoutProblems(prefix, String(fieldOf(statement, "layout")), String(fieldOf(statement, "field")), context));
      if (!isReference((fieldOf(statement, "object") as SemanticValue).type)) {
        problems.push(`${prefix}${String(fieldOf(statement, "layout"))}.${String(fieldOf(statement, "field"))} is written through a ${typeText((fieldOf(statement, "object") as SemanticValue).type)}, which is not a reference`);
      }
      const declared = fieldType(String(fieldOf(statement, "layout")), String(fieldOf(statement, "field")), context);
      if (declared !== null) {
        problems.push(...writeProblems(prefix, `${String(fieldOf(statement, "layout"))}.${String(fieldOf(statement, "field"))}`, declared, fieldOf(statement, "value") as SemanticValue));
      }
    }

    for (const value of statementValues(statement)) {
      for (const one of valueTypeProblemsDeep(prefix, value, context)) problems.push(one);
    }
  }

  return problems;
}

/* -------------------------------------------------------------------------- */
/* Rule 5: calls                                                              */
/* -------------------------------------------------------------------------- */

/** The type a parameter or a return is written as, or null when it is not one. */
function contractType(text: string): SemanticType | null {
  // A string is a string: the contract type language has no type of its own for
  // one, so it is named the way the signature names it.
  if (text === "text" || text === "boxedtext") return TEXT;
  try {
    return parseType(text);
  } catch {
    return null;
  }
}

/**
 * The signature a call is made against, as the context declares it. A context
 * that declares no function of its own — a single function, checked where the
 * file it is in is not the whole program — declares nothing, and a call it
 * cannot name is a call it may not refuse.
 */
function declaredSignature(context: Context, callee: string): FunctionSignature | null {
  const functions = fieldOf(context, "functions") as readonly FunctionSignature[] | null;
  if (functions === null) return null;
  return (
    functions.find((signature) => String(fieldOf(signature, "name")) === callee) ??
    functions.find((signature) => String(fieldOf(signature, "symbol")) === callee) ??
    null
  );
}

/** Whether a context declares the whole program, and so every callee in it. */
function declaresEveryCallee(context: Context): boolean {
  return fieldOf(context, "functions") !== null;
}

/**
 * A call names a function the program holds or a builtin the compiler
 * provides, passes the arguments the signature takes, and says it returns the
 * type the signature returns.
 */
function callProblems(context: Context, tree: Tree): string[] {
  const problems: string[] = [];

  for (const placed of fieldOf(tree, "statements") as readonly { statement: SemanticStatement; block: PlacedBlock }[]) {
    const statement = fieldOf(placed, "statement") as SemanticStatement;
    const block = fieldOf(placed, "block") as PlacedBlock;
    const prefix = label(String(fieldOf(fieldOf(block, "block"), "id")), Number(fieldOf(statement, "line")));
    for (const call of statementCalls(statement)) {
      problems.push(...oneCallProblems(prefix, call, context));
    }
  }

  return problems;
}

/** One call, against the signature the program or the compiler declares it with. */
function oneCallProblems(prefix: string, call: SemanticCall, context: Context): string[] {
  const problems: string[] = [];
  const through = fieldOf(call, "through") as SemanticValue | undefined;
  const argTypes = fieldOf(call, "argTypes") as readonly SemanticType[];
  const args = fieldOf(call, "args") as readonly SemanticValue[];
  const callee = String(fieldOf(call, "callee"));
  const builtinFlag = fieldOf(call, "builtin") === true;
  // A call through a closure names no callee and is made against the signature
  // the call site states, so what is checked is the arguments it hands over and
  // not a signature the program declares.
  if (through !== undefined) {
    if (argTypes.length !== args.length) {
      problems.push(`${prefix}a call through a closure passes ${args.length} argument(s) as ${argTypes.length} type(s)`);
    }
    args.forEach((value, at) => {
      const passed = argTypes[at];
      if (passed === undefined) return;
      if (!convertibleTo((fieldOf(value, "type") as SemanticType), passed)) {
        problems.push(`${prefix}argument ${at + 1} of a closure call is a ${typeText((fieldOf(value, "type") as SemanticType))} and is read as a ${typeText(passed)}`);
      }
    });
    return problems;
  }
  const builtin = builtinFor(callee);
  const signature = declaredSignature(context, callee);

  // A context that declares no program cannot say what a call it cannot name
  // takes or returns, so it may neither refuse the call nor read it against a
  // signature it does not have.
  if (builtin === null && signature === null) {
    if (declaresEveryCallee(context)) {
      problems.push(`${prefix}${callee} is neither a function of the program nor a builtin`);
    }
    return problems;
  }
  if (builtinFlag && builtin === null) {
    problems.push(`${prefix}${callee} is called as a builtin, and the compiler provides no such builtin`);
  }
  if (!builtinFlag && builtin !== null && signature === null) {
    problems.push(`${prefix}${callee} is a builtin and is not called as one`);
  }

  const params: string[] = [];
  let returns = "void";
  if (builtin !== null) {
    for (const type of fieldOf(builtin, "params") as readonly SemanticType[]) params.push(contractText(type));
    returns = contractText(fieldOf(builtin, "returns") as SemanticType);
  } else if (signature !== null) {
    for (const param of fieldOf(signature, "params") as readonly { type: string }[]) params.push(String(fieldOf(param, "type")));
    returns = String(fieldOf(signature, "returns"));
  }

  if ((fieldOf(fieldOf(call, "signature"), "params") as readonly unknown[]).length !== params.length) {
    problems.push(`${prefix}${callee} is called against a signature of ${(fieldOf(fieldOf(call, "signature"), "params") as readonly unknown[]).length} parameters`);
  }

  const allowed = builtin?.arities ?? [builtin?.arity ?? params.length];
  if (args.length !== params.length && !allowed.includes(args.length)) {
    problems.push(`${prefix}${callee} is called with ${args.length} arguments and takes ${params.length}`);
  }
  if (!allowed.includes(args.length)) {
    problems.push(`${prefix}${callee} is called with ${args.length} arguments and takes ${allowed.join(" or ")}`);
  }
  // The settle functions of a promise take whatever the executor hands them:
  // the value is the number, text, reference or nothing the promise carries,
  // and the builtin's declared parameter is the untyped reference only because
  // the contract language has no one type for all four.
  const settlesAny = builtinFlag && (callee === "resolve" || callee === "onFulfilled" ||
    callee === "reject" || callee === "onRejected");
  // A list service takes a block as the pointer it is whatever the elements the
  // block holds: the two sides of `[...a, ...b]` are lists of the one element
  // type the read fixed, and the service moves bytes.
  const listService = builtinFlag && (callee === "array.copy" || callee === "array.join");
  // A state cell holds whatever the module value is: the type the getter
  // states, boxed or cast at the call.
  const stateCell = builtinFlag && callee === "blaze_rt_state_set";
  // Variable-arity builtins may carry more types than arguments; that is expected.
  for (let index = 0; index < params.length; index += 1) {
    const parameter = contractType(params[index]);
    if (parameter === null) {
      problems.push(`${prefix}${callee} declares a parameter type that is not a type`);
      continue;
    }
    const argument = argTypes[index];
    if (argument === undefined) continue;
    if (settlesAny || listService || (stateCell && index === 1)) continue;
    // An unshaped reference parameter takes any reference: the deep copy and
    // the settle functions ask about the value, not about the fields a record
    // it points at was laid out with.
    const parameterType = parameter as TypeExpr;
    if (parameterType.kind === "ref" && fieldOf(parameterType, "of") === null && argument.kind === "ref") continue;
    if (!typeEquals(parameter, argument)) {
      problems.push(`${prefix}argument ${index + 1} of ${callee} is passed as a ${typeText(argument)} and is taken as a ${typeText(parameter)}`);
    }
    // The type an argument is passed as is not the type the value is: the value
    // is what the program computed and this is the width the callee reads it at,
    // and where the two are not one is a conversion a backend has to make. A
    // wide number beside a machine word is the one there is no answer for.
    const value = args[index];
    if (value === undefined) continue;
    if (!listService && !convertibleTo((fieldOf(value, "type") as SemanticType), argument)) {
      problems.push(`${prefix}argument ${index + 1} of ${callee} is a ${typeText((fieldOf(value, "type") as SemanticType))} and is read as a ${typeText(argument)}`);
    }
    const reason = wideningReason(value, argument);
    if (reason !== null) {
      problems.push(`${prefix}argument ${index + 1} of ${callee} is a ${typeText((fieldOf(value, "type") as SemanticType))} where a ${typeText(argument)} is read, and ${reason}`);
    }
  }

  const returned = contractType(returns);
  // A builtin that answers the opaque handle — the one double an entry of a
  // dictionary is — may be typed by the read that called it as the reference
  // that handle carries: `m.get(k)` answers the list the map holds, and the
  // runtime function answers the block the list is. The ABI is the same
  // pointer either way, and the read is what knows which.
  const builtinReturns = builtin === null ? null : fieldOf(builtin, "returns") as TypeExpr;
  const carried = builtinReturns !== null &&
    builtinReturns.kind === "ref" && builtinReturns.of === null && builtinReturns.name === undefined &&
    isReference(fieldOf(call, "returns") as SemanticType);
  if (returned === null) {
    problems.push(`${prefix}${callee} declares a return type that is not a type`);
  } else if (!carried && !typeEquals(returned, fieldOf(call, "returns") as SemanticType)) {
    problems.push(`${prefix}${callee} returns a ${typeText(fieldOf(call, "returns") as SemanticType)} and is declared to return a ${typeText(returned)}`);
  }

  return problems;
}

/* -------------------------------------------------------------------------- */
/* Rule 6: effects and ownership                                              */
/* -------------------------------------------------------------------------- */

/** What a call says it does, against the contract that says what it does. */
function effectProblems(prefix: string, call: SemanticCall, contracted: FunctionContract | null): string[] {
  const problems: string[] = [];
  const seen = new Set<Effect>();
  const callee = String(fieldOf(call, "callee"));

  for (const effect of fieldOf(call, "effects") as readonly Effect[]) {
    if (EFFECT_NAMES[String(effect) as Effect] !== true) {
      problems.push(`${prefix}${callee} has an effect the contract language does not name`);
      continue;
    }
    if (seen.has(effect)) {
      problems.push(`${prefix}${callee} says it has the effect ${effect} twice`);
    }
    seen.add(effect);
  }

  if (contracted === null) return problems;

  const callEffects = fieldOf(call, "effects") as readonly Effect[];
  const says = callEffects.slice().sort().join(", ");
  const contractedEffects = fieldOf(contracted, "effects") as readonly Effect[];
  const means = contractedEffects.slice().sort().join(", ");
  if (says !== means) {
    problems.push(`${prefix}${callee} has the effects [${says}] and its contract declares [${means}]`);
  }
  if (!signatureEquals(fieldOf(call, "signature") as FunctionSignature, fieldOf(contracted, "function") as FunctionSignature)) {
    problems.push(`${prefix}${callee} is called with a signature its contract does not declare`);
  }

  return problems;
}

/** Two signatures are the same when a caller may pass to either of them. */
function signatureEquals(left: FunctionSignature, right: FunctionSignature): boolean {
  if (String(fieldOf(left, "name")) !== String(fieldOf(right, "name")) ||
      String(fieldOf(left, "symbol")) !== String(fieldOf(right, "symbol")) ||
      String(fieldOf(left, "returns")) !== String(fieldOf(right, "returns"))) return false;
  const leftParams = fieldOf(left, "params") as readonly { name: string; type: string }[];
  const rightParams = fieldOf(right, "params") as readonly { name: string; type: string }[];
  if (leftParams.length !== rightParams.length) return false;
  for (let index = 0; index < leftParams.length; index += 1) {
    const param = leftParams[index];
    const other = rightParams[index];
    if (String(fieldOf(param, "name")) !== String(fieldOf(other, "name")) ||
        String(fieldOf(param, "type")) !== String(fieldOf(other, "type"))) return false;
  }
  return true;
}

/** The contract of the function a call names, or null when there is no contract. */
function contractedFunction(contract: ProgramContract | undefined, callee: string): FunctionContract | null {
  if (contract === undefined) return null;
  for (const file of fieldOf(contract, "files") as readonly ProgramContractFile[]) {
    const functions = fieldOf(file, "functions") as Record<string, FunctionContract>;
    const declared = functions[callee];
    if (declared !== undefined) return declared;
    for (const candidate of Object.values(functions)) {
      const signature = fieldOf(candidate, "function") as FunctionSignature;
      if (String(fieldOf(signature, "name")) === callee || String(fieldOf(signature, "symbol")) === callee) return candidate;
    }
  }
  return null;
}

/** What a call hands back is owned exactly when it is a reference to free. */
function ownershipProblems(prefix: string, call: SemanticCall): string[] {
  const problems: string[] = [];

  const callee = String(fieldOf(call, "callee"));
  const returns = fieldOf(call, "returns") as SemanticType;
  const ownership = String(fieldOf(call, "ownership"));
  if (isReference(returns) && ownership !== "owned") {
    problems.push(`${prefix}${callee} hands back a ${typeText(returns)}, which the caller has to free`);
  }
  if (
    (isNumber(returns) || isBoolean(returns) || returns.kind === "void") &&
    ownership !== "none"
  ) {
    problems.push(`${prefix}${callee} hands back a ${typeText(returns)}, which owns nothing`);
  }

  return problems;
}

/**
 * The blocks a jump written in `from` leaves, innermost first: the blocks it
 * is written in, and the body of the innermost loop around it, which the jump
 * leaves as well. Nothing outside that loop is left, because nothing outside
 * it stops being run.
 */
function blocksLeft(from: PlacedBlock): PlacedBlock[] {
  const loops = fieldOf(from, "loops") as readonly LoopFrame[];
  const loop = loops[loops.length - 1];
  if (loop === undefined) return [];
  const loopBody = fieldOf(loop, "body") as PlacedBlock | null;
  const left: PlacedBlock[] = [];
  let at: PlacedBlock | null = from;
  while (at !== null && at !== loopBody) {
    left[left.length] = at;
    at = fieldOf(at, "parent") as PlacedBlock | null;
  }
  if (loopBody !== null) left[left.length] = loopBody;
  return left;
}

/** A jump frees what the blocks it leaves free, in the same order. */
function jumpReleaseProblems(prefix: string, releases: string[], expected: string[]): string[] {
  const problems: string[] = [];
  for (const name of releases) {
    if (!expected.includes(name)) problems.push(`${prefix}frees ${name}, which no block it leaves owns`);
  }
  for (const name of expected) {
    if (!releases.includes(name)) problems.push(`${prefix}leaves ${name} allocated, which it has to free`);
  }
  return problems;
}

/**
 * Names freed on the way out, in the order the block declared them. The order
 * is the resolver's LIFO list, so it is a rule about the names a block owns: a
 * name the block does not own is reported as not its own and is left out of the
 * order, because where such a name sits in the list says nothing about the
 * block's own names. A function's blocks are read exactly this way — it owns
 * the names its own `let` statements declare, and no others, its parameters
 * among them.
 */
function releaseProblems(prefix: string, releases: string[], declared: string[]): string[] {
  const problems: string[] = [];
  const position = new Map<string, number>();
  for (let index = 0; index < declared.length; index += 1) position.set(declared[index], index);
  const seen = new Set<string>();
  let previous = 1 / 0;

  for (const release of releases) {
    const at = position.get(release);
    if (at === undefined) {
      problems.push(`${prefix}frees ${release}, which the block does not own`);
      continue;
    }
    if (seen.has(release)) {
      problems.push(`${prefix}frees ${release} more than once`);
      continue;
    }
    seen.add(release);
    if (at >= previous) {
      problems.push(`${prefix}frees ${release} out of the order the block declared them`);
    }
    previous = at;
  }

  return problems;
}

/**
 * What a call does beyond computing its result, who owns what it hands back,
 * and what every way out of a block frees on the way. A block is read the same
 * way whether it is a block of a program or of a function: it owns the names
 * it declares, in the order it declares them, and frees them on the way out.
 */
function effectAndOwnershipProblems(context: Context, tree: Tree): string[] {
  const problems: string[] = [];

  for (const placed of fieldOf(tree, "statements") as readonly { statement: SemanticStatement; block: PlacedBlock }[]) {
    const statement = fieldOf(placed, "statement") as SemanticStatement;
    const block = fieldOf(placed, "block") as PlacedBlock;
    const prefix = label(String(fieldOf(fieldOf(block, "block"), "id")), Number(fieldOf(statement, "line")));
    for (const call of statementCalls(statement)) {
      const callee = String(fieldOf(call, "callee"));
      problems.push(...effectProblems(prefix, call, contractedFunction(fieldOf(context, "contract") as ProgramContract | undefined, callee)));
      problems.push(...ownershipProblems(prefix, call));
    }
  }

  for (const placed of fieldOf(tree, "blocks") as readonly PlacedBlock[]) {
    const block = fieldOf(placed, "block") as SemanticBlock;
    const id = String(fieldOf(block, "id"));
    problems.push(...releaseProblems(label(id, undefined), fieldOf(block, "releases") as string[], fieldOf(placed, "own") as string[]));
    const terminator = fieldOf(block, "terminator") as SemanticBlock["terminator"];
    if (String(fieldOf(terminator, "k")) === "jump") {
      // A jump leaves every block it is written in, up to and including the
      // body of the loop it is in, so it frees exactly what those blocks free
      // when control falls out of them — no more, and none left behind.
      const expected: string[] = [];
      for (const left of blocksLeft(placed)) {
        for (const release of fieldOf(fieldOf(left, "block"), "releases") as string[]) expected[expected.length] = release;
      }
      problems.push(...jumpReleaseProblems(label(id, undefined), fieldOf(terminator, "releases") as string[], expected));
    }
  }

  return problems;
}

/* -------------------------------------------------------------------------- */
/* Rule 7: evaluated once                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A value a backend writes twice is a call it runs twice. The arm a `&&`, a
 * `||` or a `??` decides on is written down as the test and again as the value
 * that answers when the test says so, so a call in that arm is a call written
 * twice — the source form of these operators writes their left arm twice, which
 * is why the resolver hoists a call in it into a name first. Every other arm is
 * written once, and a name is read as often as the program reads it.
 */
function evaluatedOnceProblems(tree: Tree): string[] {
  const problems: string[] = [];
  const decide = (prefix: string, root: SemanticValue): void => {
    walked(root, (inner) => {
      if (inner.k !== "logical" && inner.k !== "coalesce") return;
      if (!hasCall(inner.left)) return;
      const left = fieldOf(inner, "left") as SemanticValue;
      const callee = left.k === "call" ? String(fieldOf(left, "callee")) : "a function";
      problems.push(`${prefix}${inner.k} decides on an arm that calls ${callee}, which is written twice`);
    });
  };

  for (const placed of fieldOf(tree, "statements") as readonly { statement: SemanticStatement; block: PlacedBlock }[]) {
    const statement = fieldOf(placed, "statement") as SemanticStatement;
    const block = fieldOf(placed, "block") as PlacedBlock;
    const prefix = label(String(fieldOf(fieldOf(block, "block"), "id")), Number(fieldOf(statement, "line")));
    for (const value of statementValues(statement)) decide(prefix, value);
  }
  // What a block hands back is a value the backends lower like any other, and
  // for a function whose body is one expression it is the only place the value
  // lives. A block's terminator is not one of its statements, so an arm written
  // in a return was decided on by this rule never, and the call the C backend
  // binds to a temporary ran once where the WebAssembly one ran it twice.
  for (const placed of fieldOf(tree, "blocks") as readonly PlacedBlock[]) {
    const block = fieldOf(placed, "block") as SemanticBlock;
    const terminator = fieldOf(block, "terminator") as SemanticBlock["terminator"];
    if (String(fieldOf(terminator, "k")) !== "return" || fieldOf(terminator, "value") === null) continue;
    decide(label(String(fieldOf(block, "id")), 0), fieldOf(terminator, "value") as SemanticValue);
  }

  return problems;
}

/* -------------------------------------------------------------------------- */
/* Rule 8: the backend boundary                                               */
/* -------------------------------------------------------------------------- */

/**
 * A name the program declared is a name: the model names no register, offset or
 * instruction, so a name that is not a plain identifier is something a target
 * would have had to escape, and the IR is not allowed to carry it.
 */
function checkName(problems: string[], prefix: string, name: string): void {
  if (!IDENTIFIER.test(name)) problems.push(`${prefix}"${name}" is not a plain identifier`);
}

/**
 * Every name a body carries is a plain identifier: no register, no stack
 * offset, no punctuation a target would have to escape before it emitted it.
 * The guarantee that the model names no target lives in the model; this is the
 * check that a body did not smuggle one in through a name. A function declares
 * its own name, its symbol and its parameters, and a program declares the
 * signatures of the functions it calls.
 */
function nameProblems(context: Context, tree: Tree): string[] {
  const problems: string[] = [];

  for (const placed of fieldOf(tree, "blocks") as readonly PlacedBlock[]) {
    const block = fieldOf(placed, "block") as SemanticBlock;
    const blockId = String(fieldOf(block, "id"));
    const where = label(blockId, undefined);
    checkName(problems, "", blockId);
    for (const declared of fieldOf(placed, "own") as readonly string[]) checkName(problems, where, declared);
    for (const release of fieldOf(block, "releases") as readonly string[]) checkName(problems, where, release);
    const terminator = fieldOf(block, "terminator") as SemanticBlock["terminator"];
    if (String(fieldOf(terminator, "k")) === "jump") {
      checkName(problems, where, String(fieldOf(terminator, "target")));
      for (const release of fieldOf(terminator, "releases") as readonly string[]) checkName(problems, where, release);
    }
    for (const frame of fieldOf(placed, "loops") as readonly LoopFrame[]) {
      const loop = fieldOf(frame, "loop") as SemanticLoop;
      if (loop.kind === "counted") checkName(problems, where, String(fieldOf(loop, "variable")));
      if (loop.kind === "each") {
        checkName(problems, where, String(fieldOf(loop, "of")));
        checkName(problems, where, String(fieldOf(loop, "index")));
        checkName(problems, where, String(fieldOf(loop, "element")));
      }
    }
  }

  for (const placed of fieldOf(tree, "statements") as readonly { statement: SemanticStatement; block: PlacedBlock }[]) {
    const statement = fieldOf(placed, "statement") as SemanticStatement;
    const block = fieldOf(placed, "block") as PlacedBlock;
    const prefix = label(String(fieldOf(fieldOf(block, "block"), "id")), Number(fieldOf(statement, "line")));
    if (statement.k === "set" || statement.k === "step") checkName(problems, prefix, String(fieldOf(statement, "name")));
    if (statement.k === "setElement") checkName(problems, prefix, String(fieldOf(statement, "buffer")));
    if (statement.k === "storeField") {
      checkName(problems, prefix, String(fieldOf(statement, "layout")));
      checkName(problems, prefix, String(fieldOf(statement, "field")));
    }
    for (const value of statementValues(statement)) checkNameValue(problems, prefix, value);
    for (const call of statementCalls(statement)) {
      // A call through a closure names no callee: the value is what is called.
      const callee = String(fieldOf(call, "callee"));
      if (fieldOf(call, "through") === undefined && builtinFor(callee) === null) checkName(problems, prefix, callee);
    }
  }

  const functions = fieldOf(context, "functions") as readonly FunctionSignature[] | null;
  if (functions !== null) {
    for (const signature of functions) {
      checkName(problems, "", String(fieldOf(signature, "name")));
      checkName(problems, "", String(fieldOf(signature, "symbol")));
    }
  }
  for (const layout of Object.values(fieldOf(context, "objects") as Record<string, ObjectLayout>)) {
    checkName(problems, "", String(fieldOf(layout, "name")));
    for (const field of fieldOf(layout, "fields") as readonly { name: string }[]) checkName(problems, "", cMemberName(String(fieldOf(field, "name"))));
  }
  for (const name of fieldOf(context, "declared") as readonly string[]) checkName(problems, "", name);

  return problems;
}

/** Every name a value carries is a plain identifier. */
function checkNameValue(problems: string[], prefix: string, value: SemanticValue): void {
  switch (value.k) {
    case "newObject": {
      checkName(problems, prefix, String(fieldOf(value, "layout")));
      // A field is read and written through the member the backend spells
      // it by, which is an identifier of its own however the source named
      // the field: a quoted key such as "content-type" is legal source and
      // a member the escape answers.
      for (const field of fieldOf(value, "fields") as readonly { name: string; value: SemanticValue }[]) {
        checkName(problems, prefix, cMemberName(String(fieldOf(field, "name"))));
        checkNameValue(problems, prefix, fieldOf(field, "value") as SemanticValue);
      }
      return;
    }
    case "loadField": {
      checkName(problems, prefix, String(fieldOf(value, "layout")));
      checkName(problems, prefix, cMemberName(String(fieldOf(value, "field"))));
      checkNameValue(problems, prefix, fieldOf(value, "object") as SemanticValue);
      return;
    }
    case "text": {
      for (const part of fieldOf(value, "parts") as readonly { k: string; value: SemanticValue }[]) {
        if (part.k === "value") checkNameValue(problems, prefix, part.value);
      }
      return;
    }
    case "buffer": {
      const count = fieldOf(value, "count") as SemanticValue | null;
      if (count !== null) checkNameValue(problems, prefix, count);
      const view = fieldOf(value, "view") as { of: SemanticValue; offset: SemanticValue } | null;
      if (view !== null) {
        checkNameValue(problems, prefix, fieldOf(view, "of") as SemanticValue);
        checkNameValue(problems, prefix, fieldOf(view, "offset") as SemanticValue);
      }
      for (const one of fieldOf(value, "values") as readonly SemanticValue[]) checkNameValue(problems, prefix, one);
      return;
    }
    case "call": {
      const call = fieldOf(value, "call") as SemanticCall;
      for (const one of fieldOf(call, "args") as readonly SemanticValue[]) checkNameValue(problems, prefix, one);
      return;
    }
    case "arith":
    case "compare":
    case "logical":
    case "coalesce":
      checkNameValue(problems, prefix, fieldOf(value, "left") as SemanticValue);
      checkNameValue(problems, prefix, fieldOf(value, "right") as SemanticValue);
      return;
    case "select":
      checkNameValue(problems, prefix, fieldOf(value, "condition") as SemanticValue);
      checkNameValue(problems, prefix, fieldOf(value, "then") as SemanticValue);
      checkNameValue(problems, prefix, fieldOf(value, "otherwise") as SemanticValue);
      return;
    case "unary":
    case "isNull":
      checkNameValue(problems, prefix, fieldOf(value, "operand") as SemanticValue);
      return;
    case "toText":
    case "length":
      checkNameValue(problems, prefix, fieldOf(value, "of") as SemanticValue);
      return;
    case "element":
      checkNameValue(problems, prefix, fieldOf(value, "of") as SemanticValue);
      checkNameValue(problems, prefix, fieldOf(value, "index") as SemanticValue);
      return;
    case "argv": {
      const index = fieldOf(value, "index") as SemanticValue | null;
      if (index !== null) checkNameValue(problems, prefix, index);
      return;
    }
    case "closure":
      for (const one of fieldOf(value, "captures") as readonly SemanticValue[]) checkNameValue(problems, prefix, one);
      return;
    case "capture":
      checkNameValue(problems, prefix, fieldOf(value, "closure") as SemanticValue);
      return;
    default:
      return;
  }
}

/* -------------------------------------------------------------------------- */
/* The check                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Every way the program is not a program a backend may lower, contract or not.
 */
export function semanticIrProblems(
  program: SemanticProgram,
  contract?: ProgramContract,
  known?: Callees,
): string[] {
  const defaultCallees = new Map<string, SemanticFunction>();
  for (const fn of fieldOf(program, "bodies") as readonly SemanticFunction[]) defaultCallees.set(String(fieldOf(fn, "name")), fn);
  const callees: Callees = known === undefined ? defaultCallees : known;
  const tree = readTree(program);
  const problems: string[] = [];
  for (const one of bodyProblems(programContext(program, callees, contract), programBody(program, tree), tree)) problems.push(one);
  for (const fn of fieldOf(program, "bodies") as readonly SemanticFunction[]) {
    const entry = fieldOf(fn, "entry") as SemanticBlock;
    const own = readFunctionTree(fn, entry);
    const ownContext: Context = {
      objects: fieldOf(program, "objects") as Record<string, ObjectLayout>,
      functions: fieldOf(program, "functions") as FunctionSignature[],
      callees,
      contract,
      declared: [String(fieldOf(fn, "name")), String(fieldOf(fn, "symbol")), ...(fieldOf(fn, "params") as readonly { name: string }[]).map((param) => String(fieldOf(param, "name")))],
    };
    for (const one of bodyProblems(ownContext, functionBody(entry, own), own)) problems.push(`${String(fieldOf(fn, "symbol"))}: ${one}`);
    for (const one of returnProblems(fn, ownContext, own)) problems.push(`${String(fieldOf(fn, "symbol"))}: ${one}`);
  }
  return problems;
}

/* -------------------------------------------------------------------------- */
/* A function, which is the same body plus what only a function has           */
/* -------------------------------------------------------------------------- */

/** Every rule a body of blocks is checked by, in the order they are stated. */
function bodyProblems(context: Context, body: Body, tree: Tree): string[] {
  return [
    ...structureProblems(body),
    ...controlFlowProblems(tree),
    ...parallelProblems(context, tree),
    ...regionProblems(context, tree),
    ...valueProblems(tree),
    ...typeProblems(context, tree),
    ...callProblems(context, tree),
    ...effectAndOwnershipProblems(context, tree),
    ...evaluatedOnceProblems(tree),
    ...nameProblems(context, tree),
  ];
}

/**
 * A return hands back what the signature declares: a value of the declared
 * type, nothing where the return type is void, and nothing at all where the
 * function returns nothing. The value is read where the block that owns what
 * it reads is still open, so a return that names a name its own block does not
 * hold is a return that reads a left.
 */
function returnProblems(fn: SemanticFunction, context: Context, tree: Tree): string[] {
  const problems: string[] = [];
  const returns = fieldOf(fn, "returns") as SemanticType;

  for (const placed of fieldOf(tree, "blocks") as readonly PlacedBlock[]) {
    const block = fieldOf(placed, "block") as SemanticBlock;
    const terminator = fieldOf(block, "terminator") as SemanticBlock["terminator"];
    if (String(fieldOf(terminator, "k")) !== "return") continue;
    const where = label(String(fieldOf(block, "id")), undefined);
    const value = fieldOf(terminator, "value") as SemanticValue | null;

    // A return type the IR does not state is a return nothing can be checked
    // against, so the return that hands it back is refused rather than read.
    if (!isSemanticType(returns)) {
      problems.push(`${where}the body returns ${typeText(returns)}, which is not a type`);
      continue;
    }
    if (returns.kind === "void") {
      if (value !== null) {
        problems.push(`${where}the body returns a ${typeText((fieldOf(value, "type") as SemanticType))} and is declared to return nothing`);
      }
      continue;
    }
    if (value === null) {
      problems.push(`${where}the body returns nothing and is declared to return a ${typeText(returns)}`);
      continue;
    }
    const valueType = fieldOf(value, "type") as SemanticType;
    if (!convertibleTo(valueType, returns)) {
      problems.push(`${where}the body returns a ${typeText(valueType)} and is declared to return a ${typeText(returns)}`);
    }
    const reason = wideningReason(value, returns);
    if (reason !== null) problems.push(`${where}the body returns a ${typeText(valueType)} where a ${typeText(returns)} is read, and ${reason}`);
    const finalScope = fieldOf(placed, "final") as Scope;
    const visible = fieldOf(finalScope, "visible") as Set<string>;
    for (const read of localNames(value)) {
      if (!visible.has(read)) {
        problems.push(`${where}returns ${read}, which the block it is written in does not hold`);
      }
    }
    for (const one of valueTypeProblemsDeep(where, value, context)) problems.push(one);
  }

  return problems;
}

/* -------------------------------------------------------------------------- */
/* Rule 2b: independence                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A loop the IR says is parallel is a loop the compiler has to agree is
 * parallel.
 *
 * The mark normally arrives from `semantics/parallel.ts`, which is the analysis
 * that sets it and does not set a mark it has not proved. It also arrives from
 * IR text: a body written by a model, or by a person reading `blaze ir`, can
 * carry the word, and a loop that calls its turns independent when they are not
 * is a program with a race in it rather than a program that is a little slower.
 * So the claim is proved here as well, and a loop that fails is refused with the
 * reason the analysis gives.
 */
/**
 * The loops whose marks about memory the validator will not take on trust.
 *
 * A `region` mark in IR text is a claim that everything a turn allocates is
 * dead by the end of that turn. It is proved here rather than believed for the
 * same reason the `parallel` mark is: a mark written by hand or by a model that
 * is wrong is a program whose storage is rewound under a value that is still
 * wanted, which is a program that corrupts itself rather than one that is a
 * little slower.
 */
function regionProblems(context: Context, tree: Tree): string[] {
  const problems: string[] = [];

  for (const placed of fieldOf(tree, "statements") as readonly { statement: SemanticStatement; block: PlacedBlock }[]) {
    const statement = fieldOf(placed, "statement") as SemanticStatement;
    if (statement.k !== "loop") continue;
    const loop = fieldOf(statement, "loop") as SemanticLoop;
    if (loop.kind !== "counted" && loop.kind !== "each") continue;
    if (fieldOf(loop, "region") !== true) continue;
    const block = fieldOf(placed, "block") as PlacedBlock;
    const refusal = regionRefusalFor(loop, fieldOf(context, "callees") as Callees);
    if (refusal !== null) {
      problems.push(`${label(String(fieldOf(fieldOf(block, "block"), "id")), Number(fieldOf(statement, "line")))}loop is marked region but ${refusal}`);
    }
  }

  // Each mark above is proved on its own, so two of them on one path are two
  // marks each of which is individually sound and jointly a corruption: the
  // runtime keeps one cursor and rewinds it on entry rather than pushing, so the
  // inner turn is given the base block the outer turn is still filling and every
  // block that turn took before the inner loop began is handed out a second
  // time. Proving each separately cannot see it, so the shape is refused here.
  for (const outer of markedRegionLoops(tree)) {
    const outerLoop = fieldOf(outer, "loop") as MarkedLoop;
    if (firstMarkedRegionWithin(fieldOf(outerLoop, "body") as SemanticBlock) !== null) {
      const outerStatement = fieldOf(outer, "statement") as SemanticStatement;
      const outerBlock = fieldOf(outer, "block") as PlacedBlock;
      problems.push(
        `${label(String(fieldOf(fieldOf(outerBlock, "block"), "id")), Number(fieldOf(outerStatement, "line")))}loop is marked region around a loop that is also marked region, and a rewind inside a marked loop writes over what the outer turn took`,
      );
    }
  }

  return problems;
}

/** Every marked region loop of a tree, paired with the statement that holds it. */
function markedRegionLoops(tree: Tree): { block: PlacedBlock; statement: SemanticStatement; loop: MarkedLoop }[] {
  const found: { block: PlacedBlock; statement: SemanticStatement; loop: MarkedLoop }[] = [];
  for (const placed of fieldOf(tree, "statements") as readonly { statement: SemanticStatement; block: PlacedBlock }[]) {
    const statement = fieldOf(placed, "statement") as SemanticStatement;
    if (statement.k !== "loop") continue;
    const loop = fieldOf(statement, "loop") as SemanticLoop;
    if (loop.kind !== "counted" && loop.kind !== "each") continue;
    if (fieldOf(loop, "region") !== true) continue;
    found[found.length] = { block: fieldOf(placed, "block") as PlacedBlock, statement, loop: loop as MarkedLoop };
  }
  return found;
}

/** A marked region loop somewhere inside a body, at any depth, or null. */
function firstMarkedRegionWithin(body: SemanticBlock): MarkedLoop | null {
  for (const statement of fieldOf(body, "statements") as readonly SemanticStatement[]) {
    if (statement.k === "loop") {
      const loop = fieldOf(statement, "loop") as SemanticLoop;
      if (loop.kind === "counted" || loop.kind === "each") {
        if (fieldOf(loop, "region") === true) return loop;
      }
      const found = firstMarkedRegionWithin(fieldOf(loop, "body") as SemanticBlock);
      if (found !== null) return found;
      continue;
    }
    for (const nested of statementBlocksOf(statement)) {
      const found = firstMarkedRegionWithin(nested);
      if (found !== null) return found;
    }
  }
  return null;
}

function parallelProblems(context: Context, tree: Tree): string[] {
  const problems: string[] = [];

  for (const placed of fieldOf(tree, "statements") as readonly { statement: SemanticStatement; block: PlacedBlock }[]) {
    const statement = fieldOf(placed, "statement") as SemanticStatement;
    if (statement.k !== "loop") continue;
    const loop = fieldOf(statement, "loop") as SemanticLoop;
    if (loop.kind !== "counted" && loop.kind !== "each") continue;
    if (fieldOf(loop, "parallel") !== true) continue;
    const block = fieldOf(placed, "block") as PlacedBlock;
    const where = label(String(fieldOf(fieldOf(block, "block"), "id")), Number(fieldOf(statement, "line")));
    const refusal = refusalFor(loop, fieldOf(context, "callees") as Callees);
    if (refusal !== null) {
      problems.push(`${where}loop is marked parallel but ${refusal}`);
    }
    // The reduction clauses are the other mark a body carries about itself, and
    // they are proved rather than believed for the same reason the parallel mark
    // is. The C backend writes each one as `#pragma omp parallel for
    // reduction(op:name)`, which holds that accumulator private to the thread for
    // the length of the body and combines the per-thread copies at the end, so a
    // clause the body does not perform — a product where the turns add, a name
    // the body never accumulates into — is a program whose answer is a number no
    // turn computed. `refusalFor` above derives the clauses the body really has
    // and never reads the ones written beside the mark, so IR text carries any
    // it likes.
    const derived = reductionsFor(fieldOf(loop, "body") as SemanticBlock, loop.kind === "counted" ? String(fieldOf(loop, "variable")) : String(fieldOf(loop, "index")));
    for (const reduction of (fieldOf(loop, "reductions") as readonly { name: string; op: string }[] | undefined) ?? []) {
      const performed = derived.get(reduction.name);
      if (performed === undefined) {
        problems.push(`${where}loop is marked parallel with a reduction on "${reduction.name}", and its body accumulates into no name`);
      } else if (String(fieldOf(performed, "op")) !== reduction.op) {
        const verb = String(fieldOf(performed, "op")) === "+" ? "adds into" : "multiplies into";
        problems.push(`${where}loop is marked parallel with a ${reduction.op} reduction on "${reduction.name}", and its body ${verb} it`);
      }
    }
  }

  return problems;
}

/**
 * A body with no way out is a function that never returns: every block of it
 * ends in a way that carries on, so the entry block is where the run ends, and
 * a return written anywhere but the end of what the block around it can reach
 * is a return that ends the function before the block is done.
 */
function wayOutProblems(fn: SemanticFunction, tree: Tree): string[] {
  const problems: string[] = [];

  for (const placed of fieldOf(tree, "blocks") as readonly PlacedBlock[]) {
    const block = fieldOf(placed, "block") as SemanticBlock;
    const where = label(String(fieldOf(block, "id")), undefined);
    if (block === fieldOf(fn, "entry")) {
      const terminator = fieldOf(block, "terminator") as SemanticBlock["terminator"];
      // An entry block that ends where nothing arrives returns from every path,
      // which is what a return is: the two say the same thing about a function,
      // and the statements the block holds after the `if` that proved it are the
      // ones the program never runs.
      const terminatorKind = String(fieldOf(terminator, "k"));
      if (terminatorKind !== "return" && terminatorKind !== "unreachable") {
        problems.push(`entry: the entry block ends in ${terminatorKind} rather than in a return`);
      }
      continue;
    }
    // A return in an arm or a loop body is an early return, and the block
    // around it still has a way through that does not return. A return in a
    // block of its own is not: it ends the function, and every statement the
    // block around it writes after it is a statement nothing reaches.
    const terminator = fieldOf(block, "terminator") as SemanticBlock["terminator"];
    if (String(fieldOf(terminator, "k")) === "return" && fieldOf(placed, "guarded") !== true && Number(fieldOf(placed, "rest")) > 0) {
      const parent = fieldOf(placed, "parent") as PlacedBlock | null;
      const around = parent === null ? "the body" : String(fieldOf(fieldOf(parent, "block"), "id"));
      problems.push(`${where}returns, and ${Number(fieldOf(placed, "rest"))} statements of ${around} after it are never reached`);
    }
  }

  return problems;
}

/**
 * A parameter is one value of the type the signature declares, read by the
 * name the signature gives it. A parameter that is not a value slot is a
 * parameter a backend would have to give a home of its own, and a parameter
 * whose type is not the declared one is a body reading what the caller did not
 * pass.
 */
function parameterProblems(fn: SemanticFunction, contract?: FunctionContract): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const params = fieldOf(fn, "params") as readonly { name: string; kind: string; type: SemanticType }[];

  for (const param of params) {
    const paramName = String(fieldOf(param, "name"));
    if (seen.has(paramName)) {
      problems.push(`${paramName}: the function takes a parameter of that name twice`);
    }
    seen.add(paramName);
    if (String(fieldOf(param, "kind")) !== "value") {
      problems.push(`${paramName}: a parameter is one value, and this one is a ${String(fieldOf(param, "kind"))}`);
      continue;
    }
    const paramType = fieldOf(param, "type") as SemanticType;
    if (!isSemanticType(paramType)) {
      problems.push(`${paramName}: a parameter is read as ${typeText(paramType)}, which is not a type`);
    }
  }

  if (contract !== undefined) {
    const signature = fieldOf(contract, "function") as FunctionSignature;
    const declared = fieldOf(signature, "params") as readonly { name: string; type: string }[];
    if (declared.length !== params.length) {
      problems.push(`the body takes ${params.length} parameters and the signature declares ${declared.length}`);
    }
    for (let index = 0; index < declared.length; index += 1) {
      const expected = declared[index];
      const held = params[index];
      if (expected === undefined || held === undefined) continue;
      const expectedName = String(fieldOf(expected, "name"));
      const heldName = String(fieldOf(held, "name"));
      if (heldName !== expectedName) {
        problems.push(`parameter ${index + 1} is ${heldName} and the signature declares ${expectedName}`);
      }
      const wanted = contractType(String(fieldOf(expected, "type")));
      if (wanted === null) {
        problems.push(`parameter ${index + 1} declares a type that is not a type`);
        continue;
      }
      const heldType = fieldOf(held, "type") as SemanticType;
      if (String(fieldOf(held, "kind")) === "value" && !convertibleTo(heldType, wanted)) {
        problems.push(`${heldName} is read as a ${typeText(heldType)} and the signature declares a ${typeText(wanted)}`);
      }
    }
  }

  return problems;
}

/**
 * A function that allocates builds an object and hands it to its caller, so no
 * block of its body frees it: the name the return hands back is the caller's to
 * free, and a body that frees it frees what its caller is about to read. A
 * body that frees a name it does not own is the same problem it is for a
 * program, and the shared rules above already report it.
 */
function allocationProblems(fn: SemanticFunction, tree: Tree): string[] {
  if (fieldOf(fn, "allocates") !== true) return [];
  const problems: string[] = [];

  for (const placed of fieldOf(tree, "blocks") as readonly PlacedBlock[]) {
    const block = fieldOf(placed, "block") as SemanticBlock;
    const where = label(String(fieldOf(block, "id")), undefined);
    const terminator = fieldOf(block, "terminator") as SemanticBlock["terminator"];
    const returned = String(fieldOf(terminator, "k")) === "return" ? returnedName(fieldOf(terminator, "value") as SemanticValue | null) : null;
    for (const release of fieldOf(block, "releases") as readonly string[]) {
      if (returned !== null && String(release) === String(returned)) {
        problems.push(`${where}frees ${release}, which the caller of the function owns`);
      }
    }
    if (String(fieldOf(terminator, "k")) === "jump") {
      for (const release of fieldOf(terminator, "releases") as readonly string[]) {
        if (returned !== null && String(release) === String(returned)) {
          problems.push(`${where}frees ${release} on the way out, which the caller of the function owns`);
        }
      }
    }
  }

  return problems;
}

/**
 * The conditions a function is held to are the contract's own text: they are
 * claims about the function rather than things it does, and they are checked
 * where the contract is parsed. So nothing here types them, and nothing here
 * may — this says only that the IR carries a condition that is there at all.
 */
function conditionProblems(fn: SemanticFunction): string[] {
  const problems: string[] = [];
  const requires = fieldOf(fn, "requires") as readonly string[];
  const ensures = fieldOf(fn, "ensures") as readonly string[];
  for (const one of requires) {
    if (one.trim() === "") problems.push("a precondition of the function is empty");
  }
  for (const one of ensures) {
    if (one.trim() === "") problems.push("a postcondition of the function is empty");
  }
  return problems;
}

/**
 * Every way a function is not a function a backend may lower. Every function
 * has a body, so every function is checked as one; what a postcondition adds is
 * the conditions beside it, and those are checked where they are parsed.
 * The context is what the body is read against: a function carries the layouts
 * its own body writes, and the program contract, where the caller has one,
 * names every function the body may call.
 */
function functionProblems(
  fn: SemanticFunction,
  contract: FunctionContract | undefined,
  program: ProgramContract | undefined,
  callees: Callees,
): string[] {
  const entry = fieldOf(fn, "entry") as SemanticBlock;
  const tree = readFunctionTree(fn, entry);
  const context = functionContext(fn, callees, program);
  const found = [
    ...conditionProblems(fn),
    ...parameterProblems(fn, contract),
    ...bodyProblems(context, functionBody(entry, tree), tree),
    ...returnProblems(fn, context, tree),
    ...wayOutProblems(fn, tree),
    ...allocationProblems(fn, tree),
  ];
  // Every message names the function it is about, so a file of them is read one
  // function at a time: a block is called b1 in every function of a file, so
  // the function is what tells two of them apart.
  const named: string[] = [];
  for (const problem of found) named.push(`${String(fieldOf(fn, "symbol"))}: ${problem}`);
  return named;
}

/**
 * Every way a function is not a function a backend may lower. A function
 * checked on its own is checked against its own contract, which is not the
 * whole program, so a call it cannot resolve is left to the module check.
 */
export function semanticFunctionProblems(
  fn: SemanticFunction,
  contract?: FunctionContract,
  callees: Callees = new Map(),
): string[] {
  return functionProblems(fn, contract, undefined, callees);
}

/** The same, for every function of a file, in the order the file declares them. */
export function semanticModuleProblems(
  module: SemanticModule,
  program?: ProgramContract,
  callees?: Callees,
): string[] {
  const defaultCallees = new Map<string, SemanticFunction>();
  const functions = fieldOf(module, "functions") as readonly SemanticFunction[];
  for (const fn of functions) defaultCallees.set(String(fieldOf(fn, "name")), fn);
  const resolvedCallees: Callees = callees === undefined ? defaultCallees : callees;
  const problems: string[] = [];
  for (const fn of functions) {
    const contract = contractedFunction(program, String(fieldOf(fn, "symbol")));
    problems.push(...functionProblems(fn, contract ?? undefined, program, resolvedCallees));
  }
  return problems;
}

/** Refuses a program that is not one. Throws one CompilerError. */
export function validateSemanticProgram(program: SemanticProgram, contract?: ProgramContract, callees?: Callees): void {
  refuse(`${String(fieldOf(program, "file"))} is not a program the compiler may lower`, semanticIrProblems(program, contract, callees));
}

/** Refuses a function that is not one. Throws one CompilerError. */
export function validateSemanticFunction(
  fn: SemanticFunction,
  contract?: FunctionContract,
  callees: Callees = new Map(),
): void {
  refuse(`${String(fieldOf(fn, "symbol"))} is not a function the compiler may lower`, semanticFunctionProblems(fn, contract, callees));
}

/** Refuses a module holding a function that is not one. Throws one CompilerError. */
export function validateSemanticModule(module: SemanticModule, program?: ProgramContract, callees?: Callees): void {
  refuse(`${String(fieldOf(module, "path"))} is not a module the compiler may lower`, semanticModuleProblems(module, program, callees));
}

/** The one error a caller is given: what it read, and everything wrong with it. */
function refuse(message: string, problems: string[]): void {
  if (problems.length === 0) return;
  throw new CompilerError("SemanticIrError", "ir", message, problems.join("\n"), "", "", "");
}

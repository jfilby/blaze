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
import type { Effect, FunctionContract, FunctionSignature, ObjectLayout, ProgramContract } from "../core/types.ts";
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
import { NO_CALLEES, reductionsFor, refusalFor, type Callees } from "./parallel.ts";
import { refusalFor as regionRefusalFor } from "./region.ts";

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
  const last = block.statements[block.statements.length - 1];
  if (last === undefined) return false;
  if (last.k === "raise") return true;
  if (last.k === "loop" && last.loop.kind === "while" && last.loop.neverExits === true) {
    return true;
  }
  if (last.k !== "if" || last.otherwise === null) return false;
  return last.then.terminator.k !== "next" && last.otherwise.terminator.k !== "next";
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
  return { objects: program.objects, functions: program.functions, callees, contract, declared: [] };
}

/** What a function body is checked against: what the function itself holds. */
function functionContext(fn: SemanticFunction, callees: Callees, program?: ProgramContract): Context {
  return {
    objects: fn.objects,
    functions: program === undefined ? null : signaturesOf(program),
    callees,
    contract: program,
    declared: [fn.name, fn.symbol, ...fn.params.map((param) => param.name)],
  };
}

/** Every signature the program contract declares, in the order it declares them. */
function signaturesOf(program: ProgramContract): FunctionSignature[] {
  const signatures: FunctionSignature[] = [];
  for (const file of program.files) {
    for (const declared of Object.values(file.functions)) signatures.push(declared.function);
  }
  return signatures;
}

/** A program body, read as a body of its own. */
function programBody(program: SemanticProgram, tree: Tree): Body {
  return { entry: program.entry, tree, subject: "a program", own: "the program", single: true };
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
  const slots = new Map(scope.slots);
  slots.set(slot.name, slot);
  const visible = new Set(scope.visible);
  visible.add(slot.name);
  return { slots, visible };
}

/** A scope with the names a loop hands its body added, which the body never frees. */
function innerScope(scope: Scope, slots: SemanticSlot[]): Scope {
  if (slots.length === 0) return scope;
  const inner = new Map(scope.slots);
  const visible = new Set(scope.visible);
  for (const slot of slots) {
    inner.set(slot.name, slot);
    visible.add(slot.name);
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
  tree.blocks.push(placed);

  let current = scope;
  for (let at = 0; at < block.statements.length; at += 1) {
    const statement = block.statements[at];
    tree.statements.push({ statement, block: placed, scope: current });
    if (statement.k === "let") {
      current = declaring(current, statement.slot);
      placed.own.push(statement.slot.name);
      continue;
    }
    const after = block.statements.length - at - 1;
    if (statement.k === "if") {
      walkBlock(statement.then, loops, current, tree, placed, true, after);
      if (statement.otherwise !== null) {
        walkBlock(statement.otherwise, loops, current, tree, placed, true, after);
      }
      continue;
    }
    if (statement.k === "block") {
      walkBlock(statement.body, loops, current, tree, placed, guarded, after);
      continue;
    }
    if (statement.k === "loop") {
      const frame: LoopFrame = { loop: statement.loop, container: block, body: null };
      tree.loops.push(frame);
      frame.body = walkBlock(
        statement.loop.body,
        [...loops, frame],
        innerScope(current, loopSlots(statement.loop)),
        tree,
        placed,
        true,
        after,
      );
    }
  }
  placed.final = current;

  return placed;
}

/** The whole program as a tree, each block placed in the blocks around it. */
function readTree(program: SemanticProgram): Tree {
  const tree: Tree = { blocks: [], statements: [], loops: [] };
  walkBlock(program.entry, [], { slots: new Map(), visible: new Set() }, tree);
  return tree;
}

/**
 * A function's body as a tree, with the parameters already declared: a
 * parameter is a name the body reads that no `let` of the body declares, so
 * the rules about names are the rules a program is checked by.
 */
function readFunctionTree(fn: SemanticFunction, entry: SemanticBlock): Tree {
  const tree: Tree = { blocks: [], statements: [], loops: [] };
  walkBlock(entry, [], innerScope({ slots: new Map(), visible: new Set() }, fn.params), tree);
  return tree;
}

/** The name a body hands its caller back, where it hands back a name at all. */
function returnedName(value: SemanticValue | null): string | null {
  if (value === null) return null;
  return value.k === "local" ? value.name : null;
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
      return [statement.value];
    case "fill":
      return [statement.value];
    case "raise":
      return [statement.message];
    case "setElement":
      return [statement.index, statement.value];
    case "if":
      return [statement.condition];
    case "storeField":
      return [statement.object, statement.value];
    case "call":
      // The arguments are what the call is made of, and a call written into one
      // is a call the body makes. The call itself is checked where it is
      // written rather than here, so it is not listed again.
      return [...statement.call.args];
    case "loop":
      if (statement.loop.kind === "while" || statement.loop.kind === "doWhile") return [statement.loop.condition];
      if (statement.loop.kind === "counted") {
        return statement.loop.step === null
          ? [statement.loop.from, statement.loop.to]
          : [statement.loop.from, statement.loop.to, statement.loop.step];
      }
      return [statement.loop.length];
    default:
      return [];
  }
}

/** Every call a statement makes, the statement's own call last. */
function statementCalls(statement: SemanticStatement): SemanticCall[] {
  const calls: SemanticCall[] = [];
  for (const value of statementValues(statement)) {
    walked(value, (inner) => {
      if (inner.k === "call") calls.push(inner.call);
    });
  }
  if (statement.k === "call") calls.push(statement.call);
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
  const tree = body.tree;

  for (const placed of tree.blocks) {
    if (ids.has(placed.block.id)) {
      problems.push(`${label(placed.block.id)}the block id is used by more than one block`);
      continue;
    }
    ids.add(placed.block.id);
  }

  // The entry block of a program is the one block the IR names, so that a model
  // writing a program back out writes the same program. A function's blocks are
  // named by the lowering that wrote them, and the function is named instead.
  if (body.single && body.entry.id !== "entry") {
    problems.push(`entry: the program's entry block is "${body.entry.id}" rather than entry`);
  }

  const headers = new Set(tree.loops.map((frame) => frame.loop.header));

  for (const placed of tree.blocks) {
    const where = label(placed.block.id);
    const terminator = placed.block.terminator;
    const isEntry = placed.block === body.entry;
    if (TERMINATOR_KINDS[terminator.k] !== true) {
      problems.push(`${where}the block ends in nothing ${body.subject} may end in`);
      continue;
    }
    if (terminator.k === "return" && body.single && !isEntry) {
      problems.push(`${where}only the entry block ends ${body.own}`);
    }
    if (terminator.k === "unreachable" && !endsByLeaving(placed.block)) {
      // A block that ends where nothing arrives is a claim, and a claim a model
      // or a person writes into IR text is proved here rather than believed:
      // something in the block has to leave, or control does continue past it
      // and the block is ordinary.
      problems.push(`${where}the block ends where nothing arrives, but nothing in it leaves`);
      continue;
    }
    if (terminator.k === "jump" && !ids.has(terminator.target) && !headers.has(terminator.target)) {
      problems.push(`${where}jumps to ${terminator.target}, which is not a block of the program`);
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
 * once, which is a loop the language allows, so nothing here asks a body to
 * reach its header.
 */
function controlFlowProblems(tree: Tree): string[] {
  const problems: string[] = [];

  for (const placed of tree.blocks) {
    const terminator = placed.block.terminator;
    if (terminator.k !== "jump") continue;
    const target = terminator.target;
    const continues = placed.loops.some((frame) => frame.loop.header === target);
    const breaks = placed.loops.some((frame) => frame.container.id === target);
    if (!continues && !breaks) {
      problems.push(`${label(placed.block.id)}jump to ${target} leaves no loop`);
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

  for (const placed of tree.statements) {
    const { statement, scope, block } = placed;
    const prefix = label(block.block.id, statement.line);
    const writes: string[] = [];
    if (statement.k === "set" || statement.k === "step") writes.push(statement.name);
    if (statement.k === "setElement" || statement.k === "fill") {
      const buffer = scope.slots.get(statement.buffer);
      if (buffer === undefined) {
        problems.push(`${prefix}"${statement.buffer}" is not declared where it is written`);
      } else if (!isSequence(slotType(buffer))) {
        // What a name has to hold to have an element written into it is a
        // sequence, not a slot of one kind: a program allocates the array it
        // writes and a function is handed a slice as a parameter, and both are
        // written the same way.
        problems.push(`${prefix}"${statement.buffer}" is a ${typeText(slotType(buffer))}, which has no elements to write`);
      }
      // The count a `fill` writes from is not checked here. A `fill` written as
      // `array.fill(value)` fills from the first element, and the position it
      // starts at is a name the compiler made rather than one the source
      // declared, so asking whether it is in scope refuses every fill a program
      // writes. The value a fill writes is a value like any other, and is
      // checked above with the calls written into it.
    }
    if (statement.k === "loop" && statement.loop.kind === "each") {
      if (!scope.visible.has(statement.loop.of)) {
        problems.push(`${prefix}"${statement.loop.of}" is not declared where it is read`);
      } else {
        // The element is declared as the type the walk reads it at, and the C
        // emitter declares it as that type too: an element of a `[]f64` read
        // as an `i32` is the low half of each double, with no diagnostic.
        const held = scope.slots.get(statement.loop.of);
        const element = held === undefined ? null : elementTypeOf(slotType(held));
        if (element !== null && !typeEquals(element, statement.loop.elementType)) {
          problems.push(`${prefix}an element of a ${typeText(slotType(held as SemanticSlot))} is a ${typeText(element)}, not a ${typeText(statement.loop.elementType)}`);
        }
      }
    }

    for (const name of writes) {
      const slot = scope.slots.get(name);
      if (slot === undefined) {
        problems.push(`${prefix}"${name}" is not declared where it is written`);
        continue;
      }
      // A name the source declared as a constant is a binding rather than a
      // place, and writing one mutates a binding the program did not declare
      // mutable: a parameter is written the same way, and an element of a walk
      // is written by the walk itself. The resolver holds to this, so a body
      // that breaks it is IR written by hand or by a model, and nothing
      // downstream checks it again.
      if (!slot.mutable) {
        problems.push(`${prefix}"${name}" is not a name that can be written`);
        continue;
      }
      if (statement.k === "set" && statement.op !== "=") {
        problems.push(...compoundProblems(slotType(slot), statement.value, statement.op, prefix, name));
      }
    }

    for (const value of statementValues(statement)) {
      for (const read of localNames(value)) {
        if (!scope.visible.has(read)) problems.push(`${prefix}"${read}" is not declared where it is read`);
      }
      problems.push(...readTypeProblems(prefix, value, scope));
    }
  }

  for (const placed of tree.blocks) {
    const end = placed.block.terminator;
    if (end.k !== "return" || end.value === null) continue;
    problems.push(...readTypeProblems(label(placed.block.id), end.value, placed.final));
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
  walkValues(value, (inner) => {
    if (inner.k !== "local") return;
    const slot = scope.slots.get(inner.name);
    if (slot === undefined) return;
    const held = slotType(slot);
    if (!narrowsTo(held, inner.type)) {
      problems.push(`${prefix}"${inner.name}" holds a ${typeText(held)} and is read as a ${typeText(inner.type)}, which cannot hold it`);
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

  if (!isSemanticType(value.type)) problems.push(`${prefix}${typeText(value.type)} is not a type`);

  switch (value.k) {
    case "text":
      if (!isTextType(value.type)) problems.push(`${prefix}a string is written as a ${typeText(value.type)}`);
      return problems;
    case "bool":
      if (!isBoolean(value.type)) problems.push(`${prefix}a truth is written as a ${typeText(value.type)}`);
      return problems;
    case "local":
    case "nothing":
    case "const":
      return problems;
    case "length":
      if (!isSequence(value.of.type) && !isTextType(value.of.type)) {
        problems.push(`${prefix}length reads a ${typeText(value.of.type)}, which has no length`);
      }
      if (!isNumber(value.type)) {
        problems.push(`${prefix}the length of a ${typeText(value.of.type)} is written as a ${typeText(value.type)}`);
      }
      return problems;
    case "element": {
      if (!isSequence(value.of.type)) {
        problems.push(`${prefix}an element is read out of a ${typeText(value.of.type)}, which is not a sequence`);
        return problems;
      }
      // An index is a whole number, and the source may write one as a double —
      // a loop counting in fractions indexes just as well. What has to be a
      // number is the index: a truth or a reference is not a place in an array,
      // and a target has no way to read one as one.
      if (!isNumber(value.index.type)) {
        problems.push(`${prefix}an element is read at a ${typeText(value.index.type)}, which is not a number`);
      }
      const element = elementTypeOf(value.of.type);
      if (element !== null && !typeEquals(element, value.type)) {
        problems.push(`${prefix}an element of a ${typeText(value.of.type)} is a ${typeText(element)}, not a ${typeText(value.type)}`);
      }
      return problems;
    }
    case "buffer": {
      if (value.length === null) {
        // The count the program settled on is a value, and a view writes no
        // values of its own: what it holds is the block it looks into.
        if (value.count === null) {
          problems.push(`${prefix}the array declares no elements and settles on no count`);
        } else if (!isNumber(value.count.type)) {
          problems.push(`${prefix}the array is settled on a ${typeText(value.count.type)}, which is not a number`);
        }
        if (value.view === null && value.values.length > 0) {
          problems.push(`${prefix}the array settles on a count and writes ${value.values.length} value(s) out`);
        }
        if (value.view !== null && (!isReference(value.view.of.type) || !isSequence(value.view.of.type))) {
          problems.push(`${prefix}a view is taken of a ${typeText(value.view.of.type)}, which is not a block of bytes`);
        }
        if (value.view !== null && !isNumber(value.view.offset.type)) {
          problems.push(`${prefix}the view starts at a ${typeText(value.view.offset.type)}, which is not a number`);
        }
        return problems;
      }
      if (value.view !== null) {
        problems.push(`${prefix}a view declares ${value.length} elements of its own`);
      }
      if (value.values.length !== value.length) {
        problems.push(`${prefix}the array declares ${value.length} elements and writes ${value.values.length}`);
      }
      for (const element of value.values) {
        if (!convertibleTo(element.type, value.element)) {
          problems.push(`${prefix}the array holds a ${typeText(value.element)} and writes a ${typeText(element.type)}`);
          break;
        }
      }
      const element = elementTypeOf(value.type);
      if (element === null || !typeEquals(element, value.element)) {
        problems.push(`${prefix}the array is a ${typeText(value.type)} and holds a ${typeText(value.element)}`);
      }
      return problems;
    }
    case "newObject": {
      // A field of an object being built is read the way a field of an object
      // already built is read: the layout must be one the program lays out, the
      // field must be one of its fields, and what is written must be readable
      // as the type the layout gives that field.
      if (value.layout !== "JSON" && !isLayout(context, value.layout) && !isContractLayout(context.contract, value.layout)) {
        problems.push(`${prefix}the object ${value.layout} is not a layout the program lays out`);
        return problems;
      }
      for (const field of value.fields) {
        problems.push(...layoutProblems(prefix, value.layout, field.name, context));
        const declared = fieldType(value.layout, field.name, context);
        if (declared !== null) problems.push(...writeProblems(prefix, `${value.layout}.${field.name}`, declared, field.value));
      }
      return problems;
    }
    case "loadField": {
      problems.push(...layoutProblems(prefix, value.layout, value.field, context));
      const declared = fieldType(value.layout, value.field, context);
      if (declared !== null && !fieldReadsAs(declared, value.type)) {
        problems.push(`${prefix}${value.layout}.${value.field} is a ${typeText(declared)}, not a ${typeText(value.type)}`);
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
      if (isWideType(value.left.type) || isWideType(value.right.type) || isWideType(value.type)) {
        if (!WIDE_ARITHMETIC.has(value.op)) {
          problems.push(
            `${prefix}${value.op} is not defined over a ${typeText(value.left.type)} and a ${typeText(value.right.type)}; a wide number has an add, a subtraction, a product, a quotient, a remainder, the logical operations and the shifts`,
          );
        }
        const pair = widePairProblem(value.left, value.right, value.type, COUNTED_OPERATIONS.has(value.op));
        if (pair !== null) problems.push(`${prefix}${value.op}: ${pair}`);
        // A zero divisor is a number the language raises on, so it is refused by
        // name here rather than answered with the kernel's total zero: the
        // kernel's answer is a total function, and the language is not.
        if ((value.op === "div" || value.op === "mod") && value.right.k === "const") {
          try {
            const text = value.right.text.replace(/n$/, "").trim();
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
      if (value.op === "concat") {
        if (!isTextType(value.left.type) || !isTextType(value.right.type) || !isTextType(value.type)) {
          problems.push(`${prefix}concat is written over a ${typeText(value.left.type)} and a ${typeText(value.right.type)}`);
        }
        return problems;
      }
      if (value.op === "add" && (isTextType(value.left.type) || isTextType(value.right.type))) {
        if (!isTextType(value.type)) {
          problems.push(`${prefix}text added to a ${typeText(value.left.type)} and a ${typeText(value.right.type)} is a ${typeText(value.type)}`);
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
      if (WHOLE_OPERATIONS[value.op] === true) {
        if (!isInteger(value.type)) {
          problems.push(`${prefix}${value.op} of a ${typeText(value.left.type)} and a ${typeText(value.right.type)} is a ${typeText(value.type)}, which is not a whole number`);
          return problems;
        }
        if (!isNumber(value.left.type) || !isNumber(value.right.type)) {
          problems.push(`${prefix}${value.op} over a ${typeText(value.left.type)} and a ${typeText(value.right.type)}`);
        }
        return problems;
      }
      // A power is the one arithmetic operation no target has over whole
      // numbers: `pow` takes and hands back a double, so writing the result as
      // a whole number is a truncation, and `2 ** 40` is 1099511627776 rather
      // than what a 32 bit answer would hold. The resolver gives it a double,
      // whatever the operands are.
      if (value.op === "pow" && isInteger(value.type)) {
        problems.push(`${prefix}pow of a ${typeText(value.left.type)} and a ${typeText(value.right.type)} is a ${typeText(value.type)}, which is not a floating value`);
        return problems;
      }
      // What an operation is written as is one of the two types it works on —
      // `length - 10` is a double and `10 - length` is a whole number, because
      // that is what the language says — and both sides convert to it.
      if (!isNumber(value.left.type) || !isNumber(value.right.type)) {
        problems.push(`${prefix}${value.op} over a ${typeText(value.left.type)} and a ${typeText(value.right.type)}`);
        return problems;
      }
      // A shift is written as the type of what it shifts, and `>>>` is the one
      // that converts: JavaScript reads both of its sides as 32 bit unsigned
      // numbers whatever they are, so its answer is its own type and not the
      // type of either side.
      const expected = value.op === "shl" || value.op === "shr" ? value.left.type : value.type;
      // `>>>` is the one shift that converts, so it is not written as the type
      // of either side: both are read as the unsigned 32 bit numbers the
      // language reads them as, and what it answers is one of those.
      if (value.op === "ushr") {
        if (!convertibleTo(value.left.type, value.type) || !convertibleTo(value.right.type, value.type)) {
          problems.push(`${prefix}${value.op} of a ${typeText(value.left.type)} and a ${typeText(value.right.type)} is a ${typeText(value.type)}`);
        }
        return problems;
      }
      // A whole pair added, subtracted, multiplied or divided answers a double,
      // and that is the language's own answer rather than a type the IR chose:
      // a program counts in whole numbers and computes in doubles, so `i * i`
      // over a loop index is a double on both sides of the language and here.
      const widened =
        isFloat(value.type) && isInteger(value.left.type) && isInteger(value.right.type) && value.op !== "min" && value.op !== "max";
      if (!widened && !typeEquals(expected, value.left.type) && !typeEquals(expected, value.right.type)) {
        problems.push(`${prefix}${value.op} of a ${typeText(value.left.type)} and a ${typeText(value.right.type)} is a ${typeText(value.type)}, which is neither`);
        return problems;
      }
      if (!convertibleTo(value.left.type, value.type) || !convertibleTo(value.right.type, value.type)) {
        problems.push(`${prefix}${value.op} of a ${typeText(value.left.type)} and a ${typeText(value.right.type)} is a ${typeText(value.type)}`);
      }
      return problems;
    }
    case "compare":
      if (!isBoolean(value.type)) {
        problems.push(`${prefix}a comparison is written as a ${typeText(value.type)}`);
      }
      if (!comparableTo(value.left, value.operand)) {
        problems.push(`${prefix}${value.op} compares a ${typeText(value.left.type)} as a ${typeText(value.operand)}`);
      }
      if (!comparableTo(value.right, value.operand)) {
        problems.push(`${prefix}${value.op} compares a ${typeText(value.right.type)} as a ${typeText(value.operand)}`);
      }
      // A wide number is compared by the kernel, over two of them. The operand
      // is what the comparison is read at, so a wide number beside an operand
      // that is not one is a comparison no backend has an instruction for: the
      // C backend casts a struct to whatever the operand is and writes it into a
      // C comparison, and the machine backend asks for the width a wide number
      // does not have. The count of a shift is the one narrower number a wide
      // number may be beside, and it is not a comparison.
      const pair = widePairProblem(value.left, value.right, value.operand, false);
      if (pair !== null) problems.push(`${prefix}${value.op}: ${pair}`);
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
      const arms: [SemanticType, SemanticType] = [value.left.type, value.right.type];
      const holds = arms.filter((arm) => convertibleTo(arm, value.type));
      // The arms are both of the type, or one of them is the test that decides
      // whether the other is handed back and the other is of the type.
      const tests = arms.filter((arm) => isNumber(arm) || isBoolean(arm)).length;
      if (!(holds.length === arms.length || (holds.length === 1 && tests === 1))) {
        problems.push(`${prefix}${value.op} over a ${typeText(arms[0])} and a ${typeText(arms[1])} is a ${typeText(value.type)}`);
      }
      return problems;
    }
    case "isNull":
      if (!isBoolean(value.type)) problems.push(`${prefix}a null test is written as a ${typeText(value.type)}`);
      return problems;
    case "coalesce": {
      // `a ?? b` hands back one of its two arms, the way `&&` and `||` do, so
      // what it is written as is the type both of them convert to. The left arm
      // is the one that decides, and it is only a null test if it can be
      // nothing: a left arm that always holds leaves the right one dead, which
      // is a different program from the one that is written.
      for (const [what, arm] of [["left", value.left], ["right", value.right]] as const) {
        if (!convertibleTo(arm.type, value.type)) {
          problems.push(`${prefix}the ${what} arm of ?? is a ${typeText(arm.type)}, and the whole is a ${typeText(value.type)}`);
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
      for (const [what, arm] of [["then", value.then], ["otherwise", value.otherwise]] as const) {
        if (!convertibleTo(arm.type, value.type)) {
          problems.push(`${prefix}the ${what} arm of a conditional is a ${typeText(arm.type)}, and the whole is a ${typeText(value.type)}`);
        }
      }
      return problems;
    }
    case "unary": {
      if (value.op === "not") {
        if (!isBoolean(value.operand.type) || !isBoolean(value.type)) {
          problems.push(`${prefix}not is written over a ${typeText(value.operand.type)} as a ${typeText(value.type)}`);
        }
        return problems;
      }
      if (!isNumber(value.operand.type) || !isNumber(value.type)) {
        problems.push(`${prefix}${value.op} is written over a ${typeText(value.operand.type)} as a ${typeText(value.type)}`);
      }
      // A bitwise inversion is the operation on whole numbers its binary forms
      // are: there is no `~` of a double for a target to perform, so a body
      // that asks for one is refused here rather than handed to a compiler
      // that cannot read it.
      if (value.op === "bitNot" && !isInteger(value.type)) {
        problems.push(`${prefix}bitNot of a ${typeText(value.operand.type)} is a ${typeText(value.type)}, which is not a whole number`);
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
      if (value.op === "bitNot" || value.op === "neg") {
        const wide = isWideType(value.operand.type) ? value.operand.type : value.type;
        if (wide.kind === "primitive" && wide.name === "u256") {
          problems.push(`${prefix}${value.op} of a ${typeText(value.operand.type)} is a number below zero, and a wide number holds none`);
        }
      }
      return problems;
    }
    case "toText":
      if (!isTextType(value.type)) problems.push(`${prefix}text is read as a ${typeText(value.type)}`);
      return problems;
    case "argv":
      if (value.index !== null && !isNumber(value.index.type)) {
        problems.push(`${prefix}an argument is read at a ${typeText(value.index.type)}, which is not a number`);
      }
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
  if (isTextType(value.type) && isNumber(declared)) return problems;
  if (!convertibleTo(value.type, declared)) {
    problems.push(`${prefix}${what} is a ${typeText(declared)}, not a ${typeText(value.type)}`);
  }
  const reason = wideningReason(value, declared);
  if (reason !== null) problems.push(`${prefix}${what} is written where a ${typeText(declared)} is read, and ${reason}`);
  return problems;
}

/** A field of a layout the body lays out, and the type the layout gives it. */
function layoutProblems(prefix: string, layout: string, field: string, context: Context): string[] {
  if (layout === "JSON") return [];
  if (layout !== "JSON" && !isLayout(context, layout) && !isContractLayout(context.contract, layout)) {
    return [`${prefix}the object ${layout} is not a layout the program lays out`];
  }
  const found = layoutOf(context, layout);
  const declared = found?.fields.find((one) => one.name === field);
  if (declared === undefined) {
    return [`${prefix}${layout} has no field ${field}`];
  }
  return [];
}

/** The layout a body carries, wherever it came from. */
function layoutOf(context: Context, name: string): ObjectLayout | undefined {
  if (isLayout(context, name)) return context.objects[name];
  const contract = context.contract;
  if (contract === undefined) return undefined;
  for (const file of contract.files) {
    for (const declared of Object.values(file.functions)) {
      const found = declared.definition.objects[name];
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** The type a layout gives a field, as a type the IR states. */
function fieldType(layout: string, field: string, context: Context): SemanticType | null {
  if (layout === "JSON") return { kind: "primitive", name: "f64" };
  const found = layoutOf(context, layout);
  const declared = found?.fields.find((one) => one.name === field);
  return declared === undefined ? null : parseType(declared.type);
}

/** A layout the IR itself carries. */
function isLayout(context: Context, object: string): boolean {
  return Object.prototype.hasOwnProperty.call(context.objects, object);
}

/** A layout a contract lays out, which every function's body can reach. */
function isContractLayout(contract: ProgramContract | undefined, object: string): boolean {
  if (contract === undefined) return false;
  for (const file of contract.files) {
    for (const declared of Object.values(file.functions)) {
      if (Object.prototype.hasOwnProperty.call(declared.definition.objects, object)) return true;
    }
  }
  return false;
}

/** The conditions, prints, raises and retains a body writes. */
function typeProblems(context: Context, tree: Tree): string[] {
  const problems: string[] = [];

  for (const placed of tree.statements) {
    const { statement, block } = placed;
    const prefix = label(block.block.id, statement.line);

    if (statement.k === "printText" && !isTextType(statement.value.type)) {
      problems.push(`${prefix}print is given a ${typeText(statement.value.type)}, which is not text`);
    }
    if (statement.k === "printNumber" && !isNumber(statement.value.type)) {
      problems.push(`${prefix}a number is printed as a ${typeText(statement.value.type)}`);
    }
    // A bigint is the `i64` the language's `1n` is, and the `n` after it says
    // so. A value of any other width has no such spelling: a double is written
    // as the number it is and a whole number wider than a machine word is
    // written as its digits. A wide number is the one value written as a bigint
    // that is not an `i64`: the language has no `u256`, so every value that is
    // one here was written as a bigint, and the driver writes the marker after
    // the digits the formatter gives it.
    if (statement.k === "printNumber" && statement.bigint && !isWideType(statement.value.type)) {
      const printed = statement.value.type;
      if (printed.kind !== "primitive" || printed.name !== "i64") {
        problems.push(`${prefix}a bigint is printed as a ${typeText(printed)}, which is not the sixty-four bit whole number a bigint is`);
      }
    }
    if (statement.k === "raise" && !isTextType(statement.message.type)) {
      problems.push(`${prefix}a program is raised with a ${typeText(statement.message.type)}, which is not text`);
    }
    if (statement.k === "retain" && !isReference(statement.value.type) && !isTextType(statement.value.type)) {
      if (statement.value.k !== "call") {
        problems.push(`${prefix}a ${typeText(statement.value.type)} is nothing to keep alive`);
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
      const declared = slotType(statement.slot);
      if (!convertibleTo(statement.value.type, declared)) {
        problems.push(`${prefix}"${statement.slot.name}" holds a ${typeText(declared)}, not a ${typeText(statement.value.type)}`);
      }
      const reason = wideningReason(statement.value, declared);
      if (reason !== null) problems.push(`${prefix}"${statement.slot.name}" is written where a ${typeText(declared)} is read, and ${reason}`);
    }
    if (statement.k === "set" && statement.op === "=") {
      const slot = placed.scope.slots.get(statement.name);
      const declared = slot === undefined ? null : slotType(slot);
      if (declared !== null && !convertibleTo(statement.value.type, declared)) {
        problems.push(`${prefix}"${statement.name}" holds a ${typeText(declared)}, not a ${typeText(statement.value.type)}`);
      }
      if (declared !== null) {
        const reason = wideningReason(statement.value, declared);
        if (reason !== null) problems.push(`${prefix}"${statement.name}" is written where a ${typeText(declared)} is read, and ${reason}`);
      }
    }
    if (statement.k === "step") {
      const slot = placed.scope.slots.get(statement.name);
      const declared = slot === undefined ? null : slotType(slot);
      if (declared !== null && !isNumber(declared)) {
        problems.push(`${prefix}"${statement.name}" is a ${typeText(declared)}, which is not a number a step can move`);
      }
    }
    if (statement.k === "setElement") {
      const buffer = placed.scope.slots.get(statement.buffer);
      const element = buffer === undefined ? null : elementTypeOf(slotType(buffer));
      if (element !== null) {
        if (statement.op === "=") {
          if (!convertibleTo(statement.value.type, element)) {
            problems.push(`${prefix}"${statement.buffer}" holds a ${typeText(element)}, not a ${typeText(statement.value.type)}`);
          }
          const reason = wideningReason(statement.value, element);
          if (reason !== null) problems.push(`${prefix}"${statement.buffer}[...]" is written where a ${typeText(element)} is read, and ${reason}`);
        } else {
          problems.push(...compoundProblems(element, statement.value, statement.op, prefix, `${statement.buffer}[...]`));
        }
      }
    }
    // A field written is read back the same way a field read is, so it takes
    // the same three checks: the layout is one the program lays out, the field
    // is one of its fields, and what is written is readable as the type that
    // layout gives it. The object it is written through is a reference, or the
    // C emitter casts whatever it holds to that layout and writes through it.
    if (statement.k === "storeField") {
      problems.push(...layoutProblems(prefix, statement.layout, statement.field, context));
      if (!isReference(statement.object.type)) {
        problems.push(`${prefix}${statement.layout}.${statement.field} is written through a ${typeText(statement.object.type)}, which is not a reference`);
      }
      const declared = fieldType(statement.layout, statement.field, context);
      if (declared !== null) {
        problems.push(...writeProblems(prefix, `${statement.layout}.${statement.field}`, declared, statement.value));
      }
    }

    for (const value of statementValues(statement)) {
      walked(value, (inner) => problems.push(...valueTypeProblems(prefix, inner, context)));
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
  const functions = context.functions;
  if (functions === null) return null;
  return (
    functions.find((signature) => signature.name === callee) ??
    functions.find((signature) => signature.symbol === callee) ??
    null
  );
}

/** Whether a context declares the whole program, and so every callee in it. */
function declaresEveryCallee(context: Context): boolean {
  return context.functions !== null;
}

/**
 * A call names a function the program holds or a builtin the compiler
 * provides, passes the arguments the signature takes, and says it returns the
 * type the signature returns.
 */
function callProblems(context: Context, tree: Tree): string[] {
  const problems: string[] = [];

  for (const placed of tree.statements) {
    const prefix = label(placed.block.block.id, placed.statement.line);
    for (const call of statementCalls(placed.statement)) {
      problems.push(...oneCallProblems(prefix, call, context));
    }
  }

  return problems;
}

/** One call, against the signature the program or the compiler declares it with. */
function oneCallProblems(prefix: string, call: SemanticCall, context: Context): string[] {
  const problems: string[] = [];
  const builtin = builtinFor(call.callee);
  const signature = declaredSignature(context, call.callee);

  // A context that declares no program cannot say what a call it cannot name
  // takes or returns, so it may neither refuse the call nor read it against a
  // signature it does not have.
  if (builtin === null && signature === null) {
    if (declaresEveryCallee(context)) {
      problems.push(`${prefix}${call.callee} is neither a function of the program nor a builtin`);
    }
    return problems;
  }
  if (call.builtin && builtin === null) {
    problems.push(`${prefix}${call.callee} is called as a builtin, and the compiler provides no such builtin`);
  }
  if (!call.builtin && builtin !== null && signature === null) {
    problems.push(`${prefix}${call.callee} is a builtin and is not called as one`);
  }

  const params: string[] =
    builtin !== null
      ? builtin.params.map((type) => contractText(type))
      : (signature?.params ?? []).map((param) => param.type);
  const returns = builtin !== null ? contractText(builtin.returns) : (signature?.returns ?? "void");

  if (call.signature.params.length !== params.length) {
    problems.push(`${prefix}${call.callee} is called against a signature of ${call.signature.params.length} parameters`);
  }

  const allowed = builtin?.arities ?? [builtin?.arity ?? params.length];
  if (call.args.length !== params.length && !allowed.includes(call.args.length)) {
    problems.push(`${prefix}${call.callee} is called with ${call.args.length} arguments and takes ${params.length}`);
  }
  if (!allowed.includes(call.args.length)) {
    problems.push(`${prefix}${call.callee} is called with ${call.args.length} arguments and takes ${allowed.join(" or ")}`);
  }
  if (call.argTypes.length !== call.args.length) {
    problems.push(`${prefix}${call.callee} passes ${call.args.length} arguments as ${call.argTypes.length} types`);
  }
  for (let index = 0; index < params.length; index += 1) {
    const parameter = contractType(params[index]);
    if (parameter === null) {
      problems.push(`${prefix}${call.callee} declares a parameter type that is not a type`);
      continue;
    }
    const argument = call.argTypes[index];
    if (argument === undefined) continue;
    if (!typeEquals(parameter, argument)) {
      problems.push(`${prefix}argument ${index + 1} of ${call.callee} is passed as a ${typeText(argument)} and is taken as a ${typeText(parameter)}`);
    }
    // The type an argument is passed as is not the type the value is: the value
    // is what the program computed and this is the width the callee reads it at,
    // and where the two are not one is a conversion a backend has to make. A
    // wide number beside a machine word is the one there is no answer for.
    const value = call.args[index];
    if (value === undefined) continue;
    if (!convertibleTo(value.type, argument)) {
      problems.push(`${prefix}argument ${index + 1} of ${call.callee} is a ${typeText(value.type)} and is read as a ${typeText(argument)}`);
    }
    const reason = wideningReason(value, argument);
    if (reason !== null) {
      problems.push(`${prefix}argument ${index + 1} of ${call.callee} is a ${typeText(value.type)} where a ${typeText(argument)} is read, and ${reason}`);
    }
  }

  const returned = contractType(returns);
  if (returned === null) {
    problems.push(`${prefix}${call.callee} declares a return type that is not a type`);
  } else if (!typeEquals(returned, call.returns)) {
    problems.push(`${prefix}${call.callee} returns a ${typeText(call.returns)} and is declared to return a ${typeText(returned)}`);
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

  for (const effect of call.effects) {
    if (EFFECT_NAMES[effect] !== true) {
      problems.push(`${prefix}${call.callee} has an effect the contract language does not name`);
      continue;
    }
    if (seen.has(effect)) {
      problems.push(`${prefix}${call.callee} says it has the effect ${effect} twice`);
    }
    seen.add(effect);
  }

  if (contracted === null) return problems;

  const says = [...call.effects].sort().join(", ");
  const means = [...contracted.effects].sort().join(", ");
  if (says !== means) {
    problems.push(`${prefix}${call.callee} has the effects [${says}] and its contract declares [${means}]`);
  }
  if (!signatureEquals(call.signature, contracted.function)) {
    problems.push(`${prefix}${call.callee} is called with a signature its contract does not declare`);
  }

  return problems;
}

/** Two signatures are the same when a caller may pass to either of them. */
function signatureEquals(left: FunctionSignature, right: FunctionSignature): boolean {
  if (left.name !== right.name || left.symbol !== right.symbol || left.returns !== right.returns) return false;
  if (left.params.length !== right.params.length) return false;
  return left.params.every((param, index) => {
    const other = right.params[index];
    return other !== undefined && param.name === other.name && param.type === other.type;
  });
}

/** The contract of the function a call names, or null when there is no contract. */
function contractedFunction(contract: ProgramContract | undefined, callee: string): FunctionContract | null {
  if (contract === undefined) return null;
  for (const file of contract.files) {
    const declared = file.functions[callee];
    if (declared !== undefined) return declared;
    for (const candidate of Object.values(file.functions)) {
      if (candidate.function.name === callee || candidate.function.symbol === callee) return candidate;
    }
  }
  return null;
}

/** What a call hands back is owned exactly when it is a reference to free. */
function ownershipProblems(prefix: string, call: SemanticCall): string[] {
  const problems: string[] = [];

  if (isReference(call.returns) && call.ownership !== "owned") {
    problems.push(`${prefix}${call.callee} hands back a ${typeText(call.returns)}, which the caller has to free`);
  }
  if (
    (isNumber(call.returns) || isBoolean(call.returns) || call.returns.kind === "void") &&
    call.ownership !== "none"
  ) {
    problems.push(`${prefix}${call.callee} hands back a ${typeText(call.returns)}, which owns nothing`);
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
  const loop = from.loops[from.loops.length - 1];
  if (loop === undefined) return [];
  const left: PlacedBlock[] = [];
  for (let at: PlacedBlock | null = from; at !== null && at !== loop.body; at = at.parent) left.push(at);
  if (loop.body !== null) left.push(loop.body);
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
  const position = new Map(declared.map((name, index) => [name, index]));
  const seen = new Set<string>();
  let previous = Number.POSITIVE_INFINITY;

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

  for (const placed of tree.statements) {
    const prefix = label(placed.block.block.id, placed.statement.line);
    for (const call of statementCalls(placed.statement)) {
      problems.push(...effectProblems(prefix, call, contractedFunction(context.contract, call.callee)));
      problems.push(...ownershipProblems(prefix, call));
    }
  }

  for (const placed of tree.blocks) {
    const id = placed.block.id;
    problems.push(...releaseProblems(label(id), placed.block.releases, placed.own));
    const terminator = placed.block.terminator;
    if (terminator.k === "jump") {
      // A jump leaves every block it is written in, up to and including the
      // body of the loop it is in, so it frees exactly what those blocks free
      // when control falls out of them — no more, and none left behind.
      const expected = blocksLeft(placed).flatMap((left) => left.block.releases);
      problems.push(...jumpReleaseProblems(label(id), terminator.releases, expected));
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
      const callee = inner.left.k === "call" ? inner.left.call.callee : "a function";
      problems.push(`${prefix}${inner.k} decides on an arm that calls ${callee}, which is written twice`);
    });
  };

  for (const placed of tree.statements) {
    const prefix = label(placed.block.block.id, placed.statement.line);
    for (const value of statementValues(placed.statement)) decide(prefix, value);
  }
  // What a block hands back is a value the backends lower like any other, and
  // for a function whose body is one expression it is the only place the value
  // lives. A block's terminator is not one of its statements, so an arm written
  // in a return was decided on by this rule never, and the call the C backend
  // binds to a temporary ran once where the WebAssembly one ran it twice.
  for (const placed of tree.blocks) {
    const terminator = placed.block.terminator;
    if (terminator.k !== "return" || terminator.value === null) continue;
    decide(label(placed.block.id, 0), terminator.value);
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

  for (const placed of tree.blocks) {
    const where = label(placed.block.id);
    checkName(problems, "", placed.block.id);
    for (const declared of placed.own) checkName(problems, where, declared);
    for (const release of placed.block.releases) checkName(problems, where, release);
    const terminator = placed.block.terminator;
    if (terminator.k === "jump") {
      checkName(problems, where, terminator.target);
      for (const release of terminator.releases) checkName(problems, where, release);
    }
    for (const frame of placed.loops) {
      if (frame.loop.kind === "counted") checkName(problems, where, frame.loop.variable);
      if (frame.loop.kind === "each") {
        checkName(problems, where, frame.loop.of);
        checkName(problems, where, frame.loop.index);
        checkName(problems, where, frame.loop.element);
      }
    }
  }

  for (const placed of tree.statements) {
    const prefix = label(placed.block.block.id, placed.statement.line);
    const statement = placed.statement;
    if (statement.k === "set") checkName(problems, prefix, statement.name);
    if (statement.k === "step") checkName(problems, prefix, statement.name);
    if (statement.k === "setElement") checkName(problems, prefix, statement.buffer);
    if (statement.k === "storeField") {
      checkName(problems, prefix, statement.layout);
      checkName(problems, prefix, statement.field);
    }
    for (const value of statementValues(statement)) {
      walked(value, (inner) => {
        if (inner.k === "newObject") {
          checkName(problems, prefix, inner.layout);
          // A field is read and written through the member the backend spells
          // it by, which is an identifier of its own however the source named
          // the field: a quoted key such as "content-type" is legal source and
          // a member the escape answers.
          for (const field of inner.fields) checkName(problems, prefix, cMemberName(field.name));
        }
        if (inner.k === "loadField") {
          checkName(problems, prefix, inner.layout);
          checkName(problems, prefix, cMemberName(inner.field));
        }
      });
    }
    for (const call of statementCalls(statement)) {
      if (builtinFor(call.callee) === null) checkName(problems, prefix, call.callee);
    }
  }

  for (const signature of context.functions ?? []) {
    checkName(problems, "", signature.name);
    checkName(problems, "", signature.symbol);
  }
  for (const layout of Object.values(context.objects)) {
    checkName(problems, "", layout.name);
    for (const field of layout.fields) checkName(problems, "", cMemberName(field.name));
  }
  for (const name of context.declared) checkName(problems, "", name);

  return problems;
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
  known: Callees = new Map(program.bodies.map((fn) => [fn.name, fn])),
): string[] {
  const tree = readTree(program);
  // A loop marked parallel is proved against the bodies the caller holds: a call
  // to one of them is a call whose writes this check can read, and a call to
  // anything else is a call it cannot.
  const callees: Callees = known;
  return [
    ...bodyProblems(programContext(program, callees, contract), programBody(program, tree), tree),
    // A function the program declares is checked as the function it is: the
    // same body a candidate of the program is checked against, with the
    // signatures it is called by in hand.
    ...program.bodies.flatMap((fn) => {
      const own = readFunctionTree(fn, fn.entry);
      const own_context = {
        objects: program.objects,
        functions: program.functions,
        callees,
        contract,
        declared: [fn.name, fn.symbol, ...fn.params.map((param) => param.name)],
      };
      return [
        ...bodyProblems(own_context, functionBody(fn.entry, own), own),
        // A function a program declares returns what it declared, and the rule
        // is the one a function of a module is held to. It was not asked of a
        // program's own bodies, so a body that fell off its last block ended by
        // handing back whatever the register held.
        ...returnProblems(fn, own_context, own),
      ].map((problem) => `${fn.symbol}: ${problem}`);
    }),
  ];
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

  for (const placed of tree.blocks) {
    const terminator = placed.block.terminator;
    if (terminator.k !== "return") continue;
    const where = label(placed.block.id);
    const value = terminator.value;

    // A return type the IR does not state is a return nothing can be checked
    // against, so the return that hands it back is refused rather than read.
    if (!isSemanticType(fn.returns)) {
      problems.push(`${where}the body returns ${typeText(fn.returns)}, which is not a type`);
      continue;
    }
    if (fn.returns.kind === "void") {
      if (value !== null) {
        problems.push(`${where}the body returns a ${typeText(value.type)} and is declared to return nothing`);
      }
      continue;
    }
    if (value === null) {
      problems.push(`${where}the body returns nothing and is declared to return a ${typeText(fn.returns)}`);
      continue;
    }
    if (!convertibleTo(value.type, fn.returns)) {
      problems.push(`${where}the body returns a ${typeText(value.type)} and is declared to return a ${typeText(fn.returns)}`);
    }
    const reason = wideningReason(value, fn.returns);
    if (reason !== null) problems.push(`${where}the body returns a ${typeText(value.type)} where a ${typeText(fn.returns)} is read, and ${reason}`);
    for (const read of localNames(value)) {
      if (!placed.final.visible.has(read)) {
        problems.push(`${where}returns ${read}, which the block it is written in does not hold`);
      }
    }
    walked(value, (inner) => problems.push(...valueTypeProblems(where, inner, context)));
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

  for (const placed of tree.statements) {
    const statement = placed.statement;
    if (statement.k !== "loop") continue;
    const loop = statement.loop;
    if (loop.kind !== "counted" && loop.kind !== "each") continue;
    if (loop.region !== true) continue;
    const refusal = regionRefusalFor(loop, context.callees);
    if (refusal !== null) {
      problems.push(`${label(placed.block.block.id, statement.line)}loop is marked region but ${refusal}`);
    }
  }

  // Each mark above is proved on its own, so two of them on one path are two
  // marks each of which is individually sound and jointly a corruption: the
  // runtime keeps one cursor and rewinds it on entry rather than pushing, so the
  // inner turn is given the base block the outer turn is still filling and every
  // block that turn took before the inner loop began is handed out a second
  // time. Proving each separately cannot see it, so the shape is refused here.
  for (const outer of markedRegionLoops(tree)) {
    if (firstMarkedRegionWithin(outer.loop.body) !== null) {
      problems.push(
        `${label(outer.block.block.id, outer.statement.line)}loop is marked region around a loop that is also marked region, and a rewind inside a marked loop writes over what the outer turn took`,
      );
    }
  }

  return problems;
}

/** Every marked region loop of a tree, paired with the statement that holds it. */
function markedRegionLoops(tree: Tree): { block: PlacedBlock; statement: SemanticStatement; loop: MarkedLoop }[] {
  return tree.statements.flatMap((placed) => {
    const statement = placed.statement;
    if (statement.k !== "loop") return [];
    const loop = statement.loop;
    if (loop.kind !== "counted" && loop.kind !== "each") return [];
    if (loop.region !== true) return [];
    return [{ block: placed.block, statement, loop }];
  });
}

/** A marked region loop somewhere inside a body, at any depth, or null. */
function firstMarkedRegionWithin(body: SemanticBlock): MarkedLoop | null {
  for (const statement of body.statements) {
    if (statement.k === "loop") {
      const loop = statement.loop;
      if (loop.kind === "counted" || loop.kind === "each") {
        if (loop.region === true) return loop;
      }
      const found = firstMarkedRegionWithin(statement.loop.body);
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

  for (const placed of tree.statements) {
    const statement = placed.statement;
    if (statement.k !== "loop") continue;
    const loop = statement.loop;
    if (loop.kind !== "counted" && loop.kind !== "each") continue;
    if (loop.parallel !== true) continue;
    const where = label(placed.block.block.id, statement.line);
    const refusal = refusalFor(loop, context.callees);
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
    const derived = reductionsFor(loop.body, loop.kind === "counted" ? loop.variable : loop.index);
    for (const reduction of loop.reductions ?? []) {
      const performed = derived.get(reduction.name);
      if (performed === undefined) {
        problems.push(`${where}loop is marked parallel with a reduction on "${reduction.name}", and its body accumulates into no name`);
      } else if (performed.op !== reduction.op) {
        const verb = performed.op === "+" ? "adds into" : "multiplies into";
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

  for (const placed of tree.blocks) {
    const where = label(placed.block.id);
    if (placed.block === fn.entry) {
      const terminator = placed.block.terminator;
      // An entry block that ends where nothing arrives returns from every path,
      // which is what a return is: the two say the same thing about a function,
      // and the statements the block holds after the `if` that proved it are the
      // ones the program never runs.
      if (terminator.k !== "return" && terminator.k !== "unreachable") {
        problems.push(`entry: the entry block ends in ${terminator.k} rather than in a return`);
      }
      continue;
    }
    // A return in an arm or a loop body is an early return, and the block
    // around it still has a way through that does not return. A return in a
    // block of its own is not: it ends the function, and every statement the
    // block around it writes after it is a statement nothing reaches.
    if (placed.block.terminator.k === "return" && !placed.guarded && placed.rest > 0) {
      const around = placed.parent === null ? "the body" : placed.parent.block.id;
      problems.push(`${where}returns, and ${placed.rest} statements of ${around} after it are never reached`);
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

  for (const param of fn.params) {
    if (seen.has(param.name)) {
      problems.push(`${param.name}: the function takes a parameter of that name twice`);
    }
    seen.add(param.name);
    if (param.kind !== "value") {
      problems.push(`${param.name}: a parameter is one value, and this one is a ${param.kind}`);
      continue;
    }
    if (!isSemanticType(param.type)) {
      problems.push(`${param.name}: a parameter is read as ${typeText(param.type)}, which is not a type`);
    }
  }

  if (contract !== undefined) {
    const declared = contract.function.params;
    if (declared.length !== fn.params.length) {
      problems.push(`the body takes ${fn.params.length} parameters and the signature declares ${declared.length}`);
    }
    for (let index = 0; index < declared.length; index += 1) {
      const expected = declared[index];
      const held = fn.params[index];
      if (expected === undefined || held === undefined) continue;
      if (held.name !== expected.name) {
        problems.push(`parameter ${index + 1} is ${held.name} and the signature declares ${expected.name}`);
      }
      const wanted = contractType(expected.type);
      if (wanted === null) {
        problems.push(`parameter ${index + 1} declares a type that is not a type`);
        continue;
      }
      if (held.kind === "value" && !convertibleTo(held.type, wanted)) {
        problems.push(`${held.name} is read as a ${typeText(held.type)} and the signature declares a ${typeText(wanted)}`);
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
  if (!fn.allocates) return [];
  const problems: string[] = [];

  for (const placed of tree.blocks) {
    const where = label(placed.block.id);
    const terminator = placed.block.terminator;
    const returned = terminator.k === "return" ? returnedName(terminator.value) : null;
    for (const release of placed.block.releases) {
      if (release === returned) {
        problems.push(`${where}frees ${release}, which the caller of the function owns`);
      }
    }
    if (terminator.k === "jump") {
      for (const release of terminator.releases) {
        if (release === returned) {
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

  for (const requires of fn.requires) {
    if (typeof requires !== "string" || requires.trim() === "") {
      problems.push("a precondition of the function is empty");
    }
  }
  for (const ensures of fn.ensures) {
    if (typeof ensures !== "string" || ensures.trim() === "") {
      problems.push("a postcondition of the function is empty");
    }
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
  const tree = readFunctionTree(fn, fn.entry);
  const context = functionContext(fn, callees, program);
  const found = [
    ...conditionProblems(fn),
    ...parameterProblems(fn, contract),
    ...bodyProblems(context, functionBody(fn.entry, tree), tree),
    ...returnProblems(fn, context, tree),
    ...wayOutProblems(fn, tree),
    ...allocationProblems(fn, tree),
  ];
  // Every message names the function it is about, so a file of them is read one
  // function at a time: a block is called b1 in every function of a file, so
  // the function is what tells two of them apart.
  return found.map((problem) => `${fn.symbol}: ${problem}`);
}

/**
 * Every way a function is not a function a backend may lower. A function
 * checked on its own is checked against its own contract, which is not the
 * whole program, so a call it cannot resolve is left to the module check.
 */
export function semanticFunctionProblems(
  fn: SemanticFunction,
  contract?: FunctionContract,
  callees: Callees = NO_CALLEES,
): string[] {
  return functionProblems(fn, contract, undefined, callees);
}

/** The same, for every function of a file, in the order the file declares them. */
export function semanticModuleProblems(
  module: SemanticModule,
  program?: ProgramContract,
  callees: Callees = new Map(module.functions.map((fn) => [fn.name, fn])),
): string[] {
  const problems: string[] = [];
  for (const fn of module.functions) {
    const contract = contractedFunction(program, fn.symbol);
    problems.push(...functionProblems(fn, contract ?? undefined, program, callees));
  }
  return problems;
}

/** Refuses a program that is not one. Throws one CompilerError. */
export function validateSemanticProgram(program: SemanticProgram, contract?: ProgramContract, callees?: Callees): void {
  refuse(`${program.file} is not a program the compiler may lower`, semanticIrProblems(program, contract, callees));
}

/** Refuses a function that is not one. Throws one CompilerError. */
export function validateSemanticFunction(
  fn: SemanticFunction,
  contract?: FunctionContract,
  callees: Callees = NO_CALLEES,
): void {
  refuse(`${fn.symbol} is not a function the compiler may lower`, semanticFunctionProblems(fn, contract, callees));
}

/** Refuses a module holding a function that is not one. Throws one CompilerError. */
export function validateSemanticModule(module: SemanticModule, program?: ProgramContract, callees?: Callees): void {
  refuse(`${module.path} is not a module the compiler may lower`, semanticModuleProblems(module, program, callees));
}

/** The one error a caller is given: what it read, and everything wrong with it. */
function refuse(message: string, problems: string[]): void {
  if (problems.length === 0) return;
  throw new CompilerError({
    category: "SemanticIrError",
    stage: "ir",
    message,
    detail: problems.join("\n"),
  });
}

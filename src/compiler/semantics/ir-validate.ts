/**
 * The check that a semantic IR program is a program.
 *
 * Everything a backend needs is stated in the IR, so everything a backend
 * would otherwise read wrongly is worth refusing here: a jump to a block that
 * does not exist, an argument passed as a type the callee does not take, a
 * name that is not a plain identifier, an arm a backend would write twice, a
 * field read from an object no layout has. The problems are collected rather
 * than thrown one at a time, so one run of the compiler says everything that is
 * wrong with a program, in the order the program is written.

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
  isNumber,
  isReference,
  isSemanticType,
  isSequence,
  isTextType,
  localNames,
  slotType,
  typeEquals,
  typeText,
  walkValues,
} from "../core/semantic-ir.ts";
import type {
  SemanticBlock,
  SemanticCall,
  SemanticLoop,
  SemanticProgram,
  SemanticSlot,
  SemanticStatement,
  SemanticType,
  SemanticValue,
} from "../core/semantic-ir.ts";
import { builtinFor } from "./builtins.ts";
import { parseType } from "./contract.ts";

/* -------------------------------------------------------------------------- */
/* Tables                                                                     */
/* -------------------------------------------------------------------------- */

/** The ways a block may end. A block that ends in none of them ends nowhere. */
const TERMINATOR_KINDS: Record<string, true> = { next: true, return: true, jump: true };

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

/* -------------------------------------------------------------------------- */
/* Reading the program as a tree                                              */
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
}

/** A statement, with the block it is written in and what that block may read. */
interface PlacedStatement {
  statement: SemanticStatement;
  block: PlacedBlock;
  /** What may be read where the statement is written. */
  scope: Scope;
}

/** Every block and statement of a program, in the order they are written. */
interface Tree {
  blocks: PlacedBlock[];
  statements: PlacedStatement[];
  /** Every loop the program holds, once each. */
  loops: LoopFrame[];
}

/** Where a message is written, so a message names the block and the line. */
function label(blockId: string, line?: number): string {
  return line === undefined ? `${blockId}: ` : `${blockId}: line ${line}: `;
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
 * around it and holding the names it may read.
 */
function walkBlock(
  block: SemanticBlock,
  loops: LoopFrame[],
  scope: Scope,
  tree: Tree,
  parent: PlacedBlock | null = null,
): PlacedBlock {
  const placed: PlacedBlock = { block, loops, own: [], parent };
  tree.blocks.push(placed);

  let current = scope;
  for (const statement of block.statements) {
    tree.statements.push({ statement, block: placed, scope: current });
    if (statement.k === "let") {
      current = declaring(current, statement.slot);
      placed.own.push(statement.slot.name);
      continue;
    }
    if (statement.k === "if") {
      walkBlock(statement.then, loops, current, tree, placed);
      if (statement.otherwise !== null) {
        walkBlock(statement.otherwise, loops, current, tree, placed);
      }
      continue;
    }
    if (statement.k === "block") {
      walkBlock(statement.body, loops, current, tree, placed);
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
      );
    }
  }

  return placed;
}

/** The whole program as a tree, each block placed in the blocks around it. */
function readTree(program: SemanticProgram): Tree {
  const tree: Tree = { blocks: [], statements: [], loops: [] };
  walkBlock(program.entry, [], { slots: new Map(), visible: new Set() }, tree);
  return tree;
}

/** Every value a statement computes, in the order the statement writes them. */
function statementValues(statement: SemanticStatement): SemanticValue[] {
  switch (statement.k) {
    case "let":
    case "set":
    case "printText":
    case "printNumber":
    case "retain":
      return [statement.value];
    case "raise":
      return [statement.message];
    case "setElement":
      return [statement.index, statement.value];
    case "if":
      return [statement.condition];
    case "storeField":
      return [statement.object, statement.value];
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
    walkValues(value, (inner) => {
      if (inner.k === "call") calls.push(inner.call);
    });
  }
  if (statement.k === "call") calls.push(statement.call);
  return calls;
}

/** The type a sequence holds elements of, or null for anything else. */

/* -------------------------------------------------------------------------- */
/* Rule 1: structure                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The shape of a program: one entry, one way out of every block, and no block
 * a jump names that the program does not hold.
 */
function structureProblems(program: SemanticProgram, tree: Tree): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();

  for (const placed of tree.blocks) {
    if (ids.has(placed.block.id)) {
      problems.push(`${label(placed.block.id)}the block id is used by more than one block`);
      continue;
    }
    ids.add(placed.block.id);
  }

  if (program.entry.id !== "entry") {
    problems.push(`entry: the program's entry block is "${program.entry.id}" rather than entry`);
  }

  const headers = new Set(tree.loops.map((frame) => frame.loop.header));

  for (const placed of tree.blocks) {
    const where = label(placed.block.id);
    const terminator = placed.block.terminator;
    const isEntry = placed.block === program.entry;

    if (TERMINATOR_KINDS[terminator.k] !== true) {
      problems.push(`${where}the block ends in nothing a program may end in`);
      continue;
    }
    if (terminator.k === "return" && !isEntry) {
      problems.push(`${where}only the entry block ends the program`);
    }
    if (terminator.k === "jump" && isEntry) {
      problems.push(`${where}the program body leaves for ${terminator.target} rather than ending`);
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
    if (statement.k === "setElement") {
      const buffer = scope.slots.get(statement.buffer);
      if (buffer === undefined) {
        problems.push(`${prefix}"${statement.buffer}" is not declared where it is written`);
      } else if (buffer.kind !== "buffer") {
        problems.push(`${prefix}"${statement.buffer}" is a ${typeText(slotType(buffer))}, which has no elements to write`);
      }
    }
    if (statement.k === "loop" && statement.loop.kind === "each" && !scope.visible.has(statement.loop.of)) {
      problems.push(`${prefix}"${statement.loop.of}" is not declared where it is read`);
    }

    for (const name of writes) {
      const slot = scope.slots.get(name);
      if (slot === undefined) {
        problems.push(`${prefix}"${name}" is not declared where it is written`);
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
    }
  }

  return problems;
}

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
function valueTypeProblems(
  prefix: string,
  value: SemanticValue,
  program: SemanticProgram,
  contract?: ProgramContract,
): string[] {
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
      if (isNumber(value.index.type) && isFloat(value.index.type)) {
        problems.push(`${prefix}an element is read at a ${typeText(value.index.type)}, which is not a whole number`);
      }
      const element = elementTypeOf(value.of.type);
      if (element !== null && !typeEquals(element, value.type)) {
        problems.push(`${prefix}an element of a ${typeText(value.of.type)} is a ${typeText(element)}, not a ${typeText(value.type)}`);
      }
      return problems;
    }
    case "buffer": {
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
    case "newObject":
      if (!isLayout(program, value.object) && !isContractLayout(contract, value.object)) {
        problems.push(`${prefix}the object ${value.object} is not a layout the program lays out`);
      }
      return problems;
    case "loadField": {
      problems.push(...layoutProblems(prefix, value.layout, value.field, program, contract));
      const declared = fieldType(value, program, contract);
      if (declared !== null && !convertibleTo(declared, value.type)) {
        problems.push(`${prefix}${value.layout}.${value.field} is a ${typeText(declared)}, not a ${typeText(value.type)}`);
      }
      return problems;
    }
    case "arith": {
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
      // What an operation is written as is one of the two types it works on —
      // `length - 10` is a double and `10 - length` is a whole number, because
      // that is what the language says — and both sides convert to it.
      if (!isNumber(value.left.type) || !isNumber(value.right.type)) {
        problems.push(`${prefix}${value.op} over a ${typeText(value.left.type)} and a ${typeText(value.right.type)}`);
        return problems;
      }
      const expected = value.op === "shl" || value.op === "shr" ? value.left.type : value.type;
      if (!typeEquals(expected, value.left.type) && !typeEquals(expected, value.right.type)) {
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
      return problems;
    case "logical": {
      // `&&` and `||` return one of their arms rather than a truth, so what
      // they are written as is the type both arms are.
      if (!convertibleTo(value.left.type, value.type) || !convertibleTo(value.right.type, value.type)) {
        problems.push(`${prefix}${value.op} over a ${typeText(value.left.type)} and a ${typeText(value.right.type)} is a ${typeText(value.type)}`);
      }
      return problems;
    }
    case "isNull":
      if (!isBoolean(value.type)) problems.push(`${prefix}a null test is written as a ${typeText(value.type)}`);
      return problems;
    case "coalesce":
    case "select":
      return problems;
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

/** A field of a layout the program lays out, and the type the layout gives it. */
function layoutProblems(
  prefix: string,
  layout: string,
  field: string,
  program: SemanticProgram,
  contract?: ProgramContract,
): string[] {
  if (!isLayout(program, layout) && !isContractLayout(contract, layout)) {
    return [`${prefix}the object ${layout} is not a layout the program lays out`];
  }
  const found = layoutOf(program, contract, layout);
  const declared = found?.fields.find((one) => one.name === field);
  if (declared === undefined) {
    return [`${prefix}${layout} has no field ${field}`];
  }
  return [];
}

/** The layout a program carries, wherever it came from. */
function layoutOf(
  program: SemanticProgram,
  contract: ProgramContract | undefined,
  name: string,
): ObjectLayout | undefined {
  if (isLayout(program, name)) return program.objects[name];
  if (contract === undefined) return undefined;
  for (const file of contract.files) {
    for (const declared of Object.values(file.functions)) {
      const objects = declared.definition?.objects;
      const found = objects?.[name];
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** The type a layout gives a field, as a type the IR states. */
function fieldType(value: SemanticValue & { k: "loadField" }, program: SemanticProgram, contract?: ProgramContract) {
  const layout = layoutOf(program, contract, value.layout);
  const declared = layout?.fields.find((one) => one.name === value.field);
  return declared === undefined ? null : parseType(declared.type);
}

/** A layout the IR itself carries. */
function isLayout(program: SemanticProgram, object: string): boolean {
  return Object.prototype.hasOwnProperty.call(program.objects, object);
}

/** A layout a contract lays out, for a function that has a body of its own. */
function isContractLayout(contract: ProgramContract | undefined, object: string): boolean {
  if (contract === undefined) return false;
  for (const file of contract.files) {
    for (const declared of Object.values(file.functions)) {
      const objects = declared.definition?.objects;
      if (objects !== undefined && Object.prototype.hasOwnProperty.call(objects, object)) return true;
    }
  }
  return false;
}

/** The conditions, prints, raises and retains a program writes. */
function typeProblems(program: SemanticProgram, tree: Tree, contract?: ProgramContract): string[] {
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
    if (statement.k === "raise" && !isTextType(statement.message.type)) {
      problems.push(`${prefix}a program is raised with a ${typeText(statement.message.type)}, which is not text`);
    }
    if (statement.k === "retain" && !isReference(statement.value.type) && !isTextType(statement.value.type)) {
      if (statement.value.k !== "call") {
        problems.push(`${prefix}a ${typeText(statement.value.type)} is nothing to keep alive`);
      }
    }
    if (statement.k === "setElement") {
      const buffer = placed.scope.slots.get(statement.buffer);
      if (buffer !== undefined && buffer.kind === "buffer") {
        if (statement.op === "=") {
          if (!convertibleTo(statement.value.type, buffer.element)) {
            problems.push(`${prefix}"${statement.buffer}" holds a ${typeText(buffer.element)}, not a ${typeText(statement.value.type)}`);
          }
        } else {
          problems.push(...compoundProblems(buffer.element, statement.value, statement.op, prefix, `${statement.buffer}[...]`));
        }
      }
    }

    for (const value of statementValues(statement)) {
      walkValues(value, (inner) => problems.push(...valueTypeProblems(prefix, inner, program, contract)));
    }
  }

  return problems;
}

/* -------------------------------------------------------------------------- */
/* Rule 5: calls                                                              */
/* -------------------------------------------------------------------------- */

/** The type a parameter or a return is written as, or null when it is not one. */
function contractType(text: string): SemanticType | null {
  try {
    return parseType(text);
  } catch {
    return null;
  }
}

/** The signature a call is made against, as the program declares it. */
function declaredSignature(program: SemanticProgram, callee: string) {
  return (
    program.functions.find((signature) => signature.name === callee) ??
    program.functions.find((signature) => signature.symbol === callee) ??
    null
  );
}

/**
 * A call names a function the program holds or a builtin the compiler
 * provides, passes the arguments the signature takes, and says it returns the
 * type the signature returns.
 */
function callProblems(program: SemanticProgram, tree: Tree): string[] {
  const problems: string[] = [];

  for (const placed of tree.statements) {
    const prefix = label(placed.block.block.id, placed.statement.line);
    for (const call of statementCalls(placed.statement)) {
      problems.push(...oneCallProblems(prefix, call, program));
    }
  }

  return problems;
}

/** One call, against the signature the program or the compiler declares it with. */
function oneCallProblems(prefix: string, call: SemanticCall, program: SemanticProgram): string[] {
  const problems: string[] = [];
  const builtin = builtinFor(call.callee);
  const signature = declaredSignature(program, call.callee);

  if (builtin === null && signature === null) {
    problems.push(`${prefix}${call.callee} is neither a function of the program nor a builtin`);
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
      ? builtin.params.map((type) => typeText(type))
      : (signature?.params ?? []).map((param) => param.type);
  const returns = builtin !== null ? typeText(builtin.returns) : (signature?.returns ?? "void");

  if (call.signature.params.length !== params.length) {
    problems.push(`${prefix}${call.callee} is called against a signature of ${call.signature.params.length} parameters`);
  }

  if (call.args.length !== params.length) {
    problems.push(`${prefix}${call.callee} is called with ${call.args.length} arguments and takes ${params.length}`);
  }
  if (builtin?.arity !== undefined && call.args.length !== builtin.arity) {
    problems.push(`${prefix}${call.callee} is called with ${call.args.length} arguments and takes ${builtin.arity}`);
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

/** Names freed on the way out, in the order the block declared them. */
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
 * and what every way out of a block frees on the way.
 */
function effectAndOwnershipProblems(tree: Tree, contract?: ProgramContract): string[] {
  const problems: string[] = [];

  for (const placed of tree.statements) {
    const prefix = label(placed.block.block.id, placed.statement.line);
    for (const call of statementCalls(placed.statement)) {
      problems.push(...effectProblems(prefix, call, contractedFunction(contract, call.callee)));
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

  for (const placed of tree.statements) {
    const prefix = label(placed.block.block.id, placed.statement.line);
    for (const value of statementValues(placed.statement)) {
      walkValues(value, (inner) => {
        if (inner.k !== "logical" && inner.k !== "coalesce") return;
        if (!hasCall(inner.left)) return;
        const callee = inner.left.k === "call" ? inner.left.call.callee : "a function";
        problems.push(`${prefix}${inner.k} decides on an arm that calls ${callee}, which is written twice`);
      });
    }
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
 * Every name the program carries is a plain identifier: no register, no stack
 * offset, no punctuation a target would have to escape before it emitted it.
 * The guarantee that the model names no target lives in the model; this is the
 * check that a program did not smuggle one in through a name.
 */
function nameProblems(program: SemanticProgram, tree: Tree): string[] {
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
      walkValues(value, (inner) => {
        if (inner.k === "newObject") checkName(problems, prefix, inner.object);
        if (inner.k === "loadField") {
          checkName(problems, prefix, inner.layout);
          checkName(problems, prefix, inner.field);
        }
      });
    }
    for (const call of statementCalls(statement)) {
      if (builtinFor(call.callee) === null) checkName(problems, prefix, call.callee);
    }
  }

  for (const signature of program.functions) {
    checkName(problems, "", signature.name);
    checkName(problems, "", signature.symbol);
  }
  for (const layout of Object.values(program.objects)) {
    checkName(problems, "", layout.name);
    for (const field of layout.fields) checkName(problems, "", field.name);
  }

  return problems;
}

/* -------------------------------------------------------------------------- */
/* The check                                                                  */
/* -------------------------------------------------------------------------- */

/** Every way the program is not a program a backend may lower, contract or not. */
export function semanticIrProblems(program: SemanticProgram, contract?: ProgramContract): string[] {
  const tree = readTree(program);
  return [
    ...structureProblems(program, tree),
    ...controlFlowProblems(tree),
    ...valueProblems(tree),
    ...typeProblems(program, tree, contract),
    ...callProblems(program, tree),
    ...effectAndOwnershipProblems(tree, contract),
    ...evaluatedOnceProblems(tree),
    ...nameProblems(program, tree),
  ];
}

/** Refuses a program that is not one. Throws one CompilerError. */
export function validateSemanticProgram(program: SemanticProgram, contract?: ProgramContract): void {
  const problems = semanticIrProblems(program, contract);
  if (problems.length === 0) return;
  throw new CompilerError({
    category: "SemanticIrError",
    stage: "ir",
    message: `${program.file} is not a program the compiler may lower`,
    detail: problems.join("\n"),
  });
}

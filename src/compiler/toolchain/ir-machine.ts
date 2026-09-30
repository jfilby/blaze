/**
 * Lowering a function's semantic IR to machine code.
 *
 * This backend writes the object itself. There is no C in between and no
 * assembler is asked: the IR is read, the instructions of the System V AMD64
 * convention are written out, and what comes out is a relocatable object the
 * linker puts beside the other objects of the program. The runtime, the harness
 * and the maths library are still C, and the object calls into them by the
 * symbols `runtime/abi.ts` names — the boundary is the one every backend keeps.
 *
 * No value is given a register of its own. Every value the body computes is
 * written to a slot in the frame, and the registers that carry a value between
 * two instructions are the accumulator and one scratch beside it: a whole number
 * or a reference in `rax` and `rcx`, a float in `xmm0` and `xmm1`. That is what
 * makes a register, an offset and an instruction the compiler's decision rather
 * than a model's, and it keeps the lowering readable beside the C one, which is
 * the reference for what the IR means.
 */

import { stat, writeFile } from "node:fs/promises";
import { CompilerError } from "../core/errors.ts";
import { run } from "../core/process.ts";
import { isRuntimeSymbol, RUNTIME_NAME } from "../runtime/abi.ts";
import { ARGV_LENGTH, BUILTINS } from "../semantics/builtins.ts";
import { parseType, symbolOf } from "../semantics/contract.ts";
import {
  elementTypeOf,
  hasCall,
  walkValues,
  isBoolean,
  isFloat,
  isNumber,
  isReference,
  isTextType,
  isUnsigned,
  slotType,
  typeEquals,
  valueKind,
  type CompareOp,
  type SemanticBlock,
  type SemanticCall,
  type SemanticFunction,
  type SemanticLoop,
  type SemanticStatement,
  type SemanticTerminator,
  type SemanticType,
  type SemanticValue,
} from "../core/semantic-ir.ts";
import type { FunctionContract, ObjectLayout, TargetSpec } from "../core/types.ts";
import { describeObject, writeObject, type DataLabel } from "./elf64.ts";
import { NameScope } from "./names.ts";
import {
  Encoder,
  INTEGER_ARGUMENTS,
  R12,
  R13,
  R14,
  R15,
  RAX,
  RBX,
  RCX,
  RDI,
  RDX,
  RSI,
  RSP,
  SSE_ARGUMENTS,
  type Width,
  XMM0,
  XMM1,
  XMM2,
  frame,
  indexed,
  mem,
} from "./x86.ts";

/* -------------------------------------------------------------------------- */
/* Types as the machine holds them                                              */
/* -------------------------------------------------------------------------- */

const NUMBER: SemanticType = { kind: "primitive", name: "f64" };
const USIZE: SemanticType = { kind: "primitive", name: "usize" };
const TEXT = { kind: "text" } as const;
const POINTER: SemanticType = { kind: "primitive", name: "usize" };

/** The C library a lowered function calls, which the linker resolves. */
const LIBRARY: Record<string, true> = {
  strlen: true,
  memcpy: true,
  strcmp: true,
  pow: true,
  fabs: true,
  floor: true,
  trunc: true,
};

/** The operator each compound assignment is, by the name the IR gives it. */
const COMPOUND: Record<string, "add" | "sub" | "mul" | "div" | "mod"> = {
  "+": "add",
  "-": "sub",
  "*": "mul",
  "/": "div",
  "%": "mod",
};

/**
 * The condition that fires when the one it names does not. A branch on a
 * comparison is written as the negation of the condition the comparison
 * holds under, because the flags a comparison leaves say what the
 * comparison *is*, and a branch is reached by the arm that is not the one the
 * comparison chose.
 */
const NEGATED: Record<"e" | "ne" | "l" | "le" | "g" | "ge" | "b" | "be" | "a" | "ae", "e" | "ne" | "l" | "le" | "g" | "ge" | "b" | "be" | "a" | "ae"> = {
  e: "ne",
  ne: "e",
  l: "ge",
  le: "g",
  g: "le",
  ge: "l",
  b: "ae",
  be: "a",
  a: "be",
  ae: "b",
};

/**
 * The condition a comparison of two whole numbers holds under, by whether
 * the language reads the numbers as signed. A comparison is carried out at
 * the width the language promotes it to, so the two sides are already
 * widened the way the conditions below expect them to be.
 */
const COMPARISON: Record<"signed" | "unsigned", Record<CompareOp, "e" | "ne" | "l" | "le" | "g" | "ge" | "b" | "be" | "a" | "ae">> = {
  signed: { eq: "e", ne: "ne", lt: "l", le: "le", gt: "g", ge: "ge" },
  unsigned: { eq: "e", ne: "ne", lt: "b", le: "be", gt: "a", ge: "ae" },
};

/**
 * The operations the machine writes with the number in the instruction rather
 * than in a register. A division and a remainder are the two it does not: the
 * machine divides a register by a register, and a literal is not one.
 */
const IMMEDIATE_OPERATIONS: Record<string, true> = {
  add: true,
  sub: true,
  mul: true,
  shl: true,
  shr: true,
  sar: true,
  and: true,
  or: true,
  xor: true,
};

/**
 * The registers a callee leaves as it found them, which are the ones a value
 * that never changes can be kept in across a call. Five is what the convention
 * has: rbx, r12, r13, r14 and r15.
 */
const CALLEE_SAVED: readonly number[] = [RBX, R12, R13, R14, R15];

/**
 * How often a name has to be read before it is worth a register of its own.
 *
 * Keeping one costs a push and a read back, which is five bytes against the
 * one a read saves by not reaching into the frame — so a name read a few times
 * is a few bytes larger for the same work. It buys a load retired on every
 * read rather than a smaller object, and the frame it frees is one the next
 * binding takes anyway.
 */
const PINNING_READS = 4;

/**
 * The operations the machine carries out with a literal reached in the
 * instruction rather than a register beside it. A minimum, a maximum, a power
 * and a remainder are not among them: each has its own form, and each of those
 * forms reads two registers.
 */
const FLOAT_OPERATION: Record<string, true> = { add: true, sub: true, mul: true, div: true };

/** The maths builtin each source name is one call of, by the name C gives it. */
const MATH_LIBRARY: Record<string, string> = {
  "Math.abs": "fabs",
  "Math.floor": "floor",
  "Math.trunc": "trunc",
};

/** How wide a value of this type is, which is the width a slot holds it at. */
function widthOf(type: SemanticType): Width {
  if (type.kind !== "primitive") return 8;
  switch (type.name) {
    case "bool":
    case "i8":
    case "u8":
      return 1;
    case "i16":
    case "u16":
      return 2;
    case "i32":
    case "u32":
    case "f32":
      return 4;
    default:
      return 8;
  }
}

/** Whether a whole number of this type is read as signed. */
function signedOf(type: SemanticType): boolean {
  if (type.kind !== "primitive") return true;
  return isUnsigned(type) ? false : true;
}

/**
 * The width an operation on whole numbers is carried out at. A C compiler
 * promotes anything narrower than an `int` to one and carries a shift and a
 * remainder out where it promoted it, so these are the widths an operation here
 * has to use for the same answers.
 */
function operationWidth(type: SemanticType): 4 | 8 {
  return widthOf(type) === 8 ? 8 : 4;
}

function machineError(message: string, detail?: string, functionName?: string): CompilerError {
  return new CompilerError({ category: "AssemblyError", stage: "assemble", message, function: functionName, detail });
}

/* -------------------------------------------------------------------------- */
/* The build                                                                    */
/* -------------------------------------------------------------------------- */

export interface MachineRequest {
  /** The function as the IR holds it, already validated against its contract. */
  fn: SemanticFunction;
  contract: FunctionContract;
  target: TargetSpec;
  /**
   * The symbols of the other functions of the program. An object may call one,
   * because the linker puts the objects beside each other; a symbol outside the
   * runtime, the C library and these is a reference nothing will resolve.
   */
  callable: ReadonlySet<string>;
  /** Where the object is written. */
  objectPath: string;
  candidate?: string;
}

export interface MachineResult {
  objectPath: string;
  objectSizeBytes: number;
  /** The bytes of code, which is what a size objective weighs. */
  textSizeBytes: number;
}

/**
 * The target this backend encodes for. It writes the instructions of one
 * machine, so a target naming another is refused here rather than answered with
 * code no processor of that machine reads.
 *
 * A target that names a processor of that machine is answered rather than
 * refused: what is written is the instruction set every one of them runs, so the
 * code is right for the processor asked for and leaves its extensions alone.
 * That is a question of speed, not of what the program computes.
 */
export function assertMachineTarget(target: TargetSpec): void {
  if (target.arch === "x86_64" && target.abi === "sysv") return;
  throw new CompilerError({
    category: "TargetError",
    stage: "assemble",
    message: `the machine backend cannot build for ${target.arch}-${target.os}-${target.abi}`,
    detail: "it writes x86-64 System V code itself; build with --backend c for another target",
  });
}

/**
 * The object of one function, written and checked.
 *
 * The check is the one every backend owes the program it is linked into: the
 * object defines exactly the symbol the function is called by, and every symbol
 * it refers to is one the runtime, the C library or another function of the
 * program provides. Anything else would be a link failure found after a model
 * had been asked what to do about it.
 */
export async function buildObject(request: MachineRequest): Promise<MachineResult> {
  assertMachineTarget(request.target);
  const functionName = symbolOf(request.contract);
  const object = lowerFunction(request.fn, request.contract, functionName, request.callable);
  await writeFile(request.objectPath, object.bytes);
  const written = inspectWrittenObject(request.objectPath, functionName);
  if (written.defined.length !== 1 || written.defined[0] !== functionName) {
    throw machineError(
      `the object of ${functionName} defines [${written.defined.join(", ")}] instead of only "${functionName}"`,
      "the program links the objects beside each other and calls this one by that name",
      functionName,
    );
  }
  const outside = written.undefined.filter(
    (symbol) => !isRuntimeSymbol(symbol) && LIBRARY[symbol] !== true && !request.callable.has(symbol),
  );
  if (outside.length > 0) {
    throw machineError(
      `${functionName} refers to symbols outside the runtime ABI and the C library: ${outside.join(", ")}`,
      undefined,
      functionName,
    );
  }
  return {
    objectPath: request.objectPath,
    objectSizeBytes: (await stat(request.objectPath)).size,
    textSizeBytes: object.textSizeBytes,
  };
}

/**
 * Every block of a body, itself included, which is what a read census over the
 * whole function is taken across.
 */
function everyBlock(block: SemanticBlock, into: SemanticBlock[] = []): SemanticBlock[] {
  into.push(block);
  for (const statement of block.statements) {
    if (statement.k === "if") {
      everyBlock(statement.then, into);
      if (statement.otherwise !== null) everyBlock(statement.otherwise, into);
    } else if (statement.k === "loop") everyBlock(statement.loop.body, into);
    else if (statement.k === "block") everyBlock(statement.body, into);
  }
  return into;
}

/**
 * Every value a block computes in its own right, nested blocks included, and
 * every value inside those. It is the whole of what the body reads, which is
 * what a value is a candidate to be kept in a register by.
 */
function everyValue(block: SemanticBlock, into: SemanticValue[] = []): SemanticValue[] {
  const add = (value: SemanticValue | null): void => {
    if (value === null) return;
    into.push(value);
    walkValues(value, (one) => into.push(one));
  };
  for (const statement of block.statements) {
    switch (statement.k) {
      case "let":
      case "set":
      case "printText":
      case "printNumber":
      case "retain":
      case "storeField": add(statement.value); break;
      case "setElement": add(statement.index); add(statement.value); break;
      case "if": add(statement.condition); break;
      case "raise": add(statement.message); break;
      case "call": add({ k: "call", type: statement.call.returns, call: statement.call }); break;
      case "loop": {
        const loop = statement.loop;
        if (loop.kind === "counted") { add(loop.from); add(loop.to); add(loop.step); }
        else if (loop.kind === "each") add(loop.length);
        else add(loop.condition);
        for (const nested of everyBlock(loop.body)) everyValue(nested, into);
        break;
      }
      default: break;
    }
  }
  if (block.terminator.k === "return") add(block.terminator.value);
  return into;
}
/** The object a function's machine code is, and the code it carries. */
function lowerFunction(
  fn: SemanticFunction,
  contract: FunctionContract,
  functionName: string,
  callable: ReadonlySet<string>,
): { bytes: Uint8Array; textSizeBytes: number } {
  const machine = new Machine(fn, contract);
  const text = machine.emit();
  for (const symbol of machine.externals) {
    if (isRuntimeSymbol(symbol) || LIBRARY[symbol] === true || symbol === functionName || callable.has(symbol)) continue;
    throw machineError(
      `${functionName} refers to ${symbol}, which is neither the runtime, the C library, nor a function of this program`,
      undefined,
      functionName,
    );
  }
  return {
    bytes: writeObject({
      text,
      rodata: Uint8Array.from(machine.rodata),
      function: { name: fn.symbol, offset: 0, size: text.length },
      labels: machine.labels,
      undefined: machine.externals,
      relocations: machine.code.relocations,
    }).bytes,
    textSizeBytes: text.length,
  };
}

/** What the linker sees in the object that was written. */
function inspectWrittenObject(objectPath: string, functionName: string): { defined: string[]; undefined: string[] } {
  const definedResult = run("nm", ["--defined-only", "--extern-only", objectPath], { timeoutMs: 30_000 });
  const undefinedResult = run("nm", ["--undefined-only", objectPath], { timeoutMs: 30_000 });
  if (definedResult.code !== 0 || undefinedResult.code !== 0) {
    throw machineError(
      `cannot inspect the object of ${functionName}`,
      `${definedResult.stderr}${undefinedResult.stderr}`.trim(),
      functionName,
    );
  }
  const symbolNames = (result: typeof definedResult): string[] =>
    result.stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/).pop() ?? "")
      .filter((symbol) => symbol !== "");
  return { defined: symbolNames(definedResult), undefined: symbolNames(undefinedResult) };
}

/* -------------------------------------------------------------------------- */
/* The lowering                                                                 */
/* -------------------------------------------------------------------------- */

/** A value the lowering keeps in the frame while it builds another. */
interface Held {
  readonly offset: number;
  readonly type: SemanticType;
  /**
   * The register a value that never changes lives in, or null where it lives in
   * the frame. A name that is written once and read after is in a register that
   * a call cannot take, so a read of it is a move and a frame is not reserved
   * for it at all.
   */
  readonly register: number | null;
}

class Machine {
  readonly code = new Encoder();
  readonly rodata: number[] = [];
  /** A literal already laid down, so one string is written to the object once. */
  private readonly literals = new Map<string, string>();
  /** A float already laid down, so one constant is written to the object once. */
  private readonly floatLabels = new Map<string, string>();
  readonly labels: DataLabel[] = [];
  /** The symbols the code calls or reads that this object does not define. */
  readonly externals: string[] = [];

  private readonly names = new NameScope((name) => name);
  private readonly slots = new Map<string, Held>();
  private readonly loops: { header: string; exit: string }[] = [];
  private readonly layouts: Record<string, ObjectLayout>;
  private readonly epilogue = this.code.label("Lepilogue");
  private used = 0;
  private temporaries = 0;
  /** Slots bound for the statements being written and not yet handed back. */
  private readonly borrowed: Held[] = [];
  /** Slots handed back, which the next statement that needs one takes. */
  private readonly spareSlots: number[] = [];
  /** The register a name that never changes is in, by the name it is declared as. */
  private readonly pinned = new Map<string, number>();
  /** The registers the prologue pushes and the epilogue pops, in that order. */
  private pinnedRegisters: number[] = [];
  private lastLiteral = "";

  private readonly fn: SemanticFunction;

  constructor(fn: SemanticFunction, contract: FunctionContract) {
    this.fn = fn;
    // A layout the program lays out is in the function; one only the contract
    // states is the contract's, and both are the same struct to every reader.
    this.layouts = { ...contract.definition.objects, ...fn.objects };
  }

  /* ---------------------------------------------------------------------- */
  /* The frame                                                              */
  /* ---------------------------------------------------------------------- */

  /** Room in the frame, which grows downwards from the frame pointer. */
  private reserve(bytes: number, alignment = 8): number {
    this.used = Math.ceil((this.used + bytes) / alignment) * alignment;
    return -this.used;
  }

  private bind(name: string, type: SemanticType): Held {
    const emitted = this.names.declare(name, type);
    const register = this.pinned.get(emitted) ?? null;
    // A pinned value is in a register and never in the frame, so the frame slot
    // that reads and writes go through is not reserved: an offset of zero is
    // never read, because every use of a held value goes through `load`,
    // `store` or `scratchFrom`, and those three read the register.
    const offset = register === null ? this.reserve(widthOf(type)) : 0;
    const held: Held = { offset, type, register };
    this.slots.set(emitted, held);
    return held;
  }

  private slot(name: string): Held {
    const emitted = this.names.read(name);
    const found = this.slots.get(emitted);
    if (found === undefined) throw machineError(`${this.fn.symbol} reads ${name}, which it does not declare`);
    return found;
  }

  /**
   * A slot the lowering binds for itself, of the type it holds, which is free
   * again when the statement that bound it has been written.
   *
   * Almost every slot a lowering binds for itself is written and read within
   * the one statement that needed it — the right side of an arithmetic, the
   * address of a field, the value a call takes as an argument — so the slot is
   * handed back when that statement is done and the next one that needs one
   * takes it. A frame that grew for every arithmetic the function contains
   * rather than for the few of them live at once also crosses the width at
   * which an instruction addresses a slot in one byte of displacement rather
   * than four, which is a byte on every instruction that reads one.
   */
  private hold(type: SemanticType, prefix: string): Held {
    const held = this.reserveSlot(type, prefix);
    this.borrowed.push(held);
    return held;
  }

  /**
   * A slot that outlives the statement that bound it. A loop's bound and its
   * step are read before the body and never inside it, but the body is written
   * between the two, so these are handed back by hand rather than at the end
   * of the statement the loop is.
   */
  private holdAcross(type: SemanticType, prefix: string): Held {
    return this.reserveSlot(type, prefix);
  }

  private reserveSlot(type: SemanticType, prefix: string): Held {
    this.temporaries += 1;
    const name = this.names.reserve(`${prefix}_${this.temporaries}`);
    const offset = this.spareSlots.pop() ?? this.reserve(Math.max(widthOf(type), 8));
    const held: Held = { offset, type, register: null };
    this.slots.set(name, held);
    return held;
  }

  /**
   * Hands one slot back, so that the next statement that needs one takes it.
   * Only the slots a statement bound for itself are handed back, and only once
   * the statement that bound them has been written.
   */
  private freeSlot(held: Held): void {
    this.spareSlots.push(held.offset);
  }

  /**
   * Hands back every slot bound since the mark, so that the next statement
   * that needs one takes it. The slots go back in the order the frame grew in,
   * so the ones nearest the top of it are handed out again first.
   */
  private freeSlotsSince(mark: number): void {
    for (let at = this.borrowed.length - 1; at >= mark; at -= 1) {
      this.spareSlots.push(this.borrowed[at].offset);
    }
    this.borrowed.length = mark;
  }

  private scratch(bytes: number, prefix: string): number {
    this.temporaries += 1;
    this.names.reserve(`${prefix}_${this.temporaries}`);
    return this.reserve(bytes, 16);
  }

  /**
   * A value written into a slot of its own, which is what a loop bound the
   * program computed rather than wrote out is held in: it is read once before
   * the loop and once on every turn of it, and computing it on a turn would be
   * a read the source never performed.
   */
  private heldAt(type: SemanticType, prefix: string, value: SemanticValue): Held {
    this.at(value, type);
    const held = this.holdAcross(type, prefix);
    this.store(held);
    return held;
  }

  /* ---------------------------------------------------------------------- */
  /* The function itself                                                    */
  /* ---------------------------------------------------------------------- */

  /**
   * Puts the values that never change in registers instead of in the frame.
   *
   * A name that is written once and read after is the same number at every
   * read, which is the one case where a register can be better than a slot
   * without any analysis of where a value is live: there is no second write for
   * a live range to be cut at. The register is one the convention says a callee
   * leaves as it found it, so a value read on both sides of a call survives the
   * call, and no frame is reserved for it at all.
   *
   * What is left is the cap. Five registers are callee-saved and none of them is
   * used for anything else here, so five names at a time, taken in the order of
   * how often they are read: the ones a function reads most are the ones whose
   * every read was a load out of the frame.
   *
   * Only whole numbers are pinned. A float would live in a vector register,
   * which the convention saves as one hundred and twenty eight bits whether the
   * program uses eight of them or not, and this is not worth that for the
   * frames it would save.
   */
  private allocateRegisters(): void {
    const written = new Set<string>();
    const reads = new Map<string, number>();
    const declared: { name: string; type: SemanticType }[] = this.fn.params.map((parameter) => ({
      name: parameter.name,
      type: slotType(parameter),
    }));
    for (const statement of this.fn.entry.statements) {
      if (statement.k === "set" || statement.k === "step") written.add(statement.name);
      if (statement.k === "setElement") written.add(statement.buffer);
      if (statement.k === "loop") {
        const loop = statement.loop;
        if (loop.kind === "counted") written.add(loop.variable);
        else if (loop.kind === "each") {
          written.add(loop.index);
          written.add(loop.element);
        }
      }
    }
    for (const block of everyBlock(this.fn.entry)) {
      for (const statement of block.statements) {
        if (statement.k === "set" || statement.k === "step") written.add(statement.name);
        if (statement.k === "setElement") {
          written.add(statement.buffer);
          // The buffer of a write is named rather than valued, so a census of
          // the values the body computes never sees it read.
          reads.set(statement.buffer, (reads.get(statement.buffer) ?? 0) + 1);
        }
      }
      for (const value of everyValue(block)) {
        if (value.k === "local") reads.set(value.name, (reads.get(value.name) ?? 0) + 1);
      }
    }
    // A name declared inside the body is written again each time its statement
    // runs, so only the ones the body's own statements declare are candidates.
    for (const statement of this.fn.entry.statements) {
      if (statement.k !== "let") continue;
      declared.push({ name: statement.slot.name, type: slotType(statement.slot) });
    }
    const wanted = declared
      .filter((entry) => !isFloat(entry.type) && !written.has(entry.name) && (reads.get(entry.name) ?? 0) >= PINNING_READS)
      .sort((left, right) => (reads.get(right.name) ?? 0) - (reads.get(left.name) ?? 0));
    this.pinnedRegisters = [];
    for (const [index, entry] of wanted.entries()) {
      const register = CALLEE_SAVED[index];
      if (register === undefined) break;
      this.pinned.set(entry.name, register);
      this.pinnedRegisters.push(register);
    }
    // The prologue pushes the registers below the frame pointer, and a slot the
    // lowering binds is reserved from there downwards, so the frame starts
    // below them rather than over the words they are saved in.
    this.used = this.pinnedRegisters.length * 8;
  }

  emit(): Uint8Array {
    this.allocateRegisters();
    this.code.prologue();
    // A pinned value is in a register the convention says a callee leaves as it
    // found it, so the register is pushed here and popped there. The frame below
    // them is what the pushes are counted against: a push moves the stack by
    // half a sixteen byte step, and an odd number of them is made whole again
    // by one more step out of the frame rather than by an instruction of its
    // own.
    for (const register of this.pinnedRegisters) this.code.push(register);
    const frameAt = this.code.subRegImmLater(RSP);
    this.parameters();
    // The body opens a scope of its own, and the parameters are read in it, so
    // they are declared one scope further out.
    this.names.enter();
    this.block(this.fn.entry);
    this.code.bind(this.epilogue);
    this.code.epilogue(this.pinnedRegisters);
    // The frame is a whole number of sixteen byte steps, so the stack is
    // aligned at every call the body makes: a call pushes eight bytes onto a
    // stack the callee reads as sixteen byte aligned.
    this.code.patchWord(frameAt, this.frameBytes());
    return this.code.finish();
  }

  /**
   * The frame, as a whole number of sixteen byte steps and, where the pushes
   * above left the stack half a step out, one more half.
   */
  private frameBytes(): number {
    const whole = Math.ceil(this.used / 16) * 16;
    return this.pinnedRegisters.length % 2 === 0 ? whole : whole + 8;
  }

  /**
   * The arguments as they arrive: the first six whole numbers and the first
   * eight floats come in registers, and the rest are on the stack above the
   * return address. An argument of a class that has run out of registers goes on
   * the stack, and so does every argument after it.
   */
  private parameters(): void {
    let general = 0;
    let floating = 0;
    let stack = 0;
    for (const parameter of this.fn.params) {
      const type = slotType(parameter);
      const held = this.bind(parameter.name, type);
      const offset = held.offset;
      const register = stack > 0 ? undefined : isFloat(type) ? SSE_ARGUMENTS[floating] : INTEGER_ARGUMENTS[general];
      if (held.register !== null) {
        // A parameter that is pinned is in a register from here on, so the
        // frame copy it would otherwise be written to is not made. It arrives
        // in an argument register or on the stack, and either is one move into
        // the register it is pinned to.
        if (register === undefined) this.code.movRegMem(held.register, frame(16 + stack * 8));
        else this.code.movRegReg(held.register, register);
        if (register !== undefined) {
          if (isFloat(type)) floating += 1;
          else general += 1;
        } else {
          stack += 1;
        }
        continue;
      }
      if (register === undefined) {
        // An argument of a class that has run out of registers is on the stack
        // above the return address, and so is every argument after it.
        this.code.movRegMem(RAX, frame(16 + stack * 8));
        this.code.movMemRegSized(frame(offset), RAX, widthOf(type));
        stack += 1;
        continue;
      }
      if (isFloat(type)) {
        floating += 1;
        this.code.movsStore(frame(offset), register, widthOf(type) === 4);
        continue;
      }
      general += 1;
      this.code.movMemRegSized(frame(offset), register, widthOf(type));
    }
  }

  /* ---------------------------------------------------------------------- */
  /* The accumulator and the frame                                          */
  /* ---------------------------------------------------------------------- */

  /** The accumulator holding the value a slot has. */
  private load(held: Held): void {
    if (held.register !== null) {
      this.code.movRegReg(RAX, held.register);
      return;
    }
    if (isFloat(held.type)) {
      this.code.movsLoad(XMM0, frame(held.offset), widthOf(held.type) === 4);
      return;
    }
    this.code.movRegMemSized(RAX, frame(held.offset), widthOf(held.type), signedOf(held.type));
  }

  /**
   * The value the accumulator has, written at the address a register holds.
   * The displacement is the offset of a field in the object that address
   * points at, so a write to a field is one instruction rather than a move
   * of the address, an addition to it, and the write.
   */
  private storeInto(type: SemanticType, address: number, displacement = 0): void {
    if (isFloat(type)) {
      this.code.movsStore(mem(address, displacement), XMM0, widthOf(type) === 4);
      return;
    }
    this.code.movMemRegSized(mem(address, displacement), RAX, widthOf(type));
  }

  /** A slot holding the value the accumulator has. */
  private store(held: Held): void {
    if (held.register !== null) {
      this.code.movRegReg(held.register, RAX);
      return;
    }
    if (isFloat(held.type)) {
      this.code.movsStore(frame(held.offset), XMM0, widthOf(held.type) === 4);
      return;
    }
    this.code.movMemRegSized(frame(held.offset), RAX, widthOf(held.type));
  }

  /**
   * The value at the address the accumulator has, read as the type it is.
   * The displacement is the offset of a field in the object that address
   * points at, which is how a read of a field is one instruction rather than
   * an addition to the address and then the read.
   */
  private readAt(type: SemanticType, displacement = 0): void {
    if (isFloat(type)) {
      this.code.movsLoad(XMM0, mem(RAX, displacement), widthOf(type) === 4);
      return;
    }
    this.code.movRegMemSized(RAX, mem(RAX, displacement), widthOf(type), signedOf(type));
  }

  /** The value in a slot of the frame, read as the type it is declared at. */
  private readSlotAt(type: SemanticType, offset: number): void {
    if (isFloat(type)) {
      this.code.movsLoad(XMM0, frame(offset), widthOf(type) === 4);
      return;
    }
    this.code.movRegMemSized(RAX, frame(offset), widthOf(type), signedOf(type));
  }

  /** The accumulator widened to the width and sign of the type it is read as. */
  private normalize(type: SemanticType): void {
    if (isFloat(type) || widthOf(type) === 8) return;
    this.code.narrow(RAX, RAX, widthOf(type), signedOf(type));
  }

  /**
   * The same widening, for a value that has just come out of an operation
   * carried out at the width the type is stored at.
   *
   * The invariant this rests on: an operation the machine carries out on the
   * thirty-two bit half of a register writes that half and nothing above it,
   * so the whole register already holds the value widened the way an unsigned
   * thirty-two bit type is widened and there is nothing left to do. A signed
   * type still needs its `movsxd`, because a thirty-two bit operation leaves
   * the sign in the thirty-first bit rather than copying it upwards, and so
   * does every type narrower than a word.
   *
   * It is only sound where the value provably came from such an operation. A
   * value a callee handed back is not one: the convention says nothing about
   * what the upper half of the return register holds, so a call is normalized
   * the long way.
   */
  private normalizeArithmetic(type: SemanticType): void {
    if (isFloat(type) || widthOf(type) === 8) return;
    if (widthOf(type) === 4 && !signedOf(type)) return;
    this.code.narrow(RAX, RAX, widthOf(type), signedOf(type));
  }

  /** The scratch register holding what the accumulator has. */
  private toScratch(type: SemanticType): void {
    if (isFloat(type)) {
      this.code.movsMove(XMM1, XMM0, widthOf(type) === 4);
      return;
    }
    this.code.movRegReg(RCX, RAX);
  }

  /**
   * The scratch register holding what a slot holds. The other side of an
   * operation is read out of its slot at the last moment rather than kept in a
   * register across the evaluation of this one, which would be clobbered by
   * every operation the value itself is made of.
   */
  private scratchFrom(held: Held): void {
    if (held.register !== null) {
      this.code.movRegReg(RCX, held.register);
      return;
    }
    if (isFloat(held.type)) {
      this.code.movsLoad(XMM1, frame(held.offset), widthOf(held.type) === 4);
      return;
    }
    this.code.movRegMem(RCX, frame(held.offset));
  }

  /* ---------------------------------------------------------------------- */
  /* Blocks and statements                                                  */
  /* ---------------------------------------------------------------------- */

  private block(block: SemanticBlock): void {
    this.names.enter();
    // A statement binds the slots it needs for itself, so the frame is left
    // holding the few of them that are live at once rather than the sum of
    // every one the function ever bound.
    const mark = this.borrowed.length;
    for (const statement of block.statements) this.statement(statement);
    this.freeSlotsSince(mark);
    for (const name of block.releases) this.release(name);
    this.terminator(block.terminator);
    // A block that leaves for another one has written the jump that does it,
    // and that jump is not one the lowering laid out to reach whatever comes
    // next here.
    if (block.terminator.k === "jump") this.code.sealJump();
    this.names.leave();
  }

  private statement(statement: SemanticStatement): void {
    switch (statement.k) {
      case "let": {
        const type = slotType(statement.slot);
        if (statement.slot.kind === "buffer") {
          this.value(statement.value);
          this.store(this.bind(statement.slot.name, type));
          return;
        }
        this.at(statement.value, type);
        this.store(this.bind(statement.slot.name, type));
        return;
      }
      case "set":
        this.assign(statement.name, statement.op, statement.value);
        return;
      case "setElement": {
        const buffer = this.slot(statement.buffer);
        const element = elementTypeOf(buffer.type) ?? statement.value.type;
        const place = this.hold(POINTER, "blaze_place");
        this.at(statement.value, element);
        const written = this.hold(element, "blaze_element");
        this.store(written);
        this.addressOf(statement.buffer, statement.index, element);
        this.store(place);
        if (statement.op !== "=") {
          this.readSlotAt(element, place.offset);
          const read = this.hold(element, "blaze_read");
          this.store(read);
          this.load(written);
          this.toScratch(element);
          this.load(read);
          this.apply(COMPOUND[statement.op.slice(0, -1)], element);
          this.normalizeArithmetic(element);
        } else {
          this.load(written);
        }
        this.code.movRegMem(RCX, frame(place.offset));
        this.storeInto(element, RCX);
        return;
      }
      case "step": {
        const target = this.slot(statement.name);
        this.load(target);
        this.one(target.type, statement.op === "++" ? "add" : "sub");
        this.normalizeArithmetic(target.type);
        this.store(target);
        return;
      }
      case "printText":
        this.value(statement.value);
        this.code.movRegReg(RDI, RAX);
        this.runtime("_print_text");
        return;
      case "printNumber":
        this.at(statement.value, NUMBER);
        this.runtime("_print_number");
        return;
      case "printNewline":
        this.runtime("_print_newline");
        return;
      case "retain":
        this.value(statement.value);
        this.code.movRegReg(RDI, RAX);
        this.runtime("_retain");
        return;
      case "raise":
        this.value(statement.message);
        this.code.movRegReg(RDI, RAX);
        this.runtime("_raise");
        return;
      case "call":
        this.callValue(statement.call, null);
        return;
      case "storeField":
        this.storeField(statement.object, statement.layout, statement.field, statement.value);
        return;
      case "if": {
        const otherwise = this.code.label("Lelse");
        const end = this.code.label("Lend");
        // With no other arm there is nothing at `otherwise` to reach: the arm
        // that is not taken is the end of the statement itself, so the branch
        // goes there and no jump over the other arm is written at all. What
        // that jump used to be was five bytes moving zero.
        this.truthBranch(statement.condition, false, statement.otherwise === null ? end : otherwise);
        this.block(statement.then);
        if (statement.otherwise !== null) {
          // An arm that returns or leaves for another block never comes back
          // here, so the jump over the other arm is written only when the arm
          // does fall out of the end of it.
          if (statement.then.terminator.k === "next") this.code.jmp(end);
          this.code.bind(otherwise);
          this.block(statement.otherwise);
        }
        this.code.bind(end);
        return;
      }
      case "block":
        this.block(statement.body);
        return;
      case "loop":
        this.loop(statement.loop);
        return;
    }
  }

  /** A name given a value, or one changed by the operator it was written with. */
  private assign(name: string, op: string, value: SemanticValue): void {
    const target = this.slot(name);
    // A string grows: `+=` is a new value rather than an addition in place, and
    // two addresses added together are not a string.
    if (op === "+=" && isTextType(target.type)) {
      this.concat({ k: "local", type: TEXT, name }, value, target.type);
      this.store(target);
      return;
    }
    if (op === "=") {
      this.at(value, target.type);
      this.store(target);
      return;
    }
    // Every other operator reads what the name holds, so the value it is given
    // is read into a slot first: it would otherwise be computed once per side of
    // the operation. The target's own value then goes straight into the scratch
    // the operation takes its other side from, where a load and a move would be
    // two instructions for the one read.
    const right = this.hold(target.type, "blaze_value");
    this.at(value, target.type);
    this.store(right);
    this.scratchFrom(target);
    this.load(right);
    this.apply(COMPOUND[op.slice(0, -1)], target.type);
    this.normalizeArithmetic(target.type);
    this.store(target);
  }

  private storeField(object: SemanticValue, layoutName: string, name: string, value: SemanticValue): void {
    const found = this.field(layoutName, name);
    const type = parseType(found.type);
    if (this.keepsScratch(object) && this.keepsScratch(value)) {
      // Neither side writes the scratch, so the address is taken first and the
      // value is written straight through it. The other order has to write the
      // value to the frame and read it back, because taking the address of the
      // object is what takes the scratch.
      this.value(object);
      this.code.lea(RCX, mem(RAX, found.offset));
      this.at(value, type);
      this.storeInto(type, RCX);
      return;
    }
    this.at(value, type);
    const written = this.hold(type, "blaze_field");
    this.store(written);
    // The address of the field is one `lea` rather than a copy of the object
    // and an addition to it: the offset of a field is a displacement the
    // machine computes for itself, not an arithmetic the lowering writes out.
    this.value(object);
    this.code.lea(RCX, mem(RAX, found.offset));
    this.load(written);
    this.storeInto(written.type, RCX);
  }

  /**
   * Whether writing a value leaves the scratch register as it found it, which
   * is what lets a value already held in it survive the writing of another.
   *
   * A name, a number, a truth and a null are read or written as they are. A
   * field read takes the object through the accumulator and reads the field
   * through it, so it takes neither register of its own when the object takes
   * neither either. Everything else is either written through the scratch — an
   * arithmetic, a comparison, an element read, a string — or is a call that
   * takes it away, and a value that does either is written the long way round.
   */
  private keepsScratch(value: SemanticValue): boolean {
    switch (value.k) {
      case "local":
      case "const":
      case "bool":
      case "nothing":
        return true;
      case "loadField":
        return this.keepsScratch(value.object);
      default:
        return false;
    }
  }

  private loop(loop: SemanticLoop): void {
    this.names.enter();
    this.loops.push({ header: loop.header, exit: loop.exit });
    switch (loop.kind) {
      case "while": {
        this.code.bind(loop.header);
        this.truthBranch(loop.condition, false, loop.exit);
        this.block(loop.body);
        // The same, for the edge back to the header: a body that returns or
        // breaks never reaches the test again, so the jump is not written.
        if (loop.body.terminator.k === "next") this.code.jmp(loop.header);
        this.code.bind(loop.exit);
        break;
      }
      case "doWhile": {
        this.code.bind(loop.header);
        this.block(loop.body);
        this.truthBranch(loop.condition, true, loop.header);
        this.code.bind(loop.exit);
        break;
      }
      case "counted":
        this.counted(loop);
        break;
      case "each":
        this.each(loop);
        break;
    }
    this.loops.pop();
    this.names.leave();
  }

  /**
   * A loop that counts from one number to another. The bound and the step are
   * read once, because a `for` reads its bound on every turn and adds its step
   * on every turn, so a bound or a step the IR calls is a call the loop would
   * otherwise make once per turn. The header label sits on the step, which is
   * where a `continue` belongs, and the first turn is entered at the test.
   */
  private counted(loop: Extract<SemanticLoop, { kind: "counted" }>): void {
    const type = loop.type;
    this.at(loop.from, type);
    const from = this.holdAcross(type, "blaze_from");
    this.store(from);
    const writtenTo = this.immediateOf(loop.to, type);
    const to: Held | number = writtenTo ?? this.heldAt(type, "blaze_to", loop.to);
    let step: Held | number | null = null;
    if (loop.step !== null) {
      // A step the program wrote out is the same number on every turn, so it
      // is carried by the instruction that adds it rather than by a slot it is
      // read out of on each of them.
      const number = this.immediateOf(loop.step, type);
      if (number !== null) {
        step = number;
      } else {
        this.at(loop.step, type);
        step = this.holdAcross(type, "blaze_step");
        this.store(step);
      }
    }
    const variable = this.bind(loop.variable, type);
    this.load(from);
    this.store(variable);
    const test = this.code.label("Ltest");
    this.code.jmp(test);
    this.code.bind(loop.header);
    // The counter is stepped once per turn and then tested, and both of those
    // read the accumulator the step leaves the counter in.
    if (step === null) {
      this.load(variable);
      this.one(type, loop.down ? "sub" : "add");
    } else if (typeof step === "number") {
      this.load(variable);
      this.code.aluImm(loop.down ? "sub" : "add", RAX, step, operationWidth(type) === 8);
    } else {
      this.scratchFrom(step);
      this.load(variable);
      this.apply(loop.down ? "sub" : "add", type);
    }
    this.normalizeArithmetic(type);
    this.store(variable);
    this.code.bind(test);
    // Nothing is written between the store above and the test, so the counter
    // is still in the accumulator and reading the slot it was just written to
    // would be loading a value that is already there.
    this.comparedBranch(
      type,
      loop.inclusive ? (loop.down ? "ge" : "le") : loop.down ? "gt" : "lt",
      to,
      false,
      loop.exit,
    );
    this.block(loop.body);
    if (loop.body.terminator.k === "next") this.code.jmp(loop.header);
    this.code.bind(loop.exit);
    // The slots the header was read into are dead now the loop is written, and
    // whatever the statement after this one binds takes them.
    this.freeSlot(from);
    if (typeof to !== "number") this.freeSlot(to);
    if (typeof step !== "number" && step !== null) this.freeSlot(step);
  }

  /**
   * A loop that walks an array. The buffer is read in the scope the loop was
   * entered in, and its length is read once, for the same reason a counted
   * loop's bound is.
   */
  private each(loop: Extract<SemanticLoop, { kind: "each" }>): void {
    this.at(loop.length, USIZE);
    const length = this.holdAcross(USIZE, "blaze_length");
    this.store(length);
    const index = this.bind(loop.index, USIZE);
    this.code.movRegImm(RAX, 0n);
    this.store(index);
    const test = this.code.label("Ltest");
    this.code.jmp(test);
    this.code.bind(loop.header);
    this.code.movRegMem(RAX, frame(index.offset));
    this.code.aluImm("add", RAX, 1);
    this.store(index);
    this.code.bind(test);
    // The same as in a counted loop: the count was just written and the
    // accumulator still holds it.
    this.code.aluRegMem("cmp", RAX, frame(length.offset), true);
    this.code.jcc("ae", loop.exit);
    this.addressOf(loop.of, { k: "local", type: USIZE, name: loop.index }, loop.elementType);
    this.readAt(loop.elementType);
    this.store(this.bind(loop.element, loop.elementType));
    this.block(loop.body);
    if (loop.body.terminator.k === "next") this.code.jmp(loop.header);
    this.code.bind(loop.exit);
    // The length was read before the body and is dead now the loop is written.
    this.freeSlot(length);
  }

  /**
   * The flags saying whether a value is true. An empty string is false and an
   * absent reference is false, as they are in the language, and a value that is
   * not a number is true, which is what a comparison that is not ordered says.
   */
  private truth(value: SemanticValue): void {
    this.value(value);
    this.truthOfAccumulator(value.type);
  }

  /**
   * The same truth asked of the value the accumulator already holds, which is
   * what lets a caller that has just read a value into it branch on it without
   * reading the value a second time.
   */
  private truthOfAccumulator(type: SemanticType): void {
    if (isTextType(type)) {
      this.code.movRegMemSized(RCX, mem(RAX), 1, false);
      this.code.test(RCX);
      return;
    }
    if (isFloat(type)) {
      this.floatTruth(type);
      return;
    }
    this.code.test(RAX);
  }

  /**
   * A branch on whether a value is true, and nothing else.
   *
   * A value that is a comparison is the case this exists for. The comparison
   * already leaves in the flags the answer every caller of `truth` goes on to
   * ask about, so the branch reads them where they are: the condition byte is
   * never widened into the accumulator, and the `test` that asked whether it
   * was zero never happens. The side that is not a comparison is put in the
   * accumulator and asked of it as before.
   */
  private truthBranch(value: SemanticValue, whenTrue: boolean, label: string): void {
    if (value.k === "isNull" && !isTextType(value.operand.type)) {
      // A test of a reference is a test of the pointer holding it, and the
      // answer is a branch on the pointer rather than a truth written down as
      // a number and tested again. `is_null` is the test itself and
      // `is_not_null` is its negation, so which of the two conditions the
      // branch reads is the one the test holds under for the sense asked for.
      this.value(value.operand);
      this.truthOfAccumulator(value.operand.type);
      this.code.jcc((whenTrue ? !value.negate : value.negate) ? "e" : "ne", label);
      return;
    }
    if (value.k === "compare" && !isTextType(value.operand)) {
      const type = value.operand;
      // Which form the comparison takes is settled before either side is
      // written, so that a side is evaluated once whichever form it is.
      const immediate = this.immediateOf(value.right, type);
      if (immediate !== null) {
        const condition = COMPARISON[signedOf(type) ? "signed" : "unsigned"][value.op];
        this.at(value.left, type);
        this.cmpHeld(type, immediate);
        this.code.jcc(whenTrue ? condition : NEGATED[condition], label);
        return;
      }
      const right = this.hold(type, "blaze_right");
      this.at(value.right, type);
      this.store(right);
      this.at(value.left, type);
      this.comparedBranch(type, value.op, right, whenTrue, label);
      return;
    }
    this.truth(value);
    this.code.jcc(whenTrue ? "ne" : "e", label);
  }

  /**
   * `!` over a comparison, read out of the flags the comparison leaves rather
   * than out of a number the comparison was first written down as.
   */
  private comparedNegated(value: SemanticValue & { k: "compare" }): void {
    const type = value.operand;
    const immediate = this.immediateOf(value.right, type);
    if (immediate !== null) {
      this.at(value.left, type);
      this.cmpHeld(type, immediate);
    } else {
      const right = this.hold(type, "blaze_right");
      this.at(value.right, type);
      this.store(right);
      this.at(value.left, type);
      this.cmpHeld(type, right);
    }
    this.code.setcc(NEGATED[COMPARISON[signedOf(type) ? "signed" : "unsigned"][value.op]], RAX);
    this.code.movzxReg8(RAX, RAX);
  }

  /**
   * A float is true when it is not zero, and a value that is no number is too.
   * The `movzx` that turns the two condition bytes into a number sets the
   * zero flag from that number, so the truth is in the flags once the move is
   * written and nothing has to ask about it afterwards.
   */
  private floatTruth(type: SemanticType): void {
    this.code.xorFloat(XMM2, XMM2);
    this.code.sseCompare(XMM0, XMM2, widthOf(type) === 4, false);
    this.code.setcc("ne", RAX);
    this.code.setcc("p", RCX);
    this.code.alu8("or", RAX, RCX);
    this.code.movzxReg8(RAX, RAX);
  }

  private terminator(terminator: SemanticTerminator): void {
    if (terminator.k === "next") return;
    if (terminator.k === "return") {
      if (terminator.value !== null) this.at(terminator.value, this.fn.returns);
      this.code.jmp(this.epilogue);
      return;
    }
    for (const name of terminator.releases) this.release(name);
    const open = this.loops[this.loops.length - 1];
    if (open === undefined || (terminator.target !== open.header && terminator.target !== open.exit)) {
      throw machineError(`${this.fn.symbol} jumps for a block no loop around it names`, terminator.target);
    }
    this.code.jmp(terminator.target);
  }

  private release(name: string): void {
    const held = this.slot(name);
    this.load(held);
    this.code.movRegReg(RDI, RAX);
    this.runtime("_release");
  }

  /* ---------------------------------------------------------------------- */
  /* Values                                                                 */
  /* ---------------------------------------------------------------------- */

  /** A value read as the type a use fixes it at. */
  private at(value: SemanticValue, as: SemanticType | null): void {
    this.value(value);
    if (as === null) return;
    this.convert(value.type, as);
  }

  /**
   * A value in the accumulator: a whole number or a reference in `rax`, a float
   * in `xmm0`, and a whole number widened to fill the register so that a value
   * is always the number its type names and never the bits of something wider.
   */
  private value(value: SemanticValue): void {
    switch (value.k) {
      case "const":
        this.constant(value);
        return;
      case "bool":
        this.code.movRegImm(RAX, value.value ? 1n : 0n);
        return;
      case "nothing":
        this.zero(value.type);
        return;
      case "local":
        this.load(this.slot(value.name));
        return;
      case "text":
        this.text(value);
        return;
      case "toText":
        this.asText(value.of);
        return;
      case "call":
        this.callValue(value.call, value.type);
        return;
      case "newObject":
        this.object(value);
        return;
      case "loadField":
        // The offset of the field is the displacement of the read, so the
        // address is not adjusted in a register first: the accumulator is
        // still the object, and the read reaches the field itself.
        this.value(value.object);
        this.readAt(value.type, this.field(value.layout, value.field).offset);
        return;
      case "length":
        this.length(value.of);
        return;
      case "element": {
        // An element is read at the width the array holds it at, and a use
        // that widens it converts it afterwards: an array of single precision
        // numbers read as a double is one element widened, not two.
        const element = elementTypeOf(value.of.type) ?? value.type;
        this.addressOf(value.of, value.index, element);
        this.readAt(element);
        this.convert(element, value.type);
        return;
      }
      case "argv":
        if (value.index === null) {
          this.runtime("_argv_count");
          return;
        }
        this.at(value.index, USIZE);
        this.code.movRegReg(RDI, RAX);
        this.runtime("_argv");
        return;
      case "isNull":
        this.value(value.operand);
        this.code.test(RAX);
        this.code.setcc(value.negate ? "ne" : "e", RAX);
        this.code.movzxReg8(RAX, RAX);
        return;
      case "unary":
        this.unary(value);
        return;
      case "arith":
        this.arithmetic(value);
        return;
      case "compare":
        this.comparison(value);
        return;
      case "logical":
        this.logical(value);
        return;
      case "coalesce":
        this.coalesce(value);
        return;
      case "select":
        this.select(value);
        return;
      case "buffer":
        this.buffer(value);
        return;
    }
  }

  private zero(type: SemanticType): void {
    if (isFloat(type)) {
      this.code.xorFloat(XMM0, XMM0);
      return;
    }
    this.code.movRegImm(RAX, 0n);
  }

  private constant(value: SemanticValue & { k: "const" }): void {
    if (isFloat(value.type)) {
      const single = widthOf(value.type) === 4;
      this.code.movsLoadLabel(XMM0, this.floatLiteral(floatBits(Number(decimalText(value.text)), single)), single);
      return;
    }
    const whole = integerText(value.text);
    this.code.movRegImm(RAX, whole);
    // A literal already the number its type holds needs nothing written after
    // it: the register already holds it at its own width, and narrowing it is
    // the same value read back. One instruction per literal, for nothing.
    if (!this.writtenWhole(whole, value.type)) this.normalize(value.type);
  }

  /**
   * Whether a whole number written out is already the number its type holds.
   *
   * The test is the literal's own range and not the width of the register it
   * was written into: a negative literal is sign-extended, and an unsigned
   * type keeps a top bit the register has already filled with zeros.
   */
  private writtenWhole(value: bigint, type: SemanticType): boolean {
    if (value < 0n) return false;
    const top = 1n << BigInt(widthOf(type) * 8);
    if (value >= top) return false;
    return isUnsigned(type) || value < top / 2n;
  }

  /* ---------------------------------------------------------------------- */
  /* Operations                                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * An operation whose two sides are in place: the accumulator holds the left
   * and the scratch register the right. A division is the one that cannot be
   * written in place, because the machine divides the accumulator widened to
   * twice its width and answers in two registers.
   */
  private apply(operation: "add" | "sub" | "mul" | "div" | "mod" | "shl" | "shr" | "sar" | "and" | "or" | "xor", type: SemanticType): void {
    if (isFloat(type)) {
      const names = { add: "add", sub: "sub", mul: "mul", div: "div" } as const;
      if (operation in names) this.code.sse(names[operation as "add" | "sub" | "mul" | "div"], XMM0, XMM1, widthOf(type) === 4);
      return;
    }
    const wide = operationWidth(type) === 8;
    switch (operation) {
      case "add":
      case "sub":
      case "and":
      case "or":
      case "xor":
        this.code.alu(operation, RAX, RCX, wide);
        return;
      case "mul":
        this.code.imul(RAX, RCX, wide);
        return;
      case "shl":
      case "shr":
        // A shift right keeps the sign of a signed number and fills a whole
        // number with zeros of an unsigned one, which is what the sign of the
        // type says. The count is taken at the width the language carries the
        // shift out at, which is the width the sides were promoted to.
        this.code.aluImm("and", RCX, wide ? 63 : 31);
        this.code.shift(operation === "shr" && signedOf(type) ? "sar" : operation, RAX, wide);
        return;
      case "div":
      case "mod": {
        // A division is of twice the width of the number, and what the high
        // half holds is what says whether the two are read as signed: a sign
        // repeated for a signed number, and nothing at all for an unsigned one.
        const unsigned = isUnsigned(type);
        if (unsigned) this.code.alu("xor", RDX, RDX, false);
        else this.code.signExtend(wide);
        this.code.divide(unsigned ? "div" : "idiv", RCX, wide);
        if (operation === "mod") this.code.movRegReg(RAX, RDX);
        return;
      }
      default:
        throw machineError(`${this.fn.symbol} performs ${operation}, which is not an operation of a number`);
    }
  }

  /** One, added to or taken from the value the accumulator has. */
  private one(type: SemanticType, operation: "add" | "sub"): void {
    if (isFloat(type)) {
      const single = widthOf(type) === 4;
      this.code.sseMemLabel(operation, XMM0, this.floatLiteral(floatBits(1, single)), single);
      return;
    }
    this.code.aluImm(operation, RAX, 1, operationWidth(type) === 8);
  }

  /**
   * A number as the float a register reads, at the precision asked for. The
   * register is named by the caller because one is the other side of an
   * operation and one is the only register left when a value is in the
   * accumulator and the scratch beside it.
   */
  private floatConstant(value: number, type: SemanticType, destination: number): void {
    const single = widthOf(type) === 4;
    this.code.movsLoadLabel(destination, this.floatLiteral(floatBits(value, single)), single);
  }

  /**
   * A comparison as a number: one when it holds and zero when it does not. The
   * accumulator holds the left side and the slot the right, and every
   * comparison of a value that is not a number is false.
   *
   * `UCOMISD` sets all three of the ordered flags at once when either side is
   * not a number, so the carry the below conditions read is set on exactly the
   * comparison that must be false: `CF` fires `b` and `be`, and the two
   * conditions above it stay false because the same instruction clears their
   * carry. The parity flag is the one that says a comparison was ordered, so
   * the two conditions that read the carry are gated on it — the same pair the
   * equal arms below gate on, for the same reason.
   */
  private compare(type: SemanticType, op: CompareOp, right: Held | number): void {
    if (isFloat(type)) {
      const single = widthOf(type) === 4;
      if (typeof right === "number") this.code.movsLoadLabel(XMM1, this.floatLiteral(floatBits(right, single)), single);
      else this.code.movsLoad(XMM1, frame(right.offset), single);
      this.code.sseCompare(XMM0, XMM1, single, true);
      switch (op) {
        case "lt":
        case "le":
          this.code.setcc(op === "lt" ? "b" : "be", RAX);
          this.code.setcc("np", RCX);
          this.code.alu8("and", RAX, RCX);
          break;
        case "gt":
          this.code.setcc("a", RAX);
          break;
        case "ge":
          this.code.setcc("ae", RAX);
          break;
        case "eq":
          // Equal and ordered: a value that is not a number compares equal to
          // nothing at all, and the parity bit is what says so.
          this.code.setcc("e", RAX);
          this.code.setcc("np", RCX);
          this.code.alu8("and", RAX, RCX);
          break;
        case "ne":
          this.code.setcc("ne", RAX);
          this.code.setcc("p", RCX);
          this.code.alu8("or", RAX, RCX);
          break;
      }
      this.code.movzxReg8(RAX, RAX);
      return;
    }
    this.cmpHeld(type, right);
    this.code.setcc(COMPARISON[signedOf(type) ? "signed" : "unsigned"][op], RAX);
    this.code.movzxReg8(RAX, RAX);
  }

  /**
   * A comparison of two whole numbers, left in the flags rather than turned
   * into a number. The accumulator holds the left side and the other is a slot
   * in the frame or a number in the instruction, and both sides are compared
   * at the width the language promotes them to.
   */
  private cmpHeld(type: SemanticType, right: Held | number): void {
    if (typeof right === "number") {
      this.code.aluImm("cmp", RAX, right, operationWidth(type) === 8);
      return;
    }
    if (operationWidth(type) === 8) {
      // A whole register wide, so the comparison reads the number where it
      // lies rather than through a copy of it in the scratch. Reading it as a
      // full register was a 64-bit read of a slot a 32-bit store had written,
      // so the compare ran against whatever the upper half of the frame held.
      this.code.aluRegMem("cmp", RAX, frame(right.offset), true);
      return;
    }
    // Narrower, so the read has to widen the number the way the language reads
    // it before it can be compared as one.
    this.code.movRegMemSized(RCX, frame(right.offset), operationWidth(type), signedOf(type));
    this.code.alu("cmp", RAX, RCX, false);
  }
  /**
   * A branch on a comparison: the comparison is left in the flags and the
   * branch reads them there, so the condition byte the value form would have
   * widened into the accumulator is never written at all. This is what a
   * counted loop's test, an `if` and the loops come down to when the IR hands
   * them a comparison — a `movzx` sets the zero flag from the very byte it
   * widens, so the `test` that used to follow it was reading a flag the
   * instruction before it had already set.
   *
   * A float is answered the other way, for the reason the value form above
   * states: the conditions that read the carry a `UCOMISD` leaves have to be
   * gated on the parity bit, which is two instructions rather than one. The
   * number the comparison makes is widened by a `movzx`, which sets the zero
   * flag, so the branch on it is a `jcc` on that flag and not a `test` on it.
   */
  private comparedBranch(type: SemanticType, op: CompareOp, right: Held | number, whenTrue: boolean, label: string): void {
    if (isFloat(type)) {
      const single = widthOf(type) === 4;
      if (typeof right === "number") this.code.movsLoadLabel(XMM1, this.floatLiteral(floatBits(right, single)), single);
      else this.code.movsLoad(XMM1, frame(right.offset), single);
      this.floatBranch(op, single, whenTrue, label);
      return;
    }
    const width = operationWidth(type);
    const condition = COMPARISON[signedOf(type) ? "signed" : "unsigned"][op];
    // Both sides are compared at the width the language promotes them to, and
    // the operand is read at that width too. Reading it as a full register was
    // a 64-bit read of a slot a 32-bit store had written, so the compare ran
    // against whatever the upper half of the frame held: a counted loop whose
    // bound was a small number never reached it and ran until the counter
    // overflowed.
    if (typeof right === "number") {
      this.code.aluImm("cmp", RAX, right, width === 8);
    } else if (width === 8) {
      // A whole register wide, so the read fills the register and the
      // comparison can read it where it lies rather than through a copy of it
      // in the scratch.
      this.code.aluRegMem("cmp", RAX, frame(right.offset), true);
    } else {
      // Narrower, so the read has to widen the number the way the language
      // reads it before it can be compared as one.
      this.code.movRegMemSized(RCX, frame(right.offset), width, signedOf(type));
      this.code.alu("cmp", RAX, RCX, false);
    }
    this.code.jcc(whenTrue ? condition : NEGATED[condition], label);
  }

  /**
   * A branch on a comparison of two floats, answered by the flags themselves.
   *
   * The value form of the same comparison writes two condition bytes and
   * combines them into the accumulator, which is a number a branch then has
   * to test. A branch wants no number, so the comparison is left where it is
   * and the jump reads it there.
   *
   * The sides are compared the other way round, and that is what makes the
   * conditions above the carry the ones the language asks for. `UCOMISD`
   * compares without a sign, so an unordered pair sets every flag below the
   * carry and clears every one above it: with the right side as the one being
   * compared, `a < b` is `b > a` is "above", which an unordered pair cannot
   * set, and `a > b` is "below", which it can, so that one takes the parity bit
   * as a jump of its own rather than as an instruction that combines it with a
   * condition afterwards.
   */
  private floatBranch(op: CompareOp, single: boolean, whenTrue: boolean, label: string): void {
    this.code.sseCompare(XMM1, XMM0, single, true);
    const condition =
      op === "lt" ? "a"
      : op === "le" ? "ae"
      : op === "gt" ? "b"
      : op === "ge" ? "be"
      : op === "eq" ? "e"
      : "ne";
    if (op === "lt" || op === "le") {
      this.code.jcc(whenTrue ? condition : NEGATED[condition], label);
      return;
    }
    // A comparison that was not ordered is false whichever way the branch
    // reads it, so both jumps take the same label: the first for a pair that
    // is not numbers, the second for the condition the language does answer.
    this.code.jcc("p", label);
    this.code.jcc(whenTrue ? condition : NEGATED[condition], label);
  }

  /**
   * The label a float the program wrote out is read at, or null when this
   * value cannot be reached there: it is not a literal, it is at the other
   * precision than the operation reads — which would need a conversion the
   * instruction has none of — or the operation has no form that takes memory.
   */
  private floatOperand(value: SemanticValue, type: SemanticType, op: string): string | null {
    if (!isFloat(type) || value.k !== "const" || !isFloat(value.type)) return null;
    if (FLOAT_OPERATION[op] !== true || widthOf(value.type) !== widthOf(type)) return null;
    return this.floatLiteral(floatBits(Number(decimalText(value.text)), widthOf(type) === 4));
  }

  /**
   * The number an instruction could carry instead of a register, or null when
   * what the value is cannot be written into one.
   *
   * A literal is the same number wherever it is written, so the instruction
   * that consumes it takes it as an immediate and the frame never holds it.
   * The range is the one the immediate forms encode — a sign-extended byte or
   * a sign-extended word — which is every literal a program of this language
   * writes in practice.
   */
  private immediateOf(value: SemanticValue, type: SemanticType): number | null {
    if (isFloat(type)) return null;
    if (value.k === "bool") return value.value ? 1 : 0;
    if (value.k !== "const") return null;
    const parsed = integerText(value.text);
    if (parsed < -0x8000_0000n || parsed > 0x7fff_ffffn) return null;
    return Number(parsed);
  }

  /**
   * An operation whose other side is a number written into the instruction.
   * Only `IMMEDIATE_OPERATIONS` reaches here; the two that have no such form
   * are refused by the caller before the left side is written, so the throw at
   * the end of this is the assertion that neither of them ever arrives.
   */
  private applyImmediate(
    operation: "add" | "sub" | "mul" | "div" | "mod" | "shl" | "shr" | "sar" | "and" | "or" | "xor",
    type: SemanticType,
    value: number,
  ): void {
    const wide = operationWidth(type) === 8;
    switch (operation) {
      case "add":
      case "sub":
      case "and":
      case "or":
      case "xor":
        this.code.aluImm(operation, RAX, value, wide);
        return;
      case "mul":
        this.code.imulImm(RAX, value, wide);
        return;
      case "shl":
      case "shr":
      case "sar":
        // The count of a shift is taken at the width the language masks it to,
        // and the mask is applied here rather than left to the machine, so the
        // count this form carries is the count the language computes.
        this.code.shiftImm(
          operation === "shr" && signedOf(type) ? "sar" : operation,
          RAX,
          value & (wide ? 63 : 31),
          wide,
        );
        return;
      default:
        throw machineError(`${this.fn.symbol} performs ${operation} by a number written out, which the machine has no instruction for`);
    }
  }

  private arithmetic(value: SemanticValue & { k: "arith" }): void {
    const type = value.type;
    if (value.op === "concat") {
      this.concat(value.left, value.right, type);
      return;
    }
    if (value.op === "pow") {
      this.at(value.right, NUMBER);
      const right = this.hold(NUMBER, "blaze_right");
      this.store(right);
      this.at(value.left, NUMBER);
      this.scratchFrom(right);
      this.library("pow");
      return;
    }
    if (value.op === "min" || value.op === "max") {
      this.between(value, value.op === "min");
      return;
    }
    // A right side the program wrote out is carried by the instruction rather
    // than by a slot: an immediate for a whole number, and a literal in the
    // read-only data for a float, so neither is copied into the frame and read
    // back out of it, and the eight bytes the copy lived in are not reserved
    // at all. The left side is written once whichever form is taken, so the
    // question is settled before it is evaluated.
    const literal = this.floatOperand(value.right, type, value.op);
    if (literal !== null) {
      this.at(value.left, type);
      this.code.sseMemLabel(value.op as "add" | "sub" | "mul" | "div", XMM0, literal, widthOf(type) === 4);
      this.normalizeArithmetic(type);
      return;
    }
    const immediate = this.immediateOf(value.right, type);
    if (immediate !== null && IMMEDIATE_OPERATIONS[value.op] === true) {
      this.at(value.left, type);
      this.applyImmediate(value.op, type, immediate);
      this.normalizeArithmetic(type);
      return;
    }
    this.at(value.right, type);
    const right = this.hold(type, "blaze_right");
    this.store(right);
    this.at(value.left, type);
    this.scratchFrom(right);
    this.apply(value.op, type);
    this.normalizeArithmetic(type);
  }

  /**
   * The smaller or the larger of two numbers. Each side answers once, so both
   * are read first: a value the IR calls is a call that would otherwise run
   * twice.
   *
   * A whole number is a move on a condition rather than a branch, which is
   * what the comment here used to say it could not be. It could not be for a
   * choice between two registers, and it is not for a comparison either:
   * `CMOVcc` reads the flags `CMP` left, so the answer is the same one the
   * branch chose, chosen without a guess and without paying for a guess.
   *
   * A float is not. `MINSD` and `MAXSD` answer with their source whenever the
   * comparison does not hold, and a comparison against a value that is not a
   * number never holds — so the instruction cannot say which side was at
   * fault, and `min(NaN, 2)` and `min(2, NaN)` come out the same way whichever
   * way round they are encoded. The language answers both with the right side,
   * and a signed zero is equal to a positive one rather than less than it, so
   * `min(-0.0, 0.0)` is a positive zero. An instruction that answers a pair
   * the wrong way is not a faster branch, it is a different program, so the
   * float keeps the branch and the whole number takes the move.
   */
  private between(value: SemanticValue & { k: "arith" }, smaller: boolean): void {
    const type = value.type;
    const low = this.hold(type, "blaze_low");
    const high = this.hold(type, "blaze_high");
    this.at(value.left, type);
    this.store(low);
    this.at(value.right, type);
    this.store(high);
    if (!isFloat(type)) {
      this.load(low);
      this.scratchFrom(high);
      // The answer is the right side when the comparison does not hold, so the
      // move is written on the condition that says so. The sides are compared
      // at the width the language promotes them to, and that comparison is
      // left in the flags for the move to read.
      this.code.alu("cmp", RAX, RCX, operationWidth(type) === 8);
      const away = COMPARISON[signedOf(type) ? "signed" : "unsigned"][smaller ? "lt" : "gt"];
      this.code.cmov(NEGATED[away], RAX, RCX, operationWidth(type) === 8);
      this.normalizeArithmetic(type);
      return;
    }
    const end = this.code.label("Lpick");
    const keep = this.code.label("Lkeep");
    // The comparison is a value of its own, so the arm it answers with is read
    // again rather than kept in a register through it.
    this.load(low);
    this.compare(type, smaller ? "lt" : "gt", high);
    this.code.test(RAX);
    this.code.jcc("ne", keep);
    this.load(high);
    this.code.jmp(end);
    this.code.bind(keep);
    this.load(low);
    this.code.bind(end);
  }

  private comparison(value: SemanticValue & { k: "compare" }): void {
    const type = value.operand;
    if (isTextType(type)) {
      const left = this.hold(type, "blaze_left");
      const right = this.hold(type, "blaze_right");
      this.at(value.left, TEXT);
      this.store(left);
      this.at(value.right, TEXT);
      this.store(right);
      this.textOrder(value.op, left, right);
      return;
    }
    // A right side the program wrote out is carried by the comparison itself,
    // so it is never written to the frame and read back out of it.
    const written = this.immediateOf(value.right, type);
    if (written !== null) {
      this.at(value.left, type);
      this.compare(type, value.op, written);
      this.normalize(value.type);
      return;
    }
    const right = this.hold(type, "blaze_right");
    this.at(value.right, type);
    this.store(right);
    this.at(value.left, type);
    // The left side is already in the accumulator and stays there: writing it
    // to a slot and reading it back is two instructions that answer nothing.
    this.compare(type, value.op, right);
    this.normalize(value.type);
  }

  /**
   * Which of two strings is the greater, as a number: negative, zero or
   * positive. A string built at run time and one written out are two addresses
   * that can say the same thing, so what they say is compared and not where
   * they are. An absent string is nothing, so it is equal to another absent
   * string and to no other.
   */
  private textOrder(op: CompareOp, left: Held, right: Held): void {
    this.code.movRegMem(RAX, frame(left.offset));
    this.code.movRegMem(RCX, frame(right.offset));
    this.code.alu("cmp", RAX, RCX);
    const byAddress = this.code.label("Lorder");
    const joined = this.code.label("Ljoined");
    this.code.jcc("e", byAddress);
    this.code.test(RAX);
    this.code.jcc("e", byAddress);
    this.code.test(RCX);
    this.code.jcc("e", byAddress);
    this.code.movRegReg(RDI, RAX);
    this.code.movRegReg(RSI, RCX);
    this.library("strcmp");
    this.code.jmp(joined);
    this.code.bind(byAddress);
    this.code.alu("sub", RAX, RCX);
    this.code.bind(joined);
    this.code.aluImm("cmp", RAX, 0);
    const conditions: Record<CompareOp, "e" | "ne" | "l" | "le" | "g" | "ge"> = {
      eq: "e",
      ne: "ne",
      lt: "l",
      le: "le",
      gt: "g",
      ge: "ge",
    };
    this.code.setcc(conditions[op], RAX);
    this.code.movzxReg8(RAX, RAX);
  }

  /**
   * `&&`, `||` and `??` each answer one of two values, and the left one is
   * answered by deciding on it. The left arm is left in the accumulator and
   * the branch reads it there; it is only written down first when the right
   * arm can take the accumulator away from it, which a call does. A call in
   * the right arm is the only thing that clobbers the accumulator — every
   * other operation the IR makes writes through the frame — so a right arm
   * with no call in it leaves the left one where it is and the frame slot it
   * used to take is not reserved at all.
   */
  private logical(value: SemanticValue & { k: "logical" }): void {
    const otherwise = this.code.label("Larm");
    const end = this.code.label("Lend");
    const keep = hasCall(value.right);
    if (!keep && value.left.k === "compare" && isBoolean(value.left.type) && typeEquals(value.left.type, value.type)) {
      // A truth answered by a comparison is the other arm when the comparison
      // does not hold, and a comparison that does not hold is the one truth it
      // can be: so the deciding arm is written down rather than kept, and the
      // comparison is asked of the flags instead of being written as a number
      // first. A `(a < b) && c` is then a comparison and a jump where it was a
      // comparison, a condition byte, a widening, a test and a jump.
      this.truthBranch(value.left, value.op === "and", otherwise);
      this.at(value.right, value.type);
      this.code.jmp(end);
      this.code.bind(otherwise);
      this.code.movRegImm(RAX, value.op === "and" ? 0n : 1n);
      this.code.bind(end);
      return;
    }
    const arm = keep ? this.hold(value.left.type, "blaze_arm") : null;
    this.value(value.left);
    if (arm !== null) this.store(arm);
    this.truthOfAccumulator(value.left.type);
    this.code.jcc(value.op === "and" ? "e" : "ne", otherwise);
    this.at(value.right, value.type);
    this.code.jmp(end);
    this.code.bind(otherwise);
    if (arm !== null) this.load(arm);
    this.convert(value.left.type, value.type);
    this.code.bind(end);
  }

  private coalesce(value: SemanticValue & { k: "coalesce" }): void {
    const kind = valueKind(value.left);
    if (kind !== "null" && kind !== "reference" && !isTextType(value.left.type)) {
      this.value(value.left);
      return;
    }
    const otherwise = this.code.label("Larm");
    const end = this.code.label("Lend");
    // An absent string is an absent pointer and an absent reference is one
    // too, so the test is the same one the `||` above asks: is the value zero.
    // It is asked of the accumulator the arm is already in, unless the right
    // arm is a call and would take the accumulator away from it.
    const keep = hasCall(value.right);
    const arm = keep ? this.hold(value.left.type, "blaze_arm") : null;
    this.value(value.left);
    if (arm !== null) this.store(arm);
    this.code.test(RAX);
    this.code.jcc("e", otherwise);
    this.convert(value.left.type, value.type);
    this.code.jmp(end);
    this.code.bind(otherwise);
    this.at(value.right, value.type);
    this.code.bind(end);
  }

  private select(value: SemanticValue & { k: "select" }): void {
    const otherwise = this.code.label("Larm");
    const end = this.code.label("Lend");
    this.truthBranch(value.condition, false, otherwise);
    this.at(value.then, value.type);
    this.code.jmp(end);
    this.code.bind(otherwise);
    this.at(value.otherwise, value.type);
    this.code.bind(end);
  }

  private unary(value: SemanticValue & { k: "unary" }): void {
    switch (value.op) {
      case "pos":
        this.value(value.operand);
        return;
      case "not": {
        if (value.operand.k === "compare" && !isTextType(value.operand.operand)) {
          // The comparison leaves the answer in the flags and `not` is the
          // other sense of it, so the condition byte is written from those
          // flags. The general form writes the answer down as a number first
          // and then asks whether that number is zero.
          this.comparedNegated(value.operand);
          return;
        }
        // The truth of the operand is asked of the accumulator it is already
        // in: it does not have to be written down and read back to be asked
        // about, and `not` is the one operation that changes no bit of it.
        this.truth(value.operand);
        this.code.setcc("e", RAX);
        this.code.movzxReg8(RAX, RAX);
        return;
      }
      case "bitNot":
        this.value(value.operand);
        this.code.not(RAX);
        this.normalize(value.type);
        return;
      case "neg": {
        const type = value.operand.type;
        this.value(value.operand);
        if (isFloat(type)) {
          // The sign of a float is its highest bit, so a negation turns that one
          // over rather than subtracting from nothing.
          this.code.movRegImm(RAX, widthOf(type) === 4 ? -0x8000_0000n : -0x8000_0000_0000_0000n);
          this.code.movdXmm(XMM1, RAX);
          this.code.xorFloat(XMM0, XMM1);
          return;
        }
        this.code.neg(RAX);
        this.normalize(value.type);
        return;
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Text                                                                   */
  /* -------------------------------------------------------------------------- */

  /**
   * A string, as the pointer the runtime hands out. Text the program wrote is a
   * literal in the read-only data; a value interpolated into it is written by
   * the runtime's own formatter, so a number read into a string is written the
   * way the source language writes it and not by this backend.
   */
  private text(value: SemanticValue & { k: "text" }): void {
    if (value.parts.every((part) => part.k === "text")) {
      this.literal(value.parts.map((part) => (part.k === "text" ? part.value : "")).join(""));
      this.code.leaLabel(RAX, this.lastLiteral);
      return;
    }
    // Every part is measured before the string is laid out, so the buffer that
    // holds it is exactly as long as the parts are.
    const parts = value.parts.map(() => ({ pointer: this.hold(POINTER, "blaze_part"), length: this.hold(USIZE, "blaze_length") }));
    value.parts.forEach((part, at) => {
      if (part.k === "text") {
        this.literal(part.value);
        this.code.leaLabel(RAX, this.lastLiteral);
        this.store(parts[at].pointer);
        this.code.movRegImm(RAX, BigInt(Buffer.byteLength(part.value, "utf8")));
        this.store(parts[at].length);
        return;
      }
      this.asText(part.value);
      this.store(parts[at].pointer);
      this.code.movRegReg(RDI, RAX);
      this.library("strlen");
      this.store(parts[at].length);
    });
    const total = this.hold(USIZE, "blaze_total");
    this.code.movRegImm(RAX, 0n);
    for (const part of parts) {
      this.code.aluRegMem("add", RAX, frame(part.length.offset));
    }
    this.store(total);
    this.code.movRegMem(RAX, frame(total.offset));
    this.code.aluImm("add", RAX, 1);
    this.code.movRegReg(RDI, RAX);
    this.runtime("_allocate");
    const buffer = this.hold(POINTER, "blaze_text");
    this.store(buffer);
    const filled = this.hold(USIZE, "blaze_filled");
    this.code.movRegImm(RAX, 0n);
    this.store(filled);
    for (const part of parts) {
      const skip = this.code.label("Lskip");
      this.code.movRegMem(RAX, frame(part.length.offset));
      this.code.test(RAX);
      this.code.jcc("e", skip);
      this.code.movRegMem(RAX, frame(filled.offset));
      this.code.movRegMem(RCX, frame(buffer.offset));
      this.code.lea(RCX, indexed(RCX, RAX, 1));
      this.code.movRegReg(RDI, RCX);
      this.code.movRegMem(RSI, frame(part.pointer.offset));
      this.code.movRegMem(RDX, frame(part.length.offset));
      this.library("memcpy");
      this.code.movRegMem(RAX, frame(filled.offset));
      this.code.aluRegMem("add", RAX, frame(part.length.offset));
      this.store(filled);
      this.code.bind(skip);
    }
    // The terminator is the byte after the last one written, and the value the
    // body reads is the buffer itself.
    this.code.movRegMem(RAX, frame(filled.offset));
    this.code.movRegMem(RCX, frame(buffer.offset));
    this.code.lea(RAX, indexed(RCX, RAX, 1));
    this.code.movRegReg(RCX, RAX);
    this.code.alu("xor", RAX, RAX, false);
    this.code.movMemRegSized(mem(RCX), RAX, 1);
    this.code.movRegMem(RAX, frame(buffer.offset));
  }

  /**
   * A value as text, as the source language prints one. A number is written by
   * the runtime's own formatter, so it reads the way the source writes it; a
   * truth and an absence are the words the source prints, and a reference that
   * is there is the address the driver prints for one.
   */
  private asText(value: SemanticValue): void {
    if (isTextType(value.type)) {
      this.value(value);
      return;
    }
    if (valueKind(value) === "null") {
      this.literal("null");
      this.code.leaLabel(RAX, this.lastLiteral);
      return;
    }
    if (isBoolean(value.type)) {
      const otherwise = this.code.label("Lword");
      const end = this.code.label("Lend");
      this.value(value);
      this.code.test(RAX);
      this.code.jcc("e", otherwise);
      this.literal("true");
      this.code.leaLabel(RAX, this.lastLiteral);
      this.code.jmp(end);
      this.code.bind(otherwise);
      this.literal("false");
      this.code.leaLabel(RAX, this.lastLiteral);
      this.code.bind(end);
      return;
    }
    if (isReference(value.type)) {
      const pointer = this.hold(value.type, "blaze_reference");
      const otherwise = this.code.label("Lword");
      const end = this.code.label("Lend");
      this.value(value);
      this.store(pointer);
      this.code.movRegMem(RAX, frame(pointer.offset));
      this.code.test(RAX);
      this.code.jcc("e", otherwise);
      this.code.movdXmm(XMM0, RAX);
      this.formatNumber();
      this.code.jmp(end);
      this.code.bind(otherwise);
      this.literal("null");
      this.code.leaLabel(RAX, this.lastLiteral);
      this.code.bind(end);
      return;
    }
    this.at(value, NUMBER);
    this.formatNumber();
  }

  /** The accumulator holding the text of the number `xmm0` holds. */
  private formatNumber(): void {
    const buffer = this.scratch(64, "blaze_number");
    this.code.lea(RDI, frame(buffer));
    this.code.movRegImm(RSI, 64n);
    this.runtime("_format_number");
    // The formatter writes a terminator of its own, and one is written here as
    // well: the buffer is this function's own, and the length it is given is
    // where the string ends.
    this.code.movRegReg(RCX, RAX);
    this.code.lea(RAX, frame(buffer));
    this.code.alu("xor", RDX, RDX, false);
    this.code.movMemRegSized(indexed(RAX, RCX, 1), RDX, 1);
    this.code.lea(RAX, frame(buffer));
  }

  private length(of: SemanticValue): void {
    if (isTextType(of.type)) {
      // A string is as long as its bytes. The runtime counts a string it owns
      // from the header it installed before it, which a string written out in
      // the source does not have, so both are counted as the C library counts
      // them.
      this.value(of);
      this.code.movRegReg(RDI, RAX);
      this.library("strlen");
      return;
    }
    throw machineError(
      `${this.fn.symbol} reads the length of an array, which no machine this compiler writes can answer`,
      "an array reaches a function as a pointer to its first element and no length arrives with it",
    );
  }

  /** Two values as one string, which is what `+` over text and `+=` are. */
  private concat(left: SemanticValue, right: SemanticValue, type: SemanticType): void {
    this.text({
      k: "text",
      type: TEXT,
      parts: [
        { k: "value", value: left },
        { k: "value", value: right },
      ],
    });
    if (!isTextType(type)) this.convert(TEXT, type);
  }

  private literal(text: string): void {
    // A string the program wrote out twice is the same string, so it is laid
    // down once and both places take the address of it.
    const held = this.literals.get(text);
    if (held !== undefined) {
      this.lastLiteral = held;
      return;
    }
    const label = this.code.label("Ltext");
    this.labels.push({ name: label, offset: this.rodata.length });
    for (const byte of Buffer.from(text, "utf8")) this.rodata.push(byte);
    this.rodata.push(0);
    this.literals.set(text, label);
    this.lastLiteral = label;
  }

  /**
   * A float laid down beside the code and read from there by its label.
   *
   * The other way to write a constant is to build it in a register every time
   * it is written: ten bytes of instruction, two of them, and a crossing
   * between the register files each way. A constant the program wrote in the
   * source is the same number everywhere it appears, so it is written once
   * here and read with one instruction at each use — which is what a compiler
   * that lowers a whole program does with a literal it has already seen.
   */
  private floatLiteral(bits: bigint): string {
    const held = this.floatLabels.get(bits.toString());
    if (held !== undefined) return held;
    const label = this.code.label("Lfloat");
    this.labels.push({ name: label, offset: this.rodata.length });
    for (let index = 0; index < 8; index += 1) {
      this.rodata.push(Number((bits >> BigInt(index * 8)) & 0xffn));
    }
    this.floatLabels.set(bits.toString(), label);
    return label;
  }

  /* ---------------------------------------------------------------------- */
  /* Arrays and objects                                                     */
  /* -------------------------------------------------------------------------- */

  /**
   * The address of one element, which is what a read and a write both need
   * before they know the value. The index is read into a slot first, because the
   * sequence may be a value the IR computes and the index may be another.
   */

  /**
   * The index of an element read, or null when it has to be computed.
   *
   * A number the program wrote out is one the instruction can carry. A name is
   * one the frame already holds, but only where reading it is the whole of
   * what the general form does with it: an address is built out of a whole
   * number, so a slot that holds a narrower one is read at its own width and
   * widened, and a float is read as a whole number by a conversion the general
   * form writes. Neither is a plain 64 bit read, so neither takes this path.
   */
  private plainIndex(index: SemanticValue): Held | bigint | null {
    if (index.k === "const") return integerText(index.text);
    if (index.k !== "local") return null;
    const held = this.slot(index.name);
    return isFloat(held.type) || widthOf(held.type) !== 8 ? null : held;
  }

  private readInto(held: Held | bigint, register: number): void {
    if (typeof held === "bigint") this.code.movRegImm(register, held);
    else this.code.movRegMem(register, frame(held.offset));
  }

  private addressOf(sequence: SemanticValue | string, index: SemanticValue, element: SemanticType): void {
    const scale = widthOf(element);
    const base = typeof sequence === "string" ? this.slot(sequence) : sequence.k === "local" ? this.slot(sequence.name) : null;
    // The sequence is a pointer wherever it came from: an array reaches a
    // function as a pointer to its elements, so it is one whole-register read.
    const readable = base !== null && widthOf(base.type) === 8 && !isFloat(base.type);
    const at = readable ? this.plainIndex(index) : null;
    if (readable && base !== null && at !== null) {
      // Both sides are read rather than computed, so neither of them writes a
      // register the other is holding: the address is two reads and one `lea`,
      // where the general form reserves a slot, writes the index into it and
      // reads it back out again.
      this.load(base);
      this.readInto(at, RCX);
      this.code.lea(RAX, indexed(RAX, RCX, scale));
      return;
    }
    const held = this.hold(USIZE, "blaze_index");
    this.at(index, USIZE);
    this.store(held);
    this.value(typeof sequence === "string" ? { k: "local", type: base?.type ?? POINTER, name: sequence } : sequence);
    this.code.movRegReg(RCX, RAX);
    this.code.movRegMem(RAX, frame(held.offset));
    this.code.lea(RAX, indexed(RCX, RAX, scale));
  }

  /**
   * An array the program wrote out, allocated and filled where it was.
   *
   * The address of the array is held in the scratch register across the
   * elements, and each element's offset is the displacement of its own store,
   * so an element costs one instruction rather than three. An element that is
   * a call takes the register away, because a call is written with the very
   * argument registers the scratch is one of; that element pays a reload
   * instead, which is two instructions and still fewer than the three it
   * replaced.
   */
  private buffer(value: SemanticValue & { k: "buffer" }): void {
    this.code.movRegImm(RDI, BigInt(value.length));
    this.code.movRegImm(RSI, BigInt(widthOf(value.element)));
    this.runtime("_array_new");
    const array = this.hold(POINTER, "blaze_array");
    this.store(array);
    this.code.movRegMem(RCX, frame(array.offset));
    value.values.forEach((element, at) => {
      this.at(element, value.element);
      // The address is the value the accumulator held before the element was
      // read, so it is rebuilt where the element took it from.
      if (hasCall(element)) this.code.movRegMem(RCX, frame(array.offset));
      this.storeInto(value.element, RCX, at * widthOf(value.element));
    });
    this.code.movRegReg(RAX, RCX);
  }

  private layout(name: string): ObjectLayout {
    const layout = this.layouts[name];
    if (layout === undefined) throw machineError(`${this.fn.symbol} uses the layout ${name}, which the program does not lay out`);
    return layout;
  }

  private field(layoutName: string, name: string): { name: string; type: string; offset: number } {
    const found = this.layout(layoutName).fields.find((entry) => entry.name === name);
    if (found === undefined) throw machineError(`${this.fn.symbol} uses ${layoutName}.${name}, which the layout does not have`);
    return found;
  }

  /** An object, allocated and filled as one value, on the terms `buffer` above. */
  private object(value: SemanticValue & { k: "newObject" }): void {
    const layout = this.layout(value.layout);
    this.code.movRegImm(RDI, BigInt(layout.size));
    this.code.movRegImm(RSI, BigInt(layout.align));
    this.runtime("_object_new");
    const object = this.hold(POINTER, "blaze_object");
    this.store(object);
    this.code.movRegMem(RCX, frame(object.offset));
    for (const written of value.fields) {
      const field = this.field(value.layout, written.name);
      const type = parseType(field.type);
      this.at(written.value, type);
      if (hasCall(written.value)) this.code.movRegMem(RCX, frame(object.offset));
      this.storeInto(type, RCX, field.offset);
    }
    this.code.movRegReg(RAX, RCX);
  }

  /* ---------------------------------------------------------------------- */
  /* Calls                                                                  */
  /* -------------------------------------------------------------------------- */

  private callValue(call: SemanticCall, wanted: SemanticType | null): void {
    if (call.builtin) {
      this.builtin(call);
      if (wanted !== null && wanted.kind !== "void") this.convert(call.returns, wanted);
      return;
    }
    const args = call.args.map((argument, at) => {
      const type = call.argTypes[at] ?? argument.type;
      // An argument that is a name read at the type the parameter takes is the
      // slot itself: the register the call takes it in is filled from there
      // anyway, and the general form copies it into a slot of its own first.
      // Anything else is evaluated into one, because evaluating an argument
      // writes the accumulator and a later argument would take it away again.
      if (argument.k === "local") {
        const held = this.slot(argument.name);
        if (typeEquals(held.type, type)) return held;
      }
      this.at(argument, type);
      const held = this.hold(type, "blaze_argument");
      this.store(held);
      return held;
    });
    this.callSymbol(call.signature.symbol, args, call.returns);
    if (wanted !== null && wanted.kind !== "void") this.convert(call.returns, wanted);
  }

  /**
   * A call the compiler itself provides. Each is what the C library has by the
   * same name, and `Math.round` is the one written out, because the library
   * rounds halves away from zero and the language rounds them up.
   */
  private builtin(call: SemanticCall): void {
    const argument = call.args[0];
    if (call.callee === ARGV_LENGTH) {
      this.runtime("_argv_count");
      return;
    }
    if (call.callee === "argv") {
      this.at(argument, USIZE);
      this.code.movRegReg(RDI, RAX);
      this.runtime("_argv");
      return;
    }
    if (call.callee === "Math.round") {
      this.at(argument, NUMBER);
      const operand = this.hold(NUMBER, "blaze_rounded");
      this.store(operand);
      this.floatConstant(0.5, NUMBER, XMM1);
      this.code.sse("add", XMM0, XMM1, false);
      this.library("floor");
      // The answer is kept beside the value it was made of: a value that rounds
      // to zero from below keeps its sign, which is what the language does and
      // what a round of the C library rounds away, and every other answer is
      // the one the library gave.
      this.code.movsMove(XMM1, XMM0, false);
      const keep = this.code.label("Lround");
      const end = this.code.label("Lend");
      this.code.xorFloat(XMM2, XMM2);
      this.code.sseCompare(XMM0, XMM2, false, true);
      this.code.jcc("p", keep);
      this.code.jcc("ne", keep);
      this.code.movsLoad(XMM0, frame(operand.offset), false);
      this.code.sseCompare(XMM0, XMM2, false, true);
      // A comparison of floats leaves the unsigned conditions: the ones that
      // say which side of the other a value is on.
      this.code.jcc("ae", keep);
      this.code.movsMove(XMM0, XMM1, false);
      this.code.movRegImm(RAX, -0x8000_0000_0000_0000n);
      this.code.movdXmm(XMM2, RAX);
      this.code.xorFloat(XMM0, XMM2);
      this.code.jmp(end);
      this.code.bind(keep);
      this.code.movsMove(XMM0, XMM1, false);
      this.code.bind(end);
      return;
    }
    const library = MATH_LIBRARY[call.callee];
    if (library === undefined || BUILTINS[call.callee] === undefined) {
      throw machineError(`${this.fn.symbol} calls ${call.callee}, which this backend does not lower`);
    }
    this.at(argument, NUMBER);
    this.library(library);
  }

  /**
   * A call, with the arguments where the convention puts them. The registers
   * are read last, because writing an argument that has no register left goes
   * through the very registers the others are read into.
   */
  private callSymbol(symbol: string, args: readonly Held[], returns: SemanticType): void {
    this.external(symbol);
    const onStack: Held[] = [];
    const registers: { register: number; held: Held }[] = [];
    let general = 0;
    let floating = 0;
    for (const argument of args) {
      // The registers are handed out in the order the arguments are written, and
      // an argument that has none left is on the stack with every argument after
      // it, whichever class those are.
      const register =
        onStack.length > 0 ? undefined : isFloat(argument.type) ? SSE_ARGUMENTS[floating] : INTEGER_ARGUMENTS[general];
      if (register === undefined) {
        onStack.push(argument);
        continue;
      }
      if (isFloat(argument.type)) floating += 1;
      else general += 1;
      registers.push({ register, held: argument });
    }
    // The stack a call pushes onto has to leave the stack sixteen byte
    // aligned, which is what every function the C library was compiled for
    // assumes of the call it is entered by.
    const slots = Math.ceil(onStack.length / 2) * 2;
    if (slots > 0) {
      this.code.aluImm("sub", RSP, slots * 8);
      onStack.forEach((argument, at) => {
        this.load(argument);
        if (isFloat(argument.type)) {
          this.code.movsStore(mem(RSP, at * 8), XMM0, widthOf(argument.type) === 4);
          return;
        }
        this.code.movMemReg(mem(RSP, at * 8), RAX);
      });
    }
    for (const { register, held } of registers) {
      // An argument that is pinned is in its register, so it is copied from
      // there rather than read out of the frame.
      if (held.register !== null) {
        this.code.movRegReg(register, held.register);
        continue;
      }
      if (isFloat(held.type)) {
        this.code.movsLoad(register, frame(held.offset), widthOf(held.type) === 4);
        continue;
      }
      this.code.movRegMemSized(register, frame(held.offset), widthOf(held.type), signedOf(held.type));
    }
    this.code.call(symbol);
    if (slots > 0) this.code.aluImm("add", RSP, slots * 8);
    if (returns.kind !== "void" && !isFloat(returns)) this.normalize(returns);
  }

  /** A call the body makes for what it does, with nothing of its own to pass. */
  private runtime(entry: string): void {
    this.library(`${RUNTIME_NAME}${entry}`);
  }

  private library(symbol: string): void {
    this.external(symbol);
    this.code.call(symbol);
  }

  private external(symbol: string): void {
    if (this.externals.includes(symbol)) return;
    this.externals.push(symbol);
  }

  /* ---------------------------------------------------------------------- */
  /* Conversions                                                            */
  /* -------------------------------------------------------------------------- */

  /**
   * A value in the accumulator read as another type. A use converts inside a
   * kind: a whole number written where a double is read, a number narrowed to
   * the width it is stored at. A reference is a pointer whatever it points at
   * and text is a pointer whatever it says, so neither is converted at all.
   */
  private convert(from: SemanticType, to: SemanticType): void {
    if (to.kind === "void") return;
    if (isTextType(from) || isTextType(to) || isReference(from) || isReference(to)) return;
    if (!isNumber(from) || !isNumber(to)) return;
    if (isFloat(from) && isFloat(to)) {
      if (widthOf(from) !== widthOf(to)) this.code.cvtFloatPrecision(XMM0, XMM0, widthOf(to) === 4);
      return;
    }
    if (isFloat(from)) {
      this.code.cvtFloatToInt(RAX, XMM0, widthOf(from) === 4, widthOf(to) === 8);
      this.normalizeArithmetic(to);
      return;
    }
    if (isFloat(to)) {
      this.wholeAsDouble(from, to);
      return;
    }
    if (widthOf(to) < widthOf(from)) this.code.narrow(RAX, RAX, widthOf(to), signedOf(to));
  }

  /**
   * A whole number read as a float. The accumulator holds the value widened to
   * its own width, and a conversion is signed at that width — except for a
   * whole number of a full word, which has to be read as itself or every value
   * above the middle of the range would come back negative.
   */
  private wholeAsDouble(from: SemanticType, to: SemanticType): void {
    const single = widthOf(to) === 4;
    if (widthOf(from) === 8 && isUnsigned(from)) {
      const halved = this.code.label("Lhalf");
      const done = this.code.label("Ldone");
      // A signed conversion reads the sign bit as a sign, so a value from the
      // middle of the range upwards would come back negative. Those are halved
      // instead — rounding up, since the bit shifted out is the low one — and
      // the answer is doubled afterwards.
      this.code.test(RAX);
      this.code.jcc("s", halved);
      this.code.cvtIntToFloat(XMM0, RAX, single);
      this.code.jmp(done);
      this.code.bind(halved);
      this.code.movRegReg(RCX, RAX);
      this.code.shiftImm("shr", RCX, 1);
      this.code.aluImm("and", RAX, 1);
      this.code.alu("or", RAX, RCX);
      this.code.cvtIntToFloat(XMM0, RAX, single);
      this.code.sse("add", XMM0, XMM0, single);
      this.code.bind(done);
      return;
    }
    this.code.cvtIntToFloat(XMM0, RAX, single);
  }
}

/* -------------------------------------------------------------------------- */
/* Numbers as they are written                                                  */
/* -------------------------------------------------------------------------- */

/** The value a whole number literal is. */
function integerText(text: string): bigint {
  if (/^[+-]?0[xX]/.test(text)) {
    const negative = text.startsWith("-");
    return (negative ? -1n : 1n) * BigInt(negative ? text.slice(1) : text);
  }
  if (/^[+-]?[0-9]+$/.test(text)) return BigInt(text);
  return BigInt(Math.trunc(Number(text)));
}

/** The value a number literal is, written as a decimal whatever it was. */
function decimalText(text: string): string {
  if (!/^[+-]?0[xX]/.test(text)) return text;
  const negative = text.startsWith("-");
  return `${negative ? "-" : ""}${BigInt(negative ? text.slice(1) : text).toString()}`;
}

/** The bits a number is, which is what a float is written into a register as. */
function floatBits(value: number, single: boolean): bigint {
  if (single) {
    const bits = new DataView(new ArrayBuffer(4));
    bits.setFloat32(0, value, true);
    return BigInt(bits.getUint32(0, true));
  }
  const bits = new DataView(new ArrayBuffer(8));
  bits.setFloat64(0, value, true);
  return BigInt.asIntN(64, bits.getBigUint64(0, true));
}

/* -------------------------------------------------------------------------- */
/* Reading a lowered object back                                                */
/* -------------------------------------------------------------------------- */

/**
 * What a review of the target code is shown. Machine code is not text, so a
 * review of it reads the listing the disassembler in the toolchain prints; where
 * there is no disassembler, what the object says of itself is given instead.
 */
export function describeMachineObject(objectPath: string, bytes: Uint8Array): { text: string; note: string | null } {
  const listing = run("objdump", ["-d", "-r", "--no-show-raw-insn", objectPath], { timeoutMs: 30_000 });
  if (listing.code === 0 && listing.stdout.trim() !== "") {
    return {
      text: listing.stdout,
      note: "This is the machine code itself, as the disassembler reads it. The IR it was built from is the artifact the rules are applied to, and the object is regenerated from it.",
    };
  }
  return {
    text: describeObject(bytes),
    note: "No disassembler was available, so this is what the object says of itself. The IR it was built from is the artifact the rules are applied to, and the object is regenerated from it.",
  };
}

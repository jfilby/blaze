function fieldOf(value: unknown, key: string): any {
  return (value as Record<string, unknown>)[key];
}

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

import { readFileSync, stat, writeFile } from "../core/platform.ts";
import { CompilerError, toCompilerError } from "../core/errors.ts";
import { run } from "../core/process.ts";
import { DEFAULT_ALIGNMENT, RUNTIME_NAME } from "../runtime/abi.ts";
import { isRuntimeSymbol } from "../runtime/symbols.ts";
import { integerLiteral } from "./c-names.ts";
import { ARGV_LENGTH, SHARED, builtinFor } from "../semantics/builtins.ts";
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
  isWide,
  isWideType,
  limbsOf as limbsOfName,
  isInteger,
  isSequence,
  statementBlocksOf,
  statementValues,
  WIDE_LIMBS,
  LIMB_BYTES,
  isUnsigned,
  slotType,
  typeEquals,
  typeText,
  valueKind,
  type CompareOp,
  type SemanticAssignOp,
  type SemanticBlock,
  type SemanticCall,
  type SemanticFunction,
  type SemanticLoop,
  type SemanticSlot,
  type SemanticStatement,
  type SemanticTerminator,
  type SemanticType,
  type SemanticValue,
} from "../core/semantic-ir.ts";
import type { FunctionContract, ObjectLayout, TargetSpec, TypeExpr } from "../core/types.ts";
import { nameLiveness, overlaps } from "../semantics/liveness.ts";
import { isSafeToCompute, substituteLocals, valueKey } from "../semantics/repair.ts";
import { turnIsTooCheap } from "../semantics/parallel.ts";
import { describeObject, objectSymbols, writeObject, type DataLabel } from "./elf64.ts";
import { NameScope } from "./names.ts";
import {
  Encoder,
  INTEGER_ARGUMENTS,
  R8,
  R9,
  R10,
  R11,
  RAX,
  RCX,
  RDI,
  RDX,
  RBP,
  RSI,
  RSP,
  SSE_ARGUMENTS,
  type Memory,
  type VectorSave,
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

function isDynamicType(type: SemanticType | null): boolean {
  return type !== null && type.kind === "ref" && type.of === null && type.name === undefined;
}

function isFloatType(type: SemanticType | null): boolean {
  if (type === null) return false;
  // A reference is a pointer whatever it points at, even an unshaped one:
  // `ref<any>` is still an address, not a floating point number. Treating
  // it as a float made field access read through a register the pointer never
  // reached and crashed programs that use unshaped references (binarytrees).
  if (type.kind === "ref") return false;
  if (isDynamicType(type)) return true;
  return isFloat(type);
}

const NUMBER: SemanticType = { kind: "primitive", name: "f64" };
const USIZE: SemanticType = { kind: "primitive", name: "usize" };
const I64: SemanticType = { kind: "primitive", name: "i64" };
const U64: SemanticType = { kind: "primitive", name: "u64" };
const TEXT = { kind: "text" } as const;
const POINTER: SemanticType = { kind: "primitive", name: "usize" };
const VOID_TYPE: SemanticType = { kind: "void" };
/** The truth a condition and a comparison are written as. */
const TRUTH: SemanticType = { kind: "primitive", name: "bool" };
/**
 * The largest sum a fast weight is triangular over. The weight the shift
 * computes is exact while the product `s * (s + 1)` fits the unsigned number
 * the shift reads it as: `>>>` answers `s * (s + 1)` read as a u32, and the
 * last sum whose product is one less than a full 232 sequence is 65534, whose
 * product is 4294901760. One further, and the product wraps and the weight the
 * fast arm answers is whatever wrapped into it.
 */
const TRIANGULAR_REACH = 65_534;
/** A reference the source left unshaped: a pointer to whatever it points at. */
const ANY_TYPE: SemanticType = { kind: "ref", of: null };

/** What a dictionary service answers, as the kind of value this backend holds. */
type DictionaryAnswer = "number" | "text" | "pointer" | "dynamic";

/**
 * The dictionary services a module function may call: a map and a set are one
 * handle on the runtime's dictionary, and the entries a loop walks are that
 * dictionary's own. `dynamic` is an answer the runtime hands back as the double
 * a handle is, which this backend holds as the bits of that double.
 */
const DICTIONARY_SERVICES: ReadonlyMap<string, DictionaryAnswer> = new Map<string, DictionaryAnswer>([
  ["blaze_rt_dict_new", "number"],
  ["blaze_rt_dict_get", "number"],
  ["blaze_rt_dict_set", "number"],
  ["blaze_rt_dict_get_ref", "dynamic"],
  ["blaze_rt_dict_set_ref", "number"],
  ["blaze_rt_dict_get_text", "text"],
  ["blaze_rt_dict_set_text", "number"],
  ["blaze_rt_dict_has", "number"],
  ["blaze_rt_own_key", "number"],
  ["blaze_rt_dict_len", "number"],
  ["blaze_rt_dict_delete", "number"],
  ["blaze_rt_dict_set_seq", "number"],
  ["blaze_rt_dict_get_seq", "pointer"],
  ["blaze_rt_dict_set_seq_numkey", "number"],
  ["blaze_rt_dict_get_seq_numkey", "pointer"],
  ["blaze_rt_dict_key_at", "text"],
  ["blaze_rt_dict_value_at", "number"],
  ["blaze_rt_dict_value_at_ref", "dynamic"],
  ["blaze_rt_dict_value_at_text", "text"],
  ["blaze_rt_dict_set_refkey", "number"],
  ["blaze_rt_dict_get_refkey", "number"],
  ["blaze_rt_dict_get_refkey_text", "text"],
  ["blaze_rt_dict_get_refkey_ref", "dynamic"],
  ["blaze_rt_dict_set_refkey_text", "number"],
  ["blaze_rt_dict_set_refkey_ref", "number"],
  ["blaze_rt_dict_has_refkey", "number"],
  ["blaze_rt_dict_delete_refkey", "number"],
  ["blaze_rt_dict_key_ref_at", "dynamic"],
  ["blaze_rt_dict_set_numkey", "number"],
  ["blaze_rt_dict_get_numkey", "number"],
  ["blaze_rt_dict_get_numkey_text", "text"],
  ["blaze_rt_dict_get_numkey_ref", "dynamic"],
  ["blaze_rt_dict_set_numkey_text", "number"],
  ["blaze_rt_dict_set_numkey_ref", "number"],
  ["blaze_rt_dict_has_numkey", "number"],
  ["blaze_rt_dict_delete_numkey", "number"],
  ["blaze_rt_dict_key_num_at", "number"],
  ["blaze_rt_dict_values", "pointer"],
  ["map.values", "pointer"],
  ["blaze_rt_json_field_key", "text"],
  ["blaze_rt_json_field_value", "dynamic"],
  ["array.copy", "pointer"],
  ["array.join", "pointer"],
]);

/**
 * The host services a module function may call: the builtin the source names,
 * the runtime entry it lowers to, the kinds of the arguments it takes and what
 * it answers.
 *
 * A file service answers a number — 1 or 0 for a question, the size or the kind
 * for a question that names one — or a text where a name is the answer. The
 * read of a file answers the value the runtime holds, which a text use unboxes,
 * exactly as the dictionary services answer a value of another kind.
 */
type HostService = { symbol: string; args: readonly ("text" | "number")[]; extra?: readonly number[]; returns: "number" | "text" | "dynamic" | "void" };

const HOST_SERVICES: ReadonlyMap<string, HostService> = new Map<string, HostService>([
  ["fs.readFileSync", { symbol: "blaze_rt_file_read", args: ["text", "text"], returns: "dynamic" }],
  ["fs.writeFileSync", { symbol: "blaze_rt_file_write", args: ["text", "text"], extra: [0], returns: "number" }],
  ["fs.appendFileSync", { symbol: "blaze_rt_file_write", args: ["text", "text"], extra: [1], returns: "number" }],
  ["fs.existsSync", { symbol: "blaze_rt_file_exists", args: ["text"], returns: "number" }],
  ["fs.fileSizeSync", { symbol: "blaze_rt_file_size", args: ["text"], returns: "number" }],
  ["fs.fileKindSync", { symbol: "blaze_rt_file_kind", args: ["text"], returns: "number" }],
  ["fs.mkdirSync", { symbol: "blaze_rt_dir_make", args: ["text", "number"], returns: "number" }],
  ["fs.rmSync", { symbol: "blaze_rt_file_remove", args: ["text", "number"], returns: "number" }],
  ["fs.renameSync", { symbol: "blaze_rt_file_rename", args: ["text", "text"], returns: "number" }],
  ["fs.copyFileSync", { symbol: "blaze_rt_file_copy", args: ["text", "text"], returns: "number" }],
  ["fs.dirCountSync", { symbol: "blaze_rt_dir_count", args: ["text"], returns: "number" }],
  ["fs.dirNameSync", { symbol: "blaze_rt_dir_name", args: ["text", "number"], returns: "text" }],
  ["fs.dirIsDirSync", { symbol: "blaze_rt_dir_is_dir", args: ["text", "number"], returns: "number" }],
  ["process.cwd", { symbol: "blaze_rt_current_dir", args: [], returns: "text" }],
  ["process.pid", { symbol: "blaze_rt_process_id", args: [], returns: "number" }],
  ["os.tmpdir", { symbol: "blaze_rt_temp_dir", args: [], returns: "text" }],
  ["os.platform", { symbol: "blaze_rt_host_platform", args: [], returns: "text" }],
  ["os.arch", { symbol: "blaze_rt_host_arch", args: [], returns: "text" }],
  ["crypto.randomUUID", { symbol: "blaze_rt_random_uuid", args: [], returns: "text" }],
  ["fs.fsyncPath", { symbol: "blaze_rt_file_sync", args: ["text"], returns: "number" }],
  ["timers.sleepMs", { symbol: "blaze_rt_sleep_ms", args: ["number"], returns: "number" }],
  ["exec.new", { symbol: "blaze_rt_command_new", args: [], returns: "number" }],
  ["exec.arg", { symbol: "blaze_rt_command_arg", args: ["number", "text"], returns: "number" }],
  ["exec.cwd", { symbol: "blaze_rt_command_cwd", args: ["number", "text"], returns: "number" }],
  ["exec.env", { symbol: "blaze_rt_command_env", args: ["number", "text", "text"], returns: "number" }],
  ["exec.input", { symbol: "blaze_rt_command_input", args: ["number", "text"], returns: "number" }],
  ["exec.run", { symbol: "blaze_rt_command_run", args: ["number", "number"], returns: "number" }],
  ["exec.signal", { symbol: "blaze_rt_command_signal", args: ["number"], returns: "number" }],
  ["exec.errno", { symbol: "blaze_rt_command_errno", args: ["number"], returns: "number" }],
  ["exec.timedOut", { symbol: "blaze_rt_command_timed_out", args: ["number"], returns: "number" }],
  ["exec.stdout", { symbol: "blaze_rt_command_stdout", args: ["number"], returns: "text" }],
  ["exec.stderr", { symbol: "blaze_rt_command_stderr", args: ["number"], returns: "text" }],
  ["exec.free", { symbol: "blaze_rt_command_free", args: ["number"], returns: "void" }],
  ["env.count", { symbol: "blaze_rt_env_count", args: [], returns: "number" }],
  ["env.at", { symbol: "blaze_rt_env_at", args: ["number"], returns: "text" }],
  ["os.cpuCount", { symbol: "blaze_rt_cpu_count", args: [], returns: "number" }],
]);

/**
 * The type a walk's index is held at. The IR does not name one: counting over
 * an array is a whole number whatever the elements are, and what the pinning
 * pass weighs here is the type of the register the counter is given, which is
 * this whenever the loop states no type of its own.
 */
const INDEX: SemanticType = { kind: "primitive", name: "u64" };

/** The C library a lowered function calls, which the linker resolves. */
function isLibrarySymbol(symbol: string): boolean {
  switch (symbol) {
    case "strlen":
    case "memcpy":
    case "strcmp":
    case "pow":
    case "fabs":
    case "floor":
    case "trunc":
    case "sqrt":
      return true;
    default:
      return false;
  }
}

const LIBRARY: Record<string, true> = {
  strlen: true,
  memcpy: true,
  strcmp: true,
  pow: true,
  fabs: true,
  floor: true,
  trunc: true,
  // `MATH_LIBRARY` writes `Math.sqrt` as a call to the C library's `sqrt`, so a
  // program that takes a square root names an external this table has to allow.
  // Without it the name was refused at the end of the build as one that is
  // "neither the runtime, the C library, nor a function of this program" —
  // the linker resolves every other name `MATH_LIBRARY` produces.
  sqrt: true,
};

/** The operator each compound assignment is, by the name the IR gives it. */
const COMPOUND: Record<string, "add" | "sub" | "mul" | "div" | "mod" | "and" | "or" | "xor" | "shl" | "shr" | "ushr"> = {
  "+": "add",
  "-": "sub",
  "*": "mul",
  "/": "div",
  "%": "mod",
  "&": "and",
  "|": "or",
  "^": "xor",
  "<<": "shl",
  ">>": "shr",
  ">>>": "ushr",
};

/**
 * The condition that fires when the one it names does not. A branch on a
 * comparison is written as the negation of the condition the comparison
 * holds under, because the flags a comparison leaves say what the
 * comparison *is*, and a branch is reached by the arm that is not the one the
 * comparison chose.
 */
type MachineCondition = "e" | "ne" | "l" | "le" | "g" | "ge" | "b" | "be" | "a" | "ae";

function negatedCondition(condition: MachineCondition): MachineCondition {
  switch (condition) {
    case "e": return "ne";
    case "ne": return "e";
    case "l": return "ge";
    case "le": return "g";
    case "g": return "le";
    case "ge": return "l";
    case "b": return "ae";
    case "be": return "a";
    case "a": return "be";
    default: return "b";
  }
}

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
 * The comparison that answers the opposite of another, which is what a `!` over
 * a comparison is branched on rather than a number the comparison is first
 * written down as. Over floats the two answer the same values: a pair that is
 * not numbers is in no ordered relation, every ordered comparison of one is
 * false, and the opposite is true of the unordered case too.
 */
/** The machine condition a comparison of a given sense branches on. */
function comparisonCode(sense: string, signed: boolean): "e" | "ne" | "l" | "le" | "g" | "ge" | "b" | "be" | "a" | "ae" {
  switch (sense) {
    case "eq": return "e";
    case "ne": return "ne";
    case "lt": return signed ? "l" : "b";
    case "le": return signed ? "le" : "be";
    case "gt": return signed ? "g" : "a";
    default: return signed ? "ge" : "ae";
  }
}

function oppositeOf(op: CompareOp): CompareOp {
  switch (op) {
    case "eq": return "ne";
    case "ne": return "eq";
    case "lt": return "ge";
    case "le": return "gt";
    case "gt": return "le";
    default: return "lt";
  }
}

/** A comparison the machine answers from the flags, which is one over anything but text. */
function flagComparison(value: SemanticValue): (SemanticValue & { k: "compare" }) | null {
  return value.k === "compare" && !isTextType(fieldOf(value, "operand") as SemanticType) ? value : null;
}

/**
 * The operations the machine writes with the number in the instruction rather
 * than in a register. A division and a remainder are the two it does not: the
 * machine divides a register by a register, and a literal is not one.
 */
function immediateOperation(op: string): boolean {
  switch (op) {
    case "add":
    case "sub":
    case "mul":
    case "shl":
    case "shr":
    case "ushr":
    case "sar":
    case "and":
    case "or":
    case "xor":
      return true;
    default:
      return false;
  }
}

function floatOperation(op: string): boolean {
  switch (op) {
    case "add":
    case "sub":
    case "mul":
    case "div":
      return true;
    default:
      return false;
  }
}

/**
 * The whole-number registers a callee leaves as it found them, which are the
 * ones a value that never changes can be kept in across a call. Four is what
 * this backend uses of the five the convention has: rbx, r12, r13 and r14.
 *
 * The fifth, r15, is the register an object being filled lives in for the
 * duration of the statement that fills it. It is not taken from the list of
 * values a function can pin because it is already spoken for, and it is the
 * right register for the job: it survives the calls a field value makes, which
 * is the whole reason the object pointer cannot live in the scratch register
 * every other part of the lowering uses.
 */

/**
 * The register an object allocated and filled as one value is held in across
 * the field stores, which is what stops it being written to the frame and read
 * back for every field that is a call.
 *
 * A call takes the scratch register — it is the fourth argument register — so
 * an object pointer kept there has to be written down before a field that calls
 * and read back after it, which is a store and a load per call-valued field. A
 * register the convention says a callee leaves as it found them needs neither.
 */
const OBJECT_POINTER = 15;

/**
 * The four general registers a wide number is carried in, least significant
 * limb first.
 *
 * They are four of the six the convention does not ask a callee to preserve, so
 * a value in them is gone after a call — which is why a wide number whose life
 * reaches past one lives in the frame and is read into these when it is used.
 * They start at `r8` because `rdi` and `rsi` are argument registers: a value
 * sitting in one of those when a call is made has it written over.
 *
 * The accumulator is not among them and could not be. `rax` is where every other
 * value the body computes is passed, and a limb written there would be
 * indistinguishable from a scalar the body had just produced.
 */

/**
 * The wide type a whole number is widened into when it is written in base
 * sixteen: the runtime's formatter takes four limbs, and a machine word is the
 * low one of them with three of nothing above it.
 */
const WIDE_UNSIGNED: SemanticType = { kind: "primitive", name: "u256" };

/**
 * How a comparison of two whole numbers is spelled as a condition the machine
 * reads flags with.
 *
 * The unsigned forms are the ones a whole number needs: every whole number the
 * language has is read as unsigned here unless its own type is signed, and a
 * limb of a wide number is an unsigned sixty-four bit value whatever the wide
 * type is called.
 */


/**
 * The vector registers a callee leaves as it found them, which are the ones a
 * float that never changes can be kept in across a call.
 *
 * Ten is what the convention has: xmm6 to xmm15. They are a register file of
 * their own, so a float pinned here costs nothing a whole number pinned in
 * `[3, 12, 13, 14]` would: the two lists are filled independently and neither
 * takes a register the other wanted. A float left in the frame instead costs a
 * load on every read and a store on every write, and a loop whose bound and
 * step are floats reads both on every turn.
 *
 * The first two of them are also argument registers. A callee that is handed
 * seven or eight floats has to save them before it writes to them and restore
 * them before it returns, so a value kept in one here survives the call the
 * same way a value kept in rbx does.
 */

/**
 * The whole-number registers the convention does not ask a callee to preserve,
 * which are the ones a value that no call reaches can be kept in for nothing.
 *
 * A callee-saved register costs the function a push and a pop and sixteen bytes
 * of stack, and buys the same thing a caller-saved one buys for free over the
 * stretch of the body where nothing calls: the value is in a register rather
 * than in the frame. A name that has to survive a call cannot be kept in one
 * of these — the call writes its arguments into them — so the two lists answer
 * different questions and a name is given the one its live range fits.
 *
 * `rax` is the accumulator and `rcx` the scratch, which every value the body
 * computes passes through, and `rdx` is what a division and a one-byte write
 * go through, so none of the three is a place a name can be kept.
 */

/**
 * The vector registers the convention does not ask a callee to preserve, which
 * answer the same question as `[7, 6, 8, 9, 10, 11]` does for a whole number.
 *
 * `xmm0` is the accumulator and `xmm1` the scratch, and `xmm2` is the scratch of
 * the two sequences written out in place of a call the library would make: the
 * truth of a double (`UCOMISD` against a zero it has to have somewhere) and
 * `Math.round`'s sign repair. A name kept in it is gone the moment either runs,
 * and neither is a call the liveness pass models, so `xmm2` is not a place a
 * name is kept: `kept(3)` answered `14.75` twice because the value the round
 * wrote over it was a different name's. The three left are the ones a name can
 * be kept in, which are also the fourth to seventh of the argument registers.
 */

/**
 * How many registers the values of one expression may be held in at once.
 *
 * They come out of `[6, 7, 8, 9, 10, 11, 12, 13, 14, 15]`: a value held in a register the
 * convention does not preserve is gone the moment the expression calls
 * anything, and an expression holds one side of an arithmetic while the other
 * side — which is often the call — is written. A callee-saved register costs
 * the prologue a store and the epilogue a load, which is worth paying once for
 * a loop that turns thousands of times and is not worth paying for a function
 * that computes nothing in floats, which is given none.
 */
const TEMPORARY_VECTORS = 3;

/** How many counters of one function may be held as whole numbers at once. */
const INDEX_REGISTERS = 2;

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
 * What a read is worth by the number of loops it is nested in: the first entry
 * is a read on a path nothing repeats, the second one inside a loop, the third
 * inside a loop inside a loop, and the last for anything deeper.
 *
 * It is a doubling rather than the turn count of the loop, which is not known
 * here and is not the point: what says a read is hot is that the block holding
 * it is carried out again, and how much again grows with how many loops are
 * around it. The list stops at eight because the difference between a hundred
 * turns of a loop and a thousand changes which name is pinned first not at all,
 * and a name pinned on a turn count it cannot be held to is a name pinned for
 * the wrong reason.
 */
const READ_WEIGHT: readonly number[] = [1, 2, 4, 8];

/**
 * The operations the machine carries out with a literal reached in the
 * instruction rather than a register beside it. A minimum, a maximum, a power
 * and a remainder are not among them: each has its own form, and each of those
 * forms reads two registers.
 */
/** The maths builtin each source name is one call of, by the name C gives it. */
const MATH_LIBRARY: Record<string, string> = {
  "Math.abs": "fabs",
  "Math.sqrt": "sqrt",
  "Math.trunc": "trunc",
};

/**
 * The smallest float that is a whole number whatever it is multiplied by, and
 * so the bound above which there is no fraction left to drop.
 *
 * Every double at or above two to the fifty-second carries no bits below one,
 * so rounding one down is the number itself, and a conversion of one to a
 * sixty-four bit whole number is the overflow the instruction answers with the
 * smallest number there is. The bound is therefore what a value that may be one
 * of those is tested against rather than converted.
 */
const WHOLE_FLOATS = 2 ** 52;

/**
 * The builtins this backend writes as instructions rather than as a call, by
 * the name the IR gives them.
 *
 * A rounding is the only one so far, and it is here twice over: the code it is
 * written as is arithmetic on the accumulator and the scratch beside it, and
 * the register allocator is told so that a name live across a rounding is not
 * held in a register the convention asks a callee to preserve. A body whose
 * only call is a rounding is a body that calls nothing, and every name it
 * reaches for may sit in a register that costs the function no prologue at all
 * — which on a loop that rounds once per element is the difference between an
 * array read costing a move out of the frame and costing an address.
 */
function isInlineBuiltin(name: string): boolean {
  return name === "Math.floor" || name === "Math.round";
}


/** How wide a value of this type is, which is the width a slot holds it at. */
/**
 * How wide a value of this type is, in the one register a scalar is carried in.
 *
 * A wide number has no answer here, and this function says so rather than
 * measuring one. `Width` is 1, 2, 4 or 8 — the width of one register — and every
 * scalar read, write and sign-extension in this backend is derived from it. A
 * `u256` is four limbs, so there is no width at which one register carries it:
 * answering 8 would not be a narrow answer, it would be a claim that one limb is
 * the value, and a read or a write built on it would move a quarter of the
 * number and leave the rest of the register holding whatever was there.
 *
 * `frameBytes` is what reserves room for a value, and it answers thirty two for
 * a wide number, so a value written down has somewhere for all four limbs to go.
 */
function widthOf(type: SemanticType): Width {
  if (type.kind === "primitive" && isWide(type.name)) {
    throw machineError(
      `a ${type.name} has no single-register width`,
      "a wide number is four 64 bit limbs and this is the width one register carries a value at; a wide number is measured in frame bytes and carried in limb registers, not in the accumulator",
    );
  }
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

/**
 * How many bytes a value of this type occupies in the frame.
 *
 * This is `widthOf` for everything a register can carry and thirty two for a
 * wide number, which is four limbs of eight bytes. Every reservation of frame
 * room goes through here rather than through `widthOf`, because a slot that
 * answers eight bytes for a wide number is a quarter of the value written into
 * it: the three limbs above the first would be whatever the frame held beside
 * them, and the value read back would be a number the program never wrote.
 */
function frameBytes(type: SemanticType): number {
  if (type.kind === "primitive" && isWide(type.name)) return WIDE_LIMBS[type.name] * LIMB_BYTES;
  return widthOf(type);
}

/** Whether a whole number of this type is read as signed. */
function signedOf(type: SemanticType): boolean {
  if (type.kind !== "primitive") return true;
  return isUnsigned(type) ? false : true;
}

/**
 * Which shift a shift right is written as. `>>` keeps the sign of a signed
 * number and `>>>` never does, so a shift right is the arithmetic one over a
 * signed number and the logical one over everything else.
 */
function shiftOf(operation: "shl" | "shr" | "ushr" | "sar", type: SemanticType): "shl" | "shr" | "sar" {
  const op = String(operation);
  if (op === "ushr") return "shr";
  if (op === "shr" && signedOf(type)) return "sar";
  return op as "shl" | "shr" | "sar";
}

/**
 * The width an operation on whole numbers is carried out at. A C compiler
 * promotes anything narrower than an `int` to one and carries a shift and a
 * remainder out where it promoted it, so these are the widths an operation here
 * has to use for the same answers.
 */
function operationWidth(type: SemanticType): 4 | 8 {
  if (isWideType(type)) return 8;
  return widthOf(type) === 8 ? 8 : 4;
}

function machineError(message: string, detail?: string, functionName?: string): CompilerError {
  return new CompilerError("AssemblyError", "assemble", message, detail, functionName, "", "");
}

/* -------------------------------------------------------------------------- */
/* The build                                                                    */
/* -------------------------------------------------------------------------- */

export interface MachineRequest {
  /** The function as the IR holds it, already validated against its contract. */
  fn: SemanticFunction;
  /**
   * The contract the function is called by, when the build holds one.
   *
   * A function of a program the source declares for itself has no contract: the
   * program is the oracle it is checked against, and the lowering reads the
   * signature it is called by off the IR itself — the layouts it holds are the
   * ones the resolver laid out, and the symbol is the one the program calls.
   */
  contract?: FunctionContract;
  target: TargetSpec;
  /**
   * The symbols of the other functions of the program. An object may call one,
   * because the linker puts the objects beside each other; a symbol outside the
   * runtime, the C library and these is a reference nothing will resolve.
   */
  callable: ReadonlySet<string>;
  /**
   * The symbols something other than this backend provides, listed beside the
   * callable ones so a caller that links its own C can say so.
   *
   * A build of a program passes none: every symbol of `callable` is an object
   * this backend built. A test that links the object it is checking against its
   * own C functions names them here, and a call to one of them is a call whose
   * callee preserves no vector register.
   */
  foreign?: ReadonlySet<string>;
  /**
   * The parameter indices that hold power-of-two arrays, as `powerOfTwoParams`
   * computed over the whole program. Division by one of their elements is
   * division by a power of two and can be strength-reduced to a shift.
   */
  powerOfTwoParams?: ReadonlySet<number>;
  /** Where the object is written. */
  objectPath: string;
  candidate?: string;
}

export interface MachineResult {
  objectPath: string;
  objectSizeBytes: number;
  /** The bytes of code, which is what a size objective weighs. */
  textSizeBytes: number;
  /**
   * Whether the object runs any loop's turns on a team of threads, which is a
   * fact about the lowering rather than about the IR: a loop the rule marked
   * may still be written in order here, and one written in order needs no
   * threading runtime at the link.
   */
  threads: boolean;
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
  throw new CompilerError("TargetError", "assemble", `the machine backend cannot build for ${target.arch}-${target.os}-${target.abi}`, "it writes x86-64 System V code itself; build with --backend c for another target", "", "", "");
}

/**
 * What the machine backend said when it refused to lower a function.
 */
export class MachineRefusal {
  /** What it said. */
  readonly reason: string;
  /** What it said about it, when it said more. */
  readonly detail: string | undefined;

  constructor(reason: string, detail: string | undefined) {
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * Whether the machine backend can lower a function, and what it said when it
 * could not.
 *
 * A build asks this before it generates anything. The lowering of a program is
 * one thing: the objects of its functions are linked into one binary and the
 * driver that calls them is written in C, so a program with a machine object
 * beside a C one is a program with two conventions in it — a reference is an
 * address in one and a number in the other. A function the machine backend
 * refuses is therefore a reason for the whole program to be lowered by the C
 * backend, and the build says so when it does.
 *
 * The object is not written: what a lowering refuses is the same whether it
 * was written out or not, and a build that asks this question has not decided
 * to build anything yet.
 */
export function machineRefusal(
  request: Omit<MachineRequest, "objectPath" | "candidate">,
): MachineRefusal | null {
  try {
    const contract = fieldOf(request, "contract") as FunctionContract | undefined;
    const fn = fieldOf(request, "fn") as SemanticFunction;
    const target = fieldOf(request, "target") as TargetSpec;
    assertMachineTarget(target);
    const functionName = symbolOf(contract ?? ({
      function: {
        name: String(fieldOf(fn, "name")),
        symbol: String(fieldOf(fn, "symbol")),
      },
    } as FunctionContract));
    lowerFunction(
      fn,
      contract,
      functionName,
      fieldOf(request, "callable") as ReadonlySet<string>,
      target,
      fieldOf(request, "powerOfTwoParams") as ReadonlySet<number>,
      fieldOf(request, "foreign") as ReadonlySet<string>,
    );
    return null;
  } catch (cause) {
    const error = toCompilerError(cause, "AssemblyError", "assemble", "", "", "", "", "");
    return new MachineRefusal(error.message, error.detail);
  }
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
  const contract = fieldOf(request, "contract") as FunctionContract | undefined;
  const fn = fieldOf(request, "fn") as SemanticFunction;
  const target = fieldOf(request, "target") as TargetSpec;
  const callable = fieldOf(request, "callable") as ReadonlySet<string>;
  const foreign = fieldOf(request, "foreign") as ReadonlySet<string> | undefined;
  const objectPath = String(fieldOf(request, "objectPath"));
  assertMachineTarget(target);
  const functionName = symbolOf(contract ?? ({
    function: {
      name: String(fieldOf(fn, "name")),
      symbol: String(fieldOf(fn, "symbol")),
    },
  } as FunctionContract));
  const object = lowerFunction(
    fn,
    contract,
    functionName,
    callable,
    target,
    fieldOf(request, "powerOfTwoParams") as ReadonlySet<number>,
    foreign,
  );
  await writeFile(objectPath, object.bytes, "utf8");
  const written = inspectWrittenObject(objectPath, functionName);
  if (written.defined.length !== 1 || written.defined[0] !== functionName) {
    throw machineError(
      `the object of ${functionName} defines [${written.defined.join(", ")}] instead of only "${functionName}"`,
      "the program links the objects beside each other and calls this one by that name",
      functionName,
    );
  }
  const outside = written.undefined.filter((symbol) => {
    if (isRuntimeSymbol(symbol)) return false;
    if (isLibrarySymbol(symbol)) return false;
    if (callable.has(symbol)) return false;
    if (foreign !== undefined && foreign.has(symbol)) return false;
    return true;
  });
  if (outside.length > 0) {
    throw machineError(
      `${functionName} refers to symbols outside the runtime ABI and the C library: ${outside.join(", ")}`,
      undefined,
      functionName,
    );
  }
  return {
    objectPath,
    objectSizeBytes: (await stat(objectPath)).size,
    textSizeBytes: object.textSizeBytes,
    threads: object.threads,
  };
}

/**
 * Every block of a body with how many loops it is nested in, itself included.
 *
 * The depth is what a census over the whole function weighs a read by: a read
 * in a block two loops deep is carried out once for every turn of both of them,
 * and a read at the top of the body is carried out once whatever the loops turn.
 * Counting them alike says a value read once per turn of a hot loop is worth
 * the same as one read once in the whole run, which is the difference between
 * the two being in a register.
 */
function everyBlockAtDepth(
  block: SemanticBlock,
  depth = 0,
  into: { block: SemanticBlock; depth: number }[] = [],
): { block: SemanticBlock; depth: number }[] {
  into.push({ block, depth });
  for (const statement of fieldOf(block, "statements") as readonly SemanticStatement[]) {
    if (statement.k === "if") {
      everyBlockAtDepth(fieldOf(statement, "then") as SemanticBlock, depth, into);
      const otherwise = fieldOf(statement, "otherwise") as SemanticBlock | null;
      if (String(otherwise) !== "null") everyBlockAtDepth(otherwise as SemanticBlock, depth, into);
    } else if (statement.k === "loop") {
      everyBlockAtDepth(fieldOf(fieldOf(statement, "loop"), "body") as SemanticBlock, depth + 1, into);
    } else if (statement.k === "block") {
      everyBlockAtDepth(fieldOf(statement, "body") as SemanticBlock, depth, into);
    }
  }
  return into;
}

/**
 * A counted loop that adds up what two arrays hold element by element, which is
 * the one loop shape this backend does with a whole vector of doubles at a time.
 *
 * `total += a[i] * b[i]` over `i` is the dot product, and it is the shape every
 * numeric kernel over a typed array is written as. It is also the one loop whose
 * arithmetic is a serial dependency: every turn adds into the value the turn
 * before it left, so the sum takes as long as the array is long however fast the
 * multiplication beside it retires. Writing the loop out into copies of its body
 * did not shorten that chain, and measured slower. A vector accumulator is a
 * different chain — one add per two elements, two lanes deep — and that is the
 * whole of what this buys.
 */
interface PackedDot {
  /** The counter the loop counts on, which is what both arrays are read at. */
  readonly counter: string;
  /** The name the products are added into, and the value the loop answers. */
  readonly accumulator: string;
  /** The name of the array read on the left of the product, and on the right. */
  readonly left: string;
  readonly right: string;
  /** The element the counter starts at, which is a whole number written out. */
  readonly from: number;
  /** The value the counter is compared against on every turn. */
  readonly bound: SemanticValue;
}

/** The whole number a `const` writes, or null where it is not one. */
function wholeConst(value: SemanticValue): number | null {
  if (value.k !== "const") return null;
  if (!/^-?[0-9]+$/.test(value.text)) return null;
  const read = Number(value.text);
  return Number.isSafeInteger(read) ? read : null;
}

/**
 * Whether a counted loop is a `PackedDot`, and which one it is.
 *
 * Every condition here is a refusal rather than a promise. The loop has to count
 * up by one from a whole number written out; its body has to be one statement
 * that adds a product of two element reads at the counter into a name, and it
 * has to hold nothing — a body that breaks out of the loop, continues it,
 * declares a name or writes the counter is one whose turns cannot be folded into
 * pairs. The product has to be a product: a loop that sums the difference of two
 * arrays, or divides them, is one the arithmetic below would compute wrongly
 * rather than slowly.
 *
 * The counter is usually a float, because the frontend gives a loop counter the
 * type of the numbers around it. That does not stop a turn being paired with the
 * next one: the pairing is decided by whole numbers of bytes, and every element
 * the counter names is one turn apart, so the same elements are read in the
 * same order as the scalar loop read them in.
 */
function packedDotOf(loop: SemanticLoop): PackedDot | null {
  if (loop.kind !== "counted") return null;
  if (String(fieldOf(loop, "inclusive")) === "true" ||
      String(fieldOf(loop, "down")) === "true" ||
      String(fieldOf(loop, "step")) !== "null") return null;
  const loopBody = fieldOf(loop, "body") as SemanticBlock;
  const statements = fieldOf(loopBody, "statements") as readonly SemanticStatement[];
  if (statements.length !== 1) return null;
  if ((fieldOf(loopBody, "releases") as readonly string[]).length > 0 ||
      String(fieldOf(fieldOf(loopBody, "terminator"), "k")) !== "next") return null;
  const statement = statements[0];
  if (statement.k !== "set" || String(fieldOf(statement, "op")) !== "+=") return null;
  const variable = String(fieldOf(loop, "variable"));
  if (String(fieldOf(statement, "name")) === variable) return null;
  const product = fieldOf(statement, "value") as SemanticValue;
  if (product.k !== "arith" || String(fieldOf(product, "op")) !== "mul") return null;
  const left = readOf(fieldOf(product, "left") as SemanticValue, variable);
  const right = readOf(fieldOf(product, "right") as SemanticValue, variable);
  if (left === null || right === null) return null;
  if (left.element !== "f64" || right.element !== "f64") return null;
  if (left.of === right.of) return null;
  const from = wholeConst(fieldOf(loop, "from") as SemanticValue);
  // A negative start makes the byte cursor a negative number of bytes, which the
  // shift that turns it back into an index would read as a very large one.
  if (from === null || from < 0) return null;
  // A bound that is the accumulator or the counter is a value the turns change,
  // and one read before the loop would be read once where the loop reads it
  // again.
  const to = fieldOf(loop, "to") as SemanticValue;
  if (namesIn(to).some((name) => name === String(fieldOf(statement, "name")) || name === variable)) return null;
  return {
    counter: variable,
    accumulator: String(fieldOf(statement, "name")),
    left: left.of,
    right: right.of,
    from,
    bound: to,
  };
}

/**
 * One side of a product that reads one element of an array of doubles at the
 * loop's own counter, or null where it is anything else.
 */
function readOf(
  value: SemanticValue,
  counter: string,
): { readonly of: string; readonly element: string } | null {
  const of = fieldOf(value, "of") as SemanticValue;
  const index = fieldOf(value, "index") as SemanticValue;
  const type = fieldOf(value, "type") as SemanticType;
  if (value.k !== "element" || of.k !== "local") return null;
  if (index.k !== "local" || String(fieldOf(index, "name")) !== counter) return null;
  if (type.kind !== "primitive") return null;
  return { of: String(fieldOf(of, "name")), element: type.name };
}

/** The names a value reads. */
function namesIn(value: SemanticValue): string[] {
  const found: string[] = [];
  walkValues(value, (one) => {
    if (one.k === "local") found.push(String(fieldOf(one, "name")));
  });
  return found;
}

/* -------------------------------------------------------------------------- */
/* Packed sum: the independent part of a loop turn, a vector at a time        */
/* -------------------------------------------------------------------------- */

/**
 * A counted loop whose one turn adds into a name a value the counter decides,
 * where that value can be computed for a pair of counters at once.
 *
 * This is `PackedDot` for the loops a dot product is not. A dot product folds
 * the whole of its turn into a vector accumulator and therefore reorders the
 * additions, which is only sound because the IR says nothing about the order
 * the sum is taken in. Here the addition stays exactly where the source wrote
 * it — one `addsd` per turn, in the order the turns came — and only the
 * arithmetic *underneath* it is done two counters at a time, because that part
 * reads nothing the addition writes.
 */
interface PackedSum {
  /** The counter the loop counts on, which the value under the addition reads. */
  readonly counter: string;
  /** The name the products are added into, and the value the loop answers. */
  readonly accumulator: string;
  /** What is added each turn: a function of the counter and of nothing written. */
  readonly added: SemanticValue;
  /** The element the counter starts at, which is a whole number written out. */
  readonly from: number;
  /** The value the counter is compared against on every turn. */
  readonly bound: SemanticValue;
  /**
   * The arrays the value reads elements of, in the order it first reads each.
   *
   * Every one of them is read at the counter, so a pair of turns reads a pair of
   * elements of each that stand beside each other — one load of sixteen bytes
   * apiece. Each is therefore given a register of its own to hold the first
   * element, since the loads are written against different bases and there is
   * no one register that addresses all of them.
   */
  readonly arrays: readonly string[];
}

/**
 * Whether a counted loop is a `PackedSum`, and which one it is.
 *
 * Every condition here is a refusal rather than a promise, and they are the
 * same ones `packedDotOf` refuses on: the loop has to count up by one from a
 * whole number written out, and its body has to be one statement that adds into
 * a name and holds nothing else. What is added must be a function of the
 * counter alone — a value that reads the name it is added into is one whose
 * lanes are not two turns of the same computation, and one that calls is one
 * this backend will not run twice to answer one turn.
 */
function packedSumOf(loop: SemanticLoop): PackedSum | null {
  if (loop.kind !== "counted") return null;
  if (String(fieldOf(loop, "inclusive")) === "true" ||
      String(fieldOf(loop, "down")) === "true" ||
      String(fieldOf(loop, "step")) !== "null") return null;
  const loopBody = fieldOf(loop, "body") as SemanticBlock;
  const statements = fieldOf(loopBody, "statements") as readonly SemanticStatement[];
  if (statements.length !== 1) return null;
  if ((fieldOf(loopBody, "releases") as readonly string[]).length > 0 ||
      String(fieldOf(fieldOf(loopBody, "terminator"), "k")) !== "next") return null;
  const statement = statements[0];
  if (statement.k !== "set" || String(fieldOf(statement, "op")) !== "+=") return null;
  const variable = String(fieldOf(loop, "variable"));
  const accumulator = String(fieldOf(statement, "name"));
  if (accumulator === variable) return null;
  const from = wholeConst(fieldOf(loop, "from") as SemanticValue);
  if (from === null || from < 0) return null;
  const to = fieldOf(loop, "to") as SemanticValue;
  if (namesIn(to).some((name) => name === accumulator || name === variable)) return null;
  const added = fieldOf(statement, "value") as SemanticValue;
  const census = new Census(added, variable, accumulator);
  if (census.hasCalls || !census.isPackable) return null;
  return {
    counter: variable,
    accumulator,
    added,
    from,
    bound: to,
    arrays: census.arrayNames,
  };
}

/* -------------------------------------------------------------------------- */
/* Packed weighted division: eight divides by a maintained weight at a time   */
/* -------------------------------------------------------------------------- */

/**
 * A counted loop whose turn adds `array[counter] / weight` into an accumulator,
 * where `weight` and `step` are maintained by the loop (`weight += step`,
 * `step += 1`). This is the shape `weighted()` leaves behind for a spectral
 * norm-style loop once the triangular divisor has been strength-reduced to a
 * counted weight.
 *
 * Divisor `k` turns into the future is `weight + k * step + k * (k - 1) / 2`,
 * so eight consecutive turns divide by eight different weights. The packed form
 * computes those eight divisors at once, divides eight elements at once with a
 * single packed division, then adds the eight quotients into the accumulator
 * in source order so the answer is bit-for-bit the scalar loop's.
 */
interface PackedWeighted {
  /** The counter the loop counts on, which the element is read at. */
  readonly counter: string;
  /** The name the quotients are added into. */
  readonly accumulator: string;
  /** The array the element is read from. */
  readonly array: string;
  /** The maintained weight the turn divides by. */
  readonly weight: string;
  /** The maintained step the weight is stepped by. */
  readonly step: string;
}

/**
 * Whether a counted loop is the packed-weightable form, and which names it uses.
 * Every condition here is a refusal: anything the shape does not guarantee is
 * left to the scalar loop.
 */
function packedWeightedOf(loop: SemanticLoop): PackedWeighted | null {
  if (loop.kind !== "counted") return null;
  const loopType = fieldOf(loop, "type") as SemanticType;
  if (loopType.kind !== "primitive" || loopType.name !== "i64") return null;
  if (String(fieldOf(loop, "down")) === "true") return null;
  const stepValue = fieldOf(loop, "step");
  if (String(stepValue) !== "null") {
    const written = wholeLiteral(stepValue as SemanticValue);
    if (written === null || written !== 1) return null;
  }
  const from = wholeLiteral(fieldOf(loop, "from") as SemanticValue);
  if (from === null || from < 0) return null;
  const loopBody = fieldOf(loop, "body") as SemanticBlock;
  if ((fieldOf(loopBody, "releases") as readonly string[]).length > 0 ||
      String(fieldOf(fieldOf(loopBody, "terminator"), "k")) !== "next") return null;
  const statements = fieldOf(loopBody, "statements") as readonly SemanticStatement[];
  // `total += array[j] / weight; weight += step; step += 1`, nothing else.
  if (statements.length !== 3) return null;
  const variable = String(fieldOf(loop, "variable"));
  const division = statements[0];
  if (division.k !== "set" || String(fieldOf(division, "op")) !== "+=" ||
      String(fieldOf(division, "name")) === variable) return null;
  const value = fieldOf(division, "value") as SemanticValue;
  if (value.k !== "arith" || String(fieldOf(value, "op")) !== "div") return null;
  const valueType = fieldOf(value, "type") as SemanticType;
  if (valueType.kind !== "primitive" || valueType.name !== "f64") return null;
  const element = fieldOf(value, "left") as SemanticValue;
  const divisor = fieldOf(value, "right") as SemanticValue;
  const elementOf = fieldOf(element, "of") as SemanticValue;
  const elementIndex = fieldOf(element, "index") as SemanticValue;
  const elementType = fieldOf(element, "type") as SemanticType;
  if (element.k !== "element" || elementOf.k !== "local") return null;
  if (elementIndex.k !== "local" || String(fieldOf(elementIndex, "name")) !== variable) return null;
  if (elementType.kind !== "primitive" || elementType.name !== "f64") return null;
  if (divisor.k !== "local") return null;
  const weight = String(fieldOf(divisor, "name"));
  const accumulator = String(fieldOf(division, "name"));
  // `weight += step`
  const stepped = statements[1];
  if (stepped.k !== "set" || String(fieldOf(stepped, "op")) !== "+=" ||
      String(fieldOf(stepped, "name")) !== weight) return null;
  const steppedValue = fieldOf(stepped, "value") as SemanticValue;
  if (steppedValue.k !== "local") return null;
  const step = String(fieldOf(steppedValue, "name"));
  // `step += 1`
  const advanced = statements[2];
  if (advanced.k !== "set" || String(fieldOf(advanced, "op")) !== "+=" ||
      String(fieldOf(advanced, "name")) !== step) return null;
  const advancedValue = fieldOf(advanced, "value") as SemanticValue;
  if (advancedValue.k !== "const") return null;
  const one = wholeLiteral(advancedValue);
  if (one === null || one !== 1) return null;
  return {
    counter: variable,
    accumulator,
    array: String(fieldOf(elementOf, "name")),
    weight,
    step,
  };
}

/**
 * The registers one turn of a packed sum is written with: where the pair of
 * counters it is for stands, how far along the arrays it reads has come, and
 * which register holds the first element of each of them.
 *
 * These are the loop's own, gathered once so that every value under the addition
 * is written against the same registers rather than each being handed its own
 * copy of them.
 */
interface PackedTurn {
  /** The register holding the pair of counters this turn is for, one in each lane. */
  readonly counter: number;
  /** The name that pair is of, which is the loop's own counter. */
  readonly counterName: string;
  /** The register holding how many bytes of the arrays the pairs have read. */
  readonly cursor: number;
  /** The arrays a turn reads, in the order the census first read each. */
  readonly arrays: readonly string[];
  /** The register holding the first element of each, in the same order. */
  readonly bases: readonly number[];
}

/**
 * How deep the right side of an operation may be built.
 *
 * Three registers carry the work, and the right side is built with the register
 * the left side is standing in as its third. Two operations deep is what that
 * affords: at the third the register the left is in is wanted by something the
 * right is still holding, and there is no fourth register to spill it to.
 */
const PACKED_RIGHT_DEPTH = 2;

/**
 * Whether a value is a tree of operations no deeper than `PACKED_RIGHT_DEPTH`,
 * which is what the register discipline in `packedValue` can build while the
 * register its neighbour is standing in is the one it borrows.
 */
function shallow(value: SemanticValue, depth = PACKED_RIGHT_DEPTH): boolean {
  if (value.k !== "arith") return true;
  if (depth === 0) return false;
  return shallow(value.left, depth - 1) && shallow(value.right, depth - 1);
}

/**
 * What a value reads that a packed turn cannot carry: whether any of it calls,
 * whether it can be computed a lane at a time, and which arrays it reads.
 *
 * The two refusals that matter are the ones that would change the number the
 * program answers rather than the speed it answers it at, and each of them is
 * stated in the place that makes it.
 */
class Census {
  /** Whether anything under the addition calls, which a lane cannot do once. */
  hasCalls = false;
  /** Whether every operation in the value has a packed form of the same value. */
  isPackable = true;
  /** The arrays the value reads elements of, which a pair load reads beside. */
  readonly arrayNames: string[] = [];

  /** The counter the value under the addition reads, which is the loop's own. */
  readonly counter: string;

  /** The name the value is added into, which no lane may read. */
  readonly accumulator: string;

  constructor(value: SemanticValue, counter: string, accumulator: string) {
    this.counter = counter;
    this.accumulator = accumulator;
    walkValues(value, (one) => {
      if (one.k === "call" || one.k === "newObject") this.hasCalls = true;
      if (!this.fits(one)) this.isPackable = false;
    });
  }

  /** Whether one value under the addition has a packed form of itself. */
  private fits(value: SemanticValue): boolean {
    switch (value.k) {
      case "const":
        // A literal is the same number in both lanes, which is what a pair of
        // copies of it is.
        return isFloatType(fieldOf(value, "type") as SemanticType);
      case "local":
        // The counter is the pair itself. Any other name is loop-invariant,
        // because a counted loop here writes nothing but its counter and the
        // name it adds into, and the name it adds into is refused above.
        //
        // No test is made here of what type the name has: the array a lane
        // reads its two elements out of is reached through one of these, and it
        // is not a double. What a name is read *as* is settled where it is
        // used, by the sides of the operation around it having to be at that
        // operation's own type.
        return String(fieldOf(value, "name")) !== this.accumulator;
      case "element":
        return this.fitsElement(value);
      case "arith":
        return this.fitsArithmetic(value);
      default:
        // A field, a length, a piece of text, a cast: none of them is a number
        // a lane can be handed, and each would have to be computed twice for
        // the two lanes that are wanted from it.
        return false;
    }
  }

  /**
   * An element read at the counter, of a whole double.
   *
   * Two turns read two doubles that stand beside each other, which is one
   * sixteen-byte load and not two eight-byte ones. That is only true of a
   * double: a narrower element is two or four to a register, so the pair the
   * instruction would read is not the pair the loop wants.
   */
  private fitsElement(value: SemanticValue & { k: "element" }): boolean {
    if (value.of.k !== "local") return false;
    if (value.index.k !== "local" || value.index.name !== this.counter) return false;
    if (value.type.kind !== "primitive" || value.type.name !== "f64") return false;
    if (!this.arrayNames.includes(String(fieldOf(fieldOf(value, "of"), "name")))) this.arrayNames.push(String(fieldOf(fieldOf(value, "of"), "name")));
    return true;
  }

  /**
   * An operation, and the whole of what it refuses.
   *
   * A packed instruction and the scalar one it stands for have to be the same
   * computation on every input, not on the ones a test happens to try. Four
   * families are refused here because that is not true of them.
   *
   * **Floating point arithmetic** — add, subtract, multiply, divide — is
   * allowed, and is the same number: each lane is the same IEEE-754 operation
   * on the same operands at the same rounding mode, and a packed
   * instruction raises its exceptions on a lane without touching its
   * neighbour. What makes this a multiply and *not* a fused multiply-add is
   * that SSE2 has no fused form: the two are written as two instructions and
   * rounded twice, exactly as the scalar pair is. Were a fused form added, this
   * would have to refuse multiplication feeding an addition, because it rounds
   * once where the loop rounds twice.
   *
   * **Integer arithmetic** is refused outright, for a reason that is about this
   * backend rather than about the mathematics: every packed instruction the
   * emitter below writes is a double one, so a whole number carried in a lane
   * would be a whole number carried as a double, and a loop that adds one would
   * be handed the answer to a different loop. A packed integer form is a thing
   * to add with the encoder, not one to admit ahead of it.
   *
   * Were there one, a sum and a difference would be the only safe operations.
   * A packed sum wraps each lane at the width of the type, which is what a
   * scalar sum wraps at, so overflow would be per lane and would agree. A
   * product would not: SSE2 has no packed multiply at these widths (`PMULLD` is
   * SSE4.1 and `PMULLQ` is AVX-512), and every packed form that does exist
   * computes a wider answer than the scalar one truncates to — an overflow the
   * two would not agree on. A quotient has no packed integer divide to agree
   * with at all.
   *
   * **Shifts** are refused. A packed shift takes its count at five bits for a
   * double-word lane and six for a quad-word one, where the scalar shift masks
   * it at thirty-one or sixty-three — the width of the type. The two agree for
   * every count a program would write below the width and disagree at the top
   * of it, which is a difference the language would see.
   *
   * **Conversions** are refused, and this is the one that keeps this loop the
   * shape it is written. The scalar conversion of a float to a whole number
   * branches on the range for an unsigned target and answers the value the
   * language means; the packed conversion (`CVTTPD2DQ`) has no such branch and
   * answers one indefinite value instead, so the two agree on a signed target
   * inside its range and on nothing else. The other direction is refused
   * because widening two thirty-two bit values to two doubles moves them, and
   * narrowing a double to a single leaves one lane where the scalar form has
   * one value: which lane a value lands in is not something this may decide.
   */
  private fitsArithmetic(value: SemanticValue & { k: "arith" }): boolean {
    // A double, and one of the four operations a double pair has. Every packed
    // instruction written below reads its lanes as doubles, so a lane of any
    // other type is a lane carrying a different number than the one written.
    const type = fieldOf(value, "type") as SemanticType;
    if (!isFloatType(type)) return false;
    const op = String(fieldOf(value, "op"));
    if (op !== "add" && op !== "sub" && op !== "mul" && op !== "div") return false;
    // Every side at the type of the answer, so that a lane is one value of that
    // type rather than one of some other width the pair load did not bring. This
    // is also what refuses a whole number read where a double is: the two sides
    // are not at the answer's type, and reading one is the conversion the rule
    // above refuses.
    const left = fieldOf(value, "left") as SemanticValue;
    const right = fieldOf(value, "right") as SemanticValue;
    if (!typeEquals(fieldOf(left, "type") as SemanticType, type)) return false;
    if (!typeEquals(fieldOf(right, "type") as SemanticType, type)) return false;
    // The right side is built with the register the left side is standing in as
    // its third, which is why its height is bounded and the left side's is not:
    // the left is finished with before the right begins, so nothing is lost by
    // the right writing over it, while the right is built across it.
    return shallow(right, PACKED_RIGHT_DEPTH);
  }
}

/**
 * Every block of a body, itself included, which is what a read census over the
 * whole function is taken across.
 */
function everyBlock(block: SemanticBlock, into: SemanticBlock[] = []): SemanticBlock[] {
  for (const entry of everyBlockAtDepth(block, 0, [])) into.push(fieldOf(entry, "block") as SemanticBlock);
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
    walkValues(value, (one) => { into.push(one); });
  };
  for (const statement of fieldOf(block, "statements") as readonly SemanticStatement[]) {
    switch (statement.k) {
      case "let":
      case "set":
      case "printText":
      case "printNumber":
      case "retain":
      case "storeField": add(fieldOf(statement, "value") as SemanticValue); break;
      case "setElement": add(fieldOf(statement, "index") as SemanticValue); add(fieldOf(statement, "value") as SemanticValue); break;
      case "if": add(fieldOf(statement, "condition") as SemanticValue); break;
      case "raise": add(fieldOf(statement, "message") as SemanticValue); break;
      case "call": {
        const call = fieldOf(statement, "call") as SemanticCall;
        add({ k: "call", type: fieldOf(call, "returns") as SemanticType, call });
        break;
      }
      case "loop": {
        const loop = fieldOf(statement, "loop") as SemanticLoop;
        if (loop.kind === "counted") {
          add(fieldOf(loop, "from") as SemanticValue);
          add(fieldOf(loop, "to") as SemanticValue);
          add(fieldOf(loop, "step") as SemanticValue);
        } else if (loop.kind === "each") {
          add(fieldOf(loop, "length") as SemanticValue);
        } else {
          add(fieldOf(loop, "condition") as SemanticValue);
        }
        for (const nested of everyBlock(fieldOf(loop, "body") as SemanticBlock, [])) everyValue(nested, into);
        break;
      }
      default: break;
    }
  }
  const terminator = fieldOf(block, "terminator") as SemanticTerminator;
  if (terminator.k === "return") add(fieldOf(terminator, "value") as SemanticValue);
  return into;
}

/**
 * Every name a loop reads that it does not declare for itself.
 *
 * A turn reads these out of the frame it was handed rather than out of a
 * register, because a turn runs on a thread where the registers of this one
 * mean nothing. That is the whole reason a loop's body has to be read before
 * the registers are handed out: a name on this list may not be given one.
 *
 * A name the body declares — a `let`, the counter of a loop written inside
 * it — is the turn's own: every turn enters the declaration, so two turns
 * have two of them, and a turn initializes a name it declares before anything
 * reads it. Those are left off the list, so the register a turn-local
 * accumulator or counter is worth is one the allocator may give it: the turn
 * pushes the registers it was given and reads them back at the end, which is
 * what keeps the value the calling thread had in one.
 *
 * The list is still an over-estimate. A name the loop reads but does not write
 * could be given a register safely — the turn would only be reading a
 * value another thread wrote, which is exactly what the mark forbids, so such
 * a loop is not marked in the first place — and a name that costs a frame
 * slot it did not need is a far smaller price than a name given a register the
 * turn cannot read.
 */
function namesAViewReads(loop: SemanticLoop): Set<string> {
  const names = new Set<string>();
  // What the body declares, which is the turn's own: a name on this list is
  // read out of the register it was initialized in, not out of the frame.
  const own = new Set<string>();
  for (const block of everyBlock(fieldOf(loop, "body") as SemanticBlock, [])) {
    for (const statement of fieldOf(block, "statements") as readonly SemanticStatement[]) {
      if (statement.k === "let") own.add(String(fieldOf(fieldOf(statement, "slot"), "name")));
      if (statement.k === "loop") {
        const inner = fieldOf(statement, "loop") as SemanticLoop;
        if (inner.kind === "counted") own.add(String(fieldOf(inner, "variable")));
        else if (inner.kind === "each") {
          own.add(String(fieldOf(inner, "index")));
          own.add(String(fieldOf(inner, "element")));
        }
      }
    }
  }
  for (const block of everyBlock(fieldOf(loop, "body") as SemanticBlock, [])) {
    for (const statement of fieldOf(block, "statements") as readonly SemanticStatement[]) {
      if (statement.k === "set" || statement.k === "step") {
        const name = String(fieldOf(statement, "name"));
        if (!own.has(name)) names.add(name);
      }
      if (statement.k === "setElement") names.add(String(fieldOf(statement, "buffer")));
      if (statement.k === "fill") names.add(String(fieldOf(statement, "buffer")));
      if (statement.k === "loop" && String(fieldOf(fieldOf(statement, "loop"), "kind")) === "each") names.add(String(fieldOf(fieldOf(statement, "loop"), "of")));
      for (const value of statementValues(statement)) {
        walkValues(value, (inner) => {
          if (inner.k === "local" && !own.has(String(fieldOf(inner, "name")))) names.add(String(fieldOf(inner, "name")));
        });
      }
    }
    const terminator = fieldOf(block, "terminator") as SemanticTerminator;
    if (terminator.k === "return" && String(fieldOf(terminator, "value")) !== "null") {
      walkValues(fieldOf(terminator, "value") as SemanticValue, (inner) => {
        if (inner.k === "local" && !own.has(String(fieldOf(inner, "name")))) names.add(String(fieldOf(inner, "name")));
      });
    }
  }
  if (loop.kind === "each") names.add(String(fieldOf(loop, "of")));
  return names;
}

/**
 * Whether a body can return out of the function it is written in, which is a
 * turn cannot do: the turn is a function of its own that the runtime calls,
 * and returning from it leaves the team halfway through the loop and hands
 * the caller a function that has not returned at all.
 */
function returnsFromItsBody(body: SemanticBlock): boolean {
  for (const block of everyBlock(body, [])) {
    // A block nothing arrives at is one whose every path has already returned,
    // so a turn that reaches it returns out of the function on every one of them
    // — which is what this rule is about.
    const terminator = fieldOf(block, "terminator") as SemanticTerminator;
    if (terminator.k === "return" || terminator.k === "unreachable") return true;
  }
  return false;
}

/** The object a function's machine code is, and the code it carries. */
function lowerFunction(
  fn: SemanticFunction,
  contract: FunctionContract | undefined,
  functionName: string,
  callable: ReadonlySet<string>,
  target: TargetSpec,
  powerOfTwoParams: ReadonlySet<number> = new Set(),
  foreign: ReadonlySet<string> = new Set(),
): { bytes: Uint8Array; textSizeBytes: number; threads: boolean } {
  const machine = new Machine(fn, contract, roundsOnItsOwn(target), powerOfTwoParams, target, callable, foreign);
  const text = machine.emit();
  for (const symbol of machine.externals) {
    if (isRuntimeSymbol(symbol) || LIBRARY[symbol] === true || symbol === functionName) continue;
    if (callable.has(symbol) || foreign.has(symbol)) continue;
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
    threads: machine.teamed.size > 0,
  };
}


/**
 * The register the last argument of a call that spills nothing is taken in.
 *
 * Nothing spills, so every argument before it took a register of its own class
 * and the count of each is that argument's index among the arguments of its
 * class.
 */
function lastArgumentRegister(types: readonly SemanticType[], last: number): number {
  let floating = 0;
  for (const type of types.slice(0, last)) if (isFloatType(type)) floating += 1;
  const type = types[last] as SemanticType;
  return isFloatType(type) ? (SSE_ARGUMENTS[floating] as number) : (INTEGER_ARGUMENTS[last - floating] as number);
}

/**
 * The argument at which a call runs out of registers, or the number of
 * arguments when it does not.
 *
 * The convention gives every argument a register until a class runs out, and
 * the first argument with no register is on the stack with every argument after
 * it, whichever class those are. A caller asks this before it writes its
 * arguments down, because the ones that go on the stack are written out before
 * the registers are read and writing them out goes through the very register
 * an argument left in the accumulator is in.
 */
function firstArgumentOnStack(types: readonly SemanticType[]): number {
  let general = 0;
  let floating = 0;
  for (const [at, type] of types.entries()) {
    if (isFloatType(type) ? floating >= SSE_ARGUMENTS.length : general >= INTEGER_ARGUMENTS.length) return at;
    if (isFloatType(type)) floating += 1;
    else general += 1;
  }
  return types.length;
}

/**
 * The reciprocal of a power of two, or null when the number is not one.
 *
 * A quotient by a power of two is the same number as a product by its
 * reciprocal, and both are exact: scaling by a power of two moves the exponent
 * and never the significand, so neither form rounds where the other does — not
 * for a subnormal either, where the two round the one exact value the same way.
 * What differs is the instruction. A division has three times the latency of a
 * multiply and is not pipelined, and the quotient is usually on a chain the
 * next turn of the loop is waiting for.
 *
 * The answer is taken from the log so that a fraction of a power of two is
 * found as readily as the whole number is, and the power is read back to be
 * sure it is the one the number is: a log of its own has been rounded.
 */
function reciprocalOfTwo(value: number): number | null {
  if (!Number.isFinite(value) || value === 0) return null;
  const exponent = Math.log(Math.abs(value)) / Math.log(2);
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 1022) return null;
  if (Math.pow(2, exponent) !== Math.abs(value)) return null;
  return Math.sign(value) * Math.pow(2, -exponent);
}

/**
 * How far a loop is written out, in turns and in statements.
 *
 * Twelve turns is where a loop over a field element's limbs is written whole,
 * which is the shape that pays: the turns of a short loop are dominated by the
 * test and the step rather than by the work, and the counter of each turn is a
 * number in the instruction rather than a value kept and added to. A longer
 * loop is left rolled, because what it does not need the trip count for is what
 * it is spending its turns on.
 */
const UNROLLABLE_TURNS = 12;

/**
 * How many statements a body may hold and still be written out. A body written
 * out twelve times is twelve bodies in the object, which is a trade worth
 * making for a body of a few instructions and not for a body of many.
 */
const UNROLLABLE_STATEMENTS = 6;

/**
 * How many turns of a counted loop are written for every trip of the loop that
 * is left, and how far the counter moves on each of them, or null when the loop
 * is written the way it is today.
 *
 * The turns have to be known before the first of them is written, so all three
 * of what the loop counts by are numbers the program wrote out. What each turn
 * has then is a number this pass can put in the loop rather than a counter it
 * has to keep and add to.
 *
 * A body that calls is left alone. Unrolling a body of calls turns a loop over a
 * thousand calls into a thousand copies of the same call and saves nothing:
 * what such a loop costs is the call, and the call is the same either way.
 *
 * A body that leaves early is left alone for the other reason: a `continue`
 * belongs to the next turn of the loop, and in a loop written out the turns of
 * one trip stand one after another with nothing between them for it to skip to.
 *
 * A body that writes the counter is left alone because the turns written out
 * are the loop's own and the counter is the loop's own: a turn that moves it
 * somewhere else is a turn the unrolled loop cannot have written.
 */
function unrollPlan(loop: Extract<SemanticLoop, { kind: "counted" }>): { factor: number; step: number } | null {
  if (String(fieldOf(loop, "region")) === "true" || String(fieldOf(loop, "parallel")) !== "undefined") return null;
  const loopBody = fieldOf(loop, "body") as SemanticBlock;
  if (String(fieldOf(fieldOf(loopBody, "terminator"), "k")) !== "next") return null;
  // A `continue` in a nested arm is the same early leave as one at the foot of
  // the body, and the body's own terminator does not show it: written out, the
  // turns of one trip stand one after another with nothing between them, and the
  // branch a `continue` takes lands on the trip counter this loop counts down
  // rather than on the next turn — so the counter never moves and the trip ends
  // after its first turn. `semantics/optimize-ir.ts` refuses the same body.
  function jumpsOut(block: SemanticBlock): boolean {
    for (const statement of fieldOf(block, "statements") as readonly SemanticStatement[]) {
      for (const inner of statementBlocksOf(statement)) {
        if (jumpsOut(inner)) return true;
      }
    }
    return String(fieldOf(fieldOf(block, "terminator"), "k")) === "jump";
  }
  if (jumpsOut(loopBody)) return null;
  const statements = fieldOf(loopBody, "statements") as readonly SemanticStatement[];
  if (statements.length > UNROLLABLE_STATEMENTS) return null;
  if (bodyCalls(loopBody)) return null;
  if (writesCounter(loopBody, String(fieldOf(loop, "variable")))) return null;
  // A body that is nothing but conditionals is left rolled, which is the one
  // shape writing it out does not pay for. Unrolling buys the removal of a
  // loop's test and step, and what it removes them from is the body's own work.
  // A body of nothing but conditionals has no work of its own to amortise them
  // against: each turn is a test the body already had, plus the work under
  // whichever of its arms is taken. Writing it out N times leaves every one of
  // those tests standing and only moves the counter's test and step out of the
  // loop. The shape that pays is the opposite one — the loop over a field
  // element's limbs in a modular addition, a chain of arithmetic whose turns
  // share nothing — and it is a chain of `let` and `set`, not of `if`. The two
  // are told apart here rather than by counting statements, because the count
  // cannot: `fCmp` over eleven limbs is a single `if` whose arms assign to one
  // name, and unrolling it put 284 instructions of duplicated guard into the
  // middle of an `fAddMod` called 1.7 million times per scalar multiplication.
  if (statements.length > 0 && statements.every((statement) => statement.k === "if")) return null;
  const from = wholeLiteral(fieldOf(loop, "from") as SemanticValue);
  const to = wholeLiteral(fieldOf(loop, "to") as SemanticValue);
  if (from === null || to === null) return null;
  // A step written out carries its own sign, and a step left out is one turn in
  // the direction the loop counts in: both are what the rolled loop steps by.
  const stepValue = fieldOf(loop, "step");
  const written = String(stepValue) === "null" ? null : wholeLiteral(stepValue as SemanticValue);
  if (String(stepValue) !== "null" && written === null) return null;
  const down = String(fieldOf(loop, "down")) === "true";
  const step = written ?? (down ? -1 : 1);
  if (step === 0) return null;
  const span = down ? from - to : to - from;
  const towards = down ? -step : step;
  if (towards <= 0 || span < 0) return null;
  const turns = String(fieldOf(loop, "inclusive")) === "true" ? Math.floor(span / towards) + 1 : Math.ceil(span / towards);
  if (!Number.isSafeInteger(turns) || turns < 2) return null;
  // A loop small enough to write out whole is written out whole: every turn
  // carries its own counter in the instruction and there is no trip counter,
  // no test and no step left to pay for. Only a loop larger than that is
  // written a factor of turns at a time, which still leaves a trip to count.
  let chosen: number | null = turns <= UNROLLABLE_TURNS ? turns : null;
  if (chosen === null) {
    for (const factor of [8, 4, 2]) {
      if (turns % factor === 0) { chosen = factor; break; }
    }
  }
  return chosen === null ? null : { factor: chosen, step };
}

/** The number a whole literal writes down, or null when it is not one. */
function wholeLiteral(value: SemanticValue): number | null {
  if (value.k !== "const") return null;
  const type = fieldOf(value, "type") as SemanticType;
  const text = String(fieldOf(value, "text"));
  const number = isFloatType(type) ? Number(decimalText(text)) : Number(integerText(text));
  return Number.isSafeInteger(number) ? number : null;
}

/**
 * The select a value is written as one of, or null where it is none or not
 * alone. The select appears once, and where it stands is where the weight
 * goes: a value with two of them is one whose fast arm this pass cannot put a
 * weight under without either of the other's arms disagreeing about it.
 */
function soleSelect(value: SemanticValue): Extract<SemanticValue, { k: "select" }> | null {
  let found: Extract<SemanticValue, { k: "select" }> | null = null;
  let again = false;
  walkValues(value, (inner) => {
    if (inner.k !== "select") return;
    again = again || found !== null;
    found ??= inner;
  });
  return found === null || again ? null : found;
}

/**
 * The two sides of a sum laid end to end, in the order the sum computes them.
 * An arm that is one sum of weights and one compensation is a sum of the
 * pieces this walks: the kernel stands among plain addends, so what the turn
 * adds past the weight is what is left when the kernel is taken out.
 */
function addendsOf(value: SemanticValue, into: SemanticValue[]): void {
  if (value.k !== "arith" || value.op !== "add") {
    into.push(value);
    return;
  }
  addendsOf(value.left, into);
  addendsOf(value.right, into);
}

/** Whether two values are written as one: the same shape with the same leaves. */
function sameValue(left: SemanticValue, right: SemanticValue): boolean {
  return valueKey(left) === valueKey(right);
}

/** Whether a value of the IR is what a tree's node is, in the shape of one. */
function isValueNode(node: unknown): node is SemanticValue {
  return node !== null && typeof node === "object" && typeof (node as { k?: unknown }).k === "string";
}

/**
 * The one occurrence of a value in a tree, written as another: the match is
 * the tree's own value, and everything around it is kept as it was. A tree the
 * match stands in twice is one this refuses by the count it counted — the
 * caller asked for the one, and two of them is a shape the rewrite is not the
 * rewrite of.
 */
function replaceOnce<T>(node: T, match: SemanticValue, replacement: SemanticValue): T {
  const found = valueKey(match);
  const state: [boolean, boolean] = [false, false];
  const written = walkReplace(node, found, replacement, state);
  if (!state[0] || state[1]) throw machineError("a value a rewrite asks for once is not in it, or is in it twice");
  return written as T;
}

function walkReplace(
  node: unknown,
  found: string,
  replacement: SemanticValue,
  state: [boolean, boolean],
): unknown {
  if (isValueNode(node) && valueKey(node) === found) {
    if (state[0]) state[1] = true;
    state[0] = true;
    return structuredClone(replacement);
  }
  if (Array.isArray(node)) {
    const written: unknown[] = [];
    for (const entry of node) written.push(walkReplace(entry, found, replacement, state));
    return written;
  }
  if (node !== null && typeof node === "object") {
    const pairs: [string, unknown][] = [];
    for (const [name, entry] of Object.entries(node as Record<string, unknown>)) {
      pairs.push([name, walkReplace(entry, found, replacement, state)]);
    }
    return Object.fromEntries(pairs);
  }
  return node;
}

/**
 * The sum a triangular kernel is built over, or null where the addend is not
 * one. The kernel is the product the source wrote the triangular number of:
 * one side is the sum and the other that sum plus one, so `((i + j) * (i + j +
 * 1)) >>> 1` has the pair of it.
 */
function sumOfKernel(kernel: SemanticValue): SemanticValue | null {
  if (kernel.k !== "arith") return null;
  const product = kernel.op === "ushr" ? kernel.left : null;
  if (product === null || product.k !== "arith" || product.op !== "mul") return null;
  if (kernel.right.k !== "const" || wholeLiteral(kernel.right) !== 1) return null;
  const sum = oneAbove(product.left, product.right) ?? oneAbove(product.right, product.left);
  return sum;
}

/** The value of the pair, where one of the two sides is the other plus one. */
function oneAbove(value: SemanticValue, other: SemanticValue): SemanticValue | null {
  if (other.k !== "arith" || other.op !== "add") return null;
  if (other.right.k === "const" && wholeLiteral(other.right) === 1 && sameValue(other.left, value)) return value;
  if (other.left.k === "const" && wholeLiteral(other.left) === 1 && sameValue(other.right, value)) return value;
  return null;
}

/**
 * The leaves a test of comparisons is written as a run of, or null where one
 * of its runs is not a run of comparisons. Two conditions joined by an `and`
 * hold together only where both hold, so the leaves of a run of them are what
 * the run asks; anything else — an `or`, a test that is not a comparison — is
 * carried as the leaf it is and what it asks is the leaf's own to answer.
 */
function conjunctsOf(value: SemanticValue): SemanticValue[] | null {
  if (value.k === "logical" && value.op === "and") {
    const left = conjunctsOf(value.left);
    const right = conjunctsOf(value.right);
    return left === null || right === null ? null : [...left, ...right];
  }
  return [value];
}

/**
 * Whether anything in a value reads the name, which is what a declaration
 * nothing reads any more is told by.
 */
function readsLocal(value: SemanticValue, name: string): boolean {
  let found = false;
  walkValues(value, (inner) => {
    if (inner.k === "local" && inner.name === name) found = true;
  });
  return found;
}

/**
 * One leaf of a test of a weight, written as the tests the loop's ends answer,
 * or null where the leaf is not one the ends answer for.
 *
 * A truth the body decides for itself — a boolean the turns never write — is
 * the same answer wherever the turn reads it, and is carried as it is. A
 * comparison is the ends' to answer when exactly one of its sides moves with
 * the counter by one: the side that grows is greatest at the bound and least
 * at the first value, so the lower-of comparison holds for the run where it
 * holds at both ends, and the greater-of the same way the other round. The
 * other side does not move, and what it reads where the test stands is what it
 * reads on every turn after.
 *
 * The ends are both asked of every comparison that moves, whichever direction
 * it moves in. What needs the second end is the value the turns read at sixty
 * four bits: a side whose invariant part is below zero is read as the huge
 * number its bits are, which falls off the top of the width once the counter
 * passes it — the values are huge, then small, and a test at the bound alone
 * would call such a run held when its first turns were not. The fall happens
 * at most once, because the turns together move the side by less than the
 * width holds, so a run whose ends both hold is a run that holds between
 * them, and one whose first end does not hold is refused here.
 */
function compareWithSides(compare: SemanticValue, left: SemanticValue, right: SemanticValue): SemanticValue {
  return {
    k: "compare",
    type: fieldOf(compare, "type") as TypeExpr,
    op: String(fieldOf(compare, "op")) as CompareOp,
    operand: fieldOf(compare, "operand") as SemanticType,
    left,
    right,
  };
}

function hoistableLeaf(
  leaf: SemanticValue,
  counter: string,
  writes: (name: string) => boolean,
  from: SemanticValue,
  to: SemanticValue,
): SemanticValue | null {
  if (leaf.k === "local") {
    if (!isBoolean(fieldOf(leaf, "type") as SemanticType) || writes(String(fieldOf(leaf, "name")))) return null;
    return structuredClone(leaf);
  }
  if (leaf.k !== "compare") return null;
  if (String(fieldOf(leaf, "op")) !== "le" && String(fieldOf(leaf, "op")) !== "lt" && String(fieldOf(leaf, "op")) !== "ge" && String(fieldOf(leaf, "op")) !== "gt") return null;
  // The comparison is read at the widest unsigned width, where the side that
  // moves cannot pass the top of the width more than once over the whole run.
  // Anything narrower wraps at four billion, and a shape that wraps twice is
  // not one the ends answer for.
  if (!isUnsigned(fieldOf(leaf, "operand") as SemanticType) || widthOf(fieldOf(leaf, "operand") as SemanticType) !== 8) return null;
  const left = growthOf(fieldOf(leaf, "left") as SemanticValue, counter, writes);
  const right = growthOf(fieldOf(leaf, "right") as SemanticValue, counter, writes);
  if (left === null || right === null) return null;
  if (left !== 0 && right !== 0) return null;
  if (left === 0 && right === 0) return structuredClone(leaf);
  const growth = left !== 0 ? left : right;
  if (growth !== 1 && growth !== -1) return null;
  const growing = left !== 0;
  const leafLeft = fieldOf(leaf, "left") as SemanticValue;
  const leafRight = fieldOf(leaf, "right") as SemanticValue;
  const moving = growing ? leafLeft : leafRight;
  const standing = growing ? leafRight : leafLeft;
  const at = (end: SemanticValue): SemanticValue =>
    substituteLocals(
      structuredClone(moving),
      new Map([[counter, structuredClone(end) as SemanticValue]]),
    );
  const atFrom = compareWithSides(leaf, growing ? at(from) : standing, growing ? standing : at(from));
  const atTo = compareWithSides(leaf, growing ? at(to) : standing, growing ? standing : at(to));
  // The certificate that the turns read the side in the order its arithmetic
  // says: the side moves by one per turn, so between the ends it moves in the
  // direction it moves in and by no more than the width holds — unless the
  // value it is read at fell off the top of the width on the way, which is
  // what the ends alone cannot see. The side at the bound being past (or
  // behind, for a shrinking side) the side at the first value is what says it
  // did not fall, and with it the comparison holds where the ends hold.
  const certificate = {
    k: "compare",
    type: fieldOf(leaf, "type") as TypeExpr,
    op: growing ? "gt" : "lt",
    operand: fieldOf(leaf, "operand") as SemanticType,
    left: at(to),
    right: at(from),
  } as SemanticValue;
  return {
    k: "logical",
    type: fieldOf(leaf, "type") as SemanticType,
    op: "and",
    left: {
      k: "logical",
      type: fieldOf(leaf, "type") as SemanticType,
      op: "and",
      left: atFrom,
      right: atTo,
    } as SemanticValue,
    right: certificate,
  };
}

/**
 * How much a value moves by per turn of a counter, or null where the turns say
 * nothing about it.
 */
function growthOf(
  value: SemanticValue,
  counter: string,
  writes: (name: string) => boolean,
): number | null {
  switch (value.k) {
    case "const": {
      return wholeLiteral(value) === null ? null : 0;
    }
    case "local":
      // A name the loop writes is not a number the turns keep: it is whatever
      // the body makes of it, and no shape of one makes it a step this pass
      // may count.
      if (String(fieldOf(value, "name")) === counter) return 1;
      return writes(String(fieldOf(value, "name"))) ? null : 0;
    case "arith": {
      const left = growthOf(fieldOf(value, "left") as SemanticValue, counter, writes);
      const right = growthOf(fieldOf(value, "right") as SemanticValue, counter, writes);
      if (left === null || right === null) return null;
      if (String(fieldOf(value, "op")) === "add") return left + right;
      if (String(fieldOf(value, "op")) === "sub") return left - right;
      if (String(fieldOf(value, "op")) === "mul") {
        // A product of two movers is a mover of the turns squared, which is no one
        // amount: only a move times a written number is a move the weight may
        // count.
        const amount =
          left === 0 ? wholeLiteral(fieldOf(value, "right") as SemanticValue)
          : right === 0 ? wholeLiteral(fieldOf(value, "left") as SemanticValue)
          : null;
        const moving = left === 0 ? right : right === 0 ? left : null;
        if (amount === null || moving === null) return null;
        return amount * moving;
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * What a fast arm's weight is worth at the counter's first value, or null
 * where the arm is not one.
 *
 * The arm that answers where the test holds is the triangular number the
 * source computes its divisor with — `((i + j) * (i + j + 1)) >>> 1 + i + 1`
 * is how it is written — and what the turns travel through is the sum that
 * product is over and whatever else the arm added to it. The sum is the step
 * that moves by one per turn; and what moves with it by a whole number of
 * steps is the offset every turn adds past the sum, which is what the write of
 * the weight counts.
 */
function triangularOf(
  arm: SemanticValue,
  counter: string,
  initial: SemanticValue,
  lets: ReadonlyMap<string, SemanticValue>,
  writes: (name: string) => boolean,
): { slope: SemanticValue; offset: number; from: SemanticValue } | null {
  // The arm reads the names the body declared around it, and what it reads of
  // a name is the value that name was bound with: the shape of the sum is the
  // shape of the arithmetic, and a chain of declarations is what the walk
  // chases through. One round of that per level is what a chain stands for.
  let resolved = arm;
  for (let round = 0; round < 8; round += 1) {
    if (lets.size === 0) break;
    resolved = substituteLocals(resolved, lets);
  }
  const addends: SemanticValue[] = [];
  addendsOf(resolved, addends);
  let kernel: SemanticValue | null = null;
  let sum: SemanticValue | null = null;
  const rest: SemanticValue[] = [];
  for (const addend of addends) {
    if (kernel !== null) {
      rest.push(addend);
      continue;
    }
    const over = sumOfKernel(addend);
    if (over === null) {
      rest.push(addend);
      continue;
    }
    kernel = addend;
    sum = over;
  }
  if (kernel === null || sum === null) return null;
  // The sum is what the turns move over, so a turn of one moves it by one.
  // Any other step the arm is a progression the weight cannot be held as, and
  // the turn that remains a compute is where it belongs.
  if (growthOf(sum, counter, writes) !== 1) return null;
  // Whatever else the arm answered with, it moved by a whole number of steps
  // per turn, or the turns would walk an arm the weight cannot count.
  let offset = 0;
  for (const addend of rest) {
    const growth = growthOf(addend, counter, writes);
    if (growth === null) return null;
    if (!Number.isSafeInteger(offset + growth)) return null;
    offset += growth;
  }
  // The first weight is the arm at the counter's first value: the sum stood
  // where the loop starts from, and the rest of the arm is what answered there.
  const from = substituteLocals(
    structuredClone(resolved),
    new Map([[counter, structuredClone(initial)] as [string, SemanticValue]]),
  );
  if (hasCall(from) || !isSafeToCompute(from)) return null;
  return { slope: sum, offset, from };
}

/**
 * Whether anything in a body is a call, which is what a body is not unrolled
 * for.
 *
 * A rounding is not a call. `INLINE_BUILTINS` is written as instructions on the
 * accumulator, so a body whose only call is one has nothing a turn of the loop
 * written out could duplicate but a few arithmetic instructions, and the
 * register allocator already treats a name live across a rounding as live
 * across arithmetic. The loop a modular addition keeps its limbs in is exactly
 * such a body: every turn rounds once, and refusing to write it out left the
 * counter a double in a register, the index a conversion on every turn, and
 * eleven copies of nothing but a test and a step.
 */
function bodyCalls(body: SemanticBlock): boolean {
  for (const statement of fieldOf(body, "statements") as readonly SemanticStatement[]) {
    if (statementValues(statement).some(callsOut)) return true;
    for (const inner of statementBlocksOf(statement)) {
      if (bodyCalls(inner)) return true;
    }
  }
  return false;
}

/** Whether one value reaches a callee, which a rounding written here does not. */
function callsOut(value: SemanticValue): boolean {
  let called = false;
  walkValues(value, (inner) => {
    if (called) return;
    if (inner.k === "call") {
      const call = fieldOf(inner, "call") as SemanticCall;
      if (isInlineBuiltin(String(fieldOf(call, "callee")))) return;
    }
    if (hasCall(inner)) called = true;
  });
  return called;
}

/**
 * Whether a name is ever read as a number rather than as an index, which is what
 * says a counted loop's counter is a whole number rather than a double.
 *
 * A counter the body only ever reaches through an element read or an element
 * write is never asked what its value is. It is counted in whole numbers
 * because that is what it is being used for, and the whole number is the shape
 * a counter can be stepped and tested in one instruction each: a double is
 * stepped by a move out of the read-only data and a comparison of two floats,
 * and the two of those are on every turn of the loop.
 *
 * The places that read a counter are the index of an `element` and the index of
 * a `setElement`, and nothing else. Every other use of the name — the operand
 * of an arithmetic, a side of a comparison, an argument, a condition — asks for
 * its value, and a loop with one of those keeps the double it was given.
 */
function readsCounterAsValue(body: SemanticBlock, name: string): boolean {
  return blockReadsCounterAsValue(body, name);
}

function blockReadsCounterAsValue(block: SemanticBlock, name: string): boolean {
  for (const statement of fieldOf(block, "statements") as readonly SemanticStatement[]) {
    // The index of an element write is left out, and everything else the
    // statement carries is walked.
    if (statement.k === "setElement") {
      if (valueWantsName(fieldOf(statement, "value") as SemanticValue, name)) return true;
    } else {
      for (const value of statementValues(statement)) {
        if (valueWantsName(value, name)) return true;
      }
    }
    for (const inner of statementBlocksOf(statement)) {
      if (blockReadsCounterAsValue(inner, name)) return true;
    }
  }
  return false;
}

function valueWantsName(value: SemanticValue, name: string): boolean {
  switch (value.k) {
    case "local":
      return String(fieldOf(value, "name")) === name;
    case "element":
      return valueWantsName(fieldOf(value, "of") as SemanticValue, name);
    case "text": {
      const parts = fieldOf(value, "parts") as readonly
        ({ k: "text"; value: string } | { k: "value"; value: SemanticValue })[];
      for (const part of parts) {
        if (part.k === "value" && valueWantsName(fieldOf(part, "value") as SemanticValue, name)) return true;
      }
      return false;
    }
    case "length":
    case "toText":
      return valueWantsName(fieldOf(value, "of") as SemanticValue, name);
    case "isNull":
    case "unary":
      return valueWantsName(fieldOf(value, "operand") as SemanticValue, name);
    case "argv": {
      const index = fieldOf(value, "index");
      return String(index) !== "null" && valueWantsName(index as SemanticValue, name);
    }
    case "call": {
      const call = fieldOf(value, "call") as SemanticCall;
      for (const one of fieldOf(call, "args") as readonly SemanticValue[]) {
        if (valueWantsName(one, name)) return true;
      }
      return false;
    }
    case "arith":
    case "compare":
    case "logical":
    case "coalesce":
      return valueWantsName(fieldOf(value, "left") as SemanticValue, name) ||
        valueWantsName(fieldOf(value, "right") as SemanticValue, name);
    case "buffer": {
      const count = fieldOf(value, "count");
      if (String(count) !== "null" && valueWantsName(count as SemanticValue, name)) return true;
      const view = fieldOf(value, "view");
      if (String(view) !== "null") {
        const viewRecord = view as { of: SemanticValue; offset: SemanticValue };
        if (valueWantsName(fieldOf(viewRecord, "of") as SemanticValue, name)) return true;
        if (valueWantsName(fieldOf(viewRecord, "offset") as SemanticValue, name)) return true;
      }
      for (const one of fieldOf(value, "values") as readonly SemanticValue[]) {
        if (valueWantsName(one, name)) return true;
      }
      return false;
    }
    case "loadField":
      return valueWantsName(fieldOf(value, "object") as SemanticValue, name);
    case "newObject": {
      for (const field of fieldOf(value, "fields") as readonly { value: SemanticValue }[]) {
        if (valueWantsName(fieldOf(field, "value") as SemanticValue, name)) return true;
      }
      return false;
    }
    case "select":
      return valueWantsName(fieldOf(value, "condition") as SemanticValue, name) ||
        valueWantsName(fieldOf(value, "then") as SemanticValue, name) ||
        valueWantsName(fieldOf(value, "otherwise") as SemanticValue, name);
    default:
      return false;
  }
}

/**
 * Whether a counted loop can be counted in whole numbers, which is what
 * `wholeCounted` is the answer for.
 *
 * Three numbers have to be numbers the program wrote out: the one the loop
 * counts from, the one it counts to and its step. The first two are compared
 * against each other and the step is added to the counter, and every one of those
 * is an instruction with a number of its own inside — an immediate for a whole
 * number. A bound that is not one is a value read out of the frame, and a test
 * against it is a comparison of two doubles, which is what the general form
 * writes and what this leaves alone.
 *
 * The three are also held to what an instruction's own immediate field encodes,
 * a sign-extended thirty-two bit number, so a loop that counts past that is left
 * to the general form rather than answered with a truncated bound.
 */
function wholeCountable(loop: Extract<SemanticLoop, { kind: "counted" }>): boolean {
  const fits = (value: number): boolean => value >= -0x8000_0000 && value <= 0x7fff_ffff;
  const from = wholeLiteral(fieldOf(loop, "from") as SemanticValue);
  const to = wholeLiteral(fieldOf(loop, "to") as SemanticValue);
  const stepValue = fieldOf(loop, "step");
  const down = String(fieldOf(loop, "down")) === "true";
  const step = String(stepValue) === "null" ? (down ? -1 : 1) : wholeLiteral(stepValue as SemanticValue);
  return from !== null && to !== null && step !== null && fits(from) && fits(to) && fits(step);
}

/** Whether a loop's body writes the name the loop counts by, which the loop owns. */
function writesCounter(body: SemanticBlock, name: string): boolean {
  for (const statement of fieldOf(body, "statements") as readonly SemanticStatement[]) {
    if ((statement.k === "set" || statement.k === "step") && String(fieldOf(statement, "name")) === name) return true;
    for (const inner of statementBlocksOf(statement)) {
      if (writesCounter(inner, name)) return true;
    }
  }
  return false;
}

/**
 * Whether a counted loop is written with a whole-number counter and no double
 * beside it.
 * A counter the body reaches only as an index is counted in whole numbers
 * where the loop's own numbers are whole numbers: the whole-number copy the
 * index is read out of is the counter, and the double the source wrote is never
 * written at all.
 *
 * Where the loop cannot be counted that way — its bound is a number the program
 * wrote rather than a literal, or its step is not a whole number — the double
 * is the counter the test compares, and it is read on every turn of the loop.
 * That is what makes the two cases different for the register the counter is
 * given: a double nothing ever reads is not worth a register of its own, and a
 * double the test reads on every turn is.
 */
function countsWholly(loop: Extract<SemanticLoop, { kind: "counted" }>): boolean {
  if (!wholeCountable(loop)) return false;
  if (readsCounterAsValue(loop.body, loop.variable)) return false;
  if (writesCounter(loop.body, loop.variable)) return false;
  return true;
}

/**
 * Whether a value allocates an object or an array of its own, which is what
 * takes the register an object is filled in.
 *
 * The register is one the convention asks a callee to leave alone, so a call
 * does not take it and a value that computes nothing does not either. An
 * allocation is written into it, because the allocation answers in the
 * accumulator and the register is where the thing allocated is kept while its
 * fields are written.
 */
function allocates(value: SemanticValue): boolean {
  let found = false;
  walkValues(value, (one) => {
    if (one.k === "newObject" || one.k === "buffer") found = true;
  });
  return found;
}

/**
 * Whether a target runs the rounding instruction, which is where a value rounded
 * to a whole number stops being a call into the C library.
 *
 * It is SSE4.1, which is not part of the instruction set every processor of this
 * machine runs: `assertMachineTarget` above promises the code every one of them
 * runs, so a target that has not said it has the instruction is answered with
 * the library, as it was before this instruction was written. A project that
 * named it in `target.features` gets the one instruction; a project that does
 * not is no worse off than before.
 *
 * A named `target.cpu` answers the same question, because that is what the C
 * backend is already handed: `cTargetOptions` passes it straight to gcc as
 * `-march`, and a program built for a cpu is a program its author has said may
 * assume that cpu's instruction set. Every cpu gcc names from Nehalem on has
 * SSE4.1, so a project that named one and was still answered with the library
 * here was reading a target the C half of the same build had already believed.
 */
function roundsOnItsOwn(target: TargetSpec): boolean {
  if (target.features.includes("sse4.1") || target.features.includes("sse4.2")) return true;
  return target.cpu !== "" && CPU_HAS_SSE41.test(target.cpu);
}

/**
 * Whether a target runs the BMI2 instructions, which is where wide arithmetic
 * stops being a chain of flag-dependent `adc`/`sbb` and a library call for
 * multiplication, and becomes flag-free `adcx`/`adox` and `mulx` written inline.
 *
 * It is not part of the instruction set every processor of this machine runs:
 * `assertMachineTarget` above promises the code every one of them runs, so a
 * target that has not said it has the instructions is answered with the flag
 * chain and the library, as it was before these instructions were written.
 * A project that named `bmi2` in `target.features` gets them; a project that
 * does not is no worse off than before.
 */
function bmi2OnItsOwn(target: TargetSpec): boolean {
  if (target.features.includes("bmi2")) return true;
  return target.cpu !== "" && CPU_HAS_BMI2.test(target.cpu);
}

/** The value of a wide constant the source wrote out, or null for anything
 *  the backend cannot read as one.
 *
 * A wide constant arrives two ways: as the literal the optimizer folded, and
 * as the two constructors that build one from its 64 bit limbs. Both are
 * values the compiler knows, so both count. */
function wideConstantOf(value: SemanticValue): bigint | null {
  const type = fieldOf(value, "type") as SemanticType;
  if (value.k === "const") return isWideType(type) ? integerLiteral(String(fieldOf(value, "text"))) : null;
  if (value.k !== "call" || !isWideType(type)) return null;
  const call = fieldOf(value, "call") as SemanticCall;
  const callee = String(fieldOf(call, "callee"));
  if (callee !== "u256_from_u64x2" && callee !== "u256_from_u64x4") return null;
  const args = fieldOf(call, "args") as readonly SemanticValue[];
  let whole = 0n;
  for (let at = 0; at < args.length; at += 1) {
    const limb = args[at];
    const part = limb.k === "const" ? integerLiteral(String(fieldOf(limb, "text"))) : null;
    if (part === null || part < 0n || part >= (1n << 64n)) return null;
    whole |= part << BigInt(at * 64);
  }
  return whole;
}

/**
 * `c` when a value is the modulus of a special prime — `2^256 - c` with `c`
 * below `2^64` — and null otherwise.
 *
 * A special prime is one whose reduction is a multiply of the high limbs by
 * one word rather than the general bit-by-bit reduction, and the modulus is
 * the only thing that decides it. The value is a constant here, so the
 * decision is the compiler's: the kernel call is the specialised one, the
 * additions are written out as the four limb chains they are, and nothing at
 * run time tests, branches on, or recomputes which kind of modulus it holds.
 *
 * `c` is below `2^64` because that is the shape whose folding is a fixed
 * number of limb passes: `high * c` stays within five limbs and the top limb
 * it leaves folds twice at most. A modulus with a wider complement keeps the
 * general kernel, which is correct for every modulus below `2^256`.
 */
function specialPrimeC(value: SemanticValue): bigint | null {
  const modulus = wideConstantOf(value);
  if (modulus === null || modulus <= 0n || modulus >= (1n << 256n)) return null;
  const c = (1n << 256n) - modulus;
  return c < (1n << 64n) ? c : null;
}

/** The cpu names that carry BMI2, which is every processor gcc has accepted as
 *  a `-march` from Haswell on, plus the feature levels that name it directly. */
const CPU_HAS_BMI2: RegExp =
  /^(haswell|broadwell|skylake|skylake-avx512|cooperlake|cannonlake|cascadelake|icelake-client|icelake-server|rocketlake|alderlake|raptorlake|sapphirerapids|graniterapids|tigerlake|znver[1-9]|x86-64-v[3-9])$/;

/**
 * The cpu names that carry SSE4.1, which is every processor gcc has accepted as
 * a `-march` from Nehalem on, plus the feature levels that name it directly. A
 * project that writes one of these has said what it may assume, and this is the
 * list that says what each of them means.
 */
const CPU_HAS_SSE41: RegExp =
  /^(nehalem|westmere|sandybridge|ivybridge|haswell|broadwell|skylake|skylake-avx512|cooperlake|cannonlake|cascadelake|icelake-client|icelake-server|rocketlake|alderlake|raptorlake|sapphirerapids|graniterapids|tigerlake|amdgpu|znver[1-9]|bdver[1-9]|btver[1-9]|x86-64-v[3-9])$/;

/** What the linker sees in the object that was written. */
function inspectWrittenObject(objectPath: string, functionName: string): { defined: string[]; undefined: string[] } {
  // The object was written by this compiler, and reading it back is what says
  // it holds what was meant: the symbol table it wrote is the whole answer, and
  // `nm` was two processes per function asked to repeat it.
  try {
    return objectSymbols(readFileSync(objectPath, undefined as never));
  } catch (reason) {
    throw machineError(
      `cannot inspect the object of ${functionName}`,
      reason instanceof Error ? reason.message : String(reason),
      functionName,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* The lowering                                                                 */
/* -------------------------------------------------------------------------- */

/** What a whole number may be combined with, and how. */
type Arithmetic = "add" | "sub" | "mul" | "div" | "floorDiv" | "floorMod" | "mod" | "shl" | "shr" | "ushr" | "sar" | "and" | "or" | "xor";

/**
 * A loop whose turns are run on a team of threads: the two kinds that count.
 *
 * A `while` or a `do-while` decides from a condition whether the next turn
 * runs, so the rule never marks one, and neither shape is a range the runtime
 * could cut into parts.
 */
type TeamedLoop = Extract<SemanticLoop, { kind: "counted" | "each" }>;

/**
 * The labels one loop's header and its exit are written under, and the ids the
 * IR named them by. The ids are what a `break` and a `continue` name; the
 * labels are what a jump is written to, and they are the lowering's own because
 * one block id can stand for more than one place in the code — a loop that sits
 * in the entry block leaves for that block, and so does the next loop after it.
 */
interface LoopLabels {
  readonly header: string;
  readonly exit: string;
  readonly names: { readonly header: string; readonly exit: string };
}

/** A value the lowering keeps in the frame while it builds another. */
class Held {
  /**
   * What tells this value from every other the function binds. A register is
   * handed back and given to another value, and a slot in the frame is handed
   * back and taken again, so neither the register nor the offset says on its
   * own which value a note about the accumulator is about.
   */
  readonly id: number;
  /** Where in the frame it is: a distance up from the bottom of it. */
  readonly offset: number;
  readonly type: SemanticType;
  /**
   * The register holding this value as a whole number, where it is a counter a
   * loop steps by whole ones and is read as an index. A counter of this program
   * is a double, so reading it as an index is a conversion; holding the same
   * number in a register of its own is the conversion done once for the loop
   * rather than once for every element the counter reaches.
   */
  readonly index: number | null;
  /**
   * The whole number this value holds, where the loop it belongs to counted it
   * out and the number of each turn is therefore in the code rather than in a
   * register: an element it reaches is then addressed by that number times the
   * width of an element, added to the buffer, and the register the index would
   * otherwise be materialized into is never written at all. Null wherever the
   * value is somewhere a read would have to go to, which is every name whose
   * number the lowering does not know.
   *
   * This is written by the turns of an unrolled loop as they are written, so it
   * is the value's own note of what its index register would hold, and it is
   * what `plainIndex` answers an element's index out of.
   */
  constant: bigint | null;
  /**
   * The register a value that never changes lives in, or null where it lives in
   * the frame. A name that is written once and read after is in a register that
   * a call cannot take, so a read of it is a move and a frame is not reserved
   * for it at all.
   *
   * The turn that reads the frame it was handed puts a hot name of that frame
   * in a register of its own while it runs, which is what writes this field
   * after the allocation was done — and reads it back to null when the turn is
   * written, so the next statement the outer body binds sees the frame the
   * allocation answered for.
   */
  register: number | null;

  constructor(
    id: number,
    offset: number,
    type: SemanticType,
    index: number | null,
    constant: bigint | null,
    register: number | null,
  ) {
    this.id = id;
    this.offset = offset;
    this.type = type;
    this.index = index;
    this.constant = constant;
    this.register = register;
  }
}

function heldWithRegister(held: Held, register: number | null): Held {
  return new Held(
    fieldOf(held, "id") as number,
    fieldOf(held, "offset") as number,
    fieldOf(held, "type") as SemanticType,
    fieldOf(held, "index") as number | null,
    fieldOf(held, "constant") as bigint | null,
    register,
  );
}

function setStatementWithValue(statement: SemanticStatement, value: SemanticValue): SemanticStatement {
  return {
    k: "set",
    name: String(fieldOf(statement, "name")),
    op: String(fieldOf(statement, "op")) as SemanticAssignOp,
    value,
    line: fieldOf(statement, "line") as number,
  };
}

function blockWithStatements(block: SemanticBlock, statements: SemanticStatement[]): SemanticBlock {
  return {
    id: String(fieldOf(block, "id")),
    statements,
    releases: fieldOf(block, "releases") as string[],
    terminator: fieldOf(block, "terminator") as SemanticTerminator,
  };
}

function countedWithBody(
  loop: Extract<SemanticLoop, { kind: "counted" }>,
  body: SemanticBlock,
): Extract<SemanticLoop, { kind: "counted" }> {
  const next: Extract<SemanticLoop, { kind: "counted" }> = {
    kind: "counted",
    variable: String(fieldOf(loop, "variable")),
    type: fieldOf(loop, "type") as SemanticType,
    from: fieldOf(loop, "from") as SemanticValue,
    to: fieldOf(loop, "to") as SemanticValue,
    inclusive: String(fieldOf(loop, "inclusive")) === "true",
    down: String(fieldOf(loop, "down")) === "true",
    step: fieldOf(loop, "step") as SemanticValue | null,
    header: String(fieldOf(loop, "header")),
    exit: String(fieldOf(loop, "exit")),
    body,
    parallel: String(fieldOf(loop, "parallel")) === "true" ? true : undefined,
    region: String(fieldOf(loop, "region")) === "true" ? true : undefined,
    reductions: fieldOf(loop, "reductions") as Extract<SemanticLoop, { kind: "counted" }>["reductions"],
  };
  return next;
}

class Machine {
  readonly code = new Encoder();
  readonly rodata: number[] = [];
  /** A literal already laid down, so one string is written to the object once. */
  private readonly literals = new Map<string, string>();
  /** The descriptor of each layout, laid down once per object file. */
  private readonly objectDescriptors = new Map<string, string>();
  /** A float already laid down, so one constant is written to the object once. */
  private readonly floatLabels = new Map<string, string>();
  /** The labels of the numbers laid down in both halves of a pair. */
  private readonly floatPairs = new Map<string, string>();
  /** The labels of the eight-double constant vectors laid down for packed loops. */
  private readonly floatLists = new Map<string, string>();
  readonly labels: DataLabel[] = [];
  /** The symbols the code calls or reads that this object does not define. */
  readonly externals: string[] = [];
  /**
   * The symbols this backend builds the code of.
   *
   * One of them spills every vector register it uses in its prologue and reads
   * them back in its epilogue, so a value kept in one survives the call. The
   * C library, the runtime and the host are not built that way: this target is
   * System V AMD64, where no vector register is preserved by a call at all.
   */
  private readonly callable: ReadonlySet<string>;
  private readonly foreign: ReadonlySet<string>;
  /** The target the function is lowered for, which decides whether BMI2
   *  instructions are available. */
  readonly target: TargetSpec;

  private readonly names = new NameScope((name) => name);
  private readonly slots = new Map<string, Held>();
  private readonly boxedTexts = new Set<string>();
  /**
   * How many elements each buffer name holds, as the name was bound with.
   *
   * An array reaches a function as a pointer to its elements, and no count
   * arrives with it — but a few forms give the count where the array is bound:
   * the elements written out, the count the program settled on when it runs,
   * and the name of the array the binding is again. `a.fill(x)` is a walk over
   * that count, so the count is read where the binding is written and held
   * here, the way the C driver holds it beside the name as `${name}_length`.
   * Anything else the lowering is asked to walk is refused rather than walked
   * over a number nobody read.
   */
  private readonly arrayCounts = new Map<string, bigint | Held>();
  /**
   * The names that hold a window of another block, whose pointer is the block
   * moved to where the window starts. The header in front of such a pointer is
   * not the header of the block the window is of, so its length is no count this
   * backend may read: the C backend carries it beside the name instead.
   */
  private readonly views = new Set<string>();
  private readonly loops: { header: string; exit: string; names: { header: string; exit: string } }[] = [];
  /**
   * The region loop the code being written is inside the body of, if any.
   *
   * A turn that leaves early — one that breaks out of its loop, or returns out
   * of the function — leaves the region there rather than at the end of a body
   * it never reaches. Only one region is open at a time: `semantics/region.ts`
   * marks a loop only where no loop inside it is marked.
   */
  private region: { header: string } | null = null;
  private readonly layouts: Record<string, ObjectLayout>;
  private readonly epilogue = this.code.label("Lepilogue");
  /** How many labels the lowering has minted, one pair per loop. */
  private mintedLabels = 0;
  /**
   * The labels a loop's header and its exit are written under.
   *
   * The IR names both by the id of the block they belong to, and a loop whose
   * exit is the block around it names the very block the function starts in:
   * two `for` loops one after another both leave for `entry`. Binding that id
   * twice makes the second binding the one every jump resolves to, so the first
   * loop's exit jumps past the second loop to the end of the function. A label
   * the lowering mints is named once and means one place.
   */
  private loopLabels(loop: SemanticLoop): LoopLabels {
    const at = this.mintedLabels++;
    const header = `Lhead${at}`;
    const exit = `Lexit${at}`;
    return {
      header,
      exit,
      names: { header: String(fieldOf(loop, "header")), exit: String(fieldOf(loop, "exit")) },
    };
  }
  private used = 0;
  private temporaries = 0;
  /** Slots bound for the statements being written and not yet handed back. */
  private readonly borrowed: Held[] = [];
  /**
   * Slots handed back, which the next statement that needs one takes, with the
   * room each of them has: a value of thirty-two bytes is not written into the
   * eight a pointer was handed back in, because the frame around it holds what
   * the next name lives in.
   */
  private readonly spareSlots: { offset: number; bytes: number }[] = [];
  /** The register a name that never changes is in, by the name it is declared as. */
  private readonly pinned = new Map<string, number>();
  /** The registers the prologue pushes and the epilogue reads back, in that order. */
  private pinnedRegisters: number[] = [];
  /** The vector registers spilled to the frame by the prologue and read back by the epilogue. */
  private pinnedVectors: VectorSave[] = [];
  /**
   * Where the vector registers this function keeps values in are written down
   * across a call into code this backend did not build.
   *
   * A register saved here is not the prologue's slot: that one holds the value
   * the caller had, which the epilogue has to give back, and a call writes the
   * slot with what this function holds now.
   */
  private callSaves: VectorSave[] = [];
  /** The register an object being filled lives in, when this function fills one. */
  private objectRegister: number | null = null;
  /**
   * The loops this function is writing a team of threads for, and the turns
   * still to be written out of them.
   *
   * A turn cannot be written where the loop stands: it is called by the
   * runtime from a thread of its own, with a stack that is not this one, so it
   * is written out here and placed at the end of the code. The set is what
   * says which loops are written that way, and it is filled before the body is
   * read because the frame a turn reads is laid out as the body is read.
   */
  readonly teamed = new Set<SemanticLoop>();
  /** The turns written out and waiting to be placed, in the order they were met. */
  private readonly turns: { readonly label: string; readonly loop: TeamedLoop }[] = [];
  /**
   * The names a turn reads out of the frame it was handed, which the register
   * allocator is told about so that none of them is given a register.
   *
   * A name in a register is a name whose value lives in this thread's
   * registers, and a turn runs on a thread of its own, where those registers
   * hold whatever that thread was last doing. So a name a turn reads has to be
   * in the frame, which the turn copies and then reads at the offset it had
   * here.
   */
  private readonly turnNames = new Set<string>();
  /**
   * Where a wide answer is put down before it is copied to the caller, and where
   * the pointer the caller gave for it was kept.
   *
   * A wide number is returned through memory, so the convention passes the
   * address to write it at in `rdi` — the first argument register, which the body
   * is then free to overwrite. It is put in a slot on entry and read back in the
   * epilogue, and the four limbs are written to a slot of their own rather than
   * straight through the pointer, so that the answer is computed and finished
   * before anything is copied anywhere.
   */
  private wideResult: Held | null = null;
  private wideSret: Held | null = null;
  /** Whether the body calls anything, which is what the frame's size answers for. */
  private mayCall = false;
  /** The arguments that arrived on the stack, and where each one's address is written. */
  private readonly incoming: { index: number; at: number }[] = [];
  /**
   * The slot whose value the accumulator holds, and where the code stood when
   * it last did — which is what `load` reads, and what nothing else may.
   */
  private accumulatorNote: { id: number; at: number } | null = null;

  /** The next identity a bound value is given, which no other value has. */
  private heldCount = 0;

  /**
   * Whether this function allocates an object or writes an array out, which is
   * what the register above is for.
   *
   * A function that never builds one has no use for the register, and taking it
   * anyway would cost every such function a push and a pop for nothing — which
   * is the whole of what a name being pinned costs, so a program of small
   * functions would pay for a change that helps only the few that allocate.
   */
  private fillsObjects(): boolean {
    for (const block of everyBlock(fieldOf(this.fn, "entry") as SemanticBlock, [])) {
      for (const value of everyValue(block, [])) {
        if (value.k === "newObject" || value.k === "buffer") return true;
      }
    }
    return false;
  }
  private lastLiteral = "";

  private fn: SemanticFunction;
  /** Maps a sequence parameter's name to the name of its hidden length parameter. */
  private arrayParamLengths = new Map<string, string>();
  /**
   * Whether this machine rounds a value to a whole number with an instruction of
   * its own, which is a fact about the target the build was asked for and not
   * about the function being written.
   */
  private readonly rounds: boolean;
  /**
   * Whether the target the build was asked for has AVX-512 foundation support,
   * which is what lets the lowering emit packed 512-bit division. The feature
   * is named in `target.features` by the project; it is not probed from the
   * host processor, so a binary built with it only runs on AVX-512 hardware.
   */
  private get avx512(): boolean {
    return this.target.features.includes("avx512f");
  }
  /**
   * The parameter indices that hold power-of-two arrays, so division by one of
   * their elements can be strength-reduced to a shift.
   */
  private readonly poTParams: ReadonlySet<number>;
  /**
   * The whole-number registers the counted loops of this function keep their
   * counters in, keyed by the counter name. A counter that is whole-counted is
   * stepped in a register of its own rather than held as a double in the frame,
   * and that register is what a shift count is read out of.
   */
  private readonly counterRegisters = new Map<string, number>();

  constructor(fn: SemanticFunction, contract: FunctionContract | undefined, rounds = false, powerOfTwoParams: ReadonlySet<number> = new Set(), target: TargetSpec = { arch: "x86_64", os: "linux", abi: "sysv", cpu: "", features: [] }, callable: ReadonlySet<string> = new Set(), foreign: ReadonlySet<string> = new Set()) {
    this.callable = callable;
    this.foreign = foreign;
    const params = fieldOf(fn, "params") as readonly SemanticSlot[];
    const augmented: SemanticSlot[] = [];
    for (const param of params) {
      augmented.push(param);
      const type = slotType(param);
      if (isSequence(type)) {
        const name = String(fieldOf(param, "name"));
        const lengthName = `${name}_length`;
        this.arrayParamLengths.set(name, lengthName);
        augmented.push({ kind: "value", name: lengthName, mutable: false, type: USIZE } as SemanticSlot);
      }
    }
    const widened: SemanticFunction = {
      name: String(fieldOf(fn, "name")),
      symbol: String(fieldOf(fn, "symbol")),
      params: augmented,
      returns: fieldOf(fn, "returns") as SemanticType,
      requires: fieldOf(fn, "requires") as SemanticFunction["requires"],
      ensures: fieldOf(fn, "ensures") as SemanticFunction["ensures"],
      effects: fieldOf(fn, "effects") as SemanticFunction["effects"],
      allocates: fieldOf(fn, "allocates") as boolean,
      prints: fieldOf(fn, "prints") as boolean,
      readsArgv: fieldOf(fn, "readsArgv") as boolean,
      objects: fieldOf(fn, "objects") as SemanticFunction["objects"],
      calls: fieldOf(fn, "calls") as SemanticFunction["calls"],
      entry: fieldOf(fn, "entry") as SemanticBlock,
    };
    this.fn = augmented.length === params.length ? fn : widened;
    this.rounds = rounds;
    this.poTParams = powerOfTwoParams;
    this.target = target;
    // A layout the program lays out is in the function; one only the contract
    // states is the contract's, and both are the same struct to every reader.
    const stated = contract === undefined ? {} : (fieldOf(fieldOf(contract, "definition"), "objects") as Record<string, ObjectLayout>);
    this.layouts = { ...stated, ...(fieldOf(fn, "objects") as Record<string, ObjectLayout>) };
    for (const parameter of params) {
      if (String(fieldOf(parameter, "kind")) === "text" && String(fieldOf(parameter, "boxed")) === "true") {
        this.boxedTexts.add(String(fieldOf(parameter, "name")));
      }
    }
    // A bound label is a place control reaches from somewhere other than the
    // instruction in front of it, so what the accumulator held before one is a
    // fact about the path that fell through and about no other. That is what
    // makes a note about the accumulator safe to read on the far side of one.
    this.code.onBind = () => {
      this.accumulatorNote = null;
    };
  }

  /* ---------------------------------------------------------------------- */
  /* The frame                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Room in the frame for `bytes`, and where in the frame it is: a distance up
   * from the bottom of it, which is where the prologue left the stack pointer.
   *
   * A slot's address is settled here rather than at the end of the body,
   * because the frame grows upwards from a stack pointer the prologue has
   * already moved: a slot reserved now keeps the address it is given however
   * much the frame grows around it afterwards. That is what the body and the
   * epilogue are both written against, and it is why the frame's own size is
   * the one number in a prologue that has to be left a field for.
   */
  private reserve(bytes: number, alignment = 8): number {
    this.used = Math.ceil((this.used + bytes) / alignment) * alignment;
    return this.used - bytes;
  }

  /**
   * The vector registers a value of an expression may be held in, and how many
   * of them are free. A register is taken for the length of one statement and
   * given back when the statement that took it has been written, so this is a
   * stack rather than a set: the last register to be given back is the first to
   * be taken again, which keeps the same one in play across a nested
   * expression and leaves the frame for the values that have to cross a call.
   */
  private readonly spareVectors: number[] = [];

  /**
   * The whole-number registers a counter may be read as an index out of, taken
   * one at a time by the loop that owns one. They are callee-saved for the same
   * reason the vector registers are: a loop whose body calls anything would find
   * the counter's index gone the first time it did.
   */
  private readonly spareIndexes: number[] = [];

  /**
   * The vector registers the bounds of this function's loops may be held in,
   * taken one at a time by the loop that owns one.
   *
   * A bound is held for as long as its loop runs, so two loops nested one in
   * the other need two of them, and a register a loop holds is one no other
   * value of the body may be written into.
   */
  private readonly spareBounds: number[] = [];

  /**
   * The vector registers a loop the lowering weights keeps its weight and its
   * step in, taken by the register pass before any name is weighed.
   *
   * A weight is read and stepped on every turn of its loop, and its step is read
   * on every turn too. Kept in the frame, each of them is a store and a load per
   * turn, and the load of the step is the first half of the addition that steps
   * the weight — which is the chain the turn's divisor waits on. Two registers
   * take the whole of it off the memory.
   */
  private readonly spareWeighted: number[] = [];

  /**
   * Every register the bounds of this function's loops may be held in, whether
   * a loop has taken one of them yet or not.
   *
   * A register a loop has not taken yet is free for anything else, and one it
   * has is not: the loop that holds it keeps it for as long as it runs, and
   * everything written inside that loop has to leave it alone.
   */
  private readonly boundRegisters: number[] = [];

  /**
   * One of the registers above, when one is free and no name has been pinned
   * into it, or null when there is none to give. A register a name is pinned
   * into is not free whatever the stack says, so the two pools are asked
   * together.
   */
  private takeSpareVector(): number | null {
    const spoken = new Set(this.pinned.values());
    for (const register of this.spareVectors) {
      if (spoken.has(register)) continue;
      this.spareVectors.splice(this.spareVectors.indexOf(register), 1);
      return register;
    }
    return null;
  }

  /**
   * The callee-saved vector registers the values of this function's expressions
   * may be held in, up to what its arithmetic is deep enough to want. A body
   * that computes nothing in floats is given none, which is what keeps the
   * prologue of a small function free of them.
   *
   * How many are worth having is how many one expression can hold at once: a
   * side of an arithmetic is held while the other side is written, so three is
   * as deep as an expression of ordinary shape goes. Anything deeper than that
   * is answered out of the frame, which is what every value was answered out of
   * before.
   */
  private reserveTemporaryVectors(taken: ReadonlySet<number>): number[] {
    // Only arithmetic a loop turns over pays for the registers: a prologue that
    // saves three and an epilogue that reads them back are worth a few
    // instructions per call, and a function that computes a sum once has one
    // call to spend them on.
    function turning(block: SemanticBlock, depth: number): number {
      let count = 0;
      for (const statement of fieldOf(block, "statements") as readonly SemanticStatement[]) {
        for (const inner of statementBlocksOf(statement)) count += turning(inner, depth + (statement.k === "loop" ? 1 : 0));
        if (depth === 0) continue;
        for (const value of statementValues(statement)) {
          if (isFloatType(fieldOf(value, "type") as SemanticType) &&
              (value.k === "arith" || value.k === "compare")) count += 1;
        }
      }
      return count;
    }
    const arithmetic = turning(fieldOf(this.fn, "entry") as SemanticBlock, 0);
    if (arithmetic === 0) return [];
    const free = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15].filter((register) => !taken.has(register));
    return free.slice(Math.max(free.length - Math.min(arithmetic, TEMPORARY_VECTORS), 0));
  }

  /**
   * The registers the bounds of this function's loops may be held in.
   *
   * A loop that counts in doubles tests its bound on every turn, and the test
   * needs the bound in a register: the instruction that compares two doubles
   * takes one of them as its destination and the other as its source, and the
   * condition that answers "less than" needs the larger side in the
   * destination. A bound in the frame is read into the scratch first, which is
   * a second instruction on every turn of the loop.
   *
   * A bound in a register is held for as long as the loop runs, so two loops
   * nested one in the other need two of them. One is enough for a program that
   * counts one loop at a time, which is what a program does far more often
   * than it counts a loop inside a loop.
   */
  private reserveBoundRegisters(taken: ReadonlySet<number>): number[] {
    const deepest = this.boundDepth(fieldOf(this.fn, "entry") as SemanticBlock, 0);
    if (deepest === 0) return [];
    const free = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15].filter((register) => !taken.has(register));
    return free.slice(Math.max(free.length - deepest, 0));
  }

  /** How deeply bounds are held at once in a body. */
  private boundDepth(body: SemanticBlock, depth: number): number {
    let deepest = depth;
    for (const statement of fieldOf(body, "statements") as readonly SemanticStatement[]) {
      if (statement.k === "loop") {
        const loop = fieldOf(statement, "loop") as SemanticLoop;
        if (loop.kind === "counted" && this.holdsBound(loop)) {
          deepest = Math.max(deepest, depth + 1);
        }
        deepest = Math.max(deepest, this.boundDepth(fieldOf(loop, "body") as SemanticBlock, depth + 1));
      } else if (statement.k === "if") {
        deepest = Math.max(deepest, this.boundDepth(fieldOf(statement, "then") as SemanticBlock, depth));
        const otherwise = fieldOf(statement, "otherwise") as SemanticBlock | null;
        if (String(otherwise) !== "null") {
          deepest = Math.max(deepest, this.boundDepth(otherwise as SemanticBlock, depth));
        }
      } else if (statement.k === "block") {
        deepest = Math.max(deepest, this.boundDepth(fieldOf(statement, "body") as SemanticBlock, depth));
      }
    }
    return deepest;
  }

  /**
   * Whether a loop holds its bound for as long as it runs, which is what a
   * bound in a register of its own is for.
   *
   * A bound the program wrote out is the same number on every turn, and the
   * instruction that compares against it takes it as an operand of its own, so
   * it is not held at all. A bound the body writes is read again at the header
   * instead, and a loop that counts in whole numbers compares against it with
   * a memory operand, which is one instruction as well.
   */
  private holdsBound(loop: Extract<SemanticLoop, { kind: "counted" }>): boolean {
    const type = fieldOf(loop, "type") as SemanticType;
    const to = fieldOf(loop, "to") as SemanticValue;
    if (!isFloatType(type)) return false;
    if (this.literalOf(to, type) !== null) return false;
    return !this.reread(loop, to);
  }

  /**
   * The registers a counter of one of this function's loops may be read as an
   * index out of, or none where no loop counts by whole ones over a double.
   *
   * One is enough for a program that counts one loop at a time, and a second for
   * one that nests them: a loop inside a loop has both counters live at once, and
   * an inner counter read through the outer's register would be an address built
   * from the wrong number.
   */
  private reserveIndexRegisters(taken: ReadonlySet<number>): number[] {
    const deepest = this.indexDepth(fieldOf(this.fn, "entry") as SemanticBlock, 0);
    if (deepest === 0) return [];
    const free = [3, 12, 13, 14].filter((register) => !taken.has(register));
    return free.slice(0, Math.min(deepest, INDEX_REGISTERS));
  }

  /** How many index counters are open at once in a body. */
  private indexDepth(body: SemanticBlock, depth: number): number {
    let deepest = depth;
    for (const statement of fieldOf(body, "statements") as readonly SemanticStatement[]) {
      if (statement.k === "loop") {
        const loop = fieldOf(statement, "loop") as SemanticLoop;
        if (loop.kind === "counted" &&
            isFloatType(fieldOf(loop, "type") as SemanticType) &&
            wholeLiteral(fieldOf(loop, "from") as SemanticValue) !== null &&
            !writesCounter(fieldOf(loop, "body") as SemanticBlock, String(fieldOf(loop, "variable")))) {
          deepest = Math.max(deepest, depth + 1);
        }
        deepest = Math.max(deepest, this.indexDepth(fieldOf(loop, "body") as SemanticBlock, depth + 1));
        continue;
      }
      for (const inner of statementBlocksOf(statement)) {
        deepest = Math.max(deepest, this.indexDepth(inner, depth));
      }
    }
    return deepest;
  }

  /**
   * The registers the weight and the step of a loop the lowering weights are
   * held in, two for every such loop that is open at once.
   *
   * The shape is asked of `weightedPlan`, the same pass that rewrites the loop,
   * so the registers are kept for exactly the loops that will want them. A loop
   * inside another that is also weighted needs its own pair: the outer weight is
   * still being stepped while the inner loop turns.
   */
  private reserveWeightedRegisters(taken: ReadonlySet<number>): number[] {
    const deepest = this.weightedDepth(fieldOf(this.fn, "entry") as SemanticBlock, 0);
    if (deepest === 0) return [];
    const free = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15].filter((register) => !taken.has(register));
    return free.slice(Math.max(free.length - Math.min(deepest * 2, free.length), 0));
  }

  /** How many weighted loops are open at once in a body. */
  private weightedDepth(body: SemanticBlock, depth: number): number {
    let deepest = depth;
    for (const statement of fieldOf(body, "statements") as readonly SemanticStatement[]) {
      if (statement.k === "loop") {
        const loop = fieldOf(statement, "loop") as SemanticLoop;
        if (loop.kind === "counted" && this.weightedPlan(loop) !== null) {
          deepest = Math.max(deepest, depth + 1);
        }
        deepest = Math.max(deepest, this.weightedDepth(fieldOf(loop, "body") as SemanticBlock, depth + 1));
        continue;
      }
      for (const inner of statementBlocksOf(statement)) {
        deepest = Math.max(deepest, this.weightedDepth(inner, depth));
      }
    }
    return deepest;
  }

  /** One of the registers kept above, or null when none is left. */
  private takeWeightedVector(): number | null {
    const register = this.spareWeighted.pop();
    return register === undefined ? null : register;
  }

  /** One of the registers above, given back to whatever needs one next. */
  private giveSpareVector(register: number): void {
    // A register that is already free is here twice only if a value was freed
    // twice, and two values in one register is a program that computes one of
    // them out of the other.
    if (!this.spareVectors.includes(register)) this.spareVectors.push(register);
  }

  private bind(name: string, type: SemanticType, index: number | null = null): Held {
    const emitted = this.names.declare(name, type);
    // The register a name was given is recorded under the name the source wrote
    // it as. Where a loop declares the name a second time the declaration is
    // written as another name, and the register the first one was given is
    // where the second one is read out of — the two counters are written one
    // after the other and the first is dead before the second is bound, which
    // is what the allocator established when it gave the name one register.
    const register = this.pinned.get(emitted) ?? this.pinned.get(name) ?? null;
    // A pinned value is in a register and never in the frame, so the frame slot
    // that reads and writes go through is not reserved: its distance is zero,
    // which is the first slot's own address, and it is never read — every use of
    // a held value goes through `load`, `store` or `scratchFrom`, and those
    // three read the register.
    const offset = register === null ? this.reserve(frameBytes(type)) : 0;
    this.heldCount += 1;
    const held = new Held(this.heldCount, offset, type, index, null, register);
    this.slots.set(emitted, held);
    return held;
  }

  private slot(name: string): Held {
    const emitted = this.names.read(name);
    const found = this.slots.get(emitted);
    if (found === undefined) throw machineError(`${String(fieldOf(this.fn, "symbol"))} reads ${name}, which it does not declare`);
    return found;
  }

  /**
   * A slot the lowering binds for itself, of the type it holds, which is free
   * again when the statement that bound it has been written. A value of a
   * float is held in a register where one has been given this function, and in
   * the frame otherwise.
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
    const held = this.reserveSlot(type, prefix, true, null, undefined);
    this.borrowed.push(held);
    return held;
  }

  /**
   * A slot the statement being written has to have whatever else it does, which
   * is what a value written past the end of the expression it belongs to asks
   * for: an argument parked beside the frame while the arguments after it are
   * read, and the value `Math.round` keeps beside what it rounds.
   */
  private holdSlot(type: SemanticType, prefix: string): Held {
    const held = this.reserveSlot(type, prefix, false, null, undefined);
    this.borrowed.push(held);
    return held;
  }

  /**
   * A slot that outlives the statement that bound it. A loop's bound and its
   * step are read before the body and never inside it, but the body is written
   * between the two, so these are handed back by hand rather than at the end
   * of the statement the loop is. A value read on every turn of a loop outlives
   * every call the body makes, so these are in the frame whatever the statement
   * the loop is.
   */
  private holdAcross(type: SemanticType, prefix: string): Held {
    return this.reserveSlot(type, prefix, false, null, undefined);
  }

  private reserveSlot(
    type: SemanticType,
    prefix: string,
    borrowable: boolean,
    register: number | null = null,
    named?: string,
  ): Held {
    this.temporaries += 1;
    // A name the caller reserved is the one the slot is read by: the IR the
    // caller wrote holds it, and reserving it again would spell the slot by
    // another name than the one the IR reads.
    const name = named ?? this.names.reserve(`${prefix}_${this.temporaries}`);
    // A wide number is carried in four registers of its own and is written from
    // those rather than from the accumulator, so there is nothing here to hold
    // it in.
    const where =
      register ?? (borrowable && isFloatType(type) && !isWideType(type) ? this.takeSpareVector() : null);
    // A value in a register is not in the frame, so the slot that reads and
    // writes go through it is not reserved: its distance is zero, which is the
    // first slot's own address, and it is never read.
    const need = Math.max(frameBytes(type), 8);
    const spare = where === null ? this.spareSlots.findIndex((slot) => slot.bytes >= need) : -1;
    const offset =
      where !== null ? 0 : spare >= 0 ? (fieldOf(this.spareSlots.splice(spare, 1)[0], "offset") as number) : this.reserve(need);
    this.heldCount += 1;
    const held = new Held(this.heldCount, offset, type, null, null, where);
    this.slots.set(name, held);
    return held;
  }

  /**
   * Hands one slot back, so that the next statement that needs one takes it.
   * Only the slots a statement bound for itself are handed back, and only once
   * the statement that bound them has been written. A value held in a register
   * hands the register back rather than the slot, which is still there and is
   * what the next statement that wants a frame slot will take.
   */
  private freeSlot(held: Held): void {
    const register = fieldOf(held, "register");
    if (String(register) === "null") {
      const offset = fieldOf(held, "offset") as number;
      const type = fieldOf(held, "type") as SemanticType;
      this.spareSlots.push({ offset, bytes: Math.max(frameBytes(type), 8) });
    } else {
      this.giveSpareVector(register as number);
    }
  }

  /**
   * Hands back every slot bound since the mark, so that the next statement
   * that needs one takes it. The slots go back in the order the frame grew in,
   * so the ones nearest the top of it are handed out again first.
   */
  private freeSlotsSince(mark: number): void {
    for (let at = this.borrowed.length - 1; at >= mark; at -= 1) this.freeSlot(this.borrowed[at]);
    this.borrowed.length = mark;
    // A slot handed back here goes to whatever needs one next, and no
    // instruction written says so. It used to be that this had to take the note
    // about the accumulator with it, because what said which value a slot held
    // was where it sat in the frame and the next slot to take that place held
    // another. What says it now is the identity on the note: the value that was
    // handed back is not the value the next slot is given, so a note naming it
    // is never read again and has nothing to be wrong about. Keeping it is what
    // lets `let whole = a + b` be followed by a read of `whole` that is no
    // instruction at all.
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

  /**
   * The count of elements an array binding holds, so a fill of the name is
   * written over the same number, or null where the binding says none.
   *
   * An array is bound three ways here, as it is in C: with the values written
   * out, whose count the IR knows; with the count the program settled on when
   * it runs, which is read once here; and as the name of an array it is again,
   * whose count is the one that name holds. A binding of nothing else is a
   * pointer turned, and a count it does not say is one a fill cannot be
   * written over.
   */
  private boundElementsOf(value: SemanticValue): bigint | Held | null {
    if (value.k !== "buffer") {
      // A name holds the count it was bound with whatever the array it holds is
      // spelled as: a slice and an array are both a pointer and a length here,
      // which is why the C backend declares a `_length` beside either.
      if (value.k === "local" && isSequence(value.type)) {
        return this.arrayCounts.get(this.names.read(value.name)) ?? null;
      }
      return null;
    }
    const length = fieldOf(value, "length");
    if (String(length) !== "null") return BigInt(length as number);
    const count = fieldOf(value, "count");
    if (String(count) !== "null") return this.heldElements(count as SemanticValue);
    const values = fieldOf(value, "values") as readonly unknown[];
    return values.length === 0 ? null : BigInt(values.length);
  }

  /** The count a name is bound with, kept against the name the target reads it as. */
  private rememberElements(name: string, count: bigint | Held | null): void {
    const emitted = this.names.read(name);
    if (count === null) this.arrayCounts.delete(emitted);
    else this.arrayCounts.set(emitted, count);
  }

  /** Whether a value is a window of another block, and not a block of its own. */
  private isView(value: SemanticValue): boolean {
    if (value.k === "buffer") return String(fieldOf(value, "view")) !== "null";
    if (value.k === "local" && isSequence(fieldOf(value, "type") as SemanticType)) {
      return this.views.has(this.names.read(String(fieldOf(value, "name"))));
    }
    return false;
  }

  /** Whether a name holds a window, which is what its length cannot be read from. */
  private rememberView(name: string, value: SemanticValue): void {
    const emitted = this.names.read(name);
    if (this.isView(value)) this.views.add(emitted);
    else this.views.delete(emitted);
  }

  /**
   * The length a sequence argument is handed over with, which is the hidden
   * parameter that follows the pointer in the callee's convention.
   *
   * Three forms settle the count, the same three the C backend settles it in:
   * a parameter of this function answers with the length it was handed, an
   * array this function bound answers with the count it was bound with, and a
   * value that names either answers with theirs. A sequence none of the three
   * settles is refused, and the function is lowered by the C backend, which
   * carries every length as an argument of its own.
   */
  private lengthArgument(value: SemanticValue): Held {
    if (value.k === "local") {
      const hidden = this.arrayParamLengths.get(value.name);
      if (hidden !== undefined) return this.slot(hidden);
    }
    const count = this.boundElementsOf(value);
    if (count === null) {
      throw machineError(
        `${String(fieldOf(this.fn, "symbol"))} hands over an array whose length it cannot settle`,
        "an array argument carries its length beside it, and the C backend carries it as an argument",
      );
    }
    // A count written out is laid down the way the C backend writes it: a
    // whole number of its own, in the slot the call reads it out of.
    if (typeof count === "bigint") {
      this.at({ k: "const", type: USIZE, text: count.toString() }, USIZE);
      const held = this.hold(USIZE, "blaze_length");
      this.store(held);
      return held;
    }
    return count;
  }

  private heldElements(count: SemanticValue): Held {
    this.countAsSize(count);
    const held = this.holdAcross(USIZE, "blaze_count");
    this.store(held);
    return held;
  }

  /**
   * Every element of an array written as one value, as `a.fill(x)` is.
   *
   * The count the walk is over is the one the name was bound with — the
   * binding read it and kept it for exactly this — and the write is the same
   * one a `setElement` is: the value is read once for the whole walk, and the
   * address of an element is the buffer moved by the index at the width of an
   * element, which is what `lea` is. The index is a counter of this function's
   * own, stepped in the frame: a fill is where a program puts a value into an
   * array once, not a hot turn, so the two instructions a frame index costs on
   * a turn cost less than the register a walk of one would take from the rest
   * of the function.
   *
   * The value the walk writes is the value the statement names: one argument
   * to one call of the walk, not one per element the C form writes it as, and
   * a value that is a call is made once the source says it is.
   */
  private fill(statement: Extract<SemanticStatement, { k: "fill" }>): void {
    const buffer = this.slot(statement.buffer);
    const count = this.arrayCounts.get(this.names.read(statement.buffer));
    if (count === undefined) {
      throw machineError(
        `${String(fieldOf(this.fn, "symbol"))} fills ${statement.buffer}, which it binds with no count of its own`,
        "the count of an array is settled where the array is bound: a fill of a name the binding does not count is not one this backend writes",
      );
    }
    const element = statement.type;
    const written = this.hold(element, "blaze_fill");
    // The value is read once, at the type the elements are written at: a fill
    // writes one value into every element of the array.
    this.at(statement.value, element);
    this.store(written);
    // The accumulator note is a claim about the register, and the address
    // arithmetic the walk takes it through is a claim nothing backs: it is
    // read back out of the frame again rather than believed.
    this.accumulatorNote = null;
    const index = this.holdAcross(USIZE, "blaze_fill_index");
    this.code.movRegImm(RAX, 0n);
    this.store(index);
    const test = this.code.label("Ltest");
    this.code.jmp(test);
    const body = this.code.label("Lfill");
    this.code.bind(body);
    const bufferRegister = fieldOf(buffer, "register");
    if (String(bufferRegister) === "null") this.code.movRegMem(RCX, frame(fieldOf(buffer, "offset") as number));
    else this.code.movRegReg(RCX, bufferRegister as number);
    this.load(index);
    this.code.lea(RCX, indexed(RCX, RAX, widthOf(element)));
    this.load(written);
    this.storeInto(element, RCX);
    this.accumulatorNote = null;
    // The index is stepped before the test, the way every loop of this
    // lowering counts: the first turn runs at zero and the one after it at the
    // next number, and the test is where the walk comes back to.
    this.load(index);
    this.code.aluImm("add", RAX, 1);
    this.store(index);
    this.code.bind(test);
    this.load(index);
    if (typeof count === "bigint") {
      this.code.movRegImm(RCX, count);
      this.code.alu("cmp", RAX, RCX);
    } else if (String(fieldOf(count, "register")) === "null") {
      this.code.aluRegMem("cmp", RAX, frame(fieldOf(count, "offset") as number), true);
    } else {
      this.code.alu("cmp", RAX, fieldOf(count, "register") as number);
    }
    this.code.jcc("b", body);
    this.freeSlot(index);
  }

  /**
   * A bound a loop holds for as long as it runs, in a register of its own, or
   * null where there is no register free for it.
   *
   * The register is one the convention asks a callee to leave alone, so the
   * calls the body makes do not take it, and it is held for the length of the
   * loop and given back at the end of it.
   */
  private heldBound(type: SemanticType, value: SemanticValue): Held | null {
    const register = this.spareBounds.pop() ?? null;
    if (register === null) return null;
    this.at(value, type);
    const held = this.reserveSlot(type, "blaze_to", false, register, undefined);
    this.store(held);
    return held;
  }

  /* ---------------------------------------------------------------------- */
  /* The function itself                                                    */
  /* ---------------------------------------------------------------------- */

  /**
   * Puts the values a body reaches for again in registers instead of in the frame.
   *
   * Which names those are, and which register each one gets, is answered by
   * `liveness.ts` and not by counting: a census of reads says how often a name
   * is reached for and nothing about *when*, and where a value is live is what
   * says whether two names can share a register and whether a call takes it
   * away. So each name is given the runs of the body it is live over, and two
   * names whose runs never meet are put in the same register — which is what
   * lifts the cap a fixed list puts on how many names a function can hold.
   *
   * Which register depends on what a call does to the name. One that has to
   * still be there after a call can only be kept in a register the convention
   * says a callee leaves as it found it, and that costs the function a push and
   * a pop and sixteen bytes of stack. One no call reaches can be kept in a
   * register that costs nothing, because nothing is written over it between the
   * two places the value is read. So the two lists are filled independently —
   * `[7, 6, 8, 9, 10, 11]` first for a name nothing calls, `[3, 12, 13, 14]` for one
   * something does — and a float is pinned out of the vector file rather than
   * the general one, which is a register file of its own.
   *
   * How many times a name is read still decides which name gets a register
   * first, but only as a weight: a read in a loop body is carried out once for
   * every turn of that loop and a read at the top of the body once however many
   * turns it turns, so a read is weighed by how many loops enclose the block it
   * is in. A name the weight says is worth more than the register costs is
   * given one; the ones that are not stay in the frame, where a load or a
   * store is what the lowering says they cost.
   *
   * A counted loop's counter is decided below rather than here: it is written
   * and read by the loop itself on every turn, so it is the one name whose
   * weight is not in question.
   */
  private allocateRegisters(): void {
    const reads = new Map<string, number>();
    const writes = new Map<string, number>();
    const declared: { name: string; type: SemanticType }[] = (fieldOf(this.fn, "params") as readonly SemanticSlot[]).map((parameter) => ({
      name: String(fieldOf(parameter, "name")),
      type: slotType(parameter),
    }));
    const write = (name: string, weight: number): void => {
      writes.set(name, (writes.get(name) ?? 0) + weight);
    };
    const read = (name: string, weight: number): void => {
      reads.set(name, (reads.get(name) ?? 0) + weight);
    };
    // A function that calls itself runs its own body once per level of the
    // recursion, so a read on a straight line through it is still a read
    // carried out many times — worth here what a read inside a loop is worth
    // in a function that calls nothing. `checksum` reads its one parameter
    // three times, which is below the threshold on a straight line and above
    // it in the function that is called once per node of the tree it walks.
    const calls = fieldOf(this.fn, "calls") as readonly SemanticFunction["calls"][number][];
    const fnName = String(fieldOf(this.fn, "name"));
    const recursed = calls.some((edge) => String(fieldOf(edge, "callee")) === fnName) ? 1 : 0;
    for (const entry of everyBlockAtDepth(fieldOf(this.fn, "entry") as SemanticBlock, 0, [])) {
      const block = fieldOf(entry, "block") as SemanticBlock;
      const depth = fieldOf(entry, "depth") as number;
      const weight = READ_WEIGHT[Math.min(depth + recursed, READ_WEIGHT.length - 1)];
      for (const statement of fieldOf(block, "statements") as readonly SemanticStatement[]) {
        const statementName = String(fieldOf(statement, "name"));
        if (statement.k === "set" || statement.k === "step") write(statementName, weight);
        // A compound assignment reads what the name holds as well as writing
        // what it is given, and the read is a read of the name: an accumulator
        // that is added to on every turn of a loop is reached for as often as
        // anything else there, and the frame round trip of keeping it there is
        // a load and a store on every turn.
        if (statement.k === "set" && String(fieldOf(statement, "op")) !== "=") read(statementName, weight);
        if (statement.k === "step") read(statementName, weight);
        if (statement.k === "setElement") {
          // The buffer of a write is named rather than valued, so a census of
          // the values the body computes never sees it read. Writing an element
          // changes what the pointer reaches and not the pointer itself, so it
          // is a read of the name rather than a write of it.
          const buffer = String(fieldOf(statement, "buffer"));
          reads.set(buffer, (reads.get(buffer) ?? 0) + weight);
        }
        if (statement.k === "fill") {
          // A fill is every element written at once, and the pointer it writes
          // through is read on every turn of the walk it is, which is a read
          // the census counts here the way a write of one element counts it.
          const buffer = String(fieldOf(statement, "buffer"));
          reads.set(buffer, (reads.get(buffer) ?? 0) + weight);
        }
      }
      for (const value of everyValue(block, [])) {
        if (value.k === "local") {
          const name = String(fieldOf(value, "name"));
          reads.set(name, (reads.get(name) ?? 0) + weight);
        }
      }
    }
    // Every name the body declares, and how many declarations spell it. A name
    // declared once is bound once and read under the spelling the source gave
    // it, so the register this pass gives it is the register the lowering reads
    // it by. A name declared twice is two names under one spelling — the second
    // escaping to another — so which register either is in cannot be said from
    // here, and neither of them is a candidate.
    const declarationCount = new Map<string, number>();
    const loopDeclared = new Set<string>();
    const declare = (name: string): void => {
      declarationCount.set(name, (declarationCount.get(name) ?? 0) + 1);
    };
    for (const parameter of fieldOf(this.fn, "params") as readonly SemanticSlot[]) declare(String(fieldOf(parameter, "name")));
    for (const entry of everyBlockAtDepth(fieldOf(this.fn, "entry") as SemanticBlock, 0, [])) {
      const block = fieldOf(entry, "block") as SemanticBlock;
      for (const statement of fieldOf(block, "statements") as readonly SemanticStatement[]) {
        if (statement.k === "let") {
          declare(String(fieldOf(fieldOf(statement, "slot"), "name")));
        } else if (statement.k === "loop") {
          const loop = fieldOf(statement, "loop") as SemanticLoop;
          const kind = String(fieldOf(loop, "kind"));
          if (kind === "counted") {
            const variable = String(fieldOf(loop, "variable"));
            declare(variable);
            loopDeclared.add(variable);
          } else if (kind === "each") {
            const index = String(fieldOf(loop, "index"));
            const element = String(fieldOf(loop, "element"));
            declare(index);
            declare(element);
            loopDeclared.add(index);
            loopDeclared.add(element);
          }
        }
      }
    }
    // A name a loop declares is the counter path's to decide about, and a name
    // declared inside a loop body is an accumulator as often as anything else:
    // `let sum = 0` written inside a loop and added to on every turn of it is
    // the commonest one there is, and it was left in the frame because only the
    // top of the body was looked at.
    for (const entry of everyBlockAtDepth(fieldOf(this.fn, "entry") as SemanticBlock, 0, [])) {
      const block = fieldOf(entry, "block") as SemanticBlock;
      for (const statement of fieldOf(block, "statements") as readonly SemanticStatement[]) {
        if (statement.k !== "let") continue;
        const slot = fieldOf(statement, "slot") as SemanticSlot;
        const name = String(fieldOf(slot, "name"));
        if (loopDeclared.has(name)) continue;
        declared.push({ name, type: slotType(slot) });
      }
    }
    // What a name is worth a register for is what it costs the frame: every
    // read and every write it is reached for is a memory operand, and a
    // register turns each of them into a move between registers instead.
    //
    // A name a loop writes counts its writes as well as its reads, because an
    // accumulator is read and written on every turn and both were frame
    // accesses. One written on a straight line counts too: what it used to be
    // given instead of a register was the answer that where a value is live
    // cannot be said without solving for it, which `liveness.ts` does.
    const score = (name: string): number => (reads.get(name) ?? 0) + (writes.get(name) ?? 0);
    const candidates = declared
      .map((entry) => ({ entry, score: score(entry.name) }))
      .filter((candidate) => candidate.score > 0 && declarationCount.get(candidate.entry.name) === 1 && !candidate.entry.name.startsWith("blaze_limb_"))
      .sort((left, right) => right.score - left.score);

    this.pinnedRegisters = [];
    this.pinnedVectors = [];
    this.callSaves = [];
    // Where every name is live, and what a call does to it. A name no call
    // reaches can be kept in a register the convention does not ask a callee to
    // preserve, which costs the function nothing; one that has to survive a
    // call has to be in one that does, which costs a push and a pop.
    // A loop written as a team of threads is a call into the runtime, and so is
    // a loop marked for a region: it opens and closes one around the body, and
    // both are calls. The graph is told which statements those are rather than
    // left to read the loop as a loop, which is what it would otherwise see.
    const liveness = nameLiveness(
      fieldOf(this.fn, "entry") as SemanticBlock,
      (fieldOf(this.fn, "params") as readonly SemanticSlot[]).map((parameter) => String(fieldOf(parameter, "name"))),
      (statement) => {
        const loop = fieldOf(statement, "loop") as SemanticLoop;
        const kind = String(fieldOf(loop, "kind"));
        return statement.k === "loop" &&
          (kind === "counted" || kind === "each") &&
          (this.teamed.has(loop) || String(fieldOf(loop, "region")) === "true");
      },
      // A rounding is written here as instructions rather than as a call, so a
      // name live across one of them is live across arithmetic and not across
      // a callee writing over the registers the convention does not preserve.
      (callee) => !isInlineBuiltin(callee),
    );
    // The register each parameter arrives in, and the ones the parameters after
    // it arrive in. The prologue moves a parameter out of the register it
    // arrives in and into the one it was allocated, one parameter after another,
    // so a parameter may not be given a register another parameter has not been
    // read out of yet: the move that reads it would read what the first move
    // wrote. A parameter's own arrival register is the exception, because it is
    // where its value already is and nothing is moved at all.
    const arrivals = this.arrivals();
    const arrivalOf = new Map<string, number | null>();
    const laterArrivals = new Map<string, Set<number>>();
    for (const [at, parameter] of (fieldOf(this.fn, "params") as readonly SemanticSlot[]).entries()) {
      const parameterName = String(fieldOf(parameter, "name"));
      const arrival = arrivals[at];
      arrivalOf.set(parameterName, arrival === undefined ? null : fieldOf(arrival, "register") as number | null);
      const after = new Set<number>();
      for (let later = at + 1; later < arrivals.length; later += 1) {
        const laterArrival = arrivals[later];
        const register = laterArrival === undefined ? null : fieldOf(laterArrival, "register") as number | null;
        if (String(register) !== "null") after.add(register as number);
      }
      laterArrivals.set(parameterName, after);
    }
    const taken = new Map<number, (readonly [number, number])[]>();
    const claim = (register: number, live: readonly (readonly [number, number])[]): void => {
      const found = taken.get(register);
      if (found === undefined) taken.set(register, [...live]);
      else found.push(...live);
    };
    // The registers this function's counters are read out of as whole numbers,
    // taken before any name is weighed. A counter is stepped and read on every
    // turn of its loop, and a buffer is read as the base of an element the
    // counter names: a function with several of both had all four preserved
    // registers given to the buffers and its counters left in the frame,
    // converted on every element they reached.
    const reserved = new Set<number>();
    for (const register of this.reserveIndexRegisters(new Set(this.pinned.values()))) {
      reserved.add(register);
      this.pinnedRegisters.push(register);
      this.spareIndexes.push(register);
    }
    // A loop this pass will weight keeps two vector registers for its weight and
    // its step, taken before any name is weighed for the same reason the
    // counters are: a register a name already holds is one the weight would have
    // to share or go without, and going without is a store and a load per turn.
    const weighted = new Set<number>();
    for (const register of this.reserveWeightedRegisters(new Set([...this.pinned.values(), ...reserved]))) {
      weighted.add(register);
      reserved.add(register);
      this.pinnedVectors.push({ register, offset: 0, single: false });
      this.spareWeighted.push(register);
    }
    // The first register of a pool that is free over every place the name is
    // live, or null when every one of them is spoken for. Two names whose runs
    // never meet are never both live, so either register will do.
    //
    // A parameter is also kept out of the registers the parameters after it
    // arrive in, and given its own arrival register in preference to any other:
    // that one is where its value already is, so nothing is moved and nothing
    // can be moved over.
    const free = (
      pool: readonly number[],
      live: readonly (readonly [number, number])[],
      name: string,
    ): number | null => {
      const own = arrivalOf.get(name) ?? null;
      const later = laterArrivals.get(name);
      for (const pass of [own === null ? -1 : 0, 1]) {
        for (const register of pool) {
          const wanted = pass === 0 ? register === own : register !== own;
          if (!wanted) continue;
          if (later?.has(register) === true) continue;
          // A register the counters of this function's loops are read out of is
          // spoken for whatever the liveness says, because a pin and an index in
          // one register is two values in one piece of memory.
          if (reserved.has(register)) continue;
          const held = taken.get(register);
          if (held === undefined || !overlaps(held, live)) return register;
        }
      }
      return null;
    };
    /**
     * A name in a register, or null when neither pool has one free over the
     * places it is live.
     *
     * A name a call reaches can only be kept where the callee leaves it alone,
     * because the call writes its arguments into every other one. A name no
     * call reaches is given one of those first, which is free, and only falls
     * back to a preserved one when the free file is spoken for where it is
     * live — a name whose live range is disjoint from that of the names ahead
     * of it shares their register and neither pays for it.
     */
    const assign = (name: string, type: SemanticType): void => {
      // A name a turn reads is left in the frame whatever it would otherwise
      // have been worth a register for. A pinned value lives in this thread's
      // registers and nowhere else — its frame slot is not even reserved, since
      // every read of it goes through the register — and a turn runs on a
      // thread where those registers are not this function's. One layout
      // serves both: the value is in the frame, the turn copies the frame, and
      // the turn reads its copy at the offset the value has here.
      if (this.turnNames.has(name)) return;

      // A wide number is not pinned, and this is where that is decided rather
      // than worked around further down. Everything this function does below is
      // about one register: `pinned` names a single register, the prologue
      // pushes one per pinned name, and a load and a store move one. Handing a
      // wide number one of those would give a thirty-two byte value one
      // register, and the three limbs above the first would be whatever the
      // register's neighbours held — a wrong answer from a build that reported
      // success. It is left in the frame, where all four limbs have somewhere to
      // be.
      //
      // The register file is the other half of the answer, and it is worth
      // stating because the obvious way to give one of these four registers runs
      // out at the first call. `[3, 12, 13, 14]` is `rbx`, `r12`, `r13` and `r14` —
      // four registers, and a wide number is four limbs. One wide name that has to
      // survive a call would therefore take the whole preserved file and leave
      // nothing for any other name that does, so a function holding a wide value
      // and a scalar live across one call could not have both in registers at
      // once. `[7, 6, 8, 9, 10, 11]` has six and would fit one wide name with two to
      // spare, but nothing in it survives a call at all.
      //
      // So there is no pool a wide name can be pinned into that does not cost
      // more than it saves, and it is left in the frame. It is read into
      // `[8, 9, 10, 11]` when an operation needs it and written back when one is done,
      // which is the same traffic a pinned scalar would avoid and is paid once
      // per operation rather than once per access. Pinning one would only be
      // worth it for a name read many times between writes, and the answer to
      // that is to hoist the expression, not to spend the preserved file on one
      // value.
      if (isWideType(type)) return;
      const facts = liveness.get(name);
      if (facts === undefined || facts.live.length === 0) return;
      const live = facts.live;
      const float = isFloatType(type);
      const preserved = float ? [6, 7, 8, 9, 10, 11, 12, 13, 14, 15] : [3, 12, 13, 14];
      const given = float ? [3, 4, 5] : [7, 6, 8, 9, 10, 11];
      const register = facts.acrossCall
        ? free(preserved, live, name)
        : (free(given, live, name) ?? free(preserved, live, name));
      if (register === null) return;
      this.pinned.set(name, register);
      claim(register, live);
      // Only a register the convention asks a callee to preserve is one the
      // prologue has to put somewhere and the epilogue read back. The two files
      // are numbered apart, so which one a register came from is what says it,
      // and not whether its number is in the preserved list.
      if (!preserved.includes(register)) return;
      if (float) this.pinnedVectors.push({ register, offset: 0, single: widthOf(type) === 4 });
      else this.pinnedRegisters.push(register);
    };
    // What a name is worth is what it costs the frame, but what it costs the
    // function is what the register it is put in costs to save: two memory
    // operands of prologue and epilogue for a preserved one, and none at all
    // for one the convention does not ask a callee to preserve. So a preserved
    // register has to be earned and a free one has not.
    const worth = (name: string): number => {
      const facts = liveness.get(name);
      return facts?.acrossCall === true ? PINNING_READS + 1 : 1;
    };
    for (const candidate of candidates) {
      if (candidate.score < worth(candidate.entry.name)) continue;
      assign(candidate.entry.name, candidate.entry.type);
    }
    // A counted loop's counter is written and read by the loop itself on every
    // turn, so it is what a register is worth the most on. Left in the frame it
    // costs a load and a store per turn to hold a value that the next turn
    // reads straight back out again.
    //
    // A float counter is not left out. It takes a vector register, and a
    // preserved vector register is spilled to the frame by the prologue for the
    // eight bytes it costs there and read back by the epilogue: two
    // instructions once for the function, against a load and a store on every
    // turn of the loop. A loop that turns twice never pays that back, which is
    // why it used to be left in the frame, and why a loop that turns a million
    // times was paying for it on every turn instead.
    //
    // A name two loops declare is left out only where the two loops are inside
    // one another: they share the name and would share the register, and the
    // inner one would go on stepping the outer one's counter. Two loops one
    // after the other are the other shape the name is declared twice in, and
    // they are written one after the other too — the first counter is dead
    // before the second is bound — so one register serves both and each turn of
    // each loop steps it where it lies.
    const counters = new Map<string, { depth: number; type: SemanticType; asIndex: boolean; wholly: boolean }>();
    const declarations = new Map<string, number>();
    const shared = new Set<string>();
    const walkCounters = (block: SemanticBlock, depth: number, enclosing: ReadonlySet<string>): void => {
      for (const statement of fieldOf(block, "statements") as readonly SemanticStatement[]) {
        const declare = (name: string, type: SemanticType, asIndex = false, wholly = false): void => {
          declarations.set(name, (declarations.get(name) ?? 0) + 1);
          // A counter inside a loop of the same name is stepped while the
          // outer one is still counting, so the two cannot have one register.
          if (enclosing.has(name)) shared.add(name);
          const found = counters.get(name);
          // Nor can two that count in different types: the register one is
          // given is the register both are read out of.
          if (found !== undefined && !typeEquals(fieldOf(found, "type") as SemanticType, type)) shared.add(name);
          // A name one loop counts as a whole number and another counts as a
          // value is two different counters under one spelling.
          if (found !== undefined && (String(fieldOf(found, "asIndex")) === "true") !== asIndex) shared.add(name);
          // Nor can two of which only one is counted in whole numbers: the one
          // that is has no double beside it and the other has.
          if (found !== undefined && (String(fieldOf(found, "wholly")) === "true") !== wholly) shared.add(name);
          // The inner loop of a nested pair turns the most, so depth is what
          // says which counter is worth a register first.
          const foundDepth = found === undefined ? 0 : Number(fieldOf(found, "depth"));
          counters.set(name, { depth: Math.max(foundDepth, depth), type, asIndex, wholly });
        };
        if (statement.k !== "loop") {
          // A loop in an arm of an `if` is a loop like any other, and the
          // census above counted it: a name this walk did not reach is a name
          // it would answer for the wrong number of declarations.
          for (const inner of statementBlocksOf(statement)) walkCounters(inner, depth, enclosing);
          continue;
        }
        const loop = fieldOf(statement, "loop") as SemanticLoop;
        let inside: Set<string> | null = null;
        if (loop.kind === "counted") {
          // A counter the body reaches only as an index is counted in whole
          // numbers, which is what `counted` writes it as, so giving it a vector
          // register would be a register for a double nothing reads — and a
          // preserved one costs the function a push and a pop for it.
          //
          // Where the loop cannot be counted that way the double is the counter
          // the test compares, and the test reads it on every turn of the loop.
          // That is a value the loop reads as often as anything else, and the
          // frame round trip of keeping it there is a load and a store on every
          // turn of it.
          const variable = String(fieldOf(loop, "variable"));
          const loopType = fieldOf(loop, "type") as SemanticType;
          declare(
            variable,
            loopType,
            isFloatType(loopType) && !readsCounterAsValue(fieldOf(loop, "body") as SemanticBlock, variable),
            countsWholly(loop),
          );
          inside = new Set(enclosing).add(variable);
        } else if (loop.kind === "each") {
          const element = String(fieldOf(loop, "element"));
          declarations.set(element, (declarations.get(element) ?? 0) + 1);
          // A walk over an array steps its index once per turn and reads it
          // twice — once for the address and once for whatever the body does
          // with it — which is the same shape as a counted loop's counter and is
          // given a register for the same reason. Only the index is a candidate:
          // the element is the loop's own value and is written once per turn
          // from whatever the address produced.
          const index = String(fieldOf(loop, "index"));
          declare(index, INDEX);
          inside = new Set(enclosing).add(index);
        }
        walkCounters(fieldOf(loop, "body") as SemanticBlock, depth + 1, inside ?? enclosing);
      }
    };
    walkCounters(fieldOf(this.fn, "entry") as SemanticBlock, 0, new Set());
    // A name anything other than a loop declares is left out as it was: it is
    // two bindings under one spelling, and which register either of them is in
    // cannot be said from here.
    const ordered = [...counters.entries()]
      .filter(([name]) => !shared.has(name) && declarationCount.get(name) === declarations.get(name))
      .sort((left, right) => Number(fieldOf(right[1], "depth")) - Number(fieldOf(left[1], "depth")));
    // A counter nothing reads as a value is not pinned, where the loop is
    // counted in whole numbers. It is written into the whole-number register the
    // loop's index is read out of, so the vector register the general form would
    // give it would hold a double nothing ever reads — and a preserved one costs
    // the function a push and a pop and two memory operands on the way in and
    // out.
    //
    // Where the loop cannot be counted in whole numbers the double is the
    // counter the test compares, and the test reads it on every turn of the
    // loop. A counter the loop reads on every turn is worth a register for the
    // same reason any other is: the frame round trip of keeping it there is a
    // load and a store on every turn, and the load is on the path the loop
    // carries its counter along.
    for (const [name, counter] of ordered) {
      if (String(fieldOf(counter, "asIndex")) === "true" && String(fieldOf(counter, "wholly")) === "true") continue;
      assign(name, fieldOf(counter, "type") as SemanticType);
    }
    // The register an object is filled in is claimed after every name that could
    // be pinned to one, so that a function which builds an object keeps the
    // registers its names are read most often and takes the object register
    // from what is left.
    if (this.fillsObjects()) {
      this.objectRegister = OBJECT_POINTER;
      this.pinnedRegisters.push(OBJECT_POINTER);
    }
    // The registers the values of an expression are held in are taken from what
    // the names have not taken, and they are callee-saved ones: a value held
    // across a call is gone in a register the convention does not preserve, and
    // an expression holds one side while the other side — which may be the call
    // — is written. A function that computes nothing in floats reserves none,
    // which is what keeps the prologue of a small one free of them.
    for (const register of this.reserveTemporaryVectors(new Set([...this.pinned.values(), ...weighted]))) {
      this.pinnedVectors.push({ register, offset: 0, single: false });
      this.spareVectors.push(register);
    }
    // The bounds of the loops are held in registers of their own, and are
    // taken from what the expressions of the body have not taken: a bound is
    // held for as long as its loop runs, and the body borrows its registers one
    // at a time.
    for (const register of this.reserveBoundRegisters(new Set([...this.pinned.values(), ...this.spareVectors, ...weighted]))) {
      this.pinnedVectors.push({ register, offset: 0, single: false });
      this.spareBounds.push(register);
      this.boundRegisters.push(register);
    }
    // The prologue pushes the registers above the frame and the lowering binds
    // its slots from there downwards, so a slot's address does not depend on
    // whether a register was pinned. A vector register has no push and is
    // spilled to a slot of the frame instead, so its slot is reserved here and
    // the pushes are counted as before.
    this.used = this.pinnedRegisters.length * 8;
    // The registers this function keeps values in are saved twice: once by the
    // prologue, which gives the caller's value back, and once beside every
    // foreign call, which writes down what this function holds now.
    const pinned = new Set(this.pinnedVectors.map((saved) => fieldOf(saved, "register") as number));
    for (let at = 0; at < this.pinnedVectors.length; at += 1) {
      const saved = this.pinnedVectors[at];
      const register = fieldOf(saved, "register") as number;
      const single = fieldOf(saved, "single") as boolean;
      const offset = this.reserve(8, 8);
      this.pinnedVectors[at] = { register, offset, single };
      this.callSaves.push({ register, offset: this.reserve(8, 8), single });
    }
    // A call this backend did not build may write every vector register, not
    // only the ones this body uses. The registers it does not use are not
    // touched by anything else here, so a caller may keep a value in one across
    // this call — and the foreign call would overwrite it with no save behind
    // it. A function that can make such a call therefore gives back all ten, as
    // the caller was promised. A function that only calls code this backend
    // built needs none of them: that code saves the ones it uses.
    if (this.makesForeignCall()) {
      for (const register of [6, 7, 8, 9, 10, 11, 12, 13, 14, 15]) {
        if (pinned.has(register)) continue;
        this.pinnedVectors.push({ register, offset: this.reserve(8, 8), single: false });
      }
    }
    // A loop written as a team of threads is a call into the runtime, so a
    // function holding one has a frame to keep aligned whether or not the IR
    // says the body calls anything.
    this.mayCall = this.callsAnything() || this.teamed.size > 0;
  }

  /**
   * Whether the body calls anything, which is what makes the frame's own size
   * the stack's alignment business: a call pushes a return address and every
   * callee assumes the stack it is entered on is sixteen byte aligned, so a
   * frame is a whole number of boundaries out of place. A function that calls
   * nothing has nothing to keep straight.
   */
  private callsAnything(): boolean {
    if (String(fieldOf(this.fn, "allocates")) === "true" ||
        String(fieldOf(this.fn, "prints")) === "true" ||
        String(fieldOf(this.fn, "readsArgv")) === "true") return true;
    for (const block of everyBlock(fieldOf(this.fn, "entry") as SemanticBlock, [])) {
      for (const value of everyValue(block, [])) {
        if (hasCall(value)) return true;
      }
    }
    return false;
  }

  /**
   * Whether this body calls code this backend did not build, which may write
   * every vector register. Allocation, printing and the argument list are the
   * runtime's own calls, and a builtin or an indirect callee the backend does
   * not hold is a call it cannot see inside; a call to one of the program's own
   * functions is one it can, and that function gives back the registers it uses.
   */
  private makesForeignCall(): boolean {
    if (String(fieldOf(this.fn, "allocates")) === "true" ||
        String(fieldOf(this.fn, "prints")) === "true" ||
        String(fieldOf(this.fn, "readsArgv")) === "true") return true;
    for (const block of everyBlock(fieldOf(this.fn, "entry") as SemanticBlock, [])) {
      for (const value of everyValue(block, [])) {
        if (value.k !== "call") continue;
        const call = fieldOf(value, "call") as SemanticCall;
        if (String(fieldOf(call, "builtin")) === "true" || !this.callable.has(String(fieldOf(call, "callee")))) return true;
      }
    }
    return false;
  }

  /**
   * Which loops of this body are written out as a team of threads, and which
   * names that puts in the frame.
   *
   * This runs before the registers are handed out because handing a name a
   * register decides where its value lives, and a turn reads the frame this
   * function lays out rather than the registers this thread happens to hold.
   * A name a turn reads is therefore told to the allocator first, as a name
   * that is staying in the frame.
   *
   * A loop inside a loop that is already a team is left alone whatever it
   * carries: it is written inside a turn, where the range is one thread's and
   * a second fan-out inside it has nothing measured to say it pays.
   */
  private planTeams(): void {
    const visit = (block: SemanticBlock, inside: boolean): void => {
      for (const statement of fieldOf(block, "statements") as readonly SemanticStatement[]) {
        if (statement.k === "loop") {
          const loop = fieldOf(statement, "loop") as SemanticLoop;
          const team = inside ? null : this.teamFor(loop);
          if (team !== null) {
            this.teamed.add(team);
            // Everything the turn reads that is not its own is in the frame:
            // the reads of the loops written inside it are on this list too,
            // because a name read inside them is read inside this one — and
            // the names they declare are not, which is what leaves a turn's
            // own accumulator and counter worth a register.
            for (const name of namesAViewReads(loop)) this.turnNames.add(name);
          }
          visit(fieldOf(loop, "body") as SemanticBlock, inside || team !== null);
          continue;
        }
        if (statement.k === "if") {
          visit(fieldOf(statement, "then") as SemanticBlock, inside);
          const otherwise = fieldOf(statement, "otherwise") as SemanticBlock | null;
          if (String(otherwise) !== "null") visit(otherwise as SemanticBlock, inside);
          continue;
        }
        if (statement.k === "block") visit(fieldOf(statement, "body") as SemanticBlock, inside);
      }
    };
    visit(fieldOf(this.fn, "entry") as SemanticBlock, false);
  }


  /**
   * Why this loop's turns are run on a team of threads here rather than one
   * after another, or null when they are not.
   *
   * The mark on the loop says the turns do not depend on each other; it does
   * not say this backend can start threads, and starting them costs something
   * a loop with little in a turn never earns back. So a loop is written as a
   * team only where this backend can run one correctly and where the turn is
   * worth the cost. Every refusal below leaves the loop running in order,
   * which is the same program and what this backend already wrote.
   */
  private teamFor(loop: SemanticLoop): TeamedLoop | null {
    const kind = String(fieldOf(loop, "kind"));
    if (kind !== "counted" && kind !== "each") return null;
    if (String(fieldOf(loop, "parallel")) !== "true") return null;
    const body = fieldOf(loop, "body") as SemanticBlock;
    if (turnIsTooCheap(body)) return null;
    // An accumulator the turns combine is one number every turn writes, and
    // combining it wants a slot per thread and a pass over them afterwards.
    // The loops that reduce are the ones this backend already writes a whole
    // vector at a time, so those are left to that.
    if (((fieldOf(loop, "reductions") as readonly unknown[] | undefined) ?? []).length > 0) return null;
    // A turn that returns leaves the function from inside a thread of the
    // team, which is not what returning from the function means.
    if (returnsFromItsBody(body)) return null;
    // The turn counts in halves a runtime hands it as whole numbers, so a
    // counter narrower than that would be asked to compare a bound it cannot
    // hold.
    const type = fieldOf(loop, "type") as SemanticType;
    if (kind === "counted" && (!isInteger(type) || widthOf(type) !== 8)) return null;
    return loop as TeamedLoop;
  }

  emit(): Uint8Array {
    // Which loops are written as teams is settled before the registers are
    // handed out, because a name a turn reads may not be given one: a turn runs
    // on a thread where this thread's registers mean nothing.
    this.planTeams();
    this.allocateRegisters();
    // A pinned value is in a register the convention says a callee leaves as it
    // found it, so the register is pushed here and popped there. The pushes are
    // above the frame rather than in it, which is what leaves a slot at the
    // same distance from the stack pointer whatever was pinned.
    for (const register of this.pinnedRegisters) this.code.push(register);
    const frameAt = this.code.subRegImmLater(RSP);
    // A vector register has no push and is spilled into the frame, which is
    // written after the frame is taken because that is the stack pointer the
    // slot's address is written against.
    for (const saved of this.pinnedVectors) {
      this.code.saveVector(
        fieldOf(saved, "register") as number,
        fieldOf(saved, "offset") as number,
        fieldOf(saved, "single") as boolean,
      );
    }
    this.parameters();
    // The body opens a scope of its own, and the parameters are read in it, so
    // they are declared one scope further out.
    this.names.enter();
    this.block(this.fn.entry);
    this.code.bind(this.epilogue);
    // A wide answer is copied to where the caller said it wanted it before the
    // frame is given back, because the pointer to that place was read out of
    // `rdi` on entry and the body has had every use of `rdi` since.
    this.returnWide();
    const bytes = this.frameBytes();
    this.code.epilogue(this.pinnedRegisters, this.pinnedVectors, bytes);
    // An argument that arrived on the stack is above the return address, which
    // is above the pushes, which are above the frame: how far above the stack
    // pointer it is is a function of a frame nothing had read when the address
    // was written, so it is filled in now the frame is settled.
    for (const argument of this.incoming) {
      this.code.patchDisp(
        fieldOf(argument, "index") as number,
        bytes + this.pinnedRegisters.length * 8 + (fieldOf(argument, "at") as number),
      );
    }
    if (bytes > 0) this.code.patchWord(frameAt, bytes);
    // A function the body turned out to give no frame to writes no `sub` for
    // it: the instruction was written before the body was read, because the
    // frame is as large as what the body reserved.
    else this.code.unwriteSub(frameAt);
    // The turns go after the epilogue, which is where the runtime can call
    // them: they are functions of their own, entered by address rather than by
    // falling into them from the code above.
    this.writeTurns();
    return this.code.finish();
  }

  /**
   * The four limbs of a wide answer, copied to where the caller said it wanted
   * them.
   *
   * The address is read back into `rcx` rather than left in a slot through the
   * copy, because four reads of a slot is four reads of the same address where
   * one register holding it is one read and three register-to-memory moves.
   */
  private returnWide(): void {
    if (this.wideResult === null || this.wideSret === null) return;
    this.wideLoad(this.wideResult);
    this.code.movRegMemSized(RCX, frame(fieldOf(this.wideSret, "offset") as number), 8, false);
    for (let limb = 0; limb < this.limbsOf(fieldOf(this.fn, "returns") as SemanticType); limb += 1) {
      this.code.movMemRegSized(mem(RCX, limb * LIMB_BYTES), [8, 9, 10, 11][limb], 8);
    }
  }

  /**
   * The frame, in eight byte steps and, where a call is made, with the stack
   * left the sixteen byte aligned every callee is assumed to be entered on.
   *
   * A function is entered eight bytes off a boundary, because the call that
   * reached it pushed a return address, and a call inside it wants that back.
   * So what the prologue moves the stack down by — the pushes and the frame
   * together — is a number eight bytes off a whole number of boundaries, and
   * the frame is what is left of that number once the pushes are spoken for.
   * Which costs up to eight bytes a function whose frame lands on a boundary,
   * against the four instructions a frame pointer costs every call of it.
   */
  private frameBytes(): number {
    const pushed = this.pinnedRegisters.length * 8;
    const below = pushed + this.used;
    if (!this.mayCall) return Math.ceil(below / 8) * 8;
    return 8 + 16 * Math.ceil((below - 8) / 16) - pushed;
  }

  /**
   * The address `at` bytes above the return address, which is where an argument
   * that arrived on the stack sits: the return address is the first word above
   * where the stack pointer stood on entry, so the first argument past the
   * registers is eight bytes above it.
   *
   * It is the one address in a function that cannot be written as it is
   * written: what is above the return address is a function of how large a
   * frame the body goes on to reserve, and nothing has read that yet. So the
   * displacement is written as the four byte form and left for `emit` to fill
   * in, and the index recorded here is what that patch is given by.
   */
  private stackArgument(at: number): Memory {
    this.incoming.push({ index: this.code.deferDisp(), at });
    return mem(RSP, 0);
  }

  /**
   * Where each parameter arrives: the register it is handed in, or null where it
   * is handed on the stack above the return address.
   *
   * The register allocation needs this before the prologue is written, because
   * a parameter given a register is moved there from the one it arrives in —
   * and a move into a register another parameter has not been read out of yet
   * destroys that argument.
   */
  private arrivals(): { register: number | null; stack: number; limbs: number }[] {
    // A wide answer is returned through memory, and the pointer to where it goes
    // arrives in `rdi` ahead of every other argument — which is why `parameters`
    // takes `rdi` out of the file before it binds anything. The count below has
    // to start past it as well: a first parameter read from `rdi` is the
    // pointer, so the body works on the address of its own answer as though it
    // were the number it was handed.
    let general = isWideType(this.fn.returns) ? 1 : 0;
    let floating = 0;
    let stack = 0;
    // Whether the registers have run out, which is not the same question as
    // whether anything has gone on the stack. The two came apart when a wide
    // number arrived: one is handed over in memory because it is too big for the
    // register file, and the other because there was nowhere left to put it. Only
    // the second means that everything after it is in memory too, and conflating
    // the two put every argument after a wide number on the stack, where the
    // convention hands those in registers exactly as it otherwise would.
    let exhausted = false;
    return (fieldOf(this.fn, "params") as readonly SemanticSlot[]).map((parameter) => {
      const type = slotType(parameter);
      // A wide number is thirty-two bytes, which is more than the register file
      // has to spare for one argument, and the convention's answer to a value of
      // that size is to hand it over on the stack, in four eight-byte slots.
      //
      // It starts on a sixteen byte boundary, because a value that size is what
      // the convention aligns most strictly and a slot is skipped to give it one.
      if (isWideType(type)) {
        if (stack % 2 !== 0) stack += 1;
        const here = stack;
        stack += this.limbsOf(type);
        return { register: null, stack: here, limbs: this.limbsOf(type) };
      }
      const register =
        exhausted ? undefined : isFloatType(type) ? SSE_ARGUMENTS[floating] : INTEGER_ARGUMENTS[general];
      if (register === undefined) {
        exhausted = true;
        const here = stack;
        stack += 1;
        return { register: null, stack: here, limbs: 1 };
      }
      if (isFloatType(type)) floating += 1;
      else general += 1;
      return { register, stack: -1, limbs: 1 };
    });
  }
  /**
   * The arguments as they arrive: the first six whole numbers and the first
   * eight floats come in registers, and the rest are on the stack above the
   * return address.
   */
  private parameters(): void {
    // A wide answer is returned through memory, and the pointer to where it goes
    // arrives in `rdi` ahead of every other argument, so it is taken out of the
    // register the body is about to use for something else.
    if (isWideType(fieldOf(this.fn, "returns") as SemanticType)) {
      this.wideResult = this.reserveSlot(fieldOf(this.fn, "returns") as SemanticType, "blaze_wide_result", false, null, undefined);
      this.wideSret = this.reserveSlot(POINTER, "blaze_wide_sret", false, null, undefined);
      this.code.movMemRegSized(frame(fieldOf(this.wideSret, "offset") as number), RDI, 8);
    }
    const arrivals = this.arrivals();
    for (const [at, parameter] of (fieldOf(this.fn, "params") as readonly SemanticSlot[]).entries()) {
      const arrival = arrivals[at];
      if (arrival === undefined) {
        throw machineError(`${String(fieldOf(this.fn, "symbol"))} has an argument the convention hands in nowhere`);
      }
      const type = slotType(parameter);
      const held = this.bind(String(fieldOf(parameter, "name")), type);
      const offset = fieldOf(held, "offset") as number;
      const heldRegister = fieldOf(held, "register") as number | null;
      const heldId = fieldOf(held, "id") as number;
      const register = fieldOf(arrival, "register") as number | null;
      const stack = fieldOf(arrival, "stack") as number;
      const limbs = fieldOf(arrival, "limbs") as number;
      if (String(heldRegister) !== "null") {
        // A parameter that is pinned is in a register from here on, so the frame
        // copy it would otherwise be written to is not made. It arrives in an
        // argument register or on the stack, and either is one move into the
        // register it is pinned to — which is no move at all where it was given
        // the register it arrived in, which is what it is given whenever that
        // register is one the allocation was free to use.
        if (String(register) === "null") {
          const argument = this.stackArgument(8 + stack * 8);
          if (isFloatType(type)) this.code.movsLoad(heldRegister as number, argument, widthOf(type) === 4);
          else this.code.movRegMem(heldRegister as number, argument);
          continue;
        }
        if (String(heldRegister) === String(register)) continue;
        if (isFloatType(type)) this.code.movsMove(heldRegister as number, register as number, widthOf(type) === 4);
        else this.code.movRegReg(heldRegister as number, register as number);
        continue;
      }
      if (String(register) === "null" && isWideType(type)) {
        // A wide argument arrives as four consecutive words above the return
        // address, and each of them is copied into the limb of the slot that
        // reads at that place. The words are read one at a time through the
        // accumulator rather than as one copy, because the slot is thirty-two
        // bytes and there is no instruction that moves thirty-two bytes from one
        // place to another.
        for (let limb = 0; limb < limbs; limb += 1) {
          this.code.movRegMemSized(RAX, this.stackArgument(8 + (stack + limb) * 8), 8, false);
          this.code.movMemRegSized(this.limbOf(offset, limb), RAX, 8);
        }
        continue;
      }
      if (String(register) === "null") {
        // An argument of a class that has run out of registers is on the stack
        // above the return address, and so is every argument after it.
        this.code.movRegMem(RAX, this.stackArgument(8 + stack * 8));
        this.code.movMemRegSized(frame(offset), RAX, widthOf(type));
        continue;
      }
      this.code.movMemRegSized(frame(offset), register as number, widthOf(type));
      // The first float argument arrives in the accumulator itself, so writing
      // it down leaves the accumulator holding what the slot holds — which is
      // what the first read of that parameter is answered by.
      if (isFloatType(type)) {
        this.code.movsStore(frame(offset), register as number, widthOf(type) === 4);
        if (register === XMM0) this.accumulatorNote = { id: heldId, at: this.code.written };
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* The accumulator and the frame                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * The accumulator holding the value a slot has — or already holding it, which
   * is a load this answers without writing one.
   *
   * Every value the body computes passes through the accumulator, and nothing
   * between a store and the load that reads the same slot moves it: a store
   * writes the accumulator down without taking it away. So the slot whose value
   * the accumulator holds is kept beside where the code was when it last did,
   * and a load is one instruction shorter whenever the slot is the one asked
   * for and no instruction has been written since. What says the accumulator
   * still holds it is that second half: an instruction that took the
   * accumulator moved the code on, so a fact recorded against a place in the
   * code cannot be read at a later one.
   */
  private load(held: Held): void {
    const id = fieldOf(held, "id") as number;
    const register = fieldOf(held, "register") as number | null;
    const type = fieldOf(held, "type") as SemanticType;
    const offset = fieldOf(held, "offset") as number;
    const accumulator = this.accumulatorNote;
    if (accumulator !== null &&
        (fieldOf(accumulator, "id") as number) === id &&
        (fieldOf(accumulator, "at") as number) === this.code.written) return;
    if (String(register) !== "null") {
      if (isFloatType(type)) this.code.movsMove(XMM0, register as number, widthOf(type) === 4);
      else this.code.movRegReg(RAX, register as number);
      this.accumulatorNote = { id, at: this.code.written };
      return;
    }
    if (isFloatType(type)) {
      this.code.movsLoad(XMM0, frame(offset), widthOf(type) === 4);
    } else {
      this.code.movRegMemSized(RAX, frame(offset), widthOf(type), signedOf(type));
    }
    this.accumulatorNote = { id, at: this.code.written };
  }

  /**
   * The value the accumulator has, written at the address a register holds.
   * The displacement is the offset of a field in the object that address
   * points at, so a write to a field is one instruction rather than a move
   * of the address, an addition to it, and the write.
   */
  private storeInto(type: SemanticType, address: number, displacement = 0): void {
    this.storeAt(type, mem(address, displacement));
  }

  /**
   * The value the accumulator has, written at an address the instruction
   * carries. The displacement is the offset of a field in the object that
   * address points at, which is what makes a write to a field one instruction
   * rather than a move of the address, an addition to it, and the write.
   */
  private storeAt(type: SemanticType, where: Memory): void {
    if (isFloatType(type)) {
      this.code.movsStore(where, XMM0, widthOf(type) === 4);
      return;
    }
    this.code.movMemRegSized(where, RAX, widthOf(type));
  }

  /**
   * A shift by a number written out, over a value the build gave a register of
   * its own, written in that register.
   *
   * The accumulator is where a whole number is read and written through, so a
   * shift over a name that has a register of its own was two moves and a shift
   * where a shift is the same number. The carry a limb arithmetic hands the next
   * limb is that shape: `carry = sum >> 24` over a `sum` in a register was a
   * load, a shift and a store, and the load and the store are the moves the
   * register makes unnecessary.
   *
   * The value being shifted has to be at the width the whole is read at, or the
   * shift would be of a narrower number: a slot holds what it was declared at,
   * and a read written at another width converts on the way out of it.
   */
  private shiftInPlace(value: SemanticValue, target: Held): boolean {
    if (value.k !== "arith") return false;
    const op = String(fieldOf(value, "op"));
    if (op !== "shl" && op !== "shr" && op !== "ushr") return false;
    const type = fieldOf(target, "type") as SemanticType;
    if (isFloatType(type) || isWideType(type)) return false;
    const left = fieldOf(value, "left") as SemanticValue;
    if (left.k !== "local") return false;
    const places = this.immediateOf(fieldOf(value, "right") as SemanticValue, type);
    if (places === null) return false;
    const held = this.slot(String(fieldOf(left, "name")));
    const register = fieldOf(held, "register");
    if (String(register) === "null") return false;
    if (widthOf(fieldOf(held, "type") as SemanticType) !== widthOf(type)) return false;
    const wide = operationWidth(type) === 8;
    this.code.shiftImm(shiftOf(op, type), register as number, places & (wide ? 63 : 31), wide);
    this.storeFrom(target, register as number);
    return true;
  }

  /**
   * A slot holding the value the accumulator has.
   *
   * Writing the accumulator down does not take it away, so what it holds is
   * still what it held — which is what lets the load of that same slot after it
   * be answered rather than written.
   */
  private store(held: Held): void {
    const register = fieldOf(held, "register") as number | null;
    const type = fieldOf(held, "type") as SemanticType;
    const offset = fieldOf(held, "offset") as number;
    const id = fieldOf(held, "id") as number;
    if (String(register) !== "null") {
      if (isFloatType(type)) this.code.movsMove(register as number, XMM0, widthOf(type) === 4);
      else this.code.movRegReg(register as number, RAX);
      this.accumulatorNote = { id, at: this.code.written };
      return;
    }
    if (isFloatType(type)) {
      this.code.movsStore(frame(offset), XMM0, widthOf(type) === 4);
    } else {
      this.code.movMemRegSized(frame(offset), RAX, widthOf(type));
    }
    // Writing the accumulator down does not take it away, so what it holds is
    // still what it held — which is what lets the load of that same slot after
    // it be answered rather than written.
    //
    // The note is only left where the slot holds the whole of what the
    // accumulator has. A slot narrower than the accumulator holds the low half
    // of it, and reading it back would widen it again, so the accumulator after
    // the read is not the accumulator before it.
    if (widthOf(type) === 8 && !isWideType(type)) {
      this.accumulatorNote = { id, at: this.code.written };
    }
  }

  /**
   * A value the accumulator is not in, written into the slot a name is held in.
   *
   * A value normally arrives in the accumulator and a store moves it from
   * there. A shift over a name the build gave a register of its own is written
   * in that register instead, and this is what writes the answer of one into
   * the slot the assignment names without the pair of moves through the
   * accumulator.
   *
   * The accumulator's note is dropped rather than kept where the value lands in
   * the frame: the register it is written from does not hold what the note says
   * the accumulator holds, and a note that says otherwise is a read that never
   * loads. Where the name has a register of its own the value is in that
   * register, and `load` reads it out of there whatever the note says.
   */
  private storeFrom(held: Held, register: number): void {
    const heldRegister = fieldOf(held, "register") as number | null;
    const type = fieldOf(held, "type") as SemanticType;
    const offset = fieldOf(held, "offset") as number;
    if (String(heldRegister) !== "null") {
      if (heldRegister === register) return;
      if (isFloatType(type)) this.code.movsMove(heldRegister as number, register, widthOf(type) === 4);
      else this.code.movRegReg(heldRegister as number, register);
      return;
    }
    if (isFloatType(type)) this.code.movsStore(frame(offset), register, widthOf(type) === 4);
    else this.code.movMemRegSized(frame(offset), register, widthOf(type));
    this.accumulatorNote = null;
  }

  /**
   * The value at the address the accumulator has, read as the type it is.
   * The displacement is the offset of a field in the object that address
   * points at, which is how a read of a field is one instruction rather than
   * an addition to the address and then the read.
   */
  private readAt(type: SemanticType, displacement = 0): void {
    this.readFrom(type, mem(RAX, displacement));
  }

  /**
   * The value at an address the instruction carries, read as the type it is
   * read at. The address is the pair the read itself takes rather than one put
   * together in the accumulator beforehand, so an element whose buffer and
   * index are both in registers is read without a register written at all.
   */
  private readFrom(type: SemanticType, where: Memory): void {
    if (isFloatType(type)) {
      this.code.movsLoad(XMM0, where, widthOf(type) === 4);
      return;
    }
    this.code.movRegMemSized(RAX, where, widthOf(type), signedOf(type));
  }

  /** The accumulator widened to the width and sign of the type it is read as. */
  private normalize(type: SemanticType): void {
    if (isFloatType(type) || isWideType(type) || widthOf(type) === 8) return;
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
  private normalizeArithmetic(type: SemanticType, register = RAX): void {
    if (isFloatType(type) || widthOf(type) === 8) return;
    if (widthOf(type) === 4 && !signedOf(type)) return;
    this.code.narrow(register, register, widthOf(type), signedOf(type));
  }

  /** The scratch register holding what the accumulator has. */
  private toScratch(type: SemanticType): void {
    if (isFloatType(type)) {
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
    const register = fieldOf(held, "register") as number | null;
    const type = fieldOf(held, "type") as SemanticType;
    const offset = fieldOf(held, "offset") as number;
    if (String(register) !== "null") {
      if (isFloatType(type)) this.code.movsMove(XMM1, register as number, widthOf(type) === 4);
      else this.code.movRegReg(RCX, register as number);
      return;
    }
    if (isFloatType(type)) {
      this.code.movsLoad(XMM1, frame(offset), widthOf(type) === 4);
      return;
    }
    this.code.movRegMem(RCX, frame(offset));
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
    const statements = fieldOf(block, "statements") as readonly SemanticStatement[];
    for (let at = 0; at < statements.length; at += 1) {
      const statement = statements[at];
      const next = statements[at + 1];
      // A `let chunk = Math.floor(X / powers[idx])` followed by an `if` that
      // tests whether `chunk` is odd is just "bit `idx` of `X` is set" when
      // `powers` is a power-of-two array: a shift replaces the divide and its
      // rounding. The `let` and the `if` are replaced together.
      if (next !== undefined && this.tryPowerOfTwoBitTest(statement, next)) {
        at += 1;
        continue;
      }
      this.statement(statement);
    }
    this.freeSlotsSince(mark);
    for (const name of fieldOf(block, "releases") as readonly string[]) this.release(name);
    const terminator = fieldOf(block, "terminator") as SemanticTerminator;
    this.terminator(terminator);
    // A block that leaves for another one has written the jump that does it,
    // and that jump is not one the lowering laid out to reach whatever comes
    // next here.
    if (terminator.k === "jump") this.code.sealJump();
    this.names.leave();
  }

  /**
   * The dividend of one power-of-two division, and the element it is divided
   * by, when one is present. `Math.floor(X / powers[idx])` where `powers` is a
   * parameter known to hold `2 ** i` at index `i`.
   */
  private powerOfTwoDivFloor(
    value: SemanticValue,
  ): { readonly value: SemanticValue; readonly index: SemanticValue & { k: "local" }; readonly paramName: string } | null {
    if (value.k !== "call") return null;
    const call = fieldOf(value, "call") as SemanticCall;
    if (String(fieldOf(call, "callee")) !== "Math.floor") return null;
    const args = fieldOf(call, "args") as readonly SemanticValue[];
    if (args.length !== 1) return null;
    const div = args[0];
    if (div.k !== "arith" || String(fieldOf(div, "op")) !== "div") return null;
    // Division is not commutative: the divisor is the element read from the
    // power-of-two array, and the dividend is everything else.
    const right = fieldOf(div, "right") as SemanticValue;
    if (right.k !== "element") return null;
    const element = right;
    const of = fieldOf(element, "of") as SemanticValue;
    const index = fieldOf(element, "index") as SemanticValue;
    if (of.k !== "local" || index.k !== "local") return null;
    return {
      value: fieldOf(div, "left") as SemanticValue,
      index: index as SemanticValue & { k: "local" },
      paramName: String(fieldOf(of, "name")),
    };
  }

  /**
   * Whether one condition tests whether exactly one local `chunk` is odd:
   * `chunk - Math.floor(chunk / 2) * 2 === 1`, with `chunk` read once on each
   * side of the subtraction.
   */
  private ifTestsOddness(condition: SemanticValue, chunk: string): boolean {
    if (condition.k !== "compare" || String(fieldOf(condition, "op")) !== "eq") return false;
    const left = fieldOf(condition, "left") as SemanticValue;
    const right = fieldOf(condition, "right") as SemanticValue;
    if (right.k !== "const" || Number(fieldOf(right, "text")) !== 1) return false;
    if (left.k !== "arith" || String(fieldOf(left, "op")) !== "sub") return false;
    const leftLeft = fieldOf(left, "left") as SemanticValue;
    if (leftLeft.k !== "local" || String(fieldOf(leftLeft, "name")) !== chunk) return false;
    const mul = fieldOf(left, "right") as SemanticValue;
    if (mul.k !== "arith" || String(fieldOf(mul, "op")) !== "mul") return false;
    const mulLeft = fieldOf(mul, "left") as SemanticValue;
    const mulRight = fieldOf(mul, "right") as SemanticValue;
    const floorDiv = mulLeft.k === "call" ? mulLeft : mulRight.k === "call" ? mulRight : null;
    if (floorDiv === null || floorDiv.k !== "call") return false;
    const call = fieldOf(floorDiv, "call") as SemanticCall;
    if (String(fieldOf(call, "callee")) !== "Math.floor") return false;
    const floorArgs = fieldOf(call, "args") as readonly SemanticValue[];
    if (floorArgs.length !== 1) return false;
    const innerDiv = floorArgs[0];
    if (innerDiv.k !== "arith" || String(fieldOf(innerDiv, "op")) !== "div") return false;
    const innerDivLeft = fieldOf(innerDiv, "left") as SemanticValue;
    const innerDivRight = fieldOf(innerDiv, "right") as SemanticValue;
    const innerLeft = innerDivLeft.k === "local" ? innerDivLeft : null;
    const innerRight = innerDivRight.k === "local" ? innerDivRight : null;
    const chunkRead = innerLeft !== null && String(fieldOf(innerLeft, "name")) === chunk ? innerLeft : innerRight;
    if (chunkRead === null || String(fieldOf(chunkRead, "name")) !== chunk) return false;
    const two = innerLeft === chunkRead ? innerDivRight : innerDivLeft;
    if (two.k !== "const" || Number(fieldOf(two, "text")) !== 2) return false;
    const other = mulLeft === floorDiv ? mulRight : mulLeft;
    if (other.k !== "const" || Number(fieldOf(other, "text")) !== 2) return false;
    return true;
  }

  /**
   * How many times a local name is read as a value anywhere in the function,
   * nested blocks included.
   */
  private localReads(name: string): number {
    let count = 0;
    const walk = (block: SemanticBlock): void => {
      for (const statement of fieldOf(block, "statements") as readonly SemanticStatement[]) {
        for (const value of statementValues(statement)) {
          walkValues(value, (one) => {
            if (one.k === "local" && String(fieldOf(one, "name")) === name) count += 1;
          });
        }
        for (const nested of statementBlocksOf(statement)) walk(nested);
      }
      const terminator = fieldOf(block, "terminator") as SemanticTerminator;
      if (terminator.k === "return" && String(fieldOf(terminator, "value")) !== "null") {
        walkValues(fieldOf(terminator, "value") as SemanticValue, (one) => {
          if (one.k === "local" && String(fieldOf(one, "name")) === name) count += 1;
        });
      }
    };
    walk(fieldOf(this.fn, "entry") as SemanticBlock);
    return count;
  }

  /**
   * Whether one `let` followed by one `if` is a power-of-two division whose
   * quotient is only ever tested for oddness, and if so writes the equivalent
   * bit test in place of them.
   *
   * `chunk = Math.floor(X / powers[idx])` then `chunk - floor(chunk / 2) * 2
   * === 1` is `bit idx of X is set` whenever `powers[idx] === 2 ** idx`. The
   * divide and its floor become an integer shift right by `idx` and a test of
   * the low bit.
   */
  private tryPowerOfTwoBitTest(statement: SemanticStatement, next: SemanticStatement): boolean {
    if (statement.k !== "let" || next.k !== "if") return false;
    const div = this.powerOfTwoDivFloor(statement.value);
    if (div === null) return false;
    const param = (fieldOf(this.fn, "params") as readonly SemanticSlot[]).find(
      (p, position) => String(fieldOf(p, "kind")) === "value" &&
        String(fieldOf(p, "name")) === div.paramName &&
        this.poTParams.has(position),
    );
    if (param === undefined) return false;
    // The shift count has to be a whole-number counter this function keeps in
    // a register of its own; a counter held as a double in the frame cannot be
    // used as a shift count here.
    const shift = this.counterRegisters.get(String(fieldOf(div.index, "name")));
    if (shift === undefined) return false;
    const chunk = String(fieldOf(fieldOf(statement, "slot"), "name"));
    const nextCondition = fieldOf(next, "condition") as SemanticValue;
    if (!this.ifTestsOddness(nextCondition, chunk)) return false;
    // `chunk` may only be read inside this condition: the strength reduction
    // never writes `chunk` as a number anywhere, so any other read would
    // observe a value that was never computed.
    if (this.localReads(chunk) !== 2) return false;
    const otherwise = this.code.label("Lelse");
    const end = this.code.label("Lend");
    this.at(div.value, NUMBER);
    this.code.cvtFloatToInt(RAX, XMM0, false, true);
    this.code.movRegReg(RDX, RAX);
    this.code.movRegReg(RCX, shift);
    this.code.shift("sar", RDX, true);
    this.code.testImm(RDX, 1, true);
    // Bit clear means the condition is false: leave for the `otherwise` arm, or
    // for the end of the statement when there is no other arm.
    const nextThen = fieldOf(next, "then") as SemanticBlock;
    const nextOtherwise = fieldOf(next, "otherwise") as SemanticBlock | null;
    this.code.jcc("e", String(nextOtherwise) === "null" ? end : otherwise);
    // The accumulator no longer holds anything meaningful past the test.
    this.accumulatorNote = null;
    this.block(nextThen);
    if (String(nextOtherwise) !== "null") {
      const otherwiseBlock = nextOtherwise as SemanticBlock;
      if (String(fieldOf(fieldOf(nextThen, "terminator"), "k")) === "next") this.code.jmp(end);
      this.code.bind(otherwise);
      this.block(otherwiseBlock);
    }
    this.code.bind(end);
    return true;
  }

  private statement(statement: SemanticStatement): void {
    // The values an expression writes for itself are read inside that same
    // expression and nowhere else, so they are handed back when the statement
    // that wrote them is done rather than at the end of the block. That is what
    // keeps a block of ten statements needing one register rather than ten.
    const mark = this.borrowed.length;
    this.writeStatement(statement);
    this.freeSlotsSince(mark);
  }

  private writeStatement(statement: SemanticStatement): void {
    switch (statement.k) {
      case "let": {
        const slot = fieldOf(statement, "slot") as SemanticSlot;
        const value = fieldOf(statement, "value") as SemanticValue;
        const name = String(fieldOf(slot, "name"));
        const type = slotType(slot);
        const boxed = String(fieldOf(slot, "kind")) === "text" && String(fieldOf(slot, "boxed")) === "true";
        if (boxed) this.boxedTexts.add(name);
        if (boxed) {
          // Allocate a shared cell holding the text pointer, store the initial
          // value into it, and bind the local to the cell pointer.
          this.at(value, type);
          const valueSlot = this.hold(type, "blaze_boxed_value");
          this.store(valueSlot);
          this.code.movRegImm(RDI, 8n);
          this.runtime("_allocate");
          const cellSlot = this.hold(POINTER, "blaze_boxed_cell");
          this.store(cellSlot);
          this.load(valueSlot);
          this.code.movRegMem(RCX, frame(fieldOf(cellSlot, "offset") as number));
          this.code.movMemRegSized(mem(RCX, 0), RAX, 8);
          const held = this.bind(name, type);
          this.load(cellSlot);
          this.store(held);
          this.freeSlot(valueSlot);
          this.freeSlot(cellSlot);
          return;
        }
        if (String(fieldOf(slot, "kind")) === "buffer") {
          // The count a name holds is read out of the value the name is bound
          // with, before the pointer is: a fill of the name is written over
          // the count it was bound with, and reading it after the pointer
          // would still be the same number. The C driver writes both in this
          // order too.
          const count = this.boundElementsOf(value);
          this.value(value);
          const bound = this.bind(name, type);
          this.store(bound);
          this.rememberElements(name, count);
          this.rememberView(name, value);
          return;
        }
        // A wide number is not in the accumulator, so it is written down from
        // the working registers rather than from `rax`.
        if (isWideType(type)) {
          // A binding whose value reads the name it is about to declare — a
          // `let x = x` that shadows an outer x — is written before the name
          // is declared, because the read is the outer one. Every other
          // binding is declared first, which is what lets the kernel write its
          // answer into the slot rather than into a temporary.
          if (this.reads(value, name)) {
            this.wideValue(value);
            this.wideStore(this.bind(name, type));
            return;
          }
          this.wideBind(name, this.bind(name, type), value);
          return;
        }
        this.at(value, type);
        const held = this.bind(name, type);
        if (name.startsWith("blaze_limb_")) {
          this.accumulatorNote = { id: fieldOf(held, "id") as number, at: this.code.written };
          return;
        }
        this.store(held);
        if (isSequence(type)) this.rememberView(name, value);
        return;
      }
      case "set": {
        const name = String(fieldOf(statement, "name"));
        const op = String(fieldOf(statement, "op"));
        const value = fieldOf(statement, "value") as SemanticValue;
        const held = this.slot(name);
        const type = fieldOf(held, "type") as SemanticType;
        // A name that holds an array and is bound again is bound with the
        // count the new value holds — the same question a binding asks,
        // because a fill written after this one walks the array as it is now.
        if (isSequence(type)) {
          this.rememberElements(
            name,
            op === "=" ? this.boundElementsOf(value) : null,
          );
          if (op === "=") this.rememberView(name, value);
          else this.views.delete(this.names.read(name));
        }
        if (isWideType(type)) {
          this.wideBind(name, held, value);
          return;
        }
        this.assign(name, op, value);
        return;
      }
      case "setElement": {
        const value = fieldOf(statement, "value") as SemanticValue;
        const index = fieldOf(statement, "index") as SemanticValue;
        const op = String(fieldOf(statement, "op"));
        const buffer = this.slot(String(fieldOf(statement, "buffer")));
        const bufferType = fieldOf(buffer, "type") as SemanticType;
        const isDynamic = bufferType.kind === "ref" && bufferType.of === null;
        if (isDynamic) {
          this.value(value);
          this.code.movsMove(XMM2, XMM0, false);
          this.at(index, USIZE);
          this.code.movRegReg(RDI, RAX);
          this.code.movMemRegSized(frame(fieldOf(buffer, "offset") as number), RSI, 8);
          // value in XMM2 -> move to XMM1 (second double arg) ... actually convention: first arg XMM0, second XMM1
          this.code.movsMove(XMM1, XMM2, false);
          this.code.movsLoad(XMM0, frame(fieldOf(buffer, "offset") as number), false);
          this.runtime("_array_set");
          return;
        }
        const element = elementTypeOf(bufferType) ?? (fieldOf(value, "type") as SemanticType);
        // A write of a value the program computed is the one write whose value
        // is finished before its address is needed, so the two can be written in
        // that order and the address can be the pair the write itself carries.
        // A compound write reads what the element holds first, which is the
        // other order, so it keeps the general form below.
        if (op === "=") {
          this.at(value, element);
          const where = this.elementAddress(String(fieldOf(statement, "buffer")), index, element);
          if (where !== null) {
            this.storeAt(element, where);
            return;
          }
          const written = this.hold(element, "blaze_element");
          this.store(written);
          // The address is left in the accumulator and written down, because
          // the value it is for is in a slot the loading of it takes the
          // accumulator back from.
          this.addressOf(String(fieldOf(statement, "buffer")), index, element);
          const place = this.hold(POINTER, "blaze_place");
          this.store(place);
          this.load(written);
          this.code.movRegMem(RCX, frame(fieldOf(place, "offset") as number));
          this.storeInto(element, RCX);
          return;
        }
        const place = this.hold(POINTER, "blaze_place");
        this.at(value, element);
        const written = this.hold(element, "blaze_element");
        this.store(written);
        // The address is read twice here — once for what the element holds and
        // once for the write — so it is put together in the accumulator and
        // written down rather than carried by the instruction that reads it.
        this.builtAddress(String(fieldOf(statement, "buffer")), index, element);
        this.store(place);
        // The element is read *through* the address the write goes to, not out
        // of the slot the address is kept in: the slot holds the address, and
        // reading it as the element read the address as the old value, so
        // `a[i] += 1` wrote the one and not the sum.
        this.code.movRegMem(RAX, frame(fieldOf(place, "offset") as number));
        this.readAt(element);
        const read = this.hold(element, "blaze_read");
        this.store(read);
        if (op === "**=") {
          // The old value is in `read` and the new one is in `written`: a
          // power is the libm call the two sides of an arith of it take,
          // spelled out exactly as the binary form is.
          this.load(written);
          const right = this.hold(element, "blaze_right");
          this.store(right);
          this.load(read);
          this.scratchFrom(right);
          this.library("pow");
          this.normalizeArithmetic(element);
          this.code.movRegMem(RCX, frame(fieldOf(place, "offset") as number));
          this.storeInto(element, RCX);
          return;
        }
        this.load(written);
        this.toScratch(element);
        this.load(read);
        this.apply(COMPOUND[op.slice(0, -1)], element);
        this.normalizeArithmetic(element);
        this.code.movRegMem(RCX, frame(fieldOf(place, "offset") as number));
        this.storeInto(element, RCX);
        return;
      }
      case "step": {
        // A name the build gave a register of its own is stepped where it lies,
        // the way a counted loop steps its counter. Copying it through the
        // accumulator to add one and write it back is two instructions that
        // produce the same register.
        const target = this.slot(String(fieldOf(statement, "name")));
        const targetType = fieldOf(target, "type") as SemanticType;
        const register = fieldOf(target, "register") as number | null;
        if (String(register) === "null") this.load(target);
        this.one(targetType, String(fieldOf(statement, "op")) === "++" ? "add" : "sub", register ?? RAX);
        this.normalizeArithmetic(targetType, register ?? RAX);
        if (String(register) === "null") this.store(target);
        return;
      }
      case "printText":
        this.printText(statement.value);
        return;
      case "printNumber": {
        const value = fieldOf(statement, "value") as SemanticValue;
        // A whole number is printed from the integer it is. The formatter the
        // floating numbers use takes a double, and a double holds every whole
        // number only up to 2^53 — so the bigint literal 9007199254740993 came
        // out as 9007199254740992. The C backend already wrote the digits of an
        // integer rather than handing it over; this is the same answer here.
        const type = fieldOf(value, "type") as SemanticType;
        if (isWideType(type)) {
          // A wide number is printed in hexadecimal, most significant limb
          // first, by the runtime's u256 hex formatter. The limbs are spilled
          // to a slot and its address is passed.
          this.wideValue(value);
          const slot = this.hold(type, "blaze_print_wide");
          this.wideStore(slot);
          this.code.leaMemReg(mem(RSP, fieldOf(slot, "offset") as number), RDI);
          this.library("blaze_rt_print_u256_hex");
          this.freeSlot(slot);
          return;
        }
        if (isNumber(type) && isInteger(type)) {
          // A whole number narrower than a word is widened to one first, which
          // is exact and leaves the digits it always had.
          this.at(value, widthOf(type) === 8 ? type : I64);
          this.code.movRegReg(RDI, RAX);
          this.code.movRegImm(RSI, String(fieldOf(statement, "bigint")) === "true" ? 1n : 0n);
          this.runtime("_print_whole");
          return;
        }
        this.at(value, NUMBER);
        this.runtime("_print_number");
        return;
      }
      case "printNewline":
        this.runtime("_print_newline");
        return;
      case "retain":
        this.value(fieldOf(statement, "value") as SemanticValue);
        this.code.movRegReg(RDI, RAX);
        this.runtime("_retain");
        return;
      case "raise":
        this.value(fieldOf(statement, "message") as SemanticValue);
        this.code.movRegReg(RDI, RAX);
        this.runtime("_raise");
        return;
      case "call": {
        const call = fieldOf(statement, "call") as SemanticCall;
        if (String(fieldOf(call, "callee")) === "http.serve") {
          this.httpServe(call);
          return;
        }
        this.callValue(call, null);
        return;
      }
      case "storeField":
        this.storeField(
          fieldOf(statement, "object") as SemanticValue,
          String(fieldOf(statement, "layout")),
          String(fieldOf(statement, "field")),
          fieldOf(statement, "value") as SemanticValue,
        );
        return;
      case "if": {
        const otherwise = this.code.label("Lelse");
        const end = this.code.label("Lend");
        // With no other arm there is nothing at `otherwise` to reach: the arm
        // that is not taken is the end of the statement itself, so the branch
        // goes there and no jump over the other arm is written at all. What
        // that jump used to be was five bytes moving zero.
        const condition = fieldOf(statement, "condition") as SemanticValue;
        const thenBlock = fieldOf(statement, "then") as SemanticBlock;
        const otherwiseBlock = fieldOf(statement, "otherwise") as SemanticBlock | null;
        this.truthBranch(condition, false, String(otherwiseBlock) === "null" ? end : otherwise);
        this.block(thenBlock);
        if (String(otherwiseBlock) !== "null") {
          // An arm that returns or leaves for another block never comes back
          // here, so the jump over the other arm is written only when the arm
          // does fall out of the end of it.
          if (String(fieldOf(fieldOf(thenBlock, "terminator"), "k")) === "next") this.code.jmp(end);
          this.code.bind(otherwise);
          this.block(otherwiseBlock as SemanticBlock);
        }
        this.code.bind(end);
        return;
      }
      case "block":
        this.block(fieldOf(statement, "body") as SemanticBlock);
        return;
      case "loop":
        this.loop(fieldOf(statement, "loop") as SemanticLoop);
        return;
      case "fill":
        this.fill(statement);
        return;
    }
  }

  /** A name given a value, or one changed by the operator it was written with. */
  private assign(name: string, op: string, value: SemanticValue): void {
    const target = this.slot(name);
    const targetType = fieldOf(target, "type") as SemanticType;
    const targetRegister = fieldOf(target, "register") as number | null;
    const boxed = isTextType(targetType) && this.boxedTexts.has(name);
    // A string grows: `+=` is a new value rather than an addition in place, and
    // two addresses added together are not a string.
    if (op === "+=" && isTextType(targetType)) {
      this.concat({ k: "local", type: TEXT, name }, value, targetType);
      if (boxed) {
        const valueSlot = this.hold(targetType, "blaze_boxed_value");
        this.store(valueSlot);
        const cellSlot = this.hold(POINTER, "blaze_boxed_cell");
        this.load(target);
        this.store(cellSlot);
        this.load(valueSlot);
        this.code.movRegMem(RCX, frame(fieldOf(cellSlot, "offset") as number));
        this.code.movMemRegSized(mem(RCX, 0), RAX, 8);
        this.freeSlot(valueSlot);
        this.freeSlot(cellSlot);
      } else {
        this.store(target);
      }
      return;
    }
    if (op === "=" && boxed) {
      this.at(value, targetType);
      const valueSlot = this.hold(targetType, "blaze_boxed_value");
      this.store(valueSlot);
      const cellSlot = this.hold(POINTER, "blaze_boxed_cell");
      this.load(target);
      this.store(cellSlot);
      this.load(valueSlot);
      this.code.movRegMem(RCX, frame(fieldOf(cellSlot, "offset") as number));
      this.code.movMemRegSized(mem(RCX, 0), RAX, 8);
      this.freeSlot(valueSlot);
      this.freeSlot(cellSlot);
      return;
    }
    if (op === "=") {
      if (this.copyBetween(value, target)) return;
      // A number written out goes into the register the name has of its own
      // rather than through the accumulator, which is one instruction rather
      // than the pair. A name the build gave a register of its own is a value
      // read on every turn of a loop as often as anything else — `borrow` is
      // one, and the eleven limbs of a modular subtraction assign it twice each.
      if (value.k === "const" && isFloatType(targetType) && String(targetRegister) !== "null" && !isWideType(targetType)) {
        this.floatConstant(Number(decimalText(value.text)), targetType, targetRegister as number);
        return;
      }
      // The same is true of an integer written out: a constant already fits in
      // an immediate the instruction carries, so a held register takes it
      // directly rather than through the accumulator and a move. A name the
      // build gave a register of its own is the one both sides read equally,
      // and the eleven limbs of a field arithmetic assign one several times.
      if (value.k === "const" && isInteger(targetType) && String(targetRegister) !== "null" && !isWideType(targetType)) {
        const whole = integerText(value.text);
        this.code.movRegImm(targetRegister as number, whole);
        if (!this.writtenWhole(whole, targetType)) this.normalizeArithmetic(targetType, targetRegister as number);
        return;
      }
      // A shift over a value the build gave a register of its own is written in
      // that register rather than moved into the accumulator, shifted there and
      // moved back: the carry a limb arithmetic hands the next limb is one long
      // run of exactly that.
      if (this.shiftInPlace(value, target)) return;
      this.at(value, targetType);
      this.store(target);
      return;
    }
    // Every other operator reads what the name holds as well as the value it is
    // given, and which of the two is the left side of it is the whole of what a
    // compound assignment is: `i -= 1` is `i` less one and `1 - i` is a number
    // of its own, and for `n /= 2` the difference is two divided by n.
    //
    // An addition and a multiplication are the two operations whose answer does
    // not say which side was which, so for those the value is evaluated once
    // into the accumulator and the name's old value is read into the scratch
    // register, which is one instruction fewer than the general form below and
    // the same answer.
    if (op === "**=") {
      // A power is a libm call, and the answer it hands back is the value the
      // name is to hold: one arith of the old value and the one it was given.
      this.at(
        { k: "arith", type: targetType, op: "pow", left: { k: "local", type: targetType, name }, right: value },
        targetType,
      );
      this.store(target);
      return;
    }
    const operation = COMPOUND[op.slice(0, -1)];
    // A number written out, added to a name that has a register of its own, is
    // the one instruction that carries the number: the value does not have to
    // be built in the accumulator first.
    if (String(targetRegister) !== "null" && value.k === "const" && isInteger(targetType) && !isWideType(targetType)) {
      const whole = integerText(value.text);
      const carried =
        whole >= -0x8000_0000n &&
        whole <= 0x7fff_ffffn &&
        (operation === "add" || operation === "sub" || operation === "mul");
      if (carried) {
        const wide = operationWidth(targetType) === 8;
        if (operation === "mul") this.code.imulImm(targetRegister as number, Number(whole), wide);
        else this.code.aluImm(operation, targetRegister as number, Number(whole), wide);
        if (!this.writtenWhole(whole, targetType)) this.normalizeArithmetic(targetType, targetRegister as number);
        return;
      }
    }
    // A float a name is added to is the one instruction that carries it: a
    // number written out lives in the read-only data the instruction reaches,
    // and a name the build gave a register of its own is where it lies. The
    // general form copies either into the accumulator first, which is a move the
    // turn of a loop pays on every turn — and a move waits on whatever the turn
    // before left in the accumulator, which is usually the quotient of its own
    // division.
    if (
      String(targetRegister) !== "null" &&
      isFloatType(targetType) &&
      !isWideType(targetType) &&
      this.operatesOnRegister(operation, targetType) &&
      this.compoundWithFloat(operation, target, value)
    ) {
      return;
    }
    this.at(value, targetType);
    // A name the build gave a register of its own is written in that register:
    // the value the name is given is in the accumulator and the name's own value
    // is where it lies, so the operation is the one instruction that takes the
    // accumulator as its operand and writes the register. The general form below
    // writes the value down, reads the name out and reads the value back out
    // again — four instructions where this is one.
    if (String(targetRegister) !== "null" && this.operatesOnRegister(operation, targetType)) {
      this.compoundAtRegister(operation, target);
      return;
    }
    if (operation === "add" || operation === "mul") {
      if (this.floatOverFrame(operation, targetType, target)) {
        this.normalizeArithmetic(targetType);
        this.store(target);
        return;
      }
      this.scratchFrom(target);
      this.apply(operation, targetType);
      this.normalizeArithmetic(targetType);
      this.store(target);
      return;
    }
    // Anything else needs the name on the left, and the accumulator holds the
    // value rather than the name. The value is written down before the name is
    // read rather than after, so an expression that writes the name as a side
    // of its own evaluation still reads the same thing it would have: the order
    // is the one the addition above has.
    const right = this.hold(targetType, "blaze_right");
    this.store(right);
    this.load(target);
    if (isFloatType(targetType)) {
      this.scratchFrom(right);
    } else this.readInto(right, RCX);
    this.apply(operation, targetType);
    this.normalizeArithmetic(targetType);
    this.store(target);
  }

  /**
   * Whether an operation may name a register as its other side rather than
   * taking it in the scratch.
   *
   * The operations that may are the ones whose instruction takes its second
   * operand wherever it is: a sum, a difference, a product and the three bitwise
   * operations. A division and a remainder need the divisor in the scratch and
   * the dividend in the accumulator, because the machine divides the accumulator
   * widened to twice its width; a shift takes its count in the scratch, because
   * the count of a shift is read out of the low half of that register.
   */
  private operatesOnRegister(operation: Arithmetic, type: SemanticType): boolean {
    if (isFloatType(type)) return operation === "add" || operation === "sub" || operation === "mul";
    if (isWideType(type)) return false;
    return (
      operation === "add" ||
      operation === "sub" ||
      operation === "mul" ||
      operation === "and" ||
      operation === "or" ||
      operation === "xor"
    );
  }

  /**
   * A compound assignment whose name has a register of its own, written in that
   * register.
   *
   * The value the name is given is in the accumulator and the name's own value
   * is in the register, so the operation is the one instruction that writes the
   * register from the accumulator: the name is on the left of it, which is what
   * a compound assignment means, and the answer is where the name is kept.
   *
   * The accumulator is left holding the value it had rather than the answer,
   * which is what the rest of the lowering expects: a statement's value is
   * written into the name it is given to, and nothing reads the accumulator
   * afterwards.
   */
  private compoundAtRegister(operation: Arithmetic, target: Held): void {
    const register = fieldOf(target, "register") as number;
    const type = fieldOf(target, "type") as SemanticType;
    if (isFloatType(type)) {
      this.code.sse(operation as "add" | "sub" | "mul", register, XMM0, widthOf(type) === 4);
    } else {
      const wide = operationWidth(type) === 8;
      if (operation === "mul") this.code.imul(register, RAX, wide);
      else this.code.alu(operation as "add" | "sub" | "and" | "or" | "xor", register, RAX, wide);
    }
    this.normalizeArithmetic(type, register);
    this.accumulatorNote = null;
  }

  /**
   * A compound assignment of a float whose other side needs no accumulator,
   * written as the one instruction that carries it.
   *
   * A number the program wrote out is in the read-only data, which the
   * instruction reaches as its own operand. A name the build gave a register of
   * its own is where it lies, and the instruction names that register. Either is
   * one instruction; the general form copies the value into the accumulator
   * first, and the copy is a move that waits on whatever the turn before left in
   * the accumulator — on the turn of a loop that is the quotient of its own
   * division, which is the whole of what the loop waits for.
   *
   * The two sides have to be the same number: the instruction is read at one
   * precision, so a value of another width is a conversion rather than an
   * operand and is left to the general form.
   */
  private compoundWithFloat(operation: Arithmetic, target: Held, value: SemanticValue): boolean {
    const targetType = fieldOf(target, "type") as SemanticType;
    const register = fieldOf(target, "register") as number;
    const single = widthOf(targetType) === 4;
    if (value.k === "local") {
      const held = this.slot(String(fieldOf(value, "name")));
      const heldRegister = fieldOf(held, "register") as number | null;
      const heldType = fieldOf(held, "type") as SemanticType;
      if (String(heldRegister) === "null" || isWideType(heldType) || !typeEquals(heldType, targetType)) return false;
      this.code.sse(operation as "add" | "sub" | "mul", register, heldRegister as number, single);
    } else if (value.k === "const" && isFloatType(fieldOf(value, "type") as SemanticType) &&
               widthOf(fieldOf(value, "type") as SemanticType) === widthOf(targetType)) {
      const label = this.floatLiteral(floatBits(Number(decimalText(String(fieldOf(value, "text")))), single));
      this.code.sseMemLabel(operation as "add" | "sub" | "mul", register, label, single);
    } else {
      return false;
    }
    this.normalizeArithmetic(targetType, register);
    // The answer went into the register the name is kept in, so nothing the
    // accumulator was noted as holding at the turn of this statement is what it
    // holds now.
    this.accumulatorNote = null;
    return true;
  }

  /**
   * A name given the value another name holds, written as the one copy it is.
   *
   * `carry = whole` is a move, and it is a move between two registers the build
   * gave names of its own, so it is written as the register to register copy it
   * is. The general form reads the name into the accumulator and writes the
   * accumulator back out into the other, which is the same number by two
   * instructions instead of one — and a vector register to vector register has a
   * single port to issue from, so on a loop over a field value's eleven limbs
   * those two instructions are two of the handful the loop's own arithmetic is
   * measured against.
   *
   * It answers whether it did, so every other shape is left to the general form.
   * A value in the frame is a store out of the register rather than a pair of
   * moves, which is the same question asked of the other side.
   */
  private copyBetween(value: SemanticValue, target: Held): boolean {
    if (value.k !== "local") return false;
    const source = this.slot(String(fieldOf(value, "name")));
    const sourceType = fieldOf(source, "type") as SemanticType;
    const targetType = fieldOf(target, "type") as SemanticType;
    if (!typeEquals(sourceType, targetType)) return false;
    const sourceRegister = fieldOf(source, "register") as number | null;
    if (String(sourceRegister) === "null") return false;
    const narrow = widthOf(targetType) === 4;
    const targetRegister = fieldOf(target, "register") as number | null;
    if (String(targetRegister) !== "null") {
      if (isFloatType(targetType)) this.code.movsMove(targetRegister as number, sourceRegister as number, narrow);
      else this.code.movRegReg(targetRegister as number, sourceRegister as number);
      return true;
    }
    if (isFloatType(targetType)) {
      this.code.movsStore(frame(fieldOf(target, "offset") as number), sourceRegister as number, narrow);
    } else {
      this.code.movMemRegSized(
        frame(fieldOf(target, "offset") as number),
        sourceRegister as number,
        widthOf(targetType),
      );
    }
    return true;
  }

  /**
   * A float operation over a side that is already in the frame, answered by
   * the instruction reading it rather than by a move in front of one.
   *
   * A sum and a product take their sides either way round, so the value the
   * accumulator holds and the one the frame holds may be given over in
   * whichever order is convenient and the answer is the same. A difference
   * and a quotient do not, and are left the way they were.
   *
   * It answers whether it did, so a side that is in a register rather than in
   * the frame — which is where a value the build gave a register of its own
   * lives — goes the other way.
   */
  private floatOverFrame(operation: Arithmetic, type: SemanticType, other: Held): boolean {
    if (!isFloatType(type) || (operation !== "add" && operation !== "mul")) return false;
    if (String(fieldOf(other, "register")) !== "null") return false;
    this.code.sseMem(operation, XMM0, frame(fieldOf(other, "offset") as number), widthOf(type) === 4);
    return true;
  }

  private storeField(object: SemanticValue, layoutName: string, name: string, value: SemanticValue): void {
    const found = this.field(layoutName, name);
    const type = parseType(String(fieldOf(found, "type")));
    const foundOffset = fieldOf(found, "offset") as number;
    // An object the build gave a register of its own is written through that
    // register: the address of the field is one `lea` against it, where the
    // general form copies the object into the accumulator first. The address is
    // taken before the value is written, and the value does not take the
    // scratch, so nothing moves it in between.
    const held = object.k === "local" ? this.slot(String(fieldOf(object, "name"))) : null;
    const heldRegister = held === null ? null : fieldOf(held, "register") as number | null;
    const heldType = held === null ? null : fieldOf(held, "type") as SemanticType;
    const register = held !== null && String(heldRegister) !== "null" && heldType !== null && isReference(heldType)
      ? heldRegister as number
      : null;
    if (register !== null && this.keepsScratch(value)) {
      // Neither side writes the scratch, so the address is taken first and the
      // value is written straight through it. The other order has to write the
      // value to the frame and read it back, because taking the address of the
      // object is what takes the scratch.
      this.code.lea(RCX, mem(register, foundOffset));
      this.at(value, type);
      this.storeInto(type, RCX);
      return;
    }
    if (this.keepsScratch(object) && this.keepsScratch(value)) {
      // Neither side writes the scratch, so the address is taken first and the
      // value is written straight through it. The other order has to write the
      // value to the frame and read it back, because taking the address of the
      // object is what takes the scratch.
      this.value(object);
      this.code.lea(RCX, mem(RAX, foundOffset));
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
    // The object is read here and not before the value was written, because a
    // value that calls something may have taken the register it was in.
    this.value(object);
    this.code.lea(RCX, mem(RAX, foundOffset));
    this.load(written);
    this.storeInto(fieldOf(written, "type") as SemanticType, RCX);
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

  /**
   * A loop whose turns are run on a team of threads, written where the loop
   * stands.
   *
   * The loop itself is not written here at all: it is written out as a turn —
   * a function of its own that the runtime calls once per thread with the half
   * open range that thread answers — and what stands here is the call that
   * starts the team. That is the whole of what a backend without threads of
   * its own needs: this one has no instruction that starts a thread and no
   * atomic to hand a counter over with, so the thread is the runtime's, which
   * is already written to keep a pool per thread for the allocator's sake.
   *
   * The counter is left where the loop this replaces would have left it. A
   * loop written out ends with its counter on the first value that failed the
   * test, which is the bound for `<` and one past it for `<=`, and a bound read
   * after the loop is re-read by name, so the value is the same one the loop
   * would have written.
   */
  private fanOut(loop: TeamedLoop): void {
    const label = this.code.label("Lturn");
    this.turns.push({ label, loop });
    const kind = String(fieldOf(loop, "kind"));
    const from = this.heldAt(
      USIZE,
      "blaze_from",
      kind === "counted" ? fieldOf(loop, "from") as SemanticValue : { k: "const", type: USIZE, text: "0" },
    );
    const to = this.heldAt(
      USIZE,
      "blaze_to",
      kind === "counted" ? fieldOf(loop, "to") as SemanticValue : fieldOf(loop, "length") as SemanticValue,
    );
    // The runtime is handed a count of turns and cuts that into as many parts
    // as there are processors. A counter the loop stops at with `<=` stops one
    // past the value it stopped at, and that is the end the range runs to.
    if (kind === "counted" && String(fieldOf(loop, "inclusive")) === "true") {
      this.load(to);
      this.one(USIZE, "add");
      this.store(to);
    }
    // A range whose end is below its start has no turns in it, and the
    // difference of two counters is not a count when the second is the smaller
    // of the two. The counter is left at the start, which is where a loop that
    // turned never leaves it.
    this.load(from);
    this.toScratch(USIZE);
    this.load(to);
    this.apply("sub", USIZE);
    this.code.movRegImm(RDX, 0n);
    this.code.test(RAX, true);
    this.code.cmov("s", RAX, RDX, true);
    // The turn is called with the frame to read, and the stack pointer is where
    // this function's slots are measured from.
    this.code.movRegReg(RDX, RSP);
    this.code.movRegReg(RDI, RAX);
    this.code.leaOwnLabel(RSI, label);
    this.runtime("_parallel_for");
    if (loop.kind === "counted") {
      const counter = this.bind(loop.variable, loop.type);
      this.load(to);
      this.store(counter);
    } else {
      const index = this.bind(loop.index, USIZE);
      this.load(to);
      this.store(index);
      // The element the walk was holding is only ever read inside the loop, so
      // what stands here is a slot that nothing reads: it is bound because the
      // walk declares the name, and left as it was found.
      this.bind(loop.element, loop.elementType);
    }
    this.freeSlot(from);
    this.freeSlot(to);

  }

  /**
   * Every turn this function asked for, written out one after another at the
   * end of the code, where the runtime can call them.
   *
   * A turn is a function with a frame of its own, so it begins by taking one
   * and ends by giving it back, and it is entered with the caller's frame in
   * `rdi` and the half open range it answers in `rsi` and `rdx`. What it reads
   * of the caller's frame is copied into its own, so every slot a read is
   * written against is the offset it had here — which is why the allocator
   * above was told which names a turn reads, and why none of them was given a
   * register.
   *
   * The copy is what makes the rest of this file unchanged by any of it: a
   * turn is written by the same code that writes any other loop, over the same
   * names, reading the same offsets. It runs in a thread rather than in this
   * one, and everything it reads and writes below that copy is the same as it
   * would have been.
   */
  private writeTurns(): void {
    for (const turn of this.turns) {
      const outer = this.used;
      const spares = this.spareSlots.length;
      const borrowed = this.borrowed.length;
      const accumulator = this.accumulatorNote;
      this.spareSlots.length = 0;
      this.borrowed.length = 0;
      this.accumulatorNote = null;
      this.code.bind(String(fieldOf(turn, "label")));
      // The names the turn reads out of the frame, hot enough that a register
      // of its own is worth having: the turn reads the frame it copied, so the
      // value is one load away, and a name read on every element of a loop the
      // turn runs pays that load every time. The turn's own counter is among
      // them when the body reads it as a value, and it is given a register the
      // loop binds it into rather than one established here.
      const cached = this.cacheTurnReads(fieldOf(turn, "loop") as TeamedLoop);
      const established = [...cached].filter(([, held]) => held.established);
      // The registers the convention asks a callee to leave as it found them.
      // A turn is called by the runtime rather than by this function, and it
      // writes as many of them as the body it was written out of does, so it
      // hands back exactly what it was given.
      for (const register of this.pinnedRegisters) this.code.push(register);
      for (const [, held] of cached) this.code.push(fieldOf(held, "register") as number);
      const frameAt = this.code.subRegImmLater(RSP);
      // The three arguments, written into slots of the turn's own before the
      // copy, because the copy is what writes over the slots the caller's
      // frame held and these are read again on the far side of it.
      const handed = this.bind("blaze_handed", USIZE);
      this.code.movMemRegSized(frame(fieldOf(handed, "offset") as number), RDI, 8);
      const begin = this.bind("blaze_begin", USIZE);
      this.code.movMemRegSized(frame(fieldOf(begin, "offset") as number), RSI, 8);
      const end = this.bind("blaze_end", USIZE);
      this.code.movMemRegSized(frame(fieldOf(end, "offset") as number), RDX, 8);
      // `rep movsb` reads the frame handed in and writes the turn's own, so
      // `rsi` is where it reads and `rdi` is where it writes — the two are the
      // other way round from what the instruction reads like.
      this.load(handed);
      this.code.movRegReg(RSI, RAX);
      this.code.movRegReg(RDI, RSP);
      this.code.movRegImm(RCX, BigInt(outer));
      this.code.repMovsb();
      // The copy is what an established register reads: the slot a name sits
      // in is at the distance from the stack pointer the outer body laid it
      // out at, and the copy put the caller's value there.
      for (const [name, held] of established) {
        const slot = this.slot(name);
        const slotTypeOf = fieldOf(slot, "type") as SemanticType;
        this.code.movRegMemSized(
          fieldOf(held, "register") as number,
          frame(fieldOf(slot, "offset") as number),
          widthOf(slotTypeOf),
          signedOf(slotTypeOf),
        );
      }
      this.writeTurn(fieldOf(turn, "loop") as TeamedLoop);
      const bytes = this.frameBytes();
      if (bytes > 0) this.code.patchWord(frameAt, bytes);
      else this.code.unwriteSub(frameAt);
      // The turn leaves the way a function leaves: the frame given back, the
      // registers the convention asks a callee to preserve read off the stack
      // they were pushed on, and a return. The vector registers are not read
      // back, because the slots they were spilled into belong to the frame the
      // turn copied and are gone with it.
      this.code.epilogue(
        [...this.pinnedRegisters, ...[...cached.values()].map((one) => fieldOf(one, "register") as number)],
        [],
        bytes,
      );
      for (const [name, held] of cached) {
        if (String(fieldOf(held, "established")) === "true") {
          const emitted = this.names.read(name);
          const slot = this.slots.get(emitted);
          if (slot !== undefined) this.slots.set(emitted, heldWithRegister(slot, null));
        } else {
          this.pinned.delete(name);
        }
      }
      this.used = outer;
      this.spareSlots.length = spares;
      this.borrowed.length = borrowed;
      this.accumulatorNote = accumulator;
    }
    this.turns.length = 0;
  }

  /**
   * The names of the frame the turn reads, put in registers while it runs.
   *
   * A name the turn reads could not be given a register of this function's:
   * the turn runs on a thread, where the registers the outer body set up are
   * not the turn's. But the turn has registers of its own — it pushes them
   * above the frame it copies and reads them back at the end — and the frame
   * it reads is the copy, so a name hot enough to be worth one is established
   * there once and read from the register after that. The names every turn of
   * this function reads are the same names, so the answer holds for all of
   * them.
   *
   * A name the turn writes is refused: its frame copy would go stale, and the
   * writes of a turn are the writes the parallel mark accounted for — the
   * buffers it fills and the names it declares — which the frame carries
   * rather than a register.
   */
  private cacheTurnReads(loop: TeamedLoop): Map<string, { register: number; established: boolean }> {
    const reads = new Map<string, number>();
    for (const entry of everyBlockAtDepth(fieldOf(loop, "body") as SemanticBlock, 0, [])) {
      const block = fieldOf(entry, "block") as SemanticBlock;
      const depth = fieldOf(entry, "depth") as number;
      const weight = READ_WEIGHT[Math.min(depth, READ_WEIGHT.length - 1)];
      for (const statement of fieldOf(block, "statements") as readonly SemanticStatement[]) {
        for (const value of statementValues(statement)) {
          walkValues(value, (inner) => {
            if (inner.k === "local") {
              const name = String(fieldOf(inner, "name"));
              reads.set(name, (reads.get(name) ?? 0) + weight);
            }
          });
        }
        if (statement.k === "setElement") {
          const buffer = String(fieldOf(statement, "buffer"));
          reads.set(buffer, (reads.get(buffer) ?? 0) + weight);
        }
      }
    }
    // A name the turn writes is read back out of the frame it was written to,
    // and the register the outer body had it in is not that frame.
    const written = this.loopWrites(loop);
    const pool: number[] = [];
    for (const register of [3, 12, 13, 14]) {
      if (this.pinnedRegisters.includes(register)) continue;
      if (this.spareIndexes.includes(register)) continue;
      if (register === OBJECT_POINTER && this.objectRegister === register) continue;
      pool.push(register);
    }
    const cached = new Map<string, { register: number; established: boolean }>();
    // The counter the loop counts is the turn's own, and the turn binds it
    // where the loop's own header is written: a pin under the name the IR
    // counts by is what the bind reads, and the loop establishes it from its
    // own first value, so nothing here reads for it. The loop writes its
    // counter by definition, which is why this is asked before the writes
    // below refuse one.
    const kind = String(fieldOf(loop, "kind"));
    const variable = String(fieldOf(loop, "variable"));
    if (kind === "counted" && reads.get(variable) !== undefined) {
      const register = pool.pop();
      if (register !== undefined) {
        this.pinned.set(variable, register);
        cached.set(variable, { register, established: false });
      }
    }
    const ordered = [...reads.entries()].sort((left, right) => right[1] - left[1]);
    for (const [name, count] of ordered) {
      if (count < 2) break;
      if (written.has(name)) continue;
      if (!this.turnNames.has(name)) continue;
      if (pool.length === 0) break;
      const register = pool.pop() as number;
      const emitted = this.names.read(name);
      const held = this.slots.get(emitted);
      if (held === undefined || String(fieldOf(held, "register")) !== "null") continue;
      this.slots.set(emitted, heldWithRegister(held, register));
      cached.set(name, { register, established: true });
    }
    return cached;
  }

  /**
   * One turn, written as the loop it is over the range the runtime handed it.
   *
   * The loop is the same loop with its counter starting at the beginning of
   * the range rather than at the loop's own first value, and stopping at its
   * end rather than at the loop's own bound. Everything else — the body, the
   * region around it, the counter's own type — is the loop's, which is what
   * makes a turn the same turns the loop would have run, run by several
   * threads over a slice of the counters between them.
   */
  private writeTurn(loop: TeamedLoop): void {
    const kind = String(fieldOf(loop, "kind"));
    const type = kind === "counted" ? fieldOf(loop, "type") as SemanticType : USIZE;
    const region = String(fieldOf(loop, "region")) === "true" ? true : undefined;
    const inner: SemanticLoop = kind === "counted"
      ? {
          kind: "counted",
          variable: String(fieldOf(loop, "variable")),
          type,
          from: { k: "local", type, name: "blaze_begin" },
          to: { k: "local", type, name: "blaze_end" },
          inclusive: false,
          down: String(fieldOf(loop, "down")) === "true",
          step: fieldOf(loop, "step") as SemanticValue | null,
          header: String(fieldOf(loop, "header")),
          exit: String(fieldOf(loop, "exit")),
          body: fieldOf(loop, "body") as SemanticBlock,
          region,
        }
      : {
          kind: "each",
          index: String(fieldOf(loop, "index")),
          element: String(fieldOf(loop, "element")),
          elementType: fieldOf(loop, "elementType") as TypeExpr,
          of: String(fieldOf(loop, "of")),
          length: { k: "local", type: USIZE, name: "blaze_end" },
          header: String(fieldOf(loop, "header")),
          exit: String(fieldOf(loop, "exit")),
          body: fieldOf(loop, "body") as SemanticBlock,
          region,
        };
    // A walk's range is its index, so a turn's walk starts where its half of
    // the counters starts rather than at the first element — which is the one
    // thing that would otherwise leave every thread walking the elements ahead
    // of its own.
    this.loop(inner, { k: "local", type: USIZE, name: "blaze_begin" });
  }
  /**
   * One turn of a loop, between a region's beginning and its end where the loop
   * carries the mark.
   *
   * The region begins at the top of the turn and is left at the bottom, so the
   * next turn is written over what this one built. A turn that leaves early
   * leaves it early too — see `terminator` — and leaving it twice is nothing,
   * which is why the end is written whether the body ended by jumping out or not.
   */
  private turn(loop: Extract<SemanticLoop, { kind: "counted" | "each" }>, labels: LoopLabels): void {
    const body = fieldOf(loop, "body") as SemanticBlock;
    const header = String(fieldOf(labels, "header"));
    if (String(fieldOf(loop, "region")) !== "true") {
      this.block(body);
      if (String(fieldOf(fieldOf(body, "terminator"), "k")) === "next") this.code.jmp(header);
      return;
    }
    this.runtime("_region_enter");
    const opened = this.region;
    this.region = { header };
    this.block(body);
    this.runtime("_region_leave");
    this.region = opened;
    if (String(fieldOf(fieldOf(body, "terminator"), "k")) === "next") this.code.jmp(header);
  }

  private loop(loop: SemanticLoop, start: SemanticValue | null = null): void {
    const kind = String(fieldOf(loop, "kind"));
    // A loop written as a team of threads is written as a call that starts
    // one, and the turns it runs are written out elsewhere; see `fanOut`. Every
    // other loop — a marked one this backend refused, and every loop the rule
    // never marked — is written as the loop it is, which is the same program.
    if ((kind === "counted" || kind === "each") && this.teamed.has(loop)) {
      this.fanOut(loop as TeamedLoop);
      return;
    }
    this.names.enter();
    const labels = this.loopLabels(loop);
    this.loops.push({
      header: labels.header,
      exit: labels.exit,
      names: { header: String(fieldOf(loop, "header")), exit: String(fieldOf(loop, "exit")) },
    });
    if (kind === "while" || kind === "doWhile") {
      const condition = fieldOf(loop, "condition") as SemanticValue;
      const body = fieldOf(loop, "body") as SemanticBlock;
      if (kind === "while") {
        this.code.bind(labels.header);
        this.truthBranch(condition, false, labels.exit);
        this.block(body);
        // The same, for the edge back to the header: a body that returns or
        // breaks never reaches the test again, so the jump is not written.
        if (String(fieldOf(fieldOf(body, "terminator"), "k")) === "next") this.code.jmp(labels.header);
        this.code.bind(labels.exit);
      } else {
        this.code.bind(labels.header);
        this.block(body);
        this.truthBranch(condition, true, labels.header);
        this.code.bind(labels.exit);
      }
    } else if (kind === "counted") {
      this.counted(loop as Extract<SemanticLoop, { kind: "counted" }>, labels);
    } else {
      this.each(loop as Extract<SemanticLoop, { kind: "each" }>, labels, start);
    }
    this.loops.pop();
    this.names.leave();
  }

  /**
   * Every name a loop and the blocks inside it write, which is what a bound
   * read once may not read: a value naming one of them is a value the loop has
   * to look at again on each turn rather than hold for the whole loop.
   */
  private loopWrites(loop: SemanticLoop): Set<string> {
    const written = new Set<string>();
    const kind = String(fieldOf(loop, "kind"));
    if (kind === "counted") written.add(String(fieldOf(loop, "variable")));
    else if (kind === "each") {
      written.add(String(fieldOf(loop, "index")));
      written.add(String(fieldOf(loop, "element")));
    }
    const visit = (block: SemanticBlock): void => {
      for (const statement of fieldOf(block, "statements") as readonly SemanticStatement[]) {
        if (statement.k === "set" || statement.k === "step") {
          written.add(String(fieldOf(statement, "name")));
        } else if (statement.k === "setElement") {
          written.add(String(fieldOf(statement, "buffer")));
        } else if (statement.k === "let") {
          written.add(String(fieldOf(fieldOf(statement, "slot"), "name")));
        } else if (statement.k === "loop") {
          const inner = fieldOf(statement, "loop") as SemanticLoop;
          for (const name of this.loopWrites(inner)) written.add(name);
          visit(fieldOf(inner, "body") as SemanticBlock);
        } else if (statement.k === "if") {
          visit(fieldOf(statement, "then") as SemanticBlock);
          const otherwise = fieldOf(statement, "otherwise") as SemanticBlock | null;
          if (String(otherwise) !== "null") visit(otherwise as SemanticBlock);
        } else if (statement.k === "block") {
          visit(fieldOf(statement, "body") as SemanticBlock);
        }
      }
    };
    visit(fieldOf(loop, "body") as SemanticBlock);
    return written;
  }

  /**
   * Whether a value of a loop names one of the names the loop writes, which is
   * what makes it a value the loop has to look at again on each turn rather
   * than hold for the whole loop.
   */
  private reread(loop: SemanticLoop, value: SemanticValue): boolean {
    const written = this.loopWrites(loop);
    let seen = false;
    walkValues(value, (one) => {
      if (one.k === "local" && written.has(String(fieldOf(one, "name")))) seen = true;
    });
    return seen;
  }

  /**
   * Registers of a kind this loop writes, or null when the program has pinned so
   * many that there are not enough left.
   *
   * Nothing in this loop calls, so borrowing the ones a caller does not ask to
   * be preserved is free: the convention only obliges a callee to hand back what
   * it was given, and this function has been handed nothing by the time it gets
   * here. A pinned register is one the allocator gave to a name, and writing
   * over it would be writing over that name's value, so they are the ones left
   * out.
   */
  private borrow(pool: readonly number[], howMany: number): number[] | null {
    // The registers the bounds of the loops around this one are held in are in
    // use: the loop that holds one keeps it for as long as it runs, and this is
    // written inside that loop.
    const spoken = new Set([...this.pinned.values(), ...this.boundRegisters]);
    const free = pool.filter((register) => !spoken.has(register));
    return free.length >= howMany ? free.slice(0, howMany) : null;
  }

  /**
   * A counted loop that adds up what two arrays hold, written a vector at a time.
   *
   * A turn of the loop below is two turns of the loop the source wrote: it reads
   * two elements of each array, multiplies them and adds the pair into an
   * accumulator that holds two sums at once, in three instructions where the
   * scalar turn took two loads, a multiply, an add, and the two conversions that
   * turn a float counter into the index either array is read at. Nothing here
   * calls, so none of the registers it borrows has to survive anything.
   *
   * The counter is stepped once, at the end, rather than on every turn. The
   * cursor is a count of bytes, and dividing it by the sixteen a pair is brings
   * back the index of the element the pairs stopped at — which is the counter
   * the scalar loop would have left there, because it stepped by one per turn and
   * two turns are one pair.
   *
   * An odd number of elements leaves one over, and it is written by the body this
   * would otherwise have written for every element, at the counter the pairs
   * reached. So the sum the loop answers is the sum of every element whether the
   * array held an odd number of them or not.
   *
   * Returns false when the registers this needs are not free, which leaves the
   * loop to be written the way every other one is.
   */
  private packedDot(
    dot: PackedDot,
    loop: Extract<SemanticLoop, { kind: "counted" }>,
    labels: LoopLabels,
  ): boolean {
    const type: SemanticType = { kind: "primitive", name: "f64" };
    const whole: SemanticType = { kind: "primitive", name: "i64" };
    const vectors = this.borrow([0, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], 3);
    const registers = this.borrow([RDI, RSI, R8, R9, R10, R11], 3);
    if (vectors === null || registers === null) return false;
    const [sum, lane, spare] = vectors;
    const [cursor, left, right] = registers;

    // The counter is declared before anything is written, because the scalar tail
    // at the end reads it as the index the leftover element is at.
    const variable = this.bind(String(fieldOf(dot, "counter")), type);
    const to = this.heldAt(type, "blaze_bound", fieldOf(dot, "bound") as SemanticValue);
    const limit = this.holdAcross(whole, "blaze_limit");

    // Where the pairs stop: the bound as a byte offset, less the sixteen bytes
    // one pair is. A bound under two elements leaves this negative, which is what
    // the signed comparison in the loop reads as "no pairs at all".
    this.at(fieldOf(dot, "bound") as SemanticValue, type);
    this.code.cvtFloatToInt(RAX, XMM0, false, true);
    this.code.shiftImm("shl", RAX, 3, true);
    this.code.aluImm("sub", RAX, 16, true);
    this.code.movMemRegSized(frame(fieldOf(limit, "offset") as number), RAX, 8);

    this.readInto(this.slot(String(fieldOf(dot, "left"))), left);
    this.readInto(this.slot(String(fieldOf(dot, "right"))), right);
    this.code.movRegImm(cursor, BigInt((fieldOf(dot, "from") as number) * 8));
    this.code.movsLoadLabel(XMM0, this.floatLiteral(floatBits(fieldOf(dot, "from") as number, false)), false);
    this.store(variable);

    // `total += a[i] * b[i]` adds to what the name already held, so the vector
    // starts from that value and not from zero: the low lane carries it and the
    // high lane is nothing, which is what the fold at the end of the loop adds.
    // `let total = 0` is the shape that hid this — every test wrote it — and a
    // loop seeded with anything else answered the sum of the loop rather than
    // the value the source wrote.
    //
    // Seeded after the counter is stored rather than before, because the store
    // above writes through XMM0 and the accumulator this borrows may be XMM0.
    const accumulator = this.slot(String(fieldOf(dot, "accumulator")));
    if (String(fieldOf(accumulator, "register")) !== "null") this.code.movsMove(sum, fieldOf(accumulator, "register") as number, false);
    else this.code.movsLoad(sum, frame(fieldOf(accumulator, "offset") as number), false);

    const paired = this.code.label("Lpaired");
    this.code.bind(String(fieldOf(labels, "header")));
    this.code.movRegMemSized(RAX, frame(fieldOf(limit, "offset") as number), 8, true);
    this.code.alu("cmp", RAX, cursor, true);
    this.code.jcc("l", paired);
    // The cursor is a count of bytes and not of elements, so the address it
    // names is the array's own plus the cursor: the scale of the index is one,
    // and a turn reads the sixteen bytes at it.
    this.code.packedLoad(lane, indexed(left, cursor, 1));
    this.code.packedMem("mul", lane, indexed(right, cursor, 1));
    this.code.packed("add", sum, lane);
    this.code.aluImm("add", cursor, 16, true);
    this.code.jmp(String(fieldOf(labels, "header")));
    this.code.bind(paired);

    // The sum of a vector of two is one number, and it is its halves added to
    // each other: the shuffle leaves the high double in both halves, the add
    // leaves their sum in the low one, and the low one is a whole double.
    this.code.packedMove(spare, sum);
    this.code.unpackHigh(spare, sum);
    this.code.packed("add", sum, spare);
    if (String(fieldOf(accumulator, "register")) !== "null") {
      this.code.movsMove(fieldOf(accumulator, "register") as number, sum, false);
    }
    else this.code.movsStore(frame(fieldOf(accumulator, "offset") as number), sum, false);

    // The counter where the pairs left it, which is where a scalar loop stepping
    // by one per turn would have left it too.
    this.code.movRegReg(RAX, cursor);
    this.code.shiftImm("shr", RAX, 3, true);
    this.code.cvtIntToFloat(spare, RAX, false);
    // `store` writes what the accumulator holds, and the index is in the
    // register the conversion put it in rather than in the accumulator.
    this.code.movsMove(XMM0, spare, false);
    this.store(variable);

    // What one element is left over is written by the body the loop was written
    // with, at the counter the pairs reached, and the counter is stepped past it
    // so that the value left behind is the one a scalar loop leaves.
    this.load(variable);
    this.comparedBranch(type, "lt", to, false, String(fieldOf(labels, "exit")));
    this.block(fieldOf(loop, "body") as SemanticBlock);
    this.load(variable);
    this.one(type, "add");
    this.store(variable);

    this.code.bind(String(fieldOf(labels, "exit")));
    this.freeSlot(to);
    this.freeSlot(limit);
    return true;
  }

  /**
   * A loop that adds a value the counter decides, where that value is computed
   * a pair of counters at a time and the additions are not.
   *
   * A turn below is two turns of the loop the source wrote. What is under the
   * addition — the element read, the weight built from the counter, the division
   * of one by the other — is the same arithmetic on two different counters, and
   * nothing in it reads the accumulator, so both turns' worth of it is computed
   * in one register. What is *not* done a pair at a time is the addition: the low
   * lane is added into the accumulator, then the high one, by the same scalar
   * instruction and in the same order the scalar loop would have added them in.
   *
   * That order is the whole reason this loop is not folded into a vector
   * accumulator the way a dot product is. A sum of floats is not the same number
   * however it is grouped, so a loop that adds may not have its additions
   * reordered — and this one computes everything else in the order the source
   * wrote and adds in that order too, which is what makes the pair the same
   * answer rather than merely a faster one.
   *
   * An odd number of turns leaves one over, and it is written by the body this
   * would otherwise have written for every turn, at the counter the pairs
   * reached. So the sum the loop answers is the sum of every turn whether the
   * bound was an even number or not.
   *
   * Returns false when the registers this needs are not free, which leaves the
   * loop to be written the way every other one is.
   */
  private packedSum(
    sum: PackedSum,
    loop: Extract<SemanticLoop, { kind: "counted" }>,
    labels: LoopLabels,
  ): boolean {
    const type: SemanticType = { kind: "primitive", name: "f64" };
    const whole: SemanticType = { kind: "primitive", name: "i64" };
    // The pair of counters lives in the loop counter's own register, and the
    // additions are made into the accumulator's, so a loop either of which was
    // given no register of its own is left to be written the way every other one
    // is. Both are asked for before the counter is bound, because binding is
    // what declares a name: a refusal here has to leave the names the scalar
    // loop is about to declare alone.
    const counter = this.pinned.get(this.names.read(String(fieldOf(sum, "counter"))));
    const accumulator = this.slot(String(fieldOf(sum, "accumulator")));
    // The additions below are a double added into a double, so an accumulator of
    // another type is not one this can make at all.
    if (counter === undefined || String(fieldOf(accumulator, "register")) === "null" || !isFloatType(fieldOf(accumulator, "type") as SemanticType)) return false;
    const total = fieldOf(accumulator, "register") as number;
    // Three more: where a turn's value lands, the one its other side is built
    // in, and the one the other side borrows in turn. None of them is the
    // accumulator's, which the build gave a name this loop adds into a register
    // of its own and which is therefore not free to write through.
    const vectors = this.borrow([0, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], 3);
    // One register for the cursor the pair load is written against, and one for
    // each array's first element: a load is written against a base and a
    // displacement, so two arrays cannot share one register however little they
    // are read. A value reading more arrays than there are registers free is left
    // to be written the way every other loop is.
    const registers = this.borrow([RDI, RSI, R8, R9, R10, R11], 1 + (fieldOf(sum, "arrays") as readonly string[]).length);
    if (vectors === null || registers === null) return false;
    const [result, other, third] = vectors;
    const [cursor, ...bases] = registers;

    // What one turn is written with, gathered once so that every value under the
    // addition is written against the same registers.
    const turn: PackedTurn = { counter, counterName: String(fieldOf(sum, "counter")), cursor, arrays: fieldOf(sum, "arrays") as readonly string[], bases };

    // Declared before anything is written, because the scalar tail at the end
    // reads the counter as the index the leftover turn is at. It is the one
    // register the work below never writes through, because every read of a
    // counter is a move out of it.
    const variable = this.bind(String(fieldOf(sum, "counter")), type);
    const to = this.heldAt(type, "blaze_bound", fieldOf(sum, "bound") as SemanticValue);
    const limit = this.holdAcross(whole, "blaze_limit");

    // Where the pairs stop: the bound as a byte offset, less the sixteen bytes
    // one pair is. A bound under two elements leaves this negative, which is what
    // the signed comparison in the loop reads as "no pairs at all".
    this.at(fieldOf(sum, "bound") as SemanticValue, type);
    this.code.cvtFloatToInt(RAX, XMM0, false, true);
    this.code.shiftImm("shl", RAX, 3, true);
    this.code.aluImm("sub", RAX, 16, true);
    this.code.movMemRegSized(frame(fieldOf(limit, "offset") as number), RAX, 8);

    // The counter as the pair of counters one turn answers for: this one and the
    // next. Laying one literal over the other puts them in the two lanes, and
    // each turn moves the pair on by one in both of them.
    // The counter is written by `store`, which puts the accumulator into the
    // register the loop counts in, so the value it starts from is the value the
    // accumulator is holding at this point. It is loaded into the accumulator
    // for that reason rather than into the counter: the pair is laid over it
    // afterwards, and a counter written first would have its low half replaced.
    this.code.movsLoadLabel(XMM0, this.floatLiteral(floatBits(fieldOf(sum, "from") as number, false)), false);
    this.store(variable);
    this.code.movsLoadLabel(other, this.floatLiteral(floatBits((fieldOf(sum, "from") as number) + 1, false)), false);
    this.code.unpackLow(counter, other);

    // Each array's first element, read once for the whole loop: a pair of turns
    // reads a pair of elements that stand beside each other in every one of them,
    // so the base of each is the same on every turn.
    for (const [at, name] of (fieldOf(sum, "arrays") as readonly string[]).entries()) this.readInto(this.slot(name), bases[at]);
    this.code.movRegImm(cursor, BigInt((fieldOf(sum, "from") as number) * 8));
    // `total += ...` adds to what the name already held, and the register the
    // build gave that name is still holding it: the zeroing that stood here
    // discarded it, so a loop seeded with anything but zero answered the sum of
    // the loop rather than the value the source wrote. Only the low lane carries
    // it, and the high lane is cleared rather than left as it was — the pairs
    // below add into both lanes, so a lane holding a value nothing put there
    // would be one this cannot account for.
    this.code.movsMove(total, total, false);

    const paired = this.code.label("Lsummed");
    this.code.bind(String(fieldOf(labels, "header")));
    this.code.movRegMemSized(RAX, frame(fieldOf(limit, "offset") as number), 8, true);
    this.code.alu("cmp", RAX, cursor, true);
    this.code.jcc("l", paired);
    this.packedValue(fieldOf(sum, "added") as SemanticValue, result, other, third, turn);
    // The low lane is this turn and the high lane is the next, and they are
    // added in that order because that is the order the scalar loop added in.
    // Nothing under the addition is a vector addition, so the only pair of turns
    // this folds is the pair of loads and the pair of counters.
    this.code.sse("add", total, result, false);
    this.code.packedMove(other, result);
    this.code.unpackHigh(other, result);
    this.code.movsMove(XMM0, other, false);
    this.code.sse("add", total, XMM0, false);
    // The pair moves on by the two counters one pair of turns stands for, in
    // both lanes: the low one is the turn the pair starts at and the high one is
    // the turn after it, so moving both by two leaves them a turn apart. The
    // two are laid down in the read-only data, so the instruction that moves
    // them on reads them from there.
    this.code.packedMemLabel("add", counter, this.floatPair(floatBits(2, false)));
    this.code.aluImm("add", cursor, 16, true);
    this.code.jmp(String(fieldOf(labels, "header")));
    this.code.bind(paired);

    // The counter where the pairs left it, which is where a scalar loop stepping
    // by one per turn would have left it too.
    this.code.movRegReg(RAX, cursor);
    this.code.shiftImm("shr", RAX, 3, true);
    this.code.cvtIntToFloat(other, RAX, false);
    // `store` writes what the accumulator holds, and the index is in the
    // register the conversion put it in rather than in the accumulator.
    this.code.movsMove(XMM0, other, false);
    this.store(variable);

    // The sum the pairs added is already where a scalar loop leaves it: the
    // register the build gave the name, which every read of it below is taken
    // from and every write to it is made to. Writing it into the frame as well
    // would say nothing and would land in a slot the bound was given.
    // What one turn leaves over is written by the body the loop was written
    // with, at the counter the pairs reached, and the counter is stepped past it
    // so that the value left behind is the one a scalar loop leaves.
    this.load(variable);
    this.comparedBranch(type, "lt", to, false, String(fieldOf(labels, "exit")));
    this.block(fieldOf(loop, "body") as SemanticBlock);
    this.load(variable);
    this.one(type, "add");
    this.store(variable);

    this.code.bind(String(fieldOf(labels, "exit")));
    this.freeSlot(to);
    this.freeSlot(limit);
    return true;
  }

  /* ---------------------------------------------------------------------- */
  /* Packed weighted division: eight divides by a maintained weight at a time */
  /* ---------------------------------------------------------------------- */

  /**
   * One scalar double read out of a held slot into a register, used to move the
   * maintained weight, step and accumulator in and out of the packed loop.
   */
  private loadFloat(held: Held, into: number): void {
    if (String(fieldOf(held, "register")) !== "null") {
      this.code.movsMove(into, fieldOf(held, "register") as number, false);
    } else {
      this.code.movsLoad(into, frame(fieldOf(held, "offset") as number), false);
    }
  }

  /**
   * A counted loop whose turn adds `array[counter] / weight` into an
   * accumulator, with `weight` and `step` maintained by the loop, written with
   * eight packed divisions at a time when the target has AVX-512.
   *
   * The weight the turn divides by is an arithmetic progression whose step is
   * itself stepped by one per turn, so divisor `k` turns into the future is
   * `weight + k * step + k * (k - 1) / 2`. Eight consecutive divisors are
   * built at once as `weight + [0..7] * step + [0,0,1,3,6,10,15,21]`, eight
   * elements are loaded at once, divided with a single `vdivpd`, and the eight
   * quotients are added into the accumulator one lane at a time in source
   * order, so the sum is bit-for-bit the scalar loop's. The scalar tail writes
   * the leftover turns the way the scalar loop would.
   *
   * Returns false when the registers the packed form needs are pinned, leaving
   * the loop to the scalar lowering.
   */
  private packedWeightedAvx512(
    loop: Extract<SemanticLoop, { kind: "counted" }>,
    labels: LoopLabels,
  ): boolean {
    const packed = packedWeightedOf(loop);
    if (packed === null) return false;
    const weight = this.slot(String(fieldOf(packed, "weight")));
    const step = this.slot(String(fieldOf(packed, "step")));
    const accumulator = this.slot(String(fieldOf(packed, "accumulator")));
    const array = this.slot(String(fieldOf(packed, "array")));
    // The registers names the rest of the function relies on are spoken for,
    // and so is the low half of every register the prologue spilled: a 512-bit
    // write through one of them is a write to that name's value too.
    const spoken = new Set<number>([...this.pinned.values(), ...this.pinnedVectors.map((saved) => fieldOf(saved, "register") as number)]);
    const free = (register: number): boolean => !spoken.has(register);
    // The scratch the weight and step the slots are advanced with are written
    // through, which must be free too.
    if (!free(XMM0) || !free(XMM1)) return false;
    // The whole-number registers the turns are written with: the counter's own
    // when the build pinned it to one, and three more for the array's base, the
    // bound and the address a constant vector is read through.
    const integerFree = [RDI, RSI, R8, R9, R10, R11].filter(free);
    const pinnedCounter = this.pinned.get(this.names.read(String(fieldOf(loop, "variable")))) ?? null;
    const counter = pinnedCounter ?? (integerFree.shift() ?? null);
    if (counter === null) return false;
    const [baseRegister, boundRegister, addressRegister] = integerFree;
    if (baseRegister === undefined || boundRegister === undefined || addressRegister === undefined) return false;
    // The running sum is kept in a register of its own: the pinned one when the
    // build gave the accumulator one, and a free one otherwise.
    const accumulatorRegister =
      String(fieldOf(accumulator, "register")) !== "null" ? fieldOf(accumulator, "register") as number : ([0, 1, 2, 3, 4, 5, 6, 7].find(free) ?? null);
    if (accumulatorRegister === null) return false;
    spoken.add(accumulatorRegister);
    // Four vector registers: where the eight quotients land, where the eight
    // divisors are built, and the weight and step broadcast to every lane.
    const vectors: number[] = [];
    for (let register = 0; register <= 15; register += 1) {
      if (vectors.length >= 4) break;
      if (free(register)) vectors.push(register);
    }
    if (vectors.length < 4) return false;
    const [quotient, divisors, weightVector, stepVector] = vectors;
    // Canonical copies of the maintained weight and step the packed loop steps
    // through, so the loop does not depend on whether the source kept them in
    // registers or in the frame.
    const weightSlot = this.scratch(8, "blaze_packed_weight");
    const stepSlot = this.scratch(8, "blaze_packed_step");
    // The eight quotients are stored here and read back one lane at a time so
    // the addition into the accumulator stays in source order.
    const quotients = this.scratch(64, "blaze_packed_quotients");
    // Constants the weight and step are advanced by: `weight += 8 * step + 28`,
    // `step += 8`.
    const eight = this.scratch(8, "blaze_packed_eight");
    const twentyEight = this.scratch(8, "blaze_packed_twenty_eight");
    const one = this.scratch(8, "blaze_packed_one");
    // Lay the index and triangular constant vectors down once, aligned for a
    // 512-bit load.
    const indexBits = [0n, 1n, 2n, 3n, 4n, 5n, 6n, 7n].map((k) => floatBits(Number(k), false));
    const triBits = [0n, 0n, 1n, 3n, 6n, 10n, 15n, 21n].map((k) => floatBits(Number(k), false));
    const indexLabel = this.floatList(indexBits);
    const triLabel = this.floatList(triBits);
    // Store the constants into their slots.
    this.code.movsLoadLabel(XMM0, this.floatLiteral(floatBits(8, false)), false);
    this.code.movsStore(frame(eight), XMM0, false);
    this.code.movsLoadLabel(XMM0, this.floatLiteral(floatBits(28, false)), false);
    this.code.movsStore(frame(twentyEight), XMM0, false);
    this.code.movsLoadLabel(XMM0, this.floatLiteral(floatBits(1, false)), false);
    this.code.movsStore(frame(one), XMM0, false);
    // Spill the maintained weight and step into their canonical slots.
    this.loadFloat(weight, XMM0);
    this.code.movsStore(frame(weightSlot), XMM0, false);
    this.loadFloat(step, XMM0);
    this.code.movsStore(frame(stepSlot), XMM0, false);
    // The array's base pointer and the bound the counter is tested against.
    if (String(fieldOf(array, "register")) !== "null") this.code.movRegReg(baseRegister, fieldOf(array, "register") as number);
    else this.code.movRegMemSized(baseRegister, frame(fieldOf(array, "offset") as number), 8, false);
    if ((fieldOf(loop, "to") as SemanticValue).k === "local") {
      const bound = this.slot(String(fieldOf(fieldOf(loop, "to"), "name")));
      if (String(fieldOf(bound, "register")) !== "null") this.code.movRegReg(boundRegister, fieldOf(bound, "register") as number);
      else this.code.movRegMemSized(boundRegister, frame(fieldOf(bound, "offset") as number), 8, false);
    } else {
      this.code.movRegImm(boundRegister, BigInt(wholeLiteral(fieldOf(loop, "to") as SemanticValue) as number));
    }
    // The running sum, read into the register the packed loop adds into. Where
    // the build gave the accumulator a register of its own, it is already
    // holding the value.
    if (String(fieldOf(accumulator, "register")) === "null") this.code.movsLoad(accumulatorRegister, frame(fieldOf(accumulator, "offset") as number), false);
    // The counter starts at the loop's first value.
    this.code.movRegImm(counter, BigInt(wholeLiteral(fieldOf(loop, "from") as SemanticValue) as number));

    const packedHeader = this.code.label("Lpacked");
    const tail = this.code.label("Ltail");
    this.code.bind(String(fieldOf(labels, "header")));
    this.code.bind(packedHeader);
    // Fewer than eight elements left: write them the scalar way.
    this.code.lea(addressRegister, mem(counter, 8));
    this.code.alu("cmp", addressRegister, boundRegister, true);
    this.code.jcc("g", tail);
    // Load eight elements of the array at the counter.
    this.code.evexLoad(quotient, indexed(baseRegister, counter, 8));
    // Divisor k is `weight + k * step + tri(k)`, built eight at a time: the
    // step is multiplied by the index vector and the weight and the triangular
    // offsets are added, each read out of the read-only data where it lies.
    this.code.evexBroadcastSd(weightVector, frame(weightSlot));
    this.code.evexBroadcastSd(stepVector, frame(stepSlot));
    this.code.leaLabel(addressRegister, indexLabel);
    this.code.evexMul(divisors, stepVector, mem(addressRegister));
    this.code.evexAdd(divisors, divisors, weightVector);
    this.code.leaLabel(addressRegister, triLabel);
    this.code.evexAdd(divisors, divisors, mem(addressRegister));
    // Eight packed divisions, one per lane.
    this.code.evexDiv(quotient, quotient, divisors);
    // Store the quotients and add each lane into the accumulator in source order.
    this.code.evexStore(frame(quotients), quotient);
    for (let lane = 0; lane < 8; lane += 1) {
      this.code.movsLoad(XMM0, frame(quotients + lane * 8), false);
      this.code.sse("add", accumulatorRegister, XMM0, false);
    }
    // Advance the maintained weight and step by eight turns.
    this.code.movsLoad(XMM0, frame(stepSlot), false);
    this.code.sseMem("mul", XMM0, frame(eight), false);
    this.code.sseMem("add", XMM0, frame(twentyEight), false);
    this.code.movsLoad(XMM1, frame(weightSlot), false);
    this.code.sse("add", XMM1, XMM0, false);
    this.code.movsStore(frame(weightSlot), XMM1, false);
    this.code.movsLoad(XMM0, frame(stepSlot), false);
    this.code.sseMem("add", XMM0, frame(eight), false);
    this.code.movsStore(frame(stepSlot), XMM0, false);
    this.code.aluImm("add", counter, 8, true);
    this.code.jmp(packedHeader);
    this.code.bind(tail);
    // The scalar tail: one turn at a time, stepping weight and step as the
    // scalar loop does.
    this.code.alu("cmp", counter, boundRegister, true);
    this.code.jcc("ge", String(fieldOf(labels, "exit")));
    this.code.movsLoad(XMM0, frame(weightSlot), false);
    this.code.movsLoad(XMM1, indexed(baseRegister, counter, 8), false);
    this.code.sse("div", XMM1, XMM0, false);
    this.code.sse("add", accumulatorRegister, XMM1, false);
    this.code.movsLoad(XMM0, frame(weightSlot), false);
    this.code.sseMem("add", XMM0, frame(stepSlot), false);
    this.code.movsStore(frame(weightSlot), XMM0, false);
    this.code.movsLoad(XMM0, frame(stepSlot), false);
    this.code.sseMem("add", XMM0, frame(one), false);
    this.code.movsStore(frame(stepSlot), XMM0, false);
    this.code.aluImm("add", counter, 1, true);
    this.code.jmp(tail);
    this.code.bind(String(fieldOf(labels, "exit")));
    // The running sum is written back where the accumulator reads it.
    if (String(fieldOf(accumulator, "register")) === "null") this.code.movsStore(frame(fieldOf(accumulator, "offset") as number), accumulatorRegister, false);
    return true;
  }

  /**
   * One value under the addition, in both lanes of a register at once.
   *
   * Every name this may meet is one a census has already said has a packed form
   * of itself, so each case here is how that form is written rather than whether
   * it may be. The counter is the pair the loop is counting; any other name is
   * loop-invariant and is copied into both lanes; a literal is broadcast the
   * same way; an element is the one sixteen-byte load that reads this turn and
   * the next; and an operation is its scalar form with a `d` on the opcode.
   *
   * Two registers carry the work and one carries the counters, at any depth:
   * each side is built into the register the other is not in, so neither is
   * still standing when the instruction that joins them is written.
   */
  private packedValue(
    value: SemanticValue,
    into: number,
    other: number,
    third: number,
    turn: PackedTurn,
  ): void {
    switch (value.k) {
      case "const": {
        // The number in both halves is read out of the read-only data in one
        // instruction, where the general form loads it and then interleaves it
        // with itself — two instructions on every turn of the loop.
        this.code.packedLoadLabel(into, this.floatPair(floatBits(Number(decimalText(String(fieldOf(value, "text")))), false)));
        return;
      }
      case "local": {
        if (String(fieldOf(value, "name")) === String(fieldOf(turn, "counterName"))) {
          this.code.packedMove(into, fieldOf(turn, "counter") as number);
          return;
        }
        // A name the build gave a register of its own is in it, and its frame
        // offset is the first slot's own address rather than a slot of its own,
        // so it is read out of that register. Read from the frame instead it is
        // the first slot's value, which is whatever the body last left there.
        const held = this.slot(String(fieldOf(value, "name")));
        if (String(fieldOf(held, "register")) !== "null") this.code.movsMove(into, fieldOf(held, "register") as number, false);
        else this.code.movsLoad(into, frame(fieldOf(held, "offset") as number), false);
        this.code.unpackLow(into, into);
        return;
      }
      case "element": {
        // Two turns read two doubles that stand beside each other, which is one
        // load of sixteen bytes: the base of the array the read names and the
        // cursor of the pairs, both of which are in registers for the whole loop.
        const of = fieldOf(value, "of") as SemanticValue;
        const ofName = of.k === "local" ? String(fieldOf(of, "name")) : "";
        const at = (fieldOf(turn, "arrays") as readonly string[]).indexOf(ofName);
        const base = (fieldOf(turn, "bases") as readonly number[])[at];
        if (base === undefined) throw machineError("a pair load was written for an array no base register was read for");
        this.code.packedLoad(into, indexed(base, fieldOf(turn, "cursor") as number, 1));
        return;
      }
      case "arith": {
        // The left side is finished with before the right begins, so the right
        // is built with the register it is standing in as its third and writes
        // over it, and the answer is the instruction that joins the two. That is
        // what a census bounds the height of the right side for.
        this.packedValue(fieldOf(value, "left") as SemanticValue, into, other, third, turn);
        this.packedValue(fieldOf(value, "right") as SemanticValue, other, third, into, turn);
        this.code.packed(String(fieldOf(value, "op")) as "add" | "sub" | "mul" | "div", into, other);
        return;
      }
      default:
        throw machineError("a value was packed that the census said has no packed form of itself");
    }
  }

  /**
   * A loop that counts from one number to another. The bound and the step are
   * read once, because a `for` reads its bound on every turn and adds its step
   * on every turn, so a bound or a step the IR calls is a call the loop would
   * otherwise make once per turn. The header label sits on the step, which is
   * where a `continue` belongs, and the first turn is entered at the test.
   */
  /**
   * A loop whose turn adds a number the counter decides, written with that
   * number counted rather than computed.
   *
   * `sum += i * 2 + 1` over a counter is a sum of an arithmetic progression, and
   * the progression can be counted: the counter the loop counts is the
   * progression itself, moved by the step of the progression, and the bound it
   * stops at is the bound the progression stops at. The turn is then the
   * addition of the counter to the accumulator and nothing else, where it was a
   * conversion, a multiplication and an addition.
   *
   * The progression has to be a whole number of steps for the two to be the
   * same number: the counter is a whole number and the numbers it is
   * multiplied by and added to are whole numbers, so the progression is whole
   * too — and the arithmetic the turn did in doubles held it exactly, so the
   * whole number the counter holds is the number that arithmetic gave.
   *
   * The loop this writes is the loop above with the counter standing for the
   * progression: the same turns, the same numbers added to the accumulator, and
   * the same answer.
   */
  private progression(loop: Extract<SemanticLoop, { kind: "counted" }>): Extract<SemanticLoop, { kind: "counted" }> | null {
    // The counter has to be a whole number, and the progression a whole number
    // of steps, for the arithmetic of the turn and the counter to be the same
    // number.
    const type = fieldOf(loop, "type") as SemanticType;
    if (type.kind !== "primitive" || type.name !== "i64") return null;
    const loopBody = fieldOf(loop, "body") as SemanticBlock;
    const statements = fieldOf(loopBody, "statements") as readonly SemanticStatement[];
    if (statements.length !== 1) return null;
    if ((fieldOf(loopBody, "releases") as readonly string[]).length > 0 ||
        String(fieldOf(fieldOf(loopBody, "terminator"), "k")) !== "next") return null;
    const statement = statements[0];
    const variable = String(fieldOf(loop, "variable"));
    if (statement.k !== "set" || String(fieldOf(statement, "op")) !== "+=") return null;
    if (String(fieldOf(statement, "name")) === variable) return null;
    // The ends of the loop have to be known, because the arithmetic of the turn
    // has to be exact over the whole of the range the counter takes, and the
    // range is the one the ends say.
    const from = wholeLiteral(fieldOf(loop, "from") as SemanticValue);
    const to = wholeLiteral(fieldOf(loop, "to") as SemanticValue);
    const step = String(fieldOf(loop, "step")) === "null" ? (String(fieldOf(loop, "down")) === "true" ? -1 : 1) : wholeLiteral(fieldOf(loop, "step") as SemanticValue);
    if (from === null || to === null || step === null) return null;
    const affine = this.progressionOf(fieldOf(statement, "value") as SemanticValue, variable);
    if (affine === null) return null;
    const k = fieldOf(affine, "k") as number;
    const c = fieldOf(affine, "c") as number;
    // A step of no progression is no progression, and a negative one would
    // count the loop the other way round. A progression that is the counter
    // itself is the loop as it was.
    if (k < 1) return null;
    if (k === 1 && c === 0) return null;
    if (!Number.isSafeInteger(k) || !Number.isSafeInteger(c)) return null;
    // The arithmetic of the turn has to be exact in the width it was computed
    // at: a double holds a whole number exactly up to two to the fifty-third, a
    // single up to two to the twenty-fourth, and a whole number of sixty-four
    // bits up to two to the sixty-second, and the product of the counter and the
    // step of the progression has to stay under the one that goes with it.
    const limit = isFloatType(fieldOf(statement, "value") as never as SemanticType)
      ? widthOf(fieldOf(fieldOf(statement, "value"), "type") as SemanticType) === 4
        ? 1n << 24n
        : 1n << 53n
      : 1n << 62n;
    for (const end of [BigInt(from), BigInt(to)]) {
      if (absolute(BigInt(k) * end) >= limit) return null;
      if (absolute(BigInt(k) * end + BigInt(c)) >= limit) return null;
    }
    const number = (value: number): SemanticValue => ({ k: "const", type, text: String(value) });
    const replaced: SemanticStatement = {
      k: "set",
      name: String(fieldOf(statement, "name")),
      op: String(fieldOf(statement, "op")) as SemanticAssignOp,
      value: { k: "local", type, name: variable },
      line: fieldOf(statement, "line") as number,
    };
    const counted: Extract<SemanticLoop, { kind: "counted" }> = {
      kind: "counted",
      variable,
      type,
      from: number(k * from + c),
      to: number(k * to + c),
      inclusive: String(fieldOf(loop, "inclusive")) === "true",
      down: String(fieldOf(loop, "down")) === "true",
      step: number(k * step),
      header: String(fieldOf(loop, "header")),
      exit: String(fieldOf(loop, "exit")),
      body: {
        id: String(fieldOf(loopBody, "id")),
        statements: [replaced],
        releases: fieldOf(loopBody, "releases") as string[],
        terminator: fieldOf(loopBody, "terminator") as SemanticTerminator,
      },
    };
    if (String(fieldOf(loop, "parallel")) === "true") counted.parallel = true;
    if (String(fieldOf(loop, "region")) === "true") counted.region = true;
    const reductions = fieldOf(loop, "reductions");
    if (String(reductions) !== "undefined") counted.reductions = reductions as Extract<SemanticLoop, { kind: "counted" }>["reductions"];
    return counted;
  }

  /**
   * The numbers `k` and `c` of an expression that is `k * counter + c`, or null
   * where the expression is not of that shape.
   */
  private progressionOf(value: SemanticValue, counter: string): { k: number; c: number } | null {
    if (value.k === "local") return String(fieldOf(value, "name")) === counter ? { k: 1, c: 0 } : null;
    if (value.k === "const") {
      const whole = wholeLiteral(value);
      return whole === null ? null : { k: 0, c: whole };
    }
    if (value.k !== "arith") return null;
    if (String(fieldOf(value, "op")) === "mul") {
      const scaled = this.scaledOf(value, counter);
      return scaled === null ? null : { k: scaled, c: 0 };
    }
    if (String(fieldOf(value, "op")) !== "add" && String(fieldOf(value, "op")) !== "sub") return null;
    const left = this.progressionOf(fieldOf(value, "left") as SemanticValue, counter);
    const right = this.progressionOf(fieldOf(value, "right") as SemanticValue, counter);
    if (left === null || right === null) return null;
    const leftK = Number(fieldOf(left, "k"));
    const leftC = Number(fieldOf(left, "c"));
    const rightK = Number(fieldOf(right, "k"));
    const rightC = Number(fieldOf(right, "c"));
    if (String(fieldOf(value, "op")) === "add") {
      if (leftK === 0) return { k: rightK, c: leftC + rightC };
      if (rightK === 0) return { k: leftK, c: leftC + rightC };
      return null;
    }
    if (leftK === 0) return { k: -rightK, c: leftC - rightC };
    if (rightK === 0) return { k: leftK, c: leftC - rightC };
    return null;
  }

  /**
   * The whole number a value is the counter multiplied by, or null where it is
   * not the counter multiplied by one.
   */
  private scaledOf(value: SemanticValue, counter: string): number | null {
    if (value.k === "local") return String(fieldOf(value, "name")) === counter ? 1 : null;
    if (value.k !== "arith" || String(fieldOf(value, "op")) !== "mul") return null;
    const left = this.scaledOf(fieldOf(value, "left") as SemanticValue, counter);
    const right = this.scaledOf(fieldOf(value, "right") as SemanticValue, counter);
    if (left !== null && right === null) {
      const whole = wholeLiteral(fieldOf(value, "right") as SemanticValue);
      return whole === null ? null : left * whole;
    }
    if (right !== null && left === null) {
      const whole = wholeLiteral(fieldOf(value, "left") as SemanticValue);
      return whole === null ? null : right * whole;
    }
    return null;
  }

  /**
   * The shape `weighted` rewrites, settled without writing anything.
   *
   * It is a step of its own so that the register pass can ask which loops the
   * lowering will weight *before* it hands out registers: the weight and the
   * step each want a vector register of their own, and a register already given
   * to a name is one the weight would have to share or go without.
   */
  private weightedPlan(loop: Extract<SemanticLoop, { kind: "counted" }>): {
    statement: Extract<SemanticStatement, { k: "set" }>;
    lets: Map<string, SemanticValue>;
    statements: readonly SemanticStatement[];
    accumulation: number;
    counted: NonNullable<ReturnType<typeof triangularOf>>;
    select: Extract<SemanticValue, { k: "select" }>;
    otherwise: SemanticValue;
  } | null {
    const type = fieldOf(loop, "type") as SemanticType;
    if (type.kind !== "primitive" || type.name !== "i64") return null;
    if (String(fieldOf(loop, "down")) === "true") return null;
    const stepValue = fieldOf(loop, "step");
    if (String(stepValue) !== "null") {
      const written = wholeLiteral(stepValue as SemanticValue);
      if (written === null || written !== 1) return null;
    }
    const from = wholeLiteral(fieldOf(loop, "from") as SemanticValue);
    if (from === null || from < 0) return null;
        const loopBody = fieldOf(loop, "body") as SemanticBlock;
    if ((fieldOf(loopBody, "releases") as readonly string[]).length > 0 ||
        String(fieldOf(fieldOf(loopBody, "terminator"), "k")) !== "next") return null;
    // The turn is one accumulation of a quotient; the declarations before it
    // are computable where they stand, which is what lets the weight read them.
    const statements = fieldOf(loopBody, "statements") as readonly SemanticStatement[];
    const accumulation = statements.findIndex((statement) => statement.k === "set");
    if (accumulation < 0 || accumulation !== statements.length - 1) return null;
    for (const statement of statements) {
      if (statement.k === "set") {
        if (String(fieldOf(statement, "op")) !== "+=") return null;
        if (String(fieldOf(statement, "name")) === String(fieldOf(loop, "variable"))) return null;
        continue;
      }
      const slot = fieldOf(statement, "slot") as SemanticSlot;
      if (statement.k !== "let" || String(fieldOf(slot, "kind")) !== "value" || String(fieldOf(slot, "mutable")) === "true") return null;
      if (!isSafeToCompute(fieldOf(statement, "value") as SemanticValue)) return null;
    }
    const statement = statements[accumulation] as Extract<SemanticStatement, { k: "set" }>;
    // The select appears once, and where it stands is where the weight goes.
    const select = soleSelect(fieldOf(statement, "value") as SemanticValue);
    if (select === null) return null;
    const selectType = fieldOf(select, "type") as SemanticType;
    if (selectType.kind !== "primitive" || selectType.name !== "f64") return null;
    // A turn this pass has already weighted is the one whose fast arm is the
    // weight itself, and weighting it again would hold a second value under the
    // name the first turn's steps keep moving. The arm the weight replaced is a
    // name this pass reserved, so a select whose fast arm is that name is the
    // turn again, and the loop is left as the rewrite left it.
    const selectThen = fieldOf(select, "then") as SemanticValue;
    if (selectThen.k === "local" && String(fieldOf(selectThen, "name")).startsWith("blaze_triangular")) return null;
    // The arm that answers when the test holds is the whole-number weight,
    // and the progression of it is what the step of the weight is. The names
    // the arm reads are the declarations the body made of its own values,
    // which the arm lives among and the weight may read where they stand.
    const lets = new Map<string, SemanticValue>();
    for (const entry of statements.slice(0, accumulation)) {
      const slot = fieldOf(entry, "slot") as SemanticSlot;
      if (entry.k === "let" && String(fieldOf(slot, "kind")) === "value") {
        lets.set(String(fieldOf(slot, "name")), fieldOf(entry, "value") as SemanticValue);
      }
    }
    const counted = triangularOf(
      selectThen,
      String(fieldOf(loop, "variable")),
      fieldOf(loop, "from") as SemanticValue,
      lets,
      (name) => writesCounter(loopBody, name),
    );
    if (counted === null) return null;
    // The arm the test refuses is the computation the source wrote, and it
    // read the declarations where they stood. The arm lives under the test,
    // which is the one place its answers are asked for, so what it read is
    // carried into it: the declaration a slow arm alone reads is computed
    // where the arm runs, and not on the turns the fast arm answers, which
    // used to convert the counter's sum to a double on every one of them.
    let otherwise = structuredClone(fieldOf(select, "otherwise") as SemanticValue);
    for (let round = 0; round < 8; round += 1) {
      if (lets.size === 0) break;
      otherwise = substituteLocals(otherwise, lets);
    }
    return { statement, lets, statements, accumulation, counted, select, otherwise };
  }

  /**
   * A turn whose divisor is a weight the counter decides, written with that
   * weight counted rather than computed.
   *
   * The divisor of a spectral norm's turn is a triangular number of the sum of
   * the two indices: `((i + j) * (i + j + 1)) >>> 1 + i + 1`. As a function of
   * one index with the other fixed, that is an arithmetic progression whose
   * step is that sum plus one — so a turn divides by the weight the turn
   * before it divided by, moved by one step, and the product, the shift and
   * the conversions of the weight are one addition instead.
   *
   * The weight is maintained as a double, and the maintaining is exact where
   * the weight is read: a double holds a whole number exactly up to two to the
   * fifty-third, and the weight this keeps is the number the fast path
   * computed so long as no truncation of it has happened — which the test in
   * the condition accounts for. The value the select answers when the test
   * does not hold is the one the slow path wrote, and the weight a turn the
   * test failed under left behind is a value nothing reads.
   */
  private weighted(loop: Extract<SemanticLoop, { kind: "counted" }>): {
    guarded: Extract<SemanticLoop, { kind: "counted" }>;
    lean: Extract<SemanticLoop, { kind: "counted" }> | null;
    hoisted: SemanticValue | null;
  } | null {
    const plan = this.weightedPlan(loop);
    if (plan === null) return null;
    const statement = fieldOf(plan, "statement") as Extract<SemanticStatement, { k: "set" }>;
    const statements = fieldOf(plan, "statements") as readonly SemanticStatement[];
    const accumulation = fieldOf(plan, "accumulation") as number;
    const counted = fieldOf(plan, "counted") as NonNullable<ReturnType<typeof triangularOf>>;
    const select = fieldOf(plan, "select") as Extract<SemanticValue, { k: "select" }>;
    const otherwise = fieldOf(plan, "otherwise") as SemanticValue;
    const loopBody = fieldOf(loop, "body") as SemanticBlock;
    // The weight is named once, held across the loop, and stepped after the
    // turn has divided by it. The name is the slot's own: the IR below reads
    // it as a value of its own, and nothing else of the body ever declares it.
    // A float of a loop this long is worth a register of its own, and the
    // register pass reserved a pair of them for exactly this loop before any
    // name was weighed: a register that is spoken for leaves the value in the
    // frame, where a step costs a store and a load on every turn.
    const weightName = this.names.reserve("blaze_triangular");
    const weight = this.reserveSlot(NUMBER, "blaze_triangular", true, this.takeWeightedVector(), weightName);
    // The step is a second held value beside the weight. It starts where the
    // first turn's step is — the sum at the loop's first value, moved by one —
    // and every turn hands what it held to the weight before moving itself,
    // which is the same number the derivation below it used to write.
    const stepName = this.names.reserve("blaze_triangular_step");
    const step = this.reserveSlot(NUMBER, "blaze_triangular_step", true, this.takeWeightedVector(), stepName);
    // The reach of the weight: the sum the turns move may not pass the value
    // the whole-number path's own arithmetic is exact at. The comparison is
    // read at sixty-four bits, where the sum of two counters and the bias
    // beside them is what it is — a counter is under two to the sixty-third
    // and the sum of two of them is under two to the sixty-fourth, so nothing
    // wraps and the test fails exactly where the weight would.
    const reach = {
      k: "compare",
      type: TRUTH,
      op: "le",
      operand: U64,
      left: fieldOf(counted, "slope") as SemanticValue,
      right: { k: "const", type: U64, text: String(TRIANGULAR_REACH) },
    } as SemanticValue;
    const guarded = {
      k: "logical",
      type: (fieldOf(fieldOf(select, "condition"), "type") as SemanticType),
      op: "and",
      left: fieldOf(select, "condition") as SemanticValue,
      right: reach,
    } as SemanticValue;
    // The test is a run of comparisons the counter carries, and every one of
    // them is of a value that moves with the counter by one against a value
    // that does not move at all. Where that can be said of the whole test, it
    // is asked once where the loop starts and once where it ends, and the
    // turns branch on the answer instead of computing the tests again on
    // every one of them; see `hoistableGuard`.
    const hoisted = this.hoistableGuard(guarded, loop);
    const with_weight = replaceOnce((fieldOf(statement, "value") as SemanticValue), select, {
      k: "select",
      type: fieldOf(select, "type") as SemanticType,
      condition: guarded,
      then: { k: "local", type: NUMBER, name: weightName },
      otherwise,
    }) as SemanticValue;
    // The turn the weight stands in alone: where the ends answered for the
    // whole run, the turns divide by the weight and nothing else, and the
    // select and the tests under it are the guarded loop's to carry.
    const with_weight_alone = hoisted === null
      ? null
      : (replaceOnce((fieldOf(statement, "value") as SemanticValue), select, {
          k: "local",
          type: fieldOf(select, "type") as SemanticType,
          name: weightName,
        }) as SemanticValue);
    // The first weight: the fast path at the loop's own first value, and the
    // step beside it that the turns move the weight by.
    const slopeAtStart = substituteLocals(
      structuredClone(fieldOf(counted, "slope") as SemanticValue),
      new Map([[String(fieldOf(loop, "variable")), structuredClone(fieldOf(loop, "from") as SemanticValue)] as [string, SemanticValue]]),
    );
    this.at(fieldOf(counted, "from") as SemanticValue, NUMBER);
    this.store(weight);
    this.at(
      {
        k: "arith",
        type: NUMBER,
        op: "add",
        left: slopeAtStart,
        right: { k: "const", type: NUMBER, text: String(1 + fieldOf(counted, "offset") as number) },
      },
      NUMBER,
    );
    this.store(step);
    // A declaration the body read only where the weight has taken its place is
    // a declaration nothing reads now, and computing it on every turn was the
    // work the weight made needless. What is left unread is left out, a pass
    // at a time, because a declaration another one was read through goes with
    // the second one. What the guarded turn still reads, the turn without the
    // select reads no more of — what the guarded body keeps, both bodies keep.
    let alive = [...statements.slice(0, accumulation)];
    let guardedBody: SemanticBlock;
    for (;;) {
      guardedBody = blockWithStatements(loopBody, [
          ...alive,
          setStatementWithValue(statement, with_weight),
          {
            k: "set",
            name: weightName,
            op: "+=",
            value: { k: "local", type: NUMBER, name: stepName },
            line: (fieldOf(statement, "line") as number),
          },
          {
            k: "set",
            name: stepName,
            op: "+=",
            value: { k: "const", type: NUMBER, text: "1" },
            line: (fieldOf(statement, "line") as number),
          },
        ]);
      const dead = alive.filter(
        (entry) =>
          entry.k === "let" &&
          String(fieldOf(fieldOf(entry, "slot"), "kind")) === "value" &&
          !everyValue(guardedBody, []).some((value) => readsLocal(value, String(fieldOf(fieldOf(entry, "slot"), "name")))),
      );
      if (dead.length === 0) break;
      const gone = new Set(dead);
      alive = alive.filter((entry) => !gone.has(entry));
    }
    // The lean turn reads only the weight, so declarations the guarded turn
    // kept for its select and its slow arm — the overflow checks, the
    // whole-number sum, the floating sum — may be dead here even where they
    // are alive in the guarded body. Drop them the same way, against the lean
    // body, so the fast turns do not compute them.
    let aliveLean = [...alive];
    if (with_weight_alone !== null) {
      for (;;) {
        const tryBody = blockWithStatements(loopBody, [
            ...aliveLean,
            setStatementWithValue(statement, with_weight_alone),
            {
              k: "set" as const,
              name: weightName,
              op: "+=" as const,
              value: { k: "local" as const, type: NUMBER, name: stepName },
              line: (fieldOf(statement, "line") as number),
            },
            {
              k: "set" as const,
              name: stepName,
              op: "+=" as const,
              value: { k: "const" as const, type: NUMBER, text: "1" },
              line: (fieldOf(statement, "line") as number),
            },
          ]);
        const dead = aliveLean.filter(
          (entry) =>
            entry.k === "let" &&
            String(fieldOf(fieldOf(entry, "slot"), "kind")) === "value" &&
            !everyValue(tryBody, []).some((value) => readsLocal(value, String(fieldOf(fieldOf(entry, "slot"), "name")))),
        );
        if (dead.length === 0) break;
        const gone = new Set(dead);
        aliveLean = aliveLean.filter((entry) => !gone.has(entry));
      }
    }
    const leanBody = with_weight_alone === null
      ? null
      : blockWithStatements(loopBody, [
            ...aliveLean,
            setStatementWithValue(statement, with_weight_alone),
            {
              k: "set",
              name: weightName,
              op: "+=",
              value: { k: "local", type: NUMBER, name: stepName },
              line: (fieldOf(statement, "line") as number),
            },
            {
              k: "set",
              name: stepName,
              op: "+=",
              value: { k: "const", type: NUMBER, text: "1" },
              line: (fieldOf(statement, "line") as number),
            },
          ]);
    return {
      guarded: countedWithBody(loop, guardedBody),
      lean: leanBody === null ? null : countedWithBody(loop, leanBody),
      hoisted,
    };
  }

  /**
   * A test of a weight, asked of the loop's ends rather than of every turn.
   *
   * The test a spectral norm's weight is asked under is a run of comparisons
   * the counter carries, and every one of them is of a value that moves with
   * the counter by one against a value that does not move at all. Each of them
   * is then asked of the loop's first value and of its bound, and the run
   * holds for every turn between where the ends hold together and the side
   * moved the way its arithmetic says it does between them: a side that moves
   * by one per turn travels less than the width it is read at, so it falls
   * off the top of that width at most once over the run — the ends say where
   * the comparison held, and the direction the side moved says it did not
   * fall on the way. The test is asked of the ends once, and the
   * turns branch on the one answer, where each of them computed the
   * comparisons again.
   *
   * What keeps this the same program: the comparisons are read at sixty-four
   * unsigned bits, where the moving side's travel fits — a narrower
   * comparison wraps at four billion and holds again past it, which is a
   * shape this refuses rather than reasons about; so is a comparison of two
   * moving sides, a test the body writes its own bound under, and anything
   * the arms are but comparisons and truths the body never writes. Those keep
   * the test they were written with.
   */
  private hoistableGuard(
    condition: SemanticValue,
    loop: Extract<SemanticLoop, { kind: "counted" }>,
  ): SemanticValue | null {
    if (!isBoolean(fieldOf(condition, "type") as SemanticType)) return null;
    const to = fieldOf(loop, "to") as SemanticValue;
    // A bound the body writes is read again at the header, and the turns could
    // run past the value the test at the end was asked of.
    if (this.reread(loop, to)) return null;
    const leaves = conjunctsOf(condition);
    if (leaves === null) return null;
    const body = fieldOf(loop, "body") as SemanticBlock;
    const written = (name: string): boolean => writesCounter(body, name);
    const parts: SemanticValue[] = [];
    for (const leaf of leaves) {
      const hoisted = hoistableLeaf(
        leaf,
        String(fieldOf(loop, "variable")),
        written,
        fieldOf(loop, "from") as SemanticValue,
        to,
      );
      if (hoisted === null) return null;
      parts.push(hoisted);
    }
    let whole = parts[0] as SemanticValue;
    for (const part of parts.slice(1)) {
      whole = { k: "logical", type: TRUTH, op: "and", left: whole, right: part } as SemanticValue;
    }
    return whole;
  }

  private counted(loop: Extract<SemanticLoop, { kind: "counted" }>, labels: LoopLabels): void {
    const type = fieldOf(loop, "type") as SemanticType;
    const body = fieldOf(loop, "body") as SemanticBlock;
    const variableName = String(fieldOf(loop, "variable"));
    const fromValue = fieldOf(loop, "from") as SemanticValue;
    const toValue = fieldOf(loop, "to") as SemanticValue;
    const stepValue = fieldOf(loop, "step") as SemanticValue | null;
    const inclusive = String(fieldOf(loop, "inclusive")) === "true";
    const down = String(fieldOf(loop, "down")) === "true";
    const headerLabel = String(fieldOf(labels, "header"));
    const exitLabel = String(fieldOf(labels, "exit"));
    // With AVX-512, a loop whose turn divides by a weight the counter maintains
    // can divide eight elements at a time with a single packed division. The
    // weight is an arithmetic progression whose step steps by one per turn, so
    // the divisors differ per lane while the addition into the accumulator stays
    // in source order.
    if (this.avx512) {
      if (this.packedWeightedAvx512(loop, labels)) return;
    }
    // A loop that adds up two arrays element by element is written a whole
    // vector at a time. It is recognised here rather than in a pass over the IR
    // because the arithmetic is the machine's: `optimize-ir.ts` runs before any
    // backend and would write this loop out into copies of its body first, and
    // two rewrites of one loop have to be kept from meeting.
    const dot = packedDotOf(loop);
    if (dot !== null && this.packedDot(dot, loop, labels)) return;
    // A loop that adds a value the counter decides is written the same way, with
    // everything under the addition a pair of counters at a time and the
    // addition itself one turn at a time.
    const sum = packedSumOf(loop);
    if (sum !== null && this.packedSum(sum, loop, labels)) return;
    // A loop whose turn adds a number the counter decides is written with that
    // number counted rather than computed: the counter the loop counts is the
    // progression itself, and the turn is the addition of it to the
    // accumulator and nothing else.
    const progression = this.progression(loop);
    if (progression !== null) loop = progression;
    // A turn whose divisor is a weight the counter decides — the triangular
    // number a spectral norm divides by — is a weight counted rather than
    // computed: the weight a turn divides by is the one the turn before it
    // divided by, moved by the step of the progression it is. The turn is then
    // the division by a register and one addition, where it was a product, a
    // shift and two conversions.
    const weighted = this.weighted(loop);
    if (weighted !== null && weighted.lean !== null && !this.teamed.has(loop)) {
      // The loop comes back twice: the turns the ends' answer admits divide by
      // the weight and nothing else, and the turns it refuses keep the select
      // and the tests under it. The answer is asked of the loop's two ends
      // once, and the turns run the form it admits, which is the same turns
      // the one loop ran with the tests on every one of them. The body is
      // flat — the shape above refused everything else — so a turn that
      // leaves early is not one of them, and the two are the loop the source
      // wrote.
      const after = this.code.label("Lweighted");
      const guarded = this.code.label("Lguarded");
      this.truthBranch(fieldOf(weighted, "hoisted") as SemanticValue, false, guarded);
      this.loop(fieldOf(weighted, "lean") as Extract<SemanticLoop, { kind: "counted" }>);
      this.code.jmp(after);
      this.code.bind(guarded);
      this.loop(fieldOf(weighted, "guarded") as Extract<SemanticLoop, { kind: "counted" }>);
      this.code.bind(after);
      return;
    }
    if (weighted !== null) loop = fieldOf(weighted, "guarded") as Extract<SemanticLoop, { kind: "counted" }>;
    // A loop whose turns are known before the first of them is written out as
    // the turns it is, each with the counter at the value that turn has.
    const plan = unrollPlan(loop);
    if (plan !== null &&
        this.unrolledCounted(
          loop,
          labels,
          fieldOf(plan, "factor") as number,
          fieldOf(plan, "step") as number,
        )) return;
    // The variable is bound before the loop's own values are read, because
    // whether it has a register decides whether the value the loop starts from
    // needs a slot of its own: a counter in a register is written straight from
    // the value the loop starts at, where a counter in the frame is written from
    // a slot that holds that value and nothing else ever reads.
    // A counter of this program is a double, and an index is a whole number, so
    // a counter read as an index is converted on every element it reaches. Where
    // one is to hand, the loop keeps the same number in a register of its own and
    // steps it beside the double: the conversion is done once for the loop.
    const writtenName = (value: SemanticValue): boolean => value.k === "local" && writesCounter(body, value.name);
    const shadow =
      isFloatType(type) &&
      this.spareIndexes.length > 0 &&
      wholeLiteral(fromValue) !== null &&
      (stepValue === null || wholeLiteral(stepValue) !== null) &&
      !writtenName(toValue) &&
      (stepValue === null || !writtenName(stepValue)) &&
      !writesCounter(body, variableName)
        ? this.spareIndexes.pop() ?? null
        : null;
    const variable = this.bind(variableName, type, shadow);
    // A counter nothing reads as a number is counted in whole numbers, which is
    // what an index is and what the shadow register holds. The double beside it
    // is then written and stepped and tested for nothing: the body reaches the
    // counter through element reads and element writes, every one of which is an
    // index, and nothing else ever asks the counter what it holds. A whole
    // number is stepped by one instruction and tested by one instruction; a
    // double is stepped by a move out of the read-only data and a floating
    // comparison, and both of those are on every turn of the loop.
    //
    // The bound has to be a number the program wrote out, because a test against
    // a bound that is not one is a comparison of two doubles and there is no
    // whole number to make it against. Everything else — the loop's first value,
    // its step — is already known to be one, which is what the shadow register
    // was reserved for.
    const wholeCounter =
      shadow !== null && wholeCountable(loop) && !readsCounterAsValue(body, variableName);
    if (wholeCounter) {
      this.wholeCounted(loop, labels, shadow as number);
      this.spareIndexes.push(shadow as number);
      return;
    }
    let from: Held | null = null;
    if (String(fieldOf(variable, "register")) === "null") {
      this.at(fromValue, type);
      from = this.holdAcross(type, "blaze_from");
      this.store(from);
    } else {
      this.at(fromValue, type);
      this.store(variable);
    }
    // A bound and a step are read once and held, which is what a `for` costs
    // when nothing writes them: the value the loop counts to is the same number
    // on every turn. A body that writes one of them is the other case, and
    // `for (i = 0; i < limit; i++) { limit = 9; }` reads a different bound on
    // the second turn, so a value the body writes is read again at the header
    // instead of being held for the whole loop.
    const boundReread = this.reread(loop, toValue);
    const stepReread = stepValue !== null && this.reread(loop, stepValue);
    const writtenTo = boundReread ? null : this.literalOf(toValue, type);
    // A bound of doubles is held in a register of its own, because the test of
    // the loop needs it in one: the instruction that compares two doubles takes
    // one of them as its destination and the other as its source, and the
    // condition that answers "less than" without the parity bit needs the
    // larger side in the destination. A bound in the frame is read into the
    // scratch first, which is a second instruction on every turn.
    const held = writtenTo === null ? this.heldBound(type, toValue) : null;
    const to: Held | number = writtenTo ?? held ?? this.heldAt(type, "blaze_to", toValue);
    let step: Held | number | null = null;
    if (stepValue !== null) {
      // A step the program wrote out is the same number on every turn, so it
      // is carried by the instruction that adds it rather than by a slot it is
      // read out of on each of them.
      const number = stepReread ? null : this.immediateOf(stepValue, type);
      if (number !== null) {
        step = number;
      } else {
        this.at(stepValue, type);
        step = this.holdAcross(type, "blaze_step");
        this.store(step);
      }
    }
    // A counter in the frame is started from the slot the loop's first value
    // was written to, which the step and the bound above were evaluated after
    // and would otherwise have taken the accumulator away from. A counter in a
    // register was already given it above and needs nothing here.
    if (String(fieldOf(variable, "register")) === "null" && from !== null) {
      this.load(from);
      this.store(variable);
    }
    // The counter holds its first value by now, whichever of the two ways above
    // put it there, so the whole-number copy of it is taken from the counter and
    // not from the slot the loop started from.
    if (variable.index !== null) this.startIndex(variable, type, variable.index);
    const test = this.code.label("Ltest");
    this.code.jmp(test);
    this.code.bind(headerLabel);
    // A bound the body writes is read again here, before the test reads it, so
    // the turn after the write compares against the value that was written.
    if (boundReread) {
      if (typeof to !== "number") {
        this.at(toValue, type);
        this.store(to);
      }
    }
    let stepSlot: Held | null = null;
    if (step !== null) {
      if (typeof step !== "number") stepSlot = step;
    }
    if (stepReread) {
      if (stepSlot !== null) {
        this.at(stepValue as SemanticValue, type);
        this.store(stepSlot);
      }
    }
    // The counter is stepped once per turn and then tested, and both of those
    // work on it where it is: the accumulator the step leaves it in, or the
    // register of its own when the loop was given one. A counter in a
    // register is stepped and compared where it lies, so a turn costs no
    // traffic through the frame at all.
    const counter = fieldOf(variable, "register") as number ?? RAX;
    if (step === null) {
      // No step written out is one turn's worth in the direction the loop
      // counts, which is the only place `down` decides the arithmetic.
      if (String(fieldOf(variable, "register")) === "null") this.load(variable);
      this.one(type, down ? "sub" : "add", counter);
      if (variable.index !== null) this.code.aluImm("add", variable.index, down ? -1 : 1, true);
    } else if (typeof step === "number") {
      // A step that is written down is the signed amount the index moves by,
      // so it is added whatever its sign is: the direction is already in it,
      // and subtracting a step of minus one moved the index the other way and
      // ran a descending loop for ever.
      if (String(fieldOf(variable, "register")) === "null") this.load(variable);
      if (isFloatType(type)) {
        // A float has no add-with-the-amount-inside form, so the step is written
        // into the scratch and the counter is advanced in the register it lies in.
        this.code.movsLoadLabel(XMM1, this.floatLiteral(floatBits(step, widthOf(type) === 4)), widthOf(type) === 4);
        this.code.sse("add", counter, XMM1, widthOf(type) === 4);
        if (variable.index !== null) this.code.aluImm("add", variable.index, step, true);
      } else this.code.aluImm("add", counter, step, operationWidth(type) === 8);
    } else {
      this.scratchFrom(step);
      if (String(fieldOf(variable, "register")) === "null") this.load(variable);
      else if (isFloatType(type)) this.code.movsMove(XMM0, fieldOf(variable, "register") as number, widthOf(type) === 4);
      else this.code.movRegReg(RAX, fieldOf(variable, "register") as number);
      this.apply("add", type);
      // A step that had to be read leaves the sum in the accumulator rather than
      // in the register the counter is in, because the scratch the step was read
      // into is the other side of the addition and the counter cannot be both.
      // The counter is read back out of the accumulator here, which is what a
      // counter in the frame gets from the store below instead.
      if (fieldOf(variable, "register") as number !== null) {
        if (isFloatType(type)) this.code.movsMove(fieldOf(variable, "register") as number, XMM0, widthOf(type) === 4);
        else this.code.movRegReg(fieldOf(variable, "register") as number, RAX);
      }
    }
    this.normalizeArithmetic(type, counter);
    // A counter stepped where it lies is not stored: writing the accumulator
    // into it would step it with whatever the step left behind.
    if (String(fieldOf(variable, "register")) === "null") this.store(variable);
    this.code.bind(test);
    // Nothing is written between the store above and the test, so the counter
    // is still in the accumulator and reading the slot it was just written to
    // would be loading a value that is already there.
    this.comparedBranch(
      type,
      inclusive ? (down ? "ge" : "le") : down ? "gt" : "lt",
      to,
      false,
      exitLabel,
      counter,
    );
    this.turn(loop, labels);
    this.code.bind(exitLabel);
    // The slots the header was read into are dead now the loop is written, and
    // whatever the statement after this one binds takes them.
    if (from !== null) this.freeSlot(from);
    // A bound held in a register of its own hands that register back to the
    // pool the bounds are taken from, and not to the pool the expressions of
    // the body borrow theirs from: the bound is held for the length of the
    // loop, and the body had no use of it.
    if (typeof to !== "number") {
      const toRegister = fieldOf(to, "register") as number | null;
      if (String(toRegister) === "null") this.freeSlot(to);
      else this.spareBounds.push(toRegister as number);
    }
    if (typeof step !== "number" && step !== null) this.freeSlot(step);
    // The register the counter was read as an index out of goes back too, and
    // the counter is dead with the loop. A loop after this one is a loop one
    // after the other for the length of a function far more often than it is a
    // loop inside this one, and the second of the two was converting the
    // counter on every element it reached — a load and a conversion and an
    // address built out of the two — because the first had not handed the
    // register back when it was done with it.
    if (shadow !== null) this.spareIndexes.push(shadow);
  }

  /**
   * A counted loop whose counter the body reaches only as an index, counted in
   * whole numbers.
   *
   * This is the loop above with the double taken out of it: the counter is the
   * whole number the shadow register already holds, so there is no conversion to
   * do at the start, no double to step at the header and no floating comparison
   * to make. The turn is an addition to the counter, the test is a comparison
   * against the bound the program wrote out, and both are the same whole-number
   * shape the index the body reads is.
   *
   * The loop this writes is the loop `counted` writes. The counter is the same
   * number at the same turns, because it is started from the same first value,
   * moved by the same step and tested against the same bound with the same
   * sense; and the double the general form keeps beside it is a value nothing
   * reads, which is what `readsCounterAsValue` is what says.
   */
  private wholeCounted(loop: Extract<SemanticLoop, { kind: "counted" }>, labels: LoopLabels, counter: number): void {
    // A counter whole-counted is stepped in a register of its own, and that
    // register is what a shift count is read out of when the loop divides by a
    // power of two.
    this.counterRegisters.set(String(fieldOf(loop, "variable")), counter);
    const from = wholeLiteral(fieldOf(loop, "from") as SemanticValue) as number;
    const to = wholeLiteral(fieldOf(loop, "to") as SemanticValue) as number;
    // The step is the signed amount the counter moves by, whatever the direction
    // the loop counts in: `down` says which way the trip runs and the step says
    // how far each turn goes, and a descending loop's step is already negative.
    const stepValue = fieldOf(loop, "step");
    const down = String(fieldOf(loop, "down")) === "true";
    const step = String(stepValue) === "null" ? (down ? -1 : 1) : (wholeLiteral(stepValue as SemanticValue) as number);
    // The counter is compared as a signed number because the value it was
    // holding is a double, and the order of two whole numbers as signed numbers
    // is the order the same two doubles have. The unsigned conditions would
    // answer a loop that counts from below zero the other way round.
    //
    // The sense is the opposite of the one the loop runs under: a `for` that
    // counts up to a bound without reaching it leaves the loop once the counter
    // has reached it, which is the comparison the general form negates because
    // it branches on the truth of the comparison it was given.
    const past = String(fieldOf(loop, "inclusive")) === "true" ? (down ? "lt" : "gt") : down ? "le" : "ge";
    this.code.movRegImm(counter, BigInt(from));
    const test = this.code.label("Ltest");
    this.code.jmp(test);
    this.code.bind(String(fieldOf(labels, "header")));
    this.code.aluImm("add", counter, step, true);
    this.code.bind(test);
    this.code.aluImm("cmp", counter, to, true);
    this.code.jcc(comparisonCode(past, true), String(fieldOf(labels, "exit")));
    this.turn(loop, labels);
    this.code.bind(String(fieldOf(labels, "exit")));
  }

  /**
   * A counted loop written `factor` turns for every trip of the loop that is
   * left, each turn with the counter at the number that turn has.
   *
   * The counter is stepped between the turns and once more after the last of
   * them, so the value the loop leaves it at is the one the rolled loop would
   * have left it at. What is saved is the test and the step: a trip of eleven
   * turns over a field element's limbs is eleven bodies in the code rather
   * than a test, a counter and a jump eleven times, and the counter of each turn
   * is a constant in the code rather than a value kept somewhere and added to.
   *
   * What is spent is the object: the body is written `factor` times over. That
   * is why `unrollPlan` only answers for a body that calls nothing and
   * leaves no block early — the two shapes where the code written again is not
   * the cost.
   */
  private unrolledCounted(loop: Extract<SemanticLoop, { kind: "counted" }>, labels: LoopLabels, factor: number, step: number): boolean {
    const type = fieldOf(loop, "type") as SemanticType;
    const from = wholeLiteral(fieldOf(loop, "from") as SemanticValue);
    const to = wholeLiteral(fieldOf(loop, "to") as SemanticValue);
    if (from === null || to === null) return false;
    const down = String(fieldOf(loop, "down")) === "true";
    const inclusive = String(fieldOf(loop, "inclusive")) === "true";
    const span = down ? from - to : to - from;
    const turns = inclusive ? Math.floor(span / Math.abs(step)) + 1 : Math.ceil(span / Math.abs(step));
    if (!Number.isSafeInteger(turns) || turns < factor) return false;
    // The loop's own scope was entered by the caller, as it is for the rolled
    // loop, and is left when the caller leaves it. A counter of this program is
    // a double and an index is a whole number, so the number each turn has is
    // counted out beside the value and stands in the code where the turn
    // reaches an element with it.
    const shadow = this.spareIndexes.length > 0 ? this.spareIndexes.pop() ?? null : null;
    const variable = this.bind(String(fieldOf(loop, "variable")), type, shadow);
    // A counter the body reaches only as an index is a number of the turns, and
    // the number of the turn is in the instruction as well: `from + turn * step`
    // is a literal, so the double beside it holds nothing the body reads. Which
    // of the two the body reads is what says which of them to write — and a
    // counter with no index register of its own is one whose number nothing
    // records, so an index read out of it is the counter's own value converted,
    // which is the double this is not writing.
    const asIndex = shadow !== null && isFloatType(type) && !readsCounterAsValue(fieldOf(loop, "body") as SemanticBlock, String(fieldOf(loop, "variable")));
    // A loop whose turns are all written out runs once, so there is nothing left
    // to count: the bodies below stand one after another and control leaves them
    // into the exit. A counter of trips the loop never reads is a number in the
    // frame, a load and a test and a subtraction and a store on every trip of a
    // loop that has exactly one — which is every loop this pass writes out whole,
    // because the trip count is what it needs to divide by to write a factor of
    // turns at a time.
    const trips = Math.floor(turns / factor);
    // A loop run once carries the number of every turn in the code, so its
    // counter is never moved to a register at all; a loop of several trips
    // writes its turns once and runs them again and again, and the number a turn
    // has on the second trip is the number the first left the counter at.
    this.constantCounter(variable, type, from, asIndex, trips === 1);
    if (trips > 1) {
      const counted = this.holdAcross(I64, "blaze_trips");
      this.code.movRegImm(RAX, BigInt(trips));
      this.store(counted);
      const once = this.code.label("Ltest");
      this.code.jmp(once);
      this.code.bind(once);
      this.code.bind(String(fieldOf(labels, "header")));
      // The turns left are tested before they are spent, so that a loop of any
      // number of trips writes its bodies the same number of times.
      this.load(counted);
      this.code.test(RAX);
      this.code.jcc("e", String(fieldOf(labels, "exit")));
      this.code.aluImm("sub", RAX, 1, true);
      this.store(counted);
      this.turnsOfUnrolled(loop, variable, type, factor, step, from, false, asIndex);
      this.code.jmp(String(fieldOf(labels, "header")));
      this.code.bind(String(fieldOf(labels, "exit")));
      this.freeSlot(counted);
    } else {
      this.code.bind(String(fieldOf(labels, "header")));
      this.turnsOfUnrolled(loop, variable, type, factor, step, from, true, asIndex);
      this.code.bind(String(fieldOf(labels, "exit")));
    }
    if (shadow !== null) this.spareIndexes.push(shadow);
    return true;
  }

  /**
   * The `factor` turns of one trip of a loop that is written out, each with the
   * counter at the value that turn has.
   *
   * A loop that runs once is written out whole, so each of its turns has a
   * counter this pass counted and the counter is a number in the instruction
   * rather than a value kept somewhere and converted back into an index — the
   * number is carried by the element addresses themselves and no register is
   * written. A loop that runs several trips has the same counter at a different
   * number on each of them, so its turns are written as so many steps of the
   * loop's own: the body is written out once and run once per trip, and only
   * the first of the trips was counted here.
   *
   * `whole` says the first of the two: whether the counter of every turn is a
   * number this pass worked out rather than a step of the loop's own. The second
   * case is the only one that can be entered with the counter somewhere other
   * than where the first turn left it, which is why the loop jumps to the step
   * when it is not whole.
   */
  private turnsOfUnrolled(
    loop: Extract<SemanticLoop, { kind: "counted" }>,
    variable: Held,
    type: SemanticType,
    factor: number,
    step: number,
    from: number,
    whole: boolean,
    asIndex: boolean,
  ): void {
    for (let turn = 0; turn < factor; turn += 1) {
      if (turn > 0) {
        if (whole) this.constantCounter(variable, type, from + turn * step, asIndex, true);
        else this.stepCounter(variable, type, step, asIndex);
      }
      this.block(fieldOf(loop, "body") as SemanticBlock);
    }
    // One step after the last turn, so that the value the loop leaves the
    // counter at is the one the rolled loop would have left it at.
    this.stepCounter(variable, type, step, asIndex);
  }

  /**
   * The whole-number copy of a counter started at the value the loop starts from,
   * which is the one conversion the loop's own arithmetic does not do again.
   */
  private startIndex(variable: Held, type: SemanticType, shadow: number): void {
    this.load(variable);
    this.code.cvtFloatToInt(shadow, XMM0, widthOf(type) === 4, true);
  }

  /**
   * A counter put at a number the loop counted out before it was run.
   *
   * `inCode` says the number is one the code carries for this turn rather than
   * one a register has to be moved to: the turns of a loop written out once are
   * executed once each, so the number of each of them is the number written
   * beside it, while the turns of a loop of several trips are written once and
   * run a trip at a time, and the number a turn has then is wherever the trip
   * before it left the counter.
   */
  private constantCounter(variable: Held, type: SemanticType, value: number, asIndex = false, inCode = false): void {
    // A counter the body reaches only as an index has no value to write: the
    // number of the turn is in the instruction beside it, so writing the double
    // would be a load and a store of a number nothing reads, on every turn.
    if (!asIndex) {
      if (isFloatType(type)) this.floatConstant(value, type, XMM0);
      else this.code.movRegImm(RAX, BigInt(value));
      this.store(variable);
    }
    if (variable.index === null) return;
    // The number is recorded rather than moved in, and every element the counter
    // reaches is addressed by that number without a register in it — which is
    // one instruction per turn the loop does not write, and the register it
    // would have been written into is spent on nothing else.
    if (inCode) variable.constant = BigInt(value);
    else this.code.movRegImm(variable.index, BigInt(value));
  }

  /**
   * A counter moved on by the amount the loop steps it by, in the register it is
   * in or in the frame slot it is in, which is what the rolled loop above does
   * with the same value.
   *
   * As with `constantCounter`, a counter nothing reads as a value is only moved
   * in the register the index is read out of: the move of the double is the same
   * arithmetic the index's move is, written twice, and the second of the two is
   * the one the body reads. Where the index register's number is one this pass
   * counted out, the move is the number addition itself and no register at all.
   */
  private stepCounter(variable: Held, type: SemanticType, step: number, asIndex = false): void {
    const advance = (): void => {
      if (variable.index === null) return;
      if (variable.constant !== null) variable.constant += BigInt(step);
      else this.code.aluImm("add", variable.index, step, true);
    };
    if (asIndex) {
      advance();
      return;
    }
    const register = variable.register ?? RAX;
    if (variable.register === null) this.load(variable);
    if (isFloatType(type)) {
      this.floatConstant(step, type, XMM1);
      this.code.sse("add", register, XMM1, widthOf(type) === 4);
    } else {
      this.code.aluImm("add", register, step, operationWidth(type) === 8);
    }
    advance();
    if (variable.register === null) this.store(variable);
  }

  /**
   * A loop that walks an array. The buffer is read in the scope the loop was
   * entered in, and its length is read once, for the same reason a counted
   * loop's bound is.
   */
  private each(loop: Extract<SemanticLoop, { kind: "each" }>, labels: LoopLabels, start: SemanticValue | null = null): void {
    const lengthValue = fieldOf(loop, "length") as SemanticValue;
    const indexName = String(fieldOf(loop, "index"));
    const elementName = String(fieldOf(loop, "element"));
    const ofName = String(fieldOf(loop, "of"));
    const elementType = fieldOf(loop, "elementType") as TypeExpr;
    this.at(lengthValue, USIZE);
    const length = this.holdAcross(USIZE, "blaze_length");
    this.store(length);
    const index = this.bind(indexName, USIZE);
    // The index is stepped where it lies, the way a counted loop steps its
    // counter: in the frame it costs a store and a load per turn to hold a
    // value the next turn reads straight back out again, and a register the
    // callee leaves alone costs neither.
    const counter = fieldOf(index, "register") as number ?? RAX;
    // A walk handed to a team does not start at the first element: it starts
    // where its half of the counters starts, which is what stops every thread
    // walking the elements before its own.
    if (start === null) {
      this.code.movRegImm(counter, 0n);
    } else {
      this.at(start, USIZE);
      if (counter !== RAX) this.code.movRegReg(counter, RAX);
    }
    // The index is a slot as well as a register, and the body reads the slot, so
    // the value it starts from is written down before the walk leaves this
    // statement rather than at the header where the step writes it.
    if (String(fieldOf(index, "register")) === "null") this.store(index);
    // The index is stepped before the test, and the test is where the walk comes
    // back to, so the first turn runs at the index it was started from and every
    // turn after it at the next one.
    const test = this.code.label("Ltest");
    this.code.jmp(test);
    this.code.bind(String(fieldOf(labels, "header")));
    // The index is read back out of its slot before the step, because a counter
    // in the frame is not in a register the body left alone: the body computes
    // addresses in `rax`, and the step would then be adding one to the last
    // address rather than to the index. A counter with a register of its own is
    // stepped where it lies, which is what `counted` does for the same reason.
    if (String(fieldOf(index, "register")) === "null") this.load(index);
    this.code.aluImm("add", counter, 1);
    if (String(fieldOf(index, "register")) === "null") this.store(index);
    this.code.bind(test);
    this.code.aluRegMem("cmp", counter, frame(fieldOf(length, "offset") as number), true);
    this.code.jcc("ae", String(fieldOf(labels, "exit")));
    this.readFrom(elementType, this.addressOf(ofName, { k: "local", type: USIZE, name: indexName }, elementType));
    this.store(this.bind(elementName, elementType));
    this.turn(loop, labels);
    this.code.bind(String(fieldOf(labels, "exit")));
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
    if (isFloatType(type)) {
      this.floatTruth(type);
      return;
    }
    this.code.test(RAX);
  }

  /**
   * A branch on whether a value is true, and nothing else.
   *
   * A value that is a comparison, or a comparison under a `!`, is the case this
   * exists for. The comparison already leaves in the flags the answer every
   * caller of `truth` goes on to ask about, so the branch reads them where they
   * are: the condition byte is never widened into the accumulator, and the
   * `test` that asked whether it was zero never happens. The side that is
   * neither is put in the accumulator and asked of it as before.
   *
   * A `!` is answered by the other sense of the comparison rather than by a
   * number the comparison is first written down as. Every comparison has an
   * opposite — `eq` and `ne`, `lt` and `ge`, `le` and `gt` — and over floats
   * the opposite answers the same values, because a pair that is not numbers
   * is in no ordered relation and every ordered comparison of one is false, so
   * the negation of it is true where the opposite is true of the unordered case
   * too. A loop written on `!(n <= 0)` is the shape this exists for: the loop
   * condition is a value, and a value read as a truth is four instructions
   * where a branch is one.
   */
  private truthBranch(value: SemanticValue, whenTrue: boolean, label: string): void {
    if (value.k === "isNull" && !isTextType((fieldOf(fieldOf(value, "operand"), "type") as SemanticType))) {
      // A test of a reference is a test of the pointer holding it, and the
      // answer is a branch on the pointer rather than a truth written down as a
      // number and tested again. `is_null` is the test itself and
      // `is_not_null` is its negation, so which of the two conditions the
      // branch reads is the one the test holds under for the sense asked for.
      this.value(fieldOf(value, "operand") as SemanticValue);
      this.truthOfAccumulator((fieldOf(fieldOf(value, "operand"), "type") as SemanticType));
      const negate = String(fieldOf(value, "negate")) === "true";
      this.code.jcc((whenTrue ? !negate : negate) ? "e" : "ne", label);
      return;
    }
    if (value.k === "logical" && (String(fieldOf(value, "op")) === "and" || String(fieldOf(value, "op")) === "or")) {
      // A condition that is two conditions joined is asked arm by arm: the
      // arm that settles the whole settles it, and the other arm is asked
      // only where the whole is not settled yet. The branch is the question
      // the operator answers, so the truth of neither arm is written down as
      // a number first — a comparison's flags are read where they are, and a
      // boolean value in a register is tested where it lies.
      //
      // This is the same order the value below asks in, so what a name read
      // here is live across is what the census said it was.
      // The sense of an arm that settles the whole: false for `&&`, true for
      // `||`. Where that sense is the one the caller asked the branch for, both
      // arms branch to the label on their own sense, and a left arm that
      // settles it goes there directly. Asking a left arm that settles the
      // whole for the *other* sense is the short circuit: it skips the right
      // arm and falls through, because the whole is already the other value.
      const settling = String(fieldOf(value, "op")) === "or";
      if (settling === whenTrue) {
        this.truthBranch(fieldOf(value, "left") as SemanticValue, settling, label);
        this.truthBranch(fieldOf(value, "right") as SemanticValue, whenTrue, label);
        return;
      }
      const settled = this.code.label("Lsettled");
      this.truthBranch(fieldOf(value, "left") as SemanticValue, settling, settled);
      this.truthBranch(fieldOf(value, "right") as SemanticValue, whenTrue, label);
      this.code.bind(settled);
      return;
    }
    const underNot = value.k === "unary" && String(fieldOf(value, "op")) === "not" ? flagComparison(fieldOf(value, "operand") as SemanticValue) : null;
    const comparison = underNot ?? flagComparison(value);
    if (comparison === null) {
      this.truth(value);
      this.code.jcc(whenTrue ? "ne" : "e", label);
      return;
    }
    const type = fieldOf(comparison, "operand") as SemanticType;
    // A `!` over a comparison is answered by the other sense of the comparison
    // rather than by a number the comparison is written down as first, which is
    // what keeps the condition byte out of the accumulator.
    //
    // Over whole numbers the other sense is the opposite comparison. Over floats
    // it is not, for the four ordered ones: a pair that is in no ordered relation
    // is below nothing and above nothing, so `a < b` is false and so is
    // `a >= b`, while `!(a < b)` is true — a branch written on the opposite
    // comparison took the other arm on a value that is not a number. The answer
    // is the comparison itself under the other sense, and that is what the
    // conditions below the carry are for: an unordered pair sets them, which is
    // exactly "the comparison does not hold".
    //
    // The two comparisons that are not ordered are the other way round. `==` and
    // `!=` are relations over every pair, a pair that is in no ordered relation
    // included, so each is the opposite of the other.
    const ordered = underNot !== null && isFloatType(type) && String(fieldOf(comparison, "op")) !== "eq" && String(fieldOf(comparison, "op")) !== "ne";
    const op = underNot === null || ordered ? String(fieldOf(comparison, "op")) as CompareOp : oppositeOf(String(fieldOf(comparison, "op")) as CompareOp);
    // The branch is taken under the other sense of the comparison wherever the
    // comparison itself is what was kept, and under the sense it was asked for
    // where the opposite comparison is what was kept — which answers the same
    // place, because the opposite of a relation over every pair is that pair's
    // other side.
    const sense = underNot === null ? whenTrue : ordered ? !whenTrue : whenTrue;
    // A wide number cannot be held in one register, so the comparison is
    // answered by walking the limbs in memory and leaving 0/1 in RAX, then
    // branching on it.
    if (isWideType(type)) {
      const wideComparison = {
        k: "compare",
        type: fieldOf(comparison, "type") as TypeExpr,
        op,
        operand: fieldOf(comparison, "operand") as SemanticType,
        left: fieldOf(comparison, "left") as SemanticValue,
        right: fieldOf(comparison, "right") as SemanticValue,
      } as SemanticValue & { k: "compare" };
      this.wideCompare(wideComparison);
      this.code.test(RAX, true);
      this.code.jcc(sense ? "nz" : "z", label);
      return;
    }
    // Which form the comparison takes is settled before either side is written,
    // so that a side is evaluated once whichever form it is. An other side the
    // program wrote out is carried by the comparison itself rather than by a
    // slot, so `left > 0` is a compare against a literal and not a literal
    // stored in the frame and read back out of it.
    const immediate = this.literalOf(fieldOf(comparison, "right") as SemanticValue, type);
    if (immediate !== null) {
      this.at(fieldOf(comparison, "left") as SemanticValue, type);
      // A float comparison reads both sides in vector registers, and the left
      // one has just been written into the accumulator: naming `RAX` there
      // made the literal overwrite the side it was to be compared against.
      this.comparedBranch(type, op, immediate, sense, label, isFloatType(type) ? XMM0 : RAX);
      this.noteCompared(fieldOf(comparison, "left") as SemanticValue, type);
      return;
    }
    // The side held is read back after the other one has been written, so a
    // register serves it exactly as long as nothing calls in between.
    // A left side the comparison reads where it lies costs no slot and no copy:
    // the right side goes into the accumulator, and the element is the source
    // the instruction reads it against.
    const carried = isFloatType(type) ? this.carriedOperand(fieldOf(comparison, "left") as SemanticValue, type, !hasCall(fieldOf(comparison, "right") as SemanticValue)) : null;
    if (carried !== null) {
      this.at(fieldOf(comparison, "right") as SemanticValue, type);
      this.floatBranch(op, widthOf(type) === 4, sense, label, carried, XMM0);
      this.noteCompared(fieldOf(comparison, "right") as SemanticValue, type);
      return;
    }
    const right = hasCall(fieldOf(comparison, "left") as SemanticValue) ? this.hold(type, "blaze_right") : this.hold(type, "blaze_right");
    this.at(fieldOf(comparison, "right") as SemanticValue, type);
    this.store(right);
    this.at(fieldOf(comparison, "left") as SemanticValue, type);
    // The left side is in the accumulator, which is a vector register for a
    // float and the whole-number register otherwise.
    this.comparedBranch(type, op, right, sense, label, isFloatType(type) ? XMM0 : RAX);
    this.noteCompared(fieldOf(comparison, "left") as SemanticValue, type);
  }

  /**
   * The note about the accumulator that a float comparison leaves behind.
   *
   * A comparison of two floats puts one side in the accumulator and compares it
   * against the other, which is a register or an address of its own. `UCOMISD`
   * writes no register but the flags, so the side the accumulator holds is still
   * there once the flags have been read — and the arm the branch reaches next,
   * which is written straight after, reads that side for nothing rather than
   * reading it out of the register the build gave it a second time.
   *
   * This is the one place a note is left by anything but a store, and it is why
   * the note names the side rather than the comparison: which side the
   * accumulator holds is what each of the three forms above decided for itself.
   * The note is set against the code as it stands after the branch, so it is
   * read on the same path and not across one — a label bound clears it, which is
   * what the other arm of the `if` does.
   */
  private noteCompared(side: SemanticValue, type: SemanticType): void {
    if (!isFloatType(type) || side.k !== "local") return;
    const held = this.slot(String(fieldOf(side, "name")));
    // The accumulator is asked whether it holds this slot rather than told, so
    // a form that moved it on the way to the comparison leaves nothing behind.
    const accumulator = this.accumulatorNote;
    const id = fieldOf(held, "id") as number;
    if (accumulator === null || (fieldOf(accumulator, "id") as number) !== id) return;
    this.accumulatorNote = { id, at: this.code.written };
  }

  /**
   * `!` over a comparison, read out of the number the comparison answers rather
   * than out of the flags it leaves.
   */
  private comparedNegated(value: SemanticValue & { k: "compare" }): void {
    // The comparison is written as a number first, and `not` is then the
    // question of whether that number is zero. The flags the comparison leaves
    // would be the shorter way round, and for whole numbers they are what
    // `comparedBranch` reads — but the conditions that read a `UCOMISD` have to
    // be gated on the parity bit, which is two instructions rather than one, so
    // there is no single condition to negate. Reading the flags directly also
    // meant comparing a float as though it were a whole number, against an
    // accumulator nothing had put a number in: `if (!(n <= 0))` over doubles
    // answered the base case whatever `n` was.
    this.comparison(value);
    // The zero flag is asked of a `test` of the accumulator rather than of
    // whatever the instruction before it left. The instruction before is a
    // widening move or a `setcc`, and neither of those leaves a flag that says
    // whether the answer is zero: `MOVZX` and `MOVSX` do not touch the flags at
    // all, and a `setcc` sets the zero flag to whether its own condition held.
    // A `gt` has no parity gate and so no `and` to correct that afterwards,
    // which is why `!(1 > 2)` answered `1 > 2`.
    this.code.test(RAX);
    this.code.setcc("e", RAX);
  }

  /**
   * A float is true when it is a number that is not zero. A value that is no
   * number holds nothing, as it does in the language and as the C backend
   * reads it: `UCOMISD` raises the parity bit on an operand that is not a
   * number, so the truth is `not equal` *and* `ordered`, the same pair the
   * `eq` arm of `compare` reads for the same reason. Oring the parity bit in
   * instead made every NaN true, which is what turned `NaN || 0` into the NaN
   * and handed a benchmark a depth of `NaN` where it read `6`.
   *
   * The `movzx` that turns the two condition bytes into a number does not set
   * the zero flag — a widening move leaves the flags alone — so the truth is
   * the number in the accumulator and a caller that wants a truth of something
   * else has to ask about that number itself.
   */
  private floatTruth(type: SemanticType): void {
    this.code.xorFloat(XMM2, XMM2);
    this.code.sseCompare(XMM0, XMM2, widthOf(type) === 4, false);
    this.code.setcc("ne", RAX);
    this.code.setcc("np", RCX);
    this.code.alu8("and", RAX, RCX);
    this.code.movzxReg8(RAX, RAX);
  }

  private terminator(terminator: SemanticTerminator): void {
    if (terminator.k === "next") return;
    // A block nothing arrives at writes nothing. The instructions that would
    // follow it are the epilogue's, and the epilogue is reached only by a return
    // — a fall-through here would hand back whatever the accumulator held.
    if (terminator.k === "unreachable") return;
    if (terminator.k === "return") {
      this.leaveRegion();
      // A wide number is returned through a pointer the caller passes rather
      // than in a register, because four limbs do not fit in the two registers
      // the convention returns a whole number in. The pointer was taken out of
      // `rdi` on entry and put in a slot of the frame, so that whatever the body
      // does to `rdi` — which is everything, it is the first argument register
      // — the epilogue still knows where the answer goes.
      if (isWideType(fieldOf(this.fn, "returns") as SemanticType) && String(fieldOf(terminator, "value")) !== "null") {
        this.wideValue(fieldOf(terminator, "value") as SemanticValue);
        this.wideStore(this.wideResult ?? this.bind(String(fieldOf(this.fn, "name")), fieldOf(this.fn, "returns") as SemanticType));
      }
      if (String(fieldOf(terminator, "value")) !== "null" && !isWideType(fieldOf(this.fn, "returns") as SemanticType)) this.at(fieldOf(terminator, "value") as SemanticValue, fieldOf(this.fn, "returns") as SemanticType);
      this.code.jmp(this.epilogue);
      return;
    }
    for (const name of fieldOf(terminator, "releases") as readonly string[]) this.release(name);
    const open = this.loops[this.loops.length - 1];
    // The target is the id of a block the IR names, and what the jump is
    // written under is the label the lowering minted for that place, which is
    // not the block's id: a block named by two loops is two places.
    const target = String(fieldOf(terminator, "target"));
    if (open === undefined) {
      throw machineError(`${String(fieldOf(this.fn, "symbol"))} jumps for a block no loop around it names`, target);
    }
    const openNames = fieldOf(open, "names") as { readonly header: string; readonly exit: string };
    const openHeader = String(fieldOf(openNames, "header"));
    const openExit = String(fieldOf(openNames, "exit"));
    if (target !== openHeader && target !== openExit) {
      throw machineError(`${String(fieldOf(this.fn, "symbol"))} jumps for a block no loop around it names`, target);
    }
    // A `continue` is another turn of the same loop, so the region is still the
    // right one after it; a jump out of the loop the region belongs to is not,
    // and leaves it on the way.
    //
    // Only that loop's own exit ends it. A `break` out of a loop *inside* the
    // marked one lands still inside its body, and leaving there ended the turn's
    // region early: the rest of the turn then allocated from the slab rather than
    // the cursor, and a block released on that path reached the slab's released
    // list while the region was still rewound over the same bytes — two live
    // blocks in one piece of memory from the next turn on.
    const region = this.region;
    if (target !== openHeader && region !== null &&
        String(fieldOf(region, "header")) === String(fieldOf(open, "header"))) this.leaveRegion();
    this.code.jmp(target === openHeader ? String(fieldOf(open, "header")) : String(fieldOf(open, "exit")));
  }

  /** Leaves the region the code being written is inside, where there is one. */
  private leaveRegion(): void {
    if (this.region === null) return;
    this.runtime("_region_leave");
    this.region = null;
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
    // An absent value read at a type is the zero of that type, not the zero of
    // the type the value was written at: `x ? xs[0] : null` is a text whose
    // absent arm is the null pointer, and the null the source wrote carries no
    // type of its own. Writing the absence in the representation of `ref<any>`
    // left the accumulator a float where a pointer belongs, and `=== null`
    // asked about whatever the other arm had left in the register.
    if (value.k === "nothing" && as !== null) {
      this.zero(as);
      return;
    }
    this.value(value);
    if (as === null) return;
    this.convert(value.type, as);
  }

  /**
   * Whether reading a value into a dynamic slot boxes it, which is a call the
   * runtime makes and a call takes the registers a call takes.
   */
  private boxesDynamic(value: SemanticValue, as: SemanticType | null): boolean {
    if (as === null || !isDynamicType(as)) return false;
    return isTextType(value.type) || value.k === "text" || isNumber(value.type);
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
        this.code.movRegImm(RAX, String(fieldOf(value, "value")) === "true" ? 1n : 0n);
        return;
      case "nothing":
        this.zero(fieldOf(value, "type") as SemanticType);
        return;
      case "functionRef":
        // A function reference is not a value the machine can hold; lowering
        // passes it by name where a callback site needs it.
        this.zero(fieldOf(value, "type") as SemanticType);
        return;
      case "local": {
        const slot = this.slot(String(fieldOf(value, "name")));
        this.load(slot);
        if (isTextType(fieldOf(slot, "type") as SemanticType) && this.boxedTexts.has(String(fieldOf(value, "name")))) {
          // Boxed text local holds a cell pointer; dereference it.
          this.code.movRegMemSized(RAX, mem(RAX, 0), 8, false);
        }
        // A name is loaded at the width its own declaration gives it, which is
        // not always the width this read asks for: a whole number read as a
        // double is every value the slot holds said as the wider of the two, and
        // the conversion that says so is the accumulator's to make. Without it a
        // name the build gave a register of its own lands in a general register
        // while the operation that reads it expects a floating point one — which
        // is what `x > 0` over a name `whole-numbers.ts` narrowed answered from
        // whatever the register beside it happened to hold.
        if (!typeEquals(fieldOf(slot, "type") as SemanticType, fieldOf(value, "type") as SemanticType)) this.convert(fieldOf(slot, "type") as SemanticType, fieldOf(value, "type") as SemanticType);
        return;
      }
      case "text":
        this.text(value);
        return;
      case "toText":
        // The digits are part of what `toFixed(d)` means, so they are passed
        // on: dropping them answered the number as the shortest writing of it,
        // which is the number the source asked not to write.
        this.asText(
          fieldOf(value, "of") as SemanticValue,
          null,
          fieldOf(value, "digits") as number,
          String(fieldOf(value, "precision")) === "true",
        );
        return;
      case "call":
        this.callValue(fieldOf(value, "call") as SemanticCall, fieldOf(value, "type") as SemanticType);
        return;
      case "newObject":
        this.object(value);
        return;
      case "loadField": {
        // The offset of the field is the displacement of the read, so the
        // address is not adjusted in a register first: the accumulator is
        // still the object, and the read reaches the field itself.
        //
        // An object the build gave a register of its own is read through that
        // register, which is one move fewer than copying the object into the
        // accumulator first — and the copy is on every field of every object
        // the program walks.
        const found = this.field(String(fieldOf(value, "layout")), String(fieldOf(value, "field")));
        const offset = fieldOf(found, "offset") as number;
        const object = fieldOf(value, "object") as SemanticValue;
        if (object.k === "local") {
          const held = this.slot(String(fieldOf(object, "name")));
          if (String(fieldOf(held, "register")) !== "null" && isReference(fieldOf(held, "type") as SemanticType)) {
            this.readFrom(fieldOf(value, "type") as SemanticType, mem(fieldOf(held, "register") as number, offset));
            return;
          }
        }
        this.value(object);
        this.readAt(fieldOf(value, "type") as SemanticType, offset);
        return;
      }
      case "length":
        this.length(fieldOf(value, "of") as SemanticValue);
        return;
      case "element": {
        const ofValue = fieldOf(value, "of") as SemanticValue;
        const bufferType = fieldOf(ofValue, "type") as SemanticType;
        const isDynamic = bufferType.kind === "ref" && bufferType.of === null;
        if (isDynamic) {
          this.value(ofValue);
          const slot = this.holdSlot(NUMBER, "blaze_dyn_arr");
          this.store(slot);
          this.value(fieldOf(value, "index") as SemanticValue);
          this.code.movsMove(XMM1, XMM0, false);
          this.code.movsLoad(XMM0, frame(fieldOf(slot, "offset") as number), false);
          this.runtime("_array_get");
          this.convert(NUMBER, fieldOf(value, "type") as SemanticType);
          return;
        }
        // An array that reaches a function as a parameter carries its length
        // beside it; this backend now carries that length as a hidden parameter
        // (see the constructor), so reading an element is pointer arithmetic.
        const element = elementTypeOf(fieldOf(ofValue, "type") as SemanticType) ?? fieldOf(value, "type") as SemanticType;
        this.readFrom(element, this.addressOf(ofValue, fieldOf(value, "index") as SemanticValue, element));
        this.convert(element, fieldOf(value, "type") as SemanticType);
        return;
      }
      case "argv":
        if (String(fieldOf(value, "index")) === "null") {
          this.runtime("_argv_count");
          return;
        }
        this.at(fieldOf(value, "index") as SemanticValue, USIZE);
        this.code.movRegReg(RDI, RAX);
        this.runtime("_argv");
        return;
      case "isNull":
        this.value(fieldOf(value, "operand") as SemanticValue);
        this.code.test(RAX);
        this.code.setcc(String(fieldOf(value, "negate")) === "true" ? "ne" : "e", RAX);
        this.code.movzxReg8(RAX, RAX);
        return;
      case "unary":
        if (isWideType(fieldOf(value, "type") as SemanticType)) {
          this.wideUnary(value);
          return;
        }
        this.unary(value);
        return;
      case "arith":
        this.arithmetic(value);
        return;
      case "compare":
        if (isWideType(fieldOf(value, "operand") as SemanticType)) {
          this.wideCompare(value);
          return;
        }
        this.comparison(value);
        return;
      case "logical":
        this.logical(value);
        return;
      case "coalesce":
        this.coalesce(value);
        return;
      case "select":
        if (isWideType(fieldOf(value, "type") as SemanticType)) {
          this.wideSelect(value);
          return;
        }
        this.select(value);
        return;
      case "buffer":
        this.buffer(value);
        return;
      case "closure":
      case "capture":
        // A closure is a code address the value carries beside the values it
        // captured, and this backend has no value that is two words: refusing
        // here leaves the whole program to the C backend, which carries it.
        throw machineError(
          `${String(fieldOf(this.fn, "symbol"))} builds or reads a closure, which this backend cannot lower`,
          "a closure is the code that enters it beside the values it captured, and build with --backend c to carry it",
        );
    }
  }

  private zero(type: SemanticType): void {
    if (isFloatType(type)) {
      this.code.xorFloat(XMM0, XMM0);
      return;
    }
    this.code.movRegImm(RAX, 0n);
  }

  /**
   * The count a program settles on, read as a size.
   *
   * A NaN is no count, and a count that is not a number is no count the run
   * makes: zero, which is the answer the C driver writes for the same value.
   * The conversion alone would read the middle of the range the machine
   * converts a NaN to as a size, and an allocation of that is a fault.
   */
  private countAsSize(count: SemanticValue): void {
    if (!isFloatType(count.type)) {
      this.at(count, USIZE);
      return;
    }
    this.at(count, NUMBER);
    // A NaN leaves every comparison's flags saying unordered, which is the
    // parity bit: a count that is not a number is written as zero, the way the
    // C driver's own count of the same value is.
    const answer = this.code.label("Lcount");
    const done = this.code.label("Lcounted");
    this.code.zeroFloat(XMM1);
    this.code.sseCompare(XMM0, XMM1, false, true);
    this.code.jcc("p", answer);
    this.convert(NUMBER, USIZE);
    this.code.jmp(done);
    this.code.bind(answer);
    this.code.movRegImm(RAX, 0n);
    this.code.bind(done);
  }

  private constant(value: SemanticValue & { k: "const" }): void {
    if (isWideType(value.type)) return;
    if (isFloatType(value.type)) {
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
    if (isWideType(type)) return false;
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
  private apply(operation: Arithmetic, type: SemanticType): void {
    if (isFloatType(type)) {
      if (operation === "add" || operation === "sub" || operation === "mul" || operation === "div") {
        this.code.sse(operation, XMM0, XMM1, widthOf(type) === 4);
      }
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
      case "ushr":
      case "shr":
        // A shift right keeps the sign of a signed number and fills a whole
        // number with zeros of an unsigned one, which is what the sign of the
        // type says; `>>>` is the one that fills with zeros either way. The
        // count is taken at the width the language carries the shift out at,
        // which is the width the sides were promoted to.
        this.code.aluImm("and", RCX, wide ? 63 : 31);
        this.code.shift(shiftOf(operation, type), RAX, wide);
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
      case "floorDiv":
      case "floorMod":
        // A floor division and a floored remainder are the operations of a
        // language whose division rounds towards zero and whose remainder
        // takes the sign of its left side, and this backend has not written
        // them: the division it has is the truncating one.
        throw machineError(
          `${String(fieldOf(this.fn, "symbol"))} performs ${operation}, which this backend has not written`,
          "a floor division and a floored remainder are written by the C backend; build this program as C output, or write the operation as the truncating one it is",
        );
      default:
        throw machineError(`${String(fieldOf(this.fn, "symbol"))} performs ${operation}, which is not an operation of a number`);
    }
  }

  /** One, added to or taken from the value the accumulator has. */
  private one(type: SemanticType, operation: "add" | "sub", register = RAX): void {
    if (isFloatType(type)) {
      const single = widthOf(type) === 4;
      // The destination is named by the caller because a float counter the loop
      // was given a register for is stepped where it lies, and the accumulator a
      // counter with no register of its own is stepped in is XMM0 — which is
      // what the whole-number default is, the two being numbered from one zero.
      this.code.sseMemLabel(operation, register, this.floatLiteral(floatBits(1, single)), single);
      return;
    }
    this.code.aluImm(operation, register, 1, operationWidth(type) === 8);
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
    if (isFloatType(type)) {
      const single = widthOf(type) === 4;
      if (typeof right === "number") {
        // A number the program wrote out is the instruction's own second
        // operand, so the accumulator is compared against the literal where it
        // lies rather than against a copy of it in the scratch: the copy is an
        // instruction on every turn of a loop over limbs, and the test is one
        // of them.
        this.code.sseCompareLabel(XMM0, this.floatLiteral(floatBits(right, single)), single, true);
      } else {
        if (right.register !== null) this.code.movsMove(XMM1, right.register, single);
        else this.code.movsLoad(XMM1, frame(right.offset), single);
        this.code.sseCompare(XMM0, XMM1, single, true);
      }
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
      this.code.aluRegMem("cmp", RAX, frame(fieldOf(right, "offset") as number), true);
      return;
    }
    // Narrower, so the read has to widen the number the way the language reads
    // it before it can be compared as one.
    this.code.movRegMemSized(RCX, frame(fieldOf(right, "offset") as number), operationWidth(type), signedOf(type));
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
  private comparedBranch(type: SemanticType, op: CompareOp, right: Held | number, whenTrue: boolean, label: string, left = RAX): void {
    if (isFloatType(type)) {
      const single = widthOf(type) === 4;
      // The comparison reads two registers, and a side the build gave one of
      // its own is read out of that rather than out of the frame it is not in.
      // `left` is the accumulator already whenever it is that, which is what
      // the whole-number default register is.
      //
      // A side that is a number the program wrote out goes in the accumulator
      // and the named side is compared where it lies, which is the one
      // arrangement where a counter of a loop costs a comparison and nothing
      // else: a copy of the counter into the accumulator is an instruction on
      // every turn of the loop, and the test is one of them.
      if (left !== XMM0) {
        if (typeof right === "number") {
          this.code.movsLoadLabel(XMM0, this.floatLiteral(floatBits(right, single)), single);
          this.floatBranch(op, single, whenTrue, label, left, XMM0);
          return;
        }
      }
      // The comparison names the side it reads where it lies, so a side the
      // build gave a register of its own is compared there and not copied into
      // the accumulator first. The accumulator is where a value is read and
      // written through, and a counter of a loop that has a register of its own
      // is read on every turn of it.
      //
      // The scratch is where a side of the frame is brought to, and a side that
      // is already in a register is one move fewer.
      let where = XMM1;
      if (typeof right === "number") this.code.movsLoadLabel(XMM1, this.floatLiteral(floatBits(right, single)), single);
      else if (String(fieldOf(right, "register")) !== "null") where = fieldOf(right, "register") as number;
      else this.code.movsLoad(XMM1, frame(fieldOf(right, "offset") as number), single);
      this.floatBranch(op, single, whenTrue, label, left, where);
      return;
    }
    const width = operationWidth(type);
    const condition = comparisonCode(op, signedOf(type));
    // Both sides are compared at the width the language promotes them to, and
    // the operand is read at that width too. Reading it as a full register was
    // a 64-bit read of a slot a 32-bit store had written, so the compare ran
    // against whatever the upper half of the frame held: a counted loop whose
    // bound was a small number never reached it and ran until the counter
    // overflowed.
    if (typeof right === "number") {
      this.code.aluImm("cmp", left, right, width === 8);
    } else if (width === 8) {
      // A whole register wide, so the read fills the register and the
      // comparison can read it where it lies rather than through a copy of it
      // in the scratch.
      this.code.aluRegMem("cmp", left, frame(fieldOf(right, "offset") as number), true);
    } else {
      // Narrower, so the read has to widen the number the way the language
      // reads it before it can be compared as one.
      this.code.movRegMemSized(RCX, frame(fieldOf(right, "offset") as number), width, signedOf(type));
      this.code.alu("cmp", left, RCX, false);
    }
    this.code.jcc(whenTrue ? condition : negatedCondition(condition), label);
  }

  /**
   * A branch on a comparison of two floats, answered by the flags themselves.
   *
   * The value form of the same comparison writes two condition bytes and
   * combines them into the accumulator, which is a number a branch then has
   * to test. A branch wants no number, so the comparison is left where it is
   * and the jump reads it there.
   *
   * `UCOMISD` compares without a sign, so a pair that is not numbers sets every
   * flag below the carry and clears every one above it. The two conditions above
   * the carry — `a`, "the destination is above the source", and `ae`, "at or
   * above" — therefore cannot be set by a pair that is not numbers, and they
   * answer all four of the ordered comparisons on their own. Which side has to
   * be the destination for that is what says which pair they are: `a < b` is `b`
   * above `a`, so the right side is the destination for that one, and `a > b` is
   * `a` above `b`, so the left side is for that one.
   *
   * The destination is a register and the source may be an address, so a
   * comparison whose left side is read where it lies can only be made out of the
   * right side. Where that is the case and the comparison is `a > b` or `a >= b`,
   * the conditions below the carry are read instead and gated on the parity bit —
   * two jumps where the other form is one, which is the trade this makes
   * knowingly rather than the one every ordered comparison used to pay.
   *
   * The two comparisons that are not ordered are always gated, and so is an
   * ordered comparison whose left side is an address. A pair that is in no
   * ordered relation is what the parity bit is about: the zero flag and the carry
   * are set on one as they are on the ordered pairs, so nothing but the bit
   * tells the two apart.
   */
  private floatBranch(op: CompareOp, single: boolean, whenTrue: boolean, label: string, left: number | Memory, right: number): void {
    const fromLeft = op === "gt" || op === "ge";
    const carried = fromLeft && typeof left !== "number";
    const above = fromLeft && typeof left === "number" ? left : right;
    const below = above === right ? left : right;
    const gated = op === "eq" || op === "ne" || carried;
    const condition = gated
      ? op === "eq"
        ? "e"
        : op === "ne"
          ? "ne"
          : op === "gt"
            ? "b"
            : "be"
      : op === "lt" || op === "gt"
        ? "a"
        : "ae";
    this.code.sseCompare(above, below, single, true);
    const check = whenTrue ? condition : negatedCondition(condition);
    if (!gated) {
      this.code.jcc(check, label);
      return;
    }
    // What a pair that is in no ordered relation answers is a fact about the
    // comparison rather than about the flags, and it is not the same for all of
    // them: every ordered comparison of one is false, `==` is false, and `!=` is
    // true. The zero flag and the carry are set on such a pair alike as they are
    // on the ordered pairs each condition reads, so the parity bit is the only
    // thing that tells the two apart — and where the branch jumps on an unordered
    // pair the bit is a jump of its own beside the one the condition reads.
    //
    // Where the branch does not jump on one, the condition has to be reached only
    // for an ordered pair, which is two jumps and a label: the pair is stepped
    // over on the way to the condition and again on the way out of it, so an
    // unordered pair never reads the condition at all. That is the case `a != b`
    // is on a branch that runs the arm when it holds, and reading the condition
    // for an unordered pair is what answered it the other way.
    if (whenTrue === (op === "ne")) {
      this.code.jcc("p", label);
      this.code.jcc(check, label);
      return;
    }
    const ordered = this.code.label("Lordered");
    const past = this.code.label("Lpast");
    this.code.jcc("np", ordered);
    this.code.jmp(past);
    this.code.bind(ordered);
    this.code.jcc(check, label);
    this.code.bind(past);
  }

  /**
   * The address a value is read at by the instruction that wants it, or null
   * when there is no such address and the value has to be brought somewhere
   * first.
   *
   * A comparison reads one side and writes no register but the flags, so the
   * side it reads can be the element itself: `a[i] > b[i]` is a read of one of
   * them and a comparison against the other, where the general form reads both
   * sides, holds one of them in a register or in the frame, and reads the other
   * out of that to compare it. On a loop that walks a field value's limbs
   * comparing each limb against another, that is three instructions and two
   * vector register moves out of five instructions and two moves.
   *
   * Which side it is that is carried is not a choice about which side is
   * cheaper. `UCOMISD` compares its destination against its source, and the two
   * forms this serves disagree about which side they put in the destination: a
   * comparison that answers a branch holds the right side in the destination,
   * and one that answers a number holds the left side there. Each of them names
   * memory as the source and so compares the two sides in the order the general
   * form would have, which is what leaves every condition read after it exactly
   * as it was.
   */
  private carriedOperand(value: SemanticValue, type: SemanticType, survives: boolean): Memory | null {
    if (value.k !== "element") return null;
    const element = elementTypeOf(value.of.type) ?? value.type;
    // A use that widens what the array holds is a conversion the instruction has
    // none of, so it is left to the general form rather than read at the wrong
    // width.
    if (!typeEquals(element, value.type)) return null;
    if (!typeEquals(element, type)) return null;
    // An address the instruction is to name as its own operand is built here and
    // used by the caller *after* it has written the other side. What has to
    // survive that is the index, and it survives in one of two ways or in
    // neither: a constant is folded into the displacement and is written down
    // with the address, and a register the convention preserves outlives
    // anything. Everything else does not survive — an index in the frame is read
    // into the scratch, which is a register a call writes its arguments into and
    // over, and an index in a register the convention does not preserve is a
    // register the call is free to have written its own answer into. Either way
    // the element is read at whatever address was left behind, which is not the
    // element the program named. So a carried element is carried only where the
    // other side calls nothing, which is the same question `registerOperand`
    // asks of a carried register. Left to the general form otherwise: the value
    // is written to a slot of its own there, and the slot is not the scratch.
    if (!survives) {
      const index = this.plainIndex(value.index);
      if (typeof index !== "bigint") {
        if (index === null) return null;
        if (index.register === null || ![3, 12, 13, 14].includes(index.register)) return null;
      }
    }
    return this.elementAddress(value.of, value.index, element);
  }

  /**
   * The vector register a value is already sitting in, or null when it is not
   * something an instruction may name as its own operand.
   *
   * Only a name the build gave a register of its own answers, and only where
   * that register is one the instruction may name and the other side does not
   * overwrite while it is being written. `xmm0` is the accumulator this side is
   * combined into, `xmm1` is its scratch, and `xmm2` belongs to the sequences
   * written in place of a call the library would make, so none of the three is
   * ever a place a name is kept and none is named here.
   *
   * Whether the register survives the other side is what `survives` answers. A
   * register the convention preserves outlives anything, so it is named
   * whatever the other side is; one it does not preserve is a register a call
   * writes its arguments into, so it is named only where the other side calls
   * nothing. A value at the other precision than the operation reads is left to
   * the general form, because naming its register would read it at a width the
   * instruction has none of.
   */
  private registerOperand(value: SemanticValue, type: SemanticType, survives: boolean): number | null {
    if (value.k !== "local" || !isFloatType(value.type) || !isFloatType(type)) return null;
    if (widthOf(value.type) !== widthOf(type)) return null;
    const held = this.slot(value.name);
    const register = held.register;
    if (register === null) return null;
    if (register === XMM0 || register === XMM1 || register === XMM2) return null;
    if (!survives && ![6, 7, 8, 9, 10, 11, 12, 13, 14, 15].includes(register)) return null;
    return register;
  }

  /**
   * The label a float the program wrote out is read at, or null when this
   * value cannot be reached there: it is not a literal, it is at the other
   * precision than the operation reads — which would need a conversion the
   * instruction has none of — or the operation has no form that takes memory.
   */
  private floatOperand(value: SemanticValue, type: SemanticType, op: string): string | null {
    if (!isFloatType(type) || value.k !== "const" || !isFloatType(value.type)) return null;
    if (!floatOperation(op) || widthOf(value.type) !== widthOf(type)) return null;
    return this.floatLiteral(floatBits(Number(decimalText(value.text)), widthOf(type) === 4));
  }

  /**
   * The number a comparison could carry on its other side instead of a
   * register, or null when what the value is cannot be written as one.
   *
   * A whole number is carried by the instruction's own immediate field, and a
   * float by the read-only data the instruction reads it out of, so neither is
   * written into a slot of the frame and read back out of it. Every place a
   * comparison is written already has a form that reads its other side from
   * one place or the other; this is what decides which.
   *
   * A float is only carried where the instruction can read it at the precision
   * the comparison is made at, and a whole number only where the immediate
   * fields encode it — a sign-extended byte or a sign-extended word.
   */
  private literalOf(value: SemanticValue, type: SemanticType): number | null {
    if (value.k === "bool") return isFloatType(type) ? null : String(fieldOf(value, "value")) === "true" ? 1 : 0;
    if (value.k !== "const") return null;
    if (isFloatType(type)) {
      // A float the program wrote out at the other precision is a conversion
      // the instruction has no form of, so it is left to the frame.
      if (!isFloatType(fieldOf(value, "type") as SemanticType) || widthOf(fieldOf(value, "type") as SemanticType) !== widthOf(type)) return null;
      const parsed = Number(decimalText(String(fieldOf(value, "text"))));
      // A value that is not a number has no bits to be laid down, and the
      // answer it gives is the one the operation would have given anyway.
      return Number.isNaN(parsed) ? null : parsed;
    }
    const parsed = integerText(String(fieldOf(value, "text")));
    if (parsed < -0x8000_0000n || parsed > 0x7fff_ffffn) return null;
    return Number(parsed);
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
    if (isFloatType(type)) return null;
    if (value.k === "bool") return String(fieldOf(value, "value")) === "true" ? 1 : 0;
    if (value.k !== "const") return null;
    const parsed = integerText(String(fieldOf(value, "text")));
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
    operation: Arithmetic,
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
      case "ushr":
      case "shr":
      case "sar":
        // The count of a shift is taken at the width the language masks it to,
        // and the mask is applied here rather than left to the machine, so the
        // count this form carries is the count the language computes.
        this.code.shiftImm(shiftOf(operation, type), RAX, value & (wide ? 63 : 31), wide);
        return;
      default:
        throw machineError(`${String(fieldOf(this.fn, "symbol"))} performs ${operation} by a number written out, which the machine has no instruction for`);
    }
  }

  private arithmetic(value: SemanticValue & { k: "arith" }): void {
    const type = fieldOf(value, "type") as SemanticType;
    const op = String(fieldOf(value, "op"));
    const leftValue = fieldOf(value, "left") as SemanticValue;
    const rightValue = fieldOf(value, "right") as SemanticValue;
    // A wide number is carried out in four registers rather than in the
    // accumulator, and none of what follows below is written for that: it moves
    // one value through one register and adds it to another, which is not what a
    // number of four limbs is. So the wide case is answered before any of it.
    if (isWideType(type)) {
      this.wideArithmetic(value);
      return;
    }
    if (op === "concat") {
      this.concat(leftValue, rightValue, type);
      return;
    }
    if (op === "arrayConcat") {
      // A list this backend holds is the block the runtime laid out, so two
      // lists are the two blocks joined: the runtime moves the bytes and the
      // answer's header states how many elements it holds.
      this.value(leftValue);
      const left = this.hold(POINTER, "blaze_array_left");
      this.store(left);
      this.value(rightValue);
      const right = this.hold(POINTER, "blaze_array_right");
      this.store(right);
      this.callSymbol("blaze_rt_array_join", [left, right], POINTER);
      return;
    }
    if (op === "pow") {
      this.at(rightValue, NUMBER);
      const right = this.hold(NUMBER, "blaze_right");
      this.store(right);
      this.at(leftValue, NUMBER);
      this.scratchFrom(right);
      this.library("pow");
      return;
    }
    if (op === "min" || op === "max") {
      this.between(value, op === "min");
      return;
    }
    // A right side the program wrote out is carried by the instruction rather
    // than by a slot: an immediate for a whole number, and a literal in the
    // read-only data for a float, so neither is copied into the frame and read
    // back out of it, and the eight bytes the copy lived in are not reserved
    // at all. A sum and a product take their sides either way round, so a
    // literal on either side is carried by the instruction; a difference and a
    // quotient may not, and a literal is only the left side of those. The side
    // that is not the literal is written once whichever form is taken, so the
    // question is settled before it is evaluated.
    const commutative = op === "add" || op === "mul";
    const onRight = this.floatOperand(rightValue, type, op);
    const literal = onRight ?? (commutative ? this.floatOperand(leftValue, type, op) : null);
    if (literal !== null) {
      // A quotient by a power of two is the same number as a product by the
      // reciprocal, and the product is three times quicker. A difference and a
      // quotient may not take their sides either way round, so the literal here
      // is always the divisor and the value is already in the accumulator.
      const reciprocal =
        op === "div" && rightValue.k === "const" ? reciprocalOfTwo(Number(decimalText(String(fieldOf(rightValue, "text"))))) : null;
      this.at(onRight === null ? rightValue : leftValue, type);
      this.code.sseMemLabel(
        reciprocal === null ? (op as "add" | "sub" | "mul" | "div") : "mul",
        XMM0,
        reciprocal === null ? literal : this.floatLiteral(floatBits(reciprocal, widthOf(type) === 4)),
        widthOf(type) === 4,
      );
      this.normalizeArithmetic(type);
      return;
    }
    const immediate = this.immediateOf(rightValue, type);
    if (immediate !== null && immediateOperation(String(fieldOf(value, "op")))) {
      this.at(leftValue, type);
      this.applyImmediate(op as "add" | "sub" | "mul" | "shl" | "shr" | "ushr" | "sar" | "and" | "or" | "xor", type, immediate);
      this.normalizeArithmetic(type);
      return;
    }
    // A float operation reads its other side out of the frame itself, so the
    // side that is not in the accumulator when the operation is written is
    // stored once and the instruction does the reading, which is one
    // instruction instead of the pair that reads a value out and then
    // operates on it. A sum and a product take their sides either way round,
    // which also means the right side is never written down: a call that
    // answers into the accumulator is consumed where it lands. A difference
    // and a quotient may not, so they keep the order they had.

    // Where the other side already lies, the instruction is named at it rather
    // than at a copy of it: a side read out of an array is carried as the
    // instruction's own memory operand, exactly as a comparison already carries
    // one, and a side the build gave a register of its own is carried as that
    // register. Either way the side is never copied into the frame and read
    // back out of it, and the accumulator holds the other side.
    //
    // Which side is carried decides which one the accumulator takes, so this is
    // settled before either side is written. A sum and a product take their
    // sides either way round, so either may be the one carried; a difference
    // and a quotient may not, so only their right side can be.
    //
    // A carried side is never evaluated at all. That is sound for an element
    // because `carriedOperand` answers only where the address can be named
    // outright — a base and an index and nothing else, with no call and no
    // effect in either — and sound for a register because the register is one
    // the convention preserves, or is named only where the other side calls
    // nothing and so writes nothing over it.
    if (isFloatType(type) && floatOperation(String(fieldOf(value, "op")))) {
      const operation = op as "add" | "sub" | "mul" | "div";
      const commutative = operation === "add" || operation === "mul";
      const single = widthOf(type) === 4;
      // The side the accumulator does not take, which is the only one a
      // difference and a quotient can carry.
      const carriedSide = commutative ? leftValue : rightValue;
      const carried = this.carriedOperand(carriedSide, type, !hasCall(commutative ? rightValue : leftValue));
      if (carried !== null) {
        this.at(commutative ? rightValue : leftValue, type);
        this.code.sseMem(operation, XMM0, carried, single);
        this.normalizeArithmetic(type);
        return;
      }
      // A sum and a product may hand the other side over instead, which is the
      // same instruction with the element on the other side of it.
      if (commutative) {
        const other = this.carriedOperand(rightValue, type, !hasCall(leftValue));
        if (other !== null) {
          this.at(leftValue, type);
          this.code.sseMem(operation, XMM0, other, single);
          this.normalizeArithmetic(type);
          return;
        }
      }
      // A side the build already gave a register of its own is carried by that
      // register instead, which is the same instruction with the copy into the
      // frame and the read back out of it left out.
      const parkedSide = commutative ? leftValue : rightValue;
      const parkedOther = commutative ? rightValue : leftValue;
      const parked = this.registerOperand(parkedSide, type, !hasCall(parkedOther));
      if (parked !== null) {
        this.at(parkedOther, type);
        this.code.sse(operation, XMM0, parked, single);
        this.normalizeArithmetic(type);
        return;
      }
      // A sum and a product may hand the other side over instead, which is the
      // same instruction with the name on the other side of it.
      if (commutative) {
        const other = this.registerOperand(rightValue, type, !hasCall(leftValue));
        if (other !== null) {
          this.at(leftValue, type);
          this.code.sse(operation, XMM0, other, single);
          this.normalizeArithmetic(type);
          return;
        }
      }
    }
    if (isFloatType(type)) {
      const commutative = op === "add" || op === "mul";
      this.at(commutative ? leftValue : rightValue, type);
      // This side is held in a register where the function has one free and in
      // the frame where it has not. The instruction below then reads it as its
      // own operand — a memory operand for the frame, a register for the
      // register — so either way the copy out of the accumulator and the read
      // back into the scratch are the two instructions this replaces.
      //
      // It used to be the frame every time. A function whose arithmetic is in a
      // loop is given three vector registers of its own for the values of its
      // expressions, and none of them was ever taken: the two sides of an
      // arithmetic went through the frame whatever was free, and the registers
      // were saved by the prologue and read back by the epilogue on every call
      // without ever holding anything. What they were reserved for is what they
      // are given here.
      //
      // The side was just evaluated, so where a register is free the parking
      // is a move out of the accumulator and not a write through the frame —
      // and the instruction that reads it back reads a register, which a store
      // and a load of the same eight bytes never answered as quickly.
      const memory = this.reserveSlot(type, commutative ? "blaze_left" : "blaze_right", true, null, undefined);
      this.borrowed.push(memory);
      if ((fieldOf(memory, "register") as number | null) !== null) {
        this.code.movsMove(fieldOf(memory, "register") as number, XMM0, widthOf(type) === 4);
      } else {
        this.store(memory);
      }
      this.at(commutative ? rightValue : leftValue, type);
      if ((fieldOf(memory, "register") as number | null) === null) {
        this.code.sseMem(op as "add" | "sub" | "mul" | "div", XMM0, frame(fieldOf(memory, "offset") as number), widthOf(type) === 4);
        this.normalizeArithmetic(type);
        return;
      }
      this.code.sse(op as "add" | "sub" | "mul" | "div", XMM0, fieldOf(memory, "register") as number, widthOf(type) === 4);
      this.normalizeArithmetic(type);
      return;
    }
    // A side the build gave a register of its own is carried by that register,
    // which is the same instruction with the copy into the frame and the read
    // back out of it left out. The accumulator takes the other side, which is
    // the order this already wrote them in, and the register is not the
    // accumulator's own or the scratch register's — the instruction names it
    // rather than moving into either, so neither is clobbered on the way.
    //
    // A sum and a product take their sides either way round, so either may be
    // the one carried; a difference and a quotient may not, so only their right
    // side can be. A carried side is never evaluated at all, which is sound for
    // a register because the register is one the convention preserves, or is
    // named only where the other side calls nothing and so writes nothing over
    // it.
    const named = this.integerOperand(value, type);
    if (named !== null) {
      // The side the register is the answer for, and the one the accumulator has
      // to be written from: the carried side is never evaluated at all.
      const carriedLeft = String(fieldOf(named, "carried")) === "left";
      this.at(carriedLeft ? rightValue : leftValue, type);
      this.applyRegister(
        fieldOf(named, "operation") as "add" | "sub" | "mul" | "and" | "or" | "xor",
        type,
        fieldOf(named, "register") as number,
      );
      this.normalizeArithmetic(type);
      return;
    }
    this.at(rightValue, type);
    const right = this.hold(type, "blaze_right");
    this.store(right);
    this.at(leftValue, type);
    this.scratchFrom(right);
    this.apply(op as Arithmetic, type);
    this.normalizeArithmetic(type);
  }

  /**
   * The operation, the register and the side one side of an arithmetic of whole
   * numbers could be written at rather than read out of the frame, or null where
   * no side of it could be.
   *
   * It is the answer `registerOperand` gives for a floating point operation, over
   * the whole numbers the general path below is written for: the frame round trip
   * this skips is two instructions and a store-to-load forwarding on every
   * whole-number operation whose other side the build gave a register, and a
   * carry chain is one long run of exactly those.
   *
   * A sum and a product take their sides either way round, so either of them may
   * be the carried one and the side the accumulator already holds is the one the
   * other is written at: asking for the held side is the instruction that is
   * saved, and a limb added to a carry is one instruction where it was three.
   * A difference and a quotient may not, so only their right side is a candidate
   * there.
   */
  private integerOperand(
    value: SemanticValue & { k: "arith" },
    type: SemanticType,
  ): {
    operation: Extract<Arithmetic, "add" | "sub" | "mul" | "and" | "or" | "xor">;
    register: number;
    carried: "left" | "right";
  } | null {
    if (isFloatType(type) || isWideType(type)) return null;
    // Only the operations `applyRegister` writes are asked for here: a shift
    // takes its count in the scratch register the general path masks it in, and a
    // division needs both halves of the double width in the two registers the
    // general path sets up, and neither names a register of its own.
    const op = String(fieldOf(value, "op"));
    if (op !== "add" && op !== "sub" && op !== "mul" && op !== "and" && op !== "or" && op !== "xor") return null;
    const commutative = op === "add" || op === "mul";
    const sides: boolean[] = commutative ? [true, false] : [false];
    // The side the accumulator already holds is the one the operation is written
    // from — asking for the other is the instruction that is saved. `load`
    // answers the same question for a slot; this is the one for a value the
    // statement has just computed and not written down yet.
    if (commutative && this.heldByAccumulator(fieldOf(value, "left") as SemanticValue) && !this.heldByAccumulator(fieldOf(value, "right") as SemanticValue)) sides.reverse();
    for (const carried of sides) {
      const side = carried ? fieldOf(value, "left") as SemanticValue : fieldOf(value, "right") as SemanticValue;
      const other = carried ? fieldOf(value, "right") as SemanticValue : fieldOf(value, "left") as SemanticValue;
      if (side.k !== "local" || !isInteger(fieldOf(side, "type") as SemanticType) || !isInteger(type)) continue;
      if (widthOf(fieldOf(side, "type") as SemanticType) !== widthOf(type)) continue;
      const register = fieldOf(this.slot(String(fieldOf(side, "name"))), "register") as number | null;
      // The accumulator and the scratch register are where the operation is
      // written, and the stack and base pointers are not values a program has.
      if (String(register) === "null" || register === RAX || register === RCX || register === RDX) continue;
      if (register === RSP || register === RBP) continue;
      if (hasCall(other) && ![3, 12, 13, 14].includes(register as number)) continue;
      return {
        operation: op as Extract<Arithmetic, "add" | "sub" | "mul" | "and" | "or" | "xor">,
        register: register as number,
        carried: carried ? "left" : "right",
      };
    }
    return null;
  }

  /**
   * Whether the accumulator already holds the value a name reads, which is what
   * makes asking for it cost nothing. A slot's own identity is what says so:
   * two values of the same shape are not one value, and a name read twice is one
   * read the accumulator can answer.
   */
  private heldByAccumulator(value: SemanticValue): boolean {
    const accumulator = this.accumulatorNote;
    if (value.k !== "local" || accumulator === null) return false;
    if ((fieldOf(accumulator, "at") as number) !== this.code.written) return false;
    const held = this.slots.get(this.names.read(String(fieldOf(value, "name"))));
    return held !== undefined && (fieldOf(held, "id") as number) === (fieldOf(accumulator, "id") as number);
  }

  /**
   * An arithmetic of whole numbers with one of its sides named at a register.
   *
   * The operations it is written for are the ones `integerOperand` admits, which
   * is the whole list: a sum, a difference and the three bitwise operations take
   * the second side as a register operand, and a product is the one instruction
   * of them that names its other side rather than reading it.
   */
  private applyRegister(operation: Extract<Arithmetic, "add" | "sub" | "mul" | "and" | "or" | "xor">, type: SemanticType, source: number): void {
    this.applyRegisterInto(operation, type, RAX, source);
  }

  /**
   * The same operation, written at a register of its own rather than at the
   * accumulator.
   *
   * The accumulator is where a value is read and written through, so an
   * operation over a value the build gave a register of its own was a move into
   * the accumulator, the operation there and a move back out again. The
   * instruction takes its operand wherever it is, so naming the register is the
   * same number without the two moves.
   */
  private applyRegisterInto(
    operation: Extract<Arithmetic, "add" | "sub" | "mul" | "and" | "or" | "xor">,
    type: SemanticType,
    destination: number,
    source: number,
  ): void {
    const wide = operationWidth(type) === 8;
    if (operation === "mul") {
      this.code.imul(destination, source, wide);
      return;
    }
    this.code.alu(operation, destination, source, wide);
  }

  /* ---------------------------------------------------------------------- */
  /* Wide numbers                                                           */
  /* ---------------------------------------------------------------------- */

  /** The address of one limb of a wide number held in the frame. */
  private limbOf(offset: number, limb: number): Memory {
    return frame(offset + limb * LIMB_BYTES);
  }

  /**
   * How many limbs a wide number of this type is written as.
   *
   * The count is the IR's rather than this backend's, because it is a fact about
   * the number and not about how it is carried here: a backend that decided its
   * own would agree with this one only for as long as both were right.
   */
  private limbsOf(type: SemanticType): number {
    return type.kind === "primitive" ? limbsOfName(type.name) ?? 0 : 0;
  }

  /**
   * Four limbs brought into the working registers from a slot of the frame.
   *
   * This is a wide number's answer to `load`, and the one thing about it worth
   * saying is that the accumulator is left alone: a wide value is not in `rax`
   * and nothing downstream may read it from there.
   */
  private wideLoad(held: Held): void {
    const limbs = this.limbsOf(fieldOf(held, "type") as SemanticType);
    for (let limb = 0; limb < limbs; limb += 1) {
      this.code.movRegMemSized([8, 9, 10, 11][limb], this.limbOf(held.offset, limb), 8, false);
    }
  }

  /**
   * The four limbs in the working registers written down to a slot of the frame,
   * which is a wide number's answer to `store`.
   */
  private wideStore(held: Held): void {
    const limbs = this.limbsOf(held.type);
    for (let limb = 0; limb < limbs; limb += 1) {
      this.code.movMemRegSized(this.limbOf(held.offset, limb), [8, 9, 10, 11][limb], 8);
    }
  }

  /**
   * The slot a wide value already sits in, or null when it has to be built.
   *
   * A name of a wide number lives in the frame as its four limbs and the
   * runtime kernels take the address of a value, so a call whose argument is
   * that name can be handed the address of the slot rather than a copy of the
   * limbs: four loads and four stores that say nothing, on every wide call a
   * loop makes. A name that is not wide has no four limbs to hand over, and a
   * name the liveness pass pinned lives in a register and not in the frame at
   * all — a wide number is never pinned, but the test is the one that keeps
   * this true if that ever changes.
   */
  private wideLocalSlot(value: SemanticValue): Held | null {
    if (value.k !== "local" || !isWideType(value.type)) return null;
    const held = this.slot(value.name);
    if (!isWideType(held.type) || held.register !== null) return null;
    return held;
  }

  /**
   * A slot whose four limbs hold a wide argument of a runtime kernel.
   *
   * The slot a name already lives in is used as it is; anything else is
   * computed into a slot borrowed for the statement. The address the kernel is
   * handed is the slot's either way.
   *
   * The slot is as wide as the call reads its arguments, and not as wide as the
   * value happens to be: a kernel reads four limbs whatever the source wrote,
   * so a machine word handed to one is widened into four limbs — and a slot
   * reserved for the machine word would be the first limb and three of the
   * frame beside it.
   */
  private wideArgument(value: SemanticValue, prefix: string, wide: SemanticType): Held {
    const direct = this.wideLocalSlot(value);
    if (direct !== null) return direct;
    const held = this.hold(wide, prefix);
    this.wideValue(value);
    this.wideStore(held);
    return held;
  }

  /**
   * A wide call written with its answer in `out`, which is the slot the answer
   * was going to be copied to anyway.
   *
   * A call whose answer is bound by the statement that makes it is the common
   * case — every modular operation of a curve's formulas is one — and writing
   * the answer straight to the binding's slot saves the four loads and four
   * stores of copying it there.
   *
   * `u256_div` and `u256_invert_mod` are not written this way: the division
   * kernel clears the quotient before it reads the dividend, and the inversion
   * clears the answer before it reads the value, so an answer written over an
   * operand would clear the operand with it. The modular kernels read each limb
   * before they write the limb over it, so the callers allow the aliasing those
   * two do not.
   */
  private wideKernelCall(value: SemanticValue & { k: "call" }, out: Held): void {
    const call = fieldOf(value, "call") as SemanticCall;
    const args = fieldOf(call, "args") as readonly SemanticValue[];
    const callee = String(fieldOf(call, "callee"));
    const type = fieldOf(value, "type") as SemanticType;
    if (callee === "u256_div") {
      const left = this.wideArgument(args[0], "blaze_wide_left", type);
      const right = this.wideArgument(args[1], "blaze_wide_right", type);
      this.code.leaMemReg(mem(RSP, fieldOf(out, "offset") as number), RDI);
      this.code.leaMemReg(mem(RSP, fieldOf(left, "offset") as number), RSI);
      this.code.leaMemReg(mem(RSP, fieldOf(right, "offset") as number), RDX);
      this.library(`${RUNTIME_NAME}_u256_div`);
      return;
    }
    if (callee === "u256_invert_mod") {
      const operand = this.wideArgument(args[0], "blaze_wide_left", type);
      const mod = this.wideArgument(args[1], "blaze_wide_right", type);
      this.code.leaMemReg(mem(RSP, fieldOf(out, "offset") as number), RDI);
      this.code.leaMemReg(mem(RSP, fieldOf(operand, "offset") as number), RSI);
      this.code.leaMemReg(mem(RSP, fieldOf(mod, "offset") as number), RDX);
      this.library(`${RUNTIME_NAME}_u256_invert_mod`);
      return;
    }
    // A modulus the compiler has read is a modulus whose reduction is known:
    // the product is reduced by a word rather than by the general reduction,
    // and an addition and a subtraction are the limb chains they are rather
    // than a call that works out which kind of modulus it was handed.
    if (callee === "u256_add_mod" || callee === "u256_sub_mod" || callee === "u256_mul_mod") {
      const c = specialPrimeC(args[2]);
      if (c !== null) {
        if (callee === "u256_add_mod") {
          this.wideAddModSpecial(value, out, c);
          return;
        }
        if (callee === "u256_sub_mod") {
          this.wideSubModSpecial(value, out, c);
          return;
        }
        const left = this.wideArgument(args[0], "blaze_wide_left", type);
        const right = this.wideArgument(args[1], "blaze_wide_right", type);
        this.code.leaMemReg(mem(RSP, fieldOf(out, "offset") as number), RDI);
        this.code.leaMemReg(mem(RSP, fieldOf(left, "offset") as number), RSI);
        this.code.leaMemReg(mem(RSP, fieldOf(right, "offset") as number), RDX);
        this.code.movRegImm(RCX, c);
        this.library(`${RUNTIME_NAME}_u256_mul_mod_special`);
        return;
      }
    }
    const suffix = callee.slice("u256_".length);
    const left = this.wideArgument(args[0], "blaze_wide_left", type);
    const right = this.wideArgument(args[1], "blaze_wide_right", type);
    const mod = this.wideArgument(args[2], "blaze_wide_mod", type);
    this.code.leaMemReg(mem(RSP, fieldOf(out, "offset") as number), RDI);
    this.code.leaMemReg(mem(RSP, fieldOf(left, "offset") as number), RSI);
    this.code.leaMemReg(mem(RSP, fieldOf(right, "offset") as number), RDX);
    this.code.leaMemReg(mem(RSP, fieldOf(mod, "offset") as number), RCX);
    this.library(`${RUNTIME_NAME}_u256_${suffix}`);
  }

  /**
   * `(left + right) mod 2^256 - c`, in the four limb chain the sum is.
   *
   * Both operands are residues, so the sum is below twice the modulus. The
   * carry out of the top limb is the 2^256 the sum went past, which is c
   * modulo this modulus: adding c to what is left brings the answer back
   * below it, and it cannot carry again because what is left is more than 2c
   * under 2^256. A sum that did not carry is below twice the modulus, so it
   * needs at most the one subtraction of the modulus that follows.
   */
  private wideAddModSpecial(value: SemanticValue & { k: "call" }, out: Held, c: bigint): void {
    const call = fieldOf(value, "call") as SemanticCall;
    const args = fieldOf(call, "args") as readonly SemanticValue[];
    const type = fieldOf(value, "type") as SemanticType;
    const right = this.wideArgument(args[1], "blaze_wide_right", type);
    this.wideValue(args[0]);
    this.code.aluRegMem("add", [8, 9, 10, 11][0], this.limbOf(fieldOf(right, "offset") as number, 0), true);
    for (let limb = 1; limb < 4; limb += 1) {
      this.code.aluRegMem("adc", [8, 9, 10, 11][limb], this.limbOf(fieldOf(right, "offset") as number, limb), true);
    }
    const carried = this.code.label("LwideCarried");
    const done = this.code.label("LwideAddDone");
    this.code.jcc("ae", carried);
    // The sum carried: what is left plus c is the answer, already below the
    // modulus. The carry out of the low limb is spent on a register that is
    // zero before the addition, because the accumulator is cleared with an
    // `xor` and a flags-writing instruction between the two halves of the chain
    // would drop the carry it is carrying.
    this.code.alu("xor", RDX, RDX, false);
    this.code.movRegImm(RAX, c);
    this.code.alu("add", [8, 9, 10, 11][0], RAX, true);
    for (let limb = 1; limb < 4; limb += 1) this.code.alu("adc", [8, 9, 10, 11][limb], RDX, true);
    this.wideStore(out);
    this.code.jmp(done);
    this.code.bind(carried);
    // The sum did not carry. The sum is written down first because it is the
    // answer when the subtraction of the modulus borrows.
    this.wideStore(out);
    this.subtractModulus(c);
    this.code.jcc("b", done);
    this.wideStore(out);
    this.code.bind(done);
  }

  /**
   * `(left - right) mod 2^256 - c`, in the four limb chain the difference is.
   *
   * A difference that did not borrow is a residue below the modulus. A
   * difference that borrowed is the answer plus 2^256, so subtracting c, which
   * is 2^256 modulo the modulus, is the answer itself.
   */
  private wideSubModSpecial(value: SemanticValue & { k: "call" }, out: Held, c: bigint): void {
    const call = fieldOf(value, "call") as SemanticCall;
    const args = fieldOf(call, "args") as readonly SemanticValue[];
    const type = fieldOf(value, "type") as SemanticType;
    const right = this.wideArgument(args[1], "blaze_wide_right", type);
    this.wideValue(args[0]);
    this.code.aluRegMem("sub", [8, 9, 10, 11][0], this.limbOf(fieldOf(right, "offset") as number, 0), true);
    for (let limb = 1; limb < 4; limb += 1) {
      this.code.aluRegMem("sbb", [8, 9, 10, 11][limb], this.limbOf(fieldOf(right, "offset") as number, limb), true);
    }
    const done = this.code.label("LwideSubDone");
    this.code.jcc("ae", done);
    // The borrow was `2^256`, which is c modulo this modulus, so c is taken
    // off the chain. The register the borrow is spent on is zeroed before the
    // subtraction, because clearing it after would clear the borrow too.
    this.code.alu("xor", RDX, RDX, false);
    this.code.movRegImm(RAX, c);
    this.code.alu("sub", [8, 9, 10, 11][0], RAX, true);
    for (let limb = 1; limb < 4; limb += 1) this.code.alu("sbb", [8, 9, 10, 11][limb], RDX, true);
    this.code.bind(done);
    this.wideStore(out);
  }

  /** The four limbs in the working registers minus `2^256 - c`, leaving the
   *  borrow in the carry flag.
   *
   * No limb of a special prime's modulus is zero — the low one is `2^64 - c`
   * and the three above it are all ones — so loading one is a move and never
   * the `xor` the lowering uses to write a zero, which would clear the borrow
   * the chain is carrying. */
  private subtractModulus(c: bigint): void {
    const modulus = (1n << 256n) - c;
    for (let limb = 0; limb < 4; limb += 1) {
      this.code.movRegImm(RAX, (modulus >> BigInt(limb * 64)) & 0xffffffffffffffffn);
      this.code.alu(limb === 0 ? "sub" : "sbb", [8, 9, 10, 11][limb], RAX, true);
    }
  }

  /** Whether a call is one of the wide kernels, whose answer is one slot. */
  private isWideKernelCall(value: SemanticValue): value is SemanticValue & { k: "call" } {
    if (value.k !== "call") return false;
    const call = fieldOf(value, "call") as SemanticCall;
    const callee = String(fieldOf(call, "callee"));
    if (callee === "u256_div" || callee === "u256_invert_mod") return true;
    if (callee !== "u256_add_mod" && callee !== "u256_sub_mod" && callee !== "u256_mul_mod") return false;
    return (fieldOf(call, "args") as readonly SemanticValue[]).length === 3;
  }

  /** Whether an expression reads a name, anywhere inside it. */
  private reads(value: SemanticValue, name: string): boolean {
    let found = false;
    walkValues(value, (one) => {
      if (one.k === "local" && String(fieldOf(one, "name")) === name) found = true;
    });
    return found;
  }

  /**
   * A wide value bound to a slot: a kernel's answer is written into it, and
   * anything else is computed and copied.
   *
   * The answer is not written over an operand of the same call, which is the
   * one case the modular kernels do not allow: `x = (x * y) mod m` would hand
   * the kernel the slot it writes and the slot it reads from at once, and
   * whether that is the same program depends on the kernel's own order. The
   * name is read out of the value rather than assumed, so the direct write is
   * taken exactly where it is known to be the same answer.
   */
  private wideBind(name: string, held: Held, value: SemanticValue): void {
    const call = value.k === "call" ? fieldOf(value, "call") as SemanticCall : null;
    const callee = call === null ? "" : String(fieldOf(call, "callee"));
    const aliasing = callee === "u256_div" || callee === "u256_invert_mod";
    if (this.isWideKernelCall(value) && !aliasing && !this.reads(value, name)) {
      this.wideKernelCall(value, held);
      return;
    }
    // A function that answers a wide number writes it through the address it
    // is handed, so the binding's own slot is the address when nothing in the
    // call reads the name — the same saving the kernels take, for the same
    // reason: the answer was going to be copied there anyway.
    if (call !== null && String(fieldOf(call, "builtin")) !== "true" &&
        isWideType(fieldOf(value, "type") as SemanticType) && !this.reads(value, name)) {
      this.callValue(call, fieldOf(value, "type") as SemanticType, held);
      return;
    }
    this.wideValue(value);
    this.wideStore(held);
  }

  /**
   * A wide number written into the working registers.
   *
   * A literal is one instruction per limb, because a limb is a whole machine
   * word and `mov` writes one: a constant wider than a word is not one
   * instruction at any width, and the only question is how many.
   */
  private wideValue(value: SemanticValue): void {
    const type = fieldOf(value, "type") as SemanticType;
    // A const literal is widened to four limbs even when it was typed `i64`
    // (a whole number that does not fit in one word): the const's text is the
    // full value, so every limb is written rather than sign-extending one word.
    if (value.k === "const") {
      const whole = integerLiteral(String(fieldOf(value, "text"))) ?? 0n;
      for (let limb = 0; limb < 4; limb += 1) {
        this.code.movRegImm([8, 9, 10, 11][limb], (whole >> BigInt(limb * 64)) & 0xffffffffffffffffn);
      }
      return;
    }
    // A value a use reads as a wide number is not always one the source wrote
    // as one, and the cases below each answer a value that already is.
    if (!isWideType(type)) {
      this.wideFrom(value);
      return;
    }
    switch (value.k) {
      case "local": {
        const held = this.slot(String(fieldOf(value, "name")));
        // The name is read at the width of a wide number while the slot holds
        // one machine word, so the three limbs above that word are the rest of
        // the frame rather than the number the source wrote.
        if (!isWideType(fieldOf(held, "type") as SemanticType)) {
          this.wideFrom(value);
          return;
        }
        this.wideLoad(held);
        return;
      }
      case "arith":
        this.wideArithmetic(value);
        return;
      case "loadField": {
        // A wide field is four limbs at the field's offset of the object the
        // read is written of, so the object is read into a register and each
        // limb is read from where the field holds it.
        const found = this.field(String(fieldOf(value, "layout")), String(fieldOf(value, "field")));
        const offset = fieldOf(found, "offset") as number;
        this.value(fieldOf(value, "object") as SemanticValue);
        for (let limb = 0; limb < this.limbsOf(type); limb += 1) {
          this.code.movRegMemSized([8, 9, 10, 11][limb], mem(RAX, offset + limb * LIMB_BYTES), 8, false);
        }
        return;
      }
      case "unary":
        this.wideUnary(value);
        return;
      case "select":
        this.wideSelect(value);
        return;
      case "call": {
        // `u256_from_u64x2(low, high)` builds a u256 from two 64 bit halves:
        // low becomes limb 0, high becomes limb 1, and the upper two limbs are
        // zero. `u256_from_u64x4(l0, l1, l2, l3)` builds a u256 from four
        // 64 bit limbs, least significant first. Nothing else a call returns
        // can be read as a wide number yet.
        const call = fieldOf(value, "call") as SemanticCall;
        const args = fieldOf(call, "args") as readonly SemanticValue[];
        const callee = String(fieldOf(call, "callee"));
        if (callee === "u256_from_u64x2") {
          this.at(args[0], U64);
          this.code.movRegReg([8, 9, 10, 11][0], RAX);
          this.at(args[1], U64);
          this.code.movRegReg([8, 9, 10, 11][1], RAX);
          this.code.alu("xor", [8, 9, 10, 11][2], [8, 9, 10, 11][2], false);
          this.code.alu("xor", [8, 9, 10, 11][3], [8, 9, 10, 11][3], false);
          return;
        }
        if (callee === "u256_from_u64x4") {
          for (let limb = 0; limb < 4; limb += 1) {
            this.at(args[limb], U64);
            this.code.movRegReg([8, 9, 10, 11][limb], RAX);
          }
          return;
        }
        // Modular arithmetic: (left op right) mod mod, computed by the runtime
        // kernel without u256 wraparound issues.
        if (
          callee === "u256_add_mod" ||
          callee === "u256_sub_mod" ||
          callee === "u256_mul_mod"
        ) {
          const out = this.hold(type, "blaze_wide_out");
          this.wideKernelCall(value, out);
          this.wideLoad(out);
          return;
        }
        // Integer division: left / right.
        if (callee === "u256_div") {
          const out = this.hold(type, "blaze_wide_out");
          this.wideKernelCall(value, out);
          this.wideLoad(out);
          return;
        }
        // The inverse of a value modulo a modulus: the binary extended
        // Euclidean kernel's answer.
        if (callee === "u256_invert_mod") {
          const out = this.hold(type, "blaze_wide_out");
          this.wideKernelCall(value, out);
          this.wideLoad(out);
          return;
        }
        // Any other function that answers a wide number: the convention hands
        // a value of that size back through memory, so a slot of this body's
        // frame is where the answer goes and its address is the first argument.
        // The callee takes it out of `rdi` before it binds anything (see
        // `parameters`), so the two sides agree on where the answer is.
        const out = this.hold(type, "blaze_wide_call");
        this.callValue(call, type, out);
        this.wideLoad(out);
        return;
      }
      default:
        throw machineError(
          `a wide number is not built from a ${value.k}`,
          "a wide number is a literal, a name, or the answer to an operation on two of those, and nothing else yet",
        );
    }
  }

  /**
   * A whole number widened into the limbs of a wide number.
   *
   * A value a wide number is asked for is not always one: a parameter of a
   * wide number is handed a whole number as often as not, and the whole number
   * is the machine word the low limb holds with three limbs of nothing above
   * it. This is the widening every backend answers with, and it is what stands
   * between a program and four limbs read out of a frame slot that only ever
   * held one of them.
   */
  private wideFrom(value: SemanticValue): void {
    const type = fieldOf(value, "type") as SemanticType;
    if (isFloatType(type)) {
      throw machineError(
        `a ${type.kind === "primitive" ? type.name : "f64"} is handed to a use that reads a wide number`,
        "a wide number is four limbs and a double is not a set of them: the kernel every backend widens with takes one machine word, so only a whole number has a limb in it",
      );
    }
    this.at(value, type);
    this.code.movRegReg([8, 9, 10, 11][0], RAX);
    // A widening into a signed wide number sign-extends: the upper limbs are a
    // copy of the low one shifted arithmetically so every bit above it is the
    // sign bit. An unsigned one zeroes them.
    const signed = signedOf(type);
    for (let limb = 1; limb < [8, 9, 10, 11].length; limb += 1) {
      if (signed) {
        this.code.movRegReg([8, 9, 10, 11][limb], RAX);
        this.code.shiftImm("sar", [8, 9, 10, 11][limb], 63);
      } else {
        this.code.alu("xor", [8, 9, 10, 11][limb], [8, 9, 10, 11][limb], false);
      }
    }
  }

  /**
   * An operation on two wide numbers, carried out in the working registers.
   *
   * The left side is written to a slot of the frame and the right side is left
   * in the working registers, and the operation is then a chain over the right
   * reading the left out of memory a limb at a time. That is what makes a sum
   * seven instructions rather than a call with three addresses prepared for it:
   * the carry travels in the flags between one limb and the next, and nothing is
   * written down and read back in the middle of it.
   *
   * A product and a quotient are the two the machine has no instruction for, and
   * they are the kernel's rather than this file's — which is why they are the
   * only two below that are not written here.
   */
  private wideArithmetic(value: SemanticValue & { k: "arith" }): void {
    const type = value.type;
    const limbs = this.limbsOf(type);
    if (value.op === "mul" || value.op === "div" || value.op === "mod") {
      // BREAK_POINT_FOR_TESTING
      this.wideKernel(value.op, value.left, value.right, type);
      return;
    }
    if (value.op === "shl" || value.op === "shr") {
      this.wideShift(value, value.op);
      return;
    }
    const plain =
      value.op === "add" || value.op === "sub" || value.op === "and" || value.op === "or" || value.op === "xor"
        ? value.op
        : null;
    if (plain === null) {
      throw machineError(
        `a wide ${value.op} is not written in this backend`,
        "a wide number adds, subtracts and combines bitwise here, and multiplies, divides and takes a remainder through the wide kernel",
      );
    }
    // The right side is answered first and written to a slot, and the left is
    // left in the working registers. That is the order the rest of this backend
    // evaluates an operation in — the answer of the right is not the answer, and
    // the one that is has to be last in the registers — and it is what makes a
    // difference and a quotient the left taken from the right rather than the
    // other way round. An addition and a product would not notice the two being
    // the wrong way about, which is the reason this is the order and not
    // whichever happened to be written first.
    //
    // A second quad in registers is not available, so the right side is a slot:
    // the six registers the convention does not preserve are six and a wide
    // number is four of them.
    const right = this.hold(type, "blaze_wide_right");
    this.wideValue(value.right);
    this.wideStore(right);
    this.wideValue(value.left);
    // The first limb does not read the carry the one before it left, because
    // there is no one before it; every limb after it does, which is the whole
    // difference between an addition of four limbs and four additions. The three
    // bitwise combinations read none, because a carry means nothing to them and
    // reading one would add it to a value that never carried.
    if (bmi2OnItsOwn(this.target) && value.op === "add") {
      // BMI2: `adcx` reads and writes CF without touching the other flags, so
      // the carry chain does not serialise on the whole flags register. The
      // first limb is a plain add (it sets CF), and each limb after it folds
      // the carry in with `adcx`.
      this.code.movRegMemSized(RAX, this.limbOf(right.offset, 0), 8, false);
      this.code.alu("add", [8, 9, 10, 11][0], RAX, true);
      for (let limb = 1; limb < limbs; limb += 1) {
        this.code.movRegMemSized(RAX, this.limbOf(right.offset, limb), 8, false);
        this.code.adcx([8, 9, 10, 11][limb], RAX);
      }
    } else {
      const carry = value.op === "add" ? "adc" : value.op === "sub" ? "sbb" : null;
      this.code.aluRegMem(plain, [8, 9, 10, 11][0], this.limbOf(right.offset, 0), true);
      for (let limb = 1; limb < limbs; limb += 1) {
        this.code.aluRegMem(carry ?? plain, [8, 9, 10, 11][limb], this.limbOf(right.offset, limb), true);
      }
    }
  }

  /**
   * An operation on one wide number.
   *
   * A complement is one instruction per limb, and a negation is a subtraction
   * from zero, so both are the operations below run over four limbs rather than
   * anything of their own.
   */
  private wideUnary(value: SemanticValue & { k: "unary" }): void {
    const type = fieldOf(value, "type") as SemanticType;
    const operand = fieldOf(value, "operand") as SemanticValue;
    const op = String(fieldOf(value, "op"));
    const limbs = this.limbsOf(type);
    if (op === "pos") return;
    if (op === "bitNot") {
      this.wideValue(operand);
      for (let limb = 0; limb < limbs; limb += 1) this.code.not([8, 9, 10, 11][limb], true);
      return;
    }
    if (op === "neg") {
      // `0 - x`, limb by limb with the borrow chained. The zero is materialised
      // into the second half of the pair rather than subtracted from the
      // registers it will overwrite, so that every limb of the operand is still
      // readable when its own turn comes.
      const value_ = this.hold(type, "blaze_wide_operand");
      this.wideValue(operand);
      this.wideStore(value_);
      this.code.movRegImm([8, 9, 10, 11][0], 0n);
      for (let limb = 1; limb < limbs; limb += 1) this.code.movRegImm([8, 9, 10, 11][limb], 0n);
      this.code.aluRegMem("sub", [8, 9, 10, 11][0], this.limbOf(fieldOf(value_, "offset") as number, 0), true);
      for (let limb = 1; limb < limbs; limb += 1) {
        this.code.aluRegMem("sbb", [8, 9, 10, 11][limb], this.limbOf(fieldOf(value_, "offset") as number, limb), true);
      }
      return;
    }
    throw machineError(
      `a wide ${op} is not written in this backend`,
      "a wide number complements and negates here; `not` is the logical negation of a comparison, which is a whole number however wide the two sides are",
    );
  }

  /**
   * Two wide numbers compared, limb by limb from the top down.
   *
   * The top limb is the one that decides, because the number it is part of is
   * the sum of the limbs below it and a difference anywhere below is smaller
   * than the weight of the one above. So the walk stops at the first limb that
   * differs and the condition is read off the comparison of that one — which is
   * why the answer is a branch out of the middle of the walk rather than four
   * comparisons combined afterwards.
   *
   * Two numbers whose every limb matches are equal whatever the condition asks,
   * so the walk falls off the end with a zero in the accumulator.
   */
  private wideCompare(value: SemanticValue & { k: "compare" }): void {
    const operand = fieldOf(value, "operand") as SemanticType;
    const op = String(fieldOf(value, "op")) as CompareOp;
    const limbs = this.limbsOf(operand);
    const left = this.hold(operand, "blaze_wide_left");
    const right = this.hold(operand, "blaze_wide_right");
    this.wideValue(fieldOf(value, "left") as SemanticValue);
    this.wideStore(left);
    this.wideValue(fieldOf(value, "right") as SemanticValue);
    this.wideStore(right);
    const decided = this.code.label("Lwide_decided");
    const end = this.code.label("Lwide_end");
    for (let limb = limbs - 1; limb >= 0; limb -= 1) {
      this.code.movRegMemSized(RAX, this.limbOf(fieldOf(left, "offset") as number, limb), 8, false);
      this.code.aluRegMem("cmp", RAX, this.limbOf(fieldOf(right, "offset") as number, limb), true);
      this.code.jcc("ne", decided);
    }
    // Every limb matched, so the two are the same number. An equality is
    // therefore true and every ordering is false — the walk ran out of limbs
    // without finding one that differs, and a condition asked of two equal
    // numbers has only one of those two answers.
    this.code.movRegImm(RAX, op === "eq" ? 1n : 0n);
    this.code.jmp(end);
    this.code.bind(decided);
    // `setcc` writes one byte and leaves the rest of the register as it was, and
    // what it was a moment earlier is the limb the walk had just compared. The
    // rest is cleared afterwards rather than before, which is the only order that
    // works: clearing it first would be a `xor` or a `mov` of zero, and both are
    // instructions that set the flags — so the condition `setcc` is about to read
    // would be the one they left rather than the one the comparison set.
    //
    // The clear is a thirty-two bit `and`, which has the second effect of writing
    // `eax` and so zeroing everything above it. The flags it changes are the ones
    // the condition has already been read out of, and nothing reads them again.
    this.code.setcc(comparisonCode(op, false), RAX);
    this.code.aluImm("and", RAX, 0xff, false);
    this.code.bind(end);
  }

  /**
   * One of two wide numbers, chosen by a condition.
   *
   * Every limb moves on the condition, so the answer is four conditional moves
   * rather than a branch over two thirty-two byte copies: the two are in the
   * working registers and a scratch quad at once either way, and the move costs
   * one instruction per limb where a branch costs a copy of both sides.
   */
  private wideSelect(value: SemanticValue & { k: "select" }): void {
    const limbs = this.limbsOf(value.type);
    const whenTrue = this.hold(value.type, "blaze_wide_then");
    const whenFalse = this.hold(value.type, "blaze_wide_otherwise");
    this.wideValue(value.then);
    this.wideStore(whenTrue);
    this.wideValue(value.otherwise);
    this.wideStore(whenFalse);
    // The condition is tested once, before anything is moved: a `mov` leaves the
    // flags alone, so all four moves read the same test and a chain of them is
    // four conditional moves rather than four branches.
    this.value(value.condition);
    this.code.test(RAX, true);
    for (let limb = 0; limb < limbs; limb += 1) {
      this.code.movRegMemSized([8, 9, 10, 11][limb], this.limbOf(whenFalse.offset, limb), 8, false);
      this.code.cmov("ne", [8, 9, 10, 11][limb], this.limbOf(whenTrue.offset, limb), true);
    }
  }

  /**
   * A wide number moved left or right by a whole number of bits.
   *
   * Moving a wide number is not a carry chain. The bits leaving one limb arrive
   * in its neighbour, in whichever direction the number is going, and the amount
   * is a value rather than a flag the previous limb left. Written as one
   * instruction per limb it would drop every bit that crosses a boundary, and a
   * shift that is right in its outer limbs and wrong in its middle ones is a
   * number the program never asked for and cannot tell from a right answer.
   *
   * So the amount is split into a number of whole limbs and a number of bits
   * inside one, and each output limb is built from two limbs of the input:
   * `out[i] = (src[i - k] << r) | ((src[i - k-1] >> 1) >> (63 - r))` for a shift
   * left. The second half is written that way rather than as `>> (64 - r)`
   * because a shift of sixty-four is not a shift — the machine counts only six
   * bits of the amount and would shift by zero — and because folding the one bit
   * in first makes the whole expression zero when `r` is zero, which is what it
   * is: a shift of zero whole limbs is a copy.
   *
   * The input is read through an index rather than one limb at a time written
   * out, because the limb a shift wants is `i - k` and `k` is only known at run
   * time. It is read from a slot with a whole limb of padding on each side and
   * the padding cleared, so that `i - k` running off either end of the number
   * reads zero rather than the neighbouring slot — which is what a shift of a
   * limb out of the bottom, or a whole limb in past the top, has to answer.
   */
  private wideShift(value: SemanticValue & { k: "arith" }, op: "shl" | "shr"): void {
    // The count is the number the source wrote, which is a machine number. The
    // IR does not stop one being a wide number, and reading one as a machine
    // number would take the first eight bytes of it — the count would be the low
    // half of the number being shifted, and the answer wrong rather than refused.
    if (isWideType(value.right.type)) {
      throw new CompilerError("SemanticIrError", "semantic-ir", `the count of a shift by ${op} is a wide number, which is not the number of bits to move`, "", "", "", "");
    }
    const type = value.type;
    const limbs = this.limbsOf(type);
    const signed = type.kind === "primitive" && type.name === "i256";
    const width = limbs * 64;
    const padding = limbs * LIMB_BYTES;
    const span = padding * 3;
    const region = this.reserve(span);
    const base = region + padding;
    // The padding is cleared rather than left to be whatever the frame held: a
    // limb read from beyond the number is not a limb of it.
    this.code.movRegImm(RAX, 0n);
    for (let at = 0; at < span; at += LIMB_BYTES) this.code.movMemRegSized(frame(region + at), RAX, 8);
    this.wideValue(value.left);
    // A signed number that is being moved down reads the limbs above it, and
    // those are the sign rather than zeros: a shift right of a negative number
    // keeps it negative, and a run of zeros above it would answer a positive
    // number instead. The padding below the number is still zeros, because a
    // number going left takes its bits from below and a signed number going
    // left loses the ones it moves past rather than repeating them.
    if (signed && op === "shr") {
      this.code.movRegReg(RDI, [8, 9, 10, 11][limbs - 1]);
      this.code.shiftImm("sar", RDI, 63);
      for (let at = 0; at < padding; at += LIMB_BYTES) {
        this.code.movMemRegSized(frame(region + padding + padding + at), RDI, 8);
      }
    }
    for (let limb = 0; limb < limbs; limb += 1) {
      this.code.movMemRegSized(this.limbOf(base, limb), [8, 9, 10, 11][limb], 8);
    }
    // The amount: `k` whole limbs and `r` bits inside one. `k` is negated for a
    // shift left, because the limb it wants is below the one being written and
    // an index register can only count up.
    this.at(value.right, USIZE);
    // A count that moves every bit of the number out is answered rather than
    // walked: the walk reads the limbs around the number, and a count past the
    // width would read past the run and answer whatever the frame held there.
    // The count the walk is given is held below the width, which keeps every
    // address inside the run, and what the walk made of it is masked away
    // afterwards.
    this.code.movRegReg(RSI, RAX);
    this.code.movRegReg(RCX, RAX);
    // The width of the number, and the value a count past it is answered with:
    // a number that is signed and is being moved down answers its own sign,
    // and every other number answers nothing at all. Both are written before
    // the comparison, because a zero is written as an exclusive-or and that
    // would leave the flags saying the count and the width were equal.
    const answersItsSign = signed && op === "shr";
    this.code.movRegImm(RDX, BigInt(width));
    this.code.movRegImm(RAX, answersItsSign ? BigInt(width - 1) : 0n);
    this.code.alu("cmp", RCX, RDX, true);
    this.code.movRegReg(RCX, RSI);
    this.code.cmov("ae", RCX, RAX, true);
    this.code.movRegReg(RSI, RCX);
    // The mask the answer is combined with: a count past the width leaves none
    // of the bits of every number but a signed one being moved down, and that
    // one has already been given its sign by the bounded count above.
    if (!answersItsSign) {
      this.code.movRegImm(RDI, -1n);
      this.code.movRegReg(RDX, RAX);
      this.code.cmov("ae", RDI, RDX, true);
    }
    this.code.movRegReg(RDX, RSI);
    // The count for a register shift is the scratch register, so six is written
    // there rather than as an immediate: the shift below is by six, not by the
    // bits-within-a-limb the scratch held a moment ago.
    this.code.movRegImm(RCX, 6n);
    this.code.shift("shr", RDX, true);
    if (op === "shl") this.code.neg(RDX, true);
    // The scratch register held six for that shift and is what every shift below
    // counts from, so the bits-within-a-limb amount goes back into it.
    this.code.movRegReg(RCX, RSI);
    for (let limb = 0; limb < limbs; limb += 1) {
      this.code.movRegMemSized([8, 9, 10, 11][limb], indexed(RSP, RDX, 8, base + limb * LIMB_BYTES), 8, false);
    }
    for (let limb = 0; limb < limbs; limb += 1) this.code.shift(op, [8, 9, 10, 11][limb], true);
    // Both halves of the neighbouring limb move the opposite way to the number:
    // a number going left takes the bits out of the limb below it and drops them
    // downwards. `63 - r` is kept in `rsi` because the count for a register shift
    // is the scratch register, which the fold below needs to be holding two
    // different amounts in the same loop.
    this.code.movRegImm(RAX, 63n);
    this.code.alu("sub", RAX, RSI, true);
    this.code.movRegReg(RSI, RAX);
    const towards = op === "shl" ? "shr" : "shl";
    for (let limb = 0; limb < limbs; limb += 1) {
      const neighbour = op === "shl" ? limb - 1 : limb + 1;
      this.code.movRegMemSized(RAX, indexed(RSP, RDX, 8, base + neighbour * LIMB_BYTES), 8, false);
      // The bit is folded off before the rest is shifted by `63 - r`, which is
      // what makes this zero when `r` is zero: a shift of sixty-four bits is not a
      // shift on this machine — the count is six bits wide — so `>> 64` would
      // read as `>> 0` and hand back the whole limb instead of nothing.
      this.code.movRegImm(RCX, 1n);
      this.code.shift(towards, RAX, true);
      this.code.movRegReg(RCX, RSI);
      this.code.shift(towards, RAX, true);
      this.code.alu("or", [8, 9, 10, 11][limb], RAX, true);
    }
    // The mask the answer is combined with, which is what answers a count that
    // moved every bit out: every number but a signed one being moved down has
    // no bits left, and a signed one has already been given its sign by the
    // bounded count above.
    if (!answersItsSign) {
      for (let limb = 0; limb < limbs; limb += 1) this.code.alu("and", [8, 9, 10, 11][limb], RDI, true);
    }
  }

  /**
   * A wide operation the machine has no instruction for, carried out by the
   * kernel.
   *
   * The kernel takes the addresses of its operands and writes through one, so
   * both sides have to be somewhere it can point at — which is the one thing an
   * operation written in registers cannot arrange. Both are therefore in slots,
   * and the working registers are not involved at all.
   */
  private wideKernel(op: "mul" | "div" | "mod", left: SemanticValue, right: SemanticValue, type: SemanticType): void {
    const result = this.hold(type, "blaze_wide_out");
    const a = this.hold(type, "blaze_wide_a");
    const b = this.hold(type, "blaze_wide_b");
    this.wideValue(left);
    this.wideStore(a);
    this.wideValue(right);
    this.wideStore(b);
    this.code.leaMemReg(mem(RSP, result.offset), RDI);
    this.code.leaMemReg(mem(RSP, a.offset), RSI);
    this.code.leaMemReg(mem(RSP, b.offset), RDX);
    const signed = type.kind === "primitive" && type.name === "i256";
    this.library(`${RUNTIME_NAME}_${signed ? "i256" : "u256"}_${op}`);
    // The kernel writes its answer through the first pointer, so it is in the
    // slot that pointer names and not in the registers. Every other wide value
    // is left in the working registers by whatever produced it, and the caller
    // is right to expect the same of this one: a value left in a slot would be
    // read as whatever the last register operation happened to put there.
    this.wideLoad(result);
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
    if (!isFloatType(type)) {
      this.load(low);
      this.scratchFrom(high);
      // The answer is the right side when the comparison does not hold, so the
      // move is written on the condition that says so. The sides are compared
      // at the width the language promotes them to, and that comparison is
      // left in the flags for the move to read.
      this.code.alu("cmp", RAX, RCX, operationWidth(type) === 8);
      const away = COMPARISON[signedOf(type) ? "signed" : "unsigned"][smaller ? "lt" : "gt"];
      this.code.cmov(negatedCondition(away), RAX, RCX, operationWidth(type) === 8);
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
    const type = fieldOf(value, "operand") as SemanticType;
    const op = String(fieldOf(value, "op")) as CompareOp;
    const leftValue = fieldOf(value, "left") as SemanticValue;
    const rightValue = fieldOf(value, "right") as SemanticValue;
    if (isTextType(type)) {
      const left = this.hold(type, "blaze_left");
      const right = this.hold(type, "blaze_right");
      this.at(leftValue, TEXT);
      this.store(left);
      this.at(rightValue, TEXT);
      this.store(right);
      this.textOrder(op, left, right);
      return;
    }
    // An other side the program wrote out is carried by the comparison itself,
    // so it is never written to the frame and read back out of it.
    const written = this.literalOf(rightValue, type);
    if (written !== null) {
      this.at(leftValue, type);
      this.compare(type, op, written);
      this.normalize(fieldOf(value, "type") as SemanticType);
      return;
    }
    // An other side the comparison reads where it lies, for the same reason as
    // the branch above and in the same operand order as the general form just
    // below it: here the left side is the destination and the other one is the
    // source, which is the other way round from the branch, where the side held
    // is the destination.
    const carried = isFloatType(type) ? this.carriedOperand(rightValue, type, !hasCall(leftValue)) : null;
    if (carried !== null) {
      this.at(leftValue, type);
      this.code.sseCompare(XMM0, carried, widthOf(type) === 4, true);
      this.floatCondition(op);
      this.normalize(fieldOf(value, "type") as SemanticType);
      return;
    }
    const right = this.hold(type, "blaze_right");
    this.at(rightValue, type);
    this.store(right);
    this.at(leftValue, type);
    // The left side is already in the accumulator and stays there: writing it
    // to a slot and reading it back is two instructions that answer nothing.
    this.compare(type, op, right);
    this.normalize(fieldOf(value, "type") as SemanticType);
  }

  /**
   * The number a float comparison answers, taken from the flags it left.
   *
   * The conditions are the unordered ones the instruction raises the parity bit
   * for, and every comparison of a value that is not a number is false whichever
   * way it is read: a pair of them is excluded rather than let through as an
   * answer, and `!=` is the one operator where a value that is not a number
   * really is different from the other side.
   */
  private floatCondition(op: CompareOp): void {
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
      // The deciding arm holds the answer the operator gives when the left one
      // settles it: zero for `&&`, whose left arm being false settles it, and
      // one for `||`, whose left arm being *true* settles it. So the jump to
      // that arm is taken when the comparison is false under `&&` and when it
      // is true under `||` - the opposite sense for the two, which is what the
      // argument says. Taking it the other way round answered both operators
      // with the other operator's rule: an `a && b` with a true a jumped past
      // b and answered false, and an `a || b` with a true a fell into b and
      // answered b.
      this.truthBranch(value.left, value.op === "or", otherwise);
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
    // A number arm beside a text is the test, and the text is the value the
    // operator hands back, so a number that answers is written as the text of
    // that number.
    this.arm(value.right, value.type);
    this.code.jmp(end);
    this.code.bind(otherwise);
    if (arm !== null) this.load(arm);
    if (isNumber(value.left.type) && isTextType(value.type)) this.numberAsText();
    else this.convert(value.left.type, value.type);
    this.code.bind(end);
  }

  /**
   * An arm of a short-circuit operator, read as the type the operator is
   * written as.
   *
   * A number read as a text is the text of that number, which is what the
   * operator hands back where one of its arms is a number and the other is a
   * text: the text is the value, and the number is the test that decides
   * whether it is handed back.
   */
  private arm(value: SemanticValue, type: SemanticType): void {
    if (isNumber(value.type) && isTextType(type)) {
      this.value(value);
      this.numberAsText();
      return;
    }
    this.at(value, type);
  }

  /** The accumulator holding a number, as the text of that number. */
  private numberAsText(): void {
    this.formatNumber(null);
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
    const operand = fieldOf(value, "operand") as SemanticValue;
    const operandType = fieldOf(operand, "type") as SemanticType;
    const type = fieldOf(value, "type") as SemanticType;
    switch (String(fieldOf(value, "op"))) {
      case "pos":
        if (isDynamicType(operandType)) {
          this.value(operand);
          this.code.movdXmm(XMM0, RAX);
          this.runtime("_to_number");
          return;
        }
        this.value(operand);
        return;
      case "not": {
        if (operand.k === "compare" && !isTextType(fieldOf(operand, "operand") as SemanticType)) {
          this.comparedNegated(operand);
          return;
        }
        // The truth of the operand is asked of the accumulator it is already
        // in: it does not have to be written down and read back to be asked
        // about, and `not` is the one operation that changes no bit of it.
        this.truth(operand);
        // A truth of a float is answered as a number, and the move that widens
        // that number into the accumulator leaves the flags as the `and` that
        // combined the two condition bytes left them — which is the zero-ness
        // of a truth, and not of the operand. `not` asks the question of the
        // operand, so a `test` is what asks it.
        if (!isTextType(operandType)) this.code.test(RAX);
        this.code.setcc("e", RAX);
        this.code.movzxReg8(RAX, RAX);
        return;
      }
      case "bitNot":
        this.value(operand);
        this.code.not(RAX);
        this.normalize(type);
        return;
      case "neg": {
        const type = operandType;
        if (isDynamicType(type)) {
          this.value(operand);
          this.code.movdXmm(XMM0, RAX);
          this.runtime("_to_number");
          this.code.movRegImm(RAX, -0x8000_0000_0000_0000n);
          this.code.movdXmm(XMM1, RAX);
          this.code.xorFloat(XMM0, XMM1);
          return;
        }
        this.value(operand);
        if (isFloatType(type)) {
          // The sign of a float is its highest bit, so a negation turns that one
          // over rather than subtracting from nothing.
          this.code.movRegImm(RAX, widthOf(type) === 4 ? -0x8000_0000n : -0x8000_0000_0000_0000n);
          this.code.movdXmm(XMM1, RAX);
          this.code.xorFloat(XMM0, XMM1);
          return;
        }
        this.code.neg(RAX);
        this.normalize(type);
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
    const textParts = fieldOf(value, "parts") as readonly SemanticValue[];
    if (textParts.every((part) => part.k === "text")) {
      this.literal(textParts.map((part) => (part.k === "text" ? String(fieldOf(part, "value")) : "")).join(""));
      this.code.leaLabel(RAX, this.lastLiteral);
      return;
    }
    // Every part is read before anything is measured, and every measure reads
    // its part out of the frame rather than out of the register the read left
    // it in. Measuring a part calls `strlen`, and a name the build gave a
    // register of its own — a string pinned to one of the registers a call is
    // written through, which is what a text local with no call reaching it
    // gets — is gone after the first measure: `c = c + c` read the second `c`
    // out of `rdi` after `strlen` had it, and answered a `strlen` of whatever the
    // call left there. The liveness the allocator works from never saw a call
    // in that statement, because the call is this lowering's own.
    const parts = textParts.map(() => ({ pointer: this.hold(POINTER, "blaze_part"), length: this.hold(USIZE, "blaze_length") }));
    const unmeasured: number[] = [];
    for (let at = 0; at < textParts.length; at += 1) {
      const part = textParts[at];
      if (part.k === "text") {
        this.literal(String(fieldOf(part, "value")));
        this.code.leaLabel(RAX, this.lastLiteral);
        this.store(fieldOf(parts[at], "pointer") as Held);
        this.code.movRegImm(RAX, BigInt(Buffer.byteLength(String(fieldOf(part, "value")), "utf8")));
        this.store(fieldOf(parts[at], "length") as Held);
        continue;
      }
      // A part that came back measured is as long as it says, and one that did
      // not is text to begin with, which is the only shape left to measure.
      if (!this.asTextPart(fieldOf(part, "value") as SemanticValue, fieldOf(parts[at], "length") as Held)) unmeasured.push(at);
      this.store(fieldOf(parts[at], "pointer") as Held);
    }
    for (const at of unmeasured) {
      this.code.movRegMem(RAX, frame(fieldOf(fieldOf(parts[at], "pointer"), "offset") as number));
      this.code.movRegReg(RDI, RAX);
      this.library("strlen");
      this.store(fieldOf(parts[at], "length") as Held);
    }
    const total = this.hold(USIZE, "blaze_total");
    this.code.movRegImm(RAX, 0n);
    for (const part of parts) {
      this.code.aluRegMem("add", RAX, frame(fieldOf(fieldOf(part, "length"), "offset") as number));
    }
    this.store(total);
    this.code.movRegMem(RAX, frame(fieldOf(total, "offset") as number));
    this.code.aluImm("add", RAX, 1);
    this.code.movRegReg(RDI, RAX);
    this.runtime("_allocate");
    const buffer = this.hold(POINTER, "blaze_text");
    this.store(buffer);
    const filled = this.hold(USIZE, "blaze_filled");
    this.code.movRegImm(RAX, 0n);
    this.store(filled);
    // A part of nothing is copied by a copy of nothing, and the guard that
    // used to skip it was downstream of the measure: a part that is not measured
    // is measured with `strlen` first, so a null one has already been read.
    for (const part of parts) {
      this.code.movRegMem(RAX, frame(fieldOf(filled, "offset") as number));
      this.code.movRegMem(RCX, frame(fieldOf(buffer, "offset") as number));
      this.code.lea(RCX, indexed(RCX, RAX, 1));
      this.code.movRegReg(RDI, RCX);
      this.code.movRegMem(RSI, frame(fieldOf(fieldOf(part, "pointer"), "offset") as number));
      this.code.movRegMem(RDX, frame(fieldOf(fieldOf(part, "length"), "offset") as number));
      this.library("memcpy");
      this.code.movRegMem(RAX, frame(fieldOf(filled, "offset") as number));
      this.code.aluRegMem("add", RAX, frame(fieldOf(fieldOf(part, "length"), "offset") as number));
      this.store(filled);
    }
    // The terminator is the byte after the last one written, and the value the
    // body reads is the buffer itself.
    this.code.movRegMem(RAX, frame(fieldOf(filled, "offset") as number));
    this.code.movRegMem(RCX, frame(fieldOf(buffer, "offset") as number));
    this.code.lea(RAX, indexed(RCX, RAX, 1));
    this.code.movRegReg(RCX, RAX);
    this.code.alu("xor", RAX, RAX, false);
    this.code.movMemRegSized(mem(RCX), RAX, 1);
    this.code.movRegMem(RAX, frame(fieldOf(buffer, "offset") as number));
  }

  /**
   * A text written to the output. A template is written a part at a time, which
   * is what a person reading the output would have done, and it is what the
   * output is: nothing holds the text but this statement, so laying the parts
   * out in a buffer to read the whole thing back is a copy, an allocation and a
   * measure of a string that is already known to be exactly as long as its
   * parts. The output is buffered by the runtime either way, so a part written
   * is not a write to the outside.
   *
   * A text that is a value rather than a template has nowhere to be written as
   * a value but the output, so it is written whole.
   */

  /** `http.serve(port)`: create the server, run it. The server registers the
   * default handler itself, so nothing else is needed. `blaze_http_server_run`
   * never returns. */
  private httpServe(call: SemanticCall): void {
    const args = fieldOf(call, "args") as readonly SemanticValue[];
    // The port is read into the accumulator, then moved to RSI (the second
    // argument). The host is the first argument, and a server the program did
    // not name an address for listens on every address.
    this.at(args[0], USIZE);
    this.code.movRegReg(RSI, RAX);
    this.code.alu("xor", RDI, RDI, false);
    // blaze_http_server_new(host, port) -> server handle in RAX.
    this.external("blaze_http_server_new");
    this.callForeign("blaze_http_server_new");
    // blaze_http_server_run(server) — never returns.
    this.code.movRegReg(RDI, RAX);
    this.external("blaze_http_server_run");
    this.callForeign("blaze_http_server_run");
  }

  private printText(value: SemanticValue): void {
    const textParts = value.k === "text" ? fieldOf(value, "parts") as readonly SemanticValue[] : null;
    const parts = textParts;
    const writes = parts === null ? 0 : parts.filter((part) => part.k !== "text").length;
    if (parts === null || (parts.length > 0 && writes === 0)) {
      this.value(value);
      this.code.movRegReg(RDI, RAX);
      this.runtime("_print_text");
      return;
    }
    // One part is kept measured for as long as the statement lasts, and it is
    // the only one that can need a slot: every other length is written where
    // the runtime returned it or read as a constant.
    const length = this.hold(USIZE, "blaze_length");
    for (const part of parts) {
      if (part.k === "text") {
        this.literal(String(fieldOf(part, "value")));
        this.code.leaLabel(RAX, this.lastLiteral);
        this.code.movRegReg(RDI, RAX);
        this.code.movRegImm(RSI, BigInt(Buffer.byteLength(String(fieldOf(part, "value")), "utf8")));
      } else {
        // A part that arrived without a length is text to begin with, and the
        // only shape left to measure.
        const measured = this.asTextPart(fieldOf(part, "value") as SemanticValue, length);
        this.code.movRegReg(RDI, RAX);
        if (!measured) {
          this.library("strlen");
          this.code.movRegReg(RSI, RAX);
        } else {
          this.code.movRegMem(RSI, frame(fieldOf(length, "offset") as number));
        }
      }
      this.runtime("_print_text_n");
    }
  }

  /**
   * A part of a text as the text it is, with its length where the caller asked
   * for it. A template writes the conversion around what it interpolates, and
   * the conversion is unwrapped here rather than lowered: it is text already by
   * its own type, so handing it to `asText` whole would read it as a string
   * that arrives without a length and measure the bytes the conversion had
   * just counted.
   */
  private asTextPart(value: SemanticValue, measured: Held | null): boolean {
    // The digits asked for are the outer wrapper's: a part written as
    // `${x.toString(16)}` is a number in base sixteen, and reading through the
    // wrapper for the value alone wrote the number the way the shortest writing
    // of it goes — `255` where the source says `ff`.
    const digits = value.k === "toText" ? fieldOf(value, "digits") as number : null;
    const precision = value.k === "toText" && String(fieldOf(value, "precision")) === "true";
    let inner = value;
    while (inner.k === "toText") inner = fieldOf(inner, "of") as SemanticValue;
    return this.asText(inner, measured, digits, precision);
  }

  /**
   * A value as text, as the source language prints one. A number is written by
   * the runtime's own formatter, so it reads the way the source writes it; a
   * truth and an absence are the words the source prints, and a reference that
   * is there is the address the driver prints for one.
   *
   * The length of the text is written to `measured` wherever the text is
   * written already measured: a word is a constant, and the runtime hands back
   * the count of what it formatted. Only a value that is text to begin with
   * carries no length, and a caller that needs one measures that itself. The
   * return says which of the two happened, so the caller reads a part that
   * arrived measured for nothing and measures the rest.
   */
  private asText(value: SemanticValue, measured: Held | null = null, digits: number | null = null, precision = false): boolean {
    /** A word written in place of a value, which is as long as the word is. */
    const word = (text: string): void => {
      if (measured !== null) {
        this.code.movRegImm(RAX, BigInt(Buffer.byteLength(text, "utf8")));
        this.store(measured);
      }
      this.literal(text);
      this.code.leaLabel(RAX, this.lastLiteral);
    };

    if (isTextType(value.type)) {
      this.value(value);
      return false;
    }
    if (valueKind(value) === "null") {
      word("null");
      return true;
    }
    if (isBoolean(value.type)) {
      const otherwise = this.code.label("Lword");
      const end = this.code.label("Lend");
      this.value(value);
      this.code.test(RAX);
      this.code.jcc("e", otherwise);
      word("true");
      this.code.jmp(end);
      this.code.bind(otherwise);
      word("false");
      this.code.bind(end);
      return true;
    }
    if (isDynamicType(value.type)) {
      // A service takes the handle as the double it is, and the bits this
      // backend keeps in the accumulator are that double's: the move turns
      // them back into the number the convention passes.
      this.value(value);
      this.code.movdXmm(XMM0, RAX);
      this.runtime("_to_text");
      return false;
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
      this.formatNumber(measured, digits, precision);
      this.code.jmp(end);
      this.code.bind(otherwise);
      word("null");
      this.code.bind(end);
      return true;
    }
    if (digits !== null && digits < 0 && isFloatType(value.type)) {
      throw machineError(
        `${String(fieldOf(this.fn, "symbol"))} writes a fraction in hexadecimal, which this backend cannot do`,
        "a hexadecimal form is written for a whole number; convert the value to one first",
      );
    }
    if (isWideType(value.type) || (digits !== null && digits < 0 && isInteger(value.type))) {
      // A wide number is printed from its four limbs, and a narrow whole number
      // written in base sixteen is widened into the same four so one formatter
      // writes both.
      const base = digits === null ? 10 : digits === -2 ? 2 : digits < 0 ? 16 : 10;
      const slot = this.hold(isWideType(value.type) ? value.type : WIDE_UNSIGNED, "blaze_wide_text");
      if (isWideType(value.type)) this.wideValue(value);
      else this.wideFrom(value);
      this.wideStore(slot);
      const buffer = this.scratch(80, "blaze_wide_text_buffer");
      this.code.leaMemReg(mem(RSP, slot.offset), RDI);
      this.code.movRegImm(RSI, BigInt(base));
      this.code.lea(RDX, frame(buffer));
      this.code.movRegImm(RCX, 80n);
      this.library("blaze_rt_u256_format");
      if (measured !== null) this.code.movMemRegSized(frame(measured.offset), RAX, 8);
      // The buffer is this function's own, so the text is copied into the
      // managed heap before it is answered: a text a function returns outlives
      // the frame it was written in.
      this.code.movRegReg(RCX, RAX);
      this.code.lea(RDI, frame(buffer));
      this.code.movRegReg(RSI, RCX);
      this.runtime("_string_new");
      this.freeSlot(slot);
      return true;
    }
    this.at(value, NUMBER);
    this.formatNumber(measured, digits, precision);
    return true;
  }

  /**
   * The accumulator holding the text of the number `xmm0` holds, and how long
   * that text is, written to `measured`. The runtime counts what it writes, so
   * counting it again over the result reads it a second time for an answer the
   * first read already gave.
   */
  private formatNumber(measured: Held | null, digits: number | null = null, precision = false): void {
    const buffer = this.scratch(64, "blaze_number");
    if (digits === null) {
      this.code.lea(RDI, frame(buffer));
      this.code.movRegImm(RSI, 64n);
      this.runtime("_format_number");
    } else if (precision) {
      // `blaze_rt_format_number_precision(value, digits, buffer, size)`.
      this.code.movRegImm(RDI, BigInt(digits));
      this.code.lea(RSI, frame(buffer));
      this.code.movRegImm(RDX, 64n);
      this.runtime("_format_number_precision");
    } else {
      // `blaze_rt_format_number_fixed(value, digits, buffer, size)`. The value
      // is already in the first floating point register; the whole arguments
      // are assigned over the integer registers from the first of them, which
      // the floating point argument does not take one of.
      this.code.movRegImm(RDI, BigInt(digits));
      this.code.lea(RSI, frame(buffer));
      this.code.movRegImm(RDX, 64n);
      this.runtime("_format_number_fixed");
    }
    // The formatter writes a terminator of its own, and one is written here as
    // well: the buffer is this function's own, and the length it is given is
    // where the string ends.
    this.code.movRegReg(RCX, RAX);
    if (measured !== null) this.code.movMemRegSized(frame(measured.offset), RCX, 8);
    this.code.lea(RAX, frame(buffer));
    this.code.alu("xor", RDX, RDX, false);
    this.code.movMemRegSized(indexed(RAX, RCX, 1), RDX, 1);
    // The text is copied out of this function's frame before it is answered: a
    // text a function returns, a call keeps, or a list holds outlives the frame
    // the number was written in, and reading it afterwards reads what the next
    // call left there.
    this.code.lea(RDI, frame(buffer));
    this.code.movRegReg(RSI, RCX);
    this.runtime("_string_new");
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
    if (this.isView(of)) {
      // A view's pointer is the block moved to where the window starts, so the
      // header in front of it is not the header of the block it is a window of.
      // The C backend carries the count the window is beside the name, and this
      // one refuses rather than read a header that is not there.
      throw machineError(
        `${String(fieldOf(this.fn, "symbol"))} reads the length of a view, which this backend cannot settle`,
        "a view's pointer is the block moved to where the window starts, and no count arrives with it; write the elements out, or build with --backend c",
      );
    }
    if (of.k === "local") {
      const lengthName = this.arrayParamLengths.get(of.name);
      if (lengthName !== undefined) {
        this.value({ k: "local", type: USIZE, name: lengthName });
        return;
      }
      // A name a list was bound to carries the count it was bound with, which is
      // the elements a list was written with or the count a block was joined at.
      const count = this.arrayCounts.get(this.names.read(of.name));
      if (count !== undefined) {
        if (typeof count === "bigint") {
          this.code.movRegImm(RAX, count);
        } else {
          this.load(count);
        }
        return;
      }
    }
    if (isSequence(of.type)) {
      // A list a function holds is the block the runtime laid out: the header
      // records the bytes it holds, so the count of elements is that many bytes
      // divided by the width of one. Every element the IR names is a power of
      // two wide, so the division is a shift, and the answer is the whole
      // number the length is.
      const element = elementTypeOf(of.type);
      const bytes = element === null ? 8 : widthOf(element);
      this.value(of);
      this.code.movRegReg(RDI, RAX);
      this.external("blaze_rt_object_size");
      this.callForeign("blaze_rt_object_size");
      this.code.shiftImm("shr", RAX, bytes === 1 ? 0 : bytes === 2 ? 1 : bytes === 4 ? 2 : 3);
      return;
    }
    throw machineError(
      `${String(fieldOf(this.fn, "symbol"))} reads the length of an array, which no machine this compiler writes can answer`,
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

  /** The label of the descriptor of a layout, laid down once: each field's
   *  name, the offset it sits at and the type it holds, NUL separated. */
  private objectDescriptor(layout: ObjectLayout): string {
    const layoutName = String(fieldOf(layout, "name"));
    const known = this.objectDescriptors.get(layoutName);
    if (known !== undefined) return known;
    const fields = fieldOf(layout, "fields") as readonly { name: string; offset: number; type: string }[];
    const names = fields.map((field) => `${String(fieldOf(field, "name"))}\0${fieldOf(field, "offset")}\0${String(fieldOf(field, "type"))}\0`).join("") + "\0";
    this.literal(names);
    const label = this.lastLiteral;
    this.objectDescriptors.set(layoutName, label);
    return label;
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

  /**
   * A float laid down in both halves of a pair, which is what a vector operation
   * wants a constant in.
   *
   * The instruction that puts a number in both halves of a register is a second
   * one — the load and the interleave — and a loop that multiplies by the same
   * number on every turn pays for it on every turn. The number written out in
   * both halves is one load instead, and a loop that adds the same pair to
   * something on every turn is one instruction that reads it from memory.
   */
  private floatPair(bits: bigint): string {
    const held = this.floatPairs.get(bits.toString());
    if (held !== undefined) return held;
    // The pair is laid down on a sixteen byte boundary, because the instruction
    // that reads a pair out of memory reads it aligned and the vector arithmetic
    // of the legacy instruction set has no unaligned form.
    while (this.rodata.length % 16 !== 0) this.rodata.push(0);
    const label = this.code.label("Lpair");
    this.labels.push({ name: label, offset: this.rodata.length });
    for (let index = 0; index < 8; index += 1) {
      this.rodata.push(Number((bits >> BigInt(index * 8)) & 0xffn));
    }
    for (let index = 0; index < 8; index += 1) {
      this.rodata.push(Number((bits >> BigInt(index * 8)) & 0xffn));
    }
    this.floatPairs.set(bits.toString(), label);
    return label;
  }

  /**
   * Eight doubles laid down as one constant vector, which a packed loop reads
   * with a single 512-bit load. The vector is laid down on a sixty-four byte
   * boundary so the load is aligned.
   */
  private floatList(bits: readonly bigint[]): string {
    const key = bits.join("|");
    const held = this.floatLists.get(key);
    if (held !== undefined) return held;
    while (this.rodata.length % 64 !== 0) this.rodata.push(0);
    const label = this.code.label("Lfloat8");
    this.labels.push({ name: label, offset: this.rodata.length });
    for (const value of bits) {
      for (let index = 0; index < 8; index += 1) {
        this.rodata.push(Number((value >> BigInt(index * 8)) & 0xffn));
      }
    }
    this.floatLists.set(key, label);
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
   *
   * A name the build gave a register of its own takes this path too, and is
   * read out of that register by `readInto` below. It cannot be read out of the
   * frame: a pinned name has no slot reserved at all, so its distance into the
   * frame is zero, which is the first slot's own address.
   */
  private plainIndex(index: SemanticValue): Held | bigint | null {
    if (index.k === "const") return integerText(index.text);
    if (index.k !== "local") return null;
    const held = this.slot(index.name);
    // A counter this pass counted out holds the number of its turn in the
    // instruction rather than anywhere a read could go, and that number is what
    // the address of an element is built from: the buffer and a displacement,
    // with no register spent on the index at all.
    if (held.constant !== null) return held.constant;
    // A float is not a plain index however it is held. The register a float is
    // pinned to is numbered out of the vector file, so handing it to a whole
    // number register the way a frame slot is handed over reads a different
    // register altogether — number seven being rdi and not xmm7. A float index
    // takes the general form, which converts it into the accumulator first,
    // unless the loop that counts it holds the same number in a register of its
    // own, which is what an index is then read out of.
    if (isFloatType(held.type)) {
      if (held.index === null) return null;
      // A value of its own rather than the counter's own identity: it stands in
      // for the index register and not for the counter, and a note about what
      // the accumulator holds must not answer a read of the counter with it.
      this.heldCount += 1;
      return new Held(this.heldCount, 0, USIZE, null, null, fieldOf(held, "index") as number | null);
    }
    if (held.register !== null) return held;
    return widthOf(held.type) !== 8 ? null : held;
  }

  /** The number an index is, in the register the caller asked for. */
  private readInto(held: Held | bigint, register: number): void {
    if (typeof held === "bigint") {
      this.code.movRegImm(register, held);
      return;
    }
    if (held.register !== null) {
      this.code.movRegReg(register, held.register);
      return;
    }
    this.code.movRegMem(register, frame(held.offset));
  }

  private addressOf(sequence: SemanticValue | string, index: SemanticValue, element: SemanticType): Memory {
    const carried = this.elementAddress(sequence, index, element);
    if (carried !== null) return carried;
    this.builtAddress(sequence, index, element);
    return mem(RAX);
  }

  /**
   * The address of one element, put together in the accumulator.
   *
   * This is the form every address can be written in, and the one a caller that
   * has to read the address twice takes: the index may be a value the IR
   * computes, and so may the sequence, so both are written where they are
   * computed and read back where the address is built from them.
   */
  private builtAddress(sequence: SemanticValue | string, index: SemanticValue, element: SemanticType): void {
    const scale = widthOf(element) as 1 | 2 | 4 | 8;
    const base = typeof sequence === "string" ? this.slot(sequence) : sequence.k === "local" ? this.slot(sequence.name) : null;
    // An index is a whole number, and where the loop that counts it keeps that
    // whole number in a register of its own this reads it out of that register
    // rather than out of the double the counter also is. The conversion was done
    // once for the loop when the register was filled, and doing it again on
    // every element threw the answer away and wrote the frame slot the general
    // form below puts it in. Which is what a counter the body reads as nothing
    // but an index would have left unreadable — so this is also what makes it
    // sound to count such a counter in whole numbers alone.
    const plain = this.plainIndex(index);
    if (typeof plain === "bigint") {
      // The index is a number the code carries, so the address is the buffer
      // plus that many elements and there is no register in it: one `lea`,
      // whose displacement is the number written into the instruction where it
      // fits there. A counter the loop counted out is the number of its turn
      // and nothing else, so this is the whole address of the element it
      // reaches — and the counter is never materialized anywhere.
      this.value(typeof sequence === "string" ? { k: "local", type: base?.type ?? POINTER, name: sequence } : sequence);
      this.code.movRegReg(RCX, RAX);
      const offset = plain * BigInt(scale);
      if (offset >= -0x8000_0000n && offset <= 0x7fff_ffffn) {
        this.code.lea(RAX, mem(RCX, Number(offset)));
      } else {
        this.code.movRegImm(RAX, plain);
        this.code.lea(RAX, indexed(RCX, RAX, scale));
      }
      return;
    }
    if (plain !== null && plain.register !== null && plain.register !== RAX) {
      // The sequence is read first, because it is a value of its own and may be
      // one the program computes; the counter's register is the convention's and
      // nothing below writes it.
      const counter = plain.register;
      this.value(typeof sequence === "string" ? { k: "local", type: base?.type ?? POINTER, name: sequence } : sequence);
      this.code.movRegReg(RCX, RAX);
      this.code.movRegReg(RAX, counter);
      this.code.lea(RAX, indexed(RCX, RAX, scale));
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
   * The address of one element as the instruction that reads or writes it can
   * carry, where both sides of it are already in registers.
   *
   * `base + index * scale` is one address the machine has: two registers and a
   * scale, written inside the read or the write rather than before it. So an
   * element whose buffer is in a register of its own and whose index is in one
   * — a loop counter held as a whole number, a name the allocator pinned, a
   * number the program wrote out — costs one instruction, where the general
   * form spends three that answer nothing on the way there: a move of the
   * buffer into the accumulator, a move of the index into the scratch, and the
   * addition of the two.
   *
   * Only the registers the lowering is not using for a value in flight may be
   * written here, so an index in the frame is read into the scratch — which
   * holds nothing at that point — and an index that would land in the same
   * register as the buffer is refused rather than answered with an address that
   * reads a different element.
   */
  private elementAddress(sequence: SemanticValue | string, index: SemanticValue, element: SemanticType): Memory | null {
    const scale = widthOf(element) as 1 | 2 | 4 | 8;
    const base = typeof sequence === "string"
      ? this.slot(sequence)
      : sequence.k === "local" ? this.slot(String(fieldOf(sequence, "name"))) : null;
    // The sequence is a pointer wherever it came from: an array reaches a
    // function as a pointer to its elements, so it is one whole-register read.
    if (base === null) return null;
    const baseRegister = fieldOf(base, "register") as number | null;
    const baseType = fieldOf(base, "type") as SemanticType;
    if (String(baseRegister) === "null" || widthOf(baseType) !== 8 || isFloatType(baseType)) return null;
    const register = baseRegister as number;
    const at = this.plainIndex(index);
    if (at === null) return null;
    if (typeof at === "bigint") {
      const offset = at * BigInt(scale);
      if (offset < -0x8000_0000n || offset > 0x7fff_ffffn) return null;
      return mem(register, Number(offset));
    }
    const atRegister = fieldOf(at, "register") as number | null;
    if (String(atRegister) !== "null") {
      // `rsp` is the one register an address cannot name as its index, and the
      // pools a value is given a register out of are not it. An index that
      // would land in the buffer's own register is refused for the same reason:
      // the address would be the buffer scaled by one number twice.
      if (atRegister === RSP || atRegister === register) return null;
      return indexed(register, atRegister as number, scale);
    }
    this.code.movRegMem(RCX, frame(fieldOf(at, "offset") as number));
    return indexed(register, RCX, scale);
  }

  /**
   * An array the program wrote out, allocated and filled where it was.
   *
   * The address of the array is held in a register across the elements, and
   * each element's offset is the displacement of its own store, so an element
   * costs one instruction rather than three. Which register it is held in is
   * what the rest of this depends on: the scratch register is the fourth
   * argument register, so an element that is a call takes it away and an
   * address kept there has to be written down and read back. A register the
   * convention says a callee leaves alone survives a call, so a function that
   * was given one does not pay that, and one that was not keeps the register
   * it already had and reloads the address for a call-valued element.
   */
  private buffer(value: SemanticValue & { k: "buffer" }): void {
    // A window of a block another name holds is the block itself moved by the
    // offset it starts at: no block of its own is allocated and nothing is
    // cleared, because the block it looks into is the one the name it was
    // taken of frees. The C driver writes the same window as the base moved
    // by the offset the source wrote, which is what this is.
    const view = fieldOf(value, "view");
    if (String(view) !== "null") {
      const viewRecord = view as { of: SemanticValue; offset: SemanticValue };
      // The offset is read first and parked: the value the block is taken of
      // is a value like any other, and the scratch beside the accumulator is
      // the register it may take. The parked slot is the statement's own —
      // the one that holds it hands it back when the statement is done — so
      // nothing here hands it back twice.
      const offset = this.hold(POINTER, "blaze_view");
      this.countAsSize(fieldOf(viewRecord, "offset") as SemanticValue);
      this.store(offset);
      this.value(fieldOf(viewRecord, "of") as SemanticValue);
      this.code.movRegMem(RCX, frame(fieldOf(offset, "offset") as number));
      this.code.lea(RAX, indexed(RCX, RAX, 1));
      return;
    }
    // A count the program settled on when it runs is a value like any other:
    // it is read into the first argument register the same way every other
    // runtime call is handed its arguments. Refusing it here meant a compiled
    // function could not size an array, so every helper that built its own
    // scratch space had to be written in the program body instead.
    if (String(fieldOf(value, "length")) === "null") {
      const count = fieldOf(value, "count") as SemanticValue;
      if (String(count) === "null") {
        throw machineError(
          `${String(fieldOf(this.fn, "symbol"))} holds an array with neither a length nor a count`,
          "an array is written either with its elements or with the number of them",
        );
      }
      this.countAsSize(count);
      this.code.movRegReg(RDI, RAX);
    } else {
      this.code.movRegImm(RDI, BigInt(fieldOf(value, "length") as number));
    }
    this.code.movRegImm(RSI, BigInt(widthOf(fieldOf(value, "element") as SemanticType)));
    this.runtime("_array_new");
    const held = this.objectRegister;
    if (held !== null) {
      // The register an object is filled in is the one an element that builds a
      // literal or a list of its own takes, so the array is kept in the frame as
      // well and read back into the register where an element built something.
      // Without it the base the first allocation answered was the base a later
      // element wrote itself into, and the array the call was handed was the
      // last object of it.
      const array = this.hold(POINTER, "blaze_array");
      this.store(array);
      this.code.movRegReg(held, RAX);
      (fieldOf(value, "values") as readonly SemanticValue[]).forEach((element, at) => {
        this.at(element, fieldOf(value, "element") as SemanticType);
        if (allocates(element) || hasCall(element) || this.boxesDynamic(element, fieldOf(value, "element") as SemanticType)) {
          this.code.movRegMem(held, frame(fieldOf(array, "offset") as number));
        }
        this.storeInto(fieldOf(value, "element") as SemanticType, held, at * widthOf(fieldOf(value, "element") as SemanticType));
      });
      this.code.movRegReg(RAX, held);
      return;
    }
    const array = this.hold(POINTER, "blaze_array");
    this.store(array);
    this.code.movRegMem(RCX, frame(fieldOf(array, "offset") as number));
    (fieldOf(value, "values") as readonly SemanticValue[]).forEach((element, at) => {
      this.at(element, fieldOf(value, "element") as SemanticType);
      // The address is the value the accumulator held before the element was
      // read, so it is rebuilt where the element took it from: a call takes the
      // registers a call takes, and so does the boxing a dynamic element is.
      if (hasCall(element) || this.boxesDynamic(element, fieldOf(value, "element") as SemanticType)) {
        this.code.movRegMem(RCX, frame(fieldOf(array, "offset") as number));
      }
      this.storeInto(fieldOf(value, "element") as SemanticType, RCX, at * widthOf(fieldOf(value, "element") as SemanticType));
    });
    this.code.movRegReg(RAX, RCX);
  }

  private layout(name: string): ObjectLayout {
    const layout = this.layouts[name];
    if (layout === undefined) throw machineError(`${String(fieldOf(this.fn, "symbol"))} uses the layout ${name}, which the program does not lay out`);
    return layout;
  }

  private field(layoutName: string, name: string): { name: string; type: string; offset: number } {
    const fields = fieldOf(this.layout(layoutName), "fields") as readonly { name: string; type: string; offset: number }[];
    const found = fields.find((entry) => String(fieldOf(entry, "name")) === name);
    if (found === undefined) {
      throw machineError(`${String(fieldOf(this.fn, "symbol"))} uses ${layoutName}.${name}, which the layout does not have`);
    }
    return found;
  }

  /**
   * Whether an object literal writes every field its layout has, which is what
   * decides the block it is given.
   *
   * A literal that does is a caller of the runtime's `allocate_uninitialized`,
   * and one that leaves a field out keeps the cleared block. The two cases are
   * read here rather than at the point of allocation because the fields of the
   * literal are the whole of what decides it, and the answer is the same one
   * the C backend reaches in its own `writesEveryField`.
   */
  private writesEveryField(value: SemanticValue & { k: "newObject" }, layout: ObjectLayout): boolean {
    if (Number(fieldOf(layout, "align")) > DEFAULT_ALIGNMENT) return false;
    const fields = fieldOf(value, "fields") as readonly { name: string; value: SemanticValue }[];
    const written = new Set(fields.map((entry) => String(fieldOf(entry, "name"))));
    const layoutFields = fieldOf(layout, "fields") as readonly { name: string }[];
    return layoutFields.every((entry) => written.has(String(fieldOf(entry, "name"))));
  }

  /** An object, allocated and filled as one value, on the terms `buffer` above. */
  private object(value: SemanticValue & { k: "newObject" }): void {
    const layout = this.layout(String(fieldOf(value, "layout")));
    // A literal that writes every field its layout has leaves nothing for the
    // clearing to answer, so the block it is given is not cleared: the
    // runtime's own note on `allocate_uninitialized` names an object literal
    // that writes its whole payload as what it is for. One that leaves a field
    // out keeps the cleared block, because a program is allowed to read a field
    // it never wrote and the source answers that read as a zero.
    //
    // The uncleared block carries the runtime's default alignment rather than
    // the layout's own: a field is at most a pointer wide, so no layout asks
    // for more than that today, and the check is what keeps that true rather
    // than what makes it true. This is the same decision the C backend makes in
    // `writesEveryField`, and it is made for the same reason.
    if (this.writesEveryField(value, layout)) {
      this.code.movRegImm(RDI, BigInt(Number(fieldOf(layout, "size"))));
      this.runtime("_allocate_uninitialized");
    } else {
      this.code.movRegImm(RDI, BigInt(Number(fieldOf(layout, "size"))));
      this.code.movRegImm(RSI, BigInt(Number(fieldOf(layout, "align"))));
      this.runtime("_object_new");
    }
    // The object being built is kept in a slot of the frame as well as in the
    // register the fields are written through, because anything a field's value
    // reads that builds an object of its own takes that register for itself and
    // does not hand it back. A field whose value reads a field of a nested
    // literal — `{ x: { x: 100, y: 200 }.x, y: q.y }` — therefore wrote both of
    // its fields into the *nested* block and left the object this literal
    // allocated holding whatever the allocation before it had put there: `r.x`
    // answered 30 where the source says 100.
    const register = this.objectRegister;
    // The slot the object is kept in is read only where a field's value takes the
    // register the object is filled in, and a value that allocates nothing
    // leaves that register alone: the slot is then written and never read, which
    // is a store for nothing.
    const keeps = register !== null && (fieldOf(value, "fields") as readonly { name: string; value: SemanticValue }[]).some((written) => allocates(fieldOf(written, "value") as SemanticValue));
    const object = keeps || register === null ? this.hold(POINTER, "blaze_object") : null;
    const where = object === null ? 0 : fieldOf(object, "offset") as number;
    if (object !== null) this.store(object);
    if (register !== null) this.code.movRegReg(register, RAX);
    else this.code.movRegMem(RCX, frame(where));
    const descriptor = this.objectDescriptor(layout);
    if (register !== null) this.code.movRegReg(RDI, register);
    else this.code.movRegMem(RDI, frame(where));
    this.code.leaLabel(RSI, descriptor);
    this.runtime("_object_describe");
    for (const written of fieldOf(value, "fields") as readonly { name: string; value: SemanticValue }[]) {
      const field = this.field(String(fieldOf(value, "layout")), String(fieldOf(written, "name")));
      const type = parseType(String(fieldOf(field, "type")));
      if (isWideType(type)) {
        // A wide field is four limbs written where the field is, not a value
        // the accumulator carries. The address is kept in a slot across the
        // value's own computation, because that value may be a kernel call and
        // a call takes every register the caller holds nothing of.
        const address = this.hold(POINTER, "blaze_wide_field");
        if (register !== null) this.code.movRegReg(RAX, register);
        else this.code.movRegMem(RAX, frame(where));
        this.store(address);
        this.wideValue(fieldOf(written, "value") as SemanticValue);
        this.code.movRegMem(RCX, frame(fieldOf(address, "offset") as number));
        for (let limb = 0; limb < this.limbsOf(type); limb += 1) {
          this.code.movMemRegSized(mem(RCX, fieldOf(field, "offset") as number + limb * LIMB_BYTES), [8, 9, 10, 11][limb], 8);
        }
        continue;
      }
      this.at(fieldOf(written, "value") as SemanticValue, type);
      // The register the object is filled in is read back out of the frame only
      // where the value written into the field takes it. A value that allocates
      // an object or an array of its own does, because the allocation is written
      // into the same register; one that does not leaves the object where it is,
      // and a call does not take it either — the convention asks a callee to
      // leave that register alone.
      //
      // The address the object is written through is a different matter where
      // there is no register of its own: the scratch holds the address there,
      // and a value written into the field takes the scratch as it does every
      // other value.
      if (register === null) this.code.movRegMem(RCX, frame(where));
      else if (allocates(fieldOf(written, "value") as SemanticValue)) this.code.movRegMem(register, frame(where));
      this.storeInto(type, register ?? RCX, fieldOf(field, "offset") as number);
    }
    if (register !== null) this.code.movRegReg(RAX, register);
    else this.code.movRegReg(RAX, RCX);
  }

  /* ---------------------------------------------------------------------- */
  /* Calls                                                                  */
  /* -------------------------------------------------------------------------- */

  private callValue(call: SemanticCall, wanted: SemanticType | null, sret: Held | null = null): void {
    const callArgs = fieldOf(call, "args") as readonly SemanticValue[];
    const argTypes = fieldOf(call, "argTypes") as readonly SemanticType[];
    const returns = fieldOf(call, "returns") as SemanticType;
    const signature = fieldOf(call, "signature") as { params: readonly { name: string; type: string }[]; symbol: string };
    if (String(fieldOf(call, "through")) !== "undefined") {
      // A call through a closure is a call of an address the value holds, and
      // this backend makes every call a call of a symbol it names.
      throw machineError(
        `${String(fieldOf(this.fn, "symbol"))} calls a value, which this backend cannot lower`,
        "a call through a closure goes to the address the closure holds; build with --backend c, which makes it",
      );
    }
    if (String(fieldOf(call, "builtin")) === "true") {
      this.builtin(call);
      if (wanted !== null && wanted.kind !== "void") this.convert(returns, wanted);
      return;
    }
    // An argument left where it is, rather than written to a slot and read back
    // out of it, is a store and a load saved for a value that never moved.
    //
    // Two forms are left where they are. One is the accumulator, which only the
    // last argument can use because evaluating a later one takes it away. The
    // other is the argument's own register, which a value that is nothing but a
    // read can be read into directly — a recursive call's argument is a field of
    // the parameter, and going through the accumulator for one is a move that
    // answers nothing. That is the last argument too, because an argument
    // register is one a later argument's own evaluation may write, and it is
    // only when nothing goes on the stack, because the arguments that do are
    // written out through the very registers the rest are read into.
    const types = callArgs.map((argument, at) => argTypes[at] ?? (fieldOf(argument, "type") as SemanticType));
    // A parameter that is a sequence is handed its length beside its pointer:
    // the hidden parameter the callee's prologue reads. The length is read
    // here, before any argument, because a length is a value the call reads and
    // the arguments are what the registers are filled with.
    const declared = fieldOf(signature, "params") as readonly { name: string; type: string }[];
    const carries = (at: number): boolean => {
      const parameter = declared[at];
      return parameter !== undefined && isSequence(parseType(String(fieldOf(parameter, "type"))));
    };
    const lengths = callArgs.map((argument, at) => (carries(at) ? this.lengthArgument(argument) : null));
    // The arguments as the callee reads them: a length is an argument of its
    // own, so the list the registers are handed out over is the source's
    // arguments with a whole number beside every sequence.
    const handed: SemanticType[] = [];
    const handedAt: number[] = [];
    for (const [at, type] of types.entries()) {
      handedAt.push(handed.length);
      handed.push(type);
      if (lengths[at] !== null) handed.push(USIZE);
    }
    const last = callArgs.length - 1;
    // A last argument that carries a length is not one a call can leave in the
    // register it takes: reading the length beside it would write over it.
    const trailing = last >= 0 && lengths[last] !== null;
    // A wide argument is handed over on the stack, so neither shortcut below
    // holds: the register an argument is read into is not the one its position
    // alone says, and the last argument is not the one in the accumulator.
    const wideArguments = types.some((type) => isWideType(type));
    const spilling = wideArguments ? -1 : firstArgumentOnStack(handed);
    const intoLast =
      last < 0 || wideArguments || trailing || spilling !== handed.length
        ? undefined
        : lastArgumentRegister(handed, handed.length - 1);
    let fresh = -1;
    let placed = -1;
    const evaluated: (Held | null)[] = callArgs.map((argument, at) => {
      const type = types[at];
      // An argument that is a name read at the type the parameter takes is the
      // slot itself: the register the call takes it in is filled from there
      // anyway, and the general form copies it into a slot of its own first.
      if (argument.k === "local") {
        const held = this.slot(String(fieldOf(argument, "name")));
        if (typeEquals(fieldOf(held, "type") as SemanticType, type)) return held;
        // A reference is a pointer whatever it points at, so a slot holding
        // one is already the register the call takes a reference in — the two
        // types are written differently and are the same word.
        if (isReference(fieldOf(held, "type") as SemanticType) && isReference(type)) return held;
      }
      // A wide argument is not a value the accumulator carries: it is four
      // limbs, so it is computed into a slot and copied from there to the
      // stack the convention hands it over on.
      if (isWideType(type)) {
        const held = this.hold(type, "blaze_wide_argument");
        this.wideValue(argument);
        this.wideStore(held);
        return held;
      }
      // Reading the last argument straight into the register it is taken in
      // writes that register before any of the other arguments are in place, so
      // it is only done where no other argument is pinned in it. An argument
      // whose value is a name the build gave a register of its own has no
      // `at` of its own to be clobbered by, which is what the call keeps the
      // register for; this one is a write in front of the reads rather than
      // beside them, so nothing else in the body would have said so.
      const pinnedHere =
        intoLast !== undefined &&
        callArgs.some(
          (other, otherAt) =>
            otherAt !== at && other.k === "local" && fieldOf(this.slot(String(fieldOf(other, "name"))), "register") === intoLast,
        );
      if (at === last && intoLast !== undefined && !pinnedHere && this.readIntoRegister(argument, intoLast, type)) {
        placed = handedAt[at] as number;
        return null;
      }
      const untouched = at === last && !trailing && spilling === handed.length;
      if (untouched) fresh = handedAt[at] as number;
      this.at(argument, type);
      const held = this.hold(type, "blaze_argument");
      if (!untouched) this.store(held);
      return held;
    });
    const args: (Held | null)[] = [];
    if (sret !== null) args.push(this.resultAddress(sret));
    for (const [at, held] of evaluated.entries()) {
      args.push(held);
      const length = lengths[at];
      if (length !== null) args.push(length);
    }
    // A wide answer's address is the first argument, so no argument is in the
    // register the callee reads it in: the two shortcuts below are the ones a
    // call without one takes, and passing the indices through would leave a
    // value the callee reads from the wrong register.
    const shift = sret === null && !wideArguments ? 0 : 1;
    this.callSymbol(
      String(fieldOf(signature, "symbol")),
      args,
      returns,
      shift === 0 ? fresh : -1,
      shift === 0 ? placed : -1,
    );
    if (sret !== null) return;
    if (wanted !== null && wanted.kind !== "void") this.convert(returns, wanted);
  }

  /**
   * The address of the slot a wide answer is written to, as the value of the
   * first argument. The address is written down rather than left in a register
   * because the arguments are evaluated after it, and an argument is free to
   * use every scratch register the accumulator is.
   */
  private resultAddress(out: Held): Held {
    const pointer = this.hold(POINTER, "blaze_wide_result_address");
    this.code.leaMemReg(mem(RSP, fieldOf(out, "offset") as number), RAX);
    this.store(pointer);
    return pointer;
  }

  /**
   * A value that is nothing but reads, read straight into the register the
   * caller wants it in.
   *
   * A name is read out of its slot, and a field of one is a second read at a
   * displacement. A field whose object is itself a name is the shape every
   * recursive call on a tree has.
   *
   * Anything that computes is refused, because the accumulator is what computes
   * things; so is a conversion, because the instruction that narrows the value
   * would have to write the register too and there is no general form here for
   * that. Only a value already at the type the parameter takes is read, so the
   * register holds the number the callee is declared to be handed.
   */
  private readIntoRegister(value: SemanticValue, register: number, type: SemanticType): boolean {
    if (value.k === "local") {
      const held = this.slot(String(fieldOf(value, "name")));
      if (!typeEquals(fieldOf(held, "type") as SemanticType, type) && !(isReference(fieldOf(held, "type") as SemanticType) && isReference(type))) return false;
      // A value the build gave a register of its own has no slot to read out
      // of: its distance into the frame is zero, which is the first slot's own
      // address, so it is copied from the register it is in.
      if (String(fieldOf(held, "register")) !== "null") {
        if (isFloatType(held.type)) this.code.movsMove(register, fieldOf(held, "register") as number, widthOf(fieldOf(held, "type") as SemanticType) === 4);
        else this.code.movRegReg(register, fieldOf(held, "register") as number);
        return true;
      }
      if (isFloatType(type)) this.code.movsLoad(register, frame(fieldOf(held, "offset") as number), widthOf(type) === 4);
      else this.code.movRegMemSized(register, frame(fieldOf(held, "offset") as number), widthOf(fieldOf(held, "type") as SemanticType), signedOf(fieldOf(held, "type") as SemanticType));
      return true;
    }
    if (value.k !== "loadField") return false;
    if (!typeEquals(fieldOf(value, "type") as SemanticType, type) && !(isReference(fieldOf(value, "type") as SemanticType) && isReference(type))) return false;
    const object = fieldOf(value, "object") as SemanticValue;
    if (object.k !== "local") return false;
    const base = this.slot(String(fieldOf(object, "name")));
    if (!typeEquals(fieldOf(base, "type") as SemanticType, fieldOf(object, "type") as SemanticType)) return false;
    const displacement = fieldOf(this.field(String(fieldOf(value, "layout")), String(fieldOf(value, "field"))), "offset") as number;
    if (String(fieldOf(base, "register")) !== "null") {
      const at = mem(fieldOf(base, "register") as number, displacement);
      if (isFloatType(type)) this.code.movsLoad(register, at, widthOf(type) === 4);
      else this.code.movRegMemSized(register, at, widthOf(type), signedOf(type));
      return true;
    }
    // The object is in the frame, so the field is read through it: the name is
    // read straight into the register the call takes it in and the field is
    // read through that. Going through the accumulator is a move that answers
    // nothing, and reading the object into a slot first is a store and a load
    // for a value that was read exactly once.
    if (isFloatType(type)) {
      this.code.movsLoad(register, frame(fieldOf(base, "offset") as number), widthOf(fieldOf(base, "type") as SemanticType) === 4);
      this.code.movsLoad(register, mem(register, displacement), widthOf(type) === 4);
      return true;
    }
    this.code.movRegMemSized(register, frame(fieldOf(base, "offset") as number), widthOf(fieldOf(base, "type") as SemanticType), signedOf(fieldOf(base, "type") as SemanticType));
    this.code.movRegMemSized(register, mem(register, displacement), widthOf(type), signedOf(type));
    return true;
  }

  /**
   * A float in the accumulator with everything below one dropped, which is what
   * rounding down is and what the C library is called in to do.
   *
   * Rounding down is a conversion to a whole number and the correction that
   * turns dropping the fraction towards zero into dropping it towards minus
   * infinity. A conversion answers with the whole part; the correction is one
   * taken off that answer where the whole part is above the value, which is a
   * value below zero and nothing else.
   *
   * Three values are answered without a conversion, and each is its own answer:
   * a value too large for a sixty-four bit whole number has no fraction in it,
   * a NaN is the floor of a NaN, and a zero is the floor of itself — which is
   * the one a conversion gets wrong, because it answers a negative zero with a
   * positive one, and `-0` is a number the language has and compares equal to
   * `0` without being it.
   *
   * So nothing here is a call, which is the whole of what this is for. A call
   * costs every name live across it a register the convention preserves, and on
   * a body that rounds down once per element of an array on every turn of a
   * loop that is the difference between one name kept in a register and four
   * kept in the frame.
   */
  private roundDown(): void {
    // Where the target has the instruction that rounds, it is the whole of it.
    if (this.rounds) {
      this.code.roundToInteger(XMM0, XMM0, 0x09, false);
      return;
    }
    const answer = this.code.label("Lrounded");
    // Only the accumulator, the scratch beside it and the whole number the
    // conversion answers in are written here: a value the allocator gave a
    // register of its own is in none of the three, and a rounding that took one
    // would take it. The value itself is kept in the scratch because the
    // conversion below writes over the accumulator.
    this.code.movsMove(XMM1, XMM0, false);
    // A zero is the floor of itself, and the conversion below answers a
    // negative zero with a positive one.
    this.code.sseCompareLabel(XMM0, this.floatLiteral(floatBits(0, false)), false, false);
    this.code.jcc("e", answer);
    this.code.sseCompareLabel(XMM0, this.floatLiteral(floatBits(WHOLE_FLOATS, false)), false, false);
    // What is left of a value inside the bound is a number, and a number that
    // size is a whole number already: rounding it down is the value. A value
    // that is not a number leaves every flag a comparison sets, so parity is
    // asked before the bound is. The bound is asked about on both sides for the
    // same reason a literal of it is not enough on one: a comparison against the
    // upper one alone says every value below it is below it too, which is every
    // value that is not whole enough.
    this.code.jcc("p", answer);
    this.code.jcc("a", answer);
    this.code.sseCompareLabel(XMM0, this.floatLiteral(floatBits(-WHOLE_FLOATS, false)), false, false);
    this.code.jcc("b", answer);
    this.code.cvtFloatToInt(RAX, XMM0, false, true);
    // The conversion writes the low half of the accumulator and leaves the half
    // above it as it was, so the register is cleared first and the answer does
    // not depend on what the turn before wrote there.
    this.code.zeroFloat(XMM0);
    this.code.cvtIntToFloat(XMM0, RAX, false);
    this.code.sseCompare(XMM0, XMM1, false, false);
    // The conversion drops towards zero, so it can only have rounded up — which
    // is a whole number one too many for a value below zero, and is the answer
    // itself for every other value.
    this.code.jcc("be", answer);
    this.code.sseMemLabel("sub", XMM0, this.floatLiteral(floatBits(1, false)), false);
    this.code.bind(answer);
  }

  /**
   * A call the compiler itself provides. Each is what the C library has by the
   */
  private builtin(call: SemanticCall): void {
    const args = fieldOf(call, "args") as readonly SemanticValue[];
    const callee = String(fieldOf(call, "callee"));
    const argTypes = fieldOf(call, "argTypes") as readonly SemanticType[];
    // The HTTP calls carry their handles and their text in the runtime's own
    // way, so they are written before the generic path: a handle is a pointer
    // and a text is a pointer to the bytes, and neither is a number the
    // convention would carry in a vector register.
    if (this.httpBuiltin(call)) return;
    const argument = args[0];
    if (callee === ARGV_LENGTH) {
      this.runtime("_argv_count");
      return;
    }
    if (callee === "argv") {
      this.at(argument, USIZE);
      this.code.movRegReg(RDI, RAX);
      this.runtime("_argv");
      return;
    }
    if (callee === "Math.fround" && args[0] !== undefined) {
      this.at(args[0], NUMBER);
      this.runtime("_fround");
      return;
    }
    if (callee === "Math.floor") {
      this.at(argument, NUMBER);
      this.roundDown();
      return;
    }
    if (callee === "tl.program_id") {
      this.code.xorFloat(XMM0, XMM0);
      return;
    }
    if (callee === "tl.math.exp") {
      this.at(args[0], NUMBER);
      this.external("exp");
      this.callForeign("exp");
      return;
    }
    if (callee === "tl.arange") {
      // Block range: a single program instance covers one block, so the
      // range is [0, end) on the CPU fallback.
      this.code.xorFloat(XMM0, XMM0);
      return;
    }
    if (callee === "tl.load") {
      this.at(args[0], NUMBER);
      return;
    }
    if (callee === "tl.store") {
      return;
    }
    if (callee === "array.new") {
      this.code.movRegImm(RDI, 0n);
      this.code.movRegImm(RSI, 8n);
      this.runtime("_array_new");
      return;
    }
    if (this.dictionaryBuiltin(call)) return;
    if (this.hostBuiltin(call)) return;
    // The dynamic values the runtime holds. A handle is a number the runtime
    // answers and a text is a pointer to the bytes it says, so the wall between
    // them is crossed here: a text is boxed into the handle the runtime reads,
    // and the handle a stringify answers is the text it says.
    // `JSON.stringify.pretty(value, n)` is the JSON of a record the compiler
    // cannot name: the block's layout is what the walk reads, and the answer is
    // the text it built.
    // A record copied, and a field of it written: the runtime copies the block
    // the handle names and sets the field the layout describes. Every argument
    // is a number the handle is carried in but the field's name, which is text.
    if (callee === "object.copy" || callee.startsWith("object.set.")) {
      const held: Held[] = [];
      for (const [at, argument] of args.entries()) {
        const type = argTypes[at] ?? (fieldOf(argument, "type") as SemanticType);
        const carries = isTextType(type) || isSequence(type) ? POINTER : NUMBER;
        // An unshaped reference is a double here, exactly as it is when a
        // promise settles a value.
        const target = type.kind === "ref" && type.of === null && type.name === undefined ? NUMBER : type;
        const slot = this.hold(carries, "blaze_spread");
        this.at(argument, target);
        this.store(slot);
        held.push(slot);
      }
      this.callSymbol(`blaze_rt_${callee.replace(/\./g, "_")}`, held, NUMBER);
      return;
    }
    if (callee === "JSON.stringify.pretty") {
      const held = this.hold(NUMBER, "blaze_json_value");
      // An unshaped reference is a double here, exactly as it is when a
      // promise settles a value.
      const valueType = argTypes[0] ?? NUMBER;
      const carries = valueType.kind === "ref" && valueType.of === null && valueType.name === undefined ? NUMBER : valueType;
      this.at(args[0] as never, carries);
      this.store(held);
      const spaces = this.hold(NUMBER, "blaze_json_indent");
      this.at(args[1] as never, argTypes[1] ?? NUMBER);
      this.store(spaces);
      this.callSymbol("blaze_rt_json_object", [held, spaces], TEXT);
      return;
    }
    if (callee === "JSON.stringify" && argument !== undefined) {
      const held = this.dynamicArgument(argument);
      this.callSymbol("blaze_rt_json_stringify", [held], NUMBER);
      const json = this.hold(NUMBER, "blaze_json");
      this.store(json);
      this.callSymbol("blaze_rt_to_text", [json], TEXT);
      return;
    }
    if (callee === "Date.parse" && argument !== undefined) {
      // The text goes down as the box it is, and the runtime reads it at the
      // box; the answer is the fraction the language holds it as.
      this.at(argument, TEXT);
      const text = this.hold(TEXT, "blaze_date_text");
      this.store(text);
      this.callSymbol("blaze_rt_date_parse", [text], NUMBER);
      return;
    }
    if (callee === "fs.readFileSync" && args[0] !== undefined && args[1] !== undefined) {
      // The path and the mode are the texts they are written as, and the answer
      // is the handle the runtime carries the text in: this backend keeps a
      // dynamic value as the bits of the double the handle is.
      this.at(args[0], TEXT);
      const path = this.hold(TEXT, "blaze_file_path");
      this.store(path);
      this.at(args[1], TEXT);
      const mode = this.hold(TEXT, "blaze_file_mode");
      this.store(mode);
      this.callSymbol("blaze_rt_file_read", [path, mode], NUMBER);
      this.dynamicResult();
      return;
    }
    if (callee === "blaze_rt_sha256_create") {
      // The hasher is a handle the runtime made and keeps: it answers the
      // double that names one, and the chain hands it back to the next call.
      this.callSymbol("blaze_rt_sha256_create", [], NUMBER);
      return;
    }
    if (callee === "blaze_rt_sha256_update" && args[0] !== undefined && args[1] !== undefined) {
      this.at(args[0], NUMBER);
      const hasher = this.hold(NUMBER, "blaze_hasher");
      this.store(hasher);
      this.at(args[1], TEXT);
      const text = this.hold(TEXT, "blaze_hash_text");
      this.store(text);
      this.callSymbol("blaze_rt_sha256_update", [hasher, text], NUMBER);
      return;
    }
    if (callee === "blaze_rt_sha256_digest" && argument !== undefined) {
      this.at(argument, NUMBER);
      const hasher = this.hold(NUMBER, "blaze_hasher");
      this.store(hasher);
      this.callSymbol("blaze_rt_sha256_digest", [hasher], NUMBER);
      // The runtime answers the hex digest as the handle a text is carried in,
      // and the IR says the answer is a text: the answer is already in the
      // register the unboxing takes it from.
      this.runtime("_to_text");
      return;
    }
    if (callee === "posix.dirname" && argument !== undefined) {
      this.at(argument, TEXT);
      const text = this.hold(TEXT, "blaze_path_text");
      this.store(text);
      this.callSymbol("blaze_rt_path_dirname", [text], TEXT);
      return;
    }
    if (callee === "posix.normalize" && argument !== undefined) {
      this.at(argument, TEXT);
      const text = this.hold(TEXT, "blaze_path_text");
      this.store(text);
      this.callSymbol("blaze_rt_path_normalize", [text], TEXT);
      return;
    }
    if (callee === "posix.join" && args[0] !== undefined && args[1] !== undefined) {
      this.at(args[0], TEXT);
      const left = this.hold(TEXT, "blaze_path_left");
      this.store(left);
      this.at(args[1], TEXT);
      const right = this.hold(TEXT, "blaze_path_right");
      this.store(right);
      this.callSymbol("blaze_rt_path_join", [left, right], TEXT);
      return;
    }
    if (callee === "blaze_rt_object_has_field" && args[0] !== undefined && args[1] !== undefined) {
      this.at(args[0], POINTER);
      const object = this.hold(POINTER, "blaze_has_object");
      this.store(object);
      this.at(args[1], TEXT);
      const field = this.hold(TEXT, "blaze_has_field");
      this.store(field);
      this.callSymbol("blaze_rt_object_has_field", [object, field], NUMBER);
      return;
    }
    if (callee === "JSON.parse" && argument !== undefined) {
      const text = this.dynamicArgument(argument);
      this.callSymbol("blaze_rt_json_parse", [text], NUMBER);
      this.dynamicResult();
      return;
    }
    if (callee === "JSON.get" && args[0] !== undefined && args[1] !== undefined) {
      const object = this.dynamicArgument(args[0]);
      this.at(args[1], TEXT);
      const field = this.hold(TEXT, "blaze_field");
      this.store(field);
      this.callSymbol("blaze_rt_json_get", [object, field], NUMBER);
      this.dynamicResult();
      return;
    }
    if (callee === "JSON.typeof" && argument !== undefined) {
      // The name `typeof` answers for a value the read could not type. The
      // value goes down as the handle or the number it is, and the runtime
      // answers the text that names its kind.
      const value = this.dynamicArgument(argument);
      this.callSymbol("blaze_rt_type_of", [value], TEXT);
      return;
    }
    if (callee === SHARED) {
      // A block of bytes the program lays out is the allocator's answer: the
      // count is read as a size and the block is handed back, which is what
      // the C driver writes the same call as.
      this.countAsSize(argument);
      this.code.movRegReg(RDI, RAX);
      this.runtime("_allocate");
      return;
    }
    if (callee === "Promise") {
      this.external("blaze_promise_new");
      this.callForeign("blaze_promise_new");
      // The runtime answers the promise as the address it holds, and the
      // language holds a handle as the number that address is. The address is
      // kept as the pointer it is while the executor runs, because the call
      // that sets it as current takes a pointer, and it is turned into the
      // number the call answers with at the end.
      const slot = this.holdSlot(POINTER, "blaze_promise");
      this.store(slot);
      this.load(slot);
      this.code.movRegReg(RDI, RAX);
      this.external("blaze_promise_set_current");
      this.callForeign("blaze_promise_set_current");
      const cb = args[0];
      if (cb.k === "functionRef") {
        const captures = Array.isArray(fieldOf(cb, "captures"))
          ? fieldOf(cb, "captures") as readonly { name: string }[]
          : [];
        const captureArgs = captures.map((capture) => this.slot(String(fieldOf(capture, "name"))));
        this.external(String(fieldOf(cb, "name")));
        this.callSymbol(String(fieldOf(cb, "name")), captureArgs, { kind: "void" });
      }
      this.external("blaze_promise_clear_current");
      this.callForeign("blaze_promise_clear_current");
      this.load(slot);
      this.code.zeroFloat(XMM0);
      this.code.cvtIntToFloat(XMM0, RAX, false);
      this.accumulatorNote = null;
      return;
    }
    if (callee === "Promise.failed" || callee === "Promise.message") {
      // The handle is the number the promise's address is, and the runtime
      // reads the promise that address points at: a failed promise answers 1
      // and the message it failed with, which is a text the runtime holds.
      this.at(argument, NUMBER);
      this.code.cvtFloatToInt(RAX, XMM0, false, true);
      this.code.movRegReg(RDI, RAX);
      const symbol = callee === "Promise.failed" ? "blaze_promise_failed" : "blaze_promise_message";
      this.external(symbol);
      this.callForeign(symbol);
      if (callee === "Promise.message") {
        // Reading the message is what handles the failure: the pending error
        // flag is what an async function's promise settles on, so it is
        // cleared here while the message is held.
        const message = this.hold(TEXT, "blaze_message");
        this.store(message);
        this.external("blaze_error_clear");
        this.callForeign("blaze_error_clear");
        this.load(message);
      }
      return;
    }
    if (callee === "Promise.await" || callee === "Promise.await.whole" || callee === "Promise.await.text" || callee === "Promise.await.bool" || callee === "Promise.await.value" || callee === "Promise.await.nothing") {
      this.at(args[0], NUMBER);
      // The handle is the number the promise's address is, and the runtime
      // reads the promise that address points at.
      this.code.cvtFloatToInt(RAX, XMM0, false, true);
      this.code.movRegReg(RDI, RAX);
      if (callee === "Promise.await.text") {
        this.external("blaze_promise_await_text");
        this.callForeign("blaze_promise_await_text");
        return;
      }
      if (callee === "Promise.await.whole") {
        this.external("blaze_promise_await");
        this.callForeign("blaze_promise_await");
        this.code.cvtFloatToInt(RAX, XMM0, false, true);
        return;
      }
      if (callee === "Promise.await.bool") {
        this.external("blaze_promise_await");
        this.callForeign("blaze_promise_await");
        this.code.cvtFloatToInt(RAX, XMM0, false, true);
        this.code.test(RAX);
        this.code.setcc("ne", RAX);
        return;
      }
      if (callee === "Promise.await.value") {
        this.external("blaze_promise_await_value");
        this.callForeign("blaze_promise_await_value");
        return;
      }
      if (callee === "Promise.await.nothing") {
        this.external("blaze_promise_await_nothing");
        this.callForeign("blaze_promise_await_nothing");
        this.code.xorFloat(XMM0, XMM0);
        return;
      }
      this.external("blaze_promise_await");
      this.callForeign("blaze_promise_await");
      return;
    }
    if (callee.startsWith("Promise.resolve") || callee.startsWith("Promise.settle")) {
      const settled = callee.startsWith("Promise.settle");
      const symbol = settled ? "blaze_promise_settled" : "blaze_promise_resolved";
      if (callee.endsWith(".text")) {
        this.at(args[0], TEXT);
        this.code.movRegReg(RDI, RAX);
        this.external(`${symbol}_text`);
        this.callForeign(`${symbol}_text`);
      } else if (callee.endsWith(".bool")) {
        this.at(args[0], TRUTH);
        this.code.cvtIntToFloat(XMM0, RAX, false);
        this.external(`${symbol}_number`);
        this.callForeign(`${symbol}_number`);
      } else {
        this.at(args[0], NUMBER);
        const name = callee.endsWith(".value") ? `${symbol}_value` : `${symbol}_number`;
        this.external(name);
        this.callForeign(name);
      }
      // The runtime answers the promise as the address it holds, and the
      // language holds a handle as the number that address is.
      this.code.cvtIntToFloat(XMM0, RAX, false);
      return;
    }
    if (callee === "Promise.resolve.nothing" || callee === "Promise.settle.nothing") {
      const name = callee === "Promise.settle.nothing" ? "blaze_promise_settled_null" : "blaze_promise_resolved_null";
      this.external(name);
      this.callForeign(name);
      this.code.cvtIntToFloat(XMM0, RAX, false);
      return;
    }
    if (callee === "Promise.reject") {
      const message = args[0];
      if (message !== undefined && isTextType(message.type)) {
        this.at(message, TEXT);
        this.code.movRegReg(RDI, RAX);
      } else if (message !== undefined) {
        this.at(message, NUMBER);
        this.external("blaze_rt_box_number");
        this.callForeign("blaze_rt_box_number");
        this.external("blaze_rt_to_text");
        this.callForeign("blaze_rt_to_text");
        this.code.movRegReg(RDI, RAX);
      }
      this.external("blaze_promise_rejected");
      this.callForeign("blaze_promise_rejected");
      this.code.cvtIntToFloat(XMM0, RAX, false);
      return;
    }
    if (callee === "resolve") {
      const value = args[0];
      if (value !== undefined && isTextType(value.type)) {
        this.at(value, TEXT);
        this.code.movRegReg(RDI, RAX);
        this.external("blaze_promise_resolve_current_text");
        this.callForeign("blaze_promise_resolve_current_text");
      } else if (value !== undefined && value.k === "nothing") {
        this.external("blaze_promise_resolve_current_null");
        this.callForeign("blaze_promise_resolve_current_null");
      } else if (value !== undefined && value.type.kind === "ref") {
        this.at(value, NUMBER);
        this.external("blaze_promise_resolve_current_value");
        this.callForeign("blaze_promise_resolve_current_value");
      } else {
        this.at(args[0], argTypes[0] ?? NUMBER);
        this.external("blaze_promise_resolve_current");
        this.callForeign("blaze_promise_resolve_current");
      }
      this.code.xorFloat(XMM0, XMM0);
      return;
    }
    if (callee === "reject") {
      const message = args[0];
      if (message !== undefined && isTextType(message.type)) {
        this.at(message, TEXT);
        this.code.movRegReg(RDI, RAX);
      } else if (message !== undefined) {
        this.at(message, NUMBER);
        this.external("blaze_rt_box_number");
        this.callForeign("blaze_rt_box_number");
        this.external("blaze_rt_to_text");
        this.callForeign("blaze_rt_to_text");
        this.code.movRegReg(RDI, RAX);
      }
      this.external("blaze_promise_reject_current");
      this.callForeign("blaze_promise_reject_current");
      this.code.xorFloat(XMM0, XMM0);
      return;
    }
    if (callee === "Math.round") {
      this.at(argument, NUMBER);
      const operand = this.holdSlot(NUMBER, "blaze_rounded");
      this.store(operand);
      this.floatConstant(0.5, NUMBER, XMM1);
      this.code.sse("add", XMM0, XMM1, false);
      this.roundDown();
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
    if (callee === "blaze_rt_view_load_float" || callee === "blaze_rt_view_store_float") {
      // The float a window of bytes holds, and the bytes a float is written
      // into: the block goes down as the address it is, and the offset, the
      // value and the width as the numbers they are.
      const block = this.hold(POINTER, "blaze_view_block");
      this.at(args[0], POINTER);
      this.store(block);
      const held: Held[] = [block];
      const numbers = callee === "blaze_rt_view_load_float" ? [1, 2] : [1, 2, 3];
      for (const at of numbers) {
        this.at(args[at], NUMBER);
        const one = this.hold(POINTER, "blaze_view_number");
        this.store(one);
        held.push(one);
      }
      this.callSymbol(callee, held, callee === "blaze_rt_view_load_float" ? NUMBER : VOID_TYPE);
      return;
    }
    // The text the program reads apart. The arguments are written down one
    // at a time, because evaluating one takes the accumulator the other is
    // read into, and the runtime is called with the two of them where the
    // convention puts them.
    if (
      callee === "text.indexOf" ||
      callee === "TextEncoder.encode" ||
      callee === "text.codePointAt" ||
      callee === "text.slice" ||
      callee === "text.trim" ||
      callee === "text.trimStart" ||
      callee === "text.trimEnd" ||
      callee === "text.toLowerCase" ||
      callee === "text.toUpperCase"
    ) {
      const text = (at: number): Held => {
        const value = args[at];
        if (isTextType(value.type)) {
          this.at(value, TEXT);
        } else {
          // A dynamic value crosses as the runtime's own text: the value is the
          // handle it is held as, carried as the number the convention hands a
          // double over as, and the runtime reads the bytes out of the box it
          // names.
          this.value(value);
          this.code.movdXmm(XMM0, RAX);
          this.runtime("_to_text");
        }
        const held = this.hold(TEXT, "blaze_text");
        this.store(held);
        return held;
      };
      // An index the source wrote as a number is carried as the whole number
      // it is: the fraction is read down into the accumulator's whole half,
      // and the call takes it where the convention puts a whole number.
      const index = (at: number): Held => {
        this.at(args[at], NUMBER);
        this.code.cvtFloatToInt(RAX, XMM0, false, true);
        const held = this.hold(POINTER, "blaze_text_index");
        this.store(held);
        return held;
      };
      if (callee === "TextEncoder.encode") {
        // The bytes a text is written as: the block the service lays the bytes
        // out in, which is the address a byte array is read at.
        const bytes = text(0);
        this.callSymbol("blaze_rt_text_bytes", [bytes], POINTER);
        return;
      }
      if (callee === "text.codePointAt") {
        const sliced = text(0);
        this.at(args[1], NUMBER);
        const held = this.hold(POINTER, "blaze_code_point_at");
        this.store(held);
        this.callSymbol("blaze_rt_text_code_point_at", [sliced, held], TEXT);
        return;
      }
      if (callee === "text.indexOf") {
        const left = text(0);
        const right = text(1);
        this.callSymbol("blaze_rt_text_index_of", [left, right], TEXT);
        // The index answers as a whole number in the accumulator, and the
        // number the language holds is a fraction: the widening is here.
        this.code.zeroFloat(XMM0);
        this.code.cvtIntToFloat(XMM0, RAX, false);
        return;
      }
      if (callee === "text.slice") {
        const sliced = text(0);
        const start = index(1);
        // The runtime's entry takes the stop always: a slice written with one
        // index runs to the end, which is a stop no text reaches.
        let stop: Held;
        if (args.length > 2) {
          stop = index(2);
        } else {
          this.code.movRegImm(RAX, 0x7fff_ffff_ffff_ffffn);
          stop = this.hold(POINTER, "blaze_text_stop");
          this.store(stop);
        }
        this.callSymbol("blaze_rt_text_slice", [sliced, start, stop], TEXT);
        return;
      }
      const folded = text(0);
      if (callee === "text.trimStart") {
        this.callSymbol("blaze_rt_text_trim_start", [folded], TEXT);
        return;
      }
      if (callee === "text.trimEnd") {
        this.callSymbol("blaze_rt_text_trim_end", [folded], TEXT);
        return;
      }
      if (callee === "text.toLowerCase") {
        this.callSymbol("blaze_rt_text_lower", [folded], TEXT);
        return;
      }
      if (callee === "text.toUpperCase") {
        this.callSymbol("blaze_rt_text_upper", [folded], TEXT);
        return;
      }
      this.callSymbol("blaze_rt_text_trim", [folded], TEXT);
      return;
    }
    if (callee.startsWith("blaze_rt_regex_")) {
      // The pattern, the flags and the text are texts, and the replacement of
      // a replace is one too. Each is held before the next is read: reading one
      // takes the accumulator the next is read into.
      const text = (at: number): Held => {
        const value = args[at];
        if (isTextType(value.type)) {
          this.at(value, TEXT);
        } else {
          this.value(value);
          this.runtime("_to_text");
        }
        const held = this.hold(TEXT, "blaze_text");
        this.store(held);
        return held;
      };
      if (callee === "blaze_rt_regex_replace") {
        const pattern = text(0);
        const flags = text(1);
        const subject = text(2);
        const replacement = text(3);
        this.callSymbol("blaze_rt_regex_replace", [pattern, flags, subject, replacement], TEXT);
        return;
      }
      const pattern = text(0);
      const flags = text(1);
      const subject = text(2);
      if (callee === "blaze_rt_regex_test" || callee === "blaze_rt_regex_search") {
        this.callSymbol(callee, [pattern, flags, subject], NUMBER);
        return;
      }
      this.callSymbol(callee, [pattern, flags, subject], POINTER);
      return;
    }
    if (callee === "envGet" && args[0] !== undefined) {
      this.at(args[0], TEXT);
      const name = this.hold(TEXT, "blaze_env_name");
      this.store(name);
      this.callSymbol("blaze_rt_env_get", [name], TEXT);
      return;
    }
    if (callee === "readTextFile" && args[0] !== undefined && args[1] !== undefined) {
      this.at(args[0], TEXT);
      const path = this.hold(TEXT, "blaze_read_text_path");
      this.store(path);
      this.at(args[1], TEXT);
      const mode = this.hold(TEXT, "blaze_read_text_mode");
      this.store(mode);
      this.callSymbol("blaze_rt_file_read_text", [path, mode], TEXT);
      return;
    }
    if (callee === "syncFile" && args[0] !== undefined) {
      this.at(args[0], TEXT);
      const path = this.hold(TEXT, "blaze_sync_path");
      this.store(path);
      this.callSymbol("blaze_rt_file_sync", [path], NUMBER);
      return;
    }
    if (callee === "hostPlatformName" || callee === "hostArchName") {
      this.callSymbol(callee === "hostPlatformName" ? "blaze_rt_host_platform" : "blaze_rt_host_architecture", [], TEXT);
      return;
    }
    if (
      callee === "runCommand" &&
      args[0] !== undefined &&
      args[1] !== undefined &&
      args[2] !== undefined &&
      args[3] !== undefined
    ) {
      this.at(args[0], TEXT);
      const command = this.hold(TEXT, "blaze_run_command");
      this.store(command);
      this.at(args[1], TEXT);
      const input = this.hold(TEXT, "blaze_run_input");
      this.store(input);
      this.at(args[2], NUMBER);
      const timeout = this.hold(NUMBER, "blaze_run_timeout");
      this.store(timeout);
      this.at(args[3], TEXT);
      const cwd = this.hold(TEXT, "blaze_run_cwd");
      this.store(cwd);
      this.callSymbol("blaze_rt_process_run", [command, input, timeout, cwd], TEXT);
      return;
    }
    if (callee === "streamIsTTY" && args[0] !== undefined) {
      this.at(args[0], NUMBER);
      const stream = this.hold(NUMBER, "blaze_tty_stream");
      this.store(stream);
      this.callSymbol("blaze_rt_stream_is_tty", [stream], NUMBER);
      return;
    }
    if (callee === "setExitCode" && args[0] !== undefined) {
      this.at(args[0], NUMBER);
      const code = this.hold(NUMBER, "blaze_exit_code");
      this.store(code);
      this.callSymbol("blaze_rt_set_exit_code", [code], NUMBER);
      return;
    }
    if (callee === "exitCode") {
      this.callSymbol("blaze_rt_exit_code", [], NUMBER);
      return;
    }
    if (callee === "readLine") {
      this.callSymbol("blaze_rt_read_line", [], TEXT);
      return;
    }
    if (callee === "cwdPath" || callee === "processId" || callee === "hostProcessId" || callee === "cpuCount") {
      // The host answers each with a value and takes nothing: the path is a
      // text and the two counts are numbers.
      const symbol =
        callee === "cwdPath"
          ? "blaze_rt_cwd"
          : callee === "processId" || callee === "hostProcessId"
            ? "blaze_rt_process_id"
            : "blaze_rt_cpu_count";
      this.callSymbol(symbol, [], callee === "cwdPath" ? TEXT : NUMBER);
      return;
    }
    if (callee === "sleepMs" && args[0] !== undefined) {
      this.at(args[0], NUMBER);
      const milliseconds = this.hold(NUMBER, "blaze_sleep_ms");
      this.store(milliseconds);
      this.callSymbol("blaze_rt_sleep_ms", [milliseconds], NUMBER);
      return;
    }
    if (callee === "removePath" && args[0] !== undefined && args[1] !== undefined) {
      this.at(args[0], TEXT);
      const path = this.hold(TEXT, "blaze_remove_path");
      this.store(path);
      this.at(args[1], NUMBER);
      const recursive = this.hold(NUMBER, "blaze_remove_recursive");
      this.store(recursive);
      this.callSymbol("blaze_rt_path_remove", [path, recursive], NUMBER);
      return;
    }
    if (callee === "appendPath" && args[0] !== undefined && args[1] !== undefined) {
      this.at(args[0], TEXT);
      const path = this.hold(TEXT, "blaze_append_path");
      this.store(path);
      this.at(args[1], TEXT);
      const text = this.hold(TEXT, "blaze_append_text");
      this.store(text);
      this.callSymbol("blaze_rt_file_append", [path, text], NUMBER);
      return;
    }
    if (callee === "copyPath" && args[0] !== undefined && args[1] !== undefined) {
      this.at(args[0], TEXT);
      const from = this.hold(TEXT, "blaze_copy_from");
      this.store(from);
      this.at(args[1], TEXT);
      const to = this.hold(TEXT, "blaze_copy_to");
      this.store(to);
      this.callSymbol("blaze_rt_file_copy", [from, to], NUMBER);
      return;
    }
    if (callee === "makeDir" && args[0] !== undefined) {
      this.at(args[0], TEXT);
      const path = this.hold(TEXT, "blaze_make_path");
      this.store(path);
      this.at({ k: "const", type: NUMBER, text: "1" }, NUMBER);
      const recursive = this.hold(NUMBER, "blaze_make_recursive");
      this.store(recursive);
      this.callSymbol("blaze_rt_dir_make", [path, recursive], NUMBER);
      return;
    }
    if (callee === "renamePath" && args[0] !== undefined && args[1] !== undefined) {
      this.at(args[0], TEXT);
      const from = this.hold(TEXT, "blaze_rename_from");
      this.store(from);
      this.at(args[1], TEXT);
      const to = this.hold(TEXT, "blaze_rename_to");
      this.store(to);
      this.callSymbol("blaze_rt_path_rename", [from, to], NUMBER);
      return;
    }
    if (callee === "dirList" && args[0] !== undefined) {
      // The directory's path is the text it is, and the runtime answers the
      // JSON of its entries as a text.
      this.at(args[0], TEXT);
      const path = this.hold(TEXT, "blaze_dir_path");
      this.store(path);
      this.callSymbol("blaze_rt_dir_list", [path], TEXT);
      return;
    }
    if ((callee === "pathKind" || callee === "fileSize") && args[0] !== undefined) {
      // The path is the text it is; the runtime reads it and answers the kind
      // the entry is or the bytes the file holds.
      this.at(args[0], TEXT);
      const path = this.hold(TEXT, "blaze_stat_path");
      this.store(path);
      this.callSymbol(callee === "pathKind" ? "blaze_rt_path_kind" : "blaze_rt_file_size", [path], NUMBER);
      return;
    }
    if (callee === "fs.existsSync" && args[0] !== undefined) {
      // The path is the text it is, and the runtime answers whether it names
      // anything.
      this.at(args[0], TEXT);
      const path = this.hold(TEXT, "blaze_exists_path");
      this.store(path);
      this.callSymbol("blaze_rt_path_exists", [path], NUMBER);
      return;
    }
    if (callee === "fs.writeFileSync" && args[0] !== undefined && args[1] !== undefined) {
      // The path and the text go down as the texts they are, and the answer is
      // the bytes written, which a statement drops.
      this.at(args[0], TEXT);
      const path = this.hold(TEXT, "blaze_file_path");
      this.store(path);
      this.at(args[1], TEXT);
      const text = this.hold(TEXT, "blaze_file_text");
      this.store(text);
      this.at({ k: "const", type: NUMBER, text: "0" }, NUMBER);
      const append = this.hold(NUMBER, "blaze_file_append");
      this.store(append);
      this.callSymbol("blaze_rt_file_write", [path, text, append], NUMBER);
      return;
    }
    if (callee === "process.env") {
      // The environment variable is read by its name, and the answer is the
      // text it is set to: a pointer to the bytes, which is what a text is.
      this.at(args[0], TEXT);
      this.code.movRegReg(RDI, RAX);
      this.runtime("_env_get");
      return;
    }
    if (callee === "process.stderr.write") {
      // The error stream is the runtime's own, and the text is handed over as
      // a pointer to the bytes it is.
      this.at(args[0], TEXT);
      this.code.movRegReg(RDI, RAX);
      this.runtime("_print_error_text");
      return;
    }
    if (callee === "stdoutWrite") {
      this.at(args[0], TEXT);
      this.code.movRegReg(RDI, RAX);
      this.runtime("_print_text");
      return;
    }
    if (callee === "hostArgumentCount") {
      this.runtime("_host_argument_count");
      return;
    }
    if (callee === "hostArgument" && args[0] !== undefined) {
      this.at(args[0], NUMBER);
      this.code.movRegReg(RDI, RAX);
      this.runtime("_host_argument");
      return;
    }
    if (callee === "process.hrtime.bigint") {
      // The runtime holds the clock, and the reading is the whole number of
      // nanoseconds it answers in.
      this.runtime("_monotonic_ns");
      return;
    }
    if (callee === "Number" && args[0] !== undefined) {
      const wide = args[0];
      const wideType = wide.type;
      if (wideType.kind === "primitive" && (wideType.name === "u256" || wideType.name === "i256")) {
        // A wide whole number is the decimal the runtime's formatter writes,
        // read back by the C library: the double Number(BigInt) answers.
        const slot = this.hold(wideType, "blaze_wide_number");
        this.wideValue(wide);
        this.wideStore(slot);
        this.code.leaMemReg(mem(RSP, slot.offset), RDI);
        this.library(wideType.name === "i256" ? "_i256_to_double" : "_u256_to_double");
        return;
      }
    }
    if (callee === "Number.parseInt") {
      this.at(args[0], TEXT);
      const text = this.hold(TEXT, "blaze_parse_int_text");
      this.store(text);
      this.at(args[1], NUMBER);
      const held = this.hold(POINTER, "blaze_parse_int_radix");
      this.store(held);
      this.callSymbol("blaze_rt_parse_int", [text, held], TEXT);
      return;
    }
    if (callee === "String.fromCodePoint") {
      this.at(argument, NUMBER);
      const held = this.hold(POINTER, "blaze_from_code_point");
      this.store(held);
      this.callSymbol("blaze_rt_from_code_point", [held], TEXT);
      return;
    }
    const library = MATH_LIBRARY[callee];
    if (library === undefined || builtinFor(callee) === null) {
      throw machineError(`${String(fieldOf(this.fn, "symbol"))} calls ${callee}, which this backend does not lower`);
    }
    this.at(argument, NUMBER);
    this.library(library);
  }

  /**
   * A dictionary service, or the block operation a list is built by.
   *
   * A dictionary is the double handle the runtime answers, its key is the text
   * the program wrote, and the value an entry holds is the number the entry
   * was written at: `_text` and `_ref` name a value of another kind, and the
   * service answers the kind its name says. Every argument is written down
   * before the call is made, because reading one may be a call of its own and
   * that call takes the registers the others are waiting in.
   */
  /**
   * A host service, through the table that names it.
   *
   * Every argument is read at the kind the table states and written down before
   * the call is made, because reading one may be a call that takes the
   * registers the others wait in. A value that is the same on every call — the
   * flag a write takes — is a constant the table hands over beside them.
   */
  private hostBuiltin(call: SemanticCall): boolean {
    const callee = String(fieldOf(call, "callee"));
    const callArgs = fieldOf(call, "args") as readonly SemanticValue[];
    const service = HOST_SERVICES.get(callee) as
      | { symbol: string; args: readonly ("text" | "number")[]; extra?: readonly number[]; returns: "number" | "text" | "dynamic" | "void" }
      | undefined;
    if (service === undefined) return false;
    const held: Held[] = [];
    const serviceArgs = fieldOf(service, "args") as readonly ("text" | "number")[];
    for (const [at, kind] of serviceArgs.entries()) {
      const argument = callArgs[at];
      if (argument === undefined) throw machineError(`${callee} is called with fewer arguments than the host takes`);
      if (String(kind) === "text") {
        this.at(argument, TEXT);
        const slot = this.hold(TEXT, "blaze_host_text");
        this.store(slot);
        held.push(slot);
      } else {
        this.at(argument, NUMBER);
        const slot = this.hold(NUMBER, "blaze_host_number");
        this.store(slot);
        held.push(slot);
      }
    }
    for (const value of (fieldOf(service, "extra") as readonly number[] | undefined) ?? []) {
      const constant: SemanticValue = { k: "const", type: NUMBER, text: String(value) };
      this.at(constant, NUMBER);
      const slot = this.hold(NUMBER, "blaze_host_constant");
      this.store(slot);
      held.push(slot);
    }
    if (String(fieldOf(service, "returns")) === "void") {
      // A service that answers nothing still answers this language a number:
      // the call is made, and the one it hands back is what a statement reads.
      this.callSymbol(String(fieldOf(service, "symbol")), held, VOID_TYPE);
      this.code.movRegImm(RAX, 1n);
      this.code.zeroFloat(XMM0);
      this.code.cvtIntToFloat(XMM0, RAX, false);
      return true;
    }
    const answer = String(fieldOf(service, "returns")) === "text" ? TEXT : NUMBER;
    this.callSymbol(String(fieldOf(service, "symbol")), held, answer);
    if (String(fieldOf(service, "returns")) === "dynamic") this.dynamicResult();
    return true;
  }

  private dictionaryBuiltin(call: SemanticCall): boolean {
    const callee = String(fieldOf(call, "callee"));
    const callArgs = fieldOf(call, "args") as readonly SemanticValue[];
    const argTypes = fieldOf(call, "argTypes") as readonly SemanticType[];
    const answer = DICTIONARY_SERVICES.get(String(fieldOf(call, "callee")));
    if (answer === undefined) return false;
    const held: Held[] = [];
    for (const [at, argument] of callArgs.entries()) {
      const type = argTypes[at] ?? (fieldOf(argument, "type") as SemanticType);
      // A block is handed over as the pointer it is, a text as the bytes it
      // says, and everything else — the handle, a key, a value — as the number
      // the convention carries a double in. A value read at a reference the
      // compiler cannot name is boxed the way the C backend boxes it, and the
      // handle is those bits in the vector register the double goes in.
      let carries = NUMBER;
      if (isTextType(type)) {
        this.at(argument, TEXT);
        carries = TEXT;
      } else if (isSequence(type)) {
        this.at(argument, POINTER);
        carries = POINTER;
      } else if (isDynamicType(type)) {
        this.at(argument, ANY_TYPE);
        // A key of a reference is the address as a number: the runtime writes
        // it in base sixteen and reads it back with an integer conversion, so
        // the bits of the pointer are not the value it is asked for. Every
        // other reference is the handle the value was written as, and its bits
        // are what the runtime keeps.
        if (callee.includes("_refkey") && at === 1) {
          this.code.zeroFloat(XMM0);
          this.code.cvtIntToFloat(XMM0, RAX, false);
        } else {
          this.code.movdXmm(XMM0, RAX);
        }
      } else {
        this.at(argument, NUMBER);
      }
      const slot = this.hold(carries, "blaze_dictionary");
      this.store(slot);
      held.push(slot);
    }
    const returns = answer === "text" ? TEXT : answer === "pointer" ? POINTER : NUMBER;
    // `map.values` is the name the IR gives the service, and the runtime's own
    // entry is the one it calls.
    const symbol = callee === "map.values" ? "blaze_rt_dict_values" : callee;
    this.callSymbol(symbol, held, returns);
    if (answer === "dynamic") {
      if (callee === "blaze_rt_dict_key_ref_at") {
        // The key is the address as a number again, so it is the integer the
        // double says rather than the bits of the double.
        this.code.cvtFloatToInt(RAX, XMM0, false, true);
      } else {
        // A handle arrives in the vector register a double is returned in, and
        // this backend keeps a value of that kind as the bits of the double in
        // the accumulator.
        this.dynamicResult();
      }
    }
    return true;
  }

  /**
   * A call, with the arguments where the convention puts them. The registers
   * are read last, because writing an argument that has no register left goes
   * through the very registers the others are read into.
   *
   * Within that, the order the registers are *written* in is not the order the
   * arguments are in. An argument the build gave a register of its own is read
   * out of that register, and the register an earlier argument is taken in is
   * very often the one it is in: `f(t1, bx)` with `bx` in `rdi` and `t1` taken
   * in `rdi` wrote `t1` over `bx` and then handed the callee `t1` for both
   * arguments. The same goes for the accumulator a last argument is left in,
   * which `xmm0` is also the first float argument register.
   *
   * So every argument that reads a register waits for every argument that
   * writes it, and two arguments that want each other's registers — which no
   * order satisfies — are broken by putting one of them in the frame first.
   */
  private callSymbol(symbol: string, args: readonly (Held | null)[], returns: SemanticType, fresh = -1, placed = -1): void {
    this.external(symbol);
    // What this function keeps in a vector register is written down before the
    // arguments are placed, not after: an argument of a float is handed over in
    // one of those registers, and writing that register into the slot the
    // function's own value is kept in would lose it.
    const foreign =
      symbol !== this.fn.symbol && (this.foreign.has(symbol) || !this.callable.has(symbol));
    if (foreign) this.saveVectorsForCall();
    const onStack: { held: Held; slot: number }[] = [];
    const registers: { register: number; held: Held; at: number }[] = [];
    let general = 0;
    let floating = 0;
    let stack = 0;
    let exhausted = false;
    for (const [at, argument] of args.entries()) {
      if (argument === null) continue;
      // A wide number is thirty-two bytes, and the convention hands it over on
      // the stack in four slots, sixteen byte aligned, rather than in a
      // register file that has no room for it. It takes no register of its own,
      // so every argument after it is handed over exactly as it would have been
      // without it.
      if (isWideType(argument.type)) {
        if (stack % 2 !== 0) stack += 1;
        onStack.push({ held: argument, slot: stack });
        stack += this.limbsOf(argument.type);
        continue;
      }
      // The registers are handed out in the order the arguments are written, and
      // an argument that has none left is on the stack with every argument after
      // it, whichever class those are. An argument already in its own register
      // still takes one, so that the counts below are the ones the convention
      // hands out.
      const register = exhausted ? undefined : isFloatType(argument.type) ? SSE_ARGUMENTS[floating] : INTEGER_ARGUMENTS[general];
      if (register === undefined) {
        exhausted = true;
        onStack.push({ held: argument, slot: stack });
        stack += 1;
        continue;
      }
      if (isFloatType(argument.type)) floating += 1;
      else general += 1;
      registers.push({ register, held: argument, at });
    }
    // An argument that has run out of registers goes on the stack below where
    // the return address is pushed, which is below the frame — so it is written
    // before the stack is moved down past it, because the frame is addressed
    // from the stack pointer and every slot the registers below are read from
    // has to still be where the prologue left it when they are read.
    //
    // The move itself is a whole number of sixteen byte steps, so the stack is
    // the same alignment at the call as it is everywhere else in the body, which
    // is what every function the C library was compiled for assumes of the call
    // it is entered by.
    const slots = Math.ceil(stack / 2) * 2;
    for (const entry of onStack) {
      const held = fieldOf(entry, "held") as Held;
      const at = fieldOf(entry, "slot") as number;
      if (isWideType(fieldOf(held, "type") as SemanticType)) {
        // A wide argument is four limbs the callee reads out of four slots, and
        // there is no instruction that moves four words: each limb is written
        // where the callee's own copy of it reads.
        this.wideLoad(held);
        for (let limb = 0; limb < this.limbsOf(held.type); limb += 1) {
          this.code.movMemRegSized(mem(RSP, (at + limb) * 8 - slots * 8), [8, 9, 10, 11][limb], 8);
        }
        continue;
      }
      this.load(held);
      const address = mem(RSP, at * 8 - slots * 8);
      if (isFloatType(fieldOf(held, "type") as SemanticType)) {
        this.code.movsStore(address, XMM0, widthOf(fieldOf(held, "type") as SemanticType) === 4);
        continue;
      }
      this.code.movMemReg(address, RAX);
    }
    // The moves that fill the argument registers, each with the register its
    // value is read out of: the one the build pinned it in, the accumulator a
    // call before this one left it in, or null where it is read out of the
    // frame. An argument already read into its own register is not a move at
    // all, which is the store and the load the caller avoided by not writing
    // the value down in the first place.
    type Move = { register: number; held: Held; source: number | null };
    const moves: Move[] = [];
    for (const entry of registers) {
      const register = fieldOf(entry, "register") as number;
      const held = fieldOf(entry, "held") as Held;
      const at = fieldOf(entry, "at") as number;
      if (at === placed) continue;
      // An argument the caller left where it is was never written down, so it is
      // in the accumulator and nowhere else. The slot it is named by may still
      // carry a register of its own — a function whose arithmetic is inside a loop
      // has spare vector registers to lend, and the slot was given one — and that
      // register holds whatever the last thing to use it left there, because
      // nothing ever wrote the argument into it. So the accumulator is asked
      // about before the register is: a call whose argument is an element of an
      // array answered the register instead of the element it read.
      const source =
        at === fresh && onStack.length === 0
          ? isFloatType(fieldOf(held, "type") as SemanticType)
            ? XMM0
            : RAX
          : String(fieldOf(held, "register")) !== "null"
            ? fieldOf(held, "register") as number
            : null;
      if (source === register) continue;
      moves.push({ register, held, source });
    }
    // How many of the moves left read each register, which is what says a
    // register cannot be written yet: one is being read by one of them.
    const reading = new Map<number, number>();
    for (const move of moves) {
      const moveSource = fieldOf(move, "source") as number | null;
      if (String(moveSource) === "null") continue;
      reading.set(moveSource as number, (reading.get(moveSource as number) ?? 0) + 1);
    }
    const done = (move: Move): void => {
      const moveSource = fieldOf(move, "source") as number | null;
      if (String(moveSource) === "null") return;
      const left = (reading.get(moveSource as number) ?? 1) - 1;
      if (left === 0) reading.delete(moveSource as number);
      else reading.set(moveSource as number, left);
    };
    const ordered: Move[] = [];
    while (moves.length > 0) {
      const at = moves.findIndex((move) => !reading.has(fieldOf(move, "register") as number));
      // Every register left is read by one of the moves left, which is a cycle
      // two or three of them go round. One value is written into the frame and
      // read back from there, which is a store and a load paid once to break
      // it; the frame is where every other value this call is passed is read
      // from anyway.
      if (at === -1) {
        const move = moves[0] as Move;
        const source = fieldOf(move, "source") as number;
        const moveHeld = fieldOf(move, "held") as Held;
        const moveType = fieldOf(moveHeld, "type") as SemanticType;
        const parked = this.holdSlot(moveType, "blaze_call_argument");
        if (isFloatType(moveType)) {
          this.code.movsStore(frame(fieldOf(parked, "offset") as number), source, widthOf(moveType) === 4);
        } else {
          this.code.movMemRegSized(frame(fieldOf(parked, "offset") as number), source, widthOf(moveType));
        }
        const replacement: Move = {
          register: fieldOf(move, "register") as number,
          held: parked,
          source: null,
        };
        moves[0] = replacement;
        done(replacement);
        continue;
      }
      const [move] = moves.splice(at, 1);
      done(move);
      ordered.push(move as Move);
    }
    for (const move of ordered) {
      const moveHeld = fieldOf(move, "held") as Held;
      const moveType = fieldOf(moveHeld, "type") as SemanticType;
      const moveRegister = fieldOf(move, "register") as number;
      const moveSource = fieldOf(move, "source") as number | null;
      if (String(moveSource) !== "null") {
        if (isFloatType(moveType)) this.code.movsMove(moveRegister, moveSource as number, widthOf(moveType) === 4);
        else this.code.movRegReg(moveRegister, moveSource as number);
        continue;
      }
      if (isFloatType(moveType)) {
        this.code.movsLoad(moveRegister, frame(fieldOf(moveHeld, "offset") as number), widthOf(moveType) === 4);
        continue;
      }
      this.code.movRegMemSized(
        moveRegister,
        frame(fieldOf(moveHeld, "offset") as number),
        widthOf(moveType),
        signedOf(moveType),
      );
    }
    // The stack a call pushes onto has to leave the stack sixteen byte aligned,
    // which is what every function the C library was compiled for assumes of the
    // call it is entered by, so the arguments written above are given the room
    // they are read from only here.
    if (slots > 0) this.code.aluImm("sub", RSP, slots * 8);
    this.code.call(symbol);
    if (slots > 0) this.code.aluImm("add", RSP, slots * 8);
    if (foreign) this.reloadVectorsAfterCall();
    if (returns.kind !== "void" && !isFloatType(returns) && !isWideType(returns)) this.normalize(returns);
  }

  /**
   * The HTTP calls a module function may make.
   *
   * The request and the response are the runtime's own, and a reference is a
   * pointer: it is handed over as it is. The text a call is given is a pointer
   * to the bytes, and the text a call hands back is borrowed from the request:
   * it is there for as long as the request is being served.
   *
   * Every argument is written down before the call is made, because a value
   * that is read may be a call of its own, and a call takes the registers the
   * arguments of this one are waiting in.
   */
  private httpBuiltin(call: SemanticCall): boolean {
    const callee = String(fieldOf(call, "callee"));
    const callArgs = fieldOf(call, "args") as readonly SemanticValue[];
    switch (callee) {
      case "http.requestPath":
      case "http.requestMethod":
      case "http.requestHeader":
      case "http.requestBody":
      case "http.responseStatus":
      case "http.responseHeader":
      case "http.responseBody":
      case "http.responseEnd":
        break;
      default:
        return false;
    }
    const handle = this.httpArgument(call, 0, ANY_TYPE);
    switch (callee) {
      case "http.requestPath":
        this.callSymbol("blaze_http_req_path", [handle], TEXT);
        return true;
      case "http.requestMethod":
        this.callSymbol("blaze_http_req_method", [handle], TEXT);
        return true;
      case "http.requestHeader": {
        const name = this.httpArgument(call, 1, TEXT);
        this.callSymbol("blaze_http_req_header", [handle, name], TEXT);
        return true;
      }
      case "http.requestBody": {
        /* The length of the body is not asked for: the body is a text, and a
           text is what a reader reads it as. */
        const length = this.holdSlot(POINTER, "blaze_http_length");
        this.code.movRegImm(RAX, 0n);
        this.store(length);
        this.callSymbol("blaze_http_req_body", [handle, length], TEXT);
        return true;
      }
      case "http.responseStatus": {
        const status = this.httpArgument(call, 1, USIZE);
        this.callSymbol("blaze_http_resp_status", [handle, status], VOID_TYPE);
        return true;
      }
      case "http.responseHeader": {
        const name = this.httpArgument(call, 1, TEXT);
        const value = this.httpArgument(call, 2, TEXT);
        this.callSymbol("blaze_http_resp_header", [handle, name, value], VOID_TYPE);
        return true;
      }
      case "http.responseBody": {
        const body = this.httpArgument(call, 1, TEXT);
        const length = this.httpLength(body);
        this.callSymbol("blaze_http_resp_body", [handle, body, length], VOID_TYPE);
        return true;
      }
      case "http.responseEnd": {
        if (callArgs.length < 2) {
          this.callSymbol("blaze_http_resp_complete", [handle], VOID_TYPE);
          return true;
        }
        const body = this.httpArgument(call, 1, TEXT);
        const length = this.httpLength(body);
        this.callSymbol("blaze_http_resp_body", [handle, body, length], VOID_TYPE);
        this.callSymbol("blaze_http_resp_complete", [handle], VOID_TYPE);
        return true;
      }
    }
    return false;
  }

  /** One argument of an HTTP call, written down before the call is made. */
  private httpArgument(call: SemanticCall, at: number, type: SemanticType): Held {
    const callArgs = fieldOf(call, "args") as readonly SemanticValue[];
    this.at(callArgs[at], type);
    const held = this.hold(type, "blaze_http_argument");
    this.store(held);
    return held;
  }

  /** The length of a text, as the runtime measures it. */
  private httpLength(body: Held): Held {
    this.load(body);
    this.code.movRegReg(RDI, RAX);
    this.runtime("_text_length");
    const length = this.holdSlot(POINTER, "blaze_http_length");
    this.store(length);
    return length;
  }

  /** A call the body makes for what it does, with nothing of its own to pass. */
  /**
   * A value as the number the runtime carries a dynamic value in.
   *
   * The runtime holds a dynamic value as a handle, which is a double: a number
   * is itself, a text is the handle the runtime makes of it, and a value the
   * runtime already holds is the handle it is. This backend keeps a handle as
   * the bits of the double in a whole-number register, which is what the move
   * into a vector register turns back into the number.
   */
  private dynamicArgument(value: SemanticValue): Held {
    if (isTextType(value.type) || value.k === "text") {
      this.at(value, TEXT);
      this.code.movRegReg(RDI, RAX);
      this.runtime("_box_string");
      const boxed = this.hold(NUMBER, "blaze_boxed");
      this.store(boxed);
      return boxed;
    }
    if (isDynamicType(value.type)) {
      this.value(value);
      this.code.movdXmm(XMM0, RAX);
      const handle = this.hold(NUMBER, "blaze_handle");
      this.store(handle);
      return handle;
    }
    // A number is not a handle: a small one is the index of a value the
    // runtime registered, so it is boxed into a handle of its own first.
    this.at(value, NUMBER);
    this.external("blaze_rt_box_number");
    this.callForeign("blaze_rt_box_number");
    const number = this.hold(NUMBER, "blaze_number");
    this.store(number);
    return number;
  }

  /**
   * The handle the runtime just answered, held the way this backend holds one.
   *
   * A service answers a dynamic value as the double a handle is, in the vector
   * register the convention returns a float in. A handle this backend keeps is
   * the bits of that double in the accumulator, so the eight bytes the answer
   * is are written down and read back into it.
   */
  private dynamicResult(): void {
    const answer = this.hold(NUMBER, "blaze_dynamic");
    this.store(answer);
    this.code.movRegMem(RAX, frame(answer.offset));
  }

  private runtime(entry: string): void {
    this.library(`${RUNTIME_NAME}${entry}`);
  }

  private library(symbol: string): void {
    this.callForeign(symbol);
  }

  /**
   * A call into code this backend did not build, with the vector registers this
   * function keeps values in written down around it.
   *
   * A callee this backend builds spills every vector register it uses in its
   * prologue and reads them back in its epilogue, so a value kept in one of them
   * survives the call. Nothing else does. This target is System V AMD64, where
   * no vector register is preserved by a call: the C library and the runtime are
   * built for exactly that, and a value pinned in `xmm6` across one came back as
   * whatever `strstr` had left there. So the registers are written down here,
   * and read back on the far side.
   *
   * Writing them down is not free, and it is paid only where a call leaves this
   * object: a function that calls nothing out of it, and a function that keeps
   * nothing in a vector register, both write nothing here.
   */
  private callForeign(symbol: string): void {
    this.external(symbol);
    this.saveVectorsForCall();
    this.code.call(symbol);
    this.reloadVectorsAfterCall();
  }

  private saveVectorsForCall(): void {
    for (const saved of this.callSaves) {
      this.code.saveVector(
        fieldOf(saved, "register") as number,
        fieldOf(saved, "offset") as number,
        fieldOf(saved, "single") as boolean,
      );
    }
  }

  private reloadVectorsAfterCall(): void {
    for (const saved of this.callSaves) {
      this.code.movsLoad(
        fieldOf(saved, "register") as number,
        frame(fieldOf(saved, "offset") as number),
        fieldOf(saved, "single") as boolean,
      );
    }
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
    if (typeEquals(from, to)) return;
    // A value the runtime holds is a handle this backend carries in a whole
    // number register, and the number it says is the runtime's own reading of
    // it. Some of the values of that type this backend produces are pointers
    // the runtime answered rather than handles it made, so reading one as a
    // number is not a conversion the accumulator has: the C backend reads the
    // number the value says, and this one refuses.
    if (isDynamicType(from) && isNumber(to)) {
      throw machineError(
        `a value the runtime holds is read as a ${typeText(to)}, which this backend has no lowering for`,
        "the C backend reads the number the value says; write the program so the value is read where it is made, or build it with the C backend",
      );
    }
    // A dynamic value is a handle: the runtime's double. A text and a number
    // written where one is expected are boxed into handles, and a handle read
    // as a text is unboxed. Without the crossing the list a rest parameter
    // holds kept the pointer of a text in a slot whose reader asked the
    // runtime to unbox it, and the text read back was the number beside it.
    if (isDynamicType(to)) {
      if (isTextType(from)) {
        this.code.movRegReg(RDI, RAX);
        this.runtime("_box_string");
        // The slot is a frame slot: the handle arrives in a vector register
        // and this reads its bits out of the frame, which is one place the
        // eight bytes of a handle are.
        const boxed = this.holdSlot(NUMBER, "blaze_boxed");
        this.store(boxed);
        this.code.movRegMem(RAX, frame(boxed.offset));
        return;
      }
      // A list handed to a dynamic value is the dynamic array of its elements:
      // the block, the width of one element and what an element is, boxed one at
      // a time. Handing the pointer over as it stood left the callee reading a
      // pointer as the number a handle is.
      if (isSequence(from)) {
        const element = elementTypeOf(from);
        const kind = element !== null && isTextType(element) ? 1n : element !== null && isBoolean(element) ? 2n : 0n;
        const size = BigInt(element !== null && element.kind === "primitive" ? widthOf(element) : 8);
        this.code.movRegReg(RDI, RAX);
        this.code.movRegImm(RSI, size);
        this.code.movRegImm(RDX, kind);
        this.external("blaze_rt_box_sequence");
        this.callForeign("blaze_rt_box_sequence");
        const boxed = this.holdSlot(NUMBER, "blaze_boxed");
        this.store(boxed);
        this.code.movRegMem(RAX, frame(boxed.offset));
        return;
      }
      if (isNumber(from)) {
        this.convert(from, NUMBER);
        this.external("blaze_rt_box_number");
        this.callForeign("blaze_rt_box_number");
        // The slot is a frame slot: the handle arrives in a vector register
        // and this reads its bits out of the frame, which is one place the
        // eight bytes of a handle are.
        const boxed = this.holdSlot(NUMBER, "blaze_boxed");
        this.store(boxed);
        this.code.movRegMem(RAX, frame(boxed.offset));
        return;
      }
    }
    if (isDynamicType(from) && isTextType(to)) {
      // The handle's bits are in the accumulator and the service reads the
      // double they are.
      this.code.movdXmm(XMM0, RAX);
      this.runtime("_to_text");
      return;
    }
    if (isTextType(from) || isTextType(to) || isReference(from) || isReference(to)) return;
    if (!isNumber(from) || !isNumber(to)) return;
    // Two wide types are the same four limbs, so one is the other as it is. A
    // wide type and a machine word are not: a limb is not the number, and the
    // three limbs above it are either the sign or nothing, which the widening
    // says and no conversion of the accumulator can.
    if (isWideType(from) && isWideType(to)) return;
    if (isWideType(from) || isWideType(to)) {
      throw machineError(
        `a ${typeText(from)} is converted to a ${typeText(to)}, which this backend has no single instruction for`,
        "a wide number is four limbs: a machine word is widened into one and a wide number is copied between slots, and neither is a conversion of the accumulator",
      );
    }
    if (isFloatType(from) && isFloatType(to)) {
      // The opcode's prefix names the precision the value is read at, so it is
      // the source's width and not the destination's.
      if (widthOf(from) !== widthOf(to)) this.code.cvtFloatPrecision(XMM0, XMM0, widthOf(from) === 4);
      return;
    }
    if (isFloatType(from)) {
      this.code.cvtFloatToInt(RAX, XMM0, widthOf(from) === 4, widthOf(to) === 8);
      this.normalizeArithmetic(to);
      return;
    }
    if (isFloatType(to)) {
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
   *
   * The register is cleared before the conversion writes into it. The
   * conversion writes the low half of the register and leaves the half above it
   * as it was, so it waits for whatever last wrote there — and in a loop that
   * is the arithmetic of the turn before, which writes zeros above the number
   * it works on. A loop that converts a counter on every turn therefore waits
   * for the whole arithmetic of the turn before it, and runs at a third of the
   * speed it could. Clearing the register first says the answer does not
   * depend on what was there, and `PXOR` is the instruction that says so: the
   * processor knows its answer is zero whatever the register held, so it does
   * not wait for the last write to it.
   */
  private wholeAsDouble(from: SemanticType, to: SemanticType): void {
    const single = widthOf(to) === 4;
    this.code.zeroFloat(XMM0);
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

/** The magnitude of a whole number. */
function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/** The value a whole number literal is. */
function integerText(text: string): bigint {  if (/^[+-]?0[xX]/.test(text)) {
    const negative = text.startsWith("-");
    const body = negative ? text.slice(1) : text;
    const clean = body.endsWith("n") ? body.slice(0, -1) : body;
    return (negative ? -1n : 1n) * BigInt(clean);
  }
  const clean = text.endsWith("n") ? text.slice(0, -1) : text;
  if (/^[+-]?[0-9]+$/.test(clean)) return BigInt(clean);
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

/**
 * The stack alignment a machine candidate has to keep.
 *
 * A candidate is linked against a runtime the C compiler built, and that
 * runtime assumes System V: rsp is 16-byte aligned at the point of a call, so
 * the frame below it lands on a 16-byte boundary and the callee is free to
 * store xmm registers with movaps. A candidate that moves rsp by a multiple of
 * 16 breaks that, because it arrives with rsp 8 past a boundary and hands the
 * callee a frame that is 8 out. The first aligned store in the runtime then
 * faults, and the delivered program dies before it prints anything. This is
 * read off the candidate here, where a rejection costs one generation, rather
 * than left to the run, where it costs the program.
 *
 * The check is a walk over the instructions carrying what is known of rsp as an
 * offset from a 16-byte boundary, null where something the walk cannot follow
 * moved it. It reports only an alignment it is sure of: a call reached with a
 * known offset that is not zero is rejected, and a call reached with an unknown
 * one is left alone, so a candidate the walk loses track of is never turned
 * away over this.
 */

import { readAssemblyLines } from "./asm-text.ts";

/** rsp at some point, as an offset from a 16-byte boundary, or null when unknown. */
type Alignment = number | null;

/**
 * The offset a function is entered at. The call that reached it pushed the
 * return address, so rsp is 8 past a boundary and a candidate that allocates a
 * multiple of 16 keeps it there.
 */
const ENTRY_ALIGNMENT = 8;

const ANY = 16;

/** The whole register set is 32 bytes, not the one cell a push moves. */
const WHOLE_SET = new Set(["pusha", "pushad", "pushal", "pushaw", "popa", "popad", "popal", "popaw"]);

/**
 * The mnemonics that move rsp by one cell. They are named one by one rather
 * than read off the opening of the mnemonic, because `popcnt` opens the same
 * way and is a register operation: read as a pop it moved rsp that no
 * instruction did, and a candidate that was aligned was turned away.
 */
const CELL_SET = new Set([
  "push",
  "pop",
  // AT&T writes the operand size into the mnemonic, so `pushq %rbp` is as
  // ordinary as `push %rbp` and both are the same instruction.
  "pushb",
  "pushw",
  "pushl",
  "pushq",
  "pushbq",
  "pushwq",
  "pushlq",
  "pushqq",
  "popb",
  "popw",
  "popl",
  "popq",
  "popbq",
  "popwq",
  "poplq",
  "popqq",
  "pushf",
  "pushfw",
  "pushfd",
  "pushfq",
  "popf",
  "popfw",
  "popfd",
  "popfq",
]);
/**
 * The registers an instruction moves rsp by writing to. A write to `esp` or
 * `sp` zero-extends into rsp, so `subl $8, %esp` moves it exactly as
 * `subq $8, %rsp` does. Reading the operand as `%rsp` only left such an
 * instruction looking like one that had not touched the stack at all, and a
 * call that was then made eight bytes out of line was passed.
 */
const STACK_REGISTERS: ReadonlySet<string> = new Set(["%rsp", "%esp", "%sp"]);

/**
 * Where a branch goes, as the line it names, or null when it names something
 * the walk cannot follow. A name is a label; the numeric local labels of GNU
 * as are numbered from the branch rather than from the file, so `1b` is the
 * nearest `1:` above it and `1f` the nearest below, and each is resolved
 * against the line the branch is on. A walk that cannot read `1b` stopped at
 * the first one, and every call after it went unchecked.
 */
function branchLine(
  operand: string | undefined,
  index: number,
  byLabel: Map<string, number[]>,
): number | null {
  if (operand === undefined) return null;
  const local = /^(\d+)([bf])$/.exec(operand);
  if (local !== null) {
    const at = byLabel.get(local[1]) ?? [];
    return local[2] === "b"
      ? (at.filter((line) => line < index).at(-1) ?? null)
      : (at.find((line) => line > index) ?? null);
  }
  if (!/^(?:[A-Za-z_.$][A-Za-z0-9_.$]*|\d+)$/.test(operand)) return null;
  return byLabel.get(operand)?.[0] ?? null;
}

/**
 * What a GNU as immediate is worth, or NaN when it is not a number this walk
 * can read.
 *
 * The assembler reads `$010` as octal 8, and `Number` reads it as decimal 10.
 * The walk has to model the instruction the assembler emits, not the one the
 * text looks like: reading the digits in base ten cleared a misalignment the
 * assembler creates (`addq $010, %rsp` at offset 6 walks to 0 and assembles to
 * 14), so a candidate that faults at the first aligned move inside what it
 * called was the one check in the build that said it was fine.
 */
function immediateValue(operand: string): number {
  const text = operand.startsWith("$") ? operand.slice(1) : operand;
  const sign = text.startsWith("-") ? -1 : text.startsWith("+") ? 1 : 0;
  const digits = sign === 0 ? text : text.slice(1);
  const magnitude = /^0[xX][0-9a-fA-F]+$/.test(digits)
    ? Number.parseInt(digits.slice(2), 16)
    : /^0[bB][01]+$/.test(digits)
      ? Number.parseInt(digits.slice(2), 2)
      : /^0[0-7]+$/.test(digits)
        ? Number.parseInt(digits.slice(1), 8)
        : /^[0-9]+$/.test(digits)
          ? Number.parseInt(digits, 10)
          : Number.NaN;
  return sign === 0 ? magnitude : sign * magnitude;
}

/** What an instruction leaves the offset at, given what it started at. */
function transfer(mnemonic: string, operands: string[], alignment: Alignment): Alignment {
  if (WHOLE_SET.has(mnemonic) || CELL_SET.has(mnemonic)) {
    // A push and a pop both move rsp by one cell, and one cell is half a
    // boundary, so either one leaves an aligned offset where it found a
    // misaligned one and the other way about. Pushing the whole register set
    // moves eight cells, which is a whole number of boundaries and so leaves
    // the offset where it was.
    const cell = WHOLE_SET.has(mnemonic) ? 32 : 8;
    return alignment === null ? null : (alignment + cell) % ANY;
  }
  // `leave` restores rsp from a frame the walk never read, and `enter` builds
  // one whose size is the immediate and whose nesting is the second one: both
  // leave an offset nobody here knows.
  if (mnemonic === "leave" || mnemonic === "enter") return null;
  const target = operands.at(-1);
  if (target === undefined || !STACK_REGISTERS.has(target)) return alignment;
  if (alignment === null) return null;

  const source = operands[0] ?? "";
  const value = immediateValue(operands[0] ?? "");
  if (mnemonic.startsWith("sub") || mnemonic.startsWith("add")) {
    if (!Number.isSafeInteger(value)) return null;
    return (((mnemonic.startsWith("sub") ? alignment - value : alignment + value) % ANY) + ANY) % ANY;
  }
  if (mnemonic.startsWith("and")) {
    // A realignment mask clears the low bits; one that leaves any of them set
    // puts the result where the unknown part of the value put them, so nothing
    // is learned from it.
    return Number.isSafeInteger(value) && (value & 0xf) === 0 ? 0 : null;
  }
  if (mnemonic.startsWith("xor")) return source === target ? 0 : null;
  // Anything else that writes the stack pointer builds it from a value the
  // walk did not read, so what it leaves is not something that can be said.
  return null;
}

/**
 * The lines where the candidate calls something with rsp off a 16-byte
 * boundary. Empty when every call it makes is aligned, or when the walk cannot
 * say.
 */
export function stackAlignmentProblems(assembly: string, entry: string): string[] {
  const lines = readAssemblyLines(assembly);
  const byLabel = new Map<string, number[]>();
  lines.forEach((line, index) => {
    if (line.label === null) return;
    const at = byLabel.get(line.label) ?? [];
    at.push(index);
    byLabel.set(line.label, at);
  });

  const start = byLabel.get(entry)?.[0];
  if (start === undefined) return [];

  // What the walk has worked out about where each line is reached: the
  // offsets it has seen there, and whether anything reached it that the walk
  // could not follow. Both only ever grow, so the walk settles, and a line is
  // queued at most once per offset it is reached at plus once for the unknown.
  const offsets = new Map<number, Set<number>>();
  const unreadable = new Set<number>();
  const work: { index: number; alignment: Alignment }[] = [];

  const reach = (index: number, alignment: Alignment): void => {
    if (index < 0 || index >= lines.length) return;
    if (alignment === null) {
      if (unreadable.has(index)) return;
      unreadable.add(index);
      work.push({ index, alignment });
      return;
    }
    const seen = offsets.get(index) ?? new Set<number>();
    if (seen.has(alignment)) return;
    seen.add(alignment);
    offsets.set(index, seen);
    work.push({ index, alignment });
  };

  reach(start, ENTRY_ALIGNMENT);
  while (work.length > 0) {
    const { index, alignment } = work.pop() as { index: number; alignment: Alignment };
    const line = lines[index];
    if (line.kind !== "instruction") {
      reach(index + 1, alignment);
      continue;
    }
    const { mnemonic, operands } = line;
    const next = transfer(mnemonic, operands, alignment);
    const target = branchLine(operands[0], index, byLabel);

    if (mnemonic.startsWith("call")) {
      // A call leaves the stack it was given, so what follows is where it was.
      reach(index + 1, next);
      continue;
    }
    if (mnemonic.startsWith("ret")) continue;
    if (mnemonic.startsWith("jmp")) {
      if (target !== null) reach(target, next);
      continue;
    }
    reach(index + 1, next);
    // Every other jump is conditional, so both ways out of the line are taken.
    if ((mnemonic.startsWith("j") || mnemonic.startsWith("loop")) && target !== null) {
      reach(target, next);
    }
  }

  // A line the walk could not follow is not a fault on its own: it is a call
  // whose offset is known and is not zero that is, and a line is reported for
  // the first such offset it is reached at, whichever way round they were
  // found.
  const problems: string[] = [];
  lines.forEach((line, index) => {
    if (line.kind !== "instruction" || !line.mnemonic.startsWith("call")) return;
    const wrong = [...(offsets.get(index) ?? [])].filter((offset) => offset !== 0).sort((a, b) => a - b);
    if (wrong.length === 0) return;
    problems.push(
      `line ${line.line}: "${line.mnemonic} ${line.operands.join(", ")}" is made with rsp ${wrong.join(" or ")} byte(s) off a 16-byte boundary, which faults the first aligned move in what it calls`,
    );
  });
  return problems;
}

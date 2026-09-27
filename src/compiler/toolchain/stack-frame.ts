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

/** The operand of a branch that names a label, or null when it names something else. */
function branchTarget(operand: string | undefined): string | null {
  if (operand === undefined) return null;
  return /^(?:[A-Za-z_.$][A-Za-z0-9_.$]*|\d+)$/.test(operand) ? operand : null;
}

/** What an instruction leaves the offset at, given what it started at. */
function transfer(mnemonic: string, operands: string[], alignment: Alignment): Alignment {
  if (mnemonic.startsWith("push") || mnemonic.startsWith("pop")) {
    // A push and a pop both move rsp by one cell, and one cell is half a
    // boundary, so either one leaves an aligned offset where it found a
    // misaligned one and the other way about.
    return alignment === null ? null : (alignment + 8) % ANY;
  }
  if (mnemonic === "leave") return null;
  if (operands.at(-1) !== "%rsp") return alignment;
  if (alignment === null) return null;

  const source = operands[0] ?? "";
  const value = source.startsWith("$") ? Number(source.slice(1)) : Number.NaN;
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
  if (mnemonic.startsWith("xor")) return source === "%rsp" ? 0 : null;
  return null;
}

/**
 * The lines where the candidate calls something with rsp off a 16-byte
 * boundary. Empty when every call it makes is aligned, or when the walk cannot
 * say.
 */
export function stackAlignmentProblems(assembly: string, entry: string): string[] {
  const lines = readAssemblyLines(assembly);
  const positions = new Map<string, number>();
  lines.forEach((line, index) => {
    if (line.label !== null && !positions.has(line.label)) positions.set(line.label, index);
  });

  const start = positions.get(entry);
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
    const target = branchTarget(operands[0]);

    if (mnemonic.startsWith("call")) {
      // A call leaves the stack it was given, so what follows is where it was.
      reach(index + 1, next);
      continue;
    }
    if (mnemonic.startsWith("ret")) continue;
    if (mnemonic.startsWith("jmp")) {
      if (target !== null && positions.has(target)) reach(positions.get(target) as number, next);
      continue;
    }
    reach(index + 1, next);
    // Every other jump is conditional, so both ways out of the line are taken.
    if ((mnemonic.startsWith("j") || mnemonic.startsWith("loop")) && target !== null && positions.has(target)) {
      reach(positions.get(target) as number, next);
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

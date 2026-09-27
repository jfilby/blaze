/**
 * Reading the text of an assembly candidate.
 *
 * Every rule the compiler holds a candidate to is read off its text, so the
 * text is reduced to one shape in a single place: comments taken off, the
 * label split from whatever instruction shares the line, and the operands
 * separated. What the callers do with the result differs; what a line is does
 * not.
 */

/** A line that only carries a label. */
export interface AssemblyLabel {
  readonly kind: "label";
  readonly line: number;
  readonly label: string;
}

/** A line that carries a directive, with or without a label in front of it. */
export interface AssemblyDirective {
  readonly kind: "directive";
  readonly line: number;
  readonly label: string | null;
  readonly name: string;
  readonly arguments: string;
}

/** A line that carries an instruction, with or without a label in front of it. */
export interface AssemblyInstruction {
  readonly kind: "instruction";
  readonly line: number;
  readonly label: string | null;
  readonly mnemonic: string;
  readonly operands: string[];
}

export type AssemblyLine = AssemblyLabel | AssemblyDirective | AssemblyInstruction;

/** A line with its comments removed and its surrounding space taken off. */
export function stripComments(line: string): string {
  let result = "";
  let index = 0;
  while (index < line.length) {
    if (line.startsWith("/*", index)) {
      const end = line.indexOf("*/", index + 2);
      index = end < 0 ? line.length : end + 2;
      result += " ";
      continue;
    }
    if (line[index] === "#" || line.startsWith("//", index)) break;
    result += line[index];
    index += 1;
  }
  return result;
}

/** Splits a candidate into one entry per line that carries a label, a directive or an instruction. */
export function readAssemblyLines(assembly: string): AssemblyLine[] {
  const lines: AssemblyLine[] = [];
  assembly.split(/\r?\n/).forEach((raw, offset) => {
    const lineNumber = offset + 1;
    let text = stripComments(raw).trim();
    if (text === "") return;

    // A label may share its line with the directive or instruction it introduces.
    let label: string | null = null;
    const match = /^([A-Za-z_.$][A-Za-z0-9_.$]*|\d+):\s*(.*)$/.exec(text);
    if (match !== null) {
      label = match[1];
      text = match[2].trim();
      if (text === "") {
        lines.push({ kind: "label", line: lineNumber, label });
        return;
      }
    }

    if (text.startsWith(".")) {
      const [name, ...rest] = text.split(/\s+/);
      lines.push({ kind: "directive", line: lineNumber, label, name, arguments: rest.join(" ") });
      return;
    }
    const [mnemonic, ...rest] = text.split(/\s+/);
    lines.push({
      kind: "instruction",
      line: lineNumber,
      label,
      mnemonic: mnemonic.toLowerCase(),
      operands: rest.flatMap((operand) => operand.split(",")).map((operand) => operand.trim()),
    });
  });
  return lines;
}

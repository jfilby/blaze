/**
 * The diagnostics a frontend gathers as it reads a file.
 *
 * A file is fixed in one pass, so a build says everything that is wrong with
 * it at once rather than one construct per run: the parser reads on past a
 * construct it cannot read, and every one of them is gathered here and
 * reported together.
 */

import { CompilerError } from "../core/errors.ts";

/** The error every refusal of a frontend is. */
export function frontendError(message: string, detail?: string): CompilerError {
  return new CompilerError({ category: "FrontendError", stage: "frontend", message, detail });
}

/** One construct the parser could not read, and where it was written. */
export interface Diagnostic {
  line: number;
  message: string;
  detail: string;
}

/** How many constructs one file may be reported to have before the list is cut. */
const MAXIMUM_DIAGNOSTICS = 24;

/**
 * The refusal of one file, from the constructs it earned and the whole number
 * it earned.
 *
 * A read that answers its refusals rather than throwing them still needs the
 * same error a build writes, so the message is built here once: the count is
 * the whole number, and the lines are the ones that survived the cut.
 */
export function refusalError(path: string, refused: readonly Diagnostic[], count: number): CompilerError {
  const found = refused.map((entry) => `  line ${entry.line}: ${entry.message}\n    ${entry.detail}`);
  if (count > refused.length) found.push(`  and ${count - refused.length} more`);
  return frontendError(
    `${count} construct${count === 1 ? "" : "s"} of ${path} ${count === 1 ? "is" : "are"} outside the subset the compiler reads`,
    found.join("\n"),
  );
}

/**
 * Every construct of one file that is outside the subset, gathered as the
 * parser reads on.
 */
export class Diagnostics {
  readonly entries: Diagnostic[] = [];
  private dropped = 0;

  report(message: string, detail: string, line: number): void {
    if (this.entries.length < MAXIMUM_DIAGNOSTICS) {
      this.entries.push({ line, message, detail });
      return;
    }
    this.dropped += 1;
  }

  /** How many constructs were refused, including the ones cut from the list. */
  get count(): number {
    return this.entries.length + this.dropped;
  }

  throwIfAny(path: string): void {
    if (this.entries.length === 0) return;
    throw refusalError(path, this.entries, this.count);
  }
}

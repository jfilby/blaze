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

  throwIfAny(path: string): void {
    if (this.entries.length === 0) return;
    const found = this.entries.map((entry) => `  line ${entry.line}: ${entry.message}\n    ${entry.detail}`);
    if (this.dropped > 0) found.push(`  and ${this.dropped} more`);
    throw frontendError(
      `${this.entries.length + this.dropped} construct${this.entries.length + this.dropped === 1 ? "" : "s"} of ${path} ${this.entries.length + this.dropped === 1 ? "is" : "are"} outside the subset the compiler reads`,
      found.join("\n"),
    );
  }
}

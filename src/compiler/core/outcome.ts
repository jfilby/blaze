/**
 * Explicit outcomes for the compiler's correctness-adjacent passes.
 *
 * A pass answers one of three things: it proved its claim (`passed`), it found
 * a definite contradiction (`failed`), or it could not answer because
 * something it needed was absent (`incomplete`). Those three are deliberately
 * different types. Collapsing the last two into a boolean is what lets a build
 * succeed on an arbitrary retry limit, or fail because two passes measured the
 * same program with different information.
 *
 * Diagnostics carry the pass that produced them and, when one was needed, the
 * assumption the pass relied on. A failure that cannot name its author is not
 * actionable; an "unknown" that does not say what was missing cannot be
 * distinguished from a contradiction.
 */

/** The three things a correctness-adjacent pass is allowed to answer. */
export type OutcomeStatus = "passed" | "failed" | "incomplete";

/** One reason a pass failed, with the provenance a build log needs. */
export interface Diagnostic {
  /** The pass that produced the diagnostic (for example `parallel`, `repair`). */
  readonly pass: string;
  /** What the pass found. */
  readonly message: string;
  /**
   * An assumption the pass relied on, when the verdict depends on one. A
   * profitability assumption is recorded here so a reader can tell it apart
   * from a proven semantic property.
   */
  readonly assumption?: string;
}

/** The shared result shape for optimization, validation, repair and verification. */
export type CompilerOutcome =
  | { readonly status: "passed" }
  | { readonly status: "failed"; readonly errors: readonly Diagnostic[] }
  | { readonly status: "incomplete"; readonly reason: string };

/** A value that was either measured or could not be measured. */
export type Assessment<T> =
  | { readonly status: "known"; readonly value: T }
  | { readonly status: "unknown"; readonly reason: string }
  | { readonly status: "incomplete"; readonly reason: string };

export function passed(): CompilerOutcome {
  return { status: "passed" };
}

export function failed(pass: string, ...messages: readonly string[]): CompilerOutcome {
  return { status: "failed", errors: messages.map((message) => ({ pass, message })) };
}

export function incomplete(reason: string): CompilerOutcome {
  return { status: "incomplete", reason };
}

/** Whether an outcome is a proof, as opposed to a contradiction or a gap. */
export function outcomePassed(outcome: CompilerOutcome): boolean {
  return outcome.status === "passed";
}

/**
 * The verdict a caller is allowed to treat as a definite rejection. An
 * `incomplete` answer is never a rejection: the pass simply did not have the
 * information to decide.
 */
export function outcomeFailed(outcome: CompilerOutcome): boolean {
  return outcome.status === "failed";
}

/**
 * Explicit error representation.
 *
 * Every failure carries the stage it happened in, the function it happened to,
 * the candidate it happened for and the complete diagnostic. The CLI prints a
 * short line; the JSON build record keeps the full diagnostic.
 */

export type ErrorCategory =
  | "InputError"
  | "FrontendError"
  | "ContractError"
  | "AiReviewError"
  /** A program that is not one, found before any target saw it. */
  | "SemanticIrError"
  | "AssemblyError"
  | "VerificationError"
  /** A build the user stopped before it started, so nothing is wrong. */
  | "CancelledError"
  | "BenchmarkError"
  | "LinkError"
  | "TargetError"
  | "StorageError";

/** The shape stored in JSON build records. */
export interface SerializedCompilerError {
  category: ErrorCategory;
  stage: string;
  message: string;
  function?: string;
  candidate?: string;
  detail?: string;
  project?: string;
}

export class CompilerError extends Error {
  readonly category: ErrorCategory;
  readonly stage: string;
  readonly functionName?: string;
  readonly candidate?: string;
  readonly detail?: string;
  readonly project?: string;

  constructor(
    category: ErrorCategory,
    stage: string,
    message: string,
    detail: string | undefined,
    functionName: string | undefined,
    candidate: string | undefined,
    project: string | undefined,
  ) {
    super(message);
    this.name = "CompilerError";
    this.category = category;
    this.stage = stage;
    this.functionName = functionName === "" ? undefined : functionName;
    this.candidate = candidate === "" ? undefined : candidate;
    this.detail = detail === "" ? undefined : detail;
    this.project = project === "" ? undefined : project;
  }

  toJSON(): SerializedCompilerError {
    return {
      category: this.category,
      stage: this.stage,
      message: this.message,
      function: this.functionName,
      candidate: this.candidate,
      detail: this.detail,
      project: this.project,
    };
  }
}

export function isCompilerError(value: unknown): value is CompilerError {
  return value instanceof CompilerError;
}

/** Wraps anything thrown into a CompilerError without losing the message. */
export function toCompilerError(
  value: unknown,
  category: ErrorCategory,
  stage: string,
  message: string,
  detail: string | undefined,
  functionName: string | undefined,
  candidate: string | undefined,
  project: string | undefined,
): CompilerError {
  if (isCompilerError(value)) return value;
  // The value is whatever was thrown: a text when the program wrote one, and
  // the text of the error otherwise. Its fields are not read, because an
  // unknown value has no layout the compiler can pick a field out of.
  const text = message === "" ? String(value) : message;
  const full = detail === "" ? "" : detail;
  return new CompilerError(category, stage, text, full, functionName, candidate, project);
}

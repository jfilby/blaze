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
  | "AiGenerationError"
  | "ModelDeclinedError"
  | "AssemblyError"
  | "VerificationError"
  | "BenchmarkError"
  | "LinkError"
  | "TargetError"
  | "StorageError";

export interface CompilerErrorInit {
  category: ErrorCategory;
  stage: string;
  message: string;
  function?: string;
  candidate?: string;
  detail?: string;
  /** Project the failure belongs to, once a build has started. */
  project?: string;
}

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

  constructor(init: CompilerErrorInit) {
    super(init.message);
    this.name = "CompilerError";
    this.category = init.category;
    this.stage = init.stage;
    this.functionName = init.function;
    this.candidate = init.candidate;
    this.detail = init.detail;
    this.project = init.project;
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
export function toCompilerError(value: unknown, init: Omit<CompilerErrorInit, "message"> & { message?: string }): CompilerError {
  if (isCompilerError(value)) return value;
  const message = init.message ?? (value instanceof Error ? value.message : String(value));
  const detail = init.detail ?? (value instanceof Error && value.stack ? value.stack : undefined);
  return new CompilerError({ ...init, message, detail });
}

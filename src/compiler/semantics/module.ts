/**
 * Module analysis: what one source file declares, imports and runs.
 *
 * A frontend parses a source file into this shape and nothing more. The
 * contract phase (see program.ts) then decides which declarations become
 * contracts, resolves the imports between files and validates the result. The
 * two steps are separate so that a file is parsed once, however many contracts
 * are derived from it.
 *
 * A frontend's own parse of a declaration travels in `handle` and comes back
 * unchanged in `contractFor`, so the phase never has to know a frontend's
 * internal representation.
 */

import type { FunctionContract, SourceInput, TypeExpr } from "../core/types.ts";

/**
 * One import as the source wrote it. `names` is the list of symbols it binds,
 * or null for a language that brings every export into scope unqualified.
 */
export interface ModuleImport {
  specifier: string;
  names: string[] | null;
  line: number;
}

/** A function the file declares, exported or not. */
export interface DeclaredFunction {
  name: string;
  exported: boolean;
  params: { name: string; type: TypeExpr }[];
  returns: TypeExpr;
  /** The frontend's own parse of this declaration, opaque to the phase. */
  handle: unknown;
}

/* -------------------------------------------------------------------------- */
/* Program body                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A value a running program names. A program is not contracted: it is the
 * statements of the entry module, in the order they run, and every function
 * it calls is contracted and compiled like any other. What a contract cannot
 * state is therefore the driver's work, which is why these are statements and
 * expressions of the source language rather than anything about a machine.
 */
export type ProgramValue =
  /** A number, exactly as the source wrote it. */
  | { k: "number"; text: string }
  /** A whole number too large for a double, as `1n` is written. */
  | { k: "bigint"; text: string }
  | { k: "boolean"; value: boolean }
  | { k: "null" }
  /** A string, with the values a template string interpolates. */
  | { k: "text"; parts: ProgramText[] }
  /** A buffer written out element by element, as a typed array literal is. */
  | { k: "buffer"; values: ProgramValue[] }
  | { k: "name"; name: string }
  /** `name.length`, of a buffer or of a string. */
  | { k: "length"; of: string }
  | { k: "element"; buffer: string; index: ProgramValue }
  | { k: "call"; function: string; args: ProgramValue[] }
  | { k: "binary"; op: ProgramBinaryOp; left: ProgramValue; right: ProgramValue }
  | { k: "unary"; op: ProgramUnaryOp; operand: ProgramValue }
  | { k: "conditional"; condition: ProgramValue; then: ProgramValue; otherwise: ProgramValue };

/** The operators a program value may use, as the source language writes them. */
export type ProgramBinaryOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "**"
  | "<<"
  | ">>"
  | "&"
  | "|"
  | "^"
  | "<"
  | "<="
  | ">"
  | ">="
  | "==="
  | "!=="
  | "=="
  | "!="
  | "&&"
  | "||"
  | "??";

export type ProgramUnaryOp = "-" | "+" | "!" | "~";

/** What an assignment does to what it is written on. */
export type ProgramAssignOp = "=" | "+=" | "-=" | "*=" | "/=" | "%=";

/** One piece of a string: text as written, or a value interpolated into it. */
export type ProgramText = { k: "text"; value: string } | { k: "value"; value: ProgramValue };

/** A statement a program runs. */
export type ProgramStatement =
  | { kind: "declare"; name: string; mutable: boolean; type: string | null; value: ProgramValue; line: number }
  | { kind: "assign"; name: string; op: ProgramAssignOp; value: ProgramValue; line: number }
  | { kind: "elementAssign"; buffer: string; index: ProgramValue; op: ProgramAssignOp; value: ProgramValue; line: number }
  | { kind: "update"; name: string; op: "++" | "--"; prefix: boolean; line: number }
  | { kind: "print"; values: ProgramValue[]; line: number }
  | { kind: "if"; condition: ProgramValue; then: ProgramStatement[]; otherwise: ProgramStatement[]; line: number }
  | { kind: "while"; condition: ProgramValue; body: ProgramStatement[]; line: number }
  | { kind: "doWhile"; condition: ProgramValue; body: ProgramStatement[]; line: number }
  | {
      kind: "for";
      variable: string;
      from: ProgramValue;
      to: ProgramValue;
      inclusive: boolean;
      down: boolean;
      type: string | null;
      /** How the index moves, or null for one step the way it travels. */
      step: ProgramValue | null;
      body: ProgramStatement[];
      line: number;
    }
  | { kind: "forOf"; variable: string; of: string; body: ProgramStatement[]; line: number }
  | { kind: "break"; line: number }
  | { kind: "continue"; line: number }
  | { kind: "block"; body: ProgramStatement[]; line: number }
  /** A call kept for what it does, as in `main();`. */
  | { kind: "invoke"; function: string; args: ProgramValue[]; line: number };

/** The statements of a module that run, with the file they were written in. */
export interface ProgramBody {
  file: string;
  statements: ProgramStatement[];
}

/** Everything one source file says about itself. */
export interface ModuleAnalysis {
  /** Project-relative path, so a diagnostic can name the file it came from. */
  path: string;
  imports: ModuleImport[];
  functions: DeclaredFunction[];
  /**
   * The statements the file runs, in order. Only the entry module of a program
   * may have them: a file the program merely imports is a library of
   * functions, and code in it would never run.
   */
  body: ProgramStatement[];
}

export interface Frontend {
  /**
   * Parses a module. It never contracts anything: a file is parsed once, and
   * the phase asks for a contract per exported function.
   */
  analyze(source: string, path: string): ModuleAnalysis;

  /**
   * Contracts one declared function. The contract describes the semantics the
   * function must satisfy, and names no target.
   */
  contractFor(analysis: ModuleAnalysis, declared: DeclaredFunction, input: SourceInput): FunctionContract;

  /**
   * The file names an import specifier may name, relative to the importing
   * file. Resolution is a language question, so the frontend answers it; the
   * phase picks the candidate that exists.
   */
  resolveImport(specifier: string): string[];
}

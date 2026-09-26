/**
 * Module analysis: what one source file declares and imports.
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

/** Everything one source file says about itself. */
export interface ModuleAnalysis {
  /** Project-relative path, so a diagnostic can name the file it came from. */
  path: string;
  imports: ModuleImport[];
  functions: DeclaredFunction[];
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

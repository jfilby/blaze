/**
 * Contracts programs the way a build does: through the contract phase, with
 * files handed over instead of read from disk. What the compiler runs and what
 * the tests exercise are then the same path.
 */

import { frontendFor } from "../semantics/frontend.ts";
import { entryContract, runContractPhase, type ContractPhase } from "../semantics/program.ts";
import type { FunctionContract, ProgramContract, SourceInput } from "../core/types.ts";

const ENTRY_PATH: Record<string, string> = { nim: "module.nim", typescript: "module.ts" };

/**
 * Contracts a program of named files and returns the whole phase, so a test
 * sees the statements of a program as well as its contracts.
 */
export function phaseOf(
  language: string,
  files: Record<string, string>,
  entryFile: string,
  overrides: Partial<SourceInput> = {},
): ContractPhase {
  const input: SourceInput = { language, source: files[entryFile], entry: "", ...overrides };
  return runContractPhase({
    frontend: frontendFor(language),
    input,
    entry: { path: entryFile, source: files[entryFile] },
    read: (path) => files[path] ?? null,
  });
}

/** Contracts a program of named files and returns the whole contract graph. */
export function programOf(
  language: string,
  files: Record<string, string>,
  entryFile: string,
  overrides: Partial<SourceInput> = {},
): ProgramContract {
  return phaseOf(language, files, entryFile, overrides).program;
}

/** Contracts a one file program and returns the contract of its entry function. */
export function contractOf(language: string, source: string, overrides: Partial<SourceInput> = {}): FunctionContract {
  const path = ENTRY_PATH[language];
  return entryContract(programOf(language, { [path]: source }, path, overrides));
}

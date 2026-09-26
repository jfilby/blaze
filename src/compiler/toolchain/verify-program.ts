/**
 * Checking a program.
 *
 * A function is checked against its contract, which is a mathematical
 * statement about what it must compute. A program has no such statement: it
 * is a sequence of statements whose only observable effect is what it prints.
 * So the build runs the source on its own toolchain, runs the delivered binary,
 * and compares the two: the program the compiler produced must say exactly what
 * the program in the repository says.
 *
 * The toolchain of a program is its language: a TypeScript program is checked
 * against `node`, which runs TypeScript directly.
 */

import { formatCommand, run } from "../core/process.ts";
import { CompilerError } from "../core/errors.ts";
import type { Runner } from "../core/types.ts";

/** The language a source is checked against. */
const TOOLCHAIN: Record<string, string> = { typescript: "node", ts: "node" };

/** One line of the first difference between two programs. */
export interface ProgramDifference {
  line: number;
  expected: string;
  actual: string;
}

export interface ProgramVerification {
  passed: boolean;
  /** What the source printed. */
  expected: string;
  /** What the delivered binary printed. */
  actual: string;
  difference?: ProgramDifference;
}

export interface ProgramVerificationRequest {
  language: string;
  /** The entry module, as the toolchain runs it. */
  sourcePath: string;
  /** Directory the source is run in, so its imports resolve. */
  directory: string;
  /** The delivered binary. */
  runner: Runner;
  /** The arguments the program is given, as they are given on the command line. */
  arguments?: readonly string[];
}

/** The first line where two outputs differ, or null when they are the same. */
function firstDifference(expected: string, actual: string): ProgramDifference | null {
  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  for (let index = 0; index < Math.max(expectedLines.length, actualLines.length); index += 1) {
    const left = expectedLines[index] ?? "";
    const right = actualLines[index] ?? "";
    if (left !== right) return { line: index + 1, expected: left, actual: right };
  }
  return null;
}

/**
 * Runs the source and the delivered binary, and compares what they print. The
 * source is the specification: a binary that says anything else is wrong, even
 * when every function in it satisfies its contract.
 */
export async function verifyProgram(request: ProgramVerificationRequest): Promise<ProgramVerification> {
  const toolchain = TOOLCHAIN[request.language.toLowerCase()];
  if (toolchain === undefined) {
    throw new CompilerError({
      category: "VerificationError",
      stage: "verify",
      message: `a program in ${request.language} cannot be checked`,
      detail: `checked against: ${Object.keys(TOOLCHAIN).join(", ")}; a program is checked against the toolchain that runs its source`,
    });
  }

  // A program reads the arguments it is given, so both runs get the same ones.
  const arguments_ = [...(request.arguments ?? [])];
  const source = run(toolchain, [request.sourcePath, ...arguments_], { cwd: request.directory, timeoutMs: 120_000 });
  if (source.spawnError !== undefined) {
    throw new CompilerError({
      category: "VerificationError",
      stage: "verify",
      message: `${toolchain} is not available, so the program cannot be checked`,
      detail: `${source.spawnError}\ninstall ${toolchain}, or build this project as a function entry`,
    });
  }
  if (source.code !== 0) {
    throw new CompilerError({
      category: "VerificationError",
      stage: "verify",
      message: "the program source does not run",
      detail: `${formatCommand(toolchain, [request.sourcePath, ...arguments_])}\n${source.stderr.trim()}`,
    });
  }

  const binary = run(request.runner.command, [...request.runner.args, ...arguments_], { cwd: request.directory, timeoutMs: 120_000 });
  if (binary.code !== 0) {
    throw new CompilerError({
      category: "VerificationError",
      stage: "verify",
      message: "the delivered program did not finish",
      detail: `${formatCommand(request.runner.command, [...request.runner.args, ...arguments_])}\n${binary.stderr.trim()}`,
    });
  }

  const difference = firstDifference(source.stdout, binary.stdout);
  return {
    passed: difference === null,
    expected: source.stdout,
    actual: binary.stdout,
    ...(difference === null ? {} : { difference }),
  };
}

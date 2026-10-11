/**
 * Where the things a run works on are.
 *
 * The optimizer is a package inside the blaze repository rather than a tool
 * that owns it, so nothing here owns a path either: every directory and file
 * a run touches is derived from the head of the repository the optimizer
 * itself lives in. The optimizer is `src/optimizer`, so the head is two
 * directories up — the same assumption every module used to make for itself
 * with a `join(import.meta.dirname, "..", "..")` of its own.
 *
 * The compiler is the package a run improves. The instruction file at the
 * head is what tells a coding agent how this repository works, and it is
 * here because it is the repository's and not the compiler's: a compiler
 * directory has no instructions of its own, so a run that started the agent
 * there would hand it nothing.
 */

import { join } from "node:path";

/** The base of the repository the optimizer works on: the head of it. */
export function repositoryRoot(): string {
  return join(import.meta.dirname, "..", "..");
}

/** The compiler package, which is what a run improves. */
export function compilerDirectory(root = repositoryRoot()): string {
  return join(root, "src", "compiler");
}

/** The name of the instruction file at the head of the repository. */
export const AGENTS_FILE = "AGENTS.md";

/**
 * The repository's own instruction file, which is what a coding agent reads.
 *
 * It is the file the repository carries for whoever works in it, and the
 * optimizer reads no more out of it than where it is: what it says is the
 * agent's to read, and copying it into the optimizer would be a second copy
 * of instructions that go out of date on their own.
 */
export function agentsFile(root = repositoryRoot()): string {
  return join(root, AGENTS_FILE);
}

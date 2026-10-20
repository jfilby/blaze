/**
 * The sections of the compiler test suite.
 *
 * A section is a slice of the suite that can run on its own, in its own
 * process, at the same time as any other section. A section is a whole test
 * file: every `test("name", ...)` in the file runs together, which keeps the
 * per-file module import down to one per section.
 *
 * Sections are discovered statically: the TypeScript compiler API reads each
 * test file's source and lists its `test("name", ...)` declarations, without
 * running any test body. The declaration count feeds the TAP plan.
 *
 * Note: splitting a file into per-test name sections was evaluated, but it
 * makes every section re-import the compiler (about 2.5s each), which
 * multiplies import cost across the suite and runs it slower overall on this
 * host. Whole-file sections with a bounded pool give the best wall time.
 */

import { readFile } from "node:fs/promises";
import {
  createSourceFile,
  ScriptTarget,
  ScriptKind,
  isCallExpression,
  isIdentifier,
  type Node,
} from "typescript";

/** A runnable slice of the suite — a whole test file. */
export type Section = {
  /** The test file the section runs. */
  readonly file: string;
  /** Always null: sections run whole files, not named subsets of them. */
  readonly pattern: null;
  /** How many tests the section runs (the TAP plan count). */
  readonly testCount: number;
  /** A human-readable name for the section, used in progress and diagnostics. */
  readonly name: string;
};

const SUITE_FILE_SUFFIX = ".test.ts";

/**
 * The `test(...)` declarations of one file's source, found statically with the
 * TypeScript compiler API. Every `test()` call is counted (the first argument
 * need not be a string literal), because node runs every declaration. No test
 * body is executed.
 */
function testCountOf(code: string): number {
  const source = createSourceFile(
    "suite.test.ts",
    code,
    ScriptTarget.Latest,
    true,
    ScriptKind.TS
  );
  let count = 0;

  function walk(node: Node): void {
    if (
      isCallExpression(node) &&
      isIdentifier(node.expression) &&
      node.expression.text === "test"
    ) {
      count++;
    }
    node.forEachChild((child) => walk(child));
  }

  walk(source);
  return count;
}

/**
 * Plan the suite's sections: one whole-file section per test file.
 *
 * Files that register any test under a non-literal name (template literals,
 * variables) still run whole — they were already whole-file sections, so no
 * special handling is needed beyond counting their declarations.
 */
export async function discoverSections(
  files: readonly string[]
): Promise<{ sections: Section[]; totalTests: number }> {
  const sections: Section[] = [];
  let totalTests = 0;

  for (const file of files) {
    const code = await readFile(file, "utf8");
    const count = testCountOf(code);

    sections.push({
      file,
      pattern: null,
      testCount: count,
      name: file,
    });
    totalTests += count;
  }

  return { sections, totalTests };
}

/** Whether a name refers to a suite file rather than a test inside one. */
export function isSuiteFileName(name: string): boolean {
  return name.endsWith(SUITE_FILE_SUFFIX);
}

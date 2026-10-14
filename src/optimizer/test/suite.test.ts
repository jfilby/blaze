/**
 * What the compiler's test suite says before a pass does anything.
 *
 * A pass is judged by the suite, so what it says first decides whether a
 * pass can be judged at all: a suite that already fails would have every
 * proposal reverted and blamed for a failure that was there before it. The
 * test script behind a scratch "compiler" is what says either, including
 * the shape of a suite that runs and reports failures and one that cannot
 * run at all.
 */

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { runTestSuite } from "../cli.ts";
import { scratch } from "./scratch.ts";

/**
 * A directory that answers `npm test` the way a script tells it to.
 *
 * The script is what a compiler's own suite does at the end of every run:
 * `node --test` prints the counts, and the exit status settles whether they
 * passed.
 */
async function fakeCompiler(script: string): Promise<string> {
  const dir = await scratch("blazeup-suite-");
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "fake", private: true, scripts: { test: script } }));
  return dir;
}

test("a suite that passes says so, and how many it passed", async () => {
  const dir = await fakeCompiler("node -e \"process.stdout.write('# pass 7\\n')\"");

  const result = runTestSuite(false, dir);

  assert.deepEqual(
    { completed: result.completed, passed: result.passed, passedCount: result.passedCount, failures: result.failures },
    { completed: true, passed: true, passedCount: 7, failures: 0 },
  );
});

test("a suite that runs and fails says how many failed", async () => {
  const dir = await fakeCompiler("node -e \"process.stdout.write('# pass 920\\n# fail 5\\n'); process.exit(1)\"");

  const result = runTestSuite(false, dir);

  assert.equal(result.completed, true);
  assert.equal(result.passed, false);
  assert.equal(result.failures, 5);
  assert.match(result.output, /# fail 5/);
});

test("a suite that cannot say anything still failed", async () => {
  // A suite that fails to load a file prints nothing the summary lines would
  // hold, and is a failure all the same.
  const dir = await fakeCompiler("node -e \"process.stderr.write('boom'); process.exit(1)\"");

  const result = runTestSuite(false, dir);

  assert.equal(result.completed, true);
  assert.equal(result.passed, false);
  assert.equal(result.failures, 0);
  assert.match(result.output, /boom/);
});

test("a suite with no test script says so, and did not pass", async () => {
  const dir = await scratch("blazeup-suite-");
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "fake", private: true }));

  const result = runTestSuite(false, dir);

  // There is nothing to run, which is a failed suite rather than a missing
  // process: npm says why, and the end of what it says is in the output.
  assert.equal(result.passed, false);
  assert.match(result.output, /Missing script|npm error/);
});

test("a session that forces colour does not carry it into the suite", async () => {
  // A run driven from a coloured terminal or an agent's own session inherits
  // FORCE_COLOR, which makes console.log write ANSI codes and a test that
  // compares a program's output byte for byte fail on them. The suite is run
  // colour-blind whatever the session that asked for it said.
  const dir = await fakeCompiler('node -e "process.stdout.write(process.env.NO_COLOR === \'1\' && process.env.FORCE_COLOR === undefined ? \'# pass 3\\n\' : \'# fail 1\\n\'); process.exit(process.env.NO_COLOR === \'1\' && process.env.FORCE_COLOR === undefined ? 0 : 1)"');

  const result = runTestSuite(false, dir);

  assert.equal(result.completed, true);
  assert.equal(result.passed, true);
});

/**
 * What the program round compares, and what it reports.
 *
 * A function is held to its contract; a program is held to what its own source
 * prints when it is run on its own toolchain. These tests are that comparison:
 * a program that prints something else, and a program that stopped before it
 * printed anything, are the two verdicts the round spends its repairs on, and
 * each is reported with the line it differs on and with what the program wrote
 * on its way down.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyProgram } from "../toolchain/verify-program.ts";

const SOURCE = [
  "function total(n: number): number {",
  "  let out = 0;",
  "  let i = 0;",
  "  while (i < n) { out += i; i += 1; }",
  "  return out;",
  "}",
  "console.log(total(4));",
  "",
].join("\n");

/** The source, written out where node can run it. */
async function source(): Promise<{ path: string; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "blaze-program-verify-"));
  const path = join(directory, "main.ts");
  await writeFile(path, SOURCE, "utf8");
  return { path, directory };
}

test("a program that prints what its source prints is the program the source is", async () => {
  const { path, directory } = await source();
  const checked = await verifyProgram({
    language: "typescript",
    sourcePath: path,
    directory,
    // The same program, run as node runs the source.
    runner: { command: "node", args: [path] },
  });

  assert.equal(checked.passed, true);
  assert.equal(checked.difference, undefined);
  assert.equal(checked.actual, "6\n");
});

test("a program that prints something else is reported with the line it differs on", async () => {
  const { path, directory } = await source();
  const checked = await verifyProgram({
    language: "typescript",
    sourcePath: path,
    directory,
    // A program that answers 4 where the source answers 6.
    runner: { command: "node", args: ["-e", "console.log(4)"] },
  });

  assert.equal(checked.passed, false);
  const difference = checked.difference;
  assert.ok(difference !== undefined, "the difference is reported");
  assert.equal(difference.line, 1);
  assert.equal(difference.expected, "6");
  assert.equal(difference.actual, "4");
  assert.equal(difference.expectedOutput, "6\n");
  assert.equal(difference.actualOutput, "4\n");
  assert.equal(difference.failure, undefined, "it printed something wrong rather than stopping");
});

test("a program that stops is reported with why it stopped", async () => {
  const { path, directory } = await source();
  const checked = await verifyProgram({
    language: "typescript",
    sourcePath: path,
    directory,
    // A program that raises before it prints the first line.
    runner: {
      command: "node",
      args: ["-e", "console.log('starting'); console.error('total is not implemented'); process.exit(2)"],
    },
  });

  assert.equal(checked.passed, false);
  const difference = checked.difference;
  assert.ok(difference !== undefined, "the stop is reported");
  assert.match(difference.failure ?? "", /exited with status 2/);
  assert.match(difference.failureOutput ?? "", /total is not implemented/, "what it wrote on the way down is kept");
  // It is reported against the first line of the source it never printed, so a
  // repair is shown where the program stopped rather than only how: it got
  // through the first line and stopped on the second.
  assert.equal(difference.line, 2);
  assert.equal(difference.expected, "", "there is nothing the source prints on the line it stopped on");
  assert.equal(difference.actualOutput, "starting");
});

test("a program in a language with no toolchain of its own cannot be checked", async () => {
  const { path, directory } = await source();
  await assert.rejects(
    () => verifyProgram({ language: "nim", sourcePath: path, directory, runner: { command: "true", args: [] } }),
    /a program in nim cannot be checked/,
  );
});

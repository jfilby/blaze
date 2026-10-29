/**
 * Runs that do not block: the same answers as a blocking run.
 *
 * A run the compiler waits on is one at a time by construction, so a set of
 * independent translation units could use exactly one core of the machine. These
 * are the answers the awaited form owes its callers, which are the ones the
 * blocking form already gives: the output, the status, a program that is not
 * there, and a deadline that stops the program rather than asking it to stop.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runAsync } from "../core/process.ts";

test("a run that finishes reports what it wrote and how it ended", async () => {
  const answer = await runAsync(process.execPath, ["-e", "process.stdout.write('out'); process.stderr.write('err')"], {
    timeoutMs: 60_000,
  });
  assert.equal(answer.code, 0);
  assert.equal(answer.signal, null);
  assert.equal(answer.stdout, "out");
  assert.equal(answer.stderr, "err");
  assert.equal(answer.timedOut, false);
  assert.equal(answer.spawnError, undefined);
});

test("a run that exits non zero reports the status rather than a failure to run", async () => {
  const answer = await runAsync(process.execPath, ["-e", "process.exit(3)"], { timeoutMs: 60_000 });
  assert.equal(answer.code, 3);
  assert.equal(answer.spawnError, undefined);
});

test("what the caller writes is what the run reads", async () => {
  // A run that is handed its input reads it from its standard input, which is
  // how the assembler is given a candidate.
  const answer = await runAsync(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], {
    input: "a line of input\n",
    timeoutMs: 60_000,
  });
  assert.equal(answer.code, 0);
  assert.equal(answer.stdout, "a line of input\n");
});

test("a program that is not there is reported as one that never ran", async () => {
  const answer = await runAsync("blaze-no-such-program", [], { timeoutMs: 60_000 });
  assert.equal(answer.code, null);
  assert.equal(answer.spawnError, "blaze-no-such-program");
});

test("a run past its deadline is stopped and reported as stopped", async () => {
  const answer = await runAsync(process.execPath, ["-e", "setTimeout(() => undefined, 30_000)"], {
    timeoutMs: 100,
  });
  assert.equal(answer.code, null, "a run that was stopped never exited on its own terms");
  assert.equal(answer.timedOut, true);
  assert.equal(answer.signal, "SIGKILL");
});

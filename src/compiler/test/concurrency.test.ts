/**
 * Bounded concurrency: what a build runs at once.
 *
 * The pool is what lets a set of independent translation units use more than one
 * core. What it owes the build is the other half of that: a bound the machine is
 * not asked to exceed, an answer in the order the work was given, and one report
 * of what went wrong when several things did.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mapConcurrent } from "../core/concurrency.ts";

/** A promise that resolves after `milliseconds`, without sleeping the process. */
function after(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test("the pool runs no more than the bound it was given", async () => {
  const items = Array.from({ length: 12 }, (_, index) => index);
  let running = 0;
  let most = 0;
  const results = await mapConcurrent(items, 3, async (item) => {
    running += 1;
    most = Math.max(most, running);
    await after(5);
    running -= 1;
    return item * 2;
  });

  assert.ok(most <= 3, `at most three ran at once, but ${most} did`);
  assert.ok(most > 1, "the pool did put more than one item in flight");
  assert.deepEqual(results, items.map((item) => item * 2));
});

test("the answers come back in the order the work was given, not the order it finished", async () => {
  // The first item is the slowest, so completing in order would be a different
  // answer from running in parallel and reporting what finished first.
  const delays = [30, 20, 10, 1];
  const results = await mapConcurrent(delays, 4, async (delay, index) => {
    await after(delay);
    return index;
  });
  assert.deepEqual(results, [0, 1, 2, 3]);
});

test("a bound wider than the work starts every item at once", async () => {
  let running = 0;
  let most = 0;
  await mapConcurrent([1, 2, 3], 64, async () => {
    running += 1;
    most = Math.max(most, running);
    await after(5);
    running -= 1;
  });
  assert.equal(most, 3);
});

test("an item that fails is reported by its place, and no new item starts after it", async () => {
  const started: number[] = [];
  const failure = await mapConcurrent(Array.from({ length: 8 }, (_, index) => index), 2, async (item) => {
    started.push(item);
    // The third item fails at once, and the items after it must not be started:
    // a set of sources that does not compile is not worth compiling the rest of.
    if (item === 2) throw new Error(`item ${item} failed`);
    await after(10);
    return item;
  }).then(
    () => undefined,
    (reason: unknown) => reason as Error,
  );

  assert.equal(failure?.message, "item 2 failed");
  assert.ok(!started.includes(3), `nothing after the failure started, but ${started.join(", ")} did`);
  assert.ok(started.includes(0) && started.includes(1), "the items already running were run to their end");
});

test("the earliest failure is the one reported, whatever order the failures happened in", async () => {
  // Item 1 fails after a short wait and item 0 after a long one, so the failure
  // that finished first is not the one the report is about.
  const failure = await mapConcurrent([0, 1], 2, async (item) => {
    await after(item === 0 ? 20 : 1);
    throw new Error(`item ${item}`);
  }).then(
    () => undefined,
    (reason: unknown) => reason as Error,
  );
  assert.equal(failure?.message, "item 0");
});

test("an empty set is no work and no answer", async () => {
  assert.deepEqual(await mapConcurrent([], 4, async () => 1), []);
});

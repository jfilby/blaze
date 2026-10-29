/**
 * Bounded concurrency.
 *
 * A build has work that is one item per thing rather than one thing: a set of
 * translation units that are compiled. The items are independent of each other,
 * so the machine's cores decide how long the set takes, and a loop that awaits
 * one item before starting the next spends all but one of them waiting.
 *
 * What the bound is for is the other way round: starting every item at once
 * starts as many compilers as there are sources, and each of them allocates a
 * few hundred megabytes of its own to do it. The pool is therefore bounded by
 * what the caller says the machine can run at once, and never by the number of
 * items.
 */

/**
 * Runs `work` over `items`, at most `limit` at a time, and answers the results
 * in the order the items were given.
 *
 * An item that fails stops the pool from starting new items, and the items
 * already running are waited for rather than abandoned — a compiler left
 * running is a file written after the report said what went wrong. What is
 * thrown is the failure of the earliest item that started and failed, so a set
 * of sources that fails the same way everywhere reports the same first error
 * from run to run; a source after that one which would also have failed is not
 * run at all, which is the whole point of stopping.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  // A failure is recorded with its place rather than on its own, so an item
  // that rejects with nothing at all is still a failure of that item.
  const failures: Array<{ reason: unknown } | undefined> = new Array<{ reason: unknown } | undefined>(items.length);
  const workers = Math.max(1, Math.min(Math.floor(limit), items.length));
  let next = 0;
  let stopped = false;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (stopped) return;
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        results[index] = await work(items[index] as T, index);
      } catch (reason) {
        failures[index] = { reason };
        stopped = true;
      }
    }
  };

  await Promise.all(Array.from({ length: workers }, () => worker()));

  // Every failure of an item that had already started is on record, and the
  // earliest one is what the caller is told: the same source is the same error.
  for (const failure of failures) {
    if (failure !== undefined) throw failure.reason;
  }
  return results;
}

/**
 * What the research cache keeps, and for how long.
 *
 * A paper is asked about once and not again, which is the whole point of the
 * cache — but the way it holds that has to survive the file being unreadable,
 * a timestamp that is not one, and the directory it lives in. And it has to
 * live somewhere the run can still work in: it was written beside the
 * compiler, where a run that reads the repository's state would find its own
 * cache in the way and refuse to run for the thing it wrote.
 */

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { addProcessed, isProcessed, loadCache, saveCache } from "../cache.ts";
import { scratch } from "./scratch.ts";

const DAY = 24 * 60 * 60 * 1000;

test("a paper asked about once is not asked about again", () => {
  const entries = addProcessed([], "https://example.com/paper", "A Paper");

  assert.equal(isProcessed(entries, "https://example.com/paper"), true);
  assert.equal(isProcessed(entries, "https://example.com/other"), false);
});

test("a paper older than the week is asked about again", () => {
  const entries = [{ url: "https://example.com/paper", title: "A Paper", processedAt: Date.now() - 8 * DAY }];

  assert.equal(isProcessed(entries, "https://example.com/paper"), false);
});

test("adding a paper drops the ones that have aged out", () => {
  const aged = { url: "https://example.com/old", title: "Old", processedAt: Date.now() - 8 * DAY };
  const fresh = addProcessed([aged], "https://example.com/new", "New");

  assert.deepEqual(
    fresh.map((e) => e.url),
    ["https://example.com/new"],
  );
});

test("what was saved is read back", async () => {
  const file = join(await scratch("blazeopt-cache-"), "cache.json");
  saveCache([{ url: "https://example.com/a", title: "A", processedAt: Date.now() }], file);

  assert.deepEqual(
    loadCache(file).map((e) => e.url),
    ["https://example.com/a"],
  );
});

test("a cache that cannot be read holds nothing rather than failing the run", async () => {
  const file = join(await scratch("blazeopt-cache-"), "cache.json");
  await writeFile(file, "{ not json at all");

  assert.deepEqual(loadCache(file), []);
});

test("an entry whose timestamp is not one is dropped: it could never be aged", async () => {
  const file = join(await scratch("blazeopt-cache-"), "cache.json");
  await writeFile(
    file,
    JSON.stringify({
      entries: [
        { url: "https://example.com/ok", title: "Ok", processedAt: Date.now() },
        { url: "https://example.com/bad", title: "Bad", processedAt: "yesterday" },
      ],
    }),
  );

  assert.deepEqual(
    loadCache(file).map((e) => e.url),
    ["https://example.com/ok"],
  );
});

test("the cache is not written beside the compiler any more", async () => {
  // The cache a run writes is in the user's cache directory, not inside the
  // repository a pass commits to.
  const file = join(await scratch("blazeopt-cache-"), "nested", "cache.json");
  saveCache([{ url: "https://example.com/a", title: "A", processedAt: Date.now() }], file);

  assert.deepEqual(
    loadCache(file).map((e) => e.url),
    ["https://example.com/a"],
  );
});

test("an unreadable legacy cache is read once, where the papers were", async () => {
  // The first version wrote the cache beside the compiler. A run that finds
  // nothing in the new place still reads that, so the papers it processed are
  // not asked about again.
  const dir = await scratch("blazeopt-cache-");
  const legacy = join(dir, "legacy.json");
  const fresh = join(dir, "fresh", "cache.json");
  await writeFile(
    legacy,
    JSON.stringify({ entries: [{ url: "https://example.com/a", title: "A", processedAt: Date.now() }] }),
  );

  assert.equal(isProcessed(loadCache(fresh, legacy), "https://example.com/a"), true);
});

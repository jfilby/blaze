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
import { addProcessed, isProcessed, loadCache, markUseful, saveCache, type CacheEntry } from "../cache.ts";
import { scratch } from "./scratch.ts";

const DAY = 24 * 60 * 60 * 1000;

/** A cache entry at a given age, with the fields the cache now keeps. */
function entry(url: string, ageMs: number, overrides: Partial<{ useful: boolean; readCount: number }> = {}): CacheEntry {
  return {
    url,
    title: "A Paper",
    processedAt: Date.now() - ageMs,
    useful: overrides.useful ?? false,
    readCount: overrides.readCount ?? 1,
  };
}

test("a paper asked about once is not asked about again", () => {
  const entries = addProcessed([], "https://example.com/paper", "A Paper");

  assert.equal(isProcessed(entries, "https://example.com/paper"), true);
  assert.equal(isProcessed(entries, "https://example.com/other"), false);
});

test("a paper older than the week is asked about again", () => {
  const entries = [entry("https://example.com/paper", 8 * DAY)];

  assert.equal(isProcessed(entries, "https://example.com/paper"), false);
});

test("adding a paper drops the ones that have aged out", () => {
  const aged = entry("https://example.com/old", 8 * DAY);
  const fresh = addProcessed([aged], "https://example.com/new", "New");

  assert.deepEqual(
    fresh.map((e) => e.url),
    ["https://example.com/new"],
  );
});

test("a paper that led to a commit is skipped for a month, not a week", () => {
  const entries = [entry("https://example.com/paper", 8 * DAY, { useful: true })];

  assert.equal(isProcessed(entries, "https://example.com/paper"), true);
});

test("a useful paper older than the month is asked about again", () => {
  const entries = [entry("https://example.com/paper", 31 * DAY, { useful: true })];

  assert.equal(isProcessed(entries, "https://example.com/paper"), false);
});

test("a paper read three times without a commit is skipped for a month", () => {
  const entries = [entry("https://example.com/paper", 8 * DAY, { readCount: 3 })];

  assert.equal(isProcessed(entries, "https://example.com/paper"), true);
});

test("a paper read twice without a commit is still asked about after a week", () => {
  const entries = [entry("https://example.com/paper", 8 * DAY, { readCount: 2 })];

  assert.equal(isProcessed(entries, "https://example.com/paper"), false);
});

test("reading a paper again increments its read count", () => {
  let entries = addProcessed([], "https://example.com/paper", "A Paper");
  entries = addProcessed(entries, "https://example.com/paper", "A Paper");
  entries = addProcessed(entries, "https://example.com/paper", "A Paper");

  assert.equal(entries[0]!.readCount, 3);
  assert.equal(isProcessed(entries, "https://example.com/paper"), true);
});

test("markUseful sets the useful flag", () => {
  const entries = [entry("https://example.com/paper", 0)];

  const marked = markUseful(entries, "https://example.com/paper");
  assert.equal(marked[0]!.useful, true);
  assert.equal(isProcessed(marked, "https://example.com/paper"), true);
});

test("markUseful leaves other papers alone", () => {
  const entries = [entry("https://example.com/a", 0), entry("https://example.com/b", 0)];

  const marked = markUseful(entries, "https://example.com/a");
  assert.equal(marked[0]!.useful, true);
  assert.equal(marked[1]!.useful, false);
});

test("what was saved is read back", async () => {
  const file = join(await scratch("blazeup-cache-"), "cache.json");
  saveCache([entry("https://example.com/a", 0)], file);

  assert.deepEqual(
    loadCache(file).map((e) => e.url),
    ["https://example.com/a"],
  );
});

test("a cache that cannot be read holds nothing rather than failing the run", async () => {
  const file = join(await scratch("blazeup-cache-"), "cache.json");
  await writeFile(file, "{ not json at all");

  assert.deepEqual(loadCache(file), []);
});

test("an entry whose timestamp is not one is dropped: it could never be aged", async () => {
  const file = join(await scratch("blazeup-cache-"), "cache.json");
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
  const file = join(await scratch("blazeup-cache-"), "nested", "cache.json");
  saveCache([entry("https://example.com/a", 0)], file);

  assert.deepEqual(
    loadCache(file).map((e) => e.url),
    ["https://example.com/a"],
  );
});

test("an unreadable legacy cache is read once, where the papers were", async () => {
  // The first version wrote the cache beside the compiler. A run that finds
  // nothing in the new place still reads that, so the papers it processed are
  // not asked about again.
  const dir = await scratch("blazeup-cache-");
  const legacy = join(dir, "legacy.json");
  const fresh = join(dir, "fresh", "cache.json");
  await writeFile(
    legacy,
    JSON.stringify({ entries: [{ url: "https://example.com/a", title: "A", processedAt: Date.now() }] }),
  );

  assert.equal(isProcessed(loadCache(fresh, legacy), "https://example.com/a"), true);
});

test("a cache file from before useful and readCount were tracked is read as not useful", async () => {
  // An old cache file has no useful or readCount fields. They default to
  // "not useful, read once", which is what an entry that was only tracked
  // by its timestamp was.
  const file = join(await scratch("blazeup-cache-"), "cache.json");
  await writeFile(
    file,
    JSON.stringify({
      entries: [{ url: "https://example.com/a", title: "A", processedAt: Date.now() }],
    }),
  );

  const entries = loadCache(file);
  assert.equal(entries[0]!.useful, false);
  assert.equal(entries[0]!.readCount, 1);
  assert.equal(isProcessed(entries, "https://example.com/a"), true);
});

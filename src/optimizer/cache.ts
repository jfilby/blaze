/**
 * Research result caching with weekly reset.
 *
 * The optimizer searches Tavily for compiler optimization papers and uses
 * them as context for AI-proposed improvements. To avoid re-asking about
 * the same paper, processed papers are cached with a timestamp. Entries
 * older than one week are ignored, so the cache resets weekly.
 *
 * The cache lives in the user's cache directory rather than beside the
 * compiler. The optimizer is a package inside the blaze repository, so a
 * file written there is an untracked file in somebody's repository — and a
 * run that reads the repository's state to keep its own changes apart from
 * the user's would find its own cache in the way and refuse to run. A cache
 * belongs outside the work it is about.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Where the cache lives: the user's cache directory, never the repository. */
const CACHE_FILE = join(
  process.env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache"),
  "blazeopt",
  "cache.json",
);

/** Where the first version of this module wrote it. */
const LEGACY_CACHE_FILE = join(import.meta.dirname, ".blazeopt-cache.json");

export interface CacheEntry {
  readonly url: string;
  readonly title: string;
  readonly processedAt: number;
}

interface CacheData {
  readonly entries: CacheEntry[];
}

export function loadCache(cacheFile = CACHE_FILE, legacyFile = LEGACY_CACHE_FILE): CacheEntry[] {
  // A cache written beside the compiler is read once, so that the papers a
  // previous run already processed are not asked about again after the
  // cache has moved. It is not written back there.
  if (!existsSync(cacheFile) && existsSync(legacyFile)) {
    return read(legacyFile);
  }
  return read(cacheFile);
}

function read(path: string): CacheEntry[] {
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, "utf8");
    const data = JSON.parse(raw) as CacheData;
    if (!Array.isArray(data.entries)) return [];
    // A timestamp this run cannot read is an entry this run cannot age, so
    // the entry is dropped rather than kept for ever.
    return data.entries.filter(
      (e): e is CacheEntry =>
        typeof e?.url === "string" && typeof e?.processedAt === "number" && Number.isFinite(e.processedAt),
    );
  } catch {
    return [];
  }
}

export function saveCache(entries: readonly CacheEntry[], cacheFile = CACHE_FILE): void {
  const data: CacheData = { entries: [...entries] };
  mkdirSync(dirname(cacheFile), { recursive: true });
  writeFileSync(cacheFile, JSON.stringify(data, null, 2));
}

/** Check if a paper was already processed (and is still within the weekly window). */
export function isProcessed(entries: readonly CacheEntry[], url: string): boolean {
  const now = Date.now();
  return entries.some((e) => e.url === url && now - e.processedAt < WEEK_MS);
}

/** Add a paper to the cache, evicting entries older than one week. */
export function addProcessed(entries: readonly CacheEntry[], url: string, title: string): CacheEntry[] {
  const now = Date.now();
  const fresh = entries.filter((e) => now - e.processedAt < WEEK_MS);
  return [...fresh, { url, title, processedAt: now }];
}

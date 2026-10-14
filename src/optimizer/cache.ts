/**
 * Research result caching with outcome-aware windows.
 *
 * The optimizer searches Tavily for compiler optimization papers and uses
 * them as context for AI-proposed improvements. To avoid re-asking about
 * the same paper too soon, processed papers are cached with a timestamp
 * and an outcome. The window depends on what happened:
 *
 * - A paper that led to a commit is skipped for 30 days: the working ideas
 *   are in the compiler, so re-reading has lower marginal value.
 * - A paper read EXHAUSTED_READS times without a commit is also skipped for
 *   30 days: it is unlikely to suddenly work.
 * - A paper read but not yet exhausted is skipped for 7 days: the agent is
 *   non-deterministic and the compiler changes, so a re-read might find
 *   something new.
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
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/** How many times a paper can be read without a commit before it is considered exhausted. */
const EXHAUSTED_READS = 3;

/** Where the cache lives: the user's cache directory, never the repository. */
const CACHE_FILE = join(
  process.env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache"),
  "blazeup",
  "cache.json",
);

/** Where the first version of this module wrote it. */
const LEGACY_CACHE_FILE = join(import.meta.dirname, ".blazeup-cache.json");

export interface CacheEntry {
  readonly url: string;
  readonly title: string;
  readonly processedAt: number;
  /** Whether a run that read this paper committed a change. */
  readonly useful: boolean;
  /** How many runs have read this paper. */
  readonly readCount: number;
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
    return data.entries
      .filter(
        (e): e is CacheEntry =>
          typeof e?.url === "string" && typeof e?.processedAt === "number" && Number.isFinite(e.processedAt),
      )
      // An old cache file may predate the useful and readCount fields: they
      // default to "not useful, read once", which is what an entry that was
      // only tracked by its timestamp was.
      .map((e) => ({
        url: e.url,
        title: e.title ?? "",
        processedAt: e.processedAt,
        useful: e.useful ?? false,
        readCount: e.readCount ?? 1,
      }));
  } catch {
    return [];
  }
}

export function saveCache(entries: readonly CacheEntry[], cacheFile = CACHE_FILE): void {
  const data: CacheData = { entries: [...entries] };
  mkdirSync(dirname(cacheFile), { recursive: true });
  writeFileSync(cacheFile, JSON.stringify(data, null, 2));
}

/** The window a paper is skipped for, given what happened when it was read. */
function windowFor(entry: CacheEntry): number {
  return entry.useful || entry.readCount >= EXHAUSTED_READS ? MONTH_MS : WEEK_MS;
}

/** Check if a paper was already processed (and is still within its window). */
export function isProcessed(entries: readonly CacheEntry[], url: string): boolean {
  const now = Date.now();
  const entry = entries.find((e) => e.url === url);
  if (entry === undefined) return false;
  return now - entry.processedAt < windowFor(entry);
}

/**
 * Add a paper to the cache, evicting entries older than their windows.
 *
 * A paper that already exists in the cache (even if older than its window)
 * is updated in place: its readCount is incremented and its timestamp
 * refreshed, so the history of how many times it has been read is kept.
 */
export function addProcessed(entries: readonly CacheEntry[], url: string, title: string): CacheEntry[] {
  const now = Date.now();
  const existing = entries.find((e) => e.url === url);

  // Evict entries that are older than their respective windows, except the
  // paper being updated, which is always kept.
  const fresh = entries.filter((e) => {
    if (e.url === url) return true;
    return now - e.processedAt < windowFor(e);
  });

  if (existing !== undefined) {
    return fresh.map((e) =>
      e.url === url ? { ...e, processedAt: now, readCount: e.readCount + 1 } : e,
    );
  }

  return [...fresh, { url, title, processedAt: now, useful: false, readCount: 1 }];
}

/**
 * Mark a paper as useful after a run commits.
 *
 * This is called after a run completes, so the cache knows which papers led
 * to changes that survived. A useful paper is skipped for a month.
 */
export function markUseful(entries: readonly CacheEntry[], url: string): CacheEntry[] {
  return entries.map((e) => (e.url === url ? { ...e, useful: true } : e));
}

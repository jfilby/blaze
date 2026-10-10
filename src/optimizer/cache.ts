/**
 * Research result caching with weekly reset.
 *
 * The optimizer searches Tavily for compiler optimization papers and uses
 * them as context for AI-proposed improvements. To avoid re-asking about
 * the same paper, processed papers are cached with a timestamp. Entries
 * older than one week are ignored, so the cache resets weekly.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CACHE_FILE = join(import.meta.dirname, ".blazeopt-cache.json");
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface CacheEntry {
  readonly url: string;
  readonly title: string;
  readonly processedAt: number;
}

interface CacheData {
  readonly entries: CacheEntry[];
}

export function loadCache(): CacheEntry[] {
  if (!existsSync(CACHE_FILE)) return [];
  try {
    const raw = readFileSync(CACHE_FILE, "utf8");
    const data = JSON.parse(raw) as CacheData;
    return data.entries ?? [];
  } catch {
    return [];
  }
}

export function saveCache(entries: readonly CacheEntry[]): void {
  const data: CacheData = { entries: [...entries] };
  writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
}

/** Check if a paper was already processed (and is still within the weekly window). */
export function isProcessed(entries: readonly CacheEntry[], url: string): boolean {
  const now = Date.now();
  return entries.some(
    (e) => e.url === url && now - e.processedAt < WEEK_MS,
  );
}

/** Add a paper to the cache, evicting entries older than one week. */
export function addProcessed(entries: readonly CacheEntry[], url: string, title: string): CacheEntry[] {
  const now = Date.now();
  const fresh = entries.filter((e) => now - e.processedAt < WEEK_MS);
  return [...fresh, { url, title, processedAt: now }];
}

/**
 * JSON filesystem storage.
 *
 * All filesystem access in the compiler goes through this abstraction. Paths
 * are relative to a single root and may not escape it. Writes are atomic so a
 * build record is never observed half written, and durable, so a record that
 * has been renamed into place is still there after the power goes out.
 *
 * A store is its root and nothing else: the operations are functions that take
 * the store, so a value laid out for the compiler carries no method to pick
 * apart when the same field name lives in more than one layout.
 */

import { createHash, readFile, mkdir, open, readdirEntries, rename, rm, isAbsolute, isFilePath, normalize, processId, relative, resolve, resolveFrom, sep, writeFile, dirname } from "./platform.ts";
import { CompilerError } from "./errors.ts";

export interface JsonStore {
  readonly root: string;
}

export function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function hashValue(value: unknown): string {
  return hashText(JSON.stringify(value));
}

/**
 * Distinguishes the temporary files of writes that overlap. It counts every
 * write in this process rather than every write of one store: two stores
 * under different roots each start a per store counter at zero, and the
 * second would then name its temporary file exactly as the first did.
 */
let temporaryWrites = 0;

/**
 * Puts a path on the disk rather than in the page cache. A write renamed into
 * place before its bytes are there leaves a name with nothing behind it, and
 * the next build reads that file, finds it is a record it cannot read, and
 * writes over the only copy of it.
 */
async function syncPath(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * A file and the directory entry it is reached by, both on the disk: one
 * without the other is a record pointing at nothing.
 */
export async function flushToDisk(path: string): Promise<void> {
  await syncPath(path);
  await syncPath(dirname(path));
}

export function createJsonStore(root: string): JsonStore {
  return { root: resolve(root) };
}

/** Absolute path for a store-relative path. Throws on escape attempts. */
export function storeResolve(store: JsonStore, relativePath: string): string {
  if (isAbsolute(relativePath)) {
    throw new CompilerError("StorageError", "storage", `store paths must be relative: ${relativePath}`, "", "", "", "");
  }
  const target = resolveFrom(store.root, normalize(relativePath));
  const rel = relative(store.root, target);
  if (rel.startsWith("..") || rel.split(sep).includes("..")) {
    throw new CompilerError("StorageError", "storage", `store path escapes root: ${relativePath}`, "", "", "", "");
  }
  return target;
}

export async function storeRead<T>(store: JsonStore, relativePath: string): Promise<T> {
  const file = storeResolve(store, relativePath);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (cause) {
    throw new CompilerError("StorageError", "storage", `cannot read ${relativePath}`, String(cause), "", "", "");
  }
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new CompilerError("StorageError", "storage", `${relativePath} is not valid JSON`, String(cause), "", "", "");
  }
}

export async function storeReadIfValid<T>(store: JsonStore, relativePath: string): Promise<T | undefined> {
  if (!(await storeExists(store, relativePath))) return undefined;
  // Only a file that is not JSON is no record at all. Every other read
  // failure — a record the process may not read, a disk that stopped
  // answering — is a fault, and it is raised rather than swallowed: the
  // record is there, and a caller told it is absent writes over the only
  // copy of it.
  const file = storeResolve(store, relativePath);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (cause) {
    throw new CompilerError("StorageError", "storage", `cannot read ${relativePath}`, String(cause), "", "", "");
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

export async function storeWrite<T>(store: JsonStore, relativePath: string, value: T): Promise<void> {
  const file = storeResolve(store, relativePath);
  await storeMkdirp(store, dirname(relative(store.root, file)));
  // A build writes from several places at once, and two writes to the same
  // path would otherwise share this name: one would rename the other's
  // temporary away and the loser would fail on a file that no longer
  // exists.
  const temporary = `${file}.${processId()}.${temporaryWrites++}.tmp`;
  try {
    await writeFile(temporary, serializeJson(value), "utf8");
    await syncPath(temporary);
    await rename(temporary, file);
    await syncPath(dirname(file));
  } catch (cause) {
    await rm(temporary, false, true);
    throw new CompilerError("StorageError", "storage", `cannot write ${relativePath}`, String(cause), "", "", "");
  }
}

export async function storeExists(store: JsonStore, relativePath: string): Promise<boolean> {
  // The escape guard is outside the try: a path that leaves the store is
  // an error, not the absence of a file, and swallowing it would report
  // an invalid path as "no previous build".
  const file = storeResolve(store, relativePath);
  return isFilePath(file);
}

export async function storeReadText(store: JsonStore, relativePath: string): Promise<string> {
  const file = storeResolve(store, relativePath);
  try {
    return await readFile(file, "utf8");
  } catch (cause) {
    throw new CompilerError("StorageError", "storage", `cannot read ${relativePath}`, String(cause), "", "", "");
  }
}

export async function storeWriteText(store: JsonStore, relativePath: string, contents: string): Promise<void> {
  const file = storeResolve(store, relativePath);
  await storeMkdirp(store, dirname(relative(store.root, file)));
  // A write in place is the half-written file this store promises never to
  // expose: a reader that arrives between the truncate and the last write
  // sees a file that is neither the old contents nor the new. It goes
  // through a temporary of its own, as `storeWrite` does, so a build record
  // is only ever observed whole.
  const temporary = `${file}.${processId()}.${temporaryWrites++}.tmp`;
  try {
    await writeFile(temporary, contents, "utf8");
    await syncPath(temporary);
    await rename(temporary, file);
    await syncPath(dirname(file));
  } catch (cause) {
    await rm(temporary, false, true);
    throw new CompilerError("StorageError", "storage", `cannot write ${relativePath}`, String(cause), "", "", "");
  }
}

export async function storeRemove(store: JsonStore, relativePath: string): Promise<void> {
  await rm(storeResolve(store, relativePath), true, true);
}

export async function storeMkdirp(store: JsonStore, relativePath: string): Promise<void> {
  try {
    await mkdir(storeResolve(store, relativePath), { recursive: true });
  } catch (cause) {
    throw new CompilerError("StorageError", "storage", `cannot create ${relativePath}`, String(cause), "", "", "");
  }
}

export async function storeList(store: JsonStore, relativePath: string): Promise<string[]> {
  try {
    return (await readdirEntries(storeResolve(store, relativePath))).map((entry) => entry.name);
  } catch (cause) {
    // A directory nobody created is a directory with nothing in it: the
    // caller is asking what projects exist, and one that does not is none.
    if (String(cause).includes("ENOENT")) return [];
    throw new CompilerError("StorageError", "storage", `cannot list ${relativePath}`, String(cause), "", "", "");
  }
}

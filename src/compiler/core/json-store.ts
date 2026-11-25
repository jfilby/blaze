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

import { createHash, appendFile, readFile, mkdir, readdirEntries, rename, rm, isAbsolute, isFilePath, normalize, processId, relative, resolve, resolveFrom, sep, syncFile, writeFile, dirname } from "./platform.ts";
import { CompilerError } from "./errors.ts";

export { hashValue } from "./structural-hash.ts";

function fieldOf(value: unknown, key: string): any {
  return (value as Record<string, unknown>)[key];
}

export interface JsonStore {
  readonly root: string;
}

export function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * The text `JSON.stringify(value, null, 2)` would write, in pieces.
 *
 * A build record can hold every candidate's full IR text. Writing it used to
 * build the whole pretty-printed string in one allocation before the file was
 * touched. Walking the value and yielding its parts lets the store flush a
 * record in bounded batches, so the peak cost is a batch rather than the whole
 * record. Scalars are formatted by JSON.stringify itself, which keeps the
 * escaping and the number rules identical to the one-string form.
 */
export function* jsonChunks(value: unknown): Generator<string> {
  yield* chunksOf(value, 0, new Set<object>());
}

function indent(level: number): string {
  return "  ".repeat(level);
}

function* chunksOf(value: unknown, level: number, active: Set<object>): Generator<string> {
  if (typeof value === "object" && value !== null) {
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") {
      yield* chunksOf(toJSON.call(value), level, active);
      return;
    }
  }
  if (value === null) {
    yield "null";
    return;
  }
  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean") {
    yield JSON.stringify(value);
    return;
  }
  if (type === "bigint") throw new TypeError("Do not know how to serialize a BigInt");
  if (type === "undefined" || type === "function" || type === "symbol") {
    // A member of this kind is left out of an object and written as null in an
    // array; the object writer below filters members, the array writer asks for
    // this value directly.
    yield "null";
    return;
  }

  const object = value as object;
  if (object instanceof String || object instanceof Number || object instanceof Boolean) {
    yield JSON.stringify(object.valueOf());
    return;
  }
  if (active.has(object)) throw new TypeError("Converting circular structure to JSON");
  active.add(object);
  try {
    if (Array.isArray(object)) {
      if (object.length === 0) {
        yield "[]";
        return;
      }
      yield "[\n";
      for (let index = 0; index < object.length; index += 1) {
        if (index > 0) yield ",\n";
        yield indent(level + 1);
        yield* chunksOf(index in object ? object[index] : null, level + 1, active);
      }
      yield "\n";
      yield indent(level);
      yield "]";
      return;
    }
    const members = Object.keys(object).filter((key) => {
      const member = (object as Record<string, unknown>)[key];
      return member !== undefined && typeof member !== "function" && typeof member !== "symbol";
    });
    if (members.length === 0) {
      yield "{}";
      return;
    }
    yield "{\n";
    for (let index = 0; index < members.length; index += 1) {
      if (index > 0) yield ",\n";
      yield indent(level + 1);
      yield JSON.stringify(members[index]);
      yield ": ";
      yield* chunksOf((object as Record<string, unknown>)[members[index]], level + 1, active);
    }
    yield "\n";
    yield indent(level);
    yield "}";
  } finally {
    active.delete(object);
  }
}

/** How much write text is gathered before it goes to the file. */
const WRITE_BATCH_BYTES = 64 * 1024;

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
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
  await syncFile(path);
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
  const root = String(fieldOf(store, "root"));
  const target = resolveFrom(root, normalize(relativePath));
  const rel = relative(root, target);
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
  await storeWriteChunks(store, relativePath, jsonChunks(value));
}

/**
 * Write a JSON document from chunks that may be produced asynchronously.
 *
 * A build of the compiler writes thousands of candidate records. Keeping every
 * record live until the final `storeWrite` exhausts the heap; an async producer
 * can read one spooled result at a time while this writes the document in
 * bounded batches, with the same temporary-file and atomic-rename guarantees
 * as every other store write.
 */
export async function storeWriteChunks(
  store: JsonStore,
  relativePath: string,
  chunks: Iterable<string> | AsyncIterable<string>,
): Promise<void> {
  const file = storeResolve(store, relativePath);
  await storeMkdirp(store, dirname(relative(String(fieldOf(store, "root")), file)));
  // A build writes from several places at once, and two writes to the same
  // path would otherwise share this name: one would rename the other's
  // temporary away and the loser would fail on a file that no longer exists.
  const temporary = `${file}.${processId()}.${temporaryWrites++}.tmp`;
  try {
    await writeFile(temporary, "", "utf8");
    let batch = "";
    for await (const chunk of chunks) {
      batch += chunk;
      if (batch.length >= WRITE_BATCH_BYTES) {
        await appendFile(temporary, batch, "utf8");
        batch = "";
      }
    }
    if (batch.length > 0) await appendFile(temporary, batch, "utf8");
    await appendFile(temporary, "\n", "utf8");
    await syncPath(temporary);
    await rename(temporary, file);
    await syncPath(dirname(file));
  } catch (cause) {
    await rm(temporary, false, true);
    throw new CompilerError("StorageError", "storage", `cannot write ${relativePath}`, String(cause), "", "", "");
  }
}

/**
 * Write a JSON object whose entry values are loaded one at a time.
 *
 * A build of the compiler has thousands of candidate records. Keeping every
 * value live until one final `storeWrite` exhausts the heap; a loader reads one
 * spooled result at a time while this writes the document in bounded batches.
 * `before` and `after` hold the fixed fields around the streamed entries, as
 * `generation.json` needs its model and total duration around `functions`.
 */
export async function storeWriteEntries(
  store: JsonStore,
  relativePath: string,
  entries: readonly (readonly [string, () => Promise<unknown>])[],
  before: Record<string, unknown> = {},
  after: Record<string, unknown> = {},
  entriesKey?: string,
): Promise<void> {
  const file = storeResolve(store, relativePath);
  await storeMkdirp(store, dirname(relative(String(fieldOf(store, "root")), file)));
  const temporary = `${file}.${processId()}.${temporaryWrites++}.tmp`;
  try {
    await writeFile(temporary, "", "utf8");
    let batch = "{\n";
    let first = true;
    const fixed = (fields: Record<string, unknown>): void => {
      for (const [key, value] of Object.entries(fields)) {
        if (!first) batch += ",\n";
        first = false;
        batch += `  ${JSON.stringify(key)}: `;
        for (const chunk of jsonChunks(value)) batch += chunk;
      }
    };
    fixed(before);
    const indent = entriesKey === undefined ? "  " : "    ";
    if (entriesKey !== undefined) {
      if (!first) batch += ",\n";
      first = false;
      batch += `  ${JSON.stringify(entriesKey)}: {\n`;
    }
    let entriesFirst = true;
    for (const [key, load] of entries) {
      if (!entriesFirst) batch += ",\n";
      entriesFirst = false;
      batch += `${indent}${JSON.stringify(key)}: `;
      for (const chunk of jsonChunks(await load())) batch += chunk;
      if (batch.length >= WRITE_BATCH_BYTES) {
        await appendFile(temporary, batch, "utf8");
        batch = "";
      }
    }
    if (entriesKey !== undefined) {
      batch += "\n  }";
      first = false;
    }
    fixed(after);
    batch += "\n}";
    await appendFile(temporary, batch, "utf8");
    await appendFile(temporary, "\n", "utf8");
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
  await storeMkdirp(store, dirname(relative(String(fieldOf(store, "root")), file)));
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
    const entries = await readdirEntries(storeResolve(store, relativePath));
    const names: string[] = [];
    for (const entry of entries) names.push(String(fieldOf(entry, "name")));
    return names;
  } catch (cause) {
    // A directory nobody created is a directory with nothing in it: the
    // caller is asking what projects exist, and one that does not is none.
    if (String(cause).includes("ENOENT")) return [];
    throw new CompilerError("StorageError", "storage", `cannot list ${relativePath}`, String(cause), "", "", "");
  }
}

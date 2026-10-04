/**
 * JSON filesystem storage.
 *
 * All filesystem access in the compiler goes through this abstraction. Paths
 * are relative to a single root and may not escape it. Writes are atomic so a
 * build record is never observed half written, and durable, so a record that
 * has been renamed into place is still there after the power goes out.
 */

import { createHash } from "node:crypto";
import { readFile, mkdir, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { CompilerError } from "./errors.ts";

export interface JsonStore {
  readonly root: string;
  /** Absolute path for a store-relative path. Throws on escape attempts. */
  resolve(relativePath: string): string;
  read<T>(relativePath: string): Promise<T>;
  write<T>(relativePath: string, value: T): Promise<void>;
  exists(relativePath: string): Promise<boolean>;
  readText(relativePath: string): Promise<string>;
  writeText(relativePath: string, contents: string): Promise<void>;
  remove(relativePath: string): Promise<void>;
  mkdirp(relativePath: string): Promise<void>;
  /**
   * The contents of a record that a build can do without: a missing file and
   * a file that is not JSON are both no record at all. It is for the records
   * a build regenerates when it cannot read them, never for one it has to be
   * able to read. A record that is present and cannot be read is a fault, and
   * is reported as one: no record at all would have the next write destroy it.
   */
  readIfValid<T>(relativePath: string): Promise<T | undefined>;
  /** The names of the entries directly inside a directory of the store. */
  list(relativePath: string): Promise<string[]>;
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
  const absoluteRoot = resolve(root);

  const resolveInStore = (relativePath: string): string => {
    if (isAbsolute(relativePath)) {
      throw new CompilerError({
        category: "StorageError",
        stage: "storage",
        message: `store paths must be relative: ${relativePath}`,
      });
    }
    const target = resolve(absoluteRoot, normalize(relativePath));
    const rel = relative(absoluteRoot, target);
    if (rel.startsWith("..") || rel.split(sep).includes("..")) {
      throw new CompilerError({
        category: "StorageError",
        stage: "storage",
        message: `store path escapes root: ${relativePath}`,
      });
    }
    return target;
  };

  const store: JsonStore = {
    root: absoluteRoot,
    resolve: resolveInStore,

    async read<T>(relativePath: string): Promise<T> {
      const file = resolveInStore(relativePath);
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch (cause) {
        throw new CompilerError({
          category: "StorageError",
          stage: "storage",
          message: `cannot read ${relativePath}`,
          detail: cause instanceof Error ? cause.message : String(cause),
        });
      }
      try {
        return JSON.parse(text) as T;
      } catch (cause) {
        throw new CompilerError({
          category: "StorageError",
          stage: "storage",
          message: `${relativePath} is not valid JSON`,
          detail: cause instanceof Error ? cause.message : String(cause),
        });
      }
    },

    async readIfValid<T>(relativePath: string): Promise<T | undefined> {
      if (!(await store.exists(relativePath))) return undefined;
      // Only a file that is not JSON is no record at all. Every other read
      // failure — a record the process may not read, a disk that stopped
      // answering — is a fault, and it is raised rather than swallowed: the
      // record is there, and a caller told it is absent writes over the only
      // copy of it.
      const file = resolveInStore(relativePath);
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch (cause) {
        throw new CompilerError({
          category: "StorageError",
          stage: "storage",
          message: `cannot read ${relativePath}`,
          detail: cause instanceof Error ? cause.message : String(cause),
        });
      }
      try {
        return JSON.parse(text) as T;
      } catch {
        return undefined;
      }
    },

    async write<T>(relativePath: string, value: T): Promise<void> {
      const file = resolveInStore(relativePath);
      await store.mkdirp(dirname(relative(absoluteRoot, file)));
      // A build writes from several places at once, and two writes to the same
      // path would otherwise share this name: one would rename the other's
      // temporary away and the loser would fail on a file that no longer
      // exists.
      const temporary = `${file}.${process.pid}.${temporaryWrites++}.tmp`;
      try {
        await writeFile(temporary, serializeJson(value), "utf8");
        await syncPath(temporary);
        await rename(temporary, file);
        await syncPath(dirname(file));
      } catch (cause) {
        await rm(temporary, { force: true });
        throw new CompilerError({
          category: "StorageError",
          stage: "storage",
          message: `cannot write ${relativePath}`,
          detail: cause instanceof Error ? cause.message : String(cause),
        });
      }
    },

    async exists(relativePath: string): Promise<boolean> {
      // The escape guard is outside the try: a path that leaves the store is
      // an error, not the absence of a file, and swallowing it would report
      // an invalid path as "no previous build".
      const file = resolveInStore(relativePath);
      try {
        const info = await stat(file);
        return info.isFile();
      } catch {
        return false;
      }
    },

    async readText(relativePath: string): Promise<string> {
      const file = resolveInStore(relativePath);
      try {
        return await readFile(file, "utf8");
      } catch (cause) {
        throw new CompilerError({
          category: "StorageError",
          stage: "storage",
          message: `cannot read ${relativePath}`,
          detail: cause instanceof Error ? cause.message : String(cause),
        });
      }
    },

    async writeText(relativePath: string, contents: string): Promise<void> {
      const file = resolveInStore(relativePath);
      await store.mkdirp(dirname(relative(absoluteRoot, file)));
      // A write in place is the half-written file this store promises never to
      // expose: a reader that arrives between the truncate and the last write
      // sees a file that is neither the old contents nor the new. It goes
      // through a temporary of its own, as `write` does, so a build record is
      // only ever observed whole.
      const temporary = `${file}.${process.pid}.${temporaryWrites++}.tmp`;
      try {
        await writeFile(temporary, contents, "utf8");
        await syncPath(temporary);
        await rename(temporary, file);
        await syncPath(dirname(file));
      } catch (cause) {
        await rm(temporary, { force: true });
        throw new CompilerError({
          category: "StorageError",
          stage: "storage",
          message: `cannot write ${relativePath}`,
          detail: cause instanceof Error ? cause.message : String(cause),
        });
      }
    },

    async remove(relativePath: string): Promise<void> {
      await rm(resolveInStore(relativePath), { force: true, recursive: true });
    },

    async mkdirp(relativePath: string): Promise<void> {
      try {
        await mkdir(resolveInStore(relativePath), { recursive: true });
      } catch (cause) {
        throw new CompilerError({
          category: "StorageError",
          stage: "storage",
          message: `cannot create ${relativePath}`,
          detail: cause instanceof Error ? cause.message : String(cause),
        });
      }
    },

    async list(relativePath: string): Promise<string[]> {
      try {
        return (await readdir(resolveInStore(relativePath), { withFileTypes: true })).map((entry) => entry.name);
      } catch (cause) {
        // A directory nobody created is a directory with nothing in it: the
        // caller is asking what projects exist, and one that does not is none.
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw new CompilerError({
          category: "StorageError",
          stage: "storage",
          message: `cannot list ${relativePath}`,
          detail: cause instanceof Error ? cause.message : String(cause),
        });
      }
    },
  };

  return store;
}


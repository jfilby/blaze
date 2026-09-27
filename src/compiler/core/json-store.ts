/**
 * JSON filesystem storage.
 *
 * All filesystem access in the compiler goes through this abstraction. Paths
 * are relative to a single root and may not escape it. Writes are atomic so a
 * build record is never observed half written.
 */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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

export function createJsonStore(root: string): JsonStore {
  const absoluteRoot = resolve(root);
  /** Distinguishes the temporary files of writes that overlap. */
  let written = 0;

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

    async write<T>(relativePath: string, value: T): Promise<void> {
      const file = resolveInStore(relativePath);
      await store.mkdirp(dirname(relative(absoluteRoot, file)));
      // A build writes from several places at once, and two writes to the same
      // path would otherwise share this name: one would rename the other's
      // temporary away and the loser would fail on a file that no longer
      // exists.
      const temporary = `${file}.${process.pid}.${written++}.tmp`;
      try {
        await writeFile(temporary, serializeJson(value), "utf8");
        await rename(temporary, file);
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
      try {
        const info = await stat(resolveInStore(relativePath));
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
      await writeFile(file, contents, "utf8");
    },

    async remove(relativePath: string): Promise<void> {
      await rm(resolveInStore(relativePath), { force: true, recursive: true });
    },

    async mkdirp(relativePath: string): Promise<void> {
      mkdirSync(resolveInStore(relativePath), { recursive: true });
    },
  };

  return store;
}


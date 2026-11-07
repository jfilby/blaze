/**
 * The Node implementation of the host services the compiler asks for.
 *
 * This is the only file in the compiler that names a Node module. Everything
 * else imports `core/platform.ts`, which is the same set of names over whatever
 * host the compiler is running on: the Node process that builds the compiler
 * today, and the native runtime that will run the compiler it builds.
 *
 * The functions are re-exported rather than wrapped so a call keeps the Node
 * signature it already had. A native implementation answers the same names with
 * the same arguments and the same result shape; what changes is the body behind
 * them, and that is the point of the boundary.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  open as nodeOpen,
  readFile,
  readdir as nodeReaddir,
  rename,
  rm,
  stat as nodeStat,
  writeFile,
} from "node:fs/promises";
import type { DirectoryEntry, FileInfo } from "./platform.ts";
import { createHash, randomUUID } from "node:crypto";
import {
  basename,
  dirname as nodeDirname,
  extname as nodeExtname,
  isAbsolute as nodeIsAbsolute,
  join,
  normalize as nodeNormalize,
  posix,
  relative as nodeRelative,
  resolve,
  sep,
} from "node:path";
import { availableParallelism, cpus, tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export {
  availableParallelism,
  appendFile,
  basename,
  copyFile,
  cpus,
  createHash,
  createInterface,
  existsSync,
  fileURLToPath,
  join,
  mkdir,
  mkdtemp,
  parseArgs,
  posix,
  randomUUID,
  readFile,
  readFileSync,
  nodeReaddir as readdir,
  rename,
  resolve,
  rm,
  sep,
  sleep,
  sleep as setTimeout,
  spawn,
  spawnSync,
  tmpdir,
  writeFile,
  writeFileSync,
};

/**
 * The entries of a directory, each with what it is.
 *
 * The host's own entry type answers the same questions, but it is the host's:
 * a compiler source is written against `DirectoryEntry`, so listing a
 * directory reads the same in a native adapter that never had a Node module to
 * import.
 */
export async function readdirEntries(path: string): Promise<DirectoryEntry[]> {
  return nodeReaddir(path, { withFileTypes: true });
}

/** What a file is: its size in bytes, and whether it is a file or a directory. */
export async function stat(path: string): Promise<FileInfo> {
  return nodeStat(path);
}

/**
 * A file the compiler opened, and the two things it does with it: writes it
 * through to the disk and closes it. The shape is the compiler's own, so a
 * native implementation answers the same two methods without carrying the
 * host's file handle.
 */
export interface FileHandle {
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** Opens a file as the handle above, whatever the host's own handle is. */
export async function open(path: string, mode: string): Promise<FileHandle> {
  return nodeOpen(path, mode) as unknown as Promise<FileHandle>;
}

/* -------------------------------------------------------------------------- */
/* Path work                                                                   */
/* -------------------------------------------------------------------------- */

/*
 * The path operations answer the texts they are given, and the compiler asks
 * them as its own functions rather than as the host's: a source that joins or
 * shortens a path reads the answer at `text`, which is what it is. `join` and
 * `resolve` take any number of parts and stay the host's, because a rest
 * parameter is a list a call is read against and none of these needs one.
 */

/** The directory part of a path. */
export function dirname(path: string): string {
  return nodeDirname(path);
}

/** The extension of a path, including the dot, or the empty text. */
export function extname(path: string): string {
  return nodeExtname(path);
}

/** Whether a path is absolute. */
export function isAbsolute(path: string): boolean {
  return nodeIsAbsolute(path);
}

/** A path with its empty and `.` parts taken out. */
export function normalize(path: string): string {
  return nodeNormalize(path);
}

/** The path that reaches `to` from `from`. */
export function relative(from: string, to: string): string {
  return nodeRelative(from, to);
}

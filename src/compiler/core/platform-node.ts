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
import type { BoundedCommand, DirectoryEntry, FileInfo, Host, HostSignal } from "./platform.ts";
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

/**
 * The directory a build reads its vendored sources from, `deps/facil.io` and
 * `deps/sqlite3`.
 *
 * A Node build keeps them at the repository root, three directories above this
 * file. A native install answers the same name with the directory beside its
 * binary, which is why the location is a host service rather than a path each
 * runtime computes from its own module URL.
 */
export function compilerDataRoot(): string {
  return resolve(nodeDirname(fileURLToPath(import.meta.url)), "../../..");
}

/**
 * The compiler's own source package, which is what its fingerprint walks.
 *
 * This Node build keeps the package at `src/compiler`; a native install
 * answers the same name with the installed source tree, or a tree embedded in
 * the binary. It is separate from the data root because the vendored sources
 * are read by a build, while the compiler sources are what says what that
 * build is.
 */
export function compilerSourceRoot(): string {
  return resolve(nodeDirname(fileURLToPath(import.meta.url)), "..");
}

/** The operating system this compiler is running on. */
export function hostPlatform(): string {
  return process.platform;
}

/** The architecture this compiler is running on. */
export function hostArchitecture(): string {
  return process.arch;
}

/**
 * The process id, which names the temporary files of one writer so a second
 * writer in the same directory cannot share them.
 */
export function processId(): number {
  return process.pid;
}

/**
 * A clock that only moves forward, in nanoseconds. A duration measured with
 * it is unaffected by a wall-clock adjustment, which is what a timeout and a
 * benchmark both need.
 */
export function monotonicTimeNs(): bigint {
  return process.hrtime.bigint();
}

/**
 * The variables the host process was given. A build reads `AI_MODEL` and the
 * provider credentials from here, and a child it starts is given the same
 * variables unless the caller names its own.
 */
export function hostEnvironment(): Readonly<Record<string, string | undefined>> {
  return process.env;
}

/** The line a bounded run writes when the program itself is not there. */
const MISSING_PROGRAM = "blaze: no such program: ";

/** The Node process, as the command line sees it. */
export const host: Host = {
  arguments: process.argv.slice(2),
  stdout: process.stdout,
  stderr: process.stderr,
  platform: process.platform,
  cwd: () => process.cwd(),
  setExitCode: (code: number): void => {
    process.exitCode = code;
  },
  ask: async (question: string): Promise<string | undefined> => {
    if (process.stdin.isTTY !== true) return undefined;
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await prompt.question(question);
    } finally {
      prompt.close();
    }
  },
  onExit: (handler: () => void): (() => void) => {
    process.once("exit", handler);
    return () => {
      process.off("exit", handler);
    };
  },
  onSignal: (signal: HostSignal, handler: () => void): (() => void) => {
    process.once(signal, handler);
    return () => {
      process.off(signal, handler);
    };
  },
  raiseSignal: (signal: HostSignal): void => {
    process.kill(process.pid, signal);
  },
  boundHeap: (command: string, args: readonly string[], bytes: number): BoundedCommand => {
    const kilobytes = Math.max(1, Math.floor(bytes / 1024));
    return {
      command: "/bin/sh",
      args: [
        "-c",
        [
          `ulimit -d ${kilobytes} 2>/dev/null || { echo "blaze: this shell cannot bound the memory of a program" >&2; exit 125; }`,
          `command -v "$0" >/dev/null 2>&1 || { echo "${MISSING_PROGRAM}$0" >&2; exit 127; }`,
          `exec "$0" "$@"`,
        ].join("\n"),
        command,
        ...args,
      ],
      missing: MISSING_PROGRAM,
    };
  },
};

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

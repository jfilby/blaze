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

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
import type { BoundedCommand, DirectoryEntry, FileInfo, HostChild, HostSignal, HostSpawnOptions, WebAssemblyEngine } from "./platform.ts";
import { createHash, randomUUID } from "node:crypto";
import {
  basename as nodeBasename,
  dirname as nodeDirname,
  extname as nodeExtname,
  isAbsolute as nodeIsAbsolute,
  join as nodeJoin,
  normalize as nodeNormalize,
  posix,
  relative as nodeRelative,
  resolve as nodeResolve,
  sep as nodeSep,
} from "node:path";
import { availableParallelism, cpus, tmpdir } from "node:os";
import { clearInterval as nodeClearInterval, clearTimeout, setInterval as nodeSetInterval } from "node:timers";
import { setTimeout as sleep } from "node:timers/promises";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { fileURLToPath } from "node:url";

export {
  availableParallelism,
  clearTimeout,
  appendFile,
  copyFile,
  cpus,
  createHash,
  existsSync,
  fileURLToPath,
  mkdir,
  mkdtemp,
  parseArgs,
  posix,
  randomUUID,
  readFile,
  readFileSync,
  nodeReaddir as readdir,
  rename,
  rm,
  sleep,
  sleep as setTimeout,
  spawn,
  spawnSync,
  tmpdir,
  writeFile,
  writeFileSync,
};

/** A timer that does not keep the process alive on its own. */
interface UnrefTimer {
  unref?: () => void;
}

/**
 * Runs the callback every interval, and answers the timer that stops it.
 *
 * The timer is unref'd: a title animation is cosmetic, and a command that has
 * finished its work must not wait for one.
 */
export function setInterval(tick: () => void, milliseconds: number): unknown {
  const timer: UnrefTimer = nodeSetInterval(tick, milliseconds) as unknown as UnrefTimer;
  timer.unref?.();
  return timer;
}

/** Stops the timer an interval call answered. */
export function clearInterval(timer: unknown): void {
  nodeClearInterval(timer as NodeJS.Timeout);
}

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
/** Whether a path names a directory. */
export function isDirectoryPath(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
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
 * shortens a path reads the answer at `text`, which is what it is. They are
 * wrapped rather than re-exported because a raw re-export carries no signature
 * for the compiler to read, so every call answer is a reference of no type.
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

/** The WebAssembly engine this process has, or null where it has none. */
export function webAssemblyEngine(): WebAssemblyEngine | null {
  const carrier = globalThis as { WebAssembly?: WebAssemblyEngine };
  return carrier.WebAssembly ?? null;
}

/** The line a bounded run writes when the program itself is not there. */
const MISSING_PROGRAM = "blaze: no such program: ";

/** The arguments the command was given, after the program and script names. */
export function hostArguments(): readonly string[] {
  return process.argv.slice(2);
}

/** Whether the output stream is a terminal, which a title may decorate. */
export function hostStdoutIsTTY(): boolean {
  return process.stdout.isTTY === true;
}

/** Writes to the output stream, as it is given. */
export function hostWriteOut(text: string): void {
  process.stdout.write(text);
}

/** Writes to the error stream, as it is given. */
export function hostWriteError(text: string): void {
  process.stderr.write(text);
}

/** The directory the process runs in. */
export function hostCwd(): string {
  return process.cwd();
}

/** Sets the status the process leaves with. */
export function hostSetExitCode(code: number): void {
  process.exitCode = code;
}

/** The answer to one question, or undefined when there is nobody to ask. */
export async function hostAsk(question: string): Promise<string | undefined> {
  if (process.stdin.isTTY !== true) return undefined;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await prompt.question(question);
  } finally {
    prompt.close();
  }
}

/** Calls the handler when the process exits; the answer detaches it. */
export function hostOnExit(handler: () => void): () => void {
  process.once("exit", handler);
  return () => {
    process.off("exit", handler);
  };
}

/** Calls the handler once for a signal; the answer detaches it. */
export function hostOnSignal(signal: HostSignal, handler: () => void): () => void {
  process.once(signal, handler);
  return () => {
    process.off(signal, handler);
  };
}

/** Raises a signal again once its handler has settled what it was doing. */
export function hostRaiseSignal(signal: HostSignal): void {
  process.kill(process.pid, signal);
}

/** Whether the host can start a child without blocking the process. */
export function hostSpawnSupport(): boolean {
  return true;
}

/** Starts a child the caller can wait on without blocking the process. */
export function hostSpawn(command: string, args: readonly string[], options: HostSpawnOptions): HostChild {
  return spawn(command, args, options as SpawnOptions) as unknown as HostChild;
}

/** The command that runs a program with a bounded heap. */
export function hostBoundHeap(command: string, args: readonly string[], bytes: number): BoundedCommand {
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
}

/** The last part of a path. */
export function basename(path: string): string {
  return nodeBasename(path);
}

/** The last part of a path, with the suffix taken off where it is there. */
export function basenameSuffix(path: string, suffix: string): string {
  return nodeBasename(path, suffix);
}

/**
 * The parts of a path joined with the platform's separator.
 *
 * Three parts are what the compiler asks of it, and the third is optional
 * because a call that joins two is the common one.
 */
export function join(first: string, second: string, third?: string): string {
  return third === undefined ? nodeJoin(first, second) : nodeJoin(first, second, third);
}

/** The separator a path is written with on this platform. */
export const sep: string = nodeSep;

/**
 * A path made absolute against the directory the process runs in.
 *
 * A second part is resolved after the first, which is how the compiler names a
 * file inside a directory.
 */
export function resolve(path: string, second?: string): string {
  return second === undefined ? nodeResolve(path) : nodeResolve(path, second);
}

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

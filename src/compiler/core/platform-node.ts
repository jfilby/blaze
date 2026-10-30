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
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  posix,
  relative,
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
  dirname,
  existsSync,
  extname,
  fileURLToPath,
  isAbsolute,
  join,
  mkdir,
  mkdtemp,
  normalize,
  open,
  parseArgs,
  posix,
  randomUUID,
  readFile,
  readFileSync,
  readdir,
  relative,
  rename,
  resolve,
  rm,
  sep,
  sleep,
  sleep as setTimeout,
  spawn,
  spawnSync,
  stat,
  tmpdir,
  writeFile,
  writeFileSync,
};

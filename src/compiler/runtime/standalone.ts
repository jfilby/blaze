/**
 * The compiler runtime.
 *
 * A build with `runtime: none` links the runtime the compiler emits itself: a
 * C header that describes the ABI and a C implementation of it on top of libc.
 * It is written into the project work directory and compiled once per build, so
 * a candidate object that calls the ABI resolves against exactly the same entry
 * points a Nim adapter would provide.
 *
 * The header is written for every native build, hosted or not: a C candidate
 * includes it either way, because the header describes the boundary rather than
 * a particular host.
 *
 * The object is the compiler's own source rather than the program's, so nothing
 * a program says changes it: every build of every project of a given mode and
 * target compiled the same nine thousand lines with `-O3` and then threw the
 * object away, which was the largest single cost of a build that had to change
 * one function. A compiled runtime is therefore kept under the work directory,
 * named by everything that decides it, and a build that finds it copies it out
 * instead of asking the C compiler the same question again.
 */

import { createHash } from "node:crypto";
import { copyFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { CompilerError } from "../core/errors.ts";
import { run } from "../core/process.ts";
import { RUNTIME_NAME, runtimeHeaderSource, runtimeSourceSource } from "./abi.ts";
import { cTargetOptions, optimizationOptions } from "../core/target.ts";
import type { BuildMode, TargetSpec } from "../core/types.ts";

export interface StandaloneRuntime {
  headerPath: string;
  sourcePath: string;
  objectPath: string;
}

/**
 * How the cached form is named. A change to what a cached object is or to what
 * it is keyed on names a different one rather than reusing an object built
 * under the old rule.
 */
const CACHE_SCHEMA = "compiler-runtime-object-1";

/**
 * Where compiled runtime objects are kept, under the work directory.
 *
 * It is the work directory rather than somewhere shared, because the object is
 * built for the machine the work directory was built on: `-mtune=native` and a
 * `-march` from the project's target are what the C compiler was told, and a
 * cache reached from two machines would answer one of them with the other's
 * object. The work directory is also what a project keeps between builds, which
 * is the reuse this is for.
 */
export const RUNTIME_CACHE_DIRECTORY = `${RUNTIME_NAME}-cache`;

/** Distinguishes the temporary files of builds that overlap. */
let temporary = 0;

/**
 * What the machine's C compiler is, once per process.
 *
 * The object is a compiler's answer for a given source and given flags, so a
 * different compiler is a different answer and its version is part of the key.
 * It is asked once and kept, because asking costs a process and it cannot
 * change under a running build.
 */
let compilerIdentity: Promise<string> | undefined;

function identifyCompiler(): Promise<string> {
  compilerIdentity ??= (async (): Promise<string> => {
    const version = run("gcc", ["--version"], { timeoutMs: 30_000 });
    if (version.spawnError !== undefined) {
      throw new CompilerError({
        category: "TargetError",
        stage: "compile",
        message: "the C compiler is not available",
        detail: version.spawnError,
      });
    }
    if (version.code !== 0) {
      throw new CompilerError({
        category: "TargetError",
        stage: "compile",
        message: "the C compiler did not say what it is",
        detail: version.stderr.trim(),
      });
    }
    return version.stdout.split("\n")[0]?.trim() ?? "";
  })();
  return compilerIdentity;
}

/**
 * The name a compiled object is kept under.
 *
 * Everything that decides the object is in it: the source, the flags the
 * compiler is invoked with, the source's name — which `-g` and a diagnostic
 * both carry — and the compiler itself. The cache also counts the machine's
 * cpu model, because `-mtune=native` reads it and nothing in the flags says
 * which cpu that was.
 */
function cacheKey(request: { name: string; source: string; flags: readonly string[] }, compiler: string): string {
  const machine = `${process.arch}/${cpus()[0]?.model ?? "unknown"}`;
  return createHash("sha256")
    .update([CACHE_SCHEMA, compiler, machine, request.name, ...request.flags, request.source].join("\u0000"), "utf8")
    .digest("hex")
    .slice(0, 32);
}

/** Writes the ABI header a candidate and the harness compile against. */
export async function writeRuntimeHeader(workDirectory: string): Promise<string> {
  const headerPath = `${workDirectory}/${RUNTIME_NAME}.h`;
  await writeFile(headerPath, runtimeHeaderSource(), "utf8");
  return headerPath;
}

/**
 * Writes a C source into the work directory and compiles it, reusing the object
 * an earlier build compiled from the same source with the same flags.
 *
 * A cache hit is a copy rather than the cached path itself, because the work
 * directory's object is what a build links and what its record names: a build
 * that resolved to a file under a cache would be a build whose record points at
 * something a later build may replace.
 *
 * A miss compiles into the cache and copies out of it, so the object a build
 * links is the object it kept, and a build that is stopped halfway leaves the
 * cache as it was rather than a partially written entry: an entry appears by a
 * rename, which is the only step of it that is one.
 */
export async function compileRuntimeSource(request: {
  workDirectory: string;
  /** The name of both the source and the object, inside the work directory. */
  name: string;
  source: string;
  /** The flags the object is compiled with, which are part of what decides it. */
  flags: readonly string[];
}): Promise<{ sourcePath: string; objectPath: string }> {
  const sourcePath = `${request.workDirectory}/${request.name}.c`;
  const objectPath = `${request.workDirectory}/${request.name}.o`;
  await writeFile(sourcePath, request.source, "utf8");

  const compiler = await identifyCompiler();
  const key = cacheKey(request, compiler);
  const directory = `${request.workDirectory}/${RUNTIME_CACHE_DIRECTORY}`;
  const cached = `${directory}/${key}.o`;

  const present = await stat(cached).then(
    (entry) => entry.isFile() && entry.size > 0,
    () => false,
  );
  if (present) {
    await copyFile(cached, objectPath);
    return { sourcePath, objectPath };
  }

  await mkdir(directory, { recursive: true });
  temporary += 1;
  const building = `${directory}/${key}.${process.pid}-${temporary}.tmp`;
  const compiled = run("gcc", ["-std=c11", ...request.flags, "-c", "-o", building, sourcePath], {
    timeoutMs: 120_000,
  });
  if (compiled.spawnError !== undefined) {
    await discard(building);
    throw new CompilerError({
      category: "TargetError",
      stage: "compile",
      message: "the C compiler is not available",
      detail: compiled.spawnError,
    });
  }
  if (compiled.code !== 0) {
    await discard(building);
    throw new CompilerError({
      category: "LinkError",
      stage: "compile",
      message: "the compiler runtime did not build",
      detail: `${sourcePath}\n${compiled.stderr.trim()}`,
    });
  }

  // Two builds of one project can miss the same key at once, so the rename can
  // find the name already there. The object is a function of the key, so an
  // entry that is already present answers this build as well.
  const renameFailure = await rename(building, cached).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (renameFailure !== undefined) {
    await discard(building);
    const present = await stat(cached).then(() => true, () => false);
    if (!present) throw renameFailure;
  }
  await copyFile(cached, objectPath);
  return { sourcePath, objectPath };
}

/** Removes a file a failed build left behind, and does not report a failure to. */
async function discard(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => undefined);
}

/**
 * Writes and compiles the runtime the compiler provides on top of libc.
 *
 * The guards the runtime carries are its own, and a `danger` build leaves them
 * out: the use-after-free check, the allocation overflow check and the size
 * caps are what stand between a released pointer and a second use of it.
 */
export async function buildStandaloneRuntime(
  workDirectory: string,
  mode: BuildMode = "debug",
  target: TargetSpec = { arch: "x86_64", os: "linux", abi: "sysv", cpu: "", features: [] },
): Promise<StandaloneRuntime> {
  const headerPath = await writeRuntimeHeader(workDirectory);
  // The runtime is one object with every entry point in it, and a program that
  // prints nothing still carried the number formatter and its `snprintf`
  // machinery. `-ffunction-sections` gives each entry point a section of its
  // own, and the `-Wl,--gc-sections` at the link then drops the ones this
  // program never reached. A section is only collectable if it is one.
  const compiled = await compileRuntimeSource({
    workDirectory,
    name: RUNTIME_NAME,
    source: runtimeSourceSource(mode),
    flags: [...optimizationOptions(mode), ...cTargetOptions(target), "-ffunction-sections", "-fdata-sections"],
  });
  return { headerPath, ...compiled };
}

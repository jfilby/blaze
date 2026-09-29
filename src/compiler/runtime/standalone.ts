/**
 * The compiler runtime.
 *
 * A build with `runtime: none` links the runtime the compiler emits itself: a
 * C header that describes the ABI and a C implementation of it on top of libc.
 * It is written into the project work directory and compiled once per
 * candidate, so a candidate object that calls the ABI resolves against exactly
 * the same entry points a Nim adapter would provide.
 *
 * The header is written for every native build, hosted or not: a C candidate
 * includes it either way, because the header describes the boundary rather than
 * a particular host.
 */

import { writeFile } from "node:fs/promises";
import { CompilerError } from "../core/errors.ts";
import { run } from "../core/process.ts";
import { RUNTIME_NAME, runtimeHeaderSource, runtimeSourceSource } from "./abi.ts";
import { optimizationOptions } from "../core/target.ts";
import type { BuildMode } from "../core/types.ts";

export interface StandaloneRuntime {
  headerPath: string;
  sourcePath: string;
  objectPath: string;
}

/** Writes the ABI header a candidate and the harness compile against. */
export async function writeRuntimeHeader(workDirectory: string): Promise<string> {
  const headerPath = `${workDirectory}/${RUNTIME_NAME}.h`;
  await writeFile(headerPath, runtimeHeaderSource(), "utf8");
  return headerPath;
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
): Promise<StandaloneRuntime> {
  const headerPath = await writeRuntimeHeader(workDirectory);
  const sourcePath = `${workDirectory}/${RUNTIME_NAME}.c`;
  const objectPath = `${workDirectory}/${RUNTIME_NAME}.o`;
  await writeFile(sourcePath, runtimeSourceSource(mode), "utf8");

  const compiled = run("gcc", ["-std=c11", ...optimizationOptions(mode), "-c", "-o", objectPath, sourcePath], {
    timeoutMs: 120_000,
  });
  if (compiled.spawnError !== undefined) {
    throw new CompilerError({
      category: "TargetError",
      stage: "compile",
      message: "the C compiler is not available",
      detail: compiled.spawnError,
    });
  }
  if (compiled.code !== 0) {
    throw new CompilerError({
      category: "LinkError",
      stage: "compile",
      message: "the compiler runtime did not build",
      detail: `${sourcePath}\n${compiled.stderr.trim()}`,
    });
  }
  return { headerPath, sourcePath, objectPath };
}

/**
 * The blaze Sglang runtime adapter.
 *
 * This adapter provides the entry points named by `runtime/sglang.ts`. It is
 * built as a relocatable object beside the program when Sglang is used, like
 * the SQLite adapter.
 */

// adapter alignment already done

/**
 * The C source of the Sglang adapter. It keeps device details to itself so
 * programs see only the ABI.
 */
export function sglangAdapterSource(): string {
  return `#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

/*
 * The blaze Sglang runtime adapter. Device-specific implementations may be
 * swapped in; the ABI boundary remains the same.
 */

static void* blaze_sglang_device_ptr = NULL;

int blaze_sglang_device_init(void) {
  /* No-op in the host implementation; device init is optional. */
  return 1;
}

void blaze_sglang_device_sync(void) {
  /* No-op. */
}

void* blaze_sglang_malloc(size_t bytes) {
  if (bytes == 0) return NULL;
  return malloc(bytes);
}

void blaze_sglang_free(void* ptr) {
  free(ptr);
}

int blaze_sglang_memcpy_h2d(void* dst, const void* src, size_t bytes) {
  if (dst == NULL || src == NULL) return 0;
  memcpy(dst, src, bytes);
  return 1;
}

int blaze_sglang_memcpy_d2h(void* dst, const void* src, size_t bytes) {
  if (dst == NULL || src == NULL) return 0;
  memcpy(dst, src, bytes);
  return 1;
}



int blaze_sglang_launch(const char* kernel_name,
                        unsigned long long grid_x, unsigned long long grid_y, unsigned long long grid_z,
                        unsigned long long block_x, unsigned long long block_y, unsigned long long block_z,
                        const void* const* args, const size_t* arg_sizes, size_t num_args,
                        size_t shared_mem) {
  (void)kernel_name;
  (void)grid_x; (void)grid_y; (void)grid_z;
  (void)block_x; (void)block_y; (void)block_z;
  (void)args; (void)arg_sizes; (void)num_args; (void)shared_mem;
  return 1;
}
`;
}

import { writeFile, dirname, fileURLToPath } from "../core/platform.ts";
import { CompilerError } from "../core/errors.ts";
import { run } from "../core/process.ts";
import { cTargetOptions, optimizationOptions } from "../core/target.ts";
import type { BuildMode, TargetSpec } from "../core/types.ts";
import { SGLANG_NAME, sglangHeaderSource } from "./sglang.ts";

const compilerDir = dirname(fileURLToPath(import.meta.url));
void compilerDir;

export async function buildSglangLibrary(
  workDirectory: string,
  mode: BuildMode = "debug",
  target: TargetSpec = { arch: "x86_64", os: "linux", abi: "sysv", cpu: "", features: [] },
): Promise<{ headerPath: string; objectPath: string }> {
  const headerPath = `${workDirectory}/${SGLANG_NAME}.h`;
  await writeFile(headerPath, sglangHeaderSource(), "utf8");
  const adapterPath = `${workDirectory}/${SGLANG_NAME}.c`;
  await writeFile(adapterPath, sglangAdapterSource(), "utf8");
  const adapterObject = `${workDirectory}/${SGLANG_NAME}_adapter.o`;
  const objectPath = `${workDirectory}/${SGLANG_NAME}.o`;
  const flags = [
    "-std=gnu11",
    ...optimizationOptions(mode).filter((flag) => flag !== "-flto" && flag !== "-ffat-lto-objects"),
    ...cTargetOptions(target),
    "-ffunction-sections",
    "-fdata-sections",
  ];
  const adapter = run(
    "gcc",
    [...flags, `-I${workDirectory}`, "-c", "-o", adapterObject, adapterPath],
    { timeoutMs: 300_000 },
  );
  if (adapter.spawnError !== undefined) {
    throw new CompilerError({
      category: "TargetError",
      stage: "compile",
      message: "the C compiler is not available",
      detail: adapter.spawnError,
    });
  }
  if (adapter.code !== 0) {
    throw new CompilerError({
      category: "LinkError",
      stage: "compile",
      message: "the Sglang adapter did not build",
      detail: `${adapterPath}\n${adapter.stderr.trim()}`,
    });
  }
  const bundled = run("ld", ["-r", "-o", objectPath, adapterObject], { timeoutMs: 120_000 });
  if (bundled.spawnError !== undefined || bundled.code !== 0) {
    throw new CompilerError({
      category: "LinkError",
      stage: "link",
      message: "the Sglang library did not bundle",
      detail: bundled.stderr.trim() ?? bundled.spawnError ?? "",
    });
  }
  return { headerPath, objectPath };
}

export { SGLANG_ABI } from "./sglang.ts";
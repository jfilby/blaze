/** Throwaway: does a pooled block keep its magic after a release? */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildStandaloneRuntime } from "../runtime/standalone.ts";
import { RUNTIME_NAME, runtimeHeaderSource } from "../runtime/abi.ts";
import { run } from "../core/process.ts";
import { scratch } from "./scratch.ts";

const PROBE = `
#include <stdio.h>
#include <stdint.h>
#include <stddef.h>
#include "blaze_rt.h"

int main(void) {
  /* The runtime puts this header in front of every block, and the header it
     declares is the one a program would look with. */
  void* p = blaze_rt_allocate(64);
  const blaze_rt_header* header = (const blaze_rt_header*)((char*)p - BLAZE_RT_HEADER_SIZE);
  printf("live block reads as live: %d\\n", header->magic == BLAZE_RT_MAGIC);
  blaze_rt_release(p);
  printf("after one release it still reads as live: %d\\n", header->magic == BLAZE_RT_MAGIC);
  blaze_rt_release(p);
  void* q = blaze_rt_allocate(64);
  void* r = blaze_rt_allocate(64);
  printf("two allocations after a double release alias: %d\\n", q == r);
  return 0;
}
`;

for (const mode of ["debug", "danger"] as const) {
  const directory = await scratch(`blaze-release-${mode}-`);
  await writeFile(join(directory, `${RUNTIME_NAME}.h`), runtimeHeaderSource(), "utf8");
  const built = await buildStandaloneRuntime(directory, mode);
  await writeFile(join(directory, "probe.c"), PROBE, "utf8");
  const compiled = await run(
    "gcc",
    ["-std=c11", "-O0", "-I", directory, join(directory, "probe.c"), built.objectPath, "-o", join(directory, "probe")],
    { cwd: directory, timeoutMs: 120_000 },
  );
  if (compiled.code !== 0) {
    console.log(`${mode}: gcc failed\n${compiled.stderr}`);
    continue;
  }
  const executed = await run(join(directory, "probe"), [], { cwd: directory, timeoutMs: 60_000 });
  console.log(`--- ${mode} (exit ${executed.code}) ---\n${executed.stdout}${executed.stderr}`);
}

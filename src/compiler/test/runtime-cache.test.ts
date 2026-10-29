/**
 * The compiled runtime, kept between builds.
 *
 * A runtime object is the compiler's own source compiled with the build's flags:
 * no program changes it, so a build that has to change one function of a project
 * still compiled it, which was the largest cost of that build. What is kept has
 * to be exactly what a compile of the same source with the same flags would
 * produce, which is what these tests hold it to: the cache is named by what
 * decides the object, a hit is the object it holds, and a different mode or
 * target is a different object.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scratch } from "./scratch.ts";
import { RUNTIME_CACHE_DIRECTORY, buildStandaloneRuntime } from "../runtime/standalone.ts";
import { runtimeSourceSource } from "../runtime/abi.ts";
import type { TargetSpec } from "../core/types.ts";

const TARGET: TargetSpec = { arch: "x86_64", os: "linux", abi: "sysv", cpu: "", features: [] };

/** The entries a work directory's runtime cache holds. */
async function cacheEntries(workDirectory: string): Promise<string[]> {
  const entries = await readdir(join(workDirectory, RUNTIME_CACHE_DIRECTORY)).catch(() => [] as string[]);
  return entries.sort();
}

/** The objects a work directory's runtime cache holds, in entry order. */
async function cacheObjects(workDirectory: string): Promise<Buffer[]> {
  const entries = await cacheEntries(workDirectory);
  return Promise.all(entries.map((entry) => readFile(join(workDirectory, RUNTIME_CACHE_DIRECTORY, entry))));
}

test("a runtime object compiled once is copied out of the cache instead of compiled again", async () => {
  const workDirectory = await scratch("blaze-runtime-cache-");

  const first = await buildStandaloneRuntime(workDirectory, "debug", TARGET);
  const original = await readFile(first.objectPath);
  assert.ok(original.length > 0, "the first build compiled an object");

  const entries = await cacheEntries(workDirectory);
  assert.equal(entries.length, 1, `one object was kept, but ${entries.join(", ")} were`);
  const cached = join(workDirectory, RUNTIME_CACHE_DIRECTORY, entries[0] as string);

  // A byte pattern that no compile of the runtime would produce: what the next
  // build links is either that pattern, which is the cache answering, or a real
  // object, which is the C compiler being asked again.
  const marker = Buffer.from("the cache answered this build\n");
  await writeFile(cached, marker);

  const second = await buildStandaloneRuntime(workDirectory, "debug", TARGET);
  assert.deepEqual(await readFile(second.objectPath), marker);
  assert.deepEqual(await readFile(cached), marker, "the cached object is not rewritten by a hit");
  assert.equal(second.sourcePath, first.sourcePath);
  assert.equal(await readFile(second.sourcePath, "utf8"), runtimeSourceSource("debug"));
});

test("a mode is part of what the object is, so each mode keeps its own", async () => {
  const workDirectory = await scratch("blaze-runtime-cache-modes-");

  const debug = await buildStandaloneRuntime(workDirectory, "debug", TARGET);
  const debugObject = await readFile(debug.objectPath);
  const release = await buildStandaloneRuntime(workDirectory, "release", TARGET);
  const releaseObject = await readFile(release.objectPath);

  assert.equal((await cacheEntries(workDirectory)).length, 2, "each mode is an object of its own");
  assert.notDeepEqual(debugObject, releaseObject);
  // The C source is the mode's own too, and it is written whether or not the
  // object was, because a build that links the runtime compiles candidates
  // against its header and reads its source for a diagnostic.
  assert.equal(await readFile(release.sourcePath, "utf8"), runtimeSourceSource("release"));
});

test("a target is part of what the object is, so a different one is not reused", async () => {
  const workDirectory = await scratch("blaze-runtime-cache-target-");

  await buildStandaloneRuntime(workDirectory, "debug", TARGET);
  // The features do not change the flags this compiler passes the C compiler
  // today, so they are not part of the name: what decides the object is the
  // command line, and a target that produces the same one produces the same
  // object.
  await buildStandaloneRuntime(workDirectory, "debug", { ...TARGET, features: ["sse4.1"] });
  assert.equal((await cacheEntries(workDirectory)).length, 1);

  await buildStandaloneRuntime(workDirectory, "debug", { ...TARGET, cpu: "haswell" });
  assert.equal((await cacheEntries(workDirectory)).length, 2, "a cpu is a different command line, so a different object");
  const objects = await cacheObjects(workDirectory);
  assert.notDeepEqual(objects[0], objects[1]);
});

test("a work directory keeps what it built, and does not answer for another", async () => {
  const one = await scratch("blaze-runtime-cache-one-");
  const two = await scratch("blaze-runtime-cache-two-");

  const built = await buildStandaloneRuntime(one, "debug", TARGET);
  assert.equal((await cacheEntries(one)).length, 1);

  // A second project has nothing kept yet, so it compiles its own rather than
  // reaching into the first one's work directory.
  await buildStandaloneRuntime(two, "debug", TARGET);
  assert.equal((await cacheEntries(two)).length, 1);
  assert.ok(built.objectPath.startsWith(one), "the object a build links is the one in its own work directory");
  assert.ok((await readFile(built.objectPath)).subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])));
  // The two objects are not compared: a debug build keeps the path of the
  // directory it was compiled in, so two work directories hold two objects even
  // when both were compiled from the same source with the same flags.
  assert.equal((await cacheObjects(two))[0]?.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), true);
});

/**
 * The scratch directory a test builds in.
 *
 * Every suite here needs somewhere to write a project, an object or a runtime,
 * and `mkdtemp` under the system temporary directory is what gives each one a
 * name nothing else holds. What `mkdtemp` does not give is an end: a directory
 * it made is still there when the suite finishes, so a full run left fourteen
 * thousand of them behind and filled the temporary filesystem, which then failed
 * the builds of the next run for want of space rather than for any fault of its
 * own.
 *
 * So a directory made through here is remembered and removed when the process
 * exits. Removal is at exit rather than after each test because a test's
 * directory is read by whatever asserts on it, and several suites build in one
 * directory across a sequence of tests — removing per test would delete the
 * evidence the next assertion is about.
 */

import { rmSync } from "node:fs";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Every directory made through `scratch`, removed when the process exits. */
const directories: string[] = [];

/**
 * Removes what `scratch` made, once the process is on its way out.
 *
 * `rmSync` rather than the promise: an exit handler has no one left to await a
 * rejection, and a directory that survived because the event loop had already
 * drained is exactly the leak this exists to close. A directory that cannot be
 * removed is counted and reported rather than thrown, because throwing out of an
 * exit handler ends the process on the first one and leaves the rest behind.
 */
function onExit(): void {
  const failed: string[] = [];
  for (const directory of directories.splice(0, directories.length)) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      failed.push(directory);
    }
  }
  if (failed.length > 0) {
    const plural = failed.length === 1 ? "y" : "ies";
    process.stderr.write(`blaze: ${failed.length} scratch director${plural} could not be removed\n`);
  }
}

process.on("exit", onExit);

/** A fresh empty directory named after `prefix`, removed when the process exits. */
export async function scratch(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

/**
 * The store directory a project's build wrote into.
 *
 * A store directory carries the readable project name and a hash of the
 * project's path beside it, because a name alone is not unique and two
 * projects sharing a directory would overwrite each other's cache. A test
 * that reaches into the store therefore asks which directory is the
 * project's, rather than naming one.
 */
export async function storeDirectory(directory: string, project: string): Promise<string> {
  const projects = join(directory, ".blaze", "projects");
  const found = (await readdir(projects).catch(() => [] as string[])).filter((entry) =>
    entry.startsWith(`${project}-`),
  );
  return join(projects, found.sort()[0] ?? project);
}

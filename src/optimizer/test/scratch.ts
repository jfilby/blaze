/**
 * The scratch directory a test builds in.
 *
 * The suites here need somewhere to write a project, a repository or a cache,
 * and `mkdtemp` under the system temporary directory is what gives each one a
 * name nothing else holds. What `mkdtemp` does not give is an end: a
 * directory it made is still there when the suite finishes, and a machine
 * that runs these often enough fills its temporary filesystem with them.
 *
 * So a directory made through here is remembered and removed when the
 * process exits. Removal is at exit rather than after each test because a
 * test's directory is read by whatever asserts on it — removing per test
 * would delete the evidence the next assertion is about.
 *
 * This is the compiler's own `test/scratch.ts`, whose lesson is written at
 * the top of it: a run that leaves fourteen thousand directories behind
 * fills the disk, and the failure that follows is not one of its own.
 */

import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Every directory made through `scratch`, removed when the process exits. */
const directories: string[] = [];

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
    process.stderr.write(`blazeopt: ${failed.length} scratch director${plural} could not be removed\n`);
  }
}

process.on("exit", onExit);

/** A fresh empty directory named after `prefix`, removed when the process exits. */
export async function scratch(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

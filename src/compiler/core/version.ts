/**
 * What this compiler is.
 *
 * Two things name it, and they answer different questions. The version is the
 * release, and it moves on a schedule. The fingerprint is a hash of the
 * compiler's own sources, and it moves whenever anything that decides what a
 * function compiles to moves: the prompt a model is given, the runtime it is
 * linked against, the rules the assembler is held to, the driver that runs the
 * program. Those are edited between releases and shipped with a version that
 * has not changed, so a build record that outlived such an edit is a proof
 * about a compiler that no longer exists.
 *
 * The incremental key hashes the fingerprint, which is why a stale object can
 * no longer be delivered as freshly proved.
 */

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const COMPILER_VERSION = "0.1.0";

/** The package this module was loaded from, which is what gets fingerprinted. */
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Directories that hold no compiler. Tests are not compiled into a build, and
 * the state directory is the output of builds rather than part of one. A name
 * is only ever compared against `true`, so a file called `__proto__` is read
 * like any other rather than reaching the prototype.
 */
const NOT_COMPILER: Record<string, true> = {
  node_modules: true,
  test: true,
  ".blaze": true,
};

/**
 * A hash of every compiler source under a root, or a name for the root when
 * they cannot be read. The path of each file is hashed along with its
 * contents, so a file that moves is a change even when its contents are not,
 * and the walk is sorted, so the same tree is the same hash.
 *
 * The fallback is deliberately not the version: a fingerprint that cannot be
 * computed must not be one that stays the same through an edit, and a run that
 * cannot read its own sources is not a run whose cached objects can be trusted
 * to match it.
 */
export async function fingerprintSources(root: string): Promise<string> {
  const found = new Map<string, string>();
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : 1));
    for (const entry of entries) {
      if (NOT_COMPILER[entry.name] === true) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        found.set(relative(root, path).split(sep).join("/"), await readFile(path, "utf8"));
      }
    }
  };
  try {
    await walk(root);
  } catch (cause) {
    return createHash("sha256")
      .update(`unreadable:${root}:${cause instanceof Error ? cause.message : String(cause)}`)
      .digest("hex");
  }
  const hash = createHash("sha256");
  for (const [path, contents] of found) hash.update(`${path} ${contents} `);
  return hash.digest("hex");
}

/** One read of the tree, however many functions ask for its fingerprint. */
let reading: Promise<string> | undefined;

/** The fingerprint of the compiler this process is running. */
export async function toolchainFingerprint(): Promise<string> {
  reading ??= fingerprintSources(PACKAGE_ROOT);
  return reading;
}

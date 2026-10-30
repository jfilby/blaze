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
 * The fingerprint is two hashes, because an edit to the compiler invalidates
 * two different things, and a build can carry the first across the second. What
 * a review said was about the IR: the model was handed a function and named the
 * rewrites it would make to it. An edit that cannot change that function leaves
 * what was said still true. The assembler, the encoder, the C writer and the
 * runtime are all downstream of the IR and none of them is upstream of it, so a
 * change to any of them is in the next object and is not in the artifact that
 * was reviewed — which means the stored candidates, and the verdicts recorded
 * against them, survive it. What they do not survive is the object, so the two
 * hashes are what separates a candidate that may be reviewed again from an
 * object that may be linked as it stands.
 */

import { createHash, readFile, readdir, join, relative, sep, fileURLToPath } from "./platform.ts";

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
 * The sources that decide what an object is, and cannot decide what a review
 * said. A source is named here only when nothing it does reaches back into the
 * IR a model is handed or into the verdict it returned, which is a claim about
 * that source and not about its directory: `toolchain/verifier.ts` decides
 * whether a candidate is valid and so is on the review side of the line, while
 * `toolchain/ir-machine.ts` only reads a function it was given and is on this
 * one.
 *
 * It is a list of what may be moved, not of what must be. A source that is not
 * named falls into the review fingerprint, which is the direction that is safe:
 * an edit to it discards work the build could have kept, rather than keeping
 * work the edit had invalidated. Naming a source wrongly is the other way
 * round — a stale object delivered as freshly proved — so a new source starts on
 * the review side and is moved across only with its reason written down here.
 */
const LOWERING_ONLY: Record<string, true> = {
  // What an IR is turned into. Each reads a function and emits from it, and
  // none of them rewrites the one it was given: `optimize-ir.ts` runs to a fixed
  // point in `codegen.ts` before any backend is called and no backend runs it.
  "toolchain/ir-machine.ts": true,
  "toolchain/ir-c.ts": true,
  "toolchain/ir-wasm.ts": true,
  "toolchain/csource.ts": true,
  // The encoders and writers behind them: instructions, objects, modules.
  "toolchain/x86.ts": true,
  "toolchain/asm-text.ts": true,
  "toolchain/assembler.ts": true,
  "toolchain/elf64.ts": true,
  "toolchain/wasm.ts": true,
  // How a function's frame is laid out and what it is called in a binary.
  "toolchain/stack-frame.ts": true,
  "toolchain/names.ts": true,
  "toolchain/c-names.ts": true,
  // What goes into a binary beside the objects: the runtime it is linked
  // against, and the program driver and the source it emits.
  "toolchain/linker.ts": true,
  "toolchain/driver.ts": true,
  "toolchain/program-emit.ts": true,
  "runtime/abi.ts": true,
  "runtime/nim.ts": true,
  "runtime/nim-program.ts": true,
  "runtime/standalone.ts": true,
  // How hard the toolchain is asked to build. The flags are read at every
  // compile and link and at none of the steps that decide what a function is.
  "core/target.ts": true,
};

/**
 * The two fingerprints of one tree, read in one pass.
 *
 * `review` covers every source that is not lowering-only and `lowering` the ones
 * that are, so an edit to a source lands in exactly one of them.
 */
export interface Fingerprints {
  /** What decides the IR a function is, and the verdict a review reached. */
  readonly review: string;
  /** What decides the object that IR is lowered into. */
  readonly lowering: string;
}

/**
 * A hash of every compiler source under a root, split by what each decides, or
 * a name for the root when they cannot be read. The path of each file is hashed
 * along with its contents, so a file that moves is a change even when its
 * contents are not, and the walk is sorted, so the same tree is the same hash.
 *
 * The fallback is deliberately not the version: a fingerprint that cannot be
 * computed must not be one that stays the same through an edit, and a run that
 * cannot read its own sources is not a run whose cached objects can be trusted
 * to match it. It is the answer for both halves, so an unreadable tree keeps
 * neither a stored candidate nor a stored object.
 */
export async function fingerprintSources(root: string): Promise<Fingerprints> {
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
    const unreadable = createHash("sha256")
      .update(`unreadable:${root}:${cause instanceof Error ? cause.message : String(cause)}`)
      .digest("hex");
    return { review: unreadable, lowering: unreadable };
  }
  const review = createHash("sha256");
  const lowering = createHash("sha256");
  for (const [path, contents] of found) {
    if (LOWERING_ONLY[path] === true) lowering.update(`${path} ${contents} `);
    else review.update(`${path} ${contents} `);
  }
  return { review: review.digest("hex"), lowering: lowering.digest("hex") };
}

/** One read of the tree, however many functions ask for its fingerprint. */
let reading: Promise<Fingerprints> | undefined;

/** The fingerprints of the compiler this process is running. */
export async function toolchainFingerprints(): Promise<Fingerprints> {
  reading ??= fingerprintSources(PACKAGE_ROOT);
  return reading;
}

/**
 * The engine one build ran on: the release, and the fingerprint of the sources
 * that decide what a function is. A build record carries it and the next run
 * compares it, which is what lets `blaze build` say that the compiler moved
 * under a project instead of silently asking a model for every function again.
 *
 * Only the review fingerprint is in it, because that is the side that costs:
 * an edit to a lowering-only source leaves everything a model reviewed
 * standing, so the objects are rebuilt by the rules as they are now and there
 * is nothing to ask about. Every other edit is in here.
 */
export function engineStamp(fingerprints: Fingerprints): string {
  return `${COMPILER_VERSION}+${fingerprints.review.slice(0, 8)}`;
}

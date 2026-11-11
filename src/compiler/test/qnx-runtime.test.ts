/**
 * QNX runtime selection and the shell-free facil.io walk.
 *
 * The runtime and library policy is pure data, so it is tested without a QNX
 * machine. The source walk is ordinary directory work, so it is tested on the
 * host that runs the suite; what it proves is that the build no longer needs
 * `find` to name the translation units it compiles.
 */

import assert from "node:assert/strict";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { inspectProject, runBuild } from "../compiler.ts";
import { compilerDataRoot, compilerSourceRoot } from "../core/platform.ts";
import { assertLibrarySupported, assertRuntimeSupported } from "../core/target.ts";
import { toolchainFor } from "../core/toolchain.ts";
import type { SourceInput, TargetSpec } from "../core/types.ts";
import { facilIoSourceDir, vendoredFacilIoDir, walkFacilIoTree } from "../runtime/facil.ts";
import { vendoredSqliteDir } from "../runtime/sqlite-build.ts";
import { writeProject } from "./project.ts";
import { scratch } from "./scratch.ts";

const QNX_X86: TargetSpec = { arch: "x86_64", os: "qnx", abi: "sysv", cpu: "", features: [] };
const LINUX_X86: TargetSpec = { arch: "x86_64", os: "linux", abi: "sysv", cpu: "", features: [] };

const quiet = { stage: () => {} };

test("QNX refuses the runtimes and libraries it cannot provide", () => {
  assert.doesNotThrow(() => assertRuntimeSupported(QNX_X86, "none"));
  assert.doesNotThrow(() => assertRuntimeSupported(QNX_X86, "facil"));
  assert.throws(
    () => assertRuntimeSupported(QNX_X86, "nim"),
    /the "nim" runtime is not available on QNX/,
  );
  assert.doesNotThrow(() => assertRuntimeSupported(LINUX_X86, "nim"));

  assert.doesNotThrow(() => assertLibrarySupported(QNX_X86, "sqlite"));
  assert.throws(
    () => assertLibrarySupported(QNX_X86, "triton"),
    /the "triton" library is not available on QNX/,
  );
  assert.doesNotThrow(() => assertLibrarySupported(LINUX_X86, "triton"));
});

test("a QNX build refuses Nim before it is lowered", async () => {
  const directory = await scratch("blaze-qnx-nim-");
  const input: SourceInput = {
    language: "typescript",
    source: "console.log(1);\n",
    target: QNX_X86,
    output: "c",
    runtime: "nim",
  };
  await writeProject(join(directory, "input.toml"), input);
  await assert.rejects(
    () => runBuild("input.toml", { cwd: directory, reuse: false }, quiet, "build"),
    /the "nim" runtime is not available on QNX/,
  );

  // The refusal happens before a compiler runs, but the project named a target
  // and that target selected a compiler: a record that said Linux or named no
  // compiler would hide both facts from the reader of a failed QNX build.
  const build = await inspectProject("input", directory);
  assert.equal(build.target.os, "qnx");
  assert.equal(build.toolchain, toolchainFor(QNX_X86).id);
});

test("a QNX build refuses Triton before the source is contracted", async () => {
  const directory = await scratch("blaze-qnx-triton-");
  const input: SourceInput = {
    language: "typescript",
    source: "tl.load(x);\n",
    target: QNX_X86,
    output: "c",
    runtime: "none",
  };
  await writeProject(join(directory, "input.toml"), input);
  await assert.rejects(
    () => runBuild("input.toml", { cwd: directory, reuse: false }, quiet, "build"),
    /the "triton" library is not available on QNX/,
  );
});

test("the facil.io walk finds C sources and include directories without a shell", async () => {
  const root = await scratch("blaze-facil-tree-");
  await mkdir(join(root, "http1_parser"), { recursive: true });
  await mkdir(join(root, "tls"), { recursive: true });
  await writeFile(join(root, "fio.c"), "int fio;\n", "utf8");
  await writeFile(join(root, "http1_parser", "http1_parser.c"), "int parser;\n", "utf8");
  await writeFile(join(root, "tls", "fio_tls_missing.c"), "int tls;\n", "utf8");
  await writeFile(join(root, "README.md"), "not a translation unit\n", "utf8");

  const tree = await walkFacilIoTree(root);
  assert.deepEqual(
    [...tree.sources].sort(),
    [
      join(root, "fio.c"),
      join(root, "http1_parser", "http1_parser.c"),
      join(root, "tls", "fio_tls_missing.c"),
    ].sort(),
  );
  assert.deepEqual(
    [...tree.directories].sort(),
    [join(root, "http1_parser"), join(root, "tls")].sort(),
  );
});

test("vendored sources are found from the compiler data root", async () => {
  assert.equal(vendoredFacilIoDir(), join(compilerDataRoot(), "deps", "facil.io"));
  assert.equal(vendoredSqliteDir(), join(compilerDataRoot(), "deps", "sqlite3"));
  assert.equal((await stat(facilIoSourceDir())).isDirectory(), true);
  assert.equal((await stat(vendoredSqliteDir())).isDirectory(), true);
});

test("the compiler fingerprints the package its host names", async () => {
  assert.equal((await stat(join(compilerSourceRoot(), "cli.ts"))).isFile(), true);
  assert.equal((await stat(join(compilerSourceRoot(), "core", "version.ts"))).isFile(), true);
});

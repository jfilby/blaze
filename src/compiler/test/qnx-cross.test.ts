/**
 * A QNX cross-compile smoke test.
 *
 * The target and toolchain selection are pure data and are tested by
 * `qnx-target.test.ts`. This test asks the installed QNX SDP to do the work,
 * so it skips on a machine that does not have `qcc` or has not sourced the
 * QNX environment. A machine that has both is expected to produce an object
 * for each architecture the SDP provides.
 */

import assert from "node:assert/strict";
import { stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { test } from "node:test";
import { runBuild } from "../compiler.ts";
import { run } from "../core/process.ts";
import { cTargetOptions } from "../core/target.ts";
import type { TargetSpec } from "../core/types.ts";
import { runtimeSourceSource } from "../runtime/abi.ts";
import { buildFacilRuntime } from "../runtime/facil.ts";
import { buildSqliteLibrary } from "../runtime/sqlite-build.ts";
import { buildStandaloneRuntime, writeRuntimeHeader } from "../runtime/standalone.ts";
import { writeProject } from "./project.ts";
import { scratch } from "./scratch.ts";

const QCC_ARCHITECTURES = [
  ["x86_64", "gcc_ntox86_64"],
  ["aarch64", "gcc_ntoaarch64le"],
] as const;

const QNX_TARGETS: readonly TargetSpec[] = QCC_ARCHITECTURES.map(([arch]) => ({
  arch,
  os: "qnx",
  abi: arch === "x86_64" ? "sysv" : "aapcs",
  cpu: "",
  features: [],
}));

test("qcc cross-compiles a QNX object when the QNX SDP is installed", async (t) => {
  const qcc = run("qcc", ["-V"], { timeoutMs: 30_000 });
  if (qcc.spawnError !== undefined || qcc.code !== 0) {
    t.skip("qcc is not on PATH; source the QNX SDP environment to run this test");
    return;
  }
  if (process.env.QNX_TARGET === undefined || process.env.QNX_TARGET === "") {
    t.skip("QNX_TARGET is not set; source the QNX SDP environment to run this test");
    return;
  }

  const directory = await scratch("blaze-qnx-cross-");
  const source = join(directory, "probe.c");
  await writeFile(source, "int blaze_qnx_probe(void) { return 3; }\n", "utf8");

  for (const [architecture, selector] of QCC_ARCHITECTURES) {
    const available = run("qcc", [`-V${selector}`, "--version"], { timeoutMs: 30_000 });
    if (available.spawnError !== undefined || available.code !== 0) {
      t.diagnostic(`qcc has no ${architecture} compiler: ${available.stderr.trim()}`);
      continue;
    }

    const object = join(directory, `${architecture}.o`);
    const compiled = run("qcc", [`-V${selector}`, "-c", "-o", object, source], {
      timeoutMs: 120_000,
    });
    assert.equal(compiled.spawnError, undefined, `${architecture}: ${compiled.spawnError ?? ""}`);
    assert.equal(compiled.code, 0, `${architecture}: ${compiled.stderr.trim()}`);
    const info = await stat(object);
    assert.ok(info.size > 0, `${architecture}: qcc wrote an object`);
  }
});

test("qcc compiles the generated runtime for both QNX architectures", async (t) => {
  const qcc = run("qcc", ["-V"], { timeoutMs: 30_000 });
  if (qcc.spawnError !== undefined || qcc.code !== 0) {
    t.skip("qcc is not on PATH; source the QNX SDP environment to run this test");
    return;
  }
  if (process.env.QNX_TARGET === undefined || process.env.QNX_TARGET === "") {
    t.skip("QNX_TARGET is not set; source the QNX SDP environment to run this test");
    return;
  }

  const directory = await scratch("blaze-qnx-runtime-cross-");
  // The runtime includes its own header by name, so the header is written
  // beside the source exactly as a native build writes it.
  await writeRuntimeHeader(directory);
  const source = join(directory, "blaze_rt.c");
  await writeFile(source, runtimeSourceSource("debug"), "utf8");

  for (const target of QNX_TARGETS) {
    const architecture = target.arch;
    const selector = architecture === "x86_64" ? "gcc_ntox86_64" : "gcc_ntoaarch64le";
    const available = run("qcc", [`-V${selector}`, "--version"], { timeoutMs: 30_000 });
    if (available.spawnError !== undefined || available.code !== 0) {
      t.diagnostic(`qcc has no ${architecture} compiler: ${available.stderr.trim()}`);
      continue;
    }

    const object = join(directory, `${architecture}-runtime.o`);
    const compiled = run(
      "qcc",
      [`-V${selector}`, "-std=c11", "-O0", ...cTargetOptions(target), "-c", "-o", object, source],
      { timeoutMs: 300_000 },
    );
    assert.equal(compiled.spawnError, undefined, `${architecture}: ${compiled.spawnError ?? ""}`);
    assert.equal(compiled.code, 0, `${architecture}: ${compiled.stderr.trim()}`);
    const info = await stat(object);
    assert.ok(info.size > 0, `${architecture}: qcc compiled the runtime`);
  }
});

test("qcc builds the HTTP runtime for both QNX architectures", async (t) => {
  const qcc = run("qcc", ["-V"], { timeoutMs: 30_000 });
  if (qcc.spawnError !== undefined || qcc.code !== 0) {
    t.skip("qcc is not on PATH; source the QNX SDP environment to run this test");
    return;
  }
  if (process.env.QNX_TARGET === undefined || process.env.QNX_TARGET === "") {
    t.skip("QNX_TARGET is not set; source the QNX SDP environment to run this test");
    return;
  }

  for (const target of QNX_TARGETS) {
    const selector = target.arch === "x86_64" ? "gcc_ntox86_64" : "gcc_ntoaarch64le";
    const available = run("qcc", [`-V${selector}`, "--version"], { timeoutMs: 30_000 });
    if (available.spawnError !== undefined || available.code !== 0) {
      t.diagnostic(`qcc has no ${target.arch} compiler: ${available.stderr.trim()}`);
      continue;
    }

    const directory = await scratch(`blaze-qnx-facil-${target.arch}-`);
    const runtime = await buildFacilRuntime(directory, "debug", target);
    const info = await stat(runtime.objectPath);
    assert.ok(info.size > 0, `${target.arch}: qcc built the HTTP runtime`);
  }
});

test("qcc builds the SQLite library for both QNX architectures", async (t) => {
  const qcc = run("qcc", ["-V"], { timeoutMs: 30_000 });
  if (qcc.spawnError !== undefined || qcc.code !== 0) {
    t.skip("qcc is not on PATH; source the QNX SDP environment to run this test");
    return;
  }
  if (process.env.QNX_TARGET === undefined || process.env.QNX_TARGET === "") {
    t.skip("QNX_TARGET is not set; source the QNX SDP environment to run this test");
    return;
  }

  for (const target of QNX_TARGETS) {
    const selector = target.arch === "x86_64" ? "gcc_ntox86_64" : "gcc_ntoaarch64le";
    const available = run("qcc", [`-V${selector}`, "--version"], { timeoutMs: 30_000 });
    if (available.spawnError !== undefined || available.code !== 0) {
      t.diagnostic(`qcc has no ${target.arch} compiler: ${available.stderr.trim()}`);
      continue;
    }

    const directory = await scratch(`blaze-qnx-sqlite-${target.arch}-`);
    // The adapter includes the runtime header a build writes before it.
    await writeRuntimeHeader(directory);
    const library = await buildSqliteLibrary(directory, "debug", target);
    const info = await stat(library.objectPath);
    assert.ok(info.size > 0, `${target.arch}: qcc built the SQLite library`);
  }
});

test("qcc links the generated runtime into a QNX executable", async (t) => {
  const qcc = run("qcc", ["-V"], { timeoutMs: 30_000 });
  if (qcc.spawnError !== undefined || qcc.code !== 0) {
    t.skip("qcc is not on PATH; source the QNX SDP environment to run this test");
    return;
  }
  if (process.env.QNX_TARGET === undefined || process.env.QNX_TARGET === "") {
    t.skip("QNX_TARGET is not set; source the QNX SDP environment to run this test");
    return;
  }

  for (const target of QNX_TARGETS) {
    const selector = target.arch === "x86_64" ? "gcc_ntox86_64" : "gcc_ntoaarch64le";
    const available = run("qcc", [`-V${selector}`, "--version"], { timeoutMs: 30_000 });
    if (available.spawnError !== undefined || available.code !== 0) {
      t.diagnostic(`qcc has no ${target.arch} compiler: ${available.stderr.trim()}`);
      continue;
    }

    const directory = await scratch(`blaze-qnx-link-${target.arch}-`);
    const runtime = await buildStandaloneRuntime(directory, "debug", target);
    const main = join(directory, "main.c");
    await writeFile(main, `#include "${basename(runtime.headerPath)}"\nint main(void) { return 0; }\n`, "utf8");
    const executable = join(directory, "probe");
    const linked = run(
      "qcc",
      [
        `-V${selector}`,
        "-std=c11",
        "-Wl,--gc-sections",
        "-o",
        executable,
        main,
        runtime.objectPath,
        "-lm",
        "-pthread",
      ],
      { timeoutMs: 120_000 },
    );
    assert.equal(linked.spawnError, undefined, `${target.arch}: ${linked.spawnError ?? ""}`);
    assert.equal(linked.code, 0, `${target.arch}: ${linked.stderr.trim()}`);
    const info = await stat(executable);
    assert.ok(info.size > 0, `${target.arch}: qcc linked a QNX executable`);
  }
});

const quiet = () => {};

test("a QNX C program builds and links for both targets", async (t) => {
  const qcc = run("qcc", ["-V"], { timeoutMs: 30_000 });
  if (qcc.spawnError !== undefined || qcc.code !== 0) {
    t.skip("qcc is not on PATH; source the QNX SDP environment to run this test");
    return;
  }
  if (process.env.QNX_TARGET === undefined || process.env.QNX_TARGET === "") {
    t.skip("QNX_TARGET is not set; source the QNX SDP environment to run this test");
    return;
  }

  for (const target of QNX_TARGETS) {
    const selector = target.arch === "x86_64" ? "gcc_ntox86_64" : "gcc_ntoaarch64le";
    const available = run("qcc", [`-V${selector}`, "--version"], { timeoutMs: 30_000 });
    if (available.spawnError !== undefined || available.code !== 0) {
      t.diagnostic(`qcc has no ${target.arch} compiler: ${available.stderr.trim()}`);
      continue;
    }

    const directory = await scratch(`blaze-qnx-program-${target.arch}-`);
    await writeProject(join(directory, "input.toml"), {
      language: "typescript",
      source: "console.log(1 + 2);\n",
      target,
      output: "machine",
      backend: "c",
      runtime: "none",
    });
    const outcome = await runBuild("input.toml", { cwd: directory, reuse: false }, quiet, "build");
    assert.equal(outcome.build.status, "success");
    assert.equal(outcome.build.toolchain, target.arch === "x86_64" ? "qcc-x86_64" : "qcc-aarch64");
    assert.equal(outcome.build.programVerification, "none");
    const output = outcome.outputPath;
    assert.ok(output !== null);
    const inspection = run("file", [output], { timeoutMs: 30_000 });
    assert.match(inspection.stdout, target.arch === "x86_64" ? /x86-64/ : /aarch64/);
    assert.match(inspection.stdout, /ldqnx/);
  }
});

test("a QNX HTTP program builds and links for both targets", async (t) => {
  const qcc = run("qcc", ["-V"], { timeoutMs: 30_000 });
  if (qcc.spawnError !== undefined || qcc.code !== 0) {
    t.skip("qcc is not on PATH; source the QNX SDP environment to run this test");
    return;
  }
  if (process.env.QNX_TARGET === undefined || process.env.QNX_TARGET === "") {
    t.skip("QNX_TARGET is not set; source the QNX SDP environment to run this test");
    return;
  }

  for (const target of QNX_TARGETS) {
    const selector = target.arch === "x86_64" ? "gcc_ntox86_64" : "gcc_ntoaarch64le";
    const available = run("qcc", [`-V${selector}`, "--version"], { timeoutMs: 30_000 });
    if (available.spawnError !== undefined || available.code !== 0) {
      t.diagnostic(`qcc has no ${target.arch} compiler: ${available.stderr.trim()}`);
      continue;
    }

    const directory = await scratch(`blaze-qnx-http-${target.arch}-`);
    await writeProject(join(directory, "input.toml"), {
      language: "typescript",
      source: "const port = 18080;\nhttp.serve(port);\n",
      target,
      output: "machine",
      backend: "c",
    });
    const outcome = await runBuild("input.toml", { cwd: directory, reuse: false }, quiet, "build");
    assert.equal(outcome.build.status, "success");
    assert.equal(outcome.build.runtime, "facil");
    assert.equal(outcome.build.toolchain, target.arch === "x86_64" ? "qcc-x86_64" : "qcc-aarch64");
    const output = outcome.outputPath;
    assert.ok(output !== null);
    const inspection = run("file", [output], { timeoutMs: 30_000 });
    assert.match(inspection.stdout, /ldqnx/);
  }
});

test("a QNX TLS HTTP program builds and links", async (t) => {
  const qcc = run("qcc", ["-V"], { timeoutMs: 30_000 });
  if (qcc.spawnError !== undefined || qcc.code !== 0) {
    t.skip("qcc is not on PATH; source the QNX SDP environment to run this test");
    return;
  }
  if (process.env.QNX_TARGET === undefined || process.env.QNX_TARGET === "") {
    t.skip("QNX_TARGET is not set; source the QNX SDP environment to run this test");
    return;
  }

  const directory = await scratch("blaze-qnx-http-tls-");
  await writeProject(join(directory, "input.toml"), {
    language: "typescript",
    source: 'const port = 18080;\nhttp.serveTls(port, "cert.pem", "key.pem");\n',
    target: QNX_TARGETS[0] as TargetSpec,
    output: "machine",
    backend: "c",
  });
  const outcome = await runBuild("input.toml", { cwd: directory, reuse: false }, quiet, "build");
  assert.equal(outcome.build.status, "success");
  assert.equal(outcome.build.runtime, "facil");
  assert.equal(outcome.build.toolchain, "qcc-x86_64");
  const output = outcome.outputPath;
  assert.ok(output !== null);
  const inspection = run("file", [output], { timeoutMs: 30_000 });
  assert.match(inspection.stdout, /ldqnx/);
});

test("a QNX x86-64 machine program builds and links", async (t) => {
  const qcc = run("qcc", ["-V"], { timeoutMs: 30_000 });
  if (qcc.spawnError !== undefined || qcc.code !== 0) {
    t.skip("qcc is not on PATH; source the QNX SDP environment to run this test");
    return;
  }
  if (process.env.QNX_TARGET === undefined || process.env.QNX_TARGET === "") {
    t.skip("QNX_TARGET is not set; source the QNX SDP environment to run this test");
    return;
  }

  const directory = await scratch("blaze-qnx-machine-program-");
  await writeProject(join(directory, "input.toml"), {
    language: "typescript",
    source: "console.log(1 + 2);\n",
    target: QNX_TARGETS[0] as TargetSpec,
    output: "machine",
    backend: "machine",
    runtime: "none",
  });
  const outcome = await runBuild("input.toml", { cwd: directory, reuse: false }, quiet, "build");
  assert.equal(outcome.build.status, "success");
  assert.equal(outcome.build.backend, "machine");
  assert.equal(outcome.build.toolchain, "qcc-x86_64");
  const output = outcome.outputPath;
  assert.ok(output !== null);
  const inspection = run("file", [output], { timeoutMs: 30_000 });
  assert.match(inspection.stdout, /x86-64/);
  assert.match(inspection.stdout, /ldqnx/);
});

test("qcc builds and links the TLS HTTP runtime for both QNX targets", async (t) => {
  const qcc = run("qcc", ["-V"], { timeoutMs: 30_000 });
  if (qcc.spawnError !== undefined || qcc.code !== 0) {
    t.skip("qcc is not on PATH; source the QNX SDP environment to run this test");
    return;
  }
  if (process.env.QNX_TARGET === undefined || process.env.QNX_TARGET === "") {
    t.skip("QNX_TARGET is not set; source the QNX SDP environment to run this test");
    return;
  }

  for (const target of QNX_TARGETS) {
    const selector = target.arch === "x86_64" ? "gcc_ntox86_64" : "gcc_ntoaarch64le";
    const available = run("qcc", [`-V${selector}`, "--version"], { timeoutMs: 30_000 });
    if (available.spawnError !== undefined || available.code !== 0) {
      t.diagnostic(`qcc has no ${target.arch} compiler: ${available.stderr.trim()}`);
      continue;
    }

    const directory = await scratch(`blaze-qnx-tls-${target.arch}-`);
    const runtime = await buildFacilRuntime(directory, "debug", target, {
      maxConnections: 64,
      tls: true,
    });
    const main = join(directory, "main.c");
    await writeFile(
      main,
      'extern void *blaze_http_server_new_tls(const char *, unsigned short, const char *, const char *);\nint main(void) { return blaze_http_server_new_tls("127.0.0.1", 0, "cert", "key") == 0; }\n',
      "utf8",
    );
    const executable = join(directory, "tls-probe");
    const linked = run(
      "qcc",
      [
        `-V${selector}`,
        "-std=c11",
        "-Wl,--gc-sections",
        "-o",
        executable,
        main,
        runtime.objectPath,
        "-lm",
        "-pthread",
        "-lssl",
        "-lcrypto",
        "-lsocket",
      ],
      { timeoutMs: 120_000 },
    );
    assert.equal(linked.spawnError, undefined, `${target.arch}: ${linked.spawnError ?? ""}`);
    assert.equal(linked.code, 0, `${target.arch}: ${linked.stderr.trim()}`);
    assert.ok((await stat(executable)).size > 0, `${target.arch}: qcc linked the TLS runtime`);
  }
});

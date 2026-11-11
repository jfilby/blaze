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
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../core/process.ts";
import type { TargetSpec } from "../core/types.ts";
import { runtimeSourceSource } from "../runtime/abi.ts";
import { buildFacilRuntime } from "../runtime/facil.ts";
import { writeRuntimeHeader } from "../runtime/standalone.ts";
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

  for (const [architecture, selector] of QCC_ARCHITECTURES) {
    const available = run("qcc", [`-V${selector}`, "--version"], { timeoutMs: 30_000 });
    if (available.spawnError !== undefined || available.code !== 0) {
      t.diagnostic(`qcc has no ${architecture} compiler: ${available.stderr.trim()}`);
      continue;
    }

    const object = join(directory, `${architecture}-runtime.o`);
    const compiled = run(
      "qcc",
      [`-V${selector}`, "-std=c11", "-O0", "-pthread", "-c", "-o", object, source],
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

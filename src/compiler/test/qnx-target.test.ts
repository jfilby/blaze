/**
 * QNX target and toolchain selection.
 *
 * The target model decides whether a build may start; the toolchain profile
 * decides what it asks to do the work. Both are pure data, so they are tested
 * without a QNX machine and without compiling anything.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertBuildableTarget,
  cTargetOptions,
  normalizeTarget,
  targetSummary,
} from "../core/target.ts";
import {
  assembleCommand,
  candidateOptions,
  linkOptionsFor,
  relocatableLinkCommand,
  threadingOptionsFor,
  toolchainFor,
} from "../core/toolchain.ts";
import type { TargetSpec } from "../core/types.ts";
import { assertMachineTarget } from "../toolchain/ir-machine.ts";

const QNX_X86: TargetSpec = { arch: "x86_64", os: "qnx", abi: "sysv", cpu: "", features: [] };
const QNX_ARM: TargetSpec = { arch: "aarch64", os: "qnx", abi: "aapcs", cpu: "", features: [] };

test("a QNX target is normalized with the fields the build reads", () => {
  assert.deepEqual(
    normalizeTarget({ arch: "x86_64", os: "qnx", abi: "sysv" }),
    { arch: "x86_64", os: "qnx", abi: "sysv", cpu: "", features: [] },
  );
  assert.deepEqual(
    normalizeTarget({ arch: "AARCH64", os: "QNX", abi: "AAPCS", features: ["NEON"] } as unknown as Partial<TargetSpec>),
    { arch: "aarch64", os: "qnx", abi: "aapcs", cpu: "", features: ["neon"] },
  );
});

test("only the target combinations the backends can build are admitted", () => {
  assert.equal(assertBuildableTarget(QNX_X86), QNX_X86);
  assert.equal(assertBuildableTarget(QNX_ARM), QNX_ARM);

  assert.throws(
    () => assertBuildableTarget({ ...QNX_ARM, abi: "sysv" }),
    /aarch64\/qnx\/sysv/,
  );
  assert.throws(
    () => assertBuildableTarget({ ...QNX_X86, abi: "aapcs" }),
    /x86_64\/qnx\/aapcs/,
  );
  assert.throws(
    () => assertBuildableTarget({ arch: "aarch64", os: "linux", abi: "aapcs", cpu: "", features: [] }),
    /aarch64\/linux\/aapcs/,
  );
  assert.throws(
    () => assertBuildableTarget({ arch: "riscv64", os: "qnx", abi: "aapcs", cpu: "", features: [] }),
    /riscv64\/qnx\/aapcs/,
  );
});

test("a cross build does not ask the host compiler to tune for itself", () => {
  // A named cpu is a target decision and reaches the compiler. Without one,
  // `-mtune=native` would describe the build host, which is not the machine
  // the QNX binary runs on.
  assert.deepEqual(cTargetOptions({ ...QNX_X86, cpu: "znver1" }), ["-march=znver1"]);
  if ((process.platform as string) === "qnx") {
    assert.deepEqual(cTargetOptions(QNX_X86), ["-mtune=native"]);
  } else {
    assert.deepEqual(cTargetOptions(QNX_X86), []);
  }
  assert.equal(targetSummary(QNX_ARM), "aarch64/qnx/aapcs cpu=toolchain-default");
});

test("a Linux host selects qcc for both QNX architectures", () => {
  const x86 = toolchainFor(QNX_X86, "linux");
  assert.equal(x86.id, "qcc-x86_64");
  assert.equal(x86.cc, "qcc");
  assert.deepEqual(x86.ccArgs, ["-Vgcc_ntox86_64"]);
  assert.equal(x86.nm, "ntox86_64-nm");
  assert.equal(x86.size, "ntox86_64-size");
  assert.equal(x86.assembler, "driver");
  assert.equal(x86.relocatableLinker, "driver");

  const arm = toolchainFor(QNX_ARM, "linux");
  assert.equal(arm.id, "qcc-aarch64");
  assert.deepEqual(arm.ccArgs, ["-Vgcc_ntoaarch64le"]);
  assert.equal(arm.nm, "ntoaarch64le-nm");
  assert.equal(arm.size, "ntoaarch64le-size");
});

test("a QNX host selects clang for its own architecture", () => {
  const native = toolchainFor(QNX_X86, "qnx", "x64");
  assert.equal(native.id, "qnx-clang");
  assert.equal(native.cc, "clang");
  assert.deepEqual(native.ccArgs, []);
  assert.equal(native.assembler, "driver");
  assert.equal(native.relocatableLinker, "driver");
  assert.equal(native.supportsFatLto, false);
  assert.equal(native.supportsOpenMp, false);

  assert.throws(
    () => toolchainFor(QNX_ARM, "qnx", "x64"),
    /a QNX host builds x86_64 natively and cannot build aarch64/,
  );
});

test("a toolchain without fat LTO measures machine code, not an empty object", () => {
  const gcc = toolchainFor({ arch: "x86_64", os: "linux", abi: "sysv", cpu: "", features: [] }, "linux");
  assert.ok(candidateOptions(gcc, "release").includes("-flto"));
  assert.ok(candidateOptions(gcc, "release").includes("-ffat-lto-objects"));
  assert.ok(linkOptionsFor(gcc, "release").includes("-flto"));

  const clang = toolchainFor(QNX_X86, "qnx", "x64");
  assert.deepEqual(candidateOptions(clang, "release"), ["-O3", "-fno-math-errno", "-fno-trapping-math"]);
  assert.ok(linkOptionsFor(clang, "release").includes("-flto"));
});

test("OpenMP is refused rather than quietly serialized", () => {
  const gcc = toolchainFor({ arch: "x86_64", os: "linux", abi: "sysv", cpu: "", features: [] }, "linux");
  assert.deepEqual(threadingOptionsFor(gcc, ["openmp", "pthread"]), ["-fopenmp", "-pthread"]);

  const clang = toolchainFor(QNX_X86, "qnx", "x64");
  assert.throws(
    () => threadingOptionsFor(clang, ["openmp"]),
    /does not provide OpenMP/,
  );
  assert.deepEqual(threadingOptionsFor(clang, ["pthread"]), ["-pthread"]);
});

test("assembly and relocatable links follow the profile", () => {
  const gcc = toolchainFor({ arch: "x86_64", os: "linux", abi: "sysv", cpu: "", features: [] }, "linux");
  assert.deepEqual(assembleCommand(gcc, QNX_X86, "a.s", "a.o"), {
    command: "as",
    args: ["--64", "-o", "a.o", "a.s"],
  });
  assert.deepEqual(relocatableLinkCommand(gcc, "all.o", ["a.o", "b.o"]), {
    command: "ld",
    args: ["-r", "-o", "all.o", "a.o", "b.o"],
  });

  const qcc = toolchainFor(QNX_X86, "linux");
  assert.deepEqual(assembleCommand(qcc, QNX_X86, "a.s", "a.o"), {
    command: "qcc",
    args: ["-Vgcc_ntox86_64", "-c", "-o", "a.o", "a.s"],
  });
  assert.deepEqual(relocatableLinkCommand(qcc, "all.o", ["a.o"]), {
    command: "qcc",
    args: ["-Vgcc_ntox86_64", "-r", "-o", "all.o", "a.o"],
  });
});

test("the machine backend admits QNX x86-64 and refuses QNX AArch64", () => {
  // QNX x86-64 is System V AMD64, which is the one convention the machine
  // backend writes. AArch64 has a different convention and no encoder here,
  // so the refusal names it rather than writing code the linker would accept
  // and the machine would run wrongly.
  assert.doesNotThrow(() => assertMachineTarget(QNX_X86));
  assert.throws(
    () => assertMachineTarget(QNX_ARM),
    /the machine backend cannot build for aarch64-qnx-aapcs/,
  );
});

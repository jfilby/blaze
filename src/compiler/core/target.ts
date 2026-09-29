/**
 * Target handling.
 *
 * Target information is deliberately separate from the semantic contract: the
 * same contract compiles to different native code per target.
 *
 * Version 0.1 supports x86-64 / Linux / System V AMD64 only.
 */

import { CompilerError } from "./errors.ts";
import type { Arch, Abi, BuildMode, OsName, TargetSpec } from "./types.ts";

const ARCHES: readonly Arch[] = ["x86_64", "aarch64", "riscv64"];
const OPERATING_SYSTEMS: readonly OsName[] = ["linux"];
const ABIS: readonly Abi[] = ["sysv"];

export const DEFAULT_TARGET: TargetSpec = {
  arch: "x86_64",
  os: "linux",
  abi: "sysv",
  cpu: "",
  features: [],
};

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CompilerError({
      category: "TargetError",
      stage: "target",
      message: `target.${field} must be a non-empty string`,
      detail: `received ${JSON.stringify(value)}`,
    });
  }
  return value;
}

function requireMember<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  const text = requireString(value, field);
  const match = allowed.find((entry) => entry === text.toLowerCase());
  if (match === undefined) {
    throw new CompilerError({
      category: "TargetError",
      stage: "target",
      message: `unsupported target.${field} "${text}"`,
      detail: `supported: ${allowed.join(", ")}`,
    });
  }
  return match;
}

/**
 * Fills in defaults and validates a partial target from the input file.
 */
export function normalizeTarget(partial: Partial<TargetSpec> | undefined): TargetSpec {
  if (partial === undefined) return { ...DEFAULT_TARGET };

  const features = partial.features ?? [];
  if (!Array.isArray(features) || features.some((feature) => typeof feature !== "string")) {
    throw new CompilerError({
      category: "TargetError",
      stage: "target",
      message: "target.features must be an array of strings",
    });
  }

  // An empty cpu means "whatever the toolchain defaults to".
  if (partial.cpu !== undefined && typeof partial.cpu !== "string") {
    throw new CompilerError({
      category: "TargetError",
      stage: "target",
      message: "target.cpu must be a string",
      detail: `received ${JSON.stringify(partial.cpu)}`,
    });
  }
  const cpu = partial.cpu ?? "";
  if (cpu !== "" && !/^[A-Za-z0-9_.-]+$/.test(cpu)) {
    throw new CompilerError({
      category: "TargetError",
      stage: "target",
      message: `target.cpu "${cpu}" is not a valid assembler architecture selector`,
    });
  }

  return {
    arch: partial.arch === undefined ? DEFAULT_TARGET.arch : requireMember(partial.arch, ARCHES, "arch"),
    os: partial.os === undefined ? DEFAULT_TARGET.os : requireMember(partial.os, OPERATING_SYSTEMS, "os"),
    abi: partial.abi === undefined ? DEFAULT_TARGET.abi : requireMember(partial.abi, ABIS, "abi"),
    cpu,
    features: [...features].map((feature) => feature.toLowerCase()),
  };
}

/**
 * Rejects targets this compiler version cannot build for. The failure is
 * explicit instead of producing assembly for the wrong machine.
 */
export function assertBuildableTarget(target: TargetSpec, functionName?: string): TargetSpec {
  const unsupported: string[] = [];
  if (target.arch !== "x86_64") unsupported.push(`arch ${target.arch}`);
  if (target.os !== "linux") unsupported.push(`os ${target.os}`);
  if (target.abi !== "sysv") unsupported.push(`abi ${target.abi}`);

  if (unsupported.length > 0) {
    throw new CompilerError({
      category: "TargetError",
      stage: "target",
      message: `version 0.1 builds x86_64/linux/sysv only (got ${unsupported.join(", ")})`,
      function: functionName,
    });
  }
  return target;
}

/**
 * The suffix an executable carries on the machine that writes it. Windows
 * appends `.exe`; every other platform names a binary after the program, so
 * the host is asked rather than assumed. The host is what matters here: the
 * `gcc` and `nim` that write these files are the host's.
 */
export const EXECUTABLE_SUFFIX = process.platform === "win32" ? ".exe" : "";

/**
 * The assembler options a target's cpu asks for, empty when the toolchain
 * default applies.
 *
 * The x86 assembler takes the machine it is to emit for as a command line
 * option, `-march=<cpu>`. `.arch` is the ARM and AArch64 pseudo-op, and the
 * x86 assembler reads it as the architecture named `x86`, so every build of a
 * project that set a cpu failed in the assembler with `no such architecture`.
 */
export function archOptions(target: TargetSpec): string[] {
  return target.cpu === "" ? [] : [`-march=${target.cpu}`];
}

/**
 * The C compiler options a build mode asks for.
 *
 * `-fno-lto` is on every one of them and not only the release ones: link-time
 * optimization would make the object a candidate is measured from depend on
 * every other object beside it, so the assembly a build delivers and the
 * object it links would no longer be the same program. A build measures
 * candidates against each other, and that comparison is only a comparison when
 * each one was made on its own.
 *
 * `-g` is only in `debug`, and `-O0` with it, because a program to step
 * through is a program the compiler has not rearranged. `release` and
 * `danger` ask for `-O2`, which is where the C compiler optimizes without
 * turning on the loop transformations: those are worth less on a program
 * whose loops the IR already unrolled, and they cost code size in a runtime
 * that is measured.
 */
export function optimizationOptions(mode: BuildMode): string[] {
  if (mode === "debug") return ["-O0", "-g", "-fno-lto"];
  return ["-O2", "-fno-lto"];
}

/**
 * The Nim compiler options a build mode asks for.
 *
 * Nim spells its own three build profiles as defines, so the mode is the
 * define and nothing else is spelled out: `debug` is the profile that leaves
 * the checks in and adds no optimization, which is what `-O0` is, and
 * `release` and `danger` are the profiles that optimize without them. `-g` has
 * no profile, so `debug` asks for `--debuginfo` beside it: a program to step
 * through is a program the compiler has not rearranged, the same rule the C
 * options follow.
 */
export function nimOptimizationOptions(mode: BuildMode): string[] {
  if (mode === "debug") return ["-d:debug", "--debuginfo"];
  if (mode === "danger") return ["-d:danger"];
  return ["-d:release"];
}

export function targetSummary(target: TargetSpec): string {
  const features = target.features.length > 0 ? ` features=[${target.features.join(",")}]` : "";
  const cpu = target.cpu === "" ? "toolchain-default" : target.cpu;
  return `${target.arch}/${target.os}/${target.abi} cpu=${cpu}${features}`;
}

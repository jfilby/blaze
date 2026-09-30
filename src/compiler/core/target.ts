/**
 * Target handling.
 *
 * Target information is deliberately separate from the semantic contract: the
 * same contract compiles to different native code per target.
 *
 * Version 0.1 supports x86-64 / Linux / System V AMD64 only.
 */

import { CompilerError } from "./errors.ts";
import type { Arch, Abi, BuildMode, Objective, OsName, TargetSpec } from "./types.ts";

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
 * The C compiler options the C backend asks for, in three parts.
 *
 * `-g` is only in `debug`, and `-O0` with it, because a program to step
 * through is a program the compiler has not rearranged.
 *
 * `release` and `danger` ask for `-O3`: the loop transformations, the wider
 * inlining set and the vectorizer are all on. The comment this replaces held
 * that `-O2` was chosen because the loop transforms "are worth less on a
 * program whose loops the IR already unrolled", and no pass unrolls anything —
 * `REPAIR_RULES` in `semantics/repair.ts` is the four rules that exist. The
 * cost that comment described is real, though: `-O3` does make code bigger, and
 * a contract whose primary objective is `size` is asking for the opposite. So
 * `size` asks for `-O2` instead. The candidates of one function are all built
 * the same way and so still rank the same; what changes is the program that is
 * delivered, which is the one the objective names.
 *
 * The two floating-point flags are the ones that change no computed value.
 * `-fno-math-errno` drops the promise that a maths call sets `errno`, and
 * `-fno-trapping-math` says the program has no floating-point operand that can
 * trap; between them they let the compiler emit `floor` and `pow` as
 * instructions rather than calls. `-ffast-math` is deliberately absent: the
 * generated `min` and `max` propagate NaN and preserve signed zero by hand and
 * the NaN truth test does the same, so a fast-math build would not deliver the
 * semantics the IR states.
 */
function optimizationLevel(mode: BuildMode, objective?: Objective): string[] {
  if (mode === "debug") return ["-O0", "-g"];
  if (objective === "size") return ["-O2"];
  return ["-O3", "-fno-math-errno", "-fno-trapping-math"];
}

/**
 * The options one candidate is compiled with.
 *
 * A candidate is measured against the other candidates of the same function,
 * and that comparison is only a comparison when each object was made on its
 * own. Plain `-flto` would break it twice over: the object would no longer
 * carry code at all until something linked it, so a size that weighed
 * `textSizeBytes` would weigh nothing, and one candidate's result would depend
 * on the objects beside it.
 *
 * `-ffat-lto-objects` is what makes the two goals compatible, and it is a real
 * option rather than a hope: an object compiled with it is byte-for-byte the
 * same size in `.text` as one compiled without, and carries the compiler's
 * intermediate form beside that code for a link that asks to use it. The
 * candidate stays a self-contained object that can be measured, verified and
 * delivered on its own, and the delivered program is still linked with
 * everything in front of it.
 *
 * `debug` asks for neither flag. A program to step through is a program the
 * compiler has not rearranged, and the intermediate form is the compiler's
 * most rearranged output there is.
 */
export function optimizationOptions(mode: BuildMode, objective?: Objective): string[] {
  const level = optimizationLevel(mode, objective);
  return mode === "debug" ? level : [...level, "-flto", "-ffat-lto-objects"];
}

/**
 * The options a function the C backend lowered from IR itself is compiled
 * with, which is the link-grade list and not the candidate one.
 *
 * `-ffat-lto-objects` exists so a candidate can be measured on its own, and a
 * function the compiler lowered is never ranked against a sibling: it is the
 * one lowering of an IR that was already chosen, and the build links it once
 * with everything in front of it. The flag buys that measurement nothing here
 * and costs a copy of the compiler's intermediate form in every object the
 * build makes — a section the object carries and `sizeBytes` counts, for code
 * the linker is about to throw away and regenerate.
 */
export function loweringOptions(mode: BuildMode, objective?: Objective): string[] {
  const level = optimizationLevel(mode, objective);
  return mode === "debug" ? level : [...level, "-flto"];
}

/**
 * The options the C compiler is asked to stop at assembly with, which is the
 * level and the floating-point flags and no `-flto`.
 *
 * Under link-time optimization `-S` writes the compiler's intermediate form
 * rather than machine code, so a build that asked for the assembly under
 * `-flto` delivered a dump of what was about to be handed to the linker, and
 * weighed that dump as the size of the program.
 */
export function assemblyOptions(mode: BuildMode, objective?: Objective): string[] {
  return optimizationLevel(mode, objective);
}

/**
 * The options the delivered program is linked with.
 *
 * The same level, the same floating-point flags, and `-flto`. Each function is
 * its own object and every callee is declared but not defined, so a program
 * linked without link-time optimization cannot inline one function into
 * another at all, and the runtime entry points a candidate calls across that
 * boundary stay calls. This link runs once, after a candidate has been chosen,
 * and there is no second candidate to compare it against, which is the whole
 * reason the flag is off a candidate's own compile and on here.
 *
 * It is the list `loweringOptions` hands the C backend for the objects it
 * lowers itself, and the two are the same on purpose: with `-flto` on this
 * command gcc rebuilds every object in front of it with the options of the
 * link, so a link at a different level undoes the level the objects were
 * compiled at.
 */
export function linkOptions(mode: BuildMode, objective?: Objective): string[] {
  return loweringOptions(mode, objective);
}

/**
 * The options the C compiler is asked to target.
 *
 * A named cpu fixes the instruction set, which is a decision about what the
 * delivered program may be assumed to run on. An empty one leaves the
 * instruction set at the toolchain's baseline, so the portable answer is the
 * one already given, and the one thing still worth asking for is scheduling:
 * `-mtune` picks the pipelines and the branch costs of the machine the build
 * runs on and cannot emit an instruction the baseline does not have. It does
 * make the object specific to that machine's microarchitecture, so a stored
 * object tuned on one host is tuned for the wrong one on another. That costs
 * speed and never correctness, which is why it is the default and a named cpu
 * is not.
 */
export function cTargetOptions(target: TargetSpec): string[] {
  if (target.cpu !== "") return [`-march=${target.cpu}`];
  return ["-mtune=native"];
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

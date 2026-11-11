/**
 * Toolchain selection.
 *
 * A build asks a C compiler, an assembler and a linker to make what it
 * delivers. Which programs those are is a property of the target and of the
 * machine the build runs on, not a name written into every call site: a Linux
 * build uses the host compiler, a Linux host builds QNX with the QNX cross
 * compiler, and a QNX host uses its own clang.
 *
 * The profile is deliberately small. It names the programs, the arguments the
 * driver needs before the work, and the capabilities a build has to know
 * before it asks for a flag: LTO, fat LTO, OpenMP, and whether assembly and a
 * relocatable link go through a separate tool. Everything else stays a
 * function of the target (see core/target.ts).
 */

import { CompilerError } from "./errors.ts";
import { hostArchitecture as defaultHostArchitecture, hostPlatform } from "./platform.ts";
import { archOptions, loweringOptions, optimizationOptions, threadingOptions, type Threading } from "./target.ts";
import type { Arch, BuildMode, Objective, TargetSpec } from "./types.ts";

export interface Toolchain {
  /** Stable name for the build record and the cache key. */
  readonly id: string;
  /** The compiler driver. */
  readonly cc: string;
  /** Arguments the driver needs before any other, such as qcc's `-V`. */
  readonly ccArgs: readonly string[];
  /** Whether assembly is a separate program or the driver's own input. */
  readonly assembler: "as" | "driver";
  /** Whether a relocatable link is a separate linker or the driver's `-r`. */
  readonly relocatableLinker: "ld" | "driver";
  /** The object inspector, and the size reader. */
  readonly nm: string;
  readonly size: string;
  readonly supportsLto: boolean;
  readonly supportsFatLto: boolean;
  readonly supportsOpenMp: boolean;
  /** Whether the linker collects sections no symbol reaches. */
  readonly supportsGcSections: boolean;
}

/** The Linux host compiler. */
const GCC: Toolchain = {
  id: "gcc",
  cc: "gcc",
  ccArgs: [],
  assembler: "as",
  relocatableLinker: "ld",
  nm: "nm",
  size: "size",
  supportsLto: true,
  supportsFatLto: true,
  supportsOpenMp: true,
  supportsGcSections: true,
};

/** The QNX self-hosted C/C++ toolchain. */
const QNX_CLANG: Toolchain = {
  id: "qnx-clang",
  cc: "clang",
  ccArgs: [],
  assembler: "driver",
  relocatableLinker: "driver",
  nm: "nm",
  size: "size",
  supportsLto: true,
  // Fat LTO is not assumed on the QNX desktop. A candidate is measured without
  // it rather than carrying an object whose `.text` is empty.
  supportsFatLto: false,
  // libomp is not assumed to exist on a QNX image; a C backend parallel loop
  // asks for it and fails clearly if it is not there.
  supportsOpenMp: false,
  // lld's `--gc-sections` is the same option the Linux link uses.
  supportsGcSections: true,
};

/** The QNX cross compiler, selected by qcc's `-V` target. */
function qcc(target: TargetSpec): Toolchain {
  const selector =
    target.arch === "x86_64"
      ? "gcc_ntox86_64"
      : target.arch === "aarch64"
        ? "gcc_ntoaarch64le"
        : undefined;
  if (selector === undefined) {
    throw new CompilerError({
      category: "TargetError",
      stage: "target",
      message: `QNX has no cross compiler selected for ${target.arch}`,
    });
  }
  const prefix = target.arch === "x86_64" ? "ntox86_64" : "ntoaarch64le";
  return {
    id: `qcc-${target.arch}`,
    cc: "qcc",
    ccArgs: [`-V${selector}`],
    assembler: "driver",
    relocatableLinker: "driver",
    nm: `${prefix}-nm`,
    size: `${prefix}-size`,
    supportsLto: true,
    supportsFatLto: true,
    supportsOpenMp: true,
    // The QNX cross linker is GNU ld, which reads the same section collection
    // option the Linux link passes.
    supportsGcSections: true,
  };
}

function normalizedArch(arch: string): Arch | undefined {
  switch (arch) {
    case "x64":
    case "x86_64":
      return "x86_64";
    case "arm64":
    case "aarch64":
      return "aarch64";
    case "riscv64":
      return "riscv64";
    default:
      return undefined;
  }
}

/**
 * The toolchain a target is built with.
 *
 * `host` and `hostArchitecture` are passed in so a test can ask what a QNX
 * host would select without pretending this process is that host. A build
 * passes the process it is running on.
 */
export function toolchainFor(
  target: TargetSpec,
  host: string = hostPlatform(),
  hostArchitecture: string = defaultHostArchitecture(),
): Toolchain {
  if (target.os === "linux") return GCC;
  if (target.os !== "qnx") {
    throw new CompilerError({
      category: "TargetError",
      stage: "target",
      message: `no toolchain is selected for ${target.os}`,
    });
  }

  if (host === "qnx") {
    // The QNX desktop's clang is native: it builds the architecture it runs
    // on. A cross build is the Linux-hosted qcc command instead.
    const native = normalizedArch(hostArchitecture);
    if (native !== undefined && native !== target.arch) {
      throw new CompilerError({
        category: "TargetError",
        stage: "target",
        message: `a QNX host builds ${native} natively and cannot build ${target.arch}`,
        detail: "cross-build the other architecture from a Linux host with qcc",
      });
    }
    return QNX_CLANG;
  }

  return qcc(target);
}

/** The driver and its arguments, before the work arguments. */
export function compileCommand(
  toolchain: Toolchain,
  args: readonly string[],
): { command: string; args: string[] } {
  return { command: toolchain.cc, args: [...toolchain.ccArgs, ...args] };
}

/**
 * The command that turns an assembly file into an object.
 *
 * A separate GNU assembler is used where the build has always used one. A
 * profile without one hands the assembly back to its compiler driver, which
 * selects the target's assembler itself.
 */
export function assembleCommand(
  toolchain: Toolchain,
  target: TargetSpec,
  assemblyPath: string,
  objectPath: string,
): { command: string; args: string[] } {
  if (toolchain.assembler === "as") {
    return {
      command: "as",
      args: [
        ...(target.arch === "x86_64" ? ["--64"] : []),
        ...archOptions(target),
        "-o",
        objectPath,
        assemblyPath,
      ],
    };
  }
  return {
    command: toolchain.cc,
    args: [
      ...toolchain.ccArgs,
      ...archOptions(target),
      "-c",
      "-o",
      objectPath,
      assemblyPath,
    ],
  };
}

/**
 * The command that asks the assembler whether it knows the target's cpu.
 *
 * The probe reads assembly from standard input and writes no object, so it is
 * the assembler's own input rather than a file. A profile with a separate
 * assembler names the program here; a profile that assembles through its
 * compiler driver asks the driver.
 */
export function assemblerProbeCommand(
  toolchain: Toolchain,
  target: TargetSpec,
): { command: string; args: string[] } {
  if (toolchain.assembler === "as") {
    return {
      command: "as",
      args: [
        ...(target.arch === "x86_64" ? ["--64"] : []),
        ...archOptions(target),
        "-o",
        "/dev/null",
        "-",
      ],
    };
  }
  return compileCommand(toolchain, [
    "-x",
    "assembler",
    "-c",
    ...archOptions(target),
    "-o",
    "/dev/null",
    "-",
  ]);
}

/** The command that bundles objects into one relocatable object. */
export function relocatableLinkCommand(
  toolchain: Toolchain,
  outputPath: string,
  inputs: readonly string[],
): { command: string; args: string[] } {
  if (toolchain.relocatableLinker === "ld") {
    return { command: "ld", args: ["-r", "-o", outputPath, ...inputs] };
  }
  return {
    command: toolchain.cc,
    args: [...toolchain.ccArgs, "-r", "-o", outputPath, ...inputs],
  };
}

/**
 * The options a self-contained candidate object is compiled with.
 *
 * A toolchain without fat LTO cannot both keep machine code in the object and
 * ask for LTO, so it gets neither: the candidate's size is measured on the
 * code it carries.
 */
export function candidateOptions(
  toolchain: Toolchain,
  mode: BuildMode,
  objective?: Objective,
): string[] {
  const options = optimizationOptions(mode, objective);
  if (toolchain.supportsFatLto) return options;
  return options.filter((option) => option !== "-flto" && option !== "-ffat-lto-objects");
}

/** The options for an object that is linked, not measured on its own. */
export function objectOptions(
  toolchain: Toolchain,
  mode: BuildMode,
  objective?: Objective,
): string[] {
  return candidateOptions(toolchain, mode, objective);
}

/** The options for an object the compiler lowered itself. */
export function loweringOptionsFor(
  toolchain: Toolchain,
  mode: BuildMode,
  objective?: Objective,
): string[] {
  const options = loweringOptions(mode, objective);
  return toolchain.supportsLto ? options : options.filter((option) => option !== "-flto");
}

/**
 * The options a delivered program is linked with.
 *
 * Section collection is a link capability rather than a flag every linker is
 * assumed to read. The C runtime is compiled one function per section, so a
 * linker that collects the unreached ones drops the runtime a program never
 * calls; a linker that does not support the option is asked for nothing and
 * carries the whole runtime instead.
 */
export function linkOptionsFor(
  toolchain: Toolchain,
  mode: BuildMode,
  objective?: Objective,
): string[] {
  const options = loweringOptionsFor(toolchain, mode, objective);
  return toolchain.supportsGcSections ? [...options, "-Wl,--gc-sections"] : options;
}

/**
 * The threading options a profile can serve.
 *
 * A C backend parallel loop is an OpenMP pragma, so a profile without an
 * OpenMP runtime cannot silently drop the flag: the loop would still be
 * correct and would run on one thread, which is not what the build said it
 * built. It is refused here instead.
 */
export function threadingOptionsFor(
  toolchain: Toolchain,
  threading: readonly Threading[],
): string[] {
  if (threading.includes("openmp") && !toolchain.supportsOpenMp) {
    throw new CompilerError({
      category: "TargetError",
      stage: "compile",
      message: `the ${toolchain.id} toolchain does not provide OpenMP`,
      detail: "build the function with the machine backend, or use a toolchain that has an OpenMP runtime",
    });
  }
  return threadingOptions(threading);
}

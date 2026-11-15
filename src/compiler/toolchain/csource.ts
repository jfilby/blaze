/**
 * C implementations.
 *
 * A `c` build asks the model for C instead of assembly. The C source is
 * untrusted in exactly the same way: it is compiled to an object file, and the
 * object must define exactly the contracted symbol and reference nothing at
 * all. That rules out library calls, file access and a second `main`, without
 * the compiler having to understand C.
 */

import { stat, writeFile } from "../core/platform.ts";
import { inspectObject } from "./assembler.ts";
import { cDeclarationType } from "./linker.ts";
import { parseType, symbolOf } from "../semantics/contract.ts";
import { cSymbolLabel, cSymbolName } from "./c-names.ts";
import { CompilerError } from "../core/errors.ts";
import { run } from "../core/process.ts";
import type { BuildMode, FunctionContract, TargetSpec } from "../core/types.ts";
import { RUNTIME_NAME } from "../runtime/abi.ts";
import { isRuntimeSymbol } from "../runtime/symbols.ts";
import { cTargetOptions } from "../core/target.ts";
import { candidateOptions, compileCommand, toolchainForTarget } from "../core/toolchain.ts";

function fieldOf(value: unknown, key: string): any {
  return (value as Record<string, unknown>)[key];
}

/** Told to the model verbatim, so the rules live in one place. */
export const cSourceRules = [
  `The only preprocessor lines allowed are #include <stddef.h>, #include <stdint.h> and #include "${RUNTIME_NAME}.h"; every other directive is rejected.`,
  // C reads `a || b` as a condition, where the source language reads it as a
  // value: the same expression written in C has to choose the same value.
  "A logical operator in the body is a value, not a condition: write `a || b` as `(a != 0 ? a : b)` and `a && b` as `(a != 0 ? b : a)`, and a comparison as the 1 or 0 it is.",
  "A conditional expression in the body is written as the C conditional it is, and `!x` as `(x == 0)`.",
].join("\n");

/** The only preprocessor input a candidate may use. */
const ALLOWED_INCLUDES = [
  "#include <stddef.h>",
  "#include <stdint.h>",
  `#include "${RUNTIME_NAME}.h"`,
];

const FORBIDDEN_TOKENS = [
  "__attribute__",
  "__builtin_",
  "__declspec",
  "_Pragma",
  "#pragma",
  "#import",
  "#embed",
];

/**
 * The spellings of inline assembly, whichever way they are punctuated: `asm`,
 * `__asm` and `__asm__` are the same keyword to the C compiler, and it takes
 * whitespace between the keyword and its parenthesis. A scan for `asm(` alone
 * let `asm ("mov %0, %1", ...)` reach the compiler, which is the one thing this
 * subset exists to keep out.
 */
const INLINE_ASSEMBLY: RegExp = /\b(?:__)?asm(?:__)?(?:\s+(?:__)?volatile(?:__)?)?\s*[("]/;

function cError(message: string, detail: string | undefined, functionName: string, candidate?: string): CompilerError {
  return new CompilerError("AssemblyError", "compile", message, detail, functionName, candidate, "");
}

export function cSignature(contract: FunctionContract): string {
  const signature = fieldOf(contract, "function");
  const parameters = (fieldOf(signature, "params") as readonly { readonly type: string; readonly name: string }[])
    .map((param) => `${cDeclarationType(parseType(String(fieldOf(param, "type"))))} ${String(fieldOf(param, "name"))}`)
    .join(", ");
  return `${cDeclarationType(parseType(String(fieldOf(signature, "returns"))))} ${cSymbolName(symbolOf(contract))}(${parameters})${cSymbolLabel(symbolOf(contract))}`;
}

/** Rejects anything outside the pure subset before the compiler is invoked. */
export function validateCSource(source: string, contract: FunctionContract, candidate?: string): void {
  const functionName = symbolOf(contract);
  if (source.trim() === "") {
    throw cError("the candidate contains no C source", undefined, functionName, candidate);
  }

  const problems: string[] = [];
  source.split(/\r?\n/).forEach((raw, offset) => {
    const line = raw.trim();
    if (line === "") return;
    if (line.startsWith("#")) {
      if (!ALLOWED_INCLUDES.includes(line)) {
        problems.push(`line ${offset + 1}: preprocessor directive "${line}" is not allowed`);
      }
      return;
    }
    if (line.startsWith("//") || line.startsWith("/*") || line.startsWith("*")) return;
    if (INLINE_ASSEMBLY.test(line)) {
      problems.push(`line ${offset + 1}: inline assembly is not allowed, the function must be pure C`);
    }
    for (const token of FORBIDDEN_TOKENS) {
      if (line.includes(token)) {
        problems.push(`line ${offset + 1}: "${token}" is not allowed, the function must be pure C`);
      }
    }
  });

  if (problems.length > 0) {
    throw cError(
      `the C candidate for ${functionName} violates the contract`,
      problems.join("\n"),
      functionName,
      candidate,
    );
  }
}

export interface CompileCRequest {
  source: string;
  contract: FunctionContract;
  /** How the C compiler is asked to build, from the project's mode. */
  mode: BuildMode;
  target: TargetSpec;
  sourcePath: string;
  objectPath: string;
  candidate?: string;
  /** Directories the candidate includes the runtime header from. */
  includeDirectories?: string[];
}

export interface CompileCResult {
  sourcePath: string;
  objectPath: string;
  objectSizeBytes: number;
  textSizeBytes: number;
}

export async function compileC(request: CompileCRequest): Promise<CompileCResult> {
  const contract = fieldOf(request, "contract") as FunctionContract;
  const functionName = symbolOf(contract);
  const source = String(fieldOf(request, "source"));
  const sourcePath = String(fieldOf(request, "sourcePath"));
  const objectPath = String(fieldOf(request, "objectPath"));
  const candidate = fieldOf(request, "candidate") as string | undefined;
  validateCSource(source, contract, candidate);
  await writeFile(sourcePath, source, "utf8");

  const target = fieldOf(request, "target") as TargetSpec;
  const toolchain = toolchainForTarget(target);
  const archFlag = cTargetOptions(target);
  // A C candidate includes the runtime header by name, and a build keeps the
  // runtime beside the work directory rather than beside every candidate.
  const includeDirectories = (fieldOf(request, "includeDirectories") as readonly string[] | undefined) ?? [];
  const includes = includeDirectories.flatMap((directory) => [`-I`, directory]);
  const command = compileCommand(toolchain, [
    "-std=c11",
    ...candidateOptions(toolchain, fieldOf(request, "mode") as BuildMode, fieldOf(fieldOf(contract, "optimize"), "primary")),
    "-c",
    ...archFlag,
    ...includes,
    "-o",
    objectPath,
    sourcePath,
  ]);
  const compiled = run(String(fieldOf(command, "command")), fieldOf(command, "args") as readonly string[], { timeoutMs: 120_000 });
  if (fieldOf(compiled, "spawnError") !== undefined) {
    throw new CompilerError("TargetError", "compile", "the C compiler is not available", String(fieldOf(compiled, "spawnError")), "", "", "");
  }
  const exitCode = fieldOf(compiled, "code") as number | null;
  if (exitCode !== 0) {
    throw cError(
      `the C compiler rejected the candidate for ${functionName}`,
      `${sourcePath}\n${String(fieldOf(compiled, "stderr")).trim()}`,
      functionName,
      candidate,
    );
  }

  const info = inspectObject(objectPath, functionName, candidate, toolchain);
  const defined = fieldOf(info, "defined") as readonly string[];
  if (defined.length !== 1 || String(defined[0]) !== functionName) {
    throw cError(
      `the C object defines [${defined.join(", ")}] instead of only "${functionName}"`,
      `the candidate must define exactly: ${cSignature(contract)}`,
      functionName,
      candidate,
    );
  }
  const unresolved = (fieldOf(info, "undefined") as readonly string[]).filter((symbol) => !isRuntimeSymbol(symbol));
  if (unresolved.length > 0) {
    throw cError(
      `the C candidate calls outside the runtime ABI: ${unresolved.join(", ")}`,
      "the function may call the runtime ABI and nothing else: no library calls, no syscalls, no I/O",
      functionName,
      candidate,
    );
  }

  const stats = await stat(objectPath);
  return {
    sourcePath,
    objectPath,
    objectSizeBytes: Number(fieldOf(stats, "size")),
    textSizeBytes: Number(fieldOf(info, "textSizeBytes")),
  };
}

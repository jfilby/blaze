/**
 * C implementations.
 *
 * A `c` build asks the model for C instead of assembly. The C source is
 * untrusted in exactly the same way: it is compiled to an object file, and the
 * object must define exactly the contracted symbol and reference nothing at
 * all. That rules out library calls, file access and a second `main`, without
 * the compiler having to understand C.
 */

import { stat, writeFile } from "node:fs/promises";
import { inspectObject } from "./assembler.ts";
import { cDeclarationType } from "./linker.ts";
import { parseType, symbolOf } from "../semantics/contract.ts";
import { cSymbolLabel, cSymbolName } from "./c-names.ts";
import { CompilerError } from "../core/errors.ts";
import { run } from "../core/process.ts";
import type { BuildMode, FunctionContract, TargetSpec } from "../core/types.ts";
import { isRuntimeSymbol, RUNTIME_NAME } from "../runtime/abi.ts";
import { cTargetOptions, optimizationOptions } from "../core/target.ts";

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
  "__asm__",
  "__attribute__",
  "__builtin_",
  "__declspec",
  "asm(",
  "_Pragma",
  "#pragma",
  "#import",
  "#embed",
];

function cError(message: string, detail: string | undefined, functionName: string, candidate?: string): CompilerError {
  return new CompilerError({
    category: "AssemblyError",
    stage: "compile",
    message,
    function: functionName,
    candidate,
    detail,
  });
}

export function cSignature(contract: FunctionContract): string {
  const parameters = contract.function.params
    .map((param) => `${cDeclarationType(parseType(param.type))} ${param.name}`)
    .join(", ");
  return `${cDeclarationType(parseType(contract.function.returns))} ${cSymbolName(symbolOf(contract))}(${parameters})${cSymbolLabel(symbolOf(contract))}`;
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
  const functionName = symbolOf(request.contract);
  validateCSource(request.source, request.contract, request.candidate);
  await writeFile(request.sourcePath, request.source, "utf8");

  const archFlag = cTargetOptions(request.target);
  // A C candidate includes the runtime header by name, and a build keeps the
  // runtime beside the work directory rather than beside every candidate.
  const includes = (request.includeDirectories ?? []).flatMap((directory) => [`-I`, directory]);
  const compiled = run(
    "gcc",
    ["-std=c11", ...optimizationOptions(request.mode, request.contract.optimize.primary), "-c", ...archFlag, ...includes, "-o", request.objectPath, request.sourcePath],
    { timeoutMs: 120_000 },
  );
  if (compiled.spawnError !== undefined) {
    throw new CompilerError({
      category: "TargetError",
      stage: "compile",
      message: "the C compiler is not available",
      detail: compiled.spawnError,
    });
  }
  if (compiled.code !== 0) {
    throw cError(
      `the C compiler rejected the candidate for ${functionName}`,
      `${request.sourcePath}\n${compiled.stderr.trim()}`,
      functionName,
      request.candidate,
    );
  }

  const info = inspectObject(request.objectPath, functionName, request.candidate);
  if (info.defined.length !== 1 || info.defined[0] !== functionName) {
    throw cError(
      `the C object defines [${info.defined.join(", ")}] instead of only "${functionName}"`,
      `the candidate must define exactly: ${cSignature(request.contract)}`,
      functionName,
      request.candidate,
    );
  }
  const unresolved = info.undefined.filter((symbol) => !isRuntimeSymbol(symbol));
  if (unresolved.length > 0) {
    throw cError(
      `the C candidate calls outside the runtime ABI: ${unresolved.join(", ")}`,
      "the function may call the runtime ABI and nothing else: no library calls, no syscalls, no I/O",
      functionName,
      request.candidate,
    );
  }

  return {
    sourcePath: request.sourcePath,
    objectPath: request.objectPath,
    objectSizeBytes: (await stat(request.objectPath)).size,
    textSizeBytes: info.textSizeBytes,
  };
}

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
import { parseType } from "../semantics/contract.ts";
import { CompilerError } from "../core/errors.ts";
import { run } from "../core/process.ts";
import type { FunctionContract, TargetSpec } from "../core/types.ts";
import { isRuntimeSymbol, RUNTIME_NAME } from "../runtime/abi.ts";

/** Told to the model verbatim, so the rules live in one place. */
export const cSourceRules =
  `The only preprocessor lines allowed are #include <stddef.h>, #include <stdint.h> and #include "${RUNTIME_NAME}.h"; every other directive is rejected.`;

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
  return `${cDeclarationType(parseType(contract.function.returns))} ${contract.function.name}(${parameters})`;
}

/** Rejects anything outside the pure subset before the compiler is invoked. */
export function validateCSource(source: string, contract: FunctionContract, candidate?: string): void {
  const functionName = contract.function.name;
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
  const functionName = request.contract.function.name;
  validateCSource(request.source, request.contract, request.candidate);
  await writeFile(request.sourcePath, request.source, "utf8");

  const archFlag = request.target.cpu === "" ? [] : [`-march=${request.target.cpu}`];
  // A C candidate includes the runtime header by name, and a build keeps the
  // runtime beside the work directory rather than beside every candidate.
  const includes = (request.includeDirectories ?? []).flatMap((directory) => [`-I`, directory]);
  const compiled = run(
    "gcc",
    ["-std=c11", "-O2", "-fno-lto", "-c", ...archFlag, ...includes, "-o", request.objectPath, request.sourcePath],
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

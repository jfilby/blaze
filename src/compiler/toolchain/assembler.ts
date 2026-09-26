/**
 * Assembly validation and machine code generation.
 *
 * Model output is untrusted. Before it reaches the assembler it is checked
 * structurally: only the contracted function may be defined, no other symbol
 * may be referenced, no directive may change the architecture or pull in
 * another file, and no system interface may be used. The architecture prelude
 * is compiler-controlled, so a candidate cannot silently target a different
 * machine than the contract asks for.
 *
 * After assembling, the object is checked again: it must define exactly the
 * contracted symbol and leave nothing undefined.
 */

import { stat, writeFile } from "node:fs/promises";
import { archDirective } from "../core/target.ts";
import { CompilerError } from "../core/errors.ts";
import { run } from "../core/process.ts";
import type { FunctionContract, TargetSpec } from "../core/types.ts";
import { isRuntimeSymbol } from "../runtime/abi.ts";
import { symbolOf } from "../semantics/contract.ts";

const ALLOWED_DIRECTIVES = new Set([
  ".text",
  ".globl",
  ".global",
  ".type",
  ".size",
  ".p2align",
  ".align",
  ".balign",
  ".hidden",
  ".section",
  ".ident",
]);

/** Instructions that would let a candidate leave the sandboxed contract. */
const FORBIDDEN_MNEMONICS = new Set([
  "syscall",
  "sysenter",
  "sysexit",
  "int",
  "int3",
  "iret",
  "iretq",
  "cli",
  "sti",
  "hlt",
  "invlpg",
  "wbinvd",
  "invd",
  "vmcall",
  "vmmcall",
  "xsetbv",
]);

const SYMBOL = /^[A-Za-z_.$][A-Za-z0-9_.$]*$/;

function assemblyError(message: string, detail: string | undefined, functionName: string, candidate?: string): CompilerError {
  return new CompilerError({
    category: "AssemblyError",
    stage: "assemble",
    message,
    function: functionName,
    candidate,
    detail,
  });
}

function stripComments(line: string): string {
  let result = "";
  let index = 0;
  while (index < line.length) {
    if (line.startsWith("/*", index)) {
      const end = line.indexOf("*/", index + 2);
      index = end < 0 ? line.length : end + 2;
      result += " ";
      continue;
    }
    if (line[index] === "#" || line.startsWith("//", index)) break;
    result += line[index];
    index += 1;
  }
  return result;
}

interface AssemblyStructure {
  definedLabels: Set<string>;
  referencedSymbols: string[];
  directives: { name: string; arguments: string; line: number }[];
  instructions: { mnemonic: string; operands: string; line: number }[];
}

/** Splits a candidate into labels, directives and instructions. */
export function readAssemblyStructure(assembly: string): AssemblyStructure {
  const definedLabels = new Set<string>();
  const referencedSymbols: string[] = [];
  const directives: AssemblyStructure["directives"] = [];
  const instructions: AssemblyStructure["instructions"] = [];

  assembly.split(/\r?\n/).forEach((raw, offset) => {
    const lineNumber = offset + 1;
    let line = stripComments(raw).trim();
    if (line === "") return;

    // A label may share its line with the instruction it introduces.
    const label = /^([A-Za-z_.$][A-Za-z0-9_.$]*|\d+):\s*(.*)$/.exec(line);
    if (label !== null) {
      definedLabels.add(label[1]);
      line = label[2].trim();
      if (line === "") return;
    }

    if (line.startsWith(".")) {
      const [name, ...rest] = line.split(/\s+/);
      directives.push({ name, arguments: rest.join(" "), line: lineNumber });
      return;
    }
    const [mnemonic, ...rest] = line.split(/\s+/);
    instructions.push({ mnemonic: mnemonic.toLowerCase(), operands: rest.join(" "), line: lineNumber });
  });

  for (const instruction of instructions) {
    for (const operand of instruction.operands.split(",")) {
      const token = operand.trim();
      // A leading %, $, * or @ marks a register, an immediate or an indirect
      // operand; a leading digit is a displacement. Neither is a symbol.
      if (token === "" || /^[%*$@\d]/.test(token)) continue;
      const ripRelative = /^([A-Za-z_.$][A-Za-z0-9_.$]*)\(/.exec(token);
      if (ripRelative !== null) {
        referencedSymbols.push(ripRelative[1]);
        continue;
      }
      if (SYMBOL.test(token)) referencedSymbols.push(token);
    }
  }

  return { definedLabels, referencedSymbols, directives, instructions };
}

/**
 * Rejects anything the contract does not allow. The returned diagnostics are
 * suitable for feeding back to the model.
 */
export function validateAssembly(assembly: string, contract: FunctionContract, candidate?: string): void {
  const functionName = symbolOf(contract);
  const problems: string[] = [];

  if (assembly.trim() === "") {
    throw assemblyError("the candidate contains no assembly", undefined, functionName, candidate);
  }

  const structure = readAssemblyStructure(assembly);
  const { definedLabels, referencedSymbols, directives, instructions } = structure;

  const exported = new Set<string>();
  for (const directive of directives) {
    if (!ALLOWED_DIRECTIVES.has(directive.name)) {
      problems.push(`line ${directive.line}: directive "${directive.name}" is not allowed`);
      continue;
    }
    if (directive.name === ".section" && directive.arguments.trim() !== ".text") {
      problems.push(`line ${directive.line}: only the .text section is allowed`);
      continue;
    }
    if (directive.name === ".globl" || directive.name === ".global") {
      for (const symbol of directive.arguments.split(/\s+/).filter((entry) => entry !== "")) {
        if (symbol !== functionName) {
          problems.push(`line ${directive.line}: "${symbol}" is not part of the contract, only "${functionName}" may be exported`);
        }
        exported.add(symbol);
      }
    }
    if (directive.name === ".size" || directive.name === ".type") {
      const symbol = directive.arguments.trim().split(/\s+/)[0].replace(/,$/, "");
      if (symbol !== undefined && symbol !== functionName && !definedLabels.has(symbol)) {
        problems.push(`line ${directive.line}: "${symbol}" is not defined in the candidate`);
      }
    }
  }

  for (const label of definedLabels) {
    if (label.startsWith(".") || /^\d+$/.test(label)) continue;
    if (label !== functionName) {
      problems.push(`"${label}" is defined but the contract only allows "${functionName}"`);
    }
  }

  if (instructions.length === 0) {
    problems.push("the candidate contains no instructions");
  }
  for (const instruction of instructions) {
    if (FORBIDDEN_MNEMONICS.has(instruction.mnemonic)) {
      problems.push(`line ${instruction.line}: "${instruction.mnemonic}" is not allowed, the function must be pure`);
    }
  }

  for (const symbol of new Set(referencedSymbols)) {
    if (definedLabels.has(symbol)) continue;
    if (symbol === functionName) continue;
    if (/^\d+[fb]$/.test(symbol)) continue;
    if (isRuntimeSymbol(symbol)) continue;
    problems.push(
      `"${symbol}" is referenced but not defined; the candidate may only call the runtime ABI`,
    );
  }

  if (!exported.has(functionName)) {
    problems.push(`the candidate must declare "${functionName}" global`);
  } else if (!definedLabels.has(functionName)) {
    problems.push(`"${functionName}" is declared global but never defined; the candidate needs a "${functionName}:" label`);
  }

  if (problems.length > 0) {
    throw assemblyError(
      `the assembly candidate for ${functionName} violates the contract`,
      problems.join("\n"),
      functionName,
      candidate,
    );
  }
}

export interface AssembleRequest {
  assembly: string;
  assemblyPath: string;
  objectPath: string;
  contract: FunctionContract;
  target: TargetSpec;
  candidate?: string;
}

export interface AssembleResult {
  objectPath: string;
  textSizeBytes: number;
  objectSizeBytes: number;
}

export interface ObjectInfo {
  defined: string[];
  undefined: string[];
  textSizeBytes: number;
  objectSizeBytes: number;
}

/** Confirms the assembler understands the requested architecture. */
export function assertAssemblerSupportsArch(target: TargetSpec): void {
  const directive = archDirective(target);
  if (directive === null) return;
  const probe = run("as", ["--64", "-o", "/dev/null", "-"], {
    input: `${directive}\n.text\n.globl probe\nprobe:\n\tret\n`,
    timeoutMs: 30_000,
  });
  if (probe.spawnError !== undefined) {
    throw new CompilerError({
      category: "TargetError",
      stage: "assemble",
      message: "the GNU assembler is not available",
      detail: probe.spawnError,
    });
  }
  if (probe.code !== 0) {
    throw new CompilerError({
      category: "TargetError",
      stage: "assemble",
      message: `the assembler does not support target.cpu "${target.cpu}"`,
      detail: probe.stderr.trim(),
    });
  }
}

export function inspectObject(objectPath: string, functionName: string, candidate?: string): ObjectInfo {
  const definedResult = run("nm", ["--defined-only", "--extern-only", objectPath], { timeoutMs: 30_000 });
  const undefinedResult = run("nm", ["--undefined-only", objectPath], { timeoutMs: 30_000 });
  if (definedResult.code !== 0 || undefinedResult.code !== 0) {
    throw assemblyError(
      `cannot inspect the object file for ${functionName}`,
      `${definedResult.stderr}${undefinedResult.stderr}`.trim(),
      functionName,
      candidate,
    );
  }

  const defined = definedResult.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/).pop() ?? "")
    .filter((symbol) => symbol !== "");
  const undefined = undefinedResult.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/).pop() ?? "")
    .filter((symbol) => symbol !== "");

  // `size --format=berkeley` prints a header line and one data line:
  // text, data, bss, dec, hex, filename.
  const sizeResult = run("size", ["--format=berkeley", objectPath], { timeoutMs: 30_000 });
  const dataLine = sizeResult.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[0-9]/.test(line))
    .pop();
  const textSizeBytes = Number.parseInt((dataLine ?? "").split(/\s+/)[0] ?? "", 10);
  return { defined, undefined, textSizeBytes: Number.isFinite(textSizeBytes) ? textSizeBytes : 0, objectSizeBytes: 0 };
}

/** Validates, assembles and inspects one candidate. */
export async function assemble(request: AssembleRequest): Promise<AssembleResult> {
  const functionName = request.contract.function.name;
  validateAssembly(request.assembly, request.contract, request.candidate);

  const directive = archDirective(request.target);
  const prelude = `${directive === null ? "" : `${directive}\n`}.text\n`;
  await writeFile(request.assemblyPath, `${prelude}${request.assembly}`, "utf8");

  const result = run("as", ["--64", "-o", request.objectPath, request.assemblyPath], { timeoutMs: 60_000 });
  if (result.spawnError !== undefined) {
    throw new CompilerError({
      category: "TargetError",
      stage: "assemble",
      message: "the GNU assembler is not available",
      detail: result.spawnError,
    });
  }
  if (result.code !== 0) {
    throw assemblyError(
      `the assembler rejected the candidate for ${functionName}`,
      `${request.assemblyPath}\n${result.stderr.trim()}`,
      functionName,
      request.candidate,
    );
  }

  const info = inspectObject(request.objectPath, functionName, request.candidate);
  if (info.defined.length !== 1 || info.defined[0] !== functionName) {
    throw assemblyError(
      `the object defines [${info.defined.join(", ")}] instead of only "${functionName}"`,
      undefined,
      functionName,
      request.candidate,
    );
  }
  const unresolved = info.undefined.filter((symbol) => !isRuntimeSymbol(symbol));
  if (unresolved.length > 0) {
    throw assemblyError(
      `the object references symbols outside the runtime ABI: ${unresolved.join(", ")}`,
      undefined,
      functionName,
      request.candidate,
    );
  }

  const stats = await stat(request.objectPath);
  return { objectPath: request.objectPath, textSizeBytes: info.textSizeBytes, objectSizeBytes: stats.size };
}

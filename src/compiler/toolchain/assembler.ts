/**
 * Assembly validation and machine code generation.
 *
 * Model output is untrusted. Before it reaches the assembler it is checked
 * structurally: only the contracted function may be defined, no symbol outside
 * the contract, the program and the runtime may be referenced, no directive may
 * change the architecture or pull in another file, and no system interface may
 * be used. The architecture prelude is compiler-controlled, so a candidate
 * cannot silently target a different machine than the contract asks for.
 *
 * After assembling, the object is checked again: it must define exactly the
 * contracted symbol and leave nothing undefined but the runtime and the other
 * functions of the program, which the build links beside it.
 */

import { stat, writeFile } from "node:fs/promises";
import { archOptions } from "../core/target.ts";
import { CompilerError } from "../core/errors.ts";
import { run } from "../core/process.ts";
import type { FunctionContract, TargetSpec } from "../core/types.ts";
import { isRuntimeSymbol } from "../runtime/abi.ts";
import { symbolOf } from "../semantics/contract.ts";
import { calledOut, type ContractsByName } from "../semantics/calls.ts";
import { stackAlignmentProblems } from "./stack-frame.ts";
import { readAssemblyLines } from "./asm-text.ts";

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

/**
 * The symbols a candidate may call: the functions of the program whose calls
 * the outline marked as calls (see semantics/calls.ts), and nothing else.
 *
 * The set is what makes the difference between a call and a rejected symbol,
 * and it is per candidate rather than per build. A callee the outline marked
 * for writing out is not referenceable: the body it would have to implement is
 * already in the prompt, and a symbol it names is a reimplementation behind a
 * local label, which is the thing the outline decided against.
 *
 * It follows the bodies written out rather than stopping at the candidate's own
 * edges, because a body written out is part of this object: a call written
 * inside it is a call this candidate makes, and refusing that symbol would turn
 * away the candidate that implemented the body it was given.
 */
export function callableSymbols(contract: FunctionContract, contracts: ContractsByName): Set<string> {
  return new Set(calledOut(contracts, contract).map(symbolOf));
}

/** Whether a symbol is one a candidate is allowed to call. */
export function isCallableSymbol(symbol: string, callable: ReadonlySet<string>): boolean {
  return isRuntimeSymbol(symbol) || callable.has(symbol);
}

/**
 * The program functions a candidate references. A candidate that calls one
 * cannot be linked on its own, because the object it needs is another
 * candidate's, so the program it belongs to is what has to run it.
 */
export function programCalls(assembly: string, callable: ReadonlySet<string>): string[] {
  const { definedLabels, referencedSymbols } = readAssemblyStructure(assembly);
  return [
    ...new Set(
      referencedSymbols.filter((symbol) => callable.has(symbol) && !definedLabels.has(symbol)),
    ),
  ];
}

/**
 * Instructions that would let a candidate leave the sandboxed contract. The
 * families that have several spellings are matched by their opening letters
 * instead, by `isForbidden` below: a set of names only refuses the spellings
 * it happens to list, and `as` accepts `int1`, `inb` and `outsb` as readily
 * as it accepts the names that were listed.
 */
const FORBIDDEN_MNEMONIC_PREFIXES = ["int", "in", "out"];

const FORBIDDEN_MNEMONICS = new Set([
  "syscall",
  "sysenter",
  "sysexit",
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

/** Whether an instruction would take a candidate outside the contract. */
function isForbidden(mnemonic: string): boolean {
  return (
    FORBIDDEN_MNEMONIC_PREFIXES.some((prefix) => mnemonic.startsWith(prefix)) ||
    FORBIDDEN_MNEMONICS.has(mnemonic)
  );
}

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

  for (const line of readAssemblyLines(assembly)) {
    if (line.label !== null) definedLabels.add(line.label);
    if (line.kind === "label") continue;
    if (line.kind === "directive") {
      directives.push({ name: line.name, arguments: line.arguments, line: line.line });
      continue;
    }
    instructions.push({ mnemonic: line.mnemonic, operands: line.operands.join(" "), line: line.line });
    for (const token of line.operands) {
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
export function validateAssembly(
  assembly: string,
  contract: FunctionContract,
  candidate?: string,
  callable: ReadonlySet<string> = new Set(),
): void {
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
    if (isForbidden(instruction.mnemonic)) {
      problems.push(`line ${instruction.line}: "${instruction.mnemonic}" is not allowed, the function must be pure`);
    }
  }

  for (const symbol of new Set(referencedSymbols)) {
    if (definedLabels.has(symbol)) continue;
    if (symbol === functionName) continue;
    if (/^\d+[fb]$/.test(symbol)) continue;
    if (isCallableSymbol(symbol, callable)) continue;
    problems.push(
      `"${symbol}" is referenced but not defined; the candidate may only call the runtime ABI and the other functions of this program`,
    );
  }

  if (!exported.has(functionName)) {
    problems.push(`the candidate must declare "${functionName}" global`);
  } else if (!definedLabels.has(functionName)) {
    problems.push(`"${functionName}" is declared global but never defined; the candidate needs a "${functionName}:" label`);
  }

  // What the runtime it links against was built to expect. A candidate that
  // calls with the stack off a boundary does not print the wrong thing, it dies
  // on the first aligned move inside the call, so it is turned away here.
  problems.push(...stackAlignmentProblems(assembly, functionName));

  if (problems.length > 0) {
    throw assemblyError(
      `the assembly for ${functionName} violates the contract`,
      problems.join("\n"),
      functionName,
      candidate,
    );
  }
}

export interface AssembleRequest {
  /** The other functions of the build, whose symbols this candidate may call. */
  callable?: ReadonlySet<string>;
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
  const options = archOptions(target);
  if (options.length === 0) return;
  const probe = run("as", ["--64", ...options, "-o", "/dev/null", "-"], {
    input: ".text\n.globl probe\nprobe:\n\tret\n",
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
  // Named for what it holds rather than for the keyword it shadows: a local
  // `undefined` makes every `x === undefined` below read as a comparison
  // against a list of symbols, and stops narrowing anything.
  const undefinedSymbols = undefinedResult.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/).pop() ?? "")
    .filter((symbol) => symbol !== "");

  // `size --format=berkeley` prints a header line and one data line:
  // text, data, bss, dec, hex, filename. A `size` that did not run reports no
  // data line, and its absence reads as a text size of zero, which is the
  // smallest size there is: a size-optimised build would then pick whichever
  // candidate it happened to evaluate first, and report it as the smallest.
  const sizeResult = run("size", ["--format=berkeley", objectPath], { timeoutMs: 30_000 });
  if (sizeResult.code !== 0) {
    throw assemblyError(
      `cannot measure the object file for ${functionName}`,
      sizeResult.spawnError ?? sizeResult.stderr.trim(),
      functionName,
      candidate,
    );
  }
  const dataLine = sizeResult.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[0-9]/.test(line))
    .pop();
  if (dataLine === undefined) {
    throw assemblyError(
      `cannot measure the object file for ${functionName}`,
      `size reported no size line:\n${sizeResult.stdout.trim()}`,
      functionName,
      candidate,
    );
  }
  const textSizeBytes = Number.parseInt(dataLine.split(/\s+/)[0], 10);
  if (!Number.isFinite(textSizeBytes)) {
    throw assemblyError(
      `cannot measure the object file for ${functionName}`,
      `size reported an unreadable size:\n${dataLine}`,
      functionName,
      candidate,
    );
  }
  return { defined, undefined: undefinedSymbols, textSizeBytes, objectSizeBytes: 0 };
}

/** Validates, assembles and inspects one candidate. */
export async function assemble(request: AssembleRequest): Promise<AssembleResult> {
  // The symbol the candidate is asked to define is the one the contract names,
  // which is not the function's name when a program entry carries its own.
  const functionName = symbolOf(request.contract);
  validateAssembly(request.assembly, request.contract, request.candidate, request.callable);

  await writeFile(request.assemblyPath, `.text\n${request.assembly}`, "utf8");

  const result = run("as", ["--64", ...archOptions(request.target), "-o", request.objectPath, request.assemblyPath], {
    timeoutMs: 60_000,
  });
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
  const callable = request.callable ?? new Set<string>();
  const unresolved = info.undefined.filter((symbol) => !isCallableSymbol(symbol, callable));
  if (unresolved.length > 0) {
    throw assemblyError(
      `the object references symbols outside the runtime ABI and this program: ${unresolved.join(", ")}`,
      undefined,
      functionName,
      request.candidate,
    );
  }

  const stats = await stat(request.objectPath);
  return { objectPath: request.objectPath, textSizeBytes: info.textSizeBytes, objectSizeBytes: stats.size };
}

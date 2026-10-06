/** Throwaway: wide operations reached through a program's own calls. */
import { phaseOf } from "./phase.ts";
import type { ContractPhase } from "../semantics/program.ts";
import type { FunctionContract, SourceInput } from "../core/types.ts";
import { resolveProgram } from "../semantics/ir-resolve.ts";
import { semanticIrProblems, semanticFunctionProblems } from "../semantics/ir-validate.ts";
import { resolveFunction, type FunctionContext } from "../semantics/ir-function.ts";
import { printSemanticProgram } from "../semantics/ir-text.ts";
import { generateProgramDriver } from "../toolchain/driver.ts";
import type { SemanticFunction } from "../core/semantic-ir.ts";
import { CompilerError } from "../core/errors.ts";

const MAKE = `export function make(n: bigint): u256 { return n; }\n`;

const CASES: Record<string, string> = {
  "compare": `${MAKE}const a = make(5n);\nconst b = make(7n);\nconsole.log(a < b);\n`,
  "div": `${MAKE}const a = make(100n);\nconst b = make(7n);\nconsole.log(a / b);\n`,
  "mod": `${MAKE}const a = make(100n);\nconst b = make(7n);\nconsole.log(a % b);\n`,
  "add": `${MAKE}const a = make(100n);\nconst b = make(7n);\nconsole.log(a + b);\n`,
  "shl by bigint": `${MAKE}const a = make(1n);\nconsole.log(a << 70n);\n`,
  "shl by usize": `${MAKE}const a = make(1n);\nconst n = 70;\nconsole.log(a << n);\n`,
  "equal": `${MAKE}const a = make(5n);\nconst b = make(5n);\nconsole.log(a === b);\n`,
  "function div": `export function half(a: u256, b: u256): u256 { return a / b; }\nconsole.log(half(100n, 7n));\n`,
  "function shl bigint": `export function moved(a: u256): u256 { return a << 70n; }\nconsole.log(moved(1n));\n`,
};

const contracts = (phase: ContractPhase): Record<string, FunctionContract> =>
  Object.fromEntries(phase.program.files.flatMap((f) => Object.entries(f.functions)));

const TARGET: SourceInput["target"] = { arch: "x86_64", os: "linux", abi: "sysv", cpu: "", features: [] };

for (const [label, source] of Object.entries(CASES)) {
  const files = { "main.ts": source };
  console.log(`\n=== ${label} ===`);
  try {
    const phase = phaseOf("typescript", files, "main.ts", { target: TARGET });
    const all = contracts(phase);
    const context: FunctionContext = { objectNames: phase.objectNames, functions: all };
    const semantics: Record<string, SemanticFunction> = {};
    for (const [name, contract] of Object.entries(all)) semantics[name] = resolveFunction(contract, context);
    for (const [name, contract] of Object.entries(all)) {
      const p = semanticFunctionProblems(semantics[name], contract);
      if (p.length > 0) console.log(`  FN ${name}: ${p.join(" | ")}`);
    }
    const raw = resolveProgram(phase.body!, phase.program);
    console.log("  body: " + printSemanticProgram(raw).split("block entry")[1]?.trim());
    const wide = generateProgramDriver(raw)
      .split("\n")
      .filter((l) => /blaze_rt_u256_(add|sub|mul|div|mod|shl|shr|and|or|xor|less|equal)\(/.test(l))
      .map((l) => l.trim().slice(0, 120));
    console.log("  driver wide: " + (wide.length === 0 ? "(none)" : wide.join(" ; ")));
  } catch (error) {
    if (error instanceof CompilerError) {
      console.log(`  ERR ${error.message}\n  ${(error.detail ?? "").split("\n").join("\n  ")}`);
    } else {
      console.log(`  RAW ${String(error)}\n${(error as Error).stack}`);
    }
  }
}

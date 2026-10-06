/** Throwaway: what the IR says for a program body that uses a wide number. */
import { phaseOf } from "./phase.ts";
import { resolveProgram } from "../semantics/ir-resolve.ts";
import { semanticIrProblems } from "../semantics/ir-validate.ts";
import { printSemanticProgram } from "../semantics/ir-text.ts";

const WIDE = ["export function wide(n: u256): u256 {", "  return n;", "}"];

const CASES: Record<string, string> = {
  "compare with a literal": [...WIDE, "const a = wide(5n);", "console.log(a === 5n);"].join("\n"),
  "shift": [...WIDE, "const a = wide(1n);", "console.log(a << 3);"].join("\n"),
  "complement": [...WIDE, "const a = wide(1n);", "console.log(~a);"].join("\n"),
  "add two wide": [...WIDE, "const a = wide(1n);", "const b = wide(2n);", "console.log(a + b);"].join("\n"),
  "negate": [...WIDE, "const a = wide(1n);", "console.log(-a);"].join("\n"),
};

for (const [label, source] of Object.entries(CASES)) {
  console.log(`\n=== ${label} ===`);
  try {
    const phase = phaseOf("typescript", { "main.ts": `${source}\n` }, "main.ts");
    const program = resolveProgram(phase.body!, phase.program);
    console.log(printSemanticProgram(program).split("block entry")[1]?.trim());
    console.log(`  problems: ${JSON.stringify(semanticIrProblems(program, phase.program), null, 1)}`);
  } catch (error) {
    console.log(`  threw: ${(error as Error).message}`);
  }
}

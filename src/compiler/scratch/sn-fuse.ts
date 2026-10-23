import { phaseOf } from "../test/phase.ts";
import { resolveProgram } from "../semantics/ir-resolve.ts";
import { optimizeSemanticProgram } from "../semantics/optimize-ir.ts";
import { printSemanticProgram } from "../semantics/ir-text.ts";

const source = await (await import("node:fs/promises")).readFile(
  "/jason/My_Development/blaze/src/benchmarks/machine_backend/spectral_norm/7.ts",
  "utf8",
);
const phase = phaseOf("typescript", { "7.ts": source }, "7.ts");
if (phase.body === undefined) throw new Error("no body");
const program = optimizeSemanticProgram(
  resolveProgram(phase.body, phase.program, phase.objectNames, phase.objectLayouts, phase.objectKeys),
);
const text = printSemanticProgram(program);
const at = text.indexOf("function au");
console.log(text.slice(at, text.indexOf("function atu") > at ? text.indexOf("function atu") : at + 1500));

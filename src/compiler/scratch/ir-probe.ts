import { phaseOf, semanticsOf } from "../test/phase.ts";
import { printSemanticFunction } from "../semantics/ir-text.ts";
const phase = phaseOf("typescript", { "main.ts": process.argv[2]! }, "main.ts");
const semantics = semanticsOf(phase);
for (const [, fn] of Object.entries(semantics)) console.log(printSemanticFunction(fn));

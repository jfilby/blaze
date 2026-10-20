import { phaseOf } from "../test/phase.ts";
import { resolveProgram } from "../semantics/ir-resolve.ts";
import { generateProgramDriver } from "../toolchain/driver.ts";

const source = `const req = { path: "/" };
if (req.path === "/hello") { console.log("yes"); }
console.log(req.path);
`;
const phase = phaseOf("typescript", { "main.ts": source }, "main.ts");
if (phase.body === undefined) throw new Error("no body");
const resolved = resolveProgram(phase.body, phase.program, phase.objectNames, phase.objectLayouts, phase.objectKeys);
const written = generateProgramDriver(resolved, true);
const lines = written.split("\n");
const start = lines.findIndex((l) => l.includes("int main"));
console.log(lines.slice(start, start + 40).join("\n"));

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { frontendFor } from "./semantics/frontend.ts";
import { runContractPhase } from "./semantics/program.ts";
import { resolveFunction, type FunctionContext } from "./semantics/ir-function.ts";
import { optimizeSemanticFunction } from "./semantics/optimize-ir.ts";
import { printSemanticFunction } from "./semantics/ir-text.ts";
import { inlineCalls, type RepairContext } from "./semantics/repair.ts";

const directory = resolve(process.argv[2]);
const which = process.argv[3];
const project = parseToml(await readFile(join(directory, "blaze.toml"), "utf8")) as Record<string, unknown>;
const source = await readFile(join(directory, (project as { sourceFile: string }).sourceFile), "utf8");
const phase = runContractPhase({
  frontend: frontendFor((project as { language: string }).language),
  input: { ...project, source } as never,
  entry: { path: (project as { sourceFile: string }).sourceFile, source },
  read: () => null,
});
const contracts = phase.program.files.flatMap((file) => Object.entries(file.functions));
const context: FunctionContext = {
  objectNames: phase.objectNames,
  functions: Object.fromEntries(contracts),
};
const resolvedByName = new Map(contracts.map(([name, contract]) => [name, resolveFunction(contract, context)]));
const inlinable: RepairContext = { functions: resolvedByName };
for (const [name] of contracts) {
  if (name !== which) continue;
  const lowered = optimizeSemanticFunction(inlineCalls(resolvedByName.get(name) as never, inlinable), inlinable.functions);
  process.stdout.write(printSemanticFunction(lowered));
}

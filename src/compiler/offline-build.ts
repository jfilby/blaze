/**
 * An offline build of a benchmark project: the deterministic half of
 * `blaze build` with no model in it.
 *
 * The frontend, the contract phase, the resolver, the optimizer, the machine
 * backend and the driver are all rule-based, so a benchmark can be rebuilt and
 * checked without a credential. What it cannot do is review: nothing here asks
 * a model what to change, so the IR it lowers is the IR the frontend resolved —
 * which is the IR `blaze ir` prints and the one the optimizer rewrites, and for
 * a program whose functions are all inlined or reached from its entry, exactly
 * what a build lowers.
 *
 * Every step is the one `runBuild` takes, in the order it takes them: resolve
 * each function, inline its callees the way a candidate is inlined, fold it,
 * lower it to an object, then link the objects beside the program driver.
 *
 * It is trustworthy because it is checkable rather than merely plausible: run
 * it on a project a build has already produced and the driver it writes is
 * byte for byte the one the build wrote, so a difference after a change to the
 * optimizer is the change and nothing else.
 *
 *   node offline-build.ts <project directory> <work directory>
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";

import { frontendFor } from "./semantics/frontend.ts";
import { runContractPhase } from "./semantics/program.ts";
import { resolveProgram } from "./semantics/ir-resolve.ts";
import { resolveFunction, type FunctionContext } from "./semantics/ir-function.ts";
import { optimizeSemanticFunction, optimizeSemanticProgram } from "./semantics/optimize-ir.ts";
import { programIsParallel } from "./semantics/parallel.ts";
import { printSemanticProgram } from "./semantics/ir-text.ts";
import { semanticFunctionProblems, validateSemanticProgram } from "./semantics/ir-validate.ts";
import { inlineCalls } from "./semantics/repair.ts";
import { buildObject as buildMachineObject } from "./toolchain/ir-machine.ts";
import { buildProgramDriver } from "./toolchain/driver.ts";
import { buildStandaloneRuntime } from "./runtime/standalone.ts";
import { symbolOf } from "./semantics/contract.ts";
import type { TargetSpec } from "./core/types.ts";
import type { SemanticFunction } from "./core/semantic-ir.ts";

const TARGET: TargetSpec = { arch: "x86_64", os: "linux", abi: "sysv", cpu: "", features: [] };

/** What a project file names that this harness reads. */
interface ProjectFile {
  language: string;
  sourceFile: string;
}

async function main(): Promise<void> {
  const [projectDirectory, workDirectory] = process.argv.slice(2);
  if (projectDirectory === undefined || workDirectory === undefined) {
    throw new Error("usage: offline-build.ts <project directory> <work directory>");
  }
  const directory = resolve(projectDirectory);
  const work = resolve(workDirectory);
  await mkdir(work, { recursive: true });

  const project = parseToml(await readFile(join(directory, "blaze.toml"), "utf8")) as unknown as ProjectFile;
  const source = await readFile(join(directory, project.sourceFile), "utf8");
  const phase = runContractPhase({
    frontend: frontendFor(project.language),
    input: { ...project, source } as never,
    entry: { path: project.sourceFile, source },
    read: () => null,
  });
  if (phase.body === undefined) throw new Error(`${project.sourceFile} declares no program body to build`);

  const contracts = phase.program.files.flatMap((file) => Object.entries(file.functions));
  const context: FunctionContext = {
    objectNames: phase.objectNames,
    functions: Object.fromEntries(contracts),
  };
  // Every function is resolved before any is inlined, because the inliner
  // reads the bodies it may write out and a body is what resolution writes.
  const resolvedByName = new Map(contracts.map(([name, contract]) => [name, resolveFunction(contract, context)]));
  const inlinable = { functions: resolvedByName };

  // The program, resolved and folded exactly as a build folds the driver.
  const program = optimizeSemanticProgram(resolveProgram(phase.body, phase.program));
  // The validator refuses rather than answers, so a program that is not one a
  // backend may lower stops here with the reason it gave.
  validateSemanticProgram(program, phase.program);
  await writeFile(join(work, "ir.program.txt"), `${printSemanticProgram(program)}\n`, "utf8");

  // The symbol of a function is the one its own contract names, which the
  // contract phase wrote before the IR was resolved from it.
  const callable = new Set<string>();
  for (const file of phase.program.files) {
    for (const contract of Object.values(file.functions)) callable.add(symbolOf(contract));
  }

  const objectPaths: string[] = [];
  let textBytes = 0;
  for (const file of phase.program.files) {
    for (const [name, contract] of Object.entries(file.functions)) {
      // A candidate is inlined and then folded, in that order, because the
      // callee spliced in has not been through the rewrites yet.
      const lowered = optimizeSemanticFunction(inlineCalls(resolvedByName.get(name) as SemanticFunction, inlinable));
      const here = semanticFunctionProblems(lowered);
      if (here.length > 0) {
        for (const problem of here) console.error(`  ${name}: ${problem}`);
        throw new Error(`${name} did not validate`);
      }
      const result = await buildMachineObject({
        fn: lowered,
        contract,
        target: TARGET,
        callable,
        objectPath: join(work, `${name}.o`),
      });
      objectPaths.push(join(work, `${name}.o`));
      textBytes += result.textSizeBytes;
    }
  }
  console.log(`  ${objectPaths.length} object(s), ${textBytes} bytes of code`);

  const runtime = await buildStandaloneRuntime(work, "danger", TARGET);
  const outputPath = join(work, "program");
  await buildProgramDriver({
    mode: "danger",
    objective: "throughput",
    target: TARGET,
    program,
    workDirectory: work,
    objectPaths,
    runtimeObjectPath: runtime.objectPath,
    threads: programIsParallel(program.entry, program.bodies),
    outputPath,
  });
  console.log(`  ${outputPath}`);
}

await main();
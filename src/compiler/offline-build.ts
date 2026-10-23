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
import { wholeElementArithmetic } from "./semantics/whole-elements.ts";
import { contractsByName, vectorChecked } from "./semantics/calls.ts";
import { programIsParallel } from "./semantics/parallel.ts";
import { printSemanticProgram } from "./semantics/ir-text.ts";
import { semanticFunctionProblems, validateSemanticProgram } from "./semantics/ir-validate.ts";
import { inlineCalls, type RepairContext } from "./semantics/repair.ts";
import { buildObject as buildMachineObject } from "./toolchain/ir-machine.ts";
import { buildProgramDriver } from "./toolchain/driver.ts";
import { programLoweringOf } from "./compiler.ts";
import { buildStandaloneRuntime } from "./runtime/standalone.ts";
import { buildFacilRuntime } from "./runtime/facil.ts";
import { httpRuntimeNeeds } from "./runtime/http-needs.ts";
import { buildSqliteLibrary } from "./runtime/sqlite-build.ts";
import { usesSqliteSource } from "./runtime/sqlite.ts";
import { symbolOf } from "./semantics/contract.ts";
import { powerOfTwoParams } from "./semantics/power-of-two.ts";
import type { TargetSpec } from "./core/types.ts";
import type { Threading } from "./core/target.ts";
import type { SemanticFunction } from "./core/semantic-ir.ts";


/**
 * What the project file asks of the target, which the machine backend reads:
 * `sse4.1` in `[target] features` is what turns `Math.floor` into the one
 * instruction that rounds instead of the sequence, so a harness that hardcoded
 * an empty feature list measured a program the project had not asked for.
 */
function targetFor(project: ProjectFile): TargetSpec {
  const target = project.target ?? {};
  return {
    arch: target.arch ?? "x86_64",
    os: target.os ?? "linux",
    abi: target.abi ?? "sysv",
    cpu: target.cpu ?? "",
    features: target.features ?? [],
  };
}

/** What a project file names that this harness reads. */
interface ProjectFile {
  language: string;
  target?: Partial<TargetSpec>;
  sourceFile: string;
  output?: "machine" | "wasm" | "c" | "ir" | "asm";
  backend?: "c" | "wasm" | "machine";
  runtime?: "none" | "facil" | "nim";
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
  const target = targetFor(project);
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
  // Whole-number arithmetic over a buffer of whole numbers is a question about
  // the whole program, and it is asked of the same bodies the backends are
  // handed: the pass rewrites the loops of the functions themselves rather than
  // a copy of them, so it runs here rather than inside `optimizeSemanticProgram`,
  // which is handed the program's own statements and its own bodies.
  const resolvedProgram = resolveProgram(phase.body, phase.program, phase.objectNames, phase.objectLayouts);
  wholeElementArithmetic([...resolvedByName.values()], resolvedProgram.entry, vectorChecked(contractsByName(phase.program.files)));
  // Which arrays hold powers of two, propagated through the call graph, so the
  // machine backend can strength-reduce division by one of their elements to a
  // shift.
  const powerOfTwo = powerOfTwoParams(resolvedByName, resolvedProgram.entry);
  const inlinable: RepairContext = { functions: resolvedByName };

  // The program, resolved and folded exactly as a build folds the driver.
  const program = optimizeSemanticProgram(resolvedProgram, inlinable.functions);
  // The validator refuses rather than answers, so a program that is not one a
  // backend may lower stops here with the reason it gave. The callees are the
  // program's own bodies, the same map a build hands the validator: a loop
  // marked parallel is proved against the bodies the program holds, which are
  // the ones the backends lower.
  validateSemanticProgram(program, phase.program, new Map(program.bodies.map((fn) => [fn.name, fn])));
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
      const lowered = optimizeSemanticFunction(inlineCalls(resolvedByName.get(name) as SemanticFunction, inlinable), inlinable.functions);
      // The callees are read again here because the mark the optimizer set was
      // decided with them: a loop that calls a function is measured by what that
      // function computes, and a validator given no callees measures it as a
      // call and nothing more — so it refuses a loop the optimizer admitted and
      // the build fails on a verdict nothing actually changed.
      const here = semanticFunctionProblems(lowered, contract, inlinable.functions);
      if (here.length > 0) {
        for (const problem of here) console.error(`  ${name}: ${problem}`);
        throw new Error(`${name} did not validate`);
      }
      const result = await buildMachineObject({
        fn: lowered,
        contract,
        target,
        callable,
        powerOfTwoParams: powerOfTwo.params.get(name),
        objectPath: join(work, `${name}.o`),
      });
      objectPaths.push(join(work, `${name}.o`));
      textBytes += result.textSizeBytes;
    }
  }
  console.log(`  ${objectPaths.length} object(s), ${textBytes} bytes of code`);

  // Every function the program declares that no contract covers is an object
  // of its own, the way a build lowers it: what the machine backend refused
  // stays in the driver, and so does everything whose call to it would hand
  // over what only one convention carries.
  const machine = (project.backend ?? (project.output === "machine" ? "machine" : "c")) === "machine";
  const covered = new Set(resolvedByName.keys());
  const bodyLowering = machine ? programLoweringOf(program, covered, target) : undefined;
  if (bodyLowering !== undefined) {
    for (const note of bodyLowering.notes) console.log(`  ${note}`);
  }
  const threads: Threading[] = programIsParallel(program.entry, program.bodies) ? ["openmp"] : [];
  for (const body of program.bodies) {
    if (bodyLowering === undefined || !bodyLowering.lowered.has(body.symbol)) continue;
    const result = await buildMachineObject({
      fn: body,
      target,
      callable: bodyLowering.callable,
      powerOfTwoParams: powerOfTwo.params.get(body.name),
      objectPath: join(work, `${body.symbol}.o`),
    });
    objectPaths.push(join(work, `${body.symbol}.o`));
    textBytes += result.textSizeBytes;
    if (result.threads && !threads.includes("pthread")) threads.push("pthread");
  }
  console.log(`  ${objectPaths.length} object(s), ${textBytes} bytes of code`);

  // A program that asks for the HTTP runtime links the facil.io adapter beside
  // it, the same way a build does: the source names `http`, so the driver
  // writes the `blaze_http_*` calls the adapter answers. The runtime is built
  // for the program: how many connections its server may hold, and whether it
  // speaks TLS.
  const isHttp = project.runtime === "facil" || /\bhttp\b/.test(source);
  const http = httpRuntimeNeeds(phase.body, [...phase.modules.map((module) => module.source), source]);
  const runtime = isHttp
    ? await buildFacilRuntime(work, "danger", target, http)
    : await buildStandaloneRuntime(work, "danger", target);
  // A program that uses SQLite links the SQLite library beside the runtime, the
  // same way a build does.
  const isSqlite = usesSqliteSource(source);
  const library = isSqlite ? await buildSqliteLibrary(work, "danger", target) : undefined;
  const outputPath = join(work, "program");
  await buildProgramDriver({
    mode: "danger",
    objective: "throughput",
    target,
    program,
    workDirectory: work,
    objectPaths,
    runtimeObjectPath: runtime.objectPath,
    includeHttpHeader: isHttp,
    includeSqliteHeader: isSqlite,
    ...(machine ? { lowering: "machine" as const } : {}),
    loweredBodies: (bodyLowering === undefined ? [] : program.bodies.filter((body) => bodyLowering.lowered.has(body.symbol)).map((body) => body.symbol)),
    tls: http.tls,
    libraryObjectPaths: library === undefined ? [] : [library.objectPath],
    threads,
    outputPath,
  });
  console.log(`  ${outputPath}`);
}

await main();
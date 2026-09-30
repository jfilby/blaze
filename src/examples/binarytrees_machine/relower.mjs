/**
 * Rebuild a stored machine-object build with the compiler as it is now.
 *
 * `--reuse` re-derives the whole incremental key, which hashes the compiler's
 * own sources, so it refuses to reuse a stored object as soon as the compiler
 * changes — which is exactly the change being measured. This reads the stored
 * candidates instead: the IR an earlier build produced is taken as the model
 * wrote it, and it is lowered through the same path `codegen.ts:materialize`
 * takes, so a rule added to `optimize-ir.ts` or `ir-machine.ts` is in the
 * measurement and no rule is re-asked for.
 *
 * It is a harness, not a build: it links what it is given and does not verify,
 * benchmark or review, which is what `blaze build` is for.
 *
 *   node relower.mjs <project> [workDir]
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const COMPILER = resolve(import.meta.dirname, "../../compiler");
const load = async (path) => import(join(COMPILER, path));

const { parseSemanticFunction } = await load("semantics/ir-text.ts");
const { optimizeSemanticFunction, optimizeSemanticProgram } = await load("semantics/optimize-ir.ts");
const { resolveProgram } = await load("semantics/ir-resolve.ts");
const { validateSemanticProgram } = await load("semantics/ir-validate.ts");
const { buildObject } = await load("toolchain/ir-machine.ts");
const { buildProgramDriver } = await load("toolchain/driver.ts");
const { frontendFor } = await load("semantics/frontend.ts");
const { buildStandaloneRuntime } = await load("runtime/standalone.ts");

const id = process.argv[2] ?? "binarytrees_machine";
const projectDirectory = process.argv[3] ?? dirname(process.argv[1]);
const base = join(projectDirectory, ".blaze", "projects", id);
const at = (name) => join(base, `${name}.json`);

const input = JSON.parse(await readFile(at("input"), "utf8"));
const contract = JSON.parse(await readFile(at("contract"), "utf8"));
const generation = JSON.parse(await readFile(at("generation"), "utf8"));
const target = { arch: "x86_64", os: "linux", abi: "sysv", cpu: "", features: [] };
const program = { version: contract.version, language: contract.language, entry: contract.entry, files: contract.files, edges: contract.edges };
const callable = new Set(Object.values(contract.files).flatMap((file) => Object.keys(file.functions)));
const selected = Object.fromEntries(Object.entries(generation.functions).map(([name, entry]) => [name, entry.selected]));
const work = await mkdtemp(join(projectDirectory, ".relower-"));

const objectPaths = [];
for (const file of contract.files) {
  for (const [name, fnContract] of Object.entries(file.functions)) {
    const text = await readFile(join(base, "work", name, `${selected[name] ?? "c1"}.ir`), "utf8");
    const fn = optimizeSemanticFunction(parseSemanticFunction(text, program));
    const objectPath = join(work, `${name}.o`);
    await buildObject({ fn, contract: fnContract, target, callable, objectPath });
    objectPaths.push(objectPath);
  }
}

const source = await readFile(join(projectDirectory, input.sourceFile), "utf8");
const entry = frontendFor(input.language).analyze(source, input.sourceFile);
const driver = optimizeSemanticProgram(resolveProgram({ file: entry.path, statements: entry.body }, program));
validateSemanticProgram(driver);
const runtime = await buildStandaloneRuntime(work, input.mode ?? "debug", target);
await buildProgramDriver({
  mode: input.mode,
  objective: input.optimize?.secondary === "size" ? "size" : undefined,
  target,
  program: driver,
  workDirectory: work,
  objectPaths,
  runtimeObjectPath: runtime.objectPath,
  outputPath: join(projectDirectory, id),
});
await rm(work, { recursive: true, force: true });
console.log(`built ${join(projectDirectory, id)}`);

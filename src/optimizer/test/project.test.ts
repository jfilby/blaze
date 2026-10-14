/**
 * What is read from a project, and what is refused.
 *
 * A project path is what targets a run at one blaze project, so it is read
 * before any pass — a path that names no project has to be refused before
 * anything is spent on the run, and what it names has to be a project file
 * with a source file behind it. The context the source is read for is what
 * the research query and the proposals are steered by.
 */

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { after, test } from "node:test";
import { benchmarkExample, loadProject, ProjectError } from "../project.ts";
import { craftQuery, extractProjectContext } from "../tavily.ts";
import { modelProblem, modelSpec, modelToAsk } from "../ai.ts";
import { EXECUTABLE_SUFFIX } from "../../compiler/core/target.ts";
import { compilerDirectory, repositoryRoot } from "../repository.ts";

/**
 * The environment a model is resolved from, restored after these tests.
 *
 * `process.env.X = undefined` writes the string \"undefined\", so a variable
 * is taken away with `delete` and put back as the string it was.
 */
const ENVIRONMENT = { ...process.env };

after(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ENVIRONMENT)) delete process.env[key];
  }
  Object.assign(process.env, ENVIRONMENT);
});

/** Take a variable out of the environment. */
function without(keys: readonly string[]): void {
  for (const key of keys) delete process.env[key];
}
import { scratch } from "./scratch.ts";

/** A project directory naming a source file. */
async function project(source = "export function f(x: number): number { return x; }\n"): Promise<string> {
  const dir = await scratch("blazeup-project-");
  await writeFile(join(dir, "blaze.toml"), "sourceFile = \"main.ts\"\noutput = \"machine\"\n");
  await writeFile(join(dir, "main.ts"), source);
  return dir;
}

/** A project directory whose blaze.toml carries the given extra lines. */
async function projectWith(lines: readonly string[]): Promise<string> {
  const dir = await scratch("blazeup-project-");
  await writeFile(
    join(dir, "blaze.toml"),
    `sourceFile = "main.ts"\noutput = "machine"\n${lines.join("\n")}\n`,
  );
  await writeFile(join(dir, "main.ts"), "function main(): void { console.log('hi'); }\n");
  return dir;
}

test("a project directory is read, with its source and its context", async () => {
  const dir = await project([
    "export function fib(n: number): number {",
    "  for (let i = 0; i < n; i += 1) { total += i * i; }",
    "  return total;",
    "}",
  ].join("\n"));

  const read = await loadProject(dir);

  assert.equal(read.sourcePath, join(dir, "main.ts"));
  assert.match(read.source, /fib/);
  assert.match(read.context, /recursive algorithms/);
  assert.match(read.context, /loops/);
  assert.match(read.context, /functions: fib/);
});

test("a project file may be named instead of the directory", async () => {
  const dir = await project();
  const read = await loadProject(join(dir, "blaze.toml"));

  assert.equal(read.directory, dir);
});

test("a path that names no project is refused", async () => {
  const dir = await project();

  await assert.rejects(() => loadProject(join(dir, "nope")), (cause) => {
    assert.ok(cause instanceof ProjectError);
    assert.match(cause.message, /no blaze\.toml at/);
    return true;
  });
  await assert.rejects(() => loadProject(join(dir, "missing.toml")), /no blaze\.toml at/);
});

test("a project file that names no source is refused", async () => {
  const dir = await scratch("blazeup-project-");
  await writeFile(join(dir, "blaze.toml"), "output = \"machine\"\n");

  await assert.rejects(() => loadProject(dir), /does not name a sourceFile/);
});

test("a project whose source file is not there is refused", async () => {
  const dir = await scratch("blazeup-project-");
  await writeFile(join(dir, "blaze.toml"), "sourceFile = \"gone.ts\"\n");

  await assert.rejects(() => loadProject(dir), /source file not found/);
});

test("a project file that cannot be parsed is refused, saying why", async () => {
  const dir = await scratch("blazeup-project-");
  await writeFile(join(dir, "blaze.toml"), "this is not = = toml\n");

  await assert.rejects(() => loadProject(dir), /failed to parse/);
});

test("the query is steered by what the source does", () => {
  const general = craftQuery();
  const targeted = craftQuery("domains: tree algorithms; functions: checksum");

  assert.match(general, /^compiler optimization techniques research 2025 2026/);
  assert.match(targeted, /for tree algorithms/);
  assert.doesNotMatch(targeted, /functions:/);
});

test("a source holding nothing distinctive is read as holding nothing", () => {
  assert.equal(extractProjectContext(""), "");
  assert.equal(craftQuery(extractProjectContext("")), craftQuery(""));
});

test("no model in the environment is a problem named before a session starts", () => {
  without(["AI_MODEL", "ANTHROPIC_API_KEY", "AI_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"]);

  assert.equal(modelSpec(), null);
  assert.match(modelProblem() ?? "", /no AI_MODEL is set/);
});

test("a model whose provider has no key is a problem too", () => {
  process.env["AI_MODEL"] = "anthropic/claude-sonnet-4-5";
  without(["ANTHROPIC_API_KEY", "AI_API_KEY"]);

  assert.equal(modelSpec(), "anthropic/claude-sonnet-4-5");
  // The compiler's own resolver says which keys would serve.
  assert.match(modelProblem() ?? "", /cannot be asked: missing API key for provider "anthropic"/);
  assert.match(modelProblem() ?? "", /set one of ANTHROPIC_API_KEY/);
});

test("a model with its key is not a problem", () => {
  process.env["AI_MODEL"] = "anthropic/claude-sonnet-4-5";
  process.env["ANTHROPIC_API_KEY"] = "a-key";

  assert.equal(modelProblem(), null);
});

test("the model a project names is read the way the compiler reads it", async () => {
  const dir = await scratch("blazeup-project-");
  await writeFile(join(dir, "main.ts"), "export function f(x: number): number { return x; }\n");
  await writeFile(join(dir, "blaze.toml"), [
    'sourceFile = "main.ts"',
    'model = "anthropic/claude-sonnet-4-5"',
    'output = "machine"',
  ].join("\n") + "\n");

  assert.equal((await loadProject(dir)).model, "anthropic/claude-sonnet-4-5");
});

test("a project may name its model as a table", async () => {
  const dir = await scratch("blazeup-project-");
  await writeFile(join(dir, "main.ts"), "export function f(x: number): number { return x; }\n");
  await writeFile(join(dir, "blaze.toml"), [
    'sourceFile = "main.ts"',
    '[model]',
    'provider = "openai"',
    'model = "gpt-5"',
  ].join("\n") + "\n");

  assert.equal((await loadProject(dir)).model, "openai/gpt-5");
});

test("a project that names no model reads as one that names none", async () => {
  const dir = await scratch("blazeup-project-");
  await writeFile(join(dir, "main.ts"), "export function f(x: number): number { return x; }\n");
  await writeFile(join(dir, "blaze.toml"), 'sourceFile = "main.ts"\n');

  assert.equal((await loadProject(dir)).model, null);
});

test("a project's model that cannot be used is refused, saying why", async () => {
  const dir = await scratch("blazeup-project-");
  await writeFile(join(dir, "main.ts"), "export function f(x: number): number { return x; }\n");
  await writeFile(join(dir, "blaze.toml"), [
    'sourceFile = "main.ts"',
    '[model]',
    'provider = "anthropic"',
  ].join("\n") + "\n");

  await assert.rejects(() => loadProject(dir), /names a model that cannot be used/);
});

test("a run aimed at a project asks the project's own model when the environment names none", async () => {
  without(["AI_MODEL", "ANTHROPIC_API_KEY", "AI_API_KEY", "OPENAI_API_KEY"]);
  const dir = await scratch("blazeup-project-");
  await writeFile(join(dir, "main.ts"), "export function f(x: number): number { return x; }\n");
  await writeFile(join(dir, "blaze.toml"), 'sourceFile = "main.ts"\nmodel = "openai/gpt-5"\n');
  const project = await loadProject(dir);

  assert.equal(modelToAsk(project), "openai/gpt-5");
  assert.match(modelProblem(project) ?? "", /missing API key for provider "openai"/);
});

test("a project that names no model of its own leaves the environment's", async () => {
  without(["AI_MODEL", "ANTHROPIC_API_KEY", "AI_API_KEY", "OPENAI_API_KEY"]);
  const dir = await scratch("blazeup-project-");
  await writeFile(join(dir, "main.ts"), "export function f(x: number): number { return x; }\n");
  await writeFile(join(dir, "blaze.toml"), 'sourceFile = "main.ts"\n');
  const project = await loadProject(dir);

  assert.equal(modelToAsk(project), null);
  assert.match(modelProblem(project) ?? "", /names no model/);
});

test("the environment's model wins over the project's own", async () => {
  process.env["AI_MODEL"] = "anthropic/claude-sonnet-4-5";
  const dir = await scratch("blazeup-project-");
  await writeFile(join(dir, "main.ts"), "export function f(x: number): number { return x; }\n");
  await writeFile(join(dir, "blaze.toml"), 'sourceFile = "main.ts"\nmodel = "openai/gpt-5"\n');
  const project = await loadProject(dir);

  assert.equal(modelToAsk(project), "anthropic/claude-sonnet-4-5");
});

test("the benchmark a project names is read, with the directory it runs in", async () => {
  const dir = await projectWith(["[benchmark]", 'command = "./run 16"', 'working_dir = "artifacts"']);

  const read = await loadProject(dir);

  assert.equal(read.benchmark?.command, "./run 16");
  // Beside the project's own sources, the way its `sourceFile` is: a path a
  // project file names is relative to the file that names it.
  assert.equal(read.benchmark?.directory, join(dir, "artifacts"));
  // The program is the project's own name, which is the name its build writes
  // it under beside the sources.
  assert.equal(read.benchmark?.program, `${basename(dir)}${EXECUTABLE_SUFFIX}`);
});

test("a benchmark's working_dir is the project's own directory when it says nothing", async () => {
  const dir = await projectWith(["[benchmark]", 'command = "./run 16"']);

  assert.equal((await loadProject(dir)).benchmark?.directory, dir);
});

test("a benchmark's working_dir is read beside the project's sources, and from the head of the repository", async () => {
  // A directory beside the sources, which is the project's own spelling.
  const dir = await projectWith(["[benchmark]", 'command = "./run 16"', 'working_dir = "src"']);
  await mkdir(join(dir, "src"), { recursive: true });
  assert.equal((await loadProject(dir)).benchmark?.directory, join(dir, "src"));

  // And a path from the head of the repository, which names a directory the
  // project itself does not hold: `src/compiler` is one, and an entry written
  // that way is read as it was written rather than refused.
  const repositorySpelled = await projectWith([
    "[benchmark]",
    'command = "./run 16"',
    'working_dir = "src/compiler"',
  ]);
  assert.equal((await loadProject(repositorySpelled)).benchmark?.directory, compilerDirectory(repositoryRoot()));
});

test("a benchmark's working_dir that names nothing is still read, so the command says so", async () => {
  const dir = await projectWith(["[benchmark]", 'command = "./run 16"', 'working_dir = "nowhere"']);

  // Nothing to resolve to, so the directory beside the project is what the
  // entry names: a command that never runs fails as one, rather than silently
  // timing a program somewhere else.
  assert.equal((await loadProject(dir)).benchmark?.directory, join(dir, "nowhere"));
});

test("a project that names no benchmark names none", async () => {
  assert.equal((await loadProject(await project())).benchmark, null);
});

test("a benchmark entry that names no command is refused, with an entry that does", async () => {
  const dir = await projectWith(["[benchmark]", 'working_dir = "artifacts"']);

  await assert.rejects(() => loadProject(dir), (cause) => {
    assert.ok(cause instanceof ProjectError);
    assert.match(cause.message, /\[benchmark\] names no command to time/);
    // The refusal is not only a reason: it is the entry to write into the
    // file, with the program this project's own build delivers in it.
    assert.match(cause.message, /\[benchmark\]\ncommand = "\.\/[^"]+ 16"\nworking_dir = "\."/);
    return true;
  });
});

test("a benchmark that is not a table is refused the same way", async () => {
  const dir = await projectWith(['benchmark = "./run 16"']);

  await assert.rejects(() => loadProject(dir), /\[benchmark\] must be a table naming a command to time/);
});

test("the example entry names the program the project's own build delivers", () => {
  assert.equal(
    benchmarkExample("/repo/src/binarytrees/blaze.toml"),
    ["[benchmark]", 'command = "./binarytrees 16"', 'working_dir = "."'].join("\n"),
  );
});

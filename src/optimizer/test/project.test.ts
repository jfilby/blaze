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
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadProject, ProjectError } from "../project.ts";
import { craftQuery, extractProjectContext } from "../tavily.ts";
import { modelProblem, modelSpec, modelToAsk } from "../ai.ts";

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
  const dir = await scratch("blazeopt-project-");
  await writeFile(join(dir, "blaze.toml"), "sourceFile = \"main.ts\"\noutput = \"machine\"\n");
  await writeFile(join(dir, "main.ts"), source);
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
  const dir = await scratch("blazeopt-project-");
  await writeFile(join(dir, "blaze.toml"), "output = \"machine\"\n");

  await assert.rejects(() => loadProject(dir), /does not name a sourceFile/);
});

test("a project whose source file is not there is refused", async () => {
  const dir = await scratch("blazeopt-project-");
  await writeFile(join(dir, "blaze.toml"), "sourceFile = \"gone.ts\"\n");

  await assert.rejects(() => loadProject(dir), /source file not found/);
});

test("a project file that cannot be parsed is refused, saying why", async () => {
  const dir = await scratch("blazeopt-project-");
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
  const dir = await scratch("blazeopt-project-");
  await writeFile(join(dir, "main.ts"), "export function f(x: number): number { return x; }\n");
  await writeFile(join(dir, "blaze.toml"), [
    'sourceFile = "main.ts"',
    'model = "anthropic/claude-sonnet-4-5"',
    'output = "machine"',
  ].join("\n") + "\n");

  assert.equal((await loadProject(dir)).model, "anthropic/claude-sonnet-4-5");
});

test("a project may name its model as a table", async () => {
  const dir = await scratch("blazeopt-project-");
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
  const dir = await scratch("blazeopt-project-");
  await writeFile(join(dir, "main.ts"), "export function f(x: number): number { return x; }\n");
  await writeFile(join(dir, "blaze.toml"), 'sourceFile = "main.ts"\n');

  assert.equal((await loadProject(dir)).model, null);
});

test("a project's model that cannot be used is refused, saying why", async () => {
  const dir = await scratch("blazeopt-project-");
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
  const dir = await scratch("blazeopt-project-");
  await writeFile(join(dir, "main.ts"), "export function f(x: number): number { return x; }\n");
  await writeFile(join(dir, "blaze.toml"), 'sourceFile = "main.ts"\nmodel = "openai/gpt-5"\n');
  const project = await loadProject(dir);

  assert.equal(modelToAsk(project), "openai/gpt-5");
  assert.match(modelProblem(project) ?? "", /missing API key for provider "openai"/);
});

test("a project that names no model of its own leaves the environment's", async () => {
  without(["AI_MODEL", "ANTHROPIC_API_KEY", "AI_API_KEY", "OPENAI_API_KEY"]);
  const dir = await scratch("blazeopt-project-");
  await writeFile(join(dir, "main.ts"), "export function f(x: number): number { return x; }\n");
  await writeFile(join(dir, "blaze.toml"), 'sourceFile = "main.ts"\n');
  const project = await loadProject(dir);

  assert.equal(modelToAsk(project), null);
  assert.match(modelProblem(project) ?? "", /names no model/);
});

test("the environment's model wins over the project's own", async () => {
  process.env["AI_MODEL"] = "anthropic/claude-sonnet-4-5";
  const dir = await scratch("blazeopt-project-");
  await writeFile(join(dir, "main.ts"), "export function f(x: number): number { return x; }\n");
  await writeFile(join(dir, "blaze.toml"), 'sourceFile = "main.ts"\nmodel = "openai/gpt-5"\n');
  const project = await loadProject(dir);

  assert.equal(modelToAsk(project), "anthropic/claude-sonnet-4-5");
});

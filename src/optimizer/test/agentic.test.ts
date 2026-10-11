/**
 * Where the coding agent is started, what it is given, and who writes.
 *
 * The agent is started at the base of the repository rather than in the
 * compiler directory, because the repository's own instructions are at the
 * head of it, and it is handed that file by name so it does not depend on
 * finding it. The model a run asks is the compiler's own answer to the same
 * question, and a run that cannot ask one is refused before it spends
 * anything.
 */

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { agentInstallProblem, agentModelProblem, agentProblem, agentInvocation } from "../agentic.ts";
import type { ProjectInfo } from "../project.ts";
import { scratch } from "./scratch.ts";

/** A scratch repository with a compiler directory and an instruction file. */
async function repository(): Promise<string> {
  const dir = await scratch("blazeopt-agent-");
  await mkdir(join(dir, "src", "compiler"), { recursive: true });
  await writeFile(join(dir, "AGENTS.md"), "# Instructions\n\n- Run the tests.\n");
  return dir;
}

/** The command one request builds, given what a run has. */
function invocation(
  cwd: string,
  model: string | null = "anthropic/claude-sonnet-4-5",
  showOutput = false,
): {
  command: string;
  args: string[];
  cwd: string;
} {
  const built = agentInvocation({
    method: "code-review",
    context: "",
    model,
    instructions: join(cwd, "AGENTS.md"),
    cwd,
    showOutput,
  });
  return { command: built.command, args: [...built.args], cwd: built.cwd };
}

test("the coding agent is started at the base of the repository", async () => {
  const dir = await repository();

  const run = invocation(dir);

  assert.equal(run.cwd, dir);
  assert.equal(run.command, "pi");
  // The instruction file at the head of the repository is handed to it by
  // name, so the run does not depend on the agent's discovery finding it.
  assert.equal(run.args[0], "--append-system-prompt");
  assert.equal(run.args[1], join(dir, "AGENTS.md"));
  assert.equal(run.args[run.args.indexOf("")], undefined);
  // The model the run asks is the compiler's own answer, `provider/model`.
  const model = run.args.indexOf("--model");
  assert.equal(run.args[model + 1], "anthropic/claude-sonnet-4-5");
  // Print mode: one prompt, the agent works, and its answer is what comes back.
  assert.equal(run.args[run.args.lastIndexOf("--print") + 1], promptOf({
    method: "code-review",
    context: "",
    model: "anthropic/claude-sonnet-4-5",
    instructions: join(dir, "AGENTS.md"),
    cwd: dir,
  }));
});

test("the agent is asked for the compiler, and told where it is", () => {
  const prompt = promptOf({
    method: "code-review",
    context: "",
    model: null,
    instructions: "/repo/AGENTS.md",
    cwd: "/repo",
  });

  assert.match(prompt, /src\/compiler/);
  assert.match(prompt, /AGENTS\.md/);
});

test("what a method gathered is part of what the agent is given", () => {
  const research = promptOf({
    method: "research",
    context: "Convex vectorization hoists invariants.",
    model: null,
    instructions: "/repo/AGENTS.md",
    cwd: "/repo",
  });
  assert.match(research, /research run/);
  assert.match(research, /Convex vectorization hoists invariants/);

  const feedback = promptOf({
    method: "build-feedback",
    context: "-- answer ir 1.1 --\nthe answer the reviewer could not read",
    model: null,
    instructions: "/repo/AGENTS.md",
    cwd: "/repo",
  });
  assert.match(feedback, /build-feedback run/);
  assert.match(feedback, /the answer the reviewer could not read/);
});

test("the project a run is aimed at is part of what the agent is given", () => {
  const prompt = promptOf({
    method: "code-review",
    context: "",
    model: null,
    instructions: "/repo/AGENTS.md",
    cwd: "/repo",
    project: projectOf("/repo/project/blaze.toml"),
  });

  assert.match(prompt, /\/repo\/project\/blaze\.toml/);
  assert.match(prompt, /a spectral norm/);
});

test("the event mode is asked only when the work is to be shown", async () => {
  const dir = await repository();

  // The mode it is asked in by default writes its answer at the end and
  // nothing on the way, which is all a run that is not showing the work
  // wants of it.
  const plain = invocation(dir);
  assert.equal(plain.args.includes("--mode"), false);

  // The event mode carries every tool it calls as it calls it, which is the
  // only stream that says what it is doing while it does it.
  const shown = invocation(dir, "anthropic/claude-sonnet-4-5", true);
  const mode = shown.args.indexOf("--mode");
  assert.equal(shown.args[mode + 1], "json");
  // It is still print mode: one prompt, and its answer is the end of the run.
  assert.notEqual(shown.args.indexOf("--print"), -1);
});

test("a recorded answer is not a model that can write code", () => {
  assert.match(agentModelProblem("replay:./candidate.json") ?? "", /recorded answer/);
  // A model the compiler can be asked is one the agent can be asked too.
  assert.equal(agentModelProblem("anthropic/claude-sonnet-4-5"), null);
  assert.equal(agentModelProblem(null), null);
});

test("an instruction file that is not there is said about, by name", async () => {
  const empty = await scratch("blazeopt-agent-");

  assert.match(agentProblem(null, "node", empty) ?? "", /AGENTS\.md is not there/);
});

test("a command that is not on PATH is said about by name", () => {
  assert.match(agentInstallProblem("blazeopt-no-such-command") ?? "", /could not be run/);
  assert.match(agentInstallProblem("blazeopt-no-such-command") ?? "", /blazeopt-no-such-command/);
});

test("a repository holding everything the agent needs is one it can be asked in", async () => {
  const dir = await repository();

  // `node` stands for the agent here: it is a command that runs and answers,
  // and what is being asked is whether the run is refused before it starts.
  assert.equal(agentProblem(null, "node", dir), null);
});

/** The prompt one request builds. The question of showing the work is asked
 *  of the stream rather than of the prompt, so it is not part of it. */
function promptOf(request: Omit<Parameters<typeof agentInvocation>[0], "showOutput">): string {
  // The prompt is the `--print` argument, which is the last one given.
  const args = [...agentInvocation({ ...request, showOutput: false }).args];
  const index = args.indexOf("--print");
  assert.notEqual(index, -1);
  return args[index + 1] ?? "";
}

/** A project the run is aimed at, with the shape `ProjectInfo` holds. */
function projectOf(tomlPath: string): ProjectInfo {
  return {
    tomlPath,
    directory: "/repo/project",
    sourcePath: "/repo/project/main.ts",
    source: "export function f(): number { return 1; }",
    context: "a spectral norm over two arrays",
    model: null,
    benchmark: {
      command: "./project 16",
      directory: "/repo/project",
      program: "project",
    },
  };
}

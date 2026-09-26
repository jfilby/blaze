import assert from "node:assert/strict";
import { test } from "node:test";
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../core/process.ts";

const CLI = new URL("../cli.ts", import.meta.url).pathname;
const EXAMPLE = new URL("../../examples/hello_world", import.meta.url).pathname;
const REPLAY = new URL("./fixtures/hello-world-replay.json", import.meta.url).pathname;

/** A project directory named after the project it contains, as the example is. */
async function projectDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "blaze-cli-"));
  const directory = join(root, "hello_world");
  await cp(EXAMPLE, directory, { recursive: true });
  return directory;
}

/**
 * The example project names its model in blaze.json, so the tests override it
 * on the command line, which is also how the precedence is exercised.
 */
function blaze(directory: string, ...args: string[]) {
  return run(process.execPath, [CLI, ...args, `--model=replay:${REPLAY}`], {
    cwd: directory,
    env: { AI_MODEL: "openrouter/should-not-be-used" },
    timeoutMs: 300_000,
  });
}

test("build with no argument builds the blaze.json in the current directory", async () => {
  const directory = await projectDirectory();
  const execution = blaze(directory, "build");

  assert.equal(execution.code, 0, execution.stderr);
  assert.match(execution.stdout, /Correctness verified/);
  assert.match(execution.stdout, /Output \(machine\)/);

  const delivered = join(directory, ".blaze/projects/hello_world/output/hello_world");
  // The example entry module is a program, so the delivered binary is that
  // program: it prints what main.ts prints, whatever it is given on stdin.
  const result = run(delivered, [], { input: "run\n3 3 3\n", timeoutMs: 60_000 });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "starting: dot product of 4 elements\ndone: dot product = 70\n");
});

test("generate with no argument uses the same default", async () => {
  const directory = await projectDirectory();
  const execution = blaze(directory, "generate");
  assert.equal(execution.code, 0, execution.stderr);
  assert.match(execution.stdout, /Project: \.blaze\/projects\/hello_world/);
});

test("an explicit path still builds, and the state lands in the current directory", async () => {
  const directory = await projectDirectory();
  const execution = blaze(directory, "build", join(EXAMPLE, "blaze.json"));
  assert.equal(execution.code, 0, execution.stderr);
  assert.match(execution.stdout, /projects\/hello_world\/output\/hello_world/);
});

test("without a blaze.json the default says what to do", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blaze-cli-empty-"));
  const execution = blaze(directory, "build");

  assert.notEqual(execution.code, 0);
  assert.match(execution.stderr, /no blaze\.json in/);
  assert.match(execution.stderr, /blaze build <input\.json>/);
});

test("an unknown command prints the usage and fails", async () => {
  const directory = await projectDirectory();
  const execution = blaze(directory, "frobnicate");
  assert.notEqual(execution.code, 0);
  assert.match(execution.stderr, /unknown command "frobnicate"/);
});

test("the model is named before the work starts, and on failure too", async () => {
  const directory = await projectDirectory();
  const built = blaze(directory, "build");
  assert.match(built.stdout, new RegExp(`^\\u00b7 Model: replay:${REPLAY}`, "m"));

  // The model is named first, so it is on record even when the build fails.
  const unreachable = await mkdtemp(join(tmpdir(), "blaze-cli-nokey-"));
  await cp(EXAMPLE, unreachable, { recursive: true });
  const failed = run(process.execPath, [CLI, "build", "--model", "openai/gpt-5"], {
    cwd: unreachable,
    env: { OPENAI_API_KEY: "", AI_API_KEY: "", AI_MODEL: "" },
    timeoutMs: 300_000,
  });
  assert.notEqual(failed.code, 0);
  assert.match(failed.stdout, /\u00b7 Model: openai\/gpt-5/);
  assert.match(failed.stderr, /missing API key for provider "openai"/);
});

test("test and projects name the model as well", async () => {
  const directory = await projectDirectory();
  assert.equal(blaze(directory, "build").code, 0);

  const verified = blaze(directory, "test", "hello_world");
  assert.equal(verified.code, 0, verified.stderr);
  assert.match(verified.stdout, /\u00b7 Model: replay:/);

  const listed = blaze(directory, "projects");
  assert.match(listed.stdout, new RegExp(`hello_world\\s+success\\s+\\S+\\s+replay:`));
});

test("help lists every command", async () => {
  const directory = await projectDirectory();
  const execution = blaze(directory, "--help");
  assert.equal(execution.code, 0);
  for (const command of ["build", "generate", "test", "benchmark", "inspect", "projects"]) {
    assert.match(execution.stdout, new RegExp(`blaze ${command}`));
  }
});

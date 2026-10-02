import assert from "node:assert/strict";
import { test } from "node:test";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { run } from "../core/process.ts";
import { writeProject } from "./project.ts";

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
 * The example project names its model in blaze.toml, so the tests override it
 * on the command line, which is also how the precedence is exercised.
 */
function blaze(directory: string, ...args: string[]) {
  return run(process.execPath, [CLI, ...args, `--model=replay:${REPLAY}`], {
    cwd: directory,
    env: { AI_MODEL: "openrouter/should-not-be-used" },
    timeoutMs: 300_000,
  });
}

test("build with no argument builds the blaze.toml in the current directory", async () => {
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
  // The project is named by an explicit path, the state by the directory the
  // build runs in: the two are different directories here, which is the point.
  const project = await projectDirectory();
  const directory = await mkdtemp(join(tmpdir(), "blaze-cli-elsewhere-"));
  const execution = blaze(directory, "build", join(project, "blaze.toml"));
  assert.equal(execution.code, 0, execution.stderr);
  assert.match(execution.stdout, /projects\/hello_world\/output\/hello_world/);
});

test("without a blaze.toml the default says what to do", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blaze-cli-empty-"));
  const execution = blaze(directory, "build");

  assert.notEqual(execution.code, 0);
  assert.match(execution.stderr, /no blaze\.toml in/);
  assert.match(execution.stderr, /blaze build <input\.toml>/);
});

test("init writes a project file that builds machine code", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blaze-init-"));
  const created = await run(process.execPath, [CLI, "init"], { cwd: directory });
  assert.equal(created.code, 0, created.stderr);
  assert.match(created.stdout, /created .*blaze\.toml/);

  // The file init writes is a project the compiler reads, not a sketch of one.
  await writeFile(join(directory, "main.ts"), "console.log(1 + 2);\n", "utf8");
  const built = blaze(directory, "build");
  assert.equal(built.code, 0, built.stderr);
  assert.match(built.stdout, /Output \(machine\)/);

  // Machine code is the default, so an object arrives with no toolchain asked
  // for, and it is a program that runs.
  const project = basename(directory);
  const delivered = join(directory, ".blaze/projects", project, "output", project);
  const executed = run(delivered, [], { timeoutMs: 60_000 });
  assert.equal(executed.code, 0, executed.stderr);
  assert.equal(executed.stdout, "3\n");
});

test("init refuses to write over a project file, and leaves it as it was", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blaze-init-twice-"));
  assert.equal((await run(process.execPath, [CLI, "init"], { cwd: directory })).code, 0);

  const written = 'language = "typescript"\nsource = "console.log(1);"\n';
  const path = join(directory, "blaze.toml");
  await writeFile(path, written, "utf8");

  const again = await run(process.execPath, [CLI, "init"], { cwd: directory });
  assert.notEqual(again.code, 0);
  assert.match(again.stderr, /blaze\.toml already exists/);
  // A refusal that overwrote would take the project it refused to replace with
  // it, so the file the user wrote is the file still on disk.
  assert.equal(await readFile(path, "utf8"), written);
});

test("a source file handed to build is not a project file", async () => {
  const directory = await projectDirectory();
  const execution = blaze(directory, "build", join(directory, "main.ts"));

  assert.notEqual(execution.code, 0);
  assert.match(execution.stderr, /main\.ts is a source file, not a project file/);
  assert.match(execution.stderr, /blaze\.toml beside it/);
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
  // The mode is the first line of a build, and it is the mode the project
  // named, with the flags that mode is built with.
  assert.equal(built.stdout.split("\n")[0], "· Mode: release (-O3 -fno-math-errno -fno-trapping-math -flto -ffat-lto-objects)");

  assert.match(built.stdout, new RegExp(`^\\u00b7 Model: replay:${REPLAY}`, "m"));

  // The model is named before any work starts, so it is on record even when
  // the build fails.
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
  for (const command of ["build", "generate", "test", "benchmark", "inspect", "projects", "init"]) {
    assert.match(execution.stdout, new RegExp(`blaze ${command}`));
  }
});

test("a build that is not on a terminal leaves the title alone", async () => {
  // The tests run blaze with a pipe, not a terminal, which is the case that
  // must stay silent: an OSC escape in a log file is corruption.
  const directory = await projectDirectory();
  const execution = blaze(directory, "build");

  assert.equal(execution.code, 0, execution.stderr);
  assert.doesNotMatch(execution.stdout, /\u001b]0;/);
});

/** The build record as it is on the disk, which is what a reader opens. */
async function readBuildRecord(path: string): Promise<{ engine?: string; recompiled?: boolean }> {
  return JSON.parse(await readFile(path, "utf8")) as { engine?: string; recompiled?: boolean };
}

/**
 * A review that finds nothing to change, which is what most rounds answer, so
 * a build driven from a replay fixture spends nothing and asks nothing.
 */
const SOUND = "verdict: sound\nreason: the body computes what the contract states, and no rule applies to it";

/** A library project of its own, so the test builds no example it needs. */
async function libraryProject(name: string): Promise<{ directory: string; replay: string }> {
  const directory = await mkdtemp(join(tmpdir(), `blaze-cli-${name}-`));
  await writeProject(join(directory, "input.toml"), {
    language: "nim",
    source: ["proc square(x: float32): float32 =", "  result = x * x", ""].join("\n"),
    entry: "square",
    output: "ir",
    generation: { maxCandidates: 1, maxAttempts: 1 },
  });
  const replay = join(directory, "reviews.json");
  await writeFile(replay, JSON.stringify({ reviews: [SOUND] }), "utf8");
  return { directory, replay };
}

test("--recompile rebuilds what the last build proved, and refuses to be paired with --reuse", async () => {
  const { directory, replay } = await libraryProject("recompile");
  const build = (...flags: string[]) =>
    run(process.execPath, [CLI, "build", "input.toml", `--model=replay:${replay}`, ...flags], {
      cwd: directory,
      timeoutMs: 300_000,
    });

  const first = build();
  assert.equal(first.code, 0, first.stderr);

  // The engine is what a later run compares against, so the record a reader
  // opens says which compiler produced the artifact it names.
  const record = join(directory, ".blaze/projects/input/build.json");
  const stored = await readBuildRecord(record);
  assert.match(stored.engine ?? "", /^0\.1\.0\+[0-9a-f]{8}$/, JSON.stringify(stored));

  // Nothing about the project changed, so this build is one a plain run would
  // have reused whole. `--recompile` rebuilds it anyway, and the record says so
  // rather than only the log.
  const plain = build();
  assert.equal(plain.code, 0, plain.stderr);
  assert.match(plain.stdout, /was not rebuilt/, "a plain build did not reuse what the first one proved");

  const forced = build("--recompile");
  assert.equal(forced.code, 0, forced.stderr);
  assert.doesNotMatch(forced.stdout, /was not rebuilt/, "a recompile reused what the build before it proved");
  assert.equal((await readBuildRecord(record)).recompiled, true);

  const refused = build("--recompile", "--reuse");
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /--recompile and --reuse ask for opposite builds/);
});

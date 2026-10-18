import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runBuild } from "../compiler.ts";
import { scratch } from "./scratch.ts";
import { run } from "../core/process.ts";
import { writeProject } from "./project.ts";

const QUIET = { stage: () => {} };

const SOURCE = "const p = new Promise((resolve) => resolve(42));\nconsole.log(await p);\n";

async function buildBinary(backend: "c" | "machine"): Promise<string> {
  const directory = await scratch(`blaze-promise-${backend}-`);
  await writeFile(join(directory, "main.ts"), SOURCE, "utf8");
  await writeProject(join(directory, "blaze.toml"), {
    language: "typescript",
    sourceFile: "main.ts",
    output: "machine",
    backend,
    mode: "debug",
  });
  const outcome = await runBuild(
    "blaze.toml",
    { cwd: directory, reuse: false, model: "openai-compatible/stub", maxAttempts: 1 },
    QUIET,
    "build",
  );
  assert.equal(outcome.build.status, "success", `${backend} build succeeded`);
  assert.ok(outcome.outputPath !== null, `${backend} build delivered a binary`);
  return outcome.outputPath as string;
}

for (const backend of ["c", "machine"] as const) {
  test(`${backend} backend supports promise runtime`, async () => {
    const binary = await buildBinary(backend);
    const delivered = run(binary, [], { timeoutMs: 60_000 });
    assert.equal(delivered.code, 0, delivered.stderr);
    assert.equal(delivered.stdout, "42\n");
  });
}

const SOURCE_VAR = "const x = 7;\nconst p = new Promise((resolve) => resolve(x));\nconsole.log(await p);\n";

async function buildVar(backend: "c" | "machine"): Promise<string> {
  const directory = await scratch(`blaze-promise-var-${backend}-`);
  await writeFile(join(directory, "main.ts"), SOURCE_VAR, "utf8");
  await writeProject(join(directory, "blaze.toml"), {
    language: "typescript",
    sourceFile: "main.ts",
    output: "machine",
    backend,
    mode: "debug",
  });
  const outcome = await runBuild(
    "blaze.toml",
    { cwd: directory, reuse: false, model: "openai-compatible/stub", maxAttempts: 1 },
    QUIET,
    "build",
  );
  assert.equal(outcome.build.status, "success", `${backend} build succeeded`);
  assert.ok(outcome.outputPath !== null, `${backend} build delivered a binary`);
  return outcome.outputPath as string;
}

for (const backend of ["c", "machine"] as const) {
  test(`${backend} backend resolves with a captured variable`, async () => {
    const binary = await buildVar(backend);
    const delivered = run(binary, [], { timeoutMs: 60_000 });
    assert.equal(delivered.code, 0, delivered.stderr);
    assert.equal(delivered.stdout, "7\n");
  });
}

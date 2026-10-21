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

/** A program whose executor names its resolve and reject the long way. */
const SOURCE_NAMED =
  "const p = new Promise(function (onFulfilled, onRejected) { onFulfilled(42); });\nconsole.log(await p);\n";

async function buildBinary(backend: "c" | "machine"): Promise<string> {
  return buildSource(backend, SOURCE, `blaze-promise-${backend}-`);
}

/** The binary a program of this source is built into. */
async function buildSource(backend: "c" | "machine", source: string, name: string): Promise<string> {
  const directory = await scratch(`${name}-`);
  await writeFile(join(directory, "main.ts"), source, "utf8");
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

for (const backend of ["c", "machine"] as const) {
  test(`${backend} backend resolves with the names an executor is written by`, async () => {
    // The executor names its resolve and reject `onFulfilled` and
    // `onRejected`, and the promise is settled by the names the source used.
    const binary = await buildSource(backend, SOURCE_NAMED, `blaze-promise-named-${backend}`);
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

/**
 * A program whose captured name is written before the promise is made.
 *
 * The name is read by the executor, and the executor is handed the name rather
 * than the value, so the write that gave the name its value is a write the
 * program sees. A pass that counts the reads of a body by the values alone
 * does not see the capture — the name is written down as text and not as a
 * value — and concludes that nothing reads the name, and drops the write.
 */
const SOURCE_WRITTEN = [
  "let x = 7;",
  "x = 9;",
  "const p = new Promise((resolve) => resolve(x));",
  "console.log(await p);",
  "",
].join("\n");

for (const backend of ["c", "machine"] as const) {
  test(`${backend} backend resolves with a captured name that was written`, async () => {
    const binary = await buildSource(backend, SOURCE_WRITTEN, `blaze-promise-written-${backend}`);
    const delivered = run(binary, [], { timeoutMs: 60_000 });
    assert.equal(delivered.code, 0, delivered.stderr);
    assert.equal(delivered.stdout, "9\n");
  });
}

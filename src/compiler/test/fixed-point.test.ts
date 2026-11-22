/**
 * The self-hosting fixed point, as an opt-in integration test.
 *
 * A fixed point is three builds of the same tree: the Node compiler builds
 * stage 1, stage 1 builds stage 2, and stage 2 builds stage 3. The stages are
 * compared on what a build answers — the IR text of a function — not on the
 * bytes of the binaries, which a timestamp or a linker's own ordering changes.
 *
 * Three compiler builds take minutes each and need a C toolchain, so the test
 * runs only when BLAZE_FIXED_POINT is set. The unit suite stays fast; a release
 * check sets the variable and runs this file on its own.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { run } from "../core/process.ts";

const enabled = process.env["BLAZE_FIXED_POINT"] === "1";
const root = resolve(import.meta.dirname ?? ".", "..");
const project = join(root, "blaze.toml");
const state = join(root, ".blaze");

interface BuildStatus {
  status?: string;
  output?: string;
}

function inspect(compiler: string[]): BuildStatus {
  const result = run(compiler[0] as string, [...compiler.slice(1), "inspect", "compiler"], {
    cwd: root,
    timeoutMs: 60 * 1000,
  });
  assert.equal(result.code, 0, `${compiler.join(" ")} inspect failed:\n${result.stderr}`);
  return JSON.parse(result.stdout) as BuildStatus;
}

/** The binary a stage delivered, which the next stage runs. */
function delivered(compiler: string[]): string {
  const status = inspect(compiler);
  assert.equal(status.status, "success", `the stage did not build: ${JSON.stringify(status)}`);
  assert.ok(status.output !== undefined, "the stage has no output path");
  const binary = resolve(state, status.output as string);
  assert.ok(existsSync(binary), `the stage did not deliver ${binary}`);
  return binary;
}

function build(compiler: string[]): void {
  // A recompile reviews every one of the compiler's ~7700 functions from the
  // semantic IR before any code is generated. That is a CPU-bound pass over the
  // whole module graph and takes around ninety minutes, so the old half-hour
  // limit killed a build that was still making progress rather than one that
  // had failed.
  const result = run(compiler[0] as string, [...compiler.slice(1), "build", project, "--recompile", "--verify", "none"], {
    cwd: root,
    timeoutMs: 3 * 60 * 60 * 1000,
  });
  assert.equal(result.code, 0, `${compiler.join(" ")} failed:\n${result.stderr}\n${result.stdout}`);
}

function ir(compiler: string[], fn: string): string {
  const result = run(compiler[0] as string, [...compiler.slice(1), "ir", project, "--function", fn], {
    cwd: root,
    timeoutMs: 10 * 60 * 1000,
  });
  assert.equal(result.code, 0, `${compiler.join(" ")} ir ${fn} failed:\n${result.stderr}`);
  return result.stdout;
}

test("the native compiler reaches a fixed point over the compiler tree", { skip: !enabled }, () => {
  // Stage 1 is built by Node from the installed tree.
  const node = ["node", join(root, "cli.ts")];
  build(node);
  const stage1 = delivered(node);

  // Stage 2 and stage 3 are built by the previous stage's binary.
  const one = [stage1];
  build(one);
  const stage2 = delivered(one);

  const two = [stage2];
  build(two);
  const stage3 = delivered(two);

  // The IR a stage answers for the same function is the fixed point: a
  // difference means a stage changed what it resolves from the same source.
  const functions = ["runBuild", "contractPhaseFor", "programValue", "describeModule"];
  for (const fn of functions) {
    const fromOne = ir(one, fn);
    const fromTwo = ir(two, fn);
    const fromThree = ir([stage3], fn);
    assert.equal(fromTwo, fromOne, `${fn} changed between stage 1 and stage 2`);
    assert.equal(fromThree, fromTwo, `${fn} changed between stage 2 and stage 3`);
  }
});

/**
 * The language features a source may use without a desugaring pass: a default
 * parameter, a result a function does not state, and a constant a function
 * reads from the file it was written in.
 *
 * Each is checked through the IR and then through a program the build delivers,
 * because the two halves are different claims: the IR says what the compiler
 * read, and the program says the value the language would have computed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runBuild } from "../compiler.ts";
import { run } from "../core/process.ts";
import { irOf, phaseOf, programOf } from "./phase.ts";
import { scratch } from "./scratch.ts";
import { writeProject } from "./project.ts";

const REPLAY = new URL("./fixtures/dot-product-replay.json", import.meta.url).pathname;
const QUIET = { stage: () => {} };

/** Builds a program and answers the binary and the directory it was built in. */
async function build(source: string): Promise<{ directory: string; binary: string }> {
  const directory = await scratch("blaze-language-feature-");
  await writeFile(join(directory, "main.ts"), source, "utf8");
  await writeProject(join(directory, "blaze.toml"), {
    language: "typescript",
    sourceFile: "main.ts",
    model: { provider: "replay", file: REPLAY },
    output: "machine",
  });
  const outcome = await runBuild(
    "blaze.toml",
    { cwd: directory, reuse: false, model: `replay:${REPLAY}` },
    QUIET,
    "build",
  );
  assert.ok(outcome.outputPath !== null, "a program build delivers its binary");
  return { directory, binary: outcome.outputPath as string };
}

/** Builds a program and checks it prints what the source prints under node. */
async function agreesWithNode(source: string): Promise<string> {
  const { directory, binary } = await build(source);
  const original = run("node", ["--experimental-strip-types", "main.ts"], { cwd: directory, timeoutMs: 60_000 });
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(original.code, 0, original.stderr);
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, original.stdout);
  return delivered.stdout;
}

test("a default parameter makes a function callable at the shorter arity", () => {
  // The full function takes every parameter, and each shorter arity is a
  // function of the module whose body fills the defaults the source wrote. A
  // parameter with a default and no type is held at the type the default is.
  const source = [
    "export function add(a: number, b: number = 10): number { return a + b; }",
    "export function scale(a: number, by = 2): number { return a * by; }",
    "",
  ].join("\n");
  const functions = programOf("typescript", { "module.ts": source }, "module.ts").files[0]?.functions ?? {};
  assert.ok(functions["add__1"], "the shorter arity is a function of the module");
  assert.ok(functions["scale__1"], "an untyped default still makes the shorter arity");
  assert.equal(functions["add"]?.function.params.length, 2);
  assert.equal(functions["add__1"]?.function.params.length, 1);
  assert.equal(functions["scale"]?.function.params[1]?.type, "f64");
});

test("a function that states no result is typed by the returns it has", () => {
  // A return over two `u256` names is a `u256`, which is what lets `invert`
  // answer a wide number without the source writing the annotation.
  const source = [
    "function half(n: u256, d: u256): u256 { return n % d; }",
    "console.log(half(7n, 2n).toString(16));",
    "",
  ].join("\n");
  assert.match(irOf("typescript", { "main.ts": source }, "main.ts", "half"), /^function half\(n: u256, d: u256\) -> u256$/m);
});

test("a function reads a constant the file declares, in the source's order", async () => {
  // The constant is written after the function that reads it, which is the
  // order the benchmark writes its curve. A compiled function has no scope to
  // read the file from, so the value the constant is written as is read where
  // the source reads the name.
  const output = await agreesWithNode([
    "function floorValue(a: u256): u256 { return a % CURVE.P; }",
    "const CURVE = { P: 2n ** 32n + 1n };",
    "console.log(floorValue(0x1234567890abcdefn).toString(16));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), ((0x1234567890abcdefn % (2n ** 32n + 1n)).toString(16)));
});

test("a function that reads a value the program holds stays a function of the program", async () => {
  // A constant written as a constant expression is the module's, and a function
  // that reads one is compiled with the module. A value the program computes
  // while it runs is not: the function that reads it is compiled where the
  // value is, so the name it reads is the one the program holds, not a name the
  // module has no scope for.
  const output = await agreesWithNode([
    "const base = Math.floor(2.5) + 10;",
    "function bump(x: number): number { return x + base; }",
    "console.log(bump(1));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "13");
});

test("a function declared after a statement is compiled with the module", async () => {
  // A function declaration is hoisted: the file's functions are the module's
  // wherever they are written, so the statements that run before one do not
  // decide whether it is compiled, and a program and the functions it calls are
  // one source rather than one source reordered.
  const source = [
    "console.log(later() + 1);",
    "function later(): number { return 2; }",
    "",
  ].join("\n");
  const functions = phaseOf("typescript", { "main.ts": source }, "main.ts").program.files[0]?.functions ?? {};
  assert.ok(functions["later"], "the function written after the statement is the module's");
  const output = await agreesWithNode(source);
  assert.equal(output.trim(), "3");
});

test("a name a function declares is not the file's constant", async () => {
  // A parameter spelled like a constant of the file is the parameter: the
  // constant is not read where the body declared its own name.
  const output = await agreesWithNode([
    "const P = 100n;",
    "console.log(kept(3n));",
    "function kept(P: u256): u256 { return P; }",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "3n");
});

test("a default that calls is evaluated once, with the receiver still intact", async () => {
  // A wide default is a call of its own. A call written among the arguments
  // runs while the receiver is pinned in a register the callee writes over, so
  // the default is read under a name before the call: the value the callee is
  // handed outlives every call between the two.
  const output = await agreesWithNode([
    "function twice(a: u256): u256 { return a + a; }",
    "function times(x: u256, factor: u256 = twice(x)): u256 { return x * factor; }",
    "console.log(times(3n).toString(16));",
    "",
  ].join("\n"));
  assert.equal(output.trim(), "12");
});

/**
 * A program built as WebAssembly.
 *
 * A program is one module: every function of it is in the module, a call of
 * another function of the program is a call of the index that function has in
 * it, and the body of the program is the entry of the module. The host that
 * runs it is the driver the C backend writes in C, written here as the module's
 * own function.
 *
 * Every case here is run: the module is emitted, the engine validates it, and
 * the host the build ships runs it. What it prints is compared with what the
 * source prints, because the source is the specification of a program.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { buildProgramModule, describeModule, programModuleBytes } from "../toolchain/ir-wasm.ts";
import { phaseOf, semanticsOf } from "./phase.ts";
import { resolveProgram } from "../semantics/ir-resolve.ts";
import { run } from "../core/process.ts";
import { runBuild } from "../compiler.ts";
import { writeProject } from "./project.ts";
import { scratch } from "./scratch.ts";
import type { SemanticFunction } from "../core/semantic-ir.ts";

/** A review that finds nothing to change, which is what most rounds answer. */
const REPLAY = new URL("./fixtures/dot-product-replay.json", import.meta.url).pathname;
const quiet = { stage: () => {} };

/** The files of a program, and the file its body is in. */
const PROGRAM = {
  "main.ts": [
    'import { twice, square } from "./lib.ts";',
    "",
    "console.log(twice(21));",
    "console.log(square(3));",
    "",
  ].join("\n"),
  "lib.ts": [
    'import { plus } from "./plus.ts";',
    "",
    "export function twice(x: number): number {",
    "  return plus(x, x);",
    "}",
    "",
    "export function square(x: number): number {",
    "  return plus(x, x) + x;",
    "}",
    "",
  ].join("\n"),
  "plus.ts": ["export function plus(a: number, b: number): number {", "  return a + b;", "}", ""].join("\n"),
};

/**
 * Contracts a program, lowers it into one module and runs it.
 *
 * The module is written where the host can find it and the host is run the
 * way the build runs it, so what the case reads is what a build would read.
 */
async function runProgram(
  files: Record<string, string>,
  entryFile: string,
): Promise<{ stdout: string; stderr: string; code: number; listing: string }> {
  const phase = phaseOf("typescript", files, entryFile);
  assert.ok(phase.body !== undefined, "the entry file is a program and not a library");
  const driver = resolveProgram(phase.body, phase.program);
  const semantics = semanticsOf(phase);
  const directory = await scratch("blaze-wasm-program-");
  const built = await buildProgramModule({
    functions: Object.values(semantics).map((fn) => ({ fn })),
    entry: driver.entry,
    modulePath: join(directory, "program.wasm"),
    hostPath: join(directory, "program.host.mjs"),
  });
  const result = run(process.execPath, [built.hostPath, built.modulePath], { timeoutMs: 60_000 });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code ?? -1,
    listing: describeModule(await readBytes(built.modulePath)),
  };
}

/** The bytes of a file the build wrote. */
async function readBytes(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path));
}

/**
 * What the source of a program prints, which is what a program has to print.
 *
 * The source is run by the toolchain of its language, the way the build runs
 * it when it checks a program against its own source.
 */
async function sourceOutput(files: Record<string, string>, entryFile: string): Promise<string> {
  const directory = await scratch("blaze-wasm-source-");
  for (const [name, source] of Object.entries(files)) {
    const folder = name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : "";
    if (folder !== "") await mkdir(join(directory, folder), { recursive: true });
    await writeFile(join(directory, name), source, "utf8");
  }
  const result = run(process.execPath, ["--experimental-transform-types", join(directory, entryFile)], {
    cwd: directory,
    timeoutMs: 60_000,
  });
  assert.equal(result.code, 0, result.stderr);
  return result.stdout;
}

test("a program of three functions is one module and prints what its source prints", async () => {
  const result = await runProgram(PROGRAM, "main.ts");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, await sourceOutput(PROGRAM, "main.ts"));
  assert.equal(result.stdout, "42\n9\n");
});

test("the module of a program holds every function of it and the body it runs", async () => {
  const result = await runProgram(PROGRAM, "main.ts");
  // Every function of the program is exported by the module, and the body of
  // the program is the entry of it.
  assert.match(result.listing, /exports:/);
  assert.match(result.listing, /plus \(function \d+\)/);
  assert.match(result.listing, /twice \(function \d+\)/);
  assert.match(result.listing, /square \(function \d+\)/);
  assert.match(result.listing, /__blaze_entry \(function \d+\)/);
  // The code section holds a function for each of them: three of the program
  // and the entry.
  const functions = result.listing.match(/^ {2}function \d+/gm) ?? [];
  assert.equal(functions.length, 4);
});

test("a function that calls another function of the program answers what it answers natively", async () => {
  // `twice` calls `plus`, and the call is a call of the index `plus` has in
  // the module: there is no linker and no symbol table, so the index is a
  // lookup in the table the module holds.
  const result = await runProgram(PROGRAM, "main.ts");
  assert.equal(result.stdout, "42\n9\n");
  // The call is written as a call of the index of the callee, which is past
  // every import the module has.
  assert.match(result.listing, /call \d+/);
});

test("the body of the program is the entry of the module, and it runs when the entry is called", async () => {
  const result = await runProgram(PROGRAM, "main.ts");
  assert.equal(result.stdout, "42\n9\n");
  // The entry is the last function of the module, and it is the one the host
  // calls: the body of the program prints what the program prints.
  const listing = result.listing;
  const entry = listing.indexOf("__blaze_entry");
  assert.ok(entry >= 0, "the module exports the entry of the program");
  assert.ok(listing.indexOf("call") > entry, "the entry calls the functions of the program");
});

test("a call of a function the module does not hold is refused by name", async () => {
  // A module holds every function of the program, and a call of a function it
  // does not hold has nowhere to go: the refusal says which call it is.
  const phase = phaseOf("typescript", PROGRAM, "main.ts");
  const driver = resolveProgram(phase.body as never, phase.program);
  const semantics = semanticsOf(phase);
  const twice = semantics.twice as SemanticFunction;
  assert.throws(
    () =>
      programModuleBytes({
        functions: [{ fn: twice }],
        entry: driver.entry,
      }),
    /a WebAssembly module cannot call plus/,
  );
});

test("a whole number handed to a use that reads a wide number is widened by the kernel", async () => {
  // A wide number is four limbs in the memory and the address of them, so a
  // number cannot be converted into one where it stands: the kernel that
  // builds a wide number out of one word is what does it, and the answer is
  // the same number — the low limb holds the word and the three above it are
  // nothing.
  const files = {
    "main.ts": [
      "export function f(a: u256): u256 {",
      "  return a;",
      "}",
      "console.log(f(5n));",
      "",
    ].join("\n"),
  };
  const result = await runProgram(files, "main.ts");
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "5\n");
});

test("a function that computes a wide number and then calls a function that computes one as well answers what it should", async () => {
  // The scratch of a wide number in flight is a region of the function's own,
  // so the number the callee computes is not written over the number the
  // caller is holding.
  const files = {
    "main.ts": [
      'import { wide } from "./lib.ts";',
      "export function twice(a: u256, b: u256): u256 {",
      "  const sum = a + b;",
      "  return wide(sum, sum);",
      "}",
      "console.log(twice(1n, 2n));",
      "",
    ].join("\n"),
    "lib.ts": [
      "export function wide(a: u256, b: u256): u256 {",
      "  return a + b;",
      "}",
      "",
    ].join("\n"),
  };
  const result = await runProgram(files, "main.ts");
  assert.equal(result.code, 0, result.stderr);
  // One and two are three, and three and three are six.
  assert.equal(result.stdout, "6\n");
});

test("a program reads the command line it was given", async () => {
  // The arguments a program reads are the ones the host was given, past the
  // host itself and the module it runs, which is where the driver of a native
  // program takes them from as well.
  const files = {
    "main.ts": ["console.log(process.argv.length);", "console.log(process.argv[2]);", ""].join("\n"),
  };
  const phase = phaseOf("typescript", files, "main.ts");
  const driver = resolveProgram(phase.body as never, phase.program);
  const directory = await scratch("blaze-wasm-argv-");
  const built = await buildProgramModule({
    functions: [],
    entry: driver.entry,
    modulePath: join(directory, "program.wasm"),
    hostPath: join(directory, "program.host.mjs"),
  });
  const result = run(process.execPath, [built.hostPath, built.modulePath, "7"], { timeoutMs: 60_000 });
  assert.equal(result.code, 0, result.stderr);
  // The count is the length of process.argv: the program, the file it runs,
  // and the argument it was given.
  assert.equal(result.stdout, "3\n7\n");
});

test("an argument is read as the number the language reads it as", async () => {
  // The spaces around an argument are not part of it, a base written before
  // the digits is read in that base, and an argument that is not a number at
  // all is NaN rather than a zero the source never wrote. This is what the
  // driver of a native program does, so the two agree.
  const files = {
    "main.ts": [
      "console.log(process.argv[2]);",
      "console.log(process.argv[3]);",
      "console.log(process.argv[4]);",
      "console.log(process.argv[5]);",
      "",
    ].join("\n"),
  };
  const phase = phaseOf("typescript", files, "main.ts");
  const driver = resolveProgram(phase.body as never, phase.program);
  const directory = await scratch("blaze-wasm-argv-number-");
  const built = await buildProgramModule({
    functions: [],
    entry: driver.entry,
    modulePath: join(directory, "program.wasm"),
    hostPath: join(directory, "program.host.mjs"),
  });
  const result = run(process.execPath, [built.hostPath, built.modulePath, "0b101", " 10 ", "abc", "42"], {
    timeoutMs: 60_000,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "5\n10\nNaN\n42\n");
});

test("a build of a program delivers one module and one host, and the program prints what its source prints", async () => {
  // The whole build: every function of the program is compiled, the module that
  // holds them is written, the host runs it, and what it prints is compared
  // with what the source prints.
  const directory = await scratch("blaze-wasm-build-");
  for (const [name, source] of Object.entries(PROGRAM)) {
    await writeFile(join(directory, name), source, "utf8");
  }
  await writeProject(join(directory, "blaze.toml"), {
    language: "typescript",
    sourceFile: "main.ts",
    model: { provider: "replay", file: REPLAY },
    output: "wasm",
  });
  const outcome = await runBuild(
    "blaze.toml",
    { cwd: directory, reuse: false, model: `replay:${REPLAY}` },
    quiet,
    "build",
  );
  const module = outcome.outputPath;
  assert.ok(module !== null, "a program build delivers its module");
  assert.match(module, /\.wasm$/);
  const original = run("node", ["--experimental-transform-types", join(directory, "main.ts")], {
    cwd: directory,
    timeoutMs: 60_000,
  });
  assert.equal(original.code, 0, original.stderr);
  // The host is delivered beside the module, and the program it runs prints
  // what the source prints.
  const delivered = await readHost(module);
  const result = run(process.execPath, [delivered, module], { cwd: directory, timeoutMs: 60_000 });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, original.stdout);
});

/**
 * The host delivered beside a module, which is what runs it.
 *
 * The build writes the host into the store beside the module, and the store is
 * where the build's own outputs live, so the host is found there.
 */
async function readHost(module: string): Promise<string> {
  const directory = module.replace(/\/[^/]+\.wasm$/, "");
  const { readdir } = await import("node:fs/promises");
  const files = await readdir(directory);
  const host = files.find((name) => name.endsWith(".host.mjs"));
  assert.ok(host !== undefined, "the host is delivered beside the module");
  return join(directory, host);
}

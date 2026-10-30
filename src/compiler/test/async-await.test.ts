/**
 * Async functions and `await`: the value a promise carries, and the promise an
 * async function answers.
 *
 * A compiled program runs a function's body when the function is called, so a
 * promise is settled by the time the call returns. What these tests hold the
 * compiler to is the value that travels: an async function answers a promise
 * carrying what its body returned, `await` reads that value out of it, and a
 * failure an awaited call left pending rejects the promise the async function
 * answers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runBuild } from "../compiler.ts";
import { run } from "../core/process.ts";
import { scratch } from "./scratch.ts";
import { chatEndpoint } from "./model-endpoint.ts";
import { writeProject } from "./project.ts";
import { typeScriptFrontend } from "../semantics/typescript.ts";
import { phaseOf } from "./phase.ts";

const QUIET = { stage: () => {} };
const NIM = run("nim", ["--version"], { timeoutMs: 30_000 }).code === 0;
const SOUND = "verdict: sound\nreason: the body computes what the contract states, and no rule applies to it";

/** The binary a program is built into, and the directory it was written in. */
async function built(
  source: string,
  options: { backend?: "c" | "machine"; runtime?: "nim"; mode?: "debug" | "release" } = {},
): Promise<{ directory: string; binary: string }> {
  const directory = await scratch("blaze-async-");
  await writeFile(join(directory, "main.ts"), source, "utf8");
  await writeProject(join(directory, "blaze.toml"), {
    language: "typescript",
    sourceFile: "main.ts",
    output: "machine",
    backend: options.backend ?? "c",
    mode: options.mode ?? "debug",
    ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
  });
  const outcome = await runBuild(
    "blaze.toml",
    { cwd: directory, reuse: false, model: "openai-compatible/stub", maxAttempts: 1 },
    QUIET,
    "build",
  );
  assert.equal(outcome.build.status, "success", "the program builds");
  assert.ok(outcome.outputPath !== null, "the build delivers a binary");
  return { directory, binary: outcome.outputPath as string };
}

/** The source run by node and the binary run by the machine print the same. */
async function agrees(source: string, options: { backend?: "c" | "machine"; runtime?: "nim" } = {}): Promise<void> {
  const { directory, binary } = await built(source, options);
  const original = run("node", ["main.ts"], { cwd: directory, timeoutMs: 60_000 });
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(original.code, 0, original.stderr);
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, original.stdout);
}

for (const backend of ["c", "machine"] as const) {
  test(`${backend} backend awaits a number an async function answers`, async () => {
    await agrees("async function add(a, b) { return a + b; }\nconsole.log(await add(2, 3));\n", { backend });
  });

  test(`${backend} backend awaits a string an async function answers`, async () => {
    // A parameter is what keeps the function a function of the program: a
    // function whose signature the module can state is contracted instead.
    await agrees(
      "async function f(n) { if (n > 0) return `hi`; return `no`; }\nconsole.log(await f(1));\n",
      { backend },
    );
  });

  test(`${backend} backend awaits a truth an async function answers`, async () => {
    await agrees("async function f(n) { return n > 0; }\nconsole.log(await f(1));\n", { backend });
  });

  test(`${backend} backend awaits an async call inside an async function`, async () => {
    await agrees(
      "async function g(n) { return n; }\nasync function f(n) { return (await g(n)) + 1; }\nconsole.log(await f(2));\n",
      { backend },
    );
  });

  test(`${backend} backend awaits inside an expression and a loop`, async () => {
    await agrees(
      [
        "async function f(n) { return n * 2; }",
        "const doubled = (await f(4)) * 2;",
        "let sum = 0;",
        "for (let i = 0; i < 3; i++) { sum += await f(i); }",
        "console.log(doubled);",
        "console.log(sum);",
        "",
      ].join("\n"),
      { backend },
    );
  });

  test(`${backend} backend awaits a value that is not a promise as itself`, async () => {
    await agrees("const x = await 3;\nconsole.log(x);\n", { backend });
  });

  test(`${backend} backend carries the value a promise is settled with`, async () => {
    await agrees(
      [
        "const number = new Promise((resolve) => resolve(42));",
        "const text = new Promise((resolve) => resolve(`made`));",
        "const truth = new Promise((resolve) => resolve(false));",
        "console.log(await number);",
        "console.log(await text);",
        "console.log(await truth);",
        "",
      ].join("\n"),
      { backend },
    );
  });

  test(`${backend} backend resolves a value it is given`, async () => {
    await agrees(
      [
        "const number = Promise.resolve(8);",
        "const text = Promise.resolve(`ready`);",
        "const truth = Promise.resolve(true);",
        "console.log(await number);",
        "console.log(await text);",
        "console.log(await truth);",
        "",
      ].join("\n"),
      { backend },
    );
  });

  test(`${backend} backend awaits the promise a name was last given`, async () => {
    await agrees(
      [
        "let p = Promise.resolve(1);",
        "p = Promise.resolve(2);",
        "console.log(await p);",
        "const q = 1 > 0 ? Promise.resolve(3) : Promise.resolve(4);",
        "console.log(await q);",
        "",
      ].join("\n"),
      { backend },
    );
  });

  test(`${backend} backend awaits a call without reading its value`, async () => {
    await agrees(
      [
        "async function f(n) { console.log(`inner`); return n; }",
        "console.log(`before`);",
        "await f(1);",
        "console.log(`after`);",
        "",
      ].join("\n"),
      { backend },
    );
  });

  test(`${backend} backend rejects the promise an async function answers`, async () => {
    // The failure an awaited call left pending is carried on the promise the
    // function answers, so the await that reads it is where it is raised.
    await agrees(
      [
        "async function f(n) {",
        "  const p = new Promise((resolve, reject) => reject(`boom`));",
        "  await p;",
        "  return 1;",
        "}",
        "try { await f(1); } catch (e) { console.log(`caught ${e}`); }",
        "",
      ].join("\n"),
      { backend },
    );
  });

  test(`${backend} backend settles a promise with nothing`, async () => {
    await agrees(
      [
        "async function f(n) { console.log(`work`); }",
        "await f(1);",
        "console.log(`done`);",
        "",
      ].join("\n"),
      { backend },
    );
  });

  test(`${backend} backend rejects a promise it is handed`, async () => {
    await agrees(
      [
        "const p = Promise.reject(`no`);",
        "try { await p; } catch (e) { console.log(`caught ${e}`); }",
        "",
      ].join("\n"),
      { backend },
    );
  });

  test(`${backend} backend runs a promise's executor where it is written`, async () => {
    await agrees(
      [
        "console.log(`before`);",
        "const p = new Promise((resolve) => { console.log(`executor`); resolve(1); });",
        "console.log(`after`);",
        "console.log(await p);",
        "",
      ].join("\n"),
      { backend },
    );
  });
}

test("the Nim driver awaits the value an async function answers", async (t) => {
  if (!NIM) {
    t.skip("the Nim compiler is not installed");
    return;
  }
  await agrees(
    "async function g(n) { return n; }\nasync function f(n) { return (await g(n)) + 1; }\nconsole.log(await f(2));\n",
    { runtime: "nim" },
  );
});

/* -------------------------------------------------------------------------- */
/* What the frontend reads                                                    */
/* -------------------------------------------------------------------------- */

test("an async function is a function that answers a promise", () => {
  const body = typeScriptFrontend.analyze("async function f(n) { return n; }\nconsole.log(await f(1));\n", "main.ts").body;
  const declared = body.find((statement) => statement.kind === "function");
  assert.ok(declared !== undefined, "the function is declared");
  if (declared === undefined) throw new Error("expected a function");
  assert.equal(declared.async, true, "the function is async as it was written");
});

test("an async arrow is an arrow that answers a promise", () => {
  const body = typeScriptFrontend.analyze("const f = async (n) => n;\n", "main.ts").body;
  const declare = body.find((statement) => statement.kind === "declare");
  assert.ok(declare !== undefined, "the arrow is declared");
  if (declare === undefined) throw new Error("expected a declaration");
  assert.equal(declare.value.k, "arrow");
  assert.equal(declare.value.k === "arrow" ? declare.value.async : false, true);
});

test("an async function of a module answers a promise carrying what it returns", () => {
  const phase = phaseOf(
    "typescript",
    {
      "main.ts": "import { f } from './lib.ts';\nconsole.log(await f());\n",
      "lib.ts": "export async function f(): number { return 9; }\n",
    },
    "main.ts",
  );
  const contract = phase.program.files.find((file) => file.path === "lib.ts")?.functions.f;
  assert.ok(contract !== undefined, "the function is contracted");
  if (contract === undefined) throw new Error("expected a contract");
  assert.equal(contract.function.returns, "ref<any>", "the function answers the handle a promise is");
  assert.equal(contract.promise, "f64", "the promise carries the number the body returns");
  const settles = contract.definition.statements.some(
    (statement) =>
      statement.kind === "result" &&
      statement.value !== null &&
      statement.value.k === "call" &&
      statement.value.name === "Promise.settle",
  );
  assert.ok(settles, "the body settles the promise with the value it returns");
});

test("a module's async function is awaited by the program that imports it", async (t) => {
  const answer = () => SOUND;
  await chatEndpoint(t, [], { answer });
  for (const backend of ["c", "machine"] as const) {
    const directory = await scratch("blaze-async-module-");
    await writeFile(
      join(directory, "lib.ts"),
      "export async function one(): number { return 9; }\nexport async function text(): string { return `hi`; }\nexport async function add(a: number, b: number = 2): number { return a + b; }\n",
      "utf8",
    );
    await writeFile(
      join(directory, "main.ts"),
      "import { one, text, add } from './lib.ts';\nconsole.log(await one());\nconsole.log(await text());\nconsole.log(await add(3));\n",
      "utf8",
    );
    await writeProject(join(directory, "blaze.toml"), {
      language: "typescript",
      sourceFile: "main.ts",
      model: { provider: "openai-compatible", model: "stub" },
      output: "machine",
      backend,
      mode: "debug",
      generation: { maxCandidates: 1, maxAttempts: 1 },
    });
    const outcome = await runBuild(
      "blaze.toml",
      { cwd: directory, reuse: false, model: "openai-compatible/stub", maxAttempts: 1 },
      QUIET,
      "build",
    );
    assert.equal(outcome.build.status, "success", `${backend} build succeeded`);
    assert.ok(outcome.outputPath !== null, `${backend} build delivered a binary`);
    const delivered = run(outcome.outputPath as string, [], { timeoutMs: 60_000 });
    assert.equal(delivered.code, 0, delivered.stderr);
    assert.equal(delivered.stdout, "9\nhi\n5\n");
  }
});

/* -------------------------------------------------------------------------- */
/* Python                                                                     */
/* -------------------------------------------------------------------------- */

/** The binary a Python program is built into, with a module beside it. */
async function builtPython(
  main: string,
  library: string | undefined,
  backend: "c" | "machine",
): Promise<{ directory: string; binary: string }> {
  const directory = await scratch("blaze-async-python-");
  await writeFile(join(directory, "main.py"), main, "utf8");
  if (library !== undefined) await writeFile(join(directory, "lib.py"), library, "utf8");
  await writeProject(join(directory, "blaze.toml"), {
    language: "python",
    sourceFile: "main.py",
    model: { provider: "openai-compatible", model: "stub" },
    output: "machine",
    backend,
    mode: "debug",
    generation: { maxCandidates: 1, maxAttempts: 1 },
  });
  const outcome = await runBuild(
    "blaze.toml",
    { cwd: directory, reuse: false, model: "openai-compatible/stub", maxAttempts: 1 },
    QUIET,
    "build",
  );
  assert.equal(outcome.build.status, "success", "the program builds");
  assert.ok(outcome.outputPath !== null, "the build delivers a binary");
  return { directory, binary: outcome.outputPath as string };
}

test("a Python module's async function is awaited by the program that imports it", async (t) => {
  await chatEndpoint(t, [], { answer: () => SOUND });
  const library = [
    "async def g(n: int) -> int:",
    "    return n",
    "",
    "async def one(n: int) -> int:",
    "    return (await g(n)) + 1",
    "",
    "async def text() -> str:",
    "    return 'hi'",
    "",
  ].join("\n");
  const main = "import asyncio\nfrom lib import one, text\nprint(asyncio.run(one(2)))\nprint(asyncio.run(text()))\n";
  for (const backend of ["c", "machine"] as const) {
    const { directory, binary } = await builtPython(main, library, backend);
    const original = run("python3", ["main.py"], { cwd: directory, timeoutMs: 60_000 });
    const delivered = run(binary, [], { timeoutMs: 60_000 });
    assert.equal(original.code, 0, original.stderr);
    assert.equal(delivered.code, 0, delivered.stderr);
    assert.equal(delivered.stdout, original.stdout);
  }
});

test("a Python program awaits a coroutine it declares with asyncio.run", async (t) => {
  await chatEndpoint(t, [], { answer: () => SOUND });
  const main = "import asyncio\n\nasync def doubled(n: int) -> int:\n    return n * 2\n\nprint(asyncio.run(doubled(4)))\n";
  for (const backend of ["c", "machine"] as const) {
    const { directory, binary } = await builtPython(main, undefined, backend);
    const original = run("python3", ["main.py"], { cwd: directory, timeoutMs: 60_000 });
    const delivered = run(binary, [], { timeoutMs: 60_000 });
    assert.equal(original.code, 0, original.stderr);
    assert.equal(delivered.code, 0, delivered.stderr);
    assert.equal(delivered.stdout, original.stdout);
  }
});

test("an async function of a module that returns nothing is awaited", async (t) => {
  await chatEndpoint(t, [], { answer: () => SOUND });
  const directory = await scratch("blaze-async-module-void-");
  await writeFile(join(directory, "lib.ts"), "export async function work(): void { console.log(`working`); }\n", "utf8");
  await writeFile(join(directory, "main.ts"), "import { work } from './lib.ts';\nawait work();\nconsole.log(`done`);\n", "utf8");
  await writeProject(join(directory, "blaze.toml"), {
    language: "typescript",
    sourceFile: "main.ts",
    model: { provider: "openai-compatible", model: "stub" },
    output: "machine",
    backend: "c",
    mode: "debug",
    generation: { maxCandidates: 1, maxAttempts: 1 },
  });
  const outcome = await runBuild(
    "blaze.toml",
    { cwd: directory, reuse: false, model: "openai-compatible/stub", maxAttempts: 1 },
    QUIET,
    "build",
  );
  assert.equal(outcome.build.status, "success");
  assert.ok(outcome.outputPath !== null);
  const delivered = run(outcome.outputPath as string, [], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, "working\ndone\n");
});

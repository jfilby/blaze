/**
 * Programs: the statements of an entry module, the types they resolve to, and
 * the binary a build delivers from them.
 *
 * A program is checked against the output of its own toolchain, so the tests
 * here run the source with node and the delivered binary with the compiler, and
 * compare what the two print.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBuild } from "../compiler.ts";
import { run } from "../core/process.ts";
import { typeScriptFrontend } from "../semantics/typescript.ts";
import { resolveProgram, type ResolvedValue } from "../toolchain/program.ts";
import { verifyProgram } from "../toolchain/verify-program.ts";
import { diagnostic, phaseOf } from "./phase.ts";

const REPLAY = new URL("./fixtures/dot-product-replay.json", import.meta.url).pathname;
const quiet = { stage: () => {} };
const nimAvailable = run("nim", ["--version"], { timeoutMs: 30_000 }).code === 0;

const DOT = [
  "export function dot(a: Float64Array, b: Float64Array, n: number): number {",
  "  return a[0] * b[0] + n;",
  "}",
  "",
].join("\n");

/** The statements of a TypeScript module, as the frontend parsed them. */
function bodyOf(source: string) {
  return typeScriptFrontend.analyze(source, "main.ts").body;
}

/** A program of one entry module and the library it calls, resolved. */
function resolved(files: Record<string, string>) {
  const phase = phaseOf("typescript", files, "main.ts");
  return resolveProgram(phase.body!, phase.program);
}

/** The call a resolved statement makes, which is the only interesting value. */
function callOf(value: ResolvedValue) {
  assert.equal(value.k, "call");
  if (value.k !== "call") throw new Error("expected a call");
  return value.call;
}

test("a program's statements are read in the order they run", () => {
  const body = bodyOf(
    [
      'import { dot } from "./dot.ts";',
      "const a = new Float64Array([1, 2]);",
      "const total = dot(a, a, a.length);",
      "console.log(`total: ${total}`);",
      "",
    ].join("\n"),
  );

  assert.deepEqual(body, [
    { kind: "declare", name: "a", value: { k: "buffer", values: ["1", "2"] }, line: 2 },
    {
      kind: "declare",
      name: "total",
      value: {
        k: "call",
        function: "dot",
        args: [
          { k: "name", name: "a" },
          { k: "name", name: "a" },
          { k: "length", buffer: "a" },
        ],
      },
      line: 3,
    },
    {
      kind: "print",
      value: {
        k: "text",
        parts: [
          { k: "text", value: "total: " },
          { k: "value", value: { k: "name", name: "total" } },
        ],
      },
      line: 4,
    },
  ]);
});

test("a number the source negated is read as written", () => {
  assert.deepEqual(bodyOf("console.log(-1.5e-7);\n"), [
    { kind: "print", value: { k: "number", text: "-1.5e-7" }, line: 1 },
  ]);
});

test("a statement a program cannot run is refused", () => {
  assert.match(diagnostic(() => bodyOf("console.error(1);\n")), /console\.error is not part of a program/);
  assert.match(diagnostic(() => bodyOf("for (let i = 0; i < 4; i++) {}\n")), /"for" is not a statement of a program/);
});

test("a declaration after the program is refused, because a program runs last", () => {
  assert.match(
    diagnostic(() => bodyOf(["console.log(1);", "export function f(): number {", "  return 1;", "}"].join("\n"))),
    /"export" is not a statement of a program/,
  );
});

test("a value takes the type of the call it is passed to", () => {
  const program = resolved({
    "main.ts": [
      'import { dot } from "./dot.ts";',
      "const a = new Float64Array([1, 2]);",
      "const total = dot(a, a, a.length);",
      "console.log(`${total}`);",
      "",
    ].join("\n"),
    "dot.ts": DOT,
  });

  // The array is f64 because the parameter is, and the length stays a length:
  // the driver reads it as one and converts it where the call wants a number.
  const declared = program.statements[1];
  assert.equal(declared.kind, "declare");
  if (declared.kind !== "declare") throw new Error("expected a declaration");
  const call = callOf(declared.value);
  assert.equal(call.name, "dot");
  assert.deepEqual(call.args[0], {
    k: "reference",
    name: "a",
    binding: { kind: "buffer", element: "f64", length: 2, values: ["1", "2"] },
  });
  assert.deepEqual(call.args[2], { k: "length", buffer: "a", type: "usize" });
  assert.deepEqual(call.returns, { kind: "primitive", name: "f64" });
});

test("a program that calls something the project does not compile is refused", () => {
  assert.throws(
    () =>
      resolved({
        "main.ts": ["import { dot } from './dot.ts';", "console.log(`${missing(1)}`);", ""].join("\n"),
        "dot.ts": DOT,
      }),
    /"missing" is not a function of this program/,
  );
});

test("a call with the wrong number of arguments is refused", () => {
  assert.throws(
    () =>
      resolved({
        "main.ts": ["import { dot } from './dot.ts';", "console.log(`${dot(1)}`);", ""].join("\n"),
        "dot.ts": DOT,
      }),
    /dot takes 3 argument\(s\), not 1/,
  );
});

test("a program that prints a buffer is refused", () => {
  assert.throws(
    () => resolved({ "main.ts": "const a = new Float64Array([1, 2]);\nconsole.log(`${a}`);\n" }),
    /a program cannot print a buffer/,
  );
});

test("a value the program never declared is refused", () => {
  assert.throws(() => resolved({ "main.ts": "console.log(`${total}`);\n" }), /"total" is not declared/);
});

/** A program that prints numbers, in the shapes the two runtimes differ on. */
const NUMBERS = [
  "70",
  "0.1",
  "0.30000000000000004",
  "1e21",
  "1e-7",
  "0.3333333333333333",
  "1e20",
  "0.00001",
  "1e-6",
  "-2.5",
];

const PRINTED = [
  "70",
  "0.1",
  "0.30000000000000004",
  "1e+21",
  "1e-7",
  "0.3333333333333333",
  "100000000000000000000",
  "0.00001",
  "0.000001",
  "-2.5",
];

async function numberProgram(runtime?: "nim"): Promise<{ directory: string; binary: string }> {
  const directory = await mkdtemp(join(tmpdir(), "blaze-numbers-"));
  await writeFile(join(directory, "numbers.ts"), `${NUMBERS.map((text) => `console.log(${text});`).join("\n")}\n`, "utf8");
  await writeFile(
    join(directory, "blaze.json"),
    JSON.stringify({
      language: "typescript",
      sourceFile: "numbers.ts",
      model: { provider: "replay", file: REPLAY },
      output: "machine",
      ...(runtime === undefined ? {} : { runtime }),
    }),
    "utf8",
  );
  const outcome = await runBuild("blaze.json", { cwd: directory, reuse: false, model: `replay:${REPLAY}` }, quiet, "build");
  assert.ok(outcome.outputPath !== null, "a program build delivers its binary");
  return { directory, binary: outcome.outputPath };
}

test("a program prints numbers the way the language it was written in prints them", async () => {
  const { directory, binary } = await numberProgram();
  const source = run("node", ["numbers.ts"], { cwd: directory, timeoutMs: 60_000 });
  const delivered = run(binary, [], { timeoutMs: 60_000 });

  assert.equal(source.code, 0, source.stderr);
  assert.equal(delivered.code, 0, delivered.stderr);
  // The build already compared the two; the test states the rule that
  // comparison rests on, so a change to the number format fails here with the
  // difference rather than only at some later build.
  assert.deepEqual(delivered.stdout.trimEnd().split("\n"), PRINTED);
  assert.equal(delivered.stdout, source.stdout);
});

test("the Nim driver runs a program the way the C driver does", async (t) => {
  if (!nimAvailable) {
    t.skip("the Nim compiler is not installed");
    return;
  }
  const hosted = await numberProgram("nim");
  const standalone = await numberProgram();
  const hostedOutput = run(hosted.binary, [], { timeoutMs: 60_000 });
  const standaloneOutput = run(standalone.binary, [], { timeoutMs: 60_000 });

  assert.equal(hostedOutput.code, 0, hostedOutput.stderr);
  assert.equal(hostedOutput.stdout, standaloneOutput.stdout);
});

test("a program that prints something else is reported against the line it differs on", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blaze-oracle-"));
  await writeFile(join(directory, "main.ts"), 'console.log("expected");\n', "utf8");

  const same = await verifyProgram({
    language: "typescript",
    sourcePath: join(directory, "main.ts"),
    directory,
    runner: { command: "node", args: ["-e", 'console.log("expected")'] },
  });
  assert.equal(same.passed, true);
  assert.equal(same.difference, undefined);

  const different = await verifyProgram({
    language: "typescript",
    sourcePath: join(directory, "main.ts"),
    directory,
    runner: { command: "node", args: ["-e", 'console.log("expected"); console.log("extra")'] },
  });
  assert.equal(different.passed, false);
  assert.deepEqual(different.difference, { line: 2, expected: "", actual: "extra" });
});

test("a program in a language the compiler cannot run is refused", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blaze-oracle-nim-"));
  await writeFile(join(directory, "main.nim"), 'echo "hello"\n', "utf8");

  await assert.rejects(
    () =>
      verifyProgram({
        language: "nim",
        sourcePath: join(directory, "main.nim"),
        directory,
        runner: { command: "true", args: [] },
      }),
    /a program in nim cannot be checked/,
  );
});

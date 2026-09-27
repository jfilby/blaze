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
import { chatEndpoint } from "./model-endpoint.ts";
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
    { kind: "declare", name: "a", mutable: false, type: null, value: { k: "buffer", values: [{ k: "number", text: "1" }, { k: "number", text: "2" }] }, line: 2 },
    {
      kind: "declare",
      name: "total",
      mutable: false,
      type: null,
      value: {
        k: "call",
        function: "dot",
        args: [
          { k: "name", name: "a" },
          { k: "name", name: "a" },
          { k: "length", of: "a" },
        ],
      },
      line: 3,
    },
    {
      kind: "print",
      values: [
        {
          k: "text",
          parts: [
            { k: "text", value: "total: " },
            { k: "value", value: { k: "name", name: "total" } },
          ],
        },
      ],
      line: 4,
    },
  ]);
});

test("a number the source negated is read as the value it negates", () => {
  assert.deepEqual(bodyOf("console.log(-1.5e-7);\n"), [
    {
      kind: "print",
      values: [{ k: "unary", op: "-", operand: { k: "number", text: "1.5e-7" } }],
      line: 1,
    },
  ]);
});

test("a statement a program cannot run is refused", () => {
  assert.match(diagnostic(() => bodyOf("console.error(1);\n")), /console\.error is not part of a program/);
  const refused = diagnostic(() => bodyOf("switch (total) {\n}\n"));
  assert.match(refused, /"switch/);
  assert.match(refused, /is not a statement of a program/);
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
    binding: {
      kind: "buffer",
      name: "a",
      mutable: false,
      element: "f64",
      length: 2,
      values: [
        { k: "literal", binding: { kind: "scalar", name: "", mutable: false, type: null, text: "1" } },
        { k: "literal", binding: { kind: "scalar", name: "", mutable: false, type: null, text: "2" } },
      ],
    },
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

/** A program that runs what a contract cannot state: the whole statement language. */
const LANGUAGE = [
  "let total = 0;",
  "for (let i = 1; i <= 10; i += 1) {",
  "  if (i % 2 === 0) {",
  "    continue;",
  "  }",
  "  total += i;",
  "}",
  'console.log("odd total", total);',
  "let n = 0;",
  "while (n < 3) { n += 1; }",
  "do { n -= 1; } while (n > 0);",
  "console.log(`n is ${n}, half of total is ${total / 2}`);",
  "const data = new Float64Array([1, 2, 3]);",
  "let sum = 0;",
  "for (const value of data) { sum += value; }",
  "console.log(sum > 5 ? \"big\" : \"small\", data.length, 2 ** 10, 7 % 3);",
  // A name declared with const still names an array the program may change, an
  // element is a value like any other, and a string grows rather than adds.
  "data[1] = 20;",
  "data[2] += 5;",
  'let text = "a";',
  'text += "b";',
  "console.log(data[0], data[1], data[2], text, text.length);",
  'let empty = "";',
  "console.log(empty ? \"yes\" : \"no\", text ? \"yes\" : \"no\");",
  "for (let round = 0; round < 3; round += 1) {",
  "  const inner = new Float64Array([round]);",
  "  console.log(inner[0] * 10);",
  "}",
  "",
].join("\n");

/** Builds a program of one entry module, and returns the binary it delivers. */
async function program(source: string, runtime?: "nim"): Promise<{ directory: string; binary: string }> {
  const directory = await mkdtemp(join(tmpdir(), "blaze-program-"));
  await writeFile(join(directory, "main.ts"), source, "utf8");
  await writeFile(
    join(directory, "blaze.json"),
    JSON.stringify({
      language: "typescript",
      sourceFile: "main.ts",
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

test("a program runs the statements a function body is written in", () => {
  const body = bodyOf(LANGUAGE);
  assert.deepEqual(
    body.map((statement) => statement.kind),
    [
      "declare",
      "for",
      "print",
      "declare",
      "while",
      "doWhile",
      "print",
      "declare",
      "declare",
      "forOf",
      "print",
      "elementAssign",
      "elementAssign",
      "declare",
      "assign",
      "print",
      "declare",
      "print",
      "for",
    ],
  );

  // A counted loop carries its bound and how its index moves, so the driver can
  // put the step in the loop header where `continue` runs it.
  const counted = body[1];
  assert.equal(counted.kind, "for");
  if (counted.kind !== "for") throw new Error("expected a counted loop");
  assert.deepEqual(
    { from: counted.from, to: counted.to, inclusive: counted.inclusive, down: counted.down, step: counted.step },
    { from: { k: "number", text: "1" }, to: { k: "number", text: "10" }, inclusive: true, down: false, step: { k: "number", text: "1" } },
  );
});

test("a name declared in a block is a variable of its own", () => {
  const program = resolved({
    "main.ts": ["let total = 0;", "{", "  let total = 10;", "  total += 1;", "}", "console.log(total);", ""].join("\n"),
  });
  const inner = program.statements[1];
  assert.equal(inner.kind, "block");
  if (inner.kind !== "block") throw new Error("expected a block");
  const declared = inner.body[0];
  assert.equal(declared.kind, "declare");
  if (declared.kind !== "declare") throw new Error("expected a declaration");
  // The block declares `total_2`, so the outer `total` is untouched by it.
  assert.equal(declared.name, "total_2");
  assert.equal(program.statements[0].kind === "declare" ? program.statements[0].name : "", "total");
});

test("a value declared with const cannot be changed", () => {
  assert.match(
    diagnostic(() => resolved({ "main.ts": ["const total = 0;", "total = 1;", ""].join("\n") })),
    /"total" is declared with const and cannot be changed/,
  );
});

test("a loop that moves by whole numbers counts with a whole number", () => {
  const program = resolved({
    "main.ts": ["for (let i = 0; i < 4; i += 1) {", "  console.log(i);", "}", ""].join("\n"),
  });
  const loop = program.statements[0];
  assert.equal(loop.kind, "for");
  if (loop.kind !== "for") throw new Error("expected a counted loop");
  assert.deepEqual(loop.type, { kind: "primitive", name: "i64" });
});

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
  // A repair is shown both outputs, so the mismatch carries them with the line.
  assert.equal(different.difference?.line, 2);
  assert.equal(different.difference?.expected, "");
  assert.equal(different.difference?.actual, "extra");
  assert.equal(different.difference?.expectedOutput, "expected\n");
  assert.equal(different.difference?.actualOutput, "expected\nextra\n");
});

test("a program that stops is reported against the line it never printed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blaze-stopped-"));
  await writeFile(join(directory, "main.ts"), 'console.log("expected");\nconsole.log("wanted");\n', "utf8");

  // A program that prints a line and is then killed has no line to disagree
  // with, so the verdict points at the line the source prints that it never
  // reached, and carries the reason it stopped.
  const stopped = await verifyProgram({
    language: "typescript",
    sourcePath: join(directory, "main.ts"),
    directory,
    runner: {
      command: "node",
      args: ["-e", 'require("fs").writeSync(1, "expected\\n"); process.kill(process.pid, "SIGSEGV")'],
    },
  });
  assert.equal(stopped.passed, false);
  assert.equal(stopped.difference?.failure, "the delivered program was terminated by SIGSEGV");
  assert.equal(stopped.difference?.line, 2);
  assert.equal(stopped.difference?.expected, "wanted");
  assert.equal(stopped.difference?.actual, "");
  assert.equal(stopped.difference?.expectedOutput, "expected\nwanted\n");
  assert.equal(stopped.difference?.actualOutput, "expected");
});

const languageProgram = (runtime?: "nim") => program(LANGUAGE, runtime);

test("a program runs its own statements, and the two drivers run them alike", async (t) => {
  const { directory, binary } = await languageProgram();
  const source = run("node", ["main.ts"], { cwd: directory, timeoutMs: 60_000 });
  const delivered = run(binary, [], { timeoutMs: 60_000 });

  assert.equal(source.code, 0, source.stderr);
  assert.equal(delivered.code, 0, delivered.stderr);
  // The build compares the two already; the test states what they printed, so a
  // driver that builds and runs the wrong program fails here.
  assert.deepEqual(delivered.stdout.trimEnd().split("\n"), [
    "odd total 25",
    "n is 0, half of total is 12.5",
    "big 3 1024 1",
    "1 20 8 ab 2",
    "no yes",
    "0",
    "10",
    "20",
  ]);
  assert.equal(delivered.stdout, source.stdout);

  if (!nimAvailable) {
    t.skip("the Nim compiler is not installed");
    return;
  }
  const hosted = await languageProgram("nim");
  const hostedOutput = run(hosted.binary, [], { timeoutMs: 60_000 });
  assert.equal(hostedOutput.code, 0, hostedOutput.stderr);
  assert.equal(hostedOutput.stdout, source.stdout);
});

/** A program that computes every way a number can come out differently. */
const ARITHMETIC = [
  "console.log(0.1 + 0.2, 1 / 3, 2 ** 0.5, 7 % 3, -7 % 3, 7 % -3);",
  "console.log(Math.max(1, 2), Math.min(1, 2), Math.abs(-3), Math.floor(1.7), Math.round(2.5), Math.round(-1.5), Math.trunc(-1.7));",
  "console.log(1 < 2, 2 <= 2, 3 > 4, 3 >= 4, 1 === 1, 1 !== 2, true && false, true || false, !true);",
  "console.log(5 & 3, 5 | 3, 5 ^ 3, ~5, 1 << 4, 256 >> 4);",
  "let n = 0;",
  // `&&`, `||` and `??` are one of their operands, not a truth.
  "console.log(n || 7, n ?? 7, 0 ?? 7, n && 3, 2 && 3, 1 || 0);",
  "console.log(Math.round(0.5), Math.round(1.5), Math.round(-0.5), Math.round(-1.5));",
  "const a = new Float64Array([1.5, -2.5]);",
  "console.log(a[0] + a[1], a.length, a[0] > 0 ? a[1] : -a[1]);",
  "",
].join("\n");

test("a program computes what the language computes, in both drivers", async (t) => {
  const { directory, binary } = await program(ARITHMETIC);
  const source = run("node", ["main.ts"], { cwd: directory, timeoutMs: 60_000 });
  const delivered = run(binary, [], { timeoutMs: 60_000 });

  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, source.stdout);
  // A half is rounded up and a value that rounds to zero from below keeps its
  // sign, a remainder keeps the sign of the left side, and `&&` is one of its
  // operands: the lines are what say so.
  assert.deepEqual(delivered.stdout.trimEnd().split("\n"), [
    "0.30000000000000004 0.3333333333333333 1.4142135623730951 1 -1 1",
    "2 1 3 1 3 -1 -1",
    "true true false false true true false true false",
    "1 7 6 -6 16 16",
    "7 0 0 0 3 1",
    "1 2 -0 -1",
    "-1 2 -2.5",
  ]);

  if (!nimAvailable) {
    t.skip("the Nim compiler is not installed");
    return;
  }
  const hosted = await program(ARITHMETIC, "nim");
  const hostedOutput = run(hosted.binary, [], { timeoutMs: 60_000 });
  assert.equal(hostedOutput.code, 0, hostedOutput.stderr);
  assert.equal(hostedOutput.stdout, source.stdout);
});

/**
 * The shapes a program is written in that a number or a name decides: a length
 * is a whole number, a string grows by text, a loop that moves in fractions
 * counts in fractions, and a `break` inside a block leaves the loop.
 */
const SHAPES = [
  "const a = new Float64Array([1, 2, 3]);",
  "console.log(a.length - 10, 0 - a.length, ~a.length, a.length * 2);",
  'let s = "x";',
  "s += 1;",
  'console.log(s, "abc" === 5, "abc" === "abc", `a number is a double: ${1 / 3}`);',
  "for (let i = 0; i < 3; i++) { a[i] = a[i] + 1; }",
  "for (let j = 3; j > 0; j--) { console.log(j); }",
  "console.log(a[0], a[1], a[2]);",
  "let i = 0;",
  "do { i += 1; if (i < 3) continue; console.log(i); } while (i < 3);",
  "let n = 0;",
  'while (n < 3) { n += 1; { if (n === 2) { break; } console.log("in", n); } }',
  'console.log("out", n);',
  "for (let k = 0.0; k < 0.5; k += 0.1) { console.log(k); }",
  "console.log(Math.max(0 / 0, 1), Math.min(0 / 0, 1), -0x1f, `${true}`);",
  "for (let m = 3; m > 0; m--) {",
  "  const inner = new Float64Array([m]);",
  "  if (m > 1) continue;",
  "  console.log(inner[0]);",
  "}",
  "",
].join("\n");

/** A program built for a runtime, run beside the source it was written as. */
async function agreesWithNode(source: string, runtime?: "nim"): Promise<void> {
  const { directory, binary } = await program(source, runtime);
  const original = run("node", ["main.ts"], { cwd: directory, timeoutMs: 60_000 });
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(original.code, 0, original.stderr);
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, original.stdout);
}

test("a program runs the shapes a number and a name decide", async (t) => {
  const { directory, binary } = await program(SHAPES);
  const source = run("node", ["main.ts"], { cwd: directory, timeoutMs: 60_000 });
  const delivered = run(binary, [], { timeoutMs: 60_000 });

  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, source.stdout);
  // A length is a whole number, and arithmetic on one is a double, so
  // `length - 10` is -7 and not a very large unsigned number. A string grows by
  // text, a strict comparison across types is false, a loop that moves in
  // fractions counts the doubles it reaches, and a NaN is carried through.
  assert.deepEqual(delivered.stdout.trimEnd().split("\n"), [
    "-7 -3 -4 6",
    "x1 false true a number is a double: 0.3333333333333333",
    "3",
    "2",
    "1",
    "2 3 4",
    "3",
    "in 1",
    "out 2",
    "0",
    "0.1",
    "0.2",
    "0.30000000000000004",
    "0.4",
    "NaN NaN -31 true",
    "1",
  ]);

  if (!nimAvailable) {
    t.skip("the Nim compiler is not installed");
    return;
  }
  await agreesWithNode(SHAPES, "nim");
});

test("a program refuses what the language has no answer for", () => {
  // A typed array has no element outside itself, and a whole operator rounds
  // what it is given, which the language raises on rather than doing.
  assert.match(
    diagnostic(() => resolved({ "main.ts": ["const a = new Float64Array([1, 2]);", "a[5] = 9;", ""].join("\n") })),
    /a\[5\] is outside the array/,
  );
  assert.match(
    diagnostic(() => resolved({ "main.ts": ["console.log(7.5 % 2);", ""].join("\n") })),
    /"%" needs whole numbers/,
  );
  assert.match(
    diagnostic(() => resolved({ "main.ts": ["break;", ""].join("\n") })),
    /"break" is not within a loop/,
  );
});

test("a value with no decimal of its own is written the way the language writes it", async (t) => {
  // A value that is not finite has no shortest decimal, so the source writes it
  // as Infinity, -Infinity or NaN, and a negative zero keeps its sign. The
  // driver has to write the same, which is what the comparison is for.
  const values = ["-0", "1 / 0", "-1 / 0", "0 / 0", "2 ** 1024", "-(1 / 0)"];
  const printed = ["-0", "Infinity", "-Infinity", "NaN", "Infinity", "-Infinity"];
  const { directory, binary } = await program(`${values.map((text) => `console.log(${text});`).join("\n")}\n`);
  const source = run("node", ["main.ts"], { cwd: directory, timeoutMs: 60_000 });
  const delivered = run(binary, [], { timeoutMs: 60_000 });

  assert.deepEqual(delivered.stdout.trimEnd().split("\n"), printed);
  assert.equal(delivered.stdout, source.stdout);

  if (!nimAvailable) {
    t.skip("the Nim compiler is not installed");
    return;
  }
  const hosted = await program(`${values.map((text) => `console.log(${text});`).join("\n")}\n`, "nim");
  const hostedOutput = run(hosted.binary, [], { timeoutMs: 60_000 });
  assert.equal(hostedOutput.code, 0, hostedOutput.stderr);
  assert.equal(hostedOutput.stdout, source.stdout);
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

/**
 * A function whose contract states what it does has no vector of its own, so
 * the program it belongs to is the only thing that can say whether it is right.
 * This is that loop: a program that prints something else is regenerated with
 * the line it differs on, and the build ends on the candidate that agrees.
 */
const SUM = [
  "function total(n: number): number {",
  "  let out = 0;",
  "  let i = 0;",
  "  while (i < n) { out += i; i += 1; }",
  "  return out;",
  "}",
  "console.log(total(4));",
  "",
].join("\n");

/** `total` as the model writes it: n arrives in xmm0 as a double. */
function totalAssembly(body: string[]): string {
  return ["\t.globl\ttotal", "total:", "\txorps\t%xmm1, %xmm1", ...body, "\tret", ""].join("\n");
}

/** Adds 0..n-1 by counting down, which is what the source counts up to. */
const TOTAL_RIGHT = totalAssembly([
  "\tcvttsd2siq\t%xmm0, %rcx",
  "\tdec\t%rcx",
  "\tpxor\t%xmm2, %xmm2",
  "\tpxor\t%xmm3, %xmm3",
  ".Lloop:",
  "\tcvtsi2sdq\t%rcx, %xmm2",
  "\taddsd\t%xmm2, %xmm3",
  "\tdec\t%rcx",
  "\tjs\t.Ldone",
  "\tjmp\t.Lloop",
  ".Ldone:",
  "\tmovapd\t%xmm3, %xmm0",
]);

/** Returns n instead of the sum, so the program prints 4 where the source prints 6. */
const TOTAL_WRONG = totalAssembly(["\tmovq\t%xmm0, %rax"]);

test("a program that prints something else is regenerated with the line it differs on", async (t) => {
  const endpoint = await chatEndpoint(t, [TOTAL_WRONG, TOTAL_RIGHT]);
  const directory = await mkdtemp(join(tmpdir(), "blaze-repair-"));
  await writeFile(join(directory, "main.ts"), SUM, "utf8");
  await writeFile(
    join(directory, "blaze.json"),
    JSON.stringify({
      language: "typescript",
      sourceFile: "main.ts",
      model: { provider: "openai-compatible", model: "stub" },
      output: "machine",
      generation: { maxCandidates: 1, maxAttempts: 1 },
    }),
    "utf8",
  );

  const outcome = await runBuild("blaze.json", { cwd: directory, reuse: false, model: "openai-compatible/stub" }, quiet, "build");

  assert.equal(outcome.build.status, "success", "the repaired program is the one that is delivered");
  assert.equal(endpoint.prompts.length, 2, "the program is generated once, then regenerated");
  // The first answer returns n rather than the sum, so the program printed 4
  // where the source prints 6. That difference is the second request.
  const repair = endpoint.prompts[1];
  assert.match(repair, /REJECTED BY THE PROGRAM IT BELONGS TO/);
  assert.match(repair, /the program prints "4"/);
  assert.match(repair, /the source prints "6"/);
  assert.match(repair, /movq\t%xmm0, %rax/, "the repair is handed the implementation that printed the wrong thing");
  assert.match(repair, /A diagnostic listed more than once/);
  assert.equal(run(outcome.outputPath as string, [], { timeoutMs: 60_000 }).stdout, "6\n");
});

/** Fails the instruction the program runs, so the program it is in is killed. */
const TOTAL_CRASHES = totalAssembly(["\tud2"]);

test("a program that is killed is regenerated with why it stopped", async (t) => {
  const endpoint = await chatEndpoint(t, [TOTAL_CRASHES, TOTAL_RIGHT]);
  const directory = await mkdtemp(join(tmpdir(), "blaze-stopped-repair-"));
  await writeFile(join(directory, "main.ts"), SUM, "utf8");
  await writeFile(
    join(directory, "blaze.json"),
    JSON.stringify({
      language: "typescript",
      sourceFile: "main.ts",
      model: { provider: "openai-compatible", model: "stub" },
      output: "machine",
      generation: { maxCandidates: 1, maxAttempts: 1 },
    }),
    "utf8",
  );

  const outcome = await runBuild("blaze.json", { cwd: directory, reuse: false, model: "openai-compatible/stub" }, quiet, "build");

  // A program that never finishes, is killed or fails is a verdict like any
  // other: the build spends its repair rounds on it instead of stopping at the
  // first one that does not run.
  assert.equal(outcome.build.status, "success", "the repaired program is the one that is delivered");
  assert.equal(endpoint.prompts.length, 2, "the program is generated once, then regenerated");
  const repair = endpoint.prompts[1];
  assert.match(repair, /REJECTED BY THE PROGRAM IT BELONGS TO/);
  assert.match(repair, /the delivered program was terminated by SIGILL/);
  assert.match(repair, /The program stopped before it printed line 1/);
  assert.match(repair, /ud2/, "the repair is handed the implementation that killed the program");
  assert.equal(run(outcome.outputPath as string, [], { timeoutMs: 60_000 }).stdout, "6\n");
});

test("a stepped loop runs the values the source runs, in both drivers", async (t) => {
  const source = [
    "for (let i = 0; i <= 6; i += 2) console.log(i);",
    "for (let i = 0; i < 6; i += 2) console.log(i);",
    "for (let i = 6; i >= 0; i -= 2) console.log(i);",
    "for (let i = 6; i > 0; i -= 2) console.log(i);",
    "for (let i = 0; i <= 3; i += 1) console.log(i);",
    "",
  ].join("\n");
  const reference = run("node", ["main.ts"], { cwd: (await program(source)).directory, timeoutMs: 60_000 });

  const { directory, binary } = await program(source);
  const sourceRun = run("node", ["main.ts"], { cwd: directory, timeoutMs: 60_000 });
  assert.equal(sourceRun.stdout, reference.stdout);
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, sourceRun.stdout);

  if (!nimAvailable) {
    t.skip("the Nim compiler is not installed");
    return;
  }
  const hosted = await program(source, "nim");
  const hostedOutput = run(hosted.binary, [], { timeoutMs: 60_000 });
  assert.equal(hostedOutput.code, 0, hostedOutput.stderr);
  // An inclusive bound ends on its own value and an exclusive one a step
  // short of it, in either direction: reading the bound as always exclusive
  // dropped the last value, and reading it as always inclusive ran one too far.
  assert.equal(hostedOutput.stdout, sourceRun.stdout);
});

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
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runBuild } from "../compiler.ts";
import { run } from "../core/process.ts";
import { typeScriptFrontend } from "../semantics/typescript.ts";
import { resolveProgram } from "../semantics/ir-resolve.ts";
import { semanticIrProblems } from "../semantics/ir-validate.ts";
import { typeText, type SemanticValue } from "../core/semantic-ir.ts";
import { verifyProgram } from "../toolchain/verify-program.ts";
import { diagnostic, phaseOf } from "./phase.ts";
import type { BuildMode } from "../core/types.ts";
import { writeProject } from "./project.ts";
import { scratch } from "./scratch.ts";

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
function callOf(value: SemanticValue) {
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
    { kind: "declare", name: "a", mutable: false, type: null, value: { k: "buffer", element: "f64", values: [{ k: "number", text: "1" }, { k: "number", text: "2" }] }, line: 2 },
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

test("the width of a view is a number a program reads", () => {
  // `BYTES_PER_ELEMENT` belongs to the language rather than to the program, so
  // it is read as the number written out and a program counts bytes with it.
  assert.deepEqual(bodyOf("const bytes = Float64Array.BYTES_PER_ELEMENT;\n"), [
    { kind: "declare", name: "bytes", mutable: false, type: null, value: { k: "number", text: "8" }, line: 1 },
  ]);
  assert.deepEqual(bodyOf("const bytes = Int8Array.BYTES_PER_ELEMENT;\n"), [
    { kind: "declare", name: "bytes", mutable: false, type: null, value: { k: "number", text: "1" }, line: 1 },
  ]);
  // A property of a view that is not its width is not a value, and the
  // diagnostic names the one that is.
  assert.match(
    diagnostic(() => bodyOf("console.log(Float64Array.MAX_VALUE);\n")),
    /Float64Array\.MAX_VALUE is not part of a program/,
  );
});

test("Deno names the command line node names", () => {
  // Deno hands a program the arguments alone, where node counts the program
  // and the file it runs before them, so `Deno.args[0]` is the argument
  // `process.argv[2]` is and not the one `process.argv[0]` would be.
  assert.deepEqual(bodyOf("const n = Deno.args[0];\n"), [
    {
      kind: "declare",
      name: "n",
      mutable: false,
      type: null,
      value: {
        k: "call",
        function: "argv",
        args: [{ k: "binary", op: "+", left: { k: "number", text: "2" }, right: { k: "number", text: "0" } }],
      },
      line: 1,
    },
  ]);
  // The length is the count of the arguments, and node's count carries the two
  // entries the source does not see.
  assert.deepEqual(bodyOf("const given = Deno.args.length;\n"), [
    {
      kind: "declare",
      name: "given",
      mutable: false,
      type: null,
      value: {
        k: "binary",
        op: "-",
        left: { k: "call", function: "argvLength", args: [] },
        right: { k: "number", text: "2" },
      },
      line: 1,
    },
  ]);
});

test("a statement a program cannot run is refused", () => {
  assert.match(diagnostic(() => bodyOf("console.error(1);\n")), /console\.error is not part of a program/);
  // A refused statement names the keyword that was written and what to write
  // instead, so a `switch` is not reported as the token the parser lost.
  const refused = diagnostic(() => bodyOf("switch (total) {\n}\n"));
  assert.match(refused, /"switch" is not part of a program/);
  assert.match(refused, /if \(x === 1\)/);
});

test("an array written out is the array a typed array of its values would be", () => {
  // `[1, 2, 3]` is what `new Float64Array([1, 2, 3])` spells out in full: a
  // `number` is a double whatever it was written next to, and this subset has
  // one array of numbers rather than the several TypeScript has.
  assert.deepEqual(bodyOf("const a = [1, 2, 3];\n"), bodyOf("const a = new Float64Array([1, 2, 3]);\n"));
  assert.deepEqual(bodyOf("const a = [];\n"), bodyOf("const a = new Float64Array([]);\n"));

  const program = resolved({
    "main.ts": [
      "const a = [1, 2, 3];",
      "a[1] = 20;",
      "const b = [];",
      "console.log(`${a.length} ${a[0]} ${a[1]} ${a[2]} ${b.length}`);",
      "",
    ].join("\n"),
  });
  // The IR holds each list as a block of the values written, and the empty one
  // as a block of no elements: both carry a length the program goes on to read.
  const lengths = program.entry.statements.flatMap((statement) =>
    statement.k === "let" && statement.value.k === "buffer" ? [statement.value.length] : [],
  );
  assert.deepEqual(lengths, [3, 0]);
});

test("a list of values holds numbers, and a text among them is refused", () => {
  assert.match(
    diagnostic(() => bodyOf('const a = [1, "two"];\n')),
    /"two" is not a number; an array holds numbers/,
  );
});

test("a construct outside the subset is named, with what to write instead", () => {
  // Each of these used to be reported as whatever token the parser lost its
  // place at, so a `catch` said "expected the name of a function" and a
  // `function*` said the same. They are named where they were written.
  for (const [source, what] of [
    ["const x = await f();\n", /"await" is not part of a program[\s\S]*no promise to wait for/],
    ["const x = yield 1;\n", /"yield" is not part of a program[\s\S]*hands back with return/],
    ["class C { }\n", /"class" is not part of a program[\s\S]*object written where it is made/],
    ["enum E { A }\n", /"enum" is not part of a program[\s\S]*const RED = 0/],
    ["try { f(); } catch (e) { }\n", /"catch" is not part of a program[\s\S]*nothing to catch/],
    ["function* g(): number { yield 1; }\n", /a generator is not supported/],
    ["async function g(): number { return 1; }\n", /an async function is not supported/],
  ] as const) {
    assert.match(diagnostic(() => bodyOf(source)), what);
  }
});

test("a construct outside the subset is named in a function body too", () => {
  for (const [body, what] of [
    ["try { return 1; } catch (e) { return 0; }", /"catch" is not supported[\s\S]*nothing to catch/],
    ["return await n;", /"await" is not supported/],
    ["return yield n;", /"yield" is not supported/],
  ] as const) {
    const source = `function f(n: number): number { ${body} }\nmain();\n`;
    assert.match(diagnostic(() => typeScriptFrontend.analyze(source, "lib.ts")), what);
  }
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

  // The array is read as the array it is, the length as a length, and the call
  // says the type every argument is passed as and the type it returns.
  const declared = program.entry.statements[1];
  assert.equal(declared.k, "let");
  if (declared.k !== "let") throw new Error("expected a declaration");
  const call = callOf(declared.value);
  assert.equal(call.callee, "dot");
  assert.deepEqual(call.argTypes, [
    { kind: "slice", of: { kind: "primitive", name: "f64" } },
    { kind: "slice", of: { kind: "primitive", name: "f64" } },
    { kind: "primitive", name: "f64" },
  ]);
  assert.deepEqual(call.args[0], {
    k: "local",
    type: { kind: "array", of: { kind: "primitive", name: "f64" }, length: 2 },
    name: "a",
  });
  assert.deepEqual(call.args[2], {
    k: "length",
    type: { kind: "primitive", name: "usize" },
    of: { k: "local", type: { kind: "array", of: { kind: "primitive", name: "f64" }, length: 2 }, name: "a" },
  });
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
  const directory = await scratch("blaze-numbers-");
  await writeFile(join(directory, "numbers.ts"), `${NUMBERS.map((text) => `console.log(${text});`).join("\n")}\n`, "utf8");
  await writeProject(join(directory, "blaze.toml"), {
    language: "typescript",
    sourceFile: "numbers.ts",
    model: { provider: "replay", file: REPLAY },
    output: "machine",
    ...(runtime === undefined ? {} : { runtime }),
  });
  const outcome = await runBuild("blaze.toml", { cwd: directory, reuse: false, model: `replay:${REPLAY}` }, quiet, "build");
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
async function program(source: string, runtime?: "nim", mode?: BuildMode): Promise<{ directory: string; binary: string }> {
  const directory = await scratch("blaze-program-");
  await writeFile(join(directory, "main.ts"), source, "utf8");
  await writeProject(join(directory, "blaze.toml"), {
    language: "typescript",
    sourceFile: "main.ts",
    model: { provider: "replay", file: REPLAY },
    output: "machine",
    ...(runtime === undefined ? {} : { runtime }),
  });
  const outcome = await runBuild(
    "blaze.toml",
    { cwd: directory, reuse: false, model: `replay:${REPLAY}`, ...(mode === undefined ? {} : { mode }) },
    quiet,
    "build",
  );
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

test("a typed array holds the elements its view says it does", async () => {
  // The view an array is allocated from is what says the width of an element,
  // and it was dropped on the way in: every view became a run of doubles. An
  // `Int8Array` then answered 200 where the source answers -56, and a
  // `Float32Array` answered 16777217 where the source answers 16777216. The
  // program is run by node and by the binary the build delivers, so the two
  // are compared by what they print.
  const source = [
    "const narrow = new Int8Array([200, -5]);",
    "console.log(narrow[0]);",
    "const small = new Float32Array([16777217]);",
    "console.log(small[0]);",
    "const wide = new Uint32Array([3000000000]);",
    "console.log(wide[0]);",
    "const walked = new Int32Array([1, 2, 3]);",
    "let total = 0;",
    "for (const value of walked) { total += value; }",
    "console.log(total);",
    "",
  ].join("\n");

  // The IR says the element each view holds, and a view is what says it.
  const program = resolved({ "main.ts": source });
  const views = program.entry.statements
    .filter((one) => one.k === "let" && one.slot.kind === "buffer")
    .map((one) => (one.k === "let" && one.slot.kind === "buffer" ? typeText(one.slot.element) : ""));
  assert.deepEqual(views, ["i8", "f32", "u32", "i32"]);

  const directory = await scratch("blaze-views-");
  await writeFile(join(directory, "main.ts"), source, "utf8");
  await writeProject(join(directory, "blaze.toml"), {
    language: "typescript",
    sourceFile: "main.ts",
    model: { provider: "replay", file: REPLAY },
    output: "machine",
  });
  const outcome = await runBuild("blaze.toml", { cwd: directory, reuse: false, model: `replay:${REPLAY}` }, quiet, "build");
  assert.ok(outcome.outputPath !== null, "a program build delivers its binary");
  const source_ = join(directory, "main.ts");
  const expected = run("node", ["--experimental-strip-types", source_], {});
  const actual = run(outcome.outputPath, [], {});
  assert.equal(actual.code, 0, actual.stderr);
  assert.equal(actual.stdout, expected.stdout, "the built program prints what the source prints");
  assert.equal(expected.stdout.trim().split("\n").join(","), "-56,16777216,3000000000,6");
});

test("a name declared in a block is a variable of its own", () => {
  const program = resolved({
    "main.ts": ["let total = 0;", "{", "  let total = 10;", "  total += 1;", "}", "console.log(total);", ""].join("\n"),
  });
  const inner = program.entry.statements[1];
  assert.equal(inner.k, "block");
  if (inner.k !== "block") throw new Error("expected a block");
  const declared = inner.body.statements[0];
  assert.equal(declared.k, "let");
  if (declared.k !== "let") throw new Error("expected a declaration");
  // The block keeps the name the source wrote, and the two `total` are two
  // variables because each block declares its own. A target whose blocks do
  // not shadow is the one that has to tell them apart.
  assert.equal(declared.slot.name, "total");
  assert.notEqual(inner.body.id, program.entry.id);
  const outer = program.entry.statements[0];
  assert.equal(outer.k === "let" ? outer.slot.name : "", "total");
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
  const loop = program.entry.statements[0];
  assert.equal(loop.k, "loop");
  if (loop.k !== "loop") throw new Error("expected a loop");
  assert.equal(loop.loop.kind, "counted");
  if (loop.loop.kind !== "counted") throw new Error("expected a counted loop");
  assert.deepEqual(loop.loop.type, { kind: "primitive", name: "i64" });
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

test("the Nim driver of a program is compiled at the mode the build was given", async (t) => {
  if (!nimAvailable) {
    t.skip("the Nim compiler is not installed");
    return;
  }
  // The delivered program of a hosted build is the Nim driver, so the mode is
  // the one it has to be built at, whatever the mode the units beside it were.
  const { directory, binary } = await program(LANGUAGE, "nim", "danger");
  const source = run("node", ["main.ts"], { cwd: directory, timeoutMs: 60_000 });
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  const sections = run("readelf", ["-S", binary], { timeoutMs: 30_000 }).stdout;

  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, source.stdout);
  assert.doesNotMatch(sections, /\.debug_info/, "a danger driver must not be built with debug info");
});

test("a program that prints something else is reported against the line it differs on", async () => {
  const directory = await scratch("blaze-oracle-");
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
  const directory = await scratch("blaze-stopped-");
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

test("a delivered program that runs out of memory is a verdict, not a dead build", async (t) => {
  if (run("python3", ["-c", "pass"], { timeoutMs: 30_000 }).spawnError !== undefined) {
    t.skip("python3 is needed to grow more heap than a program is given");
    return;
  }
  const directory = await scratch("blaze-oom-");
  await writeFile(join(directory, "main.ts"), 'console.log("expected");\n', "utf8");

  // The program prints the line the source prints and then grows more heap
  // than it was given. An unbounded build is killed by the system for
  // exhausting memory, which takes the build with it and reports nothing about
  // the program; bounded, the program is refused and says so, and the run comes
  // back to be judged.
  const hog = [
    "import sys",
    'sys.stdout.write("expected\\n"); sys.stdout.flush()',
    "try:",
    "    blocks = []",
    "    for _ in range(4096):",
    "        block = bytearray(1024 * 1024)",
    "        block[0] = 1",
    "        blocks.append(block)",
    "except (OSError, MemoryError):",
    '    sys.stderr.write("blaze: out of memory\\n")',
    "    sys.exit(2)",
  ].join("\n");
  const checked = await verifyProgram({
    language: "typescript",
    sourcePath: join(directory, "main.ts"),
    directory,
    runner: { command: "python3", args: ["-c", hog] },
  });

  // The line it did print is kept: what it managed to print before it stopped
  // is what a repair is told, and an out of memory stop is a fault to repair
  // rather than the end of the build.
  assert.equal(checked.passed, false);
  assert.equal(checked.difference?.failure, "the delivered program exited with status 2");
  assert.equal(checked.difference?.failureOutput, "blaze: out of memory");
  assert.equal(checked.difference?.actualOutput, "expected");
  assert.equal(checked.difference?.line, 2);
  assert.equal(checked.difference?.expected, "");
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

test("a maximum of two zeros is a positive zero and a minimum a negative one", async (t) => {
  // `fmax(0.0, -0.0)` is -0.0 in C and `+0` in the source, and the two numbers
  // compare equal, so the sign is the only thing that tells the two apart: a
  // tie has to be answered by it rather than by whichever arm was written
  // first.
  const source = [
    "console.log(Math.max(0, -0), Math.min(0, -0));",
    "console.log(Math.max(-0, 0), Math.min(-0, 0));",
    "console.log(Math.max(0, 0), Math.min(0, 0));",
    "console.log(Math.max(1, 2), Math.min(1, 2), Math.max(2, 1), Math.min(2, 1));",
    "console.log(Math.max(-5, -5), Math.min(-5, -5));",
    "",
  ].join("\n");
  const { directory, binary } = await program(source);
  const original = run("node", ["main.ts"], { cwd: directory, timeoutMs: 60_000 });
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(original.code, 0, original.stderr);
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.deepEqual(delivered.stdout.trimEnd().split("\n"), ["0 -0", "0 -0", "0 0", "2 1 2 1", "-5 -5"]);
  assert.equal(delivered.stdout, original.stdout);

  if (!nimAvailable) {
    t.skip("the Nim compiler is not installed");
    return;
  }
  await agreesWithNode(source, "nim");
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
  // A bigint is an i64 here, and a literal outside that range was written out
  // as the low sixty-four bits of itself: `18446744073709551615n` printed -1.
  assert.match(
    diagnostic(() => resolved({ "main.ts": ["console.log(18446744073709551615n);", ""].join("\n") })),
    /18446744073709551615 is not a number an i64 holds/,
  );
  // The ends of the range are the numbers themselves, and are kept.
  assert.deepEqual(
    semanticIrProblems(resolved({ "main.ts": ["console.log(9223372036854775807n, -9223372036854775808n);", ""].join("\n") })),
    [],
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

test("a value that is not a number holds nothing, as a condition reads it", async (t) => {
  // `NaN != 0` is true in C and `Boolean(NaN)` is false in the source, so a
  // condition written as a comparison against zero takes the arm it should not.
  const source = [
    "console.log(0 / 0 ? 1 : 0);",
    "console.log(0 / 0 || 7);",
    "console.log(1 ? 1 : 0, 0 ? 1 : 0, 1 / 0 ? 1 : 0);",
    "let n = 0 / 0;",
    "while (n) { console.log(`never`); n = 0; }",
    "if (0 / 0) console.log(`never`); else console.log(`falsy`);",
    "",
  ].join("\n");
  const { directory, binary } = await program(source);
  const original = run("node", ["main.ts"], { cwd: directory, timeoutMs: 60_000 });
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(original.code, 0, original.stderr);
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.deepEqual(delivered.stdout.trimEnd().split("\n"), ["0", "7", "1 0 1", "falsy"]);
  assert.equal(delivered.stdout, original.stdout);

  if (!nimAvailable) {
    t.skip("the Nim compiler is not installed");
    return;
  }
  await agreesWithNode(source, "nim");
});

test("a program in a language the compiler cannot run is refused", async () => {
  const directory = await scratch("blaze-oracle-nim-");
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

test("a stepped loop runs the values the source runs, in both drivers", async (t) => {
  const source = [
    "for (let i = 0; i <= 6; i += 2) console.log(i);",
    "for (let i = 0; i < 6; i += 2) console.log(i);",
    "for (let i = 6; i >= 0; i -= 2) console.log(i);",
    "for (let i = 6; i > 0; i -= 2) console.log(i);",
    "for (let i = 0; i <= 3; i += 1) console.log(i);",
    // `i--` is a step of minus one exactly as `i -= 1` is. It was read as a
    // step of plus one, which sent the index the other way and ran a
    // descending loop for ever instead of stopping on its bound.
    "for (let i = 3; i > 0; i--) console.log(i);",
    "for (let i = 5; i >= 1; i--) console.log(i);",
    "for (let i = 0; i < 3; i++) console.log(i);",
    "for (let i = 4; i > 0; i--) { if (i % 2 === 0) continue; console.log(i); }",
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

test("a number of one width is compared with a number of another as the source compares them", async () => {
  // A `Uint32Array` holds every 32 bit number the source can write, and the
  // values above 2^31 are the ones a signed type cannot hold. Compared as the
  // signed one of the two widths the array was paired with, 4000000000 is
  // -294967296 and every comparison against a small number answers the other
  // way round.
  const source = [
    "const wide = new Uint32Array([4000000000, 0, 2147483648]);",
    "const narrow = new Int32Array([1, 1, -2147483648]);",
    "console.log(wide[0] > narrow[0]);",
    "console.log(wide[1] < narrow[1]);",
    "console.log(wide[2] == narrow[2]);",
    "console.log(wide[0] >= 0, wide[0] < 0);",
    "",
  ].join("\n");
  const { directory, binary } = await program(source);
  const sourceRun = run("node", ["main.ts"], { cwd: directory, timeoutMs: 60_000 });
  assert.equal(sourceRun.code, 0, sourceRun.stderr);
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, "true\ntrue\nfalse\ntrue false\n");
  assert.equal(delivered.stdout, sourceRun.stdout);
});

test("an array the program sizes when it runs is as long as the count it settled on", async () => {
  // A typed array written out is as long as the values written into it, so the
  // only way a program can work out how much it needs is to say how much: the
  // count is a value, the block is settled on it when the program runs, and the
  // length the program reads is the count it asked for.
  const source = [
    "const n = 5;",
    "const a = new Float64Array(n);",
    "console.log(a.length);",
    "for (let i = 0; i < n; i++) a[i] = i * i;",
    "let total = 0;",
    "for (const value of a) total += value;",
    "console.log(total);",
    // A block the program never wrote a value into is the zero the language
    // answers a typed array with, which is what a cleared block gives it.
    "const cleared = new Float64Array(3);",
    "console.log(cleared[0], cleared[2]);",
    "",
  ].join("\n");
  const { directory, binary } = await program(source);
  const sourceRun = run("node", ["main.ts"], { cwd: directory, timeoutMs: 60_000 });
  assert.equal(sourceRun.code, 0, sourceRun.stderr);
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, "5\n30\n0 0\n");
  assert.equal(delivered.stdout, sourceRun.stdout);
});

test("a block the program lays out is three arrays of it, each with its own length", async () => {
  // `new Float64Array(block, offset, n)` is a window of a block rather than a
  // block of its own: three windows over one block are what a program means when
  // it wants three arrays to be one allocation, and each of them is as long as
  // the count it was given, not as long as the block.
  const source = [
    "const n = 4;",
    "const block = new SharedArrayBuffer(3 * 8 * n);",
    "const u = new Float64Array(block, 0, n).fill(1);",
    "const v = new Float64Array(block, 8 * n, n);",
    "const w = new Float64Array(block, 16 * n, n);",
    "for (let i = 0; i < n; i++) {",
    "  v[i] = i;",
    "  w[i] = u[i] + v[i];",
    "}",
    "console.log(u.length, v.length, w.length);",
    "console.log(w[0], w[3]);",
    "",
  ].join("\n");
  const { directory, binary } = await program(source);
  const sourceRun = run("node", ["main.ts"], { cwd: directory, timeoutMs: 60_000 });
  assert.equal(sourceRun.code, 0, sourceRun.stderr);
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, "4 4 4\n1 4\n");
  assert.equal(delivered.stdout, sourceRun.stdout);
});

test("a program declares a function, and a function is given what it reads of the scope around it", async () => {
  // A function of a program is compiled on its own and called, so it has no
  // environment to close over: what it reads of the scope it is declared in is
  // passed to it at every call, and the call is the only place the two scopes
  // meet. A function that calls another is given what that one reads as well,
  // whether or not it says so itself.
  const source = [
    "const n = 4;",
    "function total(values: Float64Array) {",
    "  let sum = 0;",
    "  for (let i = 0; i < n; i++) sum += values[i];",
    "  return sum;",
    "}",
    "function twice(value: number): number {",
    "  return value + value;",
    "}",
    "const a = new Float64Array(n);",
    "for (let i = 0; i < n; i++) a[i] = i;",
    "console.log(total(a));",
    "console.log(twice(twice(3)));",
    "",
  ].join("\n");
  const { directory, binary } = await program(source);
  const sourceRun = run("node", ["main.ts"], { cwd: directory, timeoutMs: 60_000 });
  assert.equal(sourceRun.code, 0, sourceRun.stderr);
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, "6\n12\n");
  assert.equal(delivered.stdout, sourceRun.stdout);
});

test("a function the program declares is a body of its own, and the IR says so", () => {
  // A function of a program is not a run of statements in the block the program
  // starts in: it is a function the IR holds whole, and a call of it is a call
  // like any other, with what it reads of the scope around it passed in.
  const program_ = resolved({
    "main.ts": [
      "const n = 3;",
      "function scale(value: number): number {",
      "  return value * n;",
      "}",
      "console.log(scale(2));",
      "",
    ].join("\n"),
  });
  assert.deepEqual(
    program_.functions.map((signature) => `${signature.name}(${signature.params.map((param) => param.name).join(", ")}) -> ${signature.returns}`),
    ["scale(value, n) -> f64"],
  );
  const [scale] = program_.bodies;
  assert.equal(scale.name, "scale");
  assert.deepEqual(scale.params.map((param) => param.name), ["value", "n"]);
  // The body is a body: it ends by handing back what the source returned, and
  // the return is the one thing only its entry block may do.
  const terminator = scale.entry.terminator;
  assert.equal(terminator.k, "return");
  assert.equal(terminator.k === "return" && terminator.value?.k, "arith");
});

test("a function that reads a name the scope around it does not hold is refused", () => {
  // The names a function is given are the names the scope it is declared in
  // holds above it, and a name declared below it is not one of them: a function
  // is compiled on its own, so what it reads has to be a name somebody declared
  // where the function can see it.
  assert.match(
    diagnostic(() =>
      resolved({
        "main.ts": [
          "const first = 1;",
          "function f(value: number): number {",
          "  return value + later;",
          "}",
          "const later = 2;",
          "console.log(f(first));",
          "",
        ].join("\n"),
      }),
    ),
    /"later" is not declared/,
  );
});

test("a function of a program that calls itself is refused rather than answered", () => {
  // What a function hands back is settled by reading its body, and a function
  // that calls itself is its own answer: a function of a program is compiled on
  // its own, so a recursive one is written as a function of the module, which
  // is contracted and may recurse.
  assert.match(
    diagnostic(() =>
      resolved({
        "main.ts": [
          "const start = 3;",
          "function down(n: number): number {",
          "  if (n > 0) return down(n - 1);",
          "  return 0;",
          "}",
          "console.log(down(start));",
          "",
        ].join("\n"),
      }),
    ),
    /"down" calls itself/,
  );
});

test("`>>>` is the shift the language defines, and `toFixed` writes at the digits it was asked for", async () => {
  // `>>>` reads both of its sides as the unsigned 32 bit numbers the language
  // reads them as, so `-1 >>> 1` is 2147483647 rather than -1, and it converts
  // rather than refusing a number written with a point in it. `toFixed` writes a
  // number at a fixed number of digits, which is not the shortest writing and
  // not the exponent form above a million million million.
  const source = [
    "console.log(-1 >>> 1);",
    "console.log((7 * 8) >>> 2);",
    "const n = 37;",
    "console.log(n >>> 2);",
    "console.log(Math.sqrt(2).toFixed(9));",
    "console.log((1 / 3).toFixed(4));",
    "console.log((-0.0004).toFixed(2));",
    "console.log((1e21).toFixed(2));",
    "",
  ].join("\n");
  const { directory, binary } = await program(source);
  const sourceRun = run("node", ["main.ts"], { cwd: directory, timeoutMs: 60_000 });
  assert.equal(sourceRun.code, 0, sourceRun.stderr);
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, "2147483647\n14\n9\n1.414213562\n0.3333\n-0.00\n1e+21\n");
  assert.equal(delivered.stdout, sourceRun.stdout);
});


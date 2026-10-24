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
import type { ProgramValue } from "../semantics/module.ts";
import { resolveProgram } from "../semantics/ir-resolve.ts";
import { resolveFunction } from "../semantics/ir-function.ts";
import { semanticFunctionProblems, semanticIrProblems } from "../semantics/ir-validate.ts";
import { typeText, type SemanticFunction, type SemanticValue } from "../core/semantic-ir.ts";
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

/**
 * A program that imports a function beside it, checked the same way: the source
 * the two toolchains print is compared, and what the object of the body is laid
 * out as is what the function reads it at.
 */
async function agreesWithNodeLib(source: string, library: string, output: "machine" | "asm" = "machine"): Promise<void> {
  const directory = await scratch("blaze-program-lib-");
  await writeFile(join(directory, "main.ts"), source, "utf8");
  await writeFile(join(directory, "lib.ts"), library, "utf8");
  await writeProject(join(directory, "blaze.toml"), {
    language: "typescript",
    sourceFile: "main.ts",
    model: { provider: "replay", file: REPLAY },
    output,
  });
  const outcome = await runBuild(
    "blaze.toml",
    { cwd: directory, reuse: false, model: `replay:${REPLAY}` },
    quiet,
    "build",
  );
  const binary = outcome.outputPath;
  assert.ok(binary !== null, "a program build delivers its binary");
  const original = run("node", ["main.ts"], { cwd: directory, timeoutMs: 60_000 });
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(original.code, 0, original.stderr);
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, original.stdout);
}

/** The statements of a TypeScript module, as the frontend parsed them. */
function bodyOf(source: string) {
  return typeScriptFrontend.analyze(source, "main.ts").body;
}

/** A program of one entry module and the library it calls, resolved. */
function resolved(files: Record<string, string>) {
  const phase = phaseOf("typescript", files, "main.ts");
  return resolveProgram(phase.body!, phase.program, phase.objectNames, phase.objectLayouts, phase.objectKeys);
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
  // `process.argv[2]` is and not the one `process.argv[0]` would be. The
  // value carries the index it is read at and the offset the arguments begin
  // at, and the offset is what tells the two apart.
  assert.deepEqual(bodyOf("const n = Deno.args[0];\n"), [
    {
      kind: "declare",
      name: "n",
      mutable: false,
      type: null,
      value: {
        k: "argv",
        index: { k: "number", text: "0" },
        offset: 2,
      },
      line: 1,
    },
  ]);
  // The arguments node counts begin at the third, so nothing is offset there.
  assert.deepEqual(bodyOf("const n = process.argv[2];\n"), [
    {
      kind: "declare",
      name: "n",
      mutable: false,
      type: null,
      value: {
        k: "argv",
        index: { k: "number", text: "2" },
        offset: 0,
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

test("an arrow function's body is read", () => {
  assert.match(diagnostic(() => bodyOf("console.log((x) => { console.error(1); });\n")), /console\.error is not part of a program/);
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
  // The IR holds a list of numbers as a block of the values written, and it
  // carries the length the program goes on to read. An empty list is a
  // dynamic array instead: it holds no number, so there is no type to fix it
  // at, and the runtime holds it and answers its length.
  const lengths = program.entry.statements.flatMap((statement) =>
    statement.k === "let" && statement.value.k === "buffer" ? [statement.value.length] : [],
  );
  assert.deepEqual(lengths, [3]);
  // The empty list is the dynamic array the runtime holds, and it is the only
  // name in the program that is one.
  const dynamic = program.entry.statements.flatMap((statement) =>
    statement.k === "let" && statement.slot.kind === "object" ? [statement.slot.name] : [],
  );
  assert.deepEqual(dynamic, ["b"]);
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
    ["const x = yield 1;\n", /"yield" is not part of a program[\s\S]*hands back with return/],
    ["class C { }\n", /"class" is not part of a program[\s\S]*object written where it is made/],
    ["enum E { A }\n", /"enum" is not part of a program[\s\S]*const RED = 0/],
    ["function* g(): number { yield 1; }\n", /a generator is not supported/],
    ["async function g(): number { return 1; }\n", /an async function is not supported/],
  ] as const) {
    assert.match(diagnostic(() => bodyOf(source)), what);
  }
});

test("try, catch and finally are the statements the source means", () => {
  // A compiled program cannot raise, so what a catch arm catches is the
  // failure of a call that was awaited: the runtime keeps the failure pending
  // until the next call is made, and the arm reads it there. The statements
  // are the ones the source means: the failure is cleared before the body
  // runs, the arm runs when one is pending, and the finally body runs after
  // both of them.
  const body = bodyOf("try { console.log(1); }\ncatch (e) { console.log(2); }\nfinally { console.log(3); }\nconst x = 1;\nmain();\n");
  assert.equal(body.length, 3);
  const block = body[0];
  assert.equal(block.kind, "block");
  if (block.kind !== "block") return;
  assert.deepEqual(
    block.body.map((statement) => statement.kind),
    ["invoke", "print", "if", "print"],
  );
  // The failure is cleared before the body runs, so a failure an earlier call
  // left behind is not mistaken for one of this body's own.
  const cleared = block.body[0];
  assert.equal(cleared.kind, "invoke");
  if (cleared.kind === "invoke") assert.equal(cleared.function, "blaze_error_clear");
  // The arm runs when a failure is pending, and the name it binds is the
  // message of that failure.
  const arm = block.body[2];
  assert.equal(arm.kind, "if");
  if (arm.kind === "if") {
    assert.deepEqual(arm.condition, { k: "call", function: "blaze_had_error", args: [] });
    assert.deepEqual(arm.then[0], {
      kind: "declare",
      name: "e",
      mutable: false,
      type: null,
      value: { k: "call", function: "blaze_last_error", args: [] },
      line: 1,
    });
  }
  // The body still ends at the statements that follow the try.
  assert.equal(body[1].kind, "declare");
  assert.equal(body[2].kind, "invoke");
});

test("a try block runs what it holds, and its finally runs after it", async () => {
  // The body of a try runs, and the finally runs after it: the compiled
  // program prints what the source prints.
  const source = ["try { console.log(1); }", "catch (e) { console.log(`caught ${e}`); }", "finally { console.log(3); }", ""].join("\n");
  const { directory, binary } = await program(source);
  const original = run("node", ["main.ts"], { cwd: directory, timeoutMs: 60_000 });
  const delivered = run(binary, [], { timeoutMs: 60_000 });

  assert.equal(original.code, 0, original.stderr);
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, original.stdout);
  // The catch arm does not run: nothing failed.
  assert.deepEqual(delivered.stdout.trimEnd().split("\n"), ["1", "3"]);
});

test("a try block runs in the Nim driver too", async (t) => {
  if (!nimAvailable) {
    t.skip("the Nim compiler is not installed");
    return;
  }
  // The failure a catch arm reads is the runtime's own, and the Nim runtime
  // keeps it the way the C runtime does.
  const source = ["try { console.log(1); }", "catch (e) { console.log(`caught ${e}`); }", "finally { console.log(3); }", ""].join("\n");
  const { directory, binary } = await program(source, "nim");
  const original = run("node", ["main.ts"], { cwd: directory, timeoutMs: 60_000 });
  const delivered = run(binary, [], { timeoutMs: 60_000 });

  assert.equal(original.code, 0, original.stderr);
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, original.stdout);
});

test("an awaited call in a program body is read as a promise await", () => {
  // `await` now waits on a promise, so the call it was written before is
  // wrapped in a `Promise.await` call.
  const body = bodyOf("function f(n: number): number { return n; }\nconst x = await f(1);\nmain();\n");
  const declare = body.find((statement) => statement.kind === "declare" && statement.name === "x") as {
    kind: "declare";
    value: ProgramValue;
  } | undefined;
  assert.ok(declare);
  assert.equal(declare.value.k, "call");
  assert.equal(declare.value.function, "Promise.await");
});

test("a construct outside the subset is named in a function body too", () => {
  for (const [body, what] of [
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

test("a mutable string a nested function captures is stored in a shared cell", () => {
  // The string the outer body writes and the nested function reads are one
  // value, so the binding is a cell the two share: a write inside the nested
  // function updates the binding the outer body reads.
  const source = [
    "let body = ``;",
    "function f(chunk) { body += chunk; }",
    "f(`a`);",
    "f(`b`);",
    "console.log(body);",
    "",
  ].join("\n");
  const program = resolved({ "main.ts": source });
  const declared = program.entry.statements.find((one) => one.k === "let" && one.slot.kind === "text");
  assert.ok(declared !== undefined, "the string is declared");
  if (declared === undefined || declared.k !== "let") throw new Error("expected a declaration");
  assert.equal(declared.slot.kind === "text" ? declared.slot.boxed : false, true, "the string is boxed");

  // The nested function is given the cell, and writes through it.
  const nested = program.bodies.find((body) => body.name === "f");
  assert.ok(nested !== undefined, "the nested function is compiled on its own");
  if (nested === undefined) throw new Error("expected a nested function");
  // The cell is the captured name: the parameter the source wrote is the
  // string it is given, and the capture is the cell it writes through.
  const parameter = nested.params.find((one) => one.kind === "text" && one.name === "body");
  assert.ok(parameter !== undefined, "the nested function is given the string");
  if (parameter === undefined) throw new Error("expected a parameter");
  assert.equal(parameter.kind === "text" ? parameter.boxed : false, true, "the parameter is the cell");
});

test("a parameter the source wrote no type for is read at the type its callers pass it at", () => {
  // A function of a program is compiled on its own, and what a parameter is
  // read at is what the callers of the function pass it at: a string where a
  // string is passed, and a number where a number is.
  const program = resolved({
    "main.ts": [
      "const start = 1;",
      "function show(text, count) { console.log(text, count); }",
      "show(`hello`, 2);",
      "",
    ].join("\n"),
  });
  const body = program.bodies.find((one) => one.name === "show");
  assert.ok(body !== undefined, "the function is compiled on its own");
  if (body === undefined) throw new Error("expected a function");
  const text = body.params.find((one) => one.name === "text");
  const count = body.params.find((one) => one.name === "count");
  assert.equal(text?.kind, "text", "the string the caller passes is a string");
  assert.equal(count?.kind, "value", "the number the caller passes is a number");
  assert.equal(count?.kind === "value" ? typeText(count.type) : "", "f64", "the number is a double");
});

test("a string is given to a function of a program by value", () => {
  // The string the caller builds is the string the callee reads: it is handed
  // over as the text it is, not as a number the caller holds.
  const program = resolved({
    "main.ts": [
      "const greeting = `hello`;",
      "function show(text) { console.log(text); }",
      "show(greeting);",
      "",
    ].join("\n"),
  });
  const body = program.bodies.find((one) => one.name === "show");
  assert.ok(body !== undefined, "the function is compiled on its own");
  if (body === undefined) throw new Error("expected a function");
  const text = body.params.find((one) => one.name === "text");
  assert.equal(text?.kind, "text", "the parameter is a string");
  assert.equal(text?.kind === "text" ? text.boxed : true, false, "the string is the string itself");
});

test("an awaited call in a program body is a statement that runs", () => {
  // `await x;` is a call of the promise the value is, written as a statement:
  // what it waits for has already run by the time the program reads it.
  const program = resolved({
    "main.ts": [
      "const start = 1;",
      "function f() { console.log(`done`); }",
      "await f();",
      "",
    ].join("\n"),
  });
  const statement = program.entry.statements.find((one) => one.k === "call");
  assert.ok(statement !== undefined, "the awaited call is a statement of the program");
  if (statement === undefined) throw new Error("expected a call");
  assert.equal(statement.call.callee, "Promise.await", "the statement awaits the promise");
});

test("an element of a dynamic array is read through the runtime", () => {
  // A dynamic array is a value the runtime holds rather than a block of bytes,
  // so an element of one is read through the runtime.
  const program = resolved({
    "main.ts": [
      "var tasks = [];",
      "tasks.push(7);",
      "console.log(tasks[0]);",
      "",
    ].join("\n"),
  });
  const read = program.entry.statements.find((one) => one.k === "printNumber" || one.k === "printText");
  assert.ok(read !== undefined, "the element is read");
  if (read === undefined) throw new Error("expected a print");
  const value = read.k === "printNumber" || read.k === "printText" ? read.value : null;
  assert.ok(value !== null, "the element is printed");
  if (value === null) throw new Error("expected a value");
  assert.equal(value.k, "call", "the element is read by a call");
  if (value.k !== "call") throw new Error("expected a call");
  assert.equal(value.call.callee, "array.get", "the element is read through the runtime");
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
  // The two `total` are two variables: the block's own declaration is not the
  // one outside it, and the outer read after the block is still the outer one.
  // The IR names a value by one name, so the shadowing declaration is written
  // down under a name of its own rather than leaving the two to be told apart
  // downstream — which is what lets a capture carry the binding it took instead
  // of the name it shares with this one.
  assert.notEqual(declared.slot.name, "total");
  assert.notEqual(inner.body.id, program.entry.id);
  const outer = program.entry.statements[0];
  assert.equal(outer.k === "let" ? outer.slot.name : "", "total");
  const read = program.entry.statements[2];
  assert.equal(read?.k, "printNumber");
  assert.equal(read?.k === "printNumber" ? read.value.k : "", "local");
  assert.equal(read?.k === "printNumber" && read.value.k === "local" ? read.value.name : "", "total");
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

test("a program prints and computes a bigint the way the language it was written in does", async () => {
  // A bigint is the one number in a program that is not a double, and the two
  // ways that shows are the two this covers: the arithmetic is whole, so
  // 9007199254740993n + 1n is 9007199254740994 rather than the 9007199254992 a
  // double answers for it, and it is written with the `n` after it that says
  // which of the two it is. The comparison is the third: two bigints above 2^53
  // are the same number read as doubles and two different ones as bigints.
  const source = [
    "const big = 9007199254740993n;",
    "console.log(big);",
    "console.log(big + 1n);",
    "console.log(big * 2n - 1n);",
    "console.log(big / 3n, big % 7n, big >> 2n);",
    "console.log(big === 9007199254740993n, big === 9007199254740995n, big < 9007199254740995n);",
    "let total = 0n;",
    "for (let i = 0n; i < 4n; i += 1n) total += i * 10000000000n;",
    "console.log(total);",
    // A number is still a number: it computes in doubles and is written without
    // an `n`, and the two beside each other are what the language prints.
    "console.log(7 / 2, 4000000000 + 1, 1 << 4, `${big}`);",
    "",
  ].join("\n");
  const { directory, binary } = await program(source);
  const expected = run("node", ["main.ts"], { cwd: directory, timeoutMs: 60_000 });
  const delivered = run(binary, [], { timeoutMs: 60_000 });

  assert.equal(expected.code, 0, expected.stderr);
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, expected.stdout, "the built program prints what the source prints");
  assert.deepEqual(
    delivered.stdout.trimEnd().split("\n"),
    [
      "9007199254740993n",
      "9007199254740994n",
      "18014398509481985n",
      "3002399751580331n 5n 2251799813685248n",
      "true false true",
      "60000000000n",
      "3.5 4000000001 16 9007199254740993",
    ],
    "a bigint is whole and is written with an n, and a number is neither",
  );
});

test("a bigint the language will not mix with a number is refused", () => {
  // The language raises on a bigint beside a number rather than rounding one into
  // the other, and a program that answered the expression would be answering a
  // different program: a bigint above 2^53 is not the number a double holds.
  const refusals: [string, readonly string[]][] = [
    ["added", ["console.log(1n + 1);"]],
    ["compared", ["console.log(1n < 2);"]],
    ["raised", ["console.log(2n ** 3n);"]],
    ["shifted unsigned", ["console.log(2n >>> 1n);"]],
    ["given to a number", ["function half(n: number): number {", "  return n / 2;", "}", "console.log(half(9007199254740993n));"]],
    ["declared a number", ["const n: number = 9007199254740993n;", "console.log(n);"]],
  ];
  for (const [what, lines] of refusals) {
    assert.match(
      diagnostic(() => resolved({ "main.ts": [...lines, ""].join("\n") })),
      /bigint/,
      `${what} is refused for what it is rather than answered as a number`,
    );
  }
});

test("a function that returns from every path is compiled", async () => {
  // `if (x > 0) return 1; else return 2;` returns from both arms and has no
  // return at the top of the body at all, so what the function hands back is
  // read from the arms and its last block ends where nothing arrives rather than
  // falling out of itself. Before that it could not be compiled at all: the
  // block after the `if` was written as falling through, and a function
  // declared to return a number then ended by handing back whatever the register
  // held.
  const source = [
    "const reach = 8;",
    "function pick(x: number): number {",
    "  if (x > 0) {",
    "    return 1;",
    "  } else {",
    "    return 2;",
    "  }",
    "}",
    "function firstOver(x: number): number {",
    "  for (let i = 0; i < x; i += 1) {",
    "    if (i > 2) {",
    "      return i;",
    "    } else {",
    "      return 0;",
    "    }",
    "  }",
    "  return -1;",
    "}",
    "console.log(pick(reach), pick(-reach), firstOver(reach), firstOver(-reach));",
    "",
  ].join("\n");

  // The IR says so rather than leaving it to a backend to notice: the block the
  // `if` was written in ends where nothing arrives, because both its arms leave,
  // and the loop's body does the same. What is left of `firstOver` is the return
  // the source wrote after the loop, for the turns that never run.
  const built = resolved({ "main.ts": source });
  const pick = built.bodies.find((one) => one.name === "pick");
  assert.equal(pick?.entry.terminator.k, "unreachable", "both arms return, so nothing arrives after the if");
  const first = built.bodies.find((one) => one.name === "firstOver");
  assert.equal(first?.entry.terminator.k, "return", "the loop may run no turns, so the return after it stands");
  const turn = first?.entry.statements[0];
  assert.equal(
    turn?.k === "loop" ? turn.loop.body.terminator.k : null,
    "unreachable",
    "the loop's body returns on its first turn either way",
  );
  const { directory, binary } = await program(source);
  const expected = run("node", ["main.ts"], { cwd: directory, timeoutMs: 60_000 });
  const delivered = run(binary, [], { timeoutMs: 60_000 });

  assert.equal(expected.code, 0, expected.stderr);
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, expected.stdout, "the built program prints what the source prints");
  // The loop's body returns on its first turn whatever the counter is, so the
  // answer is the else arm's 0; a bound below zero runs no turn at all, so the
  // body falls through to the return that follows the loop.
  assert.equal(delivered.stdout, "1 2 0 -1\n");
});

test("a function that falls off the end of a path is refused", () => {
  // The other half of the rule: an `if` with one arm that returns is not a
  // function that returns from every path, and the path that falls off the end
  // of the body has nothing to hand back. That is a build the compiler refuses
  // with the reason, rather than one that answers with a register's contents.
  const source = [
    "const reach = 8;",
    "function maybe(x: number): number {",
    "  if (x > 0) {",
    "    return 1;",
    "  }",
    "}",
    "console.log(maybe(reach));",
    "",
  ].join("\n");
  const phase = phaseOf("typescript", { "main.ts": source }, "main.ts");
  const program = resolveProgram(phase.body!, phase.program, phase.objectNames, phase.objectLayouts, phase.objectKeys);
  assert.deepEqual(semanticIrProblems(program, phase.program), [
    "maybe: entry: the body returns nothing and is declared to return a f64",
  ]);
});

test("a block that ends where nothing arrives is proved rather than believed", () => {
  // The word is one a model or a person can write into IR text, and a block that
  // claims it while nothing in it leaves is a block that control does continue
  // past — so the claim is proved where every other claim about a body is. The
  // block here is an arm, because that is where a resolver writes one: an entry
  // block that returns from every path is a function that returns, not a claim.
  const fn: SemanticFunction = {
    name: "subject",
    symbol: "subject",
    params: [{ kind: "value", name: "n", mutable: false, type: { kind: "primitive", name: "f64" } }],
    returns: { kind: "primitive", name: "f64" },
    requires: [],
    ensures: [],
    effects: [],
    allocates: false,
    prints: true,
    readsArgv: false,
    objects: {},
    calls: [],
    entry: {
      id: "entry",
      releases: [],
      statements: [
        {
          k: "if",
          condition: { k: "local", type: { kind: "primitive", name: "f64" }, name: "n" },
          then: {
            id: "b1",
            releases: [],
            statements: [{ k: "printNumber", value: { k: "const", type: { kind: "primitive", name: "f64" }, text: "1" }, line: 2, bigint: false }],
            // Nothing in this block leaves: it prints, and then claims that
            // control does not continue past it.
            terminator: { k: "unreachable" },
          },
          otherwise: null,
          line: 2,
        },
      ],
      terminator: { k: "return", value: { k: "const", type: { kind: "primitive", name: "f64" }, text: "0" } },
    },
  };
  assert.deepEqual(semanticFunctionProblems(fn), [
    "subject: b1: the block ends where nothing arrives, but nothing in it leaves",
  ]);
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
  // The proof grows a real heap past the delivered program's own, which on a
  // machine with little room to spare is the thing the system kills. A run of
  // the optimizer sets the variable, because a session that is benchmarking
  // the suite cannot afford the two gigabytes the proof touches; a person
  // running the suite by hand gets the proof.
  if (process.env.BLAZE_SKIP_HEAP_PROOF !== undefined) {
    t.skip("BLAZE_SKIP_HEAP_PROOF is set, so the heap proof is left out");
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

/**
 * A program the machine backend lowers every function of, with the notes the
 * build made. The notes are what says the machine backend refused a body, so a
 * test that pins a shape the machine lowers reads them and asserts none of
 * them refused.
 */
async function deliveredByMachine(
  source: string,
  mode?: BuildMode,
): Promise<{ directory: string; binary: string; notes: string[] }> {
  const directory = await scratch("blaze-machine-");
  await writeFile(join(directory, "main.ts"), source, "utf8");
  await writeProject(join(directory, "blaze.toml"), {
    language: "typescript",
    sourceFile: "main.ts",
    model: { provider: "replay", file: REPLAY },
    output: "machine",
  });
  const notes: string[] = [];
  const outcome = await runBuild(
    "blaze.toml",
    { cwd: directory, reuse: false, model: `replay:${REPLAY}`, ...(mode === undefined ? {} : { mode }) },
    { stage: (_at: string, _level: string, message: string) => notes.push(message) },
    "build",
  );
  assert.ok(outcome.outputPath !== null, "a program build delivers its binary");
  return { directory, binary: outcome.outputPath, notes };
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

test("a whole operation over a mixed pair keeps the wider of the two", async (t) => {
  // `length - 10` is signed because a length is read as a `usize`, and that is
  // the only pair that exception answers. Answering it by the first signed name
  // present made `u32 << i8` an `i8`, so the 4096 was 0 before the shift and the
  // program printed zero.
  const source = [
    "const wide = new Uint32Array(4);",
    "const narrow = new Int8Array(4);",
    "wide[0] = 4096;",
    "narrow[0] = 4;",
    "console.log(wide[0] << narrow[0]);",
    "console.log(wide[0] & 255);",
    "",
  ].join("\n");
  const { directory, binary } = await program(source);
  const original = run("node", ["main.ts"], { cwd: directory, timeoutMs: 60_000 });
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(original.code, 0, original.stderr);
  assert.equal(delivered.stdout, original.stdout, "the program answers what the language answers");
  assert.deepEqual(delivered.stdout.trimEnd().split("\n"), ["65536", "0"]);
  if (!nimAvailable) {
    t.skip("the Nim compiler is not installed");
    return;
  }
  await agreesWithNode(source, "nim");
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
  // A bigint outside the i64 range is a `u256`, which the program holds at
  // four limbs: the `n` after it is preserved, so the source prints what it
  // wrote and the build does not refuse it.
  assert.deepEqual(
    semanticIrProblems(resolved({ "main.ts": ["console.log(18446744073709551615n);", ""].join("\n") })),
    [],
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

test("`>>>` by nothing still converts the value it shifts", async () => {
  // A shift by nothing moves no bit, but `>>>` is a conversion as well as a
  // shift: the value is read as one of the unsigned 32 bit numbers the
  // language reads them as, so `-1 >>> 0` is 4294967295 and not -1. The
  // rewrite that folded the shift away folded the conversion with it.
  const source = [
    "console.log(-1 >>> 0);",
    "console.log(5000000000 >>> 0);",
    "let x = -1;",
    "console.log(x >>> 0);",
    "",
  ].join("\n");
  const { directory, binary } = await program(source);
  const sourceRun = run("node", ["main.ts"], { cwd: directory, timeoutMs: 60_000 });
  assert.equal(sourceRun.code, 0, sourceRun.stderr);
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, "4294967295\n705032704\n4294967295\n");
  assert.equal(delivered.stdout, sourceRun.stdout);
});

test("`>>>` in a function body is the shift the language defines", async () => {
  // `>>>` reads both of its sides as the unsigned 32 bit numbers the language
  // reads them as, and a function body is read by the other resolver, which
  // typed the shift as the type of the two sides: a shift of a double, which
  // the C backend wrote as `double >> double` — not C at all, so the build
  // failed where the language has an answer.
  const source = [
    "function shift(x: number): number {",
    "  return x >>> 1;",
    "}",
    "console.log(shift(-1));",
    "console.log(shift(56 >>> 2));",
    "console.log(shift(7 * 8) >>> 2);",
    "",
  ].join("\n");
  const { directory, binary } = await program(source);
  const sourceRun = run("node", ["main.ts"], { cwd: directory, timeoutMs: 60_000 });
  assert.equal(sourceRun.code, 0, sourceRun.stderr);
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, "2147483647\n7\n7\n");
  assert.equal(delivered.stdout, sourceRun.stdout);
});

test("a compound assignment a whole operator needs is refused on a double in a function body", () => {
  // A compound assignment writes its operator down on the type of the name, so
  // `%=` on a double is a target no compiler accepts: the C backend wrote
  // `x %= 3.0`, which is not C at all. The program path refuses the same
  // write by name, and a function body refuses it the same way.
  const refused = diagnostic(() => {
    const phase = phaseOf(
      "typescript",
      { "main.ts": "export function f(): number {\n  let x = 7;\n  x %= 3;\n  return x;\n}\nconsole.log(f());\n" },
      "main.ts",
    );
    const contracts = phase.program.files.flatMap((file) => Object.entries(file.functions));
    const context = {
      objectNames: phase.objectNames,
      functions: Object.fromEntries(contracts),
      language: phase.program.language,
    };
    resolveFunction(contracts[0][1], context);
  });
  assert.match(refused, /"%" needs whole numbers/);
  assert.match(refused, /"x" is a f64/);
});

test("the body of a loop is a scope of its own", () => {
  // A name a loop body declares is a name of that body: a name outside it may
  // be declared again inside it, and a name it declares is not a name outside
  // it. The body of a loop was resolved in the scope around it, so a name it
  // declared was a name of that scope and a read of it after the loop was a
  // read of a name nothing declares.
  const shadowed = resolved({
    "main.ts": ["let i = 0;", "while (i < 3) {", "  let i = 10;", "  console.log(i);", "}", ""].join("\n"),
  });
  assert.deepEqual(semanticIrProblems(shadowed), []);

  const leaked = diagnostic(() =>
    resolved({
      "main.ts": ["let j = 0;", "while (j < 3) {", "  let k = 5;", "  j += 1;", "}", "console.log(k);", ""].join("\n"),
    }),
  );
  assert.match(leaked, /"k" is not declared/);
});

test("a loop that never ends ends the block it is written in", () => {
  // `while (true)` without a break never ends, so what the source wrote after
  // it is dead. The block says so, and the statements after it are written
  // nowhere: a block that claims nothing arrives and then holds the statements
  // that follow it is a block the validator refuses.
  const program = resolved({
    "main.ts": ["let i = 0;", "while (true) { i += 1; }", "console.log(i);", ""].join("\n"),
  });
  assert.deepEqual(semanticIrProblems(program), []);
});

test("the left arm of a logical operator that calls is written once", () => {
  // The left arm of a logical operator decides first, and the source form of
  // these operators writes that arm out twice, so a call in it is written under
  // a name. The length of a buffer is asked of the runtime, and an arm that
  // asks is an arm that cannot be written twice.
  const program = resolved({
    "main.ts": ["const a = new Float64Array(3);", "if (a.length > 0 && a.length < 5) { console.log('yes'); }", ""].join("\n"),
  });
  assert.deepEqual(semanticIrProblems(program), []);
});

test("a loop that stops at a fraction stops where the language stops it", async () => {
  // The counter of a loop is a whole number and the bound it stops at may be a
  // fraction, and the language compares the two as the numbers they are:
  // `for (let i = 0; i < 5.5; i++)` counts six turns, because five is below
  // the bound and six is above it. A bound read at the counter's width stopped
  // the loop at five and counted five turns, which is a number the program
  // never wrote.
  const source = [
    "let c = 0;",
    "for (let i = 0; i < 5.5; i++) { c += 1; }",
    "console.log(c);",
    "let d = 0;",
    "for (let i = 0; i <= 5.5; i++) { d += 1; }",
    "console.log(d);",
    "let e = 0;",
    "for (let i = 10; i > 5.5; i--) { e += 1; }",
    "console.log(e);",
    "const n = 5.5;",
    "let f = 0;",
    "for (let i = 0; i < n; i++) { f += 1; }",
    "console.log(f);",
    "let g = 0;",
    "for (let i = 0; i < 5; i++) { g += 1; }",
    "console.log(g);",
    "",
  ].join("\n");
  const { directory, binary } = await program(source);
  const sourceRun = run("node", ["main.ts"], { cwd: directory, timeoutMs: 60_000 });
  assert.equal(sourceRun.code, 0, sourceRun.stderr);
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, "6\n6\n5\n6\n5\n");
  assert.equal(delivered.stdout, sourceRun.stdout);
});

test("a loop that counts in fractions stops at the fraction it was written with", async () => {
  // A counter that counts in fractions is compared against the bound as it is:
  // the bound of this loop is half a number and the loop stops there, which is
  // five turns and not the ten a whole counter against a rounded bound would
  // have counted.
  const source = [
    "let count = 0;",
    "for (let k = 0.0; k < 0.5; k += 0.1) { count += 1; }",
    "console.log(count);",
    "",
  ].join("\n");
  const { directory, binary } = await program(source);
  const sourceRun = run("node", ["main.ts"], { cwd: directory, timeoutMs: 60_000 });
  assert.equal(sourceRun.code, 0, sourceRun.stderr);
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, "5\n");
  assert.equal(delivered.stdout, sourceRun.stdout);
});

test("a loop counter is not hoisted out of the loop that declares it", async () => {
  // `j === 1` is computed on every turn of the inner loop and is the same value
  // on every turn of the *outer* one as far as the outer loop can see — the
  // name it reads is written by a loop nested inside it. Hoisting it left a
  // binding above the outer loop reading a counter that was never declared
  // there, which the validator refuses by name.
  const source = [
    "let s = 0;",
    "for (let i = 0; i < 4; i++) {",
    "  for (let j = 0; j < 4; j++) {",
    "    if (j === 1) {",
    "      break;",
    "    }",
    "    s += 1;",
    "  }",
    "}",
    "console.log(s);",
    "let t = 0;",
    "for (let i = 0; i < 4; i++) {",
    "  for (let j = 0; j < 4; j++) {",
    "    if (j === 1) {",
    "      continue;",
    "    }",
    "    t += 1;",
    "  }",
    "}",
    "console.log(t);",
    "",
  ].join("\n");
  await agreesWithNode(source);
});

test("an update of a name nothing reads is a statement the compiler keeps", async () => {
  // `dropUnread` removes a binding nothing reads, which is a slot and a store on
  // every target. The name an update writes is one of those: removing the
  // declaration and keeping the increment left a statement writing a slot the
  // block never declared.
  const source = [
    "function bump(n: number): number {",
    "  let i = 0;",
    "  i++;",
    "  return n;",
    "}",
    "console.log(bump(1));",
    "",
  ].join("\n");
  await agreesWithNode(source);
});

test("a square root in a compiled function is the C library's, not an unknown name", async () => {
  // `Math.sqrt` is lowered as a call to the C library's `sqrt`, and a compiled
  // function is the one path that emits that call: a program body is written
  // into the driver and `gcc` resolves it there. The table of library names the
  // machine backend allows did not carry `sqrt`, so the name was refused at the
  // end of the build as one that is "neither the runtime, the C library, nor a
  // function of this program".
  const source = [
    "export function root(x: number): number {",
    "  return Math.sqrt(x);",
    "}",
    "console.log(root(2));",
    "console.log(root(0));",
    "console.log(root(1e12));",
    "console.log(Math.sqrt(2) * Math.sqrt(2));",
    "",
  ].join("\n");
  await agreesWithNode(source);
});

test("arithmetic over a loop counter keeps the fraction beside it", async () => {
  // A loop counter the resolver cannot type more precisely is an `i64`, and the
  // rule that kept an `i64` beside a double — the `i64` a bigint is — read that
  // width as a bigint. So `i + 0.5` inside a loop was answered at sixty-four
  // bits and the half was dropped before any backend saw it: the array it was
  // written into held `i`, and `i / 2` became an integer division.
  const source = [
    "export function spread(n: number): number {",
    "  let a = new Float64Array(n);",
    "  let total = 0;",
    "  for (let i = 0; i < n; i++) {",
    "    a[i] = i * 1.5;",
    "  }",
    "  for (let i = 0; i < n; i++) {",
    "    total += a[i];",
    "  }",
    "  return total;",
    "}",
    "console.log(spread(5));",
    "console.log(spread(1));",
    "",
  ].join("\n");
  await agreesWithNode(source);
});

test("the width a bigint is computed at survives a call", async () => {
  // `i64` is what a bigint is, and a function declared `: bigint` hands one
  // back. Without that, `fact(20n)` was computed as a double and printed
  // without the `n` that is what says it is a bigint — and `fact(20n) + 1n` was
  // refused as a bigint mixed with a number.
  const source = [
    "export function fact(n: bigint): bigint {",
    "  if (n <= 1n) {",
    "    return 1n;",
    "  }",
    "  return n * fact(n - 1n);",
    "}",
    "export function keep(n: bigint): bigint {",
    "  return n;",
    "}",
    "export function widen(n: number): number {",
    "  return n;",
    "}",
    "console.log(fact(20n));",
    "console.log(keep(5n));",
    "console.log(keep(5n) + 1n);",
    "console.log(widen(5));",
    "",
  ].join("\n");
  await agreesWithNode(source);
});

test("an object literal is allocated, read, and handed to a compiled function", async () => {
  // The last of these is the one a program body has no other way to do: a
  // literal with nothing to read is nearly useless, and the object the body
  // builds is only worth having once a compiled function reads its fields. The
  // layout the function contracted is the same layout the body wrote the
  // literal as, because a shape is keyed by its fields whichever side wrote it.
  //
  // The function reads the numbers out of what the body built, which is the
  // whole of the point: the layout it contracted is the layout the literal was
  // written at, because a shape is keyed by its fields whichever side wrote it.
  const directory = await scratch("blaze-program-object-");
  await writeFile(
    join(directory, "main.ts"),
    [
      "import { sum } from \"./lib.ts\";",
      "const point = { x: 3, y: 4 };",
      "console.log(sum(point));",
      "console.log(point.x, point.y);",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(directory, "lib.ts"),
    ["export function sum(p: any): number {", "  return p.x + p.y;", "}", ""].join("\n"),
  );
  await writeProject(join(directory, "blaze.toml"), {
    language: "typescript",
    sourceFile: "main.ts",
    model: { provider: "replay", file: REPLAY },
    output: "machine",
  });
  const outcome = await runBuild(
    "blaze.toml",
    { cwd: directory, reuse: false, model: `replay:${REPLAY}` },
    quiet,
    "build",
  );
  assert.ok(outcome.outputPath !== null, "a program build delivers its binary");
  const original = run("node", ["--experimental-strip-types", "main.ts"], { cwd: directory, timeoutMs: 60_000 });
  const delivered = run(outcome.outputPath, [], { timeoutMs: 60_000 });
  assert.equal(original.code, 0, original.stderr);
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, original.stdout);
});

test("the compound operators are the binary one over the name and the value", async () => {
  // `&=` and the rest name the operator they apply, and all of them are
  // defined as that binary operator over the name and the value: every one of
  // the seven, and a power raised in place on a number.
  const source = [
    "const a = new Int32Array([7, 0, 8, 3, 2, 9]);",
    "a[0] &= 3;",
    "a[1] |= 8;",
    "a[2] ^= 15;",
    "a[3] <<= 1;",
    "a[4] >>= 1;",
    "a[5] >>>= 1;",
    "console.log(a[0], a[1], a[2], a[3], a[4], a[5]);",
    "let x = 2;",
    "x **= 10;",
    "console.log(x);",
    "let t = 0;",
    "for (let i = 1; i < 4; i += 1) { i &= 7; t += i; }",
    "console.log(t);",
    "",
  ].join("\n");
  await agreesWithNode(source);
});

test("a compound assignment over a wide number is the binary form the kernel answers", async () => {
  // A wide number has no operator a backend can write: `a <<= 2` over a `u256`
  // is `invalid operands to binary << (have 'blaze_u256' and 'blaze_u256')` to
  // gcc, and the machine backend has no instruction over four limbs. The binary
  // form of the same operation is the one the kernel answers, so every operator
  // a wide number has is written that way and the program is the same one.
  const source = [
    "let a: u256 = 100;",
    "a += 2;",
    "a -= 1;",
    "a *= 3;",
    "a /= 2;",
    "a %= 5;",
    "a &= 0xff;",
    "a |= 0x100;",
    "a ^= 0x1;",
    "a <<= 2;",
    "a >>= 1;",
    "console.log(a);",
    "",
  ].join("\n");
  await agreesWithNode(source);
});

test("a wide number is shifted by the machine word the count is written as", async () => {
  // The count of a shift is the machine word every backend writes it at, so a
  // count that is a program number is the number of bits to move rather than a
  // number of the width being shifted — which is the low half of the number
  // being shifted. A count that is itself a wide number is refused by name,
  // because four limbs of count are not a number of bits any target reads the
  // same way.
  const source = [
    "let a: u256 = 5;",
    "let n = 3;",
    "console.log(a << n);",
    "let b: u256 = 40;",
    "console.log(b >> n);",
    "",
  ].join("\n");
  await agreesWithNode(source);
  // A count that is itself a wide number is refused by the validator rather than
  // by the resolver, because which counts a kernel takes is a property of the
  // IR and not of the expression it came from.
  const wide = phaseOf("typescript", { "main.ts": "let a: u256 = 5;\nlet c: u256 = 3;\nconsole.log(a << c);\n" }, "main.ts");
  const program = resolveProgram(wide.body!, wide.program, wide.objectNames, wide.objectLayouts, wide.objectKeys);
  assert.match(
    semanticIrProblems(program, wide.program).join("\n"),
    /a shift count is the machine word the source wrote the shift by/,
  );
});

test("a compound over a wide number is the same program through the C backend", async () => {
  // The gcc spellings are where `a <<= 2` was `invalid operands to binary <<`, so
  // a wide compound is answered through the C backend as well as through the
  // machine one. A wide number written where a double is read is refused by
  // name rather than written where gcc cannot read it, which is the same rule an
  // element write states.
  const source = [
    "let a: u256 = 100;",
    "a <<= 3;",
    "a &= 0xff;",
    "console.log(a);",
    "const point = { x: 1, y: 2 };",
    "point.x = 5;",
    "point.y += 1;",
    "console.log(point.x, point.y);",
    "",
  ].join("\n");
  // A program is checked against the output of its own toolchain, and the two
  // backends write the same program: `agreesWithNodeLib` builds it for both.
  await agreesWithNodeLib(source, "", "asm");
});

test("a field of a program object is written where the source writes it", async () => {
  // `p.x = 1` is a store into the block the body allocated, the same way a
  // compiled function writes one, and a compound over it is a read of the field,
  // the operation and the store. The layout is the one the body wrote the
  // literal at, because a shape is keyed by its fields whichever side writes it.
  const written = bodyOf("p.x = 10;\np.y += 5;\n").map((statement) => statement.kind);
  assert.deepEqual(written, ["fieldAssign", "fieldAssign"], "a field write is a statement of a program");
  await agreesWithNodeLib(
    [
      "import { sum } from \"./lib.ts\";",
      "const point = { x: 3, y: 4 };",
      "point.x = 10;",
      "point.y += 5;",
      "console.log(point.x, point.y);",
      "console.log(sum(point));",
      "",
    ].join("\n"),
    ["export function sum(p: any): number {", "  return p.x + p.y;", "}", ""].join("\n"),
  );
});

test("a wide number is not written where a double is read", () => {
  // A field of a layout holds the type the layout gives it, and a wide number
  // read as a double is the low half of a number the program never computed —
  // the same rule an element write states, and the one that keeps a build from
  // reaching gcc with a blob assigned to a double.
  const phase = phaseOf("typescript", { "main.ts": "let a: u256 = 5;\nconst p = { x: 1, y: 2 };\np.x = a;\nconsole.log(p.x);\n" }, "main.ts");
  const program = resolveProgram(phase.body!, phase.program, phase.objectNames, phase.objectLayouts, phase.objectKeys);
  assert.match(
    semanticIrProblems(program, phase.program).join("\n"),
    /Object1\.x is a f64, not a u256/,
  );
});

test("a compound assignment to a field of a function body is the read, the operation and the store", async () => {
  // A compiled function writes into the fields of what it is handed, and the
  // operators it writes them with are the ones the source names: `p.n += 1` was
  // a parse error in a body (`unexpected "+=" in an expression`), and only `=`
  // was read. Both halves of the write now read the same bytes and answer what
  // the language answers.
  await agreesWithNodeLib(
    [
      "import { write } from \"./lib.ts\";",
      "const inner = { v: 2, n: 1 };",
      "const outer = { up: inner, n: 9 };",
      "console.log(write(inner, 40), inner.v, inner.n);",
      "console.log(outer.up.v + outer.n);",
      "",
    ].join("\n"),
    [
      "export function write(p: any, value: number): number {",
      "  p.v += value;",
      "  p.n -= 1;",
      "  return p.v + p.n;",
      "}",
      "",
    ].join("\n"),
  );
});

test("a field of a literal holds the shape of the name it is written from", async () => {
  // A name is a reference, so a field written from one is a field of the shape
  // the name's own literal was written at — read off that literal rather than
  // guessed at, because a literal written into a literal is an object of its own
  // laid out beside the one it was written into. A read of what the field holds
  // is a read of that layout, one level down.
  await agreesWithNodeLib(
    [
      "import { total } from \"./lib.ts\";",
      "const inner = { v: 2 };",
      "const outer = { up: inner, n: 1 };",
      "console.log(outer.up.v + outer.n);",
      "console.log(total(outer));",
      "",
    ].join("\n"),
    ["export function total(p: any): number {", "  return p.up.v + p.n;", "}", ""].join("\n"),
  );
});

test("a null-coalescing assign still refuses, named rather than tokenised wrong", () => {
  // `??=` has no BinaryOp in the IR. It keeps its refusal, and the operator
  // must tokenize whole — one token, so the message lands on it — rather than
  // falling apart into `?` `?` `=` and reporting the wrong place.
  const message = diagnostic(() => bodyOf("let x = 1;\nx ??= 3;\nconsole.log(x);\n"));
  assert.match(message, /"x \?\?=" is not an assignment a program can make/);
});

test("a compiled function allocates the array it was written to build", async () => {
  // `export function` is how a module offers a function, and the contract
  // frontend read no `new` at all: `new Float64Array(n)` parsed as a call to a
  // function named `new`, and the build refused the program with `unknown
  // identifier "new"`. The same two spellings the program body has always read
  // are read here, and the machine backend sizes the array from the count.
  const source = [
    "export function sized(n: number): number {",
    "  let a = new Float64Array(n);",
    "  for (let i = 0; i < n; i++) {",
    "    a[i] = i * 1.5;",
    "  }",
    "  let total = 0;",
    "  for (let i = 0; i < n; i++) {",
    "    total += a[i];",
    "  }",
    "  return total;",
    "}",
    "export function literal(): number {",
    "  let a = new Float64Array([1, 2, 3, 4]);",
    "  return a[0] + a[1] + a[2] + a[3];",
    "}",
    "export function narrow(n: number): number {",
    "  let a = new Int32Array(n);",
    "  for (let i = 0; i < n; i++) {",
    "    a[i] = i * i;",
    "  }",
    "  return a[0] + a[3];",
    "}",
    "console.log(sized(5));",
    "console.log(sized(0));",
    "console.log(literal());",
    "console.log(narrow(4));",
    "",
  ].join("\n");
  await agreesWithNode(source);
});

test("a declared function reads the bitwise operators where JavaScript puts them", async () => {
  // `&`, `^` and `|` bind looser than a shift and tighter than a comparison,
  // and the program body has always read them there. A function the module
  // declared could not use one at all: the token reached the expression reader
  // and the build stopped on `unexpected "&" in an expression`.
  const source = [
    "export function bits(i: number): number {",
    "  return i & 3;",
    "}",
    "export function mixed(a: number, b: number, c: number): number {",
    "  return a & b ^ c;",
    "}",
    "export function looser(a: number, b: number, c: number): number {",
    "  return a ^ b | c;",
    "}",
    "export function withShift(a: number): number {",
    "  return a << 1 | 1;",
    "}",
    "export function withAdd(a: number): number {",
    "  return a + 1 & 3;",
    "}",
    "console.log(bits(10));",
    "console.log(mixed(1, 3, 1));",
    "console.log(looser(6, 1, 2));",
    "console.log(withShift(2));",
    "console.log(withAdd(6));",
    "",
  ].join("\n");
  await agreesWithNode(source);
});

test("a number written at a fixed number of digits is written at them", async () => {
  // The machine backend lowered `toFixed` by ignoring the digits it was given,
  // so a compiled function wrote the shortest form of the number and a program
  // body wrote the digits — the same source, two answers. And a tie is written
  // away from zero in the language where the C library breaks one to even, so
  // `(2.5).toFixed(0)` is 3 and the library answers 2. Both backends now ask
  // the runtime for it, which is where the break is corrected on the exact
  // value: `1.005` is written `1.005` by a library rounding it correctly and is
  // not a tie, because the double under it is a hair below it.
  const source = [
    "export function show(x: number): void {",
    "  console.log(x.toFixed(0));",
    "  console.log(x.toFixed(2));",
    "  console.log(x.toFixed(6));",
    "}",
    "const k = 0;",
    "show(2.5);",
    "show(-2.5);",
    "show(0.5);",
    "show(-0.5);",
    "show(3.5);",
    "show(1.5);",
    "show(0.25);",
    "show(1.25);",
    "show(1.75);",
    "show(-0.75);",
    "show(1.005);",
    "show(2.675);",
    "show(9.5);",
    "show(0.125);",
    "show(-0.004);",
    "show(1 / 3);",
    "show(1e21);",
    "console.log((2.5).toFixed(0));",
    "console.log((0.5).toFixed(0));",
    "console.log((-2.5).toFixed(0));",
    "",
  ].join("\n");
  await agreesWithNode(source);
});

test("a wide number is written by the kernel every backend shares", async () => {
  // A `u256` is four limbs and no machine register, so an operation over one is
  // a call into the kernel rather than a C operator. The program driver had no
  // such call: `a + b` was written as C `+` over two structs, and a print was
  // `(unsigned long long)(a_u256)`, which gcc refuses as "aggregate value used
  // where an integer was expected". Both failed at the link, with the C
  // compiler's complaint rather than the compiler's own.
  const source = [
    "export function wide(a: u256, b: u256): u256 {",
    "  return a + b;",
    "}",
    "export function less(a: u256, b: u256): boolean {",
    "  return a < b;",
    "}",
    "const k = 1;",
    "let a: u256 = 12;",
    "let b: u256 = 30;",
    "console.log(a + b);",
    "console.log(a * b);",
    "console.log(a & b);",
    "console.log(a | b);",
    "console.log(a ^ b);",
    "console.log(wide(5, 7));",
    "console.log(less(5, 7));",
    "console.log(less(9, 7));",
    "",
  ].join("\n");
  await agreesWithNode(source);
});

test("a refusal names what each side of the operation is", async () => {
  // What each side is, in the language's own words, is what a person reading
  // the message needs: a program that cannot mix a bigint with a fraction is
  // told a bigint and a number, not two things it cannot name.
  const plain = phaseOf("typescript", { "main.ts": "console.log(1n + 1.5);\n" }, "main.ts");
  assert.throws(
    () => resolveProgram(plain.body!, plain.program, plain.objectNames, plain.objectLayouts, plain.objectKeys),
    /cannot mix a bigint and a number/,
  );
  // A wide number beside a double is refused where the type of the operation is
  // settled rather than where the source is read: the widening that is allowed
  // beside one is a whole number, and a fraction is not a whole number however
  // it was written.
  const wide = phaseOf("typescript", { "main.ts": "let a: u256 = 3;\nconsole.log(a + 1.5);\n" }, "main.ts");
  const program = resolveProgram(wide.body!, wide.program, wide.objectNames, wide.objectLayouts, wide.objectKeys);
  assert.match(semanticIrProblems(program, wide.program).join("\n"), /a f64 is computed with a u256/);
});

test("a wide number beside a bigint is the compiler's own widening", async () => {
  // The language has no `u256`, so a bigint beside one is not a mix of two
  // kinds: it is the compiler's spelling of a bigint too wide for a machine
  // word, and the count of a shift is a machine word whatever it was written
  // as. The shift below is the program, not a refusal about a mix.
  const phase = phaseOf("typescript", { "main.ts": "let a: u256 = 3;\nconsole.log(a << 2n);\n" }, "main.ts");
  const program = resolveProgram(phase.body!, phase.program, phase.objectNames, phase.objectLayouts, phase.objectKeys);
  assert.deepEqual(semanticIrProblems(program, phase.program), []);
});

test("a fill written for what it does is a statement a program runs", async () => {
  // `a.fill(x)` bound to a name is an expression, because it hands the array
  // back. Written on its own there is nowhere to hand it to, and the statement
  // was refused by name: `"a.fill" is not a statement of a program; a program
  // calls what it compiles`. It is the one the semantic IR already has.
  const source = [
    "const n = 5;",
    "let a = new Float64Array(n);",
    "a.fill(0);",
    "for (let i = 0; i < n; i++) {",
    "  a[i] = a[i] + i * 0.5;",
    "}",
    "console.log(a[0]);",
    "console.log(a[4]);",
    "let b = new Uint8Array(4);",
    "b.fill(200);",
    "console.log(b[0]);",
    "let c = new Float64Array(3);",
    "c.fill(1.5);",
    "c[1] += 2;",
    "console.log(c[0]);",
    "console.log(c[1]);",
    "",
  ].join("\n");
  await agreesWithNode(source);
});

test("an element is written by the operator the source wrote", async () => {
  // `a[i] += x` reads the element and writes the sum back. The statement the
  // frontend read carried no operator at all, so the compound forms were a
  // parse error in a declared function — `unexpected "+=" in an expression`.
  const source = [
    "export function accumulate(n: number): number {",
    "  let a = new Float64Array(n);",
    "  a[0] = 1;",
    "  a[1] += 5;",
    "  a[2] *= 3;",
    "  a[3] -= 0.5;",
    "  let total = 0;",
    "  for (let i = 0; i < n; i++) {",
    "    total += a[i];",
    "  }",
    "  return total;",
    "}",
    "console.log(accumulate(4));",
    "",
  ].join("\n");
  await agreesWithNode(source);
});

test("a wide number the source wrote as a bigint is printed with the n that says so", async () => {
  // The language has no `u256`, so every value that is one here was written as a
  // bigint — and the language prints a bigint with an `n` after it. Digits alone
  // are a program whose output does not match the source it is checked against,
  // and the marker follows the value rather than the type: a wide number the
  // source wrote as a number (`let a: u256 = 12`) prints its digits, because that
  // is what the source prints for it.
  const source = [
    "export function add(a: u256, b: u256): u256 {",
    "  return a + b;",
    "}",
    "export function wide(n: u256): u256 {",
    "  return n;",
    "}",
    "const a = wide(5n);",
    "const b = add(5n, 7n);",
    "console.log(a);",
    "console.log(a + b);",
    "console.log(a === 5n);",
    "console.log(a < b);",
    "console.log(b >> 1n);",
    "let written: u256 = 12;",
    "console.log(written);",
    "",
  ].join("\n");
  await agreesWithNode(source);
});

test("a wide number a call with no arguments hands back is marked from its body", async () => {
  // The marker was read off the call's arguments, which answers for every call
  // that has some and for none that has none: `console.log(five())` printed `5`
  // where the source prints `5n`, and the build was refused for a number it had
  // computed correctly. What says it is the callee's own return, so the body is
  // what is read — `return 5n` is a bigint whatever it was called with.
  const source = [
    "export function five(): u256 {",
    "  return 5n;",
    "}",
    "export function plainFive(): u256 {",
    "  return 5;",
    "}",
    "console.log(five());",
    "console.log(plainFive());",
    // Bound first, because the mark that was lost died at the binding.
    "const a = five();",
    "console.log(a);",
    "",
  ].join("\n");
  await agreesWithNode(source);
});

test("a wide number a declared function hands back is marked from its body", async () => {
  // The same read through the other path: a function declared in the program
  // body rather than imported. Both settle from a body, and one working while
  // the other did not would be a mark that follows the spelling of the callee.
  const source = [
    "function five(): u256 {",
    "  return 5n;",
    "}",
    "function plainFive(): u256 {",
    "  return 5;",
    "}",
    "console.log(five());",
    "console.log(plainFive());",
    "",
  ].join("\n");
  await agreesWithNode(source);
});


test("a fill of a window over a shared block is lowered by the machine backend", async () => {
  // The shape the spectral norm benchmark is: one block laid out, three windows
  // over it, a fill of the first one, and functions of the program that read
  // each other's windows over calls. The machine backend lowered none of this
  // while it had no answer for a fill or a window — every function of it fell
  // back to the C driver, and a program of one backend beside another failed to
  // link at the callee the object called but the driver had written `static`.
  // So this is checked against node with every function of it asked of the
  // machine backend, and with nothing of it left in the driver.
  const source = [
    "const bytesPerFloat = Float64Array.BYTES_PER_ELEMENT;",
    "",
    "function mainThread(n: number) {",
    "  const sab = new SharedArrayBuffer(3 * bytesPerFloat * n);",
    "  const u = new Float64Array(sab, 0, n).fill(1);",
    "  const v = new Float64Array(sab, bytesPerFloat * n, n);",
    "  const w = new Float64Array(sab, 2 * bytesPerFloat * n, n);",
    "  for (let i = 0; i < 10; i++) {",
    "    atAu(u, v, w);",
    "    atAu(v, u, w);",
    "  }",
    "  let vBv = 0;",
    "  let vv = 0;",
    "  for (let i = 0; i < n; i++) {",
    "    vBv += u[i] * v[i];",
    "    vv += v[i] * v[i];",
    "  }",
    "  const result = Math.sqrt(vBv / vv);",
  "  console.log(result.toFixed(9));",
    "  function atAu(u: Float64Array, v: Float64Array, w: Float64Array) {",
    "    au(u, w);",
    "    atu(w, v);",
    "  }",
    "  function au(u: Float64Array, v: Float64Array) {",
    "    for (let i = 0; i < n; i++) {",
    "      let t = 0;",
    "      for (let j = 0; j < n; j++) {",
    "        t += u[j] / a(i, j);",
    "      }",
    "      v[i] = t;",
    "    }",
    "  }",
    "  function atu(u: Float64Array, v: Float64Array) {",
    "    for (let i = 0; i < n; i++) {",
    "      let t = 0;",
    "      for (let j = 0; j < n; j++) {",
    "        t += u[j] / a(j, i);",
    "      }",
    "      v[i] = t;",
    "    }",
    "  }",
    "  function a(i: number, j: number) {",
    "    return ((i + j) * (i + j + 1) >>> 1) + i + 1;",
    "  }",
    "}",
    "mainThread(3);",
    "",
  ].join("\n");
  const { binary, notes } = await deliveredByMachine(source, "danger");
  assert.equal(notes.filter((note) => /refused to lower/.test(note)).length, 0, notes.join("\n"));
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, "1.233644501\n");
});

test("a turn whose divisor is a triangular number the counter decides is counted", async () => {
  // The divisor of the spectral norm's inner turn is `a(i, j)`, a triangular
  // number of the sum of the two indices plus the outer one. As a function of
  // the counter with the other index fixed it is an arithmetic progression, so
  // the machine backend counts it: the product, the shift and the conversions
  // of the weight are one addition a turn. The value it answers is the value
  // the compute answered, and this is checked against the source's own run.
  const source = [
    "function a(i: number, j: number): number {",
    "  return ((i + j) * (i + j + 1) >>> 1) + i + 1;",
    "}",
    "function au(u: Float64Array, v: Float64Array, n: number): void {",
    "  for (let i = 0; i < n; i++) {",
    "    let t = 0;",
    "    for (let j = 0; j < n; j++) {",
    "      t += u[j] / a(i, j);",
    "    }",
    "    v[i] = t;",
    "  }",
    "}",
    "const n = 5;",
    "const u = new Float64Array([1, 1, 1, 1, 1]);",
    "const v = new Float64Array(n);",
    "au(u, v, n);",
    "console.log(v[0], v[2], v[4]);",
    "",
  ].join("\n");
  const { directory, binary, notes } = await deliveredByMachine(source, "danger");
  assert.equal(notes.filter((note) => /refused to lower/.test(note)).length, 0, notes.join("\n"));
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  const original = run("node", ["main.ts"], { cwd: directory, timeoutMs: 60_000 });
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(original.code, 0, original.stderr);
  assert.equal(delivered.stdout, original.stdout);
});

test("a call a body makes in its return is a boundary the two backends share", async () => {
  // The shape the http server benchmark is: a body the machine backend lowers
  // ends by handing back the call of a body that takes text, and that body is
  // one the backend refused (`Math.ceil` in it). The call was read only where
  // the walk of a body reached a return — the walk of the statements never saw
  // it — so the caller stayed an object while the callee the driver wrote down
  // stayed `static`, and the program did not link at the callee's name. A call
  // in a return is one of the program's calls: the caller of it is lowered the
  // same way the callee was.
  const source = [
    'const label = "";',
    "function refused(name) {",
    "  return Math.ceil(name.length / 2);",
    "}",
    "function lowerable(v) {",
    "  return refused(`v=${v}`);",
    "}",
    "console.log(label, lowerable(3));",
    "",
  ].join("\n");
  const { directory, binary, notes } = await deliveredByMachine(source, "danger");
  assert.ok(
    notes.some((note) => /refused to lower refused \(refused calls Math\.ceil/.test(note)),
    notes.join("\n"),
  );
  assert.ok(
    notes.some(
      (note) =>
        /left lowerable in the driver: a call it shares with refused hands over what only one convention carries/.test(
          note,
        ),
    ),
    notes.join("\n"),
  );
  const delivered = run(binary, [], { timeoutMs: 60_000 });
  const original = run("node", ["main.ts"], { cwd: directory, timeoutMs: 60_000 });
  assert.equal(original.code, 0, original.stderr);
  assert.equal(delivered.code, 0, delivered.stderr);
  assert.equal(delivered.stdout, original.stdout);
});

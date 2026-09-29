/**
 * The semantic IR: what a program is before a target is chosen.
 *
 * These tests are about the IR itself, not about what a backend writes of it:
 * that every value states its type, that a program survives a round trip
 * through the text a model may write it in, and that a program no backend may
 * lower is refused before a toolchain is asked for anything.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSemanticIr } from "../compiler.ts";
import { CompilerError } from "../core/errors.ts";
import {
  convertibleTo,
  hasCall,
  localNames,
  slotType,
  typeText,
  valueKind,
  type SemanticProgram,
  type SemanticType,
  type SemanticValue,
} from "../core/semantic-ir.ts";
import { resolveProgram } from "../semantics/ir-resolve.ts";
import { semanticIrProblems, validateSemanticProgram } from "../semantics/ir-validate.ts";
import { parseSemanticModule, parseSemanticProgram, printSemanticModule, printSemanticProgram } from "../semantics/ir-text.ts";
import { run } from "../core/process.ts";
import { generateProgramDriver } from "../toolchain/driver.ts";
import { RUNTIME_NAME, runtimeHeaderSource, runtimeSourceSource } from "../runtime/abi.ts";
import { generateProgramHostSource } from "../runtime/nim-program.ts";
import type { ProgramContract } from "../core/types.ts";
import { phaseOf } from "./phase.ts";

/** A program of one entry module and the library it calls, resolved to the IR. */
function resolved(files: Record<string, string>): { program: SemanticProgram; contract: ProgramContract } {
  const phase = phaseOf("typescript", files, "main.ts");
  return { program: resolveProgram(phase.body!, phase.program), contract: phase.program };
}

const NUMBER = { kind: "primitive", name: "f64" } as const;
const USIZE = { kind: "primitive", name: "usize" } as const;
const I64 = { kind: "primitive", name: "i64" } as const;

/**
 * The C driver of a program, compiled and linked into an executable, the way a
 * build does. An IR node that lowers to text no compiler takes is caught here
 * rather than by a text assertion that passes on nonsense.
 */
async function deliverDriver(program: SemanticProgram): Promise<{ binary: string; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "blaze-ir-driver-"));
  const header = join(directory, `${RUNTIME_NAME}.h`);
  const source = join(directory, `${RUNTIME_NAME}.c`);
  const driver = join(directory, "program.c");
  const binary = join(directory, "program");
  writeFileSync(header, runtimeHeaderSource(), "utf8");
  writeFileSync(source, runtimeSourceSource(), "utf8");
  writeFileSync(driver, generateProgramDriver(program), "utf8");
  const built = run("gcc", ["-std=c11", "-O2", "-o", binary, driver, source, "-lm"], { timeoutMs: 120_000 });
  assert.equal(built.code, 0, built.stderr);
  return { binary, directory };
}

test("a value is what it is, read off the type it states", () => {
  assert.equal(valueKind({ k: "local", type: NUMBER, name: "total" }), "number");
  assert.equal(valueKind({ k: "local", type: { kind: "text" }, name: "s" }), "text");
  assert.equal(valueKind({ k: "local", type: { kind: "primitive", name: "bool" }, name: "b" }), "boolean");
  assert.equal(valueKind({ k: "local", type: { kind: "ref", of: null }, name: "tree" }), "reference");
  // Nothing is nothing, whatever a use typed it as: there is no value to read.
  assert.equal(valueKind({ k: "nothing", type: NUMBER }), "null");
});

test("the fields of an object being built are values the walk reaches", () => {
  // A field is a value of its own: a name read in one and a call written into
  // one are what the body reads and makes. The walk did not descend into them,
  // so a rule built on it — the one that names a local read where it is not
  // declared, the one that refuses an arm deciding on a call — saw nothing
  // there and let IR that no compiler takes through to the backends.
  const read: SemanticValue = { k: "local", type: NUMBER, name: "typoName" };
  const object: SemanticValue = {
    k: "newObject",
    type: { kind: "ref", of: null },
    layout: "Point",
    fields: [{ name: "x", value: read }],
  };
  assert.deepEqual(localNames(read), ["typoName"]);
  assert.deepEqual(localNames(object), ["typoName"]);

  const call: SemanticValue = {
    k: "call",
    type: NUMBER,
    call: {
      callee: "expensive",
      args: [],
      signature: { symbol: "expensive", name: "expensive", params: [], returns: "f64" },
      argTypes: [],
      returns: NUMBER,
      effects: [],
      ownership: "owned",
      retain: false,
      builtin: false,
    },
  };
  const inField: SemanticValue = {
    k: "newObject",
    type: { kind: "ref", of: null },
    layout: "Point",
    fields: [{ name: "x", value: call }],
  };
  assert.equal(hasCall(call), true);
  assert.equal(hasCall(inField), true);
});

test("a use converts inside a kind and never across kinds", () => {
  assert.equal(convertibleTo(I64, NUMBER), true);
  assert.equal(convertibleTo({ kind: "text" }, { kind: "text" }), true);
  assert.equal(convertibleTo({ kind: "ref", of: null }, { kind: "ptr", of: { kind: "void" } }), true);
  // A truth is not a number, and a number is not a truth, however one is printed.
  assert.equal(convertibleTo({ kind: "primitive", name: "bool" }, NUMBER), false);
  assert.equal(convertibleTo(NUMBER, { kind: "text" }), false);
  // An array of one element type is not a slice of another.
  assert.equal(convertibleTo({ kind: "array", of: NUMBER, length: 3 }, { kind: "slice", of: I64 }), true);
  assert.equal(
    convertibleTo({ kind: "array", of: NUMBER, length: 3 }, { kind: "slice", of: { kind: "primitive", name: "bool" } }),
    false,
  );
});

test("a value is walked whole, an array length among the values it is made of", () => {
  // A length names what it measures with `of`, and a walk that reads the wrong
  // field throws on every expression a program takes the length of.
  const expression: SemanticValue = {
    k: "arith",
    type: NUMBER,
    op: "add",
    left: { k: "length", type: USIZE, of: { k: "local", type: { kind: "array", of: NUMBER, length: 2 }, name: "a" } },
    right: { k: "const", type: NUMBER, text: "1" },
  };
  assert.deepEqual(localNames(expression), ["a"]);
  assert.equal(hasCall(expression), false);
  assert.equal(
    hasCall({
      k: "arith",
      type: NUMBER,
      op: "add",
      left: { k: "local", type: NUMBER, name: "x" },
      right: {
        k: "call",
        type: NUMBER,
        call: {
          callee: "f",
          signature: { name: "f", symbol: "f", params: [], returns: "f64" },
          args: [],
          argTypes: [],
          returns: NUMBER,
          effects: [],
          ownership: "none",
          retain: false,
          builtin: false,
        },
      },
    }),
    true,
  );
});

test("a value has a truth in every language, an array among them", () => {
  // An empty string is false, an absent reference is false, and an array is a
  // pointer, so `if (a)` is a test of the pointer rather than a refusal.
  const { program, contract } = resolved({
    "main.ts": ["const a = new Float64Array([1, 2]);", "console.log(a ? 1 : 0);", ""].join("\n"),
  });
  assert.deepEqual(semanticIrProblems(program, contract), []);
});

test("a program of every shape is a program the compiler may lower", () => {
  const { program, contract } = resolved({
    "main.ts": [
      'import { sum } from "./sum.ts";',
      "const data = new Float64Array([1, 2, 3]);",
      "let total = 0;",
      "for (let i = 0; i < data.length; i += 1) {",
      "  if (i % 2 === 0) {",
      "    continue;",
      "  }",
      "  total += data[i];",
      "}",
      "let n = 0;",
      "while (n < 2) {",
      "  n += 1;",
      "  if (n === 2) { break; }",
      "}",
      "do { n -= 1; } while (n > 0);",
      "for (const value of data) { total += value; }",
      "{",
      "  const inner = new Float64Array([1]);",
      "  total += inner[0];",
      "}",
      "const result = sum(total, n);",
      'console.log(`total ${result} ${total > 0 ? "big" : "small"}`);',
      "console.log(Math.max(1, 2), 1 << 4, ~5);",
      "",
    ].join("\n"),
    "sum.ts": "export function sum(a: number, b: number): number {\n  return a + b;\n}\n",
  });

  assert.deepEqual(semanticIrProblems(program, contract), []);
});

test("a program round trips through the text a model may write it in", () => {
  const { program, contract } = resolved({
    "main.ts": [
      'import { sum } from "./sum.ts";',
      "const data = new Float64Array([1, 2, 3]);",
      "let total = 0;",
      "for (let i = 0; i < data.length; i += 1) {",
      "  if (i % 2 === 0) { continue; }",
      "  total += data[i];",
      "}",
      "console.log(sum(total, data.length));",
      "",
    ].join("\n"),
    "sum.ts": "export function sum(a: number, b: number): number {\n  return a + b;\n}\n",
  });

  const printed = printSemanticProgram(program);
  const read = parseSemanticProgram(printed, contract);
  assert.equal(printSemanticProgram(read), printed);
  // What the text carries is the whole program, so what it reads back is the
  // same program: a call is still made against the contract it was made against.
  assert.deepEqual(read.entry.statements, program.entry.statements);
  assert.deepEqual(read.entry.releases, program.entry.releases);
});

test("a function round trips through the text a model may write it in", async () => {
  const example = new URL("../../examples/binarytrees/blaze.toml", import.meta.url).pathname;
  const printed = await runSemanticIr(example, { all: true });
  // Reading a module back binds every signature, effect, call and layout to
  // the contract, so what comes back is the same module or an error.
  const phase = phaseOf(
    "typescript",
    { "1.ts": readFileSync(new URL("../../examples/binarytrees/1.ts", import.meta.url).pathname, "utf8") },
    "1.ts",
  );
  const read = parseSemanticModule(printed, phase.program);
  assert.equal(printSemanticModule(read), printed);
  assert.deepEqual(
    read.functions.map((fn) => fn.symbol),
    ["blaze_main", "checksum", "createTree"],
  );
});

test("a reference with no layout is a type the text form writes and reads back", () => {
  // `ref<any>` is how a reference whose layout nothing types is written, and a
  // printer that wrote a bare `ref` would print IR the parser cannot read.
  const { program, contract } = resolved({ "main.ts": ["let n = null;", "console.log(n === null);", ""].join("\n") });
  const printed = printSemanticProgram(program);
  assert.match(printed, /ref<any>/);
  assert.equal(printSemanticProgram(parseSemanticProgram(printed, contract)), printed);
});

test("a line the IR cannot express is refused, naming the line", () => {
  const { contract } = resolved({ "main.ts": "console.log(1);\n" });
  const refused = (text: string): string => {
    try {
      parseSemanticProgram(text, contract);
    } catch (error) {
      assert.ok(error instanceof CompilerError);
      return `${error.message}\n${error.detail ?? ""}`;
    }
    throw new assert.AssertionError({ message: "expected the IR text to be refused" });
  };

  assert.match(refused("ir 1\nfile \"main.ts\"\nlet = 1\n"), /line 3/);
  assert.match(refused("ir 1\nfile \"main.ts\"\ncall[f64] nothing() ownership=none retain=no\n"), /line 3/);
});

test("a jump that leaves for a block no loop names is refused", () => {
  const { program, contract } = resolved({
    "main.ts": ["while (true) {", "  const inner = new Float64Array([1]);", "  if (inner[0] > 0) { break; }", "}", ""].join("\n"),
  });
  const loop = program.entry.statements.find((statement) => statement.k === "loop");
  assert.ok(loop !== undefined, "expected a loop");
  if (loop.k !== "loop") throw new Error("expected a loop");
  // The arm that breaks jumps for the block the loop sits in, after freeing
  // what the blocks it leaves owned.
  const arm = loop.loop.body.statements.find((statement) => statement.k === "if");
  if (arm === undefined || arm.k !== "if" || arm.then.terminator.k !== "jump") throw new Error("expected a break");
  assert.equal(arm.then.terminator.target, loop.loop.exit);
  assert.deepEqual(arm.then.terminator.releases, ["inner"]);
  assert.deepEqual(semanticIrProblems(program, contract), []);

  // A jump that names a block no loop around it is a jump into nowhere, which
  // is a program no backend may lower.
  const astray = structuredClone(program);
  const found = astray.entry.statements.find((statement) => statement.k === "loop");
  if (found === undefined || found.k !== "loop") throw new Error("expected a loop");
  const armOf = found.loop.body.statements.find((statement) => statement.k === "if");
  if (armOf === undefined || armOf.k !== "if" || armOf.then.terminator.k !== "jump") throw new Error("expected a jump");
  armOf.then.terminator.target = "b99";
  assert.match(semanticIrProblems(astray, contract).join("\n"), /b99/);
});

test("an allocation is freed once, and only on the path that leaves it", () => {
  const { program, contract } = resolved({
    "main.ts": [
      "for (let i = 0; i < 3; i += 1) {",
      "  const inner = new Float64Array([i]);",
      "  console.log(inner[0]);",
      "}",
      "",
    ].join("\n"),
  });
  assert.deepEqual(semanticIrProblems(program, contract), []);

  // The body is freed when the run goes round again, so the name is released
  // exactly once on every path out of the block.
  const body = program.entry.statements[0];
  if (body.k !== "loop") throw new Error("expected a loop");
  assert.deepEqual(body.loop.body.releases, ["inner"]);
  assert.equal(body.loop.body.terminator.k, "next");

  // A body that jumps frees what it owns on the way out instead of falling out
  // of the block, and the two are the same names rather than two sets of them.
  const leaving = resolved({
    "main.ts": [
      "for (let i = 0; i < 3; i += 1) {",
      "  const inner = new Float64Array([i]);",
      "  continue;",
      "}",
      "",
    ].join("\n"),
  });
  const jumped = leaving.program.entry.statements[0];
  if (jumped.k !== "loop") throw new Error("expected a loop");
  assert.equal(jumped.loop.body.terminator.k, "jump");
  if (jumped.loop.body.terminator.k !== "jump") throw new Error("expected a jump");
  assert.deepEqual(jumped.loop.body.terminator.releases, ["inner"]);
  assert.deepEqual(semanticIrProblems(leaving.program, leaving.contract), []);
  // A name freed on the way out of a block is freed once: the C that comes of it
  // releases it once, and a second release would take the runtime down.
  const released = generateProgramDriver(leaving.program).match(/blaze_rt_release\(inner\)/g) ?? [];
  assert.equal(released.length, 1);
});

test("what a block owns is freed last in first out", () => {
  const { program, contract } = resolved({
    "main.ts": [
      "{",
      "  const a = new Float64Array([1]);",
      "  const b = new Float64Array([2]);",
      "  console.log(a[0] + b[0]);",
      "}",
      "",
    ].join("\n"),
  });
  const block = program.entry.statements[0];
  if (block.k !== "block") throw new Error("expected a block");
  assert.deepEqual(block.body.releases, ["b", "a"]);
  assert.deepEqual(semanticIrProblems(program, contract), []);
});

test("an arm a backend writes twice may not carry a call", () => {
  // `&&` and `??` decide on their left arm, and a backend writes that arm as
  // the test and again as the value that answers, so a call in it is a call
  // written twice. The resolver hoists such an arm into a name; IR written by
  // hand or by a model has to be held to the same rule, or the backend runs it
  // twice and the program is not the one that was written.
  const { contract } = resolved({
    "main.ts": 'import { next } from "./sum.ts";\nconsole.log(next(1));\n',
    "sum.ts": "export function next(n: number): number {\n  return n + 1;\n}\n",
  });
  const twice = parseSemanticProgram(
    [
      "ir 1",
      'file "main.ts"',
      "function next(n: f64) -> f64",
      "",
      "block entry: releases[]",
      "  print_number [logical_and[f64] [call[f64] next [arg[f64] const[f64] 1] ownership=none retain=no] const[f64] 2] @1",
      "  print_newline @1",
      "return",
      "",
    ].join("\n"),
    contract,
  );
  assert.match(semanticIrProblems(twice, contract).join("\n"), /logical decides on an arm that calls next/);
});

test("a name a target would have to escape is not a name the IR holds", () => {
  const { program, contract } = resolved({ "main.ts": "let total = 0;\nconsole.log(total);\n" });
  assert.deepEqual(semanticIrProblems(program, contract), []);

  const named = structuredClone(program);
  const declared = named.entry.statements[0];
  if (declared.k !== "let") throw new Error("expected a declaration");
  declared.slot.name = "%rax";
  assert.match(semanticIrProblems(named, contract).join("\n"), /%rax/);
});

test("a program that is not one is refused before a target is asked for anything", () => {
  const { program, contract } = resolved({ "main.ts": "let total = 0;\nconsole.log(total);\n" });
  validateSemanticProgram(program, contract);

  const broken = structuredClone(program);
  const read = broken.entry.statements[1];
  if (read.k !== "printNumber") throw new Error("expected a print");
  read.value = { k: "local", type: NUMBER, name: "neverDeclared" };
  const refused = (() => {
    try {
      validateSemanticProgram(broken, contract);
    } catch (error) {
      assert.ok(error instanceof CompilerError);
      assert.equal(error.category, "SemanticIrError");
      assert.equal(error.stage, "ir");
      return `${error.message}\n${error.detail ?? ""}`;
    }
    throw new assert.AssertionError({ message: "expected the program to be refused" });
  })();
  assert.match(refused, /neverDeclared/);
});

test("the objects and the errors the IR states are what the runtime is asked for", async () => {
  // A field read, a field write, an object, a retain and a raise are IR
  // operations, and both backends write them as the runtime's own services: a
  // program that states one is a program a backend may lower, not one it
  // refuses after it has been validated. The program is written as IR, printed,
  // and read back, so the text form carries them too.
  const reference: SemanticType = { kind: "ref", of: null, name: "Object1" };
  const node: SemanticValue = { k: "local", type: reference, name: "node" };
  const program: SemanticProgram = {
    file: "main.ts",
    functions: [],
    objects: {
      Object1: { name: "Object1", size: 8, align: 8, fields: [{ name: "value", type: "f64", offset: 0 }] },
    },
    entry: {
      id: "entry",
      releases: ["node"],
      terminator: { k: "return", value: null },
      statements: [
        {
          k: "let",
          slot: { kind: "object", name: "node", mutable: true, type: reference },
          value: { k: "newObject", type: reference, layout: "Object1", fields: [] },
          line: 1,
        },
        { k: "storeField", object: node, layout: "Object1", field: "value", value: { k: "const", type: NUMBER, text: "7" }, line: 2 },
        { k: "retain", value: node, line: 3 },
        { k: "printNumber", value: { k: "loadField", type: NUMBER, object: node, layout: "Object1", field: "value" }, line: 4 },
        { k: "printNewline", line: 4 },
        { k: "raise", message: { k: "text", type: { kind: "text" }, parts: [{ k: "text", value: "boom" }] }, line: 5 },
      ],
    },
  };

  validateSemanticProgram(program);

  const c = generateProgramDriver(program);
  assert.match(c, /\(\(struct Object1\*\)node\)->value = 7\.0;/);
  assert.match(c, /\(\(struct Object1\*\)node\)->value\)/);
  assert.match(c, /blaze_rt_retain\(node\);/);
  assert.match(c, /blaze_rt_raise\("boom"\);/);
  const nim = generateProgramHostSource(program);
  assert.match(nim, /\(cast\[Object1\]\(node\)\)\.value = 7\.0/);
  assert.match(nim, /blaze_rt_retain/);
  assert.match(nim, /blaze_rt_raise\("boom"\)/);

  // An object is one value, and C has no way to spell a value out of several
  // statements without a statement expression. The text matching above would
  // pass on a line no compiler takes, so the driver is compiled and run here:
  // what an object literal lowers to has to be a program.
  const built: SemanticProgram = {
    ...program,
    entry: {
      id: "entry",
      releases: [],
      terminator: { k: "return", value: null },
      statements: [
        {
          k: "let",
          slot: { kind: "object", name: "node", mutable: true, type: reference },
          value: {
            k: "newObject",
            type: reference,
            layout: "Object1",
            fields: [{ name: "value", value: { k: "const", type: NUMBER, text: "7" } }],
          },
          line: 1,
        },
        {
          k: "printNumber",
          value: { k: "loadField", type: NUMBER, object: node, layout: "Object1", field: "value" },
          line: 2,
        },
        { k: "printNewline", line: 2 },
      ],
    },
  };
  validateSemanticProgram(built);
  const { binary, directory } = await deliverDriver(built);
  const ran = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(ran.code, 0, ran.stderr);
  assert.equal(ran.stdout, "7\n");
  assert.ok(directory !== "");
});

test("an object built in the arm of a conditional is built when that arm is taken", async () => {
  // `depth-- > 0 ? {left: createTree(depth), ...} : {left: null, right: null}`
  // calls createTree once. An IR that hoisted either object out of its arm
  // would build both, and the program the model reads would not be the program
  // the source writes.
  const example = new URL("../../examples/binarytrees/blaze.toml", import.meta.url).pathname;
  const printed = await runSemanticIr(example, { function: "createTree" });

  const calls = (printed.match(/createTree \[arg/g) ?? []).length;
  const objects = (printed.match(/new_object/g) ?? []).length;
  // The body says: compare, then choose one of two objects, and each object
  // holds two fields.
  assert.equal(calls, 2, "each arm builds one object, so each names the call once");
  assert.equal(objects, 2, "one object per arm, and neither is hoisted out of it");
  assert.doesNotMatch(printed, /store_field/);
  // The arms are inside the selection, which is what keeps them lazy.
  assert.match(printed, /return \[select\[/);
  assert.match(printed, /new_object\[ref<Object1>\] Object1 left .* right /);
});

test("a function is described whole, and reads back as itself", async () => {
  // A function is not a body: the IR carries what it is called by, what it is
  // held to, what it does beyond computing its result, and its body. Every
  // function of a real project, printed and parsed, has to come back the same.
  const example = new URL("../../examples/binarytrees/blaze.toml", import.meta.url).pathname;
  const printed = await runSemanticIr(example, { all: true });
  assert.match(printed, /^function checksum\(node: ref<any>\) -> f64$/m);
  assert.match(printed, /^ {2}allocates no$/m);
  assert.match(printed, /^ {2}effects io syscall$/m);
  assert.match(printed, /^ {2}param value\[f64\] depth mutable$/m);
  // The body is the function's: a field read, a recursive call, a return.
  assert.match(printed, /return \[add\[f64\]/);
  assert.match(printed, /load_field\[ref<any>\]/);

  // A function whose contract states a result carries that result and a body
  // both: the postcondition is what the result is held to, and the body is
  // what the compiler resolved and would lower.
  const library = new URL("../../examples/hello_world/blaze.toml", import.meta.url).pathname;
  const said = await runSemanticIr(library, { function: "dotProduct" });
  assert.match(said, /ensures /);
  assert.match(said, /^ {2}block entry: releases\[\]$/m);
});

test("the IR of a project is what the compiler resolved, and reads back as itself", async () => {
  const example = new URL("../../examples/hello_world/blaze.toml", import.meta.url).pathname;
  const printed = await runSemanticIr(example, {});
  // What is printed is a program the compiler may lower, which is the whole
  // point of printing it: a person reads the same program a backend lowers.
  assert.match(printed, /^ir 1$/m);
  assert.match(printed, /function dotProduct\(a: slice<f64>, b: slice<f64>, n: f64\) -> f64/);
  assert.match(printed, /call\[f64\] dotProduct/);
  assert.match(printed, /^return$/m);

  // Written out and read back, it is the program it was, and it still validates.
  const directory = await mkdtemp(join(tmpdir(), "blaze-ir-"));
  const path = join(directory, "program.ir");
  writeFileSync(path, printed, "utf8");
  const again = await runSemanticIr(example, { from: path });
  assert.equal(again, printed);
  assert.equal(readFileSync(path, "utf8"), printed);
});

test("the type of a program is the type its names read as", () => {
  const { program } = resolved({ "main.ts": "const data = new Float64Array([1, 2]);\nconsole.log(data.length);\n" });
  const declared = program.entry.statements[0];
  if (declared.k !== "let") throw new Error("expected a declaration");
  assert.equal(typeText(slotType(declared.slot)), "[f64; 2]");
  assert.equal(declared.slot.kind, "buffer");
});

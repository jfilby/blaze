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

import { join } from "node:path";
import { runSemanticIr } from "../compiler.ts";
import { CompilerError } from "../core/errors.ts";
import {
  convertibleTo,
  isSemanticType,
  hasCall,
  localNames,
  slotType,
  typeText,
  valueKind,
  wholeOf,
  type SemanticFunction,
  type SemanticProgram,
  type SemanticType,
  type SemanticValue,
} from "../core/semantic-ir.ts";
import { resolveProgram } from "../semantics/ir-resolve.ts";
import { resolveFunction } from "../semantics/ir-function.ts";
import { semanticFunctionProblems, semanticIrProblems, validateSemanticProgram } from "../semantics/ir-validate.ts";
import { parseType } from "../semantics/contract.ts";
import { generateFunctionC } from "../toolchain/ir-c.ts";
import { markParallelLoops } from "../semantics/parallel.ts";
import {
  parseSemanticFunction,
  parseSemanticModule,
  parseSemanticProgram,
  printSemanticFunction,
  printSemanticModule,
  printSemanticProgram,
} from "../semantics/ir-text.ts";
import { run } from "../core/process.ts";
import { generateProgramDriver } from "../toolchain/driver.ts";
import { RUNTIME_NAME, runtimeHeaderSource, runtimeSourceSource } from "../runtime/abi.ts";
import { generateProgramHostSource } from "../runtime/nim-program.ts";
import type { ProgramContract } from "../core/types.ts";
import { phaseOf, programOf, semanticsOf } from "./phase.ts";
import { scratch } from "./scratch.ts";

/** A program of one entry module and the library it calls, resolved to the IR. */
function resolved(files: Record<string, string>): { program: SemanticProgram; contract: ProgramContract } {
  const phase = phaseOf("typescript", files, "main.ts");
  return { program: resolveProgram(phase.body!, phase.program, phase.objectNames, phase.objectLayouts, phase.objectKeys), contract: phase.program };
}

const NUMBER = { kind: "primitive", name: "f64" } as const;
const USIZE = { kind: "primitive", name: "usize" } as const;
const I64 = { kind: "primitive", name: "i64" } as const;

/** The IR the compiler resolves for one function of a source. */
function irOf(files: Record<string, string>, name: string): string {
  const phase = phaseOf("typescript", files, "main.ts");
  const contracts = phase.program.files.flatMap((file) => Object.entries(file.functions));
  const context = { objectNames: phase.objectNames, functions: Object.fromEntries(contracts) };
  const contract = contracts.find(([, one]) => one.function.name === name);
  assert.ok(contract !== undefined, `${name} is a function of the program`);
  return printSemanticFunction(resolveFunction(contract[1], context));
}

test("a counter the body reaches only as an index is a whole number", () => {
  // The width of a counter reaches the arithmetic of the body wherever the body
  // reads it as a value, and an index is not a value: it is the place in an
  // array the body reaches, and the number of that place is a whole number
  // whatever the counter is counted in. A loop that counts the elements of an
  // array and indexes with the counter is therefore a body the counter's width
  // does not reach, and it may count in whole numbers however the arithmetic
  // around it is written.
  const indexed = irOf(
    {
      "main.ts": [
        "export function total(values: Float64Array, count: number): number {",
        "  let sum = 0;",
        "  for (let i = 0; i < count; i++) { sum += values[i] * 0.25; }",
        "  return sum;",
        "}",
        "",
      ].join("\n"),
    },
    "total",
  );
  assert.match(indexed, /for\[i64\] i/, "the counter of a loop that indexes with it is a whole number");
  assert.match(indexed, /element\[f64\] local\[\[\]f64\] values local\[i64\] i/, "the index is the whole counter");

  // A body that reads the counter as a value is left alone: there the counter's
  // width reaches the arithmetic, and a whole number in that arithmetic is a
  // number the source never wrote.
  const read = irOf(
    {
      "main.ts": [
        "export function total(count: number): number {",
        "  let sum = 0;",
        "  for (let i = 0; i < count; i++) { sum += i * 0.25; }",
        "  return sum;",
        "}",
        "",
      ].join("\n"),
    },
    "total",
  );
  assert.match(read, /for\[f64\] i/, "a counter the body reads as a value is a double");
});

/**
 * The C driver of a program, compiled and linked into an executable, the way a
 * build does. An IR node that lowers to text no compiler takes is caught here
 * rather than by a text assertion that passes on nonsense.
 */
async function deliverDriver(program: SemanticProgram): Promise<{ binary: string; directory: string }> {
  const directory = await scratch("blaze-ir-driver-");
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

test("the index an argument is read at is a value the walk reaches", () => {
  // `process.argv[i]` carries the expression that computes the index, and a
  // call written in it is a call the value makes. The walk had no case for it,
  // so `hasCall` answered "no call here" for a value whose whole body is one:
  // the rule that refuses an arm deciding on a call was disarmed, and the
  // backend wrote the call under the test and again under the value.
  const call: SemanticValue = {
    k: "call",
    type: NUMBER,
    call: {
      callee: "which",
      args: [],
      signature: { symbol: "which", name: "which", params: [], returns: "f64" },
      argTypes: [],
      returns: NUMBER,
      effects: [],
      ownership: "none",
      retain: false,
      builtin: false,
    },
  };
  const byName: SemanticValue = { k: "argv", type: NUMBER, index: { k: "local", type: USIZE, name: "i" } };
  const byCall: SemanticValue = { k: "argv", type: NUMBER, index: call };
  assert.deepEqual(localNames(byName), ["i"]);
  // Reading an argument of the program asks the runtime for it, so the value is
  // a call whatever the index is: a backend that keeps a value beside it in a
  // register has to account for the call, and there is one either way.
  assert.equal(hasCall(byName), true);
  assert.equal(hasCall(byCall), true);

  // The rule the walk exists for: an arm written under a test and again as the
  // value that answers runs a call in it twice.
  const fn: SemanticFunction = {
    name: "first",
    symbol: "first",
    params: [],
    returns: NUMBER,
    requires: [],
    ensures: [],
    effects: [],
    allocates: false,
    prints: false,
    readsArgv: true,
    objects: {},
    calls: [],
    entry: {
      id: "entry",
      releases: [],
      statements: [],
      terminator: {
        k: "return",
        value: { k: "logical", type: NUMBER, op: "or", left: byCall, right: { k: "const", type: NUMBER, text: "5" } },
      },
    },
  };
  assert.deepEqual(semanticFunctionProblems(fn), [
    "first: entry: logical decides on an arm that calls a function, which is written twice",
  ]);
});

test("a name read narrower than the slot it names is refused", () => {
  // The IR states the type every value is read as, and a backend takes that as
  // the width to read it at. `print_number local[i32] n` over an `f64` slot
  // lowers to `printf("%lld", (long long)(n))` and answers 1 where the program
  // holds 1.75 — and the width was decided here, so nothing downstream can
  // recover the number it lost.
  const fn: SemanticFunction = {
    name: "widened",
    symbol: "widened",
    params: [],
    returns: { kind: "void" },
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
        { k: "let", line: 1, slot: { kind: "value", name: "n", mutable: true, type: NUMBER }, value: { k: "const", type: NUMBER, text: "1.75" } },
        { k: "printNumber", line: 2, value: { k: "local", type: I64, name: "n" }, bigint: false },
      ],
      terminator: { k: "return", value: null },
    },
  };
  assert.deepEqual(semanticFunctionProblems(fn), ['widened: entry: line 2: "n" holds a f64 and is read as a i64, which cannot hold it']);
});

test("a buffer is read as itself whatever length it is written at", () => {
  // The same pointer under two spellings, so this is not a mismatch: a slot
  // whose length the program settled on is read as a slice of its elements, and
  // refusing that would refuse every array a program hands to a function.
  const fn: SemanticFunction = {
    name: "reader",
    symbol: "reader",
    params: [{ kind: "value", name: "values", mutable: false, type: { kind: "array", of: NUMBER, length: 4 } }],
    returns: { kind: "primitive", name: "f64" },
    requires: [],
    ensures: [],
    effects: [],
    allocates: false,
    prints: false,
    readsArgv: false,
    objects: {},
    calls: [],
    entry: {
      id: "entry",
      releases: [],
      statements: [
        {
          k: "printNumber",
          line: 1,
          bigint: false,
          value: {
            k: "element",
            type: NUMBER,
            of: { k: "local", type: { kind: "slice", of: NUMBER }, name: "values" },
            index: { k: "const", type: { kind: "primitive", name: "usize" }, text: "0" },
          },
        },
      ],
      terminator: { k: "return", value: { k: "const", type: NUMBER, text: "0" } },
    },
  };
  assert.deepEqual(semanticFunctionProblems(fn), []);
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

test("a reference is read back as the type it points at, under the field it carries it in", () => {
  // A reference carries the type it points at under `of` and the name of the
  // object under `name`. The reader took `of` for the name, so a `ref<f64>` —
  // what `semantics/contract.ts` parses and what this IR's own text writes —
  // was not a type, and a reference whose name was a number was one.
  assert.equal(isSemanticType(parseType("ref<f64>")), true);
  assert.equal(isSemanticType({ kind: "ref", of: { kind: "primitive", name: "f64" } }), true);
  assert.equal(isSemanticType({ kind: "ref", of: null }), true);
  assert.equal(isSemanticType({ kind: "ref", of: null, name: "Point" }), true);
  assert.equal(isSemanticType({ kind: "ref", of: { kind: "primitive", name: "nope" } }), false);
  assert.equal(isSemanticType({ kind: "ref", of: null, name: 42 }), false);
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
  // A length is asked of something rather than read out of the value itself,
  // and on a target that has no instruction for it that question is a call, so
  // a value that holds one is not one a backend may leave in a register.
  assert.equal(hasCall(expression), true);
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

test("a function the program declares is read back whole, body and all", () => {
  // A function of a program is a body the IR holds, not a signature: the text
  // carries it whole so that a review of the program is shown what it does, and
  // what it reads back is the same function. Its calls are bound to the
  // signatures the program itself declares, because there is no contract of
  // theirs to bind them to.
  const { program, contract } = resolved({
    "main.ts": [
      "const n = 3;",
      "function total(values: Float64Array): number {",
      "  let sum = 0;",
      "  for (let i = 0; i < n; i++) sum += values[i];",
      "  return sum;",
      "}",
      "const a = new Float64Array(n);",
      "console.log(total(a));",
      "",
    ].join("\n"),
  });
  const printed = printSemanticProgram(program);
  const read = parseSemanticProgram(printed, contract);
  assert.equal(printSemanticProgram(read), printed);
  assert.deepEqual(
    read.bodies.map((fn) => fn.name),
    ["total"],
  );
  // The body reads the names it is given, and the call passes the one it reads
  // of the scope around it.
  const [total] = read.bodies;
  assert.deepEqual(total.params.map((param) => param.name), ["values", "n"]);
  assert.deepEqual(read.entry.statements, program.entry.statements);
});

test("a function round trips through the text a model may write it in", async () => {
  const example = new URL("../../benchmarks/c_backend/binarytrees/blaze.toml", import.meta.url).pathname;
  const printed = await runSemanticIr(example, { all: true });
  // Reading a module back binds every signature, effect, call and layout to
  // the contract, so what comes back is the same module or an error.
  const phase = phaseOf(
    "typescript",
    { "1.ts": readFileSync(new URL("../../benchmarks/c_backend/binarytrees/1.ts", import.meta.url).pathname, "utf8") },
    "1.ts",
  );
  const read = parseSemanticModule(printed, phase.program);
  assert.equal(printSemanticModule(read), printed);
  assert.deepEqual(
    read.functions.map((fn) => fn.symbol),
    ["blaze_main", "checksum", "createTree"],
  );
});

test("a short circuit over two texts is a type the text form writes and reads back", () => {
  // `a && b` hands back one of its arms, so the IR states the type of them,
  // and two strings make a string. The contract type language has no string
  // type, so a printer that wrote it and a parser that read it back through
  // the contract types could not agree: the function was written, reviewed
  // and then refused on the way back in, which is the one path every revised
  // IR takes.
  for (const op of ["&&", "||"]) {
    const source = [
      "export function f(n: number): number {",
      "  if (n <= 0) { return 0; }",
      "  let a = `x`;",
      "  let b = `y`;",
      `  const v = a ${op} b;`,
      "  return v.length;",
      "}",
      "",
    ].join("\n");
    const files = { "main.ts": 'import { f } from "./lib.ts";\nconsole.log(f(1));\n', "lib.ts": source };
    const phase = phaseOf("typescript", files, "main.ts");
    const printed = printSemanticFunction(semanticsOf(phase).f as SemanticFunction);
    assert.match(printed, /logical_(?:and|or)\[text\]/, `\`${op}\` over two texts is written as a text`);
    assert.equal(
      printSemanticFunction(parseSemanticFunction(printed, phase.program)),
      printed,
      `what \`${op}\` prints, the text form reads back`,
    );
  }
});

test("a reference with no layout is a type the text form writes and reads back", () => {
  // `ref<any>` is how a reference whose layout nothing types is written, and a
  // printer that wrote a bare `ref` would print IR the parser cannot read.
  const { program, contract } = resolved({ "main.ts": ["let n = null;", "console.log(n === null);", ""].join("\n") });
  const printed = printSemanticProgram(program);
  assert.match(printed, /ref<any>/);
  assert.equal(printSemanticProgram(parseSemanticProgram(printed, contract)), printed);
});

test("a fixed-length array is a type the text form writes and reads back", () => {
  // `semantics/contract.ts` writes a count inside angle brackets — the
  // signature lines and the object layouts of a program are written that way —
  // and the reader stopped at the count, so a function with a fixed-length
  // array was written, reviewed, and then refused on the way back in. Both
  // spellings are the same type and both are read.
  const source = [
    "proc total(values: array[3, float64]): float64 =",
    "  var sum = 0.0",
    "  for i in 0 ..< 3:",
    "    sum += values[i]",
    "  result = sum",
    "",
  ].join("\n");
  const files = { "module.nim": `${source}main();\n` };
  const phase = phaseOf("nim", files, "module.nim");
  const printed = printSemanticFunction(semanticsOf(phase).total as SemanticFunction);
  assert.match(printed, /values: \[f64; 3\]/);
  assert.equal(printSemanticFunction(parseSemanticFunction(printed, phase.program)), printed);
  // The angle-bracketed spelling the contract writes is the same function.
  const written = printed.replace("[f64; 3]", "array<f64,3>");
  assert.equal(printSemanticFunction(parseSemanticFunction(written, phase.program)), printed);
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

test("a value a statement writes is a value the validator reads", () => {
  // The list of what a statement computes is what every rule below is fed, so
  // a value this omits is a value none of them reads. `fill` writes one and
  // `call` writes its arguments, and neither was listed: a fill carrying a call
  // written with the wrong number of arguments, and a call written into the
  // argument of a call statement, were programs the validator answered nothing
  // about.
  const { program, contract } = resolved({
    "main.ts": ["const a = new Int32Array(4);", "a[0] = 1;", ""].join("\n"),
  });
  const written = program.entry.statements.find((statement) => statement.k === "setElement");
  assert.ok(written !== undefined && written.k === "setElement", "the program writes an element");
  const value = structuredClone(written.value);

  // A fill naming a buffer nothing declares writes nothing the compiler knows.
  const filled = structuredClone(program);
  const declared = filled.entry.statements[0];
  if (declared.k !== "let") throw new Error("expected the buffer to be declared first");
  filled.entry.statements = [
    declared,
    { k: "fill", buffer: "ghost", index: "0", type: value.type, value, line: 2 },
  ];
  assert.match(
    semanticIrProblems(filled, contract).join("\n"),
    /"ghost" is not declared/,
    "the buffer a fill names is a name it writes",
  );


  // A call written into the value a fill writes is a call the body makes, and
  // is held to the signature of the function it names.
  const { program: callingProgram, contract: callingContract } = resolved({
    "main.ts": 'import { twice } from "./lib.ts";\nconst a = new Int32Array(4);\na[0] = twice(1, 2);\n',
    "lib.ts": "export function twice(a: number, b: number): number {\n  return a + b;\n}\n",
  });
  const calling = structuredClone(callingProgram);
  const element = calling.entry.statements.find((statement) => statement.k === "setElement");
  assert.ok(element !== undefined && element.k === "setElement", "the program writes an element");
  const declaredCall = structuredClone(element.value);
  if (declaredCall.k !== "call") throw new Error("expected a call written into the element");
  declaredCall.call.args = declaredCall.call.args.slice(0, 1);
  calling.entry.statements = [
    ...calling.entry.statements.slice(0, -1),
    { k: "fill", buffer: "a", index: "0", type: declaredCall.type, value: declaredCall, line: 3 },
  ];
  assert.match(
    semanticIrProblems(calling, callingContract).join("\n"),
    /twice is called with 1 arguments and takes 2/,
    "a call written into a fill is held to the signature it names",
  );
});

test("a call written into an argument is a call the validator holds", () => {
  // A `call` statement was checked as a call and nothing else, so the arguments
  // it was made of reached no rule at all: a call written into one of them with
  // the wrong number of arguments passed validation, and the backend wrote a
  // call the signature does not describe.
  const { program, contract } = resolved({
    "main.ts": 'import { sum, take } from "./lib.ts";\nconsole.log(take(sum(1, 2)));\n',
    "lib.ts": [
      "export function sum(a: number, b: number): number {",
      "  return a + b;",
      "}",
      "export function take(x: number): number {",
      "  return x;",
      "}",
      "",
    ].join("\n"),
  });
  assert.deepEqual(semanticIrProblems(program, contract), []);

  const printed = program.entry.statements[0];
  if (printed.k !== "printNumber") throw new Error("expected a printed call");
  if (printed.value.k !== "call") throw new Error("expected a printed call");
  // The call the statement makes, with the call written into its argument
  // reduced to one argument where the program declares two.
  const outer = structuredClone(printed.value.call);
  const argument = outer.args[0];
  if (argument.k !== "call") throw new Error("expected a call written into the argument");
  argument.call.args = argument.call.args.slice(0, 1);

  const astray = structuredClone(program);
  astray.entry.statements = [{ k: "call", line: 2, call: outer }];
  assert.match(
    semanticIrProblems(astray, contract).join("\n"),
    /sum is called with 1 arguments and takes 2/,
    "a call written into the argument of a call statement is held to its signature",
  );
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

  // The same arm in what a block hands back. A block's terminator is not one
  // of its statements, so this was the one place the rule did not reach, and
  // for a function whose body is one expression it is the only place the value
  // lives: the C backend binds the arm to a temporary and runs the call once,
  // the WebAssembly one writes the arm twice and ran it twice.
  const returned = parseSemanticProgram(
    [
      "ir 1",
      'file "main.ts"',
      "function next(n: f64) -> f64",
      "",
      "block entry: releases[]",
      "return [logical_and[f64] [call[f64] next [arg[f64] const[f64] 1] ownership=none retain=no] const[f64] 2]",
      "",
    ].join("\n"),
    contract,
  );
  assert.match(semanticIrProblems(returned, contract).join("\n"), /logical decides on an arm that calls next/);
  // `??` is the one the WebAssembly backend really does write twice, and it
  // writes the left arm down whatever the value is a statement or a terminator.
  const coalesced = parseSemanticProgram(
    [
      "ir 1",
      'file "main.ts"',
      "function next(n: f64) -> f64",
      "",
      "block entry: releases[]",
      "return [coalesce[f64] [call[f64] next [arg[f64] const[f64] 1] ownership=none retain=no] const[f64] 2]",
      "",
    ].join("\n"),
    contract,
  );
  assert.match(semanticIrProblems(coalesced, contract).join("\n"), /coalesce decides on an arm that calls next/);
  // The arm with no call in it is written twice and is still one program.
  const pure = parseSemanticProgram(
    [
      "ir 1",
      'file "main.ts"',
      "function next(n: f64) -> f64",
      "",
      "block entry: releases[]",
      "return [logical_and[f64] local[f64] n const[f64] 2]",
      "",
    ].join("\n"),
    contract,
  );
  assert.deepEqual(semanticIrProblems(pure, contract), []);
});

test("a name is written with a value its own declared type takes", () => {
  // A step is an arithmetic move and a plain assignment writes what the name
  // already holds. Neither was compared against the slot, and neither backend
  // checks it: the C emitter casts the value to the declared type and the
  // WebAssembly one leaves the stack under it, so `p++` over a reference
  // lowered to pointer arithmetic and an assignment of the wrong type lowered
  // to a module the engine refuses. `setElement` holds itself to both rules.
  const { program, contract } = resolved({
    "main.ts": ["let node = null;", "let total = 0;", "total = 2;", "console.log(total);", ""].join("\n"),
  });
  assert.deepEqual(semanticIrProblems(program, contract), [], "what the source writes is what the IR writes");

  const stepped = structuredClone(program);
  const moved = stepped.entry.statements.find((one) => one.k === "let");
  if (moved?.k !== "let") throw new Error("expected the object declaration");
  const held = slotType(moved.slot);
  moved.value = { k: "nothing", type: held };
  stepped.entry.statements.push({ k: "step", name: moved.slot.name, op: "++", prefix: false, line: 1 });
  assert.match(
    semanticIrProblems(stepped, contract).join("\n"),
    /"node" is a ref<[^>]+>, which is not a number a step can move/,
  );

  const assigned = structuredClone(program);
  const into = assigned.entry.statements.find((one) => one.k === "set");
  if (into?.k !== "set") throw new Error("expected the assignment");
  into.value = { k: "text", type: { kind: "text" }, parts: [{ k: "text", value: "nope" }] };
  assert.match(semanticIrProblems(assigned, contract).join("\n"), /"total" holds a f64, not a text/);
});

test("a name, an element, a field and an arm are read as what they are written as", () => {
  // The places a value meets a type it has to agree with. A declaration starts
  // a name as a value of another type, a `for..of` reads each element at the
  // type it names, a field is written through a reference, and a conditional
  // hands back one of its arms. None of them was compared, and each is a place
  // where the C emitter casts to a type the value is not.
  const { contract } = resolved({ "main.ts": "console.log(1);\n" });
  const problems = (body: readonly string[]): string => {
    const indented = body.map((line) => (line.startsWith(" ") ? line : `  ${line}`));
    const program = parseSemanticProgram(
      ["ir 1", 'file "main.ts"', "", "block entry: releases[]", ...indented, "return", ""].join("\n"),
      contract,
    );
    return semanticIrProblems(program, contract).join("\n");
  };

  // A number declared where a string is written becomes a pointer the emitter
  // casts to a double.
  assert.match(
    problems(['let value[f64] n immutable = [text "hi"] @1', "print_number local[f64] n @1"]),
    /"n" holds a f64, not a text/,
  );
  // A number declared where a string is written is the same statement, and the
  // other way round a string declared where a number is.
  assert.match(
    problems(["let text s immutable = const[f64] 1 @1", "print_text local[text] s @1"]),
    /"s" holds a text, not a f64/,
  );

  // An element read at the wrong width is the low half of each double, and the
  // conversion the emitter writes is a legal one, so nothing says so.
  assert.match(
    problems([
      "  let buffer data immutable element[f64] 2 = [buffer[[f64; 2]] element[f64] 2 const[f64] 1 const[f64] 2] @1",
      "  for_of[i32] e of data index i1 length [length[usize] local[[f64; 2]] data] header b1 exit entry @2",
      "    block b2: releases[]",
      "      print_number local[i32] e @2",
      "      print_newline @2",
    ]),
    /an element of a \[f64; 2\] is a f64, not a i32/,
  );

  // A field written is read back the way a field read is, so it takes the same
  // three checks: the layout is one the body lays out, the field is one of its
  // fields, and the object is a reference to write through. The layout here is
  // one a function's body lays out, which is where a field is written.
  const program = programOf(
    "typescript",
    {
      "1.ts": [
        "function make(): any {",
        "  const node = { value: 1, other: 2 };",
        "  node.value = 3;",
        "  return node;",
        "}",
        "make();",
        "",
      ].join("\n"),
    },
    "1.ts",
  );
  assert.ok(
    program.files.find((file) => file.path === "1.ts")?.functions.make !== undefined,
    "expected a function that lays out an object",
  );
  const held = "    let object[ref<Object1>] node mutable = [new_object[ref<Object1>] Object1 value const[f64] 1 other const[f64] 2] @1";
  const stored = (body: readonly string[]): string =>
    semanticFunctionProblems(
      parseSemanticFunction(
        [
          "function make() -> ref<Object1>",
          "  requires none",
          "  ensures none",
          "  allocates yes",
          "  prints no",
          "  reads_argv no",
          "  effects memory",
          "  object Object1 size 16 align 8",
          "    field value: f64 at 0",
          "    field other: f64 at 8",
          "  block entry: releases[]",
          ...body,
          "  return local[ref<Object1>] node",
          "",
        ].join("\n"),
        program,
      ),
    ).join("\n");
  assert.match(
    stored([
      "    let value[f64] node immutable = const[f64] 4096 @1",
      "    store_field local[f64] node Object1 value const[f64] 7 @2",
    ]),
    /written through a f64, which is not a reference/,
  );
  assert.match(stored([held, "    store_field local[ref<Object1>] node Object1 missing const[f64] 7 @2"]), /Object1 has no field missing/);
  assert.match(
    stored([held, "    store_field local[ref<Object1>] node Absent value const[f64] 7 @2"]),
    /the object Absent is not a layout the program lays out/,
  );

  // A conditional hands back one of its two arms, so a string beside a number
  // is a conditional no compiler takes.
  assert.match(
    problems(['print_number [select[i32] [gt[bool] f64 const[f64] 1 const[f64] 0] [text "hi"] const[i32] 0] @1']),
    /the then arm of a conditional is a text, and the whole is a i32/,
  );
  // And `??` hands back one of its arms the same way.
  assert.match(
    problems(['print_number [coalesce[i32] [text "hi"] const[i32] 0] @1']),
    /the left arm of \?\? is a text, and the whole is a i32/,
  );
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
    bodies: [],
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
        { k: "printNumber", value: { k: "loadField", type: NUMBER, object: node, layout: "Object1", field: "value" }, line: 4, bigint: false },
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
          bigint: false,
          value: {
            k: "loadField",
            type: NUMBER,
            object: node,
            layout: "Object1",
            field: "value",
          },
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
  const example = new URL("../../benchmarks/c_backend/binarytrees/blaze.toml", import.meta.url).pathname;
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

test("the type of a program is the type its names read as", () => {
  const { program } = resolved({ "main.ts": "const data = new Float64Array([1, 2]);\nconsole.log(data.length);\n" });
  const declared = program.entry.statements[0];
  if (declared.k !== "let") throw new Error("expected a declaration");
  assert.equal(typeText(slotType(declared.slot)), "[f64; 2]");
  assert.equal(declared.slot.kind, "buffer");
});

test("two whole numbers of one width are computed as the unsigned of the pair", () => {
  // The contract language keeps a value above the signed range of its width
  // above it: a `u32` holding 4000000000 is not -294967296, and an IR that
  // computed the pair as a signed number would be verified against one answer
  // and compiled into another. A `usize` is over everything and an `isize` over
  // the rest, so a length read with a signed number is still computed as one.
  assert.equal(wholeOf("u32", "i32"), "u32");
  assert.equal(wholeOf("i32", "u32"), "u32");
  assert.equal(wholeOf("u8", "i8"), "u8");
  assert.equal(wholeOf("u64", "i64"), "u64");
  assert.equal(wholeOf("u32", "i16"), "u32");
  assert.equal(wholeOf("i64", "u32"), "i64");
  assert.equal(wholeOf("usize", "i64"), "usize");
  assert.equal(wholeOf("usize", "isize"), "usize");
  assert.equal(wholeOf("isize", "i32"), "isize");
  assert.equal(wholeOf("i32", "i32"), "i32");

  // A compound assignment over the pair writes what the contract language
  // computes, so the validator does not refuse a program the evaluator and the
  // backend both answer the same way, and the C writes it back unsigned: a
  // signed accumulator wraps at 2^31 and answers -294967295 where the contract
  // answers 4000000001.
  const wide: SemanticType = { kind: "primitive", name: "u32" };
  const narrow: SemanticType = { kind: "primitive", name: "i32" };
  const a: SemanticValue = { k: "local", type: wide, name: "a" };
  const b: SemanticValue = { k: "local", type: narrow, name: "b" };
  const fn: SemanticFunction = {
    name: "add",
    symbol: "add",
    params: [
      { kind: "value", name: "a", mutable: true, type: wide },
      { kind: "value", name: "b", mutable: true, type: narrow },
    ],
    returns: wide,
    requires: [],
    ensures: [],
    effects: [],
    allocates: false,
    prints: false,
    readsArgv: false,
    objects: {},
    calls: [],
    entry: {
      id: "entry",
      releases: [],
      statements: [{ k: "set", name: "a", op: "+=", value: b, line: 1 }],
      terminator: { k: "return", value: { k: "arith", type: wide, op: "add", left: a, right: b } },
    },
  };
  assert.deepEqual(semanticFunctionProblems(fn), []);
  const written = generateFunctionC(fn);
  assert.match(written, /\ba \+= \(uint32_t\)\(b\);/);
  assert.match(written, /\breturn \(a \+ \(uint32_t\)\(b\)\);/);
});


test("a loop's reduction is written in the text a model may write it in, and read back", () => {
  // The text form is what a model is handed and may hand back, so the
  // accumulators a marked loop combines have to survive being written out and
  // read again — otherwise a model that rewrites the IR silently drops them and
  // the backend is handed a marked loop with nothing to combine.
  const source = [
    "export function f(n: number): number {",
    "  let total = 0;",
    "  for (let i = 0; i < n; i += 1) {",
    "    total += i * 2 + i + i + i + i + i + i + i;",
    "  }",
    "  return total;",
    "}",
    "",
  ].join("\n");
  const files = { "main.ts": 'import { f } from "./lib.ts";\nconsole.log(f(1));\n', "lib.ts": source };
  const phase = phaseOf("typescript", files, "main.ts");
  // The loop is marked here rather than by a build, because what this reads is
  // the text form: marking is what `semantics/parallel.ts` decides and is read
  // in the tests that cover it.
  const fn = semanticsOf(phase).f as SemanticFunction;
  markParallelLoops(fn.entry);
  const printed = printSemanticFunction(fn);
  assert.match(printed, /parallel reduction total \+/, "a marked loop names what its turns combine");
  assert.equal(
    printSemanticFunction(parseSemanticFunction(printed, phase.program)),
    printed,
    "what a reduction prints, the text form reads back",
  );
});

test("a loop's marks are read in whatever order the text writes them", () => {
  // Both marks may sit on one loop, and the text a model writes may put them the
  // other way round from the printer. Reading only `parallel` and then `region`
  // in that fixed order refused `parallel region`, and refused it as a missing
  // reduction, because `region` begins with the letter a reduction begins with.
  const source = [
    "export function f(n: number): number {",
    "  let total = 0;",
    "  for (let i = 0; i < n; i += 1) {",
    "    total += i * 2 + i + i + i + i + i + i + i;",
    "  }",
    "  return total;",
    "}",
    "",
  ].join("\n");
  const files = { "main.ts": 'import { f } from "./lib.ts";\nconsole.log(f(1));\n', "lib.ts": source };
  const phase = phaseOf("typescript", files, "main.ts");
  const fn = semanticsOf(phase).f as SemanticFunction;
  markParallelLoops(fn.entry);
  const printed = printSemanticFunction(fn);
  // The region mark is added here rather than by a build, because what this
  // reads is the text form: which loops a region pass marks is read in the
  // tests that cover it.
  const withRegion = printed.replace(" parallel reduction", " parallel region reduction");
  const reread = parseSemanticFunction(withRegion, phase.program);
  assert.equal(printSemanticFunction(reread), withRegion, "what the marks print, the text form reads back");
  const statement = reread.entry.statements.find((one) => one.k === "loop");
  assert.ok(statement !== undefined && statement.loop.kind === "counted");
  assert.equal(statement.loop.parallel, true);
  assert.equal(statement.loop.region, true);
  assert.deepEqual(statement.loop.reductions, [{ name: "total", op: "+", exact: true }]);
  // The other order reads as well, and prints back in the order the printer
  // writes: the text says the same thing whichever way round the two words are.
  assert.equal(
    printSemanticFunction(parseSemanticFunction(withRegion.replace("parallel region", "region parallel"), phase.program)),
    withRegion,
    "the marks read whichever order the text writes them",
  );
});

test("a number beside a text is the test, and the text is the value", () => {
  // `&&` and `||` hand back one of their arms rather than a truth, so what
  // they are written as is the type of the arm they hand back. An arm that is
  // a number is the test that decides whether the other arm is handed back,
  // and the other arm is a text: the number is the test, and the text is the
  // value the operator is written as.
  const mixed = irOf(
    {
      "main.ts": [
        "export function pick(n: number): number {",
        "  const name = n || `none`;",
        "  return name.length;",
        "}",
        "console.log(pick(0));",
        "",
      ].join("\n"),
    },
    "pick",
  );
  assert.match(mixed, /logical_or\[text\]/, "the operator is written as the text it hands back");
  assert.match(mixed, /local\[f64\] n/, "the number arm keeps its own width");

  // The same two arms in the body of a program, where the name they are
  // written to holds a text.
  const program = resolved({
    "main.ts": ["let name = process.argv[2] || `sample`;", "console.log(name);", ""].join("\n"),
  });
  assert.match(printSemanticProgram(program.program), /logical_or\[text\]/, "the operator is written as the text it hands back");

  // A number beside a number is a number, which is what it was before.
  const plain = resolved({
    "main.ts": ["let count = process.argv[2] || 0;", "console.log(count);", ""].join("\n"),
  });
  assert.match(printSemanticProgram(plain.program), /logical_or\[f64\]/, "a number beside a number is a number");
});

test("a number written in base sixteen is text the text form writes and reads back", () => {
  // `x.toString(16)` is a number in lowercase hexadecimal, which the IR states
  // as a conversion with a negative count of digits. A printer that wrote that
  // count as a number and a parser that read it as a count of digits disagreed
  // on every function that wrote one, so the answer could not be read back.
  const files = {
    "main.ts": 'import { f } from "./lib.ts";\nconsole.log(f(255n));\n',
    "lib.ts": "export function f(n: u256): string { return `${n.toString(16)}`; }\n",
  };
  const phase = phaseOf("typescript", files, "main.ts");
  const printed = printSemanticFunction(semanticsOf(phase).f as SemanticFunction);
  assert.match(printed, /to_text@hex/, "the count a hexadecimal form is written at is `hex`");
  assert.equal(printSemanticFunction(parseSemanticFunction(printed, phase.program)), printed);
});

test("the count a program reads from its command line is a number and not a truth", () => {
  // `+Deno.args[0] || 1` binds the number the command line said, or one. The
  // short circuit hands back one of its arms, so the name holds the arm's type:
  // reading it as a truth made `i < n` a comparison of a number with a truth,
  // and every loop over a count read from the command line was refused.
  const source = [
    "function main(): void {",
    "  const n = +Deno.args[0] || 1;",
    "  for (let i = 0; i < n; i++) { console.log(`x`); }",
    "}",
    "main();",
    "",
  ].join("\n");
  const phase = phaseOf("typescript", { "main.ts": source }, "main.ts");
  const printed = printSemanticFunction(semanticsOf(phase).main as SemanticFunction);
  assert.match(printed, /reads_argv yes/, "the command line is what the count is read from");
  assert.match(printed, /let value\[f64\] n/, "the count is the number the argument says");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { CompilerError } from "../core/errors.ts";
import { frontendFor } from "../semantics/frontend.ts";
import { readModuleGraph } from "../semantics/module-graph.ts";
import { entryContract, INLINE_MODULE, runContractPhase } from "../semantics/program.ts";
import type { ProgramContract, SourceInput, SourceModule } from "../core/types.ts";
import { diagnostic, phaseOf, programOf } from "./phase.ts";
import { resolveProgram } from "../semantics/ir-resolve.ts";

const SCALE = "export function scale(x: number): number {\n  return x * 2;\n}\n";
const SQUARE = "export function square(x: number): number {\n  return x * x;\n}\n";

const DOT = [
  'import { scale } from "./scale.ts";',
  "",
  "export function dot(a: Float64Array, n: number): number {",
  "  let total = 0;",
  "  for (let i = 0; i < n; i++) total += a[i];",
  "  return total;",
  "}",
  "",
].join("\n");

/** A program written as files, contracted exactly as a build contracts it. */
function contract(files: Record<string, string>, entryFile: string, overrides: Partial<SourceInput> = {}): ProgramContract {
  return programOf("typescript", files, entryFile, overrides);
}

test("every file of the program is contracted, with its exports and its imports", () => {
  const program = contract({ "dot.ts": DOT, "scale.ts": SCALE }, "dot.ts");

  assert.deepEqual(program.files.map((file) => file.path), ["dot.ts", "scale.ts"]);
  assert.deepEqual(program.files[0].imports, ["scale.ts"]);
  assert.deepEqual(Object.keys(program.files[0].functions), ["dot"]);
  assert.deepEqual(Object.keys(program.files[1].functions), ["scale"]);
  assert.deepEqual(program.files[1].functions.scale.ensures, ["result == (x * 2)"]);
  assert.deepEqual(program.edges, [{ from: "dot.ts", to: "scale.ts", symbols: ["scale"] }]);
  assert.equal(program.entry.function, "dot");
});

test("a private helper two files name is linked under a symbol its file makes unique", () => {
  // A program links by symbol, and `helper` in one file is not `helper` in
  // another. The source name stays the contract's, and the symbol the link
  // uses is made unique by the file: each file's call reaches its own helper.
  const program = contract(
    {
      "main.ts": 'import { a } from "./a.ts";\nimport { b } from "./b.ts";\nconst total = a() + b();\n',
      "a.ts": "function helper(n: number): number {\n  return n + 1;\n}\nexport function a(): number {\n  return helper(1);\n}\n",
      "b.ts": "function helper(n: number): number {\n  return n + 2;\n}\nexport function b(): number {\n  return helper(2);\n}\n",
    },
    "main.ts",
  );

  const a = program.files.find((file) => file.path === "a.ts");
  const b = program.files.find((file) => file.path === "b.ts");
  assert.ok(a !== undefined && b !== undefined);
  const aHelper = a.functions.helper;
  const bHelper = b.functions.helper;
  assert.ok(aHelper !== undefined && bHelper !== undefined, "both private helpers are compiled");
  assert.equal(aHelper.function.name, "helper");
  assert.notEqual(aHelper.function.symbol, bHelper.function.symbol);
  assert.match(aHelper.function.symbol, /^a_ts__helper/);
  assert.match(bHelper.function.symbol, /^b_ts__helper/);

  const aCalls = JSON.stringify(a.functions.a.definition.statements);
  const bCalls = JSON.stringify(b.functions.b.definition.statements);
  assert.ok(aCalls.includes(`"name":"${aHelper.function.symbol}"`), "a's body calls its own helper");
  assert.ok(!aCalls.includes(`"name":"${bHelper.function.symbol}"`), "a's body does not call b's helper");
  assert.ok(bCalls.includes(`"name":"${bHelper.function.symbol}"`), "b's body calls its own helper");
});

test("a value another module constructs is read where it is written", () => {
  // The constructed value is read where it is written, and its expression is a
  // range in that file's text. The shape it was exported at crosses the link;
  // the range does not, because reading it against this file's tokens would
  // read a range the file does not have. The read of the importing file is the
  // one that holds the field it names.
  const files = {
    "main.ts": 'import { read } from "./b.ts";\nread();\n',
    "b.ts": 'import { settings } from "./a.ts";\nexport function read(): number {\n  return settings.value;\n}\n',
    "a.ts": ["export class Settings {", "  value = 1;", "}", "export const settings = new Settings();", ""].join("\n"),
  };
  const records = readModuleGraph({
    frontend: frontendFor("typescript"),
    entry: { path: "main.ts", source: files["main.ts"] as string },
    read: (path) => files[path as keyof typeof files] ?? null,
  });
  const b = records.find((record) => record.path === "b.ts");
  assert.ok(b !== undefined);
  assert.equal(b.refusedCount, 0, "the importing file is read whole");
  assert.equal(b.refused.length, 0);
});


test("a module value written by a function is refused", () => {
  // A module value is read through its getter; a write to it would need a cell
  // the runtime holds, and a build without one refuses the write rather than
  // reading it as a local that is not there.
  assert.throws(
    () =>
      phaseOf(
        "typescript",
        {
          "main.ts": 'import { write } from "./lib.ts";\nwrite();\n',
          "lib.ts": [
            "function make(): number {",
            "  return 1;",
            "}",
            "const value = make();",
            "export function write(): void {",
            "  value = 2;",
            "}",
            "",
          ].join("\n"),
        },
        "main.ts",
      ),
    (error: unknown) => {
      const detail = (error as { detail?: string }).detail ?? "";
      return detail.includes("module value read through its getter");
    },
  );
});

test("a class a function returns crosses the link with its methods", () => {
  // The declaration a return type names is in the module that wrote it, not in
  // the file the import names: the importing file is read against the class,
  // so the method a value of it has is a method there. The same holds for the
  // payload of an async function.
  const phase = phaseOf(
    "typescript",
    {
      "main.ts": 'import { go, goAsync } from "./b.ts";\ngo();\ngoAsync();\n',
      "b.ts": [
        'import { open, openAsync } from "./a.ts";',
        "export function go(): number {",
        "  const handle = open();",
        "  handle.sync();",
        "  return 1;",
        "}",
        "export async function goAsync(): Promise<number> {",
        "  const handle = await openAsync();",
        "  handle.sync();",
        "  return 1;",
        "}",
        "",
      ].join("\n"),
      "a.ts": [
        "export class Handle {",
        "  value = 0;",
        "  sync(): void {",
        "    this.value = 1;",
        "  }",
        "}",
        "export function open(): Handle {",
        "  return new Handle();",
        "}",
        "export async function openAsync(): Promise<Handle> {",
        "  return new Handle();",
        "}",
        "",
      ].join("\n"),
    },
    "main.ts",
  );
  const b = phase.program.files.find((file) => file.path === "b.ts");
  assert.ok(b !== undefined);
  assert.ok(b.functions.go !== undefined);
  assert.ok(b.functions.goAsync !== undefined);
});

test("an imported function shadows a builtin of the same name", () => {
  // `resolve` is a builtin of the promise a callback settles, and a module may
  // export a function of that name. The source bound the imported one, so the
  // call is that function: its two parameters are the contract it is typed by,
  // not the builtin's one.
  const phase = phaseOf(
    "typescript",
    {
      "main.ts": 'import { resolve } from "./path.ts";\nconst total = resolve(1, 2);\n',
      "path.ts": "export function resolve(a: number, b: number): number {\n  return a + b;\n}\n",
    },
    "main.ts",
  );
  assert.ok(phase.body !== undefined);
  const driver = resolveProgram(phase.body, phase.program, phase.objectNames, phase.objectLayouts, phase.objectKeys);
  const call = findCall(driver.entry);
  assert.ok(call !== null, "the body calls the imported function");
  if (call === null) return;
  assert.equal(call.callee, "resolve");
  assert.equal(call.args.length, 2);
});

/** The first call a resolved program holds, wherever the block nests it. */
function findCall(node: unknown): { callee: string; args: unknown[] } | null {
  if (Array.isArray(node)) {
    for (const value of node) {
      const found = findCall(value);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof node !== "object" || node === null) return null;
  const record = node as Record<string, unknown>;
  if (record.k === "call" && typeof record.call === "object" && record.call !== null) {
    const call = record.call as { callee?: unknown; args?: unknown };
    if (typeof call.callee === "string" && Array.isArray(call.args)) return { callee: call.callee, args: call.args };
  }
  for (const value of Object.values(record)) {
    const found = findCall(value);
    if (found !== null) return found;
  }
  return null;
}
test("an import reaches through a file that imports another", () => {
  const program = contract(
    {
      "a.ts": 'import { b } from "./b.ts";\nexport function a(x: number): number {\n  return x;\n}\n',
      "b.ts": 'import { c } from "./c.ts";\nexport function b(x: number): number {\n  return x;\n}\n',
      "c.ts": "export function c(x: number): number {\n  return x;\n}\n",
    },
    "a.ts",
  );

  assert.deepEqual(program.files.map((file) => file.path), ["a.ts", "b.ts", "c.ts"]);
  assert.deepEqual(program.edges.map((edge) => `${edge.from} -> ${edge.to}`), ["a.ts -> b.ts", "b.ts -> c.ts"]);
});

test("a first read that waited for an import does not stop the build", () => {
  // `Object.values(TABLE)` names a value another module exports. The first read
  // of the file happens before that export is bound and refuses the call; the
  // linked read settles it, and the build reads on. The verdict is the linked
  // read's, not the provisional one's.
  const program = contract(
    {
      "lib.ts": "export const TABLE = { a: 1, b: 2 };\n",
      "cli.ts": [
        'import { TABLE } from "./lib.ts";',
        "export function sum(): number {",
        "  let total = 0;",
        "  for (const value of Object.values(TABLE)) total += value;",
        "  return total;",
        "}",
        "console.log(sum());",
        "",
      ].join("\n"),
    },
    "cli.ts",
  );

  assert.deepEqual(program.files.map((file) => file.path), ["cli.ts", "lib.ts"]);
  assert.deepEqual(Object.keys(program.files[0].functions), ["sum"]);
});

test("a construct the linked read still refuses stops the build with its reason", () => {
  // The first read is deferred, not forgiven: what the link does not settle is
  // refused in the file that wrote it, and the build names the construct.
  let refused: unknown;
  try {
    contract(
      {
        "lib.ts": "export const TABLE = { a: 1, b: 2 };\n",
        "cli.ts": [
          'import { TABLE } from "./lib.ts";',
          "export function sum(target: object): number {",
          "  const held = new WeakRef(target) === undefined ? 0 : 1;",
          "  let total = 0;",
          "  for (const value of Object.values(TABLE)) total += value;",
          "  return total + held;",
          "}",
          "console.log(sum({}));",
          "",
        ].join("\n"),
      },
      "cli.ts",
    );
  } catch (error) {
    refused = error;
  }
  assert.ok(refused instanceof CompilerError, "the linked read refuses the construct");
  assert.match(refused.message, /constructs of cli\.ts are outside the subset/);
  assert.match(refused.detail ?? "", /WeakRef/);
});

test("modules that import each other are contracted once, as one program", () => {
  const program = contract(
    {
      "a.ts": 'import { b } from "./b.ts";\nexport function a(x: number): number {\n  return x;\n}\n',
      "b.ts": 'import { a } from "./a.ts";\nexport function b(x: number): number {\n  return x;\n}\n',
    },
    "a.ts",
  );

  assert.deepEqual(program.files.map((file) => file.path), ["a.ts", "b.ts"]);
  assert.deepEqual(program.edges.map((edge) => `${edge.from} -> ${edge.to}`), ["a.ts -> b.ts", "b.ts -> a.ts"]);
});

test("a type an import names types the annotations of the file that imports it", () => {
  // A type is not a runtime import: the file that declares an interface offers
  // no function to link, and the file that names it reads the field types the
  // declaration wrote. The alias `Names` is the list `string[]` and the
  // interface is still the opaque reference a contract holds.
  const program = contract(
    {
      "types.ts": [
        "export interface Call { callee: string; }",
        "export interface Definition { calls: Call[]; }",
        "export interface Contract { definition: Definition; }",
        "export type Names = string[];",
        "",
      ].join("\n"),
      "main.ts": [
        'import type { Contract, Names } from "./types.ts";',
        "export function entry(n: number): number {",
        "  return n;",
        "}",
        "export function count(contract: Contract, names: Names): number {",
        "  return names.length + contract.definition.calls.length;",
        "}",
        "",
      ].join("\n"),
    },
    "main.ts",
  );

  const main = program.files.find((file) => file.path === "main.ts");
  assert.ok(main !== undefined);
  assert.deepEqual(main.functions.count?.function.params, [
    { name: "contract", type: "ref<any>" },
    { name: "names", type: "slice<text>" },
  ]);
  const types = program.files.find((file) => file.path === "types.ts");
  assert.ok(types !== undefined, "the file that only declares types is part of the graph");
  assert.deepEqual(Object.keys(types.functions), [], "it offers no function to link");
  assert.deepEqual(program.edges, [], "a type import is not a call edge");
});

test("a file the program cannot reach takes no part in the contract", () => {
  const program = contract({ "dot.ts": DOT, "scale.ts": SCALE, "unused.ts": SQUARE }, "dot.ts");
  assert.deepEqual(program.files.map((file) => file.path), ["dot.ts", "scale.ts"]);
});

test("an unexported function is not part of the module interface", () => {
  const program = contract(
    {
      "m.ts": "function helper(x: number): number {\n  return x;\n}\n\nexport function used(x: number): number {\n  return x;\n}\n",
    },
    "m.ts",
  );
  assert.deepEqual(Object.keys(program.files[0].functions), ["used"]);
});

test("the entry names a function of the entry file", () => {
  const program = contract({ "dot.ts": DOT, "scale.ts": SCALE }, "dot.ts", { entry: "dot" });
  assert.deepEqual(program.entry, { file: "dot.ts", function: "dot" });
  assert.equal(entryContract(program).function.name, "dot");
  assert.throws(() => contract({ "dot.ts": DOT, "scale.ts": SCALE }, "dot.ts", { entry: "missing" }), /is not an export of dot.ts/);
});

test("an import that names no module of the project is refused", () => {
  assert.throws(
    () => contract({ "dot.ts": 'import { scale } from "./scale.ts";\nexport function dot(): number {\n  return 0;\n}\n' }, "dot.ts"),
    /imports "\.\/scale.ts" \(line 1\), which is not a module of this project/,
  );
});

test("an import of a symbol the module does not export is refused", () => {
  assert.throws(
    () => contract({ "dot.ts": DOT, "scale.ts": SQUARE }, "dot.ts"),
    /imports "scale" from "\.\/scale.ts", which does not export it/,
  );
});

test("one symbol cannot arrive from two files, or under another name", () => {
  assert.throws(
    () =>
      contract(
        {
          "dot.ts": 'import { shared } from "./a.ts";\nimport { shared } from "./b.ts";\nexport function dot(): number {\n  return 0;\n}\n',
          "a.ts": "export function shared(x: number): number {\n  return x;\n}\n",
          "b.ts": "export function shared(x: number): number {\n  return x;\n}\n",
        },
        "dot.ts",
      ),
    /imports "shared" from both "\.\/a.ts" and "\.\/b.ts"/,
  );
  // A rename is a binding of the export under another name, and the edge still
  // names the symbol the other module exports, because that is what is linked.
  const renamed = contract(
    {
      "dot.ts": 'import { scale as fromB } from "./b.ts";\nexport function dot(): number {\n  return 0;\n}\n',
      "b.ts": "export function scale(x: number): number {\n  return x;\n}\n",
    },
    "dot.ts",
  );
  assert.deepEqual(renamed.edges, [{ from: "dot.ts", to: "b.ts", symbols: ["scale"] }]);
});

test("a module may export one function as its default, and an importer may bind it", () => {
  const program = contract(
    {
      "main.ts": [
        'import scale, { helper } from "./lib.ts";',
        "export function dot(x: number): number {",
        "  return 0;",
        "}",
        "",
      ].join("\n"),
      "lib.ts": [
        "function helper(x: number): number {",
        "  return x + 1;",
        "}",
        "",
        "export default function scale(x: number, n: number): number {",
        "  return x * n;",
        "}",
        "",
        "export { helper };",
        "",
      ].join("\n"),
    },
    "main.ts",
  );

  // A default export is offered under the name it was declared with, because
  // this subset links by name: the local name the importer wrote is not carried.
  const library = program.files.find((file) => file.path === "lib.ts");
  assert.deepEqual(Object.keys(library?.functions ?? {}), ["helper", "scale"]);
  assert.deepEqual(program.edges, [{ from: "main.ts", to: "lib.ts", symbols: ["helper", "scale"] }]);
});

test("a default export a module does not offer is refused, naming what it offers", () => {
  assert.match(
    diagnostic(() =>
      contract(
        {
          "main.ts": 'import scale from "./lib.ts";\nexport function dot(x: number): number {\n  return scale(x, 1);\n}\n',
          "lib.ts": SCALE,
        },
        "main.ts",
      ),
    ),
    /imports the default export of "\.\/lib\.ts".*which has none/s,
  );
});

test("an export naming a function the file does not declare is refused", () => {
  assert.match(
    diagnostic(() =>
      contract(
        {
          "main.ts": 'import { missing } from "./lib.ts";\nexport function dot(x: number): number {\n  return x;\n}\n',
          "lib.ts": "function scale(x: number): number {\n  return x;\n}\nexport { missing };\n",
        },
        "main.ts",
      ),
    ),
    /"missing" is exported but not declared here/,
  );
});

test("a file that imports a symbol it also declares is a conflict", () => {
  // A Nim import brings in every export, so the clash is caught for the reader.
  assert.throws(
    () =>
      programOf(
        "nim",
        {
          "main.nim": "import ./other\n\nproc scale(x: float64): float64 = x * 2.0\nproc dot(x: float64): float64 = x\n",
          "other.nim": "proc scale(x: float64): float64 = x\n",
        },
        "main.nim",
      ),
    /imports "scale" and declares it itself/,
  );
});

test("a Nim import brings in every export of the module it names", () => {
  const program = programOf(
    "nim",
    {
      "main.nim": "import ./other\n\nproc dot(x: float64): float64 = x\n",
      "other.nim": "proc scale(x: float64): float64 = x * 2.0\nproc shift(x: float64): float64 = x + 1.0\n",
    },
    "main.nim",
  );
  assert.deepEqual(program.edges, [{ from: "main.nim", to: "other.nim", symbols: ["scale", "shift"] }]);
});

test("a module that names no module of the project is refused", () => {
  assert.throws(
    () => programOf("nim", { "main.nim": "import std/math\n\nproc dot(x: float64): float64 = x\n" }, "main.nim"),
    /cannot import "std\/math"/,
  );
});

test("a file with no export cannot be part of a program", () => {
  assert.throws(
    () =>
      contract(
        {
          "dot.ts": 'import { hidden } from "./empty.ts";\nexport function dot(): number {\n  return 0;\n}\n',
          "empty.ts": "function hidden(x: number): number {\n  return x;\n}\n",
        },
        "dot.ts",
      ),
    /empty.ts exports no function/,
  );
});

test("an inline source cannot import, because it has no directory", () => {
  const input: SourceInput = {
    language: "typescript",
    source: 'import { f } from "./f.ts";\nexport function f(): number { return 1; }\n',
    entry: "",
  };
  assert.throws(
    () =>
      runContractPhase({
        frontend: frontendFor("typescript"),
        input,
        entry: { path: INLINE_MODULE, source: input.source },
        read: () => null,
      }),
    /an inline source cannot import "\.\/f.ts"/,
  );
});

test("the contracts that leave the phase are frozen, so a backend cannot rewrite them", () => {
  const program = contract({ "dot.ts": DOT, "scale.ts": SCALE }, "dot.ts");
  const entry = program.files[0].functions.dot;

  assert.ok(Object.isFrozen(program));
  assert.ok(Object.isFrozen(program.files));
  assert.ok(Object.isFrozen(entry));
  assert.throws(() => {
    (entry.ensures as string[]).push("result == 0");
  }, TypeError);
});

test("the phase reports every module of the program with the source it came from", () => {
  const sources: SourceModule[] = [
    { path: "dot.ts", source: DOT },
    { path: "scale.ts", source: SCALE },
  ];
  const input: SourceInput = { language: "typescript", source: sources[0].source, entry: "" };
  const phase = runContractPhase({
    frontend: frontendFor("typescript"),
    input,
    entry: sources[0],
    read: (path) => sources.find((module) => module.path === path)?.source ?? null,
  });

  assert.deepEqual(phase.modules, sources);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { frontendFor } from "../semantics/frontend.ts";
import { entryContract, INLINE_MODULE, runContractPhase } from "../semantics/program.ts";
import type { ProgramContract, SourceInput, SourceModule } from "../core/types.ts";
import { diagnostic, programOf } from "./phase.ts";

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
  assert.match(
    diagnostic(() =>
      contract(
        {
          "dot.ts": 'import { scale } from "./a.ts";\nimport { scale as fromB } from "./b.ts";\nexport function dot(): number {\n  return 0;\n}\n',
          "a.ts": SCALE,
          "b.ts": "export function scale(x: number): number {\n  return x;\n}\n",
        },
        "dot.ts",
      ),
    ),
    /renaming an import is not supported/,
  );
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

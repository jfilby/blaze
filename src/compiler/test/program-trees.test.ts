/**
 * A program that runs functions: the driver that runs them, and the object the
 * functions share.
 *
 * `src/benchmarks/c_backend/binarytrees/1.ts` is the case: a program whose statements call
 * one function, which calls two that recurse over an allocated tree. What the
 * driver has to get right is everything between the source and the binary: the
 * objects it declares, the arguments it passes, and the symbol the compiled
 * function is called by.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { frontendFor } from "../semantics/frontend.ts";
import { runContractPhase } from "../semantics/program.ts";
import { CompilerError } from "../core/errors.ts";
import { resolveProgram } from "../semantics/ir-resolve.ts";
import { printSemanticProgram } from "../semantics/ir-text.ts";
import { generateProgramDriver } from "../toolchain/driver.ts";
import { generateProgramHostSource } from "../runtime/nim-program.ts";
import { irOf } from "./phase.ts";
import { verifyProgram } from "../toolchain/verify-program.ts";
import { RUNTIME_ABI, RUNTIME_NAME, runtimeHeaderSource, runtimeSourceSource } from "../runtime/abi.ts";
import { generateRuntimeAdapterSource } from "../runtime/nim.ts";
import { run } from "../core/process.ts";
import { mkdir } from "node:fs/promises";
import { scratch } from "./scratch.ts";

const nimAvailable = run("nim", ["--version"], { timeoutMs: 30_000 }).code === 0;

const TREES = new URL("../../benchmarks/c_backend/binarytrees/1.ts", import.meta.url).pathname;

async function trees() {
  const source = await readFile(TREES, "utf8");
  const phase = runContractPhase({
    frontend: frontendFor("typescript"),
    input: { language: "typescript", source, entry: "" },
    entry: { path: "1.ts", source },
    read: () => null,
  });
  const resolved = resolveProgram(phase.body!, phase.program, phase.objectNames, phase.objectLayouts, phase.objectKeys);
  return { source, resolved, contracts: phase.program.files[0].functions };
}

test("a program of functions is resolved, objects and all", async () => {
  const { resolved, contracts } = await trees();

  // The program calls one function, which is compiled under a name of its own
  // because the executable the driver links already has an entry point.
  assert.equal(resolved.entry.statements.length, 1);
  const invoked = resolved.entry.statements[0];
  assert.equal(invoked.k, "call");
  assert.equal(invoked.k === "call" ? invoked.call.signature.symbol : "", "blaze_main");
  assert.equal(contracts.main.function.symbol, "blaze_main");
  assert.equal(contracts.checksum.function.symbol, "checksum");

  // One object for the tree, laid out by the contract and declared by the driver.
  assert.deepEqual(Object.keys(resolved.objects), ["Object1"]);
  assert.equal(resolved.objects.Object1.size, 16);
});

test("the C driver declares the objects, takes the arguments and calls the program", async () => {
  const { resolved } = await trees();
  const driver = generateProgramDriver(resolved);

  // A field that holds a reference is a handle the runtime passes around, and
  // a handle is a double: the field is one, and the object is the same size
  // everywhere it is declared.
  assert.match(driver, /struct Object1 \{\n {2}double left; \/\* \+0 \*\/\n {2}double right; \/\* \+8 \*\/\n\}; \/\* 16 bytes, align 8 \*\//);
  // The declaration of a function the driver links names the type it hands
  // back and leaves the parameters out: a parameter the source wrote no type
  // for is carried as a double or as a pointer, and the driver has to guess
  // which, so the call is left to the definition.
  assert.match(driver, /extern void blaze_main\(\);/);
  assert.match(driver, /extern struct Object1\* createTree\(\);/);
  // The arguments of the run reach the program the way the source reads them.
  assert.match(driver, /int main\(int argc, char\*\* argv\)/);
  assert.match(driver, new RegExp(`${RUNTIME_NAME}_arguments_set\\(arguments`));
  assert.match(driver, /\n {2}blaze_main\(\);\n/);
});

test("an object field named after a C keyword or a macro is declared under another name", async () => {
  // A field is named by whatever the source called it, and `long` is a legal
  // identifier to this compiler and a reserved word to the C one, so
  // `struct { double long; }` is not C: the driver, the harness and the probe
  // that declared it were all source no target compiler takes. A macro is the
  // same problem by a different road, since `bool` is substituted for `_Bool`
  // before the declaration is read. A typedef is not: a member is in a
  // namespace of its own, so `size_t` is left as the source wrote it.
  const source = [
    "function make(): any {",
    "  return { long: 1, register: 2, bool: 3, size_t: 4, alpha: 5 };",
    "}",
    "function main(): void {",
    "  console.log(`${make()}`);",
    "}",
    "main();",
    "",
  ].join("\n");
  const phase = runContractPhase({
    frontend: frontendFor("typescript"),
    input: { language: "typescript", source, entry: "" },
    entry: { path: "1.ts", source },
    read: () => null,
  });
  const driver = generateProgramDriver(resolveProgram(phase.body!, phase.program, phase.objectNames, phase.objectLayouts, phase.objectKeys));
  assert.match(driver, /double long_; \/\* \+0 \*\//);
  assert.match(driver, /double register_; \/\* \+8 \*\//);
  assert.match(driver, /double bool_; \/\* \+16 \*\//);
  assert.match(driver, /double size_t; \/\* \+24 \*\//);
  assert.match(driver, /double alpha; \/\* \+32 \*\//);
});

test("the Nim host runs the same program the C driver does", async () => {
  const { resolved } = await trees();
  const host = generateProgramHostSource(resolved);

  assert.match(host, /proc blaze_main\(\) \{\.importc: "blaze_main", nodecl\.\}/);
  assert.match(host, /proc createTree\(depth: float64\): ptr Object1 \{\.importc: "createTree", nodecl\.\}/);
  // A call that returns nothing is a statement, and the arguments are the
  // numbers the source reads them as.
  assert.match(host, /\n {2}blaze_main\(\)\n/);
  assert.match(host, new RegExp(`${RUNTIME_NAME}_arguments_set\\(`));
});

test("a Nim object is the payload the C side wrote, and not a cell in front of it", async (t) => {
  // The layout is the whole of it: an object is one block the runtime allocated
  // and every side reads the same bytes of it. A Nim object written `ref object
  // of RootObj` inherited from the root of the type hierarchy, which puts a
  // vtable pointer in front of the fields — a field the contract puts at 0 was
  // read at 8, and at 16 the next one — and a `ref object` puts a reference-count
  // cell in front of the payload, so the pointer the C backend returned was not
  // the pointer the host held. A plain object is neither.
  if (!nimAvailable) {
    t.skip("the Nim compiler is not installed");
    return;
  }
  const { resolved } = await trees();
  const host = generateProgramHostSource(resolved);
  assert.match(host, /type\n {2}Object1\* = object\n {4}left\*: pointer\n {4}right\*: pointer/);
  // The prototype the host hands the C compiler names a `void*` for it, because
  // Nim gives its own object type a C name of its own: the C compiler refused
  // the call with "assignment to `tyObject_Object1 *` from incompatible pointer
  // type `struct Object1 *`", which is what a host could not be built from.
  assert.match(host, /extern void\* createTree\(double depth\);/);
  // And the host builds, which is the whole of what those two lines are for.
  const directory = await scratch("blaze-nim-layout-");
  await writeFile(join(directory, "host.nim"), host, "utf8");
  await writeFile(join(directory, `${RUNTIME_NAME}.nim`), generateRuntimeAdapterSource("debug"), "utf8");
  const built = run("nim", ["c", "--hints:off", "--warnings:off", "-d:danger", "--compileOnly", "host.nim"], { cwd: directory, timeoutMs: 300_000 });
  assert.equal(built.code, 0, built.stderr);
});

test("the runtime offers what a function needs to allocate, print and read the command line", () => {
  const symbols = RUNTIME_ABI.map((entry) => entry.symbol);
  for (const symbol of [
    "blaze_rt_object_new",
    "blaze_rt_print_text",
    "blaze_rt_print_number",
    "blaze_rt_print_newline",
    "blaze_rt_argv_count",
    "blaze_rt_argv",
    "blaze_rt_arguments_set",
  ]) {
    assert.ok(symbols.includes(symbol), `${symbol} must be part of the runtime ABI`);
  }
});

test("both runs of a check are given the same arguments", async () => {
  const directory = await scratch("blaze-argv-");
  const sourcePath = join(directory, "source.ts");
  const binaryPath = join(directory, "program.ts");
  // The source and the program read the first argument the same way, so a
  // check that lost one says so: the two print different lines.
  const program = "console.log(`depth ${process.argv[2]}`);\n";
  await writeFile(sourcePath, program, "utf8");
  await writeFile(binaryPath, program, "utf8");

  const checked = await verifyProgram({
    language: "typescript",
    sourcePath,
    directory,
    runner: { command: "node", args: [binaryPath] },
    arguments: ["10"],
  });
  assert.equal(checked.passed, true, JSON.stringify(checked.difference ?? {}));
  assert.equal(checked.expected, "depth 10\n");
  assert.equal(checked.actual, "depth 10\n");

  // A second argument reaches the program run too: a driver that dropped it
  // would print the first, and the check would say the two differ.
  const second = await verifyProgram({
    language: "typescript",
    sourcePath,
    directory,
    runner: { command: "node", args: [binaryPath] },
    arguments: ["12"],
  });
  assert.equal(second.passed, true, JSON.stringify(second.difference ?? {}));
  assert.equal(second.actual, "depth 12\n");
});

test("the C driver closes a branch before it opens the else, so a choice compiles", async () => {
  const source = [
    "function pick(n: number): number {",
    "  return n * 2;",
    "}",
    "let n = 3;",
    "if (n > 2) {",
    '  console.log("big");',
    "} else {",
    '  console.log("small");',
    "}",
    "",
  ].join("\n");
  const phase = runContractPhase({
    frontend: frontendFor("typescript"),
    input: { language: "typescript", source, entry: "" },
    entry: { path: "1.ts", source },
    read: () => null,
  });
  const driver = generateProgramDriver(resolveProgram(phase.body!, phase.program, phase.objectNames, phase.objectLayouts, phase.objectKeys));

  // The arm is closed before the else opens: a header that closed the arm as
  // well left a stray brace and the driver could not be compiled at all.
  assert.match(driver, /\}\n {2}else \{\n/);
  assert.doesNotMatch(driver, /\} \} else \{/);
});

test("a fallback keeps its arm when the left is a reference that may be null", async () => {
  const source = [
    "function createTree(depth: number): any {",
    "  return depth-- > 0",
    "    ? { left: createTree(depth), right: createTree(depth) }",
    "    : { left: null, right: null };",
    "}",
    "",
    "const root = createTree(2);",
    "const fallback = createTree(0);",
    "if ((root ?? fallback) !== null) {",
    '  console.log("reachable");',
    "}",
    "",
  ].join("\n");
  const phase = runContractPhase({
    frontend: frontendFor("typescript"),
    input: { language: "typescript", source, entry: "" },
    entry: { path: "1.ts", source },
    read: () => null,
  });
  const driver = generateProgramDriver(resolveProgram(phase.body!, phase.program, phase.objectNames, phase.objectLayouts, phase.objectKeys));

  // A reference is as nullable as a string: reading it as a number compiled the
  // fallback away and answered the comparison with the left side alone.
  assert.match(driver, /\(root\) == NULL\)\) \? \(fallback\) : \(root\)/);
});

test("a break frees the blocks it leaves and no block it stays inside", async () => {
  const source = [
    "let round = 0;",
    "while (round < 3) {",
    "  const inner = new Float64Array([round + 1]);",
    "  let go = true;",
    "  while (go) { break; }",
    "  console.log(inner[0]);",
    "  round += 1;",
    "}",
    "",
  ].join("\n");
  const phase = runContractPhase({
    frontend: frontendFor("typescript"),
    input: { language: "typescript", source, entry: "" },
    entry: { path: "1.ts", source },
    read: () => null,
  });
  const driver = generateProgramDriver(resolveProgram(phase.body!, phase.program, phase.objectNames, phase.objectLayouts, phase.objectKeys));

  // The break leaves the inner loop, not the block the buffer belongs to, so
  // `inner` is still live where it is read. Releasing it there freed the
  // allocation the read was about to name.
  const read = driver.indexOf("inner[0]");
  const release = driver.indexOf("blaze_rt_release(inner)");
  assert.ok(read >= 0, "the buffer is read by the program");
  assert.ok(release >= 0, "the buffer is released when its block ends");
  assert.ok(release > read, "the buffer is released after its last read, not before it");
  assert.equal(driver.split("blaze_rt_release(inner)").length - 1, 1, "the buffer is released exactly once");
});

test("one name may belong to one function across the whole program", () => {
  const files: Record<string, string> = {
    "main.ts": [
      'import { helper } from "./a.ts";',
      "export function shared(x: number): number {",
      "  return x + 1;",
      "}",
      "helper(1);",
      "",
    ].join("\n"),
    "a.ts": [
      "export function helper(x: number): number {",
      "  return x;",
      "}",
      "export function shared(x: number): number {",
      "  return x + 2;",
      "}",
      "",
    ].join("\n"),
  };
  const source = files["main.ts"] as string;

  // Every function of a program is compiled on its own and linked beside the
  // others by its name, and the object layouts are resolved by name too. Two
  // files exporting one name used to overwrite each other on the way through:
  // the loser kept a contract with no layouts at all, both were written to the
  // same work directory, and the link failed with a duplicate symbol.
  assert.throws(
    () =>
      runContractPhase({
        frontend: frontendFor("typescript"),
        input: { language: "typescript", source, entry: "" },
        entry: { path: "main.ts", source },
        read: (path) => files[path] ?? null,
      }),
    /"shared" is declared by both main\.ts and a\.ts/,
  );
});

test("the diagnostic for an array used at two element types names the file it is in", () => {
  const total = [
    "function total(xs: Float32Array, n: number): number {",
    "  let sum = 0;",
    "  for (let i = 0; i < n; i++) { sum += xs[i]; }",
    "  return sum;",
    "}",
  ];
  const source = [...total, "const a: Float64Array = new Float64Array([1, 2, 3]);", "const b = a;", "console.log(total(b, 3));", ""].join("\n");

  // `b` is another name for `a`, and the driver writes the array down once, so
  // every name for it has to take the element type the parameter asks for. The
  // refusal is the one place a user is told which line of which file to go
  // and change, and it read as the literal text `this.body.file` instead.
  assert.throws(() => {
    const phase = runContractPhase({
      frontend: frontendFor("typescript"),
      input: { language: "typescript", source, entry: "" },
      entry: { path: "1.ts", source },
      read: () => null,
    });
    resolveProgram(phase.body!, phase.program, phase.objectNames, phase.objectLayouts, phase.objectKeys);
  }, (error: unknown) => error instanceof CompilerError && /line 8 of 1\.ts: allocate the array/.test(error.detail ?? ""));
});

test("a loop step that is itself a step is written once", () => {
  // `i += j++` lowers the inner `j++` into a `let` and a `step` of its own,
  // and typing the step expression a second time to settle the loop's width
  // emitted that pair twice. The counter then advanced by the value `j` held
  // after two increments instead of one, and the loop ran a different number
  // of times than the source wrote.
  const source = [
    "function go(n: number): number {",
    "  let j = 0;",
    "  let total = 0;",
    "  for (let i = 0; i < n; i += j++) { total += i; }",
    "  return total;",
    "}",
    "",
    "console.log(go(3));",
    "",
  ].join("\n");
  const ir = irOf("typescript", { "1.ts": source }, "1.ts", "go");
  // The step of the loop is written once, and the counter it moves by is the
  // value `j` held before the increment: `j++` is a postfix step, so the
  // snapshot is taken first and the name is stepped after it.
  assert.equal(ir.split("step j ++ post").length - 1, 1, ir);
  assert.match(ir, /let value\[f64\] t\d+ immutable = local\[f64\] j @4\n {4}step j \+\+ post @4/);
  assert.match(ir, /for\[f64\] i from const\[f64\] 0 to local\[f64\] n exclusive up step local\[f64\] t1/);
});

test("a function named after a C keyword is declared under another name and bound to its symbol", async () => {
  // A function's symbol is its own name, and an object file may define a symbol
  // called `short`: `extern double short(double)` is not C, so the driver, the
  // harness and the probe all wrote a declaration that named nothing and the
  // link failed on a name the source was free to choose. The declaration is
  // written under a name C takes and carries the symbol beside it, which leaves
  // the object defining the symbol the source gave it.
  const source = [
    "function short(n: number): number {",
    "  let total = 0;",
    "  let i = 0;",
    "  while (i < n) { total += i; i += 1; }",
    "  return total;",
    "}",
    "function main(): void {",
    "  console.log(short(10));",
    "}",
    "main();",
    "",
  ].join("\n");
  const phase = runContractPhase({
    frontend: frontendFor("typescript"),
    input: { language: "typescript", source, entry: "" },
    entry: { path: "1.ts", source },
    read: () => null,
  });
  const driver = generateProgramDriver(resolveProgram(phase.body!, phase.program, phase.objectNames, phase.objectLayouts, phase.objectKeys));
  // The declaration is written under a name C takes and carries the symbol
  // beside it, and it leaves the parameters out: a parameter the source wrote
  // no type for is carried as a double or as a pointer, and the driver has to
  // guess which, so the call is left to the definition.
  assert.match(driver, /extern double short_\(\) __asm__\("short"\);/);
  // Nothing anywhere in the driver calls it under the name C cannot spell: the
  // declaration is the only place the symbol is written, and it writes the name
  // the declaration took.
  assert.doesNotMatch(driver, /[^_\w]short\(/);
});

test("a function nested inside a function is read by the same resolver the captures are for", () => {
  // A function the body of another declares gets what it reads of the scope
  // around it at every call, like a function the program declares: it is
  // compiled on its own, and the call is where the scope it touches crosses.
  // Both of them must end up in one program's own table, and the contract
  // frontend parsing is what decides which table each is in — a nested one
  // used to stop the whole file from being a program.
  const source = [
    "let base = 10;",
    "function outer(x: number): number {",
    "  function inner(n: number): number {",
    "    return n + base;",
    "  }",
    "  return inner(x);",
    "}",
    "console.log(outer(32));",
    "",
  ].join("\n");
  const phase = runContractPhase({
    frontend: frontendFor("typescript"),
    input: { language: "typescript", source, entry: "" },
    entry: { path: "1.ts", source },
    read: () => null,
  });
  const printed = printSemanticProgram(resolveProgram(phase.body!, phase.program, phase.objectNames, phase.objectLayouts, phase.objectKeys));
  assert.match(printed, /function outer\(x: f64, base: f64\) -> f64/);
  assert.match(printed, /function inner\(n: f64, base: f64\) -> f64/);
});

test("a function nested inside a function declared first is still the program's", () => {
  // Nothing in a program's grammar says where its functions are written: a
  // program may run first and declare its functions when it comes to them.
  // The module front end read it as declarations, and refused the nested one
  // before the program was ever tried; the program parser is the one that
  // carries that shape, so a file it is denied is re-read by it whole.
  const source = [
    "function outer(x: number): number {",
    "  function inner(n: number): number {",
    "    return n * 2;",
    "  }",
    "  return inner(x);",
    "}",
    "console.log(outer(21));",
    "",
  ].join("\n");
  const phase = runContractPhase({
    frontend: frontendFor("typescript"),
    input: { language: "typescript", source, entry: "" },
    entry: { path: "1.ts", source },
    read: () => null,
  });
  const program = resolveProgram(phase.body!, phase.program, phase.objectNames, phase.objectLayouts, phase.objectKeys);
  assert.deepEqual(
    program.bodies.map((fn) => fn.name).sort(),
    ["inner", "outer"],
  );
});

test("a function of a program is given every name of the scope it touches", () => {
  // A function declared in a program is compiled on its own, so every name it
  // reads of the scope around it is a parameter of its own. Two walks decide
  // that list, and a statement kind either walk does not read is a name the
  // function is not handed at the call — which the resolver then refuses the
  // body for, on a program the language accepts.
  //
  // Here a name is written rather than read (`total += n`, `total++`), a buffer
  // is written through its own name (`data[0] = 9`), a loop walks a name rather
  // than a value (`for (const v of data)`), and a call is written as the value
  // of a declaration rather than as a statement — the last one is the transitive
  // half: `outer` must be given whatever `inner` reads, or it cannot pass it on.
  const source = [
    "const data = new Float64Array([1, 2, 3]);",
    "let total = 0;",
    "const base = 5;",
    "",
    "function inner(x: number): number {",
    "  return x + base;",
    "}",
    "",
    "function add(n: number): void {",
    "  total += n;",
    "}",
    "",
    "function bump(): void {",
    "  total++;",
    "}",
    "",
    "function poke(): void {",
    "  data[0] = 9;",
    "}",
    "",
    "function walk(): void {",
    "  for (const v of data) { total += v; }",
    "}",
    "",
    "function outer(x: number): number {",
    "  const y = inner(x);",
    "  return y;",
    "}",
    "",
    "add(1);",
    "bump();",
    "poke();",
    "walk();",
    "console.log(outer(1), total, data[0]);",
    "",
  ].join("\n");
  const phase = runContractPhase({
    frontend: frontendFor("typescript"),
    input: { language: "typescript", source, entry: "" },
    entry: { path: "1.ts", source },
    read: () => null,
  });
  const printed = printSemanticProgram(resolveProgram(phase.body!, phase.program, phase.objectNames, phase.objectLayouts, phase.objectKeys));

  // Each is handed the name it touches, and `outer` the name `inner` reads:
  // reaching the program at all is what these are for, and a name missing from
  // one of them refused the body for reading something nothing declared.
  assert.match(printed, /function add\(n: f64, total: f64\) -> void/);
  assert.match(printed, /function bump\(total: f64\) -> void/);
  assert.match(printed, /function poke\(data: \[\]f64\) -> void/);
  assert.match(printed, /function walk\(data: \[\]f64, total: f64\) -> void/);
  assert.match(printed, /function inner\(x: f64, base: f64\) -> f64/);
  assert.match(printed, /function outer\(x: f64, base: f64\) -> f64/);

  // The call passes what the callee reads, so the two agree.
  assert.match(printed, /call\[f64\] outer \[arg\[f64\] const\[f64\] 1 arg\[f64\] local\[f64\] base\]/);
});

test("a truth that is a call is asked of it once, by either driver", async (t) => {
  if (run("nim", ["--version"], { timeoutMs: 30_000 }).code !== 0) {
    t.skip("the Nim compiler is not installed");
    return;
  }
  // `NaN != 0` is true in C and in Nim, so the test for a number that is a
  // number reads the value twice — and a value the IR calls is a call. The C
  // driver binds it in a block; the Nim one wrote the expression out at each of
  // the two places, so `if (tick())` printed its line three times under one
  // runtime and once under the other. Both drivers are built here from the same
  // program and run against the same callee, which is what makes the difference
  // visible rather than a matter of how the text reads.
  const source = [
    "function tick(): number {",
    "  console.log(`tick`);",
    "  return 1.5;",
    "}",
    "let seen = 0;",
    "if (tick()) { seen = 1; }",
    "console.log(seen);",
    "",
  ].join("\n");
  const phase = runContractPhase({
    frontend: frontendFor("typescript"),
    input: { language: "typescript", source, entry: "" },
    entry: { path: "1.ts", source },
    read: () => null,
  });
  const resolved = resolveProgram(phase.body!, phase.program, phase.objectNames, phase.objectLayouts, phase.objectKeys);

  // The callee both drivers call, which counts nothing itself: the program's own
  // print is the count.
  const callee = ["#include <stdio.h>", "double tick(void) { printf(\"tick\\n\"); return 1.5; }", ""].join("\n");
  const root = await scratch("blaze-truth-");

  const plain = join(root, "c");
  await mkdir(plain);
  await writeFile(join(plain, "tick.c"), callee, "utf8");
  await writeFile(join(plain, "driver.c"), generateProgramDriver(resolved), "utf8");
  await writeFile(join(plain, `${RUNTIME_NAME}.h`), runtimeHeaderSource(), "utf8");
  await writeFile(join(plain, `${RUNTIME_NAME}.c`), runtimeSourceSource(), "utf8");
  const builtC = run("gcc", ["-std=c11", "-O1", "-o", "driver", "driver.c", "tick.c", `${RUNTIME_NAME}.c`, "-lm"], { cwd: plain, timeoutMs: 120_000 });
  assert.equal(builtC.code, 0, builtC.stderr);
  const fromC = run(join(plain, "driver"), [], { cwd: plain, timeoutMs: 60_000 });
  assert.equal(fromC.code, 0, fromC.stderr);

  const hosted = join(root, "nim");
  await mkdir(hosted);
  await writeFile(join(hosted, "tick.c"), callee, "utf8");
  await writeFile(join(hosted, `${RUNTIME_NAME}.nim`), generateRuntimeAdapterSource(), "utf8");
  await writeFile(join(hosted, "host.nim"), generateProgramHostSource(resolved), "utf8");
  const object = run("gcc", ["-std=c11", "-O1", "-c", "-o", "tick.o", "tick.c"], { cwd: hosted, timeoutMs: 120_000 });
  assert.equal(object.code, 0, object.stderr);
  const builtNim = run("nim", ["c", "--hints:off", "--warnings:off", `--nimcache:${join(hosted, "cache")}`, `--passL:${join(hosted, "tick.o")}`, `--out:${join(hosted, "host")}`, "host.nim"], {
    cwd: hosted,
    timeoutMs: 600_000,
  });
  assert.equal(builtNim.code, 0, builtNim.stderr);
  const fromNim = run(join(hosted, "host"), [], { cwd: hosted, timeoutMs: 60_000 });
  assert.equal(fromNim.code, 0, fromNim.stderr);

  assert.equal(fromC.stdout, "tick\n1\n", "the C driver must ask the call once");
  assert.equal(fromNim.stdout, fromC.stdout, "the two drivers must run the same program");
});


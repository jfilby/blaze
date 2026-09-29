/**
 * A program that runs functions: the driver that runs them, and the object the
 * functions share.
 *
 * `src/examples/binarytrees/1.ts` is the case: a program whose statements call
 * one function, which calls two that recurse over an allocated tree. What the
 * driver has to get right is everything between the source and the binary: the
 * objects it declares, the arguments it passes, and the symbol the compiled
 * function is called by.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frontendFor } from "../semantics/frontend.ts";
import { runContractPhase } from "../semantics/program.ts";
import { CompilerError } from "../core/errors.ts";
import { resolveProgram } from "../semantics/ir-resolve.ts";
import { generateProgramDriver } from "../toolchain/driver.ts";
import { generateProgramHostSource } from "../runtime/nim-program.ts";
import { irOf } from "./phase.ts";
import { verifyProgram } from "../toolchain/verify-program.ts";
import { RUNTIME_ABI, RUNTIME_NAME } from "../runtime/abi.ts";

const TREES = new URL("../../examples/binarytrees/1.ts", import.meta.url).pathname;

async function trees() {
  const source = await readFile(TREES, "utf8");
  const phase = runContractPhase({
    frontend: frontendFor("typescript"),
    input: { language: "typescript", source, entry: "" },
    entry: { path: "1.ts", source },
    read: () => null,
  });
  const resolved = resolveProgram(phase.body!, phase.program);
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

  assert.match(driver, /struct Object1 \{\n {2}void\* left; \/\* \+0 \*\/\n {2}void\* right; \/\* \+8 \*\/\n\}; \/\* 16 bytes, align 8 \*\//);
  assert.match(driver, /extern void blaze_main\(void\);/);
  assert.match(driver, /extern struct Object1\* createTree\(double depth\);/);
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
  const driver = generateProgramDriver(resolveProgram(phase.body!, phase.program));
  assert.match(driver, /double long_; \/\* \+0 \*\//);
  assert.match(driver, /double register_; \/\* \+8 \*\//);
  assert.match(driver, /double bool_; \/\* \+16 \*\//);
  assert.match(driver, /double size_t; \/\* \+24 \*\//);
  assert.match(driver, /double alpha; \/\* \+32 \*\//);
});

test("the Nim host runs the same program the C driver does", async () => {
  const { resolved } = await trees();
  const host = generateProgramHostSource(resolved);

  assert.match(host, /type\n {2}Object1\* = ref object of RootObj\n {4}left\*: pointer\n {4}right\*: pointer/);
  assert.match(host, /proc blaze_main\(\) \{\.importc: "blaze_main", nodecl\.\}/);
  assert.match(host, /proc createTree\(depth: float64\): ptr Object1 \{\.importc: "createTree", nodecl\.\}/);
  // A call that returns nothing is a statement, and the arguments are the
  // numbers the source reads them as.
  assert.match(host, /\n {2}blaze_main\(\)\n/);
  assert.match(host, new RegExp(`${RUNTIME_NAME}_arguments_set\\(`));
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
  const directory = await mkdtemp(join(tmpdir(), "blaze-argv-"));
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
  const driver = generateProgramDriver(resolveProgram(phase.body!, phase.program));

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
  const driver = generateProgramDriver(resolveProgram(phase.body!, phase.program));

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
  const driver = generateProgramDriver(resolveProgram(phase.body!, phase.program));

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
    resolveProgram(phase.body!, phase.program);
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

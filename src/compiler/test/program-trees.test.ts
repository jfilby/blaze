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
import { resolveProgram } from "../toolchain/program.ts";
import { generateProgramDriver } from "../toolchain/driver.ts";
import { generateProgramHostSource } from "../runtime/nim-program.ts";
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
  assert.equal(resolved.statements.length, 1);
  const invoked = resolved.statements[0];
  assert.equal(invoked.kind, "invoke");
  assert.equal(invoked.kind === "invoke" ? invoked.call.name : "", "blaze_main");
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

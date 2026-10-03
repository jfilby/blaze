import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateHarness } from "../toolchain/linker.ts";
import { buildStandaloneRuntime } from "../runtime/standalone.ts";
import { run } from "../core/process.ts";
import type { FunctionContract } from "../core/types.ts";
import { body } from "./definition.ts";
import { scratch } from "./scratch.ts";

/** Echoes the System V argument at `register`, so the harness is judged on what it hands over. */
function echoContract(params: string, returns = "i32"): FunctionContract {
  const declared = params.split(",").map((entry) => {
    const [name, type] = entry.split(":").map((part) => part.trim());
    return { name, type };
  });
  const first = declared[0].name;
  return {
    version: "1",
    function: { name: "clamp", symbol: "clamp", params: declared, returns },
    requires: [],
    // It echoes its first argument, so that is what its result must equal, and
    // a postcondition is what earns it the harness that runs vectors.
    ensures: [`result == ${first}`],
    memory: { reads: [], writes: [], aliasing: [] },
    effects: [],
    numeric: { floatingPoint: "ieee754", rounding: "nearest", fastMath: false },
    optimize: { primary: "throughput" },
    definition: body([{ kind: "result", value: { k: "ident", name: first }, line: 1 }]),
  };
}

/**
 * Assembles a candidate that returns its first integer argument, links it
 * against the harness for a signature, and returns what the harness printed.
 * Throws when the harness does not build, which is itself the defect for a
 * name the harness already holds.
 */
async function harnessResult(params: string, vector: string, body = "movl\t%edi, %eax", returns = "i32"): Promise<string> {
  const directory = await scratch("blaze-harness-");
  const harness = join(directory, "harness.c");
  const assembly = join(directory, "clamp.s");
  const object = join(directory, "clamp.o");
  const binary = join(directory, "clamp");
  await writeFile(harness, generateHarness(echoContract(params, returns), `run\n${vector}`), "utf8");
  await writeFile(assembly, [".text", ".globl clamp", "clamp:", `\t${body}`, "\tret", ""].join("\n"), "utf8");
  assert.equal(run("as", ["--64", "-o", object, assembly]).code, 0, "as must assemble the candidate");
  const runtime = await buildStandaloneRuntime(directory);
  const linked = run("gcc", ["-O2", "-I", directory, "-o", binary, harness, object, runtime.objectPath]);
  assert.equal(linked.code, 0, `the harness must build:\n${linked.stderr}`);
  return run(binary, [], { input: `run\n${vector}` }).stdout;
}

test("a parameter named after the harness's own result still receives the vector", async () => {
  // The harness holds every argument in a file-scope static named after the
  // parameter, so a parameter called `value` used to be a second `value` in
  // `main` and the call read the local: the candidate was verified against an
  // indeterminate number and the build reported a correct one as broken.
  assert.equal(await harnessResult("value: i32", "5 1 9\n"), "RESULT 5\n");
});

test("a parameter named after the harness's own machinery still builds", async () => {
  // Each of these is a name the prelude or `main` already holds, so writing
  // the parameter down under it was a redeclaration or a shadowed assignment,
  // and the harness did not compile.
  for (const params of ["cursor: i32", "input: i32", "input_line: i32", "mode: i32", "fail: i32", "read_header: i32", "token: i32"]) {
    assert.equal(await harnessResult(params, "5\n"), "RESULT 5\n", `parameter ${params}`);
  }
});

test("a parameter named after a C keyword or a header typedef still builds", async () => {
  // The contract only requires a parameter to be a legal C identifier, so
  // `int`, `restrict` and `size_t` all reach the harness as themselves.
  for (const params of ["int: i32", "restrict: i32, static: i32", "size_t: i32", "bool: i32"]) {
    assert.equal(await harnessResult(params, "5 7\n"), "RESULT 5\n", `parameter ${params}`);
  }
});

test("a parameter named after a sibling's argument storage still receives its elements", async () => {
  // A buffer is read into `count_<name>`/`storage_<name>` beside the static
  // `<name>`, so a parameter called `count_buffer` claims the counter of a
  // `buffer` beside it unless the sibling moves out of the way.
  const vector = "7 9 3\n1 2 3\n";
  assert.equal(
    await harnessResult("count_buffer: i32, storage_buffer: i32, buffer: ptr<i32>", vector, "movl\t(%rdx), %eax"),
    "RESULT 1\n",
  );
});

test("a signature wider than the argument registers still builds a harness", async () => {
  // The harness is C and the C compiler places the arguments, so a ninth one
  // goes on the stack. Asking for a register for each argument refused a
  // contract whose harness was about to be written perfectly well.
  const names = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
  assert.equal(
    await harnessResult(names.map((name) => `${name}: f64`).join(", "), "5 1 2 3 4 5 6 7 8\n", "movsd %xmm0, %xmm0", "f64"),
    "RESULT 5\n",
  );
});

test("a parameter that collides with nothing keeps the name the source gave it", () => {
  const harness = generateHarness(echoContract("low: i32, high: i32"), "run\n5 1 9\n");
  assert.match(harness, /extern int32_t clamp\(int32_t low, int32_t high\);/);
  assert.match(harness, /^static int32_t low;$/m);
});


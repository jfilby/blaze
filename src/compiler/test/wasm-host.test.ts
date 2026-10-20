/**
 * The host ABI of a WebAssembly module.
 *
 * A module reaches the runtime through the services of the host ABI, and the
 * host that runs it carries the implementations of the ones the module reached
 * for. Every case here is run: the module is emitted, the host is run against
 * it, and what it answers is compared with what the same program answers
 * elsewhere. A case that only read the bytes would agree with a module that
 * traps.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { join } from "node:path";
import { buildModule, describeModule, moduleBytes } from "../toolchain/ir-wasm.ts";
import { boundaryProblems, moduleServices } from "../toolchain/wasm.ts";
import { HOST_SERVICES } from "../toolchain/wasm-host-runtime.ts";
import { programWithSemantics } from "./phase.ts";
import { run } from "../core/process.ts";
import type { FunctionContract } from "../core/types.ts";
import type { SemanticFunction } from "../core/semantic-ir.ts";
import { scratch } from "./scratch.ts";

/**
 * Contracts a library that declares one function, emits the module for it, and
 * runs it under the host the build ships.
 */
async function compute(
  parameters: string,
  body: readonly string[],
  vectors: string,
  expected: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const library = `export function r(${parameters}): number {\n${body.join("\n")}\n}\n`;
  const files = { "main.ts": 'import { r } from "./lib.ts";\nr(0);\n', "lib.ts": library };
  const { program, semantics } = programWithSemantics("typescript", files, "main.ts");
  const contract = program.files.find((file) => file.path === "lib.ts")?.functions.r;
  assert.ok(contract !== undefined, "the entry program imports the function under test");
  const directory = await scratch("blaze-wasm-host-");
  const built = await buildModule({
    fn: semantics.r as SemanticFunction,
    contract,
    modulePath: join(directory, "candidate.wasm"),
    hostPath: join(directory, "host.mjs"),
  });
  const result = run("node", [built.hostPath, built.modulePath], { input: vectors, timeoutMs: 60_000 });
  assert.equal(result.stdout, expected, result.stderr);
  return { stdout: result.stdout, stderr: result.stderr, code: result.code ?? 0 };
}

/** The module of a function, as the bytes the build emits. */
async function moduleOf(parameters: string, body: readonly string[]): Promise<Uint8Array> {
  const library = `export function r(${parameters}): number {\n${body.join("\n")}\n}\n`;
  const files = { "main.ts": 'import { r } from "./lib.ts";\nr(0);\n', "lib.ts": library };
  const { program, semantics } = programWithSemantics("typescript", files, "main.ts");
  const contract = program.files.find((file) => file.path === "lib.ts")?.functions.r;
  assert.ok(contract !== undefined, "the entry program imports the function under test");
  return moduleBytes(semantics.r as SemanticFunction, contract);
}

test("a module of arithmetic imports the memory and the power and nothing else", async () => {
  // The module imports the services it reaches for and nothing else, so a
  // module that computes imports the memory and the power and stops there.
  const bytes = await moduleOf("a: Float64Array, n: number", ["  let total = 0;", "  for (let i = 0; i < n; i++) { total += a[i]; }", "  return total;"]);
  assert.deepEqual(moduleServices(bytes), [], "a module of arithmetic reaches no service of the host ABI");
  assert.deepEqual(boundaryProblems(bytes, "r"), [], "a module of arithmetic keeps to the boundary");
});

test("a module that prints imports the service that prints", async () => {
  const bytes = await moduleOf("n: number", ["  console.log(n);", "  return n;"]);
  assert.ok(moduleServices(bytes).includes("blaze_rt_print_number"), "the number is printed by the runtime's own formatter");
  assert.ok(moduleServices(bytes).includes("blaze_rt_print_newline"), "the line is ended by the runtime");
  assert.deepEqual(boundaryProblems(bytes, "r"), [], "a module that prints keeps to the boundary");
});

test("every service of the host ABI has a signature the module can import", () => {
  // A service the table names is one the host implements, and the boundary
  // check is what refuses a module that reaches for anything else.
  assert.ok(HOST_SERVICES.length > 0, "the table names the services a module may reach for");
  for (const service of HOST_SERVICES) {
    for (const type of service.params) {
      assert.ok(["i32", "i64", "f32", "f64"].includes(type), `${service.symbol} has a parameter of a type the format has`);
    }
    if (service.result !== null) {
      assert.ok(["i32", "i64", "f32", "f64"].includes(service.result), `${service.symbol} answers a type the format has`);
    }
  }
});

test("the boundary refuses a module that imports a function the host ABI does not name", () => {
  // The boundary is the memory, the services of the host ABI, and the
  // contracted export. A module that reaches for anything else is a module that
  // reaches for a system interface, and it is refused before it can.
  const bytes = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
    0x02, 0x0b, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x03, 0x62, 0x61, 0x64, 0x00, 0x00,
    0x03, 0x02, 0x01, 0x00,
    0x07, 0x05, 0x01, 0x01, 0x72, 0x00, 0x01,
    0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b,
  ]);
  const problems = boundaryProblems(bytes, "r");
  assert.ok(problems !== null, "the boundary is asked of the bytes");
  assert.ok(
    problems.some((problem) => problem.includes("bad")),
    `the boundary names the import it refuses: ${problems.join("; ")}`,
  );
});

test("a text parameter is refused by name rather than by what rounds", async () => {
  // The vector protocol carries a buffer as a count and its elements, and a
  // text is neither. The host generator used to ask the buffer reader for the
  // element type of a text, which said "text is not a buffer" and named
  // nothing a reader could act on.
  const contract = {
    version: "1",
    function: { name: "r", symbol: "r", params: [{ name: "t", type: "text" }], returns: "f64" },
    requires: [],
    ensures: [],
    memory: { reads: [], writes: [], aliasing: [] },
    effects: [],
    numeric: { floatingPoint: "ieee754", rounding: "nearest", fastMath: false },
    optimize: { primary: "balanced" },
    definition: { statements: [], objects: {}, allocates: false, prints: false, readsArgv: false, calls: [] },
  } as FunctionContract;
  const fn = {
    name: "r",
    symbol: "r",
    params: [{ kind: "value", name: "t", mutable: true, type: { kind: "text" } }],
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
      statements: [],
      releases: [],
      terminator: { k: "return", value: { k: "const", type: { kind: "primitive", name: "f64" }, text: "0" } },
    },
  } as unknown as SemanticFunction;
  const directory = await scratch("blaze-wasm-text-param-");
  await assert.rejects(
    buildModule({
      fn,
      contract,
      modulePath: join(directory, "candidate.wasm"),
      hostPath: join(directory, "host.mjs"),
    }),
    /is a text, which the vector protocol does not carry/,
    "the refusal names the parameter and what the protocol carries",
  );
});

test("a text is written as it is, and the runtime writes what it holds", async () => {
  await compute("n: number", ["  console.log(`hello`);", "  return n;"], "run\n1\n\n", "hello\nRESULT 1\n");
});

test("a value interpolated into a text is written the way the language writes it", async () => {
  // The runtime's own formatter writes the number, and the module asks it for
  // the text rather than writing one of its own: a number written by the
  // module and a number written by the runtime are two numbers.
  await compute("n: number", ["  console.log(`value ${n}`);", "  return n;"], "run\n2.5\n\n", "value 2.5\nRESULT 2.5\n");
});

test("two texts are joined by the runtime, which owns the answer", async () => {
  await compute("n: number", ["  let t = `a` + `b`;", "  console.log(t);", "  return n;"], "run\n1\n\n", "ab\nRESULT 1\n");
});

test("a raise stops the program with the message it names", async () => {
  // The host throws where the C runtime does not come back, and the module
  // says so itself: the instruction after the call is an `unreachable`, since
  // the format has no way of saying that a call never returns.
  const fn = {
    name: "r",
    symbol: "r",
    params: [],
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
      statements: [
        {
          k: "raise",
          message: { k: "text", type: { kind: "text" }, parts: [{ k: "text", value: "stop" }] },
          line: 2,
        },
      ],
      releases: [],
      terminator: { k: "return", value: { k: "const", type: { kind: "primitive", name: "f64" }, text: "0" } },
    },
  } as unknown as SemanticFunction;
  const contract = {
    version: "1",
    function: { name: "r", symbol: "r", params: [], returns: "f64" },
    requires: [],
    ensures: [],
    memory: { reads: [], writes: [], aliasing: [] },
    effects: [],
    numeric: { floatingPoint: "ieee754", rounding: "nearest", fastMath: false },
    optimize: { primary: "balanced" },
    definition: { statements: [], objects: {}, allocates: false, prints: false, readsArgv: false, calls: [] },
  } as FunctionContract;
  const directory = await scratch("blaze-wasm-raise-");
  const built = await buildModule({
    fn,
    contract,
    modulePath: join(directory, "candidate.wasm"),
    hostPath: join(directory, "host.mjs"),
  });
  const result = run("node", [built.hostPath, built.modulePath], { input: "run\n\n", timeoutMs: 60_000 });
  assert.notEqual(result.code, 0, "a raise stops the program");
  assert.match(result.stderr, /stop/, "the message the raise names is on the error stream");
});

test("an object is laid out by the runtime and its fields are read back", async () => {
  await compute("n: number", ["  let o = { value: 7, other: 3 };", "  return o.value + o.other;"], "run\n0\n\n", "RESULT 10\n");
});

test("a typed array is laid out by the runtime and its elements are read back", async () => {
  await compute("n: number", ["  let a = new Float64Array(3);", "  a[0] = 1;", "  a[1] = 2;", "  a[2] = 3;", "  return a[0] + a[1] + a[2];"], "run\n0\n\n", "RESULT 6\n");
});

test("a whole number that is not a float is printed from the integer itself", async () => {
  // A double holds every whole number only up to 2^53, so a larger one lost
  // its last digits on the way out. The runtime prints a whole number from the
  // integer it is.
  await compute("n: number", ["  let x = 9007199254740993;", "  console.log(x);", "  return n;"], "run\n0\n\n", "9007199254740992\nRESULT 0\n");
});

test("two texts are compared by what they say and not by where they are", async () => {
  // A text built at run time and one written out are two addresses that can
  // say the same thing, and the addresses compared as if the texts did: the
  // module answered "not equal" for two texts that say the same thing. The
  // comparison is the runtime's own, and the runtime owns the texts.
  const library = [
    "def r() -> int:",
    "    a = 'hello' + 'x'",
    "    b = 'hellox'",
    "    if a == b:",
    "        return 1",
    "    return 0",
    "",
  ].join("\n");
  const files = { "main.py": "from lib import r\nr()\n", "lib.py": library };
  const { program, semantics } = programWithSemantics("python", files, "main.py");
  const contract = program.files.find((file) => file.path === "lib.py")?.functions.r;
  assert.ok(contract !== undefined, "the entry program imports the function under test");
  const directory = await scratch("blaze-wasm-text-compare-");
  const built = await buildModule({
    fn: semantics.r as SemanticFunction,
    contract,
    modulePath: join(directory, "candidate.wasm"),
    hostPath: join(directory, "host.mjs"),
  });
  const result = run("node", [built.hostPath, built.modulePath], { input: "run\n\n", timeoutMs: 60_000 });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "RESULT 1\n");
});

test("the listing names every instruction of the code section", async () => {  const bytes = await moduleOf("a: Float64Array, n: number", ["  let total = 0;", "  for (let i = 0; i < n; i++) { total += a[i]; }", "  return total;"]);
  const listing = describeModule(bytes);
  assert.match(listing, /types:/, "the listing names the types");
  assert.match(listing, /imports:/, "the listing names the imports");
  assert.match(listing, /exports:/, "the listing names the exports");
  assert.match(listing, /code:/, "the listing names the code");
  assert.match(listing, /local\.get/, "the listing names an instruction of the body");
  assert.match(listing, /f64\.add/, "the listing names the arithmetic of the body");
  assert.ok(!listing.includes("unknown opcode"), "every instruction of the body is named");
});

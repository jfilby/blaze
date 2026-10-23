/**
 * The dynamic values of a WebAssembly module.
 *
 * A dynamic value is the runtime's own representation, carried in a handle,
 * and the runtime is the host: a module reaches it through the services of the
 * host ABI. Every case here is run: the module is emitted, the host the build
 * ships runs it, and what it answers is what the runtime answers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { join } from "node:path";
import { buildModule } from "../toolchain/ir-wasm.ts";
import { run } from "../core/process.ts";
import type { FunctionContract } from "../core/types.ts";
import type { SemanticCall, SemanticFunction, SemanticStatement, SemanticType, SemanticValue, TextType } from "../core/semantic-ir.ts";
import { scratch } from "./scratch.ts";

const F64: SemanticType = { kind: "primitive", name: "f64" };
const USIZE: SemanticType = { kind: "primitive", name: "usize" };
const DYNAMIC: SemanticType = { kind: "ref", of: null };
const TEXT: TextType = { kind: "text" };

/** A call of a builtin, which is the compiler's own and not a function of the program. */
function builtin(callee: string, type: SemanticType, args: SemanticValue[], argTypes: SemanticType[]): SemanticValue {
  const signature = {
    name: callee,
    symbol: callee,
    params: argTypes.map((_, index) => ({ name: `argument${index}`, type: "f64" })),
    returns: "f64",
  };
  const call: SemanticCall = {
    callee,
    signature,
    args,
    argTypes,
    returns: type,
    effects: [],
    ownership: "owned",
    retain: false,
    builtin: true,
  };
  return { k: "call", type, call };
}

/** A text the source wrote out. */
function literal(text: string): SemanticValue {
  return { k: "text", type: TEXT, parts: [{ k: "text", value: text }] };
}

/** A number the source wrote out. */
function number(text: string, type: SemanticType = F64): SemanticValue {
  return { k: "const", type, text };
}

/** A name the body holds. */
function local(name: string, type: SemanticType): SemanticValue {
  return { k: "local", type, name };
}

/** The contract of a function of no arguments that answers a number. */
function contract(): FunctionContract {
  return {
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
}

/**
 * Emits the module of a body and runs it under the host the build ships.
 *
 * The answer is what the module wrote on the output and what it returned, so a
 * case can ask of either.
 */
async function compute(statements: SemanticStatement[], answer?: SemanticValue): Promise<{ stdout: string; result: string }> {
  const fn: SemanticFunction = {
    name: "r",
    symbol: "r",
    params: [],
    returns: F64,
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
      statements,
      releases: [],
      terminator: { k: "return", value: answer ?? number("0") },
    },
  } as unknown as SemanticFunction;
  const directory = await scratch("blaze-wasm-dynamic-");
  const built = await buildModule({
    fn,
    contract: contract(),
    modulePath: join(directory, "candidate.wasm"),
    hostPath: join(directory, "host.mjs"),
  });
  const result = run("node", [built.hostPath, built.modulePath], { input: "run\n\n", timeoutMs: 60_000 });
  assert.equal(result.code, 0, result.stderr);
  // The host writes what the module printed and then the answer the module
  // returned, on one line of their own.
  const at = result.stdout.lastIndexOf("RESULT ");
  assert.ok(at >= 0, `the module answers a number: ${result.stdout}`);
  return {
    stdout: result.stdout.slice(0, at),
    result: result.stdout.slice(at + "RESULT ".length).split("\n")[0] ?? "",
  };
}

test("a dynamic array is made, pushed to and read back", async () => {
  // A dynamic array is the runtime's own representation, and the runtime is the
  // host: the array is made by a call of the service that makes it, and the
  // elements are pushed by the service that pushes them.
  const made = builtin("array.new", DYNAMIC, [], []);
  const first = builtin("array.push", DYNAMIC, [local("a", DYNAMIC), number("7")], [DYNAMIC, F64]);
  const second = builtin("array.push", DYNAMIC, [local("a", DYNAMIC), number("8")], [DYNAMIC, F64]);
  const read = builtin("array.get", F64, [local("a", DYNAMIC), number("0", USIZE)], [DYNAMIC, USIZE]);
  const { result } = await compute(
    [
      { k: "let", slot: { kind: "value", name: "a", mutable: true, type: DYNAMIC }, value: made, line: 1 },
      { k: "set", name: "a", op: "=", value: first, line: 2 },
      { k: "set", name: "a", op: "=", value: second, line: 3 },
    ],
    read,
  );
  assert.equal(result, "7", "the element the array holds is the one that was pushed to it");
});

test("a dynamic array answers how many elements it holds", async () => {
  const made = builtin("array.new", DYNAMIC, [], []);
  const first = builtin("array.push", DYNAMIC, [local("a", DYNAMIC), number("7")], [DYNAMIC, F64]);
  const second = builtin("array.push", DYNAMIC, [local("a", DYNAMIC), number("8")], [DYNAMIC, F64]);
  const count = builtin("array.length", F64, [local("a", DYNAMIC)], [DYNAMIC]);
  const { result } = await compute(
    [
      { k: "let", slot: { kind: "value", name: "a", mutable: true, type: DYNAMIC }, value: made, line: 1 },
      { k: "set", name: "a", op: "=", value: first, line: 2 },
      { k: "set", name: "a", op: "=", value: second, line: 3 },
    ],
    count,
  );
  assert.equal(result, "2", "the count is the number of elements that were pushed to it");
});

test("a JSON is parsed and written back as the runtime writes it", async () => {
  // The JSON is the runtime's own: it is parsed by the runtime's parser and
  // written by the runtime's writer, and the module asks it for both.
  const parsed = builtin("JSON.parse", DYNAMIC, [literal('{"a":1}')], [DYNAMIC]);
  const written = builtin("JSON.stringify", DYNAMIC, [local("v", DYNAMIC)], [DYNAMIC]);
  const { stdout } = await compute([
    { k: "let", slot: { kind: "value", name: "v", mutable: true, type: DYNAMIC }, value: parsed, line: 1 },
    { k: "printText", value: { k: "toText", type: TEXT, of: written, digits: null }, line: 2 },
  ]);
  assert.equal(stdout, '{"a":1}', "the JSON is written the way the runtime writes it");
});

test("a hasher answers the digest of what it was fed", async () => {
  // The hasher is the runtime's own, and the digest is the one the runtime
  // writes: the MD5 of what was fed to it.
  const made = builtin("crypto.createHash", DYNAMIC, [], []);
  const fed = builtin("hasher.update", DYNAMIC, [local("h", DYNAMIC), literal("abc")], [DYNAMIC, DYNAMIC]);
  const digest = builtin("hasher.update.digest", DYNAMIC, [local("h", DYNAMIC)], [DYNAMIC]);
  const { stdout } = await compute([
    { k: "let", slot: { kind: "value", name: "h", mutable: true, type: DYNAMIC }, value: made, line: 1 },
    { k: "set", name: "h", op: "=", value: fed, line: 2 },
    { k: "printText", value: { k: "toText", type: TEXT, of: digest, digits: null }, line: 3 },
  ]);
  assert.equal(stdout, "900150983cd24fb0d6963f7d28e17f72", "the digest is the one the runtime writes");
});

test("a file is read by the runtime and written as it holds it", async () => {
  // The file is the host's own: the runtime reads it and the module writes what
  // it read.
  const directory = await scratch("blaze-wasm-file-");
  const path = join(directory, "readme.txt");
  await (await import("node:fs/promises")).writeFile(path, "the file holds this\n", "utf8");
  const read = builtin("fs.readFileSync", DYNAMIC, [literal(path), literal("utf8")], [DYNAMIC, DYNAMIC]);
  const { stdout } = await compute([
    { k: "let", slot: { kind: "value", name: "f", mutable: true, type: DYNAMIC }, value: read, line: 1 },
    { k: "printText", value: { k: "toText", type: TEXT, of: local("f", DYNAMIC), digits: null }, line: 2 },
  ]);
  assert.equal(stdout, "the file holds this\n", "the file is written as the runtime read it");
});

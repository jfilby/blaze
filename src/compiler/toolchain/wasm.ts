/**
 * WebAssembly implementations.
 *
 * A `wasm` build asks the model for WebAssembly text. The compiler assembles it
 * with `wat2wasm` (wabt), then validates the module: it may import nothing but
 * the linear memory the host provides, and it must export the contracted
 * function. The host below is compiler code; it speaks the same vector
 * protocol as the native harness, so verification and benchmarking are shared.
 *
 * ABI: the exported function takes the contract's arguments in order, with
 * pointers as byte offsets into the imported linear memory, small integers as
 * i32 and f32/f64 unchanged.
 */

import { stat, writeFile } from "node:fs/promises";
import { bufferElement, parseType, symbolOf, typeToString } from "../semantics/contract.ts";
import { CompilerError } from "../core/errors.ts";
import { run } from "../core/process.ts";
import type { FunctionContract, Runner, TypeExpr } from "../core/types.ts";

/** WebAssembly value types of the contract types, keyed by contract type. */
const WASM_TYPES: Record<string, string> = {
  bool: "i32",
  i8: "i32",
  i16: "i32",
  i32: "i32",
  i64: "i64",
  u8: "i32",
  u16: "i32",
  u32: "i32",
  u64: "i64",
  f32: "f32",
  f64: "f64",
  usize: "i32",
  isize: "i32",
};

function wasmError(message: string, detail?: string, functionName?: string, candidate?: string): CompilerError {
  return new CompilerError({
    category: "AssemblyError",
    stage: "assemble",
    message,
    function: functionName,
    candidate,
    detail,
  });
}

/**
 * WebAssembly value type of a contract type. A buffer is a byte offset into
 * the module's linear memory, so it is an i32.
 */
export function wasmValueType(type: TypeExpr): string {
  if (type.kind !== "primitive") return "i32";
  const mapped = WASM_TYPES[type.name];
  if (mapped === undefined) {
    throw wasmError(`type ${typeToString(type)} has no WebAssembly value type`);
  }
  return mapped;
}

/** The exported signature the candidate must implement. */
export function wasmSignature(contract: FunctionContract): string {
  const result = wasmValueType(parseType(contract.function.returns));
  const parameters = contract.function.params.map((param) => wasmValueType(parseType(param.type)));
  const signature = parameters.length === 0 ? `(result ${result})` : `(param ${parameters.join(" ")}) (result ${result})`;
  return `(func ${signature})`;
}

export interface WasmBuildRequest {
  text: string;
  contract: FunctionContract;
  textPath: string;
  modulePath: string;
  hostPath: string;
  candidate?: string;
}

export interface WasmBuildResult {
  runner: Runner;
  modulePath: string;
  hostPath: string;
  moduleSizeBytes: number;
}

/**
 * Assembles WebAssembly text and checks the module boundary. The host provides
 * the memory, so a module that imports anything else is rejected before it can
 * reach a system interface.
 */
export async function buildWasm(request: WasmBuildRequest): Promise<WasmBuildResult> {
  // The prompt names the export as the symbol, so the module boundary is
  // checked against the symbol: a candidate that follows the prompt is the
  // one that gets through.
  const functionName = symbolOf(request.contract);
  if (request.text.trim() === "") {
    throw wasmError("the candidate contains no WebAssembly", undefined, functionName, request.candidate);
  }
  await writeFile(request.textPath, request.text, "utf8");

  const assembled = run("wat2wasm", ["--no-check", request.textPath, "-o", request.modulePath], { timeoutMs: 60_000 });
  if (assembled.spawnError !== undefined) {
    throw new CompilerError({
      category: "TargetError",
      stage: "assemble",
      message: "a wasm build needs the WebAssembly text assembler wat2wasm",
      detail: "install wabt (https://github.com/WebAssembly/wabt) so that wat2wasm is on PATH",
    });
  }
  if (assembled.code !== 0) {
    throw wasmError(
      `the WebAssembly assembler rejected the candidate for ${functionName}`,
      `${request.textPath}\n${assembled.stderr.trim()}`,
      functionName,
      request.candidate,
    );
  }

  await writeFile(request.hostPath, generateWasmHost(request.contract), "utf8");

  const inspection = run(process.execPath, ["--input-type=module", "-e", INSPECT_MODULE, request.modulePath, functionName], {
    timeoutMs: 60_000,
  });
  if (inspection.code !== 0) {
    throw wasmError(
      `the WebAssembly module for ${functionName} violates the contract`,
      (inspection.stderr.trim() || inspection.stdout.trim()).slice(0, 2000),
      functionName,
      request.candidate,
    );
  }

  return {
    runner: { command: process.execPath, args: [request.hostPath, request.modulePath] },
    modulePath: request.modulePath,
    hostPath: request.hostPath,
    moduleSizeBytes: (await stat(request.modulePath)).size,
  };
}

/** Rejects a module that reaches outside the memory the host provides. */
const INSPECT_MODULE = `
import { readFileSync } from "node:fs";
const [path, expected] = process.argv.slice(1);
const bytes = readFileSync(path);
if (!WebAssembly.validate(bytes)) {
  process.stderr.write("the module is not valid WebAssembly\\n");
  process.exit(1);
}
const module = new WebAssembly.Module(bytes);
const problems = [];
const imports = WebAssembly.Module.imports(module);
const memoryImports = imports.filter((entry) => entry.kind === "memory");
if (imports.length !== 1 || memoryImports.length !== 1 || memoryImports[0].module !== "env" || memoryImports[0].name !== "memory") {
  problems.push('the module must import exactly one memory: (import "env" "memory" ...)');
}
if (imports.some((entry) => entry.kind !== "memory")) {
  problems.push("the module must not import functions, tables or globals");
}
const exports = WebAssembly.Module.exports(module).map((entry) => entry.name);
if (exports.includes("memory") || exports.includes("_start")) {
  problems.push("the module must not export memory or _start; the host provides both");
}
if (!exports.includes(expected)) {
  problems.push('the module must export the contracted function "' + expected + '"');
}
if (problems.length > 0) {
  process.stderr.write(problems.join("\\n") + "\\n");
  process.exit(1);
}
`;

function elementSize(type: TypeExpr): number {
  return wasmValueType(type) === "i64" || wasmValueType(type) === "f64" ? 8 : 4;
}

/**
 * The host: reads the vector protocol on stdin, places buffers in the module's
 * linear memory, calls the contracted function and prints results in the same
 * format as the native harness.
 */
export function generateWasmHost(contract: FunctionContract): string {
  const functionName = symbolOf(contract);
  const returns = parseType(contract.function.returns);
  if (returns.kind !== "primitive") {
    throw wasmError(`return type ${typeToString(returns)} is not supported for wasm`, undefined, functionName);
  }


  const headerReads = contract.function.params
    .map((param, index) => {
      const type = parseType(param.type);
      if (type.kind === "primitive") {
        return `  const ${param.name} = ${scalarRead(type, `header[${index}]`)};`;
      }
      return [
        `  let ${param.name} = 0;`,
        `  let count_${param.name} = 0;`,
        `  let storage_${param.name} = 0;`,
        `  {`,
        `    const declared = Number.parseInt(header[${index}], 10);`,
        `    count_${param.name} = declared < 0 ? 0 : declared;`,
        `  }`,
      ].join("\n");
    })
    .join("\n");

  const dataReads = contract.function.params
    .map((param) => {
      const type = parseType(param.type);
      if (type.kind === "primitive") return "";
      const size = elementSize(bufferElement(type));
      return `  if (count_${param.name} !== 0) {
    const elements = nextTokens();
    if (elements === null || elements.length < count_${param.name}) fail("truncated data for ${param.name}");
    storage_${param.name} = allocate(count_${param.name} * ${size});
    ${param.name} = storage_${param.name};
    for (let element = 0; element < count_${param.name}; element += 1) {
      ${scalarStore(bufferElement(type), `elements[element]`, `storage_${param.name} + element * ${size}`)}
    }
  }`;
    })
    .join("\n");

  const callArguments = contract.function.params.map((param) => param.name).join(", ");
  const resultFormat =
    wasmValueType(returns) === "f32"
      ? "String(value)"
      : 'typeof value === "bigint" ? value.toString() : String(value)';

  return `/* Generated by the blaze compiler from a function contract. Do not edit. */
import { readFileSync } from "node:fs";

const [modulePath] = process.argv.slice(2);
const functionName = ${JSON.stringify(functionName)};
const PAGE = 65536;

function fail(message) {
  process.stderr.write("wasm-host: " + message + "\\n");
  process.exit(2);
}

const module = new WebAssembly.Module(readFileSync(modulePath));
const memory = new WebAssembly.Memory({ initial: 4 });
const instance = new WebAssembly.Instance(module, { env: { memory } });
const entry = instance.exports[functionName];
if (typeof entry !== "function") fail("the module does not export " + functionName);

let breakOffset = 1024;
let sink = 0;

function allocate(bytes) {
  const offset = breakOffset;
  const end = offset + bytes;
  if (end > memory.buffer.byteLength) {
    memory.grow(Math.ceil((end - memory.buffer.byteLength) / PAGE) + 1);
  }
  breakOffset = (end + 15) & ~15;
  return offset;
}

function view() {
  return new DataView(memory.buffer);
}

const lines = readFileSync(0, "utf8").split("\\n");
// A line is what the native harness reads with getline: the text before a
// newline, so the empty text after the last one is not a line of its own.
if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
let cursor = 0;
function nextTokens() {
  while (cursor < lines.length) {
    const line = lines[cursor++].trim();
    if (line !== "") return line.split(/\\s+/);
  }
  return null;
}

/* The header of the next vector, blank line and all: a vector of a function
   that takes nothing is an empty line, and skipping it would eat the vectors
   after it. Only a line with arguments on it to read is one to skip. */
function nextHeader() {
  if (cursor >= lines.length) return null;
  const line = lines[cursor++].trim();
  return line === "" ? [] : line.split(/\\s+/);
}

const first = nextTokens();
if (first === null) fail("empty input");
const mode = first[0];
let iterations = 1;
if (mode === "bench") {
  iterations = Number.parseInt(first[1], 10);
  if (!Number.isInteger(iterations) || iterations <= 0) fail("bench requires a positive iteration count");
} else if (mode !== "run") {
  fail("expected mode run or bench");
}

let calls = 0;
for (;;) {
  const header = ${contract.function.params.length === 0 ? "nextHeader()" : "nextTokens()"};
  if (header === null) break;
  if (header.length < ${contract.function.params.length}) fail("truncated test vector header");

${headerReads}
${dataReads}

  if (mode === "run") {
    const value = entry(${callArguments});
    process.stdout.write("RESULT " + (${resultFormat}) + "\\n");
    calls += 1;
    continue;
  }

  const start = process.hrtime.bigint();
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    sink += Number(entry(${callArguments}));
  }
  const elapsed = Number(process.hrtime.bigint() - start);
  process.stdout.write("BENCH " + elapsed + " " + sink + "\\n");
  calls += iterations;
  break;
}

if (calls === 0) fail("no test vectors");
`;
}

function scalarRead(type: TypeExpr, token: string): string {
  const wasmType = wasmValueType(type);
  if (wasmType === "f32") return `Math.fround(Number(${token}))`;
  if (wasmType === "f64") return `Number(${token})`;
  if (wasmType === "i64") return `BigInt(${token})`;
  return `Number(BigInt(${token}))`;
}

function scalarStore(type: TypeExpr, token: string, address: string): string {
  const wasmType = wasmValueType(type);
  if (wasmType === "f32") return `view().setFloat32(${address}, Math.fround(Number(${token})), true);`;
  if (wasmType === "f64") return `view().setFloat64(${address}, Number(${token}), true);`;
  if (wasmType === "i64") return `view().setBigInt64(${address}, BigInt(${token}), true);`;
  return `view().setInt32(${address}, Number(BigInt(${token})), true);`;
}

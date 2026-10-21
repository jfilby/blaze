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
 * pointers as byte offsets into the imported linear memory, 64-bit integers as
 * i64, every other integer as i32 and f32/f64 unchanged. A buffer is laid out
 * at the width of its element, so a `u8` buffer is one byte per element and
 * the module reads it at the offsets the contract gives.
 */

import { readFile, stat, writeFile } from "node:fs/promises";
import { bufferElement, isSignedIntegerType, parseType, symbolOf, typeToString } from "../semantics/contract.ts";
import { CompilerError } from "../core/errors.ts";
import { run } from "../core/process.ts";
import type { FunctionContract, PrimitiveTypeName, Runner, TypeExpr } from "../core/types.ts";
import {
  HOST_SERVICE_BY_SYMBOL,
  HOST_SERVICES,
  IMPLEMENTED_SERVICES,
  MEMORY_IMPORT,
  POW_IMPORT,
  hostRuntimeSource,
} from "./wasm-host-runtime.ts";

/** The bytes a reference takes in the memory the host provides: one pointer. */
const POINTER_SIZE = 8;

/**
 * The global a module exports to say where its own memory ends.
 *
 * The lowering lays its wide-number scratch and its pooled constants down at
 * fixed low addresses, and this host hands out memory for the vectors it reads
 * above them. Neither end can guess the other's size — the host would have to
 * read the data segment back out of the binary to learn it — so the module
 * publishes the first address above everything it owns and the host starts
 * there.
 */
export const DATA_BASE_EXPORT = "__blaze_data_base";

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
  usize: "i64",
  isize: "i64",
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

  // The boundary is asked of the assembled bytes here rather than of the
  // written file in a child process: `WebAssembly.Module` is the same reader
  // either way, and the child is still there for a build run whose process has
  // no WebAssembly of its own.
  const problems = boundaryProblems(await readFile(request.modulePath), functionName);
  const detail = problems === null ? await inspectInChild(request.modulePath, functionName) : problems;
  if (detail.length > 0) {
    throw wasmError(
      `the WebAssembly module for ${functionName} violates the contract`,
      detail.join("\n").slice(0, 2000),
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

/** Asks a child process the boundary questions this process has no engine for. */
async function inspectInChild(path: string, expected: string): Promise<string[]> {
  const inspection = run(process.execPath, ["--input-type=module", "-e", INSPECT_MODULE, path, expected], {
    timeoutMs: 60_000,
  });
  if (inspection.code === 0) return [];
  return (inspection.stderr.trim() || inspection.stdout.trim()).split("\n").filter((line) => line !== "");
}

/**
 * Reads the unsigned integer the format writes in `bits` at `at`.
 *
 * A length in the format is a LEB128, and a reader that reads one has to know
 * where it ended: the bytes of a section are counted from the start of the
 * section, so every length in it is read against the section's own bytes.
 */
export function readVaruint(bytes: Uint8Array, at: number, bits: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  for (let index = at; index < bytes.length && shift < bits; index += 1) {
    const byte = bytes[index] ?? 0;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, next: index + 1 };
    shift += 7;
  }
  throw new CompilerError({
    category: "TargetError",
    stage: "compile",
    message: "the module ends in the middle of a length",
    detail: "the bytes read back are not a module the compiler emitted",
  });
}

/** The bytes of one section, which is where its own lengths are counted from. */
export function bodyOf(bytes: Uint8Array, size: { value: number; next: number }): Uint8Array {
  return bytes.subarray(size.next, size.next + size.value);
}

/**
 * The services a module imports, by the names the host ABI knows them by.
 *
 * The host implements the services the module reached for and nothing else, so
 * the host is written from what the module asks for rather than from what the
 * table could offer.
 */
export function moduleServices(bytes: Uint8Array): string[] {
  const services: string[] = [];
  let at = 8;
  while (at < bytes.length) {
    const id = bytes[at] ?? 0;
    const size = readVaruint(bytes, at + 1, 32);
    if (id === 2) {
      const body = bodyOf(bytes, size);
      const count = readVaruint(body, 0, 32);
      let cursor = count.next;
      for (let index = 0; index < count.value && cursor < body.length; index += 1) {
        const module = readVaruint(body, cursor, 32);
        // The field's name is counted from after the module's own name, which
        // is the bytes the module's length states.
        const field = readVaruint(body, module.next + module.value, 32);
        const kind = body[field.next + field.value] ?? 0;
        const name = new TextDecoder().decode(bodyOf(body, field));
        cursor = field.next + field.value + 1;
        if (kind === 0x00) {
          const type = readVaruint(body, cursor, 32);
          cursor = type.next;
          if (name !== POW_IMPORT) services.push(name);
          continue;
        }
        if (kind === 0x02) {
          // A memory: the limits are a flag byte and a length.
          const flags = body[cursor] ?? 0;
          cursor += 1;
          const minimum = readVaruint(body, cursor, 32);
          cursor = minimum.next;
          if ((flags & 0x01) !== 0) cursor = readVaruint(body, cursor, 32).next;
          continue;
        }
        // A table or a global: neither is a service and neither is read here.
        break;
      }
    }
    at = size.next + size.value;
  }
  return services;
}

/**
 * What a module reaches for and offers that the boundary does not allow, as
 * one line each, and nothing where it keeps to it.
 *
 * The boundary is the host's linear memory, the services of the host ABI, and
 * the contracted export. The memory is the one the host provides, the services
 * are the ones the host implements, and nothing else is reachable: a module
 * that imports a function the table does not name is a module that reaches for
 * a system interface, and it is refused before it can.
 */
export function boundaryProblems(bytes: Uint8Array, expected?: string): string[] | null {
  const engine = engineHere();
  if (engine === null) return null;
  if (!engine.validate(bytes)) return ["the module is not valid WebAssembly"];
  const module = new engine.Module(bytes);
  const problems: string[] = [];
  const imports = engine.Module.imports(module);
  const memoryImports = imports.filter((entry) => entry.kind === "memory");
  if (memoryImports.length !== 1 || memoryImports[0]?.module !== "env" || memoryImports[0]?.name !== MEMORY_IMPORT) {
    problems.push(`the module must import one memory: (import "env" "${MEMORY_IMPORT}" ...)`);
  }
  for (const entry of imports) {
    if (entry.kind === "memory") continue;
    if (entry.kind !== "function") {
      problems.push(`the module must not import the ${entry.kind} "${entry.name}"; it reaches the host through the services of the host ABI`);
      continue;
    }
    if (entry.module !== "env") {
      problems.push(`the module must import its services from "env", not from "${entry.module}"`);
      continue;
    }
    if (entry.name === POW_IMPORT) continue;
    if (!HOST_SERVICE_BY_SYMBOL.has(entry.name)) {
      problems.push(`the module must not import "${entry.name}"; it is not a service of the host ABI`);
    }
  }
  const exports = engine.Module.exports(module).map((entry) => entry.name);
  if (exports.includes("memory") || exports.includes("_start")) {
    problems.push("the module must not export memory or _start; the host provides both");
  }
  if (expected !== undefined && !exports.includes(expected)) {
    problems.push(`the module must export the contracted function "${expected}"`);
  }
  return problems;
}

/**
 * The part of the engine the boundary check reads a module with. A build runs
 * under Node, so this is `globalThis.WebAssembly` itself where the runtime has
 * one; the question asked of it is whether it is there at all, not whether it
 * has this shape.
 */
interface Engine {
  validate(bytes: Uint8Array): boolean;
  Module: {
    new (bytes: Uint8Array): unknown;
    imports(module: unknown): { module: string; name: string; kind: string }[];
    exports(module: unknown): { name: string }[];
  };
}

/**
 * The engine this process has, or null where it has none.
 *
 * Where there is one the check above is the engine's own answer rather than a
 * second opinion. Where there is not, `null` says so and the caller asks the
 * child process instead.
 */
function engineHere(): Engine | null {
  const carrier = globalThis as { WebAssembly?: Engine };
  return carrier.WebAssembly ?? null;
}

/** Rejects a module that reaches outside the memory the host provides. */
export const INSPECT_MODULE = `
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
if (memoryImports.length !== 1 || memoryImports[0].module !== "env" || memoryImports[0].name !== "memory") {
  problems.push('the module must import exactly one memory: (import "env" "memory" ...)');
}
const services = ${JSON.stringify(HOST_SERVICES.map((service) => service.symbol))};
for (const entry of imports) {
  if (entry.kind === "memory") continue;
  if (entry.kind !== "function" || entry.module !== "env" || (entry.name !== "pow" && !services.includes(entry.name))) {
    problems.push('the module must not import "' + entry.name + '"; it is not a service of the host ABI');
  }
}
const exports = WebAssembly.Module.exports(module).map((entry) => entry.name);
if (exports.includes("memory") || exports.includes("_start")) {
  problems.push("the module must not export memory or _start; the host provides both");
}
if (expected !== "" && !exports.includes(expected)) {
  problems.push('the module must export the contracted function "' + expected + '"');
}
if (problems.length > 0) {
  process.stderr.write(problems.join("\\n") + "\\n");
  process.exit(1);
}
`;

/**
 * The width of one element of a buffer, in bytes. A pointer the host hands a
 * module is a byte offset, so a module reads a buffer by the width of what
 * the buffer holds: laying every element out four bytes wide stored a `u8`
 * buffer as `1, 0, 0, 0, 2, 0, 0, 0` and the module read the wrong values.
 */
function elementSize(type: TypeExpr): number {
  if (type.kind !== "primitive") return POINTER_SIZE;
  switch (type.name) {
    case "bool":
    case "i8":
    case "u8":
      return 1;
    case "i16":
    case "u16":
      return 2;
    case "i32":
    case "u32":
    case "f32":
      return 4;
    default:
      return 8;
  }
}

/**
 * What the host the build generates has to carry for the module it runs.
 */
export interface WasmHostOptions {
  /**
   * The services the module imported, which are the ones the host implements.
   *
   * A service the module did not import is not implemented and not paid for:
   * the host is generated, so it carries the implementations of what the
   * module reaches for and nothing else.
   */
  readonly services?: readonly string[];
  /**
   * The style a value is written as text in, which is the language's own: one
   * language writes a whole number with a marker the other has no word for.
   */
  readonly style?: number;
}

/**
 * The host: reads the vector protocol on stdin, places buffers in the module's
 * linear memory, calls the contracted function and prints results in the same
 * format as the native harness.
 *
 * The host is also the runtime. A module reaches the runtime through the
 * services of the host ABI, and the implementations of the ones it imported
 * are carried here, in JavaScript, over the same linear memory the module
 * reads and writes.
 */
export function generateWasmHost(contract: FunctionContract, options: WasmHostOptions = {}): string {
  const functionName = symbolOf(contract);
  const returns = parseType(contract.function.returns);
  if (returns.kind !== "primitive") {
    throw wasmError(`return type ${typeToString(returns)} is not supported for wasm`, undefined, functionName);
  }
  const services = options.services ?? [];
  for (const service of services) {
    if (!HOST_SERVICE_BY_SYMBOL.has(service)) {
      throw wasmError(`"${service}" is not a service of the host ABI`, undefined, functionName);
    }
    if (!IMPLEMENTED_SERVICES.includes(service)) {
      throw wasmError(`the host carries no implementation of "${service}"`, undefined, functionName);
    }
  }
  const style = options.style ?? 0;

  const headerReads = contract.function.params
    .map((param, index) => {
      const type = parseType(param.type);
      if (type.kind === "primitive") {
        return `  const ${param.name} = ${scalarRead(type, `header[${index}]`)};`;
      }
      if (type.kind === "text") {
        // A text parameter is refused by name rather than by the buffer reader
        // it is not: the vector protocol carries a buffer as a count and its
        // elements, and a text is neither.
        throw wasmError(
          `the parameter "${param.name}" is a text, which the vector protocol does not carry`,
          "a wasm parameter is a number or a buffer; a text parameter is not built by the c, asm or machine output kinds either",
          functionName,
        );
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
      return `  {
    storage_${param.name} = block(count_${param.name} * ${size}, 16, true);
    // A module is handed a pointer to the elements and no length beside it, so
    // the count is written in the word the pointer sits one before: a module
    // reads a length as the count at (pointer - ${POINTER_SIZE}). The word is
    // written for an empty buffer too, or a module asked to walk one would
    // read a length from below the memory the host gave it.
    writeCount(storage_${param.name}, count_${param.name});
    ${param.name} = storage_${param.name};
  }
  if (count_${param.name} !== 0) {
    const elements = nextTokens();
    if (elements === null || elements.length < count_${param.name}) fail("truncated data for ${param.name}");
    for (let element = 0; element < count_${param.name}; element += 1) {
      ${scalarStore(bufferElement(type), `elements[element]`, `${param.name} + element * ${size}`)}
    }
  }`;
    })
    .join("\n");

  const callArguments = contract.function.params.map((param) => param.name).join(", ");
  // A WebAssembly i64 arrives as a JavaScript BigInt, which prints signed, so
  // an unsigned result came back as a negative number for every value from
  // 2^63 up. The native harness prints the same result with `%llu`, and the
  // two hosts have to agree: one of them is read back as the value the
  // contract promises.
  const returnsName: PrimitiveTypeName | null = returns.kind === "primitive" ? returns.name : null;
  const resultFormat =
    wasmValueType(returns) === "f32"
      ? "String(value)"
      : returnsName !== null && wasmValueType(returns) === "i64" && !isSignedIntegerType(returnsName)
        ? "BigInt.asUintN(64, value).toString()"
        : returnsName !== null && wasmValueType(returns) === "i32" && !isSignedIntegerType(returnsName)
          // An i32 arrives as a signed JavaScript number, so every `u32` from
          // 2^31 up came back negative. The native harness prints the same
          // result with `%llu`, and the two hosts have to agree.
          ? "String(value >>> 0)"
          : 'typeof value === "bigint" ? value.toString() : String(value)';

  const serviceImports = services.map((service) => `imports.env[${JSON.stringify(service)}] = ${service};`).join("\n");
  const hashes = services.some((service) => service.startsWith("blaze_rt_md5_"));

  return `/* Generated by the blaze compiler from a function contract. Do not edit. */
import { readFileSync } from "node:fs";
${hashes ? 'import { createHash } from "node:crypto";' : ""}

${hostRuntimeSource(services)}

const [modulePath] = process.argv.slice(2);
const functionName = ${JSON.stringify(functionName)};

function fail(message) {
  process.stderr.write("wasm-host: " + message + "\\n");
  process.exit(2);
}

memory = new WebAssembly.Memory({ initial: 4 });
textStyle = ${style};
const module = new WebAssembly.Module(readFileSync(modulePath));
const imports = { env: { memory, pow: Math.pow } };
${serviceImports}
const instance = new WebAssembly.Instance(module, imports);
const entry = instance.exports[functionName];
if (typeof entry !== "function") fail("the module does not export " + functionName);

// The first address above everything the module owns. The module lays its
// scratch and its pooled constants down at fixed low addresses and publishes
// where they end, so a vector handed out here never writes over a limb of a
// wide number in flight. A module that publishes nothing (an older one, or a
// hand-written candidate) is given a page of its own, which is past anything
// the lowering reserves.
const published = instance.exports[${JSON.stringify(DATA_BASE_EXPORT)}];
cursor = typeof published === "object" && published !== null && typeof published.value === "number"
  ? published.value
  : 65536;
let sink = 0;

/* A function build reads no arguments: the vectors the host reads on standard
   input carry what the function is called with, and the command line a module
   reads is the one the program it belongs to was given. */
setArguments([]);

const lines = readFileSync(0, "utf8").split("\\n");
// A line is what the native harness reads with getline: the text before a
// newline, so the empty text after the last one is not a line of its own.
if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
let line = 0;
function nextTokens() {
  while (line < lines.length) {
    const text = lines[line++].trim();
    if (text !== "") return text.split(/\\s+/);
  }
  return null;
}

/* The header of the next vector, blank line and all: a vector of a function
   that takes nothing is an empty line, and skipping it would eat the vectors
   after it. Only a line with arguments on it to read is one to skip. */
function nextHeader() {
  if (line >= lines.length) return null;
  const text = lines[line++].trim();
  return text === "" ? [] : text.split(/\\s+/);
}

/* The call itself. A raise is the runtime's own way of stopping a program and
   is not a fault, so it is caught here and reported the way the C runtime
   reports it: the message on the error stream and the exit code of a program
   that stopped. */
let argumentsOfCall = [];
function call() {
  try {
    return entry(...argumentsOfCall);
  } catch (error) {
    if (error instanceof BlazeError) {
      process.stderr.write("blaze: " + error.message + "\\n");
      process.exit(2);
    }
    throw error;
  }
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
  argumentsOfCall = [${callArguments}];

  if (mode === "run") {
    const value = call();
    process.stdout.write("RESULT " + (${resultFormat}) + "\\n");
    calls += 1;
    continue;
  }

  const start = process.hrtime.bigint();
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    sink += Number(call());
  }
  const elapsed = Number(process.hrtime.bigint() - start);
  process.stdout.write("BENCH " + elapsed + " " + sink + "\\n");
  calls += iterations;
  break;
}

if (calls === 0) fail("no test vectors");
`;
}

/**
 * The host of a program: it runs the entry of the module and lets the program
 * print.
 *
 * A program has no vectors: what it does is what it prints, and the driver the
 * C backend writes is the module's own entry. So the host here is the same
 * host the function build generates, without the vector protocol: it reads the
 * module, calls the entry, and the runtime's own printing says what the
 * program did.
 */
export interface WasmProgramHostOptions {
  /**
   * The services the module imported, which are the ones the host implements.
   *
   * A service the module did not import is not implemented and not paid for:
   * the host is generated, so it carries the implementations of what the
   * module reaches for and nothing else.
   */
  readonly services?: readonly string[];
  /** The style a value is written as text in, which is the language's own. */
  readonly style?: number;
  /** The name the module exports the entry of the program by. */
  readonly entry: string;
}

/**
 * The host that runs a program: the runtime the module reaches for, and the
 * call of the entry that runs the body of the program.
 *
 * The arguments the program reads are the ones the host was given, past the
 * host itself and the module it runs, which is where the driver of a native
 * program takes them from as well.
 */
export function generateWasmProgramHost(options: WasmProgramHostOptions): string {
  const services = options.services ?? [];
  for (const service of services) {
    if (!HOST_SERVICE_BY_SYMBOL.has(service)) {
      throw wasmError(`"${service}" is not a service of the host ABI`);
    }
    if (!IMPLEMENTED_SERVICES.includes(service)) {
      throw wasmError(`the host carries no implementation of "${service}"`);
    }
  }
  const style = options.style ?? 0;
  const serviceImports = services.map((service) => `imports.env[${JSON.stringify(service)}] = ${service};`).join("\n");
  const hashes = services.some((service) => service.startsWith("blaze_rt_md5_"));

  return `/* Generated by the blaze compiler from a program. Do not edit. */
import { readFileSync } from "node:fs";
${hashes ? 'import { createHash } from "node:crypto";' : ""}

${hostRuntimeSource(services)}

const [modulePath] = process.argv.slice(2);
const entryName = ${JSON.stringify(options.entry)};

function fail(message) {
  process.stderr.write("wasm-host: " + message + "\\n");
  process.exit(2);
}

memory = new WebAssembly.Memory({ initial: 4 });
textStyle = ${style};
const module = new WebAssembly.Module(readFileSync(modulePath));
const imports = { env: { memory, pow: Math.pow } };
${serviceImports}
const instance = new WebAssembly.Instance(module, imports);
const entry = instance.exports[entryName];
if (typeof entry !== "function") fail("the module does not export " + entryName);

/* The first address above everything the module owns. The module lays its
   scratch and its pooled constants down at fixed low addresses and publishes
   where they end, so a value the runtime hands out here never writes over a
   limb of a wide number in flight. */
const published = instance.exports[${JSON.stringify(DATA_BASE_EXPORT)}];
cursor = typeof published === "object" && published !== null && typeof published.value === "number"
  ? published.value
  : 65536;

/* The arguments the program was given: the ones the host was started with,
   past the host itself and the module it runs. */
setArguments(process.argv.slice(3));

/* The call itself. A raise is the runtime's own way of stopping a program and
   is not a fault, so it is caught here and reported the way the C runtime
   reports it: the message on the error stream and the exit code of a program
   that stopped. */
try {
  entry();
} catch (error) {
  if (error instanceof BlazeError) {
    process.stderr.write("blaze: " + error.message + "\\n");
    process.exit(2);
  }
  throw error;
}
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
  // The element is written at its own width: writing a `u8` element as a
  // four byte word overwrote the three elements after it.
  switch (elementSize(type)) {
    case 1:
      return `view().setUint8(${address}, Number(BigInt(${token})));`;
    case 2:
      return `view().setUint16(${address}, Number(BigInt(${token})), true);`;
    default:
      return `view().setInt32(${address}, Number(BigInt(${token})), true);`;
  }
}

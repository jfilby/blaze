/**
 * The host ABI of a WebAssembly module.
 *
 * A module reaches the runtime through imports: the host provides the linear
 * memory the module reads and writes, and one function per service the module
 * uses. The table below is the runtime ABI (`runtime/abi.ts`) with the C types
 * replaced by the WebAssembly ones, so the mapping from one to the other is one
 * to one and the spelling of a call carries over unchanged:
 *
 * - a pointer is an `i32` offset into the shared memory;
 * - a `size_t` and a `long long` are an `i64`;
 * - an `int` is an `i32`;
 * - a `double` is an `f64`.
 *
 * The runtime here is the host's own: the generated `.mjs` that runs a module
 * carries the implementations of the services the module imports, and the
 * managed representation is the one the C runtime uses — a forty-eight byte
 * header in front of the payload, a reference count in it, and the payload at
 * the address the header names. A value the module holds and a value the host
 * holds are therefore the same kind of thing.
 *
 * The wide arithmetic is not a service of the runtime ABI but of the kernel
 * beside it, and it is here for the same reason: a module has no instruction
 * that carries a two hundred and fifty six bit number, so it calls the kernel
 * the other two backends call.
 */

import { RUNTIME_ABI } from "../runtime/abi.ts";

/** One service of the host ABI: the name a module imports it under, and its signature. */
export interface HostService {
  /** The name the module imports the service under, which is the runtime's own. */
  readonly symbol: string;
  /** The WebAssembly types of the parameters, in order. */
  readonly params: readonly string[];
  /** The WebAssembly type of the answer, or null where the service answers nothing. */
  readonly result: string | null;
  /** True when the call never comes back to the module that made it. */
  readonly noreturn?: boolean;
}

/**
 * The WebAssembly type of a C type of the runtime ABI.
 *
 * A pointer is an offset into the shared memory and so is an `i32`; a count
 * and a whole number are an `i64`; a `double` is an `f64`; and a function that
 * answers nothing answers nothing at all.
 */
const WASM_OF_C: Record<string, string> = {
  "void": "",
  "void*": "i32",
  "char*": "i32",
  "const char*": "i32",
  "unsigned char*": "i32",
  "const unsigned char*": "i32",
  "double": "f64",
  "size_t": "i64",
  "unsigned": "i32",
  "int": "i32",
  "long long": "i64",
  "int64_t": "i64",
  "uint64_t": "i64",
};

/**
 * The services of the runtime ABI a module may import.
 *
 * The list is the runtime's own: a service that is not here is one a module
 * cannot reach, and the boundary check refuses a module that imports one. The
 * ones that are left out are the ones that are not services of a program but
 * of a host — a promise, a thread team, a region, the command line the host
 * sets up — and a module has no host to ask.
 */
const EXPOSED_SERVICES: readonly string[] = [
  "blaze_rt_allocate",
  "blaze_rt_allocate_uninitialized",
  "blaze_rt_reallocate",
  "blaze_rt_retain",
  "blaze_rt_release",
  "blaze_rt_string_new",
  "blaze_rt_string_append",
  "blaze_rt_string_clone",
  "blaze_rt_string_length",
  "blaze_rt_text_length",
  "blaze_rt_text_compare",
  "blaze_rt_array_new",
  "blaze_rt_array_resize",
  "blaze_rt_object_new",
  "blaze_rt_object_size",
  "blaze_rt_print_text",
  "blaze_rt_print_text_n",
  "blaze_rt_print_number",
  "blaze_rt_print_whole",
  "blaze_rt_print_newline",
  "blaze_rt_raise",
  "blaze_rt_to_text",
  "blaze_rt_to_number",
  "blaze_rt_format_number",
  "blaze_rt_format_number_fixed",
  "blaze_rt_random",
  "blaze_rt_monotonic_ms",
  "blaze_rt_argv_count",
  "blaze_rt_argv",
  "blaze_rt_json_parse",
  "blaze_rt_json_stringify",
  "blaze_rt_json_get",
  "blaze_rt_dyn_array_new",
  "blaze_rt_box_number",
  "blaze_rt_box_string",
  "blaze_rt_box_null",
  "blaze_rt_array_push",
  "blaze_rt_array_get",
  "blaze_rt_array_set",
  "blaze_rt_array_length",
  "blaze_rt_md5_create",
  "blaze_rt_md5_update",
  "blaze_rt_md5_digest",
  "blaze_rt_file_read",
  "blaze_rt_env_get",
];

/**
 * The wide arithmetic, which is the kernel beside the runtime ABI rather than
 * a part of it: a module has no instruction that carries a two hundred and
 * fifty six bit number, so it calls the kernel the other two backends call.
 */
const WIDE_SERVICES: readonly HostService[] = [
  { symbol: "blaze_rt_u256_from_u64", params: ["i32", "i64"], result: null },
  { symbol: "blaze_rt_u256_from_u64x2", params: ["i32", "i64", "i64"], result: null },
  { symbol: "blaze_rt_u256_from_u64x4", params: ["i32", "i64", "i64", "i64", "i64"], result: null },
  { symbol: "blaze_rt_u256_mul", params: ["i32", "i32", "i32"], result: null },
  { symbol: "blaze_rt_u256_div", params: ["i32", "i32", "i32"], result: null },
  { symbol: "blaze_rt_u256_mod", params: ["i32", "i32", "i32"], result: null },
  { symbol: "blaze_rt_u256_add_mod", params: ["i32", "i32", "i32", "i32"], result: null },
  { symbol: "blaze_rt_u256_sub_mod", params: ["i32", "i32", "i32", "i32"], result: null },
  { symbol: "blaze_rt_u256_mul_mod", params: ["i32", "i32", "i32", "i32"], result: null },
  { symbol: "blaze_rt_u256_less", params: ["i32", "i32"], result: "i32" },
  { symbol: "blaze_rt_u256_equal", params: ["i32", "i32"], result: "i32" },
  { symbol: "blaze_rt_print_u256", params: ["i32"], result: null },
];

/**
 * The services whose WebAssembly signature is not the C one with its types
 * replaced.
 *
 * The C ABI carries a text into the dynamic side as a double: the pointer is
 * put in a double because everything on that side of the wall is a double, and
 * the runtime reads the pointer back out of it. The WebAssembly ABI has a
 * pointer of its own — an offset into the shared memory — and every other
 * service of the table that takes a text takes it that way. So this one
 * service takes the offset itself, and the host reads the text at it.
 */
const SIGNATURE_OVERRIDES: Record<string, { params: readonly string[]; result: string | null }> = {
  blaze_rt_json_parse: { params: ["i32"], result: "f64" },
};

/**
 * The text helpers, which stand beside the runtime ABI the way the wide
 * kernel does: they are not services a host of the ABI provides but
 * operations over the texts the runtime lays out, and they are here so a
 * module reads a text apart the way a native program does.
 *
 * The indexes travel as numbers, which is what a module carries an index of
 * a text as on this side of the wall: everything else it holds there is a
 * number too, and the host reads the whole number off it.
 */
const TEXT_SERVICES: readonly HostService[] = [
  { symbol: "blaze_rt_text_index_of", params: ["i32", "i32"], result: "f64" },
  { symbol: "blaze_rt_text_slice", params: ["i32", "f64", "f64"], result: "i32" },
  { symbol: "blaze_rt_text_trim", params: ["i32"], result: "i32" },
];

/**
 * The services of the host ABI, by the name they are imported under.
 *
 * The table is the runtime ABI with the C types replaced by the WebAssembly
 * ones, so the mapping from one to the other is one to one and the spelling of
 * a call carries over unchanged.
 */
export const HOST_SERVICES: readonly HostService[] = [
  ...RUNTIME_ABI.filter((entry) => EXPOSED_SERVICES.includes(entry.symbol)).map((entry) => {
    const signature = SIGNATURE_OVERRIDES[entry.symbol];
    if (signature !== undefined) return { symbol: entry.symbol, ...signature };
    return {
      symbol: entry.symbol,
      params: entry.params.map(([, type]) => {
        const mapped = WASM_OF_C[type];
        if (mapped === undefined) throw new Error(`the host ABI has no WebAssembly type for the C type "${type}"`);
        return mapped;
      }),
      result: entry.returns === "void" ? null : (WASM_OF_C[entry.returns] as string),
      ...(entry.noreturn === true ? { noreturn: true } : {}),
    };
  }),
  ...WIDE_SERVICES,
  ...TEXT_SERVICES,
];

/** Every service by name, so a lowering asks for one without searching. */
export const HOST_SERVICE_BY_SYMBOL: ReadonlyMap<string, HostService> = new Map(
  HOST_SERVICES.map((service) => [service.symbol, service]),
);

/** The name the memory is imported under, which is not a service. */
export const MEMORY_IMPORT = "memory";

/** The name the power is imported under, which is not a service either. */
export const POW_IMPORT = "pow";

/**
 * The signature of a service, as the type section writes it: the parameters and
 * the result, or null where the service answers nothing.
 */
export function serviceSignature(service: HostService): { params: readonly string[]; result: string | null } {
  return { params: service.params, result: service.result };
}

/* -------------------------------------------------------------------------- */
/* The runtime the host carries                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One part of the runtime the generated host carries.
 *
 * A part with a service is the implementation of that service and is written
 * only when the module imported it: a service the module did not import is not
 * implemented and not paid for. A part with no service is a helper every
 * implementation needs, and is written once.
 */
interface RuntimePart {
  /** The service this part implements, or null for a helper. */
  readonly service: string | null;
  readonly source: string;
}

/**
 * The runtime, as the source of the generated host.
 *
 * The memory is the host's and the host's allocator is the one that hands out
 * memory: a module never grows the memory itself and never writes below the
 * address the module published, except into the scratch the module owns.
 */
const RUNTIME_HELPERS = `
/* The managed representation: a forty-eight byte header, a count word and the
   payload, in that order, so a value the module holds and a value the host
   holds are the same kind of thing.

   The count word is the one thing the C runtime does not have: a C buffer is
   handed over with its length beside it, and a WebAssembly buffer is a bare
   offset into the memory, so the count is written in the word the offset sits
   one before. The module reads the length of a buffer from there, and the host
   writes it there for a buffer it hands over and for one the module makes. */
const PAGE = 65536;
const HEADER = 48;
const COUNT = 8;
const OVERHEAD = HEADER + COUNT;
const MAGIC = 0x424c415a45525400n;
const ALIGNMENT = 16;

let memory = null;
let cursor = 65536;
let textStyle = 0;
let lastError = "";
const freeBlocks = new Map();
/* Slot 0 stays reserved: 0 is not a dynamic value, it is the nothing a
   missing field answers, the way the C runtime reserves it. */
const dynValues = [null];

/* The arguments the program was given. A module has no process of its own, so
   the arguments it reads are the ones the host was started with. */
let programArguments = [];

/* One command line argument as the number the source reads it as. The source
   reads an argument the way the language reads a string as a number: the
   spaces around it are not part of it, a base written before the digits is
   read in that base, and an argument that is not a number at all is NaN
   rather than a zero the source never wrote. */
function programNumberOf(text) {
  const trimmed = String(text).trim();
  if (trimmed === "") return 0;
  /* A base written before the digits is read in that base, one digit at a
     time: 0b101 is five, 0o17 is fifteen, and a prefix with no digits behind
     it is not a number. */
  const base = trimmed.length > 2 && trimmed[0] === "0"
    ? trimmed[1] === "x" || trimmed[1] === "X" ? 16
      : trimmed[1] === "o" || trimmed[1] === "O" ? 8
      : trimmed[1] === "b" || trimmed[1] === "B" ? 2
      : 0
    : 0;
  if (base !== 0) {
    let value = 0;
    for (const digit of trimmed.slice(2)) {
      const letter = digit.codePointAt(0);
      const place = letter >= 48 && letter <= 57 ? letter - 48
        : letter >= 97 && letter <= 122 ? letter - 97 + 10
        : letter >= 65 && letter <= 90 ? letter - 65 + 10
        : -1;
      if (place < 0 || place >= base) return NaN;
      value = value * base + place;
    }
    return value;
  }
  /* What is left is a decimal, which is the one form a sign is written in front
     of, and the one word a decimal may spell. */
  let body = trimmed;
  let negative = false;
  if (body.startsWith("+") || body.startsWith("-")) {
    negative = body.startsWith("-");
    body = body.slice(1);
  }
  if (body === "") return NaN;
  if (body === "Infinity") return negative ? -Infinity : Infinity;
  /* A base is never written behind a sign, and a base with no digits behind it
     is not a number: neither is anything the language does not read as one. */
  if (!/^[0-9.]/.test(body)) return NaN;
  if (body[0] === "0" && "xXoObB".includes(body[1] ?? "")) return NaN;
  const value = Number(body);
  if (Number.isNaN(value)) return NaN;
  return negative ? -value : value;
}

/* The host tells the runtime what the program was given, the way the driver of
   a native program tells it. The count the runtime answers is the length of
   process.argv: the program, the file it runs, and the arguments it was
   given, so the first argument is at the index two. */
export function setArguments(values) {
  programArguments = values.map((value) => programNumberOf(value));
}

/* A raise is the runtime's own way of stopping a program, and it is not a
   fault: the host catches it and reports it the way the C runtime does. */
export class BlazeError extends Error {}

/* The memory the module and the host share. The host creates it and hands it
   over; a reader of the runtime that is not the host sets it itself. */
export function setMemory(value) {
  memory = value;
}


function view() {
  return new DataView(memory.buffer);
}

function alignUp(value, at) {
  const rest = value % at;
  return rest === 0 ? value : value + (at - rest);
}

function growTo(end) {
  const bytes = memory.buffer.byteLength;
  if (end > bytes) memory.grow(Math.ceil((end - bytes) / PAGE) + 1);
}

/* The size class a block of so many bytes is pooled under. A block is taken
   again when one of its class is free, so a loop that builds a value per turn
   does not ask the host for a new page every turn. */
function classOf(bytes) {
  if (bytes > 65536) return bytes;
  let size = 16;
  while (size < bytes) size *= 2;
  return size;
}

function readHeader(pointer) {
  const at = pointer - OVERHEAD;
  const data = view();
  return {
    magic: data.getBigUint64(at, true),
    length: Number(data.getBigUint64(at + 16, true)),
    alignment: Number(data.getBigUint64(at + 24, true)),
    references: Number(data.getBigUint64(at + 32, true)),
    capacity: Number(data.getBigUint64(at + 40, true)),
  };
}

function writeHeader(pointer, length, alignment, references, capacity) {
  const at = pointer - OVERHEAD;
  const data = view();
  data.setBigUint64(at, MAGIC, true);
  data.setBigUint64(at + 8, BigInt(pointer), true);
  data.setBigUint64(at + 16, BigInt(length), true);
  data.setBigUint64(at + 24, BigInt(alignment), true);
  data.setBigUint64(at + 32, BigInt(references), true);
  data.setBigUint64(at + 40, BigInt(capacity), true);
}

/* The count of the elements a buffer holds, which is the word the offset sits
   one before. */
function writeCount(pointer, count) {
  view().setBigUint64(pointer - COUNT, BigInt(count), true);
}

function readCount(pointer) {
  return Number(view().getBigUint64(pointer - COUNT, true));
}

/* A block of the host's memory: the header, the count word and the payload,
   in that order, with the payload at the address the module is handed. */
function block(bytes, alignment, cleared) {
  const size = Math.max(1, bytes);
  const cls = classOf(size);
  const pooled = freeBlocks.get(cls);
  if (pooled !== undefined && pooled.length > 0) {
    const pointer = pooled.pop();
    writeHeader(pointer, size, alignment, 1, cls);
    writeCount(pointer, 0);
    if (cleared) new Uint8Array(memory.buffer, pointer, size).fill(0);
    return pointer;
  }
  const pointer = alignUp(cursor + OVERHEAD, alignment);
  const end = pointer + size;
  growTo(end);
  cursor = end;
  writeHeader(pointer, size, alignment, 1, cls);
  writeCount(pointer, 0);
  if (cleared) new Uint8Array(memory.buffer, pointer, size).fill(0);
  return pointer;
}

/* The bytes of a text, whether the runtime allocated it or the compiler wrote
   it out. A managed text carries its length in the header in front of it; a
   literal has no header and is measured by scanning it. */
function textBytes(pointer) {
  if (pointer === 0) return new Uint8Array(0);
  const bytes = new Uint8Array(memory.buffer);
  const header = readHeader(pointer);
  if (header.magic === MAGIC) {
    const length = Math.max(0, header.length - 1);
    return bytes.slice(pointer, pointer + length);
  }
  let at = pointer;
  while (at < bytes.length && bytes[at] !== 0) at += 1;
  return bytes.slice(pointer, at);
}

/* A text of its own, laid out in the host's memory the way the runtime lays
   one out: the bytes, and a terminator the length does not count. */
function makeText(text) {
  const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
  const pointer = block(bytes.length + 1, ALIGNMENT, false);
  const target = new Uint8Array(memory.buffer, pointer, bytes.length + 1);
  target.set(bytes, 0);
  target[bytes.length] = 0;
  return pointer;
}

function dynRegister(value) {
  /* Handle 0 is not a dynamic value: it is the nothing a missing field
     answers. The slot stays reserved, the way the C runtime reserves it. */
  dynValues.push(value);
  return dynValues.length - 1;
}

function dynLookup(handle) {
  const at = Math.trunc(handle);
  if (at <= 0 || !Number.isFinite(at) || at >= dynValues.length) return null;
  return dynValues[at];
}

/* The shortest decimal that reads back as a value, placed the way the source
   language places it: in full from 1e-6 up to 1e21, and in exponential form
   outside that range. The C runtime writes the same number the same way, and
   the two hosts have to agree. */
function formatNumber(value) {
  if (Number.isNaN(value)) return textStyle === 1 ? "nan" : "NaN";
  if (!Number.isFinite(value)) {
    const infinity = textStyle === 1 ? "inf" : "Infinity";
    return value < 0 ? "-" + infinity : infinity;
  }
  if (value === 0) return textStyle === 1 ? (Object.is(value, -0) ? "-0.0" : "0.0") : "0";
  const negative = value < 0;
  const magnitude = negative ? -value : value;
  let written;
  if (magnitude < 9007199254740992 && Number.isInteger(magnitude)) {
    written = BigInt(magnitude).toString();
    if (textStyle === 1) written += ".0";
  } else {
    const scientific = magnitude.toExponential();
    const mark = scientific.indexOf("e");
    const exponent = Number(scientific.slice(mark + 1));
    const digits = scientific.slice(0, mark).replace(".", "");
    const count = digits.length;
    const point = exponent + 1;
    const lowest = textStyle === 1 ? -3 : -5;
    const highest = textStyle === 1 ? 16 : 21;
    if (point >= lowest && point <= highest) {
      if (point <= 0) written = "0." + "0".repeat(-point) + digits;
      else if (point >= count) written = digits + "0".repeat(point - count) + (textStyle === 1 ? ".0" : "");
      else written = digits.slice(0, point) + "." + digits.slice(point);
    } else {
      const scale = point - 1;
      written = count > 1 ? digits[0] + "." + digits.slice(1) : digits;
      written += "e" + (scale < 0 ? "-" : "+") + String(Math.abs(scale));
    }
  }
  return negative ? "-" + written : written;
}

/* A number written at a fixed number of digits after the point, which is what
   x.toFixed(d) writes: the same digits every time, rounded at the last of
   them, and never the exponent form the shortest writing falls back on. */
function formatNumberFixed(value, digits) {
  if (Number.isNaN(value) || !Number.isFinite(value) || Math.abs(value) >= 1e21) return formatNumber(value);
  const wanted = digits < 0 ? 0 : digits > 100 ? 100 : digits;
  let written = value.toFixed(wanted);
  if (written.startsWith("-") && Number(value) === 0) written = written.slice(1);
  return written;
}

function writeOut(bytes) {
  process.stdout.write(Buffer.from(bytes));
}
`;

/** The implementation of each service, as the source of the generated host. */
const RUNTIME_SERVICES: readonly RuntimePart[] = [
  {
    service: "blaze_rt_allocate",
    source: `
export function blaze_rt_allocate(bytes) {
  return block(Number(bytes), ALIGNMENT, true);
}
`,
  },
  {
    service: "blaze_rt_allocate_uninitialized",
    source: `
export function blaze_rt_allocate_uninitialized(bytes) {
  return block(Number(bytes), ALIGNMENT, false);
}
`,
  },
  {
    service: "blaze_rt_reallocate",
    source: `
export function blaze_rt_reallocate(pointer, bytes) {
  const size = Number(bytes);
  if (pointer === 0) return block(size, ALIGNMENT, true);
  const header = readHeader(pointer);
  if (size <= header.capacity) {
    if (size > header.length) new Uint8Array(memory.buffer, pointer + header.length, size - header.length).fill(0);
    writeHeader(pointer, size, header.alignment, header.references, header.capacity);
    return pointer;
  }
  const wanted = header.capacity + Math.floor(header.capacity / 2) + 16;
  const grown = block(size < wanted ? wanted : size, header.alignment, false);
  new Uint8Array(memory.buffer, grown, header.length).set(new Uint8Array(memory.buffer, pointer, header.length));
  /* The block that was moved is released, and a release is the runtime's own
     counting, so the header is written here rather than through a call the
     module may not have imported. */
  const at = pointer - OVERHEAD;
  view().setBigUint64(at, 0n, true);
  const pooled = freeBlocks.get(header.capacity);
  if (pooled === undefined) freeBlocks.set(header.capacity, [pointer]);
  else pooled.push(pointer);
  return grown;
}
`,
  },
  {
    service: "blaze_rt_retain",
    source: `
export function blaze_rt_retain(pointer) {
  if (pointer === 0) return 0;
  const header = readHeader(pointer);
  writeHeader(pointer, header.length, header.alignment, header.references + 1, header.capacity);
  return pointer;
}
`,
  },
  {
    service: "blaze_rt_release",
    source: `
export function blaze_rt_release(pointer) {
  if (pointer === 0) return;
  const header = readHeader(pointer);
  if (header.references > 1) {
    writeHeader(pointer, header.length, header.alignment, header.references - 1, header.capacity);
    return;
  }
  const at = pointer - OVERHEAD;
  view().setBigUint64(at, 0n, true);
  const cls = header.capacity;
  const pooled = freeBlocks.get(cls);
  if (pooled === undefined) freeBlocks.set(cls, [pointer]);
  else pooled.push(pointer);
}
`,
  },
  {
    service: "blaze_rt_string_new",
    source: `
export function blaze_rt_string_new(bytes, length) {
  const count = Number(length);
  const source = bytes === 0 ? new Uint8Array(0) : new Uint8Array(memory.buffer, bytes, count);
  return makeText(source);
}
`,
  },
  {
    service: "blaze_rt_string_append",
    source: `
export function blaze_rt_string_append(left, right) {
  const one = textBytes(left);
  const two = textBytes(right);
  const joined = new Uint8Array(one.length + two.length);
  joined.set(one, 0);
  joined.set(two, one.length);
  return makeText(joined);
}
`,
  },
  {
    service: "blaze_rt_string_clone",
    source: `
export function blaze_rt_string_clone(text) {
  return makeText(textBytes(text));
}
`,
  },
  {
    service: "blaze_rt_string_length",
    source: `
export function blaze_rt_string_length(text) {
  if (text === 0) return 0n;
  return BigInt(readHeader(text).length - 1);
}
`,
  },
  {
    service: "blaze_rt_text_length",
    source: `
export function blaze_rt_text_length(text) {
  return BigInt(textBytes(text).length);
}
`,
  },
  {
    service: "blaze_rt_text_compare",
    source: `
export function blaze_rt_text_compare(left, right) {
  /* Two texts are compared by what they say and not by where they are: a text
     built at run time and one written out are two addresses that can say the
     same thing. A text that is nothing is the smaller of the two, so two
     texts that are nothing are the same thing. The bytes are compared as the
     C library compares them: one byte at a time, the first difference
     deciding, and a byte read as the unsigned number it is. */
  if (left === 0 || right === 0) {
    if (left === right) return 0;
    return left === 0 ? -1 : 1;
  }
  const one = textBytes(left);
  const two = textBytes(right);
  const shared = Math.min(one.length, two.length);
  for (let at = 0; at < shared; at += 1) {
    if (one[at] !== two[at]) return one[at] < two[at] ? -1 : 1;
  }
  if (one.length === two.length) return 0;
  return one.length < two.length ? -1 : 1;
}
`,
  },
  {
    service: "blaze_rt_array_new",
    source: `
export function blaze_rt_array_new(count, elementSize) {
  const elements = Number(count);
  const width = Number(elementSize);
  const pointer = block(elements * width, ALIGNMENT, true);
  /* The count of the elements is the word the offset sits one before, which is
     where the module reads the length of a buffer from. */
  writeCount(pointer, elements);
  return pointer;
}
`,
  },
  {
    service: "blaze_rt_array_resize",
    source: `
export function blaze_rt_array_resize(pointer, count, elementSize) {
  return blaze_rt_reallocate(pointer, Number(count) * Number(elementSize));
}
`,
  },
  {
    service: "blaze_rt_object_new",
    source: `
export function blaze_rt_object_new(bytes, alignment) {
  const at = Number(alignment) === 0 ? ALIGNMENT : Number(alignment);
  return block(Number(bytes), at, true);
}
`,
  },
  {
    service: "blaze_rt_object_size",
    source: `
export function blaze_rt_object_size(pointer) {
  if (pointer === 0) return 0n;
  return BigInt(readHeader(pointer).length);
}
`,
  },
  {
    service: "blaze_rt_print_text",
    source: `
export function blaze_rt_print_text(text) {
  writeOut(textBytes(text));
}
`,
  },
  {
    service: "blaze_rt_print_text_n",
    source: `
export function blaze_rt_print_text_n(text, length) {
  const count = Number(length);
  if (text === 0) return;
  writeOut(new Uint8Array(memory.buffer, text, count));
}
`,
  },
  {
    service: "blaze_rt_print_number",
    source: `
export function blaze_rt_print_number(value) {
  if (value === 0 && Object.is(value, -0)) {
    writeOut(new TextEncoder().encode(textStyle === 1 ? "-0.0" : "-0"));
    return;
  }
  writeOut(new TextEncoder().encode(formatNumber(value)));
}
`,
  },
  {
    service: "blaze_rt_print_whole",
    source: `
export function blaze_rt_print_whole(value, bigint) {
  const magnitude = value < 0n ? -value : value;
  let written = magnitude.toString();
  if (value < 0n) written = "-" + written;
  if (bigint !== 0 && textStyle !== 1) written += "n";
  writeOut(new TextEncoder().encode(written));
}
`,
  },
  {
    service: "blaze_rt_print_newline",
    source: `
export function blaze_rt_print_newline() {
  process.stdout.write("\\n");
}
`,
  },
  {
    service: "blaze_rt_raise",
    source: `
export function blaze_rt_raise(message) {
  lastError = new TextDecoder().decode(textBytes(message));
  throw new BlazeError(lastError);
}
`,
  },
  {
    service: "blaze_rt_to_text",
    source: `
export function blaze_rt_to_text(value) {
  const boxed = dynLookup(value);
  if (boxed === null) return makeText(formatNumber(value));
  if (boxed.kind === "number") return makeText(formatNumber(boxed.number));
  if (boxed.kind === "bool") return makeText(boxed.number ? (textStyle === 1 ? "True" : "true") : (textStyle === 1 ? "False" : "false"));
  if (boxed.kind === "text") return makeText(boxed.text);
  if (boxed.kind === "null") return makeText(textStyle === 1 ? "None" : "null");
  if (boxed.kind === "array") {
    const parts = boxed.items.map((item) => {
      const inner = dynLookup(item);
      const text = new TextDecoder().decode(textBytes(blaze_rt_to_text(item)));
      return inner !== null && inner.kind === "text" ? '"' + text + '"' : text;
    });
    return makeText("[" + parts.join(",") + "]");
  }
  if (boxed.kind === "object") return makeText(jsonText(value));
  if (boxed.kind === "value") return makeText(jsonText(value));
  return makeText("null");
}
`,
  },
  {
    service: "blaze_rt_to_number",
    source: `
export function blaze_rt_to_number(value) {
  const boxed = dynLookup(value);
  if (boxed === null) return value;
  if (boxed.kind === "number" || boxed.kind === "bool") return boxed.number;
  if (boxed.kind === "text") {
    /* The number the text states, and zero where it states none: the C
       runtime reads it with atof, which reads the digits it finds and stops
       there, and answers zero for a text that holds no digits at all. */
    const parsed = Number.parseFloat(boxed.text);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return value;
}
`,
  },
  {
    service: "blaze_rt_format_number",
    source: `
export function blaze_rt_format_number(value, buffer, size) {
  return writeNumber(formatNumber(value), buffer, size);
}
`,
  },
  {
    service: "blaze_rt_format_number_fixed",
    source: `
export function blaze_rt_format_number_fixed(value, digits, buffer, size) {
  return writeNumber(formatNumberFixed(value, digits), buffer, size);
}
`,
  },
  {
    service: "blaze_rt_random",
    source: `
export function blaze_rt_random() {
  return Math.random();
}
`,
  },
  {
    service: "blaze_rt_monotonic_ms",
    source: `
export function blaze_rt_monotonic_ms() {
  return Number(process.hrtime.bigint()) / 1000000;
}
`,
  },
  {
    service: "blaze_rt_argv_count",
    source: `
export function blaze_rt_argv_count() {
  return BigInt(programArguments.length + 2);
}
`,
  },
  {
    service: "blaze_rt_argv",
    source: `
export function blaze_rt_argv(index) {
  const at = Number(index);
  if (at < 2) return NaN;
  const argument = at - 2;
  if (argument >= programArguments.length) return NaN;
  return programArguments[argument];
}
`,
  },
  {
    service: "blaze_rt_json_parse",
    source: `
export function blaze_rt_json_parse(text) {
  const source = new TextDecoder().decode(textBytes(text));
  try {
    return dynRegister({ kind: "value", value: JSON.parse(source) });
  } catch (error) {
    blaze_rt_raise("invalid JSON");
    return dynRegister({ kind: "null" });
  }
}
`,
  },
  {
    service: "blaze_rt_json_stringify",
    source: `
export function blaze_rt_json_stringify(value) {
  const boxed = dynLookup(value);
  return dynRegister({ kind: "text", text: JSON.stringify(boxed === null ? value : boxed.value) });
}
`,
  },
  {
    service: "blaze_rt_json_get",
    source: `
export function blaze_rt_json_get(value, field) {
  const boxed = dynLookup(value);
  const name = new TextDecoder().decode(textBytes(field));
  const inner = boxed === null ? null : boxed.value;
  if (inner === null || typeof inner !== "object" || Array.isArray(inner)) return dynRegister({ kind: "null" });
  const found = Object.prototype.hasOwnProperty.call(inner, name) ? inner[name] : null;
  return dynRegister(jsonValue(found));
}
`,
  },
  {
    service: "blaze_rt_dyn_array_new",
    source: `
export function blaze_rt_dyn_array_new() {
  return dynRegister({ kind: "array", items: [] });
}
`,
  },
  {
    service: "blaze_rt_box_number",
    source: `
export function blaze_rt_box_number(value) {
  return dynRegister({ kind: "number", number: value });
}
`,
  },
  {
    service: "blaze_rt_box_string",
    source: `
export function blaze_rt_box_string(value) {
  return dynRegister({ kind: "text", text: new TextDecoder().decode(textBytes(value)) });
}
`,
  },
  {
    service: "blaze_rt_box_null",
    source: `
export function blaze_rt_box_null() {
  return dynRegister({ kind: "null" });
}
`,
  },
  {
    service: "blaze_rt_array_push",
    source: `
export function blaze_rt_array_push(array, value) {
  const boxed = dynLookup(array);
  if (boxed === null || boxed.kind !== "array") {
    const fresh = dynRegister({ kind: "array", items: [] });
    dynLookup(fresh).items.push(value);
    return fresh;
  }
  boxed.items.push(value);
  return array;
}
`,
  },
  {
    service: "blaze_rt_array_get",
    source: `
export function blaze_rt_array_get(array, index) {
  const boxed = dynLookup(array);
  if (boxed === null || boxed.kind !== "array") return 0;
  const at = Number(index);
  if (at < 0 || at >= boxed.items.length) return 0;
  return boxed.items[at];
}
`,
  },
  {
    service: "blaze_rt_array_set",
    source: `
export function blaze_rt_array_set(array, index, value) {
  const boxed = dynLookup(array);
  if (boxed === null || boxed.kind !== "array") return;
  const at = Number(index);
  if (at < 0 || at >= boxed.items.length) return;
  boxed.items[at] = value;
}
`,
  },
  {
    service: "blaze_rt_array_length",
    source: `
export function blaze_rt_array_length(array) {
  const boxed = dynLookup(array);
  if (boxed === null) return 0;
  if (boxed.kind === "object") {
    const inner = boxed.value;
    if (inner === null || typeof inner !== "object") return 0;
    return Object.keys(inner).length;
  }
  if (boxed.kind !== "array") return 0;
  return boxed.items.length;
}
`,
  },
  {
    service: "blaze_rt_md5_create",
    source: `
export function blaze_rt_md5_create() {
  return dynRegister({ kind: "hasher", chunks: [] });
}
`,
  },
  {
    service: "blaze_rt_md5_update",
    source: `
export function blaze_rt_md5_update(hasher, text) {
  const boxed = dynLookup(hasher);
  if (boxed === null || boxed.kind !== "hasher") return hasher;
  boxed.chunks.push(new TextDecoder().decode(textBytes(text)));
  return hasher;
}
`,
  },
  {
    service: "blaze_rt_md5_digest",
    source: `
export function blaze_rt_md5_digest(hasher) {
  const boxed = dynLookup(hasher);
  if (boxed === null || boxed.kind !== "hasher") return dynRegister({ kind: "text", text: "" });
  return dynRegister({ kind: "text", text: md5(boxed.chunks.join("")) });
}
`,
  },
  {
    service: "blaze_rt_file_read",
    source: `
export function blaze_rt_file_read(path, mode) {
  const name = new TextDecoder().decode(textBytes(path));
  try {
    return dynRegister({ kind: "text", text: readFileSync(name, "utf8") });
  } catch (error) {
    blaze_rt_raise("file not found");
    return dynRegister({ kind: "null" });
  }
}
`,
  },
  {
    service: "blaze_rt_env_get",
    source: `
export function blaze_rt_env_get(name) {
  const variable = new TextDecoder().decode(textBytes(name));
  const value = globalThis.process !== undefined ? globalThis.process.env[variable] : undefined;
  return makeText(typeof value === "string" ? value : "");
}
`,
  },
  {
    service: "blaze_rt_u256_from_u64",
    source: `
export function blaze_rt_u256_from_u64(out, value) {
  writeWide(out, [BigInt.asUintN(64, value), 0n, 0n, 0n]);
}
`,
  },
  {
    service: "blaze_rt_u256_from_u64x2",
    source: `
export function blaze_rt_u256_from_u64x2(out, low, high) {
  writeWide(out, [BigInt.asUintN(64, low), BigInt.asUintN(64, high), 0n, 0n]);
}
`,
  },
  {
    service: "blaze_rt_u256_from_u64x4",
    source: `
export function blaze_rt_u256_from_u64x4(out, l0, l1, l2, l3) {
  writeWide(out, [BigInt.asUintN(64, l0), BigInt.asUintN(64, l1), BigInt.asUintN(64, l2), BigInt.asUintN(64, l3)]);
}
`,
  },
  {
    service: "blaze_rt_u256_mul",
    source: `
export function blaze_rt_u256_mul(out, left, right) {
  writeWide(out, wideMul(readWide(left), readWide(right)));
}
`,
  },
  {
    service: "blaze_rt_u256_div",
    source: `
export function blaze_rt_u256_div(out, left, right) {
  const divisor = readWide(right);
  if (divisor.every((limb) => limb === 0n)) blaze_rt_raise("division by zero");
  writeWide(out, wideDiv(readWide(left), divisor));
}
`,
  },
  {
    service: "blaze_rt_u256_mod",
    source: `
export function blaze_rt_u256_mod(out, left, right) {
  const divisor = readWide(right);
  if (divisor.every((limb) => limb === 0n)) blaze_rt_raise("division by zero");
  writeWide(out, wideMod(readWide(left), divisor));
}
`,
  },
  {
    service: "blaze_rt_u256_add_mod",
    source: `
export function blaze_rt_u256_add_mod(out, left, right, mod) {
  const divisor = readWide(mod);
  if (divisor.every((limb) => limb === 0n)) blaze_rt_raise("division by zero");
  writeWide(out, wideMod(wideAdd(readWide(left), readWide(right)), divisor));
}
`,
  },
  {
    service: "blaze_rt_u256_sub_mod",
    source: `
export function blaze_rt_u256_sub_mod(out, left, right, mod) {
  const divisor = readWide(mod);
  if (divisor.every((limb) => limb === 0n)) blaze_rt_raise("division by zero");
  const difference = wideSub(readWide(left), readWide(right));
  writeWide(out, wideMod(difference, divisor));
}
`,
  },
  {
    service: "blaze_rt_u256_mul_mod",
    source: `
export function blaze_rt_u256_mul_mod(out, left, right, mod) {
  const divisor = readWide(mod);
  if (divisor.every((limb) => limb === 0n)) blaze_rt_raise("division by zero");
  writeWide(out, wideMod(wideMul(readWide(left), readWide(right)), divisor));
}
`,
  },
  {
    service: "blaze_rt_u256_less",
    source: `
export function blaze_rt_u256_less(left, right) {
  return wideLess(readWide(left), readWide(right)) ? 1 : 0;
}
`,
  },
  {
    service: "blaze_rt_u256_equal",
    source: `
export function blaze_rt_u256_equal(left, right) {
  const one = readWide(left);
  const two = readWide(right);
  for (let limb = 0; limb < 4; limb += 1) if (one[limb] !== two[limb]) return 0;
  return 1;
}
`,
  },
  {
    service: "blaze_rt_print_u256",
    source: `
export function blaze_rt_print_u256(value) {
  writeOut(new TextEncoder().encode(wideText(readWide(value))));
}
`,
  },
  {
    service: "blaze_rt_text_index_of",
    source: `
export function blaze_rt_text_index_of(text, needle) {
  const haystack = new TextDecoder().decode(textBytes(text));
  const part = new TextDecoder().decode(textBytes(needle));
  return haystack.indexOf(part);
}
`,
  },
  {
    service: "blaze_rt_text_slice",
    source: `
export function blaze_rt_text_slice(text, start, stop) {
  const bytes = textBytes(text);
  const length = bytes.length;
  let from = Math.trunc(start);
  let to = Math.trunc(stop);
  if (from < 0) from += length;
  if (to < 0) to += length;
  if (from < 0) from = 0;
  if (to > length) to = length;
  if (to <= from) return makeText(new Uint8Array(0));
  return makeText(bytes.slice(from, to));
}
`,
  },
  {
    service: "blaze_rt_text_trim",
    source: `
function blaze_rt_text_is_space(byte) {
  return byte === 32 || byte === 9 || byte === 10 || byte === 13 || byte === 11 || byte === 12;
}

export function blaze_rt_text_trim(text) {
  const bytes = textBytes(text);
  let start = 0;
  let stop = bytes.length;
  while (start < stop && blaze_rt_text_is_space(bytes[start])) start += 1;
  while (stop > start && blaze_rt_text_is_space(bytes[stop - 1])) stop -= 1;
  return makeText(bytes.slice(start, stop));
}
`,
  },
];

/**
 * The helpers the wide services need: the limbs of a wide number are read out
 * of the memory the module and the host share, and written back the same way,
 * and the arithmetic over them is the kernel's.
 */
const RUNTIME_WIDE = `
function readWide(pointer) {
  const at = pointer;
  const data = view();
  const limbs = [];
  for (let limb = 0; limb < 4; limb += 1) limbs.push(data.getBigUint64(at + limb * 8, true));
  return limbs;
}

function writeWide(pointer, limbs) {
  const data = view();
  for (let limb = 0; limb < 4; limb += 1) data.setBigUint64(pointer + limb * 8, BigInt.asUintN(64, limbs[limb]), true);
}

const WIDE_MODULUS = 1n << 256n;

function wideAdd(left, right) {
  const out = [];
  let carry = 0n;
  for (let limb = 0; limb < 4; limb += 1) {
    const sum = left[limb] + right[limb] + carry;
    out.push(BigInt.asUintN(64, sum));
    carry = sum >> 64n;
  }
  return out;
}

function wideSub(left, right) {
  const out = [];
  let borrow = 0n;
  for (let limb = 0; limb < 4; limb += 1) {
    const difference = left[limb] - right[limb] - borrow;
    out.push(BigInt.asUintN(64, difference));
    borrow = difference < 0n ? 1n : 0n;
  }
  return out;
}

function wideMul(left, right) {
  const out = [0n, 0n, 0n, 0n];
  for (let i = 0; i < 4; i += 1) {
    let carry = 0n;
    for (let j = 0; i + j < 4; j += 1) {
      const product = out[i + j] + left[i] * right[j] + carry;
      out[i + j] = BigInt.asUintN(64, product);
      carry = product >> 64n;
    }
  }
  return out;
}

function wideCompare(left, right) {
  for (let limb = 3; limb >= 0; limb -= 1) {
    if (left[limb] < right[limb]) return -1;
    if (left[limb] > right[limb]) return 1;
  }
  return 0;
}

function wideLess(left, right) {
  return wideCompare(left, right) < 0;
}

function wideToBig(left) {
  let whole = 0n;
  for (let limb = 3; limb >= 0; limb -= 1) whole = (whole << 64n) | left[limb];
  return whole;
}

function wideFromBig(whole) {
  const out = [];
  let rest = whole & (WIDE_MODULUS - 1n);
  for (let limb = 0; limb < 4; limb += 1) {
    out.push(rest & 0xffffffffffffffffn);
    rest >>= 64n;
  }
  return out;
}

function wideDiv(left, right) {
  return wideFromBig(wideToBig(left) / wideToBig(right));
}

function wideMod(left, right) {
  return wideFromBig(wideToBig(left) % wideToBig(right));
}

function wideText(left) {
  return wideToBig(left).toString();
}
`;

/**
 * The helpers the services that write text and read JSON need.
 */
const RUNTIME_TEXT = `
function writeNumber(text, buffer, size) {
  const count = Number(size);
  if (count === 0) return 0n;
  const bytes = new TextEncoder().encode(text);
  const written = bytes.length < count - 1 ? bytes.length : count - 1;
  new Uint8Array(memory.buffer, buffer, written).set(bytes.subarray(0, written));
  new Uint8Array(memory.buffer, buffer + written, 1)[0] = 0;
  return BigInt(written);
}

function jsonValue(value) {
  if (value === null || value === undefined) return { kind: "null" };
  if (typeof value === "number") return { kind: "number", number: value };
  if (typeof value === "boolean") return { kind: "bool", number: value ? 1 : 0 };
  if (typeof value === "string") return { kind: "text", text: value };
  if (Array.isArray(value)) return { kind: "array", items: value.map((item) => dynRegister(jsonValue(item))) };
  return { kind: "object", value: value };
}

function jsonText(value) {
  const boxed = dynLookup(value);
  return JSON.stringify(boxed === null ? value : boxed.value);
}
`;

/**
 * The helpers the services that hash need: an MD5 of the text a hasher was
 * fed, which is the digest the C runtime writes.
 */
const RUNTIME_HASH = `
function md5(text) {
  return createHash("md5").update(text, "utf8").digest("hex");
}
`;

/**
 * The source of the runtime the host carries, with the services the module
 * imported and nothing else.
 */
export function hostRuntimeSource(services: readonly string[]): string {
  const wanted = new Set(services);
  const parts: string[] = [RUNTIME_HELPERS];
  const wide = services.filter((symbol) => symbol.startsWith("blaze_rt_u256_") || symbol === "blaze_rt_print_u256");
  if (wide.length > 0) parts.push(RUNTIME_WIDE);
  const text = services.filter(
    (symbol) =>
      symbol.startsWith("blaze_rt_json_") ||
      symbol === "blaze_rt_to_text" ||
      symbol === "blaze_rt_format_number" ||
      symbol === "blaze_rt_format_number_fixed",
  );
  if (text.length > 0) parts.push(RUNTIME_TEXT);
  const hash = services.filter((symbol) => symbol.startsWith("blaze_rt_md5_"));
  if (hash.length > 0) parts.push(RUNTIME_HASH);
  for (const part of RUNTIME_SERVICES) {
    if (part.service === null) continue;
    if (!wanted.has(part.service)) continue;
    parts.push(part.source);
  }
  return parts.join("\n");
}

/** The services the runtime source implements, which is what the host can offer. */
export const IMPLEMENTED_SERVICES: readonly string[] = RUNTIME_SERVICES.map((part) => part.service).filter((symbol): symbol is string => symbol !== null);

/**
 * The Nim host runtime.
 *
 * A build with `runtime: nim` produces three compiler-owned Nim files in the
 * project work directory: the adapter that implements the blaze runtime ABI on
 * Nim's allocator, the host program that drives verification and benchmarking
 * over the harness protocol, and nothing else. The candidate object is linked
 * into the host, so the delivered program is a Nim program whose only foreign
 * code is the contracted function.
 *
 * The host speaks exactly the protocol the C harness speaks, so the verifier
 * and the benchmark never learn which runtime a candidate was built against.
 */

import { writeFile } from "node:fs/promises";
import { CompilerError } from "../core/errors.ts";
import { run } from "../core/process.ts";
import { EXECUTABLE_SUFFIX, nimOptimizationOptions } from "../core/target.ts";
import { isFloatType, parseType, typeToString } from "../semantics/contract.ts";
import { cDeclarationType } from "../toolchain/linker.ts";
import type { BuildMode, FunctionContract, FunctionParam, ObjectLayout, Runner, TypeExpr } from "../core/types.ts";
import { RUNTIME_ANCHOR, RUNTIME_NAME } from "./abi.ts";
import { symbolOf } from "../semantics/contract.ts";

/* -------------------------------------------------------------------------- */
/* Type mapping                                                               */
/* -------------------------------------------------------------------------- */

const NIM_PRIMITIVES: Record<string, string> = {
  bool: "bool",
  i8: "int8",
  i16: "int16",
  i32: "int32",
  i64: "int64",
  u8: "uint8",
  u16: "uint16",
  u32: "uint32",
  u64: "uint64",
  f32: "float32",
  f64: "float64",
  usize: "csize_t",
  isize: "clong",
};

const NIM_ELEMENT_SIZES: Record<string, number> = {
  bool: 1,
  i8: 1,
  i16: 2,
  i32: 4,
  i64: 8,
  u8: 1,
  u16: 2,
  u32: 4,
  u64: 8,
  f32: 4,
  f64: 8,
  usize: 8,
  isize: 8,
};

type BufferType = Extract<TypeExpr, { kind: "ptr" | "slice" | "array" }>;

function isBuffer(type: TypeExpr): type is BufferType {
  return type.kind === "ptr" || type.kind === "slice" || type.kind === "array";
}

function isSigned(type: TypeExpr): boolean {
  return type.kind === "primitive" && (type.name === "isize" || type.name.startsWith("i"));
}

function isFloat(type: TypeExpr): boolean {
  return type.kind === "primitive" && isFloatType(type.name);
}

function hostError(message: string, detail?: string, functionName?: string): CompilerError {
  return new CompilerError({ category: "LinkError", stage: "host", message, function: functionName, detail });
}

function elementNimType(type: TypeExpr): string {
  if (type.kind !== "primitive") {
    throw hostError(`the host program cannot hold a ${typeToString(type)} element`);
  }
  const nim = NIM_PRIMITIVES[type.name];
  if (nim === undefined) throw hostError(`the host program cannot hold a ${type.name} element`);
  return nim;
}

function elementSize(type: TypeExpr): number {
  if (type.kind !== "primitive") throw hostError(`the host program cannot size a ${typeToString(type)} element`);
  const size = NIM_ELEMENT_SIZES[type.name];
  if (size === undefined) throw hostError(`the host program cannot size a ${type.name} element`);
  return size;
}

export function nimType(type: TypeExpr): string {
  // A reference is one pointer, named after the object it points at when the
  // contract lays that object out.
  if (type.kind === "ref") return type.name === undefined ? "pointer" : `ptr ${type.name}`;
  if (type.kind === "void") return "void";
  if (isBuffer(type)) return `ptr ${elementNimType(type.of)}`;
  return elementNimType(type);
}

/** The names Nim reserves, and the names the generated Nim hosts hold. */
const NIM_RESERVED: Record<string, true> = {
  addr: true,
  and: true,
  as: true,
  asm: true,
  bind: true,
  block: true,
  break: true,
  case: true,
  cast: true,
  concept: true,
  const: true,
  continue: true,
  converter: true,
  defer: true,
  discard: true,
  distinct: true,
  div: true,
  do: true,
  elif: true,
  else: true,
  end: true,
  enum: true,
  except: true,
  export: true,
  finally: true,
  for: true,
  from: true,
  func: true,
  if: true,
  import: true,
  in: true,
  include: true,
  interface: true,
  is: true,
  isnot: true,
  iterator: true,
  let: true,
  macro: true,
  method: true,
  mixin: true,
  mod: true,
  nil: true,
  not: true,
  object: true,
  of: true,
  or: true,
  out: true,
  proc: true,
  ptr: true,
  raise: true,
  ref: true,
  return: true,
  shl: true,
  shr: true,
  static: true,
  template: true,
  try: true,
  tuple: true,
  type: true,
  using: true,
  var: true,
  when: true,
  while: true,
  xor: true,
  yield: true,
  result: true,
  stdout: true,
  programArguments: true,
  runtimeAbi: true,
};

/**
 * A source name Nim can hold. One that is not an identifier is prefixed and
 * one that is a Nim keyword, or a name a generated host holds, takes a
 * suffix: neither spelling parses, so the whole program would fail to build.
 */
export function nimName(name: string): string {
  // A character that cannot be in an identifier is replaced rather than only
  // prefixed: `field_my-field` is not an identifier either, and the program
  // failed to build on the name that was meant to stand in for it.
  const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `field_${name.replace(/[^A-Za-z0-9_]/g, "_")}`;
  return NIM_RESERVED[identifier] === true ? `${identifier}_` : identifier;
}

/** The Nim object types a contract lays out, in the order the contract names them. */
export function nimObjectDeclarations(objects: Record<string, ObjectLayout>): string {
  return Object.values(objects)
    .map((object) => {
      const fields = object.fields
        .map((field) => `    ${nimName(field.name)}*: ${nimType(parseType(field.type))}`)
        .join("\n");
      return `type\n  ${object.name}* = ref object of RootObj\n${fields}`;
    })
    .join("\n");
}

/**
 * The text of a data string as a Nim literal holds it. A triple quoted Nim
 * string is raw, so a backslash and a quote in it stand for themselves:
 * escaping them wrote two characters where the data had one. Nothing is
 * escaped, and a `"""` cannot be written in a raw string at all, so text that
 * carries one is refused rather than cut short at the first of them.
 */
export function nimRawString(text: string): string {
  if (text.includes('"""')) {
    throw hostError("the example run cannot be held in a Nim string literal", 'the text carries a triple quote');
  }
  return text;
}

/* -------------------------------------------------------------------------- */
/* The adapter                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The Nim implementation of the runtime ABI, generated from abi.ts.
 *
 * A `danger` build leaves the guards out here exactly as it does in the C
 * runtime: the magic number, the overflow check, the caps and the null checks
 * are the only run-time safety checks a hosted program carries, and the two
 * runtimes agree on which of them a mode removes.
 */
export function generateRuntimeAdapterSource(mode: BuildMode = "debug"): string {
  const guarded = mode !== "danger";
  return `## Generated by the blaze compiler. Do not edit.
## The Nim host runtime adapter: the blaze runtime ABI on Nim's allocator.
import std/[strutils, math]

type
  BlazeHeader = object
    magic: uint64
    base: pointer
    length: uint64
    alignment: uint64
    refs: uint64
    capacity: uint64 ## payload bytes the block can hold, at least length

const
  BlazeMagic = 0x424C415A45525400'u64
  BlazeFreed = 0'u64
  BlazeHeaderSize = 48'u64
  BlazeDefaultAlignment = 16'u64
  BlazeMaxAllocation = 1'u64 shl 40

proc alignUp(value, alignment: uint64): uint64 =
  (value + alignment - 1) and not (alignment - 1)

proc headerOf(pointer: pointer): ptr BlazeHeader =
  cast[ptr BlazeHeader](cast[uint](pointer) - BlazeHeaderSize)

## The message of the last blaze_rt_raise, borrowed by blaze_rt_last_error.
var blazeLastError = ""

## Stops the process where the C runtime would. A candidate is an assembler
## object with no Nim exception handler, so a raise here finds nothing to
## unwind: control returns to the instruction after the candidate's call and
## the function carries on with whatever was wrong. Exit is the only way to
## stop there, and it is what the C runtime does.
proc blazeStop(message: string) {.noreturn.} =
  stderr.write("blaze: " & message & "\\n")
  stderr.flushFile()
  quit(2)

${guarded ? `proc check(pointer: pointer, who: string): ptr BlazeHeader =
  if pointer == nil:
    blazeStop(who & ": null pointer")
  result = headerOf(pointer)
  if result[].magic != BlazeMagic:
    blazeStop(who & ": not a live blaze pointer")
  if result[].alignment == 0 or (result[].alignment and (result[].alignment - 1)) != 0:
    blazeStop(who & ": corrupt blaze header")

## The size of count elements, refused when the product would leave the range
## the runtime hands out: a wrapped size allocates a block far smaller than the
## array the caller is about to write into, so the first element ends up
## corrupting the heap.
proc arrayBytes(count, elementSize: csize_t, who: string): csize_t =
  if elementSize != 0 and count.uint64 > BlazeMaxAllocation div elementSize.uint64:
    blazeStop(who & ": request too large")
  result = (count.uint64 * elementSize.uint64).csize_t` : `proc check(pointer: pointer, who: string): ptr BlazeHeader =
  headerOf(pointer)

proc arrayBytes(count, elementSize: csize_t, who: string): csize_t =
  result = (count.uint64 * elementSize.uint64).csize_t`}

proc blaze_rt_initialize*() {.exportc, cdecl.} =
  discard

proc blaze_rt_finalize*() {.exportc, cdecl.} =
  discard

## A block with room for the payload asked for, and optionally cleared.
##
## The per-thread allocator is used rather than the shared one. The shared heap
## takes a lock, and nothing in this ABI creates a thread or hands a block to
## one, so every allocation was paying a lock for a heap nothing contends with.
proc blazeBlock(bytes, alignment: uint64, cleared: bool): pointer =
  let align = if alignment == 0: BlazeDefaultAlignment else: alignment
  ## The payload is placed with a mask, which only places it for a power of two,
  ## and an alignment past the cap names no block the runtime can give. The
  ## alignment is added to the size on top of the payload rather than taken out
  ## of the slack the allocator leaves: those bytes are what a read past the
  ## end of an array lands on, the program is allowed to make that read, and
  ## the source language answers it as a zero.
  let total = bytes + align + BlazeHeaderSize
${guarded ? `  if total > BlazeMaxAllocation:
    blazeStop("allocation: request too large")` : ""}
  let base = if cleared: alloc0(int(total)) else: alloc(int(total))
${guarded ? `  if base == nil:
    blazeStop("allocation: out of memory")` : ""}
  let payload = alignUp(cast[uint](base) + BlazeHeaderSize, align)
  var header = BlazeHeader(magic: BlazeMagic, base: base, length: bytes,
                           alignment: align, refs: 1, capacity: bytes)
  cast[ptr BlazeHeader](payload - BlazeHeaderSize)[] = header
  cast[pointer](payload)

proc blaze_rt_allocate*(bytes: csize_t): pointer {.exportc, cdecl.} =
  blazeBlock(bytes.uint64, BlazeDefaultAlignment, true)

proc blaze_rt_allocate_uninitialized*(bytes: csize_t): pointer {.exportc, cdecl.} =
  blazeBlock(bytes.uint64, BlazeDefaultAlignment, false)

proc blaze_rt_object_new*(bytes, alignment: csize_t): pointer {.exportc, cdecl.} =
${guarded ? `  let align = if alignment == 0: BlazeDefaultAlignment else: alignment.uint64
  if (align and (align - 1)) != 0:
    blazeStop("blaze_rt_object_new: alignment must be a power of two")
  # The payload starts at the first aligned address past the header, so the
  # block has to cover the gap that alignment leaves as well as the bytes it
  # holds: sizing it by the bytes alone returns a pointer past the end of the
  # allocation. The header follows the payload, so it is written there too.
  # An alignment at the cap makes the budget below wrap, which turns the guard
  # into the whole uint64 range and lets a total that wraps into a small
  # allocation through, with the payload then placed past the block that was
  # actually mapped. The cap has to leave room for the header too.
  if align > BlazeMaxAllocation - BlazeHeaderSize:
    blazeStop("blaze_rt_object_new: alignment is too large")
  if bytes.uint64 > BlazeMaxAllocation - align - BlazeHeaderSize:
    blazeStop("blaze_rt_object_new: request too large")
  ## Cleared for the same reason an array is: a program may read a field it
  ## never wrote, and a zeroed block is what answers that read the way the
  ## source language does.
  blazeBlock(bytes.uint64, align, true)` : `  blazeBlock(bytes.uint64, if alignment == 0: BlazeDefaultAlignment else: alignment.uint64, true)`}

proc blaze_rt_retain*(pointer: pointer): pointer {.exportc, cdecl.} =
${guarded ? "  if pointer == nil:\n    return nil" : ""}
  inc check(pointer, "blaze_rt_retain")[].refs
  pointer

proc blaze_rt_release*(pointer: pointer) {.exportc, cdecl.} =
${guarded ? "  if pointer == nil:\n    return" : ""}
  let header = check(pointer, "blaze_rt_release")
  if header[].refs > 1:
    dec header[].refs
    return
  let base = header[].base
${guarded ? "  header[].magic = BlazeFreed" : ""}
  dealloc(base)

proc blaze_rt_reallocate*(pointer: pointer, bytes: csize_t): pointer {.exportc, cdecl.} =
${guarded ? `  if pointer == nil:
    return blaze_rt_allocate(bytes)` : ""}
  let header = check(pointer, "blaze_rt_reallocate")
  let previous = header[]
  ## A block asked to grow into room it already has is already that block, which
  ## is what makes a geometric growth policy free: the first append over a
  ## literal allocates once and every later one lands here.
  if bytes.uint64 <= previous.capacity:
    if bytes.uint64 > previous.length:
      zeroMem(cast[pointer](cast[uint](pointer) + previous.length), int(bytes.uint64 - previous.length))
    header[].length = bytes.uint64
    return pointer
  ## Doubling is what keeps a loop of appends from being quadratic. The request
  ## is a floor rather than a target.
  let wanted = previous.capacity + previous.capacity div 2 + 16
  let grown = blazeBlock(if bytes.uint64 < wanted: wanted else: bytes.uint64, previous.alignment, true)
  ## A fresh block can align its payload differently, so the bytes travel to
  ## where the new header says they are rather than staying where they were.
  if previous.length > 0:
    copyMem(grown, pointer, int(previous.length))
  blaze_rt_release(pointer)
  result = grown

proc blaze_rt_string_new*(bytes: pointer, length: csize_t): cstring {.exportc, cdecl.} =
  ## The whole payload is written below, terminator included, so the block is
  ## not cleared first.
  let storage = blaze_rt_allocate_uninitialized(length.csize_t + 1)
  if length > 0:
    copyMem(storage, bytes, int(length))
  cast[ptr UncheckedArray[char]](storage)[int(length)] = '\\0'
  cast[cstring](storage)

proc blaze_rt_string_length*(text: cstring): csize_t {.exportc, cdecl.} =
${guarded ? "  if text == nil:\n    return 0" : ""}
  check(cast[pointer](text), "blaze_rt_string_length")[].length - 1

## The length of any string, managed or written out as a literal. A managed
## string is measured from the header in front of it; a literal has no header,
## so the magic word is what tells the two apart and a literal is scanned.
proc blaze_rt_text_length*(text: cstring): csize_t {.exportc, cdecl.} =
  if text == nil: return 0
  let header = headerOf(cast[pointer](text))
  if header[].magic == BlazeMagic: return csize_t(header[].length - 1)
  ## A literal has no header, so it is scanned, which is what the C runtime
  ## falls back to as well. The length of a cstring is its len.
  csize_t(text.len)

proc blaze_rt_string_clone*(text: cstring): cstring {.exportc, cdecl.} =
  blaze_rt_string_new(cast[pointer](text), blaze_rt_string_length(text))

proc blaze_rt_string_append*(left, right: cstring): cstring {.exportc, cdecl.} =
  ## The left string is a value the program can still be holding, so it is only
  ## written into when it is a managed block nothing else refers to. A literal
  ## the compiler wrote out has no block to grow and a shared one has a reader
  ## that would see the append, so both are copied into a block of their own,
  ## and it is that copy which the later appends grow. Growing a block in place
  ## is what makes a loop of appends linear rather than quadratic in the bytes
  ## copied.
  if left == nil:
    return if right == nil: blaze_rt_string_new(nil, 0) else: blaze_rt_string_new(cast[pointer](right), blaze_rt_text_length(right))
  if right == nil:
    return blaze_rt_string_new(cast[pointer](left), blaze_rt_text_length(left))
  let leftLength = blaze_rt_text_length(left)
  let rightLength = blaze_rt_text_length(right)
  let wanted = leftLength + rightLength + 1
  let header = headerOf(cast[pointer](left))
  var owner: cstring
  if header[].magic == BlazeMagic and header[].refs == 1:
    ## This block is the caller's alone, so it can be written into. A resize
    ## that fits the capacity it has is the same block, and one that does not
    ## grows it to at least half again as much.
    owner = cast[cstring](blaze_rt_reallocate(cast[pointer](left), wanted))
  else:
    let room = leftLength * 2 + 16
    owner = cast[cstring](blaze_rt_allocate_uninitialized(if wanted < room: room.csize_t else: wanted))
    copyMem(cast[pointer](owner), left, int(leftLength))
  if rightLength > 0:
    copyMem(cast[pointer](cast[uint](owner) + leftLength), right, int(rightLength))
  cast[ptr UncheckedArray[char]](owner)[int(wanted - 1)] = '\\0'
  owner

proc blaze_rt_array_new*(count, elementSize: csize_t): pointer {.exportc, cdecl.} =
  ## Cleared, and deliberately so. A program is allowed to read past what it
  ## filled: a while loop over an array runs until the read comes back
  ## false, and a cleared block is what makes that read false rather than
  ## whatever the allocator handed back. The source language answers the same
  ## read as nothing, so zeroing is what agrees with it, and there is no bounds
  ## check to answer it with: the IR holds no length for an element access.
  blaze_rt_allocate(arrayBytes(count, elementSize, "blaze_rt_array_new"))

proc blaze_rt_array_resize*(pointer: pointer, count, elementSize: csize_t): pointer {.exportc, cdecl.} =
  blaze_rt_reallocate(pointer, arrayBytes(count, elementSize, "blaze_rt_array_resize"))

proc blaze_rt_object_size*(pointer: pointer): csize_t {.exportc, cdecl.} =
${guarded ? "  if pointer == nil:\n    return 0" : ""}
  check(pointer, "blaze_rt_object_size")[].length

proc blaze_rt_last_error*(): cstring {.exportc, cdecl.} =
  blazeLastError.cstring

var blazeArguments: seq[float64] = @[]

proc blaze_rt_arguments_set*(values: ptr UncheckedArray[float64], count: csize_t) {.exportc, cdecl.} =
  blazeArguments = newSeq[float64](int(count))
  for index in 0 ..< int(count):
    blazeArguments[index] = values[index]

proc blaze_rt_argv_count*(): csize_t {.exportc, cdecl.} =
  ## The length process.argv has, counting where the program runs and the file
  ## it runs before the arguments it was given.
  csize_t(blazeArguments.len + 2)

proc blaze_rt_argv*(index: csize_t): float64 {.exportc, cdecl.} =
  ## The index is the one process.argv uses, which counts where node runs
  ## and the file it runs, so the first argument the program was given is 2.
  let argument = int(index) - 2
  if argument >= 0 and argument < blazeArguments.len: blazeArguments[argument] else: 0.0

proc blaze_rt_print_text*(text: cstring) {.exportc, cdecl.} =
  if text != nil: stdout.write($text)

## The shortest decimal that reads back as the value, placed the way the source
## language places it: in full from 1e-6 up to 1e21, and in exponential form
## outside that range. A value that is not finite has no shortest decimal, so
## it is written as the language writes it, and a negative zero keeps its sign.
proc blazeShortest(value: float64): string =
  if classify(value) == fcNan: return "NaN"
  if classify(value) in {fcInf, fcNegInf}: return if value < 0.0: "-Infinity" else: "Infinity"
  if value == 0.0: return (if classify(value) == fcNegZero: "-0" else: "0")
  let negative = value < 0.0
  let magnitude = if negative: -value else: value

  var text = ""
  var precision = 0
  while precision < 17:
    text = formatBiggestFloat(magnitude, ffScientific, precision)
    if parseFloat(text) == magnitude: break
    inc precision
  if precision == 17:
    text = formatBiggestFloat(magnitude, ffScientific, 16)

  let marker = text.find('e')
  var digits = text[0 ..< marker]
  digits = digits.replace(".", "")
  let exponent = parseInt(text[marker + 1 .. ^1]).int
  let point = exponent + 1

  var body = ""
  if point >= -5 and point <= 21:
    if point <= 0:
      body = "0." & repeat('0', -point) & digits
    elif point >= digits.len:
      body = digits & repeat('0', point - digits.len)
    else:
      body = digits[0 ..< point] & "." & digits[point .. ^1]
  else:
    body = digits[0 .. 0]
    if digits.len > 1: body = body & "." & digits[1 .. ^1]
    let power = point - 1
    body = body & "e" & (if power < 0: "-" else: "+") & $abs(power)
  (if negative: "-" else: "") & body

proc blaze_rt_print_number*(value: float64) {.exportc, cdecl.} =
  stdout.write(blazeShortest(value))

proc blaze_rt_format_number*(value: float64, buffer: ptr uint8, size: csize_t): csize_t {.exportc, cdecl.} =
  let text = blazeShortest(value)
  if size == 0:
    return 0
  # The length the ABI promises is the number of bytes written, so a caller
  # that sizes or walks a buffer by it never steps past the end of its own.
  let written = min(csize_t(text.len), size - 1)
  if written > 0: copyMem(buffer, unsafeAddr text[0], int(written))
  cast[ptr UncheckedArray[uint8]](buffer)[int(written)] = 0
  written

proc blaze_rt_print_newline*() {.exportc, cdecl.} =
  stdout.write("\\n")

proc blaze_rt_raise*(message: cstring) {.exportc, cdecl, noreturn.} =
  blazeLastError = if message == nil: "" else: $message
  blazeStop(blazeLastError)
`;
}

/* -------------------------------------------------------------------------- */
/* The host program                                                           */
/* -------------------------------------------------------------------------- */

const HOST_PRELUDE = `## Generated by the blaze compiler. Do not edit.
## The Nim host program for a blaze build.
import std/[strutils, monotimes, streams, posix, os, math]
import ${RUNTIME_NAME}

proc fail(message: string) =
  stderr.write("harness: " & message & "\\n")
  quit(2)

var demoStream: Stream
var demoActive = false

proc readLineOrEof(line: var string): bool =
  if demoActive:
    return readLine(demoStream, line)
  try:
    line = stdin.readLine()
    result = true
  except EOFError:
    result = false

proc nextLine(tokens: var seq[string]): bool =
  var line: string
  while true:
    if not readLineOrEof(line):
      return false
    if line.strip.len != 0:
      break
  tokens = line.splitWhitespace()
  result = true

proc nextLineAllowingBlank(tokens: var seq[string]): bool =
  var line: string
  if not readLineOrEof(line):
    return false
  tokens = line.splitWhitespace()
  result = true

proc nowNs(): int64 =
  getMonoTime().ticks.int64
`;

/** Nim that reads one scalar from a token, with the C harness semantics. */
function scalarRead(type: TypeExpr, name: string, token: string): string {
  if (type.kind === "primitive" && type.name === "bool") {
    return `${name} = (${token}[0] == 't' or ${token}[0] == '1')`;
  }
  if (isFloat(type)) {
    return `${name} = ${nimType(type)}(parseFloat(${token}))`;
  }
  if (isSigned(type)) {
    return `${name} = ${nimType(type)}(parseBiggestInt(${token}))`;
  }
  return `${name} = ${nimType(type)}(parseBiggestUInt(${token}))`;
}

/**
 * Nim that prints one result value, in the form the verifier parses.
 *
 * `ffDecimal` counts the digits *after the point*, so a correct result of
 * 1e-18 printed as seventeen zeroes and read back as zero, and one of 1e300
 * printed three hundred and eighteen characters wide. The C harness prints
 * seventeen *significant* digits, and the verifier reads a double off
 * whichever host ran, so this prints those: a form that reads back as the
 * double the candidate computed.
 */
function resultPrint(type: TypeExpr, expression: string): string {
  if (isFloat(type)) return `stdout.write("RESULT " & formatBiggestFloat(float64(${expression}), ffScientific, 17) & "\\n")`;
  if (type.kind === "primitive" && type.name === "bool") {
    return `stdout.write(if ${expression}: "RESULT 1\\n" else: "RESULT 0\\n")`;
  }
  return `stdout.write("RESULT " & $${expression} & "\\n")`;
}

/** The value a benchmark accumulates, as a float. */
function sinkValue(type: TypeExpr, expression: string): string {
  if (type.kind === "primitive" && type.name === "bool") return `(if ${expression}: 1.0 else: 0.0)`;
  return `float64(${expression})`;
}

function parameterStorage(type: TypeExpr, name: string): string[] {
  if (!isBuffer(type)) return [`var ${name}_value: ${nimType(type)}`];
  return [
    `var ${name}_storage: ptr UncheckedArray[${elementNimType(type.of)}]`,
    `var ${name}_count: csize_t`,
  ];
}

/** Reads the header line of the next vector into the parameters. */
function headerReader(types: readonly TypeExpr[], names: readonly string[]): string {
  // A vector of a function that takes nothing is an empty line, so a blank one
  // is only a line to skip where there are arguments on it to read.
  const body: string[] = [
    "  var tokens: seq[string]",
    types.length > 0
      ? "  if not nextLine(tokens): return false"
      : "  if not nextLineAllowingBlank(tokens): return false",
  ];
  types.forEach((type, index) => {
    const name = names[index];
    if (!isBuffer(type)) {
      body.push(`  if tokens.len < ${index + 1}: fail("missing value for ${name}")`);
      body.push(`  ${scalarRead(type, `${name}_value`, `tokens[${index}]`)}`);
      return;
    }
    const fixed = type.kind === "array" && type.length !== null ? type.length : null;
    body.push(`  if tokens.len < ${index + 1}: fail("missing length for ${name}")`);
    body.push(`  let declared_${name} = parseBiggestInt(tokens[${index}])`);
    if (fixed !== null) {
      body.push(`  if declared_${name} != ${fixed}: fail("${name} must have length ${fixed}")`);
    }
    body.push(
      `  ${name}_count = (if declared_${name} < 0: 0 else: csize_t(declared_${name}))`,
    );
    // The previous vector's block is released before the next one overwrites
    // the pointer: a reader that runs once per vector would otherwise keep
    // every block but the last, up to the cap below each time. The storage is
    // empty on the first header and whenever a vector declares no length, and
    // the runtime only ignores a null pointer while its guards are in, so the
    // host never hands it one.
    body.push(`  if ${name}_storage != nil: ${RUNTIME_NAME}_release(cast[pointer](${name}_storage))`);
    body.push(`  ${name}_storage = nil`);
    body.push(`  if declared_${name} >= 0:`);
    body.push(`    if ${name}_count > (1'u64 shl 28).csize_t: fail("buffer too large")`);
    body.push(`    if ${name}_count != 0:`);
    body.push(
      `      ${name}_storage = cast[ptr UncheckedArray[${elementNimType(type.of)}]](\n` +
        `        ${RUNTIME_NAME}_allocate(${name}_count * ${elementSize(type.of)}))`,
    );
  });
  return body.join("\n");
}

/** Reads one data line per buffer parameter of the current vector. */
function dataReader(types: readonly TypeExpr[], names: readonly string[]): string {
  const body: string[] = [];
  types.forEach((type, index) => {
    if (!isBuffer(type)) return;
    const name = names[index];
    body.push(`  if ${name}_count != 0:`);
    body.push(`    var tokens: seq[string]`);
    body.push(`    if not nextLine(tokens): fail("missing data for ${name}")`);
    body.push(`    if tokens.len < int(${name}_count): fail("truncated data for ${name}")`);
    body.push(`    for element in 0 ..< int(${name}_count):`);
    body.push(`      ${scalarRead(type.of, `${name}_storage[element]`, `tokens[element]`)}`);
  });
  return body.join("\n");
}

/** Releases every buffer the host allocated for the last vector. */
function bufferRelease(types: readonly TypeExpr[], names: readonly string[]): string {
  return types
    .map((type, index) =>
      isBuffer(type)
        ? `  if ${names[index]}_storage != nil: ${RUNTIME_NAME}_release(cast[pointer](${names[index]}_storage))`
        : "",
    )
    .filter((line) => line !== "")
    .join("\n");
}

function callExpression(contract: FunctionContract, types: readonly TypeExpr[], names: readonly string[]): string {
  const callArguments = names.map((name, index) =>
    isBuffer(types[index]) ? `cast[ptr ${elementNimType(types[index]!.of)}](${name}_storage)` : `${name}_value`,
  );
  return `${symbolOf(contract)}(${callArguments.join(", ")})`;
}

/** The Nim host program: the same protocol as the C harness, on Nim. */
export function generateHostSource(contract: FunctionContract, demoRequest: string): string {
  const name = symbolOf(contract);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw hostError("the contract function name is not a valid identifier", undefined, name);
  }
  const returns = parseType(contract.function.returns);
  if (isBuffer(returns)) throw hostError("a pointer return type cannot be called from the host", undefined, name);
  const types = contract.function.params.map((param: FunctionParam) => parseType(param.type));
  // The C declaration spells the names the contract gives, because that is
  // the ABI. The Nim side is free of them: a parameter is a local name in Nim
  // however the C one is spelled, so it goes through `nimName`. A parameter
  // the source called `type` or `result` named a Nim keyword, and the whole
  // host failed to build.
  const cNames = contract.function.params.map((param) => param.name);
  const names = cNames.map(nimName);
  const cParameters = types.map((type, index) => `${cDeclarationType(type)} ${cNames[index]}`).join(", ");
  const nimParameters = names.map((name, index) => `${name}: ${nimType(types[index]!)}`).join(", ");
  const declaration = `extern ${cDeclarationType(returns)} ${name}(${cParameters || "void"});`;
  const invocation = callExpression(contract, types, names);
  const anchor = RUNTIME_ANCHOR.map((symbol) => `  cast[pointer](${symbol}),`).join("\n");
  // A `ref` parameter is named after the object it points at, so the types the
  // contract lays out are declared before the signature that spells them.
  const objects = nimObjectDeclarations(contract.definition.objects);

  return `${HOST_PRELUDE}
{.emit: """
${declaration}
""".}

${objects}

proc ${name}(${nimParameters}): ${nimType(returns)} {.importc: "${name}", nodecl.}

${types.map((type, index) => parameterStorage(type, names[index]!).join("\n")).join("\n")}

proc readHeader(): bool =
${headerReader(types, names)}
  result = true

proc readData() =
${dataReader(types, names)}

const demoRequestText = """
${nimRawString(demoRequest)}"""


proc main() =
  # Every entry point is named here, so the linker keeps the ones a candidate
  # calls even when this program does not call them itself.
  let runtimeAbi = [
${anchor}
  ]
  discard runtimeAbi.len
  # A terminal means a person ran the program, so it runs the example instead
  # of waiting for vectors that will never arrive. A pipe is the compiler
  # driving it, and keeps the protocol exactly as it was.
  if posix.isatty(0) != 0:
    stdout.write("no input given: running ${name} on a built-in example vector\\n")
    demoStream = newStringStream(demoRequestText)
    demoActive = true

  var tokens: seq[string]
  if not nextLine(tokens): fail("empty input")
  if tokens.len == 0: fail("empty input")
  let benchMode = tokens[0] == "bench"
  var iterations = 1'i64
  if benchMode:
    if tokens.len < 2: fail("bench requires an iteration count")
    iterations = parseBiggestInt(tokens[1]).int64
    if iterations <= 0: fail("bench requires a positive iteration count")
  elif tokens[0] != "run":
    fail("expected mode run or bench")

  ${RUNTIME_NAME}_initialize()
  if not readHeader(): fail("no test vector")
  readData()

  if not benchMode:
    var calls = 0
    while true:
      let value = ${invocation}
      ${resultPrint(returns, "value")}
      stdout.flushFile()
      calls += 1
      if not readHeader(): break
      readData()
    if calls == 0: fail("no test vectors")
  else:
    var sink = 0.0
    let start = nowNs()
    for _ in 0 ..< iterations:
      let value = ${invocation}
      sink += ${sinkValue(returns, "value")}
    let elapsed = nowNs() - start
    stdout.write("BENCH " & $elapsed & " " & formatBiggestFloat(sink, ffScientific, 17) & "\\n")

${bufferRelease(types, names)}
  ${RUNTIME_NAME}_finalize()

main()
`;
}

/* -------------------------------------------------------------------------- */
/* Building the host                                                          */
/* -------------------------------------------------------------------------- */

export interface HostRequest {
  contract: FunctionContract;
  /** Directory the adapter, host and executable are written to. */
  workDirectory: string;
  /** Name of the candidate being hosted, used for the executable. */
  candidate: string;
  /** The candidate object the host links against. */
  objectPath: string;
  /** The example run the program performs when started with no input. */
  demoRequest: string;
  /** How hard the build goes, which is what the host is compiled at. */
  mode: BuildMode;
}

export interface HostResult {
  runner: Runner;
  /** The host program, which is what a hosted build delivers. */
  hostPath: string;
  adapterPath: string;
}

/** Compiles the adapter and the host, and links the candidate object in. */
export async function buildHostProgram(request: HostRequest): Promise<HostResult> {
  const functionName = request.contract.function.name;
  const base = `${request.workDirectory}/${request.candidate}`;
  const adapterPath = `${request.workDirectory}/${RUNTIME_NAME}.nim`;
  // A Nim module name may not contain a dot, so the host is `<candidate>_host.nim`.
  const hostPath = `${base}_host.nim`;
  // A hosted build delivers the host program, so it takes the executable path a
  // standalone build gives its harness.
  const executable = `${base}${EXECUTABLE_SUFFIX}`;

  await writeFile(adapterPath, generateRuntimeAdapterSource(request.mode), "utf8");
  await writeFile(hostPath, generateHostSource(request.contract, request.demoRequest), "utf8");

  const result = run(
    "nim",
    [
      "c",
      "--hints:off",
      "--warnings:off",
      ...nimOptimizationOptions(request.mode),
      `--nimcache:${request.workDirectory}/nimcache`,
      `--out:${executable}`,
      `--passL:${request.objectPath}`,
      hostPath,
    ],
    { timeoutMs: 600_000 },
  );
  if (result.spawnError !== undefined) {
    throw new CompilerError({
      category: "TargetError",
      stage: "host",
      message: "the Nim compiler is not available",
      detail: `${result.spawnError}\ninstall Nim, or build this project with --runtime none`,
    });
  }
  if (result.code !== 0) {
    throw hostError(
      `the Nim host program for ${functionName} did not build`,
      `${adapterPath}\n${hostPath}\n${result.stderr.trim()}`,
      functionName,
    );
  }
  return { runner: { command: executable, args: [] }, hostPath, adapterPath };
}

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

import { mkdir, writeFile } from "../core/platform.ts";
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

/**
 * The Nim object types a contract lays out, in the order the contract names them.
 *
 * They are written as plain objects rather than as references, and that is what
 * makes them the same bytes on both sides. A Nim `ref object` is a pointer to a
 * cell whose first word is a reference count, so a field the contract puts at `0`
 * is read at `8` and the pointer the C backend returned — a payload, with nothing
 * in front of it — is not the pointer the host holds. Inheriting from `RootObj`
 * adds a vtable in front of the fields on top of that, which put two fields at
 * `8` and `16` where the contract states `0` and `8`.
 *
 * A plain object has neither: its fields are at the offsets the contract states,
 * `sizeof` is the size the runtime allocates, and the extern declaration of a
 * function that builds one — `struct Object1*` — is the same type. The lifetime
 * is the runtime's, exactly as it is on the C side: nothing here is traced,
 * because a value the program keeps is kept by the count in the runtime's own
 * header rather than by a collector walking these objects.
 */
export function nimObjectDeclarations(objects: Record<string, ObjectLayout>): string {
  return Object.values(objects)
    .map((object) => {
      const fields = object.fields
        .map((field) => `    ${nimName(field.name)}*: ${nimType(parseType(field.type))}`)
        .join("\n");
      return `type\n  ${object.name}* = object\n${fields}`;
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
import std/[algorithm, json, osproc, strutils, math, monotimes, random, times, os, posix, sysrand]

type
  BlazeHeader = object
    magic: uint64
    base: pointer
    length: uint64
    alignment: uint64
    refs: uint64
    capacity: uint64 ## payload bytes the block can hold, at least length
    descriptor: pointer ## the field names an object was laid out with, or nil
    reserved: uint64 ## keeps the header a multiple of the default alignment

const
  BlazeMagic = 0x424C415A45525400'u64
  BlazeFreed = 0'u64
  BlazeHeaderSize = 64'u64
  ## The small-block pool, the same one the C runtime keeps. A block is put in
  ## a class by the total it occupies rounded up to the granularity, and the
  ## class is what it is carved as and what it goes back onto when it is
  ## released. Sixteen classes of sixteen bytes reach 256 bytes, which covers
  ## every object a program builds out of fields, every short string and every
  ## small buffer; anything larger is Nim's allocator to give and to take back.
  BlazeSlabGranularity = 16'u64
  BlazeSlabClasses = 16
  BlazeSlabLargest = uint64(BlazeSlabClasses) * BlazeSlabGranularity
  ## How much is asked for at a time. A program that allocates very little
  ## pays for a slab it does not fill, and one that allocates a great deal
  ## reaches the allocator often enough to matter either way.
  BlazeSlabBytes = 256 * 1024
  BlazeDefaultAlignment = 16'u64
  BlazeMaxAllocation = 1'u64 shl 40
  ## The marker a block of a region carries. A block of a region is neither the
  ## host's nor the slab's: the region owns the memory and hands it out again on
  ## the next turn, so a release of one must not put it on the slab's released
  ## list — the slab would hand those bytes out again while the region is still
  ## rewound over them, and two blocks would be live in one piece of memory.
  ## The base of a pooled block is nothing while the block is live and the
  ## address of the next block of its class once it is released, so nothing else
  ## the runtime hands out carries this address.
  BlazeRegionMark = 1'u64

proc alignUp(value, alignment: uint64): uint64 =
  (value + alignment - 1) and not (alignment - 1)

proc headerOf(pointer: pointer): ptr BlazeHeader =
  cast[ptr BlazeHeader](cast[uint](pointer) - BlazeHeaderSize)

## The message of the last blaze_rt_raise, borrowed by blaze_rt_last_error.
var blazeRaisedMessage = ""

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

## The small-block pool, the same one the C runtime keeps: a small cleared
## block is carved out of a slab, and a block that is released goes back onto
## the list of its own class rather than to Nim's allocator. This is where
## most of the time of a program that builds a lot of values goes, and what is
## left after the carve is the first touch of the memory, which no allocator
## can take away.
var
  blazeSlabAt: pointer = nil
  blazeSlabEnd: pointer = nil
  blazeReleased: array[BlazeSlabClasses, ptr BlazeHeader]

## The class a block of total bytes at the given alignment belongs to, counting
## from one, or zero for a block Nim's allocator is asked for. Pooling needs a
## cleared block, because a cleared slab hands out memory that is already zero,
## and an alignment no wider than the granularity, because that is what puts
## the header at a fixed distance from the start of the class.
proc blazeClassOf(total, alignment: uint64): int =
  if total > BlazeSlabLargest or alignment > BlazeSlabGranularity: return 0
  int((total + BlazeSlabGranularity - 1) div BlazeSlabGranularity)

proc blaze_rt_initialize*() {.exportc, cdecl.} =
  discard

proc blaze_rt_finalize*() {.exportc, cdecl.} =
  discard

## A block with room for the payload asked for, and optionally cleared.
##
## A block too large for a class goes to Nim's allocator rather than to a slab.
## That one takes a lock and the pooled path above deliberately does not, so a
## program that allocates a great deal of small values pays for no lock at all.
## The region a turn of a marked loop allocates from: a cursor rewound at the
## top of every turn, so the next tree is written over the one just walked. It
## is the same kind of cursor as a slab and for the same reason it is per
## it is the same kind of cursor as a slab above, and is held the same way the
## slabs are: this host runs the program on one thread, and a cursor shared
## between threads would hand two turns the same block.
var
  blazeRegionBase: pointer = nil
  blazeRegionAt: pointer = nil
  blazeRegionEnd: pointer = nil
  blazeRegionRoom: uint64 = 0
  blazeRegionDepth: uint32 = 0

const BlazeRegionBytes = 4'u64 * 1024'u64 * 1024'u64

proc blazeRegionEnter() =
  ## Only the outermost region rewinds: a turn of a marked loop may call a
  ## function whose own turn is marked too, and rewinding inside that call hands
  ## the outer turn's blocks out a second time while it is still reading them.
  if blazeRegionDepth == 0:
    blazeRegionAt = blazeRegionBase
  inc blazeRegionDepth

proc blazeRegionLeave() =
  ## Saturating, because a turn that leaves early leaves the region early and
  ## the compiler writes the closing call on the path out of the body as well.
  if blazeRegionDepth > 0:
    dec blazeRegionDepth

## A block out of the region that is open, laid out as a block out of a slab is.
proc blazeRegionTake(total, bytes, alignment: uint64, cleared: bool): pointer =
  if (if blazeRegionEnd == nil: 0'u64 else: uint64(cast[uint](blazeRegionEnd) - cast[uint](blazeRegionAt))) < total:
    ## A region that filled up was asked for more room than it had, so the next
    ## one is twice what this one was and never less: a region that asked for the
    ## same size every time it filled would take a fresh block on every turn,
    ## which is the whole thing the region exists to avoid.
    var room = if blazeRegionRoom < BlazeRegionBytes: BlazeRegionBytes else: blazeRegionRoom * 2
    while room < total: room += room
    let fresh = alloc0(int(room) + int(BlazeHeaderSize))
    ## The room is never copied out of the block it was in: a block holds
    ## pointers to the blocks beside it, and moving them would leave every one
    ## aimed at where a block used to be. What the last turn built is abandoned
    ## rather than carried, and it is the right size for whatever needs one.
    if blazeRegionBase != nil and cast[uint](blazeRegionAt) == cast[uint](blazeRegionBase):
      dealloc(blazeRegionBase)
    blazeRegionRoom = room
    blazeRegionBase = fresh
    blazeRegionAt = fresh
    blazeRegionEnd = cast[pointer](cast[uint](fresh) + uint(room))
  let header = blazeRegionAt
  blazeRegionAt = cast[pointer](cast[uint](blazeRegionAt) + uint(total))
  let payload = cast[pointer](cast[uint](header) + BlazeHeaderSize)
  let aligned = cast[pointer]((cast[uint](payload) + uint(alignment) - 1) and not (uint(alignment) - 1))
  cast[ptr BlazeHeader](cast[uint](aligned) - BlazeHeaderSize)[] = BlazeHeader(
    magic: BlazeMagic, base: cast[pointer](BlazeRegionMark), length: bytes,
    alignment: alignment, refs: 1, capacity: bytes, descriptor: nil, reserved: 0)
  if cleared:
    ## Cleared as a whole block rather than as a payload, which is what the C
    ## runtime does and what the comment on blazeBlock below is about: the
    ## bytes between the payload and the end of the block are what a read past
    ## the end of an array lands on. The end of the block is where the cursor
    ## now is, so the clear never reaches into the block after it.
    zeroMem(aligned, int(cast[uint](header) + uint(total) - cast[uint](aligned)))
  cast[pointer](aligned)

proc blazeBlock(bytes, alignment: uint64, cleared: bool): pointer =
  let align = if alignment == 0: BlazeDefaultAlignment else: alignment
  ## The payload is placed with a mask, which only places it for a power of two,
  ## and an alignment past the cap names no block the runtime can give. The
  ## alignment is added to the size on top of the payload rather than taken out
  ## of the slack the allocator leaves: those bytes are what a read past the
  ## end of an array lands on, the program is allowed to make that read, and
  ## the source language answers it as a zero.
${guarded ? `  ## The budget the line below checks against is the cap less the alignment
  ## less the header, and an alignment at the cap leaves that subtraction to
  ## wrap: the guard would read as the whole uint64 range, every request is
  ## under it, and the total computed from it wraps into a small allocation
  ## whose payload is then placed a long way from the block that was mapped.
  ## The check is here rather than after the region branch below because a region
  ## allocation is an allocation, and the C runtime this is the twin of checks
  ## it before it hands the request to the region.
  if align > BlazeMaxAllocation - BlazeHeaderSize:
    blazeStop("allocation: object alignment is too large")
  if bytes > BlazeMaxAllocation - align - BlazeHeaderSize:
    blazeStop("allocation: request too large")` : ""}
  let total = bytes + align + BlazeHeaderSize
  if blazeRegionDepth > 0:
    return blazeRegionTake(total, bytes, align, cleared)
  let cls = if cleared: blazeClassOf(total, align) else: 0
  if cls != 0:
    ## The header of a pooled block is at the start of its class, so the
    ## payload is a fixed distance from it and the class is the whole of what
    ## the block occupies. A block taken off a release list is memory the
    ## program has already written to, so it is cleared here rather than asked
    ## for again, and the header goes down in the same pass.
    var header = blazeReleased[cls - 1]
    if header != nil:
      blazeReleased[cls - 1] = cast[ptr BlazeHeader](header[].base)
      let span = int(cls) * int(BlazeSlabGranularity)
      let clear = cast[ptr UncheckedArray[byte]](header)
      for index in 0 ..< span: clear[index] = 0
    else:
      let span = uint64(cls) * BlazeSlabGranularity
      if (if blazeSlabEnd == nil: 0'u64 else: uint64(cast[uint](blazeSlabEnd) - cast[uint](blazeSlabAt))) < span:
        blazeSlabAt = alloc0(int(BlazeSlabBytes))
${guarded ? `        if blazeSlabAt == nil:
          blazeStop("allocation: out of memory")` : ""}
        blazeSlabEnd = cast[pointer](cast[uint](blazeSlabAt) + uint(BlazeSlabBytes))
      header = cast[ptr BlazeHeader](blazeSlabAt)
      blazeSlabAt = cast[pointer](cast[uint](blazeSlabAt) + uint(span))
    header[] = BlazeHeader(magic: BlazeMagic, base: nil, length: bytes,
      descriptor: nil, reserved: 0,
                           alignment: align, refs: 1, capacity: bytes)
    return cast[pointer](cast[uint](header) + BlazeHeaderSize)
  let base = if cleared: alloc0(int(total)) else: alloc(int(total))
${guarded ? `  if base == nil:
    blazeStop("allocation: out of memory")` : ""}
  let payload = alignUp(cast[uint](base) + BlazeHeaderSize, align)
  var header = BlazeHeader(magic: BlazeMagic, base: base, length: bytes,
                           alignment: align, refs: 1, capacity: bytes, descriptor: nil, reserved: 0)
  cast[ptr BlazeHeader](payload - BlazeHeaderSize)[] = header
  cast[pointer](payload)

proc blaze_rt_allocate*(bytes: csize_t): pointer {.exportc, cdecl.} =
  blazeBlock(bytes.uint64, BlazeDefaultAlignment, true)

proc blaze_rt_allocate_uninitialized*(bytes: csize_t): pointer {.exportc, cdecl.} =
  blazeBlock(bytes.uint64, BlazeDefaultAlignment, false)

proc blaze_rt_region_enter*() {.exportc, cdecl.} =
  ## Begin a region: every block the program allocates until it leaves is taken
  ## from this thread's region cursor, so the next turn of the loop the compiler
  ## proved it for is written over the one this turn built.
  blazeRegionEnter()

proc blaze_rt_region_leave*() {.exportc, cdecl.} =
  ## End the region begun by blaze_rt_region_enter. Nothing is freed: the
  ## cursor keeps where the turn finished and the next region begins at its
  ## start again.
  blazeRegionLeave()

proc blaze_rt_parallel_for*(count: csize_t, turn: proc (frame: pointer, first, last: csize_t) {.cdecl.}, frame: pointer) {.exportc, cdecl.} =
  ## Run the turn over the counters [0, count). This host runs the turns in
  ## order, in one part, on the thread that called: a Nim host would need
  ## --threads:on, which is a compile option of the program rather than
  ## something a runtime entry can turn on for one call, and it would make
  ## every allocation the body does one a lock guards. The mark a loop carries
  ## says its turns do not depend on each other, so running them here is the
  ## same program, which is what a host without threads of its own does.
  turn(frame, 0, count)

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

proc blaze_rt_object_describe*(target: pointer, descriptor: cstring) {.exportc, cdecl.} =
  ## Names the layout an object was laid out with: each field's name, the offset
  ## it sits at and the type it holds.
  if target == nil:
    return
  headerOf(target)[].descriptor = cast[pointer](descriptor)

proc blaze_rt_object_has_field*(target: pointer, field: cstring): float64 {.exportc, cdecl.} =
  ## Whether the object was laid out with a field of this name.
  if target == nil or field == nil:
    return 0.0
  let header = headerOf(target)
  if header[].magic != BlazeMagic or header[].descriptor == nil:
    return 0.0
  var at = cast[cstring](header[].descriptor)
  let wanted = $field
  while at[0] != '\\0':
    let name = $at
    if name == wanted:
      return 1.0
    # A field is its name, the offset it sits at and the type it holds: the next
    # field starts after all three.
    at = cast[cstring](cast[uint](at) + uint(name.len) + 1)
    let offset = $at
    at = cast[cstring](cast[uint](at) + uint(offset.len) + 1)
    let kind = $at
    at = cast[cstring](cast[uint](at) + uint(kind.len) + 1)
  0.0

proc blaze_rt_retain*(pointer: pointer): pointer {.exportc, cdecl.} =
${guarded ? "  if pointer == nil:\n    return nil" : ""}
  inc check(pointer, "blaze_rt_retain")[].refs
  pointer

proc blaze_rt_release*(pointer: pointer) {.exportc, cdecl.} =
  ## The ABI promises that a null pointer is ignored, in every mode. It is the
  ## runtime's own answer to a value that is nothing rather than a check the
  ## program makes of itself: a program releases a name when it goes out of
  ## scope, and a name whose value is nothing is a program that never made one.
  if pointer == nil:
    return
  let header = check(pointer, "blaze_rt_release")
  ## A block of an open region is not recycled on its own. A block put on the
  ## released list of its class would be handed out again by the slab path
  ## while the region is rewound over the same memory, and two blocks would be
  ## live in one piece of it. The rewind takes the whole region instead, which
  ## is what the region exists for and what every block in it is there for.
  if blazeRegionDepth > 0:
    ## The block is not recycled while the region is open — the rewind takes the
    ## whole region — but its count is still a count. Another holder of this
    ## block is not going away because this one released it, and a count that
    ## reads as nothing while two holders still hold it is what sends the next
    ## release down the recycling path for a block that is live.
    if header[].refs > 0:
      dec header[].refs
    return
  if header[].refs > 1:
    dec header[].refs
    return
  if cast[uint](header[].base) == BlazeRegionMark:
    ## A block of a region whose region has closed. The region owns the memory
    ## and hands it out again on the next turn, so this block is not the slab's
    ## to keep: a block put on the slab's released list is handed out again by
    ## the slab path while the region is rewound over the same bytes, and two
    ## blocks would be live in one piece of it. The block is dropped instead:
    ## the memory is the region's, and the region is what hands it out again.
    header[].refs = 0
${guarded ? "    header[].magic = BlazeFreed" : ""}
    return
  if header[].base == nil:
    ## A block that came from a slab goes back onto the list of its own class
    ## rather than to Nim's allocator, which is the whole of what the slab is
    ## for. The class is the size the block occupies, and its capacity and its
    ## alignment are the two that size is made of, so a block goes back on the
    ## class it was taken off: capacity and alignment do not change under a live
    ## block, because the block that grows into a new capacity is a new block.
    ## The magic is poisoned here as it is on the path below, because this block
    ## is dead too: a block that keeps it reads as live to every check, which is
    ## what the release of a pooled block is most often missed by — a second
    ## release links it to itself and the class hands the same address out
    ## forever. The slab takes it back without looking at the magic, so a
    ## poisoned entry is revalidated on the way out.
    let cls = blazeClassOf(header[].capacity + header[].alignment + BlazeHeaderSize, header[].alignment)
    if cls != 0:
      header[].base = cast[pointer](blazeReleased[cls - 1])
      blazeReleased[cls - 1] = header
${guarded ? "      header[].magic = BlazeFreed" : ""}
      return
  let base = header[].base
${guarded ? "  header[].magic = BlazeFreed" : ""}
  dealloc(base)

proc blaze_rt_reallocate*(pointer: pointer, bytes: csize_t): pointer {.exportc, cdecl.} =
  ## The ABI promises this in every mode, as the C runtime this is the twin of
  ## does: a null pointer is a value that is nothing rather than a check the
  ## program makes of itself, and a danger build that read the header of one
  ## dereferenced nil - 48. It sits outside the guards here for that reason.
  if pointer == nil:
    return blaze_rt_allocate(bytes)
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
  ## A block that grows *moves*: the bytes are copied into a new block and this
  ## one is released, so every other holder of it is left holding the block that
  ## was just released. A resize is the same program only where the caller holds
  ## the only reference, which is what the C runtime this is the twin of asks
  ## there.
${guarded ? '  if previous.refs > 1:\n    blazeStop("a block that is resized must be the only reference to it")' : ""}
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

proc c_readlink(path: cstring, buffer: cstring, size: csize_t): int {.importc: "readlink", header: "<unistd.h>".}

var blazeStateCells: seq[(string, float64)] = @[]

proc blazeStateIndex(key: string): int =
  for index, cell in blazeStateCells:
    if cell[0] == key: return index
  -1

proc blaze_rt_state_get*(key: cstring): float64 {.exportc, cdecl.} =
  if key == nil: return 0.0
  let index = blazeStateIndex($key)
  if index < 0: return 0.0
  blazeStateCells[index][1]

proc blaze_rt_state_set*(key: cstring, value: float64): float64 {.exportc, cdecl.} =
  if key == nil: return value
  let index = blazeStateIndex($key)
  if index < 0: blazeStateCells.add(($key, value))
  else: blazeStateCells[index][1] = value
  value

proc blaze_rt_path_extname*(path: cstring): cstring {.exportc, cdecl.} =
  ## The last dot of the last component and what follows it, as Node reads it:
  ## a name that starts with the dot has no extension.
  if path == nil: return blaze_rt_string_new(nil, 0)
  let text = $path
  let slash = text.rfind('/')
  let base = if slash < 0: 0 else: slash + 1
  let dot = text.rfind('.')
  if dot < 0 or dot == base: return blaze_rt_string_new(nil, 0)
  blaze_rt_string_new(cast[pointer](unsafeAddr text[dot]), csize_t(text.len - dot))

proc blaze_rt_exec_path*(): cstring {.exportc, cdecl.} =
  ## The executable the operating system started, which a program naming a
  ## runner needs: the compiler runs its own binary for the host it built.
  var buffer: array[4096, char]
  let written = c_readlink("/proc/self/exe", cast[cstring](addr buffer[0]), csize_t(buffer.len - 1))
  if written <= 0: return blaze_rt_string_new(nil, 0)
  blaze_rt_string_new(addr buffer[0], csize_t(written))

proc blaze_rt_encode_uri_component*(text: cstring): cstring {.exportc, cdecl.} =
  ## The bytes a URI component leaves as they are, and every other byte
  ## percent-encoded in upper-case hexadecimal.
  if text == nil: return blaze_rt_string_new(nil, 0)
  const hex = "0123456789ABCDEF"
  var written = ""
  for letter in $text:
    let code = ord(letter)
    let unreserved = (code >= ord('A') and code <= ord('Z')) or
      (code >= ord('a') and code <= ord('z')) or
      (code >= ord('0') and code <= ord('9')) or
      letter in {'-', '_', '.', '!', '~', '*', '\'', '(', ')'}
    if unreserved:
      written.add letter
      continue
    written.add '%'
    written.add hex[(code shr 4) and 15]
    written.add hex[code and 15]
  if written.len == 0: return blaze_rt_string_new(nil, 0)
  blaze_rt_string_new(cast[pointer](unsafeAddr written[0]), csize_t(written.len))

## Two texts are compared by what they say and not by where they are: a text
## built at run time and one written out are two addresses that can say the
## same thing. A text that is nothing is the smaller of the two, so two texts
## that are nothing are the same thing, which is what a comparison of two
## absent values answers.
proc blaze_rt_text_compare*(left, right: cstring): cint {.exportc, cdecl.} =
  if left == nil or right == nil:
    if left == right: return 0
    return if left == nil: -1 else: 1
  if left == right: return 0
  let difference = cmp(cstring(left), cstring(right))
  if difference < 0: -1 elif difference > 0: 1 else: 0

proc blaze_rt_string_append*(left, right: cstring): cstring {.exportc, cdecl.} =
  ## The result is always a block of its own. The left string is a value the
  ## program may still be holding, and the runtime cannot tell whether it is: a
  ## text value is never retained and never released, so every text block's
  ## count is permanently one, and a count of one says only that this call is
  ## the first to have reached it — never that nothing else is looking at it.
  ## Writing into the block when the count is one is how a program that joined
  ## two literals and then interpolated that name with a "!" at the end printed
  ## the longer string for the name: the append landed in the bytes of a string
  ## two names were pointing at, and every later append to either of them
  ## rewrote the other.
  ##
  ## The room is still grown geometrically, so a loop of appends copies its
  ## bytes a linear number of times rather than a quadratic one.
  if left == nil:
    return if right == nil: blaze_rt_string_new(nil, 0) else: blaze_rt_string_new(cast[pointer](right), blaze_rt_text_length(right))
  if right == nil:
    return blaze_rt_string_new(cast[pointer](left), blaze_rt_text_length(left))
  let leftLength = blaze_rt_text_length(left)
  let rightLength = blaze_rt_text_length(right)
  let wanted = leftLength + rightLength + 1
  let room = leftLength * 2 + 16
  let owner = cast[cstring](blaze_rt_allocate_uninitialized(if wanted < room: room.csize_t else: wanted))
  copyMem(cast[pointer](owner), left, int(leftLength))
  ## A string handed to both sides is one block named twice, so the right side
  ## is read out of the copy just made rather than out of the block it came from.
  if rightLength > 0:
    copyMem(cast[pointer](cast[uint](owner) + leftLength), if right == left: owner else: right, int(rightLength))
  ## The length of the string, not the size of the block it was put in, and
  ## blaze_rt_text_length answers length - 1, so a joined string measured by
  ## the program would otherwise come back as the room it was given rather than
  ## as its own bytes. The C runtime records the same length in the same place.
  headerOf(cast[pointer](owner))[].length = wanted.uint64
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
  blazeRaisedMessage.cstring


var blazeArguments: seq[float64] = @[]

proc blaze_rt_arguments_set*(values: ptr UncheckedArray[float64], count: csize_t) {.exportc, cdecl.} =
  blazeArguments = newSeq[float64](int(count))
  for index in 0 ..< int(count):
    blazeArguments[index] = values[index]

proc blaze_rt_argv_count*(): csize_t {.exportc, cdecl.} =
  ## The length process.argv has, counting where the program runs and the file
  ## it runs before the arguments it was given.
  csize_t(blazeArguments.len + 2)

proc blazeNaN*(): float64 =
  ## The number that is not one, which is what the source reads an argument it
  ## was not given as. Nim has no literal for it: a zero divided by itself is
  ## the only way to write one.
  let zero = 0.0
  zero / zero

proc blaze_rt_argv*(index: csize_t): float64 {.exportc, cdecl.} =
  ## The index is the one process.argv uses, which counts where node runs
  ## and the file it runs, so the first argument the program was given is 2.
  ## An index that names no argument is NaN: the two entries before the
  ## arguments are the path the program runs and the file it runs, and reading
  ## an argument that was never given is +undefined, not a zero.
  let argument = int(index) - 2
  if argument >= 0 and argument < blazeArguments.len: blazeArguments[argument] else: blazeNaN()

var blazeHostArguments: seq[string] = @[]

proc blaze_rt_host_arguments_set*(values: cstring, count: csize_t) {.exportc, cdecl.} =
  ## The argument texts the host handed the program: borrowed for the length
  ## of the run, so the adapter keeps its own copy of each.
  blazeHostArguments = @[]
  if values == nil: return
  let slots = cast[ptr UncheckedArray[cstring]](values)
  for index in 0 ..< int(count):
    let slot = slots[index]
    blazeHostArguments.add(if slot == nil: "" else: $slot)

proc blaze_rt_host_argument_count*(): csize_t {.exportc, cdecl.} =
  csize_t(blazeHostArguments.len)

proc blaze_rt_host_argument*(index: csize_t): cstring {.exportc, cdecl.} =
  let at = int(index)
  let text = if at >= 0 and at < blazeHostArguments.len: blazeHostArguments[at] else: ""
  blaze_rt_string_new(cast[pointer](text.cstring), csize_t(text.len))

proc blaze_rt_fround*(value: float64): float64 {.exportc, cdecl.} =
  float64(float32(value))

proc blaze_rt_print_text*(text: cstring) {.exportc, cdecl.} =
  if text != nil: stdout.write($text)

proc blaze_rt_print_error_text*(text: cstring) {.exportc, cdecl.} =
  ## The error stream is the runtime's own, and a program that writes a line
  ## and then fails has both: the output is flushed before the text is written.
  if text != nil:
    flushFile(stdout)
    stderr.write($text)
    flushFile(stderr)

proc blaze_rt_print_text_n*(text: cstring, length: csize_t) {.exportc, cdecl.} =
  ## The count is the length rather than where the zero is: a compiler that laid
  ## the text out knows how long it is, and the text need not be terminated.
  ## The bytes are read as bytes rather than as the NUL terminated string the
  ## cstring also is: it scans for the terminator before the slice is taken,
  ## so a literal carrying an escape the language writes as a byte of text was
  ## cut at that byte. The C runtime this is the twin of writes the count.
  if text != nil: discard stdout.writeBuffer(cast[pointer](text), int(length))

## The shortest decimal that reads back as the value, placed the way the source
## language places it: in full from 1e-6 up to 1e21, and in exponential form
## outside that range. A value that is not finite has no shortest decimal, so
## it is written as the language writes it, and a zero of either sign is written
## as 0: the language writes a negative zero the same way it writes a positive
## one, and only a test for the sign of a zero can tell them apart.
## The style a value is written as text in: the way the language writes it.
## It is set once, when the program starts, and every value the runtime writes
## as text is written in the style that is set.
var blazeTextStyle = 0

proc blaze_rt_set_text_style*(style: cint) {.exportc, cdecl.} =
  blazeTextStyle = style.int

proc blazeShortest(value: float64): string =
  let python = blazeTextStyle == 1
  if classify(value) == fcNan: return (if python: "nan" else: "NaN")
  if classify(value) in {fcInf, fcNegInf}:
    return (if python: (if value < 0.0: "-inf" else: "inf") else: (if value < 0.0: "-Infinity" else: "Infinity"))
  if value == 0.0:
    if python: return (if signbit(value): "-0.0" else: "0.0")
    return "0"
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
  # The range a number is written in full is the language's own: one writes it
  # in full from 1e-6 up to 1e21 and the other from 1e-4 up to 1e16.
  let lowest = (if python: -3 else: -5)
  let highest = (if python: 16 else: 21)
  if point >= lowest and point <= highest:
    if point <= 0:
      body = "0." & repeat('0', -point) & digits
    elif point >= digits.len:
      body = digits & repeat('0', point - digits.len)
      # A whole number written as a fraction keeps its point: the language
      # writes 8.0 and not 8, because the two are two numbers.
      if python: body = body & ".0"
    else:
      body = digits[0 ..< point] & "." & digits[point .. ^1]
  else:
    body = digits[0 .. 0]
    if digits.len > 1: body = body & "." & digits[1 .. ^1]
    let power = point - 1
    var scale = $abs(power)
    # The exponent of one language is written with a zero in front of a single
    # digit, and the other's is not: 1e-05 and 1e-5 are two spellings of one
    # number and only one of them is the language's.
    if python and scale.len < 2: scale = "0" & scale
    body = body & "e" & (if power < 0: "-" else: "+") & scale
  (if negative: "-" else: "") & body

proc blaze_rt_print_number*(value: float64) {.exportc, cdecl.} =
  ## A program prints a number the way the host it was written for prints it,
  ## and that host writes a negative zero with its sign. Only an interpolation
  ## reads one as the plain zero the language makes of it.
  if value == 0.0 and classify(value) == fcNegZero:
    # A negative zero is written with its sign, and the way it is written is
    # the language's: one writes -0 and the other writes -0.0.
    if blazeTextStyle == 1:
      stdout.write("-0.0")
      return
    stdout.write("-0")
    return
  stdout.write(blazeShortest(value))

proc blaze_rt_print_whole*(value: int64, bigint: cint) {.exportc, cdecl.} =
  ## A whole number above 2^53 is not a number a double holds, so handing one
  ## to the formatter answers a different number than the program wrote: a
  ## bigint literal of 9007199254740993 printed as 9007199254740992. The digits
  ## are therefore written from the integer itself. The magnitude is taken
  ## unsigned because the most negative value negates to itself as a signed one
  ## and its digits would then never come out. The n of a bigint is written
  ## after the digits when the value is one.
  var magnitude = if value < 0: 0'u64 - cast[uint64](value) else: cast[uint64](value)
  var digits: array[20, char]
  var count = 0
  while true:
    digits[count] = chr(ord('0') + int(magnitude mod 10'u64))
    inc count
    magnitude = magnitude div 10'u64
    if magnitude == 0'u64:
      break
  if value < 0:
    stdout.write('-')
  while count > 0:
    dec count
    stdout.write(digits[count])
  # The marker is the word one language prints after the digits of a whole
  # number and the other has no word for.
  if bigint != 0 and blazeTextStyle != 1:
    stdout.write('n')

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

# Whether the value, written at that many digits, is a tie the library breaks
# downwards — its even neighbour being the smaller of the two, so that the
# language, which writes a tie away from zero, has to write the other one.
#
# A tie at f digits is a value m * 2^e whose twos are exactly -(e + f + 1) of
# them, and it breaks downwards exactly when (m / 2^d) * 5^f is one more than a
# multiple of four. The test is on the exact value because the digits cannot
# tell one: a library rounding 1.005 correctly writes 1.005, and it is not a
# tie, because the double under it is a hair below 1.005.
proc blazeFixedBreaksDown(value: float64, digits: int): bool =
  if value == 0.0 or classify(value) != fcNormal:
    return false
  var exponent = 0
  let fraction = frexp(abs(value), exponent)
  # 2^53 is the whole number a fraction of a double is held as, exactly.
  var mantissa = uint64(fraction * 9007199254740992.0)
  let twos = -(exponent - 53 + digits + 1)
  if twos < 0:
    return false
  for _ in 0 ..< twos:
    if (mantissa and 1) != 0:
      return false
    mantissa = mantissa shr 1
  # 5^digits is one more than a multiple of four however large it is, so the
  # residue of the product is the residue of the quotient.
  (mantissa and 3) == 1

proc blaze_rt_format_number_fixed*(value: float64, digits: cint, buffer: ptr uint8, size: csize_t): csize_t {.exportc, cdecl.} =
  let wanted = int(digits)
  var text = formatFloat(value, ffDecimal, wanted)
  if blazeFixedBreaksDown(value, wanted):
    var at = text.len - 1
    while at >= 0 and text[at] == '9':
      text[at] = '0'
      at -= 1
    if at < 0:
      text = "1" & text
    else:
      text[at] = chr(ord(text[at]) + 1)
  if size == 0:
    return 0
  let written = min(csize_t(text.len), size - 1)
  if written > 0: copyMem(buffer, unsafeAddr text[0], int(written))
  cast[ptr UncheckedArray[uint8]](buffer)[int(written)] = 0
  written

proc blaze_rt_format_number_precision*(value: float64, digits: cint, buffer: ptr uint8, size: csize_t): csize_t {.exportc, cdecl.} =
  ## What x.toPrecision(p) writes: p significant digits, in full where the
  ## decimal exponent is from -6 up to p - 1 and in exponential form outside
  ## that range. A value that is not finite is written as the language writes
  ## it, which is what the shortest formatter answers.
  if classify(value) in {fcNan, fcInf, fcNegInf}:
    return blaze_rt_format_number(value, buffer, size)
  let wanted = max(1, min(100, int(digits)))
  let negative = value < 0.0
  let magnitude = abs(value)
  var text: string
  if magnitude == 0.0:
    ## A zero has no significant digit to write, so it is the whole part and
    ## the zeros down to the last of the digits asked for.
    text = "0"
    if wanted > 1:
      text.add(".")
      text.add(repeat('0', wanted - 1))
  else:
    let scientific = formatFloat(magnitude, ffScientific, wanted - 1)
    let mark = scientific.find('e')
    let exponent = parseInt(scientific[mark + 1 .. ^1])
    var significant = scientific[0 ..< mark].replace(".", "")
    var placeExponent = exponent
    ## A tie is written away from zero and the library breaks one to even: the
    ## rounding place of p significant digits is the same place as
    ## (p - 1 - exponent) digits after the point.
    let place = wanted - 1 - placeExponent
    if place >= 0 and blazeFixedBreaksDown(value, place):
      var at = significant.len - 1
      while at >= 0 and significant[at] == '9':
        significant[at] = '0'
        at -= 1
      if at < 0:
        significant = "1" & repeat('0', wanted - 1)
        placeExponent += 1
      else:
        significant[at] = chr(ord(significant[at]) + 1)
    if placeExponent < -6 or placeExponent >= wanted:
      text = significant[0 ..< 1]
      if wanted > 1:
        text.add(".")
        text.add(significant[1 ..< wanted])
      text.add("e")
      text.add(if placeExponent < 0: "-" else: "+")
      text.add($abs(placeExponent))
    elif placeExponent >= 0:
      let point = placeExponent + 1
      text = significant[0 ..< point]
      if point < wanted:
        text.add(".")
        text.add(significant[point ..< wanted])
    else:
      text = "0." & repeat('0', -placeExponent - 1) & significant[0 ..< wanted]
  if negative:
    text = "-" & text
  if size == 0:
    return 0
  let written = min(csize_t(text.len), size - 1)
  if written > 0: copyMem(buffer, unsafeAddr text[0], int(written))
  cast[ptr UncheckedArray[uint8]](buffer)[int(written)] = 0
  written

proc blaze_rt_print_newline*() {.exportc, cdecl.} =
  stdout.write("\\n")

proc blaze_rt_raise*(message: cstring) {.exportc, cdecl, noreturn.} =
  blazeRaisedMessage = if message == nil: "" else: $message
  blazeStop(blazeRaisedMessage)

## ---------------------------------------------------------------------- ##
## Dynamic values                                                          ##
## ---------------------------------------------------------------------- ##

## The kinds of value the runtime holds. The C runtime this is the twin of
## keeps the same kinds, and a handle is the index of the value in the table
## below: a small number that names one value.
type
  BlazeDynKind = enum
    dynNull, dynNumber, dynBool, dynText, dynArray, dynObject, dynHasher, dynDict

  BlazeDyn = object
    kind: BlazeDynKind
    number: float64
    text: cstring
    items: seq[float64]
    entries: seq[(string, float64)]

var blazeDynValues: seq[BlazeDyn] = @[]

proc blazeDynRegister(value: BlazeDyn): float64 =
  ## A value the runtime holds, and the handle that names it. Handle 0 names
  ## nothing at all, exactly as the C runtime reserves it: a read of an
  ## element that is not there, or of a field that is not there, answers the
  ## zero that names no value, and a value that was registered has to be told
  ## apart from that answer. Handles therefore count from one.
  blazeDynValues.add value
  float64(blazeDynValues.len)

proc blazeDynIndex(handle: float64): int =
  ## The index of the value a handle names, or -1 where it names none. A
  ## handle is a position, so a number that is not one names no value at all,
  ## and neither does 0, which is reserved for the answer that has no value.
  if handle < 1.0 or handle != floor(handle): return -1
  let index = int(handle) - 1
  if index >= blazeDynValues.len: return -1
  index

proc blazeTextOf(text: string): cstring =
  ## A text as a block of the runtime's own, so it lives as long as the value
  ## that holds it.
  if text.len == 0:
    return blaze_rt_string_new(nil, 0)
  blaze_rt_string_new(cast[pointer](unsafeAddr text[0]), csize_t(text.len))

proc blazeNumberText(value: float64): cstring =
  ## A number as the language writes it, in a block of its own.
  var buffer: array[64, uint8]
  let written = blaze_rt_format_number(value, addr buffer[0], csize_t(buffer.len))
  blaze_rt_string_new(addr buffer[0], written)

proc blaze_rt_box_number*(value: float64): float64 {.exportc, cdecl.} =
  blazeDynRegister BlazeDyn(kind: dynNumber, number: value)

proc blaze_rt_box_string*(value: cstring): float64 {.exportc, cdecl.} =
  ## The text is copied into a block of its own, so the block the program
  ## handed over may go away while this value is still held.
  var copied: cstring = nil
  if value != nil:
    copied = blaze_rt_string_new(cast[pointer](value), blaze_rt_text_length(value))
  blazeDynRegister BlazeDyn(kind: dynText, text: copied)

proc blaze_rt_box_null*(): float64 {.exportc, cdecl.} =
  blazeDynRegister BlazeDyn(kind: dynNull)

proc blaze_rt_to_number*(value: float64): float64 {.exportc, cdecl.} =
  ## The number a value states, or the value itself where it states none.
  let index = blazeDynIndex(value)
  if index < 0: return value
  let item = blazeDynValues[index]
  case item.kind
  of dynNumber, dynBool:
    item.number
  of dynText:
    if item.text == nil:
      0.0
    else:
      try:
        parseFloat($item.text)
      except ValueError:
        0.0
  else:
    value

proc blaze_rt_is_array*(value: float64): float64 {.exportc, cdecl.} =
  ## Whether a dynamic value is an array: the kind the runtime registered the
  ## value as, and nothing for a value it does not hold.
  let index = blazeDynIndex(value)
  if index < 0: return 0.0
  if blazeDynValues[index].kind == dynArray: return 1.0
  return 0.0

proc blaze_rt_type_of*(value: float64): cstring {.exportc, cdecl.} =
  ## The name typeof answers for a value the compiler could not read the type
  ## of: the kind the runtime registered the value as, or the number or the text
  ## the value itself is.
  let index = blazeDynIndex(value)
  if index < 0:
    if value >= 4096.0: return blazeTextOf("string")
    return blazeTextOf("number")
  case blazeDynValues[index].kind
  of dynNumber:
    blazeTextOf("number")
  of dynBool:
    blazeTextOf("boolean")
  of dynText:
    blazeTextOf("string")
  else:
    blazeTextOf("object")

proc blaze_rt_to_text*(value: float64): cstring {.exportc, cdecl.} =
  ## The text a value is written as, which is the way the language writes it.
  let index = blazeDynIndex(value)
  if index < 0:
    ## A value the runtime does not hold may be a string the program holds: a
    ## pointer is a large number and a small one is a number.
    if value >= 4096.0:
      return cast[cstring](cast[uint](value))
    return blazeNumberText(value)
  let item = blazeDynValues[index]
  case item.kind
  of dynNull:
    return blazeTextOf(if blazeTextStyle == 1: "None" else: "null")
  of dynBool:
    return blazeTextOf(if blazeTextStyle == 1: (if item.number != 0.0: "True" else: "False")
                       else: (if item.number != 0.0: "true" else: "false"))
  of dynText:
    if item.text == nil: return blaze_rt_string_new(nil, 0)
    return item.text
  of dynNumber:
    return blazeNumberText(item.number)
  of dynArray:
    ## The elements of the array, separated by commas and in brackets, and a
    ## text among them is written as a text is.
    var written = "["
    for position, element in item.items:
      if position > 0: written.add ","
      let at = blazeDynIndex(element)
      let isText = at >= 0 and blazeDynValues[at].kind == dynText
      if isText: written.add '"'
      let text = blaze_rt_to_text(element)
      if text != nil: written.add $text
      if isText: written.add '"'
    written.add "]"
    return blazeTextOf(written)
  else:
    return blazeTextOf("{}")

proc blaze_rt_dyn_array_new*(): float64 {.exportc, cdecl.} =
  ## An array the runtime holds, with no elements in it yet.
  blazeDynRegister BlazeDyn(kind: dynArray)

proc blaze_rt_array_push*(array, value: float64): float64 {.exportc, cdecl.} =
  ## A value appended to the array, and the array handed back: a program that
  ## holds no array yet is given one.
  var index = blazeDynIndex(array)
  if index < 0 or blazeDynValues[index].kind != dynArray:
    index = blazeDynIndex(blazeDynRegister BlazeDyn(kind: dynArray))
  blazeDynValues[index].items.add value
  float64(index + 1)

proc blaze_rt_array_get*(array, index: float64): float64 {.exportc, cdecl.} =
  ## One element of the array, or nothing where the array holds no such one.
  let at = blazeDynIndex(array)
  if at < 0 or blazeDynValues[at].kind != dynArray: return 0.0
  let position = int(index)
  if position < 0 or position >= blazeDynValues[at].items.len: return 0.0
  blazeDynValues[at].items[position]

proc blaze_rt_array_length*(array: float64): float64 {.exportc, cdecl.} =
  ## How many elements the array holds. An object holds its fields in pairs,
  ## so it has half as many of them as it has items.
  let at = blazeDynIndex(array)
  if at < 0: return 0.0
  let item = blazeDynValues[at]
  if item.kind == dynObject: return float64(item.items.len div 2)
  if item.kind != dynArray: return 0.0
  float64(item.items.len)

proc blaze_rt_length*(value: float64): float64 {.exportc, cdecl.} =
  ## How long a value is, whichever of the runtime's shapes it has: a dynamic
  ## array or object counts its items, a dictionary or record counts its
  ## fields, and a text counts its characters.
  let at = blazeDynIndex(value)
  if at >= 0:
    let item = blazeDynValues[at]
    if item.kind == dynArray: return float64(item.items.len)
    if item.kind == dynObject: return float64(item.items.len div 2)
    if item.kind == dynText: return float64(blaze_rt_text_length(item.text))
    return 0.0
  if value < 4096.0: return 0.0
  let counted = blaze_rt_dict_len(value)
  if counted != 0.0: return counted
  float64(blaze_rt_text_length(cast[cstring](cast[uint](value))))

proc blaze_rt_array_set*(array, index, value: float64) {.exportc, cdecl.} =
  ## One element written, where the array holds it. An index that names no
  ## element writes nothing, which is what the C runtime answers.
  let at = blazeDynIndex(array)
  if at < 0 or blazeDynValues[at].kind != dynArray: return
  let position = int(index)
  if position < 0 or position >= blazeDynValues[at].items.len: return
  blazeDynValues[at].items[position] = value

proc blaze_rt_json_field_key*(obj: float64, index: float64): cstring {.exportc, cdecl.} =
  ## The key of one field of a dynamic object by its position.
  let at = blazeDynIndex(obj)
  if at < 0 or blazeDynValues[at].kind != dynObject: return ""
  let item = blazeDynValues[at]
  let position = int(index) * 2
  if position < 0 or position + 1 >= item.items.len: return ""
  let keyIndex = blazeDynIndex(item.items[position])
  if keyIndex < 0 or blazeDynValues[keyIndex].kind != dynText: return ""
  let key = blazeDynValues[keyIndex].text
  if key == nil: "" else: key

proc blaze_rt_json_field_value*(obj: float64, index: float64): float64 {.exportc, cdecl.} =
  ## The value of one field of a dynamic object by its position.
  let at = blazeDynIndex(obj)
  if at < 0 or blazeDynValues[at].kind != dynObject: return 0.0
  let item = blazeDynValues[at]
  let position = int(index) * 2
  if position < 0 or position + 1 >= item.items.len: return 0.0
  item.items[position + 1]

proc blaze_rt_json_get*(obj: float64, field: cstring): float64 {.exportc, cdecl.} =
  ## The field of an object, or nothing where the object holds no such field.
  let at = blazeDynIndex(obj)
  if at < 0 or blazeDynValues[at].kind != dynObject: return 0.0
  let item = blazeDynValues[at]
  var position = 0
  while position + 1 < item.items.len:
    let keyIndex = blazeDynIndex(item.items[position])
    let key = if keyIndex >= 0: blazeDynValues[keyIndex].text else: nil
    if key != nil and field != nil and key == field:
      return item.items[position + 1]
    position += 2
  0.0

proc blaze_rt_box_sequence*(source: pointer, elementSize: csize_t, kind: int64): float64 {.exportc, cdecl.} =
  ## A block of elements as the dynamic array they are: the elements are boxed
  ## one at a time, so the dynamic value is the list and not an empty array.
  let handle = blaze_rt_dyn_array_new()
  let size = elementSize
  if source == nil or size == 0'u64:
    return handle
  let count = int(blaze_rt_object_size(source)) div int(size)
  for at in 0 ..< count:
    let element = cast[pointer](cast[uint](source) + uint(at * int(size)))
    if kind == 2:
      var number: float64 = 0.0
      if size == 8'u64:
        copyMem(addr number, element, 8)
      elif size == 4'u64:
        var small: float32 = 0
        copyMem(addr small, element, 4)
        number = float64(small)
      else:
        number = if cast[ptr UncheckedArray[uint8]](element)[0] != 0'u8: 1.0 else: 0.0
      var flag = BlazeDyn(kind: dynBool)
      flag.number = if number != 0.0: 1.0 else: 0.0
      let boxed = blazeDynRegister(flag)
      discard blaze_rt_array_push(handle, boxed)
    elif kind == 1:
      let text = cast[ptr cstring](element)[]
      let boxed = blaze_rt_box_string(text)
      discard blaze_rt_array_push(handle, boxed)
    else:
      var number: float64 = 0.0
      if size == 8'u64:
        copyMem(addr number, element, 8)
      elif size == 4'u64:
        var small: float32 = 0
        copyMem(addr small, element, 4)
        number = float64(small)
      let boxed = blaze_rt_box_number(number)
      discard blaze_rt_array_push(handle, boxed)
  handle

## ---------------------------------------------------------------------- ##
## Dictionaries                                                            ##
## ---------------------------------------------------------------------- ##

## A dictionary is a value the runtime holds, the way an array is, so its
## handle comes from the same table. The entries are kept in the order they
## were first written, and a key is the text as an owned copy: a program may
## write a key from a block that goes away, and reading the dictionary back
## afterwards must still find it.

proc blazeDictIndex(dict: float64): int =
  ## The index of the dictionary a handle names, or -1 where it names no
  ## dictionary: a handle of another kind names nothing here.
  let at = blazeDynIndex(dict)
  if at < 0 or blazeDynValues[at].kind != dynDict: return -1
  at

proc blazeDictFind(at: int, key: string): int =
  ## The entry a key names in the dictionary at that index, or -1 where the
  ## dictionary holds no such entry.
  let entries = blazeDynValues[at].entries
  for position in 0 ..< entries.len:
    if entries[position][0] == key: return position
  -1

proc blaze_rt_dict_new*(): float64 {.exportc, cdecl.} =
  ## An empty dictionary, held by the runtime like an array is.
  blazeDynRegister BlazeDyn(kind: dynDict)

proc blaze_rt_dict_get*(dict: float64, key: cstring): float64 {.exportc, cdecl.} =
  ## The value a key holds, or NaN where the dictionary holds no such key. A
  ## key that is absent is a thing of its own, and a NaN is told apart from
  ## every value a key can hold, which is what the C runtime answers.
  let at = blazeDictIndex(dict)
  if at < 0 or key == nil: return NaN
  let position = blazeDictFind(at, $key)
  if position < 0: return NaN
  blazeDynValues[at].entries[position][1]

proc blaze_rt_dict_has*(dict: float64, key: cstring): float64 {.exportc, cdecl.} =
  ## Whether a key holds a value, answered as 1 or 0.
  let at = blazeDictIndex(dict)
  if at < 0 or key == nil: return 0.0
  if blazeDictFind(at, $key) >= 0: 1.0 else: 0.0

proc blaze_rt_own_key*(value: float64, key: cstring): float64 {.exportc, cdecl.} =
  ## Whether a value the compiler could not shape holds a key of its own: a
  ## dictionary the runtime made, a dynamic object the parser laid down, or a
  ## record this compiler laid out. Each is asked the way its own entries are
  ## read, and every other value answers nothing.
  if key == nil: return 0.0
  let at = blazeDynIndex(value)
  if at >= 0:
    let item = blazeDynValues[at]
    if item.kind == dynDict:
      if blazeDictFind(at, $key) >= 0: return 1.0
      return 0.0
    if item.kind == dynObject:
      var position = 0
      while position + 1 < item.items.len:
        let keyIndex = blazeDynIndex(item.items[position])
        if keyIndex >= 0 and blazeDynValues[keyIndex].kind == dynText and
            blazeDynValues[keyIndex].text != nil and blazeDynValues[keyIndex].text == key:
          return 1.0
        position += 2
      return 0.0
    return 0.0
  # A record's block carries the names its layout wrote, and the handle is the
  # address as the number it is: the same test the C runtime makes.
  if value < 4096.0 or value >= 281474976710656.0: return 0.0
  let header = headerOf(cast[pointer](uint(value)))
  if header[].magic != BlazeMagic or header[].descriptor == nil: return 0.0
  var field = cast[cstring](header[].descriptor)
  let wanted = $key
  while field[0] != '\\0':
    let name = $field
    if name == wanted:
      return 1.0
    field = cast[cstring](cast[uint](field) + uint(name.len) + 1)
    let offset = $field
    field = cast[cstring](cast[uint](field) + uint(offset.len) + 1)
    let kind = $field
    field = cast[cstring](cast[uint](field) + uint(kind.len) + 1)
  0.0

proc blaze_rt_array_copy*(source: pointer): pointer {.exportc, cdecl.} =
  ## A block of elements copied: a list a program holds is the block and the
  ## length its header measures, so a spread of one is these bytes again.
  if source == nil:
    return blaze_rt_allocate(0)
  let bytes = blaze_rt_object_size(source)
  let copy = blaze_rt_allocate(bytes)
  if copy != nil and bytes > 0'u64:
    copyMem(copy, source, bytes)
  copy

proc blaze_rt_array_join*(left, right: pointer): pointer {.exportc, cdecl.} =
  ## Two blocks of elements joined: the left's bytes followed by the right's.
  let leftBytes = if left == nil: 0'u64 else: uint64(blaze_rt_object_size(left))
  let rightBytes = if right == nil: 0'u64 else: uint64(blaze_rt_object_size(right))
  let joined = blaze_rt_allocate(csize_t(leftBytes + rightBytes))
  if joined != nil:
    if leftBytes > 0'u64:
      copyMem(joined, left, csize_t(leftBytes))
    if rightBytes > 0'u64:
      copyMem(cast[pointer](cast[uint](joined) + uint(leftBytes)), right, csize_t(rightBytes))
  joined

proc blaze_rt_dict_values*(dict: float64): ptr float64 {.exportc, cdecl.} =
  ## Lays a dictionary's values down as a block, in the order the keys were
  ## first written. The block's header states how many values it holds.
  let at = blazeDictIndex(dict)
  let count = if at < 0: 0 else: blazeDynValues[at].entries.len
  let values = cast[ptr UncheckedArray[float64]](blaze_rt_allocate(csize_t(count * sizeof(float64))))
  if values != nil:
    for position in 0 ..< count:
      values[position] = blazeDynValues[at].entries[position][1]
  cast[ptr float64](values)

proc blaze_rt_dict_set*(dict: float64, key: cstring, value: float64): float64 {.exportc, cdecl.} =
  ## A value written under a key, and the dictionary handed back. A key the
  ## dictionary already holds is written over where it stands, so the count of
  ## entries does not change; a key it does not hold is added after the ones
  ## it has.
  let at = blazeDictIndex(dict)
  if at < 0 or key == nil: return NaN
  let text = $key
  let position = blazeDictFind(at, text)
  if position >= 0:
    blazeDynValues[at].entries[position][1] = value
  else:
    blazeDynValues[at].entries.add (text, value)
  dict

proc blaze_rt_dict_len*(dict: float64): float64 {.exportc, cdecl.} =
  ## How many entries the dictionary holds.
  let at = blazeDictIndex(dict)
  if at < 0: return 0.0
  float64(blazeDynValues[at].entries.len)

proc blaze_rt_dict_delete*(dict: float64, key: cstring): float64 {.exportc, cdecl.} =
  ## One entry removed by its key, and the dictionary handed back. A key it does
  ## not hold is not an error: the dictionary is the one it was.
  let at = blazeDictIndex(dict)
  if at < 0 or key == nil: return NaN
  let position = blazeDictFind(at, $key)
  if position >= 0:
    blazeDynValues[at].entries.delete(position)
  dict

## A reference is a handle this runtime carries as a float64, so the reference
## entry points are the number ones under a name that says which the source
## meant. A text entry is the pointer the float64 carries, which is the same
## address the C runtime writes.

proc blaze_rt_dict_get_ref*(dict: float64, key: cstring): float64 {.exportc, cdecl.} =
  blaze_rt_dict_get(dict, key)

proc blaze_rt_dict_set_ref*(dict: float64, key: cstring, value: float64): float64 {.exportc, cdecl.} =
  blaze_rt_dict_set(dict, key, value)

proc blaze_rt_dict_get_text*(dict: float64, key: cstring): cstring {.exportc, cdecl.} =
  let at = blazeDictIndex(dict)
  if at < 0 or key == nil: return ""
  let position = blazeDictFind(at, $key)
  if position < 0: return ""
  cast[cstring](uint(blazeDynValues[at].entries[position][1]))

proc blaze_rt_dict_set_text*(dict: float64, key: cstring, value: cstring): float64 {.exportc, cdecl.} =
  blaze_rt_dict_set(dict, key, float64(cast[uint](value)))

## A list is a block and a length, and an entry is one float64: the block is
## copied into a block this runtime laid out, whose size carries the length, and
## the pointer is what the entry holds.

proc blaze_rt_as_uint_n*(bits: float64, value: int64): int64 {.exportc, cdecl.} =
  ## A whole number wrapped to the unsigned width it names.
  if bits <= 0.0: return 0
  if bits >= 64.0: return value
  value and ((1'i64 shl int(bits)) - 1)

proc blaze_rt_as_int_n*(bits: float64, value: int64): int64 {.exportc, cdecl.} =
  ## A whole number wrapped to the signed width it names, sign extended.
  if bits <= 0.0: return 0
  if bits >= 64.0: return value
  let shift = 64 - int(bits)
  (value shl shift) shr shift

proc blaze_rt_now_ms*(): float64 {.exportc, cdecl.} =
  ## The wall clock in milliseconds since the Unix epoch.
  epochTime() * 1000.0

var blaze_rt_globals: array[4096, float64]
proc blaze_rt_global_slot(slot: float64): int =
  let index = int(slot)
  if index >= 0 and index < 4096: index else: 0
proc blaze_rt_global_get*(slot: float64): float64 {.exportc, cdecl.} =
  ## Reads a module-level number.
  blaze_rt_globals[blaze_rt_global_slot(slot)]
proc blaze_rt_global_set*(slot, value: float64): float64 {.exportc, cdecl.} =
  ## Writes a module-level number, and answers the value written.
  blaze_rt_globals[blaze_rt_global_slot(slot)] = value
  value
proc blaze_rt_global_post_inc*(slot: float64): float64 {.exportc, cdecl.} =
  ## Steps a module-level number up, answering the value before the step.
  let index = blaze_rt_global_slot(slot)
  result = blaze_rt_globals[index]
  blaze_rt_globals[index] = result + 1.0
proc blaze_rt_global_post_dec*(slot: float64): float64 {.exportc, cdecl.} =
  ## Steps a module-level number down, answering the value before the step.
  let index = blaze_rt_global_slot(slot)
  result = blaze_rt_globals[index]
  blaze_rt_globals[index] = result - 1.0

proc blaze_rt_timestamp_iso*(): cstring {.exportc, cdecl.} =
  ## The current time as an ISO 8601 timestamp in UTC, to the millisecond.
  let stamp = now().utc.format("yyyy-MM-dd'T'HH:mm:ss'.000Z'")
  blaze_rt_string_new(cast[pointer](cstring(stamp)), csize_t(stamp.len))

proc blaze_rt_date_iso*(milliseconds: float64): cstring {.exportc, cdecl.} =
  ## The ISO 8601 stamp of a date, in UTC, to the millisecond.
  if milliseconds != milliseconds:
    return blaze_rt_string_new(cast[pointer](cstring"Invalid Date"), csize_t(12))
  var seconds = floor(milliseconds / 1000.0)
  var millis = int64(milliseconds - seconds * 1000.0)
  if millis < 0:
    millis += 1000
    seconds -= 1.0
  let stamp = fromUnix(int64(seconds)).utc.format("yyyy-MM-dd'T'HH:mm:ss")
  let full = stamp & "." & align($millis, 3, '0') & "Z"
  blaze_rt_string_new(cast[pointer](cstring(full)), csize_t(full.len))

proc blaze_rt_number_same*(left, right: float64): float64 {.exportc, cdecl.} =
  ## Two numbers are the same when the bits they are held as are: -0 and 0 are
  ## different, and a NaN is the same as itself, which == answers the other way.
  if cast[uint64](left) == cast[uint64](right): 1.0 else: 0.0

proc blaze_rt_dict_set_seq*(dict: float64, key: cstring, value: pointer, count, size: float64): float64 {.exportc, cdecl.} =
  let bytes = csize_t(count) * csize_t(size)
  let copy = blaze_rt_allocate(bytes)
  if copy != nil and count > 0.0 and value != nil:
    copyMem(copy, value, bytes)
  blaze_rt_dict_set(dict, key, float64(cast[uint](copy)))

proc blaze_rt_dict_get_seq*(dict: float64, key: cstring): pointer {.exportc, cdecl.} =
  let at = blazeDictIndex(dict)
  if at < 0 or key == nil: return nil
  let position = blazeDictFind(at, $key)
  if position < 0: return nil
  cast[pointer](uint(blazeDynValues[at].entries[position][1]))

proc blaze_rt_dict_key_at*(dict: float64, index: float64): cstring {.exportc, cdecl.} =
  let at = blazeDictIndex(dict)
  let position = int(index)
  if at < 0 or position < 0 or position >= blazeDynValues[at].entries.len: return ""
  blazeDynValues[at].entries[position][0].cstring

proc blaze_rt_dict_value_at*(dict: float64, index: float64): float64 {.exportc, cdecl.} =
  let at = blazeDictIndex(dict)
  let position = int(index)
  if at < 0 or position < 0 or position >= blazeDynValues[at].entries.len: return 0.0
  blazeDynValues[at].entries[position][1]

proc blaze_rt_dict_value_at_ref*(dict: float64, index: float64): float64 {.exportc, cdecl.} =
  blaze_rt_dict_value_at(dict, index)

proc blaze_rt_dict_value_at_text*(dict: float64, index: float64): cstring {.exportc, cdecl.} =
  cast[cstring](uint(blaze_rt_dict_value_at(dict, index)))

## A reference key is the address the handle carries, written as the whole
## number it is: one reference is one address, so the address is the key. The C
## runtime writes the same address in base sixteen; the two dictionaries do not
## cross runtimes, so what each writes is what it reads.

proc blaze_rt_dict_set_refkey*(dict: float64, key: float64, value: float64): float64 {.exportc, cdecl.} =
  blaze_rt_dict_set(dict, $uint64(key), value)

proc blaze_rt_dict_get_refkey*(dict: float64, key: float64): float64 {.exportc, cdecl.} =
  blaze_rt_dict_get(dict, $uint64(key))

proc blaze_rt_dict_get_refkey_text*(dict: float64, key: float64): cstring {.exportc, cdecl.} =
  blaze_rt_dict_get_text(dict, $uint64(key))

proc blaze_rt_dict_get_refkey_ref*(dict: float64, key: float64): float64 {.exportc, cdecl.} =
  blaze_rt_dict_get_refkey(dict, key)

proc blaze_rt_dict_set_refkey_text*(dict: float64, key: float64, value: cstring): float64 {.exportc, cdecl.} =
  blaze_rt_dict_set_text(dict, $uint64(key), value)

proc blaze_rt_dict_set_refkey_ref*(dict: float64, key: float64, value: float64): float64 {.exportc, cdecl.} =
  blaze_rt_dict_set_refkey(dict, key, value)

proc blaze_rt_dict_has_refkey*(dict: float64, key: float64): float64 {.exportc, cdecl.} =
  blaze_rt_dict_has(dict, $uint64(key))

proc blaze_rt_dict_delete_refkey*(dict: float64, key: float64): float64 {.exportc, cdecl.} =
  blaze_rt_dict_delete(dict, $uint64(key))

proc blaze_rt_dict_key_ref_at*(dict: float64, index: float64): float64 {.exportc, cdecl.} =
  let key = blaze_rt_dict_key_at(dict, index)
  if key == nil or ord(key[0]) == 0: return 0.0
  float64(parseUInt($key))

## A number key is the number itself, written as the bits of its double: two
## keys that are the same number are the same bits, and the text reads back as
## the number it was. A zero is one key whatever its sign, and every NaN is one.

proc blazeNumKey(key: float64): string =
  var bits = cast[uint64](key)
  if key == 0.0: bits = 0'u64
  elif key != key: bits = 0x7ff8000000000000'u64
  $bits

proc blaze_rt_dict_set_numkey*(dict: float64, key: float64, value: float64): float64 {.exportc, cdecl.} =
  blaze_rt_dict_set(dict, blazeNumKey(key), value)

proc blaze_rt_dict_get_numkey*(dict: float64, key: float64): float64 {.exportc, cdecl.} =
  blaze_rt_dict_get(dict, blazeNumKey(key))

proc blaze_rt_dict_get_numkey_text*(dict: float64, key: float64): cstring {.exportc, cdecl.} =
  blaze_rt_dict_get_text(dict, blazeNumKey(key))

proc blaze_rt_dict_get_numkey_ref*(dict: float64, key: float64): float64 {.exportc, cdecl.} =
  blaze_rt_dict_get_numkey(dict, key)

proc blaze_rt_dict_set_seq_numkey*(dict, key: float64, value: pointer, count, size: float64): float64 {.exportc, cdecl.} =
  blaze_rt_dict_set_seq(dict, blazeNumKey(key), value, count, size)

proc blaze_rt_dict_get_seq_numkey*(dict: float64, key: float64): pointer {.exportc, cdecl.} =
  blaze_rt_dict_get_seq(dict, blazeNumKey(key))

proc blaze_rt_dict_set_numkey_text*(dict: float64, key: float64, value: cstring): float64 {.exportc, cdecl.} =
  blaze_rt_dict_set_text(dict, blazeNumKey(key), value)

proc blaze_rt_dict_set_numkey_ref*(dict: float64, key: float64, value: float64): float64 {.exportc, cdecl.} =
  blaze_rt_dict_set_numkey(dict, key, value)

proc blaze_rt_dict_has_numkey*(dict: float64, key: float64): float64 {.exportc, cdecl.} =
  blaze_rt_dict_has(dict, blazeNumKey(key))

proc blaze_rt_dict_delete_numkey*(dict: float64, key: float64): float64 {.exportc, cdecl.} =
  blaze_rt_dict_delete(dict, blazeNumKey(key))

proc blaze_rt_dict_key_num_at*(dict: float64, index: float64): float64 {.exportc, cdecl.} =
  let key = blaze_rt_dict_key_at(dict, index)
  if key == nil or ord(key[0]) == 0: return 0.0
  cast[float64](parseUInt($key))

proc blaze_rt_random*(): float64 {.exportc, cdecl.} =
  ## A pseudo-random double in [0, 1), which is what the C runtime answers.
  ## Nim's own is in [0, 1) as well, and it is seeded the same way: a program
  ## that wants another seed asks for one.
  rand(1.0)

proc blaze_rt_monotonic_ms*(): float64 {.exportc, cdecl.} =
  ## The milliseconds on a monotonic clock. The clock does not move backwards,
  ## so the difference of two readings of it is a duration, and the fraction is
  ## kept: a clock that answered whole milliseconds would answer half of them
  ## as zero.
  float64(getMonoTime().ticks) / 1000000.0

proc blaze_rt_monotonic_ns*(): int64 {.exportc, cdecl.} =
  ## The same monotonic clock in whole nanoseconds, which is the reading a
  ## source that measures a duration keeps: the fraction a millisecond reading
  ## carries is a whole number here, so two readings a microsecond apart differ.
  getMonoTime().ticks

## ---------------------------------------------------------------------- ##
## Promises                                                                ##
## ---------------------------------------------------------------------- ##

## A promise a program holds. A handle is one past the index of the promise in
## the table below, so a promise is never the null pointer.
type
  BlazePromiseKind = enum
    promiseNumber, promiseText, promiseNull, promiseValue

  BlazePromise = object
    settled: bool
    failed: bool
    kind: BlazePromiseKind
    value: float64
    text: cstring
    message: cstring

var blazePromises: seq[BlazePromise] = @[]

## The promise a call is running under, which a resolve or a reject answers.
var blazeCurrentPromise: pointer = nil

## The error a call left pending, which a catch arm reads.
var blazeErrorPending = false
var blazeErrorMessage = ""

proc blazeErrorSet(message: cstring) =
  blazeErrorPending = true
  blazeErrorMessage = if message == nil: "" else: $message

proc blazePromiseIndex(promise: pointer): int =
  ## The index of the promise a handle names, or -1 where it names none.
  if promise == nil: return -1
  let index = int(cast[uint](promise)) - 1
  if index < 0 or index >= blazePromises.len: return -1
  index

proc blaze_promise_new*(): pointer {.exportc, cdecl.} =
  blazePromises.add BlazePromise()
  cast[pointer](blazePromises.len)

proc blaze_promise_resolve*(promise: pointer, value: float64) {.exportc, cdecl.} =
  let index = blazePromiseIndex(promise)
  if index < 0: return
  blazePromises[index].settled = true
  blazePromises[index].failed = false
  blazePromises[index].kind = promiseNumber
  blazePromises[index].value = value
  blazePromises[index].text = nil
  blazePromises[index].message = nil

proc blaze_promise_resolve_text*(promise: pointer, value: cstring) {.exportc, cdecl.} =
  let index = blazePromiseIndex(promise)
  if index < 0: return
  blazePromises[index].settled = true
  blazePromises[index].failed = false
  blazePromises[index].kind = promiseText
  blazePromises[index].value = 0.0
  blazePromises[index].text = value
  blazePromises[index].message = nil

proc blaze_promise_resolve_null*(promise: pointer) {.exportc, cdecl.} =
  let index = blazePromiseIndex(promise)
  if index < 0: return
  blazePromises[index].settled = true
  blazePromises[index].failed = false
  blazePromises[index].kind = promiseNull
  blazePromises[index].value = 0.0
  blazePromises[index].text = nil
  blazePromises[index].message = nil

proc blaze_promise_resolve_value*(promise: pointer, value: float64) {.exportc, cdecl.} =
  let index = blazePromiseIndex(promise)
  if index < 0: return
  blazePromises[index].settled = true
  blazePromises[index].failed = false
  blazePromises[index].kind = promiseValue
  blazePromises[index].value = value
  blazePromises[index].text = nil
  blazePromises[index].message = nil

proc blaze_promise_reject*(promise: pointer, message: cstring) {.exportc, cdecl.} =
  let index = blazePromiseIndex(promise)
  if index < 0: return
  blazePromises[index].settled = true
  blazePromises[index].failed = true
  blazePromises[index].kind = promiseNull
  blazePromises[index].value = blazeNaN()
  blazePromises[index].text = nil
  blazePromises[index].message = message
  ## The failure is pending, which is what a catch arm reads.
  blazeErrorSet(message)

proc blaze_promise_await*(promise: pointer): float64 {.exportc, cdecl.} =
  let index = blazePromiseIndex(promise)
  if index < 0: return 0.0
  let held = blazePromises[index]
  if held.failed: blazeErrorSet(held.message)
  case held.kind
  of promiseNumber, promiseNull: held.value
  of promiseText: blaze_rt_to_number(blaze_rt_box_string(held.text))
  of promiseValue: blaze_rt_to_number(held.value)

proc blaze_promise_await_text*(promise: pointer): cstring {.exportc, cdecl.} =
  let index = blazePromiseIndex(promise)
  if index < 0: return blazeTextOf("")
  let held = blazePromises[index]
  if held.failed: blazeErrorSet(held.message)
  case held.kind
  of promiseText: (if held.text == nil: blazeTextOf("") else: held.text)
  of promiseValue: blaze_rt_to_text(held.value)
  of promiseNumber: blaze_rt_to_text(blaze_rt_box_number(held.value))
  of promiseNull: blazeTextOf("")

proc blaze_promise_await_value*(promise: pointer): float64 {.exportc, cdecl.} =
  let index = blazePromiseIndex(promise)
  if index < 0: return blaze_rt_box_null()
  let held = blazePromises[index]
  if held.failed:
    blazeErrorSet(held.message)
    return blaze_rt_box_null()
  case held.kind
  of promiseValue: held.value
  of promiseText: blaze_rt_box_string(held.text)
  of promiseNumber: blaze_rt_box_number(held.value)
  of promiseNull: blaze_rt_box_null()

proc blaze_promise_await_nothing*(promise: pointer) {.exportc, cdecl.} =
  let index = blazePromiseIndex(promise)
  if index < 0: return
  if blazePromises[index].failed: blazeErrorSet(blazePromises[index].message)

proc blaze_promise_resolved_number*(value: float64): pointer {.exportc, cdecl.} =
  let promise = blaze_promise_new()
  blaze_promise_resolve(promise, value)
  promise

proc blaze_promise_resolved_text*(value: cstring): pointer {.exportc, cdecl.} =
  let promise = blaze_promise_new()
  blaze_promise_resolve_text(promise, value)
  promise

proc blaze_promise_resolved_null*(): pointer {.exportc, cdecl.} =
  let promise = blaze_promise_new()
  blaze_promise_resolve_null(promise)
  promise

proc blaze_promise_resolved_value*(value: float64): pointer {.exportc, cdecl.} =
  let promise = blaze_promise_new()
  blaze_promise_resolve_value(promise, value)
  promise

proc blaze_promise_rejected*(message: cstring): pointer {.exportc, cdecl.} =
  let promise = blaze_promise_new()
  blaze_promise_reject(promise, message)
  promise

## A promise a body settles on its way out. A failure the body left pending is
## what an async function rejects with: the flag is left as it is, so the await
## that reads the promise reports the failure to the try block it is written in.
proc blazePromiseFailedWith(message: cstring): pointer =
  let promise = blaze_promise_new()
  let index = blazePromiseIndex(promise)
  if index >= 0:
    blazePromises[index].settled = true
    blazePromises[index].failed = true
    blazePromises[index].kind = promiseNull
    blazePromises[index].value = blazeNaN()
    blazePromises[index].text = nil
    blazePromises[index].message = message
  promise

proc blaze_promise_settled_number*(value: float64): pointer {.exportc, cdecl.} =
  if blazeErrorPending: blazePromiseFailedWith(blazeErrorMessage.cstring)
  else: blaze_promise_resolved_number(value)

proc blaze_promise_settled_text*(value: cstring): pointer {.exportc, cdecl.} =
  if blazeErrorPending: blazePromiseFailedWith(blazeErrorMessage.cstring)
  else: blaze_promise_resolved_text(value)

proc blaze_promise_settled_null*(): pointer {.exportc, cdecl.} =
  if blazeErrorPending: blazePromiseFailedWith(blazeErrorMessage.cstring)
  else: blaze_promise_resolved_null()

proc blaze_promise_settled_value*(value: float64): pointer {.exportc, cdecl.} =
  if blazeErrorPending: blazePromiseFailedWith(blazeErrorMessage.cstring)
  else: blaze_promise_resolved_value(value)

proc blaze_promise_failed*(promise: pointer): cint {.exportc, cdecl.} =
  let index = blazePromiseIndex(promise)
  if index < 0: return 0
  if blazePromises[index].failed: 1 else: 0

proc blaze_promise_message*(promise: pointer): cstring {.exportc, cdecl.} =
  let index = blazePromiseIndex(promise)
  if index < 0: return nil
  blazePromises[index].message

proc blaze_promise_set_current*(promise: pointer) {.exportc, cdecl.} =
  blazeCurrentPromise = promise

proc blaze_promise_clear_current*() {.exportc, cdecl.} =
  blazeCurrentPromise = nil

proc blaze_promise_resolve_current*(value: float64) {.exportc, cdecl.} =
  if blazeCurrentPromise != nil: blaze_promise_resolve(blazeCurrentPromise, value)

proc blaze_promise_resolve_current_text*(value: cstring) {.exportc, cdecl.} =
  if blazeCurrentPromise != nil: blaze_promise_resolve_text(blazeCurrentPromise, value)

proc blaze_promise_resolve_current_null*() {.exportc, cdecl.} =
  if blazeCurrentPromise != nil: blaze_promise_resolve_null(blazeCurrentPromise)

proc blaze_promise_resolve_current_value*(value: float64) {.exportc, cdecl.} =
  if blazeCurrentPromise != nil: blaze_promise_resolve_value(blazeCurrentPromise, value)

proc blaze_promise_reject_current*(message: cstring) {.exportc, cdecl.} =
  if blazeCurrentPromise != nil: blaze_promise_reject(blazeCurrentPromise, message)

## The error a try block starts without, and the one a catch arm reads. The
## C runtime this is the twin of keeps the same two.
proc blaze_error_clear*() {.exportc, cdecl.} =
  blazeErrorPending = false
  blazeErrorMessage = ""

proc blaze_had_error*(): float64 {.exportc, cdecl.} =
  if blazeErrorPending: 1.0 else: 0.0

proc blaze_last_error*(): cstring {.exportc, cdecl.} =
  blazeErrorMessage.cstring

proc blaze_rt_json_parse*(text: float64): float64 {.exportc, cdecl.} = 0.0
proc blaze_rt_json_stringify*(value: float64): float64 {.exportc, cdecl.} = 0.0
proc blaze_rt_json_object*(value, indent: float64): cstring {.exportc, cdecl.} = ""
proc blaze_rt_object_copy*(base: float64): float64 {.exportc, cdecl.} = base

## The width of one element a type text names, which is the width the header
## and the layouts of the C runtime use.
proc blazeCloneSize(kind: cstring): csize_t =
  let name = $kind
  if name == "f32" or name == "i32" or name == "u32": return 4
  if name == "i16" or name == "u16": return 2
  if name == "i8" or name == "u8" or name == "bool": return 1
  sizeof(pointer)

proc blazeCloneElement(to, from: pointer; kind: cstring)
proc blazeCloneBlock(block: pointer; element: cstring): pointer
proc blazeCloneObject(object: pointer): pointer

## The element of a block, copied at the type its layout states.
proc blazeCloneElement(to, from: pointer; kind: cstring) =
  let name = $kind
  if name.len > 6 and name[0 .. 5] == "slice<":
    let inner = name[6 ..< name.len - 1]
    var block: pointer = nil
    copyMem(addr block, from, sizeof(block))
    let clone = if block == nil: nil else: blazeCloneBlock(block, inner)
    copyMem(to, unsafeAddr clone, sizeof(clone))
    return
  if name.len > 4 and name[0 .. 3] == "ref<":
    let inner = name[4 ..< name.len - 1]
    if inner == "any":
      var value: float64 = 0.0
      copyMem(addr value, from, sizeof(value))
      let clone = blaze_rt_clone(value)
      copyMem(to, unsafeAddr clone, sizeof(clone))
      return
    var reference: pointer = nil
    copyMem(addr reference, from, sizeof(reference))
    let clone = if reference == nil: nil else: blazeCloneObject(reference)
    copyMem(to, unsafeAddr clone, sizeof(clone))
    return
  copyMem(to, from, blazeCloneSize(kind))

proc blazeCloneBlock(block: pointer; element: cstring): pointer =
  if block == nil: return nil
  let size = blazeCloneSize(element)
  if size == 0: return nil
  let bytes = blaze_rt_object_size(block)
  let count = bytes div size
  let copy = blaze_rt_allocate(bytes)
  for at in 0 ..< count:
    blazeCloneElement(cast[pointer](cast[uint](copy) + at * uint(size)), cast[pointer](cast[uint](block) + at * uint(size)), element)
  copy

## A record copied field by field, at the layout in its header.
proc blazeCloneObject(object: pointer): pointer =
  if object == nil: return nil
  let header = headerOf(object)
  if header[].magic != BlazeMagic or header[].descriptor == nil: return object
  let bytes = header[].length
  let copy = blaze_rt_allocate(csize_t(bytes))
  if bytes > 0'u64: copyMem(copy, object, csize_t(bytes))
  headerOf(copy)[].descriptor = header[].descriptor
  var field = cast[cstring](header[].descriptor)
  while field[0] != '\0':
    let name = $field
    field = cast[cstring](cast[uint](field) + uint(name.len) + 1)
    let offset = $field
    field = cast[cstring](cast[uint](field) + uint(offset.len) + 1)
    let kind = $field
    field = cast[cstring](cast[uint](field) + uint(kind.len) + 1)
    let at = uint(offset)
    blazeCloneElement(cast[pointer](cast[uint](copy) + at), cast[pointer](cast[uint](object) + at), kind)
  copy

## A dynamic value copied: an array copies its elements and an object copies
## its values; a number, a text and nothing are the value they already are.
proc blazeCloneDynamic(value: float64): float64 =
  let index = blazeDynIndex(value)
  if index < 0: return value
  let held = blazeDynValues[index]
  case held.kind
  of dynArray:
    var copy = BlazeDyn(kind: dynArray)
    for element in held.items: copy.items.add blaze_rt_clone(element)
    blazeDynRegister(copy)
  of dynObject:
    var copy = BlazeDyn(kind: dynObject)
    for entry in held.entries:
      copy.entries.add (entry[0], blaze_rt_clone(entry[1]))
    blazeDynRegister(copy)
  else:
    value

proc blaze_rt_clone_block*(block: pointer; element: cstring): pointer {.exportc, cdecl.} =
  blazeCloneBlock(block, element)

proc blaze_rt_clone*(value: float64): float64 {.exportc, cdecl.} =
  if blazeDynIndex(value) >= 0: return blazeCloneDynamic(value)
  if value >= 4096.0:
    let object = cast[pointer](cast[uint](value))
    let header = headerOf(object)
    if header[].magic == BlazeMagic and header[].descriptor != nil:
      return float64(cast[uint](blazeCloneObject(object)))
  value
proc blaze_rt_object_set_text*(target: float64, field, value: cstring): float64 {.exportc, cdecl.} = target
proc blaze_rt_object_set_ref*(target: float64, field: cstring, value: float64): float64 {.exportc, cdecl.} = target
proc blaze_rt_object_set_number*(target: float64, field: cstring, value: float64): float64 {.exportc, cdecl.} = target
proc blaze_rt_object_set_list*(target: float64, field: cstring, value: pointer): float64 {.exportc, cdecl.} = target
  ## The JSON of a record at an indent is written by the C runtime a module's
  ## functions link; a program driver passes its values to no module.
proc blaze_rt_parse_int*(text: cstring, radix: float64): float64 {.exportc, cdecl.} = 0.0
proc blaze_rt_from_code_point*(value: float64): cstring {.exportc, cdecl.} = nil
proc blaze_rt_text_code_point_at*(text: cstring, at: float64): float64 {.exportc, cdecl.} = 0.0
proc blaze_rt_text_bytes*(text: cstring): cstring {.exportc, cdecl.} = nil
proc blaze_rt_view_load_float*(bytes: cstring, at: float64, width: float64): float64 {.exportc, cdecl.} = 0.0
proc blaze_rt_view_store_float*(bytes: cstring, at: float64, value: float64, width: float64) {.exportc, cdecl.} = discard
proc blaze_rt_md5_create*(): float64 {.exportc, cdecl.} = 0.0
proc blaze_rt_md5_update*(hasher: float64, text: cstring): float64 {.exportc, cdecl.} = hasher
proc blaze_rt_md5_digest*(hasher: float64): float64 {.exportc, cdecl.} = 0.0
proc blaze_rt_sha256_create*(): float64 {.exportc, cdecl.} = 0.0
proc blaze_rt_sha256_update*(hasher: float64, text: cstring): float64 {.exportc, cdecl.} = hasher
proc blaze_rt_sha256_digest*(hasher: float64): float64 {.exportc, cdecl.} = 0.0
proc blaze_rt_date_parse*(text: cstring): float64 {.exportc, cdecl.} = 0.0
proc blaze_rt_file_read*(path: cstring, mode: cstring): float64 {.exportc, cdecl.} =
  ## The file's text, boxed as the dynamic value the runtime carries.
  if path == nil: return blaze_rt_box_string("")
  try:
    blaze_rt_box_string(readFile($path))
  except CatchableError:
    blaze_rt_box_string("")

proc blaze_rt_file_read_text*(path: cstring, mode: cstring): cstring {.exportc, cdecl.} =
  ## The file's text as the managed string a text value is.
  if path == nil: return blazePathManaged("")
  try:
    blazePathManaged(readFile($path))
  except CatchableError:
    blazePathManaged("")

proc c_open_flags(path: cstring, flags: cint): cint {.importc: "open", varargs, header: "<fcntl.h>".}
proc c_fsync(descriptor: cint): cint {.importc: "fsync", header: "<unistd.h>".}
proc c_close(descriptor: cint): cint {.importc: "close", header: "<unistd.h>".}

proc c_fopen(path, mode: cstring): pointer {.importc: "fopen", header: "<stdio.h>".}
proc c_fwrite(data: pointer, size, count: csize_t, stream: pointer): csize_t {.importc: "fwrite", header: "<stdio.h>".}
proc c_fclose(stream: pointer): cint {.importc: "fclose", header: "<stdio.h>".}
proc c_strlen(text: cstring): csize_t {.importc: "strlen", header: "<string.h>".}

proc blaze_rt_host_platform*(): cstring {.exportc, cdecl.} =
  ## The platform name the compiler spells.
  when defined(linux): blazePathManaged("linux")
  elif defined(macosx): blazePathManaged("darwin")
  else: blazePathManaged("unknown")

proc blaze_rt_host_architecture*(): cstring {.exportc, cdecl.} =
  ## The architecture name the compiler spells.
  when defined(amd64): blazePathManaged("x64")
  elif defined(arm64): blazePathManaged("arm64")
  elif defined(i386): blazePathManaged("ia32")
  else: blazePathManaged("unknown")

proc blaze_rt_process_run*(command, input: cstring, timeoutMs: float64, cwd: cstring): cstring {.exportc, cdecl.} =
  ## Runs a command line through the shell. The host's output and error
  ## streams are one stream here: the child's standard error is written to
  ## standard output, so a build that reads the error stream reads it empty.
  if command == nil:
    return blazePathManaged("{\"code\":-1,\"signal\":0,\"timedOut\":0,\"overflow\":0,\"stdout\":\"\",\"stderr\":\"\"}")
  var code = -1
  var output = ""
  var timedOut = false
  try:
    let process = startProcess($command, workingDir = (if cwd == nil: "" else: $cwd), options = {poUsePath, poEvalCommand, poStdErrToStdOut})
    try:
      process.inputStream.write(if input == nil: "" else: $input)
      process.inputStream.close()
      output = process.outputStream.readAll()
      let finished = if timeoutMs > 0.0: waitForExit(process, int(timeoutMs)) else: (waitForExit(process); true)
      if not finished:
        timedOut = true
        process.terminate()
      code = process.peekExitCode
    finally:
      process.close()
  except CatchableError:
    code = -1
  var node = %*{"code": code, "signal": 0, "timedOut": timedOut, "overflow": false, "stdout": output, "stderr": ""}
  blazePathManaged($node)

var blazeExitStatus: int = 0

proc c_isatty(fd: cint): cint {.importc: "isatty", header: "<unistd.h>".}

proc blaze_rt_stream_is_tty*(stream: float64): float64 {.exportc, cdecl.} =
  ## One where the output stream or the error stream is a terminal.
  let descriptor: cint = if stream == 2.0: 2 else: 1
  c_isatty(descriptor) != 0

proc blaze_rt_set_exit_code*(code: float64): float64 {.exportc, cdecl.} =
  ## Sets the status the process leaves with.
  blazeExitStatus = int(code)
  code

proc blaze_rt_exit_code*(): float64 {.exportc, cdecl.} =
  ## The status the process will leave with.
  float64(blazeExitStatus)

proc blaze_rt_read_line*(): cstring {.exportc, cdecl.} =
  ## One line of the input without its newline, and the empty text at the end.
  var line = ""
  try:
    if stdin.readLine(line): discard
  except CatchableError:
    line = ""
  blazePathManaged(line)

proc blaze_rt_cwd*(): cstring {.exportc, cdecl.} =
  ## The absolute path of the directory the process runs in.
  blazePathManaged(getCurrentDir())

proc blaze_rt_path_remove*(path: cstring, recursive: float64): float64 {.exportc, cdecl.} =
  ## Removes a file or directory, and answers whether the path is gone after
  ## the call. A path that is not there is removed already.
  if path == nil: return 0.0
  let name = $path
  if not os.exists(name): return 1.0
  try:
    if dirExists(name):
      if recursive == 0.0:
        for _ in walkDir(name): return 0.0
      removeDir(name)
    else:
      removeFile(name)
  except CatchableError:
    return 0.0
  1.0

proc blaze_rt_file_append*(path, text: cstring): float64 {.exportc, cdecl.} =
  ## Appends text to a file, making the file where it is not there yet, and
  ## answers the bytes appended.
  if path == nil: return 0.0
  let content = if text == nil: "" else: $text
  try:
    let stream = open($path, fmAppend)
    try:
      stream.write(content)
    finally:
      stream.close()
  except CatchableError:
    return 0.0
  float64(content.len)

proc blaze_rt_path_rename*(fromPath, toPath: cstring): float64 {.exportc, cdecl.} =
  ## Moves a file or directory to another path, and answers whether it moved.
  if fromPath == nil or toPath == nil: return 0.0
  try:
    if dirExists($fromPath): moveDir($fromPath, $toPath) else: moveFile($fromPath, $toPath)
  except CatchableError:
    return 0.0
  1.0

proc blaze_rt_dir_list*(path: cstring): cstring {.exportc, cdecl.} =
  ## The entries of the directory as a JSON array sorted by name, each with
  ## the kind one for a file, two for a directory and three for anything else.
  if path == nil: return blazePathManaged("[]")
  var entries: seq[(string, int)] = @[]
  for kind, name in walkDir($path):
    let base = extractFilename(name)
    if base == "." or base == "..": continue
    var code = 3
    if kind == pcFile: code = 1
    elif kind == pcDir: code = 2
    entries.add((base, code))
  entries.sort(proc (left, right: (string, int)): int = cmp(left[0], right[0]))
  var list = newJArray()
  for (name, code) in entries:
    list.add(%*{"name": name, "kind": code})
  blazePathManaged($list)

proc blaze_rt_path_kind*(path: cstring): float64 {.exportc, cdecl.} =
  ## Zero for nothing, one for a file, two for a directory, three for another
  ## kind of entry.
  if path == nil: return 0.0
  let name = $path
  if dirExists(name): return 2.0
  if fileExists(name): return 1.0
  if os.exists(name): return 3.0
  0.0

proc blaze_rt_path_exists*(path: cstring): float64 {.exportc, cdecl.} =
  ## One where the path names a file or a directory, and zero where it does not.
  if path == nil: return 0.0
  if os.exists($path): 1.0 else: 0.0

## The file services the compiler's own host adapter asks for. A path is the
## bytes the host takes, and the answers are the ones the C runtime gives: a
## path that is not there is the answer a question about it has, and a name a
## listing answers is a managed text that outlives the walk.
proc blaze_rt_file_write*(path: cstring, text: cstring, append: float64): float64 {.exportc, cdecl.} =
  if path == nil: return 0.0
  try:
    let body = if text == nil: "" else: $text
    if append != 0.0:
      var handle = open($path, fmAppend)
      handle.write(body)
      handle.close()
    else:
      writeFile($path, body)
    1.0
  except CatchableError:
    0.0

proc blaze_rt_file_exists*(path: cstring): float64 {.exportc, cdecl.} =
  if path == nil: return 0.0
  if fileExists($path) or dirExists($path): 1.0 else: 0.0

proc blaze_rt_file_size*(path: cstring): float64 {.exportc, cdecl.} =
  if path == nil: return -1.0
  try:
    if not fileExists($path): return -1.0
    float64(getFileSize($path))
  except CatchableError:
    -1.0

proc blaze_rt_file_kind*(path: cstring): float64 {.exportc, cdecl.} =
  if path == nil: return 0.0
  let name = $path
  if fileExists(name): return 1.0
  if dirExists(name): return 2.0
  if symlinkExists(name): return 3.0
  0.0

proc blaze_rt_dir_make*(path: cstring, parents: float64): float64 {.exportc, cdecl.} =
  if path == nil or path[0] == '\\0': return 0.0
  try:
    if parents != 0.0:
      createDir($path)
    elif posix.mkdir(path, Mode(0o777)) != 0 and not dirExists($path):
      return 0.0
    if dirExists($path): 1.0 else: 0.0
  except CatchableError:
    0.0

proc blaze_rt_file_remove*(path: cstring, recursive: float64): float64 {.exportc, cdecl.} =
  if path == nil: return 0.0
  let name = $path
  try:
    if dirExists(name):
      if recursive != 0.0:
        removeDir(name)
      elif posix.rmdir(name) != 0:
        return 0.0
    elif fileExists(name) or symlinkExists(name):
      removeFile(name)
    if fileExists(name) or dirExists(name) or symlinkExists(name): 0.0 else: 1.0
  except CatchableError:
    0.0

proc blaze_rt_file_rename*(source, destination: cstring): float64 {.exportc, cdecl.} =
  if source == nil or destination == nil: return 0.0
  try:
    moveFile($source, $destination)
    1.0
  except CatchableError:
    0.0

proc blaze_rt_file_copy*(source, destination: cstring): float64 {.exportc, cdecl.} =
  if source == nil or destination == nil: return 0.0
  try:
    copyFile($source, $destination)
    1.0
  except CatchableError:
    0.0

proc blaze_rt_dir_count*(path: cstring): float64 {.exportc, cdecl.} =
  if path == nil or not dirExists($path): return -1.0
  var count = 0
  for _ in walkDir($path):
    count += 1
  float64(count)

proc blaze_rt_dir_name*(path: cstring, index: float64): cstring {.exportc, cdecl.} =
  if path == nil or index < 0.0 or not dirExists($path): return ""
  let wanted = int(index)
  var at = 0
  for _, full in walkDir($path):
    if at == wanted:
      let name = lastPathPart(full)
      return blaze_rt_string_new(cast[pointer](name.cstring), csize_t(name.len))
    at += 1
  ""

proc blaze_rt_dir_is_dir*(path: cstring, index: float64): float64 {.exportc, cdecl.} =
  if path == nil or index < 0.0 or not dirExists($path): return 0.0
  let wanted = int(index)
  var at = 0
  for kind, _ in walkDir($path):
    if at == wanted:
      return if kind == pcDir: 1.0 else: 0.0
    at += 1
  0.0

proc blaze_rt_current_dir*(): cstring {.exportc, cdecl.} =
  try:
    let name = getCurrentDir()
    blaze_rt_string_new(cast[pointer](name.cstring), csize_t(name.len))
  except CatchableError:
    "."

proc blaze_rt_temp_dir*(): cstring {.exportc, cdecl.} =
  try:
    let name = getTempDir()
    blaze_rt_string_new(cast[pointer](name.cstring), csize_t(name.len))
  except CatchableError:
    "/tmp"

proc blaze_rt_process_id*(): float64 {.exportc, cdecl.} =
  float64(getCurrentProcessId())

proc blaze_rt_host_arch*(): cstring {.exportc, cdecl.} =
  when defined(amd64): "x64"
  elif defined(arm64): "arm64"
  elif defined(i386): "ia32"
  else: "unknown"

## The environment as the variables it holds, by position, and how many
## processors the host has.
proc blaze_rt_env_count*(): float64 {.exportc, cdecl.} =
  var count = 0
  for _ in envPairs(): count += 1
  float64(count)

proc blaze_rt_env_at*(index: float64): cstring {.exportc, cdecl.} =
  let wanted = int(index)
  if wanted < 0: return ""
  var at = 0
  for name, value in envPairs():
    if at == wanted:
      let entry = name & "=" & value
      return blaze_rt_string_new(cast[pointer](entry.cstring), csize_t(entry.len))
    at += 1
  ""

proc blaze_rt_cpu_count*(): float64 {.exportc, cdecl.} =
  let count = countProcessors()
  if count > 0: float64(count) else: 1.0

proc blaze_rt_random_uuid*(): cstring {.exportc, cdecl.} =
  var bytes: array[16, byte]
  try:
    let drawn = urandom(16)
    for at in 0 ..< 16: bytes[at] = drawn[at]
  except CatchableError:
    for at in 0 ..< 16: bytes[at] = byte(rand(255))
  bytes[6] = (bytes[6] and 0x0f) or 0x40
  bytes[8] = (bytes[8] and 0x3f) or 0x80
  const nibbles = "0123456789abcdef"
  var text = newString(36)
  var at = 0
  for byte in 0 ..< 16:
    if byte == 4 or byte == 6 or byte == 8 or byte == 10:
      text[at] = '-'
      at += 1
    text[at] = nibbles[int(bytes[byte] shr 4)]
    at += 1
    text[at] = nibbles[int(bytes[byte] and 15)]
    at += 1
  blaze_rt_string_new(cast[pointer](text.cstring), csize_t(36))

## A program started and waited for.

## The command the adapter builds is the arguments, the directory, the
## environment it overrides, the text it reads on standard input and the two
## streams it wrote. The runtime starts it the way the C runtime does: a fork,
## an exec, both streams read while it runs, and a signal for the deadline.
type
  BlazeCommand = ref object
    args: seq[string]
    cwd: string
    envNames: seq[string]
    envValues: seq[string]
    input: string
    hasInput: bool
    outText: string
    errText: string
    status: int
    signo: int
    errnum: int
    timedOut: bool

var blazeCommands: seq[BlazeCommand] = @[]

proc blazeCommandOf(handle: float64): BlazeCommand =
  let at = int(handle)
  if at <= 0 or at > blazeCommands.len: return nil
  blazeCommands[at - 1]

proc blazeCommandResolve(name: string, found: var string): bool =
  if name.len == 0: return false
  if '/' in name:
    found = name
    return posix.access(name.cstring, X_OK) == 0
  let path = if existsEnv("PATH"): getEnv("PATH") else: "/usr/local/bin:/usr/bin:/bin"
  for directory in path.split(':'):
    let candidate = if directory.len == 0: "./" & name else: directory & "/" & name
    if posix.access(candidate.cstring, X_OK) == 0:
      found = candidate
      return true
  false

proc blazeCommandEnvironment(command: BlazeCommand): seq[string] =
  var list: seq[string] = @[]
  for name, value in envPairs():
    if command.envNames.len > 0:
      var overridden = false
      for at in 0 ..< command.envNames.len:
        if command.envNames[at] == name:
          overridden = true
          break
      if overridden: continue
    list.add(name & "=" & value)
  for at in 0 ..< command.envNames.len:
    list.add(command.envNames[at] & "=" & command.envValues[at])
  list

proc blaze_rt_command_new*(): float64 {.exportc, cdecl.} =
  blazeCommands.add BlazeCommand(args: @[], envNames: @[], envValues: @[])
  float64(blazeCommands.len)

proc blaze_rt_command_arg*(handle: float64, text: cstring): float64 {.exportc, cdecl.} =
  let command = blazeCommandOf(handle)
  if command != nil and text != nil: command.args.add($text)
  handle

proc blaze_rt_command_cwd*(handle: float64, text: cstring): float64 {.exportc, cdecl.} =
  let command = blazeCommandOf(handle)
  if command != nil: command.cwd = if text == nil: "" else: $text
  handle

proc blaze_rt_command_env*(handle: float64, name, value: cstring): float64 {.exportc, cdecl.} =
  let command = blazeCommandOf(handle)
  if command != nil and name != nil and value != nil:
    command.envNames.add($name)
    command.envValues.add($value)
  handle

proc blaze_rt_command_input*(handle: float64, text: cstring): float64 {.exportc, cdecl.} =
  let command = blazeCommandOf(handle)
  if command != nil:
    command.input = if text == nil: "" else: $text
    command.hasInput = text != nil
  handle

proc blaze_rt_command_run*(handle: float64, timeoutMs: float64): float64 {.exportc, cdecl.} =
  let command = blazeCommandOf(handle)
  if command == nil: return -1.0
  command.outText = ""
  command.errText = ""
  command.timedOut = false
  command.signo = 0
  command.errnum = 0
  command.status = 0
  if command.args.len == 0:
    command.status = -1
    command.errnum = EINVAL
    return -1.0
  var path = ""
  if not blazeCommandResolve(command.args[0], path):
    command.status = -1
    command.errnum = ENOENT
    return -1.0
  let argv = allocCStringArray(command.args)
  let envp = allocCStringArray(blazeCommandEnvironment(command))
  var outPipe, errPipe, inPipe, execPipe: array[2, cint]
  if posix.pipe(outPipe) != 0 or posix.pipe(errPipe) != 0 or posix.pipe(execPipe) != 0:
    command.status = -1
    command.errnum = errno
    deallocCStringArray(argv)
    deallocCStringArray(envp)
    return -1.0
  let wantsInput = command.hasInput
  if wantsInput and posix.pipe(inPipe) != 0:
    command.status = -1
    command.errnum = errno
    deallocCStringArray(argv)
    deallocCStringArray(envp)
    return -1.0
  discard posix.fcntl(execPipe[1], F_SETFD, FD_CLOEXEC)
  let child = posix.fork()
  if child < 0:
    command.status = -1
    command.errnum = errno
    deallocCStringArray(argv)
    deallocCStringArray(envp)
    return -1.0
  if child == 0:
    discard posix.dup2(outPipe[1], STDOUT_FILENO)
    discard posix.dup2(errPipe[1], STDERR_FILENO)
    if wantsInput:
      discard posix.dup2(inPipe[0], STDIN_FILENO)
    else:
      let none = posix.open("/dev/null", O_RDONLY)
      if none >= 0: discard posix.dup2(none, STDIN_FILENO)
    discard posix.close(outPipe[0]); discard posix.close(outPipe[1])
    discard posix.close(errPipe[0]); discard posix.close(errPipe[1])
    if wantsInput:
      discard posix.close(inPipe[0]); discard posix.close(inPipe[1])
    if command.cwd.len > 0 and posix.chdir(command.cwd.cstring) != 0:
      let code = errno
      discard posix.write(execPipe[1], code.addr, sizeof(code))
      quit(127)
    discard posix.execve(path.cstring, argv, envp)
    let code = errno
    discard posix.write(execPipe[1], code.addr, sizeof(code))
    quit(127)
  discard posix.close(outPipe[1]); discard posix.close(errPipe[1]); discard posix.close(execPipe[1])
  if wantsInput:
    discard posix.close(inPipe[0])
    let body = command.input
    if body.len > 0:
      discard posix.write(inPipe[1], body.cstring, body.len)
    discard posix.close(inPipe[1])
  var execErrno: cint = 0
  let readExec = posix.read(execPipe[0], execErrno.addr, sizeof(execErrno))
  discard posix.close(execPipe[0])
  var fds: array[2, TPollfd]
  fds[0].fd = outPipe[0]; fds[0].events = POLLIN
  fds[1].fd = errPipe[0]; fds[1].events = POLLIN
  var openCount = 2
  var expired = false
  let started = getMonoTime().ticks
  while openCount > 0:
    var waitMs: cint = -1
    if timeoutMs > 0.0:
      let elapsed = (getMonoTime().ticks - started) div 1_000_000
      let remaining = int64(timeoutMs) - elapsed
      if remaining <= 0:
        expired = true
        break
      waitMs = cint(if remaining > 1000: 1000 else: remaining)
    let ready = posix.poll(addr fds[0], 2, waitMs)
    if ready < 0:
      if errno == EINTR: continue
      break
    for at in 0 ..< 2:
      if fds[at].fd < 0: continue
      if (fds[at].revents and (POLLIN or POLLHUP or POLLERR)) == 0: continue
      var buffer: array[8192, char]
      let got = posix.read(fds[at].fd, addr buffer[0], buffer.len)
      if got > 0:
        let chunk = newString(got)
        copyMem(addr chunk[0], addr buffer[0], got)
        if at == 0: command.outText.add(chunk) else: command.errText.add(chunk)
      elif got == 0:
        discard posix.close(fds[at].fd)
        fds[at].fd = -1
        openCount -= 1
      elif errno != EINTR and errno != EAGAIN:
        discard posix.close(fds[at].fd)
        fds[at].fd = -1
        openCount -= 1
  if fds[0].fd >= 0: discard posix.close(fds[0].fd)
  if fds[1].fd >= 0: discard posix.close(fds[1].fd)
  if expired:
    command.timedOut = true
    discard posix.kill(child, SIGKILL)
  var state: cint = 0
  while posix.waitpid(child, state, 0) < 0 and errno == EINTR: discard
  if readExec > 0:
    command.status = -1
    command.errnum = int(execErrno)
  elif WIFEXITED(state):
    command.status = int(WEXITSTATUS(state))
  elif WIFSIGNALED(state):
    command.status = -3
    command.signo = int(WTERMSIG(state))
  deallocCStringArray(argv)
  deallocCStringArray(envp)
  float64(command.status)

proc blaze_rt_command_signal*(handle: float64): float64 {.exportc, cdecl.} =
  let command = blazeCommandOf(handle)
  if command == nil: 0.0 else: float64(command.signo)

proc blaze_rt_command_errno*(handle: float64): float64 {.exportc, cdecl.} =
  let command = blazeCommandOf(handle)
  if command == nil: 0.0 else: float64(command.errnum)

proc blaze_rt_command_timed_out*(handle: float64): float64 {.exportc, cdecl.} =
  let command = blazeCommandOf(handle)
  if command != nil and command.timedOut: 1.0 else: 0.0

proc blaze_rt_command_stdout*(handle: float64): cstring {.exportc, cdecl.} =
  let command = blazeCommandOf(handle)
  if command == nil: "" else: command.outText.cstring

proc blaze_rt_command_stderr*(handle: float64): cstring {.exportc, cdecl.} =
  let command = blazeCommandOf(handle)
  if command == nil: "" else: command.errText.cstring

proc blaze_rt_command_free*(handle: float64) {.exportc, cdecl.} =
  let at = int(handle)
  if at <= 0 or at > blazeCommands.len: return
  blazeCommands[at - 1] = nil

## A path's bytes and its name written out to the disk: the store syncs the
## temporary file and the directory it is renamed in, and a directory is opened
## the way a file is.
proc blaze_rt_file_sync*(path: cstring): float64 {.exportc, cdecl.} =
  if path == nil: return 0.0
  let fd = posix.open(path, O_RDONLY)
  if fd < 0: return 0.0
  let synced = posix.fsync(fd) == 0
  discard posix.close(fd)
  if synced: 1.0 else: 0.0

proc blaze_rt_sleep_ms*(milliseconds: float64): float64 {.exportc, cdecl.} =
  ## A wait of a number of milliseconds, which a retry or a poll asks for to
  ## give the host time.
  if milliseconds > 0.0:
    sleep(int(milliseconds))
  1.0

## The file services the compiler's own host adapter asks for. A path is the
## bytes the host takes, and the answers are the ones the C runtime gives: a
## path that is not there is the answer a question about it has, and a name a
## listing answers is a managed text that outlives the walk.
proc blaze_rt_file_write*(path: cstring, text: cstring, append: float64): float64 {.exportc, cdecl.} =
  if path == nil: return 0.0
  try:
    let body = if text == nil: "" else: $text
    if append != 0.0:
      var handle = open($path, fmAppend)
      handle.write(body)
      handle.close()
    else:
      writeFile($path, body)
    1.0
  except CatchableError:
    0.0

proc blaze_rt_file_exists*(path: cstring): float64 {.exportc, cdecl.} =
  if path == nil: return 0.0
  if fileExists($path) or dirExists($path): 1.0 else: 0.0

proc blaze_rt_file_size*(path: cstring): float64 {.exportc, cdecl.} =
  if path == nil: return -1.0
  try:
    if not fileExists($path): return -1.0
    float64(getFileSize($path))
  except CatchableError:
    -1.0

proc blaze_rt_file_kind*(path: cstring): float64 {.exportc, cdecl.} =
  if path == nil: return 0.0
  let name = $path
  if fileExists(name): return 1.0
  if dirExists(name): return 2.0
  if symlinkExists(name): return 3.0
  0.0

proc blaze_rt_dir_make*(path: cstring, parents: float64): float64 {.exportc, cdecl.} =
  if path == nil or path[0] == '\\0': return 0.0
  try:
    if parents != 0.0:
      createDir($path)
    elif posix.mkdir(path, Mode(0o777)) != 0 and not dirExists($path):
      return 0.0
    if dirExists($path): 1.0 else: 0.0
  except CatchableError:
    0.0

proc blaze_rt_file_remove*(path: cstring, recursive: float64): float64 {.exportc, cdecl.} =
  if path == nil: return 0.0
  let name = $path
  try:
    if dirExists(name):
      if recursive != 0.0:
        removeDir(name)
      elif posix.rmdir(name) != 0:
        return 0.0
    elif fileExists(name) or symlinkExists(name):
      removeFile(name)
    if fileExists(name) or dirExists(name) or symlinkExists(name): 0.0 else: 1.0
  except CatchableError:
    0.0

proc blaze_rt_file_rename*(source, destination: cstring): float64 {.exportc, cdecl.} =
  if source == nil or destination == nil: return 0.0
  try:
    moveFile($source, $destination)
    1.0
  except CatchableError:
    0.0

proc blaze_rt_file_copy*(source, destination: cstring): float64 {.exportc, cdecl.} =
  if source == nil or destination == nil: return 0.0
  try:
    copyFile($source, $destination)
    1.0
  except CatchableError:
    0.0

proc blaze_rt_dir_count*(path: cstring): float64 {.exportc, cdecl.} =
  if path == nil or not dirExists($path): return -1.0
  var count = 0
  for _ in walkDir($path):
    count += 1
  float64(count)

proc blaze_rt_dir_name*(path: cstring, index: float64): cstring {.exportc, cdecl.} =
  if path == nil or index < 0.0 or not dirExists($path): return ""
  let wanted = int(index)
  var at = 0
  for _, full in walkDir($path):
    if at == wanted:
      let name = lastPathPart(full)
      return blaze_rt_string_new(cast[pointer](name.cstring), csize_t(name.len))
    at += 1
  ""

proc blaze_rt_dir_is_dir*(path: cstring, index: float64): float64 {.exportc, cdecl.} =
  if path == nil or index < 0.0 or not dirExists($path): return 0.0
  let wanted = int(index)
  var at = 0
  for kind, _ in walkDir($path):
    if at == wanted:
      return if kind == pcDir: 1.0 else: 0.0
    at += 1
  0.0

proc blaze_rt_current_dir*(): cstring {.exportc, cdecl.} =
  try:
    let name = getCurrentDir()
    blaze_rt_string_new(cast[pointer](name.cstring), csize_t(name.len))
  except CatchableError:
    "."

proc blaze_rt_temp_dir*(): cstring {.exportc, cdecl.} =
  try:
    let name = getTempDir()
    blaze_rt_string_new(cast[pointer](name.cstring), csize_t(name.len))
  except CatchableError:
    "/tmp"

proc blaze_rt_process_id*(): float64 {.exportc, cdecl.} =
  float64(getCurrentProcessId())

proc blaze_rt_host_platform*(): cstring {.exportc, cdecl.} =
  when defined(linux): "linux"
  elif defined(macosx): "darwin"
  elif defined(windows): "win32"
  elif defined(qnx): "qnx"
  else: "unknown"

proc blaze_rt_host_arch*(): cstring {.exportc, cdecl.} =
  when defined(amd64): "x64"
  elif defined(arm64): "arm64"
  elif defined(i386): "ia32"
  else: "unknown"

## The environment as the variables it holds, by position, and how many
## processors the host has.
proc blaze_rt_env_count*(): float64 {.exportc, cdecl.} =
  var count = 0
  for _ in envPairs(): count += 1
  float64(count)

proc blaze_rt_env_at*(index: float64): cstring {.exportc, cdecl.} =
  let wanted = int(index)
  if wanted < 0: return ""
  var at = 0
  for name, value in envPairs():
    if at == wanted:
      let entry = name & "=" & value
      return blaze_rt_string_new(cast[pointer](entry.cstring), csize_t(entry.len))
    at += 1
  ""

proc blaze_rt_cpu_count*(): float64 {.exportc, cdecl.} =
  let count = countProcessors()
  if count > 0: float64(count) else: 1.0

proc blaze_rt_random_uuid*(): cstring {.exportc, cdecl.} =
  var bytes: array[16, byte]
  try:
    let drawn = urandom(16)
    for at in 0 ..< 16: bytes[at] = drawn[at]
  except CatchableError:
    for at in 0 ..< 16: bytes[at] = byte(rand(255))
  bytes[6] = (bytes[6] and 0x0f) or 0x40
  bytes[8] = (bytes[8] and 0x3f) or 0x80
  const nibbles = "0123456789abcdef"
  var text = newString(36)
  var at = 0
  for byte in 0 ..< 16:
    if byte == 4 or byte == 6 or byte == 8 or byte == 10:
      text[at] = '-'
      at += 1
    text[at] = nibbles[int(bytes[byte] shr 4)]
    at += 1
    text[at] = nibbles[int(bytes[byte] and 15)]
    at += 1
  blaze_rt_string_new(cast[pointer](text.cstring), csize_t(36))

## A program started and waited for.

## The command the adapter builds is the arguments, the directory, the
## environment it overrides, the text it reads on standard input and the two
## streams it wrote. The runtime starts it the way the C runtime does: a fork,
## an exec, both streams read while it runs, and a signal for the deadline.
type
  BlazeCommand = ref object
    args: seq[string]
    cwd: string
    envNames: seq[string]
    envValues: seq[string]
    input: string
    hasInput: bool
    outText: string
    errText: string
    status: int
    signo: int
    errnum: int
    timedOut: bool

var blazeCommands: seq[BlazeCommand] = @[]

proc blazeCommandOf(handle: float64): BlazeCommand =
  let at = int(handle)
  if at <= 0 or at > blazeCommands.len: return nil
  blazeCommands[at - 1]

proc blazeCommandResolve(name: string, found: var string): bool =
  if name.len == 0: return false
  if '/' in name:
    found = name
    return posix.access(name.cstring, X_OK) == 0
  let path = if existsEnv("PATH"): getEnv("PATH") else: "/usr/local/bin:/usr/bin:/bin"
  for directory in path.split(':'):
    let candidate = if directory.len == 0: "./" & name else: directory & "/" & name
    if posix.access(candidate.cstring, X_OK) == 0:
      found = candidate
      return true
  false

proc blazeCommandEnvironment(command: BlazeCommand): seq[string] =
  var list: seq[string] = @[]
  for name, value in envPairs():
    if command.envNames.len > 0:
      var overridden = false
      for at in 0 ..< command.envNames.len:
        if command.envNames[at] == name:
          overridden = true
          break
      if overridden: continue
    list.add(name & "=" & value)
  for at in 0 ..< command.envNames.len:
    list.add(command.envNames[at] & "=" & command.envValues[at])
  list

proc blaze_rt_command_new*(): float64 {.exportc, cdecl.} =
  blazeCommands.add BlazeCommand(args: @[], envNames: @[], envValues: @[])
  float64(blazeCommands.len)

proc blaze_rt_command_arg*(handle: float64, text: cstring): float64 {.exportc, cdecl.} =
  let command = blazeCommandOf(handle)
  if command != nil and text != nil: command.args.add($text)
  handle

proc blaze_rt_command_cwd*(handle: float64, text: cstring): float64 {.exportc, cdecl.} =
  let command = blazeCommandOf(handle)
  if command != nil: command.cwd = if text == nil: "" else: $text
  handle

proc blaze_rt_command_env*(handle: float64, name, value: cstring): float64 {.exportc, cdecl.} =
  let command = blazeCommandOf(handle)
  if command != nil and name != nil and value != nil:
    command.envNames.add($name)
    command.envValues.add($value)
  handle

proc blaze_rt_command_input*(handle: float64, text: cstring): float64 {.exportc, cdecl.} =
  let command = blazeCommandOf(handle)
  if command != nil:
    command.input = if text == nil: "" else: $text
    command.hasInput = text != nil
  handle

proc blaze_rt_command_run*(handle: float64, timeoutMs: float64): float64 {.exportc, cdecl.} =
  let command = blazeCommandOf(handle)
  if command == nil: return -1.0
  command.outText = ""
  command.errText = ""
  command.timedOut = false
  command.signo = 0
  command.errnum = 0
  command.status = 0
  if command.args.len == 0:
    command.status = -1
    command.errnum = EINVAL
    return -1.0
  var path = ""
  if not blazeCommandResolve(command.args[0], path):
    command.status = -1
    command.errnum = ENOENT
    return -1.0
  let argv = allocCStringArray(command.args)
  let envp = allocCStringArray(blazeCommandEnvironment(command))
  var outPipe, errPipe, inPipe, execPipe: array[2, cint]
  if posix.pipe(outPipe) != 0 or posix.pipe(errPipe) != 0 or posix.pipe(execPipe) != 0:
    command.status = -1
    command.errnum = errno
    deallocCStringArray(argv)
    deallocCStringArray(envp)
    return -1.0
  let wantsInput = command.hasInput
  if wantsInput and posix.pipe(inPipe) != 0:
    command.status = -1
    command.errnum = errno
    deallocCStringArray(argv)
    deallocCStringArray(envp)
    return -1.0
  discard posix.fcntl(execPipe[1], F_SETFD, FD_CLOEXEC)
  let child = posix.fork()
  if child < 0:
    command.status = -1
    command.errnum = errno
    deallocCStringArray(argv)
    deallocCStringArray(envp)
    return -1.0
  if child == 0:
    discard posix.dup2(outPipe[1], STDOUT_FILENO)
    discard posix.dup2(errPipe[1], STDERR_FILENO)
    if wantsInput:
      discard posix.dup2(inPipe[0], STDIN_FILENO)
    else:
      let none = posix.open("/dev/null", O_RDONLY)
      if none >= 0: discard posix.dup2(none, STDIN_FILENO)
    discard posix.close(outPipe[0]); discard posix.close(outPipe[1])
    discard posix.close(errPipe[0]); discard posix.close(errPipe[1])
    if wantsInput:
      discard posix.close(inPipe[0]); discard posix.close(inPipe[1])
    if command.cwd.len > 0 and posix.chdir(command.cwd.cstring) != 0:
      let code = errno
      discard posix.write(execPipe[1], code.addr, sizeof(code))
      quit(127)
    discard posix.execve(path.cstring, argv, envp)
    let code = errno
    discard posix.write(execPipe[1], code.addr, sizeof(code))
    quit(127)
  discard posix.close(outPipe[1]); discard posix.close(errPipe[1]); discard posix.close(execPipe[1])
  if wantsInput:
    discard posix.close(inPipe[0])
    let body = command.input
    if body.len > 0:
      discard posix.write(inPipe[1], body.cstring, body.len)
    discard posix.close(inPipe[1])
  var execErrno: cint = 0
  let readExec = posix.read(execPipe[0], execErrno.addr, sizeof(execErrno))
  discard posix.close(execPipe[0])
  var fds: array[2, TPollfd]
  fds[0].fd = outPipe[0]; fds[0].events = POLLIN
  fds[1].fd = errPipe[0]; fds[1].events = POLLIN
  var openCount = 2
  var expired = false
  let started = getMonoTime().ticks
  while openCount > 0:
    var waitMs: cint = -1
    if timeoutMs > 0.0:
      let elapsed = (getMonoTime().ticks - started) div 1_000_000
      let remaining = int64(timeoutMs) - elapsed
      if remaining <= 0:
        expired = true
        break
      waitMs = cint(if remaining > 1000: 1000 else: remaining)
    let ready = posix.poll(addr fds[0], 2, waitMs)
    if ready < 0:
      if errno == EINTR: continue
      break
    for at in 0 ..< 2:
      if fds[at].fd < 0: continue
      if (fds[at].revents and (POLLIN or POLLHUP or POLLERR)) == 0: continue
      var buffer: array[8192, char]
      let got = posix.read(fds[at].fd, addr buffer[0], buffer.len)
      if got > 0:
        let chunk = newString(got)
        copyMem(addr chunk[0], addr buffer[0], got)
        if at == 0: command.outText.add(chunk) else: command.errText.add(chunk)
      elif got == 0:
        discard posix.close(fds[at].fd)
        fds[at].fd = -1
        openCount -= 1
      elif errno != EINTR and errno != EAGAIN:
        discard posix.close(fds[at].fd)
        fds[at].fd = -1
        openCount -= 1
  if fds[0].fd >= 0: discard posix.close(fds[0].fd)
  if fds[1].fd >= 0: discard posix.close(fds[1].fd)
  if expired:
    command.timedOut = true
    discard posix.kill(child, SIGKILL)
  var state: cint = 0
  while posix.waitpid(child, state, 0) < 0 and errno == EINTR: discard
  if readExec > 0:
    command.status = -1
    command.errnum = int(execErrno)
  elif WIFEXITED(state):
    command.status = int(WEXITSTATUS(state))
  elif WIFSIGNALED(state):
    command.status = -3
    command.signo = int(WTERMSIG(state))
  deallocCStringArray(argv)
  deallocCStringArray(envp)
  float64(command.status)

proc blaze_rt_command_signal*(handle: float64): float64 {.exportc, cdecl.} =
  let command = blazeCommandOf(handle)
  if command == nil: 0.0 else: float64(command.signo)

proc blaze_rt_command_errno*(handle: float64): float64 {.exportc, cdecl.} =
  let command = blazeCommandOf(handle)
  if command == nil: 0.0 else: float64(command.errnum)

proc blaze_rt_command_timed_out*(handle: float64): float64 {.exportc, cdecl.} =
  let command = blazeCommandOf(handle)
  if command != nil and command.timedOut: 1.0 else: 0.0

proc blaze_rt_command_stdout*(handle: float64): cstring {.exportc, cdecl.} =
  let command = blazeCommandOf(handle)
  if command == nil: "" else: command.outText.cstring

proc blaze_rt_command_stderr*(handle: float64): cstring {.exportc, cdecl.} =
  let command = blazeCommandOf(handle)
  if command == nil: "" else: command.errText.cstring

proc blaze_rt_command_free*(handle: float64) {.exportc, cdecl.} =
  let at = int(handle)
  if at <= 0 or at > blazeCommands.len: return
  blazeCommands[at - 1] = nil

## A path's bytes and its name written out to the disk: the store syncs the
## temporary file and the directory it is renamed in, and a directory is opened
## the way a file is.
proc blaze_rt_file_sync*(path: cstring): float64 {.exportc, cdecl.} =
  if path == nil: return 0.0
  let fd = posix.open(path, O_RDONLY)
  if fd < 0: return 0.0
  let synced = posix.fsync(fd) == 0
  discard posix.close(fd)
  if synced: 1.0 else: 0.0

proc blaze_rt_sleep_ms*(milliseconds: float64): float64 {.exportc, cdecl.} =
  ## A wait of a number of milliseconds, which a retry or a poll asks for to
  ## give the host time.
  if milliseconds > 0.0:
    sleep(int(milliseconds))
  1.0

proc getenv(name: cstring): cstring {.importc: "getenv", header: "<stdlib.h>".}

proc blaze_rt_env_get*(name: cstring): cstring {.exportc, cdecl.} =
  ## The environment variable NAME, as the text it is set to. The value
  ## belongs to the environment and lives as long as the process does, so it
  ## is handed back the way it was borrowed. A name the environment sets
  ## nothing for is the empty text.
  if name == nil:
    return ""
  let value = getenv(name)
  if value == nil:
    ""
  else:
    value

proc blazePathManaged(text: string): cstring =
  ## The text as the managed string the runtime hands a caller.
  if text.len == 0:
    return blaze_rt_string_new(nil, 0)
  blaze_rt_string_new(unsafeAddr text[0], csize_t(text.len))

proc blazePathNormalize(path: string): string =
  ## The path with its empty, '.' and '..' parts resolved. A trailing
  ## separator is kept, as the language keeps it: normalize("a/b/") is "a/b/"
  ## and normalize("a/../") is "./".
  let absolute = path.len > 0 and path[0] == '/'
  let trailing = path.len > 0 and path[^1] == '/'
  var parts: seq[string] = @[]
  for part in path.split('/'):
    if part.len == 0 or part == ".":
      continue
    if part == "..":
      if parts.len > 0 and parts[^1] != "..":
        parts.setLen(parts.len - 1)
      elif not absolute:
        parts.add("..")
      continue
    parts.add(part)
  if parts.len == 0:
    if absolute:
      return "/"
    return if trailing: "./" else: "."
  let joined = parts.join("/")
  let text = if absolute: "/" & joined else: joined
  if trailing: text & "/" else: text

proc blazePathDirname(path: string): string =
  ## The directory of a path, found the way the language finds it: a run of
  ## trailing separators names no part of its own, and "a//b" keeps the
  ## separator before "b" in the directory it answers.
  if path.len == 0:
    return "."
  let hasRoot = path[0] == '/'
  var ending = -1
  var matchedSlash = true
  var at = path.len - 1
  while at >= 1:
    if path[at] == '/':
      if not matchedSlash:
        ending = at
        break
    else:
      matchedSlash = false
    at -= 1
  if ending == -1:
    return if hasRoot: "/" else: "."
  if hasRoot and ending == 1:
    return "//"
  path[0 ..< ending]

proc blaze_rt_path_dirname*(path: cstring): cstring {.exportc, cdecl.} =
  let text = if path == nil: "" else: $path
  blazePathManaged(blazePathDirname(text))

proc blaze_rt_path_normalize*(path: cstring): cstring {.exportc, cdecl.} =
  let text = if path == nil: "" else: $path
  blazePathManaged(blazePathNormalize(text))

proc blaze_rt_path_join*(left: cstring, right: cstring): cstring {.exportc, cdecl.} =
  let first = if left == nil: "" else: $left
  let second = if right == nil: "" else: $right
  let combined = if first.len == 0: blazePathNormalize(second)
    elif second.len == 0: blazePathNormalize(first)
    else: blazePathNormalize(first & "/" & second)
  blazePathManaged(combined)
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

/**
 * Compiles the adapter and the host, and links the candidate object in.
 *
 * Everything this writes goes in a directory of the candidate's own, because
 * candidates are built alongside each other now and a shared one is a race
 * rather than a saving. The adapter is the case that looks harmless and is
 * not: every candidate writes the same bytes to the same path, so one of them
 * truncating the file while another's compiler is halfway through reading it
 * is a build that fails on a module that was complete a moment before. The
 * cache is the other: a nimcache shared by two compilers writing two different
 * programs into it is a cache neither of them can rely on.
 *
 * Per-candidate caches are not free — the second candidate of a build used to
 * reuse the first one's, and now compiles the Nim standard library again — but
 * the reuse was worth less than the compiling it was serialised behind, and
 * this is the only way a candidate can be built at the same time as another.
 */
export async function buildHostProgram(request: HostRequest): Promise<HostResult> {
  const functionName = request.contract.function.name;
  const base = `${request.workDirectory}/${request.candidate}`;
  // The adapter is imported by its module name, so the file has to be named
  // after it, and a module is looked for beside the file that imports it: the
  // two of them share a directory for that reason and nothing else.
  const directory = `${base}_host`;
  const adapterPath = `${directory}/${RUNTIME_NAME}.nim`;
  const hostPath = `${directory}/host.nim`;
  // A hosted build delivers the host program, so it takes the executable path a
  // standalone build gives its harness.
  const executable = `${base}${EXECUTABLE_SUFFIX}`;

  await mkdir(directory, { recursive: true });
  await writeFile(adapterPath, generateRuntimeAdapterSource(request.mode), "utf8");
  await writeFile(hostPath, generateHostSource(request.contract, request.demoRequest), "utf8");

  const result = run(
    "nim",
    [
      "c",
      "--hints:off",
      "--warnings:off",
      ...nimOptimizationOptions(request.mode),
      `--nimcache:${directory}/nimcache`,
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

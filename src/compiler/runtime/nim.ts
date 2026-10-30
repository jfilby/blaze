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

import { mkdir, writeFile } from "node:fs/promises";
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
import std/[strutils, math, monotimes, random]

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
    alignment: alignment, refs: 1, capacity: bytes)
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
                           alignment: align, refs: 1, capacity: bytes)
    return cast[pointer](cast[uint](header) + BlazeHeaderSize)
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

proc blaze_rt_print_text*(text: cstring) {.exportc, cdecl.} =
  if text != nil: stdout.write($text)

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

proc blaze_rt_array_set*(array, index, value: float64) {.exportc, cdecl.} =
  ## One element written, where the array holds it. An index that names no
  ## element writes nothing, which is what the C runtime answers.
  let at = blazeDynIndex(array)
  if at < 0 or blazeDynValues[at].kind != dynArray: return
  let position = int(index)
  if position < 0 or position >= blazeDynValues[at].items.len: return
  blazeDynValues[at].items[position] = value

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
proc blaze_rt_md5_create*(): float64 {.exportc, cdecl.} = 0.0
proc blaze_rt_md5_update*(hasher: float64, text: cstring): float64 {.exportc, cdecl.} = hasher
proc blaze_rt_md5_digest*(hasher: float64): float64 {.exportc, cdecl.} = 0.0
proc blaze_rt_file_read*(path: cstring, mode: cstring): float64 {.exportc, cdecl.} = 0.0

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

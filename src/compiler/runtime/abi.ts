/**
 * The blaze runtime ABI.
 *
 * Blaze owns computation; a runtime owns runtime services. Generated code
 * never talks to a host implementation directly: it calls the entry points
 * below, and whichever runtime is linked provides them. `none` gets the C
 * runtime the compiler emits itself, `nim` gets the Nim adapter, and the code
 * the compiler writes is identical either way.
 *
 * This module is the single description of that boundary. The C header, the
 * standalone C runtime, the symbol allowlist and the Nim adapter are all
 * generated from RUNTIME_ABI, so the ABI cannot drift between the sides that
 * implement it.
 */

import type { BuildMode, RuntimeKind } from "../core/types.ts";
import { isHttpSymbol } from "./http.ts";

/** The name of the C header, the Nim adapter module and the object file. */
export const RUNTIME_NAME = "blaze_rt";

/**
 * The alignment a block carries when its caller names none, which is the
 * header's `BLAZE_RT_DEFAULT_ALIGNMENT`. A field of an object is at most a
 * pointer wide, so this covers every layout the resolver lays out, and a
 * backend that allocates a block itself has to know the alignment it is
 * getting rather than assume it.
 */
export const DEFAULT_ALIGNMENT = 16;

/** Every runtime the compiler knows about, by the kind that selects it. */
export const RUNTIME_TITLES: Record<RuntimeKind, string> = {
  none: "the compiler runtime",
  nim: "the Nim host runtime",
  facil: "the facil.io HTTP server runtime",
};

/**
 * What an entry point serves. A function reaches a few of the twenty, so the
 * prompt offers the ones a contract can need and a tag is how it says which.
 */
export type RuntimeTag = "host" | "memory" | "object" | "output" | "arguments" | "lifetime" | "error";

/** One entry point of the ABI. */

export interface RuntimeEntry {
  symbol: string;
  returns: string;
  params: readonly (readonly [name: string, type: string])[];
  /** What the entry point does, in one line, for whoever calls it. */
  summary: string;
  /** Who owns what the call returns, or what it frees. */
  ownership: string;
  /** True when the call never returns to its caller. */
  noreturn?: boolean;
  /** What the entry point serves: a host calls it, or a function can. */
  tags: readonly RuntimeTag[];
}

function entry(
  symbol: string,
  returns: string,
  params: readonly (readonly [string, string])[],
  summary: string,
  ownership: string,
  extra: { noreturn?: boolean; tags: readonly RuntimeTag[] },
): RuntimeEntry {
  return { symbol, returns, params, summary, ownership, ...extra };
}

/**
 * The ABI, in call order. Managed memory is described by a 48 byte header that
 * every runtime writes in front of the payload, so `release` and `retain` are
 * implementable by any host without knowing how the memory was obtained.
 */
export const RUNTIME_ABI: readonly RuntimeEntry[] = [
  entry("blaze_rt_initialize", "void", [], "Prepares the runtime.", "Call once before any other entry point.", { tags: ["host"] }),
  entry(
    "blaze_rt_finalize",
    "void",
    [],
    "Releases what the runtime holds itself.",
    "Call once, after the last managed value has been released.",
    { tags: ["host"] },
  ),
  entry(
    "blaze_rt_allocate",
    "void*",
    [["bytes", "size_t"]],
    "Allocates zeroed memory aligned to at least 16 bytes.",
    "Returns a managed pointer with one reference, owned by the caller.",
    { tags: ["memory"] },
  ),
  entry(
    "blaze_rt_allocate_uninitialized",
    "void*",
    [["bytes", "size_t"]],
    "Allocates memory aligned to at least 16 bytes, without clearing it.",
    "For a caller that writes every byte before reading any: an array literal, an object literal and a built string each write their whole payload. Returns a managed pointer with one reference, owned by the caller.",
    { tags: ["memory"] },
  ),
  entry("blaze_rt_json_parse", "double", [["text", "double"]], "Parses JSON into a dynamic value.", "Returns a managed dynamic value.", { tags: ["object"] }),
  entry("blaze_rt_json_stringify", "double", [["value", "double"]], "Stringifies a dynamic value.", "Returns a managed string.", { tags: ["object"] }),
  entry("blaze_rt_md5_create", "double", [], "Creates an MD5 hasher.", "Returns a managed hasher.", { tags: ["object"] }),
  entry("blaze_rt_md5_update", "double", [["hasher", "double"], ["text", "const char*"]], "Feeds text to an MD5 hasher.", "Returns the hasher.", { tags: ["object"] }),
  entry("blaze_rt_md5_digest", "double", [["hasher", "double"]], "Finalizes and returns the hex digest.", "Returns a managed string.", { tags: ["object"] }),
  entry("blaze_rt_file_read", "double", [["path", "const char*"], ["mode", "const char*"]], "Reads a file as text.", "Returns a managed string.", { tags: ["object"] }),
  entry("blaze_rt_array_push", "double", [["array", "double"], ["value", "double"]], "Appends a dynamic value to a dynamic array.", "Returns the array.", { tags: ["object"] }),
  entry("blaze_rt_dyn_array_new", "double", [], "Creates an empty dynamic array.", "Returns a managed handle.", { tags: ["object"] }),
  entry("blaze_rt_to_text", "const char*", [["value", "double"]], "Renders a dynamic value as text.", "Returns a managed string.", { tags: ["object"] }),
  entry("blaze_rt_box_number", "double", [["value", "double"]], "Boxes a number as a dynamic value.", "Returns a managed handle.", { tags: ["object"] }),
  entry("blaze_rt_box_string", "double", [["value", "const char*"]], "Boxes a string as a dynamic value.", "Returns a managed handle.", { tags: ["object"] }),
  entry("blaze_rt_box_null", "double", [], "Boxes null as a dynamic value.", "Returns a managed handle.", { tags: ["object"] }),
  entry("blaze_rt_to_number", "double", [["value", "double"]], "Converts a dynamic value to a number.", "Returns the number.", { tags: ["object"] }),
  entry(
    "blaze_rt_region_enter",
    "void",
    [],
    "Begins a region: every block the program allocates until it leaves is taken from this thread's region cursor.",
    "A region exists so that a turn which builds something and drops it can take the same storage again on the next turn, rather than asking for memory that has to be faulted in afresh. The compiler emits this around a loop it proved every allocation of whose turns is dead by the end of the turn. Regions nest: a turn of one marked loop may call a function whose own turn is marked too, and only the outermost one rewinds, because a rewind inside the call would hand the outer turn's blocks out a second time while it is still reading them.",
    { tags: ["memory"] },
  ),
  entry(
    "blaze_rt_region_leave",
    "void",
    [],
    "Ends the region begun by blaze_rt_region_enter.",
    "Nothing is freed: the storage goes back to being this thread's cursor, and the next region begins at its start again. A block allocated in a region is never referenced after the turn that made it — that is what the compiler proved before it emitted this — so there is nothing to hand back and nothing that still points at it. Leaving more often than entering ends the outermost region rather than underflowing, which is what the paths that leave a turn early make necessary.",
    { tags: ["memory"] },
  ),
  entry(
    "blaze_rt_parallel_for",
    "void",
    [
      ["count", "size_t"],
      // A parameter that is a pointer to a function is declared without a name:
      // the header is written as `type name`, and such a name has to sit
      // inside the declarator rather than after it.
      ["", "void (*)(void*, size_t, size_t)"],
      ["frame", "void*"],
    ],
    "Runs `turn` over the counters [0, count) on a team of threads, one call per thread with the half-open range it answers.",
    "The range is split into as many parts as there are processors and each part is run exactly once, so a turn writes what no other turn writes. The calling thread runs the last part itself and joins the rest before returning, so everything the caller reads afterwards is written by then. A count too small to divide is run on the calling thread alone. The frame is handed to each turn as it is to the caller: it is the caller's own stack frame, and a turn reads the values it was built to read out of it and copies them into a frame of its own.",
    { tags: ["memory"] },
  ),
  entry(
    "blaze_rt_reallocate",
    "void*",
    [
      ["pointer", "void*"],
      ["bytes", "size_t"],
    ],
    "Resizes a managed block, keeping its contents and its reference.",
    "Returns the managed pointer; a null pointer allocates. A block grown within the capacity it already has is returned as it stands, with no copy. A block that has to move is one the caller holds alone: every other holder of it is left pointing at the block the move released, so a shared block is refused by name in a guarded build.",
    { tags: ["memory"] },
  ),
  entry(
    "blaze_rt_string_append",
    "const char*",
    [
      ["left", "const char*"],
      ["right", "const char*"],
    ],
    "Joins two strings into one managed string.",
    "A null side is the empty string. Returns a managed string the caller owns. The left string is reused in place when it is the only reference to it and has room, so appending in a loop is not quadratic.",
    { tags: ["memory"] },
  ),
  entry(
    "blaze_rt_retain",
    "void*",
    [["pointer", "void*"]],
    "Adds a reference to a managed value.",
    "Returns the same pointer; every retain needs a matching release.",
    { tags: ["lifetime"] },
  ),
  entry(
    "blaze_rt_release",
    "void",
    [["pointer", "void*"]],
    "Drops one reference, freeing the value when the last one goes.",
    "A null pointer is ignored; releasing memory the runtime never returned is an error.",
    { tags: ["lifetime"] },
  ),
  entry(
    "blaze_rt_string_new",
    "const char*",
    [
      ["bytes", "const unsigned char*"],
      ["length", "size_t"],
    ],
    "Copies length bytes into a NUL terminated managed string.",
    "Returns a managed string the caller owns; the length excludes the terminator.",
    { tags: ["memory"] },
  ),
  entry(
    "blaze_rt_string_length",
    "size_t",
    [["text", "const char*"]],
    "The length of a managed string, without its terminator.",
    "Borrowed: the string stays owned by whoever created it.",
    { tags: ["memory"] },
  ),
  entry(
    "blaze_rt_text_length",
    "size_t",
    [["text", "const char*"]],
    "The length of any string, managed or written out as a literal.",
    "Borrowed. A managed string is measured from the header in front of it; a literal the compiler wrote out has no header and is measured by scanning it.",
    { tags: ["memory"] },
  ),
  entry(
    "blaze_rt_string_clone",
    "const char*",
    [["text", "const char*"]],
    "Copies a managed string into a new one.",
    "Returns a managed string the caller owns.",
    { tags: ["memory"] },
  ),
  entry(
    "blaze_rt_array_new",
    "void*",
    [
      ["count", "size_t"],
      ["elementSize", "size_t"],
    ],
    "Allocates a zeroed managed array of count elements.",
    "Returns a managed pointer the caller owns.",
    { tags: ["memory"] },
  ),
  entry(
    "blaze_rt_array_resize",
    "void*",
    [
      ["pointer", "void*"],
      ["count", "size_t"],
      ["elementSize", "size_t"],
    ],
    "Resizes a managed array to count elements.",
    "Returns the managed pointer; a null pointer allocates.",
    { tags: ["memory"] },
  ),
  entry(
    "blaze_rt_object_new",
    "void*",
    [
      ["bytes", "size_t"],
      ["alignment", "size_t"],
    ],
    "Allocates a zeroed managed object of bytes, aligned to alignment.",
    "Returns a managed pointer the caller owns; alignment is a power of two, 0 means 16.",
    { tags: ["object", "memory"] },
  ),
  entry(
    "blaze_rt_object_size",
    "size_t",
    [["pointer", "void*"]],
    "The usable size of a managed value, excluding its header.",
    "Borrowed.",
    { tags: ["object"] },
  ),
  entry(
    "blaze_rt_arguments_set",
    "void",
    [
      ["values", "const double*"],
      ["count", "size_t"],
    ],
    "Gives the runtime the arguments the program was given, as numbers.",
    "The host calls this once, before the program runs, and it reads each argument the way the source reads it: an argument that is not a number is NaN.",
    { tags: ["host"] },
  ),
  entry(
    "blaze_rt_argv_count",
    "size_t",
    [],
    "The length of process.argv: the program, the file it runs, and the arguments.",
    "Two more than the number of arguments the program was given.",
    { tags: ["arguments"] },
  ),
  entry(
    "blaze_rt_argv",
    "double",
    [["index", "size_t"]],
    "The argument at an index of process.argv, or NaN when there is no such argument.",
    "A number: index 0 and 1 are where the program runs and the file it runs, so index 2 is the first argument; an argument that is missing, or that the host read as not a number, is NaN.",
    { tags: ["arguments"] },
  ),
  entry(
    "blaze_rt_print_text",
    "void",
    [["text", "const char*"]],
    "Writes text to the output, as it is given.",
    "A null pointer writes nothing.",
    { tags: ["output"] },
  ),
  entry(
    "blaze_rt_print_text_n",
    "void",
    [
      ["text", "const char*"],
      ["length", "size_t"],
    ],
    "Writes the bytes of text to the output, of which there are length.",
    "A null pointer writes nothing, whatever the length says. Bytes of text that are not terminated by a zero are written, which is the whole point: a compiler that laid the text out knows how long it is, and the count is what it knows it by.",
    { tags: ["output"] },
  ),
  entry(
    "blaze_rt_print_number",
    "void",
    [["value", "double"]],
    "Writes a number to the output as the shortest text that reads back as it.",
    "Writes no newline: the program decides where a line ends. A negative zero keeps its sign here, which is how the host a program was written for prints it and not how the language writes one.",
    { tags: ["output"] },
  ),
  entry(
    "blaze_rt_print_whole",
    "void",
    [
      ["value", "long long"],
      ["bigint", "int"],
    ],
    "Writes a whole number to the output as its own digits.",
    "A double holds every whole number only up to 2^53, so a larger one is written from the integer itself rather than through the formatter the floating numbers use. The n of a bigint is written after the digits when the value is one.",
    { tags: ["output"] },
  ),
  entry(
    "blaze_rt_format_number",
    "size_t",
    [
      ["value", "double"],
      ["buffer", "unsigned char*"],
      ["size", "size_t"],
    ],
    "Writes the text of a number into a buffer, NUL terminated.",
    "Writes into the caller's buffer and returns the number of bytes written, which is never more than size - 1, and 0 when size is 0. This is the text an interpolation reads a number as, and a zero of either sign is written as 0: only printing keeps the sign of a negative zero.",
    { tags: ["output"] },
  ),
  entry(
    "blaze_rt_format_number_fixed",
    "size_t",
    [
      ["value", "double"],
      ["digits", "int"],
      ["buffer", "unsigned char*"],
      ["size", "size_t"],
    ],
    "Writes a number as text at a fixed number of digits after the point.",
    "What x.toFixed(d) writes: the same digits every time, rounded at the last of them, and never the exponent form the shortest writing falls back on. A value that is not finite, and one of a million million million and over, is written as the language writes it rather than at the digits asked for.",
    { tags: ["output"] },
  ),
  entry(
    "blaze_rt_print_newline",
    "void",
    [],
    "Ends a line of output.",
    "Writes one newline.",
    { tags: ["output"] },
  ),
  entry(
    "blaze_rt_raise",
    "void",
    [["message", "const char*"]],
    "Reports a runtime error to the host and stops the function.",
    "Never returns. The message is kept for blaze_rt_last_error.",
    { noreturn: true, tags: ["error"] },
  ),
  entry(
    "blaze_rt_last_error",
    "const char*",
    [],
    "The message of the last blaze_rt_raise, or an empty string.",
    "Borrowed: valid until the next raise.",
    { tags: ["error"] },
  ),
  entry(
    "blaze_promise_new",
    "void*",
    [],
    "Creates a promise handle.",
    "Owned by the caller until completed.",
    { tags: ["host"] },
  ),
  entry(
    "blaze_promise_resolve",
    "void",
    [
      ["promise", "void*"],
      ["value", "double"],
    ],
    "Resolves a promise with a value.",
    "The promise handle remains valid.",
    { tags: ["host"] },
  ),
  entry(
    "blaze_promise_reject",
    "void",
    [
      ["promise", "void*"],
      ["message", "const char*"],
    ],
    "Rejects a promise with a message.",
    "The promise handle remains valid.",
    { tags: ["host"] },
  ),
  entry(
    "blaze_promise_await",
    "double",
    [["promise", "void*"]],
    "Blocks until the promise settles and returns its value.",
    "Returns NaN on rejection.",
    { tags: ["host"] },
  ),
  entry("blaze_promise_set_current", "void", [["promise", "void*"]], "Sets the current promise.", "For resolve/reject lowering.", { tags: ["host"] }),
  entry("blaze_promise_clear_current", "void", [], "Clears the current promise.", "", { tags: ["host"] }),
  entry("blaze_promise_resolve_current", "void", [["value", "double"]], "Resolves the current promise.", "", { tags: ["host"] }),
  entry("blaze_promise_reject_current", "void", [["message", "const char*"]], "Rejects the current promise.", "", { tags: ["host"] }),
];

/**
 * The prototypes of the wide integer kernel.
 *
 * These are declared in the header for the same reason the runtime ABI is, and
 * are deliberately not part of it. `RUNTIME_ABI` is the boundary a host crosses
 * into the runtime — allocation, printing, arguments — and every entry in it is
 * implemented twice, once in C and once in the Nim adapter, so that a program
 * runs the same on either host. The wide kernel is not a service a host calls:
 * it is arithmetic that generated code itself calls, and only the C runtime
 * defines it. Putting it in the ABI would oblige the Nim adapter to restate
 * every carry and borrow, which is the one place two answers to the same
 * arithmetic could quietly disagree.
 */
const U256_DECLARATIONS: readonly string[] = [
  "void blaze_rt_u256_add(blaze_u256* out, const blaze_u256* left, const blaze_u256* right)",
  "void blaze_rt_u256_sub(blaze_u256* out, const blaze_u256* left, const blaze_u256* right)",
  "void blaze_rt_u256_mul(blaze_u256* out, const blaze_u256* left, const blaze_u256* right)",
  "void blaze_rt_u256_mul_mod(blaze_u256* out, const blaze_u256* left, const blaze_u256* right, const blaze_u256* mod)",
  "void blaze_rt_u256_add_mod(blaze_u256* out, const blaze_u256* left, const blaze_u256* right, const blaze_u256* mod)",
  "void blaze_rt_u256_sub_mod(blaze_u256* out, const blaze_u256* left, const blaze_u256* right, const blaze_u256* mod)",
  "void blaze_rt_u256_div(blaze_u256* out, const blaze_u256* left, const blaze_u256* right)",
  "void blaze_rt_u256_mod(blaze_u256* out, const blaze_u256* left, const blaze_u256* right)",
  "void blaze_rt_u256_redc(blaze_u256* out, const blaze_u256* T_hi, const blaze_u256* T_lo, const blaze_u256* mod, uint64_t pinv)",
  "void blaze_rt_u256_and(blaze_u256* out, const blaze_u256* left, const blaze_u256* right)",
  "void blaze_rt_u256_or(blaze_u256* out, const blaze_u256* left, const blaze_u256* right)",
  "void blaze_rt_u256_xor(blaze_u256* out, const blaze_u256* left, const blaze_u256* right)",
  "void blaze_rt_u256_not(blaze_u256* out, const blaze_u256* value)",
  "void blaze_rt_u256_shl(blaze_u256* out, const blaze_u256* value, unsigned count)",
  "void blaze_rt_u256_shr(blaze_u256* out, const blaze_u256* value, unsigned count)",
  "int blaze_rt_u256_less(const blaze_u256* left, const blaze_u256* right)",
  "int blaze_rt_u256_equal(const blaze_u256* left, const blaze_u256* right)",
  "void blaze_rt_u256_from_u64(blaze_u256* out, uint64_t value)",
  "void blaze_rt_u256_from_u64x2(blaze_u256* out, uint64_t low, uint64_t high)",
  "void blaze_rt_u256_from_u64x4(blaze_u256* out, uint64_t l0, uint64_t l1, uint64_t l2, uint64_t l3)",
  "void blaze_rt_u256_add_mod(blaze_u256* out, const blaze_u256* left, const blaze_u256* right, const blaze_u256* mod)",
  "void blaze_rt_u256_sub_mod(blaze_u256* out, const blaze_u256* left, const blaze_u256* right, const blaze_u256* mod)",
  "void blaze_rt_u256_mul_mod(blaze_u256* out, const blaze_u256* left, const blaze_u256* right, const blaze_u256* mod)",
  "uint64_t blaze_rt_u256_to_u64(const blaze_u256* value)",
  "size_t blaze_rt_u256_format(const blaze_u256* value, unsigned base, unsigned char* buffer, size_t size)",
  "int blaze_rt_u256_parse(blaze_u256* out, const char* text, size_t length)",
  "void blaze_rt_print_u256(const blaze_u256* value)",
  "void blaze_rt_print_u256_hex(const blaze_u256* value)",
];

/* The prototypes of the signed wide integer kernel. A blaze_i256 holds the
   same four limbs as a blaze_u256, but the top limb's high bit is the sign, so
   shift-right, comparison, division and remainder are answered as signed while
   addition, subtraction, multiplication and the bitwise operations share the
   two's complement bit patterns of the unsigned form. */
const I256_DECLARATIONS: readonly string[] = [
  "void blaze_rt_i256_add(blaze_i256* out, const blaze_i256* left, const blaze_i256* right)",
  "void blaze_rt_i256_sub(blaze_i256* out, const blaze_i256* left, const blaze_i256* right)",
  "void blaze_rt_i256_mul(blaze_i256* out, const blaze_i256* left, const blaze_i256* right)",
  "void blaze_rt_i256_div(blaze_i256* out, const blaze_i256* left, const blaze_i256* right)",
  "void blaze_rt_i256_mod(blaze_i256* out, const blaze_i256* left, const blaze_i256* right)",
  "void blaze_rt_i256_and(blaze_i256* out, const blaze_i256* left, const blaze_i256* right)",
  "void blaze_rt_i256_or(blaze_i256* out, const blaze_i256* left, const blaze_i256* right)",
  "void blaze_rt_i256_xor(blaze_i256* out, const blaze_i256* left, const blaze_i256* right)",
  "void blaze_rt_i256_not(blaze_i256* out, const blaze_i256* value)",
  "void blaze_rt_i256_shl(blaze_i256* out, const blaze_i256* value, unsigned count)",
  "void blaze_rt_i256_shr(blaze_i256* out, const blaze_i256* value, unsigned count)",
  "int blaze_rt_i256_less(const blaze_i256* left, const blaze_i256* right)",
  "int blaze_rt_i256_equal(const blaze_i256* left, const blaze_i256* right)",
  "void blaze_rt_i256_from_i64(blaze_i256* out, int64_t value)",
  "int64_t blaze_rt_i256_to_i64(const blaze_i256* value)",
  "size_t blaze_rt_i256_format(const blaze_i256* value, unsigned base, unsigned char* buffer, size_t size)",
  "int blaze_rt_i256_parse(blaze_i256* out, const char* text, size_t length)",
  "void blaze_rt_print_i256(const blaze_i256* value)",
  "void blaze_rt_print_i256_hex(const blaze_i256* value)",
];

/**
 * The wide integer symbols, which generated code may reference alongside the
 * runtime ABI. Kept apart from `RUNTIME_SYMBOLS` because they are the compiler's
 * own arithmetic rather than a service the host provides; see
 * `U256_DECLARATIONS` for why the two are not one list.
 */
export const WIDE_SYMBOLS: Record<string, true> = Object.fromEntries(
  [...U256_DECLARATIONS, ...I256_DECLARATIONS].map((declaration) => [
    declaration.slice(declaration.indexOf("blaze_rt_"), declaration.indexOf("(")),
    true as const,
  ]),
);

/** Symbols generated code may reference. Nothing else resolves at link time. */
export const RUNTIME_SYMBOLS: Record<string, true> = Object.fromEntries(
  RUNTIME_ABI.map((item) => [item.symbol, true as const]),
);

/**
 * Every entry point by name, in ABI order. A host that links a candidate
 * object against a runtime names all of them, so the linker keeps the ones
 * only the candidate calls.
 */
export const RUNTIME_ANCHOR: readonly string[] = RUNTIME_ABI.map((item) => item.symbol);

/** True when generated code is allowed to reference a symbol. */
export function isRuntimeSymbol(symbol: string): boolean {
  return RUNTIME_SYMBOLS[symbol] === true || WIDE_SYMBOLS[symbol] === true || isHttpSymbol(symbol);
}
const HEADER_PREAMBLE = `#ifndef BLAZE_RT_H
#define BLAZE_RT_H

#include <stddef.h>
#include <stdint.h>

/*
 * The managed object representation. Every value the runtime returns starts
 * with this header, so a host can retain, release and measure a value it did
 * not allocate. The payload starts ${48} bytes later and keeps the alignment
 * the allocation asked for.
 */
typedef struct blaze_rt_header {
  uint64_t magic;       /* BLAZE_RT_MAGIC while the value is live */
  void* base;           /* the address the host allocator returned */
  uint64_t length;      /* usable payload bytes */
  uint64_t alignment;   /* payload alignment, a power of two */
  uint64_t references;  /* live references, at least one */
  uint64_t capacity;    /* payload bytes the block can hold, at least length */
} blaze_rt_header;

#define BLAZE_RT_MAGIC 0x424C415A45525400ULL
#define BLAZE_RT_HEADER_SIZE 48u
#define BLAZE_RT_DEFAULT_ALIGNMENT ${DEFAULT_ALIGNMENT}u
/* The largest a request may be, so a product of a count and an element size
   that would wrap is refused rather than answered with a smaller block. */
#define BLAZE_RT_MAX_ALLOCATION (1ULL << 40)

/*
 * The canonical representation of a fixed-width wide integer.
 *
 * A wide number is held as an array of 64 bit limbs, least significant first,
 * and that array is the whole ABI: every backend lays a value out in memory in
 * this order, passes it to the runtime as a pointer to it, and reads it back
 * the same way. Least-significant-first is chosen because it is the order the
 * arithmetic walks the value in — a carry or a borrow propagates from limb 0
 * upward — and because it is the order the bytes are in on every target this
 * compiler emits for, so no backend has to reverse one.
 *
 * The limbs are unsigned whatever the width of the number is. A u256 is
 * unsigned, and a further width added beside it is unsigned for the same
 * reason: a wide number is a fixed-size bag of bits whose arithmetic is defined
 * modulo 2^(64*limbs), and a signed wide number would have to be answered from
 * the sign of the top limb on every operation, which is a rule each backend
 * would then have to implement its own way.
 */
typedef struct blaze_u256 {
  uint64_t limbs[4];
} blaze_u256;

/* The number of bytes a u256 occupies, for a backend laying a frame out. */
#define BLAZE_U256_BYTES 32u

typedef struct blaze_i256 {
  /* The same four limbs as a blaze_u256; the high bit of the top limb is the
     sign, so a negative value is held in two's complement and the sign is read
     from limb 3 rather than stored beside it. */
  uint64_t limbs[4];
} blaze_i256;

/* The number of bytes an i256 occupies, for a backend laying a frame out. */
#define BLAZE_I256_BYTES 32u

`;

const HEADER_EPILOGUE = `
extern void *blaze_current_promise;
#endif
`;

/** The C header a C candidate includes and the harness compiles against. */
export function runtimeHeaderSource(): string {
  const declarations = RUNTIME_ABI.map((item) => {
    const suffix = item.noreturn === true ? " /* never returns */" : "";
    return `${item.returns === "void" ? "void" : item.returns} ${item.symbol}(${
      item.params.length === 0 ? "void" : item.params.map(([name, type]) => `${type} ${name}`).join(", ")
    })${suffix};`;
  }).join("\n");
  return `${HEADER_PREAMBLE}\n${declarations}\n\n${[...U256_DECLARATIONS, ...I256_DECLARATIONS].map((declaration) => `${declaration};`).join("\n")}\n${HEADER_EPILOGUE}`;
}

/**
 * The arithmetic of a fixed-width wide integer, in one place.
 *
 * Every backend lowers a wide operation to a call into this kernel rather than
 * to instructions of its own, and that is what makes the semantics one answer
 * on every target: carry propagation, borrow propagation, the truncation of a
 * shift and the order limbs are compared in are the parts of a wide operation
 * a backend gets subtly wrong, and there is one copy of them here rather than
 * three. It is also what makes a further width cheap — `u128` is this source
 * with two limbs and `u512` with eight — because the backends hold no
 * per-operation code to extend: they only lay a value out and call in here.
 *
 * Values are in and out by pointer. A 32 byte struct is past the width a target
 * passes in registers, so passing by value would give each target its own
 * calling convention and an ABI that no longer matched the memory layout the
 * backends already use. A pointer is one argument everywhere, and the caller
 * already holds the value in memory because a wide number is never in a
 * register.
 *
 * Every operation is modulo 2^256 by definition of the type. An overflow is
 * therefore not a condition to report but the answer the source asked for,
 * which is why the carry out of the top limb is computed and dropped rather
 * than checked: there is nothing for it to be other than a discarded value.
 *
 * `out` may alias either operand. Addition and the logical operations read each
 * limb before writing it, so they are safe under aliasing; the shifts read the
 * whole value before writing any limb, so they are too.
 */
export const U256_KERNEL = `
/* The zero every operation starts from and the value an underflow produces. */
static blaze_u256 blaze_u256_zero(void) {
  blaze_u256 out;
  out.limbs[0] = 0; out.limbs[1] = 0; out.limbs[2] = 0; out.limbs[3] = 0;
  return out;
}

static blaze_u256 blaze_u256_of_u64(uint64_t value) {
  blaze_u256 out = blaze_u256_zero();
  out.limbs[0] = value;
  return out;
}

/* The carry is a full 128 bits so the sum of two limbs and a carry cannot
   overflow before the carry out of it is extracted. A 64 bit accumulator would
   lose the bit that belongs to the next limb up. */
void blaze_rt_u256_add(blaze_u256* out, const blaze_u256* left, const blaze_u256* right) {
  unsigned __int128 carry = 0;
  for (unsigned i = 0; i < 4; i += 1) {
    const unsigned __int128 sum = (unsigned __int128)left->limbs[i] + right->limbs[i] + carry;
    out->limbs[i] = (uint64_t)sum;
    carry = sum >> 64;
  }
}

/* The borrow is extracted from the top of the wide difference: a subtraction
   that underflowed a limb is a 128 bit value near 2^128, so its high half is 1
   exactly when the limb borrowed. Folding the borrow in as a full-width
   subtraction is what makes \`0 - 1\` the largest value rather than a value
   tested for after the fact. */
void blaze_rt_u256_sub(blaze_u256* out, const blaze_u256* left, const blaze_u256* right) {
  unsigned __int128 borrow = 0;
  for (unsigned i = 0; i < 4; i += 1) {
    const unsigned __int128 difference =
      (unsigned __int128)left->limbs[i] - right->limbs[i] - borrow;
    out->limbs[i] = (uint64_t)difference;
    borrow = (difference >> 64) & 1u;
  }
}

/* Schoolbook multiplication over the limbs. Every partial product is a 64x64
   product accumulated in 128 bits, so the carry out of one column of the
   product is added to the next rather than lost, and the columns above the top
   limb are dropped: they are the bits above 2^256, which is where the type
   ends. */
void blaze_rt_u256_mul(blaze_u256* out, const blaze_u256* left, const blaze_u256* right) {
  blaze_u256 accumulator = blaze_u256_zero();
  for (unsigned i = 0; i < 4; i += 1) {
    unsigned __int128 carry = 0;
    for (unsigned j = 0; i + j < 4; j += 1) {
      const unsigned __int128 product =
        (unsigned __int128)left->limbs[i] * right->limbs[j] + accumulator.limbs[i + j] + carry;
      accumulator.limbs[i + j] = (uint64_t)product;
      carry = product >> 64;
    }
  }
  *out = accumulator;
}

/* For a modulus of the form 2^256 - c with c < 2^64 (e.g. secp256k1's
   P = 2^256 - 2^32 - 977), 2^256 ≡ c (mod mod). A 512-bit value
   high * 2^256 + low therefore reduces to (high * c + low) mod mod.
   Since c is a single limb, high * c is just four limb-multiplies, and the
   result is at most five limbs (~320 bits). Folding the top limb down
   (top * 2^256 ≡ top * c) terminates in at most three iterations, then one
   final conditional subtraction of mod. This replaces 512 bit-by-bit shift
   and compare iterations with a handful of limb operations. */
static void mul_mod_special(blaze_u256* out, const uint64_t prod[8], const blaze_u256* mod, uint64_t c) {
  uint64_t t[5] = {0, 0, 0, 0, 0};
  /* t = high * c, schoolbook with c as a single limb. */
  for (unsigned i = 0; i < 4; i += 1) {
    const unsigned __int128 product =
      (unsigned __int128)prod[4 + i] * c + t[i];
    t[i] = (uint64_t)product;
    t[i + 1] = (uint64_t)(product >> 64);
  }
  /* t += low. */
  unsigned __int128 carry = 0;
  for (unsigned i = 0; i < 4; i += 1) {
    const unsigned __int128 sum =
      (unsigned __int128)t[i] + prod[i] + carry;
    t[i] = (uint64_t)sum;
    carry = sum >> 64;
  }
  t[4] += (uint64_t)carry;
  /* Fold t[4] * 2^256 down as t[4] * c, repeating until t[4] is zero.
     Bounded at 8 iterations for safety. */
  for (unsigned round = 0; round < 8 && t[4] != 0; round += 1) {
    const unsigned __int128 product =
      (unsigned __int128)t[4] * c;
    const uint64_t tc_lo = (uint64_t)product;
    const uint64_t tc_hi = (uint64_t)(product >> 64);
    unsigned __int128 cy = 0;
    for (unsigned i = 0; i < 2; i += 1) {
      const unsigned __int128 sum =
        (unsigned __int128)t[i] + (i == 0 ? tc_lo : tc_hi) + cy;
      t[i] = (uint64_t)sum;
      cy = sum >> 64;
    }
    for (unsigned i = 2; i < 4 && cy != 0; i += 1) {
      const unsigned __int128 sum =
        (unsigned __int128)t[i] + cy;
      t[i] = (uint64_t)sum;
      cy = sum >> 64;
    }
    t[4] = (uint64_t)cy;
  }
  /* t[0..3] is now the residue, possibly >= mod. One conditional subtraction. */
  blaze_u256 result;
  for (unsigned i = 0; i < 4; i += 1) result.limbs[i] = t[i];
  if (!blaze_rt_u256_less(&result, mod)) {
    blaze_rt_u256_sub(&result, &result, mod);
  }
  *out = result;
}

/* Modular multiplication: computes (left * right) mod mod. The full 512 bit
   product is accumulated in eight limbs. For moduli of the form 2^256 - c
   with c < 2^64 (top bit of mod set, and c = ~mod + 1 fits in one limb) a
   fast special-prime reduction is used; otherwise the general bit-by-bit
   reduction applies. Both are sound for any modulus below 2^256. */
void blaze_rt_u256_mul_mod(blaze_u256* out, const blaze_u256* left, const blaze_u256* right, const blaze_u256* mod) {
  uint64_t prod[8];
  for (unsigned i = 0; i < 8; i += 1) prod[i] = 0;
  for (unsigned i = 0; i < 4; i += 1) {
    unsigned __int128 carry = 0;
    for (unsigned j = 0; j < 4; j += 1) {
      const unsigned __int128 product =
        (unsigned __int128)left->limbs[i] * right->limbs[j] + prod[i + j] + carry;
      prod[i + j] = (uint64_t)product;
      carry = product >> 64;
    }
    prod[i + 4] = (uint64_t)carry;
  }
  /* Fast path for special primes: mod > 2^255 and c = 2^256 - mod < 2^64. */
  if ((mod->limbs[3] >> 63) != 0) {
    /* c = 2^256 - mod = ~mod + 1 (two's complement). */
    uint64_t c_limbs[4];
    for (unsigned i = 0; i < 4; i += 1) c_limbs[i] = ~mod->limbs[i];
    unsigned __int128 cc = 1;
    for (unsigned i = 0; i < 4; i += 1) {
      const unsigned __int128 s =
        (unsigned __int128)c_limbs[i] + cc;
      c_limbs[i] = (uint64_t)s;
      cc = s >> 64;
    }
    /* c fits in one limb? */
    if (c_limbs[1] == 0 && c_limbs[2] == 0 && c_limbs[3] == 0) {
      mul_mod_special(out, prod, mod, c_limbs[0]);
      return;
    }
  }
  /* General reduction: all 512 bits, most significant bit first. */
  blaze_u256 result = blaze_u256_zero();
  /* Reduce all 512 bits, most significant bit first, so each shift doubles the
     running value and the bit that comes in decides whether one is added.
     Starting from zero and processing every limb (high to low) computes
     (low_256 + high_256 * 2^256) mod mod, which is the product modulo mod. */
  for (unsigned i = 8; i-- > 0;) {
    for (unsigned bit = 64; bit-- > 0;) {
      const int overflow = (int)((result.limbs[3] >> 63) & 1u);
      result.limbs[3] = (result.limbs[3] << 1) | (result.limbs[2] >> 63);
      result.limbs[2] = (result.limbs[2] << 1) | (result.limbs[1] >> 63);
      result.limbs[1] = (result.limbs[1] << 1) | (result.limbs[0] >> 63);
      result.limbs[0] = (result.limbs[0] << 1) | ((prod[i] >> bit) & 1u);
      if (overflow || !blaze_rt_u256_less(&result, mod)) {
        blaze_rt_u256_sub(&result, &result, mod);
      }
    }
  }
  *out = result;
}

/* If mod is of the form 2^256 - c with c < 2^64 (a "special prime" like
   secp256k1's P = 2^256 - 2^32 - 977), returns 1 and stores c in *c_out.
   Otherwise returns 0. */
static int special_prime_c(const blaze_u256* mod, uint64_t* c_out) {
  if ((mod->limbs[3] >> 63) == 0) return 0;
  uint64_t c_limbs[4];
  for (unsigned i = 0; i < 4; i += 1) c_limbs[i] = ~mod->limbs[i];
  unsigned __int128 cc = 1;
  for (unsigned i = 0; i < 4; i += 1) {
    const unsigned __int128 s =
      (unsigned __int128)c_limbs[i] + cc;
    c_limbs[i] = (uint64_t)s;
    cc = s >> 64;
  }
  if (c_limbs[1] != 0 || c_limbs[2] != 0 || c_limbs[3] != 0) return 0;
  *c_out = c_limbs[0];
  return 1;
}

/* Computes 2^256 mod mod. When mod > 2^255, 2^256 < 2 * mod so the answer is
   2^256 - mod = ~mod + 1 (two's complement negation). Otherwise the answer is
   found by doubling 1 modulo mod, 256 times. */
static void pow256_mod(blaze_u256* out, const blaze_u256* mod) {
  if (mod->limbs[3] >> 63) {
    /* mod > 2^255: 2^256 < 2 * mod, so 2^256 mod mod = 2^256 - mod. */
    for (unsigned i = 0; i < 4; i += 1) out->limbs[i] = ~mod->limbs[i];
    unsigned __int128 c = 1;
    for (unsigned i = 0; i < 4; i += 1) {
      const unsigned __int128 s = (unsigned __int128)out->limbs[i] + c;
      out->limbs[i] = (uint64_t)s;
      c = s >> 64;
    }
  } else {
    *out = blaze_u256_of_u64(1);
    for (int i = 0; i < 256; i += 1) {
      blaze_rt_u256_add(out, out, out);
      if (!blaze_rt_u256_less(out, mod)) {
        blaze_rt_u256_sub(out, out, mod);
      }
    }
  }
}

/* Modular addition: computes (left + right) mod mod. The sum can carry past
   2^256; the carry bit represents 2^256 which is reduced modulo mod. */
void blaze_rt_u256_add_mod(blaze_u256* out, const blaze_u256* left, const blaze_u256* right, const blaze_u256* mod) {
  unsigned __int128 carry = 0;
  for (unsigned i = 0; i < 4; i += 1) {
    const unsigned __int128 sum = (unsigned __int128)left->limbs[i] + right->limbs[i] + carry;
    out->limbs[i] = (uint64_t)sum;
    carry = sum >> 64;
  }
  /* out = (left + right) mod 2^256, carry in {0, 1}. */
  uint64_t c;
  if (special_prime_c(mod, &c)) {
    /* Fast path: 2^256 ≡ c (mod mod). */
    if (!carry) {
      /* result = out mod mod: out < 2^256, at most one subtraction. */
      if (!blaze_rt_u256_less(out, mod)) {
        blaze_rt_u256_sub(out, out, mod);
      }
    } else {
      /* result = (out + c) mod mod. out + c may wrap past 2^256;
         the wrap bit is 2^256 ≡ c, so add c again. */
      unsigned __int128 cy = 0;
      for (unsigned i = 0; i < 4; i += 1) {
        const unsigned __int128 s =
          (unsigned __int128)out->limbs[i] + (i == 0 ? c : 0) + cy;
        out->limbs[i] = (uint64_t)s;
        cy = s >> 64;
      }
      if (cy != 0) {
        /* Wrapped: out is now small (< 2^64), add c again; result < 2^128 < mod. */
        unsigned __int128 cy2 = 0;
        for (unsigned i = 0; i < 4; i += 1) {
          const unsigned __int128 s =
            (unsigned __int128)out->limbs[i] + (i == 0 ? c : 0) + cy2;
          out->limbs[i] = (uint64_t)s;
          cy2 = s >> 64;
        }
      } else if (!blaze_rt_u256_less(out, mod)) {
        blaze_rt_u256_sub(out, out, mod);
      }
    }
    return;
  }
  blaze_rt_u256_mod(out, out, mod);
  if (carry) {
    /* result = (out + 2^256) mod mod = (out + pow256) mod mod,
       where pow256 = 2^256 mod mod and out < mod, pow256 < mod.
       out + pow256 < 2 * mod, may wrap past 2^256. */
    blaze_u256 pow256;
    pow256_mod(&pow256, mod);
    /* Check if out + pow256 >= mod, without computing the sum directly. */
    blaze_u256 mod_minus_pow256;
    blaze_rt_u256_sub(&mod_minus_pow256, mod, &pow256);  /* mod > pow256, no wrap */
    if (!blaze_rt_u256_less(out, &mod_minus_pow256)) {
      /* out + pow256 >= mod: result = out + pow256 - mod.
         Compute as (out - mod) + pow256; out - mod wraps to
         out - mod + 2^256, then adding pow256 gives
         out + pow256 - mod (no further wrap since < mod < 2^256). */
      blaze_u256 diff;
      blaze_rt_u256_sub(&diff, out, mod);  /* wraps: diff = out - mod + 2^256 */
      blaze_rt_u256_add(out, &diff, &pow256);  /* result = out + pow256 - mod, < mod < 2^256 */
    } else {
      /* out + pow256 < mod, no wrap since result < mod < 2^256. */
      blaze_rt_u256_add(out, out, &pow256);
    }
  }
}

/* Modular subtraction: computes (left - right) mod mod. If left < right the
   subtraction borrows past 2^256; the true value is negative, so we add mod
   to bring it into range. */
void blaze_rt_u256_sub_mod(blaze_u256* out, const blaze_u256* left, const blaze_u256* right, const blaze_u256* mod) {
  unsigned __int128 borrow = 0;
  for (unsigned i = 0; i < 4; i += 1) {
    const unsigned __int128 difference =
      (unsigned __int128)left->limbs[i] - right->limbs[i] - borrow;
    out->limbs[i] = (uint64_t)difference;
    borrow = (difference >> 64) & 1u;
  }
  uint64_t c;
  if (special_prime_c(mod, &c)) {
    /* Fast path: -2^256 ≡ -c (mod mod). */
    if (!borrow) {
      /* result = out mod mod: out < 2^256, at most one subtraction. */
      if (!blaze_rt_u256_less(out, mod)) {
        blaze_rt_u256_sub(out, out, mod);
      }
    } else {
      /* result = (out - c) mod mod.
         out >= c: result = out - c, which is < mod (out - c < 2^256 - c = mod).
         out < c:  result = out - c + mod = out + 2^256 - 2c.
                   Compute as out - 2c (256-bit, wraps to out + 2^256 - 2c). */
      uint64_t diff[4];
      unsigned __int128 b2 = 0;
      for (unsigned i = 0; i < 4; i += 1) {
        const unsigned __int128 d =
          (unsigned __int128)out->limbs[i] - (i == 0 ? c : 0) - b2;
        diff[i] = (uint64_t)d;
        b2 = (d >> 64) & 1u;
      }
      if (b2 == 0) {
        /* out >= c: result = out - c < mod. */
        for (unsigned i = 0; i < 4; i += 1) out->limbs[i] = diff[i];
      } else {
        /* out < c: diff = out - c + 2^256 (wrapped). Subtract c again;
           result = out + 2^256 - 2c, which is < mod and > 0. */
        unsigned __int128 b3 = 0;
        for (unsigned i = 0; i < 4; i += 1) {
          const unsigned __int128 d =
            (unsigned __int128)diff[i] - (i == 0 ? c : 0) - b3;
          diff[i] = (uint64_t)d;
          b3 = (d >> 64) & 1u;
        }
        /* b3 must be 0: diff = out - c + 2^256 >= 2^256 - c > c. */
        for (unsigned i = 0; i < 4; i += 1) out->limbs[i] = diff[i];
      }
    }
    return;
  }
  if (borrow) {
    /* left < right: true value = out - 2^256 (negative).
       (left - right) mod mod = (out - 2^256) mod mod
                              = (out - pow256) mod mod
       since -2^256 ≡ -pow256 (mod mod) and pow256 = 2^256 mod mod.
       out = (left - right) mod 2^256, out < 2^256. */
    blaze_rt_u256_mod(out, out, mod);
    blaze_u256 pow256;
    pow256_mod(&pow256, mod);
    if (blaze_rt_u256_less(out, &pow256)) {
      /* out < pow256: result = out - pow256 + mod.
         out - pow256 wraps to out - pow256 + 2^256, then + mod gives
         out - pow256 + mod (no further wrap since < mod < 2^256). */
      blaze_rt_u256_sub(out, out, &pow256);  /* wraps: out = out - pow256 + 2^256 */
      blaze_rt_u256_add(out, out, mod);  /* result = out - pow256 + mod, < mod < 2^256 */
    } else {
      /* out >= pow256: result = out - pow256, no wrap, result < mod. */
      blaze_rt_u256_sub(out, out, &pow256);
    }
  } else {
    blaze_rt_u256_mod(out, out, mod);
  }
}


void blaze_rt_u256_and(blaze_u256* out, const blaze_u256* left, const blaze_u256* right) {
  for (unsigned i = 0; i < 4; i += 1) out->limbs[i] = left->limbs[i] & right->limbs[i];
}

void blaze_rt_u256_or(blaze_u256* out, const blaze_u256* left, const blaze_u256* right) {
  for (unsigned i = 0; i < 4; i += 1) out->limbs[i] = left->limbs[i] | right->limbs[i];
}

void blaze_rt_u256_xor(blaze_u256* out, const blaze_u256* left, const blaze_u256* right) {
  for (unsigned i = 0; i < 4; i += 1) out->limbs[i] = left->limbs[i] ^ right->limbs[i];
}

/* The complement covers every limb, so it is a complement over all 256 bits
   rather than a 64 bit one repeated four times. */
void blaze_rt_u256_not(blaze_u256* out, const blaze_u256* value) {
  for (unsigned i = 0; i < 4; i += 1) out->limbs[i] = ~value->limbs[i];
}

/* A shift left by a whole number of limbs is a copy with zeros at the bottom.
   This is the common case for the multiples of 64 a caller asks for, and it is
   separated because the bit-carrying general case below cannot express it
   without a shift by the full width of a limb, which is undefined in C. */
static void blaze_u256_shl_limbs(blaze_u256* out, const blaze_u256* value, unsigned limbs) {
  blaze_u256 result = blaze_u256_zero();
  for (unsigned i = limbs; i < 4; i += 1) result.limbs[i] = value->limbs[i - limbs];
  *out = result;
}

static void blaze_u256_shr_limbs(blaze_u256* out, const blaze_u256* value, unsigned limbs) {
  blaze_u256 result = blaze_u256_zero();
  for (unsigned i = 0; i + limbs < 4; i += 1) result.limbs[i] = value->limbs[i + limbs];
  *out = result;
}

/* A shift left by a count that is not a whole number of limbs. Limb i takes
   its own bits moved up, plus the bits that fall into it from the limb below,
   which are the topmost bits of that limb. Both halves are taken from value
   rather than from result, so the move does not depend on the order the
   limbs are written in and may not be done in place.

   The top limb is not an exception: its own bits move up and are dropped when
   they leave it, which is what makes the shift of 255 bits a shift of one bit
   rather than no shift at all. */
static void blaze_u256_shl_bits(blaze_u256* out, const blaze_u256* value, unsigned bits) {
  blaze_u256 result = blaze_u256_zero();
  for (unsigned i = 0; i < 4; i += 1) {
    uint64_t limb = value->limbs[i] << bits;
    if (i > 0u) limb |= value->limbs[i - 1u] >> (64u - bits);
    result.limbs[i] = limb;
  }
  *out = result;
}

/* A shift right by a count that is not a whole number of limbs. The top limb
   fills with zeros because the number is unsigned and has no sign to extend,
   and limb zero's own bits are dropped as they leave it. */
static void blaze_u256_shr_bits(blaze_u256* out, const blaze_u256* value, unsigned bits) {
  blaze_u256 result = blaze_u256_zero();
  for (unsigned i = 0; i < 4; i += 1) {
    uint64_t limb = value->limbs[i] >> bits;
    if (i + 1u < 4u) limb |= value->limbs[i + 1u] << (64u - bits);
    result.limbs[i] = limb;
  }
  *out = result;
}

/* A shift of 256 or more shifts every bit out, which is zero for an unsigned
   number. It is answered before the count is reduced rather than left to a
   reduction modulo 256, which would make a shift of 256 a shift of zero and so
   agree with the source by accident. */
void blaze_rt_u256_shl(blaze_u256* out, const blaze_u256* value, unsigned count) {
  if (count >= 256u) { *out = blaze_u256_zero(); return; }
  const unsigned limbs = count / 64u;
  const unsigned bits = count % 64u;
  /* The count is applied as a limb shift and then a bit shift rather than as
     one of either, because a shift of a whole number of limbs and a shift of
     the bits inside a limb are the two halves of the same move. Applying only
     the bit half drops the limbs — a shift of 129 bits would move one bit and
     leave the value two limbs too low, which is a wrong answer rather than a
     refused one. The bit shift runs on the already moved value, which is why
     the intermediate is written out rather than composed limb by limb. */
  if (bits == 0u) {
    blaze_u256_shl_limbs(out, value, limbs);
    return;
  }
  blaze_u256 moved;
  blaze_u256_shl_limbs(&moved, value, limbs);
  blaze_u256_shl_bits(out, &moved, bits);
}

void blaze_rt_u256_shr(blaze_u256* out, const blaze_u256* value, unsigned count) {
  if (count >= 256u) { *out = blaze_u256_zero(); return; }
  const unsigned limbs = count / 64u;
  const unsigned bits = count % 64u;
  if (bits == 0u) {
    blaze_u256_shr_limbs(out, value, limbs);
    return;
  }
  blaze_u256 moved;
  blaze_u256_shr_limbs(&moved, value, limbs);
  blaze_u256_shr_bits(out, &moved, bits);
}

/* A comparison walks from the top limb down, because the top limb holds the
   most significant bits: the first limb that differs decides the answer and no
   limb below it can change it. Returned as a C boolean, which is what every
   backend's own comparison already produces. */
int blaze_rt_u256_less(const blaze_u256* left, const blaze_u256* right) {
  for (unsigned i = 4; i-- > 0;) {
    if (left->limbs[i] < right->limbs[i]) return 1;
    if (left->limbs[i] > right->limbs[i]) return 0;
  }
  return 0;
}

int blaze_rt_u256_equal(const blaze_u256* left, const blaze_u256* right) {
  return (left->limbs[0] == right->limbs[0]) && (left->limbs[1] == right->limbs[1]) &&
         (left->limbs[2] == right->limbs[2]) && (left->limbs[3] == right->limbs[3]);
}

/* True when any limb of the value is not zero. */
static int blaze_u256_is_zero(const blaze_u256* value) {
  return (value->limbs[0] | value->limbs[1] | value->limbs[2] | value->limbs[3]) == 0u;
}

/* How many bits a value holds above its lowest one, which is the position of its
   most significant set bit. A zero holds none and answers 0, and the divide
   below reads that as the count of turns it has left to run.

   The limbs are walked from the top down, because the top limb holds the most
   significant bits: the first limb that is not zero is the one that decides the
   width, and no limb below it can raise it. Walking up from the bottom instead
   stops at the first non-zero limb and answers the width of the lowest one,
   which for a value whose bottom limb is all ones and whose top limb is not
   said 64 bits rather than 256 — and every quotient of that value came back
   empty. */
static int blaze_u256_bits(const blaze_u256* value) {
  for (unsigned i = 4; i-- > 0;) {
    const uint64_t limb = value->limbs[i];
    if (limb == 0u) continue;
    int top = 0;
    for (unsigned bit = 0; bit < 64u; bit += 1) {
      if ((limb >> bit) & 1u) top = (int)bit + 1;
    }
    return (int)(i * 64u) + top;
  }
  return 0;
}

/* Restoring division, written here rather than beside the multiplication it is
   the counterpart of because it is the only operation in this file that calls
   \`blaze_rt_u256_less\`, and that is written below the arithmetic. A call to a
   function that is not declared yet is a call on an implicit declaration, which
   C99 removed and which answers from whatever the compiler assumed: the divide
   was written beside the multiply and returned a quotient of zero for nearly
   every input, because the comparison it asked was not the one it ran.

   The invariant the loop rests on is that what is left is always below the
   divisor: each turn moves it up by one bit and subtracts the divisor only where
   the divisor still fits under it. That is why this is not the shorter form
   subtracting \`divisor << step\` from the whole dividend — that one leaves the
   whole dividend in the remainder, which reaches the divisor's own width as
   soon as the divisor is a whole number of limbs wide and a 256 bit value
   cannot hold it. Holding what is left below the divisor keeps the move up to
   one limb plus the one bit the subtraction cannot consume. */
static void blaze_u256_divmod(blaze_u256* quotient, blaze_u256* remainder, const blaze_u256* left, const blaze_u256* right) {
  *quotient = blaze_u256_zero();
  *remainder = blaze_u256_zero();
  if (blaze_u256_is_zero(right)) return;
  blaze_u256 rest = blaze_u256_zero();
  for (int step = blaze_u256_bits(left) - 1; step >= 0; step -= 1) {
    /* What is left moves up one bit and takes the dividend's bit at the bottom.
       A shift by the full width of a limb is undefined in C, so each limb takes
       the top bit of the one below it rather than being shifted as a number.

       The top bit of the top limb falls off the end when the whole is shifted:
       that is the 256th bit, which cannot be held. When it is set the shifted
       value is at least 2^256, which is greater than any divisor below 2^256,
       so the subtraction always happens and the lost bit is exactly what makes
       the comparison come out right. */
    const int overflow = (int)((rest.limbs[3] >> 63) & 1u);
    rest.limbs[3] = (rest.limbs[3] << 1) | (rest.limbs[2] >> 63);
    rest.limbs[2] = (rest.limbs[2] << 1) | (rest.limbs[1] >> 63);
    rest.limbs[1] = (rest.limbs[1] << 1) | (rest.limbs[0] >> 63);
    rest.limbs[0] = (rest.limbs[0] << 1) | ((left->limbs[step / 64] >> (step % 64)) & 1u);
    const int subtract = overflow || !blaze_rt_u256_less(&rest, right);
    if (subtract) {
      blaze_rt_u256_sub(&rest, &rest, right);
      quotient->limbs[step / 64] |= (uint64_t)1u << (unsigned)(step % 64);
    }
  }
  *remainder = rest;
}

/* A division by zero answers zero. The language has no way to raise, so there
   is nothing here for the kernel to report it as, and a target that trapped
   would take the whole program down over one expression; the program driver is
   where a division by a zero the source can settle is refused by name. */
void blaze_rt_u256_div(blaze_u256* out, const blaze_u256* left, const blaze_u256* right) {
  blaze_u256 remainder;
  blaze_u256_divmod(out, &remainder, left, right);
}

void blaze_rt_u256_mod(blaze_u256* out, const blaze_u256* left, const blaze_u256* right) {
  /* left and out may alias (when the caller writes the remainder back into the
     dividend), so copy left into a temporary before divmod zeroes out. */
  uint64_t c;
  if (special_prime_c(right, &c)) {
    /* For special primes 2^256 - c with c < 2^64, left < 2^256 so at most one
       conditional subtraction suffices: left mod mod = left - mod if left >= mod. */
    *out = *left;
    if (!blaze_rt_u256_less(out, right)) {
      blaze_rt_u256_sub(out, out, right);
    }
    return;
  }
  blaze_u256 tmp = *left;
  blaze_u256 quotient;
  blaze_u256_divmod(&quotient, out, &tmp, right);
  (void)quotient;
}

/* Montgomery REDC: computes (T_hi * 2^256 + T_lo) * R^{-1} mod mod, where
   R = 2^256 and pinv = -mod^{-1} mod 2^64. When T_lo is zero and T_hi is a
   256-bit value, this returns T_hi mod mod. The 512-bit input is reduced by
   folding each low limb into the modulus using the precomputed pinv, which
   replaces 512 bit-by-bit shift-and-subtract iterations with four
   multiply-add passes plus one conditional subtraction. */
void blaze_rt_u256_redc(blaze_u256* out, const blaze_u256* T_hi, const blaze_u256* T_lo, const blaze_u256* mod, uint64_t pinv) {
  uint64_t t[8];
  for (unsigned i = 0; i < 4; i += 1) {
    t[i] = T_lo->limbs[i];
    t[i + 4] = T_hi->limbs[i];
  }
  for (unsigned i = 0; i < 4; i += 1) {
    /* m = t[i] * pinv mod 2^64, chosen so t[i] + m * mod[0] ≡ 0 (mod 2^64). */
    uint64_t m = t[i] * pinv;
    /* t[i..i+3] += m * mod, carry chain runs through the limbs. */
    unsigned __int128 carry = 0;
    for (unsigned j = 0; j < 4; j += 1) {
      const unsigned __int128 product =
        (unsigned __int128)m * mod->limbs[j];
      const unsigned __int128 sum =
        (unsigned __int128)t[i + j] + (uint64_t)product + carry;
      t[i + j] = (uint64_t)sum;
      carry = (sum >> 64) + (uint64_t)(product >> 64);
    }
    /* Fold the remaining carry into the next limb. */
    t[i + 4] += (uint64_t)carry;
    if (carry > 0xffffffffffffffffULL && i + 5 < 8) {
      uint64_t extra = (uint64_t)(carry >> 64);
      for (unsigned k = i + 5; k < 8 && extra != 0; k += 1) {
        const uint64_t old = t[k];
        t[k] = old + extra;
        extra = (t[k] < old) ? 1u : 0u;
      }
    }
  }
  /* t[0..3] are now zero (divisible by 2^256); the result is t[4..7]. */
  blaze_u256 result;
  for (unsigned i = 0; i < 4; i += 1) result.limbs[i] = t[4 + i];
  if (!blaze_rt_u256_less(&result, mod)) {
    blaze_rt_u256_sub(&result, &result, mod);
  }
  *out = result;
}

/* Widening zero-extends, because the number is unsigned; narrowing keeps the
   low limb, because a use of a narrow value asks for its low bits and not for
   an error. */
void blaze_rt_u256_from_u64(blaze_u256* out, uint64_t value) {
  *out = blaze_u256_of_u64(value);
}

/* Build a u256 from two 64 bit halves: the low half is limb 0 and the high
   half is limb 1, and the two upper limbs are zero. A value whose high half is
   itself above 2^64 does not fit in a u256, and the caller has to make sure it
   does not. */
void blaze_rt_u256_from_u64x2(blaze_u256* out, uint64_t low, uint64_t high) {
  blaze_u256 result = blaze_u256_zero();
  result.limbs[0] = low;
  result.limbs[1] = high;
  *out = result;
}

/* Build a u256 from four 64 bit limbs, least significant first. This is the
   full construction mechanism: any 256 bit value can be built from its limbs. */
void blaze_rt_u256_from_u64x4(blaze_u256* out, uint64_t l0, uint64_t l1, uint64_t l2, uint64_t l3) {
  blaze_u256 result = blaze_u256_zero();
  result.limbs[0] = l0;
  result.limbs[1] = l1;
  result.limbs[2] = l2;
  result.limbs[3] = l3;
  *out = result;
}

uint64_t blaze_rt_u256_to_u64(const blaze_u256* value) {
  return value->limbs[0];
}

/* A wide number as text. Decimal has no cheap C spelling, so it is produced by
   repeated long division of the limbs; the remainder of one turn is at most
   nine, which is what makes it one digit per turn. Hexadecimal reads the limbs
   top down and skips the leading zeros, so the text carries no padding the
   source did not write.

   Only decimal and hexadecimal are answered. A base outside them is refused by
   the caller rather than answered in base ten, which would print a different
   number from the one the source wrote. */
/* The inverse of blaze_rt_u256_format for base ten: the decimal a wide number
   is written as, read back into its limbs. The verification harness takes a
   test vector as text and has to turn it into the value it names, and a cast
   from a parsed 64 bit number is C the compiler rejects as "conversion to
   non-scalar type requested" — so the whole 256 bits have to be read here,
   digit by digit, which is the inverse of the division the formatter does. */
int blaze_rt_u256_parse(blaze_u256* out, const char* text, size_t length) {
  blaze_u256 value = blaze_u256_zero();
  const blaze_u256 ten = blaze_u256_of_u64(10u);
  size_t at = 0;
  int negative = 0;
  if (length > 0 && (text[0] == '-' || text[0] == '+')) {
    negative = text[0] == '-';
    at = 1;
  }
  int digits = 0;
  for (; at < length; at += 1) {
    const char character = text[at];
    if (character < '0' || character > '9') return 0;
    /* value * 10 + digit, over the four limbs, carrying as it goes. */
    unsigned __int128 carry = (unsigned __int128)(unsigned)(character - '0');
    for (unsigned i = 0; i < 4; i += 1) {
      const unsigned __int128 current = (unsigned __int128)value.limbs[i] * 10u + carry;
      value.limbs[i] = (uint64_t)current;
      carry = current >> 64;
    }
    if (carry != 0) return 0;
    digits += 1;
  }
  if (digits == 0) return 0;
  if (negative) {
    /* Two's complement over the four limbs, which is the whole of what a
       negative wide number is. */
    unsigned __int128 borrow = 1;
    for (unsigned i = 0; i < 4; i += 1) {
      const unsigned __int128 current = (unsigned __int128)(~value.limbs[i]) + borrow;
      value.limbs[i] = (uint64_t)current;
      borrow = current >> 64;
    }
  }
  *out = value;
  return 1;
}

size_t blaze_rt_u256_format(const blaze_u256* value, unsigned base, unsigned char* buffer, size_t size) {
  if (base != 10u && base != 16u) return 0;
  char text[80];
  size_t used = 0;
  if (base == 10u) {
    blaze_u256 rest = *value;
    const blaze_u256 zero = blaze_u256_zero();
    const blaze_u256 ten = blaze_u256_of_u64(10u);
    while (!blaze_rt_u256_equal(&rest, &zero)) {
      unsigned __int128 remainder = 0;
      for (unsigned i = 4; i-- > 0;) {
        const unsigned __int128 current = (remainder << 64) | rest.limbs[i];
        rest.limbs[i] = (uint64_t)(current / ten.limbs[0]);
        remainder = current % ten.limbs[0];
      }
      if (used + 1u < sizeof text) text[used++] = (char)('0' + (unsigned)remainder);
    }
    if (used == 0u) text[used++] = '0';
    for (size_t i = 0; i < used / 2u; i += 1) {
      const char swap = text[i];
      text[i] = text[used - 1u - i];
      text[used - 1u - i] = swap;
    }
  } else {
    unsigned limb = 4;
    while (limb > 0u && value->limbs[limb - 1u] == 0u) limb -= 1u;
    int leading = 1;
    while (limb > 0u) {
      limb -= 1u;
      for (unsigned nibble = 16u; nibble-- > 0;) {
        const unsigned digit = (unsigned)((value->limbs[limb] >> (nibble * 4u)) & 0xfu);
        if (leading && digit == 0u) continue;
        leading = 0;
        if (used + 1u < sizeof text) text[used++] = "0123456789abcdef"[digit];
      }
    }
    if (leading) text[used++] = '0';
  }
  if (used + 1u > size) return 0;
  memcpy(buffer, text, used);
  buffer[used] = '\\0';
  return used;
}

void blaze_rt_print_u256(const blaze_u256* value) {
  unsigned char text[80];
  const size_t written = blaze_rt_u256_format(value, 10u, text, sizeof text);
  fwrite(text, 1, written, stdout);
}

void blaze_rt_print_u256_hex(const blaze_u256* value) {
  unsigned char text[80];
  const size_t written = blaze_rt_u256_format(value, 16u, text, sizeof text);
  fwrite(text, 1, written, stdout);
}
`;

/* The arithmetic of a signed fixed-width wide integer, in one place. A blaze_i256 holds the same four limbs as a blaze_u256, so addition, subtraction, multiplication and the bitwise operations share the two's complement bit patterns of the unsigned form. Only where the sign matters does it differ: shift right extends the sign, comparison reads the sign first, division and remainder truncate toward zero, and decimal text carries a leading minus. */
export const I256_KERNEL = `
/* The zero every operation starts from and the value an underflow produces. */
static blaze_i256 blaze_i256_zero(void) {
  blaze_i256 out;
  out.limbs[0] = 0; out.limbs[1] = 0; out.limbs[2] = 0; out.limbs[3] = 0;
  return out;
}

/* Sign-extends a 64 bit value across the four limbs, so a negative number is held in two's complement with every upper limb all ones. */
static blaze_i256 blaze_i256_of_i64(int64_t value) {
  blaze_i256 out = blaze_i256_zero();
  out.limbs[0] = (uint64_t)value;
  if (value < 0) {
    out.limbs[1] = UINT64_MAX; out.limbs[2] = UINT64_MAX; out.limbs[3] = UINT64_MAX;
  }
  return out;
}

/* True when any limb of the value is not zero. */
static int blaze_i256_is_zero(const blaze_i256* value) {
  return (value->limbs[0] | value->limbs[1] | value->limbs[2] | value->limbs[3]) == 0u;
}

/* The sign of the value: 1 when negative (the top limb's high bit is set), 0 otherwise. */
static int blaze_i256_sign(const blaze_i256* value) {
  return (int)((value->limbs[3] >> 63) & 1u);
}

/* Two's complement negation: complement every limb and add one, carrying as it goes. */
static void blaze_i256_negate(blaze_i256* value) {
  unsigned __int128 borrow = 1;
  for (unsigned i = 0; i < 4; i += 1) {
    const unsigned __int128 current = (unsigned __int128)(~value->limbs[i]) + borrow;
    value->limbs[i] = (uint64_t)current;
    borrow = current >> 64;
  }
}

/* How many bits a magnitude holds above its lowest one, the position of its most significant set bit. The divide below reads that as the count of turns it has left to run. */
static int blaze_i256_bits(const blaze_i256* value) {
  for (unsigned i = 4; i-- > 0;) {
    const uint64_t limb = value->limbs[i];
    if (limb == 0u) continue;
    int top = 0;
    for (unsigned bit = 0; bit < 64u; bit += 1) {
      if ((limb >> bit) & 1u) top = (int)bit + 1;
    }
    return (int)(i * 64u) + top;
  }
  return 0;
}

/* Walks from the top limb down; the first limb that differs decides the answer, treating the limbs as an unsigned magnitude. */
static int blaze_i256_unsigned_less(const blaze_i256* left, const blaze_i256* right) {
  for (unsigned i = 4; i-- > 0;) {
    if (left->limbs[i] < right->limbs[i]) return 1;
    if (left->limbs[i] > right->limbs[i]) return 0;
  }
  return 0;
}

/* Addition and subtraction share the two's complement bit patterns of the unsigned form: the carry and borrow propagate limb by limb and the carry out of the top limb is dropped, which is exactly wrapping modulo 2^256. */
void blaze_rt_i256_add(blaze_i256* out, const blaze_i256* left, const blaze_i256* right) {
  unsigned __int128 carry = 0;
  for (unsigned i = 0; i < 4; i += 1) {
    const unsigned __int128 sum = (unsigned __int128)left->limbs[i] + right->limbs[i] + carry;
    out->limbs[i] = (uint64_t)sum;
    carry = sum >> 64;
  }
}

void blaze_rt_i256_sub(blaze_i256* out, const blaze_i256* left, const blaze_i256* right) {
  unsigned __int128 borrow = 0;
  for (unsigned i = 0; i < 4; i += 1) {
    const unsigned __int128 difference = (unsigned __int128)left->limbs[i] - right->limbs[i] - borrow;
    out->limbs[i] = (uint64_t)difference;
    borrow = (difference >> 64) & 1u;
  }
}

/* Schoolbook multiplication: the low 256 bits of the product are the same whether the operands are read as signed or unsigned, so the unsigned kernel's columns give the two's complement product. */
void blaze_rt_i256_mul(blaze_i256* out, const blaze_i256* left, const blaze_i256* right) {
  blaze_i256 accumulator = blaze_i256_zero();
  for (unsigned i = 0; i < 4; i += 1) {
    unsigned __int128 carry = 0;
    for (unsigned j = 0; i + j < 4; j += 1) {
      const unsigned __int128 product = (unsigned __int128)left->limbs[i] * right->limbs[j] + accumulator.limbs[i + j] + carry;
      accumulator.limbs[i + j] = (uint64_t)product;
      carry = product >> 64;
    }
  }
  *out = accumulator;
}

void blaze_rt_i256_and(blaze_i256* out, const blaze_i256* left, const blaze_i256* right) {
  for (unsigned i = 0; i < 4; i += 1) out->limbs[i] = left->limbs[i] & right->limbs[i];
}

void blaze_rt_i256_or(blaze_i256* out, const blaze_i256* left, const blaze_i256* right) {
  for (unsigned i = 0; i < 4; i += 1) out->limbs[i] = left->limbs[i] | right->limbs[i];
}

void blaze_rt_i256_xor(blaze_i256* out, const blaze_i256* left, const blaze_i256* right) {
  for (unsigned i = 0; i < 4; i += 1) out->limbs[i] = left->limbs[i] ^ right->limbs[i];
}

/* The complement covers every limb, so it is a complement over all 256 bits rather than a 64 bit one repeated four times. */
void blaze_rt_i256_not(blaze_i256* out, const blaze_i256* value) {
  for (unsigned i = 0; i < 4; i += 1) out->limbs[i] = ~value->limbs[i];
}

/* A shift left is the same bit move whether the number is signed or unsigned: the bits move up and the bits that leave the top limb are dropped. */
static void blaze_i256_shl_limbs(blaze_i256* out, const blaze_i256* value, unsigned limbs) {
  blaze_i256 result = blaze_i256_zero();
  for (unsigned i = limbs; i < 4; i += 1) result.limbs[i] = value->limbs[i - limbs];
  *out = result;
}

static void blaze_i256_shl_bits(blaze_i256* out, const blaze_i256* value, unsigned bits) {
  blaze_i256 result = blaze_i256_zero();
  for (unsigned i = 0; i < 4; i += 1) {
    uint64_t limb = value->limbs[i] << bits;
    if (i > 0u) limb |= value->limbs[i - 1u] >> (64u - bits);
    result.limbs[i] = limb;
  }
  *out = result;
}

void blaze_rt_i256_shl(blaze_i256* out, const blaze_i256* value, unsigned count) {
  if (count >= 256u) { *out = blaze_i256_zero(); return; }
  const unsigned limbs = count / 64u;
  const unsigned bits = count % 64u;
  if (bits == 0u) {
    blaze_i256_shl_limbs(out, value, limbs);
    return;
  }
  blaze_i256 moved;
  blaze_i256_shl_limbs(&moved, value, limbs);
  blaze_i256_shl_bits(out, &moved, bits);
}

/* A shift right extends the sign rather than filling with zeros: when the top limb's high bit is set, the bits shifted in at the top are ones, which is what keeps a negative number negative as it moves down. A shift of 256 or more leaves every bit as the sign, which is -1 for a negative number and 0 for a positive one. */
static void blaze_i256_shr_limbs(blaze_i256* out, const blaze_i256* value, unsigned limbs) {
  blaze_i256 result = blaze_i256_zero();
  const uint64_t fill = blaze_i256_sign(value) ? UINT64_MAX : 0u;
  for (unsigned i = 0; i + limbs < 4; i += 1) result.limbs[i] = value->limbs[i + limbs];
  for (unsigned i = 4 - limbs; i < 4; i += 1) result.limbs[i] = fill;
  *out = result;
}

static void blaze_i256_shr_bits(blaze_i256* out, const blaze_i256* value, unsigned bits) {
  blaze_i256 result = blaze_i256_zero();
  const uint64_t fill = blaze_i256_sign(value) ? UINT64_MAX : 0u;
  for (unsigned i = 0; i < 4; i += 1) {
    uint64_t limb = value->limbs[i] >> bits;
    if (i + 1u < 4u) limb |= value->limbs[i + 1u] << (64u - bits);
    else limb |= fill << (64u - bits);
    result.limbs[i] = limb;
  }
  *out = result;
}

void blaze_rt_i256_shr(blaze_i256* out, const blaze_i256* value, unsigned count) {
  if (count >= 256u) {
    blaze_i256 result = blaze_i256_zero();
    if (blaze_i256_sign(value)) {
      result.limbs[0] = UINT64_MAX; result.limbs[1] = UINT64_MAX; result.limbs[2] = UINT64_MAX; result.limbs[3] = UINT64_MAX;
    }
    *out = result;
    return;
  }
  const unsigned limbs = count / 64u;
  const unsigned bits = count % 64u;
  if (bits == 0u) {
    blaze_i256_shr_limbs(out, value, limbs);
    return;
  }
  blaze_i256 moved;
  blaze_i256_shr_limbs(&moved, value, limbs);
  blaze_i256_shr_bits(out, &moved, bits);
}

/* A signed comparison reads the sign first: a negative is below a positive whatever their magnitudes, and two numbers of the same sign are compared as magnitudes, with the larger magnitude of two negatives being the smaller number. */
int blaze_rt_i256_less(const blaze_i256* left, const blaze_i256* right) {
  const int leftSign = blaze_i256_sign(left);
  const int rightSign = blaze_i256_sign(right);
  if (leftSign != rightSign) return leftSign;
  /* Two's complement preserves ordering between two numbers of the same sign,
     so the unsigned limb comparison decides both the positive and the negative
     case: for two negatives the one with the larger unsigned value is the
     smaller (closer to zero) number, and the unsigned walk reads exactly that. */
  return blaze_i256_unsigned_less(left, right);
}

int blaze_rt_i256_equal(const blaze_i256* left, const blaze_i256* right) {
  return (left->limbs[0] == right->limbs[0]) && (left->limbs[1] == right->limbs[1]) &&
         (left->limbs[2] == right->limbs[2]) && (left->limbs[3] == right->limbs[3]);
}

/* Restoring division on magnitudes, then the sign is applied: the quotient takes the sign of the dividend XOR the divisor (truncating toward zero), and the remainder takes the sign of the dividend. The most negative value has no matching positive, so its magnitude is taken as itself and the single overflow case (the most negative divided by -1) wraps back to the most negative, as wrapping arithmetic does. */
static void blaze_i256_divmod(blaze_i256* quotient, blaze_i256* remainder, const blaze_i256* left, const blaze_i256* right) {
  *quotient = blaze_i256_zero();
  *remainder = blaze_i256_zero();
  if (blaze_i256_is_zero(right)) return;
  const int leftSign = blaze_i256_sign(left);
  const int rightSign = blaze_i256_sign(right);
  /* The magnitudes: negate a negative value into its two's complement positive. */
  blaze_i256 leftMag = *left;
  blaze_i256 rightMag = *right;
  if (leftSign) blaze_i256_negate(&leftMag);
  if (rightSign) blaze_i256_negate(&rightMag);
  blaze_i256 q = blaze_i256_zero();
  blaze_i256 rest = blaze_i256_zero();
  for (int step = blaze_i256_bits(&leftMag) - 1; step >= 0; step -= 1) {
    /* What is left moves up one bit and takes the dividend's bit at the bottom. A shift by the full width of a limb is undefined in C, so each limb takes the top bit of the one below it rather than being shifted as a number. */
    rest.limbs[3] = (rest.limbs[3] << 1) | (rest.limbs[2] >> 63);
    rest.limbs[2] = (rest.limbs[2] << 1) | (rest.limbs[1] >> 63);
    rest.limbs[1] = (rest.limbs[1] << 1) | (rest.limbs[0] >> 63);
    rest.limbs[0] = (rest.limbs[0] << 1) | ((leftMag.limbs[step / 64] >> (step % 64)) & 1u);
    if (!blaze_i256_unsigned_less(&rest, &rightMag)) {
      /* rest -= rightMag, written limb by limb with a borrow. */
      unsigned __int128 borrow = 0;
      for (unsigned i = 0; i < 4; i += 1) {
        const unsigned __int128 difference = (unsigned __int128)rest.limbs[i] - rightMag.limbs[i] - borrow;
        rest.limbs[i] = (uint64_t)difference;
        borrow = (difference >> 64) & 1u;
      }
      q.limbs[step / 64] |= (uint64_t)1u << (unsigned)(step % 64);
    }
  }
  /* Apply the signs: the quotient is negative exactly when the signs differ, and the remainder keeps the dividend's sign. */
  if ((leftSign ^ rightSign) != 0) blaze_i256_negate(&q);
  if (leftSign != 0) blaze_i256_negate(&rest);
  *quotient = q;
  *remainder = rest;
}

void blaze_rt_i256_div(blaze_i256* out, const blaze_i256* left, const blaze_i256* right) {
  blaze_i256 remainder;
  blaze_i256_divmod(out, &remainder, left, right);
}

void blaze_rt_i256_mod(blaze_i256* out, const blaze_i256* left, const blaze_i256* right) {
  blaze_i256 quotient;
  blaze_i256_divmod(&quotient, out, left, right);
  (void)quotient;
}

/* Widening sign-extends, because the number is signed; narrowing keeps the low limb, read as a signed 64 bit number. */
void blaze_rt_i256_from_i64(blaze_i256* out, int64_t value) {
  *out = blaze_i256_of_i64(value);
}

int64_t blaze_rt_i256_to_i64(const blaze_i256* value) {
  return (int64_t)value->limbs[0];
}

/* A wide number as text. Decimal prints a leading minus when the value is negative and then the magnitude's digits; hexadecimal reads the limbs top down and skips the leading zeros. Only decimal and hexadecimal are answered. */
size_t blaze_rt_i256_format(const blaze_i256* value, unsigned base, unsigned char* buffer, size_t size) {
  if (base != 10u && base != 16u) return 0;
  char text[80];
  size_t used = 0;
  if (base == 10u) {
    blaze_i256 rest = *value;
    const int negative = blaze_i256_sign(&rest);
    if (negative) blaze_i256_negate(&rest);
    const blaze_i256 zero = blaze_i256_zero();
    const blaze_i256 ten = blaze_i256_of_i64(10);
    while (!blaze_rt_i256_equal(&rest, &zero)) {
      unsigned __int128 remainder = 0;
      for (unsigned i = 4; i-- > 0;) {
        const unsigned __int128 current = (remainder << 64) | rest.limbs[i];
        rest.limbs[i] = (uint64_t)(current / ten.limbs[0]);
        remainder = current % ten.limbs[0];
      }
      if (used + 1u < sizeof text) text[used++] = (char)('0' + (unsigned)remainder);
    }
    if (used == 0u) text[used++] = '0';
    /* The digits were collected least significant first, so reverse them to most significant first. */
    for (size_t i = 0; i < used / 2u; i += 1) {
      const char swap = text[i];
      text[i] = text[used - 1u - i];
      text[used - 1u - i] = swap;
    }
    /* A negative value carries a leading minus, which now goes at the front. */
    if (negative) {
      for (size_t i = used; i > 0; i -= 1) text[i] = text[i - 1];
      text[0] = '-';
      used += 1;
    }
  } else {
    unsigned limb = 4;
    while (limb > 0u && value->limbs[limb - 1u] == 0u) limb -= 1u;
    int leading = 1;
    while (limb > 0u) {
      limb -= 1u;
      for (unsigned nibble = 16u; nibble-- > 0;) {
        const unsigned digit = (unsigned)((value->limbs[limb] >> (nibble * 4u)) & 0xfu);
        if (leading && digit == 0u) continue;
        leading = 0;
        if (used + 1u < sizeof text) text[used++] = "0123456789abcdef"[digit];
      }
    }
    if (leading) text[used++] = '0';
  }
  if (used + 1u > size) return 0;
  memcpy(buffer, text, used);
  buffer[used] = '\0';
  return used;
}

/* The inverse of blaze_rt_i256_format for base ten: a leading minus is read into the sign and the digits are accumulated limb by limb, then the value is negated into two's complement when the sign was set. */
int blaze_rt_i256_parse(blaze_i256* out, const char* text, size_t length) {
  blaze_i256 value = blaze_i256_zero();
  const blaze_i256 ten = blaze_i256_of_i64(10u);
  size_t at = 0;
  int negative = 0;
  if (length > 0 && (text[0] == '-' || text[0] == '+')) {
    negative = text[0] == '-';
    at = 1;
  }
  int digits = 0;
  for (; at < length; at += 1) {
    const char character = text[at];
    if (character < '0' || character > '9') return 0;
    /* value * 10 + digit, over the four limbs, carrying as it goes. */
    unsigned __int128 carry = (unsigned __int128)(unsigned)(character - '0');
    for (unsigned i = 0; i < 4; i += 1) {
      const unsigned __int128 current = (unsigned __int128)value.limbs[i] * 10u + carry;
      value.limbs[i] = (uint64_t)current;
      carry = current >> 64;
    }
    if (carry != 0) return 0;
    digits += 1;
  }
  if (digits == 0) return 0;
  if (negative) {
    /* Two's complement over the four limbs, which is the whole of what a negative wide number is. */
    unsigned __int128 borrow = 1;
    for (unsigned i = 0; i < 4; i += 1) {
      const unsigned __int128 current = (unsigned __int128)(~value.limbs[i]) + borrow;
      value.limbs[i] = (uint64_t)current;
      borrow = current >> 64;
    }
  }
  *out = value;
  return 1;
}

void blaze_rt_print_i256(const blaze_i256* value) {
  unsigned char text[80];
  const size_t written = blaze_rt_i256_format(value, 10u, text, sizeof text);
  fwrite(text, 1, written, stdout);
}

void blaze_rt_print_i256_hex(const blaze_i256* value) {
  unsigned char text[80];
  const size_t written = blaze_rt_i256_format(value, 16u, text, sizeof text);
  fwrite(text, 1, written, stdout);
}
`;

/**
 * The runtime the compiler emits for `runtime: none`, on top of libc.
 *
 * A `danger` build leaves the guards out. Every one of them is a check the
 * program would otherwise make of itself, and the guards are the only
 * run-time safety checks a generated program carries: the IR holds no length
 * for an element access and no backend emits a check for one, so the magic
 * number, the overflow check and the caps are what stand between a released
 * pointer and a second use of it.
 *
 * What `danger` does not change is what the compiler proves before it lowers
 * anything: the IR is validated the same way, and a candidate is verified
 * against the contract and measured the same way. A `danger` build is a build
 * whose program stops defending itself once it is running.
 */
export function runtimeSourceSource(mode: BuildMode = "debug"): string {
  const guarded = mode !== "danger";
  return `/* Generated by the blaze compiler. Do not edit. */
#include <math.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "${RUNTIME_NAME}.h"

static const char* blaze_rt_last_message = "";

/* The small-block pool. A block is put in a class by the total it occupies
   rounded up to the granularity, and the class is what it is carved as and
   what it goes back onto when it is released. Sixteen classes of sixteen bytes
   each reach 256 bytes, which is a header, an alignment and a payload of a
   hundred and eighty six: every object a program builds out of fields, every
   short string, and every small buffer. Anything larger is the host's to give
   and the host's to take back. */
#define BLAZE_RT_SLAB_GRANULARITY 16u
#define BLAZE_RT_SLAB_CLASSES 16u
#define BLAZE_RT_SLAB_LARGEST (BLAZE_RT_SLAB_CLASSES * BLAZE_RT_SLAB_GRANULARITY)
/* How much is asked for at a time. A program that allocates very little pays
   for a slab it does not fill, and a program that allocates a great deal
   reaches the host often enough to matter either way. */
#define BLAZE_RT_SLAB_BYTES (256u * 1024u)

/* The most parts a team is cut into. A processor count is read from the host
   and nothing bounds it, and the jobs and the thread handles of a team are two
   arrays on the stack of whoever asked for it. Sixty-four is past any machine
   this will run on and small enough to sit there. */
#define BLAZE_RT_PARALLEL_PARTS 64

${guarded ? `static void blaze_rt_refuse(const char* what) {
  fprintf(stderr, "blaze: %s\\n", what);
  exit(2);
}` : "/* A danger build: this runtime does not check what it is handed, so it has nothing to refuse. */"}

/* One subtraction and, where the guards are in, two comparisons. It is on the
   path of every retain and every release, and -ffunction-sections makes it a
   call rather than a few instructions. blaze_rt_class_of below is inlined for
   the same reason. */
static inline __attribute__((always_inline)) blaze_rt_header* blaze_rt_header_of(void* pointer) {
  blaze_rt_header* header = (blaze_rt_header*)((char*)pointer - BLAZE_RT_HEADER_SIZE);
${guarded ? `  if (header->magic != BLAZE_RT_MAGIC) blaze_rt_refuse("not a live runtime pointer");
  if (header->alignment == 0 || (header->alignment & (header->alignment - 1)) != 0) {
    blaze_rt_refuse("corrupt runtime header");
  }` : ""}
  return header;
}

/* The size of count elements, refused when the product would leave the range
   the runtime hands out: a wrapped size allocates a block far smaller than
   the array the caller is about to write into, so the first element ends up
   corrupting the heap. */
static size_t blaze_rt_array_bytes(size_t count, size_t elementSize${guarded ? ", const char* who" : ""}) {
${guarded ? `  if (elementSize != 0 && count > BLAZE_RT_MAX_ALLOCATION / elementSize) {
    fprintf(stderr, "blaze: %s: request too large\\n", who);
    exit(2);
  }` : ""}
  return count * elementSize;
}

/* A small block comes out of a slab, which is one large cleared region the
   runtime carves blocks from, and a block that is released goes back onto the
   list of its own class rather than to the host allocator.

   This is where most of the time of a program that builds a lot of values
   goes. A block of this size is a header, a payload of a few words and the
   alignment slack below, and asking the host allocator for each one costs more
   than every instruction the program itself spends on the value. What is left
   is the first touch of the memory, which no allocator can take away: a block
   the program asked for is a block the program has to have.

   A block is pooled only when it is cleared and only when its alignment is no
   wider than the granularity, and both of those make the block's own header
   sit at a fixed distance from the start of its class. A cleared slab hands
   out memory that is already zero, so a block carved from one needs nothing
   written over its payload; a fixed offset means a block taken off a release
   list is cleared by writing over the whole class rather than over a payload
   whose place in the class would have to be worked out. A block that is not
   cleared, or that is aligned more widely than the granularity, or that is
   larger than the largest class, is the host's to give and the host's to take
   back — the last of those because a slab is never handed back, and a program
   that allocates one large block and frees it should get that memory again. */
/* The pool is per thread, and that is what lets a turn of a parallel loop
   allocate. Two turns carving out of one cursor and pushing onto one list is
   what made an allocating turn unsafe before: the cursor is read, advanced and
   written by every thread at once, so two turns are handed the same block and
   two blocks are linked into one list. A pool of its own per thread removes
   the race outright rather than locking it away — there is nothing left to
   share, so no lock is bought and no turn waits on one.

   A block released by a thread other than the one that carved it goes onto
   the releasing thread's list rather than back to where it came from, which
   is sound because a slab is never handed back to the host: the memory a
   block sits in stays mapped whatever list it is on, and a block on this
   thread's list is only ever handed to this thread. The cost of that is that
   blocks migrate towards whoever is releasing most, which for a program whose
   turns each build and drop their own values is the right direction anyway.

   What the per-thread pool does not make safe is the reference count, which is
   one number every turn shares: a turn that retains or releases a value
   another turn also holds is still refused by the rule that marks loops
   parallel. What it makes safe is a turn that builds values of its own and
   lets them go, which is the shape "out[i] = build(in[i])" has. */
static _Thread_local char* blaze_rt_slab_at = NULL;
static _Thread_local char* blaze_rt_slab_end = NULL;
static _Thread_local blaze_rt_header* blaze_rt_released[BLAZE_RT_SLAB_CLASSES];

/* A region is the same kind of cursor as a slab, and it has the same reason to
   be per thread. The difference is that it is rewound rather than recycled one
   block at a time: a turn that builds a tree and walks it takes one region,
   and the turn after it starts the region again from the same place, so the
   nodes of the next tree are written over the ones just walked.

   That is where most of the time of such a program goes without it. A tree of
   depth d is 2^d nodes of a few words each, and a program asked for one
   thousand of them is asked for a gigabyte of memory it will never read again.
   Handing that out fresh costs the kernel a fault per page and a cache miss
   per node, and rewind makes the working set small enough to stay in cache.

   The cursor is rewound and never copied. A block holds pointers to the blocks
   beside it, so growing the region by moving what it already holds would
   leave every one of those pointers aimed at where a block used to be; a
   region that has run out is abandoned for a larger one instead, and the
   abandoned one is still the right size for whatever needs it to be. */
static _Thread_local char* blaze_rt_region_base = NULL;
static _Thread_local char* blaze_rt_region_at = NULL;
static _Thread_local char* blaze_rt_region_end = NULL;
static _Thread_local size_t blaze_rt_region_room = 0;
static _Thread_local unsigned blaze_rt_region_depth = 0;

/* How much a region asks for when it starts. It is big enough that the tree of
   a benchmark run is built without ever reaching for a second one, and small
   enough that a program which asks for one keeps one slab's worth. */
#define BLAZE_RT_REGION_BYTES (4u * 1024u * 1024u)

/* The class a block of total bytes at the given alignment belongs to,
   counting from one, or zero for a block the host is asked for. A class is
   never zero for a block that can be pooled, because the smallest block is a
   header and an alignment and no payload at all.

   It is marked always_inline rather than left to the C compiler's own
   judgement, and the reason is -ffunction-sections: every entry point is
   given a section of its own so that the link can drop the ones a program never
   reached, and a function of its own section is a call rather than a few
   instructions folded into its caller. That is what the flag is for, and this
   helper is not an entry point — it is three instructions on the path of every
   allocation, so as a call it costs a frame and a branch per allocation to say
   something the caller could have worked out for itself. */
static inline __attribute__((always_inline)) size_t blaze_rt_class_of(size_t total, size_t alignment) {
  if (total > BLAZE_RT_SLAB_LARGEST || alignment > BLAZE_RT_SLAB_GRANULARITY) return 0;
  return (total + BLAZE_RT_SLAB_GRANULARITY - 1) / BLAZE_RT_SLAB_GRANULARITY;
}

/* A block with room for the bytes of payload asked for, and optionally cleared.

   The alignment is added to the size on top of the payload rather than taken
   out of the slack the host allocator leaves. It looks like 16 wasted bytes on
   every block, and on a one-byte payload it is 16 of 65, but those bytes are
   what a read past the end of an array lands on: the program is allowed to
   read past what it filled, there is no bounds check at any mode because the
   IR holds no length for an element access, and the source language answers
   that read as a zero. A block sized without the slack put the read into the
   allocator's own rounding, which is not zero, and a while loop over an array
   then ran past the values it was given. */
static void* blaze_rt_region_take(size_t total, size_t bytes, size_t alignment, int cleared);

static void* blaze_rt_block(size_t bytes, size_t alignment, int cleared) {
  if (alignment == 0) alignment = BLAZE_RT_DEFAULT_ALIGNMENT;
${guarded ? `  /* The payload is placed with a mask, which only places it for a power of
     two, and an alignment past the cap names no block the runtime can give. */
  if ((alignment & (alignment - 1)) != 0) blaze_rt_refuse("object alignment must be a power of two");
  /* The budget the next line checks against is the cap less the alignment less
     the header, and an alignment at the cap leaves that subtraction to wrap:
     the guard reads as the whole size_t range, every request is under it, and
     the total below wraps into a small allocation whose payload is then
     placed a terabyte away from the block that was actually mapped. The cap
     has to leave room for the header as well as for the payload. */
  if (alignment > BLAZE_RT_MAX_ALLOCATION - BLAZE_RT_HEADER_SIZE) blaze_rt_refuse("object alignment is too large");
  if (bytes > BLAZE_RT_MAX_ALLOCATION - alignment - BLAZE_RT_HEADER_SIZE) blaze_rt_refuse("request too large");` : ""}
  const size_t total = bytes + alignment + BLAZE_RT_HEADER_SIZE;
  if (blaze_rt_region_depth > 0) return blaze_rt_region_take(total, bytes, alignment, cleared);
  const size_t cls = cleared ? blaze_rt_class_of(total, alignment) : 0;
  if (cls != 0) {
    /* The header of a pooled block is at the start of its class, so the payload
       is a fixed distance from it and the class is the whole of what the block
       occupies. A block taken off a release list is memory the program has
       already had and written to, so it is cleared here rather than asked for
       again, and the header goes down in the same pass. */
    blaze_rt_header* header = blaze_rt_released[cls - 1];
    if (header != NULL) {
      blaze_rt_released[cls - 1] = (blaze_rt_header*)header->base;
      /* Only the payload is cleared. The header is written in full by the five
         stores below, and the one field of it that is not — the free-list link
         a release pushes, and the zero that tells a pooled block from one the
         host gave out — is zeroed here on its own. Clearing the whole class
         writes those bytes twice, and a program that recycles a block on every
         allocation writes them twice for every one of them. */
      header->base = NULL;
      memset((char*)header + BLAZE_RT_HEADER_SIZE, 0, cls * BLAZE_RT_SLAB_GRANULARITY - BLAZE_RT_HEADER_SIZE);
    } else {
      const size_t span = cls * BLAZE_RT_SLAB_GRANULARITY;
      if ((size_t)(blaze_rt_slab_end - blaze_rt_slab_at) < span) {
        char* slab = (char*)calloc(1, BLAZE_RT_SLAB_BYTES);
${guarded ? "        if (slab == NULL) blaze_rt_refuse(\"out of memory\");" : ""}
        blaze_rt_slab_at = slab;
        blaze_rt_slab_end = slab + BLAZE_RT_SLAB_BYTES;
      }
      header = (blaze_rt_header*)blaze_rt_slab_at;
      blaze_rt_slab_at += span;
    }
    header->length = bytes;
    header->alignment = alignment;
    header->references = 1;
    header->capacity = bytes;
    header->magic = BLAZE_RT_MAGIC;
    return (char*)header + BLAZE_RT_HEADER_SIZE;
  }
  char* base = cleared ? (char*)calloc(1, total) : (char*)malloc(total);
${guarded ? "  if (base == NULL) blaze_rt_refuse(\"out of memory\");" : ""}
  const uintptr_t start = (uintptr_t)(base + BLAZE_RT_HEADER_SIZE);
  const uintptr_t aligned = (start + alignment - 1) & ~(uintptr_t)(alignment - 1);
  blaze_rt_header* header = (blaze_rt_header*)(aligned - BLAZE_RT_HEADER_SIZE);
  header->magic = BLAZE_RT_MAGIC;
  header->base = base;
  header->length = bytes;
  header->alignment = alignment;
  header->references = 1;
  header->capacity = bytes;
  return (void*)aligned;
}

/* A block out of the region that is open, laid out exactly as a block out of a
   slab is: the header first, then the payload placed with the alignment the
   allocation asked for, and slack enough for that placement to stay inside the
   span the cursor is advanced by. */
static void* blaze_rt_region_take(size_t total, size_t bytes, size_t alignment, int cleared) {
  if (blaze_rt_region_at == NULL || (size_t)(blaze_rt_region_end - blaze_rt_region_at) < total) {
    /* A region that filled up was asked for more room than it had, so the next
       one it asks for is twice what this one was, and never less. A region that
       asked for the same size every time it filled would hand the host a fresh
       block on every turn and move the rewind point onto it, which is the whole
       thing the region exists to avoid: the turns of a loop are the same turns,
       and a loop that fills one region fills it every time. */
    size_t room = blaze_rt_region_room < BLAZE_RT_REGION_BYTES ? BLAZE_RT_REGION_BYTES : blaze_rt_region_room * 2;
    while (room < total) room += room;
    char* fresh = (char*)aligned_alloc(64, room);
${guarded ? '    if (fresh == NULL) blaze_rt_refuse("out of memory");' : ""}
    /* A block the region has not handed anything out of yet holds nothing this
       turn is still using, so it goes back rather than being left for the host
       to reclaim. One the turn has already built into is left alone: it holds
       the tree so far, and moving that is what a copy would break. */
    if (blaze_rt_region_at == blaze_rt_region_base) free(blaze_rt_region_base);
    blaze_rt_region_room = room;
    blaze_rt_region_base = fresh;
    blaze_rt_region_at = fresh;
    blaze_rt_region_end = fresh + room;
  }
  blaze_rt_header* header = (blaze_rt_header*)blaze_rt_region_at;
  blaze_rt_region_at += total;
  char* start = (char*)header + BLAZE_RT_HEADER_SIZE;
  char* aligned = (char*)(((uintptr_t)start + alignment - 1) & ~(uintptr_t)(alignment - 1));
  header->length = bytes;
  header->alignment = alignment;
  header->references = 1;
  header->capacity = bytes;
  header->magic = BLAZE_RT_MAGIC;
  header->base = NULL;
  /* Cleared as a whole block rather than as a payload: aligned_alloc clears
     nothing, and the bytes between the payload and the end of the block are
     what a read past the end of an array lands on, which the language answers
     as a zero. Every other cleared path here -- the recycled block above and
     the host calloc below -- zeroes them with the payload, and a region that
     left them holding whatever the previous turn wrote there turns a
     "while (a[i]) i++" into a run off the end of the array. The end of the
     block is where the cursor now is, so the clear never reaches into the
     block after it. */
  if (cleared) memset(aligned, 0, (size_t)((char*)header + total) - (size_t)aligned);
  return aligned;
}

void blaze_rt_initialize(void) { setbuf(stdout, NULL); }

void blaze_rt_finalize(void) {}

void blaze_rt_region_enter(void) {
  /* The rewind is the whole of what a region is for, and it is only sound at
     the outermost one. A turn of a marked loop may call a function whose own
     turn is marked too — the compiler marks the innermost loop it can on a
     path, which is a statement about one body and says nothing about a call
     into another — and a rewind inside that call hands the outer turn's blocks
     out a second time while the outer turn is still reading them. So a nested
     enter shares the cursor the outer region is filling rather than rewinding
     it, and the inner loop loses its own reuse and keeps its blocks sound. */
  if (blaze_rt_region_depth++ == 0) blaze_rt_region_at = blaze_rt_region_base;
}

void blaze_rt_region_leave(void) {
  /* Saturating, because a turn that leaves early leaves the region early and
     the compiler writes the closing call on the path out of the body as well.
     One call too many ends the outermost region; one call too few would leave
     the thread allocating from a cursor nothing rewinds again. */
  if (blaze_rt_region_depth > 0) blaze_rt_region_depth -= 1;
}

/* What one thread of a team is handed: the turn to run, the frame to read it
   out of, and which part of the counters this thread answers. */
typedef struct blaze_rt_turn_job {
  void (*turn)(void*, size_t, size_t);
  void* frame;
  size_t begin;
  size_t end;
} blaze_rt_turn_job;

static void* blaze_rt_run_part(void* argument) {
  blaze_rt_turn_job* job = (blaze_rt_turn_job*)argument;
  job->turn(job->frame, job->begin, job->end);
  return NULL;
}

/* How many parts the counters are cut into. One part per processor, and never
   more parts than there are counters to cut, because a part of nothing is a
   thread that was started to do no work at all.

   The cap is the cap the two arrays below are sized to, and it is applied here
   rather than trusted. A processor count is read from the host and nothing
   bounds it: a machine reporting more than BLAZE_RT_PARALLEL_PARTS online
   processors made this write a part past the end of each of the two arrays,
   over the caller's stack and into a frame that was live. */
static size_t blaze_rt_parts_for(size_t count) {
  long processors = sysconf(_SC_NPROCESSORS_ONLN);
  if (processors < 1) processors = 1;
  if ((size_t)processors > count) processors = (long)count;
  if ((size_t)processors > BLAZE_RT_PARALLEL_PARTS) processors = BLAZE_RT_PARALLEL_PARTS;
  return (size_t)processors;
}

/* A turn is a call the compiler emitted into the object it is linking, and this
   is what calls it. The parts are cut by hand rather than handed out through a
   shared counter, so the code here needs no atomics of its own: a thread is
   given the range it answers before it starts, and no two are given the same
   one. The counters themselves are contiguous, which is what lets a turn read
   the same memory in the same order whichever thread is running it.

   The last part is run by the calling thread rather than by one of its own, so
   a program of one processor spawns nothing and a program whose threads cannot
   be created runs every part here, in order. Either way the parts are joined
   before this returns, so a caller that reads an element a turn wrote reads it
   written rather than reads it while a thread is still writing it. */
void blaze_rt_parallel_for(size_t count, void (*turn)(void*, size_t, size_t), void* frame) {
  size_t parts = blaze_rt_parts_for(count);
  if (parts <= 1) {
    turn(frame, 0, count);
    return;
  }
  pthread_t threads[BLAZE_RT_PARALLEL_PARTS];
  blaze_rt_turn_job jobs[BLAZE_RT_PARALLEL_PARTS];
  size_t started = 0;
  for (size_t part = 0; part + 1 < parts; part += 1) {
    jobs[part].turn = turn;
    jobs[part].frame = frame;
    jobs[part].begin = count * part / parts;
    jobs[part].end = count * (part + 1) / parts;
    if (pthread_create(&threads[started], NULL, blaze_rt_run_part, &jobs[part]) != 0) break;
    started += 1;
  }
  /* The part no thread was given, which is the one this thread runs itself. A
     thread that could not be created leaves its part to be run here too, which
     is why this starts at the first part no thread took rather than at the
     last. */
  for (size_t part = started; part < parts; part += 1) {
    turn(frame, count * part / parts, count * (part + 1) / parts);
  }
  for (size_t at = 0; at < started; at += 1) pthread_join(threads[at], NULL);
}

void* blaze_rt_allocate(size_t bytes) {
  return blaze_rt_block(bytes, BLAZE_RT_DEFAULT_ALIGNMENT, 1);
}

void* blaze_rt_allocate_uninitialized(size_t bytes) {
  return blaze_rt_block(bytes, BLAZE_RT_DEFAULT_ALIGNMENT, 0);
}

void* blaze_rt_reallocate(void* pointer, size_t bytes) {
  if (pointer == NULL) return blaze_rt_allocate(bytes);
  blaze_rt_header* header = blaze_rt_header_of(pointer);
  /* A block asked to grow into room it already has is already that block. This
     is what makes a geometric growth policy free: the first append over a
     literal allocates once and every later one lands here. */
  if (bytes <= header->capacity) {
    if (bytes > header->length) memset((char*)pointer + header->length, 0, bytes - header->length);
    header->length = bytes;
    return pointer;
  }
  /* A block that grows *moves*: the bytes are copied into a new block and this
     one is released. Every other holder of it is therefore left holding the
     block that was just released, which is a use after free whatever the count
     says — carrying the count across the move would keep the new block alive for
     holders that are reading the old one, so the same dangling pointer with the
     count agreeing about it. A resize is the same program only where the caller
     holds the only reference, so that is what is asked here. */
${guarded ? '  if (header->references > 1) blaze_rt_refuse("a block that is resized must be the only reference to it");' : ""}
  /* Doubling is what keeps a loop of appends from being quadratic. The request
     is a floor rather than a target: a caller that asks for the exact size it
     needs still gets at least twice the block it had, so the next append of a
     similar size is free. */
  size_t wanted = header->capacity + header->capacity / 2 + 16;
  void* grown = blaze_rt_block(bytes < wanted ? wanted : bytes, header->alignment, 1);
  memcpy(grown, pointer, header->length);
  blaze_rt_release(pointer);
  return grown;
}

void* blaze_rt_retain(void* pointer) {
${guarded ? "  if (pointer == NULL) return NULL;" : ""}
  blaze_rt_header_of(pointer)->references += 1;
  return pointer;
}

void blaze_rt_release(void* pointer) {
  /* The ABI promises that a null pointer is ignored, in every mode. It is the
     runtime's own answer to a value that is nothing rather than a check the
     program makes of itself: a program releases a name when it goes out of
     scope, and a name whose value is nothing is a program that never made one,
     not a program that has to be told. Dropping this reads the header of a
     null pointer, which is a fault on the first release of a value that was
     never built. */
  if (pointer == NULL) return;
  /* A block of an open region is not recycled on its own. A block put on the
     released list of its class would be handed out again by the slab path
     while the region is rewound over the same memory, and two blocks would be
     live in one piece of it. The rewind takes the whole region instead, which
     is what the region exists for and what every block in it is there for. */
  if (blaze_rt_region_depth > 0) {
    /* The block is not recycled while the region is open — the rewind takes the
       whole region — but its count is still a count. Another holder of this block
       is not going away because this one released it, and a count that reads as
       nothing while two holders still hold it is what sends the *next* release
       down the recycling path for a block that is live: the class hands the same
       address out and two values are then one piece of memory. */
    blaze_rt_header* open = blaze_rt_header_of(pointer);
    if (open->references > 0) open->references -= 1;
    return;
  }
  blaze_rt_header* header = blaze_rt_header_of(pointer);
  if (header->references > 1) {
    header->references -= 1;
    return;
  }
  if (header->base == NULL) {
    /* A block that came from a slab goes back onto the list of its own class
       rather than to the host, which is the whole of what the slab is for. The
       class is the size the block occupies, and its capacity and its alignment
       are the two that size is made of, so a block is put back on the class it
       was taken off: capacity and alignment do not change under a live block,
       because the block that grows into a new capacity is a new block. The magic
       is poisoned here as it is on the path below, because this block is dead
       too: a block that keeps it reads as live to every check, which is the one
       the release of a pooled block is most often missed by — a second release
       links it to itself and the class hands the same address out forever. The
       slab takes it back without looking at the magic (blaze_rt_block writes
       every header field afresh), so a poisoned entry is revalidated on the way
       out. */
    const size_t cls = blaze_rt_class_of(header->capacity + header->alignment + BLAZE_RT_HEADER_SIZE, header->alignment);
    if (cls != 0) {
      header->base = (void*)blaze_rt_released[cls - 1];
      blaze_rt_released[cls - 1] = header;
${guarded ? "      header->magic = 0;" : ""}
      return;
    }
  }
${guarded ? "  header->magic = 0;" : ""}
  free(header->base);
}

const char* blaze_rt_string_new(const unsigned char* bytes, size_t length) {
  /* The whole payload is written below, terminator included, so the block is
     not cleared first. */
  char* text = (char*)blaze_rt_allocate_uninitialized(length + 1);
  if (length > 0) memcpy(text, bytes, length);
  text[length] = '\\0';
  return text;
}

/* The length of a string, in O(1) where the runtime allocated it and by
   scanning where the compiler wrote it out as a C literal.

   A managed string carries its length in the header 48 bytes in front of it, so
   reading it is two loads. A literal has no header, and what sits in front of
   one is whatever else the read-only section holds, so the magic word is what
   tells the two apart. That check reads 8 bytes before the pointer, which is
   inside the block for a managed string and inside the section for a literal;
   a pointer that is neither is not a string this runtime handed out. */
size_t blaze_rt_text_length(const char* text) {
  if (text == NULL) return 0;
  const blaze_rt_header* header = (const blaze_rt_header*)((const char*)text - BLAZE_RT_HEADER_SIZE);
  if (header->magic == BLAZE_RT_MAGIC) return header->length - 1;
  return strlen(text);
}

size_t blaze_rt_string_length(const char* text) {
${guarded ? "  if (text == NULL) return 0;" : ""}
  return blaze_rt_header_of((void*)text)->length - 1;
}

const char* blaze_rt_string_clone(const char* text) {
  return blaze_rt_string_new((const unsigned char*)text, blaze_rt_string_length(text));
}

const char* blaze_rt_string_append(const char* left, const char* right) {
  if (left == NULL) return right == NULL ? blaze_rt_string_new(NULL, 0) : blaze_rt_string_new((const unsigned char*)right, blaze_rt_text_length(right));
  if (right == NULL) return blaze_rt_string_new((const unsigned char*)left, blaze_rt_text_length(left));
  const size_t left_length = blaze_rt_text_length(left);
  const size_t right_length = blaze_rt_text_length(right);
  const size_t wanted = left_length + right_length + 1;
  /* The result is always a block of its own. The left string is a value the
     program may still be holding, and the runtime cannot tell whether it is:
     a text value is never retained and never released, so every text block's
     count is permanently one, and a count of one says only that this call is
     the first to have reached it — never that nothing else is looking at it.
     Writing into the block when the count is one is how a program that joined
     two literals into "x" + "y" and then interpolated that name with a "!" at
     the end printed the longer string for the name: the append landed in the
     bytes of a string two names were pointing at, and every later append to
     either of them rewrote the other.

     The room is still grown geometrically, so a string built in a loop copies
     its bytes a linear number of times rather than a quadratic one. */
  const size_t room = left_length * 2 + 16;
  char* joined = (char*)blaze_rt_allocate_uninitialized(wanted < room ? room : wanted);
  memcpy(joined, left, left_length);
  /* The right side is copied before anything is handed back, and a right side
     that is the left one is read out of the copy just made rather than out of
     the block being released. */
  memcpy(joined + left_length, right == left ? joined : right, right_length);
  blaze_rt_header_of(joined)->length = wanted;
  joined[left_length + right_length] = '\\0';
  return joined;
}

void* blaze_rt_array_new(size_t count, size_t elementSize) {
  /* Cleared, and deliberately so. A program is allowed to read past what it
     filled: a while loop over an array runs until the read comes back
     false, and a cleared block is what makes that read false rather than
     whatever the allocator handed back. The source language answers the same
     read as nothing, so zeroing is what agrees with it, and there is no bounds
     check to answer it with: the IR holds no length for an element access. */
  return blaze_rt_allocate(blaze_rt_array_bytes(count, elementSize${guarded ? ', "blaze_rt_array_new"' : ""}));
}

void* blaze_rt_array_resize(void* pointer, size_t count, size_t elementSize) {
  return blaze_rt_reallocate(pointer, blaze_rt_array_bytes(count, elementSize${guarded ? ', "blaze_rt_array_resize"' : ""}));
}

void* blaze_rt_object_new(size_t bytes, size_t alignment) {
  /* Cleared for the same reason an array is: a program may read a field it
     never wrote, and a zeroed block is what answers that read the way the
     source language does. */
  return blaze_rt_block(bytes, alignment, 1);
}

size_t blaze_rt_object_size(void* pointer) {
${guarded ? "  if (pointer == NULL) return 0;" : ""}
  return blaze_rt_header_of(pointer)->length;
}

static const double* blaze_rt_arguments = NULL;
static size_t blaze_rt_argument_count = 0;

void blaze_rt_arguments_set(const double* values, size_t count) {
  blaze_rt_arguments = values;
  blaze_rt_argument_count = count;
}

size_t blaze_rt_argv_count(void) {
  /* The length process.argv has: the program, the file it runs, and the
     arguments it was given. blaze_rt_argv counts from the same place, so the
     two have to agree on where the first argument is. */
  return blaze_rt_argument_count + 2;
}

double blaze_rt_argv(size_t index) {
  /* The index is the one process.argv uses: 0 is where the program runs, 1 is
     the file it runs, and 2 is the first argument it was given. Both the two
     entries the host does not hold arguments for and the read past the end of
     the array are settled here in every mode, because the index is the
     runtime's own arithmetic rather than a check a program makes of itself:
     the ABI promises NaN for an index that names no argument, and a danger
     build leaves out the checks a program makes of itself, not this. Without
     it a program that reads an argument it was not given reads a pointer
     before the array, or off the end of a VLA the host sized for the
     arguments that exist.

     NaN is the answer because the source reads it as one: process.argv holds
     strings, and the two entries before the arguments are the path the
     program runs and the file it runs, neither of which is a number. Reading
     an argument the program was not given is +undefined, and a zero there
     would be a value the source never wrote. */
  if (index < 2) return NAN;
  const size_t argument = index - 2;
  if (blaze_rt_arguments == NULL || argument >= blaze_rt_argument_count) return NAN;
  return blaze_rt_arguments[argument];
}

void blaze_rt_print_text(const char* text) {
${guarded ? "  if (text == NULL) return;" : ""}
  /* fputs rather than a write of a known length: a caller may hand this a
     buffer of its own rather than a string the runtime allocated, and reading
     the header in front of one of those is reading memory that is not there.
     blaze_rt_text_length is for a value the compiler knows is a string. */
  fputs(text, stdout);
}

void blaze_rt_print_text_n(const char* text, size_t length) {
${guarded ? "  if (text == NULL) return;" : ""}
  /* fwrite rather than a write: the output is buffered, so a template written
     a part at a time is still written out once. The count is the length rather
     than what fputs would find, which is the work this entry exists to save. */
  fwrite(text, 1, length, stdout);
}

/* Copies the bytes of a number that fit, NUL terminated, and reports how many
   were written. The length the ABI promises is the number of bytes written,
   so a caller that sizes or walks its buffer by it never steps past the end
   of the buffer it was given. */
static size_t blaze_rt_write_number(const char* text, size_t length, unsigned char* buffer, size_t size) {
  /* A buffer of nothing holds nothing. The subtraction below underflows at
     size 0, so the case is settled before it rather than by a guard a danger
     build leaves out: the ABI promises 0 for a size of 0 in every mode, and
     the subtraction is the runtime's own arithmetic rather than a check the
     program makes of itself. */
  if (size == 0) return 0;
  const size_t written = length < size - 1 ? length : size - 1;
  memcpy(buffer, text, written);
  buffer[written] = '\\0';
  return written;
}

size_t blaze_rt_format_number(double value, unsigned char* buffer, size_t size) {
  /* The shortest decimal that reads back as this value, placed the way the
     source language places it: in full from 1e-6 up to 1e21, and in exponential
     form outside that range. The program this build delivers is compared
     against the source, so both have to write a number the same way. A value
     that is not finite has no shortest decimal, so the language writes those as
     Infinity, -Infinity and NaN. A zero of either sign is written as 0: the
     language writes a negative zero the same way it writes a positive one, and
     only a test for the sign of a zero can tell them apart. */
  const char* fixed = NULL;
  if (isnan(value)) fixed = "NaN";
  else if (isinf(value)) fixed = signbit(value) ? "-Infinity" : "Infinity";
  else if (value == 0.0) fixed = "0";
  if (fixed != NULL) {
    return blaze_rt_write_number(fixed, strlen(fixed), buffer, size);
  }
  const int negative = signbit(value);
  const double magnitude = negative ? -value : value;
  /* A whole number below 2^53 is written as its own digits, with no search and
     no probe.

     The search below finds the shortest decimal that reads back as this value.
     Below 2^53 that shortest decimal is the number itself: every integer in
     that range is exactly representable, and no other integer rounds to it,
     because doubles are at most one apart there and the half-step between two
     of them is under one. So the digits the search goes on to write are the
     digits of the integer, and the search found nothing a shorter form did not.

     The bound is load-bearing and is the reason this is not simply "any whole
     number". Past 2^53 a double no longer holds the integer it was given, and
     the shortest form that reads back is a shorter decimal of the number the
     double really holds — which is what the search is for, and what writing the
     integer's own digits would not be. */
  if (magnitude < 9007199254740992.0 && magnitude == (double)(long long)magnitude) {
    unsigned long long whole = (unsigned long long)magnitude;
    char written[24];
    int used = 0;
    if (negative) written[used++] = '-';
    do {
      written[used++] = (char)('0' + (int)(whole % 10ULL));
      whole /= 10ULL;
    } while (whole != 0ULL && used < (int)sizeof written);
    for (int left = 0, right = used - (negative ? 1 : 0) - 1; left < right; left += 1, right -= 1) {
      const char swap = written[negative ? left + 1 : left];
      written[negative ? left + 1 : left] = written[negative ? right + 1 : right];
      written[negative ? right + 1 : right] = swap;
    }
    written[used] = '\\0';
    return blaze_rt_write_number(written, (size_t)used, buffer, size);
  }
  /* The shortest decimal that reads back as this value.

     The obvious search for it starts at no digits and adds one at a time, and
     every step is a snprintf followed by a strtod: a number that needs three
     digits costs three of each, one that needs seventeen costs seventeen, and
     both are locale-aware libc calls. Printing a number runs this.

     Whether a given number of digits reads back is monotone in the number of
     digits. A form with more digits is the same value written with more of it
     said, so once one reads back every longer one does too, and the shortest
     form is therefore the first precision that reads back — a boundary, which
     is what a binary search is for. Five or so probes find it instead of
     seventeen, and the answer is the same one the walk found because it is the
     same number rather than a differently rounded one.

     Seventeen digits always read back, since that is the whole of a double, so
     the search has an upper end that is known to hold. */
  char text[40];
  int low = 0;
  int high = 16;
  while (low < high) {
    const int middle = (low + high) / 2;
    snprintf(text, sizeof text, "%.*e", middle, magnitude);
    if (strtod(text, NULL) == magnitude) high = middle;
    else low = middle + 1;
  }
  snprintf(text, sizeof text, "%.*e", low, magnitude);

  /* text is d.dddde[+-]XX: the digits, and where the decimal point belongs. */
  char digits[24];
  int count = 0;
  int exponent = 0;
  for (int index = 0; text[index] != '\\0'; index += 1) {
    if (text[index] == 'e') { exponent = atoi(text + index + 1); break; }
    if (text[index] == '.') continue;
    digits[count++] = text[index];
  }
  digits[count] = '\\0';
  const int point = exponent + 1;


  /* The three shapes a number takes, each written byte by byte. Formatting
     two characters, a digit string and a small integer through snprintf is a
     locale-aware libc call each, and this runs for every number a program
     prints. */
  char written[64];
  int used = 0;
  if (negative) written[used++] = '-';
  if (point >= -5 && point <= 21) {
    if (point <= 0) {
      written[used++] = '0';
      written[used++] = '.';
      for (int index = 0; index < -point; index += 1) written[used++] = '0';
      memcpy(written + used, digits, (size_t)count);
      used += count;
    } else if (point >= count) {
      memcpy(written + used, digits, (size_t)count);
      used += count;
      for (int index = 0; index < point - count; index += 1) written[used++] = '0';
    } else {
      memcpy(written + used, digits, (size_t)point);
      used += point;
      written[used++] = '.';
      memcpy(written + used, digits + point, (size_t)(count - point));
      used += count - point;
    }
    written[used] = '\\0';
  } else {
    written[used++] = digits[0];
    if (count > 1) {
      written[used++] = '.';
      memcpy(written + used, digits + 1, (size_t)(count - 1));
      used += count - 1;
    }
    written[used++] = 'e';
    int scale = point - 1;
    if (scale < 0) {
      written[used++] = '-';
      scale = -scale;
    } else {
      written[used++] = '+';
    }
    /* The digits of the exponent, with no leading zero: the language writes
       1e-7 and not 1e-07, and three digits is the most a double needs. */
    char scale_text[4];
    int scale_count = 0;
    do {
      scale_text[scale_count++] = (char)('0' + scale % 10);
      scale /= 10;
    } while (scale > 0);
    while (scale_count > 0) written[used++] = scale_text[--scale_count];
    written[used] = '\\0';
  }

  return blaze_rt_write_number(written, (size_t)used, buffer, size);
}

/* Whether "value", written at "digits" digits after the point, is a tie the C
   library breaks downwards — that is, one whose even neighbour is the smaller
   of the two and so has to be written the other way round.

   See the note above the caller for the derivation: a tie at "f" digits is a
   value "m * 2^e" whose twos are exactly "-(e + f + 1)" of them, and it breaks
   downwards exactly when "(m / 2^d) * 5^f" is one more than a multiple of
   four. */
static int blaze_fixed_breaks_down(double value, int digits) {
  if (value == 0.0 || !isfinite(value)) return 0;
  int exponent = 0;
  /* The magnitude, because a tie is written away from zero and the two numbers
     it stands between are the same whichever side of it the value is on. A
     negative double has a negative mantissa, and reading one as an unsigned
     whole number is not a number at all. */
  const double fraction = frexp(fabs(value), &exponent);
  /* "value" as a whole number times a power of two: the mantissa is exact at
     53 bits, which is every bit a double carries. */
  uint64_t mantissa = (uint64_t)ldexp(fraction, 53);
  const int twos = -(exponent - 53 + digits + 1);
  if (twos < 0) return 0;
  uint64_t whole = mantissa;
  for (int at = 0; at < twos; at += 1) {
    if (whole % 2 != 0) return 0;
    whole /= 2;
  }
  /* "5^digits" is one more than a multiple of four however large it is, so the
     residue of "(mantissa / 2^d) * 5^digits" is the residue of the quotient. */
  return whole % 4 == 1;
}

size_t blaze_rt_format_number_fixed(double value, int digits, unsigned char* buffer, size_t size) {
  /* What x.toFixed(d) writes: the same digits every time, rounded at the last of
     them, and never the exponent form the shortest writing falls back on. A
     value that is not finite, and one of a million million million and over, is
     written as the language writes it rather than at the digits asked for:
     (1e21).toFixed(2) is 1e+21 and not the twenty two digits that follow the
     point, and what follows the point of a value that is not a number is
     nothing at all. */
  if (isnan(value) || isinf(value) || fabs(value) >= 1e21) {
    return blaze_rt_format_number(value, buffer, size);
  }
  char text[512];
  const int wanted = digits < 0 ? 0 : (digits > 400 ? 400 : digits);
  int written = snprintf(text, sizeof text, "%.*f", wanted, value);
  if (written < 0) return blaze_rt_format_number(NAN, buffer, size);
  /* A tie is written away from zero and the C library breaks one to even, so
     "(2.5).toFixed(0)" is 3 and "(0.5).toFixed(0)" is 1 where "%.*f" writes 2
     and 0 — and "(3.5).toFixed(0)" is 4 where both write 4. A program that
     prints a number at a fixed number of digits prints what its source
     prints, so the break is corrected here rather than left to the library.

     A tie is decided on the exact value rather than on the digits, because the
     digits cannot tell one: "1.005" is written "1.005" at three digits by a
     library rounding it correctly, and it is not a tie, because the double
     under it is a hair below 1.005.

     Write the value as "m * 2^e", which every double can be written as with
     "m" a whole number. It is a tie at "f" digits exactly when
     "m * 5^f * 2^(e + f + 1)" is an odd whole number — which it can only be
     when "e + f + 1" is negative, and then only when the twos in "m" are
     exactly as many as cancel them. That test is "blaze_fixed_breaks_down".

     Of the two numbers a tie stands between, the library wrote the even one.
     Away from zero is the other one exactly when the even one is the smaller,
     which is when "(m / 2^d) * 5^f" is one more than a multiple of four —
     "5^f" being one more than a multiple of four however large "f" is. */
  if (blaze_fixed_breaks_down(value, wanted)) {
    int at = 0;
    while (at < written && text[written - 1 - at] == '9') {
      text[written - 1 - at] = '0';
      at += 1;
    }
    if (at == written) {
      /* Every digit was a nine, so the value grew by a whole digit. */
      memmove(text + 1, text, (size_t)written);
      text[0] = '1';
      written += 1;
    } else {
      text[written - 1 - at] = (char)(text[written - 1 - at] + 1);
    }
  }
  /* A number that needs more of the buffer than it has is written at the width
     of the buffer rather than past the end of it. */
  const size_t used = (size_t)written > size - 1 ? size - 1 : (size_t)written;
  /* The sign of a zero is not written, and only a value that is one has none to
     write: (-0).toFixed(9) is 0.000000000, while -0.004 at two digits is -0.00
     in the language as well. */
  if (used > 0 && text[0] == '-' && value == 0.0) {
    memmove(text, text + 1, used - 1);
    return blaze_rt_write_number(text, used - 1, buffer, size);
  }
  return blaze_rt_write_number(text, used, buffer, size);
}

void blaze_rt_print_number(double value) {
  char text[64];
  /* A program prints a number the way the host it was written for prints it,
     and that host writes a negative zero with its sign. Only an interpolation
     reads one as the plain zero the language makes of it, which is what
     blaze_rt_format_number answers and what this would answer without this. */
  if (value == 0.0 && signbit(value)) {
    fwrite("-0", 1, 2, stdout);
    return;
  }
  const size_t written = blaze_rt_format_number(value, (unsigned char*)text, sizeof text);
  fwrite(text, 1, written, stdout);
}

void blaze_rt_print_whole(long long value, int bigint) {
  /* A whole number above 2^53 is not a number a double holds, so handing one to
     the formatter above answers a different number than the program wrote: a
     bigint literal of 9007199254740993 printed as 9007199254740992. The digits
     are therefore written from the integer itself. The magnitude is taken
     unsigned because the most negative value negates to itself as a signed one
     and its digits would then never come out. The n of a bigint is the word the
     language prints after the digits, and it is written here rather than by the
     backend because the backend has no way to write one character. */
  char digits[20];
  int count = 0;
  unsigned long long magnitude = value < 0 ? 0ULL - (unsigned long long)value : (unsigned long long)value;
  do {
    digits[count++] = (char)('0' + (int)(magnitude % 10));
    magnitude /= 10;
  } while (magnitude > 0);
  if (value < 0) fputc('-', stdout);
  while (count > 0) fputc(digits[--count], stdout);
  if (bigint) fputc('n', stdout);
}
void blaze_rt_print_newline(void) {
  fputc('\\n', stdout);
  fflush(stdout);
}

/* Prints one 64 bit limb as eight lowercase hex digits, most significant
   nibble first. Used to print a u256 in hex, limb by limb from the top down. */
void blaze_rt_print_hex_u64(uint64_t value) {
  static const char hex[] = "0123456789abcdef";
  for (int i = 28; i >= 0; i -= 4) {
    fputc(hex[(value >> i) & 0xfu], stdout);
  }
}

void blaze_rt_raise(const char* message) {
  blaze_rt_last_message = message == NULL ? "" : message;
  fprintf(stderr, "blaze: %s\\n", blaze_rt_last_message);
  exit(2);
}

const char* blaze_rt_last_error(void) {
  return blaze_rt_last_message;
}

/* Dynamic value representation. */
typedef enum { BLAZE_DYN_NULL, BLAZE_DYN_NUMBER, BLAZE_DYN_BOOL, BLAZE_DYN_TEXT, BLAZE_DYN_ARRAY, BLAZE_DYN_OBJECT, BLAZE_DYN_HASHER } blaze_dyn_kind;
typedef struct blaze_dyn {
  blaze_dyn_kind kind;
  double number;
  char* text;
  void* items;
  size_t count;
  size_t capacity;
} blaze_dyn;

static void** blaze_dyn_reg = NULL;
static size_t blaze_dyn_reg_n = 0;
static size_t blaze_dyn_reg_cap = 0;

static double blaze_dyn_register(void* p) {
  if (blaze_dyn_reg_n == blaze_dyn_reg_cap) {
    blaze_dyn_reg_cap = blaze_dyn_reg_cap ? blaze_dyn_reg_cap * 2 : 64;
    blaze_dyn_reg = realloc(blaze_dyn_reg, blaze_dyn_reg_cap * sizeof(void*));
  }
  blaze_dyn_reg[blaze_dyn_reg_n] = p;
  return (double)(blaze_dyn_reg_n++);
}
static blaze_dyn* blaze_dyn_lookup(double h) {
  size_t i = (size_t)h;
  if (i >= blaze_dyn_reg_n) return NULL;
  return (blaze_dyn*)blaze_dyn_reg[i];
}

static blaze_dyn* blaze_dyn_new(blaze_dyn_kind k) {
  blaze_dyn* d = calloc(1, sizeof(blaze_dyn));
  d->kind = k;
  return d;
}

static char* blaze_dyn_strdup(const char* s) {
  if (!s) return NULL;
  size_t n = strlen(s);
  char* r = malloc(n + 1);
  memcpy(r, s, n + 1);
  return r;
}

double blaze_rt_box_number(double value) {
  blaze_dyn* d = blaze_dyn_new(BLAZE_DYN_NUMBER);
  d->number = value;
  return blaze_dyn_register(d);
}
double blaze_rt_box_string(const char* value) {
  blaze_dyn* d = blaze_dyn_new(BLAZE_DYN_TEXT);
  d->text = blaze_dyn_strdup(value);
  return blaze_dyn_register(d);
}
double blaze_rt_box_null(void) {
  blaze_dyn* d = blaze_dyn_new(BLAZE_DYN_NULL);
  return blaze_dyn_register(d);
}
double blaze_rt_to_number(double value) {
  blaze_dyn* d = blaze_dyn_lookup(value);
  if (!d) return value;
  if (d->kind == BLAZE_DYN_NUMBER || d->kind == BLAZE_DYN_BOOL) return d->number;
  if (d->kind == BLAZE_DYN_TEXT && d->text) return atof(d->text);
  return value;
}
const char* blaze_rt_to_text(double value) {
  blaze_dyn* d = blaze_dyn_lookup(value);
  if (!d) {
    static char buf[64];
    snprintf(buf, 64, "%.17g", value);
    return blaze_dyn_strdup(buf);
  }
  if (d->kind == BLAZE_DYN_NUMBER) {
    char* buf = malloc(64);
    snprintf(buf, 64, "%.17g", d->number);
    return buf;
  }
  if (d->kind == BLAZE_DYN_BOOL) return d->number ? "true" : "false";
  if (d->kind == BLAZE_DYN_TEXT) return d->text ? d->text : "";
  if (d->kind == BLAZE_DYN_NULL) return "null";
  if (d->kind == BLAZE_DYN_ARRAY) {
    size_t cap = 64, len = 0;
    char* out = malloc(cap);
    out[len++] = '[';
    for (size_t i = 0; i < d->count; i++) {
      if (i) { if (len + 2 >= cap) { cap *= 2; out = realloc(out, cap); } out[len++] = ','; }
      double h = ((double*)d->items)[i];
      const char* t = blaze_rt_to_text(h);
      blaze_dyn* id = blaze_dyn_lookup(h);
      int isText = id && id->kind == BLAZE_DYN_TEXT;
      size_t tl = strlen(t);
      size_t need = tl + (isText?2:0) + 1;
      if (len + need >= cap) { cap = cap*2 + need; out = realloc(out, cap); }
      if (isText) out[len++] = '"';
      memcpy(out + len, t, tl); len += tl;
      if (isText) out[len++] = '"';
    }
    if (len + 2 >= cap) { cap += 2; out = realloc(out, cap); }
    out[len++] = ']';
    out[len] = 0;
    return out;
  }
  if (d->kind == BLAZE_DYN_OBJECT) {
    double s = blaze_rt_json_stringify(value);
    blaze_dyn* sd = blaze_dyn_lookup(s);
    return sd && sd->text ? sd->text : "{}";
  }
  return "null";
}

double blaze_rt_dyn_array_new(void) {
  blaze_dyn* d = blaze_dyn_new(BLAZE_DYN_ARRAY);
  d->items = NULL;
  d->count = 0;
  d->capacity = 0;
  return blaze_dyn_register(d);
}
double blaze_rt_array_push(double array, double value) {
  blaze_dyn* d = blaze_dyn_lookup(array);
  if (!d || d->kind != BLAZE_DYN_ARRAY) {
    d = blaze_dyn_new(BLAZE_DYN_ARRAY);
    array = blaze_dyn_register(d);
  }
  if (d->count == d->capacity) {
    d->capacity = d->capacity ? d->capacity * 2 : 8;
    d->items = realloc(d->items, d->capacity * sizeof(double));
  }
  ((double*)d->items)[d->count++] = value;
  return array;
}
double blaze_rt_array_get(double array, double index) {
  blaze_dyn* d = blaze_dyn_lookup(array);
  if (!d || d->kind != BLAZE_DYN_ARRAY) return 0.0;
  size_t i = (size_t)index;
  if (i >= d->count) return 0.0;
  return ((double*)d->items)[i];
}
void blaze_rt_array_set(double array, double index, double value) {
  blaze_dyn* d = blaze_dyn_lookup(array);
  if (!d || d->kind != BLAZE_DYN_ARRAY) return;
  size_t i = (size_t)index;
  if (i >= d->count) return;
  ((double*)d->items)[i] = value;
}

double blaze_rt_file_read(const char* path, const char* mode) {
  FILE* f = fopen(path, "r");
  if (!f) { blaze_rt_raise("file not found"); return 0.0; }
  fseek(f, 0, SEEK_END);
  long sz = ftell(f);
  fseek(f, 0, SEEK_SET);
  char* buf = malloc(sz + 1);
  fread(buf, 1, sz, f);
  buf[sz] = 0;
  fclose(f);
  return blaze_rt_box_string(buf);
}

static void json_skip_ws(const char** p) { while (**p==' '||**p=='\\t'||**p=='\\n'||**p=='\\r') (*p)++; }

static void json_append_utf8(char** out, size_t* len, size_t* cap, unsigned int cp) {
  char buf[4]; int n;
  if (cp < 0x80) { buf[0]=(char)cp; n=1; }
  else if (cp < 0x800) { buf[0]=(char)(0xC0|(cp>>6)); buf[1]=(char)(0x80|(cp&0x3F)); n=2; }
  else { buf[0]=(char)(0xE0|(cp>>12)); buf[1]=(char)(0x80|((cp>>6)&0x3F)); buf[2]=(char)(0x80|(cp&0x3F)); n=3; }
  for (int i=0;i<n;i++){ if (*len+2>=*cap){ *cap = *cap ? *cap*2 : 64; *out=realloc(*out,*cap);} (*out)[(*len)++]=buf[i]; }
}

static char* json_parse_string(const char** p) {
  if (**p != '"') return NULL;
  (*p)++;
  size_t cap=64,len=0;
  char* out=malloc(cap);
  while (**p && **p != '"') {
    if (**p == '\\\\') {
      (*p)++;
      if (**p == '"') { if (len+2>=cap){cap*=2;out=realloc(out,cap);} out[len++]='"'; (*p)++; }
      else if (**p == '\\\\') { if (len+2>=cap){cap*=2;out=realloc(out,cap);} out[len++]='\\\\'; (*p)++; }
      else if (**p == '/') { if (len+2>=cap){cap*=2;out=realloc(out,cap);} out[len++]='/'; (*p)++; }
      else if (**p == 'b') { if (len+2>=cap){cap*=2;out=realloc(out,cap);} out[len++]='\\b'; (*p)++; }
      else if (**p == 'f') { if (len+2>=cap){cap*=2;out=realloc(out,cap);} out[len++]='\\f'; (*p)++; }
      else if (**p == 'n') { if (len+2>=cap){cap*=2;out=realloc(out,cap);} out[len++]='\\n'; (*p)++; }
      else if (**p == 'r') { if (len+2>=cap){cap*=2;out=realloc(out,cap);} out[len++]='\\r'; (*p)++; }
      else if (**p == 't') { if (len+2>=cap){cap*=2;out=realloc(out,cap);} out[len++]='\\t'; (*p)++; }
      else if (**p == 'u') {
        (*p)++;
        unsigned int cp=0;
        for (int i=0;i<4;i++) {
          if (!**p) { free(out); return NULL; }
          char h=**p; int v;
          if (h>='0'&&h<='9') v=h-'0';
          else if (h>='a'&&h<='f') v=h-'a'+10;
          else if (h>='A'&&h<='F') v=h-'A'+10;
          else { free(out); return NULL; }
          cp=cp*16+v;
          (*p)++;
        }
        json_append_utf8(&out,&len,&cap,cp);
      } else { free(out); return NULL; }
    } else {
      if (len+2>=cap){cap*=2;out=realloc(out,cap);}
      out[len++]=**p;
      (*p)++;
    }
  }
  if (**p != '"') { free(out); return NULL; }
  (*p)++;
  out[len]=0;
  return out;
}

static int json_parse_value(const char** p, double* out);

static int json_parse_array(const char** p, double* out) {
  if (**p != '[') return 0;
  (*p)++;
  json_skip_ws(p);
  double arr = blaze_rt_dyn_array_new();
  if (**p == ']') { (*p)++; *out = arr; return 1; }
  while (1) {
    double v;
    if (!json_parse_value(p, &v)) return 0;
    blaze_rt_array_push(arr, v);
    json_skip_ws(p);
    if (**p == ',') { (*p)++; json_skip_ws(p); continue; }
    if (**p == ']') { (*p)++; break; }
    return 0;
  }
  *out = arr;
  return 1;
}

static int json_parse_object(const char** p, double* out) {
  if (**p != '{') return 0;
  (*p)++;
  json_skip_ws(p);
  blaze_dyn* od = blaze_dyn_new(BLAZE_DYN_OBJECT);
  double oh = blaze_dyn_register(od);
  if (**p == '}') { (*p)++; *out = oh; return 1; }
  while (1) {
    if (**p != '"') return 0;
    char* keystr = json_parse_string(p);
    if (!keystr) return 0;
    json_skip_ws(p);
    if (**p != ':') { free(keystr); return 0; }
    (*p)++;
    json_skip_ws(p);
    double val;
    if (!json_parse_value(p, &val)) { free(keystr); return 0; }
    if (od->count == od->capacity) {
      od->capacity = od->capacity ? od->capacity * 2 : 8;
      od->items = realloc(od->items, od->capacity * 2 * sizeof(double));
    }
    ((double*)od->items)[od->count*2] = blaze_rt_box_string(keystr);
    ((double*)od->items)[od->count*2+1] = val;
    od->count++;
    free(keystr);
    json_skip_ws(p);
    if (**p == ',') { (*p)++; json_skip_ws(p); continue; }
    if (**p == '}') { (*p)++; break; }
    return 0;
  }
  *out = oh;
  return 1;
}

static int json_parse_value(const char** p, double* out) {
  json_skip_ws(p);
  if (**p == '"') {
    char* s = json_parse_string(p);
    if (!s) return 0;
    *out = blaze_rt_box_string(s);
    free(s);
    return 1;
  }
  if (**p == '[') return json_parse_array(p, out);
  if (**p == '{') return json_parse_object(p, out);
  if (strncmp(*p, "true", 4) == 0) { *p += 4; blaze_dyn* _db = blaze_dyn_new(BLAZE_DYN_BOOL); _db->number = 1.0; *out = blaze_dyn_register(_db); return 1; }
  if (strncmp(*p, "false", 5) == 0) { *p += 5; blaze_dyn* _db = blaze_dyn_new(BLAZE_DYN_BOOL); _db->number = 0.0; *out = blaze_dyn_register(_db); return 1; }
  if (strncmp(*p, "null", 4) == 0) { *p += 4; *out = blaze_rt_box_null(); return 1; }
  char* end = NULL;
  double v = strtod(*p, &end);
  if (end == *p) return 0;
  *p = end;
  *out = blaze_rt_box_number(v);
  return 1;
}

double blaze_rt_json_parse(double text) {
  const char* t = blaze_rt_to_text(text);
  if (!t) { blaze_rt_raise("invalid JSON"); return blaze_rt_box_null(); }
  const char* p = t;
  double out;
  if (!json_parse_value(&p, &out)) { blaze_rt_raise("invalid JSON"); return blaze_rt_box_null(); }
  json_skip_ws(&p);
  if (*p != '\\0') { blaze_rt_raise("trailing JSON"); return blaze_rt_box_null(); }
  return out;
}

static char* blaze_dyn_stringify(blaze_dyn* d);

static char* blaze_dyn_stringify_value(double value) {
  blaze_dyn* d = blaze_dyn_lookup(value);
  if (!d) {
    char* buf = malloc(64); size_t n = blaze_rt_format_number(value, (unsigned char*)buf, 64); buf[n]=0; return buf;
  }
  if (d->kind == BLAZE_DYN_BOOL) return blaze_dyn_strdup(d->number ? "true" : "false");
  if (d->kind == BLAZE_DYN_TEXT) return blaze_dyn_strdup(d->text ? d->text : "");
  if (d->kind == BLAZE_DYN_NUMBER) { char* buf=malloc(64); size_t n = blaze_rt_format_number(d->number, (unsigned char*)buf, 64); buf[n]=0; return buf; }
  if (d->kind == BLAZE_DYN_NULL) return blaze_dyn_strdup("null");
  if (d->kind == BLAZE_DYN_ARRAY || d->kind == BLAZE_DYN_OBJECT) return blaze_dyn_stringify(d);
  return blaze_dyn_strdup("null");
}

static char* blaze_dyn_stringify(blaze_dyn* d) {
  if (d->kind == BLAZE_DYN_ARRAY) {
    size_t cap = 64, len = 0;
    char* out = malloc(cap);
    out[len++] = '[';
    for (size_t i = 0; i < d->count; i++) {
      if (i) { if (len + 2 >= cap) { cap *= 2; out = realloc(out, cap); } out[len++] = ','; }
      double h = ((double*)d->items)[i];
      char* t = blaze_dyn_stringify_value(h);
      blaze_dyn* id = blaze_dyn_lookup(h);
      int isText = id && id->kind == BLAZE_DYN_TEXT;
      size_t tl = strlen(t);
      if (isText) {
        if (len + tl + 4 >= cap) { cap = cap*2 + tl + 4; out = realloc(out, cap); }
        out[len++] = '"';
        memcpy(out+len, t, tl); len += tl;
        out[len++] = '"';
      } else {
        if (len + tl + 1 >= cap) { cap = cap*2 + tl + 1; out = realloc(out, cap); }
        memcpy(out+len, t, tl); len += tl;
      }
      free(t);
    }
    if (len + 2 >= cap) { cap += 2; out = realloc(out, cap); }
    out[len++] = ']';
    out[len] = 0;
    return out;
  }
  if (d->kind == BLAZE_DYN_OBJECT) {
    size_t cap = 64, len = 0;
    char* out = malloc(cap);
    out[len++] = '{';
    for (size_t i = 0; i < d->count; i++) {
      if (i) { if (len + 2 >= cap) { cap *= 2; out = realloc(out, cap); } out[len++] = ','; }
      double kh = ((double*)d->items)[i*2];
      double vh = ((double*)d->items)[i*2+1];
      char* kt = blaze_dyn_stringify_value(kh);
      size_t ktl = strlen(kt);
      /* key must be text; ensure quotes */
      if (len + ktl + 4 >= cap) { cap = cap*2 + ktl + 4; out = realloc(out, cap); }
      out[len++] = '"';
      /* kt already unquoted payload for text? stringify_value for text returns payload without quotes */
      memcpy(out+len, kt, ktl); len += ktl;
      out[len++] = '"';
      free(kt);
      if (len + 2 >= cap) { cap += 2; out = realloc(out, cap); }
      out[len++] = ':';
      blaze_dyn* vid = blaze_dyn_lookup(vh);
      int visText = vid && vid->kind == BLAZE_DYN_TEXT;
      char* vt = blaze_dyn_stringify_value(vh);
      size_t vtl = strlen(vt);
      if (visText) {
        if (len + vtl + 4 >= cap) { cap = cap*2 + vtl + 4; out = realloc(out, cap); }
        out[len++] = '"';
        memcpy(out+len, vt, vtl); len += vtl;
        out[len++] = '"';
      } else {
        if (len + vtl + 1 >= cap) { cap = cap*2 + vtl + 1; out = realloc(out, cap); }
        memcpy(out+len, vt, vtl); len += vtl;
      }
      free(vt);
    }
    if (len + 2 >= cap) { cap += 2; out = realloc(out, cap); }
    out[len++] = '}';
    out[len] = 0;
    return out;
  }
  return blaze_dyn_strdup("null");
}

double blaze_rt_json_stringify(double value) {
  char* s = blaze_dyn_stringify_value(value);
  double h = blaze_rt_box_string(s);
  free(s);
  return h;
}

/* MD5 implementation (RFC 1321). */
typedef struct { unsigned int state[4]; unsigned int count[2]; unsigned char buffer[64]; } blaze_md5_ctx;
static void blaze_md5_transform(unsigned int state[4], const unsigned char block[64]) {
  unsigned int a=state[0],b=state[1],c=state[2],d=state[3],x[16];
  for (int i=0;i<16;i++) x[i]=block[i*4]+(block[i*4+1]<<8)+(block[i*4+2]<<16)+(block[i*4+3]<<24);
  #define F(x,y,z) ((x&y)|(~x&z))
  #define G(x,y,z) ((x&z)|(y&~z))
  #define H(x,y,z) (x^y^z)
  #define I(x,y,z) (y^(x|~z))
  #define ROTATE_LEFT(x,n) ((x<<n)|(x>>(32-n)))
  #define FF(a,b,c,d,x,s,ac) { a+=F(b,c,d)+x+ac; a=ROTATE_LEFT(a,s); a+=b; }
  #define GG(a,b,c,d,x,s,ac) { a+=G(b,c,d)+x+ac; a=ROTATE_LEFT(a,s); a+=b; }
  #define HH(a,b,c,d,x,s,ac) { a+=H(b,c,d)+x+ac; a=ROTATE_LEFT(a,s); a+=b; }
  #define II(a,b,c,d,x,s,ac) { a+=I(b,c,d)+x+ac; a=ROTATE_LEFT(a,s); a+=b; }
  /* Round 1 */
  FF(a,b,c,d,x[0],7,0xd76aa478); FF(d,a,b,c,x[1],12,0xe8c7b756); FF(c,d,a,b,x[2],17,0x242070db); FF(b,c,d,a,x[3],22,0xc1bdceee);
  FF(a,b,c,d,x[4],7,0xf57c0faf); FF(d,a,b,c,x[5],12,0x4787c62a); FF(c,d,a,b,x[6],17,0xa8304613); FF(b,c,d,a,x[7],22,0xfd469501);
  FF(a,b,c,d,x[8],7,0x698098d8); FF(d,a,b,c,x[9],12,0x8b44f7af); FF(c,d,a,b,x[10],17,0xffff5bb1); FF(b,c,d,a,x[11],22,0x895cd7be);
  FF(a,b,c,d,x[12],7,0x6b901122); FF(d,a,b,c,x[13],12,0xfd987193); FF(c,d,a,b,x[14],17,0xa679438e); FF(b,c,d,a,x[15],22,0x49b40821);
  /* Round 2 */
  GG(a,b,c,d,x[1],5,0xf61e2562); GG(d,a,b,c,x[6],9,0xc040b340); GG(c,d,a,b,x[11],14,0x265e5a51); GG(b,c,d,a,x[0],20,0xe9b6c7aa);
  GG(a,b,c,d,x[5],5,0xd62f105d); GG(d,a,b,c,x[10],9,0x02441453); GG(c,d,a,b,x[15],14,0xd8a1e681); GG(b,c,d,a,x[4],20,0xe7d3fbc8);
  GG(a,b,c,d,x[9],5,0x21e1cde6); GG(d,a,b,c,x[14],9,0xc33707d6); GG(c,d,a,b,x[3],14,0xf4d50d87); GG(b,c,d,a,x[8],20,0x455a14ed);
  GG(a,b,c,d,x[13],5,0xa9e3e905); GG(d,a,b,c,x[2],9,0xfcefa3f8); GG(c,d,a,b,x[7],14,0x676f02d9); GG(b,c,d,a,x[12],20,0x8d2a4c8a);
  /* Round 3 */
  HH(a,b,c,d,x[5],4,0xfffa3942); HH(d,a,b,c,x[8],11,0x8771f681); HH(c,d,a,b,x[11],16,0x6d9d6122); HH(b,c,d,a,x[14],23,0xfde5380c);
  HH(a,b,c,d,x[1],4,0xa4beea44); HH(d,a,b,c,x[4],11,0x4bdecfa9); HH(c,d,a,b,x[7],16,0xf6bb4b60); HH(b,c,d,a,x[10],23,0xbebfbc70);
  HH(a,b,c,d,x[13],4,0x289b7ec6); HH(d,a,b,c,x[0],11,0xeaa127fa); HH(c,d,a,b,x[3],16,0xd4ef3085); HH(b,c,d,a,x[6],23,0x04881d05);
  HH(a,b,c,d,x[9],4,0xd9d4d039); HH(d,a,b,c,x[12],11,0xe6db99e5); HH(c,d,a,b,x[15],16,0x1fa27cf8); HH(b,c,d,a,x[2],23,0xc4ac5665);
  /* Round 4 */
  II(a,b,c,d,x[0],6,0xf4292244); II(d,a,b,c,x[7],10,0x432aff97); II(c,d,a,b,x[14],15,0xab9423a7); II(b,c,d,a,x[5],21,0xfc93a039);
  II(a,b,c,d,x[12],6,0x655b59c3); II(d,a,b,c,x[3],10,0x8f0ccc92); II(c,d,a,b,x[10],15,0xffeff47d); II(b,c,d,a,x[1],21,0x85845dd1);
  II(a,b,c,d,x[8],6,0x6fa87e4f); II(d,a,b,c,x[15],10,0xfe2ce6e0); II(c,d,a,b,x[6],15,0xa3014314); II(b,c,d,a,x[13],21,0x4e0811a1);
  II(a,b,c,d,x[4],6,0xf7537e82); II(d,a,b,c,x[11],10,0xbd3af235); II(c,d,a,b,x[2],15,0x2ad7d2bb); II(b,c,d,a,x[9],21,0xeb86d391);
  state[0]+=a; state[1]+=b; state[2]+=c; state[3]+=d;
  #undef F
  #undef G
  #undef H
  #undef I
  #undef ROTATE_LEFT
  #undef FF
  #undef GG
  #undef HH
  #undef II
}
static void blaze_md5_init(blaze_md5_ctx* ctx) {
  ctx->count[0]=ctx->count[1]=0;
  ctx->state[0]=0x67452301; ctx->state[1]=0xefcdab89; ctx->state[2]=0x98badcfe; ctx->state[3]=0x10325476;
}
static void blaze_md5_update(blaze_md5_ctx* ctx, const unsigned char* input, unsigned int len) {
  unsigned int i, index, partLen;
  index = (ctx->count[0] >> 3) & 0x3F;
  if ((ctx->count[0] += (len << 3)) < (len << 3)) ctx->count[1]++;
  ctx->count[1] += (len >> 29);
  partLen = 64 - index;
  if (len >= partLen) {
    memcpy(&ctx->buffer[index], input, partLen);
    blaze_md5_transform(ctx->state, ctx->buffer);
    for (i = partLen; i + 63 < len; i += 64) blaze_md5_transform(ctx->state, &input[i]);
    index = 0;
  } else i = 0;
  memcpy(&ctx->buffer[index], &input[i], len - i);
}
static void blaze_md5_final(unsigned char digest[16], blaze_md5_ctx* ctx) {
  unsigned char bits[8];
  unsigned int index, padLen;
  for (int i=0;i<8;i++) bits[i]=(unsigned char)((ctx->count[i>>2]>>(i&3)*8)&0xFF);
  index=(ctx->count[0]>>3)&0x3F;
  padLen = (index < 56) ? (56 - index) : (120 - index);
  static unsigned char PADDING[64]={0x80};
  blaze_md5_update(ctx, PADDING, padLen);
  blaze_md5_update(ctx, bits, 8);
  for (int i=0;i<16;i++) digest[i]=(unsigned char)((ctx->state[i>>2]>>(i&3)*8)&0xFF);
}
double blaze_rt_md5_create(void) {
  blaze_md5_ctx* ctx = calloc(1, sizeof(blaze_md5_ctx));
  blaze_md5_init(ctx);
  blaze_dyn* d = blaze_dyn_new(BLAZE_DYN_HASHER);
  d->text = (char*)ctx;
  return blaze_dyn_register(d);
}
double blaze_rt_md5_update(double hasher, const char* text) {
  blaze_dyn* d = blaze_dyn_lookup(hasher);
  if (!d || d->kind != BLAZE_DYN_HASHER || !text) return hasher;
  blaze_md5_ctx* ctx = (blaze_md5_ctx*)d->text;
  blaze_md5_update(ctx, (const unsigned char*)text, (unsigned int)strlen(text));
  return hasher;
}
double blaze_rt_md5_digest(double hasher) {
  blaze_dyn* d = blaze_dyn_lookup(hasher);
  if (!d || d->kind != BLAZE_DYN_HASHER) return blaze_rt_box_string("");
  blaze_md5_ctx* ctx = (blaze_md5_ctx*)d->text;
  unsigned char digest[16];
  blaze_md5_final(digest, ctx);
  char* hex = malloc(33);
  for (int i=0;i<16;i++) sprintf(hex+i*2, "%02x", digest[i]);
  hex[32]=0;
  return blaze_rt_box_string(hex);
}

void blaze_error_clear(void);
void blaze_error_set(const char* message);
int blaze_had_error(void);
const char* blaze_last_error(void);

/* Minimal promise implementation. */
typedef struct { int settled; int failed; double value; const char* message; } blaze_promise;
void* blaze_promise_new(void) { blaze_promise* p = malloc(sizeof(blaze_promise)); p->settled = 0; p->failed = 0; p->value = 0.0; p->message = NULL; return p; }
void blaze_promise_resolve(void* promise, double value) { blaze_promise* p = promise; p->settled = 1; p->failed = 0; p->value = value; p->message = NULL; }
void blaze_promise_reject(void* promise, const char* message) { blaze_promise* p = promise; p->settled = 1; p->failed = 1; p->value = 0.0/0.0; p->message = message; blaze_error_set(message); }
double blaze_promise_await(void* promise) { blaze_promise* p = promise; if (p && p->failed) blaze_error_set(p->message); return p ? p->value : 0.0; }
int blaze_promise_failed(void* promise) { blaze_promise* p = promise; return p ? p->failed : 0; }
const char* blaze_promise_message(void* promise) { blaze_promise* p = promise; return p ? p->message : NULL; }
void blaze_promise_set_current(void* promise) { blaze_current_promise = promise; }
void blaze_promise_clear_current(void) { blaze_current_promise = NULL; }
void blaze_promise_resolve_current(double value) { if (blaze_current_promise) blaze_promise_resolve(blaze_current_promise, value); }
void blaze_promise_reject_current(const char* message) { if (blaze_current_promise) blaze_promise_reject(blaze_current_promise, message); }
void *blaze_current_promise = NULL;
static int blaze_error_flag = 0;
static const char* blaze_error_message = NULL;
void blaze_error_clear(void) { blaze_error_flag = 0; blaze_error_message = NULL; }
void blaze_error_set(const char* message) { blaze_error_flag = 1; blaze_error_message = message; }
int blaze_had_error(void) { return blaze_error_flag; }
const char* blaze_last_error(void) { return blaze_error_message; }

${U256_KERNEL}
${I256_KERNEL}
`;
}


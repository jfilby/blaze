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
  entry(
    "blaze_rt_reallocate",
    "void*",
    [
      ["pointer", "void*"],
      ["bytes", "size_t"],
    ],
    "Resizes a managed block, keeping its contents and its reference.",
    "Returns the managed pointer; a null pointer allocates. A block grown within the capacity it already has is returned as it stands, with no copy.",
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
  "void blaze_rt_u256_and(blaze_u256* out, const blaze_u256* left, const blaze_u256* right)",
  "void blaze_rt_u256_or(blaze_u256* out, const blaze_u256* left, const blaze_u256* right)",
  "void blaze_rt_u256_xor(blaze_u256* out, const blaze_u256* left, const blaze_u256* right)",
  "void blaze_rt_u256_not(blaze_u256* out, const blaze_u256* value)",
  "void blaze_rt_u256_shl(blaze_u256* out, const blaze_u256* value, unsigned count)",
  "void blaze_rt_u256_shr(blaze_u256* out, const blaze_u256* value, unsigned count)",
  "int blaze_rt_u256_less(const blaze_u256* left, const blaze_u256* right)",
  "int blaze_rt_u256_equal(const blaze_u256* left, const blaze_u256* right)",
  "void blaze_rt_u256_from_u64(blaze_u256* out, uint64_t value)",
  "uint64_t blaze_rt_u256_to_u64(const blaze_u256* value)",
  "size_t blaze_rt_u256_format(const blaze_u256* value, unsigned base, unsigned char* buffer, size_t size)",
  "void blaze_rt_print_u256(const blaze_u256* value)",
  "void blaze_rt_print_u256_hex(const blaze_u256* value)",
];

/**
 * The wide integer symbols, which generated code may reference alongside the
 * runtime ABI. Kept apart from `RUNTIME_SYMBOLS` because they are the compiler's
 * own arithmetic rather than a service the host provides; see
 * `U256_DECLARATIONS` for why the two are not one list.
 */
export const WIDE_SYMBOLS: Record<string, true> = Object.fromEntries(
  U256_DECLARATIONS.map((declaration) => [
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
  return RUNTIME_SYMBOLS[symbol] === true || WIDE_SYMBOLS[symbol] === true;
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

`;

const HEADER_EPILOGUE = `
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
  return `${HEADER_PREAMBLE}\n${declarations}\n\n${U256_DECLARATIONS.map((declaration) => `${declaration};`).join("\n")}\n${HEADER_EPILOGUE}`;
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

/* Widening zero-extends, because the number is unsigned; narrowing keeps the
   low limb, because a use of a narrow value asks for its low bits and not for
   an error. */
void blaze_rt_u256_from_u64(blaze_u256* out, uint64_t value) {
  *out = blaze_u256_of_u64(value);
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
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

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
static char* blaze_rt_slab_at = NULL;
static char* blaze_rt_slab_end = NULL;
static blaze_rt_header* blaze_rt_released[BLAZE_RT_SLAB_CLASSES];

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

void blaze_rt_initialize(void) {}

void blaze_rt_finalize(void) {}

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
       because the block that grows into a new capacity is a new block. */
    const size_t cls = blaze_rt_class_of(header->capacity + header->alignment + BLAZE_RT_HEADER_SIZE, header->alignment);
    if (cls != 0) {
      header->base = (void*)blaze_rt_released[cls - 1];
      blaze_rt_released[cls - 1] = header;
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
  /* The left string is a value the program can still be holding, so it is only
     written into when it is a managed block nothing else refers to. A literal
     the compiler wrote out has no block to grow, and a shared one has a reader
     that would see the append, so both are copied into a block of their own
     instead, and it is that copy which the later appends grow. */
  blaze_rt_header* header = (blaze_rt_header*)((const char*)left - BLAZE_RT_HEADER_SIZE);
  char* joined;
  if (header->magic == BLAZE_RT_MAGIC && header->references == 1) {
    if (wanted <= header->capacity) {
      joined = (char*)left;
    } else {
      /* Half again as much as the block had, so a loop of appends copies its
         bytes a linear number of times rather than a quadratic one. */
      const size_t room = header->capacity + header->capacity / 2 + 16;
      const size_t total = wanted < room ? room : wanted;
      joined = (char*)blaze_rt_block(total, header->alignment, 0);
      blaze_rt_header_of(joined)->capacity = total;
      memcpy(joined, left, left_length);
      blaze_rt_release((void*)left);
    }
  } else {
    const size_t room = left_length * 2 + 16;
    joined = (char*)blaze_rt_allocate_uninitialized(wanted < room ? room : wanted);
    memcpy(joined, left, left_length);
  }
  blaze_rt_header_of(joined)->length = wanted;
  memcpy(joined + left_length, right, right_length);
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
void blaze_rt_print_newline(void) {
  fputc('\\n', stdout);
}

void blaze_rt_raise(const char* message) {
  blaze_rt_last_message = message == NULL ? "" : message;
  fprintf(stderr, "blaze: %s\\n", blaze_rt_last_message);
  exit(2);
}

const char* blaze_rt_last_error(void) {
  return blaze_rt_last_message;
}

${U256_KERNEL}
`;
}


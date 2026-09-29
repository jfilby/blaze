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

import type { RuntimeKind } from "../core/types.ts";

/** The name of the C header, the Nim adapter module and the object file. */
export const RUNTIME_NAME = "blaze_rt";

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
    "blaze_rt_reallocate",
    "void*",
    [
      ["pointer", "void*"],
      ["bytes", "size_t"],
    ],
    "Resizes a managed block, keeping its contents and its reference.",
    "Returns the managed pointer; a null pointer allocates.",
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
    "The host calls this once, before the program runs. An argument that is not a number is 0.",
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
    "The argument at an index of process.argv, or 0 when there is no such argument.",
    "A number: index 0 and 1 are where the program runs and the file it runs, so index 2 is the first argument; an argument that is missing or is not a number is 0.",
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
    "blaze_rt_print_number",
    "void",
    [["value", "double"]],
    "Writes a number to the output as the shortest text that reads back as it.",
    "Writes no newline: the program decides where a line ends.",
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
    "Writes into the caller's buffer and returns the number of bytes written, which is never more than size - 1, and 0 when size is 0.",
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
  return RUNTIME_SYMBOLS[symbol] === true;
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
  uint64_t reserved;    /* zero */
} blaze_rt_header;

#define BLAZE_RT_MAGIC 0x424C415A45525400ULL
#define BLAZE_RT_HEADER_SIZE 48u
#define BLAZE_RT_DEFAULT_ALIGNMENT 16u
/* The largest a request may be, so a product of a count and an element size
   that would wrap is refused rather than answered with a smaller block. */
#define BLAZE_RT_MAX_ALLOCATION (1ULL << 40)
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
  return `${HEADER_PREAMBLE}\n${declarations}\n${HEADER_EPILOGUE}`;
}

/** The runtime the compiler emits for `runtime: none`, on top of libc. */
export function runtimeSourceSource(): string {
  return `/* Generated by the blaze compiler. Do not edit. */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "${RUNTIME_NAME}.h"

static const char* blaze_rt_last_message = "";

static void blaze_rt_refuse(const char* what) {
  fprintf(stderr, "blaze: %s\\n", what);
  exit(2);
}

static blaze_rt_header* blaze_rt_header_of(void* pointer) {
  blaze_rt_header* header = (blaze_rt_header*)((char*)pointer - BLAZE_RT_HEADER_SIZE);
  if (header->magic != BLAZE_RT_MAGIC) blaze_rt_refuse("not a live runtime pointer");
  if (header->alignment == 0 || (header->alignment & (header->alignment - 1)) != 0) {
    blaze_rt_refuse("corrupt runtime header");
  }
  return header;
}

/* The size of count elements, refused when the product would leave the range
   the runtime hands out: a wrapped size allocates a block far smaller than
   the array the caller is about to write into, so the first element ends up
   corrupting the heap. */
static size_t blaze_rt_array_bytes(size_t count, size_t elementSize, const char* who) {
  if (elementSize != 0 && count > BLAZE_RT_MAX_ALLOCATION / elementSize) {
    fprintf(stderr, "blaze: %s: request too large\\n", who);
    exit(2);
  }
  return count * elementSize;
}

static void* blaze_rt_block(size_t bytes, size_t alignment) {
  if (alignment == 0) alignment = BLAZE_RT_DEFAULT_ALIGNMENT;
  /* The payload is placed with a mask, which only places it for a power of
     two, and an alignment past the cap names no block the runtime can give. */
  if ((alignment & (alignment - 1)) != 0) blaze_rt_refuse("object alignment must be a power of two");
  /* The budget the next line checks against is the cap less the alignment less
     the header, and an alignment at the cap leaves that subtraction to wrap:
     the guard reads as the whole size_t range, every request is under it, and
     the total below wraps into a small allocation whose payload is then
     placed a terabyte away from the block that was actually mapped. The cap
     has to leave room for the header as well as for the payload. */
  if (alignment > BLAZE_RT_MAX_ALLOCATION - BLAZE_RT_HEADER_SIZE) blaze_rt_refuse("object alignment is too large");
  if (bytes > BLAZE_RT_MAX_ALLOCATION - alignment - BLAZE_RT_HEADER_SIZE) blaze_rt_refuse("request too large");
  const size_t total = bytes + alignment + BLAZE_RT_HEADER_SIZE;
  char* base = (char*)calloc(1, total);
  if (base == NULL) blaze_rt_refuse("out of memory");
  const uintptr_t start = (uintptr_t)(base + BLAZE_RT_HEADER_SIZE);
  const uintptr_t aligned = (start + alignment - 1) & ~(uintptr_t)(alignment - 1);
  blaze_rt_header* header = (blaze_rt_header*)(aligned - BLAZE_RT_HEADER_SIZE);
  header->magic = BLAZE_RT_MAGIC;
  header->base = base;
  header->length = bytes;
  header->alignment = alignment;
  header->references = 1;
  header->reserved = 0;
  return (void*)aligned;
}

void blaze_rt_initialize(void) {}

void blaze_rt_finalize(void) {}

void* blaze_rt_allocate(size_t bytes) {
  return blaze_rt_block(bytes, BLAZE_RT_DEFAULT_ALIGNMENT);
}

void* blaze_rt_reallocate(void* pointer, size_t bytes) {
  if (pointer == NULL) return blaze_rt_allocate(bytes);
  blaze_rt_header* header = blaze_rt_header_of(pointer);
  void* grown = blaze_rt_block(bytes, header->alignment);
  memcpy(grown, pointer, header->length < bytes ? header->length : bytes);
  blaze_rt_release(pointer);
  return grown;
}

void* blaze_rt_retain(void* pointer) {
  if (pointer == NULL) return NULL;
  blaze_rt_header_of(pointer)->references += 1;
  return pointer;
}

void blaze_rt_release(void* pointer) {
  if (pointer == NULL) return;
  blaze_rt_header* header = blaze_rt_header_of(pointer);
  if (header->references > 1) {
    header->references -= 1;
    return;
  }
  header->magic = 0;
  free(header->base);
}

const char* blaze_rt_string_new(const unsigned char* bytes, size_t length) {
  char* text = (char*)blaze_rt_allocate(length + 1);
  if (length > 0) memcpy(text, bytes, length);
  text[length] = '\\0';
  return text;
}

size_t blaze_rt_string_length(const char* text) {
  if (text == NULL) return 0;
  return blaze_rt_header_of((void*)text)->length - 1;
}

const char* blaze_rt_string_clone(const char* text) {
  return blaze_rt_string_new((const unsigned char*)text, blaze_rt_string_length(text));
}

void* blaze_rt_array_new(size_t count, size_t elementSize) {
  return blaze_rt_allocate(blaze_rt_array_bytes(count, elementSize, "blaze_rt_array_new"));
}

void* blaze_rt_array_resize(void* pointer, size_t count, size_t elementSize) {
  return blaze_rt_reallocate(pointer, blaze_rt_array_bytes(count, elementSize, "blaze_rt_array_resize"));
}

void* blaze_rt_object_new(size_t bytes, size_t alignment) {
  return blaze_rt_block(bytes, alignment);
}

size_t blaze_rt_object_size(void* pointer) {
  if (pointer == NULL) return 0;
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
     the file it runs, and 2 is the first argument it was given. */
  if (index < 2) return 0.0;
  const size_t argument = index - 2;
  if (blaze_rt_arguments == NULL || argument >= blaze_rt_argument_count) return 0.0;
  return blaze_rt_arguments[argument];
}

void blaze_rt_print_text(const char* text) {
  if (text == NULL) return;
  fputs(text, stdout);
}

/* Copies the bytes of a number that fit, NUL terminated, and reports how many
   were written. The length the ABI promises is the number of bytes written,
   so a caller that sizes or walks its buffer by it never steps past the end
   of the buffer it was given. */
static size_t blaze_rt_write_number(const char* text, size_t length, unsigned char* buffer, size_t size) {
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
     Infinity, -Infinity and NaN. A negative zero keeps its sign, which is what
     the source prints for it. */
  const char* fixed = NULL;
  if (isnan(value)) fixed = "NaN";
  else if (isinf(value)) fixed = signbit(value) ? "-Infinity" : "Infinity";
  else if (value == 0.0) fixed = signbit(value) ? "-0" : "0";
  if (fixed != NULL) {
    return blaze_rt_write_number(fixed, strlen(fixed), buffer, size);
  }

  const int negative = signbit(value);
  const double magnitude = negative ? -value : value;
  char text[40];
  int precision = 0;
  for (; precision < 17; precision += 1) {
    snprintf(text, sizeof text, "%.*e", precision, magnitude);
    if (strtod(text, NULL) == magnitude) break;
  }
  if (precision == 17) snprintf(text, sizeof text, "%.16e", magnitude);

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

  char written[64];
  int used = 0;
  if (negative) written[used++] = '-';
  if (point >= -5 && point <= 21) {
    if (point <= 0) {
      used += snprintf(written + used, sizeof written - (size_t)used, "0.");
      for (int index = 0; index < -point; index += 1) written[used++] = '0';
      memcpy(written + used, digits, (size_t)count);
      used += count;
      written[used] = '\\0';
    } else if (point >= count) {
      used += snprintf(written + used, sizeof written - (size_t)used, "%s", digits);
      for (int index = 0; index < point - count; index += 1) written[used++] = '0';
      written[used] = '\\0';
    } else {
      written[used++] = '\\0';
      memcpy(written + used - 1, digits, (size_t)point);
      used += point - 1;
      written[used++] = '.';
      memcpy(written + used, digits + point, (size_t)(count - point));
      used += count - point;
      written[used] = '\\0';
    }
  } else {
    written[used++] = digits[0];
    if (count > 1) {
      written[used++] = '.';
      memcpy(written + used, digits + 1, (size_t)(count - 1));
      used += count - 1;
    }
    used += snprintf(written + used, sizeof written - (size_t)used, "e%c%d", point - 1 < 0 ? '-' : '+', point - 1 < 0 ? 1 - point : point - 1);
  }

  return blaze_rt_write_number(written, (size_t)used, buffer, size);
}

void blaze_rt_print_number(double value) {
  char text[64];
  blaze_rt_format_number(value, (unsigned char*)text, sizeof text);
  fputs(text, stdout);
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
`;
}


/**
 * The program driver, in C.
 *
 * A program build delivers a binary, not a harness: the statements of the
 * entry module are run by this driver, which the compiler writes from the
 * semantic IR (see core/semantic-ir.ts) and links with the objects of the
 * functions the program compiled. The walk over the program is shared with the
 * Nim host (see program-emit.ts); what is here is how C spells it.
 *
 * The driver owns everything a contract cannot state: what a program prints,
 * what it allocates, and the strings and arithmetic it builds on the way.
 */

import { writeFile } from "node:fs/promises";
import { parseType, typeToString } from "../semantics/contract.ts";
import { CompilerError } from "../core/errors.ts";
import { run } from "../core/process.ts";
import { cDeclarationType, cObjectDeclarations } from "./linker.ts";
import { generateProgramSource, type ProgramTarget } from "./program-emit.ts";
import type { SemanticProgram } from "../semantics/ir-resolve.ts";
import {
  isBoolean,
  isFloat,
  isReference,
  isTextType,
  isUnsigned,
  isWideType,
  type SemanticCall,
  type SemanticReduction,
  type SemanticType,
  type ValueKind,
} from "../core/semantic-ir.ts";
import type { BuildMode, FunctionSignature, Objective, Runner, TargetSpec } from "../core/types.ts";
import { cTargetOptions, linkOptions, threadingOptions, type Threading } from "../core/target.ts";
import { RUNTIME_NAME, RUNTIME_SYMBOLS } from "../runtime/abi.ts";

import { C_KEYWORDS, cEscape, cHeaderNames, cLiteral, cMemberName, cOperator, cStringLiteral, cSymbolLabel, cSymbolName } from "./c-names.ts";

/** The operator C spells for the one the source used. */

/** The helpers a program needs that the runtime does not provide. */
const DRIVER_HELPERS = `/* A string the program built, held as a NUL terminated managed value. */
static const char* program_string(const char* text, size_t length) {
  const char* copy = (const char*)${RUNTIME_NAME}_string_new((const unsigned char*)text, length);
  if (copy == NULL) program_fail("out of memory");
  return copy;
}

static const char* program_concat(const char* left, const char* right) {
  const char* joined = ${RUNTIME_NAME}_string_append(left, right);
  if (joined == NULL) program_fail("out of memory");
  return joined;
}

/* The length of any string, managed or a literal the compiler wrote out. A
   managed string is measured from the header in front of it in O(1); the
   runtime measures a literal by scanning it, which is what it has to do. */
static size_t program_string_length(const char* text) {
  return ${RUNTIME_NAME}_text_length(text);
}


static bool program_string_equal(const char* left, const char* right) {
  if (left == NULL || right == NULL) return left == right;
  return strcmp(left, right) == 0;
}

static int program_string_compare(const char* left, const char* right) {
  if (left == NULL || right == NULL) return left == right ? 0 : (left == NULL ? -1 : 1);
  return strcmp(left, right);
}

static void program_print_string(const char* text) {
  if (text != NULL) fwrite(text, 1, ${RUNTIME_NAME}_text_length(text), stdout);
}

/* A number as the language writes it, which is what a string interpolates. */
static const char* program_number_text(double value) {
  char text[64];
  const size_t written = ${RUNTIME_NAME}_format_number(value, (unsigned char*)text, sizeof text);
  return program_string(text, written);
}

/* A wide number as the language writes it, which is every limb of it in
   decimal: four limbs and no machine register, so the runtime's own formatter
   is what writes it. */
static void program_print_wide(const blaze_u256* value) {
  ${RUNTIME_NAME}_print_u256(value);
}

/* The same number as text, for a string that interpolates it or for the length
   a caller measures. */
static const char* program_wide_text(const blaze_u256* value) {
  char text[80];
  const size_t written = ${RUNTIME_NAME}_u256_format(value, 10, (unsigned char*)text, sizeof text);
  return program_string(text, written);
}

/* The same number in lowercase hexadecimal, which is what x.toString(16)
   is. */
static const char* program_wide_hex_text(const blaze_u256* value) {
  char text[80];
  const size_t written = ${RUNTIME_NAME}_u256_format(value, 16, (unsigned char*)text, sizeof text);
  return program_string(text, written);
}

/* A number written at a fixed number of digits after the point, which is what
   x.toFixed(d) is: the same digits every time, rounded at the last of them,
   and never the exponent form the shortest writing falls back on.

   The runtime writes it rather than this driver repeating it, because the two
   have to agree exactly and one of them is the machine backend's: the C
   library this would otherwise call breaks a tie to even, and the language
   writes one away from zero, so (2.5).toFixed(0) is 3 here and 2 there until
   both ask the same function. */
static const char* program_number_fixed(double value, int digits) {
  char text[512];
  const size_t written = ${RUNTIME_NAME}_format_number_fixed(value, digits, (unsigned char*)text, sizeof text);
  return program_string(text, written);
}

/* A whole number written out, without the locale-aware formatting snprintf
   does for it. A double holds every i64 only up to 2^53, so a 64 bit integer is
   written by dividing by ten rather than by handing it to a printf. */
static const char* program_integer_text(long long value) {
  char text[24];
  char digits[24];
  int count = 0;
  unsigned long long magnitude = value < 0
    ? 0ULL - (unsigned long long)value
    : (unsigned long long)value;
  do {
    digits[count++] = (char)('0' + (int)(magnitude % 10));
    magnitude /= 10;
  } while (magnitude > 0);
  int used = 0;
  if (value < 0) text[used++] = '-';
  while (count > 0) text[used++] = digits[--count];
  text[used] = '\\0';
  return program_string(text, (size_t)used);
}

/* The language carries a NaN through, so a value that is not a number is
   answered with, and a tie is answered by the sign of the zero it is: a
   maximum is +0 and a minimum is -0 however the two zeros were written, which
   is the one thing fmax and fmin do not do. */
static double program_max(double left, double right) {
  if (isnan(left) || isnan(right)) return left + right;
  if (left > right) return left;
  if (right > left) return right;
  return left == 0.0 && (signbit(left) || signbit(right)) ? 0.0 : left;
}

static double program_min(double left, double right) {
  if (isnan(left) || isnan(right)) return left + right;
  if (left < right) return left;
  if (right < left) return right;
  return left == 0.0 && (signbit(left) || signbit(right)) ? -0.0 : left;
}

/* A half is rounded up, as the language rounds it, and a value that rounds to
   zero from below keeps its sign, which is what the source prints. */
static double program_round(double value) {
  const double rounded = floor(value + 0.5);
  return rounded == 0.0 && value < 0.0 ? -0.0 : rounded;
}

static const char* program_unsigned_text(unsigned long long value) {
  char text[24];
  char digits[24];
  int count = 0;
  do {
    digits[count++] = (char)('0' + (int)(value % 10));
    value /= 10;
  } while (value > 0);
  int used = 0;
  while (count > 0) text[used++] = digits[--count];
  text[used] = '\\0';
  return program_string(text, (size_t)used);
}
`;

const DRIVER_PRELUDE = `/* Generated by the blaze compiler from a program. Do not edit. */
#include <ctype.h>
#include <stdbool.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>

#include "${RUNTIME_NAME}.h"

/* One command line argument as the number the source reads it as. The source
   reads an argument the way the language reads a string as a number: the
   spaces around it are not part of it, a base written before the digits is
   read in that base, and an argument that is not a number at all is NaN
   rather than a zero the source never wrote. */
static double program_number_of(const char* text) {
  const char* start = text;
  while (isspace((unsigned char)*start)) start += 1;
  const char* end = start + strlen(start);
  while (end > start && isspace((unsigned char)end[-1])) end -= 1;
  if (end == start) return 0.0;

  /* A base written before the digits is read in that base, one digit at a
     time, rather than left to whatever the C library makes of it: 0b101 is
     five, 0o17 is fifteen, and a prefix with no digits behind it is not a
     number. A base is never written behind a sign, so the base is looked for
     before one is taken off, and a signed argument that is based is not a
     number at all. */
  int base = 0;
  if (end - start > 2 && start[0] == '0') {
    if (start[1] == 'x' || start[1] == 'X') base = 16;
    else if (start[1] == 'o' || start[1] == 'O') base = 8;
    else if (start[1] == 'b' || start[1] == 'B') base = 2;
  }
  if (base != 0) {
    double value = 0.0;
    for (const char* digit = start + 2; digit < end; digit += 1) {
      const int letter = (unsigned char)*digit;
      const int place = letter >= '0' && letter <= '9' ? letter - '0'
        : letter >= 'a' && letter <= 'z' ? letter - 'a' + 10
        : letter >= 'A' && letter <= 'Z' ? letter - 'A' + 10
        : -1;
      if (place < 0 || place >= base) return NAN;
      value = value * (double)base + (double)place;
    }
    return value;
  }

  /* What is left is a decimal, which is the one form a sign is written in front
     of, and the one word a decimal may spell. */
  bool negative = false;
  const char* digits = start;
  if (*digits == '+' || *digits == '-') {
    negative = *digits == '-';
    digits += 1;
  }
  if (digits == end) return NAN;
  if (end - digits == 8 && memcmp(digits, "Infinity", 8) == 0) return negative ? -INFINITY : INFINITY;

  /* strtod also reads inf, nan and a base before the digits, none of which the
     language reads as a number, so an argument it would answer that the source
     would not is NaN rather than handed to it. */
  if (*digits != '.' && (*digits < '0' || *digits > '9')) return NAN;
  if (*digits == '0' && digits + 1 < end && strchr("xXoObB", digits[1]) != NULL) return NAN;
  char* stop = NULL;
  const double value = strtod(digits, &stop);
  if (stop != end) return NAN;
  return negative ? -value : value;
}

static void program_fail(const char* message) {
  fprintf(stderr, "program: %s\\n", message);
  exit(2);
}

${DRIVER_HELPERS}`;

/**
 * The names C reserves, the names the headers the driver includes define, and
 * the names the driver itself holds. The driver declares a source name under
 * a C name of its own, and one that has already been taken is a diagnostic
 * the C compiler raises. The helper names are taken from the driver as it is
 * written, so adding one cannot leave the list behind.
 */
const RESERVED: Record<string, true> = {
  ...C_KEYWORDS,
  ...cHeaderNames(),
  // The entry point the driver is, and the names in its scope.
  main: true,
  argc: true,
  argv: true,
  arguments: true,
  ...Object.fromEntries(
    [...`${DRIVER_PRELUDE}`.matchAll(/program_[a-z0-9_]+/g)].map((match) => [match[0], true as const]),
  ),
  // The names the driver's own statement expressions bind. They are written
  // down here rather than counted from the source, and a program is free to
  // call a variable either of them: the `blaze_truth` in a float condition
  // shadows a source `blaze_truth` inside the condition, and the source then
  // reads the uninitialised temporary instead of its own value.
  blaze_truth: true,
  // An object built as a value is named `blaze_object_1` and up, so the whole
  // family is kept rather than the two the first builds happen to use.
  ...Object.fromEntries(
    [...Array(64).keys()].map((index) => [`blaze_object_${index + 1}`, true as const]),
  ),
  // Every entry point of the runtime the driver links against.
  ...RUNTIME_SYMBOLS,
};

/**
 * The C a value is declared as. A string is a C string, and a value of no
 * type is one too: the contract type language has no string type of its own.
 */
function declaredType(type: SemanticType | null): string {
  if (type === null || isTextType(type)) return "const char*";
  return cDeclarationType(type);
}

function driverError(message: string, detail?: string): CompilerError {
  return new CompilerError({ category: "LinkError", stage: "link", message, detail });
}


/* The kernel each operation over a wide number is one call of, by the name the
   runtime gives it. The kernel carries four limbs and answers addition,
   subtraction, a product, a quotient and a remainder, the shifts and the bitwise
   operators, and the driver says so rather than writing a C operator the
   compiler would reject. */
const WIDE_KERNELS: Record<string, string> = {
  add: "add",
  sub: "sub",
  mul: "mul",
  div: "div",
  mod: "mod",
  shl: "shl",
  shr: "shr",
  and: "and",
  or: "or",
  xor: "xor",
};

/** The C driver of one program. */
class CDriver implements ProgramTarget {
  /** The objects built so far, so each one built as a value is named apart. */
  private builds = 0;
  /** True when the program uses the HTTP runtime, so the driver includes its header. */
  private readonly includeHttpHeader: boolean;
  constructor(includeHttpHeader: boolean = false) {
    this.includeHttpHeader = includeHttpHeader;
  }
  prelude(program: SemanticProgram): string {
    const objects = cObjectDeclarations(program.objects);
    const declarations = program.functions.map((signature) => this.declaration(signature)).join("\n");
    const httpHeader = this.includeHttpHeader ? '#include "blaze_http.h"\n' : "";
    const httpDefault = this.includeHttpHeader ? "extern void blaze_http_default_handler(void *, void *);\nextern void blaze_http_server_start_background(void *);\nextern void *blaze_http_server_held(void);\nextern void blaze_http_server_join(void);\n" : "";
    return `${DRIVER_PRELUDE}
${httpHeader}${httpDefault}${objects === "" ? "" : `${objects}\n`}${declarations}`;
  }

  /** A function a program calls, declared as the driver links it. */
  private declaration(signature: FunctionSignature): string {
    const returns = parseType(signature.returns);
    if (returns.kind === "ptr" || returns.kind === "slice" || returns.kind === "array") {
      throw driverError(
        `a program cannot call ${signature.name}`,
        `${typeToString(returns)} is returned, and a program holds numbers and strings`,
      );
    }
    // A parameter name is source text that has to survive being a C
    // identifier, and a program is free to call a parameter `double`. An
    // extern declaration only needs the names to be well formed, so they are
    // escaped the same way every other name the driver writes is.
    // The driver calls functions the compiler already built; their parameter
    // types are fixed by those builds, and an `any` parameter may be carried as
    // either a double or a pointer depending on how the body reads it. An
    // empty parameter list leaves the call to the definition, so the link does
    // not depend on a type the driver has to guess.
    return `extern ${cDeclarationType(returns)} ${cSymbolName(signature.symbol)}()${cSymbolLabel(signature.symbol)};`;
  }

  openFunction(signature: FunctionSignature, parameters: { name: string; type: string }[]): string[] {
    // A function the program declares is a C function of its own: it is called
    // by name from the body that runs and from the other functions, and what it
    // hands back is what its own body settled.
    const returns = cDeclarationType(parseType(signature.returns));
    const given = parameters
      .map((param) => `${cDeclarationType(parseType(param.type))} ${param.name}`)
      .join(", ");
    return [`${returns} ${cSymbolName(signature.symbol)}(${given || "void"})${cSymbolLabel(signature.symbol)} {`];
  }

  closeFunction(releases: readonly string[], returned: boolean): string[] {
    // What the body allocated is freed before it returns, in the reverse of the
    // order the body took it. A body that returns a value has already written
    // its `return`, and the releases that follow it would be dead code — the
    // returned value is owned by the caller, and any other local reference was
    // released when it was last reassigned. A body that falls off the end
    // releases what it holds and then returns nothing.
    return returned
      ? ["}", ""]
      : [...releases, "return;", "}", ""];
  }

  returnValue(value: string): string {
    return `return ${value};`;
  }

  returnNothing(): string {
    return "return;";
  }

  openProgram(): string[] {
    return [
      "",
      "int main(int argc, char** argv) {",
      "  /* The driver is the host program: the runtime lives for the whole run. */",
      `  ${RUNTIME_NAME}_initialize();`,
      "  /* The program is given the arguments it was started with, as the numbers",
      "     the source reads them as: an argument that is not a number is NaN. */",
      "  double arguments[argc > 1 ? argc - 1 : 1];",
      "  for (int index = 1; index < argc; index += 1) arguments[index - 1] = program_number_of(argv[index]);",
      `  ${RUNTIME_NAME}_arguments_set(arguments, (size_t)(argc > 1 ? argc - 1 : 0));`,
    ];
  }

  closeProgram(releases: readonly string[]): string[] {
    return [...releases, `${RUNTIME_NAME}_finalize();`, "return 0;", "}"];
  }

  epilogue(): string[] {
    return [];
  }

  type(type: SemanticType): string {
    return declaredType(type);
  }

  cast(type: SemanticType, expression: string): string {
    return `(${declaredType(type)})(${expression})`;
  }

  asLength(expression: string, type: SemanticType): string {
    // The value is bound because it is read twice and a value the IR calls is a
    // call: `blaze_rt_argv(0)` allocates what the argument was and reads it a
    // second time out of nothing. A NaN is no count and is zero, which is what
    // the language reads a length that is not a number as. The conversion is at
    // the width the IR reads the value at, so a `u32` truncates at thirty-two
    // bits rather than counting in sixty-four and being narrowed afterwards.
    return `({ double program_count = (${expression}); (${declaredType(type)})(program_count != program_count ? 0.0 : program_count); })`;
  }

  literal(text: string, type: string): string {
    return cLiteral(text, type);
  }

  declare(name: string, type: SemanticType | null, value: string): string {
    return `${declaredType(type)} ${name} = ${value};`;
  }

  allocate(name: string, element: SemanticType, length: number, values: string[]): string[] {
    const written = declaredType(element);
    const bytes = length === 0 ? 1 : length;
    // The block is cleared, and the program may read past what it filled: a
    // `while (a[i])` loop over a typed array runs until the read comes back
    // false, and a cleared block is what makes that read false rather than
    // whatever the allocator handed back. The source language gives the same
    // answer because a read past a typed array is undefined and the language
    // answers it as nothing, and a zeroed block is the one way to agree with
    // that without a bounds check the IR holds no length to write.
    return [
      `const size_t ${name}_length = ${length};`,
      `${written}* ${name} = (${written}*)${RUNTIME_NAME}_allocate(${bytes} * sizeof(${written}));`,
      `if (${name} == NULL) program_fail("out of memory");`,
      ...values.map((text, index) => `${name}[${index}] = ${text};`),
    ];
  }

  sized(name: string, element: SemanticType, count: string): string[] {
    // A block of a count the program settled on when it ran. The count is read
    // as a length and the block is cleared, so a read of an element the program
    // never wrote is the zero the language answers it with; a block of no
    // elements is one byte, because a C allocation of nothing is a failure and
    // the language answers an empty array with an array.
    const written = declaredType(element);
    return [
      `const size_t ${name}_length = (size_t)(${count});`,
      `${written}* ${name} = (${written}*)${RUNTIME_NAME}_allocate((${name}_length == 0 ? 1 : ${name}_length) * sizeof(${written}));`,
      `if (${name} == NULL) program_fail("out of memory");`,
    ];
  }

  view(name: string, element: SemanticType, base: string, offset: string, count: string): string[] {
    // A window of a block the program laid out: the same bytes read as the
    // element of the view, from the byte offset the view starts at. The block
    // is not freed here: it belongs to the name the program gave it, which was
    // declared before this one, and what a block frees is freed after every
    // window taken of it.
    const written = declaredType(element);
    return [
      `const size_t ${name}_length = (size_t)(${count});`,
      `${written}* ${name} = (${written}*)((unsigned char*)(${base}) + (size_t)(${offset}));`,
    ];
  }

  fill(name: string, index: string, element: SemanticType, value: string): string[] {
    const written = declaredType(element);
    return [`for (size_t ${index} = 0; ${index} < ${name}_length; ${index} += 1) ${name}[${index}] = (${written})(${value});`];
  }

  alias(name: string, element: SemanticType, source: string, length: string): string[] {
    const written = declaredType(element);
    return [`const size_t ${name}_length = ${length};`, `${written}* ${name} = ${source};`];
  }

  element(buffer: string, index: string): string {
    return `${buffer}[${index}]`;
  }

  assign(name: string, operator: string, value: string, type: SemanticType | null): string {
    // A string grows: `+=` is a new value rather than an addition in place.
    if ((type === null || isTextType(type)) && operator === "+=") return `${name} = program_concat(${name}, ${value});`;
    // C has no `**=`: a power is libm's `pow`. And no `>>>=`: the unsigned
    // right shift is `>>=` over an unsigned type, which is what the binary
    // form already lowers to.
    if (operator === "**=") return `${name} = pow(${name}, ${value});`;
    if (operator === ">>>=") return `${name} >>= ${value};`;
    // A plain assignment over a reference releases the value the name held
    // before the new one takes its place, so the old object is not leaked.
    // The new value is computed first (it may read the name), then the name is
    // overwritten, then the old object is released. A self-assignment (`x = x`)
    // releases nothing: the name keeps the same object.
    if (operator === "=" && type !== null && isReference(type) && name !== value) {
      const old = `blaze_old_${this.builds += 1}`;
      return `{ void* ${old} = ${name}; ${name} = ${value}; ${RUNTIME_NAME}_release(${old}); }`;
    }
    return `${name} ${operator} ${value};`;
  }

  elementAssign(buffer: string, index: string, operator: string, value: string): string {
    if (operator === "**=") return `{ double blaze_pow = ${buffer}[${index}]; ${buffer}[${index}] = pow(blaze_pow, ${value}); }`;
    if (operator === ">>>=") return `${buffer}[${index}] >>= ${value};`;
    return `${buffer}[${index}] ${operator} ${value};`;
  }

  update(name: string, operator: string, prefix: boolean): string {
    return `${prefix ? operator : ""}${name}${prefix ? "" : operator};`;
  }

  release(name: string): string {
    return `${RUNTIME_NAME}_release(${name});`;
  }

  retain(value: string): string {
    return `${RUNTIME_NAME}_retain(${value});`;
  }

  field(object: string, layout: string, field: string): string {
    if (layout === "JSON") {
      return `${RUNTIME_NAME}_json_get(${object}, "${field}")`;
    }
    // A reference is held as a pointer, and a pointer has no fields, so the
    // layout the access names is what the field is read through. The member is
    // spelled the way `cObjectDeclarations` declared it, because a field the
    // source called `long` is declared as `long_` and reading it as `long` is
    // C the compiler refuses.
    return `((struct ${layout}*)${object})->${cMemberName(field)}`;
  }

  assignField(object: string, layout: string, field: string, value: string): string {
    return `((struct ${layout}*)${object})->${cMemberName(field)} = ${value};`;
  }

  buildObject(layout: string, fields: { field: string; value: string }[]): string {
    // An object is one value the program holds, so it is allocated and filled
    // where it is written, and a value may not be a statement. C has no way to
    // bind a temporary inside an expression, so this is a statement
    // expression: a GNU extension, which this driver needs because it builds
    // with gcc, and the only form that keeps the object inside the arm of a
    // conditional it was written in. A backend that must speak standard C
    // instead writes the arms of such a conditional as control flow and joins
    // them on a name, which is the same program with more lines.
    const name = `blaze_object_${(this.builds += 1)}`;
    const written = fields.map((one) => `((struct ${layout}*)${name})->${cMemberName(one.field)} = ${one.value};`);
    return `({ struct ${layout}* ${name} = (struct ${layout}*)${RUNTIME_NAME}_object_new(sizeof(struct ${layout}), _Alignof(struct ${layout})); ${written.join(" ")} ${name}; })`;
  }

  raise(message: string): string {
    return `${RUNTIME_NAME}_raise(${message});`;
  }

  condition(expression: string, kind: ValueKind, type: SemanticType | null): string {
    // A string holds when it has text in it, and an object holds when it is
    // there at all: an empty string is false, as it is in the language.
    if (kind === "text") return `(${expression})[0] != '\\0'`;
    if (kind === "reference") {
      if (type !== null && type.kind === "ref" && type.of === null && type.name === undefined) {
        return `((${expression}) == (${expression}) && (${expression}) != 0)`;
      }
      return `(${expression}) != NULL`;
    }
    if (kind === "boolean") return `(${expression})`;
    // A value that is not a number holds nothing, and `NaN != 0` is true in C,
    // so the test asks for a number that is a number. The value is bound
    // because it is read twice and a value the IR calls is a call.
    if (isFloat(type)) {
      return `({ double blaze_truth = (${expression}); blaze_truth == blaze_truth && blaze_truth != 0; })`;
    }
    return `(${expression}) != 0`;
  }

  openBlock(): string {
    return "{";
  }

  closeBody(): string {
    return "}";
  }

  emptyBody(): null {
    return null;
  }

  openIf(condition: string): string {
    return `if (${condition}) {`;
  }

  // The walk closes the arm's body before it asks for the else header, so
  // this opens the else body rather than closing the arm a second time.
  openElse(): string {
    return "else {";
  }

  openWhile(condition: string): string {
    return `while (${condition}) {`;
  }

  openDo(_condition: string): string[] {
    return ["do {"];
  }

  closeDo(condition: string): string[] {
    return [`} while (${condition});`];
  }

  openFor(
    variable: string,
    type: SemanticType,
    from: string,
    to: string,
    inclusive: boolean,
    down: boolean,
    step: string | null,
  ): string[] {
    const bound = down ? (inclusive ? ">=" : ">") : inclusive ? "<=" : "<";
    const move = step === null ? `${variable}${down ? "--" : "++"}` : `${variable} += ${step}`;
    return [`for (${declaredType(type)} ${variable} = ${from}; ${variable} ${bound} ${to}; ${move}) {`];
  }

  openForOf(index: string, variable: string, type: SemanticType, buffer: string, length: string): string[] {
    return [
      `for (size_t ${index} = 0; ${index} < (${length}); ${index} += 1) {`,
      `  const ${declaredType(type)} ${variable} = ${buffer}[${index}];`,
    ];
  }

  /**
   * A loop the compiler proved has turns that do not depend on each other is
   * handed to OpenMP. Everything the body reads and does not write is shared
   * and read-only by that proof, and the index the turns run on is private to
   * whichever turn is running it, which is what the pragma says.
   *
   * An accumulator the turns combine is named on the pragma as well, and that
   * is what the clause is for: without it every turn writes the one accumulator
   * the turns share and the updates are lost to each other. OpenMP gives each
   * turn a total of its own and combines them at the end, which is the same
   * number as a turn writing the accumulator, because `semantics/parallel.ts`
   * proved the values combined are whole numbers.
   */
  parallelDirective(reductions: readonly SemanticReduction[]): string[] {
    if (reductions.length === 0) return ["#pragma omp parallel for"];
    const clauses = reductions.map((reduction) => `reduction(${reduction.op}:${reduction.name})`);
    return [`#pragma omp parallel for ${clauses.join(" ")}`];
  }

  breakLine(): string {
    return "break;";
  }

  continueLine(): string {
    return "continue;";
  }

  conditional(condition: string, then: string, otherwise: string): string {
    return `((${condition}) ? (${then}) : (${otherwise}))`;
  }

  discard(expression: string, _returnsNothing: boolean): string {
    return `${expression};`;
  }

  print(value: string, type: SemanticType | null, kind: ValueKind, bigint: boolean): string[] {
    if (kind === "text") return [`program_print_string(${value});`];
    if (kind === "null") return [`program_print_string("null");`];
    if (kind === "boolean") return [`fputs((${value}) ? "true" : "false", stdout);`];
    // A wide number is four limbs and no machine register, so it is never cast
    // to a scalar: `printf("%llu", (unsigned long long)(a_u256))` is C the
    // compiler rejects as "aggregate value used where an integer was
    // expected", and the build failed at the link rather than at the print.
    // The value is written into a temporary first, because the formatter wants
    // its address and a call is not an lvalue: `&(f(x))` is C the compiler
    // rejects as "lvalue required as unary '&' operand".
    //
    // The `n` is what says the source wrote this value as a bigint, so it
    // follows the value rather than the type: a wide number the source wrote as
    // a number prints its digits and one it wrote as a bigint prints them with
    // the marker, which is what the source this program is checked against
    // prints. The language has no `u256`, so the type alone cannot say.
    if (type !== null && isWideType(type)) {
      const printed = `({ blaze_u256 blaze_wide_value = ${value}; program_print_wide(&blaze_wide_value);`;
      return [bigint ? `${printed} fputc('n', stdout); });` : `${printed} });`];
    }
    // A bigint is written with the `n` after it that says which of the two it is,
    // and it is the same sixty-four bit whole number either way — so the format
    // is the whole number's and the suffix is part of it.
    if (bigint) return [`printf("%lldn", (long long)(${value}));`];
    if (type !== null && isFloat(type)) return [`${RUNTIME_NAME}_print_number((double)(${value}));`];
    const format = type !== null && isUnsigned(type) ? "%llu" : "%lld";
    const cast = type !== null && isUnsigned(type) ? "unsigned long long" : "long long";
    return [`printf("${format}", (${cast})(${value}));`];
  }

  newline(): string {
    return `fputc('\\n', stdout);`;
  }

  call(call: SemanticCall, argumentsText: string[]): string {
    return `${cSymbolName(call.signature.symbol)}(${argumentsText.join(", ")})`;
  }

  builtin(call: SemanticCall, argumentsText: string[]): string {
    const argument = (index: number): string => argumentsText[index] ?? "0.0";
    switch (call.callee) {
      case "Math.abs":
        return `fabs(${argument(0)})`;
      case "Math.sqrt":
        return `sqrt(${argument(0)})`;
      case "Math.floor":
        return `floor(${argument(0)})`;
      case "Math.round":
        return `program_round(${argument(0)})`;
      case "Math.trunc":
        return `trunc(${argument(0)})`;
      case "Math.random":
        return `${RUNTIME_NAME}_random()`;
      case "sharedBlock":
        return `${RUNTIME_NAME}_allocate((size_t)(${argument(0)}))`;
      case "u256_from_u64x2": {
        const out = "blaze_wide";
        return `({ ${RUNTIME_NAME}_u256 ${out}; ${RUNTIME_NAME}_u256_from_u64x2(&${out}, ${argument(0)}, ${argument(1)}); ${out}; })`;
      }
      case "u256_from_u64x4": {
        const out = "blaze_wide";
        return `({ ${RUNTIME_NAME}_u256 ${out}; ${RUNTIME_NAME}_u256_from_u64x4(&${out}, ${argument(0)}, ${argument(1)}, ${argument(2)}, ${argument(3)}); ${out}; })`;
      }
      case "parseInt":
        return `${RUNTIME_NAME}_to_number(${argument(0)})`;
      case "JSON.parse":
        return `${RUNTIME_NAME}_json_parse(${argument(0)})`;
      case "JSON.stringify":
        return `${RUNTIME_NAME}_json_stringify(${argument(0)})`;
      case "crypto.createHash":
        return `${RUNTIME_NAME}_md5_create()`;
      case "fs.readFileSync":
        return `${RUNTIME_NAME}_file_read(${argument(0)}, ${argument(1)})`;
      case "hasher.update":
        return `${RUNTIME_NAME}_md5_update(${argument(0)}, ${RUNTIME_NAME}_to_text(${argument(1)}))`;
      case "hasher.update.digest":
        return `${RUNTIME_NAME}_md5_digest(${argument(0)})`;
      case "array.new":
        return `${RUNTIME_NAME}_dyn_array_new()`;
      case "array.push":
        return `${RUNTIME_NAME}_array_push(${argument(0)}, ${argument(1)})`;
      case "http.serve":
        return `({ void *blaze_http_srv = blaze_http_server_new((uint16_t)${argument(0)}); blaze_http_route_register(blaze_http_srv, "*", "*", blaze_http_default_handler); blaze_http_server_run(blaze_http_srv); })`;
      case "http.serveSettings":
        return `({ void *blaze_http_srv = blaze_http_server_new_settings((uint16_t)${argument(0)}, (intptr_t)${argument(1)}, (size_t)${argument(2)}, (size_t)${argument(3)}, (uint8_t)${argument(4)}, (int)${argument(5)}, (int)${argument(6)}); blaze_http_route_register(blaze_http_srv, "*", "*", blaze_http_default_handler); blaze_http_server_run(blaze_http_srv); })`;
      case "http.serveTls":
        return `({ void *blaze_http_srv = blaze_http_server_new_tls((uint16_t)${argument(0)}, ${argument(1)}, ${argument(2)}); blaze_http_route_register(blaze_http_srv, "*", "*", blaze_http_default_handler); blaze_http_server_run(blaze_http_srv); })`;
      case "http.createServer": {
        const cb = call.args[0];
        let trampoline = "0.0";
        if (cb !== undefined && cb.k === "functionRef" && typeof cb.name === "string" && cb.name.startsWith("__arrow_")) {
          trampoline = `(double)(uintptr_t)__arrow_trampoline_${cb.name.slice("__arrow_".length)}`;
        }
        return trampoline;
      }
      case "res.writeHead": {
        const status = call.args[1];
        const statusText = status.k === "const" ? status.text : argument(1);
        return `(blaze_http_resp_status((void*) (uintptr_t) ${argument(0)}, (uint16_t) ${statusText}), 0.0)`;
      }
      case "res.end": {
        const body = call.args[1];
        const bodyExpr = argument(1);
        /* Convert any Blaze value to its text form so JSON.stringify results
           (boxed dynamic values) and raw strings both reach the wire as bytes. */
        const bodyPtr = (body.type.kind === "ptr" || body.type.kind === "text") ? bodyExpr : `blaze_rt_to_text(${bodyExpr})`;
        return `(blaze_http_resp_body((void*) (uintptr_t) ${argument(0)}, (const unsigned char*) ${bodyPtr}, strlen((const char*) ${bodyPtr})), blaze_http_resp_complete((void*) (uintptr_t) ${argument(0)}), 0.0)`;
      }
      case "server.close": {
        /* Stop the server `server.listen` last created. The listener passed in
           is the callback, not the handle, so the handle is read from the one the
           adapter holds. A null handle is ignored by the adapter. */
        return `(blaze_http_server_stop(blaze_http_server_held()), 0.0)`;
      }
      case "server.listen": {
        const cb = call.args[3];
        let invoke = `${argument(3)}()`;
        if (cb !== undefined && cb.k === "functionRef" && Array.isArray(cb.captures) && cb.captures.length > 0) {
          invoke = `${argument(3)}(${cb.captures.join(", ")})`;
        }
        const handler = `((void(*)(void*, void*)) (uintptr_t) ${argument(0)})`;
        /* blaze_http_server_new binds the listening socket before it returns, so
           the listener is ready when the callback runs. The event loop runs on a
           detached background thread, so server.listen returns and the callback —
           and anything after it, such as server.close — can run without
           deadlocking against a server that never started. */
        return `({ void *blaze_http_srv = blaze_http_server_new((uint16_t)${argument(1)}); blaze_http_route_register(blaze_http_srv, "*", "*", ${handler} == 0 ? blaze_http_default_handler : ${handler}); blaze_http_server_start_background(blaze_http_srv); ${invoke}; blaze_http_server_join(); 0.0; })`;
      }
      case "Promise": {
        const cb = call.args[0];
        let invoke = `${argument(0)}()`;
        if (cb !== undefined && cb.k === "functionRef") {
          const name = cb.name;
          const captures = Array.isArray(cb.captures) ? cb.captures : [];
          invoke = `${name}(${captures.join(", ")})`;
        }
        return `({ void *blaze_promise = blaze_promise_new(); blaze_current_promise = blaze_promise; ${invoke}; blaze_current_promise = NULL; (double)(uintptr_t)blaze_promise; })`;
      }
      case "Promise.await":
        return `blaze_promise_await((void*)(uintptr_t)${argument(0)})`;
      case "resolve":
        return `(blaze_promise_resolve(blaze_current_promise, ${argument(0)}), 0.0)`;
      case "reject": {
        const arg = call.args[0];
        const text = (arg.k === "text" || arg.k === "const")
          ? argument(0)
          : `blaze_rt_to_text(${argument(0)})`;
        return `(blaze_promise_reject(blaze_current_promise, ${text}), 0.0)`;
      }
      case "require":
      case "req.on": {
        const req = argument(0);
        const cb = call.args[2];
        let invoke = "0.0";
        if (cb !== undefined && cb.k === "functionRef" && typeof cb.name === "string" && cb.name.startsWith("__arrow_")) {
          const trampoline = `__arrow_trampoline_${cb.name.slice("__arrow_".length)}`;
          /* The request body is already buffered by the facil.io adapter, so
             "data" and "end" fire immediately: invoke the callback with the
             request handle (as a double) and a null second handle. */
          invoke = `(${trampoline}((void *)(uintptr_t)${req}, NULL), 1.0)`;
        }
        return invoke;
      }
      case "req.text": {
        /* Read the buffered request body and return it as a Blaze string. */
        return `({ size_t blaze_http_len = 0; const char *blaze_http_body = blaze_http_req_body((void *)(uintptr_t)${argument(0)}, &blaze_http_len); (double)(uintptr_t)blaze_rt_string_new((const unsigned char *)blaze_http_body, blaze_http_len); })`;
      }
      case "req.end":
        /* Server-side: the response is ended by res.end; req.end is a no-op here. */
        return "0.0";
      case "req.write":
        /* Server-side: writing to a request is client-side only; a no-op here. */
        return "0.0";
      case "tasks.push":
        return RUNTIME_NAME + "_array_push(" + argument(0) + ", " + argument(1) + ")";
      case "fetch":
      case "http.request": {
        const urlArg = argument(0);
        const methodArg = argument(1);
        const headersArg = argument(2);
        const bodyArg = argument(3);
        const isRaw = (k: string) => k === "ptr" || k === "text";
        const urlExpr = isRaw(call.args[0].type.kind) ? (call.args[0].type.kind === "ptr" ? `(const char*)(uintptr_t)${urlArg}` : urlArg) : `blaze_rt_to_text(${urlArg})`;
        const methodExpr = isRaw(call.args[1].type.kind) ? (call.args[1].type.kind === "ptr" ? `(const char*)(uintptr_t)${methodArg}` : methodArg) : `blaze_rt_to_text(${methodArg})`;
        const headersExpr = isRaw(call.args[2].type.kind) ? (call.args[2].type.kind === "ptr" ? `(const char*)(uintptr_t)${headersArg}` : headersArg) : `blaze_rt_to_text(${headersArg})`;
        const bodyExpr = isRaw(call.args[3].type.kind) ? (call.args[3].type.kind === "ptr" ? `(const char*)(uintptr_t)${bodyArg}` : bodyArg) : `blaze_rt_to_text(${bodyArg})`;
        const bodyLen = `strlen(${bodyExpr})`;
        return `({ size_t blaze_http_len = 0; const char *blaze_http_body = blaze_http_client_request(${urlExpr}, ${methodExpr}, ${headersExpr}, (const unsigned char*)${bodyExpr}, ${bodyLen}, 10000, &blaze_http_len); (double)(uintptr_t)blaze_rt_string_new((const unsigned char*)blaze_http_body, blaze_http_len); })`;
      }
      default:
        throw driverError(`the driver cannot write down ${call.callee}`);
    }
  }

  argument(type: SemanticType, expression: string): string {
    if (type.kind === "ptr" || type.kind === "slice" || type.kind === "array") {
      return `(${cDeclarationType(type.of)}*)(${expression})`;
    }
    return expression;
  }

  argvCount(): string {
    // The runtime already counts where the program runs and the file it runs,
    // so this is the length of process.argv as node reports it.
    return `${RUNTIME_NAME}_argv_count()`;
  }

  argv(index: string): string {
    return `${RUNTIME_NAME}_argv((size_t)(${index}))`;
  }

  min(left: string, right: string): string {
    return `program_min(${left}, ${right})`;
  }

  max(left: string, right: string): string {
    return `program_max(${left}, ${right})`;
  }

  stringLiteral(text: string): string {
    return cStringLiteral(text);
  }

  stringConcat(left: string, right: string): string {
    return `program_concat(${left}, ${right})`;
  }

  stringLength(value: string): string {
    return `program_string_length(${value})`;
  }

  stringEqual(left: string, right: string): string {
    return `program_string_equal(${left}, ${right})`;
  }

  stringCompare(left: string, right: string): string {
    return `program_string_compare(${left}, ${right})`;
  }

  toText(value: string, type: SemanticType, digits: number | null): string {
    // A reference to nothing has no number of its own, and the word for it is
    // what the language prints: casting it to a number hands out the zero the
    // source never printed.
    if (type.kind === "void") {
      // Nothing has no number of its own, and the word for it is what the
      // language prints: casting it to a number hands out the zero the source
      // never printed.
      return '"null"';
    }
    if (type.kind === "ref" && type.of === null && type.name === undefined) {
      return `${RUNTIME_NAME}_to_text(${value})`;
    }
    if (type.kind === "ref" && type.of === null) {
      return `(${value} == NULL ? "null" : program_integer_text((long long)(${value})))`;
    }
    if (isBoolean(type)) return `(${value} ? "true" : "false")`;
    // A number written at a fixed number of digits is written at them whatever
    // it is: `(-0.0004).toFixed(2)` is `-0.00` and not the zero the shortest
    // writing gives it.
    if (digits !== null && digits < 0) {
      // A negative digit count marks a whole number written in hexadecimal,
      // which is what `x.toString(16)` asks for, and the value keeps its width.
      if (isWideType(type)) return `({ blaze_u256 blaze_wide_value = ${value}; program_wide_hex_text(&blaze_wide_value); })`;
      return `program_number_fixed((double)(${value}), 0)`;
    }
    if (digits !== null) return `program_number_fixed((double)(${value}), ${digits})`;
    if (isFloat(type)) return `program_number_text((double)(${value}))`;
    if (isWideType(type)) return `({ blaze_u256 blaze_wide_value = ${value}; program_wide_text(&blaze_wide_value); })`;
    return isUnsigned(type)
      ? `program_unsigned_text((unsigned long long)(${value}))`
      : `program_integer_text((long long)(${value}))`;
  }

  isNull(value: string, negate: boolean): string {
    return `((${value}) ${negate ? "!=" : "=="} NULL)`;
  }

  nullLiteral(): string {
    return "NULL";
  }

  modulo(left: string, right: string): string {
    return `((${left}) % (${right}))`;
  }

  power(left: string, right: string): string {
    return `pow((${left}), (${right}))`;
  }

  bitwiseNot(value: string): string {
    return `(~(${value}))`;
  }

  logicalNot(value: string): string {
    return `!(${value})`;
  }

  wideBinary(op: string, left: string, right: string, as: SemanticType): string {
    // The kernel is the one copy of the carry and borrow propagation every
    // backend shares, so a wide operation in a program body is the same call a
    // compiled function makes.
    const kernel = WIDE_KERNELS[op];
    if (kernel === undefined) {
      throw driverError(`a wide number has no ${op}, and the kernel has no answer for it`);
    }
    // The kernel reads the number through a pointer, so it is bound to a name of
    // its own first. An operand that is an operation is a compound literal in C,
    // and there is no address to take of one.
    const out = `blaze_wide_${(this.builds += 1)}`;
    const first = `blaze_wide_left_${this.builds}`;
    // A shift is the one operation whose second side is a count of bits rather
    // than a number of the type: the kernel declares it `unsigned`, and the count
    // is the machine word the source wrote the shift by, so it is bound as one
    // rather than as four limbs a kernel would take a pointer to.
    const counted = op === "shl" || op === "shr";
    const second = `blaze_wide_${counted ? "count" : "right"}_${(this.builds += 1)}`;
    const signed = as.kind === "primitive" && as.name === "i256";
    const wide = signed ? "blaze_i256" : "blaze_u256";
    const declared = counted ? `const unsigned ${second} = (unsigned)(${right});` : `const ${wide} ${second} = ${right};`;
    const given = counted ? second : `&${second}`;
    return (
      `({ ${wide} ${out}; ` +
      `const ${wide} ${first} = ${left}; ` +
      `${declared} ` +
      `${RUNTIME_NAME}_${signed ? "i256" : "u256"}_${kernel}(&${out}, &${first}, ${given}); ${out}; })`
    );
  }

  wideMulMod(left: string, right: string, modulus: string, as: SemanticType): string {
    const out = `blaze_wide_${(this.builds += 1)}`;
    const first = `blaze_wide_left_${this.builds}`;
    const second = `blaze_wide_right_${(this.builds += 1)}`;
    const mod = `blaze_wide_mod_${(this.builds += 1)}`;
    const signed = as.kind === "primitive" && as.name === "i256";
    const wide = signed ? "blaze_i256" : "blaze_u256";
    return `({ ${wide} ${out}; const ${wide} ${first} = ${left}; const ${wide} ${second} = ${right}; const ${wide} ${mod} = ${modulus}; ${RUNTIME_NAME}_u256_mul_mod(&${out}, &${first}, &${second}, &${mod}); ${out}; })`;
  }

  wideAddMod(left: string, right: string, modulus: string, as: SemanticType): string {
    const out = `blaze_wide_${(this.builds += 1)}`;
    const first = `blaze_wide_left_${this.builds}`;
    const second = `blaze_wide_right_${(this.builds += 1)}`;
    const mod = `blaze_wide_mod_${(this.builds += 1)}`;
    const signed = as.kind === "primitive" && as.name === "i256";
    const wide = signed ? "blaze_i256" : "blaze_u256";
    return `({ ${wide} ${out}; const ${wide} ${first} = ${left}; const ${wide} ${second} = ${right}; const ${wide} ${mod} = ${modulus}; ${RUNTIME_NAME}_u256_add_mod(&${out}, &${first}, &${second}, &${mod}); ${out}; })`;
  }

  wideSubMod(left: string, right: string, modulus: string, as: SemanticType): string {
    const out = `blaze_wide_${(this.builds += 1)}`;
    const first = `blaze_wide_left_${this.builds}`;
    const second = `blaze_wide_right_${(this.builds += 1)}`;
    const mod = `blaze_wide_mod_${(this.builds += 1)}`;
    const signed = as.kind === "primitive" && as.name === "i256";
    const wide = signed ? "blaze_i256" : "blaze_u256";
    return `({ ${wide} ${out}; const ${wide} ${first} = ${left}; const ${wide} ${second} = ${right}; const ${wide} ${mod} = ${modulus}; ${RUNTIME_NAME}_u256_sub_mod(&${out}, &${first}, &${second}, &${mod}); ${out}; })`;
  }

  widen(value: string, as: SemanticType): string {
    // A whole number widened into a wide number is the word it is in the low
    // limb and nothing above it, which is the one copy of that every backend
    // shares. A cast from a scalar to a struct is not C at all. Widening into
    // the signed wide number sign-extends; widening into the unsigned one
    // zero-extends.
    const out = `blaze_wide_${(this.builds += 1)}`;
    const signed = as.kind === "primitive" && as.name === "i256";
    return `({ ${signed ? "blaze_i256" : "blaze_u256"} ${out}; ${RUNTIME_NAME}_${signed ? "i256_from_i64" : "u256_from_u64"}(&${out}, (${signed ? "int64_t" : "uint64_t"})(${value})); ${out}; })`;
  }

  wideCompare(op: string, left: string, right: string, as: SemanticType): string {
    // The kernel walks the four limbs from the top down, so a pair of wide
    // numbers is ordered by a call rather than by an operator C does not have.
    // The signed kernel orders by sign first; the unsigned one by magnitude.
    const kernel = op === "eq" || op === "ne" ? "equal" : "less";
    const first = `blaze_wide_left_${(this.builds += 1)}`;
    const second = `blaze_wide_right_${(this.builds += 1)}`;
    const signed = as.kind === "primitive" && as.name === "i256";
    const wide = signed ? "blaze_i256" : "blaze_u256";
    const test = `${RUNTIME_NAME}_${signed ? "i256" : "u256"}_${kernel}(&${first}, &${second})`;
    // `gt` and `le` swap the operands: `a > b` is `b < a`, `a <= b` is `!(b < a)`.
    // `ge` and `ne` flip the sense: `a >= b` is `!(a < b)`, `a != b` is `!(a == b)`.
    const flip = op === "ne" || op === "ge" || op === "le" ? "!" : "";
    const swap = op === "gt" || op === "le";
    return (
      `({ const ${wide} ${first} = ${swap ? right : left}; ` +
      `const ${wide} ${second} = ${swap ? left : right}; ${flip}${test}; })`
    );
  }

  wideUnary(op: string, operand: string, as: SemanticType): string {
    // A complement is the only one of its operations a wide number has: the
    // answer of a negation is below zero, and the validator refuses that before
    // it ever reaches a driver. The signed wide number does hold below zero, so
    // `neg` of an `i256` is answered by the kernel too; for now only the
    // complement reaches here, and it is the same bits either way.
    if (op !== "bitNot") {
      throw driverError(`a wide number has no ${op}, and the kernel has no answer for it`);
    }
    const out = `blaze_wide_${(this.builds += 1)}`;
    const moved = `blaze_wide_moved_${this.builds}`;
    const signed = as.kind === "primitive" && as.name === "i256";
    const wide = signed ? "blaze_i256" : "blaze_u256";
    return (
      `({ ${wide} ${out}; const ${wide} ${moved} = ${operand}; ` +
      `${RUNTIME_NAME}_${signed ? "i256" : "u256"}_not(&${out}, &${moved}); ${out}; })`
    );
  }

  operator(op: string): string {
    try {
      return cOperator(op);
    } catch {
      throw driverError(`the driver cannot write ${op} down`);
    }
  }

  escape(name: string): string {
    return cEscape(name, RESERVED);
  }
}

/** Emits the C driver for a program. The driver is compiler code. */
export function generateProgramDriver(program: SemanticProgram, includeHttpHeader: boolean = false): string {
  return generateProgramSource(program, new CDriver(includeHttpHeader));
}

export interface ProgramDriverRequest {
  /** How the C compiler is asked to build, from the project's mode. */
  mode: BuildMode;
  /**
   * What the program is built for, which decides the level of the link. With
   * `-flto` on it, gcc rebuilds every object of the program with the options of
   * this command, so a link that dropped the objective would deliver the
   * program at a level none of its objects were compiled at.
   */
  objective?: Objective;
  /** The machine the program is built for, which every object beside it agrees on. */
  target: TargetSpec;
  program: SemanticProgram;
  /** Directory the driver is written and linked in. */
  workDirectory: string;
  /** Object of every function of the program, in the order they compile. */
  objectPaths: string[];
  /** The compiler runtime object, when the build links one. */
  runtimeObjectPath?: string;
  /**
   * True when any object of the program, or the driver itself, carries a loop
   * the compiler proved its turns independent. It is what asks for threads at
   * the link: an object compiled with a pragma in it needs the runtime that
   * serves the pragma, and a program with no such object does not link one.
   */
  threads?: readonly Threading[];
  /** True when the program uses the HTTP runtime, so the driver includes its header. */
  includeHttpHeader?: boolean;
  outputPath: string;
}

/** Writes and links the C driver. What it links is what the build verified. */
export async function buildProgramDriver(request: ProgramDriverRequest): Promise<Runner> {
  const driverPath = `${request.workDirectory}/program.c`;
  await writeFile(driverPath, generateProgramDriver(request.program, request.includeHttpHeader ?? false), "utf8");
  const inputs = [driverPath, ...request.objectPaths];
  if (request.runtimeObjectPath !== undefined) inputs.push(request.runtimeObjectPath);
  // A program computes with the maths library, so the driver links it.
  // The driver holds the program's own top-level statements, so it is tuned
  // for the same machine as every function it links, which is what a caller
  // naming a cpu asked for and what an unnamed one would not get otherwise.

  const result = run("gcc", ["-std=c11", ...linkOptions(request.mode, request.objective), ...cTargetOptions(request.target), ...threadingOptions(request.threads ?? []), "-Wl,--gc-sections", "-o", request.outputPath, ...inputs, "-lm", ...(request.runtimeObjectPath !== undefined ? ["-pthread", "-lssl", "-lcrypto"] : [])], { timeoutMs: 120_000 });
  if (result.spawnError !== undefined) {
    throw driverError("the C compiler is not available", result.spawnError);
  }
  if (result.code !== 0) {
    throw driverError("the program driver did not link", `${result.command}\n${result.stderr.trim()}`);
  }
  return { command: request.outputPath, args: [] };
}

import { CompilerError } from "../core/errors.ts";
/**
 * The C names a generated source cannot use for something of its own.
 *
 * Every C source the compiler writes puts a name the program chose into a
 * namespace the generated code already occupies: a parameter, a local, a field.
 * The generated side wins, because it is the side that has to be right, so a
 * name that is already taken is written down under a C name of its own instead.
 * The tables here say what is taken, and `cEscape` does the renaming, so the
 * driver and the test harness do it the same way.
 */

/** The keywords C reserves, complete: a generated source that writes a name down needs one. */
export const C_KEYWORDS: Record<string, true> = {
  _Alignas: true,
  _Alignof: true,
  _Atomic: true,
  _Bool: true,
  _Complex: true,
  _Generic: true,
  _Imaginary: true,
  _Noreturn: true,
  _Static_assert: true,
  _Thread_local: true,
  auto: true,
  break: true,
  case: true,
  char: true,
  const: true,
  continue: true,
  default: true,
  do: true,
  double: true,
  else: true,
  enum: true,
  extern: true,
  float: true,
  for: true,
  goto: true,
  if: true,
  inline: true,
  int: true,
  long: true,
  register: true,
  restrict: true,
  return: true,
  short: true,
  signed: true,
  sizeof: true,
  static: true,
  struct: true,
  switch: true,
  typedef: true,
  union: true,
  unsigned: true,
  void: true,
  volatile: true,
  while: true,
};

/** The bit widths the <stdint.h> limit and type macros are named after. */
const STDINT_WIDTHS: readonly number[] = [8, 16, 32, 64];

/**
 * The identifiers the standard headers a generated source includes define.
 * `bool` is the `_Bool` of <stdbool.h> and `size_t` is a typedef, and either
 * one is a diagnostic the C compiler raises on source that runs.
 */
export function cHeaderNames(): Record<string, true> {
  const names: Record<string, true> = {};
  const take = (...taken: string[]): void => {
    for (const name of taken) names[name] = true;
  };
  // <stdbool.h>, and the typedefs of <stddef.h> and <stdint.h>.
  take("bool", "true", "false", "__bool_true_false_are_defined");
  take("size_t", "ssize_t", "ptrdiff_t", "wchar_t", "max_align_t", "nullptr_t");
  take("intmax_t", "uintmax_t", "intptr_t", "uintptr_t");
  // <stdio.h>, <stdlib.h> and <string.h>.
  take("NULL", "EOF", "stdin", "stdout", "stderr");
  take("BUFSIZ", "FILENAME_MAX", "FOPEN_MAX", "TMP_MAX", "L_tmpnam");
  take("SEEK_SET", "SEEK_CUR", "SEEK_END", "_IOFBF", "_IOLBF", "_IONBF");
  take("EXIT_SUCCESS", "EXIT_FAILURE", "RAND_MAX", "MB_CUR_MAX");
  // <math.h>.
  take("M_E", "M_LOG2E", "M_LOG10E", "M_LN2", "M_LN10", "M_PI", "M_PI_2", "M_PI_4");
  take("M_1_PI", "M_2_PI", "M_2_SQRTPI", "M_SQRT2", "M_SQRT1_2");
  take("INFINITY", "NAN", "HUGE_VAL", "HUGE_VALF", "HUGE_VALL");
  take("FP_NAN", "FP_INFINITE", "FP_ZERO", "FP_SUBNORMAL", "FP_NORMAL", "MATH_ERRNO", "MATH_ERREXCEPT");
  // <stdint.h>: the limits that do not follow the width, and the families
  // that are named after it.
  take("SIZE_MAX", "PTRDIFF_MIN", "PTRDIFF_MAX", "INTPTR_MIN", "INTPTR_MAX", "UINTPTR_MAX");
  take("INTMAX_MIN", "INTMAX_MAX", "UINTMAX_MAX", "SIG_ATOMIC_MIN", "SIG_ATOMIC_MAX");
  take("WCHAR_MIN", "WCHAR_MAX", "WINT_MIN", "WINT_MAX");
  for (const width of STDINT_WIDTHS) {
    take(
      `int${width}_t`,
      `uint${width}_t`,
      `int_least${width}_t`,
      `uint_least${width}_t`,
      `int_fast${width}_t`,
      `uint_fast${width}_t`,
      `INT${width}_MIN`,
      `INT${width}_MAX`,
      `UINT${width}_MAX`,
      `INT${width}_C`,
      `UINT${width}_C`,
      `INT_LEAST${width}_MIN`,
      `INT_LEAST${width}_MAX`,
      `UINT_LEAST${width}_MIN`,
      `UINT_LEAST${width}_MAX`,
      `INT_FAST${width}_MIN`,
      `INT_FAST${width}_MAX`,
      `UINT_FAST${width}_MIN`,
      `UINT_FAST${width}_MAX`,
    );
  }
  return names;
}

/**
 * The names the standard headers define as macros, which is the smaller half
 * of what they define and the half that matters in a struct.
 *
 * A struct member is in a namespace of its own, so a member named after a
 * typedef is C the compiler takes: `struct { double size_t; }` declares a
 * member and shadows nothing. A macro is not a name at all, it is a
 * substitution the preprocessor makes in the token stream, so `double bool;`
 * becomes `double _Bool;` and the C compiler turns the declaration away.
 */
export function cMacroNames(): Record<string, true> {
  const names: Record<string, true> = {};
  const take = (...taken: string[]): void => {
    for (const name of taken) names[name] = true;
  };
  // <stdbool.h> defines all of these.
  take("bool", "true", "false", "__bool_true_false_are_defined");
  // <stdio.h>, <stdlib.h> and <math.h>.
  take("NULL", "EOF", "stdin", "stdout", "stderr");
  take("BUFSIZ", "FILENAME_MAX", "FOPEN_MAX", "TMP_MAX", "L_tmpnam");
  take("SEEK_SET", "SEEK_CUR", "SEEK_END", "_IOFBF", "_IOLBF", "_IONBF");
  take("EXIT_SUCCESS", "EXIT_FAILURE", "RAND_MAX", "MB_CUR_MAX");
  take("M_E", "M_LOG2E", "M_LOG10E", "M_LN2", "M_LN10", "M_PI", "M_PI_2", "M_PI_4");
  take("M_1_PI", "M_2_PI", "M_2_SQRTPI", "M_SQRT2", "M_SQRT1_2");
  take("INFINITY", "NAN", "HUGE_VAL", "HUGE_VALF", "HUGE_VALL");
  take("FP_NAN", "FP_INFINITE", "FP_ZERO", "FP_SUBNORMAL", "FP_NORMAL", "MATH_ERRNO", "MATH_ERREXCEPT");
  // <stdint.h>: the limits are macros and the width-named types are typedefs.
  take("SIZE_MAX", "PTRDIFF_MIN", "PTRDIFF_MAX", "INTPTR_MIN", "INTPTR_MAX", "UINTPTR_MAX");
  take("INTMAX_MIN", "INTMAX_MAX", "UINTMAX_MAX", "SIG_ATOMIC_MIN", "SIG_ATOMIC_MAX");
  take("WCHAR_MIN", "WCHAR_MAX", "WINT_MIN", "WINT_MAX");
  for (const width of STDINT_WIDTHS) {
    take(
      `INT${width}_MIN`,
      `INT${width}_MAX`,
      `UINT${width}_MAX`,
      `INT${width}_C`,
      `UINT${width}_C`,
      `INT_LEAST${width}_MIN`,
      `INT_LEAST${width}_MAX`,
      `UINT_LEAST${width}_MIN`,
      `UINT_LEAST${width}_MAX`,
      `INT_FAST${width}_MIN`,
      `INT_FAST${width}_MAX`,
      `UINT_FAST${width}_MIN`,
      `UINT_FAST${width}_MAX`,
    );
  }
  return names;
}

/**
 * The C name a name from the program is written down under: itself when
 * nothing else has it, and the name with an underscore on the end when
 * something does. Appending rather than substituting keeps the generated
 * source readable and keeps a name that is legal C a name that is legal C,
 * which a prefix of the compiler's own choosing would not.
 */
/**
 * How a symbol is spelled in a C declaration, and the assembler label that binds
 * that spelling back to the symbol the object defines.
 *
 * A function called `short` has a symbol an object file may legally define and a
 * C compiler will not accept spelled, so `extern double short(double)` is not a
 * declaration of anything and the link fails on a name the source chose. The
 * declaration is written under a name C will take and carries the symbol beside
 * it, which leaves the object alone: the symbol is still `short`, and the
 * contract that is hashed and cached is unchanged.
 *
 * The two halves are written in two places because that is where C wants them —
 * the name before the parameter list and the label after it — so a declaration is
 * `extern double ${cSymbolName(s)}(double n)${cSymbolLabel(s)};`.
 *
 * A symbol C can already spell is written as it is and carries no label, so the
 * text of a declaration is byte for byte what it was.
 */
export function cSymbolName(symbol: string): string {
  return cEscape(symbol, C_KEYWORDS);
}

/** The label binding a spelled symbol to the symbol itself, or nothing. */
export function cSymbolLabel(symbol: string): string {
  return cSymbolName(symbol) === symbol ? "" : ` __asm__("${symbol}")`;
}

export function cEscape(name: string, reserved: Readonly<Record<string, true>>): string {
  let escaped = name;
  while (reserved[escaped] === true) escaped += "_";
  return escaped;
}

/**
 * A struct member as C spells it: a name that is a C keyword, or one of the
 * macros the headers the generated C includes define, is written with an
 * underscore on the end. A field the source called `long` or `NULL` is a field
 * the C compiler would otherwise refuse.
 *
 * The declaration of a member and every access to it have to agree on that
 * name, so both write it down here rather than one of them escaping and the
 * other not: that is a driver, a harness and a probe the C compiler refuses,
 * for a program the source is entitled to write.
 */
export function cMemberName(name: string): string {
  let escaped = "";
  for (let index = 0; index < name.length; index += 1) {
    // A member is an identifier: a name the source quoted writes its characters
    // a C name cannot carry as the digit or dot they stand for, so every one of
    // them is an underscore the declaration and the access agree on.
    escaped += /[A-Za-z0-9_]/.test(name[index]) ? name[index] : "_";
  }
  if (escaped === "" || /^[0-9]/.test(escaped)) escaped = `_${escaped}`;
  return cEscape(escaped, { ...C_KEYWORDS, ...cMacroNames() });
}

/**
 * How C spells what the IR states. The driver that runs a program and the
 * backend that lowers a function to C both write numbers, text and operators
 * this way, so the rules live here rather than being written twice and left to
 * drift.
 */

/**
 * A string as a C string literal, with everything in it escaped.
 *
 * `?` is escaped because a C compiler in a strict standard mode replaces the
 * trigraphs `??=`, `??!`, `??-` and the rest in translation phase 1, before the
 * source is even tokenised, and the generated C is built with `-std=c11`. A
 * program printing `really??!` would otherwise deliver a binary printing
 * `really|`, with no diagnostic: trigraph replacement is silent without
 * `-Wtrigraphs`.
 *
 * NUL is written `\000` and not `\0` because a C escape keeps consuming octal
 * digits: `\0` followed by `12` is one newline, not a NUL and a `12`.
 */
export function cStringLiteral(text: string): string {
  const escaped = text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\?/g, "\\?")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "\\r")
    .replace(/\0/g, "\\000");
  return `"${escaped}"`;
}

/** The operator the IR states, as C spells it. */
export /**
 * The whole numbers wider than an int, and the suffix that keeps a literal
 * written as one of them at that width. A C integer literal takes its width
 * from its own magnitude, so an i64 written as a bare `1` is an int: `1 << 62`
 * is a shift x86 masks to 5 bits, and the whole operator the resolver settled
 * on 64 bits is evaluated at 32. The suffix puts the width the resolver chose
 * back into the source the C compiler reads.
 */
const C_WIDE_INTEGERS: Record<string, { type: string; suffix: string; low: bigint; high: bigint }> = {
  i64: { type: "int64_t", suffix: "LL", low: -(2n ** 63n), high: 2n ** 63n - 1n },
  u64: { type: "uint64_t", suffix: "ULL", low: 0n, high: 2n ** 64n - 1n },
  usize: { type: "size_t", suffix: "ULL", low: 0n, high: 2n ** 64n - 1n },
  isize: { type: "intptr_t", suffix: "LL", low: -(2n ** 63n), high: 2n ** 63n - 1n },
};

/**
 * How wide an unsigned whole number is, where C spells one narrow enough that
 * a literal is not a `long long` whatever it holds.
 */
const UNSIGNED_WIDTHS: Record<string, number> = { u8: 8, u16: 16, u32: 32 };

/** The value an integer literal is, or null where the text is not one. */
export function integerLiteral(text: string): bigint | null {
  if (/^[+-]?0[xX]/.test(text)) {
    // BigInt takes the sign of a decimal literal only, so a negative
    // hexadecimal one is negated rather than converted with its sign.
    const negative = text.startsWith("-");
    const body = negative ? text.slice(1) : text;
    const clean = body.endsWith("n") ? body.slice(0, -1) : body;
    return (negative ? -1n : 1n) * BigInt(clean);
  }
  const clean = text.endsWith("n") ? text.slice(0, -1) : text;
  return /^[+-]?[0-9]+$/.test(clean) ? BigInt(clean) : null;
}

/** One number as the C type of the value it initializes. */
export function cLiteral(text: string, type: string): string {
  if (type === "bool") return text === "0" ? "false" : "true";
  // A wide number is written as the four limbs it is made of, least significant
  // first, because that is the shape the ABI gives it and the one the kernel
  // reads a pointer to. There is no C literal for the width: an initializer
  // list is the only spelling that says which limb is which, and a decimal
  // constant wide enough would be something the C compiler has never heard of.
  // A negative value is its two's complement limbs, which are the same bits
  // whether the type is read as signed or unsigned; only the struct name differs.
  if (type === "u256" || type === "i256") {
    const value = integerLiteral(text) ?? 0n;
    const limbs = [0, 1, 2, 3].map((limb) => `0x${((value >> BigInt(limb * 64)) & 0xffffffffffffffffn).toString(16)}ULL`);
    // Wrapped in a cast because a braced initializer is a statement rather than
    // an expression in C, and an initializer list is not something a ternary
    // arm or an argument may be written as.
    return `(${type === "i256" ? "blaze_i256" : "blaze_u256"}){${limbs.join(", ")}}`;
  }
  const width = UNSIGNED_WIDTHS[type];
  if (width !== undefined) {
    // A number the source wrote as a negative magnitude and a use settled at an
    // unsigned width is that many bits, not a negative int: `-1 >>> 1` reads
    // `-1` as the unsigned 32 bit number the language reads it as, and C reads
    // `-1` as a signed int and fills the shift with its sign.
    const magnitude = integerLiteral(text);
    if (magnitude !== null && magnitude < 0n) return `${(1n << BigInt(width)) + magnitude}U`;
  }
  const wide = C_WIDE_INTEGERS[type];
  if (wide !== undefined) {
    const value = integerLiteral(text);
    if (value !== null && value >= wide.low && value <= wide.high) return `${text}${wide.suffix}`;
    // A value the type cannot hold as a magnitude is written as the bits it
    // is rather than as that magnitude: a decimal constant too large for any
    // signed type is not something C will read, and the bits are what the
    // width is about.
    if (value !== null) {
      const bits = value < 0n ? (1n << 64n) + value : value;
      return `(${wide.type})0x${bits.toString(16)}ULL`;
    }
  }
  if (type !== "f32" && type !== "f64") return text;
  // A value that is not a number has no decimal to write, and the source writes
  // it as a word: `1 / 0` is `Infinity`, `0 / 0` is `NaN`, and a negative zero
  // keeps its sign in the text. C spells the three of them differently, and the
  // word the source used is a bare identifier there.
  if (text === "Infinity") return `${type === "f32" ? "INFINITY" : "HUGE_VAL"}`;
  if (text === "-Infinity") return `-${type === "f32" ? "INFINITY" : "HUGE_VAL"}`;
  if (text === "NaN") return "NAN";
  if (text === "-0") return "-0.0";
  if (/^[+-]?0[xX]/.test(text)) {
    // BigInt takes the sign of a decimal literal only, so a negative
    // hexadecimal one is negated rather than converted with its sign.
    const negative = text.startsWith("-");
    const digits = negative ? text.slice(1) : text;
    const value = BigInt(digits);
    return `${negative ? "-" : ""}${value.toString()}.0`;
  }
  // A whole number written without a point is an integer in C, and a value too
  // large for one cannot be written that way at all.
  return /^[+-]?[0-9]+$/.test(text) ? `${text}.0` : text;
}


const C_OPERATORS: Record<string, string> = {
  "+": "+",
  "-": "-",
  "*": "*",
  "/": "/",
  // A remainder is the one arithmetic operator the emitter's own table spells
  // that this one did not, so every function using `%` was refused here rather
  // than lowered.
  "%": "%",
  "<<": "<<",
  ">>": ">>",
  ">>>": ">>",
  "&": "&",
  "|": "|",
  "^": "^",
  "<": "<",
  "<=": "<=",
  ">": ">",
  ">=": ">=",
  "==": "==",
  "!=": "!=",
};


/** The operator the IR states, or a refusal naming the one it cannot spell. */
export function cOperator(op: string): string {
  const written = C_OPERATORS[op];
  if (written === undefined) {
    throw new CompilerError({
      category: "LinkError",
      stage: "link",
      message: `C cannot spell the operator ${op}`,
    });
  }
  return written;
}

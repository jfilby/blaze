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
export function cEscape(name: string, reserved: Readonly<Record<string, true>>): string {
  let escaped = name;
  while (reserved[escaped] === true) escaped += "_";
  return escaped;
}

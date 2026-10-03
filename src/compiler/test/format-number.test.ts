/**
 * That the whole-number fast path in the number formatter writes exactly what
 * the search it short-circuits would have written.
 *
 * A `f64` reaches the runtime and comes back as the text a program prints, and
 * the build compares that text against the source that produced it, so the two
 * forms of the formatter have to agree on every number and not only on the
 * round ones. The reference below is the search the fast path replaces, copied
 * out of the same source, so what is compared is the two implementations of the
 * same rule rather than two hand-written expectations.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../core/process.ts";
import { runtimeHeaderSource, runtimeSourceSource } from "../runtime/abi.ts";
import { scratch } from "./scratch.ts";

test("the whole-number path writes what the search it replaces writes", async () => {
  const directory = await scratch("blaze-fmt-");
  await writeFile(join(directory, "blaze_rt.h"), runtimeHeaderSource());
  await writeFile(join(directory, "blaze_rt.c"), runtimeSourceSource("danger"));

  // The search the fast path replaces, copied verbatim out of the same source, so
  // the two are compared against each other rather than against an expectation.
  await writeFile(
    join(directory, "reference.c"),
    `
  #include <math.h>
  #include <stdio.h>
  #include <stdlib.h>
  #include <string.h>

  size_t reference_format(double value, char* buffer, size_t size) {
    if (isnan(value)) { strcpy(buffer, "NaN"); return 3; }
    if (isinf(value)) { if (signbit(value)) { strcpy(buffer, "-Infinity"); return 9; } strcpy(buffer, "Infinity"); return 8; }
    if (value == 0.0) { strcpy(buffer, "0"); return 1; }
    const int negative = signbit(value);
    const double magnitude = negative ? -value : value;
    char text[40];
    int low = 0, high = 16;
    while (low < high) {
      const int middle = (low + high) / 2;
      snprintf(text, sizeof text, "%.*e", middle, magnitude);
      if (strtod(text, NULL) == magnitude) high = middle; else low = middle + 1;
    }
    snprintf(text, sizeof text, "%.*e", low, magnitude);
    char digits[24];
    int count = 0, exponent = 0;
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
        written[used++] = '0'; written[used++] = '.';
        for (int index = 0; index < -point; index += 1) written[used++] = '0';
        memcpy(written + used, digits, (size_t)count); used += count;
      } else if (point >= count) {
        memcpy(written + used, digits, (size_t)count); used += count;
        for (int index = 0; index < point - count; index += 1) written[used++] = '0';
      } else {
        memcpy(written + used, digits, (size_t)point); used += point;
        written[used++] = '.';
        memcpy(written + used, digits + point, (size_t)(count - point)); used += count - point;
      }
      written[used] = '\\0';
    } else {
      written[used++] = digits[0];
      if (count > 1) { written[used++] = '.'; memcpy(written + used, digits + 1, (size_t)(count - 1)); used += count - 1; }
      written[used++] = 'e';
      int scale = point - 1;
      if (scale < 0) { written[used++] = '-'; scale = -scale; } else { written[used++] = '+'; }
      char scale_text[4];
      int scale_count = 0;
      do { scale_text[scale_count++] = (char)('0' + (scale % 10)); scale /= 10; } while (scale > 0);
      while (scale_count > 0) written[used++] = scale_text[--scale_count];
      written[used] = '\\0';
    }
    const size_t length = strlen(written);
    if (length >= size) return 0;
    memcpy(buffer, written, length + 1);
    return length;
  }
  `,
    "utf8",
  );

  await writeFile(
    join(directory, "t.c"),
    `
  #include <stdio.h>
  #include <string.h>
  #include <math.h>
  #include <stdint.h>
  #include "blaze_rt.h"
  size_t reference_format(double value, char* buffer, size_t size);

  static int check(double value) {
    char mine[64], theirs[64];
    size_t a = blaze_rt_format_number(value, mine, sizeof mine);
    size_t b = reference_format(value, theirs, sizeof theirs);
    if (a != b || strcmp(mine, theirs) != 0) {
      printf("MISMATCH %.20g: runtime=[%s](%zu) reference=[%s](%zu)\\n", value, mine, a, theirs, b);
      return 1;
    }
    return 0;
  }

  int main(void) {
    int bad = 0;
    double special[] = {0.0, -0.0, 1.0, -1.0, 9.0, 10.0, 42.0, 99.0, 100.0, 101.0, 1234.0, 999999.0,
                        1e15, 1e16, 1e18, 1e20, 1e21, 9007199254740992.0, 4503599627370496.5,
                        0.1, 0.2, 0.5, 1.5, 2.5, 1e-6, 1e-7, 3.14159265358979, 2.718281828459045,
                        1e100, 1e-100, 123456789.123456};
    for (unsigned i = 0; i < sizeof special / sizeof *special; i += 1) { bad += check(special[i]); bad += check(-special[i]); }
    for (long long n = -100000; n <= 100000; n += 1) { bad += check((double)n); }
    for (uint64_t n = 1; n < 1000000; n = n * 7 + 3) { bad += check((double)n); bad += check(-(double)n); }
    uint64_t seed = 88172645463325252ULL;
    for (int i = 0; i < 40000; i += 1) {
      seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17;
      bad += check((double)(int64_t)seed);
      bad += check((double)(seed % 1000000007ULL) / 1000.0);
    }
    printf(bad == 0 ? "all agree\\n" : "%d disagreements\\n", bad);
    return bad != 0;
  }
  `,
    "utf8",
  );

  const built = run("gcc", ["-std=c11", "-O1", "-o", join(directory, "t"), join(directory, "t.c"), join(directory, "reference.c"), join(directory, "blaze_rt.c"), "-I", directory, "-lm"], { timeoutMs: 120_000 });
  assert.equal(built.code, 0, `the comparison must build:\n${built.stderr}`);
  const ran = run(join(directory, "t"), [], { timeoutMs: 300_000 });
  assert.match(ran.stdout, /all agree/, `the two must agree on every number:\n${ran.stdout.trim()}`);
});


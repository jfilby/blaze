/**
 * That the runtime's JSON reads a document as the language does and writes it
 * back as the language writes it.
 *
 * The compiler delivers a program that is compared against the source that
 * produced it, and a program that reads a document and writes it out is
 * compared through the runtime: the numbers a document holds come back as the
 * numbers the language writes, a string with an escape in it comes back as the
 * escapes the language uses, and a document read and written again is the same
 * document, which is what `JSON.stringify(JSON.parse(text))` is asked to be.
 *
 * The three things worth a test rather than a review are the ones that are not
 * obvious from the source: that the fast path a number is read through answers
 * the double the decimal names rather than a smaller one near it, that a text
 * is escaped by what the grammar reserves and not by what a program happened to
 * write, and that a number the formatter has been asked for once and again
 * answers the same thing the second time — the formatter keeps its answer, and
 * the keeping is what this checks it does not get wrong.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../core/process.ts";
import { runtimeHeaderSource, runtimeSourceSource } from "../runtime/abi.ts";
import { scratch } from "./scratch.ts";

test("the runtime reads a document and writes it back as the same document", async () => {
  const directory = await scratch("blaze-json-");
  await writeFile(join(directory, "blaze_rt.h"), runtimeHeaderSource());
  await writeFile(join(directory, "blaze_rt.c"), runtimeSourceSource("danger"));

  await writeFile(
    join(directory, "t.c"),
    `
  #include <stdint.h>
  #include <stdio.h>
  #include <string.h>
  #include "blaze_rt.h"

  static int failures = 0;

  static void expect(const char* what, const char* got, const char* wanted) {
    if (strcmp(got, wanted) == 0) return;
    printf("  %s\\n    got      %s\\n    expected %s\\n", what, got, wanted);
    failures += 1;
  }

  /* The document a text is read as, written back as a document. */
  static const char* round_trip(const char* json) {
    const double parsed = blaze_rt_json_parse((double)(uintptr_t)json);
    return blaze_rt_to_text(blaze_rt_json_stringify(parsed));
  }

  static void expect_round_trip(const char* json, const char* wanted) {
    expect(json, round_trip(json), wanted);
  }

  /* A number is read as the double the decimal names, exactly. The values are
     the ones the C library answers for the same text, which is the answer a
     source program is compared against. */
  static void expect_number(const char* text, double wanted) {
    const double read = blaze_rt_to_number(blaze_rt_json_parse((double)(uintptr_t)text));
    if (memcmp(&read, &wanted, sizeof read) == 0) return;
    printf("  %s was read as %.20g and not %.20g\\n", text, read, wanted);
    failures += 1;
  }

  int main(void) {
    blaze_rt_initialize();

    /* A document comes back as the document it is. */
    expect_round_trip("{\\"a\\":1,\\"b\\":[true,false,null],\\"c\\":\\"x\\"}",
                      "{\\"a\\":1,\\"b\\":[true,false,null],\\"c\\":\\"x\\"}");
    expect_round_trip("{\\"n\\":12.5,\\"z\\":7.25,\\"s\\":99.99}", "{\\"n\\":12.5,\\"z\\":7.25,\\"s\\":99.99}");
    expect_round_trip("[[[[1]]],{\\"a\\":{\\"b\\":{\\"c\\":[1,2,3]}}}]",
                      "[[[[1]]],{\\"a\\":{\\"b\\":{\\"c\\":[1,2,3]}}}]");
    expect_round_trip("{\\"empty\\":{},\\"arr\\":[],\\"neg\\":-2.5e-3}", "{\\"empty\\":{},\\"arr\\":[],\\"neg\\":-0.0025}");

    /* A string with an escape in it is read as the bytes it stands for and
       written as the escapes those bytes need, which is not the same set: a
       slash needs no escape and a character below a space has no other form. */
    expect_round_trip("{\\"q\\":\\"a\\\\\\"b\\\\\\\\c\\\\/d\\\\n\\\\t\\\\u00e9\\"}",
                      "{\\"q\\":\\"a\\\\\\"b\\\\\\\\c/d\\\\n\\\\t\\xc3\\xa9\\"}");
    expect_round_trip("{\\"k\\\\u0001ey\\":\\"\\\\u0001\\\\u001f\\"}",
                      "{\\"k\\\\u0001ey\\":\\"\\\\u0001\\\\u001f\\"}");

    /* A number is written where the language writes it: in full from 1e-6 up
       to 1e21, and with an exponent outside that range. A whole number holds
       only up to 2^53, so a longer one is the number it rounds to. */
    expect_round_trip("[1e2,1e-7,1.5e300,12345678901234567890,0.1,1.0,-0]",
                      "[100,1e-7,1.5e+300,12345678901234567000,0.1,1,0]");
    expect_round_trip("[9007199254740993,123456789012345678901234567890]",
                      "[9007199254740992,1.2345678901234568e+29]");

    /* The top level is a value of any shape, and a text at the top is quoted
       where a text inside a document is. */
    expect_round_trip("\\"abc\\"", "\\"abc\\"");
    expect_round_trip("123", "123");
    expect_round_trip("null", "null");
    expect_round_trip("true", "true");

    /* A document is read the way the grammar writes one and space is not part
       of it at any depth. */
    expect_round_trip("  [ 1 , 2 ]  ", "[1,2]");
    expect_round_trip("{\\n  \\"a\\" : [ 1 ]\\n}", "{\\"a\\":[1]}");

    expect_number("0", 0.0);
    expect_number("-0", -0.0);
    expect_number("7", 7.0);
    expect_number("-7", -7.0);
    expect_number("12.5", 12.5);
    expect_number("7.25", 7.25);
    expect_number("99.99", 99.99);
    expect_number("1e2", 100.0);
    expect_number("1E+2", 100.0);
    expect_number("1e-2", 0.01);
    expect_number("-2.5e-3", -0.0025);
    expect_number("0.1", 0.1);
    expect_number("3.141592653589793", 3.141592653589793);
    expect_number("12345678901234567890", 12345678901234567000.0);
    expect_number("1.7976931348623157e308", 1.7976931348623157e308);
    expect_number("5e-324", 5e-324);
    expect_number("2.2250738585072014e-308", 2.2250738585072014e-308);

    /* A value the formatter has been asked for once is asked for again by
       interleaving it with other values, which is what a program that writes
       one field of a row of records does. */
    {
      static const double values[] = { 12.5, 7.25, 99.99, 0.1, -0.0025, 1e21, 1e-7, 1.0 / 3.0 };
      const size_t count = sizeof values / sizeof *values;
      char first[8][64];
      for (size_t i = 0; i < count; i += 1) {
        const size_t written = blaze_rt_format_number(values[i], (unsigned char*)first[i], sizeof first[i]);
        first[i][written] = '\\0';
      }
      for (int pass = 0; pass < 4; pass += 1) {
        for (size_t i = count; i > 0; i -= 1) {
          char again[64];
          const size_t written = blaze_rt_format_number(values[i - 1], (unsigned char*)again, sizeof again);
          again[written] = '\\0';
          expect(first[i - 1], again, first[i - 1]);
        }
      }
      /* A buffer smaller than the answer holds the part of it that fits. */
      char small[4];
      const size_t written = blaze_rt_format_number(12.5, (unsigned char*)small, sizeof small);
      small[written] = '\\0';
      expect("a short buffer", small, "12.");
    }

    /* The digest a hasher is asked for is the digest of what was fed to it. */
    {
      const double hasher = blaze_rt_md5_update(blaze_rt_md5_create(), "the quick brown fox jumps over the lazy dog");
      expect("md5", blaze_rt_to_text(blaze_rt_md5_digest(hasher)), "77add1d5f41223d5582fca736a5cb335");
    }

    blaze_rt_finalize();
    printf(failures == 0 ? "all agree\\n" : "%d disagreements\\n", failures);
    return failures != 0;
  }
  `,
    "utf8",
  );

  const built = run(
    "gcc",
    ["-std=c11", "-O1", "-o", join(directory, "t"), join(directory, "t.c"), join(directory, "blaze_rt.c"), "-I", directory, "-lm", "-pthread"],
    { timeoutMs: 120_000 },
  );
  assert.equal(built.code, 0, `the check must build:\n${built.stderr}`);
  const ran = run(join(directory, "t"), [], { timeoutMs: 120_000 });
  assert.match(ran.stdout, /all agree/, `the runtime must agree on every document:\n${ran.stdout.trim()}`);
});

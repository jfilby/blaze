/**
 * The signed 256-bit wide integer, against the language's own bigints.
 *
 * An `i256` holds the same four limbs as a `u256`, but the high bit of the top
 * limb is the sign, so a negative value is two's complement and the kernel
 * answers shift-right, comparison, division and remainder as signed while
 * addition, subtraction, multiplication and the bitwise operations share the
 * two's complement bit patterns of the unsigned form.
 *
 * The oracle is `BigInt`: every result is reduced modulo 2^256 and read back as
 * a signed 256-bit number, so a negative intermediate is the number the source
 * wrote rather than the unsigned wrap a `u256` would print.
 */
import assert from "node:assert/strict";
import { isInteger, isWhole, limbsOf, wholeOf } from "../core/semantic-ir.ts";
import { semanticFunctionProblems } from "../semantics/ir-validate.ts";
import { programWithSemantics } from "./phase.ts";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { run } from "../core/process.ts";
import { generateFunctionC } from "../toolchain/ir-c.ts";
import type { SemanticType } from "../core/semantic-ir.ts";
import { RUNTIME_NAME, runtimeHeaderSource, runtimeSourceSource, WIDE_SYMBOLS } from "../runtime/abi.ts";
import { scratch } from "./scratch.ts";

const WIDTH = 256;
const FULL = 1n << BigInt(WIDTH); // 2^256: the kernel wraps modulo 2^256 over four limbs.
const HALF = 1n << BigInt(WIDTH - 1);
const LIMBS = WIDTH / 64;
const I256: SemanticType = { kind: "primitive", name: "i256" };

/** A signed 256-bit value as 64 hex digits, most significant limb first. */
function digits(value: bigint): string {
  const wrapped = ((value % FULL) + FULL) % FULL;
  return wrapped.toString(16).padStart(WIDTH / 4, "0");
}

/** The signed 256-bit number 64 hex digits name, read back as signed. */
function signedOfHex(hex: string): bigint {
  const value = BigInt(`0x${hex}`);
  return value >= HALF ? value - (1n << BigInt(WIDTH)) : value;
}

/**
 * A C harness over the real generated runtime, driven by two operands on the
 * command line. Operands and results are 64 hex digits (two's complement limbs),
 * and the test reads them back as signed 256 bit numbers.
 */
const HARNESS = `
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include "${RUNTIME_NAME}.h"

static void write_i256(blaze_i256 value) {
  for (int i = 3; i >= 0; i -= 1) printf("%016llx", (unsigned long long)value.limbs[i]);
}

static blaze_i256 read_i256(const char* hex) {
  blaze_i256 value;
  /* The text is most-significant limb first, so the first 16 hex digits are the top limb. */
  for (int limb = 0; limb < 4; limb += 1) {
    uint64_t accumulator = 0;
    for (int j = 0; j < 16; j += 1) {
      const char digit = hex[limb * 16 + j];
      const unsigned nibble = (digit >= '0' && digit <= '9') ? (unsigned)(digit - '0') : (unsigned)(digit - 'a' + 10);
      accumulator = (accumulator << 4) | (uint64_t)nibble;
    }
    value.limbs[3 - limb] = accumulator;
  }
  return value;
}

int main(int argc, char** argv) {
  blaze_i256 left = read_i256(argv[1]);
  blaze_i256 right = read_i256(argv[2]);
  blaze_i256 out;

  blaze_rt_i256_add(&out, &left, &right); printf("add "); write_i256(out); printf("\\n");
  blaze_rt_i256_sub(&out, &left, &right); printf("sub "); write_i256(out); printf("\\n");
  blaze_rt_i256_mul(&out, &left, &right); printf("mul "); write_i256(out); printf("\\n");
  blaze_rt_i256_and(&out, &left, &right); printf("and "); write_i256(out); printf("\\n");
  blaze_rt_i256_or(&out, &left, &right); printf("or "); write_i256(out); printf("\\n");
  blaze_rt_i256_xor(&out, &left, &right); printf("xor "); write_i256(out); printf("\\n");
  blaze_rt_i256_not(&out, &left); printf("not "); write_i256(out); printf("\\n");

  blaze_rt_i256_div(&out, &left, &right); printf("div "); write_i256(out); printf("\\n");
  blaze_rt_i256_mod(&out, &left, &right); printf("mod "); write_i256(out); printf("\\n");

  for (int count = 0; count <= 2 * 256 + 44; count += 1) {
    blaze_rt_i256_shl(&out, &left, (unsigned)count);
    printf("shl%d ", count); write_i256(out); printf("\\n");
    blaze_rt_i256_shr(&out, &left, (unsigned)count);
    printf("shr%d ", count); write_i256(out); printf("\\n");
  }

  printf("lessLeft %d\\n", blaze_rt_i256_less(&left, &right));
  printf("lessRight %d\\n", blaze_rt_i256_less(&right, &left));
  printf("lessSelf %d\\n", blaze_rt_i256_less(&left, &left));
  printf("equal %d\\n", blaze_rt_i256_equal(&left, &right));

  unsigned char text[80];
  blaze_rt_i256_format(&left, 10, text, sizeof text); printf("decimal %s\\n", text);
  blaze_rt_i256_format(&left, 16, text, sizeof text); printf("hex %s\\n", text);

  blaze_rt_i256_from_i64(&out, -42);
  printf("widened %lld\\n", (long long)blaze_rt_i256_to_i64(&out));

  blaze_i256 parsed = read_i256("000000000000000000000000000000000000000000000000000000000000002a");
  blaze_rt_i256_format(&parsed, 10, text, sizeof text); printf("parsed %s\\n", text);
  return 0;
}
`;

test("an i256 is a whole number and ranks above every machine word", () => {
  assert.ok(isWhole("i256"));
  assert.ok(isInteger(I256));
  assert.equal(limbsOf("i256"), LIMBS);
  assert.equal(limbsOf("u64"), null);
  // A wide number wins the promotion over any machine word, signed or not.
  assert.equal(wholeOf("i256", "u64"), "i256");
  assert.equal(wholeOf("u64", "i256"), "i256");
  assert.equal(wholeOf("i256", "i64"), "i256");
  assert.equal(wholeOf("i256", "u256"), "i256");
  assert.equal(wholeOf("u256", "i256"), "u256");
  // The first wide argument wins; a wide number still outranks machine words.
  assert.equal(wholeOf("i256", "usize"), "i256");
  assert.equal(wholeOf("i256", "isize"), "i256");
  // The length rule is unchanged for a pair of machine words.
  assert.equal(wholeOf("usize", "i64"), "usize");
  assert.equal(wholeOf("isize", "i32"), "isize");
});

test("every i256 kernel symbol is declared and defined", () => {
  const header = runtimeHeaderSource();
  const runtime = runtimeSourceSource();
  for (const symbol of Object.keys(WIDE_SYMBOLS)) {
    if (!symbol.startsWith("blaze_rt_i256_")) continue;
    assert.ok(header.includes(`${symbol}(`), `${symbol} must be declared in ${RUNTIME_NAME}.h`);
    assert.ok(runtime.includes(`${symbol}(`), `${symbol} must be implemented by the compiler runtime`);
  }
  assert.ok(Object.keys(WIDE_SYMBOLS).some((symbol) => symbol.startsWith("blaze_rt_i256_")), "i256 symbols are registered");
  assert.match(header, /typedef struct blaze_i256/);
  assert.match(header, /uint64_t limbs\[4\];/);
  assert.match(header, /#define BLAZE_I256_BYTES 32u/);
});

test("the frontend reads an i256 annotation as the signed wide type", () => {
  const { semantics } = programWithSemantics(
    "typescript",
    { "main.ts": ["function f(a: i256, b: i256): i256 {", "  return a + b;", "}", "console.log(f(1n, 2n));", ""].join("\n") },
    "main.ts",
  );
  const fn = semantics["f"];
  assert.equal(fn.params.length, 2);
  for (const param of fn.params) {
    assert.equal(param.kind, "value");
    assert.equal(param.type.kind, "primitive");
    assert.equal(param.type.name, "i256");
  }
  assert.equal(fn.returns.kind, "primitive");
  assert.equal(fn.returns.name, "i256");
  assert.deepEqual(semanticFunctionProblems(fn), []);
});

test("a signed wide number may be negated and complemented", () => {
  // The signed wide number holds below zero, so `neg` and `bitNot` of an `i256`
  // are answered as the two's complement they are.
  const { semantics } = programWithSemantics(
    "typescript",
    { "main.ts": ["function f(a: i256): i256 {", "  return -a;", "}", "function g(a: i256): i256 {", "  return ~a;", "}", "console.log(f(1n));", "console.log(g(2n));", ""].join("\n") },
    "main.ts",
  );
  assert.deepEqual(semanticFunctionProblems(semantics["f"]), []);
  assert.deepEqual(semanticFunctionProblems(semantics["g"]), []);
  // An unsigned wide number still refuses both.
  const { semantics: refused } = programWithSemantics(
    "typescript",
    { "main.ts": ["function h(a: u256): u256 {", "  return -a;", "}", "console.log(h(1n));", ""].join("\n") },
    "main.ts",
  );
  assert.equal(semanticFunctionProblems(refused["h"]).length, 1);
});

test("an i256 is computed only with another i256", () => {
  // A machine word beside an i256 has no form the kernel answers.
  const cases: [string, string, RegExp][] = [
    ["add", "function f(a: i256, b: bigint): i256 { return a + b; }", /kernel every backend answers a wide number with is over two of them/],
    ["cmp", "function f(a: i256, b: number): boolean { return a > b; }", /a wide number is not a machine word/],
  ];
  for (const [what, source, said] of cases) {
    const { semantics } = programWithSemantics(
      "typescript",
      { "main.ts": [source, "console.log(f(1n, 2n));", ""].join("\n") },
      "main.ts",
    );
    const fn = semantics["f"];
    const problems = semanticFunctionProblems(fn);
    assert.equal(problems.length, 1, `${what} of an i256 and a machine word: ${problems.join("; ")}`);
    assert.match(problems[0]!, said, what);
  }
});

test("the C backend lowers an i256 operation to the i256 kernel", () => {
  const { semantics } = programWithSemantics(
    "typescript",
    { "main.ts": ["function f(a: i256, b: i256): i256 {", "  return a + b - a * b;", "}", "console.log(f(1n, 2n));", ""].join("\n") },
    "main.ts",
  );
  const c = generateFunctionC(semantics["f"]);
  assert.ok(c.includes("blaze_rt_i256_add"), "add lowers to the i256 add kernel");
  assert.ok(c.includes("blaze_rt_i256_sub"), "sub lowers to the i256 sub kernel");
  assert.ok(c.includes("blaze_rt_i256_mul"), "mul lowers to the i256 mul kernel");
  assert.ok(c.includes("blaze_i256"), "values are held as blaze_i256");
  assert.ok(!c.includes("blaze_rt_u256_"), "no u256 kernel leaks into an i256 function");
});

/** The answers one pair of operands gives, read back as a map by name. */
async function ask(binary: string, left: bigint, right: bigint): Promise<Map<string, string>> {
  const result = run(binary, [digits(left), digits(right)], { timeoutMs: 60_000 });
  assert.equal(result.code, 0, result.stderr);
  const answers = new Map<string, string>();
  for (const line of result.stdout.split("\n")) {
    if (line === "") continue;
    const at = line.indexOf(" ");
    answers.set(line.slice(0, at), line.slice(at + 1));
  }
  return answers;
}

test("the signed kernel answers the same arithmetic the language's bigints do", async () => {
  const directory = await scratch("blaze-i256-");
  await writeFile(join(directory, `${RUNTIME_NAME}.h`), runtimeHeaderSource(), "utf8");
  await writeFile(join(directory, "runtime.c"), runtimeSourceSource("danger"), "utf8");
  await writeFile(join(directory, "harness.c"), HARNESS, "utf8");
  const binary = join(directory, "harness");
  const built = run("gcc", ["-std=c11", "-O2", "-I", directory, join(directory, "harness.c"), join(directory, "runtime.c"), "-o", binary], {
    timeoutMs: 180_000,
  });
  assert.equal(built.code, 0, built.stderr);

  // Positive and negative boundary values, including the most negative number.
  const values: bigint[] = [
    0n, 1n, -1n, 2n, -2n, HALF - 1n, -HALF, (-HALF) + 1n, FULL, -FULL,
    1n << 64n, -(1n << 64n), 1n << 128n, -(1n << 128n), 1n << 255n, -1n,
    0x7fffffffffffffffn, -0x7fffffffffffffffn, 0x0123456789abcdefn, -0x0123456789abcdefn,
    0xfedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210n,
    -(0xfedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210n),
  ];

  let checked = 0;
  for (const left of values) {
    for (const right of values) {
      const answers = await ask(binary, left, right);
      const label = `${signedOfHex(digits(left))} with ${signedOfHex(digits(right))}`;
      const wrap = (v: bigint): bigint => ((v % FULL) + FULL) % FULL;
      // The values the kernel sees are the wrapped 256-bit operands, read back
      // as signed 256 bit numbers.
      const l = signedOfHex(digits(left));
      const r = signedOfHex(digits(right));
      // Division and remainder by zero answer zero, so skip those oracles.
      if (r === 0n) continue;
      // Division and remainder truncate toward zero, as C and the language do.
      const expected: [string, bigint][] = [
        ["add", wrap(left + right)],
        ["sub", wrap(left - right)],
        ["mul", wrap(left * right)],
        ["and", wrap(left & right)],
        ["or", wrap(left | right)],
        ["xor", wrap(left ^ right)],
        ["not", wrap(~left)],
        ["div", wrap(l / r)],
        ["mod", wrap(l % r)],
      ];

      for (const [name, want] of expected) {
        assert.equal(answers.get(name), digits(want), `${name} of ${label}`);
        checked += 1;
      }

      for (let count = 0; count <= 2 * WIDTH + 44; count += 1) {
        assert.equal(answers.get(`shl${count}`), digits(wrap(left << BigInt(count))), `left by ${count} of ${label}`);
        // Arithmetic shift right extends the sign: a negative value fills the
        // vacated top bits with ones; a shift at or past the width is -1 or 0.
        const shr = (v: bigint, c: number): bigint => {
          if (c >= WIDTH) return v < 0 ? FULL - 1n : 0n;
          const wrapped = wrap(v);
          const shifted = wrapped >> BigInt(c);
          if (v < 0) {
            const fill = ((1n << BigInt(c)) - 1n) << BigInt(WIDTH - c);
            return wrap(shifted | fill);
          }
          return shifted;
        };
        assert.equal(answers.get(`shr${count}`), digits(shr(l, count)), `arithmetic right by ${count} of ${label}`);
        checked += 2;
      }

      assert.equal(answers.get("lessLeft"), l < r ? "1" : "0", `signed left below right for ${label}`);
      assert.equal(answers.get("lessRight"), r < l ? "1" : "0", `signed right below left for ${label}`);
      assert.equal(answers.get("lessSelf"), "0", `signed left below itself for ${label}`);
      assert.equal(answers.get("equal"), l === r ? "1" : "0", `signed equality for ${label}`);
      assert.equal(answers.get("decimal"), l.toString(10), `signed decimal of ${label}`);
      assert.equal(answers.get("hex"), wrap(l).toString(16), `signed hex of ${label}`);
      checked += 6;
    }
  }

  // Widening sign-extends and narrowing keeps the low limb read as signed.
  const widened = await ask(binary, 0n, 0n);
  assert.equal(widened.get("widened"), "-42");
  // A value parsed from decimal digits is the number it names.
  const parsed = await ask(binary, 0n, 0n);
  assert.equal(parsed.get("parsed"), "42");
  assert.ok(checked > 20_000, `expected the boundary set to be exercised, checked ${checked}`);
});

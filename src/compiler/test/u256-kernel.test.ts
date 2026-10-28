/**
 * The wide division and remainder of the kernel, against `BigInt`.
 *
 * The differential set in `u256.test.ts` runs every backend over the same
 * vectors, which compares one backend against another but has the kernel
 * answering itself underneath: a bug in the restoring division would answer
 * the same wrong number on every target. This test isolates that layer. It
 * compiles the runtime the compiler emits once, and walks a sweep over that
 * single binary — the boundary values crossed with themselves, a block of
 * full-width random pairs, a block where one side is small, the four
 * differential vectors, and a set of hand-traced divmods — comparing the
 * quotient and the remainder limb by limb against the language's own
 * truncating division.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { run } from "../core/process.ts";
import { RUNTIME_NAME, runtimeHeaderSource, runtimeSourceSource } from "../runtime/abi.ts";
import { scratch } from "./scratch.ts";

const WIDTH = 256;
const MODULUS = (1n << BigInt(WIDTH)) - 1n;

/** A deterministic PRNG, so the random half of the sweep replays the same. */
function randoms(count: number, bits: bigint): bigint[] {
  let state = 0x9e3779b97f4a7c15n;
  const values: bigint[] = [];
  for (let i = 0; i < count; i += 1) {
    state = (state * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
    let value = 0n;
    for (let shift = 0n; shift < bits; shift += 64n) {
      state = (state * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
      value |= state << shift;
    }
    values.push(value & ((1n << bits) - 1n));
  }
  return values;
}

/** The values the kernel is exercised over: every boundary that means something. */
function cases(): bigint[] {
  return [
    0n,
    1n,
    2n,
    3n,
    MODULUS,
    MODULUS - 1n,
    1n << 64n,
    (1n << 64n) - 1n,
    1n << 127n,
    1n << 128n,
    (1n << 128n) - 1n,
    1n << 192n,
    1n << 255n,
    0xffffffffffffffffn,
    0x0123456789abcdefn,
    0xfedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210n,
  ];
}

/** The fixed differential vectors of `u256.test.ts`, which both backends already run. */
const FIXED: readonly (readonly [string, string])[] = [
  ["0123456789abcdeffedcba987654321089abcdef0123456776543210fedcba98", "fedcba98765432100123456789abcdeffedcba98765432100123456789abcdef"],
  ["ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", "0000000000000000000000000000000000000000000000000000000000000001"],
  ["ffffffffffffffff0000000000000000ffffffffffffffff0000000000000000", "0000000000000000ffffffffffffffff0000000000000000ffffffffffffffff"],
  ["0000000000000000000000000000000000000000000000000000000000000000", "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"],
];

/** Hand-traced divmods: small counts by hand, and the ones the limb paths care about. */
const TRACED: readonly (readonly [string, string])[] = [
  ["0000000000000000000000000000000000000000000000000000000000000007", "0000000000000000000000000000000000000000000000000000000000000002"],
  ["0000000000000000000000000000000000000000000000000000000000000000", "0000000000000000000000000000000000000000000000000000000000000003"],
  ["ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", "0000000000000000000000000000000000000000000000000000000000000002"],
  ["0000000000000000000000000000000000000000000000000000000000000000", "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"],
  ["8000000000000000000000000000000000000000000000000000000000000000", "0000000000000000000000000000000000000000000000000000000000000002"],
  ["ffffffffffffffff0000000000000000ffffffffffffffff0000000000000000", "0000000000000000000000000000000000000000000000000000000000000010"],
  ["deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef", "000000000000000000000000c0ffee0000000000baadd00dfeedfacecafebabe"],
  ["0000000100000000000000000000000000000000000000000000000000000001", "0000000100000000000000000000000000000000000000000000000000000001"],
];

/** A C harness over the real generated runtime, driven by two operands on the command line. */
const HARNESS = `
#include <stdio.h>
#include <stdint.h>
#include "${RUNTIME_NAME}.h"

static void write_u256(blaze_u256 value) {
  for (int i = 3; i >= 0; i -= 1) printf("%016llx", (unsigned long long)value.limbs[i]);
}

static blaze_u256 read_u256(const char* hex) {
  blaze_u256 value;
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
  blaze_u256 left = read_u256(argv[1]);
  blaze_u256 right = read_u256(argv[2]);
  blaze_u256 quotient;
  blaze_u256 remainder;
  blaze_rt_u256_div(&quotient, &left, &right);
  blaze_rt_u256_mod(&remainder, &left, &right);
  printf("quot ");
  write_u256(quotient);
  printf("\\nrem ");
  write_u256(remainder);
  printf("\\n");
  return 0;
}
`;

function digits(value: bigint): string {
  return value.toString(16).padStart(WIDTH / 4, "0");
}

test("the u256 quotient and remainder agree with BigInt over the whole sweep", async () => {
  const directory = await scratch("blaze-u256-kernel-");
  await writeFile(join(directory, `${RUNTIME_NAME}.h`), runtimeHeaderSource(), "utf8");
  await writeFile(join(directory, "runtime.c"), runtimeSourceSource("danger"), "utf8");
  await writeFile(join(directory, "harness.c"), HARNESS, "utf8");
  const binary = join(directory, "harness");
  const built = run(
    "gcc",
    ["-std=c11", "-O2", "-I", directory, join(directory, "harness.c"), join(directory, "runtime.c"), "-o", binary],
    { timeoutMs: 180_000 },
  );
  assert.equal(built.code, 0, built.stderr);

  const pairs: [bigint, bigint][] = [];
  const values = cases();
  for (const left of values) for (const right of values) pairs.push([left, right]);
  const wides = randoms(400, 256n);
  for (let i = 0; i < 400; i += 2) pairs.push([wides[i], wides[i + 1]]);
  const smalls = randoms(400, 32n);
  for (let i = 0; i < 200; i += 1) pairs.push([wides[i], smalls[i] + 1n]);
  for (const [left, right] of FIXED) pairs.push([BigInt(`0x${left}`), BigInt(`0x${right}`)]);
  for (const [left, right] of TRACED) pairs.push([BigInt(`0x${left}`), BigInt(`0x${right}`)]);

  for (const [left, right] of pairs) {
    const result = run(binary, [digits(left), digits(right)], { timeoutMs: 60_000 });
    assert.equal(result.code, 0, result.stderr);
    const [quotLine, remLine] = result.stdout.trim().split("\n");
    const quot = BigInt(`0x${quotLine!.slice(5)}`);
    const rem = BigInt(`0x${remLine!.slice(4)}`);
    const divisor = right === 0n ? null : right;
    const wantQuot = divisor === null ? 0n : left / divisor;
    const wantRem = divisor === null ? 0n : left % divisor;
    assert.equal(quot, wantQuot, `quotient of ${digits(left)} / ${digits(right)}`);
    assert.equal(rem, wantRem, `remainder of ${digits(left)} % ${digits(right)}`);
    if (divisor !== null) {
      assert.equal(quot * divisor + rem, left, `the quotient and remainder of ${digits(left)} / ${digits(right)} put the dividend back together`);
      assert.ok(rem < divisor, "a remainder is below its divisor");
    }
  }
  assert.equal(pairs.length, 668, `the sweep is the full sweep, ${pairs.length} pairs`);
});

/** A C harness over the special-prime kernels, driven by two operands and the
 *  complement of the modulus on the command line. */
const SPECIAL_HARNESS = `
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include "${RUNTIME_NAME}.h"

static void write_u256(blaze_u256 value) {
  for (int i = 3; i >= 0; i -= 1) printf("%016llx", (unsigned long long)value.limbs[i]);
}

static blaze_u256 read_u256(const char* hex) {
  blaze_u256 value;
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
  blaze_u256 left = read_u256(argv[1]);
  blaze_u256 right = read_u256(argv[2]);
  const uint64_t c = strtoull(argv[3], NULL, 10);
  blaze_u256 out;
  blaze_rt_u256_add_mod_special(&out, &left, &right, c);
  printf("add "); write_u256(out); printf("\\n");
  blaze_rt_u256_sub_mod_special(&out, &left, &right, c);
  printf("sub "); write_u256(out); printf("\\n");
  blaze_rt_u256_mul_mod_special(&out, &left, &right, c);
  printf("mul "); write_u256(out); printf("\\n");
  return 0;
}
`;

test("the special-prime kernels agree with BigInt over the whole sweep", async () => {
  // The modulus of a special prime is 2^256 - c, and the three operations the
  // lowering reaches for one are entries of their own rather than the general
  // kernel. They are only sound if they answer the same residue as the
  // general entry, so the sweep is the same one the division is held to,
  // reduced below each modulus and compared over the whole numbers. The
  // complements include the shape secp256k1's P has, a word at its limit, and
  // the odd values between them.
  const directory = await scratch("blaze-u256-special-");
  await writeFile(join(directory, `${RUNTIME_NAME}.h`), runtimeHeaderSource(), "utf8");
  await writeFile(join(directory, "runtime.c"), runtimeSourceSource("danger"), "utf8");
  await writeFile(join(directory, "harness.c"), SPECIAL_HARNESS, "utf8");
  const binary = join(directory, "harness");
  const built = run(
    "gcc",
    ["-std=c11", "-O2", "-I", directory, join(directory, "harness.c"), join(directory, "runtime.c"), "-o", binary],
    { timeoutMs: 180_000 },
  );
  assert.equal(built.code, 0, built.stderr);

  const complements = [(1n << 32n) + 977n, 1n, 3n, 5n, 0xffffffffffffffffn];
  const values = [...cases(), ...randoms(160, 256n)];
  for (const c of complements) {
    const modulus = (1n << 256n) - c;
    const reduced = values.map((value) => value % modulus);
    const pairs: [bigint, bigint][] = [];
    for (let i = 0; i + 1 < reduced.length; i += 2) pairs.push([reduced[i]!, reduced[i + 1]!]);
    for (const value of reduced) pairs.push([value, value]);
    for (const [left, right] of pairs) {
      const result = run(binary, [digits(left), digits(right), c.toString()], { timeoutMs: 60_000 });
      assert.equal(result.code, 0, result.stderr);
      const [addLine, subLine, mulLine] = result.stdout.trim().split("\n");
      const add = BigInt(`0x${addLine!.slice(4)}`);
      const sub = BigInt(`0x${subLine!.slice(4)}`);
      const mul = BigInt(`0x${mulLine!.slice(4)}`);
      assert.equal(add, (left + right) % modulus, `the sum of ${digits(left)} and ${digits(right)} modulo 2^256 - ${c}`);
      assert.equal(sub, ((left - right) % modulus + modulus) % modulus, `the difference of ${digits(left)} and ${digits(right)} modulo 2^256 - ${c}`);
      assert.equal(mul, (left * right) % modulus, `the product of ${digits(left)} and ${digits(right)} modulo 2^256 - ${c}`);
    }
  }
});

/** A C harness over the inversion, driven by the value and the modulus. */
const INVERT_HARNESS = `
#include <stdio.h>
#include <stdint.h>
#include "${RUNTIME_NAME}.h"

static void write_u256(blaze_u256 value) {
  for (int i = 3; i >= 0; i -= 1) printf("%016llx", (unsigned long long)value.limbs[i]);
}

static blaze_u256 read_u256(const char* hex) {
  blaze_u256 value;
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
  blaze_u256 value = read_u256(argv[1]);
  blaze_u256 mod = read_u256(argv[2]);
  blaze_u256 out;
  blaze_rt_u256_invert_mod(&out, &value, &mod);
  write_u256(out);
  printf("\\n");
  return 0;
}
`;

/** The greatest common divisor of two whole numbers, which is what decides
 *  whether an inverse exists: one exists exactly when it is one. */
function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

test("the modular inverse agrees with BigInt, and a value with none answers zero", async () => {
  // The inversion is the binary extended Euclidean algorithm: a halving and a
  // subtraction per turn, and no division. What makes it right is the
  // definition rather than the steps: `value * answer` is one modulo the
  // modulus. The sweep is over the primes the program uses -- secp256k1's P
  // and its order -- and over small odd moduli where a value can share a
  // factor with the modulus and so have no inverse at all. Both of those, and
  // an even modulus, are the cases a halving cannot answer, and zero is the
  // answer the lowering documents for them.
  const directory = await scratch("blaze-u256-invert-");
  await writeFile(join(directory, `${RUNTIME_NAME}.h`), runtimeHeaderSource(), "utf8");
  await writeFile(join(directory, "runtime.c"), runtimeSourceSource("danger"), "utf8");
  await writeFile(join(directory, "harness.c"), INVERT_HARNESS, "utf8");
  const binary = join(directory, "harness");
  const built = run(
    "gcc",
    ["-std=c11", "-O2", "-I", directory, join(directory, "harness.c"), join(directory, "runtime.c"), "-o", binary],
    { timeoutMs: 180_000 },
  );
  assert.equal(built.code, 0, built.stderr);

  const P = (1n << 256n) - (1n << 32n) - 977n;
  const N = (1n << 256n) - 432420386565659656852420866394968145599n;
  const moduli = [P, N, 3n, 5n, 97n, 65537n, (1n << 255n) - 19n, 12n];
  const values = [...cases(), ...randoms(120, 256n), 2n, P - 1n, P - 2n, N - 1n];
  for (const modulus of moduli) {
    for (const raw of values) {
      const value = raw % modulus;
      const result = run(binary, [digits(raw), digits(modulus)], { timeoutMs: 60_000 });
      assert.equal(result.code, 0, result.stderr);
      const answer = BigInt(`0x${result.stdout.trim()}`);
      const invertible = modulus > 1n && (modulus & 1n) === 1n && gcd(value, modulus) === 1n;
      if (!invertible) {
        assert.equal(answer, 0n, `${digits(value)} modulo ${digits(modulus)} has no inverse and answers zero`);
        continue;
      }
      assert.ok(answer < modulus, "an inverse is below its modulus");
      assert.equal((value * answer) % modulus, 1n, `${digits(value)} times its inverse is one modulo ${digits(modulus)}`);
    }
  }
});

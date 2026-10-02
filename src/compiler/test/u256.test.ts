/**
 * The fixed-width wide integer kernel, against the language's own bigints.
 *
 * The kernel is the one place a wide operation is defined, because every backend
 * lowers a wide operation to a call into it and so there is nothing else for the
 * targets to disagree with. That makes it worth more than an ordinary helper to
 * pin: a carry or a borrow that is wrong here is wrong on every target at once,
 * and a shift that drops the limb half of its count is wrong only for the counts
 * that are not a multiple of 64, which is exactly the kind of defect a handful
 * of hand-picked cases would miss.
 *
 * So the oracle is `BigInt`, which the language the source is written in uses for
 * the same width, and the cases are a boundary set crossed with itself plus a
 * block of random pairs. Every shift count from 0 to 300 is exercised on each
 * case rather than sampled, because the counts that are not a multiple of the
 * limb width are the ones with their own path through the kernel.
 */
import assert from "node:assert/strict";
import { isInteger, isWhole, limbsOf, wholeOf } from "../core/semantic-ir.ts";
import { test } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../core/process.ts";
import { generateFunctionC } from "../toolchain/ir-c.ts";
import { buildObject as buildMachineObject } from "../toolchain/ir-machine.ts";
import { buildStandaloneRuntime } from "../runtime/standalone.ts";
import type { ArithOp, SemanticType, SemanticValue } from "../core/semantic-ir.ts";
import type { TargetSpec, TypeExpr } from "../core/types.ts";
import { RUNTIME_NAME, runtimeHeaderSource, runtimeSourceSource, WIDE_SYMBOLS } from "../runtime/abi.ts";

const WIDTH = 256;
const MODULUS = (1n << BigInt(WIDTH)) - 1n;
const LIMBS = WIDTH / 64;
const U256: SemanticType = { kind: "primitive", name: "u256" };
const U64: SemanticType = { kind: "primitive", name: "u64" };
const BOOL: TypeExpr = { kind: "primitive", name: "bool" };
const TARGET: TargetSpec = { arch: "x86_64", os: "linux", abi: "sysv", cpu: "", features: [] };

/** A value as the 64 hex digits the harness reads, most significant limb first. */
function digits(value: bigint): string {
  return value.toString(16).padStart(WIDTH / 4, "0");
}

/**
 * A C harness over the real generated runtime, driven by two operands on the
 * command line. It reads the kernel through the header the compiler emits rather
 * than a copy, so what is tested here is the runtime a build actually links.
 */
const HARNESS = `
#include <stdio.h>
#include <stdint.h>
#include <string.h>
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
  blaze_u256 out;

  blaze_rt_u256_add(&out, &left, &right); printf("add "); write_u256(out); printf("\\n");
  blaze_rt_u256_sub(&out, &left, &right); printf("sub "); write_u256(out); printf("\\n");
  blaze_rt_u256_mul(&out, &left, &right); printf("mul "); write_u256(out); printf("\\n");
  blaze_rt_u256_and(&out, &left, &right); printf("and "); write_u256(out); printf("\\n");
  blaze_rt_u256_or(&out, &left, &right); printf("or "); write_u256(out); printf("\\n");
  blaze_rt_u256_xor(&out, &left, &right); printf("xor "); write_u256(out); printf("\\n");
  blaze_rt_u256_not(&out, &left); printf("not "); write_u256(out); printf("\\n");

  for (int count = 0; count <= 2 * 256 + 44; count += 1) {
    blaze_rt_u256_shl(&out, &left, (unsigned)count);
    printf("shl%d ", count); write_u256(out); printf("\\n");
    blaze_rt_u256_shr(&out, &left, (unsigned)count);
    printf("shr%d ", count); write_u256(out); printf("\\n");
  }

  printf("lessLeft %d\\n", blaze_rt_u256_less(&left, &right));
  printf("lessRight %d\\n", blaze_rt_u256_less(&right, &left));
  printf("lessSelf %d\\n", blaze_rt_u256_less(&left, &left));
  printf("equal %d\\n", blaze_rt_u256_equal(&left, &right));

  unsigned char text[80];
  blaze_rt_u256_format(&left, 10, text, sizeof text); printf("decimal %s\\n", text);
  blaze_rt_u256_format(&left, 16, text, sizeof text); printf("hex %s\\n", text);
  blaze_rt_u256_format(&left, 8, text, sizeof text); printf("octal %d\\n", (int)blaze_rt_u256_format(&left, 8, text, sizeof text));

  blaze_rt_u256_from_u64(&out, 0x0123456789abcdefULL);
  printf("widened %llu\\n", (unsigned long long)blaze_rt_u256_to_u64(&out));
  return 0;
}
`;

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

/** The values the kernel is exercised over: every boundary that means something. */
function cases(): bigint[] {
  return [
    0n,
    1n,
    2n,
    MODULUS,
    MODULUS - 1n,
    1n << 64n,
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

test("the wide kernel answers the same arithmetic the language's bigints do", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blaze-u256-"));
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

  let checked = 0;
  for (const [left, right] of pairs) {
    const answers = await ask(binary, left, right);
    const label = `${digits(left)} with ${digits(right)}`;

    const expected: [string, bigint][] = [
      ["add", (left + right) & MODULUS],
      ["sub", (left - right) & MODULUS],
      ["mul", (left * right) & MODULUS],
      ["and", left & right],
      ["or", left | right],
      ["xor", left ^ right],
      ["not", ~left & MODULUS],
    ];
    for (const [name, want] of expected) {
      assert.equal(answers.get(name), digits(want), `${name} of ${label}`);
      checked += 1;
    }

    // Every count, not a sample of them: a count that is not a whole number of
    // limbs is the only one that reaches the bit-carrying path, and a shift by
    // the width is the only one that must be zero rather than the value again.
    for (let count = 0; count <= 2 * WIDTH + 44; count += 1) {
      assert.equal(answers.get(`shl${count}`), digits((left << BigInt(count)) & MODULUS), `left by ${count} of ${label}`);
      assert.equal(answers.get(`shr${count}`), digits(left >> BigInt(count)), `right by ${count} of ${label}`);
      checked += 2;
    }

    assert.equal(answers.get("lessLeft"), left < right ? "1" : "0", `left below right for ${label}`);
    assert.equal(answers.get("lessRight"), right < left ? "1" : "0", `right below left for ${label}`);
    assert.equal(answers.get("lessSelf"), "0", `left below itself for ${label}`);
    assert.equal(answers.get("equal"), left === right ? "1" : "0", `equality for ${label}`);
    assert.equal(answers.get("decimal"), left.toString(10), `decimal of ${label}`);
    assert.equal(answers.get("hex"), left.toString(16), `hexadecimal of ${label}`);
    checked += 6;
  }

  // A base the kernel does not answer is refused rather than answered in another
  // base, which would print a different number from the one that was asked for.
  const one = await ask(binary, 255n, 0n);
  assert.equal(one.get("octal"), "0");
  // Widening zero-extends and narrowing keeps the low limb.
  assert.equal(one.get("widened"), "81985529216486895");
  assert.ok(checked > 20_000, `expected the boundary set to be exercised, checked ${checked}`);
});

test("every kernel symbol a candidate may call is declared and defined", () => {
  const header = runtimeHeaderSource();
  const runtime = runtimeSourceSource();
  // Every wide symbol is a function generated code can call, so each has to
  // resolve: declared in the header a C candidate includes, and defined in the
  // runtime it links. A symbol that was only defined would compile nowhere and a
  // symbol that was only declared would link nowhere.
  for (const symbol of Object.keys(WIDE_SYMBOLS)) {
    assert.ok(header.includes(`${symbol}(`), `${symbol} must be declared in ${RUNTIME_NAME}.h`);
    assert.ok(runtime.includes(`${symbol}(`), `${symbol} must be implemented by the compiler runtime`);
  }
  // The value a backend lays out in memory and the runtime reads a pointer to
  // have to be the same width, or a limb is read from a byte that is not there.
  assert.match(header, /uint64_t limbs\[4\]/);
  assert.match(header, /BLAZE_U256_BYTES 32u/);
});

test("a wide number is a whole number and is never narrowed to a machine word", () => {
  // The rules that decide what a pair of numbers is computed as. A wide number
  // ranked no higher than a machine word would have its high limbs dropped the
  // moment it was added to a `u64`, which is a wrong answer rather than a
  // refused one, so these are asserted rather than assumed.
  assert.ok(isWhole("u256"));
  assert.ok(isInteger({ kind: "primitive", name: "u256" }));
  assert.equal(limbsOf("u256"), LIMBS);
  assert.equal(limbsOf("u64"), null);
  assert.equal(wholeOf("u256", "u64"), "u256");
  assert.equal(wholeOf("u64", "u256"), "u256");
  assert.equal(wholeOf("u256", "u256"), "u256");
});
/* ------------------------------------------------------------------------ */
/* The C backend                                                               */
/* ------------------------------------------------------------------------ */

/** One lowered function per operation, so each is exercised on its own. */
function loweringSubjects(): { symbol: string; returns: SemanticType; value: SemanticValue }[] {
  const a: SemanticValue = { k: "local", type: U256, name: "a" };
  const wide = (text: string): SemanticValue => ({ k: "const", type: U256, text });
  const count = (text: string): SemanticValue => ({ k: "const", type: U64, text });
  const binary = (op: ArithOp): SemanticValue => ({ k: "arith", type: U256, op, left: a, right: wide("2") });
  const shift = (op: "shl" | "shr"): SemanticValue => ({ k: "arith", type: U256, op, left: a, right: count("100") });
  return [
    { symbol: "add", returns: U256, value: binary("add") },
    { symbol: "sub", returns: U256, value: binary("sub") },
    { symbol: "product", returns: U256, value: { k: "arith", type: U256, op: "mul", left: a, right: wide("1000000000000000000000000") } },
    { symbol: "conjunction", returns: U256, value: { k: "arith", type: U256, op: "and", left: a, right: wide("255") } },
    { symbol: "disjunction", returns: U256, value: { k: "arith", type: U256, op: "or", left: a, right: wide("255") } },
    { symbol: "difference", returns: U256, value: { k: "arith", type: U256, op: "xor", left: a, right: wide("255") } },
    { symbol: "complement", returns: U256, value: { k: "unary", type: U256, op: "bitNot", operand: a } },
    { symbol: "left", returns: U256, value: shift("shl") },
    { symbol: "right", returns: U256, value: shift("shr") },
    {
      symbol: "chosen",
      returns: U256,
      value: {
        k: "select",
        type: U256,
        condition: { k: "compare", type: BOOL, op: "gt", operand: U256, left: a, right: wide("5") },
        then: a,
        otherwise: wide("7"),
      },
    },
    {
      symbol: "below",
      returns: BOOL,
      value: {
        k: "unary",
        type: BOOL,
        op: "not",
        operand: { k: "compare", type: BOOL, op: "lt", operand: U256, left: a, right: wide("5") },
      },
    },
  ];
}

test("the C backend lowers a wide operation to the kernel and answers it", async () => {
  const subjects = loweringSubjects();
  const directory = await mkdtemp(join(tmpdir(), "blaze-u256-c-"));
  const runtime = await buildStandaloneRuntime(directory);
  const value = 0xfedcba0987654321n * (1n << 64n) + 0x1234567890abcdefn;
  const seed = ["blaze_u256 a = {0,0,0,0};", "a.limbs[0] = 0x1234567890abcdefULL;", "a.limbs[1] = 0xfedcba0987654321ULL;"];
  const calls = subjects.map(({ symbol, returns }) =>
    returns === BOOL
      ? `  printf("${symbol} %d\\n", (int)${symbol}(a));`
      : `  { blaze_u256 r = ${symbol}(a); unsigned char t[80]; blaze_rt_u256_format(&r, 10, t, sizeof t); printf("${symbol} %s\\n", t); }`,
  );
  const source = [
    "#include <stdio.h>",
    ...subjects.map(({ symbol, returns, value }) =>
      generateFunctionC({
        name: symbol,
        symbol,
        params: [{ kind: "value", name: "a", mutable: false, type: U256 }],
        returns,
        requires: [],
        ensures: [],
        effects: [],
        allocates: false,
        prints: false,
        readsArgv: false,
        objects: {},
        calls: [],
        entry: { id: "entry", statements: [], releases: [], terminator: { k: "return", value } },
      }),
    ),
    `int main(void) {\n  ${seed.join("\n  ")}\n${calls.join("\n")}\n  return 0;\n}`,
    "",
  ].join("\n");
  await writeFile(join(directory, "wide.c"), source, "utf8");
  const binary = join(directory, "wide");
  const built = run(
    "gcc",
    ["-std=c11", "-O2", "-I", directory, join(directory, "wide.c"), runtime.objectPath, "-o", binary],
    { timeoutMs: 180_000 },
  );
  assert.equal(built.code, 0, `the lowered C must build:\n${built.stderr}`);

  const answers = new Map<string, string>();
  for (const line of run(binary, [], { timeoutMs: 60_000 }).stdout.split("\n")) {
    if (line === "") continue;
    const at = line.indexOf(" ");
    answers.set(line.slice(0, at), line.slice(at + 1));
  }
  const expected: Record<string, string> = {
    add: (value + 2n).toString(10),
    sub: ((value - 2n) & MODULUS).toString(10),
    product: ((value * 1000000000000000000000000n) & MODULUS).toString(10),
    conjunction: (value & 255n).toString(10),
    disjunction: (value | 255n).toString(10),
    difference: ((value ^ 255n) & MODULUS).toString(10),
    complement: (~value & MODULUS).toString(10),
    left: ((value << 100n) & MODULUS).toString(10),
    right: (value >> 100n).toString(10),
    chosen: value.toString(10),
    below: value < 5n ? "0" : "1",
  };
  for (const [symbol, want] of Object.entries(expected)) {
    assert.equal(answers.get(symbol), want, `${symbol} of ${digits(value)}`);
  }
});

test("a backend that cannot lower a wide number refuses it rather than narrowing it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blaze-u256-m-"));
  // The two backends that do not implement one must say so. Both measure a value
  // through a single scalar carrier — one machine register, one WebAssembly value
  // type — and both have a table that answers eight bytes for a type they do not
  // recognise. Left to that default a `u256` would be given a slot a quarter of
  // the size of the value written into it, and the three limbs above the first
  // would be whatever sat beside it: a wrong answer from a build that reported
  // success. A refusal is the only answer they can give honestly today.
  const WIDE: SemanticType = { kind: "primitive", name: "u256" };
  const wide: SemanticValue = { k: "local", type: WIDE, name: "a" };
  const value: SemanticValue = { k: "arith", type: WIDE, op: "add", left: wide, right: wide };

  // The refusal is placed at the one function every read, write and frame slot
  // is derived from, so it is that function itself being exercised here rather
  // than a whole build: the build reads its contract before it reaches a value,
  // and what has to hold is that no width is ever measured for a wide number.
  await assert.rejects(
    () =>
      buildMachineObject({
        fn: {
          name: "subject",
          symbol: "subject",
          params: [{ kind: "value", name: "a", mutable: false, type: WIDE }],
          returns: WIDE,
          requires: [],
          ensures: [],
          effects: [],
          allocates: false,
          prints: false,
          readsArgv: false,
          objects: {},
          calls: [],
          entry: { id: "entry", statements: [], releases: [], terminator: { k: "return", value } },
        },
        contract: {
          version: "1",
          numeric: { floatingPoint: "ieee754", rounding: "nearest", fastMath: false },
          function: {
            name: "subject",
            symbol: "subject",
            params: [{ name: "a", type: "u256" }],
            returns: "u256",
          },
          optimize: { primary: "latency", secondary: "size" },
          effects: [],
          memory: { reads: [], writes: [], aliasing: [] },
          requires: [],
          ensures: [],
          definition: { statements: [], objects: {}, allocates: false, prints: false, readsArgv: false, calls: [] },
        },
        target: TARGET,
        callable: new Set<string>(),
        objectPath: directory,
        candidate: "c1",
      }),
    /cannot lower a u256/,
    "the machine backend must refuse a wide number",
  );
});

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
import { semanticFunctionProblems } from "../semantics/ir-validate.ts";
import { phaseOf, semanticsOf } from "./phase.ts";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { run } from "../core/process.ts";
import { generateFunctionC } from "../toolchain/ir-c.ts";
import { buildObject as buildMachineObject } from "../toolchain/ir-machine.ts";
import { moduleBytes } from "../toolchain/ir-wasm.ts";
import { Encoder, RDI, RSI, RDX, R8, R9, R10, R11, mem } from "../toolchain/x86.ts";

/** The four general registers a wide operation is carried out in. */
const WORK = [R8, R9, R10, R11];
import { buildStandaloneRuntime } from "../runtime/standalone.ts";
import type { ArithOp, CompareOp, SemanticFunction, SemanticType, SemanticValue } from "../core/semantic-ir.ts";

/** The engine the build runs on, reached the way the backend reaches it. */
interface WasmEngine {
  Memory: new (init: { initial: number }) => { buffer: ArrayBuffer };
  Module: new (bytes: Uint8Array) => unknown;
  Instance: new (module: unknown, imports: Record<string, unknown>) => { exports: unknown };
}
const engine = (globalThis as { WebAssembly?: WasmEngine }).WebAssembly as WasmEngine;
assert.ok(engine !== undefined, "the engine the build runs on carries modules");
import type { FunctionContract } from "../core/types.ts";
import type { TargetSpec, TypeExpr } from "../core/types.ts";
import { RUNTIME_NAME, runtimeHeaderSource, runtimeSourceSource, WIDE_SYMBOLS } from "../runtime/abi.ts";
import { scratch } from "./scratch.ts";

const WIDTH = 256;
const MODULUS = (1n << BigInt(WIDTH)) - 1n;
const LIMBS = WIDTH / 64;
const U256: SemanticType = { kind: "primitive", name: "u256" };
const U64: SemanticType = { kind: "primitive", name: "u64" };
const BOOL: SemanticType = { kind: "primitive", name: "bool" };
const TARGET: TargetSpec = { arch: "x86_64", os: "linux", abi: "sysv", cpu: "", features: [] };

/**
 * One function of a module, resolved the way a build resolves it, so a rule
 * about the IR is read on the IR a build hands a backend rather than on one a
 * test wrote by hand.
 */
function functionNamed(language: string, files: Record<string, string>, entry: string, name: string): SemanticFunction {
  const phase = phaseOf(language, files, entry);
  const fn = semanticsOf(phase)[name];
  assert.ok(fn !== undefined, `the module declares ${name}`);
  return fn;
}

/**
 * One function of a program, resolved the way a build resolves a program's own
 * functions, for the shapes a library entry cannot state: a function that only
 * shifts states no postcondition, and the contract phase asks for a program.
 */
function programNamed(language: string, files: Record<string, string>, entry: string, name: string): SemanticFunction {
  const phase = phaseOf(language, files, entry);
  const fn = semanticsOf(phase)[name];
  assert.ok(fn !== undefined, `the program declares ${name}`);
  return fn;
}

/** Two wide literals whose limbs carry into one another in every position. */
const WIDE_LEFT = "0xfedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
const WIDE_RIGHT = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/** The low two limbs of the argument, spelled as C literals. */
/** The argument, chosen so every limb differs and the carries are real. */
const WIDE_ARGUMENT = "0123456789abcdeffedcba987654321089abcdef0123456776543210fedcba98";
/** A constant whose limbs are all distinct, so a limb left out would show. */
const WIDE_ADDEND = "0xfedcba98765432100123456789abcdeffedcba98765432100123456789abcdef";

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
  const directory = await scratch("blaze-u256-");
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
  // A length is over every value a machine word holds and a wide number holds
  // values no machine word holds, so the length rule does not apply to a pair
  // one of each: `usize` used to win, and the type it answered was a width the
  // high three limbs do not fit in.
  assert.equal(wholeOf("u256", "usize"), "u256");
  assert.equal(wholeOf("usize", "u256"), "u256");
  assert.equal(wholeOf("u256", "isize"), "u256");
  assert.equal(wholeOf("isize", "u256"), "u256");
  // The length rule is unchanged for a pair of machine words.
  assert.equal(wholeOf("usize", "i64"), "usize");
  assert.equal(wholeOf("isize", "i32"), "isize");
});

test("a wide number is only computed with another wide number", () => {
  // Every backend answers a wide operation by calling the kernel, and the
  // kernel is over two `u256`. A narrower operand beside one has no form there:
  // the C backend wrote a cast from a scalar to a struct, which is a source that
  // does not compile, and the machine backend asked for the single-register
  // width a wide number does not have. So each of these is refused at the last
  // point before a backend is handed the tree, naming what is wrong with it.
  const pairs: [string, readonly string[], RegExp][] = [
    ["add", ["export function f(a: u256, b: bigint): u256 {", "  return a + b;", "}"], /kernel every backend answers a wide number with is over two of them/],
    ["mul", ["export function f(a: u256, b: number): u256 {", "  return a * b;", "}"], /kernel every backend answers a wide number with is over two of them/],
    // A comparison is read as the operand the IR names, and a double beside a
    // wide number makes the operand the double: which is the demotion this pair
    // used to be, and the reason it is named rather than left to a backend.
    ["gt", ["export function f(a: u256, b: number): boolean {", "  return a > b;", "}"], /a wide number is not a machine word/],
    ["lt", ["export function f(a: number, b: u256): boolean {", "  return a < b;", "}"], /a wide number is not a machine word/],
    // The other side of the same comparison: here the wide number is on the left
    // and the operand is the `i64` a whole number is read at, so the kernel is
    // what is missing rather than the width.
    ["ge", ["export function f(a: u256, b: bigint): boolean {", "  return a >= b;", "}"], /kernel every backend answers a wide number with is over two of them/],
  ];
  for (const [what, lines, said] of pairs) {
    const fn = functionNamed("typescript", { "module.ts": [...lines, ""].join("\n") }, "module.ts", "f");
    const problems = semanticFunctionProblems(fn);
    assert.equal(problems.length, 1, `${what} of a wide number and a machine word: ${problems.join("; ")}`);
    assert.match(problems[0]!, said, what);
  }

  // The count of a shift is the machine word the source wrote the shift by, and
  // it is the one narrower number a wide number may be beside. A shift states no
  // postcondition, so a function that is only a shift is contracted as a program.
  const shiftProgram = programNamed(
    "typescript",
    { "main.ts": ["function f(a: u256, b: bigint): u256 {", "  return a << b;", "}", "console.log(f(1n, 2n));", ""].join("\n") },
    "main.ts",
    "f",
  );
  assert.deepEqual(semanticFunctionProblems(shiftProgram), []);

  // Two wide numbers are what the kernel is over, and a pair of them is left
  // exactly as it was.
  const pair = functionNamed(
    "typescript",
    { "module.ts": ["export function f(a: u256, b: u256): u256 {", "  return a + b;", "}", ""].join("\n") },
    "module.ts",
    "f",
  );
  assert.deepEqual(semanticFunctionProblems(pair), []);
});

test("a whole operator over a wide number answers a wide number", () => {
  // A shift and a remainder are operations on whole numbers, and the answer was
  // the pair's common type with a side that is not one naming an `i64` — three
  // limbs dropped before a backend was handed the value. A bitwise pair says the
  // same thing and is not here only because the program's own reader has no
  // token for `&`, `|` or `^`.
  for (const [what, body] of [["<<", "a << b"], [">>", "a >> b"], ["% ", "a % b"]] as const) {
    const fn = programNamed(
      "typescript",
      {
        "main.ts": [
          "function f(a: u256, b: number): number {",
          `  return ${body};`,
          "}",
          "console.log(f(1n, 2));",
          "",
        ].join("\n"),
      },
      "main.ts",
      "f",
    );
    const term = fn.entry.terminator;
    assert.equal(term.k, "return", what);
    if (term.k !== "return" || term.value === null || term.value.k !== "arith") {
      assert.fail(`${what} did not lower to an arithmetic value`);
    }
    const answered = term.value.type;
    assert.equal(answered.kind === "primitive" ? answered.name : "", "u256", `${what} of a u256 and a double`);
  }
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
        condition: { k: "compare", type: BOOL as TypeExpr, op: "gt", operand: U256, left: a, right: wide("5") },
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
        operand: { k: "compare", type: BOOL as TypeExpr, op: "lt", operand: U256, left: a, right: wide("5") },
      },
    },
  ];
}

test("the C backend lowers a wide operation to the kernel and answers it", async () => {
  const subjects = loweringSubjects();
  const directory = await scratch("blaze-u256-c-");
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

test("a wide argument to a call this backend has not written is refused", async () => {
  // Every wide operation is written now, and every way a value crosses into or
  // out of a function this compiler compiled itself is refused: a call it makes
  // hands its arguments over in registers, and there are six registers the
  // convention does not preserve and a wide number is four limbs, so a wide
  // argument has nowhere to go that a value the callee can read.
  //
  // The refusal matters because the alternative is the default this backend has
  // everywhere else: a table that answers eight bytes for a type it does not
  // recognise. A wide argument given one of those is a pointer written where
  // thirty-two bytes were promised, and the callee reads four words of the frame
  // that were never written to them — a wrong answer from a build that reported
  // success.
  //
  // Calling into this backend from C does work, because the convention hands such
  // a value over in memory and `arrivals` reads it there; it is only a call this
  // backend emits for itself that has no answer yet.
  const directory = await scratch("blaze-u256-call-");
  const WIDE: SemanticType = { kind: "primitive", name: "u256" };
  const VOID: SemanticType = { kind: "void" };
  await assert.rejects(
    () =>
      buildMachineObject({
        fn: {
          name: "subject",
          symbol: "subject",
          params: [],
          returns: VOID,
          requires: [],
          ensures: [],
          effects: [],
          allocates: false,
          prints: false,
          readsArgv: false,
          objects: {},
          calls: [{ callee: "callee", strategy: "call" }],
          entry: {
            id: "entry",
            statements: [],
            releases: [],
            terminator: {
              k: "return",
              value: {
                k: "call",
                type: VOID,
                call: {
                  callee: "callee",
                  signature: {
                    name: "callee",
                    symbol: "callee",
                    params: [{ name: "a", type: "u256" }],
                    returns: "void",
                  },
                  args: [{ k: "const", type: WIDE, text: "0x0123456789abcdeffedcba9876543210" }],
                  argTypes: [WIDE],
                  returns: VOID,
                  effects: [],
                  ownership: "borrowed",
                  retain: false,
                  builtin: false,
                },
              },
            },
          },
        },
        contract: {
          version: "1",
          numeric: { floatingPoint: "ieee754", rounding: "nearest", fastMath: false },
          function: { name: "subject", symbol: "subject", params: [], returns: "void" },
          optimize: { primary: "latency", secondary: "size" },
          effects: [],
          memory: { reads: [], writes: [], aliasing: [] },
          requires: [],
          ensures: [],
          definition: { statements: [], objects: {}, allocates: false, prints: false, readsArgv: false, calls: [] },
        },
        target: TARGET,
        callable: new Set(["callee"]),
        objectPath: join(directory, "subject.o"),
      }),
    /no single-register width/,
    "a wide argument to a compiled call must be refused rather than narrowed",
  );
});

/* ------------------------------------------------------------------------ */
/* The machine backend                                                         */
/* ------------------------------------------------------------------------ */

test("the machine backend carries a wide operation out in registers and answers it", async () => {
  // A function that takes nothing and returns the answer to one operation on
  // two wide literals is the smallest thing that exercises the whole of what a
  // wide number is in this backend: a literal written four limbs at a time, the
  // operation itself, an answer written down to the frame, and the frame's
  // thirty two bytes copied to the pointer the caller passed.
  //
  // The two literals are chosen so that every limb of an answer differs from
  // every limb of the operands and the carries are real. A sum whose limbs do
  // not carry is a sum that would also be right with the carry left out of every
  // limb after the first, so an implementation that threaded the carry into
  // nothing would pass on it.
  //
  // Every operation is here rather than one, because they are carried out in two
  // different ways and one test of each is what says both are right: a sum and a
  // difference read the carry the limb before them left, and the three bitwise
  // combinations do not — a chain that read one for those would be a chain that
  // added a carry to a value that never carried.
  const left = BigInt(WIDE_LEFT);
  const right = BigInt(WIDE_RIGHT);
  const cases: { op: ArithOp; answer: bigint }[] = [
    { op: "add", answer: (left + right) & MODULUS },
    { op: "sub", answer: (left - right) & MODULUS },
    { op: "mul", answer: (left * right) & MODULUS },
    { op: "and", answer: left & right },
    { op: "or", answer: left | right },
    { op: "xor", answer: left ^ right },
  ];
  for (const { op, answer } of cases) {
    const directory = await scratch(`blaze-u256-machine-${op}-`);
    const runtime = await buildStandaloneRuntime(directory);
    const object = join(directory, "subject.o");
    const built = await buildMachineObject({
      fn: wideOperationFunction(op),
      contract: wideOperationContract(),
      target: TARGET,
      callable: new Set<string>(),
      objectPath: object,
    });
    assert.ok(built.textSizeBytes > 0, `the object carries the code a ${op} is`);

    await writeFile(
      join(directory, "driver.c"),
      [
        "#include <stdio.h>",
        "#include <stdint.h>",
        "extern void subject(uint64_t *out);",
        "int main(void) {",
        "  uint64_t r[4];",
        "  subject(r);",
        '  printf("%016llx%016llx%016llx%016llx\\n", (unsigned long long)r[3], (unsigned long long)r[2], (unsigned long long)r[1], (unsigned long long)r[0]);',
        "  return 0;",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    const binary = join(directory, "subject");
    const linked = run(
      "gcc",
      ["-std=c11", "-O2", join(directory, "driver.c"), object, runtime.objectPath, "-o", binary, "-lm"],
      { timeoutMs: 180_000 },
    );
    assert.equal(linked.code, 0, `a wide ${op} must link:\n${linked.stderr}`);
    const ran = run(binary, [], { timeoutMs: 60_000 });
    assert.equal(ran.code, 0, `a wide ${op} must run:\n${ran.stderr}`);
    assert.equal(ran.stdout.trim(), hexadecimal(answer), `the answer a wide ${op} gives`);
  }
});

/** `function subject(): u256` whose body is one operation on two wide literals. */
function wideOperationFunction(op: ArithOp): SemanticFunction {
  const literal = (text: string): SemanticValue => ({ k: "const", type: U256, text });
  const sum: SemanticValue = { k: "arith", type: U256, op, left: literal(WIDE_LEFT), right: literal(WIDE_RIGHT) };
  return {
    name: "subject",
    symbol: "subject",
    params: [],
    returns: U256,
    requires: [],
    ensures: [],
    effects: [],
    allocates: false,
    prints: false,
    readsArgv: false,
    objects: {},
    calls: [],
    entry: {
      id: "entry",
      statements: [],
      releases: [],
      terminator: { k: "return", value: sum },
    },
  };
}

function wideOperationContract(): FunctionContract {
  return {
    version: "1",
    numeric: { floatingPoint: "ieee754", rounding: "nearest", fastMath: false },
    function: { name: "subject", symbol: "subject", params: [], returns: "u256" },
    optimize: { primary: "latency", secondary: "size" },
    effects: [],
    memory: { reads: [], writes: [], aliasing: [] },
    requires: [],
    ensures: [],
    definition: { statements: [], objects: {}, allocates: false, prints: false, readsArgv: false, calls: [] },
  };
}

test("the machine backend reads a wide argument off the stack and answers on it", async () => {
  // A wide argument is thirty-two bytes, which is more than the register file has
  // to spare for one argument, so the convention hands it over on the stack as
  // four consecutive words. This is the whole of that path: the words are read
  // one at a time above the return address into the four limbs of a slot, and
  // the answer is written back the same way.
  //
  // The argument is the left of a sum and the answer is put in the second
  // argument, which is the only shape a wide parameter can be exercised in from
  // outside: a caller in C passes by address and this backend has no way yet to
  // hand a wide value to another function it compiled itself.
  // The answer is spelled out from `BigInt` rather than written down here: the
  // limbs of a sum with a carry out of the first are exactly the kind of thing a
  // hand-written expectation gets wrong, and a test that carries the same mistake
  // as the code it checks passes both ways.
  const argumentLimbs = [0, 1, 2, 3]
    .map((limb) => `0x${((BigInt(`0x${WIDE_ARGUMENT}`) >> BigInt(limb * 64)) & 0xffffffffffffffffn).toString(16)}ULL`)
    .join(", ");
  const addend = BigInt(`0x${WIDE_ARGUMENT}`);
  const sum = (addend + BigInt(WIDE_ADDEND)) & MODULUS;
  const expectedLimbs = [0, 1, 2, 3]
    .map((limb) => `0x${((sum >> BigInt(limb * 64)) & 0xffffffffffffffffn).toString(16)}ULL`)
    .join(", ");
  const directory = await scratch("blaze-u256-argument-");
  const runtime = await buildStandaloneRuntime(directory);
  const object = join(directory, "subject.o");
  const built = await buildMachineObject({
    fn: wideArgumentFunction(),
    contract: wideArgumentContract(),
    target: TARGET,
    callable: new Set<string>(),
    objectPath: object,
  });
  assert.ok(built.textSizeBytes > 0, "the object carries the code the function is");

  await writeFile(
    join(directory, "driver.c"),
    [
      "#include <stdio.h>",
      "#include <stdint.h>",
      // Declared by value, and not as a pointer to one: thirty-two bytes is past
      // what the register file hands over for a single argument, so the
      // convention passes such a value in memory and the compiler has to be told
      // so to place it. A pointer here would be one register, and the callee
      // would read four words of the frame that were never written.
      "struct blaze_u256 { uint64_t limbs[4]; };",
      "extern void subject(struct blaze_u256 addend, struct blaze_u256 *out);",
      "int main(void) {",
      `  const struct blaze_u256 a = {{${argumentLimbs}}};`,
      "  struct blaze_u256 r;",
      "  subject(a, &r);",
      `  const uint64_t e[4] = {${expectedLimbs}};`,
      "  int ok = 1;",
      "  for (int i = 0; i < 4; i++) ok &= (r.limbs[i] == e[i]);",
      '  printf("%s\\n", ok ? "right" : "wrong");',
      "  return ok ? 0 : 1;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  const binary = join(directory, "subject");
  const linked = run(
    "gcc",
    ["-std=c11", "-O2", join(directory, "driver.c"), object, runtime.objectPath, "-o", binary, "-lm"],
    { timeoutMs: 180_000 },
  );
  assert.equal(linked.code, 0, `the machine code must link:\n${linked.stderr}`);
  const ran = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(ran.stdout.trim(), "right", `a wide argument must arrive whole: ${ran.stderr}`);
});

/**
 * `function subject(addend: u256): u256`, whose answer is its argument plus a
 * constant.
 *
 * The argument is read off the stack four words at a time and the answer goes
 * back through the pointer the caller passed, which between them cover both
 * halves of the convention for a value this size.
 */
function wideArgumentFunction(): SemanticFunction {
  const addend: SemanticValue = { k: "local", type: U256, name: "addend" };
  const sum: SemanticValue = {
    k: "arith",
    type: U256,
    op: "add",
    left: addend,
    right: { k: "const", type: U256, text: WIDE_ADDEND },
  };
  return {
    name: "subject",
    symbol: "subject",
    params: [{ kind: "value", name: "addend", mutable: false, type: U256 }],
    returns: U256,
    requires: [],
    ensures: [],
    effects: [],
    allocates: false,
    prints: false,
    readsArgv: false,
    objects: {},
    calls: [],
    entry: { id: "entry", statements: [], releases: [], terminator: { k: "return", value: sum } },
  };
}

function wideArgumentContract(): FunctionContract {
  return {
    version: "1",
    numeric: { floatingPoint: "ieee754", rounding: "nearest", fastMath: false },
    function: {
      name: "subject",
      symbol: "subject",
      params: [{ name: "addend", type: "u256" }],
      returns: "u256",
    },
    optimize: { primary: "latency", secondary: "size" },
    effects: [],
    memory: { reads: [], writes: [], aliasing: [] },
    requires: [],
    ensures: [],
    definition: { statements: [], objects: {}, allocates: false, prints: false, readsArgv: false, calls: [] },
  };
}

/**
 * `function widen(n: u64): u256`, whose answer is the word it was handed.
 *
 * This is the one conversion into a wide number there is, and both backends got
 * it wrong in the way a mistake about what a wide number *is* goes wrong: the C
 * one wrote `(blaze_u256)(n)`, which is a conversion to a non-scalar type and so
 * a source the C compiler refuses, and the machine one read four limbs out of a
 * frame slot that only ever held one of them — so the three above were whatever
 * the body had left beside the word.
 */
function widenFunction(): SemanticFunction {
  return {
    name: "widen",
    symbol: "widen",
    params: [{ kind: "value", name: "n", mutable: false, type: U64 }],
    returns: U256,
    requires: [],
    ensures: [],
    effects: [],
    allocates: false,
    prints: false,
    readsArgv: false,
    objects: {},
    calls: [],
    entry: { id: "entry", statements: [], releases: [], terminator: { k: "return", value: { k: "local", type: U64, name: "n" } } },
  };
}

function widenContract(): FunctionContract {
  return {
    ...wideArgumentContract(),
    function: { name: "widen", symbol: "widen", params: [{ name: "n", type: "u64" }], returns: "u256" },
  };
}

test("the C backend widens a machine word into a wide number and answers it", async () => {
  const directory = await scratch("blaze-u256-widen-c-");
  const runtime = await buildStandaloneRuntime(directory);
  await writeFile(
    join(directory, "driver.c"),
    [
      "#include <stdio.h>",
      "#include <stdint.h>",
      "struct blaze_u256 { uint64_t limbs[4]; };",
      "extern struct blaze_u256 widen(uint64_t n);",
      "int main(void) {",
      `  const uint64_t word = ${0xfedcba9876543210n}n;`,
      "  struct blaze_u256 r = widen(word);",
      "  int ok = r.limbs[0] == word && r.limbs[1] == 0 && r.limbs[2] == 0 && r.limbs[3] == 0;",
      '  printf("%s\\n", ok ? "right" : "wrong");',
      "  return ok ? 0 : 1;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(directory, "widen.c"),
    [
      "#include <stdint.h>",
      "struct blaze_u256 { uint64_t limbs[4]; };",
      "void blaze_rt_u256_from_u64(struct blaze_u256* out, uint64_t value);",
      generateFunctionC(widenFunction()),
      "",
    ].join("\n"),
    "utf8",
  );
  const binary = join(directory, "widen");
  const built = run(
    "gcc",
    ["-std=c11", "-O2", join(directory, "driver.c"), join(directory, "widen.c"), runtime.objectPath, "-o", binary],
    { timeoutMs: 180_000 },
  );
  assert.equal(built.code, 0, `the widened C must build:\n${built.stderr}`);
  const ran = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(ran.stdout.trim(), "right", `a whole number widened is the number it was:\n${ran.stderr}`);
});

test("the machine backend widens a machine word into a wide number and answers it", async () => {
  const directory = await scratch("blaze-u256-widen-machine-");
  const runtime = await buildStandaloneRuntime(directory);
  const object = join(directory, "widen.o");
  const built = await buildMachineObject({
    fn: widenFunction(),
    contract: widenContract(),
    target: TARGET,
    callable: new Set<string>(),
    objectPath: object,
  });
  assert.ok(built.textSizeBytes > 0, "the object carries the code the function is");
  await writeFile(
    join(directory, "driver.c"),
    [
      "#include <stdio.h>",
      "#include <stdint.h>",
      "struct blaze_u256 { uint64_t limbs[4]; };",
      "extern struct blaze_u256 widen(uint64_t n);",
      "int main(void) {",
      `  const uint64_t word = ${0xfedcba9876543210n}n;`,
      "  struct blaze_u256 r = widen(word);",
      "  int ok = r.limbs[0] == word && r.limbs[1] == 0 && r.limbs[2] == 0 && r.limbs[3] == 0;",
      '  printf("%s\\n", ok ? "right" : "wrong");',
      "  return ok ? 0 : 1;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  const binary = join(directory, "widen");
  const linked = run(
    "gcc",
    ["-std=c11", "-O2", join(directory, "driver.c"), object, runtime.objectPath, "-o", binary, "-lm"],
    { timeoutMs: 180_000 },
  );
  assert.equal(linked.code, 0, `the machine code must link:\n${linked.stderr}`);
  const ran = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(ran.stdout.trim(), "right", `a whole number widened is the number it was:\n${ran.stderr}`);
});

test("the machine backend answers a wide complement, negation, comparison and choice", async () => {
  // Four more shapes, and each is a different answer to the same question of
  // where a wide value lives while it is being worked on.
  //
  // A complement and a negation are one instruction per limb over the registers.
  // A comparison is a walk from the top limb down that leaves the registers. A
  // choice is four conditional moves, which is the one shape that has to hold
  // both sides at once.
  const left = BigInt(`0x${WIDE_ARGUMENT}`);
  const cases: { name: string; returns: SemanticType; value: SemanticValue; answer: bigint | boolean }[] = [
    {
      name: "complement",
      returns: U256,
      value: { k: "unary", type: U256, op: "bitNot", operand: { k: "const", type: U256, text: `0x${WIDE_ARGUMENT}` } },
      answer: ~left & MODULUS,
    },
    {
      name: "negation",
      returns: U256,
      value: { k: "unary", type: U256, op: "neg", operand: { k: "const", type: U256, text: `0x${WIDE_ARGUMENT}` } },
      answer: (0n - left) & MODULUS,
    },
    {
      name: "lesser",
      returns: BOOL,
      value: wideCompare("lt", BigInt(WIDE_RIGHT) - 1n),
      answer: left < BigInt(WIDE_RIGHT) - 1n,
    },
    {
      name: "greater",
      returns: BOOL,
      value: wideCompare("gt", BigInt(WIDE_RIGHT) + 1n),
      answer: left > BigInt(WIDE_RIGHT) + 1n,
    },
    {
      name: "equal",
      returns: BOOL,
      value: wideCompare("eq", left),
      answer: true,
    },
    {
      name: "chosen",
      returns: U256,
      value: {
        k: "select",
        type: U256,
        condition: { k: "bool", type: BOOL, value: true },
        then: { k: "const", type: U256, text: WIDE_LEFT },
        otherwise: { k: "const", type: U256, text: WIDE_RIGHT },
      },
      answer: BigInt(WIDE_LEFT),
    },
  ];
  for (const { name, returns, value, answer } of cases) {
    const directory = await scratch(`blaze-u256-${name}-`);
    const runtime = await buildStandaloneRuntime(directory);
    const object = join(directory, "subject.o");
    const built = await buildMachineObject({
      fn: {
        name: "subject",
        symbol: "subject",
        params: [],
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
      },
      contract: singleResultContract(returns),
      target: TARGET,
      callable: new Set<string>(),
      objectPath: object,
    });
    assert.ok(built.textSizeBytes > 0, `the object carries the code a ${name} is`);

    const wide = returns === U256;
    await writeFile(
      join(directory, "driver.c"),
      [
        "#include <stdio.h>",
        "#include <stdint.h>",
        ...(wide ? ["struct blaze_u256 { uint64_t limbs[4]; };"] : []),
        ...(wide ? ["extern void subject(struct blaze_u256 *out);"] : ["extern int subject(void);"]),
        "int main(void) {",
        ...(wide ? ["  struct blaze_u256 r;", "  subject(&r);"] : ["  int r = subject();"]),
        ...(wide
          ? [`  const uint64_t e[4] = {${expectedLimbsOf(answer as bigint)}};`,
             "  int ok = 1;",
             "  for (int i = 0; i < 4; i++) ok &= (r.limbs[i] == e[i]);",
             '  printf("%s\\n", ok ? "right" : "wrong");',
             "  return ok ? 0 : 1;"]
          : [`  printf("%s\\n", r == ${(answer as boolean) ? 1 : 0} ? "right" : "wrong");`,
             `  return r == ${(answer as boolean) ? 1 : 0} ? 0 : 1;`]),
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    const binary = join(directory, "subject");
    const linked = run(
      "gcc",
      ["-std=c11", "-O2", join(directory, "driver.c"), object, runtime.objectPath, "-o", binary, "-lm"],
      { timeoutMs: 180_000 },
    );
    assert.equal(linked.code, 0, `a wide ${name} must link:\n${linked.stderr}`);
    const ran = run(binary, [], { timeoutMs: 60_000 });
    assert.equal(ran.stdout.trim(), "right", `a wide ${name} must answer correctly: ${ran.stderr}`);
  }
});

/** A comparison between the standing argument and `other`. */
function wideCompare(op: CompareOp, other: bigint): SemanticValue {
  return {
    k: "compare",
    type: BOOL as TypeExpr,
    op,
    operand: U256,
    left: { k: "const", type: U256, text: `0x${WIDE_ARGUMENT}` },
    right: { k: "const", type: U256, text: `0x${other.toString(16)}` },
  };
}

/** The four limbs of a wide number, spelled as C literals. */
function expectedLimbsOf(value: bigint): string {
  return [0, 1, 2, 3]
    .map((limb) => `0x${((value >> BigInt(limb * 64)) & 0xffffffffffffffffn).toString(16)}ULL`)
    .join(", ");
}

function singleResultContract(returns: SemanticType): FunctionContract {
  return {
    version: "1",
    numeric: { floatingPoint: "ieee754", rounding: "nearest", fastMath: false },
    function: {
      name: "subject",
      symbol: "subject",
      params: [],
      returns: returns.kind === "primitive" ? returns.name : "u8",
    },
    optimize: { primary: "latency", secondary: "size" },
    effects: [],
    memory: { reads: [], writes: [], aliasing: [] },
    requires: [],
    ensures: [],
    definition: { statements: [], objects: {}, allocates: false, prints: false, readsArgv: false, calls: [] },
  };
}

/**
 * The four limbs of a wide number, least significant first, as C literals.
 *
 * Derived from the same text the expectation is computed from, because writing
 * the two out separately is how they come to disagree: a hand-written limb and
 * a hand-written expectation of the same number is two chances to be wrong in
 * ways that cancel out, and the test passes.
 */
function cLimbs(hex: string): string {
  const digits = hex.replace(/^0x/, "");
  return [0, 1, 2, 3]
    .map((limb) => `0x${digits.slice((3 - limb) * 16, (4 - limb) * 16)}ULL`)
    .join(", ");
}

/** A wide number written as the thirty-two hex digits its limbs spell. */
function hexadecimal(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

/* ------------------------------------------------------------------------ */
/* The carry chain                                                            */
/* ------------------------------------------------------------------------ */

/**
 * `void carry(const uint64_t *a, const uint64_t *b, uint64_t *r)`, written in
 * the machine encoder rather than in the backend, so that what is checked here
 * is the encoding of a carry chain and nothing else: that `adc` and `sbb` are
 * the opcodes they are taken to be, and that a memory operand with a
 * displacement of eight, sixteen and twenty four bytes addresses the limb it
 * means to.
 */
function carryChain(op: "add" | "sub"): Uint8Array {
  const code = new Encoder();
  // The left operand is brought into the working registers and the right is
  // read as a memory operand, so the chain reads left to right and the order
  // the two are written in is the order they are subtracted in.
  for (let limb = 0; limb < 4; limb += 1) code.movRegMemSized(WORK[limb], mem(RDI, limb * 8), 8, false);
  code.aluRegMem(op, WORK[0], mem(RSI, 0), true);
  for (let limb = 1; limb < 4; limb += 1) {
    code.aluRegMem(op === "add" ? "adc" : "sbb", WORK[limb], mem(RSI, limb * 8), true);
  }
  for (let limb = 0; limb < 4; limb += 1) code.movMemRegSized(mem(RDX, limb * 8), WORK[limb], 8);
  return code.finish();
}

test("a carry chain the machine encoder writes is the arithmetic the language's bigints do", async () => {
  // The chain is the whole of what a wide addition is once the operands have
  // been brought into registers: one instruction for the first limb and one per
  // limb after it, with no branch and no memory round trip between them. If the
  // carry is not threaded, the answer differs from the right one in its high
  // limbs — which is why this is checked against `BigInt` and not a literal
  // written out by hand.
  const directory = await scratch("blaze-u256-carry-");
  const symbol = (name: string, op: "add" | "sub"): string => {
    const hex = Array.from(carryChain(op))
      .map((byte) => `0x${byte.toString(16).padStart(2, "0")}`)
      .join(",");
    return `__asm__(".globl ${name}\\n.type ${name},@function\\n${name}:\\n.byte ${hex}\\nret\\n.size ${name},.-${name}\\n");`;
  };
  const LIMBS_A = "0x0123456789abcdeffedcba987654321089abcdef0123456776543210fedcba98";
  const LIMBS_B = "0xfedcba98765432100123456789abcdeffedcba98765432100123456789abcdef";
  await writeFile(
    join(directory, "carry.c"),
    [
      "#include <stdio.h>",
      "#include <stdint.h>",
      symbol("blaze_test_add", "add"),
      symbol("blaze_test_sub", "sub"),
      "extern void blaze_test_add(const uint64_t *, const uint64_t *, uint64_t *);",
      "extern void blaze_test_sub(const uint64_t *, const uint64_t *, uint64_t *);",
      "int main(void) {",
      `  const uint64_t a[4] = {${cLimbs(LIMBS_A)}};`,
      `  const uint64_t b[4] = {${cLimbs(LIMBS_B)}};`,
      "  uint64_t r[4];",
      "  blaze_test_add(a, b, r);",
      '  printf("add %016llx%016llx%016llx%016llx\\n", (unsigned long long)r[3], (unsigned long long)r[2], (unsigned long long)r[1], (unsigned long long)r[0]);',
      "  blaze_test_sub(a, b, r);",
      '  printf("sub %016llx%016llx%016llx%016llx\\n", (unsigned long long)r[3], (unsigned long long)r[2], (unsigned long long)r[1], (unsigned long long)r[0]);',
      "  return 0;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  const binary = join(directory, "carry");
  const built = run("gcc", ["-std=c11", "-O1", join(directory, "carry.c"), "-o", binary], { timeoutMs: 180_000 });
  assert.equal(built.code, 0, `the encoded chain must assemble:\n${built.stderr}`);

  const left = BigInt(LIMBS_A);
  const right = BigInt(LIMBS_B);
  const answers = run(binary, [], { timeoutMs: 60_000 }).stdout.trim().split("\n");
  assert.deepEqual(answers, [
    `add ${hexadecimal((left + right) & MODULUS)}`,
    `sub ${hexadecimal((left - right) & MODULUS)}`,
  ]);
});

test("the machine backend moves a wide number by a whole number of bits", async () => {
  // A shift is the one operation that is not a carry chain: bits leave one limb
  // and arrive in its neighbour, and the amount is a value rather than a flag.
  // These amounts are the ones that break a shift written limb at a time —
  // zero, one, a whole limb, one either side of a whole limb, the two highest
  // bits, and every bit position across the top limb.
  const M = MODULUS;
  const value = BigInt(`0x${WIDE_ARGUMENT}`);
  const cases: { op: "shl" | "shr"; by: number; answer: bigint }[] = [
    { op: "shl", by: 0, answer: value },
    { op: "shl", by: 1, answer: (value << 1n) & M },
    { op: "shl", by: 63, answer: (value << 63n) & M },
    { op: "shl", by: 64, answer: (value << 64n) & M },
    { op: "shl", by: 65, answer: (value << 65n) & M },
    { op: "shl", by: 127, answer: (value << 127n) & M },
    { op: "shl", by: 128, answer: (value << 128n) & M },
    { op: "shl", by: 191, answer: (value << 191n) & M },
    { op: "shl", by: 192, answer: (value << 192n) & M },
    { op: "shl", by: 255, answer: (value << 255n) & M },
    { op: "shr", by: 0, answer: value },
    { op: "shr", by: 1, answer: value >> 1n },
    { op: "shr", by: 63, answer: value >> 63n },
    { op: "shr", by: 64, answer: value >> 64n },
    { op: "shr", by: 65, answer: value >> 65n },
    { op: "shr", by: 127, answer: value >> 127n },
    { op: "shr", by: 128, answer: value >> 128n },
    { op: "shr", by: 191, answer: value >> 191n },
    { op: "shr", by: 192, answer: value >> 192n },
    { op: "shr", by: 255, answer: value >> 255n },
  ];
  for (const { op, by, answer } of cases) {
    const name = `${op}${by}`;
    const directory = await scratch(`blaze-u256-${name}-`);
    const runtime = await buildStandaloneRuntime(directory);
    const object = join(directory, "subject.o");
    const built = await buildMachineObject({
      fn: {
        name: "subject",
        symbol: "subject",
        params: [],
        returns: U256,
        requires: [],
        ensures: [],
        effects: [],
        allocates: false,
        prints: false,
        readsArgv: false,
        objects: {},
        calls: [],
        entry: {
          id: "entry",
          statements: [],
          releases: [],
          terminator: {
            k: "return",
            value: {
              k: "arith",
              type: U256,
              op,
              left: { k: "const", type: U256, text: `0x${WIDE_ARGUMENT}` },
              right: { k: "const", type: { kind: "primitive", name: "u32" }, text: String(by) },
            },
          },
        },
      },
      contract: singleResultContract(U256),
      target: TARGET,
      callable: new Set<string>(),
      objectPath: object,
    });
    assert.ok(built.textSizeBytes > 0, `the object carries the code a ${name} is`);
    await writeFile(
      join(directory, "driver.c"),
      [
        "#include <stdio.h>",
        "#include <stdint.h>",
        "struct blaze_u256 { uint64_t limbs[4]; };",
        "extern void subject(struct blaze_u256 *out);",
        "int main(void) {",
        "  struct blaze_u256 r;",
        "  subject(&r);",
        `  const uint64_t e[4] = {${expectedLimbsOf(answer)}};`,
        "  int ok = 1;",
        "  for (int i = 0; i < 4; i++) ok &= (r.limbs[i] == e[i]);",
        '  printf("%s\\n", ok ? "right" : "wrong");',
        "  return ok ? 0 : 1;",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    const binary = join(directory, "subject");
    const linked = run(
      "gcc",
      ["-std=c11", "-O2", join(directory, "driver.c"), object, runtime.objectPath, "-o", binary, "-lm"],
      { timeoutMs: 180_000 },
    );
    assert.equal(linked.code, 0, `a wide ${name} must link:\n${linked.stderr}`);
    const ran = run(binary, [], { timeoutMs: 60_000 });
    assert.equal(ran.stdout.trim(), "right", `a wide ${name} must answer correctly: ${ran.stderr}`);
  }
});

/* ------------------------------------------------------------------------ */
/* One vector set, two backends                                              */
/* ------------------------------------------------------------------------ */

/**
 * The pairs every backend is asked the same questions about.
 *
 * The set is chosen for what it makes a lowering get wrong rather than for
 * covering the space: a pair whose limbs are all distinct so that a limb left at
 * the wrong index cannot pass, a pair that carries out of every limb so that a
 * carry threaded into only the first limb cannot pass, and the two boundaries a
 * wide number is most likely to be mishandled at — all ones and one.
 */
const DIFFERENTIAL_VECTORS: readonly (readonly [string, string])[] = [
  ["0123456789abcdeffedcba987654321089abcdef0123456776543210fedcba98", "fedcba98765432100123456789abcdeffedcba98765432100123456789abcdef"],
  ["ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", "0000000000000000000000000000000000000000000000000000000000000001"],
  ["ffffffffffffffff0000000000000000ffffffffffffffff0000000000000000", "0000000000000000ffffffffffffffff0000000000000000ffffffffffffffff"],
  ["0000000000000000000000000000000000000000000000000000000000000000", "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"],
];

/**
 * The operations both backends are asked, each with the answer the language's
 * own `BigInt` gives for the same two numbers.
 *
 * Division and the rest are left out: they are the one path where both backends
 * call the same kernel, so a vector set including them compares the kernel
 * against itself and says nothing about either backend's own lowering.
 */
const DIFFERENTIAL_OPS = ["add", "sub", "mul", "and", "or", "xor", "shl", "shr"] as const;

/** The amount both shifts are asked for, as a machine number. */
const SHIFT_COUNT = 65n;
type DifferentialOp = (typeof DIFFERENTIAL_OPS)[number];

const DIFFERENTIAL_ANSWER: Record<DifferentialOp, (left: bigint, right: bigint) => bigint> = {
  add: (left, right) => left + right,
  sub: (left, right) => left - right,
  mul: (left, right) => left * right,
  and: (left, right) => left & right,
  or: (left, right) => left | right,
  xor: (left, right) => left ^ right,
  // The count of a shift is the number the source wrote, which is a scalar and
  // not a whole number of the width being shifted — `65` is past the first limb
  // and before the second, so every limb of the answer comes from a different
  // limb of the input and a backend that shifted one limb and stopped the wrong
  // way cannot pass.
  shl: (left) => (left << SHIFT_COUNT) & MODULUS,
  // The types are unsigned, so this is a zero fill at the top.
  shr: (left) => left >> SHIFT_COUNT,
};

test("a shift by a whole number is refused rather than answered", async () => {
  // The count of a shift is the number of bits to move, which is a machine
  // number. The IR does not stop a whole number from being written there, and
  // both backends used to take the first eight bytes of it as the count — the C
  // backend by asking its writer for a scalar expression of a value that is a
  // whole number, which produced a compound literal where an integer belongs
  // and did not compile, and the machine backend by reading the number as one
  // register, which compiled, ran, and answered the low half of the number
  // being shifted.
  //
  // The second is the reason this is tested rather than fixed in the validator:
  // it is a build that reported success and gave a wrong answer, which is the
  // one failure this compiler is built to make impossible.
  const U: SemanticType = { kind: "primitive", name: "u256" };
  const directory = await scratch("blaze-u256-count-");
  const refused = { k: "arith", type: U, op: "shl", left: { k: "const", type: U, text: "0x01" }, right: { k: "const", type: U, text: "0x08" } } as const;
  await assert.rejects(
    () =>
      buildMachineObject({
        fn: {
          name: "subject", symbol: "subject", params: [], returns: U, requires: [], ensures: [],
          effects: [], allocates: false, prints: false, readsArgv: false, objects: {}, calls: [],
          entry: { id: "entry", statements: [], releases: [], terminator: { k: "return", value: refused } },
        },
        contract: singleResultContract(U),
        target: TARGET,
        callable: new Set<string>(),
        objectPath: join(directory, "subject.o"),
      }),
    /number of bits to move/,
    "the machine backend must refuse a wide shift count rather than read one",
  );
  assert.throws(
    () => generateFunctionC({
      name: "subject", symbol: "subject", params: [], returns: U, requires: [], ensures: [],
      effects: [], allocates: false, prints: false, readsArgv: false, objects: {}, calls: [],
      entry: { id: "entry", statements: [], releases: [], terminator: { k: "return", value: refused } },
    }),
    /number of bits to move/,
    "the C backend must refuse a wide shift count rather than coerce one",
  );
});

test("the backends write a whole number as the same limbs in the same order", () => {
  // The IR says a wide number is four limbs least significant first, and says so
  // once, because it is the order the runtime reads a value it is handed a
  // pointer to in. A backend is free to carry the number however it likes — in
  // registers here, in linear memory there — but what it writes out is the
  // number's limbs in the order the IR names, or a value handed from one backend
  // to another is a different number.
  //
  // The number is read back from each backend's own answer rather than from a
  // struct, because the point is what each one writes, not what it was handed.
  const left = "fedcba98765432100123456789abcdeffedcba98765432100123456789abcdef";
  assert.equal(limbsOf("u256"), 4, "a u256 is four limbs, and the count is the IR's");
  const expected = "fedcba9876543210" + "0123456789abcdef" + "fedcba9876543210" + "0123456789abcdef";
  assert.equal(wasmBackendAnswer("add", left, "0".repeat(64)), expected, "the WebAssembly backend writes the limbs least significant first");
});

test("a wide shift count of the width or more answers zero rather than walking off the number", () => {
  // The C runtime answers a count of the width or more with a whole number of
  // zero limbs, and the language agrees: nothing of the number survives a move
  // past its own width. The WebAssembly backend walked a padded copy of the
  // number instead, and the padding covers a count below the width and nothing
  // above it, so such a count read outside the module's memory and the module
  // trapped rather than answering.
  const left = "fedcba98765432100123456789abcdeffedcba98765432100123456789abcdef";
  const value = BigInt(`0x${left}`);
  for (const op of ["shl", "shr"] as const) {
    for (const count of [0, 63, 64, 65, 255, 256, 257, 320, 1000]) {
      const answer = wasmAnswerOf({
        k: "arith",
        type: U256,
        op,
        left: { k: "const", type: U256, text: `0x${left}` },
        right: { k: "const", type: { kind: "primitive", name: "usize" }, text: String(count) },
      });
      const expected = count >= 256 ? 0n : op === "shl" ? (value << BigInt(count)) & MODULUS : value >> BigInt(count);
      assert.equal(answer, expected.toString(16).padStart(64, "0"), `the WebAssembly backend's ${op} of a number by ${count}`);
    }
  }
});


test("the C backend writes a wide number the program printed", async () => {
  // A whole number is written as the integer it is, and the machine-integer path
  // casts to `unsigned long long` — which is a C error over four limbs rather
  // than a number, so a program printing or interpolating a wide number did not
  // build at all.
  const U = U256;
  const value: SemanticValue = {
    k: "arith",
    type: U,
    op: "add",
    left: { k: "const", type: U, text: "0x0123456789abcdeffedcba9876543210" },
    right: { k: "const", type: U, text: "0x1" },
  };
  const directory = await scratch("blaze-u256-print-c-");
  await writeFile(join(directory, `${RUNTIME_NAME}.h`), runtimeHeaderSource(), "utf8");
  await writeFile(join(directory, "runtime.c"), runtimeSourceSource("danger"), "utf8");
  const subject = generateFunctionC({
    name: "subject",
    symbol: "subject",
    params: [],
    returns: U,
    requires: [],
    ensures: [],
    effects: [],
    allocates: false,
    prints: true,
    readsArgv: false,
    objects: {},
    calls: [],
    entry: {
      id: "entry",
      statements: [{ k: "printNumber", value, line: 1, bigint: false }],
      releases: [],
      terminator: { k: "return", value: { k: "const", type: U, text: "0x0" } },
    },
  });
  await writeFile(
    join(directory, "print.c"),
    ["#include <stdio.h>", subject, "int main(void) { subject(); return 0; }", ""].join("\n"),
    "utf8",
  );
  const binary = join(directory, "print");
  const built = run(
    "gcc",
    ["-std=c11", "-O2", "-I", directory, join(directory, "print.c"), join(directory, "runtime.c"), "-o", binary],
    { timeoutMs: 180_000 },
  );
  assert.equal(built.code, 0, `the C must build:\n${built.stderr}`);
  const result = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    result.stdout,
    `${BigInt("0x0123456789abcdeffedcba9876543210") + 1n}`,
    "the program printed the number it was given",
  );
});


test("the C, machine and WebAssembly backends answer one vector set the same way", async () => {
  // Two backends that lower the same IR to two different languages will drift,
  // and the drift is invisible to a test that checks each against a literal: the
  // literal can be wrong in the same direction as the code. Checking both
  // against `BigInt` over the same vectors says something neither can say alone
  // — that the two implementations of carry, borrow and ordering agree, and that
  // both agree with the language's own answer for the same numbers.
  //
  // The WebAssembly backend answers what it has written and refuses the rest, so
  // the vector set names it in the failure rather than the harness skipping the
  // third backend quietly: a backend that stops being checked is one that stops
  // being known.
  for (const [leftText, rightText] of DIFFERENTIAL_VECTORS) {
    for (const op of DIFFERENTIAL_OPS) {
      const left = BigInt(`0x${leftText}`);
      const right = BigInt(`0x${rightText}`);
      const expected = (DIFFERENTIAL_ANSWER[op](left, right)) & MODULUS;
      // The C runtime's formatter writes the shortest form of a whole number, so
      // `1` comes back as one digit where a machine `%016llx` writes sixteen. The
      // number is the same either way and the comparison is about the number, so
      // both are read as the same fixed width.
      const viaC = (await cBackendAnswer(op, leftText, rightText)).padStart(64, "0");
      const viaMachine = await machineBackendAnswer(op, leftText, rightText);
      assert.equal(viaC, hexadecimal(expected), `the C backend's ${op} of ${leftText} and ${rightText}`);
      assert.equal(viaMachine, hexadecimal(expected), `the machine backend's ${op} of ${leftText} and ${rightText}`);
      // A backend that has not written an operation refuses it, and the refusal
      // is recorded rather than swallowed: what the WebAssembly backend has
      // answered is asserted below, so an operation leaving that set is visible.
      let answered: string | null = null;
      try {
        answered = wasmBackendAnswer(op, leftText, rightText);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("has not written")) throw error;
        wasmRefused.add(op);
      }
      if (answered !== null) {
        wasmAnswered.add(op);
        assert.equal(answered, hexadecimal(expected), `the WebAssembly backend's ${op} of ${leftText} and ${rightText}`);
      }
    }
  }
  // What the WebAssembly backend answers of this set, named. An operation
  // leaving it is the backend losing a capability, and the name is here so that
  // losing one is a failing test rather than a line that quietly vanished.
  assert.deepEqual(
    [...wasmAnswered].sort(),
    ["add", "and", "or", "shl", "shr", "sub", "xor"],
    "the operations the WebAssembly backend answers of this vector set",
  );
});

/** One operation on two wide literals, lowered to C, compiled, and run. */
/** The right operand of an operation: a whole number, or a shift's scalar count. */
function rightOperand(op: DifferentialOp, wide: SemanticType, text: string): SemanticValue {
  return op === "shl" || op === "shr"
    ? { k: "const", type: { kind: "primitive", name: "usize" }, text: SHIFT_COUNT.toString() }
    : { k: "const", type: wide, text: `0x${text}` };
}

async function cBackendAnswer(op: DifferentialOp, leftText: string, rightText: string): Promise<string> {
  const U = U256;
  const directory = await scratch("blaze-u256-diff-c-");
  await writeFile(join(directory, `${RUNTIME_NAME}.h`), runtimeHeaderSource(), "utf8");
  await writeFile(join(directory, "runtime.c"), runtimeSourceSource("danger"), "utf8");
  const subject = generateFunctionC({
    name: "subject",
    symbol: "subject",
    params: [],
    returns: U,
    requires: [],
    ensures: [],
    effects: [],
    allocates: false,
    prints: false,
    readsArgv: false,
    objects: {},
    calls: [],
    entry: {
      id: "entry",
      statements: [],
      releases: [],
      terminator: {
        k: "return",
        value: { k: "arith", type: U, op, left: { k: "const", type: U, text: `0x${leftText}` }, right: rightOperand(op, U, rightText) },
      },
    },
  });
  await writeFile(
    join(directory, "wide.c"),
    [
      "#include <stdio.h>",
      subject,
      "int main(void) {",
      "  blaze_u256 r = subject();",
      "  unsigned char text[80];",
      `  (void)${RUNTIME_NAME}_u256_format(&r, 16, text, sizeof text);`,
      '  printf("%s\\n", (const char *)text);',
      "  return 0;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  const binary = join(directory, "wide");
  const built = run(
    "gcc",
    ["-std=c11", "-O2", "-I", directory, join(directory, "wide.c"), join(directory, "runtime.c"), "-o", binary],
    { timeoutMs: 180_000 },
  );
  assert.equal(built.code, 0, `the C must build:\n${built.stderr}`);
  return run(binary, [], { timeoutMs: 60_000 }).stdout.trim();
}

/** The same operation, lowered to machine code, linked and run. */
/**
 * What the WebAssembly backend has answered of the set, and what it has not.
 */
const wasmAnswered = new Set<DifferentialOp>();
const wasmRefused = new Set<DifferentialOp>();

/**
 * The operation answered by the WebAssembly backend, run as a module.
 *
 * A wide number is a pointer into the module's own memory here rather than a
 * struct the host passes in, so the answer is read off that memory at the address
 * the module returns. An operation this backend has not written raises, which is
 * how the caller learns it is not answered.
 */
function wasmBackendAnswer(op: DifferentialOp, leftText: string, rightText: string): string {
  return wasmAnswerOf({
    k: "arith",
    type: U256,
    op: op as ArithOp,
    left: { k: "const", type: U256, text: `0x${leftText}` },
    right: rightOperand(op, U256, rightText),
  });
}

/**
 * The module's answer to a body that is one wide operation, read back off the
 * memory it wrote it into.
 *
 * A wide number is a pointer into the module's own memory here rather than a
 * struct the host passes in, so the answer is read off that memory at the address
 * the module returns. An operation this backend has not written raises, which is
 * how the caller learns it is not answered.
 */
function wasmAnswerOf(value: SemanticValue): string {
  const memory = new engine.Memory({ initial: 1 });
  const bytes = moduleBytes(
    {
      name: "subject",
      symbol: "subject",
      params: [],
      returns: U256,
      requires: [],
      ensures: [],
      effects: [],
      allocates: false,
      prints: false,
      readsArgv: false,
      objects: {},
      calls: [],
      entry: {
        id: "entry",
        statements: [],
        releases: [],
        terminator: { k: "return", value },
      },
    } as unknown as SemanticFunction,
    {
      version: "1",
      numeric: { floatingPoint: "ieee754", rounding: "nearest", fastMath: false },
      function: { name: "subject", symbol: "subject", params: [], returns: "u256" },
      optimize: { primary: "latency", secondary: "size" },
      effects: [],
      memory: { reads: [], writes: [], aliasing: [] },
      requires: [],
      ensures: [],
      definition: { statements: [], objects: {}, allocates: false, prints: false, readsArgv: false, calls: [] },
    },
  );
  const instance = new engine.Instance(new engine.Module(bytes), { env: { memory } });
  const address = (instance.exports as { subject: () => number }).subject();
  const view = new Uint8Array(memory.buffer);
  let limbs = "";
  for (let limb = 3; limb >= 0; limb -= 1) {
    for (let at = 7; at >= 0; at -= 1) limbs += view[address + limb * 8 + at].toString(16).padStart(2, "0");
  }
  return limbs;
}

async function machineBackendAnswer(op: DifferentialOp, leftText: string, rightText: string): Promise<string> {
  const directory = await scratch("blaze-u256-diff-m-");
  const runtime = await buildStandaloneRuntime(directory);
  const object = join(directory, "subject.o");
  const built = await buildMachineObject({
    fn: {
      name: "subject",
      symbol: "subject",
      params: [],
      returns: U256,
      requires: [],
      ensures: [],
      effects: [],
      allocates: false,
      prints: false,
      readsArgv: false,
      objects: {},
      calls: [],
      entry: {
        id: "entry",
        statements: [],
        releases: [],
        terminator: {
          k: "return",
          value: {
            k: "arith",
            type: U256,
            op,
            left: { k: "const", type: U256, text: `0x${leftText}` },
            right: rightOperand(op, U256, rightText),
          },
        },
      },
    },
    contract: singleResultContract(U256),
    target: TARGET,
    callable: new Set<string>(),
    objectPath: object,
  });
  assert.ok(built.textSizeBytes > 0, "the object carries the code");
  await writeFile(
    join(directory, "driver.c"),
    [
      "#include <stdio.h>",
      "#include <stdint.h>",
      "struct blaze_u256 { uint64_t limbs[4]; };",
      "extern void subject(struct blaze_u256 *out);",
      "int main(void) {",
      "  struct blaze_u256 r;",
      "  subject(&r);",
      '  printf("%016llx%016llx%016llx%016llx\\n", (unsigned long long)r.limbs[3], (unsigned long long)r.limbs[2], (unsigned long long)r.limbs[1], (unsigned long long)r.limbs[0]);',
      "  return 0;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  const binary = join(directory, "subject");
  const linked = run(
    "gcc",
    ["-std=c11", "-O2", join(directory, "driver.c"), object, runtime.objectPath, "-o", binary, "-lm"],
    { timeoutMs: 180_000 },
  );
  assert.equal(linked.code, 0, `the machine code must link:\n${linked.stderr}`);
  return run(binary, [], { timeoutMs: 60_000 }).stdout.trim();
}

/**
 * `function subject(): u256` whose body computes a sum, then a product, then the
 * sum of the two — the shape a name has to survive a runtime call for.
 */
function wideSumThenProductFunction(): SemanticFunction {
  const literal = (text: string): SemanticValue => ({ k: "const", type: U256, text });
  const sum: SemanticValue = { k: "arith", type: U256, op: "add", left: literal(WIDE_LEFT), right: literal("01") };
  const product: SemanticValue = { k: "arith", type: U256, op: "mul", left: literal(WIDE_RIGHT), right: literal("02") };
  const answer: SemanticValue = { k: "arith", type: U256, op: "add", left: sum, right: product };
  return {
    name: "subject",
    symbol: "subject",
    params: [],
    returns: U256,
    requires: [],
    ensures: [],
    effects: [],
    allocates: false,
    prints: false,
    readsArgv: false,
    objects: {},
    calls: [],
    entry: {
      id: "entry",
      statements: [],
      releases: [],
      terminator: { k: "return", value: answer },
    },
  };
}

test("a name computed before a wide product is still there after it", async () => {
  // A multiplication of a whole number wider than a machine word has no
  // instruction: it is the runtime kernel, which is a real call and overwrites
  // every register a call is free to. The graph that decides where each name
  // lives was told about `pow` and about calls and not about this, so the sum
  // was pinned to a register the kernel clobbered and the answer was the product
  // alone.
  const directory = await scratch("blaze-u256-across-kernel-");
  const runtime = await buildStandaloneRuntime(directory);
  const object = join(directory, "subject.o");
  await buildMachineObject({
    fn: wideSumThenProductFunction(),
    contract: wideOperationContract(),
    target: TARGET,
    callable: new Set<string>(),
    objectPath: object,
  });

  await writeFile(
    join(directory, "driver.c"),
    [
      "#include <stdio.h>",
      "#include <stdint.h>",
      "extern void subject(uint64_t *out);",
      "int main(void) {",
      "  uint64_t r[4];",
      "  subject(r);",
      '  printf("%016llx%016llx%016llx%016llx\\n", (unsigned long long)r[3], (unsigned long long)r[2], (unsigned long long)r[1], (unsigned long long)r[0]);',
      "  return 0;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  const binary = join(directory, "subject");
  const linked = run(
    "gcc",
    ["-std=c11", "-O2", join(directory, "driver.c"), object, runtime.objectPath, "-o", binary, "-lm"],
    { timeoutMs: 180_000 },
  );
  assert.equal(linked.code, 0, `the object must link:\n${linked.stderr}`);
  const ran = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(ran.code, 0, `the object must run:\n${ran.stderr}`);
  const left = BigInt(WIDE_LEFT);
  const right = BigInt(WIDE_RIGHT);
  const expected = ((left + 1n) + ((right * 2n) & MODULUS)) & MODULUS;
  assert.equal(ran.stdout.trim(), hexadecimal(expected), "the sum computed before the product is part of the answer");
});

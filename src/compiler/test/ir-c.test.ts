/**
 * What the C the compiler lowers a function's IR into computes.
 *
 * A build that asks for `c`, `asm` or `machine` is this file and nothing else:
 * the model wrote the IR, and the C below is what the target compiler reads.
 * These lower hand-written IR, build it against a driver and a callee that
 * counts how many times it was called, and run it, so a lowering that does not
 * compile, that runs a value twice, or that answers something other than what
 * the IR states fails here rather than in a candidate's verification.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { semanticFunctionProblems } from "../semantics/ir-validate.ts";
import { validateCSource } from "../toolchain/csource.ts";
import { generateFunctionC } from "../toolchain/ir-c.ts";
import { buildStandaloneRuntime } from "../runtime/standalone.ts";
import { run } from "../core/process.ts";
import type { FunctionContract, ObjectLayout } from "../core/types.ts";
import type { SemanticBlock, SemanticFunction, SemanticSlot, SemanticType, SemanticValue } from "../core/semantic-ir.ts";
import { scratch } from "./scratch.ts";

const F64: SemanticType = { kind: "primitive", name: "f64" };
const USIZE: SemanticType = { kind: "primitive", name: "usize" };
const BOOL: SemanticType = { kind: "primitive", name: "bool" };
const TEXT: SemanticType = { kind: "text" };
const PTR: SemanticType = { kind: "ptr", of: F64 };
const VOID: SemanticType = { kind: "void" };
const POINT: SemanticType = { kind: "ref", of: null, name: "Point" };

function subject(returns: SemanticType, entry: SemanticBlock, params: SemanticSlot[] = [], objects: Record<string, ObjectLayout> = {}): SemanticFunction {
  return {
    name: "subject",
    symbol: "subject",
    params,
    returns,
    requires: [],
    ensures: [],
    effects: [],
    allocates: false,
    prints: false,
    readsArgv: false,
    objects,
    calls: [],
    entry,
  };
}

/** A body that hands one value back. */
function handsBack(value: SemanticValue): SemanticBlock {
  return { id: "entry", statements: [], releases: [], terminator: { k: "return", value } };
}

/** A body that runs statements and hands back nothing. */
function runs(statements: SemanticBlock["statements"]): SemanticBlock {
  return { id: "entry", statements, releases: [], terminator: { k: "next" } };
}

const local = (name: string, type: SemanticType = F64): SemanticValue => ({ k: "local", type, name });

test("a candidate reaching for inline assembly is refused however it spells it", () => {
  // The C a candidate delivers is compiled by the C compiler, which reads
  // `asm`, `__asm` and `__asm__` as the same keyword and takes whitespace before
  // its parenthesis. A scan for one spelling let the others through to the
  // compiler, which is the one thing the subset exists to keep out.
  const contract: FunctionContract = {
    version: "1",
    numeric: { floatingPoint: "ieee754", rounding: "nearest", fastMath: false },
    function: { name: "f", symbol: "blaze_f", params: [{ name: "x", type: "f64" }], returns: "f64" },
    optimize: { primary: "latency", secondary: "size" },
    effects: [],
    memory: { reads: [], writes: [], aliasing: [] },
    requires: [],
    ensures: [],
    definition: { statements: [], objects: {}, allocates: false, prints: false, readsArgv: false, calls: [] },
  };
  for (const spelling of [
    `asm ("nop");`,
    `asm("nop");`,
    `asm volatile ("nop");`,
    `__asm ("nop");`,
    `__asm__("nop");`,
  ]) {
    const source = `double blaze_f(double x) { ${spelling} return x; }`;
    assert.throws(
      () => validateCSource(source, contract),
      (error: unknown) => {
        assert.match((error as { detail?: string }).detail ?? "", /inline assembly is not allowed/);
        return true;
      },
      `"${spelling}" must be refused`,
    );
  }
  validateCSource("double blaze_f(double x) { return x + 1; }", contract);
});

/** A call to `f`, which the driver counts, so a value written twice shows. */
const counted = (): SemanticValue => ({
  k: "call",
  type: F64,
  call: {
    callee: "f",
    builtin: false,
    signature: { name: "f", symbol: "f", params: [{ name: "v", type: "f64" }], returns: "f64" },
    args: [local("v")],
    argTypes: [F64],
    returns: F64,
    effects: [],
    ownership: "none",
    retain: false,
  },
});

/** A call to `g`, which counts as well and hands back a pointer. */
const countedPointer = (): SemanticValue => ({
  k: "call",
  type: PTR,
  call: {
    callee: "g",
    builtin: false,
    signature: { name: "g", symbol: "g", params: [{ name: "v", type: "f64" }], returns: "ptr<f64>" },
    args: [local("v")],
    argTypes: [F64],
    returns: PTR,
    effects: [],
    ownership: "none",
    retain: false,
  },
});

const literal = (text: string): SemanticValue => ({ k: "text", type: { kind: "text" }, parts: [{ k: "text", value: text }] });

/** One text followed by another, which is what `+` is over text. */
const joined = (left: SemanticValue, right: SemanticValue): SemanticValue => ({
  k: "arith",
  type: { kind: "text" },
  op: "concat",
  left,
  right,
});

const truth = (op: "eq" | "ne", left: SemanticValue, right: SemanticValue): SemanticValue => ({
  k: "compare",
  type: BOOL,
  op,
  operand: { kind: "text" },
  left,
  right,
});

/** Two numbers to work on, so every shape has a value to read. */
const NUMBERS: SemanticSlot[] = [
  { kind: "value", name: "v", mutable: false, type: F64 },
  { kind: "value", name: "w", mutable: false, type: F64 },
];

/**
 * Lowers one function, builds it with the driver beside it, and answers what it
 * wrote. The callees are a translation unit of their own so the C compiler
 * cannot fold two calls to one into one: the count is what the program did,
 * whatever the C compiler could prove about it.
 */
async function lowered(fn: SemanticFunction, driver: (name: string) => string): Promise<string> {
  const directory = await scratch("blaze-irc-");
  const source = join(directory, `${fn.symbol}.c`);
  await writeFile(
    source,
    [
      "#include <stdio.h>",
      "extern int calls;",
      "extern double f(double v);",
      "extern double* g(double v);",
      generateFunctionC(fn),
      `int main(void) { ${driver(fn.symbol)} return 0; }`,
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(directory, "callee.c"),
    [
      "int calls = 0;",
      "double f(double v) { calls++; return v + 1.0; }",
      "double seed = 1.5;",
      "double* g(double v) { calls++; return v > 0.0 ? &seed : 0; }",
      "",
    ].join("\n"),
    "utf8",
  );
  const runtime = await buildStandaloneRuntime(directory);
  const binary = join(directory, "subject");
  const built = run(
    "gcc",
    ["-std=c11", "-O2", "-I", directory, join(directory, "callee.c"), source, runtime.objectPath, "-o", binary],
    { timeoutMs: 120_000 },
  );
  assert.equal(built.code, 0, `the lowered C must build:\n${built.stderr}`);
  return run(binary, [], { timeoutMs: 60_000 }).stdout;
}

test("a value the IR calls is run once, whichever form writes it down", async () => {
  // Each of these hands an answer back from a call, and the C used to write the
  // value down twice — as the arm that decides and as the answer, or as the
  // length of a copy and its source — so a callee the program called once ran
  // once per copy.
  const shapes: { name: string; value: SemanticValue; returns: SemanticType }[] = [
    {
      name: "an interpolated part",
      returns: TEXT,
      value: { k: "text", type: { kind: "text" }, parts: [{ k: "text", value: "v=" }, { k: "value", value: counted() }] },
    },
    { name: "a smaller arm", returns: F64, value: { k: "arith", type: F64, op: "min", left: counted(), right: local("w") } },
    { name: "a greater arm", returns: F64, value: { k: "arith", type: F64, op: "max", left: local("w"), right: counted() } },
    { name: "an or that decides", returns: F64, value: { k: "logical", type: F64, op: "or", left: counted(), right: local("w") } },
    { name: "a coalesce that decides", returns: PTR, value: { k: "coalesce", type: PTR, left: countedPointer(), right: { k: "nothing", type: PTR } } },
    {
      name: "a rounded value",
      returns: F64,
      value: {
        k: "call",
        type: F64,
        call: {
          callee: "Math.round",
          builtin: true,
          signature: { name: "Math.round", symbol: "Math.round", params: [{ name: "value", type: "f64" }], returns: "f64" },
          args: [counted()],
          argTypes: [F64],
          returns: F64,
          effects: [],
          ownership: "none",
          retain: false,
        },
      },
    },
  ];
  for (const shape of shapes) {
    const stdout = await lowered(subject(shape.returns, handsBack(shape.value), NUMBERS), (name) =>
      `printf("calls=%d\\n", (${name}(1.0, 9.0), calls));`,
    );
    assert.equal(stdout, "calls=1\n", `${shape.name}`);
  }
});

test("a loop bound is read once rather than once per turn", async () => {
  // The bound of a counted loop is a value, and the C used to write it into the
  // `for` that reads it, so a bound that is a call ran once per turn: three
  // calls for two turns over a bound of two.
  const body: SemanticBlock = {
    id: "loopBody",
    statements: [{ k: "set", name: "total", op: "+=", value: { k: "const", type: F64, text: "1" }, line: 2 }],
    releases: [],
    terminator: { k: "next" },
  };
  const countedLoop: SemanticBlock["statements"][number] = {
    k: "loop",
    line: 2,
    loop: {
      kind: "counted",
      variable: "i",
      type: USIZE,
      from: { k: "const", type: USIZE, text: "0" },
      to: counted(),
      inclusive: false,
      down: false,
      step: null,
      header: "head",
      exit: "out",
      body,
    },
  };
  const stdout = await lowered(
    subject(
      F64,
      {
        id: "entry",
        statements: [
          { k: "let", slot: { kind: "value", name: "total", mutable: true, type: F64 }, value: { k: "const", type: F64, text: "0" }, line: 1 },
          countedLoop,
        ],
        releases: [],
        terminator: { k: "return", value: local("total") },
      },
      NUMBERS,
    ),
    (name) => `const double result = ${name}(1.0, 9.0); printf("%f calls=%d\\n", result, calls);`,
  );
  assert.equal(stdout, "2.000000 calls=1\n");
});

test("a counted loop counts from the name around it when its index is that name", async () => {
  // The index is declared before the bounds are read, so a bound that reads
  // the same name resolved to the loop's own declaration: the C read a
  // variable it had not declared yet and the object did not build. The name
  // around the loop is what the loop starts from.
  const body: SemanticBlock = {
    id: "loopBody",
    statements: [{ k: "set", name: "total", op: "+=", value: local("limit"), line: 3 }],
    releases: [],
    terminator: { k: "next" },
  };
  const fn = subject(
    F64,
    {
      id: "entry",
      statements: [
        { k: "let", slot: { kind: "value", name: "total", mutable: true, type: F64 }, value: { k: "const", type: F64, text: "0" }, line: 1 },
        {
          k: "loop",
          line: 2,
          loop: {
            kind: "counted",
            variable: "limit",
            type: F64,
            from: local("limit"),
            to: { k: "const", type: F64, text: "5" },
            inclusive: false,
            down: false,
            step: null,
            header: "head",
            exit: "out",
            body,
          },
        },
      ],
      releases: [],
      terminator: { k: "return", value: local("total") },
    },
    [{ kind: "value", name: "limit", mutable: false, type: F64 }],
  );
  // 3 + 4 over a bound of 5: the loop starts at the limit around it.
  assert.equal(await lowered(fn, (name) => `printf("%g\\n", ${name}(3.0));`), "7\n");
});

test("a string grows by concatenation rather than by adding to a pointer", async () => {
  // `+=` over a string is a new value, not an addition in place, and the C used
  // to write the operator down as written: `+=` on two pointers, which the C
  // compiler refuses. Both other targets already lower it as the concatenation
  // it is.
  const stdout = await lowered(
    subject(
      VOID,
      runs([
        { k: "let", slot: { kind: "text", name: "s", mutable: true }, value: literal("ab"), line: 1 },
        { k: "set", name: "s", op: "+=", value: literal("cd"), line: 2 },
        { k: "printText", value: local("s", { kind: "text" }), line: 3 },
      ]),
    ),
    (name) => `${name}();`,
  );
  assert.equal(stdout, "abcd");
});

test("appending to a string leaves the string the program still holds alone", async () => {
  // The runtime appended in place whenever the block carried one reference,
  // and a text block always carries one: a text value is never retained and
  // never released, so the count never rises. That made the count a statement
  // about whether *this call* had reached the block before and never about
  // whether anything else was looking at it, and `b = a + "!"` wrote the joined
  // string into the bytes of `a` — two names over one block, so the next
  // append to either of them rewrote the other. The answer below is what each
  // name holds, read back one at a time.
  const stdout = await lowered(
    subject(
      VOID,
      runs([
        { k: "let", slot: { kind: "text", name: "a", mutable: true }, value: joined(literal("x"), literal("y")), line: 1 },
        { k: "let", slot: { kind: "text", name: "b", mutable: true }, value: { k: "text", type: { kind: "text" }, parts: [{ k: "value", value: local("a", { kind: "text" }) }, { k: "text", value: "!" }] }, line: 2 },
        { k: "printText", value: local("a", { kind: "text" }), line: 3 },
        { k: "printNewline", line: 3 },
        { k: "printText", value: local("b", { kind: "text" }), line: 4 },
        { k: "printNewline", line: 4 },
        { k: "let", slot: { kind: "text", name: "c", mutable: true }, value: joined(local("a", { kind: "text" }), literal("?")), line: 5 },
        { k: "printText", value: local("a", { kind: "text" }), line: 6 },
        { k: "printNewline", line: 6 },
        { k: "printText", value: local("b", { kind: "text" }), line: 7 },
        { k: "printNewline", line: 7 },
        { k: "printText", value: local("c", { kind: "text" }), line: 8 },
        { k: "printNewline", line: 8 },
      ]),
    ),
    (name) => `${name}();`,
  );
  assert.equal(stdout, "xy\nxy!\nxy\nxy!\nxy?\n");
});

test("two strings are compared by what they say rather than by where they are", async () => {
  // A string built at run time and one written out are two addresses that say
  // the same thing. The comparison used to be a pointer comparison, so
  // `"ab" == "a" + "b"` was false and an empty string built at run time compared
  // unequal to `""`, which is what made `!text` answer wrong.
  const equal = await lowered(subject(BOOL, handsBack(truth("eq", literal("ab"), joined(literal("a"), literal("b"))))), (name) =>
    `printf("%d\\n", (int)${name}());`,
  );
  assert.equal(equal, "1\n");
  const empty = await lowered(subject(BOOL, handsBack(truth("ne", joined(literal(""), literal("")), literal("")))), (name) =>
    `printf("%d\\n", (int)${name}());`,
  );
  assert.equal(empty, "0\n");
});

test("the length of a string written out is its length", async () => {
  // A written-out string is a C literal, and the runtime's `string_length` reads
  // a header the runtime installed before the pointer it is handed: on a literal
  // that is whatever `.rodata` holds under it. A string is as long as its bytes,
  // which is what the C library answers for a literal and for a string the
  // runtime owns alike.
  const stdout = await lowered(
    subject(USIZE, handsBack({ k: "length", type: USIZE, of: local("s", { kind: "text" }) }), [{ kind: "text", name: "s", mutable: false }]),
    (name) => `printf("%zu\\n", ${name}("hello"));`,
  );
  assert.equal(stdout, "5\n");
});

test("a concatenation is as long as its parts", async () => {
  // The buffer a built string is laid out in was sized from the literals beside
  // the parts and a fixed room of 256 bytes for each interpolated one, so a
  // string longer than that was cut at the end of it, silently.
  const long = `x`.repeat(600);
  const stdout = await lowered(
    subject(TEXT, handsBack(joined(local("s", { kind: "text" }), literal("!"))), [{ kind: "text", name: "s", mutable: false }]),
    (name) => `const char* result = ${name}("${long}"); printf("%zu\\n", strlen(result));`,
  );
  assert.equal(stdout, "601\n");
});

test("a field whose name a C header holds is read and written as a field", async () => {
  // The layout declares its fields escaped against the keywords and the header
  // macros, so the struct holds `double NULL_;`, while every access was written
  // as `->NULL` and the preprocessor replaced it with `((void *)0)`.
  const objects: Record<string, ObjectLayout> = {
    Point: { name: "Point", fields: [{ name: "NULL", type: "f64", offset: 0 }], size: 8, align: 8 },
  };
  const stdout = await lowered(
    subject(
      F64,
      {
        id: "entry",
        statements: [
          {
            k: "let",
            slot: { kind: "object", name: "p", mutable: true, type: POINT },
            value: { k: "newObject", type: POINT, layout: "Point", fields: [{ name: "NULL", value: { k: "const", type: F64, text: "42" } }] },
            line: 1,
          },
        ],
        releases: [],
        terminator: { k: "return", value: { k: "loadField", type: F64, object: local("p", POINT), layout: "Point", field: "NULL" } },
      },
      [],
      objects,
    ),
    (name) => `printf("%f\\n", ${name}());`,
  );
  assert.equal(stdout, "42.000000\n");
});

test("a reference is written as the address a driver writes for one", async () => {
  // A reference is no number of its own, and the C used to cast it to one, which
  // is not C at all: printing an object was a source the compiler refuses. An
  // absent reference is the word the language prints, and the rest are read as
  // the address the driver prints for one.
  const objects: Record<string, ObjectLayout> = {
    Point: { name: "Point", fields: [{ name: "x", type: "f64", offset: 0 }], size: 8, align: 8 },
  };
  const held: SemanticValue = { k: "local", type: POINT, name: "p" };
  const built: SemanticValue = {
    k: "newObject",
    type: POINT,
    layout: "Point",
    fields: [{ name: "x", value: { k: "const", type: F64, text: "1" } }],
  };
  const stdout = await lowered(
    subject(
      PTR,
      {
        id: "entry",
        statements: [
          { k: "let", slot: { kind: "object", name: "p", mutable: true, type: POINT }, value: built, line: 1 },
          { k: "printText", value: { k: "toText", digits: null, type: TEXT, of: held }, line: 2 },
          { k: "printNewline", line: 3 },
        ],
        releases: [],
        terminator: { k: "return", value: held },
      },
      [],
      objects,
    ),
    (name) => `double* result = ${name}(); printf("%llu\\n", (unsigned long long)(uintptr_t)result);`,
  );
  const [written, address] = stdout.trim().split("\n");
  assert.equal(written, address);
});

test("two names that escape to one are still two names", async () => {
  // `int` is a C keyword and escapes to `int_`, which is a name the program is
  // free to have written itself. Which one is taken used to be decided before
  // the escaping, so the two were declared under one name and the object was a
  // redefinition of the other.
  const stdout = await lowered(
    subject(
      F64,
      handsBack({ k: "arith", type: F64, op: "sub", left: local("int"), right: local("int_") }),
      [
        { kind: "value", name: "int", mutable: false, type: F64 },
        { kind: "value", name: "int_", mutable: false, type: F64 },
      ],
    ),
    (name) => `printf("%f\\n", ${name}(10.0, 4.0));`,
  );
  assert.equal(stdout, "6.000000\n");
});

test("a callee whose parameter is named after a C keyword still builds", async () => {
  // The declaration of another function of the program is the only place a
  // callee's parameter names are written down — the callee declares its own
  // under names C accepts — and they were written as the contract spells them.
  const called: SemanticValue = {
    k: "call",
    type: F64,
    call: {
      callee: "f",
      builtin: false,
      signature: { name: "f", symbol: "f", params: [{ name: "int", type: "f64" }], returns: "f64" },
      args: [local("v")],
      argTypes: [F64],
      returns: F64,
      effects: [],
      ownership: "none",
      retain: false,
    },
  };
  const stdout = await lowered(
    subject(F64, handsBack(called), [{ kind: "value", name: "v", mutable: false, type: F64 }]),
    (name) => `printf("%f\\n", ${name}(1.0));`,
  );
  assert.equal(stdout, "2.000000\n");
});

test("every operator the IR states is one C can spell", async () => {
  // The emitter names each operation the IR states and then asks a shared
  // table for its C spelling. A remainder was named in one table and not the
  // other, so every function using `%` was refused at the emitter instead of
  // lowered, and nothing that built exercised the path.
  for (const op of ["add", "sub", "mul", "div", "mod", "shl", "shr", "and", "or", "xor"]) {
    const value: SemanticValue = { k: "arith", type: F64, op: op as "add", left: local("a"), right: local("b") };
    const c = generateFunctionC(
      subject(F64, handsBack(value), [
        { kind: "value", name: "a", mutable: false, type: F64 },
        { kind: "value", name: "b", mutable: false, type: F64 },
      ]),
    );
    assert.doesNotMatch(c, /cannot spell/, `the emitter must lower \`${op}\``);
  }
  // And the one that was missing computes what the source computes. A
  // remainder is over whole numbers, which is what the resolver gives it, and
  // `12 % 5` is 2.
  const I64: SemanticType = { kind: "primitive", name: "i64" };
  const whole = (name: string): SemanticValue => ({ k: "local", type: I64, name });
  const remainder: SemanticValue = { k: "arith", type: I64, op: "mod", left: whole("a"), right: whole("b") };
  const stdout = await lowered(
    subject(I64, handsBack(remainder), [
      { kind: "value", name: "a", mutable: false, type: I64 },
      { kind: "value", name: "b", mutable: false, type: I64 },
    ]),
    (name) => `printf("%lld\\n", ${name}(12LL, 5LL));`,
  );
  assert.equal(stdout, "2\n");
});

test("a minimum and a maximum answer a value that is not a number, and a signed zero", async () => {
  // `NaN > 1.0` is false in C, so the order alone answers one of the arms
  // where the source answers NaN, and `fmax(0.0, -0.0)` is `-0.0` where the
  // source answers `+0`. Both are the language rather than C: a NaN is carried
  // through whatever it is compared with, and a tie between two zeros is
  // answered by the sign, which is the only thing that tells them apart.
  const constant = (text: string): SemanticValue => ({ k: "const", type: F64, text });
  const extremum = (op: "min" | "max", left: SemanticValue, right: SemanticValue): SemanticFunction =>
    subject(F64, handsBack({ k: "arith", type: F64, op, left, right }));
  /** What the lowered function answered, as the language writes a value. */
  const answer = (name: string): string =>
    `const double r = ${name}(); printf("%s\\n", isnan(r) ? "nan" : (r == 0.0 ? (signbit(r) ? "-0" : "0") : "number"));`;
  const shapes: { name: string; fn: SemanticFunction; expected: string }[] = [
    { name: "a maximum of a NaN and a number", fn: extremum("max", constant("0.0 / 0.0"), constant("1.0")), expected: "nan\n" },
    { name: "a maximum of a number and a NaN", fn: extremum("max", constant("1.0"), constant("0.0 / 0.0")), expected: "nan\n" },
    { name: "a minimum of a NaN and a number", fn: extremum("min", constant("0.0 / 0.0"), constant("1.0")), expected: "nan\n" },
    { name: "a maximum of a positive and a negative zero", fn: extremum("max", constant("0.0"), constant("-0.0")), expected: "0\n" },
    { name: "a maximum of a negative and a positive zero", fn: extremum("max", constant("-0.0"), constant("0.0")), expected: "0\n" },
    { name: "a minimum of a positive and a negative zero", fn: extremum("min", constant("0.0"), constant("-0.0")), expected: "-0\n" },
    { name: "a minimum of a negative and a positive zero", fn: extremum("min", constant("-0.0"), constant("0.0")), expected: "-0\n" },
    { name: "a maximum of two numbers", fn: extremum("max", constant("1.0"), constant("2.0")), expected: "number\n" },
    { name: "a minimum of two equal numbers", fn: extremum("min", constant("-5.0"), constant("-5.0")), expected: "number\n" },
  ];
  for (const shape of shapes) {
    assert.equal(await lowered(shape.fn, answer), shape.expected, shape.name);
  }
});

test("a whole number is written as the integer it is, above the width of a double", async () => {
  // The runtime's formatter takes a double, and a double holds every i64 only
  // up to 2^53: 9223372036854775807 went out as 9223372036854775808 and a u64
  // above 2^53 lost its last digits. Both the way a value is printed and the
  // way a string interpolates it answer the whole number itself.
  const shapes: { name: string; type: SemanticType; argument: string; written: string }[] = [
    { name: "the largest i64", type: { kind: "primitive", name: "i64" }, argument: "9223372036854775807LL", written: "9223372036854775807" },
    { name: "the smallest i64", type: { kind: "primitive", name: "i64" }, argument: "-9223372036854775807LL - 1", written: "-9223372036854775808" },
    { name: "the largest u64", type: { kind: "primitive", name: "u64" }, argument: "18446744073709551615ULL", written: "18446744073709551615" },
    { name: "a usize past a double", type: { kind: "primitive", name: "usize" }, argument: "9007199254740993ULL", written: "9007199254740993" },
    { name: "the smallest i32", type: { kind: "primitive", name: "i32" }, argument: "-2147483647 - 1", written: "-2147483648" },
  ];
  for (const shape of shapes) {
    const parameter: SemanticSlot = { kind: "value", name: "n", mutable: false, type: shape.type };
    const read: SemanticValue = { k: "local", type: shape.type, name: "n" };
    const printed = await lowered(
      subject(VOID, runs([{ k: "printNumber", value: read, line: 1, bigint: false }]), [parameter]),
      (name) => `${name}(${shape.argument});`,
    );
    assert.equal(printed.trimEnd(), shape.written, shape.name);

    const interpolated = await lowered(
      subject(TEXT, handsBack(joined(literal("v="), { k: "toText", digits: null, type: TEXT, of: read })), [parameter]),
      (name) => `printf("%s\\n", ${name}(${shape.argument}));`,
    );
    assert.equal(interpolated.trimEnd(), `v=${shape.written}`, shape.name);
  }
});

test("a constant states the type it is written at, and a text one is a string", async () => {
  // The literal writer only quotes a float and hands every other text back as
  // it was given, so a constant written at the text type came out as a bare
  // identifier: `return hello;` is a C the compiler turns away, and the
  // candidate's object is never built.
  const stdout = await lowered(
    subject(TEXT, handsBack({ k: "const", type: TEXT, text: 'hi "there"\n' })),
    (name) => `printf("%s", ${name}());`,
  );
  assert.equal(stdout, 'hi "there"\n');
});

test("a power is a floating value, whatever the operands are", async () => {
  // `pow` takes and hands back a double, so a power written as a whole number
  // is a truncation: `2 ** 40` is 1099511627776 and a 32 bit answer holds
  // something else entirely. The resolver gives it a double, whatever the two
  // sides are, and IR that says otherwise is refused before a backend reads it.
  const I32: SemanticType = { kind: "primitive", name: "i32" };
  const power = (type: SemanticType): SemanticValue => ({
    k: "arith",
    type,
    op: "pow",
    left: { k: "const", type, text: "2" },
    right: { k: "const", type, text: "10" },
  });
  const whole: SemanticValue = { k: "arith", type: I32, op: "pow", left: { k: "const", type: I32, text: "2" }, right: { k: "const", type: I32, text: "10" } };
  assert.deepEqual(semanticFunctionProblems(subject(I32, handsBack(whole))), [
    "subject: entry: pow of a i32 and a i32 is a i32, which is not a floating value",
  ]);
  assert.deepEqual(semanticFunctionProblems(subject(F64, handsBack(power(F64)))), []);
});


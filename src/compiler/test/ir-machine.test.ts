/**
 * What the machine code the compiler lowers a function's IR into computes.
 *
 * A `machine` build is this file and nothing else: the model wrote the IR, and
 * the instructions below are what a processor runs. These lower hand-written IR,
 * link it against a driver, a callee that counts how many times it was called
 * and the runtime, and run it, so a lowering that does not assemble, that runs
 * a value twice, or that answers something other than what the IR states fails
 * here rather than in a candidate's verification.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertMachineTarget, buildObject } from "../toolchain/ir-machine.ts";
import { buildStandaloneRuntime } from "../runtime/standalone.ts";
import { cDeclarationType } from "../toolchain/linker.ts";
import { parseType, symbolOf } from "../semantics/contract.ts";
import { optimizeSemanticFunction } from "../semantics/optimize-ir.ts";
import { run } from "../core/process.ts";
import type { FunctionContract, ObjectLayout, TargetSpec } from "../core/types.ts";
import type { SemanticBlock, SemanticCall, SemanticFunction, SemanticSlot, SemanticStatement, SemanticType, SemanticValue } from "../core/semantic-ir.ts";
import { scratch } from "./scratch.ts";

const F64: SemanticType = { kind: "primitive", name: "f64" };
const F32: SemanticType = { kind: "primitive", name: "f32" };
const I32: SemanticType = { kind: "primitive", name: "i32" };
const I8: SemanticType = { kind: "primitive", name: "i8" };
const U8: SemanticType = { kind: "primitive", name: "u8" };
const I64: SemanticType = { kind: "primitive", name: "i64" };
const U64: SemanticType = { kind: "primitive", name: "u64" };
const USIZE: SemanticType = { kind: "primitive", name: "usize" };
const BOOL: SemanticType = { kind: "primitive", name: "bool" };
const TEXT: SemanticType = { kind: "text" };
const PTR: SemanticType = { kind: "ptr", of: F64 };
const VOID: SemanticType = { kind: "void" };
const POINT: SemanticType = { kind: "ref", of: null, name: "Point" };

const TARGET: TargetSpec = { arch: "x86_64", os: "linux", abi: "sysv", cpu: "", features: [] };

const POINT_LAYOUT: ObjectLayout = {
  name: "Point",
  size: 16,
  align: 8,
  fields: [
    { name: "x", type: "f64", offset: 0 },
    { name: "y", type: "f64", offset: 8 },
  ],
};

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

/** The contract of a function this file builds by hand, which is all a lowering reads. */
function contracted(fn: SemanticFunction): FunctionContract {
  return {
    version: "1",
    function: {
      name: fn.name,
      symbol: fn.symbol,
      params: fn.params.map((param) => ({ name: param.name, type: typeTextOf(param) })),
      returns: typeTextOf({ kind: "value", name: "", mutable: false, type: fn.returns }),
    },
    requires: [],
    ensures: [],
    memory: { reads: [], writes: [], aliasing: [] },
    effects: [],
    numeric: { floatingPoint: "ieee754", rounding: "nearest", fastMath: false },
    optimize: { primary: "balanced" },
    definition: { statements: [], objects: fn.objects, allocates: false, prints: false, readsArgv: false, calls: [] },
  };
}

function typeTextOf(slot: SemanticSlot): string {
  const type = slot.kind === "value" || slot.kind === "object" ? slot.type : slot.kind === "text" ? TEXT : F64;
  // The contract type language has no string, and a string is a C string: a
  // pointer to the bytes of one.
  if (type.kind === "text") return "ptr<u8>";
  if (type.kind === "ref") return type.name === undefined ? "ref<any>" : `ref<${type.name}>`;
  // An array reaches a function as a pointer to its first element: the C
  // compiler has no array parameter, and no length arrives with it.
  if (type.kind === "ptr" || type.kind === "slice" || type.kind === "array") return `ptr<${typeTextOf({ kind: "value", name: "", mutable: false, type: type.of })}>`;
  if (type.kind === "primitive") return type.name;
  return "f64";
}

/** A body that hands one value back. */
function handsBack(value: SemanticValue): SemanticBlock {
  return { id: "entry", statements: [], releases: [], terminator: { k: "return", value } };
}

const local = (name: string, type: SemanticType = F64): SemanticValue => ({ k: "local", type, name });
const number = (text: string, type: SemanticType = F64): SemanticValue => ({ k: "const", type, text });
const literal = (text: string): SemanticValue => ({ k: "text", type: TEXT, parts: [{ k: "text", value: text }] });

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

/** A reference to no layout in particular, which is how a callee takes one. */
const ANY_REF: SemanticType = { kind: "ref", of: null };

/**
 * A call of `g`, which takes a reference and answers with the sum of a point's
 * two sides, so a caller that hands over the wrong pointer shows.
 *
 * The parameter is written `ref<any>` while the argument is a name of a type
 * that names its layout: the two are the same word, and the call is the shape a
 * program gets when one function builds what another only reads.
 */
const pointCall = (argument: SemanticValue): SemanticValue => ({
  k: "call",
  type: F64,
  call: {
    callee: "g",
    builtin: false,
    signature: { name: "g", symbol: "g", params: [{ name: "p", type: "ref<any>" }], returns: "f64" },
    args: [argument],
    argTypes: [ANY_REF],
    returns: F64,
    effects: [],
    ownership: "none",
    retain: false,
  },
});

/** A call of the compiler's own, which the C library answers. */
const roundCall = (argument: SemanticValue): SemanticCall => ({
  callee: "Math.round",
  builtin: true,
  signature: { name: "Math.round", symbol: "Math.round", params: [{ name: "v", type: "f64" }], returns: "f64" },
  args: [argument],
  argTypes: [F64],
  returns: F64,
  effects: [],
  ownership: "none",
  retain: false,
});

const floorCall = (argument: SemanticValue): SemanticCall => ({
  callee: "Math.floor",
  builtin: true,
  signature: { name: "Math.floor", symbol: "Math.floor", params: [{ name: "v", type: "f64" }], returns: "f64" },
  args: [argument],
  argTypes: [F64],
  returns: F64,
  effects: [],
  ownership: "none",
  retain: false,
});

const NUMBERS: SemanticSlot[] = [
  { kind: "value", name: "v", mutable: false, type: F64 },
  { kind: "value", name: "w", mutable: false, type: F64 },
];

/**
 * Lowers one function, links the object beside a driver and a callee that
 * counts its calls, and answers what the machine code wrote. The callee is a
 * translation unit of its own so the C compiler cannot fold two calls to one
 * into one: the count is what the program did, whatever the C compiler could
 * prove about it.
 */
async function lowered(fn: SemanticFunction, driver: (name: string) => string, target: TargetSpec = TARGET): Promise<string> {
  const directory = await scratch("blaze-machine-");
  const contract = contracted(fn);
  const runtime = await buildStandaloneRuntime(directory);
  await writeFile(
    join(directory, "callee.c"),
    [
      "struct Point { double x; double y; };",
      "int calls = 0;",
      "double f(double v) { calls++; return v + 1.0; }",
      "double g(struct Point* p) { calls++; return p->x + p->y; }",
      // Two arguments in two registers, which is the smallest call whose first
      // argument register is also a register a value can be pinned in.
      "double two(double a, double b) { calls++; return 10.0 * a + b; }",
      // The same call over whole numbers, whose argument registers are the ones
      // a whole number is pinned in.
      "long long mix(long long a, long long b) { calls++; return 10 * a + b; }",
      // Nine floats is past the eight the convention has registers for, so a
      // call of this one is the shape where the arguments that run out of
      // registers are written to the stack before the registers are read.
      "double h9(double a, double b, double c, double d, double e,",
      "         double f, double g, double h, double i) {",
      "  calls++; return a + 100 * b + 10000 * c + 1000000 * d + 1e7 * e",
      "       + 1e8 * f + 1e9 * g + 1e10 * h + 1e11 * i;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  const object = join(directory, `${fn.symbol}.o`);
  const built = await buildObject({
    fn,
    contract,
    target,
    callable: new Set(["f", "g", "h9", "two", "mix"]),
    objectPath: object,
  });
  assert.ok(built.textSizeBytes > 0, "the object carries the code the function is");
  await writeFile(
    join(directory, "driver.c"),
    [
      "#include <stdio.h>",
      "#include <stdbool.h>",
      "#include <stdint.h>",
      "#include <string.h>",
      "extern int calls;",
      "extern double f(double v);",
      "extern double two(double, double);",
      "extern long long mix(long long, long long);",
      `struct Point { double x; double y; };`,
      "extern double h9(double, double, double, double, double, double, double, double, double);",
      `extern ${cDeclarationType(parseType(typeTextOf({ kind: "value", name: "", mutable: false, type: fn.returns })))} ${symbolOf(contract)}(${contract.function.params
        .map((param) => `${cDeclarationType(parseType(param.type))} ${param.name}`)
        .join(", ")});`,
      `int main(void) { ${driver(symbolOf(contract))} return 0; }`,
      "",
    ].join("\n"),
    "utf8",
  );
  const binary = join(directory, fn.symbol);
  const linked = run(
    "gcc",
    ["-std=c11", "-O2", "-I", directory, join(directory, "driver.c"), join(directory, "callee.c"), object, runtime.objectPath, "-o", binary, "-lm"],
    { timeoutMs: 120_000 },
  );
  assert.equal(linked.code, 0, `the machine code must link:\n${linked.stderr}`);
  const result = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(result.code, 0, `the machine code must run:\n${result.stderr}`);
  return result.stdout;
}

test("a value the IR calls is run once, whichever form writes it down", async () => {
  // Each of these hands an answer back from a call, and a lowering that reads
  // the value once as the side that decides and once as the answer runs the
  // callee twice.
  const shapes: { name: string; value: SemanticValue; returns: SemanticType }[] = [
    {
      name: "an interpolated part",
      returns: TEXT,
      value: { k: "text", type: TEXT, parts: [{ k: "text", value: "n=" }, { k: "value", value: counted() }] },
    },
    {
      name: "an arm that decides",
      returns: F64,
      value: {
        k: "logical",
        type: F64,
        op: "and",
        left: counted(),
        right: number("1"),
      },
    },
    {
      name: "a condition",
      returns: F64,
      value: { k: "select", type: F64, condition: { k: "compare", type: BOOL, op: "gt", operand: F64, left: counted(), right: number("0") }, then: number("1"), otherwise: number("0") },
    },
    {
      name: "a side of a sum",
      returns: F64,
      value: { k: "arith", type: F64, op: "mul", left: counted(), right: number("2") },
    },
  ];
  for (const shape of shapes) {
    const fn = subject(shape.returns, handsBack(shape.value), [{ kind: "value", name: "v", mutable: false, type: F64 }]);
    // The result is bound first: a C compiler may read the counter before it
    // makes the call, and what is being asked is how many times it ran.
    const returned = cDeclarationType(parseType(typeTextOf({ kind: "value", name: "", mutable: false, type: shape.returns })));
    const format = shape.returns === TEXT ? "%s" : "%.17g";
    const printed = await lowered(fn, (name) => `{ ${returned} r = ${name}(3.0); printf("${format}|%d", r, calls); }`);
    assert.equal(printed.endsWith("|1"), true, `${shape.name} ran the callee once:\n${printed}`);
  }
});

test("a call takes every argument where the convention puts it", async () => {
  // An argument the lowering has just evaluated is left in the accumulator
  // rather than written to a slot and read back, which is a store and a load
  // for a value that never moved. That is only true of the last argument, and
  // only while no argument has run out of registers: the ones that have are
  // written to the stack before the registers are read, and writing them goes
  // through the very register the value is in. These two are the two sides of
  // that: nine floats run out of registers and one does not.
  const call = (name: string, args: readonly SemanticValue[]): SemanticValue => ({
    k: "call",
    type: F64,
    call: {
      callee: name,
      builtin: false,
      signature: {
        name,
        symbol: name,
        params: args.map((_, index) => ({ name: `a${String(index)}`, type: "f64" })),
        returns: "f64",
      },
      args: [...args],
      argTypes: args.map(() => F64),
      returns: F64,
      effects: [],
      ownership: "none",
      retain: false,
    },
  });
  // 1 + 100*2 + 10000*3 + ... + 1e11*9, which a double holds exactly.
  const expected = "987654030201";
  const spills = subject(F64, handsBack(call("h9", [...Array.from({ length: 8 }, (_, at) => number(String(at + 1))), { k: "arith", type: F64, op: "add", left: local("v"), right: number("0") }])), [
    { kind: "value", name: "v", mutable: false, type: F64 },
  ]);
  // The result is bound before the counter is read: a C compiler may read the
  // second argument of a printf before it makes the call in the first.
  const callAndCount = (name: string): string => `{ double r = ${name}(9.0); printf("%.17g|%d", r, calls); }`;
  assert.equal(await lowered(spills, callAndCount), `${expected}|1`, "nine arguments, the last on the stack");
  // A call with registers to spare: the last argument is the one the driver
  // passes, and it is left where it lands rather than written down.
  const spare = subject(F64, handsBack(call("f", [{ k: "arith", type: F64, op: "add", left: local("v"), right: number("1") }])), [
    { kind: "value", name: "v", mutable: false, type: F64 },
  ]);
  assert.equal(await lowered(spare, callAndCount), "11|1", "one argument, left in the accumulator");
});

test("an argument left where it is read out of the accumulator, not out of the slot it is named by", async () => {
  // A function whose float arithmetic is inside a loop lends the values of its
  // expressions the spare callee-saved vector registers, and a slot it binds for
  // itself may be given one. The last argument of a call is left in the
  // accumulator rather than written down, and the slot it is named by is bound
  // all the same — so the slot carries a register nothing ever wrote the argument
  // into, and reading the argument out of *that* hands the callee whatever the
  // last use of the register left there. `sum` over `f(a[i])` answered 18 where
  // the program answers 58: `f` was called with a stale register instead of the
  // element the loop had just read.
  const body: SemanticBlock = {
    id: "entry",
    releases: [],
    terminator: { k: "return", value: local("total") },
    statements: [
      { k: "let", slot: { kind: "value", name: "total", mutable: true, type: F64 }, value: number("0"), line: 2 },
      {
        k: "loop",
        line: 3,
        loop: {
          kind: "counted",
          variable: "i",
          type: F64,
          from: number("0"),
          to: local("n"),
          inclusive: false,
          down: false,
          step: null,
          header: "b1",
          exit: "entry",
          body: {
            id: "b2",
            releases: [],
            terminator: { k: "next" },
            statements: [
              {
                k: "set",
                name: "total",
                op: "=",
                line: 4,
                value: {
                  k: "arith",
                  type: F64,
                  op: "add",
                  left: local("total"),
                  right: {
                    k: "call",
                    type: F64,
                    call: {
                      callee: "f",
                      builtin: false,
                      signature: { name: "f", symbol: "f", params: [{ name: "v", type: "f64" }], returns: "f64" },
                      args: [{ k: "element", type: F64, of: local("a", ARRAY_OF_F64), index: local("i") }],
                      argTypes: [F64],
                      returns: F64,
                      effects: [],
                      ownership: "none",
                      retain: false,
                    },
                  },
                },
              },
            ],
          },
        },
      },
    ],
  };
  const fn = subject(F64, body, [
    { kind: "value", name: "a", mutable: false, type: ARRAY_OF_F64 },
    { kind: "value", name: "n", mutable: false, type: F64 },
  ]);
  // (2+1) + (5+1) + (7+1) + (9+1)
  assert.equal(await lowered(fn, (name) => `double v[4] = {2, 5, 7, 9}; printf("%.17g", ${name}(v, 4));`), "27");
});

test("an element the instruction carries is read before the other side's call writes its registers", async () => {
  // An address built to be the instruction's own memory operand is built *before*
  // the other side is written, because the other side is what the instruction is
  // combined with — so the index in that address has to outlive whatever the
  // other side does. An index in a register the convention preserves does; one
  // in a register it does not (the six the argument registers are) is written by
  // the call the other side makes, and the element is then read at an address
  // built from whatever the callee left there. An index in the frame was already
  // refused for exactly this, because it is read into the same scratch; this is
  // the whole name beside a call, and either way the answer is the same: the
  // element is read into a slot of its own and combined after the call.
  const body: SemanticBlock = {
    id: "entry",
    releases: [],
    statements: [],
    terminator: {
      k: "return",
      value: {
        k: "arith",
        type: F64,
        op: "add",
        left: { k: "element", type: F64, of: local("a", ARRAY_OF_F64), index: local("i", USIZE) },
        right: {
          k: "call",
          type: F64,
          call: {
            callee: "f",
            builtin: false,
            signature: { name: "f", symbol: "f", params: [{ name: "v", type: "f64" }], returns: "f64" },
            args: [number("1")],
            argTypes: [F64],
            returns: F64,
            effects: [],
            ownership: "none",
            retain: false,
          },
        },
      },
    },
  };
  const fn = subject(F64, body, [
    { kind: "value", name: "a", mutable: false, type: ARRAY_OF_F64 },
    { kind: "value", name: "i", mutable: false, type: USIZE },
  ]);
  // `a[2]` is 7 and `f(1)` is 2.
  assert.equal(await lowered(fn, (name) => `double v[4] = {2, 5, 7, 9}; printf("%.17g", ${name}(v, 2UL));`), "9");
});

test("an argument the build gave a register of its own is read before that register is written", async () => {
  // A value the census weighs as worth a register is kept in one, and the
  // register it is kept in is very often one the call it is an argument of is
  // taken in: `rdi` is both the first argument register and the first register
  // a whole number no call reaches is given. So filling the argument registers
  // in the order the arguments are in takes the value out from under the
  // argument behind it, and `mix(7, v)` with `v` in `rdi` handed the callee
  // `mix(7, 7)`. That is what the secp256k1 benchmark's `pAdd` did: `bx` is in
  // `rdi`, `fCopy(t1, bx)` passed `t1` twice, and every value the point
  // addition built from `t1` came out as a zero.
  //
  // The two shapes are the two ways the registers can want each other. The
  // first is one direction, which is a matter of order: the argument read out
  // of `rdi` goes first. The second is a swap — `mix(w, v)` with `v` in `rdi`
  // and `w` in `rsi` reads `rsi` into `rdi` and `rdi` into `rsi`, and no order
  // satisfies both, so one value is put in the frame first.
  const call = (symbol: string, args: readonly SemanticValue[]): SemanticValue => ({
    k: "call",
    type: I64,
    call: {
      callee: symbol,
      builtin: false,
      signature: {
        name: symbol,
        symbol,
        params: args.map((_, index) => ({ name: `a${String(index)}`, type: "i64" })),
        returns: "i64",
      },
      args: [...args],
      argTypes: args.map(() => I64),
      returns: I64,
      effects: [],
      ownership: "none",
      retain: false,
    },
  });
  const params: SemanticSlot[] = [
    { kind: "value", name: "v", mutable: false, type: I64 },
    { kind: "value", name: "w", mutable: false, type: I64 },
  ];
  // Both parameters are read six times over, which is what the census weighs
  // as worth a register of its own. `v` arrives in `rdi` and `w` in `rsi`, and
  // each is given its own arrival register because it is where its value
  // already is.
  const summed = (name: string): SemanticValue =>
    Array.from({ length: 6 }, () => local(name, I64)).reduce((left, right) => ({ k: "arith", type: I64, op: "add", left, right }));
  const answers = (args: readonly SemanticValue[]): SemanticFunction => subject(I64, handsBack(call("mix", args)), params);
  // `mix(v + v + v + v + v + v, v)` with `v` at 3: the first argument is
  // written into the register the second is read out of.
  // `10 * 18 + 3`: an ordering that wrote the first argument before it read the
  // second handed the callee `mix(18, 18)` and answered `198`.
  assert.equal(
    await lowered(answers([summed("v"), local("v", I64)]), (name) => `printf("%lld", ${name}(3, 0));`),
    "183",
    "the argument read out of a register the first argument is taken in",
  );
  // `mix(v, w)`, which is the swap: neither register can be written before the
  // other has been read out of it.
  assert.equal(
    await lowered(answers([local("v", I64), local("w", I64)]), (name) => `printf("%lld", ${name}(3, 4));`),
    "34",
    "two arguments that want each other's registers",
  );
});

test("a jump past an arm that writes nothing is still written", async () => {
  // A jump that lands where control already is is taken back out rather than
  // written, which is what ends a function whose last block returns. The test
  // is the case where the two are not the same place: the arm between the jump
  // and its label binds a label of its own and then writes nothing at all, so
  // taking the jump out moves the label the arm was bound to and the branch
  // into it lands inside an instruction. `x || 0` is that shape — the arm is a
  // conversion of a float to a float, which is no instruction. An arm that
  // hands back a zero of its own is what makes the two sides differ in what
  // they answer: `||` keeps a true left and `&&` keeps a false one, so at a
  // left of 3 the first answers 3 and the second 0, and at a left of 0 both
  // answer the arm.
  const shapes: { name: string; value: SemanticValue; atThree: string; atZero: string }[] = [
    { name: "an or over a float arm", value: { k: "logical", type: F64, op: "or", left: local("v"), right: number("0") }, atThree: "3", atZero: "0" },
    { name: "an and over a float arm", value: { k: "logical", type: F64, op: "and", left: local("v"), right: number("0") }, atThree: "0", atZero: "0" },
    { name: "a coalesce over a float arm", value: { k: "coalesce", type: F64, left: local("v"), right: number("0") }, atThree: "3", atZero: "0" },
  ];
  for (const shape of shapes) {
    for (const [argument, expected] of [
      ["3", shape.atThree],
      ["0", shape.atZero],
    ] as const) {
      const fn = subject(F64, handsBack(shape.value), [{ kind: "value", name: "v", mutable: false, type: F64 }]);
      const printed = await lowered(fn, (name) => `printf("%g", ${name}(${argument}));`);
      assert.equal(printed, expected, `${shape.name} at ${argument}`);
    }
  }
});

test("a whole number is computed at the width the language promotes it to", async () => {
  const cases: { name: string; type: SemanticType; op: "add" | "sub" | "mul" | "div" | "mod" | "shl" | "shr" | "and" | "or" | "xor"; left: string; right: string; expected: string }[] = [
    { name: "a byte added to a byte wraps at its own width", type: U8, op: "add", left: "200", right: "100", expected: "44" },
    { name: "a byte remainder is a whole number of the promoted width", type: U8, op: "mod", left: "200", right: "100", expected: "0" },
    { name: "a signed byte divides as the number it is", type: I8, op: "div", left: "-7", right: "2", expected: "-3" },
    { name: "an unsigned division reads both sides as unsigned", type: U64, op: "div", left: "-7", right: "2", expected: "9223372036854775804" },
    { name: "a shift moves a whole number at its own width", type: I32, op: "shl", left: "3", right: "4", expected: "48" },
    { name: "a shift right keeps the sign of a signed number", type: I32, op: "shr", left: "-16", right: "2", expected: "-4" },
    { name: "a shift right of an unsigned number is a logical one", type: U64, op: "shr", left: "-16", right: "2", expected: "4611686018427387900" },
    { name: "a remainder of a signed number keeps the sign of the left", type: I64, op: "mod", left: "-7", right: "2", expected: "-1" },
  ];
  for (const entry of cases) {
    const fn = subject(entry.type, handsBack({ k: "arith", type: entry.type, op: entry.op, left: number(entry.left, entry.type), right: number(entry.right, entry.type) }));
    const printed = await lowered(fn, (name) => `printf("%lld", (long long)${name}());`);
    assert.equal(printed, entry.expected, entry.name);
  }
});

test("a minimum and a maximum are the smaller and the larger, numbers and floats alike", async () => {
  // The whole-number form is a `CMOVcc` on the flags a comparison left, which
  // is the arm the branch it replaced chose, chosen without a guess.
  const whole: [string, string][] = [
    ["1", "2"],
    ["2", "1"],
    ["-1", "1"],
    ["1", "-1"],
    ["0", "0"],
    ["-2147483648", "-1"],
    ["2147483647", "-2147483648"],
  ];
  for (const [left, right] of whole) {
    for (const [op, expected] of [
      ["min", Math.min(Number(left), Number(right))],
      ["max", Math.max(Number(left), Number(right))],
    ] as const) {
      const fn = subject(I32, handsBack({ k: "arith", op, type: I32, left: number(left, I32), right: number(right, I32) }));
      assert.equal(await lowered(fn, (name) => `printf("%d", ${name}());`), String(expected), `${left} ${op} ${right}`);
    }
  }
  // A float is not a `MINSD` or a `MAXSD`, and this is why. Those answer with
  // their source whenever the comparison does not hold, and a comparison against
  // a value that is not a number never holds, so whichever way round the pair is
  // encoded the same side comes out: the instruction cannot say which operand
  // was at fault. The language answers both with the right side, and a signed
  // zero is equal to a positive one rather than less than it. An instruction
  // that answers a pair the wrong way is not a faster branch, it is a different
  // program, so the float keeps the branch. The spelling below is the C
  // library's rather than the language's, because this is a driver printing
  // with `%g` and not the runtime's formatter.
  const floats: [string, string, string, string][] = [
    ["1.5", "2.5", "1.5", "2.5"],
    ["2.5", "1.5", "1.5", "2.5"],
    ["-0.0", "0.0", "0", "0"],
    ["NaN", "2", "2", "2"],
    ["2", "NaN", "nan", "nan"],
  ];
  for (const [left, right, min, max] of floats) {
    const smaller = subject(F64, handsBack({ k: "arith", op: "min", type: F64, left: number(left), right: number(right) }));
    assert.equal(await lowered(smaller, (name) => `printf("%g", ${name}());`), min, `min(${left}, ${right})`);
    const larger = subject(F64, handsBack({ k: "arith", op: "max", type: F64, left: number(left), right: number(right) }));
    assert.equal(await lowered(larger, (name) => `printf("%g", ${name}());`), max, `max(${left}, ${right})`);
  }
});

test("a float is computed at the precision it is written at", async () => {
  const single = subject(F32, handsBack({ k: "arith", type: F32, op: "div", left: number("1", F32), right: number("3", F32) }));
  assert.equal(await lowered(single, (name) => `printf("%.9g", (double)${name}());`), "0.333333343");

  const negated = subject(F64, handsBack({ k: "unary", type: F64, op: "neg", operand: number("0") }));
  assert.equal(await lowered(negated, (name) => `printf("%.17g", ${name}());`), "-0");

  const smallest = subject(F64, handsBack({ k: "arith", type: F64, op: "min", left: number("2.5"), right: number("-1.5") }));
  assert.equal(await lowered(smallest, (name) => `printf("%.17g", ${name}());`), "-1.5");

  // `Math.round` is the one maths builtin that is written out: the C library
  // rounds halves away from zero and the language rounds them up, so a value
  // that rounds to zero from below keeps its sign.
  const rounded = subject(F64, handsBack({ k: "call", type: F64, call: roundCall(number("-0.5")) }));
  assert.equal(await lowered(rounded, (name) => `printf("%.17g", ${name}());`), "-0");
});

test("a double kept in a register is still there after a round is written out", async () => {
  // `Math.round` is written out rather than called, and its sign repair needs a
  // zero and a sign bit in registers of its own. `xmm2` was both that scratch
  // and the first register a double was kept in, and neither the round nor the
  // truth of a double is a call the liveness pass models — so a double kept
  // there was gone the moment either ran.
  const fn = subject(F64, {
    id: "entry",
    statements: [
      { k: "let", slot: { kind: "value", name: "scaled", mutable: false, type: F64 }, value: { k: "arith", type: F64, op: "mul", left: local("x", F64), right: number("3.25") }, line: 1 },
      { k: "let", slot: { kind: "value", name: "other", mutable: false, type: F64 }, value: { k: "arith", type: F64, op: "mul", left: local("x", F64), right: number("1.75") }, line: 2 },
      { k: "let", slot: { kind: "value", name: "first", mutable: false, type: F64 }, value: { k: "call", type: F64, call: roundCall({ k: "arith", type: F64, op: "mul", left: local("x", F64), right: number("1.5") }) }, line: 3 },
      { k: "let", slot: { kind: "value", name: "second", mutable: false, type: F64 }, value: { k: "call", type: F64, call: roundCall({ k: "arith", type: F64, op: "mul", left: local("x", F64), right: number("2.5") }) }, line: 4 },
    ],
    releases: [],
    terminator: {
      k: "return",
      value: {
        k: "arith", type: F64, op: "add",
        left: { k: "arith", type: F64, op: "add", left: local("scaled", F64), right: local("first", F64) },
        right: { k: "arith", type: F64, op: "add", left: local("other", F64), right: local("second", F64) },
      },
    },
  }, [{ kind: "value", name: "x", mutable: false, type: F64 }]);
  // 3 * 3.25 + round(4.5) + 3 * 1.75 + round(7.5) = 9.75 + 5 + 5.25 + 8.
  assert.equal(await lowered(fn, (name) => `printf("%.17g", ${name}(3));`), "28");
});

test("a loop counts, walks and repeats as many times as the IR states", async () => {
  const counted = subject(F64, {
    id: "entry",
    statements: [
      { k: "let", slot: { kind: "value", name: "total", mutable: true, type: F64 }, value: number("0"), line: 1 },
      {
        k: "loop",
        line: 2,
        loop: {
          kind: "counted",
          variable: "i",
          type: I32,
          from: number("1", I32),
          to: number("10", I32),
          inclusive: false,
          down: false,
          step: null,
          header: "head",
          exit: "out",
          body: {
            id: "body",
            releases: [],
            statements: [{ k: "set", name: "total", op: "+=", value: local("i", I32), line: 3 }],
            terminator: { k: "next" },
          },
        },
      },
    ],
    releases: [],
    terminator: { k: "return", value: local("total") },
  });
  assert.equal(await lowered(counted, (name) => `printf("%.17g", ${name}());`), "45");

  const down = subject(I32, {
    id: "entry",
    statements: [
      { k: "let", slot: { kind: "value", name: "total", mutable: true, type: I32 }, value: number("0", I32), line: 1 },
      {
        k: "loop",
        line: 2,
        loop: {
          kind: "counted",
          variable: "i",
          type: I32,
          from: number("5", I32),
          to: number("1", I32),
          inclusive: true,
          down: true,
          step: null,
          header: "head",
          exit: "out",
          body: {
            id: "body",
            releases: [],
            statements: [{ k: "set", name: "total", op: "+=", value: local("i", I32), line: 3 }],
            terminator: { k: "next" },
          },
        },
      },
    ],
    releases: [],
    terminator: { k: "return", value: local("total", I32) },
  });
  assert.equal(await lowered(down, (name) => `printf("%d", ${name}());`), "15");

  const whileLoop = subject(I32, {
    id: "entry",
    statements: [
      { k: "let", slot: { kind: "value", name: "i", mutable: true, type: I32 }, value: number("0", I32), line: 1 },
      {
        k: "loop",
        line: 2,
        loop: {
          kind: "while",
          condition: { k: "compare", type: BOOL, op: "lt", operand: I32, left: local("i", I32), right: number("5", I32) },
          header: "head",
          exit: "out",
          body: {
            id: "body",
            releases: [],
            statements: [{ k: "set", name: "i", op: "+=", value: number("1", I32), line: 3 }],
            terminator: { k: "next" },
          },
        },
      },
    ],
    releases: [],
    terminator: { k: "return", value: local("i", I32) },
  });
  assert.equal(await lowered(whileLoop, (name) => `printf("%d", ${name}());`), "5");

  const walk = subject(F64, {
    id: "entry",
    statements: [
      { k: "let", slot: { kind: "value", name: "total", mutable: true, type: F64 }, value: number("0"), line: 1 },
      {
        k: "loop",
        line: 2,
        loop: {
          kind: "each",
          index: "i",
          element: "element",
          elementType: F64,
          of: "a",
          length: local("n", USIZE),
          header: "head",
          exit: "out",
          body: {
            id: "body",
            releases: [],
            statements: [{ k: "set", name: "total", op: "+=", value: local("element"), line: 3 }],
            terminator: { k: "next" },
          },
        },
      },
    ],
    releases: [],
    terminator: { k: "return", value: local("total") },
  }, [
    { kind: "value", name: "a", mutable: false, type: { kind: "slice", of: F64 } },
    { kind: "value", name: "n", mutable: false, type: USIZE },
  ]);
  const walked = await lowered(
    walk,
    (name) => `double v[3] = {1.5, 2.5, 4.0}; printf("%.17g", ${name}(v, 3));`,
  );
  assert.equal(walked, "8");
});


test("a loop with a step written out runs its counter the right number of times", async () => {
  // The loops above step by one, which is a different shape from a step the
  // program wrote: the counter is then read from the frame, stepped and
  // written back, and reading it once before that read nothing. This is the
  // shape a loop over an array has, and the counter is what both turn on.
  const stepped = subject(I32, {
    id: "entry",
    statements: [
      { k: "let", slot: { kind: "value", name: "total", mutable: true, type: I32 }, value: number("0", I32), line: 1 },
      {
        k: "loop",
        line: 2,
        loop: {
          kind: "counted",
          variable: "i",
          type: I32,
          from: number("0", I32),
          to: number("10", I32),
          inclusive: false,
          down: false,
          step: number("3", I32),
          header: "head",
          exit: "out",
          body: {
            id: "body",
            releases: [],
            statements: [{ k: "set", name: "total", op: "+=", value: local("i", I32), line: 3 }],
            terminator: { k: "next" },
          },
        },
      },
    ],
    releases: [],
    terminator: { k: "return", value: local("total", I32) },
  });
  // 0, 3, 6 and 9: the counter steps by three and stops at the bound.
  assert.equal(await lowered(stepped, (name) => `printf("%d", ${name}());`), "18");

  // The same loop counting the other way, so a written-out step is walked in
  // both directions rather than only the one the loops above happen to use.
  const down = subject(I32, {
    id: "entry",
    statements: [
      { k: "let", slot: { kind: "value", name: "total", mutable: true, type: I32 }, value: number("0", I32), line: 1 },
      {
        k: "loop",
        line: 2,
        loop: {
          kind: "counted",
          variable: "i",
          type: I32,
          from: number("10", I32),
          to: number("0", I32),
          inclusive: false,
          down: true,
          // The step is the signed amount the index moves by, so a loop that
          // counts down carries a negative one: that is what `i -= 3` resolves
          // to, and it is added like any other step.
          step: number("-3", I32),
          header: "head",
          exit: "out",
          body: {
            id: "body",
            releases: [],
            statements: [{ k: "set", name: "total", op: "+=", value: local("i", I32), line: 3 }],
            terminator: { k: "next" },
          },
        },
      },
    ],
    releases: [],
    terminator: { k: "return", value: local("total", I32) },
  });
  // 10, 7, 4 and 1.
  assert.equal(await lowered(down, (name) => `printf("%d", ${name}());`), "22");
});

test("a loop written on a negated comparison runs the turns the test holds for", async () => {
  // A loop condition is a value, and a `!` over a comparison used to be
  // answered by widening the comparison into a number and testing that number
  // against a flag the widening move had left alone. A loop on `!(n <= 0)` —
  // which is the loop `semantics/recursion.ts` writes for a tail recursion —
  // then left on the first turn whatever the flags happened to say. The branch
  // is now made on the opposite comparison, which is the same question asked
  // of the flags the comparison already left.
  const loopOn = (op: "lt" | "le" | "gt" | "ge" | "eq" | "ne", to: string): SemanticFunction =>
    subject(
      I32,
      {
        id: "entry",
        statements: [
          { k: "let", slot: { kind: "value", name: "total", mutable: true, type: I32 }, value: number("0", I32), line: 1 },
          {
            k: "loop",
            line: 2,
            loop: {
              kind: "while",
              condition: {
                k: "unary",
                type: BOOL,
                op: "not",
                operand: { k: "compare", type: BOOL, op, operand: I32, left: local("i", I32), right: number(to, I32) },
              },
              header: "head",
              exit: "out",
              body: {
                id: "body",
                releases: [],
                statements: [
                  { k: "set", name: "total", op: "+=", value: local("i", I32), line: 3 },
                  { k: "set", name: "i", op: "=", value: { k: "arith", type: I32, op: "add", left: local("i", I32), right: number("1", I32) }, line: 3 },
                ],
                terminator: { k: "next" },
              },
            },
          },
        ],
        releases: [],
        terminator: { k: "return", value: local("total", I32) },
      },
      [{ kind: "value", name: "i", mutable: true, type: I32 }],
    );

  // Each loop runs while its test is false, so each answer is the sum of the
  // counters the test lets through. The counter only goes up, so each case
  // starts where its own loop ends rather than where it would run forever.
  const runs: { op: "lt" | "le" | "gt" | "ge" | "eq" | "ne"; from: number; expected: number }[] = [
    { op: "lt", from: 1, expected: 0 },
    { op: "le", from: 0, expected: 0 },
    { op: "gt", from: 0, expected: 10 },
    { op: "ge", from: 0, expected: 6 },
    { op: "eq", from: 0, expected: 6 },
    { op: "ne", from: 0, expected: 0 },
  ];
  for (const entry of runs) {
    const printed = await lowered(loopOn(entry.op, "4"), (name) => `printf("%d", ${name}(${entry.from}));`);
    assert.equal(printed, `${entry.expected}`, `while (!(i ${entry.op} 4)) from ${entry.from}`);
  }
});

test("a loop that counts down counts down", async () => {
  // The step is the signed amount the index moves by, so the direction of a
  // written-out step is already in it and it is added like any other. Taking
  // the direction from `down` as well moved a descending index the other way,
  // and a loop like this one never came back.
  const descending = (step: string | null, from: string, to: string, inclusive: boolean): SemanticFunction =>
    subject(I32, {
      id: "entry",
      statements: [
        { k: "let", slot: { kind: "value", name: "total", mutable: true, type: I32 }, value: number("0", I32), line: 1 },
        {
          k: "loop",
          line: 2,
          loop: {
            kind: "counted",
            variable: "i",
            type: I32,
            from: number(from, I32),
            to: number(to, I32),
            inclusive,
            down: true,
            step: step === null ? null : number(step, I32),
            header: "head",
            exit: "out",
            body: {
              id: "body",
              releases: [],
              statements: [{ k: "set", name: "total", op: "+=", value: local("i", I32), line: 3 }],
              terminator: { k: "next" },
            },
          },
        },
      ],
      releases: [],
      terminator: { k: "return", value: local("total", I32) },
    });
  const sum = async (fn: SemanticFunction): Promise<string> => lowered(fn, (name) => `printf("%d", ${name}());`);

  // 10 down to 1, one turn at a time.
  assert.equal(await sum(descending(null, "10", "0", false)), "55");
  // 10, 7, 4 and 1.
  assert.equal(await sum(descending("-3", "10", "0", false)), "22");
  // 10 down to 0, both ends counted.
  assert.equal(await sum(descending("-1", "10", "0", true)), "55");
});

test("two loops one after another each leave into the block they sit in", async () => {
  // A loop that sits in the entry block leaves for the entry block, so two of
  // them leave for the same id. The label that id names is bound twice, and the
  // second binding is the one every jump resolves to, so the first loop's exit
  // jumps past the second loop to the end of the function and everything after
  // the first loop never runs.
  const twoLoops = subject(I32, {
    id: "entry",
    statements: [
      { k: "let", slot: { kind: "value", name: "total", mutable: true, type: I32 }, value: number("0", I32), line: 1 },
      {
        k: "loop",
        line: 2,
        loop: {
          kind: "counted",
          variable: "i",
          type: I32,
          from: number("0", I32),
          to: number("3", I32),
          inclusive: false,
          down: false,
          step: null,
          header: "b1",
          exit: "entry",
          body: {
            id: "b2",
            releases: [],
            statements: [{ k: "set", name: "total", op: "+=", value: local("i", I32), line: 2 }],
            terminator: { k: "next" },
          },
        },
      },
      {
        k: "loop",
        line: 3,
        loop: {
          kind: "counted",
          variable: "i",
          type: I32,
          from: number("0", I32),
          to: number("4", I32),
          inclusive: false,
          down: false,
          step: null,
          header: "b3",
          exit: "entry",
          body: {
            id: "b4",
            releases: [],
            statements: [{ k: "set", name: "total", op: "+=", value: number("1", I32), line: 3 }],
            terminator: { k: "next" },
          },
        },
      },
    ],
    releases: [],
    terminator: { k: "return", value: local("total", I32) },
  });
  // 0 + 1 + 2 from the first loop, then four more from the second.
  assert.equal(await lowered(twoLoops, (name) => `printf("%d", ${name}());`), "7");
});

test("a bound the body writes is read again on the next turn", async () => {
  // `for (let i = 0; i < limit; i++) { ... limit = 9; }` counts to a different
  // bound from the second turn, because the body wrote it. Reading the bound
  // once and holding it for the loop counts to the one it started with.
  const rewrittenBound = subject(I32, {
    id: "entry",
    statements: [
      { k: "let", slot: { kind: "value", name: "limit", mutable: true, type: I32 }, value: number("4", I32), line: 1 },
      { k: "let", slot: { kind: "value", name: "total", mutable: true, type: I32 }, value: number("0", I32), line: 2 },
      {
        k: "loop",
        line: 3,
        loop: {
          kind: "counted",
          variable: "i",
          type: I32,
          from: number("0", I32),
          to: local("limit", I32),
          inclusive: false,
          down: false,
          step: null,
          header: "b1",
          exit: "entry",
          body: {
            id: "b2",
            releases: [],
            statements: [
              { k: "set", name: "total", op: "+=", value: number("1", I32), line: 3 },
              { k: "set", name: "limit", op: "=", value: number("9", I32), line: 3 },
            ],
            terminator: { k: "next" },
          },
        },
      },
    ],
    releases: [],
    terminator: { k: "return", value: local("total", I32) },
  });
  // Nine turns, counting i = 0 through 8.
  assert.equal(await lowered(rewrittenBound, (name) => `printf("%d", ${name}());`), "9");
});

test("a loop leaves for another block, and the names it declared go with it", async () => {
  const fn = subject(I32, {
    id: "entry",
    statements: [
      { k: "let", slot: { kind: "value", name: "i", mutable: true, type: I32 }, value: number("0", I32), line: 1 },
      { k: "let", slot: { kind: "value", name: "total", mutable: true, type: I32 }, value: number("0", I32), line: 2 },
      {
        k: "loop",
        line: 3,
        loop: {
          kind: "while",
          condition: { k: "compare", type: BOOL, op: "lt", operand: I32, left: local("i", I32), right: number("10", I32) },
          header: "head",
          exit: "out",
          body: {
            id: "body",
            releases: [],
            statements: [
              { k: "set", name: "i", op: "+=", value: number("1", I32), line: 4 },
              {
                k: "if",
                line: 5,
                condition: { k: "compare", type: BOOL, op: "eq", operand: I32, left: local("i", I32), right: number("4", I32) },
                then: {
                  id: "leave",
                  releases: [],
                  statements: [],
                  terminator: { k: "jump", target: "out", releases: [] },
                },
                otherwise: null,
              },
              { k: "set", name: "total", op: "+=", value: number("2", I32), line: 6 },
            ],
            terminator: { k: "next" },
          },
        },
      },
    ],
    releases: [],
    terminator: { k: "return", value: local("total", I32) },
  });
  assert.equal(await lowered(fn, (name) => `printf("%d", ${name}());`), "6");
});

test("a whole number is printed from the integer it is", async () => {
  // Every number went through the runtime's formatter, which takes a double,
  // and a double holds a whole number only up to 2^53. The bigint literal
  // 9007199254740993 came out as 9007199254740992 — a number the program never
  // computed. The C backend already wrote the digits of an integer rather than
  // handing it over; this is the same answer on this backend, and the `n` of a
  // bigint is written after them.
  const printed = subject(VOID, {
    id: "entry",
    statements: [
      { k: "printNumber", line: 1, value: { k: "const", type: I64, text: "9007199254740993" }, bigint: true },
      { k: "printNewline", line: 1 },
      { k: "printNumber", line: 2, value: { k: "const", type: I64, text: "-9007199254740993" }, bigint: true },
      { k: "printNewline", line: 2 },
      { k: "printNumber", line: 3, value: { k: "const", type: I64, text: "9007199254740993" }, bigint: false },
      { k: "printNewline", line: 3 },
      { k: "printNumber", line: 4, value: { k: "const", type: I32, text: "-7" }, bigint: false },
      { k: "printNewline", line: 4 },
    ],
    releases: [],
    terminator: { k: "return", value: null },
  });
  assert.equal(
    await lowered(printed, (name) => `${name}();`),
    "9007199254740993n\n-9007199254740993n\n9007199254740993\n-7\n",
  );
});

test("a string joined to itself in a loop is read out of the frame, not out of a register a call took", async () => {
  // Laying a string out measures each part with `strlen`, and a name the build
  // gave a register of its own — a text local no call reaches, which the
  // liveness the allocator works from is happy to pin to one of the registers
  // a call is written through — is gone once `strlen` has run. The second part
  // of `c = c + c` was read out of `rdi` after the first measure, so the
  // answer depended on what `strlen` left there: under 64 bytes it happened to
  // be the pointer, and over it the call had overwritten the register and the
  // program died in `strlen` on whatever the call returned.
  const body: SemanticBlock = {
    id: "entry",
    statements: [
      { k: "let", line: 1, slot: { kind: "text", name: "c", mutable: true }, value: literal("x") },
      {
        k: "loop",
        line: 2,
        loop: {
          kind: "counted",
          variable: "i",
          type: F64,
          from: number("0"),
          to: local("n"),
          inclusive: false,
          down: false,
          step: null,
          header: "b1",
          exit: "entry",
          body: {
            id: "b2",
            releases: [],
            terminator: { k: "next" },
            statements: [
              { k: "set", line: 3, name: "c", op: "=", value: { k: "arith", type: TEXT, op: "concat", left: local("c", TEXT), right: local("c", TEXT) } },
            ],
          },
        },
      },
    ],
    releases: [],
    terminator: { k: "return", value: { k: "length", type: USIZE, of: local("c", TEXT) } },
  };
  const fn = subject(USIZE, body, [{ kind: "value", name: "n", mutable: false, type: F64 }]);
  // A string of 64 bytes is where `strlen` stops leaving the register alone,
  // so the length is what is asked for: 2^6 turns is 64 characters.
  assert.equal(await lowered(fn, (name) => `printf("%zu", ${name}(6));`), "64");
  assert.equal(await lowered(fn, (name) => `printf("%zu", ${name}(3));`), "8");
});

test("text is written, measured, joined and compared by what it says", async () => {
  const printed = subject(VOID, {
    id: "entry",
    statements: [
      { k: "printText", line: 1, value: literal("value ") },
      { k: "printNumber", line: 2, value: local("v"), bigint: false },
      { k: "printNewline", line: 3 },
      { k: "printText", line: 4, value: { k: "text", type: TEXT, parts: [{ k: "text", value: "n=" }, { k: "value", value: local("v") }] } },
      { k: "printNewline", line: 5 },
      { k: "printText", line: 6, value: { k: "toText", digits: null, type: TEXT, of: { k: "nothing", type: PTR } } },
      { k: "printNewline", line: 7 },
    ],
    releases: [],
    terminator: { k: "return", value: null },
  }, [{ kind: "value", name: "v", mutable: false, type: F64 }]);
  // An absent reference is the word the source prints, and an absent string
  // writes nothing at all, which is what the runtime says of a null pointer.
  assert.equal(await lowered(printed, (name) => `${name}(3.5);`), "value 3.5\nn=3.5\nnull\n");

  const length = subject(USIZE, handsBack({ k: "length", type: USIZE, of: { k: "arith", type: TEXT, op: "concat", left: literal("ab"), right: local("v", TEXT) } }), [
    { kind: "text", name: "v", mutable: false },
  ]);
  assert.equal(await lowered(length, (name) => `printf("%zu", ${name}("cde"));`), "5");

  const joined = subject(TEXT, handsBack({ k: "arith", type: TEXT, op: "concat", left: local("v", TEXT), right: literal(" world") }), [
    { kind: "text", name: "v", mutable: false },
  ]);
  assert.equal(await lowered(joined, (name) => `printf("%s", ${name}("hello"));`), "hello world");

  const equal = subject(BOOL, handsBack({ k: "compare", type: BOOL, op: "eq", operand: TEXT, left: literal("same"), right: { k: "arith", type: TEXT, op: "concat", left: literal("sa"), right: literal("me") } }));
  assert.equal(await lowered(equal, (name) => `printf("%d", ${name}());`), "1");

  const absent = subject(BOOL, handsBack({ k: "compare", type: BOOL, op: "ne", operand: TEXT, left: { k: "nothing", type: TEXT }, right: literal("") }));
  assert.equal(await lowered(absent, (name) => `printf("%d", ${name}());`), "1");
});

test("a truth is a truth: an empty string, an absent reference and a zero are all false", async () => {
  const cases: { name: string; value: SemanticValue; expected: string; argument?: string }[] = [
    { name: "an empty string", value: literal(""), expected: "0" },
    { name: "a string with a letter", value: literal("x"), expected: "1" },
    { name: "nothing", value: { k: "nothing", type: PTR }, expected: "0" },
    { name: "a reference", value: local("a", PTR), expected: "1", argument: "(double*)16" },
    { name: "a zero", value: number("0"), expected: "0" },
    { name: "a number that is not zero", value: number("0.5"), expected: "1" },
    // `UCOMISD` raises the parity bit on an operand that is no number, and oring
    // that bit into the answer made every NaN true. `Boolean(NaN)` is false in
    // the language and the C backend already reads it that way, so a NaN that
    // held kept `x || fallback` on the NaN and handed the program the wrong
    // branch — the binarytrees benchmark read `+process.argv[2] || 0` and got
    // the NaN, so every depth after it was a NaN too.
    { name: "a value that is not a number", value: number("NaN"), expected: "0" },
    { name: "a value that is not a number, at the single width", value: number("NaN", F32), expected: "0" },
  ];
  for (const entry of cases) {
    const fn = subject(
      F64,
      handsBack({ k: "select", type: F64, condition: entry.value, then: number("1"), otherwise: number("0") }),
      [{ kind: "value", name: "a", mutable: false, type: PTR }],
    );
    const printed = await lowered(fn, (name) => `printf("%d", (int)${name}(${entry.argument ?? "(double*)0"}));`);
    assert.equal(printed, entry.expected, entry.name);
  }
});

test("a comparison of a value that is not a number is false in every ordered way", async () => {
  // `UCOMISD` sets the carry as well as the zero and the parity flags when
  // either side is not a number, so `setb` and `setbe` both fired on exactly
  // the comparison that has to be false: `NaN < 2` and `NaN <= 2` answered
  // true, and a `while` written on one of them never ended. Every backend and
  // the language agree that a comparison involving a NaN is false.
  const ops: { op: "lt" | "le" | "gt" | "ge" | "eq" | "ne"; expected: number }[] = [
    { op: "lt", expected: 0 },
    { op: "le", expected: 0 },
    { op: "gt", expected: 0 },
    { op: "ge", expected: 0 },
    { op: "eq", expected: 0 },
    { op: "ne", expected: 1 },
  ];
  for (const entry of ops) {
    const against = subject(
      BOOL,
      handsBack({ k: "compare", type: BOOL, op: entry.op, operand: F64, left: number("NaN"), right: local("v") }),
      [{ kind: "value", name: "v", mutable: false, type: F64 }],
    );
    assert.equal(await lowered(against, (name) => `printf("%d", ${name}(2.0));`), `${entry.expected}`, `NaN ${entry.op} 2`);
  }
  // The ordered pairs are unchanged: the parity gate only removes the
  // unordered case, so a comparison of two numbers still answers its own way.
  const ordered: { op: "lt" | "le" | "gt" | "ge"; left: string; right: string; expected: number }[] = [
    { op: "lt", left: "1", right: "2", expected: 1 },
    { op: "lt", left: "2", right: "1", expected: 0 },
    { op: "le", left: "1", right: "1", expected: 1 },
    { op: "gt", left: "2", right: "1", expected: 1 },
    { op: "ge", left: "1", right: "1", expected: 1 },
    { op: "ge", left: "1", right: "2", expected: 0 },
  ];
  for (const entry of ordered) {
    const against = subject(
      BOOL,
      handsBack({ k: "compare", type: BOOL, op: entry.op, operand: F64, left: number(entry.left), right: number(entry.right) }),
    );
    assert.equal(await lowered(against, (name) => `printf("%d", ${name}());`), `${entry.expected}`, `${entry.left} ${entry.op} ${entry.right}`);
  }
});

test("a negated comparison is the other sense of the comparison it negates", async () => {
  // The negation was read out of the flags the comparison leaves, through the
  // conditions whole numbers use. A float leaves no such condition: the
  // conditions that read a `UCOMISD` have to be gated on the parity bit, so
  // there was one instruction where a `cmp` was written, against an
  // accumulator nothing had put a number in. `!(n <= 0)` over doubles therefore
  // compared whatever the accumulator held, and `if (!(n <= 0))` answered the
  // base case whatever `n` was.
  const cases: { op: "eq" | "ne" | "lt" | "le" | "gt" | "ge"; left: string; right: string; expected: number }[] = [
    { op: "le", left: "1", right: "2", expected: 0 },
    { op: "le", left: "2", right: "1", expected: 1 },
    { op: "le", left: "0", right: "0", expected: 0 },
    { op: "lt", left: "1", right: "2", expected: 0 },
    { op: "lt", left: "2", right: "1", expected: 1 },
    { op: "gt", left: "2", right: "1", expected: 0 },
    { op: "gt", left: "1", right: "2", expected: 1 },
    { op: "ge", left: "1", right: "1", expected: 0 },
    { op: "ge", left: "2", right: "1", expected: 0 },
    { op: "eq", left: "1", right: "1", expected: 0 },
    { op: "eq", left: "1", right: "2", expected: 1 },
    { op: "ne", left: "1", right: "2", expected: 0 },
    { op: "ne", left: "1", right: "1", expected: 1 },
  ];
  for (const entry of cases) {
    const against = subject(
      BOOL,
      handsBack({ k: "unary", type: BOOL, op: "not", operand: { k: "compare", type: BOOL, op: entry.op, operand: F64, left: number(entry.left), right: number(entry.right) } }),
    );
    assert.equal(await lowered(against, (name) => `printf("%d", ${name}());`), `${entry.expected}`, `!(${entry.left} ${entry.op} ${entry.right})`);
  }
  // The negation of a whole-number comparison is the other sense of it too.
  const whole = subject(
    BOOL,
    handsBack({ k: "unary", type: BOOL, op: "not", operand: { k: "compare", type: BOOL, op: "le", operand: I32, left: number("1", I32), right: number("2", I32) } }),
  );
  assert.equal(await lowered(whole, (name) => `printf("%d", ${name}());`), "0", "!(1 <= 2) over whole numbers");
  // A value that is not a number is in no ordered relation, so every ordered
  // comparison of one is false and its negation is true.
  for (const op of ["lt", "le", "gt", "ge", "eq"] as const) {
    const against = subject(
      BOOL,
      handsBack({ k: "unary", type: BOOL, op: "not", operand: { k: "compare", type: BOOL, op, operand: F64, left: number("NaN"), right: number("2") } }),
    );
    assert.equal(await lowered(against, (name) => `printf("%d", ${name}());`), "1", `!(NaN ${op} 2)`);
  }
});

test("a field read out of a nested object literal is read out of that literal", async () => {
  // The object being built is addressed through the register the fields are
  // written through, and anything a field's value reads that builds an object
  // of its own takes that register for itself and does not hand it back. So
  // every field of a literal with a nested literal in it was written into the
  // *nested* block, and the block the outer literal allocated kept whatever the
  // allocation before it had put there: `r.x` answered 30 where the source says
  // 100, and 10 where it says 100 again.
  const literal = (x: string, y: string): SemanticValue => ({
    k: "newObject",
    type: POINT,
    layout: "Point",
    fields: [{ name: "x", value: number(x) }, { name: "y", value: number(y) }],
  });
  const fn = subject(
    POINT,
    {
      id: "entry",
      statements: [
        {
          k: "let",
          line: 1,
          slot: { kind: "object", name: "r", mutable: true, type: POINT },
          value: {
            k: "newObject",
            type: POINT,
            layout: "Point",
            fields: [
              { name: "x", value: { k: "loadField", type: F64, object: literal("100", "200"), layout: "Point", field: "x" } },
              { name: "y", value: { k: "loadField", type: F64, object: literal("300", "400"), layout: "Point", field: "y" } },
            ],
          },
        },
      ],
      releases: [],
      terminator: { k: "return", value: local("r", POINT) },
    },
    [],
    { Point: POINT_LAYOUT },
  );
  assert.equal(
    await lowered(fn, (name) => `struct Point* r = ${name}(); printf("%.17g %.17g", r->x, r->y);`),
    "100 400",
  );
});

test("an object is allocated, written and read back through its own layout", async () => {
  const fn = subject(
    POINT,
    {
      id: "entry",
      statements: [
        {
          k: "let",
          line: 1,
          slot: { kind: "object", name: "point", mutable: true, type: POINT },
          value: {
            k: "newObject",
            type: POINT,
            layout: "Point",
            fields: [
              { name: "x", value: local("v") },
              { name: "y", value: local("w") },
            ],
          },
        },
        { k: "storeField", line: 2, object: local("point", POINT), layout: "Point", field: "y", value: number("9") },
      ],
      releases: [],
      terminator: { k: "return", value: local("point", POINT) },
    },
    NUMBERS,
    { Point: POINT_LAYOUT },
  );
  assert.equal(
    await lowered(fn, (name) => `struct Point* p = ${name}(1.5, 2.5); printf("%.17g %.17g", p->x, p->y);`),
    "1.5 9",
  );

  const read = subject(F64, handsBack({ k: "loadField", type: F64, object: local("point", POINT), layout: "Point", field: "y" }), [
    { kind: "value", name: "point", mutable: false, type: POINT },
  ], { Point: POINT_LAYOUT });
  assert.equal(await lowered(read, (name) => `struct Point p = {1.0, 2.0}; printf("%.17g", ${name}(&p));`), "2");
});

test("a reference reaches a callee that takes one written as a reference to no layout", async () => {
  // The caller holds a point as a `ref<Point>` and the callee takes a
  // `ref<any>`. They are one word and the call must pass it, whichever of the
  // two the compiler reads the argument by: a caller that wrote a copy of the
  // pointer into a slot of its own would still be right, and one that read the
  // pointer at the wrong depth would hand over the address of the slot.
  const fn = subject(
    F64,
    {
      id: "entry",
      statements: [
        {
          k: "let",
          line: 1,
          slot: { kind: "object", name: "point", mutable: true, type: POINT },
          value: {
            k: "newObject",
            type: POINT,
            layout: "Point",
            fields: [
              { name: "x", value: number("1.5") },
              { name: "y", value: number("2.5") },
            ],
          },
        },
        {
          k: "let",
          line: 2,
          slot: { kind: "value", name: "total", mutable: true, type: F64 },
          value: pointCall(local("point", POINT)),
        },
      ],
      releases: [],
      terminator: { k: "return", value: local("total") },
    },
    [],
    { Point: POINT_LAYOUT },
  );
  assert.equal(
    await lowered(fn, (name) => `double answer = ${name}(); printf("%.17g %d", answer, calls);`),
    "4 1",
  );
});

test("an element of an array is written and read at the width the element is", async () => {
  const fn = subject(F64, {
    id: "entry",
    statements: [
      { k: "setElement", line: 1, buffer: "a", index: number("1", USIZE), op: "=", value: local("v") },
      { k: "setElement", line: 2, buffer: "a", index: number("2", USIZE), op: "+=", value: local("w") },
    ],
    releases: [],
    terminator: {
      k: "return",
      value: { k: "arith", type: F64, op: "add", left: { k: "element", type: F64, of: local("a", PTR), index: number("1", USIZE) }, right: { k: "element", type: F64, of: local("a", PTR), index: number("2", USIZE) } },
    },
  }, [{ kind: "value", name: "a", mutable: false, type: PTR }, ...NUMBERS]);
  assert.equal(await lowered(fn, (name) => `double v[3] = {0, 0, 0}; printf("%.17g", ${name}(v, 1.5, 4.0));`), "5.5");
});

test("a call carries every argument where the convention puts it, past the registers too", async () => {
  // Six whole numbers and eight floats arrive in registers; the rest are on the
  // stack, and a call is made with the stack aligned the way the C library is
  // compiled to expect it.
  const names = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const params = names.map((name) => ({ kind: "value" as const, name, mutable: false, type: F64 }));
  const sum = names.reduce<SemanticValue>(
    (left, name) => ({ k: "arith", type: F64, op: "add", left, right: local(name) }),
    number("0"),
  );
  const fn = subject(F64, handsBack(sum), params);
  const printed = await lowered(fn, (name) => `printf("%.17g", ${name}(1, 2, 3, 4, 5, 6, 7, 8));`);
  assert.equal(printed, "36");

  // A call with both kinds of argument reads them from two sets of registers,
  // and a whole number the register holds is the caller's, not the callee's.
  const numbers = ["i", "j", "k"].map((name) => ({ kind: "value" as const, name, mutable: false, type: I64 }));
  const mixed = subject(
    F64,
    handsBack(
      names
        .slice(0, 7)
        .concat(numbers.map((slot) => slot.name))
        .reduce<SemanticValue>(
          (left, name) => ({
            k: "arith",
            type: F64,
            op: "add",
            left,
            right: local(name, numbers.some((slot) => slot.name === name) ? I64 : F64),
          }),
          number("0"),
        ),
    ),
    names.slice(0, 7).map((name) => ({ kind: "value" as const, name, mutable: false, type: F64 })).concat(numbers) as SemanticSlot[],
  );
  assert.equal(await lowered(mixed, (name) => `printf("%.17g", ${name}(1, 2, 3, 4, 5, 6, 7, 8, 9, 10));`), "55");

  // Nine floats: the eighth register is the last one, and the ninth is on the
  // stack above the return address.
  const wide = names.concat(["i", "j"]).map((name) => ({ kind: "value" as const, name, mutable: false, type: F64 }));
  const wideSum = wide.map((slot) => slot.name).reduce<SemanticValue>(
    (left, name) => ({ k: "arith", type: F64, op: "add", left, right: local(name) }),
    number("0"),
  );
  const wideFn = subject(F64, handsBack(wideSum), wide as SemanticSlot[]);
  assert.equal(await lowered(wideFn, (name) => `printf("%.17g", ${name}(1, 2, 3, 4, 5, 6, 7, 8, 9, 10));`), "55");
});

test("a statement moves a name on, and a power is the library's", async () => {
  const stepped = subject(I32, {
    id: "entry",
    statements: [
      { k: "let", slot: { kind: "value", name: "i", mutable: true, type: I32 }, value: number("0", I32), line: 1 },
      { k: "step", line: 2, name: "i", op: "++", prefix: true },
      { k: "step", line: 3, name: "i", op: "++", prefix: false },
      { k: "step", line: 4, name: "i", op: "--", prefix: false },
    ],
    releases: [],
    terminator: { k: "return", value: local("i", I32) },
  });
  assert.equal(await lowered(stepped, (name) => `printf("%d", ${name}());`), "1");

  const power = subject(F64, handsBack({ k: "arith", type: F64, op: "pow", left: number("2"), right: local("v") }), [
    { kind: "value", name: "v", mutable: false, type: F64 },
  ]);
  assert.equal(await lowered(power, (name) => `printf("%.17g", ${name}(10.0));`), "1024");
});

test("a function reads the arguments the program was given from the runtime", async () => {
  // Nothing set the arguments here. The count is the one it always answers,
  // the program and the file it runs, and index 0 is one of those two: it is a
  // path rather than a number, so it reads as the NaN the source reads it as.
  const count = subject(USIZE, handsBack({ k: "argv", type: USIZE, index: null }));
  assert.equal(await lowered(count, (name) => `printf("%zu", ${name}());`), "2");

  const first = subject(F64, handsBack({ k: "argv", type: F64, index: number("0", USIZE) }));
  assert.equal(await lowered(first, (name) => `printf("%s", ${name}() != ${name}() ? "not a number" : "a number");`), "not a number");
});

test("the object defines the symbol the function is called by, and nothing else", async () => {
  const directory = await scratch("blaze-machine-symbols-");
  const fn = subject(F64, handsBack(local("v")), NUMBERS);
  const objectPath = join(directory, "subject.o");
  await buildObject({ fn, contract: contracted(fn), target: TARGET, callable: new Set(), objectPath });
  const defined = run("nm", ["--defined-only", "--extern-only", objectPath], { timeoutMs: 30_000 });
  assert.equal(defined.stdout.trim().split(/\s+/).pop(), "subject");
  assert.equal(defined.stdout.trim().split("\n").length, 1);
});

test("a target this backend does not encode for is refused rather than answered with code", () => {
  assert.throws(
    () => assertMachineTarget({ arch: "aarch64", os: "linux", abi: "sysv", cpu: "", features: [] }),
    /the machine backend cannot build for aarch64-linux-sysv/,
  );
  assert.throws(
    () => assertMachineTarget({ arch: "x86_64", os: "linux", abi: "aapcs", cpu: "", features: [] } as unknown as TargetSpec),
    /cannot build for x86_64-linux-aapcs/,
  );
  // A processor of that machine is answered rather than refused: what is written
  // is the instruction set every x86-64 processor runs.
  assertMachineTarget({ arch: "x86_64", os: "linux", abi: "sysv", cpu: "znver1", features: [] });
  assertMachineTarget(TARGET);
});

test("a name the build pinned into a register is read as an element index", async () => {
  // A pinned name has no frame slot at all — its offset is zero, which is the
  // word above the frame pointer where the return address was put. An index
  // read that reached into the frame for it read that word, and the program read
  // whatever address it formed.
  //
  // `index` is written once and read enough times to be worth a register of its
  // own, which is what the build does to a parameter it reads often.
  const index: SemanticSlot = { kind: "value", name: "index", mutable: false, type: USIZE };
  const sum: SemanticSlot = { kind: "value", name: "sum", mutable: true, type: F64 };
  const element: SemanticValue = {
    k: "element", type: F64,
    of: { k: "local", type: PTR, name: "values" },
    index: { k: "local", type: USIZE, name: "index" },
  };
  const fn = subject(
    F64,
    {
      id: "entry",
      releases: [],
      statements: [
        { k: "let", slot: index, value: { k: "const", type: USIZE, text: "3" }, line: 1 },
        { k: "let", slot: sum, value: { k: "const", type: F64, text: "0" }, line: 1 },
        // Four reads of `index` is the census that gives it a register, and a
        // fifth so the count is above it whichever way the threshold is read.
        { k: "set", name: "sum", op: "+=", value: element, line: 2 },
        { k: "set", name: "sum", op: "+=", value: element, line: 3 },
        { k: "set", name: "sum", op: "+=", value: element, line: 4 },
        { k: "set", name: "sum", op: "+=", value: element, line: 5 },
      ],
      terminator: { k: "return", value: { k: "local", type: F64, name: "sum" } },
    },
    [{ kind: "value", name: "values", mutable: false, type: PTR }],
  );
  const printed = await lowered(fn, (name) => `{ double a[5] = {10,20,30,40,50}; printf("%.1f", ${name}(a)); }`);
  assert.equal(printed, "160.0", "the index is the value the program bound to it");
});

test("a walk over an array keeps its index in a register", async () => {
  // The index of a for-of is stepped once per turn and read twice — once for
  // the address and once for whatever the body does with it. In the frame that
  // is a load and a store per turn to hold a value the next turn reads straight
  // back out again; a register the callee leaves alone costs neither.
  const loop: SemanticStatement = {
    k: "loop",
    line: 1,
    loop: {
      kind: "each",
      element: "v",
      elementType: F64,
      index: "i",
      of: "values",
      length: { k: "local", type: USIZE, name: "n" },
      body: {
        id: "b2",
        releases: [],
        statements: [{ k: "set", name: "total", op: "+=", value: { k: "local", type: F64, name: "v" }, line: 2 }],
        terminator: { k: "jump", target: "h", releases: [] },
      },
      header: "h",
      exit: "x",
    },
  };
  const fn = subject(
    F64,
    {
      id: "entry",
      releases: [],
      statements: [
        { k: "let", slot: { kind: "value", name: "total", mutable: true, type: F64 }, value: { k: "const", type: F64, text: "0" }, line: 1 },
        loop,
      ],
      terminator: { k: "return", value: { k: "local", type: F64, name: "total" } },
    },
    [
      { kind: "value", name: "values", mutable: false, type: { kind: "ptr", of: F64 } },
      { kind: "value", name: "n", mutable: false, type: USIZE },
    ],
  );
  // The sum is the answer either way, and a wrong index is the difference
  // between 10 and 40 for the array below.
  const printed = await lowered(fn, (name) => `{ double a[4] = {10,20,30,40}; printf("%.1f", ${name}(a, 4)); }`);
  assert.equal(printed, "100.0", "every element is walked exactly once");
});

/** `[]f64`, the type an array of doubles reaches a function as. */
const ARRAY_OF_F64: SemanticType = { kind: "array", of: F64, length: null };

/**
 * `total += a[i] * b[i]` over `i` from zero to `n`, which is the loop this
 * backend writes a vector at a time.
 */
function dotBody(): SemanticBlock {
  const element = (buffer: string): SemanticValue => ({
    k: "element",
    type: F64,
    of: local(buffer, ARRAY_OF_F64),
    index: local("i"),
  });
  return {
    id: "entry",
    releases: [],
    terminator: { k: "return", value: local("total") },
    statements: [
      { k: "let", slot: { kind: "value", name: "total", mutable: true, type: F64 }, value: number("0"), line: 2 },
      {
        k: "loop",
        line: 3,
        loop: {
          kind: "counted",
          variable: "i",
          type: F64,
          from: number("0"),
          to: local("n"),
          inclusive: false,
          down: false,
          step: null,
          header: "b1",
          exit: "entry",
          body: {
            id: "b2",
            releases: [],
            terminator: { k: "next" },
            statements: [
              {
                k: "set",
                name: "total",
                op: "+=",
                line: 4,
                value: { k: "arith", type: F64, op: "mul", left: element("a"), right: element("b") },
              },
            ],
          },
        },
      },
    ],
  };
}

function dotSubject(): SemanticFunction {
  return subject(F64, dotBody(), [
    { kind: "value", name: "a", mutable: false, type: ARRAY_OF_F64 },
    { kind: "value", name: "b", mutable: false, type: ARRAY_OF_F64 },
    { kind: "value", name: "n", mutable: false, type: F64 },
  ]);
}

/** A driver that lays down two arrays, calls the function, and prints the sum. */
function dotDriver(turns: number): (name: string) => string {
  const a = Array.from({ length: turns }, (_one, at) => at + 1);
  const b = Array.from({ length: turns }, () => 1);
  return (name) => [
    `  double a[${turns}], b[${turns}];`,
    ...a.map((value, at) => `  a[${at}] = ${value}; b[${at}] = ${b[at]};`),
    `  printf("%g", ${name}(a, b, ${turns}));`,
  ].join("\n");
}

test("a loop that adds up two arrays is written a vector at a time", async () => {
  // An even number of elements is all pairs, so the sum is one whole vector.
  assert.equal(await lowered(dotSubject(), dotDriver(8)), "36", "eight elements, four pairs");
});

test("an array of an odd number of elements leaves one over for the scalar body", async () => {
  // The pairs stop one element short and the turn the source wrote is written
  // for that one element, at the counter the pairs reached. Seven elements is
  // three pairs and one leftover, and five is two pairs and one leftover.
  assert.equal(await lowered(dotSubject(), dotDriver(7)), "28", "seven elements, three pairs and a leftover");
  assert.equal(await lowered(dotSubject(), dotDriver(5)), "15", "five elements, two pairs and a leftover");
});

test("an array of fewer elements than a pair holds is written the loop it was written as", async () => {
  // There is no pair in a single element, so every element is the one the body
  // was written for.
  assert.equal(await lowered(dotSubject(), dotDriver(1)), "1", "one element, no pair");
  assert.equal(await lowered(dotSubject(), dotDriver(0)), "0", "no elements at all");
});


test("a compound assignment puts the name on the left of the operation", async () => {
  // `i -= 1` is i less one. Reading the value into the accumulator and the name
  // into the scratch computes one less i instead, which for a loop that counts
  // down runs one turn and stops: `sum` over ten was 10 rather than 55, and
  // `x /= 2` was two over x, so five halvings of 64 added up to 128.09 rather
  // than 62. An addition and a multiplication are the two operations whose
  // answer does not say which side was which; every other one needs the name.
  const count = (): SemanticBlock => ({
    id: "entry",
    releases: [],
    terminator: { k: "return", value: local("total") },
    statements: [
      { k: "let", slot: { kind: "value", name: "total", mutable: true, type: F64 }, value: number("0"), line: 2 },
      { k: "let", slot: { kind: "value", name: "i", mutable: true, type: F64 }, value: local("v"), line: 3 },
      {
        k: "loop",
        line: 4,
        loop: {
          kind: "while",
          condition: { k: "compare", type: BOOL, op: "gt", operand: F64, left: local("i"), right: number("0") },
          header: "b1",
          exit: "entry",
          body: {
            id: "b2",
            releases: [],
            terminator: { k: "next" },
            statements: [
              { k: "set", name: "total", op: "+=", line: 5, value: local("i") },
              { k: "set", name: "i", op: "-=", line: 6, value: number("1") },
            ],
          },
        },
      },
    ],
  });
  const fn = subject(F64, count(), [{ kind: "value", name: "v", mutable: false, type: F64 }]);
  assert.equal(await lowered(fn, (name) => `{ double r = ${name}(10.0); printf("%g", r); }`), "55", "ten, counted down");
});

/* -------------------------------------------------------------------------- */
/* Packed sum: the independent part of a turn, a pair of counters at a time    */
/* -------------------------------------------------------------------------- */

const U32: SemanticType = { kind: "primitive", name: "u32" };

const mul = (left: SemanticValue, right: SemanticValue): SemanticValue =>
  ({ k: "arith", type: F64, op: "mul", left, right });
const add = (left: SemanticValue, right: SemanticValue): SemanticValue =>
  ({ k: "arith", type: F64, op: "add", left, right });
const divide = (left: SemanticValue, right: SemanticValue): SemanticValue =>
  ({ k: "arith", type: F64, op: "div", left, right });
const subtract = (left: SemanticValue, right: SemanticValue): SemanticValue =>
  ({ k: "arith", type: F64, op: "sub", left, right });
const at = (array: string, index: SemanticValue): SemanticValue => ({
  k: "element",
  type: F64,
  of: local(array, ARRAY_OF_F64),
  index,
});

/**
 * A loop that adds `added` into a total, once for every counter from zero.
 *
 * The shape is the one the backend is asked about: one statement, one addition
 * into a name, and everything under that addition a function of the counter.
 */
function sumLoop(added: (counter: SemanticValue) => SemanticValue, seed = "0"): SemanticBlock {
  return {
    id: "entry",
    releases: [],
    terminator: { k: "return", value: local("total") },
    statements: [
      { k: "let", slot: { kind: "value", name: "total", mutable: true, type: F64 }, value: number(seed), line: 2 },
      {
        k: "loop",
        line: 3,
        loop: {
          kind: "counted",
          variable: "i",
          type: F64,
          from: number("0"),
          to: local("n"),
          inclusive: false,
          down: false,
          step: null,
          header: "b1",
          exit: "entry",
          body: {
            id: "b2",
            releases: [],
            terminator: { k: "next" },
            statements: [
              { k: "set", name: "total", op: "+=", line: 4, value: added(local("i")) },
            ],
          },
        },
      },
    ],
  };
}

function sumSubject(added: (counter: SemanticValue) => SemanticValue, second = false, seed = "0"): SemanticFunction {
  const params: SemanticSlot[] = [{ kind: "value", name: "a", mutable: false, type: ARRAY_OF_F64 }];
  if (second) params.push({ kind: "value", name: "b", mutable: false, type: ARRAY_OF_F64 });
  params.push({ kind: "value", name: "n", mutable: false, type: F64 });
  return subject(F64, sumLoop(added, seed), params);
}

/** Lays an array down, calls the function and prints what it answered in full. */
function sumDriver(turns: number, a: readonly number[], b?: readonly number[]): (name: string) => string {
  return (name) => [
    `  double a[${Math.max(turns, 1)}];`,
    ...a.map((value, at_) => `  a[${at_}] = ${value};`),
    ...(b === undefined ? [] : [`  double b[${Math.max(turns, 1)}];`, ...b.map((value, at_) => `  b[${at_}] = ${value};`)]),
    `  printf("%.17g", ${name}(a${b === undefined ? "" : ", b"}, ${turns}));`,
  ].join("\n");
}

/**
 * `total += f(i)`, summed in the order the loop wrote it.
 *
 * A `stride` of two sums the turns in pairs first, which is the grouping a
 * vector accumulator would give. It is only here so that a test can show the two
 * answers differ on the data it chose; nothing here writes it.
 */
function sumOf(
  a: readonly number[],
  b: readonly number[] | undefined,
  turns: number,
  f: (i: number) => number,
  stride = 1,
): number {
  const terms: number[] = [];
  for (let i = 0; i < turns; i += 1) terms.push(b === undefined ? f(i) : (a[i] - b[i]) / f(i));
  if (stride === 1) return terms.reduce((total, one) => total + one, 0);
  let total = 0;
  for (let at = 0; at < turns; at += stride) {
    let pair = 0;
    for (let step = 0; step < stride && at + step < turns; step += 1) pair += terms[at + step];
    total += pair;
  }
  return total;
}

/** A call of the shape a census refuses, over a name this function does have. */
const callUnder = (): SemanticValue => ({
  k: "call",
  type: F64,
  call: {
    callee: "f",
    builtin: false,
    signature: { name: "f", symbol: "f", params: [{ name: "v", type: "f64" }], returns: "f64" },
    args: [local("n")],
    argTypes: [F64],
    returns: F64,
    effects: [],
    ownership: "none",
    retain: false,
  },
});

/** The sum the loop the source wrote answers, added in the order it wrote it. */
function reference(a: readonly number[], turns: number, weight: (i: number) => number): number {
  let total = 0;
  for (let i = 0; i < turns; i += 1) total += a[i] / weight(i);
  return total;
}

/** What the instructions say, so a test can see which path the lowering took. */
async function emitted(
  fn: SemanticFunction,
  callable: readonly string[] = ["f", "g", "h9"],
  target: TargetSpec = TARGET,
): Promise<string> {
  const directory = await scratch("blaze-census-");
  const objectPath = join(directory, "subject.o");
  await buildObject({ fn, contract: contracted(fn), target, callable: new Set(callable), objectPath });
  return run("objdump", ["-d", "--no-show-raw-insn", objectPath], { timeoutMs: 30_000 }).stdout;
}

test("the arithmetic under an addition is written a pair of counters at a time", async () => {
  const turns = 6;
  const a = [1, 2, 3, 4, 5, 6];
  const c = 7;
  const fn = sumSubject((i) => divide(at("a", i), add(mul(i, i), number(String(c)))));
  assert.match(await emitted(fn), /\bmovups\b/, "a pair of counters is one load of two doubles");
  // The two are compared as numbers, which is bit for bit: a driver that printed
  // the answer to fewer digits than a double has would hide a lane that rounded
  // where the scalar one did not.
  assert.equal(
    Number(await lowered(fn, sumDriver(turns, a))),
    reference(a, turns, (i) => i * i + c),
    "the pair of turns answers what the two scalar turns would have",
  );
});

test("a packed loop adds to the value the accumulator already held", async () => {
  // `total += ...` adds to what `total` held, and the vector accumulator the
  // loop is written with used to start at zero instead: a loop seeded with
  // anything but zero answered the sum of the loop rather than the value the
  // source wrote. `let total = 0` is the shape every other test here wrote, so
  // the two forms agree on it and the bug was invisible.
  const turns = 6;
  const a = [1, 2, 3, 4, 5, 6];
  const c = 7;
  const fn = sumSubject((i) => divide(at("a", i), add(mul(i, i), number(String(c)))), false, "1000");
  assert.match(await emitted(fn), /\bmovups\b/, "the loop took the packed path");
  assert.equal(
    Number(await lowered(fn, sumDriver(turns, a))),
    1000 + reference(a, turns, (i) => i * i + c),
    "the answer is what the source holds, seed included",
  );
});

test("a packed dot product adds to the value the accumulator already held", async () => {
  // The other packed path, which builds its accumulator in a register of its
  // own rather than in the one the build gave the name, and seeded it the same
  // wrong way.
  const fn = sumSubject((i) => mul(at("a", i), at("b", i)), true, "5");
  assert.match(await emitted(fn), /\bmulpd\b/, "the loop took the packed dot path");
  assert.equal(
    Number(await lowered(fn, sumDriver(6, [1, 2, 3, 4, 5, 6], [10, 20, 30, 40, 50, 60]))),
    5 + 1 * 10 + 2 * 20 + 3 * 30 + 4 * 40 + 5 * 50 + 6 * 60,
    "the answer is what the source holds, seed included",
  );
});

test("an addition taken a turn at a time is the sum the loop wrote, not a re-grouping of it", async () => {
  // The terms here cancel: a large one and a small one, over and over. Adding
  // them in any other order gives a different number, so the answer below is the
  // proof that the loop still adds in the order the source wrote it.
  const turns = 8;
  const a = [1e16, 1, -1e16, 1, 1e16, 1, -1e16, 1];
  const c = 3;
  const ordered = reference(a, turns, (i) => i * i + c);
  const regrouped = reference([...a].reverse(), turns, (i) => i * i + c);
  assert.notEqual(ordered, regrouped, "this data tells a reordering apart at all");
  const fn = sumSubject((i) => divide(at("a", i), add(mul(i, i), number(String(c)))));
  assert.equal(
    Number(await lowered(fn, sumDriver(turns, a))),
    ordered,
    "the sum is the one the loop wrote, term by term",
  );
});

test("a leftover turn is written by the body the loop was written with", async () => {
  const turns = 5;
  const a = [1, 2, 3, 4, 5];
  const c = 7;
  const fn = sumSubject((i) => divide(at("a", i), add(mul(i, i), number(String(c)))));
  assert.equal(
    Number(await lowered(fn, sumDriver(turns, a))),
    reference(a, turns, (i) => i * i + c),
    "two pairs and one turn the pairs did not reach",
  );
});

test("a call under the addition is refused, because a lane would run it once for two turns", async () => {
  const fn = sumSubject((i) => divide(at("a", i), callUnder()));
  assert.doesNotMatch(await emitted(fn), /\bmovups\b/, "the loop is written a counter at a time");
});

test("a conversion under the addition is refused, because a packed one answers a different number", async () => {
  // This is the shape `spectral_norm` has: a triangular number read back out of
  // a float as an unsigned whole number and shifted. The scalar conversion
  // branches on the range and answers the value the language means; `CVTTPD2DQ`
  // answers one indefinite value instead, so a packed conversion is not the same
  // conversion and the loop is left as it was written.
  const triangular = (i: SemanticValue): SemanticValue => ({
    k: "arith",
    type: U32,
    op: "ushr",
    left: mul(i, add(i, number("1"))),
    right: { k: "const", type: U32, text: "1" },
  });
  const fn = sumSubject((i) => divide(at("a", i), add(triangular(i), number("1"))));
  assert.doesNotMatch(await emitted(fn), /\bmovups\b/, "the loop is written a counter at a time");
});

test("an element read anywhere but the counter is refused, because the pair load reads this turn and the next", async () => {
  const fn = sumSubject((i) => divide(at("a", i), at("a", add(i, number("1")))));
  assert.doesNotMatch(await emitted(fn), /\bmovups\b/, "the loop is written a counter at a time");
});

test("a value reading two arrays is written a pair of counters at a time, each array its own load", async () => {
  // The shape neither vector path took before: a turn is a difference of two
  // arrays over a weight built from the counter, which is neither the single
  // product a dot product is nor a turn reading one array.
  const turns = 7;
  const a = [1e16, 1, -1e16, 1, 1e16, 1, -1e16];
  const b = [0, 0, 0, 0, 0, 0, 0];
  const fn = sumSubject((i) => divide(subtract(at("a", i), at("b", i)), add(mul(i, i), number("7"))), true);
  const text = await emitted(fn);
  assert.match(text, /\bmovups\b/, "a pair of counters is one load of two doubles");
  assert.equal(
    (text.match(/\bmovups\b/g) ?? []).length,
    2,
    "one pair load per array: each is read against a base of its own",
  );
  // The data is chosen so that pairing the turns changes the answer, which is
  // what makes the comparison below a test of the order rather than a test of
  // the arithmetic.
  const ordered = sumOf(a, b, turns, (i) => i * i + 7);
  const paired = sumOf(a, b, turns, (i) => i * i + 7, 2);
  assert.notEqual(ordered, paired, "this data tells a re-grouping of the sum apart at all");
  assert.equal(
    Number(await lowered(fn, sumDriver(turns, a, b))),
    ordered,
    "the two arrays are read beside each other, and the sum is the one the loop wrote",
  );
});


test("a whole number accumulator is refused, because the additions are of doubles", async () => {
  const entry: SemanticBlock = {
    id: "entry",
    releases: [],
    terminator: { k: "return", value: { k: "local", type: I64, name: "total" } },
    statements: [
      { k: "let", slot: { kind: "value", name: "total", mutable: true, type: I64 }, value: { k: "const", type: I64, text: "0" }, line: 1 },
      {
        k: "loop",
        line: 2,
        loop: {
          kind: "counted",
          variable: "i",
          type: F64,
          from: number("0"),
          to: local("n"),
          inclusive: false,
          down: false,
          step: null,
          header: "b1",
          exit: "entry",
          body: {
            id: "b2",
            releases: [],
            terminator: { k: "next" },
            statements: [
              { k: "set", name: "total", op: "+=", line: 3, value: at("a", local("i")) },
            ],
          },
        },
      },
    ],
  };
  const fn = subject(I64, entry, [
    { kind: "value", name: "a", mutable: false, type: ARRAY_OF_F64 },
    { kind: "value", name: "n", mutable: false, type: F64 },
  ]);
  assert.doesNotMatch(await emitted(fn), /\bmovups\b/, "the loop is written a counter at a time");
});

/**
 * One machine object, lowered and run, answering a whole number the driver
 * hands it. Written here rather than reusing `lowered`, which has no way to
 * pass an argument, because the point is to run the same expression twice over
 * a set of arguments: once folded and once not, and to see the same number come
 * back both times.
 */
async function answeredBy(value: SemanticValue, inputs: readonly string[], folded: boolean): Promise<string[]> {
  const directory = await scratch("blaze-machine-identity-");
  const runtime = await buildStandaloneRuntime(directory);
  const body = (): SemanticFunction =>
    subject(
      I64,
      { id: "entry", releases: [], statements: [], terminator: { k: "return", value } },
      [{ kind: "value", name: "x", mutable: false, type: I64 }],
    );
  const toLower = folded ? optimizeSemanticFunction(body()) : body();
  const contract = contracted(toLower);
  const object = join(directory, "subject.o");
  await buildObject({ fn: toLower, contract, target: TARGET, callable: new Set(), objectPath: object });
  await writeFile(
    join(directory, "driver.c"),
    [
      "#include <stdio.h>",
      "#include <stdint.h>",
      "#include <stdlib.h>",
      "extern long long subject(long long x);",
      "int main(int argc, char** argv) {",
      "  printf(\"%lld\\n\", subject(strtoll(argv[1], NULL, 10)));",
      "  return 0;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  const binary = join(directory, "run");
  const linked = run(
    "gcc",
    ["-std=c11", "-O2", "-I", directory, join(directory, "driver.c"), object, runtime.objectPath, "-o", binary, "-lm"],
    { timeoutMs: 120_000 },
  );
  assert.equal(linked.code, 0, `the machine code must link:\n${linked.stderr}`);
  return inputs.map((input) => {
    const ran = run(binary, [input], { timeoutMs: 60_000 });
    assert.equal(ran.code, 0, `the machine code must run:\n${ran.stderr}`);
    return ran.stdout.trimEnd();
  });
}

test("the machine code of a folded identity is the machine code of the unfolded one", async () => {
  // Every identity the pass adds over a value that is not written out, driven
  // through the machine backend rather than only through C. The two objects are
  // lowered from the same expression and run over the same arguments, and the
  // numbers they answer have to agree — which is the whole claim, checked on
  // the backend the benchmarks are built for.
  //
  // The arguments are chosen to break a rewrite that is wrong rather than one
  // that is merely absent: -7 is where a signed shift and a truncation towards
  // zero part company, and 4294967295 is where a mask that has lost its high
  // bits shows.
  const readX: SemanticValue = local("x", I64);
  const cases: { name: string; value: SemanticValue }[] = [
    { name: "x / 1", value: { k: "arith", type: I64, op: "div", left: readX, right: number("1", I64) } },
    { name: "x % 1", value: { k: "arith", type: I64, op: "mod", left: readX, right: number("1", I64) } },
    { name: "x >> 0", value: { k: "arith", type: I64, op: "shr", left: readX, right: number("0", I64) } },
    { name: "x >>> 0", value: { k: "arith", type: I64, op: "ushr", left: readX, right: number("0", I64) } },
    { name: "x << 0", value: { k: "arith", type: I64, op: "shl", left: readX, right: number("0", I64) } },
    { name: "x | 0", value: { k: "arith", type: I64, op: "or", left: readX, right: number("0", I64) } },
    { name: "x ^ 0", value: { k: "arith", type: I64, op: "xor", left: readX, right: number("0", I64) } },
    { name: "x & 0", value: { k: "arith", type: I64, op: "and", left: readX, right: number("0", I64) } },
    { name: "x * 1", value: { k: "arith", type: I64, op: "mul", left: readX, right: number("1", I64) } },
    { name: "x + 0", value: { k: "arith", type: I64, op: "add", left: readX, right: number("0", I64) } },
    { name: "x - 0", value: { k: "arith", type: I64, op: "sub", left: readX, right: number("0", I64) } },
    { name: "x - x", value: { k: "arith", type: I64, op: "sub", left: readX, right: local("x", I64) } },
    { name: "x / 8", value: { k: "arith", type: I64, op: "div", left: readX, right: number("8", I64) } },
    { name: "x % 8", value: { k: "arith", type: I64, op: "mod", left: readX, right: number("8", I64) } },
    { name: "x * 8", value: { k: "arith", type: I64, op: "mul", left: readX, right: number("8", I64) } },
  ];
  const inputs = ["-7", "-1", "0", "1", "7", "255", "4294967295", "9223372036854775807"];
  for (const one of cases) {
    const plain = await answeredBy(one.value, inputs, false);
    const folded = await answeredBy(one.value, inputs, true);
    assert.deepEqual(folded, plain, `${one.name}: folding changed what the machine code computes`);
  }
});

test("a value rounded down is the same number whatever the target rounds with", async () => {
  // `Math.floor` is the one maths call a field element's limbs are made of, so
  // it is written as instructions here rather than as a call into the C library:
  // a conversion to a whole number and the correction that turns dropping the
  // fraction towards zero into dropping it towards minus infinity. Where the
  // target has the one instruction that rounds, that instruction is the whole
  // of it; where it has not, these are. The answers are the same number either
  // way, which is what the test reads.
  const floor = subject(
    F64,
    handsBack({ k: "call", type: F64, call: floorCall(local("x", F64)) }),
    [{ kind: "value", name: "x", mutable: false, type: F64 }],
  );
  // The three values the form below has to answer without converting them: a
  // negative zero, which a conversion answers with a positive one; a value
  // larger than a whole number can hold; and the bound on either side of it.
  const values = [
    "-1.5", "-0.5", "-0", "0", "0.5", "1.5", "2.5", "-3", "1e18", "-0.0001",
    "1e300", "-1e300", "4503599627370496", "-4503599627370496", "4503599627370495.5",
  ];
  const print = (name: string): string => values.map((value) => `printf("%.17g ", ${name}(${value}));`).join("");

  const called = await emitted(floor);
  assert.doesNotMatch(called, /\broundsd\b/, "a target that has not named the instruction is not given it");

  const SSE41: TargetSpec = { ...TARGET, features: ["sse4.1"] };
  const own = await emitted(floor, ["f", "g", "h9"], SSE41);
  assert.match(own, /\broundsd\b/, "the instruction the target named is the one written");
  assert.doesNotMatch(own, /\bcall\b/, "nothing is called where the instruction rounds");

  assert.equal(
    await lowered(floor, print, SSE41),
    await lowered(floor, print),
    "the instruction rounds what the conversion and its correction round",
  );
});

test("a named cpu is asked for the rounding instruction it has", async () => {
  // `target.cpu` is what the C backend already hands gcc as `-march`, so a
  // project that named one has said what the delivered program may assume.
  // Every cpu from Nehalem on carries SSE4.1, and a project naming one was
  // still answered with the library's rounding here — reading a target the C
  // half of the same build had already believed. A cpu older than the
  // instruction must still be refused it, or that promise is worth nothing.
  const floor = subject(
    F64,
    handsBack({ k: "call", type: F64, call: floorCall(local("x", F64)) }),
    [{ kind: "value", name: "x", mutable: false, type: F64 }],
  );
  for (const cpu of ["haswell", "skylake", "znver3", "x86-64-v3"]) {
    const own = await emitted(floor, ["f", "g", "h9"], { ...TARGET, cpu });
    assert.match(own, /\broundsd\b/, `${cpu} has the instruction and is not given it`);
    assert.doesNotMatch(own, /\bcall\b/, `${cpu}: nothing is called where the instruction rounds`);
  }
  for (const cpu of ["core2", "k8"]) {
    const library = await emitted(floor, ["f", "g", "h9"], { ...TARGET, cpu });
    assert.doesNotMatch(library, /\broundsd\b/, `${cpu} predates the instruction and must not be given it`);
  }
});

test("a body of nothing but conditionals is left rolled", async () => {
  // Writing a loop out buys the removal of its test and step, and what it
  // removes them from is the body's own work. A body that is all conditionals
  // has none to amortise them against: each turn is a test the body already
  // had, so writing it out eleven times leaves all eleven standing. The shape
  // is `fCmp` over a field element's limbs — one `if` per turn, guarded on a
  // name the loop never changes — and unrolling it put 284 duplicated
  // instructions inside an `fAddMod` that secp256k1 calls 1.7 million times per
  // scalar multiplication. Both loops below answer the same number, so what
  // the test reads is the instruction: the arithmetic one is written out, the
  // conditional one is not.
  const counted = (statements: SemanticStatement[]): SemanticFunction =>
    subject(I32, {
      id: "entry",
      statements: [
        { k: "let", slot: { kind: "value", name: "seen", mutable: true, type: I32 }, value: number("0", I32), line: 1 },
        {
          k: "loop",
          line: 2,
          loop: {
            kind: "counted",
            variable: "i",
            type: I32,
            from: number("11", I32),
            to: number("0", I32),
            inclusive: true,
            down: true,
            step: null,
            header: "head",
            exit: "out",
            body: { id: "body", releases: [], statements, terminator: { k: "next" } },
          },
        },
      ],
      releases: [],
      terminator: { k: "return", value: local("seen", I32) },
    });

  // The compare `fCmp` is: guarded on a name the loop does not write, so no
  // two turns of it do the same work.
  const guarded = counted([
    {
      k: "if",
      line: 3,
      condition: { k: "compare", type: BOOL, op: "eq", operand: I32, left: local("seen", I32), right: number("0", I32) },
      then: {
        id: "then",
        releases: [],
        statements: [
          { k: "set", name: "seen", op: "=", value: number("1", I32), line: 4 },
          { k: "set", name: "seen", op: "+=", value: local("i", I32), line: 5 },
          { k: "set", name: "seen", op: "+=", value: local("i", I32), line: 6 },
          { k: "set", name: "seen", op: "+=", value: local("i", I32), line: 7 },
          { k: "set", name: "seen", op: "+=", value: local("i", I32), line: 8 },
          { k: "set", name: "seen", op: "+=", value: local("i", I32), line: 9 },
        ],
        terminator: { k: "next" },
      },
      otherwise: null,
    },
  ]);
  // The shape unrolling is for, which must still be written out: a chain of
  // arithmetic whose turns share nothing.
  const arithmetic = counted([
    { k: "set", name: "seen", op: "+=", value: local("i", I32), line: 3 },
    { k: "set", name: "seen", op: "+=", value: local("i", I32), line: 4 },
    { k: "set", name: "seen", op: "+=", value: local("i", I32), line: 5 },
    { k: "set", name: "seen", op: "+=", value: local("i", I32), line: 6 },
    { k: "set", name: "seen", op: "+=", value: local("i", I32), line: 7 },
    { k: "set", name: "seen", op: "+=", value: local("i", I32), line: 8 },
  ]);

  const rolled = await emitted(guarded);
  const written = await emitted(arithmetic);
  // Both loops run the same eleven turns of a body, so what separates them is
  // only whether the body was written out, and instruction count is what that
  // is. The arithmetic body is written out whole, so its eleven copies of one
  // turn's work are what its size is made of. The conditional body is rolled,
  // so it carries one copy of a body six statements long beside a loop test —
  // which is what takes it from 136 instructions to 41. The two numbers are
  // what the gate is worth on this shape, and they were measured rather than
  // assumed: the ratio is the whole of the assertion.
  const size = (assembly: string): number => (assembly.match(/^\s+[0-9a-f]+:/gm) ?? []).length;
  assert.ok(
    size(rolled) * 2 < size(written),
    `a conditional body left rolled (${size(rolled)} instructions) is not markedly smaller than one written out (${size(written)})`,
  );
  assert.equal(
    await lowered(guarded, (name) => `printf("%d", ${name}());`),
    "56",
    "the guarded body still runs every turn: the first sets `seen`, the rest add their counter to it",
  );
  assert.equal(
    await lowered(arithmetic, (name) => `printf("%d", ${name}());`),
    "396",
    "the arithmetic body is still written out and answers what it answered rolled",
  );
});

test("a body that leaves the loop early is not written out", async () => {
  // A `continue` in a nested arm is the same early leave as one at the foot of
  // the body, and the body's own terminator does not show it. Written out, the
  // turns of one trip stand one after another with nothing between them, and the
  // branch a `continue` takes lands on the trip counter rather than on the next
  // turn: the counter never moves, the trip ends after its first turn, and this
  // loop answered zero rather than the sum of the even turns.
  const header = "head";
  const fn = subject(I32, {
    id: "entry",
    statements: [
      { k: "let", slot: { kind: "value", name: "total", mutable: true, type: I32 }, value: number("0", I32), line: 1 },
      {
        k: "loop",
        line: 2,
        loop: {
          kind: "counted",
          variable: "i",
          type: I32,
          from: number("0", I32),
          to: number("8", I32),
          inclusive: false,
          down: false,
          step: null,
          header,
          exit: "out",
          body: {
            id: "body",
            releases: [],
            statements: [
              {
                k: "if",
                line: 3,
                condition: {
                  k: "compare", type: { kind: "primitive", name: "bool" }, op: "eq", operand: I32,
                  left: local("i", I32), right: number("3", I32),
                },
                then: { id: "arm", releases: [], statements: [], terminator: { k: "jump", target: header, releases: [] } },
                otherwise: null,

              },
              { k: "set", name: "total", op: "+=", value: local("i", I32), line: 4 },
            ],
            terminator: { k: "next" },
          },
        },
      },
    ],
    releases: [],
    terminator: { k: "return", value: local("total", I32) },
  });
  // The sum of every turn but the one the `continue` skips.
  assert.equal(await lowered(fn, (name) => `printf("%d", ${name}());`), "25");
});

test("a quotient by a power of two is a product by its reciprocal", async () => {
  // Both forms are the same number, so what the test reads is the instruction:
  // a division is three times the latency of a multiply and is not pipelined,
  // and the quotient is usually on a chain the next turn waits for.
  const parameter = [{ kind: "value", name: "x", mutable: false, type: F64 }] as const;
  const quotient = (right: string) =>
    subject(F64, handsBack({ k: "arith", type: F64, op: "div", left: local("x", F64), right: number(right) }), [...parameter]);
  const instructions = await emitted(quotient("16777216"));
  assert.match(instructions, /\bmulsd\b/, "the reciprocal is carried by the instruction");
  assert.doesNotMatch(instructions, /\bdivsd\b/, "nothing divides where a multiply answers");

  // A divisor that is not a power of two has no reciprocal that is exact, so it
  // is left as the division it is.
  const third = quotient("3");
  assert.match(await emitted(third), /\bdivsd\b/);
  assert.equal(await lowered(third, (name) => `printf("%.17g", ${name}(1e300));`), (1e300 / 3).toExponential(16));
});


test("a loop whose body rounds is written out", async () => {
  // `Math.floor` is written as an instruction on the accumulator, so a body whose
  // only call is one has nothing in it that writing it out would duplicate but
  // arithmetic — which is the shape a modular addition keeps its limbs in, where
  // every turn rounds once. Counting a rounding as a call left that loop rolled,
  // and rolled it kept the counter a double in a register, converted it to an
  // index on every element it reached, and spent a test and a step per turn.
  const rounded = subject(F64, {
    id: "entry",
    releases: [],
    statements: [
      { k: "let", slot: { kind: "value", name: "total", mutable: true, type: F64 }, value: number("0"), line: 1 },
      {
        k: "loop",
        line: 2,
        loop: {
          kind: "counted",
          variable: "i",
          type: F64,
          from: number("0"),
          to: number("11"),
          inclusive: false,
          down: false,
          step: null,
          header: "head",
          exit: "out",
          body: {
            id: "body",
            releases: [],
            terminator: { k: "next" },
            statements: [
              { k: "let", slot: { kind: "value", name: "whole", mutable: true, type: F64 }, value: { k: "call", type: F64, call: floorCall(local("i")) }, line: 3 },
              { k: "set", name: "total", op: "+=", value: local("whole"), line: 4 },
            ],
          },
        },
      },
    ],
    terminator: { k: "return", value: local("total") },
  });
  // The rounding is an instruction only where the target has it, and a target
  // that has not is one where the body calls and the loop is left rolled for the
  // other reason as well.
  const native = { ...TARGET, cpu: "skylake" };
  assert.equal(
    (await emitted(rounded, ["f", "g", "h9"], native)).match(/\broundsd\b/g)?.length,
    11,
    "a body that rounds once a turn is written out once a turn",
  );
  assert.equal(
    await lowered(rounded, (name) => `printf("%.17g", ${name}());`),
    "55",
    "the written-out body is still the sum of the eleven turnings",
  );
});

test("a loop that runs more than one trip still counts its trips", async () => {
  // A note about what the accumulator holds is a fact about the path that fell
  // through to where it was taken, and a loop header is reached again on its
  // second trip with whatever the body left behind. Reading the trip counter
  // where the note says it already is makes the loop answer its first trip over
  // and over: `fZero` over eleven limbs spun in a secp256k1 that never finished.
  // The trip count here is what a written-out body cannot fold into the
  // instructions, because the same eleven turns are written once and run twice.
  const twice = subject(I32, {
    id: "entry",
    releases: [],
    statements: [
      { k: "let", slot: { kind: "value", name: "seen", mutable: true, type: I32 }, value: number("0", I32), line: 1 },
      {
        k: "loop",
        line: 2,
        loop: {
          kind: "counted",
          variable: "i",
          type: I32,
          from: number("0", I32),
          to: number("22", I32),
          inclusive: false,
          down: false,
          step: null,
          header: "head",
          exit: "out",
          body: {
            id: "body",
            releases: [],
            terminator: { k: "next" },
            statements: [{ k: "set", name: "seen", op: "+=", value: number("1", I32), line: 3 }],
          },
        },
      },
    ],
    terminator: { k: "return", value: local("seen", I32) },
  });
  assert.equal(
    await lowered(twice, (name) => `printf("%d", ${name}());`),
    "22",
    "a written-out body of eleven turns is run for both trips and answers all twenty-two",
  );
});

test("a name given a value is not read back out of the register it was given", async () => {
  // `let whole = floor(x)` and then a use of `whole` is one value, and the
  // general form makes it three: compute it into the accumulator, copy the
  // accumulator into the register the build gave the name, and copy that
  // register back into the accumulator to read it. A vector register to vector
  // register has a single port to issue from, so on a loop over a field value's
  // limbs those copies are measured against the loop's own arithmetic. The note
  // that answers the second read is about the value and not about the place it
  // was written, so it survives a statement boundary — a slot handed back is a
  // different value, and the identity on the note is what says so.
  const named = subject(F64, {
    id: "entry",
    releases: [],
    statements: [
      { k: "let", slot: { kind: "value", name: "whole", mutable: true, type: F64 }, value: { k: "call", type: F64, call: floorCall(local("x")) }, line: 1 },
      { k: "let", slot: { kind: "value", name: "scaled", mutable: true, type: F64 }, value: mul(local("whole"), number("2")), line: 2 },
    ],
    terminator: { k: "return", value: add(local("whole"), local("scaled")) },
  });
  const parameter = [{ kind: "value", name: "x", mutable: false, type: F64 }] as const;
  // The value is rounded once and read three times, and a read that the note
  // answers is no instruction at all — so the copies out of the register the
  // general form makes are what is left to count.
  const instructions = await emitted({ ...named, params: [...parameter] }, ["f", "g", "h9"], { ...TARGET, cpu: "skylake" });
  assert.equal(
    instructions.match(/roundsd/g)?.length,
    1,
    "the value is rounded once however many names read it",
  );
  // The multiply that reads the value is the instruction after the one that
  // wrote it: the note answers the read, so the copy back out of the register
  // the general form makes is not there. The read after the multiply is a
  // different question — the multiply took the accumulator and the note with it
  // — and is answered by a copy that is owed.
  assert.match(
    instructions,
    /roundsd[^\n]*\n[^\n]*movsd\s+%xmm0,%xmm3[^\n]*\n[^\n]*mulsd/,
    "the read that follows the write is answered without copying the value out of its own register",
  );
  assert.equal(
    Number(await lowered({ ...named, params: [...parameter] }, (name) => `printf("%.17g", ${name}(7.9));`)),
    3 * Math.floor(7.9),
    "the three reads are the one value the rounding answered",
  );
});

test("a name given the value another name holds is one copy", async () => {
  // `carry = whole` is a move between two registers the build gave names of its
  // own. The general form reads one into the accumulator and writes the
  // accumulator into the other, which is the same number by two instructions
  // instead of one — and the second of them is on the one port a vector move
  // issues from.
  const copied = subject(F64, {
    id: "entry",
    releases: [],
    statements: [
      { k: "let", slot: { kind: "value", name: "whole", mutable: true, type: F64 }, value: local("x"), line: 1 },
      { k: "let", slot: { kind: "value", name: "carry", mutable: true, type: F64 }, value: local("whole"), line: 2 },
    ],
    terminator: { k: "return", value: add(local("whole"), local("carry")) },
  });
  const parameter = [{ kind: "value", name: "x", mutable: false, type: F64 }] as const;
  const withParameter = { ...copied, params: [...parameter] };
  assert.equal(
    Number(await lowered(withParameter, (name) => `printf("%.17g", ${name}(2.5));`)),
    5,
    "the copy is the value it copied",
  );
});

test("a comparison reads the element it is compared against where it lies", async () => {
  // `a[i] > b[i]` is a read of one element and a comparison against the other,
  // and `UCOMISD` reads its source and writes no register but the flags. The
  // general form holds one side in a register or a slot and reads the other out
  // of that, which is three instructions and a register move a comparison does
  // not need. The side in memory is the left one, because the right one is
  // already in the destination the general form compares out of: naming the
  // memory as the source compares the two sides in the same order and leaves
  // every condition after it as it was.
  const compared = (op: "lt" | "le" | "gt" | "ge" | "eq" | "ne") =>
    subject(
      BOOL,
      {
        id: "entry",
        releases: [],
        statements: [
          {
            k: "let",
            slot: { kind: "value", name: "answer", mutable: true, type: BOOL },
            value: { k: "compare", type: BOOL, op, operand: F64, left: at("a", local("i")), right: at("b", local("i")) },
            line: 1,
          },
        ],
        terminator: { k: "return", value: local("answer", BOOL) },
      },
      [
        { kind: "value", name: "a", mutable: false, type: ARRAY_OF_F64 },
        { kind: "value", name: "b", mutable: false, type: ARRAY_OF_F64 },
        { kind: "value", name: "i", mutable: false, type: I64 },
      ],
    );
  const driver = (left: number, right: number) => (name: string) => [
    `  double a[1];`,
    `  double b[1];`,
    `  a[0] = ${Number.isNaN(left) ? "(0.0/0.0)" : left};`,
    `  b[0] = ${Number.isNaN(right) ? "(0.0/0.0)" : right};`,
    `  printf("%d", ${name}(a, b, 0));`,
  ].join("\n");

  for (const op of ["lt", "le", "gt", "ge", "eq", "ne"] as const) {
    const instructions = await emitted(compared(op), ["f", "g", "h9"]);
    assert.match(
      instructions,
      /ucomisd\s+\(%\w+,%\w+,8\),%xmm0/,
      `${op}: the element is the operand of the comparison rather than a copy of it`,
    );
    assert.doesNotMatch(
      instructions,
      /movs?d?\s+%xmm[0-9]+,%xmm[0-9]+/,
      `${op}: neither side of the comparison is copied between registers to be read`,
    );
  }
  // Every operator, on the two cases that separate them: an ordered pair, and a
  // value that is not a number. A comparison against one is false whichever way
  // it is read, and `!=` is the operator where it really is different.
  const expected: Record<string, [number, number, string][]> = {
    lt: [[1, 2, "1"], [2, 1, "0"], [1, 1, "0"], [0, 0, "0"]],
    le: [[1, 2, "1"], [2, 1, "0"], [1, 1, "1"], [0, 0, "1"]],
    gt: [[2, 1, "1"], [1, 2, "0"], [1, 1, "0"], [0, 0, "0"]],
    ge: [[2, 1, "1"], [1, 2, "0"], [1, 1, "1"], [0, 0, "1"]],
    eq: [[1, 1, "1"], [1, 2, "0"], [1, 2, "0"]],
    ne: [[1, 1, "0"], [1, 2, "1"], [1, 2, "1"]],
  };
  for (const [op, cases] of Object.entries(expected)) {
    for (const [left, right, answer] of cases) {
      const notNumbers = Number.isNaN(left) || Number.isNaN(right);
      assert.equal(
        await lowered(compared(op as "lt"), driver(left, right)),
        answer,
        `${op}(${left}, ${right})${notNumbers ? " with a value that is not a number" : ""}`,
      );
    }
  }
});

/**
 * What the machine backend does with a loop the parallel rule marked.
 *
 * The rule says the turns of a marked loop do not depend on each other; it does
 * not say a backend acts on it. The C backend writes a pragma and the host's
 * threads run it. This backend writes its own instructions, so it either writes
 * the turns out as a function the runtime calls once per thread, or leaves the
 * loop as the loop it is — which is the same program, and is what it did before
 * it could start a thread at all.
 *
 * Every test here is one of those two answers, and every one of them is checked
 * against the program rather than against the shape of the code. The driver
 * checks every element the loop wrote, because the claim being made is that a
 * turn computes the turn the loop would have computed at that counter and
 * writes it where no other turn writes: a turn run over the wrong range, run
 * twice, or run with the array pointer read out of a register that belongs to
 * another thread all show up as an element that is wrong, and a sample of three
 * would miss two of the three.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildObject, describeMachineObject } from "../toolchain/ir-machine.ts";
import { buildStandaloneRuntime } from "../runtime/standalone.ts";
import { optimizeSemanticFunction } from "../semantics/optimize-ir.ts";
import { NO_CALLEES } from "../semantics/parallel.ts";
import { run } from "../core/process.ts";
import { scratch } from "./scratch.ts";
import { symbolOf } from "../semantics/contract.ts";
import type { FunctionContract, TargetSpec } from "../core/types.ts";
import type { SemanticBlock, SemanticFunction, SemanticLoop, SemanticSlot, SemanticStatement, SemanticType, SemanticValue } from "../core/semantic-ir.ts";

const F64: SemanticType = { kind: "primitive", name: "f64" };
const I64: SemanticType = { kind: "primitive", name: "i64" };
const I32: SemanticType = { kind: "primitive", name: "i32" };
const PTR: SemanticType = { kind: "ptr", of: F64 };
const USIZE: SemanticType = { kind: "primitive", name: "usize" };
const VOID: SemanticType = { kind: "void" };

const TARGET: TargetSpec = { arch: "x86_64", os: "linux", abi: "sysv", cpu: "", features: [] };

/** How many elements the driver checks, which is enough for a team to be split. */
const ELEMENTS = 1_000_000;

const local = (name: string, type: SemanticType = F64): SemanticValue => ({ k: "local", type, name });
const number = (text: string, type: SemanticType = F64): SemanticValue => ({ k: "const", type, text });
const element = (of: string, index: SemanticValue): SemanticValue => ({ k: "element", type: F64, of: local(of, PTR), index });

/**
 * A body long enough to clear the floor a turn has to clear to be worth a
 * thread, which is the floor the rule applies before it marks anything.
 */
function chain(terms: number, at: SemanticValue): SemanticValue {
  let value = at;
  for (let term = 0; term < terms; term += 1) value = { k: "arith", type: F64, op: "add", left: value, right: number("1") };
  return value;
}

/**
 * The statements that scale one element: it is read at `at`, `by` is added to
 * it, and the answer is written at `place`. A turn of `by === 0` reads an
 * element and writes it back, which is the smallest a turn can be and the one
 * the cost floor refuses.
 */
function scalingTurn(at: SemanticValue, place: SemanticValue, by: number): SemanticStatement[] {
  const read = by === 0 ? at : chain(by, at);
  return [
    { k: "let", line: 2, slot: { kind: "value", name: "scaled", mutable: false, type: F64 }, value: read },
    { k: "setElement", line: 3, op: "=", buffer: "out", index: place, value: local("scaled") },
  ];
}

/** A counted loop over the statements the body is given. */
function counted(body: SemanticStatement[], extra: Record<string, unknown> = {}): SemanticStatement {
  return {
    k: "loop",
    line: 1,
    loop: {
      kind: "counted",
      variable: "i",
      type: I64,
      from: number("0", I64),
      to: number(String(ELEMENTS), I64),
      inclusive: false,
      down: false,
      step: null,
      header: "h1",
      exit: "entry",
      body: { id: "b1", releases: [], terminator: { k: "next" }, statements: body },
      ...extra,
    },
  };
}

function subject(entry: SemanticBlock, params: SemanticSlot[]): SemanticFunction {
  return {
    name: "subject",
    symbol: "blaze_subject",
    params,
    returns: VOID,
    requires: [],
    ensures: [],
    effects: [],
    allocates: false,
    prints: false,
    readsArgv: false,
    objects: {},
    calls: [],
    entry,
  };
}

function typeTextOf(slot: SemanticSlot): string {
  if (slot.kind === "text") return "ptr<u8>";
  if (slot.kind !== "value") return "f64";
  const type = slot.type;
  if (type.kind === "ptr" || type.kind === "slice" || type.kind === "array") return `ptr<${typeTextOf({ kind: "value", name: "", mutable: false, type: type.of })}>`;
  return type.kind === "primitive" ? type.name : "f64";
}

function contracted(fn: SemanticFunction): FunctionContract {
  return {
    version: "1",
    function: {
      name: fn.name,
      symbol: fn.symbol,
      params: fn.params.flatMap((param) => {
        const type = typeTextOf(param);
        const semanticType = param.kind === "value" || param.kind === "object" ? param.type : null;
        const isSeq = semanticType !== null && (semanticType.kind === "array" || semanticType.kind === "slice" || semanticType.kind === "ptr" || semanticType.kind === "mask");
        if (isSeq) return [{ name: param.name, type }, { name: `${param.name}_length`, type: "usize" }];
        return [{ name: param.name, type }];
      }),
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

/**
 * A body with every mark taken off it, which is the body this backend writes as
 * loops rather than as teams.
 *
 * The marks come off after the passes that set them rather than by leaving one
 * out of the IR, because the rule sets the mark on every loop it proves and a
 * loop handed to it unmarked comes back marked. That is what makes this the
 * control the tests compare against: one IR, one set of passes, a mark apart.
 */
function unmark(block: SemanticBlock): SemanticBlock {
  const statements = block.statements.map((statement): SemanticStatement => {
    switch (statement.k) {
      case "loop": {
        const loop: SemanticLoop =
          statement.loop.kind === "counted" || statement.loop.kind === "each"
            ? { ...statement.loop, parallel: undefined }
            : statement.loop;
        return { ...statement, loop: { ...loop, body: unmark(loop.body) } };
      }
      case "if":
        return {
          ...statement,
          then: unmark(statement.then),
          ...(statement.otherwise === null ? {} : { otherwise: unmark(statement.otherwise) }),
        };
      case "block":
        return { ...statement, body: unmark(statement.body) };
      default:
        return statement;
    }
  });
  return { ...block, statements };
}

/**
 * Lowers a body, runs it over an array of a million doubles and answers what
 * the program wrote.
 *
 * The driver fills the array with the counter at each element, so the value the
 * loop has to leave at every one of them is a number this file can state rather
 * than one it has to remember: `by` added to what was there. It checks every
 * element and prints the first that is wrong, because the claim a team makes is
 * about all of them and not about a sample.
 */
async function runOver(
  entry: SemanticBlock,
  params: SemanticSlot[],
  by: number,
  options: { team?: boolean; n?: number; check?: boolean } = {},
): Promise<{ printed: string; threads: boolean; listing: string }> {
  const directory = await scratch("blaze-machine-team-");
  const runtime = await buildStandaloneRuntime(directory);
  const optimized = optimizeSemanticFunction(subject(entry, params), NO_CALLEES);
  const fn = options.team === false ? { ...optimized, entry: unmark(optimized.entry) } : optimized;
  const contract = contracted(fn);
  const object = join(directory, "subject.o");
  const built = await buildObject({ fn, contract, target: TARGET, callable: new Set(), objectPath: object });
  const count = options.n ?? ELEMENTS;
  const check = options.check ?? true;
  await writeFile(
    join(directory, "driver.c"),
    [
      "#include <stdio.h>",
      "#include <stdlib.h>",
      `extern void ${symbolOf(contract)}(double* out, size_t out_length, long long n);`,
      "int main(void) {",
      `  long long n = ${count};`,
      "  double* out = (double*)malloc(n * 8);",
      "  for (long long i = 0; i < n; i++) out[i] = (double)i;",
      `  ${symbolOf(contract)}(out, n, n);`,
      ...(check
        ? [
            "  for (long long i = 0; i < n; i++) {",
            `    if (out[i] != (double)i + ${by}.0) { printf("WRONG %lld %.17g\\n", i, out[i]); return 1; }`,
            "  }",
            '  printf("every element\\n");',
          ]
        : ['  printf("ran\\n");']),
      "  return 0;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  const binary = join(directory, "run");
  const linked = run(
    "gcc",
    ["-std=c11", "-O2", "-pthread", "-I", directory, join(directory, "driver.c"), object, runtime.objectPath, "-o", binary, "-lm"],
    { timeoutMs: 120_000 },
  );
  assert.equal(linked.code, 0, `the machine code must link:\n${linked.stderr}`);
  const ran = run(binary, [], { timeoutMs: 60_000 });
  assert.equal(ran.code, 0, `the machine code must run:\n${ran.stdout}${ran.stderr}`);
  // The listing is whatever the machine code says of itself: a disassembler
  // where there is one, and the object's own description where there is not, so
  // a test that reads the code does not depend on a tool being installed.
  const listing = describeMachineObject(object, await readFile(object)).text;
  return { printed: ran.stdout.trimEnd(), threads: built.threads, listing };
}

const PARAMS: SemanticSlot[] = [{ kind: "value", name: "out", mutable: true, type: PTR }];

/** A counted loop that adds nine to every element, marked by the rule or not. */
function scalingLoop(by: number, extra: Record<string, unknown> = {}): SemanticStatement {
  return counted(scalingTurn(element("out", local("i", I64)), local("i", I64), by), extra);
}

test("a marked loop is written as a team of threads and answers for every element", async () => {
  const ran = await runOver({ id: "entry", releases: [], terminator: { k: "return", value: null }, statements: [scalingLoop(9)] }, PARAMS, 9);
  assert.equal(ran.threads, true, "the object asks for threads at the link");
  assert.match(ran.listing, /blaze_rt_parallel_for/, "and the runtime is what runs the turns");
  assert.equal(ran.printed, "every element");
});

test("the turns a team runs are the turns the loop would have run", async () => {
  // The whole claim, against the one answer that is not a team: the same body
  // with the mark taken off afterwards is lowered, run and checked over the
  // same array, and every element has to come out the same.
  const body: SemanticBlock = { id: "entry", releases: [], terminator: { k: "return", value: null }, statements: [scalingLoop(9)] };
  const team = await runOver(body, PARAMS, 9);
  const inOrder = await runOver(body, PARAMS, 9, { team: false });
  assert.equal(inOrder.threads, false, "a loop written in order asks for no threads");
  assert.doesNotMatch(inOrder.listing, /blaze_rt_parallel_for/);
  assert.equal(team.printed, inOrder.printed);
  assert.equal(team.printed, "every element");
});

test("a turn that computes little is left to run in order", async () => {
  // The floor is a judgement about speed and not about correctness: a turn that
  // computes a handful of values does less work than the team that would run it
  // costs to start. The loop here is the same shape as the one above and does a
  // hundredth of the work in it.
  const cheap: SemanticBlock = { id: "entry", releases: [], terminator: { k: "return", value: null }, statements: [scalingLoop(0)] };
  const ran = await runOver(cheap, PARAMS, 0);
  assert.equal(ran.threads, false, "a turn of two values is not worth a team");
  assert.doesNotMatch(ran.listing, /blaze_rt_parallel_for/);
  assert.equal(ran.printed, "every element");
});

test("a loop whose turns combine an accumulator is left to the vector paths", async () => {
  // Combining means a slot per thread and a pass over them afterwards, and the
  // loops that reduce are the ones this backend already writes a whole vector
  // at a time. A reduction of doubles is refused by the rule in the first place,
  // because a sum of doubles is not the same number however it is grouped.
  const body: SemanticBlock = {
    id: "entry",
    releases: [],
    terminator: { k: "return", value: null },
    statements: [
      counted([{ k: "set", name: "total", op: "+=", line: 2, value: chain(9, element("out", local("i", I64))) }], { to: number("4", I64) }),
      { k: "let", line: 3, slot: { kind: "value", name: "sink", mutable: false, type: F64 }, value: local("total") },
    ],
  };
  const ran = await runOver(body, [...PARAMS, { kind: "value", name: "total", mutable: true, type: F64 }], 0, { n: 4 });
  assert.equal(ran.threads, false, "an accumulator the turns share is not handed to a team here");
  assert.doesNotMatch(ran.listing, /blaze_rt_parallel_for/);
});

test("a counter narrower than the halves a runtime hands out is left in order", async () => {
  // A team is cut into halves counted in whole numbers, and a counter that
  // cannot hold one of them has nothing to be cut into.
  const narrow: SemanticBlock = {
    id: "entry",
    releases: [],
    terminator: { k: "return", value: null },
    statements: [
      counted(scalingTurn(element("out", local("i", I32)), local("i", I32), 9), {
        type: I32,
        from: number("0", I32),
        to: number(String(ELEMENTS), I32),
      }),
    ],
  };
  const ran = await runOver(narrow, PARAMS, 9);
  assert.equal(ran.threads, false);
  assert.doesNotMatch(ran.listing, /blaze_rt_parallel_for/);
  assert.equal(ran.printed, "every element");
});

test("a turn that returns out of the function is not run by a team", async () => {
  // A turn is a function the runtime calls, so returning from it leaves the team
  // halfway through the loop and hands the caller a function that has not
  // returned at all. The loop runs in order instead, where the return means
  // what the source wrote.
  const body: SemanticBlock = {
    id: "entry",
    releases: [],
    terminator: { k: "return", value: null },
    statements: [
      {
        k: "loop",
        line: 1,
        loop: {
          kind: "counted",
          variable: "i",
          type: I64,
          from: number("0", I64),
          to: number(String(ELEMENTS), I64),
          inclusive: false,
          down: false,
          step: null,
          header: "h1",
          exit: "entry",
          body: {
            id: "b1",
            releases: [],
            terminator: { k: "return", value: number("0", I64) },
            statements: scalingTurn(element("out", local("i", I64)), local("i", I64), 9),
          },
        },
      },
    ],
  };
  const ran = await runOver(body, PARAMS, 9, { n: 8, check: false });
  assert.equal(ran.threads, false);
  assert.doesNotMatch(ran.listing, /blaze_rt_parallel_for/);
  assert.equal(ran.printed, "ran", "and the return in the body is the return the source wrote");
});

test("a walk over an array is written as a team of threads", async () => {
  // The other shape a range takes: the index is the range and the buffer is a
  // name the walk reads, so a turn copies the frame and walks its own half of
  // it. The length is a name rather than a literal here, because a walk reads
  // its length once and a turn must not read it once per thread.
  const walk = (): SemanticBlock => ({
    id: "entry",
    releases: [],
    terminator: { k: "return", value: null },
    statements: [
      {
        k: "loop",
        line: 1,
        loop: {
          kind: "each",
          index: "j",
          element: "x",
          elementType: F64,
          of: "out",
          length: local("n", I64),
          header: "h1",
          exit: "entry",
          body: {
            id: "b1",
            releases: [],
            terminator: { k: "next" },
            statements: scalingTurn(local("x"), local("j", USIZE), 9),
          },
        },
      },
    ],
  });
  const params: SemanticSlot[] = [...PARAMS, { kind: "value", name: "n", mutable: false, type: I64 }];
  const team = await runOver(walk(), params, 9);
  const inOrder = await runOver(walk(), params, 9, { team: false });
  assert.equal(team.threads, true);
  assert.equal(inOrder.threads, false);
  assert.equal(team.printed, inOrder.printed);
  assert.equal(team.printed, "every element");
});

test("a range with nothing in it asks for a team and runs none of its turns", async () => {
  // A loop whose bound is below where it starts turns no times at all. The
  // difference of two counters is not a count when the second is the smaller of
  // them, and a team handed that difference would be handed the whole range
  // twice over.
  const empty: SemanticBlock = {
    id: "entry",
    releases: [],
    terminator: { k: "return", value: null },
    statements: [counted(scalingTurn(element("out", local("i", I64)), local("i", I64), 9), { from: local("n", I64), to: number("0", I64) })],
  };
  const ran = await runOver(empty, [...PARAMS, { kind: "value", name: "n", mutable: false, type: I64 }], 0);
  assert.equal(ran.threads, true, "the loop is still one this backend can hand to a team");
  assert.equal(ran.printed, "every element", "and no turn of it ran");
});

test("a loop nested in a team is written as the loop it is", async () => {
  // The inner loop runs inside a turn, where the range is one thread's and a
  // second fan-out inside it has nothing measured to say it pays. What has to
  // hold is the part that is easy to get wrong: the names the inner loop reads
  // are read out of the frame the turn copied, and each outer turn writes its
  // own elements rather than the same ones again.
  const nested = (outerTo: number, innerTo: number): SemanticBlock => ({
    id: "entry",
    releases: [],
    terminator: { k: "return", value: null },
    statements: [
      {
        k: "loop",
        line: 1,
        loop: {
          kind: "counted",
          variable: "i",
          type: I64,
          from: number("0", I64),
          to: number(String(outerTo), I64),
          inclusive: false,
          down: false,
          step: null,
          header: "h1",
          exit: "entry",
          body: {
            id: "b1",
            releases: [],
            terminator: { k: "next" },
            statements: [
              {
                k: "loop",
                line: 2,
                loop: {
                  kind: "counted",
                  variable: "k",
                  type: I64,
                  from: number("0", I64),
                  to: number(String(innerTo), I64),
                  inclusive: false,
                  down: false,
                  step: null,
                  header: "h2",
                  exit: "b1",
                  body: {
                    id: "b2",
                    releases: [],
                    terminator: { k: "next" },
                    statements: scalingTurn(element("out", { k: "arith", type: I64, op: "add", left: { k: "arith", type: I64, op: "mul", left: local("i", I64), right: number(String(innerTo), I64) }, right: local("k", I64) }), { k: "arith", type: I64, op: "add", left: { k: "arith", type: I64, op: "mul", left: local("i", I64), right: number(String(innerTo), I64) }, right: local("k", I64) } as SemanticValue, 9),
                  },
                },
              },
            ],
          },
        },
      },
    ],
  });
  const team = await runOver(nested(2, 4), PARAMS, 9, { n: 8 });
  const inOrder = await runOver(nested(2, 4), PARAMS, 9, { team: false, n: 8 });
  assert.equal(team.printed, inOrder.printed);
  assert.equal(team.printed, "every element");
});

test("a loop marked for a region answers for every element", async () => {
  // A region-marked loop opens and closes a region around its body, and both are
  // calls into the runtime. The graph that decides which registers a name may
  // live in was told about the loops written as a team of threads and not about
  // these, so a name defined before the region was entered and read inside it
  // was pinned to a register the runtime call overwrites. The driver checks every
  // element, because a name clobbered by the call is wrong on every turn after
  // the first, and sampling three of them would miss it.
  // The mark is written on the loop rather than left to the rule: the rule needs
  // a loop that allocates to reuse its storage, and this one is about what
  // survives the region, not about what it reuses.
  const loop = counted([
        // `base` was defined before the region was entered and is read inside
        // it, so it has to survive the runtime call the region is.
        {
          k: "let",
          line: 2,
          slot: { kind: "value", name: "scaled", mutable: false, type: F64 },
          value: { k: "arith", type: F64, op: "add", left: chain(9, element("out", local("i", I64))), right: local("base") },
        },
        { k: "setElement", line: 3, op: "=", buffer: "out", index: local("i", I64), value: local("scaled") },
  ], { region: true });
  const body: SemanticBlock = {
    id: "entry",
    releases: [],
    terminator: { k: "return", value: null },
    statements: [
      { k: "let", line: 1, slot: { kind: "value", name: "base", mutable: false, type: F64 }, value: number("0") },
      loop,
    ],
  };
  const ran = await runOver(body, PARAMS, 9);
  assert.match(ran.listing, /blaze_rt_region_enter/, "the region is opened around the body");
  assert.equal(ran.printed, "every element");
});

test("a break out of a loop inside a region leaves the region open", async () => {
  // The region belongs to the loop it was opened for. A `break` out of a loop
  // *inside* that one lands still inside its body, and ending the region there
  // meant the rest of the turn allocated from the slab rather than the cursor,
  // while a block released on that path reached the slab's released list and the
  // next turn's rewind handed the same bytes out again.
  const inner: SemanticStatement = {
    k: "loop",
    line: 4,
    loop: {
      kind: "while",
      // Always true, so the turn reaches the body and always breaks out of it:
      // what is under test is the jump, not the loop.
      condition: { k: "compare", type: { kind: "primitive", name: "bool" }, op: "ge", operand: I64, left: local("i", I64), right: number("0", I64) },
      header: "h2",
      exit: "b3",
      body: {
        id: "b3",
        releases: [],
        terminator: { k: "jump", target: "b3", releases: [] },
        statements: [],
      },
    },
  };
  const loop = counted([
    { k: "let", line: 2, slot: { kind: "value", name: "scaled", mutable: false, type: F64 }, value: chain(9, element("out", local("i", I64))) },
    { k: "setElement", line: 3, op: "=", buffer: "out", index: local("i", I64), value: local("scaled") },
    inner,
  ], { region: true });
  const body: SemanticBlock = {
    id: "entry",
    releases: [],
    terminator: { k: "return", value: null },
    statements: [
      { k: "let", line: 1, slot: { kind: "value", name: "base", mutable: false, type: F64 }, value: number("0") },
      loop,
    ],
  };
  const ran = await runOver(body, PARAMS, 9);
  const entered = (ran.listing.match(/blaze_rt_region_enter/g) ?? []).length;
  const left = (ran.listing.match(/blaze_rt_region_leave/g) ?? []).length;
  assert.equal(entered, left, "the turn opens one region and closes it once");
  assert.equal(ran.printed, "every element");
});

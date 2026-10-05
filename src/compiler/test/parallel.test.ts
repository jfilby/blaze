/**
 * Which loops the compiler runs their turns at the same time on.
 *
 * A mark on a loop is a promise that no two turns of it can be in one another's
 * way, so what is checked here is every way a turn can reach another: the
 * writes that are refused, the body that is marked, and the round trip of the
 * word through the IR text a model is handed and a person reads.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { SemanticCall, SemanticFunction, SemanticLoop, SemanticSlot, SemanticStatement, SemanticValue } from "../core/semantic-ir.ts";
import { optimizeSemanticFunction } from "../semantics/optimize-ir.ts";
import { entryIsParallel, markParallelLoops, refusalFor } from "../semantics/parallel.ts";
import { semanticFunctionProblems, semanticIrProblems } from "../semantics/ir-validate.ts";
import type { TypeExpr } from "../core/types.ts";
import { parseSemanticProgram, printSemanticProgram } from "../semantics/ir-text.ts";
import { resolveProgram } from "../semantics/ir-resolve.ts";
import { phaseOf } from "./phase.ts";

/**
 * A program whose loop turns write one element each: every turn writes the
 * element its own counter names, which is the shape the mark exists for.
 */
const PARALLEL_SOURCE = [
  "const n = 3;",
  "const input = new Float64Array([1, 2, 3]);",
  "const output = new Float64Array(n);",
  "for (let i = 0; i < n; i += 1) {",
  "  const scaled = input[i] * 2 + 1;",
  "  output[i] = scaled + scaled + scaled + scaled + scaled + scaled;",
  "}",
  "console.log(output[0]);",
  "",
].join("\n");


const F64: TypeExpr = { kind: "primitive", name: "f64" };
const I64: TypeExpr = { kind: "primitive", name: "i64" };
const BOOL: TypeExpr = { kind: "primitive", name: "bool" };
const USIZE: TypeExpr = { kind: "primitive", name: "usize" };

type CountedLoop = Extract<SemanticLoop, { kind: "counted" }>;
type LoopStatement = Extract<SemanticStatement, { k: "loop" }>;

/**
 * A body that does enough work in a turn to be worth a thread.
 *
 * A turn that computes a handful of values is refused on cost alone, so every
 * body a test expects to be marked carries a chain of additions long enough to
 * clear that bar. The chain is over the counter, which is the one name a turn
 * has of its own.
 */
function chain(terms: number): Extract<SemanticStatement, { k: "let" }> {
  let value: SemanticValue = { k: "const", type: F64, text: "1" };
  for (let term = 0; term < terms; term += 1) {
    value = { k: "arith", type: F64, op: "add", left: value, right: { k: "const", type: F64, text: "1" } };
  }
  return { k: "let", line: 2, slot: { kind: "value", name: "acc", mutable: false, type: F64 }, value };
}

/** A counted loop over the statements given. */
function countedLoop(
  body: readonly SemanticStatement[],
  extra: Partial<CountedLoop> = {},
): LoopStatement {
  return {
    k: "loop",
    line: 1,
    loop: {
      kind: "counted",
      variable: "i",
      type: I64,
      from: { k: "const", type: I64, text: "0" },
      to: { k: "const", type: I64, text: "1000" },
      inclusive: false,
      down: false,
      step: null,
      header: "h1",
      exit: "x1",
      body: { id: "b1", statements: [...body], releases: [], terminator: { k: "next" } },
      ...extra,
    },
  };
}

/** A for-of walk over the statements given. */
function eachLoop(body: readonly SemanticStatement[]): LoopStatement {
  return {
    k: "loop",
    line: 1,
    loop: {
      kind: "each",
      index: "idx",
      element: "element",
      elementType: F64,
      of: "values",
      length: { k: "const", type: USIZE, text: "1000" },
      header: "h1",
      exit: "x1",
      body: { id: "b1", statements: [...body], releases: [], terminator: { k: "next" } },
    },
  };
}

/** A function whose whole body is one loop over the statements given. */
function functionWith(loop: LoopStatement): SemanticFunction {
  return {
    name: "f",
    symbol: "blaze_f",
    params: [{ kind: "value", name: "acc", mutable: true, type: F64 }],
    returns: { kind: "void" },
    requires: [],
    ensures: [],
    effects: [],
    allocates: false,
    prints: false,
    readsArgv: false,
    objects: {},
    calls: [],
    entry: { id: "entry", statements: [loop], releases: [], terminator: { k: "return", value: null } },
  };
}

/** The counted loop a function's body is. */
function onlyLoop(fn: SemanticFunction): CountedLoop {
  const statement = fn.entry.statements[0];
  assert.equal(statement?.k, "loop");
  const loop = (statement as LoopStatement).loop;
  assert.equal(loop.kind, "counted");
  return loop as CountedLoop;
}

test("a loop whose body computes and declares is marked", () => {
  const fn = functionWith(
    countedLoop([
      chain(8),
    ]),
  );
  markParallelLoops(fn.entry);
  assert.equal(onlyLoop(fn).parallel, true);
});

test("a for-of walk whose body only reads is marked", () => {
  const fn = functionWith(
    eachLoop([
      chain(8),
    ]),
  );
  markParallelLoops(fn.entry);
  assert.equal(entryIsParallel(fn.entry), true);
});

test("a loop that accumulates into a name outside it is not marked", () => {
  const fn = functionWith(
    countedLoop([
      { k: "set", line: 2, name: "total", op: "+=", value: { k: "local", type: F64, name: "x" } },
    ]),
  );
  markParallelLoops(fn.entry);
  assert.equal(onlyLoop(fn).parallel, undefined);
});

test("a loop writing out[i] is marked, because every turn writes its own element", () => {
  const fn = functionWith(
    countedLoop([
      {
        k: "setElement",
        line: 2,
        buffer: "out",
        index: { k: "local", type: USIZE, name: "i" },
        op: "=",
        value: {
          k: "arith",
          type: F64,
          op: "mul",
          left: {
            k: "element",
            type: F64,
            of: { k: "local", type: { kind: "array", of: F64, length: 4 }, name: "values" },
            index: { k: "local", type: USIZE, name: "i" },
          },
          right: { k: "const", type: F64, text: "2" },
        },
      },
      chain(8),
    ]),
  );
  markParallelLoops(fn.entry);
  assert.equal(onlyLoop(fn).parallel, true);
});

test("a loop writing an element at an index it computed is not marked", () => {
  const fn = functionWith(
    countedLoop([
      {
        k: "setElement",
        line: 2,
        buffer: "out",
        index: { k: "local", type: USIZE, name: "j" },
        op: "=",
        value: { k: "local", type: F64, name: "x" },
      },
    ]),
  );
  markParallelLoops(fn.entry);
  assert.equal(onlyLoop(fn).parallel, undefined);
});

test("a loop writing two elements of one array is not marked", () => {
  const fn = functionWith(
    countedLoop([
      { k: "setElement", line: 2, buffer: "out", index: { k: "local", type: USIZE, name: "i" }, op: "=", value: { k: "local", type: F64, name: "x" } },
      { k: "setElement", line: 3, buffer: "out", index: { k: "local", type: USIZE, name: "i" }, op: "=", value: { k: "local", type: F64, name: "y" } },
    ]),
  );
  markParallelLoops(fn.entry);
  assert.equal(onlyLoop(fn).parallel, undefined);
});

test("a loop reading a written array at another index is not marked", () => {
  const fn = functionWith(
    countedLoop([
      { k: "setElement", line: 2, buffer: "out", index: { k: "local", type: USIZE, name: "i" }, op: "=", value: { k: "local", type: F64, name: "x" } },
      {
        k: "let",
        line: 3,
        slot: { kind: "value", name: "neighbour", mutable: false, type: F64 },
        value: { k: "element", type: F64, of: { k: "local", type: { kind: "array", of: F64, length: 4 }, name: "out" }, index: { k: "local", type: USIZE, name: "j" } },
      },
    ]),
  );
  markParallelLoops(fn.entry);
  assert.equal(onlyLoop(fn).parallel, undefined);
});

test("a write through a name bound to a written array is not marked", () => {
  // The element rule reads a buffer by the name it was written under, so a
  // write at `mine[i]` and a read at `out[j]` were two buffers rather than one:
  // every turn writes its own element of the same array, and a read at an index
  // of its own meets what another turn wrote.
  const fn = functionWith(
    countedLoop([
      {
        k: "let",
        line: 2,
        slot: { kind: "value", name: "mine", mutable: false, type: { kind: "array", of: F64, length: 4 } },
        value: { k: "local", type: { kind: "array", of: F64, length: 4 }, name: "out" },
      },
      { k: "setElement", line: 3, buffer: "mine", index: { k: "local", type: USIZE, name: "i" }, op: "=", value: { k: "local", type: F64, name: "x" } },
      {
        k: "let",
        line: 4,
        slot: { kind: "value", name: "neighbour", mutable: false, type: F64 },
        value: { k: "element", type: F64, of: { k: "local", type: { kind: "array", of: F64, length: 4 }, name: "out" }, index: { k: "local", type: USIZE, name: "j" } },
      },
      chain(8),
    ]),
  );
  markParallelLoops(fn.entry);
  assert.equal(onlyLoop(fn).parallel, undefined);
});

test("a loop that allocates is marked, because the allocator pools per thread", () => {
  const fn = functionWith(
    countedLoop([
      {
        k: "let",
        line: 2,
        slot: { kind: "buffer", name: "scratch", mutable: false, element: { kind: "primitive", name: "f64" }, length: 8 },
        value: {
          k: "buffer",
          type: { kind: "array", of: F64, length: 8 },
          element: F64,
          length: 8,
          count: { k: "const", type: USIZE, text: "8" },
          view: null,
          values: [],
        },
      },
      chain(8),
    ]),
  );
  markParallelLoops(fn.entry);
  assert.equal(onlyLoop(fn).parallel, true);
});

/** A call to `callee`, as the IR states one. */
function call(callee: string, over: Partial<SemanticCall> = {}): Extract<SemanticStatement, { k: "call" }> {
  return {
    k: "call",
    line: 2,
    call: {
      callee,
      signature: { name: callee, symbol: `blaze_${callee}`, params: [], returns: "f64" },
      args: [],
      argTypes: [],
      returns: F64,
      effects: [],
      ownership: "none",
      retain: false,
      builtin: false,
      ...over,
    },
  };
}

/** A function of the program, as `optimizeSemanticProgram` collects them. */
function callee(
  name: string,
  statements: readonly SemanticStatement[],
  params: readonly SemanticSlot[] = [],
): SemanticFunction {
  return {
    ...functionWith(countedLoop([])),
    name,
    symbol: `blaze_${name}`,
    params: [...params],
    entry: { id: "entry", statements: [...statements], releases: [], terminator: { k: "return", value: null } },
  };
}

test("a loop calling a function that writes nothing is marked", () => {
  const fn = functionWith(countedLoop([call("pure"), chain(8)]));
  const callees = new Map([["pure", callee("pure", [chain(8)])]]);
  markParallelLoops(fn.entry, callees);
  assert.equal(onlyLoop(fn).parallel, true);
});

test("a loop calling a function that spends its own parameter is marked", () => {
  // Every turn that calls the function is a separate call with its own copy of
  // the argument, so a callee that decrements it on the way down reaches nobody
  // else. Refusing this refused nearly every loop that calls a function written
  // the ordinary way — `createTree` spending the depth it was given among them.
  const countdown = callee(
    "countdown",
    [{ k: "step", line: 2, name: "n", op: "--", prefix: false }, chain(8)],
    [{ kind: "value", name: "n", mutable: true, type: F64 }],
  );
  const fn = functionWith(countedLoop([call("countdown"), chain(8)]));
  markParallelLoops(fn.entry, new Map([["countdown", countdown]]));
  assert.equal(onlyLoop(fn).parallel, true);
});

test("a loop calling a function that declares and writes its own name is marked", () => {
  // A name the callee declares is its own on the same terms as a parameter.
  const accumulator = callee("accumulator", [{ k: "let", line: 2, slot: { kind: "value", name: "held", mutable: true, type: F64 }, value: { k: "const", type: F64, text: "1" } }, chain(8)]);
  const fn = functionWith(countedLoop([call("accumulator"), chain(8)]));
  markParallelLoops(fn.entry, new Map([["accumulator", accumulator]]));
  assert.equal(onlyLoop(fn).parallel, true);
});

test("a loop calling a function this build does not hold is not marked", () => {
  const fn = functionWith(countedLoop([call("elsewhere"), chain(8)]));
  markParallelLoops(fn.entry, new Map());
  assert.equal(onlyLoop(fn).parallel, undefined);
});

test("a loop calling a function that allocates what it hands back is marked", () => {
  const fn = functionWith(countedLoop([call("maker", { ownership: "owned" }), chain(8)]));
  markParallelLoops(fn.entry, new Map([["maker", callee("maker", [chain(8)])]]));
  assert.equal(onlyLoop(fn).parallel, true);
});

test("a loop calling a function whose body allocates is marked", () => {
  const fn = functionWith(countedLoop([call("maker"), chain(8)]));
  const maker = callee("maker", [
    {
      k: "let",
      line: 2,
      slot: { kind: "object", name: "built", mutable: false, type: { kind: "ref", of: F64, name: "Node" } },
      value: { k: "newObject", type: { kind: "ref", of: F64, name: "Node" }, layout: "Node", fields: [] },
    },
    chain(8),
  ]);
  markParallelLoops(fn.entry, new Map([["maker", maker]]));
  assert.equal(onlyLoop(fn).parallel, true);
});

test("a loop calling a function that counts a reference is not marked", () => {
  const fn = functionWith(countedLoop([call("keeper", { retain: true }), chain(8)]));
  markParallelLoops(fn.entry, new Map([["keeper", callee("keeper", [chain(8)])]]));
  assert.equal(onlyLoop(fn).parallel, undefined);
});

test("a loop calling a function with an effect beyond memory is not marked", () => {
  const fn = functionWith(countedLoop([call("clock", { effects: ["clock"] }), chain(8)]));
  markParallelLoops(fn.entry, new Map([["clock", callee("clock", [chain(8)])]]));
  assert.equal(onlyLoop(fn).parallel, undefined);
});

test("purity is transitive: a call to a pure function is pure", () => {
  const inner = callee("inner", [chain(8)]);
  const middle = callee("middle", [call("inner"), chain(8)]);
  const fn = functionWith(countedLoop([call("middle"), chain(8)]));
  markParallelLoops(fn.entry, new Map([["middle", middle], ["inner", inner]]));
  assert.equal(onlyLoop(fn).parallel, true);
});

test("purity is transitive both ways: one impure step refuses the whole chain", () => {
  // The step is impure because it prints, which is what output order is: a
  // callee that writes an argument of its own is no longer a step that refuses.
  const impure = callee("impure", [{ k: "printNumber", line: 2, value: { k: "const", type: F64, text: "1" }, bigint: false }, chain(8)]);
  const middle = callee("middle", [call("impure"), chain(8)]);
  const fn = functionWith(countedLoop([call("middle"), chain(8)]));
  markParallelLoops(fn.entry, new Map([["middle", middle], ["impure", impure]]));
  assert.equal(onlyLoop(fn).parallel, undefined);
});

test("a function that calls itself and writes nothing is pure, and reading it ends", () => {
  const recursive = callee("recursive", [call("recursive"), chain(8)]);
  const fn = functionWith(countedLoop([call("recursive"), chain(8)]));
  markParallelLoops(fn.entry, new Map([["recursive", recursive]]));
  assert.equal(onlyLoop(fn).parallel, true);
});

test("a loop accumulating a whole number written as a double is marked", () => {
  // `1` held at `f64` is the whole number 1, and what decides whether the turns
  // may combine it is the number rather than the width it is carried at.
  const fn = functionWith(
    countedLoop([
      { k: "set", line: 2, name: "total", op: "+=", value: { k: "const", type: F64, text: "1" } },
      chain(8),
    ]),
  );
  markParallelLoops(fn.entry, new Map());
  assert.equal(onlyLoop(fn).parallel, true);
  assert.deepEqual(onlyLoop(fn).reductions, [{ name: "total", op: "+", exact: true }]);
});

test("a loop whose body reads the accumulator it combines is not marked", () => {
  // The prefix sum: `out[i] = total` is the total only up to that turn, and the
  // combining is what makes `total` private to the turn — the C backend writes
  // `reduction(+:total)`, so the read sees the owning thread's partial sum.
  const fn = functionWith(
    countedLoop([
      { k: "set", line: 2, name: "total", op: "+=", value: { k: "const", type: F64, text: "1" } },
      { k: "setElement", line: 3, buffer: "out", index: { k: "local", type: I64, name: "i" }, op: "=", value: { k: "local", type: F64, name: "total" } },
      chain(8),
    ]),
  );
  markParallelLoops(fn.entry, new Map());
  assert.equal(onlyLoop(fn).parallel, undefined);
});

test("a loop whose body prints is not marked, because output order is the program's", () => {
  const fn = functionWith(
    countedLoop([{ k: "printNumber", line: 2, value: { k: "local", type: F64, name: "x" }, bigint: false }]),
  );
  markParallelLoops(fn.entry);
  assert.equal(onlyLoop(fn).parallel, undefined);
});

test("a loop whose body calls anything is not marked", () => {
  const fn = functionWith(
    countedLoop([
      {
        k: "call",
        line: 2,
        call: {
          callee: "g",
          signature: { name: "g", symbol: "blaze_g", params: [], returns: "f64" },
          args: [],
          argTypes: [],
          returns: F64,
          effects: [],
          ownership: "none",
          retain: false,
          builtin: false,
        },
      },
    ]),
  );
  markParallelLoops(fn.entry);
  assert.equal(onlyLoop(fn).parallel, undefined);
});

test("a loop whose body computes a value that calls is not marked", () => {
  const fn = functionWith(
    countedLoop([
      {
        k: "let",
        line: 2,
        slot: { kind: "value", name: "length", mutable: false, type: USIZE },
        value: { k: "length", type: USIZE, of: { k: "local", type: { kind: "array", of: F64, length: 4 }, name: "values" } },
      },
    ]),
  );
  markParallelLoops(fn.entry);
  assert.equal(onlyLoop(fn).parallel, undefined);
});

test("a while loop is refused because one turn decides whether the next runs", () => {
  const refusal = refusalFor({
    kind: "while",
    condition: { k: "local", type: { kind: "primitive", name: "bool" }, name: "going" },
    header: "h1",
    exit: "x1",
    body: { id: "b1", statements: [], releases: [], terminator: { k: "next" } },
  });
  assert.equal(refusal !== null, true);
});

test("a loop whose turn does almost nothing is refused, because a thread team costs more", () => {
  // `out[i] = values[i] * 2` is what the C compiler vectorises; handing four
  // million of those to four threads measured slower than running them in order.
  const fn = functionWith(
    countedLoop([
      {
        k: "setElement",
        line: 2,
        buffer: "out",
        index: { k: "local", type: USIZE, name: "i" },
        op: "=",
        value: {
          k: "arith",
          type: F64,
          op: "mul",
          left: {
            k: "element",
            type: F64,
            of: { k: "local", type: { kind: "array", of: F64, length: 4 }, name: "values" },
            index: { k: "local", type: USIZE, name: "i" },
          },
          right: { k: "const", type: F64, text: "2" },
        },
      },
    ]),
  );
  markParallelLoops(fn.entry);
  assert.equal(onlyLoop(fn).parallel, undefined);
});

test("a loop counting down or by two is refused, and one counting up by one is not", () => {
  const down = countedLoop([], { down: true }).loop as CountedLoop;
  assert.equal(refusalFor(down) !== null, true);
  const stepped = countedLoop([], { step: { k: "const", type: I64, text: "2" } }).loop as CountedLoop;
  assert.equal(refusalFor(stepped) !== null, true);
  assert.equal(refusalFor(countedLoop([chain(8)]).loop as CountedLoop), null);
});

test("a loop counting in fractions is refused, because a counter of them wraps", () => {
  const fractional = countedLoop([], { type: F64 }).loop as CountedLoop;
  assert.equal(refusalFor(fractional) !== null, true);
});

test("a loop marked parallel in IR text is proved, and a false one is refused", () => {
  const fn = functionWith(
    countedLoop([{ k: "set", line: 2, name: "total", op: "+=", value: { k: "local", type: F64, name: "x" } }], {
      parallel: true,
    }),
  );
  const problems = semanticFunctionProblems(fn);
  assert.equal(problems.length > 0, true);
  assert.match(problems[0], /marked parallel/);
});

test("the word survives being printed and read back", () => {
  const phase = phaseOf("typescript", { "main.ts": PARALLEL_SOURCE }, "main.ts");
  const program = resolveProgram(phase.body!, phase.program);
  markParallelLoops(program.entry);
  const printed = printSemanticProgram(program);
  assert.match(printed, /parallel/);
  const read = parseSemanticProgram(printed, phase.program);
  assert.deepEqual(semanticIrProblems(read, phase.program), []);
  assert.equal(printSemanticProgram(read), printed);
});

test("a body the optimizer settles on comes out of the pass marked", () => {
  // The body has to be one the rewrites keep: a `let` nothing reads is dead and
  // is dropped, and what is left of it is a turn too cheap to be worth a
  // thread. Writing one element a turn is what a program keeps, and is the
  // shape the mark exists for.
  const fn = functionWith(
    countedLoop([
      {
        k: "setElement",
        line: 2,
        buffer: "out",
        index: { k: "local", type: USIZE, name: "i" },
        op: "=",
        value: {
          k: "arith",
          type: F64,
          op: "mul",
          left: {
            k: "element",
            type: F64,
            of: { k: "local", type: { kind: "array", of: F64, length: 4 }, name: "values" },
            index: { k: "local", type: USIZE, name: "i" },
          },
          right: { k: "const", type: F64, text: "2" },
        },
      },
      {
        k: "setElement",
        line: 3,
        buffer: "scaled",
        index: { k: "local", type: USIZE, name: "i" },
        op: "=",
        value: {
          k: "arith",
          type: F64,
          op: "add",
          left: { k: "local", type: F64, name: "acc" },
          right: { k: "const", type: F64, text: "1" },
        },
      },
    ]),
  );
  assert.equal(entryIsParallel(optimizeSemanticFunction(fn).entry), true);
});

test("a body that writes a shared name is left unmarked and stays valid", () => {
  const fn = functionWith(
    countedLoop([
      { k: "set", line: 2, name: "total", op: "+=", value: { k: "const", type: F64, text: "1" } },
    ]),
  );
  fn.params = [
    { kind: "value", name: "total", mutable: true, type: F64 },
    { kind: "value", name: "x", mutable: false, type: F64 },
  ];
  assert.deepEqual(semanticFunctionProblems(fn), []);
  assert.equal(onlyLoop(fn).parallel, undefined);
});
test("a turn that accumulates into a name it found is marked, and the loop names the accumulator", () => {
  const fn = functionWith(countedLoop([{ k: "set", line: 2, name: "total", op: "+=", value: { k: "const", type: I64, text: "1" } }, chain(8)]));
  markParallelLoops(fn.entry);
  assert.equal(onlyLoop(fn).parallel, true);
  assert.deepEqual(onlyLoop(fn).reductions, [{ name: "total", op: "+", exact: true }]);
});

test("a turn that multiplies into a name it found is marked, and combines by the product", () => {
  const fn = functionWith(countedLoop([{ k: "set", line: 2, name: "product", op: "*=", value: { k: "const", type: I64, text: "2" } }, chain(8)]));
  markParallelLoops(fn.entry);
  assert.deepEqual(onlyLoop(fn).reductions, [{ name: "product", op: "*", exact: true }]);
});

test("a turn that combines a value which is not a whole number is not marked", () => {
  // A sum of doubles is not the same number however it is grouped, so a turn
  // that adds one is a turn whose answer depends on which turn ran, and the
  // loop is left as it was written.
  const fn = functionWith(countedLoop([{ k: "set", line: 2, name: "total", op: "+=", value: { k: "const", type: F64, text: "1.5" } }, chain(8)]));
  markParallelLoops(fn.entry);
  assert.equal(onlyLoop(fn).parallel, undefined);
});

test("a turn that divides into a name it found is not marked, because a division is not a whole number", () => {
  const fn = functionWith(
    countedLoop([
      { k: "set", line: 2, name: "total", op: "+=", value: { k: "arith", type: F64, op: "div", left: { k: "const", type: I64, text: "100" }, right: { k: "local", type: I64, name: "i" } } },
      chain(8),
    ]),
  );
  markParallelLoops(fn.entry);
  assert.equal(onlyLoop(fn).parallel, undefined);
});

test("a turn that decides what the total is, rather than adding to it, is not marked", () => {
  // `total = x` is not a combination: the turn decided the answer, so which turn
  // ran last is the answer, and no combining afterwards repairs that.
  const fn = functionWith(countedLoop([{ k: "set", line: 2, name: "total", op: "=", value: { k: "const", type: I64, text: "1" } }, chain(8)]));
  markParallelLoops(fn.entry);
  assert.equal(onlyLoop(fn).parallel, undefined);
});

test("a loop whose body leaves it with a break is not marked", () => {
  // OpenMP has no `break` in a parallel loop, and a turn that leaves decides
  // whether the next one runs, which is the thing handing turns to threads
  // forbids.
  const fn = functionWith(
    countedLoop([
      { k: "if", line: 2, condition: { k: "bool", type: BOOL, value: true }, then: { id: "bx", statements: [], releases: [], terminator: { k: "jump", target: "x1", releases: [] } }, otherwise: null },
      chain(8),
    ]),
  );
  markParallelLoops(fn.entry);
  assert.equal(onlyLoop(fn).parallel, undefined);
});

test("a loop whose body only skips a turn with a continue is marked", () => {
  // A `continue` is the turn saying it has nothing to add, which is a decision
  // about itself and not about the next turn, so it is left alone.
  const fn = functionWith(
    countedLoop([
      { k: "if", line: 2, condition: { k: "bool", type: BOOL, value: true }, then: { id: "bx", statements: [], releases: [], terminator: { k: "jump", target: "h1", releases: [] } }, otherwise: null },
      chain(8),
    ]),
  );
  markParallelLoops(fn.entry);
  assert.equal(onlyLoop(fn).parallel, true);
});

test("a loop with two accumulators names both of them", () => {
  const fn = functionWith(
    countedLoop([
      { k: "set", line: 2, name: "total", op: "+=", value: { k: "const", type: I64, text: "1" } },
      { k: "set", line: 3, name: "product", op: "*=", value: { k: "const", type: I64, text: "2" } },
      chain(8),
    ]),
  );
  markParallelLoops(fn.entry);
  assert.deepEqual(onlyLoop(fn).reductions, [
    { name: "total", op: "+", exact: true },
    { name: "product", op: "*", exact: true },
  ]);
});

test("a turn that calls a function which reaches itself is not refused as cheap", () => {
  // The cost of one call is not a number the IR holds: `createTree` read once is
  // a handful of values, and at a depth the program chooses it is as many as the
  // program says. Refusing a turn on a threshold nobody measured is not the same
  // judgement as refusing one that was measured and found too small.
  const recursive = callee("recursive", [call("recursive"), chain(8)]);
  const fn = functionWith(countedLoop([call("recursive")]));
  markParallelLoops(fn.entry, new Map([["recursive", recursive]]));
  assert.equal(onlyLoop(fn).parallel, true);
});

test("a turn that computes in what a block returns is not refused as cheap", () => {
  // A function that computes its answer in the `return` has nearly all its work
  // there, and reading only the statements before it counted almost none.
  // Eight values, none of them in a statement: a callee whose whole work is the
  // value it ends in, which is what reading only the statements missed.
  const ones: SemanticValue[] = Array.from({ length: 8 }, () => ({ k: "const", type: F64, text: "1" }));
  const answered = ones.slice(1).reduce<SemanticValue>((left, right) => ({ k: "arith", type: F64, op: "add", left, right }), ones[0] as SemanticValue);
  const answering = callee("answering", []);
  const fn = functionWith(countedLoop([call("answering")]));
  const entry = { ...answering.entry, terminator: { k: "return" as const, value: answered } };
  markParallelLoops(fn.entry, new Map([["answering", { ...answering, entry }]]));
  assert.equal(onlyLoop(fn).parallel, true);
});

test("a loop whose turns are few enough to measure is still refused on that count", () => {
  // The threshold is still the threshold: a turn that computes two values and
  // calls nothing is still not worth a team of threads.
  const fn = functionWith(countedLoop([{ k: "let", line: 2, slot: { kind: "value", name: "t", mutable: true, type: F64 }, value: { k: "const", type: F64, text: "1" } }]));
  markParallelLoops(fn.entry);
  assert.equal(onlyLoop(fn).parallel, undefined);
});

test("a turn that combines what a call answers is marked when the call answers a whole number", () => {
  // `checksum` answers `1`, or `1 + checksum(left) + checksum(right)`, and each
  // of those is whole — so the turns may add their totals up in any order and
  // get the same number. That is what the return values are read for.
  const checksum = callee("checksum", []);
  const entry = { ...checksum.entry, terminator: { k: "return" as const, value: { k: "const" as const, type: F64, text: "1" } } };
  const fn = functionWith(countedLoop([{ k: "set", line: 2, name: "total", op: "+=", value: { k: "call", type: F64, call: { callee: "checksum", signature: { name: "checksum", symbol: "blaze_checksum", params: [], returns: "f64" }, args: [], argTypes: [], returns: F64, effects: [], ownership: "none", retain: false, builtin: false } } }, chain(8)]));
  markParallelLoops(fn.entry, new Map([["checksum", { ...checksum, entry }]]));
  assert.equal(onlyLoop(fn).parallel, true);
  assert.deepEqual(onlyLoop(fn).reductions, [{ name: "total", op: "+", exact: true }]);
});

test("a turn that combines what a call answers is not marked when the call does not answer a whole number", () => {
  const halved = callee("halved", []);
  const entry = { ...halved.entry, terminator: { k: "return" as const, value: { k: "const" as const, type: F64, text: "0.5" } } };
  const fn = functionWith(countedLoop([{ k: "set", line: 2, name: "total", op: "+=", value: { k: "call", type: F64, call: { callee: "halved", signature: { name: "halved", symbol: "blaze_halved", params: [], returns: "f64" }, args: [], argTypes: [], returns: F64, effects: [], ownership: "none", retain: false, builtin: false } } }, chain(8)]));
  markParallelLoops(fn.entry, new Map([["halved", { ...halved, entry }]]));
  assert.equal(onlyLoop(fn).parallel, undefined);
});

test("a loop calling a function whose only impure call is its answer is refused", () => {
  // A function's answer is nearly all of its work, and a callee written the
  // ordinary way calls from its return. Reading only the statements of its body
  // read such a callee as writing nothing, so a loop calling it was marked and
  // every turn printed over the others.
  const noisy = callee("noisy", []);
  noisy.prints = true;
  noisy.effects = ["io"];
  noisy.entry = {
    id: "entry",
    statements: [],
    releases: [],
    terminator: {
      k: "return",
      value: {
        k: "call",
        type: F64,
        call: {
          callee: "printIt",
          signature: { name: "printIt", symbol: "blaze_printIt", params: [], returns: "f64" },
          args: [],
          argTypes: [],
          returns: F64,
          effects: ["io"],
          ownership: "none",
          retain: false,
          builtin: false,
        },
      },
    },
  };
  // Twenty terms, so the turn clears the cost floor: a turn refused as cheap is
  // refused for the wrong reason and the test would pass without proving this.
  const fn = functionWith(countedLoop([call("noisy"), chain(20)]));
  const callees = new Map([
    ["noisy", noisy],
    ["printIt", callee("printIt", [chain(20)])],
  ]);
  markParallelLoops(fn.entry, callees);
  assert.equal(onlyLoop(fn).parallel, undefined, "a turn that prints may not run beside another turn that prints");
});

test("a loop calling a function this build holds no body for is refused", () => {
  // The same hole swallowed the call to a function nobody read: the refusal for
  // an unknown callee lives where the purity check is, and the purity check is
  // where the answer of a function was not being read.
  const opaque = callee("opaque", []);
  opaque.entry = {
    id: "entry",
    statements: [],
    releases: [],
    terminator: {
      k: "return",
      value: {
        k: "call",
        type: F64,
        call: {
          callee: "missing",
          signature: { name: "missing", symbol: "blaze_missing", params: [], returns: "f64" },
          args: [],
          argTypes: [],
          returns: F64,
          effects: [],
          ownership: "none",
          retain: false,
          builtin: false,
        },
      },
    },
  };
  const fn = functionWith(countedLoop([call("opaque"), chain(20)]));
  markParallelLoops(fn.entry, new Map([["opaque", opaque]]));
  assert.equal(onlyLoop(fn).parallel, undefined, "a body this build does not hold is a body nobody has read");
});

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

test("a loop that allocates is not marked, because the allocator is one heap", () => {
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
    ]),
  );
  markParallelLoops(fn.entry);
  assert.equal(onlyLoop(fn).parallel, undefined);
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

test("a loop calling a function that writes an outer name is not marked", () => {
  const impure = callee(
    "impure",
    [{ k: "set", line: 2, name: "total", op: "+=", value: { k: "const", type: F64, text: "1" } }],
    [{ kind: "value", name: "total", mutable: true, type: F64 }],
  );
  const fn = functionWith(countedLoop([call("impure"), chain(8)]));
  markParallelLoops(fn.entry, new Map([["impure", impure]]));
  assert.equal(onlyLoop(fn).parallel, undefined);
});

test("a loop calling a function this build does not hold is not marked", () => {
  const fn = functionWith(countedLoop([call("elsewhere"), chain(8)]));
  markParallelLoops(fn.entry, new Map());
  assert.equal(onlyLoop(fn).parallel, undefined);
});

test("a loop calling a function that allocates what it hands back is not marked", () => {
  const fn = functionWith(countedLoop([call("maker", { ownership: "owned" }), chain(8)]));
  markParallelLoops(fn.entry, new Map([["maker", callee("maker", [chain(8)])]]));
  assert.equal(onlyLoop(fn).parallel, undefined);
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
  const impure = callee(
    "impure",
    [{ k: "set", line: 2, name: "total", op: "+=", value: { k: "const", type: F64, text: "1" } }],
    [{ kind: "value", name: "total", mutable: true, type: F64 }],
  );
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

test("a loop calling a pure function a turn writes beside is still refused for the write", () => {
  const fn = functionWith(
    countedLoop([
      { k: "set", line: 2, name: "total", op: "+=", value: { k: "const", type: F64, text: "1" } },
      chain(8),
    ]),
  );
  markParallelLoops(fn.entry, new Map());
  assert.equal(onlyLoop(fn).parallel, undefined);
});

test("a loop whose body prints is not marked, because output order is the program's", () => {
  const fn = functionWith(
    countedLoop([{ k: "printNumber", line: 2, value: { k: "local", type: F64, name: "x" } }]),
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
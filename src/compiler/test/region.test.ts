import assert from "node:assert/strict";
import test from "node:test";

import { markRegionLoops, refusalFor } from "../semantics/region.ts";
import { semanticFunctionProblems } from "../semantics/ir-validate.ts";
import type { TypeExpr } from "../core/types.ts";
import type {
  SemanticFunction,
  SemanticLoop,
  SemanticStatement,
  SemanticValue,
} from "../core/semantic-ir.ts";

const F64: TypeExpr = { kind: "primitive", name: "f64" };
const I64: TypeExpr = { kind: "primitive", name: "i64" };
const REF: TypeExpr = { kind: "ref", of: F64 };

type CountedLoop = Extract<SemanticLoop, { kind: "counted" }>;
type LoopStatement = Extract<SemanticStatement, { k: "loop" }>;

/** An object built by a turn: the block the reuse is about. */
function node(): SemanticValue {
  return { k: "newObject", type: REF, layout: "Node", fields: [] };
}

/** Binding a value to a name the turn declares, at the type the value is. */
function bind(name: string, value: SemanticValue): Extract<SemanticStatement, { k: "let" }> {
  return { k: "let", line: 2, slot: { kind: "value", name, mutable: false, type: value.type }, value };
}

/** Writing a value into a name the turn found rather than declared. */
function writeOuter(value: SemanticValue): Extract<SemanticStatement, { k: "set" }> {
  return { k: "set", line: 2, name: "acc", op: "=", value };
}

function countedLoop(body: readonly SemanticStatement[]): LoopStatement {
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
    objects: {
      Node: { name: "Node", size: 8, align: 8, fields: [{ name: "inner", type: "ref<any>", offset: 0 }] },
    },
    calls: [],
    entry: { id: "entry", statements: [loop], releases: [], terminator: { k: "return", value: null } },
  };
}

function onlyLoop(fn: SemanticFunction): CountedLoop {
  const statement = fn.entry.statements[0];
  assert.equal(statement?.k, "loop");
  const loop = (statement as LoopStatement).loop;
  assert.equal(loop.kind, "counted");
  return loop as CountedLoop;
}

/** A callee that reads what it is given and hands back a number. */
function reader(name: string, param = "node"): SemanticFunction {
  return {
    name,
    symbol: `blaze_${name}`,
    params: [{ kind: "value", name: param, mutable: false, type: REF }],
    returns: F64,
    requires: [],
    ensures: [],
    effects: [],
    allocates: false,
    prints: false,
    readsArgv: false,
    objects: {
      Node: { name: "Node", size: 8, align: 8, fields: [{ name: "inner", type: "ref<any>", offset: 0 }] },
    },
    calls: [],
    entry: {
      id: "entry",
      statements: [],
      releases: [],
      terminator: { k: "return", value: { k: "const", type: F64, text: "1" } },
    },
  };
}

/** A call of the function named. */
function callValue(callee: string, args: readonly SemanticValue[] = []): SemanticValue {
  return {
    k: "call",
    type: F64,
    call: {
      callee,
      signature: { name: callee, symbol: `blaze_${callee}`, params: [], returns: "f64" },
      args: [...args],
      argTypes: [],
      returns: F64,
      effects: [],
      ownership: "none",
      retain: false,
      builtin: false,
    },
  };
}

test("a turn that builds a value and binds it to its own name may reuse the storage", () => {
  const fn = functionWith(countedLoop([bind("tree", node())]));
  markRegionLoops(fn.entry);
  assert.equal(onlyLoop(fn).region, true);
});

test("a turn that writes what it built into a name that outlives it may not", () => {
  // This is the one that matters: the next turn rewinds over the block, and the
  // name outliving it is still holding it.
  const fn = functionWith(countedLoop([bind("tree", node()), writeOuter({ k: "local", type: REF, name: "tree" })]));
  markRegionLoops(fn.entry);
  assert.equal(onlyLoop(fn).region, undefined);
});

test("a turn that hands what it built to a function that only reads it may", () => {
  // `checksum` walks a tree and hands back a number, so the tree is still the
  // turn's afterwards — which is the shape binarytrees is.
  const checksum = reader("checksum");
  const fn = functionWith(countedLoop([bind("tree", node()), bind("sum", callValue("checksum", [{ k: "local", type: REF, name: "tree" }]))]));
  markRegionLoops(fn.entry, new Map([["checksum", checksum]]));
  assert.equal(onlyLoop(fn).region, true);
});

test("a turn that hands what it built to a reader whose answer is computed from it may", () => {
  // The real `checksum`, not a stub of it: its answer is `1 + walk(left) +
  // walk(right)`, so a walk of that value reaches the node it was given through
  // a `loadField` on each side. Reading the tree is what the turn wants to do,
  // and it is not the same as keeping it — the answer is a number, and a number
  // carries no block out of the turn.
  const checksum = reader("checksum");
  const field = (name: string): SemanticValue => ({
    k: "loadField",
    type: REF,
    object: { k: "local", type: REF, name: "node" },
    layout: "Node",
    field: name,
  });
  const one: SemanticValue = { k: "const", type: F64, text: "1" };
  checksum.entry.terminator = {
    k: "return",
    value: { k: "arith", type: F64, op: "add", left: one, right: { k: "arith", type: F64, op: "add", left: callValue("checksum", [field("inner")]), right: callValue("checksum", [field("inner")]) } },
  };
  const fn = functionWith(countedLoop([bind("tree", node()), bind("sum", callValue("checksum", [{ k: "local", type: REF, name: "tree" }]))]));
  markRegionLoops(fn.entry, new Map([["checksum", checksum]]));
  assert.equal(onlyLoop(fn).region, true);
});

test("a turn whose answer is read out of what it built may", () => {
  // `sum += checksum(tree)` reaches `tree` through both of the calls `checksum`
  // makes with it, and stores a number. Only a reference can put a block
  // anywhere, so a store of a number is not an escape whatever the value was
  // computed from.
  const checksum = reader("checksum");
  const fn = functionWith(countedLoop([
    bind("tree", node()),
    { k: "set", line: 2, name: "acc", op: "+=", value: callValue("checksum", [{ k: "local", type: REF, name: "tree" }]) },
  ]));
  markRegionLoops(fn.entry, new Map([["checksum", checksum]]));
  assert.equal(onlyLoop(fn).region, true);
});

test("a turn that hands back a reference it read out of what it was given may not", () => {
  // The other side of the same gate: an answer that *is* a reference, taken
  // from the object the caller owns. The turn's storage is in that answer, so
  // the next turn's rewind would write over a block somebody still holds.
  const field = reader("firstChild");
  field.entry.terminator = {
    k: "return",
    value: { k: "loadField", type: REF, object: { k: "local", type: REF, name: "node" }, layout: "Node", field: "inner" },
  };
  const fn = functionWith(countedLoop([bind("tree", node()), bind("kept", callValue("firstChild", [{ k: "local", type: REF, name: "tree" }]))]));
  markRegionLoops(fn.entry, new Map([["firstChild", field]]));
  assert.equal(onlyLoop(fn).region, undefined);
});

test("a turn that hands what it built to a function that keeps it may not", () => {
  // The callee writes what it was given into a name it found, which is
  // somewhere the caller can still be holding the block.
  const keeper = reader("keeper");
  keeper.entry = {
    id: "entry",
    statements: [{ k: "set", line: 1, name: "held", op: "=", value: { k: "local", type: REF, name: "node" } }],
    releases: [],
    terminator: { k: "return", value: null },
  };
  const fn = functionWith(countedLoop([bind("tree", node()), bind("sum", callValue("keeper", [{ k: "local", type: REF, name: "tree" }]))]));
  markRegionLoops(fn.entry, new Map([["keeper", keeper]]));
  assert.equal(onlyLoop(fn).region, undefined);
});

test("a turn that hands what it built to a function this build does not hold may not", () => {
  // A body nobody has read is a body that might keep anything.
  const fn = functionWith(countedLoop([bind("tree", node()), bind("sum", callValue("unknown", [{ k: "local", type: REF, name: "tree" }]))]));
  markRegionLoops(fn.entry);
  assert.equal(onlyLoop(fn).region, undefined);
});

test("a turn that counts what it built may not", () => {
  // A count outlives the storage it counts, and the count is not something a
  // rewind can take back.
  const fn = functionWith(countedLoop([bind("tree", node()), { k: "retain", line: 2, value: { k: "local", type: REF, name: "tree" } }]));
  markRegionLoops(fn.entry);
  assert.equal(onlyLoop(fn).region, undefined);
});

test("a turn that stores what it built into a field of its own object may", () => {
  const object = node();
  const fn = functionWith(countedLoop([
    bind("outer", object),
    { k: "storeField", line: 2, object: { k: "local", type: REF, name: "outer" }, layout: "Node", field: "inner", value: node() },
  ]));
  markRegionLoops(fn.entry);
  assert.equal(onlyLoop(fn).region, true);
});

test("a turn that stores what it built into an object it did not build may not", () => {
  const fn = functionWith(countedLoop([
    bind("inner", node()),
    { k: "storeField", line: 2, object: { k: "local", type: REF, name: "acc" }, layout: "Node", field: "inner", value: { k: "local", type: REF, name: "inner" } },
  ]));
  markRegionLoops(fn.entry);
  assert.equal(onlyLoop(fn).region, undefined);
});

test("a turn that builds nothing is left unmarked", () => {
  // There is no cursor to rewind, so the mark would cost the two calls that
  // open and close a region on every turn and buy nothing.
  const fn = functionWith(countedLoop([bind("sum", { k: "const", type: F64, text: "1" })]));
  markRegionLoops(fn.entry);
  assert.equal(onlyLoop(fn).region, undefined);
});

test("a turn that calls a function this build does not hold is marked", () => {
  // A body nobody has read is a body that may allocate, so the mark stays: it
  // costs two calls and it is what keeps the memory a region saves.
  const fn = functionWith(countedLoop([bind("sum", callValue("unknown"))]));
  markRegionLoops(fn.entry);
  assert.equal(onlyLoop(fn).region, true);
});

test("a loop inside a marked loop is left to take its storage fresh", () => {
  // A rewind takes everything the region has handed out, so a rewind inside a
  // loop that is itself in one would write over what the outer turn took before
  // the inner loop began. The loop the blocks are built in is the one marked.
  const inner = countedLoop([bind("tree", node())]);
  const outer: LoopStatement = {
    k: "loop",
    line: 1,
    loop: {
      kind: "counted",
      variable: "j",
      type: I64,
      from: { k: "const", type: I64, text: "0" },
      to: { k: "const", type: I64, text: "100" },
      inclusive: false,
      down: false,
      step: null,
      header: "h0",
      exit: "x0",
      body: { id: "b0", statements: [bind("keep", node()), inner], releases: [], terminator: { k: "next" } },
    },
  };
  const fn = functionWith(outer);
  markRegionLoops(fn.entry);
  const marked = onlyLoop(fn);
  assert.equal(marked.region, undefined);
  const nested = marked.body.statements[1] as LoopStatement;
  assert.equal(nested.k, "loop");
  assert.equal((nested.loop as CountedLoop).region, true);
});

test("a loop that may run any number of times may not", () => {
  const fn = functionWith(countedLoop([bind("tree", node())]));
  const loop = onlyLoop(fn);
  const whileLoop: SemanticLoop = {
    kind: "while",
    condition: { k: "const", type: F64, text: "1" },
    header: "h1",
    exit: "x1",
    body: loop.body,
  };
  assert.notEqual(refusalFor(whileLoop), null);
});
test("a loop marked region in IR text is proved, and a false one is refused", () => {
  // A mark written by hand or by a model is a claim that everything a turn
  // allocates is dead by the end of that turn. It is proved here rather than
  // believed: a wrong one rewinds storage a value that is still wanted sits on.
  const fn = functionWith(countedLoop([bind("tree", node()), writeOuter({ k: "local", type: REF, name: "tree" })]));
  onlyLoop(fn).region = true;
  const problems = semanticFunctionProblems(fn);
  assert.equal(problems.length > 0, true);
  assert.match(problems[0], /marked region/);
});

test("a loop marked region in IR text is accepted when it is true", () => {
  const fn = functionWith(countedLoop([bind("tree", node())]));
  onlyLoop(fn).region = true;
  assert.deepEqual(semanticFunctionProblems(fn), []);
});

/** A factory written the ordinary way: the block it builds is its answer. */
function factory(name: string): SemanticFunction {
  return {
    name,
    symbol: `blaze_${name}`,
    params: [],
    returns: REF,
    requires: [],
    ensures: [],
    effects: [],
    allocates: true,
    prints: false,
    readsArgv: false,
    objects: {
      Node: { name: "Node", size: 8, align: 8, fields: [{ name: "inner", type: "ref<any>", offset: 0 }] },
    },
    calls: [],
    entry: {
      id: "entry",
      statements: [],
      releases: [],
      terminator: { k: "return", value: node() },
    },
  };
}

test("a block a callee builds in its answer is the turn's block", () => {
  // A factory builds its object in the value it returns, which is where a
  // factory written the ordinary way puts it. Reading only the statements of its
  // body read every factory as building nothing, so the turn below kept its block
  // in a name that outlived it — and the rewind wrote over it.
  const make = factory("makeNode");
  const fn = functionWith(
    countedLoop([
      { k: "let", line: 1, slot: { kind: "value", name: "tree", mutable: true, type: REF }, value: callValue("makeNode") },
      writeOuter({ k: "local", type: REF, name: "tree" }),
    ]),
  );
  markRegionLoops(fn.entry, new Map([["makeNode", make]]));
  assert.equal(onlyLoop(fn).region, undefined, "the block escapes the turn, so the turn may not reuse the storage");
});

test("a block a callee builds through another callee is the turn's block", () => {
  // The same question one call deeper: a factory that delegates builds just as
  // much as one that builds. Reading only the callee's own statements read a
  // delegating factory as building nothing.
  const make = factory("makeNode");
  const wrap = factory("build");
  wrap.entry = { ...wrap.entry, terminator: { k: "return", value: callValue("makeNode") } };
  const fn = functionWith(
    countedLoop([
      { k: "let", line: 1, slot: { kind: "value", name: "tree", mutable: true, type: REF }, value: callValue("build") },
      writeOuter({ k: "local", type: REF, name: "tree" }),
    ]),
  );
  markRegionLoops(fn.entry, new Map([["makeNode", make], ["build", wrap]]));
  assert.equal(onlyLoop(fn).region, undefined, "the block escapes the turn through two calls");
});

test("an array written in a turn is as much the turn's as an object is", () => {
  // The runtime takes every block from the region's cursor while a region is
  // open, so an array literal written in a turn is the turn's block too. Read as
  // a window into a block another name holds it is not, which is the one case
  // that is genuinely not a block of its own.
  const row: SemanticValue = {
    k: "buffer",
    type: { kind: "slice", of: F64 },
    element: F64,
    length: 2,
    count: null,
    view: null,
    values: [{ k: "const", type: F64, text: "1" }, { k: "const", type: F64, text: "2" }],
  };
  const fn = functionWith(
    countedLoop([
      { k: "let", line: 1, slot: { kind: "value", name: "row", mutable: true, type: { kind: "slice", of: F64 } }, value: row },
      writeOuter({ k: "local", type: { kind: "slice", of: F64 }, name: "row" }),
    ]),
  );
  markRegionLoops(fn.entry);
  assert.equal(onlyLoop(fn).region, undefined, "the array escapes the turn, so the turn may not reuse the storage");
});

test("two marked region loops on one path are refused", () => {
  // The runtime keeps one cursor and rewinds it on entry rather than pushing, so
  // the inner turn is handed the base block the outer turn is still filling.
  // Each mark is proved on its own, which cannot see the pair.
  const inner = countedLoop([bind("leaf", node())]);
  const innerLoop = inner.loop as CountedLoop;
  // Distinct block ids: the validator refuses two blocks sharing one before it
  // ever reaches the marks.
  innerLoop.header = "h2";
  innerLoop.exit = "x2";
  innerLoop.body.id = "b2";
  innerLoop.region = true;
  const outer = countedLoop([bind("tree", node()), inner]);
  (outer.loop as CountedLoop).region = true;
  const fn = functionWith(outer);
  const problems = semanticFunctionProblems(fn);
  assert.ok(
    problems.some((problem) => /is marked region around a loop that is also marked region/.test(problem)),
    `nested region marks must be refused: ${JSON.stringify(problems)}`,
  );
});

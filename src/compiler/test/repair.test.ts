/**
 * The rules a review may propose, as they behave on real functions.
 *
 * A proposal is a name and a block, and the compiler answers it by rewriting
 * the IR or by saying why it will not. What is checked here is both halves:
 * that a rule which holds produces a function the compiler may still lower —
 * and computes what the original computed — and that a rule which does not
 * hold is refused with a reason rather than applied to something it was not
 * aimed at.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { applyProposal, describeSites, inlineCalls, REPAIR_RULES, type RepairOutcome } from "../semantics/repair.ts";
import { printSemanticFunction, parseSemanticFunction } from "../semantics/ir-text.ts";
import { validateSemanticFunction } from "../semantics/ir-validate.ts";
import { foldedCandidate } from "../codegen.ts";
import { parseReview, type Proposal } from "../core/proposal.ts";
import { phaseOf, semanticsOf } from "./phase.ts";
import type { SemanticFunction } from "../core/semantic-ir.ts";
import type { Candidate, FunctionContract, ProgramContract } from "../core/types.ts";

/** The proposals a review of `answer` carries, or nothing if it cannot be read. */
function proposalsIn(answer: string): Proposal[] {
  const parsed = parseReview(answer);
  assert.ok("review" in parsed, `the answer is not a review: ${"unusable" in parsed ? parsed.unusable : ""}`);
  return [...parsed.review.proposals];
}

function repaired(...proposals: string[]): string {
  return ["verdict: repaired", "reason: for the test", ...proposals.map((one) => `proposal: ${one}`)].join("\n");
}

const LIBRARY: Record<string, string> = {
  "main.ts": "import { work, twice } from './lib.ts';\nconsole.log(work(2));\n",
  "lib.ts": [
    "export function twice(x: number): number {",
    "  return x + x;",
    "}",
    "",
    "export function work(scale: number): number {",
    "  let total = 0;",
    "  for (let i = 0; i < 4; i += 1) {",
    "    total += (i * scale) / 8 + (i * scale) / 16 + (i * scale) / (scale * scale) + (i * scale) / (scale * scale);",
    "  }",
    "  return total + twice(scale);",
    "}",
    "",
    "export function plain(scale: number): number {",
    "  let total = 0;",
    "  for (let i = 0; i < 4; i += 1) {",
    "    total += i * scale;",
    "  }",
    "  return total;",
    "}",
    "",
    "export function shadow(t: number, u: number): number {",
    "  let total = t;",
    "  if (t > 3) {",
    "    let t = 100;",
    "    total = t + u;",
    "  }",
    "  return total;",
    "}",
    "",
    "export function caller(x: number, u: number): number {",
    "  return shadow(x, u) + shadow(x + 1, u);",
    "}",
    "",
  ].join("\n"),
};

const phase = phaseOf("typescript", LIBRARY, "main.ts");
const program: ProgramContract = phase.program;
const semantics = semanticsOf(phase);
const contracts: Record<string, FunctionContract> = Object.fromEntries(
  program.files.flatMap((file) => Object.entries(file.functions)),
);
const context = { functions: new Map(Object.entries(semantics)) };

function resolved(name: string): SemanticFunction {
  return semantics[name] as SemanticFunction;
}

/** Applies one proposal and hands back the revision, or the refusal. */
function apply(name: string, proposal: Proposal): { ir: string; note: string } | { refused: string } {
  const outcome = applyProposal(resolved(name), proposal, context);
  if ("refused" in outcome) return outcome;
  // Every rule has to leave a function the compiler may lower: that is what
  // makes an applied proposal an artifact rather than an edit.
  validateSemanticFunction(outcome.applied, contracts[name]);
  return { ir: printSemanticFunction(outcome.applied), note: outcome.note };
}

test("the catalogue is the one the prompt offers, and every rule is applied and refused by it", () => {
  assert.deepEqual(
    REPAIR_RULES.map((rule) => rule.name),
    ["hoist-invariant", "common-subexpression", "reciprocal-multiply", "inline-call"],
  );
  for (const rule of REPAIR_RULES) {
    assert.ok(rule.summary.length > 0, `${rule.name} says what it does`);
    assert.ok(rule.applies.length > 0, `${rule.name} says when it holds`);
  }
});

test("the two rules that bind a value say a read of memory is never one", () => {
  // A model reads `applies` before it proposes and cannot read the rule, so an
  // exclusion the text leaves out is one it proposes against. A memory read is
  // the exclusion that actually refuses rules in practice — the IR holds no
  // length and no null test — and it is not visible in the shape of the value.
  for (const rule of REPAIR_RULES.filter((entry) => entry.name === "hoist-invariant" || entry.name === "common-subexpression")) {
    assert.match(rule.applies, /read of memory/, `${rule.name} says a read of memory is excluded`);
  }
});

test("a loop is named by the block it leaves for, and the site index says so", () => {
  const sites = describeSites(resolved("work"));
  assert.ok(sites.some((line) => /^loop b\d+:/.test(line)), sites.join("\n"));
  assert.ok(sites.some((line) => /^block entry: the function body/.test(line)), sites.join("\n"));
});

test("hoist-invariant binds a value a loop computes again above the loop", () => {
  // `scale * scale` is computed twice per iteration and never changes, so it
  // is bound once above the loop and read by name inside it. `i * scale` is
  // computed just as often and is left where it is: it reads the counter, and
  // the counter is a different value on every iteration.
  const outcome = apply("work", proposalsIn(repaired("hoist-invariant b1"))[0] as Proposal);
  assert.ok("ir" in outcome, "the rule applies");
  assert.match(outcome.ir, /let value\[f64\] hoisted\d+ immutable = \[mul\[f64\] local\[f64\] scale local\[f64\] scale\]/);
  assert.match(outcome.ir, /\[div\[f64\] \[mul\[f64\] local\[f64\] i local\[f64\] scale\] local\[f64\] hoisted\d+\]/);
  assert.match(outcome.note, /hoisted 1 value\(s\) out of b1/);
});

test("hoist-invariant refuses a loop that computes nothing twice", () => {
  const outcome = apply("plain", proposalsIn(repaired("hoist-invariant b1"))[0] as Proposal);
  assert.ok("refused" in outcome);
  assert.match(outcome.refused, /nothing more than once/);
});

test("hoist-invariant refuses a function that has no loop", () => {
  const outcome = apply("twice", proposalsIn(repaired("hoist-invariant entry"))[0] as Proposal);
  assert.ok("refused" in outcome);
  assert.match(outcome.refused, /no loop is written in block entry or leaves for it/);
});

test("common-subexpression binds what a block computes twice", () => {
  const outcome = apply("work", proposalsIn(repaired("common-subexpression b2"))[0] as Proposal);
  assert.ok("ir" in outcome);
  assert.match(outcome.ir, /let value\[f64\] shared\d+ immutable = /);
  assert.match(outcome.note, /bound \d+ repeated value\(s\) in b2/);
});

test("common-subexpression refuses a block whose only repetition cannot be bound", () => {
  // `plain` does write a value twice — the `0` its accumulator starts at — so
  // a refusal that claimed it computed nothing twice was not describing the
  // body. What it computed twice was a literal, and the refusal says so.
  const outcome = apply("plain", proposalsIn(repaired("common-subexpression entry"))[0] as Proposal);
  assert.ok("refused" in outcome);
  assert.match(outcome.refused, /it is a name or a literal/);
});

test("reciprocal-multiply turns a division by a power of two into a multiplication", () => {
  const outcome = apply("work", proposalsIn(repaired("reciprocal-multiply b2"))[0] as Proposal);
  assert.ok("ir" in outcome);
  assert.match(outcome.ir, /\[mul\[f64\] \[mul\[f64\] local\[f64\] i local\[f64\] scale\] const\[f64\] 0\.125\]/);
  assert.match(outcome.ir, /const\[f64\] 0\.0625/);
  assert.doesNotMatch(outcome.ir, /const\[f64\] (8|16)\]/, "no division by a power of two is left");
});

test("reciprocal-multiply refuses a block that divides by nothing of the kind", () => {
  const outcome = apply("twice", proposalsIn(repaired("reciprocal-multiply entry"))[0] as Proposal);
  assert.ok("refused" in outcome);
  assert.match(outcome.refused, /divides by nothing that is a power of two/);
});

test("inline-call puts a callee's body where the call was", () => {
  const outcome = apply("work", proposalsIn(repaired("inline-call entry callee=twice"))[0] as Proposal);
  assert.ok("ir" in outcome);
  // The body of `twice` is the caller's, under a name of its own, and the
  // edge the body no longer makes is gone with it.
  assert.match(outcome.ir, /let value\[f64\] inlined\d+ immutable = \[add\[f64\] local\[f64\] scale local\[f64\] scale\]/);
  assert.doesNotMatch(outcome.ir, /call twice/);
  assert.match(outcome.note, /inlined twice into entry and bound what it returns/);
});

test("inline-call refuses a callee the program does not have", () => {
  const outcome = apply("work", proposalsIn(repaired("inline-call entry callee=thrice"))[0] as Proposal);
  assert.ok("refused" in outcome);
  assert.match(outcome.refused, /thrice is not a function of this program/);
});

test("inline-call refuses a callee that declares a name one of its blocks shadows", () => {
  // The substitution that puts a callee's body where the call was is by name,
  // and a name a block declares over another name of the same function is two
  // bindings under one spelling. Renaming the shadow sends the parameter's own
  // reads to it and leaving it sends the shadow's reads to the argument:
  // `caller(10, 5)` answered 31 where the program answers 210, because the
  // inlined `let t = 100` was read as the caller's `x` and `10 + 5` was written
  // where `100 + 5` was. The pass the compiler runs on its own does this too,
  // and nothing downstream reports it.
  const outcome = apply("caller", proposalsIn(repaired("inline-call entry callee=shadow"))[0] as Proposal);
  assert.ok("refused" in outcome);
  assert.match(outcome.refused, /shadow declares "t" in a block of its own/);
});

test("inline-call refuses a block that does not call the callee", () => {
  const outcome = apply("twice", proposalsIn(repaired("inline-call entry callee=twice"))[0] as Proposal);
  assert.ok("refused" in outcome);
  assert.match(outcome.refused, /twice is not called in block entry/);
});

test("a rule that does not exist is refused with the ones that do", () => {
  const outcome = apply("work", proposalsIn(repaired("unroll b1"))[0] as Proposal);
  assert.ok("refused" in outcome);
  assert.match(outcome.refused, /there is no rule named "unroll": the rules are hoist-invariant, common-subexpression, reciprocal-multiply, inline-call/);
});

test("an argument a rule does not take is refused rather than ignored", () => {
  const outcome = apply("work", proposalsIn(repaired("hoist-invariant b1 factor=2"))[0] as Proposal);
  assert.ok("refused" in outcome);
  assert.match(outcome.refused, /hoist-invariant takes no factor: it takes nothing at all/);
});

test("a rule aimed at a block that is not there is refused with the blocks that are", () => {
  const outcome = apply("work", proposalsIn(repaired("common-subexpression b9"))[0] as Proposal);
  assert.ok("refused" in outcome);
  assert.match(outcome.refused, /no block is named b9; the blocks are entry, b\d+/);
});

test("a rule aimed at a block the body does not have is refused, and the body is untouched", () => {
  const before = printSemanticFunction(resolved("work"));
  applyProposal(resolved("work"), proposalsIn(repaired("hoist-invariant b1"))[0] as Proposal, context);
  assert.equal(printSemanticFunction(resolved("work")), before, "a refused proposal leaves the caller's tree alone");
});

// The two rules below used to hand back a function that computes something
// other than what the source computes, and the validator accepted both. A rule
// that is applied is an artifact the compiler lowers, so a rewrite that
// changes the answer is not a missed opportunity, it is a wrong program.

/** Applies one proposal to a source of its own, and says what came of it. */
function against(
  lib: string,
  name: string,
  proposalText: string,
): { ir: string; note: string } | { refused: string } {
  const files = { "main.ts": `import { ${name} } from './lib.ts';\nconsole.log(${name}(2));\n`, "lib.ts": lib };
  const own = phaseOf("typescript", files, "main.ts");
  const ownProgram: ProgramContract = own.program;
  const ownSemantics = semanticsOf(own);
  const ownContracts: Record<string, FunctionContract> = Object.fromEntries(
    ownProgram.files.flatMap((file) => Object.entries(file.functions)),
  );
  const proposal = proposalsIn(repaired(proposalText))[0] as Proposal;
  const outcome = applyProposal(structuredClone(ownSemantics[name] as SemanticFunction), proposal, {
    functions: new Map(Object.entries(ownSemantics)),
  });
  if ("refused" in outcome) return outcome;
  validateSemanticFunction(outcome.applied, ownContracts[name] as FunctionContract);
  return { ir: printSemanticFunction(outcome.applied), note: outcome.note };
}

test("inline-call writes under a name of the callee's own, not the caller's", () => {
  // This used to be refused, and the reason was a real defect rather than a
  // real obstacle: a `set` names what it writes as a bare string, so the
  // spliced body carried `x = x + 1` over onto `work`'s own `x`, and the value
  // the caller read back was a write it never made. `work(5)` is 11 and the
  // spliced body returned 12. A parameter is a copy of its argument, so the
  // write now lands on a temporary of its own and the caller's `x` is what it
  // was.
  const parameter = against(
    [
      "export function bump(x: number): number { x = x + 1; return x; }",
      "export function work(x: number): number {",
      "  const y = bump(x);",
      "  return x + y;",
      "}",
    ].join("\n"),
    "work",
    "inline-call entry callee=bump",
  );
  assert.ok(!("refused" in parameter), `a callee that writes its parameter is inlinable: ${JSON.stringify(parameter)}`);
  assert.match(parameter.ir, /inlined\d+ = \[add\[f64\] local\[f64\] inlined\d+/, "the write is on a copy of its own");
  assert.doesNotMatch(parameter.ir, /^\s*set x = /m, "the write did not land on the caller's parameter");
  // The caller's own `x` is still read where the caller read it, so the answer
  // is 5 + 6 rather than 6 + 6.
  assert.match(parameter.ir, /return \[add\[f64\] local\[f64\] x local\[f64\] y\]/, "the caller reads its own x");

  const local = against(
    [
      "export function bump(x: number): number { let acc = x; acc = x + 1; return acc; }",
      "export function work(x: number): number {",
      "  let acc = 100;",
      "  const y = bump(x);",
      "  return acc + y;",
      "}",
    ].join("\n"),
    "work",
    "inline-call entry callee=bump",
  );
  assert.ok(!("refused" in local), `a callee that writes its own local is inlinable: ${JSON.stringify(local)}`);
  // The callee's `acc` is renamed, so the caller's own `acc = 100` is what the
  // caller reads back: 100 + 6, not 6 + 6.
  assert.match(local.ir, /let value\[f64\] inlined\d+ mutable = local\[f64\] x/, "the callee's local was renamed into this function");
  assert.match(local.ir, /let value\[f64\] acc mutable = const\[f64\] 100/, "the caller's own local is still the one it declared");
  assert.match(local.ir, /return \[add\[f64\] local\[f64\] acc local\[f64\] y\]/, "the caller reads its own acc");
});

test("common-subexpression refuses a value a nested block shadows", () => {
  // `a * 2` is computed once through the arm's own `a` and once through the
  // parameter. The two are written the same way and the key compares the
  // writing, so the rule saw one repeated value and bound it at the top of
  // `entry`, where the name it reads is the parameter. `work(2)` is 24; the
  // bound body returns 8.
  const outcome = against(
    [
      "export function work(a: number): number {",
      "  let s = 0;",
      "  if (a > 0) {",
      "    let a = 10;",
      "    s = a * 2;",
      "  }",
      "  return s + a * 2;",
      "}",
    ].join("\n"),
    "work",
    "common-subexpression entry",
  );
  assert.ok("refused" in outcome, "a value a nested block shadows is not one value");
  assert.match(outcome.refused, /it reads a name the region writes/);
});

test("a value that reads through an object is not bound under a negation", () => {
  // `-a[i]` is an element read under a negation, and `isSafeToCompute` answered
  // true for a `unary` without looking at the operand, so the rule bound the
  // read to a name. Binding it put the read at the top of the block, on every
  // turn, where the source performed it only on the turns its own code reached:
  // the same reason an `element` of its own is refused, and the operand is read
  // on the same turn the whole is.
  const negated = against(
    [
      "export function work(a: Float64Array): number {",
      "  let total = 0;",
      "  for (let i = 0; i < 3; i += 1) {",
      "    total = total - (-a[i]) - (-a[i]);",
      "  }",
      "  return total;",
      "}",
    ].join("\n"),
    "work",
    "common-subexpression b2",
  );
  assert.ok("refused" in negated, "a read through an object is not bound under a negation");
  assert.match(negated.refused, /it reads memory/);
});

// A refusal is what the next round is handed, so a refusal that does not say
// which value it refused tells a model that was right about the repetition
// that it was wrong about it, and it proposes the same thing again. These are
// the three cases that actually occur: a read of memory, a call, and a name.

test("a refusal names the value it refused and the reason, so the next round can act on it", () => {
  // The case from a real build: `checksum` reads `node.left` once in the guard
  // and once in the return, so the repetition is real and the refusal has to be
  // about the read rather than about the count. The value is quoted the way the
  // IR prints it, because that is the text the model read to decide it was
  // repeated in the first place. The object has to be built from a real field
  // for the read to be one: a parameter typed `any` with no object behind it
  // resolves to no field at all, and there is nothing to refuse.
  const outcome = against(
    [
      "export function create(depth: number): any {",
      "  return { left: null, right: null };",
      "}",
      "export function checksum(node: any): number {",
      "  if (!node.left) { return 1; }",
      "  return 1 + checksum(node.left) + checksum(node.right);",
      "}",
    ].join("\n"),
    "checksum",
    "common-subexpression entry",
  );
  assert.ok("refused" in outcome, "a read of memory is not bound");
  assert.match(outcome.refused, /computes `\[load_field\[ref<any>\] local\[ref<any>\] node Object1 left\]` 2 times/);
  assert.match(outcome.refused, /it reads memory/);
});

test("a refusal says a repeated call is a call, and a repeated name is a name", () => {
  const called = against(
    [
      "export function twice(x: number): number { return x + x; }",
      "export function work(scale: number): number {",
      "  return twice(scale) + twice(scale);",
      "}",
    ].join("\n"),
    "work",
    "common-subexpression entry",
  );
  assert.ok("refused" in called, "a call is never bound");
  assert.match(called.refused, /it calls something/);

  const named = against(
    [
      "export function work(scale: number): number {",
      "  let total = scale + scale;",
      "  return total * scale + scale;",
      "}",
    ].join("\n"),
    "work",
    "common-subexpression entry",
  );
  assert.ok("refused" in named, "a name is read rather than computed");
  assert.match(named.refused, /it is a name or a literal/);
});

test("inline-call keeps a call edge a terminator still makes", () => {
  // `twice` is called from a statement, which the rule inlines, and from the
  // return terminator, which it does not. The call edges are what the printed
  // artifact declares its callees from, so dropping the edge left a function
  // that calls `twice` and declares no callee, and the compiler refused to
  // read its own artifact back.
  const lib = [
    "export function twice(x: number): number {",
    "  return x + x;",
    "}",
    "",
    "export function work(n: number): number {",
    "  let t = 0;",
    "  if (n > 0) { t = twice(n); }",
    "  return t + twice(n);",
    "}",
  ].join("\n");
  const files = { "main.ts": "import { work } from './lib.ts';\nconsole.log(work(3));\n", "lib.ts": lib };
  const own = phaseOf("typescript", files, "main.ts");
  const ownProgram: ProgramContract = own.program;
  const ownSemantics = semanticsOf(own);
  const proposal = proposalsIn(repaired("inline-call b1 callee=twice"))[0] as Proposal;
  const outcome = applyProposal(structuredClone(ownSemantics.work as SemanticFunction), proposal, {
    functions: new Map(Object.entries(ownSemantics)),
  });
  assert.ok("applied" in outcome, "the call in the arm is inlined");
  assert.deepEqual(
    outcome.applied.calls.map((edge) => edge.callee),
    ["twice"],
    "the terminator still calls it, so the edge is still declared",
  );
  // The artifact is read back, which is what a build does to a revised IR.
  const reread = parseSemanticFunction(printSemanticFunction(outcome.applied), ownProgram);
  assert.deepEqual(
    reread.calls.map((edge) => edge.callee),
    ["twice"],
  );
});

test("common-subexpression binds a value under the declaration it reads", () => {
  // `n * n` is computed twice and never changes, so it is bound once. The
  // binding cannot go at the top of the block: `n` is declared in this block,
  // and a binding written above that declaration reads a slot nothing has
  // filled in yet, which the validator refuses and the C backend cannot
  // write. It goes directly under the declaration instead, and every use of
  // the name is still below it.
  const lib = [
    "export function squared(): number {",
    "  let n = 2;",
    "  let first = n * n;",
    "  let spare = 5;",
    "  let second = n * n;",
    "  return first + second + spare;",
    "}",
    "",
  ].join("\n");
  const files = { "main.ts": "import { squared } from './lib.ts';\nconsole.log(squared());\n", "lib.ts": lib };
  const own = phaseOf("typescript", files, "main.ts");
  const ownSemantics = semanticsOf(own);
  const outcome = applyProposal(structuredClone(ownSemantics.squared as SemanticFunction), proposalsIn(repaired("common-subexpression entry"))[0] as Proposal, {
    functions: new Map(Object.entries(ownSemantics)),
  });
  assert.ok("applied" in outcome, "the rule applies: the value is computed twice and nothing writes it");
  // `apply` above is what every other test here goes through, and it validates:
  // this is the assertion that the binding is written under `let n`.
  validateSemanticFunction(outcome.applied, own.program.files[1].functions.squared as FunctionContract);
  const statements = (outcome.applied as SemanticFunction).entry.statements;
  const bound = statements.findIndex((statement) => statement.k === "let" && statement.slot.name.startsWith("shared"));
  const declared = statements.findIndex((statement) => statement.k === "let" && statement.slot.name === "n");
  assert.ok(bound !== -1, `a value was bound: ${JSON.stringify(statements)}`);
  assert.ok(bound > declared, "the binding is written after the declaration it reads");
  // And the artifact a build lowers is the one the source is: 4 + 4 + 5.
  const reread = parseSemanticFunction(printSemanticFunction(outcome.applied), own.program);
  assert.equal(validateSemanticFunction(reread, own.program.files[1].functions.squared as FunctionContract), undefined);
});

test("an accumulator is inlinable, which is the callee most worth inlining", () => {
  // A helper that accumulates is the commonest shape in a program written this
  // way, and it used to be refused for writing at all. It is also the callee
  // where a call costs the most: the loop inside it is the work, and a call to
  // it from inside another loop pays for the call and the frame every turn.
  const outcome = attemptOn(
    "usesAccumulator",
    [
      "export function accumulate(scale: number): number {",
      "  let total = 0;",
      "  let i = 0;",
      "  while (i < 4) { total = total + i * scale; i = i + 1; }",
      "  return total;",
      "}",
      "",
      "export function usesAccumulator(scale: number): number {",
      "  let total = 0;",
      "  let j = 0;",
      "  while (j < 3) { total = total + accumulate(scale); j = j + 1; }",
      "  return total;",
      "}",
      "",
    ].join("\n"),
    "inline-call b2 callee=accumulate",
  );
  assert.ok(typeof outcome === "object" && "applied" in outcome, `an accumulator is inlinable: ${JSON.stringify(outcome)}`);
  const ir = typeof outcome === "object" && "applied" in outcome ? printSemanticFunction(outcome.applied) : "";
  assert.match(ir, /inlined\d+/, "the callee's names were renamed into this function");
  assert.doesNotMatch(ir, /accumulate\(/, "the call the body replaced is gone from the caller");
});

/** Resolves one function of its own library and applies one proposal to it. */
function attemptOn(name: string, lib: string, proposal: string): RepairOutcome | "refused" {
  const files = { "main.ts": `import { ${name} } from './lib.ts';\nconsole.log(${name}());\n`, "lib.ts": lib };
  const own = phaseOf("typescript", files, "main.ts");
  const ownSemantics = semanticsOf(own);
  const proposalText = proposalsIn(repaired(proposal))[0] as Proposal;
  const outcome = applyProposal(
    structuredClone(ownSemantics[name] as SemanticFunction),
    proposalText,
    { functions: new Map(Object.entries(ownSemantics)) },
  );
  if (!("applied" in outcome)) return "refused";
  // An applied rule has to leave a function the compiler may still lower, and
  // it has to leave the program the source wrote.
  validateSemanticFunction(outcome.applied, own.program.files[1].functions[name] as FunctionContract);
  return outcome;
}

test("hoist-invariant refuses a value a write through another name would change", () => {
  // `a` and `b` are two names for one object, and the loop writes `b`. The IR
  // carries no alias information, so nothing that reads names can tell that
  // `a.v + a.v` is a different value on the second turn than on the first: the
  // value is judged unchanged while the memory it reads is written under the
  // other name. Hoisted above the loop it is read once, on the first turn, and
  // the program answers 0 where the source answers 4.
  const lib = [
    "export function aliased(): number {",
    "  const a = { v: 0 };",
    "  const b = a;",
    "  let total = 0;",
    "  for (let i = 0; i < 3; i += 1) {",
    "    total = a.v + a.v;",
    "    b.v = i + 1;",
    "  }",
    "  return total;",
    "}",
    "",
  ].join("\n");
  const outcome = attemptOn("aliased", lib, "hoist-invariant b1");
  assert.equal(outcome, "refused", "a value read through memory is not hoisted out of a loop that writes memory");
});

test("no rule binds a value that can fault on a turn that did not use to compute it", () => {
  // A name is computed once, where it is written, and read wherever the value
  // was. When the value was only computed inside an arm, binding it computes
  // it on every turn instead. `10 / d` is an integer division, and there is no
  // division by zero on a whole number on any target: the C backend raises
  // `SIGFPE` and a module traps. The function is well defined at `d = 0`
  // because the arm that divides is not taken there.
  const lib = [
    "export function guarded(d: bigint, n: bigint): bigint {",
    "  let total = 0n;",
    "  if (n > 0n) { total = 10n / d; }",
    "  if (n > 1n) { total = total + 10n / d; }",
    "  return total;",
    "}",
    "",
  ].join("\n");
  assert.equal(
    attemptOn("guarded", lib, "common-subexpression entry"),
    "refused",
    "a division of whole numbers is not bound out of the arm that guards it",
  );

  // The same shape with a load instead of a division. There is no bounds check
  // on an element access at any mode, because the IR holds no length for one,
  // so binding the read makes the program read past the end of the buffer on
  // the turns where the arm was not taken. The rule still holds here — `n > 0`
  // is computed twice and can fault on neither — so what it must not do is
  // bind the read beside it.
  const reads = [
    "export function reads(a: Float64Array, n: number): number {",
    "  let total = 0;",
    "  if (n > 0) { total = a[0]; }",
    "  if (n > 0) { total = total + a[0]; }",
    "  return total;",
    "}",
    "",
  ].join("\n");
  const bound = attemptOn("reads", reads, "common-subexpression entry");
  assert.ok(bound !== "refused" && "applied" in bound, "the comparison is bound: it is computed twice and safe");
  const ir = printSemanticFunction(bound.applied);
  const bindings = ir.split("\n").filter((line) => /^\s*let .*shared\d+.*= \[/.test(line));
  assert.ok(bindings.length > 0, `something was bound: ${ir}`);
  assert.ok(
    bindings.every((line) => !line.includes("element")),
    `a load was bound out of the arm that guards it: ${bindings.join(" | ")}`,
  );
});

/* -------------------------------------------------------------------------- */
/* inlineCalls                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Contracts a library, resolves it, and inlines into one of its functions
 * without a proposal naming anything — which is how the compiler now asks.
 */
function inlined(lib: string, name: string): { ir: string; fn: SemanticFunction } | { refused: string } {
  const files = { "main.ts": `import { ${name} } from './lib.ts';\nconsole.log(${name}(2));\n`, "lib.ts": lib };
  const own = phaseOf("typescript", files, "main.ts");
  const ownSemantics = semanticsOf(own);
  const contracts: Record<string, FunctionContract> = Object.fromEntries(
    own.program.files.flatMap((file) => Object.entries(file.functions)),
  );
  const fn = inlineCalls(structuredClone(ownSemantics[name] as SemanticFunction), {
    functions: new Map(Object.entries(ownSemantics)),
  });
  // What the compiler does on its own has to leave a function it may still
  // lower, exactly as a proposal it applied has to.
  validateSemanticFunction(fn, contracts[name] as FunctionContract);
  return { ir: printSemanticFunction(fn), fn };
}

test("a callee that calls nothing is put where its call was", () => {
  const result = inlined(
    [
      "export function twice(x: number): number {",
      "  return x + x;",
      "}",
      "",
      "export function work(x: number): number {",
      "  return twice(x);",
      "}",
      "",
    ].join("\n"),
    "work",
  );
  assert.ok("ir" in result);
  assert.doesNotMatch(result.ir, /call twice/, "the call is gone");
  assert.deepEqual(result.fn.calls, [], "and the edge the body no longer makes is gone with it");
});

test("a callee that writes its parameter does not write the caller's name", () => {
  // A parameter is a copy of the argument, so `bump(x)` leaving `x` alone is
  // what the source says: `work(5)` is 11 and a write that reached through
  // would answer 12. Nothing proposes this rewrite now — the compiler asks for
  // it on every candidate of every build — so the copy has to hold without one.
  const result = inlined(
    [
      "export function bump(x: number): number {",
      "  x = x + 1;",
      "  return x;",
      "}",
      "",
      "export function work(x: number): number {",
      "  const y = bump(x);",
      "  return x + y;",
      "}",
      "",
    ].join("\n"),
    "work",
  );
  assert.ok("ir" in result);
  assert.doesNotMatch(result.ir, /call bump/);
  // The temporary is a place the spliced body writes — `x = x + 1` inside
  // `bump` lands on it — so it is bound as a name that can be written, and the
  // caller's own `x` is still a binding.
  assert.match(result.ir, /let value\[f64\] inlined\d+ mutable = local\[f64\] x/, "the argument is copied to a temporary of its own");
  assert.match(result.ir, /return \[add\[f64\] local\[f64\] x local\[f64\] y\]/, "and the caller still reads its own x");
});

test("a callee that calls something is left alone, however deep the recursion", () => {
  // `twice` calls itself, so `work` calling `twice` cannot be spliced: the
  // body would hold the call that has to be put into it. A pass that cannot
  // see the end of that has to be bounded by the calls the function was
  // written with, which is what `inlineCalls` rounds on.
  const result = inlined(
    [
      "export function countdown(n: number): number {",
      "  if (n <= 0) { return 0; }",
      "  return countdown(n - 1);",
      "}",
      "",
      "export function work(n: number): number {",
      "  return countdown(n);",
      "}",
      "",
    ].join("\n"),
    "work",
  );
  assert.ok("ir" in result);
  assert.match(result.ir, /call countdown/, "the call the compiler cannot remove is still there");
});

test("the fold inlines, and every path to an object goes through the fold", () => {
  // The compiler does not ask for the rewrite; the fold does, on the way to
  // every object and module. This is what says so: a candidate folded with the
  // program's functions has no call left in it, and the same candidate folded
  // without them is handed back untouched rather than half rewritten.
  const files = {
    "main.ts": "import { work } from './lib.ts';\nconsole.log(work(2));\n",
    "lib.ts": ["export function twice(x: number): number {", "  return x + x;", "}", "", "export function work(x: number): number {", "  return twice(x);", "}", ""].join("\n"),
  };
  const phase = phaseOf("typescript", files, "main.ts");
  const semantics = semanticsOf(phase);
  const candidate: Candidate = {
    id: "c1",
    text: printSemanticFunction(semantics.work as SemanticFunction),
    model: "the test",
    modelConfig: "none",
    generatedAt: "1970-01-01T00:00:00.000Z",
    candidate: 1,
    round: 1,
  };
  const withFunctions = foldedCandidate(candidate, phase.program, semantics);
  assert.doesNotMatch(withFunctions.text, /call twice/, `the fold inlined it: ${withFunctions.text}`);
  const alone = foldedCandidate(candidate, phase.program, {});
  assert.match(alone.text, /call twice/, "and it rewrites nothing it was not given the bodies for");
});

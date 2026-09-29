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
import { applyProposal, describeSites, REPAIR_RULES } from "../semantics/repair.ts";
import { printSemanticFunction, parseSemanticFunction } from "../semantics/ir-text.ts";
import { validateSemanticFunction } from "../semantics/ir-validate.ts";
import { parseReview, type Proposal } from "../core/proposal.ts";
import { phaseOf, semanticsOf } from "./phase.ts";
import type { SemanticFunction } from "../core/semantic-ir.ts";
import type { FunctionContract, ProgramContract } from "../core/types.ts";

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
  assert.match(outcome.refused, /computes nothing more than once/);
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

test("common-subexpression refuses a block that computes nothing twice", () => {
  const outcome = apply("plain", proposalsIn(repaired("common-subexpression entry"))[0] as Proposal);
  assert.ok("refused" in outcome);
  assert.match(outcome.refused, /computes nothing more than once/);
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

test("inline-call refuses a callee that writes its own parameter", () => {
  // `bump` writing `x` is state of `bump`. The spliced body carries that write
  // over as a `set` on a bare name, so it lands on `work`'s own `x` and the
  // argument the call was made with is already gone by the time it is read.
  // `work(5)` is 11; the inlined body returns 12.
  const outcome = against(
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
  assert.ok("refused" in outcome, "a private write is not a caller's to inherit");
  assert.match(outcome.refused, /bump writes the parameter "x"/);
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
  assert.match(outcome.refused, /nothing to bind/);
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

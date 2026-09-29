/**
 * The review protocol: what a review is asked, what an answer may say, and
 * what the compiler does with one.
 *
 * A review is the only thing a model is ever asked for, so the grammar of an
 * answer is as much a part of the compiler as the rules a proposal names. What
 * is checked here is that an answer the compiler cannot read is refused as
 * unreadable rather than treated as a review of nothing, that the prompts say
 * what an answer has to be, and that the catalogue in the prompt is the one the
 * engine applies.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseReview } from "../core/proposal.ts";
import { buildIrReviewPrompt, buildRetryPrompt, buildSystemPrompt, buildTargetReviewPrompt, type ReviewRequest } from "../ai/review.ts";
import { REPAIR_RULES, describeSites } from "../semantics/repair.ts";
import { printSemanticFunction } from "../semantics/ir-text.ts";
import { semanticsOf, phaseOf } from "./phase.ts";
import type { FunctionContract, ProgramContract } from "../core/types.ts";

const FILES: Record<string, string> = {
  "lib.ts": [
    "export function dotProduct(a: Float64Array, b: Float64Array, n: number): number {",
    "  let total = 0;",
    "  for (let i = 0; i < n; i++) {",
    "    total += a[i] * b[i];",
    "  }",
    "  return total;",
    "}",
    "",
  ].join("\n"),
  "main.ts": ["import { dotProduct } from \"./lib.ts\";", "console.log(dotProduct(1));", ""].join("\n"),
};

const phase = phaseOf("typescript", FILES, "main.ts");
const program: ProgramContract = phase.program;
const semantics = semanticsOf(phase);
const contract: FunctionContract = program.files.find((file) => file.path === "lib.ts")?.functions.dotProduct as FunctionContract;
const ir = printSemanticFunction(semantics.dotProduct as NonNullable<typeof semantics.dotProduct>);

function request(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    stage: "ir",
    contract,
    unit: { file: "lib.ts", function: "dotProduct" },
    program,
    semantics,
    target: { arch: "x86_64", os: "linux", abi: "sysv", cpu: "", features: [] },
    output: "machine",
    candidate: 1,
    candidates: 2,
    attempt: 1,
    artifact: ir,
    artifactNote: null,
    feedback: [],
    refusals: [],
    ...overrides,
  };
}

test("a review that finds nothing to change is read as one", () => {
  const parsed = parseReview("verdict: sound\nreason: the body is the reduction the contract asks for");
  assert.ok("review" in parsed);
  assert.equal(parsed.review.verdict, "sound");
  assert.equal(parsed.review.reason, "the body is the reduction the contract asks for");
  assert.deepEqual(parsed.review.proposals, []);
});

test("a review is read out of a fenced answer, and the fence is not part of it", () => {
  const parsed = parseReview(
    ["```text", "verdict: repaired", "reason: the bound is read on every iteration", "proposal: hoist-invariant b1", "```"].join("\n"),
  );
  assert.ok("review" in parsed);
  assert.equal(parsed.review.verdict, "repaired");
  assert.equal(parsed.review.proposals.length, 1);
  const [proposal] = parsed.review.proposals;
  assert.equal(proposal?.rule, "hoist-invariant");
  assert.equal(proposal?.site, "b1");
  assert.equal(proposal?.text, "hoist-invariant b1");
});

test("a proposal carries the arguments its rule takes", () => {
  const parsed = parseReview("verdict: repaired\nreason: inline it\nproposal: inline-call b2 callee=twice");
  assert.ok("review" in parsed);
  const [proposal] = parsed.review.proposals;
  assert.deepEqual({ ...proposal?.args }, { callee: "twice" });
});

test("an answer that is not a review is refused as unreadable, and says which line", () => {
  for (const [answer, because] of [
    ["here is the implementation you asked for\nfunction dotProduct() {}", /line 1/],
    ["verdict: maybe\nreason: unsure", /not a verdict/],
    ["reason: no verdict here", /no verdict/],
    ["verdict: sound", /no reason/],
    ["verdict: repaired\nreason: something is wrong", /proposes no fix/],
    ["verdict: sound\nreason: all good\nproposal: hoist-invariant b1", /calls the artifact sound and proposes a fix/],
    ["verdict: repaired\nreason: fix it\nproposal: hoist-invariant", /proposes "hoist-invariant" and no block/],
    ["verdict: repaired\nreason: fix it\nproposal:", /proposes nothing/],
    ["verdict: repaired\nreason: fix it\nproposal: hoist-invariant b1 factor", /neither a rule nor a name=value/],
    ["verdict: repaired\nreason: fix it\nproposal: hoist-invariant b1 factor=", /gives factor no value/],
    ["verdict: repaired\nreason: fix it\nproposal: hoist-invariant b1 factor=2 factor=3", /gives factor twice/],
    ["verdict: sound\nreason: fine\nverdict: unsound", /a verdict more than once/],
  ] as const) {
    const parsed = parseReview(answer);
    assert.ok("unusable" in parsed, `"${answer.split("\n")[0]}" must not be read as a review`);
    assert.match(parsed.unusable, because, answer);
  }
});

test("a verdict of unsound is a report, and carries no proposal", () => {
  const parsed = parseReview("verdict: unsound\nreason: no rule in the catalogue turns this into a sum");
  assert.ok("review" in parsed);
  assert.equal(parsed.review.verdict, "unsound");
  assert.deepEqual(parsed.review.proposals, []);
});

test("the system prompt says a review is a verdict and proposals, and never a program", () => {
  const system = buildSystemPrompt();
  assert.match(system, /You do not write a program/);
  assert.match(system, /You do not decide that an artifact is correct/);
  assert.match(system, /You do not describe a fix in prose/);
  assert.doesNotMatch(system, /Answer with the whole function as semantic IR/);
});

test("the IR review hands over the artifact, the sites a proposal may name and the rules it may name them by", () => {
  const prompt = buildIrReviewPrompt(request());
  assert.match(prompt, /THE SEMANTIC IR THE COMPILER RESOLVED THE SOURCE INTO/);
  assert.ok(prompt.includes(ir), "the artifact under review is the IR as the compiler wrote it");
  assert.match(prompt, /## SITES A PROPOSAL MAY NAME/);
  for (const line of describeSites(semantics.dotProduct as NonNullable<typeof semantics.dotProduct>)) {
    assert.ok(prompt.includes(line), `the site index states ${line}`);
  }
  for (const rule of REPAIR_RULES) {
    assert.match(prompt, new RegExp(`- ${rule.name}: ${rule.summary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  }
  assert.match(prompt, /verdict: sound \| repaired \| unsound/);
  assert.match(prompt, /proposal: <rule> <block> \[name=value\]/);
});

test("a review of the target says what the target is and how a change to it is made", () => {
  const prompt = buildTargetReviewPrompt(
    request({ stage: "target", artifact: "dotProduct:\n  ret\n", artifactNote: "the assembly the C compiler made" }),
  );
  assert.match(prompt, /THE TARGET CODE THE COMPILER LOWERED THE IR INTO/);
  assert.ok(prompt.includes("the assembly the C compiler made"));
  assert.match(prompt, /The compiler rewrites the IR and\s+lowers it again/);
  assert.doesNotMatch(prompt, /THE SEMANTIC IR THE COMPILER RESOLVED THE SOURCE INTO/);
});

test("what the compiler found and what it refused is handed to the next review", () => {
  const prompt = buildIrReviewPrompt(
    request({
      feedback: ["[round 1] verify failed: 2 of 40 test vectors did not match the contract"],
      refusals: ["`hoist-invariant b1` was refused: no loop is written in block b1"],
    }),
  );
  assert.match(prompt, /WHAT THE COMPILER ALREADY FOUND/);
  assert.match(prompt, /2 of 40 test vectors did not match the contract/);
  assert.match(prompt, /no loop is written in block b1/);
});

test("a program that printed something else is shown beside the source that did not", () => {
  const prompt = buildIrReviewPrompt(
    request({
      programFailure: {
        previous: ir,
        mismatch: {
          line: 2,
          expected: "done: 70",
          actual: "done: 0",
          expectedOutput: "starting\ndone: 70\n",
          actualOutput: "starting\ndone: 0\n",
        },
      },
    }),
  );
  assert.match(prompt, /WHAT THE PROGRAM IT BELONGS TO PRINTED/);
  assert.match(prompt, /WHAT THE SOURCE PRINTS/);
  assert.match(prompt, /The outputs are the same until line 2, where they differ/);
});

test("a re-request quotes why the answer was set aside, and asks again from the beginning", () => {
  const retry = buildRetryPrompt("THE REVIEW REQUEST", ["line 1 is neither a verdict, a reason nor a proposal"]);
  assert.match(retry, /THE PREVIOUS ANSWER COULD NOT BE READ/);
  assert.match(retry, /line 1 is neither a verdict/);
  assert.match(retry, /Answer the request above from the beginning/);
});

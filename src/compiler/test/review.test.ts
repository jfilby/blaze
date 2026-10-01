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
  assert.doesNotMatch(prompt, /proposal: <rule>/);
});

test("two candidates of one build are never asked the same question", () => {
  // A build pays for a review per candidate, so five candidates that render the
  // same prompt are five calls that learn one thing: `renderReview` read
  // neither the candidate nor the attempt, and every chain starts from the same
  // base IR, so the first round of every function was byte-identical across all
  // of them. What differs is a reading — where to start looking — not a rule:
  // narrowing the catalogue per candidate would make a build worse at whatever
  // the candidate was not sent to look for.
  const prompts = [1, 2, 3, 4, 5].map((candidate) => buildIrReviewPrompt(request({ candidate, candidates: 5 })));
  assert.equal(new Set(prompts).size, 5, "each candidate of a build is asked something of its own");
  const readings = prompts.map((prompt) => /## WHERE THIS READING STARTS[\s\S]*?\.\n\n([\s\S]*?)\n\nThat is where/.exec(prompt)?.[1]);
  assert.equal(new Set(readings).size, 5, "and the reading each was given is its own");
  for (const prompt of prompts) {
    for (const rule of REPAIR_RULES) {
      assert.ok(prompt.includes(`- ${rule.name}:`), `every rule stays open to a candidate told to read elsewhere: ${rule.name}`);
    }
    assert.match(prompt, /not what you are allowed to propose/, "a reading is a place to start, not a restriction");
  }
  // More candidates than there are readings must still differ: the number the
  // prompt states is part of what tells them apart, not only the reading.
  const many = [1, 2, 3, 4, 5, 6, 7, 8].map((candidate) => buildIrReviewPrompt(request({ candidate, candidates: 8 })));
  assert.equal(new Set(many).size, 8, "a build with more candidates than readings still asks each its own question");
});

test("a build that asked for one candidate is not told it is one of several", () => {
  // There is no other reading to differ from, so the section is a statement
  // about a build that is not happening.
  const prompt = buildIrReviewPrompt(request({ candidate: 1, candidates: 1 }));
  assert.doesNotMatch(prompt, /WHERE THIS READING STARTS/);
  assert.doesNotMatch(prompt, /candidate 1 of 1/);
});

test("the target review diverges as the IR review does", () => {
  const target = (candidate: number) =>
    buildTargetReviewPrompt(request({ stage: "target", candidate, candidates: 5, artifact: "dotProduct:\n  ret\n" }));
  assert.notEqual(target(1), target(2), "the winner's target review is still one reading of several");
  assert.match(target(2), /candidate 2 of 5/);
});

test("the answer format is shown as whole answers, naming a block the IR prints and no brackets", () => {
  const prompt = buildIrReviewPrompt(request());
  const sites = describeSites(semantics.dotProduct as NonNullable<typeof semantics.dotProduct>);
  const named = /^proposal: hoist-invariant (\S+)$/m.exec(prompt)?.[1];
  assert.ok(named !== undefined, "the worked example names a rule and a block id");
  assert.ok(
    sites.some((line) => line.startsWith(`block ${named}:`)),
    `the block the example names, ${named}, is one the site list offers`,
  );
  // The bracketed placeholder is what a model copies back verbatim, so the
  // prompt shows the argument bare and says so.
  assert.doesNotMatch(prompt, /\[name=value\]/);
  assert.match(prompt, /written `name=value` with no\nbrackets around them/);
  // Nothing is proposed by leaving the line out, which the two failure modes
  // in the wild were a model reaching for a placeholder instead of.
  assert.match(prompt, /carries no\n`proposal:` line at all/);
});

test("a rule that takes no argument says so, rather than looking like one whose arguments were left out", () => {
  const prompt = buildIrReviewPrompt(request());
  for (const rule of REPAIR_RULES.filter((entry) => entry.args.length === 0)) {
    assert.match(prompt, new RegExp(`- ${rule.name}:[\\s\\S]*?takes no arguments`));
  }
  assert.match(prompt, /takes one argument: callee/);
});

test("a line that says it proposes nothing is a review with no proposals, not an unreadable answer", () => {
  for (const word of ["none", "None", "nothing", "n/a", "-"]) {
    const parsed = parseReview(`verdict: sound\nreason: the body is right\nproposal: ${word}`);
    assert.ok("review" in parsed, `\`proposal: ${word}\` must be read as a review with no proposals`);
    assert.deepEqual(parsed.review.proposals, []);
  }
});

test("a verdict of repaired still needs a fix, whatever the no-proposal line is written as", () => {
  const parsed = parseReview("verdict: repaired\nreason: the bound is recomputed\nproposal: none");
  assert.ok("unusable" in parsed);
  assert.match(parsed.unusable, /proposes no fix/);
});

test("an argument written inside the brackets of the format line is the argument inside them", () => {
  const one = parseReview("verdict: repaired\nreason: inline it\nproposal: inline-call b2 [callee=twice]");
  assert.ok("review" in one);
  assert.deepEqual({ ...one.review.proposals[0]?.args }, { callee: "twice" });

  const two = parseReview("verdict: repaired\nreason: inline it\nproposal: inline-call b2 [callee=twice, factor=2]");
  assert.ok("review" in two);
  assert.deepEqual({ ...two.review.proposals[0]?.args }, { callee: "twice", factor: "2" });
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

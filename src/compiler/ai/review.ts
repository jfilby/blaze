/**
 * What a review asks for, and what an answer looks like.
 *
 * The compiler is the only thing that writes a program. It resolves the source
 * into the semantic IR, lowers that IR to whatever target a build asked for, and
 * proves the result by running it. A model is asked twice along that path, and
 * both times it is asked the same thing: read the artifact the compiler just
 * produced, say whether it is right, and name the fixes you would make out of
 * the catalogue of rewrites this compiler implements.
 *
 * A review is never a program. There is no syntax for one here, and an answer
 * that tries to write a body, an assembly listing or a corrected IR is an
 * answer the compiler cannot read: the rules below are the only way a review
 * says anything, and each of them names a rewrite that the compiler applies
 * itself, on its own tree, and then re-verifies.
 *
 * Two artifacts are reviewed, and the prompts differ only in what they show:
 *
 *   the IR      what the compiler resolved the source into, before anything was
 *               lowered from it
 *   the target  the text the compiler lowered that IR into, which is what a
 *               reader of the build will run
 *
 * Both are read with the same contract, the same objective and the same
 * catalogue, because a fix to either is a fix to the program: a revision is
 * applied to the IR and the target is regenerated from it.
 */

import { parseType, typeToString, isBufferType } from "../semantics/contract.ts";
import { describeSites, inlineRefusal, REPAIR_RULES } from "../semantics/repair.ts";
import type { SemanticFunction } from "../core/semantic-ir.ts";
import type {
  FunctionContract,
  OutputKind,
  ProgramContract,
  ProgramFailure,
  TargetSpec,
} from "../core/types.ts";

/* -------------------------------------------------------------------------- */
/* The request                                                                */
/* -------------------------------------------------------------------------- */

/** Which artifact of the build is being read. */
export type ReviewStage = "ir" | "target";

export interface ReviewRequest {
  stage: ReviewStage;
  contract: FunctionContract;
  unit: { file: string; function: string };
  /** The whole program, contracted: what a review reads a function in the context of. */
  program: ProgramContract;
  /** Every function of the program as the compiler resolved it, by name. */
  semantics: Record<string, SemanticFunction>;
  target: TargetSpec;
  output: OutputKind;
  candidate: number;
  candidates: number;
  attempt: number;
  /**
   * The artifact as the compiler wrote it. For a review of the IR this is the
   * IR; for a review of a target it is the text the compiler lowered the IR
   * into, which is a module's shape rather than a listing where a target is
   * not written as text.
   */
  artifact: string;
  /** What the artifact is, where the text alone does not say. */
  artifactNote: string | null;
  /** What the compiler's own verification said about the artifact, oldest first. */
  feedback: readonly string[];
  /** The proposals of the round before this one the compiler refused, and why. */
  refusals: readonly string[];
  /** What the program printed where its source prints something else. */
  programFailure?: ProgramFailure;
}

/* -------------------------------------------------------------------------- */
/* Sections                                                                   */
/* -------------------------------------------------------------------------- */

/** One part of a prompt, under a markdown header. */
function section(title: string, body: string | readonly string[]): string {
  return [`## ${title}`, "", ...(typeof body === "string" ? body.split("\n") : body)].join("\n");
}

/** A diagnostic is a multi-line block; a bullet only covers its first line. */
function asBullet(entry: string): string {
  const [head, ...rest] = entry.split("\n");
  return [`- ${head}`, ...rest.map((line) => `  ${line}`)].join("\n");
}

function renderMemory(contract: FunctionContract): string {
  const aliasing = contract.memory.aliasing;
  const lines = [
    `reads: ${contract.memory.reads.length === 0 ? "nothing" : contract.memory.reads.join(", ")}`,
    `writes: ${contract.memory.writes.length === 0 ? "nothing" : contract.memory.writes.join(", ")}`,
    `aliasing: ${
      aliasing.length === 0
        ? contract.memory.writes.length === 0
          ? "not constrained (the function writes nothing)"
          : "not constrained"
        : aliasing.join(", ")
    }`,
  ];
  if (contract.memory.alignment !== undefined) lines.push(`alignment: ${JSON.stringify(contract.memory.alignment)}`);
  return lines.join("\n");
}

/**
 * The parameters as the contract types them, next to what each one is on the
 * wire. A buffer is a bare pointer to its first element: its length is not
 * passed beside it, so it is one of the other parameters.
 */
function renderTypes(contract: FunctionContract): string {
  const entries = contract.function.params.map((param) => {
    const type = parseType(param.type);
    if (!isBufferType(type)) return `${param.name}: ${param.type} (scalar)`;
    const wire = `buffer of ${typeToString(type.of)}, passed as a bare pointer to the first element; no length arrives with it`;
    return `${param.name}: ${param.type} (${wire})`;
  });
  entries.push(`result: ${contract.function.returns}`);
  return entries.join("\n");
}

/** The contract, as a review reads it. The body is the artifact, not part of it. */
function renderContract(contract: FunctionContract): string {
  const { statements, ...whatItDoes } = contract.definition;
  return JSON.stringify({ ...contract, definition: whatItDoes }, null, 2);
}

/** The program the function belongs to: what else it is, and what it may call. */
function renderProgram(request: ReviewRequest): string {
  const lines = [`language: ${request.program.language}`, `function under review: ${request.unit.function} in ${request.unit.file}`];
  for (const file of request.program.files) {
    if (file.path === request.unit.file) continue;
    lines.push(`${file.path} exports ${Object.keys(file.functions).join(", ") || "nothing"}`);
    for (const [name, contract] of Object.entries(file.functions)) {
      lines.push(
        `  ${name}(${contract.function.params.map((param) => `${param.name}: ${param.type}`).join(", ")}) -> ${contract.function.returns}`,
        ...contract.requires.map((requirement) => `    requires ${requirement}`),
        ...contract.ensures.map((condition) => `    ensures ${condition}`),
      );
    }
  }
  return section("PROGRAM", lines);
}

/** The target, as the machine the artifact has to run on. */
function renderTarget(target: TargetSpec): string {
  return section("TARGET", [
    `architecture: ${target.arch}, operating system: ${target.os}, ABI: ${target.abi}`,
    `instruction set: ${target.features.length === 0 ? `the ${target.arch} baseline` : target.features.join(", ")}`,
  ]);
}

function renderObjective(contract: FunctionContract): string[] {
  return [
    `primary: ${contract.optimize.primary}`,
    `secondary: ${contract.optimize.secondary ?? "none"}`,
    "",
    "Judge the artifact against the primary objective, and propose only what moves it. A change that makes",
    "the artifact smaller and slower, or faster and larger, is not one the objective asks for.",
  ];
}

function renderNumerical(contract: FunctionContract): string[] {
  return [
    `floating point: ${contract.numeric.floatingPoint}`,
    `rounding: ${contract.numeric.rounding}`,
    `fast math: ${contract.numeric.fastMath}`,
    "",
    contract.numeric.fastMath === false
      ? "Reassociation, contraction and value changes are not allowed: the result must be reproducible within the accumulated rounding error of a sequential sum."
      : "Rounding changes are permitted, but the result must still satisfy the postconditions.",
  ];
}

/** The rules, as a proposal names one. */
function renderCatalogue(): string[] {
  const lines: string[] = [];
  for (const rule of REPAIR_RULES) {
    lines.push(`- ${rule.name}: ${rule.summary}`, `  applies: ${rule.applies}`);
    // What a rule takes is said either way. Listing only the arguments a rule
    // has leaves a rule that takes none looking like one whose arguments were
    // forgotten, and the proposal that follows is refused for carrying one.
    lines.push(
      rule.args.length === 0
        ? "  takes no arguments: a proposal naming it is the rule and the block id, and nothing after them"
        : `  takes one argument: ${rule.args.map((argument) => argument.name).join(", ")}`,
    );
    for (const argument of rule.args) lines.push(`  ${argument.name}: ${argument.description}`);
  }
  return lines;
}

/**
 * The answer, in the only form the compiler reads.
 *
 * The shape is shown as whole answers against a block id the artifact really
 * has, not as a line of placeholders. A format written as `<rule> <block>
 * [name=value]` is read back as a proposal with a rule called `<rule>` and an
 * argument called `name`, which is a round trip spent on a question the request
 * already answered.
 */
function renderAnswerFormat(site: string | null, callee: string | null): string[] {
  return [
    "Answer with these lines and nothing else, in this order:",
    "",
    "verdict: sound | repaired | unsound",
    "reason: one line saying what you found",
    "one `proposal:` line per fix, naming a rule from the catalogue and a block id from the site list",
    "",
    "An answer that finds nothing to change is two lines, and no proposal line at all:",
    "",
    "verdict: sound",
    "reason: the bound is read out of the slice on every iteration",
    "",
    ...(site === null
      ? []
      : [
          "An answer that does is those two lines and one proposal line per fix:",
          "",
          "verdict: repaired",
          "reason: the bound is recomputed on every iteration",
          `proposal: hoist-invariant ${site}`,
          ...(callee === null ? [] : [`proposal: inline-call ${site} callee=${callee}`]),
          "",
        ]),
    "A proposal is a rule, then a block id, then the arguments that rule takes, written `name=value` with no",
    `brackets around them: \`callee=${callee ?? "name"}\`, not \`[callee=${callee ?? "name"}]\`. A rule that takes`,
    "no argument takes none, and `inline-call` is the only rule in the catalogue that takes one. A line reading",
    "`proposal: none` is not how nothing is proposed: a `sound` or `unsound` answer that has no fix carries no",
    "`proposal:` line at all.",
    "",
    "`verdict: sound` takes no proposals, `verdict: repaired` takes at least one, and `verdict: unsound` is",
    "for an artifact that is wrong with no rule in the catalogue that fixes it: say so in the reason and",
    "propose nothing. Nothing else is read: a paragraph, a diff, a rewritten body or a list of instructions",
    "is discarded, and the request is asked again.",
  ];
}

/* -------------------------------------------------------------------------- */
/* The system prompt                                                          */
/* -------------------------------------------------------------------------- */

export function buildSystemPrompt(): string {
  return [
    "You are a verification backend for a compiler.",
    "",
    "You are handed one artifact at a time: the semantic IR the compiler resolved from a source file, or",
    "the target code the compiler lowered that IR into. You read it against the contract it is held to,",
    "and you answer with a verdict and, where the catalogue has a rewrite for it, the fixes you would make.",
    "",
    "## What you do not do",
    "",
    "- You do not write a program. You never emit IR, C, assembly, WebAssembly or a diff, and an answer",
    "  carrying one is an answer the compiler cannot read.",
    "- You do not decide that an artifact is correct. The compiler is what decides: it validates the IR",
    "  against its contract, lowers it, and runs it against test vectors built from that contract, and a",
    "  program is compared with what its own source prints. Your verdict is what you concluded from reading",
    "  the artifact, and it never overrides what the compiler found by running it.",
    "- You do not describe a fix in prose. Every fix is one named rule from the catalogue and one block id,",
    "  and the compiler applies the rule itself to its own tree, revalidates what came out and verifies it",
    "  again. A rule that does not hold where it was aimed is refused, and the refusal is reported back.",
    "",
    "## What you read",
    "",
    "- The contract: the signature, the preconditions, the postconditions, the memory the function touches,",
    "  the effects it has and the objective it is optimized for. The artifact is held to all of it.",
    "- The artifact, exactly as the compiler wrote it, with every block named by the id a proposal uses.",
    "- The sites: every block and every loop, by id, so a proposal names a block that exists.",
    "- When the compiler has already run the artifact, its diagnostics, and the proposals of the round",
    "  before that it refused.",
    "",
    "Report what you find, propose only what the catalogue can do, and answer in the format the request",
    "gives. A verdict with nothing behind it is worse than no verdict at all.",
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* The two prompts                                                            */
/* -------------------------------------------------------------------------- */

function renderDiagnostics(request: ReviewRequest): string[] {
  const lines: string[] = [];
  if (request.feedback.length > 0) {
    lines.push("### WHAT THE COMPILER FOUND BY RUNNING IT, OLDEST FIRST", "", ...request.feedback.map(asBullet));
  }
  if (request.programFailure !== undefined) {
    const { mismatch } = request.programFailure;
    lines.push(
      "",
      "### WHAT THE PROGRAM IT BELONGS TO PRINTED",
      "",
      "```",
      mismatch.actualOutput.trimEnd(),
      "```",
      ...(mismatch.failureOutput === undefined
        ? []
        : ["", "### WHAT IT WROTE TO STANDARD ERROR", "", "```", mismatch.failureOutput.trimEnd(), "```"]),
      "",
      "### WHAT THE SOURCE PRINTS",
      "",
      "```",
      mismatch.expectedOutput.trimEnd(),
      "```",
      "",
      mismatch.failure === undefined
        ? `The outputs are the same until line ${mismatch.line}, where they differ:`
        : `The program stopped before it printed line ${mismatch.line}:`,
      `  the source prints ${JSON.stringify(mismatch.expected)}`,
      `  the program ${mismatch.failure === undefined ? "prints" : "printed"} ${JSON.stringify(mismatch.actual)}`,
    );
  }
  if (request.refusals.length > 0) {
    lines.push(
      "",
      "### PROPOSALS OF THE ROUND BEFORE THIS ONE THAT WERE REFUSED",
      "",
      ...request.refusals.map(asBullet),
      "",
      "Each of these named a rule and a block, and the rule does not hold there. Propose something else, or",
      "a rule that does hold somewhere else.",
    );
  }
  return lines;
}

/**
 * What one candidate of a build is told to read for, chosen by which candidate
 * it is so that two candidates are never asked the same question.
 *
 * A build asks for several candidates because one reading of an artifact is not
 * the only reading: the same question asked twice is the same answer twice, and
 * the build would pay for the same review N times and learn from it once. What
 * each candidate is given here is a *place to start looking*, not a rule it may
 * propose and not a rule it may not: every rule in the catalogue stays open to
 * every candidate, and a candidate that finds nothing where it was sent says
 * `sound` and the build moves on. The order is fixed so that the candidates of a
 * build cover the catalogue between them rather than all landing on the first
 * rule, and the last entry is the catch-all for a build with more candidates
 * than there are places to start.
 */
const CANDIDATE_READINGS: readonly string[] = [
  [
    "Start with the loops. Read the body of each one for a value it computes on",
    "every turn that does not change from one turn to the next, and propose the",
    "rule that binds it once above the loop.",
  ].join("\n"),
  [
    "Start with the blocks rather than the loops. Read each one for a value it",
    "computes more than once, in itself or in a block nested inside it, written",
    "the same way every time, and propose the rule that binds it to a name.",
  ].join("\n"),
  [
    "Start with the arithmetic. Read every operation the body performs for one",
    "another form of itself that costs the machine less, and propose the rule",
    "that writes it.",
  ].join("\n"),
  [
    "Start with the calls. Read each one for a callee that computes a result and",
    "does nothing else, whose body could stand where the call is, and propose",
    "the rule that puts it there.",
  ].join("\n"),
  [
    "Read the whole body before proposing anything, and take the change that most",
    "reduces the work the objective above names, whichever rule it turns out to",
    "be. If the rules above cover several readings of the same place, propose the",
    "one that helps most.",
  ].join("\n"),
  [
    "Read for what the objective above asks of this function, and for nothing",
    "else: a change that does not move that number is not one of the fixes to",
    "propose here, however correct it would be.",
  ].join("\n"),
];

/**
 * The reading this candidate is given, or nothing when the build asked for one
 * candidate and there is no second reading to differ from.
 */
function renderReading(request: ReviewRequest): readonly string[] {
  if (request.candidates < 2) return [];
  const reading = CANDIDATE_READINGS[(request.candidate - 1) % CANDIDATE_READINGS.length];
  return [
    section("WHERE THIS READING STARTS", [
      `This is candidate ${request.candidate} of ${request.candidates}. The others are reading the same artifact`,
      "independently and none of them can see this one, so nothing here has been said to you before and nothing",
      "you find is expected to match.",
      "",
      reading,
      "",
      "That is where to start reading, not what you are allowed to propose: every rule in the catalogue below is",
      "open to this candidate, including the ones this reading does not mention. An artifact with nothing to fix",
      "is `sound` and no proposals, and that is an answer the build acts on.",
    ]),
  ];
}

/**
 * Whether a review may ask for a callee's body to be put where its call was.
 *
 * The example a prompt shows is one the rule has an answer for, so the callee
 * is read with the rule that decides it rather than with the body's own list of
 * callees: a callee that calls something cannot be written anywhere, and an
 * example naming one is an example of a refusal.
 */
function inlineRefusable(callee: SemanticFunction | undefined): boolean {
  return callee !== undefined && inlineRefusal(callee) === null;
}

function renderReview(request: ReviewRequest, lead: readonly string[]): string {
  const semantic = request.semantics[request.contract.function.name];
  // The worked examples in the answer format name a block and a callee this
  // artifact really has, so a model copying the shape copies an id the IR
  // prints rather than the name of a placeholder. The callee is one the body
  // reaches other than itself — an example that inlines a function into itself
  // is an example of a rule being refused — and it is one whose body the rule
  // can actually put where the call was. An example of a callee that calls
  // something is an example of a refusal, and a model that copies the shape
  // spends the round on it: `pDouble` reaches `fMulMod`, whose body holds four
  // calls, and the proposal the prompt showed there was refused every time a
  // build asked. Where the body reaches nothing the rule may write, there is no
  // example to give and the line is left out.
  const callee =
    semantic === undefined
      ? null
      : (semantic.calls.find((edge) => edge.callee !== semantic.name && inlineRefusable(request.semantics[edge.callee]))
          ?.callee ?? null);
  // The sites are the whole list the review is handed, walked once: the worked
  // example names a block out of it and the section further down prints it. The
  // block named is the last one, so the example is a block inside the body
  // rather than the body itself.
  const sites = semantic === undefined ? null : describeSites(semantic);
  const site =
    sites === null
      ? null
      : (sites
          .map((entry) => /^block (\S+):/.exec(entry)?.[1])
          .filter((id): id is string => id !== undefined)
          .at(-1) ?? semantic.entry.id);
  const artifactTitle =
    request.stage === "ir"
      ? "THE SEMANTIC IR THE COMPILER RESOLVED THE SOURCE INTO"
      : "THE TARGET CODE THE COMPILER LOWERED THE IR INTO";
  return [
    section("CONTRACT", renderContract(request.contract)),
    renderProgram(request),
    renderTarget(request.target),
    section("SIGNATURE", [
      `function under review: ${request.contract.function.name}`,
      "",
      "parameter types:",
      "",
      renderTypes(request.contract),
    ]),
    ...(sites === null ? [] : [section("SITES A PROPOSAL MAY NAME", sites)]),
    section(artifactTitle, [
      "```",
      request.artifact.trimEnd(),
      "```",
      ...(request.artifactNote === null ? [] : ["", request.artifactNote]),
    ]),
    section("WHAT THE RESULT MUST SATISFY", [
      "preconditions on entry:",
      "",
      ...request.contract.requires.map((requirement) => `- ${requirement}`),
      "",
      ...(request.contract.ensures.length === 0
        ? [
            "There is no postcondition: the result is not one expression, so what the function returns is",
            "checked by running the program it is part of and comparing what it prints with what the source",
            "program prints.",
          ]
        : ["postconditions on return:", "", ...request.contract.ensures.map((condition) => `- ${condition}`)]),
    ]),
    section("MEMORY REQUIREMENTS", renderMemory(request.contract)),
    section("NUMERICAL SEMANTICS", renderNumerical(request.contract)),
    section("OPTIMIZATION OBJECTIVE", renderObjective(request.contract)),
    section("WHAT THIS REVIEW IS FOR", lead),
    ...renderReading(request),
    ...(renderDiagnostics(request).length === 0 ? [] : [section("WHAT THE COMPILER ALREADY FOUND", renderDiagnostics(request))]),
    section("WHAT YOU MAY PROPOSE", [
      "Every fix is one of these rewrites, applied by the compiler to its own tree. There is nothing else a",
      "proposal may ask for.",
      "",
      ...renderCatalogue(),
    ]),
    section("YOUR ANSWER", renderAnswerFormat(site, callee)),
  ].join("\n\n");
}

/** The review of the IR, before anything has been lowered from it. */
export function buildIrReviewPrompt(request: ReviewRequest): string {
  const lead =
    request.feedback.length === 0 && request.programFailure === undefined
      ? [
          "The IR below is what the compiler resolved from the source. It is about to be lowered, assembled,",
          "linked and run against the contract above, and what it produces is what the build delivers. Read",
          "it for what it computes, and for what the objective above asks of it.",
        ]
      : [
          "The IR below is what the compiler resolved from the source, and it is what the diagnostics in the",
          "next section are about. It is not right yet: the compiler ran it, and it did not do what the",
          "contract says. Read what is wrong with the body, and propose the rewrites that answer it.",
        ];
  return renderReview(request, lead);
}

/** The review of the target the IR was lowered into. */
export function buildTargetReviewPrompt(request: ReviewRequest): string {
  return renderReview(request, [
    `The text below is what the compiler lowered the IR into for a ${request.output} build, on the target above.`,
    "The IR it was lowered from is not shown here: read the target, and where a change to it would have to be",
    "made in the IR that produces it, name the rule that makes it.",
    "",
    "A proposal here is applied the same way as one from the IR review. The compiler rewrites the IR and",
    "lowers it again, then runs it against the contract as before. What is reviewed is the target; what is",
    "regenerated is the program behind it.",
  ]);
}

/**
 * The request that follows an answer the compiler could not read. The answer
 * itself is not quoted: there is nothing in it to read, or the compiler would
 * not be asking again. What is quoted is why it was set aside.
 */
export function buildRetryPrompt(user: string, reasons: readonly string[]): string {
  return [
    user,
    "",
    "## THE PREVIOUS ANSWER COULD NOT BE READ",
    "",
    "The compiler asked the request above and received answers it could not read as a review:",
    "",
    ...reasons.map(asBullet),
    "",
    "Answer the request above from the beginning, in the format it gives, and put nothing else in the reply.",
  ].join("\n");
}

/**
 * What a model says when it is asked to verify an artifact.
 *
 * A model never writes the IR and never writes target code. It reads one of
 * them, says whether it is right, and names the fixes it would make out of the
 * catalogue the compiler implements. The compiler evaluates every proposal it
 * is given, applies the ones that hold, and regenerates the artifact from the
 * revision: what comes out is a tree the compiler wrote, and the only part of
 * the model in it is the choice of which rule to run and where.
 *
 * An answer is therefore a verdict, a reason and a list of proposals:
 *
 *   verdict: repaired
 *   reason: the bound is read out of the slice on every iteration
 *   proposal: hoist-invariant b1
 *   proposal: common-subexpression b2
 *   proposal: unroll b3 factor=4
 *
 * A verdict is one of:
 *
 *   sound      the artifact is right; no proposal says otherwise
 *   repaired   the artifact needs the listed fixes; it is not right as it is
 *   unsound    the artifact is wrong and no rule in the catalogue fixes it
 *
 * The compiler does not take a verdict for proof. What decides whether an
 * artifact is right is the toolchain: the IR is validated against its contract,
 * lowered, and run against vectors built from that contract, and a program is
 * compared with what its own source prints. A verdict only says what the reader
 * of the artifact thought, and `unsound` with no applicable rule is a build log
 * line, not a verdict the compiler acts on.
 *
 * The grammar is read strictly. An answer the compiler cannot read is not a
 * wrong answer, it is no answer: nothing was proposed, so the request is made
 * again rather than turning a malformed reply into a rejected artifact. Two
 * things are read rather than refused, because a model that means them is not
 * ambiguous about what it meant: a `proposal:` line whose whole value is the
 * word for nothing is no proposal, and an argument wrapped in the brackets the
 * format line is written with is the argument inside them. The verdict beside
 * a `none` still decides whether the review holds, so nothing is taken on
 * trust here.
 */

/** What a reader of an artifact concluded about it. */
export type Verdict = "sound" | "repaired" | "unsound";

export const VERDICTS: readonly Verdict[] = ["sound", "repaired", "unsound"];

/**
 * One fix, as it was proposed: a rule out of the catalogue, the block it is
 * aimed at, and whatever arguments the rule takes. The rule name and the
 * arguments are not checked here — a rule that does not exist, or one aimed at
 * a block that is not there, is a proposal the compiler refuses and says so,
 * which is a different thing from an answer it could not read.
 */
export interface Proposal {
  /** The rule, as the catalogue names it. */
  readonly rule: string;
  /** The block the rule applies to, by the id the IR prints on it. */
  readonly site: string;
  /** The rule's own arguments, as `name=value` pairs. */
  readonly args: Readonly<Record<string, string>>;
  /** The line as it was written, kept for the record and for a refusal. */
  readonly text: string;
}

/** A whole review of one artifact. */
export interface Review {
  readonly verdict: Verdict;
  readonly reason: string;
  readonly proposals: readonly Proposal[];
}

export type ParsedReview = { readonly review: Review } | { readonly unusable: string };

/** Fences are stripped before a reply is read: a reply is often wrapped in one. */
const FENCE = /^\s*```/;

/**
 * Reads a review out of a reply.
 *
 * Blank lines, comment lines and the fences around a fenced answer are ignored;
 * everything else has to be a `verdict:`, `reason:` or `proposal:` line, because
 * a reply that carries prose beside the answer is one the compiler has to guess
 * at, and a guess at which rule to run is a guess at what the build delivers.
 */
export function parseReview(text: string): ParsedReview {
  const lines = text.split("\n").filter((line) => line.trim() !== "" && !FENCE.test(line));
  let verdict: Verdict | null = null;
  let reason: string | null = null;
  const proposals: Proposal[] = [];

  for (const [index, line] of lines.entries()) {
    const field = /^([a-z]+):[ \t]*(.*)$/.exec(line);
    if (field === null) {
      return { unusable: `line ${index + 1} is neither a verdict, a reason nor a proposal: ${JSON.stringify(line)}` };
    }
    const [, name, value] = field;
    switch (name) {
      case "verdict": {
        if (verdict !== null) return { unusable: "the answer gives a verdict more than once" };
        const stated = VERDICTS.find((entry) => entry === value);
        if (stated === undefined) {
          return { unusable: `${JSON.stringify(value)} is not a verdict: expected sound, repaired or unsound` };
        }
        verdict = stated;
        break;
      }
      case "reason": {
        if (reason !== null) return { unusable: "the answer gives a reason more than once" };
        if (value.trim() === "") return { unusable: "the answer gives an empty reason" };
        reason = value.trim();
        break;
      }
      case "proposal": {
        const proposal = readProposal(value, index + 1);
        if ("unusable" in proposal) return proposal;
        // A line that says it proposes nothing is a review with no proposals,
        // and the verdict decides whether that is a whole answer: `sound` and
        // `unsound` are both asked for with no proposal, and `repaired` is
        // asked for with at least one.
        if (!("nothing" in proposal)) proposals.push(proposal.proposal);
        break;
      }
      default:
        return { unusable: `line ${index + 1} names an unknown field ${JSON.stringify(name)}` };
    }
  }

  if (verdict === null) return { unusable: "the answer gives no verdict" };
  if (reason === null) return { unusable: "the answer gives no reason" };
  if (verdict === "sound" && proposals.length > 0) {
    return { unusable: "the answer calls the artifact sound and proposes a fix to it" };
  }
  if (verdict === "repaired" && proposals.length === 0) {
    return { unusable: "the answer calls the artifact wrong and proposes no fix for it" };
  }
  return { review: { verdict, reason, proposals } };
}

/**
 * One `proposal:` line: a rule, the block id it applies to, and the arguments
 * that rule takes. The arguments are the words after the block id, and they
 * may be written bare as `name=value` or wrapped in the brackets the format
 * line is written with, which is the shape a model copying that line produces.
 */
function readProposal(
  value: string,
  line: number,
): { proposal: Proposal } | { nothing: true } | { unusable: string } {
  const trimmed = value.trim();
  if (NO_PROPOSAL.test(trimmed)) return { nothing: true };
  const [head, ...tail] = trimmed.split(/\s+/);
  if (head === undefined || tail.length === 0) {
    // A bare rule and an empty line are two different mistakes, and the build
    // log is the only place a reply is kept, so what the model wrote is part of
    // the reason rather than something the reader has to have seen.
    return trimmed === ""
      ? { unusable: `line ${line} proposes nothing: a proposal is a rule and the block it applies to` }
      : { unusable: `line ${line} proposes ${JSON.stringify(trimmed)} and no block to apply it to` };
  }
  const [rule, site] = [head, tail[0] as string];
  const args: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const written of argumentWords(tail.slice(1).join(" "))) {
    const argument = /^([a-z_]+)=(.*)$/.exec(written);
    if (argument === null) {
      return { unusable: `line ${line} proposes ${JSON.stringify(written)}, which is neither a rule nor a name=value argument` };
    }
    const [, name, argumentValue] = argument;
    if (name in args) return { unusable: `line ${line} gives ${name} twice` };
    if (argumentValue === "") return { unusable: `line ${line} gives ${name} no value` };
    args[name] = argumentValue;
  }
  return { proposal: { rule, site, args, text: trimmed } };
}

/**
 * What a model writes on a `proposal:` line when it is answering `sound` or
 * `unsound` and has a line left over. It is not a rule and not a block, and
 * there is nothing in it to apply: the answer that carries one is a review
 * with no proposals, which is what the verdict above it says.
 */
const NO_PROPOSAL = /^(?:none|nothing|n\/a|na|-|\.{3})$/i;

/**
 * The arguments the tail of a proposal line carries. A bracketed group is the
 * arguments inside it, one per comma, whether it is written `[name=value]` or
 * `[a=1, b=2]`; everything outside the brackets is a bare `name=value` word.
 */
function argumentWords(tail: string): string[] {
  const written: string[] = [];
  for (const [, group, bare] of tail.matchAll(/\[([^\]]*)\]|([^\[\]]+)/g)) {
    for (const word of (bare ?? "").trim().split(/\s+/)) if (word !== "") written.push(word);
    if (group !== undefined) {
      for (const part of group.split(",")) {
        const argument = part.trim().replace(/,$/, "");
        if (argument !== "") written.push(argument);
      }
    }
  }
  return written;
}

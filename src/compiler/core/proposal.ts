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
 * again rather than turning a malformed reply into a rejected artifact.
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
        proposals.push(proposal.proposal);
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
 * One `proposal:` line, as `<rule> <site> [name=value ...]`. The site is a
 * block id the IR prints, and a rule that takes no argument may be written
 * without one.
 */
function readProposal(value: string, line: number): { proposal: Proposal } | { unusable: string } {
  const words = value.trim().split(/\s+/);
  if (words.length < 2) {
    return { unusable: `line ${line} proposes nothing: a proposal is a rule and the block it applies to` };
  }
  const [rule, site] = words;
  const args: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const word of words.slice(2)) {
    const argument = /^([a-z_]+)=(.*)$/.exec(word);
    if (argument === null) {
      return { unusable: `line ${line} proposes ${JSON.stringify(word)}, which is neither a rule nor a name=value argument` };
    }
    const [, name, argumentValue] = argument;
    if (name in args) return { unusable: `line ${line} gives ${name} twice` };
    if (argumentValue === "") return { unusable: `line ${line} gives ${name} no value` };
    args[name] = argumentValue;
  }
  return { proposal: { rule, site, args, text: value.trim() } };
}

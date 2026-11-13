/**
 * AI backends.
 *
 * A backend turns one review request into one review. The request names an
 * artifact the compiler just produced — the semantic IR, or the target code it
 * lowered that IR into — and the answer is a verdict, a reason and a list of
 * proposals naming rewrites out of the catalogue in `semantics/repair.ts`. The
 * compiler applies those rewrites to its own tree and verifies the result; no
 * model output is ever compiled, so a backend has no path that can put text from
 * a provider into an object file.
 *
 * An answer the compiler cannot read is not a wrong answer, it is no answer:
 * nothing was proposed, so the request is made again rather than turning a
 * malformed reply into a rejected artifact.
 *
 * Two backends implement the same contract:
 *
 *   - ReplayBackend: an offline backend that returns recorded reviews, so the
 *     deterministic part of the pipeline (resolving, validating, lowering,
 *     verifying, benchmarking, selection) can be exercised without network
 *     access or credentials. It lives here because it needs no host.
 *   - the provider transport: the backend a model provider configuration
 *     constructs. It is the host's, asked for through the `#host/model`
 *     boundary: `ai/review-node.ts` carries the AI SDK for the Node compiler,
 *     and a native project maps the same name to the transport it links
 *     (the host boundary in docs/specs/self-hosting.md).
 */

import { createSdkBackend } from "#host/model";
import { readFile } from "../core/platform.ts";
import { CompilerError } from "../core/errors.ts";
import type { ModelConfiguration } from "./model.ts";
import type { ReviewRequest } from "./review.ts";
import { parseReview, reviewOrUnusable, type Review } from "../core/proposal.ts";

export interface AiBackend {
  /** Recorded in build records. */
  readonly id: string;
  /**
   * Asks for one review. `sequence` is the position this request takes in the
   * build's record and names the attempt it belongs to; the request itself says
   * which candidate and attempt that is.
   */
  review(request: ReviewRequest, sequence: number): Promise<Review>;
}

export function reviewError(message: string, detail?: string): CompilerError {
  return new CompilerError("AiReviewError", "review", message, detail, "", "", "");
}

/* -------------------------------------------------------------------------- */
/* Request accounting                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Tokens a provider charged one request for. A provider may report none of
 * them, and a gateway in between may report none at all.
 */
export interface ResponseUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/**
 * How a request that came back ended: the reason the provider gives, the name
 * it gives that reason, and what the request cost. All three are the
 * provider's account of a request rather than anything the compiler decided,
 * and a build that fails on an answer it could not read is the one place they
 * can still be read.
 */
export interface ProviderStop {
  /** Why the provider stopped generating, unified across providers. */
  finishReason: string;
  /** The provider's own name for the same reason, when it has one. */
  rawFinishReason?: string;
  /** What the request cost, as far as the provider reported it. */
  usage?: ResponseUsage;
}

/**
 * Says a stop out loud for a build that reports one. The provider's own name
 * is only worth printing where it says something the unified reason does not:
 * a provider that reports both usually reports the same word twice. The total
 * is left out when the input and output already add up to it, and stands in
 * for them when a provider reports the sum and nothing else.
 */
export function describeProviderStop(stop: ProviderStop): string {
  const parts = [`finish reason: ${stop.finishReason}`];
  if (stop.rawFinishReason !== undefined && stop.rawFinishReason !== stop.finishReason) {
    parts.push(`raw: ${stop.rawFinishReason}`);
  }
  if (stop.usage !== undefined) {
    const counted =
      stop.usage.inputTokens !== undefined && stop.usage.outputTokens !== undefined
        ? stop.usage.inputTokens + stop.usage.outputTokens
        : undefined;
    const tokens = [
      ...(stop.usage.inputTokens === undefined ? [] : [`${stop.usage.inputTokens} in`]),
      ...(stop.usage.outputTokens === undefined ? [] : [`${stop.usage.outputTokens} out`]),
      ...(stop.usage.totalTokens === undefined || stop.usage.totalTokens === counted
        ? []
        : [`${stop.usage.totalTokens} total`]),
    ];
    if (tokens.length > 0) parts.push(`usage: ${tokens.join(", ")}`);
  }
  return parts.join(", ");
}

/**
 * How much of a reply a failure record carries. A refusal names a line of the
 * answer, so the answer is what makes the refusal readable, and a model that
 * wrote an essay instead of a review is worth reading to the end — but a reply
 * that never ends is not, so the rest of it is counted rather than kept.
 */
const QUOTED_REPLY_LINES = 20;

/**
 * What a model wrote, indented under the request it answered. The number a
 * refusal names is a line of this text, so it is printed as it came: a reply
 * quoted back is quoted by its lines and not by its tokens, and a build that
 * cannot read an answer has nowhere else to read it.
 */
export function quoteReply(answer: string | undefined): string[] {
  if (answer === undefined) return [];
  const lines = answer.replace(/\s+$/, "").split("\n");
  if (lines.length === 0 || lines.every((line) => line.trim() === "")) return [];
  return [
    ...lines.slice(0, QUOTED_REPLY_LINES).map((line) => `    ${line}`),
    ...(lines.length <= QUOTED_REPLY_LINES ? [] : [`    … ${lines.length - QUOTED_REPLY_LINES} more lines`]),
  ];
}

/* -------------------------------------------------------------------------- */
/* Vercel AI SDK backend                                                      */
/* -------------------------------------------------------------------------- */

/** Exactly what is sent to a model for one review. */
export interface PromptDump {
  stage: ReviewRequest["stage"];
  candidate: number;
  attempt: number;
  system: string;
  user: string;
}

/**
 * An answer that was not a review, for a build that is asked again over it. It
 * is kept beside the prompt rather than in the retry reason, so a refusal that
 * names a line of it can be read against the text it names.
 */
export interface AnswerDump {
  stage: ReviewRequest["stage"];
  candidate: number;
  attempt: number;
  /** The re-request about to be made, 1-based. */
  retry: number;
  /** What the model wrote, as the provider returned it. */
  answer: string;
}

/**
 * Why an answer is asked for again, reported so a build says what it is
 * waiting for rather than going quiet on a model that keeps answering with
 * nothing.
 */
export interface ResponseRetry {
  stage: ReviewRequest["stage"];
  candidate: number;
  attempt: number;
  /** The re-request being made, 1-based. */
  retry: number;
  /** Re-requests this attempt is allowed in total. */
  retries: number;
  /** Why the answer before it could not be read. */
  reason: string;
  /** How the request behind it ended, when there was a request to end. */
  stop?: ProviderStop;
  /**
   * What the model wrote, when there was a reply to write. A build reports the
   * reason in one line; this is the reply that reason is about, and it is what
   * says whether the model wrote two reasons, a paragraph or the format it was
   * shown. It is not in the line, because a build log is read on a terminal.
   */
  answer?: string;
}

/**
 * How long the first re-request waits, doubling for each one after it: a
 * provider answering with nothing is usually busy, and an answer asked for
 * while it still is comes back the same.
 *
 * The doubling stops at the cap. A project that asks for a few thousand
 * re-requests would otherwise leave the last of them waiting for a length of
 * time no build outlives, with nothing said about it, and the cap costs
 * nothing: a wait this long is a wait the provider has answered within.
 */
export interface BackendOptions {
  /**
   * Wall clock budget for ONE model request. Unset by default: a model that
   * thinks for a long time is not a failure, and the compiler says which
   * model it is waiting on. Set it when a build must fail rather than wait.
   *
   * The budget is per request, not per build: every request is given the
   * whole of it, and one that overruns it fails the build at once rather than
   * spending a re-request on it.
   */
  timeoutMs?: number;
  /**
   * Extra requests one review may spend on an answer that could not be read.
   * Defaults to `DEFAULT_GENERATION.maxRetries`.
   */
  retries?: number;
  /** Called before an answer is asked for again, with the reason for it. */
  onRetry?: (retry: ResponseRetry) => void;
  /** Called with the prompt before it is sent, for --debug. */
  onPrompt?: (dump: PromptDump) => void;
}

/* -------------------------------------------------------------------------- */
/* Replay backend                                                             */
/* -------------------------------------------------------------------------- */

interface ReplayFile {
  /** Unvalidated: a replay file is written by hand, and what it holds is
   *  checked where it is read rather than taken on the shape of this. */
  reviews?: unknown;
}

export class ReplayBackend implements AiBackend {
  readonly id: string;
  private readonly configuration: ModelConfiguration;
  private entries: string[] | null = null;

  constructor(configuration: ModelConfiguration) {
    this.configuration = configuration;
    this.id = String((configuration as unknown as Record<string, unknown>)["id"]);
  }

  private async load(): Promise<string[]> {
    if (this.entries !== null) return this.entries;
    const file = String((this.configuration as unknown as Record<string, unknown>)["replayFile"]);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (cause) {
      throw reviewError(
        `cannot read replay file ${file}`,
        cause instanceof Error ? cause.message : String(cause),
      );
    }
    const trimmed = text.trim();
    if (trimmed.startsWith("{")) {
      let parsed: ReplayFile;
      try {
        parsed = JSON.parse(trimmed) as ReplayFile;
      } catch (cause) {
        throw reviewError(`replay file ${file} is not valid JSON`, cause instanceof Error ? cause.message : String(cause));
      }
      const recorded: unknown = parsed.reviews;
      if (!Array.isArray(recorded) || recorded.length === 0) {
        throw reviewError(`replay file ${file} must contain a non-empty "reviews" array`);
      }
      // Every entry is what one answer of an offline build is made of, so an
      // entry that is not text is a broken replay file and not a request that
      // failed: carrying a number into the review reader would report the crash
      // as if the model had answered badly.
      const entries: string[] = [];
      for (const [index, entry] of recorded.entries()) {
        if (typeof entry !== "string") {
          throw reviewError(`replay file ${file} has a "reviews" entry ${index} that is not text`);
        }
        entries.push(entry);
      }
      this.entries = entries;
      return this.entries;
    }
    this.entries = [trimmed];
    return this.entries;
  }

  async review(request: ReviewRequest, sequence: number): Promise<Review> {
    const entries = await this.load();
    // A position before the first entry is not a position: a build names its
    // candidates from one, so one below that is a caller that lost count, and
    // serving it an answer from the end of the file would hide that.
    if (!Number.isInteger(sequence) || sequence < 1) {
      throw reviewError(`the replay backend was asked for review ${sequence}, which is not a review`);
    }
    // Answers are served by record position, not by a shared cursor: candidates
    // are reviewed at the same time, and a cursor would hand them out in
    // whatever order they happened to reach the backend.
    const entry = entries[Math.min(sequence - 1, entries.length - 1)];
    const parsed = reviewOrUnusable(parseReview(entry));
    if (parsed.unusable !== null) {
      const at = Math.min(sequence - 1, entries.length - 1) + 1;
      throw reviewError(
        `replay entry ${at} is not a review of the ${request.stage} of ${request.contract.function.name}: ${parsed.unusable}`,
        `recorded in ${String((this.configuration as unknown as Record<string, unknown>)["replayFile"])}`,
      );
    }
    return parsed.review as Review;
  }
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                    */
/* -------------------------------------------------------------------------- */

export function createBackend(configuration: ModelConfiguration, options: BackendOptions = {}): AiBackend {
  if (configuration.provider === "replay") return new ReplayBackend(configuration);
  return createSdkBackend(configuration, options);
}

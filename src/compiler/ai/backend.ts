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
 *   - VercelAiBackend: the production backend, built on the Vercel AI SDK
 *   - ReplayBackend: an offline backend that returns recorded reviews, so the
 *     deterministic part of the pipeline (resolving, validating, lowering,
 *     verifying, benchmarking, selection) can be exercised without network
 *     access or credentials
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createCommandCode } from "./commandcode.ts";
import { generateText, type LanguageModel, type LanguageModelUsage } from "ai";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { CompilerError } from "../core/errors.ts";
import type { ModelConfiguration } from "./model.ts";
import { buildRetryPrompt, buildSystemPrompt, buildIrReviewPrompt, buildTargetReviewPrompt, type ReviewRequest } from "./review.ts";
import { parseReview, type Review } from "../core/proposal.ts";
import { DEFAULT_GENERATION } from "../core/types.ts";

/**
 * A model call that produced no review: the provider request failed, or the
 * reply could not be read as one. It is neither a rejection of an artifact nor
 * a fix, so the attempt is asked for again in place.
 */
class UnusableAnswer extends Error {
  /** Why the answer could not be read, told to the model on the re-request. */
  readonly reason: string;
  /** Whether asking again can change the outcome. */
  readonly retryable: boolean;
  /** What fails the build once the re-requests are spent. */
  readonly failure: CompilerError;
  /**
   * How the request that produced this answer ended, kept for a reply that
   * could not be read: an answer cut off by the output limit, one a content
   * filter took and one the model finished on its own are a different failure
   * from each other, and only the provider knows which it was, for what it
   * cost. Kept out of the reason, which the re-request prompt carries, because a
   * stop is a fact about the request the model cannot change by being asked
   * again. Absent for a request that never came back at all.
   */
  readonly stop: ProviderStop | undefined;

  constructor(reason: string, retryable: boolean, failure: CompilerError, stop?: ProviderStop) {
    super(reason);
    this.reason = reason;
    this.retryable = retryable;
    this.failure = failure;
    this.stop = stop;
  }
}

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

function reviewError(message: string, detail?: string): CompilerError {
  return new CompilerError({ category: "AiReviewError", stage: "review", message, detail });
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

/** The tokens a provider reported, or nothing when it reported none. */
function usageOf(usage: LanguageModelUsage): ResponseUsage | undefined {
  const reported: ResponseUsage = {
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
  };
  return Object.keys(reported).length === 0 ? undefined : reported;
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
const RETRY_BACKOFF_MS = 500;
const RETRY_BACKOFF_MAX_MS = 8_000;

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

/** The prompt a review of one artifact is sent as. */
function reviewPrompts(request: ReviewRequest): { system: string; user: string } {
  const system = buildSystemPrompt();
  const user = request.stage === "ir" ? buildIrReviewPrompt(request) : buildTargetReviewPrompt(request);
  return { system, user };
}

export class VercelAiBackend implements AiBackend {
  readonly id: string;
  private readonly configuration: ModelConfiguration;
  private readonly timeoutMs: number | undefined;
  private readonly retries: number;
  private readonly onRetry: ((retry: ResponseRetry) => void) | undefined;
  private readonly onPrompt: ((dump: PromptDump) => void) | undefined;
  private model: LanguageModel | null = null;

  constructor(configuration: ModelConfiguration, options: BackendOptions = {}) {
    this.configuration = configuration;
    this.timeoutMs = options.timeoutMs;
    this.retries = options.retries ?? DEFAULT_GENERATION.maxRetries;
    this.onRetry = options.onRetry;
    this.onPrompt = options.onPrompt;
    this.id = configuration.id;
  }

  /**
   * Provider construction is the only provider-specific code in the compiler;
   * everything else is expressed through the AI SDK abstraction.
   */
  private async languageModel(): Promise<LanguageModel> {
    if (this.model !== null) return this.model;
    const configuration = this.configuration;
    const apiKey = configuration.apiKey ?? "";
    const baseURL = configuration.baseUrl;

    if (configuration.provider === "openai") {
      this.model = createOpenAI(apiKey === "" ? undefined : { apiKey, ...(baseURL === undefined ? {} : { baseURL }) })(configuration.model);
    } else if (configuration.provider === "openrouter" || configuration.provider === "openai-compatible") {
      if (baseURL === undefined) throw reviewError(`${configuration.provider} has no endpoint`);
      this.model = createOpenAICompatible({
        name: configuration.provider,
        baseURL,
        apiKey,
        ...(configuration.headers === undefined ? {} : { headers: configuration.headers }),
      })(configuration.model);
    } else if (configuration.provider === "commandcode") {
      if (baseURL === undefined) throw reviewError("commandcode has no endpoint");
      this.model = createCommandCode({
        apiKey,
        baseUrl: baseURL,
        ...(configuration.headers === undefined ? {} : { headers: configuration.headers }),
      })(configuration.model);
    } else if (configuration.provider === "anthropic") {
      this.model = createAnthropic({ apiKey, ...(baseURL === undefined ? {} : { baseURL }) })(configuration.model);
    } else if (configuration.provider === "google") {
      this.model = createGoogleGenerativeAI({ apiKey, ...(baseURL === undefined ? {} : { baseURL }) })(configuration.model);
    } else {
      throw reviewError(`provider "${configuration.provider}" cannot be used for reviews`);
    }
    return this.model;
  }

  /**
   * Asks the model until it answers with a review the compiler can read, or
   * the re-request budget is spent.
   *
   * A model that fails to answer, or answers with something that is not a
   * review, has proposed nothing: there is nothing to apply, verify or reject,
   * and the next attempt would be a review of a repair that does not exist.
   * Such an answer is asked for again in place instead, each time told what was
   * wrong with the one before it, and none of them costs the attempt one of its
   * review rounds.
   */
  async review(request: ReviewRequest, _sequence: number): Promise<Review> {
    const { system, user } = reviewPrompts(request);
    this.onPrompt?.({ stage: request.stage, candidate: request.candidate, attempt: request.attempt, system, user });
    const model = await this.languageModel();
    const answers: { reason: string; stop: ProviderStop | undefined }[] = [];
    let review: Review;

    for (let retry = 0; ; retry += 1) {
      try {
        const answer = await this.ask(
          model,
          system,
          answers.length === 0 ? user : buildRetryPrompt(user, answers.map((entry) => entry.reason)),
        );
        const parsed = parseReview(answer.text);
        if ("unusable" in parsed) {
          // The reason the answer could not be read is told to the model, and
          // how the request ended is told to the build: a reply the provider
          // cut short is a different failure from one the model finished, and
          // only the provider knows which it was.
          throw new UnusableAnswer(
            parsed.unusable,
            true,
            reviewError("the model did not answer with a review the compiler could read"),
            answer.stop,
          );
        }
        review = parsed.review;
        break;
      } catch (cause) {
        if (!(cause instanceof UnusableAnswer)) throw cause;
        if (!cause.retryable) throw cause.failure;
        answers.push({ reason: cause.reason, stop: cause.stop });
        if (retry === this.retries) {
          throw new CompilerError({
            category: "AiReviewError",
            stage: "review",
            message: cause.failure.message,
            function: request.contract.function.name,
            detail: [
              `asked ${this.retries + 1} times, and no answer carried a review:`,
              ...answers.map((entry) => `- ${entry.reason}${entry.stop === undefined ? "" : ` (${describeProviderStop(entry.stop)})`}`),
              ...(cause.failure.detail === undefined ? [] : [cause.failure.detail]),
            ].join("\n"),
          });
        }
        this.onRetry?.({
          stage: request.stage,
          candidate: request.candidate,
          attempt: request.attempt,
          retry: retry + 1,
          retries: this.retries,
          reason: cause.reason,
          ...(cause.stop === undefined ? {} : { stop: cause.stop }),
        });
        await sleep(Math.min(RETRY_BACKOFF_MS * 2 ** retry, RETRY_BACKOFF_MAX_MS));
      }
    }
    return review;
  }

  /** One model call: what came back, and how the request ended. */
  private async ask(
    model: LanguageModel,
    system: string,
    user: string,
  ): Promise<{ text: string; stop: ProviderStop | undefined }> {
    let text: string;
    let stop: ProviderStop | undefined;
    try {
      // The system text goes in `instructions`, not a system message: that is
      // the portable form, and providers such as OpenRouter reject a system
      // message outright. A budget, when the project sets one, bounds this one
      // call: each request is given the whole of it, and a re-request is not
      // run inside what this one left.
      const result = await generateText({
        model,
        instructions: system,
        prompt: user,
        ...(this.timeoutMs === undefined ? {} : { abortSignal: AbortSignal.timeout(this.timeoutMs) }),
      });
      text = result.text;
      // How the request ended and what it cost, kept for a reply that turns
      // out to be unreadable: a request that never came back with a review has
      // neither to report.
      const usage = usageOf(result.usage);
      stop = {
        finishReason: result.finishReason,
        ...(result.rawFinishReason === undefined ? {} : { rawFinishReason: result.rawFinishReason }),
        ...(usage === undefined ? {} : { usage }),
      };
    } catch (cause) {
      if (isTimeout(cause) && this.timeoutMs !== undefined) {
        // Overrunning the budget is a decision about the clock rather than a
        // flaky answer, so it is not asked for again: the project said how
        // long to wait, and waiting longer is the only answer to that.
        throw new UnusableAnswer(
          "it did not answer within the request budget",
          false,
          reviewError(
            `the model did not answer within ${Math.round(this.timeoutMs / 1000)}s`,
            "remove generation.timeoutSeconds to wait as long as the model needs",
          ),
        );
      }
      // Everything else the provider does to a request is transient, and is
      // asked for again: a connection that dropped mid-reply is not a model
      // that will not answer, and spending a re-request on it is what a
      // re-request is for.
      throw new UnusableAnswer(
        "the provider request failed",
        true,
        reviewError("the model provider request failed", cause instanceof Error ? cause.message : String(cause)),
      );
    }

    // A reply the provider cut off at the token limit is the first part of an
    // answer, not a smaller one: what came back ends wherever the limit fell,
    // which is usually mid-line, and a review that stops there names a verdict
    // with no reason under it. It is asked for again, which costs the attempt
    // nothing but another request the same as an answer with nothing in it, and
    // the model can write less and land inside the limit. Every provider the
    // compiler talks to maps its own word for a cutoff to `length`.
    if (stop?.finishReason === "length") {
      throw new UnusableAnswer(
        "the answer was cut off at the token limit before it was finished",
        true,
        reviewError(
          "the model wrote more than it was allowed to answer",
          "the reply was cut off before the review was finished, so none of it was read",
        ),
        stop,
      );
    }
    return { text, stop };
  }
}

/**
 * A request that ran out of time, and nothing else. The name is what tells
 * them apart: a `TimeoutError` is the deadline this compiler set expiring,
 * and only that is a decision about the clock. An `AbortError` is how a
 * dropped connection or a cancelled request surfaces, and reading it as a
 * timeout fails a build over a network that blinked.
 */
function isTimeout(cause: unknown): boolean {
  if (cause instanceof Error) {
    if (cause.name === "TimeoutError") return true;
    if (cause.cause instanceof Error && cause.cause.name === "TimeoutError") return true;
  }
  return false;
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
    this.id = configuration.id;
  }

  private async load(): Promise<string[]> {
    if (this.entries !== null) return this.entries;
    const file = this.configuration.replayFile as string;
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
    const parsed = parseReview(entry);
    if ("unusable" in parsed) {
      const at = Math.min(sequence - 1, entries.length - 1) + 1;
      throw reviewError(
        `replay entry ${at} is not a review of the ${request.stage} of ${request.contract.function.name}: ${parsed.unusable}`,
        `recorded in ${String(this.configuration.replayFile)}`,
      );
    }
    return parsed.review;
  }
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                    */
/* -------------------------------------------------------------------------- */

export function createBackend(configuration: ModelConfiguration, options: BackendOptions = {}): AiBackend {
  if (configuration.provider === "replay") return new ReplayBackend(configuration);
  return new VercelAiBackend(configuration, options);
}

/**
 * The model transport a Node host carries.
 *
 * This is the only source that names the AI SDK. It is the host's answer to the
 * `#host/model` boundary: the compiler asks for a backend by that specifier,
 * `package.json` maps it here for Node, and a native project maps the same name
 * to an adapter of its own (§5a of the self-hosting spec). Keeping the SDK
 * behind the boundary is what lets the compiler's own tree be built without
 * compiling the SDK's sources.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, type LanguageModel, type LanguageModelUsage } from "ai";
import { createCommandCode } from "./commandcode.ts";
import { sleep } from "../core/platform.ts";
import { CompilerError } from "../core/errors.ts";
import { parseReview, type Review } from "../core/proposal.ts";
import { DEFAULT_GENERATION } from "../core/types.ts";
import type { ModelConfiguration } from "./model.ts";
import { buildRetryPrompt, buildSystemPrompt, buildIrReviewPrompt, buildTargetReviewPrompt, type ReviewRequest } from "./review.ts";
import {
  describeProviderStop,
  quoteReply,
  reviewError,
  type AiBackend,
  type BackendOptions,
  type PromptDump,
  type ProviderStop,
  type ResponseRetry,
  type ResponseUsage,
} from "./backend.ts";

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
  /**
   * The reply as the provider returned it, when there was one. It is kept out of
   * the reason, which the re-request prompt carries, because what a model wrote
   * is not an instruction to a model. It is the other half of the record: a
   * build says an answer could not be read, and this is the only place the
   * answer itself can be read.
   */
  readonly answer: string | undefined;

  constructor(
    reason: string,
    retryable: boolean,
    failure: CompilerError,
    stop?: ProviderStop,
    answer?: string,
  ) {
    super(reason);
    this.reason = reason;
    this.retryable = retryable;
    this.failure = failure;
    this.stop = stop;
    this.answer = answer;
  }
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


const RETRY_BACKOFF_MS = 500;
const RETRY_BACKOFF_MAX_MS = 8_000;


/** The prompt a review of one artifact is sent as. */
function reviewPrompts(request: ReviewRequest): { system: string; user: string } {
  const system = buildSystemPrompt();
  const user = request.stage === "ir" ? buildIrReviewPrompt(request) : buildTargetReviewPrompt(request);
  return { system, user };
}

/**
 * The AI SDK model a provider configuration constructs.
 *
 * Provider construction is the only provider-specific code in the compiler,
 * and it is written once here rather than once per caller: `blazeup` asks
 * the models a build asks, off a project's own selection, and a second copy
 * of these branches would be a place for the two to drift apart.
 */
export function languageModelFor(configuration: ModelConfiguration): LanguageModel {
  const apiKey = configuration.apiKey ?? "";
  const baseURL = configuration.baseUrl;

  if (configuration.provider === "openai") {
    return createOpenAI(apiKey === "" ? undefined : { apiKey, ...(baseURL === undefined ? {} : { baseURL }) })(configuration.model);
  }
  if (configuration.provider === "openrouter" || configuration.provider === "openai-compatible" || configuration.provider === "opencode-go" || configuration.provider === "opencode-zen" || configuration.provider === "nebius") {
    if (baseURL === undefined) throw reviewError(`${configuration.provider} has no endpoint`);
    return createOpenAICompatible({
      name: configuration.provider,
      baseURL,
      apiKey,
      ...(configuration.headers === undefined ? {} : { headers: configuration.headers }),
    })(configuration.model);
  }
  if (configuration.provider === "commandcode") {
    if (baseURL === undefined) throw reviewError("commandcode has no endpoint");
    return createCommandCode({
      apiKey,
      baseUrl: baseURL,
      ...(configuration.headers === undefined ? {} : { headers: configuration.headers }),
    })(configuration.model);
  }
  if (configuration.provider === "anthropic") {
    return createAnthropic({ apiKey, ...(baseURL === undefined ? {} : { baseURL }) })(configuration.model);
  }
  if (configuration.provider === "google") {
    return createGoogleGenerativeAI({ apiKey, ...(baseURL === undefined ? {} : { baseURL }) })(configuration.model);
  }
  throw reviewError(`provider "${configuration.provider}" cannot be used for reviews`);
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
    this.model ??= languageModelFor(this.configuration);
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
    const answers: { reason: string; stop: ProviderStop | undefined; answer: string | undefined }[] = [];
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
          // The reason the answer could not be read is told to the model, how
          // the request ended and what the model wrote are told to the build: a
          // reply the provider cut short is a different failure from one the
          // model finished, only the provider knows which it was, and the reply
          // is the only place a refusal like "a second reason" can be read.
          throw new UnusableAnswer(
            parsed.unusable,
            true,
            reviewError("the model did not answer with a review the compiler could read"),
            answer.stop,
            answer.text,
          );
        }
        review = parsed.review;
        break;
      } catch (cause) {
        if (!(cause instanceof UnusableAnswer)) throw cause;
        if (!cause.retryable) throw cause.failure;
        answers.push({ reason: cause.reason, stop: cause.stop, answer: cause.answer });
        if (retry === this.retries) {
          throw new CompilerError({
            category: "AiReviewError",
            stage: "review",
            message: cause.failure.message,
            function: request.contract.function.name,
            detail: [
              `asked ${this.retries + 1} times, and no answer carried a review:`,
              ...answers.flatMap((entry, at) => [
                `- request ${at + 1}: ${entry.reason}${entry.stop === undefined ? "" : ` (${describeProviderStop(entry.stop)})`}`,
                ...quoteReply(entry.answer),
              ]),
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
          ...(cause.answer === undefined ? {} : { answer: cause.answer }),
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
        text,
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


/**
 * The backend a provider configuration constructs on a Node host.
 *
 * A replayed review needs no host at all: `createBackend` answers it before it
 * asks here. Everything else is the provider transport this file carries.
 */
export function createSdkBackend(configuration: ModelConfiguration, options: BackendOptions = {}): AiBackend {
  return new VercelAiBackend(configuration, options);
}
